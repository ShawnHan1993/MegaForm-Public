from app_state import (
    MARKDOWN_MODEL_ID,
    MARKDOWN_MODEL_NAME,
    MINERU_MODEL_ID,
    MINERU_MODEL_NAME,
    NODE_SUMMARY_MIN_TOKENS,
    _call_summary_model,
    _estimate_tokens,
    _filter_valid_model_ids,
    _get_model_config_for_display_map,
    _get_selected_model_ids,
    _get_summary_model_id,
    _get_user_id,
    _get_user_language,
    _mark_root_summary_dirty,
    _mark_root_summary_dirty_if_shallow_node,
    _node_depth_from_root,
    _should_use_profile,
    _summary_changed_enough,
    asyncio,
    db,
    deque,
    json,
    log,
)
from context_builder import build_context
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from routes.import_routes import _collect_node_response_ids, _remove_mineru_response_assets_many
from streaming import _bg_stream_models, _sse, _start_stream_segment, _subscribe_stream

router = APIRouter()

@router.get("/api/roots")
def list_roots(request: Request):
    user_id = _get_user_id(request)
    return JSONResponse(db.get_all_roots(user_id=user_id))


@router.get("/api/root-groups")
def list_root_groups(request: Request):
    user_id = _get_user_id(request)
    return JSONResponse(db.get_root_groups(user_id=user_id))


