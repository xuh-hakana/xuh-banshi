/*
 * src/learn/favor.js —— 每个人的好感：事件流水 / 衰减 / 撤销
 *
 * 这是干什么的：people.js 只存「现在多少分」，这里补上「为什么变、能不能反悔」。
 * 分数真身**仍然是 people.js**（单一数据源，不复制一份分数）；
 * 这里只多两样东西：
 *   users/<pid>/favor.jsonl  一条一次变化，只追加，带理由和证据
 *   users/<pid>/decay.json   当前衰减速率（她 2026-11-09 定的规则）
 *
 * 衰减规则（主人 2026-11-09 原话）：「触发一次掉好感后每天按那次的数量掉，直到触发加好感」。
 * 落成代码 = 记下上次掉分的绝对值当速率，每天按这个数扣一次，直到来了一次加分为止。
 */
const people = require('../people');
const store = require('./store');
const S = require('./schema');

const evPath = pid => store.userPath(pid, S.FILES.favor);
const decayPath = pid => store.userPath(pid, S.FILES.decay);

function exists(pid) { try { return !!people.get(pid); } catch (e) { return false; } }

function clipEvidence(ev) {
  if (!ev) return null;
  return {
    ref: String(ev.ref || '').slice(0, 160),
    quote: String(ev.quote || '').slice(0, 160),
  };
}

/* 写一条事件 + 更新衰减速率。分数已经由调用方改好，这里不再动 people。
 * 抽出来是为了让两条路共用：record()（自己改分）、note()（别人改完分来留痕）。 */
function writeEvent(pid, before, after, d, o) {
  const ts = Date.now();
  const event = {
    id: store.uid('fv'),
    ts: store.iso(ts),
    pid: String(pid),
    delta: d,
    before,
    after,
    trigger: S.TRIGGER[o.trigger] ? o.trigger : 'chat',
    reason: String(o.reason || '').slice(0, 120),
    evidence: clipEvidence(o.evidence),
    by: o.by === 'master' ? 'master' : 'bot',
  };
  store.appendJSONL(evPath(pid), event);

  // 衰减速率：掉分就按这次掉的量续掉；加分就停
  const st = store.readJSON(decayPath(pid), { rate: 0, since: null, lastAt: null, why: '' });
  if (d < 0) {
    st.rate = Math.abs(d);
    st.since = event.ts;
    st.lastAt = ts;
    st.why = event.reason;
  } else {
    st.rate = 0;
    st.since = null;
    st.lastAt = ts;
    st.why = '';
  }
  store.writeJSON(decayPath(pid), st);
  return event;
}

/* 记一次好感变化。返回 {ok, event} 或 {error}
 * opts: {trigger, reason, evidence, by} */
function record(pid, delta, opts) {
  const o = opts || {};
  const d = Math.round(Number(delta) || 0);
  if (!d) return { error: '变化量是 0，没记' };
  if (!exists(pid)) return { error: '没有这个人：' + pid };

  const before = people.getFavor(pid);
  const after = people.setFavor(pid, before + d);
  return { ok: true, event: writeEvent(pid, before, after, d, o) };
}

/* 别人已经改过分了（people.addFavor 那条老路径），这里只负责留痕。
 * 不碰分数，所以不会和调用方打架，也不会递归回 addFavor。 */
function note(pid, before, after, opts) {
  const b = Number(before) || 0;
  const a = Number(after) || 0;
  const d = Math.round(a - b);
  if (!d || !exists(pid)) return null;
  return writeEvent(pid, b, a, d, opts || {});
}

/* 每天结算一次衰减（由 index.tick 定时调）。
 * 只在「已经跨过整天」时才动，一次把攒下的天数合成一条记录，不写几十行。 */
function tick(nowMs) {
  const t = Number(nowMs) || Date.now();
  const out = [];
  for (const pid of store.listUserIds()) {
    if (!exists(pid)) continue;
    const st = store.readJSON(decayPath(pid), null);
    if (!st || !st.rate || !st.lastAt) continue;
    const days = Math.floor((t - st.lastAt) / 86400000);
    if (days < 1) continue;

    const before = people.getFavor(pid);
    if (before <= 0) {                       // 已经到底了，停掉速率，别记一堆 0 变动
      st.rate = 0; st.since = null; st.lastAt = t;
      store.writeJSON(decayPath(pid), st);
      continue;
    }
    const delta = -st.rate * days;
    const after = people.setFavor(pid, before + delta);
    const event = {
      id: store.uid('fv'),
      ts: store.iso(t),
      pid,
      delta,
      before,
      after,
      trigger: 'decay',
      reason: days + ' 天没加分，按上次 -' + st.rate + '/天 继续掉',
      evidence: null,
      by: 'bot',
    };
    store.appendJSONL(evPath(pid), event);
    st.lastAt = st.lastAt + days * 86400000;
    if (after <= 0) { st.rate = 0; st.since = null; }
    store.writeJSON(decayPath(pid), st);
    out.push(event);
  }
  return out;
}

