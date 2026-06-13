from app_state import _get_user_id, db
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from routes.import_routes import (
    MINERU_ASSET_EXTENSIONS,
    _collect_response_delete_asset_ids,
    _mineru_asset_root,
    _remove_mineru_response_assets_many,
    _safe_zip_member_path,
)

router = APIRouter()

@router.get("/api/nodes/{node_id}/responses")
def list_node_responses(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(db.get_node_responses(node_id, user_id=user_id))


# ═══ API: 回答 (Responses) ═══
# Response(回答) + Nut(文字锚点)

@router.get("/api/responses/{response_id}")
def get_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    resp = db.get_response(response_id, user_id=user_id)
    if not resp:
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(resp)


@router.get("/api/responses/{response_id}/assets/{asset_path:path}")
def get_response_asset(response_id: str, asset_path: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)

    safe_path = _safe_zip_member_path(asset_path)
    if not safe_path:
        return JSONResponse({"error": "资源路径无效"}, status_code=400)
    if safe_path.suffix.lower() not in MINERU_ASSET_EXTENSIONS:
        return JSONResponse({"error": "资源类型不支持"}, status_code=400)

    root = _mineru_asset_root(user_id, response_id)
    target = root / safe_path
    try:
        resolved_root = root.resolve()
        resolved_target = target.resolve()
    except OSError:
        return JSONResponse({"error": "资源不存在"}, status_code=404)
    if resolved_root not in resolved_target.parents or not resolved_target.is_file():
        return JSONResponse({"error": "资源不存在"}, status_code=404)

    return FileResponse(
        str(resolved_target),
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.patch("/api/responses/{response_id}")
async def update_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    resp = db.update_response(response_id, user_id=user_id, **data)
    if not resp:
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(resp)


@router.delete("/api/responses/{response_id}")
def delete_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    response_ids = _collect_response_delete_asset_ids(response_id, user_id=user_id)
    db.delete_response(response_id, user_id=user_id)
    _remove_mineru_response_assets_many(user_id, response_ids)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: Nuts (螺母)
# ═══════════════════════════════════════════════

@router.post("/api/responses/{response_id}/nuts")
async def create_nut(response_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    data = await request.json()
    seek = data.get("seek", 0)
    end_seek = data.get("end_seek", seek)
    label = data.get("label", "")
    nut = db.create_nut(response_id, seek, end_seek, user_id=user_id, label=label)
    return JSONResponse(nut)


@router.get("/api/responses/{response_id}/nuts")
def list_nuts(response_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(db.get_response_nuts(response_id, user_id=user_id))


@router.delete("/api/nuts/{nut_id}")
def delete_nut(nut_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_nut(nut_id, user_id=user_id):
        return JSONResponse({"error": "螺母不存在"}, status_code=404)
    db.delete_nut(nut_id, user_id=user_id)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: 搜索
# ═══════════════════════════════════════════════

# ═══ API: 全文搜索 (FTS5) ═══
