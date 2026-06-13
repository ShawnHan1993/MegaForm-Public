from app_state import (
    MINERU_MODEL_ID,
    MINERU_MODEL_NAME,
    MINERU_USAGE_CALLS_SETTING,
    MINERU_USAGE_INPUT_SETTING,
    MINERU_USAGE_OUTPUT_SETTING,
    MODEL_CONFIG_SCHEMA,
    PROFILE_UPDATE_MODEL_SETTING,
    SEARCH_PROVIDERS,
    SUMMARY_AUTO_ENABLED_SETTING,
    SUMMARY_MODEL_SETTING,
    _filter_valid_model_ids,
    _get_model_config_for_call,
    _get_profile_update_model_id,
    _get_summary_auto_enabled,
    _get_selected_model_ids,
    _get_summary_model_id,
    _get_thinking_budgets,
    _get_user_id,
    _profile_enabled_default,
    compute_cost,
    db,
    httpx,
    json,
    log,
)
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

router = APIRouter()

@router.get("/api/search")
def search(request: Request, q: str = Query(""), group_id: list[str] = Query(default=[])):
    if not q:
        return JSONResponse([])
    user_id = _get_user_id(request)
    return JSONResponse(db.search_all(q, user_id=user_id, group_ids=group_id))


# ═══════════════════════════════════════════════
# API: 模型配置
# ═══════════════════════════════════════════════

# ═══ API: 模型配置 (Model Configs) ═══

@router.get("/api/models")
def list_models(request: Request):
    user_id = _get_user_id(request)
    configs = db.get_model_configs(user_id=user_id)
    recent_usage = db.get_recent_model_usage(days=2, user_id=user_id)
    for cfg in configs:
        usage = recent_usage.get(cfg["id"], {})
        cfg["recent_usage_count"] = usage.get("usage_count", 0)
        cfg["recent_token_usage"] = usage.get("token_usage", 0)
    configs.extend(db.list_shared_model_configs_for_user(user_id=user_id))
    selected_ids = _get_selected_model_ids(user_id=user_id)
    thinking_budgets = _get_thinking_budgets(user_id=user_id)
    return JSONResponse({
        "models": configs,
        "selected_model_ids": selected_ids,
        "summary_model_id": _get_summary_model_id(user_id=user_id),
        "summary_auto_enabled": _get_summary_auto_enabled(user_id=user_id),
        "profile_update_model_id": _get_profile_update_model_id(user_id=user_id),
        "thinking_budgets": thinking_budgets,
        "schema": MODEL_CONFIG_SCHEMA,
    })


