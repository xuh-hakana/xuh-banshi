#!/bin/bash
set -u
WK="."
S="$WK/tools/banshi-fix/staged"
L="$HOME/.astrbot/data/plugins/astrbot_plugin_banshi_auto"
TS=$(date +%Y%m%d-%H%M%S)
B="$HOME/.astrbot/plugin_backups/banshi-identity-$TS"
mkdir -p "$B/data"
cp -a "$L/main.py" "$B/"
cp -a "$L/core" "$B/core"
cp -a "$L/data/outbox.json" "$B/data/" 2>/dev/null
cp -a "$L/data/sent.jsonl" "$B/data/" 2>/dev/null
echo "备份: $B"
launchctl bootout gui/501/com.strangelove.astrbot-backend >/dev/null 2>&1 || true
sleep 1
cp "$S/main.py" "$L/main.py"
for f in outbox.py archive.py outbox_runtime.py migrate_v2.py; do cp "$S/core/$f" "$L/core/$f"; done
rm -rf "$L/__pycache__" "$L/core/__pycache__"
cp "$S/data/outbox.json" "$L/data/.outbox.new" && mv "$L/data/.outbox.new" "$L/data/outbox.json"
echo "代码+队列已替换"
launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/com.strangelove.astrbot-backend.plist" >/dev/null 2>&1 \
  || launchctl kickstart -k gui/501/com.strangelove.astrbot-backend >/dev/null 2>&1
sleep 8
echo "== 验收"
python3 "$WK/tools/banshi-fix/fix.py" --verify
echo -n "补丁生效标记: "; grep -c resolve_ckey "$L/core/outbox.py"
