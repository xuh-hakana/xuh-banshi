#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查冗余.py —— 记忆文件去重检查（纯本地，不联网、不调模型、不耗积分）

用法:
    python3 检查冗余.py            # 全量检查
    python3 检查冗余.py --brief    # 只报结论行

判据（对应 rules/任务-维护记忆.md）:
  1. 完全重复行（去空白·去标点后一致）           → 冗余
  2. 高相似行（相似度 ≥ 0.82 且 ≥16 字）         → 疑似换个说法讲同一件事
  3. 同文件内相邻行不比对（避免自己跟自己报）
  4. 跳过：标题、纯符号行、表格分隔、短行(<12 字)、代码围栏

退出码: 0=干净  1=发现冗余
"""
import os
import re
import sys
import difflib

ROOT = os.path.dirname(os.path.abspath(__file__))
CORE = ["MEMORY.md", "USER.md", "SOUL.md", "IDENTITY.md", "记忆一览.md"]
RULES_DIR = os.path.join(ROOT, "rules")
SKIP_DIR = "_存档"
MIN_LEN = 12          # 完全重复的最小字数
SIM_MIN_LEN = 16      # 相似比对的最小字数
SIM_THRESHOLD = 0.82  # 相似阈值

PUNCT = re.compile(r"[\s，。、；：！？（）()\[\]【】「」《》\"'`~\-—…·|>*#_=+,.;:!?/\\]+")
PREFIX = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s*|#{1,6}\s+)?")


def norm(s):
    """归一化：去标点空白，用于比对"""
    return PUNCT.sub("", PREFIX.sub("", s))


def is_noise(line):
    t = line.strip()
    if not t:
        return True
    if t.startswith(">") or t.startswith("---"):
        return True
    if set(t) <= set("-|= *"):
        return True
    if t.startswith("|"):
        return True  # 表格行跳过：多个表用同一套列名必然误报，且表格内容重复价值低
    if len(norm(t)) < MIN_LEN:
        return True
    return False


def collect():
    files = []
    for f in CORE:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            files.append(p)
    if os.path.isdir(RULES_DIR):
        for name in sorted(os.listdir(RULES_DIR)):
            if name.endswith(".md") and SKIP_DIR not in name:
                files.append(os.path.join(RULES_DIR, name))
    return files


def load(files):
    items = []  # (relpath, lineno, raw, norm)
    for p in files:
        rel = os.path.relpath(p, ROOT)
        in_code = False
        with open(p, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                s = line.rstrip("\n")
                if s.strip().startswith("```"):
                    in_code = not in_code
                    continue
                if in_code or is_noise(s):
                    continue
                items.append((rel, i, s.strip(), norm(s)))
    return items


def main():
    brief = "--brief" in sys.argv
    files = collect()
    items = load(files)

    # 文件体量（只统计，不作阈值）
    sizes = []
    for p in files:
        n = len(open(p, encoding="utf-8").read())
        sizes.append((os.path.relpath(p, ROOT), n))

    exact = {}
    for rel, ln, raw, nrm in items:
        exact.setdefault(nrm, []).append((rel, ln, raw))

    dup_exact = {k: v for k, v in exact.items() if len({x[0] for x in v}) > 1 or len(v) > 1}

    # 相似比对：字符集粗筛 → 精确算
    similar = []
    sets = [(rel, ln, raw, frozenset(nrm)) for rel, ln, raw, nrm in items if len(nrm) >= SIM_MIN_LEN]
    seen_pairs = set()
    for i in range(len(sets)):
        r1, l1, t1, s1 = sets[i]
        for j in range(i + 1, len(sets)):
            r2, l2, t2, s2 = sets[j]
            if r1 == r2 and abs(l1 - l2) <= 2:
                continue
            union = len(s1 | s2)
            if not union or len(s1 & s2) / union < 0.55:
                continue
            ratio = difflib.SequenceMatcher(None, t1, t2).ratio()
            if ratio >= SIM_THRESHOLD:
                key = tuple(sorted([(r1, l1), (r2, l2)]))
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                similar.append((ratio, r1, l1, t1, r2, l2, t2))

    # 输出
    print("=" * 66)
    print("记忆冗余检查　扫描 %d 个文件 / %d 条有效行" % (len(files), len(items)))
    print("=" * 66)
    if not brief:
        print("\n[文件体量]　仅记录，不作阈值")
        for rel, n in sorted(sizes, key=lambda x: -x[1]):
            print("  %6d  %s" % (n, rel))
        print("  合计 %6d" % sum(n for _, n in sizes))

    print("\n[完全重复]　%d 组" % len(dup_exact))
    for k, v in dup_exact.items():
        if brief:
            print("  · %s" % v[0][2][:40])
            continue
        print("  ✗「%s」" % v[0][2][:60])
        for rel, ln, raw in v:
            print("      %s:%d" % (rel, ln))

    print("\n[疑似同义]　%d 组（相似度 ≥ %.2f）" % (len(similar), SIM_THRESHOLD))
    for ratio, r1, l1, t1, r2, l2, t2 in similar:
        print("  ~ %.0f%%" % (ratio * 100))
        print("      %s:%d  %s" % (r1, l1, t1[:60]))
        print("      %s:%d  %s" % (r2, l2, t2[:60]))

    total = len(dup_exact) + len(similar)
    print("\n" + "-" * 66)
    if total == 0:
        print("结论：干净。无完全重复、无同义重复。")
    else:
        print("结论：发现 %d 处需处理（完全重复 %d + 疑似同义 %d）。" % (total, len(dup_exact), len(similar)))
        print("处理规则：留主文件完整版，别处改成 `见 <文件名>`；同义的合并到所属场景文件。")
        print("依据：rules/任务-维护记忆.md")
    print("-" * 66)
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
