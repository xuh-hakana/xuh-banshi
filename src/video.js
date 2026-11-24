'use strict';
/*
 * video.js —— 看视频（主人 2026-11-22 定）
 *
 * 主人原话要的口径：
 *   默认：只看字幕前 60 字 + 每 8 秒截一帧、只截 3 张。
 *   有人发「笑点解析」：改看全部字幕 + 全部可截帧数。
 *
 * 为什么要单独一个文件：视频这条链是「下载 → ffprobe → 切帧 → 转字幕 → 视觉模型」，四步各有各的失败面，
 * 塞进 qq.js 会把那个已经 6000 行的消息链再撑一圈。这里只做「给我一个视频段，还我一段可读文案」。
 *
 * 字幕来源（2026-11-22 实测）：没有任何可用云 ASR —— SiliconFlow 余额不足(402)、Gemini key 是占位符、
 * AstrBot STT 没开、本机无 torch。所以走本机 whisper.cpp（brew install whisper-cpp + ggml 模型）。
 * 缺 whisper / 缺模型 / 超时 → 只丢字幕，画面照常，绝不抛错到消息链。
 *
 * 降级原则：任何一步失败都返回 \'\'（调用方换成 ［视频：没看出内容］），不阻塞回话、不刷屏重试。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ---------------- 配置（缺键全走默认，改 features.json 立即生效） ---------------- */
function cfg() {
  let v = {};
  try { v = require('./config').cfgLive().video || {}; } catch { v = {}; }
  return {
    enable: v.enable !== false,                       // 默认开
    frameIntervalSec: Number(v.frameIntervalSec) > 0 ? Number(v.frameIntervalSec) : 8,
    briefFrameCount: Number(v.briefFrameCount) > 0 ? Number(v.briefFrameCount) : 3,
    briefSubtitleChars: Number(v.briefSubtitleChars) > 0 ? Number(v.briefSubtitleChars) : 60,
    fullMaxFrames: Number(v.fullMaxFrames) > 0 ? Number(v.fullMaxFrames) : 24,
    maxFullSeconds: Number(v.maxFullSeconds) > 0 ? Number(v.maxFullSeconds) : 600,
    briefTimeoutMs: Number(v.briefTimeoutMs) > 0 ? Number(v.briefTimeoutMs) : 45000,
    fullTimeoutMs: Number(v.fullTimeoutMs) > 0 ? Number(v.fullTimeoutMs) : 180000,
    ffmpegBin: String(v.ffmpegBin || ''),
    ffprobeBin: String(v.ffprobeBin || ''),
    whisperBin: String(v.whisperBin || ''),
    ytdlpBin: String(v.ytdlpBin || ''),
    asrModel: String(v.asrModel || ''),
    asrLang: String(v.asrLang || 'zh'),
    asrThreads: Number(v.asrThreads) > 0 ? Number(v.asrThreads) : 4,
  };
}

/* ---------------- 找二进制 / 模型（mac 与 win 都给候选，找不到返回 \'\'） ---------------- */
function findBin(name, override, extra) {
  if (override && fs.existsSync(override)) return override;
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin',
    path.join(os.homedir(), '.workbuddy', 'binaries')];
  const names = [name].concat(Array.isArray(extra) ? extra : []);
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}
function bins() {
  const c = cfg();
  const ffmpeg = findBin('ffmpeg', c.ffmpegBin, ['ffmpeg.exe']);
  const ffprobe = findBin('ffprobe', c.ffprobeBin, ['ffprobe.exe']);
  const whisper = findBin('whisper-cli', c.whisperBin, ['main', 'whisper']);
  let model = c.asrModel;
  if (model && !fs.existsSync(model)) model = '';
  if (!model) {
    for (const n of ['ggml-small.bin', 'ggml-base.bin', 'ggml-medium.bin', 'ggml-tiny.bin']) {
      const p = path.join(ROOT, 'data', 'models', n);
      if (fs.existsSync(p)) { model = p; break; }
    }
  }
  return { ffmpeg, ffprobe, whisper, model };
}

