"""
MegaForm — 模型配置 & 流式调用模块
支持 OpenAI 兼容 API、Ollama、Anthropic、Gemini
支持流式 SSE 输出 (chat_completion_stream)
支持深度思考 (thinking/reasoning) 功能，自动检测不同 API 的思考参数格式
"""
import json
import logging
import httpx
import os
from typing import Optional, AsyncGenerator
from web_search import search_web, see_web, format_search_context
from utility import merge_delta_into_existing
import asyncio

log = logging.getLogger("megaform.models")


MAX_URLS = 5


def _web_search_tools(language: str = "zh-CN") -> list[dict]:
    if language == "en":
        search_description = (
            "Search the web for real-time information. Use this tool when you need "
            "latest news, factual information, or when you are uncertain. It returns "
            "search result summaries and URLs."
        )
        query_description = "Search query or question"
        see_description = (
            "Fetch detailed content from specified web pages. Use this when search "
            "snippets are not detailed enough and you need the full page content. "
            f"Read at most {MAX_URLS} URLs each time."
        )
        urls_description = f"List of web page URLs to read, at most {MAX_URLS}"
    else:
        search_description = (
            "搜索互联网获取实时信息。当需要查找最新新闻、事实信息、"
            "或不确定答案时调用此工具。返回搜索结果摘要和URL。"
        )
        query_description = "搜索关键词或问题"
        see_description = (
            "获取指定网页的详细内容。当搜索结果中的摘要不够详细，"
            f"需要查看完整页面内容时调用此工具。每次最多读取{MAX_URLS}个URL。"
        )
        urls_description = f"需要读取的网页URL列表（最多{MAX_URLS}个）"
    return [
        {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": search_description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": query_description,
                        }
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "see_web",
                "description": see_description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "urls": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": urls_description,
                            "maxItems": MAX_URLS,
                        }
                    },
                    "required": ["urls"],
                },
            },
        },
    ]

# 最大工具调用轮次（防止死循环）
MAX_TOOL_ROUNDS = 7
OPENAI_STREAM_MAX_RETRIES = 2
OPENAI_STREAM_RETRY_BASE_DELAY = 0.5
OPENAI_STREAM_RETRYABLE_ERRORS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
)
OPENAI_STREAM_TIMEOUT = httpx.Timeout(300.0, connect=30.0)


def _normalize_base_url(base_url: str) -> str:
    return (base_url or "").rstrip("/").lower()


def _is_google_gemini_base_url(base_url: str) -> bool:
    return "generativelanguage.googleapis.com" in _normalize_base_url(base_url)


def _is_official_openai_base_url(base_url: str) -> bool:
    return "api.openai.com" in _normalize_base_url(base_url)


def _is_openrouter_base_url(base_url: str) -> bool:
    return "openrouter.ai" in _normalize_base_url(base_url)


def _is_openrouter_anthropic_model(provider: str, base_url: str, model_name: str) -> bool:
    return (
        (provider == "openrouter" or _is_openrouter_base_url(base_url))
        and model_name.lower().startswith("anthropic/")
    )


def _anthropic_messages_url(base_url: str) -> str:
    normalized = (base_url or "").rstrip("/")
    if not normalized:
        return "https://api.anthropic.com/v1/messages"
    lower = normalized.lower()
    if lower.endswith("/messages"):
        return normalized
    if _is_openrouter_base_url(normalized) and lower.endswith("/api"):
        return f"{normalized}/v1/messages"
    if lower.endswith("/v1"):
        return f"{normalized}/messages"
    return f"{normalized}/v1/messages"


def _is_deepseek_v4_model(model_name: str) -> bool:
    name = model_name.lower().removeprefix("deepseek/")
    return name.startswith("deepseek-v4")


def _proxy_env_state() -> str:
    return " ".join(
        f"{key}={'set' if os.environ.get(key) else 'unset'}"
        for key in (
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
            "http_proxy", "https_proxy", "all_proxy",
        )
    )


def _log_openai_stream_transient_error(
    exc: Exception, *, url: str, provider: str, model_name: str,
    attempt: int, max_retries: int, will_retry: bool,
) -> None:
    log.warning(
        "stream-openai: transient network error endpoint=%s provider=%s model=%s "
        "attempt=%d/%d retry=%s proxy_env=%s error=%s: %s",
        url, provider, model_name, attempt + 1, max_retries + 1, will_retry,
        _proxy_env_state(), type(exc).__name__, exc,
    )


