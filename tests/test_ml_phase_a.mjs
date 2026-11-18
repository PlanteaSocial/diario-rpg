import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SyntaxFeatures = require(path.join(ROOT, "frontend/js/ml/syntax_features.js"));
const CalibrationMath = require(path.join(ROOT, "frontend/js/ml/calibration_math.js"));
const SuggestionEngine = require(path.join(ROOT, "frontend/js/ml/suggestion_engine.js"));
const ClientEngine = require(path.join(ROOT, "frontend/js/client_engine.js"));

// Exponer globales igual que en navegador para integración directa.
globalThis.SyntaxFeatures = SyntaxFeatures;
globalThis.CalibrationMath = CalibrationMath;
globalThis.SuggestionEngine = SuggestionEngine;

test("1. Presupuesto de peso (< 300 KB) y latencia en frío/caliente (< 2 ms)", () => {
  const mlDir = path.join(ROOT, "frontend/js/ml");
  const files = ["syntax_features.js", "calibration_math.js", "suggestion_engine.js"];
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += fs.statSync(path.join(mlDir, f)).size;
  }
  assert.ok(totalBytes < 300 * 1024, `Peso excedido: ${totalBytes} bytes`);

  const sample = "En el trabajo dije que todo bien, pero la verdad estoy en piloto automático y ya no me da la cabeza.";
  // Warmup JIT
  for (let i = 0; i < 10; i++) ClientEngine.classifyTextDetailed(sample);

  const runs = 50;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    ClientEngine.classifyTextDetailed(sample);
  }
  const avgMs = (performance.now() - t0) / runs;
  assert.ok(avgMs < 2.0, `Latencia promedio esperada < 2 ms, observada: ${avgMs.toFixed(3)} ms`);
});

test("2. Segmentación por cláusulas, peso post-adversativo 1.65 y 16 señales sintácticas", () => {
  const text = "En el trabajo dije que todo bien, pero la verdad estoy en piloto automático y ya no me da la cabeza.";
  const syn = SyntaxFeatures.extract(text, { self_report_word: "bien", valence_rating: 4 });

  assert.equal(syn.clauses.length, 2);
  assert.equal(syn.clauses[0].weight, 1.0);
  assert.equal(syn.clauses[0].isPostAdversative, false);
  assert.equal(syn.clauses[1].weight, 1.65);
  assert.equal(syn.clauses[1].isPostAdversative, true);

  // Exactamente 16 señales explícitas declaradas
  assert.equal(Object.keys(syn.signals16).length, 16);
  assert.ok(syn.signals16.sig_adversative_ratio > 0);
  assert.ok(syn.signals16.sig_idiom_mental_load > 0);
  assert.ok(syn.signals16.sig_intra_note_contradiction > 0);
  assert.ok(syn.signals16.sig_self_report_gap > 0);

  // El peso post-adversativo + modismos debe superar el "todo bien" inicial
  const res = ClientEngine.classifyTextDetailed(text, { questionnaire: { self_report_word: "bien", valence_rating: 4 } });
  const probs = res.profile.valencia_emocional.probabilities;
  const pNeg = (probs.negativo || 0) + (probs.muy_negativo || 0);
  assert.ok(pNeg >= 0.65, `Se esperaba pNeg >= 0.65 tras giro adversativo, obtenido ${pNeg}`);
  assert.ok(res.profile.ejes_tematicos.carga_mental >= 0.75);

  const disc = ClientEngine.detectDiscrepancy({ self_report_word: "bien", valence_rating: 4 }, res.profile);
  assert.equal(disc.has_discrepancy, true);
  assert.equal(disc.level, "marked");
});

test("3. Negación activa (5 tokens), doble negación, intensificadores e ironía", () => {
  // Negación dentro de ventana de 5 tokens no debe sumar positivo
  const negated = "No me siento nada bien, ni tantito tranquilo y sin ganas de concentrarme.";
  const negRes = ClientEngine.classifyTextDetailed(negated);
  const pPos = (negRes.profile.valencia_emocional.probabilities.positivo || 0) +
               (negRes.profile.valencia_emocional.probabilities.muy_positivo || 0);
  const pNeg = (negRes.profile.valencia_emocional.probabilities.negativo || 0) +
               (negRes.profile.valencia_emocional.probabilities.muy_negativo || 0);
  assert.ok(pNeg >= 0.65, `Doble negación debe dominar en negativo (pNeg=${pNeg})`);
  assert.ok(pPos < 0.15, `Palabras positivas negadas no deben inflar positivo (pPos=${pPos})`);
  assert.ok(negRes.syntax_analysis.signals16.sig_double_negation > 0);
  assert.ok(negRes.syntax_analysis.signals16.sig_negated_positive > 0);
  assert.ok(negRes.syntax_analysis.signals16.sig_negated_sleep_energy > 0);

  // Ironía entrecomillada y exclamativa dentro de queja
  const ironic = 'Qué "maravilloso" día con mil pendientes; según yo muy \'feliz\' y ya estoy fundido!';
  const ironRes = ClientEngine.classifyTextDetailed(ironic);
  assert.ok(ironRes.syntax_analysis.signals16.sig_ironic_quotes > 0, "Debe detectar ironía entrecomillada");
  const ironPos = ironRes.profile.valencia_emocional.probabilities.muy_positivo || 0;
  assert.ok(ironPos < 0.1, `Ironía no debe disparar muy_positivo (${ironPos})`);
  assert.ok(ironRes.profile.valencia_score_estimada < 2.8);
});

