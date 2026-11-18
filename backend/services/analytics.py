"""
Cálculos deterministas en Python puro para Diario Inteligente.
Garantiza cero aritmética por LLM y cálculos precisos de horas de sueño,
rachas, comparativas contra línea base personal y detección de discrepancias.
"""

from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Tuple, Any
from backend.models.schema import (
    DayEntry, Questionnaire, LayaProfile,
    DiscrepancyResult, BaselineMetrics, TimeSeriesPoint,
    GoalAlignmentSignal, GoalAlignmentSummary,
    UserProfileBase, SelfAssessment, CompanionState
)

VALENCE_SCORE_MAP = {
    "muy_negativo": 1.0,
    "negativo": 2.0,
    "neutro": 3.0,
    "positivo": 4.0,
    "muy_positivo": 5.0
}

ENERGY_SCORE_MAP = {
    "agotamiento_baja": 1.5,
    "calma_estable": 3.0,
    "tension_alta": 4.0,
    "entusiasmo_alta": 5.0
}

def calculate_sleep_hours(bedtime: Optional[str], wakeup: Optional[str]) -> float:
    """
    Calcula las horas reales de sueño a partir de HH:MM de acostarse y despertar,
    manejando correctamente el cruce de medianoche.
    """
    if not bedtime or not wakeup:
        return 8.0

    try:
        t_bed = datetime.strptime(bedtime.strip(), "%H:%M")
        t_wake = datetime.strptime(wakeup.strip(), "%H:%M")

        # Si despertar es anterior o igual a acostarse, cruzó la medianoche
        if t_wake <= t_bed:
            t_wake += timedelta(days=1)

        diff = t_wake - t_bed
        hours = round(diff.total_seconds() / 3600.0, 2)
        # Limitar a rango razonable (0 a 24 horas)
        return max(0.5, min(24.0, hours))
    except Exception:
        return 8.0

def detect_discrepancy(
    questionnaire: Questionnaire,
    laya_profile: Optional[LayaProfile]
) -> DiscrepancyResult:
    """
    Detecta si existe una divergencia marcada entre el auto-reporte en una palabra
    del usuario (Bien, Regular, Mal, No sé) y la valencia emocional objetiva
    calculada por Laya a partir del texto del día.
    """
    if not laya_profile:
        return DiscrepancyResult(has_discrepancy=False, level="none")

    self_report = questionnaire.self_report_word.lower()
    valencia_choice = laya_profile.valencia_emocional.choice
    valencia_probs = laya_profile.valencia_emocional.probabilities
    p_negativo_total = valencia_probs.get("muy_negativo", 0.0) + valencia_probs.get("negativo", 0.0)
    p_positivo_total = valencia_probs.get("muy_positivo", 0.0) + valencia_probs.get("positivo", 0.0)

    # Caso 1: Usuario dice "bien", pero el texto refleja valencia negativa muy marcada
    if self_report == "bien" and (valencia_choice in ["muy_negativo", "negativo"] or p_negativo_total >= 0.65):
        return DiscrepancyResult(
            has_discrepancy=True,
            level="marked",
            message=(
                "Tu auto-reporte indica que te sentiste 'Bien', sin embargo, tu escrito "
                "refleja palabras con tono de tensión o malestar. ¿Sientes que estás minimizando "
                "lo que te ocurrió hoy para seguir adelante?"
            ),
            details={
                "self_report": self_report,
                "laya_choice": valencia_choice,
                "p_negativo": round(p_negativo_total, 3),
                "type": "positivo_enmascara_negativo"
            }
        )

    # Caso 2: Usuario dice "mal", pero el texto describe logros y satisfacción
    if self_report == "mal" and (valencia_choice in ["muy_positivo", "positivo"] or p_positivo_total >= 0.70):
        return DiscrepancyResult(
            has_discrepancy=True,
            level="marked",
            message=(
                "Calificaste tu día como 'Mal', aunque tus notas destacan elementos positivos o avances. "
                "A veces un solo evento incómodo puede opacar las cosas gratas del día."
            ),
            details={
                "self_report": self_report,
                "laya_choice": valencia_choice,
                "p_positivo": round(p_positivo_total, 3),
                "type": "negativo_opaca_positivo"
            }
        )

    # Caso 3: Usuario dice "no sé" con señales de sobrecarga mental o contradicción
    if self_report == "no_se":
        contradiccion = laya_profile.senales_alerta.get("contradiccion_emocional", 0.0)
        carga = laya_profile.ejes_tematicos.get("carga_mental", 0.0)
        if contradiccion > 0.60 or carga > 0.60:
            return DiscrepancyResult(
                has_discrepancy=True,
                level="mild",
                message=(
                    "Seleccionaste 'No sé'. Es comprensible cuando conviven emociones encontradas "
                    "o hay mucha saturación de pensamientos simultáneos."
                ),
                details={"self_report": self_report, "contradiccion": contradiccion, "carga": carga}
            )

    return DiscrepancyResult(has_discrepancy=False, level="none")

