# -*- coding: utf-8 -*-
"""sticker_hash_index.py <图库根目录> [旧索引 json 路径]
给整个表情图库算 16x16 dHash（256 bit，64 位 hex），输出 {相对路径: hash}。
为什么不用 aHash 8x8（老 sticker_hash.py）：8x8 只有 64 bit，白底表情包彼此撞得很凶——
实测「疑惑.jpg」和「q笑17.jpg」算出来一模一样，拿它认图库会认错人。
8x8 → 16x16 后区分度够了（同图重压缩仍然几乎不变）。
- 只算「索引里还没有」的图：老图片不重复解码，增量跑得快。
- 文件已经删掉的条目顺手清掉，索引里不留死路径。
- 只认 stickerFiles() 同一批格式；根目录只认 q 开头的情绪图。
输出 JSON：{"ok":true,"index":{...},"added":N,"total":N,"failed":N}
"""
import sys, os, json


def _dh(im):
    from PIL import Image
    im = im.convert('L').resize((17, 16), Image.LANCZOS)
    px = list(im.getdata())
    bits = []
    for row in range(16):
        base = row * 17
        for col in range(16):
            bits.append('1' if px[base + col] > px[base + col + 1] else '0')
    return f'{int("".join(bits), 2):064x}'


def hashes(path):
    """返回 1~2 个哈希。透明图返回 [白底, 黑底]：
    QQ 转存时可能把透明压成白底、也可能压成黑底，两种算出来差过 100 位
    （实测「震撼.gif」透明区 26.6%，白底 vs 黑底距离 101），只存一种会认不出。"""
    from PIL import Image
    im = Image.open(path)
    if im.mode in ('RGBA', 'LA', 'P', 'PA'):
        im = im.convert('RGBA')
        out = []
        for color in ((255, 255, 255, 255), (0, 0, 0, 255)):
            bg = Image.new('RGBA', im.size, color)
            bg.alpha_composite(im)
            out.append(_dh(bg))
        return out if out[0] != out[1] else out[:1]
    return [_dh(im)]


EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
SUBS = ('常用', '可用', '虚幻', '关键词触发', '少用')


def walk(root):
    out = []
    try:
        for f in os.listdir(root):
            p = os.path.join(root, f)
            if os.path.isfile(p) and f.lower().endswith(EXT) and f[:1].lower() == 'q' and not f[:2].lower() == 'qq':
                out.append(f)               # 根目录只认 q 开头的情绪图
    except OSError:
        pass
    for s in SUBS:
        d = os.path.join(root, s)
        try:
            for f in os.listdir(d):
                if os.path.isfile(os.path.join(d, f)) and f.lower().endswith(EXT):
                    out.append(s + '/' + f)
        except OSError:
            pass
    return out


def main():
    root = sys.argv[1]
    old_path = sys.argv[2] if len(sys.argv) > 2 else ''
    old = {}
    if old_path and os.path.exists(old_path):
        try:
            with open(old_path, 'r', encoding='utf-8') as fh:
                old = json.load(fh) or {}
        except Exception:
            old = {}
    # __v 是格式版本：2 = 每项可能是 [白底, 黑底] 两个哈希。老索引没有它，Node 侧会当成没索引重算。
    index, added, failed = {'__v': 2}, 0, 0
    for rel in walk(root):
        v = old.get(rel)
        if isinstance(v, str):
            v = [v] if len(v) == 64 else None
        if v and all(isinstance(x, str) and len(x) == 64 for x in v):
            index[rel] = v if len(v) > 1 else v[0]
            continue
        try:
            hs = hashes(os.path.join(root, rel))
            index[rel] = hs if len(hs) > 1 else hs[0]
            added += 1
        except Exception:
            failed += 1
    print(json.dumps({'ok': True, 'index': index, 'added': added, 'total': len(index), 'failed': failed},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
