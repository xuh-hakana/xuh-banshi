'use strict';
/* mediagen/frames.js —— 调 liveframe.py 出帧，ffmpeg 直接吃 rawvideo（不落中间图） */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PY = path.join(ROOT, 'data', 'vendor', 'mpt-venv', 'bin', 'python');
const LIVE = path.join(__dirname, 'liveframe.py');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

function buildCfg(o) {
  const shots = (o.shots || []).map(s => ({
    id: s.id, img: s.img, keyout: s.keyout !== false, eye: s.eye || null,
    seed: s.seed || 1.1, scale: s.scale || 0.88,
    t0: s.t0, t1: s.t1,
    lines: (s.lines || []).map(l => ({ t0: l.t0, t1: l.t1, text: l.text, wav: l.wav })),
  }));
  return {
    width: o.width || 1920, height: o.height || 1080, fps: o.fps || 30,
    totalSec: o.totalSec, bg: o.bg || { c1: [252, 232, 241], c2: [255, 248, 251] }, shots,
  };
}

function run(cfgPath, outMp4, audioWav) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const W = cfg.width, H = cfg.height, fps = cfg.fps;
  return new Promise((resolve) => {
    const py = spawn(PY, [LIVE, cfgPath, '--raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', W + 'x' + H, '-r', String(fps), '-i', '-',
      '-i', audioWav,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', outMp4,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let pyErr = '', ffErr = '';
    py.stderr.on('data', d => { pyErr += d.toString(); if (pyErr.length > 4000) pyErr = pyErr.slice(-4000); });
    ff.stderr.on('data', d => { ffErr += d.toString(); if (ffErr.length > 4000) ffErr = ffErr.slice(-4000); });
    py.stdout.pipe(ff.stdin);
    let codePy = null, codeFf = null;
    const done = () => {
      if (codePy === null || codeFf === null) return;
      resolve({ ok: codePy === 0 && codeFf === 0 && fs.existsSync(outMp4), codePy, codeFf, pyErr: pyErr.slice(-800), ffErr: ffErr.slice(-800), out: outMp4 });
    };
    py.on('close', c => { codePy = c; done(); });
    ff.on('close', c => { codeFf = c; done(); });
    ff.stdin.on('error', () => {});
  });
}

function still(cfgPath, idx, outPng) {
  return new Promise((resolve) => {
    const p = spawn(PY, [LIVE, cfgPath, '--still', String(idx), outPng], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    p.stderr.on('data', d => { e += d.toString(); });
    p.on('close', c => resolve({ ok: c === 0 && fs.existsSync(outPng), code: c, err: e.slice(-500), out: outPng }));
  });
}

function probeDuration(file) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) ? d : 0;
}
module.exports = { buildCfg, run, still, probeDuration, PY, LIVE, FFMPEG };
