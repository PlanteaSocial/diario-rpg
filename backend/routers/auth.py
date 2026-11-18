"""Rutas de autenticación, cuenta y administración de usuarios."""

from __future__ import annotations

import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

import backend.config as config
from backend.deps import get_current_user, require_admin
from backend.services import auth
from backend.services import security as sec

router = APIRouter(prefix="/api", tags=["auth"])


class SetupRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    display_name: str = Field(..., min_length=1, max_length=60)
    password: str = Field(..., min_length=10, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=128)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=10, max_length=128)


class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    display_name: str = Field(..., min_length=1, max_length=60)
    password: str = Field(..., min_length=10, max_length=128)
    role: str = Field(default="user", pattern="^(admin|user)$")


class UserUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=60)
    role: Optional[str] = Field(default=None, pattern="^(admin|user)$")
    is_active: Optional[bool] = None


class ResetPasswordRequest(BaseModel):
    new_password: Optional[str] = Field(default=None, min_length=10, max_length=128)


def _is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    return request.url.scheme == "https" or (config.TRUST_PROXY and forwarded == "https")


def _cookie_samesite(request: Request) -> str:
    if config.COOKIE_SAMESITE == "none" and _is_https(request):
        return "none"
    return "strict" if config.COOKIE_SAMESITE == "strict" else "lax"


def _set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=sec.SESSION_COOKIE,
        value=token,
        max_age=int(sec.SESSION_TTL.total_seconds()),
        httponly=True,
        samesite=_cookie_samesite(request),
        secure=_is_https(request),
        path="/",
    )


def _clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=sec.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite=_cookie_samesite(request),
        secure=_is_https(request),
    )


def _client_ip(request: Request) -> str:
    host = (request.client.host if request.client else "") or "local"
    # Solo se confía en X-Forwarded-For cuando hay un proxy de confianza o local.
    if config.TRUST_PROXY or host in ("127.0.0.1", "::1"):
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return host


def _require_local_setup(request: Request) -> None:
    """El primer administrador solo puede crearse desde el propio equipo."""
    host = (request.client.host if request.client else "") or ""
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if host not in ("127.0.0.1", "::1", "localhost") or (
        forwarded and forwarded not in ("127.0.0.1", "::1")
    ):
        raise HTTPException(
            status_code=403,
            detail="La configuración inicial debe hacerse desde el equipo donde corre el diario.",
        )


# ---------------------------------------------------------------------------
# Estado de sesión y primer arranque
# ---------------------------------------------------------------------------

@router.get("/auth/status")
def auth_status(request: Request):
    setup_required = auth.count_users() == 0
    token = request.cookies.get(sec.SESSION_COOKIE)
    user = auth.resolve_session(token)
    return {
        "setup_required": setup_required,
        "authenticated": bool(user),
        "user": user,
        "auth_mode": config.AUTH_MODE,
    }


@router.post("/auth/setup")
def setup_first_admin(payload: SetupRequest, request: Request, response: Response):
    _require_local_setup(request)
    if auth.count_users() > 0:
        raise HTTPException(status_code=409, detail="La configuración inicial ya se completó.")

    try:
        user = auth.create_user(
            username=payload.username,
            display_name=payload.display_name,
            password=payload.password,
            role="admin",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Los datos previos de una instalación de una sola persona pasan a esta cuenta.
    auth.adopt_legacy_data(user["id"])

    token = auth.create_session(
        user["id"], ip=_client_ip(request), user_agent=request.headers.get("user-agent")
    )
    _set_session_cookie(response, request, token)
    return {"user": user, "setup_completed": True}


@router.post("/auth/login")
def login(payload: LoginRequest, request: Request, response: Response):
    ip = _client_ip(request)
    retry = auth.check_ip_rate(ip)
    if retry:
        raise HTTPException(
            status_code=429,
            detail=f"Demasiados intentos. Espera {retry} segundos.",
            headers={"Retry-After": str(retry)},
        )

    auth.record_ip_attempt(ip)
    user, reason, lock_seconds = auth.authenticate(payload.username, payload.password)

    if not user:
        if reason == "locked":
            raise HTTPException(
                status_code=429,
                detail=f"Demasiados intentos fallidos. Espera {lock_seconds} segundos.",
                headers={"Retry-After": str(lock_seconds or 60)},
            )
        # Mismo mensaje para usuario inexistente, contraseña incorrecta o cuenta inactiva.
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos.")

    auth.clear_ip_attempts(ip)
    token = auth.create_session(
        user["id"], ip=ip, user_agent=request.headers.get("user-agent")
    )
    _set_session_cookie(response, request, token)
    return {"user": user}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    auth.revoke_session(request.cookies.get(sec.SESSION_COOKIE))
    _clear_session_cookie(response, request)
    return {"ok": True}


@router.get("/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {"user": user}


@router.post("/auth/password")
def change_own_password(
    payload: PasswordChangeRequest,
    request: Request,
    response: Response,
    user: dict = Depends(get_current_user),
):
    row = auth.get_user_by_id(user["id"])
    if not row:
        raise HTTPException(status_code=401, detail="Sesión no válida.")

    valid, _ = sec.verify_password(payload.current_password, row["password_hash"])
    if not valid:
        raise HTTPException(status_code=400, detail="La contraseña actual no es correcta.")

    try:
        auth.set_password(user["id"], payload.new_password, must_change_password=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Cierra las demás sesiones y renueva la de este dispositivo.
    auth.revoke_user_sessions(user["id"])
    token = auth.create_session(
        user["id"], ip=_client_ip(request), user_agent=request.headers.get("user-agent")
    )
    _set_session_cookie(response, request, token)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Administración de usuarios
# ---------------------------------------------------------------------------

@router.get("/users")
def list_users(admin: dict = Depends(require_admin)):
    return {"users": auth.list_users()}


@router.post("/users")
def create_user(payload: UserCreateRequest, admin: dict = Depends(require_admin)):
    try:
        user = auth.create_user(
            username=payload.username,
            display_name=payload.display_name,
            password=payload.password,
            role=payload.role,
            must_change_password=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": user}


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    admin: dict = Depends(require_admin),
):
    if user_id == admin["id"] and payload.is_active is False:
        raise HTTPException(status_code=400, detail="No puedes desactivar tu propia cuenta.")
    if user_id == admin["id"] and payload.role == "user":
        raise HTTPException(status_code=400, detail="No puedes quitarte el rol de administrador.")

    try:
        user = auth.update_user(
            user_id,
            display_name=payload.display_name,
            role=payload.role,
            is_active=payload.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": user}


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    payload: ResetPasswordRequest,
    admin: dict = Depends(require_admin),
):
    target = auth.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")

    temp_password = payload.new_password
    generated = False
    if not temp_password:
        temp_password = f"Diario-{secrets.token_urlsafe(9)}7"
        generated = True

    try:
        auth.set_password(user_id, temp_password, must_change_password=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    auth.revoke_user_sessions(user_id)
    return {
        "ok": True,
        "user_id": user_id,
        "temp_password": temp_password,
        "generated": generated,
    }