def _format_openai_stream_connect_error(exc: Exception, *, provider: str, url: str) -> str:
    message = str(exc)
    if provider == "deepseek" and "TLS/SSL connection has been closed" in message:
        return (
            "DeepSeek 连接在 TLS 握手阶段被关闭。请求尚未进入模型推理，通常是网络线路、"
            "代理/VPN、DNS 或 DeepSeek API 入口临时异常；请检查代理环境或稍后重试。"
            f"endpoint={url} proxy_env={_proxy_env_state()} original={message}"
        )
    return message


def _is_openai_reasoning_model(model_name: str) -> bool:
    name = model_name.lower().removeprefix("openai/")
    return name.startswith(("o1", "o3", "o4"))


def _get_native_search_config(provider: str, model_name: str) -> dict | None:
    """检测供应商是否支持原生搜索能力，返回对应的 payload 增强配置。

    Returns:
        {"type": "tool", "tool": {...}}   — 注入到 tools 数组的 tool 定义
        {"type": "payload_key", "key": "...", "value": {...}} — 注入到 payload 根键
        None — 不支持原生搜索，走自定义 tool-calling 循环
    """
    # Anthropic 原生 web_search（server-side tool，Claude 自行执行搜索）
    if provider == "anthropic":
        return {"type": "tool", "tool": {"type": "web_search_20260209", "name": "web_search"}}

    # OpenAI 专用 search-preview 模型（Chat Completions API 原生搜索）
    if "-search-" in model_name.lower():
        return {"type": "payload_key", "key": "web_search_options", "value": {}}

    # xAI Grok — Chat Completions 已弃用 web_search，走 tool-calling
    # DeepSeek / Groq / Ollama / OpenRouter — 无原生搜索
    return None


def _extract_grounding_metadata(response_json: dict) -> dict | None:
    """从 Gemini 响应中提取 Google Search grounding 元数据。

    Gemini 原生 API / OpenAI 兼容端点均可能返回 groundingMetadata：
    - webSearchQueries: 实际执行的搜索查询列表
    - groundingChunks: 引用的网页来源 [{web: {uri, title}}]
    - groundingSupports: 回答文本片段与来源的对应关系

    尝试多种嵌套格式以兼容不同 API 层封装。返回 None 表示无 grounding 数据。
    参考: https://ai.google.dev/gemini-api/docs/google-search#understanding_the_grounding_metadata
    """
    # 顶层字段
    for key in ("groundingMetadata", "grounding_metadata"):
        gm = response_json.get(key)
        if isinstance(gm, dict) and gm:
            return gm

    # Gemini 原生格式: candidates[0].groundingMetadata
    candidates = response_json.get("candidates") or []
    if candidates and isinstance(candidates[0], dict):
        for key in ("groundingMetadata", "grounding_metadata"):
            gm = candidates[0].get(key)
            if isinstance(gm, dict) and gm:
                return gm

    # OpenAI 兼容端点可能将 grounding 放入 extra_content
    choices = response_json.get("choices") or []
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or choices[0].get("delta") or {}
        extra = msg.get("extra_content") or {}
        for key in ("groundingMetadata", "grounding_metadata", "google"):
            gm = extra.get(key)
            if isinstance(gm, dict) and gm and "groundingChunks" in gm:
                return gm

    return None


def _format_grounding_sources(grounding: dict) -> list[dict]:
    """将 groundingMetadata 格式化为前端可用的 sources 列表。

    返回 [{"title": str, "url": str, "snippet": str}, ...]
    参考: https://ai.google.dev/gemini-api/docs/google-search#attributing_sources_with_inline_citations
    """
    chunks = grounding.get("groundingChunks") or []
    sources = []
    for c in chunks:
        if not isinstance(c, dict):
            continue
        web = c.get("web") or {}
        url = web.get("uri", "")
        title = web.get("title", "")
        if url:
            sources.append({
                "title": title or url,
                "url": url,
                "snippet": "",
            })
    return sources