def compute_streaks(entries: List[DayEntry]) -> int:
    """
    Calcula la racha actual de días consecutivos registrados en el diario,
    tomando como ancla de referencia la fecha del último registro disponible en el historial
    (soporta días simulados hacia adelante o atrás respecto al reloj del sistema).
    """
    if not entries:
        return 0

    dates = sorted(list({datetime.strptime(e.date, "%Y-%m-%d").date() for e in entries}), reverse=True)
    if not dates:
        return 0

    streak = 1
    for i in range(len(dates) - 1):
        if (dates[i] - dates[i+1]).days == 1:
            streak += 1
        else:
            break
    return streak

def compute_personal_baseline(entries: List[DayEntry]) -> BaselineMetrics:
    """
    Calcula la línea base personal del usuario a partir de sus entradas históricas.
    Nunca compara contra promedios externos.
    """
    if not entries:
        return BaselineMetrics()

    n = len(entries)
    sleep_sum = sum(e.questionnaire.sleep_hours for e in entries)
    valence_user_sum = sum(e.questionnaire.valence_rating for e in entries)
    energy_user_sum = sum(e.questionnaire.energy_rating for e in entries)
    workload_sum = sum(e.questionnaire.workload_rating for e in entries)

    # Valores Laya
    laya_valence_scores = []
    laya_energy_scores = []
    primary_emotions: Dict[str, int] = {}
    discrepancy_count = 0

    for e in entries:
        if e.discrepancy and e.discrepancy.has_discrepancy:
            discrepancy_count += 1

        if e.laya_profile:
            laya_valence_scores.append(e.laya_profile.valencia_score_estimada)
            c_energy = e.laya_profile.activacion_energia.choice
            laya_energy_scores.append(ENERGY_SCORE_MAP.get(c_energy, 3.0))

            c_emotion = e.laya_profile.emocion_primaria.choice
            primary_emotions[c_emotion] = primary_emotions.get(c_emotion, 0) + 1
        else:
            laya_valence_scores.append(float(e.questionnaire.valence_rating))
            laya_energy_scores.append(float(e.questionnaire.energy_rating))

    predominant_emotion = max(primary_emotions.items(), key=lambda x: x[1])[0] if primary_emotions else "calma"

    return BaselineMetrics(
        total_days=n,
        current_streak=compute_streaks(entries),
        avg_sleep_hours=round(sleep_sum / n, 2),
        avg_valence_user=round(valence_user_sum / n, 2),
        avg_valence_laya=round(sum(laya_valence_scores) / len(laya_valence_scores), 2) if laya_valence_scores else 3.0,
        avg_energy_user=round(energy_user_sum / n, 2),
        avg_energy_laya=round(sum(laya_energy_scores) / len(laya_energy_scores), 2) if laya_energy_scores else 3.0,
        avg_workload=round(workload_sum / n, 2),
        predominant_primary_emotion=predominant_emotion,
        discrepancy_count=discrepancy_count
    )

def build_time_series(entries: List[DayEntry]) -> List[TimeSeriesPoint]:
    """Construye los puntos de la serie temporal para gráficas superponibles ordenados por fecha."""
    sorted_entries = sorted(entries, key=lambda e: e.date)
    points = []
    for e in sorted_entries:
        v_laya = e.laya_profile.valencia_score_estimada if e.laya_profile else float(e.questionnaire.valence_rating)
        e_choice = e.laya_profile.activacion_energia.choice if e.laya_profile else None
        e_laya = ENERGY_SCORE_MAP.get(e_choice, float(e.questionnaire.energy_rating)) if e_choice else float(e.questionnaire.energy_rating)
        p_emo = e.laya_profile.emocion_primaria.choice if e.laya_profile else "neutro"

        points.append(TimeSeriesPoint(
            date=e.date,
            valence_user=float(e.questionnaire.valence_rating),
            valence_laya=round(v_laya, 2),
            energy_user=float(e.questionnaire.energy_rating),
            energy_laya=round(e_laya, 2),
            sleep_hours=e.questionnaire.sleep_hours,
            workload=float(e.questionnaire.workload_rating),
            has_discrepancy=bool(e.discrepancy and e.discrepancy.has_discrepancy),
            primary_emotion=p_emo
        ))
    return points


