"""Dependencias compartidas de autenticación y repositorio por usuario."""

from fastapi import Depends, HTTPException, Request

from backend.storage.repository import BaseDiaryRepository, SQLiteDiaryRepository


def get_current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Sesión requerida.",
            headers={"WWW-Authenticate": "Cookie"},
        )
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=403, detail="Solo un administrador puede hacer esto."
        )
    return user


def get_repo(user: dict = Depends(get_current_user)) -> BaseDiaryRepository:
    return SQLiteDiaryRepository(user_id=int(user["id"]))
