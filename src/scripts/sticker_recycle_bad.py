# -*- coding: utf-8 -*-
"""把不符合表情包规则的图批量挪进 回收站/（2026-11-22 主人要求：先观察）。
规则同 src/scripts/sticker_kind.py：截图、插画、漫画整页不收；
只有「色数 ≤40 且边缘 ≤0.10」的简单单格漫画保留。
产出：data/stickers/.kind_moved.json（清单），并同步清理 .md5.json / .phash.json 里指向已挪走文件的条目。
"""
import os, sys, json, shutil, time
from multiprocessing import Pool

ROOT = "/Volumes/980/xuhuan mac/xuhbot"
D = os.path.join(ROOT, "src", "data", "stickers")
REC = os.path.join(D, "回收站")
DIRS = ["常用", "可用", "关键词触发", "少用", "难用", "大图", "虚幻"]
EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")
sys.path.insert(0, os.path.join(ROOT, "src", "scripts"))


def work(args):
    rel, path = args
    try:
        from sticker_kind import classify
        kind, simple, m = classify(path)
        return rel, kind, simple, m
    except Exception as e:
        return rel, "error:" + str(e)[:60], False, {}


def main():
    os.makedirs(REC, exist_ok=True)
    jobs = []
    for d in DIRS:
        p = os.path.join(D, d)
        if not os.path.isdir(p):
            continue
        for name in sorted(os.listdir(p)):
            if os.path.splitext(name)[1].lower() in EXTS:
                jobs.append((d + "/" + name, os.path.join(p, name)))
    total = len(jobs)
    moved, kept, errors = [], 0, []
    try:
        prev = json.load(open(os.path.join(D, ".kind_moved.partial.json"), encoding="utf-8"))
        moved = prev.get("moved") or []
    except Exception:
        pass
    print("start", total, flush=True)
    with Pool(4) as pool:
        for i, (rel, kind, simple, m) in enumerate(pool.imap_unordered(work, jobs, chunksize=4), 1):
            if kind.startswith("error:"):
                errors.append({"rel": rel, "err": kind})
                kept += 1
            elif kind in ("screenshot", "illustration") or (kind == "manga_page" and not simple):
                base = os.path.basename(rel)
                dst = os.path.join(REC, base)
                if os.path.exists(dst):
                    dst = os.path.join(REC, os.path.dirname(rel) + "__" + base)
                try:
                    shutil.move(os.path.join(D, rel), dst)
                    moved.append({"from": rel, "to": os.path.basename(dst), "kind": kind, "m": m})
                except Exception as e:
                    errors.append({"rel": rel, "err": "move:" + str(e)[:60]})
                    kept += 1
            else:
                kept += 1
            if i % 100 == 0:
                print("progress %d/%d moved=%d" % (i, total, len(moved)), flush=True)
                with open(os.path.join(D, ".kind_moved.partial.json"), "w", encoding="utf-8") as f:
                    json.dump({"total": total, "done": i, "moved": moved}, f, ensure_ascii=False)
    report = {"at": int(time.time()), "total": total, "kept": kept,
              "moved": len(moved), "errors": errors, "items": moved}
    with open(os.path.join(D, ".kind_moved.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    try:
        os.remove(os.path.join(D, ".kind_moved.partial.json"))
    except OSError:
        pass

    moved_to = {m["to"] for m in moved}
    moved_from = {m["from"] for m in moved}
    ts = time.strftime("%Y%m%d-%H%M%S")
    # .md5.json：删掉指向已挪走文件的条目
    md5_path = os.path.join(D, ".md5.json")
    try:
        shutil.copy2(md5_path, md5_path + ".bak-" + ts)
        data = json.load(open(md5_path, encoding="utf-8"))
        drop = [k for k, v in data.items()
                if isinstance(v, dict) and str(v.get("f") or "") in moved_from]
        for k in drop:
            data.pop(k, None)
        json.dump(data, open(md5_path, "w", encoding="utf-8"), ensure_ascii=False)
        print("md5 pruned", len(drop), flush=True)
    except Exception as e:
        print("md5 prune failed", e, flush=True)
    # .phash.json：路径键直接删
    ph_path = os.path.join(D, ".phash.json")
    try:
        shutil.copy2(ph_path, ph_path + ".bak-" + ts)
        data = json.load(open(ph_path, encoding="utf-8"))
        drop = [k for k in data if k in moved_from]
        for k in drop:
            data.pop(k, None)
        json.dump(data, open(ph_path, "w", encoding="utf-8"), ensure_ascii=False)
        print("phash pruned", len(drop), flush=True)
    except Exception as e:
        print("phash prune failed", e, flush=True)
    print("DONE moved=%d kept=%d errors=%d" % (len(moved), kept, len(errors)), flush=True)


if __name__ == "__main__":
    main()
