'use strict';
/*
 * teach.js —— 别人（含主人）教给虚幻的知识，带 id 署名，只在教的人在场的会话里用。
 *
 * 主人 2026-11-12 定：
 *   · 群里那句「下次遇到有人说"刀盾"直接回复"我的刀盾"」要真的录入并生效；
 *   · 列表每条带教学者的 id 署名；
 *   · 只在对方**在场**的私聊 / 群聊里使用（在场按群成员名单，qq.js 取）；
 *   · 涵盖 梗词句 / 游戏攻略 / 情绪表达，按方向不同另存（主人 2026-11-13 定死三类）；
 *   · 「不建双份，但可按方向不同另存」：一条只落在一个方向文件里，改方向时物理搬走。
 *
 * 和约定的边界（主人同日定「Ciallo 照常算约定」「约定保持原样」）：
 *   说话方式类（句尾/称呼/语气）继续走 core.pactOf / pactAdd，本模块不碰、不改 onlyRules。
 *   「碰到 X 就回 Y」这类场景约定也留在 topics.jsonl；这里只给它们打 dir 展示，不复制数据。
 *
 * 免记录群（noRecordGroups，如赛博鱼塘②塘 100000000）：教学照常落盘。
 *   core.topicAdd 的 kind=promise 拦截、qq.js 的 !noRec 都不经过这里。
 */
const fs = require('fs');
const path = require('path');
const people = require('./people');
const review = require('./review');   // 2026-11-12：三类知识共用复核/锁定/证据快照

const DIR = path.join(__dirname, 'data', 'teach');
const TOPICS = path.join(__dirname, 'data', 'topics.jsonl');

// 方向分区：新增方向只在这里加一项，文件自动跟着生成，不用改读写逻辑。
// 主人 2026-11-13 定死三类：「改成：游戏攻略、情绪表达、梗词句（词义解析）」。
// 「梗词句」= 词义解析 / 固定梗句用法及示例 / 网络梗含义，一个文件里放。
// 「其他」不再是方向，只作拆不出类时的落点（文件名 other.jsonl，前端不列这一格，能手动搬走）。
const DIRS = ['游戏攻略', '情绪表达', '梗词句'];
const OTHER_DIR = '其他';
// 未来与「说话方式」同级别的约定分区（主人 2026-11-12 列举）。现在只登记口径，
// 不预先造空分类；识别到时归到对应名字，别把身份/情绪/禁止类塞进「说话方式」。
const SECTIONS = ['说话方式', '身份认知', '情绪认知与应对', '禁止回复', '常态情绪', '代称'];
/* 「约定」六个同级分区真正用起来（主人 2026-11-13：「后续「约定」类增加应分类归入」）。
 * 新增约定自动落一个分区；判不准的一律落「说话方式」（老口径不变），前端还能手动改。
 * 顺序有意义：禁止回复先判（「不许回」常同时带情绪词）。 */
const SECTION_RULES = [
  ['禁止回复', /(不许回|不要回|别回|禁止回|不能回|不许说|不要说|别提|不许提|不要叫|别叫|不许回答|别回答|禁言)/],
  ['身份认知', /(你是谁|你是什么|身份|你不是|你叫什么|记住你是|你就是|你其实是|作为.{0,6}(bot|机器人|幽灵))/],
  ['情绪认知与应对', /(难过|伤心|生气|委屈|害怕|焦虑|哭|安慰|哄|心情不好|低落|别不理|陪我|抱抱|焦虑|崩溃)/],
  ['常态情绪', /(平时|日常|一般|心情|状态|情绪|开心|高兴|活泼|温柔|安静|元气)/],
  ['代称', /(叫我|称呼|代称|你就叫|喊我)/],
];
function sectionOf(text, hint) {
  const t = String(text || '');
  if (SECTIONS.indexOf(String(hint || '')) >= 0) return String(hint);
  for (const [name, re] of SECTION_RULES) if (re.test(t)) return name;
  return '说话方式';
}

