"""
Servidor principal FastAPI para Diario RPG (Local-First y Cloud-Ready).
Expone la API REST para notas, clasificación con Laya, analíticas y sirve el frontend estático.
"""

from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
import json
import platform
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import backend.config as config
from backend.deps import get_current_user, get_repo, require_admin
from backend.models.schema import (
    CompanionActionRequest,
    DayEntry,
    DayEntryCreate,
    FeedbackCorrection,
    LayaProfile,
    PatternsResponse,
    Questionnaire,
    QuickNote,
    QuickNoteCreate,
    SelfAssessmentSubmit,
    UserProfileBase,
)
from backend.routers.auth import router as auth_router
from backend.routers.learning import router as learning_router
from backend.services import auth as auth_service
from backend.services import security as sec
from backend.services.analytics import (
    COMPANION_SHOP_ITEMS,
    DAILY_GOAL_MINUTES_MAP,
    SELF_ASSESSMENT_QUIZZES,
    apply_companion_reward,
    build_time_series,
    calculate_sleep_hours,
    compute_combined_personal_radar,
    compute_laya_axes_averages,
    compute_mood_distribution,
    compute_onboarding_radar,
    compute_period_goal_cross_insights,
    compute_personal_baseline,
    detect_discrepancy,
    evaluate_daily_goal_alignment,
    evaluate_self_assessment,
    execute_companion_action,
    filter_entries_by_period,
    get_adventurer_title,
)
from backend.services.laya_engine import (
    LAYA_QUESTIONS,
    VALENCE_WEIGHTS,
    classify_text_with_laya,
    classify_text_with_laya_detailed,
    get_laya_agent,
    laya_backend_name,
)
from backend.services.network import get_network_access_info
from backend.services.qwen_engine import (
    detect_available_qwen_model,
    generate_deterministic_summary,
    generate_period_summary,
)
from backend.services.safety import evaluate_safety
import backend.storage.database as database
from backend.storage.database import init_db
from backend.storage.repository import BaseDiaryRepository

# Inicializar Base de Datos al importar la app
init_db()


