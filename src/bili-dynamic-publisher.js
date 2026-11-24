/* ===========================================================================
 * bili-dynamic-publisher.js — 搬屎源群内容 → B站动态（筛选/去重/配额/发布）
 *
 * 数据流：
 *   插件 astrbot_plugin_banshi_auto 把源群消息导出成 JSON →
 *   src/data/bili-dynamic-inbox/ → 本模块筛选/去重/排队 → 到槽位发布
 *   日记不进本队列、不占 10 条额度（主人 2026-11-24 令）：走 diary-publish.postBili 单独发。
 *
 * 主人口径（2026-11-23）：
 *   · 视频不发；聊天记录也发，但纯口语且每行 <20 字的多行记录过滤。
 *   · 政治/色情/辱骂只认强词；图片只拦明确暴露的隐私部位。
 *   · 一天 10 条，间隔 >10 分钟，优先 9-14、18-22，分布均匀。
 *   · 不重复、不遗漏：队列落盘，失败重试，当天发不完顺延。
 *   · 词表正文不写日志、不进 selfpost、不进 filtered 记录。
 * =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const poopQuality = require('./poop-quality');   // 优质屎插队（2026-11-24）

const ROOT = __dirname;
const DATA = process.env.BILI_DYNAMIC_DATA_DIR ? path.resolve(process.env.BILI_DYNAMIC_DATA_DIR) : path.join(ROOT, 'data');
const INBOX = path.join(DATA, 'bili-dynamic-inbox');
const DONE = path.join(INBOX, 'done');
const QUEUE = path.join(DATA, 'bili-dynamic-queue.json');
const POSTED = path.join(DATA, 'bili-dynamic-posted.jsonl');
const FILTERED = path.join(DATA, 'bili-dynamic-filtered.jsonl');
const BLOCKED_DIR = path.join(DATA, 'bili-blocked-images');
const BLOCKED_JSON = path.join(DATA, 'bili-blocked-images.json');
const CONFIG = process.env.BILI_DYNAMIC_CONFIG ? path.resolve(process.env.BILI_DYNAMIC_CONFIG) : path.join(ROOT, 'config', 'features.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const MAX_TEXT = 2000;

const DEFAULT = {
  enabled: true,
  dailyCap: 10,
  gapSeconds: 600,
  windows: [['09:00', '14:00'], ['18:00', '22:00']],
  maxImages: 9,
  retryMax: 5,
  blockedKeepDays: 7,
  blockedMaxFiles: 300,
  pornCensorEnabled: true,
  pornMinConfidence: 0.6,
  pollSeconds: 60,
  maxIngestPerTick: 20,
};

let timer = null;
let busy = false;
let _deps = null;

function cfg() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  return Object.assign({}, DEFAULT, (j && j.biliDynamic) || {});
}
function ensureDirs() { for (const d of [DATA, INBOX, DONE]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} } }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function appendJsonl(p, row) { try { ensureDirs(); fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8'); } catch {} }

function dayStr(now) {
  const d = new Date(now);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function hhmm(day, s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(day + 'T' + String(m[1]).padStart(2, '0') + ':' + m[2] + ':00').getTime();
}
function jitter(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % (4 * 60 * 1000);      // 0~4 分钟
}
/* 每天 10 个槽：9-14 五个、18-22 五个，等距 + 抖动；硬保证相邻 >= gap。 */
function planSlots(day) {
  const c = cfg();
  const bases = ['09:00', '10:00', '11:00', '12:00', '13:00', '18:00', '18:48', '19:36', '20:24', '21:12'];
  const gap = Math.max(600000, Number(c.gapSeconds) * 1000);
  const out = [];
  for (let i = 0; i < bases.length; i++) {
    const t = hhmm(day, bases[i]) + jitter(day + ':' + i);
    if (out.length && t - out[out.length - 1].at < gap) out.push({ at: out[out.length - 1].at + gap, used: false });
    else out.push({ at: t, used: false });
  }
  return out;
}

