"""
Bucle automático de reentrenamiento y calibración condicional (laya-train).
Si la evaluación inicial arroja accuracy < 0.75 o calibración deficiente:
1. Genera el lote de entrenamiento formateado (data/train_seed.jsonl).
2. Ejecuta laya.train.finetune con calibración automática de temperaturas.
3. Conecta el nuevo checkpoint ajustado a backend/services/laya_engine.py.
4. Vuelve a ejecutar la evaluación sobre data/eval_es.jsonl y genera un reporte Antes vs Después.
"""

import sys
import os
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import laya
import laya.train
from backend.config import EVAL_ES_PATH, TRAIN_SEED_PATH, EVAL_REPORT_PATH
from backend.services.laya_engine import LAYA_QUESTIONS, classify_text_with_laya
from scripts.evaluate_laya import evaluate_dataset

SNAPSHOT_DIR = Path(os.path.expanduser("~/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots"))

def find_multilingual_model_dir() -> Path:
    """Busca el directorio del modelo multilingüe en la caché local."""
    for p in SNAPSHOT_DIR.rglob("*"):
        if p.is_dir() and (p / "multilingual" / "model.safetensors").exists():
            return p / "multilingual"
        if p.is_dir() and (p / "model.safetensors").exists() and "multilingual" in str(p):
            return p
    # Fallback directo al snapshot conocido
    for snap in SNAPSHOT_DIR.glob("*"):
        cand = snap / "multilingual"
        if cand.exists():
            return cand
    raise FileNotFoundError("No se encontró el checkpoint multilingüe en la caché local.")

def run_retraining_pipeline():
    print("=================================================================")
    print(" INICIANDO PIPELINE DE EVALUACIÓN Y REENTRENAMIENTO CONDICIONAL")
    print("=================================================================\n")

    # Paso 1: Evaluación Inicial Base
    print("Paso 1: Evaluando checkpoint base...")
    before_report = evaluate_dataset(EVAL_ES_PATH)
    if not before_report:
        print("Error en evaluación inicial.")
        return

    acc_before = before_report["metrics"]["overall_accuracy"]
    print(f"\n[Evaluación Inicial] Exactitud Global: {acc_before * 100:.1f}%")

    # Paso 2: Condición de reentrenamiento
    if acc_before >= 0.75:
        print("✓ La exactitud base supera el umbral de 75%. No se requiere reentrenamiento.")
        return

    print("! La exactitud base es menor a 0.75. Ejecutando reentrenamiento condicional...")

    # Paso 3: Preparar datos de entrenamiento (data/train_seed.jsonl)
    train_formatted_path = PROJECT_ROOT / "data" / "train_formatted.jsonl"
    formatted_rows = []
    with open(TRAIN_SEED_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                item = json.loads(line.strip())
                labeled_q = {k: LAYA_QUESTIONS[k] for k in item["gold"].keys() if k in LAYA_QUESTIONS}
                formatted_rows.append({
                    "state": item["state"],
                    "questions": labeled_q,
                    "expected": item["gold"]
                })

    with open(train_formatted_path, "w", encoding="utf-8") as f:
        for r in formatted_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"✓ Lote de entrenamiento preparado: {len(formatted_rows)} ejemplos.")

    # Paso 4: Ajuste fino mediante laya-train
    model_dir = find_multilingual_model_dir()
    checkpoint_out = PROJECT_ROOT / "data" / "checkpoints" / "laya_finetuned"
    checkpoint_out.mkdir(parents=True, exist_ok=True)

    print(f"-> Checkpoint base: {model_dir}")
    print(f"-> Destino afinado: {checkpoint_out}")

    config = laya.train.TrainConfig(
        epochs=3,
        micro_batch=4,
        freeze_encoder=True,
        calib_max=50,
        target_error=0.10
    )

    print("\nEjecutando laya.train.finetune con calibración automática de temperaturas...")
    train_summary = laya.train.finetune(
        data=str(train_formatted_path),
        model_dir=str(model_dir),
        output_dir=str(checkpoint_out),
        config=config,
        device="cpu"
    )
    print("✓ Ajuste fino completado exitosamente.")

    # Paso 5: Conectar nuevo checkpoint al backend
    import backend.services.laya_engine as le
    print("\nConectando nuevo checkpoint afinado al backend...")
    le._agent_instance = laya.load(str(checkpoint_out))

    # Paso 6: Re-evaluación y reporte comparativo Antes vs Después
    print("\nPaso 6: Re-evaluando sobre eval_es.jsonl con el modelo afinado...")
    after_report = evaluate_dataset(EVAL_ES_PATH)

    acc_after = after_report["metrics"]["overall_accuracy"]
    gap_before = before_report["metrics"]["calibration_gap"]
    gap_after = after_report["metrics"]["calibration_gap"]

    comparative_report = {
        "status": "retrained_and_calibrated",
        "checkpoint_used": str(checkpoint_out),
        "before": before_report["metrics"],
        "after": after_report["metrics"],
        "improvement": {
            "overall_accuracy_gain": round((acc_after - acc_before) * 100, 2),
            "calibration_gap_reduction": round((gap_before - gap_after) * 100, 2)
        }
    }

    with open(EVAL_REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(comparative_report, f, indent=2, ensure_ascii=False)

    print("\n=======================================================")
    print("          REPORTE COMPARATIVO ANTES vs. DESPUÉS        ")
    print("=======================================================")
    print(f"Exactitud Valencia:   {before_report['metrics']['accuracy_valencia']*100:.1f}% -> {after_report['metrics']['accuracy_valencia']*100:.1f}%")
    print(f"Exactitud Activación: {before_report['metrics']['accuracy_energia']*100:.1f}% -> {after_report['metrics']['accuracy_energia']*100:.1f}%")
    print(f"Exactitud Emoción:    {before_report['metrics']['accuracy_emocion']*100:.1f}% -> {after_report['metrics']['accuracy_emocion']*100:.1f}%")
    print(f"Exactitud Global:     {acc_before*100:.1f}% -> {acc_after*100:.1f}% (+{(acc_after - acc_before)*100:.1f}%)")
    print(f"Brecha Calibración:   {gap_before*100:.1f}% -> {gap_after*100:.1f}%")
    print("=======================================================\n")

if __name__ == "__main__":
    run_retraining_pipeline()
