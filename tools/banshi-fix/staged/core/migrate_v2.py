"""migrate_v2.py — 旧 queue.json → 按群发件箱 outbox.json 的一次性迁移。

零丢失原则（主人 2026-11-24 令「没发的屎不能丢」）：
- 原 queue.json 不删不改，另存 queue.v1-<ts>.json 备份；
- 旧条目整条追加到 queue_archive.jsonl 留底；
- 只搬运「台账证明还没发」的 (内容, 群) 对，发过的不再生成任务；
- 迁移后自校验未发对数量，少一个就回滚（不切换、不写 outbox）。
"""
import json
import os
import time


class JsonlLedger:
    """只读 sent.jsonl 的台账实现：给迁移 CLI 用，避免依赖 aiohttp。"""

    def __init__(self, sent_file):
        self.rows = {}
        try:
            with open(sent_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    mid = str(rec.get("mid"))
                    self.rows.setdefault(mid, set()).add(
                        (str(rec.get("platform") or "qq"), str(rec.get("target")))
                    )
        except OSError:
            pass

    def sent_targets(self, mid):
        return {t for (_p, t) in self.rows.get(str(mid), set())}

    def content_sent_targets(self, ckey):
        return {t for (_p, t) in self.rows.get("key:" + str(ckey), set())}

    def content_sent(self, platform, gid, ckey):
        return (str(platform or "qq"), str(gid)) in self.rows.get("key:" + str(ckey), set())


def load_v1(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def entry_ids(entry):
    ids = entry.get("message_ids")
    if not isinstance(ids, list) or not ids:
        ids = [entry.get("message_id")]
    return [str(x) for x in ids if x is not None]


def entry_key(entry):
    k = str(entry.get("message_key") or "")
    if k:
        return k
    ids = entry_ids(entry)
    return ("mid:" + ids[0]) if ids else ""


def _is_sent(archive, platform, gid, mid, ckey):
    try:
        if archive.sent_targets(mid) and str(gid) in archive.sent_targets(mid):
            return True
    except Exception:
        pass
    try:
        return bool(archive.content_sent(platform, gid, ckey))
    except AttributeError:
        try:
            return str(gid) in archive.content_sent_targets(ckey)
        except Exception:
            return False
    except Exception:
        return False


def collect_pairs(entries, archive, env, platform="qq"):
    """返回 (待发对集合, 统计)。待发对 = 台账未发 + 目标名单内 + 不早于加群时间。"""
    targets = set(env.targets())
    stat = {"sent": 0, "removed_group": 0, "new_group": 0, "no_targets": 0}
    pairs = set()
    for e in entries:
        if not isinstance(e, dict):
            continue
        ckey = entry_key(e)
        if not ckey:
            continue
        at = float(e.get("at") or 0)
        snap = e.get("targets") if isinstance(e.get("targets"), dict) else {}
        has = False
        for mid in entry_ids(e):
            tg = snap.get(mid)
            if not isinstance(tg, list):
                continue
            for g in tg:
                g = str(g)
                if g not in targets:
                    stat["removed_group"] += 1
                    continue
                join = env.join_at(g)
                if join and at < join:
                    stat["new_group"] += 1
                    continue
                if _is_sent(archive, platform, g, mid, ckey):
                    stat["sent"] += 1
                    continue
                pairs.add((g, ckey))
                has = True
        if not has:
            stat["no_targets"] += 1
    return pairs, stat


def migrate_v1(queue_path, outbox, archive, env, dump_path=None, backup_path=None, dry=False):
    entries = load_v1(queue_path)
    before, stat = collect_pairs(entries, archive, env)
    report = {
        "v1_entries": len(entries),
        "unsent_pairs": len(before),
        "distinct_keys": len({k for (_g, k) in before}),
        "merged_dups": sum(1 for e in entries if isinstance(e, dict)) - len({entry_key(e) for e in entries if isinstance(e, dict)}),
        "sent_skipped": stat["sent"],
        "removed_group": stat["removed_group"],
        "new_group_skipped": stat["new_group"],
        "no_targets": stat["no_targets"],
        "tasks_after": 0,
        "missing": 0,
        "ok": True,
        "dry": bool(dry),
    }
    if not entries:
        return report
    if dry:
        simulated = set(before)
        report["tasks_after"] = len(simulated)
        return report

    # 1) 备份 + 留底（先做，失败就不动 outbox）
    now = time.time()
    try:
        if backup_path:
            with open(queue_path, "rb") as src, open(backup_path, "wb") as dst:
                dst.write(src.read())
        if dump_path:
            with open(dump_path, "a", encoding="utf-8") as f:
                for e in entries:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
    except OSError as exc:
        report["ok"] = False
        report["error"] = "备份/留底失败：%r" % (exc,)
        return report

    # 2) 搬运：同 ckey 合并，任务主键天然去重
    for e in entries:
        if not isinstance(e, dict):
            continue
        ids = entry_ids(e)
        ckey = outbox.resolve_ckey({"message_key": str(e.get("message_key") or "")}, ids)
        if not ckey:
            continue
        at = float(e.get("at") or now)
        source = str(e.get("source") or "")
        sender = str(e.get("sender") or "")
        outbox.upsert_content(ckey, "qq", source, sender, at, ids)
        snap = e.get("targets") if isinstance(e.get("targets"), dict) else {}
        for mid in ids:
            tg = snap.get(mid)
            if not isinstance(tg, list):
                continue
            for g in tg:
                g = str(g)
                if (g, ckey) not in before:
                    continue    # 已发/除名/新群老屎：不生成任务
                outbox.ensure_from_archive(
                    ckey, g, source, sender, at, ids, platform="qq",
                )
    outbox.save(force=True)

    # 3) 自校验：未发对必须一个不少
    after = {(str(t.get("gid")), str(t.get("ckey")))
             for t in outbox.tasks.values() if t.get("state") != "paused"}
    missing = before - after
    report["tasks_after"] = len(after)
    report["missing"] = len(missing)
    if missing:
        report["ok"] = False
        report["missing_sample"] = [list(x) for x in list(missing)[:5]]
    return report


def env_from_config(cfg, auto_groups=None):
    try:
        from .outbox import DictEnv
    except ImportError:
        from core.outbox import DictEnv
    joins = {}
    for g, d in (auto_groups or {}).items():
        if isinstance(d, dict):
            try:
                joins[str(g)] = float(d.get("at") or 0)
            except (TypeError, ValueError):
                pass
    return DictEnv(
        targets=cfg.get("target_group_list") or [],
        excludes=cfg.get("exclude_group_list") or [],
        sources=cfg.get("source_group_list") or [],
        joins=joins,
        max_tries=int(cfg.get("max_tries") or 3),
        retry_base=int(cfg.get("retry_interval_seconds") or 60),
    )


def _cli():
    import argparse
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from core.outbox import Outbox
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="插件 data 目录")
    ap.add_argument("--config", required=True, help="astrbot 插件配置 json")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    with open(args.config, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    try:
        with open(os.path.join(args.data, "auto_groups.json"), encoding="utf-8") as f:
            groups = json.load(f)
    except (OSError, ValueError):
        groups = {}
    env = env_from_config(cfg, groups)
    archive = JsonlLedger(os.path.join(args.data, "sent.jsonl"))
    queue_path = os.path.join(args.data, "queue.json")
    if args.dry:
        from types import SimpleNamespace

        class FakeOutbox:
            def __init__(self):
                self.contents = {}
                self.tasks = {}
            def upsert_content(self, *a, **k):
                pass
            def ensure_from_archive(self, ckey, gid, *a, **k):
                self.tasks[gid + "|" + ckey] = {"gid": gid, "ckey": ckey, "state": "pending"}
            def save(self, force=False):
                pass
        outbox = FakeOutbox()
    else:
        outbox = Outbox(os.path.join(args.data, "outbox.json"), archive, env)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rep = migrate_v1(
        queue_path, outbox, archive, env,
        dump_path=os.path.join(args.data, "queue_archive.jsonl"),
        backup_path=os.path.join(args.data, "queue.v1-%s.json" % stamp),
        dry=args.dry,
    )
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0 if rep.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_cli())
