"""outbox_runtime.py — 把 v2 按群发件箱接到插件上。

main.py 只改四处：导入、__init__ 初始化、_emit_burst 入队、末尾 bind()。
其余队列语义（清扫/发送/清理/迁移/补发/合并/拆分）全部收口在这里，
旧方法被 bind() 覆盖，避免两套队列逻辑并存。
"""
import asyncio
import os
import time

from astrbot.api import logger

from ..config import OUTBOX_FILE, QUEUE_FILE
from .archive import Archive  # noqa: F401  (显式导出，便于单测/工具)
from .migrate_v2 import migrate_v1
from .outbox import Outbox, task_key
from .sender import Sender


class _OutboxEnv:
    """插件配置 -> Outbox 所需的最小环境。"""

    def __init__(self, plugin):
        self.p = plugin

    def targets(self):
        return [str(x) for x in self.p._list("target_group_list")]

    def excludes(self):
        return [str(x) for x in self.p._list("exclude_group_list")]

    def sources(self):
        return [str(x) for x in self.p._list("source_group_list")]

    def join_at(self, gid):
        try:
            jd = self.p._load_auto_groups().get(str(gid))
            return float((jd or {}).get("at") or 0) if isinstance(jd, dict) else 0.0
        except Exception:
            return 0.0

    def max_tries(self):
        return self.p._int("max_tries", 3)

    def retry_base(self):
        return self.p._int("retry_interval_seconds", 60)

    def index_has(self, key, gid):
        try:
            return bool(self.p.index.has(str(key), str(gid)))
        except Exception:
            return False


class _LegacyQueueView:
    """只读兼容视图：点图/面板/旧辅助函数还按 entry 形态读队列。

    写入语义已收口到 outbox；remove() 只清「台账已证明发过」的任务，
    save()/flush() 转成 outbox 落盘，绝不复活 queue.json。
    """

    def __init__(self, plugin):
        self.p = plugin

    @property
    def items(self):
        p = self.p
        out = []
        for ck, c in list(p.outbox.contents.items()):
            tasks = [t for t in p.outbox.tasks.values() if str(t.get("ckey")) == str(ck)]
            pending = [t for t in tasks if t.get("state") != "paused"]
            gids = []
            for t in pending:
                if str(t.get("gid")) not in gids:
                    gids.append(str(t.get("gid")))
            mids = [str(m) for m in (c.get("mids") or [])]
            if not mids:
                continue
            out.append({
                "message_id": mids[0],
                "message_ids": mids,
                "message_key": ck,
                "source": str(c.get("source") or ""),
                "sender": str(c.get("sender") or ""),
                "at": float(c.get("at") or 0),
                "targets": {m: list(gids) for m in mids},
                "tries": max([int(t.get("tries") or 0) for t in tasks] or [0]),
            })
        return out

    def remove(self, entry):
        p = self.p
        ck = str((entry or {}).get("message_key") or "")
        if not ck:
            return
        for t in [t for t in p.outbox.tasks.values() if str(t.get("ckey")) == str(ck)]:
            if p.outbox._is_sent(t.get("platform"), t.get("gid"), ck):
                p.outbox.complete(t.get("gid"), ck, (p.outbox.content(ck) or {}).get("mids", [None])[0])
        p.outbox.audit()

    def save(self, force=False):
        self.p.outbox.save(force=force)

    def flush(self):
        self.p.outbox.flush()

    def __len__(self):
        return len(self.p.outbox.tasks)


def _segments_of(detail):
    if not isinstance(detail, dict):
        return []
    segs = detail.get("message")
    if segs is None:
        segs = (detail.get("data") or {}).get("message")
    return segs if isinstance(segs, list) else []


