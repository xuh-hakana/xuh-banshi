/*
 * tastecopy.js — ⑧「本地模型专用喜好表」副本 + 两表之间转移 / 复制 / 差异记录
 *
 * 主人 2026-11-13 原文：
 *   「复制『虚幻喜好表』改为本地模型专用的『喜好表』，所有内容保持不变。」
 *   「我可以在两个表之间转移 / 复制。」
 *   「新增 / 删减喜好等不同的部分也能兼容记录。」
 *   「全部完成后，给虚幻的本地模型喜好表上锁，禁止你修改、查看，不许偷删。」（⑩）
 *
 * 为什么单独一份文件：本地模型弱，她后续会大量删词条省 token；删了不能影响虚幻自己那一份。
 * 用 taste.mineWords / mineSecOf 同一套解析，不建第二套格式，也不复制代码。
 *
 * 写词一律「保留原行前缀 + 只动词」：喜好表里 neutral 有两行（中立 / 还没表态），
 * 重写整行会把另一行吞掉，这是真会丢数据的坑。
 */
const fs = require('fs');
const path = require('path');
const taste = require('./taste');

const MINE_FILE = taste.MINE_FILE;                                   // soul/F-全场景通用主人设/0-我的喜好.md
const LOCAL_FILE = path.join(__dirname, 'data', '喜好表-本地模型.md');
const LOCK_FILE = path.join(__dirname, 'data', '喜好表-本地模型.lock.json');
const LINE_RE = /^([-*]\s*[^:：]+?\s*[:：]\s*)(.*)$/;

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function exists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

/* 首次建副本：字节级复制，内容一个字不变（她要「所有内容保持不变」）。
 * 不自动执行：require 模块不该偷偷写盘；由 api('ensure') 或启动脚本显式调。 */
function ensure() {
  if (exists(LOCAL_FILE)) return { ok: true, created: false, file: 'data/喜好表-本地模型.md' };
  if (!exists(MINE_FILE)) return { error: '虚幻喜好表不存在，没法复制' };
  fs.copyFileSync(MINE_FILE, LOCAL_FILE);
  return { ok: true, created: true, file: 'data/喜好表-本地模型.md', sameBytes: read(MINE_FILE) === read(LOCAL_FILE) };
}

/* ⑩ 落锁：锁的是这份副本，不是 喜好参数.json 里那把（那是虚幻喜好表的锁）。
 * 锁上以后所有非主人写入口一律拒绝；助手也不得打开 / 打印 / 删除这份文件的内容。 */
function isLocked() {
  try { return !!(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) || {}).locked; } catch { return false; }
}
function lock(opt) {
  if (String((opt || {}).by) !== 'master') return { error: '只有主人能上这把锁' };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      locked: true, at: Date.now(), by: 'master',
      note: '本地模型喜好表已落锁：助手不得修改 / 查看 / 删除；程序按功能读取注入不算助手查看。',
    }, null, 1), 'utf8');
    return { ok: true, locked: true };
  } catch (e) { return { error: '没写进锁：' + e.message }; }
}
function canWrite(opt) { return !isLocked() || String((opt || {}).by) === 'master'; }

function wordsOf(file) {
  const w = taste.mineWords(file);
  const out = [];
  for (const sec of Object.keys(w)) for (const word of w[sec]) out.push({ sec, word });
  return out;
}
/* 追加词：认准该栏第一行，只往行尾加，前缀原样保留。已有就跳过。 */
function addWords(file, sec, words) {
  const lines = read(file).replace(/\r/g, '').split('\n');
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (m && taste.mineSecOf(m[1].replace(/^[-*]\s*/, '')) === sec) { hit = i; break; }
  }
  if (hit < 0) return { error: '这一栏在表里没有对应行：' + sec };
  const m = lines[hit].match(LINE_RE);
  const cur = m[2].split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  const added = [];
  for (const w of words) {
    const t = String(w || '').trim();
    if (!t || cur.indexOf(t) >= 0) continue;
    cur.push(t); added.push(t);
  }
  if (added.length) {
    lines[hit] = m[1] + cur.join('、');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
  }
  return { ok: true, added, skipped: words.length - added.length };
}
/* 删词：逐行按分隔符摘掉，前缀原样保留；不动其它行。 */
function delWords(file, words) {
  const want = new Set(words.map(w => String(w || '').trim()).filter(Boolean));
  const lines = read(file).replace(/\r/g, '').split('\n');
  const removed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m || !taste.mineSecOf(m[1].replace(/^[-*]\s*/, ''))) continue;
    const cur = m[2].split(/[、,，]/);
    const next = cur.filter(s => {
      const t = s.trim();
      if (!want.has(t)) return true;
      removed.push(t); return false;
    });
    if (next.length !== cur.length) lines[i] = m[1] + next.map(s => s.trim()).filter(Boolean).join('、');
  }
  if (removed.length) fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { ok: true, removed };
}
function fileOf(which) {
  return String(which || '') === 'local' ? LOCAL_FILE : MINE_FILE;
}
/* 两表之间复制 / 转移。源表里找不到这个词就不动（不凭空造喜好）。
 * 目标表按源表的栏位落——「转移 / 复制」是同一个词换一份表，不改栏。 */