# ── 模型配置 JSON Schema ─────────────────────────────────────────────────
# 用于前端动态表单渲染，定义模型配置所需的所有字段
MODEL_CONFIG_SCHEMA = {
    "fields": [
        {"key": "id", "label": "模型标识", "type": "text", "placeholder": "如 deepseek-chat", "required": True},
        {"key": "name", "label": "显示名称", "type": "text", "placeholder": "如 DeepSeek Chat", "required": True},
        {"key": "provider", "label": "提供商", "type": "select",
         "options": ["openai", "deepseek", "ollama", "anthropic", "custom"],
         "required": True},
        {"key": "base_url", "label": "API 地址", "type": "text", "placeholder": "https://api.deepseek.com/v1"},
        {"key": "api_key", "label": "API Key", "type": "password", "placeholder": "sk-..."},
        {"key": "model_name", "label": "模型名", "type": "text", "placeholder": "deepseek-chat", "required": True},
        {"key": "max_tokens", "label": "最大输出 Token", "type": "number", "default": 4096},
        {"key": "price_per_input", "label": "输入单价 (元/1K tokens)", "type": "number", "default": 0},
        {"key": "price_per_output", "label": "输出单价 (元/1K tokens)", "type": "number", "default": 0},
    ]
}


async def chat_completion_stream(
    model_cfg: dict, messages: list[dict], thinking_budget: int = 0,
    search_config: Optional[dict] = None,
    language: str = "zh-CN",
) -> AsyncGenerator[dict, None]:
    """
    流式调用模型 API，通过 AsyncGenerator yield 事件字典。

    与 chat_completion 不同，此函数不等待完整响应，而是逐步产出 SSE 兼容的事件。
    调用方（通常是 main.py 的 SSE endpoint）将这些事件转发给前端实现打字机效果。

    如果提供了 search_config（联网搜索已启用），会先运行 tool-calling 循环：
      1. 模型决定是否调用 search_web → 后端执行搜索 → 结果返回模型
      2. 模型决定是否调用 see_web → 后端抓取网页 → 结果返回模型
      3. 模型生成最终回复（流式输出）
    工具调用过程以 thinking 事件发送到前端。

    事件类型:
      {"type": "thinking", "content": "chunk"}  — 思考过程 / 工具调用过程
      {"type": "content", "content": "chunk"}   — 正式回复内容片段
      {"type": "usage", "usage": {...}}         — Token 用量信息

    参数:
        model_cfg: 模型配置字典
        messages: 对话消息列表
        thinking_budget: 思考 token 预算，0 表示不启用
        search_config: 联网搜索配置 {"provider": "...", "api_key": "...", "base_url": "..."}
    """
    provider = model_cfg.get("provider", "openai")
    base_url = model_cfg.get("base_url", "").rstrip("/")
    api_key = model_cfg.get("api_key", "")
    model_name = model_cfg.get("model_name", "")
    max_tokens = model_cfg.get("max_tokens", 4096)

    if provider == "anthropic" or _is_openrouter_anthropic_model(provider, base_url, model_name):
        async for event in _stream_anthropic(
            base_url, api_key, model_name, messages, max_tokens, thinking_budget,
            search_config=search_config):
            yield event
    elif _is_google_gemini_base_url(base_url) and "gemini" in model_name.lower():
        # 只有直连 Google Gemini 时才走原生 API；OpenRouter 等代理仍走 OpenAI-compatible。
        if search_config:
            content = "🔍 Gemini native web search enabled (Google Search Grounding)\n" if language == "en" else "🔍 已启用 Gemini 原生联网搜索 (Google Search Grounding)\n"
            yield {"type": "thinking", "content": content}
        async for event in _stream_gemini_native(
            api_key, model_name, messages, max_tokens,
            thinking_budget=thinking_budget, search_config=search_config,
        ):
            yield event
    else:
        async for event in _stream_openai_compatible(
            base_url, api_key, model_name, messages, max_tokens, provider, thinking_budget,
            search_config=search_config, language=language,
        ):
            yield event


