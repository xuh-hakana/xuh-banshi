'use strict';
/*
 * clips.js —— AI 画面（场景 B）
 *
 * 主路：智谱 CogVideoX-Flash 文生视频（实测 2026-11-25：HTTP 200、免费、异步任务）
 * 兜底：智谱 CogView-3-Flash 文生图 → ffmpeg zoompan 做缓慢推拉，凑一个 5 秒片段
 * 这样即使视频模型排不上队/限额，也永远有画面可剪。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const keys = require('./keys');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

function base(provider = 'zhipu') {
  return (keys.base(provider) || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
}

async function post(url, body, key, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 300));
    return JSON.parse(txt);
  } finally { clearTimeout(t); }
}

async function download(url, out) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 300000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    return out;
  } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 提交一个文生视频任务，返回 id */
async function submitVideo(prompt, o = {}) {
  const key = keys.get('zhipu');
  if (!key) throw new Error('没有 zhipu key');
  const model = o.model || 'cogvideox-flash';
  const j = await post(base() + '/videos/generations', { model, prompt: String(prompt).slice(0, 900) }, key);
  const id = j.id || (j.data && j.data.id);
  if (!id) throw new Error('提交没拿到 task id: ' + JSON.stringify(j).slice(0, 200));
  return { id, model, raw: j };
}

/** 轮询到出片，返回视频 url */
async function pollVideo(id, o = {}) {
  const key = keys.get('zhipu');
  const interval = o.pollIntervalMs || 5000;
  const timeout = o.pollTimeoutMs || 480000;
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    const r = await fetch(base() + '/async-result/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + key },
    });
    const j = await r.json();
    const st = String(j.task_status || '');
    last = st;
    if (st === 'SUCCESS') {
      const url = (j.video_result && j.video_result[0] && j.video_result[0].url)
        || (j.data && j.data[0] && j.data[0].url);
      if (!url) throw new Error('成功了但没给 url: ' + JSON.stringify(j).slice(0, 300));
      return url;
    }
    if (st === 'FAIL') throw new Error('视频任务失败: ' + JSON.stringify(j).slice(0, 300));
    await sleep(interval);
  }
  throw new Error('视频任务超时（' + Math.round(timeout / 1000) + 's，最后状态 ' + last + '）');
}

/** 生成一个片段；video 失败自动降级成图 + zoompan */
async function makeClip(prompt, outMp4, o = {}) {
  const notes = [];
  const model = o.videoModel || 'cogvideox-flash';
  if (o.useVideo !== false) {
    try {
      const s = await submitVideo(prompt, { model });
      notes.push('video-submit ' + s.id);
      const url = await pollVideo(s.id, o);
      notes.push('video-poll ok');
      const tmp = outMp4.replace(/\.mp4$/, '.raw.mp4');
      await download(url, tmp);
      // 统一到目标分辨率/帧率/时长
      const w = o.width || 1920, h = o.height || 1080, fps = o.fps || 30, sec = o.seconds || 5;
      const r = spawnSync(FFMPEG, ['-y', '-i', tmp, '-t', String(sec),
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', outMp4,
      ], { encoding: 'utf8' });
      try { fs.unlinkSync(tmp); } catch {}
      if (r.status !== 0) throw new Error('ffmpeg 规整失败: ' + (r.stderr || '').slice(-200));
      notes.push('video ok');
      return { ok: true, kind: 'video', path: outMp4, notes };
    } catch (e) {
      notes.push('video failed: ' + e.message.slice(0, 160));
      if (o.noFallback) throw e;
    }
  }

  // 兜底：图 → zoompan
  const key = keys.get('zhipu');
  const j = await post(base() + '/images/generations', {
    model: o.imageModel || 'cogview-3-flash', prompt: String(prompt).slice(0, 900), size: o.imageSize || '1440x960',
  }, key, 180000);
  const url = j.data && j.data[0] && j.data[0].url;
  if (!url) throw new Error('出图没给 url: ' + JSON.stringify(j).slice(0, 200));
  const png = outMp4.replace(/\.mp4$/, '.png');
  await download(url, png);
  notes.push('image ok');
  const w = o.width || 1920, h = o.height || 1080, fps = o.fps || 30, sec = o.seconds || 5;
  const frames = Math.round(sec * fps);
  const vf = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps}`;
  const r = spawnSync(FFMPEG, ['-y', '-loop', '1', '-i', png, '-t', String(sec), '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', outMp4,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zoompan 失败: ' + (r.stderr || '').slice(-300));
  notes.push('image ok');
  return { ok: true, kind: 'image', path: outMp4, notes };
}

module.exports = { makeClip, submitVideo, pollVideo, download };
