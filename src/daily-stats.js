'use strict';
/* ===========================================================================
 * daily-stats.js —— 上线日报的唯一统计与渲染模块
 *
 * 用途：每天第一次上线（0 点后）把「昨天」的成绩单发到主人群。
 * 铁律（主人 2026-11-24 令）：
 *   ① 每个数字都取对象**自己的计数/日志/时间戳**，不另写平行计数器；
 *   ② 行为数只认「真发成功」的记录，失败不进行为数；
 *   ③ 失败单独汇总成「共报错」，标错（待修复）另算，两者不混；
 *   ④ 模块本身只读 + 渲染，发送在 qq.js 的 greetOnii 里。
 *
 * 唯一的两处「对象本身不计数」补写：
 *   · data/move-poop-stats.jsonl —— move-poop 每转发成功一次写一行（见 move-poop.js）
 *   · data/daily-stats.json      —— 日切快照，只存人数/群数/条目数/好感分这些对象的「昨天基线」
 * =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const SNAPSHOT = path.join(DATA, 'daily-stats.json');
const MOVE_POOP_STATS = path.join(DATA, 'move-poop-stats.jsonl');
const DEFAULT_BANSHI = path.join(os.homedir(), '.astrbot', 'data', 'plugins',
  'astrbot_plugin_banshi_auto', 'data');

// 系统故障类（≠标错「待修复」）：只这些算「共报错」
const ERR_KINDS = new Set([
  '消息没发出去', '表情没发出去', '消息没回', '模型全都答不上来',
  '模型余额不足', '模型被限流', '模型用不了', 'B站提醒被风控', '发送回读失效',
]);
const DIARY_KINDS = new Set(['日记']);

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function keyOfDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayKey(now) { return keyOfDate(new Date(Number(now) || Date.now())); }
function dayBefore(day) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return keyOfDate(d);
}
function dayRange(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  return { start, end: start + 24 * 3600 * 1000 };
}
function inRange(ts, day) {
  if (!ts) return false;
  const r = dayRange(day);
  const t = Number(ts) || Date.parse(ts) || 0;
  return t >= r.start && t < r.end;
}
function favName(qq) {
  try {
    const p = require('./people');
    return shortName(p.labelOfKey('qq:' + qq));
  } catch { return shortName(qq); }
}
function shortName(s) {
  return String(s || '').replace(/[（(].*$/, '').replace(/QQ\s*[\d:]+.*$/i, '').trim().slice(0, 6) || '—';
}
function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}
function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()); } catch { return []; }
}
function readJSONL(p) {
  const out = [];
  for (const l of readLines(p)) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
function safe(fn, def) { try { const v = fn(); return v === undefined ? def : v; } catch { return def; } }

/* ── 事件总账：bot-writes.jsonl（各模块主动写文件时自己记的） ───────────── */
function loadWrites(dataDir, day) {
  const arr = [];
  for (const o of readJSONL(path.join(dataDir, 'bot-writes.jsonl'))) {
    if (!o || !o.t) continue;
    const t = Date.parse(o.t);
    if (!(t >= dayRange(day).start && t < dayRange(day).end)) continue;
    arr.push(o);
  }
  return arr;
}

/* ── 好友/群：对象自己的名单 ─────────────────────────────────────────── */
function peopleCount() {
  try { return require('./people').all().length; } catch { return null; }
}
function groupCount() {
  try { return Object.keys(require('./qq-meta').groupNames()).length; } catch { return null; }
}

/* 搜索到：bot-writes 自己的历史（topics.jsonl 的 text 不带这个前缀，不能反推） */
function searchedTotal(dataDir) {
  let n = 0;
  for (const o of readJSONL(path.join(dataDir, 'bot-writes.jsonl'))) {
    if (o && o.action === '话题' && /^搜索到的/.test(String(o.text || ''))) n++;
  }
  return n;
}
/* 搜索到：bot-writes 自己的历史（topics.jsonl 的 text 不带这个前缀，不能反推） */
function searchedTotal(dataDir) {
  let n = 0;
  for (const o of readJSONL(path.join(dataDir, 'bot-writes.jsonl'))) {
    if (o && o.action === '话题' && /^搜索到的/.test(String(o.text || ''))) n++;
  }
  return n;
}
/* ── 话题/约定/搜索：topics.jsonl 自己的 kind ─────────────────────────── */
function topicTotals(dataDir) {
  const r = { topic: 0, promise: 0, searched: 0 };
  for (const o of readJSONL(path.join(dataDir, 'topics.jsonl'))) {
    if (!o || !o.kind) continue;
    if (o.kind === 'promise') r.promise++;
    else if (o.kind === 'topic') {
      r.topic++;
      if (/^搜索到的/.test(String(o.text || ''))) r.searched++;
    }
  }
  return r;
}

