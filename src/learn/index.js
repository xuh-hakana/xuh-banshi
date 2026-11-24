/*
 * src/learn/index.js —— 学习系统唯一入口
 *
 * 这是干什么的：外面（core.js / 客户端 / 定时器）只认这一个文件，不直接碰
 * favor.js / style.js / kb.js / acts.js。这样以后加东西，调用点不用改。
 *
 * 三层在这里落地：
 *   hot(ctx)        每轮注入：每人风格三份（最高优先） + 好感摘要
 *   warm(ctx, q)    命中才检索：这个人自己的知识库，最多 3 条
 *   act(...)        冷层：这一轮说了什么话题、给谁、依据是什么
 *
 * 开关：config/features.json → learn.*
 * 关掉 enabled 就完全回到没有学习系统的状态，一行代码不用改。
 */
const cfg = require('../config');
const people = require('../people');
const favor = require('./favor');
const style = require('./style');
const kb = require('./kb');
const acts = require('./acts');
const bridge = require('./bridge');
const astrbot = require('./astrbot');       // AstrBot 学到的心情 / 表达 / 风格（2026-11-22）
const mood = require('./mood');             // 心情 → 语气 的映射，不存状态
const store = require('./store');
const S = require('./schema');

function conf() {
  const c = (cfg.cfgLive() || {}).learn || {};
  return {
    enabled: c.enabled !== false,
    decay: c.decay !== false,
    hotChars: Number(c.hotChars) > 0 ? Number(c.hotChars) : S.LIMITS.hotChars,
    styleHotChars: Number(c.styleHotChars) > 0 ? Number(c.styleHotChars) : S.LIMITS.styleHotChars,
    warm: c.warm !== false,
    acts: c.acts !== false,
    dsh: c.dsh !== false,
    dshChars: Number(c.dshChars) > 0 ? Number(c.dshChars) : 700,
    astrbot: c.astrbot !== false,
    astrbotChars: Number(c.astrbotChars) > 0 ? Number(c.astrbotChars) : 400,
    mood: c.mood !== false,
    moodChars: Number(c.moodChars) > 0 ? Number(c.moodChars) : 200,
  };
}

// 这一轮说话人对应的人物 id（platform + id → pid）。取不到就返回 null，不硬造人。
function pidOfCtx(ctx) {
  if (!ctx || !ctx.uid) return null;
  const plat = ctx.source === 'bili' ? 'bili' : 'qq';
  try { return people.findByAccount(plat, String(ctx.uid)) || null; }
  catch (e) { return null; }
}

