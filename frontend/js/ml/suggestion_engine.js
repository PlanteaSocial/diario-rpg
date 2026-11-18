/**
 * Motor Vectorial de Crónicas y Sugerencias Sin Repetición (< 60 KB, < 1 ms).
 *
 * Sustituye plantillas rígidas con un banco curado en español neutro (segunda persona,
 * sin género asumido, lenguaje cotidiano no clínico usando solo "señal", "patrón", "sugerencia").
 *
 * Selección por tarjeta:
 *   Score_i = G_i * ( Affinity(v10, target_i) - MMR_HLR_Penalty(i, history_14d) )
 * donde:
 *   - G_i ∈ {0, 1}: compuerta dura (seguridad crisis, coherencia de sueño >= 7h, carga, etc.).
 *   - v10 ∈ [0, 1]^10: [valencia, agotamiento, tension, trabajo_estudio, descanso_sueno,
 *                       relaciones_familia, salud_cuerpo, carga_mental, desgaste, deficit_sueno].
 *   - Decaimiento HLR: 2^(-Δt / h) con h = 7 días en ventana de 14 días.
 *   - Slot-filling determinista: inyecta {horas_sueno}, {eje_top_1}, {micro_accion}, etc.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SuggestionEngine = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HLR_HALF_LIFE_DAYS = 7.0;
  const HISTORY_WINDOW_DAYS = 14.0;
  const MMR_LAMBDA = 0.55;

  const AXIS_LABELS_ES = {
    trabajo_estudio: "trabajo y estudio",
    descanso_sueno: "descanso y sueño",
    relaciones_familia: "vínculos y convivencia",
    salud_cuerpo: "salud y cuerpo",
    carga_mental: "carga mental"
  };

  const EMOTION_LABELS_ES = {
    alegria: "alegría",
    calma: "calma",
    estres: "estrés",
    tristeza: "tristeza",
    frustracion: "frustración",
    ansiedad: "inquietud",
    gratitud: "gratitud",
    apatia: "desgano"
  };

  // Verificación de lenguaje no clínico ni con género asumido.
  const FORBIDDEN_PATTERNS = [
    /\btrastorno\b/i,
    /\bpatolog[ií]a\b/i,
    /\bs[ií]ndrome\b/i,
    /\bdepresi[oó]n\b/i,
    /\bdiagn[oó]stic\w*/i,
    /\bterap[eé]utic\w*/i,
    /\bpsiqui[aá]tric\w*/i,
    /\bcontigo mism[ao]\b/i,
    /\ba ti mism[ao]\b/i,
    /\bpara ti mism[ao]\b/i,
    /\b(?:estas|est[aá]s|sientes|sentirte)\s+(?:cansad[ao]|agotad[ao]|abrumad[ao]|estresad[ao]|ocupad[ao]|sol[ao])\b/i
  ];

  // Banco curado de micro-acciones concretas (<= 3 min, sin género, no clínicas).
  const MICRO_ACTIONS = {
    carga_mental: [
      { id: "act_volcar_3", text: "anotar en una lista breve los 3 pendientes reales de mañana y cerrar los demás por hoy" },
      { id: "act_pausa_90s", text: "apartar la vista de la pantalla durante 90 segundos y soltar los hombros" },
      { id: "act_regla_5m", text: "elegir un solo pendiente pequeño y dedicarle apenas 5 minutos sin buscar perfección" },
      { id: "act_cerrar_pestanas", text: "dejar por escrito lo que ronda tu cabeza en 'Apuntes rápidos' antes de descansar" }
    ],
    pausa_desgaste: [
      { id: "act_bajar_ritmo", text: "recortar hoy una exigencia secundaria y concederte media hora sin pantallas ni reloj" },
      { id: "act_agua_quietud", text: "tomar un vaso de agua con calma y sentarte en silencio durante 3 minutos" },
      { id: "act_cero_pendientes", text: "posponer para otro día lo que no sea urgente y priorizar una cena ligera y descanso" }
    ],
    sueno_deficit: [
      { id: "act_cierre_30m", text: "fijar una alarma amable de cierre de pantallas 30 minutos antes de dormir" },
      { id: "act_luz_tenue", text: "bajar la intensidad de las luces una hora antes de acostarte para facilitar el descanso" },
      { id: "act_libreta_noche", text: "dejar fuera de la cama el teléfono y anotar un pendiente en papel para no cargarlo al dormir" }
    ],
    tension_laboral: [
      { id: "act_resp_46", text: "hacer 4 ciclos de inhalar en 4 segundos y soltar el aire lento en 6 segundos" },
      { id: "act_limite_cierre", text: "marcar una hora de cierre explícita hoy y dejar de revisar mensajes laborales después" },
      { id: "act_cambio_espacio", text: "levantarte 5 minutos de tu lugar habitual y caminar un poco para cortar la inercia" }
    ],
    emocion_dificil: [
      { id: "act_gesto_amable", text: "hablarte con la misma paciencia que tendrías con una amistad cercana en un día difícil" },
      { id: "act_anclaje_54321", text: "nombrar en voz baja 3 cosas que ves y 2 sonidos a tu alrededor para anclarte al presente" },
      { id: "act_escribir_suelto", text: "soltar en tres líneas sin editar lo que más pesó hoy para sacarlo de la cabeza" }
    ],
    cuerpo_salud: [
      { id: "act_estirar_cuello", text: "girar suave el cuello, estirar la espalda y tomar un vaso de agua fresca" },
      { id: "act_camina_10m", text: "regalarte 10 minutos de caminata tranquila o movimiento ligero sin audífonos" },
      { id: "act_comida_calma", text: "dedicar unos minutos a hidratarte y hacer una comida sin revisar notificaciones" }
    ],
    equilibrio_positivo: [
      { id: "act_guardar_momento", text: "anotar en una línea qué factor concreto ayudó hoy a sostener ese equilibrio" },
      { id: "act_mantener_ritmo", text: "conservar el mismo ritual sencillo de cierre que funcionó hoy" },
      { id: "act_agradecer_breve", text: "reconocer un avance cotidiano del día sin minimizarlo ni correr hacia lo siguiente" }
    ]
  };

  /**
   * Banco curado de crónicas y micro-sugerencias.
   * targetVec10 = [valencia, agotamiento, tension, trabajo_estudio, descanso_sueno,
   *                relaciones_familia, salud_cuerpo, carga_mental, desgaste, deficit_sueno]
   */
  const CARD_BANK = [
    // ==================== CONTENCIÓN (SOLO ALERTA ROJA) ====================
    {
      id: "cont_refugio_presente",
      theme: "contencion",
      scope: "both",
      requireAlert: true,
      dailyTitle: "Espacio de acompañamiento",
      dailyChronicle: "Tus palabras de hoy traen una señal de dolor intenso. En este momento no hace falta resolver pendientes ni exigirte respuestas rápidas.",
      dailySuggestion: "Sugerencia: quédate en un lugar seguro y considera contactar ahora mismo con una de las líneas de apoyo disponibles en pantalla o con alguien de tu confianza.",
      periodText: "Tu registro reciente refleja una señal de dolor profundo. Lo prioritario ahora es tu cuidado inmediato y contar con compañía real; utiliza las líneas de apoyo mostradas arriba si lo necesitas.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.1, 0.7, 0.6, 0.2, 0.3, 0.3, 0.3, 0.6, 0.9, 0.4]
    },
    {
      id: "cont_paso_acompanado",
      theme: "contencion",
      scope: "both",
      requireAlert: true,
      dailyTitle: "No atravieses esto en soledad",
      dailyChronicle: "Se percibe una carga emocional muy alta en lo que compartiste hoy. Tu bienestar es lo primero por encima de cualquier tarea.",
      dailySuggestion: "Sugerencia: acércate a una persona de confianza o marca a la Línea de la Vida (800 911 2000) para conversar con escucha respetuosa y confidencial.",
      periodText: "En los escritos recientes aparece una señal de alarma emocional que merece atención cálida y directa. Permítete recibir apoyo humano a través de los contactos confidenciales disponibles.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.08, 0.75, 0.65, 0.2, 0.3, 0.35, 0.35, 0.6, 0.92, 0.4]
    },
    {
      id: "cont_pausa_segura",
      theme: "contencion",
      scope: "both",
      requireAlert: true,
      dailyTitle: "Prioridad: tu resguardo hoy",
      dailyChronicle: "El texto muestra señales delicadas de sufrimiento en este momento. Respira despacio y deja a un lado cualquier presión cotidiana.",
      dailySuggestion: "Sugerencia: comunica cómo te sientes a alguien cercano o usa los canales gratuitos de apoyo mostrados arriba.",
      periodText: "Tus últimos registros concentran señales de sobrecarga severa. Hoy la única prioridad es tu resguardo y pedir escucha acompañada en los canales mostrados arriba.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.12, 0.68, 0.6, 0.2, 0.25, 0.3, 0.4, 0.55, 0.88, 0.35]
    },

    // ==================== PAUSA SUAVE / DESGASTE SOSTENIDO ====================
    {
      id: "pausa_descarga_real",
      theme: "pausa_desgaste",
      scope: "both",
      forbidAlert: true,
      minWear: 0.55,
      dailyTitle: "Patrón de desgaste acumulado",
      dailyChronicle: "Hoy aparece una señal clara de agotamiento en torno a {eje_top_1}, tras dormir {horas_sueno}. No todo requiere solución inmediata.",
      dailySuggestion: "Sugerencia: concede valor a una pausa real hoy; podrías {micro_accion}.",
      periodText: "En los últimos {total_dias} días se observa un patrón de desgaste sostenido ligado a {eje_top_1} (sueño medio {sueno_medio}, carga {carga}). Sugerencia: bajar exigencias no esenciales esta semana y {micro_accion}.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.22, 0.9, 0.45, 0.55, 0.45, 0.15, 0.45, 0.78, 0.92, 0.35]
    },
    {
      id: "pausa_bateria_reserva",
      theme: "pausa_desgaste",
      scope: "both",
      forbidAlert: true,
      minWear: 0.45,
      dailyTitle: "Señal de reserva baja",
      dailyChronicle: "Tu escrito describe un cansancio profundo y la sensación de avanzar en reserva frente a {eje_top_1}. Reconocer ese límite ya es un paso útil.",
      dailySuggestion: "Sugerencia: cuida tu ritmo antes de forzarte de más; intenta {micro_accion}.",
      periodText: "El periodo muestra señales recurrentes de fatiga emocional (ánimo medio {valencia_media}) y peso en {eje_top_1}. Sugerencia: proteger espacios de recuperación sin culpa y {micro_accion}.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.25, 0.88, 0.4, 0.4, 0.35, 0.2, 0.5, 0.7, 0.85, 0.25]
    },
    {
      id: "pausa_trewa_suave",
      theme: "pausa_desgaste",
      scope: "daily",
      forbidAlert: true,
      minWear: 0.5,
      dailyTitle: "Permiso para soltar el ritmo",
      dailyChronicle: "Con {horas_sueno} de descanso y señales intensas de agotamiento en {eje_top_1}, el cuerpo pide menos fricción y más tregua.",
      dailySuggestion: "Sugerencia: por hoy basta con sostener lo mínimo indispensable y {micro_accion}.",
      actionPool: "pausa_desgaste",
      targetVec10: [0.24, 0.86, 0.35, 0.45, 0.4, 0.15, 0.4, 0.65, 0.88, 0.3]
    },

    // ==================== CARGA MENTAL & PILOTO AUTOMÁTICO ====================
    {
      id: "carga_piloto_automatico",
      theme: "carga_mental",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Señal de piloto automático",
      dailyChronicle: "Tu registro refleja varias demandas abiertas a la vez alrededor de {eje_top_1}, con tono de {emocion_top} aunque hayas dormido {horas_sueno}.",
      dailySuggestion: "Sugerencia: saca el ruido de la mente hacia el papel; puede ayudarte {micro_accion}.",
      periodText: "Durante el periodo de {total_dias} días destaca un patrón de carga mental alta en torno a {eje_top_1}, con {emocion_top} como tono frecuente y sueño medio de {sueno_medio}. Sugerencia: {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.3, 0.62, 0.72, 0.7, 0.2, 0.15, 0.2, 0.92, 0.6, 0.15]
    },
    {
      id: "carga_lista_eterna",
      theme: "carga_mental",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Saturación de pendientes",
      dailyChronicle: "Aparece un patrón de lista interminable en {eje_top_1} que consume atención incluso en los momentos libres.",
      dailySuggestion: "Sugerencia: acota el foco a una sola cosa manejable hoy y prueba {micro_accion}.",
      periodText: "Tus entradas muestran una saturación cognitiva constante (carga {carga}) alrededor de {eje_top_1}.{cruce_meta} Sugerencia: reducir las tareas simultáneas y {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.32, 0.5, 0.82, 0.85, 0.15, 0.1, 0.15, 0.9, 0.52, 0.1]
    },
    {
      id: "carga_ruido_cognitivo",
      theme: "carga_mental",
      scope: "daily",
      forbidAlert: true,
      dailyTitle: "Espacio para despejar la cabeza",
      dailyChronicle: "Hoy predominó la sensación de llevar demasiadas pestañas abiertas en {eje_top_1} (descanso registrado: {horas_sueno}).",
      dailySuggestion: "Sugerencia: libera memoria de trabajo antes de descansar; te vendrá bien {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.35, 0.55, 0.68, 0.6, 0.2, 0.2, 0.25, 0.86, 0.48, 0.1]
    },
    {
      id: "carga_descanso_ok_pero_saturado",
      theme: "carga_mental",
      scope: "daily",
      forbidAlert: true,
      minSleepHours: 7.0,
      dailyTitle: "Sobrecarga mental con buen sueño",
      dailyChronicle: "Aunque descansaste {horas_sueno}, tu mente cargó bastante fricción en {eje_top_1}; la fatiga de hoy viene más del ruido mental que de falta de horas de cama.",
      dailySuggestion: "Sugerencia: no compensas el desgaste mental solo durmiendo; prueba ahora {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.33, 0.58, 0.65, 0.72, 0.12, 0.15, 0.2, 0.88, 0.5, 0.0]
    },

    // ==================== DÉFICIT DE SUEÑO (SOLO SI SUEÑO < 7.0h) ====================
    {
      id: "sueno_corto_presion",
      theme: "sueno_deficit",
      scope: "both",
      forbidAlert: true,
      requiresSleepDeficit: true,
      dailyTitle: "Señal de descanso insuficiente",
      dailyChronicle: "Registraste {horas_sueno} de descanso hoy, un margen corto que suele amplificar el peso de {eje_top_1} y la sensación de {emocion_top}.",
      dailySuggestion: "Sugerencia: prioriza proteger tu noche desde temprano; intenta {micro_accion}.",
      periodText: "En este tramo ({total_dias} días) el promedio de sueño bajó a {sueno_medio} frente a una carga de {carga}, acentuando señales de {emocion_top}.{cruce_meta} Sugerencia: {micro_accion}.",
      actionPool: "sueno_deficit",
      targetVec10: [0.32, 0.82, 0.48, 0.45, 0.92, 0.15, 0.35, 0.55, 0.62, 0.9]
    },
    {
      id: "sueno_desvelo_energia",
      theme: "sueno_deficit",
      scope: "daily",
      forbidAlert: true,
      requiresSleepDeficit: true,
      dailyTitle: "Impacto del desvelo en el ánimo",
      dailyChronicle: "Con apenas {horas_sueno} de sueño, es natural que hoy sientas menor reserva de energía frente a {eje_top_1}.",
      dailySuggestion: "Sugerencia: evita compensar el desvelo con sobreexigencia; esta noche conviene {micro_accion}.",
      actionPool: "sueno_deficit",
      targetVec10: [0.34, 0.84, 0.38, 0.35, 0.9, 0.15, 0.4, 0.48, 0.55, 0.88]
    },
    {
      id: "sueno_corte_nocturno",
      theme: "sueno_deficit",
      scope: "both",
      forbidAlert: true,
      requiresSleepDeficit: true,
      dailyTitle: "Cuidar la transición nocturna",
      dailyChronicle: "Tu texto menciona el cansancio del descanso corto ({horas_sueno}) mezclado con demandas de {eje_top_1}.",
      dailySuggestion: "Sugerencia: prepara una bajada gradual antes de acostarte; prueba {micro_accion}.",
      periodText: "Se aprecia una relación directa entre menor descanso ({sueno_medio}) y mayor vulnerabilidad ante {eje_top_1}.{cruce_meta} Sugerencia: cuidar el cierre nocturno y {micro_accion}.",
      actionPool: "sueno_deficit",
      targetVec10: [0.36, 0.72, 0.55, 0.5, 0.88, 0.15, 0.3, 0.62, 0.5, 0.84]
    },

    // ==================== TENSIÓN LABORAL / LÍMITES ====================
    {
      id: "tension_demanda_alta",
      theme: "tension_laboral",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Patrón de presión en la rutina",
      dailyChronicle: "Tu escrito concentra señales de exigencia y prisa alrededor de {eje_top_1}, con {emocion_top} en primer plano.",
      dailySuggestion: "Sugerencia: separa tu valía personal de la urgencia externa y busca {micro_accion}.",
      periodText: "En los {total_dias} días revisados predomina la exigencia vinculada a {eje_top_1} (carga media {carga}, sueño {sueno_medio}).{cruce_meta} Sugerencia: fortalecer tus límites de cierre y {micro_accion}.",
      actionPool: "tension_laboral",
      targetVec10: [0.34, 0.4, 0.88, 0.9, 0.25, 0.15, 0.25, 0.72, 0.45, 0.2]
    },
    {
      id: "tension_limites_jornada",
      theme: "tension_laboral",
      scope: "daily",
      forbidAlert: true,
      minWorkload: 4,
      dailyTitle: "Jornada exigente en límites",
      dailyChronicle: "Con una carga elevada ({carga}) enfocada en {eje_top_1}, el día dejó poca holgura para respirar entre actividades.",
      dailySuggestion: "Sugerencia: protege el cierre de tu jornada con un gesto concreto: {micro_accion}.",
      actionPool: "tension_laboral",
      targetVec10: [0.36, 0.45, 0.85, 0.88, 0.25, 0.15, 0.25, 0.68, 0.42, 0.2]
    },
    {
      id: "tension_calma_fisiologica",
      theme: "tension_laboral",
      scope: "daily",
      forbidAlert: true,
      dailyTitle: "Aflojar la aceleración del día",
      dailyChronicle: "Se nota aceleración y foco de {emocion_top} en {eje_top_1} a pesar de haber dormido {horas_sueno}.",
      dailySuggestion: "Sugerencia: dale una señal física de calma a tu cuerpo antes de seguir: procura {micro_accion}.",
      actionPool: "tension_laboral",
      targetVec10: [0.38, 0.32, 0.84, 0.75, 0.2, 0.2, 0.3, 0.65, 0.38, 0.15]
    },

    // ==================== CONTRADICCIÓN / DISCREPANCIA SUAVE ====================
    {
      id: "disc_enmascaramiento",
      theme: "discrepancia_coherencia",
      scope: "daily",
      forbidAlert: true,
      requiresDiscrepancyOrContradiction: true,
      dailyTitle: "Emociones encontradas en el día",
      dailyChronicle: "En tus líneas conviven partes de aparente calma con señales claras de malestar o carga alrededor de {eje_top_1}. Es común minimizar el peso para seguir funcionando.",
      dailySuggestion: "Sugerencia: validar ambas caras sin juzgarte ayuda a aclarar el panorama; podrías {micro_accion}.",
      actionPool: "emocion_dificil",
      targetVec10: [0.32, 0.58, 0.62, 0.55, 0.25, 0.25, 0.2, 0.72, 0.55, 0.2]
    },
    {
      id: "disc_ironia_o_giro",
      theme: "discrepancia_coherencia",
      scope: "daily",
      forbidAlert: true,
      requiresDiscrepancyOrContradiction: true,
      dailyTitle: "Lo que pesa detrás del 'todo bien'",
      dailyChronicle: "Tu texto arranca restando importancia, pero hacia el cierre asoma con claridad la fricción real de {emocion_top} en {eje_top_1}.",
      dailySuggestion: "Sugerencia: escucha esa segunda voz honesta de tu escrito y date espacio para {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.3, 0.6, 0.65, 0.6, 0.2, 0.2, 0.2, 0.78, 0.6, 0.15]
    },

    // ==================== EMOCIONES DIFÍCILES (TRISTEZA / FRUSTRACIÓN / ANSIEDAD) ====================
    {
      id: "emo_tristeza_acompanada",
      theme: "emocion_dificil",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Espacio sereno para un día gris",
      dailyChronicle: "Hoy predomina una señal de {emocion_top} en torno a {eje_top_1} (sueño: {horas_sueno}). No hace falta forzar entusiasmo cuando el día pesó.",
      dailySuggestion: "Sugerencia: trata este momento con suavidad; puede ayudar {micro_accion}.",
      periodText: "En los últimos {total_dias} días el ánimo promedio ({valencia_media}) ha tendido a la introspección con matices de {emocion_top} alrededor de {eje_top_1}. Sugerencia: evitar la autoexigencia dura y {micro_accion}.",
      actionPool: "emocion_dificil",
      targetVec10: [0.22, 0.72, 0.35, 0.25, 0.35, 0.45, 0.3, 0.45, 0.62, 0.25]
    },
    {
      id: "emo_frustracion_soltar",
      theme: "emocion_dificil",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Descargar fricción sin rumiar",
      dailyChronicle: "Aparecen señales de {emocion_top} frente a obstáculos en {eje_top_1}. Escribirlo aquí evita que siga rebotando dentro.",
      dailySuggestion: "Sugerencia: separa lo que depende de ti de lo que no, y prueba {micro_accion}.",
      periodText: "Se detecta un patrón de {emocion_top} vinculado a {eje_top_1} (carga {carga}).{cruce_meta} Sugerencia: pausar antes de reaccionar en caliente y {micro_accion}.",
      actionPool: "emocion_dificil",
      targetVec10: [0.28, 0.35, 0.78, 0.65, 0.2, 0.4, 0.2, 0.62, 0.42, 0.2]
    },
    {
      id: "emo_ansiedad_anclaje",
      theme: "emocion_dificil",
      scope: "daily",
      forbidAlert: true,
      dailyTitle: "Volver del futuro al minuto presente",
      dailyChronicle: "La nota refleja anticipación e inquietud frente a {eje_top_1}, con descanso registrado de {horas_sueno}.",
      dailySuggestion: "Sugerencia: reduce el horizonte solo a lo inmediato de hoy y prueba {micro_accion}.",
      actionPool: "emocion_dificil",
      targetVec10: [0.3, 0.35, 0.85, 0.55, 0.3, 0.25, 0.3, 0.7, 0.45, 0.2]
    },
    {
      id: "emo_apatia_paso_minimo",
      theme: "apatia_arranque",
      scope: "daily",
      forbidAlert: true,
      dailyTitle: "Desgano sin juicio ni prisa",
      dailyChronicle: "Se percibe falta de impulso o monotonía en torno a {eje_top_1} tras dormir {horas_sueno}. No todo avance exige mucha energía.",
      dailySuggestion: "Sugerencia: sustituye las metas grandes por un gesto minúsculo hoy: {micro_accion}.",
      actionPool: "carga_mental",
      targetVec10: [0.32, 0.78, 0.25, 0.35, 0.3, 0.2, 0.25, 0.65, 0.65, 0.2]
    },

    // ==================== CUERPO Y SALUD ====================
    {
      id: "cuerpo_tension_fisica",
      theme: "cuerpo_salud",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Señal corporal de atención",
      dailyChronicle: "Tu escrito menciona sensaciones físicas o cuidado corporal ligadas a {eje_top_1} (sueño: {horas_sueno}). El cuerpo suele avisar antes que la mente.",
      dailySuggestion: "Sugerencia: atiende lo básico de hidratación y postura; hoy conviene {micro_accion}.",
      periodText: "Las notas de estos {total_dias} días incluyen señales físicas asociadas a {eje_top_1} con descanso medio de {sueno_medio}. Sugerencia: integrar micro-pausas corporales y {micro_accion}.",
      actionPool: "cuerpo_salud",
      targetVec10: [0.38, 0.62, 0.52, 0.35, 0.35, 0.2, 0.88, 0.42, 0.45, 0.25]
    },
    {
      id: "cuerpo_energia_cuidada",
      theme: "cuerpo_salud",
      scope: "daily",
      forbidAlert: true,
      minSleepHours: 7.0,
      dailyTitle: "Cuidado físico con buen descanso",
      dailyChronicle: "Dormiste {horas_sueno} y dedicaste atención a {eje_top_1}. Sostener esos hábitos físicos amortigua la carga de la semana.",
      dailySuggestion: "Sugerencia: mantén esa base corporal amable y aprovecha para {micro_accion}.",
      actionPool: "cuerpo_salud",
      targetVec10: [0.68, 0.25, 0.28, 0.25, 0.2, 0.25, 0.86, 0.2, 0.15, 0.0]
    },

    // ==================== VÍNCULOS Y CONVIVENCIA ====================
    {
      id: "vinculos_presencia",
      theme: "vinculos_cuidado",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Peso en relaciones y convivencia",
      dailyChronicle: "El eje que más resalta hoy es {eje_top_1}, dejando huella en tu tono emocional ({emocion_top}).",
      dailySuggestion: "Sugerencia: distingue qué conversación vale tener con calma y prueba {micro_accion}.",
      periodText: "Durante estos {total_dias} días el tema de {eje_top_1} tuvo un papel central junto con {emocion_top} y descanso de {sueno_medio}. Sugerencia: cuidar tus espacios de diálogo y {micro_accion}.",
      actionPool: "emocion_dificil",
      targetVec10: [0.55, 0.3, 0.45, 0.2, 0.2, 0.9, 0.2, 0.35, 0.25, 0.15]
    },
    {
      id: "vinculos_sosten",
      theme: "vinculos_cuidado",
      scope: "daily",
      forbidAlert: true,
      dailyTitle: "Compañía que amortigua el día",
      dailyChronicle: "Compartir tiempo con personas cercanas en {eje_top_1} ayudó a dar respiro a la jornada (descanso: {horas_sueno}).",
      dailySuggestion: "Sugerencia: ten presente qué vínculos te recargan y procura {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.78, 0.18, 0.2, 0.2, 0.2, 0.92, 0.25, 0.15, 0.1, 0.05]
    },

    // ==================== EQUILIBRIO Y DÍAS NEUTROS ====================
    {
      id: "neutro_ritmo_estable",
      theme: "equilibrio_neutro",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Día cotidiano y estable",
      dailyChronicle: "Tus palabras muestran una jornada ordinaria sin picos bruscos alrededor de {eje_top_1}, con {horas_sueno} de sueño.",
      dailySuggestion: "Sugerencia: la estabilidad tranquila también cuenta; basta con {micro_accion}.",
      periodText: "En los {total_dias} días evaluados se observa un patrón estable (ánimo medio {valencia_media}, sueño {sueno_medio}, carga {carga}) con foco en {eje_top_1}.{cruce_meta} Sugerencia: mantener tu racha actual y {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.54, 0.25, 0.28, 0.45, 0.25, 0.25, 0.25, 0.25, 0.12, 0.1]
    },
    {
      id: "neutro_constancia_silenciosa",
      theme: "equilibrio_neutro",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Constancia en lo cotidiano",
      dailyChronicle: "Aunque el día fue rutinario alrededor de {eje_top_1} ({emocion_top}), tomarte unos minutos para registrar tu estado fortalece tu línea base.",
      dailySuggestion: "Sugerencia: conserva ese ritmo sin añadir presión extra; puedes {micro_accion}.",
      periodText: "Tus registros de {total_dias} días mantienen continuidad ({racha}) con predominio de {emocion_top} y descanso medio de {sueno_medio}. Sugerencia: {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.52, 0.28, 0.3, 0.35, 0.2, 0.2, 0.2, 0.28, 0.15, 0.1]
    },
    {
      id: "neutro_cierre_ordenado",
      theme: "equilibrio_neutro",
      scope: "daily",
      forbidAlert: true,
      minSleepHours: 7.0,
      dailyTitle: "Balance entre rutina y descanso",
      dailyChronicle: "Con {horas_sueno} de sueño y actividad moderada en {eje_top_1}, hoy se percibe un tono sereno y manejable.",
      dailySuggestion: "Sugerencia: aprovecha la calma del día para {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.58, 0.2, 0.22, 0.4, 0.2, 0.2, 0.2, 0.22, 0.1, 0.0]
    },

    // ==================== POSITIVO, GRATITUD Y LOGROS ====================
    {
      id: "pos_logro_disfrute",
      theme: "positivo_gratitud",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Tono constructivo y avance",
      dailyChronicle: "Se nota satisfacción y claridad en tu escrito de hoy alrededor de {eje_top_1}, acompañado de {horas_sueno} de descanso.",
      dailySuggestion: "Sugerencia: registra qué permitió que hoy fluyera así; te ayudará {micro_accion}.",
      periodText: "El periodo de {total_dias} días destaca por un patrón positivo (ánimo medio {valencia_media}) y buen balance frente a {eje_top_1} (sueño {sueno_medio}).{cruce_meta} Sugerencia: {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.88, 0.1, 0.18, 0.55, 0.2, 0.35, 0.3, 0.18, 0.06, 0.05]
    },
    {
      id: "pos_gratitud_calma",
      theme: "positivo_gratitud",
      scope: "both",
      forbidAlert: true,
      dailyTitle: "Gratitud y aire fresco",
      dailyChronicle: "Tus palabras transmiten {emocion_top} genuina en torno a {eje_top_1}. Celebrar días amables equilibra los momentos más exigentes.",
      dailySuggestion: "Sugerencia: disfruta el cierre del día sin apresurarte y prueba {micro_accion}.",
      periodText: "Tus entradas recientes reflejan calma y gratitud ({emocion_top}) con un descanso medio de {sueno_medio} y racha de {racha}.{cruce_meta} Sugerencia: {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.92, 0.1, 0.12, 0.25, 0.35, 0.55, 0.35, 0.12, 0.05, 0.05]
    },
    {
      id: "pos_descanso_reparador",
      theme: "positivo_gratitud",
      scope: "daily",
      forbidAlert: true,
      minSleepHours: 7.0,
      dailyTitle: "Descanso que sostiene tu energía",
      dailyChronicle: "Las {horas_sueno} de descanso se reflejan en un tono más ligero y optimista frente a {eje_top_1}.",
      dailySuggestion: "Sugerencia: protege la rutina nocturna que hizo posible este respiro; puedes {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.85, 0.08, 0.15, 0.35, 0.65, 0.25, 0.35, 0.15, 0.05, 0.0]
    },
    {
      id: "pos_racha_constancia",
      theme: "positivo_gratitud",
      scope: "period",
      forbidAlert: true,
      minStreak: 3,
      periodText: "Sostienes una racha de {racha} observando tus patrones con {emocion_top} dominante y sueño medio de {sueno_medio} frente a {eje_top_1}.{cruce_meta} Sugerencia: {micro_accion}.",
      actionPool: "equilibrio_positivo",
      targetVec10: [0.8, 0.15, 0.22, 0.4, 0.3, 0.3, 0.25, 0.22, 0.08, 0.08]
    }
  ];

  function clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  /**
   * Construye el vector de 10 dimensiones del día o periodo:
   * [valencia, agotamiento, tension, trabajo_estudio, descanso_sueno,
   *  relaciones_familia, salud_cuerpo, carga_mental, desgaste, deficit_sueno]
   */
  function buildVector10({
    valenciaScore = 3.0,
    activacionProbs = {},
    ejes = {},
    senales = {},
    sleepHours = 7.5
  } = {}) {
    const valencia = clamp01((Number(valenciaScore) - 1.0) / 4.0);
    const agotamiento = clamp01(activacionProbs.agotamiento_baja || 0);
    const tension = clamp01(activacionProbs.tension_alta || 0);
    const trabajo = clamp01(ejes.trabajo_estudio || 0);
    const descanso = clamp01(ejes.descanso_sueno || 0);
    const relaciones = clamp01(ejes.relaciones_familia || 0);
    const salud = clamp01(ejes.salud_cuerpo || 0);
    const cargaMental = clamp01(ejes.carga_mental || 0);
    const desgaste = clamp01(senales.desgaste_sostenido || 0);
    const deficitSueno = clamp01(Math.max(0, 7.0 - Number(sleepHours || 7.5)) / 2.5);

    return [
      valencia,
      agotamiento,
      tension,
      trabajo,
      descanso,
      relaciones,
      salud,
      cargaMental,
      desgaste,
      deficitSueno
    ].map((x) => Number(x.toFixed(4)));
  }

  function cosineSimilarity(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na <= 1e-12 || nb <= 1e-12) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Afinidad combinada con foco en distancia ponderada sobre las 10 dimensiones + coseno centrado.
   */
  function computeAffinity(dayVec10, cardVec10) {
    const weights = [2.2, 1.35, 1.35, 1.0, 1.15, 1.0, 1.0, 1.4, 1.6, 1.4];
    let wSum = 0;
    let dist2 = 0;
    for (let i = 0; i < 10; i++) {
      const w = weights[i];
      const diff = (dayVec10[i] || 0) - (cardVec10[i] || 0);
      dist2 += w * diff * diff;
      wSum += w;
    }
    const normDist2 = dist2 / wSum;
    const distScore = Math.exp(-4.2 * normDist2);

    // Similitud bipolar en valencia centrada (-1..+1) más ejes activos (dims 1..9)
    const dCentered = [(dayVec10[0] - 0.5) * 2, ...dayVec10.slice(1)];
    const cCentered = [(cardVec10[0] - 0.5) * 2, ...cardVec10.slice(1)];
    const cos01 = clamp01(0.5 + 0.5 * cosineSimilarity(dCentered, cCentered));

    return Number((0.68 * distScore + 0.32 * cos01).toFixed(4));
  }

  /**
   * Compuerta dura G_i ∈ {0, 1}: prohíbe incoherencias antes de puntuar.
   */
  function passesHardGate(card, ctx) {
    const scope = ctx.scope || "daily";
    if (card.scope !== "both" && card.scope !== scope) return false;

    const isAlert = ctx.safetyLevel === "alert";
    if (isAlert) {
      return Boolean(card.requireAlert);
    }
    if (card.requireAlert) return false;

    const sleep = Number(ctx.sleepHours ?? 7.5);
    if (card.requiresSleepDeficit && sleep >= 7.0) return false;
    if (typeof card.minSleepHours === "number" && sleep < card.minSleepHours) return false;

    if (typeof card.minWorkload === "number" && Number(ctx.workload ?? 3) < card.minWorkload) {
      return false;
    }
    if (typeof card.minWear === "number" && Number(ctx.wearProb ?? 0) < card.minWear) {
      return false;
    }
    if (typeof card.minStreak === "number" && Number(ctx.streak ?? 1) < card.minStreak) {
      return false;
    }
    if (card.requiresDiscrepancyOrContradiction) {
      const hasDisc = Boolean(ctx.hasDiscrepancy) || Number(ctx.contradictionProb ?? 0) >= 0.45;
      if (!hasDisc) return false;
    }

    return true;
  }

  /**
   * Penalización MMR + decaimiento HLR: 2^(-Δt / 7) sobre historial de últimos 14 días.
   */
  function computeMmrHlrPenalty(card, history = [], nowMs = Date.now()) {
    let maxExact = 0;
    let maxRedundancy = 0;

    for (const item of history || []) {
      if (!item || !item.id) continue;
      const shownMs = Date.parse(item.shown_at || item.date || "");
      if (!Number.isFinite(shownMs)) continue;
      const deltaDays = Math.max(0, (nowMs - shownMs) / 86400000);
      if (deltaDays > HISTORY_WINDOW_DAYS) continue;

      const decay = Math.pow(2.0, -deltaDays / HLR_HALF_LIFE_DAYS);

      if (item.id === card.id) {
        maxExact = Math.max(maxExact, decay);
      }

      const simVec = Array.isArray(item.vec10) && item.vec10.length === 10
        ? Math.max(0, cosineSimilarity(card.targetVec10, item.vec10))
        : 0.4;
      const sim = item.theme && item.theme === card.theme
        ? Math.max(0.45, simVec * 0.55)
        : simVec * 0.35;

      maxRedundancy = Math.max(maxRedundancy, decay * sim);
    }

    const exactPenalty = maxExact * 0.95;
    const mmrPenalty = MMR_LAMBDA * maxRedundancy;
    return {
      total: Number((exactPenalty + mmrPenalty).toFixed(4)),
      exactPenalty: Number(exactPenalty.toFixed(4)),
      mmrPenalty: Number(mmrPenalty.toFixed(4))
    };
  }

  function pickMicroAction(poolName, history = [], nowMs = Date.now()) {
    const pool = MICRO_ACTIONS[poolName] || MICRO_ACTIONS.equilibrio_positivo;
    const recentActionDecay = {};
    for (const h of history || []) {
      if (!h || !h.action_id) continue;
      const shownMs = Date.parse(h.shown_at || h.date || "");
      if (!Number.isFinite(shownMs)) continue;
      const deltaDays = Math.max(0, (nowMs - shownMs) / 86400000);
      if (deltaDays > HISTORY_WINDOW_DAYS) continue;
      const decay = Math.pow(2.0, -deltaDays / HLR_HALF_LIFE_DAYS);
      recentActionDecay[h.action_id] = Math.max(recentActionDecay[h.action_id] || 0, decay);
    }

    let bestAct = pool[0];
    let bestPen = Infinity;
    for (const act of pool) {
      const pen = recentActionDecay[act.id] || 0;
      if (pen < bestPen - 1e-6) {
        bestPen = pen;
        bestAct = act;
      }
    }
    return bestAct;
  }

  function formatHours(h) {
    const num = Number(h ?? 7.5);
    return Number.isInteger(num) ? `${num}h` : `${num.toFixed(1)}h`;
  }

  function renderSlots(template, slots) {
    return String(template || "")
      .replace(/\{([a-z0-9_]+)\}/gi, (_, key) => (slots[key] !== undefined ? String(slots[key]) : ""))
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,;!?])/g, "$1")
      .trim();
  }

  /**
   * Comprueba que la salida cumpla estrictamente lenguaje neutro (tú, sin género, cero términos clínicos).
   */
  function isNeutralNonClinical(text) {
    const s = String(text || "");
    return !FORBIDDEN_PATTERNS.some((pat) => pat.test(s));
  }

  function resolveTopAxisKey(ejes = {}) {
    let topKey = "carga_mental";
    let topVal = -1;
    for (const [k, v] of Object.entries(ejes || {})) {
      if (Number(v) > topVal) {
        topVal = Number(v);
        topKey = k;
      }
    }
    return topKey;
  }

  /**
   * Selecciona la mejor crónica y micro-sugerencia para un día individual (pestaña Hoy).
   */
  function selectDailyReflection({
    date,
    layaProfile,
    questionnaire = {},
    safety = {},
    discrepancy = {},
    goalAlignment = null,
    history = [],
    nowIso = null
  } = {}) {
    const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    const sleepHours = Number(questionnaire.sleep_hours ?? 7.5);
    const workload = Number(questionnaire.workload_rating ?? 3);
    const safetyLevel = safety.level || "safe";
    const ejes = (layaProfile && layaProfile.ejes_tematicos) || {};
    const senales = (layaProfile && layaProfile.senales_alerta) || {};
    const actProbs = (layaProfile && layaProfile.activacion_energia && layaProfile.activacion_energia.probabilities) || {};
    const valScore = layaProfile ? Number(layaProfile.valencia_score_estimada) : Number(questionnaire.valence_rating || 3);
    const emoKey = (layaProfile && layaProfile.emocion_primaria && layaProfile.emocion_primaria.choice) || "calma";

    const vec10 = buildVector10({
      valenciaScore: valScore,
      activacionProbs: actProbs,
      ejes,
      senales,
      sleepHours
    });

    const ctx = {
      scope: "daily",
      safetyLevel,
      sleepHours,
      workload,
      wearProb: Number(senales.desgaste_sostenido || 0),
      contradictionProb: Number(senales.contradiccion_emocional || 0),
      hasDiscrepancy: Boolean(discrepancy && discrepancy.has_discrepancy),
      streak: 1
    };

    const scored = [];
    for (const card of CARD_BANK) {
      if (!passesHardGate(card, ctx)) continue;
      const affinity = computeAffinity(vec10, card.targetVec10);
      const pen = computeMmrHlrPenalty(card, history, safeNowMs);
      const finalScore = Number((affinity - pen.total).toFixed(4));
      scored.push({ card, affinity, penalty: pen, finalScore });
    }

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const chosen = scored[0] || {
      card: CARD_BANK.find((c) => c.id === "neutro_ritmo_estable"),
      affinity: 0.5,
      penalty: { total: 0, exactPenalty: 0, mmrPenalty: 0 },
      finalScore: 0.5
    };

    const action = pickMicroAction(chosen.card.actionPool, history, safeNowMs);
    const topAxisKey = resolveTopAxisKey(ejes);
    const slots = {
      horas_sueno: formatHours(sleepHours),
      eje_top_1: AXIS_LABELS_ES[topAxisKey] || "tu rutina",
      emocion_top: EMOTION_LABELS_ES[emoKey] || emoKey,
      carga: `${workload}/5`,
      micro_accion: action.text
    };

    const chronicle = renderSlots(chosen.card.dailyChronicle, slots);
    const suggestion = renderSlots(chosen.card.dailySuggestion, slots);

    return {
      card_id: chosen.card.id,
      theme: chosen.card.theme,
      title: chosen.card.dailyTitle || "Crónica del día",
      chronicle,
      suggestion,
      action_id: action.id,
      safety_locked: safetyLevel === "alert",
      slots_used: slots,
      vec10,
      scoring: {
        affinity: chosen.affinity,
        penalty: chosen.penalty.total,
        final_score: chosen.finalScore,
        candidates_passed_gate: scored.length
      },
      history_record: {
        id: chosen.card.id,
        theme: chosen.card.theme,
        action_id: action.id,
        scope: "daily",
        date: date || new Date(safeNowMs).toISOString().slice(0, 10),
        shown_at: new Date(safeNowMs).toISOString(),
        vec10
      }
    };
  }

  /**
   * Selecciona la mejor crónica del periodo (pestaña Patrones) sin repetir sugerencias recientes.
   */
  function selectPeriodChronicle({
    stats = {},
    entries = [],
    history = [],
    nowIso = null
  } = {}) {
    const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    // Revisar si la entrada más reciente disparó alerta roja de seguridad.
    const latestEntry = entries && entries.length ? entries[0] : null;
    const latestAlert = Boolean(latestEntry && latestEntry.safety && latestEntry.safety.level === "alert");

    // Promediar ejes y activación reales del periodo.
    const avgEjes = { trabajo_estudio: 0, descanso_sueno: 0, relaciones_familia: 0, salud_cuerpo: 0, carga_mental: 0 };
    const avgAct = { agotamiento_baja: 0, calma_estable: 0, tension_alta: 0, entusiasmo_alta: 0 };
    let maxDesgaste = 0;
    let avgDesgaste = 0;
    let avgContra = 0;
    let countProf = 0;

    for (const e of entries || []) {
      const lp = e.laya_profile;
      if (!lp) continue;
      countProf += 1;
      for (const k of Object.keys(avgEjes)) {
        avgEjes[k] += Number((lp.ejes_tematicos && lp.ejes_tematicos[k]) || 0);
      }
      const ap = (lp.activacion_energia && lp.activacion_energia.probabilities) || {};
      for (const k of Object.keys(avgAct)) {
        avgAct[k] += Number(ap[k] || 0);
      }
      const d = Number((lp.senales_alerta && lp.senales_alerta.desgaste_sostenido) || 0);
      avgDesgaste += d;
      if (d > maxDesgaste) maxDesgaste = d;
      avgContra += Number((lp.senales_alerta && lp.senales_alerta.contradiccion_emocional) || 0);
    }

    if (countProf > 0) {
      for (const k of Object.keys(avgEjes)) avgEjes[k] /= countProf;
      for (const k of Object.keys(avgAct)) avgAct[k] /= countProf;
      avgDesgaste /= countProf;
      avgContra /= countProf;
    }

    const suenoMedio = Number(stats.sueno_medio ?? 7.5);
    const valMedia = Number(stats.valencia_media ?? 3.0);
    const cargaMedia = Number(stats.carga_media ?? 3.0);
    const racha = Number(stats.racha ?? 1);
    const totalDias = Number(stats.total_dias ?? (entries ? entries.length : 0));

    const vec10 = buildVector10({
      valenciaScore: valMedia,
      activacionProbs: avgAct,
      ejes: avgEjes,
      senales: { desgaste_sostenido: Math.max(avgDesgaste, maxDesgaste * 0.75) },
      sleepHours: suenoMedio
    });

    const ctx = {
      scope: "period",
      safetyLevel: latestAlert ? "alert" : "safe",
      sleepHours: suenoMedio,
      workload: cargaMedia,
      wearProb: Math.max(avgDesgaste, maxDesgaste * 0.8),
      contradictionProb: avgContra,
      hasDiscrepancy: (entries || []).some((e) => e.discrepancy && e.discrepancy.has_discrepancy),
      streak: racha
    };

    const scored = [];
    for (const card of CARD_BANK) {
      if (!passesHardGate(card, ctx)) continue;
      const affinity = computeAffinity(vec10, card.targetVec10);
      const pen = computeMmrHlrPenalty(card, history, safeNowMs);
      const finalScore = Number((affinity - pen.total).toFixed(4));
      scored.push({ card, affinity, penalty: pen, finalScore });
    }

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const chosen = scored[0] || {
      card: CARD_BANK.find((c) => c.id === "neutro_ritmo_estable"),
      affinity: 0.5,
      penalty: { total: 0, exactPenalty: 0, mmrPenalty: 0 },
      finalScore: 0.5
    };

    const action = pickMicroAction(chosen.card.actionPool, history, safeNowMs);
    const topAxisArr = stats.ejes_principales && stats.ejes_principales.length ? stats.ejes_principales : [resolveTopAxisKey(avgEjes)];
    const topAxisKey = topAxisArr[0];
    const emoKey = stats.emocion_dominante || "calma";
    const cruces = stats.cruces_objetivos || [];
    const cruceSlot = cruces.length ? ` ${cruces[0]}` : "";

    const slots = {
      horas_sueno: formatHours(suenoMedio),
      sueno_medio: formatHours(suenoMedio),
      valencia_media: `${valMedia.toFixed(1)}/5`,
      carga: `${cargaMedia.toFixed(1)}/5`,
      eje_top_1: AXIS_LABELS_ES[topAxisKey] || String(topAxisKey).replace(/_/g, " "),
      emocion_top: EMOTION_LABELS_ES[emoKey] || emoKey,
      racha: racha === 1 ? "1 día" : `${racha} días`,
      total_dias: Math.max(1, totalDias),
      cruce_meta: cruceSlot,
      micro_accion: action.text
    };

    const summaryText = renderSlots(chosen.card.periodText, slots);

    return {
      card_id: chosen.card.id,
      theme: chosen.card.theme,
      summary_text: summaryText,
      generated_by: "Motor Vectorial Local (MMR + HLR en navegador)",
      action_id: action.id,
      vec10,
      scoring: {
        affinity: chosen.affinity,
        penalty: chosen.penalty.total,
        final_score: chosen.finalScore
      },
      history_record: {
        id: chosen.card.id,
        theme: chosen.card.theme,
        action_id: action.id,
        scope: "period",
        date: new Date(safeNowMs).toISOString().slice(0, 10),
        shown_at: new Date(safeNowMs).toISOString(),
        vec10
      }
    };
  }

  /**
   * Añade un registro al historial de sugerencias manteniendo máximo 14–30 días / 60 elementos.
   */
  function appendHistory(history = [], record, nowIso = null) {
    if (!record) return Array.isArray(history) ? history : [];
    const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const kept = (Array.isArray(history) ? history : []).filter((h) => {
      const t = Date.parse((h && (h.shown_at || h.date)) || "");
      return Number.isFinite(t) && (safeNowMs - t) / 86400000 <= 30;
    });
    return [record, ...kept].slice(0, 60);
  }

  return {
    HLR_HALF_LIFE_DAYS,
    HISTORY_WINDOW_DAYS,
    MMR_LAMBDA,
    CARD_BANK,
    MICRO_ACTIONS,
    buildVector10,
    cosineSimilarity,
    computeAffinity,
    passesHardGate,
    computeMmrHlrPenalty,
    isNeutralNonClinical,
    selectDailyReflection,
    selectPeriodChronicle,
    appendHistory
  };
});