class _BoundedCache:
    """Caché LRU en memoria acotada para evitar crecimiento ilimitado en procesos largos."""

    def __init__(self, max_size: int = 256):
        self._max_size = max_size
        self._data: OrderedDict[Any, Any] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            if key not in self._data:
                return default
            self._data.move_to_end(key)
            return self._data[key]

    def set(self, key: Any, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._max_size:
                self._data.popitem(last=False)

    def clear_prefix(self, prefix: str) -> None:
        with self._lock:
            for key in [k for k in self._data if str(k).startswith(prefix)]:
                self._data.pop(key, None)


_pattern_summary_cache = _BoundedCache(max_size=256)
last_dev_trace = _BoundedCache(max_size=64)


def _clear_user_summary_cache(user_id: Any) -> None:
    _pattern_summary_cache.clear_prefix(f"{user_id}:")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await run_in_threadpool(get_laya_agent)
    except Exception as exc:
        print("Aviso al inicializar Laya:", exc)
    yield


app = FastAPI(
    title="Diario Inteligente API",
    description="Backend local-first y cloud-ready con Laya AI, SQLite y Qwen vía Ollama",
    version="2.0.0",
    lifespan=lifespan,
)

# Rutas públicas de la API (el resto exige sesión).
PUBLIC_API_PATHS = {
    "/api/health",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/auth/logout",
}

# Rutas permitidas cuando el usuario debe cambiar su contraseña.
PASSWORD_CHANGE_PATHS = {"/api/auth/me", "/api/auth/password", "/api/auth/logout"}


def _is_allowed_origin(origin: str, request_host: str) -> bool:
    if not origin or origin == "null":
        return False
    normalized = origin.rstrip("/")
    if normalized in config.CORS_ORIGINS:
        return True
    return urlparse(origin).netloc == (request_host or "")


def _apply_security_headers(response, path: str):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"

    connect_sources = ["'self'"] + list(config.CORS_ORIGINS)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        f"connect-src {' '.join(connect_sources)}; "
        "font-src 'self' data:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.middleware("http")
async def auth_and_security_middleware(request: Request, call_next):
    path = request.url.path

    if path.startswith("/api/") and request.method != "OPTIONS":
        # 1. Protección CSRF para peticiones que cambian estado.
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin") or ""
            request_host = request.headers.get("host") or ""
            if request.headers.get("sec-fetch-site") == "cross-site":
                if not (origin and _is_allowed_origin(origin, request_host)):
                    return _apply_security_headers(
                        JSONResponse(
                            status_code=403, content={"detail": "Origen no permitido."}
                        ),
                        path,
                    )
            if origin and not _is_allowed_origin(origin, request_host):
                return _apply_security_headers(
                    JSONResponse(
                        status_code=403, content={"detail": "Origen no permitido."}
                    ),
                    path,
                )

        # 2. Sesión para todo lo que no sea público.
        if path not in PUBLIC_API_PATHS:
            token = request.cookies.get(sec.SESSION_COOKIE)
            user = await run_in_threadpool(auth_service.resolve_session, token)
            if not user:
                return _apply_security_headers(
                    JSONResponse(
                        status_code=401,
                        content={"detail": "Sesión requerida."},
                        headers={"WWW-Authenticate": "Cookie"},
                    ),
                    path,
                )
            request.state.user = user
            request.state.session_token = token

            if user.get("must_change_password") and path not in PASSWORD_CHANGE_PATHS:
                return _apply_security_headers(
                    JSONResponse(
                        status_code=403,
                        content={
                            "detail": "Debes cambiar tu contraseña antes de continuar."
                        },
                    ),
                    path,
                )

            if path.startswith("/api/dev/") and user.get("role") != "admin":
                return _apply_security_headers(
                    JSONResponse(
                        status_code=403, content={"detail": "Solo administradores."}
                    ),
                    path,
                )

    response = await call_next(request)
    return _apply_security_headers(response, path)


if config.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(auth_router)
app.include_router(learning_router)


# --- Endpoints de Estado y Diagnóstico ---
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/status")
def get_system_status(user: dict = Depends(get_current_user)):
    qwen_model = detect_available_qwen_model()
    db_info = str(database.DB_PATH) if user.get("role") == "admin" else "sqlite-local"
    return {
        "status": "online",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "database": db_info,
        "laya_model": "convaiinnovations/laya (multilingual)",
        "ollama_qwen": (
            qwen_model if qwen_model else "no detectado (usando motor determinista)"
        ),
        "classifier": laya_backend_name(),
        "platform": f"{platform.system()} Local-First",
    }


@app.get("/api/network-info")
def get_network_info(user: dict = Depends(get_current_user)):
    """Detecta IPs disponibles (Tailscale y Wi-Fi) y devuelve códigos QR SVG locales."""
    return get_network_access_info()


# --- Endpoints de Notas Rápidas ---
@app.post("/api/quick-notes", response_model=QuickNote)
def create_quick_note(
    note: QuickNoteCreate, repo: BaseDiaryRepository = Depends(get_repo)
):
    saved = repo.save_quick_note(note)
    prof = repo.get_user_profile()
    prof_base = UserProfileBase(**prof.model_dump())
    prof_base.companion = apply_companion_reward(
        prof_base.companion, exp_gain=5, coins_gain=2
    )
    repo.save_user_profile(prof_base)
    return saved


@app.get("/api/quick-notes", response_model=List[QuickNote])
def list_quick_notes(
    date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="Fecha YYYY-MM-DD"),
    repo: BaseDiaryRepository = Depends(get_repo),
):
    return repo.get_quick_notes(date)


