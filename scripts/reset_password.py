#!/usr/bin/env python3
"""
Recuperación local de contraseña para Diario RPG.

Requiere acceso físico o SSH al equipo donde vive la base de datos.
Uso:
    .venv/bin/python scripts/reset_password.py <usuario>
"""

import getpass
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.storage.database import init_db
from backend.services import auth


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: .venv/bin/python scripts/reset_password.py <usuario>")
        return 2

    init_db()
    username = sys.argv[1].strip()
    user = auth.get_user_by_username(username)
    if not user:
        print(f"No existe una cuenta con el usuario «{username}».")
        return 1

    print(f"Cuenta: @{user['username']} ({user['display_name']}) · rol {user['role']}")
    password = getpass.getpass("Nueva contraseña: ")
    confirm = getpass.getpass("Repite la contraseña: ")
    if password != confirm:
        print("Las contraseñas no coinciden.")
        return 1

    try:
        auth.set_password(user["id"], password, must_change_password=True)
    except ValueError as exc:
        print(f"Contraseña no válida: {exc}")
        return 1

    auth.revoke_user_sessions(user["id"])
    print("Contraseña actualizada. Se cerraron todas las sesiones de esa cuenta.")
    print("Al entrar, el usuario deberá establecer una contraseña nueva.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