/* 内容落到哪一类（三类：游戏攻略 / 情绪表达 / 梗词句）。
 * md 里没写「> 分类：」时用它兜底；判不出的一律梗词句（主人 2026-11-13 定的三类，没有第四类）。 */
function guessDir(text) {
  const t = String(text || '');
  if (DIR_GAME.test(t)) return '游戏攻略';
  if (DIR_EMO.test(t)) return '情绪表达';
  return '梗词句';
}

const DIR_GAME = /(攻略|游戏|打法|关卡|副本|出装|阵容|配队|技能|boss|怎么打|怎么过|任务|掉落|build)/i;
const DIR_EMO = /(情绪|心情|生气|难过|哭|安慰|哄|道歉|开心|委屈|害怕|安慰我|别理我|不许回)/;
const NOTE_RE = /(别解释|不要解释|不用解释|不解释|别多说|不要多说|不许解释|只回|只发这一个|不用加别的)/;
// 说话方式类一律让位给约定，不进教学列表（Ciallo 那条口径）
const STYLE_RE = /(结尾|句尾|末尾|加个|加上|带上|叫我|称呼|语气|口癖|你以后.*都说)/;
const LEAD_RE = /(下次|以后|往后|从现在起|碰到|遇到|看到|看见|听到|听见|只要|如果|要是|有人说|有人发|有人问|有人提)/;
const DO_RE = /(?:直接|马上|就|便|都|你)?\s*(?:回复|回一句|回|说一句|说|喊|发一句|发|刷一句|刷|答)/;
const QUOTE_RE = /[「“"『']([^」”"』']{1,60})[」”"』']/g;
const NUM_SPLIT = /(?:^|[\s，。；、])\s*\d{1,2}\s*[.．、)）]\s*/;

/* 从「梗百科长文」里抽出固定用法句（2026-11-21 冰冰冰失效事故）。
 * 主人常整段贴梗百科（几百字），里面只有一句是「看到X时，直接发一句Y」这种要照做的；
 * 整段落库会污染，所以先把它抽成短句，再交给 parse 走正常流程。
 * 只认「条件句 + 明确的照做动词（直接发一句/直接回复/直接刷）」；没有就不动，交回原逻辑。 */
const FIXED_USE_RE = /(?:看到|看见|碰到|遇到|听到|听见|有人说|有人发|提到)[^。！？\n]{0,60}?(?:时|的时候)?\s*[,，]?\s*(?:就)?\s*(?:直接|马上)?\s*(?:发一句|回一句|回复一句|刷一句|回|回复|发|刷)\s*[：:]?\s*[「“"『'][^」”"』']{1,40}[」”"』']/;
function fixedUseOf(raw) {
  const s = String(raw || '');
  if (s.length <= 200) return '';                 // 短文不用抽，parse 自己能处理
  const m = s.match(FIXED_USE_RE);
  return m ? m[0].trim() : '';
}
// 「看到鬼畜视频、ai音乐、司凤音乐时」这种顿号列举，拆成多个触发词，各自都能命中
function splitWhen(w) {
  const s = String(w || '').replace(/(?:的)?(?:时|时候)$/, '').trim();
  if (!/[、,，/]/.test(s)) return [s].filter(x => x.length >= 2);
  return s.split(/[、,，/]/).map(x => x.trim()).filter(x => x.length >= 2);
}

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const lines = p => read(p).split('\n').filter(Boolean);
const jsonLines = p => lines(p).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
const fileOf = dir => path.join(DIR, (DIRS.indexOf(dir) >= 0 ? dir : OTHER_DIR) + '.jsonl');
const norm = s => String(s || '').toLowerCase()
  .replace(/[\s\u3000，。！？、；：~～…·,.!?;:'"“”‘’()（）【】\[\]「」『』/\\|<>《》\-—]/g, '');

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} }

/* 这句是不是「教了一条知识」。返回 {dir, when, say, note} 或 null。
 * 判据：有教学引子 + 有「回/回复/说」的动作 + 能抽出要原样说的话 + 不是说话方式。 */
