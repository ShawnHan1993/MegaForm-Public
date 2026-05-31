"""
MegaForm v2 — 巨型问题
节点-回答树模型: Root Node → Node → Response, Nut 锚定追问

架构: FastAPI + SQLite + 多 LLM 并行调用
数据流: 用户输入 → 追溯祖先链 → 多模型并行 → SSE 流式输出 → 树状展示
"""
import json
import os
import re
import time
import logging
import httpx
from difflib import SequenceMatcher
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import FastAPI, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import database as db
import auth as authn
from models import chat_completion_stream, compute_cost, MODEL_CONFIG_SCHEMA
from web_search import SEARCH_PROVIDERS

import asyncio

BASE_DIR = Path(__file__).parent
DIST_DIR = BASE_DIR / "static" / "dist"
SYSTEM_PROMPTS = {
    "zh-CN": "你是一个有帮助的助手。请优先使用用户当前提问所使用的语言回答。\n今天的日期是 {}。",
    "en": "You are a helpful assistant. Prefer answering in the language the user is using in the current request.\nToday's date is {}.",
}
PROFILE_CONTEXT_TEMPLATES = {
    "zh-CN": """
以下 Markdown 是用户的全局 Profile。把它作为背景知识和偏好参考，而不是用户当前请求。如果当前请求与 Profile 冲突，请遵循当前请求。

<user_profile_markdown>
{}
</user_profile_markdown>
""",
    "en": """
The following Markdown is the user's global profile. Treat it as background knowledge and preference guidance, not as the user's current request. If the current request conflicts with this profile, follow the current request.

<user_profile_markdown>
{}
</user_profile_markdown>
""",
}

# ── 日志 ──────────────────────────────────────────────────────────────

def setup_logging():
    """配置统一日志格式"""
    level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)-5s] %(name)s | %(message)s",
        datefmt="%m-%d %H:%M:%S",
        force=True,
    )
    # 抑制过于啰嗦的第三方库日志
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

log = logging.getLogger("megaform")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _get_user_id(request: Request) -> str:
    return authn.require_user(request)["id"]


def _normalize_locale(value: str | None) -> str:
    return value if value in {"zh-CN", "en"} else "zh-CN"


def _get_user_language(user_id: str = db.LOCAL_USER_ID) -> str:
    user = db.get_user(user_id)
    return _normalize_locale(user.get("locale") if user else None)


def _get_selected_model_ids(user_id: str = db.LOCAL_USER_ID) -> list[str]:
    """从 settings 表读取用户已选模型 ID 列表，过滤已删除/不存在的模型。
    
    如果 settings 中无记录，则使用第一个可用模型作为初始选择。
    返回有效的模型 ID 列表（可能为空）。
    """
    try:
        val = db.get_setting("selected_model_ids", "[]", user_id=user_id)
        ids = json.loads(val)
        if not isinstance(ids, list):
            ids = []
    except (json.JSONDecodeError, TypeError):
        ids = []
    
    # 过滤：只保留存在且未删除的模型
    configs = _get_visible_model_configs(user_id=user_id)
    valid_ids = {c["id"] for c in configs}
    filtered = [mid for mid in ids if mid in valid_ids]
    
    # 如果没有有效选择，自动选第一个可用模型
    if not filtered and configs:
        filtered = [configs[0]["id"]]
    
    return filtered


def _get_thinking_budgets(user_id: str = db.LOCAL_USER_ID) -> dict[str, int]:
    """从 settings 表读取用户为每个模型设置的思考强度。"""
    try:
        val = db.get_setting("thinking_budgets", "{}", user_id=user_id)
        budgets = json.loads(val)
        if not isinstance(budgets, dict):
            budgets = {}
    except (json.JSONDecodeError, TypeError):
        budgets = {}
    # 过滤：只保留有效模型 ID 的配置
    configs = _get_visible_model_configs(user_id=user_id)
    valid_ids = {c["id"] for c in configs}
    return {k: v for k, v in budgets.items() if k in valid_ids and isinstance(v, (int, float))}


def _filter_valid_model_ids(ids: list, user_id: str = db.LOCAL_USER_ID) -> list[str]:
    """过滤前端传入的模型 ID，只保留当前可用模型。"""
    configs = _get_visible_model_configs(user_id=user_id)
    valid_ids = {c["id"] for c in configs}
    return [mid for mid in ids if isinstance(mid, str) and mid in valid_ids]


def _get_visible_model_configs(user_id: str = db.LOCAL_USER_ID) -> list[dict]:
    configs = db.get_model_configs(user_id=user_id)
    configs.extend(db.list_shared_model_configs_for_user(user_id=user_id))
    return configs


def _get_model_config_for_call(model_id: str, user_id: str = db.LOCAL_USER_ID) -> dict | None:
    if db.is_shared_model_id(model_id):
        return db.resolve_shared_model_config(model_id, user_id=user_id)
    return db.get_model_config(model_id, user_id=user_id)


def _get_model_config_for_display_map(user_id: str = db.LOCAL_USER_ID) -> dict[str, dict]:
    cfg_map = db.get_all_model_configs_map(user_id=user_id)
    for cfg in db.list_shared_model_configs_for_user(user_id=user_id):
        cfg_map[cfg["id"]] = cfg
    return cfg_map


def _profile_enabled_default(user_id: str = db.LOCAL_USER_ID) -> bool:
    return db.get_setting("profile_injection_enabled", "true", user_id=user_id).lower() != "false"


def _should_use_profile(value, user_id: str = db.LOCAL_USER_ID) -> bool:
    if value is None:
        return _profile_enabled_default(user_id=user_id)
    return bool(value)


def _build_system_prompt(user_id: str = db.LOCAL_USER_ID, use_profile: bool = True) -> dict:
    language = _get_user_language(user_id)
    content = SYSTEM_PROMPTS[language].format(datetime.now().strftime("%Y-%m-%d %H:%M"))
    if use_profile:
        profile = db.get_user_profile(user_id=user_id)
        profile_md = (profile.get("content") or "").strip()
        if profile_md:
            content += "\n" + PROFILE_CONTEXT_TEMPLATES[language].format(profile_md)
    return {"role": "system", "content": content}


