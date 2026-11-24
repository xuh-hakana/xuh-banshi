/*
 * tasteid.js — 喜好唯一 id + 四栏具体描述 + 最小参数类型默认模版
 *
 * 主人 2026-11-13 原文 ③⑤⑦⑧：
 *   「模型不记串：每个喜好有唯一 id。其他表写关联偏好 id。」
 *   「所有喜好都能选择设定具体描述：来源 / 对其理解 / 理由 / 附加条件。」
 *   「『特别·喜/厌』每轮展示，仅展示词条不含描述，描述依旧需检索。」
 *   「没有填写参数的，按最小参数类型（如喜好的具体描述：人，吃的，类）分配默认模版解释。」
 *   「此『喜好表』和原本的表功能一致，与其他表的联动也不变，每个词/句对应的其他表条目也会随双方修改同步。」
 *
 * 一个词/句 = 一个 id；虚幻喜好表和本地模型喜好表共用同一个 id 空间：
 * 同一个词在两份表里是同一个 id，改哪一边，其他表按 id 挂的条目都不会串到人 / 串到词。
 * 词条删了 id 不删（标 gone），保证「其他表写关联偏好 id」不悬空；差异由 tastecopy.diff() 记。
 */
const fs = require('fs');
const path = require('path');
const taste = require('./taste');
const tastecopy = require('./tastecopy');

const FILE = path.join(__dirname, 'data', '喜好id.json');
const META = [
  ['source', '来源'],
  ['understand', '对其理解'],
  ['reason', '理由'],
  ['condition', '附加条件'],
];
const EMPTY = () => ({ version: 1, next: 1, items: {} });

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    if (!j.items || typeof j.items !== 'object') j.items = {};
    if (!Number(j.next)) j.next = 1;
    return j;
  } catch { return EMPTY(); }
}
function save(j) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(j, null, 1), 'utf8');
    return true;
  } catch (e) { console.error('[tasteid] 存失败：' + e.message); return false; }
}
function bare(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[「」『』“”"']/g, '').trim();
}
function rowsOf(file) {
  const w = taste.mineWords(file);
  const out = [];
  for (const sec of Object.keys(w)) for (const word of w[sec]) out.push({ sec, word: bare(word) });
  return out;
}

/* 扫两份表，给新词建 id、更新栏位、标出哪边有哪边没有。
 * 「新增 / 删减喜好等不同的部分也能兼容记录」：两边都不在了才标 gone，不删 id。 */
function sync() {
  const j = load();
  const byWord = {};
  for (const id of Object.keys(j.items)) {
    const w = bare(j.items[id].word);
    if (w && !byWord[w]) byWord[w] = id;
    /* 改过词的旧说法仍回指同一个 id（⑧「随双方修改同步」）：
       副本锁住不能跟着改时，旧词不会被另建新 id、原 id 也不会被标 gone。 */
    for (const old of (j.items[id].prev || [])) {
      const ow = bare(old);
      if (ow && !byWord[ow]) byWord[ow] = id;
    }
  }
  const mine = rowsOf(taste.MINE_FILE);
  const local = fs.existsSync(tastecopy.LOCAL_FILE) ? rowsOf(tastecopy.LOCAL_FILE) : [];
  const mw = new Set(mine.map(x => x.word)), lw = new Set(local.map(x => x.word));
  let changed = false, added = 0;
  const seen = new Set();
  for (const [rows, side] of [[mine, 'mine'], [local, 'local']]) {
    for (const r of rows) {
      if (!r.word || seen.has(r.word + '|' + side)) continue;
      seen.add(r.word + '|' + side);
      let id = byWord[r.word];
      if (!id) {
        id = 't' + j.next++;
        j.items[id] = { word: r.word, sec: '', localSec: '', at: Date.now(), meta: {} };
        byWord[r.word] = id; added++; changed = true;
      }
      const it = j.items[id];
      if (side === 'mine' && it.sec !== r.sec) { it.sec = r.sec; changed = true; }
      if (side === 'local' && it.localSec !== r.sec) { it.localSec = r.sec; changed = true; }
    }
  }
  for (const id of Object.keys(j.items)) {
    const it = j.items[id];
    const words = [bare(it.word)].concat((it.prev || []).map(bare)).filter(Boolean);
    const inMine = words.some(w => mw.has(w)), inLocal = words.some(w => lw.has(w));
    if (it.inMine !== inMine || it.inLocal !== inLocal || it.gone !== (!inMine && !inLocal)) {
      it.inMine = inMine; it.inLocal = inLocal; it.gone = !inMine && !inLocal; changed = true;
    }
  }
  if (changed) save(j);
  return { ok: true, total: Object.keys(j.items).length, added, mine: mine.length, local: local.length };
}
function idOf(word, opt) {
  const w = bare(word);
  if (!w) return '';
  const o = opt || {};
  const j = load();
  for (const id of Object.keys(j.items)) if (bare(j.items[id].word) === w) return id;
  if (o.create === false) return '';
  const id = 't' + j.next++;
  j.items[id] = {
    word: w, sec: String(o.sec || ''), localSec: '', at: Date.now(), meta: {},
    inMine: !!o.inMine, inLocal: !!o.inLocal, gone: false,
  };
  save(j);
  return id;
}
function get(id) {
  const it = load().items[String(id || '')];
  return it ? Object.assign({ id }, it) : null;
}
function list(opt) {
  sync();
  const o = opt || {};
  let rows = Object.keys(load().items).map(id => get(id));
  if (o.only === 'mine') rows = rows.filter(x => x.inMine);
  if (o.only === 'local') rows = rows.filter(x => x.inLocal);
  if (!o.includeGone) rows = rows.filter(x => !x.gone);
  return { ok: true, total: rows.length, items: rows };
}
function setMeta(id, patch) {
  const j = load();
  const it = j.items[String(id || '')];
  if (!it) return { error: '没有这个喜好 id' };
  it.meta = it.meta || {};
  for (const [k] of META) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      const v = String(patch[k] == null ? '' : patch[k]).trim().slice(0, 300);
      if (v) it.meta[k] = v; else delete it.meta[k];
    }
  }
  if (patch && patch.kind) it.kind = String(patch.kind).trim().slice(0, 20);
  it.at = Date.now();
  return save(j) ? { ok: true, id, meta: it.meta } : { error: '没写进去' };
}
/* 改词不改 id（⑧「每个词/句对应的其他表条目也会随双方修改同步」）。
 * 光改 喜好id.json 的 word 不够：sync() 按两份表正文的词建 id，旧词会被另建新 id、
 * 原 id 标 gone，其他三张表挂的 tasteIds 就悬空了。所以：
 *   ① 正本正文里的旧词同步改成新词；② 旧词记进 prev，副本里没跟着改的旧词仍回指原 id。
 * 本地副本已上锁（⑩），这边一律不动，由 diff 记为「只在副本」；关联条目照旧按 id 跟着。 */
