"""
Pruebas de seguridad: hashing, sesiones, primer arranque, aislamiento y CSRF.
Todas usan una base SQLite temporal.
"""

import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.config as config
import backend.storage.database as database
from backend.services import security as sec
from backend.storage.repository import SQLiteDiaryRepository
from backend.models.schema import QuickNoteCreate
from fastapi.testclient import TestClient
from backend.main import app


class TestSecurityPrimitives(unittest.TestCase):
    def test_password_hash_is_not_plaintext_and_verifies(self):
        stored = sec.hash_password("ClaveSegura2026")
        self.assertNotIn("ClaveSegura2026", stored)
        self.assertTrue(stored.startswith("$argon2") or stored.startswith("pbkdf2_sha256$"))
        ok, needs_rehash = sec.verify_password("ClaveSegura2026", stored)
        self.assertTrue(ok)
        self.assertFalse(needs_rehash)
        bad, _ = sec.verify_password("OtraClave2026", stored)
        self.assertFalse(bad)

    def test_password_policy_rejects_weak_values(self):
        for weak in ("corta1", "sinNumerosAqui", "1234567890", "password"):
            with self.assertRaises(ValueError):
                sec.validate_password(weak, username="juan")
        with self.assertRaises(ValueError):
            sec.validate_password("JuanSeguro2026", username="juan")
        sec.validate_password("BosqueTranquilo2026", username="juan")

    def test_session_tokens_are_random_and_hashed(self):
        t1, h1 = sec.new_session_token()
        t2, h2 = sec.new_session_token()
        self.assertNotEqual(t1, t2)
        self.assertNotEqual(h1, h2)
        self.assertEqual(h1, sec.session_token_hash(t1))
        self.assertNotIn(t1, h1)


