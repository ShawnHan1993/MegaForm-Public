import unicodedata

from app_state import _build_system_prompt, _get_user_language, db, re

_UNICODE_SCRIPT_MAP = str.maketrans({
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "⁺": "+", "⁻": "-", "⁼": "=", "⁽": "(", "⁾": ")",
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
    "₊": "+", "₋": "-", "₌": "=", "₍": "(", "₎": ")",
    "ᵢ": "i", "ⱼ": "j", "ₖ": "k", "ₗ": "l", "ₘ": "m",
    "ₙ": "n", "ₚ": "p", "ᵣ": "r", "ₛ": "s", "ₜ": "t",
})

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
    current_node_id: str | None = None,
    current_nut_id: str | None = None,
    current_partial_content: str | None = None,
    current_parent_model_id: str | None = None,
    relation: str | None = None,
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

    # ── 当前 Progression 节点的兄弟节点上下文 ──
    # 新建节点尚无 child_order，所有已存在的 progression 兄弟都在其之前。
    # 给已有节点追加/重跑模型时，只复用它创建时可见的更早兄弟，不能把它自己的旧回复带入。
    if relation == "progression" and parent_node_id:
        sibling_cutoff_order = 999999
        if current_node_id:
            current_node = db.get_node(current_node_id, user_id=user_id)
            if current_node:
                sibling_cutoff_order = current_node.get("child_order", 0)

        all_siblings = db.get_progression_siblings_before(
            parent_node_id, sibling_cutoff_order, user_id=user_id
        )
        for sib in all_siblings:
            if sib.get("id") == current_node_id:
                continue
            sib_content = sib["content"]
            if sib.get("nut_id") and sib.get("relation") == "followup":
                continue
            sib_resps = db.get_node_responses(sib["id"], user_id=user_id)
            best_sib = _select_best_response(sib_resps, model_id, sib.get("parent_model_id"))
            if best_sib:
                messages.append({"role": "user", "content": sib_content})
                messages.append({"role": "assistant", "content": best_sib["content"]})

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
    pc_clean = re.sub(r'\s+', ' ', partial.translate(_UNICODE_SCRIPT_MAP)).strip()
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
        text = text.translate(_UNICODE_SCRIPT_MAP)
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
            # LaTeX 上下标符号本身不可见，浏览器复制公式时常只保留指数/下标内容。
            if ch in '#*`[]!>_~{}$^&':
                i += 1
                continue

            # 浏览器复制数学公式时常把 hyphen 显示为 unicode minus。
            if ch in '−–—':
                ch = '-'

            # KaTeX/MathML 复制时可能输出数学字母区字符，NFKC 可还原大多数 ASCII 变量名。
            normalized_ch = unicodedata.normalize("NFKC", ch)

            # 忽略所有空白差异：raw 可能是 ``g(q, k, m-n)``，选区可能是 ``g(q,k,m−n)``。
            if ch.isspace():
                i += 1
                continue

            chars.append(normalized_ch.lower())
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
