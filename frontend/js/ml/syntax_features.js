/**
 * Extractor Sintáctico de Bajo Peso para Español Cotidiano (< 100 KB, < 2 ms).
 *
 * Implementa:
 * 1. Segmentación por cláusulas (puntuación ., ;, \n, ?, ! y conectores adversativos).
 * 2. Ponderación post-adversativa (1.65 después de pero/aunque/sin embargo/la neta/la verdad/en realidad/a pesar de; 1.0 ordinaria).
 * 3. Extractor explícito de 16 señales sintácticas: negación activa en ventana de 5 tokens,
 *    doble negación e intensificadores, ironía entrecomillada/exclamativa, diccionario fraseológico
 *    de modismos mexicanos/hispanos de sobrecarga y contradicción intra-nota + auto-reporte.
 *
 * Cero red externa: corre 100% en el navegador (o en Node para pruebas).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SyntaxFeatures = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WEIGHT_ORDINARY = 1.0;
  const WEIGHT_POST_ADVERSATIVE = 1.65;
  const NEGATION_WINDOW = 5;

  const NEGATION_OPS = new Set([
    "no", "ni", "nunca", "jamas", "nada", "tampoco", "sin", "ningun", "ninguno", "ninguna"
  ]);

  const INTENSIFIERS = {
    muy: 1.35,
    demasiado: 1.45,
    demasiada: 1.45,
    demasiados: 1.4,
    demasiadas: 1.4,
    super: 1.4,
    bastante: 1.25,
    tan: 1.25,
    completamente: 1.45,
    totalmente: 1.45,
    extremadamente: 1.55,
    horriblemente: 1.5,
    terriblemente: 1.5,
    mucho: 1.25,
    mucha: 1.25,
    muchisimo: 1.45,
    muchisima: 1.45
  };

  // Palabras positivas/restaurativas agrupadas por efecto al ser negadas en ventana de 5 tokens.
  const POSITIVE_REST_TARGETS = new Set(["dormir", "dormi", "descansar", "descanso"]);
  const POSITIVE_ENERGY_TARGETS = new Set([
    "energia", "animo", "ganas", "concentrarme", "concentracion",
    "motivado", "motivada", "inspirado", "inspirada", "avance", "avanzar", "logre"
  ]);
  const POSITIVE_AFFECT_TARGETS = new Set([
    "bien", "tranquilo", "tranquila", "tranquilidad", "calma", "sereno", "serena",
    "paz", "feliz", "contento", "contenta", "alegria", "gusto", "mejor",
    "agradable", "bonito", "bonita", "felicidad", "orgulloso", "orgullosa", "disfrute"
  ]);

  const DOUBLE_NEGATION_PHRASES = [
    "no me siento nada",
    "no estoy nada",
    "no esta nada",
    "no dormi nada",
    "no he dormido nada",
    "ni tantito",
    "para nada",
    "ni un poco",
    "ni una pizca",
    "no puedo nada",
    "nunca estoy bien",
    "nunca me siento bien"
  ];

  const EXHAUSTION_LIMIT_PHRASES = [
    "ya no puedo mas",
    "no puedo mas",
    "no aguanto mas",
    "ya no aguanto",
    "no doy mas",
    "ya no doy mas",
    "ya no doy una",
    "hasta el tope",
    "al borde",
    "estoy al limite",
    "sin fuerzas ya"
  ];

  // Ironía / sarcasmo en términos positivos entrecomillados o exclamativos.
  const IRONIC_POSITIVE_STEMS = [
    "maravilloso", "maravillosa", "feliz", "excelente", "genial", "increible",
    "perfecto", "perfecta", "bonito", "bonita", "tranquilo", "tranquila",
    "bien", "gran", "divertido", "divertida", "productivo", "productiva", "alegre"
  ];

  const IRONIC_LEAD_CUES = [
    "segun yo", "claro que si", "aja", "si como no"
  ];

  const COMPLAINT_CONTEXT_WORDS = new Set([
    "pendientes", "trabajo", "jefe", "oficina", "junta", "juntas", "trafico",
    "dolor", "cansado", "cansada", "agotado", "agotada", "harto", "harta",
    "estres", "estresado", "estresada", "colapso", "problema", "problemas",
    "fallo", "madrugada", "desvelo", "peor", "horrible", "pesado", "lunes",
    "carga", "saturado", "saturada", "abrumado", "abrumada", "nada"
  ]);

  // Diccionario fraseológico de modismos mexicanos/hispanos de sobrecarga y desgaste.
  const IDIOM_ENTRIES = [
    {
      phrase: "piloto automatico",
      family: "mental_load",
      weight: 1.5,
      valence: { negativo: 0.9, muy_negativo: 0.2 },
      activation: { agotamiento_baja: 1.35, tension_alta: 0.35 },
      emotion: { apatia: 0.9, estres: 0.75 },
      axes: { carga_mental: 1.75 },
      signals: { desgaste_sostenido: 1.35 }
    },
    {
      phrase: "en automatico",
      family: "mental_load",
      weight: 1.25,
      valence: { negativo: 0.7 },
      activation: { agotamiento_baja: 0.95 },
      emotion: { apatia: 0.85, estres: 0.4 },
      axes: { carga_mental: 1.4 },
      signals: { desgaste_sostenido: 0.85 }
    },
    {
      phrase: "no me da la cabeza",
      family: "mental_load",
      weight: 1.55,
      valence: { negativo: 1.1, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.25, tension_alta: 0.5 },
      emotion: { estres: 0.85, frustracion: 0.6 },
      axes: { carga_mental: 1.85 },
      signals: { desgaste_sostenido: 1.3 }
    },
    {
      phrase: "no me da el cerebro",
      family: "mental_load",
      weight: 1.45,
      valence: { negativo: 1.0 },
      activation: { agotamiento_baja: 1.0 },
      emotion: { estres: 0.8, frustracion: 0.55 },
      axes: { carga_mental: 1.7 },
      signals: { desgaste_sostenido: 0.95 }
    },
    {
      phrase: "cabeza hecha bolas",
      family: "mental_load",
      weight: 1.45,
      valence: { negativo: 0.95 },
      activation: { tension_alta: 1.0, agotamiento_baja: 0.65 },
      emotion: { ansiedad: 0.75, estres: 0.85 },
      axes: { carga_mental: 1.75 },
      signals: { desgaste_sostenido: 0.75 }
    },
    {
      phrase: "mente hecha bolas",
      family: "mental_load",
      weight: 1.45,
      valence: { negativo: 0.95 },
      activation: { tension_alta: 1.0, agotamiento_baja: 0.6 },
      emotion: { ansiedad: 0.75, estres: 0.85 },
      axes: { carga_mental: 1.75 },
      signals: { desgaste_sostenido: 0.75 }
    },
    {
      phrase: "hecha bolas",
      family: "mental_load",
      weight: 1.15,
      valence: { negativo: 0.75 },
      activation: { tension_alta: 0.8 },
      emotion: { frustracion: 0.65, estres: 0.7 },
      axes: { carga_mental: 1.35 },
      signals: { desgaste_sostenido: 0.45 }
    },
    {
      phrase: "hecho bolas",
      family: "mental_load",
      weight: 1.15,
      valence: { negativo: 0.75 },
      activation: { tension_alta: 0.8 },
      emotion: { frustracion: 0.65, estres: 0.7 },
      axes: { carga_mental: 1.35 },
      signals: { desgaste_sostenido: 0.45 }
    },
    {
      phrase: "la lista nunca se achica",
      family: "mental_load",
      weight: 1.5,
      valence: { negativo: 1.05 },
      activation: { tension_alta: 1.15, agotamiento_baja: 0.55 },
      emotion: { estres: 1.1, frustracion: 0.75 },
      axes: { carga_mental: 1.75, trabajo_estudio: 1.2 },
      signals: { desgaste_sostenido: 1.0 }
    },
    {
      phrase: "lista interminable",
      family: "mental_load",
      weight: 1.35,
      valence: { negativo: 0.9 },
      activation: { tension_alta: 1.05 },
      emotion: { estres: 0.95, frustracion: 0.6 },
      axes: { carga_mental: 1.55, trabajo_estudio: 1.0 },
      signals: { desgaste_sostenido: 0.8 }
    },
    {
      phrase: "no me alcanza el dia",
      family: "mental_load",
      weight: 1.2,
      valence: { negativo: 0.8 },
      activation: { tension_alta: 1.0 },
      emotion: { estres: 0.9 },
      axes: { carga_mental: 1.35, trabajo_estudio: 0.9 },
      signals: { desgaste_sostenido: 0.65 }
    },
    {
      phrase: "mil pestanas abiertas",
      family: "mental_load",
      weight: 1.3,
      valence: { negativo: 0.8 },
      activation: { tension_alta: 1.05 },
      emotion: { estres: 0.9, ansiedad: 0.55 },
      axes: { carga_mental: 1.65 },
      signals: { desgaste_sostenido: 0.65 }
    },
    {
      phrase: "mil cosas encima",
      family: "mental_load",
      weight: 1.3,
      valence: { negativo: 0.9 },
      activation: { tension_alta: 1.1 },
      emotion: { estres: 1.0 },
      axes: { carga_mental: 1.55, trabajo_estudio: 0.85 },
      signals: { desgaste_sostenido: 0.75 }
    },
    {
      phrase: "estar fundido",
      family: "burnout",
      weight: 1.55,
      valence: { negativo: 1.0, muy_negativo: 0.5 },
      activation: { agotamiento_baja: 1.5 },
      emotion: { tristeza: 0.55, apatia: 0.8, estres: 0.55 },
      axes: { carga_mental: 1.15, salud_cuerpo: 0.75 },
      signals: { desgaste_sostenido: 1.5 }
    },
    {
      phrase: "estar fundida",
      family: "burnout",
      weight: 1.55,
      valence: { negativo: 1.0, muy_negativo: 0.5 },
      activation: { agotamiento_baja: 1.5 },
      emotion: { tristeza: 0.55, apatia: 0.8, estres: 0.55 },
      axes: { carga_mental: 1.15, salud_cuerpo: 0.75 },
      signals: { desgaste_sostenido: 1.5 }
    },
    {
      phrase: "fundido",
      family: "burnout",
      weight: 1.35,
      valence: { negativo: 0.85, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.35 },
      emotion: { apatia: 0.7, estres: 0.5 },
      axes: { carga_mental: 1.0, salud_cuerpo: 0.65 },
      signals: { desgaste_sostenido: 1.25 }
    },
    {
      phrase: "fundida",
      family: "burnout",
      weight: 1.35,
      valence: { negativo: 0.85, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.35 },
      emotion: { apatia: 0.7, estres: 0.5 },
      axes: { carga_mental: 1.0, salud_cuerpo: 0.65 },
      signals: { desgaste_sostenido: 1.25 }
    },
    {
      phrase: "quemado",
      family: "burnout",
      weight: 1.4,
      valence: { negativo: 0.9, muy_negativo: 0.4 },
      activation: { agotamiento_baja: 1.25, tension_alta: 0.45 },
      emotion: { estres: 0.8, apatia: 0.75 },
      axes: { carga_mental: 1.25, trabajo_estudio: 0.95 },
      signals: { desgaste_sostenido: 1.45 }
    },
    {
      phrase: "quemada",
      family: "burnout",
      weight: 1.4,
      valence: { negativo: 0.9, muy_negativo: 0.4 },
      activation: { agotamiento_baja: 1.25, tension_alta: 0.45 },
      emotion: { estres: 0.8, apatia: 0.75 },
      axes: { carga_mental: 1.25, trabajo_estudio: 0.95 },
      signals: { desgaste_sostenido: 1.45 }
    },
    {
      phrase: "dar el bajon",
      family: "burnout",
      weight: 1.4,
      valence: { negativo: 1.0, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.25 },
      emotion: { tristeza: 1.05, apatia: 0.6 },
      axes: { carga_mental: 0.75 },
      signals: { desgaste_sostenido: 1.15 }
    },
    {
      phrase: "dio el bajon",
      family: "burnout",
      weight: 1.4,
      valence: { negativo: 1.0, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.25 },
      emotion: { tristeza: 1.05, apatia: 0.6 },
      axes: { carga_mental: 0.75 },
      signals: { desgaste_sostenido: 1.15 }
    },
    {
      phrase: "de bajon",
      family: "burnout",
      weight: 1.3,
      valence: { negativo: 0.95, muy_negativo: 0.25 },
      activation: { agotamiento_baja: 1.15 },
      emotion: { tristeza: 0.95, apatia: 0.55 },
      axes: { carga_mental: 0.65 },
      signals: { desgaste_sostenido: 1.0 }
    },
    {
      phrase: "pila baja",
      family: "burnout",
      weight: 1.2,
      valence: { negativo: 0.75 },
      activation: { agotamiento_baja: 1.3 },
      emotion: { apatia: 0.65, tristeza: 0.4 },
      axes: { descanso_sueno: 0.8, salud_cuerpo: 0.6 },
      signals: { desgaste_sostenido: 0.9 }
    },
    {
      phrase: "sin pila",
      family: "burnout",
      weight: 1.2,
      valence: { negativo: 0.75 },
      activation: { agotamiento_baja: 1.3 },
      emotion: { apatia: 0.65 },
      axes: { descanso_sueno: 0.8, salud_cuerpo: 0.55 },
      signals: { desgaste_sostenido: 0.9 }
    },
    {
      phrase: "hecho polvo",
      family: "burnout",
      weight: 1.45,
      valence: { negativo: 0.95, muy_negativo: 0.45 },
      activation: { agotamiento_baja: 1.45 },
      emotion: { tristeza: 0.6, apatia: 0.7 },
      axes: { salud_cuerpo: 0.95, carga_mental: 0.9 },
      signals: { desgaste_sostenido: 1.35 }
    },
    {
      phrase: "hecha polvo",
      family: "burnout",
      weight: 1.45,
      valence: { negativo: 0.95, muy_negativo: 0.45 },
      activation: { agotamiento_baja: 1.45 },
      emotion: { tristeza: 0.6, apatia: 0.7 },
      axes: { salud_cuerpo: 0.95, carga_mental: 0.9 },
      signals: { desgaste_sostenido: 1.35 }
    },
    {
      phrase: "arrastrando la cobija",
      family: "burnout",
      weight: 1.4,
      valence: { negativo: 0.9, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.35 },
      emotion: { apatia: 0.85, tristeza: 0.6 },
      axes: { carga_mental: 0.85, descanso_sueno: 0.75 },
      signals: { desgaste_sostenido: 1.35 }
    },
    {
      phrase: "agua al cuello",
      family: "mental_load",
      weight: 1.4,
      valence: { negativo: 0.95, muy_negativo: 0.3 },
      activation: { tension_alta: 1.3 },
      emotion: { ansiedad: 0.9, estres: 1.05 },
      axes: { carga_mental: 1.45, trabajo_estudio: 1.0 },
      signals: { desgaste_sostenido: 1.0 }
    },
    {
      phrase: "hasta el cuello",
      family: "mental_load",
      weight: 1.3,
      valence: { negativo: 0.85 },
      activation: { tension_alta: 1.2 },
      emotion: { estres: 1.0, ansiedad: 0.7 },
      axes: { carga_mental: 1.4, trabajo_estudio: 0.95 },
      signals: { desgaste_sostenido: 0.85 }
    },
    {
      phrase: "cada dia igual",
      family: "burnout",
      weight: 1.35,
      valence: { negativo: 0.85, muy_negativo: 0.35 },
      activation: { agotamiento_baja: 1.05 },
      emotion: { apatia: 1.05, tristeza: 0.55 },
      axes: { carga_mental: 0.8 },
      signals: { desgaste_sostenido: 1.4 }
    }
  ];

  // Expresiones somáticas / descanso / vínculos / agencia
  const SLEEP_DEFICIT_PHRASES = [
    "dormi mal", "dormi pesimo", "dormi fatal", "no pude dormir", "no dormi",
    "me desvele", "desperte mil veces", "sin pegar el ojo", "poco sueno",
    "insomnio", "madrugue agotado", "desperte cansado", "desperte cansada"
  ];

  const SOMATIC_STRAIN_PHRASES = [
    "dolor de cabeza", "me duele la cabeza", "dolor de espalda", "nudo en el estomago",
    "estomago revuelto", "pecho apretado", "contractura", "hombros tensos",
    "tension en el cuello", "migrana", "fatiga fisica", "palpitaciones"
  ];

  const SOCIAL_POSITIVE_PHRASES = [
    "hable con", "sali con", "comi con", "charle con", "me acompano", "apoyo",
    "abrace", "reimos", "agradeci", "en familia", "con amigos", "con mi pareja"
  ];

  const AGENCY_PROGRESS_PHRASES = [
    "logre", "termine a tiempo", "avance bastante", "resolvi", "me concentre",
    "entregue a tiempo", "cumpli con", "organice", "desconecte a tiempo", "pude descansar"
  ];

  // Léxicos base enriquecidos para ponderación por cláusulas (1.0 / 1.65) y negación.
  const BASE_LEXICONS = {
    valencia: {
      muy_negativo: [
        "no puedo mas", "sin salida", "desesperanza", "insoportable", "horrible",
        "vacio", "llorar", "lloro", "colapso", "hundido", "hundida", "no aguanto",
        "todo mal", "pesimo", "pesima", "devastado", "devastada", "desmorono",
        "desanimo", "impotencia", "rabia", "me esta matando", "explotar"
      ],
      negativo: [
        "cansado", "cansada", "cansancio", "estres", "estresado", "estresada",
        "preocupado", "preocupada", "enojo", "enojado", "enojada", "frustrado",
        "frustrada", "triste", "ansiedad", "ansioso", "ansiosa", "agotado", "agotada",
        "exhausto", "exhausta", "drenado", "drenada", "caotico", "caotica", "agobio",
        "mal dia", "fastidio", "harto", "harta", "pesado", "pesada", "dificil",
        "molesto", "molesta", "nervios", "dolor", "duele", "presion", "presionarme",
        "dormi mal", "desperte", "preocupacion", "abrumado", "abrumada", "saturado",
        "saturada", "mal", "soledad", "falla", "incomoda", "incomodo", "discusion",
        "aislarme", "lagrimas", "incertidumbre", "taquicardia", "critica", "criticaron"
      ],
      positivo: [
        "bien", "contento", "contenta", "tranquilo", "tranquila", "logre", "logramos",
        "bueno", "buen", "alegria", "gusto", "mejor", "descanso", "descanse",
        "reparadora", "reparador", "agradable", "bonito", "bonita", "avance",
        "calma", "paz", "silencio", "equilibrio", "sereno", "serena", "alivio",
        "fluido", "productivo", "productiva", "divertido", "divertida", "rico",
        "tranquilidad", "carino", "fresco", "ordene", "ordenar"
      ],
      muy_positivo: [
        "increible", "feliz", "agradecido", "agradecida", "agradezco", "gratitud",
        "emocionado", "emocionada", "emocion", "euforia", "maravilloso", "maravillosa",
        "excelente", "gran dia", "felicidad", "orgulloso", "orgullosa", "pleno",
        "plena", "afortunado", "afortunada", "celebrarlo", "celebre", "abrazar", "abrace"
      ]
    },
    activacion: {
      agotamiento_baja: [
        "cansado", "cansada", "cansancio", "agotado", "agotada", "exhausto", "exhausta",
        "sin energia", "dormir", "siesta", "desvelo", "pesado", "pesada", "lento",
        "apagado", "apagada", "sin fuerzas", "sueno", "fatiga", "drenado", "drenada",
        "inercia", "aislarme", "nostalgia"
      ],
      calma_estable: [
        "tranquilo", "tranquila", "calma", "relajado", "relajada", "descanso",
        "descanse", "sereno", "serena", "paz", "silencio", "tranquilidad",
        "equilibrio", "estable", "reparadora"
      ],
      tension_alta: [
        "estres", "ansiedad", "ansioso", "ansiosa", "prisa", "presion", "presionarme",
        "pendientes", "nervios", "agobio", "saturado", "saturada", "deadline",
        "entregas", "corriendo", "urgencia", "acelerado", "tenso", "tensa",
        "caotico", "taquicardia", "revuelve", "explotar", "discusion", "criticaron"
      ],
      entusiasmo_alta: [
        "emocionado", "emocionada", "emocion", "motivado", "motivada", "energia",
        "entusiasmo", "animo", "vitalidad", "con ganas", "inspirado", "inspirada",
        "impulso", "celebrarlo", "divertido", "orgulloso", "abrazar"
      ]
    },
    emocion: {
      alegria: ["feliz", "contento", "contenta", "alegria", "risas", "gusto", "disfrute", "sonrisa", "celebre", "celebrarlo", "divertido", "emocion", "orgulloso", "abrazar"],
      calma: ["tranquilo", "tranquila", "calma", "relajado", "relajada", "paz", "silencio", "descanso", "descanse", "sereno", "equilibrio", "tranquilidad"],
      estres: ["estres", "presion", "presionarme", "pendientes", "agobio", "saturado", "saturada", "entregas", "deadline", "trabajo", "juntas", "caotico", "explotar", "duele"],
      tristeza: ["triste", "pena", "solo", "sola", "soledad", "melancolia", "nostalgia", "llorar", "lloro", "lagrimas", "vacio", "desanimo", "pesada"],
      frustracion: ["frustrado", "frustrada", "enojo", "enojado", "enojada", "impotencia", "rabia", "injusto", "harto", "harta", "molesto", "molesta", "fastidio", "falla", "discusion", "criticaron", "insoportable"],
      ansiedad: ["ansiedad", "ansioso", "ansiosa", "nervios", "miedo", "preocupado", "preocupada", "incertidumbre", "zozobra", "taquicardia", "revuelve"],
      gratitud: ["agradecido", "agradecida", "agradezco", "gracias", "gratitud", "bendecido", "afortunado", "afortunada", "valoro", "carino", "nobles"],
      apatia: ["apatia", "desgano", "desinteres", "monotonia", "indiferencia", "sin ganas", "nada me importa", "desconectado", "inercia", "exhausto", "drenado"]
    },
    ejes: {
      trabajo_estudio: [
        "trabajo", "tarea", "tareas", "pendientes", "entrega", "entregas", "jefe",
        "oficina", "universidad", "escuela", "estudio", "estudiar", "examen",
        "clase", "proyecto", "reunion", "reuniones", "junta", "juntas", "equipo", "sprint", "cliente"
      ],
      descanso_sueno: [
        "dormir", "sueno", "desvelo", "siesta", "descanso", "cama", "insomnio",
        "dormi", "dormir mal", "despertar", "desperte", "alarma", "descansar", "madrugada"
      ],
      relaciones_familia: [
        "pareja", "novia", "novio", "amigos", "amiga", "amigo", "familia",
        "mama", "papa", "hermano", "hermana", "hijos", "convivencia", "social",
        "cita", "reunion familiar", "companeros", "companeras"
      ],
      salud_cuerpo: [
        "dolor", "cabeza", "estomago", "cuerpo", "ejercicio", "gym", "correr",
        "comer", "alimentacion", "enfermo", "enferma", "gripe", "espalda",
        "bicicleta", "caminar", "migrana", "salud", "agua"
      ],
      carga_mental: [
        "saturado", "saturada", "saturacion", "piloto automatico", "lista",
        "pendientes", "bloqueo", "no doy", "encima", "carga", "agobio",
        "demasiadas cosas", "sin cabeza", "colapsado", "colapsada", "cabeza"
      ]
    }
  };

  // Salvaguardas para metáforas cotidianas (no son ideación suicida ni purga).
  const SAFE_METAPHOR_PATTERNS = [
    /\bme muero de (risa|sue[nñ]o|hambre|fr[ií]o|calor|pena|verg[uü]enza|ganas|curiosidad|calor)\b/i,
    /\bmuert[oa] de (risa|cansancio|sue[nñ]o|hambre|fr[ií]o|calor)\b/i,
    /\b(cortarm[ea] el (pelo|cabello|u[nñ]as|fleco)|cortar con la rutina|cortar por lo sano)\b/i,
    /\bdeshacerme de (pendientes|cosas|papeles|ropa|tareas|ese problema|correos|trastes|basura)\b/i,
    /\bdesaparecer (de la junta|del trabajo|de la oficina|de redes|del chat|un rato para descansar)\b/i
  ];

  // Frases implícitas de riesgo para compuerta semántica calibrada (riesgo >= 0.50).
  const IMPLICIT_RISK_RULES = [
    {
      name: "implicit_disappear_switchoff",
      re: /\b(?:quisiera|quiero|ojal[aá](?:\s+pudiera)?|necesito|me gustar[ií]a|prefiero)\s+(?:ya\s+)?(?:apagarm[ea]|desaparecer|dejar de existir|no despertar|dormir para siempre|borrarm[ea]|esfumarm[ea]|no estar aqu[ií])\b/i,
      weight: 2.75
    },
    {
      name: "implicit_switchoff_pair",
      re: /\bapagarm[ea]\s+(?:y\s+)?(?:desaparecer|para siempre|de una vez)\b/i,
      weight: 2.85
    },
    {
      name: "implicit_disappear_forever",
      re: /\bdesaparecer\s+(?:para siempre|por completo|de una vez|y no volver)\b/i,
      weight: 2.75
    },
    {
      name: "implicit_no_wake",
      re: /\b(?:ojal[aá]|quisiera|quiero|preferir[ií]a)\s+no\s+(?:despertar|levantarm[ea]\s+nunca|seguir aqu[ií])\b/i,
      weight: 2.75
    },
    {
      name: "implicit_burden_worthless",
      re: /\b(?:soy un estorbo|estorbo en este mundo|todos estar[ií]an mejor sin m[ií]|no le veo sentido a seguir viviendo)\b/i,
      weight: 2.65
    },
    {
      name: "implicit_purge_food",
      re: /\b(?:deshacerm[ea]|sacarm[ea]|sacar|eliminar|quitarm[ea]|arrojar)\s+(?:de\s+)?lo que com[ií]\b/i,
      weight: 2.75
    },
    {
      name: "implicit_purge_compensate",
      re: /\b(?:castigarm[ea]\s+(?:sin comer|por comer)|compensar\s+lo que com[ií]|forzarm[ea]\s+a\s+vomitar|provocarm[ea]\s+el\s+v[oó]mito)\b/i,
      weight: 2.85
    },
    {
      name: "implicit_severe_restriction",
      re: /\bno\s+(?:merezco|deb[ií])\s+(?:comer|probar bocado)\b.*\b(?:nunca|nada|sacar|purgar|deshacer)\b/i,
      weight: 2.5
    }
  ];

  function fold(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function stripSafeMetaphors(rawText) {
    let cleaned = String(rawText || "");
    for (const pat of SAFE_METAPHOR_PATTERNS) {
      cleaned = cleaned.replace(new RegExp(pat.source, "gi"), " [metafora_cotidiana] ");
    }
    return cleaned;
  }

  /**
   * Divide el texto en cláusulas con peso 1.0 (ordinaria) y 1.65 (post-adversativa).
   * Preserva el texto original por cláusula para detección de comillas y exclamaciones.
   */
  function segmentClauses(text) {
    const source = String(text || "").trim();
    if (!source) return [];

    // Quitar encabezado sintético de Notas Rápidas sin perder líneas de notas.
    const cleanLines = source
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/^notas r[aá]pidas del d[ií]a:\s*/i, "").replace(/^\[\d{2}:\d{2}\]\s*/, "").trim())
      .filter(Boolean);

    const clauses = [];
    const advRe = /(?:^|[,\s—:])((?:pero(?:\s+(?:la\s+verdad|la\s+neta|en\s+realidad|bueno))?|sin\s+embargo|no\s+obstante|la\s+neta|la\s+verdad|en\s+realidad|a\s+pesar\s+de(?:\s+(?:todo|que))?|por\s+desgracia|lo\s+malo\s+es\s+que|el\s+problema\s+es\s+que|aunque)\b)/gi;

    for (const line of cleanLines) {
      // Dividir por puntuación fuerte manteniendo presencia de signo exclamativo.
      const sentRe = /([^.;!?]+)([.;!?]*)/g;
      let sm;
      while ((sm = sentRe.exec(line)) !== null) {
        const sentRaw = (sm[1] || "").trim();
        const punct = sm[2] || "";
        if (!sentRaw) continue;
        const hasExclamation = punct.includes("!") || sentRaw.includes("¡");

        // Caso especial español: "Aunque X, Y" al inicio de la oración -> Y lleva el foco 1.65.
        const initialAunque = /^\s*aunque\b([^,]+),\s*(.+)$/i.exec(sentRaw);
        if (initialAunque) {
          const part1 = initialAunque[1].trim();
          const part2 = initialAunque[2].trim();
          if (part1) {
            clauses.push({
              raw: part1,
              folded: fold(part1),
              isPostAdversative: false,
              connector: "aunque_concesiva",
              weight: WEIGHT_ORDINARY,
              hasExclamation
            });
          }
          if (part2) {
            // Verificar si part2 contiene aún otro conector adversativo interno.
            const sub = splitByConnectors(part2, advRe, true, "aunque_foco", hasExclamation);
            clauses.push(...sub);
          }
          continue;
        }

        const subClauses = splitByConnectors(sentRaw, advRe, false, null, hasExclamation);
        clauses.push(...subClauses);
      }
    }

    return clauses;
  }

  function splitByConnectors(segment, advRe, defaultPostAdv, defaultConnector, hasExclamation) {
    const out = [];
    advRe.lastIndex = 0;
    let lastIdx = 0;
    let currentPost = defaultPostAdv;
    let currentConn = defaultConnector;
    let m;

    while ((m = advRe.exec(segment)) !== null) {
      const connWord = m[1];
      const connStart = m.index + (m[0].length - connWord.length);
      const before = segment.slice(lastIdx, m.index).replace(/^[,;\s—:]+|[,;\s—:]+$/g, "").trim();
      if (before) {
        out.push({
          raw: before,
          folded: fold(before),
          isPostAdversative: currentPost,
          connector: currentConn,
          weight: currentPost ? WEIGHT_POST_ADVERSATIVE : WEIGHT_ORDINARY,
          hasExclamation
        });
      }
      lastIdx = connStart + connWord.length;
      currentPost = true;
      currentConn = fold(connWord).replace(/\s+/g, " ").trim();
    }

    const tail = segment.slice(lastIdx).replace(/^[,;\s—:]+|[,;\s—:]+$/g, "").trim();
    if (tail) {
      out.push({
        raw: tail,
        folded: fold(tail),
        isPostAdversative: currentPost,
        connector: currentConn,
        weight: currentPost ? WEIGHT_POST_ADVERSATIVE : WEIGHT_ORDINARY,
        hasExclamation
      });
    }
    return out;
  }

  function tokenizeFolded(foldedClause) {
    const tokens = [];
    const re = /[a-z0-9]+/g;
    let m;
    while ((m = re.exec(foldedClause)) !== null) {
      tokens.push({ word: m[0], index: tokens.length, start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function countPhraseMatches(foldedClause, phrase) {
    const needle = fold(phrase);
    if (!needle) return 0;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(needle)}(?:$|[^a-z0-9])`, "g");
    const matches = foldedClause.match(re);
    return matches ? matches.length : 0;
  }

  /**
   * Detecta términos positivos entrecomillados ("maravilloso", 'feliz') y exclamaciones irónicas.
   */
  function analyzeIronyInClause(clauseRaw, clauseFolded, globalComplaintCount) {
    let ironicQuotes = 0;
    let ironicExclamation = 0;
    const ironicPositiveWordsMatched = new Set();

    const quoteRe = /["'“‘«]\s*([^"'”’»\n]{1,42}?)\s*["'”’»]/g;
    let qm;
    while ((qm = quoteRe.exec(clauseRaw)) !== null) {
      const inner = fold(qm[1]);
      for (const stem of IRONIC_POSITIVE_STEMS) {
        if (new RegExp(`\\b${stem}\\b`).test(inner)) {
          ironicQuotes += 1;
          ironicPositiveWordsMatched.add(stem);
        }
      }
    }

    const tokens = tokenizeFolded(clauseFolded);
    const localComplaintHits = tokens.filter((t) => COMPLAINT_CONTEXT_WORDS.has(t.word)).length;
    const hasLeadCue = IRONIC_LEAD_CUES.some((cue) => countPhraseMatches(clauseFolded, cue) > 0);

    // Exclamación irónica dentro de quejas o con marcador "según yo" / "qué ...!"
    if (clauseFolded.includes("!") || /[¡!]/.test(clauseRaw)) {
      const posFound = tokens.filter((t) => IRONIC_POSITIVE_STEMS.includes(t.word)).map((t) => t.word);
      if (posFound.length > 0 && (localComplaintHits > 0 || globalComplaintCount >= 2 || hasLeadCue)) {
        ironicExclamation += 1;
        posFound.forEach((w) => ironicPositiveWordsMatched.add(w));
      }
    } else if (hasLeadCue && (localComplaintHits > 0 || ironicQuotes > 0 || globalComplaintCount >= 2)) {
      const posFound = tokens.filter((t) => IRONIC_POSITIVE_STEMS.includes(t.word)).map((t) => t.word);
      if (posFound.length > 0) {
        ironicQuotes += 0.75;
        posFound.forEach((w) => ironicPositiveWordsMatched.add(w));
      }
    }

    return {
      ironicQuotes,
      ironicExclamation,
      ironicPositiveWordsMatched
    };
  }

  function hasWindowNegation(tokens, tokenIdx, windowSize = NEGATION_WINDOW) {
    let negCount = 0;
    let closestDist = 999;
    const start = Math.max(0, tokenIdx - windowSize);
    for (let i = tokenIdx - 1; i >= start; i--) {
      const w = tokens[i].word;
      if (NEGATION_OPS.has(w)) {
        negCount += 1;
        if (closestDist === 999) closestDist = tokenIdx - i;
      }
    }
    return { negated: negCount > 0, negCount, closestDist };
  }

  function localIntensifierMultiplier(tokens, tokenIdx) {
    let mult = 1.0;
    let hits = 0;
    const start = Math.max(0, tokenIdx - 2);
    for (let i = tokenIdx - 1; i >= start; i--) {
      const m = INTENSIFIERS[tokens[i].word];
      if (m) {
        mult = Math.max(mult, m);
        hits += 1;
      }
    }
    return { mult, hits };
  }

  function addScore(map, key, val) {
    if (!val) return;
    map[key] = (map[key] || 0) + val;
  }

  /**
   * Extrae características sintácticas, 16 señales explícitas y logits brutos por bloque.
   */
  function extract(text, questionnaire = null) {
    const raw = String(text || "").trim();
    if (!raw) {
      return {
        clauses: [],
        signals16: buildEmptySignals16(),
        rawLogits: buildZeroRawLogits(),
        hasAdversativeShift: false,
        intraNoteContradiction: 0,
        implicitRiskHits: [],
        tokenCount: 0,
        postAdversativeClauses: 0
      };
    }

    const clauses = segmentClauses(raw);
    const fullFolded = fold(raw);

    // Contar palabras de queja globales para ayudar en detección de ironía exclamativa.
    const allTokens = tokenizeFolded(fullFolded);
    const globalComplaintCount = allTokens.filter((t) => COMPLAINT_CONTEXT_WORDS.has(t.word)).length;

    const rawLogits = buildZeroRawLogits();
    const signalAccum = buildEmptySignals16();

    const clausePolarities = [];
    let hasAdversativeShift = false;
    let postAdvCount = 0;
    let ordCount = 0;

    // 1. Procesar cada cláusula con su peso 1.0 o 1.65
    for (const cl of clauses) {
      const w = cl.weight;
      if (cl.isPostAdversative) postAdvCount += 1;
      else ordCount += 1;

      const tokens = tokenizeFolded(cl.folded);
      let clausePosScore = 0;
      let clauseNegScore = 0;

      // 1a. Ironía entrecomillada y exclamativa en la cláusula
      const irony = analyzeIronyInClause(cl.raw, cl.folded, globalComplaintCount);
      if (irony.ironicQuotes > 0) {
        signalAccum.sig_ironic_quotes += irony.ironicQuotes * w;
        addScore(rawLogits.valencia, "negativo", 1.15 * w * irony.ironicQuotes);
        addScore(rawLogits.emocion, "frustracion", 0.85 * w * irony.ironicQuotes);
        addScore(rawLogits.emocion, "estres", 0.65 * w * irony.ironicQuotes);
        addScore(rawLogits.senales, "contradiccion_emocional", 1.15 * w);
        clauseNegScore += 0.9 * irony.ironicQuotes;
      }
      if (irony.ironicExclamation > 0) {
        signalAccum.sig_ironic_exclamation += irony.ironicExclamation * w;
        addScore(rawLogits.valencia, "negativo", 0.95 * w * irony.ironicExclamation);
        addScore(rawLogits.emocion, "frustracion", 0.8 * w * irony.ironicExclamation);
        addScore(rawLogits.senales, "contradiccion_emocional", 0.95 * w);
        clauseNegScore += 0.8 * irony.ironicExclamation;
      }

      // 1b. Modismos mexicanos/hispanos en la cláusula
      for (const idiom of IDIOM_ENTRIES) {
        const hits = countPhraseMatches(cl.folded, idiom.phrase);
        if (!hits) continue;
        const factor = hits * w;
        if (idiom.family === "mental_load") {
          signalAccum.sig_idiom_mental_load += factor;
        } else {
          signalAccum.sig_idiom_burnout += factor;
        }
        for (const [k, v] of Object.entries(idiom.valence || {})) {
          addScore(rawLogits.valencia, k, v * factor);
          if (k === "negativo" || k === "muy_negativo") clauseNegScore += v;
        }
        for (const [k, v] of Object.entries(idiom.activation || {})) {
          addScore(rawLogits.activacion, k, v * factor);
        }
        for (const [k, v] of Object.entries(idiom.emotion || {})) {
          addScore(rawLogits.emocion, k, v * factor);
        }
        for (const [k, v] of Object.entries(idiom.axes || {})) {
          addScore(rawLogits.ejes, k, v * factor);
        }
        for (const [k, v] of Object.entries(idiom.signals || {})) {
          addScore(rawLogits.senales, k, v * factor);
        }
      }

      // 1c. Doble negación y frases límite
      for (const dp of DOUBLE_NEGATION_PHRASES) {
        const hits = countPhraseMatches(cl.folded, dp);
        if (hits > 0) {
          signalAccum.sig_double_negation += hits * w;
          addScore(rawLogits.valencia, "negativo", 1.2 * hits * w);
          addScore(rawLogits.valencia, "muy_negativo", 0.65 * hits * w);
          addScore(rawLogits.activacion, "agotamiento_baja", 0.85 * hits * w);
          addScore(rawLogits.emocion, "tristeza", 0.7 * hits * w);
          clauseNegScore += 1.2 * hits;
        }
      }
      for (const ep of EXHAUSTION_LIMIT_PHRASES) {
        const hits = countPhraseMatches(cl.folded, ep);
        if (hits > 0) {
          signalAccum.sig_exhaustion_limit += hits * w;
          addScore(rawLogits.valencia, "muy_negativo", 1.4 * hits * w);
          addScore(rawLogits.valencia, "negativo", 0.9 * hits * w);
          addScore(rawLogits.activacion, "agotamiento_baja", 1.35 * hits * w);
          addScore(rawLogits.senales, "desgaste_sostenido", 1.75 * hits * w);
          addScore(rawLogits.ejes, "carga_mental", 1.1 * hits * w);
          clauseNegScore += 1.5 * hits;
        }
      }

      // 1d. Frases de déficit de sueño, somáticas, apoyo social y progreso
      for (const p of SLEEP_DEFICIT_PHRASES) {
        const hits = countPhraseMatches(cl.folded, p);
        if (hits > 0) {
          signalAccum.sig_sleep_deficit_phrases += hits * w;
          addScore(rawLogits.ejes, "descanso_sueno", 1.55 * hits * w);
          addScore(rawLogits.valencia, "negativo", 0.9 * hits * w);
          addScore(rawLogits.activacion, "agotamiento_baja", 1.1 * hits * w);
          clauseNegScore += 0.8 * hits;
        }
      }
      for (const p of SOMATIC_STRAIN_PHRASES) {
        const hits = countPhraseMatches(cl.folded, p);
        if (hits > 0) {
          signalAccum.sig_somatic_strain += hits * w;
          addScore(rawLogits.ejes, "salud_cuerpo", 1.45 * hits * w);
          addScore(rawLogits.valencia, "negativo", 0.7 * hits * w);
          addScore(rawLogits.activacion, "tension_alta", 0.65 * hits * w);
          clauseNegScore += 0.65 * hits;
        }
      }
      for (const p of SOCIAL_POSITIVE_PHRASES) {
        const hits = countPhraseMatches(cl.folded, p);
        if (hits > 0) {
          // Verificar que no vaya precedido de negación ("no hable con nadie", "sin apoyo").
          const idxPos = cl.folded.indexOf(p);
          const prefix = cl.folded.slice(Math.max(0, idxPos - 18), idxPos);
          if (!/\b(no|ni|nunca|sin)\s*$/.test(prefix)) {
            signalAccum.sig_social_support_positive += hits * w;
            addScore(rawLogits.ejes, "relaciones_familia", 1.2 * hits * w);
            addScore(rawLogits.valencia, "positivo", 0.7 * hits * w);
            addScore(rawLogits.emocion, "gratitud", 0.45 * hits * w);
            clausePosScore += 0.7 * hits;
          }
        }
      }
      for (const p of AGENCY_PROGRESS_PHRASES) {
        const hits = countPhraseMatches(cl.folded, p);
        if (hits > 0) {
          const idxPos = cl.folded.indexOf(p);
          const prefix = cl.folded.slice(Math.max(0, idxPos - 18), idxPos);
          if (/\b(no|ni|nunca|jamas|sin|tampoco)\s+$/.test(prefix) || /\b(no\s+pude|ni\s+pude)\s+$/.test(prefix)) {
            signalAccum.sig_negated_sleep_energy += hits * w;
            addScore(rawLogits.valencia, "negativo", 0.9 * hits * w);
            addScore(rawLogits.emocion, "frustracion", 0.85 * hits * w);
            clauseNegScore += 0.85 * hits;
          } else {
            signalAccum.sig_agency_progress += hits * w;
            addScore(rawLogits.valencia, "positivo", 0.85 * hits * w);
            addScore(rawLogits.emocion, "alegria", 0.5 * hits * w);
            clausePosScore += 0.85 * hits;
          }
        }
      }

      // 1e. Escaneo token por token con ventana de negación (5 tokens) e intensificadores.
      const suppressedTokens = new Set();
      tokens.forEach((tok, idx) => {
        const word = tok.word;
        const { mult: intensMult, hits: intensHits } = localIntensifierMultiplier(tokens, idx);
        if (intensHits > 0 && INTENSIFIERS[word] == null) {
          signalAccum.sig_intensifiers += intensHits * 0.25 * w;
        }
        const negInfo = hasWindowNegation(tokens, idx, NEGATION_WINDOW);
        const isIronicWord = irony.ironicPositiveWordsMatched.has(word);

        // Si un término positivo aparece entrecomillado o exclamado irónicamente, no suma positivo.
        if (isIronicWord) {
          suppressedTokens.add(idx);
          return;
        }

        // Concesivo frustrado ("por más que intenté estar tranquilo...") seguido de fallo/negación en la nota.
        const isFrustratedAttempt =
          (POSITIVE_AFFECT_TARGETS.has(word) || POSITIVE_ENERGY_TARGETS.has(word)) &&
          /\b(?:por mas que|aunque)\s+(?:intente|trate|quise|busque)\b[^.;!?]*$/.test(cl.folded.slice(0, tok.start)) &&
          /\b(no|ni|nunca|tampoco|sin)\b/.test(fullFolded);
        if (isFrustratedAttempt) {
          suppressedTokens.add(idx);
          signalAccum.sig_negated_positive += 0.6 * w;
          addScore(rawLogits.valencia, "negativo", 0.55 * w);
          clauseNegScore += 0.5;
          return;
        }

        const isRestTarget = POSITIVE_REST_TARGETS.has(word);
        const isEnergyTarget = POSITIVE_ENERGY_TARGETS.has(word);
        const isAffectTarget = POSITIVE_AFFECT_TARGETS.has(word);

        if (negInfo.negated && (isRestTarget || isEnergyTarget || isAffectTarget)) {
          suppressedTokens.add(idx);
          const doubleBoost = negInfo.negCount >= 2 ? 1.35 : 1.0;
          if (negInfo.negCount >= 2) {
            signalAccum.sig_double_negation += 0.75 * w;
          }
          const score = w * intensMult * doubleBoost;

          if (isRestTarget) {
            signalAccum.sig_negated_sleep_energy += 1.0 * score;
            addScore(rawLogits.valencia, "negativo", 1.15 * score);
            addScore(rawLogits.activacion, "agotamiento_baja", 1.25 * score);
            addScore(rawLogits.ejes, "descanso_sueno", 1.45 * score);
            addScore(rawLogits.senales, "desgaste_sostenido", 0.75 * score);
            clauseNegScore += 1.1 * doubleBoost;
          } else if (isEnergyTarget) {
            signalAccum.sig_negated_sleep_energy += 1.0 * score;
            addScore(rawLogits.valencia, "negativo", 1.05 * score);
            addScore(rawLogits.activacion, "agotamiento_baja", 1.2 * score);
            addScore(rawLogits.emocion, "apatia", 0.9 * score);
            addScore(rawLogits.emocion, "frustracion", 0.55 * score);
            addScore(rawLogits.ejes, "carga_mental", 0.9 * score);
            addScore(rawLogits.senales, "desgaste_sostenido", 0.85 * score);
            clauseNegScore += 1.05 * doubleBoost;
          } else {
            signalAccum.sig_negated_positive += 1.0 * score;
            addScore(rawLogits.valencia, "negativo", 1.25 * score);
            if (doubleBoost > 1.0 || intensMult >= 1.35) {
              addScore(rawLogits.valencia, "muy_negativo", 0.65 * score);
            }
            addScore(rawLogits.activacion, "agotamiento_baja", 0.65 * score);
            addScore(rawLogits.emocion, "tristeza", 0.85 * score);
            addScore(rawLogits.emocion, "frustracion", 0.55 * score);
            clauseNegScore += 1.2 * doubleBoost;
          }
          return;
        }

        // Acumular hits léxicos en los 4 bloques si no fueron invertidos ni ironizados.
        let tokenAddedNeg = false;
        const negNear = hasWindowNegation(tokens, idx, 4).negated;

        for (const [cat, words] of Object.entries(BASE_LEXICONS.valencia)) {
          if (words.includes(word)) {
            if ((cat === "negativo" || cat === "muy_negativo") && negNear && !word.startsWith("no ")) {
              // "no estoy triste" / "sin estrés" atenúa fuertemente la carga negativa.
              addScore(rawLogits.valencia, "neutro", 0.45 * w);
              clausePosScore += 0.25;
              tokenAddedNeg = true;
              continue;
            }
            const factor = w * intensMult;
            addScore(rawLogits.valencia, cat, 1.0 * factor);
            if (cat === "positivo" || cat === "muy_positivo") clausePosScore += 0.9 * intensMult;
            if (cat === "negativo" || cat === "muy_negativo") clauseNegScore += 0.95 * intensMult;
          }
        }

        for (const [cat, words] of Object.entries(BASE_LEXICONS.activacion)) {
          if (words.includes(word)) {
            if ((cat === "tension_alta" || cat === "agotamiento_baja") && negNear) {
              addScore(rawLogits.activacion, "calma_estable", 0.4 * w);
              continue;
            }
            addScore(rawLogits.activacion, cat, 1.0 * w * intensMult);
          }
        }

        for (const [cat, words] of Object.entries(BASE_LEXICONS.emocion)) {
          if (words.includes(word)) {
            if (["estres", "tristeza", "frustracion", "ansiedad", "apatia"].includes(cat) && negNear) {
              addScore(rawLogits.emocion, "calma", 0.4 * w);
              continue;
            }
            addScore(rawLogits.emocion, cat, 1.0 * w * intensMult);
          }
        }

        if (!tokenAddedNeg) {
          for (const [eje, words] of Object.entries(BASE_LEXICONS.ejes)) {
            if (words.includes(word)) {
              addScore(rawLogits.ejes, eje, 1.0 * w);
            }
          }
        }
      });

      // Señales adicionales de desgaste por palabras clave no idiomáticas.
      for (const word of ["agotado", "agotada", "desgaste", "sin fuerzas", "desesperanza", "harto", "harta", "arrastrando", "colapso", "derrumbe"]) {
        const hits = countPhraseMatches(cl.folded, word);
        if (hits > 0) {
          const isNegatedWord = word === "agotado" || word === "agotada" || word === "harto" || word === "harta"
            ? /\b(?:no|sin|ya no)\s+$/.test(cl.folded.slice(Math.max(0, cl.folded.indexOf(word) - 10), cl.folded.indexOf(word)))
            : false;
          if (!isNegatedWord) {
            addScore(rawLogits.senales, "desgaste_sostenido", 0.95 * hits * w);
          }
        }
      }

      // Calcular polaridad neta normalizada de la cláusula en [-1, 1].
      const totalC = clausePosScore + clauseNegScore;
      const netPol = totalC > 0 ? (clausePosScore - clauseNegScore) / Math.max(1.2, totalC) : 0;
      clausePolarities.push({
        weight: w,
        isPostAdversative: cl.isPostAdversative,
        pos: Number(clausePosScore.toFixed(3)),
        neg: Number(clauseNegScore.toFixed(3)),
        netPolarity: Number(netPol.toFixed(3))
      });

      cl._pos = clausePosScore;
      cl._neg = clauseNegScore;
      cl._net = netPol;
    }

    // 2. Contradicción intra-nota + giro post-adversativo (ej. positivo antes del "pero", negativo después).
    let maxPosClause = 0;
    let maxNegClause = 0;
    for (let i = 0; i < clauses.length; i++) {
      const cl = clauses[i];
      if (cl._net > 0) maxPosClause = Math.max(maxPosClause, cl._net);
      if (cl._net < 0) maxNegClause = Math.max(maxNegClause, Math.abs(cl._net));
      if (i > 0 && cl.isPostAdversative) {
        const prev = clauses[i - 1];
        if (prev._pos >= 0.45 && cl._neg >= 0.45) {
          hasAdversativeShift = true;
          // La cláusula post-adversativa anula parcialmente el reclamo previo ("dije que todo bien, pero...").
          rawLogits.valencia.positivo = Math.max(0, rawLogits.valencia.positivo - prev._pos * 0.65);
          rawLogits.valencia.muy_positivo = Math.max(0, rawLogits.valencia.muy_positivo - prev._pos * 0.35);
          rawLogits.activacion.calma_estable = Math.max(0, rawLogits.activacion.calma_estable * 0.45);
          rawLogits.emocion.calma = Math.max(0, rawLogits.emocion.calma * 0.45);
        } else if (prev._neg >= 0.45 && cl._pos >= 0.45) {
          hasAdversativeShift = true;
          rawLogits.valencia.negativo = Math.max(0, rawLogits.valencia.negativo - prev._neg * 0.65);
          rawLogits.valencia.muy_negativo = Math.max(0, rawLogits.valencia.muy_negativo - prev._neg * 0.35);
        }
      }
    }

    const intraNoteContradiction = clamp01(
      maxPosClause * maxNegClause * 1.45 + (hasAdversativeShift ? 0.35 : 0)
    );
    signalAccum.sig_intra_note_contradiction = intraNoteContradiction;
    if (intraNoteContradiction > 0) {
      addScore(rawLogits.senales, "contradiccion_emocional", intraNoteContradiction * 2.1);
    }
    if (postAdvCount > 0) {
      signalAccum.sig_adversative_ratio = clamp01((postAdvCount / Math.max(1, clauses.length)) * (hasAdversativeShift ? 1.4 : 1.0));
    }

    // 3. Distancia frente al auto-reporte del cuestionario (1..5 y palabra clave).
    let selfReportGap = 0;
    if (questionnaire) {
      const netTextPolarity =
        (rawLogits.valencia.positivo + rawLogits.valencia.muy_positivo * 1.3 -
          rawLogits.valencia.negativo - rawLogits.valencia.muy_negativo * 1.35) /
        Math.max(1.5, rawLogits.valencia.positivo + rawLogits.valencia.negativo + rawLogits.valencia.muy_negativo + rawLogits.valencia.muy_positivo);

      const srWord = fold(questionnaire.self_report_word || "");
      const ratingNorm = ((Number(questionnaire.valence_rating || 3) - 3) / 2); // -1..1
      if (srWord === "bien" && netTextPolarity < -0.25) {
        selfReportGap = clamp01(Math.abs(netTextPolarity) * 1.25);
      } else if (srWord === "mal" && netTextPolarity > 0.25) {
        selfReportGap = clamp01(netTextPolarity * 1.15);
      } else if (srWord === "no_se" && intraNoteContradiction > 0.3) {
        selfReportGap = clamp01(intraNoteContradiction * 0.9);
      } else {
        const gap = Math.abs(ratingNorm - netTextPolarity);
        if (gap >= 0.6) selfReportGap = clamp01((gap - 0.3) * 0.8);
      }
      signalAccum.sig_self_report_gap = selfReportGap;
      if (selfReportGap >= 0.45) {
        addScore(rawLogits.senales, "contradiccion_emocional", selfReportGap * 1.4);
      }
    }

    // 4. Compuerta semántica de riesgo implícito (salvaguardada ante metáforas).
    const safeCleanedRaw = stripSafeMetaphors(raw);
    const safeCleanedFolded = fold(safeCleanedRaw);
    const implicitRiskHits = [];
    for (const rule of IMPLICIT_RISK_RULES) {
      if (rule.re.test(safeCleanedRaw) || rule.re.test(safeCleanedFolded)) {
        implicitRiskHits.push(rule.name);
        addScore(rawLogits.senales, "riesgo_autolesion_purga", rule.weight);
      }
    }

    // Frases de léxico directo de señal riesgo (no regex de crisis inmediata, pero alta relevancia).
    for (const phrase of ["autolesion", "hacerme dano", "cortarme", "lastimarme", "purga", "vomitar", "dejar de comer", "restringir comida"]) {
      if (countPhraseMatches(safeCleanedFolded, phrase) > 0) {
        implicitRiskHits.push(`lex:${phrase}`);
        addScore(rawLogits.senales, "riesgo_autolesion_purga", 2.35);
      }
    }

    // Normalizar las 16 señales explícitas en [0, 1] para vectorización y trazabilidad.
    const signals16 = {
      sig_adversative_ratio: Number(clamp01(signalAccum.sig_adversative_ratio).toFixed(4)),
      sig_negated_positive: Number(clamp01(signalAccum.sig_negated_positive / 2.2).toFixed(4)),
      sig_negated_sleep_energy: Number(clamp01(signalAccum.sig_negated_sleep_energy / 2.2).toFixed(4)),
      sig_double_negation: Number(clamp01(signalAccum.sig_double_negation / 1.5).toFixed(4)),
      sig_exhaustion_limit: Number(clamp01(signalAccum.sig_exhaustion_limit / 1.5).toFixed(4)),
      sig_intensifiers: Number(clamp01(signalAccum.sig_intensifiers).toFixed(4)),
      sig_ironic_quotes: Number(clamp01(signalAccum.sig_ironic_quotes / 1.5).toFixed(4)),
      sig_ironic_exclamation: Number(clamp01(signalAccum.sig_ironic_exclamation / 1.2).toFixed(4)),
      sig_idiom_mental_load: Number(clamp01(signalAccum.sig_idiom_mental_load / 2.0).toFixed(4)),
      sig_idiom_burnout: Number(clamp01(signalAccum.sig_idiom_burnout / 2.0).toFixed(4)),
      sig_sleep_deficit_phrases: Number(clamp01(signalAccum.sig_sleep_deficit_phrases / 1.8).toFixed(4)),
      sig_somatic_strain: Number(clamp01(signalAccum.sig_somatic_strain / 1.6).toFixed(4)),
      sig_social_support_positive: Number(clamp01(signalAccum.sig_social_support_positive / 1.5).toFixed(4)),
      sig_agency_progress: Number(clamp01(signalAccum.sig_agency_progress / 1.5).toFixed(4)),
      sig_intra_note_contradiction: Number(clamp01(signalAccum.sig_intra_note_contradiction).toFixed(4)),
      sig_self_report_gap: Number(clamp01(signalAccum.sig_self_report_gap).toFixed(4))
    };

    return {
      clauses: clauses.map((c, idx) => ({
        index: idx,
        text: c.raw,
        isPostAdversative: c.isPostAdversative,
        connector: c.connector,
        weight: c.weight,
        netPolarity: Number((c._net || 0).toFixed(3))
      })),
      signals16,
      rawLogits,
      hasAdversativeShift,
      intraNoteContradiction: Number(intraNoteContradiction.toFixed(4)),
      implicitRiskHits,
      tokenCount: allTokens.length,
      postAdversativeClauses: postAdvCount,
      ordinaryClauses: ordCount
    };
  }

  function buildEmptySignals16() {
    return {
      sig_adversative_ratio: 0,
      sig_negated_positive: 0,
      sig_negated_sleep_energy: 0,
      sig_double_negation: 0,
      sig_exhaustion_limit: 0,
      sig_intensifiers: 0,
      sig_ironic_quotes: 0,
      sig_ironic_exclamation: 0,
      sig_idiom_mental_load: 0,
      sig_idiom_burnout: 0,
      sig_sleep_deficit_phrases: 0,
      sig_somatic_strain: 0,
      sig_social_support_positive: 0,
      sig_agency_progress: 0,
      sig_intra_note_contradiction: 0,
      sig_self_report_gap: 0
    };
  }

  function buildZeroRawLogits() {
    return {
      valencia: { muy_negativo: 0, negativo: 0, neutro: 0, positivo: 0, muy_positivo: 0 },
      activacion: { agotamiento_baja: 0, calma_estable: 0, tension_alta: 0, entusiasmo_alta: 0 },
      emocion: { alegria: 0, calma: 0, estres: 0, tristeza: 0, frustracion: 0, ansiedad: 0, gratitud: 0, apatia: 0 },
      ejes: {
        trabajo_estudio: 0,
        descanso_sueno: 0,
        relaciones_familia: 0,
        salud_cuerpo: 0,
        carga_mental: 0
      },
      senales: {
        desgaste_sostenido: 0,
        contradiccion_emocional: 0,
        riesgo_autolesion_purga: 0
      }
    };
  }

  return {
    WEIGHT_ORDINARY,
    WEIGHT_POST_ADVERSATIVE,
    NEGATION_WINDOW,
    fold,
    stripSafeMetaphors,
    segmentClauses,
    extract,
    buildEmptySignals16,
    buildZeroRawLogits
  };
});
