from app_state import (
    _get_model_config_for_call,
    _get_user_language,
    asyncio,
    chat_completion_stream,
    compute_cost,
    db,
    json,
    log,
    time,
)

_stream_channels: dict[str, dict] = {}
_stream_channels_lock = asyncio.Lock()


def _message_content_length(content) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for item in content:
            if isinstance(item, dict):
                total += len(str(item.get("text") or ""))
                image_url = item.get("image_url")
                if isinstance(image_url, dict):
                    total += min(len(str(image_url.get("url") or "")), 2048)
                elif image_url:
                    total += min(len(str(image_url)), 2048)
        return total
    return len(str(content or ""))

def _sse(event: str, data: dict) -> str:
    """格式化 SSE 事件"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _parse_meta_obj(raw_meta) -> dict:
    """兼容旧数据：meta 可能被双重 JSON 编码成字符串。"""
    meta = raw_meta or "{}"
    for _ in range(2):
        if isinstance(meta, dict):
            return meta
        if not isinstance(meta, str):
            return {}
        try:
            meta = json.loads(meta or "{}")
        except (json.JSONDecodeError, TypeError):
            return {}
    return meta if isinstance(meta, dict) else {}


def _iter_text_chunks(text: str, size: int = 80):
    """把 DB 中已有内容拆成较细 SSE 片段，避免重连时一次性大块跳变。"""
    if not text:
        return
    for i in range(0, len(text), size):
        yield text[i:i + size]


async def _bg_stream_one_model(
    node_id: str, mid: str,
    messages: list[dict], thinking_budgets: dict, search_results: list,
    search_config: dict = None,
    user_id: str = db.LOCAL_USER_ID,
):
    """后台任务（单模型）：流式调用一个模型，写入 DB + 推送事件到频道。
    由 _bg_stream_models 通过 asyncio.gather 并行调用多模型。
    
    内容已通过节流写入 DB；订阅者断开不影响后台继续。"""
    async def _qput(event_str: str):
        await _publish_stream_event(node_id, event_str)

    cfg = _get_model_config_for_call(mid, user_id=user_id)
    if not cfg or (cfg.get("provider") != "ollama" and not cfg.get("api_key")):
        await _qput(_sse("model_error", {
            "model_id": mid,
            "error": f"模型 {mid} 未配置" if not cfg else "未配置 API Key"
        }))
        return

    tb = int(thinking_budgets.get(mid, 0))
    response = db.create_response(
        node_id=node_id, model_id=mid, content="",
        user_id=user_id,
        status="streaming",
        thinking_budget=tb,
        meta={"thinking_budget": tb},
    )
    rid = response["id"]

    await _qput(_sse("model_start", {
        "node_id": node_id, "model_id": mid, "model_name": cfg["name"],
    }))

    full_content = ""
    full_thinking = ""
    usage_info = {}
    grounding_sources = None  # Gemini 原生搜索引用来源
    t0 = time.time()
    last_db_write = 0.0
    _written_len = 0          # 已写入 DB 的字符数

    try:
        async for chunk in chat_completion_stream(cfg, messages, thinking_budget=tb, search_config=search_config, language=_get_user_language(user_id)):
            if chunk["type"] == "thinking":
                full_thinking += chunk["content"]
                await _qput(_sse("thinking", {
                    "node_id": node_id, "model_id": mid, "content": chunk["content"],
                }))
            elif chunk["type"] == "content":
                full_content += chunk["content"]
                now = time.time()
                # 节流：写 DB 也保持较细颗粒度，保证切换问题树后的 DB 重连不会大段跳字。
                if len(full_content) - _written_len >= 32 or now - last_db_write >= 0.12:
                    db.update_response_content(rid, full_content, user_id=user_id)
                    _written_len = len(full_content)
                    last_db_write = now
                await _qput(_sse("content", {
                    "node_id": node_id, "model_id": mid, "content": chunk["content"],
                }))
            elif chunk["type"] == "usage":
                usage_info = chunk["usage"]
            elif chunk["type"] == "sources":
                # Gemini 原生搜索返回的引用来源 (已由 models.py 格式化)
                sources = chunk.get("sources", [])
                if sources:
                    grounding_sources = sources
                    await _qput(_sse("sources", {
                        "node_id": node_id, "model_id": mid, "sources": sources,
                    }))

        latency = int((time.time() - t0) * 1000)

        # 如果供应商流式不返回 usage（如 Google Gemini），按字符数估算
        if not usage_info:
            total_input_chars = sum(_message_content_length(m.get("content", "")) for m in messages)
            total_output_chars = len(full_content) + len(full_thinking)
            usage_info = {
                "prompt_tokens": max(1, total_input_chars // 3),
                "completion_tokens": max(1, total_output_chars // 3),
            }
            log.info("stream: %s 未返回 usage，估算 tokens_in≈%d out≈%d",
                     cfg["name"], usage_info["prompt_tokens"], usage_info["completion_tokens"])

        meta = {}
        if full_thinking:
            meta["thinking_content"] = full_thinking

        # 构建 sources: 原生搜索引用优先，其次 tool-calling 搜索结果
        if grounding_sources:
            response_sources = grounding_sources
        elif search_results:
            response_sources = [
                {"title": r["title"], "url": r["url"], "snippet": r["content"][:200]}
                for r in search_results
            ]
        else:
            response_sources = None

        db.update_response(rid,
            user_id=user_id,
            content=full_content,
            status="completed",
            tokens_input=usage_info.get("prompt_tokens", usage_info.get("input_tokens", 0)),
            tokens_output=usage_info.get("completion_tokens", usage_info.get("output_tokens", 0)),
            latency_ms=latency,
            finish_reason="stop",
            sources=response_sources,
            meta=meta if meta else None,
        )

        tokens_in = usage_info.get("prompt_tokens", usage_info.get("input_tokens", 0))
        tokens_out = usage_info.get("completion_tokens", usage_info.get("output_tokens", 0))
        cost = compute_cost(cfg, tokens_in, tokens_out)

        # 累加消费金额和 token 计数。共享模型的实际用量归到 owner 的源模型，
        # 当前用户的聊天/response 仍保持在自己的 user_id 下。
        shared = cfg.get("_shared") if isinstance(cfg.get("_shared"), dict) else None
        if shared:
            db.add_model_usage(shared["source_model_id"], cost, user_id=shared["owner_user_id"])
            db.add_model_tokens(shared["source_model_id"], tokens_in, tokens_out, user_id=shared["owner_user_id"])
            db.add_usage_log(
                user_id=user_id,
                family_id=shared["family_id"],
                capability_id=shared["capability_id"],
                provider=cfg.get("provider", ""),
                model=cfg.get("model_name", ""),
                input_tokens=tokens_in,
                output_tokens=tokens_out,
                estimated_cost=cost,
            )
        else:
            db.add_model_usage(mid, cost, user_id=user_id)
            db.add_model_tokens(mid, tokens_in, tokens_out, user_id=user_id)

        await _qput(_sse("model_done", {
            "node_id": node_id, "model_id": mid, "model_name": cfg["name"],
            "response_id": rid,
            "tokens_input": tokens_in,
            "tokens_output": tokens_out,
            "thinking_budget": tb,
            "cost": round(cost, 4), "latency_ms": latency,
        }))
        log.info("stream: %s 完成 tokens_in=%d out=%d latency=%dms",
                 cfg["name"], tokens_in, tokens_out, latency)

    except Exception as e:
        log.error("stream: %s 调用失败: %s", cfg.get("name", mid), e, exc_info=True)
        db.update_response(rid, status="error", user_id=user_id,
            meta={"error": str(e)})
        await _qput(_sse("model_error", {
            "node_id": node_id, "model_id": mid, "model_name": cfg.get("name", mid), "error": str(e),
        }))


async def _bg_stream_models(
    node_id: str, root_id: str,
    model_ids: list[str], messages_by_model: dict[str, list[dict]],
    thinking_budgets: dict, search_results: list,
    search_config: dict = None,
    segment_id: int = 0,
    user_id: str = db.LOCAL_USER_ID,
):
    """后台任务：并行调用所有模型，流式写入 DB + 推送到事件频道"""
    await _ensure_stream_channel(node_id)
    try:
        # 并行调用所有模型（asyncio.gather 并发执行）
        await asyncio.gather(*[
            _bg_stream_one_model(
                node_id, mid, messages_by_model[mid],
                thinking_budgets, search_results,
                search_config=search_config,
                user_id=user_id,
            )
            for mid in model_ids
        ])
        await _publish_stream_event(node_id, _sse("done", {"node_id": node_id}))
    finally:
        # 延迟清理频道，给后续短暂重连窗口
        await asyncio.sleep(60)
        async with _stream_channels_lock:
            channel = _stream_channels.get(node_id)
            if channel and channel.get("segment_id") == segment_id:
                _stream_channels.pop(node_id, None)


async def _ensure_stream_channel(node_id: str) -> dict:
    """获取或创建 node_id 的事件频道。"""
    async with _stream_channels_lock:
        if node_id not in _stream_channels:
            _stream_channels[node_id] = {
                "history": [],
                "subscribers": set(),
                "done": False,
                "segment_id": 0,
            }
        return _stream_channels[node_id]


async def _start_stream_segment(node_id: str) -> int:
    """标记 node_id 有一段新的流式输出，并返回新事件起点与段版本。"""
    channel = await _ensure_stream_channel(node_id)
    async with _stream_channels_lock:
        channel["done"] = False
        channel["segment_id"] = int(channel.get("segment_id", 0)) + 1
        return len(channel["history"]), channel["segment_id"]


async def _publish_stream_event(node_id: str, event_str: str):
    """向频道发布事件，并广播到每个订阅者的独立队列。"""
    channel = await _ensure_stream_channel(node_id)
    async with _stream_channels_lock:
        channel["history"].append(event_str)
        if len(channel["history"]) > 2000:
            channel["history"] = channel["history"][-2000:]
        if 'event: done' in event_str:
            channel["done"] = True
        subscribers = list(channel["subscribers"])

    for queue in subscribers:
        try:
            queue.put_nowait(event_str)
        except asyncio.QueueFull:
            pass


async def _subscribe_stream(
    node_id: str,
    history_start: int = 0,
    user_id: str = db.LOCAL_USER_ID,
    stop_on_done: bool = True,
):
    """SSE 生成器: 订阅 node_id 的频道。

    每个调用者得到自己的队列；history_start 用于只回放某个时间点之后
    的事件，避免追加模型时吃到旧事件。
    """
    channel = await _ensure_stream_channel(node_id)
    queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
    async with _stream_channels_lock:
        channel["subscribers"].add(queue)
        history = list(channel["history"][history_start:])
        already_done = channel["done"]
    try:
        for event_str in history:
            yield event_str
            if stop_on_done and 'event: done' in event_str:
                return
        if stop_on_done and already_done:
            yield _sse("done", {"node_id": node_id})
            return

        while True:
            try:
                event_str = await asyncio.wait_for(queue.get(), timeout=30)
                yield event_str
                # 检查是否为 done 事件
                if stop_on_done and 'event: done' in event_str:
                    break
            except asyncio.TimeoutError:
                # 30s 无新事件 → 检查 DB 是否已完成(重连场景)
                responses = db.get_node_responses(node_id, user_id=user_id)
                any_streaming = any(r.get("status") == "streaming" for r in responses)
                if not any_streaming:
                    # 所有回复已完成，发送 done
                    yield _sse("done", {"node_id": node_id})
                    break
    finally:
        async with _stream_channels_lock:
            channel = _stream_channels.get(node_id)
            if channel:
                channel["subscribers"].discard(queue)