function newState(now) {
  return { day: dayStr(now), slots: planSlots(dayStr(now)), used: 0, lastPublishAt: 0, items: [], seen: [] };
}
function loadState(now) {
  const st = readJson(QUEUE, null);
  if (!st || typeof st !== 'object') return newState(now);
  st.items = Array.isArray(st.items) ? st.items : [];
  st.seen = Array.isArray(st.seen) ? st.seen : [];
  st.used = Number(st.used) || 0;
  st.lastPublishAt = Number(st.lastPublishAt) || 0;
  // 永久去重底账并进 seen：即使队列文件被重建、seen 被清空，已发档案仍挡得住
  const ledger = loadLedger();
  const seenSet = new Set(st.seen);
  for (const h of ledger.hashes) if (!seenSet.has(h)) { st.seen.push(h); seenSet.add(h); }
  if (st.day !== dayStr(now) || !Array.isArray(st.slots) || st.slots.length !== 10) {
    st.day = dayStr(now); st.slots = planSlots(st.day); st.used = 0;
  }
  return st;
}
function saveState(st) {
  try {
    ensureDirs();
    const tmp = QUEUE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
    fs.renameSync(tmp, QUEUE);
  } catch (e) { console.error('[B站动态] 队列写不进去：' + e.message); }
}

const norm = s => String(s == null ? '' : s).replace(/[\s\u200b-\u200f\ufeff]+/g, '');
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

/* 永久去重底账（主人 2026-11-24 令「发过的只发一次、永久去重」）：
 * 唯一真相是已发档案 POSTED（只追加、不截断）。队列里的 seen 有上限、且队列文件
 * 重建/换目录就没了，不能当永久依据。入队前必须查这份底账，按「源消息 id」和
 * 「内容 hash」双维度判，任一命中就不再发。分块消息的 id/hash 带 -N 后缀，统一去掉再比。 */
let _ledger = null;
const baseId = s => String(s == null ? '' : s).replace(/-\d+$/, '');
function loadLedger() {
  if (_ledger) return _ledger;
  const ids = new Set(), hashes = new Set();
  try {
    const txt = fs.readFileSync(POSTED, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let r = null;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      if (r.id) ids.add(baseId(r.id));
      if (r.hash) hashes.add(String(r.hash));
    }
  } catch {}
  _ledger = { ids, hashes };
  return _ledger;
}
function rememberPosted(id, hash) {
  const l = loadLedger();
  if (id) l.ids.add(baseId(id));
  if (hash) l.hashes.add(String(hash));
}

function imageMd5(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}
function itemHash(text, images) {
  const imgs = (images || []).map(x => imageMd5(x.path)).filter(Boolean).sort();
  return sha1(norm(text) + '|' + imgs.join(','));
}
function hitHash(hits) { return sha1((hits || []).join('\u0001')).slice(0, 12); }
const KIND_LABEL = { political: '政治强词', sexual: '色情强词', insult: '辱骂强词', exposure: '图片暴露' };
function logFiltered(src, reason, kind, hits) {
  const k = String(kind || src.kind || '');
  // 有命中词时只记类别，绝不把词表原文写进日志
  const safeReason = (Array.isArray(hits) && hits.length) ? (KIND_LABEL[k] || '命中禁词') : String(reason || '').slice(0, 120);
  appendJsonl(FILTERED, {
    at: new Date().toISOString(), source: String(src.source || ''), mids: src.mids || [],
    kind: k, hitCount: Array.isArray(hits) ? hits.length : 0,
    hitHash: hitHash(hits), reason: safeReason,
  });
}

