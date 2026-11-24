/*
 * info-scan.js — 「信息识别」四个功能的统一引擎（2026-11-21 主人定）
 *
 * 四个功能：言外之意 / 信息量 / 梗含量 / 自我表达。左栏「信息识别」分组，各占一页。
 * 结构全同：树状 groups[]（按情绪分组，emotion=any 永远生效）+ 判定时现读联动。
 *
 * 联动口径（她 05:46 定）：
 *   - 情绪 = 方式1：树节点存 emotion 分组，按当前判出的情绪取对应组 + any 组。
 *   - 词典 / 约定 = 方式2：不存 id（存不了也没意义），判定时现读命中 ——
 *     信息量/自我表达现读通用词典+约定；梗含量现读梗词典+约定；言外之意按她原话只走情绪组。
 *
 * 不建双份：四个功能共用这里一套读写/扫描，core.js 的 readIntents/addIntents 等是薄封装。
 * 落点：src/data/{intents,infoamount,memecontent,selfexpress}.json
 */
const fs = require('fs');
const path = require('path');
const { related } = require('./match');   // 相关性判据只有一份（和 coord 共用）

const ROOT = __dirname;
const SPECS = {
  intents:     { file: 'intents.json',     label: '言外之意', reads: [] },
  infoamount:  { file: 'infoamount.json',  label: '信息量',   reads: ['dict', 'pact'] },
  memecontent: { file: 'memecontent.json', label: '梗含量',   reads: ['meme', 'pact'] },
  selfexpress: { file: 'selfexpress.json', label: '自我表达', reads: ['dict', 'pact'] },
  logic:       { file: 'logic.json',       label: '逻辑',     reads: ['dict', 'pact'] },
};
const DEFAULT = () => ({ version: 1, note: '', emotionLink: '情绪书', readLink: [], groups: [], stars: [], starNext: 1, next: 1 });
const _cache = {};   // key -> { at, data }

function fp(key) {
  const s = SPECS[key];
  return s ? path.join(ROOT, 'data', s.file) : null;
}
function read(key) {
  const p = fp(key);
  if (!p) return DEFAULT();
  try {
    const st = fs.statSync(p).mtimeMs;
    if (_cache[key] && _cache[key].at === st) return _cache[key].data;
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    const d = DEFAULT();
    j.version = d.version;
    j.emotionLink = d.emotionLink;
    j.readLink = Array.isArray(j.readLink) ? j.readLink : (SPECS[key].reads || []);
    if (!Array.isArray(j.groups)) j.groups = [];
    if (!Array.isArray(j.stars)) j.stars = [];
    j.starNext = Number(j.starNext) || 1;
    j.next = Number(j.next) || 1;
    _cache[key] = { at: st, data: j };
    return j;
  } catch { return DEFAULT(); }
}
function save(key, j) {
  const p = fp(key);
  if (!p) return false;
  try {
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
    delete _cache[key];
    return true;
  } catch { return false; }
}
function add(key, items) {
  const j = read(key);
  const added = [];
  for (const x of (Array.isArray(items) ? items : [items])) {
    const phrase = String((x && x.phrase) || '').trim().slice(0, 120);
    const meaning = String((x && x.meaning) || '').trim().slice(0, 300);
    if (!phrase || !meaning) continue;
    const emo = String((x && x.emotion) || 'any').trim() || 'any';
    let g = j.groups.find(g => String(g.emotion || 'any') === emo);
    if (!g) {
      g = { id: 'g_' + emo, name: emo === 'any' ? '不受情绪影响' : emo, emotion: emo, items: [] };
      j.groups.push(g);
    }
    const it = { id: 'i' + (j.next++), phrase, meaning, t: new Date().toISOString() };
    g.items.push(it);
    added.push(Object.assign({ emotion: emo }, it));
  }
  if (added.length) save(key, j);
  return added;
}
function del(key, id, gidx, iidx) {
  const j = read(key);
  if (id != null) {
    for (const g of j.groups) {
      const k = (g.items || []).findIndex(it => it.id === id);
      if (k >= 0) { g.items.splice(k, 1); return save(key, j); }
    }
    return false;
  }
  const g = j.groups[Number(gidx)];
  if (!g || !g.items || g.items[Number(iidx)] == null) return false;
  g.items.splice(Number(iidx), 1);
  return save(key, j);
}

/* ===== 星标样本（主人 2026-11-21 的话挑明）：星标里虚幻自己说的话，
 * 证明她在这几个方面「到位了」——按勾选的方面各存一条正面样本，面板可见、可删。
 * 只存正文摘要（≤120 字）+ 出处，不复制整条聊天记录；正文池仍是 chat-stars，不建第二份。 */
