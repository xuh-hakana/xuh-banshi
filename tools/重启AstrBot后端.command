#!/bin/bash
# ==========================================================
#   双击入口：重启 AstrBot 后端
#   —— 这个文件只负责"让双击能跑起来"，真正的重启逻辑在同目录的
#      「重启AstrBot后端.py」里。改逻辑去改那个 .py。
#   允许被软链到别的文件夹双击（会自动找回本文件真正所在的位置）
# ==========================================================

SELF="$0"
while [ -L "$SELF" ]; do
    D="$(cd -P "$(dirname "$SELF")" && pwd)"
    L="$(readlink "$SELF")"
    case "$L" in
        /*) SELF="$L" ;;
        *)  SELF="$D/$L" ;;
    esac
done
DIR="$(cd -P "$(dirname "$SELF")" && pwd)"
cd "$DIR" || exit 1

clear
echo "正在重启 AstrBot 后端，请稍等（最多 80 秒）…"
echo ""
python3 "$DIR/重启AstrBot后端.py"
RC=$?

echo ""
if [ "$RC" = "0" ]; then
    echo "== 完成 =="
else
    echo "== 没成功，退出码 $RC，看上面提示 =="
fi
printf "按任意键关闭窗口…"
read -n 1 -s
echo ""
