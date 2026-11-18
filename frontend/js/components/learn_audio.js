/**
 * SoundFX 100% local para el módulo Aprender.
 * Sintetiza sonidos con Web Audio API (sin archivos externos).
 */

const LearnAudio = {
  ctx: null,
  muted: localStorage.getItem("learn_audio_muted") === "1",

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  isMuted() {
    return this.muted;
  },

  setMuted(value) {
    this.muted = Boolean(value);
    localStorage.setItem("learn_audio_muted", this.muted ? "1" : "0");
    const btn = document.getElementById("learn-audio-btn");
    if (btn) {
      btn.textContent = this.muted ? "🔇" : "🔊";
      btn.title = this.muted ? "Activar sonidos" : "Silenciar sonidos";
    }
  },

  toggle() {
    this.setMuted(!this.muted);
    if (!this.muted) this.unlock();
    return this.muted;
  },

  tone({ freq = 440, dur = 0.12, type = "sine", gain = 0.05, delay = 0, slideTo = null }) {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), start + dur);
    vol.gain.setValueAtTime(0.0001, start);
    vol.gain.exponentialRampToValueAtTime(gain, start + 0.015);
    vol.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(vol).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  },

  charge() {
    this.tone({ freq: 220, slideTo: 520, dur: 0.42, type: "triangle", gain: 0.035 });
  },

  unlock() {
    this.tone({ freq: 660, dur: 0.08, type: "sine", gain: 0.04 });
    this.tone({ freq: 880, dur: 0.1, type: "sine", gain: 0.035, delay: 0.06 });
  },

  correct(combo = 1) {
    const base = 520 + Math.min(6, Math.max(0, combo - 1)) * 55;
    this.tone({ freq: base, dur: 0.09, type: "sine", gain: 0.05 });
    this.tone({ freq: base * 1.25, dur: 0.12, type: "sine", gain: 0.045, delay: 0.07 });
  },

  error() {
    this.tone({ freq: 200, slideTo: 120, dur: 0.22, type: "sawtooth", gain: 0.035 });
  },

  wrong() {
    this.tone({ freq: 220, dur: 0.14, type: "sawtooth", gain: 0.055 });
    this.tone({ freq: 185, dur: 0.18, type: "sawtooth", gain: 0.055, delay: 0.1 });
  },

  chargeTick(pct = 0) {
    this.tone({ freq: 320 + pct * 360, dur: 0.045, type: "sine", gain: 0.035 });
  },

  pop() {
    this.tone({ freq: 540, dur: 0.06, type: "sine", gain: 0.06 });
  },

  chip() {
    this.tone({ freq: 660, dur: 0.05, type: "triangle", gain: 0.07 });
  },

  complete() {
    this.finish();
  },

  pick() {
    this.tone({ freq: 420, dur: 0.05, type: "triangle", gain: 0.03 });
  },

  finish() {
    [523, 659, 784, 1046].forEach((freq, i) => {
      this.tone({ freq, dur: 0.18, type: "triangle", gain: 0.045, delay: i * 0.11 });
    });
  },

  initButton() {
    const btn = document.getElementById("learn-audio-btn");
    if (btn) {
      btn.textContent = this.muted ? "🔇" : "🔊";
      btn.title = this.muted ? "Activar sonidos" : "Silenciar sonidos";
      btn.addEventListener("click", () => this.toggle());
    }
  }
};
