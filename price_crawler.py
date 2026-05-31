"""
周期性价格同步模块
────────────────────
从各预设 provider 获取最新 API 定价，更新 model_configs 中的
price_per_input / price_per_output / price_unit。

仅更新使用预设 provider 配置的模型（provider 在 PRESET_PROVIDERS 中），
自定义 base_url 的模型不受影响。

定价变更会写入 settings 表（price_last_sync），前端 ConfigModal 可展示最后同步时间。
"""

import logging
import json
import re
from datetime import datetime, timezone

import httpx

import database as db

log = logging.getLogger("price_crawler")

# ── 预设供应商 ──
# 这些 provider 名称对应 ConfigModal 快速配置中的预设供应商
# 只同步 provider 在此集合中的模型（自定义 base_url 跳过）
PRESET_PROVIDERS = {
    "openai", "deepseek", "anthropic", "gemini",
    "kimi", "minimax", "zhipu", "xai",
}

# ── 供应商标准 base_url 前缀 ──
# 用于过滤：模型 base_url 必须以此为前缀才同步
# （避免把代理/中转 URL 的模型也覆盖了）
PRESET_BASE_PREFIX = {
    "openai":    "https://api.openai.com",
    "deepseek":  "https://api.deepseek.com",
    "anthropic": "https://api.anthropic.com",
    "gemini":    "https://generativelanguage.googleapis.com",
    "kimi":      "https://api.moonshot.cn",
    "minimax":   "https://api.minimax.chat",
    "zhipu":     "https://open.bigmodel.cn",
    "xai":       "https://api.x.ai",
}


# ═════════════════════════════════════════════════════════════
# 定价数据源
# ═════════════════════════════════════════════════════════════

# 格式: {provider: {model_pattern: (price_per_1M_input, price_per_1M_output, currency)}}
# model_pattern 会做子串匹配（不区分大小写）
# 价格单位: 元/1M tokens (CNY) 或 $/1M tokens (USD)
# 最终存储到 model_configs 时转换为 元/1K tokens 或 $/1K tokens

# 数据来源（2026-05）:
#   OpenAI:    https://openai.com/api/pricing/
#   Anthropic: https://www.anthropic.com/pricing
#   DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
#   Google:    https://ai.google.dev/pricing
#   xAI:       https://x.ai/api/pricing
#   Kimi:      https://platform.moonshot.cn/docs/pricing
#   Minimax:   https://www.minimaxi.com/document/price
#   智谱:       https://open.bigmodel.cn/pricing

