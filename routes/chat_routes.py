from app_state import (
    MARKDOWN_MODEL_ID,
    MARKDOWN_MODEL_NAME,
    MINERU_MODEL_ID,
    MINERU_MODEL_NAME,
    _filter_valid_model_ids,
    _get_model_config_for_call,
    _get_selected_model_ids,
    _get_user_id,
    _mark_root_summary_dirty_if_shallow_node,
    _profile_enabled_default,
    _should_use_profile,
    asyncio,
    db,
    json,
    log,
)
from context_builder import build_context, find_partial_position
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from streaming import (
    _bg_stream_models,
    _bg_stream_one_model,
    _iter_text_chunks,
    _parse_meta_obj,
    _sse,
    _start_stream_segment,
    _subscribe_stream,
)

router = APIRouter()


def _normalize_image_attachments(raw) -> list[dict]:
    attachments = raw if isinstance(raw, list) else []
    normalized = []
    for item in attachments[:1]:
        if not isinstance(item, dict) or item.get("type") != "image":
            continue
        data_url = str(item.get("data_url") or "")
        mime_type = str(item.get("mime_type") or "")
        if not data_url.startswith("data:image/") or ";base64," not in data_url:
            continue
        if mime_type not in ("image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"):
            continue
        normalized.append({
            "type": "image",
            "name": str(item.get("name") or "image")[:200],
            "mime_type": "image/jpeg" if mime_type == "image/jpg" else mime_type,
            "data_url": data_url,
            "size": int(item.get("size") or 0),
        })
    return normalized


def _attach_images_to_messages(messages: list[dict], attachments: list[dict]) -> list[dict]:
    if not attachments:
        return messages
    next_messages = [dict(m) for m in messages]
    for idx in range(len(next_messages) - 1, -1, -1):
        if next_messages[idx].get("role") != "user":
            continue
        content = next_messages[idx].get("content", "")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
        image_blocks = [
            {
                "type": "image_url",
                "image_url": {"url": attachment["data_url"], "detail": "auto"},
            }
            for attachment in attachments
        ]
        next_messages[idx]["content"] = [*blocks, *image_blocks]
        break
    return next_messages

