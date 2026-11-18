"""
Motor del módulo Aprender (Local-First).
Calcula la probabilidad de recuerdo HLR, el estado de cada nodo y una
recomendación educativa suave a partir de los ejes de Laya.

No emite diagnósticos ni etiquetas clínicas.
"""

from __future__ import annotations

from functools import lru_cache
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.config import LEARNING_TRACKS_PATH, GLOSSARY_PATH

DEFAULT_HALF_LIFE_DAYS = 4.0
MAX_HALF_LIFE_DAYS = 30.0
REVIEW_THRESHOLD = 0.75


def _now() -> datetime:
    return datetime.now().astimezone()


@lru_cache(maxsize=8)
def _load_json_cached(path_str: str, mtime_ns: int) -> Dict[str, Any]:
    with open(path_str, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_json(path: Path) -> Dict[str, Any]:
    return _load_json_cached(str(path), path.stat().st_mtime_ns)


def load_tracks() -> Dict[str, Any]:
    return _load_json(LEARNING_TRACKS_PATH)


def load_glossary() -> Dict[str, Any]:
    return _load_json(GLOSSARY_PATH)


def find_lesson(tracks_payload: Dict[str, Any], lesson_id: str) -> Optional[Dict[str, Any]]:
    for track in tracks_payload.get("tracks", []):
        for lesson in track.get("lessons", []):
            if lesson.get("id") == lesson_id:
                found = dict(lesson)
                found["track_title"] = track.get("title", "")
                found["track_id"] = track.get("id", "")
                return found
    return None


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    local_tz = _now().tzinfo
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=local_tz)
    return parsed.astimezone(local_tz)


def days_since(value: Optional[str], now: Optional[datetime] = None) -> float:
    parsed = parse_iso(value)
    if not parsed:
        return 0.0
    current = now or _now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=parsed.tzinfo)
    else:
        current = current.astimezone(parsed.tzinfo)
    delta = (current - parsed).total_seconds() / 86400.0
    return max(0.0, delta)


def recall_probability(half_life_days: float, elapsed_days: float) -> float:
    """p = 2^(-delta / h). HLR de Settles & Meeder (2016)."""
    h = max(0.1, float(half_life_days or DEFAULT_HALF_LIFE_DAYS))
    delta = max(0.0, float(elapsed_days or 0.0))
    return float(2.0 ** (-delta / h))


def node_state(progress: Optional[Dict[str, Any]], memory: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not progress:
        return {
            "status": "nuevo",
            "recall": 0.0,
            "half_life_days": DEFAULT_HALF_LIFE_DAYS,
            "elapsed_days": 0.0,
            "review_due": False,
        }

    half_life = float((memory or {}).get("half_life_days") or DEFAULT_HALF_LIFE_DAYS)
    last_reviewed = (memory or {}).get("last_reviewed_at") or progress.get("completed_at")
    elapsed = days_since(last_reviewed)
    recall = recall_probability(half_life, elapsed)

    if recall < REVIEW_THRESHOLD:
        status = "repasar"
    else:
        status = "dominado"

    return {
        "status": status,
        "recall": round(recall, 3),
        "half_life_days": round(half_life, 2),
        "elapsed_days": round(elapsed, 2),
        "review_due": recall < REVIEW_THRESHOLD,
    }


def build_state(
    tracks_payload: Dict[str, Any],
    progress_rows: List[Dict[str, Any]],
    memory_rows: List[Dict[str, Any]],
    notebook_rows: List[Dict[str, Any]],
    entries: List[Any],
) -> Dict[str, Any]:
    progress_map = {row["lesson_id"]: row for row in progress_rows}
    memory_map = {row["lesson_id"]: row for row in memory_rows}

    tracks: List[Dict[str, Any]] = []
    due_lessons: List[Dict[str, Any]] = []

    for track in tracks_payload.get("tracks", []):
        lessons_out: List[Dict[str, Any]] = []
        completed_count = 0

        for lesson in track.get("lessons", []):
            lesson_id = lesson.get("id")
            progress = progress_map.get(lesson_id)
            state = node_state(progress, memory_map.get(lesson_id))
            if progress:
                completed_count += 1
            if state["review_due"]:
                due_lessons.append(
                    {
                        "lesson_id": lesson_id,
                        "track_id": track.get("id"),
                        "title": lesson.get("title"),
                        "track_title": track.get("title"),
                        "recall": state["recall"],
                    }
                )
            lessons_out.append(
                {
                    "id": lesson_id,
                    "level": lesson.get("level"),
                    "title": lesson.get("title"),
                    "subtitle": lesson.get("subtitle"),
                    "minutes": lesson.get("minutes"),
                    "exp": lesson.get("exp"),
                    "steps_count": len(lesson.get("steps", [])),
                    "completed": bool(progress),
                    "best_accuracy": (progress or {}).get("best_accuracy"),
                    "attempts": (progress or {}).get("attempts", 0),
                    **state,
                }
            )

        total = len(track.get("lessons", [])) or 1
        tracks.append(
            {
                "id": track.get("id"),
                "title": track.get("title"),
                "subtitle": track.get("subtitle"),
                "icon": track.get("icon"),
                "accent": track.get("accent"),
                "completed_count": completed_count,
                "total_count": total,
                "progress_pct": round((completed_count / total) * 100),
                "lessons": lessons_out,
            }
        )

    due_lessons.sort(key=lambda item: item["recall"])
    recommendation = build_recommendation(entries, tracks_payload)

    return {
        "tracks": tracks,
        "notebook": notebook_rows,
        "due_lessons": due_lessons,
        "recommendation": recommendation,
        "hlr_threshold": REVIEW_THRESHOLD,
    }


def build_recommendation(entries: List[Any], tracks_payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Sugerencia educativa sutil: nunca afirma un diagnóstico."""
    recent = [e for e in entries if getattr(e, "laya_profile", None)][:3]
    if len(recent) < 3:
        return None

    def axis_high(entry: Any, axis: str, threshold: float = 0.6) -> bool:
        profile = getattr(entry, "laya_profile", None)
        if not profile:
            return False
        ejes = getattr(profile, "ejes_tematicos", {}) or {}
        return float(ejes.get(axis, 0.0)) >= threshold

    if all(axis_high(e, "descanso_sueno") for e in recent):
        return {
            "track_id": "sueno",
            "message": "Si te interesa entender mejor cómo funciona el descanso, tienes una ruta educativa breve en Aprender.",
        }
    if all(axis_high(e, "carga_mental") for e in recent):
        return {
            "track_id": "estres",
            "message": "Si quieres entender mejor cómo se acumula la saturación mental, hay una ruta educativa breve en Aprender.",
        }
    return None
