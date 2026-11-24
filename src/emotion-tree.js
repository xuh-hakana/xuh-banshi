/* ===== 情绪书（主人 2026-11-07 定）=====
 * 一棵树：6 大类 → 21 分支 → 叶（叶名 = 表情图族名）。
 * 每个叶两列词：self = 虚幻能说的话（输出用，按顺序挑），other = 只能识别不会说的话。
 *   主人原话：「别人词永远比虚幻词多，所以不要重复写，额外增加即可」
 *   → 判定别人时用 self ∪ other；输出只取 self。
 * 判定分两类（主人 2026-11-07 定：「大部分情绪词/语气词，都是句子首/句子末/单独」）：
 *   A 多字情绪词 → 句子里任何位置都认
 *   B 语气词/单字/数字/叠字 → 只认句首、句末、整句只有它（左右都要是边界）
 * 零 token、零模型调用，纯本地字符串匹配。
 */
const fs = require('fs');
const path = require('path');

const BOOK_PATH = path.join(__dirname, 'data', '情绪书.json');
const REC_PATH = path.join(__dirname, 'data', '情绪记录.jsonl');
/* 聊天记录 ↔ 情绪 的稳定映射（主人 2026-11-07 定：聊天记录里能直接改情绪、能补漏判）。
 * 按 chatKey（= core.starsKey(t,nick,text)，和星标同一套）存，换机/重读都稳定。
 * 结构：{ [chatKey]: { leaf, word, source, t } }
 *   source: 'auto'（扫出来的/机器人判的）| 'user'（主人手改）| 'review'（从 auto 改成别的叶 = 判错） */
const CHAT_EMO_PATH = path.join(__dirname, 'data', 'chat-emotion.json');

/* 边界字符：标点、空白、语气尾巴。B 类词左右必须撞到这些东西（或撞到句子头尾）才算。 */
const BOUND = '，。！？、；：,.!?;:~～…—·「」『』（）()【】[]{}<>《》"\'“”‘’ \t\n';
const TAIL = '啊呀哦呢吧嘛啦喵噢诶嘿咯嘞哟诶欸诶';

let _book = null, _mt = 0, _idx = null;

function empty() {
  return { version: 1, cores: [], branches: [], leaves: [], replies: [], ratio: {} };
}

/* 读文件，mtime 变了才重读（面板/手改都即时生效） */
function load() {
  let st = 0;
  try { st = fs.statSync(BOOK_PATH).mtimeMs; } catch { return _book || empty(); }
  if (_book && st === _mt) return _book;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(BOOK_PATH, 'utf8')); }
  catch (e) {
    console.error('[情绪书] 读不出来，先按空树跑：' + e.message);
    return _book || empty();
  }
  _book = Object.assign(empty(), j || {});
  ['cores', 'branches', 'leaves', 'replies'].forEach(k => { if (!Array.isArray(_book[k])) _book[k] = []; });
  _book.branches.forEach(b => { b.id = String(b.id || '').trim().toUpperCase(); });
  _book.leaves = _book.leaves.filter(x => x && x.name);
  _mt = st;
  _idx = null;
  return _book;
}

/* 建索引：词 → 叶。self/other 合并，但记下来源（输出时只要 self） */
function index() {
  if (_idx) return _idx;
  const bk = load();
  const brOf = {};
  bk.branches.forEach(b => { brOf[b.id] = b; });
  const list = [];
  const byWord = new Map();
  for (const lf of bk.leaves) {
    const br = brOf[lf.branch] || {};
    const self = (lf.self || []).map(s => String(s)).filter(Boolean);
    const other = (lf.other || []).map(s => String(s)).filter(Boolean);
    const node = {
      name: lf.name,
      branch: lf.branch || '',
      branchName: br.name || '',
      core: br.core || '',
      files: Array.isArray(lf.files) ? lf.files : (lf.files ? [lf.files] : []),
      priority: Number(lf.priority) || 5,
      self, other,
      replies: Array.isArray(lf.replies) ? lf.replies : [],
      leaf: lf,
      all: self.concat(other),
    };
    list.push(node);
    for (const w of node.all) {
      const k = w;
      if (!byWord.has(k)) byWord.set(k, []);
      byWord.get(k).push(node);
    }
  }
  _idx = { nodes: list, byWord, brOf };
  return _idx;
}

