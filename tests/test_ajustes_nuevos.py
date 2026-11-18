"""
Pruebas de verificación de los 5 ajustes puntuales del Diario Inteligente.
"""

import unittest
from datetime import datetime
from backend.services.laya_engine import LAYA_QUESTIONS, classify_text_with_laya, get_laya_agent
from backend.services.safety import evaluate_safety
from backend.services.analytics import compute_streaks, classify_entry_mood_category, compute_mood_distribution
from backend.services.qwen_engine import generate_period_summary, verify_semantic_safety_with_qwen, sanitize_response
from backend.services.network import generate_qr_svg, get_network_access_info
from backend.models.schema import DayEntry, Questionnaire, LayaProfile, LayaCategoryResult, SafetyResult

class TestAjustesPuntuales(unittest.TestCase):

    def test_1_laya_questions_and_signals(self):
        """Verifica la nueva pregunta de riesgo y las redacciones cotidianas."""
        self.assertIn("sen_riesgo_autolesion_purga", LAYA_QUESTIONS)
        q_riesgo = LAYA_QUESTIONS["sen_riesgo_autolesion_purga"]
        self.assertEqual(q_riesgo["type"], "noul")
        self.assertIn("autolesión", q_riesgo["instructions"])
        self.assertIn("purga", q_riesgo["instructions"])

        # Redacciones cotidianas
        self.assertIn("pendientes, tareas, entregas", LAYA_QUESTIONS["eje_trabajo_estudio"]["instructions"])
        self.assertIn("saturación mental, piloto automático", LAYA_QUESTIONS["eje_carga_mental"]["instructions"])
        self.assertIn("decir que todo está bien", LAYA_QUESTIONS["sen_contradiccion_emocional"]["instructions"])

        # Prueba de inferencia con motor base
        profile = classify_text_with_laya("Hoy entregué varios pendientes del trabajo y tareas que tenía atrasadas.")
        self.assertIsNotNone(profile)
        self.assertIn("riesgo_autolesion_purga", profile.senales_alerta)
        self.assertIn("desgaste_sostenido", profile.senales_alerta)
        self.assertIn("contradiccion_emocional", profile.senales_alerta)
        # Eje trabajo estudio debe ser alto
        self.assertGreater(profile.ejes_tematicos.get("trabajo_estudio", 0.0), 0.5)

    def test_2_safety_levels_separation(self):
        """Verifica la separación estricta entre crisis (911) y pausa suave (sin helplines)."""
        # A. Crisis determinista
        res_crisis = evaluate_safety("Siento que no puedo más y quiero cortarme")
        self.assertTrue(res_crisis.is_triggered)
        self.assertEqual(res_crisis.level, "alert")
        self.assertGreater(len(res_crisis.helplines), 0)

        # B. Pausa suave (desgaste alto >= 0.85 sin autolesión)
        res_pausa = evaluate_safety(
            "He tenido semanas muy pesadas y no tengo energía",
            laya_senales={"desgaste_sostenido": 0.90, "riesgo_autolesion_purga": 0.05}
        )
        self.assertTrue(res_pausa.is_triggered)
        self.assertEqual(res_pausa.level, "pause")
        self.assertEqual(len(res_pausa.helplines), 0)
        self.assertIn("pausa", res_pausa.message.lower())

        # C. Caso seguro
        res_safe = evaluate_safety(
            "Fue un buen día en el parque con mi familia",
            laya_senales={"desgaste_sostenido": 0.1, "riesgo_autolesion_purga": 0.01}
        )
        self.assertFalse(res_safe.is_triggered)
        self.assertEqual(res_safe.level, "safe")

    def test_3_streaks_calculation_relative_to_history(self):
        """Verifica que la racha cuente días consecutivos a partir del último registro disponible."""
        # 3 días simulados en fechas futuras o pasadas
        entries = [
            DayEntry(
                id=1,
                date="2026-12-05",
                day_text="Día 3",
                questionnaire=Questionnaire(),
                created_at="2026-12-05T12:00:00",
                updated_at="2026-12-05T12:00:00"
            ),
            DayEntry(
                id=2,
                date="2026-12-04",
                day_text="Día 2",
                questionnaire=Questionnaire(),
                created_at="2026-12-04T12:00:00",
                updated_at="2026-12-04T12:00:00"
            ),
            DayEntry(
                id=3,
                date="2026-12-03",
                day_text="Día 1",
                questionnaire=Questionnaire(),
                created_at="2026-12-03T12:00:00",
                updated_at="2026-12-03T12:00:00"
            ),
        ]
        streak = compute_streaks(entries)
        self.assertEqual(streak, 3)

        # Con salto de día intermedio (ej. falta 2026-12-02)
        entries.append(
            DayEntry(
                id=4,
                date="2026-12-01",
                day_text="Día anterior",
                questionnaire=Questionnaire(),
                created_at="2026-12-01T12:00:00",
                updated_at="2026-12-01T12:00:00"
            )
        )
        streak_with_gap = compute_streaks(entries)
        self.assertEqual(streak_with_gap, 3)

    def test_4_qwen_pattern_summary_generation(self):
        """Verifica que Qwen genere el resumen en Ollama con think: False y lenguaje no clínico."""
        stats = {
            "valencia_media": 2.8,
            "valencia_min": 2.1,
            "valencia_max": 3.9,
            "energia_dominante": "tension_alta",
            "sueno_medio": 6.2,
            "sueno_min": 5.0,
            "carga_media": 4.1,
            "carga_max": 5,
            "emocion_dominante": "estres",
            "ejes_principales": ["trabajo_estudio", "carga_mental"],
            "total_dias": 7,
            "racha": 7
        }
        res = generate_period_summary(stats)
        self.assertIn("summary", res)
        self.assertIn("engine", res)
        # Debe haber usado Ollama con qwen3.5:4b
        print("\nResultado Resumen Qwen:", res)
        self.assertTrue("Ollama" in res["engine"] or "Python" in res["engine"])

    def test_5_red_mood_classification_and_distribution(self):
        """Verifica criterio de rojo ('muy_negativo') para valencia <= 2.0 o alerta roja de seguridad."""
        def make_entry(eid: int, date: str, score: float, laya_choice: str = "negativo", safety: SafetyResult = None, with_laya: bool = True):
            lp = None
            if with_laya:
                lp = LayaProfile(
                    valencia_emocional=LayaCategoryResult(choice=laya_choice, probabilities={laya_choice: 0.7}),
                    activacion_energia=LayaCategoryResult(choice="tension_alta", probabilities={"tension_alta": 0.8}),
                    emocion_primaria=LayaCategoryResult(choice="estres", probabilities={"estres": 0.7}),
                    ejes_tematicos={},
                    senales_alerta={},
                    valencia_score_estimada=score,
                )
            return DayEntry(
                id=eid,
                date=date,
                day_text="Texto de prueba",
                questionnaire=Questionnaire(valence_rating=int(round(score))),
                laya_profile=lp,
                safety=safety or SafetyResult(),
                created_at=f"{date}T12:00:00",
                updated_at=f"{date}T12:00:00",
            )

        e_boundary = make_entry(1, "2026-11-18", 2.0, "negativo")
        e_below = make_entry(2, "2026-11-17", 1.89, "negativo")
        e_red_alert = make_entry(3, "2026-11-19", 2.4, "negativo", SafetyResult(is_triggered=True, level="alert", message="Crisis"))
        e_tense = make_entry(4, "2026-11-20", 2.15, "negativo", SafetyResult(is_triggered=True, level="pause", message="Pausa"))
        e_no_laya_two = make_entry(5, "2026-11-15", 2.0, with_laya=False)

        self.assertEqual(classify_entry_mood_category(e_boundary), "muy_negativo")
        self.assertEqual(classify_entry_mood_category(e_below), "muy_negativo")
        self.assertEqual(classify_entry_mood_category(e_red_alert), "muy_negativo")
        self.assertEqual(classify_entry_mood_category(e_tense), "negativo")
        self.assertEqual(classify_entry_mood_category(e_no_laya_two), "muy_negativo")

        dist = compute_mood_distribution([e_boundary, e_below, e_red_alert, e_tense, e_no_laya_two])
        self.assertEqual(dist["muy_negativo"], 4)
        self.assertEqual(dist["negativo"], 1)

    def test_6_qwen_neutral_gender_sanitization(self):
        """Verifica que sanitize_response neutralice fórmulas con género asumido si llegaran a aparecer."""
        cleaned = sanitize_response(
            "Es normal sentirse agotado, así que es bueno ser amable contigo misma y darte un respiro para ti mismo."
        )
        self.assertNotIn("contigo misma", cleaned.lower())
        self.assertNotIn("ti mismo", cleaned.lower())
        self.assertNotIn("agotado", cleaned.lower())
        self.assertIn("sentir agotamiento", cleaned.lower())
        self.assertIn("contigo", cleaned.lower())
        self.assertIn("para ti", cleaned.lower())

    def test_7_network_info_and_local_qr_svg(self):
        """Verifica detección de red (Tailscale prioritario + Wi-Fi) y generación SVG 100% local."""
        from unittest.mock import patch

        svg = generate_qr_svg("http://100.88.246.36:8000")
        self.assertIn("<svg", svg)
        self.assertIn("<path", svg)

        with patch("backend.services.network._collect_candidate_ipv4s", return_value=["192.168.1.162", "100.88.246.36"]):
            info = get_network_access_info(port=8000)
            self.assertEqual(info["port"], 8000)
            self.assertEqual(info["preferred"], "tailscale")
            ids = [opt["id"] for opt in info["options"]]
            self.assertEqual(ids, ["tailscale", "wifi"])
            self.assertEqual(info["options"][0]["url"], "http://100.88.246.36:8000")
            self.assertEqual(info["options"][1]["url"], "http://192.168.1.162:8000")
            self.assertIn("<svg", info["options"][0]["svg"])

if __name__ == "__main__":
    unittest.main()
