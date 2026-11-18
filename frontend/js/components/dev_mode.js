/**
 * Componente: Modo Desarrollador (Developer Drawer & Inspección en Vivo)
 * Proporciona transparencia total sobre las preguntas enviadas a Laya AI,
 * las probabilidades devueltas, las fórmulas matemáticas de valencia y
 * el peso de las respuestas del cuestionario del día.
 */

const DevModeComponent = {
  drawer: null,
  backdrop: null,
  cachedTrace: null,

  init() {
    this.drawer = document.getElementById("dev-drawer");
    this.backdrop = document.getElementById("dev-drawer-backdrop");

    const toggleBtn = document.getElementById("dev-mode-btn");
    const closeBtn = document.getElementById("dev-drawer-close-btn");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => this.open());
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }

    if (this.backdrop) {
      this.backdrop.addEventListener("click", () => this.close());
    }

    this.setupSubTabs();
    this.setupSimulator();
    this.setupCopyButton();
  },

  open() {
    if (this.drawer && this.backdrop) {
      this.drawer.classList.add("active");
      this.backdrop.classList.add("active");
      this.loadTrace();
    }
  },

  close() {
    if (this.drawer && this.backdrop) {
      this.drawer.classList.remove("active");
      this.backdrop.classList.remove("active");
    }
  },

  setupSubTabs() {
    const tabs = document.querySelectorAll(".dev-tab-btn");
    const panes = document.querySelectorAll(".devtab-pane");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.devtab;
        tabs.forEach((t) => t.classList.remove("active"));
        panes.forEach((p) => p.classList.remove("active"));

        tab.classList.add("active");
        const activePane = document.getElementById(`devtab-pane-${target}`);
        if (activePane) activePane.classList.add("active");
      });
    });
  },

  setupSimulator() {
    const runBtn = document.getElementById("dev-sim-run-btn");
    const input = document.getElementById("dev-sim-input");

    if (runBtn && input) {
      runBtn.addEventListener("click", async () => {
        const text = input.value.trim();
        if (!text) {
          App.showToast("Escribe una frase para simular");
          return;
        }

        const status = document.getElementById("dev-sim-status");
        const container = document.getElementById("dev-sim-results-container");

        runBtn.disabled = true;
        status.textContent = "Ejecutando inferencia con Laya AI...";

        try {
          const res = await API.simulateLaya(text);
          status.textContent = `✓ Inferencia completada en ${res.latency_ms} ms (${res.input_tokens} tokens)`;
          this.renderSimulationResults(res, container);
        } catch (err) {
          status.textContent = "Error al ejecutar simulación.";
          console.error(err);
        } finally {
          runBtn.disabled = false;
        }
      });
    }
  },

  setupCopyButton() {
    const btn = document.getElementById("dev-copy-schema-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        const codeBox = document.getElementById("dev-schema-json-box");
        if (codeBox) {
          navigator.clipboard.writeText(codeBox.textContent).then(() => {
            App.showToast("Schema JSON copiado al portapapeles");
          });
        }
      });
    }
  },

  async loadTrace() {
    try {
      const data = await API.getDevTrace();
      this.cachedTrace = data;

      // 1. Badge de Estado del Modelo
      const statusBadge = document.getElementById("dev-model-status-badge");
      if (statusBadge) {
        const rawLaya = String(data.active_laya_model || "");
        const layaName = rawLaya.includes("laya_finetuned")
          ? "Laya AI (Afinado localmente)"
          : rawLaya.includes("syntax-calibrada")
            ? "Motor Sintáctico 16 Señales + Calibración Local (Navegador)"
            : rawLaya.includes("heuristica")
              ? "Heurística local (Laya no instalado)"
              : "Laya AI (Multilingual Base)";
        statusBadge.innerHTML = `<b>Modelo:</b> ${API.escapeHtml(layaName)} · <b>Redactor:</b> ${API.escapeHtml(data.active_qwen_model)}`;
      }

      // 2. Renderizar Pestaña 1: Última Inferencia
      this.renderInferenceTrace(data.last_trace);

      // 3. Renderizar Pestaña 2: Pesos del Cuestionario
      this.renderQuestionnaireWeights(data.questionnaire_weights_explanation);

      // 4. Renderizar Pestaña 4: Schema JSON
      const schemaBox = document.getElementById("dev-schema-json-box");
      if (schemaBox && data.system_schema) {
        schemaBox.textContent = JSON.stringify(data.system_schema.questions, null, 2);
      }

    } catch (err) {
      console.error("Error al cargar traza de desarrollo:", err);
    }
  },

  renderInferenceTrace(trace) {
    const latencyBadge = document.getElementById("dev-latency-badge");
    const summaryBox = document.getElementById("dev-metrics-summary");
    const textBox = document.getElementById("dev-input-text-box");
    const valenceBadge = document.getElementById("dev-valence-score-badge");
    const stepsContainer = document.getElementById("dev-valence-steps-container");
    const questionsContainer = document.getElementById("dev-questions-breakdown-container");

    if (!trace || trace.type === "initial_ready") {
      if (summaryBox) {
        summaryBox.innerHTML = `
          <i>Aún no se ha guardado una entrada en esta sesión.</i><br>
          Guarda un día en la pestaña <b>Hoy</b> o prueba el <b>Simulador en Vivo</b> para ver los números exactos.
        `;
      }
      return;
    }

    if (latencyBadge) latencyBadge.textContent = `${trace.latency_ms} ms · ${trace.input_tokens} tokens`;
    if (textBox) textBox.textContent = trace.input_text || "(Sin texto)";

    // Resumen de Métricas
    if (summaryBox) {
      const timestamp = new Date(trace.timestamp).toLocaleTimeString();
      summaryBox.innerHTML = `
        <div><b>Fecha registrada:</b> ${API.escapeHtml(trace.date || 'Hoy')} (${API.escapeHtml(timestamp)})</div>
        <div><b>Latencia de pasada no autorregresiva:</b> ${Number(trace.latency_ms) || 0} ms</div>
        <div><b>Presupuesto de tokens:</b> ${Number(trace.input_tokens) || 0} tokens procesados</div>
      `;
    }

    // Desglose de Cálculo de Valencia
    const calc = trace.valence_calculation || {};
    if (valenceBadge) valenceBadge.textContent = `Score Continuo: ${calc.final_score || '--'} / 5.0`;

    if (stepsContainer && calc.steps) {
      stepsContainer.innerHTML = calc.steps
        .map(
          (s) => `
        <div class="weight-row">
          <span><b>${s.category}:</b> ${s.percentage}</span>
          <span style="color: var(--text-tertiary);">× peso ${s.weight} = <b style="color: var(--accent-blue);">${s.contribution}</b></span>
        </div>
      `
        )
        .join("") + `
        <div style="margin-top: 0.5rem; text-align: right; font-weight: 700; color: #0071e3; font-size: 0.88rem;">
          Puntaje Final: ${calc.final_score} / 5.0
        </div>
      `;
    }

    // Desglose de Respuestas y Probabilidades por Pregunta
    if (questionsContainer && trace.raw_answers) {
      let qHtml = "";
      for (const [qId, qData] of Object.entries(trace.raw_answers)) {
        const type = API.escapeHtml(qData.type);
        qHtml += `<div style="margin-bottom: 1rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.75rem;">`;
        qHtml += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
          <span style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">${API.escapeHtml(qId.toUpperCase())}</span>
          <span class="dev-tag">${type}</span>
        </div>`;

        if (qData.type === "choice") {
          const choice = qData.choice;
          const conf = (Number(qData.answer_confidence || 0) * 100).toFixed(1);
          qHtml += `<div style="font-size: 0.8rem; margin-bottom: 0.4rem;">Ganador: <b style="color: #0071e3;">${API.escapeHtml(choice)}</b> (certeza: ${conf}%)</div>`;
          for (const [opt, p] of Object.entries(qData.probabilities || {})) {
            const pct = (Number(p || 0) * 100).toFixed(1);
            const isWinner = opt === choice;
            qHtml += `
              <div class="prob-bar-wrapper" style="margin-bottom: 0.35rem;">
                <div class="prob-bar-label" style="font-size: 0.75rem;">
                  <span style="${isWinner ? 'font-weight: 700; color: #0071e3;' : ''}">${API.escapeHtml(opt)} ${isWinner ? '✓' : ''}</span>
                  <span>${pct}%</span>
                </div>
                <div class="prob-track" style="height: 4px;">
                  <div class="prob-fill" style="width: ${pct}%; ${isWinner ? 'background: #0071e3;' : 'background: #c7c7cc;'}"></div>
                </div>
              </div>
            `;
          }
        } else if (qData.type === "noul") {
          const pSi = (Number(qData.noul || 0) * 100).toFixed(1);
          qHtml += `
            <div style="font-size: 0.8rem; margin-bottom: 0.3rem;">Probabilidad afirmativa: <b>${pSi}%</b></div>
            <div class="prob-track" style="height: 6px;">
              <div class="prob-fill" style="width: ${pSi}%; background: ${Number(pSi) > 50 ? '#ff9500' : '#8e8e93'};"></div>
            </div>
          `;
        }
        qHtml += `</div>`;
      }
      questionsContainer.innerHTML = qHtml + this._renderSyntaxSection(trace);
    }
  },

  _renderSyntaxSection(trace) {
    const syn = trace && trace.syntax_analysis;
    if (!syn) return "";
    const activeSignals = Object.entries(syn.signals16 || {})
      .filter(([, val]) => Number(val) > 0)
      .map(([k, val]) => `<span class="dev-tag" style="margin: 0.15rem;">${API.escapeHtml(k)}: ${(Number(val) * 100).toFixed(0)}%</span>`)
      .join("");
    const clausesHtml = (syn.clauses || [])
      .map((c) => `
        <div style="font-size: 0.76rem; color: var(--text-secondary); margin-bottom: 0.25rem;">
          <b>[peso ${c.weight}${c.isPostAdversative ? " · post-adv" : ""}]</b> ${API.escapeHtml(c.text)}
        </div>
      `)
      .join("");
    const cal = trace.calibration_meta || {};
    const blend = cal.desgaste_blend || {};
    return `
      <div style="margin-top: 0.85rem; padding-top: 0.75rem; border-top: 1px dashed var(--border-subtle);">
        <div style="font-weight: 700; font-size: 0.82rem; color: var(--accent-indigo); margin-bottom: 0.4rem;">
          Análisis Sintáctico & Calibración (${Number(syn.postAdversativeClauses || 0)} post-adversativas)
        </div>
        ${clausesHtml}
        <div style="margin-top: 0.45rem;">${activeSignals || '<span style="font-size:0.75rem; color:var(--text-tertiary);">Sin señales sintácticas activas (texto neutro).</span>'}</div>
        ${blend.ema_3d !== null && blend.ema_3d !== undefined
          ? `<div style="font-size: 0.74rem; color: var(--text-tertiary); margin-top: 0.35rem;">EMA 3d desgaste: ${(Number(blend.ema_3d) * 100).toFixed(1)}% · Hoy: ${(Number(blend.p_today) * 100).toFixed(1)}%</div>`
          : ""}
      </div>
    `;
  },

  renderQuestionnaireWeights(weightsExpl) {
    const container = document.getElementById("dev-questionnaire-weights-container");
    if (!container || !weightsExpl) return;

    let html = "";
    for (const [key, item] of Object.entries(weightsExpl)) {
      html += `
        <div class="dev-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
            <span style="font-weight: 700; font-size: 0.9rem; text-transform: capitalize;">${key.replace(/_/g, " ")}</span>
            <span class="dev-tag">${item.impacto}</span>
          </div>
          <div style="font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: 0.4rem;">
            <b>Mecanismo de Cálculo:</b> ${item.calculo}
          </div>
          <div style="font-size: 0.82rem; color: var(--text-primary); line-height: 1.5;">
            <b>Propósito & Cruce:</b> ${item.rol || item.umbral || ''}
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  },

  renderSimulationResults(res, container) {
    if (!container) return;

    const answers = res.raw_answers || {};
    let html = `
      <div class="dev-card" style="margin-top: 1rem; border-color: #5856d6;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <span style="font-weight: 700; color: #5856d6; font-size: 0.85rem;">Resultado de la Inferencia en Vivo</span>
          <span class="dev-tag">${res.latency_ms} ms</span>
        </div>
        <div style="font-size: 0.82rem; margin-bottom: 0.75rem;">
          <b>Score Valencia Calculado:</b> ${res.valence_calculation.final_score} / 5.0
        </div>
    `;

    for (const [qId, qData] of Object.entries(answers)) {
      html += `<div style="margin-bottom: 0.75rem; border-top: 1px dashed var(--border-subtle); padding-top: 0.5rem;">`;
      html += `<div style="font-weight: 600; font-size: 0.8rem; margin-bottom: 0.25rem;">${API.escapeHtml(qId)} (${API.escapeHtml(qData.type)})</div>`;

      if (qData.type === "choice") {
        html += `<div style="font-size: 0.78rem; margin-bottom: 0.3rem;">Selección: <b>${API.escapeHtml(qData.choice)}</b> (${(Number(qData.answer_confidence || 0) * 100).toFixed(1)}%)</div>`;
        for (const [opt, p] of Object.entries(qData.probabilities || {})) {
          const pct = (Number(p || 0) * 100).toFixed(1);
          html += `
            <div class="prob-bar-label" style="font-size: 0.72rem;">
              <span>${API.escapeHtml(opt)}</span>
              <span>${pct}%</span>
            </div>
            <div class="prob-track" style="height: 3px; margin-bottom: 0.25rem;">
              <div class="prob-fill" style="width: ${pct}%;"></div>
            </div>
          `;
        }
      } else if (qData.type === "noul") {
        const pct = (Number(qData.noul || 0) * 100).toFixed(1);
        html += `
          <div class="prob-bar-label" style="font-size: 0.72rem;">
            <span>Probabilidad Sí: ${pct}%</span>
          </div>
          <div class="prob-track" style="height: 3px;">
            <div class="prob-fill" style="width: ${pct}%; background: #ff9500;"></div>
          </div>
        `;
      }
      html += `</div>`;
    }

    html += `${this._renderSyntaxSection(res)}</div>`;
    container.innerHTML = html;
  }
};
