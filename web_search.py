"""
MegaForm — Web Search Module (网络搜索模块)

支持的搜索后端:
- brave    — Brave Search API (独立索引, 免费层 2000/月)
- serper   — Serper.dev (Google SERP 包装, 最便宜 $0.30/1K)
- tavily   — Tavily (AI 原生搜索, 含 AI 摘要)
- serpapi  — SerpAPI (全功能 SERP, 100+ 搜索引擎)
- searxng  — SearXNG (自托管元搜索引擎, 免费, 无需 API Key)

搜索结果会被格式化后注入 LLM system prompt 供模型参考。
"""

import logging
import httpx
import urllib.parse
import asyncio

log = logging.getLogger("megaform.web_search")


# ── 搜索提供商预设 (供前端 UI 使用) ──

SEARCH_PROVIDERS = [
    {
        "id": "brave",
        "name": "Brave Search",
        "base_url": "https://api.search.brave.com/res/v1/web/search",
        "api_key_hint": "BSA... (Brave Search API Key)",
        "free_tier": "2,000 次/月免费",
        "pricing": "$5/1K 次",
    },
    {
        "id": "serper",
        "name": "Serper (Google)",
        "base_url": "https://google.serper.dev/search",
        "api_key_hint": "注册即得 API Key",
        "free_tier": "2,500 次/月免费",
        "pricing": "$0.30/1K 次",
    },
    {
        "id": "tavily",
        "name": "Tavily",
        "base_url": "https://api.tavily.com/search",
        "api_key_hint": "tvly-...",
        "free_tier": "1,000 次/月免费",
        "pricing": "$0.008/次",
    },
    {
        "id": "serpapi",
        "name": "SerpAPI",
        "base_url": "https://serpapi.com/search",
        "api_key_hint": "注册即得 API Key",
        "free_tier": "100 次/月免费",
        "pricing": "$50/月起",
    },
    {
        "id": "searxng",
        "name": "SearXNG (自托管)",
        "base_url": "http://localhost:8080",
        "api_key_hint": "无需 API Key, 填实例地址即可",
        "free_tier": "完全免费",
        "pricing": "免费 (自托管)",
    },
]


async def search_web(query: str, provider: str = "tavily", api_key: str = "",
                     base_url: str = "", max_results: int = 5) -> list[dict]:
    """执行网络搜索并返回结果列表。

    根据 provider 参数分发到不同的搜索后端。

    参数:
        query: 搜索关键词
        provider: 搜索提供商 (brave|serper|tavily|serpapi|searxng)
        api_key: API 密钥 (SearXNG 忽略此参数)
        base_url: 自定义 API 地址 (用于 SearXNG 或私有部署)
        max_results: 最大返回结果数，默认 5

    返回:
        list[dict]: 搜索结果，每项包含 title/content/url
    """
    log.info("搜索 query=%.50s... provider=%s", query, provider)

    if provider == "brave" and api_key:
        return await _search_brave(query, api_key, max_results)
    elif provider == "serper" and api_key:
        return await _search_serper(query, api_key, max_results)
    elif provider == "tavily" and api_key:
        return await _search_tavily(query, api_key, max_results)
    elif provider == "serpapi" and api_key:
        return await _search_serpapi(query, api_key, max_results)
    elif provider == "searxng" and base_url:
        return await _search_searxng(query, base_url, max_results)

    return []


# ═══════════════════════════════════════════════════════════════
# ── Brave Search API ──
# ═══════════════════════════════════════════════════════════════

