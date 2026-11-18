"""
Script de evaluación para Laya AI sobre el conjunto en español (data/eval_es.jsonl).
Mide precisión (accuracy) y calibración de probabilidades/porcentajes en:
- Valencia emocional
- Nivel de energía / activación
- Emoción primaria dominante
Genera el reporte data/eval_report.json.
"""

import sys
import json
from pathlib import Path

# Agregar raíz al sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import EVAL_ES_PATH, EVAL_REPORT_PATH
from backend.services.laya_engine import classify_text_with_laya

def evaluate_dataset(dataset_path: Path):
    if not dataset_path.exists():
        print(f"Error: No se encontró el dataset en {dataset_path}")
        return None

    samples = []
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                samples.append(json.loads(line.strip()))

    total = len(samples)
    print(f"\n=======================================================")
    print(f" Evaluando Laya Multilingual sobre {total} casos en español")
    print(f"=======================================================\n")

    correct_valencia = 0
    correct_energia = 0
    correct_emocion = 0
    confidences_valencia = []

    details = []

    for i, s in enumerate(samples, 1):
        text = s["text"]
        exp_val = s.get("expected_valencia")
        exp_ene = s.get("expected_energia")
        exp_emo = s.get("expected_emocion")

        profile = classify_text_with_laya(text)
        if not profile:
            continue

        pred_val = profile.valencia_emocional.choice
        pred_ene = profile.activacion_energia.choice
        pred_emo = profile.emocion_primaria.choice
        val_conf = profile.valencia_emocional.answer_confidence

        match_val = (pred_val == exp_val)
        match_ene = (pred_ene == exp_ene)
        match_emo = (pred_emo == exp_emo)

        if match_val: correct_valencia += 1
        if match_ene: correct_energia += 1
        if match_emo: correct_emocion += 1

        confidences_valencia.append(val_conf)

        details.append({
            "id": s["id"],
            "text": text[:60] + "...",
            "valencia": {"exp": exp_val, "pred": pred_val, "match": match_val},
            "energia": {"exp": exp_ene, "pred": pred_ene, "match": match_ene},
            "emocion": {"exp": exp_emo, "pred": pred_emo, "match": match_emo},
            "confidence": val_conf
        })

    acc_valencia = round(correct_valencia / total, 4)
    acc_energia = round(correct_energia / total, 4)
    acc_emocion = round(correct_emocion / total, 4)
    overall_acc = round((acc_valencia + acc_energia + acc_emocion) / 3.0, 4)
    avg_confidence = round(sum(confidences_valencia) / len(confidences_valencia), 4) if confidences_valencia else 0.0

    report = {
        "dataset": str(dataset_path.name),
        "total_samples": total,
        "metrics": {
            "accuracy_valencia": acc_valencia,
            "accuracy_energia": acc_energia,
            "accuracy_emocion": acc_emocion,
            "overall_accuracy": overall_acc,
            "average_confidence": avg_confidence,
            "calibration_gap": round(abs(avg_confidence - acc_valencia), 4)
        },
        "details": details
    }

    # Guardar reporte
    with open(EVAL_REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("--- RESULTADOS DE EVALUACIÓN ---")
    print(f"• Exactitud Valencia Emocional: {acc_valencia * 100:.1f}% ({correct_valencia}/{total})")
    print(f"• Exactitud Activación / Energía: {acc_energia * 100:.1f}% ({correct_energia}/{total})")
    print(f"• Exactitud Emoción Primaria:   {acc_emocion * 100:.1f}% ({correct_emocion}/{total})")
    print(f"• Exactitud Global Promedio:    {overall_acc * 100:.1f}%")
    print(f"• Confianza Media de Laya:     {avg_confidence * 100:.1f}%")
    print(f"• Brecha de Calibración:        {report['metrics']['calibration_gap'] * 100:.1f}%")
    print(f"=======================================================")
    print(f"Reporte detallado guardado en: {EVAL_REPORT_PATH}\n")

    return report

if __name__ == "__main__":
    evaluate_dataset(EVAL_ES_PATH)
