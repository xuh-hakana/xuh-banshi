/* ===========================================================================
 * judge.js — 虚幻「所有发言」的统一判定内核（2026-11-19 主人令）
 *
 * 她原话：「所有虚幻发的都要星标/标错，不是新功能，是你漏做的功能。还有判情绪、漏判
 *   等等，都是虚幻所有发言都管」「星标/标错等确实不通用。但是算包含，而不是独立。
 *   按通用到专用排：全私聊，QQ群，全评论（含QQ空间评论、b站单层评论等）。
 *   QQ空间评论，b站视频/图文评论，全动态（含b站动态）。b站动态，日记。」
 * 又纠正：「错了，我一行一句」「不是要你原话复制，这是要你等下执行的，你必须理清楚」。
 *
 * 【本案的关键：包含 ≠ 独立，也 ≠ 画树】
 *   scope 是 8 个**平铺**标签，一行一句。通用层（全评论 / 全动态）是**查询视图**：
 *   查它时把子 scope 的记录聚合过来；写记录时只挂最贴切的那个专用 scope。
 *   数据只落一份，不复制、不建父子层级、不为通用层另存一份。
 *
 * 【不造平行池】
 *   星标 → core.starsAdd（chat-stars.json，正面样本池）
 *   标错 → core.addIssue（ai-feedback.jsonl 待修复池）
 *   情绪 → emotion-tree.writeChatEmotion / record
 *   本文件只多存一张「判定台账」judge-verdicts.jsonl：记「这条被谁判成什么」，
 *   用途是①防重复判 ②面板回显。正文不进台账（正文在各自的源记录里）。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'judge-verdicts.jsonl');

/* 8 个平铺 scope（一字不改照她的一行一句）。 */
const SCOPES = [
  '全私聊', 'QQ群', '全评论', 'QQ空间评论',
  'b站视频/图文评论', '全动态', 'b站动态', '日记',
];

/* 通用 scope → 展开成哪些专用 scope（查询时用；写时永远落专用）。
 * 「含…」是她原话自带的说明，不是我加的树。这里只做集合展开，不排序、不嵌套。 */
const EXPAND = {
  '全评论': ['QQ空间评论', 'b站视频/图文评论'],
  '全动态': ['b站动态', '日记'],
};
function expand(scope) {
  const s = String(scope || '');
  return EXPAND[s] ? EXPAND[s].slice() : [s];
}
function isView(scope) { return !!EXPAND[String(scope || '')]; }

function readAll() {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.id) out.push(j); } catch {}
  }
  return out;
}

function verdictKey(scope, id) { return String(scope || '') + ':' + String(id || ''); }

/* 找某条的判定。view scope（全评论/全动态）会连带查子 scope —— 因为判定只落在专用层。 */
function find(scope, id) {
  const scopes = expand(scope);
  return readAll().filter(v => scopes.indexOf(v.scope) >= 0 && String(v.id) === String(id));
}

/* 查某 scope 下的判定（view 自动聚合子 scope）。n 条，新的在前。 */
function list(scope, n) {
  const scopes = expand(scope);
  let rows = readAll();
  if (scope) rows = rows.filter(v => scopes.indexOf(v.scope) >= 0);
  rows.reverse();
  return rows.slice(0, Math.max(1, Number(n) || 200));
}

/* 落一条判定台账（append-only，同 scope:id 不重复）。 */
function record(entry) {
  const e = entry || {};
  const scope = String(e.scope || '');
  if (SCOPES.indexOf(scope) < 0) return { ok: false, error: '不认识的 scope：' + scope };
  if (isView(scope)) return { ok: false, error: '「' + scope + '」是聚合视图，判定要落在具体来源上' };
  const id = String(e.id || '');
  if (!id) return { ok: false, error: '缺 id' };
  const key = verdictKey(scope, id);
  const old = readAll().filter(v => v.key === key)[0];
  if (old) return { ok: false, error: '这条已经判过了（' + (old.verdict === 'star' ? '星标' : '标错') + '）', dup: true, verdict: old };
  const row = {
    key, id, scope,
    verdict: e.verdict === 'star' ? 'star' : 'issue',
    note: String(e.note || '').slice(0, 300),
    by: String(e.by || 'manual'),
    src: String(e.src || ''),
    t: e.t || new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) { return { ok: false, error: '台账写失败：' + err.message }; }
  return { ok: true, verdict: row };
}

/* 统一判定入口：按 verdict 把同一条同时写进现有池 + 台账。
 * item = { id, scope, text, t, nick, prev, prevNick, src, note }
 * verdict = 'star' | 'issue'；emotions 可选（多情绪数组）。 */
function judge(item, verdict, note, by) {
  const it = item || {};
  const scope = String(it.scope || '');
  if (isView(scope)) return { ok: false, error: '「' + scope + '」是聚合视图，不能直接在它上面判定' };
  // 先查台账：判过了直接退，绝不重复写池（否则标错会往待修复塞脏数据）
  const already = find(scope, it.id)[0];
  if (already) return { ok: false, error: '这条已经判过了（' + (already.verdict === 'star' ? '星标' : '标错') + '）', dup: true, verdict: already };
  const text = String(it.text || '').trim();
  if (!text) return { ok: false, error: '没有正文' };
  const why = String(note || it.note || '').trim();
  const who = String(it.nick || '虚幻');
  const src = String(it.src || scope);

  let poolResult;
  if (verdict === 'issue') {
    // 标错 → 待修复池（和聊天记录标错同一个池）
    const core = require('./core');
    core.addIssue('待修复', text, {
      note: scope + (why ? '：' + why : ' 标错'),
      ctx: it.prev ? [{ nick: String(it.prevNick || ''), text: String(it.prev).slice(0, 120) }] : undefined,
    });
    poolResult = 'issue';
  } else {
    // 星标 → chat-stars 正面样本池
    const core = require('./core');
    poolResult = core.starsAdd({
      t: it.t || new Date().toISOString(),
      scope, nick: who, text,
      prev: it.prev ? String(it.prev).slice(0, 100) : '',
      prevNick: it.prevNick || '',
      src, by: 'manual',
      note: why || (scope + ' 星标'),
      ctx: it.ctx,
    });
  }

  // 情绪：可选的多情绪/判错修正（不覆盖正文池）
  let emoResult = null;
  if (Array.isArray(it.emotions) && it.emotions.length) {
    const et = require('./emotion-tree');
    et.writeChatEmotion(String(it.id), it.emotions[0].leaf || it.emotions[0], it.emotions[0].word || '', 'review');
    emoResult = it.emotions;
  }

  const v = record({
    id: it.id, scope, verdict: verdict === 'issue' ? 'issue' : 'star',
    note: why, by: by || 'manual', src,
  });
  return { ok: v.ok, error: v.error, pool: poolResult, emotions: emoResult, verdict: v.verdict };
}

module.exports = { FILE, SCOPES, EXPAND, expand, isView, readAll, find, list, record, judge, verdictKey };
