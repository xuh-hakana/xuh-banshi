#!/bin/bash
# ==========================================================
#   双击入口：检查「不记录群」是不是真的在拦
#   —— 这个文件只负责"让双击能跑起来"，真正的检查逻辑在同目录的
#      「检查不记录群.sh」里。改检查内容去改那个 .sh。
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
bash "$DIR/检查不记录群.sh"

echo ""
printf "按任意键关闭窗口…"
read -n 1 -s
echo ""