def _build_openai_payload(model_name: str, messages: list[dict], max_tokens: int,
                          provider: str, thinking_budget: int = 0,
                          stream: bool = True, base_url: str = "") -> dict:
    """构建 OpenAI 兼容 API 的请求 payload。

    处理不同提供商/模型的 thinking 参数：
    - DeepSeek V4: extra_body.thinking + reasoning_effort "high"/"max"
    - OpenAI o3/o4: reasoning_effort "low"/"medium"/"high"
    - Gemini 3.x: thinkingLevel, Gemini 2.x: thinkingBudget
    - 其他: extra_body + max_tokens 扩展
    """
    payload = {
        "model": model_name,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": stream,
    }

    is_official_openai_reasoning = (
        provider == "openai"
        and _is_official_openai_base_url(base_url)
        and _is_openai_reasoning_model(model_name)
    )
    if is_official_openai_reasoning:
        payload.pop("max_tokens", None)
        payload["max_completion_tokens"] = max_tokens

    # 深度思考参数注入
    if thinking_budget > 0:
        if provider == "deepseek":
            if _is_deepseek_v4_model(model_name):
                payload["extra_body"] = {"thinking": {"type": "enabled"}}
            # DeepSeek V4: reasoning_effort 只有 "high"/"max" 两档。
            if thinking_budget <= 32768:
                payload["reasoning_effort"] = "high"
            else:
                payload["reasoning_effort"] = "max"
            payload["max_tokens"] = max_tokens + thinking_budget
        elif is_official_openai_reasoning:
            # OpenAI o3/o4: reasoning_effort，不需要 extra_body
            if thinking_budget <= 2048:
                payload["reasoning_effort"] = "low"
            elif thinking_budget <= 16384:
                payload["reasoning_effort"] = "medium"
            else:
                payload["reasoning_effort"] = "high"
        elif model_name.startswith("gemini-3") or model_name.startswith("gemini-3."):
            # Gemini 3.x: thinkingLevel (MINIMAL/LOW/MEDIUM/HIGH)，不发送 extra_body
            if thinking_budget <= 1024:
                payload["thinkingConfig"] = {"thinkingLevel": "MINIMAL"}
            elif thinking_budget <= 4096:
                payload["thinkingConfig"] = {"thinkingLevel": "LOW"}
            elif thinking_budget <= 16384:
                payload["thinkingConfig"] = {"thinkingLevel": "MEDIUM"}
            else:
                payload["thinkingConfig"] = {"thinkingLevel": "HIGH"}
        elif "gemini" in model_name:
            # Gemini 2.x: thinkingBudget 整数，不发送 extra_body（会导致 400）
            # Gemini 2.5 Pro 最少需要 128 thinkingBudget
            tb = thinking_budget
            if thinking_budget > 0 and "pro" in model_name.lower():
                tb = max(thinking_budget, 128)
            payload["thinkingConfig"] = {"thinkingBudget": tb}
        else:
            # 其他 provider: extra_body 方式
            payload["extra_body"] = {"thinking": {"type": "enabled"}}
            payload["max_tokens"] = max_tokens + thinking_budget
    else:
        # 不启用思考 —— 不发送禁用心智（大部分 provider 不支持，会 400）
        # 仅在 provider 明确需要显式禁用时才发送
        if provider == "deepseek" and _is_deepseek_v4_model(model_name):
            payload["extra_body"] = {"thinking": {"type": "disabled"}}
    return payload


