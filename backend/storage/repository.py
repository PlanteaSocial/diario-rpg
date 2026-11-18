"""
Capa de abstracción de repositorio para Diario Inteligente (Local-First y Cloud-Ready).
Permite trabajar 100% offline con SQLite y desacoplar la lógica de negocio para
sincronización con Cloud Firestore o empaquetado en Electron.

Todas las operaciones están aisladas por usuario: el repositorio se crea con
`SQLiteDiaryRepository(user_id=...)` y nunca mezcla datos entre cuentas.
"""

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Dict, List, Optional

import backend.config as config
from backend.models.schema import (
    DayEntry,
    DayEntryCreate,
    DiscrepancyResult,
    EntityId,
    FeedbackCorrection,
    GoalAlignmentSummary,
    LayaProfile,
    Questionnaire,
    QuickNote,
    QuickNoteCreate,
    SafetyResult,
    SelfAssessment,
    UserProfile,
    UserProfileBase,
)
from backend.storage.database import db_connection


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class BaseDiaryRepository(ABC):
    user_id: EntityId

    @abstractmethod
    def save_quick_note(self, note: QuickNoteCreate) -> QuickNote:
        pass

    @abstractmethod
    def get_quick_notes(self, date: str) -> List[QuickNote]:
        pass

    @abstractmethod
    def save_or_update_day_entry(
        self,
        entry: DayEntryCreate,
        laya_profile: Optional[LayaProfile],
        discrepancy: DiscrepancyResult,
        safety: SafetyResult,
        goal_alignment: Optional[GoalAlignmentSummary] = None,
    ) -> DayEntry:
        pass

    @abstractmethod
    def get_day_entry(self, date: str) -> Optional[DayEntry]:
        pass

    @abstractmethod
    def list_day_entries(
        self, limit: int = 100, include_quick_notes: bool = True
    ) -> List[DayEntry]:
        pass

    @abstractmethod
    def update_corrections(
        self, date: str, corrections: Dict[str, str]
    ) -> Optional[DayEntry]:
        pass

    @abstractmethod
    def record_feedback(self, feedback: FeedbackCorrection) -> None:
        pass

    @abstractmethod
    def get_user_profile(self) -> UserProfile:
        pass

    @abstractmethod
    def save_user_profile(self, profile: UserProfileBase) -> UserProfile:
        pass

    @abstractmethod
    def save_self_assessment(self, assessment_data: Dict[str, Any]) -> SelfAssessment:
        pass

    @abstractmethod
    def list_self_assessments(self, limit: int = 50) -> List[SelfAssessment]:
        pass

    @abstractmethod
    def list_learning_progress(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def get_learning_progress(self, lesson_id: str) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def complete_learning_lesson(
        self, lesson_id: str, track_id: str, accuracy: float, exp_earned: int
    ) -> Dict[str, Any]:
        pass

    @abstractmethod
    def list_hlr_memory(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def get_hlr_memory(self, lesson_id: str) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def upsert_hlr_memory(
        self, lesson_id: str, half_life_days: float
    ) -> Dict[str, Any]:
        pass

    @abstractmethod
    def add_notebook_entry(
        self, track_title: str, lesson_id: str, statement_text: str
    ) -> Dict[str, Any]:
        pass

    @abstractmethod
    def list_notebook_entries(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def delete_notebook_entry(self, entry_id: EntityId) -> bool:
        pass

    @abstractmethod
    def reset_user_data(self) -> None:
        pass


class SQLiteDiaryRepository(BaseDiaryRepository):
    def __init__(self, user_id: int = 0, feedback_path: Optional[Path] = None):
        self.user_id = int(user_id)
        self._feedback_path = feedback_path

    def _get_feedback_path(self) -> Path:
        return self._feedback_path or config.TRAIN_FEEDBACK_PATH

    def _fetch_quick_notes(
        self, cursor: sqlite3.Cursor, date: str
    ) -> List[QuickNote]:
        rows = cursor.execute(
            """
            SELECT id, date, time, text, created_at
            FROM quick_notes
            WHERE user_id = ? AND date = ?
            ORDER BY time ASC, id ASC
            """,
            (self.user_id, date),
        ).fetchall()
        return [
            QuickNote(
                id=r["id"],
                date=r["date"],
                time=r["time"],
                text=r["text"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    def _row_to_day_entry(
        self,
        row: sqlite3.Row,
        preloaded_notes: Optional[List[QuickNote]] = None,
        cursor: Optional[sqlite3.Cursor] = None,
    ) -> DayEntry:
        """Convierte una fila SQLite de day_entries en un objeto DayEntry tipado."""
        date_val = row["date"]
        if preloaded_notes is not None:
            quick_notes = preloaded_notes
        elif cursor is not None:
            quick_notes = self._fetch_quick_notes(cursor, date_val)
        else:
            quick_notes = self.get_quick_notes(date_val)

        questionnaire = Questionnaire.model_validate_json(row["questionnaire_json"])
        laya_profile = (
            LayaProfile.model_validate_json(row["laya_profile_json"])
            if row["laya_profile_json"]
            else None
        )
        discrepancy = (
            DiscrepancyResult.model_validate_json(row["discrepancy_json"])
            if row["discrepancy_json"]
            else DiscrepancyResult()
        )
        safety = (
            SafetyResult.model_validate_json(row["safety_json"])
            if row["safety_json"]
            else SafetyResult()
        )

        goal_align_raw = (
            row["goal_alignment_json"]
            if "goal_alignment_json" in row.keys()
            else None
        )
        goal_alignment = (
            GoalAlignmentSummary.model_validate_json(goal_align_raw)
            if goal_align_raw
            else None
        )
        user_corrections = (
            json.loads(row["user_corrections_json"])
            if row["user_corrections_json"]
            else {}
        )

        return DayEntry(
            id=row["id"],
            date=date_val,
            day_text=row["day_text"] or "",
            quick_notes=quick_notes,
            questionnaire=questionnaire,
            laya_profile=laya_profile,
            discrepancy=discrepancy,
            safety=safety,
            goal_alignment=goal_alignment,
            user_corrections=user_corrections,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def save_quick_note(self, note: QuickNoteCreate) -> QuickNote:
        created_at = _utc_now_iso()
        clean_text = note.text.strip()
        with db_connection(commit=True) as conn:
            cursor = conn.execute(
                "INSERT INTO quick_notes (user_id, date, time, text, created_at) VALUES (?, ?, ?, ?, ?)",
                (self.user_id, note.date, note.time, clean_text, created_at),
            )
            note_id = cursor.lastrowid

        return QuickNote(
            id=note_id,
            date=note.date,
            time=note.time,
            text=clean_text,
            created_at=created_at,
        )

    def get_quick_notes(self, date: str) -> List[QuickNote]:
        with db_connection() as conn:
            return self._fetch_quick_notes(conn.cursor(), date)

    def save_or_update_day_entry(
        self,
        entry: DayEntryCreate,
        laya_profile: Optional[LayaProfile],
        discrepancy: DiscrepancyResult,
        safety: SafetyResult,
        goal_alignment: Optional[GoalAlignmentSummary] = None,
    ) -> DayEntry:
        now = _utc_now_iso()
        clean_text = entry.day_text.strip()
        questionnaire_json = entry.questionnaire.model_dump_json()
        laya_json = laya_profile.model_dump_json() if laya_profile else None
        discrepancy_json = discrepancy.model_dump_json()
        safety_json = safety.model_dump_json()
        goal_align_json = goal_alignment.model_dump_json() if goal_alignment else None

        with db_connection(commit=True) as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO day_entries
                    (user_id, date, day_text, questionnaire_json, laya_profile_json,
                     discrepancy_json, safety_json, goal_alignment_json,
                     user_corrections_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
                ON CONFLICT(user_id, date) DO UPDATE SET
                    day_text = excluded.day_text,
                    questionnaire_json = excluded.questionnaire_json,
                    laya_profile_json = excluded.laya_profile_json,
                    discrepancy_json = excluded.discrepancy_json,
                    safety_json = excluded.safety_json,
                    goal_alignment_json = excluded.goal_alignment_json,
                    updated_at = excluded.updated_at
                """,
                (
                    self.user_id,
                    entry.date,
                    clean_text,
                    questionnaire_json,
                    laya_json,
                    discrepancy_json,
                    safety_json,
                    goal_align_json,
                    now,
                    now,
                ),
            )
            row = cursor.execute(
                "SELECT * FROM day_entries WHERE user_id = ? AND date = ?",
                (self.user_id, entry.date),
            ).fetchone()
            return self._row_to_day_entry(row, cursor=cursor)

    def get_day_entry(self, date: str) -> Optional[DayEntry]:
        with db_connection() as conn:
            cursor = conn.cursor()
            row = cursor.execute(
                "SELECT * FROM day_entries WHERE user_id = ? AND date = ?",
                (self.user_id, date),
            ).fetchone()
            return self._row_to_day_entry(row, cursor=cursor) if row else None

    def list_day_entries(
        self, limit: int = 100, include_quick_notes: bool = True
    ) -> List[DayEntry]:
        safe_limit = max(1, min(int(limit), 1000))
        with db_connection() as conn:
            cursor = conn.cursor()
            rows = cursor.execute(
                "SELECT * FROM day_entries WHERE user_id = ? ORDER BY date DESC LIMIT ?",
                (self.user_id, safe_limit),
            ).fetchall()

            if not rows:
                return []

            if not include_quick_notes:
                return [
                    self._row_to_day_entry(row, preloaded_notes=[]) for row in rows
                ]

            dates = [r["date"] for r in rows]
            placeholders = ",".join(["?"] * len(dates))
            note_rows = cursor.execute(
                f"""
                SELECT id, date, time, text, created_at
                FROM quick_notes
                WHERE user_id = ? AND date IN ({placeholders})
                ORDER BY time ASC, id ASC
                """,
                [self.user_id, *dates],
            ).fetchall()

        notes_by_date: Dict[str, List[QuickNote]] = {d: [] for d in dates}
        for nr in note_rows:
            notes_by_date[nr["date"]].append(
                QuickNote(
                    id=nr["id"],
                    date=nr["date"],
                    time=nr["time"],
                    text=nr["text"],
                    created_at=nr["created_at"],
                )
            )

        return [
            self._row_to_day_entry(
                row, preloaded_notes=notes_by_date.get(row["date"], [])
            )
            for row in rows
        ]

    def update_corrections(
        self, date: str, corrections: Dict[str, str]
    ) -> Optional[DayEntry]:
        with db_connection(commit=True) as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            row = cursor.execute(
                "SELECT id, user_corrections_json FROM day_entries WHERE user_id = ? AND date = ?",
                (self.user_id, date),
            ).fetchone()

            if not row:
                return None

            existing_corrections = json.loads(row["user_corrections_json"] or "{}")
            existing_corrections.update(corrections)
            new_corrections_json = json.dumps(existing_corrections, ensure_ascii=False)

            cursor.execute(
                "UPDATE day_entries SET user_corrections_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (new_corrections_json, _utc_now_iso(), row["id"], self.user_id),
            )
            updated_row = cursor.execute(
                "SELECT * FROM day_entries WHERE id = ? AND user_id = ?",
                (row["id"], self.user_id),
            ).fetchone()
            return self._row_to_day_entry(updated_row, cursor=cursor)

    def record_feedback(self, feedback: FeedbackCorrection) -> None:
        now = _utc_now_iso()
        with db_connection(commit=True) as conn:
            conn.execute(
                """
                INSERT INTO user_feedback (user_id, date, text_snippet, question_id, original_value, corrected_value, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    self.user_id,
                    feedback.date,
                    feedback.text_snippet,
                    feedback.question_id,
                    feedback.original_value,
                    feedback.corrected_value,
                    feedback.notes or "",
                    now,
                ),
            )

        feedback_path = self._get_feedback_path()
        feedback_path.parent.mkdir(parents=True, exist_ok=True)
        feedback_entry = {
            "user_id": self.user_id,
            "date": feedback.date,
            "text": feedback.text_snippet,
            "question_id": feedback.question_id,
            "original_value": feedback.original_value,
            "corrected_value": feedback.corrected_value,
            "notes": feedback.notes,
            "timestamp": now,
        }
        with open(feedback_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(feedback_entry, ensure_ascii=False) + "\n")

    def get_user_profile(self) -> UserProfile:
        with db_connection(commit=True) as conn:
            row = conn.execute(
                "SELECT * FROM user_profile WHERE user_id = ?", (self.user_id,)
            ).fetchone()
            if not row:
                now = _utc_now_iso()
                default_base = UserProfileBase()
                conn.execute(
                    "INSERT OR IGNORE INTO user_profile (user_id, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (self.user_id, default_base.model_dump_json(), now, now),
                )
                row = conn.execute(
                    "SELECT * FROM user_profile WHERE user_id = ?", (self.user_id,)
                ).fetchone()

        data = json.loads(row["profile_json"])
        base = UserProfileBase(**data)
        return UserProfile(
            id=self.user_id,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            **base.model_dump(),
        )

    def save_user_profile(self, profile: UserProfileBase) -> UserProfile:
        now = _utc_now_iso()
        profile_json = profile.model_dump_json()
        with db_connection(commit=True) as conn:
            conn.execute(
                """
                INSERT INTO user_profile (user_id, profile_json, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    profile_json = excluded.profile_json,
                    updated_at = excluded.updated_at
                """,
                (self.user_id, profile_json, now, now),
            )
            row = conn.execute(
                "SELECT created_at, updated_at FROM user_profile WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
        return UserProfile(
            id=self.user_id,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            **profile.model_dump(),
        )

    def save_self_assessment(self, assessment_data: Dict[str, Any]) -> SelfAssessment:
        now = _utc_now_iso()
        data_json = json.dumps(assessment_data, ensure_ascii=False)
        with db_connection(commit=True) as conn:
            cursor = conn.execute(
                "INSERT INTO self_assessments (user_id, quiz_id, quiz_title, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    self.user_id,
                    assessment_data["quiz_id"],
                    assessment_data["quiz_title"],
                    data_json,
                    now,
                ),
            )
            new_id = cursor.lastrowid
        return SelfAssessment(id=new_id, created_at=now, **assessment_data)

    def list_self_assessments(self, limit: int = 50) -> List[SelfAssessment]:
        safe_limit = max(1, min(int(limit), 200))
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM self_assessments WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
                (self.user_id, safe_limit),
            ).fetchall()

        items = []
        for r in rows:
            data = json.loads(r["data_json"])
            items.append(
                SelfAssessment(id=r["id"], created_at=r["created_at"], **data)
            )
        return items

    # --- Módulo Aprender: progreso, memoria HLR y libreta ---
    def list_learning_progress(self) -> List[Dict[str, Any]]:
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM learning_progress WHERE user_id = ?", (self.user_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def get_learning_progress(self, lesson_id: str) -> Optional[Dict[str, Any]]:
        with db_connection() as conn:
            row = conn.execute(
                "SELECT * FROM learning_progress WHERE user_id = ? AND lesson_id = ?",
                (self.user_id, lesson_id),
            ).fetchone()
            return dict(row) if row else None

    def complete_learning_lesson(
        self, lesson_id: str, track_id: str, accuracy: float, exp_earned: int
    ) -> Dict[str, Any]:
        now = _utc_now_iso()
        with db_connection(commit=True) as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT * FROM learning_progress WHERE user_id = ? AND lesson_id = ?",
                (self.user_id, lesson_id),
            ).fetchone()

            if existing:
                attempts = int(existing["attempts"] or 0) + 1
                best = max(float(existing["best_accuracy"] or 0), float(accuracy))
                total_exp = int(existing["exp_earned"] or 0) + int(exp_earned)
                conn.execute(
                    """
                    UPDATE learning_progress
                    SET completed_at = ?, best_accuracy = ?, attempts = ?, exp_earned = ?
                    WHERE user_id = ? AND lesson_id = ?
                    """,
                    (now, best, attempts, total_exp, self.user_id, lesson_id),
                )
            else:
                attempts = 1
                best = float(accuracy)
                total_exp = int(exp_earned)
                conn.execute(
                    """
                    INSERT INTO learning_progress
                        (user_id, lesson_id, track_id, completed_at, best_accuracy, attempts, exp_earned)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        self.user_id,
                        lesson_id,
                        track_id,
                        now,
                        best,
                        attempts,
                        total_exp,
                    ),
                )

        return {
            "lesson_id": lesson_id,
            "track_id": track_id,
            "completed_at": now,
            "best_accuracy": best,
            "attempts": attempts,
            "exp_earned": total_exp,
        }

    def list_hlr_memory(self) -> List[Dict[str, Any]]:
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM hlr_memory WHERE user_id = ?", (self.user_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def get_hlr_memory(self, lesson_id: str) -> Optional[Dict[str, Any]]:
        with db_connection() as conn:
            row = conn.execute(
                "SELECT * FROM hlr_memory WHERE user_id = ? AND lesson_id = ?",
                (self.user_id, lesson_id),
            ).fetchone()
            return dict(row) if row else None

    def upsert_hlr_memory(
        self, lesson_id: str, half_life_days: float
    ) -> Dict[str, Any]:
        now = _utc_now_iso()
        with db_connection(commit=True) as conn:
            conn.execute(
                """
                INSERT INTO hlr_memory (user_id, lesson_id, half_life_days, last_reviewed_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, lesson_id) DO UPDATE SET
                    half_life_days = excluded.half_life_days,
                    last_reviewed_at = excluded.last_reviewed_at
                """,
                (self.user_id, lesson_id, float(half_life_days), now),
            )
        return {
            "lesson_id": lesson_id,
            "half_life_days": float(half_life_days),
            "last_reviewed_at": now,
        }

    def add_notebook_entry(
        self, track_title: str, lesson_id: str, statement_text: str
    ) -> Dict[str, Any]:
        now = _utc_now_iso()
        clean_text = statement_text.strip()
        with db_connection(commit=True) as conn:
            cursor = conn.execute(
                """
                INSERT INTO therapy_notebook
                    (user_id, track_title, lesson_id, statement_text, created_at, exported)
                VALUES (?, ?, ?, ?, ?, 0)
                """,
                (self.user_id, track_title, lesson_id, clean_text, now),
            )
            new_id = cursor.lastrowid
        return {
            "id": new_id,
            "track_title": track_title,
            "lesson_id": lesson_id,
            "statement_text": clean_text,
            "created_at": now,
            "exported": 0,
        }

    def list_notebook_entries(self) -> List[Dict[str, Any]]:
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM therapy_notebook WHERE user_id = ? ORDER BY created_at DESC, id DESC",
                (self.user_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_notebook_entry(self, entry_id: EntityId) -> bool:
        with db_connection(commit=True) as conn:
            cursor = conn.execute(
                "DELETE FROM therapy_notebook WHERE id = ? AND user_id = ?",
                (int(entry_id), self.user_id),
            )
            return cursor.rowcount > 0

    def reset_user_data(self) -> None:
        """Elimina notas, entradas, feedback, autoevaluaciones y progreso de Aprender del usuario."""
        with db_connection(commit=True) as conn:
            conn.execute("BEGIN IMMEDIATE")
            for table in (
                "quick_notes",
                "day_entries",
                "user_feedback",
                "self_assessments",
                "learning_progress",
                "hlr_memory",
                "therapy_notebook",
            ):
                conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (self.user_id,))

        feedback_path = self._get_feedback_path()
        if feedback_path.exists():
            kept_lines = []
            for line in feedback_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("user_id") != self.user_id:
                    kept_lines.append(line)
            feedback_path.write_text(
                "\n".join(kept_lines) + ("\n" if kept_lines else ""),
                encoding="utf-8",
            )