@router.post("/api/models")
async def save_model(request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    # 移除旧 is_default 字段（前端可能还在发送）
    data.pop("is_default", None)
    # 归一化 id：空字符串/纯空白 → 后端自动生成新 ID
    data["id"] = (data.get("id") or "").strip()
    result = db.save_model_config(data, user_id=user_id)
    log.info("models: 保存模型 id=%s name=%s provider=%s", result["id"], data.get("name","?"), data.get("provider","?"))
    return JSONResponse({"id": result["id"], "status": "ok"})


@router.delete("/api/models/{model_id}")
def delete_model(model_id: str, request: Request):
    user_id = _get_user_id(request)
    if not model_id or not model_id.strip():
        return JSONResponse({"status": "error", "message": "model_id cannot be empty"}, status_code=400)
    # 先查模型名用于日志
    cfg = db.get_model_config(model_id, user_id=user_id)
    if not cfg:
        return JSONResponse({"status": "error", "message": "模型不存在"}, status_code=404)
    log.info("models: 删除模型 id=%s name=%s", model_id, cfg["name"] if cfg else "?")
    db.delete_model_config(model_id, user_id=user_id)
    return JSONResponse({"status": "ok"})

# 防止空 model_id 导致 405（前端可能传空字符串）
@router.delete("/api/models/")
def delete_model_empty():
    return JSONResponse({"status": "error", "message": "model_id cannot be empty"}, status_code=400)




@router.put("/api/models/{model_id}/thinking-budget")
async def set_thinking_budget(model_id: str, request: Request):
    """持久化模型的思考强度设置"""
    user_id = _get_user_id(request)
    data = await request.json()
    budget = int(data.get("thinking_budget", 0))
    cfg = db.get_model_config_by_id(model_id, user_id=user_id)
    if not cfg:
        return JSONResponse({"status": "error", "message": "模型不存在"}, status_code=404)
    cfg["thinking_budget"] = budget
    db.save_model_config(cfg, user_id=user_id)
    log.info("models: 思考强度 id=%s budget=%d", model_id, budget)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: 模型发现 — 从供应商动态获取可用模型列表
# ═══════════════════════════════════════════════

PROVIDER_DISCOVER = {
    # OpenAI-compatible /v1/models 端点
    "openai":    {"url_tpl": "{base_url}/models",  "style": "openai"},
    "deepseek":  {"url_tpl": "{base_url}/models",  "style": "openai"},
    "kimi":      {"url_tpl": "{base_url}/models",  "style": "openai"},
    "minimax":   {"url_tpl": "{base_url}/models",  "style": "openai"},
    # 智谱
    "zhipu":     {"url_tpl": "{base_url}/models",  "style": "openai"},
    # Anthropic — 无标准 models 端点，返回已知模型列表
    "anthropic": {"url_tpl": None,                  "style": "static",
                  "static_models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514",
                                    "claude-3.7-sonnet-20250219", "claude-3.5-haiku-20241022"]},
    # Gemini
    "gemini":    {"url_tpl": None,                  "style": "static",
                  "static_models": ["gemini-2.5-pro", "gemini-2.5-flash",
                                    "gemini-2.0-flash", "gemini-2.0-flash-lite"]},
    # Ollama 本地 — /api/tags (注意 base_url 可能含 /v1 后缀)
    "ollama":    {"url_tpl": "{base_url_api}/tags", "style": "ollama"},
}


@router.post("/api/models/discover")
async def discover_models(request: Request):
    """动态发现供应商可用模型列表。"""
    """根据供应商类型和 API Key 动态获取可用模型列表"""
    _get_user_id(request)
    data = await request.json()
    provider = data.get("provider", "")
    base_url = data.get("base_url", "")
    api_key = data.get("api_key", "")

    if not provider:
        return JSONResponse({"status": "error", "message": "provider is required"}, status_code=400)

    log.info("discover: provider=%s base_url=%s", provider, base_url[:60] if base_url else "(none)")
    info = PROVIDER_DISCOVER.get(provider)
    if not info:
        # 未知供应商，尝试 OpenAI 兼容
        if base_url:
            info = {"url_tpl": "{base_url}/models", "style": "openai"}
        else:
            return JSONResponse({"status": "error", "message": f"不支持的供应商: {provider}"}, status_code=400)

    style = info["style"]

    # ── 静态列表（Anthropic / Gemini） ──
    if style == "static":
        models = []
        for m in info["static_models"]:
            models.append({"model_name": m, "name": m, "source": "static"})
        return JSONResponse({"status": "ok", "models": models})

    # ── Ollama 本地 ──
    if style == "ollama":
        # Ollama 的 /api/tags 端点在根路径下，不含 /v1
        api_base = base_url.rstrip("/")
        if api_base.endswith("/v1"):
            api_base = api_base[:-3]
        url = info["url_tpl"].format(base_url_api=f"{api_base}/api")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                body = resp.json()
                models = []
                for m in body.get("models", []):
                    name = m.get("name", m.get("model", ""))
                    models.append({"model_name": name, "name": name, "source": "ollama"})
                return JSONResponse({"status": "ok", "models": models})
        except Exception as e:
            log.error("discover: Ollama 连接失败 %s: %s", url, e)
            return JSONResponse({"status": "error", "message": f"无法连接 Ollama: {e}"}, status_code=502)

    # ── OpenAI 兼容 /v1/models ──
    if style == "openai":
        url = info["url_tpl"].format(base_url=base_url.rstrip("/"))
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                body = resp.json()
                models = []
                for m in body.get("data", []):
                    mid = m.get("id", "")
                    # 过滤掉过老的 / 不常用的
                    if not mid:
                        continue
                    models.append({"model_name": mid, "name": mid, "source": "api",
                                   "owned_by": m.get("owned_by", "")})
                # 按 model_name 排序
                models.sort(key=lambda x: x["model_name"])
                return JSONResponse({"status": "ok", "models": models})
        except httpx.HTTPStatusError as e:
            log.error("discover: API 返回 %s %s: %.200s", provider, e.response.status_code, e.response.text)
            return JSONResponse({"status": "error",
                                 "message": f"API 返回 {e.response.status_code}: {e.response.text[:200]}"},
                                status_code=502)
        except Exception as e:
            log.error("discover: 请求失败 %s: %s", provider, e)
            return JSONResponse({"status": "error", "message": f"请求失败: {e}"}, status_code=502)

    return JSONResponse({"status": "error", "message": "未处理的供应商类型"}, status_code=400)


