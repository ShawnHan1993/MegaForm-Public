from app_state import EMAIL_RE, _normalize_locale, authn, db, httpx, log, os
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

router = APIRouter()

@router.get("/api/me")
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


@router.post("/api/me/locale")
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


@router.post("/api/auth/register")
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


@router.post("/api/auth/login")
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


@router.post("/api/auth/logout")
def logout(request: Request):
    response = JSONResponse({"status": "ok"})
    if not authn.is_local_mode():
        token = authn.get_request_token(request)
        if token:
            db.delete_session_by_token_hash(authn.hash_token(token))
    authn.clear_session_cookie(response)
    return response


@router.post("/api/auth/logout-all")
def logout_all(request: Request):
    user = authn.get_current_user_optional(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    count = 0 if authn.is_local_mode() else db.delete_user_sessions(user["id"])
    response = JSONResponse({"status": "ok", "revoked_sessions": count})
    authn.clear_session_cookie(response)
    return response


@router.get("/api/auth/google/start")
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


@router.get("/api/auth/google/callback")
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
