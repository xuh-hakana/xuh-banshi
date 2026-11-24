/*
 * replypath.js — 「回话路径」：四张表统一入口
 *
 * 主人 2026-11-13 原文：
 *   「后续增加『情绪应对表』（让虚幻知道情绪之间是怎么应对的，和『喜好表』的联动是有自己偏好的应对。
 *     『情绪书』和『情绪应对』是同样的功能，但『情绪应对』前端页需要纯文字，无图，方便我选择更多应对方式）、
 *     『动作应对表』、『信息对齐表』。这些表与『虚幻喜好表』之间有联动，统一成『回话路径』入口加在前端。」
 *   「模型不记串：每个喜好有唯一 id。其他表写关联偏好 id。」
 *   「冲突优先级：特别喜欢、特别讨厌、确定讨厌、确定喜欢、中立。我可设例外项目。」
 *   「触发条件和强度阈值：触发/上限/抑制/例外/外显等等具体内容。先只记录不做。」
 *
 * 2026-11-15 她纠正（覆盖 11-13 做错的那版）：
 *   正确是「情绪应对表 / 动作应对表 / 信息对齐表 / 虚幻喜好表」**四张表平级**统一成「回话路径」，
 *   不是「三张表 + 两份喜好 + 设置」。第 ⑧ 条的本地模型副本是另一件事，不占这四张表的位置。
 *   情绪应对表不能空着：内容来自情绪书（同一个功能），纯文字无图，能选更多应对方式。
 *
 * 不建双份：虚幻喜好表读正本 soul/F-全场景通用主人设/0-我的喜好.md，情绪书读 data/情绪书.json，
 * 都不复制进本文件；本文件只存「她自己选 / 写的条目」+ 优先级 / 例外 / 阈值配置。
 *
 * 「先只记录不做」是硬边界：trigger/limit/suppress/exception/visible 与 thresholds.items 只存取，
 * 不接进回复链路做判定。retrieve 只负责「命中时把内容交给本地检索」，不判定该用哪条。
 */
const fs = require('fs');
const path = require('path');
const tasteid = require('./tasteid');
const tastecopy = require('./tastecopy');

const FILE = path.join(__dirname, 'data', '回话路径.json');
const EMO_FILE = path.join(__dirname, 'data', '情绪书.json');
/* 四张表：前三张落本文件，第四张「虚幻喜好表」读正本（不复制）。 */
const KINDS = [
  ['emotion', '情绪应对表'],
  ['action', '动作应对表'],
  ['align', '信息对齐表'],
  ['taste', '虚幻喜好表'],
];
const OWN_KINDS = ['emotion', 'action', 'align'];
const KIND_LABEL = Object.fromEntries(KINDS);
const THRESHOLD_FIELDS = ['trigger', 'limit', 'suppress', 'exception', 'visible'];
const DEFAULT = () => ({
  version: 2,
  note: '回话路径：四张表统一入口（情绪应对 / 动作应对 / 信息对齐 / 虚幻喜好）。阈值字段只记录不做。',
  priority: ['specialLike', 'specialHate', 'hateConf', 'likeConf', 'neutral', 'likeGuess', 'hateGuess'],
  exceptions: [],
  thresholds: { mode: '只记录不做', fields: THRESHOLD_FIELDS, items: [] },
  tables: { emotion: [], action: [], align: [] },
  next: 1,
});

function load() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { j = DEFAULT(); }
  const d = DEFAULT();
  j.version = 2;
  j.note = d.note;
  j.priority = Array.isArray(j.priority) && j.priority.length ? j.priority : d.priority;
  j.exceptions = Array.isArray(j.exceptions) ? j.exceptions : [];
  j.thresholds = Object.assign({}, d.thresholds, j.thresholds || {});
  j.thresholds.mode = '只记录不做';
  j.thresholds.fields = THRESHOLD_FIELDS.slice();
  j.thresholds.items = Array.isArray(j.thresholds.items) ? j.thresholds.items : [];
  j.tables = j.tables || {};
  for (const k of OWN_KINDS) if (!Array.isArray(j.tables[k])) j.tables[k] = [];
  j.next = Number(j.next) || 1;
  return j;
}
function save(j) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(j, null, 1), 'utf8');
    return true;
  } catch (e) { console.error('[replypath] 存失败：' + e.message); return false; }
}

