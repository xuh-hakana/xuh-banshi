/*
 * guides.js — 本地攻略库（关键词检索，不联网、不用向量）
 * 用法：把 .md 攻略放进 data/guides/，按 ## 标题切段，按问题关键词匹配注入。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data', 'guides');
let cache = null;      // [{file, title, body, g}]
let stamp = 0;

// 剥掉 HTML 注释（攻略第一行那枚 `<!-- guide:xxx -->` 标记不能进搜索结果、不能进提示词）
const stripCmt = s => String(s || '').replace(/<!--[\s\S]*?-->/g, '').trim();

// 标记约定：data/guides/ 下每份 .md 第一行都是 `<!-- guide:文件名 -->`。
// 缺了机器人自己补（guideHeal），不私信、不打扰主人（2026-11-06 定）。
// 机器人自动落盘的：客户端标「自动」（2026-11-13 起「学到的」按范围分文件，见 isAutoGuide）
const AUTO_GUIDES = new Set(['联网确认.md']);
/* 这两份不是攻略，是「人设条 / 教学条」的独立数据（主人 2026-11-13）：
   人设素材 = 别人 / 角色的人设；可用知识 = 别人教的事实原理。
   不进攻略检索缓存、不补 guide 标记、不整篇注入提示词；只在 kb.js 里按条检索、命中才给。 */
const NOT_GUIDES = new Set(['人设素材.md', '可用知识.md']);
const isAutoGuide = f => AUTO_GUIDES.has(f) || /^学到的（.+）\.md$/.test(f);
const guideFiles = () => {
  try { return fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.md') && !NOT_GUIDES.has(f)); } catch { return []; }
};
const markOf = slug => '<!-- guide:' + slug + ' -->';
const hasMark = raw => /^<!--\s*guide:[^>]*-->/i.test(String(raw || '').trimStart());
/* 署名（2026-11-13 主人定）：攻略也按「人」署名，跟教学一条规矩——存 platform:id。
 * 位置在 guide 标记下面那一行 `<!-- by:qq:1000000002 -->`；stripCmt 会把它一起剥掉，
 * 所以既不进搜索结果、也不进提示词，纯粹是归属记录。 */
const BY_RE = /<!--\s*by:([^>]*?)\s*-->/i;
const byOf = raw => { const m = String(raw || '').match(BY_RE); return m ? String(m[1]).trim() : ''; };
const byMark = by => '<!-- by:' + String(by || '').trim() + ' -->';

/* 主人的全部账号（platform:id）。用来给界面上标「我」，不复制数据——就现读 people.json。
 * people.js 是底层模块，不 require 本文件，所以放函数里懒加载，不会循环。 */
function masterKeys() {
  try {
    const people = require('./people');
    const p = (people.load() || {})['p_master'];
    const s = new Set();
    for (const a of (p && p.accounts) || []) s.add(String(a.platform) + ':' + String(a.id));
    return s;
  } catch { return new Set(); }
}
// 文件名只留中文 / 字母 / 数字 / 下划线 / 连字符 / 中文括号（括号给「学到的（群123）」用）
const sanitizeName = n => String(n || '').trim().replace(/[^\u4e00-\u9fa5A-Za-z0-9_\-（）]/g, '');
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}
/* 外部改了 data/guides/*.md（kb.js 的单条核实 / 单条删除）后强制下次检索重读。
 * 只清缓存，不写文件；标记仍然由 guideHeal 补齐。 */
function reset() { cache = null; stamp = 0; }

// 缺标记就补到第一行；已带标记返回 false。原子写、正文原样保留。
function ensureMark(file, slug) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (hasMark(raw)) return false;
  const cleaned = raw.replace(/<!--\s*guide:[^>]*-->\s*/gi, '');  // 位置不对的旧标记先去掉，别留两份
  writeFileAtomic(file, markOf(slug) + '\n' + cleaned.trimStart());
  return true;
}

function load() {
  const files = guideFiles();
  const now = files.map(f => { try { return fs.statSync(path.join(DIR, f)).mtimeMs; } catch { return 0; } }).join(',');
  if (cache && now === stamp) return;
  stamp = now;
  cache = [];
  for (const f of files) {
    const md = fs.readFileSync(path.join(DIR, f), 'utf8');
    // 以二级标题切段；没有标题就整篇
    const parts = md.split(/^##+\s+/m);
    if (parts.length <= 1) {
      cache.push({ file: f, title: f.replace(/\.md$/i, ''), body: stripCmt(md), g: grams(stripCmt(md)) });
      continue;
    }
    // 学到的那几份只有样板文件头（「这是干什么的…」），不进检索也不进提示词（2026-11-13）
    let head = isAutoGuide(f) ? '' : stripCmt(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      const lines = parts[i].split('\n');
      const title = lines.shift().trim();
      const body = stripCmt(lines.join('\n'));
      if (!body) continue;
      // 只有「待补/待填」的占位段不入库：否则标题里的词会虚高覆盖率，让她误以为有资料
      if (body.length < 120 && /(待补|待填|待主人补充|TODO)/i.test(body)) continue;
      cache.push({ file: f, title, body: (head && i === 1 ? head + '\n\n' : '') + body, g: grams(title + ' ' + body) });
    }
  }
}

// 中文用二字切片 + 英文数字词，够用的轻量召回
function grams(text) {
  const set = new Set();
  const low = String(text).toLowerCase();
  for (const w of low.match(/[a-z0-9]+/g) || []) if (w.length >= 2) set.add(w);
  const cj = low.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cj.length - 1; i++) set.add(cj.slice(i, i + 2));
  return set;
}