/* 撤销一条：不删原记录，追加一条反向记录（审计要能看见「撤过」这件事） */
function revoke(pid, id, why, by) {
  if (!exists(pid)) return { error: '没有这个人：' + pid };
  const list = store.readJSONL(evPath(pid));
  const target = list.find(e => e.id === id);
  if (!target) return { error: '找不到这条记录：' + id };
  if (list.some(e => e.rev && e.rev.of === id)) return { error: '这条已经撤销过了' };

  const before = people.getFavor(pid);
  const after = people.setFavor(pid, before - target.delta);
  const event = {
    id: store.uid('fv'),
    ts: store.iso(Date.now()),
    pid: String(pid),
    delta: -target.delta,
    before,
    after,
    trigger: 'revoke',
    reason: String(why || ('撤销 ' + target.trigger + '：' + (target.reason || ''))).slice(0, 120),
    evidence: { ref: id, quote: '' },
    by: by === 'bot' ? 'bot' : 'master',
    rev: { of: id },
  };
  store.appendJSONL(evPath(pid), event);

  // 撤销的如果正是设速率的那一条，把速率清掉，不然还按错的量继续掉
  const st = store.readJSON(decayPath(pid), null);
  if (st && target.delta < 0 && st.since === target.ts) {
    st.rate = 0; st.since = null; st.why = '';
    store.writeJSON(decayPath(pid), st);
  }
  return { ok: true, event };
}

function recent(pid, n) {
  const list = store.readJSONL(evPath(pid), n || S.LIMITS.recentEvents);
  const revoked = new Set(list.filter(e => e.rev && e.rev.of).map(e => e.rev.of));
  return list.reverse().map(e => Object.assign({}, e, { undone: revoked.has(e.id) }));
}

function state(pid) {
  return store.readJSON(decayPath(pid), { rate: 0, since: null, lastAt: null, why: '' });
}

/* 热层用：只给「朋友录」的定性含义（主人 2026-11-13 令）。
 * 她原话：「人物好感要能看到具体数值，但禁止输出数值，输出内容是「朋友录」的含义，也是人设里虚幻的朋友们」。
 * 数值只在客户端给主人看；这里不出现 0~100 分数、±delta、日期，也不许模型凭数字编「好感 100」。
 * 没有记录就返回空串（不占 token）。 */
function hotBlock(pid, name) {
  if (!exists(pid)) return '';
  const score = people.getFavor(pid);
  const evs = recent(pid, S.LIMITS.summaryEvents).filter(e => !e.undone);
  if (!score && !evs.length) return '';
  const who = String(name || (people.get(pid) || {}).name || '这个人');
  const lvl = S.level(score);                 // 亲近 / 认识 / 无记录，只作定性判断，不输出分数
  const lines = ['## 朋友录 · 「' + who + '」：' + (lvl === '无记录' ? '还不熟' : lvl)];
  lines.push('- 朋友录＝虚幻的朋友们：这里是关系，不是分数。别报数字，也别拿数字当亲近的理由。');
  if (score < 1) lines.push('- 还不熟：别自来熟，也别一上来就贴。');
  else if (score >= 60) lines.push('- 自己人：可以主动找话、可以损两句。');
  else lines.push('- 认识：正常来往，别过度热情。');
  // 事由照旧给（不砍功能），但抹掉 ±delta / 日期 / 任何数字，只留文字。
  for (const e of evs.slice(0, 2)) {
    const why = String(e.reason || '').replace(/[+-]?\d+(?:\.\d+)?/g, '').replace(/[（）()]/g, '').trim();
    if (why) lines.push('- 最近：' + why.slice(0, 60));
  }
  return lines.join('\n');
}

module.exports = { record, note, tick, revoke, recent, state, hotBlock, evPath, decayPath };