@router.post("/api/chat/stream")
async def api_chat_stream(request: Request):
    """
    流式对话接口，返回 SSE 事件流。

    LLM 调用通过后台任务执行，与 HTTP 连接解耦：
    - 前端断开页面不影响后台继续获取回复(渐进写入 DB)
    - 重连: GET /api/chat/stream/{node_id}

    事件类型:
      node_created  — 节点已创建，若是首问则同时创建问题树
      model_start   — 模型开始响应
      thinking      — 思考过程片段
      content       — 回复内容片段
      model_done    — 模型响应完成
      model_error   — 模型响应出错
      done          — 所有模型响应完成
    """
    user_id = _get_user_id(request)
    data = await request.json()
    content = data.get("content", "").strip()
    root_id = data.get("root_id")
    parent_id = data.get("parent_id")
    model_ids = data.get("model_ids", [])
    logic_node = bool(data.get("logic_node"))
    nut_id = data.get("nut_id")
    partial_content = data.get("partial_content")
    web_search_enabled = data.get("web_search", False)
    thinking_budgets = data.get("thinking_budgets", {})
    use_profile = _should_use_profile(data.get("use_profile"), user_id=user_id)
    attachments = _normalize_image_attachments(data.get("attachments"))

    if not content:
        return JSONResponse({"error": "消息不能为空"}, status_code=400)

    # 默认模型；逻辑节点允许没有模型和回答。
    if not model_ids and not logic_node:
        model_ids = _get_selected_model_ids(user_id=user_id)
    elif model_ids:
        model_ids = _filter_valid_model_ids(model_ids, user_id=user_id)
    if not model_ids and not logic_node:
        return JSONResponse({"error": "请先配置至少一个模型"}, status_code=400)

    if root_id and not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    if parent_id and not db.get_node(parent_id, user_id=user_id):
        return JSONResponse({"error": "父节点不存在"}, status_code=404)
    if nut_id and not db.get_nut(nut_id, user_id=user_id):
        return JSONResponse({"error": "螺母不存在"}, status_code=404)

    log.info("stream: root=%s parent=%s models=%s web=%s content=%.60s...",
             root_id or "(new)", parent_id or "(none)", model_ids, web_search_enabled, content)

    # 确定关系类型
    relation = data.get("relation") or ("followup" if parent_id else "progression")
    parent_model_id = data.get("parent_model_id")

    # 构建上下文（含螺母/followup 上下文注入）。
    # 每个模型单独构造，避免非根节点多模型回答时都继承第一个模型的历史分支。
    messages_by_model = {} if logic_node else {
        mid: _attach_images_to_messages(build_context(
            parent_id, content, mid,
            current_nut_id=nut_id,
            current_partial_content=partial_content,
            current_parent_model_id=parent_model_id,
            relation=relation,
            user_id=user_id,
            use_profile=use_profile,
        )[0], attachments)
        for mid in model_ids
    }

    # 联网搜索 — 改为 tool-calling 模式：search_config 传给 models.py，
    # 由模型自己决定是否搜索、搜什么、是否深入阅读网页
    search_config = None
    search_results = []
    if web_search_enabled:
        search_provider = db.get_setting("web_search_provider", "tavily", user_id=user_id)
        search_api_key = db.get_setting("web_search_api_key", "", user_id=user_id)
        search_base_url = db.get_setting("web_search_base_url", "", user_id=user_id)
        search_config = {
            "provider": search_provider,
            "api_key": search_api_key,
            "base_url": search_base_url,
        }

    node_kwargs = {"relation": relation}
    node_meta = {"use_profile": use_profile}
    if logic_node:
        node_meta["kind"] = "logic"
    if attachments:
        node_meta["attachments"] = [{"type": a["type"], "name": a["name"], "mime_type": a["mime_type"], "size": a["size"]} for a in attachments]
    node_kwargs["meta"] = node_meta
    if attachments:
        node_kwargs["attachments"] = attachments
    if parent_id:
        node_kwargs["parent_id"] = parent_id
        node_kwargs["parent_model_id"] = parent_model_id or (model_ids[0] if model_ids else None)
    if nut_id:
        node_kwargs["nut_id"] = nut_id

    # 自动创建螺母
    created_nut = None
    if partial_content and parent_id and parent_model_id:
        resps = db.get_node_responses(parent_id, user_id=user_id)
        target_resp = next((r for r in resps if r["model_id"] == parent_model_id), None)
        if target_resp:
            nut_seek, nut_end_seek = find_partial_position(
                target_resp["content"], partial_content
            )
            if nut_end_seek > 0:
                created_nut = db.create_nut(
                    target_resp["id"], nut_seek, nut_end_seek,
                    user_id=user_id,
                    label=partial_content[:50],
                )
                node_kwargs["nut_id"] = created_nut["id"]

    node = db.create_node(root_id, content, user_id=user_id, **node_kwargs)
    node_id = node["id"]
    root_id = node["root_id"]
    _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)
    log.info("stream: 节点已创建 node=%s root=%s relation=%s", node_id, root_id, relation)

    if logic_node:
        async def logic_event_generator():
            yield _sse("node_created", {
                "root_id": root_id,
                "node_id": node_id,
                "nut_id": node_kwargs.get("nut_id"),
                "nut": created_nut,
                "relation": relation,
            })
            yield _sse("done", {"node_id": node_id})

        return StreamingResponse(logic_event_generator(), media_type="text/event-stream")

    # ── 启动后台任务（LLM 调用与 HTTP 连接解耦） ──
    history_start, segment_id = await _start_stream_segment(node_id)
    asyncio.create_task(_bg_stream_models(
        node_id=node_id, root_id=root_id,
        model_ids=model_ids, messages_by_model=messages_by_model,
        thinking_budgets=thinking_budgets, search_results=search_results,
        search_config=search_config,
        segment_id=segment_id,
        user_id=user_id,
    ))

    # ── SSE 生成器 ──
    async def event_generator():
        # 先发送 node_created
        yield _sse("node_created", {
            "root_id": root_id,
            "node_id": node_id,
            "nut_id": node_kwargs.get("nut_id"),
            "nut": created_nut,
            "relation": relation,
        })
        # 然后订阅队列流
        async for event in _subscribe_stream(node_id, history_start=history_start, user_id=user_id):
            yield event

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/api/chat/stream/{node_id}")
async def api_chat_stream_reconnect(node_id: str, request: Request):
    """
    重连流式对话 — 当页面刷新或重新打开时恢复正在进行的流式输出。

    采用 DB 轮询方式（非队列读取），因为重连时队列中的历史事件可能已被清空。
    - 已完成模型: 发送 model_start → content(全量) → model_done
    - 流式中模型: 发送 model_start → 已有内容 → 轮询 DB → 增量 content → model_done
    - 最后发送 done
    """
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)

    streaming_resps = db.get_responses_by_status(node_id, "streaming", user_id=user_id)
    if not streaming_resps:
        return JSONResponse(db.get_node_responses(node_id, user_id=user_id))

    log.info("stream-reconnect: node=%s 恢复 %d 个流式回复", node_id, len(streaming_resps))

    async def event_generator():
        all_resps = db.get_node_responses(node_id, user_id=user_id)
        # 构建 model_id → model_name 映射
        model_configs = {c["id"]: c for c in db.get_model_configs(user_id=user_id)}

        for resp in all_resps:
            mid = resp["model_id"]
            if mid == MINERU_MODEL_ID:
                model_name = MINERU_MODEL_NAME
            elif mid == MARKDOWN_MODEL_ID:
                model_name = MARKDOWN_MODEL_NAME
            else:
                model_name = model_configs.get(mid, {}).get("name", mid)

            # 解析 meta
            meta = _parse_meta_obj(resp.get("meta"))

            yield _sse("model_start", {"node_id": node_id, "model_id": mid, "model_name": model_name})
            thinking = meta.get("thinking_content", "")
            if thinking:
                yield _sse("thinking", {"node_id": node_id, "model_id": mid, "content": thinking})

            if resp.get("status") == "completed":
                # 已完成 — 重连时也拆成小块，避免前端 Markdown/代码块一次性大重排
                for content_chunk in _iter_text_chunks(resp["content"]):
                    yield _sse("content", {"node_id": node_id, "model_id": mid, "content": content_chunk})
                    await asyncio.sleep(0)
                yield _sse("model_done", {
                    "node_id": node_id, "model_id": mid, "model_name": model_name,
                    "response_id": resp["id"],
                    "tokens_input": resp.get("tokens_input", 0),
                    "tokens_output": resp.get("tokens_output", 0),
                    "latency_ms": resp.get("latency_ms", 0),
                })

            elif resp.get("status") == "streaming":
                # 流式中 — 发送已有内容，然后轮询增量
                for content_chunk in _iter_text_chunks(resp["content"]):
                    yield _sse("content", {"node_id": node_id, "model_id": mid, "content": content_chunk})
                    await asyncio.sleep(0)
                sent_len = len(resp["content"])
                max_empty_polls = 600  # 最多 600 × 100ms = 60s 无新数据后超时

                while True:
                    await asyncio.sleep(0.1)
                    updated = db.get_response(resp["id"], user_id=user_id)
                    if not updated:
                        break
                    if updated["status"] != "streaming":
                        # 完成或出错
                        new_content = updated["content"][sent_len:]
                        if new_content:
                            for content_chunk in _iter_text_chunks(new_content):
                                yield _sse("content", {"node_id": node_id, "model_id": mid, "content": content_chunk})
                                await asyncio.sleep(0)
                        if updated["status"] == "completed":
                            yield _sse("model_done", {
                                "node_id": node_id, "model_id": mid, "model_name": model_name,
                                "response_id": resp["id"],
                                "tokens_input": updated.get("tokens_input", 0),
                                "tokens_output": updated.get("tokens_output", 0),
                                "latency_ms": updated.get("latency_ms", 0),
                            })
                        elif updated["status"] == "error":
                            error_meta = _parse_meta_obj(updated.get("meta"))
                            yield _sse("model_error", {
                                "node_id": node_id, "model_id": mid, "model_name": model_name,
                                "error": error_meta.get("error", "未知错误"),
                            })
                        break

                    new_content = updated["content"][sent_len:]
                    if new_content:
                        for content_chunk in _iter_text_chunks(new_content):
                            yield _sse("content", {"node_id": node_id, "model_id": mid, "content": content_chunk})
                            await asyncio.sleep(0)
                        sent_len = len(updated["content"])
                        max_empty_polls = 600  # 重置计数器
                    else:
                        max_empty_polls -= 1
                        if max_empty_polls <= 0:
                            log.warning("stream-reconnect: model=%s 超时无新数据", mid)
                            break

        yield _sse("done", {"node_id": node_id})

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/api/node/{node_id}/add-model")
async def api_node_add_model(node_id: str, request: Request):
    """
    为已有节点追加一个新的模型回复（流式 SSE）。
    """
    user_id = _get_user_id(request)
    data = await request.json()
    model_id = data.get("model_id", "").strip()
    thinking_budget = int(data.get("thinking_budget", 0))
    web_search_enabled = data.get("web_search", False)

    if not model_id:
        return JSONResponse({"error": "model_id 不能为空"}, status_code=400)
    if not _get_model_config_for_call(model_id, user_id=user_id):
        return JSONResponse({"error": "模型不存在"}, status_code=404)

    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)

    existing = db.get_node_responses(node_id, user_id=user_id)
    if any(r["model_id"] == model_id and r.get("status") != "error" for r in existing):
        return JSONResponse({"error": f"模型 {model_id} 已有回复"}, status_code=400)

    log.info("add-model: node=%s model=%s budget=%d web=%s", node_id, model_id, thinking_budget, web_search_enabled)

    messages, _ = build_context(
        node.get("parent_id"), node["content"], model_id,
        current_node_id=node_id,
        current_nut_id=node.get("nut_id"),
        current_parent_model_id=node.get("parent_model_id"),
        relation=node.get("relation", None),
        user_id=user_id,
        use_profile=_parse_meta_obj(node.get("meta")).get("use_profile", _profile_enabled_default(user_id=user_id)),
    )
    # 联网搜索配置
    search_config = None
    if web_search_enabled:
        search_provider = db.get_setting("web_search_provider", "tavily", user_id=user_id)
        search_api_key = db.get_setting("web_search_api_key", "", user_id=user_id)
        search_base_url = db.get_setting("web_search_base_url", "", user_id=user_id)
        search_config = {
            "provider": search_provider,
            "api_key": search_api_key,
            "base_url": search_base_url,
        }

    thinking_budgets = {model_id: thinking_budget} if thinking_budget else {}
    history_start, _segment_id = await _start_stream_segment(node_id)
    asyncio.create_task(_bg_stream_one_model(
        node_id=node_id, mid=model_id, messages=messages,
        thinking_budgets=thinking_budgets, search_results=[],
        search_config=search_config,
        user_id=user_id,
    ))

    async def event_generator():
        async for event_str in _subscribe_add_model(node_id, model_id, history_start, user_id=user_id):
            yield event_str

    return StreamingResponse(event_generator(), media_type="text/event-stream")


