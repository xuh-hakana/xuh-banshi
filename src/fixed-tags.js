'use strict';
/*
 * src/fixed-tags.js —— 固定标签（2026-11-21 主人定）
 *
 * 这是干什么的：把「某人亲口认下的长期喜好」单独存一层，和《人物喜好》那张会被模型猜、
 * 会被自动抽取增删的表分开。固定标签的硬规则：
 *   ① 只有本人能取消：本人在聊天里明确说「不玩了 / 不喜欢了 / 退坑了…」才删；
 *   ② 主人可以在面板取消，但每次要先「解锁一次」（一次性 token，两分钟过期、用掉即废）；
 *   ③ 模型 / 自动抽取 / 脚本都不许改这一层——它只认本人原话和主人面板；
 *   ④ 其他人明确说「我喜欢玩 X」也自动立成固定标签（不止洛克王国）。
 *
 * 数据只有一份：src/data/fixed-tags.json（原子写，面板与机器人热读）。
 * 不写进 topics.jsonl / 人物喜好.md：一个是约定、一个是可猜的口味表，语义都不一样。
 *
 * 谁在用：
 *   core.learnTaste   —— 每条消息都路过，这里顺手认「立标签 / 本人取消」
 *   taste.block       —— 回这个人话时，把固定标签一起注入提示词（不许当猜测改掉）
 *   roco-merchant.js  —— @ 谁 = 查「洛克王国」标签持有人，再筛「接受这个提醒」的人
 *   panel.js          —— 列表 / 主人直接加 / 解锁一次后取消
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { botWrite } = require('./wlog');

const FILE = path.join(__dirname, 'data', 'fixed-tags.json');
const TAG_MAX = 24;
const UNLOCK_TTL_MS = 2 * 60 * 1000;   // 解锁一次的有效期：两分钟，且只能用一次

let _cache = null;
let _stamp = { mtimeMs: -1, size: -1 };
const _unlocks = new Map();            // token -> { qq, tag, exp }（只在面板进程内有效）

function normQq(v) { return String(v == null ? '' : v).trim().replace(/\D/g, ''); }

/* 把「玩洛克王国」「看番了」收成标签词：去掉前面的动词和句尾语气词，只留东西本身。 */
function normTag(v) {
  let s = String(v == null ? '' : v).trim()
    .replace(/^[\s，。！？、,.!?~～]+|[\s，。！？、,.!?~～]+$/g, '')
    .replace(/^(玩|看|听|吃|喝|打|刷|追|养|收集|买|肝)/, '')
    .replace(/(了|啦|呀|呢|啊|吧|哦|喔|嘛|哈)+$/g, '')
    .trim();
  if (!s || s.length > TAG_MAX) return '';
  return s;
}

function readAll() {
  try {
    const st = fs.statSync(FILE);
    if (_cache && _stamp.mtimeMs === st.mtimeMs && _stamp.size === st.size) return _cache;
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _cache = (j && Array.isArray(j.tags)) ? j : { version: 1, tags: [] };
    _stamp = { mtimeMs: st.mtimeMs, size: st.size };
  } catch { _cache = { version: 1, tags: [] }; }
  return _cache;
}

function writeAll(obj) {
  const out = { version: 1, tags: Array.isArray(obj && obj.tags) ? obj.tags : [] };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
    _cache = out;
    try { const st = fs.statSync(FILE); _stamp = { mtimeMs: st.mtimeMs, size: st.size }; } catch { _stamp = { mtimeMs: -1, size: -1 }; }
    return true;
  } catch (e) {
    console.log('[固定标签] 写不进：' + e.message);
    return false;
  }
}

function list() {
  return readAll().tags.map(x => Object.assign({}, x));
}

function of(qq) {
  const q = normQq(qq);
  if (!q) return [];
  return readAll().tags.filter(x => normQq(x.qq) === q).map(x => Object.assign({}, x));
}

function has(qq, tag) {
  const t = normTag(tag);
  return !!t && of(qq).some(x => x.tag === t);
}

/* 主人 / 系统直接立标签。同一个人同一个词只留一条，重复加只更新说明。 */
function add(o) {
  o = o || {};
  const qq = normQq(o.qq);
  const tag = normTag(o.tag);
  if (!qq || !tag) return { error: '要填 QQ 号和标签词' };
  const db = readAll();
  const tags = db.tags.slice();
  const i = tags.findIndex(x => normQq(x.qq) === qq && x.tag === tag);
  const rec = {
    qq, tag,
    name: String(o.name || (i >= 0 ? tags[i].name : '') || '').slice(0, 40),
    from: String(o.from || (i >= 0 ? tags[i].from : '主人')).slice(0, 20),
    note: String(o.note || (i >= 0 ? tags[i].note : '')).slice(0, 120),
    at: (i >= 0 ? tags[i].at : '') || new Date().toISOString(),
    by: /本人/.test(String(o.from || '')) ? 'self' : 'master',
  };
  if (i >= 0) tags[i] = Object.assign({}, tags[i], rec);
  else tags.push(rec);
  if (!writeAll({ tags })) return { error: '写不进 data/fixed-tags.json' };
  if (i < 0) botWrite('data/fixed-tags.json', '固定标签', qq + (rec.name ? '（' + rec.name + '）' : '') + '：立「' + tag + '」（' + rec.from + '）');
  return { ok: true, item: rec, created: i < 0 };
}

/* 删一条（内部用；两个入口都从这里走）：
 *   by='self'  本人原话取消，不需要解锁；
 *   by='panel' 主人面板取消，必须先 consumeUnlock 成功。
 * 模型 / 脚本没有别的删除入口。 */
