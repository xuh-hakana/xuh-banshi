'use strict';
/*
 * music.js —— 配乐（场景 C 的保底腿）
 *
 * 现状（2026-11-25 实测）：MiniMax 音乐 API 对新用户关闭（HTTP 410 / 2153），
 * SiliconFlow 余额不足，本机没有可用的音乐大模型 key → 所以默认走程序化编曲。
 * 好处是零成本、必成功、可指定 BPM/情绪；等哪天有 Mureka / Suno 兼容 key，
 * 在 src/config/media.json 把 music.provider 改成对应名字，接上 provider 即可。
 *
 * 产物：44.1kHz / 16bit / 立体声 wav，纯 Node 写 PCM，不依赖任何 npm 包。
 */
const fs = require('fs');
const path = require('path');

const SR = 44100;

/** 和弦进行（半音偏移，相对根音） */
const PROGRESSIONS = {
  calm: [[0, 4, 7, 11], [-3, 2, 5, 9], [-5, 0, 4, 7], [-7, -2, 2, 5]],
  warm: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [5, 9, 12]],
  cool: [[0, 3, 7, 10], [-2, 2, 5, 9], [-4, 0, 3, 7], [-5, -1, 2, 7]],
  epic: [[0, 7, 12], [-5, 2, 7], [-3, 4, 9], [-7, 0, 5]],
};

function noteHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

function envelope(t, dur, attack, release) {
  const a = Math.min(1, t / Math.max(0.001, attack));
  const r = Math.min(1, Math.max(0, (dur - t) / Math.max(0.001, release)));
  return a * r;
}

/**
 * 合成一段 BGM
 * @param {object} o { seconds, bpm, mood, root }
 * @returns {string} wav 路径
 */
function synth(o = {}) {
  const seconds = Math.max(6, Math.min(300, Number(o.seconds) || 40));
  const bpm = Math.max(50, Math.min(180, Number(o.bpm) || 96));
  const mood = PROGRESSIONS[String(o.mood || 'calm')] ? String(o.mood || 'calm') : 'calm';
  const prog = PROGRESSIONS[mood];
  const root = Number.isFinite(Number(o.root)) ? Number(o.root) : 57; // A3
  const beat = 60 / bpm;
  const barLen = beat * 4;
  const n = Math.floor(SR * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  // 1) 铺底 pad：每个和弦 4 拍
  const bars = Math.ceil(seconds / barLen);
  for (let b = 0; b < bars; b++) {
    const chord = prog[b % prog.length];
    const t0 = b * barLen;
    for (let vi = 0; vi < chord.length; vi++) {
      const midi = root + chord[vi] + (vi === 0 ? 0 : 0);
      const f = noteHz(midi);
      const pan = (vi / Math.max(1, chord.length - 1)) * 2 - 1;
      const gl = Math.sqrt((1 - pan) / 2), gr = Math.sqrt((1 + pan) / 2);
      const amp = 0.16 / Math.sqrt(chord.length);
      for (let i = Math.floor(t0 * SR); i < Math.min(n, Math.floor((t0 + barLen) * SR)); i++) {
        const t = i / SR - t0;
        const env = envelope(t, barLen, 0.35, 0.9);
        const s = (Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.18) * amp * env;
        left[i] += s * gl; right[i] += s * gr;
      }
    }
  }

  // 2) 心跳式低音：每拍一下
  const kicks = Math.floor(seconds / beat);
  for (let k = 0; k < kicks; k++) {
    const t0 = k * beat;
    const f0 = 96, f1 = 46;
    const amp = k % 4 === 0 ? 0.30 : 0.16;
    for (let i = Math.floor(t0 * SR); i < Math.min(n, Math.floor((t0 + 0.28) * SR)); i++) {
      const t = i / SR - t0;
      const f = f1 + (f0 - f1) * Math.exp(-t * 22);
      const env = Math.exp(-t * 9);
      const s = Math.sin(2 * Math.PI * f * t) * amp * env;
      left[i] += s; right[i] += s;
    }
  }

  // 3) 稀疏旋律：每两拍一个音，五声音阶
  const penta = [0, 2, 4, 7, 9, 12, 14, 16];
  const steps = Math.floor(seconds / (beat * 2));
  for (let s = 0; s < steps; s++) {
    const t0 = s * beat * 2;
    if (s % 3 === 1) continue; // 留白
    const midi = root + 12 + penta[(s * 7 + 3) % penta.length];
    const f = noteHz(midi);
    const dur = beat * 1.4;
    const amp = 0.075;
    for (let i = Math.floor(t0 * SR); i < Math.min(n, Math.floor((t0 + dur) * SR)); i++) {
      const t = i / SR - t0;
      const env = envelope(t, dur, 0.02, 0.5) * Math.exp(-t * 1.6);
      const s2 = Math.sin(2 * Math.PI * f * t) * amp * env;
      left[i] += s2 * 0.9; right[i] += s2 * 1.0;
    }
  }

  // 4) 软限幅 + 淡入淡出
  const fade = Math.floor(SR * 0.6);
  for (let i = 0; i < n; i++) {
    let l = Math.tanh(left[i] * 1.2) * 0.9;
    let r = Math.tanh(right[i] * 1.2) * 0.9;
    if (i < fade) { const g = i / fade; l *= g; r *= g; }
    if (i > n - fade) { const g = (n - i) / fade; l *= g; r *= g; }
    left[i] = l; right[i] = r;
  }

  return writeWav(o.out, left, right);
}

function writeWav(outPath, left, right) {
  const n = left.length;
  const dataBytes = n * 2 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), o); o += 2;
    buf.writeInt16LE(Math.round(r * 32767), o); o += 2;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function make(o = {}) {
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'media.json'), 'utf8')); } catch { return {}; } })();
  const m = cfg.music || {};
  const out = o.out || path.join(process.cwd(), 'bgm.wav');
  const provider = String(o.provider || m.provider || 'proc');
  if (provider !== 'proc') {
    // 预留：Mureka / Suno 兼容 —— 没 key 时明确失败，不假装成功
    const keys = require('./keys');
    if (!keys.has(provider)) throw new Error('music provider ' + provider + ' 没有可用 key（media.json.keys 里加）');
  }
  const p = synth({
    out,
    seconds: o.seconds || Math.max(12, Number(m.seconds) || 40),
    bpm: o.bpm || m.bpm || 96,
    mood: o.mood || m.mood || 'calm',
    root: o.root,
  });
  return { ok: true, path: p, provider: 'proc', bytes: fs.statSync(p).size };
}

module.exports = { make, synth };
