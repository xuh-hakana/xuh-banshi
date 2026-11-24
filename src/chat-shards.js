'use strict';
/*
 * chat-shards.js — 聊天记录按「会话 + 静默段」分流（2026-11-19 建，2026-11-21 改按静默分段）
 *
 * 干什么：把主文件 data/chat-log.jsonl 的每一行，另外写一份到
 *   data/chat-shards/<群_群号 | 私_昵称 | 其它_来源>__<YYYY-MM-DD_HHmm>.jsonl
 * 分段规则（主人 2026-11-21 02:37 令，替代早先的「静默4小时」）：
 *   同一会话，**先攒够 MIN_LINES 行**，之后距上一条消息静默 ≥ SILENCE_MS 才开新段。
 *   - 75 行是「下限门槛」，不是硬上限：不够 75 行时静默再久也不切（冷清会话的零散消息合并成一段）；
 *     够 75 行后连续热聊可以超过 75 行不切——为了「消息不被隔断」，不在连续对话中间硬切。
 *   - 攒够行数之后，静默满 14 分钟才切——53 行聊一半不会因停顿被切碎。
 * 段名带的是这一段的**首条消息北京时间**，所以既是「按天」组织，又不会因为跨零点断话。
 *
 * 给面板：① 平时只读最近 N 个分片（不整份读 8000+ 行，不卡）；
 *        ② 按会话 / 按段一键删；③ 翻到更早才读主文件。
 *
 * 铁律（别破坏）：
 *  - 主文件 chat-log.jsonl 仍是唯一数据源。review 证据锚点、learn/acts.js 的
 *    行号游标、日记的游标/静默判定全依赖它的全局行号——分流只是「派生视图」。
 *  - 分片删了能从主文件 rebuild，不丢数据；主文件还在，一切照旧。
 *  - 分段边界由「相邻间隔 ≥ SILENCE_MS」决定，由 appendLine（增量写）与
 *    rebuild（按主文件顺序重放）共用同一套逻辑，两边必须一致，否则段会串。
 *  - 写入 key 依赖 sidecar _state.json 记住每个会话的「当前段起点 + 上一条时间」。
 *    sidecar 丢了能从主文件重放重建，不致命；但重建前不要把新行写错段。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'data', 'chat-log.jsonl');
const DIR = path.join(ROOT, 'data', 'chat-shards');
const STATE = path.join(DIR, '_state.json');
const INDEX = path.join(DIR, '_index.json');
const SILENCE_MS = 14 * 60 * 1000;      // 攒够 MIN_LINES 行后，静默 14 分钟 → 开新段（主人 2026-11-21 02:37 令，原 4h）
const MIN_LINES = 75;                   // 行数下限门槛：不够 75 行时静默再久也不切
const PAD = n => String(n).padStart(2, '0');

function safeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || '空';
}

/* 行首 UTC 时间戳（Z 结尾）→ 毫秒；取不到返回 NaN。 */
function lineMs(line) {
  const m = String(line || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/* 毫秒 → 北京时间段名后缀 YYYY-MM-DD_HHmm */
function stampOf(ms) {
  if (!isFinite(ms)) return '未知时';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + PAD(d.getUTCMonth() + 1) + '-' + PAD(d.getUTCDate())
    + '_' + PAD(d.getUTCHours()) + PAD(d.getUTCMinutes());
}

/* 会话 key（不带段后缀）——写入与重建共用，务必稳定。 */
function baseKeyOfLine(line) {
  const s = String(line || '');
  const m = s.match(/^\S+\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]/);
  if (!m) return '其它_裸行';
  const src = m[1] || '', scope = m[2] || '', nick = m[3] || '';
  if (/^群\d+/.test(scope)) return '群_' + safeName(scope);
  if (src === 'auto-reprobe') return '其它_auto-reprobe';
  if (scope === '私聊' || (!scope && (src === 'qq' || src === 'bili'))) {
    const to = s.match(/\[→([^\]]*)\]/);
    const who = to && String(to[1] || '').trim() ? to[1].trim() : nick;
    return '私_' + safeName(who || '没署名');
  }
  return '其它_' + safeName(src || scope || '杂');
}

/* key → {conv, stamp}。段后缀固定 __YYYY-MM-DD_HHmm 在结尾，用最后一个 __ 拆。 */
function splitKey(key) {
  const s = String(key || '');
  const i = s.lastIndexOf('__');
  if (i > 0) return { conv: s.slice(0, i), stamp: s.slice(i + 2) };
  return { conv: s, stamp: '' };
}

function fileOf(key) { return path.join(DIR, safeName(key) + '.jsonl'); }
function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }

/* ---- 分段状态 sidecar：{conv: {start: 段首ms, last: 上一条ms, n: 当前段已攒行数}} ----
 * n 是 2026-11-21 加的：攒够 MIN_LINES 行之后静默才切段。旧 sidecar 没 n 的，rebuild 会补。 */
let _state = null;
function loadState() {
  if (_state) return _state;
  _state = {};
  try { const o = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (o && typeof o === 'object') _state = o; } catch (e) {}
  return _state;
}
function saveState() { try { fs.writeFileSync(STATE, JSON.stringify(_state || {})); } catch (e) {} }