# --- Endpoints de la Nota del Día y Clasificación Laya ---
@app.post("/api/day-entry", response_model=DayEntry)
def save_day_entry(
    entry: DayEntryCreate, repo: BaseDiaryRepository = Depends(get_repo)
):
    # 1. Asegurar cálculo determinista exacto de horas de sueño
    calculated_sleep = calculate_sleep_hours(
        entry.questionnaire.sleep_bedtime,
        entry.questionnaire.sleep_wakeup,
    )
    entry.questionnaire.sleep_hours = calculated_sleep

    # 2. Reunir todo el texto del día: Escrito principal + Notas Rápidas acumuladas
    quick_notes = repo.get_quick_notes(entry.date)
    quick_texts = [f"[{qn.time}] {qn.text}" for qn in quick_notes]
    combined_parts = []
    if entry.day_text.strip():
        combined_parts.append(entry.day_text.strip())
    if quick_texts:
        combined_parts.append("Notas rápidas del día:\n" + "\n".join(quick_texts))

    full_day_text = "\n\n".join(combined_parts)

    # 3. Clasificación detallada con Laya AI para el motor y Modo Desarrollador
    laya_profile = None
    detailed_trace = None
    if full_day_text:
        detailed_trace = classify_text_with_laya_detailed(full_day_text)
        if detailed_trace.get("profile"):
            laya_profile = LayaProfile(**detailed_trace["profile"])

    # 4. Evaluación de Seguridad (Capa determinista + semántica)
    senales_alerta = laya_profile.senales_alerta if laya_profile else None
    safety_result = evaluate_safety(full_day_text, senales_alerta)

    # 5. Detección de Discrepancias (Auto-reporte vs Laya) y Alineación con Metas
    discrepancy_result = detect_discrepancy(entry.questionnaire, laya_profile)
    user_profile = repo.get_user_profile()
    goal_alignment = evaluate_daily_goal_alignment(
        entry.questionnaire, laya_profile, user_profile
    )

    # 6. Actualizar Traza de Inferencia para Modo Desarrollador (por usuario)
    _clear_user_summary_cache(repo.user_id)
    last_dev_trace.set(
        repo.user_id,
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": "day_entry_inference",
            "date": entry.date,
            "input_text": full_day_text,
            "latency_ms": detailed_trace.get("latency_ms", 0.0) if detailed_trace else 0.0,
            "input_tokens": detailed_trace.get("input_tokens", 0) if detailed_trace else 0,
            "profile": detailed_trace.get("profile") if detailed_trace else None,
            "raw_answers": detailed_trace.get("raw_answers") if detailed_trace else {},
            "raw_usage": detailed_trace.get("raw_usage") if detailed_trace else {},
            "valence_calculation": detailed_trace.get("valence_calculation") if detailed_trace else {},
            "questions_schema": LAYA_QUESTIONS,
            "questionnaire_analysis": {
                "answers": entry.questionnaire.model_dump(),
                "sleep_hours_formula": f"{entry.questionnaire.sleep_bedtime} a {entry.questionnaire.sleep_wakeup} = {calculated_sleep} h",
                "self_report": entry.questionnaire.self_report_word,
                "discrepancy_evaluation": discrepancy_result.model_dump(),
                "goal_alignment": goal_alignment.model_dump(),
                "ratings": {
                    "valence_user": entry.questionnaire.valence_rating,
                    "valence_laya_score": laya_profile.valencia_score_estimada if laya_profile else None,
                    "energy_user": entry.questionnaire.energy_rating,
                    "energy_laya_choice": laya_profile.activacion_energia.choice if laya_profile else None,
                    "workload_user": entry.questionnaire.workload_rating,
                },
            },
            "safety_evaluation": safety_result.model_dump(),
        },
    )

    # 7. Guardar en repositorio y recompensar constancia RPG
    saved_entry = repo.save_or_update_day_entry(
        entry=entry,
        laya_profile=laya_profile,
        discrepancy=discrepancy_result,
        safety=safety_result,
        goal_alignment=goal_alignment,
    )

    val_score = (
        laya_profile.valencia_score_estimada
        if laya_profile
        else float(entry.questionnaire.valence_rating)
    )
    prof_base = UserProfileBase(**user_profile.model_dump())
    prof_base.companion = apply_companion_reward(
        prof_base.companion,
        exp_gain=30,
        coins_gain=12,
        sleep_hours=calculated_sleep,
        valence_score=val_score,
    )
    repo.save_user_profile(prof_base)

    return saved_entry