/* 词是 A 类还是 B 类：A = 多字且有实义；B = 单字/纯数字/叠字/语气词 */
function isB(w) {
  const s = String(w);
  if (s.length === 1) return true;
  if (/^\d+$/.test(s)) return true;            // 6 / 666
  if (/^(.)\1+$/.test(s)) return true;         // 哈哈哈 / 呜呜
  return false;
}

/* 位置判定（只对 B 类）：左边是句子头或标点/空白，右边是句子尾或标点/空白/语气尾巴 */
function posOK(text, w, at) {
  const end = at + w.length;
  const rep = /^(.)\1+$/.test(w);                 // 叠字：哈哈哈 / 呜呜
  const leftCh = at > 0 ? text[at - 1] : '';
  const rightCh = text[end] || '';
  const left = at === 0 || BOUND.indexOf(leftCh) >= 0 || (rep && leftCh === w[0]);
  const right = end >= text.length || BOUND.indexOf(rightCh) >= 0
    || TAIL.indexOf(rightCh) >= 0 || (rep && rightCh === w[w.length - 1]);
  return left && right;
}

/* 标点归一（主人 2026-11-07 定）：
 *   「不要。。。/不要.../不要、、、」是同一个意思 → 都归一成「…」（欲言又止）
 *   「不要，，，/不要,,,」是另一个意思 → 都归一成「，」（顿一下，不是欲言又止）
 * 所以省略号族和逗号族要分开归一，不能一起抹掉。 */
function normPunct(s) {
  return String(s)
    .replace(/(?:。{2,}|\.{2,}|…+|·{2,}|、{2,}|⋯+|﹏{2,})/g, '…')
    .replace(/(?:，{2,}|,{2,})/g, '，');
}
const HAS_PUNCT = /[…，]/;

/* 标点归一：去掉句号/省略号后还能匹配（「不要…」→「不要」），
 * 但只在纯文字词上用；带省略号/逗号的词必须按归一后的原文精确匹配，
 * 否则「不要，，，」会被当成「不要…」。 */
function relax(text) {
  return String(text).replace(/[。．.、，,~～…—\s]+/g, '');
}

/* 判一句。返回 { best, hits }。best 可能为 null（判不出）。
 * opt.who = 'self' | 'other'（默认 other = 别人说话，用并集）
 * opt.minScore 默认 1 */