/* 一行落在哪个段。主人 2026-11-21 02:37 令（替代原「静默4小时」）：
 *  - 状态缺失 → 开首段；
 *  - 当前段已攒 ≥ MIN_LINES 行 **且** 距上一条静默 ≥ SILENCE_MS → 开新段；
 *  - 没攒够 75 行，静默再久也不切；攒够后连续热聊（间隔 <14min）也不切，可超 75 行。
 * 返回 {key, isNew, start, last, n}；n=切段后本段行数（新段=1，续段=cur.n+1）。
 * 调用方负责写回 state 与 index。key 撞车（同会话同分钟开两段）由调用方加 #序号后缀。
 * 时间倒退（补写旧消息）不改段首，只更新 last 为较大的那个，避免段名乱跳。 */
function nextSeg(line, cur) {
  const ms = lineMs(line);
  const convMs = isFinite(ms) ? ms : 0;
  const hasCur = cur && isFinite(cur.start) && isFinite(cur.last);
  const enough = hasCur && (Number(cur.n) || 0) >= MIN_LINES;
  const silent = hasCur && cur.last && (convMs - cur.last) >= SILENCE_MS;
  let start, isNew, n;
  if (!hasCur || (enough && silent)) {
    start = ms; isNew = true; n = 1;
  } else {
    start = cur.start; isNew = false; n = (Number(cur && cur.n) || 0) + 1;
  }
  const last = (isFinite(cur && cur.last) && cur.last > convMs) ? cur.last : convMs;
  const key = baseKeyOfLine(line) + '__' + stampOf(start);
  return { key, isNew, start, last, n };
}

/* 段 key 撞车去重：同会话同一分钟开了两段（段首 stamp 相同）时，第二段加 #2/#3 后缀。
 * 逐段递增试探，直到 key 不在 index 里。续段（isNew=false）直接用原 key，不调用这里。 */
function uniqueKey(key) {
  if (!loadIndex()[key]) return key;
  let s = 2;
  while (loadIndex()[key + '#' + s]) s++;
  return key + '#' + s;
}

/* 追加一行到它所属的分片（core.logLine 写主文件后调）。失败只报错，绝不影响主写入。 */
function appendLine(line) {
  try {
    if (!String(line || '').trim()) return;
    ensureDir();
    const base = baseKeyOfLine(line);
    const st = loadState();
    const seg = nextSeg(line, st[base]);
    // 撞车只在开新段时可能；续段复用原 key（state 里记的是最终 key）
    const key = seg.isNew ? uniqueKey(seg.key) : (st[base].key || seg.key);
    st[base] = { start: seg.start, last: seg.last, n: seg.n, key };
    saveState();
    const txt = String(line).endsWith('\n') ? String(line) : String(line) + '\n';
    fs.appendFileSync(fileOf(key), txt, 'utf8');
    const idx = loadIndex();
    const e = idx[key] || (idx[key] = { count: 0, size: 0, start: seg.start, last: seg.last });
    e.count++; e.size += Buffer.byteLength(txt); e.last = seg.last;
    saveIndex();
  } catch (e) { console.error('[chat-shards] 分流写失败（不影响主文件）：' + e.message); }
}

/* 从主文件按时间顺序重放，重建所有分段分片 + 状态 + 计数索引。 */
function rebuild() {
  ensureDir();
  for (const f of fs.readdirSync(DIR)) {
    if (f.endsWith('.jsonl')) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {} }
  }
  let raw = '';
  try { raw = fs.readFileSync(MAIN, 'utf8'); } catch (e) { return { files: 0, lines: 0, error: e.message }; }
  const lines = raw.split('\n');
  // 按行首时间稳定排序，保证「相邻间隔」判定不被写入顺序干扰
  const rows = lines.filter(l => l.trim()).map(l => ({ l, ms: lineMs(l) }));
  rows.sort((a, b) => {
    const am = isFinite(a.ms) ? a.ms : Infinity, bm = isFinite(b.ms) ? b.ms : Infinity;
    return am - bm;
  });
  const state = {}, idx = {}, buckets = {};
  for (const r of rows) {
    const base = baseKeyOfLine(r.l);
    const seg = nextSeg(r.l, state[base]);
    // 与 appendLine 同一套撞车去重：开新段加 #序号，续段复用旧 key
    let key = seg.key;
    if (seg.isNew && idx[key]) { let s = 2; while (idx[key + '#' + s]) s++; key = key + '#' + s; }
    else if (!seg.isNew && state[base].key) key = state[base].key;
    state[base] = { start: seg.start, last: seg.last, n: seg.n, key };
    (buckets[key] || (buckets[key] = [])).push(r.l);
    const e = idx[key] || (idx[key] = { count: 0, size: 0, start: seg.start, last: seg.last });
    e.count++; e.size += Buffer.byteLength(r.l) + 1; e.last = seg.last;
  }
  for (const k of Object.keys(buckets)) {
    fs.writeFileSync(fileOf(k), buckets[k].join('\n') + '\n', 'utf8');
  }
  _state = state; _idx = idx;
  saveState(); saveIndex();
  return { files: Object.keys(buckets).length, lines: rows.length };
}

