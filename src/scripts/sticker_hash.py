# -*- coding: utf-8 -*-
"""sticker_hash.py <图片路径> [a8|d16]
a8（默认）: 8x8 aHash hex —— 收图去重用的老口径，别改，stickerPHash 默认吃这个
d16       : 16x16 dHash hex（256 bit）—— 图库认图用，区分度够（8x8 白底表情包会互撞）
"""
import sys, json


def ahash(path):
    from PIL import Image
    im = Image.open(path).convert('L').resize((8, 8), Image.LANCZOS)
    px = list(im.getdata())
    avg = sum(px) / 64.0
    bits = ''.join('1' if p >= avg else '0' for p in px)
    return f'{int(bits, 2):016x}'


def flat_gray(path):
    from PIL import Image
    im = Image.open(path)
    # 透明底必须先铺白底，否则透明区被当成同色，整张图算出来一模一样
    if im.mode in ('RGBA', 'LA', 'P', 'PA'):
        im = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert('L')


def dhash16(path):
    from PIL import Image
    im = flat_gray(path).resize((17, 16), Image.LANCZOS)
    px = list(im.getdata())
    bits = []
    for row in range(16):
        base = row * 17
        for col in range(16):
            bits.append('1' if px[base + col] > px[base + col + 1] else '0')
    return f'{int("".join(bits), 2):064x}'


if __name__ == '__main__':
    try:
        mode = sys.argv[2] if len(sys.argv) > 2 else 'a8'
        h = dhash16(sys.argv[1]) if mode == 'd16' else ahash(sys.argv[1])
        print(json.dumps({'ok': True, 'h': h}))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:200]}))
