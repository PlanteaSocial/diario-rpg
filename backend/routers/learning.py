"""Rutas REST del módulo Aprender (Local-First y Cloud-Ready)."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.deps import get_repo
from backend.models.schema import UserProfile, UserProfileBase
from backend.services.analytics import apply_companion_reward, get_adventurer_title
from backend.services.learning_engine import (
    DEFAULT_HALF_LIFE_DAYS,
    MAX_HALF_LIFE_DAYS,
    build_state,
    find_lesson,
    load_glossary,
    load_tracks,
)
from backend.storage.repository import BaseDiaryRepository

router = APIRouter(prefix="/api/learning", tags=["learning"])


class LessonCompleteRequest(BaseModel):
    lesson_id: str = Field(..., min_length=1, max_length=64)
    accuracy: float = Field(default=100.0, ge=0, le=100)


class NotebookCreateRequest(BaseModel):
    lesson_id: str = Field(..., min_length=1, max_length=64)
    statement_text: str = Field(..., min_length=1, max_length=2000)
    track_title: Optional[str] = Field(default=None, max_length=120)


def _state_payload(
    repo: BaseDiaryRepository, profile: Optional[UserProfile] = None
) -> dict:
    tracks_payload = load_tracks()
    progress_rows = repo.list_learning_progress()
    memory_rows = repo.list_hlr_memory()
    notebook_rows = repo.list_notebook_entries()
    entries = repo.list_day_entries(limit=10, include_quick_notes=False)
    state = build_state(
        tracks_payload, progress_rows, memory_rows, notebook_rows, entries
    )
    resolved_profile = profile or repo.get_user_profile()
    state["companion"] = resolved_profile.companion
    state["adventurer_title"] = get_adventurer_title(resolved_profile.companion.level)
    state["glossary"] = load_glossary().get("terms", {})
    return state


@router.get("/state")
def get_learning_state(repo: BaseDiaryRepository = Depends(get_repo)):
    return _state_payload(repo)


@router.get("/lesson/{lesson_id}")
def get_lesson(lesson_id: str):
    tracks_payload = load_tracks()
    lesson = find_lesson(tracks_payload, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lección no encontrada")
    return {"lesson": lesson, "glossary": load_glossary().get("terms", {})}


@router.post("/complete")
def complete_lesson(
    payload: LessonCompleteRequest,
    repo: BaseDiaryRepository = Depends(get_repo),
):
    tracks_payload = load_tracks()
    lesson = find_lesson(tracks_payload, payload.lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lección no encontrada")

    previous = repo.get_learning_progress(payload.lesson_id)
    first_completion = previous is None
    accuracy = round(float(payload.accuracy), 1)

    exp_gain = int(lesson.get("exp", 25)) if first_completion else 10
    coins_gain = int(lesson.get("coins", 8)) if first_completion else 3

    progress = repo.complete_learning_lesson(
        lesson_id=payload.lesson_id,
        track_id=lesson.get("track_id", ""),
        accuracy=accuracy,
        exp_earned=exp_gain,
    )

    memory = repo.get_hlr_memory(payload.lesson_id)
    current_half_life = float(
        (memory or {}).get("half_life_days") or DEFAULT_HALF_LIFE_DAYS
    )
    if accuracy >= 70:
        next_half_life = min(current_half_life * 2.0, MAX_HALF_LIFE_DAYS)
    else:
        next_half_life = current_half_life
    repo.upsert_hlr_memory(payload.lesson_id, next_half_life)

    profile = repo.get_user_profile()
    prof_base = UserProfileBase(**profile.model_dump())
    prof_base.companion = apply_companion_reward(
        prof_base.companion, exp_gain=exp_gain, coins_gain=coins_gain
    )
    saved_profile = repo.save_user_profile(prof_base)

    state = _state_payload(repo, profile=saved_profile)
    lesson_state = None
    for track in state["tracks"]:
        for node in track["lessons"]:
            if node["id"] == payload.lesson_id:
                lesson_state = node
                break
        if lesson_state is not None:
            break

    return {
        "progress": progress,
        "hlr": lesson_state,
        "companion": saved_profile.companion,
        "adventurer_title": get_adventurer_title(saved_profile.companion.level),
        "exp_gain": exp_gain,
        "coins_gain": coins_gain,
        "first_completion": first_completion,
        "state": state,
    }


@router.post("/notebook")
def create_notebook_entry(
    payload: NotebookCreateRequest,
    repo: BaseDiaryRepository = Depends(get_repo),
):
    tracks_payload = load_tracks()
    lesson = find_lesson(tracks_payload, payload.lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Lección no encontrada")

    track_title = payload.track_title or lesson.get("track_title") or "Aprender"
    entry = repo.add_notebook_entry(
        track_title, payload.lesson_id, payload.statement_text
    )
    return {"entry": entry, "notebook": repo.list_notebook_entries()}


@router.delete("/notebook/{entry_id}")
def delete_notebook_entry(
    entry_id: int,
    repo: BaseDiaryRepository = Depends(get_repo),
):
    deleted = repo.delete_notebook_entry(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Apunte no encontrado")
    return {"deleted": True, "notebook": repo.list_notebook_entries()}
