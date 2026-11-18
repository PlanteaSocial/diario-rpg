"""
Servicio de autenticación y gestión de usuarios (local-first).

- Contraseñas con Argon2id/PBKDF2 (nunca en claro).
- Sesiones opacas: cookie con token aleatorio; en SQLite solo el SHA-256.
- Bloqueo temporal por cuenta y límite de intentos por IP (con poda de memoria).
- Aislamiento de datos por user_id en todas las tablas del diario.
"""

from __future__ import annotations

from datetime import timedelta
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.services import security as sec
from backend.storage.database import db_connection

SCOPED_TABLES = (
    "quick_notes",
    "day_entries",
    "user_feedback",
    "self_assessments",
    "learning_progress",
    "hlr_memory",
    "therapy_notebook",
    "user_profile",
)

MAX_FAILED_ATTEMPTS = 5
ACCOUNT_LOCK_MINUTES = 15
MAX_SESSIONS_PER_USER = 10
_IP_MAX_KEYS = 2048

_IP_ATTEMPTS: Dict[str, List[float]] = {}
_IP_LOCK = threading.Lock()


def public_user(row: Any) -> Dict[str, Any]:
    """Convierte una fila de users en un dict sin datos sensibles."""
    return {
        "id": int(row["id"]),
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "is_active": bool(row["is_active"]),
        "must_change_password": bool(row["must_change_password"]),
        "created_at": row["created_at"],
        "last_login_at": row["last_login_at"],
    }


def _fetch_user(where: str, params: Tuple[Any, ...]) -> Optional[Any]:
    with db_connection() as conn:
        return conn.execute(f"SELECT * FROM users WHERE {where}", params).fetchone()


def count_users() -> int:
    with db_connection() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])


def count_admins() -> int:
    with db_connection() as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
            ).fetchone()[0]
        )


def get_user_by_username(username: str) -> Optional[Any]:
    return _fetch_user("username = ? COLLATE NOCASE", ((username or "").strip(),))


def get_user_by_id(user_id: int) -> Optional[Any]:
    return _fetch_user("id = ?", (int(user_id),))


def list_users() -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY created_at ASC, id ASC"
        ).fetchall()
        return [public_user(row) for row in rows]


