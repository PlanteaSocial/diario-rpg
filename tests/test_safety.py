"""
Pruebas para la capa de seguridad y cálculos deterministas de analítica.
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from datetime import datetime, timedelta, timezone
from backend.services.safety import evaluate_safety
from backend.services.analytics import (
    calculate_sleep_hours, detect_discrepancy, compute_streaks, execute_companion_action
)
from backend.models.schema import Questionnaire, LayaProfile, LayaCategoryResult, CompanionState

class TestSafetyAndAnalytics(unittest.TestCase):
    def test_safety_deterministic_alert(self):
        # Frase con señal de riesgo explícita
        risk_text = "Hoy no veo salida y he estado pensando en quitarme la vida."
        res = evaluate_safety(risk_text)
        self.assertTrue(res.is_triggered)
        self.assertEqual(res.level, "alert")
        self.assertTrue(len(res.helplines) >= 1)

    def test_safety_safe_text(self):
        normal_text = "Hoy trabajé bastante y luego salí a cenar unos tacos."
        res = evaluate_safety(normal_text)
        self.assertFalse(res.is_triggered)
        self.assertEqual(res.level, "safe")

    def test_sleep_hours_calculation(self):
        # Cruce normal de medianoche: 23:15 a 07:15 = 8.0 horas
        hours1 = calculate_sleep_hours("23:15", "07:15")
        self.assertEqual(hours1, 8.0)

        # Mismo día: 01:00 a 08:30 = 7.5 horas
        hours2 = calculate_sleep_hours("01:00", "08:30")
        self.assertEqual(hours2, 7.5)

    def test_discrepancy_detection(self):
        # Usuario dice "bien", pero Laya detecta negativo predominante
        q = Questionnaire(self_report_word="bien", valence_rating=4)
        profile = LayaProfile(
            valencia_emocional=LayaCategoryResult(
                choice="muy_negativo",
                probabilities={"muy_negativo": 0.85, "negativo": 0.10, "neutro": 0.05, "positivo": 0.0, "muy_positivo": 0.0},
                answer_confidence=0.85
            ),
            activacion_energia=LayaCategoryResult(choice="agotamiento_baja", probabilities={"agotamiento_baja": 1.0}),
            emocion_primaria=LayaCategoryResult(choice="tristeza", probabilities={"tristeza": 1.0}),
            ejes_tematicos={},
            senales_alerta={}
        )
        disc = detect_discrepancy(q, profile)
        self.assertTrue(disc.has_discrepancy)
        self.assertEqual(disc.level, "marked")

    def test_safety_accented_crisis_terms(self):
        for phrase in ("pensamientos de autolesión", "episodio de vómito inducido"):
            res = evaluate_safety(phrase)
            self.assertTrue(res.is_triggered, phrase)
            self.assertEqual(res.level, "alert")

    def test_companion_snack_timezone_compatibility(self):
        # Cooldown activo con timestamp UTC-aware
        recent_utc = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        comp = CompanionState(last_snack_at=recent_utc)
        updated, msg = execute_companion_action(comp, "snack")
        self.assertIn("Espera", msg)
        self.assertEqual(updated.satiety, comp.satiety)

        # Timestamp antiguo (naive) permite snack
        old_naive = (datetime.now() - timedelta(minutes=25)).replace(tzinfo=None).isoformat()
        comp2 = CompanionState(last_snack_at=old_naive)
        updated2, msg2 = execute_companion_action(comp2, "snack")
        self.assertIn("disfrutó", msg2)
        self.assertGreater(updated2.satiety, comp2.satiety)

if __name__ == "__main__":
    unittest.main()
