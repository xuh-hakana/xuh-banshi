'use strict';
/* ===========================================================================
 * alarms.js —— 虚幻给自己定的闹钟（主人 2026-11-24 令）
 *
 * 她原话：「给虚幻一个给自己定时的闹钟功能，以后有ai承诺，就给自己加闹钟，
 *   上限6个月，太久的任务不定，放到面板的提醒里，说明是哪个群/人/平台的内容/时间。
 *   过时的也归类，完成/失败」
 *
 * 触发 → 结果 → 落点：
 *   ① 她发出的话过了承诺闸门 → 异步调一次模型抽「是不是承诺/内容/时间」→ 存一条 pending
 *   ② 到期 → 用她的人设当场生成一句兑现话 → 发回原群/原人 → 发出=done，发不出=failed
 *   ③ 到期超过 maxDays(默认180天=6个月) → too_far，记下来但不设定时
 *   ④ 没给时间（「回头查到了再说」）→ 兜底 fallbackHours（默认24h），note 写明是兜底
 *   ⑤ 到期后 overdueHours 还没发出去 → failed（过时归失败）
 *
 * 数据只有一份：src/data/alarms.json（数组，原子写，重启不丢）。面板 /api/alarms 直接读它，
 * 不另存第二套。配置在 config/features.json 的 alarms 段（面板可改，cfgLive 热读）。
 *
 * 不连 QQ：note() 只接「她发出去的原文 + 来源」，判定结果写盘；到点发送走 qq.js 注入的
 * send(scope, text) / ready()，生成兑现句走 core（人设同一套），本文件不 require connectors。
 *
 * 判定省额度：先过候选词闸门（gate），像承诺才烧一次模型；「主人真贴心」这类客套直接排除。
 * 模型调用 preferFallback + noThink：用便宜的备用模型，不占她的「想给我看」思考额度。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const configStore = require('./config');
const core = require('./core');

let DATA = path.join(__dirname, 'data', 'alarms.json');
const DAY = 24 * 60 * 60 * 1000;

let _send = null;     // qq.js 注入：(scope, text) => Promise<boolean>；scope 里带群/人/平台
let _ready = null;    // qq.js 注入：() => QQ 是否连着；断线不标记已发，下一跳补
let _timer = null;
let _busy = false;    // 一跳还在生成/发送时，轮询不许再起一跳
const DEFAULT = {
  enabled: true,
  maxDays: 180,
  fallbackHours: 24,
  tickSec: 30,
  overdueHours: 48,
  maxKeep: 500,
  gateWords: [],
};

/* ---------- 小工具 ---------- */
function conf() {
  let a = {};
  try { a = (configStore.cfgLive ? configStore.cfgLive() : configStore.load()).alarms || {}; } catch (e) { a = {}; }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: a.enabled !== false,
    maxDays: num(a.maxDays, DEFAULT.maxDays),
    fallbackHours: num(a.fallbackHours, DEFAULT.fallbackHours),
    tickSec: num(a.tickSec, DEFAULT.tickSec),
    overdueHours: num(a.overdueHours, DEFAULT.overdueHours),
    maxKeep: num(a.maxKeep, DEFAULT.maxKeep),
    gateWords: Array.isArray(a.gateWords) ? a.gateWords.filter(x => typeof x === 'string' && x.trim()) : [],
  };
}
function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
function writeAll(list) {
  try {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const tmp = DATA + '.tmp';
    if (path.resolve(DATA) === path.resolve(require('./state/entities').F.alarms)) {
      require('./state/entities').ent().alarms.replace(list);
    } else {
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, DATA);
    }
    return true;
  } catch (e) { console.error('[闹钟] 写不进：' + e.message); return false; }
}
function newId() { return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36); }
function S(v) { return String(v == null ? '' : v).trim(); }

/* 候选词闸门：命中才烧模型。默认词表 + 面板可加。
 * 校准样本（主人 2026-11-24 给的三条）：
 *   「回头查到了再跟你说」→ 命中「回头」「再跟你说」→ 判为承诺（无时间 → 兜底）
 *   「主人真贴心」→ 不命中 → 不判，零消耗
 *   「等16分钟…到时候提醒你们」→ 命中「等到…分钟/到时候/提醒」→ 判为承诺（16分钟） */
const GATE_DEFAULT = ['回头', '等一下', '等会儿', '待会', '一会儿', '等', '明天', '后天', '下周',
  '下个月', '改天', '下次', '到时候', '提醒', '帮你', '给你', '跟你说', '发给你', '查到', '弄好',
  '做好', '写完', '包在我', '答应', '再联系', '再找你', '陪你', '一起等', '分钟后', '小时后'];
function gateHit(text, extra) {
  const t = S(text);
  if (!t) return '';
  const words = GATE_DEFAULT.concat(extra || []);
  for (const w of words) if (w && t.indexOf(w) >= 0) return w;
  return '';
}