/* B站筛掉的图留档：给 QQ 群「点图」用。同一张按 md5 只留一份，mids 并入。 */
let _blocked = null;
function loadBlocked() {
  if (_blocked) return _blocked;
  const j = readJson(BLOCKED_JSON, null);
  _blocked = (j && j.items && typeof j.items === 'object') ? j.items : {};
  return _blocked;
}
function saveBlocked() {
  try {
    ensureDirs();
    fs.mkdirSync(BLOCKED_DIR, { recursive: true });
    const tmp = BLOCKED_JSON + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ items: loadBlocked() }), 'utf8');
    fs.renameSync(tmp, BLOCKED_JSON);
  } catch (e) { console.log('[B站动态] 被筛图台账写不进去：' + e.message); }
}
function recordBlockedImage(p, verdict, item) {
  try {
    const src = String(p || '');
    if (!src || !fs.existsSync(src)) return;
    const md5 = imageMd5(src);
    if (!md5) return;
    const ext = (String(path.extname(src)).toLowerCase().match(/^\.(jpe?g|png|gif|webp|bmp)$/) || ['.jpg'])[0];
    try { fs.mkdirSync(BLOCKED_DIR, { recursive: true }); } catch {}
    const dest = path.join(BLOCKED_DIR, md5 + ext);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    const items = loadBlocked();
    const old = items[md5] || {};
    items[md5] = {
      at: Number(old.at) || Date.now(),
      path: dest,
      source: String(item.source || old.source || ''),
      kind: String(verdict.kind || old.kind || ''),
      hasText: !!(old.hasText || String(verdict.ocrText || '').trim()),
      mids: Array.from(new Set([...(old.mids || []), ...((item.mids || []).map(String))])),
    };
    saveBlocked();
  } catch (e) { console.log('[B站动态] 被筛图留档失败：' + e.message); }
}
function pruneBlocked() {
  try {
    const items = loadBlocked();
    const c = cfg();
    const keepDays = Math.max(0, Number(c.blockedKeepDays) || 0);
    const maxFiles = Math.max(0, Number(c.blockedMaxFiles) || 0);
    let rows = Object.keys(items).map(k => Object.assign({ md5: k }, items[k]));
    let changed = false;
    if (keepDays > 0) {
      const cut = Date.now() - keepDays * 86400000;
      const keep = rows.filter(r => Number(r.at) >= cut);
      if (keep.length !== rows.length) { rows = keep; changed = true; }
    }
    if (maxFiles > 0 && rows.length > maxFiles) {
      rows.sort((a, b) => Number(a.at) - Number(b.at));
      for (const r of rows.slice(0, rows.length - maxFiles)) {
        try { fs.rmSync(String(r.path || ''), { force: true }); } catch {}
        changed = true;
      }
      rows = rows.slice(rows.length - maxFiles);
    }
    if (changed) {
      const next = {};
      for (const r of rows) next[r.md5] = { at: r.at, path: r.path, source: r.source, kind: r.kind, hasText: !!r.hasText, mids: r.mids };
      _blocked = next;
      saveBlocked();
    }
  } catch (e) { console.log('[B站动态] 被筛图清理失败：' + e.message); }
}

/* 把一条导出的候选整理成待发项：文本 + 通过初筛的图片 */
function candidateText(item) {
  const lines = Array.isArray(item.lines) ? item.lines : [];
  if (lines.length) return lines.map(l => (l.nick ? l.nick + '：' : '') + String(l.text || '')).join('\n').trim();
  return String(item.text || '').trim();
}
function splitText(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_TEXT) return t ? [t] : [];
  const out = [];
  let cur = '';
  for (const line of t.split(/\n/)) {
    const piece = String(line);
    if (piece.length > MAX_TEXT) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < piece.length; i += MAX_TEXT) out.push(piece.slice(i, i + MAX_TEXT));
      continue;
    }
    if ((cur + (cur ? '\n' : '') + piece).length > MAX_TEXT) { out.push(cur); cur = piece; }
    else cur = cur ? cur + '\n' + piece : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/* 初筛：返回 {ok, text, images, kind, reason, hits}。图片逐张判，坏的丢掉。 */
