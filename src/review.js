'use strict';
/*
 * review.js —— 三类知识的复核 / 锁定 / 署名隐私（主人 2026-11-12 定）
 *
 * 覆盖：教学知识（所有方向）、约定（所有分区/代称）、话题。
 * 口径（主人本轮四个决策）：
 *   · 5 条原记录 = 从 chat-log.jsonl 抓的**证据快照**，存在条目自己的 review.evidence 上；
 *     确认后只删这 5 条快照，chat-log.jsonl 原始日志一行不动。
 *   · 确认 = locked。locked 条目服务端硬拒一切 edit/del（不靠提示词、不靠前端禁用）。
 *   · 原作者本人在 QQ 里改口 → **旧锁定条物理删掉**，生成新条重新 pending → 重复整套流程。
 *   · 署名 id 不随「使用知识」注入；只有被问来源才 @ 作者问，明确拒绝 → deny 永不公开，
 *     其余（同意/没回/超时/岔开）→ 视为同意（allow）。
 *
 * 为什么是纯工具模块：三类数据各留在原文件（data/teach/*.jsonl、data/topics.jsonl、
 * data/people.json 的 alias），复核状态是**条目上的字段**，不建平行总表、不复制内容。
 * 本模块不写这些文件，只提供判据 + 快照生成，落盘由各自的写函数完成（单一数据源）。
 */
const fs = require('fs');
const path = require('path');

const CHAT = path.join(__dirname, 'data', 'chat-log.jsonl');
const ASK_TTL = 60 * 1000;             // 来源询问等待窗口：主人 2026-11-13 定，1 分钟没人应答就转临时代办

const PENDING = 'pending';              // 新录入 / 本人改口生成，等主人确认
const LEGACY = 'legacy';                // 老数据，未复核（按需补证据，不一次性扫 409 条）
const LOCKED = 'locked';                // 主人确认过，AI 与助手都不许删改

/* 被问「这条知识哪来的」——只在这种情况才涉及署名，其余场合一个 id 都不给。 */
const SOURCE_RE = /(谁教|谁跟你说|谁告诉你|谁说的|谁说|从哪学|哪学来|哪儿学|哪听来|听谁说|谁给|出处|来源是谁|谁跟讲|谁那听|是不是.*教|跟谁学)/;
/* 作者明确拒绝才 deny。没回 / 超时 / 岔开一律不算拒绝（= 其余视为同意）。 */
const DENY_RE = /(不行|不要|别说|别提|不许|不可以|别报|保密|别说我|别把我|不要说|别说出来|别讲|不要讲|不方便|算了.*别|不要暴露|别说是我)/;
const ALLOW_RE = /(可以|行啊|好啊|没问题|随你|说吧|嗯|ok|行|公开|告诉|没问题呀)/i;
/* 本人在 QQ 里改口：同一署名作者，明确说改 / 不对 / 别再回 X 了 / 改成 Y */
const REVISE_RE = /(改成|改一下|改了|不对|不是这个|别再|不用回|换成|重新记|记错了|刚才那条|那条.*改|我说的不是|应该是)/;

function isSourceQuestion(text) { return SOURCE_RE.test(String(text || '')); }
function isDenial(text) { return DENY_RE.test(String(text || '')); }
function isRevision(text) { return REVISE_RE.test(String(text || '')); }

/* ===== 条目上的复核状态 ===== */
function stateOf(it) {
  const r = it && it.review;
  return (r && (r.state === PENDING || r.state === LEGACY || r.state === LOCKED)) ? r.state : LEGACY;
}
function isLocked(it) { return stateOf(it) === LOCKED; }
/* 署名是不是主人自己（主人 2026-11-13：「我的署名默认全部公开」）。
 * 她的号写在 connect.json：masterQQ + masters[]，两个都算。*/
let _masters = null;
function masterIds() {
  if (_masters) return _masters;
  try {
    const c = require('./config').load() || {};
    _masters = new Set([c.masterQQ].concat(c.masters || []).map(x => String(x || '').replace(/^[a-z]+:/, '')).filter(Boolean));
  } catch { _masters = new Set(); }
  return _masters;
}
function isMine(it) {
  if (!it) return false;
  if (it.by === 'master') return true;
  const bare = s => String(s || '').replace(/^[a-z]+:/, '');
  if (it.qq && masterIds().has(bare(it.qq))) return true;
  // 代称虚拟条目（alias:p_master）没有 qq，按人物判
  const pid = String(it.pid || '');
  if (pid) { try { return pid === 'p_master'; } catch {} }
  return false;
}
function creditOf(it) {
  const c = it && it.review && it.review.credit;
  if (c === 'deny' || c === 'allow') return c;
  if (isMine(it)) return 'allow';     // 主人自己的署名：不问，默认公开
  return 'ask';
}
/* 新条目：pending（要主人确认）；老条目：legacy（点开才按需补证据）。 */
function fresh(o) {
  return {
    state: (o && o.legacy) ? LEGACY : PENDING,
    evidence: [],
    credit: 'ask',
    lockedBy: '', lockedAt: '',
  };
}
function ensure(it, o) {
  if (!it) return it;
  if (!it.review || typeof it.review !== 'object') it.review = fresh(o || { legacy: true });
  return it;
}
/* 硬闸门：locked 一律不许改/删。byAuthor 是 qq.js 的「本人改口」专用通道，
 * 那条路不是改内容，是删旧条 + 生成新条，也不走这里放行。 */