/* ---------------- 小工具 ---------------- */
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), 'xuhbot-video-' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String((stderr || err.message || '') ).slice(0, 200)));
      resolve(String(stdout || ''));
    });
  });
}

/* ================= 明确指令 / 视频链接（2026-11-22 主人定） ================= */
/* 明确指令 → 看全部（全部字幕 + 全部可截帧数）。
 * 只在「这条消息确实带了视频/视频链接/引用视频」时才问它——纯聊天里一句「看看吧」不该烧全量。 */
const FULL_CMD_RE = /(查看|看看|看下|看一眼|看一遍|看仔细|仔细看|好好看|帮我看看|你看看|看完|全看|分析(一下)?(这段|这个)?视频|视频(讲|说|演)了?什么|总结(一下)?(这段|这个)?视频|解析(一下)?(这段|这个)?视频)/;
function wantsFull(text) { return FULL_CMD_RE.test(String(text || '')); }

/* 链接归到哪个站（只用来决定下载策略；认不出就按论坛页处理）。 */
const LINK_HOSTS = [
  [/bilibili\.com|b23\.tv/i, 'bilibili'],
  [/youtube\.com|youtu\.be/i, 'youtube'],
  [/douyin\.com|iesdouyin\.com/i, 'douyin'],
  [/kuaishou\.com/i, 'kuaishou'],
  [/weibo\.(com|cn)/i, 'weibo'],
  [/xiaohongshu\.com|xhslink\.com/i, 'xiaohongshu'],
  [/acfun\.cn/i, 'acfun'],
  [/iqiyi\.com/i, 'iqiyi'],
  [/youku\.com/i, 'youku'],
  [/vimeo\.com/i, 'vimeo'],
  [/twitter\.com|x\.com|t\.co/i, 'twitter'],
];
function linkKind(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return '';
  for (const pair of LINK_HOSTS) if (pair[0].test(u)) return pair[1];
  if (/\.(mp4|m3u8|flv|webm)(\?|$)/i.test(u)) return 'video-file';
  if (/[?&](vid|video|v)=/i.test(u) || /\/(video|v|play|watch)\//i.test(u)) return 'video-page';
  return 'forum';   // 贴吧/NGA/论坛帖：去页面里找 og:video / <video> / <iframe>
}

function ytdlpBin() {
  const c = cfg();
  if (c.ytdlpBin && fs.existsSync(c.ytdlpBin)) return c.ytdlpBin;
  return findBin('yt-dlp', '', ['yt-dlp']);
}

/* yt-dlp 元数据（20 秒）：标题 + 时长。失败返回 null，交给 HTML 兜底。 */
async function ytMeta(url) {
  const bin = ytdlpBin();
  if (!bin) return null;
  try {
    const out = await run(bin, ['--no-warnings', '--no-playlist', '-J', url], 20000);
    const j = JSON.parse(out);
    return { title: String(j.title || '').slice(0, 80), durationSec: Math.round(Number(j.duration || 0)) };
  } catch (e) { console.log('[video] yt-dlp 取不到元数据：' + e.message.slice(0, 80)); return null; }
}

/* yt-dlp 下小尺寸片（480p 封顶、120MB 封顶），ffmpeg 自动合并音视频。 */
async function ytDownload(url, dir) {
  const bin = ytdlpBin();
  if (!bin) return '';
  try {
    await run(bin, ['--no-warnings', '--no-playlist',
      '-f', 'bv*[height<=480]+ba/b[height<=480]/b',
      '--merge-output-format', 'mp4', '--max-filesize', '120M',
      '-o', path.join(dir, 'v.%(ext)s'), url], 120000);
  } catch (e) { console.log('[video] yt-dlp 下载失败：' + e.message.slice(0, 100)); return ''; }
  try {
    const f = fs.readdirSync(dir).filter(n => /^v\.(mp4|mkv|webm|flv)$/i.test(n))[0];
    return f ? path.join(dir, f) : '';
  } catch { return ''; }
}

/* 论坛/贴吧页面里找视频：og:video → <video src> → <source src> → 站外播放器 iframe。 */
async function pageMedia(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400 * 1024);
    const pick = re => { const m = html.match(re); return m ? String(m[1]).replace(/&amp;/g, '&').trim() : ''; };
    const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,120})["']/i);
    const cands = [
      pick(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i),
      pick(/<video[^>]+src=["']([^"']+)["']/i),
      pick(/<source[^>]+src=["']([^"']+)["']/i),
      pick(/<iframe[^>]+src=["']([^"']*(?:bilibili|youtube|player)[^"']*)["']/i),
    ].filter(Boolean);
    if (!cands.length) return title ? { title: title, mediaUrl: '' } : null;
    let mu = cands[0];
    if (mu.startsWith('//')) mu = 'https:' + mu;
    else if (mu.startsWith('/')) mu = new URL(url).origin + mu;
    return { title: title || '', mediaUrl: mu };
  } catch (e) { console.log('[video] 页面打不开：' + e.message.slice(0, 80)); return null; }
}