KNOWN_PRICES: dict[str, list[tuple[str, float, float, str]]] = {
    "openai": [
        ("gpt-5.1",               1.25,  10.00, "USD"),   # 2026-05 最新
        ("gpt-5",                 2.50,  10.00, "USD"),
        ("gpt-5-mini",            0.15,   0.60, "USD"),
        ("gpt-5-nano",            0.05,  0.20, "USD"),
        ("gpt-4.1",               2.00,   8.00, "USD"),
        ("gpt-4.1-mini",          0.40,   1.60, "USD"),
        ("gpt-4.1-nano",          0.10,   0.40, "USD"),
        ("o4-mini",               1.10,   4.40, "USD"),
        ("o3",                    10.00, 40.00, "USD"),
        ("o3-mini",               1.10,   4.40, "USD"),
        ("o1",                    15.00, 60.00, "USD"),
        ("o1-mini",               1.10,   4.40, "USD"),
        ("gpt-4o",                2.50,  10.00, "USD"),
        ("gpt-4o-mini",           0.15,   0.60, "USD"),
    ],
    "anthropic": [
        ("claude-opus-4",        15.00,  75.00, "USD"),
        ("claude-sonnet-4",       3.00,  15.00, "USD"),
        ("claude-3.7-sonnet",     3.00,  15.00, "USD"),
        ("claude-3.5-haiku",      0.80,   4.00, "USD"),
    ],
    "deepseek": [
        ("deepseek-v4-pro",       0.54,   2.16, "CNY"),   # 输入 ¥0.54/M → ¥2.16/M 输出
        ("deepseek-v4",           0.27,   1.10, "CNY"),
        ("deepseek-v3",           0.27,   1.10, "CNY"),
        ("deepseek-r1",           1.00,   4.00, "CNY"),   # R1 有思考过程
        ("deepseek-r1-0528",      1.00,   4.00, "CNY"),
        ("deepseek-chat",         0.27,   1.10, "CNY"),
        ("deepseek-reasoner",     1.00,   4.00, "CNY"),
    ],
    "gemini": [
        ("gemini-2.5-pro",        1.25,  10.00, "USD"),
        ("gemini-2.5-flash",      0.15,   0.60, "USD"),
        ("gemini-2.0-flash",      0.10,   0.40, "USD"),
        ("gemini-2.0-flash-lite", 0.05,   0.10, "USD"),
        ("gemini-3",              0.50,   1.50, "USD"),   # 新模型，价格待确认
    ],
    "kimi": [
        ("moonshot-v1",           0.60,   0.60, "CNY"),   # ¥0.6/M 输入输出同价
        ("kimi-latest",           0.60,   0.60, "CNY"),
        ("kimi-k2",               2.00,   8.00, "CNY"),   # Kimi K2 thinking
    ],
    "minimax": [
        ("abab7",                 1.00,   1.00, "CNY"),   # ¥1/M
        ("abab6.5s",              0.50,   0.50, "CNY"),
        ("abab6.5",               3.00,   3.00, "CNY"),
    ],
    "zhipu": [
        ("glm-4-plus",            5.00,   5.00, "CNY"),   # ¥5/M
        ("glm-4-flash",           0.10,   0.10, "CNY"),
        ("glm-4-air",             0.05,   0.05, "CNY"),
        ("glm-4-long",            1.00,   1.00, "CNY"),
        ("glm-z1",                5.00,   5.00, "CNY"),   # 推理模型
    ],
    "xai": [
        ("grok-4",                3.00,  15.00, "USD"),
        ("grok-3",                3.00,  15.00, "USD"),
        ("grok-3-mini",           0.30,   0.50, "USD"),
        ("grok-2",                2.00,  10.00, "USD"),
    ],
}


async def _fetch_deepseek_pricing() -> dict[str, tuple[float, float, str]] | None:
    """尝试从 DeepSeek 官方文档抓取最新定价（Markdown 页面）"""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://api-docs.deepseek.com/quick_start/pricing",
                headers={"User-Agent": "MegaForm-PriceCrawler/1.0"},
                follow_redirects=True,
            )
            if resp.status_code != 200:
                return None
            text = resp.text

        # 解析 Markdown 中的价格表: | model | input | output |
        results = {}
        # 匹配模式: | model_name | ¥0.54 / M tokens | ¥2.16 / M tokens |
        pattern = re.compile(
            r'\|\s*([\w\-.]+)\s*\|\s*[¥$]?([\d.]+)\s*/\s*M\s*tokens?\s*\|'
            r'\s*[¥$]?([\d.]+)\s*/\s*M\s*tokens?\s*\|',
            re.IGNORECASE,
        )
        for m in pattern.finditer(text):
            model = m.group(1).strip().lower()
            price_in = float(m.group(2))
            price_out = float(m.group(3))
            results[model] = (price_in, price_out, "CNY")
            log.info("price_crawler: DeepSeek 抓取到 %s input=¥%.2f/M output=¥%.2f/M",
                     model, price_in, price_out)
        return results if results else None
    except Exception as e:
        log.warning("price_crawler: DeepSeek 抓取失败: %s", e)
        return None


async def _fetch_openai_pricing() -> dict[str, tuple[float, float, str]] | None:
    """尝试从 OpenAI 定价页抓取"""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://openai.com/api/pricing/",
                headers={"User-Agent": "MegaForm-PriceCrawler/1.0"},
                follow_redirects=True,
            )
            if resp.status_code != 200:
                return None
            text = resp.text

        # OpenAI 页面是 JS 渲染的，直接抓 HTML 不一定有用
        # 搜索 JSON-LD 或 script 中的数据
        results = {}
        # 匹配 $X.XX / 1M input tokens 模式
        price_block = re.compile(
            r'[\"\']([\w\-.]+?)[\"\'].*?'
            r'\$([\d.]+)\s*/\s*1M\s*(?:input\s*)?tokens.*?'
            r'\$([\d.]+)\s*/\s*1M\s*(?:output\s*)?tokens',
            re.IGNORECASE | re.DOTALL,
        )
        for m in price_block.finditer(text):
            model = m.group(1).strip().lower()
            price_in = float(m.group(2))
            price_out = float(m.group(3))
            results[model] = (price_in, price_out, "USD")
        return results if results else None
    except Exception as e:
        log.warning("price_crawler: OpenAI 抓取失败: %s", e)
        return None