function guard(it) {
  if (isLocked(it)) return { ok: false, error: '这条你已经确认锁定了，不许改也不许删（除非原作者本人改口）' };
  return { ok: true };
}
function lock(it, by) {
  const r = ensure(it, { legacy: true }).review;
  r.state = LOCKED;
  r.evidence = [];                 // 5 条证据快照删掉；chat-log.jsonl 原始日志不动
  r.lockedBy = String(by || 'master');
  r.lockedAt = new Date().toISOString();
  return it;
}
function setCredit(it, c) {
  const r = ensure(it, { legacy: true }).review;
  if (c === 'deny' || c === 'allow' || c === 'ask') r.credit = c;
  return it;
}

/* ===== 5 条相关原记录（证据快照）=====
 * 优先按条目 src 里的 chat-log 行号锚定；老条目没有 src，按时间 + scope + 文本相似度找。
 * 只取**同一会话**（同一个群 / 都是私聊）里锚点前后邻近的行 —— 话题「不出群」在证据层也成立。
 * 返回最多 5 条，读不到就如实少给，不编、不跨群凑数。 */
function readChat() {
  let raw = '';
  try { raw = fs.readFileSync(CHAT, 'utf8'); } catch { return []; }
  const out = [];
  const arr = raw.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const line = arr[i];
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\](.*)$/);
    if (!m) continue;
    const scope = m[3];
    out.push({
      line: i + 1, t: m[1], scope,
      gid: (String(scope).match(/群\s*(\d+)/) || [])[1] || '',
      who: String(m[4] || '').trim(),
      text: String(m[5] || '').replace(/^\s*\]/, '').trim().slice(0, 200),
      raw: line.slice(0, 260),
    });
  }
  return out;
}
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u3000，。！？、；：~～…·,.!?;:'"“”‘’()（）【】\[\]「」『』/\\|<>《》\-—@\d]/g, '');
}
function inScope(row, scope) {
  const s = String(scope || '').trim();
  if (!s) return true;
  const gid = (s.match(/群\s*(\d+)/) || [])[1] || '';
  if (gid) return row.gid === gid;
  return /私聊|private/.test(row.scope) && /私聊|private/.test(s);
}
function anchorOf(rows, it) {
  const src = String((it && it.src) || '').match(/chat-log\.jsonl:\s*(\d+)/);
  if (src) {
    const i = rows.findIndex(r => r.line === Number(src[1]));
    if (i >= 0) return i;
  }
  const wantT = Date.parse((it && it.t) || '');
  const want = norm((it && it.text) || (it && it.say) || '');
  let bi = -1, best = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!inScope(r, it && it.scope)) continue;
    const dt = Math.abs(Date.parse(r.t) - wantT);
    const same = want && norm(r.text).indexOf(want.slice(0, 6)) >= 0;
    const score = (Number.isFinite(dt) ? dt : 8e15) - (same ? 6e9 : 0);
    if (score < best) { best = score; bi = i; }
  }
  return bi;
}
function evidenceFor(it, opt) {
  const rows = readChat().filter(r => inScope(r, it && it.scope));
  if (!rows.length) return [];
  const ai = anchorOf(rows, it);
  if (ai < 0) return [];
  const n = Number((opt || {}).n || 5);
  const half = Math.floor(n / 2);
  const from = Math.max(0, ai - half);
  return rows.slice(from, from + n).map(r => ({
    line: r.line, t: r.t, scope: r.scope, who: r.who, text: r.text,
  }));
}
/* 存到条目上（前端「查看原记录」按需调，不一次性给 409 条都算）。 */
function attachEvidence(it) {
  const r = ensure(it, { legacy: true }).review;
  r.evidence = evidenceFor(it);
  return it;
}

/* ===== 来源询问：运行时状态 + 临时代办（2026-11-13 主人定）=====
 * 口径（她原话）：
 *   · @询问只问 QQ 的，优先第一个号；
 *   · 询问完还要回去复命；
 *   · 等待 1 分钟无人应答 → 记「临时代办」，下次被作者触发会话时再问，问到后删代办（再复命一次）。
 * 所以状态必须落盘（重启不丢），存 data/ask-pending.json，一条一个记录：
 *   { id, at, entryIds, kind, authorPid, authorName, authorId, askerUid, askerNick, askerScope, state }
 *   state = 'asking'（已问、等着）/ 'temp'（超时未答，转代办）
 */
const ASK_PATH = path.join(__dirname, 'data', 'ask-pending.json');