function parse(raw) {
  let src = String(raw || '').replace(/@\d{5,12}\s*/g, ' ').replace(/\[图片\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // 梗百科长文：先抽出「看到X时直接发一句Y」那句，用短句走下面的解析
  const fixed = fixedUseOf(src);
  if (fixed) src = fixed;
  const t = src;
  if (!t || t.length > 200) return null;
  if (STYLE_RE.test(t)) return null;                 // 说话方式交给 core.pactOf
  if (!LEAD_RE.test(t) || !DO_RE.test(t)) return null;

  // 引号内容先整段收好：回话里带「答 / 回 / 说」这类字时，按动词扫描会把内容切断
  // （CRUD 自测真事：「直接回复『自测答』」被切成「」」）。有引号就按引号取，不扫动词。
  const quoted = [];
  let m;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(t))) quoted.push(m[1].trim());

  let say = '', when = [];
  if (quoted.length >= 2) {
    when = [quoted[0].slice(0, 24)];             // 第一个引号 = 触发词
    say = quoted[quoted.length - 1];             // 最后一个引号 = 要原样说的话
  } else if (quoted.length === 1) {
    say = quoted[0];
  } else {
    // 没引号：取最后一个引导动作词之后，截到句读
    let leadAt = -1;
    const anyDo = /(?:回复|回一句|回|说一句|说|喊|发|答)/g;
    anyDo.lastIndex = 0;
    let d;
    while ((d = anyDo.exec(t))) leadAt = d.index + d[0].length;
    say = leadAt >= 0 ? t.slice(leadAt).split(/[，。；、,;\n]/)[0] : '';
  }
  say = String(say).replace(/^[：:\s一句个两二三四五六七八九十]+/, '')
    .replace(NOTE_RE, '').replace(/(就行|就好|即可|的说|吧)$/, '')
    .replace(/[，。；;、\s]+$/, '').trim().slice(0, 60);
  if (!say) return null;

  // when：编号列表 > 第一个引号 > 「有人说/碰到」后面那截
  if (NUM_SPLIT.test(t) && quoted.length < 2) {
    when = t.split(NUM_SPLIT).slice(1)
      .map(x => x.replace(/[（(][^）)]{0,30}[）)]/g, ' ')
        .replace(/[，。；;,].*$/, '').trim().slice(0, 24))
      .filter(x => x.length >= 2).slice(0, 40);
  }
  if (!when.length) {
    const wm = t.match(/(?:有人说|有人发|有人问|有人提|碰到|遇到|看到|看见|听到|听见|提到)([^，。；,;就再便直接]{1,24})/);
    if (wm) {
      const w = wm[1].replace(/[「“"『'」”"』']/g, '')
        .replace(/^(这些|那些|这个|那个|这种|那种|有人)/, '').trim();
      if (w.length >= 2) when = [w.slice(0, 24)];
    }
  }
  // 两个引号时，第一个引号里的触发词比整句截取更准
  if (quoted.length >= 2 && norm(quoted[0]).length >= 2) when = [quoted[0].slice(0, 24)];
  // 顿号列举的触发词拆开：「鬼畜视频、ai音乐、司凤音乐时」→ 三个各自能命中
  if (when.length === 1) when = splitWhen(when[0]);
  if (!when.length) return null;                    // 没触发条件的只是闲聊，不收

  const note = (t.match(NOTE_RE) || [])[1] || '';
  let dir = '梗词句';
  if (DIR_GAME.test(t)) dir = '游戏攻略';
  else if (DIR_EMO.test(t)) dir = '情绪表达';
  else if (say.length > 30) dir = OTHER_DIR;
  return { dir, when, say, note };
}

/* 一条只落在一个方向文件里。同一教学者 + 同一句回话 + 同一触发词 视为重复。 */
function add(o) {
  const src = o || {};
  const d = src.parsed || parse(src.text);
  if (!d) return null;
  const rawQq = String(src.qq || '').trim();
  if (!rawQq) return null;
  let qq = rawQq;
  try { qq = people.keyOf(rawQq) || rawQq; } catch {}   // 统一成 platform:id 署名
  // 按人查（2026-11-13 主人定：「按人查，不是按号查」）：署名同时记 pid，
  // 生效/在场判定都走人——他换号说同一句话照样算他的，不会因为号不同就失效。
  let pid = '';
  try { pid = people.pidOfKey(qq) || ''; } catch {}
  for (const x of listAll()) {
    if (x.fromPact) continue;
    const sameGuy = pid ? (String(x.pid || '') === pid) : (String(x.qq) === qq);
    if (sameGuy && String(x.say) === d.say
      && String((x.when || [])[0] || '') === String(d.when[0] || '')) return null;
  }
  ensureDir();
  const it = {
    id: 'teach_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
    t: src.t || new Date().toISOString(),
    qq,                                   // 署名：platform:id（原号，可核验）
    pid,                                  // 署名的人（按人查用这个）
    nick: String(src.nick || '').slice(0, 40),
    scope: String(src.scope || '').slice(0, 40),
    dir: d.dir,
    when: d.when.slice(0, 40),
    say: d.say,
    note: d.note,
    text: String(src.text || '').slice(0, 200),
    src: String(src.src || '').slice(0, 80),      // 从哪条消息来的，可核验
    by: src.by === 'author' ? 'author' : (src.by === 'master' ? 'master' : 'other'),
    /* 两条轴的单条覆盖：只写显式传进来的，没传就沿用方向默认。
     * 2026-11-20 主人纠正：梗词句是「认梗」的，谁说到都算，**不要**给约定副本强塞
     * retrieval:false / present:true——那等于让它认不出梗。强制只在 pactLines（按人取）。
     * 这个覆盖能力留着：将来某条真需要单独改轴时还能用。 */
    ...(src.retrieval === undefined ? {} : { retrieval: !!src.retrieval }),
    ...(src.present === undefined ? {} : { present: !!src.present }),
    // 复核（2026-11-12）：新录入一律 pending，附 5 条相关原记录供主人确认归属/内容。
    // 老数据不带这个字段 = legacy，点开时按需补证据，不一次性扫全库。
    review: review.fresh({ legacy: false }),
  };
  review.attachEvidence(it);                      // 快照存条目上；chat-log.jsonl 一行不动
  fs.appendFileSync(fileOf(d.dir), JSON.stringify(it) + '\n', 'utf8');
  return it;
}

/* 客户端列表：自有条目 + 约定里打了 dir 的条目（只读展示，不复制一份数据）。 */
/* 客户端列表：只列 teach 文件里的真条目（2026-11-20）。
 * 以前还把 topics.jsonl 里带 dir 的约定合成一条「只读展示」，结果面板删它删不动
 * （数据不在这个文件里），前端把格子拿掉、刷新又回来——就是主人说的「后端没同步」。
 * 约定本体归「约定」页；约定同步到梗词句的副本由 pactAdd 写进本文件夹，是独立一行，删得掉。 */
function listAll() {
  ensureDir();
  const out = [];
  for (const dir of DIRS.concat([OTHER_DIR])) {
    if (!fs.existsSync(fileOf(dir))) continue;
    for (const x of jsonLines(fileOf(dir))) {
      review.ensure(x, { legacy: true });
      out.push(Object.assign({}, x, { dir, readonly: false }));
    }
  }
  return out;
}

function find(id) {
  for (const dir of DIRS.concat([OTHER_DIR])) {
    const p = fileOf(dir), rows = jsonLines(p);
    const i = rows.findIndex(x => String(x.id) === String(id));
    if (i >= 0) return { dir, p, rows, i, it: rows[i] };
  }
  return null;
}
const writeRows = (p, rows) => fs.writeFileSync(p, rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''), 'utf8');