@router.post("/api/root-groups")
async def create_root_group(request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    group = db.create_root_group(data.get("name", ""), user_id=user_id)
    return JSONResponse(group)


@router.patch("/api/root-groups/{group_id}")
async def update_root_group(group_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    group = db.update_root_group(group_id, user_id=user_id, **data)
    if not group:
        return JSONResponse({"error": "分组不存在"}, status_code=404)
    return JSONResponse(group)


@router.delete("/api/root-groups/{group_id}")
def delete_root_group(group_id: str, request: Request):
    user_id = _get_user_id(request)
    ok = db.delete_root_group(group_id, user_id=user_id)
    if not ok:
        return JSONResponse({"error": "分组不存在"}, status_code=404)
    return JSONResponse({"status": "ok"})


@router.get("/api/roots/{root_id}")
def get_root(root_id: str, request: Request):
    # 浏览器访问 → 重定向到前端深链接
    accept = request.headers.get("accept", "")
    if "text/html" in accept:
        return RedirectResponse(url=f"/root/{root_id}", status_code=302)
    user_id = _get_user_id(request)
    root = db.get_root(root_id, user_id=user_id)
    if not root:
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    return JSONResponse(root)


@router.patch("/api/roots/{root_id}")
async def update_root(root_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    if not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    # 仅摘要修改时不动 updated_at
    touch = not (set(data.keys()) == {"summary"})
    root = db.update_node(root_id, touch_updated_at=touch, user_id=user_id, **data)
    return JSONResponse(root)


@router.delete("/api/roots/{root_id}")
def delete_root(root_id: str, request: Request):
    user_id = _get_user_id(request)
    response_ids = []
    for node in db.get_root_nodes(root_id, user_id=user_id):
        response_ids.extend(r["id"] for r in db.get_node_responses(node["id"], user_id=user_id))
    db.delete_root(root_id, user_id=user_id)
    _remove_mineru_response_assets_many(user_id, response_ids)
    return JSONResponse({"status": "ok"})


@router.patch("/api/roots/{root_id}/group")
async def move_root_group(root_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    group_id = data.get("group_id")
    node = db.move_root_to_group(
        root_id,
        group_id if group_id else None,
        user_id=user_id,
    )
    if not node:
        return JSONResponse({"error": "根节点或分组不存在"}, status_code=404)
    return JSONResponse(node)


@router.post("/api/roots/{root_id}/pin")
async def pin_root(root_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    pinned = data.get("pinned", True)
    node = db.update_node(root_id, pinned=1 if pinned else 0, user_id=user_id)
    if not node:
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: Nodes
# ═══════════════════════════════════════════════

@router.get("/api/roots/{root_id}/nodes")
def list_root_nodes(root_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    return JSONResponse(db.get_root_nodes(root_id, user_id=user_id))


@router.get("/api/roots/{root_id}/tree")
def get_root_tree(root_id: str, request: Request):
    """返回问题树的完整树结构。"""
    user_id = _get_user_id(request)
    root = db.get_root(root_id, user_id=user_id)
    if not root:
        return JSONResponse({"error": "根节点不存在"}, status_code=404)

    nodes = db.get_root_nodes(root_id, user_id=user_id)
    node_map = {n["id"]: {**n, "children": [], "responses": []} for n in nodes}

    # 填充 responses（含 nuts + model_name）
    cfg_map = _get_model_config_for_display_map(user_id=user_id)
    for n in nodes:
        resps = db.get_node_responses(n["id"], user_id=user_id)
        for resp in resps:
            resp["nuts"] = db.get_response_nuts(resp["id"], user_id=user_id)
            mid = resp.get("model_id", "")
            cfg = cfg_map.get(mid, {})
            if mid == MINERU_MODEL_ID:
                resp["model_name"] = MINERU_MODEL_NAME
            elif mid == MARKDOWN_MODEL_ID:
                resp["model_name"] = MARKDOWN_MODEL_NAME
            else:
                resp["model_name"] = cfg.get("name", mid) or mid
        node_map[n["id"]]["responses"] = resps

    # 填充 children + 构建树
    root_node = None
    for n in nodes:
        pid = n.get("parent_id")
        if pid and pid in node_map:
            node_map[pid]["children"].append(node_map[n["id"]])
        elif pid is None:
            root_node = node_map[n["id"]]

    # 按 child_order 排序 children
    def sort_children(node_data):
        if node_data.get("children"):
            node_data["children"].sort(key=lambda x: x.get("child_order", 0))
            for child in node_data["children"]:
                sort_children(child)
    if root_node:
        sort_children(root_node)

    return JSONResponse({"root": root_node})


def _load_responses_with_nuts(node_id: str, user_id: str = db.LOCAL_USER_ID) -> list:
    """加载节点回复及其螺母，并为每条 response 附加 model_name"""
    resps = db.get_node_responses(node_id, user_id=user_id)
    cfg_map = _get_model_config_for_display_map(user_id=user_id)  # 含已删除模型与共享模型
    for resp in resps:
        resp["nuts"] = db.get_response_nuts(resp["id"], user_id=user_id)
        mid = resp.get("model_id", "")
        cfg = cfg_map.get(mid, {})
        if mid == MINERU_MODEL_ID:
            resp["model_name"] = MINERU_MODEL_NAME
        elif mid == MARKDOWN_MODEL_ID:
            resp["model_name"] = MARKDOWN_MODEL_NAME
        else:
            resp["model_name"] = cfg.get("name", mid) or mid
    return resps


@router.get("/api/roots/{root_id}/tree/stream")
async def stream_root_tree(root_id: str, request: Request):
    """SSE 渐进式加载问题树（BFS 逐节点推送，避免一次性加载过大的树）"""
    user_id = _get_user_id(request)
    root = db.get_root(root_id, user_id=user_id)
    if not root:
        return JSONResponse({"error": "根节点不存在"}, status_code=404)

    async def generate():
        nodes = db.get_root_nodes(root_id, user_id=user_id)

        # 找根节点
        root = None
        for n in nodes:
            if n.get("parent_id") is None:
                root = n
                break

        if not root:
            yield f"event: done\ndata: {{}}\n\n"
            return

        # 发送根节点
        root_data = dict(root)
        root_data["responses"] = _load_responses_with_nuts(root["id"], user_id=user_id)
        root_data["children"] = []
        yield f"event: root\ndata: {json.dumps({'node': root_data}, ensure_ascii=False)}\n\n"

        # BFS 遍历所有子节点
        queue = deque([root["id"]])
        visited = {root["id"]}

        while queue:
            parent_id = queue.popleft()
            children = [n for n in nodes if n.get("parent_id") == parent_id]
            children.sort(key=lambda x: x.get("child_order", 0))

            for child in children:
                if child["id"] in visited:
                    continue
                visited.add(child["id"])
                queue.append(child["id"])

                child_data = dict(child)
                child_data["responses"] = _load_responses_with_nuts(child["id"], user_id=user_id)
                child_data["children"] = []
                yield f"event: node\ndata: {json.dumps({'node': child_data}, ensure_ascii=False)}\n\n"

        yield f"event: done\ndata: {{}}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/api/nodes/{node_id}")
def get_node(node_id: str, request: Request):
    # 浏览器访问 → 重定向到前端深链接
    accept = request.headers.get("accept", "")
    if "text/html" in accept:
        return RedirectResponse(url=f"/node/{node_id}", status_code=302)
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    # 附带 responses
    resps = db.get_node_responses(node_id, user_id=user_id)
    return JSONResponse({**node, "responses": resps})


# ═══ API: 节点 (Nodes) ═══
# relation: progression / followup, nut_id 锚定文字

@router.get("/api/nodes/{node_id}/path")
def get_node_path(node_id: str, request: Request):
    user_id = _get_user_id(request)
    path = db.get_path_to_root(node_id, user_id=user_id)
    if not path:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(path)


@router.get("/api/nodes/{node_id}/children")
def get_node_children(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(db.get_node_children(node_id, user_id=user_id))


@router.patch("/api/nodes/{node_id}")
async def update_node(node_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    node = db.update_node(node_id, user_id=user_id, **data)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    if any(k in data for k in ("content", "relation", "parent_id", "parent_model_id")):
        _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)
    return JSONResponse(node)


@router.delete("/api/nodes/{node_id}")
def delete_node_api(node_id: str, request: Request):
    """级联删除节点及其所有后代。删除根节点=删除整棵问题树。"""
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    depth = _node_depth_from_root(node_id, user_id=user_id)

    if node.get("parent_id") is None:
        root_id = node["root_id"]
        response_ids = []
        for root_node in db.get_root_nodes(root_id, user_id=user_id):
            response_ids.extend(r["id"] for r in db.get_node_responses(root_node["id"], user_id=user_id))
        log.info("node: 删除根节点 root=%s", root_id)
        db.delete_root(root_id, user_id=user_id)
        _remove_mineru_response_assets_many(user_id, response_ids)
        return JSONResponse({"status": "ok", "deleted_root": True, "root_id": root_id})

    response_ids = _collect_node_response_ids(node_id, user_id=user_id)
    count = db.delete_subtree(node_id, user_id=user_id)
    _remove_mineru_response_assets_many(user_id, response_ids)
    if depth is not None and depth <= 1:
        _mark_root_summary_dirty(node["root_id"], user_id=user_id)
    return JSONResponse({"status": "ok", "deleted_count": count})


# ── 节点折叠/摘要 ──

@router.post("/api/nodes/{node_id}/collapse")
async def collapse_node(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    data = await request.json()
    collapsed = data.get("collapsed", True)
    summary = data.get("summary")
    meta = {"collapsed": 1 if collapsed else 0}
    if summary is not None:
        meta["summary"] = summary
    db.set_node_meta(node_id, user_id=user_id, **meta)
    return JSONResponse({"status": "ok"})


@router.post("/api/nodes/{node_id}/expand-subtree")
def expand_node_subtree(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    db.expand_subtree(node_id, user_id=user_id)
    return JSONResponse({"status": "ok"})


@router.post("/api/nodes/{node_id}/summary")
async def update_summary(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    data = await request.json()
    summary = data.get("summary", "")
    db.update_node(node_id, summary=summary, touch_updated_at=False, user_id=user_id)
    return JSONResponse({"status": "ok"})


@router.post("/api/nodes/{node_id}/generate-summary")
async def generate_summary(node_id: str, request: Request):
    """调用配置的摘要模型生成节点摘要（流式收集结果）"""
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)

    try:
        data = await request.json()
    except Exception:
        data = {}
    force = bool(data.get("force"))

    if not _get_summary_model_id(user_id=user_id):
        return JSONResponse({"summary": node.get("summary", ""), "updated": False, "disabled": True})

    content = node["content"]
    if not force and _estimate_tokens(content) <= NODE_SUMMARY_MIN_TOKENS:
        return JSONResponse({"summary": node.get("summary", ""), "updated": False, "skipped": True})

    if _get_user_language(user_id) == "en":
        prompt = (
            "Summarize the core topic of the following user question in English. "
            "Requirements: within 25 tokens; no quotes; no final period; output only the summary:\n\n"
            f"{content[:2000]}"
        )
    else:
        prompt = (
            "请用中文概括以下用户问题的核心内容。要求：25个token以内；"
            "不要加引号、不要加句号；直接输出摘要：\n\n"
            f"{content[:2000]}"
        )

    try:
        summary = await _call_summary_model(prompt, user_id=user_id)
        updated = False
        if summary and (force or _summary_changed_enough(node.get("summary", ""), summary)):
            db.update_node(node_id, summary=summary, touch_updated_at=False, user_id=user_id)
            updated = True
            _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)
        return JSONResponse({"summary": summary or node.get("summary", ""), "updated": updated, "forced": force})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/nodes/{node_id}/rerun/stream")
async def rerun_node_stream(node_id: str, request: Request):
    """节点重跑（流式版本）— 使用 SSE 实时输出，`OpenAI` 兼容。体验与提新问题一致。

    流程:
    1. 立即删除旧 responses + 子节点（清空重来）
    2. 启动后台任务调用 chat_completion_stream
    3. 返回 SSE 流，与 /api/chat/stream 事件格式完全一致

    事件类型:
      node_ready   — 节点已就绪(id, root_id)
      model_start  — 模型开始响应
      thinking     — 思考过程片段
      content      — 回复内容片段
      model_done   — 模型完成
      model_error  — 模型出错
      done         — 全部完成
    """
    user_id = _get_user_id(request)
    data = await request.json()
    new_content = data.get("content", "").strip()
    model_ids = data.get("model_ids", [])
    thinking_budgets = data.get("thinking_budgets", {})
    web_search_enabled = data.get("web_search", False)
    use_profile = _should_use_profile(data.get("use_profile"), user_id=user_id)

    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)

    # 1. 更新内容
    if new_content and new_content != node["content"]:
        db.update_node(node_id, content=new_content, user_id=user_id)
        log.info("rerun-stream: 更新节点内容 node=%s", node_id)

    # 刷新节点数据
    node = db.get_node(node_id, user_id=user_id)
    content = node["content"]

    # 2. 默认模型
    if not model_ids:
        model_ids = _get_selected_model_ids(user_id=user_id)
    else:
        model_ids = _filter_valid_model_ids(model_ids, user_id=user_id)
    if not model_ids:
        return JSONResponse({"error": "请先配置至少一个模型"}, status_code=400)

    # 3. 判断是否要清除旧数据
    # 逻辑：如果所选模型中没有任何一个对该节点做过回答 → 扩充模式（保留旧回复）
    #       否则 → 替换模式（删除旧回复+子节点，重新来）
    content_changed = bool(new_content and new_content != node["content"])
    if content_changed:
        response_ids = _collect_node_response_ids(node_id, user_id=user_id)
        db.delete_node_responses(node_id, user_id=user_id)
        children = db.get_node_children(node_id, user_id=user_id)
        for child in children:
            db.delete_subtree(child["id"], user_id=user_id)
        _remove_mineru_response_assets_many(user_id, response_ids)
        log.info("rerun-stream: 全部重跑 node=%s changed=%s",
                 node_id, content_changed)
    else:
        existing_resps = db.get_node_responses(node_id, user_id=user_id)
        existing_model_ids = {r["model_id"] for r in existing_resps}
        for model_id in model_ids:
            if model_id in existing_model_ids:
                log.info("rerun-stream: 模型 %s 已有旧回复，将做替换", model_id)
                response_ids = [r["id"] for r in existing_resps if r["model_id"] == model_id]
                for child in db.get_node_children(node_id, parent_model_id=model_id, user_id=user_id):
                    response_ids.extend(_collect_node_response_ids(child["id"], user_id=user_id))
                db.delete_node_responses(node_id, model_id, user_id=user_id)
                children = db.get_node_children(node_id, parent_model_id=model_id, user_id=user_id)
                for child in children:
                    db.delete_subtree(child["id"], user_id=user_id)
                _remove_mineru_response_assets_many(user_id, response_ids)
            else:
                log.info("rerun-stream: 模型 %s 没有旧回复，将做扩充", model_id)

    # 4. 构建上下文
    parent_id = node.get("parent_id")
    messages_by_model = {
        mid: build_context(
            parent_id, content, mid,
            current_node_id=node_id,
            current_nut_id=node.get("nut_id"),
            current_parent_model_id=node.get("parent_model_id"),
            relation=node.get("relation"),
            user_id=user_id,
            use_profile=use_profile,
        )[0]
        for mid in model_ids
    }

    root_id = node["root_id"]
    _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)

    # 联网搜索配置
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
    log.info("rerun-stream: node=%s root=%s models=%s", node_id, root_id, model_ids)

    # 5. 启动后台任务
    history_start, segment_id = await _start_stream_segment(node_id)
    asyncio.create_task(_bg_stream_models(
        node_id=node_id, root_id=root_id,
        model_ids=model_ids, messages_by_model=messages_by_model,
        thinking_budgets=thinking_budgets, search_results=search_results,
        search_config=search_config,
        segment_id=segment_id,
        user_id=user_id,
    ))

    # 6. SSE 生成器
    async def event_generator():
        yield _sse("node_ready", {"root_id": root_id, "node_id": node_id})
        async for event in _subscribe_stream(node_id, history_start=history_start, user_id=user_id):
            yield event

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ═══════════════════════════════════════════════
# API: Chat Stream (SSE 流式对话) — 解耦版
# ═══════════════════════════════════════════════
# 核心设计: LLM 调用通过 asyncio.create_task 与 HTTP 连接解耦。
# 前端断开不影响后台继续获取回复，重新打开页面可恢复。
#
# 数据流:
#   POST /api/chat/stream  → 创建节点 → 启动后台任务 → SSE 订阅频道
#   GET  /api/chat/stream/{node_id} → 重连流(DB 轮询恢复)
#
# 每个 node_id 对应一个短生命周期频道。频道为每个订阅者创建独立队列，
# 避免多个 SSE 连接竞争消费同一个 asyncio.Queue 导致事件丢失。
# history 用于覆盖“后台任务先于浏览器开始读取”的短暂竞态。
