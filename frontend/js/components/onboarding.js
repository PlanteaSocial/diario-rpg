/**
 * Componente: Cuestionario Inicial de Bienvenida (Onboarding + Metas + Radar de 5 Ejes)
 * Flujo paso a paso con barra de progreso, tarjetas táctiles con íconos, y conexión directa
 * con SQLite, Laya AI y Qwen. Estrictamente no clínico.
 */

const OnboardingComponent = {
  currentStep: 1,
  totalSteps: 4,
  draft: {
    morning_habit: "cafe",
    habits_to_improve: [],
    sleep_improvement_goal: "dormir_mas_horas",
    stress_areas: [],
    personal_objective: "constancia",
    daily_goal_level: "normal"
  },
  isBound: false,

  init() {
    if (this.isBound) return;
    this.bindEvents();
    this.isBound = true;
  },

  open(existingProfile = null) {
    this.init();
    if (existingProfile) {
      this.draft = {
        morning_habit: existingProfile.morning_habit || "cafe",
        habits_to_improve: [...(existingProfile.habits_to_improve || [])],
        sleep_improvement_goal: existingProfile.sleep_improvement_goal || "dormir_mas_horas",
        stress_areas: [...(existingProfile.stress_areas || [])],
        personal_objective: existingProfile.personal_objective || "constancia",
        daily_goal_level: existingProfile.daily_goal_level || "normal"
      };
    }
    this.currentStep = 1;
    this.syncSelectionUI();
    this.renderStep();

    const overlay = document.getElementById("onboarding-overlay");
    if (overlay) overlay.classList.add("active");
  },

  close() {
    const overlay = document.getElementById("onboarding-overlay");
    if (overlay) overlay.classList.remove("active");
  },

  bindEvents() {
    // Selección única (radio táctil)
    document.querySelectorAll(".ob-single-group").forEach((group) => {
      const field = group.dataset.field;
      group.querySelectorAll(".ob-option-card").forEach((card) => {
        card.addEventListener("click", () => {
          group.querySelectorAll(".ob-option-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          this.draft[field] = card.dataset.val;
        });
      });
    });

    // Selección múltiple (chips/tarjetas)
    document.querySelectorAll(".ob-multi-group").forEach((group) => {
      const field = group.dataset.field;
      group.querySelectorAll(".ob-option-card").forEach((card) => {
        card.addEventListener("click", () => {
          const val = card.dataset.val;
          card.classList.toggle("selected");
          const current = new Set(this.draft[field] || []);
          if (current.has(val)) current.delete(val);
          else current.add(val);
          this.draft[field] = Array.from(current);
        });
      });
    });

    const prevBtn = document.getElementById("ob-prev-btn");
    const nextBtn = document.getElementById("ob-next-btn");
    const skipBtn = document.getElementById("ob-skip-btn");
    const finishBtn = document.getElementById("ob-finish-btn");

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (this.currentStep > 1) {
          this.currentStep -= 1;
          this.renderStep();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", async () => {
        if (this.currentStep < 3) {
          this.currentStep += 1;
          this.renderStep();
        } else if (this.currentStep === 3) {
          await this.saveAndShowRadar();
        }
      });
    }

    if (skipBtn) {
      skipBtn.addEventListener("click", async () => {
        await this.saveAndFinish(true);
      });
    }

    if (finishBtn) {
      finishBtn.addEventListener("click", () => {
        this.close();
      });
    }
  },

  syncSelectionUI() {
    document.querySelectorAll(".ob-single-group").forEach((group) => {
      const field = group.dataset.field;
      const val = this.draft[field];
      group.querySelectorAll(".ob-option-card").forEach((card) => {
        card.classList.toggle("selected", card.dataset.val === val);
      });
    });

    document.querySelectorAll(".ob-multi-group").forEach((group) => {
      const field = group.dataset.field;
      const selectedSet = new Set(this.draft[field] || []);
      group.querySelectorAll(".ob-option-card").forEach((card) => {
        card.classList.toggle("selected", selectedSet.has(card.dataset.val));
      });
    });
  },

  renderStep() {
    for (let i = 1; i <= this.totalSteps; i++) {
      const stepEl = document.getElementById(`ob-step-${i}`);
      if (stepEl) stepEl.classList.toggle("active", i === this.currentStep);
    }

    const progressEl = document.getElementById("ob-progress-fill");
    const labelEl = document.getElementById("ob-step-indicator");
    const prevBtn = document.getElementById("ob-prev-btn");
    const nextBtn = document.getElementById("ob-next-btn");
    const footerNav = document.getElementById("ob-footer-nav");
    const finishBar = document.getElementById("ob-finish-bar");

    if (progressEl) progressEl.style.width = `${(this.currentStep / this.totalSteps) * 100}%`;
    if (labelEl) labelEl.textContent = `Paso ${this.currentStep} de ${this.totalSteps}`;
    if (prevBtn) prevBtn.style.visibility = this.currentStep > 1 && this.currentStep < 4 ? "visible" : "hidden";

    if (this.currentStep < 4) {
      if (footerNav) footerNav.style.display = "flex";
      if (finishBar) finishBar.style.display = "none";
      if (nextBtn) {
        nextBtn.textContent = this.currentStep === 3 ? "Ver mi Mapa de Enfoque →" : "Siguiente →";
      }
    } else {
      if (footerNav) footerNav.style.display = "none";
      if (finishBar) finishBar.style.display = "flex";
    }
  },

  async saveAndShowRadar() {
    const nextBtn = document.getElementById("ob-next-btn");
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = "Calculando enfoque...";
    }

    try {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
      const payload = {
        ...this.draft,
        theme_mode: currentTheme,
        onboarding_completed: true
      };

      const res = await API.saveProfile(payload);
      if (App && App.onProfileLoaded) {
        App.onProfileLoaded(res.profile, res.personal_radar);
      }

      this.currentStep = 4;
      this.renderStep();

      // Dibujar gráfica de radar en el paso 4
      const radar = res.profile.radar_focus || {};
      const labels = Object.keys(radar);
      const values = Object.values(radar);
      const canvas = document.getElementById("onboarding-radar-canvas");

      // Esperar un tick de animación para que el canvas tenga dimensiones visibles
      setTimeout(() => {
        RadarChartHelper.draw(canvas, labels, values);
      }, 60);

      this.renderWelcomeMessage(res.profile);
    } catch (err) {
      console.error("Error guardando perfil de onboarding:", err);
      App.showToast("Error al guardar tu perfil");
    } finally {
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.textContent = "Ver mi Mapa de Enfoque →";
      }
    }
  },

  async saveAndFinish(isSkip = false) {
    try {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
      const res = await API.saveProfile({
        ...this.draft,
        theme_mode: currentTheme,
        onboarding_completed: true
      });
      if (App && App.onProfileLoaded) {
        App.onProfileLoaded(res.profile, res.personal_radar);
      }
      this.close();
      if (isSkip) App.showToast("Puedes configurar tus metas cuando quieras desde Ajustes");
    } catch (err) {
      this.close();
    }
  },

  renderWelcomeMessage(profile) {
    const box = document.getElementById("ob-radar-message");
    if (!box || !profile) return;

    const goalLabels = {
      facil: "Fácil (5 min/día)",
      normal: "Normal (10 min/día)",
      serio: "Serio (15 min/día)",
      intensivo: "Intensivo (20+ min/día)"
    };
    const objLabels = {
      control_emocional: "construir equilibrio emocional",
      mas_energia: "recuperar tu energía diaria",
      limites_sanos: "proteger tus límites sanos",
      constancia: "cultivar constancia diaria"
    };

    const goalStr = goalLabels[profile.daily_goal_level] || "Normal (10 min/día)";
    const objStr = objLabels[profile.personal_objective] || "cuidar tu bienestar";

    const radar = profile.radar_focus || {};
    const topFocus = Object.entries(radar).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);

    box.innerHTML = `
      <strong>Tu brújula está lista.</strong> Hemos calibrado tu meta diaria en modo
      <b>${API.escapeHtml(goalStr)}</b> para acompañarte a <b>${API.escapeHtml(objStr)}</b>.
      <br><br>
      Tus dos áreas de mayor enfoque inicial son <b>${API.escapeHtml(topFocus.join(" y "))}</b>. A partir de ahora,
      cada entrada en tu diario comparará tus señales cotidianas frente a estas metas personales.
    `;
  }
};