@app.get("/api/day-entry", response_model=Optional[DayEntry])
def get_day_entry(
    date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="Fecha YYYY-MM-DD"),
    repo: BaseDiaryRepository = Depends(get_repo),
):
    return repo.get_day_entry(date)


# --- Endpoints de Historial ---
@app.get("/api/history", response_model=List[DayEntry])
def get_history(
    limit: int = Query(default=100, ge=1, le=500),
    repo: BaseDiaryRepository = Depends(get_repo),
):
    return repo.list_day_entries(limit=limit)


# --- Corrección del Usuario ("El usuario manda") ---
@app.post("/api/feedback")
def submit_user_feedback(
    feedback: FeedbackCorrection, repo: BaseDiaryRepository = Depends(get_repo)
):
    repo.record_feedback(feedback)
    correction_dict = {feedback.question_id: feedback.corrected_value}
    updated_entry = repo.update_corrections(feedback.date, correction_dict)
    _clear_user_summary_cache(repo.user_id)

    return {
        "status": "success",
        "message": "Corrección guardada y registrada para aprendizaje futuro.",
        "updated_entry": updated_entry,
    }


# --- Perfil de Usuario, Metas y Onboarding ---
@app.get("/api/profile")
def get_user_profile(repo: BaseDiaryRepository = Depends(get_repo)):
    profile = repo.get_user_profile()
    entries = repo.list_day_entries(limit=100, include_quick_notes=False)
    assessments = repo.list_self_assessments(limit=20)
    combined_radar = compute_combined_personal_radar(profile, assessments, entries)
    return {
        "profile": profile,
        "personal_radar": combined_radar,
        "adventurer_title": get_adventurer_title(profile.companion.level),
        "shop_items": list(COMPANION_SHOP_ITEMS.values()),
    }


@app.put("/api/profile")
def update_user_profile(
    payload: UserProfileBase, repo: BaseDiaryRepository = Depends(get_repo)
):
    existing = repo.get_user_profile()
    # Conservar progreso RPG del compañero al actualizar preferencias
    payload.companion = existing.companion
    payload.daily_goal_minutes = DAILY_GOAL_MINUTES_MAP.get(payload.daily_goal_level, 10)
    if payload.onboarding_completed or not payload.radar_focus:
        payload.radar_focus = compute_onboarding_radar(payload)
    saved = repo.save_user_profile(payload)
    _clear_user_summary_cache(repo.user_id)
    entries = repo.list_day_entries(limit=100, include_quick_notes=False)
    assessments = repo.list_self_assessments(limit=20)
    combined_radar = compute_combined_personal_radar(saved, assessments, entries)
    return {
        "profile": saved,
        "personal_radar": combined_radar,
        "adventurer_title": get_adventurer_title(saved.companion.level),
    }


# --- Santuario & Tienda RPG del Compañero ---
@app.get("/api/companion")
def get_companion_sanctuary(repo: BaseDiaryRepository = Depends(get_repo)):
    profile = repo.get_user_profile()
    return {
        "companion": profile.companion,
        "adventurer_title": get_adventurer_title(profile.companion.level),
        "shop_items": list(COMPANION_SHOP_ITEMS.values()),
    }


@app.post("/api/companion/action")
def perform_companion_action(
    req: CompanionActionRequest, repo: BaseDiaryRepository = Depends(get_repo)
):
    profile = repo.get_user_profile()
    updated_comp, msg = execute_companion_action(
        profile.companion, req.action, req.value
    )
    prof_base = UserProfileBase(**profile.model_dump())
    prof_base.companion = updated_comp
    saved = repo.save_user_profile(prof_base)
    return {
        "companion": saved.companion,
        "adventurer_title": get_adventurer_title(saved.companion.level),
        "message": msg,
    }