# ==============================================================================
# Onboarding Radar, Alineación con Metas, Filtros y Autoevaluaciones No Clínicas
# ==============================================================================

DAILY_GOAL_MINUTES_MAP = {
    "facil": 5,
    "normal": 10,
    "serio": 15,
    "intensivo": 20
}

def compute_onboarding_radar(profile: UserProfileBase) -> Dict[str, float]:
    """
    Calcula deterministamente los 5 ejes de enfoque iniciales (0 a 100)
    a partir de las metas y hábitos declarados en el Onboarding.
    Valores más altos representan mayor prioridad/enfoque en esa área.
    """
    habits = set(profile.habits_to_improve or [])
    areas = set(profile.stress_areas or [])
    obj = profile.personal_objective or "constancia"
    morning = profile.morning_habit or "cafe"

    descanso = 45.0
    if "dormir_tarde" in habits:
        descanso += 25.0
    if profile.sleep_improvement_goal in ["dormir_mas_horas", "horario_fijo", "dejar_pantallas"]:
        descanso += 15.0
    if "salud" in areas:
        descanso += 10.0

    limites = 45.0
    if "redes_sociales" in habits:
        limites += 20.0
    if obj == "limites_sanos":
        limites += 25.0
    if "familia_pareja" in areas or "trabajo_estudio" in areas:
        limites += 10.0

    carga_mental = 45.0
    if "carga_mental" in areas:
        carga_mental += 25.0
    if "procrastinar" in habits:
        carga_mental += 15.0
    if "trabajo_estudio" in areas or "economia" in areas:
        carga_mental += 10.0

    constancia = 50.0
    goal_boost = {"facil": 15.0, "normal": 25.0, "serio": 35.0, "intensivo": 42.0}
    constancia += goal_boost.get(profile.daily_goal_level, 25.0)
    if obj == "constancia" or morning in ["ejercicio", "planificar"]:
        constancia += 8.0

    manejo_estres = 45.0
    if obj in ["control_emocional", "mas_energia"]:
        manejo_estres += 25.0
    if "trabajo_estudio" in areas or "carga_mental" in areas:
        manejo_estres += 15.0
    if "comer_deshoras" in habits or "olvidar_pausas" in habits:
        manejo_estres += 10.0

    return {
        "Descanso": round(min(98.0, descanso), 1),
        "Límites": round(min(98.0, limites), 1),
        "Carga mental": round(min(98.0, carga_mental), 1),
        "Constancia": round(min(98.0, constancia), 1),
        "Manejo del estrés": round(min(98.0, manejo_estres), 1),
    }


def _is_late_bedtime(bedtime: Optional[str]) -> bool:
    """Detecta si la hora de acostarse fue igual o posterior a medianoche (00:00-04:59)."""
    if not bedtime:
        return False
    try:
        hour = int(bedtime.strip().split(":")[0])
        return 0 <= hour < 5
    except Exception:
        return False