function edit(id, patch, opt) {
  const f = find(id);
  if (!f) return null;
  // 锁定后一切编辑硬拒；本人改口通道不走这里（是删旧条 + 生成新条）。
  const g = (opt && opt.byAuthor) ? { ok: true } : review.guard(f.it);
  if (!g.ok) return null;
  const o = patch || {};
  const next = Object.assign({}, f.it, {
    say: String(o.say || f.it.say).slice(0, 60),
    when: Array.isArray(o.when) ? o.when.slice(0, 40).map(String) : f.it.when,
    note: String(o.note === undefined ? f.it.note : o.note).slice(0, 40),
    // 主人在前端「重新判断归属、修改内容」（2026-11-12）：作者署名 / 昵称 / 场合 / 原话都能改。
    qq: String(o.qq === undefined ? f.it.qq : o.qq).slice(0, 60),
    nick: String(o.nick === undefined ? f.it.nick : o.nick).slice(0, 40),
    scope: String(o.scope === undefined ? f.it.scope : o.scope).slice(0, 40),
    text: String(o.text === undefined ? f.it.text : o.text).slice(0, 200),
  });
  const dir = DIRS.indexOf(o.dir) >= 0 ? o.dir : f.dir;
  // 按人查（2026-11-13）：署名号改了，pid 跟着重算，别留下「号换了人还算他」的错配
  if (String(next.qq || '') !== String(f.it.qq || '')) {
    try { next.pid = people.pidOfKey(next.qq) || ''; } catch { next.pid = ''; }
  }
  // 两条轴的单条覆盖：只有显式传 true/false 才写死；传 null 才是「回到方向默认」。
  // 不传 = 保持原样（否则只切一条会把另一条悄悄重置回默认，2026-11-13 自测发现）。
  if (o.retrieval === null) delete next.retrieval; else if (o.retrieval !== undefined) next.retrieval = !!o.retrieval;
  if (o.present === null) delete next.present; else if (o.present !== undefined) next.present = !!o.present;
  if (dir === f.dir) { f.rows[f.i] = next; writeRows(f.p, f.rows); }
  else {                                        // 改方向 = 物理搬走，不留双份
    f.rows.splice(f.i, 1); writeRows(f.p, f.rows);
    next.dir = dir;
    ensureDir(); fs.appendFileSync(fileOf(dir), JSON.stringify(next) + '\n', 'utf8');
  }
  return Object.assign({}, next, { dir });
}
function delRaw(id) {
  const f = find(id);
  if (!f) return false;
  f.rows.splice(f.i, 1); writeRows(f.p, f.rows);
  return true;
}
function del(id, opt) {
  const f = find(id);
  if (!f) return false;
  const g = (opt && opt.byAuthor) ? { ok: true } : review.guard(f.it);
  if (!g.ok) return false;
  return delRaw(id);
}
/* 给 topics.jsonl 里某条约定打方向标记（够童！→ 梗）。只改这一条，不新增、不复制。 */
function markPactDir(id, dir) {
  const rows = jsonLines(TOPICS);
  const i = rows.findIndex(x => String(x.id) === String(id));
  if (i < 0 || DIRS.indexOf(dir) < 0) return false;
  if (!review.guard(rows[i]).ok) return false;
  rows[i].dir = dir;
  writeRows(TOPICS, rows);
  return true;
}

