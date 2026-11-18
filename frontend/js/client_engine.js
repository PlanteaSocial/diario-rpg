/**
 * Motor determinista 100% local en el navegador para Diario RPG (Modo Nube Spark).
 * Porta con fidelidad los servicios Python de clasificación heurística, seguridad,
 * analíticas, compañero RPG, resumen determinista y módulo Aprender (HLR).
 *
 * Nada del texto del diario sale del navegador hacia servidores de IA.
 */

const ClientEngine = {
  VALENCE_WEIGHTS: {
    muy_negativo: 1.0,
    negativo: 2.0,
    neutro: 3.0,
    positivo: 4.0,
    muy_positivo: 5.0
  },

  ENERGY_SCORE_MAP: {
    agotamiento_baja: 1.5,
    calma_estable: 3.0,
    tension_alta: 4.0,
    entusiasmo_alta: 5.0
  },

  DAILY_GOAL_MINUTES_MAP: {
    facil: 5,
    normal: 10,
    serio: 15,
    intensivo: 20
  },

  DEFAULT_HALF_LIFE_DAYS: 4.0,
  MAX_HALF_LIFE_DAYS: 30.0,
  REVIEW_THRESHOLD: 0.75,

  LAYA_QUESTIONS: {
    valencia_emocional: {
      type: "choice",
      instructions: "¿Qué tono o valencia emocional predomina en el escrito?",
      criteria: {
        muy_negativo: "Profunda tristeza, dolor, desesperanza, llanto o gran angustia",
        negativo: "Preocupación, frustración, enojo, malestar, cansancio molesto o quejas",
        neutro: "Día ordinario, rutinario, tareas cotidianas sin emociones intensas",
        positivo: "Alegría, tranquilidad, satisfacción, buen ánimo, alivio o motivación",
        muy_positivo: "Gran entusiasmo, euforia, profunda gratitud o inmensa felicidad"
      }
    },
    activacion_energia: {
      type: "choice",
      instructions: "¿Qué nivel de energía o activación psicofisiológica refleja el texto?",
      criteria: {
        agotamiento_baja: "Cansancio extremo, falta de energía, fatiga, desánimo o lentitud",
        calma_estable: "Serenidad, relajación, equilibrio emocional, paz o sosiego",
        tension_alta: "Estrés, ansiedad, nerviosismo, agitación, prisa o sobrecarga",
        entusiasmo_alta: "Dinamismo alto positivo, ímpetu, emoción, vitalidad y motivación"
      }
    },
    emocion_primaria: {
      type: "choice",
      instructions: "¿Cuál es la emoción o afecto dominante en el texto?",
      criteria: {
        alegria: "Felicidad, risas, contento, regocijo o satisfacción",
        calma: "Paz interior, tranquilidad, descanso o serenidad",
        estres: "Presión por tiempo, pendientes acumulados, exceso de trabajo o agobio",
        tristeza: "Pena, desánimo, soledad, melancolía o pérdida",
        frustracion: "Impotencia ante obstáculos, enojo por cosas que salieron mal",
        ansiedad: "Inquietud por el futuro, miedo, zozobra o incertidumbre",
        gratitud: "Agradecimiento sincero, valorar a personas o circunstancias",
        apatia: "Desinterés, desgano, monotonía, sensación de vacío o indiferencia"
      }
    },
    eje_trabajo_estudio: { type: "noul", instructions: "¿El texto habla sobre pendientes, tareas, entregas, trabajo o estudio?" },
    eje_descanso_sueno: { type: "noul", instructions: "¿El texto habla de dormir, desvelo, siestas, calidad de sueño o descanso físico?" },
    eje_relaciones_familia: { type: "noul", instructions: "¿El texto involucra a la pareja, amigos, familia, vida social o convivencia?" },
    eje_salud_cuerpo: { type: "noul", instructions: "¿El texto menciona síntomas físicos, dolores, alimentación, ejercicio o bienestar corporal?" },
    eje_carga_mental: { type: "noul", instructions: "¿El texto refleja saturación mental, piloto automático, lista interminable de pendientes o bloqueo?" },
    sen_desgaste_sostenido: { type: "noul", instructions: "¿Hay indicios de agotamiento crónico, desesperanza continua o sensación de no poder más?" },
    sen_contradiccion_emocional: { type: "noul", instructions: "¿El texto muestra contradicción emocional, como decir que todo está bien mientras expresa malestar?" },
    sen_riesgo_autolesion_purga: { type: "noul", instructions: "¿El texto expresa intención, pensamientos o actos de autolesión, daño físico, purga o restricción alimentaria?" }
  },

  VALENCE_LEXICON: {
    muy_negativo: ["no puedo mas", "sin salida", "desesperanza", "insoportable", "horrible", "vacio", "llorar", "lloro", "colapso", "hundido", "no aguanto", "todo mal"],
    negativo: ["cansado", "cansancio", "estres", "estresado", "preocupado", "enojo", "enojado", "frustrado", "triste", "ansiedad", "ansioso", "agotado", "mal dia", "fastidio", "harto", "pesado", "dificil", "molesto", "nervios", "dolor", "presion", "dormi mal", "desperte", "extrano", "preocupacion"],
    positivo: ["bien", "contento", "tranquilo", "logre", "bueno", "alegria", "gusto", "mejor", "descanso", "agradable", "bonito", "avance", "calma"],
    muy_positivo: ["increible", "feliz", "agradecido", "gratitud", "emocionado", "euforia", "maravilloso", "excelente", "gran dia", "felicidad", "orgulloso"]
  },

  ACTIVATION_LEXICON: {
    agotamiento_baja: ["cansado", "cansancio", "agotado", "sin energia", "dormir", "siesta", "desvelo", "pesado", "lento", "apagado", "sin fuerzas", "sueno"],
    calma_estable: ["tranquilo", "calma", "relajado", "descanso", "sereno", "paz", "tranquilidad"],
    tension_alta: ["estres", "ansiedad", "ansioso", "prisa", "presion", "pendientes", "nervios", "agobio", "saturado", "deadline", "entregas", "corriendo"],
    entusiasmo_alta: ["emocionado", "motivado", "energia", "entusiasmo", "animo", "vitalidad", "con ganas", "inspirado"]
  },

  EMOTION_LEXICON: {
    alegria: ["feliz", "contento", "alegria", "risas", "gusto", "disfrute", "sonrisa"],
    calma: ["tranquilo", "calma", "relajado", "paz", "descanso", "sereno"],
    estres: ["estres", "presion", "pendientes", "agobio", "saturado", "entregas", "deadline", "trabajo"],
    tristeza: ["triste", "pena", "solo", "soledad", "melancolia", "llorar", "vacio"],
    frustracion: ["frustrado", "enojo", "enojado", "impotencia", "injusto", "harto", "molesto"],
    ansiedad: ["ansiedad", "ansioso", "nervios", "miedo", "preocupado", "incertidumbre"],
    gratitud: ["agradecido", "gracias", "gratitud", "bendecido", "afortunado"],
    apatia: ["apatia", "desgano", "desinteres", "monotonia", "indiferencia", "sin ganas", "nada me importa"]
  },

  AXIS_LEXICON: {
    eje_trabajo_estudio: ["trabajo", "tarea", "tareas", "pendientes", "entrega", "entregas", "jefe", "oficina", "universidad", "escuela", "estudio", "estudiar", "examen", "clase", "proyecto", "reunion", "equipo"],
    eje_descanso_sueno: ["dormir", "sueno", "desvelo", "siesta", "descanso", "cama", "insomnio", "dormi", "dormir mal", "despertar", "desperte", "alarma", "descansar"],
    eje_relaciones_familia: ["pareja", "novia", "novio", "amigos", "amiga", "amigo", "familia", "mama", "papa", "hermano", "hermana", "hijos", "convivencia", "social", "cita", "reunion familiar"],
    eje_salud_cuerpo: ["dolor", "cabeza", "estomago", "cuerpo", "ejercicio", "gym", "correr", "comer", "alimentacion", "enfermo", "gripe", "cansancio fisico", "espalda"],
    eje_carga_mental: ["saturado", "saturacion", "piloto automatico", "lista", "pendientes", "bloqueo", "no doy", "encima", "carga", "agobio", "demasiadas cosas", "sin cabeza", "colapsado"]
  },

  SIGNAL_LEXICON: {
    sen_desgaste_sostenido: ["agotado", "desgaste", "sin fuerzas", "no puedo mas", "desesperanza", "harto", "quemado", "cada dia igual", "arrastrando"],
    sen_riesgo_autolesion_purga: ["autolesion", "hacerme dano", "cortarme", "lastimarme", "purga", "vomitar", "dejar de comer", "no comer", "restringir comida"]
  },

  CONTRADICTION_POSITIVE: ["todo esta bien", "todo bien", "no pasa nada", "estoy bien", "aqui todo bien"],
  CONTRADICTION_NEGATIVE: ["pero", "aunque", "cansado", "cansancio", "estres", "triste", "fastidio", "molesto", "harto", "agotado", "preocupado"],

  RISK_PATTERNS: [
    /\b(suicid|matarm[ea]|quitarme la vida|acabar con todo|no quiero vivir|desaparecer de este mundo|hacerme da[ñn]o|cortarm[ea]|autolesi[oó]n)\w*/i,
    /\b(purgarm[ea]|vomitar la comida|v[oó]mito inducido|no merezco comer|dejar de comer por completo|laxantes para no engordar)\w*/i
  ],

  RESOURCES_HELPLINES: [
    { name: "Línea de la Vida (México)", contact: "800 911 2000", description: "Atención personalizada 24/7, gratuita y confidencial." },
    { name: "Teléfono de la Esperanza (Internacional / España)", contact: "717 003 717 / 914 590 055", description: "Apoyo emocional y escucha activa en crisis." },
    { name: "Emergencias generales", contact: "911", description: "En caso de peligro inmediato." }
  ],

  SAFE_SUPPORT_MESSAGE:
    "Hemos notado en tu escrito palabras o señales que reflejan un momento de sobrecarga o dolor profundo. " +
    "Tu bienestar y tu vida son lo más valioso. No tienes que atravesar esto en soledad: " +
    "existen personas capacitadas dispuestas a escucharte con calidez, respeto y total confidencialidad.",

  SOFT_PAUSE_MESSAGE:
    "Tu escrito refleja señales de un desgaste o agotamiento muy profundo. " +
    "Recuerda que no todo tiene que resolverse hoy; date permiso para hacer una pausa, " +
    "bajar el ritmo y recargar energías con calma.",

  SELF_ASSESSMENT_QUIZZES: {
    procrastinacion: {
      id: "procrastinacion",
      title: "Estilo ante la Procrastinación",
      icon: "⏳",
      subtitle: "Explora qué detona postergar tareas y cómo suavizar el arranque.",
      duration: "1 min · 4 preguntas",
      axes: ["Carga mental", "Constancia"],
      questions: [
        { id: "q1", text: "Cuando una tarea parece grande, ¿sueles aplazarla buscando primero el momento ideal?" },
        { id: "q2", text: "¿Cambias rápidamente hacia el celular o tareas pequeñas para evitar iniciar lo importante?" },
        { id: "q3", text: "¿Sientes que la exigencia de hacerlo perfecto termina frenando tu primer paso?" },
        { id: "q4", text: "¿Terminas el día con cansancio mental por pensar en pendientes que dejaste en pausa?" }
      ]
    },
    limites_descanso: {
      id: "limites_descanso",
      title: "Límites y Descanso Digital",
      icon: "🛡️",
      subtitle: "Observa qué tan protegidos están tus horarios de cierre y tu desconexión nocturna.",
      duration: "1 min · 4 preguntas",
      axes: ["Límites", "Descanso"],
      questions: [
        { id: "q1", text: "¿Revisas mensajes laborales o pendientes cuando ya habías decidido descansar?" },
        { id: "q2", text: "¿Las pantallas nocturnas terminan recorriendo tu hora habitual de dormir?" },
        { id: "q3", text: "¿Te cuesta decir 'no' o posponer un favor aunque ya sientas la agenda llena?" },
        { id: "q4", text: "¿Sientes que tus jornadas se mezclan sin un momento claro de cierre?" }
      ]
    },
    carga_mental: {
      id: "carga_mental",
      title: "Balance de Carga Mental",
      icon: "🧠",
      subtitle: "Mide cuántas 'pestañas abiertas' llevas contigo vs espacios de pausa.",
      duration: "1 min · 4 preguntas",
      axes: ["Carga mental", "Manejo del estrés"],
      questions: [
        { id: "q1", text: "¿Sientes que cargas demasiados recordatorios y pendientes dando vueltas en tu cabeza?" },
        { id: "q2", text: "¿Avanzas en tu rutina en piloto automático sin notar cómo respira o se siente tu cuerpo?" },
        { id: "q3", text: "¿Repasas tareas del día siguiente justo cuando intentas relajarte por la noche?" },
        { id: "q4", text: "¿Sientes que te faltan pausas breves de cinco minutos sin estímulos durante el día?" }
      ]
    }
  },

  COMPANION_SHOP_ITEMS: {
    te_tibio: { id: "te_tibio", name: "Té de Manzanilla", icon: "🍵", type: "snack", price: 12, desc: "+18 Saciedad, +15 Energía serena", satiety: 18, energy: 15, mood: 8, bond: 5 },
    galleta_miel: { id: "galleta_miel", name: "Galleta de Miel", icon: "🍪", type: "snack", price: 10, desc: "+20 Saciedad, +12 Ánimo", satiety: 20, energy: 5, mood: 12, bond: 5 },
    pan_tibio: { id: "pan_tibio", name: "Panecito Recién Horneado", icon: "🥐", type: "snack", price: 18, desc: "+30 Saciedad, +15 Ánimo, +8 Vínculo", satiety: 30, energy: 10, mood: 15, bond: 8 },
    slime_menta: { id: "slime_menta", name: "Esencia Slime Menta", icon: "🌿", type: "variant", price: 45, desc: "Color verde menta relajante para tu compañero" },
    slime_lavanda: { id: "slime_lavanda", name: "Esencia Slime Lavanda", icon: "🔮", type: "variant", price: 60, desc: "Tono lavanda nocturno místico para tu compañero" }
  },

  ADVENTURER_TITLES: [
    "Aprendiz Sereno",
    "Explorador Consciente",
    "Cronista de Calma",
    "Guardián del Ritmo",
    "Sabio del Equilibrio"
  ],

  _round(n, dec = 2) {
    const f = 10 ** dec;
    return Math.round((Number(n) + Number.EPSILON) * f) / f;
  },

  _fold(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  },

  _escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  _countHits(foldedText, words) {
    let hits = 0;
    for (const word of words) {
      const needle = this._fold(word);
      if (!needle) continue;
      if (needle.includes(" ")) {
        let idx = 0;
        while ((idx = foldedText.indexOf(needle, idx)) !== -1) {
          hits += 1;
          idx += needle.length;
        }
      } else {
        const re = new RegExp(`\\b${this._escapeRe(needle)}\\b`, "g");
        const m = foldedText.match(re);
        if (m) hits += m.length;
      }
    }
    return hits;
  },

  _distribution(foldedText, lexicon, defaultKey) {
    const raw = {};
    let total = 0;
    for (const [cat, words] of Object.entries(lexicon)) {
      const c = this._countHits(foldedText, words);
      raw[cat] = c;
      total += c;
    }
    if (total === 0) {
      const probs = {};
      for (const cat of Object.keys(lexicon)) probs[cat] = cat === defaultKey ? 1.0 : 0.0;
      return { probs, best: defaultKey, confidence: 0.3 };
    }
    const eps = 0.02;
    const smoothed = {};
    let norm = 0;
    for (const [cat, c] of Object.entries(raw)) {
      smoothed[cat] = c + eps;
      norm += smoothed[cat];
    }
    const probs = {};
    let best = defaultKey;
    let bestVal = -1;
    for (const [cat, v] of Object.entries(smoothed)) {
      probs[cat] = this._round(v / norm, 4);
      if (raw[cat] > bestVal) {
        bestVal = raw[cat];
        best = cat;
      }
    }
    const confidence = this._round(Math.min(0.92, 0.45 + 0.08 * total), 3);
    return { probs, best, confidence };
  },

  _noulProb(foldedText, words) {
    const hits = this._countHits(foldedText, words);
    if (hits === 0) return 0.05;
    return this._round(Math.min(0.96, 0.28 + 0.22 * hits), 4);
  },

  /**
   * Evalúa si un texto coincide con la compuerta determinista de riesgo explícito.
   */
  matchesExplicitRiskRegex(text) {
    if (!text) return false;
    const syntaxMod = this._resolveSyntaxModule();
    const sanitized = syntaxMod && syntaxMod.stripSafeMetaphors
      ? syntaxMod.stripSafeMetaphors(text)
      : String(text);
    const rawLower = sanitized.toLowerCase();
    const foldedLower = this._fold(sanitized);
    for (const pat of this.RISK_PATTERNS) {
      if (pat.test(rawLower) || pat.test(foldedLower)) {
        return true;
      }
    }
    return false;
  },

  _resolveSyntaxModule() {
    if (typeof SyntaxFeatures !== "undefined") return SyntaxFeatures;
    if (typeof require === "function") {
      try {
        return require("./ml/syntax_features.js");
      } catch {
        return null;
      }
    }
    return null;
  },

  _resolveCalibrationModule() {
    if (typeof CalibrationMath !== "undefined") return CalibrationMath;
    if (typeof require === "function") {
      try {
        return require("./ml/calibration_math.js");
      } catch {
        return null;
      }
    }
    return null;
  },

  _resolveSuggestionModule() {
    if (typeof SuggestionEngine !== "undefined") return SuggestionEngine;
    if (typeof require === "function") {
      try {
        return require("./ml/suggestion_engine.js");
      } catch {
        return null;
      }
    }
    return null;
  },

  classifyTextDetailed(text, options = {}) {
    if (!text || !text.trim()) {
      return {
        error: "Texto vacío",
        latency_ms: 0.0,
        input_tokens: 0,
        profile: null,
        raw_answers: {},
        raw_usage: {},
        valence_calculation: {},
        questions_schema: this.LAYA_QUESTIONS
      };
    }

    const t0 = performance.now();
    const syntaxMod = this._resolveSyntaxModule();
    const calibMod = this._resolveCalibrationModule();

    let valRes;
    let actRes;
    let emoRes;
    let ejesOut;
    let senalesOut;
    let syntaxAnalysis = null;
    let calibrationMeta = null;
    let tokens = 0;
    let backendName = "heuristica-local-js";

    const explicitRegexRisk = this.matchesExplicitRiskRegex(text);

    if (syntaxMod && calibMod) {
      const syn = syntaxMod.extract(text, options.questionnaire || null);
      const cal = calibMod.calibrateProfile(syn.rawLogits, {
        priorDesgasteSeries: options.priorDesgasteSeries || [],
        explicitRegexRisk
      });
      valRes = cal.valencia_emocional;
      actRes = cal.activacion_energia;
      emoRes = cal.emocion_primaria;
      ejesOut = cal.ejes_tematicos;
      senalesOut = cal.senales_alerta;
      calibrationMeta = cal.calibration_meta;
      tokens = syn.tokenCount;
      syntaxAnalysis = {
        clauses: syn.clauses,
        signals16: syn.signals16,
        hasAdversativeShift: syn.hasAdversativeShift,
        intraNoteContradiction: syn.intraNoteContradiction,
        postAdversativeClauses: syn.postAdversativeClauses,
        ordinaryClauses: syn.ordinaryClauses,
        implicitRiskHits: syn.implicitRiskHits
      };
      backendName = "laya-syntax-calibrada-js";
    } else {
      // Respaldo legacy si no se cargaron los submódulos ml/*.js
      const folded = this._fold(text.trim());
      valRes = this._distribution(folded, this.VALENCE_LEXICON, "neutro");
      actRes = this._distribution(folded, this.ACTIVATION_LEXICON, "calma_estable");
      emoRes = this._distribution(folded, this.EMOTION_LEXICON, "calma");
      ejesOut = {
        trabajo_estudio: this._noulProb(folded, this.AXIS_LEXICON.eje_trabajo_estudio),
        descanso_sueno: this._noulProb(folded, this.AXIS_LEXICON.eje_descanso_sueno),
        relaciones_familia: this._noulProb(folded, this.AXIS_LEXICON.eje_relaciones_familia),
        salud_cuerpo: this._noulProb(folded, this.AXIS_LEXICON.eje_salud_cuerpo),
        carga_mental: this._noulProb(folded, this.AXIS_LEXICON.eje_carga_mental)
      };
      const saysOk = this.CONTRADICTION_POSITIVE.some((p) => folded.includes(this._fold(p)));
      const saysBad = this._countHits(folded, this.CONTRADICTION_NEGATIVE) > 0;
      senalesOut = {
        desgaste_sostenido: this._noulProb(folded, this.SIGNAL_LEXICON.sen_desgaste_sostenido),
        contradiccion_emocional: saysOk && saysBad ? 0.62 : (saysOk ? 0.18 : 0.05),
        riesgo_autolesion_purga: explicitRegexRisk ? 1.0 : this._noulProb(folded, this.SIGNAL_LEXICON.sen_riesgo_autolesion_purga)
      };
      tokens = folded.split(/\s+/).filter(Boolean).length;
    }

    const answers = {
      valencia_emocional: { type: "choice", choice: valRes.choice, probabilities: valRes.probs || valRes.probabilities, answer_confidence: valRes.answer_confidence },
      activacion_energia: { type: "choice", choice: actRes.choice, probabilities: actRes.probs || actRes.probabilities, answer_confidence: actRes.answer_confidence },
      emocion_primaria: { type: "choice", choice: emoRes.choice, probabilities: emoRes.probs || emoRes.probabilities, answer_confidence: emoRes.answer_confidence },
      eje_trabajo_estudio: { type: "noul", noul: ejesOut.trabajo_estudio },
      eje_descanso_sueno: { type: "noul", noul: ejesOut.descanso_sueno },
      eje_relaciones_familia: { type: "noul", noul: ejesOut.relaciones_familia },
      eje_salud_cuerpo: { type: "noul", noul: ejesOut.salud_cuerpo },
      eje_carga_mental: { type: "noul", noul: ejesOut.carga_mental },
      sen_desgaste_sostenido: { type: "noul", noul: senalesOut.desgaste_sostenido },
      sen_contradiccion_emocional: { type: "noul", noul: senalesOut.contradiccion_emocional },
      sen_riesgo_autolesion_purga: { type: "noul", noul: senalesOut.riesgo_autolesion_purga }
    };

    const valProbs = valRes.probs || valRes.probabilities || {};
    const calcSteps = [];
    let scoreEstimado = 0.0;
    for (const [cat, weight] of Object.entries(this.VALENCE_WEIGHTS)) {
      const p = valProbs[cat] || 0.0;
      const contrib = p * weight;
      scoreEstimado += contrib;
      calcSteps.push({
        category: cat,
        probability: this._round(p, 4),
        percentage: `${(p * 100).toFixed(2)}%`,
        weight,
        contribution: this._round(contrib, 4)
      });
    }

    const latencyMs = this._round(performance.now() - t0, 2);
    const usage = { input_tokens: tokens, latency_ms: latencyMs, backend: backendName };

    const profile = {
      valencia_emocional: { choice: valRes.choice, probabilities: valProbs, answer_confidence: valRes.answer_confidence },
      activacion_energia: { choice: actRes.choice, probabilities: actRes.probs || actRes.probabilities, answer_confidence: actRes.answer_confidence },
      emocion_primaria: { choice: emoRes.choice, probabilities: emoRes.probs || emoRes.probabilities, answer_confidence: emoRes.answer_confidence },
      ejes_tematicos: ejesOut,
      senales_alerta: senalesOut,
      valencia_score_estimada: this._round(scoreEstimado, 2),
      raw_usage: usage
    };

    return {
      text,
      latency_ms: latencyMs,
      input_tokens: tokens,
      profile,
      raw_answers: answers,
      raw_usage: usage,
      valence_calculation: {
        formula: "Score = Σ ( P(categoría_i) × Peso_i )",
        weights: this.VALENCE_WEIGHTS,
        steps: calcSteps,
        final_score: this._round(scoreEstimado, 2)
      },
      syntax_analysis: syntaxAnalysis,
      calibration_meta: calibrationMeta,
      questions_schema: this.LAYA_QUESTIONS
    };
  },

  classifyText(text, options = {}) {
    const detailed = this.classifyTextDetailed(text, options);
    return detailed.profile;
  },

  evaluateSafety(text, layaSenales = null, options = {}) {
    if (!text) return { is_triggered: false, level: "safe", message: null, helplines: [], gate: "none" };

    // Compuerta 1 (OR): Regex determinista explícita -> riesgo = 1.00
    if (this.matchesExplicitRiskRegex(text)) {
      return {
        is_triggered: true,
        level: "alert",
        gate: "regex_determinista",
        message: this.SAFE_SUPPORT_MESSAGE,
        helplines: this.RESOURCES_HELPLINES
      };
    }

    let senales = layaSenales;
    if (!senales) {
      const prof = this.classifyText(text, options);
      senales = prof ? prof.senales_alerta : null;
    }

    if (senales) {
      // Compuerta 2 (OR): Compuerta semántica calibrada (riesgo_autolesion_purga >= 0.50)
      const riesgo = senales.riesgo_autolesion_purga ?? senales.sen_riesgo_autolesion_purga ?? 0;
      if (riesgo >= 0.5) {
        return {
          is_triggered: true,
          level: "alert",
          gate: "platt_semantica",
          message: this.SAFE_SUPPORT_MESSAGE,
          helplines: this.RESOURCES_HELPLINES
        };
      }
      // Pausa Suave: desgaste_sostenido >= 0.85 (ponderado 0.75 * hoy + 0.25 * EMA_3d)
      const desgaste = senales.desgaste_sostenido ?? senales.sen_desgaste_sostenido ?? 0;
      if (desgaste >= 0.85) {
        return {
          is_triggered: true,
          level: "pause",
          gate: "desgaste_sostenido_ema",
          message: this.SOFT_PAUSE_MESSAGE,
          helplines: []
        };
      }
    }
    return { is_triggered: false, level: "safe", message: null, helplines: [], gate: "none" };
  },

  calculateSleepHours(bedtime, wakeup) {
    if (!bedtime || !wakeup) return 8.0;
    const bm = /^(\d{2}):(\d{2})$/.exec(bedtime.trim());
    const wm = /^(\d{2}):(\d{2})$/.exec(wakeup.trim());
    if (!bm || !wm) return 8.0;
    const bMin = Number(bm[1]) * 60 + Number(bm[2]);
    let wMin = Number(wm[1]) * 60 + Number(wm[2]);
    if (wMin <= bMin) wMin += 24 * 60;
    const hours = this._round((wMin - bMin) / 60, 2);
    return Math.max(0.5, Math.min(24.0, hours));
  },

  detectDiscrepancy(questionnaire, layaProfile) {
    if (!layaProfile) return { has_discrepancy: false, message: null, level: "none", details: {} };
    const selfReport = String(questionnaire.self_report_word || "").toLowerCase();
    const choice = layaProfile.valencia_emocional.choice;
    const probs = layaProfile.valencia_emocional.probabilities || {};
    const pNeg = (probs.muy_negativo || 0) + (probs.negativo || 0);
    const pPos = (probs.muy_positivo || 0) + (probs.positivo || 0);

    // Regla exacta calibrada: auto_reporte == "Bien" y P(muy_negativo) + P(negativo) >= 0.65
    if (selfReport === "bien" && pNeg >= 0.65) {
      return {
        has_discrepancy: true,
        level: "marked",
        message: "Tu auto-reporte indica que te sentiste 'Bien', sin embargo, tu escrito refleja palabras con tono de tensión o malestar. ¿Sientes que estás minimizando lo que te ocurrió hoy para seguir adelante?",
        details: { self_report: selfReport, laya_choice: choice, p_negativo: this._round(pNeg, 3), type: "positivo_enmascara_negativo" }
      };
    }
    if (selfReport === "mal" && pPos >= 0.7) {
      return {
        has_discrepancy: true,
        level: "marked",
        message: "Calificaste tu día como 'Mal', aunque tus notas destacan elementos positivos o avances. A veces un solo evento incómodo puede opacar las cosas gratas del día.",
        details: { self_report: selfReport, laya_choice: choice, p_positivo: this._round(pPos, 3), type: "negativo_opaca_positivo" }
      };
    }
    if (selfReport === "no_se") {
      const contra = (layaProfile.senales_alerta || {}).contradiccion_emocional || 0;
      const carga = (layaProfile.ejes_tematicos || {}).carga_mental || 0;
      if (contra > 0.6 || carga > 0.6) {
        return {
          has_discrepancy: true,
          level: "mild",
          message: "Seleccionaste 'No sé'. Es comprensible cuando conviven emociones encontradas o hay mucha saturación de pensamientos simultáneos.",
          details: { self_report: selfReport, contradiccion: contra, carga }
        };
      }
    }
    return { has_discrepancy: false, message: null, level: "none", details: {} };
  },

  _parseDateMs(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  },

  computeStreaks(entries) {
    if (!entries || !entries.length) return 0;
    const uniqueMs = Array.from(new Set(entries.map((e) => this._parseDateMs(e.date)))).sort((a, b) => b - a);
    let streak = 1;
    const dayMs = 86400000;
    for (let i = 0; i < uniqueMs.length - 1; i++) {
      if (Math.round((uniqueMs[i] - uniqueMs[i + 1]) / dayMs) === 1) streak += 1;
      else break;
    }
    return streak;
  },

  computePersonalBaseline(entries) {
    if (!entries || !entries.length) {
      return {
        total_days: 0,
        current_streak: 0,
        avg_sleep_hours: 0,
        avg_valence_user: 0,
        avg_valence_laya: 0,
        avg_energy_user: 0,
        avg_energy_laya: 0,
        avg_workload: 0,
        predominant_primary_emotion: "calma",
        discrepancy_count: 0
      };
    }
    const n = entries.length;
    let sleepSum = 0, valUserSum = 0, eneUserSum = 0, workSum = 0;
    const layaVal = [], layaEne = [], emoCounts = {};
    let discCount = 0;

    for (const e of entries) {
      sleepSum += e.questionnaire.sleep_hours;
      valUserSum += e.questionnaire.valence_rating;
      eneUserSum += e.questionnaire.energy_rating;
      workSum += e.questionnaire.workload_rating;
      if (e.discrepancy && e.discrepancy.has_discrepancy) discCount += 1;
      if (e.laya_profile) {
        layaVal.push(e.laya_profile.valencia_score_estimada);
        layaEne.push(this.ENERGY_SCORE_MAP[e.laya_profile.activacion_energia.choice] || 3.0);
        const emo = e.laya_profile.emocion_primaria.choice;
        emoCounts[emo] = (emoCounts[emo] || 0) + 1;
      } else {
        layaVal.push(Number(e.questionnaire.valence_rating));
        layaEne.push(Number(e.questionnaire.energy_rating));
      }
    }
    const sortedEmos = Object.entries(emoCounts).sort((a, b) => b[1] - a[1]);
    return {
      total_days: n,
      current_streak: this.computeStreaks(entries),
      avg_sleep_hours: this._round(sleepSum / n, 2),
      avg_valence_user: this._round(valUserSum / n, 2),
      avg_valence_laya: this._round(layaVal.reduce((a, b) => a + b, 0) / layaVal.length, 2),
      avg_energy_user: this._round(eneUserSum / n, 2),
      avg_energy_laya: this._round(layaEne.reduce((a, b) => a + b, 0) / layaEne.length, 2),
      avg_workload: this._round(workSum / n, 2),
      predominant_primary_emotion: sortedEmos.length ? sortedEmos[0][0] : "calma",
      discrepancy_count: discCount
    };
  },

  buildTimeSeries(entries) {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    return sorted.map((e) => {
      const vLaya = e.laya_profile ? e.laya_profile.valencia_score_estimada : Number(e.questionnaire.valence_rating);
      const eChoice = e.laya_profile ? e.laya_profile.activacion_energia.choice : null;
      const eLaya = eChoice ? (this.ENERGY_SCORE_MAP[eChoice] ?? Number(e.questionnaire.energy_rating)) : Number(e.questionnaire.energy_rating);
      const pEmo = e.laya_profile ? e.laya_profile.emocion_primaria.choice : "neutro";
      return {
        date: e.date,
        valence_user: Number(e.questionnaire.valence_rating),
        valence_laya: this._round(vLaya, 2),
        energy_user: Number(e.questionnaire.energy_rating),
        energy_laya: this._round(eLaya, 2),
        sleep_hours: e.questionnaire.sleep_hours,
        workload: Number(e.questionnaire.workload_rating),
        has_discrepancy: Boolean(e.discrepancy && e.discrepancy.has_discrepancy),
        primary_emotion: pEmo
      };
    });
  },

  computeOnboardingRadar(profile) {
    const habits = new Set(profile.habits_to_improve || []);
    const areas = new Set(profile.stress_areas || []);
    const obj = profile.personal_objective || "constancia";
    const morning = profile.morning_habit || "cafe";

    let descanso = 45.0;
    if (habits.has("dormir_tarde")) descanso += 25.0;
    if (["dormir_mas_horas", "horario_fijo", "dejar_pantallas"].includes(profile.sleep_improvement_goal)) descanso += 15.0;
    if (areas.has("salud")) descanso += 10.0;

    let limites = 45.0;
    if (habits.has("redes_sociales")) limites += 20.0;
    if (obj === "limites_sanos") limites += 25.0;
    if (areas.has("familia_pareja") || areas.has("trabajo_estudio")) limites += 10.0;

    let cargaMental = 45.0;
    if (areas.has("carga_mental")) cargaMental += 25.0;
    if (habits.has("procrastinar")) cargaMental += 15.0;
    if (areas.has("trabajo_estudio") || areas.has("economia")) cargaMental += 10.0;

    let constancia = 50.0 + ({ facil: 15, normal: 25, serio: 35, intensivo: 42 }[profile.daily_goal_level] || 25);
    if (obj === "constancia" || morning === "ejercicio" || morning === "planificar") constancia += 8.0;

    let manejoEstres = 45.0;
    if (obj === "control_emocional" || obj === "mas_energia") manejoEstres += 25.0;
    if (areas.has("trabajo_estudio") || areas.has("carga_mental")) manejoEstres += 15.0;
    if (habits.has("comer_deshoras") || habits.has("olvidar_pausas")) manejoEstres += 10.0;

    return {
      Descanso: this._round(Math.min(98, descanso), 1),
      Límites: this._round(Math.min(98, limites), 1),
      "Carga mental": this._round(Math.min(98, cargaMental), 1),
      Constancia: this._round(Math.min(98, constancia), 1),
      "Manejo del estrés": this._round(Math.min(98, manejoEstres), 1)
    };
  },

  _isLateBedtime(bedtime) {
    if (!bedtime) return false;
    const h = parseInt(String(bedtime).split(":")[0], 10);
    return Number.isFinite(h) && h >= 0 && h < 5;
  },

  evaluateDailyGoalAlignment(questionnaire, layaProfile, userProfile) {
    const signals = [];
    const habits = new Set(userProfile.habits_to_improve || []);
    const areas = new Set(userProfile.stress_areas || []);
    const obj = userProfile.personal_objective;
    const ejes = layaProfile ? (layaProfile.ejes_tematicos || {}) : {};
    const valScore = layaProfile ? layaProfile.valencia_score_estimada : Number(questionnaire.valence_rating);

    let checksTotal = 0, checksMet = 0;
    const wantsSleepCare = habits.has("dormir_tarde") || Boolean(userProfile.sleep_improvement_goal) || obj === "mas_energia";
    if (wantsSleepCare) {
      checksTotal += 1;
      if (questionnaire.sleep_hours < 6.5 || this._isLateBedtime(questionnaire.sleep_bedtime)) {
        signals.push({
          area: "Descanso",
          signal: `Señal frente a tu meta de descanso: registraste ${questionnaire.sleep_hours}h (acostarse ${questionnaire.sleep_bedtime}). Sugerencia: procura adelantar tu cierre hoy.`,
          status: "observacion"
        });
      } else {
        checksMet += 1;
        signals.push({
          area: "Descanso",
          signal: `Patrón positivo de descanso: dormiste ${questionnaire.sleep_hours}h, alineado con tu meta de sueño.`,
          status: "cumplido"
        });
      }
    }

    if (obj === "limites_sanos" || areas.has("trabajo_estudio")) {
      checksTotal += 1;
      const trabajoProb = ejes.trabajo_estudio || 0;
      if (questionnaire.workload_rating >= 4 || (trabajoProb >= 0.7 && valScore < 3.0)) {
        signals.push({
          area: "Límites y Carga",
          signal: "Señal de saturación frente a tu objetivo de límites sanos: hoy la carga laboral/académica tuvo un peso alto en tu día.",
          status: "sugerencia"
        });
      } else {
        checksMet += 1;
        signals.push({
          area: "Límites y Carga",
          signal: "Buen balance entre tus demandas del día y tu objetivo de límites sanos.",
          status: "cumplido"
        });
      }
    }

    if (habits.has("comer_deshoras")) {
      checksTotal += 1;
      if (questionnaire.food_routine === "si") {
        checksMet += 1;
        signals.push({ area: "Rutina física", signal: "Cuidaste tus horarios de comida hoy, sumando puntos a tu meta diaria.", status: "cumplido" });
      } else {
        signals.push({ area: "Rutina física", signal: "Señal en alimentación: mencionaste no comer completamente a tus horas frente al hábito que quieres cuidar.", status: "observacion" });
      }
    }

    const cargaProb = ejes.carga_mental || 0;
    if ((areas.has("carga_mental") || habits.has("procrastinar")) && cargaProb >= 0.65) {
      signals.push({ area: "Carga mental", signal: "El motor local detectó una señal alta de carga mental o pendientes acumulados en tu escrito de hoy.", status: "sugerencia" });
    }

    const adherence = checksTotal > 0 ? this._round((checksMet / checksTotal) * 100, 1) : 100.0;
    return { signals, adherence_score: adherence };
  },

  filterEntriesByPeriod(entries, days = 0) {
    if (!entries || !entries.length || days <= 0) return entries || [];
    const latestMs = Math.max(...entries.map((e) => this._parseDateMs(e.date)));
    const cutoff = latestMs - (days - 1) * 86400000;
    return entries.filter((e) => this._parseDateMs(e.date) >= cutoff);
  },

  classifyEntryMoodCategory(entry) {
    const isRedAlert = Boolean(entry.safety && entry.safety.is_triggered && entry.safety.level === "alert");
    const score = entry.laya_profile ? Number(entry.laya_profile.valencia_score_estimada) : Number(entry.questionnaire.valence_rating);
    if (isRedAlert || score <= 2.0) return "muy_negativo";
    if (score >= 4.2) return "muy_positivo";
    if (score >= 3.4) return "positivo";
    if (score >= 2.6) return "neutro";
    return "negativo";
  },

  computeMoodDistribution(entries) {
    const dist = { muy_positivo: 0, positivo: 0, neutro: 0, negativo: 0, muy_negativo: 0 };
    for (const e of entries) dist[this.classifyEntryMoodCategory(e)] += 1;
    return dist;
  },

  computeLayaAxesAverages(entries) {
    const totals = { trabajo_estudio: 0, descanso_sueno: 0, relaciones_familia: 0, salud_cuerpo: 0, carga_mental: 0 };
    let count = 0;
    for (const e of entries) {
      if (e.laya_profile && e.laya_profile.ejes_tematicos) {
        count += 1;
        for (const k of Object.keys(totals)) totals[k] += Number(e.laya_profile.ejes_tematicos[k] || 0) * 100;
      }
    }
    if (count === 0) return totals;
    const out = {};
    for (const k of Object.keys(totals)) out[k] = this._round(totals[k] / count, 1);
    return out;
  },

  computePeriodGoalCrossInsights(entries, userProfile) {
    if (!entries || !entries.length) return [];
    const insights = [];
    const n = entries.length;
    const habits = new Set(userProfile.habits_to_improve || []);
    const areas = new Set(userProfile.stress_areas || []);

    const shortSleep = entries.filter((e) => e.questionnaire.sleep_hours < 6.5 || this._isLateBedtime(e.questionnaire.sleep_bedtime)).length;
    if (habits.has("dormir_tarde") || userProfile.sleep_improvement_goal) {
      if (shortSleep > 0) insights.push(`Señal en descanso: en ${shortSleep} de ${n} días registraste desvelo o menos de 6.5h de sueño frente a tu meta.`);
      else insights.push(`Patrón positivo de descanso: cumpliste tu meta de horas de sueño en los ${n} días analizados.`);
    }

    const highLoad = entries.filter((e) => e.questionnaire.workload_rating >= 4).length;
    if ((userProfile.personal_objective === "limites_sanos" || areas.has("trabajo_estudio")) && highLoad > 0) {
      insights.push(`Patrón de demanda laboral: ${highLoad} días presentaron carga alta (4-5/5) respecto a tu enfoque de límites sanos.`);
    }

    if (habits.has("comer_deshoras")) {
      const irrFood = entries.filter((e) => e.questionnaire.food_routine !== "si").length;
      if (irrFood > 0) insights.push(`Señal de rutina alimentaria: ${irrFood} de ${n} días mostraron comidas fuera de horario.`);
    }

    const mentalLoad = entries.filter((e) => e.laya_profile && (e.laya_profile.ejes_tematicos?.carga_mental || 0) >= 0.65).length;
    if (mentalLoad > 0) {
      insights.push(`El motor local identificó saturación o carga mental marcada en ${mentalLoad} de ${n} días del periodo.`);
    }
    return insights;
  },

  computeCombinedPersonalRadar(userProfile, selfAssessments, entries) {
    const base = { ...(userProfile.radar_focus || this.computeOnboardingRadar(userProfile)) };
    const seen = new Set();
    for (const sa of selfAssessments || []) {
      if (seen.has(sa.quiz_id)) continue;
      seen.add(sa.quiz_id);
      for (const [axis, impact] of Object.entries(sa.radar_impacts || {})) {
        if (axis in base) base[axis] = this._round(base[axis] * 0.55 + impact * 0.45, 1);
      }
    }
    if (entries && entries.length) {
      const streak = this.computeStreaks(entries);
      const streakScore = Math.min(100, 40 + streak * 8.5);
      base.Constancia = this._round((base.Constancia || 60) * 0.5 + streakScore * 0.5, 1);
    }
    return base;
  },

  evaluateSelfAssessment(quizId, answers) {
    const quiz = this.SELF_ASSESSMENT_QUIZZES[quizId];
    if (!quiz) throw new Error(`Autoevaluación desconocida: ${quizId}`);
    const vals = quiz.questions.map((q) => Math.max(1, Math.min(4, parseInt(answers?.[q.id] ?? 2, 10) || 2)));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const intensity = this._round(((avg - 1) / 3) * 100, 1);
    let resultLabel, reflection;

    if (intensity >= 65) {
      resultLabel = "Señal alta de fricción cotidiana";
      if (quizId === "procrastinacion") {
        reflection = "Se aprecia un patrón de freno antes de comenzar, muchas veces ligado a saturación o perfeccionismo. Sugerencia: prueba la regla de los 5 minutos iniciando con un paso minúsculo e imperfecto.";
      } else if (quizId === "limites_descanso") {
        reflection = "Tu descanso nocturno está compitiendo con pendientes digitales y horarios abiertos. Sugerencia: fija una 'alarma de cierre de pantalla' 30 minutos antes de tu hora objetivo.";
      } else {
        reflection = "Llevas bastante ruido mental activo fuera de horario. Sugerencia: vacía tus pendientes en 'Nota Rápida' antes de dormir para liberar espacio mental.";
      }
    } else if (intensity >= 35) {
      resultLabel = "Equilibrio en construcción";
      reflection = "Manejas varias situaciones con fluidez, aunque aparecen señales intermitentes de desgaste en días exigentes. Sugerencia: conserva una micro-pausa intencional a mitad de tarde.";
    } else {
      resultLabel = "Ritmo sano y consciente";
      reflection = "Tus respuestas reflejan un patrón saludable y claro en esta área. Sugerencia: continúa usando tu diario para notar a tiempo cualquier cambio en tu rutina.";
    }

    const radarImpacts = {};
    for (const axis of quiz.axes) {
      radarImpacts[axis] = this._round(Math.max(40, Math.min(95, 40 + intensity * 0.55)), 1);
    }
    return {
      quiz_id: quizId,
      quiz_title: quiz.title,
      answers,
      score_pct: intensity,
      result_label: resultLabel,
      reflection_message: reflection,
      radar_impacts: radarImpacts
    };
  },

  getAdventurerTitle(level) {
    const idx = Math.min(this.ADVENTURER_TITLES.length - 1, Math.max(0, Math.floor((level - 1) / 2)));
    return this.ADVENTURER_TITLES[idx];
  },

  applyCompanionReward(companion, { expGain = 0, coinsGain = 0, sleepHours = null, valenceScore = null } = {}) {
    const comp = JSON.parse(JSON.stringify(companion));
    comp.coins = Math.max(0, (comp.coins || 0) + coinsGain);
    comp.exp = Math.max(0, (comp.exp || 0) + expGain);
    while (comp.exp >= comp.next_level_exp) {
      comp.exp -= comp.next_level_exp;
      comp.level += 1;
      comp.next_level_exp = Math.round(100 * 1.35 ** (comp.level - 1));
      comp.bond = Math.min(100, comp.bond + 10);
    }
    if (sleepHours !== null && sleepHours !== undefined) {
      if (sleepHours >= 7.0) comp.energy = Math.min(100, comp.energy + 12);
      else if (sleepHours < 6.0) comp.energy = Math.max(25, comp.energy - 8);
    }
    if (valenceScore !== null && valenceScore !== undefined) {
      if (valenceScore >= 3.5) comp.mood = Math.min(100, comp.mood + 8);
      else if (valenceScore < 2.5) comp.bond = Math.min(100, comp.bond + 4);
    }
    comp.bond = Math.max(0, Math.min(100, comp.bond + (expGain > 0 ? 2 : 0)));
    return comp;
  },

  executeCompanionAction(companion, action, value = null) {
    const comp = JSON.parse(JSON.stringify(companion));
    if (action === "pet") {
      comp.mood = Math.min(100, comp.mood + 10);
      comp.bond = Math.min(100, comp.bond + 3);
      return { companion: comp, message: `Acariciaste a ${comp.name}. ¡Se siente acompañado! (+Ánimo)` };
    }
    if (action === "rest") {
      comp.energy = Math.min(100, comp.energy + 20);
      comp.mood = Math.min(100, comp.mood + 4);
      return { companion: comp, message: `${comp.name} tomó una siesta serena (+20 Energía).` };
    }
    if (action === "snack") {
      const now = Date.now();
      if (comp.last_snack_at) {
        const lastMs = Date.parse(comp.last_snack_at);
        if (Number.isFinite(lastMs)) {
          const elapsedMin = (now - lastMs) / 60000;
          if (elapsedMin < 10) {
            const rem = Math.max(1, Math.round(10 - elapsedMin));
            return { companion: comp, message: `Espera ${rem} min para el próximo snack gratis.` };
          }
        }
      }
      comp.satiety = Math.min(100, comp.satiety + 15);
      comp.mood = Math.min(100, comp.mood + 6);
      comp.bond = Math.min(100, comp.bond + 2);
      comp.last_snack_at = new Date(now).toISOString();
      return { companion: comp, message: `¡${comp.name} disfrutó un bocadillo gratis!` };
    }
    if (action === "rename" && value) {
      const cleanName = String(value).trim().slice(0, 20);
      if (cleanName) {
        comp.name = cleanName;
        return { companion: comp, message: `Tu compañero ahora se llama ${cleanName}.` };
      }
    }
    if (action === "buy" && value) {
      const item = this.COMPANION_SHOP_ITEMS[value];
      if (!item) return { companion: comp, message: "Artículo no encontrado." };
      if (comp.coins < item.price) {
        return { companion: comp, message: `Necesitas ${item.price} monedas (tienes ${comp.coins}). Escribe en tu diario para ganar más.` };
      }
      if (item.type === "variant") {
        if ((comp.unlocked_variants || []).includes(item.id)) {
          comp.variant = item.id;
          return { companion: comp, message: `Ya tenías ${item.name}; ¡equipado!` };
        }
        comp.coins -= item.price;
        comp.unlocked_variants = [...(comp.unlocked_variants || ["slime_azul"]), item.id];
        comp.variant = item.id;
        return { companion: comp, message: `¡Desbloqueaste y equipaste ${item.name}!` };
      }
      comp.coins -= item.price;
      comp.pantry = comp.pantry || {};
      comp.pantry[item.id] = (comp.pantry[item.id] || 0) + 1;
      return { companion: comp, message: `Compraste ${item.name}. ¡Ahora está en tu despensa!` };
    }
    if (action === "feed" && value) {
      comp.pantry = comp.pantry || {};
      const qty = comp.pantry[value] || 0;
      const item = this.COMPANION_SHOP_ITEMS[value];
      if (qty <= 0 || !item) return { companion: comp, message: "No tienes ese bocadillo en la despensa." };
      if (qty <= 1) delete comp.pantry[value];
      else comp.pantry[value] = qty - 1;
      comp.satiety = Math.min(100, comp.satiety + (item.satiety || 15));
      comp.energy = Math.min(100, comp.energy + (item.energy || 5));
      comp.mood = Math.min(100, comp.mood + (item.mood || 10));
      comp.bond = Math.min(100, comp.bond + (item.bond || 5));
      return { companion: comp, message: `¡${comp.name} disfrutó ${item.name}!` };
    }
    if (action === "equip_variant" && value) {
      if (value === "slime_azul" || (comp.unlocked_variants || []).includes(value)) {
        comp.variant = value;
        return { companion: comp, message: "Aspecto de compañero actualizado." };
      }
    }
    return { companion: comp, message: "Acción completada." };
  },

  selectDailyReflection(opts = {}) {
    const sugMod = this._resolveSuggestionModule();
    if (!sugMod) return null;
    return sugMod.selectDailyReflection(opts);
  },

  generatePeriodChronicle(stats, opts = {}) {
    const sugMod = this._resolveSuggestionModule();
    if (sugMod) {
      return sugMod.selectPeriodChronicle({
        stats,
        entries: opts.entries || [],
        history: opts.history || [],
        nowIso: opts.nowIso || null
      });
    }
    return {
      card_id: "fallback_det",
      summary_text: this.generateDeterministicSummary(stats),
      generated_by: "Motor analítico local (Zero-Knowledge en navegador)",
      history_record: null
    };
  },

  generateDeterministicSummary(stats, opts = {}) {
    const sugMod = this._resolveSuggestionModule();
    if (sugMod) {
      return sugMod.selectPeriodChronicle({
        stats,
        entries: opts.entries || [],
        history: opts.history || [],
        nowIso: opts.nowIso || null
      }).summary_text;
    }

    const val = stats.valencia_media ?? 3.0;
    const sueno = stats.sueno_medio ?? 7.5;
    const carga = stats.carga_media ?? 3.0;
    const emocion = stats.emocion_dominante || "calma";
    const ejes = stats.ejes_principales || ["trabajo_estudio"];
    const racha = stats.racha || 1;

    let apertura;
    if (val >= 3.8) apertura = "En este periodo se observa un tono general positivo y constructivo.";
    else if (val <= 2.4) apertura = "Tus registros muestran señales de exigencia o momentos de malestar que han requerido de tu paciencia.";
    else apertura = "Tus días reflejan un equilibrio constante con momentos de rutina y estabilidad.";

    let descansoObs;
    if (sueno < 6.5 && carga >= 3.5) descansoObs = `Se aprecia una correlación entre menos horas de sueño (promedio de ${sueno}h) y una carga de trabajo alta (${carga}/5).`;
    else if (sueno >= 7.0 && carga <= 3.0) descansoObs = `El descanso adecuado (promedio de ${sueno}h) parece haber amortiguado las demandas diarias.`;
    else descansoObs = `El descanso se ha mantenido en una media de ${sueno}h diarias frente a una demanda percibida de ${carga}/5.`;

    const ejesStr = ejes.slice(0, 2).map((e) => e.replace(/_/g, " ")).join(", ");
    const emocionObs = `La emoción que más se asoma en tus palabras es la ${emocion}, vinculada principalmente a aspectos de ${ejesStr}.`;

    const cruces = stats.cruces_objetivos || [];
    const cruceStr = cruces.length ? ` ${cruces[0]}` : "";
    const sugerencia = (val < 3.0 || carga > 3.8)
      ? "Sugerencia: regálate pausas breves a mitad del día para desconectar y verificar cómo está tu respiración."
      : "Sugerencia: celebra los pequeños avances del día a día y mantén ese espacio de autoreflexión.";
    const rachaStr = racha > 1 ? ` ¡Llevas una racha de ${racha} días escribiendo!` : "";
    return `${apertura} ${descansoObs} ${emocionObs}${cruceStr} ${sugerencia}${rachaStr}`;
  },

  recallProbability(halfLifeDays, elapsedDays) {
    const h = Math.max(0.1, Number(halfLifeDays || this.DEFAULT_HALF_LIFE_DAYS));
    const d = Math.max(0.0, Number(elapsedDays || 0));
    return 2.0 ** (-d / h);
  },

  nodeState(progress, memory) {
    if (!progress) {
      return {
        status: "nuevo",
        recall: 0.0,
        half_life_days: this.DEFAULT_HALF_LIFE_DAYS,
        elapsed_days: 0.0,
        review_due: false
      };
    }
    const halfLife = Number((memory && memory.half_life_days) || this.DEFAULT_HALF_LIFE_DAYS);
    const lastRev = (memory && memory.last_reviewed_at) || progress.completed_at;
    const lastMs = Date.parse(lastRev);
    const elapsed = Number.isFinite(lastMs) ? Math.max(0, (Date.now() - lastMs) / 86400000) : 0;
    const recall = this.recallProbability(halfLife, elapsed);
    const status = recall < this.REVIEW_THRESHOLD ? "repasar" : "dominado";
    return {
      status,
      recall: this._round(recall, 3),
      half_life_days: this._round(halfLife, 2),
      elapsed_days: this._round(elapsed, 2),
      review_due: recall < this.REVIEW_THRESHOLD
    };
  },

  buildLearningState(tracksPayload, progressMap, memoryMap, notebookList, recentEntries) {
    const tracks = [];
    const dueLessons = [];
    for (const track of tracksPayload.tracks || []) {
      const lessonsOut = [];
      let completedCount = 0;
      for (const lesson of track.lessons || []) {
        const prog = progressMap[lesson.id] || null;
        const st = this.nodeState(prog, memoryMap[lesson.id] || null);
        if (prog) completedCount += 1;
        if (st.review_due) {
          dueLessons.push({
            lesson_id: lesson.id,
            track_id: track.id,
            title: lesson.title,
            track_title: track.title,
            recall: st.recall
          });
        }
        lessonsOut.push({
          id: lesson.id,
          level: lesson.level,
          title: lesson.title,
          subtitle: lesson.subtitle,
          minutes: lesson.minutes,
          exp: lesson.exp,
          steps_count: (lesson.steps || []).length,
          completed: Boolean(prog),
          best_accuracy: prog ? prog.best_accuracy : null,
          attempts: prog ? (prog.attempts || 0) : 0,
          ...st
        });
      }
      const total = (track.lessons || []).length || 1;
      tracks.push({
        id: track.id,
        title: track.title,
        subtitle: track.subtitle,
        icon: track.icon,
        accent: track.accent,
        completed_count: completedCount,
        total_count: total,
        progress_pct: Math.round((completedCount / total) * 100),
        lessons: lessonsOut
      });
    }
    dueLessons.sort((a, b) => a.recall - b.recall);

    let recommendation = null;
    const recentWithLaya = (recentEntries || []).filter((e) => e.laya_profile).slice(0, 3);
    if (recentWithLaya.length >= 3) {
      const allHigh = (axis) => recentWithLaya.every((e) => Number(e.laya_profile?.ejes_tematicos?.[axis] || 0) >= 0.6);
      if (allHigh("descanso_sueno")) {
        recommendation = { track_id: "sueno", message: "Si te interesa entender mejor cómo funciona el descanso, tienes una ruta educativa breve en Aprender." };
      } else if (allHigh("carga_mental")) {
        recommendation = { track_id: "estres", message: "Si quieres entender mejor cómo se acumula la saturación mental, hay una ruta educativa breve en Aprender." };
      }
    }

    return {
      tracks,
      notebook: notebookList || [],
      due_lessons: dueLessons,
      recommendation,
      hlr_threshold: this.REVIEW_THRESHOLD
    };
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = ClientEngine;
}
