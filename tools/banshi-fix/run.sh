#!/bin/bash
set -u
PY=python3
cd "." || exit 1
echo "== 1) 代码补丁"
$PY tools/banshi-fix/fix.py --code || { echo "CODE_FAIL"; exit 1; }
echo "== 2) 停服务"
launchctl bootout gui/501/com.strangelove.astrbot-backend >/dev/null 2>&1 || true
sleep 1
echo "== 3) 清理 mid 轨副本"
if ! $PY tools/banshi-fix/fix.py --data; then
  echo "DATA_FAIL 重启服务"
  launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/com.strangelove.astrbot-backend.plist" >/dev/null 2>&1
  exit 1
fi
echo "== 4) 启服务"
launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/com.strangelove.astrbot-backend.plist" >/dev/null 2>&1 \
  || launchctl kickstart -k gui/501/com.strangelove.astrbot-backend >/dev/null 2>&1
sleep 6
echo "== 5) 验收统计"
$PY tools/banshi-fix/fix.py --verify