async function screenItem(item, d) {
  const kind = String(item.kind || '');
  if (kind === 'video') return { ok: false, reason: '视频不发' };
  const text = candidateText(item);
  const lines = Array.isArray(item.lines) ? item.lines.map(l => String(l.text || '')) : [];
  if (lines.length >= 2 && d.isPureColloquialChat(lines)) return { ok: false, reason: '纯口语短聊天记录' };
  if (text) {
    const j = d.judgeText(text);
    if (!j.pass) return { ok: false, reason: j.reason, hits: j.hits || [] };
  }
  const rawImgs = (Array.isArray(item.images) ? item.images : []).slice(0, Number(cfg().maxImages) || 9);
  const images = [];
  for (const im of rawImgs) {
    const p = String((im && (im.path || im.file)) || '');
    if (!p) continue;
    const r = await d.judgeImage(p);
    const c = cfg();
    const pornBlocked = c.pornCensorEnabled !== false && r.porn &&
      (Number(r.pornConfidence) || 0) >= (Number(c.pornMinConfidence) || 0.6);
    if (!r.pass || pornBlocked) {
      if (pornBlocked && r.pass) {
        const reason = '色图（性暗示）';
        logFiltered(item, reason, 'porn', []);
        recordBlockedImage(p, Object.assign({}, r, { kind: 'porn', reason }), item);
      } else {
        logFiltered(item, r.reason, r.kind, r.hits);
        recordBlockedImage(p, r, item);
      }
      continue;
    }
    images.push({ path: p, url: String(im.url || '') });
  }
  if (!text && !images.length) return { ok: false, reason: '没有可发文字或图片' };
  return { ok: true, text, images, kind: kind || (images.length ? 'image' : 'text') };
}

/* 队列顺序（主人 2026-11-24）：优质屎 premium 最前 > 其余按源消息时间。
 * 日记不进本队列（单独发），diary 档保留只是兼容旧数据，无害。 */
const PRIORITY_RANK = { premium: 0, diary: 1, 'move-poop': 2 };
function itemOrder(a, b) {
  const ra = PRIORITY_RANK[a.priority] == null ? 2 : PRIORITY_RANK[a.priority];
  const rb = PRIORITY_RANK[b.priority] == null ? 2 : PRIORITY_RANK[b.priority];
  return ra - rb || Number(a.at) - Number(b.at);
}

function enqueueItem(st, src, screened, opts) {
  if (!st.items) st.items = [];
  if (!st.seen) st.seen = [];
  const ledger = loadLedger();                       // 永久底账：以前发过的，这次一律不收
  const srcId = String(src.id || '');
  const srcMids = (Array.isArray(src.mids) ? src.mids : []).map(String);
  const everSent = id => id && (ledger.ids.has(baseId(id)) ||
    st.items.some(x => baseId(x.id) === baseId(id)));   // 源消息 id：分块去掉 -N 再比
  if (everSent(srcId) || srcMids.some(everSent)) return 0;
  const chunks = splitText(screened.text);
  if (!chunks.length && !screened.images.length) return 0;
  const parts = chunks.length ? chunks : [''];
  // 优质屎（主人 2026-11-24 原话）：入队前按内容指纹查台账，命中即列为优质、插到最前。
  // 指纹正文必须和 qq.js 转发展开那侧一致 —— 用 lines[].text 纯正文（不带「昵称：」前缀），
  // 不能用 screened.text（candidateText 拼了昵称，会和对侧算出不同 hash）。
  let premium = false;
  try {
    const pureLines = Array.isArray(item.lines) ? item.lines.map(l => String((l && l.text) || '')) : [];
    const pureText = pureLines.length ? pureLines.join('\n') : String(screened.text || '');
    // 图描述一起进去重口径（2026-11-22 主人定）：字一样、图不同的两条才算不同的屎
    premium = poopQuality.isPremium(pureText, poopQuality.imageKeysOfItem(screened), poopQuality.descsOfItem(screened));
  } catch (e) {}
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i];
    const hash = parts.length > 1 ? sha1(itemHash(text, screened.images) + '#' + i) : itemHash(text, screened.images);
    if (!hash || ledger.hashes.has(hash) || st.seen.includes(hash) || st.items.some(x => x.hash === hash)) continue;
    st.items.push({
      id: String(src.id || '') + (parts.length > 1 ? '-' + i : ''),
      hash, text, images: screened.images.slice(),
      kind: screened.kind, source: String(src.source || ''), mids: (src.mids || []).map(String),
      at: Number(src.at) || Date.now(), enqueuedAt: Date.now(),
      priority: premium ? 'premium' : ((opts && opts.priority) || 'move-poop'),
      premium: premium ? { at: Date.now() } : undefined,
      tries: 0, nextTry: 0, state: 'pending',
    });
    n++;
  }
  st.items.sort(itemOrder);
  return n;
}

