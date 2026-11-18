# ==============================================================================
# Script de Arranque Rápido para Windows (PowerShell) - Diario Inteligente
# ==============================================================================
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   Iniciando Diario Inteligente (Local-First · Windows Nativo)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $AppDir

# 1. Liberar puerto 8000 si ya estaba en uso por una sesión anterior
$occupied = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($occupied) {
    Write-Host "-> Liberando puerto 8000 (cerrando proceso previo PID: $($occupied.OwningProcess[0]))..." -ForegroundColor Yellow
    foreach ($procId in $occupied.OwningProcess) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

# 2. Verificar o activar el entorno virtual
$VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $AltPython = Join-Path (Split-Path -Parent $AppDir) "laya_ai\.venv\Scripts\python.exe"
    if (Test-Path $AltPython) {
        $VenvPython = $AltPython
        Write-Host "-> Utilizando entorno virtual en: $AltPython" -ForegroundColor Green
    } else {
        Write-Host "-> Creando entorno virtual local..." -ForegroundColor Yellow
        python -m venv (Join-Path $AppDir ".venv")
        $VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
        & "$AppDir\.venv\Scripts\pip.exe" install laya fastapi uvicorn requests
    }
} else {
    Write-Host "-> Entorno virtual detectado: $VenvPython" -ForegroundColor Green
}

# 3. Verificar estado de Ollama
Write-Host "-> Verificando servicio local de Ollama..." -ForegroundColor Yellow
try {
    $ollamaCheck = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($ollamaCheck.models) {
        $qwenFound = $ollamaCheck.models | Where-Object { $_.name -like "*qwen*" }
        if ($qwenFound) {
            Write-Host "   ✓ Ollama activo con modelo: $($qwenFound[0].name)" -ForegroundColor Green
        } else {
            Write-Host "   ! Ollama activo, pero no se detectó modelo Qwen. Se usará motor determinista de respaldo." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "   ! Ollama no está escuchando en puerto 11434. La app funcionará con el motor de respaldo determinista." -ForegroundColor Yellow
}

# 4. Comprobar regla de Firewall de Windows para puerto TCP 8000 (solo aviso informativo)
try {
    $fwRule = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8000 }
    if (-not $fwRule) {
        Write-Host "   ! Si aún no abres el puerto 8000 en Firewall para tu celular, ejecuta PowerShell como Administrador:" -ForegroundColor Yellow
        Write-Host '     New-NetFirewallRule -DisplayName "Diario RPG (Puerto 8000)" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow' -ForegroundColor Gray
    }
} catch {}

# 5. Lanzar servidor FastAPI con Uvicorn en todas las interfaces (0.0.0.0:8000)
Write-Host "`n-> Cargando Laya AI y levantando servidor en 0.0.0.0:8000 (PC, Wi-Fi y Tailscale)..." -ForegroundColor Cyan
Write-Host "   El navegador local (http://127.0.0.1:8000) se abrirá automáticamente en unos segundos." -ForegroundColor Gray
Write-Host "   Usa el botón 'Código QR' arriba a la derecha para abrirlo desde tu celular." -ForegroundColor Gray
Write-Host "   Presiona Ctrl+C para detener la aplicación.`n" -ForegroundColor Gray

$env:PYTHONPATH = $AppDir
$RunAppPy = Join-Path $AppDir "run_app.py"
& $VenvPython $RunAppPy --open-browser
