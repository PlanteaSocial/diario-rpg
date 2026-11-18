/**
 * Componente: Santuario & Tienda RPG del Compañero Slime
 * Estética Cozy RPG de pergamino cálido con pixel art animado.
 */

const SanctuaryComponent = {
  companion: null,
  shopItems: [],
  activeTab: "mascota", // "mascota" | "tienda"
  isBound: false,

  init() {
    if (this.isBound) return;
    this.isBound = true;
    this.bindEvents();
  },

  bindEvents() {
    const modal = document.getElementById("sanctuary-modal");
    const closeBtn = document.getElementById("sanctuary-close-btn");

    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.remove("active"));
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("active");
      });
    }

    document.querySelectorAll(".sanc-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.sanctab || "mascota";
        this.renderModalTabs();
      });
    });

    const renameBtn = document.getElementById("sanc-rename-btn");
    if (renameBtn) {
      renameBtn.addEventListener("click", async () => {
        const curName = this.companion ? this.companion.name : "Slime";
        const newName = prompt("Nuevo nombre para tu compañero:", curName);
        if (newName && newName.trim()) {
          await this.doAction("rename", newName.trim());
        }
      });
    }
  },

  async open(tab = "mascota") {
    this.init();
    this.activeTab = tab;
    this.renderModalTabs();

    try {
      const res = await API.getCompanion();
      this.companion = res.companion;
      this.shopItems = res.shop_items || [];
      this.render();
    } catch (err) {
      console.error("Error cargando santuario:", err);
    }

    const modal = document.getElementById("sanctuary-modal");
    if (modal) modal.classList.add("active");
  },

  renderModalTabs() {
    document.querySelectorAll(".sanc-tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.sanctab === this.activeTab);
    });
    const petPane = document.getElementById("sanc-pane-mascota");
    const shopPane = document.getElementById("sanc-pane-tienda");
    if (petPane) petPane.style.display = this.activeTab === "mascota" ? "block" : "none";
    if (shopPane) shopPane.style.display = this.activeTab === "tienda" ? "block" : "none";
  },

  async doAction(action, value = null) {
    try {
      const res = await API.companionAction(action, value);
      this.companion = res.companion;
      this.render();
      if (App && App.updateAdventurerBanner) {
        App.updateAdventurerBanner(this.companion, res.adventurer_title);
      }
      if (res.message) App.showToast(res.message);
    } catch (err) {
      console.error("Error en acción de santuario:", err);
    }
  },

  render() {
    const c = this.companion;
    if (!c) return;

    // Monedas y título del santuario
    const coinsEl = document.getElementById("sanc-coins-badge");
    const miniIco = document.getElementById("sanc-header-icon");
    if (coinsEl) coinsEl.innerHTML = `${PixelSprites.coin(14)} <span>${c.coins}</span>`;
    if (miniIco) miniIco.innerHTML = PixelSprites.slime(c.variant, 24);

    // Escenario mascota
    const nameEl = document.getElementById("sanc-pet-name");
    const lvlEl = document.getElementById("sanc-pet-level");
    const stageSprite = document.getElementById("sanc-slime-stage");
    const subLabelEl = document.getElementById("sanc-pet-variant-label");
    const bondTextEl = document.getElementById("sanc-bond-text");
    const bondFillEl = document.getElementById("sanc-bond-fill");

    const variantNames = {
      slime_azul: "Slime Sereno",
      slime_menta: "Slime Menta",
      slime_lavanda: "Slime Lavanda"
    };

    if (nameEl) nameEl.textContent = c.name || "Slime";
    if (lvlEl) lvlEl.textContent = `Nv. ${c.level} · Compañero`;
    if (stageSprite) stageSprite.innerHTML = PixelSprites.slime(c.variant, 82);
    if (subLabelEl) subLabelEl.textContent = variantNames[c.variant] || "Slime Compañero";
    if (bondTextEl) bondTextEl.textContent = `${c.bond} / 100 Vínculo`;
    if (bondFillEl) bondFillEl.style.width = `${c.bond}%`;

    // Barras de estado
    const setStat = (idBar, idPct, val) => {
      const b = document.getElementById(idBar);
      const p = document.getElementById(idPct);
      if (b) b.style.width = `${val}%`;
      if (p) p.textContent = `${val}%`;
    };
    setStat("sanc-bar-satiety", "sanc-pct-satiety", c.satiety);
    setStat("sanc-bar-energy", "sanc-pct-energy", c.energy);
    setStat("sanc-bar-mood", "sanc-pct-mood", c.mood);

    // Despensa
    const pantryBox = document.getElementById("sanc-pantry-list");
    if (pantryBox) {
      const entries = Object.entries(c.pantry || {}).filter(([, qty]) => qty > 0);
      if (entries.length === 0) {
        pantryBox.innerHTML = `<span style="color: var(--text-tertiary); font-size: 0.85rem;">Despensa vacía — consigue bocadillos en la pestaña Tienda con tus monedas de constancia.</span>`;
      } else {
        pantryBox.innerHTML = entries
          .map(([id, qty]) => {
            const item = this.shopItems.find((i) => i.id === id) || { name: id, icon: "🍪" };
            const safeId = API.escapeHtml(id);
            return `
              <button type="button" class="pantry-item-pill" onclick="SanctuaryComponent.doAction('feed', '${safeId}')">
                <span>${API.escapeHtml(item.icon)}</span>
                <span>${API.escapeHtml(item.name)}</span>
                <strong>×${Number(qty) || 0}</strong>
              </button>
            `;
          })
          .join("");
      }
    }

    // Tienda
    const shopBox = document.getElementById("sanc-shop-list");
    if (shopBox) {
      shopBox.innerHTML = (this.shopItems || [])
        .map((item) => {
          const isVariant = item.type === "variant";
          const unlocked = isVariant && (c.unlocked_variants || []).includes(item.id);
          const equipped = isVariant && c.variant === item.id;

          const safeItemId = API.escapeHtml(item.id);
          let actionBtn = "";
          if (equipped) {
            actionBtn = `<span class="badge-pill" style="color: var(--accent-green);">✓ Activo</span>`;
          } else if (unlocked) {
            actionBtn = `<button type="button" class="btn-secondary" style="padding: 0.35rem 0.8rem; font-size: 0.8rem;" onclick="SanctuaryComponent.doAction('equip_variant', '${safeItemId}')">Equipar</button>`;
          } else {
            actionBtn = `
              <button type="button" class="btn-primary" style="padding: 0.38rem 0.85rem; font-size: 0.8rem;"
                onclick="SanctuaryComponent.doAction('buy', '${safeItemId}')">
                ${PixelSprites.coin(12)} ${Number(item.price) || 0}
              </button>
            `;
          }

          return `
            <div class="shop-item-row">
              <div style="display: flex; align-items: center; gap: 0.75rem;">
                <div class="shop-item-icon">${API.escapeHtml(item.icon)}</div>
                <div>
                  <div style="font-weight: 700; font-size: 0.92rem;">${API.escapeHtml(item.name)}</div>
                  <div style="font-size: 0.78rem; color: var(--text-secondary);">${API.escapeHtml(item.desc)}</div>
                </div>
              </div>
              ${actionBtn}
            </div>
          `;
        })
        .join("");

      // Agregar opción Slime Azul original para re-equipar
      if (c.variant !== "slime_azul") {
        shopBox.innerHTML += `
          <div class="shop-item-row">
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <div class="shop-item-icon">💧</div>
              <div>
                <div style="font-weight: 700; font-size: 0.92rem;">Slime Clásico Azul</div>
                <div style="font-size: 0.78rem; color: var(--text-secondary);">Apariencia serena original</div>
              </div>
            </div>
            <button type="button" class="btn-secondary" style="padding: 0.35rem 0.8rem; font-size: 0.8rem;" onclick="SanctuaryComponent.doAction('equip_variant', 'slime_azul')">Equipar</button>
          </div>
        `;
      }
    }
  }
};