/* ---------- 承诺判定（一次小模型调用） ----------
 * 输出严格 JSON；用 preferFallback + noThink 省额度、不占思考开关。
 * 失败一律当「不是承诺」——宁可漏，不可把客套话记成闹钟。 */
const SYS = [
  '你是一个判断器。判断这句话是不是「她」（一个 QQ 陪伴机器人）对别人做出的明确承诺——',
  '即她答应将来自己做某件事，或答应到了某个时间提醒/联系某人。',
  '只输出一个 JSON 对象，不要任何别的话、不要代码块：',
  '{"promise":true,"content":"她答应做什么（20字内）","dueMinutes":数字或null,"dueISO":"带+08:00的时刻或null"}',
  '规则：',
  '1. 客套、撒娇、夸奖、纯情绪（如「嘻嘻，主人真贴心！」）不算承诺，promise=false。',
  '2. 只是说别人要做的事（「你要记得活动身体哦」）不算她自己的承诺；但她说了「我提醒你/我陪你一起等」算。',
  '3. dueMinutes=从现在起多少分钟后（「等16分钟」→16；「明天这个点」→按24小时推；「下周三」→按天推到分钟）。',
  '4. dueISO=原话给了绝对时间时填带 +08:00 的 ISO 串（如「12月5日下午3点」）。两者都不确定就都填 null。',
  '5. 没给任何时间（如「回头查到了再跟你说」）→ dueMinutes 和 dueISO 都填 null，不要猜。',
  '6. content 写她答应的那件事本身，不要写「她承诺了」，不要加引号。',
].join('\n');

function pickJson(s) {
  const t = S(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

async function judge(text) {
  const messages = [
    { role: 'system', content: SYS },
    { role: 'user', content: '这句话：' + S(text).slice(0, 600) },
  ];
  const raw = await core.callLLM(messages, { tag: 'alarms', noThink: true, preferFallback: true });
  const j = pickJson(raw);
  if (!j || j.promise !== true) return null;
  const content = S(j.content).slice(0, 60);
  if (!content) return null;
  let dueAt = 0, dueRaw = '';
  const iso = S(j.dueISO);
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) { dueAt = ms; dueRaw = iso; }
  }
  if (!dueAt) {
    const min = Number(j.dueMinutes);
    if (Number.isFinite(min) && min > 0) {
      dueAt = Date.now() + Math.round(min * 60 * 1000);
      dueRaw = Math.round(min) + '分钟后';
    }
  }
  return { content, dueAt, dueRaw };  // dueAt=0 表示没给时间 → 兜底
}

/* ---------- 对外：记一条承诺 ----------
 * meta = { platform:'qq', scope:'群858455686'|'私聊', groupId, userId, who, at }
 * 异步、不阻塞发送；任何异常都吞掉，绝不影响她回话。 */
function note(text, meta) {
  const c = conf();
  if (!c.enabled) return;
  const hit = gateHit(text, c.gateWords);
  if (!hit) return;
  const m = meta || {};
  const said = S(text).slice(0, 800);
  const who = S(m.who);
  // 去重：同一句 + 同一人 + 60 秒内只记一次（回执重发/复读不重复建闹钟）
  const key = said + '|' + who + '|' + S(m.scope);
  const now = Date.now();
  const recent = readAll().some(x => x.key === key && now - x.createdAt < 60000);
  if (recent) return;

  judge(said).then(r => {
    if (!r) return;
    const list = readAll();
    const cc = conf();
    let dueAt = r.dueAt, fallback = false, noteText = '';
    if (!dueAt) {
      dueAt = now + cc.fallbackHours * 60 * 60 * 1000;
      fallback = true;
      noteText = '原话没给时间，按兜底 ' + cc.fallbackHours + ' 小时设定';
    }
    const tooFar = (dueAt - now) > cc.maxDays * DAY;
    const row = {
      id: newId(), key,
      createdAt: now,
      t: new Date(now).toISOString(),
      platform: S(m.platform || 'qq'),
      scope: S(m.scope), groupId: Number(m.groupId) || 0,
      userId: Number(m.userId) || 0, who,
      text: said, content: r.content,
      dueAt, dueRaw: r.dueRaw || noteText || '兜底',
      fallback, tooFar,
      status: tooFar ? 'too_far' : 'pending',
      statusAt: now, note: noteText,
    };
    list.push(row);
    // 只留最近 maxKeep 条（太久的归档无意义，面板也翻不动）
    const keep = list.slice(-cc.maxKeep);
    writeAll(keep);
    console.log('[闹钟] 记一条' + (tooFar ? '（超过' + cc.maxDays + '天，不定）' : '') + '：' + row.content + ' ← ' + (who || S(m.scope)));
  }).catch(e => { console.log('[闹钟] 判定没成，这次不记：' + (e && e.message || e)); });
}

