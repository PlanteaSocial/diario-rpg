#!/usr/bin/env bash
# Detiene la instancia de Diario RPG lanzada desde este proyecto.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PIDFILE="$APP_DIR/.run/app.pid"
PY="$APP_DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

stopped=0

kill_pid() {
  local pid="$1"
  [ -n "${pid:-}" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.15
    done
    kill -9 "$pid" 2>/dev/null || true
    stopped=1
  fi
}

if [ -f "$PIDFILE" ]; then
  kill_pid "$(cat "$PIDFILE" 2>/dev/null || true)"
  rm -f "$PIDFILE"
fi

# Procesos de este proyecto aunque se hayan lanzado a mano.
while IFS= read -r pid; do
  [ -n "$pid" ] && kill_pid "$pid"
done < <(pgrep -f "$APP_DIR/run_app.py" 2>/dev/null || true)

# Último recurso: el proceso que escucha en :8000 y cuyo cwd es este proyecto.
PORT_PID="$("$PY" - "$APP_DIR" <<'PY' 2>/dev/null || true
import os
import re
import subprocess
import sys

app_dir = os.path.realpath(sys.argv[1])
try:
    out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True).stdout
except OSError:
    sys.exit(0)

for line in out.splitlines():
    if ":8000" not in line:
        continue
    match = re.search(r"pid=(\d+)", line)
    if not match:
        continue
    pid = match.group(1)
    try:
        cwd = os.path.realpath(os.readlink(f"/proc/{pid}/cwd"))
    except OSError:
        continue
    if cwd == app_dir:
        print(pid)
        break
PY
)"
if [ -n "${PORT_PID:-}" ]; then
  kill_pid "$PORT_PID"
fi

if [ "$stopped" -eq 1 ]; then
  echo "Diario RPG detenido."
else
  echo "No había una instancia activa de Diario RPG."
fi
