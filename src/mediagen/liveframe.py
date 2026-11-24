#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""liveframe.py —— 2.5D「live2D 风格」动态立绘帧渲染（Pillow 直出 rawvideo 给 ffmpeg）
用法:
  python liveframe.py cfg.json --raw            # rgb24 帧流写 stdout
  python liveframe.py cfg.json --still 120 out.png
cfg: {width,height,fps,totalSec,bg:{c1,c2},shots:[{id,img,keyout,eye,t0,t1,lines:[{t0,t1,text,wav}]}]}
"""
import json, math, os, sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FF = "/System/Library/Fonts/Supplemental/Songti.ttc"
FONT_CANDIDATES = [
    "./data/vendor/mpt-home/resource/fonts/MicrosoftYaHeiBold.ttc",
    "./data/vendor/mpt-home/resource/fonts/STHeitiMedium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]
def font_path():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None

def load_cfg(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)

def gradient(w, h, c1, c2):
    a = np.linspace(0.0, 1.0, h).reshape(h, 1, 1)
    top = np.array(c1, dtype=np.float32).reshape(1, 1, 3)
    bot = np.array(c2, dtype=np.float32).reshape(1, 1, 3)
    arr = (top * (1 - a) + bot * a)
    arr = np.repeat(arr, w, axis=1)
    # 加一点柔光斑
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    glow = np.exp(-(((xx - w * 0.5) ** 2) / (2 * (w * 0.42) ** 2) + ((yy - h * 0.38) ** 2) / (2 * (h * 0.42) ** 2)))
    arr = arr + glow[:, :, None] * 26.0
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")

def keyout(im):
    """四角取样判底色：纯白/近纯色就按色距抠成透明"""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    base = np.array([sum(c[i] for c in corners) / 4.0 for i in range(3)])
    spread = max(float(np.abs(np.array(c[:3]) - base).max()) for c in corners)
    if spread > 26 or base.min() < 180:
        return im, False
    arr = np.asarray(im).astype(np.float32)
    dist = np.abs(arr[:, :, :3] - base.reshape(1, 1, 3)).max(axis=2)
    alpha = np.clip((dist - 26.0) / 26.0, 0.0, 1.0)
    alpha = (alpha * 255).astype(np.uint8)
    out = arr.astype(np.uint8).copy()
    out[:, :, 3] = alpha
    img = Image.fromarray(out, "RGBA")
    # 边缘柔化
    a = img.split()[3].filter(ImageFilter.GaussianBlur(1.2))
    img.putalpha(a)
    return img, True

def rms_envelope(wav_path, fps, t0, t1):
    """把一段 wav 压成 [0..1] 的逐帧能量，给口型用"""
    n = max(1, int(round((t1 - t0) * fps)))
    try:
        with wave.open(wav_path, "rb") as w:
            ch, sw, sr = w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(w.getnframes())
        if sw != 2:
            return np.zeros(n, dtype=np.float32)
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        if ch > 1:
            a = a.reshape(-1, ch).mean(axis=1)
        a = a / 32768.0
        hop = max(1, len(a) // n)
        env = np.zeros(n, dtype=np.float32)
        for i in range(n):
            seg = a[i * hop:(i + 1) * hop]
            env[i] = float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0
        m = float(env.max())
        if m > 1e-6:
            env = env / m
        # 平滑，别抖
        k = np.array([0.25, 0.5, 0.25])
        env = np.convolve(env, k, mode="same")
        return np.clip(env, 0, 1)
    except Exception:
        return np.zeros(n, dtype=np.float32)

class Renderer:
    def __init__(self, cfg):
        self.cfg = cfg
        self.W = int(cfg.get("width", 1920))
        self.H = int(cfg.get("height", 1080))
        self.fps = int(cfg.get("fps", 30))
        self.bg = gradient(self.W, self.H, cfg.get("bg", {}).get("c1", [250, 230, 240]),
                           cfg.get("bg", {}).get("c2", [255, 248, 252]))
        fp = font_path()
        self.font = ImageFont.truetype(fp, 58) if fp else ImageFont.load_default()
        self.font_small = ImageFont.truetype(fp, 34) if fp else self.font
        self.shots = cfg.get("shots", [])
        self._portrait = {}
        self._bubble = {}
        self._env = {}
        for s in self.shots:
            self._prep(s)

    def _prep(self, s):
        img = Image.open(s["img"])
        img, keyed = keyout(img) if s.get("keyout", True) else (img.convert("RGBA"), False)
        s["_keyed"] = keyed
        target_h = int(self.H * float(s.get("scale", 0.88)))
        ratio = target_h / img.size[1]
        bw = max(1, int(img.size[0] * ratio))
        base = img.resize((bw, target_h), Image.LANCZOS)
        m = 46
        canvas = Image.new("RGBA", (bw + m * 2, target_h + m * 2), (0, 0, 0, 0))
        canvas.paste(base, (m, m), base)
        if not keyed:
            msk = Image.new("L", canvas.size, 0)
            ImageDraw.Draw(msk).rounded_rectangle([0, 0, canvas.size[0] - 1, canvas.size[1] - 1],
                                                  radius=int(min(canvas.size) * 0.055), fill=255)
            canvas.putalpha(Image.composite(canvas.split()[3], Image.new("L", canvas.size, 0), msk))
        sh = Image.new("RGBA", canvas.size, (74, 34, 52, 0))
        sh.putalpha(canvas.split()[3].point(lambda v: int(v * 0.30)))
        s["_shadow"] = sh.filter(ImageFilter.GaussianBlur(16))
        s["_canvas"] = canvas
        s["_margin"] = m
        s["_box"] = (bw, target_h)
        for i, ln in enumerate(s.get("lines", [])):
            if ln.get("wav") and os.path.exists(ln["wav"]):
                self._env[(s["id"], i)] = rms_envelope(ln["wav"], self.fps, ln["t0"], ln["t1"])

    def _bubble_img(self, text, sub=False):
        key = (text, sub)
        if key in self._bubble:
            return self._bubble[key]
        f = self.font_small if sub else self.font
        pad_x, pad_y = 44, 26
        tmp = Image.new("RGBA", (10, 10))
        d = ImageDraw.Draw(tmp)
        box = d.textbbox((0, 0), text, font=f)
        tw, th = box[2] - box[0], box[3] - box[1]
        w, h = tw + pad_x * 2, th + pad_y * 2
        im = Image.new("RGBA", (int(w), int(h)), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(h / 2.4), fill=(255, 255, 255, 232), outline=(232, 130, 168, 255), width=4)
        d.text((pad_x - box[0], pad_y - box[1]), text, font=f, fill=(74, 46, 58, 255))
        self._bubble[key] = im
        return im

    def _shot_at(self, t):
        for s in self.shots:
            if s["t0"] <= t < s["t1"]:
                return s
        return self.shots[-1] if self.shots else None

    def _line_at(self, s, t):
        for i, ln in enumerate(s.get("lines", [])):
            if ln["t0"] <= t < ln["t1"]:
                return i, ln
        return None, None

    def frame(self, t):
        s = self._shot_at(t)
        fr = self.bg.copy()
        if s is None:
            return fr
        canvas = s["_canvas"]
        bw, bh = canvas.size
        cx, cy = bw / 2.0, bh / 2.0
        osc = t - s["t0"]
        breath = 1.0 + 0.006 * math.sin(2 * math.pi * osc / 3.4)
        dx = 3.0 * math.sin(2 * math.pi * osc / 4.7)
        dy = 5.0 * math.sin(2 * math.pi * osc / 2.9)
        li, ln = self._line_at(s, t)
        amp = 0.0
        if li is not None:
            env = self._env.get((s["id"], li))
            if env is not None:
                idx = int((t - ln["t0"]) * self.fps)
                if 0 <= idx < len(env):
                    amp = float(env[idx])
            dy += amp * 2.5 * math.sin(2 * math.pi * osc / 0.55)
        scale = breath * (1.0 + 0.004 * amp)
        a = 1.0 / scale
        coeffs = (a, 0, cx * (1 - a) + dx, 0, a, cy * (1 - a) + dy)
        moved = canvas.transform((int(bw), int(bh)), Image.AFFINE, coeffs, resample=Image.BICUBIC)
        # 说话时下颌轻抬（下 30% 上移），只在能量大时动
        if amp > 0.06:
            y0 = int(bh * 0.70)
            band = moved.crop((0, y0, bw, bh))
            shifted = Image.new("RGBA", band.size, (0, 0, 0, 0))
            shifted.paste(band, (0, -int(round(amp * 4)) - 1))
            moved.paste(Image.new("RGBA", band.size, (0, 0, 0, 0)), (0, y0))
            moved.paste(shifted, (0, y0), shifted)
        # 眨眼：eye 给了才做（把眼部条带压扁一瞬）
        eye = s.get("eye")
        if eye:
            ph = (osc + float(s.get("seed", 1.1))) % 4.6
            if ph < 0.13:
                ex0, ey0, ex1, ey1 = [float(v) for v in eye]
                bx0, bx1 = int(bw * ex0), int(bw * ex1)
                by0, by1 = int(bh * ey0), int(bh * ey1)
                if bx1 > bx0 and by1 > by0:
                    band = moved.crop((bx0, by0, bx1, by1))
                    squashed = band.resize((bx1 - bx0, max(2, int((by1 - by0) * 0.35))), Image.BILINEAR)
                    moved.paste(moved.crop((bx0, by0, bx1, by1)).filter(ImageFilter.GaussianBlur(6)), (bx0, by0))
                    moved.paste(squashed, (bx0, by1 - squashed.size[1]), squashed)
        x = int((self.W - bw) / 2)
        y = int(self.H - bh + 26)
        fr.paste(s["_shadow"], (x + 8, y + 16), s["_shadow"])
        fr.paste(moved, (x, y), moved)
        # 字幕
        if ln is not None and ln.get("text"):
            bub = self._bubble_img(ln["text"])
            fade = min(1.0, (t - ln["t0"]) / 0.14, max(0.001, (ln["t1"] - t) / 0.16))
            fade = max(0.0, min(1.0, fade))
            if fade > 0.02:
                b = bub.copy()
                al = b.split()[3].point(lambda v: int(v * fade))
                b.putalpha(al)
                bx = int((self.W - b.size[0]) / 2)
                by = int(self.H - 168)
                fr.paste(b, (bx, by), b)
        return fr

def main():
    cfg_path = sys.argv[1]
    cfg = load_cfg(cfg_path)
    r = Renderer(cfg)
    if "--still" in sys.argv:
        i = sys.argv.index("--still")
        idx = int(sys.argv[i + 1])
        out = sys.argv[i + 2]
        t = idx / float(r.fps)
        r.frame(t).save(out)
        sys.stderr.write("still %s ok\n" % out)
        return
    total = float(cfg.get("totalSec", 1.0))
    n = int(round(total * r.fps))
    o = sys.stdout.buffer
    for i in range(n):
        fr = r.frame(i / float(r.fps)).convert("RGB")
        o.write(fr.tobytes())
        if i % 300 == 0:
            sys.stderr.write("frame %d/%d\n" % (i, n))
            sys.stderr.flush()
    o.flush()
    sys.stderr.write("done %d frames\n" % n)

if __name__ == "__main__":
    main()
