/* ===========================================================================
 * diary-flow.js — 一天一篇日记的完整流程（2026-11-18 主人令）
 *
 * 她的原话（逐字）：
 *   「一天只需要一篇完整的。等群里出现晚安/我直接私信发给虚幻今天结束等表示一天结束时/
 *     时间确实到了8:00时。时间限制是作为1天的兜底。如果22:00时且群里长时间静默，
 *     虚幻自己要来询问我是否结束今天并写日记。我可以发「重写」驳回写的差的。
 *     我认为可以就发「发」。然后此通过的日记同步发QQ空间、b站动态。」
 *
 * 流程（states）：
 *   idle ──群里出现晚安 / 她私信说结束 / 08:00 兜底──▶ drafting
 *   drafting ──生成成功──▶ drafted（私信给她看，等她一句话）
 *   drafted ──她回「发」──▶ 落盘 + 发 QQ空间、B站 ──▶ published
 *   drafted ──她回「重写」──▶ drafting（最多 maxRetry 次，超过就停下来告诉她）
 *   08:00 兜底那篇：她的答复是「兜底那篇自动发」→ 生成完直接落盘 + 发平台，不等她。
 *
 * 22:00 提醒：到点、群静默够久、今天还没写过也没问过 → 她自己来问「今天结束了吗」。
 *
 * 边界不是自然日零点，是 cursor：
 *   她定「发完日记后的新记录，全是下一天要用的记录」→ 写完推进 cursor，之后归下一天。
 *
 * 状态：data/diary-state.json（重启不丢，草稿正文也在里面）
 * 规则：data/diary-rules.json 的 trigger 段（客户端可改）
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(__dirname, 'data', 'diary-state.json');
const CHATLOG = path.join(__dirname, 'data', 'chat-log.jsonl');

const core = require('./core');
const publish = require('./diary-publish');

const EMPTY = {
  cursor: 0,          // 已经写进日记的聊天记录行数
  phase: 'idle',      // idle | drafting | drafted | published
  draftId: '',
  day: '',
  title: '',
  text: '',
  qzoneText: '',
  retry: 0,
  askedDay: '',       // 22:00 提醒过哪一天（同一天只问一次）
  autoPass: false,    // 这篇是 08:00 兜底、直接发
  published: null,
  at: 0,
  why: '',            // 这次为什么写（群晚安 / 主人说结束 / 08:00 兜底）
};

function loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE, 'utf8') || '{}');
    return Object.assign({}, EMPTY, o);
  } catch { return Object.assign({}, EMPTY); }
}
function saveState(o) {
  const dir = path.dirname(STATE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, EMPTY, o), null, 1), 'utf8');
  fs.renameSync(tmp, STATE);
}
function loadTrigger() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'diary-rules.json'), 'utf8'));
    return j.trigger || {};
  } catch { return {}; }
}
/* 「22:00」→ 1320（分钟） */
function hmToMin(s, dflt) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return dflt;
  return Number(m[1]) * 60 + Number(m[2]);
}
function todayLocal(nowArg) {
  const d = nowArg ? new Date(nowArg) : new Date();
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
}
/* 群里最后一次说话距今多久（分钟）。用 chat-log 的 mtime —— 最后一条写进去就是这个时间。 */
function silentMinutes(nowArg) {
  try {
    const st = fs.statSync(CHATLOG);
    const now = nowArg ? Number(nowArg) : Date.now();
    return Math.max(0, Math.floor((now - st.mtimeMs) / 60000));
  } catch { return 0; }
}
function log(msg) { console.log('[diary-flow] ' + msg); }
function tellMaster(msg) {
  try { core.master(msg); } catch (e) { log('私信发不出去：' + e.message); }
}

/* 首次启用：游标从「现在这一条」开始，不追历史。
 * 为什么：chat-log 有几千条，一开就把它们当一篇重新写＝十几片、几分钟、一堆额度，
 * 而且那是旧账不是今天的事。要补哪一天在面板点「现在写」。
 * 返回 true 表示这次做了初始化。 */
function ensureInit() {
  if (fs.existsSync(STATE)) return false;
  const total = core.chatLogLineCount();
  saveState({ cursor: total, phase: 'idle' });
  log('首次启用：游标从当前第 ' + total + ' 条开始算，不追历史');
  return true;
}

