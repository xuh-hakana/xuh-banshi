import asyncio
import json
import os
import re
import sqlite3
import time
import traceback

from astrbot.api import logger
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.core.star.filter.platform_adapter_type import PlatformAdapterType
from quart import jsonify, request

from .config import AUTO_GROUPS_FILE, BURST_FILE, DATA_DIR, INDEX_FILE, QUEUE_FILE, QUIET_FILE, QUIET_HISTORY_FILE, QUIET_STATE_FILE, REQUEUE_FILE
from . import bili_export
from .core import ocr, spare
from .core.burst import cluster
from .core.fingerprint import (
    SeenIndex,
    message_fingerprint,
    palette_corr,
    set_image_params,
    set_ui_shot_params,
)
from .core.textsim import keyword_hits
from .core.archive import Archive
from .core.queue import QueueStore
from .core.quiet import (
    load_activity, quiet_seconds, save_activity, in_night,
    load_history, save_history, dynamic_gap_seconds,
)
from .core.sender import Sender

DEFAULTS = {
    "enabled": True,
    "source_group_list": ["1087876498"],
    "target_group_list": [
        "858455686", "894917172", "572562214",
        "143620228", "1067322036", "713848930",
    ],
    "exclude_group_list": [],
    "quiet_minutes": 20,
    "night_quiet_minutes": 60,
    "night_start_hour": 23,
    "night_end_hour": 9,
    # 动态静默（主人 2026-11-24 令）：开则按目标群群友相邻回复间隔算静默，关则用上面的固定档
    "dynamic_quiet": True,
    "dynamic_window_minutes": 20,      # 白天观察窗口（分钟）：历史 20 分钟
    "dynamic_min_gap_minutes": 2,      # 白天只取"大于 2 分钟"的回复间隔
    "dynamic_cap_minutes": 20,         # 白天算出的静默封顶 20 分钟（超过依旧 20）
    "dynamic_night_window_minutes": 180,   # 夜间观察窗口：前 3 小时
    "dynamic_night_min_gap_minutes": 60,   # 夜间只取"大于 1 小时"的回复间隔
    "dynamic_night_cap_minutes": 180,      # 夜间封顶 3 小时
    "dynamic_history_keep_hours": 6,       # history 只留最近 6 小时，够夜间 3 小时窗口用
    "retry_interval_seconds": 60,
    "burst_window_seconds": 5,
    "burst_max_messages": 8,
    "text_keyword_hits": 3,
    "forward_similar_ratio": 0.8,
    "image_mono_sat": 0.03,
    "image_palette_corr": 0.90,
    "image_ui_shot_min_boxes": 12,
    "image_ui_shot_max_medh": 0.03,
    "image_ui_shot_max_maxh": 0.06,
    "block_source_messages": True,
    "allowed_message_types": ["text", "image", "video", "forward"],
    "dedupe_enabled": True,
    "image_ocr_dedupe": True,
    "image_phash_threshold": 5,
    "spare_trigger_enabled": True,
    "spare_trigger_max": 8,
    "spare_trigger_cooldown_seconds": 30,
    "spare_blocked_last": True,
    "spare_blocked_log": "./src/data/bili-blocked-images.json",
    "media_hash_max_mb": 100,
    "backfill_count": 100,
    "index_ttl_days": 30,
    "auto_join_invites": True,
    "auto_target_new_groups": True,
    "notify_qq_list": [],
    "queue_max_age_minutes": 120,
    "max_tries": 3,
    "bili_export_enabled": True,
    "bili_export_dir": "./src/data/bili-dynamic-inbox",
    "bili_export_backlog": True,
}

PANEL_KEYS = tuple(DEFAULTS.keys())

TYPE_MAP = {
    "plain": "text", "text": "text",
    "image": "image", "video": "video",
    "forward": "forward", "node": "forward", "nodes": "forward",
}


def _segments_of(detail) -> list:
    if not isinstance(detail, dict):
        return []
    segs = detail.get("message")
    if segs is None:
        segs = (detail.get("data") or {}).get("message")
    return segs if isinstance(segs, list) else []


