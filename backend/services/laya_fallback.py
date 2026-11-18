"""
Motor de respaldo local para Laya (sin torch ni el paquete `laya`).

Diario RPG debe poder arrancar en cualquier Linux (o Windows) aunque el modelo
Laya no esté instalado. Este motor heurístico devuelve exactamente la misma
estructura de respuestas que `agent.predict(texto, preguntas)` para que el resto
del backend funcione sin cambios.

No sustituye al clasificador: es un respaldo transparente, determinista y
100% offline. Si `laya` está instalado, el motor real tiene prioridad.
"""

from __future__ import annotations

import re
import time
import unicodedata
from typing import Any, Dict, List, Tuple


def _fold(text: str) -> str:
    """Minúsculas y sin acentos, para comparar palabras de forma robusta."""
    lowered = (text or "").lower()
    decomposed = unicodedata.normalize("NFD", lowered)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def _count_hits(text: str, words: List[str]) -> int:
    hits = 0
    for word in words:
        needle = _fold(word)
        if not needle:
            continue
        if " " in needle:
            hits += text.count(needle)
        else:
            hits += len(re.findall(rf"\b{re.escape(needle)}\b", text))
    return hits


VALENCE_LEXICON: Dict[str, List[str]] = {
    "muy_negativo": [
        "no puedo mas", "sin salida", "desesperanza", "insoportable", "horrible",
        "vacio", "llorar", "lloro", "colapso", "hundido", "no aguanto", "todo mal",
    ],
    "negativo": [
        "cansado", "cansancio", "estres", "estresado", "preocupado", "enojo",
        "enojado", "frustrado", "triste", "ansiedad", "ansioso", "agotado",
        "mal dia", "fastidio", "harto", "pesado", "dificil", "molesto", "nervios",
        "dolor", "presion", "dormi mal", "desperte", "extrano", "preocupacion",
    ],
    "positivo": [
        "bien", "contento", "tranquilo", "logre", "bueno", "alegria", "gusto",
        "mejor", "descanso", "agradable", "bonito", "avance", "calma",
    ],
    "muy_positivo": [
        "increible", "feliz", "agradecido", "gratitud", "emocionado", "euforia",
        "maravilloso", "excelente", "gran dia", "felicidad", "orgulloso",
    ],
}

ACTIVATION_LEXICON: Dict[str, List[str]] = {
    "agotamiento_baja": [
        "cansado", "cansancio", "agotado", "sin energia", "dormir", "siesta",
        "desvelo", "pesado", "lento", "apagado", "sin fuerzas", "sueño",
    ],
    "calma_estable": [
        "tranquilo", "calma", "relajado", "descanso", "sereno", "paz", "tranquilidad",
    ],
    "tension_alta": [
        "estres", "ansiedad", "ansioso", "prisa", "presion", "pendientes",
        "nervios", "agobio", "saturado", "deadline", "entregas", "corriendo",
    ],
    "entusiasmo_alta": [
        "emocionado", "motivado", "energia", "entusiasmo", "animo", "vitalidad",
        "con ganas", "inspirado",
    ],
}

EMOTION_LEXICON: Dict[str, List[str]] = {
    "alegria": ["feliz", "contento", "alegria", "risas", "gusto", "disfrute", "sonrisa"],
    "calma": ["tranquilo", "calma", "relajado", "paz", "descanso", "sereno"],
    "estres": ["estres", "presion", "pendientes", "agobio", "saturado", "entregas", "deadline", "trabajo"],
    "tristeza": ["triste", "pena", "solo", "soledad", "melancolia", "llorar", "vacio"],
    "frustracion": ["frustrado", "enojo", "enojado", "impotencia", "injusto", "harto", "molesto"],
    "ansiedad": ["ansiedad", "ansioso", "nervios", "miedo", "preocupado", "incertidumbre"],
    "gratitud": ["agradecido", "gracias", "gratitud", "bendecido", "afortunado"],
    "apatia": ["apatia", "desgano", "desinteres", "monotonia", "indiferencia", "sin ganas", "nada me importa"],
}

AXIS_LEXICON: Dict[str, List[str]] = {
    "eje_trabajo_estudio": [
        "trabajo", "tarea", "tareas", "pendientes", "entrega", "entregas", "jefe",
        "oficina", "universidad", "escuela", "estudio", "estudiar", "examen",
        "clase", "proyecto", "reunion", "equipo",
    ],
    "eje_descanso_sueno": [
        "dormir", "sueño", "sueno", "desvelo", "siesta", "descanso", "cama",
        "insomnio", "dormi", "dormir mal", "despertar", "desperte", "alarma", "descansar",
    ],
    "eje_relaciones_familia": [
        "pareja", "novia", "novio", "amigos", "amiga", "amigo", "familia",
        "mama", "papa", "hermano", "hermana", "hijos", "convivencia", "social",
        "cita", "reunion familiar",
    ],
    "eje_salud_cuerpo": [
        "dolor", "cabeza", "estomago", "cuerpo", "ejercicio", "gym", "correr",
        "comer", "alimentacion", "enfermo", "gripe", "cansancio fisico", "espalda",
    ],
    "eje_carga_mental": [
        "saturado", "saturacion", "piloto automatico", "lista", "pendientes",
        "bloqueo", "no doy", "encima", "carga", "agobio", "demasiadas cosas",
        "sin cabeza", "colapsado",
    ],
}