/* ---------- 发布底层 ---------- */
function creds() {
  const b = require('./bili-space');
  const c = b.creds();
  return { cookie: String(c.cookie || ''), csrf: String(c.csrf || '') };
}
function postHeaders(extra, referer) {
  const c = creds();
  const h = { 'User-Agent': UA, Referer: referer || 'https://t.bilibili.com/', Origin: 'https://t.bilibili.com' };
  if (c.cookie) h.Cookie = c.cookie;
  return Object.assign(h, extra || {});
}
function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}
function uploadable(p) {
  let buf = fs.readFileSync(p);
  let mime = mimeOf(buf);
  if (mime === 'image/webp') {
    const py = process.env.PYTHON || 'python3';
    const out = p.replace(/\.[^.]+$/, '') + '.bili.png';
    try {
      execFileSync(py, ['-c', 'from PIL import Image;import sys;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2])', p, out], { timeout: 20000 });
      buf = fs.readFileSync(out); mime = 'image/png';
    } catch { throw new Error('webp 转 png 失败'); }
  }
  return { buf, mime };
}
async function localImage(im) {
  const p = String((im && im.path) || '');
  if (p && fs.existsSync(p)) return p;
  const url = String((im && im.url) || '');
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const got = await require('./core').getBinary(url);
    if (!got || !got.buf) return '';
    const tmp = path.join(DATA, 'bili-img-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.img');
    fs.writeFileSync(tmp, got.buf);
    return tmp;
  } catch { return ''; }
}

async function uploadImage(p) {
  const c = creds();
  if (!c.csrf) throw new Error('没有 B站登录态（bili_jct）');
  const { buf, mime } = uploadable(p);
  const ext = mime.indexOf('png') >= 0 ? 'png' : mime.indexOf('gif') >= 0 ? 'gif' : 'jpg';
  const form = new FormData();
  form.append('file_up', new Blob([buf], { type: mime }), 'image.' + ext);
  form.append('category', 'daily');
  form.append('biz', 'new_dyn');
  form.append('csrf', c.csrf);
  const r = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
    method: 'POST', headers: postHeaders(), body: form,
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0 || !j.data || !j.data.image_url) throw new Error('上传失败：' + ((j && (j.message || j.code)) || '无响应'));
  const d = j.data;
  return { img_src: d.image_url, img_width: Number(d.image_width) || 0, img_height: Number(d.image_height) || 0, img_size: Number(d.img_size) || Math.round(buf.length / 1024) };
}
async function postDynamic(text, pics) {
  const c = creds();
  if (!c.csrf) throw new Error('没有 B站登录态（bili_jct）');
  const url = 'https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=' + encodeURIComponent(c.csrf);
  const dyn = { scene: pics && pics.length ? 2 : 1, content: { contents: [{ raw_text: String(text || ''), type: 1, biz_id: '' }] }, meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } } };
  if (pics && pics.length) dyn.pics = pics;
  let j = null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: postHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ dyn_req: dyn }),
    });
    j = await r.json();
  } catch (e) { const err = new Error('请求失败：' + e.message); err.network = true; throw err; }
  if (j && j.code === 0) {
    const d = j.data || {};
    return { ok: true, dynId: String(d.dyn_id_str || d.dynamic_id_str || d.dyn_id || '') };
  }
  const err = new Error('B站返回 ' + ((j && j.code) || '?') + '：' + ((j && (j.message || j.msg)) || ''));
  err.code = j && j.code;
  throw err;
}

