"""
Pruebas unitarias para el repositorio y la base de datos SQLite (Local-First).
Incluye pruebas de concurrencia y aislamiento de borrado por usuario.
"""

from concurrent.futures import ThreadPoolExecutor
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.config as config
from backend.storage.database import init_db
from backend.storage.repository import SQLiteDiaryRepository
from backend.models.schema import (
    QuickNoteCreate,
    DayEntryCreate,
    Questionnaire,
    DiscrepancyResult,
    SafetyResult,
    FeedbackCorrection,
)


class TestDiaryRepository(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        import backend.storage.database as database
        cls._database = database
        cls._original_db = database.DB_PATH
        cls._original_feedback = config.TRAIN_FEEDBACK_PATH
        database.DB_PATH = Path(cls._tmpdir.name) / "test_repository.db"
        config.TRAIN_FEEDBACK_PATH = Path(cls._tmpdir.name) / "test_repo_feedback.jsonl"
        init_db()

    @classmethod
    def tearDownClass(cls):
        cls._database.DB_PATH = cls._original_db
        config.TRAIN_FEEDBACK_PATH = cls._original_feedback
        cls._tmpdir.cleanup()

    def setUp(self):
        init_db()
        self.repo = SQLiteDiaryRepository(user_id=1)
        self.test_date = "2026-11-16"

    def test_save_and_get_quick_note(self):
        note = QuickNoteCreate(
            date=self.test_date,
            time="10:30",
            text="Prueba de pensamiento rápido en memoria"
        )
        saved = self.repo.save_quick_note(note)
        self.assertIsNotNone(saved.id)
        self.assertEqual(saved.text, note.text)

        notes = self.repo.get_quick_notes(self.test_date)
        self.assertTrue(len(notes) >= 1)
        self.assertTrue(any(n.text == note.text for n in notes))

    def test_save_and_get_day_entry(self):
        entry_data = DayEntryCreate(
            date=self.test_date,
            day_text="Texto principal del día de prueba.",
            questionnaire=Questionnaire(
                sleep_bedtime="23:30",
                sleep_wakeup="07:30",
                sleep_hours=8.0,
                food_routine="si",
                self_report_word="bien",
                valence_rating=4,
                energy_rating=3,
                workload_rating=2
            )
        )
        saved = self.repo.save_or_update_day_entry(
            entry=entry_data,
            laya_profile=None,
            discrepancy=DiscrepancyResult(),
            safety=SafetyResult()
        )
        self.assertIsNotNone(saved.id)
        self.assertEqual(saved.date, self.test_date)

        fetched = self.repo.get_day_entry(self.test_date)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.day_text, "Texto principal del día de prueba.")
        self.assertEqual(fetched.questionnaire.valence_rating, 4)

    def test_concurrent_profile_init_and_learning_updates(self):
        def init_profile(_):
            return SQLiteDiaryRepository(user_id=99).get_user_profile()

        with ThreadPoolExecutor(max_workers=6) as pool:
            profiles = list(pool.map(init_profile, range(10)))
        self.assertEqual(len(profiles), 10)
        self.assertTrue(all(p.id == 99 for p in profiles))

        def complete_once(_):
            return SQLiteDiaryRepository(user_id=99).complete_learning_lesson(
                "tdah_1", "tdah", 95.0, 10
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(complete_once, range(6)))

        progress = SQLiteDiaryRepository(user_id=99).get_learning_progress("tdah_1")
        self.assertEqual(progress["attempts"], 6)
        self.assertEqual(progress["exp_earned"], 60)

    def test_reset_user_data_is_isolated(self):
        r1 = SQLiteDiaryRepository(user_id=10)
        r2 = SQLiteDiaryRepository(user_id=20)
        r1.save_quick_note(QuickNoteCreate(date="2026-11-10", time="09:00", text="nota u1"))
        r2.save_quick_note(QuickNoteCreate(date="2026-11-10", time="09:05", text="nota u2"))
        r1.record_feedback(FeedbackCorrection(
            date="2026-11-10", text_snippet="a", question_id="valencia_emocional",
            original_value="neutro", corrected_value="positivo"
        ))
        r2.record_feedback(FeedbackCorrection(
            date="2026-11-10", text_snippet="b", question_id="valencia_emocional",
            original_value="neutro", corrected_value="negativo"
        ))

        r1.reset_user_data()
        self.assertEqual(r1.get_quick_notes("2026-11-10"), [])
        self.assertEqual(len(r2.get_quick_notes("2026-11-10")), 1)
        lines = config.TRAIN_FEEDBACK_PATH.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn('"user_id": 20', lines[0])


if __name__ == "__main__":
    unittest.main()
