# Diario Inteligente · Local-First (Linux · Windows · macOS)

**Diario Inteligente** es una aplicación de escritorio/web local-first de diario personal y seguimiento emocional. Funciona de forma nativa en **Linux** (probado en Omarchy/Arch), **Windows** y **macOS**, sin depender de la nube.

---

## 🏗️ Stack Tecnológico & Arquitectura

1. **Backend Local**: Python 3.11+ + FastAPI + Uvicorn sirviendo API REST y frontend estático en `http://127.0.0.1:8000`.
2. **Base de Datos Local-First**: SQLite en modo WAL (`data/diario.db`) detrás de un patrón repositorio abstracto (`storage/repository.py`), garantizando funcionamiento 100% offline y desacoplamiento para futuras sincronizaciones.
3. **Motor de Clasificación Primario — Laya AI**:
   - Modelo: `convaiinnovations/laya` (checkpoint `multilingual`, 322M parámetros).
   - Filosofía: *"Decisions, not text"*. Clasificador no autorregresivo que evalúa el texto del día en una sola pasada (~33 ms) contra preguntas estructuradas (`choice`, `score`, `noul`) con probabilidades calibradas.
   - Batería paralela (<20 opciones por pregunta):
     - Valencia emocional (muy negativo a muy positivo)
     - Activación / Energía percibida (agotamiento a entusiasmo)
     - Emoción primaria dominante (alegría, calma, estrés, tristeza, frustración, ansiedad, gratitud, apatía)
     - Ejes temáticos booleanos en paralelo (trabajo/estudio, descanso/sueño, relaciones/familia, salud/cuerpo, carga mental)
     - Señales de alerta (desgaste sostenido, contradicción emocional)
4. **Motor Redactor Secundario — Qwen vía Ollama**:
   - Detecta automáticamente el modelo `qwen3.5:4b` (o variantes Qwen cuantizadas) en Ollama (`http://127.0.0.1:11434`).
   - Recibe exclusivamente los porcentajes JSON de Laya y estadísticas de Python para redactar un resumen amable del periodo.
   - Restricción estricta de vocabulario: Únicamente lenguaje no clínico (*"señal"*, *"patrón"*, *"sugerencia"*). Prohibidos términos clínicos o diagnósticos médicos.
   - Incluye motor determinista de respaldo si Ollama no está activo.
5. **Cálculos Deterministas en Python**: Horas reales de sueño (cruce de medianoche), rachas, promedios de línea base personal y detección de discrepancias (auto-reporte vs. texto).
6. **Diseño UX/UI (Apple HIG)**:
   - Paleta serena `#f5f5f7` con tarjetas `#ffffff`, tipografía del sistema, navegación en 5 pestañas: **Hoy**, **Historial**, **Patrones**, **Retos** y **Aprender** (más **Ajustes** en la cabecera).
   - Captura primero, cero ruido: Nota Rápida (mensajería) + Nota del Día con cuestionario de un solo toque (<15 s).
   - Regla *"El usuario manda"*: botón para ver porcentajes de Laya y corregir manualmente etiquetas, registrando cada ejemplo en `data/train_feedback.jsonl`.
7. **Capa de Seguridad No Negociable**: Detección determinista de autolesión / restricción severa y semántica con Laya, activando mensajes cálidos de apoyo y líneas oficiales de ayuda (Línea de la Vida, Teléfono de la Esperanza, 911).
8. **Módulo Aprender (Fase 1)**: Rutas educativas curadas de 3–4 minutos con 4 niveles de andamiaje (mito/realidad, clasificación, escenario y reflexión). Incluye dial de fricción, repaso Birdbrain, memoria HLR (`p = 2^(-Δ/h)`), libreta local y EXP integrada al Slime. Sin diagnósticos ni lenguaje clínico.
9. **Clasificador opcional con respaldo local**: si el paquete `laya` (y torch) no está instalado, la app arranca igual con un motor heurístico determinista (`backend/services/laya_fallback.py`) que devuelve la misma estructura de perfil. Al instalar Laya, el modelo real toma el control automáticamente.

---

## 🐧 Arranque rápido en Linux