def evaluate_daily_goal_alignment(
    questionnaire: Questionnaire,
    laya_profile: Optional[LayaProfile],
    user_profile: UserProfileBase
) -> GoalAlignmentSummary:
    """
    Cruza en Python puro lo que el usuario registró y escribió hoy frente a sus metas
    y hábitos elegidos en el Onboarding (cero lenguaje clínico).
    """
    signals: List[GoalAlignmentSignal] = []
    habits = set(user_profile.habits_to_improve or [])
    areas = set(user_profile.stress_areas or [])
    obj = user_profile.personal_objective

    ejes = laya_profile.ejes_tematicos if laya_profile else {}
    val_score = laya_profile.valencia_score_estimada if laya_profile else float(questionnaire.valence_rating)

    checks_total = 0
    checks_met = 0

    # 1. Cruce de Sueño y Descanso vs Meta de Sueño
    wants_sleep_care = (
        "dormir_tarde" in habits
        or bool(user_profile.sleep_improvement_goal)
        or obj == "mas_energia"
    )
    if wants_sleep_care:
        checks_total += 1
        if questionnaire.sleep_hours < 6.5 or _is_late_bedtime(questionnaire.sleep_bedtime):
            signals.append(GoalAlignmentSignal(
                area="Descanso",
                signal=(
                    f"Señal frente a tu meta de descanso: registraste {questionnaire.sleep_hours}h "
                    f"(acostarse {questionnaire.sleep_bedtime}). Sugerencia: procura adelantar tu cierre hoy."
                ),
                status="observacion"
            ))
        else:
            checks_met += 1
            signals.append(GoalAlignmentSignal(
                area="Descanso",
                signal=f"Patrón positivo de descanso: dormiste {questionnaire.sleep_hours}h, alineado con tu meta de sueño.",
                status="cumplido"
            ))

    # 2. Cruce de Carga Laboral y Límites vs Meta de Límites / Peso laboral
    wants_boundaries = obj == "limites_sanos" or "trabajo_estudio" in areas
    if wants_boundaries:
        checks_total += 1
        trabajo_prob = ejes.get("trabajo_estudio", 0.0)
        if questionnaire.workload_rating >= 4 or (trabajo_prob >= 0.70 and val_score < 3.0):
            signals.append(GoalAlignmentSignal(
                area="Límites y Carga",
                signal=(
                    "Señal de saturación frente a tu objetivo de límites sanos: hoy la carga laboral/académica "
                    "tuvo un peso alto en tu día."
                ),
                status="sugerencia"
            ))
        else:
            checks_met += 1
            signals.append(GoalAlignmentSignal(
                area="Límites y Carga",
                signal="Buen balance entre tus demandas del día y tu objetivo de límites sanos.",
                status="cumplido"
            ))

    # 3. Cruce de Alimentación vs Hábito de comer a deshoras
    if "comer_deshoras" in habits:
        checks_total += 1
        if questionnaire.food_routine == "si":
            checks_met += 1
            signals.append(GoalAlignmentSignal(
                area="Rutina física",
                signal="Cuidaste tus horarios de comida hoy, sumando puntos a tu meta diaria.",
                status="cumplido"
            ))
        else:
            signals.append(GoalAlignmentSignal(
                area="Rutina física",
                signal="Señal en alimentación: mencionaste no comer completamente a tus horas frente al hábito que quieres cuidar.",
                status="observacion"
            ))

    # 4. Cruce de Carga Mental / Procrastinación detectada por Laya
    carga_prob = ejes.get("carga_mental", 0.0)
    if ("carga_mental" in areas or "procrastinar" in habits) and carga_prob >= 0.65:
        signals.append(GoalAlignmentSignal(
            area="Carga mental",
            signal="Laya detectó una señal alta de carga mental o pendientes acumulados en tu escrito de hoy.",
            status="sugerencia"
        ))

    adherence = round((checks_met / checks_total) * 100.0, 1) if checks_total > 0 else 100.0
    return GoalAlignmentSummary(signals=signals, adherence_score=adherence)


def filter_entries_by_period(entries: List[DayEntry], days: int = 0) -> List[DayEntry]:
    """Filtra las entradas tomando como referencia el último registro en BD."""
    if not entries or days <= 0:
        return entries
    latest_date = max(datetime.strptime(e.date, "%Y-%m-%d").date() for e in entries)
    cutoff = latest_date - timedelta(days=days - 1)
    return [
        e for e in entries
        if datetime.strptime(e.date, "%Y-%m-%d").date() >= cutoff
    ]


def classify_entry_mood_category(entry: DayEntry) -> str:
    """
    Clasifica un día en una de las 5 categorías de valencia para calendario y distribución.
    Cualquier día con alerta roja de seguridad o valencia promedio <= 2.0 se clasifica
    como 'muy_negativo' ('Muy difícil').
    """
    is_red_alert = bool(
        entry.safety and entry.safety.is_triggered and entry.safety.level == "alert"
    )
    score = (
        float(entry.laya_profile.valencia_score_estimada)
        if entry.laya_profile
        else float(entry.questionnaire.valence_rating)
    )
    if is_red_alert or score <= 2.0:
        return "muy_negativo"
    if score >= 4.2:
        return "muy_positivo"
    if score >= 3.4:
        return "positivo"
    if score >= 2.6:
        return "neutro"
    return "negativo"