/* ---- 计数索引 sidecar：{key: {count,size,start,last}}，list 不全文读 ---- */
let _idx = null;
function loadIndex() {
  if (_idx) return _idx;
  _idx = {};
  try { const o = JSON.parse(fs.readFileSync(INDEX, 'utf8')); if (o && typeof o === 'object') _idx = o; } catch (e) {}
  return _idx;
}
function saveIndex() { try { fs.writeFileSync(INDEX, JSON.stringify(_idx || {})); } catch (e) {} }

/* 列分片：{key, conv, stamp, count, size, start, last}。计数来自 sidecar，不全文读。 */
function list() {
  ensureDir();
  const idx = loadIndex();
  return Object.keys(idx).filter(k => fs.existsSync(fileOf(k))).map(k => {
    const e = idx[k] || {};
    const sp = splitKey(k);
    return { key: k, conv: sp.conv, stamp: sp.stamp, count: e.count || 0, size: e.size || 0,
      start: e.start || 0, last: e.last || 0 };
  }).sort((a, b) => (b.last || 0) - (a.last || 0));
}

/* 按会话聚合（前端 chips 用）：同一会话的多段合成一条。 */
function listConversations() {
  const by = {};
  for (const x of list()) {
    const c = by[x.conv] || (by[x.conv] = { conv: x.conv, count: 0, segs: 0, latest: '', last: 0 });
    c.count += x.count; c.segs++;
    if (x.stamp > c.latest) c.latest = x.stamp;
    c.last = Math.max(c.last, x.last || 0);
  }
  return Object.values(by).sort((a, b) => b.last - a.last);
}

/* 读一个分片（key 带段后缀）。 */
function readShard(key) {
  if (!key) return [];
  try { return fs.readFileSync(fileOf(key), 'utf8').split('\n').filter(Boolean); }
  catch (e) { return []; }
}

/* 从最近往前第 skip 段起、读 N 个分片的所有消息，按时间排序。
 * 面板默认读 skip=0（最近 N 段）；往上翻到顶时 skip+=上次实读段数，读更早一批。
 * 列表按段最后一条时间倒序（见 list），段之间时间可能交错，故调用方合并多批后需按行时间重排。 */
function readRecent(n, skip) {
  const N = Math.max(1, Number(n) || 12);
  const off = Math.max(0, Number(skip) || 0);
  const items = list().slice(off, off + N);
  const out = [];
  for (const it of items) out.push(...readShard(it.key));
  out.sort();
  return out;
}

/* 某会话的分片（前端按会话分区时走这条）；days 不用，一个会话段数通常不多，全读。 */
function readConv(conv) {
  const out = [];
  for (const it of list()) if (it.conv === conv) out.push(...readShard(it.key));
  out.sort();
  return out;
}

/* 主文件最后一条的签名，给 8 秒轮询用：只读文件尾，不整份 parse。 */
function tailSig() {
  try {
    const st = fs.statSync(MAIN);
    return String(st.size) + '|' + String(Math.round(st.mtimeMs));
  } catch (e) { return 'err'; }
}

/* 一键删：传会话 base（无 __ 后缀）删该会话所有段；传完整 key 只删那一段。
 * 从主文件精确移除对应行 + 重建分片；删前调用方应先备份主文件。 */
function clearShard(key, backupMain) {
  if (!key) return { removed: 0, ok: false, error: '没给会话 key' };
  let raw = '';
  try { raw = fs.readFileSync(MAIN, 'utf8'); } catch (e) { return { removed: 0, ok: false, error: e.message }; }
  const wantConv = splitKey(key).conv;
  const fullKey = key.indexOf('__') > 0;
  const state = {}, used = Object.create(null), kept = [], removed = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const base = baseKeyOfLine(line);
    const seg = nextSeg(line, state[base]);
    // 与 appendLine/rebuild 同一套撞车去重，保证算出来的 key 与磁盘分片名一致
    let k = seg.key;
    if (seg.isNew && used[k]) { let s = 2; while (used[k + '#' + s]) s++; k = k + '#' + s; }
    used[k] = 1;
    state[base] = { start: seg.start, last: seg.last, n: seg.n, key: k };
    const hit = fullKey ? (k === key) : (base === wantConv);
    if (hit) removed.push(line); else kept.push(line);
  }
  try {
    if (backupMain) fs.writeFileSync(backupMain, raw, 'utf8');
    const tmp = MAIN + '.shard-tmp';
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, MAIN);
    rebuild();
    return { removed: removed.length, ok: true };
  } catch (e) { return { removed: 0, ok: false, error: e.message }; }
}

module.exports = { MAIN, DIR, SILENCE_MS, MIN_LINES, lineMs, stampOf, baseKeyOfLine, splitKey, nextSeg, appendLine, rebuild, list, listConversations, readShard, readRecent, readConv, tailSig, clearShard };
