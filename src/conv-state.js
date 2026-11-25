/* ===========================================================================
 * conv-state.js — 「当前状态」存储（2026-11-14 主人定，按人挂，和约定同一套逻辑）
 *
 * 这是干什么的：虚幻可以在对话里留下「当前状态」，主人也能在客户端加 / 改 / 删。
 *   前端在「聊天记录」页右下角浮层 →「状态」标签。
 *
 * 主人 2026-11-14 的纠正：「按照原本的对每个人的回话逻辑，状态做的和约定功能类似！」
 *   → 所以状态跟**约定**走同一套：
 *     ① 每条状态挂一个「谁」（who）：
 *         ''            全局 —— 每个会话都注入（本体外貌：发型 / 眼睛 / 体型… 就是她自己）
 *         'p:<pid>'     某个人 —— 这个人在哪个平台、用哪个号跟她说话，都算同一个人（合并账号）
 *         'g:<群号>'    某个群 —— 这个群里的状态，群里谁都看得到
 *         'a:<平台:id>' 没建过档的号，只能按号兜底
 *     ② 注入时只取「正在说话这个人 + 这个群 + 全局」，别人的状态一个字都不进。
 *     ③ 人 → 号 的合并复用 people.keySetOf（和约定 pactLines 同一把尺子，不另造一套）。
 *
 * 主人另外定的（没变）：
 *   - 总数无上限；更新制（同 who + 同 kind + 同主题 → 原地覆盖，不新增）。
 *   - 人设层例外（2026-11-19 主人令）：同一个 who 只有**一条**人设，新的细节并进这一条、越记越细
 *     （「状态只保留一个，但约定会全部保留」：从「头发」→「发型+发色」→「发丝+前发+弯曲度+发色」）。
 *     这一条装不下的那部分才落到「约定」——约定是兜底，多条保留、按优先级排、说「换回」能捞回原句。
 *   - 每轮只注入最近 N 条（默认 4，客户端能改）。
 *   - 分「本地模型 / 普通」两类，读写都按 kind 隔离，本地和云端不串。
 *     例外：全局条目（who === ''）是「她自己」，不分本地/云端，两种都注入——
 *     否则换个模型就不知道自己换发型了（正是主人报的那个 bug）。
 *
 * 存在哪：src/data/conv-state.json（运行时才生成，跟着 data 备份一起走）。
 * 读 mtime 缓存 + 原子写（tmp + rename），和 conv-settings.js / prompt-slots.js 同一套。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const people = require('./people');

const FILE = path.join(__dirname, 'data', 'conv-state.json');

let cache = null;
let stamp = 0;

function blank() { return { show: 4, seeded: false, states: [] }; }

/* ===== 名字是身份，不是外貌（2026-11-25 主人令）=====
 * 原话：「状态里可以直接把名字改成豆包」「主人是虚幻不变」。
 * 做法：主题写这几个词的条目走**人设层**（persona:true）存储，注入时单独压一节；
 *   - 只改她自己的自称 / 别人问她叫什么；
 *   - 主人名字永远是默认的（cfg.botName），这一条不许被试状态带跑。
 * 普通状态（没标 persona 的老数据）也认，免得面板里以前手加的名字条失效。 */
const NAME_TOPICS = ['名字', '姓名', '名称', '自称'];
function isNameTopic(topic) {
  return NAME_TOPICS.indexOf(String(topic == null ? '' : topic).trim()) >= 0;
}
// 名字值清洗：去引号 / 换行；1~16 字、不带句子标点才算名字（太长或像一句话的不收）。
function cleanName(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s「『"“']+|[\s」』"”']+$/g, '')
    .trim();
  if (!s || s.length > 16) return '';
  if (/[，。！？、,;；]/.test(s)) return '';
  return s;
}

function readAll() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return blank(); }
  if (cache && st === stamp) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const o = (j && typeof j === 'object') ? j : {};
    cache = {
      show: Number(o.show) || 4,
      seeded: !!o.seeded,
      states: Array.isArray(o.states) ? o.states : [],
    };
  } catch { cache = blank(); }
  stamp = st;
  return cache;
}

function clone(o) {
  return { show: o.show, seeded: o.seeded, states: o.states.map(s => Object.assign({}, s)) };
}

