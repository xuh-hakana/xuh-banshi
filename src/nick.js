/*
 * nick.js — 称呼系统（主人 2026-10-20 定的规则，别再自己发挥）
 *
 * 主人 100000000  → 「主人」/「虚幻主人」
 * 欧尼酱 100000000 → 称呼表定：名字「欧尼酱」+ 代称优先度（哥哥、萌梓哥哥、爸爸、妈妈），
 *                      名字概率略大、代称左→右递减（主人 2026-10-23 定，不再硬编码名单）
 * 其他人           → 平时「昵称」，开心/难过/被骂/好奇时「昵称+酱」，
 *                     **好感度满 100**（data/favor.json）之后才日常「昵称+宝宝」
 *                     （主人 2026-10-22：以前被夸一次就永久宝宝——作废；现在夸一次只 +1 好感）
 *
 * 后缀状态存在 data/people-state.json，重启不清零；好感度在 data/favor.json（面板可调）。
 */
const { botWrite } = require('./wlog');
const favor = require('./favor');
const taste = require('./taste');
const configStore = require('./config');   // 黑名单群判定（这些人不记好感）
const people = require('./people');         // 2026-11-03：称呼状态改存 people.json（人物维度），这里是适配层
const aiMark = require('./ai-mark');         // 2026-11-21：AI 账号不加好感（好感恒 0）

/* 演示 / 基准 / 对照实验专用假身份，一律不落库（2026-11-19 事故）。
 * 起因：selfcheck 基准和 /tmp 对照组脚本都用 uid 123456、昵称「测试群友」、群 100000000
 * 跑真实链路，每跑一次就往 people.json / people-state.json 写一条假人。
 * 她在面板删掉，下一轮自检或测试又把它造回来——她看到的就是「删了还在」。
 * 这些号只用来构造提示词，记称呼 / 加好感 / 记代称全部跳过。 */
const DEMO_UIDS = new Set(['123456', '666666', '777777', '555555', '100000000']);
// 禁用词对照组脚本（/tmp/bans-control.js 那类）按 '9100'+字符码 造号：910049、910050… 还有 930049。
// 这些号只存在于实验里，同样不许落库（2026-11-19 实测往 people.json 写进了 6 个）。
const DEMO_PAT = /^(9100|9300)\d{2}$/;
const isDemoId = id => DEMO_UIDS.has(String(id || '')) || DEMO_PAT.test(String(id || ''));

let cfg = {};

function init(c) { cfg = c || {}; }
// 称呼状态现由 people.js 主存（data/people.json），按 QQ 账号摊平后就是旧 people-state.json 的形状。
// 这里 load/save 只是适配：内存里仍按 QQ 当钥匙操作，落盘写回 people.json（自动同步镜像）。
function load() {
  try { return people.stateView(); } catch { return {}; }
}
function save(o, mode) {
  try { people.writeStateView(o, { mode: mode || 'sync' }); } catch (e) { console.error('[nick] 存状态失败', e.message); }
}
const FILE = people.STATE_MIRROR;   // 兼容旧引用（镜像文件路径）

// 情绪判定：先判被骂（表面上难过，其实心里开心 → 加酱）
const SAD = /(呜呜|QAQ|qwq|T_T|哭|难过|伤心|委屈|不开心|难受)/i;
const SCOLD = /(傻逼|婊子|弱智|智障|傻b|沙比|煞笔|制杖|二逼|滚蛋|去死|笨蛋|蠢货|废物)/i;
const PRAISE = /(好聪明|真聪明|聪明|真棒|好棒|棒棒|厉害|好乖|真乖|好孩子|天才|太强了|牛啊|好可爱|真可爱|可爱死了)/;
// 主人纠正判定（主人 2026-10-22 真事：「夸在哪，我去，别记错了啊」——她把调侃当成了夸）：
// 这些话一出现，无论带没带「夸/棒/厉害」，都不是夸——是主人在纠正判定
const PRAISE_NEG = /(不是夸|别记错|夸在哪|哪里夸|谁夸你|这是批评|是批评|不是夸奖|吹的吧|给你纠正)/;
const HAPPY = /(哈哈|嘿嘿|嘻嘻|开心|好耶|太棒|喜欢|爱你|可爱|233|笑死|awsl)/i;
const CURIOUS = /(是什么|为什么|怎么|如何|哪里|哪个|谁|吗|呢|\?|？|攻略|教程|推荐|介绍)/;