/* ===== 复核动作（主人 2026-11-12）=====
 * 全部落在条目自身的 review 字段；确认 = 锁定 + 删 5 条证据快照。 */
function confirm(id) {
  const f = find(id);
  if (!f) return null;
  review.lock(f.it, 'master');
  f.rows[f.i] = f.it; writeRows(f.p, f.rows);
  return review.stateOf(f.it) === review.LOCKED ? f.it : null;
}
function attach(id) {
  const f = find(id);
  if (!f) return null;
  review.attachEvidence(f.it);
  f.rows[f.i] = f.it; writeRows(f.p, f.rows);
  return f.it;
}
function setCredit(id, c) {
  const f = find(id);
  if (!f) return null;
  review.setCredit(f.it, c);
  f.rows[f.i] = f.it; writeRows(f.p, f.rows);
  return f.it;
}
/* 原作者本人在 QQ 里改口（主人选「旧条删掉 + 生成新条」）：
 * 锁定也放行 —— 这是唯一允许的解除方式。旧条物理删除，新条重新 pending + 5 条证据。 */
function reviseByAuthor(id, payload) {
  const f = find(id);
  if (!f) return null;
  const o = payload || {};
  const body = String(o.text || f.it.text || '');
  const next = {
    text: body,
    qq: String(f.it.qq || ''), nick: String(f.it.nick || ''),
    scope: String(f.it.scope || ''), src: String(o.src || ''),
    by: 'author', t: o.t,
  };
  // 改口常写成「不对，改成我的剑盾」——没有引号，parse() 拆不出来。
  // 这时沿用旧条的触发词/方向，只把「改成 X」或最后一个引号里的那截当新的回话。
  let parsed = parse(body);
  if (!parsed) {
    const qs = [...body.matchAll(/[「“"『']([^」”"』']{1,60})[」”"』']/g)];
    const gm = body.match(/(?:改成|换成|应该是|回|说)\s*([^\s，。！？,!?]{1,60})/);
    const say = (qs.length ? qs[qs.length - 1][1] : (gm ? gm[1] : '')) || String(f.it.say || '');
    parsed = { dir: f.it.dir || OTHER_DIR, when: (f.it.when || []).slice(), say, note: '' };
  }
  const added = add(Object.assign({}, next, { parsed }));
  if (!added) return null;                 // 新条拆不出来 → 旧条绝不先删
  delRaw(id);
  return added;
}