async def _search_brave(query: str, api_key: str, max_results: int) -> list[dict]:
    """Brave Search API — 独立搜索索引, LLM 友好格式."""
    url = "https://api.search.brave.com/res/v1/web/search"
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": api_key,
    }
    params = {"q": query, "count": min(max_results, 20)}

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers=headers, params=params)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for r in data.get("web", {}).get("results", [])[:max_results]:
        results.append({
            "title": r.get("title", ""),
            "content": r.get("description", ""),
            "url": r.get("url", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════
# ── Serper (Google SERP) ──
# ═══════════════════════════════════════════════════════════════

async def _search_serper(query: str, api_key: str, max_results: int) -> list[dict]:
    """Serper.dev — 最快的 Google SERP API, 极低成本."""
    url = "https://google.serper.dev/search"
    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json",
    }
    payload = {"q": query, "num": max_results}

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for r in data.get("organic", [])[:max_results]:
        results.append({
            "title": r.get("title", ""),
            "content": r.get("snippet", ""),
            "url": r.get("link", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════
# ── Tavily (AI-native search) ──
# ═══════════════════════════════════════════════════════════════

async def _search_tavily(query: str, api_key: str, max_results: int) -> list[dict]:
    """Tavily — 专为 AI Agent 优化的搜索 API, 返回 AI 摘要."""
    url = "https://api.tavily.com/search"
    payload = {
        "query": query,
        "max_results": max_results,
        "include_answer": True,
        "search_depth": "basic",
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    results = []
    if data.get("answer"):
        results.append({"title": "AI 摘要", "content": data["answer"], "url": ""})
    for r in data.get("results", []):
        results.append({
            "title": r.get("title", ""),
            "content": r.get("content", ""),
            "url": r.get("url", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════
# ── SerpAPI ──
# ═══════════════════════════════════════════════════════════════

async def _search_serpapi(query: str, api_key: str, max_results: int) -> list[dict]:
    """SerpAPI — 支持 100+ 搜索引擎的全功能 SERP API."""
    url = "https://serpapi.com/search"
    params = {
        "q": query,
        "api_key": api_key,
        "engine": "google",
        "num": max_results,
    }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for r in data.get("organic_results", [])[:max_results]:
        results.append({
            "title": r.get("title", ""),
            "content": r.get("snippet", ""),
            "url": r.get("link", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════
# ── SearXNG (self-hosted) ──
# ═══════════════════════════════════════════════════════════════

async def _search_searxng(query: str, base_url: str, max_results: int) -> list[dict]:
    """SearXNG — 自托管元搜索引擎, 免费, 隐私友好."""
    url = f"{base_url.rstrip('/')}/search"
    params = {"q": query, "format": "json", "categories": "general"}
    headers = {"Accept": "application/json"}

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    results = []
    for r in data.get("results", [])[:max_results]:
        results.append({
            "title": r.get("title", ""),
            "content": r.get("content", ""),
            "url": r.get("url", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════

def format_search_context(results: list[dict], query: str, language: str = "zh-CN") -> str:
    """将搜索结果格式化为可供 LLM 参考的上下文字符串。"""
    if not results:
        return ""
    if language == "en":
        ctx = f"Here are web search results for \"{query}\". Use them to answer the user's question when relevant; ignore them if they are unrelated.\n\n"
    else:
        ctx = f"以下是关于「{query}」的网络搜索结果，请参考这些信息回答用户的问题。如果搜索结果与问题无关，可以忽略。\n\n"
    for i, r in enumerate(results, 1):
        ctx += f"[{i}] {r['title']}\n"
        if r['content']:
            ctx += f"{r['content']}\n"
        if r['url']:
            ctx += f"{'Source' if language == 'en' else '来源'}: {r['url']}\n"
        ctx += "\n"
    return ctx


# ═══════════════════════════════════════════════════════════════
# ── see_web — 抓取网页详细内容 ──
# ═══════════════════════════════════════════════════════════════

import re as _re

_HTML_TAG = _re.compile(r'<[^>]+>')
_HTML_SCRIPT = _re.compile(r'<script[^>]*>.*?</script>', _re.DOTALL | _re.IGNORECASE)
_HTML_STYLE = _re.compile(r'<style[^>]*>.*?</style>', _re.DOTALL | _re.IGNORECASE)
_HTML_ENTITY = _re.compile(r'&[a-zA-Z]+;|&#\d+;')
_WHITESPACE = _re.compile(r'\s+')


def _extract_text_from_html(html: str, max_chars: int = 8000) -> str:
    """从 HTML 中提取纯文本内容（去除标签/脚本/样式）。"""
    text = _HTML_SCRIPT.sub(' ', html)
    text = _HTML_STYLE.sub(' ', text)
    text = _HTML_TAG.sub(' ', text)
    text = _HTML_ENTITY.sub(' ', text)
    text = _WHITESPACE.sub(' ', text).strip()
    if len(text) > max_chars:
        text = text[:max_chars] + "..."
    return text


async def see_web(urls: list[str], max_chars_per_page: int = 8000, language: str = "zh-CN") -> str:
    """抓取指定 URL 列表的网页内容，返回格式化文本。

    用于 tool-calling 流程的第二阶段：模型看了搜索结果摘要后，
    决定深入阅读某些网页的完整内容。

    参数:
        urls: 要抓取的 URL 列表
        max_chars_per_page: 每页最大保留字符数，默认 8000

    返回:
        str: 格式化的网页内容文本，供模型参考
    """
    if not urls:
        return ""

    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; MegaForm/1.0; +https://megaform.local)",
    }

    async def fetch_url(i: int, url: str, client: httpx.AsyncClient) -> str:
        try:
            log.info("see_web: [%d/%d] 开始抓取 %s", i, len(urls), url[:80])
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()

            content_type = resp.headers.get("content-type", "")
            if "text/html" in content_type:
                text = _extract_text_from_html(resp.text, max_chars_per_page)
            elif "text/plain" in content_type:
                text = resp.text[:max_chars_per_page]
            else:
                # 非文本内容，跳过
                message = "Non-text content; unable to extract" if language == "en" else "非文本内容，无法提取"
                return f"[{i}] {url}\n({message})\n"

            return f"[{i}] {url}\n{text}\n"
        except Exception as e:
            log.warning("see_web: 抓取失败 %s: %s", url[:80], e)
            message = "Fetch failed" if language == "en" else "抓取失败"
            return f"[{i}] {url}\n({message}: {e})\n"

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        tasks = [fetch_url(i, url, client) for i, url in enumerate(urls, 1)]
        all_content = await asyncio.gather(*tasks)

    return "\n---\n".join(filter(None, all_content)) if all_content else ""