# ═══════════════════════════════════════════════
# API: Token 用量
# ═══════════════════════════════════════════════

# ═══ API: Token 用量 ═══

@router.get("/api/token-usage")
def token_usage(request: Request):
    user_id = _get_user_id(request)
    configs = db.get_all_model_configs_map(user_id=user_id)  # 含已删除模型，确保历史用量中的模型名不丢失
    # call_count 仍从 responses 统计（计数不受删除影响），但 token 从 model_configs 直读
    call_counts = db.get_token_usage_call_counts(user_id=user_id)

    enriched = []
    for cfg in configs.values():
        call_count = call_counts.get(cfg["id"], 0)
        total_input = cfg.get("input_tokens", 0) or 0
        total_output = cfg.get("output_tokens", 0) or 0
        cumulative_usage = cfg.get("usage", 0) or 0
        if call_count == 0 and total_input == 0 and total_output == 0:
            continue  # 从未使用过的模型不显示
        enriched.append({
            "model_id": cfg["id"],
            "model_name": cfg.get("name", cfg["id"]),
            "call_count": call_count,
            "total_input": total_input,
            "total_output": total_output,
            "total_tokens": total_input + total_output,
            "price_unit": cfg.get("price_unit", "CNY"),
            "deleted": cfg.get("deleted", 0),
            "cumulative_usage": round(cumulative_usage, 4),
        })

    mineru_call_count = int(db.get_setting(MINERU_USAGE_CALLS_SETTING, "0", user_id=user_id) or 0)
    mineru_total_input = int(db.get_setting(MINERU_USAGE_INPUT_SETTING, "0", user_id=user_id) or 0)
    mineru_total_output = int(db.get_setting(MINERU_USAGE_OUTPUT_SETTING, "0", user_id=user_id) or 0)
    if MINERU_MODEL_ID not in configs and (mineru_call_count or mineru_total_input or mineru_total_output):
        enriched.append({
            "model_id": MINERU_MODEL_ID,
            "model_name": MINERU_MODEL_NAME,
            "call_count": mineru_call_count,
            "total_input": mineru_total_input,
            "total_output": mineru_total_output,
            "total_tokens": mineru_total_input + mineru_total_output,
            "price_unit": "CNY",
            "deleted": 0,
            "cumulative_usage": 0,
        })

    # 按调用次数降序排列，已删除模型排在最后；同次数时用 token 总量兜底
    enriched.sort(key=lambda x: (x["deleted"], -x["call_count"], -x["total_tokens"]))

    totals = {
        "call_count": sum(r["call_count"] for r in enriched),
        "total_input": sum(r["total_input"] for r in enriched),
        "total_output": sum(r["total_output"] for r in enriched),
        "total_tokens": sum(r["total_tokens"] for r in enriched),
        "cumulative_usage": round(sum(r["cumulative_usage"] for r in enriched), 4),
    }

    return JSONResponse({"models": enriched, "totals": totals})


