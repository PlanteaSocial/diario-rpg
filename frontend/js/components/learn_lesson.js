/**
 * Motor de lecciones de Aprender.
 * 6 mecánicas con fricción cognitiva: dial, clasificación, escenario anclado,
 * orden por fichas, reflexión con dibujo y repaso Birdbrain.
 */

const LearnLesson = {
  lesson: null,
  glossary: {},
  queue: [],
  failedQueue: [],
  reviewPass: false,
  completedSteps: 0,
  totalMainSteps: 0,
  combo: 0,
  maxCombo: 0,
  correctFirst: 0,
  totalFirst: 0,
  dial: null,
  currentStep: null,
  termPop: null,
  _docHideHandler: null,
  _feedbackTimer: null,

  async start(lessonId) {
    if (this._feedbackTimer) {
      clearTimeout(this._feedbackTimer);
      this._feedbackTimer = null;
    }
    this.hideTerm();
    const data = await API.getLearningLesson(lessonId);
    if (!data || data.detail || !data.lesson) {
      App.showToast("No se pudo abrir la lección");
      return;
    }

    this.lesson = data.lesson;
    this.glossary = data.glossary || {};
    this.queue = (this.lesson.steps || []).map((step) => ({ step, review: false }));
    this.failedQueue = [];
    this.reviewPass = false;
    this.completedSteps = 0;
    this.totalMainSteps = this.queue.length;
    this.combo = 0;
    this.maxCombo = 0;
    this.correctFirst = 0;
    this.totalFirst = 0;
    this.currentStep = null;

    const map = document.getElementById("learn-map");
    const lessonEl = document.getElementById("learn-lesson");
    if (map) map.style.display = "none";
    if (lessonEl) {
      lessonEl.style.display = "block";
      lessonEl.innerHTML = `
        <div class="duo-lesson-bar">
          <button type="button" class="duo-close-btn" id="learn-back-btn" title="Salir de la lección" aria-label="Salir">✕</button>
          <div class="duo-lesson-progress"><span id="learn-progress-fill"></span></div>
          <div class="learn-combo" id="learn-combo">🔥 x0</div>
        </div>
        <div class="duo-lesson-head">
          <span class="duo-lesson-track">${this.escape(this.lesson.track_title || "Aprender")}</span>
          <h2 class="serif-heading">${this.escape(this.lesson.title || "")}</h2>
        </div>
        <div class="learn-step-meta">
          <span id="learn-step-label">Paso 1</span>
          <span class="learn-review-badge" id="learn-review-badge" hidden>Repaso Birdbrain</span>
        </div>
        <div id="learn-step-body"></div>
        <div id="learn-feedback"></div>
      `;
      document.getElementById("learn-back-btn").addEventListener("click", () => this.exit());
    }

    this.renderCurrent();
    window.scrollTo({ top: 0, behavior: "smooth" });
  },

  exit() {
    if (this._feedbackTimer) {
      clearTimeout(this._feedbackTimer);
      this._feedbackTimer = null;
    }
    this.hideTerm();
    const map = document.getElementById("learn-map");
    const lessonEl = document.getElementById("learn-lesson");
    if (lessonEl) lessonEl.style.display = "none";
    if (map) map.style.display = "block";
    if (LearnMapComponent && LearnMapComponent.loadState) LearnMapComponent.loadState();
  },

  renderCurrent() {
    if (!this.queue.length) {
      if (this.failedQueue.length && !this.reviewPass) {
        this.reviewPass = true;
        this.queue = this.failedQueue.map((step) => ({ step, review: true }));
        this.failedQueue = [];
        App.showToast("Repaso rápido de los conceptos que fallaron");
      } else {
        this.finish();
        return;
      }
    }

    const item = this.queue[0];
    this.currentStep = item.step;
    const step = item.step;
    const body = document.getElementById("learn-step-body");
    const feedback = document.getElementById("learn-feedback");
    if (feedback) feedback.innerHTML = "";
    if (!body) return;

    this.updateHeader(item);

    if (step.type === "myth") this.renderMyth(step, body);
    else if (step.type === "classify") this.renderClassify(step, body);
    else if (step.type === "scenario") this.renderScenario(step, body);
    else if (step.type === "order") this.renderOrder(step, body);
    else if (step.type === "reflect") this.renderReflect(step, body);
    else this.finish();
  },

  updateHeader(item) {
    const label = document.getElementById("learn-step-label");
    const fill = document.getElementById("learn-progress-fill");
    const badge = document.getElementById("learn-review-badge");
    const combo = document.getElementById("learn-combo");

    const total = item.review ? this.queue.length : this.totalMainSteps;
    const current = item.review ? 1 : Math.min(this.completedSteps + 1, this.totalMainSteps);
    if (label) label.textContent = `Paso ${current} de ${total}`;
    if (fill) {
      const pct = Math.min(100, (this.completedSteps / Math.max(1, this.totalMainSteps)) * 100);
      fill.style.width = `${Math.max(pct, 6)}%`;
    }
    if (badge) badge.hidden = !item.review;
    if (combo) combo.textContent = `🔥 x${this.combo}`;
  },

  linkTerms(text) {
    const escaped = this.escape(text || "");
    return escaped.replace(/\[\[([^\]]+)\]\]/g, (_, term) => {
      const safe = this.escape(term);
      return `<span class="learn-term" role="button" tabindex="0" data-term="${safe}">${safe}</span>`;
    });
  },

  bindTerms(root) {
    root.querySelectorAll(".learn-term").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        this.showTerm(el.dataset.term, el);
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ev.stopPropagation();
          this.showTerm(el.dataset.term, el);
        }
      });
    });
  },

  showTerm(term, anchor) {
    this.hideTerm();
    const definition = this.glossary[term];
    if (!definition) return;
    const pop = document.createElement("div");
    pop.className = "learn-term-pop";
    pop.innerHTML = `<strong>${this.escape(term)}</strong><p>${this.escape(definition)}</p>`;
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 150, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 300, Math.max(12, rect.left - 40));
    pop.style.top = `${top + window.scrollY}px`;
    pop.style.left = `${left + window.scrollX}px`;
    this.termPop = pop;
    this._docHideHandler = () => this.hideTerm();
    setTimeout(() => {
      if (this._docHideHandler) {
        document.addEventListener("click", this._docHideHandler, { once: true });
      }
    }, 10);
  },

  hideTerm() {
    if (this._docHideHandler) {
      document.removeEventListener("click", this._docHideHandler);
      this._docHideHandler = null;
    }
    if (this.termPop) {
      this.termPop.remove();
      this.termPop = null;
    }
  },

  renderMyth(step, body) {
    body.innerHTML = `
      <div class="learn-step-card">
        <div class="learn-step-kicker">Mito o realidad</div>
        <p class="learn-statement">${this.linkTerms(step.statement)}</p>
        <div id="learn-dial-mount"></div>
      </div>
    `;
    this.bindTerms(body);

    const mount = document.getElementById("learn-dial-mount");
    this.dial = LearnDial.mount(mount, {
      leftLabel: "Mito",
      rightLabel: "Realidad",
      onAnswer: (side) => {
        const correctSide = step.is_myth ? "left" : "right";
        const ok = side === correctSide;
        const chosen = side === "left" ? "Mito" : "Realidad";
        const title = ok ? "Correcto" : `Era ${step.is_myth ? "un mito" : "realidad"}`;
        this.registerAnswer(ok);
        this.showFeedback(ok, title, `${this.linkTerms(step.explanation)}<div class="learn-answer-note">Elegiste: <b>${chosen}</b></div>`);
      }
    });
  },

  renderClassify(step, body) {
    const items = (step.items || []).map((item) => ({ ...item }));
    const buckets = step.buckets || [];
    const leftBucket = buckets[0] || { id: "a", label: "Opción A" };
    const rightBucket = buckets[1] || { id: "b", label: "Opción B" };
    const state = {
      remaining: items,
      total: items.length,
      solved: 0,
      firstTry: new Map(),
      current: null
    };

    const paint = () => {
      if (!state.remaining.length) {
        const firstTryCorrect = [...state.firstTry.values()].filter(Boolean).length;
        this.totalFirst += state.total;
        this.correctFirst += firstTryCorrect;
        this.bumpCombo(true);
        LearnAudio.complete();
        const current = this.queue[0];
        if (firstTryCorrect < state.total && current && !current.review) {
          this.failedQueue.push(current.step);
        }
        this.showFeedback(true, "Clasificación completa", `Has separado las señales sin dejarte llevar por la primera impresión. Aciertos al primer intento: <b>${firstTryCorrect}/${state.total}</b>.`);
        return;
      }

      state.current = state.remaining[0];
      body.innerHTML = `
        <div class="learn-step-card">
          <div class="learn-step-kicker">Clasifica la señal</div>
          <p class="learn-classify-prompt">${this.linkTerms(step.prompt)}</p>
          <div class="learn-classify-meta">
            <span>Tarjeta ${state.solved + 1} de ${state.total}</span>
            <span>Quedan ${state.remaining.length}</span>
          </div>
          <div class="learn-classify-card" id="learn-classify-card">${this.linkTerms(state.current.text)}</div>
          <div id="learn-classify-dial"></div>
          <div class="learn-hint-line" id="learn-classify-hint"></div>
        </div>
      `;
      this.bindTerms(body);

      const mount = document.getElementById("learn-classify-dial");
      const item = state.current;
      this.dial = LearnDial.mount(mount, {
        leftLabel: leftBucket.label,
        rightLabel: rightBucket.label,
        onAnswer: (side) => {
          const chosenBucket = side === "left" ? leftBucket.id : rightBucket.id;
          const ok = chosenBucket === item.bucket;
          if (!state.firstTry.has(item.id)) state.firstTry.set(item.id, ok);

          if (ok) {
            state.solved += 1;
            state.remaining.shift();
            this.bumpCombo(true);
            LearnAudio.correct(this.combo);
            paint();
            return;
          }

          this.bumpCombo(false);
          LearnAudio.wrong();
          const card = document.getElementById("learn-classify-card");
          const hint = document.getElementById("learn-classify-hint");
          card?.classList.add("anim-shake");
          if (hint) hint.textContent = item.hint || "Esa no es la cubeta. La tarjeta vuelve al final.";
          setTimeout(() => {
            if (state.remaining.length > 1) {
              state.remaining.push(state.remaining.shift());
            }
            paint();
          }, 950);
        }
      });
    };

    paint();
  },

  renderScenario(step, body) {
    const sentences = step.sentences || [];
    let unlocked = false;

    body.innerHTML = `
      <div class="learn-step-card">
        <div class="learn-step-kicker">Escenario aplicado</div>
        <h3 class="learn-scenario-title serif-heading">${this.escape(step.title || "")}</h3>
        <div class="learn-scenario-text">
          ${sentences
            .map(
              (sentence, index) =>
                `<button type="button" class="learn-clue-span clue-span" data-index="${index}">${this.linkTerms(sentence)}</button>`
            )
            .join(" ")}
        </div>
        <div class="learn-clue-hint" id="learn-clue-hint">Toca la frase que contiene la pista clave del problema.</div>
        <div class="learn-options is-locked" id="learn-options">
          ${(step.options || [])
            .map(
              (option, index) =>
                `<button type="button" class="learn-option-btn" data-index="${index}" disabled>${this.linkTerms(option)}</button>`
            )
            .join("")}
        </div>
      </div>
    `;
    this.bindTerms(body);

    const optionsBox = document.getElementById("learn-options");
    const hint = document.getElementById("learn-clue-hint");

    body.querySelectorAll(".learn-clue-span").forEach((span) => {
      span.addEventListener("click", () => {
        const index = Number(span.dataset.index);
        if (index !== Number(step.key_index)) {
          span.classList.add("is-miss", "clue-miss");
          if (hint) hint.textContent = "Esa frase describe, pero no es la pista central. Sigue leyendo.";
          LearnAudio.error();
          return;
        }
        if (unlocked) return;
        unlocked = true;
        span.classList.add("is-key", "clue-found");
        if (hint) hint.textContent = "Pista encontrada. Ahora elige la explicación.";
        optionsBox?.classList.remove("is-locked");
        optionsBox?.querySelectorAll("button").forEach((btn) => (btn.disabled = false));
        LearnAudio.unlock();
      });
    });

    body.querySelectorAll(".learn-option-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!unlocked) return;
        const ok = Number(btn.dataset.index) === Number(step.answer);
        this.registerAnswer(ok);
        this.showFeedback(
          ok,
          ok ? "Bien leído" : "Casi",
          `${this.linkTerms(step.explanation)}`
        );
      });
    });
  },

  renderOrder(step, body) {
    const correct = step.correct || [];
    const distractors = step.distractors || [];
    const bankItems = [...correct, ...distractors].map((text, index) => ({
      id: `chip_${index}`,
      text
    }));
    for (let i = bankItems.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bankItems[i], bankItems[j]] = [bankItems[j], bankItems[i]];
    }

    const state = { bank: bankItems, slots: [] };

    const paint = () => {
      const slotsEl = document.getElementById("learn-order-slots");
      const bankEl = document.getElementById("learn-order-bank");
      const meta = document.getElementById("learn-order-meta");
      const check = document.getElementById("learn-order-check");
      if (!slotsEl || !bankEl) return;

      slotsEl.innerHTML = state.slots.length
        ? state.slots
            .map(
              (chip, index) =>
                `<button type="button" class="learn-chip is-slot" data-slot="${index}">${this.escape(chip.text)}</button>`
            )
            .join("")
        : `<span class="learn-slot-empty">Toca las fichas en el orden correcto</span>`;

      bankEl.innerHTML = state.bank
        .map(
          (chip) =>
            `<button type="button" class="learn-chip" data-bank="${chip.id}" ${state.slots.length >= correct.length ? "disabled" : ""}>${this.escape(chip.text)}</button>`
        )
        .join("");

      if (meta) meta.textContent = `Fichas colocadas: ${state.slots.length} de ${correct.length}`;
      if (check) check.disabled = state.slots.length !== correct.length;

      bankEl.querySelectorAll("[data-bank]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (state.slots.length >= correct.length) return;
          const idx = state.bank.findIndex((c) => c.id === btn.dataset.bank);
          if (idx === -1) return;
          state.slots.push(state.bank.splice(idx, 1)[0]);
          LearnAudio.pick();
          paint();
        });
      });
      slotsEl.querySelectorAll("[data-slot]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.slot);
          state.bank.push(state.slots.splice(idx, 1)[0]);
          LearnAudio.pick();
          paint();
        });
      });
    };

    body.innerHTML = `
      <div class="learn-step-card">
        <div class="learn-step-kicker">Construye el orden</div>
        <p class="learn-classify-prompt">${this.linkTerms(step.prompt)}</p>
        <div class="learn-order-slots" id="learn-order-slots"></div>
        <div class="learn-order-meta" id="learn-order-meta">Fichas colocadas: 0 de ${correct.length}</div>
        <div class="learn-order-bank" id="learn-order-bank"></div>
        <button type="button" class="btn-primary learn-order-check" id="learn-order-check" disabled>Comprobar orden</button>
      </div>
    `;
    paint();

    document.getElementById("learn-order-check").addEventListener("click", () => {
      const chosen = state.slots.map((chip) => chip.text);
      const ok = chosen.length === correct.length && chosen.every((text, i) => text === correct[i]);
      this.registerAnswer(ok);
      const correctText = correct.map((t, i) => `${i + 1}. ${this.escape(t)}`).join("<br>");
      this.showFeedback(
        ok,
        ok ? "Orden correcto" : "Revisa el orden",
        ok
          ? "Has reconstruido la secuencia sin pistas."
          : `El orden esperado era:<br><div class="learn-order-answer">${correctText}</div>`
      );
    });
  },

  renderReflect(step, body) {
    body.innerHTML = `
      <div class="learn-step-card">
        <div class="learn-step-kicker">Reflexión personal</div>
        <p class="learn-reflect-prompt">${this.linkTerms(step.prompt)}</p>
        <textarea class="learn-reflect-input" id="learn-reflect-input" placeholder="${this.escape(step.placeholder || "")}" rows="4"></textarea>
        ${
          step.draw
            ? `<div class="learn-draw-wrap">
                 <canvas id="learn-draw-canvas" width="640" height="220"></canvas>
                 <div class="learn-draw-meta"><span id="learn-draw-meta">Trazos: 0</span><button type="button" class="learn-mini-btn" id="learn-draw-clear">Limpiar</button></div>
                 <div class="learn-draw-prompt">${this.escape(step.draw_prompt || "Dibuja lo que sientas, sin buscar que quede bien.")}</div>
               </div>`
            : ""
        }
        <div class="learn-reflect-actions">
          <button type="button" class="btn-secondary" id="learn-notebook-save">Guardar en libreta</button>
          <button type="button" class="btn-primary" id="learn-reflect-continue" disabled>Continuar</button>
        </div>
      </div>
    `;
    this.bindTerms(body);

    const input = document.getElementById("learn-reflect-input");
    const continueBtn = document.getElementById("learn-reflect-continue");
    const saveBtn = document.getElementById("learn-notebook-save");
    let strokes = 0;

    const refresh = () => {
      const hasText = input.value.trim().length >= 8;
      continueBtn.disabled = !(hasText || strokes >= 3);
    };

    input.addEventListener("input", refresh);

    if (step.draw) {
      const canvas = document.getElementById("learn-draw-canvas");
      const ctx = canvas.getContext("2d");
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-primary") || "#26211b";
      let drawing = false;
      let last = null;

      const pos = (ev) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
          y: ((ev.clientY - rect.top) / rect.height) * canvas.height
        };
      };

      canvas.addEventListener("pointerdown", (ev) => {
        drawing = true;
        last = pos(ev);
        strokes += 1;
        document.getElementById("learn-draw-meta").textContent = `Trazos: ${strokes}`;
        try { canvas.setPointerCapture?.(ev.pointerId); } catch {}
        refresh();
      });
      canvas.addEventListener("pointermove", (ev) => {
        if (!drawing) return;
        const next = pos(ev);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(next.x, next.y);
        ctx.stroke();
        last = next;
      });
      const stop = () => (drawing = false);
      canvas.addEventListener("pointerup", stop);
      canvas.addEventListener("pointercancel", stop);

      document.getElementById("learn-draw-clear").addEventListener("click", () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        strokes = 0;
        document.getElementById("learn-draw-meta").textContent = "Trazos: 0";
        refresh();
      });
    }

    saveBtn.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) {
        App.showToast("Escribe una reflexión antes de guardarla");
        return;
      }
      saveBtn.disabled = true;
      try {
        const res = await API.saveNotebookEntry(this.lesson.id, text, this.lesson.track_title);
        LearnNotebook.setEntries(res.notebook || []);
        App.showToast("Reflexión guardada en la libreta");
        saveBtn.textContent = "Guardado ✓";
      } catch (err) {
        App.showToast("No se pudo guardar la reflexión");
        saveBtn.disabled = false;
      }
    });

    continueBtn.addEventListener("click", () => {
      this.registerAnswer(true);
      this.advance();
    });
  },

  registerAnswer(ok) {
    this.totalFirst += 1;
    if (ok) {
      this.correctFirst += 1;
      this.bumpCombo(true);
    } else {
      this.bumpCombo(false);
      const item = this.queue[0];
      if (item && !item.review) this.failedQueue.push(item.step);
    }
  },

  bumpCombo(ok) {
    if (ok) {
      this.combo += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    } else {
      this.combo = 0;
    }
    const comboEl = document.getElementById("learn-combo");
    if (comboEl) comboEl.textContent = `🔥 x${this.combo}`;
  },

  showFeedback(ok, title, html) {
    const box = document.getElementById("learn-feedback");
    if (!box) return;
    box.innerHTML = `
      <div class="learn-feedback ${ok ? "is-ok" : "is-bad"}">
        <div class="learn-feedback-head">${ok ? "✓" : "✕"} ${this.escape(title)}</div>
        <div class="learn-feedback-body">${html}</div>
        <button type="button" class="btn-primary learn-continue-btn" id="learn-continue-btn" ${ok ? "" : "disabled"}>
          ${ok ? "Continuar" : "Leyendo ajuste (2s)..."}
        </button>
      </div>
    `;
    this.bindTerms(box);

    const btn = document.getElementById("learn-continue-btn");
    if (!ok) {
      if (this._feedbackTimer) clearTimeout(this._feedbackTimer);
      this._feedbackTimer = setTimeout(() => {
        this._feedbackTimer = null;
        if (!btn || !btn.isConnected) return;
        btn.disabled = false;
        btn.textContent = "Continuar";
      }, 2100);
    }
    btn?.addEventListener("click", () => this.advance());
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  advance() {
    if (!this.queue.length) return;
    this.queue.shift();
    this.completedSteps += 1;
    const fill = document.getElementById("learn-progress-fill");
    if (fill) {
      const pct = Math.min(100, (this.completedSteps / Math.max(1, this.totalMainSteps)) * 100);
      fill.style.width = `${Math.max(pct, 6)}%`;
    }
    this.renderCurrent();
    document.getElementById("learn-step-body")?.scrollIntoView({ behavior: "smooth", block: "start" });
  },

  async finish() {
    const accuracy = this.totalFirst ? Math.round((this.correctFirst / this.totalFirst) * 100) : 100;
    const body = document.getElementById("learn-step-body");
    const feedback = document.getElementById("learn-feedback");
    if (feedback) feedback.innerHTML = "";
    LearnAudio.finish();

    let result = null;
    try {
      result = await API.completeLesson(this.lesson.id, accuracy);
    } catch (err) {
      console.error("Error completando lección:", err);
    }

    const hlr = result && result.hlr ? result.hlr : null;
    const recall = hlr ? Math.round((hlr.recall || 0) * 100) : 0;
    const halfLife = hlr ? hlr.half_life_days : 4;
    const days = Math.max(1, Math.round(halfLife * 0.415));

    if (body) {
      body.innerHTML = `
        <div class="learn-finish">
          <div class="learn-finish-emoji">🏅</div>
          <h2 class="serif-heading">Lección completada</h2>
          <p class="learn-finish-sub">${this.escape(this.lesson.title)} · ${this.escape(this.lesson.track_title || "")}</p>
          <div class="learn-finish-stats">
            <div><b>${accuracy}%</b><span>Precisión</span></div>
            <div><b>+${result ? result.exp_gain : this.lesson.exp}</b><span>EXP</span></div>
            <div><b>x${this.maxCombo}</b><span>Mejor combo</span></div>
            <div><b>${days} d</b><span>Próximo repaso</span></div>
          </div>
          <div class="learn-finish-hlr">
            Memoria estimada: <b>${recall}%</b> · vida media ${halfLife} días.
            ${hlr && hlr.status === "repasar" ? "El nodo queda marcado para repasar." : "El nodo queda dominado por ahora."}
          </div>
          <div class="learn-finish-actions">
            <button type="button" class="btn-primary" id="learn-finish-map">Volver al mapa</button>
            <button type="button" class="btn-secondary" id="learn-finish-repeat">Repetir lección</button>
          </div>
        </div>
      `;
      document.getElementById("learn-finish-map").addEventListener("click", () => this.exit());
      document.getElementById("learn-finish-repeat").addEventListener("click", () => this.start(this.lesson.id));
    }

    if (result && result.state && LearnMapComponent) {
      LearnMapComponent.state = result.state;
      LearnMapComponent.render();
    }
    if (result && result.companion && App) {
      if (App.userProfile) App.userProfile.companion = result.companion;
      if (App.updateAdventurerBanner) {
        App.updateAdventurerBanner(result.companion, result.adventurer_title || "Explorador Consciente");
      }
    }
  },

  escape(str) {
    return API.escapeHtml(str);
  }
};