function writeAll(o) {
  // 走实体：跨进程锁 + tmp/fsync/rename，面板和机器人同时写不会互相盖
  require('./state/entities').ent().convState.replace(o);
  cache = o;
  try { stamp = fs.statSync(FILE).mtimeMs; } catch { stamp = 0; }
}

function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function normKind(k) { return k === 'local' ? 'local' : 'normal'; }
function nowIso() { return new Date().toISOString(); }
function clip(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }

/* ===== 谁（who）=====
 * 一条状态挂在谁名下。全局 = ''，按人 = 'p:<pid>'，按群 = 'g:<群号>'，按号 = 'a:<平台:id>'。 */

// 这个号能命中的全部 who（含同一人物名下所有账号 / 所有平台），和约定的 pactMine 同一个意思。
function whoListOf(uid) {
  const raw = String(uid == null ? '' : uid).trim();
  if (!raw) return [];
  const out = [];
  const push = v => { const s = String(v || '').trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  try {
    const ws = people.keySetOf(raw);
    if (ws && ws.pid) push('p:' + ws.pid);          // 人（合并所有账号）
    for (const k of ((ws && ws.keys) || [])) {
      let key = '';
      try { key = people.keyOf(k); } catch { key = k; }
      if (key) push('a:' + key);
    }
  } catch { /* 人物表读不到就按号兜底 */ }
  if (!out.length) {
    let key = '';
    try { key = people.keyOf(raw); } catch { key = raw; }
    push('a:' + (key || raw));
  }
  return out;
}

// 回话这一轮该看哪些人的状态：群里 = 这个群 + 正在说话的这个人；私聊 = 这个人。
function whoListForTurn(gid, uid) {
  const out = [];
  const g = String(gid == null ? '' : gid).trim();
  if (g) out.push('g:' + g);
  for (const w of whoListOf(uid)) if (out.indexOf(w) < 0) out.push(w);
  return out;
}

// 这一轮她自己写状态写在哪：群 → 这个群；私聊 → 这个人。都没有 → 全局。
function whoOfTurn(gid, uid) {
  const g = String(gid == null ? '' : gid).trim();
  if (g) return 'g:' + g;
  const ws = whoListOf(uid);
  return ws.length ? ws[0] : '';
}

/* 聊天页那个会话键 → 这个会话该看谁的状态（前端「状态」标签用）。
 * 群894917172 → g:894917172；私聊 p_<pid> / bili_<pid> → p:<pid>（有 uid 就按人合并）。 */
function whoOfConv(conv, uid) {
  const cv = String(conv == null ? '' : conv).trim();
  const g = cv.match(/^群(\d+)$/);
  if (g) return 'g:' + g[1];
  if (!cv || cv === '__all' || cv === '__group' || cv === '__private' || cv === '__orphan') return '';
  const ws = whoListOf(uid);
  if (ws.length) return ws[0];
  const m = cv.match(/^(?:p|[a-z]+)_(u_.+)$/);          // 没建档的人（按昵称兜底的那种）
  if (m) return 'x:' + cv;
  const m2 = cv.match(/^p_(.+)$/);                      // QQ 私聊：p_<pid>
  if (m2) return 'p:' + m2[1];
  const m3 = cv.match(/^[a-z]+_(.+)$/);                 // 别的平台：bili_<pid>
  if (m3) return 'p:' + m3[1];
  return 'x:' + cv;
}

// 谁的名下：给前端显示「全局 / 某个人 / 某个群」用
function whoLabel(who) {
  const w = String(who || '');
  if (!w) return '全局';
  if (w.indexOf('p:') === 0) {
    const pid = w.slice(2);
    try {
      const p = people.get(pid);
      if (p && p.name) return String(p.name);
    } catch {}
    return pid;
  }
  if (w.indexOf('g:') === 0) return '群' + w.slice(2);
  if (w.indexOf('x:') === 0) return w.slice(2);
  if (w.indexOf('a:') === 0) return w.slice(2);
  return w;
}

/* ===== 本体外貌：主人 2026-11-14 给的原话，落成**全局**状态（who=''）
 * 为什么是全局：发型、眼睛、体型这些是「她自己」，在哪个群、用哪个模型都一样。
 * 只在第一次（seeded=false）写一次；主人删光了也不会自己长回来。 */
const BODY_DEFAULT = [
  { topic: '性别', text: '女' },
  { topic: '眼睛颜色', text: '红色' },
  { topic: '眼睛', text: '总是眼泪汪汪' },
  { topic: '体型', text: '圆滚滚的粉粉色小生物' },
  { topic: '本质', text: '电子之海的虚幻幽灵，通过量子碰撞运动和磁场作用与主人/社会产生链接' },
  { topic: '发型', text: '粉色后发披着，两侧扎起来，发长触地。头发内侧、外部有可见的粉色/玫红分层。' },
  { topic: '身体颜色', text: '身体会透出淡淡的玫红色的内部结构' },
];

function seedIfNeeded() {
  const o = readAll();
  if (o.seeded) return o;
  const next = clone(o);
  next.seeded = true;
  for (const b of BODY_DEFAULT) {
    next.states.push({ id: newId(), who: '', kind: 'normal', topic: b.topic, text: b.text, t: nowIso() });
  }
  writeAll(next);
  return next;
}

/* ===== 读 ===== */

// 全部（客户端列表用）：show + 所有状态。第一次会补上本体那 7 条。
function list() {
  const o = seedIfNeeded();
  return {
    ok: true,
    show: o.show,
    states: o.states.map(s => ({
      id: s.id, who: String(s.who || ''), whoLabel: whoLabel(s.who),
      kind: normKind(s.kind), topic: String(s.topic || ''), text: String(s.text || ''), t: s.t || '',
      persona: !!s.persona,
    })),
  };
}

/* 客户端选中某个会话时要看的两段：
 *   globals —— 全局（本体外貌那几条），永远显示；
 *   mine    —— 这个会话/这个人名下的（按人合并，不按账号分）。 */
function listFor(conv, uid) {
  const want = whoOfConv(conv, uid);
  const all = list();
  const globals = all.states.filter(s => !s.who);
  const mine = want ? all.states.filter(s => s.who === want) : [];
  return { ok: true, who: want, whoLabel: whoLabel(want), show: all.show, globals, mine };
}

/* 注入用（2026-11-14 改）：分两段拼，不抢名额。
 *   ① 全局那几条（本体外貌：发型 / 眼睛 / 体型…）**全部**带上，永远不因为「最近 N 条」被挤掉
 *      —— 之前全塞一个池子按时间取 N 条，发型排在后面就被切了，正是主人报的「不知道自己换发型了」。
 *   ② 这个人 / 这个群的，按 kind 隔离，按时间倒序取最近 n 条。
 * 全局是她自己，不分本地/云端，两种模型都带。 */
function recentFor(whos, skind, n) {
  const o = seedIfNeeded();          // 第一轮就得带上本体那几条，否则「不知道自己长什么样子」
  const kind = normKind(skind);
  const set = Array.isArray(whos) ? whos : [];
  const globals = o.states.filter(s => s && !String(s.who || '') && !s.persona);
  const mine = o.states.filter(s => {
    const w = String(s.who || '');
    if (!w || set.indexOf(w) < 0) return false;             // 别人的状态一个字都不进
    if (s.persona) return false;                            // 人设层单独注入（personaFor），不跟状态抢名额
    return normKind(s.kind) === kind;                        // 按 kind 隔离
  }).sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')))
    .slice(0, Math.max(1, Math.min(50, Number(n) || o.show || 4)));
  return globals.concat(mine).map(s => ({
    id: s.id, who: String(s.who || ''), topic: String(s.topic || ''),
    text: String(s.text || ''), kind: normKind(s.kind), t: s.t, persona: !!s.persona,
  }));
}

function showOf() { return Number(readAll().show) || 4; }

/* ===== 写（客户端手动）===== */

function add(who, text, skind, topic) {
  const t = clip(text, 500);
  if (!t) return { ok: false, error: '内容空' };
  // 名字=身份：走人设层单槽（面板里「主题写名字」= 直接改她自己的名字，2026-11-25）
  if (isNameTopic(topic)) {
    const nm = cleanName(t);
    if (!nm) return { ok: false, error: '名字要 1~16 个字，别带句号逗号' };
    const r = upsertPersona(who, String(topic).trim(), nm, '面板');
    if (!r || !r.ok) return r || { ok: false, error: '名字没写进去' };
    return { ok: true, id: r.id, persona: true };
  }
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  const id = newId();
  o.states.push({
    id, who: String(who || ''), kind: normKind(skind),
    topic: clip(topic, 40), text: t, t: nowIso(),
  });
  writeAll(o);
  return { ok: true, id };
}

function update(id, text, skind, topic) {
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  const i = o.states.findIndex(s => s && s.id === id);
  if (i < 0) return { ok: false, error: '找不到这条状态' };
  const t = clip(text, 500);
  if (!t) return { ok: false, error: '内容空' };
  // 名字条：主题被清空 / 改成别的，都还是「名字」这一项（不然它就变回普通状态，名字立刻失效）
  let top = topic == null ? String(o.states[i].topic || '') : clip(topic, 40);
  if (isNameTopic(o.states[i].topic) && !isNameTopic(top)) top = String(o.states[i].topic || '');
  if (isNameTopic(top) && !cleanName(t)) return { ok: false, error: '名字要 1~16 个字，别带句号逗号' };
  o.states[i] = Object.assign({}, o.states[i], {
    text: t, kind: normKind(skind),
    topic: top,
    t: nowIso(),
  });
  // 人设条目：面板手改过整段之后，旧的 parts 分项就作废了（不然下次追加会拿旧分项把它盖回去）
  if (o.states[i].persona) delete o.states[i].parts;
  writeAll(o);
  return { ok: true };
}

function remove(id) {
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  const before = o.states.length;
  o.states = o.states.filter(s => !(s && s.id === id));
  writeAll(o);
  return { ok: true, removed: before - o.states.length };
}

function setShow(n) {
  const v = Math.round(Number(n) || 0);
  if (v < 1 || v > 999) return { ok: false, error: '数字要在 1~999' };
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  o.show = v;
  writeAll(o);
  return { ok: true, show: v };
}

/* ===== 写（AI 自己记）=====
 * 更新制：同一个 who + 同 kind + 同主题 → 原地覆盖，不新增条目（「换发型」不会越记越多）。
 * 主题撞上**全局**那条（发型 / 眼睛 / 体型…）→ 直接更新全局那条，所有会话都生效。 */
function upsert(who, skind, text, topic) {
  const t = clip(text, 500);
  if (!t) return { ok: false, error: '状态内容空' };
  const kind = normKind(skind);
  const top = clip(topic, 40);
  const W = String(who || '');
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  // ① 主题命中全局条目（她自己身上的东西）→ 改全局，所有会话都生效
  if (top && W !== '') {
    const gi = o.states.findIndex(s => s && !s.who && (s.topic || '') === top);
    if (gi >= 0) {
      o.states[gi] = Object.assign({}, o.states[gi], { text: t, t: nowIso() });
      writeAll(o);
      return { ok: true, updated: true, who: '', id: o.states[gi].id };
    }
  }
  // ② 这个 who 下同主题 → 原地覆盖
  if (top) {
    const i = o.states.findIndex(s => s && String(s.who || '') === W && (s.topic || '') === top
      && (W === '' || normKind(s.kind) === kind));
    if (i >= 0) {
      o.states[i] = Object.assign({}, o.states[i], { text: t, kind, t: nowIso() });
      writeAll(o);
      return { ok: true, updated: true, who: W, id: o.states[i].id };
    }
  }
  // ③ 新建
  const id = newId();
  o.states.push({ id, who: W, kind, topic: top, text: t, t: nowIso() });
  writeAll(o);
  return { ok: true, who: W, id };
}

// 按主题删（AI 写 `@@状态删 主题@@`）：先删全局同主题，再删这个 who 的。
function delTopic(who, skind, topic) {
  const top = clip(topic, 40);
  if (!top) return { ok: false, error: '主题空' };
  const kind = normKind(skind);
  const W = String(who || '');
  const o = clone(seedIfNeeded());   // 先保证本体那几条在（否则第一次写会丢了全局）
  const before = o.states.length;
  o.states = o.states.filter(s => {
    if (!s || (s.topic || '') !== top) return true;
    const w = String(s.who || '');
    if (!w) return false;                                   // 全局的按主题也能删
    if (w !== W) return true;                               // 别人的不动
    return normKind(s.kind) !== kind;                       // 只删自己这一 kind
  });
  writeAll(o);
  return { ok: true, removed: before - o.states.length };
}

/* ===== 人设层（2026-11-19 主人令）=====
 * 原话：「别人说你是一个猫娘，会用到虚幻的状态功能，要直接取代原本的人设，对此人变成猫娘。」
 *       「所有改变人设的都要直接在别人那里直接取代默认值。」「别人都能改，但不改默认值。」
 * 存在同一个文件里，条目多一个 persona:true —— 不另造一份存储，面板「状态」标签照样看得到、删得掉。
 *   who=''         主人设的 → 改默认值，对所有人生效
 *   who='p:<pid>'  别人设的 → 只对他生效；换个人（包括主人）说话仍是默认的虚幻
 * 和普通状态的分工：普通状态是「她现在的样子」，人设层是「对她来说她是谁」——注入时单独一段、
 * 明确**取代**人设正文，并且优先于「约定」（约定是文字太长、判不清状态归属时的兜底）。 */

// 这个人的人设该挂在哪：按人（合并账号）优先，没建档按号兜底。
function personaWhoOf(uid) {
  const ws = whoListOf(uid);
  return ws.length ? ws[0] : '';
}

/* 写入（单槽累积，2026-11-19 主人二次令）：
 * 原话：「状态类只有一个，最终会从简单的头发，变成发型+发色，变成发丝+前发+头发弯曲度+发色，
 *        等等，极尽细致后，最终多余的兜底落到约定。」
 * → 同一个 who 只有一条，新细节**并进这一条**：同一项覆盖、新项追加，越记越细。
 *   不整条取代（那会把已经记住的细节丢掉），也不并存多条（那就不是「只有一个」了）。
 *   这一条装不下（超过 PERSONA_CAP）的那部分不硬塞，作为 overflow 交回调用方落「约定」——
 *   约定是兜底，不是「除了单句设定全进约定」。
 * 存储：条目里 parts = { 项: 内容 }，text = 拼好的整段（注入和面板都读 text）。 */
const PERSONA_CAP = 500;

function personaParts(s) {
  const p = (s && s.parts && typeof s.parts === 'object' && !Array.isArray(s.parts)) ? s.parts : null;
  if (p && Object.keys(p).length) {
    const out = {};
    for (const k of Object.keys(p)) {
      const v = clip(p[k], 500);
      if (v) out[clip(k, 40) || '人设'] = v;
    }
    if (Object.keys(out).length) return out;
  }
  // 老条目（只有 topic + text）：当成一项
  const one = {};
  one[clip((s && s.topic) || '人设', 40) || '人设'] = clip((s && s.text) || '', 500);
  return one;
}

// parts → 一整段。「人设」是总述（不带前缀），其余写成「项：内容」，用分号连。
function personaText(parts) {
  const core = [], rest = [];
  for (const k of Object.keys(parts || {})) {
    const v = clip(parts[k], 500);
    if (!v) continue;
    if (k === '人设') core.push(v); else rest.push(k + '：' + v);
  }
  return core.concat(rest).join('；');
}

function upsertPersona(who, topic, text, by) {
  const t = clip(text, 500);
  if (!t) return { ok: false, error: '人设内容空' };
  const W = String(who || '');
  const top = clip(topic, 40) || '人设';
  const o = clone(seedIfNeeded());
  const mine = o.states.filter(s => s && s.persona && String(s.who || '') === W)
    .sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')));
  const keep = mine.length ? mine[mine.length - 1] : null;
  // 历史上按主题并存留下的多条：按时间并进来，一个字不丢
  const parts = {};
  for (const s of mine) {
    const pp = personaParts(s);
    for (const k of Object.keys(pp)) if (!parts[k] && pp[k]) parts[k] = pp[k];
  }
  const isNew = !parts[top];
  parts[top] = t;
  const joined = personaText(parts);
  if (isNew && joined.length > PERSONA_CAP) {
    // 这一条塞不下了 → 不硬塞，交给调用方落约定（兜底）
    delete parts[top];
    return { ok: true, who: W, overflow: (top === '人设' ? t : top + '：' + t), text: personaText(parts) };
  }
  const id = keep ? keep.id : newId();
  o.states = o.states.filter(s => !(s && s.persona && String(s.who || '') === W));
  o.states.push({
    id, who: W, kind: 'normal', persona: true, topic: top, parts,
    text: joined, by: clip(by, 40), t: nowIso(),
  });
  writeAll(o);
  return { ok: true, who: W, id, text: joined };
}

/* 注入用：这一轮该看的人设。
 *   global —— 主人改的默认值（who=''），对所有人；
 *   mine   —— 正在说话这个人名下的（别人让他变成的样子）。
 * 人设只有一个槽：同一个人身上历史遗留多条时只认最新那条（老的并进新条，不丢字）。
 * 人设不分本地/云端（换了模型她也还是那个人设），所以不按 kind 过滤。 */
function personaFor(whos) {
  const o = seedIfNeeded();
  const set = Array.isArray(whos) ? whos : [];
  const rows = o.states.filter(s => s && s.persona)
    .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
  const pick = s => ({
    id: s.id, who: String(s.who || ''), topic: String(s.topic || ''), text: String(s.text || ''), t: s.t || '',
    parts: personaParts(s),
  });
  const seen = new Set();
  const global = [], mine = [];
  for (const s of rows) {
    const w = String(s.who || '');
    if (!w) {
      if (!seen.has('')) { seen.add(''); global.push(pick(s)); }
      continue;
    }
    if (set.indexOf(w) < 0 || seen.has(w)) continue;
    seen.add(w);
    mine.push(pick(s));
  }
  return { global, mine };
}

/* 这一轮该用的名字（2026-11-25「状态里直接把名字改成豆包」）：
 * 优先级：只对现在说话这个人设的（mine）> 全局默认（global）；同一层取最新。
 * 再退到普通状态（没标 persona 的老数据）：全局 + 这个人 / 这个群，按时间取最新。
 * 返回 { name, who, source } 或 null。 */
function nameOfTurn(whos) {
  const set = Array.isArray(whos) ? whos : [];
  const pr = personaFor(set);
  for (const grp of ['mine', 'global']) {
    for (const s of pr[grp]) {
      const parts = s.parts || {};
      for (const k of Object.keys(parts)) {
        if (!isNameTopic(k)) continue;
        const nm = cleanName(parts[k]);
        if (nm) return { name: nm, who: String(s.who || ''), source: grp };
      }
    }
  }
  const o = seedIfNeeded();
  const rows = o.states
    .filter(s => s && !s.persona && isNameTopic(s.topic))
    .filter(s => { const w = String(s.who || ''); return !w || set.indexOf(w) >= 0; })
    .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
  for (const s of rows) {
    const nm = cleanName(s.text);
    if (nm) return { name: nm, who: String(s.who || ''), source: String(s.who || '') ? 'state' : 'state-global' };
  }
  return null;
}

// 恢复默认：topic 空 = 把这个 who 的人设整条删；给了 topic 只删那一项（删空了就整条删）。
function resetPersona(who, topic) {
  const W = String(who || '');
  const top = clip(topic, 40);
  const o = clone(seedIfNeeded());
  const before = o.states.length;
  const next = [];
  for (const s of o.states) {
    if (!s || !s.persona || String(s.who || '') !== W) { next.push(s); continue; }
    if (!top) continue;                                  // 整个恢复
    const parts = personaParts(s);
    if (!(top in parts)) { next.push(s); continue; }
    delete parts[top];
    const left = personaText(parts);
    if (!left) continue;                                 // 这项删完就空了 → 整条删
    next.push(Object.assign({}, s, { parts, text: left, topic: Object.keys(parts)[0] || '人设', t: nowIso() }));
  }
  o.states = next;
  writeAll(o);
  return { ok: true, removed: before - o.states.length };
}

/* 主人说「发型恢复默认」：把本体那几条全局状态改回出厂值（BODY_DEFAULT）。
 * topic 空 = 全部回默认。别人说恢复默认只删他自己那份人设，不动全局。 */
function restoreBody(topic) {
  const top = clip(topic, 40);
  const o = clone(seedIfNeeded());
  let n = 0;
  for (const b of BODY_DEFAULT) {
    if (top && b.topic !== top) continue;
    const i = o.states.findIndex(s => s && !s.who && !s.persona && (s.topic || '') === b.topic);
    if (i >= 0) {
      if ((o.states[i].text || '') !== b.text) n++;
      o.states[i] = Object.assign({}, o.states[i], { text: b.text, t: nowIso() });
    } else {
      o.states.push({ id: newId(), who: '', kind: 'normal', topic: b.topic, text: b.text, t: nowIso() });
      n++;
    }
  }
  if (n) writeAll(o);
  return { ok: true, restored: n };
}

module.exports = {
  FILE,
  whoListOf, whoListForTurn, whoOfTurn, whoOfConv, whoLabel,
  list, listFor, recentFor, showOf,
  add, update, remove, setShow,
  upsert, delTopic,
  personaWhoOf, upsertPersona, personaFor, resetPersona, restoreBody,
  NAME_TOPICS, isNameTopic, nameOfTurn,
};
