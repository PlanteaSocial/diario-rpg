@echo off
chcp 65001 > nul
title Detener Diario Inteligente

echo ======================================================================
echo    Deteniendo Diario Inteligente (Liberando puerto 8000)
echo ======================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; if ($p) { $p.OwningProcess | Sort-Object -Unique | ForEach-Object { Write-Host ('Deteniendo proceso PID ' + $_ + '...'); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host ''; Write-Host '[OK] Servidor detenido y puerto 8000 liberado con exito.' } else { Write-Host 'El puerto 8000 ya se encontraba libre.' }"

echo.
ping -n 4 127.0.0.1 >nul
