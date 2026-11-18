"""
Pruebas de integración de la API REST de FastAPI para Diario Inteligente.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.config as config
from backend.main import app
import backend.storage.database as database
from backend.services import auth as auth_service


class TestDiarioAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Base y feedback temporales: las pruebas no tocan data/diario.db ni train_feedback.jsonl
        cls._tmpdir = tempfile.TemporaryDirectory()
        cls._original_db = database.DB_PATH
        cls._original_feedback = config.TRAIN_FEEDBACK_PATH
        database.DB_PATH = Path(cls._tmpdir.name) / "test_api.db"
        config.TRAIN_FEEDBACK_PATH = Path(cls._tmpdir.name) / "test_feedback.jsonl"
        database.init_db()
        auth_service.create_user("tester", "Tester", "ClaveSegura2026", role="admin")
        cls.client = TestClient(app)
        login = cls.client.post(
            "/api/auth/login",
            json={"username": "tester", "password": "ClaveSegura2026"},
        )
        assert login.status_code == 200, login.text
        cls.test_date = "2026-11-16"

    @classmethod
    def tearDownClass(cls):
        database.DB_PATH = cls._original_db
        config.TRAIN_FEEDBACK_PATH = cls._original_feedback
        cls._tmpdir.cleanup()

    def test_status_endpoint(self):
        res = self.client.get("/api/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "online")
        self.assertIn("laya_model", data)
        self.assertIn("classifier", data)

    def test_static_and_relative_frontend_assets(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/css/style.css").status_code, 200)
        self.assertEqual(self.client.get("/js/api.js").status_code, 200)
        self.assertEqual(self.client.get("/static/js/api.js").status_code, 200)

    def test_quick_notes_flow(self):
        # 1. Crear nota rápida
        res = self.client.post("/api/quick-notes", json={
            "date": self.test_date,
            "time": "14:15",
            "text": "Pensamiento de prueba para la API"
        })
        self.assertEqual(res.status_code, 200)
        note = res.json()
        self.assertEqual(note["text"], "Pensamiento de prueba para la API")

        # 2. Listar notas del día
        res2 = self.client.get(f"/api/quick-notes?date={self.test_date}")
        self.assertEqual(res2.status_code, 200)
        notes = res2.json()
        self.assertTrue(len(notes) >= 1)

    def test_input_validation_guards(self):
        # Fecha inválida rechazada con 422
        bad_date = self.client.post("/api/quick-notes", json={
            "date": "2026-99-99",
            "time": "10:00",
            "text": "nota"
        })
        self.assertEqual(bad_date.status_code, 422)

        # Hora inválida rechazada con 422
        bad_time = self.client.post("/api/quick-notes", json={
            "date": self.test_date,
            "time": "25:99",
            "text": "nota"
        })
        self.assertEqual(bad_time.status_code, 422)

        # Valores fuera de catálogo en cuestionario rechazados con 422
        bad_q = self.client.post("/api/day-entry", json={
            "date": self.test_date,
            "day_text": "texto",
            "questionnaire": {
                "food_routine": "invalido",
                "self_report_word": "bien"
            }
        })
        self.assertEqual(bad_q.status_code, 422)

        # Límites negativos o excesivos en historial rechazados con 422
        self.assertEqual(self.client.get("/api/history?limit=-1").status_code, 422)
        self.assertEqual(self.client.get("/api/history?limit=9999").status_code, 422)

    def test_day_entry_save_and_retrieve(self):
        payload = {
            "date": self.test_date,
            "day_text": "Hoy fue un día de trabajo enfocado y pude avanzar mucho en mis tareas pendientes.",
            "questionnaire": {
                "sleep_bedtime": "23:00",
                "sleep_wakeup": "07:00",
                "food_routine": "si",
                "self_report_word": "bien",
                "valence_rating": 4,
                "energy_rating": 3,
                "workload_rating": 3
            }
        }
        res = self.client.post("/api/day-entry", json=payload)
        self.assertEqual(res.status_code, 200)
        entry = res.json()
        self.assertEqual(entry["date"], self.test_date)
        self.assertIsNotNone(entry["laya_profile"])

        # Recuperar por fecha
        res_get = self.client.get(f"/api/day-entry?date={self.test_date}")
        self.assertEqual(res_get.status_code, 200)
        entry_get = res_get.json()
        self.assertEqual(entry_get["date"], self.test_date)

    def test_feedback_endpoint(self):
        payload = {
            "date": self.test_date,
            "text_snippet": "Texto corregido",
            "question_id": "valencia_emocional",
            "original_value": "neutro",
            "corrected_value": "positivo",
            "notes": "Corrección manual por usuario"
        }
        res = self.client.post("/api/feedback", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertTrue(config.TRAIN_FEEDBACK_PATH.exists())

    def test_patterns_endpoint(self):
        res = self.client.get("/api/patterns")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("time_series", data)
        self.assertIn("baseline", data)
        self.assertIn("summary_text", data)

    def test_dev_mode_endpoints(self):
        # 1. Traza de desarrollo
        res_trace = self.client.get("/api/dev/trace")
        self.assertEqual(res_trace.status_code, 200)
        trace_data = res_trace.json()
        self.assertIn("active_laya_model", trace_data)
        self.assertIn("system_schema", trace_data)
        self.assertIn("questionnaire_weights_explanation", trace_data)

        # 2. Simulador Laya en vivo
        res_sim = self.client.post("/api/dev/simulate", json={
            "text": "Hoy me sentí muy motivado con los nuevos avances."
        })
        self.assertEqual(res_sim.status_code, 200)
        sim_data = res_sim.json()
        self.assertIn("latency_ms", sim_data)
        self.assertIn("raw_answers", sim_data)
        self.assertIn("valence_calculation", sim_data)


if __name__ == "__main__":
    unittest.main()
