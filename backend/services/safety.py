"""
Capa de Seguridad No Negociable (Local-First).
Detección en dos capas con separación de niveles:
1. Tarjeta roja de crisis (911 / Línea de la Vida):
   Solo se activa si la capa determinista (regex) hace match O si
   sen_riesgo_autolesion_purga >= 0.50 Y qwen_engine.py confirma riesgo real
   mediante verificación semántica focalizada.
2. Tarjeta suave de pausa/descanso (sin líneas de crisis):
   Se activa cuando sen_desgaste_sostenido >= 0.85 sin riesgo de autolesión ni purga.
"""

import re
from typing import Dict, Any, List, Optional
from backend.models.schema import SafetyResult
from backend.services.qwen_engine import verify_semantic_safety_with_qwen

# Frases y patrones deterministas de riesgo
RISK_PATTERNS = [
    # Autolesión / ideación suicida directa
    r"\b(suicid|matarm[ea]|quitarme la vida|acabar con todo|no quiero vivir|desaparecer de este mundo|hacerme da[ñn]o|cortarm[ea]|autolesi[oó]n)\w*",
    # Trastornos de conducta alimentaria / conductas de purga severa
    r"\b(purgarm[ea]|vomitar la comida|v[oó]mito inducido|no merezco comer|dejar de comer por completo|laxantes para no engordar)\w*"
]

RESOURCES_HELPLINES = [
    {
        "name": "Línea de la Vida (México)",
        "contact": "800 911 2000",
        "description": "Atención personalizada 24/7, gratuita y confidencial."
    },
    {
        "name": "Teléfono de la Esperanza (Internacional / España)",
        "contact": "717 003 717 / 914 590 055",
        "description": "Apoyo emocional y escucha activa en crisis."
    },
    {
        "name": "Emergencias generales",
        "contact": "911",
        "description": "En caso de peligro inmediato."
    }
]

SAFE_SUPPORT_MESSAGE = (
    "Hemos notado en tu escrito palabras o señales que reflejan un momento de sobrecarga o dolor profundo. "
    "Tu bienestar y tu vida son lo más valioso. No tienes que atravesar esto en soledad: "
    "existen personas capacitadas dispuestas a escucharte con calidez, respeto y total confidencialidad."
)

SOFT_PAUSE_MESSAGE = (
    "Tu escrito refleja señales de un desgaste o agotamiento muy profundo. "
    "Recuerda que no todo tiene que resolverse hoy; date permiso para hacer una pausa, "
    "bajar el ritmo y recargar energías con calma."
)

def evaluate_safety(text: str, laya_senales: Optional[Dict[str, float]] = None) -> SafetyResult:
    """
    Evalúa el texto y las señales de Laya para determinar el nivel de seguridad.
    Retorna un SafetyResult con nivel 'alert' (crisis), 'pause' (pausa suave) o 'safe'.
    """
    if not text:
        return SafetyResult(is_triggered=False, level="safe")

    text_lower = text.lower()

    # 1. Capa determinista: Coincidencia directa por regex
    for pattern in RISK_PATTERNS:
        if re.search(pattern, text_lower):
            return SafetyResult(
                is_triggered=True,
                level="alert",
                message=SAFE_SUPPORT_MESSAGE,
                helplines=RESOURCES_HELPLINES
            )

    # 2. Capa semántica de crisis: Laya (riesgo >= 0.50) + Verificación semántica Qwen
    if laya_senales:
        riesgo_laya = (
            laya_senales.get("riesgo_autolesion_purga")
            or laya_senales.get("sen_riesgo_autolesion_purga")
            or 0.0
        )
        if riesgo_laya >= 0.50:
            # Confirmar mediante verificación semántica focalizada en Qwen
            is_confirmed = verify_semantic_safety_with_qwen(text)
            if is_confirmed:
                return SafetyResult(
                    is_triggered=True,
                    level="alert",
                    message=SAFE_SUPPORT_MESSAGE,
                    helplines=RESOURCES_HELPLINES
                )

        # 3. Tarjeta suave de pausa/descanso (sin líneas de crisis)
        desgaste = (
            laya_senales.get("desgaste_sostenido")
            or laya_senales.get("sen_desgaste_sostenido")
            or 0.0
        )
        if desgaste >= 0.85:
            return SafetyResult(
                is_triggered=True,
                level="pause",
                message=SOFT_PAUSE_MESSAGE,
                helplines=[]  # Sin líneas de crisis para la tarjeta suave
            )

    return SafetyResult(is_triggered=False, level="safe")