async def _stream_openai_compatible(
    base_url: str, api_key: str, model_name: str,
    messages: list[dict], max_tokens: int, provider: str,
    thinking_budget: int = 0,
    search_config: Optional[dict] = None,
    language: str = "zh-CN",
) -> AsyncGenerator[dict, None]:
    """OpenAI 兼容 API 流式调用（含联网搜索）。

    如果提供了 search_config：
      - 有原生搜索能力（Gemini google_search / OpenAI search-preview）→ 注入原生 tool，跳过 tool-calling
      - 无原生搜索 → 运行自定义 tool-calling 循环（search_web + see_web）
    工具调用过程以 thinking 事件发送到前端。
    """
    native_search = _get_native_search_config(provider, model_name) if search_config else None
    # ── 正常流式输出 ──
    headers = {
        "Content-Type": "application/json",
        # OpenRouter 要求：所有 Anthropic 模型请求必须带这两个头，否则 403
        "HTTP-Referer": "https://megaform.local",
        "X-Title": "MegaForm",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = _build_openai_payload(
        model_name, messages, max_tokens, provider, thinking_budget,
        stream=True, base_url=base_url,
    )

    # ── 注入原生搜索配置 ──
    if native_search:
        content = "🔍 Native web search enabled\n" if language == "en" else "🔍 已启用原生联网搜索\n"
        yield {"type": "thinking", "content": content}
        if native_search["type"] == "tool":
            payload.setdefault("tools", []).append(native_search["tool"])
        elif native_search["type"] == "payload_key":
            payload[native_search["key"]] = native_search["value"]

    url = f"{base_url}/chat/completions"
    log.info("stream-openai: %s/%s url=%s, max_tokens=%d thinking=%d", provider, model_name, url, max_tokens, thinking_budget)
    if search_config and not native_search:
        chatting_turns = MAX_TOOL_ROUNDS
        payload["tools"] = _web_search_tools(language)
    else:
        chatting_turns = 1
    early_stop_for_chatting_turns = False
    if "test_model" in model_name:
        try:
            times = int(payload["messages"][-1]["content"].strip())
        except:
            times = 28
        yield {"type": "thinking", "content": f"Total {times} blocks from test model\n\n"}
        for i in range(times):
            content_block = f"this is context_block {i} from test model\n\n"
            if i < 10:
                yield {"type": "thinking", "content": content_block}
            else:
                yield {"type": "content", "content": content_block}
            await asyncio.sleep(1)
        return
    for chatting_turn in range(chatting_turns):
        current_msg = {}
        emitted_stream_event = False
        for attempt in range(OPENAI_STREAM_MAX_RETRIES + 1):
            current_msg = {}
            try:
                async with httpx.AsyncClient(timeout=OPENAI_STREAM_TIMEOUT) as client:
                    async with client.stream("POST", url, headers=headers, json=payload) as resp:
                        if chatting_turn == chatting_turns - 1:
                            payload.pop("tools", None)  # 最后一个轮次不再提供工具，避免模型重复调用:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            # SSE 格式：每行以 "data: " 开头（跳过空行和注释行）
                            if not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            # "[DONE]" 标记流结束
                            if data_str == "[DONE]":
                                tools_callings = current_msg.get("tool_calls", [])
                                if len(tools_callings) > 0:
                                    payload["messages"].append(current_msg)
                                else:
                                    # LLM stops outputting while doesn't call any tool,
                                    # we consider it as the end of the chatting turn
                                    # and break the outer loop to avoid infinite waiting
                                    early_stop_for_chatting_turns = True
                                for tools_calling in tools_callings:
                                    # tools_calling is like---
                                    # {
                                    #     'index': 0,
                                    #     'id': 'call_00_R3dykS7w1Q4xCbgHRzMk3698',
                                    #     'type': 'function',
                                    #     'function': {
                                    #         'name': 'search_web',
                                    #         'arguments': '{"query": "伊朗局势 最新 2026年5月"}'
                                    #     }
                                    # }
                                    tools_calling_arg = json.loads(tools_calling.get("function", {}).get("arguments", ""))
                                    tools_calling_func = tools_calling.get("function", {}).get("name", "")
                                    if tools_calling_func == "search_web":
                                        query = tools_calling_arg.get("query", "")
                                        emitted_stream_event = True
                                        label = "Searching" if language == "en" else "正在搜索"
                                        yield {"type": "thinking", "content": f"\n\n🔍 {label}: {query}......\n"}
                                        try:
                                            sp = search_config.get("provider", "tavily")
                                            sk = search_config.get("api_key", "")
                                            su = search_config.get("base_url", "")
                                            results = await search_web(query, provider=sp, api_key=sk, base_url=su)
                                            tools_calling_res = format_search_context(results, query, language=language)
                                            done = f"Search complete: {len(results)} results" if language == "en" else f"搜索完成: {len(results)} 条结果"
                                            yield {"type": "thinking", "content": f"✅ {done}\n\n"}
                                        except Exception as e:
                                            label = "Search failed" if language == "en" else "搜索失败"
                                            tools_calling_res = f"{label}: {e}"
                                            yield {"type": "thinking", "content": f"❌ {label}: {e}\n\n"}
                                    elif tools_calling_func == "see_web":
                                        urls = tools_calling_arg.get("urls", [])[:MAX_URLS]
                                        emitted_stream_event = True
                                        label = "Reading" if language == "en" else "正在读取"
                                        yield {"type": "thinking", "content": f"\n\n📄 {label}: {', '.join(urls)}......\n"}
                                        try:
                                            tools_calling_res = await see_web(urls, language=language)
                                            done = "Read complete" if language == "en" else "读取完成"
                                            yield {"type": "thinking", "content": f"✅ {done}\n\n"}
                                        except Exception as e:
                                            label = "Read failed" if language == "en" else "读取失败"
                                            tools_calling_res = f"{label}: {e}"
                                            yield {"type": "thinking", "content": f"❌ {label}: {e}\n\n"}
                                    else:
                                        emitted_stream_event = True
                                        message = f"LLM called unknown tool {tools_calling_func}" if language == "en" else f"LLM 调用了未知工具 {tools_calling_func}"
                                        yield {"type": "thinking", "content": f"\n\n❌ {message}\n\n"}
                                        tools_calling_res = "This tool does not exist" if language == "en" else "此工具不存在"
                                    payload["messages"].append(
                                        {
                                            "role": "tool",
                                            "tool_call_id": tools_calling["id"],
                                            "content": tools_calling_res,
                                        }
                                    )
                                break
                            try:
                                chunk = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue

                            # Token 用量（部分提供商在最后一个 chunk 中返回）
                            if chunk.get("usage"):
                                emitted_stream_event = True
                                yield {"type": "usage", "usage": chunk["usage"]}

                            # 从 chunk 中提取 delta（增量内容）
                            choices_in_chunk = chunk.get("choices", [{}])
                            if len(choices_in_chunk) == 0:
                                delta = {}
                            else:
                                delta = chunk.get("choices", [{}])[0].get("delta", {})

                            # DeepSeek R1 特有的 reasoning_content（思考过程)
                            merge_delta_into_existing(current_msg, delta)
                            if delta.get("reasoning_content"):
                                emitted_stream_event = True
                                yield {"type": "thinking", "content": delta["reasoning_content"]}

                            # 常规回复内容
                            if delta.get("content"):
                                emitted_stream_event = True
                                yield {"type": "content", "content": delta["content"]}
                break
            except OPENAI_STREAM_RETRYABLE_ERRORS as e:
                will_retry = attempt < OPENAI_STREAM_MAX_RETRIES and not emitted_stream_event
                _log_openai_stream_transient_error(
                    e, url=url, provider=provider, model_name=model_name,
                    attempt=attempt, max_retries=OPENAI_STREAM_MAX_RETRIES,
                    will_retry=will_retry,
                )
                if not will_retry:
                    raise RuntimeError(
                        _format_openai_stream_connect_error(e, provider=provider, url=url)
                    ) from e
                await asyncio.sleep(OPENAI_STREAM_RETRY_BASE_DELAY * (2 ** attempt))

        # Some OpenAI-compatible providers close the SSE stream without sending
        # the final "data: [DONE]" sentinel. If no tool call was assembled, the
        # model has already produced its final answer, so stop instead of
        # replaying the same request for every remaining tool round.
        if not current_msg.get("tool_calls"):
            early_stop_for_chatting_turns = True

        if early_stop_for_chatting_turns:
            break


# ── Gemini 原生 API 流式调用 ──

def _convert_messages_to_gemini_contents(messages: list[dict]) -> list[dict]:
    """将 OpenAI 格式 messages 转换为 Gemini 原生 API contents 格式。

    OpenAI: {"role": "user"|"assistant"|"system", "content": "..."}
    Gemini:  {"role": "user"|"model", "parts": [{"text": "..."}]}

    系统消息 (role=system) 暂不转换 —— native API 通过 systemInstruction 字段注入。
    """
    contents = []
    for msg in messages:
        role = msg.get("role", "user")
        if role == "system":
            continue  # 系统消息单独处理
        if role == "assistant":
            role = "model"
        content = msg.get("content", "")
        parts = []
        # 支持纯文本和 content 数组（多模态）
        if isinstance(content, list):
            for item in content:
                if item.get("type") == "text":
                    parts.append({"text": item["text"]})
        else:
            parts.append({"text": str(content)})
        if parts:
            contents.append({"role": role, "parts": parts})
    return contents


async def _stream_gemini_native(
    api_key: str,
    model_name: str,
    messages: list[dict],
    max_tokens: int,
    thinking_budget: int = 0,
    search_config: Optional[dict] = None,
) -> AsyncGenerator[dict, None]:
    """Gemini 原生 streamGenerateContent API 流式调用。

    与 OpenAI 兼容端点不同，原生端点支持：
    - google_search 工具（Google Search grounding）
    - thinkingConfig（思考/推理控制）
    - groundingMetadata 引用来源（citations）

    SSE 格式: 每个 data 行是一个 GenerateContentResponse JSON 对象。
    参考: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
    """
    # 提取模型 ID（去掉可能的 "models/" 前缀）
    model_id = model_name.replace("models/", "", 1) if model_name.startswith("models/") else model_name

    # 构建 Gemini 原生端点 URL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:streamGenerateContent"

    headers = {"Content-Type": "application/json"}
    params = {"alt": "sse"}
    if api_key:
        params["key"] = api_key

    # 转换消息格式
    contents = _convert_messages_to_gemini_contents(messages)

    # 提取系统消息作为 systemInstruction
    system_texts = [m["content"] for m in messages if m.get("role") == "system" and m.get("content")]
    system_instruction = None
    if system_texts:
        system_instruction = {"parts": [{"text": "\n".join(system_texts)}]}

    # 构建请求体
    body: dict = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
        },
    }

    if system_instruction:
        body["systemInstruction"] = system_instruction

    is_gemini_3 = model_name.lower().startswith("gemini-3") or ".3" in model_name.lower()

    # 思考/推理配置（位于 generationConfig 内部）
    thinking_cfg = None
    if thinking_budget > 0:
        if is_gemini_3:
            # Gemini 3.x: thinkingLevel
            if thinking_budget <= 1024:
                level = "MINIMAL"
            elif thinking_budget <= 4096:
                level = "LOW"
            elif thinking_budget <= 16384:
                level = "MEDIUM"
            else:
                level = "HIGH"
            thinking_cfg = {"thinkingLevel": level, "includeThoughts": True}
        else:
            # Gemini 2.x: thinkingBudget
            thinking_cfg = {"thinkingBudget": thinking_budget, "includeThoughts": True}
    else:
        # 总是请求 thought 标记以便区分思考/回复内容
        thinking_cfg = {"includeThoughts": True}
    if thinking_cfg:
        body["generationConfig"]["thinkingConfig"] = thinking_cfg

    # Google Search grounding 工具
    if search_config:
        body["tools"] = [{"google_search": {}}]

    log.info("stream-gemini-native: model=%s max_tokens=%d thinking=%d search=%s",
             model_id, max_tokens, thinking_budget, bool(search_config))

    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", url, headers=headers, params=params, json=body) as resp:
            resp.raise_for_status()

            full_text = ""
            full_thinking = ""
            grounding_sent = False
            usage_info = {}

            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if not data_str:
                    continue

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                candidates = chunk.get("candidates") or []
                if not candidates:
                    continue
                cand = candidates[0]

                # ── Grounding 引用来源 ──
                if not grounding_sent:
                    gm = _extract_grounding_metadata(chunk)
                    if gm:
                        sources = _format_grounding_sources(gm)
                        if sources:
                            grounding_sent = True
                            yield {"type": "sources", "sources": sources}

                # ── 文本内容（含思考标记） ──
                content = cand.get("content") or {}
                parts = content.get("parts") or []

                for part in parts:
                    text = part.get("text", "")
                    if not text:
                        continue

                    if part.get("thought"):
                        full_thinking += text
                        yield {"type": "thinking", "content": text}
                    else:
                        full_text += text
                        yield {"type": "content", "content": text}

                # ── Token 用量（通常在最后 chunk）──
                usage = chunk.get("usageMetadata") or {}
                if usage:
                    usage_info = {
                        "prompt_tokens": usage.get("promptTokenCount", 0),
                        "completion_tokens": usage.get("candidatesTokenCount", 0),
                    }

            # ── 最终用量 ──
            if usage_info:
                yield {"type": "usage", "usage": usage_info}
            else:
                # 估算（fallback）
                total_input_chars = sum(len(m.get("content", "")) for m in messages)
                total_output_chars = len(full_text) + len(full_thinking)
                yield {
                    "type": "usage",
                    "usage": {
                        "prompt_tokens": max(1, total_input_chars // 3),
                        "completion_tokens": max(1, total_output_chars // 3),
                    },
                }

def _build_anthropic_payload(model_name: str, messages: list[dict], max_tokens: int,
                          thinking_budget: int = 0, stream: bool = True) -> dict:
    """构建 Anthropic 兼容 API 的请求 payload。
    """
    system_msg = ""
    user_msgs = []
    for m in messages:
        if m["role"] == "system":
            system_msg = m["content"]
        else:
            user_msgs.append(m)

    payload = {
        "model": model_name,
        "messages": user_msgs,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if system_msg:
        payload["system"] = system_msg

    # 启用思考：Opus 4.7 必须用 adaptive，其余用 enabled + budget_tokens
    if thinking_budget > 0:
        if "opus-4-7" in model_name:
            payload["thinking"] = {"type": "adaptive"}
        else:
            payload["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }
            # 确保 max_tokens 至少覆盖思考 + 回复
            payload["max_tokens"] = max(max_tokens, thinking_budget + 1024)
    return payload

async def _stream_anthropic(
    base_url: str, api_key: str, model_name: str,
    messages: list[dict], max_tokens: int,
    thinking_budget: int = 0,
    search_config: Optional[dict] = None,
) -> AsyncGenerator[dict, None]:
    """Anthropic Messages API 流式调用。

    Anthropic 的 SSE 格式与 OpenAI 不同，采用 event/data 两行结构：
    - event: content_block_delta → thinking_delta 或 text_delta
    - event: message_delta → usage 信息
    - event: message_start → 消息元信息（当前未使用）

    注意：Anthropic 中 system 消息是顶层字段而非 message 列表中的一条，
    需要从 messages 中单独提取。

    联网搜索：提供 search_config 时注入 Anthropic 原生 web_search server-side tool。
    """
    # 分离 system 消息：Anthropic API 中 system 是顶层字段
    payload = _build_anthropic_payload(
        model_name, messages, max_tokens, thinking_budget=thinking_budget, stream=True
    )
    headers = {"Content-Type": "application/json"}
    if _is_openrouter_base_url(base_url):
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers["HTTP-Referer"] = "https://megaform.local"
        headers["X-Title"] = "MegaForm"
    else:
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"

    # ── 注入 Anthropic 原生 web_search server-side tool ──
    if search_config:
        payload["tools"] = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 5}]

    url = _anthropic_messages_url(base_url)
    log.info("stream-anthropic: %s url=%s max_tokens=%d thinking=%d search=%s", model_name, url, max_tokens, thinking_budget, str(bool(search_config)))

    # Anthropic SSE 格式：先 event: 行指示事件类型，再 data: 行携带 JSON
    event_type = ""
    usage_info = {}
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                elif line.startswith("data: "):
                    try:
                        data = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue

                    # content_block_delta: 内容增量（可能是思考或文本）
                    if event_type == "content_block_delta":
                        delta = data.get("delta", {})
                        delta_type = delta.get("type", "")
                        if delta_type == "thinking_delta":
                            yield {"type": "thinking", "content": delta.get("thinking", "")}
                        elif delta_type == "text_delta":
                            yield {"type": "content", "content": delta.get("text", "")}

                    # message_delta: Token 用量信息
                    elif event_type == "message_delta":
                        usage = data.get("usage", {})
                        if usage:
                            usage_info.update(usage)
                            yield {"type": "usage", "usage": usage_info}

                    elif event_type == "message_start":
                        usage = data.get("message", {}).get("usage", {})
                        if usage:
                            yield {"type": "usage", "usage": usage}
                            usage_info.update(usage)


def compute_cost(model_cfg: dict, tokens_input: int, tokens_output: int) -> float:
    """计算本次模型调用的费用（元）。

    费用 = (输入 token × 输入单价 + 输出 token × 输出单价) / 1000

    参数:
        model_cfg: 模型配置字典，含 price_per_input 和 price_per_output（元/1K tokens）
        tokens_input: 输入 token 数量
        tokens_output: 输出 token 数量

    返回:
        float: 费用（元），保留实际小数精度
    """
    price_in = model_cfg.get("price_per_input", 0)
    price_out = model_cfg.get("price_per_output", 0)
    # 价格单位为 元/1K tokens，所以需要除以 1000
    return (tokens_input * price_in + tokens_output * price_out) / 1000