@router.post("/api/model-configs/{model_id}/recalculate-cost")
def recalculate_model_cost(model_id: str, request: Request):
    """以当前登记的模型定价重新计算该模型的累计消费金额。

    从 responses 表汇总该模型的所有 token 用量，再按 model_configs
    中当前的 price_per_input / price_per_output 重新计算总消费，
    并回写到 model_configs.usage。
    """
    user_id = _get_user_id(request)
    cfg = db.get_model_config(model_id, user_id=user_id)
    if not cfg:
        return JSONResponse({"error": "模型不存在"}, status_code=404)

    # 汇总该模型所有回答的 token 用量
    usage = db.get_token_usage(user_id=user_id)
    model_usage = next((u for u in usage if u["model_id"] == model_id), None)
    if not model_usage:
        # 无用量记录，将 usage 归零
        conn = db.get_db()
        conn.execute("UPDATE model_configs SET usage=0 WHERE id=? AND user_id=?", (model_id, user_id))
        conn.commit()
        conn.close()
        return JSONResponse({"cumulative_usage": 0, "total_input": 0, "total_output": 0})

    total_input = model_usage["total_input"]
    total_output = model_usage["total_output"]
    cost = compute_cost(cfg, total_input, total_output)

    # 直接设置 usage 为重新计算的值（覆盖而非累加）
    conn = db.get_db()
    conn.execute("UPDATE model_configs SET usage=? WHERE id=? AND user_id=?", (round(cost, 4), model_id, user_id))
    conn.commit()
    conn.close()

    log.info("重新计算模型 %s 消费: input=%d output=%d cost=%.4f",
             cfg.get("name", model_id), total_input, total_output, cost)
    return JSONResponse({
        "cumulative_usage": round(cost, 4),
        "total_input": total_input,
        "total_output": total_output,
    })


# ═══════════════════════════════════════════════
# API: Settings
# ═══════════════════════════════════════════════

@router.get("/api/profile")
def get_profile(request: Request):
    user_id = _get_user_id(request)
    profile = db.get_user_profile(user_id=user_id)
    return JSONResponse({
        "content": profile.get("content", ""),
        "current_version_id": profile.get("current_version_id"),
        "updated_at": profile.get("updated_at"),
        "injection_enabled": _profile_enabled_default(user_id=user_id),
        "profile_update_model_id": _get_profile_update_model_id(user_id=user_id),
    })


