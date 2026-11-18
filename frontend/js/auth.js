/**
 * Autenticación y cuentas de Diario RPG (Modo Dual: Local + Firebase Auth / Bóveda E2EE).
 */

const Auth = {
  currentUser: null,
  mode: "loading",
  started: false,
  setupRequired: false,
  cloudRegisterMode: false,
  _pendingRecoveryKey: "",

  async init() {
    this.bind();
    const serverEl = document.getElementById("auth-server-url");
    if (serverEl) serverEl.textContent = API.baseUrl || window.location.host;

    const useCloud = await this._detectCloudMode();
    if (useCloud) {
      await this._initCloud();
    } else {
      await this._initLocal();
    }
  },

  async _detectCloudMode() {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get("mode");
    const canCloud = typeof FirebaseBackend !== "undefined" && FirebaseBackend.hasConfig();

    if (forced === "cloud" && canCloud) return true;
    if (forced === "local") return false;

    const host = window.location.hostname || "";
    const isFirebaseHost = host.endsWith(".web.app") || host.endsWith(".firebaseapp.com");
    if (isFirebaseHost && canCloud) return true;

    // En localhost/LAN comprobamos brevemente si el backend FastAPI está respondiendo.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1400);
      const res = await fetch(API._resolveUrl("/api/health"), {
        credentials: "same-origin",
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) return false;
    } catch {
      // Sin backend local -> usar modo nube si está configurado
    }
    return canCloud;
  },

  async _initLocal() {
    API.setMode("local");
    this._updateBrandCopy(false);
    try {
      const status = await API.getAuthStatus();
      this.setupRequired = Boolean(status.setup_required);
      if (status.setup_required) {
        this.show("login");
        this.updateSetupEntry();
      } else if (!status.authenticated) {
        this.show("login");
      } else if (status.user && status.user.must_change_password) {
        this.currentUser = status.user;
        this.show("change");
      } else {
        this.enterApp(status.user);
      }
    } catch (err) {
      this.show("login", "No se pudo conectar con el servidor local.");
    }
  },

  async _initCloud() {
    API.setMode("cloud");
    this._updateBrandCopy(true);
    this.show("loading");
    try {
      await FirebaseBackend.ensureInitialized();
      await FirebaseBackend.checkRedirectResult();
      const fbUser = await FirebaseBackend.waitForAuthUser();
      if (!fbUser) {
        this.show("cloud-login");
        return;
      }
      await this._handleFirebaseUser(fbUser);
    } catch (err) {
      console.error("Error iniciando Firebase:", err);
      this.show("cloud-login", err.message || "No se pudo iniciar la conexión cifrada con Firebase.");
    }
  },

  async _handleFirebaseUser(fbUser) {
    this.currentUser = FirebaseBackend.formatPublicUser(fbUser);
    this.show("loading");
    try {
      const vault = await FirebaseBackend.inspectVault();
      if (!vault.hasVault) {
        this._renderVaultAccountLabel("vault-create-account-label", this.currentUser);
        this.show("vault-create");
      } else if (!vault.unlocked) {
        this._renderVaultAccountLabel("vault-unlock-account-label", this.currentUser);
        this.show("vault-unlock");
      } else {
        this.enterApp(this.currentUser);
      }
    } catch (err) {
      this.show("cloud-login", err.message || "No se pudo comprobar tu bóveda cifrada.");
    }
  },

  _renderVaultAccountLabel(elId, user) {
    const el = document.getElementById(elId);
    if (!el || !user) return;
    const identity = user.email ? `${user.display_name} (${user.email})` : user.display_name;
    el.textContent = identity;
  },

  _updateBrandCopy(isCloud) {
    const tag = document.querySelector(".auth-tagline");
    const foot = document.querySelector(".auth-foot");
    const srv = document.querySelector(".auth-server");
    const privNote = document.getElementById("settings-privacy-note");

    if (isCloud) {
      if (tag) tag.textContent = "Tu diario cifrado de extremo a extremo. Solo tú tienes la llave.";
      if (foot) foot.textContent = "🔒 Cifrado AES-256-GCM en tu navegador · Firebase Zero-Knowledge";
      if (srv) srv.innerHTML = `Modo: <code>Nube cifrada (Firebase Spark)</code>`;
      if (privNote) {
        privNote.textContent =
          "Todos tus escritos, notas y progreso se cifran en tu dispositivo con AES-256-GCM antes de guardarse en Cloud Firestore. Nadie sin tu frase de bóveda puede leerlos.";
      }
    } else {
      if (tag) tag.textContent = "Tu diario, tus rutas, tus datos. Solo en este equipo.";
      if (foot) foot.textContent = "🔒 Local-first · Contraseñas con hash Argon2id · Sin nube";
      if (srv) srv.innerHTML = `Servidor: <code id="auth-server-url">${API.escapeHtml(API.baseUrl || window.location.host)}</code>`;
    }
  },

  bind() {
    // Formularios Locales
    document.getElementById("auth-login-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.login();
    });
    document.getElementById("auth-setup-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.setup();
    });
    document.getElementById("auth-change-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.changePasswordFromGate();
    });
    document.getElementById("auth-show-setup")?.addEventListener("click", () => {
      if (this.setupRequired) {
        this.show("setup");
      } else {
        this.showInfo(
          "La creación de cuentas la gestiona un administrador desde Mi cuenta → Usuarios del diario."
        );
      }
    });
    document.getElementById("auth-show-login")?.addEventListener("click", () => this.show("login"));

    // Formularios Cloud (Google + Email + Bóveda E2EE)
    document.getElementById("auth-google-btn")?.addEventListener("click", () => this.loginWithGoogle());
    document.getElementById("auth-cloud-email-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitCloudEmail();
    });
    document.getElementById("auth-cloud-toggle-mode")?.addEventListener("click", () => {
      this.cloudRegisterMode = !this.cloudRegisterMode;
      this.updateCloudEmailFormMode();
    });
    document.getElementById("auth-cloud-reset-btn")?.addEventListener("click", () => this.sendCloudPasswordReset());

    document.getElementById("vault-create-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createCloudVault();
    });
    document.getElementById("vault-unlock-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.unlockCloudVault();
    });
    document.getElementById("vault-recovery-unlock-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.unlockCloudVaultWithRecovery();
    });
    document.getElementById("vault-toggle-recovery")?.addEventListener("click", () => {
      const box = document.getElementById("vault-recovery-unlock-wrap");
      const form = document.getElementById("vault-unlock-form");
      if (!box || !form) return;
      const showRec = box.hidden;
      box.hidden = !showRec;
      form.hidden = showRec;
    });

    ["vault-create-switch-account", "vault-unlock-switch-account"].forEach((id) => {
      document.getElementById(id)?.addEventListener("click", async () => {
        await FirebaseBackend.logout();
        this.currentUser = null;
        this.show("cloud-login");
      });
    });

    document.getElementById("vault-recovery-copy")?.addEventListener("click", () => {
      if (!this._pendingRecoveryKey) return;
      navigator.clipboard?.writeText(this._pendingRecoveryKey);
      App.showToast("Llave de recuperación copiada.");
    });
    document.getElementById("vault-recovery-download")?.addEventListener("click", () => {
      this._downloadTextFile("diario-rpg-llave-recuperacion.txt",
        `Diario RPG · Llave de Recuperación Zero-Knowledge\nCuenta: ${this.currentUser?.email || this.currentUser?.uid}\n\n${this._pendingRecoveryKey}\n\nGuarda esta llave en un lugar seguro. Sin tu frase de bóveda ni esta llave nadie puede descifrar tu diario.\n`
      );
    });
    document.getElementById("vault-recovery-ack")?.addEventListener("change", (e) => {
      const btn = document.getElementById("vault-recovery-continue");
      if (btn) btn.disabled = !e.target.checked;
    });
    document.getElementById("vault-recovery-continue")?.addEventListener("click", () => {
      this._pendingRecoveryKey = "";
      this.enterApp(this.currentUser);
    });

    // Modal Mi Cuenta
    document.getElementById("header-user-btn")?.addEventListener("click", () => this.openAccount());
    document.getElementById("account-close-btn")?.addEventListener("click", () => this.closeAccount());
    document.getElementById("account-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "account-modal") this.closeAccount();
    });
    document.getElementById("account-logout-btn")?.addEventListener("click", () => this.logout());
    document.getElementById("account-change-btn")?.addEventListener("click", () => {
      const box = document.getElementById("account-change-wrap");
      if (box) box.hidden = !box.hidden;
    });
    document.getElementById("account-change-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.changePasswordFromAccount();
    });
    document.getElementById("user-create-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createUser();
    });

    // Acciones Cloud en Mi Cuenta
    document.getElementById("account-vault-change-btn")?.addEventListener("click", () => {
      const box = document.getElementById("account-vault-change-wrap");
      if (box) box.hidden = !box.hidden;
    });
    document.getElementById("account-vault-recovery-btn")?.addEventListener("click", () => {
      const box = document.getElementById("account-vault-recovery-wrap");
      if (box) box.hidden = !box.hidden;
    });
    document.getElementById("account-vault-change-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.changeCloudVaultPassphrase();
    });
    document.getElementById("account-vault-recovery-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.revealCloudRecoveryKey();
    });
    document.getElementById("account-export-btn")?.addEventListener("click", () => this.exportCloudBackup());
    document.getElementById("account-import-btn")?.addEventListener("click", () => {
      document.getElementById("account-import-file")?.click();
    });
    document.getElementById("account-import-file")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) this.importCloudBackup(file);
      e.target.value = "";
    });
  },

  show(mode, message = "") {
    this.mode = mode;
    const gate = document.getElementById("auth-gate");
    if (!gate) return;
    gate.hidden = false;
    document.body.classList.add("auth-locked");

    [
      "loading",
      "login",
      "setup",
      "change",
      "cloud-login",
      "vault-create",
      "vault-recovery",
      "vault-unlock"
    ].forEach((name) => {
      const panel = document.getElementById(`auth-panel-${name}`);
      if (panel) panel.hidden = name !== mode;
    });

    const errMap = {
      login: "auth-login-error",
      setup: "auth-setup-error",
      change: "auth-change-error",
      "cloud-login": "auth-cloud-error",
      "vault-create": "vault-create-error",
      "vault-unlock": "vault-unlock-error"
    };
    const errorBox = document.getElementById(errMap[mode] || "");
    if (errorBox) {
      errorBox.textContent = message || "";
      errorBox.hidden = !message;
    }

    if (mode !== "login") {
      const info = document.getElementById("auth-login-info");
      if (info) info.hidden = true;
    }
    if (mode === "login") this.updateSetupEntry();
    if (mode === "cloud-login") this.updateCloudEmailFormMode();

    const focusMap = {
      login: "auth-login-user",
      setup: "auth-setup-name",
      change: "auth-change-current",
      "cloud-login": "auth-cloud-email",
      "vault-create": "vault-create-pass",
      "vault-unlock": "vault-unlock-pass"
    };
    const target = document.getElementById(focusMap[mode]);
    if (target) setTimeout(() => target.focus(), 80);
  },

  updateCloudEmailFormMode() {
    const reg = this.cloudRegisterMode;
    const nameWrap = document.getElementById("auth-cloud-name-wrap");
    const pass2Wrap = document.getElementById("auth-cloud-pass2-wrap");
    const submitBtn = document.getElementById("auth-cloud-submit");
    const toggleBtn = document.getElementById("auth-cloud-toggle-mode");
    const resetBtn = document.getElementById("auth-cloud-reset-btn");
    const title = document.getElementById("auth-cloud-title");

    if (nameWrap) nameWrap.hidden = !reg;
    if (pass2Wrap) pass2Wrap.hidden = !reg;
    const nameInput = document.getElementById("auth-cloud-name");
    const pass2Input = document.getElementById("auth-cloud-pass2");
    if (nameInput) nameInput.required = reg;
    if (pass2Input) pass2Input.required = reg;
    if (submitBtn) submitBtn.textContent = reg ? "Crear cuenta con correo" : "Entrar con correo";
    if (toggleBtn) toggleBtn.textContent = reg ? "Ya tengo cuenta · Entrar" : "Crear cuenta con correo";
    if (resetBtn) resetBtn.hidden = reg;
    if (title) title.textContent = reg ? "Crear cuenta" : "Entrar a tu diario";
  },

  updateSetupEntry() {
    const notice = document.getElementById("auth-setup-notice");
    const text = document.getElementById("auth-switch-text");
    const link = document.getElementById("auth-show-setup");
    if (!text || !link) return;
    if (this.setupRequired) {
      if (notice) {
        notice.textContent =
          "Este equipo aún no tiene cuentas. Crea la primera cuenta administradora para empezar.";
        notice.hidden = false;
      }
      text.textContent = "¿Primera vez aquí?";
      link.textContent = "Crear cuenta administradora";
    } else {
      if (notice) notice.hidden = true;
      text.textContent = "¿No tienes cuenta?";
      link.textContent = "Crear cuenta";
    }
  },

  showInfo(message) {
    this.show("login");
    const info = document.getElementById("auth-login-info");
    if (info) {
      info.textContent = message;
      info.hidden = false;
    }
  },

  hideGate() {
    const gate = document.getElementById("auth-gate");
    if (gate) gate.hidden = true;
    document.body.classList.remove("auth-locked");
  },

  enterApp(user) {
    this.currentUser = user;
    this.hideGate();
    this.renderUserChip(user);

    const isAdmin = Boolean(user && user.role === "admin");
    const showDev = isAdmin || window.location.search.includes("dev=1");
    const devBtn = document.getElementById("dev-mode-btn");
    if (devBtn) devBtn.hidden = !showDev;
    const devTools = document.getElementById("date-tools-dev-section");
    if (devTools) devTools.hidden = !showDev;

    if (!this.started) {
      this.started = true;
      Promise.resolve(App.init()).catch((err) => {
        console.error("Error iniciando la app:", err);
      });
    } else if (API.isCloud()) {
      // Si se volvió a desbloquear bóveda tras bloqueo, recargar vista actual.
      App.loadUserProfile(true);
      DayEditorComponent.loadEntry();
      QuickNotesComponent.loadNotes();
    }
  },

  renderUserChip(user) {
    const nameEl = document.getElementById("header-user-name");
    const initialEl = document.getElementById("header-user-initial");
    if (!user) return;
    const name = user.display_name || user.username;
    if (nameEl) nameEl.textContent = name;
    if (initialEl) initialEl.textContent = (name || "?").trim().charAt(0).toUpperCase();
    const btn = document.getElementById("header-user-btn");
    if (btn) btn.title = `Cuenta de ${name}`;
  },

  setLoading(buttonId, loading, label) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (loading) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Un momento…";
    } else {
      btn.disabled = false;
      btn.textContent = label || btn.dataset.label || "Continuar";
    }
  },

  /* ------------------------- Flujos Cloud (Google / Email / Vault) ------------------------- */
  async loginWithGoogle() {
    const errorBox = document.getElementById("auth-cloud-error");
    if (errorBox) errorBox.hidden = true;
    const btn = document.getElementById("auth-google-btn");
    if (btn) btn.disabled = true;
    try {
      const user = await FirebaseBackend.loginWithGoogle();
      if (user) {
        await this._handleFirebaseUser(FirebaseBackend.user);
      }
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message || "No se pudo entrar con Google.";
        errorBox.hidden = false;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async submitCloudEmail() {
    const email = document.getElementById("auth-cloud-email").value.trim();
    const pass = document.getElementById("auth-cloud-pass").value;
    const errorBox = document.getElementById("auth-cloud-error");
    const infoBox = document.getElementById("auth-cloud-info");
    if (errorBox) errorBox.hidden = true;
    if (infoBox) infoBox.hidden = true;

    if (this.cloudRegisterMode) {
      const name = document.getElementById("auth-cloud-name").value.trim();
      const pass2 = document.getElementById("auth-cloud-pass2").value;
      if (pass !== pass2) {
        if (errorBox) {
          errorBox.textContent = "Las contraseñas no coinciden.";
          errorBox.hidden = false;
        }
        return;
      }
      this.setLoading("auth-cloud-submit", true);
      try {
        await FirebaseBackend.registerWithEmail(name, email, pass);
        document.getElementById("auth-cloud-pass").value = "";
        document.getElementById("auth-cloud-pass2").value = "";
        await this._handleFirebaseUser(FirebaseBackend.user);
      } catch (err) {
        if (errorBox) {
          errorBox.textContent = err.message || "No se pudo crear la cuenta.";
          errorBox.hidden = false;
        }
      } finally {
        this.setLoading("auth-cloud-submit", false, "Crear cuenta con correo");
      }
    } else {
      this.setLoading("auth-cloud-submit", true);
      try {
        await FirebaseBackend.loginWithEmail(email, pass);
        document.getElementById("auth-cloud-pass").value = "";
        await this._handleFirebaseUser(FirebaseBackend.user);
      } catch (err) {
        if (errorBox) {
          errorBox.textContent = err.message || "No se pudo iniciar sesión.";
          errorBox.hidden = false;
        }
      } finally {
        this.setLoading("auth-cloud-submit", false, "Entrar con correo");
      }
    }
  },

  async sendCloudPasswordReset() {
    const email = document.getElementById("auth-cloud-email").value.trim();
    const errorBox = document.getElementById("auth-cloud-error");
    const infoBox = document.getElementById("auth-cloud-info");
    if (errorBox) errorBox.hidden = true;
    if (infoBox) infoBox.hidden = true;
    try {
      await FirebaseBackend.sendPasswordReset(email);
      if (infoBox) {
        infoBox.textContent = "Te enviamos un enlace para restablecer tu contraseña a tu correo.";
        infoBox.hidden = false;
      }
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
    }
  },

  async createCloudVault() {
    const p1 = document.getElementById("vault-create-pass").value;
    const p2 = document.getElementById("vault-create-pass2").value;
    const errBox = document.getElementById("vault-create-error");
    if (errBox) errBox.hidden = true;
    if (p1.length < 8) {
      if (errBox) {
        errBox.textContent = "La frase de bóveda debe tener al menos 8 caracteres.";
        errBox.hidden = false;
      }
      return;
    }
    if (p1 !== p2) {
      if (errBox) {
        errBox.textContent = "Las frases no coinciden.";
        errBox.hidden = false;
      }
      return;
    }
    this.setLoading("vault-create-submit", true);
    try {
      const { recoveryKey } = await FirebaseBackend.createVault(p1);
      document.getElementById("vault-create-pass").value = "";
      document.getElementById("vault-create-pass2").value = "";
      this._pendingRecoveryKey = recoveryKey;
      const codeEl = document.getElementById("vault-recovery-code");
      if (codeEl) codeEl.textContent = recoveryKey;
      const ack = document.getElementById("vault-recovery-ack");
      const contBtn = document.getElementById("vault-recovery-continue");
      if (ack) ack.checked = false;
      if (contBtn) contBtn.disabled = true;
      this.show("vault-recovery");
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "No se pudo crear la bóveda cifrada.";
        errBox.hidden = false;
      }
    } finally {
      this.setLoading("vault-create-submit", false, "Crear bóveda cifrada");
    }
  },

  async unlockCloudVault() {
    const pass = document.getElementById("vault-unlock-pass").value;
    const errBox = document.getElementById("vault-unlock-error");
    if (errBox) errBox.hidden = true;
    this.setLoading("vault-unlock-submit", true);
    try {
      await FirebaseBackend.unlockVault(pass);
      document.getElementById("vault-unlock-pass").value = "";
      this.enterApp(this.currentUser);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "No se pudo desbloquear la bóveda.";
        errBox.hidden = false;
      }
    } finally {
      this.setLoading("vault-unlock-submit", false, "Desbloquear diario");
    }
  },

  async unlockCloudVaultWithRecovery() {
    const rec = document.getElementById("vault-recovery-input").value.trim();
    const newP1 = document.getElementById("vault-recovery-newpass").value;
    const newP2 = document.getElementById("vault-recovery-newpass2").value;
    const errBox = document.getElementById("vault-recovery-error");
    if (errBox) errBox.hidden = true;

    if (newP1 && newP1 !== newP2) {
      if (errBox) {
        errBox.textContent = "Las frases nuevas no coinciden.";
        errBox.hidden = false;
      }
      return;
    }

    this.setLoading("vault-recovery-unlock-submit", true);
    try {
      await FirebaseBackend.unlockVaultWithRecovery(rec);
      if (newP1) {
        await FirebaseBackend.rewrapVaultPassphrase(rec, newP1, true);
        App.showToast("Frase de bóveda actualizada.");
      }
      document.getElementById("vault-recovery-input").value = "";
      document.getElementById("vault-recovery-newpass").value = "";
      document.getElementById("vault-recovery-newpass2").value = "";
      this.enterApp(this.currentUser);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "No se pudo recuperar la bóveda.";
        errBox.hidden = false;
      }
    } finally {
      this.setLoading("vault-recovery-unlock-submit", false, "Recuperar acceso");
    }
  },

  /* ------------------------- Flujos Locales ------------------------- */
  async login() {
    const username = document.getElementById("auth-login-user").value.trim();
    const password = document.getElementById("auth-login-pass").value;
    const errorBox = document.getElementById("auth-login-error");
    const infoBox = document.getElementById("auth-login-info");
    if (errorBox) errorBox.hidden = true;
    if (infoBox) infoBox.hidden = true;
    this.setLoading("auth-login-submit", true);

    try {
      const data = await API.login(username, password);
      document.getElementById("auth-login-pass").value = "";
      if (data.user && data.user.must_change_password) {
        this.currentUser = data.user;
        this.show("change");
      } else {
        this.enterApp(data.user);
      }
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message || "No se pudo iniciar sesión.";
        errorBox.hidden = false;
      }
    } finally {
      this.setLoading("auth-login-submit", false, "Entrar");
    }
  },

  async setup() {
    const name = document.getElementById("auth-setup-name").value.trim();
    const username = document.getElementById("auth-setup-user").value.trim();
    const pass = document.getElementById("auth-setup-pass").value;
    const pass2 = document.getElementById("auth-setup-pass2").value;
    const errorBox = document.getElementById("auth-setup-error");
    if (errorBox) errorBox.hidden = true;

    if (pass !== pass2) {
      if (errorBox) {
        errorBox.textContent = "Las contraseñas no coinciden.";
        errorBox.hidden = false;
      }
      return;
    }

    this.setLoading("auth-setup-submit", true);
    try {
      const data = await API.setupAccount(username, name, pass);
      this.enterApp(data.user);
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message || "No se pudo crear la cuenta.";
        errorBox.hidden = false;
      }
    } finally {
      this.setLoading("auth-setup-submit", false, "Crear cuenta");
    }
  },

  async changePasswordFromGate() {
    const current = document.getElementById("auth-change-current").value;
    const next = document.getElementById("auth-change-new").value;
    const next2 = document.getElementById("auth-change-new2").value;
    const errorBox = document.getElementById("auth-change-error");
    if (errorBox) errorBox.hidden = true;

    if (next !== next2) {
      if (errorBox) {
        errorBox.textContent = "Las contraseñas nuevas no coinciden.";
        errorBox.hidden = false;
      }
      return;
    }

    this.setLoading("auth-change-submit", true);
    try {
      await API.changePassword(current, next);
      const me = await API.getMe();
      this.enterApp(me.user);
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message || "No se pudo cambiar la contraseña.";
        errorBox.hidden = false;
      }
    } finally {
      this.setLoading("auth-change-submit", false, "Guardar y entrar");
    }
  },

  async logout() {
    try {
      await API.logout();
      if (API.isCloud()) {
        this.closeAccount();
        this.currentUser = null;
        this.show("cloud-login");
      } else {
        window.location.reload();
      }
    } catch (err) {
      if (typeof App !== "undefined" && App.showToast) {
        App.showToast("No se pudo cerrar sesión. Intenta de nuevo.");
      }
    }
  },

  onUnauthorized() {
    if (API.isCloud()) {
      if (FirebaseBackend.user) {
        this._renderVaultAccountLabel("vault-unlock-account-label", this.currentUser);
        this.show("vault-unlock");
      } else {
        this.show("cloud-login");
      }
      return;
    }
    if (this.mode === "login" && !document.getElementById("auth-gate")?.hidden) return;
    window.location.reload();
  },

  /* ------------------------- Cuenta, Bóveda y Usuarios ------------------------- */
  openAccount() {
    const modal = document.getElementById("account-modal");
    if (!modal) return;
    this.renderAccount();
    if (!API.isCloud()) {
      this.renderUsers();
    }
    modal.classList.add("active");
  },

  closeAccount() {
    document.getElementById("account-modal")?.classList.remove("active");
    ["account-change-wrap", "account-vault-change-wrap", "account-vault-recovery-wrap"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    ["account-change-form", "account-vault-change-form", "account-vault-recovery-form"].forEach((id) => {
      document.getElementById(id)?.reset();
    });
    const recOut = document.getElementById("account-vault-rec-out");
    if (recOut) recOut.hidden = true;
  },

  renderAccount() {
    const user = this.currentUser;
    const box = document.getElementById("account-summary");
    if (!box || !user) return;
    const isCloud = API.isCloud();
    const subtitle = isCloud
      ? `${user.email || user.username} · Bóveda AES-256-GCM`
      : `@${user.username} · ${user.role === "admin" ? "Administrador" : "Usuario"}`;
    box.innerHTML = `
      <div class="account-identity">
        <div class="account-avatar">${this.escape((user.display_name || user.username).charAt(0).toUpperCase())}</div>
        <div>
          <strong>${this.escape(user.display_name || user.username)}</strong>
          <div class="account-handle">${this.escape(subtitle)}</div>
        </div>
      </div>
    `;

    const localPwdBtn = document.getElementById("account-change-btn");
    if (localPwdBtn) localPwdBtn.hidden = isCloud;

    const adminSection = document.getElementById("users-admin-section");
    if (adminSection) adminSection.hidden = isCloud || user.role !== "admin";

    const cloudSection = document.getElementById("account-cloud-section");
    if (cloudSection) cloudSection.hidden = !isCloud;
  },

  async changeCloudVaultPassphrase() {
    const cur = document.getElementById("vault-chg-cur").value;
    const next = document.getElementById("vault-chg-new").value;
    const next2 = document.getElementById("vault-chg-new2").value;
    const errBox = document.getElementById("vault-chg-error");
    if (errBox) errBox.hidden = true;
    if (next !== next2) {
      if (errBox) {
        errBox.textContent = "Las frases nuevas no coinciden.";
        errBox.hidden = false;
      }
      return;
    }
    try {
      await FirebaseBackend.rewrapVaultPassphrase(cur, next, false);
      document.getElementById("account-vault-change-form")?.reset();
      document.getElementById("account-vault-change-wrap").hidden = true;
      App.showToast("Frase de bóveda actualizada sin re-subir tu historial.");
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "No se pudo cambiar la frase.";
        errBox.hidden = false;
      }
    }
  },

  async revealCloudRecoveryKey() {
    const pass = document.getElementById("vault-rec-pass").value;
    const errBox = document.getElementById("vault-rec-error");
    const outBox = document.getElementById("account-vault-rec-out");
    if (errBox) errBox.hidden = true;
    if (outBox) outBox.hidden = true;
    try {
      const rec = await FirebaseBackend.exportRecoveryKey(pass);
      document.getElementById("vault-rec-pass").value = "";
      if (outBox) {
        outBox.innerHTML = `<code>${this.escape(rec)}</code>`;
        outBox.hidden = false;
      }
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "Frase incorrecta.";
        errBox.hidden = false;
      }
    }
  },

  async exportCloudBackup() {
    try {
      const backup = await FirebaseBackend.exportBackupJson();
      const stamp = new Date().toISOString().slice(0, 10);
      this._downloadTextFile(
        `diario-rpg-respaldo-${stamp}.json`,
        JSON.stringify(backup, null, 2),
        "application/json"
      );
      App.showToast("Respaldo JSON exportado.");
    } catch (err) {
      App.showToast(err.message || "No se pudo exportar el respaldo.");
    }
  },

  async importCloudBackup(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await FirebaseBackend.importBackupJson(parsed);
      App.showToast(`Respaldo importado (${res.imported_days} días cifrados).`);
      await App.loadUserProfile(false);
      await DayEditorComponent.loadEntry();
      await QuickNotesComponent.loadNotes();
    } catch (err) {
      App.showToast(err.message || "No se pudo importar el respaldo.");
    }
  },

  _downloadTextFile(filename, text, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  async changePasswordFromAccount() {
    const current = document.getElementById("account-current-pass").value;
    const next = document.getElementById("account-new-pass").value;
    const next2 = document.getElementById("account-new-pass2").value;
    const errorBox = document.getElementById("account-change-error");
    if (errorBox) errorBox.hidden = true;

    if (next !== next2) {
      if (errorBox) {
        errorBox.textContent = "Las contraseñas nuevas no coinciden.";
        errorBox.hidden = false;
      }
      return;
    }

    try {
      await API.changePassword(current, next);
      document.getElementById("account-change-form").reset();
      App.showToast("Contraseña actualizada. Las otras sesiones se cerraron.");
      const me = await API.getMe();
      this.currentUser = me.user;
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message || "No se pudo cambiar la contraseña.";
        errorBox.hidden = false;
      }
    }
  },

  async renderUsers() {
    const list = document.getElementById("users-list");
    if (!list || !this.currentUser || this.currentUser.role !== "admin") return;
    list.innerHTML = `<div class="account-muted">Cargando usuarios…</div>`;
    try {
      const data = await API.listUsers();
      list.innerHTML = (data.users || [])
        .map((u) => {
          const active = u.is_active;
          const role = u.role === "admin" ? "Admin" : "Usuario";
          const isSelf = u.id === this.currentUser.id;
          return `
            <div class="user-row ${active ? "" : "is-inactive"}">
              <div class="user-row-main">
                <strong>${this.escape(u.display_name)}</strong>
                <span class="account-handle">@${this.escape(u.username)} · ${role}${isSelf ? " · tú" : ""}</span>
              </div>
              <div class="user-row-actions">
                <select class="user-role-select" data-role-user="${u.id}" title="Rol de la cuenta" ${isSelf ? "disabled" : ""}>
                  <option value="user" ${u.role === "user" ? "selected" : ""}>Usuario</option>
                  <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
                </select>
                <button type="button" class="user-mini-btn" data-reset-user="${u.id}" title="Generar contraseña temporal" ${isSelf ? "disabled" : ""}>Restablecer</button>
                <button type="button" class="user-mini-btn ${active ? "is-danger" : ""}" data-toggle-user="${u.id}" data-active="${active ? "1" : "0"}" ${isSelf ? "disabled" : ""}>
                  ${active ? "Desactivar" : "Activar"}
                </button>
              </div>
            </div>
          `;
        })
        .join("");

      list.querySelectorAll("[data-role-user]").forEach((select) => {
        select.addEventListener("change", () =>
          this.changeUserRole(Number(select.dataset.roleUser), select.value)
        );
      });
      list.querySelectorAll("[data-reset-user]").forEach((btn) => {
        btn.addEventListener("click", () => this.resetUserPassword(Number(btn.dataset.resetUser)));
      });
      list.querySelectorAll("[data-toggle-user]").forEach((btn) => {
        btn.addEventListener("click", () =>
          this.toggleUserActive(Number(btn.dataset.toggleUser), btn.dataset.active !== "1")
        );
      });
    } catch (err) {
      list.innerHTML = `<div class="account-error">No se pudieron cargar los usuarios.</div>`;
    }
  },

  async createUser() {
    const name = document.getElementById("user-create-name").value.trim();
    const username = document.getElementById("user-create-username").value.trim();
    const password = document.getElementById("user-create-pass").value;
    const role = document.getElementById("user-create-role").value;
    const box = document.getElementById("user-create-result");
    if (box) box.hidden = true;

    try {
      const data = await API.createUser(username, name, password, role);
      document.getElementById("user-create-form").reset();
      if (box) {
        box.className = "account-result is-ok";
        box.textContent = `Cuenta creada: @${data.user.username}. Pídele que cambie la contraseña al entrar.`;
        box.hidden = false;
      }
      this.renderUsers();
    } catch (err) {
      if (box) {
        box.className = "account-result is-error";
        box.textContent = err.message || "No se pudo crear la cuenta.";
        box.hidden = false;
      }
    }
  },

  async changeUserRole(userId, role) {
    try {
      await API.updateUser(userId, { role });
      App.showToast(role === "admin" ? "Rol de administrador asignado." : "Rol de usuario asignado.");
      this.renderUsers();
    } catch (err) {
      App.showToast(err.message || "No se pudo cambiar el rol.");
      this.renderUsers();
    }
  },

  async resetUserPassword(userId) {
    if (!window.confirm("¿Generar una contraseña temporal para este usuario? Se cerrarán sus sesiones.")) {
      return;
    }
    try {
      const data = await API.resetUserPassword(userId);
      const box = document.getElementById("user-temp-password");
      if (box) {
        box.hidden = false;
        box.innerHTML = `
          <strong>Contraseña temporal</strong>
          <code id="user-temp-value">${this.escape(data.temp_password)}</code>
          <button type="button" class="user-mini-btn" id="user-temp-copy">Copiar</button>
          <p class="account-muted">Compártela por un canal privado. El usuario deberá cambiarla al entrar.</p>
        `;
        document.getElementById("user-temp-copy")?.addEventListener("click", () => {
          navigator.clipboard?.writeText(data.temp_password);
          App.showToast("Contraseña temporal copiada.");
        });
      }
    } catch (err) {
      App.showToast(err.message || "No se pudo restablecer la contraseña.");
    }
  },

  async toggleUserActive(userId, active) {
    try {
      await API.updateUser(userId, { is_active: active });
      App.showToast(active ? "Usuario activado." : "Usuario desactivado.");
      this.renderUsers();
    } catch (err) {
      App.showToast(err.message || "No se pudo actualizar el usuario.");
    }
  },

  escape(str) {
    return API.escapeHtml(str);
  }
};
