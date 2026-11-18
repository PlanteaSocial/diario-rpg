"""
Motor de clasificación primario — Laya AI (convaiinnovations/laya, checkpoint multilingual).
Ejecuta la batería de preguntas tipadas en paralelo (choice, score, noul) devolviendo
porcentajes calibrados en una sola pasada (~33 ms).
Estricto principio: 'Decisions, not text' y menos de 20 opciones por pregunta.
"""

from pathlib import Path
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from backend.config import LAYA_MODEL_ID, LAYA_SUBFOLDER, PROJECT_ROOT
from backend.models.schema import LayaProfile, LayaCategoryResult
from backend.services.laya_fallback import FALLBACK_AGENT

try:  # El modelo es opcional: en Linux sin GPU/torch la app usa el respaldo local.
    import laya  # type: ignore
    LAYA_AVAILABLE = True
    LAYA_IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # ImportError, OSError por DLLs, etc.
    laya = None  # type: ignore
    LAYA_AVAILABLE = False
    LAYA_IMPORT_ERROR = str(exc)

_agent_instance = None
_agent_lock = threading.Lock()
FINETUNED_DIR = PROJECT_ROOT / "data" / "checkpoints" / "laya_finetuned"


def laya_backend_name() -> str:
    """Nombre legible del motor de clasificación activo."""
    if getattr(_agent_instance, "backend", "") == "heuristica-local":
        return "heuristica-local (laya no disponible)"
    if LAYA_AVAILABLE:
        return "laya"
    return "heuristica-local (laya no instalado)"


def get_laya_agent():
    """Retorna el agente Laya multilingüe o, si no está instalado, el respaldo local."""
    global _agent_instance
    if _agent_instance is None:
        with _agent_lock:
            if _agent_instance is None:
                if not LAYA_AVAILABLE:
                    print("ℹ Motor Laya no disponible; usando clasificador heurístico local.")
                    _agent_instance = FALLBACK_AGENT
                    return _agent_instance
                try:
                    try:
                        # Cargar checkpoint multilingüe base directamente (ModernBERT 322M)
                        _agent_instance = laya.load("ml")
                        print("✓ Cargando motor base multilingüe de Laya ('ml')")
                    except Exception:
                        _agent_instance = laya.load(LAYA_MODEL_ID, subfolder=LAYA_SUBFOLDER)
                except Exception as exc:
                    # Instalación rota o sin pesos: la app sigue funcionando.
                    print(f"⚠ Laya no pudo cargar ({exc}); usando clasificador heurístico local.")
                    _agent_instance = FALLBACK_AGENT
    return _agent_instance