/* ---------- 到点兑现 ---------- */
async function sayDue(row) {
  // 用她的人设当场说一句，不套模板；不占「想给我看」的思考额度。
  const cue = '（你之前答应过「' + row.content + '」，现在到时间了，说一句兑现/回应，别提闹钟、提醒、系统）';
  const msgs = await core.buildMessages('alarm:' + row.id, cue, '这是你自己许下的承诺，到点了。用你平时的语气说一句，最多两句，短一点。不要复述括号里的提示语。');
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: cue });
  let line = S(core.polish(await core.callLLM(msgs, { tag: 'alarms', noThink: true }), 'alarm:' + row.id));
  if (!line || /到点了|之前答应|闹钟|提醒|系统/.test(line) || /^\{/.test(line) || /"promise"/.test(line) || line.length > 120) {
    line = row.content + '，弄好了哦。';   // 兜底：宁短也不发念提示的话/判定 JSON
  }
  return line;
}

function setStatus(id, status, note) {
  const list = readAll();
  let changed = false;
  for (const x of list) if (x.id === id) {
    x.status = status; x.statusAt = Date.now();
    if (note) x.note = S(note).slice(0, 200);
    changed = true;
  }
  if (changed) writeAll(list);
  return changed;
}

async function tick() {
  const c = conf();
  if (!c.enabled || !_send || !_ready) return;
  if (!_ready()) return;               // QQ 没连上：一条都不标，等下一跳
  if (_busy) return;
  const now = Date.now();
  const due = readAll().filter(x => x.status === 'pending' && !x.tooFar && x.dueAt <= now);
  if (!due.length) return;
  _busy = true;
  try {
    for (const row of due.slice(0, 5)) {   // 一跳最多发 5 条，免得攒多了刷屏
      if (now - row.dueAt > c.overdueHours * 60 * 60 * 1000) {
        setStatus(row.id, 'failed', '超过 ' + c.overdueHours + ' 小时没发出去，过时归失败');
        continue;
      }
      try {
        const line = await sayDue(row);
        const ok = await _send({ platform: row.platform, scope: row.scope, groupId: row.groupId, userId: row.userId, who: row.who }, line);
        setStatus(row.id, ok ? 'done' : 'failed', ok ? '' : '发送没成功');
        console.log('[闹钟] 到点 ' + (ok ? '发出' : '没发出') + '：' + row.content + ' → ' + row.scope);
      } catch (e) {
        setStatus(row.id, 'failed', '发送出错：' + (e && e.message || e));
      }
    }
  } finally { _busy = false; }
}

function start(opts) {
  const o = opts || {};
  _send = typeof o.send === 'function' ? o.send : null;
  _ready = typeof o.ready === 'function' ? o.ready : null;
  if (_timer) clearInterval(_timer);
  const sec = conf().tickSec;
  _timer = setInterval(() => { tick().catch(e => console.error('[闹钟] tick 出错：' + e.message)); }, sec * 1000);
  setTimeout(() => { tick().catch(() => {}); }, 30 * 1000);   // 开机 30 秒补一次
}

/* ---------- 面板用（只读 + 显式改动） ---------- */
function all() { return readAll().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
function grouped() {
  const out = { pending: [], done: [], failed: [], too_far: [] };
  for (const x of all()) (out[x.status] || out.failed).push(x);
  return out;
}
function manualAdd(rec) {
  const r = rec || {};
  const list = readAll();
  const cc = conf();
  const now = Date.now();
  const dueAt = Number(r.dueAt) || now + cc.fallbackHours * 60 * 60 * 1000;
  const row = {
    id: newId(), key: 'manual|' + now,
    createdAt: now, t: new Date(now).toISOString(),
    platform: S(r.platform || 'qq'), scope: S(r.scope || '手动记的'),
    groupId: Number(r.groupId) || 0, userId: Number(r.userId) || 0, who: S(r.who),
    text: S(r.text || r.content), content: S(r.content || r.text).slice(0, 60) || '没写内容',
    dueAt, dueRaw: S(r.dueRaw || '手动设定'), fallback: false,
    tooFar: (dueAt - now) > cc.maxDays * DAY, status: 'pending', statusAt: now, note: '面板手动加的',
  };
  if (row.tooFar) row.status = 'too_far';
  list.push(row); writeAll(list.slice(-cc.maxKeep));
  return row;
}
function manualStatus(id, status, note) {
  if (['pending', 'done', 'failed', 'too_far'].indexOf(status) < 0) return false;
  return setStatus(S(id), status, note);
}
function remove(id) {
  const list = readAll();
  const next = list.filter(x => x.id !== S(id));
  if (next.length === list.length) return false;
  return writeAll(next);
}

module.exports = {
  start, note, tick, all, grouped, manualAdd, manualStatus, remove,
  conf, _gateHit: gateHit, _judge: judge, _pickJson: pickJson,
  _setIo: (send, ready) => { _send = send; _ready = ready; },
  // 自测用：不碰真实数据文件
  _withData: (file) => { /* 测试里改 DATA 指向临时文件 */ DATA = file; },
};