/* ===== 情绪应对表的内容：情绪书（同一个功能，纯文字无图，能选更多应对方式）=====
 * 情绪书 6 大类 → 21 分支 → 27 叶；每叶 self（虚幻能说的）+ other（识别用）全列成纯文字。
 * 图的字段 files / q 编号一个都不带出去：她要「前端纯文字，无图」。
 * 运行时合成，不落第二份数据；她选中的才写进 tables.emotion（带 builtinId 引用）。 */
function emoBook() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(EMO_FILE, 'utf8')) || {}; } catch { return { cores: [], rows: [], total: 0 }; }
  const coreName = {};
  for (const c of (j.cores || [])) coreName[c.id] = c.name;
  const byCore = new Map();
  const rows = [];
  for (const b of (j.branches || [])) {
    const cn = coreName[b.core] || '';
    if (!byCore.has(cn)) byCore.set(cn, { name: cn, branches: [] });
    const group = { name: b.name, leaves: [] };
    for (const l of (j.leaves || [])) {
      if (l.branch !== b.id) continue;
      const seen = new Set();
      const says = [];
      for (const [src, arr] of [['self', l.self || []], ['other', l.other || []]]) {
        for (const s of arr) {
          const text = String(s || '').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          const id = 'emobook:' + b.id + ':' + l.name + ':' + text;
          says.push({ id, text, src });
          rows.push({ id, core: cn, branch: b.name, leaf: l.name, text, src });
        }
      }
      group.leaves.push({ name: l.name, says });
    }
    byCore.get(cn).branches.push(group);
  }
  return { cores: Array.from(byCore.values()), rows, total: rows.length };
}
/* 兼容旧调用：纯文字候选（现在是 self + other 全部，不再只给 self） */
function emoOptions() {
  return emoBook().rows.map(r => ({
    id: r.id, name: r.leaf, text: r.text, branch: r.branch, core: r.core,
    builtin: true, readonly: true,
  }));
}

/* ===== 第四张表「虚幻喜好表」：读正本，不落第二份数据 ===== */
function tasteTable() {
  let taste = null;
  try { taste = require('./taste'); } catch { return { label: '虚幻喜好表', kind: 'taste', cols: [], items: [], total: 0 }; }
  const w = taste.mineWords();
  let raw = [];
  try { raw = taste.colsOrdered ? taste.colsOrdered() : []; } catch {}
  const cols = (raw || []).map(c => Array.isArray(c)
    ? { key: c[0], label: c[1] || String(c[0]) }
    : { key: c.key || c[0] || '', label: c.label || c[1] || String(c.key || '') });
  const useCols = cols.length ? cols : Object.keys(w).map(k => ({ key: k, label: k }));
  const items = [];
  for (const c of useCols) {
    for (const word of (w[c.key] || [])) {
      let id = '';
      try { id = tasteid.idOf(word); } catch {}
      let rec = {};
      try { rec = tasteid.get(id) || {}; } catch {}
      items.push({ id, word, sec: c.key, secLabel: c.label, meta: rec.meta || {} });
    }
  }
  return { label: '虚幻喜好表', kind: 'taste', cols: useCols, items, total: items.length };
}