SUMMARY_MODEL_SETTING = "summary_model_id"
NODE_SUMMARY_MIN_TOKENS = 30
SUMMARY_MAX_TOKENS = 25
ROOT_SUMMARY_DEBOUNCE_SECONDS = int(os.environ.get("MEGAFORM_ROOT_SUMMARY_DEBOUNCE_SECONDS", "3600"))
ROOT_SUMMARY_MIN_NODES = 3
ROOT_SUMMARY_DAILY_HOUR = int(os.environ.get("MEGAFORM_ROOT_SUMMARY_DAILY_HOUR", "3"))
_root_summary_tasks: dict[str, asyncio.Task] = {}


def _get_summary_model_id(user_id: str = db.LOCAL_USER_ID) -> str:
    model_id = db.get_setting(SUMMARY_MODEL_SETTING, "", user_id=user_id).strip()
    return model_id if db.get_model_config(model_id, user_id=user_id) else ""


def _get_summary_model_config(user_id: str = db.LOCAL_USER_ID) -> dict | None:
    model_id = _get_summary_model_id(user_id=user_id)
    if not model_id:
        return None
    cfg = db.get_model_config(model_id, user_id=user_id)
    if not cfg:
        return None
    if cfg.get("provider") != "ollama" and not cfg.get("api_key"):
        log.info("summary: 摘要模型 %s 缺少 API Key，跳过", model_id)
        return None
    cfg = dict(cfg)
    cfg["max_tokens"] = min(int(cfg.get("max_tokens") or 4096), 256)
    return cfg