/* 一个链接 → 本地可分析的视频。成功给 { file, own, dir, title, durationSec }。 */
async function fetchLink(url, kind) {
  const k = kind || linkKind(url);
  if (k === 'video-file') {
    const core = require('./core');
    const got = await core.getBinary(url, 60000);
    const dir = tmpDir('link');
    const f = path.join(dir, 'v' + (path.extname(url.split('?')[0]) || '.mp4'));
    fs.writeFileSync(f, got.buf);
    return { file: f, own: true, dir: dir, title: '', durationSec: 0 };
  }
  const dir = tmpDir('link');
  if (k !== 'forum') {
    const meta = await ytMeta(url);
    const f = await ytDownload(url, dir);
    if (f) return { file: f, own: true, dir: dir, title: (meta && meta.title) || '', durationSec: (meta && meta.durationSec) || 0 };
  }
  const page = await pageMedia(url);
  if (page && page.mediaUrl) {
    const inner = page.mediaUrl;
    if (/\.(mp4|webm)(\?|$)/i.test(inner)) {
      const core = require('./core');
      const got = await core.getBinary(inner, 60000);
      const f = path.join(dir, 'v' + (path.extname(inner.split('?')[0]) || '.mp4'));
      fs.writeFileSync(f, got.buf);
      return { file: f, own: true, dir: dir, title: page.title, durationSec: 0 };
    }
    const meta = await ytMeta(inner);
    const f = await ytDownload(inner, dir);
    if (f) return { file: f, own: true, dir: dir, title: page.title || (meta && meta.title) || '', durationSec: (meta && meta.durationSec) || 0 };
  }
  rmrf(dir);
  throw new Error('取不到这条链接里的视频');
}

