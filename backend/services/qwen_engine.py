"""
Motor redactor secundario — Qwen cuantizado vía Ollama.
Recibe ÚNICAMENTE los porcentajes procesados por Laya y estadísticas de Python.
Restricción estricta: Lenguaje no clínico ('señal', 'patrón', 'sugerencia').
Prohibido: diagnósticos médicos, etiquetas psiquiátricas o lenguaje clínico.
Incluye generador determinista de respaldo si Ollama no está disponible o demora.
"""

import re
from typing import Dict, Any, Optional
import requests
from backend.config import OLLAMA_BASE_URL, OLLAMA_PREFERRED_MODELS

_HTTP_SESSION = requests.Session()

# Palabras prohibidas (clínicas o diagnósticas)
FORBIDDEN_CLINICAL_TERMS = [
    r"\btrastorno\b", r"\bpatolog[ií]a\b", r"\bs[ií]ndrome\b", r"\bdepresi[oó]n cl[ií]nica\b",
    r"\bdiagn[oó]stico\b", r"\bterap[eé]utica\b", r"\bansiedad generalizada\b", r"\bpsiqui[aá]tric\w*"
]

_SANITIZE_RULES = [
    (r"\btrastorno\b", "patrón recurrente"),
    (r"\bpatolog[ií]a\b", "situación"),
    (r"\bs[ií]ndrome\b", "conjunto de señales"),
    (r"\bdiagn[oó]stico\b", "observación"),
    (r"\bansiedad generalizada\b", "tensión constante"),
    (r"\bcontigo mism[ao]\b", "contigo"),
    (r"\ba ti mism[ao]\b", "a ti"),
    (r"\bpara ti mism[ao]\b", "para ti"),
    (r"\b(?:sentirse|sentirte) agotad[ao]\b", "sentir agotamiento"),
    (r"\bte sientes agotad[ao]\b", "sientes agotamiento"),
    (r"\best[aá]s agotad[ao]\b", "tienes agotamiento"),
    (r"\b(?:sentirse|sentirte) cansad[ao]\b", "sentir cansancio"),
    (r"\bte sientes cansad[ao]\b", "sientes cansancio"),
    (r"\best[aá]s cansad[ao]\b", "tienes cansancio"),
    (r"\b(?:sentirse|sentirte) abrumad[ao]\b", "sentir saturación"),
    (r"\bte sientes abrumad[ao]\b", "sientes saturación"),
    (r"\b(?:sentirse|sentirte) estresad[ao]\b", "sentir estrés"),
    (r"\bte sientes estresad[ao]\b", "sientes estrés"),
    (r"\b(?:qu[eé] tan|cu[aá]n) pesad[ao] te sientes\b", "cuánta carga sientes"),
]

def sanitize_response(text: str) -> str:
    """Filtra y reemplaza términos clínicos o con marca de género por equivalentes neutros y amables."""
    cleaned = text
    for pattern, repl in _SANITIZE_RULES:
        cleaned = re.sub(pattern, repl, cleaned, flags=re.IGNORECASE)
    return cleaned

def detect_available_qwen_model() -> Optional[str]:
    """Detecta si hay algún modelo Qwen disponible en el servidor local de Ollama."""
    try:
        res = _HTTP_SESSION.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        if res.status_code == 200:
            models = [m.get("name", "") for m in res.json().get("models", [])]
            for pref in OLLAMA_PREFERRED_MODELS:
                for m in models:
                    if pref in m:
                        return m
            # Si hay algún otro modelo qwen
            for m in models:
                if "qwen" in m.lower():
                    return m
    except Exception:
        pass
    return None

