#!/bin/bash
# 内存采样：每 60 秒记一次 RSS top10（排除本地模型）与 swap，单进程超 3G 打 ALERT。
# 用法：nohup bash scripts/mem-watch.sh >/dev/null 2>&1 &
LOG="$(cd "$(dirname "$0")/.." && pwd)/data/mem-watch.log"
LIMIT_MB=3072
mkdir -p "$(dirname "$LOG")"
while true; do
  ts=$(date '+%F %T')
  {
    echo "== $ts"
    sysctl -n vm.swapusage
    ps -axo rss,pid,comm | sort -nr | awk -v lim="$LIMIT_MB" '
      # rss 单位是 KB，阈值是 MB，换算后再比；ALERT 直接打在这一行前面，不重复输出
      { if ($3 ~ /llama-server/) next
        if (int($1/1024) > lim) printf "ALERT "
        printf "%6dMB pid=%-7s %s\n", int($1/1024), $2, $3 }
    ' | head -13
    ps -axo rss,comm | grep -v llama-server | awk '{s+=$1} END {printf "TOTAL %.1fGB (excl llama)\n", s/1048576}'
  } >> "$LOG"
  sleep 60
done