/* ── 生成一篇（不落盘）──────────────────────────────────────────────
 * opts.autoPass = true  → 08:00 兜底，生成成功就直接发平台（她定「兜底那篇自动发」）
 * 返回 { ok, reason, day, title, text }
 */
async function draft(why, optsArg) {
  const o = optsArg || {};
  const st = loadState();
  if (st.phase === 'drafting') { log('已经在写了，跳过这次触发'); return { ok: false, reason: 'busy' }; }

  const total = core.chatLogLineCount();
  if (total <= st.cursor) {
    log('从上次写完到现在没有新记录（' + st.cursor + '/' + total + '），不写');
    return { ok: false, reason: 'no-new' };
  }

  st.phase = 'drafting';
  st.why = String(why || '');
  st.autoPass = !!o.autoPass;
  st.retry = o.retry ? st.retry : 0;
  saveState(st);

  log('开始写：' + (why || '?') + '，从第 ' + st.cursor + ' 条之后取，共 ' + (total - st.cursor) + ' 条新记录');
  let r;
  try {
    r = await core.doDiary('', { auto: true, sinceCount: st.cursor, dryRun: true });
  } catch (e) {
    const s2 = loadState();
    s2.phase = 'idle';
    saveState(s2);
    log('生成失败：' + e.message);
    return { ok: false, reason: 'error', error: e.message };
  }

  const st2 = loadState();
  if (!r || !r.ok) {
    st2.phase = 'idle';
    saveState(st2);
    log('这次没写成：' + ((r && r.reason) || '未知') + (r && r.issues ? '｜' + r.issues.join('；') : ''));
    return { ok: false, reason: (r && r.reason) || 'unknown', issues: (r && r.issues) || [] };
  }

  // 空间和B站都直接发日记全文。
  // 2026-11-18 主人查到的口径：「空间动态最多1万到20万字」→ 500 字的日记原文完全放得下，
  // 不需要先压成短说说（那一版会多花一次模型调用，已删）。
  st2.phase = 'drafted';
  st2.day = r.day || todayLocal();
  st2.title = r.title || '';
  st2.text = r.text || '';
  st2.qzoneText = '';
  st2.draftId = Date.now().toString(36);
  st2.at = Date.now();
  saveState(st2);

  // 兜底那篇直接发；其余等她一句话
  if (o.autoPass) {
    log('兜底篇写完，按她的规矩直接发平台');
    return await approve('auto');
  }

  tellMaster('日记写好了（' + st2.day + (st2.title ? ' · ' + st2.title : '') + '），你看行不行：\n\n'
    + st2.text
    + '\n\n回「发」我就发到 QQ空间 和 B站动态；回「重写」我把这篇废掉重写。');
  return { ok: true, day: st2.day, title: st2.title, text: st2.text };
}

/* ── 通过：落盘 + 发两个平台 ──────────────────────────────────────── */
async function approve(from) {
  const st = loadState();
  if (st.phase !== 'drafted' || !st.text) {
    log('没有等她点头的草稿，忽略「发」');
    return { ok: false, reason: 'no-draft' };
  }
  const T = loadTrigger();

  const file = core.saveDiaryFile(st.day, st.title, st.text, {});
  log('落盘：' + file.file);

  const pub = { qzone: null, bili: null };
  // 两个平台都发日记全文：空间上限 1 万~20 万字（她 2026-11-18 查的口径），B站动态能放图文长文。
  if (T.publishQzone !== false) {
    try { pub.qzone = await publish.postQzone(st.text); }
    catch (e) { pub.qzone = { ok: false, error: e.message }; }
  }
  if (T.publishBili !== false) {
    try { pub.bili = await publish.postBili(st.text); }
    catch (e) { pub.bili = { ok: false, error: e.message }; }
  }

  const st2 = loadState();
  st2.phase = 'published';
  st2.published = pub;
  st2.cursor = core.chatLogLineCount();     // 写完推进游标：之后的新记录归下一天
  st2.retry = 0;
  saveState(st2);

  const q = pub.qzone ? (pub.qzone.ok ? '空间发了' : '空间没发出去（' + pub.qzone.error + '）') : '空间没开';
  const b = pub.bili ? (pub.bili.ok ? 'B站动态发了' : 'B站没发出去（' + pub.bili.error + '）') : 'B站没开';
  log((from === 'auto' ? '兜底篇' : '') + '已落盘：' + q + '｜' + b);
  if (from !== 'auto') tellMaster('记下了。' + q + '｜' + b);
  return { ok: true, day: st2.day, qzone: pub.qzone, bili: pub.bili };
}

