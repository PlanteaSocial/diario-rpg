/**
 * Suite Comparativa Fase C: Evalua las 5 Baterias Criticas y el corpus held-out (eval_es.jsonl)
 * comparando:
 *   1. Motor Anterior v1 (`heuristica-local-js` conteo simple de palabras)
 *   2. Tier 0 Sintaxis + Calibracion (`laya-syntax-calibrada-js`, < 300 KB, < 2 ms)
 *   3. Tier 1 Hibrido ONNX INT8 + Cabezal Destilado (`model_es_q8.onnx` + `diario_heads_v1.json`)
 *
 * Uso: node tests/eval_suite.mjs [--json] [--no-onnx]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SyntaxFeatures = require(path.join(ROOT, "frontend/js/ml/syntax_features.js"));
const CalibrationMath = require(path.join(ROOT, "frontend/js/ml/calibration_math.js"));
const SuggestionEngine = require(path.join(ROOT, "frontend/js/ml/suggestion_engine.js"));
const BpeTokenizer = require(path.join(ROOT, "frontend/js/ml/bpe_tokenizer.js"));
const ClientEngine = require(path.join(ROOT, "frontend/js/client_engine.js"));

globalThis.SyntaxFeatures = SyntaxFeatures;
globalThis.CalibrationMath = CalibrationMath;
globalThis.SuggestionEngine = SuggestionEngine;
globalThis.BpeTokenizer = BpeTokenizer;

const BATTERIES = [
  {
    id: "B1",
    name: "Negaciones simples y compuestas",
    text: "No me siento nada bien, por más que intenté estar tranquilo hoy no pude concentrarme ni tantito",
    questionnaire: { self_report_word: "mal", valence_rating: 1, workload_rating: 3, sleep_hours: 7.0 },
    check(det) {
      const p = det.profile.valencia_emocional.probabilities;
      const pNeg = (p.muy_negativo || 0) + (p.negativo || 0);
      const pPos = (p.positivo || 0) + (p.muy_positivo || 0);
      return {
        passed: pNeg >= 0.80 && pPos <= 0.08,
        metrics: { pNeg: Number(pNeg.toFixed(4)), pPos: Number(pPos.toFixed(4)) },
        summary: `P(neg)=${pNeg.toFixed(3)} (>=0.80), P(pos)=${pPos.toFixed(3)} (<=0.08)`
      };
    }
  },
  {
    id: "B2",
    name: "Modismos mexicanos de sobrecarga",
    text: "Estuve todo el día en piloto automático, siento que la lista nunca se achica y ya no me da la cabeza",
    questionnaire: { self_report_word: "regular", valence_rating: 2, workload_rating: 5, sleep_hours: 6.5 },
    check(det) {
      const carga = det.profile.ejes_tematicos.carga_mental || 0;
      const desg = det.profile.senales_alerta.desgaste_sostenido || 0;
      const act = det.profile.activacion_energia.choice;
      const safety = ClientEngine.evaluateSafety(this.text, det.profile.senales_alerta);
      const ok = carga >= 0.80 && desg >= 0.85 && safety.level === "pause" && act === "agotamiento_baja";
      return {
        passed: ok,
        metrics: { carga: Number(carga.toFixed(4)), desg: Number(desg.toFixed(4)), act, safetyLevel: safety.level },
        summary: `carga=${carga.toFixed(3)}, desg=${desg.toFixed(3)} (${safety.level}), act=${act}`
      };
    }
  },
  {
    id: "B3",
    name: "Discrepancia e ironia",
    text: "Qué 'maravilloso' día, otra vez apagando fuegos hasta las 11 pm, según yo todo bajo control pero estoy fundido",
    questionnaire: { self_report_word: "bien", valence_rating: 4, workload_rating: 4, sleep_hours: 6.0 },
    check(det) {
      const p = det.profile.valencia_emocional.probabilities;
      const pNeg = (p.muy_negativo || 0) + (p.negativo || 0);
      const contra = det.profile.senales_alerta.contradiccion_emocional || 0;
      const disc = ClientEngine.detectDiscrepancy(this.questionnaire, det.profile);
      const ok = Boolean(disc.has_discrepancy) && pNeg >= 0.65 && contra >= 0.75;
      return {
        passed: ok,
        metrics: { pNeg: Number(pNeg.toFixed(4)), contra: Number(contra.toFixed(4)), discrepancy: Boolean(disc.has_discrepancy) },
        summary: `Disc=${disc.has_discrepancy}, P(neg)=${pNeg.toFixed(3)} (>=0.65), contra=${contra.toFixed(3)} (>=0.75)`
      };
    }
  },
  {
    id: "B4",
    name: "Dias neutros y descriptivos",
    text: "Fui a comprar tortillas, adelanté dos prácticas de contabilidad, hablé con mi mamá y me dormí a las 11",
    questionnaire: { self_report_word: "bien", valence_rating: 4, workload_rating: 2, sleep_hours: 8.0 },
    check(det) {
      const p = det.profile.valencia_emocional.probabilities;
      const pNeuPos = (p.neutro || 0) + (p.positivo || 0);
      const desg = det.profile.senales_alerta.desgaste_sostenido || 0;
      const risk = det.profile.senales_alerta.riesgo_autolesion_purga || 0;
      const safety = ClientEngine.evaluateSafety(this.text, det.profile.senales_alerta);
      const ok = pNeuPos >= 0.75 && desg <= 0.25 && risk <= 0.10 && !safety.is_triggered;
      return {
        passed: ok,
        metrics: { pNeuPos: Number(pNeuPos.toFixed(4)), desg: Number(desg.toFixed(4)), risk: Number(risk.toFixed(4)) },
        summary: `P(neu+pos)=${pNeuPos.toFixed(3)}, desg=${desg.toFixed(3)}, risk=${risk.toFixed(3)}`
      };
    }
  },
  {
    id: "B5",
    name: "Seguridad explicita e implicita",
    text: "Quisiera apagarme por completo y desaparecer, o deshacerme de todo lo que comí hoy porque no lo soporto",
    questionnaire: { self_report_word: "mal", valence_rating: 1, workload_rating: 4, sleep_hours: 5.0 },
    check(det) {
      const risk = det.profile.senales_alerta.riesgo_autolesion_purga || 0;
      const safety = ClientEngine.evaluateSafety(this.text, det.profile.senales_alerta);
      const ok = risk >= 0.50 && safety.is_triggered && safety.level === "alert";
      return {
        passed: ok,
        metrics: { risk: Number(risk.toFixed(4)), safetyLevel: safety.level, gate: safety.gate },
        summary: `risk=${risk.toFixed(3)} (>=0.50), level=${safety.level} (${safety.gate})`
      };
    }
  }
];

function classifyLegacyV1(text) {
  const origResolveSyn = ClientEngine._resolveSyntaxModule;
  const origResolveCal = ClientEngine._resolveCalibrationModule;
  ClientEngine._resolveSyntaxModule = () => null;
  ClientEngine._resolveCalibrationModule = () => null;
  try {
    return ClientEngine.classifyTextDetailed(text);
  } finally {
    ClientEngine._resolveSyntaxModule = origResolveSyn;
    ClientEngine._resolveCalibrationModule = origResolveCal;
  }
}

function runOnnxBatchInPython(texts, tokSpec) {
  const pyBin = "/tmp/diario_ml_venv/bin/python";
  const onnxPath = path.join(ROOT, "models/model_es_q8.onnx");
  if (!fs.existsSync(pyBin) || !fs.existsSync(onnxPath)) {
    return null;
  }
  const tok = BpeTokenizer.create(tokSpec);
  const encoded = texts.map((t) => tok.encode(t, 128));
  const script = `
import json, sys, time
import numpy as np
import onnxruntime as ort

items = json.loads(sys.stdin.read())
sess = ort.InferenceSession(${JSON.stringify(onnxPath)}, providers=["CPUExecutionProvider"])
# Warmup
sess.run(None, {
  "input_ids": np.array([[2, 100, 1]], dtype=np.int64),
  "attention_mask": np.array([[1, 1, 1]], dtype=np.int64),
})
out = []
for item in items:
    ids = np.array([item["inputIds"]], dtype=np.int64)
    mask = np.array([item["attentionMask"]], dtype=np.int64)
    t0 = time.perf_counter()
    emb = sess.run(None, {"input_ids": ids, "attention_mask": mask})[0][0]
    ms = (time.perf_counter() - t0) * 1000.0
    out.append({"emb": emb.tolist(), "ms": ms})
print(json.dumps(out))
`;
  const raw = execFileSync(pyBin, ["-c", script], {
    input: JSON.stringify(encoded),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(raw);
}

function classifyTier1FromEmb(text, emb, msOnnx, questionnaire, prototypes, heads) {
  const t0 = performance.now();
  const syn = SyntaxFeatures.extract(text, questionnaire || null);
  const explicitRisk = ClientEngine.matchesExplicitRiskRegex(text);
  const cal = CalibrationMath.scoreTier1Hybrid(emb, syn.signals16, {
    prototypes,
    heads,
    priorDesgasteSeries: [],
    explicitRegexRisk: explicitRisk
  });
  const totalMs = msOnnx + (performance.now() - t0);
  return ClientEngine.buildDetailedTraceFromProfile(text, {
    valRes: cal.valencia_emocional,
    actRes: cal.activacion_energia,
    emoRes: cal.emocion_primaria,
    ejesOut: cal.ejes_tematicos,
    senalesOut: cal.senales_alerta,
    tokens: syn.tokenCount,
    latencyMs: totalMs,
    backendName: "laya-onnx-q8-worker",
    syntaxAnalysis: syn,
    calibrationMeta: cal.calibration_meta
  });
}

function polarity(v) {
  if (v === "muy_negativo" || v === "negativo") return "neg";
  if (v === "positivo" || v === "muy_positivo") return "pos";
  return "neu";
}

function evaluateHoldoutJsonl(evalPath, prototypes, heads, tokSpec, skipOnnx) {
  const lines = fs.readFileSync(evalPath, "utf8").trim().split("\n").filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  const texts = rows.map((r) => r.text || r.state || "");
  const onnxOut = skipOnnx ? null : runOnnxBatchInPython(texts, tokSpec);

  const stats = {};
  const engines = [
    { key: "v1", fn: (i) => classifyLegacyV1(texts[i]) },
    { key: "tier0", fn: (i) => ClientEngine.classifyTextDetailed(texts[i]) }
  ];
  if (onnxOut) {
    engines.push({
      key: "tier1",
      fn: (i) => classifyTier1FromEmb(texts[i], onnxOut[i].emb, onnxOut[i].ms, null, prototypes, heads)
    });
  }

  for (const eng of engines) {
    let valExact = 0;
    let polExact = 0;
    let actExact = 0;
    let emoExact = 0;
    let falseAlarms = 0;
    let totalMs = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const goldVal = row.expected_valencia || (row.gold && row.gold.valencia_emocional);
      const goldAct = row.expected_energia || (row.gold && row.gold.activacion_energia);
      const goldEmo = row.expected_emocion || (row.gold && row.gold.emocion_primaria);
      const t0 = performance.now();
      const det = eng.fn(i);
      const dt = eng.key === "tier1" ? onnxOut[i].ms : (performance.now() - t0);
      totalMs += dt;
      const p = det.profile;
      if (p.valencia_emocional.choice === goldVal) valExact++;
      if (polarity(p.valencia_emocional.choice) === polarity(goldVal)) polExact++;
      if (p.activacion_energia.choice === goldAct) actExact++;
      if (p.emocion_primaria.choice === goldEmo) emoExact++;
      if (goldVal === "neutro" && (p.senales_alerta.riesgo_autolesion_purga || 0) >= 0.5) {
        falseAlarms++;
      }
    }
    stats[eng.key] = {
      n: rows.length,
      valExact,
      polExact,
      actExact,
      emoExact,
      falseAlarms,
      avgMs: Number((totalMs / rows.length).toFixed(3))
    };
  }
  return stats;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const jsonMode = args.has("--json");
  const skipOnnx = args.has("--no-onnx");

  const tokSpec = JSON.parse(fs.readFileSync(path.join(ROOT, "models/tokenizer_es.json"), "utf8"));
  const prototypes = JSON.parse(fs.readFileSync(path.join(ROOT, "models/prototypes_neg_v1.json"), "utf8"));
  const heads = JSON.parse(fs.readFileSync(path.join(ROOT, "models/diario_heads_v1.json"), "utf8"));

  // Warmup Tier 0
  for (let i = 0; i < 8; i++) ClientEngine.classifyTextDetailed(BATTERIES[0].text, { questionnaire: BATTERIES[0].questionnaire });

  const bTexts = BATTERIES.map((b) => b.text);
  const onnxBatteries = skipOnnx ? null : runOnnxBatchInPython(bTexts, tokSpec);

  const batteryReport = [];
  let allTier0Pass = true;
  let allTier1Pass = true;

  for (let i = 0; i < BATTERIES.length; i++) {
    const b = BATTERIES[i];
    const t0V1 = performance.now();
    const resV1 = classifyLegacyV1(b.text);
    const msV1 = performance.now() - t0V1;

    const t0T0 = performance.now();
    const resT0 = ClientEngine.classifyTextDetailed(b.text, { questionnaire: b.questionnaire });
    const msT0 = performance.now() - t0T0;

    const cV1 = b.check(resV1);
    const cT0 = b.check(resT0);
    if (!cT0.passed) allTier0Pass = false;

    let cT1 = null;
    let msT1 = null;
    if (onnxBatteries) {
      const resT1 = classifyTier1FromEmb(
        b.text,
        onnxBatteries[i].emb,
        onnxBatteries[i].ms,
        b.questionnaire,
        prototypes,
        heads
      );
      msT1 = resT1.latency_ms;
      cT1 = b.check(resT1);
      if (!cT1.passed) allTier1Pass = false;
    }

    batteryReport.push({
      id: b.id,
      name: b.name,
      v1: { ...cV1, ms: Number(msV1.toFixed(3)) },
      tier0: { ...cT0, ms: Number(msT0.toFixed(3)) },
      tier1: cT1 ? { ...cT1, ms: Number(msT1.toFixed(3)) } : null
    });
  }

  const evalStats = evaluateHoldoutJsonl(path.join(ROOT, "data/eval_es.jsonl"), prototypes, heads, tokSpec, skipOnnx);

  const modelFiles = {
    tokenizer_es_kb: Number((fs.statSync(path.join(ROOT, "models/tokenizer_es.json")).size / 1024).toFixed(1)),
    diario_heads_v1_kb: Number((fs.statSync(path.join(ROOT, "models/diario_heads_v1.json")).size / 1024).toFixed(1)),
    prototypes_neg_v1_kb: Number((fs.statSync(path.join(ROOT, "models/prototypes_neg_v1.json")).size / 1024).toFixed(1)),
    model_es_q8_mb: Number((fs.statSync(path.join(ROOT, "models/model_es_q8.onnx")).size / (1024 * 1024)).toFixed(2))
  };

  const payload = {
    allTier0Pass,
    allTier1Pass,
    batteryReport,
    evalStats,
    modelFiles
  };

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("\n=== FASE C: EVALUACION COMPARATIVA (Antes v1 vs Tier 0 vs Tier 1 ONNX INT8) ===\n");
    for (const r of batteryReport) {
      console.log(`[${r.id}] ${r.name}`);
      console.log(`  Antes (v1) : ${r.v1.passed ? "PASS" : "FAIL"} | ${r.v1.summary} | ${r.v1.ms} ms`);
      console.log(`  Tier 0 (JS): ${r.tier0.passed ? "PASS" : "FAIL"} | ${r.tier0.summary} | ${r.tier0.ms} ms`);
      if (r.tier1) {
        console.log(`  Tier 1 (Q8): ${r.tier1.passed ? "PASS" : "FAIL"} | ${r.tier1.summary} | ${r.tier1.ms} ms`);
      }
    }
    console.log("\n=== HELD-OUT eval_es.jsonl (n=25) ===");
    for (const [k, st] of Object.entries(evalStats)) {
      console.log(`  ${k.padEnd(6)}: val=${st.valExact}/${st.n} | pol=${st.polExact}/${st.n} | ene=${st.actExact}/${st.n} | emo=${st.emoExact}/${st.n} | falsas_alarmas=${st.falseAlarms} | latencia_prom=${st.avgMs} ms`);
    }
    console.log("\n=== ARTEFACTOS ONNX/HÍBRIDOS (en GitHub CDN, 0 B en Firebase Hosting) ===");
    console.log(modelFiles);
  }

  if (!allTier0Pass || (onnxBatteries && !allTier1Pass)) {
    process.exit(1);
  }
}

main();