function judge(text, opt) {
  const o = opt || {};
  const raw = String(text || '');
  if (!raw.trim()) return { best: null, hits: [] };
  const ix = index();
  const rawN = normPunct(raw);          // 标点归一后用（省略号/逗号分族）
  const flat = relax(raw);
  const hits = [];

  for (const [w, nodes] of ix.byWord) {
    const b = isB(w);
    let at = raw.indexOf(w);
    let ok = false, pos = 'any';
    if (HAS_PUNCT.test(w)) {
      /* 带省略号/逗号的词：只认归一后的原文，绝不走 relax —— 否则
       * 「不要，，，」会被「不要…」吃掉，「不要。。。」也会被「不要」吃掉。 */
      ok = rawN.indexOf(w) >= 0;
      pos = 'punct';
    } else if (b) {
      while (at >= 0) { if (posOK(raw, w, at)) { ok = true; pos = 'edge'; break; } at = raw.indexOf(w, at + 1); }
    } else {
      ok = at >= 0;
      if (!ok && flat !== raw) { ok = flat.indexOf(w) >= 0; pos = 'relaxed'; }
    }
    if (!ok) continue;
    const score = w.length * 10 + (b ? (pos === 'edge' ? 6 : 0) : 4) + (pos === 'punct' ? 8 : 0);
    for (const n of nodes) hits.push({ w, node: n, score, pos, b });
  }

  hits.sort((a, b2) => b2.score - a.score || b2.w.length - a.w.length);
  /* 同一句里多命中：取分最高的叶；同分时优先 self 列（她自己写的更准） */
  let best = hits[0] || null;
  if (best && hits.length > 1) {
    const same = hits.filter(h => h.score === best.score);
    const selfOne = same.find(h => h.node.self.indexOf(h.w) >= 0);
    if (selfOne) best = selfOne;
  }
  if (best && best.score < (o.minScore || 1)) best = null;

  /* 多情绪（2026-11-19 主人令：「字多的场景，情绪会有丰富变化。功能本身变成多情绪的」）。
   * 长文本里依次出现的几种情绪都记下来，按命中分排序、按叶去重；best 仍保留第一，
   * 老调用方（coreOf / record 老路径 / 面板）取 best 不受影响。
   * 只有文本较长（>=40 字）或有多个不同叶命中时才展开，短句还是单情绪，避免噪音。 */
  let emotions = [];
  if (raw.length >= 40 || hits.length > 1) {
    const seen = new Set();
    for (const h of hits) {
      const name = h.node.name;
      if (seen.has(name)) continue;
      seen.add(name);
      emotions.push({ core: h.node.core, branch: h.node.branch, leaf: name, word: h.w, score: h.score });
      if (emotions.length >= 6) break;
    }
    if (emotions.length < 2) emotions = [];   // 只有一种就不算「丰富变化」，保持单情绪
  }
  return { best, hits: hits.slice(0, 8), emotions };
}

/* 只要 6 大类 id（给 core.emotionOf 用，保持老接口不破） */
function coreOf(text) {
  const r = judge(text);
  return r.best ? r.best.node.core : '';
}

/* 叶细节（面板要显示「伤心·失望·委屈」这种） */
function detail(text) {
  const r = judge(text);
  if (!r.best) return null;
  const n = r.best.node;
  return { core: n.core, branch: n.branch, branchName: n.branchName, leaf: n.name, word: r.best.w };
}

/* 虚幻表达这个叶时，按 self 顺序挑第一句能用的 */
function sayFor(leafName) {
  const ix = index();
  const n = ix.nodes.find(x => x.name === leafName);
  return n ? (n.self[0] || '') : '';
}

/* 递归展开应对（主人：「应对方式也不止一种」「递归定位打开其他的」）
 * 结果去重、按引用顺序；防环（走过的 id 不再进） */
function repliesOf(leafName) {
  const bk = load();
  const ix = index();
  const n = ix.nodes.find(x => x.name === leafName);
  if (!n || !n.replies.length) return [];
  const map = {};
  (bk.replies || []).forEach(r => { if (r && r.id) map[r.id] = r; });
  const out = [], seen = new Set();
  const walk = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const r = map[id];
    if (!r) { out.push({ id, text: '', missing: true }); return; }
    out.push({ id, text: String(r.text || '') });
    for (const sub of (r.ref || [])) walk(sub);
  };
  n.replies.forEach(walk);
  return out;
}

/* 记录别人的情绪（主人：「以后要记录别人的情绪」）
 * 只在判出来时记；同一人同一句 60 秒内不重复。 */
const _lastRec = new Map();
function record(who, text, r, src) {
  if (!r || !r.best) return;
  const key = String(who || '') + '|' + String(text || '').slice(0, 40);
  const now = Date.now();
  if (now - (_lastRec.get(key) || 0) < 60000) return;
  _lastRec.set(key, now);
  if (_lastRec.size > 500) { const k = _lastRec.keys().next().value; _lastRec.delete(k); }
  const n = r.best.node;
  const row = {
    t: now, who: String(who || ''), text: String(text || '').slice(0, 200),
    core: n.core, branch: n.branch, leaf: n.name, word: r.best.w,
    src: src || 'other',
  };
  /* 多情绪：长文本依次几种情绪，按分排序写入；第一情绪仍落在 leaf/core/branch 老字段，
   * 所以任何只读 leaf 的老代码（面板、mergeChatEmotion、统计）不用改就继续对。 */
  if (Array.isArray(r.emotions) && r.emotions.length >= 2) {
    row.emotions = r.emotions.map(e => ({ core: e.core, branch: e.branch, leaf: e.leaf, word: e.word }));
  }
  const line = JSON.stringify(row);
  try { fs.appendFileSync(REC_PATH, line + '\n'); } catch (e) { console.error('[情绪书] 记录失败：' + e.message); }
}

