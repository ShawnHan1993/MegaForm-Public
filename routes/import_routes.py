from app_state import (
    MARKDOWN_MODEL_ID,
    MARKDOWN_MODEL_NAME,
    MINERU_API_BASE,
    MINERU_ASSETS_DIR,
    MINERU_HTTP_RETRY_ATTEMPTS,
    MINERU_HTTP_RETRY_BASE_DELAY_SECONDS,
    MINERU_INPUT_BYTES_PER_TOKEN,
    MINERU_MODEL_ID,
    MINERU_MODEL_NAME,
    MINERU_POLL_INTERVAL_SECONDS,
    MINERU_POLL_TIMEOUT_SECONDS,
    MINERU_USAGE_CALLS_SETTING,
    MINERU_USAGE_INPUT_SETTING,
    MINERU_USAGE_OUTPUT_SETTING,
    Path,
    _estimate_tokens,
    _get_user_id,
    _get_user_language,
    _mark_root_summary_dirty_if_shallow_node,
    asyncio,
    db,
    httpx,
    io,
    log,
    quote,
    re,
    shutil,
    time,
    unquote,
    urlparse,
    zipfile,
)
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from streaming import (
    _iter_text_chunks,
    _publish_stream_event,
    _sse,
    _start_stream_segment,
    _stream_channels,
    _stream_channels_lock,
    _subscribe_stream,
)

router = APIRouter()

def _mineru_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "*/*",
    }


def _mineru_success(data: dict) -> bool:
    return isinstance(data, dict) and data.get("code") == 0


def _mineru_error_message(data: dict, fallback: str = "MinerU 请求失败") -> str:
    if isinstance(data, dict):
        return str(data.get("msg") or data.get("message") or fallback)
    return fallback


