#!/bin/bash
set -u
WK="."
S="$WK/tools/banshi-fix/staged"
L="$HOME/.astrbot/data/plugins/astrbot_plugin_banshi_auto"
TS=$(date +%Y%m%d-%H%M%S)
B="$HOME/.astrbot/plugin_backups/banshi-identity-$TS"
mkdir -p "$B/data"
cp -a "$L/main.py" "$B/" 2>/dev/null
cp -a "$L/core" "$B/core" 2>/dev/null
cp -a "$L/data/outbox.json" "$B/data/" 2>/dev/null
cp -a "$L/data/sent.jsonl" "$B/data/" 2>/dev/null
echo "备份: $B"
echo "== 停后端"
PID=$(pgrep -f launch_backend.py | head -1 || true)
if [ -n "$PID" ]; then kill "$PID" 2>/dev/null; sleep 2; fi
PID=$(pgrep -f launch_backend.py | head -1 || true)
if [ -n "$PID" ]; then kill -9 "$PID" 2>/dev/null; sleep 1; fi
if pgrep -f launch_backend.py >/dev/null; then echo "警告:后端未停"; else echo "后端已停"; fi
echo "== 替换代码 + 队列"
cp "$S/main.py" "$L/main.py"
for f in outbox.py archive.py outbox_runtime.py migrate_v2.py; do cp "$S/core/$f" "$L/core/$f"; done
rm -rf "$L/__pycache__" "$L/core/__pycache__"
cp "$S/data/outbox.json" "$L/data/.outbox.new" && mv "$L/data/.outbox.new" "$L/data/outbox.json"
echo -n "线上 resolve_ckey 标记: "; grep -c resolve_ckey "$L/core/outbox.py"
echo "== 启后端"
if ! pgrep -f launch_backend.py >/dev/null; then
  launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/com.strangelove.astrbot-backend.plist" >/dev/null 2>&1 || true
  sleep 4
  if ! pgrep -f launch_backend.py >/dev/null; then
    open -a "~/Applications/AstrBot.app" 2>/dev/null || true
    sleep 12
  fi
fi
if pgrep -f launch_backend.py >/dev/null; then echo "后端已起"; else echo "警告:后端未起"; fi
echo "== 验收"
python3 "$WK/tools/banshi-fix/fix.py" --verify