def _init_outbox(self):
    self.outbox = Outbox(OUTBOX_FILE, self.archive, _OutboxEnv(self))
    self.queue = _LegacyQueueView(self)
    self._inflight_lanes = set()
    migrated = False
    if not os.path.exists(OUTBOX_FILE) and os.path.exists(QUEUE_FILE):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        rep = migrate_v1(
            QUEUE_FILE, self.outbox, self.archive, _OutboxEnv(self),
            dump_path=os.path.join(os.path.dirname(QUEUE_FILE), "queue_archive.jsonl"),
            backup_path=os.path.join(os.path.dirname(QUEUE_FILE), "queue.v1-%s.json" % stamp),
        )
        migrated = True
        logger.info(
            "[半自动化搬屎] 队列升级 v2：旧条目 %s -> 内容 %s / 任务 %s；"
            "未发对 %s；合并重复 %s；跳过已发 %s；除名群 %s；新群老屎 %s；校验 %s" % (
                rep.get("v1_entries"), rep.get("distinct_keys"), rep.get("tasks_after"),
                rep.get("unsent_pairs"), rep.get("merged_dups"), rep.get("sent_skipped"),
                rep.get("removed_group"), rep.get("new_group_skipped"),
                "通过" if rep.get("ok") else "失败(%s 对丢失)" % rep.get("missing"),
            )
        )
        if not rep.get("ok"):
            raise RuntimeError("搬屎队列 v1->v2 迁移校验失败，拒绝启动，旧队列原样保留")
    _pause_removed_groups(self)
    changed = self.outbox.audit()
    if changed:
        logger.info(f"[半自动化搬屎] 发件箱自检修正 {changed} 条")
    st = self.outbox.stats()
    logger.info(
        "[半自动化搬屎] 发件箱 v2 就绪%s：内容 %s / 任务 %s（待发 %s / 卡住 %s / 暂停 %s）" % (
            "（刚迁移）" if migrated else "",
            st["contents"], st["tasks"], st["pending"], st["blocked"], st["paused"],
        )
    )


def _pause_removed_groups(self):
    env = _OutboxEnv(self)
    allowed = set(env.targets())
    joins = {}
    for gid in set(str(t.get("gid")) for t in self.outbox.tasks.values()):
        if gid not in allowed:
            self.outbox.pause_group(gid)
            continue
        if self.outbox.resume_group(gid):
            joins[gid] = env.join_at(gid)
    # 新加的群不补老屎：内容时间早于入群时间的任务保持 paused
    changed = 0
    for t in self.outbox.tasks.values():
        gid = str(t.get("gid"))
        join = env.join_at(gid)
        if not join or t.get("state") == "paused":
            continue
        c = self.outbox.content(t.get("ckey"))
        if isinstance(c, dict) and float(c.get("at") or 0) < join:
            t["state"] = "paused"
            changed += 1
    if changed:
        self.outbox.save(force=True)


def _outbox_ingest_cluster(self, fps, items, group_idx, source, at, seg_map):
    """_emit_burst 单个聚类 -> outbox.ingest。返回是否新建了任务。"""
    ids = [str(items[i].get("mid")) for i in group_idx]
    fp = fps[group_idx[0]] if group_idx and group_idx[0] < len(fps) else None
    batch = [{"mid": items[i].get("mid"), "sender": items[i].get("sender"),
              "at": items[i].get("at") or at} for i in group_idx]
    created = self.outbox.ingest(fp, batch, source)
    return created


async def _outbox_sweep(self):
    if not self._bool("enabled", True):
        return
    now = time.time()
    self._detect_period_change(now)
    for gid in [str(t) for t in self._list("target_group_list")]:
        if gid in self._lane_busy:
            continue
        if not self._quiet_ok(gid, now):
            continue
        task = self.outbox.next_for(gid, now)
        if task is None:
            continue
        k = task_key(gid, task.get("ckey"))
        if k in self._inflight_lanes:
            continue
        claim = self.outbox.claim(gid, task.get("ckey"), now)
        if claim is None:
            continue
        self._inflight_lanes.add(k)
        self._lane_busy.add(gid)

        async def _guard(t=claim, kk=k):
            try:
                await self._outbox_deliver(t)
            finally:
                self._inflight_lanes.discard(kk)

        self._spawn(_guard())


