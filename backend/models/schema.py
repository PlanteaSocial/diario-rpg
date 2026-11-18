"""
Modelos de datos tipados (Pydantic v2) para Diario Inteligente.
Garantiza validación estricta de entradas y compatibilidad con SQLite y Cloud Firestore.
"""

import re
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field, field_validator

EntityId = Union[int, str]
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def _validate_iso_date(value: str) -> str:
    cleaned = (value or "").strip()
    if not _DATE_RE.match(cleaned):
        raise ValueError("La fecha debe tener formato YYYY-MM-DD.")
    try:
        datetime.strptime(cleaned, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("La fecha no es un día válido del calendario.") from exc
    return cleaned


def _validate_hhmm(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip()
    if not _TIME_RE.match(cleaned):
        raise ValueError("La hora debe tener formato HH:MM.")
    hour, minute = map(int, cleaned.split(":"))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("La hora debe estar entre 00:00 y 23:59.")
    return cleaned


class QuickNoteCreate(BaseModel):
    date: str = Field(..., description="Fecha en formato YYYY-MM-DD")
    time: str = Field(..., description="Hora de captura en formato HH:MM")
    text: str = Field(..., min_length=1, max_length=5000, description="Contenido del pensamiento o nota rápida")

    @field_validator("date")
    @classmethod
    def check_date(cls, v: str) -> str:
        return _validate_iso_date(v)

    @field_validator("time")
    @classmethod
    def check_time(cls, v: str) -> str:
        checked = _validate_hhmm(v)
        if checked is None:
            raise ValueError("La hora es obligatoria.")
        return checked

    @field_validator("text")
    @classmethod
    def check_text_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("La nota rápida no puede estar vacía.")
        return v


class QuickNote(QuickNoteCreate):
    id: EntityId
    created_at: str


class Questionnaire(BaseModel):
    sleep_bedtime: Optional[str] = Field(default="23:00", description="Hora de acostarse (HH:MM)")
    sleep_wakeup: Optional[str] = Field(default="07:00", description="Hora de despertar (HH:MM)")
    sleep_hours: float = Field(default=8.0, ge=0.0, le=24.0, description="Horas calculadas de sueño")
    food_routine: Literal["si", "no", "a_medias"] = Field(default="si", description="¿Comiste a tus horas? si | no | a_medias")
    self_report_word: Literal["bien", "regular", "mal", "no_se"] = Field(default="bien", description="Auto-reporte: bien | regular | mal | no_se")
    valence_rating: int = Field(default=3, ge=1, le=5, description="Valencia/Ánimo subjetivo (1 a 5)")
    energy_rating: int = Field(default=3, ge=1, le=5, description="Energía/Activación subjetiva (1 a 5)")
    workload_rating: int = Field(default=3, ge=1, le=5, description="Carga/Demanda del día (1 a 5)")

    @field_validator("sleep_bedtime", "sleep_wakeup")
    @classmethod
    def check_sleep_hhmm(cls, v: Optional[str]) -> Optional[str]:
        return _validate_hhmm(v)


class LayaCategoryResult(BaseModel):
    choice: str
    probabilities: Dict[str, float]
    answer_confidence: float = 0.0


class LayaProfile(BaseModel):
    valencia_emocional: LayaCategoryResult
    activacion_energia: LayaCategoryResult
    emocion_primaria: LayaCategoryResult
    ejes_tematicos: Dict[str, float]  # { eje_name: float probability }
    senales_alerta: Dict[str, float]   # { signal_name: float probability }
    valencia_score_estimada: float = 3.0  # Escala 1.0 a 5.0
    raw_usage: Optional[Dict[str, Any]] = None


class DiscrepancyResult(BaseModel):
    has_discrepancy: bool = False
    message: Optional[str] = None
    level: str = "none"  # none | mild | marked
    details: Dict[str, Any] = Field(default_factory=dict)


class SafetyResult(BaseModel):
    is_triggered: bool = False
    level: str = "safe"  # safe | pause | alert
    message: Optional[str] = None
    helplines: List[Dict[str, str]] = Field(default_factory=list)


class DayEntryCreate(BaseModel):
    date: str = Field(..., description="Fecha en formato YYYY-MM-DD")
    day_text: str = Field(default="", max_length=50000, description="Escrito del día")
    questionnaire: Questionnaire = Field(default_factory=Questionnaire)

    @field_validator("date")
    @classmethod
    def check_date(cls, v: str) -> str:
        return _validate_iso_date(v)


class GoalAlignmentSignal(BaseModel):
    area: str
    signal: str
    status: str = "observacion"  # cumplido | observacion | sugerencia


class GoalAlignmentSummary(BaseModel):
    signals: List[GoalAlignmentSignal] = Field(default_factory=list)
    adherence_score: float = 100.0


class DayEntry(BaseModel):
    id: EntityId
    date: str
    day_text: str
    quick_notes: List[QuickNote] = Field(default_factory=list)
    questionnaire: Questionnaire
    laya_profile: Optional[LayaProfile] = None
    discrepancy: DiscrepancyResult = Field(default_factory=DiscrepancyResult)
    safety: SafetyResult = Field(default_factory=SafetyResult)
    goal_alignment: Optional[GoalAlignmentSummary] = None
    user_corrections: Dict[str, str] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class FeedbackCorrection(BaseModel):
    date: str
    text_snippet: str = Field(..., min_length=1, max_length=5000)
    question_id: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")
    original_value: str = Field(..., min_length=1, max_length=64)
    corrected_value: str = Field(..., min_length=1, max_length=64)
    notes: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("date")
    @classmethod
    def check_date(cls, v: str) -> str:
        return _validate_iso_date(v)


class CompanionState(BaseModel):
    name: str = Field(default="Slime", max_length=24)
    variant: str = Field(default="slime_azul", max_length=32)  # slime_azul | slime_menta | slime_lavanda
    unlocked_variants: List[str] = Field(default_factory=lambda: ["slime_azul"])
    level: int = Field(default=1, ge=1)
    exp: int = Field(default=20, ge=0)
    next_level_exp: int = Field(default=100, ge=1)
    coins: int = Field(default=35, ge=0)
    bond: int = Field(default=68, ge=0, le=100)     # 0..100 Vínculo
    satiety: int = Field(default=55, ge=0, le=100)  # 0..100 Saciedad
    energy: int = Field(default=75, ge=0, le=100)   # 0..100 Energía
    mood: int = Field(default=72, ge=0, le=100)     # 0..100 Ánimo
    pantry: Dict[str, int] = Field(default_factory=lambda: {"te_tibio": 1, "galleta_miel": 1})
    last_snack_at: Optional[str] = None


class CompanionActionRequest(BaseModel):
    action: Literal["pet", "rest", "snack", "rename", "buy", "feed", "equip_variant"]
    value: Optional[str] = Field(default=None, max_length=64)


class UserProfileBase(BaseModel):
    morning_habit: str = Field(default="cafe", max_length=40, description="celular | cafe | ejercicio | planificar | otro")
    habits_to_improve: List[str] = Field(default_factory=list, max_length=20)
    sleep_improvement_goal: str = Field(default="dormir_mas_horas", max_length=40)
    stress_areas: List[str] = Field(default_factory=list, max_length=20)
    personal_objective: str = Field(default="constancia", max_length=40, description="control_emocional | mas_energia | limites_sanos | constancia")
    daily_goal_level: Literal["facil", "normal", "serio", "intensivo"] = Field(default="normal")
    daily_goal_minutes: int = Field(default=10, ge=1, le=240)
    theme_mode: Literal["light", "dark"] = Field(default="light")
    onboarding_completed: bool = Field(default=False)
    radar_focus: Dict[str, float] = Field(default_factory=lambda: {
        "Descanso": 60.0,
        "Límites": 60.0,
        "Carga mental": 60.0,
        "Constancia": 60.0,
        "Manejo del estrés": 60.0
    })
    companion: CompanionState = Field(default_factory=CompanionState)


class UserProfile(UserProfileBase):
    id: EntityId = 1
    created_at: str
    updated_at: str


class SelfAssessmentSubmit(BaseModel):
    quiz_id: str = Field(..., min_length=1, max_length=64)
    answers: Dict[str, int]


class SelfAssessment(BaseModel):
    id: EntityId
    quiz_id: str
    quiz_title: str
    answers: Dict[str, int]
    score_pct: float
    result_label: str
    reflection_message: str
    radar_impacts: Dict[str, float]
    created_at: str


class BaselineMetrics(BaseModel):
    total_days: int = 0
    current_streak: int = 0
    avg_sleep_hours: float = 0.0
    avg_valence_user: float = 0.0
    avg_valence_laya: float = 0.0
    avg_energy_user: float = 0.0
    avg_energy_laya: float = 0.0
    avg_workload: float = 0.0
    predominant_primary_emotion: str = "calma"
    discrepancy_count: int = 0


class TimeSeriesPoint(BaseModel):
    date: str
    valence_user: float
    valence_laya: float
    energy_user: float
    energy_laya: float
    sleep_hours: float
    workload: float
    has_discrepancy: bool
    primary_emotion: str


class PatternsResponse(BaseModel):
    time_series: List[TimeSeriesPoint]
    baseline: BaselineMetrics
    summary_text: str
    generated_by: str
    mood_distribution: Dict[str, int] = Field(default_factory=dict)
    laya_axes_avg: Dict[str, float] = Field(default_factory=dict)
    personal_radar: Dict[str, float] = Field(default_factory=dict)
    goal_cross_insights: List[str] = Field(default_factory=list)
    period_days: int = 0