function mood(text) {
  const t = String(text || '');
  if (SCOLD.test(t)) return 'scolded';   // 被骂 → 也算开心场合 → 加酱
  if (PRAISE_NEG.test(t)) return '';     // 主人在纠正「刚才不是夸」——严禁当成夸
  if (SAD.test(t)) return 'sad';
  if (PRAISE.test(t)) return 'praised';  // 被夸 → 改口「宝宝」，永久
  if (HAPPY.test(t)) return 'happy';
  if (CURIOUS.test(t)) return 'curious';
  return '';
}

const pick = a => a[Math.floor(Math.random() * a.length)];
const oniiQQ = () => String(cfg.oniiQQ || '100000000');

// ===== 代称优先度清单（主人 2026-10-23 定）=====
// alias 存成「、」分隔的字符串，**左→右就是优先度，从高到低**（如欧尼酱的：哥哥、萌梓哥哥、爸爸、妈妈）。
// 解析时严格按顿号/竖线切，逐个去空白、去空项、去重——不许有字符错误（自测有专项校验）。
function aliasList(rec) {
  const seen = new Set(); const out = [];
  for (const raw of String((rec && rec.alias) || '').split(/[、｜|,，;；]/)) {
    const s = String(raw).replace(/\s+/g, '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out;
}
// 追加代称（AI 猜的、或主人补的）：去重；最多 5 个，超了从最右（优先度最低）开始挤掉。
// 主人 2026-10-23 定：代称来源=AI 猜测（如元囮的「大饮尽」）+ 主人手写，都走这里。
function addAlias(uid, a) {
  const id = String(uid || '').replace(/\D/g, '');
  const s = String(a || '').replace(/\s+/g, '').trim();
  if (!id || !s || s.length > 12) return false;
  const st = load();
  const rec = st[id] || {};
  if (String(rec.name || '') === s) return false;      // 和确认名相同就不算代称
  const list = aliasList(rec).filter(x => x !== s);
  list.push(s);                                        // 新猜的放最右（优先度最低），不压过主人定的顺序
  while (list.length > 5) list.splice(4, 1);           // 超 5 个：挤掉最左边的旧猜项（主人自己写的那段顺序永远在前）
  rec.alias = list.join('、');
  st[id] = rec; save(st);
  botWrite('data/people.json', '代称', id + ' 新增代称「' + s + '」（现在：' + rec.alias + '）');
  return true;
}
// 按权重挑称呼的工具（**2026-11-22 起称呼不再走这里**：身份直接给称呼、其余用真名/可见名）。
// 保留函数是因为面板/测试可能还在引用；不要再把代称池接回 nameFor。
function pickWeighted(pool) {
  if (!pool.length) return '';
  const n = pool.length - 1;                            // 代称个数
  const w = pool.map((_, i) => (i === 0 ? n + 2 : Math.max(1, n - i)));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r < 0) return pool[i]; }
  return pool[pool.length - 1];
}

// ===== 资料卡 / 群名片（主人 2026-10-23 定）=====
// 一个人只有 1 张资料卡名（rec.nick，可以空着），但**每个群各有一张群名片**（rec.cards[gid]）。
// 以前只有一个 nick 字段，几个群互相覆盖——主人原话：「把 id 那栏 1 个的限制，改成资料卡 1 个（空的空着）、
// 更多的按所在的群计，每个群都记。」
// 群名片尾部常带一串全角空格（QQ 的显示名会这样），存之前先清掉。
/* 只有**整条就是系统提示**的才算脏名：QQ 把人移出群后会给名片补一句「已被移出群聊」。
 * 2026-11-22 她纠正：她自己的群名片本来就是「那就是死了已被移出群聊」（她故意起的），
 * 而群里另一个人叫「那就是死了」——上一条 ^.*已被移出群聊$ 会把她整条洗成「那就是死了」，
 * 两个人当场撞成一个。所以只在「除了系统提示没别的字」时才丢。 */