/* ===== 在场：由 qq.js 查群成员名单后塞进来（主人 2026-11-12 选的口径）===== */
const present = new Map();                       // k -> { at, ids:Set }
function setPresent(k, ids) {
  const set = new Set((ids || []).map(x => String(x).replace(/^[a-z]+:/, '')).filter(Boolean));
  present.set(String(k), { at: Date.now(), ids: set });
}
function presentOf(k) {
  const v = present.get(String(k));
  return v ? v.ids : new Set();
}
function bare(q) { return String(q || '').replace(/^[a-z]+:/, ''); }

/* ===== 两条轴（2026-11-13 主人定）=====
 * 她原话：「「检索式命中」和「在场就用」是交叉存在，相同点是署名。
 *          检索式命中：梗、游戏攻略。在场就用：梗、游戏攻略、情绪表达、等。
 *          我可以把「在场就用」的栏目/单独条目加入「检索式命中」。」
 * 所以每条按方向给默认值，单条可以覆盖（x.retrieval / x.present）：
 *   检索式命中 = 有人说到触发词就用，不要求本人在场；
 *   在场就用   = 教的人在场才可用（有触发词的要撞上，没触发词的就是整体生效）。
 * 两条都不带的条目不生效——这是主人显式关掉的意思。 */
const AXIS = {
  游戏攻略: { retrieval: true, present: true },
  情绪表达: { retrieval: false, present: true },
  梗词句: { retrieval: true, present: true },
};
/* 整栏切换（2026-11-13 主人：「我可以把「在场就用」的栏目 / 单独条目加入「检索式命中」」）。
 * 优先级：单条字段 > 栏目覆盖（axis.json）> 方向默认（AXIS）。
 * 存在 data/teach/axis.json，改完即时生效，不用重启；不塞进提示词。 */