def create_user(
    username: str,
    display_name: str,
    password: str,
    role: str = "user",
    must_change_password: bool = False,
) -> Dict[str, Any]:
    username = sec.validate_username(username)
    display_name = sec.validate_display_name(display_name)
    sec.validate_password(password, username=username)
    if role not in ("admin", "user"):
        raise ValueError("Rol no válido.")

    now = sec.iso(sec.utcnow())
    password_hash = sec.hash_password(password)
    try:
        with db_connection(commit=True) as conn:
            existing = conn.execute(
                "SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,)
            ).fetchone()
            if existing:
                raise ValueError("Ese nombre de usuario ya existe.")
            cursor = conn.execute(
                """
                INSERT INTO users
                    (username, display_name, password_hash, role, is_active,
                     must_change_password, failed_attempts, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)
                """,
                (
                    username,
                    display_name,
                    password_hash,
                    role,
                    1 if must_change_password else 0,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return public_user(row)
    except sqlite3.IntegrityError as exc:
        raise ValueError("Ese nombre de usuario ya existe.") from exc


def update_user(
    user_id: int,
    display_name: Optional[str] = None,
    role: Optional[str] = None,
    is_active: Optional[bool] = None,
) -> Dict[str, Any]:
    with db_connection(commit=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (int(user_id),)
        ).fetchone()
        if not row:
            raise ValueError("Usuario no encontrado.")

        if role is not None and role not in ("admin", "user"):
            raise ValueError("Rol no válido.")

        active_admins = int(
            conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
            ).fetchone()[0]
        )
        if role == "user" and row["role"] == "admin" and active_admins <= 1:
            raise ValueError("Debe existir al menos un administrador activo.")
        if is_active is False and row["role"] == "admin" and active_admins <= 1:
            raise ValueError("No puedes desactivar al último administrador.")

        new_display = (
            sec.validate_display_name(display_name)
            if display_name is not None
            else row["display_name"]
        )
        new_role = role if role is not None else row["role"]
        new_active = int(is_active) if is_active is not None else int(row["is_active"])
        now = sec.iso(sec.utcnow())

        conn.execute(
            """
            UPDATE users
            SET display_name = ?, role = ?, is_active = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_display, new_role, new_active, now, int(user_id)),
        )
        if is_active is False:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(user_id),))
        updated = conn.execute(
            "SELECT * FROM users WHERE id = ?", (int(user_id),)
        ).fetchone()
        return public_user(updated)


def set_password(
    user_id: int, password: str, must_change_password: bool = False
) -> None:
    user = get_user_by_id(user_id)
    if not user:
        raise ValueError("Usuario no encontrado.")
    sec.validate_password(password, username=user["username"])
    now = sec.iso(sec.utcnow())
    password_hash = sec.hash_password(password)
    with db_connection(commit=True) as conn:
        conn.execute(
            """
            UPDATE users
            SET password_hash = ?, must_change_password = ?,
                failed_attempts = 0, locked_until = NULL, updated_at = ?
            WHERE id = ?
            """,
            (password_hash, 1 if must_change_password else 0, now, int(user_id)),
        )


# ---------------------------------------------------------------------------
# Intentos fallidos y bloqueo
# ---------------------------------------------------------------------------

def _client_ip(ip: Optional[str]) -> str:
    return (ip or "local").strip() or "local"


def _prune_ip_attempts_locked(now: float, window: int) -> None:
    stale_keys = [
        k
        for k, timestamps in _IP_ATTEMPTS.items()
        if not any(now - t < window for t in timestamps)
    ]
    for k in stale_keys:
        _IP_ATTEMPTS.pop(k, None)
    if len(_IP_ATTEMPTS) > _IP_MAX_KEYS:
        # Evict oldest keys if still above cap
        overflow = len(_IP_ATTEMPTS) - _IP_MAX_KEYS
        for k in list(_IP_ATTEMPTS.keys())[:overflow]:
            _IP_ATTEMPTS.pop(k, None)


def check_ip_rate(ip: Optional[str], limit: int = 20, window: int = 600) -> Optional[int]:
    """Devuelve segundos de espera si la IP superó el límite, o None."""
    key = _client_ip(ip)
    now = time.time()
    with _IP_LOCK:
        if len(_IP_ATTEMPTS) > 128:
            _prune_ip_attempts_locked(now, window)
        attempts = [t for t in _IP_ATTEMPTS.get(key, []) if now - t < window]
        if attempts:
            _IP_ATTEMPTS[key] = attempts
        else:
            _IP_ATTEMPTS.pop(key, None)
        if len(attempts) >= limit:
            return max(1, int(window - (now - attempts[0])))
    return None


def record_ip_attempt(ip: Optional[str], window: int = 600) -> None:
    key = _client_ip(ip)
    now = time.time()
    with _IP_LOCK:
        if len(_IP_ATTEMPTS) >= _IP_MAX_KEYS:
            _prune_ip_attempts_locked(now, window)
        _IP_ATTEMPTS.setdefault(key, []).append(now)


def clear_ip_attempts(ip: Optional[str]) -> None:
    with _IP_LOCK:
        _IP_ATTEMPTS.pop(_client_ip(ip), None)


def authenticate(
    username: str, password: str
) -> Tuple[Optional[Dict[str, Any]], str, Optional[int]]:
    """Autentica. Devuelve (usuario, motivo, segundos_de_bloqueo)."""
    user = get_user_by_username(username)
    if not user:
        sec.dummy_verify(password)
        return None, "invalid", None

    locked_until = sec.parse_iso(user["locked_until"])
    now = sec.utcnow()
    if locked_until and locked_until > now:
        return None, "locked", max(1, int((locked_until - now).total_seconds()))

    valid, needs_rehash = sec.verify_password(password, user["password_hash"])
    if not valid:
        attempts = int(user["failed_attempts"] or 0) + 1
        lock_value = None
        if attempts >= MAX_FAILED_ATTEMPTS:
            lock_value = sec.iso(now + timedelta(minutes=ACCOUNT_LOCK_MINUTES))
        with db_connection(commit=True) as conn:
            conn.execute(
                "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
                (attempts, lock_value, user["id"]),
            )
        if lock_value:
            return None, "locked", ACCOUNT_LOCK_MINUTES * 60
        return None, "invalid", None

    if not bool(user["is_active"]):
        return None, "inactive", None

    now_iso = sec.iso(now)
    new_hash = sec.hash_password(password) if needs_rehash else None
    with db_connection(commit=True) as conn:
        if new_hash is not None:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (new_hash, user["id"]),
            )
        conn.execute(
            """
            UPDATE users
            SET failed_attempts = 0, locked_until = NULL,
                last_login_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (now_iso, now_iso, user["id"]),
        )
        fresh = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        return public_user(fresh), "ok", None


# ---------------------------------------------------------------------------
# Sesiones
# ---------------------------------------------------------------------------

def cleanup_expired_sessions() -> None:
    with db_connection(commit=True) as conn:
        conn.execute(
            "DELETE FROM sessions WHERE expires_at <= ?", (sec.iso(sec.utcnow()),)
        )


def create_session(
    user_id: int, ip: Optional[str] = None, user_agent: Optional[str] = None
) -> str:
    token, token_hash = sec.new_session_token()
    now = sec.utcnow()
    now_iso = sec.iso(now)
    with db_connection(commit=True) as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso,))
        # Limita el número de sesiones activas por usuario.
        rows = conn.execute(
            "SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
            (int(user_id),),
        ).fetchall()
        for old in rows[MAX_SESSIONS_PER_USER - 1:]:
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (old["token_hash"],)
            )

        conn.execute(
            """
            INSERT INTO sessions
                (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                token_hash,
                int(user_id),
                now_iso,
                sec.iso(now + sec.SESSION_TTL),
                now_iso,
                (ip or "")[:64],
                (user_agent or "")[:256],
            ),
        )
    return token


def resolve_session(token: Optional[str]) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    token_hash = sec.session_token_hash(token)
    with db_connection(commit=True) as conn:
        row = conn.execute(
            """
            SELECT u.*, s.expires_at AS session_expires_at, s.last_seen_at AS session_last_seen
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND u.is_active = 1
            """,
            (token_hash,),
        ).fetchone()
        if not row:
            return None

        expires = sec.parse_iso(row["session_expires_at"])
        now = sec.utcnow()
        if not expires or expires <= now:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return None

        last_seen = sec.parse_iso(row["session_last_seen"])
        if not last_seen or (now - last_seen) > timedelta(minutes=5):
            conn.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (sec.iso(now), token_hash),
            )
        return public_user(row)


def revoke_session(token: Optional[str]) -> None:
    if not token:
        return
    with db_connection(commit=True) as conn:
        conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?",
            (sec.session_token_hash(token),),
        )


def revoke_user_sessions(
    user_id: int, keep_token_hash: Optional[str] = None
) -> None:
    with db_connection(commit=True) as conn:
        if keep_token_hash:
            conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                (int(user_id), keep_token_hash),
            )
        else:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(user_id),))


def adopt_legacy_data(user_id: int) -> None:
    """Asigna los datos previos (user_id = 0) al primer usuario creado."""
    with db_connection(commit=True) as conn:
        for table in SCOPED_TABLES:
            if table == "user_profile":
                conn.execute(
                    "UPDATE OR IGNORE user_profile SET user_id = ? WHERE user_id = 0",
                    (int(user_id),),
                )
                conn.execute("DELETE FROM user_profile WHERE user_id = 0")
            else:
                conn.execute(
                    f"UPDATE {table} SET user_id = ? WHERE user_id = 0",
                    (int(user_id),),
                )