/* ── 星标：core 自己是唯一写入口 ─────────────────────────────────────── */
function starTotals(dataDir, day) {
  // 生产走 core.starsRead（唯一写入口）；测试用别的 dataDir 时直接读那份 fixture。
  const list = safe(() => (dataDir === DATA ? require('./core').starsRead() : readJSON(path.join(dataDir, 'chat-stars.json'), [])), []);
  let today = 0;
  for (const x of list) {
    if (!x) continue;
    const at = x.at || x.t;
    if (x.by === 'emoji' && inRange(at, day)) today++;
  }
  return { total: list.length, todayEmoji: today };
}

/* ── 标错 / 报错：ai-feedback.jsonl 自己的 kind ───────────────────────── */
function feedbackTotals(dataDir, day) {
  const r = { issueTotal: 0, issueToday: 0, withdrawToday: 0, errorTotal: 0, errorToday: 0, errKinds: {} };
  for (const o of readJSONL(path.join(dataDir, 'ai-feedback.jsonl'))) {
    if (!o || !o.kind) continue;
    const t = Date.parse(o.t || '');
    const isDay = t >= dayRange(day).start && t < dayRange(day).end;
    if (o.kind === '待修复') {
      r.issueTotal++;
      if (isDay) {
        r.issueToday++;
        if (/有消息被撤回/.test(String(o.text || ''))) r.withdrawToday++;
      }
    } else if (ERR_KINDS.has(o.kind)) {
      r.errorTotal++;
      if (isDay) { r.errorToday++; r.errKinds[o.kind] = (r.errKinds[o.kind] || 0) + 1; }
    }
  }
  return r;
}

/* ── 平台各自的成功日志 ──────────────────────────────────────────────── */
function biliTotals(dataDir, day) {
  const posted = readJSONL(path.join(dataDir, 'bili-dynamic-posted.jsonl'));
  let today = 0, todayShit = 0, shitTotal = 0;
  for (const o of posted) {
    if (!o) continue;
    const shit = o.priority === 'move-poop';
    if (shit) shitTotal++;
    if (inRange(o.at, day)) { today++; if (shit) todayShit++; }
  }
  return { total: posted.length, today, todayShit, shitTotal };
}
function qzoneTotals(dataDir, day) {
  const h = readJSON(dataDir + '/qzone-history.json', {}) || {};
  const posts = Array.isArray(h.posts) ? h.posts : [];
  const days = h.days || {};
  const postedToday = posts.filter(p => inRange(String((p && p.t) || '').replace('T', ' '), day)).length;
  return {
    postTotal: posts.length,
    postToday: postedToday,
    planDone: Number((days[day] || {}).done || 0),
  };
}
function qzoneComments(dataDir, day) {
  const all = readJSONL(path.join(dataDir, 'qzone-friend-comments.jsonl'));
  return { total: all.length, today: all.filter(o => inRange(o && o.t, day)).length };
}
function rocoStatus(day) {
  try { return require('./roco-bili').status(day); } catch { return null; }
}
/* 共评论：空间评论 + B站提醒评论 + B站回评（各自成功才记） */
function commentTotals(dataDir, day) {
  const qc = readJSONL(path.join(dataDir, 'qzone-friend-comments.jsonl'));
  const st = readJSON(path.join(dataDir, 'roco-bili-state.json'), {}) || {};
  let replied = 0;
  for (const k of Object.keys(st.replyDaily || {})) replied += Number(st.replyDaily[k]) || 0;
  const commented = Object.keys(st.commented || {}).length;
  return {
    total: qc.length + commented + replied,
    qzoneToday: qc.filter(o => inRange(o && o.t, day)).length,
  };
}
function diaryView() {
  try { return require('./diary-flow').view(); } catch { return null; }
}