def generate_deterministic_summary(stats: Dict[str, Any]) -> str:
    """
    Generador determinista de respaldo basado en reglas y combinatoria amable en español.
    Garantiza tono sereno, no clínico y 100% libre de diagnósticos.
    """
    valencia = stats.get("valencia_media", 3.0)
    energia = stats.get("energia_dominante", "calma_estable")
    sueno = stats.get("sueno_medio", 7.5)
    carga = stats.get("carga_media", 3.0)
    emocion = stats.get("emocion_dominante", "calma")
    ejes = stats.get("ejes_principales", ["trabajo_estudio"])
    racha = stats.get("racha", 1)

    # 1. Apertura sobre el tono general
    if valencia >= 3.8:
        apertura = "En este periodo se observa un tono general positivo y constructivo."
    elif valencia <= 2.4:
        apertura = "Tus registros muestran señales de exigencia o momentos de malestar que han requerido de tu paciencia."
    else:
        apertura = "Tus días reflejan un equilibrio constante con momentos de rutina y estabilidad."

    # 2. Análisis del descanso y la carga
    if sueno < 6.5 and carga >= 3.5:
        descanso_obs = f"Se aprecia una correlación entre menos horas de sueño (promedio de {sueno}h) y una carga de trabajo alta ({carga}/5)."
    elif sueno >= 7.0 and carga <= 3.0:
        descanso_obs = f"El descanso adecuado (promedio de {sueno}h) parece haber amortiguado las demandas diarias."
    else:
        descanso_obs = f"El descanso se ha mantenido en una media de {sueno}h diarias frente a una demanda percibida de {carga}/5."

    # 3. Emoción y tema
    ejes_str = ", ".join(e.replace("_", " ") for e in ejes[:2])
    emocion_obs = f"La emoción que más se asoma en tus palabras es la {emocion}, vinculada principalmente a aspectos de {ejes_str}."

    # 4. Cruce con objetivos personales si existen
    cruces = stats.get("cruces_objetivos", [])
    cruce_str = f" {cruces[0]}" if cruces else ""

    # 5. Sugerencia amable y no clínica
    if valencia < 3.0 or carga > 3.8:
        sugerencia = "Sugerencia: regálate pausas breves a mitad del día para desconectar y verificar cómo está tu respiración."
    else:
        sugerencia = "Sugerencia: celebra los pequeños avances del día a día y mantén ese espacio de autoreflexión."

    racha_str = f" ¡Llevas una racha de {racha} días escribiendo!" if racha > 1 else ""

    return f"{apertura} {descanso_obs} {emocion_obs}{cruce_str} {sugerencia}{racha_str}"

def verify_semantic_safety_with_qwen(text: str) -> bool:
    """
    Realiza una verificación semántica focalizada con Qwen para discernir si el texto
    expresa una intención o riesgo real de autolesión/suicidio/purga, diferenciándolo
    de metáforas cotidianas (ej. 'me muero de risa', 'estoy muerto de cansancio').
    """
    if not text or not text.strip():
        return False

    model_name = detect_available_qwen_model()
    if not model_name:
        # Si Ollama no está activo, asumimos falso a nivel semántico (la capa regex ya cubre crisis directa)
        return False

    prompt = (
        "Eres un evaluador de seguridad para un diario reflexivo. Analiza este texto:\n"
        f"\"\"\"{text.strip()}\"\"\"\n\n"
        "Pregunta: ¿El texto expresa una intención real, acto, o ideación explícita de autolesión, suicidio, purga o agresión física contra uno mismo?\n"
        "Nota: No confundir con metáforas cotidianas de cansancio o frustración ('me muero de cansancio', 'me quiero cortar el pelo', 'estoy harto').\n"
        "Responde ÚNICAMENTE una palabra: 'SI' o 'NO'."
    )

    try:
        res = _HTTP_SESSION.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "think": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 10
                }
            },
            timeout=15
        )
        if res.status_code == 200:
            data = res.json()
            content = data.get("message", {}).get("content", "").strip().upper()
            return "SI" in content
    except Exception as e:
        print("Aviso en verificación semántica Qwen:", e)

    return False