def compute_mood_distribution(entries: List[DayEntry]) -> Dict[str, int]:
    """Cuenta días por categoría de valencia emocional alineada con el calendario."""
    dist = {
        "muy_positivo": 0,
        "positivo": 0,
        "neutro": 0,
        "negativo": 0,
        "muy_negativo": 0
    }
    for e in entries:
        cat = classify_entry_mood_category(e)
        dist[cat] += 1
    return dist


def compute_laya_axes_averages(entries: List[DayEntry]) -> Dict[str, float]:
    """Promedia en porcentaje (0-100) los 5 ejes temáticos detectados por Laya."""
    totals = {
        "trabajo_estudio": 0.0,
        "descanso_sueno": 0.0,
        "relaciones_familia": 0.0,
        "salud_cuerpo": 0.0,
        "carga_mental": 0.0,
    }
    count = 0
    for e in entries:
        if e.laya_profile and e.laya_profile.ejes_tematicos:
            count += 1
            for k in totals:
                totals[k] += float(e.laya_profile.ejes_tematicos.get(k, 0.0)) * 100.0
    if count == 0:
        return {k: 0.0 for k in totals}
    return {k: round(v / count, 1) for k, v in totals.items()}


def compute_period_goal_cross_insights(entries: List[DayEntry], user_profile: UserProfileBase) -> List[str]:
    """Genera insights en español no clínico cruzando el periodo con los objetivos del usuario."""
    if not entries:
        return []

    insights: List[str] = []
    n = len(entries)
    habits = set(user_profile.habits_to_improve or [])
    areas = set(user_profile.stress_areas or [])

    # 1. Revisar desvelos / poco sueño frente a objetivo de sueño
    short_sleep_days = sum(
        1 for e in entries
        if e.questionnaire.sleep_hours < 6.5 or _is_late_bedtime(e.questionnaire.sleep_bedtime)
    )
    if "dormir_tarde" in habits or user_profile.sleep_improvement_goal:
        if short_sleep_days > 0:
            insights.append(
                f"Señal en descanso: en {short_sleep_days} de {n} días registraste desvelo o menos de 6.5h de sueño frente a tu meta."
            )
        else:
            insights.append(
                f"Patrón positivo de descanso: cumpliste tu meta de horas de sueño en los {n} días analizados."
            )

    # 2. Revisar picos de carga laboral frente a objetivo de límites sanos
    high_load_days = sum(1 for e in entries if e.questionnaire.workload_rating >= 4)
    if user_profile.personal_objective == "limites_sanos" or "trabajo_estudio" in areas:
        if high_load_days > 0:
            insights.append(
                f"Patrón de demanda laboral: {high_load_days} días presentaron carga alta (4-5/5) respecto a tu enfoque de límites sanos."
            )

    # 3. Revisar comidas a tiempo si el hábito fue seleccionado
    if "comer_deshoras" in habits:
        irregular_food = sum(1 for e in entries if e.questionnaire.food_routine != "si")
        if irregular_food > 0:
            insights.append(
                f"Señal de rutina alimentaria: {irregular_food} de {n} días mostraron comidas fuera de horario."
            )

    # 4. Carga mental recurrente en textos
    mental_load_days = sum(
        1 for e in entries
        if e.laya_profile and e.laya_profile.ejes_tematicos.get("carga_mental", 0.0) >= 0.65
    )
    if mental_load_days > 0:
        insights.append(
            f"Laya identificó saturación o carga mental marcada en {mental_load_days} de {n} días del periodo."
        )

    return insights


def compute_combined_personal_radar(
    user_profile: UserProfileBase,
    self_assessments: List[SelfAssessment],
    entries: List[DayEntry]
) -> Dict[str, float]:
    """Combina el radar de onboarding con autoevaluaciones recientes y constancia en el diario."""
    base_radar = dict(user_profile.radar_focus or compute_onboarding_radar(user_profile))

    # Ajustar por última autoevaluación por quiz_id
    seen_quizzes = set()
    for sa in self_assessments:
        if sa.quiz_id in seen_quizzes:
            continue
        seen_quizzes.add(sa.quiz_id)
        for axis, impact in sa.radar_impacts.items():
            if axis in base_radar:
                base_radar[axis] = round((base_radar[axis] * 0.55) + (impact * 0.45), 1)

    # Ajustar Constancia por racha real
    if entries:
        streak = compute_streaks(entries)
        streak_score = min(100.0, 40.0 + streak * 8.5)
        base_radar["Constancia"] = round((base_radar.get("Constancia", 60.0) * 0.5) + (streak_score * 0.5), 1)

    return base_radar