function transfer(from, to, words, opt) {
  if (!canWrite(opt)) return { error: '本地模型喜好表已落锁，只有主人能改' };
  const fromFile = fileOf(from), toFile = fileOf(to);
  if (from === to) return { error: '源和目标不能是同一份表' };
  const src = wordsOf(fromFile);
  const dst = new Set(wordsOf(toFile).map(x => x.word));
  const bySec = {};
  for (const w of words) {
    const t = String(w || '').trim();
    const hit = src.find(x => x.word === t);
    if (!hit) continue;
    if (dst.has(t)) continue;
    (bySec[hit.sec] = bySec[hit.sec] || []).push(t);
  }
  const copied = [];
  for (const sec of Object.keys(bySec)) {
    const r = addWords(toFile, sec, bySec[sec]);
    if (r.error) return r;
    copied.push(...(r.added || []));
  }
  let removed = [];
  if (opt && opt.move) {
    removed = delWords(fromFile, copied).removed || [];
  }
  return { ok: true, copied, removed, from, to };
}
/* 差异：只记「哪边多 / 哪边少」，不因为一边删了就删另一边——她要能分别删。 */
function diff() {
  const a = wordsOf(MINE_FILE), b = wordsOf(LOCAL_FILE);
  const aw = new Set(a.map(x => x.word)), bw = new Set(b.map(x => x.word));
  return {
    ok: true,
    mineOnly: a.map(x => x.word).filter(w => !bw.has(w)),
    localOnly: b.map(x => x.word).filter(w => !aw.has(w)),
    both: a.map(x => x.word).filter(w => bw.has(w)).length,
    mineCount: a.length, localCount: b.length,
  };
}
/* ⑧ 注入时选哪份表（core.buildMessages 唯一调用点，判定只在这里写一遍）：
 * 会话勾「本地优先」→ 副本；其余 / 副本不存在 / 任何异常 → 虚幻自己那份。
 * 绝不因为少文件让口味整段消失。 */
function fileFor(k) {
  if (!k) return MINE_FILE;
  try {
    const st = require('./conv-settings').get(k);
    if (st && st.model === 'local' && exists(LOCAL_FILE)) return LOCAL_FILE;
  } catch {}
  return MINE_FILE;
}
function list(which) {
  const f = fileOf(which);
  return { ok: true, which: which === 'local' ? 'local' : 'mine', file: path.basename(f), rows: wordsOf(f) };
}
function api(action, payload) {
  const p = payload || {};
  switch (action) {
    case 'ensure': return ensure();
    case 'status': return { ok: true, exists: exists(LOCAL_FILE), locked: isLocked(), mine: path.basename(MINE_FILE), local: path.basename(LOCAL_FILE) };
    case 'cols': return { ok: true, cols: taste.MINE_SECS.map(([key, label]) => ({ key, label })) };
    case 'list': return list(p.which);
    case 'diff': return diff();
    case 'copy': return transfer(p.from || 'mine', p.to || 'local', p.words || [], { by: p.by });
    case 'move': return transfer(p.from || 'mine', p.to || 'local', p.words || [], { by: p.by, move: true });
    case 'add': {
      if (!canWrite(p)) return { error: '本地模型喜好表已落锁，只有主人能改' };
      return addWords(fileOf(p.which), String(p.sec || ''), p.words || []);
    }
    case 'del': {
      if (!canWrite(p)) return { error: '本地模型喜好表已落锁，只有主人能改' };
      return delWords(fileOf(p.which), p.words || []);
    }
    case 'lock': return lock(p);
    default: return { error: '没这个动作：' + action };
  }
}

module.exports = { api, ensure, diff, transfer, isLocked, lock, canWrite, wordsOf, fileFor, MINE_FILE, LOCAL_FILE, LOCK_FILE };