# Definición de la batería paralela de preguntas estructuradas
LAYA_QUESTIONS: Dict[str, Dict[str, Any]] = {
    # 1. Valencia emocional (choice de 5 niveles)
    "valencia_emocional": {
        "type": "choice",
        "instructions": "¿Qué tono o valencia emocional predomina en el escrito?",
        "criteria": {
            "muy_negativo": "Profunda tristeza, dolor, desesperanza, llanto o gran angustia",
            "negativo": "Preocupación, frustración, enojo, malestar, cansancio molesto o quejas",
            "neutro": "Día ordinario, rutinario, tareas cotidianas sin emociones intensas",
            "positivo": "Alegría, tranquilidad, satisfacción, buen ánimo, alivio o motivación",
            "muy_positivo": "Gran entusiasmo, euforia, profunda gratitud o inmensa felicidad"
        }
    },
    # 2. Activación / Energía percibida (choice de 4 niveles)
    "activacion_energia": {
        "type": "choice",
        "instructions": "¿Qué nivel de energía o activación psicofisiológica refleja el texto?",
        "criteria": {
            "agotamiento_baja": "Cansancio extremo, falta de energía, fatiga, desánimo o lentitud",
            "calma_estable": "Serenidad, relajación, equilibrio emocional, paz o sosiego",
            "tension_alta": "Estrés, ansiedad, nerviosismo, agitación, prisa o sobrecarga",
            "entusiasmo_alta": "Dinamismo alto positivo, ímpetu, emoción, vitalidad y motivación"
        }
    },
    # 3. Emoción primaria (choice corto, 8 opciones < 10)
    "emocion_primaria": {
        "type": "choice",
        "instructions": "¿Cuál es la emoción o afecto dominante en el texto?",
        "criteria": {
            "alegria": "Felicidad, risas, contento, regocijo o satisfacción",
            "calma": "Paz interior, tranquilidad, descanso o serenidad",
            "estres": "Presión por tiempo, pendientes acumulados, exceso de trabajo o agobio",
            "tristeza": "Pena, desánimo, soledad, melancolía o pérdida",
            "frustracion": "Impotencia ante obstáculos, enojo por cosas que salieron mal",
            "ansiedad": "Inquietud por el futuro, miedo, zozobra o incertidumbre",
            "gratitud": "Agradecimiento sincero, valorar a personas o circunstancias",
            "apatia": "Desinterés, desgano, monotonía, sensación de vacío o indiferencia"
        }
    },
    # 4. Ejes temáticos (noul booleanos con redacción cotidiana explícita)
    "eje_trabajo_estudio": {
        "type": "noul",
        "instructions": "¿El texto habla sobre pendientes, tareas, entregas, trabajo o estudio?"
    },
    "eje_descanso_sueno": {
        "type": "noul",
        "instructions": "¿El texto habla de dormir, desvelo, siestas, calidad de sueño o descanso físico?"
    },
    "eje_relaciones_familia": {
        "type": "noul",
        "instructions": "¿El texto involucra a la pareja, amigos, familia, vida social o convivencia?"
    },
    "eje_salud_cuerpo": {
        "type": "noul",
        "instructions": "¿El texto menciona síntomas físicos, dolores, alimentación, ejercicio o bienestar corporal?"
    },
    "eje_carga_mental": {
        "type": "noul",
        "instructions": "¿El texto refleja saturación mental, piloto automático, lista interminable de pendientes o bloqueo?"
    },
    # 5. Señales de alerta o ambigüedad (noul booleanos)
    "sen_desgaste_sostenido": {
        "type": "noul",
        "instructions": "¿Hay indicios de agotamiento crónico, desesperanza continua o sensación de no poder más?"
    },
    "sen_contradiccion_emocional": {
        "type": "noul",
        "instructions": "¿El texto muestra contradicción emocional, como decir que todo está bien o 'no pasa nada' mientras expresa malestar o fastidio?"
    },
    "sen_riesgo_autolesion_purga": {
        "type": "noul",
        "instructions": "¿El texto expresa intención, pensamientos o actos de autolesión, hacerse daño físico, purga o restricción alimentaria intencional?"
    }
}

VALENCE_WEIGHTS = {
    "muy_negativo": 1.0,
    "negativo": 2.0,
    "neutro": 3.0,
    "positivo": 4.0,
    "muy_positivo": 5.0
}

def _parse_category(
    answers: Dict[str, Any], key: str, default_choice: str
) -> LayaCategoryResult:
    data = answers.get(key, {})
    choice = data.get("choice", default_choice)
    probs = data.get("probabilities", {default_choice: 1.0})
    conf = float(data.get("answer_confidence", 0.0))
    return LayaCategoryResult(
        choice=choice,
        probabilities={k: round(float(v), 4) for k, v in probs.items()},
        answer_confidence=round(conf, 4),
    )