const BAD_CARD = /^(?:该用户不存在|已?被?移出群聊|已退出群聊|已解散)$/;
function cleanCard(s) {
  return String(s || '').replace(/[\s\u3000]+/g, ' ').trim().slice(0, 40);
}
/* 「像不像一个名字」——2026-11-18 给「自己喊过就记」加的辅助闸。
 * 主闸是「只从本群群名片/资料卡名取」（不取 ctx.nick 兜底）；这里再挡住
 * 本身就像一句话的群名片。名字是短词：不含句子标点、不超 20 字。
 * 「独舞酱」「H-ORITA」「FromGod Jungle」过；「抓走你 你涉黄了」不过。
 * 注意：只挡自动记代称，不挡面板手写（那条走 reviewEdit，不经过这里）。 */
function looksLikeName(s) {
  const t = String(s || '').trim();
  if (!t || t === '你' || t.length > 20) return false;
  if (/[。！？!?，,；;：:]/.test(t)) return false;        // 一句话的标点
  // 带空格的：只放过纯 ASCII 的英文 ID 名（FromGod Jungle / H-ORITA）。
  // 「咦惹 二次元」「抓走你 你涉黄了」这种中文短语带空格 = 一句话，挡住。
  if (/\s/.test(t) && !/^[A-Za-z0-9_\-\s.]+$/.test(t)) return false;
  return true;
}

/* 「叫我 XX」的捕获也收进这里：只认句首/停顿以后的祈使句。
 * 真事：群里原话「叫它乙?这一叫我都觉得脸上有点挂不住喵」里，
 * 老正则从腰上截出「我都觉得脸上有点挂不住喵」当名字写了。
 * 「这一叫我」前面不是句首也不是停顿，所以现在不认；
 * 「叫我乙」「以后大家就叫我 Ayami」「诶，叫我老群夺舍了」照旧认。 */
function callMeName(text) {
  const body = String(text || '').replace(/@\d{5,12}\s*/g, ' ').trim();
  const m = body.match(/(?:^|[，。！？!?、；;\s])(?:(?:以后|大家|你们|你|就|请|都|麻烦|帮忙)\s*){0,3}叫我\s*([^\s，。！？、,!?]{1,12})/);
  return m ? m[1] : '';
}

/* 「观察到别人 @ 某人，顺手记称呼」的上下文闸。
 * 只有 @ 前面确实是「叫/喊/称呼/唤（他|她|它|你|对方|这位）」这类明确称呼动词才算，
 * 不许把「@某人 就是什么都没发才恶心」「↩回复@某人：…↩ @某人 抓走你」当称呼。
 * 这里只看 @（或 @ 前那个候选词）之前那一段，防止从聊天句中间腰截一段短语。 */
