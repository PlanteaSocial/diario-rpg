/**
 * Librería de Sprites e Íconos Pixel Art 100% Offline (SVG CrispEdges)
 * Inspirada en la estética Cozy RPG de pergamino cálido y compañeros Slime.
 */

const PixelSprites = {
  slime(variant = "slime_azul", size = 84) {
    const palettes = {
      slime_azul: {
        outline: "#1e1b18",
        light: "#bae6fd",
        main: "#38bdf8",
        shade: "#0284c7",
        cheek: "#fb7185"
      },
      slime_menta: {
        outline: "#1e1b18",
        light: "#bbf7d0",
        main: "#34d399",
        shade: "#059669",
        cheek: "#fda4af"
      },
      slime_lavanda: {
        outline: "#1e1b18",
        light: "#e9d5ff",
        main: "#c084fc",
        shade: "#7e22ce",
        cheek: "#f472b6"
      }
    };
    const p = palettes[variant] || palettes.slime_azul;

    return `
      <svg width="${size}" height="${size}" viewBox="0 0 18 18" shape-rendering="crispEdges" class="pixel-sprite slime-bob">
        <!-- Brote verde en la cabeza -->
        <rect x="6" y="1" width="2" height="1" fill="#4ade80"/>
        <rect x="10" y="1" width="2" height="1" fill="#4ade80"/>
        <rect x="7" y="2" width="4" height="1" fill="#22c55e"/>
        <rect x="8" y="3" width="2" height="1" fill="#15803d"/>

        <!-- Contorno del Slime -->
        <rect x="6" y="4" width="6" height="1" fill="${p.outline}"/>
        <rect x="4" y="5" width="2" height="1" fill="${p.outline}"/>
        <rect x="12" y="5" width="2" height="1" fill="${p.outline}"/>
        <rect x="3" y="6" width="1" height="2" fill="${p.outline}"/>
        <rect x="14" y="6" width="1" height="2" fill="${p.outline}"/>
        <rect x="2" y="8" width="1" height="5" fill="${p.outline}"/>
        <rect x="15" y="8" width="1" height="5" fill="${p.outline}"/>
        <rect x="3" y="13" width="1" height="1" fill="${p.outline}"/>
        <rect x="14" y="13" width="1" height="1" fill="${p.outline}"/>
        <rect x="4" y="14" width="10" height="1" fill="${p.outline}"/>

        <!-- Cuerpo base -->
        <rect x="6" y="5" width="6" height="1" fill="${p.main}"/>
        <rect x="4" y="6" width="10" height="2" fill="${p.main}"/>
        <rect x="3" y="8" width="12" height="5" fill="${p.main}"/>
        <rect x="4" y="13" width="10" height="1" fill="${p.shade}"/>

        <!-- Brillo superior -->
        <rect x="5" y="6" width="3" height="1" fill="${p.light}"/>
        <rect x="4" y="7" width="2" height="1" fill="${p.light}"/>
        <rect x="4" y="8" width="1" height="1" fill="#ffffff"/>

        <!-- Sombra inferior -->
        <rect x="4" y="12" width="10" height="1" fill="${p.shade}"/>
        <rect x="5" y="13" width="8" height="1" fill="${p.shade}"/>

        <!-- Ojos, mejillas y sonrisa -->
        <rect x="5" y="9" width="1" height="2" fill="${p.outline}"/>
        <rect x="12" y="9" width="1" height="2" fill="${p.outline}"/>
        <rect x="4" y="11" width="1" height="1" fill="${p.cheek}"/>
        <rect x="13" y="11" width="1" height="1" fill="${p.cheek}"/>
        <rect x="8" y="11" width="2" height="1" fill="${p.outline}"/>
      </svg>
    `;
  },

  heroScholar(size = 48) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 18 18" shape-rendering="crispEdges" class="pixel-sprite">
        <!-- Fondo cielo sereno del retrato -->
        <rect x="1" y="1" width="16" height="16" fill="#dbeafe"/>
        <rect x="1" y="12" width="16" height="5" fill="#92400e"/>
        <rect x="1" y="11" width="16" height="1" fill="#78350f"/>

        <!-- Cuerpo polluelo cronista -->
        <rect x="6" y="4" width="5" height="1" fill="#1e1b18"/>
        <rect x="5" y="5" width="7" height="5" fill="#facc15"/>
        <rect x="7" y="6" width="1" height="1" fill="#1e1b18"/>
        <rect x="10" y="6" width="1" height="1" fill="#1e1b18"/>
        <rect x="11" y="7" width="2" height="1" fill="#f97316"/>
        <!-- Bufanda roja -->
        <rect x="5" y="9" width="7" height="2" fill="#dc2626"/>
        <rect x="4" y="10" width="2" height="2" fill="#b91c1c"/>

        <!-- Pergamino y pluma en escritorio -->
        <rect x="9" y="12" width="6" height="3" fill="#fef3c7"/>
        <rect x="10" y="13" width="4" height="1" fill="#d97706"/>
        <rect x="13" y="9" width="1" height="3" fill="#ffffff"/>
        <rect x="14" y="8" width="1" height="2" fill="#e2e8f0"/>
      </svg>
    `;
  },

  hourglass(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="3" y="1" width="10" height="2" fill="#92400e"/>
        <rect x="4" y="3" width="8" height="1" fill="#1e1b18"/>
        <rect x="4" y="4" width="1" height="3" fill="#1e1b18"/>
        <rect x="11" y="4" width="1" height="3" fill="#1e1b18"/>
        <rect x="5" y="4" width="6" height="2" fill="#fef3c7"/>
        <rect x="6" y="6" width="4" height="1" fill="#f59e0b"/>
        <rect x="6" y="7" width="4" height="2" fill="#1e1b18"/>
        <rect x="7" y="7" width="2" height="2" fill="#fbbf24"/>
        <rect x="4" y="9" width="1" height="3" fill="#1e1b18"/>
        <rect x="11" y="9" width="1" height="3" fill="#1e1b18"/>
        <rect x="5" y="9" width="6" height="3" fill="#fef3c7"/>
        <rect x="6" y="11" width="4" height="1" fill="#f59e0b"/>
        <rect x="3" y="13" width="10" height="2" fill="#92400e"/>
      </svg>
    `;
  },

  notebook(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="3" y="1" width="10" height="14" fill="#1e1b18"/>
        <rect x="4" y="2" width="8" height="12" fill="#1d4ed8"/>
        <rect x="4" y="2" width="2" height="12" fill="#1e40af"/>
        <rect x="6" y="4" width="5" height="3" fill="#fef3c7"/>
        <rect x="7" y="5" width="3" height="1" fill="#94a3b8"/>
        <rect x="8" y="11" width="2" height="4" fill="#ef4444"/>
      </svg>
    `;
  },

  book(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="2" y="2" width="12" height="12" fill="#1e1b18"/>
        <rect x="3" y="3" width="5" height="10" fill="#fef3c7"/>
        <rect x="8" y="3" width="5" height="10" fill="#fde68a"/>
        <rect x="7" y="3" width="2" height="10" fill="#a84b08"/>
        <rect x="4" y="5" width="3" height="1" fill="#94a3b8"/>
        <rect x="4" y="7" width="3" height="1" fill="#94a3b8"/>
        <rect x="9" y="5" width="3" height="1" fill="#a16207"/>
        <rect x="9" y="7" width="3" height="1" fill="#a16207"/>
        <rect x="5" y="13" width="6" height="1" fill="#c25e12"/>
      </svg>
    `;
  },

  chart(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="2" y="13" width="12" height="1" fill="#1e1b18"/>
        <rect x="3" y="8" width="2" height="5" fill="#0284c7"/>
        <rect x="7" y="5" width="2" height="8" fill="#22c55e"/>
        <rect x="11" y="3" width="2" height="10" fill="#f59e0b"/>
      </svg>
    `;
  },

  checkmark(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="2" y="8" width="2" height="2" fill="#15803d"/>
        <rect x="4" y="10" width="2" height="2" fill="#22c55e"/>
        <rect x="6" y="11" width="2" height="2" fill="#15803d"/>
        <rect x="7" y="9" width="2" height="2" fill="#22c55e"/>
        <rect x="9" y="7" width="2" height="2" fill="#4ade80"/>
        <rect x="11" y="5" width="2" height="2" fill="#22c55e"/>
        <rect x="13" y="3" width="2" height="2" fill="#4ade80"/>
      </svg>
    `;
  },

  compass(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="5" y="2" width="6" height="12" fill="#d97706"/>
        <rect x="2" y="5" width="12" height="6" fill="#d97706"/>
        <rect x="4" y="4" width="8" height="8" fill="#fef3c7"/>
        <rect x="8" y="5" width="2" height="2" fill="#ef4444"/>
        <rect x="7" y="7" width="2" height="2" fill="#1e1b18"/>
        <rect x="6" y="9" width="2" height="2" fill="#0284c7"/>
      </svg>
    `;
  },

  gear(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="6" y="2" width="4" height="12" fill="#64748b"/>
        <rect x="2" y="6" width="12" height="4" fill="#64748b"/>
        <rect x="4" y="4" width="8" height="8" fill="#94a3b8"/>
        <rect x="6" y="6" width="4" height="4" fill="#1e293b"/>
      </svg>
    `;
  },

  moon(size = 20) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="6" y="2" width="5" height="2" fill="#fbbf24"/>
        <rect x="4" y="4" width="4" height="2" fill="#fbbf24"/>
        <rect x="3" y="6" width="3" height="4" fill="#f59e0b"/>
        <rect x="4" y="10" width="4" height="2" fill="#f59e0b"/>
        <rect x="6" y="12" width="5" height="2" fill="#d97706"/>
        <rect x="11" y="5" width="1" height="1" fill="#fef08a"/>
        <rect x="13" y="8" width="1" height="1" fill="#fef08a"/>
      </svg>
    `;
  },

  coin(size = 16) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="3" y="1" width="6" height="10" fill="#d97706"/>
        <rect x="1" y="3" width="10" height="6" fill="#f59e0b"/>
        <rect x="3" y="2" width="6" height="8" fill="#fbbf24"/>
        <rect x="5" y="4" width="2" height="4" fill="#fef3c7"/>
      </svg>
    `;
  },

  flame(size = 16) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" class="pixel-sprite">
        <rect x="5" y="1" width="2" height="2" fill="#f97316"/>
        <rect x="4" y="3" width="4" height="3" fill="#ea580c"/>
        <rect x="2" y="5" width="8" height="4" fill="#dc2626"/>
        <rect x="3" y="9" width="6" height="2" fill="#9a3412"/>
        <rect x="4" y="6" width="4" height="3" fill="#facc15"/>
      </svg>
    `;
  }
};
