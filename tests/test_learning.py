"""
Pruebas del módulo Aprender sobre una base SQLite temporal.
No toca data/diario.db.
"""

from datetime import datetime, timedelta, timezone
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.storage.database as database
from backend.storage.repository import SQLiteDiaryRepository
from backend.services.learning_engine import recall_probability, node_state


class TestLearningModule(unittest.TestCase):
    def setUp(self):
        self._original_db = database.DB_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        database.DB_PATH = Path(self.tmpdir.name) / "test_diario.db"
        database.init_db()
        self.repo = SQLiteDiaryRepository()

        from backend.routers import learning as learning_router
        self.learning = learning_router

    def tearDown(self):
        database.DB_PATH = self._original_db
        self.tmpdir.cleanup()

    def test_complete_lesson_updates_progress_and_hlr(self):
        result = self.learning.complete_lesson(
            self.learning.LessonCompleteRequest(lesson_id="tdah_1", accuracy=100),
            repo=self.repo,
        )
        self.assertTrue(result["first_completion"])
        self.assertEqual(result["exp_gain"], 25)
        self.assertEqual(result["hlr"]["status"], "dominado")
        self.assertEqual(result["hlr"]["half_life_days"], 8.0)

        second = self.learning.complete_lesson(
            self.learning.LessonCompleteRequest(lesson_id="tdah_1", accuracy=90),
            repo=self.repo,
        )
        self.assertFalse(second["first_completion"])
        self.assertEqual(second["hlr"]["half_life_days"], 16.0)

        progress = self.repo.get_learning_progress("tdah_1")
        self.assertEqual(progress["attempts"], 2)

    def test_notebook_crud(self):
        created = self.learning.create_notebook_entry(
            self.learning.NotebookCreateRequest(
                lesson_id="sueno_4", statement_text="Mi ritual de cierre"
            ),
            repo=self.repo,
        )
        self.assertEqual(len(created["notebook"]), 1)
        entry_id = created["entry"]["id"]

        deleted = self.learning.delete_notebook_entry(entry_id, repo=self.repo)
        self.assertTrue(deleted["deleted"])
        self.assertEqual(len(deleted["notebook"]), 0)

    def test_state_includes_all_tracks_and_glossary(self):
        state = self.learning._state_payload(self.repo)
        self.assertEqual(len(state["tracks"]), 3)
        self.assertEqual(sum(t["total_count"] for t in state["tracks"]), 12)
        self.assertIn("TDAH", state["glossary"])

    def test_frontend_static_learning_data_matches_backend(self):
        self.assertEqual(
            (PROJECT_ROOT / "data" / "learning_tracks.json").read_text(encoding="utf-8"),
            (PROJECT_ROOT / "frontend" / "data" / "learning_tracks.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(
            (PROJECT_ROOT / "data" / "glossary_terms.json").read_text(encoding="utf-8"),
            (PROJECT_ROOT / "frontend" / "data" / "glossary_terms.json").read_text(encoding="utf-8"),
        )

    def test_recall_probability_curve(self):
        self.assertAlmostEqual(recall_probability(4.0, 0.0), 1.0)
        self.assertAlmostEqual(recall_probability(4.0, 4.0), 0.5)
        due = node_state(
            {"lesson_id": "x", "completed_at": "2026-01-01T00:00:00"},
            {"half_life_days": 4.0, "last_reviewed_at": "2026-01-05T00:00:00"},
        )
        self.assertLess(due["recall"], 0.75)
        self.assertTrue(due["review_due"])

        # Timestamps conscientes de zona horaria (UTC) funcionan sin error y sin desfase
        recent_utc = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        fresh = node_state(
            {"lesson_id": "x", "completed_at": recent_utc},
            {"half_life_days": 4.0, "last_reviewed_at": recent_utc},
        )
        self.assertEqual(fresh["status"], "dominado")
        self.assertGreater(fresh["recall"], 0.95)


if __name__ == "__main__":
    unittest.main()
