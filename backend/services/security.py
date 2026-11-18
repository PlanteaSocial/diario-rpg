"""
Seguridad de autenticación para Diario RPG.

- Hash de contraseñas con Argon2id (recomendado) y respaldo PBKDF2-SHA256.
- Tokens de sesión aleatorios; solo se guarda su hash SHA-256 en SQLite.
- Política de contraseñas y utilidades de comparación en tiempo constante.

Nunca se registra ni se devuelve la contraseña en claro.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

try:  # Argon2id es el estándar recomendado para contraseñas.
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

    ARGON2_AVAILABLE = True
except Exception:  # pragma: no cover - entorno sin argon2
    PasswordHasher = None  # type: ignore
    ARGON2_AVAILABLE = False

ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST = 64 * 1024  # 64 MiB
ARGON2_PARALLELISM = 2
PBKDF2_ITERATIONS = 600_000

SESSION_COOKIE = "diario_session"
SESSION_TTL = timedelta(days=7)
PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 128

_hasher = (
    PasswordHasher(
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_COST,
        parallelism=ARGON2_PARALLELISM,
        hash_len=32,
        salt_len=16,
    )
    if ARGON2_AVAILABLE
    else None
)

COMMON_PASSWORDS = {
    "1234567890", "123456789", "password", "password1", "qwerty123",
    "contrasena", "contraseña", "diario123", "iloveyou", "admin123",
    "0000000000", "1111111111", "abc123456", "letmein123",
}

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$")


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def hash_password(password: str) -> str:
    """Genera un hash seguro con sal aleatoria."""
    if _hasher is not None:
        return _hasher.hash(password)
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64encode(salt)}${_b64encode(digest)}"


def verify_password(password: str, stored_hash: Optional[str]) -> Tuple[bool, bool]:
    """Verifica una contraseña. Devuelve (es_valida, necesita_rehash)."""
    if not stored_hash:
        return False, False

    if stored_hash.startswith("$argon2"):
        if _hasher is None:
            return False, False
        try:
            _hasher.verify(stored_hash, password)
            return True, _hasher.check_needs_rehash(stored_hash)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False, False
        except Exception:
            return False, False

    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            _, iterations, salt_b64, digest_b64 = stored_hash.split("$")
            salt = _b64decode(salt_b64)
            expected = _b64decode(digest_b64)
            actual = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, int(iterations)
            )
            valid = hmac.compare_digest(actual, expected)
            return valid, valid and int(iterations) < PBKDF2_ITERATIONS
        except Exception:
            return False, False

    return False, False


# Hash señuelo: iguala el tiempo de respuesta cuando el usuario no existe.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(24))


def dummy_verify(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


def new_session_token() -> Tuple[str, str]:
    """Devuelve (token en claro para la cookie, hash para guardar)."""
    token = secrets.token_urlsafe(32)
    return token, session_token_hash(token)


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def validate_username(username: str) -> str:
    value = (username or "").strip()
    if not USERNAME_RE.match(value):
        raise ValueError(
            "El usuario debe tener 3-32 caracteres: letras, números, punto, guion o guion bajo."
        )
    return value


def validate_display_name(name: str) -> str:
    value = " ".join((name or "").strip().split())
    if not (1 <= len(value) <= 60):
        raise ValueError("El nombre visible debe tener entre 1 y 60 caracteres.")
    return value


def validate_password(password: str, username: Optional[str] = None) -> None:
    if not isinstance(password, str):
        raise ValueError("La contraseña no es válida.")
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"La contraseña debe tener al menos {PASSWORD_MIN_LENGTH} caracteres.")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise ValueError(f"La contraseña no puede superar {PASSWORD_MAX_LENGTH} caracteres.")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise ValueError("La contraseña debe incluir al menos una letra y un número.")
    if password.lower() in COMMON_PASSWORDS:
        raise ValueError("Esa contraseña es demasiado común. Elige otra.")
    if username and username.lower() in password.lower():
        raise ValueError("La contraseña no debe contener tu nombre de usuario.")
