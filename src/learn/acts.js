/*
 * src/learn/acts.js —— 冷层：交互元记录
 *
 * 这是干什么的：记「这一轮说了什么话题、给谁、依据是什么」。
 * 她 2026-11-09 的原话要求：可审计、可追溯、能按话题/对象/时间检索；
 * 输出要打话题标签和对象标签。
 *
 * 和 chat-log 的区别：chat-log 是「说过什么」的原文流水，给检索用；
 * 这里是「为什么这么说」的索引——话题、对象、证据，一条对应一次输出。
 * 不复制原文，只存摘要 + 指向原文的引用（ref），避免两份原文对不上。
 *
 * 只追加：acts/<YYYY-MM>.jsonl，永不改旧行。
 */
const path = require('path');
const fs = require('fs');
const S = require('./schema');
const store = require('./store');
const search = require('./search');

function monthFile(month) { return path.join(S.PATHS.acts, (month || store.monthKey()) + '.jsonl'); }

function months() {
  try {
    return fs.readdirSync(S.PATHS.acts)
      .filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 7)).sort();
  } catch (e) { return []; }
}

/* ---------- 写入 ---------- */
/* act: {
 *   pid, nick,                对谁（pid 可空：不认识的人）
 *   where: 'group'|'private', groupId
 *   topic: ['学习系统', '好感衰减'],   话题标签
 *   knowledge: [{title, ref}],        这次输出用到的知识
 *   text,                             输出内容摘要（≤120 字，不存全文）
 *   evidence: [{ref, quote}],         凭什么这么说
 *   kind: 'reply'|'proactive'
 * } */
function record(act) {
  const a = act || {};
  const row = {
    id: store.uid('act'),
    ts: store.iso(),
    day: store.dayKey(),          // 本地日期，检索/显示都按这个（ts 是 UTC）
    pid: a.pid ? String(a.pid) : null,
    nick: String(a.nick || '').slice(0, 40),
    where: a.where === 'private' ? 'private' : 'group',
    groupId: a.groupId ? String(a.groupId) : null,
    topic: (Array.isArray(a.topic) ? a.topic : [a.topic]).map(s => String(s || '').trim()).filter(Boolean).slice(0, 5),
    knowledge: (Array.isArray(a.knowledge) ? a.knowledge : []).slice(0, 5).map(k => ({
      title: String((k && k.title) || '').slice(0, 60),
      ref: String((k && k.ref) || '').slice(0, 160),
    })),
    text: String(a.text || '').slice(0, S.LIMITS.actTextChars),
    evidence: (Array.isArray(a.evidence) ? a.evidence : []).slice(0, 4).map(e => ({
      ref: String((e && e.ref) || '').slice(0, 160),
      quote: String((e && e.quote) || '').slice(0, 200),
    })),
    kind: a.kind === 'proactive' ? 'proactive' : 'reply',
    auto: a.auto === true,        // true = 事后从 chat-log 补的，不是实时记的
  };
  store.appendJSONL(monthFile(), row);
  return { ok: true, id: row.id, month: store.monthKey() };
}

/* ---------- 检索 ---------- */
/* 三种过滤可叠加：对象（pid）、话题（模糊匹配）、时间范围。
 * 给了 q 就再走一遍混合打分，没给就按时间倒序。 */
async function query(opt) {
  const o = opt || {};
  const from = o.from ? String(o.from) : '';
  const to = o.to ? String(o.to) : '';
  let rows = [];
  months().forEach(m => {
    if (from && m < from.slice(0, 7)) return;
    if (to && m > to.slice(0, 7)) return;
    rows = rows.concat(store.readJSONL(monthFile(m)));
  });
  if (o.pid) rows = rows.filter(r => r.pid === String(o.pid));
  if (o.groupId) rows = rows.filter(r => r.groupId === String(o.groupId));
  // 旧记录没有 day 字段，这里补算本地日期（ts 是 UTC，凌晨会显示成前一天）
  rows = rows.map(r => Object.assign({}, r, { day: r.day || store.localDate(r.ts) }));
  if (from) rows = rows.filter(r => String(r.ts || '') >= from);
  if (to) rows = rows.filter(r => String(r.ts || '') <= to);
  if (o.topic) {
    const t = String(o.topic);
    rows = rows.filter(r => (r.topic || []).some(x => x.includes(t) || t.includes(x)));
  }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const q = String(o.q || '').trim();
  if (q && rows.length) {
    const docs = rows.map(r => ({ text: (r.text || '') + ' ' + (r.topic || []).join(' ') }));
    const hits = await search.search(docs, q, { n: o.limit || 20 });
    return hits.map(h => rows[h.i]);
  }
  return rows.slice(0, o.limit || 20);
}