# --- Autoevaluaciones y Retos de Hábitos (No Clínicos) ---
@app.get("/api/assessments")
def get_assessments(repo: BaseDiaryRepository = Depends(get_repo)):
    profile = repo.get_user_profile()
    entries = repo.list_day_entries(limit=100, include_quick_notes=False)
    history = repo.list_self_assessments(limit=30)
    combined_radar = compute_combined_personal_radar(profile, history, entries)
    return {
        "quizzes": list(SELF_ASSESSMENT_QUIZZES.values()),
        "history": history,
        "personal_radar": combined_radar,
    }


@app.post("/api/assessments")
def submit_assessment(
    submission: SelfAssessmentSubmit, repo: BaseDiaryRepository = Depends(get_repo)
):
    try:
        evaluated = evaluate_self_assessment(submission.quiz_id, submission.answers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    saved = repo.save_self_assessment(evaluated)
    profile = repo.get_user_profile()

    # Recompensa por autoconocimiento
    prof_base = UserProfileBase(**profile.model_dump())
    prof_base.companion = apply_companion_reward(
        prof_base.companion, exp_gain=20, coins_gain=8
    )
    updated_profile = repo.save_user_profile(prof_base)

    entries = repo.list_day_entries(limit=100, include_quick_notes=False)
    history = repo.list_self_assessments(limit=30)
    combined_radar = compute_combined_personal_radar(updated_profile, history, entries)
    return {
        "assessment": saved,
        "personal_radar": combined_radar,
        "companion": updated_profile.companion,
    }


def _compute_patterns_context(
    days: int, repo: BaseDiaryRepository
) -> Dict[str, Any]:
    """Calcula de forma determinista y ultrarrápida métricas, series y ejes de Laya."""
    all_entries = repo.list_day_entries(limit=365, include_quick_notes=False)
    entries = filter_entries_by_period(all_entries, days=days)
    baseline = compute_personal_baseline(entries)
    time_series = build_time_series(entries)
    mood_distribution = compute_mood_distribution(entries)
    laya_axes_avg = compute_laya_axes_averages(entries)

    user_profile = repo.get_user_profile()
    assessments = repo.list_self_assessments(limit=30)
    personal_radar = compute_combined_personal_radar(
        user_profile, assessments, all_entries
    )
    goal_cross_insights = compute_period_goal_cross_insights(entries, user_profile)

    eje_sums: Dict[str, float] = {}
    valences: List[float] = []
    workloads: List[int] = []
    sleeps: List[float] = []
    latest_updated = entries[0].updated_at if entries else "none"

    for e in entries:
        workloads.append(e.questionnaire.workload_rating)
        sleeps.append(e.questionnaire.sleep_hours)
        if e.laya_profile:
            valences.append(e.laya_profile.valencia_score_estimada)
            if e.laya_profile.ejes_tematicos:
                for eje, prob in e.laya_profile.ejes_tematicos.items():
                    eje_sums[eje] = eje_sums.get(eje, 0.0) + prob

    sorted_ejes = sorted(eje_sums.items(), key=lambda x: x[1], reverse=True)
    top_ejes = (
        [k for k, _ in sorted_ejes[:2]]
        if sorted_ejes
        else ["trabajo_estudio", "carga_mental"]
    )

    stats = {
        "valencia_media": round(baseline.avg_valence_laya, 2),
        "energia_dominante": baseline.predominant_primary_emotion,
        "sueno_medio": round(baseline.avg_sleep_hours, 1),
        "carga_media": round(baseline.avg_workload, 1),
        "emocion_dominante": baseline.predominant_primary_emotion,
        "ejes_principales": top_ejes,
        "total_dias": baseline.total_days,
        "racha": baseline.current_streak,
        "valencia_min": round(min(valences), 2) if valences else 3.0,
        "valencia_max": round(max(valences), 2) if valences else 3.0,
        "carga_max": max(workloads) if workloads else 3,
        "sueno_min": round(min(sleeps), 1) if sleeps else 7.0,
        "objetivo_personal": user_profile.personal_objective,
        "habitos_cuidar": user_profile.habits_to_improve,
        "cruces_objetivos": goal_cross_insights,
    }

    cache_key = f"{repo.user_id}:{days}:{len(entries)}:{latest_updated}:{user_profile.updated_at}"
    return {
        "baseline": baseline,
        "time_series": time_series,
        "mood_distribution": mood_distribution,
        "laya_axes_avg": laya_axes_avg,
        "personal_radar": personal_radar,
        "goal_cross_insights": goal_cross_insights,
        "stats": stats,
        "cache_key": cache_key,
    }


# --- Patrones, Gráficas y Resumen Qwen ---
@app.get("/api/patterns", response_model=PatternsResponse)
def get_patterns(
    days: int = Query(default=0, ge=0, le=3650, description="Filtro de periodo: 7, 30, o 0 para todo"),
    refresh_llm: bool = Query(default=False, description="Si true, invoca Qwen síncronamente"),
    repo: BaseDiaryRepository = Depends(get_repo),
):
    ctx = _compute_patterns_context(days, repo)
    cache_key = ctx["cache_key"]

    cached = _pattern_summary_cache.get(cache_key)
    if refresh_llm:
        summary_result = generate_period_summary(ctx["stats"])
        _pattern_summary_cache.set(cache_key, summary_result)
    elif cached is not None:
        summary_result = cached
    else:
        summary_result = {
            "summary": generate_deterministic_summary(ctx["stats"]),
            "engine": "Motor analítico rápido (toca Actualizar para Qwen 3.5)",
        }

    return PatternsResponse(
        time_series=ctx["time_series"],
        baseline=ctx["baseline"],
        summary_text=summary_result["summary"],
        generated_by=summary_result["engine"],
        mood_distribution=ctx["mood_distribution"],
        laya_axes_avg=ctx["laya_axes_avg"],
        personal_radar=ctx["personal_radar"],
        goal_cross_insights=ctx["goal_cross_insights"],
        period_days=days,
    )


@app.post("/api/patterns/summarize")
def summarize_patterns_with_qwen(
    days: int = Query(default=0, ge=0, le=3650),
    repo: BaseDiaryRepository = Depends(get_repo),
):
    """Invoca explícitamente a Qwen 3.5:4b para redactar el resumen y lo almacena en caché."""
    ctx = _compute_patterns_context(days, repo)
    summary_result = generate_period_summary(ctx["stats"])
    _pattern_summary_cache.set(ctx["cache_key"], summary_result)
    return {
        "summary_text": summary_result["summary"],
        "generated_by": summary_result["engine"],
    }


# --- Endpoints del Modo Desarrollador ---
@app.get("/api/dev/trace")
def get_developer_trace(user: dict = Depends(require_admin)):
    """
    Retorna la traza completa de la última inferencia, el schema de preguntas
    enviadas a Laya, el modelo activo y la explicación del peso de las respuestas del cuestionario.
    """
    active_model = laya_backend_name()
    qwen_model = detect_available_qwen_model()

    return {
        "active_laya_model": active_model,
        "active_qwen_model": qwen_model or "motor determinista en Python",
        "last_trace": last_dev_trace.get(user["id"]),
        "system_schema": {
            "questions": LAYA_QUESTIONS,
            "valence_weights": VALENCE_WEIGHTS,
        },
        "questionnaire_weights_explanation": {
            "sueño": {
                "impacto": "Determinista",
                "calculo": "Horas reales calculadas (HH:MM despertar - HH:MM acostar con cruce de medianoche).",
                "rol": "Se superpone en la gráfica contra la valencia/ánimo y se analiza en la línea base personal para detectar deuda de sueño.",
            },
            "alimentacion": {
                "impacto": "Control de rutina",
                "calculo": "Categoría (Sí / No / A medias).",
                "rol": "Se asocia a regularidad de hábitos diarios.",
            },
            "auto_reporte": {
                "impacto": "Detector de coherencia (Discrepancia)",
                "calculo": "Compara la palabra ('Bien', 'Regular', 'Mal', 'No sé') contra P(muy_negativo) + P(negativo) de Laya.",
                "umbral": "Si el usuario elige 'Bien' pero Laya arroja P(negativo total) >= 65%, se activa una tarjeta serena de discrepancia.",
            },
            "escalas_animo_y_energia": {
                "impacto": "Comparativa directa contra predicción",
                "calculo": "Escala subjetiva 1 a 5 vs. Escala continua de Laya (1.0 a 5.0) y activación.",
                "rol": "Permite contrastar la autopercepción consciente frente al tono emocional latente detectado en el texto.",
            },
            "carga_de_trabajo": {
                "impacto": "Correlación multidimensional",
                "calculo": "Escala 1 a 5 cruzada en la gráfica interactiva temporal.",
                "rol": "Permite observar si los picos de carga (4-5) coinciden con caídas de ánimo o alteraciones de sueño.",
            },
        },
    }


@app.post("/api/dev/simulate")
def simulate_laya_inference(
    payload: Dict[str, str], user: dict = Depends(require_admin)
):
    """
    Permite probar cualquier texto arbitrario en vivo contra la batería de Laya
    y ver exactamente los porcentajes, tokens y tiempo de respuesta en milisegundos.
    """
    text = payload.get("text", "")
    if not text.strip():
        raise HTTPException(
            status_code=400, detail="El campo 'text' no puede estar vacío."
        )

    return classify_text_with_laya_detailed(text)


@app.post("/api/dev/reset-db")
def reset_database(
    repo: BaseDiaryRepository = Depends(get_repo),
    user: dict = Depends(require_admin),
):
    """
    Limpia por completo las notas rápidas, días guardados y feedback del usuario actual.
    """
    repo.reset_user_data()
    _clear_user_summary_cache(repo.user_id)
    last_dev_trace.set(
        repo.user_id,
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": "database_reset",
            "status": "clean",
            "message": "Base de datos reiniciada. Lista para nuevas pruebas.",
        },
    )

    return {
        "status": "success",
        "message": "Diario y base de datos reiniciados exitosamente.",
    }