/* ---------------- ① 取到本地文件（OneBot 各实现字段不一，三条链都兜） ---------------- */
async function ensureLocal(seg, callApi) {
  if (seg && seg.link) return fetchLink(String(seg.link), seg.kind || linkKind(String(seg.link)));   // 视频链接（2026-11-22）
  const d = (seg && seg.data) || seg || {};
  const cand = [d.path, d.file].filter(x => typeof x === 'string' && x);
  for (const p of cand) {
    try { if (path.isAbsolute(p) && fs.existsSync(p)) return { file: p, own: false }; } catch {}
  }
  const url = String(d.url || d.file_url || '');
  if (/^https?:\/\//i.test(url)) {
    const core = require('./core');
    const got = await core.getBinary(url, 30000);
    const dir = tmpDir('dl');
    const f = path.join(dir, 'v' + (path.extname(url.split('?')[0]) || '.mp4'));
    fs.writeFileSync(f, got.buf);
    return { file: f, own: true, dir };
  }
  // 第三条：NapCat get_file（回包里 file 是本地路径 / url / base64 三种版本都有）
  if (callApi && (d.file_id || d.file)) {
    try {
      const r = await callApi('get_file', { file: d.file, file_id: d.file_id }, 15000);
      const rd = (r && r.data) || {};
      if (rd.file && path.isAbsolute(String(rd.file)) && fs.existsSync(String(rd.file))) {
        return { file: String(rd.file), own: false };
      }
      if (rd.base64) {
        const dir = tmpDir('b64');
        const f = path.join(dir, 'v.mp4');
        fs.writeFileSync(f, Buffer.from(String(rd.base64), 'base64'));
        return { file: f, own: true, dir };
      }
      if (/^https?:\/\//i.test(String(rd.url || ''))) {
        const core = require('./core');
        const got = await core.getBinary(String(rd.url), 30000);
        const dir = tmpDir('dl');
        const f = path.join(dir, 'v.mp4');
        fs.writeFileSync(f, got.buf);
        return { file: f, own: true, dir };
      }
    } catch (e) { /* 落到下面抛错 */ }
  }
  throw new Error('取不到视频文件（path/url/get_file 都不行）');
}

/* ---------------- ② ffprobe：时长 + 有没有内嵌字幕轨 ---------------- */
async function probe(file) {
  const b = bins();
  if (!b.ffprobe) return { durationSec: 0, subtitleStream: -1 };
  const out = await run(b.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 20000);
  let j = {};
  try { j = JSON.parse(out); } catch { j = {}; }
  const streams = Array.isArray(j.streams) ? j.streams : [];
  let dur = Number((j.format && j.format.duration) || 0);
  if (!dur) {
    const vs = streams.find(s => s.codec_type === 'video');
    if (vs) dur = Number(vs.duration || 0);
  }
  const subIdx = streams.findIndex(s => s.codec_type === 'subtitle');
  return { durationSec: Math.max(0, Math.round(dur)), subtitleStream: subIdx };
}

/* ---------------- ③ 切帧：按时间点 seek（不整片解码，长片也不炸内存） ---------------- */
/* 默认口径：每 8 秒一帧、最多 3 张。
 * 短视频（时长不到 interval*count）按真实时长均匀铺开——不然 5 秒的片子只有 t=0 一帧，
 * 而 t=0 经常是黑屏片头，等于什么都没看见。长片就老实按 0/8/16 秒取。 */
function pickTimes(durationSec, count, interval) {
  const dur = Math.max(0.5, durationSec || 0);
  const n = Math.min(count, Math.max(1, Math.ceil(dur / interval)));
  if (dur <= interval * count) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(Math.round(((i + 0.5) * dur / n) * 10) / 10);
    return out.length ? out : [0];
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(i * interval);
  return out;
}
function spreadTimes(durationSec, n, interval) {
  const dur = Math.max(0.5, durationSec || 0);
  const raw = [];
  for (let t = 0; t < dur; t += interval) raw.push(t);
  if (!raw.length) raw = [0];
  if (raw.length <= n) return raw;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (dur - 0.5)) / n * 10) / 10);   // 均匀抽样
  return out;
}
async function grabFrames(file, times, dir) {
  const b = bins();
  if (!b.ffmpeg) return [];
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const p = path.join(dir, 'f' + String(i + 1).padStart(2, '0') + '.jpg');
    try {
      await run(b.ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(times[i]), '-i', file,
        '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', p], 15000);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) out.push({ t: times[i], file: p });
    } catch (e) { console.log('[video] 第 ' + (i + 1) + ' 帧没切出来：' + e.message.slice(0, 80)); }
  }
  return out;
}
function toDataUri(p) {
  try {
    const mt = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
    return require('./img-cache').dataUriFromFile(p, mt);
  } catch { return ''; }
}