def _estimate_tokens(text: str) -> int:
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    words = len(re.findall(r"[A-Za-z0-9_]+", text))
    other = max(0, len(re.sub(r"[\s\u3400-\u9fffA-Za-z0-9_]", "", text)) // 2)
    return cjk + words + other


def _clean_summary(text: str) -> str:
    text = re.sub(r"^[\s\"'“”‘’`]+|[\s\"'“”‘’`。.!！?？]+$", "", text.strip())
    text = re.sub(r"\s+", " ", text)
    if _estimate_tokens(text) <= SUMMARY_MAX_TOKENS:
        return text
    if re.search(r"\s", text):
        return " ".join(text.split()[:SUMMARY_MAX_TOKENS]).strip()
    return text[:SUMMARY_MAX_TOKENS * 2].strip()


def _summary_changed_enough(old: str, new: str) -> bool:
    old_norm = re.sub(r"\s+", "", (old or "").strip().lower())
    new_norm = re.sub(r"\s+", "", (new or "").strip().lower())
    if not new_norm or old_norm == new_norm:
        return False
    if not old_norm:
        return True
    return SequenceMatcher(None, old_norm, new_norm).ratio() < 0.72


async def _call_summary_model(prompt: str, user_id: str = db.LOCAL_USER_ID) -> str:
    cfg = _get_summary_model_config(user_id=user_id)
    if not cfg:
        return ""
    full_content = ""
    async for chunk in chat_completion_stream(
        cfg,
        [{"role": "user", "content": prompt}],
        thinking_budget=0,
        search_config=None,
        language=_get_user_language(user_id),
    ):
        log.info("summary chunk: %s %.80r", chunk.get("type"), chunk.get("content", ""))
        pass
        if chunk["type"] == "content":
            full_content += chunk["content"]
    return _clean_summary(full_content)


def _node_depth_from_root(node_id: str, user_id: str = db.LOCAL_USER_ID) -> int | None:
    path = db.get_path_to_root(node_id, user_id=user_id)
    if not path:
        return None
    return len(path) - 1


def _mark_root_summary_dirty_if_shallow_node(node_id: str, user_id: str = db.LOCAL_USER_ID):
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return
    depth = _node_depth_from_root(node_id, user_id=user_id)
    if depth is not None and depth <= 1:
        _mark_root_summary_dirty(node["root_id"], user_id=user_id)


def _root_shallow_node_lines(root_id: str, user_id: str = db.LOCAL_USER_ID) -> list[str]:
    language = _get_user_language(user_id)
    nodes = db.get_root_nodes(root_id, user_id=user_id)
    by_id = {n["id"]: n for n in nodes}
    lines = []
    for node in nodes:
        depth = 0
        parent_id = node.get("parent_id")
        while parent_id and parent_id in by_id:
            depth += 1
            parent_id = by_id[parent_id].get("parent_id")
        if depth <= 1:
            summary = (node.get("summary") or "").strip()
            content = re.sub(r"\s+", " ", node.get("content") or "").strip()
            label = ("Root" if depth == 0 else "Level 2") if language == "en" else ("第一层" if depth == 0 else "第二层")
            if summary:
                lines.append(f"- {label}: {summary} | {content[:500]}")
            else:
                lines.append(f"- {label}: {content[:500]}")
    return lines


def _root_has_enough_nodes_for_summary(root_id: str, user_id: str = db.LOCAL_USER_ID) -> bool:
    return len(db.get_root_nodes(root_id, user_id=user_id)) >= ROOT_SUMMARY_MIN_NODES


async def _generate_root_summary(root_id: str, user_id: str = db.LOCAL_USER_ID):
    root = db.get_root(root_id, user_id=user_id)
    if not root:
        return
    if not _root_has_enough_nodes_for_summary(root_id, user_id=user_id):
        log.info("summary: root=%s 节点数不足 %d，跳过", root_id, ROOT_SUMMARY_MIN_NODES)
        return
    lines = _root_shallow_node_lines(root_id, user_id=user_id)
    if not lines:
        return
    if _get_user_language(user_id) == "en":
        prompt = (
            "Based only on the root node and second-level nodes below, generate an English summary. "
            "Requirements: within 25 tokens; do not explain; do not add quotes; output only the summary. "
            "If there is little information, still summarize the core topic.\n\n"
            + "\n".join(lines[:60])
        )
    else:
        prompt = (
            "请只根据下面这个问题树的根节点和第二层节点，生成一个中文摘要。"
            "要求：25个token以内；不要解释；不要加引号；直接输出摘要。"
            "如果信息很少，也要概括核心主题。\n\n"
            + "\n".join(lines[:60])
        )
    try:
        summary = await _call_summary_model(prompt, user_id=user_id)
        if summary and _summary_changed_enough(root.get("summary", ""), summary):
            db.update_node(root_id, summary=summary, touch_updated_at=False, user_id=user_id)
            log.info("summary: root=%s 摘要已更新: %s", root_id, summary)
    except Exception as e:
        log.warning("summary: root=%s 生成失败: %s", root_id, e)


def _mark_root_summary_dirty(root_id: str, user_id: str = db.LOCAL_USER_ID):
    if not root_id:
        return
    if not _root_has_enough_nodes_for_summary(root_id, user_id=user_id):
        return
    existing = _root_summary_tasks.pop(root_id, None)
    if existing and not existing.done():
        existing.cancel()

    async def _debounced():
        try:
            await asyncio.sleep(ROOT_SUMMARY_DEBOUNCE_SECONDS)
            await _generate_root_summary(root_id, user_id=user_id)
        except asyncio.CancelledError:
            raise
        finally:
            current = _root_summary_tasks.get(root_id)
            if current is asyncio.current_task():
                _root_summary_tasks.pop(root_id, None)

    _root_summary_tasks[root_id] = asyncio.create_task(_debounced())


def _seconds_until_next_daily_root_summary_run() -> float:
    now = datetime.now()
    target = now.replace(
        hour=ROOT_SUMMARY_DAILY_HOUR,
        minute=0,
        second=0,
        microsecond=0,
    )
    if target <= now:
        target += timedelta(days=1)
    return max(1.0, (target - now).total_seconds())


async def _run_daily_root_summary_scan():
    roots = db.get_all_roots(user_id=None)
    eligible = [
        r for r in roots
        if _get_summary_model_id(user_id=r["user_id"])
        and int(r.get("node_count") or 0) >= ROOT_SUMMARY_MIN_NODES
    ]
    log.info("summary-daily: 扫描 %d 个 root，其中 %d 个满足节点数门槛", len(roots), len(eligible))
    for root in eligible:
        await _generate_root_summary(root["id"], user_id=root["user_id"])
        await asyncio.sleep(0)


# ── FastAPI App ──────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log.info("MegaForm 启动中...")
    db.init_db()
    db.migrate_schema()
    db.ensure_local_user()
    expired_sessions = db.cleanup_expired_sessions()
    if expired_sessions:
        log.info("清理过期 session: %d 条", expired_sessions)
    log.info("数据库初始化完成")

    # ── 清理僵尸 streaming response ──
    # 服务重启后，之前处于 streaming 状态的 response 已经不可能再恢复
    # 将内容为空的标记为 error，有部分内容的标记为 completed
    try:
        zombie_count = db.cleanup_zombie_streaming()
        if zombie_count > 0:
            log.info("清理僵尸 streaming: %d 条记录已修复", zombie_count)
    except Exception as e:
        log.warning("清理僵尸 streaming 异常: %s", e)

    configs = db.get_model_configs()
    if not configs:
        log.info("未发现模型配置，创建默认 DeepSeek Chat 配置")
        db.save_model_config({
            "id": "deepseek-chat",
            "name": "DeepSeek Chat",
            "provider": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "",
            "model_name": "deepseek-chat",
            "max_tokens": 4096,
            "price_per_input": 0.5,
            "price_per_output": 2.0,
        })

    # ── 后台守护：每小时清理无关联回答的模型配置 ──
    async def _cleanup_loop():
        while True:
            await asyncio.sleep(3600)  # 每小时执行一次
            try:
                count = db.cleanup_orphan_models()
                log.info("守护清理: 扫描完成，删除 %d 个孤儿模型配置", count)
            except Exception as e:
                log.warning("守护清理异常: %s", e)
    cleanup_task = asyncio.create_task(_cleanup_loop())

    # ── 后台守护：每天凌晨定时刷新有足够节点的问题树摘要 ──
    async def _daily_root_summary_loop():
        while True:
            delay = _seconds_until_next_daily_root_summary_run()
            log.info("summary-daily: 下次全量扫描将在 %.0f 秒后执行", delay)
            await asyncio.sleep(delay)
            try:
                await _run_daily_root_summary_scan()
            except Exception as e:
                log.warning("summary-daily: 全量扫描异常: %s", e, exc_info=True)
    daily_root_summary_task = asyncio.create_task(_daily_root_summary_loop())

    yield
    cleanup_task.cancel()
    daily_root_summary_task.cancel()
    for task in list(_root_summary_tasks.values()):
        task.cancel()
    await asyncio.gather(cleanup_task, daily_root_summary_task, *_root_summary_tasks.values(), return_exceptions=True)
    _root_summary_tasks.clear()


app = FastAPI(title="MegaForm", lifespan=lifespan)

# ── SPA 静态文件 ──
# 开发时 Vite dev server 处理 HMR，生产时 FastAPI serve dist/
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")


# ═══════════════════════════════════════════════
# API: Auth & current user
# ═══════════════════════════════════════════════

@app.get("/api/me")
def get_me(request: Request):
    user = authn.get_current_user_optional(request)
    return JSONResponse({
        "authenticated": bool(user),
        "auth_mode": authn.get_auth_mode(),
        "local_mode": authn.is_local_mode(),
        "email_auth_enabled": authn.email_auth_enabled(),
        "google_auth_configured": authn.google_oauth_configured(),
        "user": authn.public_user(user) if user else None,
    })


@app.post("/api/me/locale")
async def update_locale(request: Request):
    user = authn.require_user(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    updated = db.update_user_locale(user["id"], _normalize_locale(payload.get("locale"))) or user
    return JSONResponse({"status": "ok", "user": authn.public_user(updated)})


def _validate_email_password(payload: dict, *, registering: bool) -> tuple[str, str, str]:
    email = authn.normalize_email(payload.get("email", ""))
    password = payload.get("password", "")
    display_name = (payload.get("display_name") or "").strip()
    if not EMAIL_RE.match(email):
        raise ValueError("请输入有效邮箱")
    if not isinstance(password, str) or len(password) < 8:
        raise ValueError("密码至少需要 8 个字符")
    if registering and len(password) > 256:
        raise ValueError("密码过长")
    return email, password, display_name


@app.post("/api/auth/register")
async def register_email(request: Request):
    if authn.is_local_mode() or not authn.email_auth_enabled():
        return JSONResponse({"error": "邮箱注册未启用"}, status_code=400)
    try:
        payload = await request.json()
        email, password, display_name = _validate_email_password(payload, registering=True)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "请求格式无效"}, status_code=400)

    if db.get_user_by_email(email):
        return JSONResponse({"error": "该邮箱已注册"}, status_code=409)

    try:
        user = db.create_password_user(
            email,
            authn.hash_password(password),
            display_name,
            locale=_normalize_locale(payload.get("locale")),
        )
    except Exception as e:
        log.warning("email-register: failed: %s", e, exc_info=True)
        return JSONResponse({"error": "注册失败"}, status_code=500)

    response = JSONResponse({"status": "ok", "user": authn.public_user(user)})
    authn.create_session_for_user(user["id"], response)
    return response