/* ---------- 调度 ---------- */
function nextSlot(st, now, gapMs) {
  if (Number(st.used) >= Number(cfg().dailyCap)) return null;
  const s = (st.slots || []).find(x => !x.used && x.at <= now);
  if (!s) return null;
  if (st.lastPublishAt && now - st.lastPublishAt <= gapMs) return null;   // 严格大于 10 分钟
  return s;
}
function pickItem(st, now) {
  const ready = (st.items || []).filter(x => (Number(x.nextTry) || 0) <= now);
  ready.sort(itemOrder);   // 优质屎插队最前（2026-11-24）
  return ready[0] || null;
}

async function publishOne(st, item, slot, now) {
  const c = cfg();
  const d = depsOf();
  const up = d.uploadImage || uploadImage;
  const poster = d.postDynamic || postDynamic;
  const pics = [];
  for (const im of item.images || []) {
    try {
      const local = await localImage(im);
      if (!local) { console.log('[B站动态] 图片跳过：本地路径和 URL 都取不到'); continue; }
      pics.push(await up(local));
    } catch (e) { console.log('[B站动态] 图片跳过：' + e.message); }
  }
  const text = String(item.text || '').trim();
  if (!text && !pics.length) { item.state = 'filtered'; item.error = '没有可发内容'; return { ok: false, filtered: true, reason: item.error }; }
  try {
    const r = await poster(text, pics);
    slot.used = true; st.used = Number(st.used) + 1; st.lastPublishAt = now;
    st.items = st.items.filter(x => x !== item);
    st.seen = (st.seen || []).concat([item.hash]).slice(-20000);
    appendJsonl(POSTED, { at: new Date().toISOString(), id: item.id, dynId: r.dynId, hash: item.hash, kind: item.kind, source: item.source, images: pics.length, priority: item.priority });
    rememberPosted(item.id, item.hash);             // 立刻进永久底账，不等下次启动读档案
    try {
      if (process.env.BILI_DYNAMIC_NO_SELFPOST !== '1') require('./selfpost').add({
        plat: 'bili', kind: 'dynamic', text: text.slice(0, 4000), tid: r.dynId,
        link: r.dynId ? 'https://t.bilibili.com/' + r.dynId : '',
        note: '搬屎源群→B站动态' + (pics.length ? '（' + pics.length + ' 图）' : ''),
        from: 'move-poop', ok: true,
      });
    } catch {}
    return { ok: true, dynId: r.dynId };
  } catch (e) {
    if (e.code === 4101001) {   // 平台明确拒绝：不重试
      item.state = 'filtered'; item.error = e.message;
      logFiltered({ id: item.id, mids: item.mids, kind: item.kind, source: item.source }, 'B站拒收：' + e.message, item.kind, []);
      return { ok: false, filtered: true, reason: e.message };
    }
    item.tries = Number(item.tries) + 1;
    const base = 60 * 1000, maxTry = Math.max(1, Number(c.retryMax) || 5);
    item.nextTry = now + Math.min(3600000, base * Math.pow(2, Math.min(item.tries - 1, 6)));
    item.error = e.message;
    if (item.tries > maxTry) item.nextTry = now + 3600000;
    return { ok: false, reason: e.message, retry: true };
  }
}

async function tickOnce(now) {
  now = Number(now) || Date.now();
  const c = cfg();
  if (!c.enabled) return { ok: true, skipped: 'disabled' };
  if (busy) return { ok: true, skipped: 'busy' };
  busy = true;
  try {
    const st = loadState(now);
    saveState(st);                      // 跨日重置先落盘
    await ingest(st, now);
    const gapMs = Math.max(600000, Number(c.gapSeconds) * 1000);
    const slot = nextSlot(st, now, gapMs);
    if (!slot) { saveState(st); return { ok: true, idle: true, pending: st.items.length, used: st.used }; }
    const item = pickItem(st, now);
    if (!item) { saveState(st); return { ok: true, idle: true, pending: 0, used: st.used }; }
    const r = await publishOne(st, item, slot, now);
    saveState(st);
    console.log('[B站动态] ' + (r.ok ? '已发 ' + r.dynId : r.filtered ? '拒收：' + r.reason : '失败重试：' + r.reason) + '（今日 ' + st.used + '/' + c.dailyCap + '）');
    return Object.assign({ ok: true, pending: st.items.length, used: st.used }, r);
  } finally { busy = false; }
}

