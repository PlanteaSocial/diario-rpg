/**
 * Libreta de Aprender: reflexiones locales para terapia o relectura.
 */

const LearnNotebook = {
  entries: [],

  init() {
    const modal = document.getElementById("learn-notebook-modal");
    const openBtn = document.getElementById("learn-notebook-btn");
    const closeBtn = document.getElementById("learn-notebook-close-btn");
    const copyBtn = document.getElementById("learn-notebook-copy-btn");

    if (openBtn) openBtn.addEventListener("click", () => this.open());
    if (closeBtn && modal) closeBtn.addEventListener("click", () => modal.classList.remove("active"));
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    }
    if (copyBtn) copyBtn.addEventListener("click", () => this.copyAll());
  },

  setEntries(entries) {
    this.entries = Array.isArray(entries) ? entries : [];
    const count = document.getElementById("learn-notebook-count");
    if (count) count.textContent = String(this.entries.length);
  },

  async open() {
    const modal = document.getElementById("learn-notebook-modal");
    if (!modal) return;
    modal.classList.add("active");
    try {
      const state = await API.getLearningState();
      this.setEntries(state.notebook || []);
    } catch (err) {
      console.error("Error cargando libreta:", err);
    }
    this.render();
  },

  render() {
    const list = document.getElementById("learn-notebook-list");
    if (!list) return;

    if (!this.entries.length) {
      list.innerHTML = `
        <div class="learn-notebook-empty">
          <span>📓</span>
          <p>Aún no hay reflexiones guardadas. Al terminar una lección puedes guardar tu respuesta desde el paso de reflexión.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = this.entries
      .map(
        (entry) => `
        <article class="learn-notebook-item" data-id="${entry.id}">
          <div class="learn-notebook-item-head">
            <span class="learn-notebook-track">${this.escape(entry.track_title)}</span>
            <span class="learn-notebook-date">${this.formatDate(entry.created_at)}</span>
          </div>
          <p class="learn-notebook-text">${this.escape(entry.statement_text)}</p>
          <div class="learn-notebook-item-actions">
            <button type="button" class="learn-mini-btn" data-copy="${entry.id}">Copiar</button>
            <button type="button" class="learn-mini-btn learn-mini-danger" data-delete="${entry.id}">Eliminar</button>
          </div>
        </article>
      `
      )
      .join("");

    list.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = this.entries.find((e) => String(e.id) === btn.dataset.copy);
        if (entry) this.copyText(entry.statement_text);
      });
    });
    list.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await API.deleteNotebookEntry(btn.dataset.delete);
          this.setEntries(res.notebook || []);
          this.render();
          App.showToast("Apunte eliminado de la libreta");
        } catch (err) {
          App.showToast("No se pudo eliminar el apunte");
        }
      });
    });
  },

  copyAll() {
    if (!this.entries.length) {
      App.showToast("La libreta está vacía");
      return;
    }
    const text = this.entries
      .map((e) => `• ${e.track_title} (${this.formatDate(e.created_at)})\n${e.statement_text}`)
      .join("\n\n");
    this.copyText(text);
  },

  copyText(text) {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => App.showToast("Copiado al portapapeles"))
      .catch(() => App.showToast("No se pudo copiar automáticamente"));
  },

  formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "";
    }
  },

  escape(str) {
    return API.escapeHtml(str);
  }
};