/* ── 搬屎：banshi 插件自己的 seen_index + xuhbot move-poop 自己的流水 ── */
function banshiTotals(banshiDir, day, cfg) {
  // 只用插件自己的两份账：
  //   archive/<日期>.jsonl —— 当天「取用」了几条（取消息条数、源群）
  //   sent.jsonl           —— 每次「发成功」一行 (mid,target,at)（目标群数、每群最多/最少、累计）
  const out = { sourceGroups: [], sourceMsgs: null, targetGroups: null, perGroup: {}, total: null, ok: false };
  if (!banshiDir) return out;
  const conf = readJSON(path.resolve(banshiDir, '../../../config/astrbot_plugin_banshi_auto_config.json'), null);
  const srcs = (conf && Array.isArray(conf.source_group_list)) ? conf.source_group_list.map(String) : [];
  out.sourceGroups = srcs;
  const srcSet = new Set(srcs);

  // 当天取的（archive）：一行一条，含 source
  const arch = readJSONL(path.join(banshiDir, 'archive', day + '.jsonl'));
  if (arch.length) {
    out.ok = true;
    out.sourceMsgs = arch.length;
    if (!srcSet.size) {
      for (const o of arch) if (o && o.source) srcSet.add(String(o.source));
      out.sourceGroups = [...srcSet];
    }
  }

  // 发送账（sent.jsonl）：按 (mid,target) 去重，只认当天 at
  const sent = readJSONL(path.join(banshiDir, 'sent.jsonl'));
  if (sent.length) {
    out.ok = true;
    const allMids = new Set();
    const dayKeys = new Set();
    for (const o of sent) {
      if (!o) continue;
      const mid = String(o.mid || '').replace(/^key:mid:/, '');
      if (mid) allMids.add(mid);
      if (!inRange(Number(o.at) * 1000, day)) continue;
      const tgt = String(o.target || '');
      if (!tgt || srcSet.has(tgt)) continue;
      const k = mid + '|' + tgt;
      if (dayKeys.has(k)) continue;
      dayKeys.add(k);
      out.perGroup[tgt] = (out.perGroup[tgt] || 0) + 1;
    }
    out.total = allMids.size;
    out.targetGroups = Object.keys(out.perGroup).length;
  }
  return out;
}
function movePoopTotals(dataDir, day) {
  const rows = readJSONL(path.join(dataDir, 'move-poop-stats.jsonl')).filter(o => inRange(o && o.t, day));
  const srcs = new Set(), mids = new Set(), tgts = new Set(), per = {};
  for (const r of rows) {
    if (r.sourceGroup) srcs.add(String(r.sourceGroup));
    if (r.mid) mids.add(String(r.mid));
    if (r.targetGroup) { tgts.add(String(r.targetGroup)); per[r.targetGroup] = (per[r.targetGroup] || 0) + 1; }
  }
  return { sourceGroups: srcs.size, sourceMsgs: mids.size, targetGroups: tgts.size, perGroup: per };
}
function mergeShi(b, m) {
  const per = Object.assign({}, b.perGroup);
  for (const g of Object.keys(m.perGroup)) per[g] = (per[g] || 0) + m.perGroup[g];
  const counts = Object.values(per);
  const sourceGroups = b.sourceGroups.length + (m.sourceGroups ? m.sourceGroups : 0);
  return {
    available: !!b.ok || sourceGroups > 0,
    sourceGroups: sourceGroups || null,
    sourceMsgs: b.ok ? b.sourceMsgs + m.sourceMsgs : (m.sourceMsgs || null),
    targetGroups: Object.keys(per).length || (b.targetGroups || m.targetGroups || null),
    max: counts.length ? Math.max.apply(null, counts) : null,
    min: counts.length ? Math.min.apply(null, counts) : null,
    total: b.ok ? b.total : null,
  };
}

