/**
 * Componente Reutilizable: Gráfica de Radar de 5 Ejes (HTML5 Canvas)
 * Usado en Onboarding (Resultado visual), Patrones (Ejes Laya AI) y Autoconocimiento (Radar Personal).
 */

const RadarChartHelper = {
  splitLabelLines(label) {
    if (!label || label.length <= 12) return [label];
    if (label.includes(" / ")) {
      const parts = label.split(" / ");
      return [parts[0] + " /", parts[1]];
    }
    const words = label.split(" ");
    if (words.length >= 2) {
      const mid = Math.ceil(words.length / 2);
      return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
    }
    return [label];
  },

  draw(canvas, labels, values, options = {}) {
    if (!canvas || !labels || labels.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width || canvas.width || 340;
    const cssHeight = rect.height || canvas.height || 290;

    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDark ? "rgba(212, 195, 154, 0.18)" : "rgba(104, 95, 83, 0.16)";
    const labelColor = isDark ? "#e2dccb" : "#27221d";
    const valueColor = options.strokeColor || (isDark ? "#38bdf8" : "#0284c7");
    const fillColor = options.fillColor || (isDark ? "rgba(56, 189, 248, 0.24)" : "rgba(2, 132, 199, 0.18)");
    const maxVal = options.maxValue || 100;

    const cx = cssWidth / 2;
    const cy = cssHeight / 2 + 6;
    const radius = Math.min(cssWidth, cssHeight) * 0.26;
    const count = labels.length;
    const angleStep = (Math.PI * 2) / count;
    const startAngle = -Math.PI / 2;

    // 1. Anillos concéntricos (20%, 40%, 60%, 80%, 100%)
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 5; ring++) {
      const r = (radius * ring) / 5;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const angle = startAngle + i * angleStep;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = gridColor;
      ctx.stroke();
    }

    // 2. Ejes radiales y etiquetas con ajuste multilínea seguro
    labels.forEach((label, i) => {
      const angle = startAngle + i * angleStep;
      const xEnd = cx + Math.cos(angle) * radius;
      const yEnd = cy + Math.sin(angle) * radius;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(xEnd, yEnd);
      ctx.strokeStyle = gridColor;
      ctx.stroke();

      const labelDist = radius + 18;
      let lx = cx + Math.cos(angle) * labelDist;
      const ly = cy + Math.sin(angle) * labelDist;

      const cosA = Math.cos(angle);
      if (Math.abs(cosA) < 0.2) {
        ctx.textAlign = "center";
      } else if (cosA > 0) {
        ctx.textAlign = "left";
      } else {
        ctx.textAlign = "right";
      }

      const sinA = Math.sin(angle);
      const lines = this.splitLabelLines(label);
      let baseY = ly;
      if (sinA < -0.5) baseY = ly - (lines.length * 12) - 4;
      else if (sinA > 0.5) baseY = ly + 6;
      else baseY = ly - ((lines.length - 1) * 6);

      ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
      ctx.fillStyle = labelColor;
      lines.forEach((line, idx) => {
        ctx.fillText(line, lx, baseY + idx * 13);
      });

      const valPct = Math.round(values[i] ?? 0);
      ctx.font = "700 10.5px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = valueColor;
      ctx.fillText(`${valPct}%`, lx, baseY + lines.length * 13);
    });

    // 3. Polígono secundario de comparación (si existe)
    if (options.compareValues && options.compareValues.length === count) {
      ctx.beginPath();
      options.compareValues.forEach((v, i) => {
        const clamped = Math.max(0, Math.min(maxVal, v));
        const r = (clamped / maxVal) * radius;
        const angle = startAngle + i * angleStep;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = isDark ? "rgba(167, 139, 250, 0.7)" : "rgba(88, 86, 214, 0.55)";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 4. Polígono principal relleno
    ctx.beginPath();
    const vertexCoords = [];
    values.forEach((v, i) => {
      const clamped = Math.max(0, Math.min(maxVal, v));
      const r = (clamped / maxVal) * radius;
      const angle = startAngle + i * angleStep;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      vertexCoords.push({ x, y });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();

    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = valueColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // 5. Puntos en cada vértice
    vertexCoords.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = valueColor;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? "#0f172a" : "#ffffff";
      ctx.fill();
    });
  }
};
