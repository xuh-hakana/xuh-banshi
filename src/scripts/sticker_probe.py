# -*- coding: utf-8 -*-
"""sticker_probe.py <图片路径> —— 一次解码出 a8(8x8 aHash) + d16(16x16 dHash) + kind/simple。

2026-11-23 主人定：收一张图原来要起 3 个 python 进程（kind + aHash + dHash16），
现在统一成 1 个进程一次算完，口径完全不变（复用 sticker_kind.py / sticker_hash.py 的实现）。
"""
import sys, os, json

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'err': 'no path'}))
        return
    p = sys.argv[1]
    out = {'ok': True, 'a8': '', 'd16': '', 'kind': 'sticker', 'simple': True}
    try:
        import sticker_hash as SH
        out['a8'] = SH.ahash(p)
        out['d16'] = SH.dhash16(p)
    except Exception as e:
        out['h_err'] = str(e)[:160]
    try:
        import sticker_kind as SK
        kind, simple, m = SK.classify(p)
        out['kind'] = kind
        out['simple'] = bool(simple)
        out['m'] = m
    except Exception as e:
        out['k_err'] = str(e)[:160]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