async def _outbox_deliver(self, task):
    gid = str(task.get("gid"))
    ckey = str(task.get("ckey"))
    platform = str(task.get("platform") or "qq")
    try:
        content = self.outbox.content(ckey)
        if not isinstance(content, dict):
            self.outbox.fail(gid, ckey, "内容记录缺失")
            return
        # 发前双保险：另一条链路可能已发
        try:
            if self.archive.content_sent(platform, gid, ckey):
                self.outbox.complete(gid, ckey)
                return
        except AttributeError:
            pass
        bot = self._bot
        if bot is None:
            self.outbox.fail(gid, ckey, "bot 未连接")
            return
        mids = [str(m) for m in (content.get("mids") or [])]
        sender = str(content.get("sender") or "")
        last_err = "无可发送内容"
        used = None
        for mid in mids:
            segs = self._recent_segs.get(mid)
            if not segs:
                try:
                    rec = self.archive.latest(mid)
                    if isinstance(rec, dict):
                        segs = rec.get("segs")
                except Exception:
                    segs = None
            if not segs:
                try:
                    detail = await bot.api.call_action("get_msg", message_id=int(mid))
                    segs = _segments_of(detail)
                except Exception as e:
                    last_err = f"取消息失败：{e!r}"
                    continue
            if not segs:
                last_err = "消息内容为空"
                continue
            try:
                ok, how = await asyncio.wait_for(
                    Sender(bot).forward(gid, mid, segs), timeout=45
                )
            except asyncio.TimeoutError:
                ok, how = False, "发送超时"
            except Exception as e:
                ok, how = False, str(e)
            if ok:
                used = (mid, how)
                break
            last_err = str(how)
        if used is None:
            self.outbox.fail(gid, ckey, last_err)
            self._stats["failed"] += 1
            logger.warning(f"[半自动化搬屎] {ckey[:18]} -> 群 {gid} 失败，任务保留待重试：{last_err}")
            return
        mid, how = used
        if not self.outbox.complete(gid, ckey, mid, platform):
            # 台账没写进去就不能删任务
            self.outbox.fail(gid, ckey, "已发台账写入失败")
            logger.error(f"[半自动化搬屎] {ckey[:18]} -> 群 {gid} 发成功但台账写入失败，任务已保留")
            return
        self._sent_cache.setdefault(mid, set()).add(gid)
        self._mark_activity(gid)
        self._arm_quiet(gid)
        fp = self._recent_fp.get(mid)
        if fp and fp.get("items"):
            try:
                self.index.add(fp, gid)
            except Exception:
                pass
        self._stats["forwarded"] += 1
        self._stats["last"] = time.strftime("%H:%M:%S")
        logger.info(f"[半自动化搬屎] {mid} -> 群 {gid}（{how}，内容 key {ckey[:18]}）")
    except Exception as e:
        logger.warning(f"[半自动化搬屎] {ckey[:18]} -> 群 {gid} 发送异常：{e}")
        try:
            self.outbox.release(gid, ckey)
        except Exception:
            pass
    finally:
        self._lane_busy.discard(gid)


async def _outbox_prune(self):
    """只压缩已发任务；未发任务绝不按年龄移档、绝不删除。"""
    if self._pruning:
        return
    self._pruning = True
    try:
        n = self.outbox.audit()
        if n:
            logger.info(f"[半自动化搬屎] 发件箱清理：已发/除名修正 {n} 条（未发一条未动）")
        # 内容体回收：该内容对当前所有目标群都已发，才移除内容记录（媒体/原文仍在 archive）
        env = _OutboxEnv(self)
        targets = [g for g in env.targets()]
        removed = 0
        for ck, c in list(self.outbox.contents.items()):
            mids = [str(m) for m in (c.get("mids") or [])]
            if not mids:
                self.outbox.contents.pop(ck, None)
                removed += 1
                continue
            if any(str(t.get("ckey")) == str(ck) for t in self.outbox.tasks.values()):
                continue
            need = False
            for gid in targets:
                if gid == str(c.get("source")):
                    continue
                join = env.join_at(gid)
                if join and float(c.get("at") or 0) < join:
                    continue
                if not self.outbox._is_sent(c.get("platform"), gid, ck):
                    need = True
                    break
            if not need:
                self.outbox.contents.pop(ck, None)
                removed += 1
        if removed:
            self.outbox.save(force=True)
        st = self.outbox.stats()
        logger.info(
            f"[半自动化搬屎] 发件箱：待发 {st['pending']} / 卡住 {st['blocked']} / 暂停 {st['paused']}"
        )
    finally:
        self._pruning = False


def _outbox_group_summary(self):
    out = []
    now = time.time()
    for gid in [str(t) for t in self._list("target_group_list")]:
        span = self._locked_seconds(now, gid)
        left = max(0, span - (now - float(self._last_activity.get(gid) or 0)))
        out.append({
            "gid": gid,
            "pending": self.outbox.group_pending(gid),
            "fails": self.outbox.group_max_fails(gid),
            "blocked": self.outbox.group_blocked(gid),
            "next_ok_in": int(left),
        })
    return out