async def _subscribe_add_model(node_id: str, model_id: str, history_start: int = 0, user_id: str = db.LOCAL_USER_ID):
    """订阅流事件，仅转发本模型相关事件，模型完成后发送 done"""
    model_done_seen = False
    import re as _re

    async for event_str in _subscribe_stream(
        node_id,
        history_start=history_start,
        user_id=user_id,
        stop_on_done=False,
    ):
        event_model_id = None
        try:
            data_match = _re.search(r'data: ({.*})', event_str)
            if data_match:
                evt_data = json.loads(data_match.group(1))
                event_model_id = evt_data.get("model_id")
        except Exception:
            pass

        if event_model_id == model_id:
            yield event_str
            if 'event: model_done' in event_str or 'event: model_error' in event_str:
                model_done_seen = True
                break
        elif 'event: done' in event_str:
            # Node-level streams can finish while this add-model request is still
            # running. Add-model subscribers only finish on their own model event
            # or the DB status check below.
            pass
        else:
            pass

        responses = db.get_node_responses(node_id, user_id=user_id)
        target = next((r for r in responses if r["model_id"] == model_id), None)
        if target and target.get("status") != "streaming":
            model_done_seen = True
            break

    if not model_done_seen:
        responses = db.get_node_responses(node_id, user_id=user_id)
        target = next((r for r in responses if r["model_id"] == model_id), None)
        if target and target.get("status") != "streaming":
            model_done_seen = True

    if model_done_seen:
        yield _sse("done", {"node_id": node_id})


# ═══════════════════════════════════════════════
# API: Responses
# ═══════════════════════════════════════════════