const STAR_MAX = 300;   // 每个功能最多留 300 条，超了丢最老的
function addStar(key, x) {
  const j = read(key);
  const it = x || {};
  const text = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text) return null;
  const dup = j.stars.find(s => s.text === text && String(s.scope || '') === String(it.scope || ''));
  if (dup) return dup;
  const row = {
    id: 's' + (j.starNext++),
    text,
    note: String(it.note || '').slice(0, 200),
    scope: String(it.scope || ''),
    nick: String(it.nick || '虚幻'),
    t: it.t || new Date().toISOString(),
  };
  j.stars.push(row);
  if (j.stars.length > STAR_MAX) j.stars = j.stars.slice(-STAR_MAX);
  save(key, j);
  return row;
}
function delStar(key, id) {
  const j = read(key);
  const i = j.stars.findIndex(s => String(s.id) === String(id));
  if (i < 0) return false;
  j.stars.splice(i, 1);
  return save(key, j);
}
/* 汇总（主人 2026-11-21：「逻辑要整合这页所有的，以及以后新增的」）：
 * 逻辑页不另存一份别人的内容——按 SPECS 遍历，把其它功能的规则捞出来给「逻辑」用。
 * 以后在 SPECS 里加一个 key，这里自动带上，不用改调用方。exclude=不要汇总的 key（默认就是 logic 自己）。 */
function digest(emo, exclude) {
  const out = [];
  for (const k of Object.keys(SPECS)) {
    if (k === exclude) continue;
    const j = read(k);
    const rules = rulesOf(k, emo);
    out.push({
      key: k,
      label: SPECS[k].label,
      total: (j.groups || []).reduce((s, g) => s + ((g.items || []).length), 0),
      groups: (j.groups || []).length,
      stars: (j.stars || []).length,
      rules,
    });
  }
  return out;
}

/* 最新 n 条星标样本（新的在前）。 */
function starsOf(key, n) {
  const j = read(key);
  return j.stars.slice().reverse().slice(0, Math.max(1, Number(n) || 10));
}

/* 取这个功能的规则条目（按当前情绪 + any 组）： [{phrase, meaning, emotion}] */
function rulesOf(key, emo) {
  const j = read(key);
  const e = String(emo || '').trim();
  const out = [];
  for (const g of j.groups) {
    const ge = String(g.emotion || 'any');
    if (ge !== 'any' && !(e && ge === e)) continue;
    for (const it of (g.items || [])) out.push({ phrase: it.phrase, meaning: it.meaning, emotion: ge });
  }
  return out;
}

/* 现读联动：dict=通用词典 / meme=梗词典 / pact=约定。返回可读文本行（无命中返回 []）。
 * 注入方 core.js 把 deps 传进来（避免这里 require 造成循环依赖）。 */
function liveHits(key, text, deps) {
  const reads = (SPECS[key] && SPECS[key].reads) || [];
  const out = [];
  const t = String(text || '');
  if (t.length < 2) return out;
  try {
    if (reads.includes('dict') && deps && deps.dictGloss) {
      const hits = deps.dictGloss(t) || [];
      for (const h of hits.slice(0, 3)) out.push('词典「' + h.title + '」：' + h.meaning);
    }
    if (reads.includes('meme') && deps && deps.glossaryHit) {
      const hits = deps.glossaryHit(t) || [];
      for (const h of hits.slice(0, 3)) out.push('梗「' + h.title + '」：' + h.meaning);
    }
    if (reads.includes('pact') && deps && deps.pactHit && deps.pactsFor) {
      const hs = [];
      for (const p of (deps.pactsFor() || [])) {
        const w = deps.pactHit(p, t);
        if (!w) continue;
        // 2026-11-21 修两个错：①注入的是「命中到的触发词」w，不是约定本体 ——
        // 提示词里出现「约定：他们为什么打架？」，模型既不知道要干什么还被引偏；
        // ②pactHit 的松匹配（4 字共同）会把无关约定拽进来，所以再用实词重合卡一道。
        const body = String(p.text || w);
        if (!related(t, body, w)) continue;
        if (hs.indexOf(body) >= 0) continue;
        hs.push(body.slice(0, 80));
      }
      if (hs.length) out.push('约定：' + hs.slice(0, 2).join('；'));
    }
  } catch { /* 现读失败不当误，联动是辅助 */ }
  return out;
}

module.exports = { SPECS, KEYS: Object.keys(SPECS), read, save, add, del, rulesOf, liveHits, digest, addStar, delStar, starsOf };
