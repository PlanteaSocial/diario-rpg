@echo off
chcp 65001 > nul
title Diario RPG - Local First

echo ======================================================================
echo    Iniciando Diario RPG (Local-First Windows)
echo ======================================================================

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo -^> Liberando puerto 8000 si estaba ocupado...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" > nul 2>&1

set "PYTHON_EXE=%PROJECT_DIR%.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

echo -^> Iniciando servidor en 0.0.0.0:8000 (PC, Wi-Fi y Tailscale)...
echo    El navegador local (http://127.0.0.1:8000) se abrira al estar listo.
echo    Para entrar desde tu celular usa el boton Codigo QR.
echo    Presiona Ctrl+C para detener.
echo ======================================================================

"%PYTHON_EXE%" "%PROJECT_DIR%run_app.py" --open-browser
pause