function rename(id, word) {
  const w = bare(word);
  if (!w) return { error: '词不能为空' };
  const j = load(), it = j.items[String(id || '')];
  if (!it) return { error: '没有这个喜好 id' };
  const old = bare(it.word);
  if (old === w) return { ok: true, id, word: w, unchanged: true };
  let mineSync = '';
  if (it.sec) {
    const r = taste.mineSet(it.sec, old, w, it.sec, { by: 'master' });
    if (r && r.error) mineSync = String(r.error);
  }
  it.prev = (it.prev || []).filter(x => bare(x) !== w);
  if (old && it.prev.indexOf(old) < 0) it.prev.push(old);
  it.word = w; it.at = Date.now();
  return save(j) ? {
    ok: true, id, word: w, prev: it.prev,
    mineSync: mineSync || undefined,
    localSkipped: tastecopy.isLocked(),
  } : { error: '没写进去' };
}
/* 最小参数类型：没填描述的，按词本身归到最小一类给默认模版解释（人 / 吃的 / 类 / 其它）。 */
function templateOf(id) {
  const it = get(id);
  if (!it) return '';
  const w = it.word;
  let kind = '一个词或一句';
  if (it.kind) kind = it.kind;
  else if (/(人|酱|哥|姐|友|神|谁|妈|爸|同学|老师)$/.test(w)) kind = '人';
  else if (/(吃|喝|菜|饭|翅|腿|糖|果|面|茶|肉|零食)/.test(w)) kind = '吃的';
  else if (/(模型|游戏|作品|图|视频|角色|对战|检索|软件|站|书|番|歌)/.test(w)) kind = '一类事物';
  return '（未填描述）默认模版：这是' + kind + '。';
}
/* 只有检索命中才拼描述；空的就给默认模版，不把四栏长文塞进每轮提示词。 */
function describe(id) {
  const it = get(id);
  if (!it) return '';
  const m = it.meta || {};
  const parts = [];
  for (const [k, label] of META) {
    const v = String(m[k] || '').trim();
    if (v) parts.push(label + '：' + v.slice(0, 120));
  }
  return parts.length ? parts.join('；') : templateOf(id);
}
function api(action, payload) {
  const p = payload || {};
  switch (action) {
    case 'sync': return sync();
    case 'list': return list(p);
    case 'get': { const r = get(p.id); return r ? { ok: true, item: r } : { error: '没有这个喜好 id' }; }
    case 'id': return { ok: true, id: idOf(p.word, p) };
    case 'meta': return setMeta(p.id, p);
    case 'rename': return rename(p.id, p.word);
    case 'describe': return { ok: true, id: p.id, desc: describe(p.id), template: templateOf(p.id) };
    case 'template': return { ok: true, id: p.id, template: templateOf(p.id) };
    default: return { error: '没这个动作：' + action };
  }
}

module.exports = { api, sync, list, idOf, get, setMeta, rename, describe, templateOf, META, FILE };