/* ── 驳回重写 ─────────────────────────────────────────────────────── */
async function rewrite() {
  const st = loadState();
  if (st.phase !== 'drafted' || !st.text) {
    log('没有等她点头的草稿，忽略「重写」');
    return { ok: false, reason: 'no-draft' };
  }
  const T = loadTrigger();
  const max = Number(T.maxRetry) || 3;
  if (st.retry >= max) {
    log('已经重写 ' + st.retry + ' 次，到上限了，停下来等她说话');
    tellMaster('这篇已经重写 ' + st.retry + ' 次了，再写我怕越写越偏。'
      + '你可以直接告诉我该写哪件事，或者回「发」先发出去。');
    return { ok: false, reason: 'max-retry' };
  }
  st.retry += 1;
  st.phase = 'idle';
  st.text = '';          // 废掉这一篇，不留在状态里
  st.title = '';
  st.qzoneText = '';
  saveState(st);
  log('她驳回，重写第 ' + st.retry + ' 次');
  return await draft(st.why || '重写', { retry: true });
}

/* ── 触发：群里的消息 ─────────────────────────────────────────────── */
function hitsAny(text, words) {
  const t = String(text || '');
  if (!t) return '';
  for (const w of (words || [])) {
    const s = String(w || '').trim();
    if (s && t.indexOf(s) >= 0) return s;
  }
  return '';
}

/* 群里任何一条消息都可能触发。她定「任何群都算」。 */
function onGroupText(gid, text) {
  const T = loadTrigger();
  const st = loadState();
  if (st.phase === 'drafting') return null;
  if (st.phase === 'drafted') return null;                 // 上一篇还在等她看，不叠
  const now = new Date();
  // 今天已经发过了就别再写（「一天只需要一篇完整的」）
  if (st.phase === 'published' && st.day === todayLocal(now)) return null;
  const hit = hitsAny(text, T.nightWords);
  if (!hit) return null;
  log('群 ' + gid + ' 出现「' + hit + '」，开始写今天的日记');
  return draft('群里出现「' + hit + '」');
}

/* ── 触发：她的私信 ─────────────────────────────────────────────────
 * 返回 null = 不管这条（照常当聊天）；返回 {handled:true,...} = 这条被日记流程吃掉了，
 * 调用方不要再当聊天回一遍（否则她回一句「发」会收到聊天回复 + 日记动作两条）。 */
async function onPrivateFromMaster(text) {
  const T = loadTrigger();
  const t = String(text || '').trim();
  if (!t) return null;
  const st = loadState();

  // 1) 先判「发」/「重写」——这两个只有在有草稿时才拦，
  //    免得她平时说一句「发」就被当成审批（没草稿时原样当聊天）。
  if (st.phase === 'drafted') {
    const yes = String(T.approveWord || '发').trim();
    const no = String(T.rewriteWord || '重写').trim();
    if (t === yes || t === '发' || t === '发吧' || t === '可以发' || t === '行') {
      log('她回「发」，通过');
      const r = await approve('master');
      return Object.assign({ handled: true, act: 'approve' }, r || {});
    }
    if (t === no || t === '重写' || t === '重写吧' || t === '不行' || t === '驳回') {
      log('她回「重写」，驳回');
      const r = await rewrite();
      return Object.assign({ handled: true, act: 'rewrite' }, r || {});
    }
  }

  // 2) 再判「今天结束」这类
  const hit = hitsAny(t, T.endWords);
  if (!hit) return null;
  if (st.phase === 'drafting') return { handled: true, act: 'busy' };
  if (st.phase === 'drafted') return { handled: true, act: 'waiting' };
  if (st.phase === 'published' && st.day === todayLocal()) return { handled: true, act: 'done-today' };
  log('主人说「' + hit + '」，开始写今天的日记');
  const r = await draft('主人说「' + hit + '」');
  return Object.assign({ handled: true, act: 'draft' }, r || {});
}

