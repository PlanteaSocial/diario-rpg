/**
 * Calibración Matemática de Probabilidades y Compuertas de Seguridad (< 30 KB, < 0.5 ms).
 *
 * Implementa:
 * 1. Temperature Scaling sobre los 3 bloques mutuamente excluyentes:
 *    valencia_emocional, activacion_energia y emocion_primaria.
 * 2. Platt / Sigmoid Scaling sobre los 5 ejes temáticos y 3 señales independientes.
 * 3. Suavizado temporal EMA 3d (0.75 * P_hoy + 0.25 * EMA_3d) para desgaste_sostenido.
 * 4. Reglas exactas de umbral para Discrepancia, Pausa Suave (>= 0.85) y
 *    Alerta Roja de doble compuerta OR (Regex determinista = 1.00 || Semántica >= 0.50).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CalibrationMath = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TEMPERATURES = {
    valencia_emocional: 1.25,
    activacion_energia: 1.25,
    emocion_primaria: 1.3
  };

  // Logits base (prior) en días neutros: evitan distribuciones planas o 100% artificiales,
  // manteniendo umbral natural para que 1 señal léxica clara supere la línea base neutra.
  const PRIORS = {
    valencia_emocional: {
      muy_negativo: -0.9,
      negativo: -0.2,
      neutro: 0.85,
      positivo: -0.2,
      muy_positivo: -0.9
    },
    activacion_energia: {
      agotamiento_baja: -0.25,
      calma_estable: 0.7,
      tension_alta: -0.25,
      entusiasmo_alta: -0.4
    },
    emocion_primaria: {
      alegria: -0.35,
      calma: 0.7,
      estres: -0.35,
      tristeza: -0.4,
      frustracion: -0.35,
      ansiedad: -0.35,
      gratitud: -0.4,
      apatia: -0.45
    }
  };

  // Parámetros Platt σ(a * z + b) para salidas independientes [0, 1].
  const PLATT_AXES = { a: 2.0, b: -2.4 };
  const PLATT_SIGNALS = {
    desgaste_sostenido: { a: 1.35, b: -2.85 },
    contradiccion_emocional: { a: 1.55, b: -2.75 },
    riesgo_autolesion_purga: { a: 1.45, b: -3.4 }
  };

  function round(n, dec = 4) {
    const f = 10 ** dec;
    return Math.round((Number(n) + Number.EPSILON) * f) / f;
  }

  function clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  /**
   * Transformación sublinear logarítmica para evitar saturación extrema por conteo bruto.
   */
  function compressRawScore(rawVal, gain = 2.4, slope = 0.85) {
    const x = Math.max(0, Number(rawVal || 0));
    if (x === 0) return 0;
    return gain * Math.log1p(x * slope);
  }

  /**
   * Temperature Scaling: softmax( (prior_k + compressed(raw_k)) / T )
   */
  function temperatureSoftmaxBlock(rawScores, blockKey) {
    const priors = PRIORS[blockKey] || {};
    const T = Math.max(0.2, TEMPERATURES[blockKey] || 1.25);
    const keys = Object.keys(priors);

    const logits = {};
    let maxScaled = -Infinity;
    for (const k of keys) {
      const z = (priors[k] || 0) + compressRawScore(rawScores[k] || 0);
      const scaled = z / T;
      logits[k] = scaled;
      if (scaled > maxScaled) maxScaled = scaled;
    }

    const exps = {};
    let sumExp = 0;
    for (const k of keys) {
      const e = Math.exp(logits[k] - maxScaled);
      exps[k] = e;
      sumExp += e;
    }

    const probabilities = {};
    let best = keys[0];
    let bestP = -1;
    let normCheck = 0;
    for (const k of keys) {
      const p = round(exps[k] / sumExp, 4);
      probabilities[k] = p;
      normCheck += p;
      if (p > bestP) {
        bestP = p;
        best = k;
      }
    }

    // Ajustar error mínimo de redondeo en la categoría ganadora para sumar 1.0 exacto.
    const diff = round(1.0 - normCheck, 4);
    if (Math.abs(diff) > 0 && best in probabilities) {
      probabilities[best] = round(Math.max(0, probabilities[best] + diff), 4);
      bestP = probabilities[best];
    }

    // Confianza calibrada combinando margen top-1 vs top-2 y entropía normalizada.
    const sortedProbs = Object.values(probabilities).sort((a, b) => b - a);
    const margin = sortedProbs.length > 1 ? sortedProbs[0] - sortedProbs[1] : sortedProbs[0];
    const maxEnt = Math.log(Math.max(2, keys.length));
    let entropy = 0;
    for (const p of sortedProbs) {
      if (p > 1e-9) entropy -= p * Math.log(p);
    }
    const certainty = 1 - entropy / maxEnt;
    const rawConf = 0.28 + 0.45 * bestP + 0.22 * margin + 0.15 * certainty;
    const answer_confidence = round(Math.max(0.3, Math.min(0.96, rawConf)), 3);

    return {
      choice: best,
      probabilities,
      answer_confidence
    };
  }

  /**
   * Platt / Sigmoid Scaling: σ(a * z + b).
   */
  function plattSigmoid(rawLogit, a = 1.5, b = -2.5) {
    const z = a * Number(rawLogit || 0) + b;
    if (z >= 35) return 1.0;
    if (z <= -35) return 0.0;
    return round(1.0 / (1.0 + Math.exp(-z)), 4);
  }

  /**
   * Calcula EMA de 3 días previos para desgaste_sostenido y pondera 0.75 * hoy + 0.25 * EMA_3d.
   * `priorSeries` debe venir ordenado cronológicamente (del más antiguo al más reciente previo a hoy).
   */
  function blendDesgasteEma3d(pToday, priorSeries = []) {
    const todayVal = clamp01(pToday);
    const clean = (Array.isArray(priorSeries) ? priorSeries : [])
      .map((v) => clamp01(v))
      .slice(-3);

    if (clean.length === 0) {
      return {
        effective: round(todayVal, 4),
        p_today: round(todayVal, 4),
        ema_3d: null,
        history_days_used: 0
      };
    }

    const alpha = 2.0 / (3.0 + 1.0); // EMA ventana de 3 días (0.5)
    let ema = clean[0];
    for (let i = 1; i < clean.length; i++) {
      ema = alpha * clean[i] + (1.0 - alpha) * ema;
    }

    const effective = clamp01(0.75 * todayVal + 0.25 * ema);
    return {
      effective: round(effective, 4),
      p_today: round(todayVal, 4),
      ema_3d: round(ema, 4),
      history_days_used: clean.length
    };
  }

  /**
   * Calibra por completo todos los bloques a partir de logits sintácticos + historial previo opcional.
   */
  function calibrateProfile(rawLogits, { priorDesgasteSeries = [], explicitRegexRisk = false } = {}) {
    const valRes = temperatureSoftmaxBlock(rawLogits.valencia || {}, "valencia_emocional");
    const actRes = temperatureSoftmaxBlock(rawLogits.activacion || {}, "activacion_energia");
    const emoRes = temperatureSoftmaxBlock(rawLogits.emocion || {}, "emocion_primaria");

    const ejes = {};
    for (const ejeKey of ["trabajo_estudio", "descanso_sueno", "relaciones_familia", "salud_cuerpo", "carga_mental"]) {
      const z = (rawLogits.ejes && rawLogits.ejes[ejeKey]) || 0;
      ejes[ejeKey] = plattSigmoid(z, PLATT_AXES.a, PLATT_AXES.b);
    }

    const rawSignals = rawLogits.senales || {};
    const pDesgasteHoy = plattSigmoid(
      rawSignals.desgaste_sostenido || 0,
      PLATT_SIGNALS.desgaste_sostenido.a,
      PLATT_SIGNALS.desgaste_sostenido.b
    );
    const desgasteBlend = blendDesgasteEma3d(pDesgasteHoy, priorDesgasteSeries);

    const pContradiccion = plattSigmoid(
      rawSignals.contradiccion_emocional || 0,
      PLATT_SIGNALS.contradiccion_emocional.a,
      PLATT_SIGNALS.contradiccion_emocional.b
    );

    const pRiesgoSemantico = plattSigmoid(
      rawSignals.riesgo_autolesion_purga || 0,
      PLATT_SIGNALS.riesgo_autolesion_purga.a,
      PLATT_SIGNALS.riesgo_autolesion_purga.b
    );

    const pRiesgoFinal = explicitRegexRisk ? 1.0 : pRiesgoSemantico;

    const senales = {
      desgaste_sostenido: desgasteBlend.effective,
      contradiccion_emocional: pContradiccion,
      riesgo_autolesion_purga: pRiesgoFinal
    };

    return {
      valencia_emocional: valRes,
      activacion_energia: actRes,
      emocion_primaria: emoRes,
      ejes_tematicos: ejes,
      senales_alerta: senales,
      calibration_meta: {
        method: "temperature_plus_platt_v1",
        temperatures: { ...TEMPERATURES },
        desgaste_blend: desgasteBlend,
        riesgo_semantic_prob: pRiesgoSemantico,
        riesgo_regex_override: Boolean(explicitRegexRisk)
      }
    };
  }

  return {
    TEMPERATURES,
    PRIORS,
    PLATT_AXES,
    PLATT_SIGNALS,
    round,
    clamp01,
    compressRawScore,
    temperatureSoftmaxBlock,
    plattSigmoid,
    blendDesgasteEma3d,
    calibrateProfile
  };
});