/* ---------- inbox ---------- */
async function ingest(st, now) {
  now = Number(now) || Date.now();
  let names = [];
  try { names = fs.readdirSync(INBOX).filter(n => n.endsWith('.json')).sort().slice(0, Math.max(1, Number(cfg().maxIngestPerTick) || 20)); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const p = path.join(INBOX, name);
    let item = null;
    try { item = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!item || typeof item !== 'object') continue;
    try {
      const r = await screenItem(item, depsOf());
      if (!r.ok) { logFiltered(item, r.reason, item.kind, r.hits); }
      else {
        const added = enqueueItem(st, item, r, { priority: item.priority || 'move-poop' });
        if (added) n += added;
      }
    } catch (e) { console.log('[B站动态] 筛选出错：' + e.message); continue; }
    try { fs.renameSync(p, path.join(DONE, name)); } catch {}
  }
  if (n) saveState(st);
  pruneBlocked();
  return n;
}

// 已废弃（主人 2026-11-24 令「日记单独，不进 10 条队列」）：无运行时调用者，仅为兼容旧测试保留。
// 日记现在走 diary-publish.postBili 直接发，不占本队列额度。
function enqueueDiary(text) {
  const c = cfg();
  const now = Date.now();
  const st = loadState(now);
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '没内容' };
  const added = enqueueItem(st, { id: 'diary-' + now, source: 'diary', mids: [], at: now }, { ok: true, text: t, images: [], kind: 'text' }, { priority: 'diary' });
  saveState(st);
  if (!added) return { ok: false, error: '内容重复或已发过' };
  const gap = Math.max(600000, Number(c.gapSeconds) * 1000);
  const slot = (st.slots || []).find(x => !x.used && x.at > now - gap);
  return { ok: true, queued: true, slot: slot ? new Date(slot.at).toISOString() : '', pending: st.items.length };
}

/* ---------- 依赖注入 ---------- */
function depsDefault() {
  let censor = null;
  const get = () => { if (!censor) censor = require('./bili-censor'); return censor; };
  const core = require('./core');
  return {
    judgeText: t => get().judgeText(t),
    judgeImage: p => get().judgeImage(p, core),
    isPureColloquialChat: l => get().isPureColloquialChat(l),
  };
}
function depsOf() { if (!_deps) _deps = depsDefault(); return _deps; }

function start(opts) {
  const o = opts || {};
  if (o.deps) _deps = o.deps;
  ensureDirs();
  if (timer) return;
  const loop = async () => {
    try { await tickOnce(Date.now()); } catch (e) { console.log('[B站动态] tick 出错：' + e.message); }
  };
  const every = () => Math.max(10, Number(cfg().pollSeconds) || 60) * 1000;
  const schedule = () => { if (!timer) return; timer = setTimeout(() => loop().finally(schedule), every()); };
  timer = setTimeout(() => loop().finally(schedule), 3000);
  console.log('[B站动态] publisher 已启动（每天 ' + cfg().dailyCap + ' 条，槽位 9-14 / 18-22）');
}
function stop() { if (timer) clearTimeout(timer); timer = null; }

module.exports = {
  start, stop, tickOnce, enqueueDiary, ingest,
  _cfg: cfg, _planSlots: planSlots, _splitText: splitText, _itemHash: itemHash,
  _screenItem: screenItem, _loadState: loadState, _saveState: saveState,
  _uploadImage: uploadImage, _postDynamic: postDynamic,
  _recordBlockedImage: recordBlockedImage, _loadBlocked: loadBlocked, _pruneBlocked: pruneBlocked,
  BLOCKED_DIR, BLOCKED_JSON,
  _setDeps: d => { _deps = d; }, _nowState: () => loadState(Date.now()),
  INBOX, QUEUE, POSTED, FILTERED,
};
