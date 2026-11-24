"""outbox.py — 按 (平台, 目标群, 内容key) 唯一的发件箱。

设计铁律（主人 2026-11-24 令「按群排，只有群/平台级重复允许，其他全部禁止」）：
1. 任务主键 = gid|ckey。同一群、同一内容只可能有一条任务，重复由数据结构保证，
   不靠遍历去重，因此不可能再堆出 53/39 份僵尸。
2. 只有 complete() 能删任务，且删之前必先写已发台账。没发过的任务永不消失，
   不按年龄清、不按失败清。
3. 失败只加 tries 不删；到 max_tries 转 blocked，仍低频重试（2 小时）。
4. 目标群被移出名单 -> paused（保留）；加回且未发 -> 恢复。多源群只影响
   contents.source(s)，不产生第二份任务。
"""
import json
import os
import tempfile
import threading
import time

VERSION = 2
PLATFORM_DEFAULT = "qq"


def task_key(gid, ckey):
    return str(gid) + "|" + str(ckey)


class DictEnv:
    """最小环境适配器：单测和不依赖 AstrBot 的场景用。"""

    def __init__(self, targets=(), excludes=(), sources=(), joins=None,
                 max_tries=3, retry_base=60):
        self._targets = list(targets)
        self._excludes = list(excludes)
        self._sources = list(sources)
        self._joins = dict(joins or {})
        self._max_tries = int(max_tries)
        self._retry_base = int(retry_base)

    def targets(self):
        return [str(x) for x in self._targets]

    def excludes(self):
        return [str(x) for x in self._excludes]

    def sources(self):
        return [str(x) for x in self._sources]

    def join_at(self, gid):
        try:
            return float(self._joins.get(str(gid)) or 0)
        except (TypeError, ValueError):
            return 0.0

    def max_tries(self):
        return max(1, self._max_tries)

    def retry_base(self):
        return max(10, self._retry_base)