def generate_period_summary(stats: Dict[str, Any]) -> Dict[str, str]:
    """
    Genera el resumen amable del periodo usando Qwen si está disponible,
    o el generador determinista si Ollama no responde a tiempo.
    """
    model_name = detect_available_qwen_model()

    if model_name:
        cruces_list = stats.get("cruces_objetivos", [])
        cruces_text = "\n  * " + "\n  * ".join(cruces_list) if cruces_list else "Sin cruces registrados aún."
        objetivo_usr = stats.get("objetivo_personal", "constancia")
        habitos_usr = ", ".join(stats.get("habitos_cuidar", [])) or "ninguno especificado"

        prompt = (
            "Eres la voz cálida, empática y serena de una app de diario personal llamada 'Diario Inteligente'.\n"
            "Tu tarea es redactar una crónica amable, cercana y clara (de 3 a 4 oraciones) en español sobre los patrones "
            "del periodo a partir de estas estadísticas ya calculadas:\n"
            f"- Valencia media: {stats.get('valencia_media', 3.0)}/5.0 (variación: {stats.get('valencia_min', 3.0)} a {stats.get('valencia_max', 3.0)})\n"
            f"- Nivel de energía dominante: {stats.get('energia_dominante', 'calma')}\n"
            f"- Horas promedio de sueño: {stats.get('sueno_medio', 7.5)} h (mínimo de sueño: {stats.get('sueno_min', 7.0)} h)\n"
            f"- Carga de trabajo promedio: {stats.get('carga_media', 3.0)}/5.0 (pico máximo de carga: {stats.get('carga_max', 3)}/5)\n"
            f"- Emoción predominante identificada por Laya: {stats.get('emocion_dominante', 'calma')}\n"
            f"- Ejes temáticos destacados: {', '.join(stats.get('ejes_principales', []))}\n"
            f"- Días analizados: {stats.get('total_dias', 0)}, Racha de días: {stats.get('racha', 0)}\n"
            f"- Objetivo personal: {objetivo_usr} (hábitos a cuidar: {habitos_usr})\n"
            f"- Observaciones cruzadas frente a tus metas:{cruces_text}\n\n"
            "REGLAS OBLIGATORIAS:\n"
            "1. Dirígete siempre en segunda persona neutra ('tú') sin asumir género masculino ni femenino: usa giros neutros como 'contigo', 'para ti', 'darte un respiro', 'sentir agotamiento' o 'sentir cansancio', evitando por completo formas en masculino o femenino como 'contigo misma', adjetivos concordados en -o/-a o participios personales.\n"
            "2. Menciona observaciones reales si notas caídas de ánimo, picos de carga o variaciones de sueño frente a tus metas.\n"
            "3. Usa ÚNICAMENTE lenguaje cotidiano, cálido y no clínico (ej. 'señal', 'patrón', 'sugerencia').\n"
            "4. Queda estrictamente PROHIBIDO emitir diagnósticos médicos, etiquetas clínicas o patologizantes.\n"
            "5. Concluye con una sugerencia pequeña y amable para tu autocuidado, evitando terminaciones de género."
        )

        try:
            # Invocar Ollama api/chat con think: False para respuesta inmediata (1 a 5 seg)
            res = _HTTP_SESSION.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": model_name,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "think": False,
                    "options": {
                        "temperature": 0.4,
                        "num_predict": 180
                    }
                },
                timeout=35
            )
            if res.status_code == 200:
                raw_text = res.json().get("message", {}).get("content", "").strip()
                # Limpiar posibles etiquetas de pensamiento si vinieran en texto
                clean_text = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL).strip()
                clean_text = sanitize_response(clean_text)
                if clean_text:
                    return {
                        "summary": clean_text,
                        "engine": f"Ollama ({model_name})"
                    }
        except Exception as e:
            print("Aviso al invocar Qwen para resumen de periodo:", e)

    # Respaldo determinista de alta fidelidad
    det_text = generate_deterministic_summary(stats)
    return {
        "summary": det_text,
        "engine": "Motor analítico en Python (local-first)"
    }