test("4. Modismos mexicanos/hispanos de sobrecarga", () => {
  const idiomsText = "La lista nunca se achica, traigo la cabeza hecha bolas, hoy me dio el bajón y estoy quemado.";
  const res = ClientEngine.classifyTextDetailed(idiomsText);
  assert.ok(res.syntax_analysis.signals16.sig_idiom_mental_load > 0.5);
  assert.ok(res.syntax_analysis.signals16.sig_idiom_burnout > 0.5);
  assert.ok(res.profile.ejes_tematicos.carga_mental >= 0.8);
  assert.ok(res.profile.senales_alerta.desgaste_sostenido >= 0.75);
});

test("5. Calibración neutra (sin inflación ni ceros planos) y EMA 3d en Pausa Suave", () => {
  const neutral = "Hoy fui al mercado, cociné arroz, leí un rato y salí a caminar.";
  const nRes = ClientEngine.classifyTextDetailed(neutral);
  const probs = nRes.profile.valencia_emocional.probabilities;

  assert.equal(nRes.profile.valencia_emocional.choice, "neutro");
  assert.ok(probs.neutro > 0.4 && probs.neutro < 0.8, `Neutro calibrado esperado 0.4..0.8, got ${probs.neutro}`);
  assert.ok(probs.positivo > 0.05 && probs.negativo > 0.05, "Softmax con temperatura evita probabilidades degeneradas 0.0/1.0");
  assert.ok(nRes.profile.senales_alerta.riesgo_autolesion_purga <= 0.1, "Riesgo en día neutro <= 0.10");

  // Pausa Suave: 0.75 * P_hoy + 0.25 * EMA_3d >= 0.85
  const burnoutText = "Ya no puedo más, estoy completamente fundido y quemado, cada día igual y sin fuerzas.";
  // Caso A: 3 días previos también con desgaste alto -> supera 0.85
  const resSustained = ClientEngine.classifyTextDetailed(burnoutText, {
    priorDesgasteSeries: [0.65, 0.78, 0.85]
  });
  const safSustained = ClientEngine.evaluateSafety(burnoutText, resSustained.profile.senales_alerta);
  assert.equal(safSustained.level, "pause");
  assert.equal(safSustained.helplines.length, 0, "Pausa suave nunca activa líneas de emergencia");
  assert.ok(resSustained.profile.senales_alerta.desgaste_sostenido >= 0.85);

  // Caso B: 3 días previos en calma (0.05) amortiguan un solo día pesado bajo 0.85
  const resSingleSpike = ClientEngine.classifyTextDetailed("Estoy fundido hoy y muy cansado.", {
    priorDesgasteSeries: [0.05, 0.05, 0.05]
  });
  const safSingle = ClientEngine.evaluateSafety("Estoy fundido hoy y muy cansado.", resSingleSpike.profile.senales_alerta);
  assert.equal(safSingle.level, "safe");
  assert.ok(resSingleSpike.profile.senales_alerta.desgaste_sostenido < 0.85);
});

test("6. Alerta Roja doble compuerta OR (regex 1.00 OR semántica >= 0.50) y cero falsas alarmas", () => {
  // Compuerta Regex determinista
  const explicitText = "He estado pensando en quitarme la vida.";
  const expDet = ClientEngine.classifyTextDetailed(explicitText);
  assert.equal(expDet.profile.senales_alerta.riesgo_autolesion_purga, 1.0);
  const expSaf = ClientEngine.evaluateSafety(explicitText, expDet.profile.senales_alerta);
  assert.equal(expSaf.level, "alert");
  assert.equal(expSaf.gate, "regex_determinista");
  assert.ok(expSaf.helplines.length >= 1);

  // Compuerta Semántica calibrada (sin match literal de regex explícita)
  for (const implicitPhrase of [
    "Últimamente quisiera apagarme y desaparecer.",
    "Siento tanta culpa que quiero deshacerme de lo que comí."
  ]) {
    const det = ClientEngine.classifyTextDetailed(implicitPhrase);
    assert.ok(
      det.profile.senales_alerta.riesgo_autolesion_purga >= 0.5,
      `Frase implícita "${implicitPhrase}" debería dar >= 0.50, got ${det.profile.senales_alerta.riesgo_autolesion_purga}`
    );
    const saf = ClientEngine.evaluateSafety(implicitPhrase, det.profile.senales_alerta);
    assert.equal(saf.level, "alert");
    assert.equal(saf.gate, "platt_semantica");
    assert.ok(saf.helplines.length >= 1);
  }

  // Salvaguarda contra falsas alarmas en metáforas y días neutros
  for (const safeMetaphor of [
    "Hoy trabajé bastante y luego salí a cenar tacos.",
    "Me muero de risa con mis amigos y luego me muero de sueño.",
    "Necesito deshacerme de pendientes acumulados y cortarme el pelo mañana."
  ]) {
    const det = ClientEngine.classifyTextDetailed(safeMetaphor);
    assert.ok(
      det.profile.senales_alerta.riesgo_autolesion_purga <= 0.1,
      `Falsa alarma en "${safeMetaphor}": ${det.profile.senales_alerta.riesgo_autolesion_purga}`
    );
    const saf = ClientEngine.evaluateSafety(safeMetaphor, det.profile.senales_alerta);
    assert.notEqual(saf.level, "alert");
  }
});