/* 按话题聚合：一段时间的输出都落在哪些话题上（复盘用） */
function topics(opt) {
  const o = opt || {};
  const acc = {};
  months().forEach(m => {
    store.readJSONL(monthFile(m)).forEach(r => {
      if (o.pid && r.pid !== String(o.pid)) return;
      (r.topic || []).forEach(t => { acc[t] = (acc[t] || 0) + 1; });
    });
  });
  return Object.keys(acc).map(t => ({ topic: t, n: acc[t] })).sort((a, b) => b.n - a.n);
}

function counts() {
  let total = 0;
  months().forEach(m => { total += store.readJSONL(monthFile(m)).length; });
  return { total, months: months() };
}

/* ---------- 事后补录：从 chat-log 增量生成 ---------- */
/* 为什么不是实时写：发送链路是热路径（一错就丢消息），往里加读盘不划算。
 * chat-log 本身是完整的文本流水，事后按行扫一遍就能拿到「谁对谁说了什么」，
 * 而且不碰发送逻辑、不改任何老行为。
 *
 * 只认两件事：昵称等于机器人自己名字的行 = 输出；它前面那条别人说的话 = 证据。
 * topic 不打标签（auto:true）——编标签比没有更糟，等她复盘或实时入口再补。
 */
function botName() {
  try { return String(require('../config').cfgLive().persona.botName || '虚幻'); }
  catch (e) { return '虚幻'; }
}

function syncFromChatLog(opts) {
  const o = opts || {};
  const CHAT = path.join(__dirname, '..', 'data', 'chat-log.jsonl');
  const cursorFile = path.join(S.PATHS.acts, '.cursor.json');
  let raw = '';
  try { raw = fs.readFileSync(CHAT, 'utf8'); } catch (e) { return { added: 0, error: '读不到 chat-log' }; }
  const lines = raw.split('\n');
  const cur = store.readJSON(cursorFile, { line: 0 });
  const start = Math.max(0, Math.min(Number(cur.line) || 0, lines.length));
  const name = botName();
  const out = { added: 0, scanned: 0, from: start, to: start };

  // 从 start 前一行的位置开始找「上一句别人说的话」，给第一条输出配证据
  const max = Number(o.max) > 0 ? Number(o.max) : 300;     // 一次最多补几条：历史很长时别一口气灌进去
  const pending = [];
  let prevOther = null;
  for (let i = Math.max(0, start - 1); i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = /^(\S+Z) \[([^\]]+)\]\[群(\d+)\]\[([^\]]+)\](?:\[→([^\]]*)\])?\s?([\s\S]*)$/.exec(line);
    if (!m) continue;
    if (i < start) out.scanned += 1;
    const nick = m[4], to = m[5] || '', text = m[6] || '';
    const ref = 'chat-log.jsonl:' + (i + 1);
    if (nick !== name) { prevOther = { nick, text: text.slice(0, 200), ref }; continue; }
    if (i < start) { prevOther = null; continue; }        // 旧行不重记
    out.scanned += 1;
    pending.push({
      nick: to,
      where: 'group',
      groupId: m[3],
      topic: [],
      text,
      evidence: prevOther ? [prevOther] : [],
      kind: o.kind || 'reply',
      auto: true,
    });
    prevOther = null;
  }
  pending.slice(-max).forEach(a => { record(a); out.added += 1; });
  out.to = lines.length;
  store.writeJSON(cursorFile, { line: out.to, at: store.iso() });
  return out;
}

module.exports = { record, query, topics, counts, months, monthFile, syncFromChatLog, botName };