/* 二字切片的权重：越少见的词越重（「折射」比「怎么」值钱）。
 * 每轮强制检索要 precision —— 不然「今天天气不错」也会撞上某条无关的学到的（2026-11-13）。 */
function gramWeights(q, list) {
  const n = (list && list.length) || 1;
  const w = new Map();
  for (const g of q) {
    let df = 0;
    for (const s of list) if (s.g && s.g.has(g)) df++;
    // 资料里根本没有这个词（df=0）：按中性 1 算，不让「没出现过的词」把分母抬高
    w.set(g, df ? Math.log(1 + n / (1 + df)) : 1);
  }
  return w;
}
function weightedRatio(q, set, w) {
  let hitW = 0, allW = 0;
  for (const x of q) {
    const ww = w.get(x) || 1;
    allW += ww;
    if (set && set.has(x)) hitW += ww;
  }
  return allW ? hitW / allW : 0;
}

/* 疑问 / 指代 / 口气词：算覆盖率时先剥掉，不然「怎么、什么、这个」把分母撑大、真词被稀释
 * （「这个折射技能怎么配」剥完只剩「折射技能配」）。只在 minRatio > 0 时用，老调用不受影响。 */
const ASK_STOP = /(怎么样|怎么|怎样|什么|这个|那个|这些|那些|多少|为什么|如何|可以|能不能|帮我|请问|一下|吗|呢|吧|啊|呀)/g;

