"""
Authentication/session helpers for MegaForm.

Phase 1 keeps the business data single-tenant, but establishes a stable
current-user/session contract for the later user isolation migration.
"""

import hashlib
import hmac
import os
import secrets
import urllib.parse
from typing import Optional

from fastapi import HTTPException, Request, Response

import database as db

SESSION_COOKIE_NAME = os.environ.get("MEGAFORM_SESSION_COOKIE", "megaform_session")
DEFAULT_SESSION_DAYS = int(os.environ.get("MEGAFORM_SESSION_DAYS", "30"))
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
GOOGLE_SCOPES = "openid email profile"
PASSWORD_SCHEME = "pbkdf2_sha256"
PASSWORD_ITERATIONS = int(os.environ.get("MEGAFORM_PASSWORD_ITERATIONS", "260000"))


def get_auth_mode() -> str:
    mode = os.environ.get("MEGAFORM_AUTH_MODE", "local").strip().lower()
    return mode if mode in {"local", "oauth"} else "local"


def is_local_mode() -> bool:
    return get_auth_mode() == "local"


def email_auth_enabled() -> bool:
    return os.environ.get("MEGAFORM_EMAIL_AUTH", "true").strip().lower() != "false"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_urlsafe(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PASSWORD_ITERATIONS,
    ).hex()
    return f"{PASSWORD_SCHEME}${PASSWORD_ITERATIONS}${salt}${digest}"


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        scheme, iterations_raw, salt, expected = password_hash.split("$", 3)
        if scheme != PASSWORD_SCHEME:
            return False
        iterations = int(iterations_raw)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations,
        ).hex()
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user.get("email"),
        "display_name": user.get("display_name") or user["id"],
        "avatar_url": user.get("avatar_url") or "",
        "locale": user.get("locale") or "",
        "timezone": user.get("timezone") or "",
        "last_login_at": user.get("last_login_at"),
    }


def ensure_local_user() -> dict:
    user = db.ensure_local_user()
    db.touch_user_login(user["id"])
    return db.get_user(user["id"]) or user


def get_request_token(request: Request) -> str:
    return request.cookies.get(SESSION_COOKIE_NAME, "")


def get_current_user_optional(request: Request) -> Optional[dict]:
    if is_local_mode():
        return ensure_local_user()

    token = get_request_token(request)
    if not token:
        return None
    session = db.get_session_by_token_hash(hash_token(token))
    if not session:
        return None
    return {
        "id": session["user_id"],
        "email": session.get("email"),
        "display_name": session.get("display_name") or session["user_id"],
        "avatar_url": session.get("avatar_url") or "",
        "locale": session.get("locale") or "",
        "timezone": session.get("timezone") or "",
        "last_login_at": session.get("last_login_at"),
    }


def require_user(request: Request) -> dict:
    user = get_current_user_optional(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def attach_session_cookie(response: Response, token: str, *, days: int = DEFAULT_SESSION_DAYS) -> None:
    secure_cookie = os.environ.get("MEGAFORM_COOKIE_SECURE", "false").lower() == "true"
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=days * 24 * 60 * 60,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")


def create_session_for_user(user_id: str, response: Response, *, days: int = DEFAULT_SESSION_DAYS) -> str:
    token = new_session_token()
    db.create_session(user_id, hash_token(token), days=days)
    db.touch_user_login(user_id)
    attach_session_cookie(response, token, days=days)
    return token


def oauth_base_url(request: Request) -> str:
    configured = os.environ.get("MEGAFORM_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


def google_redirect_uri(request: Request) -> str:
    configured = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
    if configured:
        return configured
    return f"{oauth_base_url(request)}/api/auth/google/callback"


def google_oauth_configured() -> bool:
    return bool(
        os.environ.get("GOOGLE_CLIENT_ID", "").strip()
        and os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    )


def build_google_authorize_url(request: Request, state: str) -> str:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    params = {
        "client_id": client_id,
        "redirect_uri": google_redirect_uri(request),
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "state": state,
        "access_type": "offline",
        "prompt": "select_account",
    }
    return GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params)