const CALL_CONTEXT = /^(?:叫|喊|称呼|称|唤)(?:他|她|它|你|你们|对方|这位|那位|这个|那个)?$/;
function looksLikeCallContext(prefix) {
  const s = String(prefix || '').replace(/[\s，,、：:]+$/g, '');
  return CALL_CONTEXT.test(s);
}
function saveCard(uid, gid, card, profileNick) {
  const id = String(uid || '').replace(/\D/g, '');
  if (!id) return false;
  if (isDemoId(id)) return false;      // 假身份不落库（见 DEMO_UIDS）
  const st = load();
  const rec = st[id] || {};
  let dirty = false;
  /* 2026-11-22 她实测纠正（「三组都错，是人物表本身错了吧」）：
   * 群名片只认**事件里真的带了 card** 的值；card 为空时**不许拿资料卡名去覆盖已有群名片**，
   * 只在「这个群还没有卡」时用资料卡名补一次。
   * 原来 `cleanCard(card) || cleanCard(profileNick)` 把资料卡名当群名片写，
   * 实测把「金毛初华」「企鹅火丁」这种真实群名片覆盖成了 QQ 昵称。 */
  const c = cleanCard(card);
  if (String(gid || '') && c && !BAD_CARD.test(c)) {
    rec.cards = rec.cards || {};
    if (rec.cards[String(gid)] !== c) { rec.cards[String(gid)] = c; dirty = true; }
  } else if (String(gid || '') && !(rec.cards || {})[String(gid)]) {
    // 只有这个群完全没有卡，才用资料卡名占个位（仍是「他在这个群显示的名字」）
    const fb = cleanCard(profileNick);
    if (fb && !BAD_CARD.test(fb) && looksLikeName(fb)) {
      rec.cards = rec.cards || {};
      rec.cards[String(gid)] = fb;
      dirty = true;
    }
  }
  // 资料卡名是 QQ 上的真实值：2026-11-22 起允许覆盖（以前只补空，改过名永远更新不过来），
  // 但仍挡系统污染名。旧值由 people.save 的 qqsync 档写进 nickHistory，当曾用名参与认人。
  const pn = cleanCard(profileNick);
  if (pn && !BAD_CARD.test(pn) && rec.nick !== pn) { rec.nick = pn; dirty = true; }
  if (dirty) { st[id] = rec; save(st, 'qqsync'); }   // 真实资料（QQ 侧）→ 允许覆盖，旧值进 nickHistory
  return dirty;
}
// 这个人在这个群叫什么（没有群名片 → 退回资料卡名）
function cardIn(uid, gid) {
  const st = load();
  const rec = st[String(uid)] || {};
  if (gid && rec.cards && rec.cards[String(gid)]) return rec.cards[String(gid)];
  return String(rec.nick || '');
}
// 一个人的全部名片：{ profile, cards:{gid:card} }
function cardsOf(uid) {
  const st = load();
  const rec = st[String(uid)] || {};
  return { profile: String(rec.nick || ''), cards: rec.cards || {} };
}

/* 非 QQ 平台（B站直播/评论区）的称呼：身份是 (platform, id)，不是 QQ 号。
 * 和 QQ 路径的区别（都是有意的）：
 *   · 昵称取**账号级** nick（people.touch 已经写进去的），ctx.nick 兜底；
 *   · **不读** QQ 的 stateView()（那是按 QQ 摊平的视图），也**不写** people-state.json 镜像；
 *   · 好感 / 满 100 的判断走 favor.isBaby('bili:123') → people 的按账号接口。 */
function nameForAccount(platform, aid, ctx = {}, text = '') {
  const key = platform + ':' + aid;
  const incoming = cleanCard(ctx.nick);
  let rec = null;
  try { rec = people.getByAccount(platform, aid); } catch { rec = null; }
  const acc = rec ? (rec.accounts || []).find(a => String(a.platform) === String(platform) && String(a.id) === String(aid)) : null;
  let nick = String((acc && acc.nick) || '').trim();
  const demoAcc = isDemoId(aid);      // 假身份（见 DEMO_UIDS）：只算称呼，不建档、不加好感
  /* 2026-11-22 她令「被回复了才建档」：没建档的平台账号**不许自动建档**（原来 touch 会建），
   * 只拿事件昵称当这一轮的称呼；已建档的才写，而且只在昵称真的变了时写。 */
  if (!demoAcc && incoming && !BAD_CARD.test(incoming)) {
    try {
      if (nick && nick !== incoming) people.setAccountNick(platform, aid, incoming);
    } catch { /* 写不进去也不影响称呼 */ }
    nick = incoming;
  }
  if (!nick) nick = incoming;

  // 被夸 → 好感 +1；过 60 自动写「喜欢（人物）」（taste.addPerson 会带平台前缀落节）
  // 2026-11-13 主人修正：她自己触发的一切照常记，免记录群只对别人生效
  const m = mood(text);
  if (!demoAcc && m === 'praised' && !aiMark.isAI(platform, aid) && (ctx.isMaster || !configStore.isNoRecordGid(ctx.gid))) {
    const r = favor.add(key, 1);
    if (r.crossed) taste.addPerson(key, ctx.nick || nick || '', r.v);
  }

  /* 非 QQ 平台同样：真名（本人承认）→ 这个平台的可见名（昵称）。
   * 2026-11-22 起不再从代称里抽着喊——代称只用来认人。 */
  const real = rec ? String(rec.name || '').trim() : '';
  const masterCall = rec ? String(rec.masterCall || '').trim() : '';
  const base = real || masterCall || nick || cleanCard(ctx.nick) || '你';
  // 「酱」优先：开心/难过/被骂/好奇时永远加酱
  if (m && m !== 'praised') return base + '酱';
  let said = base;
  if (String((acc && acc.suffix) || '') === 'baobao' || favor.isBaby(key)) said += '宝宝';
  return said;
}