const AXIS_FILE = path.join(DIR, 'axis.json');
function axisCfg() {
  try { return JSON.parse(fs.readFileSync(AXIS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function setAxisDir(dir, field, val) {
  const d = String(dir || '');
  if (!AXIS[d] && d !== OTHER_DIR) return null;
  if (field !== 'retrieval' && field !== 'present') return null;
  const all = axisCfg();
  const cur = all[d] || {};
  if (val === null || val === undefined) delete cur[field];
  else cur[field] = !!val;
  if (Object.keys(cur).length) all[d] = cur; else delete all[d];
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(AXIS_FILE, JSON.stringify(all, null, 1), 'utf8');
  } catch (e) { console.error('[teach] 轴配置写不进去：' + e.message); return null; }
  return all[d] || {};
}
function axisOf(x) {
  const dir = (x && x.dir) || '';
  const base = AXIS[dir] || { retrieval: false, present: true };
  const ov = axisCfg()[dir] || {};
  const d = {
    retrieval: ov.retrieval === undefined ? base.retrieval : !!ov.retrieval,
    present: ov.present === undefined ? base.present : !!ov.present,
  };
  return {
    retrieval: (x && x.retrieval === undefined) ? d.retrieval : !!x.retrieval,
    present: (x && x.present === undefined) ? d.present : !!x.present,
  };
}
/* 这个人名下所有平台的裸 id（按人查：他换号说同一句话照样算他的）。 */
function ownerIds(x) {
  const out = new Set();
  const pid = String((x && x.pid) || '');
  if (pid) {
    try { for (const a of people.accountsOf(pid)) out.add(String(a.id)); } catch {}
  }
  if (!out.size) out.add(bare(x && x.qq));
  return out;
}
function ownerHere(x, ids) {
  if (!ids || !ids.size) return false;
  for (const id of ownerIds(x)) if (ids.has(id)) return true;
  return false;
}

/* 最长公共片段：短条件要基本对上，长条件 4 字连上就算撞上（与 core.pactHit 同口径） */
function common(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let last = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? last + 1 : 0;
      if (prev[j] > best) best = prev[j];
      last = keep;
    }
  }
  return best;
}
function hit(when, text) {
  const a = norm(text);
  if (!a) return '';
  for (const w of when || []) {
    const b = norm(w);
    if (!b || b.length < 2) continue;
    if (a.includes(b) || b.includes(a)) return w;
    if (common(a, b) >= (b.length <= 4 ? b.length : 4)) return w;
  }
  return '';
}

/* 「直接回复」用：教的人在场且本轮撞上触发词 → 返回要原样说出口的那句（不走模型）。 */
function sayFor(k, text) {
  const ids = presentOf(k);
  if (!ids.size) return '';
  for (const x of listAll()) {
    if (!x.say) continue;
    if (!axisOf(x).present) continue;          // 检索式轴不负责「原样替他说」，只给提示词
    if (!ownerHere(x, ids)) continue;
    if (hit(x.when, text)) return String(x.say);
  }
  return '';
}

/* 本轮提示词：两条轴取并集，没命中、没在场就一个字都不加。
 *   检索式命中 → 撞上触发词就用（不要求本人在场）；
 *   在场就用   → 本人在场，有触发词的撞上就用，没触发词的整体生效。 */
function linesFor(k, text) {
  const ids = presentOf(k);
  const out = [];
  for (const x of listAll()) {
    if (!x.say) continue;
    const ax = axisOf(x);
    const h = hit(x.when, text);
    const noWhen = !(x.when || []).length;
    const byRetrieval = ax.retrieval && !!h;
    const byPresent = ax.present && ownerHere(x, ids) && (noWhen || !!h);
    if (!byRetrieval && !byPresent) continue;
    out.push('- 有人说到「' + (h || (x.when || [])[0] || '') + '」→ 原样回「' + x.say + '」，一个字一个标点都不许改'
      + (x.note ? '；' + x.note : '') + '。');
  }
  return out.join('\n');
}

module.exports = {
  DIRS, OTHER_DIR, SECTIONS, SECTION_RULES, sectionOf, guessDir, AXIS, AXIS_FILE, DIR, parse, add, listAll, edit, del, delRaw, markPactDir,
  axisOf, axisCfg, setAxisDir,
  confirm, attach, setCredit, reviseByAuthor, review, ownerIds,
  setPresent, presentOf, linesFor, sayFor, hit,
};
