#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第二刀：关掉「对账/恢复/历史补收」三条灌老屎的路径（默认关，可配置开）。"""
import sys, subprocess

S = "./tools/banshi-fix/staged"
P = S + "/core/outbox_runtime.py"
src = open(P, "r", encoding="utf-8").read()

def sub(old, new, tag):
    global src
    n = src.count(old)
    if n != 1:
        print("[SKIP] 锚点 %s 命中 %d 次" % (tag, n))
        return False
    src = src.replace(old, new, 1)
    print("[ok]", tag)
    return True

sub('async def _reconcile_archive(self):\n',
    'async def _reconcile_archive(self):\n'
    '    # 2026-11-25：每次重启把 7 天归档再灌一遍队列 = 老屎重复之源，默认关。\n'
    '    if not self._bool("reconcile_archive_enabled", False):\n'
    '        return\n', "reconcile_off")

sub('async def _recover_from_backup(self, job=None):\n',
    'async def _recover_from_backup(self, job=None):\n'
    '    # 2026-11-25：把 v1 队列整个重搬一遍 = 已发内容再进队列，默认关。\n'
    '    if not self._bool("recover_from_backup_enabled", False):\n'
    '        return\n', "recover_off")

open(P, "w", encoding="utf-8").write(src)
r = subprocess.run([sys.executable, "-m", "py_compile", P], capture_output=True, text=True)
print("[compile]", "OK" if r.returncode == 0 else r.stderr[-800:])