// 给某个 QQ 号算出这一句该用的称呼
function nameFor(uid, ctx = {}, text = '') {
  const raw = String(uid || '');
  if (!raw) return '';
  const k = people.splitUid(raw);                   // 'bili:123' → 账号身份；裸数字 → null
  if (k && k.platform !== 'qq') return nameForAccount(k.platform, k.id, ctx, text);
  const id = k ? k.id : raw;                        // 'qq:123' 与 '123' 等价
  if (!id) return '';
  if ((cfg.masterQQ && id === String(cfg.masterQQ)) || (Array.isArray(cfg.masters) && cfg.masters.map(String).includes(String(id)))) return '主人';
  /* 身份就是称呼（2026-11-22 她令）：欧尼酱也由身份直接给称呼，
   * 不再从「哥哥、萌梓哥哥、爸爸、妈妈」那张代称表里抽。 */
  if (id === oniiQQ()) return '欧尼酱';
  /* 2026-11-22 她纠正：QQ 侧说话就建档（B站 才是回复才建档）。
   * 所以这里不再拦截未建档的人，照旧写群名片/资料卡。 */

  const st = load();
  const rec = st[id] || {};
  const demo = isDemoId(id);          // 假身份：称呼照算（提示词要用），但不写盘
  let dirty = false;
  // 群里有群名片就记进这个群那一格；私聊才更新资料卡名（主人 2026-10-23 定）
  // 2026-11-18：ctx.nick 偶尔会带进一整句话（不是人名），先过 looksLikeName 再写，
  // 否则「抓走你 你涉黄了」会被当成群名片存下来、再被当称呼用。
  /* 群名片只写「事件真的带回的 card」（ctx.card），不拿 ctx.nick 冒充——
   * ctx.nick 在群名片为空时就是资料卡昵称，写进 cards 会把真实群名片覆盖掉（2026-11-22 实测事故）。 */
  const evCard = cleanCard(ctx.card);
  if (ctx.gid && evCard && looksLikeName(evCard)) {
    rec.cards = rec.cards || {};
    if (rec.cards[String(ctx.gid)] !== evCard) { rec.cards[String(ctx.gid)] = evCard; dirty = true; }
  } else if (!ctx.gid && ctx.nick && looksLikeName(ctx.nick) && !rec.nick) {
    rec.nick = cleanCard(ctx.nick); dirty = true;
  }

  // 被夸 → 好感 +1（主人 2026-10-22：不再夸一次就满），反馈照常不播报好感
  // 过 60 = 她喜欢这个人 → 自动写进《人物喜好》的「喜欢（人物）」（面板可删可改）
  // 满 100 日常才叫「宝宝」；掉好感的功能以后再加（favor.add 已支持负数）
  // 免记录群（noRecordGroups，现只有赛博鱼塘 100000000）不记好感——跟聊天记录同一道闸，不是新开关
  const m = mood(text);
  if (m === 'praised') {
    // 2026-11-13 主人修正：她本人触发时免记录群照常记好感
    if (!demo && !aiMark.isAI('qq', id) && (ctx.isMaster || !configStore.isNoRecordGid(ctx.gid))) {
      const r = favor.add(id, 1);
      if (r.crossed) taste.addPerson(id, ctx.nick || rec.nick || '', r.v);
    }
  }
  if (dirty && !demo) {
    st[id] = rec; save(st, 'qqsync');   // 消息事件里的群名片/资料卡 = QQ 真实值，允许覆盖
    botWrite('data/people.json', '称呼', (ctx.nick || id) + ' 记住了称呼');
  }

  // 名字规则（2026-11-22 她令）：
  //   身份就是称呼 —— 主人喊「主人」、欧尼酱喊「欧尼酱」，不再另养一张称呼表；
  //   其他人喊「真名（本人承认的）→ 当前可见名（本群群名片/资料卡）」。
  //   代称只拿来认人，不拿来喊（旧版会从代称池里抽，喊出「主人（虚幻）」这种别人随口叫的名）。
  const real = String(rec.name || '').trim();
  // 主人对他的叫法（2026-11-22）：「昵称」位置换成她的叫法——她喊「大萌新」，就跟着这么喊
  const masterCall = String(rec.masterCall || '').trim();
  const localCard = (ctx.gid && rec.cards && rec.cards[String(ctx.gid)]) || '';
  // 群里的当前可见名以**事件带来的显示名**最准（刚改名片、还没同步到 people.json 时也对）
  const eventNick = looksLikeName(String(ctx.nick || '')) ? cleanCard(ctx.nick) : '';
  /* 2026-11-22 她令：喊人只用本群名片 / 真名 / 主人的叫法 / 其他平台的昵称。
   * 所以这里只认「当前这个号在当前群」的名字——rec.nick 是摊平后的旧值（可能是别的号、
   * 别的群留下的），不能再当兜底，否则就会喊出另一个群的名牌。 */
  let visible = (ctx.gid && eventNick) || localCard;
  if (!visible) {
    try { visible = people.currentVisibleNameOf(people.pidOfIdAll(id) || '', ctx.gid, 'qq', id); } catch { visible = ''; }
  }
  if (!visible) visible = eventNick;
  const base = real || masterCall || visible || '你';
  // 「酱」优先：开心/难过/被骂/好奇时永远加酱，宝宝不覆盖它
  if (m && m !== 'praised') return base + '酱';
  let said = base;
  // 平时：好感度满 100 才叫「昵称+宝宝」（面板手动设的后缀 suffix 仍然算数，主人留着调着玩）
  if (rec.suffix === 'baobao' || favor.isBaby(id)) said += '宝宝';
  return said;
}