@app.post("/api/dev/simulate-week")
def simulate_week(
    repo: BaseDiaryRepository = Depends(get_repo),
    user: dict = Depends(require_admin),
):
    """
    Genera automáticamente una simulación de 7 días consecutivos con textos,
    notas rápidas y cuestionarios realistas para probar analíticas y gráficas de inmediato.
    """
    today = date.today()

    simulated_data = [
        {
            "offset": 6,
            "quick": [("09:00", "Inicio de semana con café y revisión de objetivos del sprint.")],
            "text": "Lunes productivo. Tuvimos la reunión de planeación y definimos los objetivos de la semana con claridad. Me siento motivado.",
            "bed": "23:00", "wake": "07:00", "food": "si", "self": "bien", "val": 4, "ene": 4, "work": 3,
        },
        {
            "offset": 5,
            "quick": [("14:30", "El código del backend quedó listo antes de lo planeado.")],
            "text": "Martes de trabajo fluido. Me concentré durante cuatro horas seguidas sin distracciones y logré resolver los pendientes críticos.",
            "bed": "23:30", "wake": "07:30", "food": "si", "self": "bien", "val": 4, "ene": 3, "work": 3,
        },
        {
            "offset": 4,
            "quick": [("18:45", "Muchísima presión de última hora por cambios del cliente."), ("22:15", "Tengo dolor de cabeza y sigo pensando en los pendientes.")],
            "text": "Miércoles bastante pesado. El cliente pidió cambios radicales y tuvimos que quedarnos hasta tarde. Sentí tensión y cansancio acumulado.",
            "bed": "01:00", "wake": "06:30", "food": "a_medias", "self": "mal", "val": 2, "ene": 4, "work": 5,
        },
        {
            "offset": 3,
            "quick": [("13:00", "Salí a comer con unos amigos para despejar la mente.")],
            "text": "Jueves más tranquilo. Dormí una siesta corta para recuperarme del desvelo de ayer y charlé con mis compañeros. Me ayudó a recuperar la calma.",
            "bed": "23:15", "wake": "07:15", "food": "si", "self": "regular", "val": 3, "ene": 2, "work": 3,
        },
        {
            "offset": 2,
            "quick": [("17:00", "Entregamos la versión final a tiempo.")],
            "text": "¡Viernes de éxito! Desplegamos la nueva versión del proyecto y no hubo ningún bug. Salimos a cenar para celebrar el esfuerzo del equipo.",
            "bed": "00:00", "wake": "08:30", "food": "si", "self": "bien", "val": 5, "ene": 4, "work": 4,
        },
        {
            "offset": 1,
            "quick": [("11:00", "Paseo en bicicleta por el parque bajo el sol.")],
            "text": "Sábado relajante y al aire libre. Desconecté totalmente del trabajo, cociné algo rico y descansé viendo una serie.",
            "bed": "23:30", "wake": "08:30", "food": "si", "self": "bien", "val": 5, "ene": 3, "work": 1,
        },
        {
            "offset": 0,
            "quick": [("10:30", "Mañana tranquila de domingo y café caliente.")],
            "text": "Domingo sereno. Ordené mis cosas, regué las plantas y me preparé mentalmente para una buena semana. Me siento en paz.",
            "bed": "23:00", "wake": "07:00", "food": "si", "self": "bien", "val": 4, "ene": 3, "work": 2,
        },
    ]

    user_profile = repo.get_user_profile()
    created_dates = []
    for day in simulated_data:
        target_date = (today - timedelta(days=day["offset"])).strftime("%Y-%m-%d")

        for t_str, q_text in day["quick"]:
            repo.save_quick_note(QuickNoteCreate(date=target_date, time=t_str, text=q_text))

        sleep_calc = calculate_sleep_hours(day["bed"], day["wake"])
        q_obj = Questionnaire(
            sleep_bedtime=day["bed"],
            sleep_wakeup=day["wake"],
            sleep_hours=sleep_calc,
            food_routine=day["food"],
            self_report_word=day["self"],
            valence_rating=day["val"],
            energy_rating=day["ene"],
            workload_rating=day["work"],
        )

        full_text = (
            day["text"]
            + "\n\nNotas rápidas del día:\n"
            + "\n".join([f"[{t}] {txt}" for t, txt in day["quick"]])
        )
        laya_profile = classify_text_with_laya(full_text)
        discrepancy = detect_discrepancy(q_obj, laya_profile)
        safety = evaluate_safety(
            full_text, laya_profile.senales_alerta if laya_profile else None
        )
        goal_alignment = evaluate_daily_goal_alignment(q_obj, laya_profile, user_profile)

        repo.save_or_update_day_entry(
            entry=DayEntryCreate(date=target_date, day_text=day["text"], questionnaire=q_obj),
            laya_profile=laya_profile,
            discrepancy=discrepancy,
            safety=safety,
            goal_alignment=goal_alignment,
        )
        created_dates.append(target_date)

    _clear_user_summary_cache(repo.user_id)
    return {
        "status": "success",
        "created_days": len(created_dates),
        "dates": created_dates,
        "message": f"Se han simulado {len(created_dates)} días completos con Laya AI y analíticas.",
    }


# --- Servir Frontend Estático ---
if config.FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(config.FRONTEND_DIR)), name="static")

    @app.get("/")
    def serve_index():
        return FileResponse(str(config.FRONTEND_DIR / "index.html"))

    @app.get("/{full_path:path}")
    def serve_static_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="No encontrado")
        root = config.FRONTEND_DIR.resolve()
        requested = (config.FRONTEND_DIR / full_path).resolve()
        # Evita path traversal fuera del directorio del frontend.
        if requested != root and root not in requested.parents:
            raise HTTPException(status_code=404, detail="No encontrado")
        if requested.is_file():
            return FileResponse(str(requested))
        return FileResponse(str(root / "index.html"))
