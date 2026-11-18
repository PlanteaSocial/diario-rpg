/**
 * Bóveda Criptográfica Zero-Knowledge en el Navegador (WebCrypto API).
 *
 * - Cifrado simétrico AES-256-GCM con IV aleatorio de 96 bits por operación.
 * - AAD (Additional Authenticated Data) ligado a uid + recurso para evitar reubicación de blobs.
 * - Derivación de llave maestra (KEK) con PBKDF2-SHA256 (210,000 iteraciones) y sal de 128 bits.
 * - Envoltura de DEK (Data Encryption Key) de 256 bits: cambiar la frase de bóveda no
 *   obliga a re-cifrar todo el historial y permite generar una llave de recuperación sin conexión.
 */

const VaultCrypto = {
  KDF_ITERATIONS: 210000,
  VERSION: 1,

  _enc: new TextEncoder(),
  _dec: new TextDecoder(),

  _checkWebCrypto() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Tu navegador no soporta WebCrypto API (HTTPS requerido).");
    }
  },

  toBase64(bytes) {
    let bin = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) {
      bin += String.fromCharCode(arr[i]);
    }
    return btoa(bin);
  },

  fromBase64(b64) {
    const bin = atob(String(b64 || "").trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  },

  async _deriveKek(passphrase, saltBytes, iterations = this.KDF_ITERATIONS) {
    this._checkWebCrypto();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      this._enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async _importDek(dekBytes) {
    this._checkWebCrypto();
    if (!(dekBytes instanceof Uint8Array) || dekBytes.length !== 32) {
      throw new Error("Llave de bóveda inválida.");
    }
    return crypto.subtle.importKey(
      "raw",
      dekBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async _aesEncryptBytes(key, plainBytes, aad = "") {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const params = { name: "AES-GCM", iv };
    if (aad) params.additionalData = this._enc.encode(aad);
    const ctBuf = await crypto.subtle.encrypt(params, key, plainBytes);
    return {
      iv: this.toBase64(iv),
      ct: this.toBase64(new Uint8Array(ctBuf))
    };
  },

  async _aesDecryptBytes(key, ivB64, ctB64, aad = "") {
    const iv = this.fromBase64(ivB64);
    const ct = this.fromBase64(ctB64);
    const params = { name: "AES-GCM", iv };
    if (aad) params.additionalData = this._enc.encode(aad);
    const plainBuf = await crypto.subtle.decrypt(params, key, ct);
    return new Uint8Array(plainBuf);
  },

  async formatRecoveryKey(dekBytes) {
    const hashBuf = await crypto.subtle.digest("SHA-256", dekBytes);
    const checksum = new Uint8Array(hashBuf).slice(0, 2);
    const full = new Uint8Array(dekBytes.length + 2);
    full.set(dekBytes, 0);
    full.set(checksum, dekBytes.length);
    const hex = Array.from(full, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    // Agrupar en bloques de 4 caracteres con prefijo DRPG1
    const groups = hex.match(/.{1,4}/g) || [];
    return `DRPG1-${groups.join("-")}`;
  },

  async parseRecoveryKey(recoveryStr) {
    const cleaned = String(recoveryStr || "")
      .trim()
      .toUpperCase()
      .replace(/^DRPG1-?/, "")
      .replace(/[^0-9A-F]/g, "");
    if (cleaned.length !== 68) {
      throw new Error("La llave de recuperación no tiene el formato correcto.");
    }
    const bytes = new Uint8Array(34);
    for (let i = 0; i < 34; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    const dekBytes = bytes.slice(0, 32);
    const expectedCheck = bytes.slice(32, 34);
    const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", dekBytes));
    if (actualHash[0] !== expectedCheck[0] || actualHash[1] !== expectedCheck[1]) {
      throw new Error("La llave de recuperación tiene un error de escritura (checksum inválido).");
    }
    return dekBytes;
  },

  async createVault(uid, passphrase) {
    if (!uid) throw new Error("UID requerido para crear la bóveda.");
    if (typeof passphrase !== "string" || passphrase.length < 8) {
      throw new Error("La frase de bóveda debe tener al menos 8 caracteres.");
    }
    this._checkWebCrypto();
    const dekBytes = crypto.getRandomValues(new Uint8Array(32));
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const kek = await this._deriveKek(passphrase, saltBytes, this.KDF_ITERATIONS);

    const dekPayload = this._enc.encode(
      JSON.stringify({ v: this.VERSION, uid, dek: this.toBase64(dekBytes) })
    );
    const wrappedDek = await this._aesEncryptBytes(kek, dekPayload, `${uid}:vault-wrap`);
    const dekKey = await this._importDek(dekBytes);
    const recoveryKey = await this.formatRecoveryKey(dekBytes);
    dekBytes.fill(0);

    return {
      dekKey,
      recoveryKey,
      vaultMeta: {
        v: this.VERSION,
        kdf: "PBKDF2-SHA256",
        iter: this.KDF_ITERATIONS,
        saltB64: this.toBase64(saltBytes),
        wrappedDek
      }
    };
  },

  async _unwrapDekBytes(uid, vaultMeta, passphrase) {
    if (!vaultMeta || !vaultMeta.saltB64 || !vaultMeta.wrappedDek) {
      throw new Error("Metadatos de bóveda incompletos.");
    }
    const saltBytes = this.fromBase64(vaultMeta.saltB64);
    const iter = Number(vaultMeta.iter) || this.KDF_ITERATIONS;
    const kek = await this._deriveKek(passphrase, saltBytes, iter);
    let plainBytes;
    try {
      plainBytes = await this._aesDecryptBytes(
        kek,
        vaultMeta.wrappedDek.iv,
        vaultMeta.wrappedDek.ct,
        `${uid}:vault-wrap`
      );
    } catch {
      throw new Error("Frase de bóveda incorrecta.");
    }
    const parsed = JSON.parse(this._dec.decode(plainBytes));
    if (parsed.uid !== uid || !parsed.dek) {
      throw new Error("La bóveda no corresponde a esta cuenta.");
    }
    return this.fromBase64(parsed.dek);
  },

  async unlockWithPassphrase(uid, vaultMeta, passphrase) {
    const dekBytes = await this._unwrapDekBytes(uid, vaultMeta, passphrase);
    try {
      return await this._importDek(dekBytes);
    } finally {
      dekBytes.fill(0);
    }
  },

  async unlockWithRecoveryKey(recoveryStr) {
    const dekBytes = await this.parseRecoveryKey(recoveryStr);
    try {
      return await this._importDek(dekBytes);
    } finally {
      dekBytes.fill(0);
    }
  },

  async rewrapPassphrase(uid, vaultMeta, currentPassphrase, newPassphrase, usingRecovery = false) {
    if (typeof newPassphrase !== "string" || newPassphrase.length < 8) {
      throw new Error("La nueva frase de bóveda debe tener al menos 8 caracteres.");
    }
    const dekBytes = usingRecovery
      ? await this.parseRecoveryKey(currentPassphrase)
      : await this._unwrapDekBytes(uid, vaultMeta, currentPassphrase);
    try {
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const newKek = await this._deriveKek(newPassphrase, saltBytes, this.KDF_ITERATIONS);
      const dekPayload = this._enc.encode(
        JSON.stringify({ v: this.VERSION, uid, dek: this.toBase64(dekBytes) })
      );
      const wrappedDek = await this._aesEncryptBytes(newKek, dekPayload, `${uid}:vault-wrap`);
      const dekKey = await this._importDek(dekBytes);
      return {
        dekKey,
        vaultMeta: {
          v: this.VERSION,
          kdf: "PBKDF2-SHA256",
          iter: this.KDF_ITERATIONS,
          saltB64: this.toBase64(saltBytes),
          wrappedDek
        }
      };
    } finally {
      dekBytes.fill(0);
    }
  },

  async exportRecoveryWithPassphrase(uid, vaultMeta, passphrase) {
    const dekBytes = await this._unwrapDekBytes(uid, vaultMeta, passphrase);
    try {
      return await this.formatRecoveryKey(dekBytes);
    } finally {
      dekBytes.fill(0);
    }
  },

  async encryptJson(dekKey, payloadObj, aad = "") {
    const plain = this._enc.encode(JSON.stringify(payloadObj));
    const { iv, ct } = await this._aesEncryptBytes(dekKey, plain, aad);
    return {
      v: this.VERSION,
      alg: "AES-256-GCM",
      iv,
      ct
    };
  },

  async decryptJson(dekKey, envelope, aad = "") {
    if (!envelope || !envelope.iv || !envelope.ct) {
      throw new Error("Sobre cifrado inválido.");
    }
    const plainBytes = await this._aesDecryptBytes(dekKey, envelope.iv, envelope.ct, aad);
    return JSON.parse(this._dec.decode(plainBytes));
  }
};
