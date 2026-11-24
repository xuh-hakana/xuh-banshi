
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""搬屎重复修复：统一内容身份 + 跨身份闸门 + 清理双轨副本。

用法:
  python3 fix.py --code          打代码补丁（幂等，锚点不唯一则中止）
  python3 fix.py --data          备份 data/ 并清理 mid: 轨副本（会先写报告）
  python3 fix.py --verify        跨身份重复统计（只读）
"""
import json, os, shutil, subprocess, sys, time

L = os.environ.get("BANSHI_L") or os.path.expanduser("~/.astrbot/data/plugins/astrbot_plugin_banshi_auto")
D = os.environ.get("BANSHI_D") or os.path.join(L, "data")
TS = time.strftime("%Y%m%d-%H%M%S")
BK = os.environ.get("BANSHI_BK") or os.path.expanduser("~/.astrbot/plugin_backups/banshi-identity-" + TS)

def rd(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def wr(p, s):
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)

def sub(src, old, new, tag):
    n = src.count(old)
    if n != 1:
        raise SystemExit("[ABORT] 锚点 %s 命中 %d 次（要求 1）" % (tag, n))
    return src.replace(old, new, 1)

# ---------------- 代码补丁 ----------------
OLD_IS_SENT = '''    def _is_sent(self, platform, gid, ckey):
        try:
            return bool(self.ledger.content_sent(platform, gid, ckey))
        except AttributeError:
            try:
                return str(gid) in self.ledger.content_sent_targets(ckey)
            except Exception:
                return False
        except Exception:
            return False'''

NEW_IS_SENT = '''    def mids_of(self, ckey):
        c = self.contents.get(str(ckey)) or {}
        return [str(m) for m in (c.get("mids") or [])]

    def ckey_for_mid(self, mid):
        """mid -> 已有内容身份（优先指纹身份）。没有返回空。"""
        mid = str(mid)
        for k, c in self.contents.items():
            if isinstance(c, dict) and mid in [str(m) for m in (c.get("mids") or [])]:
                if not str(k).startswith("mid:"):
                    return str(k)
        for k, c in self.contents.items():
            if isinstance(c, dict) and mid in [str(m) for m in (c.get("mids") or [])]:
                return str(k)
        return ""

    def resolve_ckey(self, fp, mids):
        """内容身份唯一化：指纹优先 -> 按 mid 反查已有指纹身份 -> mid 兜底。"""
        mids = [str(m) for m in (mids or []) if m is not None]
        mk = str((fp or {}).get("message_key") or "")
        if mk:
            return mk
        for m in mids:
            k = self.ckey_for_mid(m)
            if k and not k.startswith("mid:"):
                return k
        for m in mids:
            k = self.ckey_for_mid(m)
            if k:
                return k
        return ("mid:" + mids[0]) if mids else ""

    def _is_sent(self, platform, gid, ckey):
        try:
            if bool(self.ledger.content_sent(platform, gid, ckey)):
                return True
        except AttributeError:
            try:
                if str(gid) in self.ledger.content_sent_targets(ckey):
                    return True
            except Exception:
                pass
        except Exception:
            pass
        # 跨身份：同内容的任一 mid 已在该群发过，也算已发
        try:
            mids = self.mids_of(ckey)
            if mids and self.ledger.sent_by_mid(gid, mids, platform):
                return True
        except Exception:
            pass
        # 再兜一层：指纹库记着这份内容在该群出现过（与 v1 判重同语义）
        try:
            if ckey and str(gid) not in (self.env.sources() or []) and self.env.index_has(ckey, gid):
                return True
        except Exception:
            pass
        return False'''

PATCHES = []

def patch_outbox(s):
    s = sub(s, OLD_IS_SENT, NEW_IS_SENT, "outbox._is_sent")
    s = sub(s, 'ckey = str((fp or {}).get("message_key") or ("mid:" + mids[0]))',
            'ckey = self.resolve_ckey(fp, mids)', "outbox.ingest.ckey")
    return s

def patch_archive(s):
    s = sub(s, 'def record(self, mid, source, sender, at, segs, nickname: str = "", extra=None) -> dict:',
            'def record(self, mid, source, sender, at, segs, nickname: str = "", extra=None,\n               message_key: str = "") -> dict:', "archive.record.sig")
    s = sub(s, '            "ts": time.time(),\n        }',
            '            "ts": time.time(),\n            "key": str(message_key or ""),\n        }', "archive.record.key")
    anchor = '    def content_sent_targets(self, message_key) -> set:'
    add = '''    def sent_by_mid(self, gid, mids, platform="qq") -> bool:
        """同一内容换身份（mid/指纹）也要认：任一 mid 或 key:mid 在该群发过即算已发。"""
        try:
            sent = self._load_sent()
        except Exception:
            return False
        gid = str(gid)
        for m in (mids or []):
            for k in (str(m), "key:" + str(m)):
                if gid in (sent.get(k) or ()):
                    return True
        return False

'''
    return sub(s, anchor, add + anchor, "archive.sent_by_mid")

def patch_runtime(s):
    s = sub(s, '''    def retry_base(self):
        return self.p._int("retry_interval_seconds", 60)''',
            '''    def retry_base(self):
        return self.p._int("retry_interval_seconds", 60)

    def index_has(self, key, gid):
        try:
            return bool(self.p.index.has(str(key), str(gid)))
        except Exception:
            return False''', "runtime.env.index_has")
    s = sub(s, '''            if self.archive.content_sent("qq", gid, str(rec.get("message_key") or ("mid:" + str(mid)))):
                continue
            if self.outbox.ensure_from_archive(
                str(rec.get("message_key") or ("mid:" + str(mid))), gid, source,
                str(rec.get("sender") or ""), at, [str(mid)],
            ):''',
            '''            ckey = self.outbox.resolve_ckey(
                {"message_key": str(rec.get("key") or rec.get("message_key") or "")}, [str(mid)])
            if not ckey:
                continue
            if self.outbox._is_sent("qq", gid, ckey):
                continue
            if self.outbox.ensure_from_archive(
                ckey, gid, source,
                str(rec.get("sender") or ""), at, [str(mid)],
            ):''', "runtime.reconcile")
    return s

def patch_migrate(s):
    s = sub(s, '        ckey = entry_key(e)\n        if not ckey:\n            continue\n        at = float(e.get("at") or now)',
            '        ckey = outbox.resolve_ckey({"message_key": str(e.get("message_key") or "")}, ids)\n        if not ckey:\n            continue\n        at = float(e.get("at") or now)', "migrate.ckey_main")
    return s

def patch_main(s):
    s = sub(s, '''                self.archive.record(
                    mid_s, gid, str(event.get_sender_id()),
                    float(raw.get("time") or time.time()), segs,
                    nickname=sender_info.get("card") or sender_info.get("nickname") or "",
                )''',
            '''                self.archive.record(
                    mid_s, gid, str(event.get_sender_id()),
                    float(raw.get("time") or time.time()), segs,
                    nickname=sender_info.get("card") or sender_info.get("nickname") or "",
                    message_key=self._mid_key(mid_s),
                )''', "main.record_evt")
    s = sub(s, '            self.archive.record(mid, src, sender, at, segs)\n            healed += 1',
            '            self.archive.record(mid, src, sender, at, segs, message_key=self._mid_key(mid))\n            healed += 1', "main.record_heal")
    s = sub(s, '    async def _recover_loop(self):',
            '''    def _mid_key(self, mid):
        """归档落身份：mid 在 outbox 里已有的内容身份（指纹优先）。"""
        try:
            return self.outbox.ckey_for_mid(mid)
        except Exception:
            return ""

    async def _recover_loop(self):''', "main._mid_key")
    return s

TARGETS = [("core/outbox.py", patch_outbox), ("core/archive.py", patch_archive),
           ("core/outbox_runtime.py", patch_runtime), ("core/migrate_v2.py", patch_migrate),
           ("main.py", patch_main)]

def do_code():
    os.makedirs(BK, exist_ok=True)
    for name, _ in TARGETS:
        p = os.path.join(L, name)
        b = os.path.join(BK, name.replace("/", "_"))
        if os.path.exists(p) and not os.path.exists(b):
            shutil.copy2(p, b)
    # 先全部在内存里打补丁，全部成功才落盘（要么全改要么不改）
    staged = []
    for name, fn in TARGETS:
        p = os.path.join(L, name)
        src = rd(p)
        if "resolve_ckey" in src and name != "main.py":
            print("[skip] %s 已打过补丁" % name)
            continue
        new = fn(src)
        staged.append((p, new))
    for p, new in staged:
        wr(p, new)
        print("[patch] %s" % os.path.basename(p))
    if not staged:
        print("[code] 无需改动")
        return
    for p, _ in staged:
        r = subprocess.run([sys.executable, "-m", "py_compile", p], capture_output=True, text=True)
        if r.returncode != 0:
            print("[FAIL] 编译失败 %s\n%s" % (p, r.stderr[-1500:]))
            print("[回滚] 备份在 %s" % BK)
            return
    print("[code] 编译全过；备份 %s" % BK)

def load_outbox():
    with open(os.path.join(D, "outbox.json"), "r", encoding="utf-8") as f:
        return json.load(f)

def do_data():
    os.makedirs(BK, exist_ok=True)
    for f in ("outbox.json", "sent.jsonl", "queue.json", "seen_index.json"):
        p = os.path.join(D, f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(BK, f))
    print("[backup] data -> %s" % BK)
    ob = load_outbox()
    tasks, contents = ob.get("tasks") or {}, ob.get("contents") or {}
    mid_tasks = {k: v for k, v in tasks.items() if str(v.get("ckey") or "").startswith("mid:")}
    mid_contents = [k for k in contents if str(k).startswith("mid:")]
    rep = {"ts": TS, "removed_tasks": len(mid_tasks), "removed_contents": len(mid_contents),
           "tasks_before": len(tasks), "contents_before": len(contents),
           "by_group": {}}
    for t in mid_tasks.values():
        g = str(t.get("gid"))
        rep["by_group"][g] = rep["by_group"].get(g, 0) + 1
    for k in mid_tasks:
        tasks.pop(k, None)
    for k in mid_contents:
        contents.pop(k, None)
    ob["tasks"], ob["contents"] = tasks, contents
    rep["tasks_after"] = len(tasks)
    rep["contents_after"] = len(contents)
    tmp = os.path.join(D, ".outbox.fix.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ob, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(D, "outbox.json"))
    with open(os.path.join(BK, "cleanup-report.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print(json.dumps(rep, ensure_ascii=False))

def read_sent():
    rows = []
    p = os.path.join(D, "sent.jsonl")
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows

def do_verify():
    ob = load_outbox()
    contents, tasks = ob.get("contents") or {}, ob.get("tasks") or {}
    mid2keys = {}
    for k, c in contents.items():
        for m in (c.get("mids") or []):
            mid2keys.setdefault(str(m), set()).add(str(k))
    multi = {m: ks for m, ks in mid2keys.items() if len(ks) > 1}
    rows = read_sent()
    key_of = {}
    for m, ks in mid2keys.items():
        for k in ks:
            if k.startswith("m:"):
                key_of[m] = k
                break
    # 内容身份 x 群 的发送次数（跨身份合并到指纹身份）
    sent_cnt = {}
    for r in rows:
        mid = str(r.get("mid"))
        g = str(r.get("target"))
        if mid.startswith("key:"):
            ident = mid[4:]
            if ident.startswith("mid:"):
                ident = key_of.get(ident[4:], ident)
        else:
            ident = key_of.get(mid, "mid:" + mid)
        sent_cnt[(ident, g)] = sent_cnt.get((ident, g), 0) + 1
    dup = {k: v for k, v in sent_cnt.items() if v > 1}
    mid_pend = sum(1 for t in tasks.values() if str(t.get("ckey") or "").startswith("mid:"))
    print(json.dumps({
        "contents": len(contents), "tasks": len(tasks),
        "midTrackTasks": mid_pend,
        "midsWithMultiIdentity": len(multi),
        "sentRows": len(rows),
        "dup_content_group_pairs": len(dup),
        "dupTop": ["%s@%s x%d" % (k[0][:24], k[1], v) for k, v in list(dup.items())[:8]],
    }, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    a = set(sys.argv[1:])
    if "--code" in a:
        do_code()
    if "--data" in a:
        do_data()
    if "--verify" in a:
        do_verify()
    if not a:
        print(__doc__)
