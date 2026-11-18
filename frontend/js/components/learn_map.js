/**
 * Mapa de rutas de Aprender — estilo "camino" tipo Duolingo.
 *
 * Cada ruta es una unidad con banner de color, un sendero serpenteante de
 * nodos circulares con relieve 3D, burbuja EMPEZAR en el nodo actual, cofre
 * al final de la unidad y trofeo cuando la unidad está dominada.
 *
 * La lógica de desbloqueo y el estado HLR vienen del backend sin cambios.
 */

const LearnMapComponent = {
  state: null,
  loading: false,

  // Desplazamiento horizontal del sendero (unidades de --path-unit).
  PATH_SHAPE: [0, 8, 17, 8, 0, -8, -17, -8],

  init() {
    LearnAudio.initButton();
    LearnNotebook.init();
  },

  async loadState() {
    if (this.loading) return;
    this.loading = true;
    try {
      const state = await API.getLearningState();
      this.state = state;
      LearnNotebook.setEntries(state.notebook || []);
      this.render();
    } catch (err) {
      console.error("Error cargando Aprender:", err);
      const map = document.getElementById("learn-map");
      if (map) map.innerHTML = `<div class="learn-loading">No se pudieron cargar las rutas. Revisa que el servidor esté activo.</div>`;
    } finally {
      this.loading = false;
    }
  },

  render() {
    if (!this.state) return;
    this.renderRecommendation();

    const map = document.getElementById("learn-map");
    if (!map) return;

    const tracks = this.state.tracks || [];
    const totalLessons = tracks.reduce((acc, t) => acc + t.total_count, 0);
    const completed = tracks.reduce((acc, t) => acc + t.completed_count, 0);
    const due = (this.state.due_lessons || []).length;
    const appProfile = typeof App !== "undefined" && App ? App.userProfile : null;
    const companion = this.state.companion || (appProfile ? appProfile.companion : null) || {};

    const unitsHtml = tracks
      .map((track, index) => this.renderUnit(track, index, companion))
      .join("");

    map.innerHTML = `
      <div class="duo-shell">
        ${this.renderHud(companion, completed, totalLessons, due)}
        <div class="duo-units">${unitsHtml}</div>
        <p class="duo-footnote">Sesiones de 3–4 min · Sin castigos por perder días: la constancia amable también cuenta.</p>
      </div>
    `;

    map.querySelectorAll("[data-lesson]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        LearnAudio.unlock();
        LearnLesson.start(btn.dataset.lesson);
      });
    });

    map.querySelectorAll("[data-chest]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const track = tracks.find((t) => t.id === btn.dataset.chest);
        if (track) this.openChest(track);
      });
    });

    map.querySelectorAll("[data-guide]").forEach((btn) => {
      btn.addEventListener("click", () => LearnNotebook.open());
    });
  },

  renderHud(companion, completed, totalLessons, due) {
    const level = companion.level || 1;
    const coins = companion.coins != null ? companion.coins : 0;
    return `
      <div class="duo-hud" role="status" aria-label="Progreso de Aprender">
        <div class="duo-hud-chip" title="Nivel de tu compañero">
          <span class="duo-hud-ico">🐣</span><b>Nv. ${level}</b>
        </div>
        <div class="duo-hud-chip" title="Monedas disponibles">
          <span class="duo-hud-ico">🪙</span><b>${coins}</b>
        </div>
        <div class="duo-hud-chip" title="Lecciones completadas">
          <span class="duo-hud-ico">📚</span><b>${completed}/${totalLessons}</b>
        </div>
        <div class="duo-hud-chip ${due > 0 ? "is-due" : ""}" title="Lecciones para repasar hoy">
          <span class="duo-hud-ico">↻</span><b>${due}</b><span class="duo-hud-label">repaso</span>
        </div>
      </div>
    `;
  },

  renderUnit(track, index, companion) {
    const lessons = track.lessons || [];
    const accent = track.accent || "#a84b08";
    const accentDark = this.shade(accent, -22);
    const accentSoft = this.hexToRgba(accent, 0.16);
    const direction = index % 2 === 0 ? 1 : -1;
    const complete = track.completed_count >= track.total_count && track.total_count > 0;

    const nodes = lessons
      .map((lesson, lessonIndex) => {
        const prev = lessonIndex > 0 ? lessons[lessonIndex - 1] : null;
        const locked = lessonIndex > 0 && !lesson.completed && !(prev && prev.completed);
        const isCurrent = !locked && !lesson.completed && !lessons.slice(0, lessonIndex).some((l) => !l.completed);
        const dx = (this.PATH_SHAPE[lessonIndex % this.PATH_SHAPE.length] || 0) * direction;
        return this.renderNode(lesson, { locked, isCurrent, dx, accent, accentDark });
      })
      .join("");

    const chestDx = (this.PATH_SHAPE[lessons.length % this.PATH_SHAPE.length] || 0) * direction;
    const chest = `
      <div class="duo-row duo-row--chest" style="--dx:${chestDx}">
        <button type="button" class="duo-node duo-node--chest ${complete ? "is-open" : "is-locked"}"
                data-chest="${this.escape(track.id)}"
                title="${complete ? "Abrir cofre de la unidad" : "Completa los niveles para abrir el cofre"}"
                ${complete ? "" : "disabled"}>
          <span class="duo-node-ico duo-chest-ico">${this.chestSvg()}</span>
        </button>
        <span class="duo-caption">${complete ? "Cofre listo" : "Cofre de unidad"}</span>
      </div>
    `;

    const trophy = complete
      ? `
        <div class="duo-trophy" aria-label="Unidad dominada">
          <div class="duo-trophy-medal">🏆</div>
          <span>Unidad dominada</span>
        </div>
      `
      : "";

    const mascot = index === 0 ? this.renderMascot(companion, track) : "";

    return `
      <article class="duo-unit" style="--unit:${accent};--unit-dark:${accentDark};--unit-soft:${accentSoft}">
        <header class="duo-banner">
          <div class="duo-banner-copy">
            <span class="duo-banner-kicker">Ruta ${index + 1} · Unidad ${index + 1} · ${track.completed_count}/${track.total_count}</span>
            <h3 class="duo-banner-title">${track.icon || "📘"} ${this.escape(track.title)}</h3>
            <p class="duo-banner-sub">${this.escape(track.subtitle || "")}</p>
          </div>
          <button type="button" class="duo-guide-btn" data-guide title="Abrir la libreta de la ruta" aria-label="Abrir libreta">📖</button>
          <div class="duo-banner-progress" aria-hidden="true">
            <span style="width:${Math.max(0, Math.min(100, track.progress_pct))}%"></span>
          </div>
        </header>
        <div class="duo-path">
          ${mascot}
          ${nodes}
          ${chest}
          ${trophy}
        </div>
      </article>
    `;
  },

  renderNode(lesson, { locked, isCurrent, dx, accent, accentDark }) {
    const review = lesson.completed && lesson.status === "repasar";
    const done = lesson.completed && !review;
    const stateClass = review ? "is-review" : done ? "is-done" : locked ? "is-locked" : "is-open";
    const color = locked ? "#cfd4da" : review ? "#f0a020" : accent;
    const dark = locked ? "#a9b0b8" : review ? "#c47f0d" : accentDark;
    const icon = review ? "↻" : done ? "✓" : locked ? "🔒" : "★";
    const caption = isCurrent
      ? `<span class="duo-caption duo-caption--current">Nivel ${lesson.level} · ${this.escape(lesson.title)}</span>`
      : "";

    return `
      <div class="duo-row ${isCurrent ? "is-current" : ""}" style="--dx:${dx}">
        ${isCurrent ? `<span class="duo-start">EMPEZAR</span>` : ""}
        <button type="button"
                class="duo-node ${stateClass}"
                style="--node:${color};--node-dark:${dark}"
                data-lesson="${this.escape(lesson.id)}"
                ${locked ? "disabled" : ""}
                title="${this.escape(this.nodeTooltip(lesson, { locked, review, done }))}"
                aria-label="${this.escape(lesson.title)}">
          <span class="duo-node-ico">${icon}</span>
          ${locked ? "" : `<span class="duo-node-badge">${lesson.level}</span>`}
        </button>
        ${caption}
      </div>
    `;
  },

  chestSvg() {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <path d="M9 30c0-8.6 10.3-13.2 23-13.2S55 21.4 55 30v3H9z" fill="currentColor"/>
        <rect x="9" y="31" width="46" height="22" rx="4" fill="currentColor" opacity="0.92"/>
        <rect x="9" y="31" width="46" height="5" fill="#000" opacity="0.14"/>
        <rect x="26.5" y="32.5" width="11" height="12" rx="2.2" fill="var(--bg-card, #fcfaf3)"/>
        <circle cx="32" cy="38" r="2.3" fill="currentColor"/>
        <rect x="30.5" y="38.6" width="3" height="5.2" rx="1.5" fill="currentColor"/>
      </svg>
    `;
  },

  nodeTooltip(lesson, { locked, review, done }) {
    if (locked) return `${lesson.title} · se abre al completar el nivel anterior`;
    if (review) return `${lesson.title} · repasar (recuerdo ${Math.round((lesson.recall || 0) * 100)}%)`;
    if (done) return `${lesson.title} · dominado (recuerdo ${Math.round((lesson.recall || 0) * 100)}%)`;
    return `${lesson.title} · ${lesson.minutes} min · +${lesson.exp} EXP`;
  },

  renderMascot(companion, track) {
    if (typeof PixelSprites === "undefined") return "";
    const variant = companion.variant || "slime_azul";
    const filled = Math.round((track.progress_pct / 100) * 3);
    const stars = [0, 1, 2]
      .map((i) => `<span class="duo-mascot-star ${i < filled ? "is-on" : ""}">★</span>`)
      .join("");
    return `
      <div class="duo-mascot" aria-hidden="true">
        ${PixelSprites.slime(variant, 104)}
        <div class="duo-mascot-stars">${stars}</div>
      </div>
    `;
  },

  openChest(track) {
    const lessons = track.lessons || [];
    const accuracies = lessons
      .filter((l) => l.completed && l.best_accuracy != null)
      .map((l) => l.best_accuracy);
    const avg = accuracies.length
      ? Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length)
      : 100;
    const message = `🎁 ${track.title}: ${track.completed_count}/${track.total_count} niveles · precisión media ${avg}%.`;
    if (App && App.showToast) App.showToast(message);
    LearnAudio.finish();
  },

  renderRecommendation() {
    const box = document.getElementById("learn-recommendation");
    if (!box) return;
    const rec = this.state ? this.state.recommendation : null;
    if (!rec) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `
      <div class="duo-rec">
        <span class="duo-rec-icon">💡</span>
        <div class="duo-rec-text">${this.escape(rec.message)}</div>
        <button type="button" class="duo-rec-go" id="learn-rec-go">Ver ruta</button>
      </div>
    `;
    const go = document.getElementById("learn-rec-go");
    if (go) {
      go.addEventListener("click", () => {
        const target = document.querySelector(`[data-lesson^="${rec.track_id}_"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.focus?.();
        }
      });
    }
  },

  /* ---------- utilidades de color ---------- */

  shade(hex, percent) {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return hex;
    const factor = 1 + percent / 100;
    const channel = (value) => Math.max(0, Math.min(255, Math.round(value * factor)));
    return `rgb(${channel(rgb.r)}, ${channel(rgb.g)}, ${channel(rgb.b)})`;
  },

  hexToRgba(hex, alpha) {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return `rgba(168, 75, 8, ${alpha})`;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  },

  hexToRgb(hex) {
    const value = String(hex || "").trim().replace("#", "");
    if (value.length === 3) {
      return {
        r: parseInt(value[0] + value[0], 16),
        g: parseInt(value[1] + value[1], 16),
        b: parseInt(value[2] + value[2], 16)
      };
    }
    if (value.length !== 6) return null;
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  },

  escape(str) {
    return API.escapeHtml(str);
  }
};