/* ---------------- ④ 字幕：内嵌轨优先，否则 whisper ---------------- */
async function embeddedSubs(file, idx, dir) {
  const b = bins();
  const out = path.join(dir, 'e.srt');
  try {
    await run(b.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-map', '0:s:' + idx, out], 20000);
    const srt = fs.readFileSync(out, 'utf8');
    return srt.replace(/\r/g, '')
      .split('\n')
      .filter(l => l && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
      .join('')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
      .trim();
  } catch { return ''; }
}
async function whisperSubs(file, seconds, dir) {
  const b = bins();
  if (!b.whisper || !b.model) return { text: '', why: '没有 whisper-cli 或模型' };
  const c = cfg();
  const wav = path.join(dir, 'a.wav');
  try {
    await run(b.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
      '-t', String(Math.max(1, Math.ceil(seconds))), wav], 30000);
  } catch (e) { return { text: '', why: '抽音轨失败：' + e.message.slice(0, 80) }; }
  const base = path.join(dir, 'a');
  try {
    await run(b.whisper, ['-m', b.model, '-f', wav, '-l', c.asrLang, '-t', String(c.asrThreads),
      '-nt', '-otxt', '-of', base, '-np'], 120000);
    const txt = fs.readFileSync(base + '.txt', 'utf8');
    return { text: txt.replace(/\s+/g, '').trim(), why: '' };
  } catch (e) { return { text: '', why: 'whisper 失败：' + e.message.slice(0, 80) }; }
}

/* ---------------- ⑤ 视觉：每批 ≤4 帧（core.seeImage 的上限），逐批问 ---------------- */
async function describeFrames(frames) {
  if (!frames.length) return [];
  const uris = frames.map(f => toDataUri(f.file)).filter(Boolean);
  if (!uris.length) return [];
  const core = require('./core');
  const out = [];
  for (let i = 0; i < uris.length; i += 4) {
    const batch = uris.slice(i, i + 4);
    const q = '这是同一段视频里按时间顺序截的 ' + batch.length + ' 帧画面。'
      + '每一帧用一句话说清画面里在发生什么（谁、在做什么、有没有字），'
      + '按顺序一行一帧，不要编号不要解释，不要复述这段话：';
    try {
      const txt = await core.seeImage(batch, q, '', true);
      const lines = String(txt || '').split(/\n+/).map(s => s
        .replace(/^[-\d.、)\s]+/, '')
        .replace(/^第[一二三四五六七八九十\d]{1,3}[帧张画面]+[:：、.，,]?\s*/, '')   // 模型爱加「第一帧：」前缀
        .replace(/^(这一帧|本帧|图中|画面中)[:：、.，,]?\s*/, '')
        .trim()).filter(Boolean);
      out.push(...lines.slice(0, batch.length));
    } catch (e) {
      console.log('[video] 视觉没答：' + e.message.slice(0, 80));
    }
  }
  return out;
}

/* ---------------- ⑥ 编排 + 缓存 ---------------- */
const cache = new Map();     // key: file|mode -> 结果
const inflight = new Map();  // key: file -> Promise（同一条视频并发去重）

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, '');
  return t.length > n ? t.slice(0, n) : t;
}

function buildText(r, mode) {
  const c = cfg();
  const parts = [];
  if (r.title) parts.push('「' + clip(r.title, 40) + '」');
  if (r.durationSec) parts.push('时长 ' + fmtDur(r.durationSec));
  const shots = r.frames.map((d, i) => '画面' + (i + 1) + '：' + d).join('｜');
  if (mode === 'full') {
    if (r.subFull) parts.push('字幕（全部）：' + clip(r.subFull, 4000));
    if (r.frames.length) parts.push(shots + '（共 ' + r.frames.length + ' 张，每 ' + c.frameIntervalSec + ' 秒一张）');
  } else {
    if (r.subBrief) parts.push('字幕（前' + c.briefSubtitleChars + '字）：' + r.subBrief);
    if (r.frames.length) parts.push(shots);
  }
  if (!parts.length) return '';
  return '［视频：' + parts.join('｜') + '］';
}