class TestAuthAPI(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self._original_db = database.DB_PATH
        database.DB_PATH = Path(self.tmpdir.name) / "auth.db"
        database.init_db()
        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        database.DB_PATH = self._original_db
        self.tmpdir.cleanup()

    def _setup_admin(self):
        res = self.client.post(
            "/api/auth/setup",
            json={
                "username": "juan",
                "display_name": "Juan",
                "password": "DiarioSeguro2026",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["user"]

    def _login(self, username, password, client=None):
        client = client or self.client
        return client.post(
            "/api/auth/login", json={"username": username, "password": password}
        )

    def test_1_setup_adopts_legacy_data_and_requires_auth(self):
        # Dato previo a la migración multi-usuario.
        SQLiteDiaryRepository(user_id=0).save_quick_note(
            QuickNoteCreate(date="2026-11-01", time="08:00", text="nota heredada")
        )

        self.assertEqual(self.client.get("/api/history").status_code, 401)
        user = self._setup_admin()
        self.assertEqual(user["role"], "admin")
        self.assertTrue(user["must_change_password"] is False)

        notes = self.client.get("/api/quick-notes?date=2026-11-01").json()
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["text"], "nota heredada")

        # El setup ya no puede repetirse.
        again = self.client.post(
            "/api/auth/setup",
            json={"username": "otro", "display_name": "Otro", "password": "OtraClave2026"},
        )
        self.assertEqual(again.status_code, 409)

    def test_1b_setup_rejects_remote_clients(self):
        remote = TestClient(app, client=("10.0.0.5", 50002))
        res = remote.post(
            "/api/auth/setup",
            json={
                "username": "intruso",
                "display_name": "Intruso",
                "password": "IntrusoSeguro2026",
            },
        )
        self.assertEqual(res.status_code, 403)
        self.assertEqual(self.client.get("/api/auth/status").json()["setup_required"], True)

    def test_2_login_logout_and_cookie_flags(self):
        self._setup_admin()
        self.client.post("/api/auth/logout")
        res = self._login("juan", "DiarioSeguro2026")
        self.assertEqual(res.status_code, 200)
        cookie = res.headers.get("set-cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=lax", cookie)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)

        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)

    def test_3_user_isolation(self):
        self._setup_admin()
        res = self.client.post(
            "/api/users",
            json={
                "username": "ana",
                "display_name": "Ana",
                "password": "PaisajeSeguro2026",
                "role": "user",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)

        # Ana entra y debe cambiar la contraseña temporal.
        self.client.post("/api/auth/logout")
        login = self._login("ana", "PaisajeSeguro2026")
        self.assertTrue(login.json()["user"]["must_change_password"])
        self.assertEqual(self.client.get("/api/history").status_code, 403)
        change = self.client.post(
            "/api/auth/password",
            json={
                "current_password": "PaisajeSeguro2026",
                "new_password": "NuevaClave2026",
            },
        )
        self.assertEqual(change.status_code, 200, change.text)

        # Ana escribe una nota; Juan no debe verla.
        self.client.post(
            "/api/quick-notes",
            json={"date": "2026-11-02", "time": "10:00", "text": "nota de ana"},
        )
        self.assertEqual(len(self.client.get("/api/quick-notes?date=2026-11-02").json()), 1)

        self.client.post("/api/auth/logout")
        self._login("juan", "DiarioSeguro2026")
        self.assertEqual(self.client.get("/api/quick-notes?date=2026-11-02").json(), [])

    def test_4_admin_only_endpoints(self):
        self._setup_admin()
        self.client.post(
            "/api/users",
            json={
                "username": "ana",
                "display_name": "Ana",
                "password": "PaisajeSeguro2026",
                "role": "user",
            },
        )
        self.client.post("/api/auth/logout")
        self._login("ana", "PaisajeSeguro2026")
        self.client.post(
            "/api/auth/password",
            json={
                "current_password": "PaisajeSeguro2026",
                "new_password": "NuevaClave2026",
            },
        )
        self.assertEqual(self.client.get("/api/users").status_code, 403)
        self.assertEqual(self.client.get("/api/dev/trace").status_code, 403)
        self.assertEqual(self.client.post("/api/dev/simulate", json={"text": "hola"}).status_code, 403)
        self.assertEqual(self.client.post("/api/dev/reset-db").status_code, 403)
        self.assertEqual(self.client.post("/api/dev/simulate-week").status_code, 403)
        # Los usuarios sin rol admin no reciben rutas internas del servidor en /api/status.
        status_data = self.client.get("/api/status").json()
        self.assertEqual(status_data["database"], "sqlite-local")

    def test_5_csrf_origin_is_rejected_unless_allowlisted(self):
        self._setup_admin()
        res = self.client.post(
            "/api/quick-notes",
            json={"date": "2026-11-03", "time": "11:00", "text": "x"},
            headers={"Origin": "http://evil.example"},
        )
        self.assertEqual(res.status_code, 403)

        # Un origen explícitamente configurado en CORS_ORIGINS sí debe aceptarse.
        prev_origins = list(config.CORS_ORIGINS)
        config.CORS_ORIGINS = ["https://diario-rpg.web.app"]
        try:
            ok_res = self.client.post(
                "/api/quick-notes",
                json={"date": "2026-11-03", "time": "11:05", "text": "desde firebase"},
                headers={"Origin": "https://diario-rpg.web.app", "Sec-Fetch-Site": "cross-site"},
            )
            self.assertEqual(ok_res.status_code, 200)
        finally:
            config.CORS_ORIGINS = prev_origins

    def test_6_failed_logins_lock_the_account(self):
        self._setup_admin()
        self.client.post("/api/auth/logout")
        last = None
        for _ in range(5):
            last = self._login("juan", "ClaveIncorrecta2026")
        self.assertEqual(last.status_code, 429)
        # Incluso con la contraseña correcta sigue bloqueada.
        blocked = self._login("juan", "DiarioSeguro2026")
        self.assertEqual(blocked.status_code, 429)

    def test_7_password_change_revokes_other_sessions(self):
        self._setup_admin()
        other = TestClient(app, client=("127.0.0.1", 50001))
        self.assertEqual(self._login("juan", "DiarioSeguro2026", client=other).status_code, 200)
        self.assertEqual(other.get("/api/auth/me").status_code, 200)

        res = self.client.post(
            "/api/auth/password",
            json={
                "current_password": "DiarioSeguro2026",
                "new_password": "NuevaClaveSegura2026",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(other.get("/api/auth/me").status_code, 401)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)


if __name__ == "__main__":
    unittest.main()