/* 关联偏好 id：只认 tasteid 里已有的 id；给词也行，先转成 id（不凭空造串）。 */
function normTasteIds(p) {
  const out = [];
  const raw = Array.isArray(p.tasteIds) ? p.tasteIds : (p.tasteId ? [p.tasteId] : []);
  for (const x of raw) {
    const id = String(x || '').trim();
    if (!id) continue;
    if (tasteid.get(id)) { if (out.indexOf(id) < 0) out.push(id); continue; }
    const made = tasteid.idOf(id, { create: false });
    if (made && out.indexOf(made) < 0) out.push(made);
  }
  if (p.word) {
    const made = tasteid.idOf(p.word);
    if (made && out.indexOf(made) < 0) out.push(made);
  }
  return out;
}
function rowOf(p, id) {
  const r = {
    id: id, name: String(p.name || '').trim().slice(0, 60),
    text: String(p.text || '').trim().slice(0, 500),
    tasteIds: Array.isArray(p.tasteIds) ? p.tasteIds.slice(0, 20) : [],
    at: Date.now(),
  };
  // 只记录不做：字段原样存，代码不拿它做判定
  for (const f of THRESHOLD_FIELDS) r[f] = String(p[f] == null ? '' : p[f]).trim().slice(0, 200);
  if (p.builtin) { r.builtin = true; r.builtinId = String(p.builtinId || p.id || '').slice(0, 160); }
  return r;
}
function find(j, kind, id) {
  return (j.tables[kind] || []).findIndex(x => String(x.id) === String(id));
}
function view(j, opt) {
  const o = opt || {};
  const book = o.withBook === false ? { cores: [], rows: [], total: 0 } : emoBook();
  const tables = {};
  for (const [k, label] of KINDS) {
    if (k === 'taste') { tables.taste = tasteTable(); continue; }
    const items = (j.tables[k] || []).slice();
    tables[k] = {
      label, kind: k, total: items.length, items,
      book: k === 'emotion' ? book : null,
      bookTotal: k === 'emotion' ? book.total : 0,
      picked: k === 'emotion' ? items.filter(x => x.builtin).length : 0,
    };
  }
  return {
    ok: true, tables, priority: j.priority, exceptions: j.exceptions,
    thresholds: j.thresholds, kinds: KINDS.map(([k, n]) => ({ key: k, label: n })),
  };
}
/* 联动：按偏好 id 反查前三张表里所有引用它的条目（两表词条怎么改都不串）。 */
function lookup(tasteId, kind) {
  const j = load(), id = String(tasteId || '').trim(), out = [];
  for (const k of OWN_KINDS) {
    if (kind && kind !== k) continue;
    for (const r of (j.tables[k] || [])) {
      if ((r.tasteIds || []).indexOf(id) >= 0) out.push(Object.assign({ kind: k, kindLabel: KIND_LABEL[k] }, r));
    }
  }
  return { ok: true, id, total: out.length, items: out };
}
/* 「让虚幻知道情绪之间是怎么应对的」+「和喜好表的联动是有自己偏好的应对」：
 * 命中才返回（0 token 不命中）；挂了当前偏好 id 的条目排前面 = 有自己偏好的应对。
 * 只给内容，不判定该用哪条；阈值字段一概不参与。 */
function retrieve(text, ids) {
  const q = String(text || '').trim();
  if (q.length < 2) return '';
  const set = new Set((ids || []).map(String));
  const j = load();
  const rows = [];
  for (const k of OWN_KINDS) {
    for (const r of (j.tables[k] || [])) {
      const name = String(r.name || '');
      const hay = [name, r.text, (r.tasteIds || []).map(id => (tasteid.get(id) || {}).word || '').join(' ')].join(' ');
      if (hay.indexOf(q) < 0 && !(name && q.indexOf(name) >= 0)) continue;
      const pref = (r.tasteIds || []).some(id => set.has(id)) ? 0 : 1;
      const words = (r.tasteIds || []).map(id => (tasteid.get(id) || {}).word).filter(Boolean);
      rows.push({ pref, line: '【' + KIND_LABEL[k] + (pref === 0 ? '·偏好' : '') + '】'
        + (name ? name + '：' : '') + String(r.text || '')
        + (words.length ? '（关联：' + words.join('、') + '）' : '') });
    }
  }
  if (rows.length < 6) {
    for (const r of emoBook().rows) {
      if (q.indexOf(r.leaf) < 0 && q.indexOf(r.branch) < 0 && q.indexOf(r.core) < 0
        && r.text.indexOf(q) < 0 && q.indexOf(r.text) < 0) continue;
      rows.push({ pref: 1, line: '【情绪应对·' + r.core + '/' + r.leaf + '】' + r.text });
      if (rows.length >= 12) break;
    }
  }
  rows.sort((a, b) => a.pref - b.pref);
  return rows.slice(0, 6).map(x => x.line).join('\n');
}
/* 冲突优先级 + 例外项目：只排序 / 只返回，不接进回复选路。 */
function resolve(ids) {
  const j = load();
  const rank = {};
  j.priority.forEach((k, i) => { rank[k] = i; });
  const rows = (ids || []).map(id => {
    const it = tasteid.get(id) || {};
    const ex = j.exceptions.find(x => String(x.id) === String(id));
    return { id, sec: it.sec || '', word: it.word || '', rank: ex ? -1 : (rank[it.sec] == null ? 99 : rank[it.sec]), exception: ex || null };
  });
  rows.sort((a, b) => a.rank - b.rank);
  return { ok: true, priority: j.priority, items: rows };
}

