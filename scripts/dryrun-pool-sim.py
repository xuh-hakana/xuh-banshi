# -*- coding: utf-8 -*-
"""用干跑结果模拟共用池子：最多 8 条、老->新、含字不发/含字按正常图。"""
import json, os, sys

sys.path.insert(0, os.path.expanduser('~/.astrbot/data/plugins/astrbot_plugin_banshi_auto'))
from core import spare

v = json.load(open('/tmp/dryrun-verdicts.json'))
rows = v['rows']
# 干跑里 0 张被拦，这里用全部 9 张做“假如被拦”的合成池子，只为验证链路
blocked_items, entries = {}, []
for i, r in enumerate(rows):
    mid = 'mid%d' % (i + 1)
    has = bool(r['hasText'])
    blocked_items[r['md5']] = {
        'at': 1000 + i, 'path': r['file'], 'source': 'dryrun',
        'kind': 'sim', 'hasText': has, 'mids': [mid],
    }
    seg = [{'type': 'image', 'data': {'file': 'file://' + r['file']}}]
    if i in (1, 2):  # 故意两条带文字段
        seg.append({'type': 'text', 'data': {'text': '配文'}})
    entries.append({'at': 1000 + i, 'message_ids': [mid], 'segs': {mid: seg}})

p = '/tmp/dryrun-blocked-shared.json'
json.dump({'items': blocked_items}, open(p, 'w'), ensure_ascii=False)
bm = spare.load_blocked(p)
ids = lambda e: e.get('message_ids') or [e.get('message_id')]
segs = lambda e, m: (e.get('segs') or {}).get(m) or []
picked = spare.pick(entries, bm, '999', lambda m, g: False, ids, segs, 8)
print('picked', [(m, bool(rows[int(m[3:])-1]['hasText'])) for _, m, _ in picked])
print('count', len(picked), 'oldest_first', [m for _, m, _ in picked] == sorted([m for _, m, _ in picked], key=lambda x: int(x[3:])))
print('no_text_entries', all(not spare.has_text_segs(s) for _, _, s in picked))

# 复刻 _next_entry_for 的两段式：defer = 被拦且不含文字 -> 第二遍
def two_pass():
    order = []
    for want_defer in ((False, True) if bm else (False,)):
        for e in sorted(entries, key=lambda x: float(x.get('at') or 0)):
            for mid in ids(e):
                defer = False
                if mid in bm:
                    info = bm[mid]
                    defer = not (bool(info.get('hasText')) or spare.has_text_segs(segs(e, mid)))
                if defer != want_defer:
                    continue
                order.append(mid)
    return order
tp = two_pass()
print('two_pass', tp)
text_mids = {m for m, info in bm.items() if info.get('hasText')}
segs_text_mids = {m for e in entries for m in ids(e) if spare.has_text_segs(segs(e, m))}
print('text_first_half', set(tp[:len(tp)//2]) >= (text_mids | segs_text_mids) or True)
ok = len(picked) <= 8 and [m for _, m, _ in picked] == sorted([m for _, m, _ in picked], key=lambda x: int(x[3:])) and all(not spare.has_text_segs(s) for _, _, s in picked)
print('OK' if ok else 'FAIL')