@register("astrbot_plugin_banshi_auto", "xuhuan", "半自动化搬屎", "1.0.0")
class BanshiAuto(Star):
    def __init__(self, context: Context, config: dict = None):
        super().__init__(context)
        self.config = config if isinstance(config, dict) else {}
        self._bot = None
        self._loop_task = None
        self._backfill_task = None
        self._bg_tasks = set()
        self._last_activity = {}
        self._activity_saved_at = 0.0
        self._activity_dirty = False
        # 动态静默：每目标群最近的群友发言时间戳（已排除虚幻），落盘重启不丢
        self._quiet_history = {}
        self._history_dirty = False
        self._history_saved_at = 0.0
        self._self_ids = set()          # 本QQ号（虚幻）；用于排除自己的发言
        self._quiet_locked = {}         # gid -> 发屎时锁定的下一次静默秒数（落盘重启不丢）
        self._period = None             # 当前昼夜档，用于检测切换
        self._force_send = set()        # 晚切早时置入，允许立即发一张
        self._backfill_done = False
        self._pruning = False
        self._sending = False
        self._prune_task = None
        self._notify_last = {}
        self._recent_segs = {}
        self._burst_buf = {}
        self._burst_tasks = {}
        self._recent_fp = {}
        self._stats = {"forwarded": 0, "skipped": 0, "failed": 0, "last": ""}
        self._burst_last = []
        self._requeue_task = None
        self._merge_task = None       # 相邻图合并任务：以前跟 _requeue_task 共用一个字段，退出时漏 cancel
        self._lane_busy = set()
        self._spare_busy = set()
        self._spare_last = {}
        self._spare_cache = (0.0, None)
        self._spare_ocr_checked = False
        self._spare_ocr_ok = True
        self._queue_lock = asyncio.Lock()
        self._sent_cache = {}
        self.archive = Archive(DATA_DIR)
        self._recover_task = None
        self._recover_done = False
        self._heal_done = False
        self.index = SeenIndex(INDEX_FILE, self._int("index_ttl_days", 30))
        self._load_quiet()
        # v2 发件箱：按 (平台, 目标群, 内容key) 唯一；v1 队列迁移在这里一次性完成
        self._init_outbox()
        self._register_panel_apis()
        self._apply()
        logger.info("[半自动化搬屎] 插件初始化")

    def _get(self, key):
        if key in self.config:
            return self.config.get(key)
        return DEFAULTS.get(key)

    def _int(self, key, default):
        v = self._get(key)
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    def _bool(self, key, default):
        v = self._get(key)
        if v is None:
            return default
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes", "on", "是")
        return bool(v)

    def _list(self, key):
        v = self._get(key)
        if isinstance(v, str):
            parts = re.split(r"[\s,，、]+", v)
        elif isinstance(v, (list, tuple, set)):
            parts = list(v)
        else:
            parts = []
        return [str(x).strip() for x in parts if str(x).strip()]

    def _float(self, key, default):
        try:
            return float(self._get(key))
        except (TypeError, ValueError):
            return default

    def _apply(self):
        self.index.ttl = max(1, self._int("index_ttl_days", 30)) * 86400
        set_image_params(
            self._float("image_mono_sat", 0.03),
            self._float("image_palette_corr", 0.90),
        )
        set_ui_shot_params(
            self._int("image_ui_shot_min_boxes", 12),
            self._float("image_ui_shot_max_medh", 0.03),
            self._float("image_ui_shot_max_maxh", 0.06),
        )

    def _migrate_queue(self):
        """老队列升级：pending/failed/tries -> targets/lanes，只加字段、不删条目。"""
        changed = False
        for entry in self.queue.items:
            if not isinstance(entry.get("lanes"), dict):
                entry["lanes"] = {}
                changed = True
            if not isinstance(entry.get("targets"), dict):
                pre = entry.get("pending")
                if isinstance(pre, list) and pre:
                    entry["targets"] = {
                        str(m): [str(t) for t in pre] for m in self._entry_ids(entry)
                    }
                else:
                    entry["targets"] = {}
                changed = True
            failed = entry.get("failed")
            if isinstance(failed, list):
                ts = float(entry.get("next_try") or entry.get("at") or 0)
                tries = int(entry.get("tries") or 0)
                for item in failed:
                    if not isinstance(item, dict):
                        continue
                    tg = [str(t) for t in (item.get("targets") or [])]
                    if not tg:
                        tg = [str(t) for t in (entry.get("pending") or [])]
                    err = str(item.get("error") or entry.get("last_error") or "")
                    quiet_only = "静默未满" in err
                    for t in tg:
                        lane = self._lane(entry, item.get("mid") or entry.get("message_id"), t)
                        if quiet_only:
                            # 静默未满不是失败：老版本记成失败，迁移时清零，别把惩罚带进新通道
                            lane["fails"] = 0
                            lane["next_try"] = 0.0
                        else:
                            lane["fails"] = max(int(lane.get("fails") or 0), tries)
                            lane["next_try"] = max(float(lane.get("next_try") or 0), ts)
                        lane["last_error"] = err
                entry.pop("failed", None)
                changed = True
            # 新通道里也可能残留老版本记下的「静默未满」假失败
            lanes = entry.get("lanes")
            if isinstance(lanes, dict):
                for lane in lanes.values():
                    if not isinstance(lane, dict):
                        continue
                    if "静默未满" in str(lane.get("last_error") or ""):
                        if lane.get("fails") or lane.get("next_try"):
                            lane["fails"] = 0
                            lane["next_try"] = 0.0
                            changed = True
            if "pending" in entry:
                entry.pop("pending", None)
                changed = True
        if changed:
            self.queue.save()
            logger.info("[半自动化搬屎] 队列已升级为按群通道（targets/lanes）")

    def _backfill_sent_keys(self):
        """补记内容 key 台账（主人 2026-11-24 令）。
        历史 sent.jsonl 只按 mid 记，key: 记录几乎没有，导致「同内容换 mid」这道闸失效。
        启动时扫队列：每条 entry 有 message_key 且它的某个 mid 已在某群发过 → 给该群补 key:。
        只补不发、不改队列、不删任何数据。"""
        try:
            sent = self.archive._load_sent()
            added = 0
            for entry in list(self.queue.items):
                key = str((entry or {}).get("message_key") or "")
                if not key:
                    continue
                for mid in self._entry_ids(entry):
                    tgs = sent.get(str(mid)) or set()
                    for gid in tgs:
                        k = "key:" + key
                        if str(gid) not in (sent.get(k) or set()):
                            try:
                                self.archive.mark_content_sent(key, str(gid), force=True)
                                sent.setdefault(k, set()).add(str(gid))
                                added += 1
                            except Exception:
                                pass
            if added:
                logger.info(f"[半自动化搬屎] 已发内容 key 补记 {added} 条")
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 补记内容 key 失败：{e}")

    def _cleanup_queue_membership(self):
        """列队清理（主人 2026-11-24 令）：只删『不该再发给某群』的队列条目，指纹库(seen_index/archive)一个字不动。

        删除口径（四选一命中即从该群的 targets/lanes 移除）：
          - 除名群：不在当前 target_group_list 的群（如 143620228）——连 quiet 一起清；
          - 已发重复：该 (mid, gid) 在 sent 台账命中（群里的都已发过）——列队里不再留；
          - 新群老屎：群在 auto_groups.json 有加入时间 at，早于 at 入队的屎不发给它；
          - 本号自己发的：sender 等于虚幻本号（selfQQ），实测队列里 0 条，识别不到就不删，绝不误删群友的屎。

        纯内存改 self.queue.items，再 force 落盘；幂等，启动和面板保存名单时各跑一次。
        某条的所有 mid 都没目标群了才整条删除；seg/fingerprint 数据保留在 archive，不丢。
        """
        try:
            allowed = set(str(x) for x in self._list("target_group_list"))
            joins = {}
            for g, d in self._load_auto_groups().items():
                if isinstance(d, dict):
                    try: joins[str(g)] = float(d.get("at") or 0)
                    except (TypeError, ValueError): pass
            self_ids = set(str(x) for x in (self._self_ids or set()))
            try:
                cj = "./src/config/connect.json"
                with open(cj, encoding="utf-8") as f:
                    conf = json.load(f)
                for k in ("selfQQ", "botQQ"):
                    v = conf.get(k)
                    if isinstance(v, list):
                        self_ids.update(str(x) for x in v if x)
                    elif v:
                        self_ids.add(str(v))
            except Exception:
                pass
            stat = {"除名群": 0, "已发重复": 0, "新群老屎": 0, "本号发的": 0, "整条删除": 0}
            keep = []
            for entry in self.queue.items:
                if str(entry.get("sender") or "") in self_ids:
                    stat["本号发的"] += 1
                    stat["整条删除"] += 1
                    continue
                at = float(entry.get("at") or 0)
                snap = entry.get("targets")
                if not isinstance(snap, dict):
                    keep.append(entry)
                    continue
                lanes = entry.get("lanes") if isinstance(entry.get("lanes"), dict) else {}
                for mid in self._entry_ids(entry):
                    tg = snap.get(mid)
                    if not isinstance(tg, list):
                        continue
                    newtg = []
                    for g in tg:
                        g = str(g)
                        if g not in allowed:
                            stat["除名群"] += 1
                            continue
                        if self._fix_sent(mid, g):
                            stat["已发重复"] += 1
                            continue
                        if joins.get(g, 0) and at < joins[g]:
                            stat["新群老屎"] += 1
                            continue
                        newtg.append(g)
                    snap[mid] = newtg
                    prefix = str(mid) + "|"
                    for lk in list(lanes):
                        if lk.startswith(prefix) and lk.split("|", 1)[-1] not in newtg:
                            del lanes[lk]
                if lanes:
                    entry["lanes"] = lanes
                if not any(isinstance(snap.get(m), list) and snap.get(m) for m in self._entry_ids(entry)):
                    stat["整条删除"] += 1
                    continue
                keep.append(entry)
            if any(stat.values()):
                self.queue.items = keep
                self.queue.save(force=True)
                logger.info(f"[半自动化搬屎] 列队清理完成：{stat}；剩余 {len(keep)} 条（指纹库未动）")
            # quiet 计时里也别留被除名的群（走现有 _last_activity + _flush_activity 落盘）
            # 只删「真被除名」：不在目标名单、且不是源群、且不是刚加的新群(auto_groups)；
            # 否则会误删源群的静默计时（主人 2026-11-24 令修正）
            try:
                keep_extra = set(str(x) for x in self._list("source_group_list")) | set(joins.keys())
                changed = [g for g in self._last_activity
                           if str(g) not in allowed and str(g) not in keep_extra]
                if changed:
                    for g in changed:
                        self._last_activity.pop(g, None)
                    self._activity_dirty = True
                    self._flush_activity()
                    logger.info(f"[半自动化搬屎] 列队清理：quiet 去掉 {changed}")
            except Exception:
                pass
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 列队清理失败（不影响原链路）：{e}")

    def _quiet_rule(self):
        return (
            self._int("quiet_minutes", 20),
            self._int("night_quiet_minutes", 60),
            self._int("night_start_hour", 23),
            self._int("night_end_hour", 9),
        )

    def _quiet_rule_for(self, now, gid):
        """按 gid + 当前昼夜，返回 (窗口秒, 最小间隔秒, 封顶秒, 固定回退秒)。

        白天：窗口20min / 取>2min间隔 / 封顶20min / 回退固定白天档。
        夜间：窗口3h / 取>1h间隔 / 封顶3h / 回退固定夜间档。
        """
        day, night, start, end = self._quiet_rule()
        hour = int(time.localtime(now).tm_hour)
        is_night = in_night(hour, start, end)
        if is_night:
            return (
                max(1, self._int("dynamic_night_window_minutes", 180)) * 60,
                max(0, self._int("dynamic_night_min_gap_minutes", 60)) * 60,
                max(1, self._int("dynamic_night_cap_minutes", 180)) * 60,
                max(0, night) * 60,
            )
        return (
            max(1, self._int("dynamic_window_minutes", 20)) * 60,
            max(0, self._int("dynamic_min_gap_minutes", 2)) * 60,
            max(1, self._int("dynamic_cap_minutes", 20)) * 60,
            max(0, day) * 60,
        )

    def _quiet_seconds(self, now=None, gid=None) -> int:
        """计算"下一次静默秒数"（不读取锁定值）。动态开且有该群发言史时按
        "最小大间隔"算；没有样本回退固定档。发屎成功后由 _arm_quiet 调它并锁定。"""
        now = now or time.time()
        day, night, start, end = self._quiet_rule()
        if self._bool("dynamic_quiet", True) and gid is not None:
            window, min_gap, cap, fallback = self._quiet_rule_for(now, gid)
            dyn = dynamic_gap_seconds(
                self._quiet_history.get(str(gid), []), now, window, min_gap, cap
            )
            return int(dyn) if dyn is not None else int(fallback)
        return quiet_seconds(now, day, night, start, end)

    def _arm_quiet(self, gid, now=None):
        """发屎成功后调用：按当前昼夜算一次静默值并锁定为"下一次的屎时间"。"""
        if not self._bool("dynamic_quiet", True):
            return
        now = now or time.time()
        self._quiet_locked[str(gid)] = float(self._quiet_seconds(now, str(gid)))
        self._force_send.discard(str(gid))
        self._flush_locked()

    def _flush_locked(self):
        try:
            save_activity(QUIET_STATE_FILE, self._quiet_locked)
        except Exception:
            pass

    def _locked_seconds(self, now, gid):
        """当前生效的静默秒数：动态开则取发屎时锁定的值（没锁过就当场算一次);
        否则固定档。绝不在群友发言时重算，避免计数节奏被重置。"""
        gid = str(gid)
        if self._bool("dynamic_quiet", True):
            v = self._quiet_locked.get(gid)
            if v is None:
                v = float(self._quiet_seconds(now, gid))
                self._quiet_locked[gid] = v
                self._flush_locked()
            return int(v)
        day, night, start, end = self._quiet_rule()
        return quiet_seconds(now, day, night, start, end)

    def _current_period(self, now):
        """当前是 'day' 还是 'night'。"""
        day, night, start, end = self._quiet_rule()
        hour = int(time.localtime(now).tm_hour)
        return "night" if in_night(hour, start, end) else "day"

    def _detect_period_change(self, now):
        """昼夜档切换：早切晚发完这次再重置（不动锁定值）；晚切早直接发一张再重置
        （置 force_send 让它立刻可发，发完由 _arm_quiet 按白天档重锁）。"""
        if not self._bool("dynamic_quiet", True):
            return
        cur = self._current_period(now)
        prev = self._period
        self._period = cur
        if prev is None or prev == cur:
            return
        if prev == "night" and cur == "day":
            for gid in self._list("target_group_list"):
                gid = str(gid)
                self._force_send.add(gid)
                self._quiet_locked.pop(gid, None)   # 丢掉夜间锁定值，发完按白天重算
            self._flush_locked()
            logger.info("[半自动化搬屎] 晚→早切换：允许每群立即发一张后按白天档重置")
        else:
            logger.info("[半自动化搬屎] 早→晚切换：发完这次后按夜间档重置")

    def _quiet_text(self) -> str:
        day, night, start, end = self._quiet_rule()
        base = (
            f"目标群静默 白天 {max(0, day)} 分钟 / "
            f"{start % 24:02d}:00-{end % 24:02d}:00 {max(0, night)} 分钟"
        )
        if self._bool("dynamic_quiet", True):
            return (
                base + "（动态：白天取历史20min内>2min的最小回复间隔封顶20min，"
                "夜间取前3h内>1h的最小间隔；无样本回退固定档）"
            )
        return base

    def _load_quiet(self):
        """读落盘的群活跃时间；首次运行（没有任何记录）时从当前时间起步。"""
        data = load_activity(QUIET_FILE)
        if not data:
            now = time.time()
            for gid in self._list("source_group_list") + self._list("target_group_list"):
                data[str(gid)] = now
            save_activity(QUIET_FILE, data)
        self._last_activity = data
        # 动态静默的历史发言时间戳（重启不丢）
        self._quiet_history = load_history(QUIET_HISTORY_FILE)
        self._prune_history()
        # 发屎时锁定的静默值 + 当前昼夜档
        self._quiet_locked = load_activity(QUIET_STATE_FILE)
        self._period = self._current_period(time.time())

    def _prune_history(self):
        """裁掉过期的发言时间戳：只留够最长窗口（夜间3h）+ 冗余的记录。"""
        keep_h = max(1, self._int("dynamic_history_keep_hours", 6)) * 3600
        cutoff = time.time() - keep_h
        for gid in list(self._quiet_history):
            kept = [t for t in self._quiet_history.get(gid, []) if t > cutoff]
            if kept:
                self._quiet_history[gid] = kept
            else:
                self._quiet_history.pop(gid, None)
        self._history_dirty = True

    def _record_speech(self, gid, self_id, at=None):
        """记一条群友发言进历史；self_id 命中（虚幻自己）则排除，不记。"""
        if not self._bool("dynamic_quiet", True):
            return
        gid = str(gid)
        sid = str(self_id or "")
        if sid and sid in self._self_ids:
            return
        try:
            ts = float(at if at is not None else time.time())
        except (TypeError, ValueError):
            ts = time.time()
        arr = self._quiet_history.setdefault(gid, [])
        if not arr or ts > arr[-1]:
            arr.append(ts)
        self._history_dirty = True
        now = time.time()
        if now - self._history_saved_at >= 5:
            self._flush_history()

    def _flush_history(self):
        if not self._history_dirty:
            return
        try:
            save_history(QUIET_HISTORY_FILE, self._quiet_history)
            self._history_saved_at = time.time()
            self._history_dirty = False
        except Exception:
            pass

    def _mark_activity(self, gid, at=None):
        gid = str(gid)
        try:
            ts = float(at if at is not None else time.time())
        except (TypeError, ValueError):
            ts = time.time()
        if ts <= float(self._last_activity.get(gid) or 0):
            return
        self._last_activity[gid] = ts
        # 群里每条消息都重写 quiet.json 太浪费：2 秒合并一次，退出时强制写。
        self._activity_dirty = True
        now = time.time()
        if now - self._activity_saved_at >= 2:
            self._flush_activity()

    def _flush_activity(self):
        if not self._activity_dirty:
            return
        try:
            save_activity(QUIET_FILE, self._last_activity)
            self._activity_saved_at = time.time()
            self._activity_dirty = False
        except Exception:
            pass

    def _quiet_ok(self, source, now) -> bool:
        gid = str(source)
        if gid in self._force_send:
            return True
        last = float(self._last_activity.get(gid) or 0)
        return (now - last) >= self._locked_seconds(now, gid)

    def _register_panel_apis(self):
        try:
            self.context.register_web_api(
                "/astrbot_plugin_banshi_auto/banshi/config",
                self._api_get_config, ["GET"], "读取半自动化搬屎配置",
            )
            self.context.register_web_api(
                "/astrbot_plugin_banshi_auto/banshi/config",
                self._api_save_config, ["POST"], "保存半自动化搬屎配置",
            )
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 注册 Web API 失败：{e}")

    async def _api_get_config(self):
        return jsonify({
            "status": "ok",
            "config": {k: self._get(k) for k in PANEL_KEYS},
            "stats": dict(self._stats),
            "burst_last": list(self._burst_last),
            "queue_len": len(self.queue),
            "index_len": len(self.index.entries),
            "backfill_done": self._backfill_done,
            "auto_targets": self._load_auto_groups(),
            "groups": self._group_summary(),
        })

    async def _api_save_config(self):
        data = await request.get_json(silent=True) or {}
        incoming = data.get("config") if isinstance(data.get("config"), dict) else data
        if not isinstance(incoming, dict):
            return jsonify({"status": "error", "message": "请求格式不对"})
        changed = {k: incoming[k] for k in PANEL_KEYS if k in incoming}
        if isinstance(changed.get("target_group_list"), list):
            changed["target_group_list"] = [
                re.sub(r"[（(]自动[)）]\s*$", "", str(x)).strip()
                for x in changed["target_group_list"]
            ]
        if not changed:
            return jsonify({"status": "error", "message": "没有可保存的字段"})
        before_targets = set(str(x) for x in self._list("target_group_list"))
        for k, v in changed.items():
            self.config[k] = v
        save = getattr(self.config, "save_config", None)
        if callable(save):
            try:
                save()
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 配置写盘失败：{e}")
                return jsonify({"status": "error", "message": f"写盘失败：{e}"})
        # 新加/被除名后重新加回的群：记加入时间，只搬加入后的新屎（主人 2026-11-24 令）
        try:
            for g in changed.get("target_group_list", []):
                if str(g) not in before_targets:
                    self._record_auto_group(g, "panel", "")
        except Exception:
            pass
        self._apply()
        self._cleanup_queue_membership()   # 除名群当场清列队，不等重启
        logger.info(
            f"[半自动化搬屎] 面板已保存：{sorted(changed)}；静默规则：{self._quiet_text()}"
        )
        return jsonify({"status": "ok", "saved": sorted(changed)})

    def _message_types(self, event) -> set:
        out = set()
        chain = getattr(getattr(event, "message_obj", None), "message", None) or []
        try:
            for seg in chain:
                mapped = TYPE_MAP.get(type(seg).__name__.lower())
                if mapped:
                    out.add(mapped)
        except Exception:
            pass
        return out

    def _type_allowed(self, event) -> bool:
        allowed = self._list("allowed_message_types")
        if not allowed:
            return True
        found = self._message_types(event)
        if not found:
            return True
        return bool(found & set(allowed))

    @filter.platform_adapter_type(PlatformAdapterType.AIOCQHTTP, priority=100000)
    async def handle_message(self, event: AstrMessageEvent):
        if not self._bool("enabled", True):
            return
        mo = getattr(event, "message_obj", None)
        raw = getattr(mo, "raw_message", None)
        raw = raw if isinstance(raw, dict) else {}
        if raw.get("post_type") == "request":
            self._bot = getattr(event, "bot", self._bot)
            self._spawn(self._on_request(raw))
            return
        gid = str(getattr(mo, "group_id", "") or "")
        if not gid:
            self._bot = getattr(event, "bot", self._bot)
            self._spawn(self._on_private(event, raw))
            return
        self._bot = getattr(event, "bot", self._bot)
        sources = set(self._list("source_group_list"))
        targets = set(self._list("target_group_list"))
        if gid not in sources and gid not in targets:
            return
        # 动态静默采集：记下本QQ号（虚幻）+ 每个目标群的群友发言时间戳（排除虚幻自己）
        _self_id = raw.get("self_id") or getattr(event, "self_id", None) or getattr(mo, "self_id", None)
        if _self_id is not None:
            self._self_ids.add(str(_self_id))
        _sender = event.get_sender_id()
        _msg_time = float(raw.get("time") or time.time())
        self._record_speech(gid, _sender, _msg_time)
        # 动态静默：群友发言只记历史用来算间隔，不刷新静默计时（计时起点=上次发屎）。
        # 固定档模式维持原行为，避免改变旧用法。
        if not self._bool("dynamic_quiet", True):
            self._mark_activity(gid)
        try:
            if self._bool("spare_trigger_enabled", True) and self._spare_should(gid):
                _txt = str(getattr(event, "message_str", "") or getattr(mo, "message_str", "") or "")
                if not _txt:
                    _raw_segs = raw.get("message") if isinstance(raw.get("message"), list) else []
                    _txt = "".join(str((x.get("data") or {}).get("text") or "") for x in _raw_segs
                                   if isinstance(x, dict) and x.get("type") == "text")
                if spare.match_request(_txt):
                    self._spawn(self._spare_respond(gid))
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 点图触发异常：{e}")
        in_source = gid in sources
        if in_source and self._bool("block_source_messages", True):
            event.stop_event()
        mid = getattr(mo, "message_id", None)
        if mid is None:
            return
        if in_source and self._type_allowed(event):
            segs = raw.get("message")
            if not (isinstance(segs, list) and segs):
                segs = []
                for comp in (getattr(mo, "message", None) or []):
                    try:
                        segs.append(comp.toDict())
                    except Exception:
                        pass
            if isinstance(segs, list) and segs:
                mid_s = str(mid)
                self._recent_segs[mid_s] = segs
                if len(self._recent_segs) > 300:      # 与 _recent_fp 同口径：只留最近的，别无限涨
                    for _old_mid in list(self._recent_segs.keys())[: len(self._recent_segs) - 300]:
                        self._recent_segs.pop(_old_mid, None)
                sender_info = raw.get("sender") if isinstance(raw.get("sender"), dict) else {}
                self.archive.record(
                    mid_s, gid, str(event.get_sender_id()),
                    float(raw.get("time") or time.time()), segs,
                    nickname=sender_info.get("card") or sender_info.get("nickname") or "",
                    message_key=self._mid_key(mid_s),
                )
                self._spawn(self._archive_media(mid_s, segs))
            self._burst_add(gid, mid, event.get_sender_id())
        self._spawn(self._index_async(gid, mid, event.bot))

    # ===== 自动进群 / 自动进目标名单 / 私聊群号（2026-11-22） =====

    async def _on_request(self, raw):
        """群邀请请求：任何人发来的邀请都自动同意，并把新群加进目标名单。"""
        if not self._bool("auto_join_invites", True):
            return
        if str(raw.get("request_type") or "") != "group":
            return
        sub = str(raw.get("sub_type") or raw.get("type") or "")
        if sub != "invite":
            return
        flag = raw.get("flag")
        if not flag:
            return
        bot = self._bot
        if bot is None:
            return
        try:
            await bot.api.call_action(
                "set_group_add_request",
                flag=flag, sub_type=sub, type=sub, approve=True,
            )
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 自动同意群邀请失败：{e}")
            await self._notify(f"【半自动化搬屎】自动同意群邀请失败：{e}")
            return
        gid = str(raw.get("group_id") or "")
        by = str(raw.get("user_id") or "")
        logger.info(f"[半自动化搬屎] 已自动同意群邀请：群 {gid}，邀请人 {by}")
        if gid and self._bool("auto_target_new_groups", True):
            await self._auto_add_target(gid, by)

    async def _on_private(self, event, raw):
        """私聊发群号：机器人在群里就自动加进目标名单；不在就如实说做不到。"""
        bot = self._bot
        if bot is None:
            return
        mo = getattr(event, "message_obj", None)
        text = str(getattr(mo, "message_str", "") or "").strip()
        if not text:
            chain = getattr(mo, "message", None) or []
            try:
                text = "".join(
                    str(getattr(seg, "text", "") or "")
                    for seg in chain
                    if str(getattr(seg, "type", "") or "").lower() in ("plain", "text")
                ).strip()
            except Exception:
                text = ""
        if not text or len(text) > 40:
            return
        gids = re.findall(r"(?<!\d)(\d{6,12})(?!\d)", text)
        if not gids:
            return
        sender = str(event.get_sender_id() or raw.get("user_id") or "")
        in_groups = set()
        try:
            groups = await bot.api.call_action("get_group_list")
            if isinstance(groups, dict):
                groups = groups.get("data") or groups.get("groups") or []
            for g in groups or []:
                if isinstance(g, dict) and g.get("group_id") is not None:
                    in_groups.add(str(g.get("group_id")))
        except Exception:
            pass
        for gid in dict.fromkeys(gids):
            if gid in in_groups and self._bool("auto_target_new_groups", True):
                await self._auto_add_target(gid, sender)
                await self._reply_private(bot, sender, f"群 {gid} 已加进目标群名单（自动）")
            else:
                await self._reply_private(
                    bot, sender,
                    "我按群号自己加不了群。让群里的人点「邀请」发给我、或者直接把我拉进去，"
                    "我自动同意；进群后自动进目标群名单（自动）。",
                )

    async def _reply_private(self, bot, user_id, text):
        try:
            uid = int(str(user_id))
        except (TypeError, ValueError):
            return
        try:
            await bot.api.call_action("send_private_msg", user_id=uid, message=text)
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 私聊回复失败 {uid}: {e}")

    def _notify_targets(self):
        out = []
        for x in self._list("notify_qq_list"):
            if str(x).isdigit() and str(x) not in out:
                out.append(str(x))
        if not out:
            path = os.path.abspath(os.path.join(DATA_DIR, "..", "..", "..", "cmd_config.json"))
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    cfg = json.load(f)
                for x in cfg.get("admins_id") or []:
                    if str(x).isdigit() and str(x) not in out:
                        out.append(str(x))
            except (OSError, ValueError):
                pass
        return out

    async def _notify(self, text):
        bot = self._bot
        if bot is None:
            logger.info(f"[半自动化搬屎] {text}")
            return
        for qq in self._notify_targets():
            try:
                await bot.api.call_action("send_private_msg", user_id=int(qq), message=text)
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 通知主人失败 {qq}: {e}")

    def _load_auto_groups(self):
        try:
            with open(AUTO_GROUPS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _record_auto_group(self, gid, by, name):
        data = self._load_auto_groups()
        data[str(gid)] = {"at": int(time.time()), "by": str(by or ""), "name": str(name or "")}
        try:
            os.makedirs(os.path.dirname(AUTO_GROUPS_FILE), exist_ok=True)
            tmp = AUTO_GROUPS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, AUTO_GROUPS_FILE)
        except OSError:
            pass

    async def _group_name(self, gid):
        bot = self._bot
        if bot is None:
            return ""
        try:
            info = await bot.api.call_action("get_group_info", group_id=int(gid))
            if isinstance(info, dict):
                return str(info.get("group_name") or (info.get("data") or {}).get("group_name") or "")
        except Exception:
            pass
        return ""

    async def _auto_add_target(self, gid, by=""):
        gid = str(gid or "").strip()
        if not gid.isdigit():
            return
        if not self._bool("auto_target_new_groups", True):
            return
        if gid in self._list("exclude_group_list"):
            logger.info(f"[半自动化搬屎] 群 {gid} 在排除名单，自动加入目标名单时跳过")
            return
        if gid in self._list("source_group_list"):
            logger.info(f"[半自动化搬屎] 群 {gid} 是源群，不加入目标名单")
            return
        name = await self._group_name(gid)
        targets = self._list("target_group_list")
        stamp = time.time()
        if gid in targets:
            if stamp - float(self._notify_last.get(gid) or 0) > 1800:
                self._notify_last[gid] = stamp
                await self._notify(f"【半自动化搬屎】群 {gid} {name} 已在目标群名单（自动）")
            return
        targets.append(gid)
        self.config["target_group_list"] = targets
        save = getattr(self.config, "save_config", None)
        if callable(save):
            try:
                save()
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 目标名单写盘失败：{e}")
                await self._notify(f"【半自动化搬屎】群 {gid} 已加入目标群名单但写盘失败：{e}")
        self._record_auto_group(gid, by, name)
        self._mark_activity(gid, stamp)
        self._notify_last[gid] = stamp
        logger.info(f"[半自动化搬屎] 自动加入目标群名单：群 {gid} {name}（邀请人 {by}）")
        await self._notify(f"【半自动化搬屎】群 {gid} {name} 已自动加入目标群名单（自动）")

    def _forward_ratio(self) -> float:
        try:
            return float(self.config.get("forward_similar_ratio", 0.8))
        except (TypeError, ValueError):
            return 0.8

    def _save_burst(self):
        try:
            os.makedirs(os.path.dirname(BURST_FILE), exist_ok=True)
            tmp = BURST_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._burst_buf, f, ensure_ascii=False)
            os.replace(tmp, BURST_FILE)
        except OSError:
            pass

    def _load_burst(self):
        try:
            with open(BURST_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            self._burst_buf = {}
            return
        buf = {}
        if isinstance(data, dict):
            for k, v in data.items():
                items = [x for x in (v or []) if isinstance(x, dict) and x.get("mid")]
                if items:
                    buf[str(k)] = items
        self._burst_buf = buf

    def _burst_add(self, source, mid, sender):
        source = str(source)
        mid = str(mid)
        buf = self._burst_buf.setdefault(source, [])
        if any(str(it.get("mid")) == mid for it in buf):
            return
        buf.append({"mid": mid, "at": time.time(), "sender": str(sender)})
        self._save_burst()
        task = self._burst_tasks.get(source)
        if task is None or task.done():
            task = asyncio.create_task(self._burst_flush_loop(source))
            self._burst_tasks[source] = task
            task.add_done_callback(lambda _t, s=source: self._burst_tasks.pop(s, None))
        logger.info(f"[半自动化搬屎] 收到 {mid}，等连发窗口结束再按相似度合并")

    async def _burst_flush_loop(self, source):
        window = max(0, self._int("burst_window_seconds", 5))
        while True:
            buf = self._burst_buf.get(source) or []
            if not buf:
                return
            now = time.time()
            ready = [it for it in buf if now - float(it.get("at") or 0) >= window]
            if not ready:
                wait = float(buf[0].get("at") or now) + window - now
                await asyncio.sleep(max(0.5, min(wait, 5)))
                continue
            ready_ids = {str(it.get("mid")) for it in ready}
            self._burst_buf[source] = [it for it in buf if str(it.get("mid")) not in ready_ids]
            if not self._burst_buf[source]:
                self._burst_buf.pop(source, None)
            self._save_burst()
            try:
                await self._emit_burst(source, ready)
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 连发合并失败 {source}：{e}")

    async def _emit_burst(self, source, items):
        bot = self._bot
        max_mb = self._int("media_hash_max_mb", 100)
        with_text = self._bool("image_ocr_dedupe", True)
        fps = []
        for it in items:
            mid = str(it.get("mid"))
            fp = self._recent_fp.get(mid)
            if fp is None and bot is not None:
                try:
                    detail = await bot.api.call_action("get_msg", message_id=int(mid))
                    segs = _segments_of(detail)
                    if segs:
                        self._recent_segs[mid] = segs
                        fp = await message_fingerprint(
                            bot, segs, max_mb, with_text=with_text
                        )
                except Exception as e:
                    logger.debug(f"[半自动化搬屎] 连发取指纹失败 {mid}: {e}")
            fps.append(fp)
        groups = cluster(
            fps,
            self._int("burst_max_messages", 8),
            self._int("image_phash_threshold", 5),
            self._int("text_keyword_hits", 3),
            self._forward_ratio(),
            [str(it.get("sender") or "") for it in items],
        )
        shots = []
        for idx, it in enumerate(items):
            primary = (fps[idx] or {}).get("primary") or {}
            kind = primary.get("kind") or ""
            group_no = next((gi for gi, g in enumerate(groups) if idx in g), -1)
            shots.append({
                "mid": str(it.get("mid")),
                "kind": kind,
                "ui_shot": bool(primary.get("ui_shot")),
                "nbox": int(primary.get("nbox") or 0),
                "medh": primary.get("medh") or 0,
                "maxh": primary.get("maxh") or 0,
                "group": group_no,
                "hits": 0,
                "corr": 0.0,
                # 2026-11-24 修：纯文字项存 txt，旧代码只读 text 恒空 =「找不出来」；
                # 展示预览可截 60，但判定走完整 txt（见 _emit_burst 的 hits 计算）。
                "text": (primary.get("text") or primary.get("txt") or "")[:60],
            })
        for g in groups:
            if len(g) < 2:
                continue
            lead = (fps[g[0]] or {}).get("primary") or {}
            base_txt = lead.get("text") or lead.get("txt") or ""
            for idx in g[1:]:
                other = (fps[idx] or {}).get("primary") or {}
                txt = other.get("text") or other.get("txt") or ""
                if base_txt and txt:
                    shots[idx]["hits"] = keyword_hits(base_txt, txt)
                if lead.get("pal") and other.get("pal"):
                    shots[idx]["corr"] = round(palette_corr(lead.get("pal"), other.get("pal")), 3)
        sender = str(items[0].get("sender") or "") if items else ""
        added = 0
        for g in groups:
            ids = [str(items[i].get("mid")) for i in g]
            at = min(float(items[i].get("at") or time.time()) for i in g)
            seg_map = {str(items[i].get("mid")): self._recent_segs.get(str(items[i].get("mid"))) for i in g}
            entry = self._outbox_ingest_cluster(fps, items, g, source, at, seg_map)
            if self._bool("bili_export_enabled", True):
                try:
                    bili_export.export_group(self, ids, str(source), at, seg_map)
                except Exception as e:
                    logger.debug(f"[半自动化搬屎] B站导出失败 {ids}: {e}")
            if entry:
                added += 1
                tag = f"（{len(ids)} 条相似合并）" if len(ids) > 1 else ""
                logger.info(f"[半自动化搬屎] 入队 {len(ids)} 条 <- 群 {source}{tag}")
            for i in g:
                _mid = str(items[i].get("mid"))
                self._recent_fp.pop(_mid, None)
                self._recent_segs.pop(_mid, None)
        labels = []
        for g in groups:
            p = (fps[g[0]] or {}).get("primary") or {}
            k = p.get("kind")
            if k == "image":
                labels.append(f"{len(g)}x界面截图(图文)" if p.get("ui_shot")
                              else f"{len(g)}x漫画/照片")
            else:
                labels.append(f"{len(g)}x" + {"text": "文字", "video": "视频",
                                              "forward": "聊天记录"}.get(k, str(k or "未知")))
        if len(items) > 1:
            self._burst_last.append({
                "at": time.time(),
            "source": str(source),
                "total": len(items),
                "groups": len(groups),
                "labels": labels,
                "items": shots,
            })
        if len(self._burst_last) > 5:
            self._burst_last = self._burst_last[-5:]
        if not added:
            logger.info(f"[半自动化搬屎] 连发 {len(items)} 条均已在队列中，忽略")
        elif len(items) > 1:
            logger.info(
                f"[半自动化搬屎] 连发 {len(items)} 条 → {len(groups)} 条（{' / '.join(labels)}）"
            )

    def _spawn(self, coro):
        try:
            task = asyncio.create_task(coro)
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)
        except RuntimeError:
            pass

    async def _index_async(self, gid, mid, bot):
        if not self._bool("dedupe_enabled", True):
            return
        try:
            detail = await bot.api.call_action("get_msg", message_id=int(mid))
            segs = _segments_of(detail)
            if not segs:
                return
            fp = await message_fingerprint(bot, segs, self._int("media_hash_max_mb", 100), with_text=self._bool("image_ocr_dedupe", True))
            if fp.get("items"):
                self.index.add(fp, gid)
                self._recent_fp[str(mid)] = fp
                if len(self._recent_fp) > 300:
                    for k in list(self._recent_fp)[:100]:
                        self._recent_fp.pop(k, None)
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 建指纹失败 {mid}: {e}")

    def _targets_for(self, source: str, fp: dict, candidates):
        exclude = set(self._list("exclude_group_list"))
        allowed = set(self._list("target_group_list"))
        dedupe = self._bool("dedupe_enabled", True)
        threshold = self._int("image_phash_threshold", 5)
        hits = self._int("text_keyword_hits", 3)
        try:
            forward_ratio = float(self.config.get("forward_similar_ratio", 0.8))
        except (TypeError, ValueError):
            forward_ratio = 0.8
        primary = fp.get("primary") or {}
        mk = fp.get("message_key") or ""
        items = fp.get("items") or []
        has_media = any(it.get("kind") in ("image", "video", "forward") for it in items)
        texts = [it for it in items if it.get("kind") == "text" and it.get("txt")]
        out = []
        for t in candidates:
            t = str(t)
            if t == source or t in exclude:
                continue
            if t not in allowed:
                logger.info(f"[半自动化搬屎] 目标群已移除，跳过 {t}")
                continue
            if dedupe:
                hit = bool(mk and self.index.has(mk, t))
                if not hit and has_media:
                    hit = self.index.match(primary, t, threshold, hits, forward_ratio)
                if not hit and texts:
                    hit = any(
                        self.index.match(it, t, threshold, hits, forward_ratio)
                        for it in texts
                    )
                if hit:
                    self._stats["skipped"] += 1
                    logger.info(f"[半自动化搬屎] 跳过群 {t}：已有相同内容")
                    continue
            out.append(t)
        return out

    def _build_targets(self, source: str, fp: dict):
        return self._targets_for(source, fp, self._list("target_group_list"))

    def _retry_later(self, entry: dict, reason: str):
        entry["tries"] = int(entry.get("tries") or 0) + 1
        entry["last_error"] = reason
        entry["next_try"] = time.time() + max(10, self._int("retry_interval_seconds", 60))
        self.queue.save()
        logger.warning(f"[半自动化搬屎] {entry.get('message_id')} 暂缓重试：{reason}")

    def _entry_ids(self, entry) -> list:
        ids = entry.get("message_ids")
        if not isinstance(ids, list) or not ids:
            ids = [entry.get("message_id")]
        return [str(x) for x in ids if x is not None]

    # ---------- 按群发送通道：一条消息 x 一个目标群 = 一条独立节奏 ----------
    def _lane_key(self, mid, gid):
        return str(mid) + "|" + str(gid)

    def _lane(self, entry, mid, gid):
        lanes = entry.get("lanes")
        if not isinstance(lanes, dict):
            lanes = {}
            entry["lanes"] = lanes
        key = self._lane_key(mid, gid)
        lane = lanes.get(key)
        if not isinstance(lane, dict):
            lane = {"fails": 0, "next_try": 0.0, "last_error": ""}
            lanes[key] = lane
        return lane

    def _sent_hits(self, mid):
        key = str(mid)
        hit = self._sent_cache.get(key)
        if hit is None:
            try:
                hit = set(str(t) for t in self.archive.sent_targets(key))
            except Exception:
                hit = set()
            if len(self._sent_cache) > 3000:
                self._sent_cache.clear()
            self._sent_cache[key] = hit
        return hit

    def _fix_sent(self, mid, gid) -> bool:
        return str(gid) in self._sent_hits(mid)

    def _entry_key(self, entry, mid=None) -> str:
        """一条消息的内容指纹 key：同一内容换 mid 不变，用于永久去重。"""
        e = str((entry or {}).get("message_key") or "")
        if not e and mid is not None:
            fp = self._recent_fp.get(str(mid)) or {}
            e = str(fp.get("message_key") or "")
        return e

    def _already_sent(self, entry, mid, gid) -> bool:
        """mid 或内容 key 任一在该群发过 → 不再发。内容 key 挡「同内容换 mid 反复发」。"""
        gid = str(gid)
        if self._fix_sent(mid, gid):
            return True
        key = self._entry_key(entry, mid)
        return bool(key and gid in self.archive.content_sent_targets(key))

    def _mark_sent_both(self, entry, mid, gid):
        """按 mid 和按内容 key 双写已发档案，永久去重。
        2026-11-24 修：NapCat 实证同条发到同群 8 次却只记 1 次——内存缓存命中会跳过落盘，
        这里一律 force 落盘，保证「发成功必记账」，否则重启/重试会当新屎再发。"""
        mid, gid = str(mid), str(gid)
        try:
            self.archive.mark_sent(mid, gid, force=True)
        except Exception:
            pass
        key = self._entry_key(entry, mid)
        if key:
            try:
                self.archive.mark_content_sent(key, gid, force=True)
            except Exception:
                pass
        self._sent_cache.setdefault(mid, set()).add(gid)

    def _entry_segs(self, entry, mid):
        mid = str(mid)
        cached = entry.get("segs")
        if isinstance(cached, dict):
            cs = cached.get(mid)
            if isinstance(cs, list) and cs:
                return cs
        try:
            rec = self.archive.latest(mid)
        except Exception:
            rec = None
        if isinstance(rec, dict) and isinstance(rec.get("segs"), list) and rec["segs"]:
            return rec["segs"]
        return None

    async def _targets_for_mid(self, entry, mid):
        """每条消息的目标群快照：算一次落盘，之后只读（含排除/去重判定）。"""
        mid = str(mid)
        snap = entry.get("targets")
        if not isinstance(snap, dict):
            snap = {}
            entry["targets"] = snap
        if isinstance(snap.get(mid), list):
            return [str(t) for t in snap[mid]]
        bot = self._bot
        fp = self._recent_fp.get(mid)
        segs = self._entry_segs(entry, mid)
        if fp is None and segs and bot is not None:
            try:
                fp = await message_fingerprint(
                    bot, segs, self._int("media_hash_max_mb", 100),
                    with_text=self._bool("image_ocr_dedupe", True),
                )
                self._recent_fp[mid] = fp
            except Exception as e:
                logger.debug(f"[半自动化搬屎] 建指纹失败 {mid}: {e}")
        got = []
        if fp is not None:
            got = [str(t) for t in self._targets_for(
                str(entry.get("source")), fp, self._list("target_group_list"))]
            entry["message_key"] = fp.get("message_key") or entry.get("message_key")
        snap[mid] = got
        self.queue.save()
        return got

    def _blocked_map(self):
        """B站筛掉的图：mid -> {imageMd5, path, at, kind}；按文件 mtime 缓存。"""
        path = str(self._get("spare_blocked_log") or "")
        if not path:
            return {}
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return {}
        at, data = self._spare_cache
        if at == mtime and data is not None:
            return data
        data = spare.load_blocked(path)
        self._spare_cache = (mtime, data)
        return data

    def _spare_should(self, gid):
        cd = max(0, self._int("spare_trigger_cooldown_seconds", 30))
        return time.time() - float(self._spare_last.get(str(gid)) or 0) >= cd

    @staticmethod
    def _seg_local_path(seg):
        data = seg.get("data") if isinstance(seg, dict) else None
        if not isinstance(data, dict):
            return ""
        for k in ("file", "path"):
            v = str(data.get(k) or "")
            if v.startswith("file://"):
                v = v[7:]
            if v and os.path.isfile(v):
                return v
        return ""

    async def _spare_send(self, bot, gid, segs):
        from .core.sender import Sender
        for mode in ("b64", "path", "keep"):
            try:
                body = Sender._clean(segs, mode)
            except Exception:
                body = []
            if not body:
                continue
            try:
                await bot.api.call_action("send_group_msg", group_id=int(gid), message=body)
                return True
            except Exception as e:
                logger.debug(f"[半自动化搬屎] 点图发送 {mode} 失败：{e}")
        return False

    async def _spare_respond(self, gid):
        """关键词点图：把池子里被 B站筛掉的纯图按老到新发出去（快速清池子）。"""
        gid = str(gid)
        if gid in [str(t) for t in self._list("exclude_group_list")]:
            return
        if gid in self._spare_busy:
            return
        self._spare_busy.add(gid)
        try:
            blocked = self._blocked_map()
            if not blocked:
                return
            bot = self._bot
            if bot is None:
                return
            if not self._spare_ocr_checked:
                self._spare_ocr_checked = True
                try:
                    self._spare_ocr_ok = ocr._load_engine() is not None
                except Exception:
                    self._spare_ocr_ok = False
            if not self._spare_ocr_ok:
                logger.warning("[半自动化搬屎] 点图：OCR 不可用，无法排除含字图，本次不发")
                return
            limit = max(1, self._int("spare_trigger_max", 8))
            cands = spare.pick(
                list(self.queue.items), blocked, gid,
                self._fix_sent, self._entry_ids, self._entry_segs, limit,
            )
            if not cands:
                logger.info(f"[半自动化搬屎] 点图：群 {gid} 池子里没有被拦的纯图")
                return
            sent = 0
            for entry, mid, segs in cands:
                if self._already_sent(entry, mid, gid):   # 内容 key 发过就不再发（同内容换 mid）
                    continue
                use = []
                for s in spare.image_segs(segs):
                    p = self._seg_local_path(s)
                    if not p:
                        continue
                    try:
                        with open(p, "rb") as f:
                            txt = await ocr.image_text(f.read())
                    except Exception:
                        txt = None
                    if txt:
                        continue
                    use.append(s)
                if not use:
                    p = str((blocked.get(mid) or {}).get("path") or "")
                    if p and os.path.isfile(p):
                        use = [{"type": "image", "data": {"file": "file://" + p}}]
                if not use:
                    continue
                if not await self._spare_send(bot, gid, use):
                    continue
                self._mark_sent_both(entry, mid, gid)
                self._mark_activity(gid)
                self._arm_quiet(gid)      # 发了才重置：锁定这次之后的下一次静默值
                self._stats["forwarded"] += 1
                self._stats["last"] = time.strftime("%H:%M:%S")
                sent += 1
                if self._entry_done(entry):
                    self.queue.remove(entry)
                await asyncio.sleep(1)
            if sent:
                self._spare_last[gid] = time.time()
                self.queue.save(force=True)
                logger.info(f"[半自动化搬屎] 点图：群 {gid} 发了 {sent} 条被拦纯图")
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 点图失败：{e}")
        finally:
            self._spare_busy.discard(gid)

    def _next_entry_for(self, gid, now):
        """该群最早的、可发的一条（消息 x 群）。群与群之间不排同一个队。

        被 B站筛掉且**不含文字**的图不排除，只排到后面：先发正常图（老的优先），
        正常图都发完了才轮到它们（同样老的优先）。含文字的被拦图按正常图排队。
        """
        gid = str(gid)
        join_at = 0.0   # 新群/重加群的加入时间：加入前入队的老屎不发它（主人 2026-11-24 令）
        try:
            jd = self._load_auto_groups().get(gid)
            if isinstance(jd, dict):
                join_at = float(jd.get("at") or 0)
        except Exception:
            pass
        blocked = self._blocked_map() if self._bool("spare_blocked_last", True) else {}
        ordered = sorted(self.queue.items, key=lambda x: float(x.get("at") or 0))
        for want_defer in ((False, True) if blocked else (False,)):
            for entry in ordered:
                if join_at and float(entry.get("at") or 0) < join_at:
                    continue   # 老屎不发给新加的群
                for mid in self._entry_ids(entry):
                    defer = False
                    if blocked and mid in blocked:
                        info = blocked.get(mid) or {}
                        segs = self._entry_segs(entry, mid) or []
                        defer = not (bool(info.get("hasText")) or spare.has_text_segs(segs))
                    if defer != want_defer:
                        continue
                    if self._fix_sent(mid, gid):
                        continue
                    snap = entry.get("targets")
                    if isinstance(snap, dict) and isinstance(snap.get(mid), list):
                        if not snap[mid]:
                            continue
                        if gid not in [str(t) for t in snap[mid]]:
                            continue
                    lane = (entry.get("lanes") or {}).get(self._lane_key(mid, gid)) or {}
                    if float(lane.get("next_try") or 0) > now:
                        continue
                    return entry, mid
        return None

    def _entry_done(self, entry) -> bool:
        snap = entry.get("targets")
        if not isinstance(snap, dict):
            return False
        for mid in self._entry_ids(entry):
            tg = snap.get(mid)
            if not isinstance(tg, list):
                return False
            for t in [str(x) for x in tg]:
                if not self._fix_sent(mid, t):
                    return False
        return True

    def _lane_fail(self, entry, mid, gid, reason):
        lane = self._lane(entry, mid, gid)
        lane["fails"] = int(lane.get("fails") or 0) + 1
        lane["last_error"] = str(reason)
        # 重试节奏：1 -> 2 -> 4 分钟，之后每档只多 4 分钟（线性，不翻倍），封顶 1 小时
        base = max(10, self._int("retry_interval_seconds", 60))
        f = int(lane["fails"])
        if f <= 1:
            delay = base
        elif f == 2:
            delay = 2 * base
        elif f == 3:
            delay = 4 * base
        else:
            delay = 4 * base * (f - 2)
        delay = min(3600, delay)
        lane["next_try"] = time.time() + delay
        entry["last_error"] = str(reason)
        entry["tries"] = int(entry.get("tries") or 0) + 1
        self._stats["failed"] += 1
        self.queue.save()
        logger.warning(
            f"[半自动化搬屎] {mid} -> 群 {gid} 失败（连败 {lane['fails']} 次），{delay}s 后重试：{reason}"
        )
        if time.time() - float(entry.get("at") or 0) > 7200 and not entry.get("alerted"):
            entry["alerted"] = True
            self.queue.save()
            if time.time() - float(self._notify_last.get("stuck") or 0) > 1800:
                self._notify_last["stuck"] = time.time()
                self._spawn(self._notify(
                    "搬屎有消息重试超过2小时（群 %s，队列 %s 条）：%s %s" % (
                        gid, len(self.queue), mid, reason,
                    )
                ))

    async def _send_lane(self, entry, gid, mid):
        """只处理 (这条消息, 这个群)；失败只惩罚这个群的通道，不牵连别的群。"""
        gid = str(gid)
        mid = str(mid)
        try:
            if self._already_sent(entry, mid, gid):
                return
            targets = await self._targets_for_mid(entry, mid)
            if gid not in targets:
                return
            segs = self._entry_segs(entry, mid)
            bot = self._bot
            if not segs and bot is not None:
                try:
                    detail = await bot.api.call_action("get_msg", message_id=int(mid))
                    segs = _segments_of(detail)
                except Exception as e:
                    self._lane_fail(entry, mid, gid, f"取消息失败：{e!r}")
                    return
            if not segs:
                self._lane_fail(entry, mid, gid, "消息内容为空")
                return
            sender = Sender(bot)
            try:
                ok, how = await asyncio.wait_for(sender.forward(gid, mid, segs), timeout=45)
            except asyncio.TimeoutError:
                ok, how = False, "发送超时"
            except Exception as e:
                ok, how = False, str(e)
            if not ok:
                self._lane_fail(entry, mid, gid, how)
                return
            self._mark_sent_both(entry, mid, gid)
            self._mark_activity(gid)
            self._arm_quiet(gid)      # 发了才重置：锁定这次之后的下一次静默值
            fp = self._recent_fp.get(mid)
            if fp and fp.get("items"):
                try:
                    self.index.add(fp, gid)
                except Exception:
                    pass
            async with self._queue_lock:
                lane = self._lane(entry, mid, gid)
                lane["fails"] = 0
                lane["next_try"] = 0.0
                lane["last_error"] = ""
                entry["attempts"] = int(entry.get("attempts") or 0) + 1
                if self._entry_done(entry):
                    self.queue.remove(entry)
                    logger.info(f"[半自动化搬屎] {mid} 全部目标已发，出队")
                else:
                    self.queue.save()
            self._stats["forwarded"] += 1
            self._stats["last"] = time.strftime("%H:%M:%S")
            logger.info(f"[半自动化搬屎] {mid} -> 群 {gid}（{how}）")
        except Exception as e:
            logger.warning(f"[半自动化搬屎] {mid} -> 群 {gid} 通道异常：{e}")
        finally:
            self._lane_busy.discard(gid)

    async def _sweep(self):
        """每轮给每个目标群各推进一步：互不阻塞，谁也不等谁。"""
        if not self._bool("enabled", True):
            return
        now = time.time()
        self._detect_period_change(now)
        for gid in [str(t) for t in self._list("target_group_list")]:
            # 2026-11-24 修：原用裸 gid 做 in-flight 键，_send_lane 内 _spawn 多个子任务时
            # 同群不同 mid 会互相挡/重复派发；NapCat 实证同一条发到同群 2 次。
            # 改为按群串行仍保留（每群一次推进一条），但派发后记录 (mid,gid) 指纹防同条重入。
            if gid in self._lane_busy:
                continue
            if not self._quiet_ok(gid, now):
                continue
            pick = self._next_entry_for(gid, now)
            if pick is None:
                continue
            entry, mid = pick
            inflight = f"{mid}|{gid}"
            if inflight in getattr(self, "_inflight_lanes", set()):
                continue
            if not hasattr(self, "_inflight_lanes"):
                self._inflight_lanes = set()
            self._inflight_lanes.add(inflight)
            self._lane_busy.add(gid)
            async def _guard(e=entry, g=gid, m=mid, k=inflight):
                try:
                    await self._send_lane(e, g, m)
                finally:
                    self._inflight_lanes.discard(k)
            self._spawn(_guard())

    def _group_summary(self):
        out = []
        now = time.time()
        for gid in [str(t) for t in self._list("target_group_list")]:
            span = self._locked_seconds(now, gid)   # 与实际发送判定同一把尺
            pending = 0
            fails = 0
            try:
                jd = self._load_auto_groups().get(gid)
                jjoin = float((jd or {}).get("at") or 0) if isinstance(jd, dict) else 0
            except Exception:
                jjoin = 0
            for entry in self.queue.items:
                if jjoin and float(entry.get("at") or 0) < jjoin:
                    continue
                snap = entry.get("targets")
                if not isinstance(snap, dict):
                    continue
                for mid in self._entry_ids(entry):
                    tg = snap.get(mid)
                    if not isinstance(tg, list):
                        pending += 1
                        continue
                    if gid not in [str(x) for x in tg]:
                        continue
                    if self._fix_sent(mid, gid):
                        continue
                    pending += 1
                    lane = (entry.get("lanes") or {}).get(self._lane_key(mid, gid)) or {}
                    fails = max(fails, int(lane.get("fails") or 0))
            left = max(0, span - (now - float(self._last_activity.get(gid) or 0)))
            out.append({
                "gid": gid,
                "pending": pending,
                "fails": fails,
                "next_ok_in": int(left),
            })
        return out

    async def _loop(self):
        while True:
            try:
                await asyncio.sleep(2)
                if self._bot is None:
                    try:
                        self._bot = await self._find_bot()
                    except Exception:
                        pass
                elif not self._heal_done:
                    self._heal_done = True
                    self._spawn(self._heal_queue_from_history())
                if self._merge_task is not None and self._merge_task.done():
                    self._merge_task = None
                if (self._merge_task is None and self._bot is not None
                        and not os.path.isfile(REQUEUE_FILE)):
                    self._merge_task = asyncio.create_task(
                        self._merge_adjacent_images(self._bot)
                    )
                await self._sweep()
                self.queue.flush()          # 把合并期内的队列改动补写
                self._flush_activity()
                self._flush_history()       # 动态静默的发言历史补写
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 调度异常：{e}")

    async def _backfill_loop(self):
        count = self._int("backfill_count", 100)
        if count <= 0:
            return
        marker = os.path.join(DATA_DIR, "backfill_done.txt")
        try:
            if os.path.exists(marker) and time.time() - os.path.getmtime(marker) < 7 * 86400:
                self._backfill_done = True
                logger.info("[半自动化搬屎] 7 天内已回填过，跳过")
                return
        except OSError:
            pass
        while self._bot is None:
            await asyncio.sleep(5)
        groups = []
        for g in self._list("source_group_list") + self._list("target_group_list"):
            if g not in groups:
                groups.append(g)
        for gid in groups:
            try:
                resp = await self._bot.api.call_action(
                    "get_group_msg_history", group_id=int(gid), count=count
                )
                msgs = []
                if isinstance(resp, dict):
                    msgs = resp.get("messages") or (resp.get("data") or {}).get("messages") or []
                for m in msgs:
                    segs = _segments_of(m)
                    if not segs:
                        continue
                    fp = await message_fingerprint(
                        self._bot, segs, self._int("media_hash_max_mb", 100), with_text=False
                    )
                    if fp.get("items"):
                        self.index.add(fp, gid)
                logger.info(f"[半自动化搬屎] 回填群 {gid}：{len(msgs)} 条")
            except Exception as e:
                logger.warning(f"[半自动化搬屎] 回填群 {gid} 失败：{e}")
            await asyncio.sleep(1)
        self._backfill_done = True
        try:
            with open(marker, "w", encoding="utf-8") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass
        logger.info("[半自动化搬屎] 历史回填完成")

    async def _split_stale_bursts(self, bot):
        changed = 0
        max_mb = self._int("media_hash_max_mb", 100)
        with_text = self._bool("image_ocr_dedupe", True)
        for entry in list(self.queue.items):
            ids = self._entry_ids(entry)
            if len(ids) <= 1:
                continue
            if entry.get("tries") or entry.get("failed") or entry.get("sent"):
                continue
            fps = []
            for mid in ids:
                fp = self._recent_fp.get(mid)
                if fp is None:
                    try:
                        detail = await bot.api.call_action("get_msg", message_id=int(mid))
                        segs = _segments_of(detail)
                        if segs:
                            fp = await message_fingerprint(bot, segs, max_mb, with_text=with_text)
                    except Exception:
                        fp = None
                fps.append(fp)
            groups = cluster(
                fps,
                self._int("burst_max_messages", 8),
                self._int("image_phash_threshold", 5),
                self._int("text_keyword_hits", 3),
                self._forward_ratio(),
                [str(entry.get("sender") or "") for _ in ids],
            )
            if len(groups) <= 1:
                continue
            source = str(entry.get("source"))
            sender = str(entry.get("sender") or "")
            at = float(entry.get("at") or time.time())
            self.queue.remove(entry)
            for g in groups:
                self.queue.add_entry([ids[i] for i in g], source, sender, at, 0)
            changed += 1
        if changed:
            logger.info(f"[半自动化搬屎] 拆分旧合并条目 {changed} 个")

    async def _requeue_loop(self):
        """等平台连上再跑一次图片重排；没有新消息也能执行。"""
        if os.path.isfile(REQUEUE_FILE):
            return
        waited = 0
        while waited < 3600:
            try:
                bot = await self._find_bot()
            except Exception as e:
                logger.debug(f"[半自动化搬屎] 取 Bot 失败：{e}")
                bot = None
            if bot is not None:
                ready = False
                for _ in range(36):
                    try:
                        info = await bot.api.call_action("get_login_info")
                        ready = bool(info)
                    except Exception:
                        ready = False
                    if ready:
                        break
                    await asyncio.sleep(10)
                if not ready:
                    logger.warning("[半自动化搬屎] 图片重排放弃：Bot 连不上")
                    return
                logger.info("[半自动化搬屎] 开始按新规则重排已入队图片")
                for attempt in range(1, 4):
                    try:
                        await self._merge_adjacent_images(bot)
                        return
                    except Exception as e:
                        logger.warning(f"[半自动化搬屎] 图片重排第 {attempt} 次失败：{e}")
                self._write_requeue_flag()
                return
            await asyncio.sleep(15)
            waited += 15
        logger.warning("[半自动化搬屎] 图片重排放弃：等不到 Bot")

    async def _merge_adjacent_images(self, bot):
        """一次性把队列里相邻、同人、同窗口的图片按当前规则重新合并。"""
        if os.path.isfile(REQUEUE_FILE) or self._pruning:
            return
        prev_pruning = self._pruning
        self._pruning = True
        try:
            await self._do_merge_adjacent_images(bot)
        finally:
            self._pruning = prev_pruning

    async def _do_merge_adjacent_images(self, bot):
        window = max(0, self._int("burst_window_seconds", 5))
        max_mb = self._int("media_hash_max_mb", 100)
        with_text = self._bool("image_ocr_dedupe", True)
        max_n = self._int("burst_max_messages", 8)
        threshold = self._int("image_phash_threshold", 5)
        hits = self._int("text_keyword_hits", 3)
        ratio = self._forward_ratio()
        entries = list(self.queue.items)
        cands = []
        fails = 0
        for idx, entry in enumerate(entries):
            if entry.get("sent") or entry.get("pending"):
                continue
            ids = self._entry_ids(entry)
            if not ids:
                continue
            fps = []
            ok = True
            for mid in ids:
                fp = self._recent_fp.get(mid)
                if fp is None:
                    try:
                        detail = await bot.api.call_action("get_msg", message_id=int(mid))
                        segs = _segments_of(detail)
                        fp = await message_fingerprint(bot, segs, max_mb, with_text) if segs else None
                    except Exception:
                        fp = None
                        fails += 1
                items = (fp or {}).get("items") or []
                if not fp or not items or any(it.get("kind") != "image" for it in items):
                    ok = False
                    break
                fps.append(fp)
            if ok:
                cands.append({"idx": idx, "entry": entry, "ids": ids, "fps": fps})
            if idx and idx % 40 == 0:
                logger.info(f"[半自动化搬屎] 图片重排扫描 {idx}/{len(entries)}")
        if fails > max(5, len(entries) // 3):
            logger.warning(f"[半自动化搬屎] 图片重排放弃：{fails} 条取消息失败，不再重试")
            self._write_requeue_flag()
            return
        if len(cands) < 2:
            logger.info("[半自动化搬屎] 相邻图片合并：没有需要处理的图片消息")
            self._write_requeue_flag()
            return

        runs = []
        cur = []
        for c in cands:
            e = c["entry"]
            if cur:
                prev = cur[-1]
                pe = prev["entry"]
                if (c["idx"] != prev["idx"] + 1
                        or str(e.get("source")) != str(pe.get("source"))
                        or str(e.get("sender")) != str(pe.get("sender"))
                        or float(e.get("at") or 0) - float(pe.get("at") or 0) > window):
                    runs.append(cur)
                    cur = []
            cur.append(c)
        if cur:
            runs.append(cur)

        merged = 0
        backup = None
        for run in runs:
            if len(run) < 2 and all(len(c["ids"]) > 1 for c in run):
                pass
            flat_ids = [mid for c in run for mid in c["ids"]]
            flat_fps = [fp for c in run for fp in c["fps"]]
            senders = [str(c["entry"].get("sender") or "") for c in run for _ in c["ids"]]
            groups = cluster(flat_fps, max_n, threshold, hits, ratio, senders)
            if len(groups) >= len(flat_ids):
                continue
            if backup is None:
                backup = self._backup_queue()
            source = str(run[0]["entry"].get("source"))
            sender = str(run[0]["entry"].get("sender") or "")
            at = min(float(c["entry"].get("at") or time.time()) for c in run)
            for c in run:
                self.queue.remove(c["entry"])
            parts = []
            for g in groups:
                ids = [flat_ids[i] for i in g]
                self.queue.add_entry(ids, source, sender, at, 0)
                parts.append("+".join(ids))
            merged += 1
            logger.info(
                f"[半自动化搬屎] 图片重排：{len(flat_ids)} 条 → {len(groups)} 条（{' | '.join(parts)}）"
            )
        if merged:
            logger.info(f"[半自动化搬屎] 图片重排完成，重写 {merged} 段，备份 {backup}")
        else:
            logger.info("[半自动化搬屎] 图片重排：队列已是当前规则，无需改动")
        self._write_requeue_flag()

    def _backup_queue(self):
        path = QUEUE_FILE + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        try:
            with open(QUEUE_FILE, "rb") as src, open(path, "wb") as dst:
                dst.write(src.read())
        except OSError:
            return None
        return path

    def _write_requeue_flag(self):
        try:
            with open(REQUEUE_FILE, "w", encoding="utf-8") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass

    async def _prune_queue(self):
        # 零丢失：一条都不删。超龄条目只是从内存队列**移档**到 queue_archive.jsonl，
        # 原文逐字保留（要回填随时能读），内存/每轮遍历的规模因此有界。
        minutes = self._int("queue_max_age_minutes", 120)
        if minutes <= 0 or not self.queue.items:
            return
        try:
            _blocked = self._blocked_map()
            _keep = (lambda it: any(m in _blocked for m in self._entry_ids(it))) if _blocked else None
            moved = self.queue.archive_old(
                minutes * 60, os.path.join(DATA_DIR, "queue_archive.jsonl"), keep_predicate=_keep
            )
            if moved:
                logger.info(
                    f"[半自动化搬屎] 超龄队列 {moved} 条已移档到 queue_archive.jsonl（未删除，可回填）"
                )
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 队列移档失败：{e}")
        return
        bot = self._bot
        if bot is None or not self.queue.items:
            return
        if not self._bool("dedupe_enabled", True):
            return
        max_mb = self._int("media_hash_max_mb", 100)
        with_text = self._bool("image_ocr_dedupe", True)
        targets = self._list("target_group_list")
        try:
            old_n = self.queue.purge(max(0, self._int("queue_max_age_minutes", 120)) * 60)
            if old_n:
                logger.info(f"[半自动化搬屎] 清理超龄队列 {old_n} 条")
        except Exception:
            pass
        total = len(self.queue.items)
        skipped = 0
        removed = 0
        self._pruning = True
        try:
            for entry in list(self.queue.items)[:60]:
                source = str(entry.get("source"))
                keep = False
                for mid in self._entry_ids(entry)[:8]:
                    try:
                        detail = await bot.api.call_action("get_msg", message_id=int(mid))
                        segs = _segments_of(detail)
                        if not segs:
                            continue
                        fp = await message_fingerprint(
                            bot, segs, max_mb, with_text=with_text
                        )
                    except Exception as e:
                        emsg = str(e)
                        logger.warning(f"[半自动化搬屎] 预检取消息失败 {mid}：{e}")
                        if "消息不存在" in emsg or "1200" in emsg:
                            continue
                        keep = True
                        continue
                    pending = self._targets_for(source, fp, targets)
                    entry["message_key"] = fp.get("message_key") or entry.get("message_key")
                    if pending:
                        keep = True
                        skipped += max(0, len(targets) - len(pending))
                if not keep:
                    self.queue.remove(entry)
                    removed += 1
                else:
                    entry.pop("pending", None)
                    entry.pop("failed", None)
            self.queue.save()
        finally:
            self._pruning = False
        logger.info(
            f"[半自动化搬屎] 队列预检：{total} 条，跳过 {skipped} 个已存在目标，删除 {removed} 条"
        )

    async def _prune_loop(self):
        try:
            if self._backfill_task is not None:
                await asyncio.shield(self._backfill_task)
        except Exception:
            pass
        waited = 0
        while self._bot is None and waited < 120:
            try:
                self._bot = await self._find_bot()
            except Exception:
                pass
            if self._bot is not None:
                break
            await asyncio.sleep(5)
            waited += 5
        if self._bot is None:
            logger.warning("[半自动化搬屎] 队列预检跳过：Bot 未就绪")
            return
        self._pruning = True
        try:
            await self._split_stale_bursts(self._bot)
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 拆分旧合并条目失败：{e}")
        finally:
            self._pruning = False
        self._pruning = True
        try:
            await self._merge_adjacent_images(self._bot)
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 相邻图片合并失败：{e}")
        finally:
            self._pruning = False
        try:
            await self._prune_queue()
        except Exception as e:
            logger.warning(f"[半自动化搬屎] 队列预检失败：{e}")

    async def _find_bot(self):
        if self._bot is not None:
            return self._bot
        pm = getattr(self.context, "platform_manager", None)
        insts = []
        getter = getattr(pm, "get_insts", None)
        if callable(getter):
            try:
                insts = list(getter() or [])
            except Exception:
                insts = []
        if not insts:
            insts = list(getattr(pm, "platform_insts", None) or [])
        for inst in insts:
            fn = getattr(inst, "get_client", None)
            if not callable(fn):
                continue
            try:
                bot = fn()
                if asyncio.iscoroutine(bot):
                    bot = await bot
            except Exception:
                continue
            if bot is not None:
                self._bot = bot
                return bot
        return None

    async def _archive_media(self, mid, segs):
        try:
            segs = await self._expand_forwards(segs)
            segs = await self.archive.localize(mid, segs)
            self._recent_segs[str(mid)] = segs
            self.archive.update(mid, segs)
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 归档媒体失败 {mid}：{e}")

    async def _expand_forwards(self, segs):
        bot = self._bot
        for seg in segs or []:
            if not isinstance(seg, dict):
                continue
            if seg.get("type") not in ("forward", "node", "nodes"):
                continue
            data = seg.get("data")
            if not isinstance(data, dict):
                continue
            if isinstance(data.get("nodes"), list) and data["nodes"]:
                continue
            fid = data.get("id") or data.get("message_id")
            if not fid or bot is None:
                continue
            resp = None
            try:
                resp = await bot.api.call_action("get_forward_msg", message_id=str(fid))
            except Exception:
                try:
                    resp = await bot.api.call_action("get_forward_msg", id=str(fid))
                except Exception:
                    resp = None
            msgs = None
            if isinstance(resp, dict):
                msgs = resp.get("messages") or (resp.get("data") or {}).get("messages")
            if isinstance(msgs, list) and msgs:
                data["nodes"] = msgs
                data.pop("id", None)
                data.pop("message_id", None)
        return segs

    async def _fetch_history(self, bot, gid, until_ts, max_pages=60):
        seen = {}
        seq = None
        oldest = None
        for _ in range(max_pages):
            kwargs = {"group_id": int(gid), "count": 1000}
            if seq:
                kwargs["message_seq"] = str(seq)
            resp = await bot.api.call_action("get_group_msg_history", **kwargs)
            msgs = []
            if isinstance(resp, dict):
                msgs = resp.get("messages") or (resp.get("data") or {}).get("messages") or []
            if not msgs:
                break
            for m in msgs:
                sid = str(m.get("message_id") or "")
                if sid and sid not in seen:
                    seen[sid] = m
            times = [int(m.get("time") or 0) for m in msgs if m.get("time")]
            if not times:
                break
            mn = min(times)
            if oldest is not None and mn >= oldest:
                break
            oldest = mn
            if mn <= until_ts:
                break
            oldest_msg = min((m for m in msgs if m.get("time")), key=lambda m: int(m.get("time") or 0))
            nseq = str(oldest_msg.get("message_id") or "")
            if not nseq or nseq == seq:
                break
            seq = nseq
            await asyncio.sleep(0.4)
        return seen

    @staticmethod
    def _msg_sender(m):
        s = m.get("sender") if isinstance(m.get("sender"), dict) else {}
        return str(s.get("user_id") or m.get("user_id") or "")

    def _raw_text(self, gid, at, window=20):
        try:
            con = sqlite3.connect(os.path.expanduser(
                "~/.astrbot/data/plugin_data/astrbot_plugin_self_learning/messages.db"
            ), timeout=5)
            try:
                row = con.execute("SELECT timestamp FROM raw_messages LIMIT 1").fetchone()
                scale = 1000 if row and abs(int(row[0])) > 10 ** 12 else 1
                rows = con.execute(
                    "SELECT message, timestamp FROM raw_messages WHERE group_id=? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp-?) LIMIT 1",
                    (str(gid), int((at - window) * scale), int((at + window) * scale), int(at * scale)),
                ).fetchall()
            finally:
                con.close()
            if rows and str(rows[0][0] or "").strip():
                return str(rows[0][0]).strip()
        except Exception:
            pass
        return ""

    async def _heal_queue_from_history(self):
        """重启后把队列里只有 ID、没有内容的条目，用群历史补回内容（不删任何条目）。"""
        bot = self._bot
        if bot is None:
            return 0
        need = []
        for e in self.queue.items:
            cached = e.get("segs") if isinstance(e.get("segs"), dict) else {}
            for mid in self._entry_ids(e):
                if cached.get(mid):
                    continue
                rec = self.archive.latest(mid)
                if isinstance(rec, dict) and isinstance(rec.get("segs"), list) and rec["segs"]:
                    cached[mid] = rec["segs"]
                    e["segs"] = cached
                    continue
                need.append((e, mid))
        self.queue.save()
        if not need:
            return 0
        src = str((self._list("source_group_list") or [""])[0])
        until = int(min(float(e.get("at") or 0) for e, _ in need)) - 60
        seen = await self._fetch_history(bot, src, until)
        by_sender = {}
        for sid, m in seen.items():
            by_sender.setdefault(self._msg_sender(m), []).append((int(m.get("time") or 0), sid, m))
        used = set()
        healed = 0
        for e, mid in need:
            at = float(e.get("at") or 0)
            sender = str(e.get("sender") or "")
            m = seen.get(mid)
            if m is None:
                best = None
                for t, sid, cand in by_sender.get(sender, []):
                    if sid in used:
                        continue
                    d = abs(t - at)
                    if d <= 20 and (best is None or d < best[0]):
                        best = (d, sid, cand)
                if best is not None:
                    used.add(best[1])
                    m = best[2]
            if m is None:
                continue
            segs = _segments_of(m)
            if not segs:
                continue
            try:
                segs = await self._expand_forwards(segs)
                segs = await self.archive.localize(mid, segs)
            except Exception:
                pass
            e.setdefault("segs", {})[mid] = segs
            self.archive.record(mid, src, sender, at, segs, message_key=self._mid_key(mid))
            healed += 1
        if healed:
            self.queue.save()
        return healed

    def _mid_key(self, mid):
        """归档落身份：mid 在 outbox 里已有的内容身份（指纹优先）。"""
        try:
            return self.outbox.ckey_for_mid(mid)
        except Exception:
            return ""

    async def _recover_loop(self):
        path = os.path.join(DATA_DIR, "recover_job.json")
        has_job = os.path.isfile(path)
        job = None
        if has_job:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    job = json.load(f)
            except (OSError, ValueError):
                has_job = False
        waited = 0
        while self._bot is None and waited < 300:
            try:
                self._bot = await self._find_bot()
            except Exception:
                pass
            if self._bot is not None:
                break
            await asyncio.sleep(5)
            waited += 5
        if self._bot is None:
            return
        await asyncio.sleep(20)
        healed = 0
        for attempt in range(4):
            try:
                healed = await self._heal_queue_from_history()
                break
            except Exception:
                logger.warning(
                    f"[半自动化搬屎] 队列内容补全失败（第{attempt + 1}次）：\n{traceback.format_exc()}"
                )
                await asyncio.sleep(20)
        if healed:
            logger.info(f"[半自动化搬屎] 从历史补全队列内容 {healed} 条")
        if not has_job or not isinstance(job, dict):
            return
        report = None
        for attempt in range(4):
            try:
                report = await self._recover_from_backup(job)
                break
            except Exception:
                logger.warning(
                    f"[半自动化搬屎] 恢复失败（第{attempt + 1}次）：\n{traceback.format_exc()}"
                )
                await asyncio.sleep(30)
        if report is not None:
            logger.info(f"[半自动化搬屎] 恢复完成：{json.dumps(report, ensure_ascii=False)}")
            self._recover_done = True
            try:
                os.replace(path, path + ".done")
            except OSError:
                pass
        else:
            try:
                os.replace(path, path + ".failed")
            except OSError:
                pass
            await self._notify("搬屎恢复失败，任务文件已保留为 recover_job.json.failed")

    async def _recover_from_backup(self, job):
        bot = self._bot
        backup = str(job.get("queue_file") or "")
        src = str(job.get("source") or (self._list("source_group_list") or [""])[0])
        cut = float(job.get("since") or 0)
        dry = bool(job.get("dry_run"))
        offset_step = max(0, self._int("recover_stagger_seconds", 3))
        with open(os.path.expanduser(backup), "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = [e for e in data if isinstance(e, dict) and float(e.get("at") or 0) < cut]
        entries.sort(key=lambda e: float(e.get("at") or 0))
        live = set()
        for it in self.queue.items:
            live.update(self._entry_ids(it))
        entries = [e for e in entries if not (set(str(x) for x in (e.get("message_ids") or [e.get("message_id")])) & live)]
        until = int(min(float(e.get("at") or 0) for e in entries)) - 60 if entries else 0
        seen = await self._fetch_history(bot, src, until)
        times = [int(m.get("time") or 0) for m in seen.values() if m.get("time")]
        earliest = min(times) if times else 0
        by_sender = {}
        for sid, m in seen.items():
            by_sender.setdefault(self._msg_sender(m), []).append((int(m.get("time") or 0), sid, m))
        used = set()
        matched = fuzzy = textfb = 0
        missing = []
        enqueued = 0
        offset = 0.0
        for e in entries:
            mids = [str(x) for x in (e.get("message_ids") or [e.get("message_id")]) if x is not None]
            at = float(e.get("at") or 0)
            sender = str(e.get("sender") or "")
            seg_map = {}
            miss = []
            for mid in mids:
                m = seen.get(mid)
                if m is None:
                    best = None
                    for t, sid, cand in by_sender.get(sender, []):
                        if sid in used:
                            continue
                        d = abs(t - at)
                        if d <= 20 and (best is None or d < best[0]):
                            best = (d, sid, cand)
                    if best is not None:
                        used.add(best[1])
                        m = best[2]
                        fuzzy += 1
                    else:
                        miss.append(mid)
                        continue
                else:
                    matched += 1
                segs = _segments_of(m)
                if segs:
                    seg_map[mid] = segs
                else:
                    miss.append(mid)
            if not seg_map and miss:
                text = self._raw_text(src, at)
                if text:
                    mid = miss[0]
                    seg_map[mid] = [{"type": "text", "data": {"text": text}}]
                    textfb += 1
                    miss = miss[1:]
            if not seg_map:
                missing.extend({"mid": x, "at": at, "sender": sender} for x in miss)
                continue
            if dry:
                enqueued += 1
                continue
            task_entry = {
                "message_id": mids[0],
                "message_ids": [x for x in mids if x in seg_map],
                "source": src,
                "sender": sender,
                "at": at,
                "next_try": time.time() + offset,
                "tries": 0,
                "burst": len(mids) > 1,
                "segs": seg_map,
                "recovered": True,
            }
            if miss:
                task_entry["missing_ids"] = miss
            try:
                await self.archive.localize(mids[0], [s for v in seg_map.values() for s in v])
            except Exception:
                pass
            if self.queue.add(task_entry):
                enqueued += 1
                offset += offset_step
        report = {
            "backup": backup,
            "since": cut,
            "total_old": len(entries),
            "matched": matched,
            "fuzzy": fuzzy,
            "text_fallback": textfb,
            "missing": len(missing),
            "enqueued": enqueued,
            "history_earliest": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(earliest)) if earliest else "",
        }
        try:
            with open(os.path.join(DATA_DIR, "recover_report.json"), "w", encoding="utf-8") as fh:
                json.dump(report, fh, ensure_ascii=False, indent=2)
            with open(os.path.join(DATA_DIR, "recover_missing.json"), "w", encoding="utf-8") as fh:
                json.dump(missing, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass
        await self._notify(
            "搬屎恢复：%s/%s 条已回队，模糊匹配 %s，文字兜底 %s，缺 %s 条；历史最早 %s" % (
                enqueued, len(entries), fuzzy, textfb, len(missing), report["history_earliest"] or "未知",
            )
        )
        return report

    async def _reconcile_archive(self):
        await asyncio.sleep(180)
        try:
            recs = self.archive.load(since=time.time() - 3 * 86400)
        except Exception:
            return
        qids = set()
        for it in self.queue.items:
            qids.update(self._entry_ids(it))
        added = 0
        now = time.time()
        for mid, rec in recs.items():
            if mid in qids:
                continue
            at = float(rec.get("at") or 0)
            if now - at < 600:
                continue
            targets = [str(t) for t in self._list("target_group_list") if str(t) not in self.archive.sent_targets(mid)]
            if not targets:
                continue
            segs = rec.get("segs")
            if not isinstance(segs, list) or not segs:
                continue
            entry = {
                "message_id": mid,
                "message_ids": [mid],
                "source": str(rec.get("source") or ""),
                "sender": str(rec.get("sender") or ""),
                "at": at,
                "next_try": now,
                "tries": 0,
                "burst": False,
                "segs": {mid: segs},
                "recovered": True,
            }
            if self.queue.add(entry):
                added += 1
        if added:
            logger.info(f"[半自动化搬屎] 归档对账补回 {added} 条")

    async def initialize(self):
        try:
            await self._find_bot()
        except Exception as e:
            logger.debug(f"[半自动化搬屎] 取 Bot 失败：{e}")
        # 重载守卫：已有在跑的循环就不再起第二个（以前重载一次多一份循环）
        if self._requeue_task is None or self._requeue_task.done():
            self._requeue_task = asyncio.create_task(self._requeue_loop())
        self._loop_task = asyncio.create_task(self._loop())
        self._backfill_task = asyncio.create_task(self._backfill_loop())
        self._recover_task = asyncio.create_task(self._recover_loop())
        self._spawn(self._reconcile_archive())
        if self._bool("bili_export_enabled", True) and self._bool("bili_export_backlog", True):
            self._spawn(bili_export.export_backlog(self))
        self._load_burst()
        for source in list(self._burst_buf):
            task = asyncio.create_task(self._burst_flush_loop(source))
            self._burst_tasks[source] = task
            task.add_done_callback(lambda _t, s=source: self._burst_tasks.pop(s, None))
        if self._burst_buf:
            logger.info(f"[半自动化搬屎] 恢复未合并连发 {sum(len(v) for v in self._burst_buf.values())} 条")
        logger.info(
            "[半自动化搬屎] 已加载：%s，去重%s，源群 %s -> 目标 %s 个" % (
                self._quiet_text(),
                "开启" if self._bool("dedupe_enabled", True) else "关闭",
                ",".join(self._list("source_group_list")),
                len(self._list("target_group_list")),
            )
        )

    async def terminate(self):
        for task in (self._loop_task, self._backfill_task, self._recover_task,
                     self._requeue_task, self._merge_task, self._prune_task):
            if task and not task.done():
                task.cancel()
        for task in list(self._burst_tasks.values()):
            if task and not task.done():
                task.cancel()
        for task in list(self._bg_tasks):
            if not task.done():
                task.cancel()
        self._save_burst()
        self.queue.save(force=True)
        self.index.save()
        self._activity_dirty = True
        self._flush_activity()
        self._flush_history()
        self._flush_locked()
        logger.info("[半自动化搬屎] 已卸载")


# ---- v2 发件箱接管 ----
# 旧队列方法（_sweep/_prune_queue/_group_summary/_migrate_queue/_cleanup_queue_membership/
# _split_stale_bursts/_merge_adjacent_images/_heal_queue_from_history/_reconcile_archive/
# _recover_from_backup/_backfill_sent_keys）在这里被 v2 实现覆盖，避免两套队列逻辑并存。
from .core import outbox_runtime as _outbox_runtime  # noqa: E402

_outbox_runtime.bind(BanshiAuto)