function api(action, payload) {
  const p = payload || {};
  const j = load();
  switch (action) {
    case 'list': tasteid.sync(); return view(j, p);   // 打开入口时补齐两份表的唯一 id
    case 'view': return view(j, p);
    case 'book': { const b = emoBook(); return { ok: true, cores: b.cores, total: b.total, items: b.rows }; }
    case 'options': { const a = emoOptions(); return { ok: true, total: a.length, items: a }; }
    case 'lookup': return lookup(p.id || p.tasteId, p.kind);
    case 'resolve': return resolve(p.ids || (p.id ? [p.id] : []));
    case 'retrieve': return { ok: true, block: retrieve(p.text, p.ids) };
    /* 从情绪书选一条/多条进「情绪应对表」（同一个功能，选中才落盘，带引用不复制正文）。 */
    case 'pick': {
      const ids = Array.isArray(p.ids) ? p.ids : (p.id ? [p.id] : []);
      if (!ids.length) return { error: '先选说法' };
      const tids = normTasteIds(p);
      const book = new Map(emoBook().rows.map(r => [r.id, r]));
      let n = 0;
      for (const id of ids) {
        const b = book.get(String(id));
        if (!b) continue;
        if (j.tables.emotion.some(x => String(x.builtinId) === String(b.id))) continue;
        j.tables.emotion.push(rowOf({
          name: b.leaf, text: b.text, tasteIds: tids,
          builtin: true, builtinId: b.id,
        }, 'rp' + j.next++));
        n++;
      }
      return save(j) ? { ok: true, added: n, total: j.tables.emotion.length } : { error: '没写进去' };
    }
    case 'add': {
      const kind = String(p.kind || '');
      if (OWN_KINDS.indexOf(kind) < 0) return { error: '没有这张表：' + kind };
      const p2 = Object.assign({}, p, { tasteIds: normTasteIds(p) });
      const id = 'rp' + j.next++;
      j.tables[kind].push(rowOf(p2, id));
      return save(j) ? { ok: true, id, kind } : { error: '没写进去' };
    }
    case 'save': {
      const kind = String(p.kind || '');
      if (OWN_KINDS.indexOf(kind) < 0) return { error: '没有这张表：' + kind };
      const i = find(j, kind, p.id);
      if (i < 0) return { error: '没找到这一条：' + p.id };
      const p2 = Object.assign({}, j.tables[kind][i], p, { tasteIds: normTasteIds(p) });
      j.tables[kind][i] = rowOf(p2, p.id);
      return save(j) ? { ok: true, id: p.id } : { error: '没写进去' };
    }
    case 'del': {
      const kind = String(p.kind || '');
      if (OWN_KINDS.indexOf(kind) < 0) return { error: '没有这张表：' + kind };
      const i = find(j, kind, p.id);
      if (i < 0) return { error: '没找到这一条：' + p.id };
      j.tables[kind].splice(i, 1);
      return save(j) ? { ok: true, id: p.id } : { error: '没写进去' };
    }
    /* 第四张表「虚幻喜好表」：写一律转发到正本 / tasteid，不在本文件存第二份。 */
    case 'taste-add': return tastecopy.api('add', { which: 'mine', words: [String(p.word || '').trim()], sec: p.sec || 'likeConf', by: 'master' });
    case 'taste-del': return tastecopy.api('del', { which: 'mine', words: [String(p.word || '').trim()], by: 'master' });
    case 'taste-meta': return tasteid.api('meta', p);
    case 'priority': {
      if (!Array.isArray(p.priority) || !p.priority.length) return { error: '优先级不能为空' };
      j.priority = p.priority.map(String);
      return save(j) ? { ok: true, priority: j.priority } : { error: '没写进去' };
    }
    case 'exception': {
      const id = String(p.id || '').trim();
      if (!id) return { error: '要指定偏好 id' };
      if (p.remove) j.exceptions = j.exceptions.filter(x => String(x.id) !== id);
      else {
        const old = j.exceptions.find(x => String(x.id) === id);
        const rec = { id, note: String(p.note || '').trim().slice(0, 200), at: Date.now() };
        if (old) Object.assign(old, rec); else j.exceptions.push(rec);
      }
      return save(j) ? { ok: true, exceptions: j.exceptions } : { error: '没写进去' };
    }
    /* 阈值只记录不做：存进去，不产生任何行为。 */
    case 'threshold': {
      const text = String(p.text || '').trim().slice(0, 300);
      if (!text) return { error: '内容为空' };
      j.thresholds.items.push({ id: 'th' + j.next++, text, kind: String(p.kind || ''), at: Date.now() });
      return save(j) ? { ok: true, items: j.thresholds.items, mode: '只记录不做' } : { error: '没写进去' };
    }
    case 'diff': return tastecopy.diff();
    case 'template': return { ok: true, id: p.id, template: tasteid.templateOf(p.id) };
    default: return { error: '没这个动作：' + action };
  }
}

module.exports = { api, lookup, resolve, retrieve, emoOptions, emoBook, view, KINDS, OWN_KINDS, KIND_LABEL, THRESHOLD_FIELDS, FILE };