function search(query, topK = 3, maxChars = 2600, minRatio = 0) {
  load();
  if (!cache || !cache.length) return '';
  const qText = minRatio > 0 ? String(query || '').replace(ASK_STOP, ' ') : String(query || '');
  const q = grams(qText);
  if (!q.size) return '';
  const gw = gramWeights(q, cache);
  const scored = [];
  const raw = String(qText || '').toLowerCase();
  // 有没有连续 3 个字原样撞上（「微波炉」这种专名比零散二字切片可信得多）
  const has3 = txt => {
    for (let i = 0; i + 3 <= raw.length; i++) {
      const tri = raw.slice(i, i + 3);
      if (!/[\u4e00-\u9fa5a-z0-9]/.test(tri[0]) || !/[\u4e00-\u9fa5a-z0-9]/.test(tri[2])) continue;
      if (txt.indexOf(tri) >= 0) return true;
    }
    return false;
  };
  for (const s of cache) {
    // 学到的 / 梗词句走 learnSearch（同一个「别人教的知识」检索器），别在攻略里重复给
    if (/^学到的（.+）\.md$/.test(s.file) || s.file === '梗词句.md') continue;
    let hit = 0;
    for (const x of q) if (s.g.has(x)) hit++;
    const tg = grams(s.title);
    let th = 0;
    for (const x of q) if (tg.has(x)) th++;
    if (hit + th <= 0) continue;
    // 覆盖率门槛（2026-11-13，按权重算）：宁可不给，也别把无关资料灌进提示词。
    // 例外：① 连续 3 字撞上（专名）；② 标题基本被这句话覆盖；③ 这句话点了文件名。
    // 老调用不传 minRatio，行为不变。
    if (minRatio > 0) {
      const ratio = weightedRatio(q, s.g, gw);
      const tr = weightedRatio(q, tg, gw);
      const nameHit = raw.indexOf(s.file.replace(/\.md$/i, '').toLowerCase()) >= 0;
      const ok = ratio >= minRatio
        || (has3(s.title + ' ' + s.body) && hit >= 2 && ratio >= 0.2)
        || tr >= 0.6
        || (nameHit && hit >= 1);
      if (!ok) continue;
    }
    scored.push({ s, score: hit + th * 3 });
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.score - a.score);
  let out = '';
  for (const { s } of scored.slice(0, topK)) {
    const block = `### ${s.file} · ${s.title}\n${s.body}\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

// 覆盖度：问题里的词有多少能在资料里找到（0~1）。用来判断本地资料够不够用
// 先剥掉疑问/语气虚词，否则「怎么/什么/的」会把覆盖率虚高
const STOP = /[的了呢吗吧啊是在有我你他她它这那个就也都很不么怎如何什里样]/g;
function bi(text) {
  const cj = String(text || '').replace(STOP, '').replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i < cj.length - 1; i++) set.add(cj.slice(i, i + 2));
  return set;
}
function coverage(query, text) {
  const q = bi(query);
  if (!q.size) return 0;
  const t = bi(text);
  let hit = 0;
  for (const x of q) if (t.has(x)) hit++;
  return hit / q.size;
}

// 问题直接点到了某个小标题（比如问「折射」）→ 本地这一节就是答案，别再去搜二手攻略
function titleHit(query) {
  load();
  if (!cache || !cache.length) return false;
  const q = String(query || '');
  for (const s of cache) {
    const core = String(s.title || '').replace(/[（(].*?[）)]/g, '').trim();
    if (core.length >= 2 && q.includes(core)) return true;
    const name = String(s.file || '').replace(/\.md$/i, '').trim();   // 问到整篇的名字也算
    if (name.length >= 2 && q.includes(name)) return true;
  }
  return false;
}

// ===== 网络热梗库（data/网络热梗.md）=====
// 和攻略库分开：梗库不参与攻略检索，只在「这句话像不像梗」时才查。
// 条目分两种（按有没有「怎么接」分）：
//   接梗型（有「怎么接」）→ 别人发这个梗时，按「怎么接」接管这一轮的回复；
//   词典型（只有「含义」，俚语/黑话）→ 只把含义注进提示词帮助理解，不接管回复（如「米=钱」）。
// 每节格式（## 梗名）：
//   - 特征词：词1、词2（消息里命中才算认出；写「关键词」的是通用说明，不参与匹配）
//   - 含义：这个梗是什么意思（给人看，也给 AI 看）
//   - 怎么接：怎么回（可选；接梗型必填）
//   - 怎么玩：自己想玩这个梗时怎么用（可选）
//   - 全文：这条梗的完整原文（可选）。写了这行 = 「原文梗」：别人只发了一截 → 直接背全文，不过模型（见 memeFullHit）
//   - 范例：示范句（可选，只用于校验和兜底，不进 prompt——免费模型会逐字照抄）
const MEME_FILE = path.join(__dirname, 'data', '网络热梗.md');
let memeCache = null, memeStamp = 0;

function parseMemes(md) {
  const out = [];
  for (const part of md.split(/^##+\s+/m).slice(1)) {
    const lines = part.split('\n');
    const title = lines.shift().trim();
    const body = lines.join('\n').trim();
    const field = re => { const m = body.match(re); return m ? m[1].trim() : ''; };
    out.push({
      title, body,
      words: field(/^[-*]\s*特征词[:：]\s*(.+)$/m).split(/[｜|、,，；;]/).map(s => s.trim()).filter(Boolean),
      meaning: field(/^[-*]\s*(?:含义|是什么)[:：]\s*(.+)$/m),
      how: field(/^[-*]\s*怎么接[:：]\s*(.+)$/m),
      full: field(/^[-*]\s*全文[:：]\s*(.+)$/m),
      ctx: field(/^[-*]\s*上下文[:：]\s*(.+)$/m),
      play: field(/^[-*]\s*(?:怎么玩|玩法)[:：]\s*(.+)$/m),
      ex: field(/^[-*]\s*(?:范例|举例)[:：]\s*(.+)$/m),
    });
  }
  return out;
}
function loadMemes() {
  let st = 0;
  try { st = fs.statSync(MEME_FILE).mtimeMs; } catch { return []; }
  if (memeCache && st === memeStamp) return memeCache;
  memeStamp = st;
  let md = '';
  try { md = fs.readFileSync(MEME_FILE, 'utf8'); } catch { return []; }
  memeCache = parseMemes(md);
  return memeCache;
}

// ===== 梗词典（data/梗词典.jsonl，来自开源 CHIME 数据集：1455 个中文网络梗）=====
// 词典型：只有含义、没有「怎么接」→ 只在理解时注入，不接管回复、不进面板卡片页、不进梗速览。
// 自己梗库里写了的词永远优先（glossaryHit 先查自有节）。
const DICT_FILE = path.join(__dirname, 'data', '梗词典.jsonl');
let dictCache = null, dictStamp = 0;
function loadMemeDict() {
  let st = 0;
  try { st = fs.statSync(DICT_FILE).mtimeMs; } catch { return []; }
  if (dictCache && st === dictStamp) return dictCache;
  dictStamp = st;
  try {
    dictCache = fs.readFileSync(DICT_FILE, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .map(x => ({
        title: String(x.meme || ''), body: '', words: [String(x.meme || '')],
        meaning: String(x.meaning || ''), how: '', play: '',
        ex: (x.examples && x.examples[0]) || '',
      }));
  } catch { dictCache = []; }
  return dictCache;
}
// 命中用「全集」：自有梗库 + 词典
function allMemes() { return loadMemes().concat(loadMemeDict()); }

// 拼一节的正文（规范格式：特征词 / 是什么 / 怎么接 / 怎么玩 / 举例，缺的省略）
function memeBody(s) {
  const lines = ['- 特征词：' + (s.words || []).join('、')];
  if (s.meaning) lines.push('- 是什么：' + s.meaning);
  if (s.ctx) lines.push('- 上下文：' + s.ctx);
  if (s.how) lines.push('- 怎么接：' + s.how);
  if (s.full) lines.push('- 全文：' + s.full);
  if (s.play) lines.push('- 怎么玩：' + s.play);
  if (s.ex) lines.push('- 举例：' + s.ex);
  return lines.join('\n');
}

// 把节列表写回文件：保留文件头；「不要跟着玩」这类守门节永远排最后
function writeMemes(sections) {
  let md = '';
  try { md = fs.readFileSync(MEME_FILE, 'utf8'); } catch {}
  const i = md.search(/^##+\s+/m);
  const header = i >= 0 ? md.slice(0, i) : (md ? md.replace(/\s*$/, '\n') : '# 网络热梗库\n\n');
  const isGuard = t => /不要跟着玩/.test(t);
  const sorted = sections.slice().sort((a, b) => (isGuard(a.title) ? 1 : 0) - (isGuard(b.title) ? 1 : 0));
  fs.writeFileSync(MEME_FILE, header + sorted.map(s => '## ' + s.title + '\n\n' + String(s.body || '').trim() + '\n').join('\n'), 'utf8');
  memeCache = null; memeStamp = 0;
}

function memeAdd(s) {
  const t = String(s && s.title || '').trim();
  if (!t) return { error: '梗名不能为空' };
  const list = loadMemes();
  if (list.some(x => x.title === t)) return { error: '已经有叫「' + t + '」的梗了' };
  const item = { title: t, words: s.words || [], meaning: s.meaning || '', how: s.how || '', full: s.full || '', ctx: s.ctx || '', play: s.play || '', ex: s.ex || '' };
  item.body = memeBody(item);
  writeMemes(list.concat([item]));
  return { ok: true };
}
function memeUpdate(title, patch) {
  const list = loadMemes().slice();
  const i = list.findIndex(x => x.title === title);
  if (i < 0) return { error: '找不到「' + title + '」' };
  const merged = Object.assign({}, list[i], patch);
  merged.title = String(merged.title || '').trim() || title;
  merged.body = memeBody(merged);
  list[i] = merged;
  writeMemes(list);
  return { ok: true };
}
function memeDel(title) {
  const list = loadMemes().slice();
  const i = list.findIndex(x => x.title === title);
  if (i < 0) return { error: '找不到「' + title + '」' };
  list.splice(i, 1);
  writeMemes(list);
  return { ok: true };
}

// 接梗型命中就返回 { title, body, hits }；need 是至少要命中几个特征词
function memeHit(text, need) {
  const t = String(text || '').toLowerCase();
  if (t.length < 12) return null;
  let best = null;
  for (const s of allMemes()) {
    if (!s.how || !s.words.length) continue;       // 词典型不接管回复
    let hits = 0;
    for (const w of s.words) if (w && t.includes(w.toLowerCase())) hits++;
    if (!hits) continue;
    const n = need || (s.words.length <= 3 ? 1 : 2);
    if (hits < n) continue;
    // 命中数优先，同样命中数时「特征词更少的那节」更精确
    if (!best || hits > best.hits || (hits === best.hits && s.words.length < best.words)) {
      best = { title: s.title, body: s.body, hits, words: s.words.length };
    }
  }
  return best;
}

// 词典型命中（俚语/黑话）：只用来解释含义，不管接法。短句也要能命中（「多少米」才几个字）。
// 自己梗库里写了的优先；没有才查词典（CHIME）。
function glossaryHit(text) {
  const t = String(text || '').toLowerCase();
  if (t.length < 2) return [];
  const out = [];
  for (const s of allMemes()) {
    if (s.how || !s.words.length || !s.meaning) continue;
    if (s.words.some(w => w && t.includes(w.toLowerCase()))) out.push({ title: s.title, meaning: s.meaning, own: !!s.body });
  }
  return out.sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0)).slice(0, 2)
    .map(x => ({ title: x.title, meaning: x.meaning }));
}

// 「原文梗」命中（主人 2026-10-22 定的机制，不是某一节的接法）：
// 条目写了「全文」→ 别人发的只是这套梗的**一小截**（命中特征词、但消息里没有完整原文）→ 直接把全文背出来。
// 已经把整套都发出来了（消息里含全文）→ 不算「不全」，返回 null 照常玩梗。
// 返回 { title, full, hits }，没命中返回 null。
function normCmp(t) {
  return String(t || '').toLowerCase().replace(/[\s，。！？、；~～…·,.!?；:"'“”‘’（）()【】\[\]=＝\-—_*#>]/g, '');
}
function memeFullHit(text, need) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  if (t.length < 4) return null;                       // 太短不像在发梗
  const nt = normCmp(raw);
  let best = null;
  for (const s of loadMemes()) {                       // 只查自有梗库：词典没有全文
    if (!s.full || !s.words.length) continue;
    let hits = 0;
    for (const w of s.words) if (w && t.includes(w.toLowerCase())) hits++;
    if (!hits) continue;
    const n = need || (s.words.length <= 3 ? 1 : 2);   // 和 memeHit 同一门槛：特征词多的节要命中 2 个才认
    if (hits < n) continue;
    if (nt.includes(normCmp(s.full))) continue;        // 全文都在消息里 → 发的是完整一套
    if (!best || hits > best.hits) best = { title: s.title, full: s.full, hits };
  }
  return best;
}

// 这句话里有没有任何梗库特征词（不管接不接梗）——有就拿「xx 是什么梗」去搜，不裸搜
function memeWordHit(text) {
  const t = String(text || '').toLowerCase();
  if (t.length < 2) return false;
  return allMemes().some(s => s.words.some(w => w && t.includes(w.toLowerCase())));
}

// 取某一节的接法。
// how / plain = 「- 怎么接：」那行（只写方向，直接喂给模型）
// ex = 「- 范例：」里的句子——只用于校验和兜底，不进 prompt（范例句一旦进 prompt，免费模型会逐字照抄）
function memeHowto(title) {
  const s = loadMemes().find(x => x.title === title);
  if (!s || !s.how) return null;
  const ex = [];
  const push = t => {
    const v = String(t || '').replace(/^[，,、。；;\s]+|[，,、。；;\s]+$/g, '');
    if (v && !ex.includes(v)) ex.push(v);
  };
  const raw = s.ex || '';
  const re = /[「“"]([^」”"]{2,40})[」”"]/g;
  let x, quoted = 0;
  while ((x = re.exec(raw))) { push(x[1]); quoted++; }
  if (!quoted && raw) raw.split(/[｜|、；;]/).forEach(push);
  return { how: s.how, plain: s.how, ex };
}

// 通用那段（怎么认段子），命中任何梗时都带上给模型看
function memeGeneral() {
  let md = '';
  try { md = fs.readFileSync(MEME_FILE, 'utf8'); } catch { return ''; }
  const part = md.split(/^##+\s+/m).slice(1).find(p => /通用/.test(p.slice(0, 40)));
  if (!part) return '';
  return part.split('\n').slice(1).join('\n').trim();
}

// 给 systemPrompt 的梗速览：一行一个「梗名：含义」，只收写了含义的（守门节和通用节不算）
function memeOverview(limit) {
  return loadMemes()
    .filter(s => s.meaning && s.how && !/通用/.test(s.title) && !/不要跟着玩/.test(s.title))
    .slice(0, limit || 30)
    .map(s => '- ' + s.title + '：' + s.meaning);
}

// ===== 记到攻略：把口述内容追加进 data/guides/<name>.md（并同步人设副本）=====
// 这是「记到 X 攻略里」指令的落盘实现。之前 bot 只会嘴上回「已记好啦」、磁盘什么都没写，
// 于是群聊再被问到就靠模型瞎编（2026-11-01 翻车根因）。这个函数负责真写。
function guideAppend(name, content) {
  const nm = String(name || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  if (!nm) return { error: '攻略名不能为空' };
  const txt = String(content || '').trim();
  if (!txt) return { error: '没有要记的内容' };
  const file = path.join(DIR, nm + '.md');
  const personaFile = path.join(__dirname, 'persona', '1-人设正文', 'guides', nm + '.md');
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const firstLine = txt.split('\n')[0].trim();
  const title = (firstLine.length > 16 ? firstLine.slice(0, 16) + '…' : firstLine) || '记录';
  const block = `## ${title}\n> 来源：主人 ${date} 通过「记到攻略」指令口述（自动落盘）\n${txt}\n`;
  let created = false;
  try {
    if (!fs.existsSync(file)) {
      writeFileAtomic(file, `${markOf(nm)}\n# ${nm}\n\n> 来源：主人通过「记到攻略」指令自动落盘。\n\n` + block);
      created = true;
    } else {
      ensureMark(file, nm);                       // 老文件缺标记也顺手补上，不留漏网的
      const cur = fs.readFileSync(file, 'utf8');
      writeFileAtomic(file, cur.replace(/\s*$/, '') + '\n\n' + block);
    }
  } catch (e) { return { error: '写攻略文件失败：' + e.message }; }
  let persona = false;
  if (fs.existsSync(personaFile)) {
    try {
      const cur = fs.readFileSync(personaFile, 'utf8');
      fs.writeFileSync(personaFile, cur.replace(/\s*$/, '') + '\n\n' + block, 'utf8');
      persona = true;
    } catch (e) { console.error('[guides] 人设副本同步失败', e.message); }
  }
  cache = null; stamp = 0;   // 强制下次检索重新加载，立刻能查到刚写的内容
  return { file: path.join('data', 'guides', nm + '.md'), name: nm, chars: txt.length, persona, created };
}

// ===== 学到的事：别人教的、官方资料直取的，真写盘 =====
// 这是干什么的：让「被教会＝学到了」不是嘴上一句，磁盘上真多一条；下次被问到由 learnSearch() 命中读回。
// 并进现成攻略库，不另起一套检索器（主人 2026-11-07：同功能并进老处）。
// 未核实的口述不许当事实：每条自带核实状态，跟已核实资料冲突时按正确知识说，如实指出哪里不对。
//
// 2026-11-13 主人定：**不要一个文件装所有事**，按范围分——每个群一份、私聊一份、联网一份。
// 好处（她原话「刚好可以算在场人物」）：一个群的文件里出现的人，就是这个群在场的人；
// 检索时只读本群那份 + 联网那份，别处的知识不会串过来。
const LEARN_BASE = '学到的';
const LEARN_OFFICIAL = '联网';        // 官方直取：全范围通用
function learnScopeOf(scope) {
  const s = String(scope || '').trim().replace(/[（）()]/g, '');
  return s || '未分群';
}
const learnFileOf = scope => LEARN_BASE + '（' + learnScopeOf(scope) + '）.md';
const learnPathOf = scope => path.join(DIR, learnFileOf(scope));
function learnHeadOf(scope) {
  const sc = learnScopeOf(scope);
  const where = sc === '未分群' ? '' : '「' + sc + '」里';
  return markOf(LEARN_BASE + '（' + sc + '）') + '\n# ' + LEARN_BASE + '（' + sc + '）\n\n'
    + '> 这是干什么的：' + where + '别人教的事、官方资料直取的事都记在这份里，由 guides.learnSearch() 命中才读，不每轮注入。\n'
    + '> 每条带「核实状态」：未核实＝别人教的，不许当事实；已核实＝官方资料直取。\n'
    + '> 跟已核实资料冲突时按正确知识说，如实指出哪里不对。\n'
    + '> 机器人自动落盘，客户端这里能看能改。\n';
}

function learnKey(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function learnRecord(title, body, meta, scope) {
  const txt = String(body || '').replace(/\r/g, '').trim().slice(0, 600);
  if (txt.length < 8) return { error: '内容不到 8 个字，不记' };
  const key = learnKey(txt).slice(0, 40);
  const file = learnFileOf(scope);
  const full = learnPathOf(scope);
  let raw = '';
  try { raw = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''; }
  catch (e) { return { error: '读 ' + file + ' 失败：' + e.message }; }
  // 去重只在同一份里做：同一个事在 A 群和 B 群各教一次，各留各的（那是不同群的在场面）
  if (key && learnKey(raw).includes(key)) return { ok: false, dup: true, file: 'data/guides/' + file };
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const head = `## ${String(title || '记录').replace(/[\n\r]/g, ' ').slice(0, 40)}\n`
    + `> 时间：${time}\n> ${String(meta || '').replace(/[\n\r]/g, ' ').slice(0, 140)}\n\n${txt}\n`;
  try {
    writeFileAtomic(full, (raw ? raw.replace(/\s*$/, '') + '\n\n' : learnHeadOf(scope).trimEnd() + '\n\n') + head);
  } catch (e) { return { error: '写 ' + file + ' 失败：' + e.message }; }
  cache = null; stamp = 0;   // 下次检索立刻能查到刚写的这条
  return { ok: true, dup: false, file: 'data/guides/' + file, chars: txt.length, scope: learnScopeOf(scope) };
}

// 别人教我的：核实状态＝未核实。who 是说话人（群友昵称或「主人」），scope 是「群123 / 私聊 / 联网」。
function learnTeach(text, who, scope) {
  const s = String(text || '').trim().slice(0, 600);
  if (!s) return { error: '没有内容' };
  return learnRecord('有人教了我一件事', s,
    '来源：' + String(who || '有人') + ' 口述。核实状态：未核实，不许当事实；'
    + '跟已核实资料冲突时按正确知识说，如实指出哪里不对。', scope);
}

// 官方资料直取：核实状态＝已核实。只有免 Key 的官方源才调这里，抓来的网页不沉淀。
// 落「联网」那份（全范围通用），不绑某个群。
function learnAuto(query, text, source, scope) {
  const s = String(text || '').trim().slice(0, 600);
  if (!s) return { error: '没有内容' };
  return learnRecord('查到：' + String(query || '').replace(/[\n\r]/g, ' ').slice(0, 30), s,
    '来源：' + String(source || '官方资料') + ' 直取。核实状态：已核实。', scope || LEARN_OFFICIAL);
}


// 只检索「学到的」：跟攻略数据分开注入。
// 读哪几份：本轮所在范围那份 + 「联网」那份（官方直取的事实跟场合无关）。
// 攻略段的规矩是「只依据原文照抄数值、最多两句、不许寒暄」，套到别人口述的一句话上会答非所问。
// 复用同一个 load() / grams() / cache，不是第二套检索器。
function learnSearch(query, scope, topK = 2, maxChars = 900, minRatio = 0) {
  load();
  if (!cache || !cache.length) return '';
  const qText = minRatio > 0 ? String(query || '').replace(ASK_STOP, ' ') : String(query || '');
  const q = grams(qText);
  if (!q.size) return '';
  const gw = gramWeights(q, cache);
  // 梗词句.md 是「记录的 · 学到的 · 梗词句」的正本（主人 2026-11-13），跟学到的走同一个检索器
  const want = new Set([learnFileOf(scope), learnFileOf(LEARN_OFFICIAL), '梗词句.md']);
  const scored = [];
  for (const s of cache) {
    if (!want.has(s.file)) continue;
    let hit = 0;
    for (const x of q) if (s.g.has(x)) hit++;
    if (!hit) continue;
    // 和攻略同一道门槛：按权重算覆盖率，不够就不给（每轮检索只喂命中的，2026-11-13）
    // 例外（2026-11-21 冰冰冰事故）：**问的就是这一节的名字** —— 标题原样出现在问题里，
    // 说明对方在问「X 是什么」，那就直接给，别被覆盖率门槛挡掉（「冰冰冰是什么意思」实测被 0.45 挡住过）。
    const flat = x => String(x || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const tFlat = flat(s.title), qFlat = flat(qText);
    const byTitle = tFlat.length >= 2 && qFlat.indexOf(tFlat) >= 0;
    if (minRatio > 0 && !byTitle && weightedRatio(q, s.g, gw) < minRatio) continue;
    scored.push({ s, score: hit });
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.score - a.score);
  let out = '';
  for (const { s } of scored.slice(0, topK)) {
    // 文件头（# 学到的（群…） + 几行 > 说明）不进提示词：命中一条就白带上几十字
    let body = String(s.body || '').replace(/^#\s*学到的（[^）]*）\s*(?:\n>.*)*\s*/, '').trim();
    // 每条自带的元信息行（> 时间 / > 来源 / > 分类 / > 核实）也不进提示词——
    // 署名和核实状态是面板里看的，模型只需要「这句话什么意思、怎么用」（少 token，主人 2026-11-13）。
    body = body.replace(/^>.*(?:\n|$)/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    const block = `### ${s.title}\n${body}\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

// ===== 攻略标记 + 管理（每份攻略第一行带 `<!-- guide:xxx -->`；客户端「攻略」页走这里增删改）=====
// 缺标记不报、不私信：guideHeal 自己补。这里的状态只给自检 / 客户端显示用。
function guideStatus() {
  const found = [], lost = [];
  for (const f of guideFiles()) {
    const slug = f.replace(/\.md$/i, '');
    let raw = '';
    try { raw = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { raw = ''; }
    (hasMark(raw) ? found : lost).push(slug);
  }
  return { found, lost };
}

// 列表（客户端「攻略」页用）：名称 / 小节数 / 字数 / 是否标记 / 是否自动生成
function guideList() {
  const mine = masterKeys();
  return guideFiles().map(f => {
    const slug = f.replace(/\.md$/i, '');
    let raw = '';
    try { raw = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { raw = ''; }
    const by = byOf(raw);
    return {
      name: slug, file: f,
      sections: (raw.match(/^##+\s+/gm) || []).length,
      chars: raw.length,
      marked: hasMark(raw),
      by,
      mine: !!by && mine.has(by),
      auto: isAutoGuide(f),
    };
  });
}

// 静默自愈：所有 data/guides/*.md 缺标记就补上，不通知、不报错打扰主人。
// 目录没变就跳过（启动时、客户端打开攻略页时各调一次，几乎零开销）。
let healKey = '';
function sigOf(files) {
  return files.map(f => {
    try { return f + ':' + fs.statSync(path.join(DIR, f)).mtimeMs; } catch { return f + ':0'; }
  }).join('|');
}
function guideHeal() {
  const files = guideFiles();
  const key = sigOf(files);
  if (key === healKey) return { fixed: [] };
  const fixed = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/i, '');
    try { if (ensureMark(path.join(DIR, f), slug)) fixed.push(slug); }
    catch (e) { console.error('[guides] 补标记失败 ' + f + '：' + e.message); }
  }
  healKey = sigOf(files);
  if (fixed.length) { cache = null; stamp = 0; }
  return { fixed };
}

// 读一份攻略的完整原文（客户端编辑时用；带标记也一并返回，保存时再规整）
function guideRead(name) {
  const slug = sanitizeName(name);
  if (!slug) return { error: '攻略名不能为空' };
  const file = path.join(DIR, slug + '.md');
  if (!fs.existsSync(file)) return { error: '找不到攻略「' + slug + '」' };
  try { return { ok: true, name: slug, content: fs.readFileSync(file, 'utf8') }; }
  catch (e) { return { error: e.message }; }
}

// 写 / 新建一份攻略：第一行强制带上 `<!-- guide:xxx -->` 标记（漏了自动补、多份会去重）
function guideWrite(name, content, by) {
  const slug = sanitizeName(name);
  if (!slug) return { error: '攻略名只能是中文 / 字母 / 数字 / 下划线' };
  const file = path.join(DIR, slug + '.md');
  let body = String(content == null ? '' : content)
    .replace(/<!--\s*guide:[^>]*-->/gi, '')
    .replace(BY_RE, '');
  // 没显式传署名就沿用文件里原有的（编辑器里看不到那行注释，不能一保存就丢）
  let sig = String(by == null ? '' : by).trim();
  if (!sig) { try { if (fs.existsSync(file)) sig = byOf(fs.readFileSync(file, 'utf8')); } catch {} }
  if (!/^#\s/m.test(body)) body = '# ' + slug + '\n\n' + body;
  const out = markOf(slug) + '\n' + (sig ? byMark(sig) + '\n' : '') + body.replace(/^\s+|\s+$/g, '') + '\n';
  try { writeFileAtomic(file, out); }
  catch (e) { return { error: '写文件失败：' + e.message }; }
  cache = null; stamp = 0;
  return { ok: true, file: path.join('data', 'guides', slug + '.md'), name: slug };
}

/* 改一份攻略的署名（不动正文）。by 传空串 = 清掉署名。 */
function guideSetBy(name, by) {
  const slug = sanitizeName(name);
  if (!slug) return { error: '攻略名不能为空' };
  const file = path.join(DIR, slug + '.md');
  if (!fs.existsSync(file)) return { error: '找不到攻略「' + slug + '」' };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: '读不出来：' + e.message }; }
  const sig = String(by == null ? '' : by).trim();
  const body = raw.replace(/<!--\s*guide:[^>]*-->\s*/gi, '').replace(BY_RE, '');
  const out = markOf(slug) + '\n' + (sig ? byMark(sig) + '\n' : '') + body.replace(/^\s+|\s+$/g, '') + '\n';
  try { writeFileAtomic(file, out); }
  catch (e) { return { error: '写文件失败：' + e.message }; }
  cache = null; stamp = 0;
  return { ok: true, name: slug, by: sig };
}

// 删一份攻略（2026-11-13 起自动生成的也能删，客户端要点两下确认）
function guideDelete(name) {
  const slug = sanitizeName(name);
  if (!slug) return { error: '攻略名不能为空' };
  // 2026-11-13 主人要「编辑/看原文/删」对自动落的也开放；删除照旧要点两下（客户端 arm），不做硬拦。
  const file = path.join(DIR, slug + '.md');
  if (!fs.existsSync(file)) return { error: '找不到攻略「' + slug + '」' };
  try { fs.unlinkSync(file); } catch (e) { return { error: '删不掉：' + e.message }; }
  cache = null; stamp = 0;
  return { ok: true, name: slug };
}

// 给客户端 IPC 用的统一入口（main.js 直接转调，不另写一套）
function api(action, payload) {
  const p = payload || {};
  switch (action) {
    case 'list': guideHeal(); return { ok: true, list: guideList() };
    case 'status': { guideHeal(); const s = guideStatus(); return { ok: true, found: s.found, lost: s.lost }; }
    case 'read': { const r = guideRead(p.name); return r.ok ? r : { error: r.error }; }
    case 'write': { const r = guideWrite(p.name, p.content, p.by); return r.ok ? r : { error: r.error }; }
    case 'setby': { const r = guideSetBy(p.name, p.by); return r.ok ? r : { error: r.error }; }
    case 'delete': { const r = guideDelete(p.name); return r.ok ? r : { error: r.error }; }
    default: return { error: '未知操作：' + action };
  }
}

/* ===== 梗教学正本（data/guides/梗词句.md）=====
 * 2026-11-21 冰冰冰事故：主人教的「看到X时直接发一句Y」只落了条目副本，词义/来源没有正本，
 * 面板「记录的 · 学到的 · 梗词句」里查不到这条梗，跨群也读不到。这个方法就是补那一节。
 * 落点：data/guides/梗词句.md（learnSearch 会检索它；kb.items 把整份判成「梗词句」）。
 * 和 teach/梗词句.jsonl 的分工：那份是带署名的条目（可复核/可删/按在场判定），
 * 这份是词义正本（谁都能读）。去重按节标题：同一句再教一次不会堆两节。 */
const MEME_NOTE_FILE = '梗词句.md';
const MEME_NOTE_HEAD = '<!-- guide:梗词句 -->\n<!-- by:qq:1000000002 -->\n# 梗词句\n\n'
  + '> 这是干什么的：「记录的 · 学到的 · 梗词句」正本。每条 = 词义解析 + 固定梗句用法及示例 + 网络梗含义。\n'
  + '> 只在有人说到这个词时才读命中那一条，不整份塞提示词。\n';
function memeNote(o) {
  o = o || {};
  const title = String(o.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 40);
  const body = String(o.body || '').trim().slice(0, 900);
  if (!title) return { error: '梗名为空' };
  if (body.length < 8) return { error: '正文不到 8 个字，不记' };
  const p = path.join(DIR, MEME_NOTE_FILE);
  let raw = '';
  try { raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch (e) { return { error: '读梗词句.md 失败：' + e.message }; }
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('^#{2,3}\\s*' + esc + '\\s*$', 'm').test(raw)) {
    return { ok: false, dup: true, file: 'data/guides/' + MEME_NOTE_FILE };
  }
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sec = `## ${title}\n> 时间：${time}\n> 来源：${String(o.source || '主人 口述').replace(/[\r\n]+/g, ' ').slice(0, 60)}\n`
    + `> 分类：梗词句\n> 核实：未核实（等主人手动确认）\n\n${body}\n`;
  const base = raw.trim() ? raw.replace(/\s*$/, '') : MEME_NOTE_HEAD.replace(/\s*$/, '');
  try { writeFileAtomic(p, base + '\n\n' + sec); }
  catch (e) { return { error: '写梗词句.md 失败：' + e.message }; }
  cache = null; stamp = 0;      // 下次检索立刻能查到刚写的这条
  return { ok: true, file: 'data/guides/' + MEME_NOTE_FILE };
}

module.exports = { search, coverage, titleHit, memeHit, memeHowto, memeGeneral, memeFullHit, guideAppend,
  memeNote,
  memeList: loadMemes, memeAdd, memeUpdate, memeDel, glossaryHit, memeWordHit, memeOverview,
  guideStatus, guideHeal, guideList, guideRead, guideWrite, guideDelete, guideSetBy, byOf, api, reset,
  learnTeach, learnAuto, learnSearch,
  learnFileOf, learnScopeOf, learnPathOf, isAutoGuide,
  learnPath: () => learnPathOf(LEARN_OFFICIAL) };
