#!/bin/bash
set -u
WK="."
S="$WK/tools/banshi-fix/staged"
L="$HOME/.astrbot/data/plugins/astrbot_plugin_banshi_auto"
TS=$(date +%Y%m%d-%H%M%S)
B="$HOME/.astrbot/plugin_backups/banshi-nooffeed-$TS"
mkdir -p "$B/data"
cp -a "$L/core/outbox_runtime.py" "$B/outbox_runtime.py" 2>/dev/null
cp -a "$L/data/outbox.json" "$B/data/" 2>/dev/null
echo "备份: $B"
echo "== 停后端"
PID=$(pgrep -f "backend/app/main.py" | head -1 || true)
if [ -n "$PID" ]; then kill "$PID" 2>/dev/null; sleep 3; fi
PID=$(pgrep -f "backend/app/main.py" | head -1 || true)
if [ -n "$PID" ]; then kill -9 "$PID" 2>/dev/null; sleep 1; fi
if pgrep -f "backend/app/main.py" >/dev/null; then echo "警告:未停"; else echo "后端已停"; fi
echo "== 替换"
cp "$S/core/outbox_runtime.py" "$L/core/outbox_runtime.py"
rm -rf "$L/__pycache__" "$L/core/__pycache__"
cp "$S/data/outbox.json" "$L/data/.ob.new" && mv "$L/data/.ob.new" "$L/data/outbox.json"
echo -n "关路径标记: "; grep -c "reconcile_archive_enabled" "$L/core/outbox_runtime.py"
echo "== 起后端"
launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/com.strangelove.astrbot-backend.plist" >/dev/null 2>&1 || true
sleep 18
if pgrep -f "backend/app/main.py" >/dev/null; then echo "后端已起"; else echo "警告:后端未起"; fi
echo "== 启动日志（搬屎）"
grep -a "搬屎" /tmp/astrbot-backend.out.log 2>/dev/null | tail -7 | cut -c1-200
echo "== 验收"
python3 "$WK/tools/banshi-fix/fix.py" --verify