/* 读最近 N 条记录（面板用）；每条带上审核状态 */
function recent(n) {
  const lim = Math.max(1, Math.min(2000, Number(n) || 200));
  let lines = [];
  try { lines = fs.readFileSync(REC_PATH, 'utf8').trim().split('\n'); } catch { return []; }
  return lines.slice(-lim).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse()
    .map(r => { const rv = reviewState(r.t); return Object.assign(r, { review: rv ? rv.action : 'new', reviewLeaf: rv ? rv.leaf : '' }); });
}

/* ===== 审核（主人 2026-11-07 纠正语义）=====
 * 每条情绪判断记录（情绪记录.jsonl）默认是「没看过」。
 * 主人在面板里审：
 *   - 没动它（不纠正）→ 标「没错」：看过，AI 判得对
 *   - 改了判定（换成别的叶）→ 标「判错」：AI 判错了，记下来
 * 所以：标黄 / 图上的点 = 没看过（待审）；判错 = 主人改过才会出现。
 * 状态存 情绪审核.json，按记录的 t（时间戳）当 key。 */
const REVIEW_PATH = path.join(__dirname, 'data', '情绪审核.json');

function loadReview() {
  try { return JSON.parse(fs.readFileSync(REVIEW_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function saveReview(map) {
  const tmp = REVIEW_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, REVIEW_PATH);
}
/* action: 'ok'（看过·没错）| 'wrong'（看过·判错）；leaf 仅在 wrong 时用，记主人认为正确的叶名 */
function markReview(t, action, leaf) {
  const map = loadReview();
  map[String(t)] = { action: action === 'wrong' ? 'wrong' : 'ok', leaf: leaf || '', at: Date.now() };
  saveReview(map);
  return true;
}
function reviewState(t) { return loadReview()[String(t)] || null; }

/* 读全部记录（聚合用，封顶防过大） */
function readAllRecords() {
  let lines = [];
  try { lines = fs.readFileSync(REC_PATH, 'utf8').trim().split('\n'); } catch { return []; }
  if (lines.length > 20000) lines = lines.slice(-20000);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/* 按叶聚合审核状态：{ 叶名: { unread, wrong } }
 * unread = 还没审的记录数（驱动整块标黄 / 单图点）
 * wrong  = 主人审过并判成 AI 错的次数（单独的「判错」标记） */
function reviewCounts() {
  const map = loadReview();
  const counts = {};
  for (const rec of readAllRecords()) {
    if (!rec || !rec.leaf) continue;
    const c = counts[rec.leaf] || (counts[rec.leaf] = { unread: 0, wrong: 0 });
    const rv = map[String(rec.t)];
    if (!rv) c.unread++;
    else if (rv.action === 'wrong') c.wrong++;
  }
  /* 聊天记录里主人改过的判错（source='review'）也并入同一个 判错 计数，
   * 这样表情包页/情绪书页的「判错 N」徽标一处亮、处处亮（主人 2026-11-07 定：判错联动）。 */
  const crw = chatReviewWrong();
  for (const k in crw) {
    const c = counts[k] || (counts[k] = { unread: 0, wrong: 0 });
    c.wrong += crw[k];
  }
  return counts;
}

/* ===== 聊天记录 ↔ 情绪 映射（主人 2026-11-07 定）=====
 * 聊天记录页里每条能直接改情绪、能批量补漏判。存成按 chatKey 的映射，
 * 和星标同一套 key（core.starsKey(t,nick,text)），换机/重读都稳定。 */

function readChatEmotion() {
  try { return JSON.parse(fs.readFileSync(CHAT_EMO_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
/* 写一条（原子写）。leaf 为空 → 删掉这条的映射（清空情绪）。 */
function writeChatEmotion(key, leaf, word, source) {
  if (!key) return false;
  const map = readChatEmotion();
  if (!leaf) { delete map[key]; }
  else {
    map[String(key)] = {
      leaf: String(leaf),
      word: String(word || ''),
      source: source === 'user' ? 'user' : (source === 'review' ? 'review' : 'auto'),
      t: Date.now(),
    };
  }
  const tmp = CHAT_EMO_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
  fs.renameSync(tmp, CHAT_EMO_PATH);
  return true;
}

/* 从 情绪记录.jsonl 回退匹配（机器人实时判的、还没进 chat-emotion.json 的）。
 * 按「文本前 40 字重叠」匹配——机器人记的就是原话，最稳；昵称（whoName）可能和聊天记录的 nick 对不齐，所以以文本为主。 */
function matchRecord(nick, text) {
  const tx = String(text || '').slice(0, 200);
  if (tx.length < 2) return null;
  const recs = readAllRecords();
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (!r || !r.leaf) continue;
    const rt = String(r.text || '').slice(0, 40);
    if (!rt) continue;
    if (tx.indexOf(rt) === 0 || rt.indexOf(tx.slice(0, 40)) === 0) {
      return { leaf: r.leaf, word: r.word || '', source: 'auto' };
    }
  }
  return null;
}

/* 把情绪挂到聊天记录每条 entry 上（优先 chat-emotion.json，回退 情绪记录）。
 * entry 需带 key / nick / text。直接改原对象加 .emo = {leaf,word,source} | null。 */
function mergeChatEmotion(list) {
  const map = readChatEmotion();
  for (const e of (list || [])) {
    if (!e) continue;
    const ce = map[String(e.key)];
    if (ce && ce.leaf) { e.emo = { leaf: ce.leaf, word: ce.word || '', source: ce.source || 'auto' }; continue; }
    const m = matchRecord(e.nick || e.whoName, e.text);
    e.emo = m || null;
  }
  return list;
}

/* chat-emotion 里被判错的（source='review'）按叶统计，并入 reviewCounts */
function chatReviewWrong() {
  const map = readChatEmotion();
  const out = {};
  for (const k in map) {
    const v = map[k];
    if (v && v.source === 'review' && v.leaf) out[v.leaf] = (out[v.leaf] || 0) + 1;
  }
  return out;
}

/* 面板要的整棵树：叶 + 图数（图数由调用方注入，这里只给结构） */
function tree() {
  const bk = load();
  const ix = index();
  const cnt = {};
  ix.nodes.forEach(n => { cnt[n.name] = n; });
  return {
    cores: bk.cores,
    branches: bk.branches,
    leaves: ix.nodes.map(n => ({
      name: n.name, branch: n.branch, branchName: n.branchName, core: n.core,
      files: n.files, priority: n.priority,
      self: n.self, other: n.other, replies: n.replies,
    })),
    replies: bk.replies || [],
    ratio: bk.ratio || {},
  };
}

/* 写整棵树（面板保存用，原子写：先写临时文件再 rename） */
function save(obj) {
  const tmp = BOOK_PATH + '.tmp';
  const txt = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, txt, 'utf8');
  fs.renameSync(tmp, BOOK_PATH);
  _book = null; _mt = 0; _idx = null;
  return true;
}

module.exports = {
  BOOK_PATH, REC_PATH, REVIEW_PATH, CHAT_EMO_PATH,
  load, index, judge, coreOf, detail, sayFor, repliesOf, record, recent, tree, save,
  markReview, reviewState, reviewCounts, readAllRecords,
  readChatEmotion, writeChatEmotion, matchRecord, mergeChatEmotion, chatReviewWrong,
  isB, posOK, relax, normPunct,
};
