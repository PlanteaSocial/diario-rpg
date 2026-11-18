# ==============================================================================
# Script para Detener el Servidor de Diario Inteligente (Puerto 8000)
# ==============================================================================
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "Buscando procesos escuchando en el puerto 8000..." -ForegroundColor Cyan

$connections = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue

if ($connections) {
    foreach ($conn in $connections) {
        $pidToKill = $conn.OwningProcess
        if ($pidToKill -gt 0) {
            Write-Host "Deteniendo proceso PID: $pidToKill ..." -ForegroundColor Yellow
            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
    Write-Host "✓ Servidor detenido exitosamente. Puerto 8000 liberado." -ForegroundColor Green
} else {
    Write-Host "El puerto 8000 ya está libre. No había servidores activos." -ForegroundColor Gray
}
