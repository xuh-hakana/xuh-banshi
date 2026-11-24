# -*- coding: utf-8 -*-
"""一次性把「B站筛掉的图 → 群关键词点图」补进搬屎插件（可重复执行，已打过就跳过）。"""
import os
import py_compile
import shutil
import sys
import time

BASE = os.path.expanduser("~/.astrbot/data/plugins/astrbot_plugin_banshi_auto")
MAIN = os.path.join(BASE, "main.py")
SCHEMA = os.path.join(BASE, "_conf_schema.json")
PANEL = os.path.join(BASE, "pages/banshi/index.html")
QUEUE = os.path.join(BASE, "core/queue.py")
SPARE = os.path.join(BASE, "core/spare.py")
STAMP = time.strftime("%Y%m%d-%H%M%S")

SPARE_SRC = '''# -*- coding: utf-8 -*-
"""B站动态筛掉的图 -> QQ 群关键词点图（清池子）的纯逻辑。

xuhbot 的 src/bili-dynamic-publisher.js 把 B站审核判不过的图留档到
src/data/bili-blocked-images.json（{items: {md5: {at, path, source, kind, mids}}}）。
本模块不依赖 AstrBot：关键词匹配、台账读取、从队列里挑“被拦的、老的”条目。
"""
import json
import re

_ACTIONS = ("来点", "发点", "发一点", "整点", "来张", "看看", "看", "发")
_NOUNS = ("涩图", "色图", "瑟图", "涩涩", "瑟瑟")
_MAX_GAP = 6
_BLOCKING = ("video", "record", "file", "audio", "forward", "node", "nodes")


def normalize(text):
    out = []
    for ch in str(text or "").lower():
        if ch.isalnum() or "\u4e00" <= ch <= "\u9fff":
            out.append(ch)
    return "".join(out)


def match_request(text):
    """动作词 + 名词，相距 <= 6 字，前后两种顺序都算。"""
    t = normalize(text)
    if not t:
        return False
    for a in _ACTIONS:
        pa = -1
        while True:
            pa = t.find(a, pa + 1)
            if pa < 0:
                break
            ae = pa + len(a)
            for n in _NOUNS:
                pn = -1
                while True:
                    pn = t.find(n, pn + 1)
                    if pn < 0:
                        break
                    ne = pn + len(n)
                    if pn >= ae and pn - ae <= _MAX_GAP:
                        return True
                    if pa >= ne and pa - ne <= _MAX_GAP:
                        return True
    return False


def load_blocked(path):
    """mid -> {imageMd5, path, at, kind}；文件坏了/不在就空表。"""
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return out
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, dict):
        return out
    for md5, rec in items.items():
        if not isinstance(rec, dict):
            continue
        mids = rec.get("mids") if isinstance(rec.get("mids"), list) else []
        info = {
            "imageMd5": str(md5),
            "path": str(rec.get("path") or ""),
            "at": float(rec.get("at") or 0),
            "kind": str(rec.get("kind") or ""),
        }
        for mid in mids:
            out[str(mid)] = info
    return out


def image_segs(segs):
    return [s for s in (segs or []) if isinstance(s, dict) and s.get("type") == "image"]


def has_text_or_media(segs):
    """条里有文字段或视频/聊天记录等非图片媒体 -> 这条不发。"""
    for s in segs or []:
        if not isinstance(s, dict):
            continue
        t = s.get("type")
        if t in _BLOCKING:
            return True
        if t == "text":
            data = s.get("data") or {}
            if str(data.get("text") or "").strip():
                return True
    return False


def pick(entries, blocked, gid, sent_fn, ids_of, segs_of, limit=8):
    """按 at 升序挑“被拦 + 还没发这个群 + 纯图”的条目，最多 limit 条。"""
    out = []
    for e in sorted(entries or [], key=lambda x: float((x or {}).get("at") or 0)):
        if not isinstance(e, dict):
            continue
        try:
            ids = [str(m) for m in ids_of(e)]
        except Exception:
            continue
        for mid in ids:
            if mid not in blocked:
                continue
            try:
                if sent_fn(mid, gid):
                    continue
            except Exception:
                continue
            try:
                segs = segs_of(e, mid) or []
            except Exception:
                segs = []
            if has_text_or_media(segs):
                continue
            if not image_segs(segs) and not str((blocked.get(mid) or {}).get("path") or ""):
                continue
            out.append((e, mid, segs))
            break
        if len(out) >= limit:
            break
    return out
'''


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    tmp = path + ".tmp-spare"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def patch(path, pairs):
    s = read(path)
    changed = 0
    for old, new in pairs:
        if new in s:
            continue
        if s.count(old) != 1:
            raise SystemExit("anchor 不唯一/找不到：%s @ %s (count=%d)" % (path, old[:60], s.count(old)))
        s = s.replace(old, new, 1)
        changed += 1
    if changed:
        write(path, s)
    return changed


