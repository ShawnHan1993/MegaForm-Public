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
import io
import zipfile
import shutil
import httpx
from difflib import SequenceMatcher
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, unquote, urlparse

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
MINERU_ASSETS_DIR = BASE_DIR / "data" / "mineru_assets"
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
SUMMARY_AUTO_ENABLED_SETTING = "summary_auto_enabled"
PROFILE_UPDATE_MODEL_SETTING = "profile_update_model_id"
PROFILE_DAILY_LAST_RUN_SETTING = "profile_daily_last_run_date"
PROFILE_WEEKLY_LAST_RUN_SETTING = "profile_weekly_last_run_week"
MINERU_MODEL_ID = "mineru-pdf"
MINERU_MODEL_NAME = "MinerU PDF"
MARKDOWN_MODEL_ID = "markdown"
MARKDOWN_MODEL_NAME = "markdown"
MINERU_API_BASE = "https://mineru.net/api/v4"
MINERU_POLL_INTERVAL_SECONDS = 2.0
MINERU_POLL_TIMEOUT_SECONDS = 600
MINERU_HTTP_RETRY_ATTEMPTS = 3
MINERU_HTTP_RETRY_BASE_DELAY_SECONDS = 1.0
MINERU_INPUT_BYTES_PER_TOKEN = 4
MINERU_USAGE_CALLS_SETTING = "mineru_pdf_call_count"
MINERU_USAGE_INPUT_SETTING = "mineru_pdf_input_tokens"
MINERU_USAGE_OUTPUT_SETTING = "mineru_pdf_output_tokens"
NODE_SUMMARY_MIN_TOKENS = 30
ROOT_SUMMARY_DEBOUNCE_SECONDS = int(os.environ.get("MEGAFORM_ROOT_SUMMARY_DEBOUNCE_SECONDS", "3600"))
ROOT_SUMMARY_DAILY_HOUR = int(os.environ.get("MEGAFORM_ROOT_SUMMARY_DAILY_HOUR", "3"))
PROFILE_UPDATE_HOUR = int(os.environ.get("MEGAFORM_PROFILE_UPDATE_HOUR", "3"))
PROFILE_MAX_CHARS = 800
_root_summary_tasks: dict[str, asyncio.Task] = {}


def _get_summary_model_id(user_id: str = db.LOCAL_USER_ID) -> str:
    model_id = db.get_setting(SUMMARY_MODEL_SETTING, "", user_id=user_id).strip()
    return model_id if db.get_model_config(model_id, user_id=user_id) else ""


def _get_summary_auto_enabled(user_id: str = db.LOCAL_USER_ID) -> bool:
    settings = db.get_all_settings(user_id=user_id)
    if SUMMARY_AUTO_ENABLED_SETTING in settings:
        return settings[SUMMARY_AUTO_ENABLED_SETTING].lower() == "true"
    return bool(_get_summary_model_id(user_id=user_id))


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


def _get_profile_update_model_id(user_id: str = db.LOCAL_USER_ID) -> str:
    model_id = db.get_setting(PROFILE_UPDATE_MODEL_SETTING, "", user_id=user_id).strip()
    return model_id if _get_model_config_for_call(model_id, user_id=user_id) else ""


def _get_profile_update_model_config(user_id: str = db.LOCAL_USER_ID) -> dict | None:
    model_id = _get_profile_update_model_id(user_id=user_id)
    if not model_id:
        return None
    cfg = _get_model_config_for_call(model_id, user_id=user_id)
    if not cfg:
        return None
    if cfg.get("provider") != "ollama" and not cfg.get("api_key"):
        log.info("profile-update: 模型 %s 缺少 API Key，跳过", model_id)
        return None
    cfg = dict(cfg)
    cfg["max_tokens"] = min(int(cfg.get("max_tokens") or 4096), 900)
    return cfg


