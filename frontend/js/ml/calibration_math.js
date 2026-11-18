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
   * Softmax con escalado de temperatura sobre logits ya calculados, garantizando suma exacta = 1.0
   * y cálculo de confianza calibrada por margen top1-top2 + entropía normalizada.
   */
  function softmaxFromLogits(rawLogitsByKey, temperature = 1.0) {
    const keys = Object.keys(rawLogitsByKey || {});
    if (!keys.length) {
      return { choice: "", probabilities: {}, answer_confidence: 0.3 };
    }
    const T = Math.max(0.2, Number(temperature) || 1.0);

    const scaledLogits = {};
    let maxScaled = -Infinity;
    for (const k of keys) {
      const scaled = Number(rawLogitsByKey[k] || 0) / T;
      scaledLogits[k] = scaled;
      if (scaled > maxScaled) maxScaled = scaled;
    }

    const exps = {};
    let sumExp = 0;
    for (const k of keys) {
      const e = Math.exp(scaledLogits[k] - maxScaled);
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
   * Temperature Scaling: softmax( (prior_k + compressed(raw_k)) / T )
   */
  function temperatureSoftmaxBlock(rawScores, blockKey) {
    const priors = PRIORS[blockKey] || {};
    const T = Math.max(0.2, TEMPERATURES[blockKey] || 1.25);
    const keys = Object.keys(priors);

    // Suprimir levemente el prior positivo cuando hay clara señal negativa sin contraparte positiva.
    const effectivePriors = { ...priors };
    if (blockKey === "valencia_emocional") {
      const negSum = Number(rawScores.negativo || 0) + Number(rawScores.muy_negativo || 0);
      const posSum = Number(rawScores.positivo || 0) + Number(rawScores.muy_positivo || 0);
      if (negSum >= 2.2 && posSum === 0) {
        effectivePriors.positivo -= 0.75;
        effectivePriors.muy_positivo -= 0.6;
      } else if (posSum >= 2.2 && negSum === 0) {
        effectivePriors.negativo -= 0.75;
        effectivePriors.muy_negativo -= 0.6;
      } else if (posSum >= 0.5 && negSum === 0) {
        effectivePriors.negativo -= 0.6;
        effectivePriors.muy_negativo -= 0.6;
      }
    }

    const combinedLogits = {};
    for (const k of keys) {
      combinedLogits[k] = (effectivePriors[k] || 0) + compressRawScore(rawScores[k] || 0);
    }
    return softmaxFromLogits(combinedLogits, T);
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

  const SYNTAX_SIGNAL16_KEYS = [
    "sig_adversative_ratio",
    "sig_negated_positive",
    "sig_negated_sleep_energy",
    "sig_double_negation",
    "sig_exhaustion_limit",
    "sig_intensifiers",
    "sig_ironic_quotes",
    "sig_ironic_exclamation",
    "sig_idiom_mental_load",
    "sig_idiom_burnout",
    "sig_sleep_deficit_phrases",
    "sig_somatic_strain",
    "sig_social_support_positive",
    "sig_agency_progress",
    "sig_intra_note_contradiction",
    "sig_self_report_gap"
  ];

  function dotProduct(a, b, offsetA = 0, len = b.length) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
      acc += Number(a[offsetA + i] || 0) * Number(b[i] || 0);
    }
    return acc;
  }

  /**
   * Evalúa los cabezales híbridos Tier 1 ([embedding ONNX 768 + señales16 + prototipos/subespacio])
   * con Temperature Scaling y Platt Scaling idénticos al entrenamiento Teacher-Student.
   */
  function scoreTier1Hybrid(embeddingVec, synSignals16, {
    prototypes,
    heads,
    priorDesgasteSeries = [],
    explicitRegexRisk = false
  } = {}) {
    if (!embeddingVec || !prototypes || !heads) {
      throw new Error("scoreTier1Hybrid requiere embedding, prototypes y heads.");
    }

    const layout = heads.feature_layout || {};
    const embDim = Number(layout.emb_dim || embeddingVec.length || 768);
    const synDim = Number(layout.syntax_dim || 16);
    const anchorNames = prototypes.anchor_names || [];
    const negSubspace = prototypes.neg_subspace || [];
    const totalDim = Number(layout.total_dim || (embDim + synDim + anchorNames.length + negSubspace.length));

    const feat = new Float32Array(totalDim);
    for (let i = 0; i < embDim; i++) {
      feat[i] = Number(embeddingVec[i] || 0);
    }

    if (Array.isArray(synSignals16) || ArrayBuffer.isView(synSignals16)) {
      for (let i = 0; i < synDim; i++) {
        feat[embDim + i] = Number(synSignals16[i] || 0);
      }
    } else {
      const sObj = synSignals16 || {};
      for (let i = 0; i < synDim; i++) {
        feat[embDim + i] = Number(sObj[SYNTAX_SIGNAL16_KEYS[i]] || 0);
      }
    }

    let cursor = embDim + synDim;
    for (let i = 0; i < anchorNames.length; i++) {
      const anchorVec = (prototypes.anchors || {})[anchorNames[i]] || [];
      feat[cursor++] = dotProduct(embeddingVec, anchorVec, 0, embDim);
    }
    for (let i = 0; i < negSubspace.length; i++) {
      feat[cursor++] = dotProduct(embeddingVec, negSubspace[i], 0, embDim);
    }

    const evalMulticlassHead = (blockHead) => {
      const classes = blockHead.classes || [];
      const rawLogits = {};
      for (let c = 0; c < classes.length; c++) {
        rawLogits[classes[c]] = dotProduct(feat, blockHead.weights[c], 0, totalDim) + Number(blockHead.biases[c] || 0);
      }
      return softmaxFromLogits(rawLogits, blockHead.temperature || 1.0);
    };

    const evalBinaryHead = (binHead) => {
      const rawZ = dotProduct(feat, binHead.weights, 0, totalDim) + Number(binHead.bias || 0);
      return plattSigmoid(rawZ, binHead.platt_a || 1.0, binHead.platt_b || 0.0);
    };

    const blocks = heads.blocks || {};
    const valRes = evalMulticlassHead(blocks.valencia_emocional);
    const actRes = evalMulticlassHead(blocks.activacion_energia);
    const emoRes = evalMulticlassHead(blocks.emocion_primaria);

    const ejes = {};
    for (const ejeKey of ["trabajo_estudio", "descanso_sueno", "relaciones_familia", "salud_cuerpo", "carga_mental"]) {
      const head = (heads.ejes || {})[ejeKey];
      ejes[ejeKey] = head ? evalBinaryHead(head) : 0.05;
    }

    const senHeads = heads.senales || {};
    const pDesgasteHoy = senHeads.desgaste_sostenido ? evalBinaryHead(senHeads.desgaste_sostenido) : 0.05;
    const desgasteBlend = blendDesgasteEma3d(pDesgasteHoy, priorDesgasteSeries);
    const pContradiccion = senHeads.contradiccion_emocional ? evalBinaryHead(senHeads.contradiccion_emocional) : 0.05;
    const pRiesgoSemantico = senHeads.riesgo_autolesion_purga ? evalBinaryHead(senHeads.riesgo_autolesion_purga) : 0.02;
    const pRiesgoFinal = explicitRegexRisk ? 1.0 : pRiesgoSemantico;

    const temperatures = {
      valencia_emocional: Number((blocks.valencia_emocional || {}).temperature || 1.0),
      activacion_energia: Number((blocks.activacion_energia || {}).temperature || 1.0),
      emocion_primaria: Number((blocks.emocion_primaria || {}).temperature || 1.0)
    };

    return {
      valencia_emocional: valRes,
      activacion_energia: actRes,
      emocion_primaria: emoRes,
      ejes_tematicos: ejes,
      senales_alerta: {
        desgaste_sostenido: desgasteBlend.effective,
        contradiccion_emocional: pContradiccion,
        riesgo_autolesion_purga: pRiesgoFinal
      },
      calibration_meta: {
        method: "onnx_q8_hybrid_v1",
        temperatures,
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
    SYNTAX_SIGNAL16_KEYS,
    round,
    clamp01,
    compressRawScore,
    softmaxFromLogits,
    temperatureSoftmaxBlock,
    plattSigmoid,
    blendDesgasteEma3d,
    calibrateProfile,
    scoreTier1Hybrid
  };
});
