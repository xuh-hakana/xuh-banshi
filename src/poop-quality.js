/* ===========================================================================
 * poop-quality.js — 优质屎判定（主人 2026-11-24 原话）
 *
 * 原话：「发到群里后被点赞了、回复了、后续5分钟群聊关键词和发的屎重合了。
 *        这屎列为优质屎，优先进入b站动态搬屎队列」
 *
 * 判定对象：虚幻搬到目标群的那条屎（AstrBot 插件转发的那条）。
 * 三条命中任意一条即优质（主人 2026-11-24 选）：
 *   ① 被点赞（group_msg_emoji_like，消息号 = 转发消息号）
 *   ② 被回复（群友消息 reply 段指向转发消息号）
 *   ③ 后续 5 分钟内群聊关键词与屎重合（两字组覆盖率，零 token）
 * 结果：列为优质 → B站动态搬屎队列插队到最前，仍占每天 10 条额度。
 * 日记不参与（单独发，见 diary-publish）。
 *
 * 【怎么把目标群那条对回 B站队列那条】
 * 真搬运跑在 AstrBot 插件 astrbot_plugin_banshi_auto，它把源群消息转发到目标群，
 * 同时把同一条源群消息导出成 inbox JSON（id = 源群 mid）。所以转发消息展开后的
 * 文本/图片 = inbox item 的文本/图片，是同一份内容。两条链路各自算同一个 contentKey，
 * 命中即可对回，不依赖转发消息号（转发后新号 ≠ 源群 mid，不能用号对）。
 *
 * 【注入】start({cfgLive, dataFile})；qq.js 在收到转发/点赞/回复/群聊时调 hook。
 * publisher 入队前调 isPremium(text, images) 查台账定优先级。
 * =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DATA = path.join(__dirname, 'data', 'poop-quality.json');
const DEFAULT = {
  enabled: true,
  windowSeconds: 300,      // ③ 的 5 分钟窗（主人原话）
  gramSize: 2,             // 两字组，和 websearch.js 的 grams 同思路，零 token
  minOverlap: 0.34,        // 关键词覆盖率门槛（呼应 websearch.RELEVANT_MIN）
  minSharedGrams: 2,       // 至少 2 个二字组重合才认，防单字巧合
  keepDays: 7,             // 台账保留天数
  maxKeys: 5000,
};

let cfgLive = null;
let dataFile = DEFAULT_DATA;
let state = null;   // { v:1, marks:{ key:{at,why,mid} } }

function cfg() {
  const c = (cfgLive && cfgLive()) || {};
  return Object.assign({}, DEFAULT, c.poopQuality || {});
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/* ---------- 台账落盘 ---------- */
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { state = null; }
  if (!state || typeof state !== 'object' || !state.marks || typeof state.marks !== 'object') {
    state = { v: 1, marks: {} };
  }
  return state;
}
function save() {
  try {
    const c = cfg();
    prune(c);
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = dataFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, dataFile);
  } catch (e) { console.log('[优质屎] 台账写不进去：' + e.message); }
}
function prune(c) {
  const st = load();
  const cut = Date.now() - Math.max(1, num(c.keepDays, 7)) * 86400000;
  const keys = Object.keys(st.marks).filter(k => Number((st.marks[k] || {}).at) >= cut);
  const keep = keys.slice(-Math.max(1, num(c.maxKeys, 5000)));
  const next = {};
  for (const k of keep) next[k] = st.marks[k];
  st.marks = next;
}

