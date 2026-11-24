/*
 * ai-mark.js — 「AI 账号」标记表（2026-11-21 主人定）
 *
 * 这是干什么的：把「名字里带关键词」的账号标成 AI。AI 账号**只录入人物**
 *   （建档 + 记 nick / 群名片），其它一切录入（好感 / 喜好 / 情绪 / 标错 / 约定 /
 *   话题 / 日期 / 代称 / 学习 / 星标）全部不做，好感恒定 0 —— 行为跟「免记录群」同一套闸。
 *
 * 为什么不塞进 people.json：主人 2026-11-21 明确「单独，不要浪费 token」。
 *   单独一份 data/ai-marks.json，主键跟 people 一样是 platform:id（qq:123 / bili:456）。
 *   people.json 一个字节不动；判定、面板、机器人读的都是这一份。
 *
 * 记录两种状态（同一个键只留一种）：
 *   · 标成 AI：{ level:'t0'|'t1'|'t2', name, src, by, at, reported? }
 *   · 主人移除（改回人物）：{ exempt:true, by:'master', at }
 *       —— 豁免不是「删掉」：名字还带关键词，下条消息照样会被判到。
 *          记豁免 = 以后自动判定一律绕开这个号，面板再「标记 AI」才会重新标。
 *
 * 分档（主人 2026-11-21 原话，t3 是笔误，实际只有 t0/t1/t2）：
 *   t0：「乙」「小肥鱼」「ai」「bot」—— 绝对是 AI，直接标，不私信
 *   t1：「鲸」「🐳」「🐟」「鱼」「饭」「家的」—— 小概率误判，标 + 看注册时间（新号不报，老号才报）
 *   t2：「家」                          —— 中概率误判，标 + 私信
 *   （2026-11-21 07:36 主人令：「的」从 t2 移除——「的」字人人都有，误标太狠。）
 *   只判「真实名字」= QQ 资料卡昵称 nick + 各群群名片 cards（别的平台同理只认真名）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'ai-marks.json');

const T0 = ['乙', '小肥鱼', 'ai', 'bot'];
const T1 = ['鲸', '🐳', '🐟', '鱼', '饭', '家的'];
const T2 = ['家'];
const RANK = { t0: 3, t1: 2, t2: 1 };

/* 平台名归一（只做小写 + 几个中文别名；不依赖 people.js，避免循环依赖） */
function normPlat(p) {
  const s = String(p == null ? '' : p).trim().toLowerCase();
  if (!s) return '';
  const alias = {
    'b站': 'bili', '哔哩哔哩': 'bili', '哔哩': 'bili', 'bilibili': 'bili', 'blbl': 'bili', 'b23': 'bili',
    '小红书': 'xhs', '红书': 'xhs', '抖音': 'douyin', '小黑盒': 'xiaoheihe', '微博': 'weibo', '微信': 'wechat',
  };
  return alias[s] || s;
}
function normId(id) { return String(id == null ? '' : id).trim(); }
function keyOf(platform, id) {
  const p = normPlat(platform), i = normId(id);
  return (p && i) ? (p + ':' + i) : '';
}

/* t1 的注册时间门槛（2026-11-21 07:44 主人令）：
 * 「t1 的看注册时间，比 2026.10.1 晚的都标 ai，只有早于这个时间的才和 t2 一起报」。
 * 现实限制：NapCat get_stranger_info 的 regTime 只精确到**年**——不管哪年注册，时间戳都固定是该年
 * 北京时间 1 月 1 日（实测 2008-01-01 15:16 / 2025-01-01 16:31 / 2026-01-01 22:44），
 * 分不出 10 月 1 日这条线。所以落地成「注册年份 ≥ 2026 = 新号（不报）」，其余 = 老号（跟 t2 一起报）。
 * 取不到 regTime（0）一律按老号 → 照报，不静默吞掉。 */
const T1_REG_YEAR = 2026;
function isNewAccount(regTime) {
  const t = Number(regTime) || 0;
  if (!t) return false;
  const y = new Date(t * 1000).getFullYear();
  return y >= T1_REG_YEAR;
}
function yearOfReg(regTime) {
  const t = Number(regTime) || 0;
  return t ? new Date(t * 1000).getFullYear() : 0;
}

/* 判一个名字属于哪一档；没命中返回 null。
 * 顺序固定 t0 → t1 → t2：先把「乙 / 小肥鱼」这种 t0 认掉，不让它被 t1 的「鱼」抢走。 */
function classifyName(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase();
  if (!s) return null;
  for (const w of T0) if (s.indexOf(w) >= 0) return 't0';
  for (const w of T1) if (s.indexOf(w) >= 0) return 't1';
  for (const w of T2) if (s.indexOf(w) >= 0) return 't2';
  return null;
}

