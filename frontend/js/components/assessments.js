/**
 * Componente: Autoconocimiento & Retos de Hábitos (Estrictamente No Clínico)
 * Cuestionarios breves e interactivos de autoconocimiento práctico que alimentan
 * el radar personal del usuario. Cero diagnósticos ni términos clínicos.
 */

const AssessmentsComponent = {
  quizzes: [],
  history: [],
  personalRadar: {},
  activeQuiz: null,
  answers: {},

  init() {
    if (this._bound) return;
    this._bound = true;
    this.bindModalEvents();

    const canvas = document.getElementById("assessments-radar-canvas");
    const acc = canvas ? canvas.closest("details") : null;
    if (acc) {
      acc.addEventListener("toggle", () => {
        if (acc.open) this.renderRadar();
      });
    }
  },

  bindModalEvents() {
    const closeBtn = document.getElementById("quiz-modal-close-btn");
    const modal = document.getElementById("quiz-modal");
    const submitBtn = document.getElementById("quiz-submit-btn");

    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.remove("active"));
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    }

    if (submitBtn) {
      submitBtn.addEventListener("click", () => this.submitQuiz());
    }
  },

  async loadAssessments() {
    try {
      const data = await API.getAssessments();
      this.quizzes = data.quizzes || [];
      this.history = data.history || [];
      this.personalRadar = data.personal_radar || {};

      this.renderQuizzes();
      this.renderRadar();
      this.renderRecentHistory();
    } catch (err) {
      console.error("Error cargando autoevaluaciones:", err);
    }
  },

  renderRadar() {
    const canvas = document.getElementById("assessments-radar-canvas");
    if (!canvas) return;
    const labels = Object.keys(this.personalRadar);
    const values = Object.values(this.personalRadar);
    if (labels.length === 0) return;

    setTimeout(() => {
      RadarChartHelper.draw(canvas, labels, values, {
        strokeColor: "#5856d6",
        fillColor: "rgba(88, 86, 214, 0.2)"
      });
    }, 40);
  },

  renderQuizzes() {
    const grid = document.getElementById("quizzes-grid-container");
    if (!grid) return;

    grid.innerHTML = this.quizzes
      .map((q) => {
        const lastAttempt = this.history.find((h) => h.quiz_id === q.id);
        const statusHtml = lastAttempt
          ? `<div class="quiz-status-pill completed">✓ ${API.escapeHtml(lastAttempt.result_label)} (${Math.round(lastAttempt.score_pct)}%)</div>`
          : `<div class="quiz-status-pill pending">✦ Pendiente de explorar</div>`;

        return `
          <div class="quiz-card">
            <div class="quiz-card-top">
              <div class="quiz-icon-badge">${API.escapeHtml(q.icon)}</div>
              <span class="quiz-duration-tag">${API.escapeHtml(q.duration)}</span>
            </div>
            <h3 class="quiz-card-title">${API.escapeHtml(q.title)}</h3>
            <p class="quiz-card-desc">${API.escapeHtml(q.subtitle)}</p>
            <div class="quiz-axes-tags">
              ${q.axes.map((a) => `<span class="badge-pill">${API.escapeHtml(a)}</span>`).join("")}
            </div>
            ${statusHtml}
            <button class="btn-primary quiz-start-btn" onclick="AssessmentsComponent.openQuiz('${API.escapeHtml(q.id)}')">
              ${lastAttempt ? "Volver a explorar" : "Explorar ahora"}
            </button>
          </div>
        `;
      })
      .join("");
  },

  renderRecentHistory() {
    const container = document.getElementById("assessments-history-container");
    if (!container) return;

    if (!this.history || this.history.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-tertiary); font-size: 0.9rem; padding: 1rem 0;">
          Completa cualquiera de las tarjetas de autoconocimiento para ver cómo evoluciona tu radar de enfoque y recibir una sugerencia práctica.
        </div>
      `;
      return;
    }

    container.innerHTML = this.history
      .slice(0, 5)
      .map(
        (h) => `
        <div class="assessment-result-row">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; gap: 0.5rem;">
            <strong>${API.escapeHtml(h.quiz_title)}</strong>
            <span class="badge-pill" style="color: var(--accent-indigo);">${API.escapeHtml(h.result_label)}</span>
          </div>
          <p style="font-size: 0.88rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: 0.25rem;">
            ${API.escapeHtml(h.reflection_message)}
          </p>
          <span style="font-size: 0.75rem; color: var(--text-tertiary);">
            Registrado el ${new Date(h.created_at).toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      `
      )
      .join("");
  },

  openQuiz(quizId) {
    const quiz = this.quizzes.find((q) => q.id === quizId);
    if (!quiz) return;
    this.activeQuiz = quiz;
    this.answers = {};
    quiz.questions.forEach((q) => {
      this.answers[q.id] = 2;
    });

    const modal = document.getElementById("quiz-modal");
    const titleEl = document.getElementById("quiz-modal-title");
    const bodyEl = document.getElementById("quiz-modal-body");
    const resultBox = document.getElementById("quiz-modal-result");
    const submitBtn = document.getElementById("quiz-submit-btn");

    if (titleEl) titleEl.textContent = `${quiz.icon} ${quiz.title}`;
    if (resultBox) resultBox.style.display = "none";
    if (submitBtn) submitBtn.style.display = "inline-flex";

    const scaleOptions = [
      { val: 1, label: "Casi nunca" },
      { val: 2, label: "A veces" },
      { val: 3, label: "Frecuente" },
      { val: 4, label: "Casi siempre" }
    ];

    if (bodyEl) {
      bodyEl.innerHTML = quiz.questions
        .map(
          (q, idx) => `
          <div class="quiz-q-block">
            <div class="quiz-q-text">${idx + 1}. ${q.text}</div>
            <div class="pill-group" data-qid="${q.id}">
              ${scaleOptions
                .map(
                  (opt) => `
                <button type="button" class="pill-btn ${opt.val === 2 ? "active" : ""}" data-val="${opt.val}"
                  onclick="AssessmentsComponent.selectAnswer('${q.id}', ${opt.val}, this)">
                  ${opt.label}
                </button>
              `
                )
                .join("")}
            </div>
          </div>
        `
        )
        .join("");
      bodyEl.style.display = "block";
    }

    if (modal) modal.classList.add("active");
  },

  selectAnswer(qId, val, btnEl) {
    this.answers[qId] = val;
    const parent = btnEl.closest(".pill-group");
    if (parent) {
      parent.querySelectorAll(".pill-btn").forEach((b) => b.classList.remove("active"));
    }
    btnEl.classList.add("active");
  },

  async submitQuiz() {
    if (!this.activeQuiz) return;
    const submitBtn = document.getElementById("quiz-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Calculando perfil...";
    }

    try {
      const res = await API.submitAssessment(this.activeQuiz.id, this.answers);
      const assessment = res.assessment;
      this.personalRadar = res.personal_radar;

      const bodyEl = document.getElementById("quiz-modal-body");
      const resultBox = document.getElementById("quiz-modal-result");
      if (bodyEl) bodyEl.style.display = "none";
      if (submitBtn) submitBtn.style.display = "none";

      if (resultBox) {
        resultBox.style.display = "block";
        resultBox.innerHTML = `
          <div class="quiz-result-banner">
            <div style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-indigo); font-weight: 700;">
              ${API.escapeHtml(assessment.result_label)}
            </div>
            <p style="margin-top: 0.65rem; font-size: 0.98rem; line-height: 1.6; color: var(--text-primary);">
              ${API.escapeHtml(assessment.reflection_message)}
            </p>
            <div style="margin-top: 1rem; font-size: 0.82rem; color: var(--text-secondary);">
              ✓ Tu radar personal de enfoque se ha actualizado automáticamente.
            </div>
          </div>
        `;
      }

      await this.loadAssessments();
      if (App && res.companion && App.updateAdventurerBanner) {
        App.updateAdventurerBanner(res.companion);
      }
      App.showToast("Reto completado (+20 EXP, +8 🪙)");
    } catch (err) {
      console.error("Error enviando autoevaluación:", err);
      App.showToast("No se pudo guardar el reto");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Ver mi reflejo personal";
      }
    }
  }
};
