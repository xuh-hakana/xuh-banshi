import json, os, sys
d = os.path.expanduser("~/.astrbot/data/plugins/astrbot_plugin_banshi_auto/data")
o = json.load(open(os.path.join(d, "outbox.json")))
t, c = o["tasks"], o["contents"]
sent = {}
for line in open(os.path.join(d, "sent.jsonl"), encoding="utf-8"):
    try: x = json.loads(line)
    except Exception: continue
    sent.setdefault(str(x.get("mid")), set()).add(str(x.get("target")))
pend = [v for v in t.values() if v.get("state") == "pending"]
bad = 0
for v in pend:
    cont = c.get(str(v.get("ckey"))) or {}
    g = str(v.get("gid"))
    for m in (cont.get("mids") or []):
        if g in (sent.get(str(m)) or ()):
            bad += 1
            break
print("pending", len(pend), "alreadySentSameGroup", bad)