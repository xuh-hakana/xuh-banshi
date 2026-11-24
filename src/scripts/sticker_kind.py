# -*- coding: utf-8 -*-
"""sticker_kind.py <图片路径> [--json]
判断这张图属于哪一类，给收图链路当闸门用（2026-11-22 主人定：
以后不收截图、插画，漫画只收简单的）。

输出 JSON: {"ok":true,"kind":"sticker|screenshot|illustration|manga_page|manga_simple",
            "simple":bool,"m":{...指标...}}

判断顺序（指标都在 128x128 归一化后算，与分辨率无关）：
  1. 界面截图：OCR 文字框 ≥12 个、中位行高 ≤3%、最大行高 ≤6%（视频/论坛/聊天室界面）
  2. 插画：量化色数 ≥110 且白底 <30%（精美立绘/大图，不是表情包）
  3. 漫画页：长宽比 ≤0.75、白底 ≥30%、边缘密度 ≥0.09（整页分镜）
     - 复杂页 reject；只有「色数 ≤40 且边缘 ≤0.10」的单格简单漫画才收
  4. 其余算表情包
"""
import sys, json


def load(path):
    from PIL import Image
    im = Image.open(path)
    im.load()
    if im.mode in ('RGBA', 'LA', 'P', 'PA'):
        im = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert('RGB')


def metrics(im):
    import numpy as np
    w, h = im.size
    a = np.asarray(im.resize((128, 128)), dtype=np.float32)
    g = a.mean(axis=2)
    edge = float(abs(np.diff(g, axis=1)).mean() + abs(np.diff(g, axis=0)).mean()) / 255.0
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = float(((mx - mn) / np.maximum(mx, 1)).mean())
    white = float((g > 235).mean())
    q = (a // 32).astype(int)
    colors = len(set(map(tuple, q.reshape(-1, 3))))
    return {
        'w': w, 'h': h,
        'ratio': round(w / float(h), 3) if h else 0,
        'edge': round(edge, 4), 'sat': round(sat, 3),
        'white': round(white, 3), 'colors': colors,
    }


def ocr_stats(path, h):
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception:
        return None
    try:
        eng = RapidOCR()
        res, _ = eng(path)
    except Exception:
        return None
    if not res:
        return {'nbox': 0, 'medh': 0.0, 'maxh': 0.0}
    hs = []
    for item in res:
        try:
            ys = [float(p[1]) for p in item[0]]
        except Exception:
            continue
        if len(ys) >= 2:
            hs.append((max(ys) - min(ys)) / float(h or 1))
    if not hs:
        return {'nbox': 0, 'medh': 0.0, 'maxh': 0.0}
    hs.sort()
    return {'nbox': len(hs), 'medh': round(hs[len(hs) // 2], 4), 'maxh': round(hs[-1], 4)}


def classify(path):
    im = load(path)
    m = metrics(im)
    # 快速通道：方形/横版、色数不高、白底不多、线条不密 —— 典型表情包，不用跑 OCR
    # （OCR 是这条链路里最慢的一步，1929 张全跑要半小时以上）
    if (m['ratio'] >= 0.75 and m['colors'] <= 105
            and m['white'] < 0.30 and m['edge'] < 0.11):
        m['ocr'] = None
        return 'sticker', True, m
    o = ocr_stats(path, m['h'])
    m['ocr'] = o
    if o and o['nbox'] >= 12 and o['medh'] <= 0.03 and o['maxh'] <= 0.06:
        return 'screenshot', False, m
    # 插画只认「大图 + 高色数 + 无白底 + 细节密」四样齐全的，避免把高清表情包误杀
    # （2026-11-22 主人反馈：152 张里 44 张彩色表情包被误判成插画，放宽后误杀 0，靠描述兜底）
    if (m['colors'] >= 140 and m['w'] * m['h'] >= 1000000
            and m['white'] < 0.10 and m['edge'] >= 0.115):
        return 'illustration', False, m
    if m['ratio'] <= 0.72 and m['white'] >= 0.30 and m['edge'] >= 0.09:
        simple = m['colors'] <= 40 and m['edge'] <= 0.10
        return ('manga_simple' if simple else 'manga_page'), simple, m
    return 'sticker', True, m


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'err': 'no path'}, ensure_ascii=False))
        return
    try:
        kind, simple, m = classify(sys.argv[1])
        print(json.dumps({'ok': True, 'kind': kind, 'simple': simple, 'm': m}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'err': str(e)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
