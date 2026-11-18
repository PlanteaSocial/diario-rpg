/**
 * Componente: Notas Rápidas (Messaging Style)
 * Permite capturar pensamientos breves en cualquier momento con HH:MM instantáneo.
 */

const QuickNotesComponent = {
  currentDate: "",
  notes: [],
  isInitialized: false,

  init(date) {
    this.currentDate = date;
    if (!this.isInitialized) {
      const input = document.getElementById("quick-note-input");
      const sendBtn = document.getElementById("quick-note-send-btn");

      if (sendBtn) {
        sendBtn.addEventListener("click", () => this.sendNote());
      }

      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.sendNote();
          }
        });
      }
      this.isInitialized = true;
    }

    this.loadNotes();
  },

  async loadNotes() {
    try {
      this.notes = await API.getQuickNotes(this.currentDate);
      this.renderChips();
      if (App && App.updateDailyGoalProgress) App.updateDailyGoalProgress();
    } catch (err) {
      console.error("Error al cargar notas rápidas:", err);
    }
  },

  async sendNote() {
    const input = document.getElementById("quick-note-input");
    const text = input.value.trim();
    if (!text) return;

    // Calcular HH:MM local
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const timeStr = `${hours}:${minutes}`;

    try {
      const saved = await API.createQuickNote(this.currentDate, timeStr, text);
      this.notes.push(saved);
      input.value = "";
      this.renderChips();
      if (App && App.updateDailyGoalProgress) App.updateDailyGoalProgress();
      if (App && App.refreshCompanionBanner) App.refreshCompanionBanner();
      App.showToast("Nota rápida guardada (+5 EXP, +2 🪙)");
    } catch (err) {
      App.showToast("Error al guardar nota");
      console.error(err);
    }
  },

  renderChips() {
    const wrapper = document.getElementById("quick-chips-wrapper");
    const container = document.getElementById("quick-chips-list");
    const countEl = document.getElementById("quick-notes-count");
    const emptyEl = document.getElementById("quick-notes-empty");
    const total = this.notes ? this.notes.length : 0;

    if (countEl) countEl.textContent = String(total);
    if (emptyEl) emptyEl.style.display = total === 0 ? "block" : "none";

    if (!wrapper || !container) return;

    if (total === 0) {
      wrapper.style.display = "none";
      container.innerHTML = "";
      return;
    }

    wrapper.style.display = "block";
    container.innerHTML = this.notes
      .map(
        (n) => `
        <div class="quick-chip">
          <span class="quick-chip-time">${n.time}</span>
          <span>${this.escapeHtml(n.text)}</span>
        </div>
      `
      )
      .join("");
  },

  escapeHtml(str) {
    return API.escapeHtml(str);
  }
};
