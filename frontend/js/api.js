/**
 * Cliente de API unificado para Diario RPG (Modo Dual: Local FastAPI + Firebase Cloud E2EE).
 */

const API = {
  mode: "local", // "local" | "cloud"

  baseUrl: (
    (window.__DIARIO_CONFIG__ && window.__DIARIO_CONFIG__.apiBaseUrl) ||
    document.querySelector('meta[name="diario-api-base"]')?.getAttribute("content") ||
    ""
  ).replace(/\/+$/, ""),

  getAuthToken: null,

  setMode(mode) {
    this.mode = mode === "cloud" ? "cloud" : "local";
  },

  isCloud() {
    return this.mode === "cloud";
  },

  escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  _resolveUrl(url) {
    if (!url.startsWith("/")) return url;
    return `${this.baseUrl}${url}`;
  },

  /** Fetch con cookies de sesión o Bearer token y aviso global si la sesión expiró. */
  async _fetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (typeof this.getAuthToken === "function") {
      const token = await this.getAuthToken();
      if (token && !headers.Authorization) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    const credentials = options.credentials || (this.baseUrl ? "include" : "same-origin");
    const res = await fetch(this._resolveUrl(url), { ...options, headers, credentials });
    if (res.status === 401 && typeof Auth !== "undefined" && !url.includes("/auth/")) {
      Auth.onUnauthorized();
    }
    return res;
  },

  async _json(res) {
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) {
      const detail =
        data && typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data?.detail) && data.detail[0]?.msg
            ? data.detail[0].msg
            : null;
      const error = new Error(detail || `Error ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  },

  async _cloud(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.status === 401 && typeof Auth !== "undefined") {
        Auth.onUnauthorized();
      }
      throw err;
    }
  },

  /* ------------------------------ Autenticación Local ------------------------------ */
  async getAuthStatus() {
    return this._json(await this._fetch("/api/auth/status"));
  },

  async login(username, password) {
    const res = await this._fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    return this._json(res);
  },

  async setupAccount(username, displayName, password) {
    const res = await this._fetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, display_name: displayName, password })
    });
    return this._json(res);
  },

  async logout() {
    if (this.isCloud()) return FirebaseBackend.logout();
    const res = await this._fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    return this._json(res);
  },

  async getMe() {
    return this._json(await this._fetch("/api/auth/me"));
  },

  async changePassword(currentPassword, newPassword) {
    const res = await this._fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
    });
    return this._json(res);
  },

  async listUsers() {
    return this._json(await this._fetch("/api/users"));
  },

  async createUser(username, displayName, password, role = "user") {
    const res = await this._fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, display_name: displayName, password, role })
    });
    return this._json(res);
  },

  async updateUser(userId, payload) {
    const res = await this._fetch(`/api/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return this._json(res);
  },

  async resetUserPassword(userId, newPassword = null) {
    const res = await this._fetch(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: newPassword })
    });
    return this._json(res);
  },

  /* ------------------------------ Datos del Diario (Modo Dual) ------------------------------ */
  async getStatus() {
    if (this.isCloud()) return FirebaseBackend.getStatus();
    return this._json(await this._fetch("/api/status"));
  },

  async getNetworkInfo() {
    if (this.isCloud()) return FirebaseBackend.getNetworkInfo();
    return this._json(await this._fetch("/api/network-info"));
  },

  async getQuickNotes(date) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getQuickNotes(date));
    return this._json(await this._fetch(`/api/quick-notes?date=${encodeURIComponent(date)}`));
  },

  async createQuickNote(date, time, text) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.createQuickNote(date, time, text));
    const res = await this._fetch("/api/quick-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, time, text })
    });
    return this._json(res);
  },

  async getDayEntry(date) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getDayEntry(date));
    return this._json(await this._fetch(`/api/day-entry?date=${encodeURIComponent(date)}`));
  },

  async saveDayEntry(data) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.saveDayEntry(data));
    const res = await this._fetch("/api/day-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return this._json(res);
  },

  async getHistory(limit = 100) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getHistory(limit));
    return this._json(await this._fetch(`/api/history?limit=${encodeURIComponent(limit)}`));
  },

  async getPatterns(days = 0, refreshLlm = false) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getPatterns(days));
    return this._json(
      await this._fetch(`/api/patterns?days=${encodeURIComponent(days)}&refresh_llm=${Boolean(refreshLlm)}`)
    );
  },

  async summarizePatterns(days = 0) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.summarizePatterns(days));
    const res = await this._fetch(`/api/patterns/summarize?days=${encodeURIComponent(days)}`, {
      method: "POST"
    });
    return this._json(res);
  },

  async getProfile() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getProfile());
    return this._json(await this._fetch("/api/profile"));
  },

  async saveProfile(profilePayload) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.saveProfile(profilePayload));
    const res = await this._fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profilePayload)
    });
    return this._json(res);
  },

  async getAssessments() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getAssessments());
    return this._json(await this._fetch("/api/assessments"));
  },

  async submitAssessment(quizId, answers) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.submitAssessment(quizId, answers));
    const res = await this._fetch("/api/assessments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quiz_id: quizId, answers })
    });
    return this._json(res);
  },

  async getCompanion() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getCompanion());
    return this._json(await this._fetch("/api/companion"));
  },

  async companionAction(action, value = null) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.companionAction(action, value));
    const res = await this._fetch("/api/companion/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, value })
    });
    return this._json(res);
  },

  async submitFeedback(date, textSnippet, questionId, originalValue, correctedValue, notes = "") {
    if (this.isCloud()) {
      return this._cloud(() =>
        FirebaseBackend.submitFeedback(date, textSnippet, questionId, originalValue, correctedValue)
      );
    }
    const res = await this._fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        text_snippet: textSnippet,
        question_id: questionId,
        original_value: originalValue,
        corrected_value: correctedValue,
        notes
      })
    });
    return this._json(res);
  },

  async getDevTrace() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getDevTrace());
    return this._json(await this._fetch("/api/dev/trace"));
  },

  async simulateLaya(text) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.simulateLaya(text));
    const res = await this._fetch("/api/dev/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    return this._json(res);
  },

  async resetDatabase() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.resetDatabase());
    const res = await this._fetch("/api/dev/reset-db", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    return this._json(res);
  },

  async simulateWeek() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.simulateWeek());
    const res = await this._fetch("/api/dev/simulate-week", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    return this._json(res);
  },

  async getLearningState() {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getLearningState());
    return this._json(await this._fetch("/api/learning/state"));
  },

  async getLearningLesson(lessonId) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.getLearningLesson(lessonId));
    return this._json(await this._fetch(`/api/learning/lesson/${encodeURIComponent(lessonId)}`));
  },

  async completeLesson(lessonId, accuracy) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.completeLesson(lessonId, accuracy));
    const res = await this._fetch("/api/learning/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lesson_id: lessonId, accuracy })
    });
    return this._json(res);
  },

  async saveNotebookEntry(lessonId, statementText, trackTitle = null) {
    if (this.isCloud()) {
      return this._cloud(() => FirebaseBackend.saveNotebookEntry(lessonId, statementText, trackTitle));
    }
    const res = await this._fetch("/api/learning/notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lesson_id: lessonId, statement_text: statementText, track_title: trackTitle })
    });
    return this._json(res);
  },

  async deleteNotebookEntry(entryId) {
    if (this.isCloud()) return this._cloud(() => FirebaseBackend.deleteNotebookEntry(entryId));
    const res = await this._fetch(`/api/learning/notebook/${encodeURIComponent(entryId)}`, { method: "DELETE" });
    return this._json(res);
  }
};
