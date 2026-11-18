/**
 * Dial de fricción táctil: mantener 420 ms + deslizar izquierda/derecha.
 * Integra el módulo `mountFrictionDial` del prototipo validado.
 */

const LearnDial = {
  mount(container, options) {
    const { leftLabel = "Mito", rightLabel = "Realidad", onAnswer } = options || {};
    const CIRC = 2 * Math.PI * 29;

    container.innerHTML = `
      <div class="friction-wrap">
        <div class="friction-stage" id="friction-stage">
          <div class="friction-wings">
            <button type="button" class="friction-wing" data-side="left">${leftLabel}</button>
            <button type="button" class="friction-wing" data-side="right">${rightLabel}</button>
          </div>
          <div class="friction-knob" id="friction-knob">
            <svg class="friction-ring-svg" viewBox="0 0 68 68">
              <circle cx="34" cy="34" r="29" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="4"/>
              <circle id="friction-ring" cx="34" cy="34" r="29" fill="none" stroke="#38bdf8" stroke-width="4"
                stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/>
            </svg>
            <span id="friction-icon" class="friction-icon">👆</span>
            <span id="friction-hint" class="friction-hint">MANTÉN</span>
          </div>
        </div>
        <div id="friction-sub" class="friction-sub">
          Mantén 0.4 s y desliza: ${leftLabel} ← → ${rightLabel}
        </div>
        <button type="button" class="friction-skip" id="friction-skip">Prefiero usar botones</button>
      </div>
    `;

    const stage = container.querySelector("#friction-stage");
    const knob = container.querySelector("#friction-knob");
    const ring = container.querySelector("#friction-ring");
    const icon = container.querySelector("#friction-icon");
    const hint = container.querySelector("#friction-hint");
    const sub = container.querySelector("#friction-sub");
    const skip = container.querySelector("#friction-skip");
    const leftWing = container.querySelector('[data-side="left"]');
    const rightWing = container.querySelector('[data-side="right"]');

    let unlocked = false;
    let dragging = false;
    let lockedOut = false;
    let startX = 0;
    let currentDx = 0;
    let chargeRaf = null;
    let lastTickStep = -1;
    const HOLD_MS = 420;

    function resetCharge() {
      if (chargeRaf) cancelAnimationFrame(chargeRaf);
      knob.classList.remove("charging");
      if (!unlocked) {
        ring.style.strokeDashoffset = String(CIRC);
        icon.textContent = "👆";
        hint.textContent = "MANTÉN";
      }
    }

    function unlockDial() {
      if (unlocked) return;
      unlocked = true;
      knob.classList.remove("charging");
      knob.classList.add("burst");
      stage.classList.add("unlocked");
      ring.style.strokeDashoffset = "0";
      icon.textContent = "⇄";
      hint.textContent = "DESLIZA";
      skip.hidden = true;
      sub.textContent = "Desliza hacia tu respuesta (o toca una opción)";
      sub.classList.add("is-ready");
      LearnAudio.unlock();
    }

    function resetDial() {
      lockedOut = false;
      unlocked = false;
      dragging = false;
      stage.classList.remove("unlocked");
      knob.classList.remove("burst", "charging");
      knob.style.transform = "";
      leftWing.classList.remove("active-left");
      rightWing.classList.remove("active-right");
      ring.style.strokeDashoffset = String(CIRC);
      icon.textContent = "👆";
      hint.textContent = "MANTÉN";
      sub.textContent = `Mantén 0.4 s y desliza: ${leftLabel} ← → ${rightLabel}`;
      sub.classList.remove("is-ready");
      skip.hidden = false;
    }

    function commit(side) {
      if (lockedOut) return;
      lockedOut = true;
      dragging = false;
      knob.style.transform = "";
      leftWing.classList.remove("active-left");
      rightWing.classList.remove("active-right");
      LearnAudio.pop();
      if (typeof onAnswer === "function") onAnswer(side);
    }

    function maxTravel() {
      return Math.max(70, stage.clientWidth * 0.34);
    }

    knob.addEventListener("pointerdown", (e) => {
      if (lockedOut) return;
      e.preventDefault();
      try { knob.setPointerCapture(e.pointerId); } catch {}
      dragging = true;
      startX = e.clientX;
      currentDx = 0;

      if (!unlocked) {
        knob.classList.add("charging");
        icon.textContent = "⚡";
        hint.textContent = "CARGANDO";
        const t0 = performance.now();
        lastTickStep = -1;
        const stepCharge = (now) => {
          if (!dragging || unlocked) return;
          const p = Math.min(1, (now - t0) / HOLD_MS);
          ring.style.strokeDashoffset = String(CIRC * (1 - p));
          const tick = Math.floor(p * 4);
          if (tick > lastTickStep) {
            lastTickStep = tick;
            LearnAudio.chargeTick(p);
          }
          if (p >= 1) {
            startX = e.clientX;
            unlockDial();
          } else {
            chargeRaf = requestAnimationFrame(stepCharge);
          }
        };
        chargeRaf = requestAnimationFrame(stepCharge);
      }
    });

    knob.addEventListener("pointermove", (e) => {
      if (!dragging || !unlocked || lockedOut) return;
      const max = maxTravel();
      currentDx = Math.max(-max, Math.min(max, e.clientX - startX));
      knob.style.transform = `translateX(${currentDx}px)`;
      const threshold = max * 0.48;
      leftWing.classList.toggle("active-left", currentDx < -threshold);
      rightWing.classList.toggle("active-right", currentDx > threshold);
    });

    const endPointer = () => {
      if (!dragging) return;
      dragging = false;
      if (!unlocked) {
        resetCharge();
        return;
      }
      const threshold = maxTravel() * 0.48;
      if (currentDx < -threshold) commit("left");
      else if (currentDx > threshold) commit("right");
      else {
        knob.style.transform = "translateX(0px)";
        leftWing.classList.remove("active-left");
        rightWing.classList.remove("active-right");
      }
    };

    knob.addEventListener("pointerup", endPointer);
    knob.addEventListener("pointercancel", endPointer);
    leftWing.addEventListener("click", () => {
      if (unlocked && !lockedOut) commit("left");
    });
    rightWing.addEventListener("click", () => {
      if (unlocked && !lockedOut) commit("right");
    });
    skip.addEventListener("click", () => {
      unlockDial();
      skip.hidden = true;
      sub.textContent = "Elige con las opciones de arriba";
    });

    return {
      reset: resetDial,
      destroy() {
        if (chargeRaf) cancelAnimationFrame(chargeRaf);
      }
    };
  }
};