# Catálogo de Autoevaluaciones / Retos de Hábitos (Estrictamente No Clínico)
SELF_ASSESSMENT_QUIZZES: Dict[str, Dict[str, Any]] = {
    "procrastinacion": {
        "id": "procrastinacion",
        "title": "Estilo ante la Procrastinación",
        "icon": "⏳",
        "subtitle": "Explora qué detona postergar tareas y cómo suavizar el arranque.",
        "duration": "1 min · 4 preguntas",
        "axes": ["Carga mental", "Constancia"],
        "questions": [
            {"id": "q1", "text": "Cuando una tarea parece grande, ¿sueles aplazarla buscando primero el momento ideal?"},
            {"id": "q2", "text": "¿Cambias rápidamente hacia el celular o tareas pequeñas para evitar iniciar lo importante?"},
            {"id": "q3", "text": "¿Sientes que la exigencia de hacerlo perfecto termina frenando tu primer paso?"},
            {"id": "q4", "text": "¿Terminas el día con cansancio mental por pensar en pendientes que dejaste en pausa?"}
        ]
    },
    "limites_descanso": {
        "id": "limites_descanso",
        "title": "Límites y Descanso Digital",
        "icon": "🛡️",
        "subtitle": "Observa qué tan protegidos están tus horarios de cierre y tu desconexión nocturna.",
        "duration": "1 min · 4 preguntas",
        "axes": ["Límites", "Descanso"],
        "questions": [
            {"id": "q1", "text": "¿Revisas mensajes laborales o pendientes cuando ya habías decidido descansar?"},
            {"id": "q2", "text": "¿Las pantallas nocturnas terminan recorriendo tu hora habitual de dormir?"},
            {"id": "q3", "text": "¿Te cuesta decir 'no' o posponer un favor aunque ya sientas la agenda llena?"},
            {"id": "q4", "text": "¿Sientes que tus jornadas se mezclan sin un momento claro de cierre?"}
        ]
    },
    "carga_mental": {
        "id": "carga_mental",
        "title": "Balance de Carga Mental",
        "icon": "🧠",
        "subtitle": "Mide cuántas 'pestañas abiertas' llevas contigo vs espacios de pausa.",
        "duration": "1 min · 4 preguntas",
        "axes": ["Carga mental", "Manejo del estrés"],
        "questions": [
            {"id": "q1", "text": "¿Sientes que cargas demasiados recordatorios y pendientes dando vueltas en tu cabeza?"},
            {"id": "q2", "text": "¿Avanzas en tu rutina en piloto automático sin notar cómo respira o se siente tu cuerpo?"},
            {"id": "q3", "text": "¿Repasas tareas del día siguiente justo cuando intentas relajarte por la noche?"},
            {"id": "q4", "text": "¿Sientes que te faltan pausas breves de cinco minutos sin estímulos durante el día?"}
        ]
    }
}


