#!/bin/bash
# 找 node 来跑脚本：不依赖全局 PATH（这台机器没装 node，但 WorkBuddy 自带 Electron/Node）。
# 用法：bash scripts/node.sh src/bot.js …     或  bash scripts/node.sh -e "console.log(process.version)"
set -u

ELECTRON="/Applications/WorkBuddy.app/Contents/MacOS/Electron"
NODEDAT="/Applications/WorkBuddy.app/Contents/Resources/vendor/node.dat"
CACHE_DIR="$HOME/Library/Caches/xuhbot-node"

# 1) 显式指定
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
  exec "${NODE_BIN}" "$@"
fi

# 2) PATH 里的 node
if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi

# 3) WorkBuddy 的版本目录（客户端拉 bot 用的就是这一个）
WBNODE_DIR="$HOME/.workbuddy/binaries/node/versions"
if [ -d "$WBNODE_DIR" ]; then
  for v in "$WBNODE_DIR"/current "$WBNODE_DIR"/*; do
    if [ -x "$v/bin/node" ]; then exec "$v/bin/node" "$@"; fi
  done
fi

# 4) 已解包过的副本
if [ -x "$CACHE_DIR/node" ]; then
  exec "$CACHE_DIR/node" "$@"
fi

# 4) WorkBuddy 的 Electron 直接当 node 用（同一个 V8/Node 运行时）
if [ -x "$ELECTRON" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$@"
fi

# 5) 从 node.dat 解包（gzip 里是 node_mac_arm64.dat.tmp.tar）
if [ -f "$NODEDAT" ]; then
  mkdir -p "$CACHE_DIR"
  if gunzip -c "$NODEDAT" | tar -x -C "$CACHE_DIR" 2>/dev/null; then
    found=$(find "$CACHE_DIR" -maxdepth 2 -type f -name 'node*' ! -name '*.tmp' | head -1)
    if [ -n "$found" ]; then
      chmod +x "$found"
      cp -f "$found" "$CACHE_DIR/node"
      exec "$CACHE_DIR/node" "$@"
    fi
  fi
fi

echo "找不到 node：请安装 node，或设置 NODE_BIN，或确认 WorkBuddy.app 还在 /Applications。" >&2
exit 2