def main():
    for f in (MAIN, SCHEMA, PANEL, QUEUE):
        bak = f + ".bak-spare2-" + STAMP
        if not os.path.exists(bak):
            shutil.copy2(f, bak)
    write(SPARE, SPARE_SRC)

    # ---- queue.py：移档时保留被拦条目 ----
    patch(QUEUE, [(
        "    def archive_old(self, max_age: float, archive_path: str) -> int:",
        "    def archive_old(self, max_age: float, archive_path: str, keep_predicate=None) -> int:",
    ), (
        "        for it in self.items:\n            (old if now - float(it.get(\"at\") or 0) > max_age else keep).append(it)",
        "        for it in self.items:\n            expired = now - float(it.get(\"at\") or 0) > max_age\n            if expired and keep_predicate is not None and keep_predicate(it):\n                expired = False\n            (old if expired else keep).append(it)",
    )])

    # ---- main.py ----
    patch(MAIN, [(
        "from . import bili_export\n",
        "from . import bili_export\nfrom .core import ocr, spare\n",
    ), (
        '    "image_phash_threshold": 5,\n',
        '    "image_phash_threshold": 5,\n'
        '    "spare_trigger_enabled": True,\n'
        '    "spare_trigger_max": 8,\n'
        '    "spare_trigger_cooldown_seconds": 30,\n'
        '    "spare_blocked_skip_normal": True,\n'
        '    "spare_blocked_log": "/Volumes/980/xuhuan mac/xuhbot/src/data/bili-blocked-images.json",\n',
    ), (
        "        self._lane_busy = set()\n",
        "        self._lane_busy = set()\n"
        "        self._spare_busy = set()\n"
        "        self._spare_last = {}\n"
        "        self._spare_cache = (0.0, None)\n"
        "        self._spare_ocr_checked = False\n"
        "        self._spare_ocr_ok = True\n",
    ), (
        "        self._mark_activity(gid)\n        in_source = gid in sources\n",
        "        self._mark_activity(gid)\n"
        "        try:\n"
        '            if self._bool("spare_trigger_enabled", True) and self._spare_should(gid):\n'
        '                _txt = str(getattr(event, "message_str", "") or getattr(mo, "message_str", "") or "")\n'
        "                if not _txt:\n"
        '                    _raw_segs = raw.get("message") if isinstance(raw.get("message"), list) else []\n'
        '                    _txt = "".join(str((x.get("data") or {}).get("text") or "") for x in _raw_segs\n'
        '                                   if isinstance(x, dict) and x.get("type") == "text")\n'
        "                if spare.match_request(_txt):\n"
        "                    self._spawn(self._spare_respond(gid))\n"
        "        except Exception as e:\n"
        '            logger.debug(f"[半自动化搬屎] 点图触发异常：{e}")\n'
        "        in_source = gid in sources\n",
    ), (
        "    def _next_entry_for(self, gid, now):\n"
        '        """该群最早的、可发的一条（消息 x 群）。群与群之间不排同一个队。"""\n'
        "        gid = str(gid)\n"
        "        for entry in self.queue.ordered():\n"
        "            for mid in self._entry_ids(entry):\n"
        "                if self._fix_sent(mid, gid):\n",
        "    def _blocked_map(self):\n"
        '        """B站筛掉的图：mid -> {imageMd5, path, at, kind}；按文件 mtime 缓存。"""\n'
        '        path = str(self._get("spare_blocked_log") or "")\n'
        "        if not path:\n"
        "            return {}\n"
        "        try:\n"
        "            mtime = os.path.getmtime(path)\n"
        "        except OSError:\n"
        "            return {}\n"
        "        at, data = self._spare_cache\n"
        "        if at == mtime and data is not None:\n"
        "            return data\n"
        "        data = spare.load_blocked(path)\n"
        "        self._spare_cache = (mtime, data)\n"
        "        return data\n"
        "\n"
        "    def _spare_should(self, gid):\n"
        '        cd = max(0, self._int("spare_trigger_cooldown_seconds", 30))\n'
        "        return time.time() - float(self._spare_last.get(str(gid)) or 0) >= cd\n"
        "\n"
        "    @staticmethod\n"
        "    def _seg_local_path(seg):\n"
        '        data = seg.get("data") if isinstance(seg, dict) else None\n'
        "        if not isinstance(data, dict):\n"
        '            return ""\n'
        '        for k in ("file", "path"):\n'
        '            v = str(data.get(k) or "")\n'
        '            if v.startswith("file://"):\n'
        "                v = v[7:]\n"
        "            if v and os.path.isfile(v):\n"
        "                return v\n"
        '        return ""\n'
        "\n"
        "    async def _spare_send(self, bot, gid, segs):\n"
        "        from .core.sender import Sender\n"
        '        for mode in ("b64", "path", "keep"):\n'
        "            try:\n"
        "                body = Sender._clean(segs, mode)\n"
        "            except Exception:\n"
        "                body = []\n"
        "            if not body:\n"
        "                continue\n"
        "            try:\n"
        '                await bot.api.call_action("send_group_msg", group_id=int(gid), message=body)\n'
        "                return True\n"
        "            except Exception as e:\n"
        '                logger.debug(f"[半自动化搬屎] 点图发送 {mode} 失败：{e}")\n'
        "        return False\n"
        "\n"
        "    async def _spare_respond(self, gid):\n"
        '        """关键词点图：把池子里被 B站筛掉的纯图按老到新发出去（快速清池子）。"""\n'
        "        gid = str(gid)\n"
        "        if gid in self._spare_busy:\n"
        "            return\n"
        "        self._spare_busy.add(gid)\n"
        "        try:\n"
        "            blocked = self._blocked_map()\n"
        "            if not blocked:\n"
        "                return\n"
        "            bot = self._bot\n"
        "            if bot is None:\n"
        "                return\n"
        "            if not self._spare_ocr_checked:\n"
        "                self._spare_ocr_checked = True\n"
        "                try:\n"
        "                    self._spare_ocr_ok = ocr._load_engine() is not None\n"
        "                except Exception:\n"
        "                    self._spare_ocr_ok = False\n"
        "            if not self._spare_ocr_ok:\n"
        '                logger.warning("[半自动化搬屎] 点图：OCR 不可用，无法排除含字图，本次不发")\n'
        "                return\n"
        '            limit = max(1, self._int("spare_trigger_max", 8))\n'
        "            cands = spare.pick(\n"
        "                list(self.queue.items), blocked, gid,\n"
        "                self._fix_sent, self._entry_ids, self._entry_segs, limit,\n"
        "            )\n"
        "            if not cands:\n"
        '                logger.info(f"[半自动化搬屎] 点图：群 {gid} 池子里没有被拦的纯图")\n'
        "                return\n"
        "            sent = 0\n"
        "            for entry, mid, segs in cands:\n"
        "                use = []\n"
        "                for s in spare.image_segs(segs):\n"
        "                    p = self._seg_local_path(s)\n"
        "                    if not p:\n"
        "                        continue\n"
        "                    try:\n"
        '                        with open(p, "rb") as f:\n'
        "                            txt = await ocr.image_text(f.read())\n"
        "                    except Exception:\n"
        "                        txt = None\n"
        "                    if txt:\n"
        "                        continue\n"
        "                    use.append(s)\n"
        "                if not use:\n"
        '                    p = str((blocked.get(mid) or {}).get("path") or "")\n'
        "                    if p and os.path.isfile(p):\n"
        '                        use = [{"type": "image", "data": {"file": "file://" + p}}]\n'
        "                if not use:\n"
        "                    continue\n"
        "                if not await self._spare_send(bot, gid, use):\n"
        "                    continue\n"
        "                try:\n"
        "                    self.archive.mark_sent(mid, gid)\n"
        "                except Exception:\n"
        "                    pass\n"
        "                self._sent_cache.setdefault(mid, set()).add(gid)\n"
        "                self._mark_activity(gid)\n"
        '                self._stats["forwarded"] += 1\n'
        '                self._stats["last"] = time.strftime("%H:%M:%S")\n'
        "                sent += 1\n"
        "                if self._entry_done(entry):\n"
        "                    self.queue.remove(entry)\n"
        "                await asyncio.sleep(1)\n"
        "            if sent:\n"
        "                self._spare_last[gid] = time.time()\n"
        "                self.queue.save(force=True)\n"
        '                logger.info(f"[半自动化搬屎] 点图：群 {gid} 发了 {sent} 条被拦纯图")\n'
        "        except Exception as e:\n"
        '            logger.warning(f"[半自动化搬屎] 点图失败：{e}")\n'
        "        finally:\n"
        "            self._spare_busy.discard(gid)\n"
        "\n"
        "    def _next_entry_for(self, gid, now):\n"
        '        """该群最早的、可发的一条（消息 x 群）。群与群之间不排同一个队。"""\n'
        "        gid = str(gid)\n"
        '        blocked = self._blocked_map() if self._bool("spare_blocked_skip_normal", True) else {}\n'
        '        for entry in sorted(self.queue.items, key=lambda x: float(x.get("at") or 0)):\n'
        "            for mid in self._entry_ids(entry):\n"
        "                if mid in blocked:\n"
        "                    continue\n"
        "                if self._fix_sent(mid, gid):\n",
    ), (
        "            moved = self.queue.archive_old(\n"
        "                minutes * 60, os.path.join(DATA_DIR, \"queue_archive.jsonl\")\n"
        "            )\n",
        "            _blocked = self._blocked_map()\n"
        "            _keep = (lambda it: any(m in _blocked for m in self._entry_ids(it))) if _blocked else None\n"
        "            moved = self.queue.archive_old(\n"
        "                minutes * 60, os.path.join(DATA_DIR, \"queue_archive.jsonl\"), keep_predicate=_keep\n"
        "            )\n",
    )])

    # ---- schema ----
    patch(SCHEMA, [(
        '  "queue_max_age_minutes": {\n',
        '  "spare_trigger_enabled": {\n    "type": "bool",\n    "default": true,\n    "description": "关键词点图：群里有人发「来点/发点/看看 + 涩图/色图/瑟瑟」时，把池子里被 B站筛掉的纯图发出去"\n  },\n'
        '  "spare_trigger_max": {\n    "type": "int",\n    "default": 8,\n    "description": "关键词点图一次最多发几条（队列条目）"\n  },\n'
        '  "spare_trigger_cooldown_seconds": {\n    "type": "int",\n    "default": 30,\n    "description": "同一个群两次关键词点图的最小间隔（秒）"\n  },\n'
        '  "spare_blocked_skip_normal": {\n    "type": "bool",\n    "default": true,\n    "description": "被 B站筛掉的图不参与正常搬屎转发，只留给关键词点图"\n  },\n'
        '  "spare_blocked_log": {\n    "type": "string",\n    "default": "/Volumes/980/xuhuan mac/xuhbot/src/data/bili-blocked-images.json",\n    "description": "xuhbot 写的被筛图台账路径（本插件只读）"\n  },\n'
        '  "queue_max_age_minutes": {\n',
    )])

    # ---- panel ----
    patch(PANEL, [(
        "    var c2b = el('div', 'card');\n",
        "    var c2c = el('div', 'card');\n"
        "    c2c.appendChild(el('h2', '', 'B站筛掉的图（群关键词点图）'));\n"
        "    var sw3 = el('div', 'switches');\n"
        "    sw3.appendChild(switchRow('spare_trigger_enabled', '关键词点图', '群里有人发「来点涩图 / 发点色图 / 看看瑟瑟」时，把池子里被 B站筛掉的纯图发出去（每次最多 N 条）。', cfg.spare_trigger_enabled));\n"
        "    sw3.appendChild(switchRow('spare_blocked_skip_normal', '被拦图不参与正常转发', '这些图只留给关键词点图，正常搬屎跳过。', cfg.spare_blocked_skip_normal));\n"
        "    c2c.appendChild(sw3);\n"
        "    var r2c = el('div', 'row');\n"
        "    r2c.appendChild(numRow('spare_trigger_max', '一次最多（条）', cfg.spare_trigger_max, '关键词点图一次最多发几条，默认 8。'));\n"
        "    r2c.appendChild(numRow('spare_trigger_cooldown_seconds', '点图冷却（秒）', cfg.spare_trigger_cooldown_seconds, '同一个群两次点图的最小间隔，默认 30。'));\n"
        "    c2c.appendChild(r2c);\n"
        "    c2c.appendChild(el('div', 'hint', '被筛图台账：' + (cfg.spare_blocked_log || '') + '（xuhbot 写，本插件只读）'));\n"
        "    app.appendChild(c2c);\n"
        "\n"
        "    var c2b = el('div', 'card');\n",
    )])

    py_compile.compile(MAIN, doraise=True)
    py_compile.compile(QUEUE, doraise=True)
    py_compile.compile(SPARE, doraise=True)
    print("OK patched", STAMP)


if __name__ == "__main__":
    main()
