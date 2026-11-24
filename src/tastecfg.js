/*
 * tastecfg.js — 喜好表的参数与锁（主人 2026-11-13 令）
 *
 * 原话：「模型的喜好表的参数我可以直接在这页调」「后期这个表会变非常多，仅在被询问喜欢哪些时，
 *   部分展示「喜欢」，其余「确认/可能」只在模型搜索时附带展示」「给虚幻的喜好表上锁，
 *   禁止你修改、查看，不许偷删」。
 *
 * 一份文件 data/喜好参数.json，三个用途：
 *   order   前端七栏的排列顺序（拖动直接改这里，读写逻辑跟着走，不写死）
 *   show    注入模型时的口径：特别栏是否每轮给、确定栏给多少、可能/中立给不给
 *   locked  锁：锁了以后**所有自动写入口**（模型抽取 / 机器人观察 / 助手脚本）一律拒绝，
 *           只有主人在面板里手动改才放行。锁本身也只能由主人改。
 *
 * 为什么不放进 soul/F-全场景通用主人设/0-我的喜好.md 的注释里：那份是给人看的正文，参数是机器读的；
 * 混在一起她手改正文时容易把参数弄坏。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', '喜好参数.json');

/* 七栏。key 是落盘/接口用的，label 是给人看的；顺序只是默认值，前端拖动后以文件为准。 */
const COLS = [
  { key: 'specialLike', label: '特别·喜欢', always: true },
  { key: 'likeConf', label: '喜欢（确定）', always: true },
  { key: 'likeGuess', label: '喜欢（可能）', always: false },
  { key: 'neutral', label: '中立', always: false },
  { key: 'hateConf', label: '讨厌（确定）', always: true },
  { key: 'hateGuess', label: '讨厌（可能）', always: false },
  { key: 'specialHate', label: '特别·讨厌', always: true },
];
const COL_KEYS = COLS.map(c => c.key);

const DEFAULT = {
  order: COL_KEYS.slice(),
  show: {
    special: true,        // 特别·喜欢 / 特别·讨厌 每轮都给
    confLimit: 12,        // 确定栏每栏最多给几条（超了只给前 N + 提示去检索）
    showGuess: false,     // 平时不给「可能」——她说「其余『确认/可能』只在模型搜索时附带展示」
    showNeutral: false,   // 平时不给「中立」（量最大）
    askLimit: 60,         // 她问「你喜欢什么」时，每栏展开几条
  },
  locked: false,
  at: 0,
};

let _cache = { at: -1, data: null };
function load() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return merge(DEFAULT); }
  if (_cache.at === st && _cache.data) return _cache.data;
  let o = {};
  try { o = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { o = {}; }
  const d = merge(o);
  _cache = { at: st, data: d };
  return d;
}
/* 补齐缺字段：老文件 / 她手改漏项都不至于让调用方拿到 undefined */
function merge(o) {
  const x = o || {};
  const order = Array.isArray(x.order) ? x.order.filter(k => COL_KEYS.indexOf(k) >= 0) : [];
  for (const k of COL_KEYS) if (order.indexOf(k) < 0) order.push(k);
  return {
    order,
    show: Object.assign({}, DEFAULT.show, x.show || {}),
    locked: !!x.locked,
    at: Number(x.at) || 0,
  };
}
function save(o) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const d = merge(Object.assign({}, load(), o || {}));
    d.at = Date.now();
    fs.writeFileSync(FILE, JSON.stringify(d, null, 1), 'utf8');
    _cache = { at: -1, data: null };
    return d;
  } catch (e) { console.error('[tastecfg] 存失败：' + e.message); return null; }
}
/* 锁：默认不开。开/关只由主人（面板）调用，参数里带 by:'master' 才认。 */
function isLocked() { return !!load().locked; }
function setLock(on, opt) {
  const by = String((opt && opt.by) || '');
  if (by !== 'master') return { error: '只有主人能改喜好表的锁' };
  const d = save({ locked: !!on });
  if (!d) return { error: '没写进去' };
  return { ok: true, locked: d.locked };
}
/* 自动写入口的统一闸：返回 true = 可以写。锁着的时候只有 byUser 能过。 */
function canWrite(opt) {
  if (!isLocked()) return true;
  return !!(opt && (opt.byUser || opt.by === 'master'));
}
function cols() { return COLS.map(c => ({ key: c.key, label: c.label, always: !!c.always })); }

module.exports = { FILE, COLS, COL_KEYS, DEFAULT, load, save, isLocked, setLock, canWrite, cols };