@app.post("/api/auth/login")
async def login_email(request: Request):
    if authn.is_local_mode() or not authn.email_auth_enabled():
        return JSONResponse({"error": "邮箱登录未启用"}, status_code=400)
    try:
        payload = await request.json()
        email, password, _ = _validate_email_password(payload, registering=False)
    except ValueError:
        return JSONResponse({"error": "邮箱或密码错误"}, status_code=401)
    except Exception:
        return JSONResponse({"error": "请求格式无效"}, status_code=400)

    user = db.get_user_by_email(email)
    if not user or not authn.verify_password(password, user.get("password_hash")):
        return JSONResponse({"error": "邮箱或密码错误"}, status_code=401)

    locale = payload.get("locale")
    if locale in {"zh-CN", "en"}:
        user = db.update_user_locale(user["id"], locale) or user

    response = JSONResponse({"status": "ok", "user": authn.public_user(user)})
    authn.create_session_for_user(user["id"], response)
    return response


@app.post("/api/auth/logout")
def logout(request: Request):
    response = JSONResponse({"status": "ok"})
    if not authn.is_local_mode():
        token = authn.get_request_token(request)
        if token:
            db.delete_session_by_token_hash(authn.hash_token(token))
    authn.clear_session_cookie(response)
    return response


@app.post("/api/auth/logout-all")
def logout_all(request: Request):
    user = authn.get_current_user_optional(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    count = 0 if authn.is_local_mode() else db.delete_user_sessions(user["id"])
    response = JSONResponse({"status": "ok", "revoked_sessions": count})
    authn.clear_session_cookie(response)
    return response


@app.get("/api/auth/google/start")
def google_auth_start(request: Request, next: str = "/", locale: str = ""):
    if not authn.google_oauth_configured():
        return JSONResponse({"error": "Google OAuth 未配置"}, status_code=400)

    bind_user_id = None
    current_user = authn.get_current_user_optional(request)
    if current_user and not authn.is_local_mode():
        bind_user_id = current_user["id"]

    state = authn.new_session_token()
    db.create_oauth_state(
        "google",
        state,
        next_url=next if next.startswith("/") else "/",
        bind_user_id=bind_user_id,
        locale=locale if locale in {"zh-CN", "en"} else "",
    )
    return RedirectResponse(authn.build_google_authorize_url(request, state), status_code=302)


@app.get("/api/auth/google/callback")
async def google_auth_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error:
        return RedirectResponse(url=f"/login?error={error}", status_code=302)
    if not code or not state:
        return JSONResponse({"error": "缺少 OAuth code/state"}, status_code=400)

    state_row = db.consume_oauth_state("google", state)
    if not state_row:
        return JSONResponse({"error": "OAuth state 无效或已过期"}, status_code=400)

    token_payload = {
        "code": code,
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", "").strip(),
        "redirect_uri": authn.google_redirect_uri(request),
        "grant_type": "authorization_code",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            token_resp = await client.post(authn.GOOGLE_TOKEN_URL, data=token_payload)
            token_resp.raise_for_status()
            token_data = token_resp.json()
            access_token = token_data.get("access_token")
            if not access_token:
                return JSONResponse({"error": "Google 未返回 access_token"}, status_code=502)
            user_resp = await client.get(
                authn.GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            user_resp.raise_for_status()
            profile = user_resp.json()
    except httpx.HTTPStatusError as e:
        log.warning("google-oauth: HTTP error %s %.200s", e.response.status_code, e.response.text)
        return JSONResponse({"error": "Google OAuth 请求失败"}, status_code=502)
    except Exception as e:
        log.warning("google-oauth: callback failed: %s", e, exc_info=True)
        return JSONResponse({"error": str(e)}, status_code=502)

    google_sub = profile.get("sub")
    if not google_sub:
        return JSONResponse({"error": "Google 用户信息缺少 sub"}, status_code=502)

    existing_account = db.get_oauth_account("google", google_sub)
    bind_user_id = state_row.get("bind_user_id")
    if bind_user_id:
        user_id = bind_user_id
        if existing_account and existing_account["user_id"] != user_id:
            return JSONResponse({"error": "该 Google 账户已绑定到其他用户"}, status_code=409)
    elif existing_account:
        user_id = existing_account["user_id"]
    else:
        user_id = db.new_id()

    user = db.ensure_user(
        user_id,
        email=profile.get("email"),
        display_name=profile.get("name") or profile.get("email") or "Google User",
        avatar_url=profile.get("picture") or "",
        locale=state_row.get("locale") or profile.get("locale") or "",
    )
    if state_row.get("locale"):
        user = db.update_user_locale(user["id"], state_row.get("locale")) or user
    db.link_oauth_account(
        user["id"],
        "google",
        google_sub,
        email=profile.get("email"),
        raw_profile=profile,
    )

    response = RedirectResponse(url=state_row.get("next_url") or "/", status_code=302)
    authn.create_session_for_user(user["id"], response)
    return response


# ── Helper: 构建上下文 ──────────────────────────────────────────────

def _get_nut_text(nut_id: str, user_id: str = db.LOCAL_USER_ID) -> str | None:
    """根据 nut_id 获取螺母对应的选中文本"""
    if not nut_id:
        return None
    nut = db.get_nut(nut_id, user_id=user_id)
    if not nut:
        return None
    # 从 nut 的 response_id 获取对应回复，截取 seek~end_seek
    resp = db.get_response(nut["response_id"], user_id=user_id)
    if not resp:
        # 退而求其次用 label
        return nut.get("label")
    raw = resp["content"]
    start = nut.get("seek", 0)
    end = nut.get("end_seek", len(raw))
    start = max(0, min(start, len(raw)))
    end = max(start, min(end, len(raw)))
    selected = raw[start:end].strip()
    return selected or nut.get("label")


def _select_best_response(resps: list[dict], model_id: str | None, parent_model_id: str | None = None) -> dict | None:
    """从 responses 列表中按优先级选择最佳回复。
    优先级：model_id 匹配 → parent_model_id 匹配 → 任意第一个"""
    if not resps:
        return None
    if model_id:
        best = next((r for r in resps if r["model_id"] == model_id), None)
        if best:
            return best
    if parent_model_id:
        best = next((r for r in resps if r["model_id"] == parent_model_id), None)
        if best:
            return best
    return resps[0]


def _wrap_followup_content(quote: str, question: str, language: str) -> str:
    if language == "en":
        return (
            f'Regarding this passage from your previous answer, "{quote}", continue with this question:\n'
            f"{question}\nPlease stay focused and avoid unnecessary digressions."
        )
    return f"针对你上面答复的「{quote}」这段话，继续提出如下问题：\n{question}。请不要做过多延伸，恰到好处就行。"


def build_context(
    parent_node_id: str | None,
    content: str,
    model_id: str | None = None,
    current_nut_id: str | None = None,
    current_partial_content: str | None = None,
    current_parent_model_id: str | None = None,
    user_id: str = db.LOCAL_USER_ID,
    use_profile: bool = True,
):
    """
    从 parent_node_id 向上追溯祖先链，构建发给模型的 messages。
    
    逻辑:
    1. 对每个祖先节点: 添加 [用户提问] + [助手回答]
    2. 如果节点是 progression 且有兄弟节点（同父、相同 relation、child_order 更小），
       将兄弟节点的 [提问+回答] 也纳入上下文
    3. 回答按优先级: 每个祖先节点优先使用通向下一个节点的 parent_model_id；
       路径末尾的父节点使用当前请求的 current_parent_model_id；
       无法确定时再用 model_id 匹配 → 任意一个
    4. 如果节点是 followup 且有 nut_id，在用户消息前插入
       "针对你上面答复的「xxx」内容，继续提出如下问题" 的上下文提示
    5. 最后追加当前用户消息，如果当前消息也是 followup，
       通过 current_nut_id / current_partial_content 注入选中文本上下文
    """
    # ── 处理当前消息的 followup 上下文 ──
    language = _get_user_language(user_id)
    current_user_content = content
    system_prompt = _build_system_prompt(user_id=user_id, use_profile=use_profile)
    if current_nut_id:
        nut_text = _get_nut_text(current_nut_id, user_id=user_id)
        if nut_text:
            current_user_content = _wrap_followup_content(nut_text, content, language)
    elif current_partial_content:
        current_user_content = _wrap_followup_content(current_partial_content, content, language)

    if not parent_node_id:
        return [system_prompt, {"role": "user", "content": current_user_content}], None

    path = db.get_path_to_root(parent_node_id, user_id=user_id)
    root_id = path[0]["root_id"] if path else None

    messages = []
    for idx, node in enumerate(path):
        next_node = path[idx + 1] if idx + 1 < len(path) else None
        context_parent_model_id = (
            next_node.get("parent_model_id") if next_node else current_parent_model_id
        )
        # ── Progression 兄弟节点上下文 ──
        # 如果当前节点是 progression，把同父下比自己早的 progression 兄弟也纳入
        user_content = node["content"]  # 用户输入的query
        if node.get("relation") == "progression" and node.get("parent_id"):
            siblings = db.get_progression_siblings_before(
                node["parent_id"], node.get("child_order", 0), user_id=user_id
            )
            for sib in siblings:
                sib_content = sib["content"]
                if sib.get("nut_id") and sib.get("relation") == "followup":
                    # this should not get into
                    continue
                sib_resps = db.get_node_responses(sib["id"], user_id=user_id)
                best_sib = _select_best_response(sib_resps, context_parent_model_id or model_id, sib.get("parent_model_id"))
                if best_sib:
                    messages.append({"role": "user", "content": sib_content})
                    messages.append({"role": "assistant", "content": best_sib["content"]})
        elif node.get("nut_id") and node.get("relation") == "followup" and node.get("parent_id"):
            # ── 处理 followup: 如果有 nut_id，提取选中文本 ──
            nut_text = _get_nut_text(node["nut_id"], user_id=user_id)
            if nut_text:
                user_content = _wrap_followup_content(nut_text, user_content, language)
        # ── 获取该节点的回复 ──
        resps = db.get_node_responses(node["id"], user_id=user_id)
        if context_parent_model_id:
            best = _select_best_response(resps, None, context_parent_model_id)
        else:
            best = _select_best_response(resps, model_id, None)
        if best:
            messages.append({"role": "user", "content": user_content})
            messages.append({"role": "assistant", "content": best["content"]})

    # ── 追加当前用户消息（已包含 followup 上下文） ──
    messages.append({"role": "user", "content": current_user_content})

    # 截断过长上下文
    max_chars = 80000
    total = sum(len(m["content"]) for m in messages)
    while total > max_chars and len(messages) > 2:
        dropped = messages.pop(0)
        total -= len(dropped["content"])

    messages = [system_prompt] + messages
    return messages, root_id


# ── Helper: 选中文本定位

def find_partial_position(raw: str, partial: str) -> tuple[int, int]:
    """
    在 raw markdown 中找到 partial 文本的大致 (start, end) 位置。
    返回 raw 中的字符偏移。

    选区来自浏览器渲染后的可见文本，而 raw 是 Markdown/LaTeX 源文。
    因此除了直接搜索，还需要做一层可见文本归一化：
    - 去掉 Markdown/LaTeX 控制字符和命令名；
    - 保留 LaTeX 命令参数内容，例如 ``\\mathbf{q}`` → ``q``；
    - 统一 unicode minus ``−`` 与 ASCII ``-``；
    - 忽略空白差异。
    """
    pc_clean = re.sub(r'\s+', ' ', partial).strip()
    if not pc_clean:
        return (0, 0)

    # ── 策略1: 直接在 raw 中搜索 ──
    pos = raw.find(pc_clean)
    if pos >= 0:
        return (pos, pos + len(pc_clean))

    def build_normalized_with_map(text: str) -> tuple[str, list[int]]:
        chars: list[str] = []
        raw_map: list[int] = []
        i = 0
        while i < len(text):
            ch = text[i]

            # 跳过 LaTeX 命令名，保留后续 { ... } 中的可见内容。
            if ch == '\\':
                j = i + 1
                while j < len(text) and text[j].isalpha():
                    j += 1
                # ``\\(``, ``\\)`` 这类定界符没有命令名，只跳过反斜杠。
                i = j if j > i + 1 else i + 1
                continue

            # 跳过 Markdown/LaTeX 格式字符。注意保留普通圆括号，公式里的 g(...) 需要它们。
            if ch in '#*`[]!>_~{}$':
                i += 1
                continue

            # 浏览器复制数学公式时常把 hyphen 显示为 unicode minus。
            if ch in '−–—':
                ch = '-'

            # 忽略所有空白差异：raw 可能是 ``g(q, k, m-n)``，选区可能是 ``g(q,k,m−n)``。
            if ch.isspace():
                i += 1
                continue

            chars.append(ch.lower())
            raw_map.append(i)
            i += 1
        return ''.join(chars), raw_map

    def normalize_query(text: str) -> str:
        normalized, _ = build_normalized_with_map(text)
        return normalized

    # ── 策略2: Markdown/LaTeX 可见文本归一化后搜索 ──
    normalized_raw, raw_map = build_normalized_with_map(raw)
    normalized_partial = normalize_query(pc_clean)
    match_pos = normalized_raw.find(normalized_partial)
    if match_pos >= 0 and normalized_partial:
        start_idx = raw_map[match_pos]
        end_idx = raw_map[match_pos + len(normalized_partial) - 1] + 1
        return (start_idx, min(end_idx, len(raw)))

    # ── 策略3: 单词级兜底，仍然尽量避免锚到正文开头 ──
    pc_words = re.findall(r'\w+', normalized_partial)
    for window in range(len(pc_words), 0, -1):
        fragment = ''.join(pc_words[:window])
        if not fragment:
            continue
        match_pos = normalized_raw.find(fragment)
        if match_pos >= 0:
            start_idx = raw_map[match_pos]
            end_idx = raw_map[min(match_pos + len(fragment) - 1, len(raw_map) - 1)] + 1
            return (start_idx, min(end_idx, len(raw)))

    # 找不到时返回空区间，避免错误地把追问插到文章开头。
    return (0, 0)


# ── SPA 首页路由 (必须在 API 路由之后) ──

@app.get("/", response_class=HTMLResponse)
async def serve_spa():
    index_html = DIST_DIR / "index.html"
    if index_html.exists():
        return FileResponse(str(index_html))
    return HTMLResponse(
        """
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>MegaForm</title>
          </head>
          <body>
            <main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 15vh auto; line-height: 1.6;">
              <h1>MegaForm 后端已启动</h1>
              <p>未找到前端构建产物 <code>static/dist/index.html</code>。</p>
              <p>开发模式请运行 <code>cd frontend && npm run dev</code> 后访问 <code>http://localhost:5173</code>。</p>
              <p>生产模式请先运行 <code>cd frontend && npm run build</code>，再访问 <code>http://localhost:8080</code>。</p>
            </main>
          </body>
        </html>
        """,
        status_code=200,
    )


# ═══════════════════════════════════════════════
# API: Roots
# ═══════════════════════════════════════════════

@app.get("/api/roots")
def list_roots(request: Request):
    user_id = _get_user_id(request)
    return JSONResponse(db.get_all_roots(user_id=user_id))


@app.get("/api/roots/{root_id}")
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


@app.patch("/api/roots/{root_id}")
async def update_root(root_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    if not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    # 仅摘要修改时不动 updated_at
    touch = not (set(data.keys()) == {"summary"})
    root = db.update_node(root_id, touch_updated_at=touch, user_id=user_id, **data)
    return JSONResponse(root)


@app.delete("/api/roots/{root_id}")
def delete_root(root_id: str, request: Request):
    user_id = _get_user_id(request)
    db.delete_root(root_id, user_id=user_id)
    return JSONResponse({"status": "ok"})


@app.post("/api/roots/{root_id}/pin")
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

@app.get("/api/roots/{root_id}/nodes")
def list_root_nodes(root_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    return JSONResponse(db.get_root_nodes(root_id, user_id=user_id))


@app.get("/api/roots/{root_id}/tree")
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
        resp["model_name"] = cfg.get("name", mid) or mid
    return resps


@app.get("/api/roots/{root_id}/tree/stream")
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


@app.get("/api/nodes/{node_id}")
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

@app.get("/api/nodes/{node_id}/path")
def get_node_path(node_id: str, request: Request):
    user_id = _get_user_id(request)
    path = db.get_path_to_root(node_id, user_id=user_id)
    if not path:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(path)


@app.get("/api/nodes/{node_id}/children")
def get_node_children(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(db.get_node_children(node_id, user_id=user_id))


@app.patch("/api/nodes/{node_id}")
async def update_node(node_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    node = db.update_node(node_id, user_id=user_id, **data)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    if any(k in data for k in ("content", "relation", "parent_id", "parent_model_id")):
        _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)
    return JSONResponse(node)


@app.delete("/api/nodes/{node_id}")
def delete_node_api(node_id: str, request: Request):
    """级联删除节点及其所有后代。删除根节点=删除整棵问题树。"""
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    depth = _node_depth_from_root(node_id, user_id=user_id)

    if node.get("parent_id") is None:
        root_id = node["root_id"]
        log.info("node: 删除根节点 root=%s", root_id)
        db.delete_root(root_id, user_id=user_id)
        return JSONResponse({"status": "ok", "deleted_root": True, "root_id": root_id})

    count = db.delete_subtree(node_id, user_id=user_id)
    if depth is not None and depth <= 1:
        _mark_root_summary_dirty(node["root_id"], user_id=user_id)
    return JSONResponse({"status": "ok", "deleted_count": count})


# ── 节点折叠/摘要 ──

@app.post("/api/nodes/{node_id}/collapse")
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


@app.post("/api/nodes/{node_id}/expand-subtree")
def expand_node_subtree(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    db.expand_subtree(node_id, user_id=user_id)
    return JSONResponse({"status": "ok"})


@app.post("/api/nodes/{node_id}/summary")
async def update_summary(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    data = await request.json()
    summary = data.get("summary", "")
    db.update_node(node_id, summary=summary, touch_updated_at=False, user_id=user_id)
    return JSONResponse({"status": "ok"})


@app.post("/api/nodes/{node_id}/generate-summary")
async def generate_summary(node_id: str, request: Request):
    """调用配置的摘要模型生成节点摘要（流式收集结果）"""
    user_id = _get_user_id(request)
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return JSONResponse({"error": "节点不存在"}, status_code=404)

    if not _get_summary_model_id(user_id=user_id):
        return JSONResponse({"summary": node.get("summary", ""), "updated": False, "disabled": True})

    content = node["content"]
    if _estimate_tokens(content) <= NODE_SUMMARY_MIN_TOKENS:
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
        if summary and _summary_changed_enough(node.get("summary", ""), summary):
            db.update_node(node_id, summary=summary, touch_updated_at=False, user_id=user_id)
            updated = True
            _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)
        return JSONResponse({"summary": summary or node.get("summary", ""), "updated": updated})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/nodes/{node_id}/rerun/stream")
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
        db.delete_node_responses(node_id, user_id=user_id)
        children = db.get_node_children(node_id, user_id=user_id)
        for child in children:
            db.delete_subtree(child["id"], user_id=user_id)
        log.info("rerun-stream: 全部重跑 node=%s changed=%s",
                 node_id, content_changed)
    else:
        existing_resps = db.get_node_responses(node_id, user_id=user_id)
        existing_model_ids = {r["model_id"] for r in existing_resps}
        for model_id in model_ids:
            if model_id in existing_model_ids:
                log.info("rerun-stream: 模型 %s 已有旧回复，将做替换", model_id)
                db.delete_node_responses(node_id, model_id, user_id=user_id)
                children = db.get_node_children(node_id, parent_model_id=model_id, user_id=user_id)
                for child in children:
                    db.delete_subtree(child["id"], user_id=user_id)
            else:
                log.info("rerun-stream: 模型 %s 没有旧回复，将做扩充", model_id)

    # 4. 构建上下文
    parent_id = node.get("parent_id")
    messages_by_model = {
        mid: build_context(
            parent_id, content, mid,
            current_nut_id=node.get("nut_id"),
            current_parent_model_id=node.get("parent_model_id"),
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

_stream_channels: dict[str, dict] = {}
_stream_channels_lock = asyncio.Lock()


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
            total_input_chars = sum(len(m["content"]) for m in messages)
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


@app.post("/api/chat/stream")
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
        mid: build_context(
            parent_id, content, mid,
            current_nut_id=nut_id,
            current_partial_content=partial_content,
            current_parent_model_id=parent_model_id,
            user_id=user_id,
            use_profile=use_profile,
        )[0]
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
    node_kwargs["meta"] = node_meta
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


@app.get("/api/chat/stream/{node_id}")
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


@app.post("/api/node/{node_id}/add-model")
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
        current_nut_id=node.get("nut_id"),
        current_parent_model_id=node.get("parent_model_id"),
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

@app.get("/api/nodes/{node_id}/responses")
def list_node_responses(node_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_node(node_id, user_id=user_id):
        return JSONResponse({"error": "节点不存在"}, status_code=404)
    return JSONResponse(db.get_node_responses(node_id, user_id=user_id))


# ═══ API: 回答 (Responses) ═══
# Response(回答) + Nut(文字锚点)

@app.get("/api/responses/{response_id}")
def get_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    resp = db.get_response(response_id, user_id=user_id)
    if not resp:
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(resp)


@app.patch("/api/responses/{response_id}")
async def update_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    data = await request.json()
    resp = db.update_response(response_id, user_id=user_id, **data)
    if not resp:
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(resp)


@app.delete("/api/responses/{response_id}")
def delete_response(response_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    db.delete_response(response_id, user_id=user_id)
    return JSONResponse({"status": "ok"})


# ═══════════════════════════════════════════════
# API: Nuts (螺母)
# ═══════════════════════════════════════════════

@app.post("/api/responses/{response_id}/nuts")
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


@app.get("/api/responses/{response_id}/nuts")
def list_nuts(response_id: str, request: Request):
    user_id = _get_user_id(request)
    if not db.get_response(response_id, user_id=user_id):
        return JSONResponse({"error": "回答不存在"}, status_code=404)
    return JSONResponse(db.get_response_nuts(response_id, user_id=user_id))


@app.delete("/api/nuts/{nut_id}")
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

@app.get("/api/search")
def search(request: Request, q: str = Query("")):
    if not q:
        return JSONResponse([])
    user_id = _get_user_id(request)
    return JSONResponse(db.search_all(q, user_id=user_id))


# ═══════════════════════════════════════════════
# API: 模型配置
# ═══════════════════════════════════════════════

# ═══ API: 模型配置 (Model Configs) ═══

@app.get("/api/models")
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
        "thinking_budgets": thinking_budgets,
        "schema": MODEL_CONFIG_SCHEMA,
    })


@app.post("/api/models")
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


@app.delete("/api/models/{model_id}")
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
@app.delete("/api/models/")
def delete_model_empty():
    return JSONResponse({"status": "error", "message": "model_id cannot be empty"}, status_code=400)




@app.put("/api/models/{model_id}/thinking-budget")
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


@app.post("/api/models/discover")
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

@app.get("/api/token-usage")
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

    # 按 total_tokens 降序排列，已删除模型排在最后
    enriched.sort(key=lambda x: (x["deleted"], -x["total_tokens"]))

    totals = {
        "call_count": sum(r["call_count"] for r in enriched),
        "total_input": sum(r["total_input"] for r in enriched),
        "total_output": sum(r["total_output"] for r in enriched),
        "total_tokens": sum(r["total_tokens"] for r in enriched),
        "cumulative_usage": round(sum(r["cumulative_usage"] for r in enriched), 4),
    }

    return JSONResponse({"models": enriched, "totals": totals})


@app.post("/api/model-configs/{model_id}/recalculate-cost")
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

@app.get("/api/profile")
def get_profile(request: Request):
    user_id = _get_user_id(request)
    profile = db.get_user_profile(user_id=user_id)
    return JSONResponse({
        "content": profile.get("content", ""),
        "current_version_id": profile.get("current_version_id"),
        "updated_at": profile.get("updated_at"),
        "injection_enabled": _profile_enabled_default(user_id=user_id),
    })


@app.post("/api/profile")
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
    profile = db.save_user_profile(content, user_id=user_id, note=str(data.get("note") or "手动保存"))
    return JSONResponse({
        "status": "ok",
        "content": profile.get("content", ""),
        "current_version_id": profile.get("current_version_id"),
        "updated_at": profile.get("updated_at"),
        "injection_enabled": _profile_enabled_default(user_id=user_id),
    })


@app.get("/api/profile/history")
def get_profile_history(request: Request, limit: int = Query(50)):
    user_id = _get_user_id(request)
    return JSONResponse(db.list_user_profile_versions(user_id=user_id, limit=limit))


@app.post("/api/profile/history/{version_id}/restore")
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
    })

@app.get("/api/settings")
def get_settings(request: Request):
    user_id = _get_user_id(request)
    return JSONResponse(db.get_all_settings(user_id=user_id))


@app.post("/api/settings")
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
    db.batch_set_settings({k: str(v) for k, v in data.items()}, user_id=user_id)
    return JSONResponse({"status": "ok"})


@app.get("/api/settings/web-search-enabled")
def get_web_search_enabled(request: Request):
    """返回 web_search_enabled 开关状态"""
    user_id = _get_user_id(request)
    val = db.get_setting("web_search_enabled", "false", user_id=user_id)
    return JSONResponse({"enabled": val.lower() == "true"})


@app.put("/api/settings/web-search-enabled")
async def set_web_search_enabled(request: Request):
    """设置 web_search_enabled 开关状态"""
    user_id = _get_user_id(request)
    data = await request.json()
    db.set_setting("web_search_enabled", "true" if data.get("enabled") else "false", user_id=user_id)
    return JSONResponse({"status": "ok"})


@app.get("/api/settings/selected-model-ids")
def get_selected_model_ids(request: Request):
    """返回用户持久化的已选模型 ID 列表"""
    user_id = _get_user_id(request)
    ids = _get_selected_model_ids(user_id=user_id)
    return JSONResponse({"ids": ids})


@app.put("/api/settings/selected-model-ids")
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

@app.post("/api/price-sync")
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


@app.get("/api/price-sync/last")
def last_price_sync(request: Request):
    """返回上次定价同步的时间"""
    user_id = _get_user_id(request)
    last = db.get_setting("price_last_sync", "", user_id=user_id)
    return JSONResponse({"last_sync": last})


# ═══════════════════════════════════════════════
# API: Search Config
# ═══════════════════════════════════════════════

@app.get("/api/search-providers")
def get_search_providers(request: Request):
    """返回可用搜索服务提供商列表（含预设 URL / 定价信息）"""
    _get_user_id(request)
    return JSONResponse(SEARCH_PROVIDERS)


# ── SPA Catch-all (必须在最后) ──
# ═══ SPA Catch-all (必须在所有 API 之后) ═══

@app.get("/{path:path}")
async def spa_catchall(path: str):
    """SPA 路由 fallback: 优先尝试静态文件，否则返回 index.html"""
    static_file = DIST_DIR / path
    if static_file.exists() and static_file.is_file():
        return FileResponse(str(static_file))
    # SPA fallback
    index_html = DIST_DIR / "index.html"
    if index_html.exists():
        return FileResponse(str(index_html))
    return JSONResponse({"error": "Not found"}, status_code=404)


# ── 启动 ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