/* ── bot-writes 今日事件：话题/约定/喜恶/关系/好感/其他 ───────────────── */
function writeEvents(writes) {
  const ev = {
    records: 0, pacts: 0, searched: 0,
    stancePairs: 0, stanceUp: 0, stanceDown: 0, stanceByPerson: {},
    tasteByPerson: {},
    favorFallback: {},
    qqPosts: 0, qqComments: 0,
    newPeople: 0, newGroups: 0, stickers: 0, health: 0,
  };
  for (const o of writes) {
    const a = String(o.action || ''), t = String(o.text || '');
    if (a === '话题') {
      if (/^搜索到的/.test(t)) ev.searched++;
      else ev.records++;
    } else if (a === '约定') ev.pacts++;
    else if (a === 'QQ空间发动态') ev.qqPosts++;
    else if (a === '逛空间评论') ev.qqComments++;
    else if (a === '新人物') ev.newPeople++;
    else if (a === '新群') ev.newGroups++;
    else if (a === '表情包收集') ev.stickers++;
    else if (a === '保健提醒') ev.health++;
    else if (a === '喜恶') {
      const who = shortName(t.split('：')[0]);
      // 「我喜欢/我讨厌/我还没表态」是她自己的口味，不是别人的喜好变动；「空间动态」是批量归并行。
      if (/^我/.test(who) || who === '空间动态') continue;
      ev.tasteByPerson[who] = (ev.tasteByPerson[who] || 0) + 1;
    } else if (a === '好感') {
      const m = t.match(/(-?\d+)\s*→\s*(-?\d+)/);
      if (m) {
        const who = shortName(t.split('：')[0]);
        ev.favorFallback[who] = (Number(m[2]) || 0) - (Number(m[1]) || 0);
      }
    } else if (a === '关系' && !/共同话题/.test(t)) {
      const m = t.match(/\s*→\s*([^：]+)：(.+)$/);
      if (!m) continue;
      const aName = shortName(t.split('→')[0]);
      const bName = shortName(m[1]);
      ev.stancePairs++;
      const up = /喜/.test(m[2]) && !/降/.test(m[2]);
      if (up) ev.stanceUp++; else ev.stanceDown++;
      ev.stanceByPerson[aName] = (ev.stanceByPerson[aName] || 0) + 1;
      ev.stanceByPerson[bName] = (ev.stanceByPerson[bName] || 0) + 1;
    }
  }
  return ev;
}
function topOf(map) {
  const ks = Object.keys(map || {});
  if (!ks.length) return null;
  ks.sort((a, b) => map[b] - map[a]);
  return { maxName: ks[0], max: map[ks[0]], minName: ks[ks.length - 1], min: map[ks[ks.length - 1]] };
}

/* ── 好感：当前分 vs 昨天的快照 ───────────────────────────────────────── */
function favorNow() {
  try {
    const people = require('./people');
    const out = {};
    for (const x of require('./favor').all()) {
      const name = safe(() => people.labelOfKey('qq:' + x.qq), '') || '';
      out[String(x.qq)] = { v: Number(x.v) || 0, name };
    }
    return out;
  } catch { return null; }
}
function favorDiff(cur, prev) {
  if (!cur || !prev) return null;
  const deltas = {};
  for (const k of Object.keys(cur)) {
    if (!(k in prev)) continue;
    const curV = Number(cur[k] && cur[k].v !== undefined ? cur[k].v : cur[k]) || 0;
    const d = curV - Number(prev[k] || 0);
    if (d) deltas[k] = d;
  }
  const vals = Object.values(deltas);
  if (!vals.length) return { count: 0, up: 0, down: 0, max: null, min: null };
  const maxK = Object.keys(deltas).sort((a, b) => deltas[b] - deltas[a])[0];
  const minK = Object.keys(deltas).sort((a, b) => deltas[a] - deltas[b])[0];
  return {
    count: Object.keys(deltas).length,
    up: vals.filter(v => v > 0).length,
    down: vals.filter(v => v < 0).length,
    max: { delta: deltas[maxK], name: maxK },
    min: { delta: deltas[minK], name: minK },
  };
}

/* ── 模型用量：token-usage.jsonl 自己的流水 ───────────────────────────── */
function usageToday(dataDir, day) {
  const rows = readJSONL(path.join(dataDir, 'usage', 'token-usage.jsonl'));
  let calls = 0, fails = 0;
  for (const o of rows) if (inRange(o && o.t, day)) { calls++; if (o.ok === false) fails++; }
  return { calls, fails };
}