@router.post("/api/profile")
async def save_profile(request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    content = str(data.get("content") or "")
    if len(content) > 200_000:
        return JSONResponse({"error": "Profile 太长，最多 200000 字符"}, status_code=400)
    if "injection_enabled" in data:
        db.set_setting(
            "profile_injection_enabled",
            "true" if data.get("injection_enabled") else "false",
            user_id=user_id,
        )
    if PROFILE_UPDATE_MODEL_SETTING in data:
        model_id = str(data.get(PROFILE_UPDATE_MODEL_SETTING) or "").strip()
        db.set_setting(
            PROFILE_UPDATE_MODEL_SETTING,
            model_id if _get_model_config_for_call(model_id, user_id=user_id) else "",
            user_id=user_id,
        )
    profile = db.save_user_profile(content, user_id=user_id, note=str(data.get("note") or "手动保存"))
    return JSONResponse({
        "status": "ok",
        "content": profile.get("content", ""),
        "current_version_id": profile.get("current_version_id"),
        "updated_at": profile.get("updated_at"),
        "injection_enabled": _profile_enabled_default(user_id=user_id),
        "profile_update_model_id": _get_profile_update_model_id(user_id=user_id),
    })


@router.get("/api/profile/history")
def get_profile_history(request: Request, limit: int = Query(50)):
    user_id = _get_user_id(request)
    return JSONResponse(db.list_user_profile_versions(user_id=user_id, limit=limit))


@router.post("/api/profile/history/{version_id}/restore")
def restore_profile(version_id: str, request: Request):
    user_id = _get_user_id(request)
    profile = db.restore_user_profile_version(version_id, user_id=user_id)
    if not profile:
        return JSONResponse({"error": "版本不存在"}, status_code=404)
    return JSONResponse({
        "status": "ok",
        "content": profile.get("content", ""),
        "current_version_id": profile.get("current_version_id"),
        "updated_at": profile.get("updated_at"),
        "injection_enabled": _profile_enabled_default(user_id=user_id),
        "profile_update_model_id": _get_profile_update_model_id(user_id=user_id),
    })

@router.get("/api/settings")
def get_settings(request: Request):
    user_id = _get_user_id(request)
    return JSONResponse(db.get_all_settings(user_id=user_id))


@router.post("/api/settings")
async def save_settings(request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    if "selected_model_ids" in data:
        try:
            ids = json.loads(data["selected_model_ids"])
        except (json.JSONDecodeError, TypeError):
            ids = []
        if not isinstance(ids, list):
            ids = []
        data["selected_model_ids"] = json.dumps(_filter_valid_model_ids(ids, user_id=user_id), ensure_ascii=False)
    if SUMMARY_MODEL_SETTING in data:
        summary_model_id = str(data.get(SUMMARY_MODEL_SETTING) or "").strip()
        data[SUMMARY_MODEL_SETTING] = summary_model_id if db.get_model_config(summary_model_id, user_id=user_id) else ""
    if SUMMARY_AUTO_ENABLED_SETTING in data:
        data[SUMMARY_AUTO_ENABLED_SETTING] = "true" if str(data.get(SUMMARY_AUTO_ENABLED_SETTING)).lower() == "true" else "false"
    if PROFILE_UPDATE_MODEL_SETTING in data:
        model_id = str(data.get(PROFILE_UPDATE_MODEL_SETTING) or "").strip()
        data[PROFILE_UPDATE_MODEL_SETTING] = model_id if _get_model_config_for_call(model_id, user_id=user_id) else ""
    db.batch_set_settings({k: str(v) for k, v in data.items()}, user_id=user_id)
    return JSONResponse({"status": "ok"})


@router.get("/api/settings/web-search-enabled")
def get_web_search_enabled(request: Request):
    """返回 web_search_enabled 开关状态"""
    user_id = _get_user_id(request)
    val = db.get_setting("web_search_enabled", "false", user_id=user_id)
    return JSONResponse({"enabled": val.lower() == "true"})


@router.put("/api/settings/web-search-enabled")
async def set_web_search_enabled(request: Request):
    """设置 web_search_enabled 开关状态"""
    user_id = _get_user_id(request)
    data = await request.json()
    db.set_setting("web_search_enabled", "true" if data.get("enabled") else "false", user_id=user_id)
    return JSONResponse({"status": "ok"})


@router.get("/api/settings/selected-model-ids")
def get_selected_model_ids(request: Request):
    """返回用户持久化的已选模型 ID 列表"""
    user_id = _get_user_id(request)
    ids = _get_selected_model_ids(user_id=user_id)
    return JSONResponse({"ids": ids})


@router.put("/api/settings/selected-model-ids")
async def set_selected_model_ids(request: Request):
    """持久化用户已选模型 ID 列表"""
    user_id = _get_user_id(request)
    data = await request.json()
    ids = data.get("ids", [])
    if not isinstance(ids, list):
        ids = []
    ids = _filter_valid_model_ids(ids, user_id=user_id)
    db.set_setting("selected_model_ids", json.dumps(ids, ensure_ascii=False), user_id=user_id)
    log.info("settings: 保存 selected_model_ids=%s", ids)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: 定价同步
# ═══════════════════════════════════════════════

@router.post("/api/price-sync")
async def manual_price_sync(request: Request):
    """手动触发一次定价同步（返回更新的模型数）"""
    user_id = _get_user_id(request)
    import price_crawler
    try:
        updated = await price_crawler.sync_prices(user_id=user_id)
        return JSONResponse({"status": "ok", "updated": updated})
    except Exception as e:
        log.error("price_sync 手动触发异常: %s", e, exc_info=True)
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@router.get("/api/price-sync/last")
def last_price_sync(request: Request):
    """返回上次定价同步的时间"""
    user_id = _get_user_id(request)
    last = db.get_setting("price_last_sync", "", user_id=user_id)
    return JSONResponse({"last_sync": last})


# ═══════════════════════════════════════════════
# API: Search Config
# ═══════════════════════════════════════════════

@router.get("/api/search-providers")
def get_search_providers(request: Request):
    """返回可用搜索服务提供商列表（含预设 URL / 定价信息）"""
    _get_user_id(request)
    return JSONResponse(SEARCH_PROVIDERS)


# ── SPA Catch-all (必须在最后) ──
# ═══ SPA Catch-all (必须在所有 API 之后) ═══
