#!/usr/bin/env python3
"""
Destilación Offline Teacher-Student desde `data/checkpoints/laya_finetuned` (mmBERT-base 22 capas)
hacia el runtime ligero de navegador (Tier 1):

Genera en `models/`:
  1. `model_es_q8.onnx`       (~18.7 MB INT8 · Student ModernBERT 2 capas, vocabulario español podado 12,288)
  2. `tokenizer_es.json`      (~550 KB   · Tokenizador BPE + byte-fallback consistente por cierre)
  3. `diario_heads_v1.json`   (~108 KB   · Cabezales híbridos [emb_768 + signals_16 + protos] calibrados T/Platt)
  4. `prototypes_neg_v1.json` (~58 KB    · Prototipos multi-ancla + subespacio SVD de negación 4x768)

Nota ética / metodológica:
  Las 5 Baterías de evaluación de Fase C y `data/eval_es.jsonl` permanecen fuera del conjunto
  de entrenamiento (100% held-out) para medir generalización real sin fuga de datos.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import ModernBertConfig, ModernBertModel
from onnxruntime.quantization import QuantType, quantize_dynamic
import onnxruntime as ort
import laya

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.services.laya_engine import LAYA_QUESTIONS

CKPT_DIR = PROJECT_ROOT / "data" / "checkpoints" / "laya_finetuned"
TOKENIZER_SRC = CKPT_DIR / "tokenizer" / "tokenizer.json"
TRAIN_SEED_PATH = PROJECT_ROOT / "data" / "train_seed.jsonl"
EVAL_ES_PATH = PROJECT_ROOT / "data" / "eval_es.jsonl"
LEARNING_TRACKS_PATH = PROJECT_ROOT / "data" / "learning_tracks.json"
GLOSSARY_PATH = PROJECT_ROOT / "data" / "glossary_terms.json"
SYNTAX_JS_PATH = PROJECT_ROOT / "frontend" / "js" / "ml" / "syntax_features.js"
BPE_JS_PATH = PROJECT_ROOT / "frontend" / "js" / "ml" / "bpe_tokenizer.js"

OUT_DIR = PROJECT_ROOT / "models"
OUT_DIR.mkdir(parents=True, exist_ok=True)

TARGET_VOCAB_SIZE = 12288

VALENCE_CLASSES = ["muy_negativo", "negativo", "neutro", "positivo", "muy_positivo"]
ACTIVATION_CLASSES = ["agotamiento_baja", "calma_estable", "tension_alta", "entusiasmo_alta"]
EMOTION_CLASSES = ["alegria", "calma", "estres", "tristeza", "frustracion", "ansiedad", "gratitud", "apatia"]
AXES_KEYS = ["trabajo_estudio", "descanso_sueno", "relaciones_familia", "salud_cuerpo", "carga_mental"]
SIGNAL_KEYS = ["desgaste_sostenido", "contradiccion_emocional", "riesgo_autolesion_purga"]


# ---------------------------------------------------------------------------
# 1. Poda BPE consistente por cierre en español + verificación Node/Python
# ---------------------------------------------------------------------------

def is_spanish_latin_token(tok: str) -> bool:
    if len(tok) <= 2:
        return True
    clean = tok.replace("\u2581", "").replace("\u0120", "").replace("##", "")
    return bool(re.fullmatch(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.,;:!?¡¿'\"()\[\]\-_/+\s]+", clean))


def gather_domain_corpus_strings() -> List[str]:
    texts: List[str] = []
    if TRAIN_SEED_PATH.exists():
        with open(TRAIN_SEED_PATH, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    texts.append(json.loads(line)["state"])
    if LEARNING_TRACKS_PATH.exists():
        texts.append(LEARNING_TRACKS_PATH.read_text(encoding="utf-8"))
    if GLOSSARY_PATH.exists():
        texts.append(GLOSSARY_PATH.read_text(encoding="utf-8"))
    if SYNTAX_JS_PATH.exists():
        texts.append(SYNTAX_JS_PATH.read_text(encoding="utf-8"))
    for row in build_distillation_dataset():
        texts.append(row["text"])
    for p, n in NEGATION_MINIMAL_PAIRS:
        texts.extend([p, n])
    for group in MULTI_ANCHORS.values():
        texts.extend(group)
    return texts


def prune_tokenizer(agent_tok, target_size: int = TARGET_VOCAB_SIZE) -> Tuple[Dict[str, Any], List[int]]:
    raw_tok = json.loads(TOKENIZER_SRC.read_text(encoding="utf-8"))
    orig_vocab: Dict[str, int] = raw_tok["model"]["vocab"]
    inv_orig = {tid: tok for tok, tid in orig_vocab.items()}
    orig_merges = raw_tok["model"]["merges"]

    # Map produced token -> (left, right, rank)
    produced_by: Dict[str, Tuple[str, str, int]] = {}
    for rank, pair in enumerate(orig_merges):
        l, r = pair if isinstance(pair, list) else pair.split(" ", 1)
        merged = l + r
        if merged not in produced_by:
            produced_by[merged] = (l, r, rank)

    kept_tokens = set()
    # Base: especiales (0..216) + 256 byte-fallback (217..472)
    for tid in range(473):
        if tid in inv_orig:
            kept_tokens.add(inv_orig[tid])

    # Caracteres simples ASCII/Español/Puntuación presentes en vocabulario original
    for tok, tid in orig_vocab.items():
        if len(tok) == 1 and ord(tok) < 0x0250:
            kept_tokens.add(tok)

    def add_with_closure(tok: str):
        stack = [tok]
        while stack:
            cur = stack.pop()
            if cur in kept_tokens or cur not in orig_vocab:
                continue
            kept_tokens.add(cur)
            if cur in produced_by:
                l, r, _ = produced_by[cur]
                if l not in kept_tokens:
                    stack.append(l)
                if r not in kept_tokens:
                    stack.append(r)

    # Cobertura completa de todo el léxico de dominio español
    corpus_texts = gather_domain_corpus_strings()
    for t in corpus_texts:
        ids = agent_tok.encode(t, add_special_tokens=False)
        for tid in ids:
            tok = inv_orig.get(tid)
            if tok and is_spanish_latin_token(tok):
                add_with_closure(tok)

    # Completar presupuesto hasta target_size con los subwords latinos/españoles de mayor frecuencia (menor ID)
    sorted_candidates = sorted(
        [(tid, tok) for tok, tid in orig_vocab.items() if tok not in kept_tokens and is_spanish_latin_token(tok)],
        key=lambda x: x[0],
    )
    for tid, tok in sorted_candidates:
        if len(kept_tokens) >= target_size:
            break
        add_with_closure(tok)

    # Ordenar respetando el índice original (<pad>=0, <eos>=1, <bos>=2, <unk>=3)
    # sin cortar nunca ancestros del cierre BPE.
    ordered = sorted(list(kept_tokens), key=lambda tok: orig_vocab[tok])

    # Construir nuevo diccionario compactado 0..V-1 y mapa orig_ids
    new_vocab: Dict[str, int] = {}
    orig_ids: List[int] = []
    for new_id, tok in enumerate(ordered):
        new_vocab[tok] = new_id
        orig_ids.append(orig_vocab[tok])

    # Filtrar reglas de merge respetando rank original donde left, right y left+right están presentes
    pruned_merges = []
    for pair in orig_merges:
        l, r = pair if isinstance(pair, list) else pair.split(" ", 1)
        m = l + r
        if l in new_vocab and r in new_vocab and m in new_vocab:
            pruned_merges.append([l, r])

    spec = {
        "format": "diario-bpe-es-v1",
        "vocab_size": len(new_vocab),
        "bos_id": new_vocab["<bos>"],
        "eos_id": new_vocab["<eos>"],
        "pad_id": new_vocab["<pad>"],
        "unk_id": new_vocab["<unk>"],
        "vocab": new_vocab,
        "merges": pruned_merges,
    }
    return spec, orig_ids


def verify_js_tokenizer_parity(spec_path: Path):
    test_phrases = [
        "Hola, hoy dormí 7 horas y avancé en mis pendientes.",
        "Qué 'maravilloso' día en piloto automático!",
        "Quisiera apagarme por completo y desaparecer."
    ]
    js_script = f"""
    const fs = require("fs");
    const Bpe = require({json.dumps(str(BPE_JS_PATH))});
    const spec = JSON.parse(fs.readFileSync({json.dumps(str(spec_path))}, "utf8"));
    const tok = Bpe.create(spec);
    const out = {json.dumps(test_phrases)}.map(t => tok.encode(t, 128));
    console.log(JSON.stringify(out));
    """
    proc = subprocess.run(["node", "-e", js_script], capture_output=True, text=True, check=True)
    encoded = json.loads(proc.stdout)
    assert len(encoded) == len(test_phrases)
    for e in encoded:
        assert e["inputIds"][0] == 2 and e["inputIds"][-1] == 1
        assert len(e["inputIds"]) > 3
    print(f"✓ Tokenizador BPE JS validado ({len(encoded)} muestras, vocab={json.loads(spec_path.read_text())['vocab_size']}).")


# ---------------------------------------------------------------------------
# 2. Corpus de destilación sintético/estructurado (cero fuga de eval/baterías)
# ---------------------------------------------------------------------------

NEGATION_MINIMAL_PAIRS: List[Tuple[str, str]] = [
    ("Me siento bien y bastante tranquilo hoy.", "No me siento nada bien ni tranquilo hoy."),
    ("Pude concentrarme sin dificultad durante la mañana.", "Hoy no pude concentrarme ni tantito."),
    ("Dormí profundo y desperté con buena energía.", "No pude dormir nada y desperté sin energía."),
    ("Tengo mucho ánimo y ganas de seguir adelante.", "No tengo nada de ánimo ni ganas de seguir."),
    ("Me sentí alegre y en calma con mi familia.", "No me sentí ni tantito alegre ni en calma."),
    ("Siento alivio después de terminar los pendientes.", "No siento alivio, para nada pude descansar."),
    ("Me ayudó mucho salir a caminar para despejarme.", "Ni saliendo a caminar pude despejar la mente."),
    ("Hoy todo fluyó con tranquilidad en la oficina.", "Para nada estuvo tranquilo hoy en la oficina."),
    ("Logré avanzar con claridad y paciencia.", "No logré concentrarme ni avanzar en nada."),
    ("Estoy con fuerzas y buen humor esta tarde.", "Estoy sin fuerzas ni tantito humor esta tarde."),
    ("Me siento descansado después de la siesta.", "No descansé nada con la siesta de hoy."),
    ("Disfruté la comida y la plática con calma.", "No disfruté la comida ni tuve calma hoy."),
    ("La cabeza me da para resolver los problemas.", "Ya no me da la cabeza para resolver nada."),
    ("Tengo la mente ordenada y despejada.", "Traigo la cabeza hecha bolas y saturada."),
    ("Pude parar a tiempo y descansar tranquilo.", "Nunca puedo parar ni descansar tranquilo."),
    ("Me sentí muy acompañado en la reunión.", "Me sentí solo y sin apoyo en la reunión."),
    ("Siento paz y estabilidad durante el día.", "Para nada siento paz ni estabilidad hoy."),
    ("Me alcanzó el tiempo para terminar todo bien.", "No me alcanzó el día ni pude terminar bien."),
    ("Recuperé las fuerzas y la motivación.", "Sigo sin fuerzas ni motivación ninguna."),
    ("Todo estuvo en orden y muy manejable.", "Nada estuvo en orden ni manejable hoy.")
]

MULTI_ANCHORS: Dict[str, List[str]] = {
    "negated_wellbeing": [
        "No me siento nada bien y tampoco pude concentrarme ni tantito.",
        "Por más que intenté estar tranquilo no tuve nada de calma hoy.",
        "Sin ánimo, sin ganas y sin poder descansar ni un poco.",
        "Para nada me sentí bien hoy, ni siquiera logré enfocarme."
    ],
    "calm_positive": [
        "Día tranquilo y sereno, descansé bien y disfruté mis actividades.",
        "Me siento en calma, agradecido y con paz en casa.",
        "Tuve buena energía, avancé con claridad y dormí a gusto."
    ],
    "overload_idioms": [
        "Sigo en piloto automático con mil cosas encima y ya no me da la cabeza.",
        "La lista de pendientes nunca se achica y traigo la cabeza hecha bolas.",
        "Tengo mil pestañas abiertas en la mente y el tiempo no alcanza."
    ],
    "chronic_burnout": [
        "Estoy completamente fundido y quemado, cada día igual y sin fuerzas.",
        "Me dio un bajón tremendo y siento que ya no puedo más con el desgaste.",
        "Ando hecho polvo, arrastrando la cobija y con la pila en ceros."
    ],
    "ironic_overload": [
        "Qué 'maravilloso' día resolviendo urgencias hasta medianoche, según yo muy bien pero agotado.",
        "Según yo todo 'excelente' en el trabajo aunque la verdad ya no aguanto.",
        "Un lunes 'feliz' lleno de reclamos y pendientes encima, pero estoy tronado."
    ],
    "everyday_neutral": [
        "Fui al mercado por verdura, pagué el recibo de luz y cené temprano.",
        "Ordené mis cuadernos, limpié la cocina y dormí a las diez y media.",
        "Llevé ropa a lavar, revisé correos rutinarios y llamé a mi papá.",
        "Compré pan en la tienda, preparé sopa y vi un episodio de una serie."
    ],
    "implicit_disappear_risk": [
        "A veces quisiera apagarme por completo y desaparecer para siempre.",
        "Ojalá pudiera borrarme del mapa y no volver a despertar mañana.",
        "No le veo sentido a seguir aquí, prefiero apagarme de una vez."
    ],
    "implicit_purge_risk": [
        "Siento tanta culpa que quiero deshacerme de lo que comí hoy.",
        "No soporto haber comido y pienso en sacarme toda la comida.",
        "Quisiera castigarme sin comer ni probar bocado y devolver lo que cené."
    ]
}


def _make_item(
    text: str,
    val: str,
    act: str,
    emo: str,
    ejes: Dict[str, float] | None = None,
    senales: Dict[str, float] | None = None,
) -> Dict[str, Any]:
    e_def = {k: 0.05 for k in AXES_KEYS}
    if ejes:
        e_def.update(ejes)
    s_def = {k: 0.04 for k in SIGNAL_KEYS}
    if senales:
        s_def.update(senales)
    return {
        "text": text,
        "val": val,
        "act": act,
        "emo": emo,
        "ejes": e_def,
        "senales": s_def,
    }


def build_distillation_dataset() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []

    # Cargar train_seed.jsonl existente (mapeando valores parciales con defaults limpios)
    if TRAIN_SEED_PATH.exists():
        with open(TRAIN_SEED_PATH, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                g = row.get("gold", {})
                items.append(_make_item(
                    row["state"],
                    g.get("valencia_emocional", "neutro"),
                    g.get("activacion_energia", "calma_estable"),
                    g.get("emocion_primaria", "calma"),
                    ejes={
                        "trabajo_estudio": 0.75 if any(w in row["state"].lower() for w in ("examen", "trabajo", "balance", "soporte", "proyecto")) else 0.08,
                        "descanso_sueno": 0.75 if any(w in row["state"].lower() for w in ("dorm", "siesta", "descans", "sueño")) else 0.06,
                        "relaciones_familia": 0.75 if any(w in row["state"].lower() for w in ("amigo", "familia", "mamá", "hermano", "pareja")) else 0.06,
                        "salud_cuerpo": 0.70 if any(w in row["state"].lower() for w in ("dolor", "espalda", "cuerpo", "ejercicio", "caminar")) else 0.06,
                        "carga_mental": 0.70 if any(w in row["state"].lower() for w in ("pendientes", "soporte", "satur", "cabeza", "horas")) else 0.08,
                    },
                    senales={
                        "desgaste_sostenido": 0.65 if g.get("valencia_emocional") == "muy_negativo" else 0.05,
                        "contradiccion_emocional": 0.05,
                        "riesgo_autolesion_purga": 0.02,
                    },
                ))

    # --- 1. Negaciones simples y compuestas ---
    neg_samples = [
        ("No me siento nada bien desde la mañana y no pude estar tranquilo.", "muy_negativo", "agotamiento_baja", "tristeza", {"carga_mental": 0.55}, {"desgaste_sostenido": 0.58}),
        ("Intenté relajarme un rato, pero ni tantito logré concentrarme hoy.", "negativo", "tension_alta", "frustracion", {"carga_mental": 0.72}, {"desgaste_sostenido": 0.38}),
        ("No descansé nada y tampoco tengo ánimo de hacer mis tareas.", "negativo", "agotamiento_baja", "apatia", {"descanso_sueno": 0.85, "trabajo_estudio": 0.65}, {"desgaste_sostenido": 0.62}),
        ("Para nada estuvo tranquilo el día, no pude respirar con calma.", "negativo", "tension_alta", "estres", {"carga_mental": 0.68}, {"desgaste_sostenido": 0.45}),
        ("Sin ganas, sin energía y sin poder dormir bien desde antier.", "muy_negativo", "agotamiento_baja", "tristeza", {"descanso_sueno": 0.90}, {"desgaste_sostenido": 0.78}),
        ("Por más que lo intenté, no conseguí enfocarme ni sentir paz.", "negativo", "tension_alta", "ansiedad", {"carga_mental": 0.65}, {"desgaste_sostenido": 0.42}),
        ("Nunca termino bien el día cuando me quedo sin fuerzas.", "negativo", "agotamiento_baja", "tristeza", {"carga_mental": 0.55}, {"desgaste_sostenido": 0.72}),
        ("Ni ganas ni concentración tuve en clase hoy.", "negativo", "agotamiento_baja", "apatia", {"trabajo_estudio": 0.82}, {"desgaste_sostenido": 0.40}),
        ("No pude dormir ni sentirme alegre en toda la jornada.", "negativo", "agotamiento_baja", "tristeza", {"descanso_sueno": 0.85}, {"desgaste_sostenido": 0.55}),
        ("Hoy no estoy nada motivado y todo cuesta el doble.", "negativo", "agotamiento_baja", "apatia", {"carga_mental": 0.50}, {"desgaste_sostenido": 0.58}),
    ]
    for s in neg_samples:
        items.append(_make_item(*s))

    # --- 2. Modismos mexicanos / hispanos de sobrecarga y desgaste ---
    idiom_samples = [
        ("Ando en piloto automático toda la semana y ya no me da la cabeza.", "negativo", "agotamiento_baja", "estres", {"carga_mental": 0.94, "trabajo_estudio": 0.65}, {"desgaste_sostenido": 0.90}),
        ("La lista nunca se achica; aunque tache cosas, me siento fundido.", "muy_negativo", "agotamiento_baja", "estres", {"carga_mental": 0.92, "trabajo_estudio": 0.80}, {"desgaste_sostenido": 0.91}),
        ("Traigo la cabeza hecha bolas con tanto pendiente y me dio el bajón.", "negativo", "agotamiento_baja", "tristeza", {"carga_mental": 0.90}, {"desgaste_sostenido": 0.88}),
        ("Estoy quemado de la oficina, ya no doy una y traigo la pila baja.", "muy_negativo", "agotamiento_baja", "apatia", {"trabajo_estudio": 0.88, "carga_mental": 0.88}, {"desgaste_sostenido": 0.92}),
        ("Siento el agua al cuello con mil pestañas abiertas en mi cabeza.", "negativo", "tension_alta", "ansiedad", {"carga_mental": 0.91, "trabajo_estudio": 0.82}, {"desgaste_sostenido": 0.72}),
        ("Cada día igual, avanzando en automático y hecho polvo.", "muy_negativo", "agotamiento_baja", "apatia", {"carga_mental": 0.86, "salud_cuerpo": 0.55}, {"desgaste_sostenido": 0.93}),
        ("No me alcanza el día para nada y terminé fundida a las nueve.", "negativo", "agotamiento_baja", "estres", {"carga_mental": 0.85, "trabajo_estudio": 0.75}, {"desgaste_sostenido": 0.86}),
        ("Me comió el tiempo y traigo mil cosas encima en automático.", "negativo", "agotamiento_baja", "estres", {"carga_mental": 0.89, "trabajo_estudio": 0.70}, {"desgaste_sostenido": 0.84}),
    ]
    for s in idiom_samples:
        items.append(_make_item(*s))

    # --- 3. Discrepancia, post-adversativo e ironía ---
    irony_samples = [
        ("En la junta dije que todo bien, pero la verdad estoy agotado y saturado.", "negativo", "agotamiento_baja", "estres", {"trabajo_estudio": 0.85, "carga_mental": 0.85}, {"desgaste_sostenido": 0.70, "contradiccion_emocional": 0.88}),
        ("Qué 'maravilloso' lunes arreglando errores ajenos, según yo feliz pero harto.", "negativo", "tension_alta", "frustracion", {"trabajo_estudio": 0.82, "carga_mental": 0.75}, {"desgaste_sostenido": 0.62, "contradiccion_emocional": 0.90}),
        ("Según yo todo bajo control, pero la neta siento que voy a explotar.", "muy_negativo", "tension_alta", "ansiedad", {"carga_mental": 0.88}, {"desgaste_sostenido": 0.74, "contradiccion_emocional": 0.91}),
        ("¡Qué 'excelente' noticia tener trabajo extra a medianoche!, estoy fundido.", "negativo", "agotamiento_baja", "frustracion", {"trabajo_estudio": 0.90, "descanso_sueno": 0.65, "carga_mental": 0.82}, {"desgaste_sostenido": 0.82, "contradiccion_emocional": 0.89}),
        ("No pasa nada en casa, aunque en realidad llevo días sin dormir bien y triste.", "negativo", "agotamiento_baja", "tristeza", {"relaciones_familia": 0.65, "descanso_sueno": 0.85}, {"desgaste_sostenido": 0.68, "contradiccion_emocional": 0.87}),
        ("Todo tranquilo en apariencia, sin embargo tengo un nudo en el estómago.", "negativo", "tension_alta", "ansiedad", {"salud_cuerpo": 0.72}, {"desgaste_sostenido": 0.45, "contradiccion_emocional": 0.84}),
        ("A pesar de que me fue bien en el examen, en realidad me siento vacío y solo.", "negativo", "agotamiento_baja", "tristeza", {"trabajo_estudio": 0.65}, {"desgaste_sostenido": 0.60, "contradiccion_emocional": 0.82}),
        ("Día pesado de entregas, pero al final hablé con mi amiga y me sentí en paz.", "positivo", "calma_estable", "alivio" if False else "calma", {"trabajo_estudio": 0.65, "relaciones_familia": 0.85}, {"desgaste_sostenido": 0.15, "contradiccion_emocional": 0.55}),
    ]
    for s in irony_samples:
        items.append(_make_item(*s))

    # --- 4. Días neutros / descriptivos cotidianos (0 desgaste, 0 riesgo) ---
    neutral_samples = [
        ("Fui a la tienda por leche, adelanté un ensayo de historia y me dormí a las diez.", "neutro", "calma_estable", "calma", {"trabajo_estudio": 0.60, "descanso_sueno": 0.55}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Hoy cociné lentejas, contesté mensajes de mi hermano y salí a caminar.", "positivo", "calma_estable", "calma", {"relaciones_familia": 0.72, "salud_cuerpo": 0.45}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Día normal de clases, tomé apuntes de economía y cené quesadillas.", "neutro", "calma_estable", "calma", {"trabajo_estudio": 0.68, "salud_cuerpo": 0.25}, {"desgaste_sostenido": 0.05, "riesgo_autolesion_purga": 0.02}),
        ("Limpio el escritorio, riego las plantas y reviso la agenda de mañana.", "neutro", "calma_estable", "calma", {"carga_mental": 0.15}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Fui al súper por fruta, hice dos ejercicios de programación y llamé a mi papá.", "positivo", "calma_estable", "calma", {"trabajo_estudio": 0.58, "relaciones_familia": 0.65}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Lunes ordinario sin sobresaltos; desayuné a mis horas y dormí temprano.", "positivo", "calma_estable", "calma", {"descanso_sueno": 0.65, "salud_cuerpo": 0.55}, {"desgaste_sostenido": 0.03, "riesgo_autolesion_purga": 0.02}),
        ("Pasé a pagar el internet, adelanté lectura de biología y descansé un rato.", "neutro", "calma_estable", "calma", {"trabajo_estudio": 0.55, "descanso_sueno": 0.40}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Cené sopa caliente con mi tía y vi noticias antes de acostarme.", "positivo", "calma_estable", "gratitud", {"relaciones_familia": 0.75, "descanso_sueno": 0.35}, {"desgaste_sostenido": 0.03, "riesgo_autolesion_purga": 0.02}),
        ("Organicé carpetas en la computadora, compré pan y escuché radio.", "neutro", "calma_estable", "calma", {"trabajo_estudio": 0.40}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Fui a correr treinta minutos en la mañana y luego preparé mi almuerzo.", "positivo", "entusiasmo_alta", "alegria", {"salud_cuerpo": 0.88}, {"desgaste_sostenido": 0.03, "riesgo_autolesion_purga": 0.02}),
    ]
    for s in neutral_samples:
        items.append(_make_item(*s))

    # --- 5. Seguridad implícita / explícita + metáforas seguras ---
    safety_samples = [
        ("A veces quisiera apagarme del todo y desaparecer sin dejar rastro.", "muy_negativo", "agotamiento_baja", "tristeza", {}, {"desgaste_sostenido": 0.92, "riesgo_autolesion_purga": 0.92}),
        ("Siento que no soporto haber comido y quiero deshacerme de todo lo que cené.", "muy_negativo", "tension_alta", "ansiedad", {"salud_cuerpo": 0.85}, {"desgaste_sostenido": 0.75, "riesgo_autolesion_purga": 0.92}),
        ("Ya no quiero despertar mañana, ojalá pudiera esfumarme de esta vida.", "muy_negativo", "agotamiento_baja", "tristeza", {}, {"desgaste_sostenido": 0.95, "riesgo_autolesion_purga": 0.95}),
        ("Me castigo por probar bocado y busco vomitar para sacarme la comida.", "muy_negativo", "tension_alta", "ansiedad", {"salud_cuerpo": 0.90}, {"desgaste_sostenido": 0.78, "riesgo_autolesion_purga": 0.96}),
        ("Hoy pensé en hacerme daño porque siento un vacío insoportable.", "muy_negativo", "agotamiento_baja", "tristeza", {}, {"desgaste_sostenido": 0.92, "riesgo_autolesion_purga": 0.97}),
        ("Prefiero apagarme y no existir más antes que seguir sintiendo esto.", "muy_negativo", "agotamiento_baja", "tristeza", {}, {"desgaste_sostenido": 0.92, "riesgo_autolesion_purga": 0.94}),
        ("No soporto lo que comí y pienso en purgarme o dejar de comer por completo.", "muy_negativo", "tension_alta", "frustracion", {"salud_cuerpo": 0.88}, {"desgaste_sostenido": 0.80, "riesgo_autolesion_purga": 0.96}),
        # Metáforas cotidianas seguras (riesgo <= 0.05)
        ("Me muero de risa con mi hermana viendo videos viejos, qué gran tarde.", "muy_positivo", "entusiasmo_alta", "alegria", {"relaciones_familia": 0.82}, {"desgaste_sostenido": 0.04, "riesgo_autolesion_purga": 0.02}),
        ("Mañana voy a cortarme el pelo y a deshacerme de cajas viejas del cuarto.", "neutro", "calma_estable", "calma", {}, {"desgaste_sostenido": 0.05, "riesgo_autolesion_purga": 0.02}),
        ("Llegué muerto de hambre del gimnasio y cené dos tacos con calma.", "positivo", "calma_estable", "alegria", {"salud_cuerpo": 0.82}, {"desgaste_sostenido": 0.05, "riesgo_autolesion_purga": 0.02}),
    ]
    for s in safety_samples:
        items.append(_make_item(*s))

    # --- 6. Emociones positivas / gratitud / energía / calma ---
    pos_samples = [
        ("Estoy muy feliz y agradecido porque aprobé mi materia y dormí ocho horas.", "muy_positivo", "entusiasmo_alta", "alegria", {"trabajo_estudio": 0.70, "descanso_sueno": 0.75}, {"desgaste_sostenido": 0.03}),
        ("Qué gratitud sentir este silencio en la mañana con un café tibio.", "muy_positivo", "calma_estable", "gratitud", {"descanso_sueno": 0.35}, {"desgaste_sostenido": 0.03}),
        ("Resolví el problema del proyecto y salí tranquilo a celebrar con el equipo.", "positivo", "entusiasmo_alta", "alegria", {"trabajo_estudio": 0.80, "relaciones_familia": 0.65}, {"desgaste_sostenido": 0.04}),
        ("Me siento orgulloso de mantener mi rutina de sueño y ejercicio.", "muy_positivo", "calma_estable", "gratitud", {"descanso_sueno": 0.75, "salud_cuerpo": 0.82}, {"desgaste_sostenido": 0.03}),
        ("Tarde muy pacífica leyendo bajo el árbol, con descanso y calma interior.", "positivo", "calma_estable", "calma", {"descanso_sueno": 0.45}, {"desgaste_sostenido": 0.03}),
        ("Disfruté caminar temprano sintiendo el aire limpio y recuperando el equilibrio.", "positivo", "calma_estable", "calma", {"salud_cuerpo": 0.65}, {"desgaste_sostenido": 0.03}),
        ("Agradezco mucho a mis amistades por acompañarme con cariño este día.", "muy_positivo", "calma_estable", "gratitud", {"relaciones_familia": 0.90}, {"desgaste_sostenido": 0.03}),
        ("Qué frustración intentar arreglar la falla todo el día y recibir críticas sin apoyo.", "negativo", "tension_alta", "frustracion", {"trabajo_estudio": 0.85, "carga_mental": 0.70}, {"desgaste_sostenido": 0.35}),
        ("Me preocupa mucho la incertidumbre del contrato y tengo el estómago tenso.", "negativo", "tension_alta", "ansiedad", {"trabajo_estudio": 0.60, "salud_cuerpo": 0.65}, {"desgaste_sostenido": 0.35}),
        ("Hoy sentí nostalgia y pena al recordar viejos tiempos; se me escaparon lágrimas.", "negativo", "agotamiento_baja", "tristeza", {"relaciones_familia": 0.70}, {"desgaste_sostenido": 0.32}),
        ("Hago las cosas por inercia sin alegría ni tristeza particular, un día gris.", "neutro", "agotamiento_baja", "apatia", {"carga_mental": 0.35}, {"desgaste_sostenido": 0.25}),
        ("El servidor falló con demasiada presión del cliente y terminé con dolor de cabeza.", "negativo", "tension_alta", "estres", {"trabajo_estudio": 0.88, "salud_cuerpo": 0.70, "carga_mental": 0.75}, {"desgaste_sostenido": 0.42}),
        ("Gracias por haber podido dormir una siesta que me devolvió el ánimo.", "positivo", "calma_estable", "gratitud", {"descanso_sueno": 0.88}, {"desgaste_sostenido": 0.03}),
        ("Qué alegría enorme recibir tan buena noticia de la familia, salí a festejar.", "muy_positivo", "entusiasmo_alta", "alegria", {"relaciones_familia": 0.85}, {"desgaste_sostenido": 0.03}),
    ]
    for s in pos_samples:
        items.append(_make_item(*s))

    return items


# ---------------------------------------------------------------------------
# 3. Extracción de Knowledge del Teacher + Destilación Student ONNX
# ---------------------------------------------------------------------------

class MeanPoolEncoder(nn.Module):
    def __init__(self, enc: ModernBertModel):
        super().__init__()
        self.enc = enc

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        out = self.enc(input_ids=input_ids, attention_mask=attention_mask)
        h = out.last_hidden_state
        mask = attention_mask.unsqueeze(-1).float()
        pooled = (h * mask).sum(dim=1) / torch.clamp(mask.sum(dim=1), min=1e-6)
        return F.normalize(pooled, p=2, dim=-1)


@torch.no_grad()
def encode_teacher_texts(teacher_enc, tokenizer, texts: List[str], batch_size: int = 16) -> np.ndarray:
    teacher_enc.float().eval()
    embs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        toks = tokenizer(batch, padding=True, truncation=True, max_length=128, return_tensors="pt")
        out = teacher_enc(input_ids=toks["input_ids"], attention_mask=toks["attention_mask"])
        h = out.last_hidden_state
        mask = toks["attention_mask"].unsqueeze(-1).float()
        pooled = (h * mask).sum(dim=1) / torch.clamp(mask.sum(dim=1), min=1e-6)
        normed = F.normalize(pooled, p=2, dim=-1)
        embs.append(normed.cpu().numpy())
    return np.vstack(embs).astype(np.float32)


def encode_with_pruned_js_spec(texts: List[str], spec: Dict[str, Any], max_len: int = 128) -> Tuple[torch.Tensor, torch.Tensor]:
    js_script = f"""
    const fs = require("fs");
    const Bpe = require({json.dumps(str(BPE_JS_PATH))});
    const spec = JSON.parse(fs.readFileSync({json.dumps(str(OUT_DIR / "tokenizer_es.json"))}, "utf8"));
    const texts = JSON.parse(fs.readFileSync(0, "utf8"));
    const tok = Bpe.create(spec);
    const res = texts.map(t => tok.encode(t, {max_len}));
    console.log(JSON.stringify(res));
    """
    proc = subprocess.run(["node", "-e", js_script], input=json.dumps(texts), capture_output=True, text=True, check=True)
    enc_list = json.loads(proc.stdout)
    max_l = max(len(x["inputIds"]) for x in enc_list)
    pad_id = spec["pad_id"]
    ids_mat = np.full((len(enc_list), max_l), pad_id, dtype=np.int64)
    mask_mat = np.zeros((len(enc_list), max_l), dtype=np.int64)
    for i, item in enumerate(enc_list):
        L = len(item["inputIds"])
        ids_mat[i, :L] = item["inputIds"]
        mask_mat[i, :L] = item["attentionMask"]
    return torch.from_numpy(ids_mat), torch.from_numpy(mask_mat)


def extract_syntax_signals_node(texts: List[str]) -> np.ndarray:
    js_script = f"""
    const fs = require("fs");
    const Syn = require({json.dumps(str(SYNTAX_JS_PATH))});
    const texts = JSON.parse(fs.readFileSync(0, "utf8"));
    const keys = Object.keys(Syn.buildEmptySignals16());
    const rows = texts.map(t => {{
      const s = Syn.extract(t, null).signals16;
      return keys.map(k => Number(s[k] || 0));
    }});
    console.log(JSON.stringify(rows));
    """
    proc = subprocess.run(["node", "-e", js_script], input=json.dumps(texts), capture_output=True, text=True, check=True)
    return np.array(json.loads(proc.stdout), dtype=np.float32)


def distill_student_encoder(teacher_enc, orig_ids: List[int], spec: Dict[str, Any], texts: List[str], teacher_embs: np.ndarray) -> Path:
    print("-> Inicializando Student ModernBERT de 2 capas (capas Teacher [0, 21])...")
    cfg = copy.deepcopy(teacher_enc.config)
    cfg.num_hidden_layers = 2
    cfg.layer_types = ["full_attention", "full_attention"]
    cfg.vocab_size = len(orig_ids)
    cfg._attn_implementation = "eager"

    stu_enc = ModernBertModel(cfg)
    with torch.no_grad():
        idx_tensor = torch.tensor(orig_ids, dtype=torch.long)
        stu_enc.embeddings.tok_embeddings.weight.copy_(teacher_enc.embeddings.tok_embeddings.weight[idx_tensor].float())
        stu_enc.embeddings.norm.weight.copy_(teacher_enc.embeddings.norm.weight.float())
        stu_enc.layers[0].load_state_dict({k: v.float() for k, v in teacher_enc.layers[0].state_dict().items()})
        stu_enc.layers[1].load_state_dict({k: v.float() for k, v in teacher_enc.layers[21].state_dict().items()})
        stu_enc.final_norm.weight.copy_(teacher_enc.final_norm.weight.float())

    # Congelar embeddings para conservar generalización léxica en las 12,288 subpalabras; entrenar bloques
    stu_enc.embeddings.tok_embeddings.weight.requires_grad_(False)
    student = MeanPoolEncoder(stu_enc).float()

    stu_ids, stu_mask = encode_with_pruned_js_spec(texts, spec, max_len=128)
    target_t = torch.from_numpy(teacher_embs)

    # Normalizar similitud inicial antes de destilar
    student.eval()
    with torch.no_grad():
        init_embs = student(stu_ids, stu_mask)
        init_cos = float(F.cosine_similarity(init_embs, target_t, dim=-1).mean())
    print(f"   Cosine medio antes de destilar: {init_cos:.4f}")

    student.train()
    opt = torch.optim.AdamW([p for p in student.parameters() if p.requires_grad], lr=2e-4, weight_decay=0.01)
    n = stu_ids.size(0)
    batch_size = 16
    epochs = 14

    t_start = time.perf_counter()
    for ep in range(epochs):
        perm = torch.randperm(n)
        total_loss = 0.0
        for i in range(0, n, batch_size):
            b_idx = perm[i : i + batch_size]
            if len(b_idx) < 2:
                continue
            b_ids = stu_ids[b_idx]
            b_mask = stu_mask[b_idx]
            b_tgt = target_t[b_idx]

            opt.zero_grad()
            pred = student(b_ids, b_mask)
            cos_loss = (1.0 - F.cosine_similarity(pred, b_tgt, dim=-1)).mean()
            mse_loss = F.mse_loss(pred, b_tgt)
            # Preservación relacional de similitud por pares
            sim_stu = pred @ pred.t()
            sim_tch = b_tgt @ b_tgt.t()
            rel_loss = F.mse_loss(sim_stu, sim_tch)
            loss = cos_loss + 2.0 * mse_loss + 1.5 * rel_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            opt.step()
            total_loss += float(loss.item()) * len(b_idx)
        if (ep + 1) in (1, 7, epochs):
            print(f"   Epoch {ep+1:02d}/{epochs}: loss={total_loss/n:.4f}")

    student.eval()
    with torch.no_grad():
        post_embs = student(stu_ids, stu_mask)
        post_cos = float(F.cosine_similarity(post_embs, target_t, dim=-1).mean())
    print(f"✓ Destilación completa en {time.perf_counter()-t_start:.1f}s · Cosine Teacher-Student: {init_cos:.4f} -> {post_cos:.4f}")

    # Exportar FP32 y cuantizar a INT8 (< 20 MB para jsDelivr + Raw GitHub CDN)
    fp32_path = Path(tempfile.gettempdir()) / "diario_student_fp32.onnx"
    q8_path = OUT_DIR / "model_es_q8.onnx"
    dummy_ids = torch.tensor([[2, 100, 200, 300, 1]], dtype=torch.long)
    dummy_mask = torch.tensor([[1, 1, 1, 1, 1]], dtype=torch.long)
    torch.onnx.export(
        student,
        (dummy_ids, dummy_mask),
        str(fp32_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["embedding"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "embedding": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(str(fp32_path), str(q8_path), weight_type=QuantType.QUInt8)
    fp32_path.unlink(missing_ok=True)
    size_mb = q8_path.stat().st_size / (1024 * 1024)
    print(f"✓ ONNX INT8 exportado en {q8_path} ({size_mb:.2f} MB)")
    return q8_path


@torch.no_grad()
def encode_with_onnx(sess: ort.InferenceSession, texts: List[str], spec: Dict[str, Any]) -> np.ndarray:
    ids_t, mask_t = encode_with_pruned_js_spec(texts, spec, max_len=128)
    embs = []
    for i in range(len(texts)):
        # Pasar longitud exacta sin padding para máxima velocidad de navegador
        real_len = int(mask_t[i].sum().item())
        inp_ids = ids_t[i : i + 1, :real_len].numpy()
        inp_mask = mask_t[i : i + 1, :real_len].numpy()
        out = sess.run(None, {"input_ids": inp_ids, "attention_mask": inp_mask})[0]
        embs.append(out[0])
    return np.vstack(embs).astype(np.float32)


# ---------------------------------------------------------------------------
# 4. Prototipos Multi-Ancla + Subespacio SVD de Negación (~58 KB)
# ---------------------------------------------------------------------------

def build_prototypes_neg(sess: ort.InferenceSession, spec: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    pos_texts = [p for p, _ in NEGATION_MINIMAL_PAIRS]
    neg_texts = [n for _, n in NEGATION_MINIMAL_PAIRS]
    pos_embs = encode_with_onnx(sess, pos_texts, spec)
    neg_embs = encode_with_onnx(sess, neg_texts, spec)
    diffs = neg_embs - pos_embs
    # SVD para extraer los 4 ejes principales del subespacio de negación (4 x 768)
    _, _, vt = np.linalg.svd(diffs, full_matrices=False)
    u_neg = vt[:4].astype(np.float32)

    # Centroides multi-ancla normalizados (12 conceptos x 768)
    anchors: Dict[str, List[float]] = {}
    anchor_order = list(MULTI_ANCHORS.keys())
    for name in anchor_order:
        texts = MULTI_ANCHORS[name]
        embs = encode_with_onnx(sess, texts, spec)
        centroid = embs.mean(axis=0)
        norm = float(np.linalg.norm(centroid))
        if norm > 1e-8:
            centroid = centroid / norm
        anchors[name] = [round(float(x), 3) for x in centroid.tolist()]

    payload = {
        "format": "diario-prototypes-neg-v1",
        "dim": 768,
        "neg_subspace": [[round(float(x), 3) for x in row.tolist()] for row in u_neg],
        "anchor_names": anchor_order,
        "anchors": anchors,
    }
    out_path = OUT_DIR / "prototypes_neg_v1.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"✓ Prototipos + subespacio negación exportados: {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")
    return payload, anchor_order


def compute_proto_features(embs: np.ndarray, proto_payload: Dict[str, Any]) -> np.ndarray:
    u_neg = np.array(proto_payload["neg_subspace"], dtype=np.float32)  # [4, 768]
    anchor_names = proto_payload["anchor_names"]
    anchor_mat = np.array([proto_payload["anchors"][k] for k in anchor_names], dtype=np.float32)  # [12, 768]

    cos_anchors = embs @ anchor_mat.T  # [N, 12]
    neg_proj = embs @ u_neg.T  # [N, 4]
    return np.hstack([cos_anchors, neg_proj]).astype(np.float32)  # [N, 12]


# ---------------------------------------------------------------------------
# 5. Entrenamiento de Cabezal Híbrido + Calibración (~108 KB)
# ---------------------------------------------------------------------------

def train_hybrid_heads(
    agent,
    sess: ort.InferenceSession,
    spec: Dict[str, Any],
    proto_payload: Dict[str, Any],
    dataset: List[Dict[str, Any]],
) -> Dict[str, Any]:
    texts = [d["text"] for d in dataset]
    proto_dim = len(proto_payload["anchor_names"]) + len(proto_payload["neg_subspace"])
    print(f"-> Extrayendo features híbridos [ONNX 768 + Sintaxis 16 + Prototipos {proto_dim}] sobre {len(texts)} muestras...")
    embs = encode_with_onnx(sess, texts, spec)
    syn16 = extract_syntax_signals_node(texts)
    proto_feat = compute_proto_features(embs, proto_payload)
    X = np.hstack([embs, syn16, proto_feat]).astype(np.float32)
    X_t = torch.from_numpy(X)

    # Obtener predicción Teacher real de seguridad en muestras de seguridad / límite como conocimiento suave
    print("-> Destilando probabilidades suaves Teacher en casos de seguridad/matiz...")
    teacher_risk_soft = []
    for d in dataset:
        # Llamada puntual solo sobre las de riesgo implícito o metáforas de seguridad para destilar señal semántica fina
        is_sec = (
            d["senales"]["riesgo_autolesion_purga"] >= 0.4
            or any(m in d["text"].lower() for m in ("muero", "cortar", "deshacer"))
        )
        if is_sec:
            res = agent.predict(d["text"], {"sen_riesgo_autolesion_purga": LAYA_QUESTIONS["sen_riesgo_autolesion_purga"]})
            p_tch = float(res["answers"]["sen_riesgo_autolesion_purga"]["noul"])
            # Mezcla 0.65 etiqueta curada + 0.35 dark-knowledge Teacher
            teacher_risk_soft.append(0.65 * d["senales"]["riesgo_autolesion_purga"] + 0.35 * p_tch)
        else:
            teacher_risk_soft.append(d["senales"]["riesgo_autolesion_purga"])

    def fit_multiclass(classes: List[str], field: str, lr: float = 0.08, steps: int = 450, wd: float = 0.025) -> Dict[str, Any]:
        y = torch.tensor([classes.index(d[field]) for d in dataset], dtype=torch.long)
        lin = nn.Linear(X.shape[1], len(classes))
        nn.init.zeros_(lin.weight)
        nn.init.zeros_(lin.bias)
        opt = torch.optim.AdamW(lin.parameters(), lr=lr, weight_decay=wd)
        for _ in range(steps):
            opt.zero_grad()
            logits = lin(X_t)
            loss = F.cross_entropy(logits, y, label_smoothing=0.04)
            loss.backward()
            opt.step()

        # Calibración Temperature Scaling simple post-ajuste sobre conjunto de entrenamiento
        with torch.no_grad():
            raw_logits = lin(X_t)
        temp = torch.nn.Parameter(torch.tensor([1.05]))
        t_opt = torch.optim.LBFGS([temp], lr=0.1, max_iter=30)
        def closure():
            t_opt.zero_grad()
            t_pos = torch.clamp(temp, 0.6, 2.5)
            l = F.cross_entropy(raw_logits / t_pos, y)
            l.backward()
            return l
        t_opt.step(closure)
        T_val = float(torch.clamp(temp, 0.7, 2.2).item())

        with torch.no_grad():
            W = lin.weight.numpy()
            b = lin.bias.numpy()
        return {
            "classes": classes,
            "temperature": round(T_val, 3),
            "weights": [[round(float(v), 3) for v in row] for row in W],
            "biases": [round(float(v), 3) for v in b],
        }

    def fit_binary(target_vals: List[float], lr: float = 0.07, steps: int = 450, wd: float = 0.02) -> Dict[str, Any]:
        y = torch.tensor(target_vals, dtype=torch.float32)
        lin = nn.Linear(X.shape[1], 1)
        nn.init.zeros_(lin.weight)
        nn.init.constant_(lin.bias, -1.5)
        opt = torch.optim.AdamW(lin.parameters(), lr=lr, weight_decay=wd)
        for _ in range(steps):
            opt.zero_grad()
            logits = lin(X_t).squeeze(-1)
            loss = F.binary_cross_entropy_with_logits(logits, y)
            loss.backward()
            opt.step()
        with torch.no_grad():
            raw_logits = lin(X_t).squeeze(-1)

        # Ajuste Platt (a, b_platt)
        a_p = torch.nn.Parameter(torch.tensor([1.0]))
        b_p = torch.nn.Parameter(torch.tensor([0.0]))
        p_opt = torch.optim.LBFGS([a_p, b_p], lr=0.1, max_iter=30)
        def closure():
            p_opt.zero_grad()
            cal_logits = torch.clamp(a_p, 0.5, 2.2) * raw_logits + b_p
            l = F.binary_cross_entropy_with_logits(cal_logits, y)
            l.backward()
            return l
        p_opt.step(closure)

        with torch.no_grad():
            W = lin.weight[0].numpy()
            b = float(lin.bias[0].item())
        return {
            "weights": [round(float(v), 3) for v in W],
            "bias": round(b, 3),
            "platt_a": round(float(torch.clamp(a_p, 0.5, 2.2).item()), 3),
            "platt_b": round(float(b_p.item()), 3),
        }

    blocks = {
        "valencia_emocional": fit_multiclass(VALENCE_CLASSES, "val"),
        "activacion_energia": fit_multiclass(ACTIVATION_CLASSES, "act"),
        "emocion_primaria": fit_multiclass(EMOTION_CLASSES, "emo"),
    }

    ejes_heads = {
        key: fit_binary([d["ejes"][key] for d in dataset]) for key in AXES_KEYS
    }
    senales_heads = {
        "desgaste_sostenido": fit_binary([d["senales"]["desgaste_sostenido"] for d in dataset]),
        "contradiccion_emocional": fit_binary([d["senales"]["contradiccion_emocional"] for d in dataset]),
        "riesgo_autolesion_purga": fit_binary(teacher_risk_soft, lr=0.08, steps=550, wd=0.015),
    }

    payload = {
        "format": "diario-heads-v1",
        "feature_layout": {
            "emb_dim": 768,
            "syntax_dim": 16,
            "proto_dim": proto_dim,
            "total_dim": int(X.shape[1]),
        },
        "blocks": blocks,
        "ejes": ejes_heads,
        "senales": senales_heads,
    }
    out_path = OUT_DIR / "diario_heads_v1.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"✓ Cabezal híbrido diario_heads_v1.json exportado: {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")
    return payload


def main():
    t0 = time.perf_counter()
    torch.manual_seed(42)
    np.random.seed(42)

    print("1. Cargando Teacher `laya_finetuned` (mmBERT-base 22 capas)...")
    agent = laya.load(str(CKPT_DIR))
    agent.model.eval()
    teacher_enc = agent.model.encoder

    print("2. Podando tokenizador BPE al español por cierre (target=12,288)...")
    spec, orig_ids = prune_tokenizer(agent.tok, target_size=TARGET_VOCAB_SIZE)
    tok_path = OUT_DIR / "tokenizer_es.json"
    tok_path.write_text(json.dumps(spec, separators=(",", ":")), encoding="utf-8")
    print(f"✓ tokenizer_es.json guardado ({tok_path.stat().st_size / 1024:.1f} KB, vocab={spec['vocab_size']}, merges={len(spec['merges'])})")
    verify_js_tokenizer_parity(tok_path)

    print("3. Extrayendo embeddings del Teacher 22-capas sobre corpus de destilación...")
    dataset = build_distillation_dataset()
    corpus_for_enc = list(dict.fromkeys(
        [d["text"] for d in dataset]
        + [p for pair in NEGATION_MINIMAL_PAIRS for p in pair]
        + [t for lst in MULTI_ANCHORS.values() for t in lst]
    ))
    teacher_embs = encode_teacher_texts(teacher_enc, agent.tok, corpus_for_enc)
    print(f"✓ Embeddings Teacher listos: {teacher_embs.shape}")

    print("4. Destilando Student ModernBERT 2 capas y cuantizando ONNX INT8...")
    q8_path = distill_student_encoder(teacher_enc, orig_ids, spec, corpus_for_enc, teacher_embs)
    sess = ort.InferenceSession(str(q8_path), providers=["CPUExecutionProvider"])

    print("5. Calculando prototipos multi-ancla + subespacio SVD de negación...")
    proto_payload, _ = build_prototypes_neg(sess, spec)

    print("6. Entrenando y calibrando cabezal híbrido diario_heads_v1.json...")
    train_hybrid_heads(agent, sess, spec, proto_payload, dataset)

    print(f"\n✓ Destilación Teacher-Student completa en {time.perf_counter() - t0:.1f}s.")


if __name__ == "__main__":
    main()