/* ── 定时：08:00 兜底 / 22:00 静默提醒 ────────────────────────────── */
function tick(nowArg) {
  const now = nowArg ? new Date(nowArg) : new Date();
  const T = loadTrigger();
  const st = loadState();
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = todayLocal(now);

  if (st.phase === 'drafting') return { phase: st.phase };

  // ① 08:00 兜底：昨天那篇还缺，就补一篇（补完直接发，她定「兜底那篇自动发」）
  const fb = hmToMin(T.fallbackAt || '08:00', 480);
  if (mins >= fb && st.phase === 'idle') {
    const y = core.yesterdayStamp(now);
    if (!core.diaryExists(y)) {
      log('到 ' + (T.fallbackAt || '08:00') + ' 了，昨天还没有日记，兜底补一篇');
      draft('到 ' + (T.fallbackAt || '08:00') + ' 兜底', { autoPass: T.fallbackAutoPublish !== false })
        .catch(e => log('兜底写失败：' + e.message));
      return { phase: 'drafting', by: 'fallback' };
    }
  }

  // ② 22:00 + 群静默够久 → 她自己来问（今天还没写、也还没问过）
  const askAt = hmToMin(T.askAt || '22:00', 1320);
  if (mins >= askAt && st.phase === 'idle' && st.askedDay !== today) {
    const need = Number(T.askSilentMin) || 120;
    const silent = silentMinutes(now.getTime());
    if (silent >= need) {
      st.askedDay = today;
      saveState(st);
      log('22:00 了、群静默 ' + silent + ' 分钟，去问主人今天结不结束');
      tellMaster('群里好久没人说话了（' + Math.round(silent / 60) + ' 个小时了）。'
        + '今天要结束了吗？你说结束，我就写今天的日记。');
      return { phase: 'idle', asked: true };
    }
    return { phase: 'idle', waitingSilence: true, silent };
  }

  return { phase: st.phase };
}

/* ── 给面板看 ─────────────────────────────────────────────────────── */
function view() {
  ensureInit();        // 面板可能在机器人进程起来之前就打开；这时候也要先把游标定到「现在」
  const st = loadState();
  const T = loadTrigger();
  return {
    ok: true,
    phase: st.phase,
    day: st.day,
    title: st.title,
    retry: st.retry,
    cursor: st.cursor,
    total: core.chatLogLineCount(),
    pending: Math.max(0, core.chatLogLineCount() - st.cursor),
    why: st.why,
    at: st.at,
    askedDay: st.askedDay,
    published: st.published,
    hasDraft: !!(st.phase === 'drafted' && st.text),
    draftHead: String(st.text || '').slice(0, 400),
    qzoneText: st.qzoneText,
    rules: {
      nightWords: T.nightWords || [],
      endWords: T.endWords || [],
      askAt: T.askAt || '22:00',
      askSilentMin: T.askSilentMin || 120,
      fallbackAt: T.fallbackAt || '08:00',
      approveWord: T.approveWord || '发',
      rewriteWord: T.rewriteWord || '重写',
      maxRetry: T.maxRetry || 3,
      publishQzone: T.publishQzone !== false,
      publishBili: T.publishBili !== false,
    },
    silentMin: silentMinutes(),
  };
}

/* 面板手动动作：now（立刻写）/ approve / rewrite / reset */
async function act(what) {
  ensureInit();        // 「现在写」之前也要先把游标定好，否则会把几千条历史当一篇重写
  const w = String(what || '');
  if (w === 'now') return draft('面板手动写');
  if (w === 'approve') return approve('master');
  if (w === 'rewrite') return rewrite();
  if (w === 'reset') {
    const st = loadState();
    st.phase = 'idle';
    st.text = '';
    st.title = '';
    st.qzoneText = '';
    st.retry = 0;
    saveState(st);
    log('面板重置了草稿状态');
    return { ok: true };
  }
  return { ok: false, reason: 'unknown-act' };
}

module.exports = {
  ensureInit, onGroupText, onPrivateFromMaster, tick, view, act,
  draft, approve, rewrite, loadState, saveState, silentMinutes, STATE,
};
