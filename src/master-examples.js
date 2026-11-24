'use strict';
/* master-examples.js —— 「主人例句」（2026-11-22 主人定）
 *
 * 主人原话：「把问句和我的回复，对应记成重要的例子，到『星标』功能里，
 *   『星标』功能里新开一个比现在的『虚幻正确回复』高一级的『主人例句』。」
 *   「记成例子，但不要把我的话当成标准模版，而是要学习这种『撩人』感。」
 *
 * 所以这里是**最高一级的案例**（比 chat-stars 的正面样本高）：
 *   · 一条 = 一个问句 + 主人会怎么回 + 为什么这么回（机制，不是文案）
 *   · 只当「劲」的参照：允许换说法、换情绪，禁止照抄句子
 *   · 检索时 pri 最高（coord.js），提示词里排在最前（core/roco-bili）
 *
 * 文件：data/master-examples.json（数组，按时间正序）。
 * 字段：{ id, q, a, why, scene, t, by }
 *   q  对方那句话/那个问法（可用 x 占位商品名）
 *   a  主人示范回复（括号里可能是「（可怜的颜文字）」这种情绪提示，不当字面照抄）
 *   why 为什么这么回 —— 学的是这个
 *   scene 适用场景（bili-comment / qq / any），pick() 按场景筛
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'master-examples.json');

function list() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function save(arr) {
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2));
}

function add(x) {
  const q = String((x && x.q) || '').trim();
  const a = String((x && x.a) || '').trim();
  if (!q || !a) return { ok: false, why: '问句和回复都要有' };
  const arr = list();
  const id = 'mx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  const item = {
    id, q: q.slice(0, 120), a: a.slice(0, 300),
    why: String((x && x.why) || '').trim().slice(0, 300),
    scene: String((x && x.scene) || 'any').trim() || 'any',
    t: new Date().toISOString(), by: String((x && x.by) || 'master'),
  };
  arr.push(item);
  save(arr);
  return { ok: true, item, total: arr.length };
}

function remove(id) {
  const arr = list();
  const next = arr.filter(x => x && x.id !== id);
  if (next.length === arr.length) return { ok: false, why: '没这条' };
  save(next);
  return { ok: true, total: next.length };
}

/* 给提示词用：按场景挑 n 条（优先 scene 精确匹配，其次 any）。
 * 不返回 id/t，只回 q/a/why，省 token。 */
function pick(n, scene) {
  const arr = list();
  const s = String(scene || '').trim();
  const hit = arr.filter(x => x && s && x.scene === s);
  const any = arr.filter(x => x && (!x.scene || x.scene === 'any'));
  const pool = hit.length >= (n || 1) ? hit : hit.concat(any);
  const out = [];
  const seen = new Set();
  for (const x of pool) {
    if (!x || !x.q || !x.a || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ q: x.q, a: x.a, why: x.why || '' });
    if (out.length >= (n || 1)) break;
  }
  return out;
}

/* 把主人原句里的「（可怜的颜文字）」这类占位**换成对应颜文字**（主人 2026-11-22：
 * 「这个要你换成对应的颜文字，而不是删掉」）。面板展示保留原句，注入模型时走这里。 */
const EMO_FILL = [
  [/[（(][^）)]{0,12}可怜[^）)]{0,12}[）)]/g, '(｡•́︿•̀｡)'],
  [/[（(][^）)]{0,12}傲娇[^）)]{0,12}[）)]/g, '(￣^￣)ゞ'],
  [/[（(][^）)]{0,12}开心[^）)]{0,12}[）)]/g, '(≧▽≦)'],
  [/[（(][^）)]{0,12}得意[^）)]{0,12}[）)]/g, '(๑•̀ㅂ•́)و✧'],
  [/[（(][^）)]{0,12}委屈[^）)]{0,12}[）)]/g, '[委屈]'],
];
function renderText(s) {
  let t = String(s || '');
  for (const [re, to] of EMO_FILL) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

module.exports = { list, add, remove, pick, renderText, FILE };