class Outbox:
    SAVE_MIN_INTERVAL = 2.0

    def __init__(self, path, ledger, env=None):
        self.path = path
        self.ledger = ledger
        self.env = env or DictEnv()
        self.data = {"v": VERSION, "contents": {}, "tasks": {}}
        self._lock = threading.RLock()
        self._last_save = 0.0
        self._dirty = False
        self._load()

    # ---------- 读写 ----------
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = None
        if not isinstance(data, dict) or data.get("v") != VERSION:
            return
        contents = data.get("contents")
        tasks = data.get("tasks")
        self.data = {
            "v": VERSION,
            "contents": contents if isinstance(contents, dict) else {},
            "tasks": tasks if isinstance(tasks, dict) else {},
        }

    def save(self, force=False):
        now = time.time()
        if not force and now - self._last_save < self.SAVE_MIN_INTERVAL:
            self._dirty = True
            return
        try:
            d = os.path.dirname(self.path)
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".outbox-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False)
            os.replace(tmp, self.path)
            self._last_save = now
            self._dirty = False
        except OSError:
            self._dirty = True

    def flush(self):
        if self._dirty:
            self.save(force=True)

    # ---------- 查询 ----------
    @property
    def contents(self):
        return self.data["contents"]

    @property
    def tasks(self):
        return self.data["tasks"]

    def content(self, ckey):
        return self.contents.get(str(ckey))

    def task(self, gid, ckey):
        return self.tasks.get(task_key(gid, ckey))

    def pending_pairs(self):
        """未发 (gid, ckey) 集合：迁移校验和验收用。"""
        return {(t.get("gid"), t.get("ckey")) for t in self.tasks.values()
                if t.get("state") != "paused"}

    def stats(self):
        out = {"contents": len(self.contents), "tasks": len(self.tasks),
               "pending": 0, "blocked": 0, "paused": 0, "sending": 0}
        for t in self.tasks.values():
            st = str(t.get("state") or "pending")
            if st == "pending":
                out["pending"] += 1
            elif st == "blocked":
                out["blocked"] += 1
            elif st == "paused":
                out["paused"] += 1
            elif st == "sending":
                out["sending"] += 1
        return out

    def group_pending(self, gid):
        return sum(1 for t in self.tasks.values()
                   if str(t.get("gid")) == str(gid) and t.get("state") in ("pending", "blocked", "sending"))

    def group_blocked(self, gid):
        return sum(1 for t in self.tasks.values()
                   if str(t.get("gid")) == str(gid) and t.get("state") == "blocked")

    def group_max_fails(self, gid):
        m = 0
        for t in self.tasks.values():
            if str(t.get("gid")) == str(gid):
                m = max(m, int(t.get("tries") or 0))
        return m

    def contents_for_group(self, gid):
        out = []
        for t in self.tasks.values():
            if str(t.get("gid")) != str(gid):
                continue
            c = self.contents.get(str(t.get("ckey")))
            if c:
                out.append((t, c))
        out.sort(key=lambda x: float(x[1].get("at") or 0))
        return out

    # ---------- 写入：内容 ----------
    def upsert_content(self, ckey, platform, source, sender, at, mids,
                       kind="", head=""):
        """同 ckey 只保留一份内容；后来的 mid/源群并进来（同内容换 mid 不新建）。"""
        ckey = str(ckey)
        cur = self.contents.get(ckey)
        mids = [str(m) for m in (mids or []) if m is not None]
        at = float(at or time.time())
        if not isinstance(cur, dict):
            cur = {
                "key": ckey, "platform": str(platform or PLATFORM_DEFAULT),
                "first_at": at, "at": at,
                "source": str(source or ""), "sources": [str(source)] if source else [],
                "sender": str(sender or ""), "mids": [],
                "kind": str(kind or ""), "head": str(head or "")[:120],
            }
            self.contents[ckey] = cur
        for m in mids:
            if m not in cur["mids"]:
                cur["mids"].append(m)
        src = str(source or "")
        if src and src not in cur.get("sources", []):
            cur.setdefault("sources", []).append(src)
        cur["at"] = min(float(cur.get("at") or at), at)
        cur["first_at"] = min(float(cur.get("first_at") or at), at)
        if not cur.get("source") and src:
            cur["source"] = src
        if not cur.get("sender") and sender:
            cur["sender"] = str(sender)
        if kind and not cur.get("kind"):
            cur["kind"] = str(kind)
        if head and not cur.get("head"):
            cur["head"] = str(head)[:120]
        return cur

    # ---------- 写入：任务 ----------
    def _new_task(self, gid, ckey, platform, at):
        return {
            "gid": str(gid), "ckey": str(ckey),
            "platform": str(platform or PLATFORM_DEFAULT),
            "at": float(at or time.time()), "created_at": time.time(),
            "tries": 0, "next_try": 0.0, "last_error": "",
            "state": "pending", "claim_at": 0.0,
        }

    def _candidates(self, source, platform, ckey, at):
        """该内容该发给哪些群：目标名单 - 排除 - 源群 - 加入时间之前 - 台账已发。"""
        out = []
        targets = self.env.targets()
        excludes = set(self.env.excludes())
        for gid in targets:
            gid = str(gid)
            if gid == str(source) or gid in excludes:
                continue
            join = self.env.join_at(gid)
            if join and at < join:
                continue
            if self._is_sent(platform, gid, ckey):
                continue
            out.append(gid)
        return out

    def mids_of(self, ckey):
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
        return False

    def ingest(self, fp, items, source, platform=PLATFORM_DEFAULT):
        """入队一批（连发聚类的同一份内容）。返回新建任务数。"""
        items = [it for it in (items or []) if isinstance(it, dict) and it.get("mid") is not None]
        if not items:
            return 0
        mids = [str(it.get("mid")) for it in items]
        at = min(float(it.get("at") or time.time()) for it in items)
        sender = str(items[0].get("sender") or "")
        primary = (fp or {}).get("primary") or {}
        ckey = self.resolve_ckey(fp, mids)
        kind = str(primary.get("kind") or "")
        head = str(primary.get("text") or primary.get("txt") or "")[:120]
        with self._lock:
            self.upsert_content(ckey, platform, source, sender, at, mids, kind, head)
            created = 0
            for gid in self._candidates(source, platform, ckey, at):
                k = task_key(gid, ckey)
                if k in self.tasks:
                    continue
                self.tasks[k] = self._new_task(gid, ckey, platform, at)
                created += 1
            if created:
                self.save()
            return created

    def ensure_from_archive(self, ckey, gid, source, sender, at, mids,
                            platform=PLATFORM_DEFAULT, kind="", head=""):
        """补发/回填用：内容与任务都不存在才建；已发台账命中则跳过。"""
        with self._lock:
            cur = self.content(ckey)
            if cur is None:
                self.upsert_content(ckey, platform, source, sender, at, mids, kind, head)
            k = task_key(gid, ckey)
            if k in self.tasks or self._is_sent(platform, gid, ckey):
                return False
            self.tasks[k] = self._new_task(gid, ckey, platform, at)
            self.save()
            return True

    # ---------- 调度 ----------
    def _claimable(self, task, now):
        state = str(task.get("state") or "pending")
        if state == "paused":
            return False
        if state == "sending":
            return now - float(task.get("claim_at") or 0) > 180   # 上次发送中崩溃，超时可重抢
        if float(task.get("next_try") or 0) > now:
            return False
        if self._is_sent(task.get("platform"), task.get("gid"), task.get("ckey")):
            return False
        return True

    def next_for(self, gid, now=None):
        now = time.time() if now is None else float(now)
        gid = str(gid)
        best = None
        best_key = None
        for t in self.tasks.values():
            if str(t.get("gid")) != gid:
                continue
            if not self._claimable(t, now):
                continue
            c = self.contents.get(str(t.get("ckey")))
            if not isinstance(c, dict):
                continue
            k = (float(c.get("at") or 0), float(t.get("created_at") or 0))
            if best is None or k < best_key:
                best, best_key = t, k
        return best

    def claim(self, gid, ckey, now=None):
        now = time.time() if now is None else float(now)
        with self._lock:
            t = self.task(gid, ckey)
            if not isinstance(t, dict) or not self._claimable(t, now):
                return None
            t["state"] = "sending"
            t["claim_at"] = now
            self.save()
            return dict(t)

    def release(self, gid, ckey):
        with self._lock:
            t = self.task(gid, ckey)
            if isinstance(t, dict) and t.get("state") == "sending":
                t["state"] = "pending"
                t["claim_at"] = 0.0
                self.save()

    # ---------- 终态 ----------
    def complete(self, gid, ckey, mid=None, platform=None):
        """唯一删除任务的入口：先写台账并回读确认，再删任务。"""
        gid, ckey = str(gid), str(ckey)
        platform = str(platform or PLATFORM_DEFAULT)
        with self._lock:
            t = self.task(gid, ckey)
            if isinstance(t, dict):
                platform = str(t.get("platform") or platform)
            self._mark_ledger(platform, gid, ckey, mid)
            if not self._is_sent(platform, gid, ckey):
                if isinstance(t, dict):
                    t["state"] = "pending"
                    t["claim_at"] = 0.0
                    t["last_error"] = "已发台账写入失败"
                self.save(force=True)
                return False
            self.tasks.pop(task_key(gid, ckey), None)
            self.save(force=True)
            return True

    def _mark_ledger(self, platform, gid, ckey, mid):
        try:
            self.ledger.mark_content_sent(ckey, gid, force=True, platform=platform)
        except TypeError:
            self.ledger.mark_content_sent(ckey, gid, force=True)
        except Exception:
            pass
        if mid is not None and str(mid):
            try:
                self.ledger.mark_sent(str(mid), gid, force=True)
            except Exception:
                pass

    def fail(self, gid, ckey, reason):
        """失败：只加惩罚，不删任务；到上限转 blocked，仍低频重试。"""
        with self._lock:
            t = self.task(gid, ckey)
            if not isinstance(t, dict):
                return
            tries = int(t.get("tries") or 0) + 1
            t["tries"] = tries
            t["last_error"] = str(reason)[:300]
            t["claim_at"] = 0.0
            base = self.env.retry_base()
            max_tries = self.env.max_tries()
            if tries >= max_tries:
                t["state"] = "blocked"
                t["next_try"] = time.time() + 7200
                t["alerted"] = t.get("alerted") or tries == max_tries
            else:
                t["state"] = "pending"
                if tries <= 1:
                    delay = base
                elif tries == 2:
                    delay = 2 * base
                elif tries == 3:
                    delay = 4 * base
                else:
                    delay = 4 * base * (tries - 2)
                t["next_try"] = time.time() + min(3600, delay)
            self.save()

    # ---------- 名单变更 ----------
    def pause_group(self, gid):
        with self._lock:
            changed = 0
            for t in self.tasks.values():
                if str(t.get("gid")) == str(gid) and t.get("state") != "paused":
                    t["state"] = "paused"
                    changed += 1
            if changed:
                self.save()
            return changed

    def resume_group(self, gid):
        with self._lock:
            changed = 0
            for t in self.tasks.values():
                if str(t.get("gid")) != str(gid) or t.get("state") != "paused":
                    continue
                if self._is_sent(t.get("platform"), gid, t.get("ckey")):
                    continue   # 已发的不复活，留给 audit 清
                t["state"] = "pending"
                t["next_try"] = 0.0
                changed += 1
            if changed:
                self.save()
            return changed

    # ---------- 合并/拆分 ----------
    def merge_contents(self, keys):
        keys = [str(k) for k in keys if k]
        keep = None
        for k in keys:
            c = self.contents.get(k)
            if not isinstance(c, dict):
                continue
            if keep is None:
                keep = c
                continue
            for m in c.get("mids") or []:
                if m not in keep["mids"]:
                    keep["mids"].append(m)
            for s in c.get("sources") or []:
                if s not in keep.setdefault("sources", []):
                    keep["sources"].append(s)
            keep["at"] = min(float(keep.get("at") or 0), float(c.get("at") or 0))
            self.contents.pop(k, None)
            for tk, t in list(self.tasks.items()):
                if str(t.get("ckey")) != k:
                    continue
                t["ckey"] = keep["key"]
                nk = task_key(t.get("gid"), keep["key"])
                if nk in self.tasks and nk != tk:
                    old = self.tasks[nk]
                    old["at"] = min(float(old.get("at") or 0), float(t.get("at") or 0))
                    old["tries"] = max(int(old.get("tries") or 0), int(t.get("tries") or 0))
                    old["next_try"] = min(float(old.get("next_try") or 0), float(t.get("next_try") or 0))
                    self.tasks.pop(tk, None)
                else:
                    self.tasks[nk] = self.tasks.pop(tk)
        if keep is not None:
            self.save()
        return keep

    def split_content(self, ckey, groups):
        """把一份内容按指纹聚类拆成多份；groups 为 [[mid,...], ...]。"""
        c = self.contents.get(str(ckey))
        if not isinstance(c, dict):
            return []
        out = []
        for idx, mids in enumerate(groups):
            mids = [str(m) for m in mids]
            if not mids:
                continue
            if idx == 0:
                c["mids"] = mids
                out.append(c)
                continue
            nk = str(ckey) + "#" + str(idx)
            nc = dict(c)
            nc["key"] = nk
            nc["mids"] = mids
            self.contents[nk] = nc
            for gid in self._candidates(c.get("source"), c.get("platform"), nk, nc.get("at")):
                self.tasks[task_key(gid, nk)] = self._new_task(gid, nk, nc.get("platform"), nc.get("at"))
            out.append(nc)
        self.save()
        return out

    # ---------- 自检 ----------
    def audit(self):
        """启动自检：已发的清掉、除名的暂停、孤儿任务保留并记账。只修状态不删未发。"""
        changed = 0
        targets = set(self.env.targets())
        for tk, t in list(self.tasks.items()):
            if not isinstance(t, dict):
                self.tasks.pop(tk, None)
                changed += 1
                continue
            if self._is_sent(t.get("platform"), t.get("gid"), t.get("ckey")):
                self._mark_ledger(t.get("platform"), t.get("gid"), t.get("ckey"), None)
                self.tasks.pop(tk, None)
                changed += 1
                continue
            if str(t.get("gid")) not in targets and t.get("state") != "paused":
                t["state"] = "paused"
                changed += 1
            if str(t.get("ckey")) not in self.contents:
                t["state"] = "paused"
                t["last_error"] = "内容记录缺失"
                changed += 1
        if changed:
            self.save(force=True)
        return changed