function readAsks() {
  try { const a = JSON.parse(fs.readFileSync(ASK_PATH, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeAsks(list) {
  try { fs.writeFileSync(ASK_PATH, JSON.stringify((list || []).slice(-200)), 'utf8'); } catch (e) { console.log('[ask] 代办写不回：' + e.message); }
}
/* 开一条询问。authorId 传「作者的第一个 QQ 号」（她定的优先第一个号）。 */
function askOpen(o) {
  const r = {
    id: 'ask_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
    at: Date.now(),
    entryIds: (o.entryIds || []).slice(0, 12),
    kind: String(o.kind || 'teach'),
    authorPid: String(o.authorPid || ''),
    authorName: String(o.authorName || '').slice(0, 40),
    authorId: String(o.authorId || ''),
    askerUid: String(o.askerUid || ''),
    askerNick: String(o.askerNick || '').slice(0, 40),
    askerScope: String(o.askerScope || '').slice(0, 40),
    state: 'asking',
  };
  const list = readAsks(); list.push(r); writeAsks(list);
  return r;
}
/* 作者本人说话了：找一条等他的（先 asking，再 temp） */
function askForAuthor(uid) {
  const id = String(uid || '').replace(/^[a-z]+:/, '');
  if (!id) return null;
  const list = readAsks();
  return list.find(x => String(x.authorId) === id && x.state === 'asking')
    || list.find(x => String(x.authorId) === id && x.state === 'temp')
    || null;
}
function askClose(id) {
  const list = readAsks();
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return null;
  const r = list[i]; list.splice(i, 1); writeAsks(list);
  return r;
}
/* 转代办 / 主动标记：状态变了就落盘 */
function askState(id, st) {
  const list = readAsks();
  const r = list.find(x => x.id === id);
  if (!r) return null;
  r.state = st; writeAsks(list);
  return r;
}
/* 每轮顺手调：超 1 分钟没人应答 → asking 转 temp（不退化成「视为同意」，等下次再问） */
function askExpire(now) {
  const list = readAsks();
  const t = Number(now || Date.now());
  let n = 0;
  for (const r of list) {
    if (r.state === 'asking' && t - Number(r.at || 0) > ASK_TTL) { r.state = 'temp'; n++; }
  }
  if (n) writeAsks(list);
  return n;
}
/* 兼容老调用：按会话 k 记（面板/自测用），行为不变 */
const asks = new Map();
function ask(k, itemIds, author) {
  asks.set(String(k), { at: Date.now(), items: (itemIds || []).slice(0, 12), author: String(author || '') });
}
function pendingAsk(k) {
  const a = asks.get(String(k));
  if (!a) return null;
  if (Date.now() - a.at > ASK_TTL) { asks.delete(String(k)); return null; }
  return a;
}
function onAuthorReply(k, text) {
  const a = pendingAsk(k);
  if (!a) return null;
  asks.delete(String(k));
  return { ids: a.items, credit: isDenial(text) ? 'deny' : 'allow', author: a.author };
}
function expire(k, onDone) {
  const a = asks.get(String(k));
  if (a && Date.now() - a.at > ASK_TTL) {
    asks.delete(String(k));
    if (onDone) onDone({ ids: a.items, credit: 'allow', author: a.author });
  }
}

/* 虚幻自己的风格：被问来源时 @ 作者那一句。不带 id、不带知识点内容。 */
function askLine(nick) {
  const n = String(nick || '').trim() || '你';
  const lines = [
    '诶，有人问我这茬是跟谁学的～' + n + '，能说是你教的不？不想让我说就吱一声，我就装不知道啦',
    '唔，被追问出处了！' + n + '，这句可以报你名字嘛？不乐意我就不说，反正我会装傻✌',
    '有人刨根问底问我是从哪学来的……' + n + '，我要不要把你供出来呀？不想被认领就说一声哦',
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

/* 复命（2026-11-13 主人定「询问完还要回去复命」）：
 * 问完必须回去跟提问的人说一句结果。同意才报名字，拒绝就说不能说——两种都不带对方的 id。 */
function reportLine(name, credit) {
  if (credit === 'deny') {
    return ['问过啦～人家说不想被认领，那我就装不知道咯✌', '我去问过了，人家不肯露名～那就不说啦'][Math.floor(Math.random() * 2)];
  }
  const n = String(name || '').trim() || '那个人';
  return ['问过啦，人家说可以的～是「' + n + '」教我的哦', '回你了：可以讲，是「' + n + '」教的'][Math.floor(Math.random() * 2)];
}
/* 临时代办到期：作者一说话就补问一句（问完删代办） */
function reaskLine(name) {
  const n = String(name || '').trim() || '你';
  return '对了' + n + '，之前有人问我那茬是哪学的～能报你名字嘛？不能就算了，我就不说啦';
}

module.exports = {
  PENDING, LEGACY, LOCKED, ASK_TTL,
  SOURCE_RE, DENY_RE, REVISE_RE,
  isSourceQuestion, isDenial, isRevision,
  stateOf, isLocked, creditOf, isMine, fresh, ensure, guard, lock, setCredit,
  readChat, inScope, evidenceFor, attachEvidence,
  ask, pendingAsk, onAuthorReply, expire, askLine,
  askOpen, askForAuthor, askClose, askState, askExpire, reportLine, reaskLine, readAsks,
};