Requisitos: Python 3.11+ y, opcionalmente, [`uv`](https://docs.astral.sh/uv/) para crear el entorno más rápido.

```bash
cd /home/juan/Projects/Plantea/Herramientas/Diario_RPG/diario_inteligente
./run.sh
```

El script:

1. Crea `.venv` si no existe (con `uv` o `python3 -m venv`).
2. Instala las dependencias base de `requirements.txt`.
3. Comprueba que el puerto 8000 esté libre y si Ollama responde.
4. Levanta FastAPI en `0.0.0.0:8000` y abre el navegador cuando está listo.

Para detenerlo:

```bash
./stop.sh
```

Opciones:

```bash
./run.sh --no-browser   # no abre el navegador
```

**Lanzador de escritorio:** el archivo `diario-rpg.desktop` ya está instalado en `~/.local/share/applications/`. Busca “Diario RPG” en el menú de aplicaciones (o en el lanzador de Omarchy).

**Modelo Laya opcional (pesado, ~2 GB con torch):**

```bash
.venv/bin/pip install -r requirements-laya.txt
```

Sin ese paso, el badge de estado muestra `classifier: heuristica-local` y todo lo demás funciona igual.

## 🔐 Autenticación y múltiples usuarios

- **Primer arranque:** si la base no tiene cuentas, la app muestra una pantalla de **Primer acceso** para crear la cuenta administradora. Solo se permite desde el propio equipo (`127.0.0.1`/`localhost`). Los datos que ya existan se asignan automáticamente a esa primera cuenta.
- **Contraseñas:** se guardan con **Argon2id** (sal aleatoria, 64 MiB, 3 pasadas). Si `argon2-cffi` no está disponible, se usa **PBKDF2-SHA256 con 600 000 iteraciones**. Nunca se guarda ni se registra la contraseña en claro.
- **Sesiones:** cookie `HttpOnly`, `SameSite=Lax`, `Secure` automático en HTTPS, 7 días de vigencia. En SQLite solo se guarda el **SHA-256** del token, nunca el token.
- **Protecciones:** bloqueo de la cuenta tras 5 intentos fallidos (15 min), límite de intentos por IP, comprobación de `Origin`/`Sec-Fetch-Site` contra CSRF, cabeceras `X-Frame-Options: DENY`, `nosniff`, CSP y `Cache-Control: no-store` en la API.
- **Aislamiento:** cada cuenta tiene su propio diario, notas rápidas, perfil, compañero, progreso de Aprender, memoria HLR y libreta. El repositorio se crea por usuario y todas las consultas filtran por `user_id`.
- **Administración:** el administrador abre **Mi cuenta → Usuarios del diario** para crear cuentas, asignar rol, desactivar/reactivar y generar contraseñas temporales. El usuario debe cambiar la contraseña en su primer acceso.
- **Roles:** `admin` puede gestionar usuarios y usar el Modo Desarrollador; `user` solo accede a sus propios datos.
- **Cambio de contraseña:** desde **Mi cuenta → Cambiar contraseña**. Al cambiarla se cierran las demás sesiones.
- **Acceso remoto:** para usar el diario desde el celular se recomienda Tailscale (cifrado) o un proxy HTTPS. La configuración inicial debe hacerse una vez en el equipo local.
- **Recuperación de contraseña:** si olvidas la contraseña, desde el equipo donde corre el diario ejecuta `.venv/bin/python scripts/reset_password.py <usuario>`. Se cierran todas las sesiones de esa cuenta y se pide una contraseña nueva al entrar.
- **Datos en reposo:** las contraseñas están hasheadas, pero el contenido del diario vive en SQLite sin cifrar. Protege el equipo con cifrado de disco (LUKS en Linux, FileVault en macOS, BitLocker en Windows) y mantén `data/` fuera de carpetas compartidas.

### Acceso desde el celular

El servidor escucha en `0.0.0.0`. Usa el botón **Código QR** de la cabecera para abrirlo desde el teléfono en la misma Wi-Fi (o por Tailscale). En Linux no hace falta abrir firewall para `127.0.0.1`; para la LAN, permite el puerto 8000 en tu firewall si lo tienes activo.

---

## ☁️ Modo Nube Zero-Knowledge (Firebase Spark · Hosting + Auth + Firestore E2EE)

Además del arranque local-first con `./run.sh`, el frontend soporta **Modo Dual**: cuando se abre desde Firebase Hosting (o sin backend local en `/api/health`), cambia automáticamente a ejecución 100% cliente/serverless sin costo:

- **URL de producción:** `https://diario-rpg-plantea.web.app` (proyecto `diario-rpg-plantea`).
- **Autenticación:** Firebase Auth con **Google Sign-In** y **Correo/Contraseña**.
- **Cifrado Zero-Knowledge en cliente (`frontend/js/vault_crypto.js`):**
  - El usuario define una **Frase secreta de bóveda**, con la cual el navegador deriva una llave **KEK** mediante `PBKDF2-SHA256` (210 000 iteraciones, sal de 128 bits) para envolver una **DEK** de 256 bits (`AES-256-GCM`), generando además una llave de recuperación única (`DRPG1-...`).
  - Todas las entradas del diario, notas rápidas, perfil, compañero RPG, retos y progreso de Aprender se cifran en el navegador con `AES-256-GCM` y AAD ligado a `uid` + documento antes de enviarse a Cloud Firestore (`/diario_users/{uid}/...`).
- **Motor analítico híbrido en navegador (`frontend/js/client_engine.js` + `frontend/js/ml/`):**
  - **Tier 0 inmediato (`< 2 ms`, `< 300 KB`):**
    - `syntax_features.js`: segmentación por cláusulas (ponderación `1.65` post-adversativa vs `1.0`), 16 señales sintácticas explícitas (negación en ventana de 5 tokens, doble negación, intensificadores, ironía entrecomillada/exclamativa, diccionario fraseológico de modismos de sobrecarga y contradicción intra-nota).
    - `calibration_math.js`: Temperature Scaling (valencia, activación, emoción), Platt Scaling (5 ejes + 3 señales), EMA 3d para desgaste sostenido (`0.75 * hoy + 0.25 * EMA_3d >= 0.85`) y doble compuerta OR de seguridad.
    - `suggestion_engine.js`: banco curado en español neutro sin género ni lenguaje clínico con compuerta dura, afinidad 10D, penalización MMR + HLR (`h = 7 días` / ventana `14 días`) y slot-filling determinista.
  - **Tier 1 neuronal ONNX INT8 offline (`semantic.worker.js` + `semantic_client.js` + `bpe_tokenizer.js`):**
    - Destilación Teacher-Student de 22 → 2 capas (`scripts/distill_laya_student.py`) desde `laya_finetuned` a `models/model_es_q8.onnx` (`18.67 MB`), `tokenizer_es.json` (`687.6 KB`, 12 290 subpalabras), `prototypes_neg_v1.json` (`58.0 KB`) y cabezales híbridos `diario_heads_v1.json` (`125.5 KB`).
    - Los pesos viven fuera de Firebase Hosting (servidos vía GitHub + `jsDelivr` / `raw.githubusercontent` CDN) con caché persistente en **IndexedDB + Cache API** (`navigator.storage.persist()`) y reconciliación en frío (`entryId` + `revision`) de Tier 0 a Tier 1.
- **Respaldo portátil:** desde **Mi cuenta** se puede exportar/importar respaldo JSON completo y cambiar la frase de bóveda sin re-cifrar todo el historial.
- **Despliegue:**

```bash
npx -y firebase-tools@latest deploy --only auth,firestore,hosting --project diario-rpg-plantea
```

---

## 🎓 Módulo Aprender

- **Contenido curado:** `data/learning_tracks.json` (3 rutas: TDAH, estrés/desgaste y sueño) y `data/glossary_terms.json` para Pull Learning.
- **Sendero tipo Duolingo:** cada ruta es una unidad con banner de color, camino serpenteante de nodos circulares con relieve 3D, burbuja **EMPEZAR** en el nodo actual, nodos bloqueados en gris, cofre al final de la unidad y trofeo al dominarla. Incluye HUD de nivel/monedas/lecciones/repasos y mascota Slime junto al sendero.
- **Mecánicas:** dial Hold-to-Charge + Slide, clasificación con reencolado, escenario con ancla de lectura, orden por fichas, reflexión con dibujo y pausa obligatoria al fallar.
- **Memoria:** `hlr_memory` guarda la vida media por lección (se duplica al aprobar, máximo 30 días); cuando la probabilidad de recuerdo baja de 0.75 el nodo pasa a `repasar`.
- **API:** `GET /api/learning/state`, `GET /api/learning/lesson/{id}`, `POST /api/learning/complete`, `POST /api/learning/notebook`, `DELETE /api/learning/notebook/{id}`.
- **Ética:** ningún test o app diagnostica. La recomendación de Laya es una invitación educativa, nunca una etiqueta clínica.

---

## 📁 Estructura del Proyecto

```text
diario_inteligente/
├── .venv/                      # Entorno virtual de Python (Linux/macOS)
├── backend/
│   ├── config.py               # Configuración centralizada, rutas y modelos
│   ├── main.py                 # FastAPI app, endpoints REST y servidor estático
│   ├── models/
│   │   └── schema.py           # Modelos Pydantic v2 tipados
│   ├── deps.py                 # Dependencias de sesión, admin y repositorio por usuario
│   ├── storage/
│   │   ├── database.py         # Conexión SQLite WAL mode e inicialización
│   │   └── repository.py       # Patrón Repositorio abstracto y SQLite
│   └── services/
│       ├── laya_engine.py      # Motor de clasificación Laya AI (opcional)
│       ├── laya_fallback.py    # Respaldo heurístico local sin torch
│       ├── security.py         # Argon2id/PBKDF2, tokens y política de contraseñas
│       ├── auth.py             # Cuentas, sesiones, bloqueo e aislamiento por usuario
│       ├── qwen_engine.py      # Resumen amable con Qwen / respaldo determinista
│       ├── safety.py           # Capa de seguridad no negociable y líneas de ayuda
│       └── analytics.py        # Cálculos deterministas (sueño, rachas, discrepancia)
├── frontend/
│   ├── index.html              # Vista principal en 5 pestañas + gate dual
│   ├── css/
│   │   └── style.css           # Estilos cozy + sendero estilo Duolingo
│   ├── data/                   # Copias estáticas de rutas y glosario para Hosting
│   └── js/
│       ├── firebase-config.js  # Credenciales Web de diario-rpg-plantea
│       ├── vault_crypto.js     # Cifrado Zero-Knowledge AES-256-GCM (WebCrypto)
│       ├── ml/
│       │   ├── syntax_features.js   # Segmentación 1.65/1.0 y 16 señales sintácticas
│       │   ├── calibration_math.js  # Temperature Scaling, Platt, EMA 3d, Tier 1 híbrido
│       │   ├── suggestion_engine.js # Motor vectorial 10D + MMR + HLR sin repetición
│       │   ├── bpe_tokenizer.js     # Tokenizador BPE + byte-fallback en JS puro
│       │   ├── semantic.worker.js   # Web Worker ONNX WASM con caché IndexedDB offline
│       │   └── semantic_client.js   # Coordinador Cold Start (Tier 0 -> Tier 1 entryId)
│       ├── client_engine.js    # Orquestador local, seguridad, analíticas y HLR en JS
│       ├── firebase_backend.js # Adaptador Firebase Auth + Firestore E2EE
│       ├── api.js              # Enrutador dual (FastAPI local / Firebase Cloud)
│       ├── auth.js             # Puerta de acceso local, Google/Email y Bóveda
│       ├── app.js              # Controlador principal
│       └── components/         # Editor, notas, historial, patrones, santuario y Aprender
├── models/                     # Artefactos Tier 1 servidos vía GitHub CDN (0 B en Spark)
│   ├── model_es_q8.onnx        # Encoder ModernBERT 2 capas INT8 destilado (18.67 MB)
│   ├── tokenizer_es.json       # Vocabulario BPE podado al español (687.6 KB)
│   ├── prototypes_neg_v1.json  # 8 prototipos multi-ancla + subespacio SVD negación (58 KB)
│   └── diario_heads_v1.json    # Cabezal híbrido 796D calibrado (125.5 KB)
├── assets/
│   └── diario-rpg.svg          # Icono del lanzador de escritorio
├── data/
│   └── ...                     # SQLite, rutas educativas y evaluación
├── scripts/
│   ├── distill_laya_student.py # Destilación Teacher-Student + cuantización INT8 ONNX
│   ├── evaluate_laya.py        # Evaluación de exactitud y calibración de Laya
│   └── retrain_laya.py         # Pipeline de reentrenamiento condicional
├── tests/                      # Suite unittest + Node ML + Chromium E2E (50 pruebas)
├── firebase.json               # Configuración Auth, Firestore (northamerica-south1) y Hosting
├── firestore.rules             # Reglas estrictas por UID y esquema cifrado
├── firestore.indexes.json      # Índices de Firestore
├── run.sh                      # Arranque Linux/macOS
├── stop.sh                     # Detener servidor
├── run.bat                     # Arranque Windows CMD
├── start_app.ps1               # Arranque Windows PowerShell
├── diario-rpg.desktop          # Lanzador de escritorio
└── README.md                   # Esta documentación
```

---

## 🪟 Arranque rápido en Windows

Abre una consola de PowerShell en la carpeta del proyecto y ejecuta:

```powershell
cd C:\Users\juana\.gemini\antigravity\scratch\diario_inteligente
.\start_app.ps1
```

O haz doble clic en `run.bat` desde el Explorador de Archivos de Windows.  
La aplicación se abrirá automáticamente en tu navegador en:  
👉 **http://127.0.0.1:8000**

### Para detener el servidor:
- En PowerShell: `.\stop_app.ps1`
- O doble clic en: `stop_app.bat`

---

## 🧪 Ejecución de Pruebas y Evaluación

Para correr la suite de pruebas unitarias y de integración:

```bash
.venv/bin/python -m unittest discover tests
```

> Las pruebas de API requieren `httpx2` (dependencia de `starlette.testclient`):
> `.venv/bin/pip install -r requirements-dev.txt`.

Para evaluar el clasificador Laya sobre el conjunto en español (requiere `laya` instalado):

```bash
.venv/bin/python scripts/evaluate_laya.py
```

Para ejecutar el pipeline de reentrenamiento y calibración condicional:

```bash
.venv/bin/python scripts/retrain_laya.py
```
