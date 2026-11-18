#!/usr/bin/env bash
# =============================================================================
# Diario RPG · Arranque en Linux / macOS
# Crea el entorno virtual si hace falta, instala dependencias base y levanta
# FastAPI en 0.0.0.0:8000 abriendo el navegador cuando el puerto está listo.
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$APP_DIR"

VENV_PY="$APP_DIR/.venv/bin/python"
PORT=8000
OPEN_BROWSER=1

for arg in "$@"; do
  case "$arg" in
    --no-browser) OPEN_BROWSER=0 ;;
    --help|-h)
      echo "Uso: ./run.sh [--no-browser]"
      echo "  --no-browser   Levanta el servidor sin abrir el navegador."
      exit 0
      ;;
  esac
done

echo "======================================================================"
echo "   Diario RPG · Local-First ($(uname -s))"
echo "======================================================================"

# 1. Entorno virtual
if [ ! -x "$VENV_PY" ]; then
  echo "-> Creando entorno virtual en .venv ..."
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv >/dev/null
  else
    python3 -m venv .venv
  fi
fi

# 2. Dependencias base (solo si falta FastAPI)
if ! "$VENV_PY" -c "import fastapi, uvicorn, pydantic, qrcode, requests" >/dev/null 2>&1; then
  echo "-> Instalando dependencias base ..."
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$VENV_PY" -r requirements.txt
  else
    "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
    "$VENV_PY" -m pip install --upgrade pip >/dev/null
    "$VENV_PY" -m pip install -r requirements.txt
  fi
fi

# 3. Puerto libre
if "$VENV_PY" - "$PORT" <<'PY' >/dev/null 2>&1
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", port))
    sys.exit(0)  # ocupado
except OSError:
    sys.exit(1)  # libre
finally:
    s.close()
PY
then
  echo "-> El puerto $PORT ya está en uso."
  echo "   Detén la instancia anterior con: ./stop.sh"
  echo "   O revisa qué proceso lo ocupa:   ss -ltnp | grep :$PORT"
  exit 1
fi

# 4. Ollama (informativo)
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "   ✓ Ollama activo (resúmenes con Qwen si hay modelo disponible)."
else
  echo "   ! Ollama no responde; se usará el redactor determinista de respaldo."
fi

# 5. Servidor
mkdir -p "$APP_DIR/.run"
echo $$ > "$APP_DIR/.run/app.pid"

echo "-> Servidor en http://127.0.0.1:$PORT (PC, Wi-Fi y Tailscale)."
echo "   Botón 'Código QR' para abrirlo desde el celular. Ctrl+C para detener."
echo

if [ "$OPEN_BROWSER" -eq 1 ]; then
  exec "$VENV_PY" "$APP_DIR/run_app.py" --open-browser
else
  exec "$VENV_PY" "$APP_DIR/run_app.py"
fi