// 按行截断：宁可少给一行，也不要在句子中间砍断
function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const out = [];
  let len = 0;
  for (const line of s.split('\n')) {
    if (len + line.length + 1 > max) break;
    out.push(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

/* ---------- 热层：每轮注入 ---------- */
/* 顺序写死：每人风格三份 ＞ DSH 风格档案 ＞ 好感摘要。
 * 风格块单独算预算（styleHotChars），不会因为好感那段长了就被挤掉——
 * 她 2026-11-09 明确「每轮强制注入，优先级高于普通记忆」。
 * DSH 那块来自桌面 harness 里两个风格插件学到的档案，是「虚幻自己怎么写」，
 * 比「对某人的好感」更基础，所以排在好感前面、每人风格后面。 */
function hot(ctx) {
  const c = conf();
  if (!c.enabled) return '';
  const pid = pidOfCtx(ctx);
  const groupId = ctx && ctx.groupId !== undefined && ctx.groupId !== null ? String(ctx.groupId) : '';
  const blocks = [];
  if (pid) {
    try {
      const s = style.block(pid, ctx.nick, c.styleHotChars);
      if (s) blocks.push(s);
    } catch (e) { /* 热层失败绝不能拖垮这一轮回复 */ }
  }
  if (c.dsh) {
    try {
      const d = bridge.text(c.dshChars);
      if (d) blocks.push(d);
    } catch (e) { /* 同上 */ }
  }
  // 心情：只在她自己有心情数据时才出现，不编（astrbot.js 里 48 小时过期也算没有）
  if (c.mood) {
    try {
      astrbot.kick();                       // 第一次没数据就踢后台刷一次，不阻塞这一轮
      const mb = mood.block(astrbot.moodFor(groupId), c.moodChars);
      if (mb) blocks.push(mb);
    } catch (e) { /* 同上 */ }
  }
  // 这个群的人平时怎么接话：口气参考，不是标准答案
  if (c.astrbot) {
    try {
      const ab = astrbotBlock(groupId, c.astrbotChars);
      if (ab) blocks.push(ab);
    } catch (e) { /* 同上 */ }
  }
  if (pid) {
    try {
      const f = favor.hotBlock(pid, ctx.nick);
      if (f) blocks.push(f);
    } catch (e) { /* 同上 */ }
  }
  if (!blocks.length) return '';
  const budget = c.hotChars + c.styleHotChars + (c.dsh ? c.dshChars : 0)
    + (c.mood ? c.moodChars : 0) + (c.astrbot ? c.astrbotChars : 0);
  return clip(blocks.join('\n\n'), budget);
}

/* AstrBot 表达样本 + 已通过审查的规矩，合成一小块（每群各自一份）。 */
function astrbotBlock(groupId, max) {
  const lines = [];
  const ex = astrbot.exprFor(groupId, 5);
  if (ex.length) {
    lines.push('## 这个群的人平时这么说（口气参考，不是答案）');
    ex.forEach(x => lines.push('「' + x.situation + '」→「' + x.expression + '」'));
  }
  const st = astrbot.styleFor(groupId, 3);
  if (st.length) {
    lines.push('## 学到的接话规矩（学规矩，不照抄）');
    st.forEach(x => lines.push('· ' + x));
  }
  return lines.length ? clip(lines.join('\n'), max) : '';
}

/* ---------- 温层：命中才检索 ---------- */
async function warm(ctx, q) {
  const c = conf();
  if (!c.enabled || !c.warm) return '';
  const pid = pidOfCtx(ctx);
  if (!pid) return '';
  try { return await kb.warmBlock(pid, q, ctx.nick); } catch (e) { return ''; }
}

/* ---------- 冷层：记这一轮输出 ---------- */
function act(ctxOrPid, a) {
  const c = conf();
  if (!c.enabled || !c.acts) return { skipped: true };
  try {
    if (ctxOrPid && typeof ctxOrPid === 'object') {
      const pid = pidOfCtx(ctxOrPid);
      return acts.record(Object.assign({ pid, nick: ctxOrPid.nick, groupId: ctxOrPid.groupId,
        where: ctxOrPid.groupId ? 'group' : 'private' }, a));
    }
    return acts.record(Object.assign({ pid: ctxOrPid }, a));
  } catch (e) { return { error: e.message }; }
}

/* ---------- 定时：衰减结算 + 刷新 DSH 风格档案 ---------- */
function tick() {
  const c = conf();
  if (!c.enabled) return [];
  // 风格档案由桌面 harness 那边的插件写，跟衰减无关，所以放在 decay 检查之前
  if (c.dsh) { try { bridge.refresh().catch(() => {}); } catch (e) { /* 读不到就算了 */ } }
  if (c.astrbot || c.mood) { try { astrbot.refresh().catch(() => {}); } catch (e) { /* 同上 */ } }
  if (!c.decay) return [];
  try { return favor.tick(); } catch (e) { return []; }
}

/* ---------- 写入 ---------- */
// 手动改到某个分数（客户端用）：差额记成一条 manual 事件，不直接改分数
function setFavor(pid, value, why) {
  const now = people.getFavor(pid);
  const v = Math.round(Number(value));
  if (!people.get(pid)) return { error: '没有这个人：' + pid };
  if (!isFinite(v)) return { error: '分数不是数字' };
  if (v === now) return { ok: true, unchanged: true };
  return favor.record(pid, v - now, { trigger: 'manual', reason: why || '客户端手改', by: 'master' });
}

function revoke(pid, id, why) { return favor.revoke(pid, id, why, 'master'); }

/* ---------- 客户端读 ---------- */
function accountsOf(pid) {
  try { return (people.accountsOf(pid) || []).map(a => (a.platform || 'qq') + ':' + (a.id || '')); }
  catch (e) { return []; }
}

function view() {
  const c = conf();
  const users = [];
  for (const pid of store.listUserIds()) {
    let p = null;
    try { p = people.get(pid); } catch (e) { p = null; }
    if (!p) continue;
    const score = people.getFavor(pid);
    const events = favor.recent(pid, S.LIMITS.recentEvents);
    const st = style.read(pid);
    const styled = style.KEYS.some(k => st[k]);
    const kbc = kb.counts(pid);
    if (!score && !events.length && !styled && !kbc.total) continue;   // 什么都没有的人不占屏
    users.push({
      pid,
      name: p.name || '',
      accounts: accountsOf(pid),
      favor: score,
      level: S.level(score),
      decay: favor.state(pid),
      events,
      style: { has: styled, chars: style.KEYS.reduce((n, k) => n + st[k].length, 0) },
      kb: kbc,
    });
  }
  users.sort((a, b) => (b.favor - a.favor) || (b.kb.total - a.kb.total));
  return {
    enabled: c.enabled, decay: c.decay, warm: c.warm, acts: c.acts,
    hotChars: c.hotChars, styleHotChars: c.styleHotChars,
    dsh: c.dsh, dshChars: c.dshChars,
    astrbot: c.astrbot, astrbotChars: c.astrbotChars,
    mood: c.mood, moodChars: c.moodChars,
    dshState: (() => { try { return bridge.state(); } catch (e) { return { err: e.message }; } })(),
    astrbotState: (() => { try { return astrbot.state(); } catch (e) { return { err: e.message }; } })(),
    users, actsTotal: acts.counts().total, emb: require('./search').conf(),
    root: S.PATHS.root,
  };
}

/* 客户端编辑每人三份 */
function styleGet(pid) {
  const r = style.read(pid);
  const raw = {};
  style.KEYS.forEach(k => { try { raw[k] = require('fs').readFileSync(style.pathOf(pid, k), 'utf8'); } catch (e) { raw[k] = ''; } });
  return { pid: String(pid), clean: r, raw };
}
function styleSet(pid, key, text) { return style.write(pid, key, text, 'master'); }

/* 客户端读/写知识库 */
function kbList(pid) { return { pid: String(pid), counts: kb.counts(pid), items: kb.all(pid) }; }
function kbAdd(pid, item) { return kb.add(pid, Object.assign({}, item, { evidence: { ref: '客户端手记', quote: '' } })); }
function kbDel(pid, id) { return kb.del(pid, id); }
function kbExport(pid) { return kb.exportJSON(pid); }

/* 客户端看冷层 */
async function actsList(opt) { return acts.query(opt || {}); }
function actsTopics(opt) { return acts.topics(opt || {}); }

module.exports = {
  hot, warm, act, tick, setFavor, revoke, view, pidOfCtx, conf,
  styleGet, styleSet, kbList, kbAdd, kbDel, kbExport, actsList, actsTopics,
  bridge,
  S, favor, style, kb, acts, store,
};
