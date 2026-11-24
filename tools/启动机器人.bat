@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul
title Utsuro Bot
set "NODE=C:~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
if not exist "%NODE%" set "NODE=node"
echo ==========================================
echo   Utsuro Bot  -  QQ / Bilibili
echo   This window keeps the bot alive:
echo   if it exits, it restarts automatically.
echo   Close this window = bot offline.
echo ==========================================
echo.

rem v90: one instance only. Two bots = every message answered twice, and they
rem fight over the same websocket. The running pid sits in data/bot-status.json.
"%NODE%" -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('data/bot-status.json','utf8'));if(s&&s.pid){process.kill(s.pid,0);process.exit(0)}}catch(e){}process.exit(1)"
if not errorlevel 1 (
  echo A bot is ALREADY running. This window closes in 8 seconds.
  echo Do not open it twice. To restart, use option 4 in the check menu.
  ping -n 9 127.0.0.1 >nul
  exit /b 0
)

set /a FAILS=0
:loop
echo [%date% %time%] start bot.js >> data\bot-err.log
rem v90: waiting uses ping instead of timeout (timeout breaks when stdin or
rem stdout is redirected, e.g. started from a script).
rem v88: stdout goes to bot-out.log too. Without this the self-check reads a
rem months-old log and thinks nothing ever crashed.
"%NODE%" bot.js >>data\bot-out.log 2>>data\bot-err.log
set "CODE=!ERRORLEVEL!"
echo.
echo [%date% %time%] bot.js exited, code !CODE! >> data\bot-err.log
echo [stopped] exit code !CODE!
set /a FAILS+=1
if !FAILS! GTR 5 (
  echo 5 exits in this window. Waiting 60 seconds before retry.
  echo [%date% %time%] 5 exits in this window, sleeping 60s >> data\bot-err.log
  set /a FAILS=0
  ping -n 61 127.0.0.1 >nul
) else (
  echo Restarting in 5 seconds... close this window to stop.
  ping -n 6 127.0.0.1 >nul
)
goto loop