/* ── 采集 ─────────────────────────────────────────────────────────────── */
function collect(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || DATA;
  const now = Number(o.now) || Date.now();
  const day = o.day || keyOfDate(new Date(now - 24 * 3600 * 1000));
  const cfg = o.cfg || safe(() => require('./config').cfgLive(), {}) || {};
  const dr = cfg.dailyReport || {};
  const banshiDir = o.banshiDir !== undefined ? o.banshiDir : (dr.banshiDataDir || DEFAULT_BANSHI);

  const writes = safe(() => loadWrites(dataDir, day), []);
  const ev = writeEvents(writes);
  const topics = safe(() => topicTotals(dataDir), { topic: 0, promise: 0, searched: 0 });
  topics.searched = safe(() => searchedTotal(dataDir), topics.searched);
  topics.searched = safe(() => searchedTotal(dataDir), topics.searched);
  const stars = o.stars !== undefined ? o.stars : safe(() => starTotals(dataDir, day), { total: 0, todayEmoji: 0 });
  const fb = safe(() => feedbackTotals(dataDir, day), { issueTotal: 0, issueToday: 0, withdrawToday: 0, errorTotal: 0, errorToday: 0, errKinds: {} });
  const bili = safe(() => biliTotals(dataDir, day), { total: 0, today: 0, todayShit: 0, shitTotal: 0 });
  const qz = safe(() => qzoneTotals(dataDir, day), { postTotal: 0, postToday: 0, planDone: 0 });
  const qc = safe(() => qzoneComments(dataDir, day), { total: 0, today: 0 });
  const roco = o.roco !== undefined ? o.roco : safe(() => rocoStatus(day), null);
  const dv = o.diaryView !== undefined ? o.diaryView : safe(() => diaryView(), null);
  const shi = safe(() => mergeShi(banshiTotals(banshiDir, day, cfg), movePoopTotals(dataDir, day)), { available: false });
  const usg = safe(() => usageToday(dataDir, day), { calls: 0, fails: 0 });

  const msgTotal = safe(() => readLines(path.join(dataDir, '她说过的话.jsonl')).length, null);
  const favorCur = o.favor !== undefined ? o.favor : safe(() => favorNow(), null);

  const snap = o.snapshot === undefined ? readSnapshot(dataDir) : o.snapshot;
  const prevDay = dayBefore(day);
  const prev = snap && snap.day === prevDay ? snap : null;

  const biliRoco = roco || {};
  const diary = diaryOf(dv, day, now);
  const people = o.people !== undefined ? o.people : peopleCount();
  const groups = o.groups !== undefined ? o.groups : groupCount();

  return {
    day,
    dataDir,
    msgTotal,
    shitTotal: shi.total,
    commentTotal: safe(() => commentTotals(dataDir, day).total, null),
    postTotal: (qz.postTotal || 0) + (bili.total || 0),
    errorTotal: fb.errorTotal,
    errorToday: fb.errorToday,
    errKinds: fb.errKinds,
    people,
    groups,
    topics, stars, issues: { total: fb.issueTotal, today: fb.issueToday, withdrawToday: fb.withdrawToday },
    botwrites: ev,
    shi,
    bili: {
      today: bili.today, todayShit: bili.todayShit,
      rocoToday: biliRoco.today || 0, rocoRare: biliRoco.todayRare || 0, rocoCommon: biliRoco.todayCommon || 0,
      normalComments: biliRoco.todayCommon || 0,
      repliedNew: (biliRoco.repliers && biliRoco.repliers.todayNew) || 0,
      repliedToday: (biliRoco.repliers && biliRoco.repliers.today) || 0,
    },
    qq: { posts: ev.qqPosts, postPlanDone: qz.planDone, comments: ev.qqComments, commentsLog: qc.today },
    diary,
    stance: { pairs: ev.stancePairs, up: ev.stanceUp, down: ev.stanceDown, per: topOf(ev.stanceByPerson) },
    taste: { people: Object.keys(ev.tasteByPerson).length, entries: Object.values(ev.tasteByPerson).reduce((a, b) => a + b, 0), per: topOf(ev.tasteByPerson) },
    favor: favorDiff(favorCur, prev && prev.favor) || favorFallbackOf(ev),
    other: { newPeople: ev.newPeople, newGroups: ev.newGroups, stickers: ev.stickers, health: ev.health, calls: usg.calls, fails: usg.fails },
    favorNow: favorCur,
    deltas: {
      people: deltaOf(people, prev && prev.people),
      groups: deltaOf(groups, prev && prev.groups),
      records: deltaOf(topics.topic, prev && prev.topics),
      pacts: deltaOf(topics.promise, prev && prev.promises),
      searched: deltaOf(topics.searched, prev && prev.searched),
    },
    hasPrev: !!prev,
  };
}
function deltaOf(cur, prev) {
  if (cur == null || prev == null) return null;
  return Number(cur) - Number(prev);
}
function favorFallbackOf(ev) {
  const map = ev.favorFallback || {};
  const ks = Object.keys(map);
  if (!ks.length) return null;
  ks.sort((a, b) => map[b] - map[a]);
  return {
    count: ks.length,
    up: ks.filter(k => map[k] > 0).length,
    down: ks.filter(k => map[k] < 0).length,
    max: { delta: map[ks[0]], name: ks[0] },
    min: { delta: map[ks[ks.length - 1]], name: ks[ks.length - 1] },
  };
}
function diaryOf(dv, day, now) {
  const rules = (dv && dv.rules) || {};
  const at = String(rules.fallbackAt || '08:00');
  const [hh, mm] = at.split(':').map(Number);
  const base = new Date(now);
  base.setSeconds(0, 0);
  base.setMilliseconds(0);
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh || 8, mm || 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  const leftMin = Math.max(0, Math.round((next.getTime() - now) / 60000));
  const pub = (dv && dv.published) || {};
  const forDay = !!(dv && dv.day === day);
  return {
    phase: dv ? dv.phase : null,
    bili: forDay && pub.bili ? !!pub.bili.ok : null,
    qzone: forDay && pub.qzone ? !!pub.qzone.ok : null,
    forDay,
    nextAt: at, leftMin,
    label: forDay ? '昨天' : '未写',
  };
}

