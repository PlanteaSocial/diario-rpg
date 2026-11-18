/**
 * Backend en la Nube 100% Serverless para Diario RPG (Firebase Spark + E2EE).
 *
 * - Autenticación: Firebase Auth (Google Sign-In y Correo/Contraseña).
 * - Persistencia: Cloud Firestore en `/diario_users/{uid}/...` con persistencia offline.
 * - Privacidad Zero-Knowledge: todos los escritos, notas rápidas, perfil, compañero,
 *   retos y progreso de Aprender se cifran en el navegador con AES-256-GCM antes de
 *   enviarse a Firestore.
 */

const FirebaseBackend = {
  SDK_VERSION: "13.3.0",
  app: null,
  auth: null,
  db: null,
  sdkPromise: null,

  user: null,
  dekKey: null,
  vaultMeta: null,
  vaultCreatedAt: null,

  _staticLearning: null,
  _staticGlossary: null,
  _vaultCache: { profile: null, learning: null, assessments: null },
  _daysCache: new Map(),
  _allDaysLoaded: false,
  _lastDevTrace: null,

  hasConfig() {
    const cfg = window.DIARIO_RPG_FIREBASE_CONFIG;
    if (!cfg || typeof cfg !== "object") return false;
    return ["apiKey", "authDomain", "projectId", "appId"].every((k) => {
      const v = String(cfg[k] || "").trim();
      return v.length > 0 && !v.startsWith("REEMPLAZAR_") && !v.includes("TU_PROYECTO");
    });
  },

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-fb-src="${src}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.dataset.fbSrc = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
      document.head.appendChild(s);
    });
  },

  async ensureInitialized() {
    if (this.auth && this.db) return;
    if (!this.hasConfig()) {
      throw new Error("Falta configuración de Firebase en js/firebase-config.js.");
    }
    if (!this.sdkPromise) {
      const base = `https://www.gstatic.com/firebasejs/${this.SDK_VERSION}`;
      this.sdkPromise = (async () => {
        if (!window.firebase || !window.firebase.apps) {
          await this._loadScript(`${base}/firebase-app-compat.js`);
        }
        if (!window.firebase.auth) {
          await this._loadScript(`${base}/firebase-auth-compat.js`);
        }
        if (!window.firebase.firestore) {
          await this._loadScript(`${base}/firebase-firestore-compat.js`);
        }
        if (!window.firebase.apps.length) {
          this.app = window.firebase.initializeApp(window.DIARIO_RPG_FIREBASE_CONFIG);
        } else {
          this.app = window.firebase.app();
        }
        this.auth = window.firebase.auth();
        this.db = window.firebase.firestore();
        try {
          await this.db.enablePersistence({ synchronizeTabs: true });
        } catch (err) {
          // Ignorar si ya estaba habilitada o en modo incógnito
        }
      })();
    }
    await this.sdkPromise;
  },

  async waitForAuthUser() {
    await this.ensureInitialized();
    return new Promise((resolve) => {
      const unsub = this.auth.onAuthStateChanged((u) => {
        unsub();
        this.user = u || null;
        resolve(this.user);
      });
    });
  },

  formatPublicUser(fbUser) {
    if (!fbUser) return null;
    const email = fbUser.email || "";
    const handle = email ? email.split("@")[0] : fbUser.uid.slice(0, 10);
    return {
      id: fbUser.uid,
      uid: fbUser.uid,
      email,
      username: handle,
      display_name: fbUser.displayName || handle || "Aventurero",
      photo_url: fbUser.photoURL || null,
      provider: (fbUser.providerData && fbUser.providerData[0]?.providerId) || "firebase",
      role: "user",
      is_active: true,
      must_change_password: false
    };
  },

  async loginWithGoogle() {
    await this.ensureInitialized();
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      const res = await this.auth.signInWithPopup(provider);
      this.user = res.user;
      return this.formatPublicUser(this.user);
    } catch (err) {
      if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
        await this.auth.signInWithRedirect(provider);
        return null;
      }
      throw this._friendlyAuthError(err);
    }
  },

  async checkRedirectResult() {
    await this.ensureInitialized();
    try {
      const res = await this.auth.getRedirectResult();
      if (res && res.user) {
        this.user = res.user;
      }
    } catch (err) {
      throw this._friendlyAuthError(err);
    }
  },

  async loginWithEmail(email, password) {
    await this.ensureInitialized();
    try {
      const res = await this.auth.signInWithEmailAndPassword(String(email || "").trim(), password);
      this.user = res.user;
      return this.formatPublicUser(this.user);
    } catch (err) {
      throw this._friendlyAuthError(err);
    }
  },

  async registerWithEmail(displayName, email, password) {
    await this.ensureInitialized();
    try {
      const res = await this.auth.createUserWithEmailAndPassword(String(email || "").trim(), password);
      if (res.user && displayName) {
        await res.user.updateProfile({ displayName: displayName.trim() });
      }
      this.user = this.auth.currentUser || res.user;
      return this.formatPublicUser(this.user);
    } catch (err) {
      throw this._friendlyAuthError(err);
    }
  },

  async sendPasswordReset(email) {
    await this.ensureInitialized();
    const clean = String(email || "").trim();
    if (!clean) throw new Error("Ingresa tu correo electrónico primero.");
    try {
      await this.auth.sendPasswordResetEmail(clean);
      return { ok: true };
    } catch (err) {
      throw this._friendlyAuthError(err);
    }
  },

  _friendlyAuthError(err) {
    const code = err && err.code ? err.code : "";
    const map = {
      "auth/invalid-email": "El correo electrónico no es válido.",
      "auth/user-disabled": "Esta cuenta está deshabilitada.",
      "auth/user-not-found": "Correo o contraseña incorrectos.",
      "auth/wrong-password": "Correo o contraseña incorrectos.",
      "auth/invalid-credential": "Correo o contraseña incorrectos.",
      "auth/email-already-in-use": "Ya existe una cuenta registrada con ese correo.",
      "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
      "auth/popup-closed-by-user": "Se cerró la ventana de Google antes de completar el acceso.",
      "auth/cancelled-popup-request": "Acceso cancelado.",
      "auth/unauthorized-domain": "Dominio no autorizado en Firebase Auth."
    };
    return new Error(map[code] || err?.message || "No se pudo autenticar con Firebase.");
  },

  clearMemoryVault() {
    this.dekKey = null;
    this.vaultMeta = null;
    this.vaultCreatedAt = null;
    this._vaultCache = { profile: null, learning: null, assessments: null };
    this._daysCache = new Map();
    this._allDaysLoaded = false;
    this._lastDevTrace = null;
  },

  async logout() {
    this.clearMemoryVault();
    this.user = null;
    if (this.auth) {
      await this.auth.signOut();
    }
    return { ok: true };
  },

  _uid() {
    const u = this.user || (this.auth && this.auth.currentUser);
    if (!u) throw new Error("Sesión requerida.");
    this.user = u;
    return u.uid;
  },

  _requireUnlocked() {
    const uid = this._uid();
    if (!this.dekKey) {
      const err = new Error("Tu bóveda cifrada está bloqueada.");
      err.status = 401;
      throw err;
    }
    return uid;
  },

  _userDocRef(uid) {
    return this.db.collection("diario_users").doc(uid);
  },

  _vaultDocRef(uid, docId) {
    return this._userDocRef(uid).collection("vault").doc(docId);
  },

  _dayDocRef(uid, dateStr) {
    return this._userDocRef(uid).collection("days").doc(dateStr);
  },

  async inspectVault() {
    const uid = this._uid();
    const snap = await this._userDocRef(uid).get();
    if (!snap.exists) {
      this.vaultMeta = null;
      this.vaultCreatedAt = null;
      return { hasVault: false, unlocked: false };
    }
    const data = snap.data() || {};
    this.vaultMeta = data.vaultMeta || null;
    this.vaultCreatedAt = data.createdAt || null;
    return {
      hasVault: Boolean(this.vaultMeta),
      unlocked: Boolean(this.dekKey)
    };
  },

  async createVault(passphrase) {
    const uid = this._uid();
    const now = new Date().toISOString();
    const { dekKey, recoveryKey, vaultMeta } = await VaultCrypto.createVault(uid, passphrase);
    await this._userDocRef(uid).set({
      schemaVersion: 1,
      vaultMeta,
      createdAt: now,
      updatedAt: now
    });
    this.dekKey = dekKey;
    this.vaultMeta = vaultMeta;
    this.vaultCreatedAt = now;

    // Inicializar perfil por defecto cifrado
    const defaultProfile = this._defaultProfile(uid, now);
    await this._writeVaultDoc("profile", defaultProfile);
    await this._writeVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] });
    await this._writeVaultDoc("assessments", []);

    return { recoveryKey };
  },

  async unlockVault(passphrase) {
    const uid = this._uid();
    if (!this.vaultMeta) await this.inspectVault();
    if (!this.vaultMeta) throw new Error("Esta cuenta aún no tiene bóveda creada.");
    const dekKey = await VaultCrypto.unlockWithPassphrase(uid, this.vaultMeta, passphrase);
    this.dekKey = dekKey;
    // Verificar también que el perfil descifra sin errores si existe
    await this._readVaultDoc("profile", null);
    return { unlocked: true };
  },

  async unlockVaultWithRecovery(recoveryKey) {
    const uid = this._uid();
    if (!this.vaultMeta) await this.inspectVault();
    const candidateKey = await VaultCrypto.unlockWithRecoveryKey(recoveryKey);
    const snap = await this._vaultDocRef(uid, "profile").get();
    if (snap.exists) {
      try {
        const profile = await VaultCrypto.decryptJson(candidateKey, snap.data(), `${uid}:vault:profile`);
        this._vaultCache.profile = profile;
      } catch {
        throw new Error("La llave de recuperación no corresponde a esta cuenta.");
      }
    }
    this.dekKey = candidateKey;
    return { unlocked: true };
  },

  async rewrapVaultPassphrase(currentOrRecovery, newPassphrase, usingRecovery = false) {
    const uid = this._uid();
    if (!this.vaultMeta || !this.vaultCreatedAt) await this.inspectVault();
    const { dekKey, vaultMeta } = await VaultCrypto.rewrapPassphrase(
      uid,
      this.vaultMeta,
      currentOrRecovery,
      newPassphrase,
      usingRecovery
    );
    const now = new Date().toISOString();
    await this._userDocRef(uid).set({
      schemaVersion: 1,
      vaultMeta,
      createdAt: this.vaultCreatedAt || now,
      updatedAt: now
    });
    this.dekKey = dekKey;
    this.vaultMeta = vaultMeta;
    return { ok: true };
  },

  async exportRecoveryKey(passphrase) {
    const uid = this._uid();
    if (!this.vaultMeta) await this.inspectVault();
    return VaultCrypto.exportRecoveryWithPassphrase(uid, this.vaultMeta, passphrase);
  },

  _defaultProfile(uid, now = new Date().toISOString()) {
    return {
      id: uid,
      morning_habit: "cafe",
      habits_to_improve: [],
      sleep_improvement_goal: "dormir_mas_horas",
      stress_areas: [],
      personal_objective: "constancia",
      daily_goal_level: "normal",
      daily_goal_minutes: 10,
      theme_mode: localStorage.getItem("diario_theme") || "light",
      onboarding_completed: false,
      radar_focus: {
        Descanso: 60.0,
        "Límites": 60.0,
        "Carga mental": 60.0,
        Constancia: 60.0,
        "Manejo del estrés": 60.0
      },
      companion: {
        name: "Slime",
        variant: "slime_azul",
        unlocked_variants: ["slime_azul"],
        level: 1,
        exp: 20,
        next_level_exp: 100,
        coins: 35,
        bond: 68,
        satiety: 55,
        energy: 75,
        mood: 72,
        pantry: { te_tibio: 1, galleta_miel: 1 },
        last_snack_at: null
      },
      created_at: now,
      updated_at: now
    };
  },

  async _readVaultDoc(docId, fallbackValue) {
    const uid = this._requireUnlocked();
    if (this._vaultCache[docId] !== null && this._vaultCache[docId] !== undefined) {
      return this._vaultCache[docId];
    }
    const snap = await this._vaultDocRef(uid, docId).get();
    if (!snap.exists) {
      this._vaultCache[docId] = fallbackValue;
      return fallbackValue;
    }
    const decrypted = await VaultCrypto.decryptJson(
      this.dekKey,
      snap.data(),
      `${uid}:vault:${docId}`
    );
    this._vaultCache[docId] = decrypted;
    return decrypted;
  },

  async _writeVaultDoc(docId, payloadObj) {
    const uid = this._requireUnlocked();
    const env = await VaultCrypto.encryptJson(this.dekKey, payloadObj, `${uid}:vault:${docId}`);
    await this._vaultDocRef(uid, docId).set({
      ...env,
      updatedAt: new Date().toISOString()
    });
    this._vaultCache[docId] = payloadObj;
    return payloadObj;
  },

  async _readDayBundle(dateStr) {
    const uid = this._requireUnlocked();
    if (this._daysCache.has(dateStr)) {
      return this._daysCache.get(dateStr);
    }
    const snap = await this._dayDocRef(uid, dateStr).get();
    if (!snap.exists) {
      const empty = { quick_notes: [], entry: null };
      this._daysCache.set(dateStr, empty);
      return empty;
    }
    const bundle = await VaultCrypto.decryptJson(
      this.dekKey,
      snap.data(),
      `${uid}:day:${dateStr}`
    );
    const normalized = {
      quick_notes: Array.isArray(bundle.quick_notes) ? bundle.quick_notes : [],
      entry: bundle.entry || null
    };
    this._daysCache.set(dateStr, normalized);
    return normalized;
  },

  async _writeDayBundle(dateStr, bundle) {
    const uid = this._requireUnlocked();
    const env = await VaultCrypto.encryptJson(this.dekKey, bundle, `${uid}:day:${dateStr}`);
    await this._dayDocRef(uid, dateStr).set({
      ...env,
      date: dateStr,
      updatedAt: new Date().toISOString()
    });
    this._daysCache.set(dateStr, bundle);
    return bundle;
  },

  async _loadAllDays(limit = 365) {
    const uid = this._requireUnlocked();
    if (this._allDaysLoaded && limit <= 365) {
      return Array.from(this._daysCache.values())
        .filter((b) => Boolean(b.entry))
        .map((b) => ({ ...b.entry, quick_notes: b.quick_notes || [] }))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
    }
    const snap = await this._userDocRef(uid)
      .collection("days")
      .orderBy("date", "desc")
      .limit(Math.min(Math.max(1, limit), 500))
      .get();

    const entries = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const dateStr = data.date || docSnap.id;
      const bundle = await VaultCrypto.decryptJson(
        this.dekKey,
        data,
        `${uid}:day:${dateStr}`
      );
      const normalized = {
        quick_notes: Array.isArray(bundle.quick_notes) ? bundle.quick_notes : [],
        entry: bundle.entry || null
      };
      this._daysCache.set(dateStr, normalized);
      if (normalized.entry) {
        entries.push({ ...normalized.entry, quick_notes: normalized.quick_notes });
      }
    }
    if (snap.docs.length < Math.min(Math.max(1, limit), 500)) {
      this._allDaysLoaded = true;
    }
    return entries.sort((a, b) => b.date.localeCompare(a.date));
  },

  async _loadStaticLearningData() {
    if (!this._staticLearning) {
      const res = await fetch("data/learning_tracks.json");
      if (!res.ok) throw new Error("No se pudieron cargar las rutas de Aprender.");
      this._staticLearning = await res.json();
    }
    if (!this._staticGlossary) {
      const res = await fetch("data/glossary_terms.json");
      if (!res.ok) throw new Error("No se pudo cargar el glosario de Aprender.");
      this._staticGlossary = await res.json();
    }
    return { tracks: this._staticLearning, glossary: this._staticGlossary };
  },

  _findLesson(tracksPayload, lessonId) {
    for (const track of tracksPayload.tracks || []) {
      for (const lesson of track.lessons || []) {
        if (lesson.id === lessonId) {
          return { ...lesson, track_title: track.title || "", track_id: track.id || "" };
        }
      }
    }
    return null;
  },

  /* ============================================================================
   * Métodos equivalentes a la API REST (consumidos por API.*)
   * ============================================================================ */

  async getStatus() {
    return {
      status: "online",
      timestamp: new Date().toISOString(),
      database: "Cloud Firestore (E2EE AES-256-GCM)",
      laya_model: "Motor Sintáctico 16 Señales + Calibración Local (Navegador)",
      ollama_qwen: "Motor Vectorial de Crónicas MMR+HLR (Zero-Knowledge)",
      classifier: "laya-syntax-calibrada-js (100% cliente)",
      platform: "Firebase Hosting · Plan Spark"
    };
  },

  async getNetworkInfo() {
    const url = window.location.origin;
    return {
      port: window.location.port || "443",
      preferred: "cloud",
      options: [
        {
          id: "cloud",
          label: "Web Cifrada",
          ip: window.location.host,
          url,
          hint: "Abre este enlace en cualquier navegador e inicia sesión con tu cuenta y frase de bóveda.",
          svg: `<div style="padding:1rem;font-size:0.85rem;color:var(--text-secondary);">Comparte o guarda esta URL:<br><strong>${API.escapeHtml(url)}</strong></div>`
        }
      ]
    };
  },

  async getQuickNotes(date) {
    const bundle = await this._readDayBundle(date);
    return bundle.quick_notes || [];
  },

  async createQuickNote(date, time, text) {
    const clean = String(text || "").trim();
    if (!clean) throw new Error("La nota rápida no puede estar vacía.");
    const bundle = await this._readDayBundle(date);
    const now = new Date().toISOString();
    const note = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      date,
      time,
      text: clean,
      created_at: now
    };
    bundle.quick_notes.push(note);
    await this._writeDayBundle(date, bundle);

    const profile = await this._getOrInitProfile();
    profile.companion = ClientEngine.applyCompanionReward(profile.companion, { expGain: 5, coinsGain: 2 });
    profile.updated_at = now;
    await this._writeVaultDoc("profile", profile);
    return note;
  },

  async getDayEntry(date) {
    const bundle = await this._readDayBundle(date);
    if (!bundle.entry) return null;
    return { ...bundle.entry, quick_notes: bundle.quick_notes || [] };
  },

  async saveDayEntry(payload) {
    const bundle = await this._readDayBundle(payload.date);
    const q = { ...(payload.questionnaire || {}) };
    q.sleep_hours = ClientEngine.calculateSleepHours(q.sleep_bedtime, q.sleep_wakeup);
    q.food_routine = q.food_routine || "si";
    q.self_report_word = q.self_report_word || "bien";
    q.valence_rating = Number(q.valence_rating || 3);
    q.energy_rating = Number(q.energy_rating || 3);
    q.workload_rating = Number(q.workload_rating || 3);

    const quickTexts = (bundle.quick_notes || []).map((qn) => `[${qn.time}] ${qn.text}`);
    const parts = [];
    if ((payload.day_text || "").trim()) parts.push(payload.day_text.trim());
    if (quickTexts.length) parts.push("Notas rápidas del día:\n" + quickTexts.join("\n"));
    const fullText = parts.join("\n\n");

    const recentEntries = await this._loadAllDays(14);
    const priorDesgasteSeries = recentEntries
      .filter((e) => e.date < payload.date && e.laya_profile && e.laya_profile.senales_alerta)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-3)
      .map((e) => Number(
        (e.laya_profile.raw_usage && e.laya_profile.raw_usage.p_desgaste_hoy !== undefined)
          ? e.laya_profile.raw_usage.p_desgaste_hoy
          : (e.laya_profile.senales_alerta.desgaste_sostenido || 0)
      ));

    const detailedTrace = fullText
      ? ClientEngine.classifyTextDetailed(fullText, { questionnaire: q, priorDesgasteSeries })
      : null;
    const layaProfile = detailedTrace ? detailedTrace.profile : null;
    if (layaProfile && detailedTrace.calibration_meta && detailedTrace.calibration_meta.desgaste_blend) {
      layaProfile.raw_usage = {
        ...(layaProfile.raw_usage || {}),
        p_desgaste_hoy: detailedTrace.calibration_meta.desgaste_blend.p_today
      };
    }

    const safety = ClientEngine.evaluateSafety(fullText, layaProfile ? layaProfile.senales_alerta : null, {
      questionnaire: q,
      priorDesgasteSeries
    });
    const discrepancy = ClientEngine.detectDiscrepancy(q, layaProfile);
    const userProfile = await this._getOrInitProfile();
    const goalAlignment = ClientEngine.evaluateDailyGoalAlignment(q, layaProfile, userProfile);

    const dailyReflection = ClientEngine.selectDailyReflection({
      date: payload.date,
      layaProfile,
      questionnaire: q,
      safety,
      discrepancy,
      goalAlignment,
      history: userProfile.suggestion_history || []
    });

    const now = new Date().toISOString();
    const existing = bundle.entry;
    const savedEntry = {
      id: existing ? existing.id : payload.date,
      date: payload.date,
      day_text: (payload.day_text || "").trim(),
      quick_notes: bundle.quick_notes || [],
      questionnaire: q,
      laya_profile: layaProfile,
      discrepancy,
      safety,
      goal_alignment: goalAlignment,
      daily_reflection: dailyReflection ? {
        card_id: dailyReflection.card_id,
        theme: dailyReflection.theme,
        title: dailyReflection.title,
        chronicle: dailyReflection.chronicle,
        suggestion: dailyReflection.suggestion,
        safety_locked: dailyReflection.safety_locked
      } : null,
      user_corrections: existing ? (existing.user_corrections || {}) : {},
      created_at: existing ? existing.created_at : now,
      updated_at: now
    };

    this._lastDevTrace = {
      timestamp: now,
      type: "day_entry_inference",
      date: payload.date,
      input_text: fullText,
      latency_ms: detailedTrace ? detailedTrace.latency_ms : 0.0,
      input_tokens: detailedTrace ? detailedTrace.input_tokens : 0,
      profile: layaProfile,
      raw_answers: detailedTrace ? detailedTrace.raw_answers : {},
      raw_usage: detailedTrace ? detailedTrace.raw_usage : {},
      valence_calculation: detailedTrace ? detailedTrace.valence_calculation : {},
      syntax_analysis: detailedTrace ? detailedTrace.syntax_analysis : null,
      calibration_meta: detailedTrace ? detailedTrace.calibration_meta : null,
      daily_reflection: dailyReflection,
      questions_schema: ClientEngine.LAYA_QUESTIONS
    };

    bundle.entry = savedEntry;
    await this._writeDayBundle(payload.date, bundle);

    const valScore = layaProfile ? layaProfile.valencia_score_estimada : Number(q.valence_rating);
    userProfile.companion = ClientEngine.applyCompanionReward(userProfile.companion, {
      expGain: 30,
      coinsGain: 12,
      sleepHours: q.sleep_hours,
      valenceScore: valScore
    });
    if (dailyReflection && dailyReflection.history_record && typeof SuggestionEngine !== "undefined") {
      userProfile.suggestion_history = SuggestionEngine.appendHistory(
        userProfile.suggestion_history || [],
        dailyReflection.history_record
      );
    }
    userProfile.updated_at = now;
    await this._writeVaultDoc("profile", userProfile);

    return savedEntry;
  },

  async getHistory(limit = 100) {
    return this._loadAllDays(limit);
  },

  async getPatterns(days = 0, { refresh = false } = {}) {
    const allEntries = await this._loadAllDays(365);
    const entries = ClientEngine.filterEntriesByPeriod(allEntries, days);
    const baseline = ClientEngine.computePersonalBaseline(entries);
    const timeSeries = ClientEngine.buildTimeSeries(entries);
    const moodDistribution = ClientEngine.computeMoodDistribution(entries);
    const layaAxesAvg = ClientEngine.computeLayaAxesAverages(entries);

    const userProfile = await this._getOrInitProfile();
    const assessments = await this._readVaultDoc("assessments", []);
    const personalRadar = ClientEngine.computeCombinedPersonalRadar(userProfile, assessments, allEntries);
    const goalCrossInsights = ClientEngine.computePeriodGoalCrossInsights(entries, userProfile);

    const ejeSums = {};
    const valences = [];
    const workloads = [];
    const sleeps = [];
    for (const e of entries) {
      workloads.push(e.questionnaire.workload_rating);
      sleeps.push(e.questionnaire.sleep_hours);
      if (e.laya_profile) {
        valences.push(e.laya_profile.valencia_score_estimada);
        for (const [eje, prob] of Object.entries(e.laya_profile.ejes_tematicos || {})) {
          ejeSums[eje] = (ejeSums[eje] || 0) + Number(prob);
        }
      }
    }
    const sortedEjes = Object.entries(ejeSums).sort((a, b) => b[1] - a[1]);
    const topEjes = sortedEjes.length ? sortedEjes.slice(0, 2).map(([k]) => k) : ["trabajo_estudio", "carga_mental"];

    const stats = {
      valencia_media: ClientEngine._round(baseline.avg_valence_laya, 2),
      energia_dominante: baseline.predominant_primary_emotion,
      sueno_medio: ClientEngine._round(baseline.avg_sleep_hours, 1),
      carga_media: ClientEngine._round(baseline.avg_workload, 1),
      emocion_dominante: baseline.predominant_primary_emotion,
      ejes_principales: topEjes,
      total_dias: baseline.total_days,
      racha: baseline.current_streak,
      valencia_min: valences.length ? ClientEngine._round(Math.min(...valences), 2) : 3.0,
      valencia_max: valences.length ? ClientEngine._round(Math.max(...valences), 2) : 3.0,
      carga_max: workloads.length ? Math.max(...workloads) : 3,
      sueno_min: sleeps.length ? ClientEngine._round(Math.min(...sleeps), 1) : 7.0,
      objetivo_personal: userProfile.personal_objective,
      habitos_cuidar: userProfile.habits_to_improve,
      cruces_objetivos: goalCrossInsights
    };

    const chronicle = ClientEngine.generatePeriodChronicle(stats, {
      entries,
      history: userProfile.suggestion_history || []
    });

    if (refresh && chronicle.history_record && typeof SuggestionEngine !== "undefined") {
      userProfile.suggestion_history = SuggestionEngine.appendHistory(
        userProfile.suggestion_history || [],
        chronicle.history_record
      );
      userProfile.updated_at = new Date().toISOString();
      await this._writeVaultDoc("profile", userProfile);
    }

    return {
      time_series: timeSeries,
      baseline,
      summary_text: chronicle.summary_text,
      generated_by: chronicle.generated_by,
      mood_distribution: moodDistribution,
      laya_axes_avg: layaAxesAvg,
      personal_radar: personalRadar,
      goal_cross_insights: goalCrossInsights,
      period_days: days
    };
  },

  async summarizePatterns(days = 0) {
    const res = await this.getPatterns(days, { refresh: true });
    return {
      summary_text: res.summary_text,
      generated_by: res.generated_by
    };
  },

  async _getOrInitProfile() {
    const uid = this._requireUnlocked();
    let prof = await this._readVaultDoc("profile", null);
    if (!prof) {
      prof = this._defaultProfile(uid);
      await this._writeVaultDoc("profile", prof);
    }
    return prof;
  },

  async getProfile() {
    const profile = await this._getOrInitProfile();
    const entries = await this._loadAllDays(100);
    const assessments = await this._readVaultDoc("assessments", []);
    const combinedRadar = ClientEngine.computeCombinedPersonalRadar(profile, assessments, entries);
    return {
      profile,
      personal_radar: combinedRadar,
      adventurer_title: ClientEngine.getAdventurerTitle(profile.companion.level),
      shop_items: Object.values(ClientEngine.COMPANION_SHOP_ITEMS)
    };
  },

  async saveProfile(profilePayload) {
    const existing = await this._getOrInitProfile();
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...profilePayload,
      id: existing.id,
      companion: existing.companion,
      daily_goal_minutes: ClientEngine.DAILY_GOAL_MINUTES_MAP[profilePayload.daily_goal_level] || 10,
      created_at: existing.created_at || now,
      updated_at: now
    };
    if (updated.onboarding_completed || !updated.radar_focus) {
      updated.radar_focus = ClientEngine.computeOnboardingRadar(updated);
    }
    await this._writeVaultDoc("profile", updated);
    const entries = await this._loadAllDays(100);
    const assessments = await this._readVaultDoc("assessments", []);
    return {
      profile: updated,
      personal_radar: ClientEngine.computeCombinedPersonalRadar(updated, assessments, entries),
      adventurer_title: ClientEngine.getAdventurerTitle(updated.companion.level)
    };
  },

  async getAssessments() {
    const profile = await this._getOrInitProfile();
    const entries = await this._loadAllDays(100);
    const history = await this._readVaultDoc("assessments", []);
    return {
      quizzes: Object.values(ClientEngine.SELF_ASSESSMENT_QUIZZES),
      history,
      personal_radar: ClientEngine.computeCombinedPersonalRadar(profile, history, entries)
    };
  },

  async submitAssessment(quizId, answers) {
    const evaluated = ClientEngine.evaluateSelfAssessment(quizId, answers);
    const now = new Date().toISOString();
    const saved = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: now,
      ...evaluated
    };
    const history = [...(await this._readVaultDoc("assessments", []))];
    history.unshift(saved);
    await this._writeVaultDoc("assessments", history.slice(0, 100));

    const profile = await this._getOrInitProfile();
    profile.companion = ClientEngine.applyCompanionReward(profile.companion, { expGain: 20, coinsGain: 8 });
    profile.updated_at = now;
    await this._writeVaultDoc("profile", profile);

    const entries = await this._loadAllDays(100);
    return {
      assessment: saved,
      personal_radar: ClientEngine.computeCombinedPersonalRadar(profile, history, entries),
      companion: profile.companion
    };
  },

  async getCompanion() {
    const profile = await this._getOrInitProfile();
    return {
      companion: profile.companion,
      adventurer_title: ClientEngine.getAdventurerTitle(profile.companion.level),
      shop_items: Object.values(ClientEngine.COMPANION_SHOP_ITEMS)
    };
  },

  async companionAction(action, value = null) {
    const profile = await this._getOrInitProfile();
    const res = ClientEngine.executeCompanionAction(profile.companion, action, value);
    profile.companion = res.companion;
    profile.updated_at = new Date().toISOString();
    await this._writeVaultDoc("profile", profile);
    return {
      companion: profile.companion,
      adventurer_title: ClientEngine.getAdventurerTitle(profile.companion.level),
      message: res.message
    };
  },

  async submitFeedback(date, _textSnippet, questionId, _originalValue, correctedValue) {
    const bundle = await this._readDayBundle(date);
    if (bundle.entry) {
      bundle.entry.user_corrections = bundle.entry.user_corrections || {};
      bundle.entry.user_corrections[questionId] = correctedValue;
      bundle.entry.updated_at = new Date().toISOString();
      await this._writeDayBundle(date, bundle);
    }
    return {
      status: "success",
      message: "Corrección guardada en tu bóveda cifrada.",
      updated_entry: bundle.entry ? { ...bundle.entry, quick_notes: bundle.quick_notes || [] } : null
    };
  },

  async getDevTrace() {
    return {
      active_laya_model: "laya-syntax-calibrada-js (navegador)",
      active_qwen_model: "motor vectorial MMR+HLR en JS",
      last_trace: this._lastDevTrace,
      system_schema: {
        questions: ClientEngine.LAYA_QUESTIONS,
        valence_weights: ClientEngine.VALENCE_WEIGHTS
      },
      questionnaire_weights_explanation: {
        sueno: { impacto: "Determinista", calculo: "Horas reales con cruce de medianoche.", rol: "Se cruza contra ánimo y meta de descanso." },
        alimentacion: { impacto: "Control de rutina", calculo: "Sí / No / A medias.", rol: "Regularidad de hábitos." },
        auto_reporte: { impacto: "Detector de coherencia", calculo: "Compara palabra vs valencia detectada.", umbral: "Alerta serena si P(negativo) >= 65%." }
      }
    };
  },

  async simulateLaya(text) {
    return ClientEngine.classifyTextDetailed(text);
  },

  async resetDatabase() {
    const uid = this._requireUnlocked();
    const snap = await this._userDocRef(uid).collection("days").get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = this.db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    this._daysCache.clear();
    this._allDaysLoaded = true;
    await this._writeVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] });
    await this._writeVaultDoc("assessments", []);
    const prof = await this._getOrInitProfile();
    if (prof.suggestion_history && prof.suggestion_history.length) {
      prof.suggestion_history = [];
      prof.updated_at = new Date().toISOString();
      await this._writeVaultDoc("profile", prof);
    }
    this._lastDevTrace = { timestamp: new Date().toISOString(), type: "database_reset", status: "clean", message: "Bóveda reiniciada." };
    return { status: "success", message: "Diario cifrado reiniciado." };
  },

  async simulateWeek() {
    const samples = [
      { offset: 6, quick: [["09:00", "Inicio de semana con café y revisión de objetivos."]], text: "Lunes productivo. Definimos objetivos con claridad. Me siento motivado.", bed: "23:00", wake: "07:00", food: "si", self: "bien", val: 4, ene: 4, work: 3 },
      { offset: 5, quick: [["14:30", "Pendientes principales listos antes de tiempo."]], text: "Martes de trabajo fluido. Me concentré muy bien y avancé bastante.", bed: "23:30", wake: "07:30", food: "si", self: "bien", val: 4, ene: 3, work: 3 },
      { offset: 4, quick: [["18:45", "Mucha presión de última hora."]], text: "Miércoles pesado con cambios de última hora y cansancio acumulado.", bed: "01:00", wake: "06:30", food: "a_medias", self: "mal", val: 2, ene: 4, work: 5 },
      { offset: 3, quick: [["13:00", "Comida tranquila para despejar la mente."]], text: "Jueves más tranquilo. Descansé un poco y recuperé la calma.", bed: "23:15", wake: "07:15", food: "si", self: "regular", val: 3, ene: 2, work: 3 },
      { offset: 2, quick: [["17:00", "Cerramos la semana a tiempo."]], text: "Viernes de éxito. Celebramos los avances y todo salió bien.", bed: "00:00", wake: "08:30", food: "si", self: "bien", val: 5, ene: 4, work: 4 },
      { offset: 1, quick: [["11:00", "Paseo tranquilo al aire libre."]], text: "Sábado relajante. Desconecté por completo y descansé muy bien.", bed: "23:30", wake: "08:30", food: "si", self: "bien", val: 5, ene: 3, work: 1 },
      { offset: 0, quick: [["10:30", "Mañana serena de domingo."]], text: "Domingo en paz. Ordené mis cosas y me siento tranquilo.", bed: "23:00", wake: "07:00", food: "si", self: "bien", val: 4, ene: 3, work: 2 }
    ];
    const now = new Date();
    const dates = [];
    for (const s of samples) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - s.offset);
      const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      for (const [t, txt] of s.quick) {
        await this.createQuickNote(dateStr, t, txt);
      }
      await this.saveDayEntry({
        date: dateStr,
        day_text: s.text,
        questionnaire: {
          sleep_bedtime: s.bed,
          sleep_wakeup: s.wake,
          food_routine: s.food,
          self_report_word: s.self,
          valence_rating: s.val,
          energy_rating: s.ene,
          workload_rating: s.work
        }
      });
      dates.push(dateStr);
    }
    return { status: "success", created_days: dates.length, dates, message: `Se simularon ${dates.length} días cifrados.` };
  },

  async getLearningState() {
    const { tracks, glossary } = await this._loadStaticLearningData();
    const learning = await this._readVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] });
    const entries = await this._loadAllDays(10);
    const profile = await this._getOrInitProfile();
    const state = ClientEngine.buildLearningState(
      tracks,
      learning.progress || {},
      learning.hlr || {},
      learning.notebook || [],
      entries
    );
    state.companion = profile.companion;
    state.adventurer_title = ClientEngine.getAdventurerTitle(profile.companion.level);
    state.glossary = glossary.terms || {};
    return state;
  },

  async getLearningLesson(lessonId) {
    const { tracks, glossary } = await this._loadStaticLearningData();
    const lesson = this._findLesson(tracks, lessonId);
    if (!lesson) throw new Error("Lección no encontrada");
    return { lesson, glossary: glossary.terms || {} };
  },

  async completeLesson(lessonId, accuracy) {
    const { tracks } = await this._loadStaticLearningData();
    const lesson = this._findLesson(tracks, lessonId);
    if (!lesson) throw new Error("Lección no encontrada");

    const learning = JSON.parse(JSON.stringify(
      await this._readVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] })
    ));
    learning.progress = learning.progress || {};
    learning.hlr = learning.hlr || {};
    learning.notebook = learning.notebook || [];

    const prev = learning.progress[lessonId] || null;
    const firstCompletion = !prev;
    const acc = ClientEngine._round(Number(accuracy), 1);
    const expGain = firstCompletion ? Number(lesson.exp || 25) : 10;
    const coinsGain = firstCompletion ? Number(lesson.coins || 8) : 3;
    const now = new Date().toISOString();

    const progress = {
      lesson_id: lessonId,
      track_id: lesson.track_id || "",
      completed_at: now,
      best_accuracy: prev ? Math.max(Number(prev.best_accuracy || 0), acc) : acc,
      attempts: prev ? Number(prev.attempts || 0) + 1 : 1,
      exp_earned: prev ? Number(prev.exp_earned || 0) + expGain : expGain
    };
    learning.progress[lessonId] = progress;

    const prevMem = learning.hlr[lessonId] || null;
    const curHalf = Number((prevMem && prevMem.half_life_days) || ClientEngine.DEFAULT_HALF_LIFE_DAYS);
    const nextHalf = acc >= 70 ? Math.min(curHalf * 2.0, ClientEngine.MAX_HALF_LIFE_DAYS) : curHalf;
    learning.hlr[lessonId] = { lesson_id: lessonId, half_life_days: nextHalf, last_reviewed_at: now };
    await this._writeVaultDoc("learning", learning);

    const profile = await this._getOrInitProfile();
    profile.companion = ClientEngine.applyCompanionReward(profile.companion, { expGain, coinsGain });
    profile.updated_at = now;
    await this._writeVaultDoc("profile", profile);

    const state = await this.getLearningState();
    let lessonState = null;
    for (const tr of state.tracks) {
      for (const node of tr.lessons) {
        if (node.id === lessonId) {
          lessonState = node;
          break;
        }
      }
      if (lessonState) break;
    }

    return {
      progress,
      hlr: lessonState,
      companion: profile.companion,
      adventurer_title: ClientEngine.getAdventurerTitle(profile.companion.level),
      exp_gain: expGain,
      coins_gain: coinsGain,
      first_completion: firstCompletion,
      state
    };
  },

  async saveNotebookEntry(lessonId, statementText, trackTitle = null) {
    const { tracks } = await this._loadStaticLearningData();
    const lesson = this._findLesson(tracks, lessonId);
    if (!lesson) throw new Error("Lección no encontrada");
    const learning = JSON.parse(JSON.stringify(
      await this._readVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] })
    ));
    learning.notebook = learning.notebook || [];
    const entry = {
      id: Date.now(),
      track_title: trackTitle || lesson.track_title || "Aprender",
      lesson_id: lessonId,
      statement_text: String(statementText || "").trim(),
      created_at: new Date().toISOString(),
      exported: 0
    };
    learning.notebook.unshift(entry);
    await this._writeVaultDoc("learning", learning);
    return { entry, notebook: learning.notebook };
  },

  async deleteNotebookEntry(entryId) {
    const learning = JSON.parse(JSON.stringify(
      await this._readVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] })
    ));
    const before = (learning.notebook || []).length;
    learning.notebook = (learning.notebook || []).filter((e) => String(e.id) !== String(entryId));
    if (learning.notebook.length === before) throw new Error("Apunte no encontrado");
    await this._writeVaultDoc("learning", learning);
    return { deleted: true, notebook: learning.notebook };
  },

  async exportBackupJson() {
    this._requireUnlocked();
    const profile = await this._getOrInitProfile();
    const learning = await this._readVaultDoc("learning", { progress: {}, hlr: {}, notebook: [] });
    const assessments = await this._readVaultDoc("assessments", []);
    await this._loadAllDays(500);
    const days = {};
    for (const [dateStr, bundle] of this._daysCache.entries()) {
      if ((bundle.quick_notes && bundle.quick_notes.length) || bundle.entry) {
        days[dateStr] = bundle;
      }
    }
    return {
      app: "Diario RPG",
      format: "diario-rpg-backup-v1",
      exported_at: new Date().toISOString(),
      profile,
      learning,
      assessments,
      days
    };
  },

  async importBackupJson(backup) {
    const uid = this._requireUnlocked();
    if (!backup || backup.format !== "diario-rpg-backup-v1") {
      throw new Error("El archivo no es un respaldo válido de Diario RPG.");
    }
    const now = new Date().toISOString();
    if (backup.profile) {
      const merged = { ...this._defaultProfile(uid, now), ...backup.profile, id: uid, updated_at: now };
      await this._writeVaultDoc("profile", merged);
    }
    if (backup.learning) {
      await this._writeVaultDoc("learning", backup.learning);
    }
    if (Array.isArray(backup.assessments)) {
      await this._writeVaultDoc("assessments", backup.assessments);
    }
    const dayEntries = Object.entries(backup.days || {});
    for (const [dateStr, bundle] of dayEntries) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && bundle) {
        await this._writeDayBundle(dateStr, {
          quick_notes: Array.isArray(bundle.quick_notes) ? bundle.quick_notes : [],
          entry: bundle.entry || null
        });
      }
    }
    this._allDaysLoaded = false;
    return { imported_days: dayEntries.length };
  }
};
