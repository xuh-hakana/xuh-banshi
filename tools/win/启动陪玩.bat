@echo off
chcp 65001 >nul
title 虚幻陪玩
cd /d "%~dp0"
echo.
echo   虚幻陪玩 - 正在启动，稍等
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0companion-shot.ps1" %*
echo.
echo   已停止。
pause
