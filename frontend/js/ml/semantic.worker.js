/**
 * Web Worker asíncrono Tier 1 para inferencia semántica local (Zero-Knowledge E2EE).
 * Carga BPE + Sintaxis + Calibración desde 'self', descarga el encoder ONNX INT8
 * (~18.7 MB) y artefactos destilados desde GitHub CDN (jsDelivr / Raw fallback),
 * los persiste en IndexedDB + Cache API y ejecuta 100% offline en visitas futuras.
 */
/* global importScripts, BpeTokenizer, SyntaxFeatures, CalibrationMath */
"use strict";

importScripts("./bpe_tokenizer.js", "./syntax_features.js", "./calibration_math.js");

const ARTIFACT_VERSION = "v1.0.0-mmbert2-q8";
const IDB_NAME = "diario_rpg_ml_cache_v1";
const IDB_STORE = "artifacts";
const CACHE_API_NAME = "diario-rpg-ml-v1";

const DEFAULT_SOURCES = {
  ort_wasm_js: {
    mime: "text/javascript",
    urls: [
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.js",
      "https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.wasm.min.js"
    ]
  },
  ort_wasm_mjs: {
    mime: "text/javascript",
    urls: [
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs",
      "https://unpkg.com/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs"
    ]
  },
  ort_wasm_bin: {
    mime: "application/wasm",
    urls: [
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm",
      "https://unpkg.com/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm"
    ]
  },
  tokenizer_json: {
    mime: "application/json",
    urls: [
      "https://cdn.jsdelivr.net/gh/PlanteaSocial/diario-rpg@main/models/tokenizer_es.json",
      "https://raw.githubusercontent.com/PlanteaSocial/diario-rpg/main/models/tokenizer_es.json"
    ]
  },
  prototypes_json: {
    mime: "application/json",
    urls: [
      "https://cdn.jsdelivr.net/gh/PlanteaSocial/diario-rpg@main/models/prototypes_neg_v1.json",
      "https://raw.githubusercontent.com/PlanteaSocial/diario-rpg/main/models/prototypes_neg_v1.json"
    ]
  },
  heads_json: {
    mime: "application/json",
    urls: [
      "https://cdn.jsdelivr.net/gh/PlanteaSocial/diario-rpg@main/models/diario_heads_v1.json",
      "https://raw.githubusercontent.com/PlanteaSocial/diario-rpg/main/models/diario_heads_v1.json"
    ]
  },
  model_onnx: {
    mime: "application/octet-stream",
    urls: [
      "https://cdn.jsdelivr.net/gh/PlanteaSocial/diario-rpg@main/models/model_es_q8.onnx",
      "https://raw.githubusercontent.com/PlanteaSocial/diario-rpg/main/models/model_es_q8.onnx"
    ]
  }
};

const EXPLICIT_RISK_PATTERNS = [
  /\b(suicid|matarm[ea]|quitarme la vida|acabar con todo|no quiero vivir|desaparecer de este mundo|hacerme da[ñn]o|cortarm[ea]|autolesi[oó]n)\w*/i,
  /\b(purgarm[ea]|vomitar la comida|v[oó]mito inducido|no merezco comer|dejar de comer por completo|laxantes para no engordar)\w*/i
];

let initPromise = null;
let runtimeState = {
  ready: false,
  cacheHit: false,
  initMs: 0,
  tokenizer: null,
  prototypes: null,
  heads: null,
  session: null
};
let runQueue = Promise.resolve();

function checkExplicitRisk(text) {
  if (!text) return false;
  const sanitized = self.SyntaxFeatures && self.SyntaxFeatures.stripSafeMetaphors
    ? self.SyntaxFeatures.stripSafeMetaphors(text)
    : String(text);
  const rawLower = sanitized.toLowerCase();
  const folded = self.SyntaxFeatures && self.SyntaxFeatures.fold
    ? self.SyntaxFeatures.fold(sanitized)
    : rawLower;
  return EXPLICIT_RISK_PATTERNS.some((pat) => pat.test(rawLower) || pat.test(folded));
}

function openCacheDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet(db, key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(db, record) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function fetchFromMirrors(urls) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} en ${url}`);
        continue;
      }
      const buffer = await res.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        lastErr = new Error(`Respuesta vacía en ${url}`);
        continue;
      }
      return { buffer, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No fue posible descargar el artefacto ML.");
}

async function loadArtifactBuffer(db, cacheApi, key, spec, progressIdx, totalArtifacts) {
  const idbRec = await idbGet(db, key);
  if (
    idbRec
    && idbRec.version === ARTIFACT_VERSION
    && idbRec.buffer instanceof ArrayBuffer
    && idbRec.buffer.byteLength > 0
  ) {
    return { buffer: idbRec.buffer, fromCache: true };
  }

  if (cacheApi) {
    for (const url of spec.urls) {
      try {
        const hit = await cacheApi.match(url);
        if (hit && hit.ok) {
          const buf = await hit.arrayBuffer();
          if (buf && buf.byteLength > 0) {
            await idbPut(db, {
              key,
              version: ARTIFACT_VERSION,
              mime: spec.mime,
              buffer: buf,
              cachedAt: Date.now()
            });
            return { buffer: buf, fromCache: true };
          }
        }
      } catch {
        // Ignorar fallo puntual en Cache API y seguir al espejo de red
      }
    }
  }

  self.postMessage({
    type: "progress",
    phase: "downloading",
    artifact: key,
    completed: progressIdx,
    total: totalArtifacts
  });

  const { buffer, url } = await fetchFromMirrors(spec.urls);
  await idbPut(db, {
    key,
    version: ARTIFACT_VERSION,
    mime: spec.mime,
    buffer,
    cachedAt: Date.now()
  });
  if (cacheApi && url) {
    try {
      await cacheApi.put(
        url,
        new Response(buffer.slice(0), {
          status: 200,
          headers: { "Content-Type": spec.mime }
        })
      );
    } catch {
      // Cache API es redundancia opcional junto a IndexedDB
    }
  }
  return { buffer, fromCache: false };
}

function mergeSources(config = {}) {
  const overrides = (config && config.sources) || {};
  const merged = {};
  for (const [k, def] of Object.entries(DEFAULT_SOURCES)) {
    const ov = overrides[k];
    merged[k] = ov && Array.isArray(ov.urls) && ov.urls.length
      ? { mime: ov.mime || def.mime, urls: ov.urls }
      : def;
  }
  return merged;
}

async function ensureInitialized(config = {}) {
  if (runtimeState.ready) return runtimeState;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const t0 = performance.now();
    const sources = mergeSources(config);
    const keys = Object.keys(sources);

    const db = await openCacheDb();
    let cacheApi = null;
    if (typeof caches !== "undefined") {
      try {
        cacheApi = await caches.open(CACHE_API_NAME);
      } catch {
        cacheApi = null;
      }
    }

    const buffers = {};
    let allFromCache = true;
    const loadedItems = await Promise.all(
      keys.map((k, i) => loadArtifactBuffer(db, cacheApi, k, sources[k], i, keys.length))
    );
    for (let i = 0; i < keys.length; i++) {
      buffers[keys[i]] = loadedItems[i].buffer;
      if (!loadedItems[i].fromCache) allFromCache = false;
    }

    const decoder = new TextDecoder("utf-8");
    const tokenizerSpec = JSON.parse(decoder.decode(buffers.tokenizer_json));
    const prototypes = JSON.parse(decoder.decode(buffers.prototypes_json));
    const heads = JSON.parse(decoder.decode(buffers.heads_json));
    const tokenizer = self.BpeTokenizer.create(tokenizerSpec);

    if (!self.ort) {
      const ortJsBlobUrl = URL.createObjectURL(
        new Blob([buffers.ort_wasm_js], { type: "text/javascript" })
      );
      try {
        importScripts(ortJsBlobUrl);
      } finally {
        URL.revokeObjectURL(ortJsBlobUrl);
      }
    }

    const mjsBlobUrl = URL.createObjectURL(
      new Blob([buffers.ort_wasm_mjs], { type: "text/javascript" })
    );
    const wasmBlobUrl = URL.createObjectURL(
      new Blob([buffers.ort_wasm_bin], { type: "application/wasm" })
    );
    self.ort.env.wasm.numThreads = 1;
    self.ort.env.wasm.proxy = false;
    self.ort.env.wasm.wasmPaths = { mjs: mjsBlobUrl, wasm: wasmBlobUrl };
    self.ort.env.wasm.wasmBinary = undefined;

    let session;
    try {
      session = await self.ort.InferenceSession.create(
        new Uint8Array(buffers.model_onnx),
        { executionProviders: ["wasm"], graphOptimizationLevel: "all" }
      );
    } finally {
      URL.revokeObjectURL(mjsBlobUrl);
      URL.revokeObjectURL(wasmBlobUrl);
    }

    const initMs = Math.round((performance.now() - t0) * 100) / 100;
    runtimeState = {
      ready: true,
      cacheHit: allFromCache,
      initMs,
      tokenizer,
      prototypes,
      heads,
      session
    };
    return runtimeState;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function runClassify(payload) {
  const state = await ensureInitialized(payload.config || {});
  const text = String(payload.text || "").trim();
  const t0 = performance.now();

  const encoded = state.tokenizer.encode(text, 128);
  const seqLen = encoded.inputIds.length;
  const idsBig = BigInt64Array.from(encoded.inputIds, (v) => BigInt(v));
  const maskBig = BigInt64Array.from(encoded.attentionMask, (v) => BigInt(v));

  const feeds = {
    input_ids: new self.ort.Tensor("int64", idsBig, [1, seqLen]),
    attention_mask: new self.ort.Tensor("int64", maskBig, [1, seqLen])
  };
  const outputs = await state.session.run(feeds);
  const embedding = outputs.embedding.data;

  const syn = self.SyntaxFeatures.extract(text, payload.questionnaire || null);
  const explicitRisk = typeof payload.explicitRegexRisk === "boolean"
    ? payload.explicitRegexRisk
    : checkExplicitRisk(text);

  const calibrated = self.CalibrationMath.scoreTier1Hybrid(embedding, syn.signals16, {
    prototypes: state.prototypes,
    heads: state.heads,
    priorDesgasteSeries: payload.priorDesgasteSeries || [],
    explicitRegexRisk: explicitRisk
  });

  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  return {
    ...calibrated,
    tokens: seqLen,
    latencyMs,
    cacheHit: state.cacheHit,
    backend: "laya-onnx-q8-worker",
    syntaxAnalysis: {
      clauses: syn.clauses,
      signals16: syn.signals16,
      hasAdversativeShift: syn.hasAdversativeShift,
      intraNoteContradiction: syn.intraNoteContradiction,
      postAdversativeClauses: syn.postAdversativeClauses,
      ordinaryClauses: syn.ordinaryClauses,
      implicitRiskHits: syn.implicitRiskHits
    }
  };
}

self.onmessage = function (ev) {
  const msg = ev.data || {};
  if (msg.type === "init") {
    ensureInitialized(msg.config || {})
      .then((state) => {
        self.postMessage({
          type: "ready",
          reqId: msg.reqId || null,
          cacheHit: state.cacheHit,
          initMs: state.initMs,
          version: ARTIFACT_VERSION
        });
      })
      .catch((err) => {
        self.postMessage({
          type: "error",
          reqId: msg.reqId || null,
          phase: "init",
          message: err ? (err.message || String(err)) : "Error iniciando worker ONNX"
        });
      });
    return;
  }

  if (msg.type === "classify") {
    runQueue = runQueue
      .then(() => runClassify(msg))
      .then((result) => {
        self.postMessage({
          type: "classified",
          reqId: msg.reqId || null,
          entryId: msg.entryId || null,
          revision: msg.revision || null,
          result
        });
      })
      .catch((err) => {
        self.postMessage({
          type: "error",
          reqId: msg.reqId || null,
          entryId: msg.entryId || null,
          revision: msg.revision || null,
          phase: "classify",
          message: err ? (err.message || String(err)) : "Error clasificando en worker ONNX"
        });
      });
  }
};