SIGNAL_LEXICON: Dict[str, List[str]] = {
    "sen_desgaste_sostenido": [
        "agotado", "desgaste", "sin fuerzas", "no puedo mas", "desesperanza",
        "harto", "quemado", "cada dia igual", "arrastrando",
    ],
    "sen_riesgo_autolesion_purga": [
        "autolesion", "hacerme daño", "hacerme dano", "cortarme", "lastimarme",
        "purga", "vomitar", "dejar de comer", "no comer", "restringir comida",
    ],
}

CONTRADICTION_POSITIVE = [
    "todo esta bien", "todo bien", "no pasa nada", "estoy bien", "aqui todo bien",
]
CONTRADICTION_NEGATIVE = [
    "pero", "aunque", "cansado", "cansancio", "estres", "triste", "fastidio",
    "molesto", "harto", "agotado", "preocupado",
]


def _distribution(text: str, lexicon: Dict[str, List[str]], default_key: str) -> Tuple[Dict[str, float], str, float]:
    """Convierte conteos de palabras clave en una distribución de probabilidad."""
    raw = {category: _count_hits(text, words) for category, words in lexicon.items()}
    total = sum(raw.values())
    if total == 0:
        return {category: (1.0 if category == default_key else 0.0) for category in lexicon}, default_key, 0.3

    # Suavizado: las categorías sin coincidencias conservan una probabilidad mínima.
    epsilon = 0.02
    smoothed = {category: (count + epsilon) for category, count in raw.items()}
    norm = sum(smoothed.values())
    probabilities = {category: round(value / norm, 4) for category, value in smoothed.items()}
    best = max(raw, key=lambda category: raw[category])
    confidence = round(min(0.92, 0.45 + 0.08 * total), 3)
    return probabilities, best, confidence


def _noul_probability(text: str, words: List[str]) -> float:
    hits = _count_hits(text, words)
    if hits == 0:
        return 0.05
    return round(min(0.96, 0.28 + 0.22 * hits), 4)


class HeuristicLayaAgent:
    """Agente compatible con `laya.Agent.predict` usado como respaldo local."""

    backend = "heuristica-local"

    def predict(self, text: str, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        started = time.perf_counter()
        folded = _fold(text)
        answers: Dict[str, Dict[str, Any]] = {}

        for question_id, question in questions.items():
            qtype = question.get("type")
            criteria = question.get("criteria", {}) or {}

            if qtype == "choice":
                if question_id == "valencia_emocional":
                    probs, best, confidence = _distribution(folded, VALENCE_LEXICON, "neutro")
                elif question_id == "activacion_energia":
                    probs, best, confidence = _distribution(folded, ACTIVATION_LEXICON, "calma_estable")
                elif question_id == "emocion_primaria":
                    probs, best, confidence = _distribution(folded, EMOTION_LEXICON, "calma")
                else:
                    keys = list(criteria.keys()) or ["si", "no"]
                    probs = {key: round(1.0 / len(keys), 4) for key in keys}
                    best = keys[0]
                    confidence = 0.3
                answers[question_id] = {
                    "choice": best,
                    "probabilities": probs,
                    "answer_confidence": confidence,
                }

            elif qtype == "noul":
                if question_id in AXIS_LEXICON:
                    probability = _noul_probability(folded, AXIS_LEXICON[question_id])
                elif question_id in SIGNAL_LEXICON:
                    probability = _noul_probability(folded, SIGNAL_LEXICON[question_id])
                elif question_id == "sen_contradiccion_emocional":
                    says_ok = any(_fold(phrase) in folded for phrase in CONTRADICTION_POSITIVE)
                    says_bad = _count_hits(folded, CONTRADICTION_NEGATIVE) > 0
                    probability = 0.62 if (says_ok and says_bad) else (0.18 if says_ok else 0.05)
                else:
                    probability = 0.1
                answers[question_id] = {"noul": probability}

            else:
                answers[question_id] = {"noul": 0.1}

        elapsed_ms = (time.perf_counter() - started) * 1000
        return {
            "answers": answers,
            "usage": {
                "input_tokens": len(folded.split()),
                "latency_ms": round(elapsed_ms, 2),
                "backend": self.backend,
            },
        }


FALLBACK_AGENT = HeuristicLayaAgent()