def _mineru_response_json(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _mineru_should_retry_response(resp: httpx.Response, data: dict | None = None) -> bool:
    if resp.status_code in {408, 409, 425, 429} or 500 <= resp.status_code < 600:
        return True
    data = data or {}
    code = data.get("code")
    msg = str(data.get("msg") or data.get("message") or "").lower()
    if code == 0:
        return False
    transient_words = ("timeout", "temporar", "rate limit", "too many", "busy", "overload", "try again")
    return any(word in msg for word in transient_words)


async def _mineru_request_with_retry(
    request_coro_factory,
    *,
    label: str,
    node_id: str,
    response_id: str,
    attempts: int = MINERU_HTTP_RETRY_ATTEMPTS,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            resp = await request_coro_factory()
            data = _mineru_response_json(resp)
            retryable_response = _mineru_should_retry_response(resp, data)
            if attempt < attempts and retryable_response:
                delay = MINERU_HTTP_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
                log.warning(
                    "mineru-import: retryable response label=%s node=%s response=%s attempt=%d/%d status=%s code=%s msg=%s delay=%.1fs",
                    label, node_id, response_id, attempt, attempts, resp.status_code,
                    data.get("code"), str(data.get("msg") or data.get("message") or "")[:200], delay,
                )
                await asyncio.sleep(delay)
                continue
            if retryable_response:
                log.error(
                    "mineru-import: retryable response exhausted label=%s node=%s response=%s attempts=%d status=%s code=%s msg=%s",
                    label, node_id, response_id, attempts, resp.status_code,
                    data.get("code"), str(data.get("msg") or data.get("message") or "")[:200],
                )
            if attempt > 1:
                log.info(
                    "mineru-import: retry succeeded label=%s node=%s response=%s attempt=%d/%d status=%s",
                    label, node_id, response_id, attempt, attempts, resp.status_code,
                )
            return resp
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as e:
            last_error = e
            if attempt >= attempts:
                break
            delay = MINERU_HTTP_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
            log.warning(
                "mineru-import: retryable exception label=%s node=%s response=%s attempt=%d/%d error=%s delay=%.1fs",
                label, node_id, response_id, attempt, attempts, repr(e), delay,
            )
            await asyncio.sleep(delay)
    log.error(
        "mineru-import: retries exhausted label=%s node=%s response=%s attempts=%d error=%s",
        label, node_id, response_id, attempts, repr(last_error),
    )
    if last_error:
        raise last_error
    raise RuntimeError(f"MinerU 请求失败: {label}")


MINERU_ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MINERU_MAX_ASSET_BYTES = 20 * 1024 * 1024
MINERU_MAX_ASSET_TOTAL_BYTES = 200 * 1024 * 1024


def _is_external_asset_src(src: str) -> bool:
    return not src or bool(re.match(r"^(?:https?:|data:|blob:|#|/)", src, re.IGNORECASE))


def _safe_user_asset_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value or "unknown")


def _mineru_asset_root(user_id: str, response_id: str) -> Path:
    return MINERU_ASSETS_DIR / _safe_user_asset_segment(user_id) / _safe_user_asset_segment(response_id)


def _remove_mineru_response_assets(user_id: str, response_id: str) -> None:
    root = _mineru_asset_root(user_id, response_id)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


def _remove_mineru_response_assets_many(user_id: str, response_ids: list[str]) -> None:
    for response_id in response_ids:
        _remove_mineru_response_assets(user_id, response_id)


def _collect_node_response_ids(node_id: str, user_id: str) -> list[str]:
    seen_nodes: set[str] = set()
    response_ids: list[str] = []

    def visit(current_id: str):
        if current_id in seen_nodes:
            return
        seen_nodes.add(current_id)
        response_ids.extend(r["id"] for r in db.get_node_responses(current_id, user_id=user_id))
        for child in db.get_node_children(current_id, user_id=user_id):
            visit(child["id"])

    visit(node_id)
    return response_ids


def _collect_response_delete_asset_ids(response_id: str, user_id: str) -> list[str]:
    response_ids = [response_id]
    nut_ids = {nut["id"] for nut in db.get_response_nuts(response_id, user_id=user_id)}
    if not nut_ids:
        return response_ids

    root_resp = db.get_response(response_id, user_id=user_id)
    if not root_resp:
        return response_ids
    node = db.get_node(root_resp["node_id"], user_id=user_id)
    if not node:
        return response_ids
    for candidate in db.get_root_nodes(node["root_id"], user_id=user_id):
        if candidate.get("nut_id") in nut_ids:
            response_ids.extend(_collect_node_response_ids(candidate["id"], user_id=user_id))
    return list(dict.fromkeys(response_ids))


def _safe_zip_member_path(name: str) -> Path | None:
    raw = unquote((name or "").replace("\\", "/")).strip("/")
    if not raw or raw.endswith("/"):
        return None
    parts = Path(raw).parts
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return Path(*parts)


def _mineru_markdown_base_dir(md_name: str) -> Path:
    safe_md_path = _safe_zip_member_path(md_name)
    if not safe_md_path:
        return Path()
    parent = safe_md_path.parent
    return Path() if str(parent) == "." else parent


def _normalize_mineru_markdown_asset_src(src: str, md_base_dir: Path, saved_assets: set[str]) -> str | None:
    src = (src or "").strip()
    if _is_external_asset_src(src):
        return None
    src_no_fragment = re.split(r"[?#]", src, maxsplit=1)[0]
    safe_src_path = _safe_zip_member_path(src_no_fragment)
    if not safe_src_path:
        return None

    candidates = []
    if str(md_base_dir) != ".":
        candidates.append(md_base_dir / safe_src_path)
    candidates.append(safe_src_path)

    if len(safe_src_path.parts) >= 2 and safe_src_path.parts[0] == "images":
        candidates.append(Path(*safe_src_path.parts[-2:]))

    for candidate in candidates:
        normalized = candidate.as_posix()
        if normalized in saved_assets:
            return normalized
    return None


def _mineru_asset_url(response_id: str, asset_path: str) -> str:
    return f"/api/responses/{response_id}/assets/{quote(asset_path, safe='/')}"


def _rewrite_mineru_markdown_assets(markdown: str, response_id: str, md_base_dir: Path, saved_assets: set[str]) -> str:
    def repl_md(match: re.Match) -> str:
        alt, src = match.group(1), match.group(2).strip()
        if src.startswith("<") and src.endswith(">"):
            inner = src[1:-1].strip()
            rewritten = _normalize_mineru_markdown_asset_src(inner, md_base_dir, saved_assets)
            return f"![{alt}](<{_mineru_asset_url(response_id, rewritten)}>)" if rewritten else match.group(0)
        rewritten = _normalize_mineru_markdown_asset_src(src, md_base_dir, saved_assets)
        return f"![{alt}]({_mineru_asset_url(response_id, rewritten)})" if rewritten else match.group(0)

    markdown = re.sub(r"!\[([^\]]*)\]\(([^)\n]+)\)", repl_md, markdown)

    def repl_html(match: re.Match) -> str:
        quote, src = match.group(1), match.group(2)
        rewritten = _normalize_mineru_markdown_asset_src(src, md_base_dir, saved_assets)
        if not rewritten:
            return match.group(0)
        return f"src={quote}{_mineru_asset_url(response_id, rewritten)}{quote}"

    return re.sub(r"src=(['\"])(?!https?:|data:|blob:|#|/)([^'\"]+)\1", repl_html, markdown, flags=re.IGNORECASE)


def _extract_full_markdown_bundle_from_zip(zip_bytes: bytes, response_id: str, user_id: str) -> tuple[str, int]:
    asset_root = _mineru_asset_root(user_id, response_id)
    _remove_mineru_response_assets(user_id, response_id)
    saved_assets: set[str] = set()
    asset_total = 0

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        md_names = [name for name in names if name.lower().endswith(".md")]
        preferred = next((name for name in md_names if name.lower().endswith("full.md")), None)
        md_name = preferred or (md_names[0] if md_names else None)
        if not md_name:
            raise ValueError("MinerU 结果 zip 中未找到 Markdown 文件")
        md_base_dir = _mineru_markdown_base_dir(md_name)

        for info in zf.infolist():
            member_path = _safe_zip_member_path(info.filename)
            if not member_path:
                continue
            if member_path.suffix.lower() not in MINERU_ASSET_EXTENSIONS:
                continue
            if "images" not in member_path.parts:
                continue
            if info.file_size > MINERU_MAX_ASSET_BYTES:
                log.warning("mineru-import: 跳过过大的图片 %s size=%d", info.filename, info.file_size)
                continue
            if asset_total + info.file_size > MINERU_MAX_ASSET_TOTAL_BYTES:
                log.warning("mineru-import: 图片总大小超过限制，停止继续保存")
                break

            target = asset_root / member_path
            resolved_root = asset_root.resolve()
            resolved_target = target.resolve()
            if resolved_root not in resolved_target.parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            saved_assets.add(member_path.as_posix())
            asset_total += info.file_size

        raw = zf.read(md_name)

    text = raw.decode("utf-8", errors="replace")
    markdown = _rewrite_mineru_markdown_assets(text, response_id, md_base_dir, saved_assets)
    log.info(
        "mineru-import: saved assets response=%s markdown=%s assets=%d bytes=%d dir=%s",
        response_id, md_name, len(saved_assets), asset_total, asset_root,
    )
    return markdown, len(saved_assets)


def _estimate_mineru_input_tokens(pdf_bytes: bytes) -> int:
    return max(1, len(pdf_bytes) // MINERU_INPUT_BYTES_PER_TOKEN)


def _estimate_mineru_url_input_tokens(pdf_url: str) -> int:
    return max(1, len(pdf_url or "") // MINERU_INPUT_BYTES_PER_TOKEN)


def _filename_from_pdf_url(pdf_url: str) -> str:
    parsed = urlparse(pdf_url)
    name = Path(unquote(parsed.path or "")).name
    if not name:
        return "document.pdf"
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf"
    return Path(name).name


def _redact_url_for_log(raw_url: str | None) -> str:
    if not raw_url:
        return ""
    parsed = urlparse(raw_url)
    path = parsed.path or ""
    return f"{parsed.scheme}://{parsed.netloc}{path[:80]}{'...' if len(path) > 80 else ''}"


def _create_pdf_import_node_response(
    *,
    root_id: str | None,
    parent_id: str | None,
    relation: str,
    card_content: str,
    filename: str,
    user_id: str,
    source: str,
    source_url: str | None = None,
) -> tuple[dict, dict, str]:
    safe_relation = relation if relation in {"progression", "followup"} else "progression"
    default_content = f"阅读 PDF：{filename}" if _get_user_language(user_id) != "en" else f"Read PDF: {filename}"
    node_content = card_content.strip()[:1000] or default_content
    meta = {"kind": "pdf_import", "filename": filename, "source": source, "card_content": node_content}
    response_meta = {"source": source, "filename": filename}
    if source_url:
        meta["source_url"] = source_url
        response_meta["source_url"] = source_url
    node_kwargs = {"relation": safe_relation, "meta": meta}
    if parent_id:
        node_kwargs["parent_id"] = parent_id
        node_kwargs["parent_model_id"] = MINERU_MODEL_ID

    node = db.create_node(root_id, node_content, user_id=user_id, **node_kwargs)
    response = db.create_response(
        node_id=node["id"],
        model_id=MINERU_MODEL_ID,
        content="",
        user_id=user_id,
        status="streaming",
        meta=response_meta,
    )
    _mark_root_summary_dirty_if_shallow_node(node["id"], user_id=user_id)
    log.info(
        "mineru-import: created node=%s response=%s root=%s parent=%s source=%s filename=%s relation=%s",
        node["id"], response["id"], node.get("root_id"), parent_id or "", source, filename, safe_relation,
    )
    return node, response, safe_relation


async def _bg_mineru_pdf_import(
    node_id: str,
    response_id: str,
    filename: str,
    api_key: str,
    user_id: str,
    pdf_bytes: bytes | None = None,
    pdf_url: str | None = None,
    segment_id: int = 0,
):
    async def _qput(event: str, data: dict):
        await _publish_stream_event(node_id, _sse(event, data))

    model_version = db.get_setting("mineru_model_version", "vlm", user_id=user_id).strip() or "vlm"
    language = db.get_setting("mineru_language", "ch", user_id=user_id).strip() or "ch"
    enable_formula = db.get_setting("mineru_enable_formula", "true", user_id=user_id).lower() != "false"
    enable_table = db.get_setting("mineru_enable_table", "true", user_id=user_id).lower() != "false"
    is_ocr = db.get_setting("mineru_is_ocr", "false", user_id=user_id).lower() == "true"
    headers = _mineru_headers(api_key)
    t0 = time.time()
    input_mode = "url" if pdf_url else "upload"

    await _qput("model_start", {
        "node_id": node_id,
        "model_id": MINERU_MODEL_ID,
        "model_name": MINERU_MODEL_NAME,
    })

    try:
        log.info(
            "mineru-import: start node=%s response=%s mode=%s filename=%s model_version=%s language=%s formula=%s table=%s ocr=%s url=%s",
            node_id, response_id, input_mode, filename, model_version, language,
            enable_formula, enable_table, is_ocr, _redact_url_for_log(pdf_url),
        )
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=120.0)) as client:
            if not pdf_bytes and not pdf_url:
                raise RuntimeError("缺少 PDF 文件或链接")
            await _qput("thinking", {
                "node_id": node_id,
                "model_id": MINERU_MODEL_ID,
                "content": f"提交 PDF 给 MinerU: {filename}\n",
            })
            task_id = ""
            batch_id = ""
            task_ref = ""
            if pdf_url:
                apply_payload = {
                    "url": pdf_url,
                    "data_id": response_id,
                    "is_ocr": is_ocr,
                    "model_version": model_version,
                    "language": language,
                    "enable_formula": enable_formula,
                    "enable_table": enable_table,
                }
                apply_resp = await _mineru_request_with_retry(
                    lambda: client.post(
                        f"{MINERU_API_BASE}/extract/task",
                        headers=headers,
                        json=apply_payload,
                    ),
                    label="submit-url-task",
                    node_id=node_id,
                    response_id=response_id,
                )
                apply_data = _mineru_response_json(apply_resp)
                if apply_resp.status_code >= 400 or not _mineru_success(apply_data):
                    raise RuntimeError(_mineru_error_message(apply_data, f"创建解析任务失败: HTTP {apply_resp.status_code}"))
                task_id = str((apply_data.get("data") or {}).get("task_id") or "")
                if not task_id:
                    raise RuntimeError("MinerU 未返回 task_id")
                task_ref = task_id
                log.info(
                    "mineru-import: submitted node=%s response=%s mode=url task=%s http_status=%s endpoint=/extract/task",
                    node_id, response_id, task_id, apply_resp.status_code,
                )
                await _qput("thinking", {
                    "node_id": node_id,
                    "model_id": MINERU_MODEL_ID,
                    "content": "MinerU 已接收 PDF 链接...\n",
                })
            else:
                apply_payload = {
                    "files": [{"name": filename, "data_id": response_id, "is_ocr": is_ocr}],
                    "model_version": model_version,
                    "language": language,
                    "enable_formula": enable_formula,
                    "enable_table": enable_table,
                }
                apply_resp = await _mineru_request_with_retry(
                    lambda: client.post(
                        f"{MINERU_API_BASE}/file-urls/batch",
                        headers=headers,
                        json=apply_payload,
                    ),
                    label="apply-upload-url",
                    node_id=node_id,
                    response_id=response_id,
                )
                apply_data = _mineru_response_json(apply_resp)
                if apply_resp.status_code >= 400 or not _mineru_success(apply_data):
                    raise RuntimeError(_mineru_error_message(apply_data, f"申请上传链接失败: HTTP {apply_resp.status_code}"))
                batch_id = apply_data["data"]["batch_id"]
                task_ref = batch_id
                log.info(
                    "mineru-import: submitted node=%s response=%s mode=upload batch=%s http_status=%s endpoint=/file-urls/batch",
                    node_id, response_id, batch_id, apply_resp.status_code,
                )
                upload_url = (apply_data["data"].get("file_urls") or [None])[0]
                if not upload_url:
                    raise RuntimeError("MinerU 未返回上传链接")

                await _qput("thinking", {
                    "node_id": node_id,
                    "model_id": MINERU_MODEL_ID,
                    "content": "上传 PDF 到 MinerU...\n",
                })
                upload_resp = await _mineru_request_with_retry(
                    lambda: client.put(upload_url, content=pdf_bytes),
                    label="upload-pdf",
                    node_id=node_id,
                    response_id=response_id,
                )
                if upload_resp.status_code >= 300:
                    raise RuntimeError(f"上传 PDF 失败: HTTP {upload_resp.status_code}")
                log.info(
                    "mineru-import: uploaded node=%s response=%s batch=%s bytes=%d http_status=%s",
                    node_id, response_id, batch_id, len(pdf_bytes), upload_resp.status_code,
                )

            deadline = time.time() + MINERU_POLL_TIMEOUT_SECONDS
            last_state = ""
            result_item = None
            while time.time() < deadline:
                await asyncio.sleep(MINERU_POLL_INTERVAL_SECONDS)
                if task_id:
                    poll_resp = await _mineru_request_with_retry(
                        lambda: client.get(
                            f"{MINERU_API_BASE}/extract/task/{task_id}",
                            headers=headers,
                        ),
                        label="poll-url-task",
                        node_id=node_id,
                        response_id=response_id,
                    )
                else:
                    poll_resp = await _mineru_request_with_retry(
                        lambda: client.get(
                            f"{MINERU_API_BASE}/extract-results/batch/{batch_id}",
                            headers=headers,
                        ),
                        label="poll-upload-task",
                        node_id=node_id,
                        response_id=response_id,
                    )
                poll_data = _mineru_response_json(poll_resp)
                if poll_resp.status_code >= 400 or not _mineru_success(poll_data):
                    raise RuntimeError(_mineru_error_message(poll_data, f"查询解析结果失败: HTTP {poll_resp.status_code}"))

                if task_id:
                    result_item = poll_data.get("data") or {}
                else:
                    results = poll_data.get("data", {}).get("extract_result") or []
                    result_item = results[0] if results else None
                state = (result_item or {}).get("state", "pending")
                progress = (result_item or {}).get("extract_progress") or {}
                if state != last_state or progress:
                    log.info(
                        "mineru-import: poll node=%s response=%s mode=%s task_ref=%s state=%s progress=%s",
                        node_id, response_id, input_mode, task_ref, state, progress or {},
                    )
                    if progress.get("total_pages"):
                        status_text = f"MinerU {state}: {progress.get('extracted_pages', 0)}/{progress.get('total_pages')} 页\n"
                    else:
                        status_text = f"MinerU {state}...\n"
                    await _qput("thinking", {
                        "node_id": node_id,
                        "model_id": MINERU_MODEL_ID,
                        "content": status_text,
                    })
                    last_state = state

                if state == "failed":
                    raise RuntimeError((result_item or {}).get("err_msg") or "MinerU 解析失败")
                if state == "done":
                    break
            else:
                raise TimeoutError("MinerU 解析超时")

            full_zip_url = (result_item or {}).get("full_zip_url")
            if not full_zip_url:
                raise RuntimeError("MinerU 完成但未返回 full_zip_url")
            log.info(
                "mineru-import: done node=%s response=%s mode=%s task_ref=%s zip=%s",
                node_id, response_id, input_mode, task_ref, _redact_url_for_log(full_zip_url),
            )

            await _qput("thinking", {
                "node_id": node_id,
                "model_id": MINERU_MODEL_ID,
                "content": "下载并读取 Markdown...\n",
            })
            zip_resp = await _mineru_request_with_retry(
                lambda: client.get(full_zip_url),
                label="download-result-zip",
                node_id=node_id,
                response_id=response_id,
            )
            zip_resp.raise_for_status()
            log.info(
                "mineru-import: downloaded zip node=%s response=%s mode=%s task_ref=%s bytes=%d",
                node_id, response_id, input_mode, task_ref, len(zip_resp.content),
            )
            markdown, asset_count = _extract_full_markdown_bundle_from_zip(
                zip_resp.content,
                response_id=response_id,
                user_id=user_id,
            )
            log.info(
                "mineru-import: extracted bundle node=%s response=%s markdown_chars=%d asset_count=%d",
                node_id, response_id, len(markdown), asset_count,
            )

        tokens_input = _estimate_mineru_input_tokens(pdf_bytes) if pdf_bytes else _estimate_mineru_url_input_tokens(pdf_url or "")
        tokens_output = _estimate_tokens(markdown)
        db.increment_setting_ints({
            MINERU_USAGE_CALLS_SETTING: 1,
            MINERU_USAGE_INPUT_SETTING: tokens_input,
            MINERU_USAGE_OUTPUT_SETTING: tokens_output,
        }, user_id=user_id)
        db.update_response(
            response_id,
            user_id=user_id,
            content=markdown,
            status="completed",
            tokens_input=tokens_input,
            tokens_output=tokens_output,
            latency_ms=int((time.time() - t0) * 1000),
            finish_reason="stop",
            meta={
                "source": "mineru",
                "filename": filename,
                "source_url": pdf_url,
                "model_version": model_version,
                "full_zip_url": full_zip_url,
                "asset_storage": "local",
                "asset_base": f"/api/responses/{response_id}/assets/",
                "asset_count": asset_count,
            },
        )
        for chunk in _iter_text_chunks(markdown, size=1200):
            await _qput("content", {
                "node_id": node_id,
                "model_id": MINERU_MODEL_ID,
                "content": chunk,
            })
            await asyncio.sleep(0)
        await _qput("model_done", {
            "node_id": node_id,
            "model_id": MINERU_MODEL_ID,
            "model_name": MINERU_MODEL_NAME,
            "response_id": response_id,
            "tokens_input": tokens_input,
            "tokens_output": tokens_output,
            "cost": 0,
            "latency_ms": int((time.time() - t0) * 1000),
        })
        log.info(
            "mineru-import: completed node=%s response=%s mode=%s tokens_in=%d tokens_out=%d assets=%d latency_ms=%d",
            node_id, response_id, input_mode, tokens_input, tokens_output, asset_count,
            int((time.time() - t0) * 1000),
        )
    except Exception as e:
        log.error(
            "mineru-import: failed node=%s response=%s mode=%s file=%s url=%s error=%s",
            node_id, response_id, input_mode, filename, _redact_url_for_log(pdf_url), e,
            exc_info=True,
        )
        db.update_response(
            response_id,
            user_id=user_id,
            status="error",
            meta={"error": str(e), "source": "mineru", "filename": filename},
        )
        await _qput("model_error", {
            "node_id": node_id,
            "model_id": MINERU_MODEL_ID,
            "model_name": MINERU_MODEL_NAME,
            "error": str(e),
        })
    finally:
        await _publish_stream_event(node_id, _sse("done", {"node_id": node_id}))
        await asyncio.sleep(60)
        async with _stream_channels_lock:
            channel = _stream_channels.get(node_id)
            if channel and channel.get("segment_id") == segment_id:
                _stream_channels.pop(node_id, None)


@router.post("/api/pdf/import/stream")
async def import_pdf_stream(
    request: Request,
    root_id: str = Query(""),
    parent_id: str = Query(""),
    relation: str = Query("progression"),
    card_content: str = Query(""),
):
    user_id = _get_user_id(request)
    api_key = db.get_setting("mineru_api_key", "", user_id=user_id).strip()
    if not api_key:
        return JSONResponse({"error": "请先在配置中填写 MinerU API Key"}, status_code=400)

    filename = Path(
        request.headers.get("x-filename")
        or request.query_params.get("filename")
        or "document.pdf"
    ).name
    if not filename.lower().endswith(".pdf"):
        return JSONResponse({"error": "仅支持 PDF 文件"}, status_code=400)

    pdf_bytes = await request.body()
    if not pdf_bytes:
        return JSONResponse({"error": "PDF 文件为空"}, status_code=400)

    root_id = root_id.strip() or None
    parent_id = parent_id.strip() or None
    if root_id and not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    if parent_id and not db.get_node(parent_id, user_id=user_id):
        return JSONResponse({"error": "父节点不存在"}, status_code=404)

    log.info(
        "mineru-import: request upload filename=%s bytes=%d root=%s parent=%s relation=%s",
        filename, len(pdf_bytes), root_id or "", parent_id or "", relation,
    )
    node, response, safe_relation = _create_pdf_import_node_response(
        root_id=root_id,
        parent_id=parent_id,
        relation=relation,
        card_content=card_content,
        filename=filename,
        user_id=user_id,
        source="mineru",
    )
    node_id = node["id"]

    history_start, segment_id = await _start_stream_segment(node_id)
    asyncio.create_task(_bg_mineru_pdf_import(
        node_id=node_id,
        response_id=response["id"],
        filename=filename,
        api_key=api_key,
        user_id=user_id,
        pdf_bytes=pdf_bytes,
        segment_id=segment_id,
    ))

    async def event_generator():
        yield _sse("node_created", {
            "root_id": node["root_id"],
            "node_id": node_id,
            "nut_id": None,
            "nut": None,
            "relation": safe_relation,
        })
        async for event_str in _subscribe_stream(node_id, history_start=history_start, user_id=user_id):
            yield event_str

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/api/pdf/import-url/stream")
async def import_pdf_url_stream(request: Request):
    user_id = _get_user_id(request)
    api_key = db.get_setting("mineru_api_key", "", user_id=user_id).strip()
    if not api_key:
        return JSONResponse({"error": "请先在配置中填写 MinerU API Key"}, status_code=400)

    data = await request.json()
    pdf_url = str(data.get("url") or "").strip()
    parsed = urlparse(pdf_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return JSONResponse({"error": "PDF 链接无效"}, status_code=400)

    filename = Path(str(data.get("filename") or _filename_from_pdf_url(pdf_url))).name
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    root_id = str(data.get("root_id") or "").strip() or None
    parent_id = str(data.get("parent_id") or "").strip() or None
    relation = str(data.get("relation") or "progression")
    card_content = str(data.get("card_content") or "")

    if root_id and not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    if parent_id and not db.get_node(parent_id, user_id=user_id):
        return JSONResponse({"error": "父节点不存在"}, status_code=404)

    log.info(
        "mineru-import: request url filename=%s url=%s root=%s parent=%s relation=%s",
        filename, _redact_url_for_log(pdf_url), root_id or "", parent_id or "", relation,
    )
    node, response, safe_relation = _create_pdf_import_node_response(
        root_id=root_id,
        parent_id=parent_id,
        relation=relation,
        card_content=card_content,
        filename=filename,
        user_id=user_id,
        source="mineru_url",
        source_url=pdf_url,
    )
    node_id = node["id"]

    history_start, segment_id = await _start_stream_segment(node_id)
    asyncio.create_task(_bg_mineru_pdf_import(
        node_id=node_id,
        response_id=response["id"],
        filename=filename,
        api_key=api_key,
        user_id=user_id,
        pdf_url=pdf_url,
        segment_id=segment_id,
    ))

    async def event_generator():
        yield _sse("node_created", {
            "root_id": node["root_id"],
            "node_id": node_id,
            "nut_id": None,
            "nut": None,
            "relation": safe_relation,
        })
        async for event_str in _subscribe_stream(node_id, history_start=history_start, user_id=user_id):
            yield event_str

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/api/markdown/import/stream")
async def import_markdown_stream(
    request: Request,
    root_id: str = Query(""),
    parent_id: str = Query(""),
    relation: str = Query("progression"),
    card_content: str = Query(""),
):
    user_id = _get_user_id(request)
    filename = Path(
        request.headers.get("x-filename")
        or request.query_params.get("filename")
        or "document.md"
    ).name
    if not filename.lower().endswith((".md", ".markdown")):
        return JSONResponse({"error": "仅支持 Markdown 文件"}, status_code=400)

    markdown_bytes = await request.body()
    if not markdown_bytes:
        return JSONResponse({"error": "Markdown 文件为空"}, status_code=400)
    try:
        markdown = markdown_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        return JSONResponse({"error": "Markdown 文件需要使用 UTF-8 编码"}, status_code=400)

    root_id = root_id.strip() or None
    parent_id = parent_id.strip() or None
    if root_id and not db.get_root(root_id, user_id=user_id):
        return JSONResponse({"error": "根节点不存在"}, status_code=404)
    if parent_id and not db.get_node(parent_id, user_id=user_id):
        return JSONResponse({"error": "父节点不存在"}, status_code=404)

    safe_relation = relation if relation in {"progression", "followup"} else "progression"
    default_content = f"阅读 Markdown：{filename}" if _get_user_language(user_id) != "en" else f"Read Markdown: {filename}"
    node_content = card_content.strip()[:1000] or default_content
    node_kwargs = {
        "relation": safe_relation,
        "meta": {"kind": "markdown_import", "filename": filename, "source": "upload", "card_content": node_content},
    }
    if parent_id:
        node_kwargs["parent_id"] = parent_id
        node_kwargs["parent_model_id"] = MARKDOWN_MODEL_ID

    t0 = time.time()
    tokens_input = max(1, len(markdown_bytes) // MINERU_INPUT_BYTES_PER_TOKEN)
    tokens_output = _estimate_tokens(markdown)

    node = db.create_node(root_id, node_content, user_id=user_id, **node_kwargs)
    node_id = node["id"]
    response = db.create_response(
        node_id=node_id,
        model_id=MARKDOWN_MODEL_ID,
        content=markdown,
        user_id=user_id,
        status="completed",
        tokens_input=tokens_input,
        tokens_output=tokens_output,
        latency_ms=int((time.time() - t0) * 1000),
        finish_reason="stop",
        meta={"source": "upload", "filename": filename},
    )
    _mark_root_summary_dirty_if_shallow_node(node_id, user_id=user_id)

    async def event_generator():
        yield _sse("node_created", {
            "root_id": node["root_id"],
            "node_id": node_id,
            "nut_id": None,
            "nut": None,
            "relation": safe_relation,
        })
        yield _sse("model_start", {
            "node_id": node_id,
            "model_id": MARKDOWN_MODEL_ID,
            "model_name": MARKDOWN_MODEL_NAME,
        })
        for chunk in _iter_text_chunks(markdown, size=400):
            yield _sse("content", {
                "node_id": node_id,
                "model_id": MARKDOWN_MODEL_ID,
                "content": chunk,
            })
            await asyncio.sleep(0)
        yield _sse("model_done", {
            "node_id": node_id,
            "model_id": MARKDOWN_MODEL_ID,
            "model_name": MARKDOWN_MODEL_NAME,
            "response_id": response["id"],
            "tokens_input": tokens_input,
            "tokens_output": tokens_output,
            "cost": 0,
            "latency_ms": response.get("latency_ms") or 0,
        })
        yield _sse("done", {"node_id": node_id})

    return StreamingResponse(event_generator(), media_type="text/event-stream")