def evaluate_self_assessment(quiz_id: str, answers: Dict[str, int]) -> Dict[str, Any]:
    """Evalúa deterministamente un reto/autoevaluación práctica sin lenguaje clínico."""
    quiz = SELF_ASSESSMENT_QUIZZES.get(quiz_id)
    if not quiz:
        raise ValueError(f"Autoevaluación desconocida: {quiz_id}")

    vals = [max(1, min(4, int(answers.get(q["id"], 2)))) for q in quiz["questions"]]
    avg_val = sum(vals) / len(vals)
    # Convertir escala 1..4 de fricción a 0..100 de intensidad de señal
    intensity_pct = round(((avg_val - 1.0) / 3.0) * 100.0, 1)

    if intensity_pct >= 65.0:
        result_label = "Señal alta de fricción cotidiana"
        if quiz_id == "procrastinacion":
            reflection = (
                "Se aprecia un patrón de freno antes de comenzar, muchas veces ligado a saturación o perfeccionismo. "
                "Sugerencia: prueba la regla de los 5 minutos iniciando con un paso minúsculo e imperfecto."
            )
        elif quiz_id == "limites_descanso":
            reflection = (
                "Tu descanso nocturno está compitiendo con pendientes digitales y horarios abiertos. "
                "Sugerencia: fija una 'alarma de cierre de pantalla' 30 minutos antes de tu hora objetivo."
            )
        else:
            reflection = (
                "Llevas bastante ruido mental activo fuera de horario. "
                "Sugerencia: vacía tus pendientes en 'Nota Rápida' antes de dormir para liberar espacio mental."
            )
    elif intensity_pct >= 35.0:
        result_label = "Equilibrio en construcción"
        reflection = (
            "Manejas varias situaciones con fluidez, aunque aparecen señales intermitentes de desgaste en días exigentes. "
            "Sugerencia: conserva una micro-pausa intencional a mitad de tarde."
        )
    else:
        result_label = "Ritmo sano y consciente"
        reflection = (
            "Tus respuestas reflejan un patrón saludable y claro en esta área. "
            "Sugerencia: continúa usando tu diario para notar a tiempo cualquier cambio en tu rutina."
        )

    radar_impacts = {}
    for axis in quiz["axes"]:
        # Mayor intensidad de fricción -> sube el enfoque/prioridad en el radar (entre 40 y 95)
        radar_impacts[axis] = round(max(40.0, min(95.0, 40.0 + intensity_pct * 0.55)), 1)

    return {
        "quiz_id": quiz_id,
        "quiz_title": quiz["title"],
        "answers": answers,
        "score_pct": intensity_pct,
        "result_label": result_label,
        "reflection_message": reflection,
        "radar_impacts": radar_impacts
    }


# ==============================================================================
# Compañero Cozy & Progresión RPG No Clínica (EXP, Monedas, Santuario y Tienda)
# ==============================================================================

COMPANION_SHOP_ITEMS: Dict[str, Dict[str, Any]] = {
    "te_tibio": {
        "id": "te_tibio",
        "name": "Té de Manzanilla",
        "icon": "🍵",
        "type": "snack",
        "price": 12,
        "desc": "+18 Saciedad, +15 Energía serena",
        "satiety": 18,
        "energy": 15,
        "mood": 8,
        "bond": 5
    },
    "galleta_miel": {
        "id": "galleta_miel",
        "name": "Galleta de Miel",
        "icon": "🍪",
        "type": "snack",
        "price": 10,
        "desc": "+20 Saciedad, +12 Ánimo",
        "satiety": 20,
        "energy": 5,
        "mood": 12,
        "bond": 5
    },
    "pan_tibio": {
        "id": "pan_tibio",
        "name": "Panecito Recién Horneado",
        "icon": "🥐",
        "type": "snack",
        "price": 18,
        "desc": "+30 Saciedad, +15 Ánimo, +8 Vínculo",
        "satiety": 30,
        "energy": 10,
        "mood": 15,
        "bond": 8
    },
    "slime_menta": {
        "id": "slime_menta",
        "name": "Esencia Slime Menta",
        "icon": "🌿",
        "type": "variant",
        "price": 45,
        "desc": "Color verde menta relajante para tu compañero"
    },
    "slime_lavanda": {
        "id": "slime_lavanda",
        "name": "Esencia Slime Lavanda",
        "icon": "🔮",
        "type": "variant",
        "price": 60,
        "desc": "Tono lavanda nocturno místico para tu compañero"
    }
}

ADVENTURER_TITLES = [
    "Aprendiz Sereno",
    "Explorador Consciente",
    "Cronista de Calma",
    "Guardián del Ritmo",
    "Sabio del Equilibrio"
]