def _estimate_tokens(text: str) -> int:
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    words = len(re.findall(r"[A-Za-z0-9_]+", text))
    other = max(0, len(re.sub(r"[\s\u3400-\u9fffA-Za-z0-9_]", "", text)) // 2)
    return cjk + words + other


def _clean_summary(text: str) -> str:
    text = re.sub(r"^[\s\"'“”‘’`]+|[\s\"'“”‘’`。.!！?？]+$", "", text.strip())
    text = re.sub(r"^(摘要|总结|summary)\s*[:：]\s*", "", text, flags=re.IGNORECASE).strip()
    meta_probe = re.sub(r"^[\s>*_\-`#]+", "", text)
    meta_probe = re.sub(r"^(?:\*\s*)+", "", meta_probe).strip()
    meta_patterns = [
        r"^(draft|analysis|analyze the input|step\s*\d+|reasoning)\b",
        r"^(let me|we need to|i need to|the user asks)\b",
    ]
    if any(re.search(pattern, meta_probe, flags=re.IGNORECASE) for pattern in meta_patterns):
        return ""
    text = re.sub(r"\s+", " ", text)
    return text


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
    language = _get_user_language(user_id)
    system_prompt = (
        "You are a title generator. Return only the final short readable title. "
        "Never output analysis, drafts, steps, labels, markdown, or explanations."
        if language == "en"
        else "你是标题生成器。只输出最终的简短可读标题。禁止输出分析过程、草稿、步骤、标签、Markdown 或解释。"
    )
    full_content = ""
    async for chunk in chat_completion_stream(
        cfg,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        thinking_budget=0,
        search_config=None,
        language=language,
    ):
        log.info("summary chunk: %s %.80r", chunk.get("type"), chunk.get("content", ""))
        pass
        if chunk["type"] == "content":
            full_content += chunk["content"]
    return _clean_summary(full_content)


async def _call_profile_update_model(prompt: str, user_id: str = db.LOCAL_USER_ID) -> str:
    cfg = _get_profile_update_model_config(user_id=user_id)
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
        if chunk["type"] == "content":
            full_content += chunk["content"]
    return full_content.strip()


PROFILE_SECTION_NAMES = [
    "Background",
    "Research Preferences",
    "Communication Preferences",
    "Language Preferences",
    "Timezone",
    "Other Notes",
]


def _extract_profile_section(profile: str, heading: str) -> str:
    match = re.search(rf"(?ms)^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s+|\Z)", profile or "")
    return match.group(1).strip() if match else ""


def _strip_profile_heading(text: str, heading: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json|markdown)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(rf"(?is)^##\s+{re.escape(heading)}\s*", "", text).strip()
    return text


def _replace_profile_sections(profile: str, replacements: dict[str, str]) -> str:
    profile = (profile or db.DEFAULT_PROFILE_MD).strip()
    if not profile.startswith("# User Profile"):
        profile = "# User Profile\n\n" + profile
    for heading, body in replacements.items():
        body = _strip_profile_heading(body, heading)
        block = f"## {heading}\n\n{body}".rstrip()
        pattern = rf"(?ms)^##\s+{re.escape(heading)}\s*\n.*?(?=^##\s+|\Z)"
        if re.search(pattern, profile):
            profile = re.sub(pattern, block + "\n\n", profile).strip()
        else:
            profile = (profile.rstrip() + "\n\n" + block).strip()
    return re.sub(r"\n{3,}", "\n\n", profile).strip() + "\n"


def _compact_profile_locally(profile: str, preferred_sections: tuple[str, ...]) -> str:
    profile = re.sub(r"[ \t]+", " ", (profile or db.DEFAULT_PROFILE_MD).strip())
    profile = re.sub(r"\n{3,}", "\n\n", profile)
    if len(profile) <= PROFILE_MAX_CHARS:
        return profile + "\n"

    sections = {name: _extract_profile_section(profile, name) for name in PROFILE_SECTION_NAMES}
    over = len(profile) - PROFILE_MAX_CHARS
    shrink_order = list(preferred_sections) + [name for name in PROFILE_SECTION_NAMES if name not in preferred_sections]
    for name in shrink_order:
        body = sections.get(name, "")
        if not body:
            continue
        target = max(0, len(body) - over - 8)
        if target < len(body):
            sections[name] = body[:target].rstrip(" ,，;；.。") + ("…" if target > 0 else "")
            profile = _replace_profile_sections(profile, {name: sections[name]})
            if len(profile) <= PROFILE_MAX_CHARS:
                return profile
            over = len(profile) - PROFILE_MAX_CHARS
    return profile[:PROFILE_MAX_CHARS - 2].rstrip() + "\n"


def _extract_json_object(text: str) -> dict:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _utc_range_for_local_day(day: datetime) -> tuple[str, str]:
    start_local = day.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        end_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _utc_range_for_previous_local_week(now: datetime) -> tuple[str, str]:
    this_monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    last_monday = this_monday - timedelta(days=7)
    return (
        last_monday.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        this_monday.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _format_profile_node_lines(nodes: list[dict], max_lines: int = 160) -> str:
    lines = []
    for node in nodes[:max_lines]:
        content = re.sub(r"\s+", " ", node.get("content") or "").strip()
        summary = re.sub(r"\s+", " ", node.get("summary") or "").strip()
        if not content:
            continue
        if len(content) > 360:
            content = content[:360].rstrip() + "..."
        if summary:
            lines.append(f"- {node.get('created_at', '')}: {content} [summary: {summary[:120]}]")
        else:
            lines.append(f"- {node.get('created_at', '')}: {content}")
    return "\n".join(lines)[:40_000]


def _profile_language_instruction(language: str) -> str:
    return "Write the profile content in English." if language == "en" else "Profile 内容请使用简体中文。"


async def _update_profile_weekly(user_id: str, nodes: list[dict]) -> bool:
    if not nodes:
        return False
    profile = db.get_user_profile(user_id=user_id).get("content", db.DEFAULT_PROFILE_MD)
    language = _get_user_language(user_id)
    prompt = (
        "You update a compact Markdown user profile for MegaForm.\n"
        "Task: infer the user's capability boundaries and interests from the previous week's newly created nodes and the full current profile. "
        "Update ONLY the Background and Research Preferences sections. Focus on the user's inner world: what they likely know or do not know, familiar/unfamiliar domains, research interests, and chat habits. "
        "Keep it concise; do not invent concrete physical-world facts such as family, property, possessions, or job titles. "
        f"{_profile_language_instruction(language)}\n"
        "Return strict JSON only: {\"background\":\"...\",\"research_preferences\":\"...\"}. "
        "Each value should be short Markdown text without headings; together they should leave the full profile under 800 characters.\n\n"
        f"Current full profile:\n{profile}\n\n"
        f"Previous-week nodes:\n{_format_profile_node_lines(nodes)}"
    )
    raw = await _call_profile_update_model(prompt, user_id=user_id)
    data = _extract_json_object(raw)
    background = str(data.get("background") or "").strip()
    research_preferences = str(data.get("research_preferences") or "").strip()
    if not background and not research_preferences:
        return False
    updated = _replace_profile_sections(profile, {
        "Background": background or _extract_profile_section(profile, "Background"),
        "Research Preferences": research_preferences or _extract_profile_section(profile, "Research Preferences"),
    })
    updated = _compact_profile_locally(updated, ("Background", "Research Preferences"))
    if updated.strip() == (profile or "").strip():
        return False
    db.save_user_profile(updated, user_id=user_id, note="自动更新：每周能力与兴趣")
    log.info("profile-update: user=%s weekly updated from %d nodes", user_id, len(nodes))
    return True


async def _update_profile_daily(user_id: str, nodes: list[dict]) -> bool:
    if not nodes:
        return False
    profile = db.get_user_profile(user_id=user_id).get("content", db.DEFAULT_PROFILE_MD)
    language = _get_user_language(user_id)
    current_other_notes = _extract_profile_section(profile, "Other Notes")
    prompt = (
        "You update ONLY the Other Notes section of a compact Markdown user profile for MegaForm.\n"
        "Use only the current Other Notes section and yesterday's newly created nodes. "
        "Do NOT use or infer from Background or Research Preferences. "
        "Focus only on physical-world/material attributes: possessions, personal property, family members, household context, job/workplace facts, location/timezone facts, recurring obligations. "
        "Remove stale or unsupported notes when yesterday's nodes clearly contradict them. Keep it concise and avoid speculation. "
        f"{_profile_language_instruction(language)}\n"
        "Return strict JSON only: {\"other_notes\":\"...\"}. The value should be short Markdown text without a heading; keep the full profile under 800 characters.\n\n"
        f"Current Other Notes:\n{current_other_notes or '(empty)'}\n\n"
        f"Yesterday's nodes:\n{_format_profile_node_lines(nodes)}"
    )
    raw = await _call_profile_update_model(prompt, user_id=user_id)
    data = _extract_json_object(raw)
    other_notes = str(data.get("other_notes") or "").strip()
    if not other_notes:
        return False
    updated = _replace_profile_sections(profile, {"Other Notes": other_notes})
    updated = _compact_profile_locally(updated, ("Other Notes",))
    if updated.strip() == (profile or "").strip():
        return False
    db.save_user_profile(updated, user_id=user_id, note="自动更新：每日现实信息")
    log.info("profile-update: user=%s daily updated from %d nodes", user_id, len(nodes))
    return True


def _mark_root_summary_dirty_if_shallow_node(node_id: str, user_id: str = db.LOCAL_USER_ID):
    node = db.get_node(node_id, user_id=user_id)
    if not node:
        return
    if node["id"] == node["root_id"]:
        _mark_root_summary_dirty(node["root_id"], user_id=user_id)


async def _generate_root_summary(root_id: str, user_id: str = db.LOCAL_USER_ID):
    if not _get_summary_auto_enabled(user_id=user_id):
        return
    root = db.get_root(root_id, user_id=user_id)
    if not root:
        return
    content = re.sub(r"\s+", " ", root.get("content") or "").strip()
    if not content:
        return
    if _get_user_language(user_id) == "en":
        prompt = (
            "Summarize the core topic of the following user question in English. "
            "Use only this question text. Ignore child nodes, answers, and any other context. "
            "Requirements: within 25 tokens; output a complete phrase; no quotes; no final period; output only the summary:\n\n"
            f"{content[:2000]}"
        )
    else:
        prompt = (
            "请用中文概括以下用户问题的核心内容。只根据这段问题原文生成，"
            "不要参考子节点、回答或任何其他上下文。要求：25个token以内；语义完整；"
            "不要加引号、不要加句号；直接输出摘要：\n\n"
            f"{content[:2000]}"
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
    if not _get_summary_auto_enabled(user_id=user_id):
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
        if _get_summary_auto_enabled(user_id=r["user_id"])
        and _get_summary_model_id(user_id=r["user_id"])
    ]
    log.info("summary-daily: 扫描 %d 个 root，其中 %d 个启用自动摘要", len(roots), len(eligible))
    for root in eligible:
        await _generate_root_summary(root["id"], user_id=root["user_id"])
        await asyncio.sleep(0)


def _seconds_until_next_profile_update_run() -> float:
    now = datetime.now()
    target = now.replace(
        hour=PROFILE_UPDATE_HOUR,
        minute=0,
        second=0,
        microsecond=0,
    )
    if target <= now:
        target += timedelta(days=1)
    return max(1.0, (target - now).total_seconds())


async def _run_profile_update_scan():
    now = datetime.now().astimezone()
    yesterday = now - timedelta(days=1)
    daily_key = yesterday.strftime("%Y-%m-%d")
    daily_start, daily_end = _utc_range_for_local_day(yesterday)

    weekly_key = ""
    weekly_start = weekly_end = ""
    if now.weekday() == 0:
        this_monday = (now - timedelta(days=now.weekday())).date()
        weekly_key = this_monday.isoformat()
        weekly_start, weekly_end = _utc_range_for_previous_local_week(now)

    users = [u for u in db.list_users() if _get_profile_update_model_id(user_id=u["id"])]
    log.info("profile-update: 扫描 %d 个启用自动更新的用户", len(users))
    for user in users:
        user_id = user["id"]
        try:
            if weekly_key and db.get_setting(PROFILE_WEEKLY_LAST_RUN_SETTING, "", user_id=user_id) != weekly_key:
                nodes = db.get_nodes_created_between(user_id, weekly_start, weekly_end, limit=300)
                await _update_profile_weekly(user_id, nodes)
                db.set_setting(PROFILE_WEEKLY_LAST_RUN_SETTING, weekly_key, user_id=user_id)

            if db.get_setting(PROFILE_DAILY_LAST_RUN_SETTING, "", user_id=user_id) != daily_key:
                nodes = db.get_nodes_created_between(user_id, daily_start, daily_end, limit=200)
                await _update_profile_daily(user_id, nodes)
                db.set_setting(PROFILE_DAILY_LAST_RUN_SETTING, daily_key, user_id=user_id)
        except Exception as e:
            log.warning("profile-update: user=%s 更新失败: %s", user_id, e, exc_info=True)
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

    # ── 后台守护：每天凌晨定时用用户选择的模型更新 Profile ──
    async def _profile_update_loop():
        while True:
            delay = _seconds_until_next_profile_update_run()
            log.info("profile-update: 下次扫描将在 %.0f 秒后执行", delay)
            await asyncio.sleep(delay)
            try:
                await _run_profile_update_scan()
            except Exception as e:
                log.warning("profile-update: 全量扫描异常: %s", e, exc_info=True)
    profile_update_task = asyncio.create_task(_profile_update_loop())

    yield
    cleanup_task.cancel()
    daily_root_summary_task.cancel()
    profile_update_task.cancel()
    for task in list(_root_summary_tasks.values()):
        task.cancel()
    await asyncio.gather(cleanup_task, daily_root_summary_task, profile_update_task, *_root_summary_tasks.values(), return_exceptions=True)
    _root_summary_tasks.clear()
