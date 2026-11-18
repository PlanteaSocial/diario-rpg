/**
 * Verificacion E2E real en Headless Chromium (Playwright):
 * 1. Cold-Start Tier 0 (< 2 ms) -> Web Worker ONNX WASM (`semantic.worker.js`) descargando artefactos
 *    e inferencia real de las 5 Baterias Criticas dentro de Chromium.
 * 2. Reconciliacion asincrona por `entryId` + `revision` (ignora revisiones obsoletas) y cifrado AES-256-GCM.
 * 3. Recarga 100% OFFLINE bloqueando red externa para comprobar caché persistente en IndexedDB (~ms).
 * 4. Verificacion tactil completa del modulo Aprender: dial mantener+deslizar (420ms),
 *    pausa de lectura de 2s al fallar, pista tocable en escenarios, contador exacto de fichas y pizarra de dibujo.
 *
 * Uso:
 *   node tests/verify_browser_e2e.mjs                     (servidor local + /models/ con CSP de firebase.json)
 *   node tests/verify_browser_e2e.mjs --live-url https://diario-rpg-plantea.web.app
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_NODE_PATH,
    "playwright",
    path.join(os.homedir(), ".local/share/mise/installs/playwright/latest/node_modules/playwright")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // probar siguiente candidato
    }
  }
  throw new Error("No se encontró el módulo 'playwright'. Define PLAYWRIGHT_NODE_PATH.");
}

const { chromium } = resolvePlaywright();
const CHROMIUM_BIN = fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm"
};

function startLocalProductionServer() {
  const fbJson = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));
  const globalHeaders = ((fbJson.hosting || {}).headers || [])[0]?.headers || [];
  const frontDir = path.join(ROOT, "frontend");
  const modelsDir = path.join(ROOT, "models");

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanPath = decodeURIComponent((req.url || "/").split("?")[0]);
      for (const h of globalHeaders) {
        if (h.key && h.value) res.setHeader(h.key, h.value);
      }

      let targetFile;
      if (cleanPath.startsWith("/models/")) {
        const rel = cleanPath.slice("/models/".length);
        targetFile = path.join(modelsDir, rel);
      } else {
        const rel = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
        targetFile = path.join(frontDir, rel);
      }

      const normRoot = cleanPath.startsWith("/models/") ? modelsDir : frontDir;
      if (!targetFile.startsWith(normRoot) || !fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(targetFile);
      res.setHeader("Content-Type", MIME_MAP[ext] || "application/octet-stream");
      if (cleanPath.startsWith("/models/")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      fs.createReadStream(targetFile).pipe(res);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function runVerification() {
  const args = process.argv.slice(2);
  const liveIdx = args.indexOf("--live-url");
  const liveUrl = liveIdx !== -1 ? args[liveIdx + 1] : null;

  let localSrv = null;
  let baseUrl = liveUrl;
  let navUrl = liveUrl;
  if (!baseUrl) {
    localSrv = await startLocalProductionServer();
    baseUrl = localSrv.url;
    navUrl = `${baseUrl}/?mode=cloud`;
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_BIN
  });

  const context = await browser.newContext();
  const pageErrors = [];
  const consoleErrors = [];

  try {
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("response", (res) => {
      if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`);
    });

    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(() => (
      typeof ClientEngine !== "undefined"
      && typeof SemanticClient !== "undefined"
      && typeof VaultCrypto !== "undefined"
      && typeof LearnLesson !== "undefined"
      && typeof LearnDial !== "undefined"
    ), { timeout: 20000 });

    // Limpiar IndexedDB/Cache previos para medir Cold Start real
    await page.evaluate(async () => {
      await new Promise((res) => {
        const req = indexedDB.deleteDatabase("diario_rpg_ml_cache_v1");
        req.onsuccess = req.onerror = req.onblocked = () => res();
      });
      if (typeof caches !== "undefined") {
        await caches.delete("diario-rpg-ml-v1");
      }
    });

    const workerConfig = liveUrl
      ? {}
      : {
          sources: {
            tokenizer_json: { mime: "application/json", urls: [`${baseUrl}/models/tokenizer_es.json`] },
            prototypes_json: { mime: "application/json", urls: [`${baseUrl}/models/prototypes_neg_v1.json`] },
            heads_json: { mime: "application/json", urls: [`${baseUrl}/models/diario_heads_v1.json`] },
            model_onnx: { mime: "application/octet-stream", urls: [`${baseUrl}/models/model_es_q8.onnx`] }
          }
        };

    // 1. Cold Start Tier 0 + Descarga Worker + 5 Baterias reales dentro del Web Worker ONNX WASM
    const coldReport = await page.evaluate(async (cfg) => {
      const b1Text = "No me siento nada bien, por más que intenté estar tranquilo hoy no pude concentrarme ni tantito";
      const t0Start = performance.now();
      const tier0Fast = ClientEngine.classifyTextDetailed(b1Text);
      const tier0Ms = performance.now() - t0Start;

      // Verificar reconciliacion asincrona por entryId + revision (stales descartados)
      let resolvedList = [];
      SemanticClient.warmup(cfg);
      SemanticClient.scheduleReconcile({
        entryId: "2026-11-17",
        revision: "rev-old",
        text: "Todo normal hoy.",
        onResolved: (id, rev) => resolvedList.push({ id, rev })
      });
      const finalRec = SemanticClient.scheduleReconcile({
        entryId: "2026-11-17",
        revision: "rev-new",
        text: b1Text,
        onResolved: (id, rev, trace) => resolvedList.push({ id, rev, backend: trace.raw_usage.backend })
      });

      const statusCold = await SemanticClient.init(cfg);
      await finalRec;

      const cases = [
        { id: "B1", text: b1Text, q: { self_report_word: "mal", valence_rating: 1, workload_rating: 3, sleep_hours: 7 } },
        { id: "B2", text: "Estuve todo el día en piloto automático, siento que la lista nunca se achica y ya no me da la cabeza", q: { self_report_word: "regular", valence_rating: 2, workload_rating: 5, sleep_hours: 6.5 } },
        { id: "B3", text: "Qué 'maravilloso' día, otra vez apagando fuegos hasta las 11 pm, según yo todo bajo control pero estoy fundido", q: { self_report_word: "bien", valence_rating: 4, workload_rating: 4, sleep_hours: 6 } },
        { id: "B4", text: "Fui a comprar tortillas, adelanté dos prácticas de contabilidad, hablé con mi mamá y me dormí a las 11", q: { self_report_word: "bien", valence_rating: 4, workload_rating: 2, sleep_hours: 8 } },
        { id: "B5", text: "Quisiera apagarme por completo y desaparecer, o deshacerme de todo lo que comí hoy porque no lo soporto", q: { self_report_word: "mal", valence_rating: 1, workload_rating: 4, sleep_hours: 5 } }
      ];

      const workerResults = {};
      for (const c of cases) {
        const res = await SemanticClient.classify(c.text, { questionnaire: c.q });
        const safety = ClientEngine.evaluateSafety(c.text, res.profile.senales_alerta);
        const disc = ClientEngine.detectDiscrepancy(c.q, res.profile);
        workerResults[c.id] = {
          backend: res.raw_usage.backend,
          latency_ms: res.latency_ms,
          valencia: res.profile.valencia_emocional.probabilities,
          activacion: res.profile.activacion_energia.choice,
          ejes: res.profile.ejes_tematicos,
          senales: res.profile.senales_alerta,
          safetyLevel: safety.level,
          hasDiscrepancy: disc.has_discrepancy
        };
      }

      // E2EE AES-256-GCM verificación
      const vault = await VaultCrypto.createVault("uid-e2e-test", "frase-secreta-rpg-2026");
      const aad = "uid-e2e-test:2026-11-17";
      const cipher = await VaultCrypto.encryptJson(vault.dekKey, { text: cases[4].text, secret: true }, aad);
      const plain = await VaultCrypto.decryptJson(vault.dekKey, cipher, aad);
      let wrongKeyFailed = false;
      try {
        await VaultCrypto.unlockWithPassphrase("uid-e2e-test", vault.vaultMeta, "clave-incorrecta");
      } catch {
        wrongKeyFailed = true;
      }

      return {
        tier0Backend: tier0Fast.raw_usage.backend,
        tier0Ms,
        statusCold,
        resolvedList,
        workerResults,
        e2eeOk: plain.text === cases[4].text && plain.secret === true && wrongKeyFailed
      };
    }, workerConfig);

    assert.equal(coldReport.tier0Backend, "laya-syntax-calibrada-js");
    assert.equal(coldReport.statusCold.ready, true);
    assert.equal(coldReport.statusCold.cacheHit, false);
    assert.equal(coldReport.e2eeOk, true, "Fallo en verificacion E2EE AES-256-GCM");
    assert.equal(coldReport.resolvedList.length, 1, "La revision obsoleta no debio ejecutarse");
    assert.equal(coldReport.resolvedList[0].rev, "rev-new");

    const w = coldReport.workerResults;
    assert.ok((w.B1.valencia.negativo + w.B1.valencia.muy_negativo) >= 0.80, `Worker B1 pNeg=${JSON.stringify(w.B1.valencia)}`);
    assert.ok((w.B1.valencia.positivo + w.B1.valencia.muy_positivo) <= 0.08, `Worker B1 pPos=${JSON.stringify(w.B1.valencia)}`);
    assert.ok(w.B2.ejes.carga_mental >= 0.80 && w.B2.senales.desgaste_sostenido >= 0.85 && w.B2.activacion === "agotamiento_baja");
    assert.ok(w.B3.hasDiscrepancy && (w.B3.valencia.negativo + w.B3.valencia.muy_negativo) >= 0.65 && w.B3.senales.contradiccion_emocional >= 0.75);
    assert.ok((w.B4.valencia.neutro + w.B4.valencia.positivo) >= 0.75 && w.B4.senales.desgaste_sostenido <= 0.25 && w.B4.senales.riesgo_autolesion_purga <= 0.10);
    assert.ok(w.B5.senales.riesgo_autolesion_purga >= 0.50 && w.B5.safetyLevel === "alert");

    // 2. Segunda visita: bloquear red de modelos/WASM para demostrar carga 100% OFFLINE desde IndexedDB
    const pageWarm = await context.newPage();
    pageWarm.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
    pageWarm.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    pageWarm.on("response", (res) => {
      if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`);
    });
    await pageWarm.route(/\.(onnx|wasm|mjs)(\?|$)|models\/.*\.json|ort\.wasm\.min\.js/, (route) => route.abort("failed"));
    await pageWarm.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pageWarm.waitForFunction(() => typeof SemanticClient !== "undefined");

    const warmReport = await pageWarm.evaluate(async (cfg) => {
      const statusWarm = await SemanticClient.init(cfg);
      const inferB5 = await SemanticClient.classify(
        "Quisiera apagarme por completo y desaparecer, o deshacerme de todo lo que comí hoy porque no lo soporto"
      );
      return {
        statusWarm,
        b5Risk: inferB5.profile.senales_alerta.riesgo_autolesion_purga,
        b5LatencyMs: inferB5.latency_ms
      };
    }, workerConfig);

    assert.equal(warmReport.statusWarm.ready, true);
    assert.equal(warmReport.statusWarm.cacheHit, true, "La segunda visita debe cargar 100% desde IndexedDB");
    assert.ok(warmReport.b5Risk >= 0.50, "Worker offline debe mantener precision B5");

    // 3. Verificación exhaustiva de las mecánicas táctiles de Aprender sobre el currículo real
    const learnSetup = await pageWarm.evaluate(async () => {
      const [tracksRes, glossaryRes] = await Promise.all([
        fetch("/data/learning_tracks.json"),
        fetch("/data/glossary_terms.json")
      ]);
      const tracksData = await tracksRes.json();
      const glossaryData = await glossaryRes.json();

      // Recolectar 1 paso real de cada tipo (myth, scenario, order, reflect)
      const byType = {};
      for (const tr of (tracksData.tracks || [])) {
        for (const les of (tr.lessons || [])) {
          for (const st of (les.steps || [])) {
            if (!byType[st.type]) byType[st.type] = st;
          }
        }
      }

      // Mostrar pestaña de Aprender en DOM real para interactuar táctilmente
      const gate = document.getElementById("auth-gate");
      if (gate) {
        gate.hidden = true;
        gate.style.display = "none";
      }
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      const pane = document.getElementById("pane-aprender");
      if (pane) pane.classList.add("active");

      LearnLesson.glossary = glossaryData.terms || {};
      LearnLesson.lesson = { id: "e2e_test", title: "Verificación Táctil", track_title: "QA", steps: [byType.myth, byType.scenario, byType.order, byType.reflect].filter(Boolean) };
      LearnLesson.queue = LearnLesson.lesson.steps.map((step) => ({ step, review: false }));
      LearnLesson.failedQueue = [];
      LearnLesson.reviewPass = false;
      LearnLesson.completedSteps = 0;
      LearnLesson.totalMainSteps = LearnLesson.queue.length;
      LearnLesson.combo = 0;
      LearnLesson.maxCombo = 0;
      LearnLesson.correctFirst = 0;
      LearnLesson.totalFirst = 0;

      const mapEl = document.getElementById("learn-map");
      const lessonEl = document.getElementById("learn-lesson");
      if (mapEl) mapEl.style.display = "none";
      lessonEl.style.display = "block";
      lessonEl.innerHTML = `
        <div id="learn-step-label">Paso 1</div>
        <span id="learn-progress-fill"></span>
        <div id="learn-combo">🔥 x0</div>
        <span id="learn-review-badge" hidden></span>
        <div id="learn-step-body"></div>
        <div id="learn-feedback"></div>
      `;

      window.__learnE2ESteps = byType;
      return {
        hasAllTypes: Boolean(byType.myth && byType.scenario && byType.order && byType.reflect),
        mythIsMyth: byType.myth?.is_myth,
        scenarioKeyIndex: byType.scenario?.key_index,
        orderTotal: byType.order?.correct?.length || 0,
        reflectHasDraw: Boolean(byType.reflect?.draw)
      };
    });
    assert.equal(learnSetup.hasAllTypes, true, "Debe existir myth, scenario, order y reflect en learning_tracks.json");

    // 3a) Dial táctil (mantener >= 420 ms + deslizar) + Pausa de 2s al fallar
    await pageWarm.evaluate(() => LearnLesson.renderMyth(window.__learnE2ESteps.myth, document.getElementById("learn-step-body")));
    const knobBox = await pageWarm.locator("#friction-knob").boundingBox();
    assert.ok(knobBox, "No se encontro #friction-knob");
    const cx = knobBox.x + knobBox.width / 2;
    const cy = knobBox.y + knobBox.height / 2;
    await pageWarm.mouse.move(cx, cy);
    await pageWarm.mouse.down();
    await pageWarm.waitForTimeout(480);
    const hintAfterHold = await pageWarm.locator("#friction-hint").textContent();
    assert.equal(hintAfterHold?.trim(), "DESLIZA", `Dial debio desbloquear tras 480ms, got "${hintAfterHold}"`);

    // Elegir intencionadamente el lado INCORRECTO para verificar la pausa obligatoria de 2s al fallar
    const wrongDx = learnSetup.mythIsMyth ? 130 : -130;
    await pageWarm.mouse.move(cx + wrongDx, cy, { steps: 8 });
    await pageWarm.mouse.up();

    const btnDisabledImmediate = await pageWarm.locator("#learn-continue-btn").isDisabled();
    assert.equal(btnDisabledImmediate, true, "Al fallar, #learn-continue-btn debe iniciar bloqueado (~2s)");
    await pageWarm.waitForTimeout(900);
    const btnDisabledMid = await pageWarm.locator("#learn-continue-btn").isDisabled();
    assert.equal(btnDisabledMid, true, "A los 900ms todavia debe respetar la pausa de lectura");
    await pageWarm.waitForTimeout(1400);
    const btnDisabledAfter2s = await pageWarm.locator("#learn-continue-btn").isDisabled();
    assert.equal(btnDisabledAfter2s, false, "Despues de 2s debe habilitarse #learn-continue-btn");

    // 3b) Pista tocable en Escenario aplicado
    await pageWarm.evaluate(() => {
      document.getElementById("learn-feedback").innerHTML = "";
      LearnLesson.renderScenario(window.__learnE2ESteps.scenario, document.getElementById("learn-step-body"));
    });
    const optionDisabledBefore = await pageWarm.locator("#learn-options button").first().isDisabled();
    assert.equal(optionDisabledBefore, true, "Las opciones deben iniciar bloqueadas hasta tocar la pista");
    await pageWarm.locator(`.learn-clue-span[data-index="${learnSetup.scenarioKeyIndex}"]`).click();
    const optionDisabledAfter = await pageWarm.locator("#learn-options button").first().isDisabled();
    const clueHintText = await pageWarm.locator("#learn-clue-hint").textContent();
    assert.equal(optionDisabledAfter, false, "Tocar la pista correcta debe desbloquear opciones");
    assert.ok(clueHintText.includes("Pista encontrada"), `Mensaje esperado tras pista: ${clueHintText}`);

    // 3c) Contador exacto de fichas en Ordenar
    await pageWarm.evaluate(() => LearnLesson.renderOrder(window.__learnE2ESteps.order, document.getElementById("learn-step-body")));
    const meta0 = await pageWarm.locator("#learn-order-meta").textContent();
    assert.equal(meta0.trim(), `Fichas colocadas: 0 de ${learnSetup.orderTotal}`);
    await pageWarm.locator("#learn-order-bank .learn-chip").first().click();
    const meta1 = await pageWarm.locator("#learn-order-meta").textContent();
    assert.equal(meta1.trim(), `Fichas colocadas: 1 de ${learnSetup.orderTotal}`);

    // 3d) Pizarra de dibujo en Reflexion
    await pageWarm.evaluate(() => {
      const refl = { ...window.__learnE2ESteps.reflect, draw: true };
      LearnLesson.renderReflect(refl, document.getElementById("learn-step-body"));
    });
    const canvasBox = await pageWarm.locator("#learn-draw-canvas").boundingBox();
    assert.ok(canvasBox, "No se encontro #learn-draw-canvas");
    for (let s = 0; s < 3; s++) {
      const y = canvasBox.y + 40 + s * 35;
      await pageWarm.mouse.move(canvasBox.x + 30, y);
      await pageWarm.mouse.down();
      await pageWarm.mouse.move(canvasBox.x + 140, y + 10, { steps: 5 });
      await pageWarm.mouse.up();
    }
    const drawMeta = await pageWarm.locator("#learn-draw-meta").textContent();
    const reflectCanContinue = !(await pageWarm.locator("#learn-reflect-continue").isDisabled());
    assert.equal(drawMeta.trim(), "Trazos: 3");
    assert.equal(reflectCanContinue, true, "3 trazos deben habilitar Continuar en Reflexion");

    assert.equal(pageErrors.length, 0, `Page errors detectados: ${JSON.stringify(pageErrors)}`);
    assert.equal(consoleErrors.length, 0, `Console errors detectados: ${JSON.stringify(consoleErrors)}`);

    console.log(JSON.stringify({
      status: "PASS",
      target: baseUrl,
      errors_count: 0,
      cold_tier0_ms: Number(coldReport.tier0Ms.toFixed(2)),
      cold_worker_init_ms: coldReport.statusCold.initMs,
      warm_worker_offline_init_ms: warmReport.statusWarm.initMs,
      warm_worker_cache_hit: warmReport.statusWarm.cacheHit,
      worker_batteries: {
        B1_pNeg: Number((w.B1.valencia.negativo + w.B1.valencia.muy_negativo).toFixed(4)),
        B2_desgaste: w.B2.senales.desgaste_sostenido,
        B3_contra: w.B3.senales.contradiccion_emocional,
        B4_risk: w.B4.senales.riesgo_autolesion_purga,
        B5_risk: w.B5.senales.riesgo_autolesion_purga
      },
      aprender_mechanics: {
        dial_hold_unlock: hintAfterHold?.trim(),
        pause_2s_enforced: btnDisabledImmediate && btnDisabledMid && !btnDisabledAfter2s,
        scenario_clue_unlock: true,
        order_chip_counter: meta1.trim(),
        reflect_draw_strokes: drawMeta.trim()
      }
    }, null, 2));
  } finally {
    await browser.close();
    if (localSrv) localSrv.server.close();
  }
}

runVerification().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