// 「记到本子里啦」→ 按人换说法，必须带「回忆」+ 称呼，各给一撮变体别重复
const APPROVE_LINES_MASTER = [
  '我会好好记住和{n}的回忆啦！',
  '好好记住{n}给我的回忆了',
  '和{n}的回忆，都写进我的本子里了！',
  '嗯！这是我和{n}的回忆，我不会忘的',
  '记下来啦，这是{n}给我的回忆',
  '我把和{n}的回忆藏好了，谁都抢不走',
  '{n}的回忆又多了一条，好开心',
  '这条要写三遍！因为是和{n}的回忆',
];
const APPROVE_LINES_ONII = [
  '我会好好记住和{n}的回忆啦！',
  '和{n}的回忆，我要好好写下来！',
  '这是{n}给我的回忆，记住啦',
  '嗯！和{n}的回忆都收好了',
  '我把{n}的回忆记进本子了哦',
  '{n}讲的事我记住啦，是回忆哦',
];
const APPROVE_LINES_OTHER = [
  '我会好好记住和{n}的回忆啦！',
  '和{n}的回忆，记下来了！',
  '这是{n}给我的回忆，我写好了',
  '嗯！{n}的回忆又多了一条',
  '{n}的回忆我收好啦',
  '记住啦，这是和{n}的回忆',
];
function approveLine(uid, ctx = {}) {
  const n = nameFor(uid, ctx, '');
  const id = String(uid);
  let tpl;
  if ((cfg.masterQQ && id === String(cfg.masterQQ)) || (Array.isArray(cfg.masters) && cfg.masters.map(String).includes(String(id)))) tpl = pick(APPROVE_LINES_MASTER);
  else if (id === oniiQQ()) tpl = pick(APPROVE_LINES_ONII);
  else tpl = pick(APPROVE_LINES_OTHER);
  return tpl.replace(/\{n\}/g, n || '你');
}

module.exports = { init, nameFor, approveLine, mood, aliasList, addAlias, saveCard, cardIn, cardsOf, cleanCard, looksLikeName, callMeName, looksLikeCallContext, FILE };
