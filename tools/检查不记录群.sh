#!/bin/bash
# ==========================================================
#   检查「不记录群」是不是真的在拦（两层都查）
#   用法：双击这个文件，或在终端里 bash "检查不记录群.sh"
#   干什么：
#     1) bot.js 层：chat-log / 话题 / 首见 里有没有目标群的行
#     2) AstrBot 层：会话库 / 记忆片段池 里有没有目标群的记录
#   改群号：改下面 GROUP 这一行
# ==========================================================
GROUP="100000000"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$PROJ/data"

echo "=========================================="
echo "  检查「不记录群」：群 $GROUP"
echo "  现在：$(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""
echo "【第一层 · bot.js】"
echo "  聊天记录里的行数  : $(grep -c "\[群$GROUP\]" "$DATA/chat-log.jsonl" 2>/dev/null | head -1)   ← 应该是 0"
echo "  话题日志里的行数  : $(grep -c "\"scope\":\"群$GROUP\"" "$DATA/topics.jsonl" 2>/dev/null | head -1)   ← 应该是 0"
python3 -c "
import json
d=json.load(open('$DATA/seen.json'))
hit=[x for x in d.get('groups',[]) if '$GROUP' in str(x)]
print('  首见记录        :', hit if hit else '无   ← 应该是无')
" 2>/dev/null
echo "  （对照）聊天记录总行数: $(grep -c '' "$DATA/chat-log.jsonl" 2>/dev/null)   ← 别的群在正常记录就说明机器人活着"
echo ""
echo "【第二层 · AstrBot】"
python3 - << PYEOF
import sqlite3, os
G = "$GROUP"
def q(db, sql, args=()):
    try:
        con = sqlite3.connect(db, timeout=8); cur = con.cursor()
        cur.execute(sql, args); n = cur.fetchone()[0]; con.close(); return n
    except Exception:
        return -1
base = os.path.expanduser('~/.astrbot/data')
db = os.path.join(base, 'data_v4.db')
print("  会话全文(conversations):", q(db, "SELECT count(*) FROM conversations WHERE user_id LIKE ?", (f'%{G}%',)), "  ← 应该是 0")
print("  调用统计(provider_stats):", q(db, "SELECT count(*) FROM provider_stats WHERE umo LIKE ?", (f'%{G}%',)), "  ← 应该是 0")
fdb = os.path.join(base, 'plugin_data/astrbot_plugin_memshare/fragments.db')
print("  记忆片段(memory_fragments):", q(fdb, "SELECT count(*) FROM memory_fragments WHERE umo LIKE ?", (f'%{G}%',)), "  ← 应该是 0")
PYEOF
echo ""
echo "【配置在哪】"
echo "  bot.js 层：$DATA/../config/features.json 的 noRecordGroups"
echo "  AstrBot 层：~/.astrbot/data/config/astrbot_plugin_memshare_config.json 的 exclude_group_ids"
echo "  （改 bot.js 那份即时生效；改 AstrBot 那份要重启 AstrBot）"
echo ""
echo "=========================================="
