/*
 * src/learn/style.js —— 「每个人自己的」三份档案
 *
 * 这是干什么的：记住「这个人是怎样的人、跟他说话不能做什么、他自己怎么说话」。
 * 注意别跟 `src/style.js` 混：那份是**主人**的说话风格（机器人是主人的分身）；
 * 这份是**每个对话者**的档案，一人一份，互不可见。
 *
 * 三份固定名字（schema.FILES.styleFiles），一份管一件事：
 *   角色性格.md        这个人是谁：身份、脾气、跟主人的关系、在意什么
 *   允许&禁止行为.md    跟这个人说话时不许做的事（一句一条，禁令放句首）
 *   预设发言例句.md     他自己说过的原话，只学味道，不许照样念
 *
 * 为什么必须每轮注入：他要求「每轮强制注入，优先级高于普通记忆」。
 * 所以 hot() 里这块排在好感摘要前面，且字数上限单算，不吃好感那 700 字。
 */
const fs = require('fs');
const path = require('path');
const S = require('./schema');
const store = require('./store');

const NAMES = S.FILES.styleFiles;          // ['角色性格.md', '允许&禁止行为.md', '预设发言例句.md']
const KEYS = ['角色性格', '允许&禁止', '例句'];

// 「有没有这个人」问 people（人物表才是人的正本），不问目录：
// 目录只在写过东西之后才存在，拿它判断会导致第一次写就被拒。
function exists(pid) {
  try { return !!require('../people').get(pid); } catch (e) { return false; }
}

function dirOf(pid) { return path.join(store.userDir(pid), S.FILES.styleDir); }
function pathOf(pid, key) {
  const i = KEYS.indexOf(key);
  return path.join(dirOf(pid), NAMES[i < 0 ? 0 : i]);
}

function readRaw(pid, key) {
  try { return fs.readFileSync(pathOf(pid, key), 'utf8'); } catch (e) { return ''; }
}
function clean(text) {
  // 去掉标题行和引用说明行：注入时只留能照着做的句子，省 token
  return String(text || '').split('\n')
    .filter(l => !/^#{1,6}\s/.test(l) && !/^>\s?/.test(l))
    .join('\n').trim();
}

/* 三份一起读。空的那份返回空串，调用方自己决定要不要注入。 */
function read(pid) {
  const out = { pid: String(pid) };
  KEYS.forEach(k => { out[k] = clean(readRaw(pid, k)); });
  return out;
}

function has(pid) {
  const r = read(pid);
  return KEYS.some(k => r[k]);
}

/* 写一份。text 为空等于清空这一份（返回 ok，不删文件：留着她能回退看历史）。 */
function write(pid, key, text, by) {
  if (KEYS.indexOf(key) < 0) return { error: '未知的一份：' + key + '（只认 角色性格 / 允许&禁止 / 例句）' };
  if (!exists(pid)) return { error: '没有这个人：' + pid };
  const p = pathOf(pid, key);
  store.ensureDir(path.dirname(p));
  const body = String(text || '').slice(0, S.LIMITS.styleFileChars);
  const head = '# ' + key + '（' + pid + '）\n\n'
    + '> 这是干什么的：给虚幻看的一页，每轮都进提示词。写短句，一句一条。\n'
    + '> 改这一页等于改它对这个人的判断，不删历史（旧内容在 .bak 里）。\n\n';
  try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch (e) {}
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, head + body + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return { ok: true, file: p, chars: body.length, by: by || 'master' };
}

/* 追加一张例句：例句那份只追加、不覆盖（原话要留全）。 */
function addSample(pid, line, meta) {
  const t = String(line || '').trim();
  if (!t) return { error: '例句是空的' };
  const p = pathOf(pid, '例句');
  store.ensureDir(path.dirname(p));
  if (!fs.existsSync(p)) write(pid, '例句', '', 'bot');
  fs.appendFileSync(p, '- ' + t.slice(0, S.LIMITS.styleSampleChars)
    + (meta && meta.from ? '（' + String(meta.from).slice(0, 20) + '）' : '') + '\n', 'utf8');
  return { ok: true };
}

/* ---------- 每轮注入的那一块 ---------- */
/* 优先级最高，所以放在 hot() 最前面；三份都有内容才三块全给。
 * 写成 flash 能读的形状：一条规则一句，禁令放句首，条件写「如果…就…」。 */
function block(pid, nick, maxChars) {
  const r = read(pid);
  if (!KEYS.some(k => r[k])) return '';
  const who = String(nick || '').trim() || '这个人';
  const parts = ['## 他（' + who + '）是谁'];
  if (r['角色性格']) parts.push('他这个人：\n' + r['角色性格']);
  if (r['允许&禁止']) parts.push('跟他说话：\n' + r['允许&禁止']);
  if (r['例句']) {
    parts.push('他自己这么说过（只学味道，不许把这些句子说出来）：\n' + r['例句']);
  }
  const text = parts.join('\n');
  const cap = Number(maxChars) > 0 ? Number(maxChars) : S.LIMITS.styleHotChars;
  return text.length <= cap ? text : text.slice(0, cap) + '\n…（这一页还有，先看这些）';
}

module.exports = { KEYS, NAMES, read, has, write, addSample, block, pathOf, dirOf };