/* 对一个视频段做一次分析。mode: \'brief\'（默认 3 帧 + 60 字）| \'full\'（笑点解析用） */
async function analyze(seg, opts) {
  const o = opts || {};
  const c = cfg();
  if (!c.enable) return { ok: false, text: '［视频］', why: 'video.enable=false' };
  const mode = o.mode === 'full' ? 'full' : 'brief';
  const callApi = o.callApi;

  // 链接用链接本身当 key（同一条链接第二次直接命中缓存，不再重下 10 秒）
  const preKey = seg && seg.link ? 'link:' + seg.link + '|' + mode : '';
  if (preKey && cache.has(preKey)) return cache.get(preKey);
  const got = await ensureLocal(seg, callApi);
  const key = preKey || (got.file + '|' + mode);
  if (cache.has(key)) { if (got.own && got.dir) rmrf(got.dir); return cache.get(key); }

  const work = async () => {
    const dir = tmpDir('work');
    try {
      const info = await probe(got.file);
      const dur = info.durationSec || (mode === 'brief' ? c.frameIntervalSec * c.briefFrameCount : 0);
      const times = mode === 'full'
        ? spreadTimes(dur, c.fullMaxFrames, c.frameIntervalSec)
        : pickTimes(dur, c.briefFrameCount, c.frameIntervalSec);
      const framesRaw = await grabFrames(got.file, times, dir);

      // 字幕：内嵌轨（免费且准）优先；没有就 whisper
      let subFull = '', why = '';
      if (info.subtitleStream >= 0) subFull = await embeddedSubs(got.file, info.subtitleStream, dir);
      if (!subFull) {
        const listen = mode === 'full'
          ? Math.min(dur || c.maxFullSeconds, c.maxFullSeconds)
          : Math.min(Math.max(dur, 1), Math.max(c.briefSubtitleChars, 60));
        const w = await whisperSubs(got.file, listen, dir);
        subFull = w.text; why = w.why;
      }
      const frames = await describeFrames(framesRaw);
      const res = {
        ok: !!(frames.length || subFull),
        title: got.title || '',
        durationSec: got.durationSec || dur, subFull,
        subBrief: clip(subFull, c.briefSubtitleChars),
        frames, times, why,
      };
      res.text = buildText(res, mode);
      if (!res.text) res.text = '［视频：没看出内容］';
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      cache.set(key, res);
      return res;
    } finally {
      rmrf(dir);
      if (got.own && got.dir) rmrf(got.dir);
    }
  };

  const use = mode === 'full' ? 'full' : 'brief';
  const pkey = key;
  let p = inflight.get(pkey);
  if (!p) { p = work(); inflight.set(pkey, p); }
  const timeout = mode === 'full' ? c.fullTimeoutMs : c.briefTimeoutMs;
  const res = await Promise.race([p, new Promise(r => setTimeout(() => r(null), timeout))])
    .catch(e => { console.log('[video] 分析失败：' + e.message.slice(0, 120)); return null; })
    .finally(() => { inflight.delete(pkey); });
  if (!res) return { ok: false, text: '［视频：没看出内容］', why: '超时或失败', durationSec: 0, subFull: '', subBrief: '', frames: [] };
  return res;
}

/* 给 qq.js 用的薄入口：返回可读文案，永不抛错 */
async function describe(seg, opts) {
  try {
    const r = await analyze(seg, opts);
    return r.text || '［视频：没看出内容］';
  } catch (e) {
    console.log('[video] 兜底：' + e.message.slice(0, 120));
    return '［视频：没看出内容］';
  }
}

module.exports = {
  describe, analyze, probe, ensureLocal,
  _pickTimes: pickTimes, _spreadTimes: spreadTimes, _buildText: buildText, _bins: bins, _cfg: cfg,
  _grabFrames: grabFrames, _whisperSubs: whisperSubs, _describeFrames: describeFrames, _toDataUri: toDataUri,
  wantsFull, linkKind, fetchLink, _ytMeta: ytMeta, _pageMedia: pageMedia,
};
