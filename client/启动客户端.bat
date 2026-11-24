@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没装 Node.js。先去 https://nodejs.org 装 22 或更新版本，再双击本文件。
  pause
  exit /b 1
)
if not exist "node_modules\electron" (
  echo 第一次启动，正在装 Electron（约 100 MB，几分钟，只装这一次）…
  call npm install --registry=https://registry.npmmirror.com
  if not exist "node_modules\electron" call npm install
  if not exist "node_modules\electron" (
    echo Electron 装不上。检查网络，或在 cmd 里手动跑：cd client ^&^& npm install
    pause
    exit /b 1
  )
)
call npx electron . %*
