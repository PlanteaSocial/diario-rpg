/**
 * Coordinador en hilo principal del Web Worker semántico Tier 1 (ONNX INT8 en navegador).
 * - Solicita persistencia de almacenamiento (navigator.storage.persist()).
 * - Gestiona Cold Start (Tier 0 instantáneo mientras descarga ONNX en segundo plano)
 *   y reconciliación asíncrona por entryId + revision al estar listo el Worker.
 * - Mantiene estado observable y fallback limpio ante entornos sin Web Worker.
 */
(function (root) {
  "use strict";

  const SemanticClient = {
    _worker: null,
    _initPromise: null,
    _ready: false,
    _state: "idle", // idle | initializing | ready | error | unsupported
    _cacheHit: false,
    _initMs: 0,
    _version: null,
    _lastError: null,
    _progress: null,
    _config: {},
    _reqSeq: 0,
    _pending: new Map(),
    _reconcileRevision: new Map(),
    _listeners: new Set(),

    isSupported() {
      return typeof Worker !== "undefined";
    },

    isReady() {
      return Boolean(this._ready && this._worker);
    },

    getStatus() {
      return {
        supported: this.isSupported(),
        ready: this._ready,
        state: this._state,
        cacheHit: this._cacheHit,
        initMs: this._initMs,
        version: this._version,
        lastError: this._lastError,
        progress: this._progress
      };
    },

    onStateChange(fn) {
      if (typeof fn === "function") this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    },

    _emitState() {
      const snap = this.getStatus();
      for (const fn of this._listeners) {
        try {
          fn(snap);
        } catch {
          // No propagar errores de observadores UI
        }
      }
    },

    _requestPersistentStorage() {
      try {
        if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.persist === "function") {
          navigator.storage.persist().catch(() => {});
        }
      } catch {
        // Opcional según política del navegador
      }
    },

    _ensureWorker() {
      if (this._worker) return this._worker;
      if (!this.isSupported()) {
        this._state = "unsupported";
        return null;
      }
      const workerUrl = this._config.workerUrl || "js/ml/semantic.worker.js";
      const worker = new Worker(workerUrl);
      worker.onmessage = (ev) => this._handleMessage(ev.data || {});
      worker.onerror = (err) => {
        this._ready = false;
        this._state = "error";
        this._lastError = err && err.message ? err.message : "Error inesperado en Web Worker ONNX";
        this._emitState();
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error(this._lastError));
        }
        this._pending.clear();
      };
      this._worker = worker;
      return worker;
    },

    _handleMessage(msg) {
      if (msg.type === "progress") {
        this._progress = {
          phase: msg.phase,
          artifact: msg.artifact,
          completed: msg.completed,
          total: msg.total
        };
        this._emitState();
        return;
      }

      if (msg.type === "ready") {
        this._ready = true;
        this._state = "ready";
        this._cacheHit = Boolean(msg.cacheHit);
        this._initMs = Number(msg.initMs || 0);
        this._version = msg.version || null;
        this._lastError = null;
        this._progress = { phase: "ready", completed: 7, total: 7 };
        this._emitState();
      }

      if (msg.reqId && this._pending.has(msg.reqId)) {
        const entry = this._pending.get(msg.reqId);
        this._pending.delete(msg.reqId);
        clearTimeout(entry.timer);
        if (msg.type === "error") {
          if (msg.phase === "init") {
            this._ready = false;
            this._state = "error";
            this._lastError = msg.message || "Error inicializando Worker";
            this._emitState();
          }
          entry.reject(new Error(msg.message || "Error en Worker ONNX"));
        } else {
          entry.resolve(msg);
        }
        return;
      }

      if (msg.type === "error" && msg.phase === "init") {
        this._ready = false;
        this._state = "error";
        this._lastError = msg.message || "Error inicializando Worker";
        this._emitState();
      }
    },

    _postRequest(payload, timeoutMs = 45000) {
      const worker = this._ensureWorker();
      if (!worker) {
        return Promise.reject(new Error("Web Workers no disponibles en este entorno."));
      }
      const reqId = `ml_${++this._reqSeq}_${Date.now()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this._pending.has(reqId)) {
            this._pending.delete(reqId);
            reject(new Error("Tiempo de espera agotado en Worker ONNX."));
          }
        }, timeoutMs);
        this._pending.set(reqId, { resolve, reject, timer });
        worker.postMessage({ ...payload, reqId });
      });
    },

    async init(config = {}) {
      if (config && Object.keys(config).length) {
        this._config = { ...this._config, ...config };
      }
      if (!this.isSupported()) {
        this._state = "unsupported";
        return this.getStatus();
      }
      if (this._ready) return this.getStatus();
      if (this._initPromise) return this._initPromise;

      this._requestPersistentStorage();
      this._state = "initializing";
      this._lastError = null;
      this._emitState();

      this._initPromise = this._postRequest(
        { type: "init", config: this._config },
        Number(this._config.initTimeoutMs || 90000)
      )
        .then(() => this.getStatus())
        .catch((err) => {
          this._initPromise = null;
          this._ready = false;
          this._state = "error";
          this._lastError = err ? err.message : "Error de inicialización";
          this._emitState();
          throw err;
        });

      return this._initPromise;
    },

    warmup(config = {}) {
      if (!this.isSupported()) return Promise.resolve(null);
      return this.init(config).catch(() => null);
    },

    async classify(text, options = {}) {
      const clean = String(text || "").trim();
      if (!clean) {
        return ClientEngine.classifyTextDetailed(text, options);
      }
      await this.init(options.config || {});
      const explicitRegexRisk = typeof options.explicitRegexRisk === "boolean"
        ? options.explicitRegexRisk
        : ClientEngine.matchesExplicitRiskRegex(clean);

      const timeoutMs = Number(options.timeoutMs || 15000);
      const msg = await this._postRequest(
        {
          type: "classify",
          entryId: options.entryId || null,
          revision: options.revision || null,
          text: clean,
          questionnaire: options.questionnaire || null,
          priorDesgasteSeries: options.priorDesgasteSeries || [],
          explicitRegexRisk,
          config: options.config || this._config
        },
        timeoutMs
      );

      const res = msg.result || {};
      return ClientEngine.buildDetailedTraceFromProfile(clean, {
        valRes: res.valencia_emocional,
        actRes: res.activacion_energia,
        emoRes: res.emocion_primaria,
        ejesOut: res.ejes_tematicos,
        senalesOut: res.senales_alerta,
        tokens: res.tokens || 0,
        latencyMs: res.latencyMs || 0,
        backendName: res.backend || "laya-onnx-q8-worker",
        syntaxAnalysis: res.syntaxAnalysis || null,
        calibrationMeta: res.calibration_meta || null,
        extraUsage: {
          tier: "tier_1_onnx_q8",
          cache_hit: Boolean(res.cacheHit),
          entry_id: options.entryId || null,
          revision: options.revision || null
        }
      });
    },

    /**
     * En Cold Start, encola la re-evaluación Tier 1 en segundo plano y reconcilia
     * estrictamente por entryId + revision para evitar sobreescribir ediciones más recientes.
     */
    scheduleReconcile({
      entryId,
      revision,
      text,
      questionnaire = null,
      priorDesgasteSeries = [],
      explicitRegexRisk = null,
      onResolved = null
    }) {
      if (!this.isSupported() || !entryId || !String(text || "").trim()) return null;
      this._reconcileRevision.set(entryId, revision);

      return this.classify(text, {
        entryId,
        revision,
        questionnaire,
        priorDesgasteSeries,
        explicitRegexRisk
      })
        .then(async (detailedTrace) => {
          if (this._reconcileRevision.get(entryId) !== revision) {
            return null;
          }
          if (typeof onResolved === "function") {
            await onResolved(entryId, revision, detailedTrace);
          }
          return detailedTrace;
        })
        .catch(() => null);
    }
  };

  root.SemanticClient = SemanticClient;
})(typeof globalThis !== "undefined" ? globalThis : this);
