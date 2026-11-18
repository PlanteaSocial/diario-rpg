/**
 * Controlador Principal de la Aplicación Diario Inteligente.
 * Manejo de pestañas, fecha actual, tema claro/oscuro, meta diaria y onboarding.
 */

const App = {
  currentDateStr: "",
  todayRealStr: "",
  userProfile: null,
  personalRadar: {},

  async init() {
    if (this._started) return;
    this._started = true;
    this.initThemeFromStorage();
    this.renderPixelIcons();
    this.setupDate();
    this.setupDateNavigator();
    this.setupTabs();
    this.setupThemeControls();
    this.setupSanctuaryTriggers();
    this.setupRailActions();
    this.setupQrAccessModal();

    // Inicializar componentes (carga perezosa de Historial/Patrones al abrir pestaña)
    OnboardingComponent.init();
    SanctuaryComponent.init();
    AssessmentsComponent.init();
    LearnMapComponent.init();
    QuickNotesComponent.init(this.currentDateStr);
    DayEditorComponent.init(this.currentDateStr);
    HistoryComponent.init();
    PatternsComponent.init();
    DevModeComponent.init();

    // Cargar perfil de metas y lanzar Onboarding si es la primera vez
    await this.loadUserProfile(true);
    this.renderLearnHint();
  },

  renderPixelIcons() {
    const map = {
      "px-hero-portrait": PixelSprites.heroScholar(46),
      "px-header-slime": PixelSprites.slime("slime_azul", 22),
      "px-header-chart": PixelSprites.chart(20),
      "px-header-moon": PixelSprites.moon(20),
      "px-header-gear": PixelSprites.gear(20),
      "px-nav-hoy": PixelSprites.hourglass(18),
      "px-nav-hist": PixelSprites.notebook(18),
      "px-nav-pat": PixelSprites.chart(18),
      "px-nav-retos": PixelSprites.compass(18),
      "px-nav-learn": PixelSprites.book(18),
      "px-mob-hoy": PixelSprites.hourglass(22),
      "px-mob-hist": PixelSprites.notebook(22),
      "px-mob-pat": PixelSprites.chart(22),
      "px-mob-retos": PixelSprites.compass(22),
      "px-mob-learn": PixelSprites.book(22),
      "px-mob-aj": PixelSprites.gear(22)
    };
    Object.entries(map).forEach(([id, svg]) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = svg;
    });
  },

  setupSanctuaryTriggers() {
    const openPet = () => SanctuaryComponent.open("mascota");
    const openShop = () => SanctuaryComponent.open("tienda");

    ["header-slime-btn", "open-sanctuary-pet-btn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", openPet);
    });
    const shopBtn = document.getElementById("open-sanctuary-shop-btn");
    if (shopBtn) shopBtn.addEventListener("click", openShop);

    const headerChartBtn = document.getElementById("header-patterns-btn");
    if (headerChartBtn) {
      headerChartBtn.addEventListener("click", () => this.activateTab("patrones"));
    }

    const headerAjustesBtn = document.getElementById("header-settings-btn");
    if (headerAjustesBtn) {
      headerAjustesBtn.addEventListener("click", () => this.activateTab("ajustes"));
    }
  },

  setupRailActions() {
    document.querySelectorAll("[data-rail-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.railAction;
        if (action === "note") {
          this.activateTab("hoy");
          const input = document.getElementById("quick-note-input");
          if (input) {
            input.scrollIntoView({ behavior: "smooth", block: "center" });
            input.focus({ preventScroll: true });
          }
          return;
        }
        this.activateTab(action);
      });
    });
  },

  async renderLearnHint() {
    const box = document.getElementById("hoy-learn-hint");
    if (!box) return;
    try {
      const state = await API.getLearningState();
      const rec = state.recommendation;
      if (!rec) {
        box.innerHTML = "";
        return;
      }
      box.innerHTML = `
        <div class="learn-hoy-hint">
          <span class="learn-hoy-hint-ico">💡</span>
          <div class="learn-hoy-hint-text">${this.escapeHtml(rec.message)}</div>
          <button type="button" class="learn-mini-btn" id="hoy-learn-hint-btn">Abrir Aprender</button>
        </div>
      `;
      const btn = document.getElementById("hoy-learn-hint-btn");
      if (btn) btn.addEventListener("click", () => this.activateTab("aprender"));
    } catch (err) {
      box.innerHTML = "";
    }
  },

  escapeHtml(str) {
    return API.escapeHtml(str);
  },

  renderTodayRail(entry) {
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const dateEl = document.getElementById("rail-stats-date");
    if (dateEl) {
      const dateStr = (entry && entry.date) || this.currentDateStr;
      if (dateStr) {
        const [y, m, d] = dateStr.split("-").map(Number);
        const dt = new Date(y, m - 1, d);
        dateEl.textContent = dt.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
      } else {
        dateEl.textContent = "—";
      }
    }

    const q = entry && entry.questionnaire;
    if (!q) {
      setText("rail-sleep", "—");
      setText("rail-mood", "—");
      setText("rail-energy", "—");
      setText("rail-load", "—");
      setText("rail-mood-line", "Sin check-in todavía");
      return;
    }

    setText("rail-sleep", `${q.sleep_hours}h`);
    setText("rail-mood", `${q.valence_rating}/5`);
    setText("rail-energy", `${q.energy_rating}/5`);
    setText("rail-load", `${q.workload_rating}/5`);

    const emotion = entry.laya_profile && entry.laya_profile.emocion_primaria
      ? entry.laya_profile.emocion_primaria.choice
      : "";
    const moodParts = [`Check-in: ${q.self_report_word}`];
    if (emotion) moodParts.push(`Laya: ${emotion}`);
    setText("rail-mood-line", moodParts.join(" · "));
  },

  setupQrAccessModal() {
    const openBtn = document.getElementById("qr-access-btn");
    const closeBtn = document.getElementById("qr-close-btn");
    const modal = document.getElementById("qr-modal");
    const copyBtn = document.getElementById("qr-copy-btn");

    if (openBtn) {
      openBtn.addEventListener("click", () => this.openQrModal());
    }
    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.remove("active"));
    }
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    }
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const urlEl = document.getElementById("qr-url-display");
        const urlText = urlEl ? urlEl.textContent : "";
        if (!urlText || urlText === "--") return;
        try {
          await navigator.clipboard.writeText(urlText);
          this.showToast("Enlace copiado al portapapeles");
        } catch {
          this.showToast("Copia manualmente: " + urlText);
        }
      });
    }
  },

  async openQrModal() {
    const modal = document.getElementById("qr-modal");
    const tabsEl = document.getElementById("qr-network-tabs");
    const svgEl = document.getElementById("qr-svg-container");
    const urlEl = document.getElementById("qr-url-display");
    const hintEl = document.getElementById("qr-hint-text");
    if (!modal || !tabsEl || !svgEl) return;

    modal.classList.add("active");
    svgEl.textContent = "Detectando red local y Tailscale...";

    try {
      const info = await API.getNetworkInfo();
      const options = info.options || [];
      if (options.length === 0) {
        svgEl.textContent = "No se encontraron interfaces de red.";
        return;
      }

      const renderOption = (optId) => {
        const opt = options.find((o) => o.id === optId) || options[0];
        tabsEl.querySelectorAll(".sanc-tab-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.netid === opt.id);
        });
        svgEl.innerHTML = opt.svg;
        if (urlEl) urlEl.textContent = opt.url;
        if (hintEl) hintEl.textContent = opt.hint || "";
      };

      tabsEl.innerHTML = options
        .map(
          (o) =>
            `<button type="button" class="sanc-tab-btn" data-netid="${o.id}">${o.label}</button>`
        )
        .join("");

      tabsEl.querySelectorAll(".sanc-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => renderOption(btn.dataset.netid));
      });

      renderOption(info.preferred || options[0].id);
    } catch (err) {
      svgEl.textContent = "Error al detectar la dirección de red.";
      console.error(err);
    }
  },

  async refreshCompanionBanner() {
    try {
      const res = await API.getCompanion();
      this.updateAdventurerBanner(res.companion, res.adventurer_title);
    } catch (e) {}
  },

  updateAdventurerBanner(companion, title = "Aprendiz Sereno") {
    if (!companion) return;
    if (this.userProfile) this.userProfile.companion = companion;

    const lvlEl = document.getElementById("adv-level-text");
    const titleEl = document.getElementById("adv-title-text");
    const coinsEl = document.getElementById("adv-coins-pill");
    const expFillEl = document.getElementById("adv-exp-fill");
    const expLabelEl = document.getElementById("adv-exp-label");
    const miniSlimeIco = document.getElementById("adv-mini-slime");
    const miniSlimeTxt = document.getElementById("adv-slime-status");
    const hdrSlime = document.getElementById("px-header-slime");

    if (lvlEl) lvlEl.textContent = `Nivel ${companion.level}`;
    if (titleEl) titleEl.textContent = title;
    if (coinsEl) coinsEl.innerHTML = `${PixelSprites.coin(13)} <span>${companion.coins}</span>`;

    const pct = Math.min(100, Math.round((companion.exp / Math.max(1, companion.next_level_exp)) * 100));
    if (expFillEl) expFillEl.style.width = `${pct}%`;
    if (expLabelEl) expLabelEl.textContent = `${companion.exp} / ${companion.next_level_exp} EXP`;

    if (miniSlimeIco) miniSlimeIco.innerHTML = PixelSprites.slime(companion.variant, 22);
    if (hdrSlime) hdrSlime.innerHTML = PixelSprites.slime(companion.variant, 22);

    if (miniSlimeTxt) {
      const estado = companion.mood >= 65 ? "Sereno y feliz" : (companion.energy < 45 ? "Necesita descanso" : "Te acompaña");
      miniSlimeTxt.innerHTML = `<strong>${this.escapeHtml(companion.name)} · Nv.${Number(companion.level) || 1}</strong> <span style="opacity:0.75;">${estado} · ${Number(companion.bond) || 0}%</span>`;
    }
  },

  initThemeFromStorage() {
    const saved = localStorage.getItem("diario_theme") || "light";
    this.applyTheme(saved, false);
  },

  applyTheme(theme, persist = false) {
    const mode = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", mode);
    localStorage.setItem("diario_theme", mode);

    const quickBtn = document.getElementById("quick-theme-btn");
    if (quickBtn && typeof PixelSprites !== "undefined") {
      quickBtn.innerHTML = mode === "dark" ? "☀️" : PixelSprites.moon(18);
      quickBtn.title = mode === "dark" ? "Cambiar a Modo Claro Pergamino" : "Cambiar a Modo Oscuro Cozy";
    }

    document.querySelectorAll(".theme-choice-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.themeChoice === mode);
    });

    // Redibujar canvases activos para adaptar contraste
    if (PatternsComponent && PatternsComponent.data) {
      PatternsComponent.drawChart();
      PatternsComponent.drawRadarChart();
    }
    if (AssessmentsComponent && Object.keys(AssessmentsComponent.personalRadar || {}).length > 0) {
      AssessmentsComponent.renderRadar();
    }

    if (persist && this.userProfile) {
      const p = this.userProfile;
      p.theme_mode = mode;
      API.saveProfile({
        morning_habit: p.morning_habit,
        habits_to_improve: p.habits_to_improve || [],
        sleep_improvement_goal: p.sleep_improvement_goal,
        stress_areas: p.stress_areas || [],
        personal_objective: p.personal_objective,
        daily_goal_level: p.daily_goal_level,
        daily_goal_minutes: p.daily_goal_minutes,
        theme_mode: mode,
        onboarding_completed: Boolean(p.onboarding_completed),
        radar_focus: p.radar_focus || {}
      }).catch(() => {});
    }
  },

  setupThemeControls() {
    const quickBtn = document.getElementById("quick-theme-btn");
    if (quickBtn) {
      quickBtn.addEventListener("click", () => {
        const cur = document.documentElement.getAttribute("data-theme") || "light";
        this.applyTheme(cur === "dark" ? "light" : "dark", true);
      });
    }

    document.querySelectorAll(".theme-choice-card").forEach((card) => {
      card.addEventListener("click", () => {
        this.applyTheme(card.dataset.themeChoice, true);
      });
    });

    const reopenObBtn = document.getElementById("reopen-onboarding-btn");
    if (reopenObBtn) {
      reopenObBtn.addEventListener("click", () => {
        OnboardingComponent.open(this.userProfile);
      });
    }
  },

  async loadUserProfile(checkOnboarding = false) {
    try {
      const res = await API.getProfile();
      this.onProfileLoaded(res.profile, res.personal_radar, res.adventurer_title);
      if (checkOnboarding && res.profile && !res.profile.onboarding_completed) {
        OnboardingComponent.open(res.profile);
      }
    } catch (err) {
      console.error("Error cargando perfil de usuario:", err);
    }
  },

  onProfileLoaded(profile, personalRadar = {}, adventurerTitle = null) {
    if (!profile) return;
    this.userProfile = profile;
    this.personalRadar = personalRadar || profile.radar_focus || {};

    if (profile.theme_mode) {
      this.applyTheme(profile.theme_mode, false);
    }

    if (profile.companion) {
      this.updateAdventurerBanner(profile.companion, adventurerTitle || "Aprendiz Sereno");
    }

    this.updateDailyGoalProgress();
    this.renderSettingsProfileSummary();
  },

  updateDailyGoalProgress() {
    const ringCircle = document.getElementById("daily-goal-ring-fill");
    const pctLabel = document.getElementById("daily-goal-pct-text");
    const descLabel = document.getElementById("daily-goal-desc-text");
    if (!ringCircle || !pctLabel || !descLabel) return;

    const goalLevel = this.userProfile ? this.userProfile.daily_goal_level : "normal";
    const goalMins = this.userProfile ? this.userProfile.daily_goal_minutes : 10;
    const levelNames = { facil: "Fácil", normal: "Normal", serio: "Serio", intensivo: "Intensivo" };

    const isSaved = Boolean(DayEditorComponent && DayEditorComponent.currentEntry);
    const notesCount = QuickNotesComponent && QuickNotesComponent.notes ? QuickNotesComponent.notes.length : 0;
    const textLen = (document.getElementById("day-text")?.value || "").trim().length;

    let pct = 0;
    if (isSaved) {
      pct = 100;
    } else {
      const notesCredit = Math.min(35, notesCount * 20);
      const textCredit = Math.min(55, Math.round((textLen / 120) * 55));
      pct = Math.min(90, notesCredit + textCredit);
    }

    // Circunferencia r=14 -> 2*pi*14 ≈ 87.96
    const circ = 87.96;
    const offset = circ - (pct / 100) * circ;
    ringCircle.style.strokeDashoffset = offset;
    pctLabel.textContent = pct === 100 ? "✓" : `${pct}%`;

    const levelStr = `${levelNames[goalLevel] || "Normal"} (${goalMins}m)`;
    if (pct === 100) {
      descLabel.innerHTML = `<strong>Cumplida</strong> · ${levelStr}`;
    } else if (pct > 0) {
      descLabel.innerHTML = `Meta: <b>${levelStr}</b>`;
    } else {
      descLabel.innerHTML = `Meta: <b>${levelStr}</b>`;
    }
  },

  renderSettingsProfileSummary() {
    const box = document.getElementById("settings-goals-summary");
    if (!box || !this.userProfile) return;

    const p = this.userProfile;
    const objMap = {
      control_emocional: "Equilibrio emocional",
      mas_energia: "Más energía vital",
      limites_sanos: "Límites sanos",
      constancia: "Constancia diaria"
    };
    const goalMap = {
      facil: "Fácil (5 min/día)",
      normal: "Normal (10 min/día)",
      serio: "Serio (15 min/día)",
      intensivo: "Intensivo (20+ min/día)"
    };
    const habitsText = (p.habits_to_improve || []).length
      ? p.habits_to_improve.map((h) => h.replace(/_/g, " ")).join(", ")
      : "Ninguno seleccionado aún";

    box.innerHTML = `
      <div class="settings-goal-grid">
        <div><span>Objetivo principal:</span> <strong>${this.escapeHtml(objMap[p.personal_objective] || p.personal_objective)}</strong></div>
        <div><span>Meta diaria:</span> <strong>${this.escapeHtml(goalMap[p.daily_goal_level] || p.daily_goal_level)}</strong></div>
        <div><span>Rutina de mañana:</span> <strong style="text-transform: capitalize;">${this.escapeHtml((p.morning_habit || "").replace(/_/g, " "))}</strong></div>
        <div><span>Hábitos a cuidar:</span> <strong style="text-transform: capitalize;">${this.escapeHtml(habitsText)}</strong></div>
      </div>
    `;
  },

  setupDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    this.todayRealStr = `${yyyy}-${mm}-${dd}`;
    this.currentDateStr = this.todayRealStr;
    this.updateDateUI();
  },

  updateDateUI() {
    const [y, m, d] = this.currentDateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);

    const isToday = this.currentDateStr === this.todayRealStr;
    const titleEl = document.getElementById("page-main-title");
    if (titleEl) {
      titleEl.textContent = isToday ? "Hoy" : "Diario del Día";
    }

    const label = document.getElementById("current-date-label");
    if (label) {
      label.textContent = dt.toLocaleDateString("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }) + (isToday ? " (Hoy)" : "");
    }

    const picker = document.getElementById("active-date-picker");
    if (picker) picker.value = this.currentDateStr;

    const todayBtn = document.getElementById("today-jump-btn");
    if (todayBtn) todayBtn.classList.toggle("active", isToday);
  },

  setDate(newDateStr) {
    if (!newDateStr) return;
    this.currentDateStr = newDateStr;
    this.updateDateUI();

    QuickNotesComponent.init(this.currentDateStr);
    DayEditorComponent.init(this.currentDateStr);

    const activeTab = document.querySelector(".nav-tab-btn.active")?.dataset.tab;
    if (activeTab === "historial") HistoryComponent.loadHistory();
    if (activeTab === "patrones") PatternsComponent.loadPatterns();
  },

  jumpToTabAndDate(tabName, dateStr) {
    this.setDate(dateStr);
    this.activateTab(tabName);
  },

  shiftDate(days) {
    const [y, m, d] = this.currentDateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);

    const nextY = dt.getFullYear();
    const nextM = String(dt.getMonth() + 1).padStart(2, "0");
    const nextD = String(dt.getDate()).padStart(2, "0");
    this.setDate(`${nextY}-${nextM}-${nextD}`);
  },

  setupDateNavigator() {
    const toggleBtn = document.getElementById("date-tools-toggle-btn");
    const popover = document.getElementById("date-tools-popover");
    const prevBtn = document.getElementById("prev-day-btn");
    const nextBtn = document.getElementById("next-day-btn");
    const todayBtn = document.getElementById("today-jump-btn");
    const picker = document.getElementById("active-date-picker");
    const simWeekBtn = document.getElementById("simulate-week-btn");
    const resetDbBtn = document.getElementById("reset-db-btn");

    if (toggleBtn && popover) {
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        popover.classList.toggle("open");
      });
      document.addEventListener("click", (e) => {
        if (!popover.contains(e.target) && e.target !== toggleBtn) {
          popover.classList.remove("open");
        }
      });
    }

    if (prevBtn) prevBtn.addEventListener("click", () => this.shiftDate(-1));
    if (nextBtn) nextBtn.addEventListener("click", () => this.shiftDate(1));
    if (todayBtn) todayBtn.addEventListener("click", () => {
      this.setDate(this.todayRealStr);
      if (popover) popover.classList.remove("open");
    });
    if (picker) picker.addEventListener("change", (e) => {
      this.setDate(e.target.value);
      if (popover) popover.classList.remove("open");
    });

    if (simWeekBtn) {
      simWeekBtn.addEventListener("click", async () => {
        simWeekBtn.disabled = true;
        simWeekBtn.textContent = "Simulando 7 días...";
        try {
          const res = await API.simulateWeek();
          App.showToast(res.message || "Semana simulada con éxito");
          this.setDate(this.todayRealStr);
          if (popover) popover.classList.remove("open");
        } catch (err) {
          App.showToast("Error al simular semana");
          console.error(err);
        } finally {
          simWeekBtn.disabled = false;
          simWeekBtn.textContent = "⚡ Simular 1 Semana";
        }
      });
    }

    if (resetDbBtn) {
      resetDbBtn.addEventListener("click", async () => {
        if (!confirm("¿Deseas vaciar todas las notas y registros para empezar de cero?")) {
          return;
        }
        resetDbBtn.disabled = true;
        try {
          const res = await API.resetDatabase();
          App.showToast(res.message || "Diario limpiado");
          this.setDate(this.todayRealStr);
          if (popover) popover.classList.remove("open");
        } catch (err) {
          App.showToast("Error al reiniciar diario");
          console.error(err);
        } finally {
          resetDbBtn.disabled = false;
        }
      });
    }
  },

  activateTab(target) {
    const allTabs = document.querySelectorAll(".nav-tab-btn, .mobile-nav-btn");
    const panes = document.querySelectorAll(".tab-pane");

    allTabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === target));
    panes.forEach((p) => p.classList.toggle("active", p.id === `pane-${target}`));

    if (target === "historial") {
      HistoryComponent.loadHistory();
    } else if (target === "patrones") {
      PatternsComponent.loadPatterns();
    } else if (target === "autoconocimiento") {
      AssessmentsComponent.loadAssessments();
    } else if (target === "aprender") {
      LearnMapComponent.loadState();
    } else if (target === "ajustes") {
      this.loadSystemStatus();
      this.renderSettingsProfileSummary();
    }
  },

  setupTabs() {
    document.querySelectorAll(".nav-tab-btn, .mobile-nav-btn").forEach((tab) => {
      tab.addEventListener("click", () => {
        this.activateTab(tab.dataset.tab);
      });
    });
  },

  async loadSystemStatus() {
    const indicator = document.getElementById("system-status-indicator");
    const box = document.getElementById("settings-status-box");

    try {
      const status = await API.getStatus();
      if (indicator) {
        indicator.textContent = String(status.ollama_qwen || "").includes("qwen")
          ? "Local (Laya + Qwen)"
          : "Local (Laya)";
      }

      if (box) {
        const esc = (v) => this.escapeHtml(v);
        box.innerHTML = `
          <div><b>Estado del Servidor:</b> <span style="color: var(--accent-green);">● En línea (${esc(status.platform)})</span></div>
          <div><b>Servidor:</b> ${esc(API.baseUrl || window.location.host)}</div>
          <div><b>Base de Datos:</b> ${esc(status.database)}</div>
          <div><b>Motor Clasificador:</b> ${esc(status.laya_model)} · ${esc(status.classifier || "")}</div>
          <div><b>Motor Redactor (Ollama):</b> ${esc(status.ollama_qwen)}</div>
          <div><b>Hora del Sistema:</b> ${esc(new Date(status.timestamp).toLocaleTimeString())}</div>
        `;
      }
    } catch (err) {
      if (indicator) indicator.textContent = "Desconectado";
      if (box) box.textContent = "Error al conectar con la API local.";
    }
  },

  showToast(message, duration = 2800) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Primero la puerta de autenticación; App.init() se lanza al entrar.
  Auth.init();
});
