import json
import os
import re
import time

import aiohttp

MEDIA_TYPES = ("image", "video", "record", "file", "audio")


def _safe(name: str, fallback: str = "file") -> str:
    base = os.path.basename(str(name or "")).strip() or fallback
    base = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+", "_", base)
    return base[:80] or fallback


class Archive:
    """接收即归档：内容与媒体落盘，发送不再依赖 NapCat 的运行期 message_id。"""

    def __init__(self, data_dir: str):
        self.dir = os.path.join(data_dir, "archive")
        self.media = os.path.join(data_dir, "media")
        self.sent_file = os.path.join(data_dir, "sent.jsonl")
        self._sent = None          # mid -> set(target)：索引，O(1) 查，行为与原来的全表扫描完全一样
        self._rows = None          # mid -> set((platform, target))：平台维度去重（v2 起）
        self._cache = {}           # mid -> rec，按插入顺序淘汰，避免历史越久内存越大
        self._cache_max = 2000
        for d in (self.dir, self.media):
            os.makedirs(d, exist_ok=True)

    # ---------- 归档 ----------
    def _day_file(self, at: float) -> str:
        return os.path.join(self.dir, time.strftime("%Y-%m-%d", time.localtime(at)) + ".jsonl")

    def record(self, mid, source, sender, at, segs, nickname: str = "", extra=None,
               message_key: str = "") -> dict:
        rec = {
            "mid": str(mid),
            "source": str(source),
            "sender": str(sender),
            "nickname": str(nickname or ""),
            "at": float(at or time.time()),
            "segs": segs if isinstance(segs, list) else [],
            "ts": time.time(),
            "key": str(message_key or ""),
        }
        if isinstance(extra, dict):
            rec.update(extra)
        self._cache[rec["mid"]] = rec
        if len(self._cache) > self._cache_max:
            for old_mid in list(self._cache.keys())[: len(self._cache) - self._cache_max]:
                self._cache.pop(old_mid, None)
        try:
            with open(self._day_file(rec["at"]), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return rec

    def update(self, mid, segs):
        rec = {"mid": str(mid), "segs": segs, "ts": time.time(), "updated": True}
        old = self._cache.get(str(mid))
        if old:
            old["segs"] = segs
        else:
            loaded = self.load(since=0)
            if str(mid) in loaded:
                loaded[str(mid)]["segs"] = segs
                self._cache[str(mid)] = loaded[str(mid)]
        try:
            with open(self._day_file(time.time()), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def load(self, since: float = 0) -> dict:
        out = {}
        try:
            names = sorted(os.listdir(self.dir))
        except OSError:
            return out
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(self.dir, name)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except ValueError:
                            continue
                        mid = str(rec.get("mid") or "")
                        if not mid:
                            continue
                        if rec.get("updated"):
                            if mid in out:
                                out[mid]["segs"] = rec.get("segs") or out[mid].get("segs")
                            continue
                        if float(rec.get("at") or 0) < since:
                            continue
                        if "at" in rec or "source" in rec:
                            out[mid] = rec
                            self._cache[mid] = rec
            except OSError:
                continue
        return out

    def latest(self, mid):
        """取一条消息的归档记录。

        旧写法是「缓存没命中就 load(since=0) 全量扫所有日文件」——历史越久越慢，
        而且会把整库记录塞进 _cache。现在只按需从最新的日文件往前翻，找到就停；
        「后来补的 updated 行」在更新的日文件里，所以在命中基线后再把更新的文件扫一遍补 segs，
        返回结果与旧写法一致。
        """
        mid = str(mid)
        if mid in self._cache:
            return self._cache[mid]
        try:
            names = sorted((n for n in os.listdir(self.dir) if n.endswith(".jsonl")), reverse=True)
        except OSError:
            return None
        base = None
        newer = []
        for name in names:
            found_here = None
            search_updates = base is not None      # 已找到基线：只在更新的文件里找 updated 行
            try:
                with open(os.path.join(self.dir, name), "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except ValueError:
                            continue
                        if str(rec.get("mid") or "") != mid:
                            continue
                        if rec.get("updated"):
                            newer.append(rec)
                        elif search_updates:
                            pass
                        else:
                            found_here = rec
            except OSError:
                continue
            if found_here is not None:
                base = found_here
                break          # 基线找到了，更老的文件不用再看
        if base is None:
            return None
        for rec in newer:
            base["segs"] = rec.get("segs") or base.get("segs")
        self._cache[mid] = base
        if len(self._cache) > self._cache_max:
            for old_mid in list(self._cache.keys())[: len(self._cache) - self._cache_max]:
                self._cache.pop(old_mid, None)
        return base

    # ---------- 媒体 ----------
    def _media_path(self, mid, idx, kind, name) -> str:
        day = os.path.join(self.media, time.strftime("%Y-%m-%d", time.localtime()))
        folder = os.path.join(day, str(mid))
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, f"{idx}_{kind}_{_safe(name, kind)}")

    @staticmethod
    def _local_file(data) -> str:
        for key in ("file", "path"):
            val = str(data.get(key) or "")
            if val.startswith("file://"):
                val = val[7:]
            if val and os.path.isfile(val):
                return val
        return ""

    async def _download(self, session, url, dest) -> bool:
        try:
            async with session.get(
                url, headers={"User-Agent": "Mozilla/5.0"}, timeout=aiohttp.ClientTimeout(total=90)
            ) as resp:
                if resp.status != 200:
                    return False
                tmp = dest + ".part"
                size = 0
                with open(tmp, "wb") as f:
                    async for chunk in resp.content.iter_chunked(65536):
                        f.write(chunk)
                        size += len(chunk)
                if size <= 0:
                    os.remove(tmp)
                    return False
                os.replace(tmp, dest)
                return True
        except Exception:
            return False

    async def localize(self, mid, segs):
        """把消息里的媒体落到本机；失败保留原 URL，绝不影响入队。"""
        if not isinstance(segs, list):
            return segs
        want = [s for s in segs if isinstance(s, dict) and s.get("type") in MEDIA_TYPES]
        if not want:
            return segs
        async with aiohttp.ClientSession() as session:
            for idx, seg in enumerate(segs):
                if not isinstance(seg, dict) or seg.get("type") not in MEDIA_TYPES:
                    continue
                data = seg.get("data")
                if not isinstance(data, dict):
                    continue
                kind = seg.get("type")
                name = data.get("name") or data.get("file") or f"{kind}"
                dest = self._media_path(mid, idx, kind, name)
                if os.path.isfile(dest) and os.path.getsize(dest) > 0:
                    data["file"] = "file://" + dest
                    data["url"] = ""
                    continue
                local = self._local_file(data)
                if local:
                    try:
                        with open(local, "rb") as src, open(dest, "wb") as dst:
                            dst.write(src.read())
                        data["file"] = "file://" + dest
                        data["url"] = ""
                        continue
                    except OSError:
                        pass
                url = str(data.get("url") or "")
                if url.startswith("http"):
                    if await self._download(session, url, dest):
                        data["file"] = "file://" + dest
                        data["url"] = ""
        return segs

    # ---------- 发送记录 ----------
    def _load_sent(self):
        if self._sent is not None:
            return self._sent
        self._sent = {}
        self._rows = {}
        try:
            with open(self.sent_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    mid = str(rec.get("mid"))
                    target = str(rec.get("target"))
                    plat = str(rec.get("platform") or "qq")
                    self._sent.setdefault(mid, set()).add(target)
                    self._rows.setdefault(mid, set()).add((plat, target))
        except OSError:
            pass
        return self._sent

    def sent_targets(self, mid) -> set:
        mid = str(mid)
        return set(self._load_sent().get(str(mid)) or ())

    def mark_sent(self, mid, target, force=False, platform="qq"):
        mid, target = str(mid), str(target)
        self._load_sent()
        sent = self._sent
        targets = sent.setdefault(mid, set())
        rows = self._rows.setdefault(mid, set())
        plat = str(platform or "qq")
        if target in targets and not force:
            return
        targets.add(target)
        rows.add((plat, target))
        try:
            with open(self.sent_file, "a", encoding="utf-8") as f:
                f.write(json.dumps({"mid": str(mid), "target": str(target), "platform": plat,
                                    "at": time.time()}, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # ---------- 按内容指纹的永久去重（主人 2026-11-24 令「发过的只发一次、永久去重」）----------
    # 同一条内容会被源群反复发成不同 mid，只按 mid 记已发挡不住。这里把内容的
    # message_key 也当身份记进同一份 sent.jsonl，用 key: 前缀和纯数字 mid 区分，
    # 不另建文件。旧档案里没有 key: 记录，首次运行会把队列里已发的补记进去。
    def sent_by_mid(self, gid, mids, platform="qq") -> bool:
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

    def content_sent_targets(self, message_key) -> set:
        k = "key:" + str(message_key or "")
        if k == "key:":
            return set()
        return set(self._load_sent().get(k) or ())

    def content_sent(self, platform, target, message_key) -> bool:
        """(平台, 群, 内容key) 是否已发。这是 v2 唯一允许的重复维度：同群同平台同内容只能发一次。"""
        k = "key:" + str(message_key or "")
        if k == "key:":
            return False
        self._load_sent()
        rows = (self._rows or {}).get(k) or set()
        return (str(platform or "qq"), str(target)) in rows

    def mark_content_sent(self, message_key, target, force=False, platform="qq"):
        k = "key:" + str(message_key or "")
        if k == "key:":
            return
        self.mark_sent(k, target, force=force, platform=platform)
