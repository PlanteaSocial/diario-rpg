/**
 * Componente: Historial Cronológico + Calendario Visual de Ánimo
 * Muestra un calendario mensual interactivo por color de valencia y lista cronológica detallada.
 */

const HistoryComponent = {
  entries: [],
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(), // 0..11

  init() {
    if (this._bound) return;
    this._bound = true;
    this.setupModal();
    this.setupCalendarNav();
  },

  setupModal() {
    const modal = document.getElementById("detail-modal");
    const closeBtn = document.getElementById("modal-close-btn");

    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.remove("active"));
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    }
  },

  setupCalendarNav() {
    const prevBtn = document.getElementById("cal-prev-month-btn");
    const nextBtn = document.getElementById("cal-next-month-btn");

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        this._hasManualMonthNav = true;
        this.viewMonth -= 1;
        if (this.viewMonth < 0) {
          this.viewMonth = 11;
          this.viewYear -= 1;
        }
        this.renderCalendar();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        this._hasManualMonthNav = true;
        this.viewMonth += 1;
        if (this.viewMonth > 11) {
          this.viewMonth = 0;
          this.viewYear += 1;
        }
        this.renderCalendar();
      });
    }
  },

  getValenceLevel(entry) {
    const score = entry.laya_profile
      ? entry.laya_profile.valencia_score_estimada
      : entry.questionnaire.valence_rating;
    const isRedAlert = Boolean(
      entry.safety && entry.safety.is_triggered && entry.safety.level === "alert"
    );

    if (isRedAlert || score <= 2.0) {
      return { cls: "mood-very-neg", label: "Muy difícil", score, isRedAlert };
    }
    if (score >= 4.2) return { cls: "mood-very-pos", label: "Muy positivo", score, isRedAlert };
    if (score >= 3.4) return { cls: "mood-pos", label: "Positivo", score, isRedAlert };
    if (score >= 2.6) return { cls: "mood-neutral", label: "Neutro", score, isRedAlert };
    return { cls: "mood-neg", label: "Tenso", score, isRedAlert };
  },

  async loadHistory() {
    const container = document.getElementById("history-container");
    if (!container) return;

    try {
      this.entries = await API.getHistory();

      // Si hay entradas, situar calendario en el mes del último registro si el usuario no ha navegado manualmente
      if (this.entries && this.entries.length > 0 && !this._hasManualMonthNav) {
        const [y, m] = this.entries[0].date.split("-").map(Number);
        this.viewYear = y;
        this.viewMonth = m - 1;
      }

      this.renderCalendar();

      if (!this.entries || this.entries.length === 0) {
        container.innerHTML = `
          <div class="card" style="text-align: center; color: var(--text-tertiary); padding: 3rem 1rem;">
            Aún no hay días registrados. Comienza escribiendo tu primer escrito en la pestaña "Hoy".
          </div>
        `;
        return;
      }

      container.innerHTML = this.entries
        .map((entry) => {
          const q = entry.questionnaire;
          const hasDiscrepancy = entry.discrepancy && entry.discrepancy.has_discrepancy;
          const pEmotion = entry.laya_profile ? entry.laya_profile.emocion_primaria.choice : "registrado";
          const snippet = entry.day_text ? entry.day_text : "Solo notas rápidas y cuestionario";
          const mood = this.getValenceLevel(entry);

          return `
            <div class="history-item" onclick="HistoryComponent.showDetail('${entry.date}')">
              <div style="display: flex; align-items: center; gap: 0.9rem; min-width: 0;">
                <span class="calendar-dot-inline ${mood.cls}" title="${mood.label} (${mood.score}/5)"></span>
                <div style="min-width: 0;">
                  <div class="history-date">${this.formatDate(entry.date)}</div>
                  <div class="history-preview">${this.escapeHtml(snippet)}</div>
                </div>
              </div>
              <div style="display: flex; gap: 0.45rem; align-items: center; flex-wrap: wrap;">
                <span class="badge-pill">Ánimo: ${mood.score.toFixed(1)}/5</span>
                <span class="badge-pill">Sueño: ${q.sleep_hours}h</span>
                <span class="badge-pill">Carga: ${q.workload_rating}/5</span>
                <span class="badge-pill" style="color: var(--accent-indigo); text-transform: capitalize;">${this.escapeHtml(pEmotion)}</span>
                ${hasDiscrepancy ? '<span class="badge-pill warning">✦ Discrepancia</span>' : ''}
              </div>
            </div>
          `;
        })
        .join("");
    } catch (err) {
      container.innerHTML = `<div class="card" style="color: var(--accent-red);">Error al cargar historial.</div>`;
      console.error(err);
    }
  },

  renderCalendar() {
    const titleEl = document.getElementById("cal-month-title");
    const gridEl = document.getElementById("cal-days-grid");
    if (!titleEl || !gridEl) return;

    const firstDayDate = new Date(this.viewYear, this.viewMonth, 1);
    const monthName = firstDayDate.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    titleEl.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    // Mapear entradas por YYYY-MM-DD
    const entryMap = {};
    (this.entries || []).forEach((e) => {
      entryMap[e.date] = e;
    });

    // Lunes=0 .. Domingo=6
    const jsStartDay = firstDayDate.getDay(); // 0=Dom..6=Sab
    const startOffset = jsStartDay === 0 ? 6 : jsStartDay - 1;
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();

    let cellsHtml = "";
    for (let i = 0; i < startOffset; i++) {
      cellsHtml += `<div class="cal-cell empty"></div>`;
    }

    const mmStr = String(this.viewMonth + 1).padStart(2, "0");
    for (let day = 1; day <= daysInMonth; day++) {
      const ddStr = String(day).padStart(2, "0");
      const dateStr = `${this.viewYear}-${mmStr}-${ddStr}`;
      const entry = entryMap[dateStr];
      const isToday = App && App.todayRealStr === dateStr;

      if (entry) {
        const mood = this.getValenceLevel(entry);
        const hasDisc = entry.discrepancy && entry.discrepancy.has_discrepancy;
        const alertNote = mood.isRedAlert ? " · Alerta de seguridad" : "";
        cellsHtml += `
          <button type="button" class="cal-cell has-entry ${mood.cls} ${isToday ? "is-today" : ""}"
            onclick="HistoryComponent.showDetail('${dateStr}')"
            title="${dateStr}: ${mood.label} (${mood.score}/5)${alertNote}">
            <span class="cal-day-num">${day}</span>
            <span class="cal-mood-dot"></span>
            ${hasDisc ? '<span class="cal-disc-mark" title="Discrepancia">✦</span>' : ''}
          </button>
        `;
      } else {
        cellsHtml += `
          <button type="button" class="cal-cell ${isToday ? "is-today" : ""}"
            onclick="HistoryComponent.editDate('${dateStr}')"
            title="Escribir entrada para ${dateStr}">
            <span class="cal-day-num">${day}</span>
          </button>
        `;
      }
    }

    gridEl.innerHTML = cellsHtml;
  },

  editDate(dateStr) {
    const modal = document.getElementById("detail-modal");
    if (modal) modal.classList.remove("active");
    if (App && App.jumpToTabAndDate) {
      App.jumpToTabAndDate("hoy", dateStr);
    }
  },

  showDetail(date) {
    const entry = this.entries.find((e) => e.date === date);
    if (!entry) return;

    const modal = document.getElementById("detail-modal");
    const title = document.getElementById("modal-date-title");
    const content = document.getElementById("modal-body-content");

    title.textContent = this.formatDate(entry.date);

    let quickHtml = "";
    if (entry.quick_notes && entry.quick_notes.length > 0) {
      quickHtml = `
        <div style="margin-bottom: 1.25rem;">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 0.5rem;">Notas Rápidas:</h4>
          <div style="display: flex; flex-direction: column; gap: 0.35rem;">
            ${entry.quick_notes
              .map(
                (qn) => `
              <div style="background: var(--bg-card-subtle); padding: 0.45rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.88rem;">
                <span style="font-weight: 600; color: var(--accent-blue);">${qn.time}</span> - ${this.escapeHtml(qn.text)}
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `;
    }

    let goalHtml = "";
    if (entry.goal_alignment && entry.goal_alignment.signals && entry.goal_alignment.signals.length > 0) {
      goalHtml = `
        <div style="margin-top: 1.25rem; border-top: 1px solid var(--border-subtle); padding-top: 1rem;">
          <h4 style="font-size: 0.88rem; margin-bottom: 0.5rem; color: var(--accent-blue);">Cruce con tus Metas (${entry.goal_alignment.adherence_score}%):</h4>
          <div style="display: flex; flex-direction: column; gap: 0.4rem;">
            ${entry.goal_alignment.signals
              .map(
                (s) => `
              <div style="font-size: 0.84rem; color: var(--text-secondary); background: var(--bg-card-subtle); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm);">
                <b>${this.escapeHtml(s.area)}:</b> ${this.escapeHtml(s.signal)}
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `;
    }

    let layaHtml = "";
    if (entry.laya_profile) {
      const lp = entry.laya_profile;
      layaHtml = `
        <div style="margin-top: 1.25rem; border-top: 1px solid var(--border-subtle); padding-top: 1rem;">
          <h4 style="font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--accent-indigo);">Perfil Detectado por Laya AI:</h4>
          <div style="font-size: 0.85rem; line-height: 1.6; color: var(--text-secondary);">
            • <b>Valencia:</b> ${this.escapeHtml(lp.valencia_emocional.choice)} (${(lp.valencia_emocional.answer_confidence * 100).toFixed(1)}% confianza)<br>
            • <b>Activación:</b> ${this.escapeHtml(lp.activacion_energia.choice)}<br>
            • <b>Emoción principal:</b> ${this.escapeHtml(lp.emocion_primaria.choice)}<br>
            • <b>Puntaje ponderado continuo:</b> ${lp.valencia_score_estimada} / 5.0
          </div>
        </div>
      `;
    }

    content.innerHTML = `
      <div style="font-size: 1rem; line-height: 1.65; white-space: pre-wrap; margin-bottom: 1.25rem;">
        ${entry.day_text ? this.escapeHtml(entry.day_text) : '<i>(Sin texto principal)</i>'}
      </div>
      ${quickHtml}
      <div style="background: var(--bg-card-subtle); padding: 0.85rem; border-radius: var(--radius-md); font-size: 0.85rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
        <div><b>Sueño:</b> ${this.escapeHtml(entry.questionnaire.sleep_hours)} horas</div>
        <div><b>Alimentación a tiempo:</b> ${this.escapeHtml(entry.questionnaire.food_routine)}</div>
        <div><b>Auto-reporte:</b> ${this.escapeHtml(entry.questionnaire.self_report_word)}</div>
        <div><b>Carga percibida:</b> ${this.escapeHtml(entry.questionnaire.workload_rating)} / 5</div>
      </div>
      ${goalHtml}
      ${layaHtml}
      <div style="margin-top: 1.5rem; display: flex; justify-content: flex-end;">
        <button class="btn-secondary" onclick="HistoryComponent.editDate('${entry.date}')">✏️ Ir a editar este día</button>
      </div>
    `;

    modal.classList.add("active");
  },

  formatDate(dateStr) {
    try {
      const [y, m, d] = dateStr.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.toLocaleDateString("es-ES", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });
    } catch {
      return dateStr;
    }
  },

  escapeHtml(str) {
    return API.escapeHtml(str);
  }
};