test("7. Motor Vectorial: Compuerta dura G_i, no repetición MMR+HLR (14d), slot-filling y lenguaje neutro", () => {
  // Verificación exhaustiva de neutralidad y cero lenguaje clínico en TODO el banco
  for (const card of SuggestionEngine.CARD_BANK) {
    for (const field of [card.dailyTitle, card.dailyChronicle, card.dailySuggestion, card.periodText]) {
      if (!field) continue;
      assert.ok(
        SuggestionEngine.isNeutralNonClinical(field),
        `Texto no neutro o clínico en ${card.id}: ${field}`
      );
    }
  }
  for (const pool of Object.values(SuggestionEngine.MICRO_ACTIONS)) {
    for (const act of pool) {
      assert.ok(
        SuggestionEngine.isNeutralNonClinical(act.text),
        `Micro-acción no neutra o clínica en ${act.id}: ${act.text}`
      );
    }
  }

  // Compuerta dura: si durmió >= 7h no puede salir ninguna tarjeta de déficit de sueño
  const heavyLoadText = "Estoy saturado, tengo mil cosas encima y en piloto automático en el trabajo.";
  const heavyProfile = ClientEngine.classifyText(heavyLoadText);
  const goodSleepQ = { sleep_hours: 8.0, workload_rating: 4, valence_rating: 2, self_report_word: "regular" };
  const refl8h = SuggestionEngine.selectDailyReflection({
    date: "2026-11-17",
    layaProfile: heavyProfile,
    questionnaire: goodSleepQ,
    safety: { level: "safe" },
    history: []
  });
  assert.notEqual(refl8h.theme, "sueno_deficit");
  assert.ok(!/\{[a-z0-9_]+\}/i.test(refl8h.chronicle + refl8h.suggestion), "Sin slots sin resolver");
  assert.equal(refl8h.vec10.length, 10);

  // Compuerta dura en Alerta Roja: SOLO permite tarjetas de contención
  const reflCrisis = SuggestionEngine.selectDailyReflection({
    date: "2026-11-17",
    layaProfile: heavyProfile,
    questionnaire: goodSleepQ,
    safety: { level: "alert" },
    history: []
  });
  assert.equal(reflCrisis.theme, "contencion");
  assert.equal(reflCrisis.safety_locked, true);

  // No repetición con MMR + decaimiento HLR (h = 7 días) durante 4 días seguidos idénticos
  let history = [];
  const chosenCardIds = [];
  for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
    const nowIso = new Date(Date.UTC(2026, 10, 14 + dayOffset, 20, 0, 0)).toISOString();
    const r = SuggestionEngine.selectDailyReflection({
      date: `2026-11-${14 + dayOffset}`,
      layaProfile: heavyProfile,
      questionnaire: goodSleepQ,
      safety: { level: "safe" },
      history,
      nowIso
    });
    chosenCardIds.push(r.card_id);
    history = SuggestionEngine.appendHistory(history, r.history_record, nowIso);
  }
  assert.equal(
    new Set(chosenCardIds).size,
    chosenCardIds.length,
    `No debe repetir tarjetas en días consecutivos: ${chosenCardIds.join(", ")}`
  );

  // Rotación en crónicas de periodo también evita repetición
  const periodStats = {
    valencia_media: 2.6,
    sueno_medio: 6.1,
    carga_media: 4.2,
    emocion_dominante: "estres",
    ejes_principales: ["carga_mental", "trabajo_estudio"],
    total_dias: 7,
    racha: 5,
    cruces_objetivos: []
  };
  let pHist = [];
  const periodIds = [];
  for (let i = 0; i < 3; i++) {
    const p = SuggestionEngine.selectPeriodChronicle({ stats: periodStats, entries: [], history: pHist });
    periodIds.push(p.card_id);
    assert.ok(!/\{[a-z0-9_]+\}/i.test(p.summary_text), "Sin placeholders sin resolver en crónica");
    assert.ok(SuggestionEngine.isNeutralNonClinical(p.summary_text));
    pHist = SuggestionEngine.appendHistory(pHist, p.history_record);
  }
  assert.equal(new Set(periodIds).size, periodIds.length, `Crónicas repetidas: ${periodIds.join(", ")}`);
});