def _cleanup_queue_membership(self):
    """名单变更：除名群暂停（不删），加回且未发恢复；再跑一次自检。"""
    try:
        _pause_removed_groups(self)
        n = self.outbox.audit()
        st = self.outbox.stats()
        logger.info(
            f"[半自动化搬屎] 名单同步：自检修正 {n}；待发 {st['pending']} / 卡住 {st['blocked']} / 暂停 {st['paused']}"
        )
        try:
            allowed = set(str(x) for x in self._list("target_group_list"))
            keep_extra = set(str(x) for x in self._list("source_group_list"))
            changed = [g for g in self._last_activity
                       if str(g) not in allowed and str(g) not in keep_extra]
            if changed:
                for g in changed:
                    self._last_activity.pop(g, None)
                self._activity_dirty = True
                self._flush_activity()
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"[半自动化搬屎] 名单同步失败（不影响发送）：{e}")


async def _split_stale_bursts(self, bot):
    """连发聚类当时没拆开的，按指纹重新拆分内容。只动未尝试过的内容。"""
    changed = 0
    for ck, c in list(self.outbox.contents.items()):
        mids = [str(m) for m in (c.get("mids") or [])]
        if len(mids) <= 1:
            continue
        if any(str(t.get("ckey")) == str(ck) and int(t.get("tries") or 0) for t in self.outbox.tasks.values()):
            continue
        fps = []
        for mid in mids:
            fp = self._recent_fp.get(mid)
            if fp is None:
                rec = self.archive.latest(mid)
                segs = (rec or {}).get("segs") or []
                if segs:
                    try:
                        fp = await self._fingerprint(segs)
                    except Exception:
                        fp = None
            fps.append(fp)
        try:
            groups = _cluster(self, fps, len(mids))
        except Exception:
            continue
        if len(groups) <= 1:
            continue
        self.outbox.split_content(ck, [[mids[i] for i in g] for g in groups])
        changed += 1
    if changed:
        logger.info(f"[半自动化搬屎] 拆分合并内容 {changed} 份（未发任务不丢）")


async def _merge_adjacent_images(self, bot):
    """相邻单图（同源、15 秒内、都没试过）合并成一条连发。"""
    try:
        mine = []
        for ck, c in self.outbox.contents.items():
            if str(c.get("kind")) != "image":
                continue
            mids = [str(m) for m in (c.get("mids") or [])]
            if len(mids) != 1:
                continue
            tasks = [t for t in self.outbox.tasks.values() if str(t.get("ckey")) == str(ck)]
            if not tasks or any(int(t.get("tries") or 0) for t in tasks):
                continue
            mine.append((float(c.get("at") or 0), str(c.get("source")), ck))
        mine.sort()
        groups, cur = [], []
        for at, src, ck in mine:
            if cur and (cur[-1][1] != src or at - cur[-1][0] > 15):
                groups.append(cur)
                cur = []
            cur.append((at, src, ck))
        if cur:
            groups.append(cur)
        merged = 0
        for g in groups:
            if len(g) < 2:
                continue
            keys = [x[2] for x in g]
            before = len(self.outbox.tasks)
            self.outbox.merge_contents(keys)
            if len(self.outbox.tasks) <= before:
                merged += 1
        if merged:
            logger.info(f"[半自动化搬屎] 相邻图片合并 {merged} 组（任务已按群合并，未发不丢）")
    except Exception as e:
        logger.warning(f"[半自动化搬屎] 相邻图片合并失败：{e}")


def _cluster(self, fps, n):
    from .burst import cluster
    return cluster(
        fps,
        self._int("burst_max_messages", 8),
        self._int("image_phash_threshold", 5),
        self._int("text_keyword_hits", 3),
        self._float("forward_similar_ratio", 0.8),
        [""] * n,
    )