async def sync_prices(user_id: str = db.LOCAL_USER_ID) -> int:
    """同步所有预设 provider 的模型定价。返回更新的模型数。"""
    updated = 0

    # 1) 尝试实时抓取（失败则回退到硬编码）
    live_prices: dict[str, dict[str, tuple[float, float, str]]] = {}

    ds_prices = await _fetch_deepseek_pricing()
    if ds_prices:
        live_prices["deepseek"] = ds_prices

    oai_prices = await _fetch_openai_pricing()
    if oai_prices:
        live_prices["openai"] = oai_prices

    # 2) 合并：实时抓取 > 硬编码
    all_prices: dict[str, list[tuple[str, float, float, str]]] = {}
    for provider in PRESET_PROVIDERS:
        live = live_prices.get(provider, {})
        known = KNOWN_PRICES.get(provider, [])
        if live:
            # 实时抓取的覆盖硬编码
            merged = []
            seen = set()
            for model, (pi, po, cu) in live.items():
                merged.append((model, pi, po, cu))
                seen.add(model)
            for model_pat, pi, po, cu in known:
                if model_pat.lower() not in seen:
                    merged.append((model_pat, pi, po, cu))
            all_prices[provider] = merged
        else:
            all_prices[provider] = known

    # 3) 查询所有模型配置
    all_configs = db.get_all_model_configs_map(user_id=user_id)

    # 4) 匹配并更新
    for cfg_id, cfg in all_configs.items():
        provider = cfg.get("provider", "")
        base_url = cfg.get("base_url", "")
        model_name = cfg.get("model_name", "")

        # 跳过非预设 provider
        if provider not in PRESET_PROVIDERS:
            continue

        # 跳过已删除的模型
        if cfg.get("deleted"):
            continue

        # 跳过自定义 base_url 的模型（保留用户手动配置的定价）
        expected_prefix = PRESET_BASE_PREFIX.get(provider, "")
        if expected_prefix and base_url and not base_url.startswith(expected_prefix):
            log.debug("price_crawler: 跳过自定义 URL 模型 %s (%s)", model_name, base_url[:50])
            continue

        # 匹配定价
        prices = all_prices.get(provider, [])
        matched = None
        model_lower = model_name.lower()
        for pattern, price_in, price_out, currency in prices:
            if pattern.lower() in model_lower:
                matched = (price_in, price_out, currency)
                break

        if not matched:
            log.debug("price_crawler: 无匹配定价 %s/%s", provider, model_name)
            continue

        price_in, price_out, currency = matched

        # 转换为 1K tokens 单位（定价表为 1M tokens）
        price_per_input = round(price_in / 1000, 6)
        price_per_output = round(price_out / 1000, 6)

        # 检查是否需要更新
        old_in = cfg.get("price_per_input", 0)
        old_out = cfg.get("price_per_output", 0)
        old_unit = cfg.get("price_unit", "CNY")

        if (abs(old_in - price_per_input) < 0.000001 and
            abs(old_out - price_per_output) < 0.000001 and
            old_unit == currency):
            continue  # 无变化

        # 更新
        cfg["price_per_input"] = price_per_input
        cfg["price_per_output"] = price_per_output
        cfg["price_unit"] = currency
        db.save_model_config(cfg, user_id=user_id)

        log.info("price_crawler: 更新定价 %s/%s %s→%s in=%.6f→%.6f out=%.6f→%.6f %s",
                 provider, model_name, cfg.get("name", ""),
                 "✓", old_in, price_per_input, old_out, price_per_output, currency)
        updated += 1

    # 5) 记录同步时间
    now = datetime.now(timezone.utc).isoformat()
    db.set_setting("price_last_sync", now, user_id=user_id)

    return updated


# ── 手动触发接口：用 httpx POST /api/price-sync 可在不重启的情况下刷新 ──