/* ---------- 内容指纹（qq.js 转发展开 与 publisher inbox 共用这一处） ---------- */
const norm = s => String(s == null ? '' : s)
  .toLowerCase()
  .replace(/\[[^\]]*\]/g, '')                       // 去 [图片]/[表情]/[视频] 占位
  .replace(/[\s\u200b-\u200f\ufeff]+/g, '')         // 去空白/零宽
  .replace(/[，。！？、；：~～…·,.!?;:'"“”‘’()（）【】\[\]「」『』\/\\|<>《》\-—]/g, '');

/* text: 正文；imageKeys: 图片稳定标识数组（转发展开和 inbox 都取同一套：文件名去扩展 / url 尾段） */
function contentKey(text, imageKeys) {
  const t = norm(text).slice(0, 1500);
  const imgs = (Array.isArray(imageKeys) ? imageKeys : [])
    .map(x => String(x || '').toLowerCase().split(/[?#]/)[0].split('/').pop().replace(/\.[a-z0-9]+$/, ''))
    .filter(Boolean).sort();
  const raw = t + '|' + imgs.join(',');
  if (!t && !imgs.length) return '';
  return crypto.createHash('sha1').update(raw).digest('hex');
}
/* 从 OneBot 图片段取稳定 key：file 名（NapCat 落盘名常为 md5）优先，其次 url 尾段 */
function imageKeyOf(seg) {
  const d = (seg && seg.data) || {};
  const f = String(d.file || '');
  const u = String(d.url || '');
  return f && !/^base64:\/\//.test(f) ? f.split('/').pop() : (u.split('/').pop() || '');
}
/* 从 publisher inbox item 取图片 keys */
function imageKeysOfItem(item) {
  return (Array.isArray(item && item.images) ? item.images : [])
    .map(im => String((im && (im.path || im.file || im.url)) || '').split('/').pop())
    .filter(Boolean);
}

/* ---------- 入口 hook ---------- */
/* ① 虚幻发的搬运消息：qq.js 展开转发后把 {text, imageKeys, mid} 交进来，记一条观察。
 *    用 mid 作观察索引（目标群转发消息号），点赞/回复事件带的就是这个号。 */
const watching = new Map();   // mid -> { key, at }
function noteSent({ mid, text, imageKeys, at }) {
  const c = cfg();
  if (!c.enabled || !mid) return '';
  const key = contentKey(text, imageKeys);
  if (!key) return '';
  watching.set(String(mid), { key, text: String(text || ''), at: Number(at) || Date.now() });
  if (watching.size > 2000) {
    const cut = Date.now() - Math.max(600000, num(c.windowSeconds, 300) * 1000) * 4;
    for (const [k, v] of watching) if (Number(v.at) < cut) watching.delete(k);
  }
  return key;
}

/* ②③ 点赞 / 回复命中：mid = 被点赞/被回复的那条转发消息号。
 *    转发出去后群友的点赞/引用都挂在新号上，正好和 noteSent 的 mid 对齐。 */
function hitByMid(mid, why) {
  const c = cfg();
  if (!c.enabled || !mid) return false;
  const w = watching.get(String(mid));
  if (!w) return false;
  // 观察窗：点赞/回复也算在发屎后 N 分钟内（主人默认统一 5 分钟）
  if (Date.now() - Number(w.at) > Math.max(60000, num(c.windowSeconds, 300) * 1000) * 12) return false;
  return mark(w.key, why, mid);
}

/* ③ 群聊关键词重合：后续 5 分钟内，群友发言的二字组覆盖率达标即命中。
 *    这里按内容 key 反查所有在窗内的观察项（不依赖 mid）。 */
function hitByChat(text, at) {
  const c = cfg();
  if (!c.enabled) return false;
  const gs = grams(text, num(c.gramSize, 2));
  if (!gs.size) return false;
  const now = Number(at) || Date.now();
  const win = Math.max(1, num(c.windowSeconds, 300)) * 1000;
  let any = false;
  for (const [mid, w] of watching) {
    if (now - Number(w.at) > win) continue;
    const their = grams(w.text || '', num(c.gramSize, 2));   // noteSent 存的正文
    if (their.size < num(c.minSharedGrams, 2)) continue;
    let hit = 0;
    for (const g of gs) if (their.has(g)) hit++;
    if (hit >= num(c.minSharedGrams, 2) && hit / Math.min(gs.size, their.size) >= num(c.minOverlap, 0.34)) {
      any = mark(w.key, 'keyword', mid) || any;
    }
  }
  return any;
}
/* 观察项要留正文供关键词比对（watching 只存 key 不够）——noteSent 里补存 textGrams */
function grams(s, size) {
  const set = new Set();
  const clean = norm(s).replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  const n = Math.max(1, num(size, 2));
  for (const tok of clean.split(' ')) {
    if (tok.length < 2) continue;
    if (tok.length <= n) { set.add(tok); continue; }
    for (let i = 0; i + n <= tok.length; i++) set.add(tok.slice(i, i + n));
  }
  return set;
}

function mark(key, why, mid) {
  const st = load();
  if (!key) return false;
  const old = st.marks[key];
  if (old) { old.at = Date.now(); old.hit = (old.hit || 1) + 1; save(); return false; }
  st.marks[key] = { at: Date.now(), why: String(why || ''), mid: String(mid || '') };
  save();
  console.log('[优质屎] 命中（' + (why || '?') + '）→ 列入优质，B站队列插队');
  return true;
}

/* publisher 入队前查：这条屎是否被判过优质 */
function isPremium(text, imageKeys) {
  const c = cfg();
  if (!c.enabled) return false;
  const key = contentKey(text, imageKeys);
  if (!key) return false;
  const m = load().marks[key];
  if (!m) return false;
  const cut = Date.now() - Math.max(1, num(c.keepDays, 7)) * 86400000;
  if (Number(m.at) < cut) return false;
  return true;
}

function start(opts) {
  const o = opts || {};
  cfgLive = o.cfgLive || null;
  dataFile = o.dataFile || DEFAULT_DATA;
  state = null;
  load();
  console.log('[优质屎] 已启动（命中点赞/回复/5分钟关键词 → B站队列插队；台账 ' + dataFile + '）');
}
function stop() { watching.clear(); }

module.exports = {
  start, stop, contentKey, imageKeyOf, imageKeysOfItem, noteSent, hitByMid, hitByChat, isPremium, grams, mark,
  _state: () => load(), _watching: watching, _setState: s => { state = s; },
  _setDataFile: p => { dataFile = p; state = null; }, _DEFAULT: DEFAULT,
};