/* 非 QQ 平台「二重判」（2026-11-21 主人定）：命中 t1/t2 的其他平台账号，
 * 再看主页的签名 / 简介 / 置顶帖 / 视频或直播间标题等内容；二重也中 → 当 t0，不私信。
 * 只认明确的 AI 标识（t0 强词 + AI 特征词），不拿 t1/t2 的宽泛词——不然「的」「家」在简介里
 * 必然出现，等于人人都是 AI。返回 't0' 或 ''。 */
const AI_HOME_WORDS = ['乙', '小肥鱼', '机器人', '虚拟主播', '虚拟形象', 'ai绘画', 'ai生成', 'aigc', 'gpt', 'claude', '大模型', '自动回复', 'bot'];
function classifyHomeText(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s) return '';
  for (const w of AI_HOME_WORDS) if (s.indexOf(w.toLowerCase()) >= 0) return 't0';
  return '';
}

/* 从「资料卡昵称 + 各群群名片」里取最高档（t0 > t1 > t2）。
 * 返回 { level, name, src } 或 null。cards 形如 { 群号: 群名片 }。 */
function classifyAccount(nick, cards) {
  let hit = null;
  const take = (lv, name, src) => {
    if (!lv) return;
    if (!hit || RANK[lv] > RANK[hit.level]) hit = { level: lv, name: String(name || '').trim(), src };
  };
  take(classifyName(nick), nick, 'nick');
  if (cards && typeof cards === 'object') {
    for (const g of Object.keys(cards)) {
      const c = cards[g];
      if (c) take(classifyName(c), c, 'card:' + g);
    }
  }
  return hit;
}

/* ===== 读写（mtime/大小缓存，面板改了下次自动重读）===== */
let _cache = null, _mtime = 0, _size = -1;
function all() {
  try {
    const st = fs.statSync(FILE);
    if (_cache && _mtime === st.mtimeMs && _size === st.size) return _cache;
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    _cache = (o.marks && typeof o.marks === 'object') ? o.marks : {};
    _mtime = st.mtimeMs; _size = st.size;
    return _cache;
  } catch { _cache = {}; return _cache; }
}
function _save(marks) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, marks }, null, 1), 'utf8');
    _cache = null; _mtime = 0; _size = -1;
    return true;
  } catch (e) {
    console.error('[ai-mark] 存失败', e.message);
    _cache = null; _mtime = 0; _size = -1;
    return false;
  }
}

function recOf(platform, id) {
  const k = keyOf(platform, id);
  return k ? (all()[k] || null) : null;
}
function isAI(platform, id) {
  const r = recOf(platform, id);
  return !!(r && r.level && !r.exempt);
}
function isExempt(platform, id) {
  const r = recOf(platform, id);
  return !!(r && r.exempt);
}
function levelOf(platform, id) {
  const r = recOf(platform, id);
  return (r && !r.exempt && r.level) ? r.level : '';
}

/* 标成 AI（覆盖豁免）。meta 里可带 name / src / by / reported 等。 */
function mark(platform, id, level, meta) {
  const k = keyOf(platform, id);
  if (!k) return false;
  const m = all();
  const cur = m[k] || {};
  const lv = RANK[level] ? level : (RANK[cur.level] ? cur.level : 't1');
  const r = Object.assign({}, cur, meta || {}, { level: lv, exempt: false, at: Date.now() });
  if (!r.by) r.by = 'auto';
  m[k] = r;
  return _save(m);
}

/* 主人移除 → 记豁免，不再自动判（不是删记录）。 */
function unmark(platform, id) {
  const k = keyOf(platform, id);
  if (!k) return false;
  const m = all();
  m[k] = { exempt: true, by: 'master', at: Date.now() };
  return _save(m);
}

/* 面板要的全部 AI（排除豁免）：[{ key, platform, id, level, name, src }] */
function list() {
  const m = all();
  const out = [];
  for (const k of Object.keys(m)) {
    const r = m[k] || {};
    if (!r.level || r.exempt) continue;
    const i = k.indexOf(':');
    out.push({ key: k, platform: k.slice(0, i), id: k.slice(i + 1), level: r.level, name: r.name || '', src: r.src || '' });
  }
  return out.sort((a, b) => (RANK[b.level] - RANK[a.level]) || a.key.localeCompare(b.key));
}

module.exports = {
  FILE, T0, T1, T2, RANK, T1_REG_YEAR,
  classifyName, classifyAccount, classifyHomeText, isNewAccount, yearOfReg, normPlat, keyOf,
  all, recOf, isAI, isExempt, levelOf, mark, unmark, list,
};