def get_adventurer_title(level: int) -> str:
    idx = min(len(ADVENTURER_TITLES) - 1, max(0, (level - 1) // 2))
    return ADVENTURER_TITLES[idx]


def apply_companion_reward(
    companion: CompanionState,
    exp_gain: int = 0,
    coins_gain: int = 0,
    sleep_hours: Optional[float] = None,
    valence_score: Optional[float] = None
) -> CompanionState:
    """Actualiza EXP, nivel, monedas y estadísticas del compañero en Python puro."""
    comp = companion.model_copy(deep=True)
    comp.coins = max(0, comp.coins + coins_gain)
    comp.exp = max(0, comp.exp + exp_gain)

    while comp.exp >= comp.next_level_exp:
        comp.exp -= comp.next_level_exp
        comp.level += 1
        comp.next_level_exp = round(100 * (1.35 ** (comp.level - 1)))
        comp.bond = min(100, comp.bond + 10)

    if sleep_hours is not None:
        if sleep_hours >= 7.0:
            comp.energy = min(100, comp.energy + 12)
        elif sleep_hours < 6.0:
            comp.energy = max(25, comp.energy - 8)

    if valence_score is not None:
        if valence_score >= 3.5:
            comp.mood = min(100, comp.mood + 8)
        elif valence_score < 2.5:
            # En días difíciles el compañero acompaña con vínculo
            comp.bond = min(100, comp.bond + 4)

    comp.bond = max(0, min(100, comp.bond + (2 if exp_gain > 0 else 0)))
    return comp


def execute_companion_action(companion: CompanionState, action: str, value: Optional[str] = None) -> Tuple[CompanionState, str]:
    """Ejecuta interacciones del Santuario y Tienda RPG."""
    comp = companion.model_copy(deep=True)

    if action == "pet":
        comp.mood = min(100, comp.mood + 10)
        comp.bond = min(100, comp.bond + 3)
        return comp, f"Acariciaste a {comp.name}. ¡Se siente acompañado! (+Ánimo)"

    if action == "rest":
        comp.energy = min(100, comp.energy + 20)
        comp.mood = min(100, comp.mood + 4)
        return comp, f"{comp.name} tomó una siesta serena (+20 Energía)."

    if action == "snack":
        now = datetime.now(timezone.utc)
        if comp.last_snack_at:
            try:
                last_dt = datetime.fromisoformat(comp.last_snack_at)
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
                elapsed_min = (now - last_dt.astimezone(timezone.utc)).total_seconds() / 60.0
                if elapsed_min < 10.0:
                    rem = max(1, int(round(10.0 - elapsed_min)))
                    return comp, f"Espera {rem} min para el próximo snack gratis."
            except ValueError:
                pass
        comp.satiety = min(100, comp.satiety + 15)
        comp.mood = min(100, comp.mood + 6)
        comp.bond = min(100, comp.bond + 2)
        comp.last_snack_at = now.isoformat()
        return comp, f"¡{comp.name} disfrutó un bocadillo gratis!"

    if action == "rename" and value:
        clean_name = value.strip()[:20]
        if clean_name:
            comp.name = clean_name
            return comp, f"Tu compañero ahora se llama {clean_name}."

    if action == "buy" and value:
        item = COMPANION_SHOP_ITEMS.get(value)
        if not item:
            return comp, "Artículo no encontrado."
        if comp.coins < item["price"]:
            return comp, f"Necesitas {item['price']} monedas (tienes {comp.coins}). Escribe en tu diario para ganar más."

        if item["type"] == "variant":
            if item["id"] in comp.unlocked_variants:
                comp.variant = item["id"]
                return comp, f"Ya tenías {item['name']}; ¡equipado!"
            comp.coins -= item["price"]
            comp.unlocked_variants.append(item["id"])
            comp.variant = item["id"]
            return comp, f"¡Desbloqueaste y equipaste {item['name']}!"
        else:
            comp.coins -= item["price"]
            comp.pantry[item["id"]] = comp.pantry.get(item["id"], 0) + 1
            return comp, f"Compraste {item['name']}. ¡Ahora está en tu despensa!"

    if action == "feed" and value:
        qty = comp.pantry.get(value, 0)
        item = COMPANION_SHOP_ITEMS.get(value)
        if qty <= 0 or not item:
            return comp, "No tienes ese bocadillo en la despensa."
        comp.pantry[value] = qty - 1
        if comp.pantry[value] <= 0:
            del comp.pantry[value]
        comp.satiety = min(100, comp.satiety + item.get("satiety", 15))
        comp.energy = min(100, comp.energy + item.get("energy", 5))
        comp.mood = min(100, comp.mood + item.get("mood", 10))
        comp.bond = min(100, comp.bond + item.get("bond", 5))
        return comp, f"¡{comp.name} disfrutó {item['name']}!"

    if action == "equip_variant" and value:
        if value in comp.unlocked_variants or value == "slime_azul":
            comp.variant = value
            return comp, "Aspecto de compañero actualizado."

    return comp, "Acción completada."