def _build_profile_from_answers(
    answers: Dict[str, Any], usage: Optional[Dict[str, Any]]
) -> Tuple[LayaProfile, List[Dict[str, Any]], float]:
    valencia_cat = _parse_category(answers, "valencia_emocional", "neutro")
    activacion_cat = _parse_category(answers, "activacion_energia", "calma_estable")
    emocion_cat = _parse_category(answers, "emocion_primaria", "calma")

    calc_steps = []
    score_estimado = 0.0
    for cat, weight in VALENCE_WEIGHTS.items():
        p = valencia_cat.probabilities.get(cat, 0.0)
        contrib = p * weight
        score_estimado += contrib
        calc_steps.append(
            {
                "category": cat,
                "probability": round(p, 4),
                "percentage": f"{p * 100:.2f}%",
                "weight": weight,
                "contribution": round(contrib, 4),
            }
        )

    ejes = {
        "trabajo_estudio": round(float(answers.get("eje_trabajo_estudio", {}).get("noul", 0.0)), 4),
        "descanso_sueno": round(float(answers.get("eje_descanso_sueno", {}).get("noul", 0.0)), 4),
        "relaciones_familia": round(float(answers.get("eje_relaciones_familia", {}).get("noul", 0.0)), 4),
        "salud_cuerpo": round(float(answers.get("eje_salud_cuerpo", {}).get("noul", 0.0)), 4),
        "carga_mental": round(float(answers.get("eje_carga_mental", {}).get("noul", 0.0)), 4),
    }

    senales = {
        "desgaste_sostenido": round(float(answers.get("sen_desgaste_sostenido", {}).get("noul", 0.0)), 4),
        "contradiccion_emocional": round(float(answers.get("sen_contradiccion_emocional", {}).get("noul", 0.0)), 4),
        "riesgo_autolesion_purga": round(float(answers.get("sen_riesgo_autolesion_purga", {}).get("noul", 0.0)), 4),
    }

    profile = LayaProfile(
        valencia_emocional=valencia_cat,
        activacion_energia=activacion_cat,
        emocion_primaria=emocion_cat,
        ejes_tematicos=ejes,
        senales_alerta=senales,
        valencia_score_estimada=round(score_estimado, 2),
        raw_usage=usage,
    )
    return profile, calc_steps, round(score_estimado, 2)


def classify_text_with_laya(text: str) -> Optional[LayaProfile]:
    """
    Ejecuta la clasificación completa de Laya sobre el texto combinado del día.
    Retorna un LayaProfile con todas las distribuciones de probabilidad.
    """
    if not text or not text.strip():
        return None

    agent = get_laya_agent()
    result = agent.predict(text.strip(), LAYA_QUESTIONS)
    profile, _, _ = _build_profile_from_answers(
        result.get("answers", {}), result.get("usage")
    )
    return profile


def classify_text_with_laya_detailed(text: str) -> Dict[str, Any]:
    """
    Ejecuta la inferencia detallada de Laya capturando métricas de latencia,
    tokens, schema completo de preguntas y el desglose matemático de la valencia.
    """
    if not text or not text.strip():
        return {
            "error": "Texto vacío",
            "latency_ms": 0.0,
            "input_tokens": 0,
            "profile": None,
            "raw_answers": {},
            "raw_usage": {},
            "valence_calculation": {},
            "questions_schema": LAYA_QUESTIONS,
        }

    t0 = time.perf_counter()
    agent = get_laya_agent()
    result = agent.predict(text.strip(), LAYA_QUESTIONS)
    latency_ms = round((time.perf_counter() - t0) * 1000, 2)
    answers = result.get("answers", {})
    usage = result.get("usage", {})

    profile, calc_steps, final_score = _build_profile_from_answers(answers, usage)

    return {
        "text": text,
        "latency_ms": latency_ms,
        "input_tokens": usage.get("input_tokens", 0),
        "profile": profile.model_dump(),
        "raw_answers": answers,
        "raw_usage": usage,
        "valence_calculation": {
            "formula": "Score = Σ ( P(categoría_i) × Peso_i )",
            "weights": VALENCE_WEIGHTS,
            "steps": calc_steps,
            "final_score": final_score,
        },
        "questions_schema": LAYA_QUESTIONS,
    }