async def _heal_queue_from_history(self):
    """离线漏收：拉源群最近历史，把没进发件箱的内容补进来（已发对由台账挡住）。"""
    bot = self._bot
    if bot is None or self._heal_done:
        return
    self._heal_done = True
    count = max(0, self._int("backfill_count", 100))
    if count <= 0:
        return
    total = 0
    for gid in [str(x) for x in self._list("source_group_list")]:
        try:
            resp = await bot.api.call_action(
                "get_group_msg_history", group_id=int(gid), count=count
            )
            msgs = resp.get("messages") if isinstance(resp, dict) else []
            msgs = msgs or ((resp or {}).get("data") or {}).get("messages") or []
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 补收群 {gid} 历史失败：{e}")
            continue
        for m in msgs:
            segs = _segments_of(m)
            mid = str(m.get("message_id") or "")
            if not mid or not segs:
                continue
            if any(mid in (c.get("mids") or []) for c in self.outbox.contents.values()):
                continue
            try:
                fp = await self._fingerprint_local(segs)
                batch = [{"mid": mid, "sender": "", "at": float(m.get("time") or time.time())}]
                if self.outbox.ingest(fp, batch, gid):
                    total += 1
            except Exception:
                continue
    if total:
        logger.info(f"[半自动化搬屎] 历史补收：新增 {total} 份内容（已发对自动跳过）")


async def _fingerprint_local(self, segs):
    from .fingerprint import message_fingerprint
    return await message_fingerprint(
        self._bot, segs, self._int("media_hash_max_mb", 100),
        with_text=self._bool("image_ocr_dedupe", True),
    )


async def _reconcile_archive(self):
    """归档里收到过但队列里缺的，补成任务（只补未发对）。"""
    if not self._bool("enabled", True):
        return
    env = _OutboxEnv(self)
    sources = set(env.sources())
    added = 0
    try:
        recs = self.archive.load(since=time.time() - 7 * 86400)
    except Exception as e:
        logger.debug(f"[半自动化搬屎] 归档对账读取失败：{e}")
        return
    for mid, rec in list(recs.items()):
        if not isinstance(rec, dict) or str(rec.get("source")) not in sources:
            continue
        source = str(rec.get("source"))
        at = float(rec.get("at") or 0)
        for gid in env.targets():
            if gid == source:
                continue
            join = env.join_at(gid)
            if join and at < join:
                continue
            ckey = self.outbox.resolve_ckey(
                {"message_key": str(rec.get("key") or rec.get("message_key") or "")}, [str(mid)])
            if not ckey:
                continue
            if self.outbox._is_sent("qq", gid, ckey):
                continue
            if self.outbox.ensure_from_archive(
                ckey, gid, source,
                str(rec.get("sender") or ""), at, [str(mid)],
            ):
                added += 1
    if added:
        logger.info(f"[半自动化搬屎] 归档对账：补入 {added} 个未发对")


async def _recover_from_backup(self, job=None):
    """v2 恢复：把 v1 队列（现存的 queue.json）再搬一遍，幂等补漏。"""
    if not os.path.exists(QUEUE_FILE):
        return
    rep = migrate_v1(
        QUEUE_FILE, self.outbox, self.archive, _OutboxEnv(self),
        dump_path=None, backup_path=None,
    )
    logger.info(
        "[半自动化搬屎] v1 补漏：未发对 %s，任务 %s，校验 %s" % (
            rep.get("unsent_pairs"), rep.get("tasks_after"),
            "通过" if rep.get("ok") else "失败",
        )
    )


def bind(cls):
    """main.py 末尾调用：用 v2 实现覆盖旧队列方法。"""
    cls._init_outbox = _init_outbox
    cls._outbox_ingest_cluster = _outbox_ingest_cluster
    cls._outbox_sweep = _outbox_sweep
    cls._outbox_deliver = _outbox_deliver
    cls._outbox_prune = _outbox_prune
    cls._outbox_group_summary = _outbox_group_summary
    cls._outbox_cleanup_membership = _cleanup_queue_membership
    cls._sweep = _outbox_sweep
    cls._prune_queue = _outbox_prune
    cls._group_summary = _outbox_group_summary
    cls._cleanup_queue_membership = _cleanup_queue_membership
    cls._split_stale_bursts = _split_stale_bursts
    cls._merge_adjacent_images = _merge_adjacent_images
    cls._do_merge_adjacent_images = _merge_adjacent_images
    cls._heal_queue_from_history = _heal_queue_from_history
    cls._reconcile_archive = _reconcile_archive
    cls._recover_from_backup = _recover_from_backup
    cls._migrate_queue = lambda self: None
    cls._backfill_sent_keys = lambda self: None