/* ── 快照（唯一的日切基线补写） ───────────────────────────────────────── */
function snapPath(dir) { return path.join(dir || DATA, 'daily-stats.json'); }
function readSnapshot(dir) { return readJSON(snapPath(dir), null); }
function writeSnapshot(day, m, dir) {
  try {
    const cur = (m && m.favorNow) || favorNow() || {};
    const p = snapPath(dir || (m && m.dataDir));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      day,
      people: m.people, groups: m.groups,
      topics: m.topics.topic, promises: m.topics.promise, searched: m.topics.searched,
      favor: cur,
    }), 'utf8');
    return true;
  } catch (e) { console.log('[日报] 快照写失败：' + e.message); return false; }
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */
function n2(v) { return v == null ? '—' : String(v); }
function d2(v) { return v == null ? '—' : (v > 0 ? '+' + v : v < 0 ? String(v) : '0'); }
function personDelta(name, d) {
  if (d == null) return name;
  return name + d2(d);
}
function diaryWord(v) { return v == null ? '未写' : (v ? '已发' : '未发'); }
function fmtMin(m) {
  if (m == null) return '—';
  if (m >= 60) return Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '');
  return m + '分钟';
}
function render(m, opts) {
  const o = opts || {};
  const maxChars = Math.max(200, Number(o.maxChars) || 600);
  const d = m.deltas || {};
  const errKinds = Object.keys(m.errKinds || {}).sort((a, b) => m.errKinds[b] - m.errKinds[a]);
  const errTodayText = m.errorToday
    ? m.errorToday + '（' + (errKinds.length ? errKinds.map(k => k + m.errKinds[k]).join('／') : '杂项') + '）'
    : '0';
  const st = m.stance || {};
  const ta = m.taste || {};
  const fa = m.favor || {};
  const shi = m.shi || {};
  const bl = m.bili || {};
  const qq = m.qq || {};
  const ot = m.other || {};
  const dy = m.diary || {};

  const lines = [
    { key: 'title', p: 100, text: '【昨日日报 ' + m.day.slice(5) + '】' },
    { key: 'total', p: 99, text: '累计 消息' + n2(m.msgTotal) + '｜屎' + n2(m.shitTotal) + '｜评论' + n2(m.commentTotal)
      + '｜动态' + n2(m.postTotal) + '｜报错' + n2(m.errorTotal) },
    { key: 'people', p: 95, text: '人物' + n2(m.people) + '（' + d2(d.people) + '）｜群' + n2(m.groups) + '（' + d2(d.groups) + '）' },
    { key: 'records', p: 94, text: '记录' + n2(m.topics.topic) + '（' + d2(d.records) + '）｜约定' + n2(m.topics.promise)
      + '（' + d2(d.pacts) + '）｜搜到' + n2(m.topics.searched) + '（' + d2(d.searched) + '）' },
    { key: 'stars', p: 90, text: '星标' + n2(m.stars.total) + '（表情+' + (m.stars.todayEmoji || 0) + '）｜标错'
      + n2(m.issues.total) + '（+' + (m.issues.today || 0) + (m.issues.withdrawToday ? '，撤回' + m.issues.withdrawToday : '') + '）' },
    { key: 'errors', p: 89, text: '报错 ' + errTodayText + '｜累计' + n2(m.errorTotal) },
    { key: 'shi', p: 70, text: shi.available
      ? '屎 源' + n2(shi.sourceGroups) + '群/取' + n2(shi.sourceMsgs) + '条 → ' + n2(shi.targetGroups) + '群，最多' + n2(shi.max) + '条、最少' + n2(shi.min) + '条'
      : '屎 —（没有搬屎数据）' },
    { key: 'bili', p: 65, text: 'B站 洛克' + (bl.rocoToday || 0) + '（普通' + (bl.rocoCommon || 0) + '/稀有' + (bl.rocoRare || 0)
      + '）｜动态' + (bl.today || 0) + '（其中屎' + (bl.todayShit || 0) + '）｜评论' + (bl.normalComments || 0)
      + '｜被回' + (bl.repliedNew || 0) + '｜日记' + diaryWord(dy.bili) },
    { key: 'qq', p: 64, text: 'QQ 动态' + (qq.posts || 0) + '｜评论' + (qq.comments || 0) + '｜日记' + diaryWord(dy.qzone) },
    { key: 'stance', p: 50, text: '喜厌：' + (st.pairs || 0) + ' 对关系变化（变喜 ' + (st.up || 0) + '、变厌 ' + (st.down || 0)
      + '）' + (st.per ? '；动得最多 ' + st.per.maxName + st.per.max + ' 次、最少 ' + st.per.minName + st.per.min + ' 次' : '') },
    { key: 'taste', p: 49, text: '喜好：' + (ta.people || 0) + ' 人记了 ' + (ta.entries || 0) + ' 条'
      + (ta.per ? '；最多 ' + ta.per.maxName + ta.per.max + ' 条、最少 ' + ta.per.minName + ta.per.min + ' 条' : '') },
    { key: 'favor', p: 48, text: fa && fa.count != null
      ? '好感：' + fa.count + ' 人变了' + (fa.max ? '；涨得最多 ' + favName(fa.max.name) + d2(fa.max.delta) + '、跌得最多 ' + favName(fa.min.name) + d2(fa.min.delta) : '')
      : '好感 —（无昨日基线）' },
    { key: 'other', p: 30, text: '其他 新人物' + (ot.newPeople || 0) + '｜新群' + (ot.newGroups || 0) + '｜收图' + (ot.stickers || 0)
      + '｜健康提醒' + (ot.health || 0) + '｜模型' + (ot.calls || 0) + '次/失败' + (ot.fails || 0) },
    { key: 'next', p: 20, text: '日记下次 ' + (dy.nextAt || '08:00') + '（还有 ' + fmtMin(dy.leftMin) + '）' + (dy.phase === 'drafted' && dy.forDay ? '，草稿等你点头' : '') },
  ];
  // 超长：从优先级最低的开始丢整行，绝不截半句
  const drop = ['next', 'other', 'favor', 'taste', 'stance', 'qq', 'bili', 'shi'];
  let out = lines.slice();
  const len = arr => arr.map(x => x.text).join('\n').length;
  for (const k of drop) {
    if (len(out) <= maxChars) break;
    out = out.filter(x => x.key !== k);
  }
  let text = out.map(x => x.text).join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

/* ── 一次性入口（qq.js / 测试 / 演练都走它） ──────────────────────────── */
function run(opts) {
  const o = opts || {};
  const m = collect(o);
  const maxChars = o.maxChars || (o.cfg && o.cfg.dailyReport && o.cfg.dailyReport.maxChars) || 600;
  const text = render(m, { maxChars });
  if (o.dry !== true) writeSnapshot(m.day, m);
  return { stats: m, text };
}

module.exports = {
  collect, render, run, readSnapshot, writeSnapshot,
  dayRange, dayBefore, todayKey, keyOfDate, ERR_KINDS,
  _defaults: { DATA, SNAPSHOT, MOVE_POOP_STATS, DEFAULT_BANSHI },
};
