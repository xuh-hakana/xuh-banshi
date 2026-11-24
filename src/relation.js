/*
 * relation.js — 喜 / 无感 / 厌 人物表（主人 2026-11-13 令）
 *
 * 原话（2026-11-13 21:00 逐字，覆盖同日早先那版）：
 * 「共同「话题」大于2，互相变成「喜」。a辱骂b，a「厌」b。如原本是「喜」，降级「无感」，
 *   并重新计话题数到2升回。如「厌」因共同话题升级，变「无感」。」
 * 拆成状态机（当前态度决定辱骂的结果，不是三条并列短语）：
 *   · 任意 + 共同话题 > 2            → 互相「喜」
 *   · 非喜 + a 辱骂 b                → a「厌」b
 *   · 喜   + a 辱骂 b                → 降「无感」，话题计数清零，重新累计到阈值才升回「喜」
 *   · 厌   + 共同话题升级            → 只到「无感」，本条不作数、清零重新攒，不许当场升「喜」
 * 阈值：沿用「>2」＝第 3 条（LIKE_AT）。她写「到 2 升回」，台账记着暂按沿用 3 条、未再问。
 *
 * 落盘 data/人物关系.json：
 *   { "qq:10001": { "qq:10002": { "s": "like|neutral|hate", "n": 3, "at": 0, "why": "共同话题" } } }
 *   · 键是「谁看谁」：外层 = 看的人，内层 = 被看的人。方向性是真的（a 厌 b 不等于 b 厌 a），
 *     只有「共同话题过 2」才会**双向**变喜。
 *   · 没记录的 = 无感（neutral），不写盘。人物表里新来的人天然是无感，不需要建档。
 *   · 只认人物表里有的账号（people.pidOfKey 查得到），凭空造出来的号不记。
 *
 * 为什么不塞进 people.json：那是人物档案（一个 pid 一份），这是**两人之间**的关系；
 * 混在一起会让 people.json 变成 n² 的矩阵，面板加载一次就卡。
 */
const fs = require('fs');
const path = require('path');
const people = require('./people');
const { botWrite } = require('./wlog');

const FILE = path.join(__dirname, 'data', '人物关系.json');
const STANCES = ['like', 'neutral', 'hate'];
const LABEL = { like: '喜', neutral: '无感', hate: '厌' };
const LIKE_AT = 3;        // 「共同话题大于 2」→ 第 3 条起算互喜
const TOPIC_CAP = 9;      // 计数封顶，别让一个词被反复提就堆到几百

let _cache = { at: -1, data: null };
function load() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return {}; }
  if (_cache.at === st && _cache.data) return _cache.data;
  let o = {};
  try { o = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { o = {}; }
  _cache = { at: st, data: o };
  return o;
}
function save(o) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 1), 'utf8');
    _cache = { at: -1, data: null };
    return true;
  } catch (e) { console.error('[relation] 存失败：' + e.message); return false; }
}
const keyOf = v => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  try { return people.keyOf(s); } catch { return s; }
};
/* 只认人物表里有的账号；查不到返回 ''（不凭空造人） */
function known(v) {
  const k = keyOf(v);
  if (!k) return '';
  try { return people.pidOfKey(k) ? k : ''; } catch { return ''; }
}
function stanceOf(a, b) {
  const A = known(a), B = known(b);
  if (!A || !B || A === B) return 'neutral';
  const rec = (load()[A] || {})[B];
  return rec && STANCES.indexOf(rec.s) >= 0 ? rec.s : 'neutral';
}
function countOf(a, b) {
  const A = known(a), B = known(b);
  if (!A || !B || A === B) return 0;
  const rec = (load()[A] || {})[B];
  return (rec && Number(rec.n)) || 0;
}
function setStance(a, b, s, opt) {
  const A = known(a), B = known(b);
  const st = STANCES.indexOf(String(s)) >= 0 ? String(s) : '';
  if (!A || !B || A === B || !st) return false;
  const o = load();
  o[A] = o[A] || {};
  const prev = o[A][B] || {};
  // 无感就是「没态度」：不留记录，省得文件里堆一堆 neutral
  if (st === 'neutral') { delete o[A][B]; }
  else o[A][B] = { s: st, n: st === 'like' ? Number(prev.n || 0) : 0, at: Date.now(), why: String((opt && opt.why) || '') };
  if (!Object.keys(o[A]).length) delete o[A];
  if (!save(o)) return false;
  botWrite('data/人物关系.json', '关系', people.labelOfKey(A) + ' → ' + people.labelOfKey(B) + '：' + LABEL[st]);
  return true;
}
/* 共同话题（主人 2026-11-13 21:00 逐字版）：
 *   · 每多一条共同话题，n+1；n 到 LIKE_AT（大于 2）→ 双向「喜」；
 *   · 已经是「喜」的保持；已经是「厌」的**只回到无感**，本条不作数、计数清零重新攒，
 *     不许同一条话题里紧接着又判 n>=3 连跳到「喜」（2026-11-13 修掉的两级跳）。
 * 返回 [{a,b,s}] 变化，方便日志/测试。 */
