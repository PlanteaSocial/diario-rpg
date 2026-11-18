"""
Pruebas de integración para el Onboarding/Perfil de Metas, Autoevaluaciones No Clínicas,
Cruce Diario con Laya/Qwen y Filtros de Periodo en Patrones.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.main import app
import backend.storage.database as database
from backend.services import auth as auth_service


class TestOnboardingAndAssessments(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Base temporal: no modificar el diario real del usuario
        cls._tmpdir = tempfile.TemporaryDirectory()
        cls._original_db = database.DB_PATH
        database.DB_PATH = Path(cls._tmpdir.name) / "test_goals.db"
        database.init_db()
        auth_service.create_user("tester", "Tester", "ClaveSegura2026", role="admin")
        cls.client = TestClient(app)
        login = cls.client.post(
            "/api/auth/login",
            json={"username": "tester", "password": "ClaveSegura2026"},
        )
        assert login.status_code == 200, login.text

    @classmethod
    def tearDownClass(cls):
        database.DB_PATH = cls._original_db
        cls._tmpdir.cleanup()

    def test_1_profile_onboarding_and_radar(self):
        # Guardar preferencias completas de Onboarding
        payload = {
            "morning_habit": "celular",
            "habits_to_improve": ["dormir_tarde", "redes_sociales"],
            "sleep_improvement_goal": "dormir_mas_horas",
            "stress_areas": ["trabajo_estudio", "carga_mental"],
            "personal_objective": "limites_sanos",
            "daily_goal_level": "serio",
            "theme_mode": "dark",
            "onboarding_completed": True
        }
        res = self.client.put("/api/profile", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        profile = data["profile"]
        self.assertTrue(profile["onboarding_completed"])
        self.assertEqual(profile["daily_goal_minutes"], 15)
        self.assertEqual(profile["theme_mode"], "dark")

        radar = profile["radar_focus"]
        self.assertEqual(len(radar), 5)
        for axis in ["Descanso", "Límites", "Carga mental", "Constancia", "Manejo del estrés"]:
            self.assertIn(axis, radar)
            self.assertGreaterEqual(radar[axis], 40.0)

    def test_2_goal_cross_alignment_on_day_save(self):
        # Día con desvelo (01:30 a 06:30 = 5h) y carga laboral 5/5 frente a metas de descanso y límites
        payload = {
            "date": "2026-11-15",
            "day_text": "Tuve demasiados pendientes en el trabajo, mucha saturación mental y me dormí muy tarde.",
            "questionnaire": {
                "sleep_bedtime": "01:30",
                "sleep_wakeup": "06:30",
                "food_routine": "a_medias",
                "self_report_word": "regular",
                "valence_rating": 2,
                "energy_rating": 2,
                "workload_rating": 5
            }
        }
        res = self.client.post("/api/day-entry", json=payload)
        self.assertEqual(res.status_code, 200)
        entry = res.json()
        self.assertIsNotNone(entry.get("goal_alignment"))
        signals = entry["goal_alignment"]["signals"]
        self.assertTrue(len(signals) >= 2)
        areas = [s["area"] for s in signals]
        self.assertIn("Descanso", areas)
        self.assertIn("Límites y Carga", areas)

    def test_3_self_assessments_and_radar_impact(self):
        # Listar catálogo
        res_list = self.client.get("/api/assessments")
        self.assertEqual(res_list.status_code, 200)
        quizzes = res_list.json()["quizzes"]
        self.assertEqual(len(quizzes), 3)

        # Enviar evaluación de procrastinación
        res_sub = self.client.post("/api/assessments", json={
            "quiz_id": "procrastinacion",
            "answers": {"q1": 3, "q2": 4, "q3": 3, "q4": 3}
        })
        self.assertEqual(res_sub.status_code, 200)
        sub_data = res_sub.json()
        self.assertIn("assessment", sub_data)
        self.assertIn("personal_radar", sub_data)
        self.assertGreater(sub_data["assessment"]["score_pct"], 50.0)
        # Asegurar lenguaje estrictamente no clínico
        msg = sub_data["assessment"]["reflection_message"].lower()
        for forbidden in ["trastorno", "patología", "diagnóstico", "depresión"]:
            self.assertNotIn(forbidden, msg)

    def test_4_patterns_period_filter_and_radar(self):
        res = self.client.get("/api/patterns?days=7")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["period_days"], 7)
        self.assertIn("mood_distribution", data)
        self.assertIn("laya_axes_avg", data)
        self.assertIn("personal_radar", data)
        self.assertIn("goal_cross_insights", data)

    def test_5_companion_sanctuary_and_rewards(self):
        # 1. Consultar estado del santuario
        res_comp = self.client.get("/api/companion")
        self.assertEqual(res_comp.status_code, 200)
        comp_data = res_comp.json()
        self.assertIn("companion", comp_data)
        self.assertIn("shop_items", comp_data)
        coins_before = comp_data["companion"]["coins"]

        # 2. Acariciar al Slime
        res_pet = self.client.post("/api/companion/action", json={"action": "pet"})
        self.assertEqual(res_pet.status_code, 200)
        self.assertGreaterEqual(res_pet.json()["companion"]["mood"], comp_data["companion"]["mood"])

        # 3. Comprar un bocadillo en la tienda si hay monedas suficientes
        if coins_before >= 10:
            res_buy = self.client.post("/api/companion/action", json={"action": "buy", "value": "galleta_miel"})
            self.assertEqual(res_buy.status_code, 200)
            self.assertEqual(res_buy.json()["companion"]["coins"], coins_before - 10)
            # Alimentar al Slime con lo comprado
            res_feed = self.client.post("/api/companion/action", json={"action": "feed", "value": "galleta_miel"})
            self.assertEqual(res_feed.status_code, 200)
            self.assertGreaterEqual(res_feed.json()["companion"]["satiety"], comp_data["companion"]["satiety"])


if __name__ == "__main__":
    unittest.main()
