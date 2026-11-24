#!/bin/bash
# 双击这个文件就能开客户端（macOS / Linux）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没装 Node.js。先去 https://nodejs.org 装 22 或更新版本，再双击本文件。"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "第一次启动，正在装 Electron（约 100 MB，几分钟，只装这一次）…"
  npm install --registry=https://registry.npmmirror.com || npm install
  if [ ! -d node_modules/electron ]; then
    echo "Electron 装不上。检查网络，或在终端里手动跑：cd client && npm install"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  fi
fi

npx electron . "$@"