function noteTopics(participants) {
  const ks = [];
  for (const p of (participants || [])) {
    const k = known(p && (p.key || p));
    if (k && ks.indexOf(k) < 0) ks.push(k);
  }
  if (ks.length < 2) return [];
  const o = load();
  const changed = [];
  const bump = (a, b) => {
    o[a] = o[a] || {};
    const cur = o[a][b] || { s: 'neutral', n: 0, at: 0, why: '' };
    let n = Math.min(TOPIC_CAP, Number(cur.n || 0) + 1);
    let s = cur.s;
    let reset = false;
    if (s === 'hate') {
      s = 'neutral';                       // 厌 → 无感，不直接变喜
      n = 0;                               // 本条不作数：清零重新攒，不许下一条就升喜
      reset = true;
    }
    if (!reset && n >= LIKE_AT && s === 'neutral') s = 'like';
    // 无感也要留计数：不留的话每次从 0 重新数，永远到不了 3（自测踩到）
    o[a][b] = { s, n, at: Date.now(), why: '共同话题' };
    changed.push({ a, b, s });
  };
  for (let i = 0; i < ks.length; i++) {
    for (let j = 0; j < ks.length; j++) {
      if (i === j) continue;
      bump(ks[i], ks[j]);
    }
  }
  if (save(o)) botWrite('data/人物关系.json', '关系', '共同话题 +1：' + ks.map(k => people.labelOfKey(k)).join(' / '));
  return changed;
}
/* a 辱骂 b（主人 2026-11-13 21:00 逐字版）：
 *   · 原本不是「喜」→ 直接「厌」；
 *   · 原本是「喜」→ 降成「无感」，并且共同话题计数清零（「降级「无感」，并重新计话题数到2升回」）。
 *     删掉整条记录 = neutral + n=0：显式写成规则，不靠「删了自然就清零」这种隐式行为，
 *     免得以后有人给 neutral 补记录时把这条弄丢。
 *   · 只会改 a 看 b 的方向，不反向记仇。 */
function noteInsult(a, b) {
  const A = known(a), B = known(b);
  if (!A || !B || A === B) return { s: '' };
  const o = load();
  const cur = (o[A] || {})[B] || { s: 'neutral', n: 0 };
  let s, reset = false;
  if (cur.s === 'like') {
    o[A] = o[A] || {};
    delete o[A][B];                         // = 降无感 + 话题计数清零，之后重新累计到阈值才升回
    if (!Object.keys(o[A]).length) delete o[A];
    s = 'neutral';
    reset = true;
  } else {
    o[A] = o[A] || {};
    o[A][B] = { s: 'hate', n: 0, at: Date.now(), why: '辱骂' };
    s = 'hate';
  }
  save(o);
  botWrite('data/人物关系.json', '关系', people.labelOfKey(A) + ' → ' + people.labelOfKey(B) + '：' + (s === 'hate' ? '厌（辱骂）' : '喜降为无感（辱骂，话题计数清零）'));
  return { s, before: cur.s, reset };
}
/* 观察「这两人认识」（主人 2026-11-13：「虚幻观察群友对话时就能得知群友是不是认识，以此新增」）：
 * 只是给人物的关系留一条「见过互动」的痕迹，不改态度（默认就是无感）。 */
function touchPair(a, b) {
  const A = known(a), B = known(b);
  if (!A || !B || A === B) return false;
  const o = load();
  o[A] = o[A] || {};
  const cur = o[A][B] || { s: 'neutral', n: 0, at: 0 };
  if (cur.seen) return true;                       // 已经记过「认识」，不反复写盘
  o[A][B] = Object.assign({}, cur, { at: Date.now(), seen: true });
  return save(o);
}
/* 某人看所有人的态度：只返回人物表里还在的人，neutral 单独一列（前端默认隐藏） */
function listFor(owner) {
  const A = known(owner);
  const out = { like: [], neutral: [], hate: [] };
  if (!A) return out;
  const o = load();
  const mine = o[A] || {};
  const seen = new Set();
  for (const pid of new Set(people.all().map(p => p.pid))) {
    for (const acc of (people.accountsOf(pid) || [])) {
      const k = acc.platform + ':' + acc.id;
      if (k === A || seen.has(k)) continue;
      seen.add(k);
      const rec = mine[k] || {};
      const s = STANCES.indexOf(rec.s) >= 0 ? rec.s : 'neutral';
      out[s].push({ key: k, pid, name: people.labelOfKey(k), n: Number(rec.n || 0), why: String(rec.why || '') });
    }
  }
  for (const s of STANCES) out[s].sort((x, y) => (y.n - x.n) || x.name.localeCompare(y.name, 'zh'));
  return out;
}
/* 给模型看的：只给「喜 / 厌」，无感不给（量大且没信息量） */
function blockFor(owner) {
  const r = listFor(owner);
  const rows = [];
  if (r.like.length) rows.push('他喜欢的人：' + r.like.map(x => x.name).join('、'));
  if (r.hate.length) rows.push('他讨厌的人：' + r.hate.map(x => x.name).join('、'));
  return rows.join('\n');
}
module.exports = { FILE, STANCES, LABEL, LIKE_AT, load, save, stanceOf, countOf, setStance, noteTopics, noteInsult, touchPair, listFor, blockFor, keyOf, known };
