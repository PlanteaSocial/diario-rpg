/**
 * Componente: Patrones, Gráfica Superponible, Distribución de Ánimo y Radar Laya AI
 * Visualiza evolución temporal (con eje Y secundario 0h-10h para sueño),
 * filtro rápido de periodo (7d / 30d / Todo), radar de 5 ejes de Laya y resumen Qwen 3.5.
 */

const PatternsComponent = {
  data: null,
  canvas: null,
  ctx: null,
  hoverIndex: -1,
  currentPeriodDays: 0, // 7 | 30 | 0 (Todo)
  radarMode: "laya", // "laya" | "personal"
  _rafPending: false,

  init() {
    if (this._bound) return;
    this._bound = true;

    this.canvas = document.getElementById("patterns-canvas");
    if (this.canvas) {
      this.ctx = this.canvas.getContext("2d");
      this.setupCanvasEvents();
    }

    const toggles = ["chk-valence", "chk-energy", "chk-sleep", "chk-workload"];
    toggles.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", () => this.drawChart());
    });

    // Redibujar canvas si se abre su acordeón desplegable
    const radarDetails = document.getElementById("patterns-radar-accordion");
    if (radarDetails) {
      radarDetails.addEventListener("toggle", () => {
        if (radarDetails.open) this.drawRadarChart();
      });
    }

    // Selector rápido de periodo (7d / 30d / Todo)
    document.querySelectorAll(".period-pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".period-pill-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentPeriodDays = parseInt(btn.dataset.days, 10) || 0;
        this.loadPatterns(false);
      });
    });

    // Selector de modo Radar (Ejes de Laya vs Radar Personal/Metas)
    document.querySelectorAll(".radar-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.radarMode = btn.dataset.mode || "laya";
        this.drawRadarChart();
      });
    });

    const refreshBtn = document.getElementById("refresh-summary-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => this.refreshQwenSummary());
    }
  },

  async loadPatterns(isUserRefresh = false) {
    try {
      const refreshBtn = document.getElementById("refresh-summary-btn");
      if (refreshBtn && API.isCloud && API.isCloud()) {
        refreshBtn.textContent = "✦ Generar otra crónica";
        const titleSpan = refreshBtn.closest(".qwen-summary-card")?.querySelector(".qwen-title .serif-heading");
        if (titleSpan) titleSpan.textContent = "✦ Crónica de tu diario";
      }
      this.data = await API.getPatterns(this.currentPeriodDays, false);
      this.renderBaseline(this.data.baseline);
      this.renderMoodDistribution(this.data.mood_distribution || {});
      this.renderGoalCrossInsights(this.data.goal_cross_insights || []);
      this.renderSummary(this.data.summary_text, this.data.generated_by);
      this.drawChart();
      this.drawRadarChart();

      if (isUserRefresh) {
        await this.refreshQwenSummary();
      }
    } catch (err) {
      console.error("Error al cargar patrones:", err);
    }
  },

  async refreshQwenSummary() {
    const refreshBtn = document.getElementById("refresh-summary-btn");
    const badgeEl = document.getElementById("summary-engine-badge");
    const isCloud = Boolean(API.isCloud && API.isCloud());
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = isCloud ? "Seleccionando crónica local..." : "Consultando Qwen 3.5...";
    }
    if (badgeEl) badgeEl.textContent = isCloud ? "Motor Vectorial Local (MMR + HLR)..." : "Redactando con Qwen 3.5:4b...";

    try {
      const res = await API.summarizePatterns(this.currentPeriodDays);
      this.renderSummary(res.summary_text, res.generated_by);
      App.showToast(isCloud ? "Crónica actualizada sin repetición" : "Resumen actualizado con Qwen");
    } catch (err) {
      console.error("Error invocando redactor:", err);
      App.showToast(isCloud ? "No se pudo actualizar la crónica" : "No se pudo conectar con Qwen");
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = isCloud ? "✦ Generar otra crónica" : "✦ Actualizar con Qwen 3.5";
      }
    }
  },

  renderBaseline(b) {
    const container = document.getElementById("baseline-stats-container");
    if (!container || !b) return;

    container.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${b.current_streak}</div>
        <div class="stat-label">Racha de Días</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${b.avg_valence_laya.toFixed(1)} <span class="stat-sub">/ 5</span></div>
        <div class="stat-label">Ánimo Medio (Laya)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${b.avg_sleep_hours.toFixed(1)}h</div>
        <div class="stat-label">Sueño Promedio</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${b.avg_workload.toFixed(1)} <span class="stat-sub">/ 5</span></div>
        <div class="stat-label">Carga Media</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="font-size: 1.25rem; text-transform: capitalize; color: var(--accent-indigo);">${API.escapeHtml(b.predominant_primary_emotion)}</div>
        <div class="stat-label">Emoción Dominante</div>
      </div>
    `;
  },

  renderMoodDistribution(dist) {
    const container = document.getElementById("mood-distribution-container");
    if (!container) return;

    const categories = [
      { key: "muy_positivo", label: "Muy positivo", icon: "🌟", color: "#34c759" },
      { key: "positivo", label: "Positivo", icon: "😊", color: "#0071e3" },
      { key: "neutro", label: "Neutro", icon: "😌", color: "#8b5cf6" },
      { key: "negativo", label: "Tenso", icon: "🌥️", color: "#ff9500" },
      { key: "muy_negativo", label: "Muy difícil", icon: "🌧️", color: "#ff3b30" }
    ];

    const total = categories.reduce((acc, c) => acc + (dist[c.key] || 0), 0);

    if (total === 0) {
      container.innerHTML = `<div style="font-size: 0.88rem; color: var(--text-tertiary);">Sin registros suficientes en este periodo.</div>`;
      return;
    }

    const barSegments = categories
      .map((c) => {
        const count = dist[c.key] || 0;
        if (count === 0) return "";
        const pct = (count / total) * 100;
        return `<div class="mood-bar-segment" style="width: ${pct}%; background: ${c.color};" title="${c.label}: ${count} días (${Math.round(pct)}%)"></div>`;
      })
      .join("");

    const cards = categories
      .map((c) => {
        const count = dist[c.key] || 0;
        const pct = Math.round((count / total) * 100);
        return `
          <div class="mood-dist-pill">
            <span class="mood-dist-dot" style="background: ${c.color};"></span>
            <span class="mood-dist-name">${c.icon} ${c.label}</span>
            <strong class="mood-dist-pct">${pct}%</strong>
            <span class="mood-dist-count">(${count}d)</span>
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="mood-stacked-bar">${barSegments}</div>
      <div class="mood-dist-grid">${cards}</div>
    `;
  },

  renderGoalCrossInsights(insights) {
    const container = document.getElementById("goal-cross-insights-box");
    if (!container) return;

    if (!insights || insights.length === 0) {
      container.innerHTML = `<div style="font-size: 0.85rem; color: var(--text-tertiary);">Registra días y configura tus metas en Ajustes para ver tu alineación periódica.</div>`;
      return;
    }

    container.innerHTML = insights
      .map(
        (txt) => `
        <div class="goal-insight-item">
          <span class="goal-insight-dot">✦</span>
          <span>${API.escapeHtml(txt)}</span>
        </div>
      `
      )
      .join("");
  },

  drawRadarChart() {
    const canvas = document.getElementById("patterns-radar-canvas");
    const subtitleEl = document.getElementById("patterns-radar-subtitle");
    if (!canvas || !this.data) return;

    if (this.radarMode === "laya") {
      const axes = this.data.laya_axes_avg || {};
      const labels = [
        "Trabajo / Estudio",
        "Descanso / Sueño",
        "Relaciones",
        "Salud / Cuerpo",
        "Carga Mental"
      ];
      const values = [
        axes.trabajo_estudio || 0,
        axes.descanso_sueno || 0,
        axes.relaciones_familia || 0,
        axes.salud_cuerpo || 0,
        axes.carga_mental || 0
      ];
      if (subtitleEl) {
        subtitleEl.textContent = "Porcentajes promedio reales detectados por Laya en tus textos del periodo.";
      }
      RadarChartHelper.draw(canvas, labels, values, {
        strokeColor: "#0071e3",
        fillColor: "rgba(0, 113, 227, 0.22)"
      });
    } else {
      const personal = this.data.personal_radar || {};
      const labels = Object.keys(personal);
      const values = Object.values(personal);
      if (subtitleEl) {
        subtitleEl.textContent = "Tu brújula combinada de metas iniciales, autoevaluaciones y constancia.";
      }
      RadarChartHelper.draw(canvas, labels, values, {
        strokeColor: "#5856d6",
        fillColor: "rgba(88, 86, 214, 0.22)"
      });
    }
  },

  renderSummary(text, engine) {
    const textEl = document.getElementById("qwen-summary-text");
    const badgeEl = document.getElementById("summary-engine-badge");
    if (textEl) textEl.textContent = text || "Sin observaciones aún.";
    if (badgeEl) badgeEl.textContent = engine ? `Generado por: ${engine}` : "";
  },

  setupCanvasEvents() {
    const handleMove = (e) => {
      if (!this.data || !this.data.time_series || this.data.time_series.length === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const xCss = e.clientX - rect.left;
      const paddingLeft = 45;
      const paddingRight = 50;
      const chartWidth = rect.width - paddingLeft - paddingRight;
      const pts = this.data.time_series;

      let nextIdx = -1;
      if (pts.length === 1) {
        nextIdx = 0;
      } else if (chartWidth > 0) {
        const step = chartWidth / (pts.length - 1);
        const idx = Math.round((xCss - paddingLeft) / step);
        nextIdx = Math.max(0, Math.min(pts.length - 1, idx));
      }

      if (nextIdx !== this.hoverIndex && !this._rafPending) {
        this.hoverIndex = nextIdx;
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._rafPending = false;
          this.drawChart();
        });
      }
    };

    const handleLeave = () => {
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.drawChart();
      }
    };

    this.canvas.addEventListener("mousemove", handleMove);
    this.canvas.addEventListener("mouseleave", handleLeave);
  },

  drawChart() {
    if (!this.ctx || !this.canvas) return;

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDark ? "rgba(219, 204, 168, 0.16)" : "rgba(104, 95, 82, 0.15)";
    const axisLabelColor = isDark ? "#bdb5a2" : "#685f52";
    const dotCenterColor = isDark ? "#1a1f30" : "#fcfaf3";

    // Ajustar resolución retina / HiDPI
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = (rect.width || 600) * dpr;
    this.canvas.height = (rect.height || 320) * dpr;
    this.ctx.scale(dpr, dpr);

    const width = rect.width || 600;
    const height = rect.height || 320;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    const pts = this.data && this.data.time_series ? this.data.time_series : [];
    if (pts.length === 0) {
      ctx.fillStyle = axisLabelColor;
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Guarda al menos un día para visualizar tus patrones y evolución.", width / 2, height / 2);
      return;
    }

    const padL = 45;
    const padR = 50; // Margen para el Eje Y secundario de sueño
    const padT = 30;
    const padB = 40;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;

    // Opciones activas
    const showValence = document.getElementById("chk-valence")?.checked ?? true;
    const showEnergy = document.getElementById("chk-energy")?.checked ?? true;
    const showSleep = document.getElementById("chk-sleep")?.checked ?? true;
    const showWorkload = document.getElementById("chk-workload")?.checked ?? true;

    // Líneas horizontales de guía (Eje Y primario: escala 1 a 5)
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "11px -apple-system, sans-serif";
    ctx.fillStyle = axisLabelColor;
    ctx.textAlign = "right";

    for (let level = 1; level <= 5; level++) {
      const y = padT + chartH - ((level - 1) / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText(level.toString(), padL - 10, y + 4);
    }

    // Eje Y Secundario a la derecha: Sueño (0h a 10h)
    if (showSleep) {
      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillStyle = "#34c759";
      ctx.textAlign = "left";
      for (let h = 0; h <= 10; h += 2) {
        const y = padT + chartH - (h / 10.0) * chartH;
        ctx.fillText(`${h}h`, width - padR + 10, y + 4);
      }
    }

    const getX = (idx) => {
      if (pts.length === 1) return padL + chartW / 2;
      return padL + (idx / (pts.length - 1)) * chartW;
    };

    const getYPrimary = (val, minVal = 1, maxVal = 5) => {
      const clamped = Math.max(minVal, Math.min(maxVal, val));
      const norm = (clamped - minVal) / (maxVal - minVal);
      return padT + chartH - norm * chartH;
    };

    const getYSleep = (hours) => {
      const clamped = Math.max(0, Math.min(10, hours));
      const norm = clamped / 10.0;
      return padT + chartH - norm * chartH;
    };

    const seriesList = [
      { key: "valence_laya", show: showValence, color: isDark ? "#60a5fa" : "#0071e3", isSleep: false },
      { key: "energy_laya", show: showEnergy, color: isDark ? "#a78bfa" : "#5856d6", isSleep: false },
      { key: "sleep_hours", show: showSleep, color: "#34c759", isSleep: true },
      { key: "workload", show: showWorkload, color: "#ff9500", isSleep: false }
    ];

    seriesList.forEach((s) => {
      if (!s.show) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();

      pts.forEach((p, i) => {
        const x = getX(i);
        const y = s.isSleep ? getYSleep(p[s.key]) : getYPrimary(p[s.key], 1, 5);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      pts.forEach((p, i) => {
        const x = getX(i);
        const y = s.isSleep ? getYSleep(p[s.key]) : getYPrimary(p[s.key], 1, 5);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = dotCenterColor;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Etiquetas del Eje X (Fechas)
    ctx.textAlign = "center";
    ctx.fillStyle = axisLabelColor;
    ctx.font = "11px -apple-system, sans-serif";
    const labelStep = pts.length > 14 ? Math.ceil(pts.length / 10) : 1;
    pts.forEach((p, i) => {
      const x = getX(i);
      if (i % labelStep === 0 || i === pts.length - 1) {
        const dateParts = p.date.split("-");
        const shortDate = `${dateParts[2]}/${dateParts[1]}`;
        ctx.fillText(shortDate, x, height - 15);
      }

      if (p.has_discrepancy) {
        ctx.fillStyle = "#ff9500";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.fillText("✦", x, padT - 10);
        ctx.font = "11px -apple-system, sans-serif";
        ctx.fillStyle = axisLabelColor;
      }
    });

    // Tooltip en Hover
    if (this.hoverIndex >= 0 && this.hoverIndex < pts.length) {
      const p = pts[this.hoverIndex];
      const x = getX(this.hoverIndex);

      ctx.strokeStyle = isDark ? "rgba(255, 255, 255, 0.25)" : "rgba(0, 0, 0, 0.15)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      const boxW = 195;
      const boxH = 115;
      let boxX = x + 15;
      if (boxX + boxW > width - 10) boxX = x - boxW - 15;
      const boxY = padT + 10;

      ctx.fillStyle = isDark ? "rgba(15, 23, 42, 0.96)" : "rgba(29, 29, 31, 0.92)";
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 8);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.font = "bold 12px -apple-system, sans-serif";
      ctx.fillText(`${p.date} ${p.has_discrepancy ? '✦ Discrepancia' : ''}`, boxX + 12, boxY + 20);

      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillStyle = "#98c4f9";
      ctx.fillText(`Ánimo Laya: ${p.valence_laya} / 5`, boxX + 12, boxY + 40);

      ctx.fillStyle = "#cbb8f9";
      ctx.fillText(`Energía: ${p.energy_laya} / 5`, boxX + 12, boxY + 58);

      ctx.fillStyle = "#a3e6af";
      ctx.fillText(`Sueño: ${p.sleep_hours} horas (eje 0-10h)`, boxX + 12, boxY + 76);

      ctx.fillStyle = "#ffd08a";
      ctx.fillText(`Carga: ${p.workload} / 5 (${p.primary_emotion})`, boxX + 12, boxY + 94);
    }
  }
};
