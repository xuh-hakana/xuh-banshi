/*
 * src/learn/kb.js —— 「每个人自己的」知识库
 *
 * 这是干什么的：这个人说过的事实、偏好、经验，按人分开存，命中才读。
 * 和全局攻略（guides.js）不是一个东西：攻略是「谁知道都能用」，
 * 这里是「只跟这个人有关」，别人一条都看不到（按 pid 分目录，物理隔离）。
 *
 * 存哪：users/<pid>/kb/<YYYY-MM>.json —— 按月一份，每条带时间戳。
 * 为什么不一天一份：一天十几个文件，检索要开十几个文件；按月一份刚好。
 *
 * 检索：走 search.js 的混合打分。装了 Ollama 就是关键词 + 向量 RRF 融合，
 * 没装就只剩关键词（照样能用，只是同义说法会漏）。
 */
const path = require('path');
const S = require('./schema');
const store = require('./store');
const search = require('./search');

const KIND = { fact: '事实', pref: '偏好', exp: '经验' };

// 这是干什么的：问 people 有没有这个人。不问目录——目录写过东西才存在，
// 拿目录判断会让「第一次给某人记知识」直接失败。
function exists(pid) {
  try { return !!require('../people').get(pid); } catch (e) { return false; }
}

function kbDir(pid) { return path.join(store.userDir(pid), S.FILES.kbDir); }
function monthFile(pid, month) { return path.join(kbDir(pid), month + '.json'); }

function months(pid) {
  try {
    return require('fs').readdirSync(kbDir(pid))
      .filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
  } catch (e) { return []; }
}

function readMonth(pid, month) {
  const j = store.readJSON(monthFile(pid, month), { items: [] });
  return Array.isArray(j.items) ? j.items : [];
}
function writeMonth(pid, month, items) {
  return store.writeJSON(monthFile(pid, month), { month, items });
}

/* 全部条目，最近的排前面 */
function all(pid) {
  const out = [];
  months(pid).forEach(m => readMonth(pid, m).forEach(it => out.push(it)));
  return out
    .map(x => Object.assign({}, x, { day: x.day || store.localDate(x.ts) }))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
}

/* ---------- 写入 ---------- */
/* item: {text, kind: fact|pref|exp, tags: [], evidence: {ref, quote}} */
function add(pid, item) {
  const o = item || {};
  const text = String(o.text || '').trim();
  if (!text) return { error: '内容是空的' };
  if (!exists(pid)) return { error: '没有这个人：' + pid };
  const ts = store.iso();
  const month = store.monthKey();
  const items = readMonth(pid, month);
  // 同一句话不重复记（人一天能把同一件事说三遍）
  const same = items.find(x => x.text === text);
  if (same) return { ok: true, duplicate: true, id: same.id };
  const row = {
    id: store.uid('kb'),
    ts,
    day: store.dayKey(),          // 本地日期，显示用（ts 是 UTC，凌晨会显示成前一天）
    text: text.slice(0, S.LIMITS.kbTextChars),
    kind: KIND[o.kind] ? o.kind : 'fact',
    tags: (Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(/[,，\s]+/))
      .map(s => String(s).trim()).filter(Boolean).slice(0, 6),
    evidence: o.evidence ? {
      ref: String(o.evidence.ref || '').slice(0, 120),
      quote: String(o.evidence.quote || '').slice(0, 200),
    } : null,
  };
  items.push(row);
  writeMonth(pid, month, items);
  return { ok: true, duplicate: false, id: row.id, month };
}

function del(pid, id) {
  const m = months(pid);
  for (const month of m) {
    const items = readMonth(pid, month);
    const i = items.findIndex(x => x.id === id);
    if (i < 0) continue;
    const [gone] = items.splice(i, 1);
    writeMonth(pid, month, items);
    return { ok: true, removed: gone };
  }
  return { error: '没这条：' + id };
}

/* ---------- 检索 ---------- */
/* 返回 [{item, score, how}]；低于阈值不给——宁可说没查到，也不硬凑。
 * how='kw' 说明这次只有字面命中（没装 Ollama 或没算出向量），how='rrf' 是两路融合。
 *
 * 2026-11-10 修：原来只给查询算向量、文档一侧从来没算过，
 * 结果是 `docs.some(d=>d.vec)` 永远 false —— 向量一路等于摆设，装了 Ollama 也不生效。
 * 现在：先关键词取宽一点（12 条）当候选，只对候选算向量并回存，下次不用重算。 */
async function find(pid, q, opts) {
  const o = opts || {};
  const items = all(pid);
  const text = String(q || '').trim();
  if (!items.length || !text) return [];
  const want = Number(o.n) > 0 ? Number(o.n) : 5;
  const docs = items.map(x => ({ text: (x.text || '') + ' ' + (x.tags || []).join(' '), vec: x.vec || null }));

  const kwHits = await search.search(docs, text, { n: Math.max(want, 12), useVec: false });
  const kwOnly = () => kwHits.slice(0, want).map(h => ({ item: items[h.i], score: h.score, how: 'kw' }));
  if (o.useVec === false || !kwHits.length) return kwOnly();

  const qv = await search.embed(text);
  if (!qv) return kwOnly();                       // 没装 Ollama / 这 60 秒内冷却中

  const vecScore = {};
  const dirty = {};
  for (const h of kwHits) {
    const it = items[h.i];
    if (!it.vec) {
      const v = await search.embed(docs[h.i].text);
      if (v) { it.vec = v; dirty[it.id] = it; }
    }
    if (it.vec) vecScore[h.i] = search.cosine(qv, it.vec);
  }
  if (!Object.keys(vecScore).length) return kwOnly();

  const kwIdx = kwHits.map(h => h.i);
  const vecIdx = Object.keys(vecScore).map(Number).sort((a, b) => vecScore[b] - vecScore[a]);
  const fused = search.rrf([kwIdx, vecIdx]).slice(0, want);

  // 算出来的向量存回去，下次不用重算
  if (Object.keys(dirty).length) {
    months(pid).forEach(month => {
      const arr = readMonth(pid, month);
      let changed = false;
      arr.forEach((x, i) => { if (dirty[x.id]) { arr[i] = dirty[x.id]; changed = true; } });
      if (changed) writeMonth(pid, month, arr);
    });
  }
  return fused.map(x => ({ item: items[x.i], score: x.score, how: 'rrf' }));
}

/* 注入块：命中才给，最多 3 条，超过 500 字就砍 */
async function warmBlock(pid, q, nick) {
  const hits = await find(pid, q, { n: 3 });
  if (!hits.length) return '';
  const lines = hits.map(h => '- ' + h.item.text + (h.item.day ? '（' + h.item.day + '）' : ''));
  const body = '## 关于' + (String(nick || '').trim() || '这个人') + '，你自己记着的\n' + lines.join('\n');
  return body.length <= S.LIMITS.warmChars ? body : body.slice(0, S.LIMITS.warmChars);
}

/* ---------- 导出 ---------- */
function exportJSON(pid) {
  return {
    pid: String(pid),
    exportedAt: store.iso(),
    count: all(pid).length,
    items: all(pid),
  };
}

function counts(pid) {
  const items = all(pid);
  const by = { fact: 0, pref: 0, exp: 0 };
  items.forEach(x => { by[x.kind] = (by[x.kind] || 0) + 1; });
  return { total: items.length, by, months: months(pid) };
}

module.exports = { KIND, add, del, all, find, warmBlock, exportJSON, counts, months, kbDir };
