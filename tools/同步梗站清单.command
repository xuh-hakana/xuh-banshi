#!/bin/bash
# 梗站清单：单一数据源在 xuhbot/src/data/meme-sites.json（权威）。
# search（Python 面板）那份是它的同步副本，由本文件生成。
# 改站点清单只改权威那份，然后双击本文件同步；两个 app 各自打包时各带自己的副本。
SRC="$HOME/Documents/xuhuan mac/xuhbot/src/data/meme-sites.json"
DST="$HOME/Documents/xuhuan mac/search/server/meme_sites.json"
if [ ! -f "$SRC" ]; then echo "源文件不存在: $SRC"; exit 1; fi
cp "$SRC" "$DST" && echo "已同步梗站清单 → $DST" || echo "同步失败"