function remove(qq, tag, opt) {
  const q = normQq(qq), t = normTag(tag);
  const o = opt || {};
  if (!q || !t) return { error: '要填 QQ 号和标签词' };
  if (o.by !== 'self') {
    if (!consumeUnlock(o.token, q, t)) return { error: '固定标签只能本人取消；面板取消要先解锁一次' };
  }
  const db = readAll();
  const before = db.tags.length;
  const tags = db.tags.filter(x => !(normQq(x.qq) === q && x.tag === t));
  if (tags.length === before) return { error: '没有这条固定标签' };
  if (!writeAll({ tags })) return { error: '写不进 data/fixed-tags.json' };
  botWrite('data/fixed-tags.json', '固定标签', q + '：取消「' + t + '」（' + (o.by === 'self' ? '本人说不喜欢了' : '主人面板解锁后取消') + '）');
  return { ok: true, removed: before - tags.length };
}

/* ===== 面板「解锁一次」 =====
 * 只发 token，不直接删；删的时候把 token 带回来，校验 QQ + 标签 + 有效期，用掉即作废。
 * token 只存在面板进程内存里，重启就失效（重启后要重新点一次解锁，符合「一次」）。 */
function issueUnlock(qq, tag) {
  const q = normQq(qq), t = normTag(tag);
  if (!q || !t) return { error: '要填 QQ 号和标签词' };
  const token = crypto.randomBytes(12).toString('hex');
  _unlocks.set(token, { qq: q, tag: t, exp: Date.now() + UNLOCK_TTL_MS });
  return { ok: true, token, ttlSec: Math.round(UNLOCK_TTL_MS / 1000) };
}
function consumeUnlock(token, qq, tag) {
  const k = String(token || '');
  if (!k) return false;
  const it = _unlocks.get(k);
  if (!it) return false;
  _unlocks.delete(k);
  if (it.exp < Date.now()) return false;
  return it.qq === normQq(qq) && it.tag === normTag(tag);
}

/* 标签持有人（@ 谁由这张表算，不写死 QQ 号）。 */
function holders(tag) {
  const t = normTag(tag);
  if (!t) return [];
  return Array.from(new Set(readAll().tags.filter(x => x.tag === t).map(x => normQq(x.qq)).filter(Boolean)));
}

/* ===== 从一句话里认「立标签 / 本人取消」 =====
 * 只认第一人称：「我喜欢玩 X」才立；「你喜欢什么」不算。
 * 取消只认这个人自己名下的标签，别人说「洛克王国不好玩」不会动到他的标签。 */
const LIKE_RE = /我[^，。！？!?,\s]{0,6}?(?:喜欢|爱玩|爱看|爱听|爱吃|爱喝|迷上|就好这口)([^，。！？!?,\s]{1,16})/;
const NEG_RE = /(不玩了|不想玩|不再玩|不怎么玩|不咋玩|不玩|退坑|弃坑|退游|脱坑|戒了|戒掉|不喜欢|不爱|腻了|玩腻|不感兴趣|没兴趣|卸载|删了|不追了|不看了|不吃了)/;
const STOP = /^(你|您|吗|呢|什么|怎么|啥|不|这|那|他|她|它|我)/;

/* 本人取消：这句话里出现了他的哪个标签，且附近有否定词。
 * 位置判断放宽到整句：中文口语常把标签放前面（「洛克王国我不玩了」）或后面（「我不玩洛克王国了」）。 */
function cancelBySpeech(qq, text) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return [];
  const mine = of(qq);
  if (!mine.length) return [];
  const out = [];
  for (const it of mine) {
    const i = s.indexOf(it.tag);
    if (i < 0) continue;
    // 否定词在这句话里就算（同一句里既提了标签又说不想玩，语义足够明确）
    if (!NEG_RE.test(s)) continue;
    const r = remove(it.qq, it.tag, { by: 'self' });
    if (r.ok) out.push(it.tag);
  }
  return out;
}

/* 亲口说喜欢 → 立标签。返回新立的词。 */
function addBySpeech(qq, name, text) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return [];
  const m = s.match(LIKE_RE);
  if (!m) return [];
  // 「你喜欢什么」是在问别人，不是自述：动词前面的那截里出现「你 / 您」就不算
  const head = m[0].slice(0, m[0].length - m[1].length);
  if (/你|您/.test(head)) return [];
  const tag = normTag(m[1]);
  if (!tag || STOP.test(tag) || has(qq, tag)) return [];
  // 否定句里出现的「喜欢」不算（「我不喜欢洛克王国」不该被立成标签）。
  // 注意「特别」里也有个「别」，先把它和几个常见词摘掉，再判否定词。
  const h2 = head.replace(/特别|区别|分别|告别|类别|性别|级别/g, '');
  if (/[不没别]/.test(h2)) return [];
  const r = add({ qq, name, tag, from: '本人亲口说', note: '聊天里明确说喜欢，自动立为固定标签' });
  return r.ok ? [tag] : [];
}

function learnSpeech(qq, name, text) {
  const cancelled = cancelBySpeech(qq, text);
  const added = addBySpeech(qq, name, text);
  return { cancelled, added };
}

/* 注入提示词用的一行。没有标签返回空串。 */
function lineFor(qq) {
  const tags = of(qq).map(x => x.tag);
  if (!tags.length) return '';
  return '固定标签（本人亲口认下或主人指定，不是猜的；不许当成「可能是」改掉）：' + tags.join('、');
}

module.exports = {
  FILE, list, of, has, add, remove, holders, lineFor,
  learnSpeech, cancelBySpeech, addBySpeech, normTag,
  issueUnlock, consumeUnlock,
  _read: readAll,
};
