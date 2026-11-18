/**
 * Componente: Editor Zen del Día y Check-in Progresivo (1 pregunta a la vez)
 * Flujo sereno: Escribir (Enter o Continuar) -> Preguntas paso a paso (con botón Atrás) -> Guardar.
 */

const DayEditorComponent = {
  currentDate: "",
  currentEntry: null,
  currentStage: "write", // "write" | "checkin" | "saved"
  checkinStep: 1,        // 1..6
  totalSteps: 6,
  isInitialized: false,
  _autoAdvanceTimer: null,
  _goalDebounceTimer: null,

  init(date) {
    this.currentDate = date;
    if (!this.isInitialized) {
      this.setupPillGroups();
      this.setupSleepCalculator();
      this.setupActions();
      this.isInitialized = true;
    }
    this.loadEntry();
  },

  setStage(stage, step = 1) {
    this.currentStage = stage;
    this.checkinStep = step;

    const writeStage = document.getElementById("hoy-stage-write");
    const checkinStage = document.getElementById("hoy-stage-checkin");
    const savedStage = document.getElementById("hoy-stage-saved");

    if (writeStage) writeStage.style.display = stage === "write" ? "block" : "none";
    if (checkinStage) checkinStage.style.display = stage === "checkin" ? "block" : "none";
    if (savedStage) savedStage.style.display = stage === "saved" ? "block" : "none";

    if (stage === "checkin") {
      this.renderCheckinStep();
    }
    if (stage === "saved") {
      this.renderSavedSummaryCard();
    }
  },

  renderCheckinStep() {
    for (let i = 1; i <= this.totalSteps; i++) {
      const stepEl = document.getElementById(`checkin-step-${i}`);
      if (stepEl) stepEl.classList.toggle("active", i === this.checkinStep);
    }

    const fillEl = document.getElementById("checkin-progress-fill");
    const labelEl = document.getElementById("checkin-step-label");
    const nextBtn = document.getElementById("checkin-next-btn");
    const saveBtn = document.getElementById("save-day-btn");
    const previewEl = document.getElementById("checkin-note-preview-text");

    if (fillEl) fillEl.style.width = `${(this.checkinStep / this.totalSteps) * 100}%`;
    if (labelEl) labelEl.textContent = `Pregunta ${this.checkinStep} de ${this.totalSteps}`;

    if (previewEl) {
      const txt = (document.getElementById("day-text")?.value || "").trim();
      previewEl.textContent = txt ? `"${txt.slice(0, 75)}${txt.length > 75 ? "..." : ""}"` : "(Solo check-in sin nota larga)";
    }

    // Mostrar Siguiente en pasos 1..5, y Guardar en paso 6
    if (nextBtn) nextBtn.style.display = this.checkinStep < this.totalSteps ? "inline-flex" : "none";
    if (saveBtn) saveBtn.style.display = this.checkinStep === this.totalSteps ? "inline-flex" : "none";
  },

  goBackInCheckin() {
    if (this._autoAdvanceTimer) {
      clearTimeout(this._autoAdvanceTimer);
      this._autoAdvanceTimer = null;
    }
    if (this.checkinStep > 1) {
      this.checkinStep -= 1;
      this.renderCheckinStep();
    } else {
      // Desde paso 1 volver al editor de texto sin perder nada
      this.setStage("write");
      const textarea = document.getElementById("day-text");
      if (textarea) textarea.focus();
    }
  },

  goNextInCheckin() {
    if (this.checkinStep < this.totalSteps) {
      this.checkinStep += 1;
      this.renderCheckinStep();
    }
  },

  clearForm() {
    this.currentEntry = null;
    const textarea = document.getElementById("day-text");
    if (textarea) textarea.value = "";
    const bed = document.getElementById("sleep-bedtime");
    if (bed) bed.value = "23:00";
    const wake = document.getElementById("sleep-wakeup");
    if (wake) wake.value = "07:00";
    this.updateSleepDisplay(8.0);

    this.setActivePill("food-group", "si");
    this.setActivePill("self-report-group", "bien");
    this.setActivePill("valence-group", "3");
    this.setActivePill("energy-group", "3");
    this.setActivePill("workload-group", "3");

    const layaAccordion = document.getElementById("laya-details-accordion");
    if (layaAccordion) layaAccordion.open = false;
    const alertsCont = document.getElementById("alerts-container");
    if (alertsCont) alertsCont.innerHTML = "";
    const probsCont = document.getElementById("laya-probs-content");
    if (probsCont) probsCont.innerHTML = "";

    this.setStage("write", 1);
  },

  setupPillGroups() {
    const groups = [
      { id: "food-group", autoAdvance: true },
      { id: "self-report-group", autoAdvance: true },
      { id: "valence-group", autoAdvance: true },
      { id: "energy-group", autoAdvance: true },
      { id: "workload-group", autoAdvance: false } // Último paso: usuario pulsa Guardar Día
    ];

    groups.forEach(({ id, autoAdvance }) => {
      const container = document.getElementById(id);
      if (!container) return;

      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".pill-btn");
        if (!btn) return;

        container.querySelectorAll(".pill-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        if (autoAdvance && this.currentStage === "checkin") {
          if (this._autoAdvanceTimer) clearTimeout(this._autoAdvanceTimer);
          this._autoAdvanceTimer = setTimeout(() => {
            this.goNextInCheckin();
          }, 210);
        }
      });
    });
  },

  updateSleepDisplay(hoursNum) {
    const display = document.getElementById("sleep-hours-calc");
    const warning = document.getElementById("sleep-warning-banner");
    const hours = Number(hoursNum);
    if (!Number.isFinite(hours)) return;

    const labelHours = (hours > 14 && Number(hours.toFixed(1)) === 14.0)
      ? hours.toFixed(2)
      : hours.toFixed(1);

    if (display) {
      display.textContent = `${labelHours} horas de sueño`;
      display.classList.toggle("is-unusual", hours > 14);
    }

    if (warning) {
      if (hours > 14) {
        warning.style.display = "flex";
        warning.innerHTML = `<span>⚠️</span><span>Son <b>${labelHours} h</b>: revisa si se cruzó <b>a. m. / p. m.</b> al acostarte o despertar para no distorsionar tu promedio ni la gráfica.</span>`;
      } else {
        warning.style.display = "none";
        warning.innerHTML = "";
      }
    }
  },

  setupSleepCalculator() {
    const bed = document.getElementById("sleep-bedtime");
    const wake = document.getElementById("sleep-wakeup");

    const updateHours = () => {
      if (!bed || !wake) return;
      const bVal = bed.value;
      const wVal = wake.value;
      if (!bVal || !wVal) return;

      const [bH, bM] = bVal.split(":").map(Number);
      const [wH, wM] = wVal.split(":").map(Number);

      let bMinutes = bH * 60 + bM;
      let wMinutes = wH * 60 + wM;
      if (wMinutes <= bMinutes) wMinutes += 24 * 60;

      const diffHours = (wMinutes - bMinutes) / 60;
      this.updateSleepDisplay(diffHours);
    };

    if (bed && wake) {
      bed.addEventListener("change", updateHours);
      bed.addEventListener("input", updateHours);
      wake.addEventListener("change", updateHours);
      wake.addEventListener("input", updateHours);
    }
  },

  setupActions() {
    const continueBtn = document.getElementById("continue-to-checkin-btn");
    const backBtn = document.getElementById("checkin-back-btn");
    const nextBtn = document.getElementById("checkin-next-btn");
    const saveBtn = document.getElementById("save-day-btn");
    const editFromPreviewBtn = document.getElementById("checkin-edit-note-btn");
    const editSavedBtn = document.getElementById("saved-edit-btn");
    const dayTextEl = document.getElementById("day-text");
    const enterToggle = document.getElementById("enter-advances-chk");

    if (continueBtn) {
      continueBtn.addEventListener("click", () => this.setStage("checkin", 1));
    }

    if (backBtn) {
      backBtn.addEventListener("click", () => this.goBackInCheckin());
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => this.goNextInCheckin());
    }

    if (editFromPreviewBtn) {
      editFromPreviewBtn.addEventListener("click", () => {
        this.setStage("write");
        if (dayTextEl) dayTextEl.focus();
      });
    }

    if (editSavedBtn) {
      editSavedBtn.addEventListener("click", () => {
        this.setStage("write");
        if (dayTextEl) dayTextEl.focus();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", () => this.saveDay());
    }

    if (dayTextEl) {
      // Enter directo (sin Shift) o Ctrl+Enter avanza a las preguntas si el interruptor está activo
      dayTextEl.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        const enterEnabled = enterToggle ? enterToggle.checked : true;
        if (e.key === "Enter" && !e.shiftKey && (enterEnabled || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.setStage("checkin", 1);
        }
      });

      // Debounce de 400ms para evitar repintado en cada tecla
      dayTextEl.addEventListener("input", () => {
        if (this._goalDebounceTimer) clearTimeout(this._goalDebounceTimer);
        this._goalDebounceTimer = setTimeout(() => {
          if (App && App.updateDailyGoalProgress) App.updateDailyGoalProgress();
        }, 400);
      });
    }
  },

  async loadEntry() {
    this.clearForm();
    this.currentEntry = null;
    try {
      const entry = await API.getDayEntry(this.currentDate);
      if (entry) {
        this.currentEntry = entry;
        this.populateForm(entry);
        if (entry.laya_profile) {
          this.renderLayaProfile(entry.laya_profile, entry.user_corrections, entry.goal_alignment);
        }
        this.renderAlerts(entry.discrepancy, entry.safety);
        this.setStage("saved");
      }
      if (App && App.renderTodayRail) App.renderTodayRail(this.currentEntry);
      if (App && App.updateDailyGoalProgress) {
        App.updateDailyGoalProgress();
      }
    } catch (err) {
      console.error("Error al cargar entrada del día:", err);
    }
  },

  populateForm(entry) {
    const textarea = document.getElementById("day-text");
    if (textarea && entry.day_text) textarea.value = entry.day_text;

    const q = entry.questionnaire;
    if (!q) return;

    if (q.sleep_bedtime) document.getElementById("sleep-bedtime").value = q.sleep_bedtime;
    if (q.sleep_wakeup) document.getElementById("sleep-wakeup").value = q.sleep_wakeup;
    if (typeof q.sleep_hours === "number") {
      this.updateSleepDisplay(q.sleep_hours);
    }

    this.setActivePill("food-group", q.food_routine);
    this.setActivePill("self-report-group", q.self_report_word);
    this.setActivePill("valence-group", String(q.valence_rating));
    this.setActivePill("energy-group", String(q.energy_rating));
    this.setActivePill("workload-group", String(q.workload_rating));
  },

  renderSavedSummaryCard() {
    const box = document.getElementById("saved-day-summary-box");
    if (!box || !this.currentEntry) return;

    const e = this.currentEntry;
    const q = e.questionnaire;
    const textPreview = e.day_text
      ? `<p class="saved-text-excerpt">${this.escapeHtml(e.day_text)}</p>`
      : `<p class="saved-text-excerpt" style="opacity: 0.65; font-style: italic;">Check-in guardado sin nota extensa.</p>`;

    const emoBadge = e.laya_profile
      ? `<span class="badge-pill" style="color: var(--accent-indigo); text-transform: capitalize;">✦ ${this.escapeHtml(e.laya_profile.emocion_primaria.choice)}</span>`
      : "";

    const backendUsed = e.laya_profile && e.laya_profile.raw_usage ? e.laya_profile.raw_usage.backend : "";
    const tierBadge = backendUsed === "laya-onnx-q8-worker"
      ? `<span class="badge-pill" data-ml-tier="tier_1" title="Inferencia neuronal local en Web Worker ONNX">🧠 Laya ONNX Tier 1</span>`
      : (backendUsed ? `<span class="badge-pill" data-ml-tier="tier_0" title="Análisis sintáctico inmediato mientras prepara Tier 1">⚡ Sintaxis Tier 0</span>` : "");

    const refl = e.daily_reflection;
    const reflectionHtml = refl
      ? `
        <div class="daily-reflection-card ${refl.safety_locked ? "is-containment" : ""}">
          <div class="daily-reflection-head">
            <span>✦ ${this.escapeHtml(refl.title || "Crónica del día")}</span>
          </div>
          <p class="daily-reflection-chronicle">${this.escapeHtml(refl.chronicle || "")}</p>
          <p class="daily-reflection-suggestion">${this.escapeHtml(refl.suggestion || "")}</p>
        </div>
      `
      : "";

    box.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.85rem;">
        <span class="saved-status-chip">✓ Día guardado</span>
        <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
          <span class="badge-pill">🌙 ${this.escapeHtml(q.sleep_hours)}h</span>
          <span class="badge-pill">💬 ${this.escapeHtml(q.self_report_word)}</span>
          <span class="badge-pill">🌤️ Ánimo ${this.escapeHtml(q.valence_rating)}/5</span>
          ${emoBadge}
          ${tierBadge}
        </div>
      </div>
      ${textPreview}
      ${reflectionHtml}
    `;
  },

  onTier1Reconciled(updatedEntry) {
    if (!updatedEntry || updatedEntry.date !== this.currentDate) return;
    this.currentEntry = updatedEntry;
    this.renderSavedSummaryCard();
    if (updatedEntry.laya_profile) {
      this.renderLayaProfile(updatedEntry.laya_profile, updatedEntry.user_corrections, updatedEntry.goal_alignment);
    }
    this.renderAlerts(updatedEntry.discrepancy, updatedEntry.safety);
    if (typeof App !== "undefined" && App.renderTodayRail) {
      App.renderTodayRail(updatedEntry);
    }
    if (typeof App !== "undefined" && App.showToast) {
      App.showToast("Análisis semántico refinado en segundo plano (Tier 1 ONNX)");
    }
  },

  setActivePill(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll(".pill-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === value);
    });
  },

  getActivePill(groupId, defaultValue) {
    const group = document.getElementById(groupId);
    if (!group) return defaultValue;
    const active = group.querySelector(".pill-btn.active");
    return active ? active.dataset.val : defaultValue;
  },

  async saveDay() {
    const saveBtn = document.getElementById("save-day-btn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Analizando con Laya...";
    }

    const dayText = document.getElementById("day-text").value;
    const sleepBedtime = document.getElementById("sleep-bedtime").value;
    const sleepWakeup = document.getElementById("sleep-wakeup").value;

    const payload = {
      date: this.currentDate,
      day_text: dayText,
      questionnaire: {
        sleep_bedtime: sleepBedtime,
        sleep_wakeup: sleepWakeup,
        food_routine: this.getActivePill("food-group", "si"),
        self_report_word: this.getActivePill("self-report-group", "bien"),
        valence_rating: parseInt(this.getActivePill("valence-group", "3"), 10),
        energy_rating: parseInt(this.getActivePill("energy-group", "3"), 10),
        workload_rating: parseInt(this.getActivePill("workload-group", "3"), 10)
      }
    };

    try {
      const savedEntry = await API.saveDayEntry(payload);
      this.currentEntry = savedEntry;
      App.showToast("Día guardado serenamente");

      if (savedEntry.laya_profile) {
        this.renderLayaProfile(savedEntry.laya_profile, savedEntry.user_corrections, savedEntry.goal_alignment);
      }

      this.renderAlerts(savedEntry.discrepancy, savedEntry.safety);
      this.setStage("saved");

      if (App && App.updateDailyGoalProgress) {
        App.updateDailyGoalProgress();
      }
      if (App && App.renderTodayRail) {
        App.renderTodayRail(savedEntry);
      }
      if (App && App.renderLearnHint) {
        App.renderLearnHint();
      }
      if (App && App.refreshCompanionBanner) {
        App.refreshCompanionBanner();
      }
    } catch (err) {
      App.showToast("Error al guardar el día");
      console.error(err);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "✓ Guardar Día";
      }
    }
  },

  renderAlerts(discrepancy, safety) {
    const container = document.getElementById("alerts-container");
    if (!container) return;
    container.innerHTML = "";

    if (safety && safety.is_triggered) {
      if (safety.level === "alert") {
        const helplinesHtml = (safety.helplines || [])
          .map((h) => {
            const safeTel = String(h.contact || "").replace(/[^0-9+\-\s]/g, "").trim();
            return `
            <div class="helpline-item">
              • ${this.escapeHtml(h.name)}: <a href="tel:${this.escapeHtml(safeTel)}" style="color: inherit; text-decoration: underline;">${this.escapeHtml(h.contact)}</a>
              <span style="font-weight: normal; font-size: 0.8rem; opacity: 0.85;">(${this.escapeHtml(h.description)})</span>
            </div>
          `;
          })
          .join("");

        container.innerHTML += `
          <div class="alert-card safety crisis">
            <div class="alert-icon">🤍</div>
            <div class="alert-content">
              <h4>Espacio de Apoyo y Contención</h4>
              <p>${this.escapeHtml(safety.message)}</p>
              <div style="margin-top: 0.5rem;">${helplinesHtml}</div>
            </div>
          </div>
        `;
      } else if (safety.level === "pause") {
        container.innerHTML += `
          <div class="alert-card safety pause">
            <div class="alert-icon">🌿</div>
            <div class="alert-content">
              <h4>Momento de Pausa y Cuidado Personal</h4>
              <p>${this.escapeHtml(safety.message)}</p>
            </div>
          </div>
        `;
      }
    }

    if (discrepancy && discrepancy.has_discrepancy) {
      container.innerHTML += `
        <div class="alert-card discrepancy">
          <div class="alert-icon">✦</div>
          <div class="alert-content">
            <h4>Observación de Coherencia Emocional</h4>
            <p>${this.escapeHtml(discrepancy.message)}</p>
          </div>
        </div>
      `;
    }
  },

  renderLayaProfile(profile, corrections = {}, goalAlignment = null) {
    const container = document.getElementById("laya-probs-content");
    if (!container || !profile) return;

    let html = "";

    if (goalAlignment && goalAlignment.signals && goalAlignment.signals.length > 0) {
      html += `
        <div class="goal-alignment-box">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.45rem;">
            <strong style="font-size: 0.85rem; color: var(--accent-blue);">✦ Conexión con tus Metas Personales</strong>
            <span class="badge-pill">${goalAlignment.adherence_score}% alineado</span>
          </div>
          ${goalAlignment.signals
            .map(
              (s) => `
            <div class="goal-align-line">
              <b>${this.escapeHtml(s.area)}:</b> ${this.escapeHtml(s.signal)}
            </div>
          `
            )
            .join("")}
        </div>
      `;
    }

    html += this.renderProbSection(
      "Valencia Emocional",
      "valencia_emocional",
      profile.valencia_emocional,
      corrections["valencia_emocional"],
      ["muy_negativo", "negativo", "neutro", "positivo", "muy_positivo"]
    );

    html += this.renderProbSection(
      "Nivel de Activación / Energía",
      "activacion_energia",
      profile.activacion_energia,
      corrections["activacion_energia"],
      ["agotamiento_baja", "calma_estable", "tension_alta", "entusiasmo_alta"]
    );

    html += this.renderProbSection(
      "Emoción Dominante",
      "emocion_primaria",
      profile.emocion_primaria,
      corrections["emocion_primaria"],
      ["alegria", "calma", "estres", "tristeza", "frustracion", "ansiedad", "gratitud", "apatia"]
    );

    html += `<div style="margin-top: 1.25rem;"><h4 style="font-size: 0.92rem; margin-bottom: 0.5rem; color: var(--text-secondary);">Ejes Temáticos Detectados</h4>`;
    for (const [eje, prob] of Object.entries(profile.ejes_tematicos || {})) {
      const pct = (prob * 100).toFixed(1);
      html += `
        <div class="prob-bar-wrapper">
          <div class="prob-bar-label">
            <span>${eje.replace(/_/g, " ").toUpperCase()}</span>
            <span>${pct}%</span>
          </div>
          <div class="prob-track">
            <div class="prob-fill" style="width: ${pct}%; background: var(--accent-indigo);"></div>
          </div>
        </div>
      `;
    }
    html += `</div>`;

    container.innerHTML = html;
  },

  renderProbSection(title, questionId, categoryResult, userCorrected, allOptions) {
    if (!categoryResult) return "";
    const activeChoice = userCorrected || categoryResult.choice;
    const isCorrected = Boolean(userCorrected);

    let barsHtml = "";
    for (const [opt, p] of Object.entries(categoryResult.probabilities || {})) {
      const pct = (p * 100).toFixed(1);
      const isWinner = opt === activeChoice;
      barsHtml += `
        <div class="prob-bar-wrapper">
          <div class="prob-bar-label">
            <span style="font-weight: ${isWinner ? "700" : "normal"}; color: ${isWinner ? "var(--accent-blue)" : "inherit"};">
              ${opt.replace(/_/g, " ")} ${isWinner ? "✓" : ""}
            </span>
            <span>${pct}%</span>
          </div>
          <div class="prob-track">
            <div class="prob-fill" style="width: ${pct}%; opacity: ${isWinner ? 1 : 0.45};"></div>
          </div>
        </div>
      `;
    }

    const selectOptions = allOptions
      .map((opt) => `<option value="${opt}" ${opt === activeChoice ? "selected" : ""}>${opt.replace(/_/g, " ")}</option>`)
      .join("");

    return `
      <div style="margin-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 1rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; gap: 0.5rem; flex-wrap: wrap;">
          <h4 style="font-size: 0.92rem;">${title} ${isCorrected ? '<span style="color: var(--accent-green); font-size: 0.78rem;">(Corregido)</span>' : ""}</h4>
          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <select id="correct-${questionId}" class="active-date-picker" style="font-size: 0.78rem;">
              ${selectOptions}
            </select>
            <button type="button" class="btn-secondary" style="font-size: 0.76rem; padding: 0.25rem 0.6rem;"
              onclick="DayEditorComponent.submitCorrection('${questionId}', '${categoryResult.choice}')">
              Corregir
            </button>
          </div>
        </div>
        ${barsHtml}
      </div>
    `;
  },

  async submitCorrection(questionId, originalValue) {
    const select = document.getElementById(`correct-${questionId}`);
    if (!select) return;
    const correctedValue = select.value;
    const snippet = document.getElementById("day-text").value.trim() || "Entrada de diario";

    try {
      const res = await API.submitFeedback(this.currentDate, snippet, questionId, originalValue, correctedValue);
      App.showToast("Corrección registrada");
      if (res.updated_entry) {
        this.currentEntry = res.updated_entry;
        if (res.updated_entry.laya_profile) {
          this.renderLayaProfile(res.updated_entry.laya_profile, res.updated_entry.user_corrections, res.updated_entry.goal_alignment);
        }
      }
    } catch (err) {
      App.showToast("Error al guardar corrección");
      console.error(err);
    }
  },

  escapeHtml(str) {
    return API.escapeHtml(str);
  }
};
