/*
 * connectors/qq.js — NapCat (OneBot 11) 连接器
 * 私聊任意聊；群里必须 @机器人 才回。
 *
 * ═════════════════════════════════════════════════════════════
 * 回话规则分类地图 v3（2026-11-18；权威清单 docs/回话规则分类清单-待核对.md）
 * 判据：按生效场景归类，不望文生义；「私聊」与「聊天」同义，相对「公开发评论」。
 * 归位方式（主人 2026-11-18 定：沿用现有文件、内部按类归位）：
 *   独立 helper 块按类打标签；handleTurn / onMessage 决策链已整段物理归位到
 *   文件末尾独立区块（原 3092–4541 → 现 4040–5489）。搬运方式＝整块原样剪切搬家、
 *   内部一字不改：守卫逐字钉的字符串与相对顺序（必回铁律所在）全部保持不变，
 *   test-persona 86/86 零回归。改的只是代码位置，不是功能。
 *   A 群专属（仅群）：欢迎新人(2320) / 锐评(2507) / 凑热闹(2567) / 吐槽围观(2588)
 *                    / 攒N条(2600) / 复读刷屏(2781) / 戳一戳(4563) / 加星(5177)
 *   H 全聊天（群+私聊+B站私信，相对公开发评论）：纯情绪(1544) / 问候(1615) /
 *                    拆句(1815) / 必回对准(2436) / 嫌我蠢(2470) / 自动提问(2492) /
 *                    复读玩梗(2633) / 话题(3014) / 必回本体(决策链内)
 *   B 测试专属：修bug/自检/测上限/表情包报错/上线日报（决策链内 + 5207 起）
 *   D 平台功能：QQ空间(4766 起)；B站/直播在各自模块
 *   E 特殊通用：日记本体在 diary-flow.js
 *   F 全场景通用：说话风格/梗库/情绪/记忆/回话路径，在 core.js 与各数据文件
 *   I 独立：masterQQ/masters/oniiQQ（connect.json，身份层不归类）
 *   X 采集：表情包自动收集(898)，非回话规则
 * ═════════════════════════════════════════════════════════════
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../core');
const imgCache = require('../img-cache');   // 同一张图只 base64 一次（发送/识图共用）
const { boundedMap } = require('../bounded-map');   // 缓存加界：超过上限淘汰最老的，读法不变
const fileCache = require('../file-cache');       // 表文件按 mtime 缓存，不每条消息重新 parse
const nlCommand = require('../nl-command');   // 主人私聊「自然语言=指令」统一层（2026-11-19 主人令）
const movePoop = require('../move-poop');     // 自动搬屎（2026-11-21 复刻 618 星 astrbot_sowing_discord，默认关闭）
const dailyStats = require('../daily-stats');  // 上线日报：只读统计 + 渲染（2026-11-24 主人令换掉旧的离开时长播报）
const poopQuality = require('../poop-quality'); // 优质屎判定（2026-11-24：点赞/回复/5分钟关键词 → B站队列插队）
const S0 = v => String(v == null ? '' : v).trim();
const { botWrite } = require('../wlog');
const guides = require('../guides');
const video = require('../video');   // 看视频（主人 2026-11-22：默认 3 帧 + 字幕前 60 字，笑点解析全量）

// ===== 回话「输出判定」簇已拆到 rules/（主人 2026-11-19 令「记录和输出分开」+「按场景按需调用」）=====
// 门面 rules/output.js 不再一次性建出全部判定：按场景类拆成
//   rules/scene-h-chat.js  【H 全聊天】手打@ / 嫌我蠢 / 自动提问
//   rules/scene-a-group.js 【A QQ群专属】锐评 / 限流 / 凑热闹 / 攒N条 / 热度 / 今日计数（连 5 张群级 Map）
// 这里用**同名委托**接住：启动时不 require 任何类文件，第一次真调用才加载对应类。
// 所以私聊进程不会加载群类（也不分配群级 Map），只跑群不触发「嫌我蠢」时也不加载聊天类。
// 决策链里的调用点、守卫字符串、相对顺序全部不变（名字还叫这些名字）。
// cfgLazy：getCfg 惰性读本模块 cfg（cfgLive 函数声明提升，此处引用安全）。
const _output = require('../rules/output').createOutput({
  getCfg: () => cfg,
  cfgLive: () => cfgLive(),
  guides,
});
// 【H 全聊天】类
const typedAtOther = t => _output.typedAtOther(t);
const detectCriticism = (t, atMe, lastBotSpokeAt) => _output.detectCriticism(t, atMe, lastBotSpokeAt);
const looksLikeQuestion = t => _output.looksLikeQuestion(t);
// 【A QQ群专属】类（第一次调用才加载 scene-a-group + 建群级 Map）
const looksLikeComment = t => _output.looksLikeComment(t);
const autoAllowed = gid => _output.autoAllowed(gid);
const bumpSpoke = gid => _output.bumpSpoke(gid);
const saidToday = gid => _output.saidToday(gid);
const autoTalkWorthy = t => _output.autoTalkWorthy(t);
const chimeAllowed = (gid, t) => _output.chimeAllowed(gid, t);
const recordAt = gid => _output.recordAt(gid);
const isHot = gid => _output.isHot(gid);
const autoNeed = gid => _output.autoNeed(gid);
const grpAutoTick = gid => _output.grpAutoTick(gid);
const grpAutoConsume = gid => _output.grpAutoConsume(gid);
const RECENT_MS = _output.RECENT_MS;
const lastSpoke = _output.lastSpoke;                                  // 惰性 Map 视图（只 .get/.set）
const BANTER = { test: t => _output.BANTER.test(t) };                  // 正则只经 .test 用
const region = require('../region');
const dice = require('../dice');
const websearch = require('../websearch');
const pauseCtl = require('../pause');
const peopleCmd = require('../people-cmd');   // 2026-11-03：多端互通，主人私聊里录入人物/账号
const qmeta = require('../qq-meta');          // 2026-11-07：头像缓存 / 群名表 / 显示名→QQ号（客户端同一份）
const convSettings = require('../conv-settings');  // 2026-11-07：按会话的回复开关 / 黑名单 / 上下文条数
const platLimits = require('../platform-limits'); // 2026-11-17：各平台输出字数上限的单一数据源
const limitProbe = require('../limit-probe'); // 2026-11-17：测各平台字数上限（主人私信命令触发）
const localsearch = require('../localsearch');    // 2026-11-09：问「几次/什么时候」先查已落盘的数据
const healthRemind = require('../health-remind'); // 2026-11-10：定时保健提醒（排点/话术/节假日/按人约定都在这个模块里）
const rocoMerchant = require('../roco-merchant'); // 2026-11-21：洛克王国远行商人提醒（数据源轮询 + 固定标签持有人）
const alarms = require('../alarms');              // 2026-11-24：她自己给自己定的闹钟（承诺→定时→到点兑现→归类）
const rocoBili = require('../roco-bili');         // 2026-11-21：稀有商品轮次去 B站 评论区留提醒（去重/额度/风控停机）
const review = require('../review');              // 2026-11-12：三类知识复核/锁定/署名隐私
const people = require('../people');              // 2026-11-12：代称本人新增写回人物主存（同一份 alias）
const aiMark = require('../ai-mark');             // 2026-11-21：AI 账号标记表（名字带关键词 = 只建档、不写画像、好感恒 0）
const teach = require('../teach');                // 2026-11-13：来源询问要按人查条目（和 core 共用同一份实例）
const qc = require('../qzone-comment');           // 2026-11-17：逛别人空间留评论（选人/选动态/低分门）
const selfpost = require('../selfpost');          // 2026-11-17：她自己发出去的说说/动态留档（提示词+思考，主人要回看）
// 2026-11-18：一天一篇日记的全流程（群晚安 / 她私信说结束 / 08:00 兜底 / 「发」「重写」审批）。
// 不循环：diary-flow 顶层只 require core 和 diary-publish，diary-publish 里对 qq 是惰性 require。
const diaryFlow = require('../diary-flow');
let cfg, ws, selfId;
let seq = 0;
const waiters = boundedMap(2000);     // echo -> {resolve, reject}，用于要回包的接口

// 主人可以有多个号（主人 2026-10-22：识别主人的路径有问题——她在群里的号没被认出来）。
// cfg.masterQQ 是主号（私聊报告/动态发布用它），cfg.masters 里是其他同样算主人的号。
function isMasterUid(uid) {
  const s = String(uid || '');
  if (!s) return false;
  if (cfg.masterQQ && s === String(cfg.masterQQ)) return true;
  return Array.isArray(cfg.masters) && cfg.masters.some(m => String(m) === s);
}

// 身份消歧——**只作用在给模型的字符串上**（主人 2026-10-22 晚定：聊天记录落盘/面板原样记，一个字不动；
// AI 号不写死，selfId 运行时从 NapCat 拿，换号自动跟随）。
// 场景规则（2026-11-19 主人改）：**取消「主人＝虚幻同一个人」**——她是她、你是你，
// 主人说话一律标「主人」，不再因为「没在跟我说话」就把她的话记成「你自己（虚幻）」。
// （原来那条是为了把主人当分身，结果模型把主人说的话当成自己说的，跟历史打标也对不上。）
function uidTag(uid, nick, talking) {
  const s = String(uid || '');
  if (s && String(selfId || '') === s) return '你自己（虚幻）';
  if (isMasterUid(s)) return '主人';
  const n = String(nick || '').trim() || '群友';
  return (cfg && n === cfg.botName) ? n + '（重名的群友，不是你自己）' : n;
}

// 历史回看打标（2026-11-06 修「回复错人」①）：不套当前轮的 talkingToMe，
// 只按「这条消息是谁发的」打标——主人永远是「主人」、自己永远是「你自己（虚幻）」、群友用昵称。
// 之前把当前消息的 talkingToMe 一刀切灌进整段历史（即时记忆/笑点解析），导致主人最近的话被标成
// 「你自己（虚幻）说」，模型以为虚幻自己骂自己傻，防御性回「我哪里傻了嘛」时就 @/引用错人。
function uidTagHist(uid, nick) {
  const s = String(uid || '');
  if (s && String(selfId || '') === s) return '你自己（虚幻）';
  if (isMasterUid(s)) return '主人';
  const n = String(nick || '').trim() || '群友';
  return (cfg && n === cfg.botName) ? n + '（重名的群友，不是你自己）' : n;
}

// 她最近说话的对象（输出侧判定用）：在群里她回复/@ 了谁。主人接话（3 分钟内）算「和我对话」。
const herTarget = boundedMap(3000);   // gkey -> { uid, t }
function noteHerTarget(gkey, uid) { herTarget.set(String(gkey || ''), { uid: String(uid || ''), t: Date.now() }); }
function sheJustTalkedTo(gkey, uid) {
  const h = herTarget.get(String(gkey || ''));
  return !!h && String(h.uid) === String(uid) && Date.now() - h.t < 3 * 60 * 1000;
}

// 发送钩子：只在自测脚本里用（真实 QQ 测试要一个独立连接发消息，不能跟主 bot 抢 ws）
let _sendHook = null;
function sendAction(action, params, opts) {
  const onResult = (opts && opts.onResult) || null;
  // 丢弃时告诉调用方「没发」，别让调用方当成已发（2026-11-21 主人：发送失败要在时间窗内补）。
  const dropped = why => {
    if (onResult) { try { onResult(false, why); } catch {} }
    return false;
  };
  // 群禁言总闸（2026-11-05 她定）：被禁言的群，任何群消息都不往下发。
  // 放这里是因为所有发送最终都出这个口（文字、表情、主动搭话、定时问候），
  // 前面该拦的已经拦了，这是最后一道「别白花力气去发一条注定失败的消息」。
  if (action === 'send_group_msg' && params && botMuted(params.group_id)) {
    console.log('[禁言] 群 ' + params.group_id + ' 还在禁言中，丢弃一条发送');
    return dropped('群还在禁言中');
  }
  /* 会话关闭总闸（2026-11-21 主人报「关闭功能没生效」）：
   * 原来只在 onsMsg 入口拦新消息，已经进了合并队列/正在生成的回合照发——22:43:59 关群，
   * 22:45:02 那条排队回复还是发出去了。放在这个唯一出口，和禁言同一道：
   * 合并回合、保健提醒、远行商人、搬屎、主动搭话、定时问候一次全兜住。
   * _allowOff 只给「刚执行关闭/打开指令」的回执用（不然主人看不到关没关），发前摘掉。 */
  const _offGid = (action === 'send_group_msg' && params) ? params.group_id
    : (action === 'send_msg' && params && params.message_type === 'group') ? params.group_id : '';
  if (_offGid && convSettings.isOff('qq_' + _offGid) && !(params && params._allowOff)) {
    console.log('[关闭] 群 ' + _offGid + ' 已关（不看也不回），丢弃一条发送：' + String(briefTextOf(params)).slice(0, 30));
    return dropped('群已关（不看也不回）');
  }
  if (params && params._allowOff) delete params._allowOff;   // 豁免只这一次，别漏给 NapCat
  if (_sendHook) {
    const r = _sendHook(action, params);
    if (onResult) { try { onResult(r !== false, r === false ? '测试钩子判失败' : ''); } catch {} }
    return r;
  }
  if (SEND_ACTIONS[action]) return dispatchSend(action, params, 0, false, onResult);   // 消息类：要回执 + 失败自动重发
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ action, params, echo: 'e' + Date.now() + '_' + (++seq) }));
}

/* ===== 发送回执 + 自动重发（2026-11-09 她定：「这条没发出去，这种问题出现要自动重发」）=====
 * 真事：11-09 11:23:24 群里那条「哇，原来贾宝玉这么厉害啊…」NapCat 日志记了「发送 ->」，
 * 但她 QQ 里没有这条。原来的发送是「发出去就不管」，回包（echo）虽然带上了但没人收，
 * 成功失败程序完全不知道。现在四层兜：
 *   ① 等回包（ackTimeoutMs 默认 8 秒）；retcode≠0 / 超时 → 重发。
 *   ② 回包成功且有 message_id → 2 秒后回读一次 get_msg，NapCat 明确说「消息不存在」→ 重发。
 *   ③ 回读连续 3 次都判「不存在」→ 认为是 get_msg 本身靠不住，自动关掉回读（防止每条都重发变刷屏）。
 *   ④ 重发到 maxTries（默认 3 = 首发 + 2 次重发）还没成 → 记进 ai-feedback「消息没发出去」，
 *      客户端「虚幻自查」页能看见；同一条 5 分钟内不重复记。
 * 停止条件：群里被禁言、WS 一直连不上到上限。关掉：config/features.json → sendGuard.enabled=false。
 */
const SEND_ACTIONS = { send_group_msg: 1, send_private_msg: 1, send_msg: 1 };
const sendAcks = boundedMap(2000);       // echo -> { action, params, tries, timer }
const sendFailSeen = boundedMap(500, 6 * 60 * 60 * 1000);   // 失败描述 -> 上次记 feedback 的时间
let verifyMissStreak = 0;         // 回读连续判「不存在」的次数（熔断用）
let verifyOff = false;            // 熔断后本次运行不再回读

function sendGuardCfg() {
  const c = (cfgLive().sendGuard) || {};
  return {
    enabled: c.enabled !== false,
    ackTimeoutMs: Math.max(2000, Number(c.ackTimeoutMs) || 8000),
    maxTries: Math.max(1, Math.min(5, Number(c.maxTries) || 3)),
    verify: c.verify !== false,
  };
}
// 消息体压成一句人话（日志/待修复里看得懂，不贴满屏段结构）
function briefParams(action, params) {
  const p = params || {};
  const priv = action === 'send_private_msg' || (action === 'send_msg' && p.message_type === 'private');
  const to = priv ? ('私聊 ' + p.user_id) : ('群 ' + p.group_id);
  const msg = p.message;
  let t = '';
  if (typeof msg === 'string') t = msg;
  else if (Array.isArray(msg)) {
    t = msg.map(s => (s && s.type === 'text'
      ? String((s.data && s.data.text) || '')
      : '[' + String((s && s.type) || '?') + ']')).join('');
  }
  return to + '：「' + String(t || '').replace(/\s+/g, ' ').slice(0, 40) + '」';
}
function dispatchSend(action, params, tries, skipVerify, onResult) {
  const g = sendGuardCfg();
  if (!g.enabled) {   // 关掉就回到老样子：发出去不管
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, params, echo: 'e' + Date.now() + '_' + (++seq) }));
      if (onResult) { try { onResult(true, '发送校验关着，按已发处理'); } catch {} }
    } else if (onResult) { try { onResult(false, 'WS 没连上'); } catch {} }
    return;
  }
  // 重发前再看一眼禁言：这几十秒里被关进去了就别硬发
  if (action === 'send_group_msg' && params && botMuted(params.group_id)) {
    console.log('[禁言] 群 ' + params.group_id + ' 已被禁言，放弃重发：' + briefParams(action, params));
    if (onResult) { try { onResult(false, '群已被禁言'); } catch {} }
    return;
  }
  // 重发前也看一眼会话关闭（2026-11-21）：这几十秒里主人把群关了，就不许再补发。
  const _offGid2 = (action === 'send_group_msg' && params) ? params.group_id
    : (action === 'send_msg' && params && params.message_type === 'group') ? params.group_id : '';
  if (_offGid2 && !(params && params._allowOff) && convSettings.isOff('qq_' + _offGid2)) {
    console.log('[关闭] 群 ' + _offGid2 + ' 已关，放弃重发：' + briefParams(action, params));
    if (onResult) { try { onResult(false, '群已关'); } catch {} }
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return laterResend(action, params, tries, 'WS 没连上', skipVerify, onResult);
  const echo = 'e' + Date.now() + '_' + (++seq);
  try { ws.send(JSON.stringify({ action, params, echo })); }
  catch (e) { return laterResend(action, params, tries, '写进 WS 失败：' + e.message, skipVerify, onResult); }
  const timer = setTimeout(() => {
    finishSend(echo, false, '等了 ' + Math.round(g.ackTimeoutMs / 1000) + ' 秒没有回包');
  }, g.ackTimeoutMs);
  sendAcks.set(echo, { action, params, tries, timer, skipVerify: !!skipVerify, onResult: onResult || null });
}
/* ===== 她发出去的消息留一份 id（2026-11-19：主人在私聊说「撤回群里这句」，指令层没这动作）=====
 * 撤回要有 message_id，聊天记录只存文本。发成功（回包带 message_id）就留 30 分钟、最多 60 条。 */
const recentSent = [];
function briefTextOf(params) {
  const msg = params && params.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg.map(s => (s && s.type === 'text' ? String((s.data && s.data.text) || '') : '')).join('');
  }
  return '';
}
function noteSent(action, params, mid) {
  if (mid == null || mid === '') return;
  const p = params || {};
  const scope = action === 'send_group_msg' ? ('群' + (p.group_id || '')) : ('私聊' + (p.user_id || ''));
  recentSent.push({ at: Date.now(), scope, mid: String(mid), text: briefTextOf(p) });
  while (recentSent.length > 60) recentSent.shift();
}
/* 撤回：优先按原文匹配（主人把原话贴回来），其次「群里那句」，再次本会话最后一条。 */
async function recallSent(o) {
  o = o || {};
  const now = Date.now();
  const alive = recentSent.filter(x => now - x.at < 30 * 60 * 1000);
  if (!alive.length) return { ok: false, error: '最近 30 分钟里没有我发出去的消息，没得撤' };
  const squash = s => String(s || '').replace(/\s+/g, '');
  const want = squash(o.match);
  let cand = null;
  if (want && want.length >= 4) {
    cand = alive.slice().reverse().find(x => {
      const t = squash(x.text);
      return t && (t.indexOf(want) >= 0 || want.indexOf(t.slice(0, Math.min(t.length, 20))) >= 0);
    }) || null;
  }
  if (!cand && o.inGroup) cand = alive.filter(x => /^群/.test(x.scope)).slice(-1)[0] || null;
  if (!cand && /^群/.test(S0(o.scope))) cand = alive.slice().reverse().find(x => x.scope === o.scope) || null;
  // 私聊里只说「撤回这句」：必须有原话/引用才撤。盲取最后一条会撤掉刚发的上线汇报（2026-11-19）。
  if (!cand) return { ok: false, error: '不确定撤哪条。把要撤的那句引用一下，或者把原话贴给我。' };
  // QQ 只让撤 2 分钟内的消息；报错照原样给，后面再补一句人话提示（2026-11-20 主人定「报错+提示」）。
  // 注意：不能拿 age 当硬门槛提前拦——有的号/场景时限不同，交给 QQ 判。
  const ageSec = Math.round((now - cand.at) / 1000);
  let r;
  try {
    r = await callApi('delete_msg', { message_id: /^\d+$/.test(cand.mid) ? Number(cand.mid) : cand.mid }, 6000);
  } catch (e) {
    return { ok: false, error: '撤回请求没过：' + e.message + '。' + recallFailHint(ageSec), target: cand };
  }
  const ok = !!(r && (r.retcode === 0 || r.status === 'ok'));
  if (ok) {
    const i = recentSent.indexOf(cand);
    if (i >= 0) recentSent.splice(i, 1);
    return { ok: true, target: cand };
  }
  return {
    ok: false,
    target: cand,
    error: 'NapCat 回了 '
      + JSON.stringify({ retcode: r && r.retcode, status: r && r.status, msg: (r && (r.message || r.wording)) || '' })
      + '。' + recallFailHint(ageSec),
  };
}

function recallFailHint(ageSec) {
  if (ageSec >= 110) return '提示：这句是 ' + ageSec + ' 秒前发的，QQ 只能撤 2 分钟内的，超时了撤不回来';
  return '提示：QQ 没让撤（可能这条已过时限或不是能撤的消息）';
}

function finishSend(echo, ok, why, ev) {
  const rec = sendAcks.get(echo);
  if (!rec) return;
  sendAcks.delete(echo);
  clearTimeout(rec.timer);
  if (!ok) return laterResend(rec.action, rec.params, rec.tries, why, rec.skipVerify, rec.onResult);
  const g = sendGuardCfg();
  const mid = ev && ev.data ? (ev.data.message_id != null ? ev.data.message_id : ev.data.messageId) : null;
  noteSent(rec.action, rec.params, mid);   // 留 id，「撤回刚才那句」要用
  // 回包成功 = 发送成功，先告诉等结果的人（远行商人靠这个决定「这轮算发了没」）。
  // 下面回读不到时会走重发，重发全败由 reportSendFail 再报一次失败。
  if (rec.onResult) { try { rec.onResult(true); } catch {} }
  if (!g.verify || verifyOff || rec.skipVerify || mid == null || mid === '') return;
  // 回读确认：这条真在服务器上，才算发到了。查不到（NapCat 明确说「不存在」）才重发。
  setTimeout(() => {
    callApi('get_msg', { message_id: Number(mid) || mid }, 5000)
      .then(() => { verifyMissStreak = 0; })
      .catch(e => {
        const m = String((e && e.message) || '');
        // 只有「明确说这条不存在」才算失败；接口不支持 / 超时 / 权限错一律不重发（宁可漏，不刷屏）
        if (!/不存在|没找到|not\s*found|消息不存在|消息已过期/i.test(m)) return;
        verifyMissStreak++;
        if (verifyMissStreak >= 3) {
          verifyOff = true;
          console.log('[发送] 回读连续 ' + verifyMissStreak + ' 次判「不存在」，get_msg 不可信，本次运行不再回读');
          try { core.aiFeedback('发送回读失效', 'get_msg 连续判「消息不存在」，已停止回读确认。发送失败只能靠回包判断了。'); } catch {}
          return;
        }
        laterResend(rec.action, rec.params, rec.tries, '回读查不到这条（' + m + '）', true);
      });
  }, 2000);
}
function laterResend(action, params, tries, why, skipVerify, onResult) {
  const g = sendGuardCfg();
  const next = tries + 1;
  if (next >= g.maxTries) return reportSendFail(action, params, why, tries, onResult);
  const wait = 1500 * next;
  console.log('[发送] ' + why + ' → ' + (wait / 1000) + ' 秒后重发（第 ' + next + ' 次，上限 ' + g.maxTries + ' 次）｜' + briefParams(action, params));
  setTimeout(() => dispatchSend(action, params, next, skipVerify, onResult), wait);
}
function reportSendFail(action, params, why, tries, onResult) {
  if (onResult) { try { onResult(false, why + '（重发 ' + tries + ' 次都没成）'); } catch {} }
  const desc = briefParams(action, params);
  console.log('[发送] 放弃：' + desc + '（' + why + '，已试 ' + (tries + 1) + ' 次）');
  const k = desc.slice(0, 60);
  const now = Date.now();
  if (now - (sendFailSeen.get(k) || 0) < 5 * 60 * 1000) return;   // 同一条 5 分钟内不重复记
  sendFailSeen.set(k, now);
  if (sendFailSeen.size > 200) sendFailSeen.clear();
  try { core.aiFeedback('消息没发出去', desc + '｜原因：' + why + '｜重发 ' + tries + ' 次都没成'); } catch {}
}

// 要等结果的接口（查资料卡地区）
function callApi(action, params, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WS 未连接'));
    const echo = 'c' + (++seq);
    waiters.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (waiters.has(echo)) { waiters.delete(echo); reject(new Error('超时')); }
    }, timeout);
  });
}

/* ===== AI 判定通知（2026-11-21 主人定）=====
 * t0 绝对 → 只标不报；t2 → 标 + 报；t1 → 先看 QQ 注册时间：新号（注册年份 ≥ 2026）只标不报，
 * 只有老号才跟 t2 一起报。注册时间只精确到年（见 ai-mark.isNewAccount 注释），取不到按老号报。 */
/* 注册时间按平台取（2026-11-21 主人令：别只看腾讯）。
 * qq → NapCat regTime（只精确到年）；bili → card.regtime / acc/info.jointime（实测恒 0）；
 * 其它平台（小红书 / 抖音 / 微博…）没有公开接口 → 0 = 不知道 → 按老号报。 */
async function regTimeOf(platform, id) {
  const p = String(platform || '').toLowerCase();
  if (p === 'qq') return fetchRegTime(id);
  if (p === 'bili') { try { return Number(await require('../bili-space').regTime(id)) || 0; } catch { return 0; } }
  return 0;
}

async function fetchRegTime(uid) {
  const rec = aiMark.recOf('qq', uid) || {};
  if (rec.regTime) return Number(rec.regTime) || 0;
  try {
    const r = await callApi('get_stranger_info', { user_id: Number(uid) }, 4000);
    const d = (r && r.data) || {};
    const t = Number(d.regTime || d.reg_time || 0) || 0;
    if (t) {
      const lv = aiMark.levelOf('qq', uid);
      if (lv) aiMark.mark('qq', uid, lv, { regTime: t });   // 存进标记表，下次不再问接口
    }
    return t;
  } catch { return 0; }
}

async function aiReport(uid, level, hitName, pm) {
  const rec0 = aiMark.recOf('qq', uid) || {};
  if (rec0.reported || rec0.silent) return;
  let reg = Number(rec0.regTime) || 0;
  if (level === 't1') {
    reg = await regTimeOf('qq', uid);
    if (aiMark.isNewAccount(reg)) {
      try { aiMark.mark('qq', uid, 't1', { silent: true, silentWhy: 'reg-new', regTime: reg }); } catch {}
      console.log('[AI] t1 新号不报：QQ ' + uid + '（' + (hitName || '无名字') + '，注册 ' + aiMark.yearOfReg(reg) + ' 年）');
      return;
    }
  }
  const peopleLib = require('../people');
  const person = pm || (() => { try { return peopleLib.getByAccount('qq', uid); } catch { return null; } })();
  const acc = person ? (person.accounts || []).find(a => String(a.platform) === 'qq' && String(a.id) === uid) : null;
  let gn = {};
  try { gn = qmeta.groupNames() || {}; } catch { gn = {}; }
  const gids = acc && acc.cards ? Object.keys(acc.cards).filter(g => acc.cards[g]) : [];
  const groups = gids.map(g => (gn[g] ? gn[g] + '（' + g + '）' : '群' + g)).join('、') || '（没记到群）';
  const msg = '[AI判定] 疑似 AI 账号，已标为 ' + level + '：\nQQ ' + uid + '（' + (hitName || '无名字') + '）\n所在群：' + groups
    + (reg ? '\n注册：' + aiMark.yearOfReg(reg) + ' 年' : '')
    + '\n误判就引用这条消息、回复任意内容（空格也行），我把它改回人物。';
  try {
    core.master(msg);
    aiMark.mark('qq', uid, level, reg ? { reported: true, reportedAt: Date.now(), regTime: reg } : { reported: true, reportedAt: Date.now() });
  } catch {}
}

/* ===== 群成员名单（2026-11-12 主人定）=====
 * 别人教的知识只在教的人「在场」时用；在场按**群成员名单**判，不按最近发过言判。
 * 缓存 10 分钟；接口失败 / 超时就用上一次的名单，一次都没有就返回空（教学这轮不注入，不拖慢回话）。 */
const _memberCache = boundedMap(5000);
async function groupMemberIds(gid) {
  const key = String(gid || '');
  if (!key) return [];
  const hit = _memberCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ids;
  try {
    const r = await callApi('get_group_member_list', { group_id: Number(gid), no_cache: false }, 2500);
    const arr = Array.isArray(r) ? r : ((r && (r.data || r.list)) || []);
    const ids = arr.map(x => String((x && (x.user_id || x.uin)) || '')).filter(Boolean);
    if (ids.length) { _memberCache.set(key, { at: Date.now(), ids }); return ids; }
  } catch (e) { /* 拿不到就用旧名单，不让回话等接口 */ }
  return hit ? hit.ids : [];
}

/* ===== 真实资料卡同步（2026-11-22 她令：「群名片和人物表要读真实的资料卡更新的！」）=====
 * 以前只有「他本人说话」时才顺手记一下，没说过话的人永远空白、改过名也不会更新。
 * 现在按已知群拉成员列表，把 QQ 上的真实 card（群名片）/ nickname（资料卡）写进人物表：
 *   · 只更新**已建档**的人——不给全群建档（几百个陌生人会把人物表炸掉）；
 *   · 群名片为空 = 这个群他就用资料卡名 → 删掉该群那格，当前可见名自然退回资料卡；
 *   · 写入走 people.save 的 'qqsync' 档：允许覆盖 nick/cards（QQ 是权威源），
 *     旧值进 nickHistory 当「曾用名」，以后改名了也认得出是同一个人。
 */
let _profileSyncedAt = 0;
const PROFILE_SYNC_TTL = 6 * 3600 * 1000;   // 6 小时一次，别把接口刷爆
function _knownGroupIds() {
  const out = new Set();
  const add = v => { const s = String(v || '').replace(/^qq_/, '').replace(/\D/g, ''); if (s) out.add(s); };
  try {
    const conv = fileCache.readJson(path.join(__dirname, '..', 'data', 'conv-settings.json')) || {};
    Object.keys(conv).forEach(add);
  } catch {}
  try {
    const gn = fileCache.readJson(path.join(__dirname, '..', 'data', 'group-names.json')) || {};
    Object.keys(gn).forEach(add);
  } catch {}
  try { add(cfg.oniiGroup); } catch {}
  try { (cfg.groups || []).forEach(g => add(g && (g.id || g.gid || g))); } catch {}
  return [...out];
}
async function syncProfilesOnce(opt) {
  const force = !!(opt && opt.force);
  if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, reason: '未连接' };
  if (!force && _profileSyncedAt && Date.now() - _profileSyncedAt < PROFILE_SYNC_TTL) {
    return { ok: false, reason: '刚同步过' };
  }
  const gids = _knownGroupIds();
  if (!gids.length) return { ok: false, reason: '没有已知群' };
  const o = people.load();
  // 号 → 人物账号，先建索引（几百人 × 几个账号，比每行遍历快得多）
  const idx = new Map();
  for (const pid of Object.keys(o)) {
    for (const a of (o[pid].accounts || [])) {
      if (String(a.platform) !== 'qq') continue;
      idx.set(String(a.id), { pid, acc: a });
    }
  }
  let nickCh = 0, cardCh = 0, seen = 0, groups = 0;
  for (const gid of gids) {
    let arr = [];
    try {
      const r = await callApi('get_group_member_list', { group_id: Number(gid), no_cache: true }, 8000);
      arr = Array.isArray(r) ? r : ((r && (r.data || r.list)) || []);
    } catch (e) {
      console.log('[资料卡] 群 ' + gid + ' 拉成员失败：' + String(e.message || e).split('\n')[0]);
      continue;
    }
    if (!arr.length) continue;
    groups++;
    for (const m of arr) {
      const uid = String((m && (m.user_id || m.uin)) || '');
      const hit = uid && idx.get(uid);
      if (!hit) continue;                    // 没建档就不动（不批量造人）
      seen++;
      const acc = hit.acc;
      const nick = String((m && (m.nickname || m.nick)) || '').trim().slice(0, 40);
      const card = String((m && m.card) || '').trim().slice(0, 40);
      if (nick && acc.nick !== nick) { acc.nick = nick; nickCh++; }
      acc.cards = acc.cards || {};
      /* 2026-11-22：card 为空只代表「这次没拿到」，不代表他没设群名片。
       * 原来这里会 delete 掉已有卡，随后事件又把旧名写回来——来回横跳，还造出一堆假「曾用名」。 */
      if (card && acc.cards[gid] !== card) { acc.cards[gid] = card; cardCh++; }
    }
    await new Promise(r => setTimeout(r, 600));   // 串行 + 间隔，别触发腾讯风控
  }
  let saved = true;
  if (nickCh || cardCh) saved = people.save(o, { allowIdentity: 'qqsync' });
  _profileSyncedAt = Date.now();
  console.log('[资料卡] 同步完成：群 ' + groups + '，命中已建档 ' + seen + ' 人，资料卡变化 ' + nickCh
    + '，群名片变化 ' + cardCh + '，落盘 ' + saved);
  /* 不再顺手刷 B站 昵称（2026-11-22 她令：不做定时拉取，等他下次在 B站 说话时再更新）。 */
  return { ok: true, groups, seen, nick: nickCh, card: cardCh, saved };
}
// 私聊看到的人：顺手拉一次他自己的资料卡（get_stranger_info 不受群限制）
const _profAt = boundedMap(5000, 30 * 60 * 1000);          // qq -> 上次拉资料卡的时间（10 分钟一次，别每条私聊都打接口）
async function syncOneProfile(uid) {
  const id = String(uid || '').replace(/\D/g, '');
  if (!id) return false;
  try {
    const r = await callApi('get_stranger_info', { user_id: Number(id) }, 4000);
    const d = (r && (r.data || r)) || {};
    const nick = String(d.nickname || d.nick || '').trim().slice(0, 40);
    if (!nick) return false;
    const o = people.load();
    let hit = null, pid = '';
    for (const k of Object.keys(o)) {
      const acc = (o[k].accounts || []).find(a => String(a.platform) === 'qq' && String(a.id) === id);
      if (acc) { hit = acc; pid = k; break; }
    }
    if (!hit || hit.nick === nick) return false;
    hit.nick = nick;
    return people.save(o, { allowIdentity: 'qqsync' });
  } catch { return false; }
}

/* ===== 群禁言（2026-11-05 她定：机器人自己在群里被禁言，就别再给模型发消息）=====
 * 为什么：被禁言后照样调模型、照样试着发，token 白花、消息还发不出去。
 * 两个来源互相补：
 *   · group_ban 事件（有人禁言她 / 提前解禁）—— NapCat 主动推，最准、不花接口；
 *   · get_group_member_info 的 shut_up_timestamp —— 重启后错过事件时兜底，
 *     一个群 10 分钟最多问一次，不在每条消息上都打接口。
 * 时长不用自己算：QQ 的禁言选项 30 秒 / 60 秒 / 1 小时 / 1 天 / 30 天 / 自定义，
 * 事件里给的是秒数、查询接口给的是到期时间戳，统一换成「到期时刻」比就行。
 */
const mutedUntil = boundedMap(3000);      // 群号(字符串) -> 禁言到期时间戳(ms)
const muteProbedAt = boundedMap(3000, 30 * 60 * 1000);    // 群号 -> 上次问接口的时间(ms)
const MUTE_PROBE_TTL = 10 * 60 * 1000;    // 同一个群 10 分钟内只问一次
const MUTE_MAX_FALLBACK = 30 * 86400 * 1000;  // 事件没给时长时按 30 天算（QQ 最长就是这个）

function botMuted(gid) {
  const until = mutedUntil.get(String(gid || ''));
  return !!until && until > Date.now();
}
// 还剩多久（只用于日志/面板，说人话）
function muteLeftText(gid) {
  const until = mutedUntil.get(String(gid || ''));
  if (!until || until <= Date.now()) return '';
  const s = Math.round((until - Date.now()) / 1000);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.round(s / 60) + ' 分钟';
  if (s < 86400) return Math.round(s / 3600) + ' 小时';
  return Math.round(s / 86400) + ' 天';
}
// 禁言状态一变就刷一次状态文件，让「机器人」页马上看到（不然要等下一分钟心跳）
function flushMuteStatus() {
  try { setStatus(!!(curStatus && curStatus.online), (curStatus && curStatus.detail) || ''); } catch {}
}
// 收到 group_ban 通知：ban=被禁言、lift_ban=提前解禁。禁的是别人就返回 false，别的事照常处理。
function onGroupBan(ev) {
  const me = String(selfId || ev.self_id || '');
  const gid = String(ev.group_id || '');
  if (!me || !gid || String(ev.user_id) !== me) return false;   // 禁的不是她
  if (ev.sub_type === 'lift_ban') {
    mutedUntil.delete(gid);
    muteProbedAt.set(gid, Date.now());
    console.log('[禁言] 群 ' + gid + ' 解除了');
    flushMuteStatus();
    return true;
  }
  const sec = Number(ev.duration) || 0;
  mutedUntil.set(gid, Date.now() + (sec > 0 ? sec * 1000 : MUTE_MAX_FALLBACK));
  muteProbedAt.set(gid, Date.now());
  console.log('[禁言] 我在群 ' + gid + ' 被禁言 '
    + (sec > 0 ? sec + ' 秒（到 ' + new Date(Date.now() + sec * 1000).toLocaleString('zh-CN') + '）' : '（事件没给时长，按 30 天兜底）'));
  flushMuteStatus();
  return true;
}
// 兜底查询：查自己在群里的资料，shut_up_timestamp = 禁言到期时间（秒，0=没被禁言）
async function probeMute(gid) {
  const k = String(gid || '');
  if (!k || !selfId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const r = await callApi('get_group_member_info', {
      group_id: Number(k), user_id: Number(selfId), no_cache: true,
    }, 4000);
    let t = Number((r && r.data && r.data.shut_up_timestamp) || 0);
    if (t > 1e12) t = Math.round(t / 1000);      // 万一给的是毫秒
    if (t > 0) {
      const until = t * 1000;
      const had = botMuted(k);
      mutedUntil.set(k, until);
      if (!had && until > Date.now()) {
        console.log('[禁言] 查到自己还在禁言中，剩 ' + muteLeftText(k) + '（群 ' + k + '）');
        flushMuteStatus();
      }
    } else {
      if (botMuted(k)) { mutedUntil.delete(k); flushMuteStatus(); }
      else mutedUntil.delete(k);
    }
  } catch (e) {
    // 查不到就当没禁言：宁可多回一条，也不能因为接口抽风就装死
  }
}
// 给界面看的：现在哪几个群还在禁言、各剩多久（顺手把已过期的清掉，不让 Map 越攒越大）
function muteStatus() {
  const out = [];
  const now = Date.now();
  for (const [gid, until] of Array.from(mutedUntil.entries())) {
    if (until > now) out.push({ group: gid, until: new Date(until).toISOString(), left: muteLeftText(gid) });
    else mutedUntil.delete(gid);
  }
  return out;
}
// 进群消息时顺手刷新一次（不 await，不拖慢这条消息）
function ensureMuteKnown(gid) {
  const k = String(gid || '');
  if (!k) return;
  const at = muteProbedAt.get(k) || 0;
  if (Date.now() - at < MUTE_PROBE_TTL) return;
  muteProbedAt.set(k, Date.now());
  probeMute(k);
}

// 问天气没写城市时：先查登记表，再看资料卡，都没有就返回空 → 上层反问她住哪
// 现实：NapCat 4.18 的资料卡接口已不返回 city（腾讯关了），所以登记表才是主力
async function lookupRegion(ctx) {
  const uid = ctx.uid;
  if (!uid) return '';
  const saved = region.getRegion(uid);
  if (saved) return saved;
  // 资料卡接口实测拿不到城市（NapCat 4.18 的 fetchUserDetailInfo 返回空），默认不去等它
  // 欧尼酱（oniiQQ）只在 oniiGroup 这一个群里，查他也去那个群查
  const gidForProfile = String(uid) === String(cfg.oniiQQ || '') ? (cfg.oniiGroup || 0) : ctx.gid;
  if (cfg.lookupProfileRegion && gidForProfile) {
    try {
      const r = await callApi('get_group_member_info', { group_id: gidForProfile, user_id: uid, no_cache: true }, 2500);
      const d = r.data || {};
      const c = region.parseArea(d.area) || region.parseArea(d.city);
      if (c) { region.setRegion(uid, c); return c; }
    } catch (e) { console.log('[QQ] 群成员资料卡查不到地区:', e.message.split('\n')[0]); }
  }
  return '';
}

// 表情包：data/stickers/ 里的图片，模型用 [表情:名字] 触发
const STICKER_DIR = path.join(__dirname, '..', 'data', 'stickers');
// ===== 表情包自动收集（主人 2026-10-22）：群聊里的表情包自动收进 data/stickers/，她按需发 =====
// 规则：只收非测试群的图；md5 + 像素指纹去重；不收张数限制，只受已收图总量 50GB 封顶（2026-11-17 改）。
// 2026-11-03 主人纠正两条：
//   ① 300KB 上限是错的 —— 群里很多表情包就有 3MB，那样等于把大半的图挡在门外。改成 8MB（识图已放开见 :2087，收图大图单独存见 :883）。
//   ② 「别人一天最多 20 张」这条从来不是她的规矩 —— 删掉。500 张上限 2026-11-17 也取消，改总量 50GB。
// 名字用视觉翻译的开头（有语义她才挑得出来「哪张配哪句话」），重名自动加序号。
const STICKER_MD5 = path.join(STICKER_DIR, '.md5.json');
const stickerSeen = new Set();          // 本次进程内已见过的 md5
const STICKER_MAX_BYTES = 8 * 1024 * 1024;   // 收图体积上限（2026-11-03：原 300KB 太窄）
function stickerMd5Load() {
  try { return fileCache.readJson(STICKER_MD5) || {}; } catch { return {}; }
}
function stickerMd5Save(o) {
  try { fs.mkdirSync(STICKER_DIR, { recursive: true }); fs.writeFileSync(STICKER_MD5, JSON.stringify(o), 'utf8'); } catch {}
}
// 清理名字：只留中文/字母/数字/常用符号，去掉路径非法字符
const STICKER_COMMON = path.join(STICKER_DIR, '常用');   // 主人认为好用的固定几个（一直留着，2026-10-22 定）
// 场合表放表情包**根目录**（2026-10-31 主人定：「总之表情包功能都放这里」）。
// 以前在 常用/常用.md 里，现在和 普通-场合.json、.md5.json 并排，一眼看得全。
const STICKER_COMMON_MD = path.join(STICKER_DIR, '常用.md');
// ===== 表情池（主人 2026-10-30 定，2026-11-08 改口径）=====
// 常用/ 和 虚幻/ 同级：同属 main（权重 48），同名图两张都进候选一起抽，没有先后。
// 常用/ = 她手挑的；虚幻/ = 虚幻形象的表情包（5 张），发哪张由 常用.md 的场合行决定。
// 可用/ → usable（6）；关键词触发/ → kw（8）；少用/ 和根目录 q 图 → normal（1）。
const STICKER_USABLE = path.join(STICKER_DIR, '可用');
const STICKER_SELF = path.join(STICKER_DIR, '虚幻');
// 关键词池（2026-11-02 主人定：「情绪图再加一个文件夹 关键词触发，承担关键词功能」）
// 这个文件夹里的图 = 名字本身就是触发词，谁提到都能发，不等她有自己的情绪。
// 它同时是**唯一**的关键词来源：根目录不带 q 的图不再算关键词类，直接无视。
const STICKER_KW = path.join(STICKER_DIR, '关键词触发');
// 关键词的「额外说法」表（可空）：一行「- 打得过吗、胜率：奶龙论战很爽」。
// 名字本身能命中的不用写，只有想多加几个说法的才写这里，所以这个文件通常只有几行。
const STICKER_KW_MD = path.join(STICKER_KW, '关键词.md');
// 少用（2026-11-03 主人定）：原「收到」收件箱改名而来，主人不要「只存不发」的文件夹。
// 它同时是 AstrBot 的临时图目录（~/.astrbot/data/temp 软链到这里），所以里面大部分是
// media_image_时间戳.jpg。**池身份 = 普通池 normal，和根目录同一个池**（主人 2026-11-03 晚定：
// 二存一、不并存）；只有「什么时候挑它」单独算一族，清单只写一行，不逐张列。
const STICKER_LOW = path.join(STICKER_DIR, '少用');
// 难用（2026-11-16 主人补：曾经漏的功能）：情绪表情优先级梯度的最低一档
// 常用 > 可用 > 少用 > 难用。按名字分 —— q 开头是情绪图，非 q 是关键词图；
// 关键词图与这套优先级无关，放在哪档都能被一致触发，只有同级重叠才按优先级区分。
const STICKER_HARD = path.join(STICKER_DIR, '难用');
// 大图（2026-11-16 主人定）：大于 8MB 的图从「跳过」改为单独收进这个文件夹，和难用同级。
const STICKER_BIG = path.join(STICKER_DIR, '大图');
// 2026-11-17 主人定：取消「每个文件夹 500 张」上限，改成已收图总量 50GB 封顶。
// 下面的 dirImgCount / lowCount / kwCount 留作备用统计，不再用作收图闸门。
const STICKER_TOTAL_MAX = 50 * 1024 * 1024 * 1024;   // 50GB = 50 * 1024^3 字节
// 已收图总量（字节）：扫 stickers 下所有图片，含全部子目录（常用/可用/虚幻/关键词触发/少用/难用/大图/回收站）。
// 按她「已收图的总量」字面 —— 回收站也算占空间。只数图片文件，非图片不计。
function stickerTotalBytes() {
  let total = 0;
  const walk = dir => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);                       // 子目录递归
        else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) {
          try { total += fs.statSync(p).size; } catch {}
        }
      }
    } catch {}
  };
  walk(STICKER_DIR);
  return total;
}
function dirImgCount(dir, skipBotDump) {
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .filter(f => !(skipBotDump && /^media_image/i.test(f)))
      .length;
  } catch { return 0; }
}
function lowCount() { return dirImgCount(STICKER_LOW, true); }
function kwCount() { return dirImgCount(STICKER_KW, false); }
function hardCount() { return dirImgCount(STICKER_HARD, false); }
function bigCount() { return dirImgCount(STICKER_BIG, false); }
// 视觉描述 → 情绪短名（新收的图按「q<情绪><序号>」命名，如 q哭1）。
// 顺序有讲究：先匹配更具体的，「笑」要排在「开心」前面，免得「苦笑」被认成开心。
const VIS_EMO = [
  ['哭', ['哭', '泪', '抽泣', '呜呜', '哇哇', '流泪', '哭泣']],
  ['委屈', ['委屈', '眼巴巴', '可怜', '撇嘴']],
  ['怒', ['生气', '愤怒', '发火', '瞪', '怒视', '皱眉']],
  ['震惊', ['震惊', '吃惊', '惊讶', '瞪大', '呆住', '傻眼']],
  ['无语', ['无语', '沉默', '无奈', '翻白眼', '冷漠', '尴尬']],
  ['疑惑', ['疑惑', '问号', '懵', '歪头', '困惑', '不解']],
  ['累', ['疲惫', '累', '瘫', '躺平', '困倦', '打哈欠']],
  ['喜欢', ['爱心', '比心', '亲亲', '脸红', '抱抱', '喜欢', '贴贴']],
  ['得意', ['得意', '骄傲', '炫耀', '叉腰', '酷', '自信']],
  ['害怕', ['害怕', '恐惧', '发抖', '吓得', '惊恐']],
  ['笑', ['大笑', '微笑', '笑', '开心', '高兴', '咧嘴', '哈哈', '欢乐']],
  // 2026-11-05 加这一类：主人说的「悲伤」原来不在表里，识图给「难过/悲伤」时命名会退化成文件名。
  // 放在最后：描述里同时有「哭」和「悲伤」时还是按哭算（形状比措辞准）。
  ['难过', ['难过', '悲伤', '伤心', '低落', '沮丧', '郁闷', '心碎', 'emo', '丧']],
];
const QZONE_HIST_PATH = path.join(__dirname, '..', 'data', 'qzone-history.json');
let stickerWishAt = 0;   // 上次提醒主人「缺表情」的时间（节流 10 分钟）
function stickerFiles() {
  let out = [];
  // 2026-11-02 主人定：**根目录只认 q 开头的情绪图，其余一律无视**。
  // 以前根目录什么都算（关键词图、群友收来的杂图、功能截图都在里面，还共用 2% 权重），
  // 于是「token」这种词会捞出一张设置说明截图。现在关键词图只在 关键词触发/ 里，
  // 根目录放错位置的图（没带 q）就当它不存在，不列清单、不发、不参与任何匹配。
  try {
    out = fs.readdirSync(STICKER_DIR)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .filter(f => /^q(?!q)/i.test(f));
  } catch {}
  const sub = (dir, prefix) => {
    try { out = out.concat(fs.readdirSync(dir).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)).map(f => prefix + '/' + f)); } catch {}
  };
  sub(STICKER_COMMON, '常用');
  sub(STICKER_USABLE, '可用');
  sub(STICKER_SELF, '虚幻');
  sub(STICKER_KW, '关键词触发');
  sub(STICKER_LOW, '少用');
  sub(STICKER_HARD, '难用');       // 2026-11-16：情绪优先级最低档，进清单才发得出、搜得到
  sub(STICKER_BIG, '大图');        // 2026-11-16：大于 8MB 的图单独一档
  return out;
}
// 一个文件属于哪个池：main（常用+虚幻）/ usable（可用）/ kw（关键词触发）/ normal（根目录 q + 少用）/ hard（难用）/ big（大图）
// 2026-11-03 晚 主人定：**「少用」和根目录是同一个池，二存一，不并存**。
// 以前给少用单开一个 low 池，等于多出一套权重和一套规则；现在它只是普通池的另一个收图入口。
// 2026-11-16 主人定：难用是情绪优先级梯度的最底一档（常用>可用>少用>难用），单列 hard 池、
// 权重比 normal 再低；大图是体积档，单列 big。关键词图按名字判、不按文件夹，放哪档都走 kw 的触发。
function stickerPool(f) {
  const s = String(f || '');
  if (s.startsWith('常用/') || s.startsWith('虚幻/')) return 'main';
  if (s.startsWith('可用/')) return 'usable';
  if (s.startsWith('关键词触发/')) return 'kw';
  if (s.startsWith('难用/')) return 'hard';
  if (s.startsWith('大图/')) return 'big';
  return 'normal';                     // 根目录 q 图 和 少用/ 都算普通池
}
// 六个池的原始权重（2026-10-31 定 48/6/1；2026-11-02 补 kw；2026-11-03 少用并入 normal；
// 2026-11-16 补 hard(难用，最低档) / big(大图)）。难用 0.5 < 少用 1，符合情绪优先级梯度。
const POOL_W = { main: 48, usable: 6, kw: 8, normal: 1, hard: 0.5, big: 0.5 };
// 这次从哪个池挑（2026-10-31 主人改正口径）：
// **先把「这个场合本来就没图」的池整个排除，再只在剩下的池之间按原始权重归一化抽。**
// 以前是「按全局 90/8/2 掷一次，掷空了就退回常用」——只有 可用+普通 有图时，
// 90% 掷到常用→没有→退回常用还是没有→永远落普通，可用那 8 完全没机会。现在不会了。
//   三池都有 → 48:6:1 = 87.3% / 10.9% / 1.8%
//   可用+普通 → 6:1 = 85.7% / 14.3%
//   常用+普通 → 48:1 = 98% / 2%
//   常用+可用 → 48:6 = 88.9% / 11.1%
/* 2026-11-07 主人定：池权重可在面板调（情绪书 ratio），改完立刻生效。
 * 「关键词优先度 1」—— 以前是 8，太容易抢情绪图。 */
function poolW() {
  const d = Object.assign({}, POOL_W);
  try {
    const r = (require('../emotion-tree').load().ratio) || {};
    for (const k of Object.keys(d)) {
      const v = Number(r[k]);
      if (Number.isFinite(v) && v >= 0) d[k] = v;
    }
  } catch {}
  return d;
}
function pickPoolByWeight(files) {
  const list = files || [];
  const has = p => list.some(f => stickerPool(f) === p);
  const pools = ['main', 'usable', 'normal'].filter(has);
  if (!pools.length) return 'main';
  if (pools.length === 1) return pools[0];
  const W = poolW();
  const total = pools.reduce((s, p) => s + W[p], 0);
  let r = Math.random() * total;
  for (const p of pools) { r -= W[p]; if (r <= 0) return p; }
  return pools[pools.length - 1];
}
// ===== 场合组（2026-10-31 主人定：一行 = 一类，冒号前描述 + 冒号后图名都算触发词）=====
// 表长这样：`- 想哭、难过、受委屈的时候：哭、虚幻哭`
// 冒号前 = 描述（也是触发词），冒号后 = 这一类的图名（图名本身也可能是一个场合词，比如「难过2」）。
// 想哭的时候从整组里挑一张，不写死发「哭」——这是主人第 4 条要的。
// 两张表合并读：md（她手排的顺序，优先）+ json（其余），同描述自动并成一组。
let _grpCache = null, _grpAt = 0;
function stickerGroups() {
  if (_grpCache && Date.now() - _grpAt < 3000) return _grpCache;
  const groups = [];                       // [{ desc, names:[] }]
  const seen = new Set();                  // 已经进过组的图名（md 优先，json 不重复塞）
  const findOrAdd = desc => {
    const k = String(desc).replace(/[\s，。！？、；：,.;:!?]/g, '');
    let g = groups.find(x => x.key === k);
    if (!g) { g = { key: k, desc: String(desc).trim(), names: [] }; groups.push(g); }
    return g;
  };
  // ① md：一行一组
  // 2026-11-02：这里读**两张**表 —— 常用.md（情绪场合）+ 关键词触发/关键词.md（关键词额外说法）。
  // 两张表各管各的池，同一个图名不会同时出现在两边（关键词图已经全在 关键词触发/ 里）。
  try {
    let nIdx = 0;
    for (const tbPath of [STICKER_COMMON_MD, STICKER_KW_MD]) {
      let raw = '';
      try { raw = fs.readFileSync(tbPath, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const m = line.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+?)\s*$/);
        if (m) {
          // 2026-11-09 合并重复图：画面一样的两张只留一张，被合并掉的旧触发词用 `@别名` 接到保留者。
          // 别名行不进 seen / byName —— 否则保留者已在别的表里登记过，会被去重跳掉，这行就空了；
          // 也避免把常用场合表的词抢过来。数据写在 关键词触发/关键词.md，面板可改。
          const alias = /^@别名\s+/.test(m[1]);
          const g = findOrAdd(alias ? m[1].replace(/^@别名\s+/, '') : m[1]);
          for (const n of m[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean)) {
            if (!alias) { if (seen.has(n)) continue; seen.add(n); }
            g.names.push(n);
          }
          continue;
        }
        // 2026-10-31（只增不减）：面板保存时**描述框空着的行也写盘**，写成「- 图名1、图名2」。
        // 这种行没有冒号，必须认得 —— 单独成一组、位置保留，不能跟别行合并、更不能丢。
        const m2 = line.match(/^[-*]\s*(.+?)\s*$/);
        if (!m2) continue;
        const ns = m2[1].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean).filter(n => !seen.has(n));
        if (!ns.length) continue;
        const g2 = { key: '__nodesc' + (++nIdx), desc: '', names: [] };
        groups.push(g2);
        for (const n of ns) { seen.add(n); g2.names.push(n); }
      }
    }
  } catch {}
  // 注：2026-10-31 两张表已经合并进 常用.md（一行一类，描述在前），普通-场合.json 停用并移进备份。
  // 这里不再读 json —— 读两处会让同一张图被两个组抢。
  // 少用整目录算一族（2026-11-03 主人定：不要「只存不发」的收件箱）。
  // 池身份是 normal；这里只是把它做成一个能点名的场合。
  // 2026-11-03 夜：排除名字 q 开头的图——那些是机器人命名的情绪图，走「按名字/情绪」那条路，
  // 不并进这一族，否则同一张图会被两条路同时抽到。
  // 一族只有一行，模型想甩图但没话说时才点它。
  try {
    const lowImgs = fs.readdirSync(STICKER_LOW)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map(f => f.replace(/\.[^.]+$/, ''))
      .filter(n => !/^q(?!q)/i.test(n));
    if (lowImgs.length) {
      groups.push({ key: '少用', desc: '想甩一张图但没什么话可说（备用图，别常用、别连着发）', names: lowImgs });
    }
  } catch {}
  // 难用/大图整目录各算一族（2026-11-16 主人补）：和少用同样能点名整族甩图。
  // 只收 q 开头的情绪图 —— 非 q 是关键词图，它按名字触发、与优先级档无关，不并进档位族。
  for (const [dir, key, desc] of [
    [STICKER_HARD, '难用', '实在没合适的图、凑合用一张（最不常用的备用图）'],
    [STICKER_BIG, '大图', '体积大的图，想甩一张大图的时候'],
  ]) {
    try {
      const imgs = fs.readdirSync(dir)
        .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
        .map(f => f.replace(/\.[^.]+$/, ''))
        .filter(n => /^q(?!q)/i.test(n));
      if (imgs.length) groups.push({ key, desc, names: imgs });
    } catch {}
  }
  // 反查：图名 → 组；描述 → 组
  const byName = new Map();
  for (const g of groups) for (const n of g.names) if (!byName.has(n)) byName.set(n, g);
  _grpCache = { groups, byName };
  _grpAt = Date.now();
  return _grpCache;
}
// 触发词 → 组：先看是不是某个图名，再看是不是某条描述（整条或描述里的某个词）
function stickerGroupOf(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  const wl = w.toLowerCase();
  const { groups, byName } = stickerGroups();
  if (byName.has(w)) return byName.get(w);
  for (const [n, gg] of byName) if (n.toLowerCase() === wl) return gg;   // 大小写不敏感（Token / token）
  const key = w.replace(/[\s，。！？、；：,.;:!?]/g, '');
  const keyL = key.toLowerCase();
  for (const g of groups) if (g.key === key || g.key.toLowerCase() === keyL) return g;
  // 描述里拆出来的词：「想哭、难过、受委屈的时候」拆成 想哭 / 难过 / 受委屈的时候
  if (w.length >= 2) {
    for (const g of groups) {
      const parts = g.desc.split(/[、,，/｜|；;]/).map(x => x.trim()).filter(Boolean);
      if (parts.some(p => p === w || p.toLowerCase() === wl)) return g;
      if (g.desc.includes(w) || g.desc.toLowerCase().includes(wl)) return g;
    }
  }
  return null;
}
// 从一批图里挑一张：先按池权重挑池（48/6/1，只在有图的池之间归一化），再池内随机
/* 2026-11-07 修：以前是「先按池权重抽一个池，再在池里均匀抽」——
 * 于是「可用」池只有 1 张 q笑21 时，它独占 6/7 的概率，23 张的少用池几乎发不出去。
 * 现在按**每张图**加权：常用池每张 48、可用 6、少用/根目录 1。这才是「比例」的本意。 */
function pickFromCands(cands) {
  if (!cands || !cands.length) return null;
  const W = poolW();
  const ws = cands.map(f => {
    const v = Number(W[stickerPool(f)]);
    return Number.isFinite(v) ? v : 1;
  });
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return cands[Math.floor(Math.random() * cands.length)];
  let r = Math.random() * total;
  for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}
// 「每个都是有场合能触发的」：场合单在 data/stickers/常用.md（一行「- 名字：场合」）。
// 提示词只列有场合的；没进单子的不会发（等于不用），主人点名要删我再删。
function stickerOccasions() {
  const map = {};
  try {
    for (const line of fileCache.readText(STICKER_COMMON_MD).split('\n')) {
      const m = line.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+?)\s*$/);
      if (m) map[m[1].trim()] = m[2].trim();
    }
  } catch {}
  return map;
}
function stickerName(desc) {
  let s = String(desc || '').replace(/［图：|］/g, '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, '');
  s = s.replace(/[，。！？、…「」『』（）()．,!?]/g, '');
  // 2026-10-30：中文引号/书名号/方括号在文件名里合法但很难看（“近30天”消费统计 → 近30天消费统计）
  // 全角冒号/分号也要洗——洗出过只剩「：」的垃圾名字（：.jpg / ：2.jpg）
  s = s.replace(/[“”‘’《》〈〉【】〔〕·—～~：；]/g, '');
  // 主人 2026-10-22：名字不显示「图中有+量词」这种套话——「图中有一个穿着蓝色」→「穿着蓝色」
  // 2026-10-30：视觉模型现在爱说「图片展示了…」，一起洗掉（和插件侧 vision.py 的 _sticker_clean 保持一致）
  s = s.replace(/(图片展示了|图片显示|展示了|显示的是|图片中|画面中|图中|这是一张|这是一幅|这是一只|这是一个|这是)/g, '');
  s = s.replace(/(有一个|有一只|有一张|有一位|有一幅|有一条|有一枚)/g, '');
  s = s.replace(/^(是一(个|只|张|位|幅|条|名|枚|款|颗|头|朵|块|片))/, '');
  // 2026-10-30：视觉描述常以「一个/一只」开头，去掉更干净（她的例子是「蓝发小女孩2」不是「一个蓝发小女孩1」）
  s = s.replace(/^(一个|一只|一张|一位|一幅|一条|一名|一群|一头|一朵|一块|一片|两根|两个|两只|几)/, '');
  s = s.slice(0, 10);
  return s || '';
}
// 启动时把旧表情包的名字洗一遍（老版本收集的叫「图中有一个穿着…」或 md5 名），md5 去重表同步改
function stickerRenamePass() {
  try {
    const store = stickerMd5Load();
    const used = new Set(stickerFiles().map(f => f.replace(/\.[^.]+$/, '')));
    let moved = 0;
    for (const f of stickerFiles()) {
      if (f.startsWith('少用/')) continue;   // 少用/ 里是 AstrBot 落盘原件（media_image_时间戳），不改名
      const ext = path.extname(f);
      // f 可能带「常用/」前缀：先拆目录，只洗文件名本身
      const sub = path.dirname(f);
      const fname = path.basename(f);
      let base = fname.slice(0, fname.length - ext.length);
      if (/^[0-9a-f]{32}$/.test(base)) base = '表情' + new Date().toISOString().slice(5, 10).replace('-', '');   // md5 裸名 → 收集日期
      const clean = stickerName(base);
      if (!clean || clean === base || used.has(clean)) continue;
      let name = clean, i = 2;
      while (used.has(name)) name = clean + (i++);
      // 改名要在原来的目录里做，不许跑到父目录去（真踩过：常用/开心.jpg 被洗成父目录的 常用开心.jpg）
      const src = path.join(STICKER_DIR, f);
      const dstName = sub && sub !== '.' ? path.join(sub, name + ext) : (name + ext);
      fs.renameSync(src, path.join(STICKER_DIR, dstName));
      used.add(name);
      for (const [md5, v] of Object.entries(store)) {
        const fn = typeof v === 'string' ? v : v.f;
        if (fn === f) store[md5] = typeof v === 'string' ? dstName.replace(/\\/g, '/') : Object.assign({}, v, { f: dstName.replace(/\\/g, '/') });
      }
      moved++;
    }
    if (moved) { stickerMd5Save(store); console.log('[表情] 洗名 ' + moved + ' 张（去掉「图中有/量词」套话和 md5 裸名）'); }
  } catch (e) { console.log('[表情] 洗名失败：' + e.message); }
}
// Python 解释器在哪台机器的哪个位置——2026-10-28 迁 Mac 时从写死的 Windows 路径改成自动识别：
//   Windows     <home>\.workbuddy\binaries\python\envs\default\Scripts\python.exe
//   macOS/Linux <home>/.workbuddy/binaries/python/envs/default/bin/python3
// 本地虚拟环境还没建的话，回落到 PATH 里的 python / python3。
// 原来的写法 'C:/Users/user/...' 在 Mac 上必然找不到，表情去重会静默失效（不报错，只是开始收重复表情）。
function defaultPython() {
  const base = path.join(require('os').homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default');
  if (process.platform === 'win32') {
    const winPy = path.join(base, 'Scripts', 'python.exe');
    try { if (fs.existsSync(winPy)) return winPy; } catch {}
    return 'python';
  }
  const unixPy = path.join(base, 'bin', 'python3');
  try { if (fs.existsSync(unixPy)) return unixPy; } catch {}
  return 'python3';
}
// 感知哈希（主人 2026-10-22：同一张图 QQ 每次转存 md5 都不一样，像素不变——
// 「开心.jpg」和「图中有一个蓝绿色头发」就是同图收了两次）。8x8 aHash，汉明距离 ≤5 判为同图。
function stickerPHash(buf, mode) {
  return new Promise(resolve => {
    const tmp = path.join(require('os').tmpdir(), 'st_' + Date.now() + Math.random().toString(36).slice(2));
    try { fs.writeFileSync(tmp, buf); } catch { return resolve(''); }
    const py = (cfg && cfg.qzone && cfg.qzone.pythonPath) || defaultPython();
    // mode: 空 = 8x8 aHash（收图去重的老口径，别动）；'d16' = 16x16 dHash（图库认图用）
    const args = [path.join(__dirname, '..', 'scripts', 'sticker_hash.py'), tmp].concat(mode ? [mode] : []);
    require('child_process').execFile(py, args, { timeout: 20000 }, (err, so) => {
      try { fs.unlinkSync(tmp); } catch {}
      try { const j = JSON.parse(String(so || '')); resolve(j.ok ? j.h : ''); } catch { resolve(''); }
    });
  });
}
// 图片类型判定（2026-11-22 主人定：以后不收截图、插画，漫画只收简单的）。
// 判在 src/scripts/sticker_kind.py：界面截图(OCR 多小字)/插画(量化色数≥110)/漫画整页(竖版白底分镜)。
// 算不出来一律放过，不能因为判图把正常表情包挡了。
function stickerKind(buf) {
  return new Promise(resolve => {
    const tmp = path.join(require('os').tmpdir(), 'sk_' + Date.now() + Math.random().toString(36).slice(2));
    try { fs.writeFileSync(tmp, buf); } catch { return resolve({ ok: false }); }
    const py = (cfg && cfg.qzone && cfg.qzone.pythonPath) || defaultPython();
    const args = [path.join(__dirname, '..', 'scripts', 'sticker_kind.py'), tmp];
    require('child_process').execFile(py, args, { timeout: 30000 }, (err, so) => {
      try { fs.unlinkSync(tmp); } catch {}
      try { const j = JSON.parse(String(so || '')); resolve(j && j.ok ? j : { ok: false }); } catch { resolve({ ok: false }); }
    });
  });
}
// 同步版，只给「启动对账补登记」用（stickerReconcile 是同步函数，等不了 Promise）。
// 同一个 python 脚本、同一个默认口径（8x8 aHash），算不出来就返回空，绝不影响对账本身。
function stickerPHashSync(rel, mode) {
  try {
    const py = (cfg && cfg.qzone && cfg.qzone.pythonPath) || defaultPython();
    const args = [path.join(__dirname, '..', 'scripts', 'sticker_hash.py'), path.join(STICKER_DIR, rel)];
    if (mode) args.push(mode);
    const so = require('child_process').execFileSync(py, args,
      { timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(String(so || ''));
    return j.ok ? j.h : '';
  } catch { return ''; }
}
// ===== 图库认图（2026-11-05 主人定：她发图，先认是不是她自己库里的那张）=====
// 为什么要另建索引：.md5.json 是按文件 md5 存的，QQ 每转存一次 md5 就变，而且 353 条里只有 36 条留了像素哈希。
// 所以另存 .phash.json：键=相对路径（稳定），值=16x16 dHash（256 bit）。
// 为什么不用老 8x8 aHash：白底表情包互撞得厉害（实测「疑惑.jpg」和「q笑17.jpg」同一个哈希）。
// 实测口径：库里同一张图（含换名重复）距离 0~2；不同图最近 16；QQ 重新压缩后 0~3，
// 但动图转成静态图会到 11（「探头.gif」q60 实测）→ 阈值定 14：够认动图转码，又离「不同图 16」留一点。
const STICKER_PHASH = path.join(STICKER_DIR, '.phash.json');
const LIB_HIT_MAX = 14;                 // 汉明距离（bit）≤14 算同一张图
let _libCache = { key: '', map: {} };
let _libAt = 0;                         // 上次跑增量索引的时间（节流）
let _libBusy = false;
function libMap() {
  try {
    const st = fs.statSync(STICKER_PHASH);
    const key = st.mtimeMs + ':' + st.size;
    if (key === _libCache.key) return _libCache.map;
    const raw = fileCache.readJson(STICKER_PHASH) || {};
    // __v 是格式版本（2 = 每项可能是 [白底版, 黑底版] 两个哈希）；老索引当成没有，触发重建
    const map = raw.__v === 2 ? raw : {};
    _libCache = { key, map };
  } catch { _libCache = { key: 'none', map: {} }; }
  return _libCache.map;
}
function hammingBits(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    n += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return n + Math.abs(a.length - b.length) * 4;
}
// 图库里同一张图常常存了不止一份（她手挑的「悲伤.jpg」+ 自动收的「q害怕1」+ 一批 media_image_xxx），
// 距离都是 0。挑哪个名字报给模型，按这个分数来：名字有意义 2 分（太长 1 分）、情绪图 +0.5、常用/虚幻池 +1（她手挑的最可信）。
// 不加这条的话会挑到「media_image_20261102001114327_afa0」——报给模型等于没认出来。
function libNameQuality(rel) {
  const raw = String(rel || '').split('/').pop().replace(/\.[^.]+$/, '');
  const junk = /^media_image/i.test(raw) || /^\d+$/.test(raw) || /^[a-f0-9]{16,}$/i.test(raw) || /^收集\d{4}$/.test(raw);
  let q = junk ? 0 : (raw.length <= 8 ? 2 : 1);
  if (/[一-龥]/.test(raw)) q += 0.5;          // 中文名比英文/拼音好读（库里混着 rtest_prob 这种测试名）
  if (/^q(?!q)/i.test(raw)) q += 0.5;
  if (/^(常用|虚幻)\//.test(String(rel))) q += 1;
  return q;
}
// 图库里有没有这张：命中返回相对路径（可用/q悲伤1.jpg），没有返回 ''
function stickerLibHit(h) {
  if (!h || h.length < 32) return '';
  const map = libMap();
  const cands = [];
  for (const rel of Object.keys(map)) {
    if (rel === '__v') continue;
    const vh = map[rel];
    const list = Array.isArray(vh) ? vh : [vh];       // 透明图存了白底/黑底两版，取最近的那个
    let d = LIB_HIT_MAX + 1;
    for (const one of list) {
      if (!one || one.length !== h.length) continue;
      const x = hammingBits(one, h);
      if (x < d) d = x;
    }
    if (d <= LIB_HIT_MAX) cands.push([rel, d]);
  }
  if (!cands.length) return '';
  cands.sort((a, b) => (a[1] - b[1]) || (libNameQuality(b[0]) - libNameQuality(a[0])));
  for (const [rel] of cands) {
    try { if (fs.existsSync(path.join(STICKER_DIR, rel))) return rel; } catch {}   // 索引里躺着已删的图
  }
  return '';
}
// 库里的名字：「可用/q悲伤1.gif」→「悲伤」；「关键词触发/蓝发小女孩2.jpg」→「蓝发小女孩」
function stickerLibLabel(rel) {
  let n = String(rel || '').split('/').pop().replace(/\.[^.]+$/, '');
  n = n.replace(/\d+$/, '');
  if (/^q(?!q)/i.test(n)) n = n.slice(1);
  return n || String(rel || '');
}
// 增量补索引：她新丢进文件夹的图、新收到的图，都要认得出。
// 一次 python 批量算（只算缺的，全量 415 张约 3 秒、增量一张约 0.2 秒）；30 秒内不重复跑，失败就当没有索引。
function stickerLibRefresh(force) {
  const now = Date.now();
  if (_libBusy) return;
  if (!force && now - _libAt < 30 * 1000) return;
  _libAt = now;
  _libBusy = true;
  const py = (cfg && cfg.qzone && cfg.qzone.pythonPath) || defaultPython();
  require('child_process').execFile(py,
    [path.join(__dirname, '..', 'scripts', 'sticker_hash_index.py'), STICKER_DIR, STICKER_PHASH],
    { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, so) => {
      _libBusy = false;
      if (err) { console.log('[图库] 建索引失败：' + String(err.message || err).slice(0, 60)); return; }
      try {
        const j = JSON.parse(String(so || ''));
        if (!j.ok) return;
        fs.writeFileSync(STICKER_PHASH, JSON.stringify(j.index), 'utf8');
        _libCache = { key: 'none', map: {} };      // 下次用时重读
        if (j.added) console.log('[图库] 补了 ' + j.added + ' 张指纹（库里共 ' + j.total + ' 张）');
      } catch (e) { console.log('[图库] 索引写盘失败：' + e.message.slice(0, 60)); }
    });
}
function hammingHex(a, b) { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; }
// 新图起名（2026-10-30 主人定）：情绪类 q<情绪><序号>（q哭1）；关键词类 <描述><序号>（蓝发小女孩2）。
// 一律带编号存盘；调取时可省编号（stickerHit 里做前缀匹配）。整体不超 10 字——名字超了会被洗名截断。
function stickerMakeName(desc) {
  let base = '';
  const d = String(desc || '');
  // 2026-11-05：识图改成三行格式后，情绪单独一行。先认这一行——
  // 「字：」行里可能出现「哭」「笑」这种字，整段扫会被图上的文字带偏。
  const emoLine = (d.match(/情绪[：:]\s*([^\n/／；;]+)/) || [])[1] || '';
  const pickEmo = s => {
    for (const pair of VIS_EMO) if (pair[1].some(k => s.includes(k))) return 'q' + pair[0];
    return '';
  };
  base = pickEmo(emoLine);
  if (!base) for (const pair of VIS_EMO) {
    if (pair[1].some(k => d.includes(k))) { base = 'q' + pair[0]; break; }
  }
  if (!base) {
    // 情绪没认出：用「是什么：」那句起名（比整段好——整段会把「字无字情绪…」也搓进名字）
    const whatLine = (d.match(/是什么[：:]\s*([^\n]+)/) || [])[1] || '';
    base = stickerName(whatLine) || stickerName(d) || ('收集' + new Date().toISOString().slice(5, 10).replace('-', ''));
  }
  if (base.length > 9) base = base.slice(0, 9);                      // 留一位给序号
  const allBase = stickerFiles().map(f => f.replace(/\.[^.]+$/, '').split('/').pop());
  const same = allBase.filter(n => n === base || (n.startsWith(base) && /^\d+$/.test(n.slice(base.length))));
  let idx = 1;
  if (same.length) {
    idx = Math.max.apply(null, same.map(n => n.length > base.length ? (parseInt(n.slice(base.length), 10) || 0) : 0)) + 1;
  }
  return base + idx;
}
// 已收图总量满 50GB → 提醒主人一次/天（2026-11-17 主人定：取消 500 张上限，改总量 50GB）
let stickerLimitAt = '';
function stickerLimitWarn() {
  const day = new Date().toISOString().slice(0, 10);
  if (stickerLimitAt === day) return;
  stickerLimitAt = day;
  try {
    core.master('表情包总量已经满 50GB，不再自动收了。'
      + '要腾地方：打开「表情包」文件夹删几张不要的，删完自动恢复。');
  } catch {}
}
// ===== 收一张图（字节已经在手上了）—— QQ 群友发的、B站评论区看到的，全走这一个口子 =====
// 为什么抽出来（2026-11-01 主人第 8 条「做在外部，和现在的合并」）：
//   B站评论区收图不能改 astrbot 插件（插件一升级就被覆盖），只能放在项目这边；
//   但又必须和 QQ 收图共用同一套去重 / 清晰度取大 / 命名，不然库里会进重复图。
// opt = { pool: 'normal'|'usable', desc, sourceTag }
// 返回 { ok, rel, why }
// 【分类 X·采集】收图公共口子（QQ群友+B站评论区共用，去重/清晰度/命名）：非回话规则，是素材采集。
async function collectStickerBuf(got, opt) {
  opt = opt || {};
  const pool = opt.pool === 'usable' ? 'usable' : 'normal';
  const desc = opt.desc || '';
  const tag = opt.sourceTag || '来源不明';
  if (!got || !got.buf || !got.buf.length) return { ok: false, why: '空文件' };
  // 2026-11-16 主人定：大于 8MB 的图不再跳过，单独收进「大图/」。原来是直接拒收。
  const isBig = got.buf.length > STICKER_MAX_BYTES;
  const mime = String(got.type || 'image/jpeg').split(';')[0].toLowerCase();
  const ext = mime.indexOf('png') >= 0 ? '.png' : mime.indexOf('webp') >= 0 ? '.webp' : mime.indexOf('gif') >= 0 ? '.gif' : '.jpg';
  // 2026-11-22 主人定：收图前先判类型，截图/插画/复杂漫画页不收（cfg.stickerKindFilter === false 可关掉）
  let kindInfo = null;
  if (!(cfg && cfg.stickerKindFilter === false)) {
    // 描述（识图）兜底：结构判断分不清的高清图，用模型描述里的关键词判（2026-11-22 主人定）
    const dtext = String(desc || '');
    const whyDesc = /截图|聊天记录|评论区|论坛帖子|网页|界面|对话框|弹幕列表/.test(dtext)
      ? 'screenshot'
      : (/插画|立绘|原画|壁纸|海报|画作|绘画作品|艺术图|插图/.test(dtext) ? 'illustration' : '');
    if (whyDesc) {
      console.log('[表情] 不收这张：' + whyDesc + '（描述：' + dtext.slice(0, 40) + '）');
      return { ok: false, why: '不属于表情包（' + whyDesc + '）' };
    }
    kindInfo = await stickerKind(got.buf);
    if (kindInfo && kindInfo.ok
        && (kindInfo.kind === 'screenshot' || kindInfo.kind === 'illustration'
            || (kindInfo.kind === 'manga_page' && !kindInfo.simple))) {
      const mm = kindInfo.m || {};
      console.log('[表情] 不收这张：' + kindInfo.kind + '（' + mm.colors + ' 色 / 白底 ' + mm.white + ' / 长宽 ' + mm.ratio + '）');
      return { ok: false, why: '不属于表情包（' + kindInfo.kind + '）' };
    }
  }
  const md5 = crypto.createHash('md5').update(got.buf).digest('hex');
  const store = stickerMd5Load();
  // 落盘记录可能指向已被挪走/删掉的图（去重清理后留的旧条目）。这种不算「已有」：
  // 否则同图再收会在第一闸被挡掉，连「留名字存大图」都走不到。
  const seenRec = store[md5];
  const seenRel = typeof seenRec === 'string' ? seenRec : ((seenRec && seenRec.f) || '');
  const seenAlive = seenRel && fs.existsSync(path.join(STICKER_DIR, seenRel));
  if (stickerSeen.has(md5) || seenAlive) return { ok: false, why: '已经有了（同一张图）' };   // 去重（内存 + 落盘）
  stickerSeen.add(md5);
  // 像素级去重 + 清晰度优选（2026-10-30 主人定：内容不重复，取清晰度高的）
  // 同一张图再出现：新的明显更清楚（大 15% 以上）→ 覆盖旧文件、文件名留旧的；否则跳过
  const h = await stickerPHash(got.buf);
  const d16 = h ? await stickerPHash(got.buf, 'd16') : '';   // 16x16 精细指纹
  // 2026-11-09 修：16x16 全库索引以前只在 8x8 命中后用来「排除误判」，从不主动认图。
  // 8x8 会随重新压缩漂过阈值 5，那时同图又被另存一份 —— 「留名字存大图」看着就像没了。
  // 现在先主动认一次；命中返回库里现存、名字最有意义的那张的相对路径。
  const libHit = d16 ? stickerLibHit(d16) : '';
  const finishDup = oldRel => {
    const oldPath = path.join(STICKER_DIR, oldRel);
    let oldSize = 0;
    try { oldSize = fs.statSync(oldPath).size; } catch {}
    if (got.buf.length > oldSize * 1.15) {
      try {
        fs.writeFileSync(oldPath, got.buf);
        store[md5] = { f: oldRel, h: h || '', d: String(desc || '').slice(0, 600) };
        stickerMd5Save(store);
        console.log('[表情] 同一张图有更清楚的版本，已替换「' + oldRel + '」');
        botWrite('data/stickers/', '表情包收集', '同一张图换了更清楚的版本，替换「' + oldRel + '」');
        return { ok: true, rel: oldRel, why: '换了更清楚的版本' };
      } catch (e) { return { ok: false, why: '替换失败：' + e.message }; }
    }
    console.log('[表情] 和库里「' + oldRel + '」是同一张图，且已有的更清楚，不重复收');
    return { ok: false, why: '和已有的「' + oldRel + '」是同一张图' };
  };
  let dup = '';
  if (h) {
    for (const v of Object.entries(store)) {
      const vh = typeof v[1] === 'string' ? '' : (v[1].h || '');
      if (!vh || hammingHex(vh, h) > 5) continue;
      // 8x8 指纹在白底表情包上会互撞（本文件 553 行注释自己写过）：撞车若当成同图，
      // 会「拿新图覆盖旧图」坏掉已有图。全库 16x16 真有同图才拦，查不到就当撞车放过。
      if (d16 && !libHit) continue;
      dup = libHit || (typeof v[1] === 'string' ? v[1] : (v[1].f || ''));
      break;
    }
  }
  if (!dup && libHit) dup = libHit;          // 8x8 漂了，但 16x16 认出是同一张
  if (dup && !fs.existsSync(path.join(STICKER_DIR, dup))) dup = '';   // 索引里躺着已删的图
  if (dup) return finishDup(dup);
  // 名字（2026-10-30 新格式）：情绪类 q<情绪><序号>，关键词类 <描述><序号>
  // 2026-11-02 主人定：**落到哪个文件夹按名字分**——q 开头的进根目录（情绪池），
  // 其余进 关键词触发/。以前非 q 的也扔根目录，可根目录现在只认 q，扔进去就永远发不出去了。
  const name = stickerMakeName(desc);
  const isEmoName = /^q(?!q)/i.test(name);
  // 2026-11-03 主人定：**只有她发的情绪图才进 可用/**。
  // 以前是「她发的全进 可用/」，于是「符合自己喜好的烤五花」「星露谷新mod推荐」这种展示图/选项图
  // 也进了情绪池，被当成「她自己的情绪」，清单里还长出一行「名字：名字1」的废话（模型会照念）。
  // 现在：情绪图 → 可用/；其余 → 关键词触发/（和群友的图同一套按名字分）。
  // 2026-11-03 夜 主人定：**所有收图一律写 少用/**，根目录不再承担收发。
  // 根目录从此不写新图，只作为旧存量（q 情绪图）兼容读取；AstrBot 落盘本来就在 少用/。
  const goUsable = pool === 'usable' && isEmoName;
  const goKw = !goUsable && !isEmoName;
  // 2026-11-16 主人定：大于 8MB 的图进「大图/」，和难用同级。
  const dirName = isBig ? '大图' : (goUsable ? '可用' : goKw ? '关键词触发' : '少用');
  const targetDir = isBig ? STICKER_BIG : (goUsable ? STICKER_USABLE : (goKw ? STICKER_KW : STICKER_LOW));
  // 2026-11-17 主人定：取消各文件夹 500 张上限，改成已收图总量 50GB 封顶。
  // 落盘前再算一次总量（拉图前 collectSticker 也算过一次，这里防并发/绕过入口的 B站收图）：
  // 现有总量 + 这张的大小 > 50GB → 不收、提醒一次/天。
  if (stickerTotalBytes() + got.buf.length > STICKER_TOTAL_MAX) {
    stickerLimitWarn();
    return { ok: false, why: '表情包总量已经满 50GB，不再自动收了' };
  }
  const rel = dirName + '/' + name + ext;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, name + ext), got.buf);
  // 完整识图描述按 md5 存一份（主人 2026-11-19 定）：文件名只有 9 字上限，
  // 她要靠改名把图变成符合的情绪，名字一改描述就没了 → 描述必须挂在 md5 上，
  // 改名只动 f（stickerReconcile 只改 v.f），d 天然跟着图走，不会失效。
  store[md5] = { f: rel, h: h || '', d: String(desc || '').slice(0, 600),
    k: (kindInfo && kindInfo.ok) ? kindInfo.kind : '' };
  stickerMd5Save(store);
  // 新图立刻补进图库指纹（增量只算这一张）；30 秒节流，连收好几张也只跑一次
  stickerLibRefresh();
  console.log('[表情] 收了一张：' + rel + '（' + tag + '）' + (isBig ? '（大图，单独存）' : ''));
  botWrite('data/stickers/' + dirName + '/', '表情包收集',
    tag + '「' + name + '」' + (desc ? '（图上：' + String(desc).slice(0, 40) + '）' : ''));
  return { ok: true, rel };
}

async function collectSticker(im, desc, ev) {
  try {
    // 主人发的：群里、私聊都收（情绪图进【可用】，其余进 关键词触发/，2026-11-03 定）
    // 别人发的：只收群聊，全收 —— 没有一天张数上限，只受总量 50GB 封顶（2026-11-17 她定）
    const fromMaster = !!(ev && isMasterUid(ev.user_id));
    if (!fromMaster && (!ev || !ev.group_id)) return;
    if (ev && ev.group_id && String(ev.group_id) === String((cfg || {}).testGroup || '')) return;
    // 2026-11-17：拉图前先看总量，满了就别下载省流量。落盘前 collectStickerBuf 还会再算一次防并发。
    if (!fromMaster && stickerTotalBytes() >= STICKER_TOTAL_MAX) {
      stickerLimitWarn();
      return;
    }
    let url = String((im && (im.url || im.file)) || '');
    if (!/^https?:\/\//i.test(url) && im && im.file) {
      try {
        const r = await callApi('get_image', { file: im.file }, 3000);
        if (r && r.data && /^https?:\/\//i.test(String(r.data.url || ''))) url = r.data.url;
      } catch {}
    }
    if (!/^https?:\/\//i.test(url)) return;
    const got = await core.getBinary(url);
    if (!got || !got.buf) return;
    // 2026-11-01：缓冲拿到手之后的事（去重 / 清晰度取大 / 命名 / 落盘）全交给 collectStickerBuf，
    // 这样 B站评论区收图能跟 QQ 收图共用同一套逻辑，不用复制两份。
    await collectStickerBuf(got, {
      pool: fromMaster ? 'usable' : 'normal',
      desc,
      sourceTag: fromMaster ? '主人发的表情' : ('从群 ' + ev.group_id + ' 收了'),
    });
  } catch (e) { console.log('[表情] 收集失败：' + e.message); }
}
// 模型爱说的表情名 → 实际有的图（2026-10-22：它说[表情:心疼]，目录里没有，日志报「没有这张」）
const STICKER_ALIAS = { '心疼': '担心', '心疼疼': '担心', '抱抱': '喜欢', '呜呜': '虚幻哭', '委屈': '悲伤', '累': '疲惫', '哭': '悲痛' };
// 同步判定库里有没有这张（发不发由 sendSticker，记不记日志用这个）
// ===== 关键词类「拆词 + 模糊」兜底（2026-11-01 主人定）=====
// 只作用在**关键词触发/ 里的关键词类图**上；情绪类（常用/可用/虚幻/根目录 q）一律不碰。
// 目的：长名字图（淳平三角洲堵桥乌鲁鲁、蓝发小女孩1）说一半、说近了也能发。
// 图池仍是 stickerFiles() 实时扫目录 —— 以后丢进根目录的新图自动生效，不用登记、不用改这份代码。
const KW_NAME_MIN = 4;    // 图名至少 4 字才参与兜底（短名照样只走精确，避免"开心"被"开"拉走）
const KW_WANT_MIN = 2;    // 触发词至少 2 字（单字太泛，会乱发）
const KW_WANT_MAX = 12;   // 触发词太长不像图名（多半是整句话），不做拆词
const KW_FUZZ_WANT = 3;   // 模糊层触发词至少 3 字（2 字交给拆词层，不然太容易撞）
const KW_EXTRA_MAX = 4;   // 图名最多比触发词多 4 个字（再多就不是"说近了"，是另一张）
// ===== ⑦⑧ 两层（2026-11-01 主人第 2 条：「读一样的触发 + 字型一样的可有前后缀」）=====
// 主人原话：「小菲，小塔，小塔菲，这种是前缀啊，还有后缀 菲酱」「沙溢斯 shayisi 不都是一个读音吗」
// ⑦ 谐音：转拼音再比（沙溢斯 shayisi = 啥意思 shayisi，能捞到「淳平啥意思」）
// ⑧ 前后缀：剥掉称呼词（小X / X酱）再对图名
const KW_NAME_MIN2 = 2;  // ⑦⑧ 层的图名门槛：≥2 字（「塔菲」这种两字图名也要能认）
const KW_PY_MIN = 4;     // 触发词拼音至少 4 个字母（<4 是单字，谐音全是噪音）
const KW_AFFIX_PRE = ['小', '大', '老', '阿'];                      // 前缀称呼：小菲 / 老张
const KW_AFFIX_SUF = ['酱', '子', '喵', '宝', '儿', '君', '桑', '崽'];  // 后缀称呼：菲酱 / 塔喵
// 汉字 → 无声调拼音。表在 data/拼音表.json（403 个拼音键、20772 个字）。
// 独立文件是为了不把 6 万字塞进代码；读不到就返回空 Map，⑦ 层自动失效、其余层照常。
let _pyTable = null;
function pyMap() {
  if (_pyTable) return _pyTable;
  _pyTable = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', '拼音表.json'), 'utf8'));
    for (const py of Object.keys(raw)) for (const ch of raw[py]) if (!_pyTable.has(ch)) _pyTable.set(ch, py);
  } catch {}
  return _pyTable;
}
function pyOf(s) {
  const m = pyMap();
  if (!m.size) return '';
  let out = '';
  for (const ch of String(s || '')) {
    if (/[a-z0-9]/i.test(ch)) { out += ch.toLowerCase(); continue; }   // 英文数字原样保留
    const p = m.get(ch);
    if (p) out += p;
  }
  return out;
}
const _pyNameCache = new Map();     // 图名拼音缓存（图名不变就一直有效，改名后新名重新算）
function pyOfName(s) {
  let v = _pyNameCache.get(s);
  if (v === undefined) { v = pyOf(s); _pyNameCache.set(s, v); }
  return v;
}
// 是子序列（字按顺序都在，允许中间跳字）：「小菲」是「小塔菲」的子序列
function isSubseq(a, b) {
  let i = 0;
  for (const ch of String(b)) { if (ch === String(a)[i]) i++; if (i >= a.length) return true; }
  return i >= String(a).length;
}
// 剥称呼词缀（剥两轮：「小菲酱」→ 菲）
function kwStrip(s) {
  let t = String(s || '');
  for (let round = 0; round < 2; round++) {
    const before = t;
    for (const p of KW_AFFIX_PRE) if (t.length > p.length && t.startsWith(p)) { t = t.slice(p.length); break; }
    for (const q of KW_AFFIX_SUF) if (t.length > q.length && t.endsWith(q)) { t = t.slice(0, -q.length); break; }
    if (t === before) break;
  }
  return t;
}
// 从一句话里滑窗取 2~4 字片段（「小菲唐氏喵」→ 小菲 / 菲唐 / 唐氏 / 氏喵 / 小菲唐 …）
function kwFrags(w) {
  const s = String(w || '');
  const out = [];
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i + len <= s.length; i++) {
      const f = s.slice(i, i + len);
      if (out.indexOf(f) < 0) out.push(f);
    }
  }
  return out;
}
// 片段核心 vs 图名，返回得分（0 = 不中）。分数里带「长度接近」偏好，说「塔菲」优先「塔菲」而不是「塔菲跳舞」。
function kwCoreHit(core, name) {
  const c = String(core || ''), n = String(name || '');
  if (!c || !n) return 0;
  if (n.includes(c)) return (2 + c.length) * 100 - Math.abs(n.length - c.length);
  // 跳字：核心的字按顺序都在图名里，且覆盖图名 2/3 以上（「小菲」→「小塔菲」）
  if (c.length >= 2 && c.length * 3 >= n.length * 2 && isSubseq(c, n)) {
    return (1 + c.length) * 100 - Math.abs(n.length - c.length);
  }
  // 单字核心：必须是图名的首字或尾字，且图名不长（「小菲」剥掉「小」剩「菲」= 塔菲的尾字）
  if (c.length === 1 && n.length <= 4 && (n.startsWith(c) || n.endsWith(c))) return 100;
  return 0;
}
// 最长公共子序列长度：用"共同的字有多少"衡量像不像，顺序保留，"漏字/多字"都只扣一点。
function lcsLen(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[n];
}

function stickerHit(name) {
  const files = stickerFiles();
  const want = String(name || '').trim();
  if (!want) return null;
  // 2026-10-23 真 bug：常用目录的文件在 stickerFiles() 里带「常用/」前缀（用来区分两个目录），
  // 这里却直接拿全路径去比名字 → 「疑惑」明明躺在 data/stickers/常用/ 里，她照样报「库里没有这张」，
  // 常用单 16 张全部匹配不上。比较时只取文件名。
  const base = f => f.replace(/\.[^.]+$/, '').split('/').pop();
  // 大小写归一（2026-11-01 主人：「修大小写，VS/Vs/vS 都能中」）：库里 124 张图名带英文字母
  // （DeepSeek / Gemini / NapCat / Token / QQ…），模型或群友换个大小写以前就判「库里没有这张」。
  // 比较一律转小写，返回的仍然是磁盘上的原名。
  const low = s => String(s).toLowerCase();
  const wantL = low(want);
  const baseL = f => low(base(f));

  // ⓵ 点名了具体编号（q哭1 / 蓝发小女孩3）→ 就是要那一张，不随机
  if (/\d$/.test(want)) {
    const exact = files.find(f => baseL(f) === wantL);
    if (exact) return exact;
  }
  // ⓶ 按「场合组」找（2026-10-31 主人第 4 条）：说「哭」= 想哭那一整类，从整组里挑一张，
  //    不写死发「哭」本身。冒号前的描述、冒号后的图名都算触发词，都进组。
  //    同情绪同池（2026-11-01 主人：「所有同情绪也是同池」）：组里点名的图 + **所有以它们开头的图**一起进池，
  //    所以「疑惑」不只是 疑惑.jpg，而是 疑惑 / 疑惑1 / 疑惑2 / 可用里那张疑惑；「哭」也是 哭 / 哭1。
  const g = stickerGroupOf(want);
  if (g && g.names.length) {
    const pre = g.names.map(low);
    const inGroup = files.filter(f => pre.indexOf(baseL(f)) >= 0);
    if (inGroup.length) {
      const famSet = new Set(inGroup);
      for (const f of files) {
        const b = baseL(f);
        if (pre.some(p => b === p || b.startsWith(p))) famSet.add(f);
      }
      const picked = pickFromCands([...famSet]);
      if (picked) return picked;
    }
  }
  // ⓷ 不在任何组里、但名字就是文件名（关键词类，如「蓝发小女孩」）→ 直接发。
  //    「同一家的」一起进池子随机（2026-11-01 主人：「情绪和关键词图都是，池内随机。所有的奶龙都能入」）：
  //    说「奶龙」不是只发 奶龙.gif，而是 奶龙.gif / 奶龙vs美团 / 奶龙论战很爽 … 一起按池权重随机；
  //    带编号的兄弟（q怒1…q怒9）也算同一家 —— 整名本身带编号的（q委屈1）在 ⓵ 就返回了，不会漏到这儿，
  //    所以「q委屈1」永远不会被 10~19 号串走。
  //    原来单列一层的「无编号调取」（[表情:q哭] → q哭1/q哭2… 随机）条件已被这一层完全包含，合并进来，不留死代码。
  const family = files.filter(f => {
    const b = baseL(f);
    return b === wantL || b.startsWith(wantL);
  });
  if (family.length) {
    const picked = pickFromCands(family);
    if (picked) return picked;
  }
  // ⓹ 第三层（2026-10-31）：模型常常把 q 省掉、或把编号省掉 —— `[表情:哭]`、`[表情:分析后发言]`
  // 以前一律「库里没有这张」。按「去掉 q 和编号后同名」再找一次。
  if (want.length >= 1) {
    const stem = n => low(n).replace(/^q/, '').replace(/\d+$/, '');
    const cands = files.filter(f => baseL(f) === 'q' + wantL || stem(base(f)) === wantL);
    const picked = pickFromCands(cands);
    if (picked) return picked;
  }
  // 老别名表放最后（2026-10-31 调顺序）：它是 q哭1 这批名字出现之前写的，
  // 「哭→悲痛」这种硬映射会盖掉新名字，所以先让真名字/同情绪名字命中，实在没有再走别名。
  const aliasKey = STICKER_ALIAS[want] ? want : Object.keys(STICKER_ALIAS).find(k => low(k) === wantL);
  if (aliasKey) {
    const a = files.find(f => baseL(f) === low(STICKER_ALIAS[aliasKey]));
    if (a) return a;
  }
  // ⓺ 关键词类兜底（2026-11-01）：说一半（拆词）+ 说近了（模糊）。
  //    放在最后 —— 上面所有精确/前缀/组/别名路径原样不动，只有本来要报「库里没有这张」的才走这里。
  //    图池来自 stickerFiles() 实时扫目录，新丢进根目录的图自动参与，不需要任何登记表。
  // 开关：config.json → sticker.keywordFuzzy（1 开 / 0 关，默认开；面板表情页可改，改完立刻生效）
  const kwOn = ((cfgLive().sticker || {}).keywordFuzzy) !== 0;
  if (kwOn && want.length >= KW_WANT_MIN && want.length <= KW_WANT_MAX) {
    const w = wantL.replace(/[\s，。！？、；：,.;:!?「」『』（）()]/g, '');
    const kwStem = n => low(n).replace(/^q/, '').replace(/\d+$/, '');
    // 两级池：kwAll（≥2 字，给 ⑦⑧ 谐音/前后缀用）、kw（≥4 字，给 ⓺ 拆词模糊用，口径与原来一致）
    const kwAll = [];
    const kw = [];
    for (const f of files) {
      if (core.stickerIsEmotion(f)) continue;      // 只留关键词类（情绪类全跳过）；2026-11-16 起难用/大图里的非 q 图也算，关键词图与优先级档无关
      const n = kwStem(base(f));
      if (n.length < KW_NAME_MIN2) continue;
      const item = { f, n };
      kwAll.push(item);
      if (n.length >= KW_NAME_MIN) kw.push(item);
    }
    if (kwAll.length && w.length >= KW_WANT_MIN) {
      // ① 拆词：图名里含这个片段（或这段更长的描述里含图名）→ 就是说到这张图
      const sub = kw.filter(x => x.n.includes(w) || w.includes(x.n));
      if (sub.length) {
        // 只留「长度最接近触发词」的一档：说「小女孩」时优先 5~6 字的图，不被超长名字稀释
        let best = Infinity;
        for (const x of sub) best = Math.min(best, Math.abs(x.n.length - w.length));
        const near = sub.filter(x => Math.abs(x.n.length - w.length) <= best + 1);
        const picked = pickFromCands(near.map(x => x.f));
        if (picked) return picked;
      }
      // ② 模糊：错字 / 漏字 / 多字。判据用「触发词有几个字没对上」+「图名多出几个字」，
      //    比单纯算相似度更贴合中文长名：说「蓝发女娃」也能认成「祥子蓝发小女孩」。
      if (w.length >= KW_FUZZ_WANT) {
        const maxMiss = w.length >= 6 ? 2 : 1;   // 长一点的话允许错/漏 2 个字
        let bestMiss = Infinity, bestExtra = Infinity, bestList = [];
        for (const x of kw) {
          const L = lcsLen(w, x.n);
          if (!L) continue;
          const miss = w.length - L;             // 触发词里没对上的字
          const extra = x.n.length - L;          // 图名比触发词多出来的字
          if (miss > maxMiss || extra > KW_EXTRA_MAX) continue;
          if (miss < bestMiss || (miss === bestMiss && extra < bestExtra)) {
            bestMiss = miss; bestExtra = extra; bestList = [x.f];
          } else if (miss === bestMiss && extra === bestExtra) bestList.push(x.f);
        }
        if (bestList.length) {
          const picked = pickFromCands(bestList);
          if (picked) return picked;
        }
      }
      // ⑦ 谐音（主人第 2 条「读一样的触发」）：转拼音再比。
      //    「沙溢斯」shayisi 就是「啥意思」shayisi → 是「淳平啥意思」chunpingshayisi 的一段 → 算说到这张图。
      const pw = pyOf(w);
      if (pw.length >= KW_PY_MIN) {
        const hits = [];
        for (const x of kwAll) {
          const pn = pyOfName(x.n);
          if (pn.length < KW_PY_MIN) continue;
          if (pn.includes(pw) || pw.includes(pn)) hits.push(x.f);
        }
        const picked = pickFromCands(hits);
        if (picked) return picked;
      }
      // ⑧ 字型前后缀（主人第 2 条后半）：从整句里滑窗取片段，剥掉称呼词，核心对上图名就算。
      //    「小塔」「小菲」「菲酱」「小菲唐氏喵」全部命中。取分最高的一档，多张再按池权重随机。
      let bestScore = 0, bestF = [];
      for (const fr of kwFrags(w)) {
        // 2026-11-01 修：全英文片段没有意义。以前只比中文没事，做了大小写归一小写后，
        // 「deepseek」会被切成 de / ee / ep…，de 又刚好是 cloude 的结尾 → 乱发一张图。纯英片段直接跳过。
        if (!/[\u4e00-\u9fa5]/.test(fr)) continue;
        const core = kwStrip(fr);
        if (!core) continue;
        for (const x of kwAll) {
          const sc = kwCoreHit(core, x.n);
          if (!sc) continue;
          if (sc > bestScore) { bestScore = sc; bestF = [x.f]; }
          else if (sc === bestScore) bestF.push(x.f);
        }
      }
      const picked3 = pickFromCands(bestF);
      if (picked3) return picked3;
    }
  }
  return null;
}
// ===== 手动放图自动去重（2026-11-09 主人定：手动放进来的图也要自动清，留名字存大图）=====
// 全量扫当前图库，按 16×16 指纹距离 ≤6 判「画面一样」，每组只留有意义的名字，内容取组内最大。
// 为什么全量而不是只看「新登记」：她从库里复制/拖回的图 md5 已存在，走的是 ① 改名接上，
// 根本不会进新登记；只看新登记会漏掉这类重复。
// 清单 / 常用.md / 关键词.md 里挂着的名字一律保留，不丢触发词；清完再跑不会再动（幂等）。
// 副本挪进 回收站/，不删除；覆盖前把原内容另存一份，随时能拿回来。
function stickerManualDedupe(store) {
  const base = r => String(r).split('/').pop().replace(/\.[^.]+$/, '');
  const junk = n => /^media_image/i.test(n) || /^\d+$/.test(n) || /^[0-9a-f]{16,}$/i.test(n) || /^收集\d{4}$/.test(n);
  const abs = r => path.join(STICKER_DIR, r);
  const size = r => { try { return fs.statSync(abs(r)).size; } catch { return 0; } };
  const trash = r => {
    const t = path.join(STICKER_DIR, '回收站');
    fs.mkdirSync(t, { recursive: true });
    let dst = path.join(t, path.basename(r)), n = 1;
    while (fs.existsSync(dst)) dst = path.join(t, base(r) + '_' + (n++) + path.extname(r));
    return dst;
  };
  const out = { moved: 0, replaced: 0 };
  const lib = libMap();
  if (Object.keys(lib).length < 50) return out;         // 索引还没建好，等下一次，别同步算 400 张卡住对账
  const files = stickerFiles();
  const missing = files.filter(f => !lib[f]);
  if (missing.length > 20) { stickerLibRefresh(); return out; }   // 一次放太多，先让索引补上，下次再清
  const H = {};
  for (const f of files) {
    if (!fs.existsSync(abs(f))) continue;
    const v = lib[f];
    const one = Array.isArray(v) ? (v[0] || '') : (v || '');
    const d = one || stickerPHashSync(f, 'd16');
    if (d) H[f] = d;
  }
  let refs = '';
  for (const p of [STICKER_COMMON_MD, STICKER_KW_MD, path.join(STICKER_DIR, '清单.md')]) {
    try { refs += fs.readFileSync(p, 'utf8'); } catch {}
  }
  const score = r => {
    const pool = { '常用/': 5, '虚幻/': 5, '可用/': 4, '关键词触发/': 3, '少用/': 2 }[String(r).split('/')[0] + '/'] || 1;
    const n = base(r);
    let q = junk(n) ? 0 : (n.length <= 8 ? 2 : 1);
    if (/[一-龥]/.test(n)) q += 0.5;
    return pool * 10 + q;
  };
  const dist = (a, b) => (a && b && a.length === b.length) ? hammingBits(a, b) : 999;
  const keys = Object.keys(H), used = new Set();
  let ph = null;
  for (let i = 0; i < keys.length; i++) {
    const f = keys[i];
    if (used.has(f)) continue;
    const grp = [f];
    for (let j = i + 1; j < keys.length; j++) {
      if (!used.has(keys[j]) && dist(H[f], H[keys[j]]) <= 6) grp.push(keys[j]);
    }
    if (grp.length < 2) continue;
    grp.forEach(x => used.add(x));
    const named = grp.filter(x => !junk(base(x)));
    const best = (named.length ? named : grp).slice()
      .sort((a, b) => (score(b) - score(a)) || (size(b) - size(a)) || a.localeCompare(b))[0];
    const keepers = [...new Set([best].concat(named.filter(x => refs.indexOf(base(x)) >= 0)))];
    const remove = grp.filter(x => keepers.indexOf(x) < 0);
    const big = grp.slice().sort((a, b) => size(b) - size(a))[0];
    for (const k of keepers) {                          // 留名字存大图
      if (size(k) >= size(big)) continue;
      try {
        fs.copyFileSync(abs(k), trash('__覆盖前__' + path.basename(k)));
        fs.copyFileSync(abs(big), abs(k));
        out.replaced++;
      } catch {}
    }
    for (const k of keepers) {
      try {
        const mh = crypto.createHash('md5').update(fs.readFileSync(abs(k))).digest('hex');
        store[mh] = { f: k, h: stickerPHashSync(k) };
      } catch {}
    }
    for (const r of remove) {
      let rh = '';
      try { rh = crypto.createHash('md5').update(fs.readFileSync(abs(r))).digest('hex'); } catch {}
      try {
        fs.renameSync(abs(r), trash(r));
        if (rh && typeof store[rh] === 'object') store[rh].f = keepers[0];
        if (!ph) { try { ph = fileCache.readJson(STICKER_PHASH); } catch { ph = null; } }
        if (ph) delete ph[r];
        out.moved++;
      } catch {}
    }
  }
  if (ph) { try { fs.writeFileSync(STICKER_PHASH, JSON.stringify(ph), 'utf8'); } catch {} }
  if (out.moved || out.replaced) stickerMd5Save(store);
  return out;
}

// ===== 场合对账（2026-10-30 主人定：她手动改名/删图/加图后，清单要自己跟上）=====
// ① 图不在了 → 场合条目直接删（主人明确说不回滚，不留 已删除.json）
// ② 改了名 → 用 md5 认出是同一张，场合自动搬到新名（以后随便改名都不掉描述）
// ③ 新加的图没场合 → 收集进 noOcc，面板能看到，带 q 的等补
// 跑在：机器人启动时 + 面板打开表情页时。幂等，跑几次结果一样。
function stickerReconcile() {
  // 报告口径（2026-10-31 主人第 8 条定的三个数）：
  //   pureDesc   纯描述 —— 这一行的图名在库里一个都找不到。**可以单独存在，不删**
  //   classified 已分类 —— 表里有描述、图也在库里的张数
  //   needDesc   需描述 —— 情绪类、表里没写、自动补也补不出来。正常应该恒为 0，非 0 就是 bug
  const report = { pureDesc: 0, classified: 0, needDesc: [], renamed: [], fixed: 0, filled: 0 };
  const files = stickerFiles();
  const baseOf = f => f.replace(/\.[^.]+$/, '').split('/').pop();
  const absOf = rel => path.join(STICKER_DIR, rel);
  const mdOf = rel => {
    try { return crypto.createHash('md5').update(fs.readFileSync(absOf(rel))).digest('hex'); }
    catch { return ''; }
  };
  const nowByMd5 = new Map();
  for (const f of files) { const h = mdOf(f); if (h) nowByMd5.set(h, f); }
  const nameSet = new Set(files.map(baseOf));
  const store = stickerMd5Load();

  // ⓿ 全量补指纹（2026-10-31 修「改名没自动跟上」的根因）
  // 以前只登记 QQ 上收到的图 —— 主人手动拖进 常用/ 的十几张一条记录都没有，
  // 她一改名，对账手里没有旧名字，认不出是同一张：条目没了、新名字算新图。
  // 现在每次先扫四个文件夹补全。补的时候记的是**当前**名字，所以以后改名能跟，入册前改过的追不回来。
  let idxNew = 0;
  for (const [h, f] of nowByMd5.entries()) {
    if (store[h]) continue;                       // 老记录（含旧名字）绝不覆盖，否则改名就接不上了
    // 2026-11-08 修：这里原来把画面指纹写死成空字符串，等于新登记的图永远不参与像素去重。
    // 存量那批空指纹就是这么攒出来的；补登记时顺手算一次，以后不再产生新的空指纹。
    store[h] = { f, h: stickerPHashSync(f) };
    idxNew++;
  }

  // 2026-11-17 修「客户端改名→md 缺失」：读失败必须和「文件本来就是空的」分开。
  // 旧代码读失败 catch{} 留 mdLines=[]，下面只要 renameMap 非空就把空数组整表写回 → md 被清空。
  // 现在记 mdReadOk：读失败一律不写回，保住原文件（供用户改的地方绝不能因用户修改而失效）。
  let mdRaw = null;
  try { mdRaw = fileCache.readText(STICKER_COMMON_MD); } catch {}
  const mdReadOk = mdRaw != null;
  let mdLines = mdReadOk ? mdRaw.split('\n') : [];

  // ① 改名：md5 还在、旧名字没了、新名字出现了 → 把表里那一行的图名换掉
  const renameMap = {};
  for (const [h, v] of Object.entries(store)) {
    const oldName = baseOf(typeof v === 'string' ? v : (v && v.f) || '');
    if (!oldName || nameSet.has(oldName)) continue;
    const cur = nowByMd5.get(h);
    if (!cur) continue;                                  // 图真没了，不动表（纯描述保留）
    const newName = baseOf(cur);
    if (newName !== oldName) { renameMap[oldName] = newName; report.renamed.push(oldName + ' → ' + newName); }
  }
  if (Object.keys(renameMap).length) {
    mdLines = mdLines.map(l => {
      const m = l.match(/^([-*]\s*)(.+?)(\s*[:：]\s*)(.+)$/);
      if (m) {
        let changed = false;
        const out = m[4].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean).map(p => {
          if (renameMap[p]) { changed = true; report.fixed++; return renameMap[p]; }
          return p;
        });
        return changed ? m[1] + m[2] + m[3] + out.join('、') : l;
      }
      // 没冒号的行 = 描述框空着的「纯描述」行（`- 图名1、图名2`）：图名也得跟着改，
      // 否则改完名这一整行就成了找不到图的纯描述，看着像图丢了（2026-11-01 补）。
      const m2 = l.match(/^([-*]\s*)([^:：]+)$/);
      if (!m2) return l;
      let changed2 = false;
      const out2 = m2[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean).map(p => {
        if (renameMap[p]) { changed2 = true; report.fixed++; return renameMap[p]; }
        return p;
      });
      return changed2 ? m2[1] + out2.join('、') : l;
    });
    // 读失败绝不写回（否则把原 md 覆盖成空）；写用临时文件+原子 rename，中途失败也不损坏原文件
    if (mdReadOk) {
      try {
        const tmp = STICKER_COMMON_MD + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, mdLines.join('\n'), 'utf8');
        fs.renameSync(tmp, STICKER_COMMON_MD);
      } catch (e) { console.log('[表情] 对账写回 md 失败，原文件保留：' + e.message); }
    } else {
      console.log('[表情] 对账读 md 失败，跳过写回，保住原文件（改名仍生效，md 未改）');
    }
  }

  // ② 统计（2026-10-31 主人定：**不删任何东西** —— 纯描述本来就可以单独存在）
  const inBook = new Set();
  for (const l of mdLines) {
    const m = l.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const names = m[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean);
    const alive = names.filter(n => nameSet.has(n));
    if (!alive.length) { report.pureDesc++; continue; }   // 一个图都没有 → 纯描述
    for (const n of alive) { inBook.add(n); report.classified++; }
  }
  // ③ 情绪类、表里没写、自动补也补不出来 → bug 清单
  for (const f of files) {
    const n = baseOf(f);
    if (inBook.has(n)) continue;
    if (!core.stickerIsEmotion(f)) continue;             // 关键词类不需要描述
    if (core.stickerAutoOcc(n)) continue;                // 能自动补 → 不算缺
    report.needDesc.push(n);
  }

  // md5 索引：改名就更新；**图没了也不删记录**（2026-10-31 主人第 3 条：只增不减，我来减）
  // 留着旧记录，哪天把图放回来还能认出是同一张、场合自动接上 —— 面板上就是这么写的承诺，
  // 以前这里会 delete，等于承诺了却做不到。场合表那边本来就不删，这里也不能删。
  let idxChanged = false;
  for (const [h, v] of Object.entries(store)) {
    const cur = nowByMd5.get(h);
    if (!cur) continue;                                   // 图暂时不在：记录留着，不动
    const curName = typeof v === 'string' ? '' : (v && v.f) || '';
    if (curName !== cur) { if (typeof v === 'string') store[h] = cur; else v.f = cur; idxChanged = true; }
  }
  if (idxChanged || idxNew) stickerMd5Save(store);
  report.filled = idxNew;

  // ⓿-b 放在 return 前：前面的改名 / 统计都要用完整文件列表，不能被挪图影响。
  try {
    const d = stickerManualDedupe(store);
    if (d.moved) console.log('[对账] 手动放图去重 ' + d.moved + ' 张（留名字存大图 ' + d.replaced + ' 张）');
  } catch (e) { console.log('[对账] 手动放图去重失败：' + e.message); }
  if (report.renamed.length || idxNew || report.needDesc.length) {
    console.log('[对账] 改名接上 ' + report.renamed.length + ' 张；纯描述 ' + report.pureDesc + ' 条；'
      + '已分类 ' + report.classified + ' 张；需描述 ' + report.needDesc.length + ' 张（bug）；新登记指纹 ' + idxNew + ' 张');
  }
  return report;
}

function sendSticker(ev, name, allowOff) {
  const hit = stickerHit(name);
  if (!hit) return false;
  const abs = path.join(STICKER_DIR, hit).replace(/\\/g, '/');
  // 2026-11-18 真机实测定案（测试群 100000000）：当前 NapCat 读不了本机 file:/// 路径，
  // 一律 retcode 1200 EPERM（含 %20 转义、裸路径三种都失败）；base64:// 真机 ok 且图真进群。
  // 11-12 那次「修 file:///」只改了斜杠数量、没真机验，图其实一直发不出去——这次按真机结果改 base64。
  let imgFile;
  try {
    imgFile = 'base64://' + imgCache.b64FromFile(abs);
  } catch (e) {
    console.log('[发图] 读图失败，改回 file:/// 兜底：' + abs + ' ' + e.message);
    imgFile = 'file:///' + String(abs).replace(/^\/+/, '');
  }
  const seg = [{ type: 'image', data: { file: imgFile } }];
  if (ev.message_type === 'private') sendAction('send_private_msg', { user_id: ev.user_id, message: seg });
  else sendAction('send_group_msg', Object.assign({ group_id: ev.group_id, message: seg }, allowOff ? { _allowOff: true } : {}));
  return true;
}

// ===== 纯情绪发言 → 单发对应情绪的表情包（主人 2026-10-23 凌晨定）=====
// 映射表在 data/情绪表情.json（面板可直接改：一栏情绪、一栏触发词，纯文字不用碰符号；
// 改坏了 JSON 校验会拦住，代码里也留了兜底，宁可认不出也不崩）。
// 「只发表情/情绪发言」= 划掉表情代码和 emoji 后只剩语气词：哈哈哈哈、救命、哭死、？？？这类。
// 【分类 H·全聊天】纯情绪→单发表情图 / 图片连发驳回：群私聊通用，相对公开发评论。
const EMO_FILE = path.join(__dirname, '..', 'data', '情绪表情.json');
let _emoMap = null, _emoAt = 0;
function emoMap() {
  if (_emoMap && Date.now() - _emoAt < 60000) return _emoMap;
  let list = null;
  try { list = JSON.parse(fs.readFileSync(EMO_FILE, 'utf8')); } catch {}
  if (!Array.isArray(list)) list = [];
  _emoMap = list.filter(x => x && x.cat && Array.isArray(x.words) && x.words.length);
  _emoAt = Date.now();
  return _emoMap;
}
const EMO_STRIP_RE = /\[[^\]]*\]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
const EMO_TEXT_RE = /^(哈+|嘿+|嘻+|好耶|6+|草|裂开|绷不住[了]?|蚌埠住[了]?|乐|寄|麻了|急死|哭死|泪目|破防[了]?|emo[了]?|救命[啊呀哦]?|晚安|早安|午安|哇+|哇塞|哦+|噢+|嗯+|啊+|咦+|哎+|唉+|太可爱[了]?|真可爱|好看|可爱|疑惑|问号|懵|害怕|吓死|气死|烦死|累|困|肝|？+|\?+|~+|。+)[哈嘿嘻哇啊哦噢嗯咦哎唉6～~！!。?？\s]*$/i;
function emotionOnly(text) {
  const s = String(text || '').replace(EMO_STRIP_RE, '').trim();
  if (!s) return true;                       // 纯表情/纯 emoji
  if (s.length > 8) return false;
  return EMO_TEXT_RE.test(s);
}
/* 2026-11-07 主人定：情绪判断改走「情绪书」（data/情绪书.json）。
 * 返回叶名（委屈/赌气/笑…），老 9 类词表只当兜底。 */
function emotionCategory(text) {
  const t = String(text || '');
  try {
    const d = require('../emotion-tree').detail(t);
    if (d && d.leaf) return d.leaf;
  } catch {}
  const low = t.toLowerCase();
  for (const e of emoMap()) {
    if (e.words.some(w => w && low.includes(String(w).toLowerCase()))) return e.cat;
  }
  return '';
}
// 情绪触发：情绪书命中某个叶 → 按这个叶的图族挑（族名带 q 和不带 q 都认，前缀也认）。
// 族名在库里一张都没有 → 退回老 9 类同名图 → 再没有就安静。
function pickEmotionSticker(text) {
  const files = stickerFiles();
  const base = f => f.replace(/\.[^.]+$/, '').split('/').pop();
  let fams = [];
  try {
    const r = require('../emotion-tree').judge(text);
    if (r.best) fams = (r.best.node.files || []).slice();
  } catch {}
  if (!fams.length) {
    const cat = emotionCategory(text);
    if (cat) fams = [cat, 'q' + cat];
  }
  if (!fams.length) return '';
  /* 按 files 的书写顺序当优先级（主人 2026-11-07：「优先级在进来的时候设置一下」）：
   * 第一个族在库里有图就用它，没有再看下一个。以前是所有族混在一起随机，
   * 于是「怒」会随机到只有 1 张的老图 生气，而不是 12 张的 q怒。 */
  for (const fam of fams) {
    if (!fam) continue;
    const cands = files.filter(f => { const b = base(f); return b === fam || b.startsWith(fam); });
    if (!cands.length) continue;
    const picked = pickFromCands(cands);
    return base(picked || cands[0]);
  }
  return '';
}

/* ===== 连续发图驳回（主人 2026-10-31 定）=====
 * 「纯情绪 → 单图」这条规则里还带一个限制：**不许连着两次都只发图**。
 *   例：1【泪目】→【表情:哭】；2【哈哈】→ 图驳回、也不回话。
 * 「连续」= 上一条是纯图、而且离得不远（90 秒内）；中间隔了一条文字、或隔久了，就不算连续。 */
const IMG_GAP_MS = 90 * 1000;
const _lastImgAt = boundedMap(3000);          // 会话（群 / 私聊对象）→ 上次「只发图」的时间
function markOut(key, isImgOnly) {
  if (isImgOnly) _lastImgAt.set(key, Date.now());
  else _lastImgAt.delete(key);
}
function imgBlocked(key) {
  const t = _lastImgAt.get(key) || 0;
  return !!t && Date.now() - t < IMG_GAP_MS;
}
// 这一轮的会话钥匙（群按群号，私聊按对象，不然所有私聊会被当成同一条会话）
function imgKeyOf(ev, isPrivate) {
  return isPrivate ? ('p' + String(ev.user_id || '')) : ('g' + String(ev.group_id || ''));
}

/* ===== 问候气氛维护（主人 2026-10-23 凌晨定）=====
 * 检测到「大家好/早上好/中午好/晚上好/晚安」等问候 → 都要回复；
 * 除晚安一类**结束语**外，回复要翻长期记忆+短期记忆，把一件具体的旧事带进问候里（callback）。
 * 词表在 data/问候语.json（面板可直接改，纯文字）；群级同类型问候 10 分钟只主动应一次防刷屏。 */
// 【分类 H·全聊天】问候：打招呼必回 / 晚安道别。主人裁「聊天形式专属但不是 QQ 专属回话路径」，
// 私聊不冷却、群 10 分钟冷却，群+私聊都命中 → 并入 H 全聊天场景（相对公开发评论）。
const GREET_FILE = path.join(__dirname, '..', 'data', '问候语.json');
let _greetCfg = null, _greetAt = 0;
function greetCfg() {
  const st = (() => { try { return fs.statSync(GREET_FILE).mtimeMs; } catch { return 0; } })();
  if (_greetCfg && st === _greetAt) return _greetCfg;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(GREET_FILE, 'utf8')); } catch {}
  _greetCfg = {
    greet: (j && Array.isArray(j.greet) ? j.greet : ['大家好', '早上好', '中午好', '下午好', '晚上好', '你好']).map(s => String(s).toLowerCase()).filter(Boolean),
    closing: (j && Array.isArray(j.closing) ? j.closing : ['晚安', '拜拜', '睡了']).map(s => String(s).toLowerCase()).filter(Boolean),
  };
  _greetAt = st;
  return _greetCfg;
}
function stripForGreet(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|［[^］]*］/g, '')      // [图片]、［图：…］
    .replace(/@[\w一-龥]{1,20}(（@?\d{4,12}）)?/g, '')  // @段
    .replace(/[\s，。！？、~～!！?？.·:：;；,]/g, '')
    .toLowerCase();
}
// 命中 → {kind:'greet'|'closing', word}；不命中 → null。
// 去掉标点/图/@ 后总长 ≤ 8 才算问候（问候+半句话可以，「你好，请问…」这种问题不算）；
// 结束语（晚安类）全文里出现就算（「我先睡了」）；打招呼类要打头（「今晚好看吗」不算）。
function greetingHit(text) {
  const s = stripForGreet(text);
  if (!s || s.length > 8) return null;
  const g = greetCfg();
  const close = g.closing.find(w => s.includes(w));
  if (close) return { kind: 'closing', word: close };
  const hit = g.greet.find(w => s.startsWith(w));
  if (hit) return { kind: 'greet', word: hit };
  return null;
}
// 同一会话同类型问候的主动应答冷却（默认 10 分钟，config.greeting.cooldownMs 可调；私聊不冷却）
const greetLast = boundedMap(3000, 6 * 60 * 60 * 1000);   // scopeKey:kind -> ts
// 面板改 config 立刻生效（v71，主人定「讲触发条件的数字必须现读 config」）：
// merge/grpAuto/chime/greeting 这几段也走 mtime 缓存现读（llmCfg/matchTrigger 早就这样），
// 面板里改完数值不用重启 bot。mtime 没变只 stat 一次，开销可忽略。
function cfgLive() { return core.readConfigFresh() || cfg || {}; }

function greetGate(scopeKey, kind, isPrivate, uid) {
  if (isPrivate) return true;
  const cd = Number((cfgLive().greeting || {}).cooldownMs);
  const wait = Number.isFinite(cd) ? cd : 10 * 60 * 1000;
  const key = scopeKey + ':' + kind + ':' + (kind === 'greet' ? '' : String(uid || ''));
  const last = greetLast.get(key) || 0;
  if (Date.now() - last < wait) return false;
  greetLast.set(key, Date.now());
  if (greetLast.size > 200) { const first = greetLast.keys().next().value; greetLast.delete(first); }
  return true;
}

// 「@123456 文字」→ OneBot 段（at + text）。没有 @ 时返回 null（发纯文本就行）
function buildAtSegments(text) {
  const s = String(text || '');
  if (!/@\d{5,12}/.test(s)) return null;
  const segs = [];
  const re = /@(\d{5,12})/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ type: 'text', data: { text: s.slice(last, m.index) } });
    segs.push({ type: 'at', data: { qq: m[1] } });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ type: 'text', data: { text: s.slice(last) } });
  return segs.length ? segs : null;
}

/* 裸表情标记纠错（主人 2026-11-18 令）：模型（尤其本地 9b）想发表情时，
 * 偶尔把 `[表情:q无语]` 写成 `[q无语]` —— 少了「表情:」，replyTo 就把它当正文发进群，
 * 于是一句「q无语」顶替了图片（真事 11-17 19:22）。
 * 做法：只认「库里存在**以这个名字开头**的图」的裸 token，才补成 `[表情:名字]`。
 * 不用 stickerHit 判——它是模糊匹配，连「图片」「一个不存在xyz」都能命中某张图，
 * 拿来判会把正文里的 [图片] 之类全吞掉。必须文件名前缀命中才算。 */
function fixBareStickerTag(text) {
  return String(text || '').replace(/\[([^\]\[\n]{1,20})\]/g, (m, name) => {
    const n = String(name || '').trim();
    if (!n || /[:：表情]/.test(n)) return m;              // 已是 [表情:x] / 含冒号 / 名字里带「表情」→ 不碰
    const files = stickerFiles();
    const low = n.toLowerCase().replace(/\s+/g, '');     // 模型偶尔写 [q 震惊]（带空格），去空格再比
    const hit = files.some(f => String(f).replace(/\.[^.]+$/, '').split('/').pop().toLowerCase().startsWith(low));
    if (!hit) return m;
    const clean = n.replace(/\s+/g, '');                 // 输出也去空格，stickerHit 才能按文件名命中
    console.log('[表情纠错] 裸标记 [' + n + '] → [表情:' + clean + ']');
    return '[表情:' + clean + ']';
  });
}

// ===== 引用谁：当前说话人 vs 原说话人（主人 2026-11-22 定）=====
// 群里「A 引用了 B 的话」时，她这一句到底是在回 A（当前说话人）还是在回 B（原说话人）——
// 以前只要有原说话人就强制引用 B（主人被顶掉），群友那边又完全没得选。现在统一走这里判定。
// QQ 的 reply 段引用哪条 id，群里就显示她在回复谁：引用 A 的这条 / 引用 B 的那条原消息。
const QUOTE_FRESH_MS = 5 * 60 * 1000;

/* 从模型输出里剥出「引用谁」标记：[引用:原] / [引用:当前] / [引用:无]（也认「原说话人/当前说话人」）。
 * 标记只是给系统的，发出去之前必须剥干净——群里看到 [引用:原] 这种字就穿帮了。
 * 返回 { hint: 'origin'|'current'|'none'|'', text }，只认第一个。 */
function takeQuoteHint(text) {
  const src = String(text == null ? '' : text);
  let hint = '';
  const out = src.replace(/\[\s*引用\s*[:：]\s*(原说话人|当前说话人|原|当前|无)\s*\]/g, (m, k) => {
    const h = (k === '原' || k === '原说话人') ? 'origin'
      : ((k === '当前' || k === '当前说话人') ? 'current' : 'none');
    if (!hint) hint = h;
    return '';
  });
  return { hint, text: out.replace(/^[ \t\u3000]+/gm, '').trim() };
}

/* 引用谁（纯函数、可测）：返回 { mode:'none'|'current'|'origin', id, name }。
 * 顺序：私聊不引用 → 模型标记 → 证据 → 默认。
 * 证据只有两种：这条消息除 @/引用外没有自己的正文（纯转发，只能是在答被引用那条）、
 * 或她的回复里 @ 了原说话人。其余默认引用**当前这条**（她在回发话的人）。
 * 原说话人那条超过 5 分钟 / 没有消息 id → 不拿它当引用目标（沿用旧的 5 分钟新鲜度）。 */
function pickQuoteTarget(o) {
  const x = o || {};
  const none = { mode: 'none', id: '', name: '' };
  if (x.isPrivate) return none;
  const now = Number(x.now) || Date.now();
  const spk = x.speaker || {};
  const org = x.origin || null;
  const curOk = !!spk.msgId;
  const orgOk = !!(org && !org.self && org.msgId
    && org.msgT && now - Number(org.msgT) < QUOTE_FRESH_MS);
  const cur = () => (curOk ? { mode: 'current', id: String(spk.msgId), name: String(spk.name || '') } : none);
  const origin = () => ({ mode: 'origin', id: String(org.msgId), name: String(org.name || '') });
  const hint = String(x.hint || '');
  if (hint === 'none') return none;
  if (hint === 'current') return cur();
  if (hint === 'origin') return orgOk ? origin() : cur();
  // 根本没有原说话人 → 保持老口径（不引用），普通对话不额外挂引用；
  // 有原说话人但那条过期/拿不到 id → 退「当前这条」（老行为：别把很久以前别人那句顶出来当回谁）
  if (!orgOk) return (org && !org.self) ? cur() : none;
  const ans = String(x.ans || '');
  // 发话人自己引用自己的话 → 两个目标其实是同一个人，@ 他不算「在回原说话人」
  const samePerson = !!org.uid && !!spk.uid && String(org.uid) === String(spk.uid);
  const atOrigin = !samePerson && !!org.uid && ans.indexOf('@' + String(org.uid)) >= 0;
  if (atOrigin || x.speakerHasBody === false) return origin();
  return cur();
}
/* replyTo 出口兜底：任何路径带进来的 [引用:…] 都在这里剥掉 */
function stripQuoteHintTags(text) { return takeQuoteHint(text).text; }

function replyTo(ev, text, opts) {
  const _lockGid = (ev && ev.message_type !== 'private') ? ev.group_id : '';
  // 群禁言硬闸（2026-11-05 她定）：这个群我正被禁言 → 一个字都不发，连尝试都不试。
  // 前面 onMessage / handleTurn 管的是「不调模型」，这里管的是「所有旁路也发不出去」：
  // 复读链、骰子、表情、定时问候这些不走主闸的路径，全从 replyTo 出去，一并拦住。
  if (_lockGid && botMuted(_lockGid)) {
    console.log('[禁言] 群里还在禁言（还剩 ' + muteLeftText(_lockGid) + '），这条不发：' + String(text || '').slice(0, 30));
    return { text: '', want: '', sent: false, stickerOk: false };
  }
  /* 会话关闭硬闸（2026-11-21 主人报「关闭功能没生效」）：关成「不看也不回」的群，
   * 复读链、骰子、表情、定时问候这些不走主闸的旁路也不许发（和禁言闸同一位置、同一口径）。
   * opts.allowOff 只给「群 xxx 已关闭」这条回执自己用，别的调用一律不带。 */
  const _offOk = !!(_lockGid && opts && opts.allowOff);
  if (_lockGid && !_offOk && convSettings.isOff('qq_' + _lockGid)) {
    console.log('[关闭] 群里已关（不看也不回），这条不发：' + String(text || '').slice(0, 30));
    return { text: '', want: '', sent: false, stickerOk: false };
  }
  const stickers = [];
  // 「引用谁」标记兜底（[引用:原]/[引用:当前]/[引用:无]）绝不能当正文发进群
  text = stripQuoteHintTags(text);
  // 主人 2026-11-18：先纠正「[q无语] 漏写表情:」这种裸标记，再按正常格式提取表情。
  text = fixBareStickerTag(text);
  const clean = String(text || '').replace(/\[表情[:：]\s*([^\]\n]{1,20})\]/g, (m, name) => {
    stickers.push(String(name).trim());
    return '';
  });
  // 主人 2026-10-22 定（v53 放宽）：像人一样**断续连发**算整个回答，不乱刷屏就行。
  // 想连发：段与段之间单独写一行「|||」→ 发送层拆成多条消息连着发（每条隔 ~800ms）；
  // 没写 ||| 就还是一条消息，段内换行保留格式（不按普通换行拆）。
  const parts = clean.split(/\s*\|\|\|\s*/).map(s => s.trim()).filter(Boolean).slice(0, 6);
  // 剥掉模型爱加的「整句包裹引号」——主人截图问过「你讲话带「」是什么问题」（2026-10-22）
  const stripQuote = seg => {
    const j = seg.split(/\n+/).map(x => x.trim()).filter(Boolean).join('\n');
    return (j.length > 2 && j.startsWith('「') && j.endsWith('」') && j.indexOf('」', 1) === j.length - 1)
      ? j.slice(1, -1).trim() : j;
  };
  // 每条能放多少字（2026-11-17 主人令：默认=平台上限，手填不能超）：
  // 上限从 platform-limits 的 qq.cap 读（现网初值 600）；会话 ⚙ 手填的 chars 只能往下收、不能往上超。
  // 不跟着抬的话，上限调到 1500 也会在这一步被裁回 600；现在上限表就是那道墙。
  const _capId = (ev && ev.message_type === 'private') ? ev.user_id : (ev && ev.group_id);
  const _qqCap = platLimits.capOf('qq') || 600;
  const capChars = platLimits.clampChars('qq', convSettings.charsOf('qq_' + String(_capId || ''))) || _qqCap;
  const bodies = parts.map(stripQuote).filter(Boolean).map(s => s.slice(0, capChars));
  // 表情包最多一张，紧跟在文字后面（单独一条消息，但那是图片，不算刷屏）。
  // 库里没这张 → 不再无声吞掉：记进面板「虚幻自查」页给主人看（主人 2026-10-22 定）
  const want = stickers.slice(0, 1)[0] || '';
  const haveSticker = want ? !!stickerHit(want) : false;
  if (want && !haveSticker) {
    const have = stickerFiles().map(f => f.replace(/\.[^.]+$/, '')).slice(0, 20).join('、');
    core.aiFeedback('表情没发出去', '在' + (ev.message_type === 'private' ? '私聊' : '群' + ev.group_id)
      + '想发表情「' + want + '」，库里没有这张，没发成。现在有的：' + (have || '（一张都没有）'));
    console.log('[表情] 没有这张（已记反馈）：' + want);
    // 反馈要有下文（主人 2026-10-22 定）：光记在面板里没人看——私聊告诉主人缺哪张、去哪补（10 分钟最多提醒一次）
    const now = Date.now();
    if (now - (stickerWishAt || 0) > 10 * 60 * 1000) {
      stickerWishAt = now;
      core.master('虚幻想发表情「' + want + '」但常用单里没有这张，没发成。'
        + '补法：把图放进 data/stickers/常用/，面板表情页点「↺ 重制」会自动配好描述；'
        + '也可以自己在「常用.md」里加一行「- 什么时候用：' + want + '」（描述在前，图名在后）。'
        + '（面板「虚幻自查」页有完整记录）');
    }
  }
  if (!bodies.length && !want) {
    core.aiFeedback('消息没发出去', '生成了一条空回复（剥完表情就没字了），没有发。原话：' + String(text || '').slice(0, 80));
    return { text: '', want, sent: false };
  }
  let delay = 0;
  // 引用 id 提前算：下面「图先发」和「纯图+引用」两处都要用它判重。
  // 主人 2026-11-18 补：只第一条文字带引用；纯图没有文字时，引用改由「空格消息」承载。
  const rid = (opts && opts.replyId) ? String(opts.replyId) : '';
  // 2026-10-31 主人第 7 条：回复以 [表情:名字] 开头（她想先甩图再说话）→ **图先发，文字跟在后面**。
  // 写法对照：整条只写 `[表情:担心]` = 只发图不写字；`[表情:担心] 安慰你，不哭不哭。有什么话和我说说呀` = 图 + 文字。
  const imgFirst = !!(want && haveSticker && /^\s*\[表情[:：]/.test(String(text || '')));
  // 纯图 + 要引用时，图片由下面「引用+空格」分支统一发（一次），这里不再抢发，否则一张图发两遍。
  const imgByQuote = !bodies.length && want && haveSticker && rid && ev.message_type !== 'private';
  if (imgFirst && !imgByQuote) { setTimeout(() => sendSticker(ev, want, _offOk), 0); delay = 600; }
  // 记「她这次说话的对象」（主人 2026-10-22 晚定）：群里她回复/@ 了谁——
  // 之后那个人（尤其主人）3 分钟内接话，算「和我对话」继续认主人（sheJustTalkedTo）
  if (ev.message_type !== 'private' && ev.user_id) noteHerTarget('g' + ev.group_id, ev.user_id);
  // 「引用回复」某人（主人 2026-10-23 定）：主人 @/引用了群友、她要回那个人时，
  // 消息带一个 reply 段 → 群里看得出这句是在回谁（原话真事：她对着主人答「你在测我呢」）。
  bodies.forEach((body, i) => {
    if (i > 0) delay += 800;
    setTimeout(() => {
      if (ev.message_type === 'private') sendAction('send_private_msg', { user_id: ev.user_id, message: body });
      else {
        // 可以 @ 人（主人 2026-10-22 撤了「禁 @」）：回复里写 @QQ号 → 转成 OneBot 真 at 段发出去。
        // 只有真 @ 能被人点名字跳转；写成文本的 @ 是假的（截图真事：她把 @183.156.231.90 这种当号发出去了）。
        const segs = buildAtSegments(body);
        if (rid && i === 0) {
          const base = segs || [{ type: 'text', data: { text: body } }];
          sendAction('send_group_msg', Object.assign({ group_id: ev.group_id, message: [{ type: 'reply', data: { id: rid } }].concat(base) }, _offOk ? { _allowOff: true } : {}));
        } else {
          sendAction('send_group_msg', Object.assign({ group_id: ev.group_id, message: segs || body }, _offOk ? { _allowOff: true } : {}));
        }
      }
    }, delay);
  });
  // 纯图 + 要引用（主人 2026-11-18 定）：QQ 里 reply 段必须挂在有内容的消息上，
  // 空内容发不出去 → 单独发一条「引用 + 一个空格」承载 reply，图片紧随其后。
  if (!bodies.length && want && haveSticker && rid && ev.message_type !== 'private') {
    setTimeout(() => sendAction('send_group_msg', Object.assign({
      group_id: ev.group_id,
      message: [{ type: 'reply', data: { id: rid } }, { type: 'text', data: { text: ' ' } }],
    }, _offOk ? { _allowOff: true } : {})), 0);
    setTimeout(() => sendSticker(ev, want, _offOk), 300);
  } else if (want && haveSticker && !imgFirst) {
    setTimeout(() => sendSticker(ev, want, _offOk), (bodies.length ? bodies.length * 800 : 0) + 300);
  }
  return { text: bodies.join('\n'), want, sent: !!bodies.length, stickerOk: want && haveSticker };
}
// ===== 断续发送（v78，主人 2026-10-23 定）=====
// 「遇到文内有【。】的，下一句很大概率变成断续发送」——对方发来的话里带句号（说明是成句的话），
// 她这一条回复就大概率按句拆成 2~3 条发（复用 ||| 机制，每条隔 800ms），像人打字一句一句冒出来。
// 只对成句的回复生效：太短、功能类回复（笑点解析/攻略/自检）、模型自己分了段的不动。
// 【分类 H·全聊天】拆句 splitOut：群私聊聊天输出层，按 cfg.split 拆长答。
function splitOut(ans, srcText) {
  const c = cfgLive().split || {};
  if (c.enabled === false) return ans;
  const s = String(ans || '');
  if (!s || s.includes('|||')) return s;
  if (!/。/.test(String(srcText || ''))) return s;
  if (/笑点解析|攻略|自检/.test(String(srcText || ''))) return s;
  const plain = s.replace(/\s/g, '');
  if (plain.length < Number(c.minChars || 14)) return s;
  if (Math.random() > Number(c.p == null ? 0.7 : c.p)) return s;
  const cut = s.split(/(?<=[。！？!?～~…])/).map(x => x.trim()).filter(Boolean);
  if (cut.length < 2) return s;
  const maxSeg = Math.max(2, Number(c.maxSeg || 3));
  const parts = [];
  for (const piece of cut) {
    const last = parts[parts.length - 1];
    const lastLen = last ? last.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length : 0;
    if (last && (lastLen < 4 || parts.length >= maxSeg)) parts[parts.length - 1] = last + piece;
    else parts.push(piece);
  }
  if (parts.length < 2) return s;
  console.log('[split] 对方文内有句号 → 这次断续发（' + parts.length + ' 条）');
  return parts.slice(0, maxSeg).join(' ||| ');
}

// 私聊发一条（诊断报告要用，比 replyTo 松一点：不裁 900 字）
function sendPrivate(uid, text) {
  if (!uid) return;
  const body = String(text || '').trim().slice(0, 1800);
  if (!body) return;
  sendAction('send_private_msg', { user_id: uid, message: body });
}

/* ===== 客户端发言（2026-11-23 主人令）=====
 * 她原话：「给我的虚幻客户端加可以直接发送全类型消息和QQ一样的功能」「我要的是走QQ，不是绕过」。
 *
 * 做法：把客户端输入**当成一条真的主人私聊消息**塞进 onMessage —— 合并窗口、主人必回复、
 * 学习/好感/约定/话题/落盘全部照旧走，回复也照旧由 replyTo 发到她的 QQ 私聊（不走旁路）。
 *
 * 媒体（图/视频/语音/文件）：
 *   · 先复制一份进 data/client-media/（客户端那条原文件删了，聊天记录里的缩略图还得能看）；
 *   · 图片 → imgs 带 localPath，交 describeImgs 读盘识图，正文出［图：…］；
 *   · 视频 → videos 带 path；
 *   · 语音 → asr 转写，正文出［语音：…］；
 *   · 文件 → file-digest 读内容（文本直读，其余交 DSH），正文出［文件：名｜内容：…］；
 *   · 每种都追加 ［媒体:<文件名>］ 标记，面板据此渲染缩略图 / 播放器。
 */
const CLIENT_MEDIA_DIR = path.join(__dirname, '..', 'data', 'client-media');
function saveClientMedia(abs, name) {
  try {
    fs.mkdirSync(CLIENT_MEDIA_DIR, { recursive: true });
    const ext = (path.extname(String(name || abs)) || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    const base = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-'
      + crypto.randomBytes(3).toString('hex') + ext;
    fs.copyFileSync(abs, path.join(CLIENT_MEDIA_DIR, base));
    return base;
  } catch (e) {
    console.log('[客户端] 存媒体副本失败：' + e.message);
    return '';
  }
}

async function injectClientMessage(o) {
  o = o || {};
  const uid = String(cfg.masterQQ || (Array.isArray(cfg.masters) && cfg.masters[0]) || '');
  if (!uid) return { ok: false, error: '配置里没有主人 QQ 号' };
  let masterName = '';
  try { masterName = core.personNameOf(uid, '') || ''; } catch {}
  let text = String(o.text || '').trim().slice(0, 4000);
  const atts = (Array.isArray(o.files) ? o.files : []).slice(0, 9);
  const imgs = [], videos = [], media = [], notes = [];
  for (const a of atts) {
    const p = String((a && a.path) || '');
    if (!p || !fs.existsSync(p)) { notes.push({ ok: false, name: String(a && a.name || ''), error: '文件不在' }); continue; }
    const name = String((a && a.name) || path.basename(p)).replace(/[[\]\n\r]/g, '').slice(0, 60);
    const kind = String((a && a.kind) || 'file');
    const saved = saveClientMedia(p, name);
    if (saved) media.push(saved);
    const mark = saved ? ' ［媒体:' + saved + '］' : '';
    if (kind === 'image') {
      const local = saved ? path.join(CLIENT_MEDIA_DIR, saved) : p;
      imgs.push({ localPath: local, file: name, url: '' });
      text += ' [图片]' + mark;
      notes.push({ ok: true, kind, name });
    } else if (kind === 'video') {
      const local = saved ? path.join(CLIENT_MEDIA_DIR, saved) : p;
      videos.push({ path: local, file: name, url: '' });
      text += ' [视频]' + mark;
      notes.push({ ok: true, kind, name });
    } else if (kind === 'audio') {
      let tr = { ok: false, error: '没转写' };
      try { tr = await require('../asr').transcribe(p); } catch (e) { tr = { ok: false, error: e.message }; }
      text += ' ［语音：' + (tr.ok ? tr.text : '（没听清）') + '］' + mark;
      notes.push({ ok: true, kind, name, asr: tr.ok ? tr.text : '', asrError: tr.ok ? '' : tr.error });
    } else {
      let kb = 0;
      try { kb = fs.statSync(p).size / 1024 / 1024; } catch {}
      let dg = { ok: false, error: '没读' };
      try { dg = await require('../file-digest').digest(p, name); } catch (e) { dg = { ok: false, error: e.message }; }
      text += ' ［文件：' + name + '（' + kb.toFixed(1) + 'MB）' + (dg.ok ? '｜内容：' + dg.text : '｜（没读出内容：' + dg.error + '）') + '］';
      notes.push({ ok: true, kind, name, digestVia: dg.via || '', digestError: dg.ok ? '' : dg.error });
    }
  }
  text = text.trim().slice(0, 12000);
  if (!text) return { ok: false, error: '没有内容' };
  const ev = {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: Number(selfId) || 0, user_id: Number(uid) || uid,
    time: Math.floor(Date.now() / 1000), message_id: -Date.now(),
    message_format: 'array',
    message: [{ type: 'text', data: { text: text } }],
    raw_message: text,
    sender: { user_id: Number(uid) || uid, nickname: masterName, card: '' },
    _client: true, _clientImgs: imgs, _clientVideos: videos,
  };
  // 不 await 整轮：这一轮里要调模型，几十秒回不来；面板靠轮询看回复。
  setImmediate(() => { onMessage(ev).catch(e => console.log('[客户端] 这一轮出错：' + (e && e.message || e))); });
  return { ok: true, media, notes, sent: text.slice(0, 200) };
}

// 聊天记录只记 QQ 里实际出现的（主人 2026-10-22 定）：文字照记；表情发成了补一行「[表情包:x]」，
// 没发出去的（库里没这张 / 空回复）**不进聊天记录**，只进面板「虚幻自查」页（replyTo 里记）
// 上一条「真正发出去」的消息是不是兜底回复，按会话 scope 记。
// 主人 2026-11-13 令：上一条发出的消息是兜底回复时，下一条兜底就不发了。
// 连续失败只发第一条；期间那条兜底没发出，「上一条发出的」仍是它，所以一直不再刷，
// 直到有任何一条正常回复/命令回执/表情图经 logSent 发出才把标记清掉。
const lastFallbackByScope = boundedMap(3000);   // scope -> boolean

function logSent(scope, r, to, isFallback) {
  if (!r) return;
  let out = r.text || '';
  if (r.want && r.stickerOk) out = (out ? out + '\n' : '') + '[表情包:' + r.want + ']';
  // 触发人（v78 硬限制）：这条回复是回谁的，落盘里写死，面板不再按时间顺序猜
  if (out) {
    markActive();
    core.logLine('qq', '', out, true, scope, { to: to || '' });
    lastFallbackByScope.set(String(scope || ''), !!isFallback);   // 只有真发出去的才算「上一条」
  }
}

/* 群里发的「管理指令」回执往哪发（2026-11-21 主人令：「这个只需要私信说，不要在群里发二次」）：
 * 群开关（关群 / 开群）是管理动作，主人在群里说一次就够了，回执一律走私聊给发指令的主人；
 * 其它指令（上下文条数、字数、模型…）照旧回在群里，免得主人不知道自己那条生效了。
 * 注意：群开关回执走私聊后就不再经过群发送闸，所以 out.allowOff 在这条路上用不上（保留给别的调用）。 */
function replyGroupCommand(ev, out, scope0) {
  const said = String((out && out.reply) || '已处理。');
  if (out && (out.action === 'group_off' || out.action === 'group_on')) {
    sendPrivate(ev.user_id, said);
    core.logLine('qq', '', said, true, '私聊', { to: nameOf(ev) });   // 私聊里也留一条，面板能看到回了什么
    return;
  }
  logSent(scope0, replyTo(ev, said, { allowOff: !!(out && out.allowOff) }), nameOf(ev));
}

// 认一个人的显示名（记录触发人用）：人物表 → 群名片 → 昵称
// 2026-11-21 主人令：**只读人物表**（people.json，和面板同一份）。
// 原来第一优先读 cfg.people，那份配置早已没人写（永远是 {}），名字直接掉回 QQ 昵称；
// 昵称被系统改成「那就是死了已被移出群聊」这类时她就跟着叫错，而面板按人物表显示是对的
// —— 主人实测「虚幻认错人、面板没记错」就是这个根因。人物表查不到才退回群名片/昵称。
function nameOf(ev) {
  const uid = String((ev && ev.user_id) || '');
  const fb = String((ev && ev.sender && (ev.sender.card || ev.sender.nickname)) || '');
  try { const n = core.personNameOf(uid, fb); if (n) return n; } catch {}
  return fb || (ev && ev.message_type === 'private' ? '有人' : '群友');
}

// 主人 @/引用了谁（不是她）→ 返回那个人的显示名；没对准人返回 ''。
// 记录聊天记录、给她「回谁」都要用（v78：主人 @ 别人时，她回的是被 @ 的那个人，不是主人）
function aimTargetFrom(text, replyOrigin, gid) {
  // 返回 {name, uid, msgId}：名字给提示词用，QQ 号/消息 id 用来「引用回复」那一条
  if (replyOrigin && !replyOrigin.self) {
    // msgT 用被引用那条的真实时间（2026-11-13 修引用错人）：写 Date.now() 会让 5 分钟新鲜度检查永远通过。
    return { name: String(replyOrigin.nick || '').slice(0, 20), uid: String(replyOrigin.uid || ''),
      msgId: String(replyOrigin.msgId || ''), msgT: Number(replyOrigin.msgT || 0) || Date.now() };
  }
  const q = (String(text || '').match(/@(\d{5,12})/g) || [])
    .map(x => x.slice(1)).find(x => String(x) !== String(selfId || ''));
  if (q) {
    const p = (cfgLive().people || {});
    const hit = instantLog('g' + gid, 60).filter(x => String(x.uid) === String(q)).slice(-1)[0];
    const last = lastMsgByUid.get('g' + gid + ':' + String(q));
    return { name: p[q] || (hit ? hit.nick : ('QQ' + q)), uid: String(q), msgId: last ? String(last.id || '') : '', msgT: last ? Number(last.t || 0) : 0 };
  }
  const typed = (String(text || '').match(/@[^\s\d@，。！？~～!！?？.、…:：;；,''"“”()（）]{1,30}/g) || [])[0];
  if (typed) {
    const nm = typed.slice(1);
    const last = findLastMsgByNick(gid, nm);   // 手打 @昵称 → 靠昵称找到那人最新一条（引用回复要用）
    return { name: nm, uid: '', msgId: last ? String(last.id || '') : '', msgT: last ? Number(last.t || 0) : 0 };
  }
  return { name: '', uid: '', msgId: '', msgT: 0 };
}

// ===== @ 时机（主人 2026-10-22 傍晚定）=====
// 回复耗时决定要不要 @ 对方：确定 5 秒内能回的**直接回不 @**；
// 超过 8 秒的**必须 @**（让人知道这句是回谁的）；5~8 秒的随机决定。
// 连续回同一个人的只有第一条 @（中间回过别人、或隔了 10 分钟以上，才算新的一条）。
const atReplyState = { uid: '', gid: '', t: 0, at: false };
function groupAtNeed(elapsed, rnd) {           // 纯决策（可测）：耗时毫秒 → 要不要 @
  if (elapsed > 8000) return true;
  if (elapsed >= 5000) return (rnd == null ? Math.random() : rnd) < 0.5;
  return false;
}

// ===== 发言类回复的公共规则层（主人 2026-10-23 定：这是一层，不是五处零散功能）=====
// 等待说完再答（handleTurn 入口的 merge）/ 超时必@ / 复读限制 / 联系上下文 / 记忆 callback——
// 五条规则统一喂给**所有发言类回复**：被 @、自主接话、问候、凑热闹、回应主人、固定话术……
// 哪条路径都不能绕过；以后加新回复路径，也走这两个函数，别再各写一份。
function applyAtTiming(ans, ev, turnStart, opts) {   // 超时必@：5 秒内不 @ / 8 秒必 @ / 5~8 秒随机；连着回同一个人只第一条
  if (ev.message_type === 'private' || !ev.user_id) return ans;
  const o = opts || {};
  if (o.noAt || o.mustReply) {                      // 「回应主人」顶上来的回复 @ 都不用（主人 2026-10-23 定）
    // 连她自己写出来的 @ 也剥掉（她 @ 到别人 —— 比如主人 @ 的那个人 —— 不算，原样留着）
    const cut = String(ans).replace(new RegExp('^@' + String(ev.user_id) + '[\\s\\u3000]*', 'gm'), '');
    if (cut !== String(ans)) console.log('[at] 必回的回复不需要 @：把 @主人 去掉了');
    return cut;
  }
  const aUid = String(ev.user_id), aGid = String(ev.group_id);
  // 主人 2026-11-23 报：模型写了 @主人(100000000)，超时必@ 却在前面又叠一个 @当前说话人(Nana)，
  // 接着 atNameConvert 把 @主人当「@别人」抹成空格 → 群里只剩 @Nana「好的主人」= 认错人。
  // 修：模型已经写了**任意** @号（5~12 位 QQ），就当她自己指定了 @ 对象，不再叠加；
  // 状态仍按「是否 @ 了当前说话人」记，连回同一个人的去重口径不变。
  const atSpeaker = ans.indexOf('@' + aUid) >= 0;
  const atAnyone = /@\d{5,12}/.test(ans);
  let needAt = !atAnyone && groupAtNeed(Date.now() - (turnStart || Date.now()));
  const now2 = Date.now();
  if (needAt && atReplyState.at && atReplyState.uid === aUid && atReplyState.gid === aGid
    && now2 - atReplyState.t < 600000) needAt = false;      // 连着回同一个人，@ 过一次就够了
  if (needAt) ans = '@' + aUid + ' ' + ans;
  atReplyState.uid = aUid; atReplyState.gid = aGid; atReplyState.t = now2;
  atReplyState.at = needAt || atSpeaker;
  return ans;
}
// 聊天记录里的「引用/转述」痕迹，绝不许出现在她发出去的话里。
// 真事 2026-10-23：群里有人引用了一条「那就是死了已被移出群聊　　」的消息，
// 历史里是「↩回复@xxx：原话↩」，她把这截原样搬进了回复——群里看着像在 @ 一个被踢的人。
function stripEchoJunk(s) {
  return String(s || '')
    .replace(/↩[^↩\n]{0,120}↩/g, '')                                  // 引用格式整段剥掉
    .replace(/@[^\s@\n]{0,30}(?:已被?移出群聊|已退出群聊|已解散)[\s\u3000]*/g, '')  // 退群/被踢的群名片
    .replace(/[\u3000]{2,}/g, ' ')                                     // 全角空格串
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ===== 「没做成的事不许说成做成了」闸（v91，主人 2026-10-23 报的真事）=====
// 私聊原文：「去加群100000000」→ 她回「已成功加入群100000000，主人～」，实测根本没进群。
// 查过：NapCat 的群相关接口一共 56 个，**没有「按群号搜索并加群」这个动作**；
// 她只能「被别人邀请进群 / 被别人拉进去」时自动同意（见 onRequest）。主动加群这件事本身不存在。
// 也就是说那句「已成功」是她自己编的——代码里没有任何返回值能让她以为成功了，这是谎报，不是能力问题。
// 这条闸不改她的性格，只拦「没发生的事被说成发生了」：主人会当真，然后在群里等她说话。
let selfJoinAt = 0;                            // 她真的被邀请/拉进群的时刻（connect 里的 group_increase 写）
// 只认「已经/成功 + 进群」和「加好了」这两种完成宣言，以及「我+加/进/入+群」这种自述；
// 不认「我在群里」——她本来就在这个群里说话，那是真话（吃过一次误伤）。
const JOIN_DONE = /(?:已经|已|刚刚|刚才|刚|成功|终于)\s*(?:成功)?\s*(?:加入|进入|进了|加入了|入群|进群)/;
const JOIN_ADDED = /(?:加|进)好(?:了|啦)|(?:加|进)上了/;
const JOIN_SELF = /(?:我|咱|俺|虚幻)[^，。！？!?\n]{0,8}(?:加|进|入)(?:了|到|进)?(?:这个|那个)?\s*群/;
// 这些是「做不到 / 让别人做 / 被邀请」的说法，不是她的完成宣言，不能拦
const JOIN_NOT_CLAIM = /(?:加不了|进不去|进不了|没法加|没法进|不能加|不会加|怎么加|能加吗|可以加吗|要不要加|邀请我|拉我|让[我你他她]|请你|被我|帮你|给我)/;
const JOIN_HONEST = '加群这事我自己做不了呀——得你邀请我，或者直接把我拉进去，我马上就同意～';
function fakeJoinSeg(seg) {
  if (JOIN_NOT_CLAIM.test(seg)) return false;
  return JOIN_DONE.test(seg) || JOIN_ADDED.test(seg) || JOIN_SELF.test(seg);
}
function noFakeJoin(s) {
  const t = String(s || '');
  if (!t || t.indexOf('群') < 0) return t;                         // 连「群」都没提，直接放过
  if (Date.now() - selfJoinAt < 30 * 60 * 1000) return t;          // 半小时内真进过群，那她说「我进来了」是真的
  let hit = false;
  const out = t.split(/(?<=[。！？!?\n])/).map(seg => {
    if (!fakeJoinSeg(seg)) return seg;
    hit = true;
    return JOIN_HONEST;
  }).join('');
  return hit ? out : t;
}

// ===== 「没删却说删了」闸（v92，主人 2026-11-23 报的真事）=====
// 群里没人叫她删，她自己编了句「好的主人，已经删除了～」，还 @ 错人（见 applyAtTiming 注释）。
// 真删除/撤回走 nl-command.handle（上面 4887-4900），命中就 return，**根本不进模型回调**；
// 所以能走到模型回调出口、又冒出「已经删除/撤回」完成宣言的 — 一律是幻觉，拦下不发、不留日志。
// 只认完成宣言（已经/刚刚/已 + 删/撤/清 + 了），放过否定、疑问、教学、转述。
const DEL_DONE = /(?:已经|已|刚刚|刚才|成功|终于)\s*(?:成功)?\s*(?:(?:把|帮|替|给)[^，。！？\n]{0,20})?\s*(?:删除|删掉|删了|删去|撤掉|撤回|清掉|清除|移除)\s*(?:了|啦|掉|好)?/;
// 否定/疑问/教学靠 DEL_DONE 的「已经/已/刚刚」完成态前缀把关：没前缀就自然不命中，
// 所以这里不再列「帮你删/你想删」这类词——否则「已经帮你删掉了」会被误放过。
const DEL_NOT_CLAIM = /(?:删不了|撤不了|没法删|不能删|不会删|没删|别删|要不要删|删了吗|删了没|能删|可以删|怎么删|如何删|教你删|谁删|被删|删除线|已读)/;
function claimsDeleted(s) {
  const t = String(s || '');
  if (!t || DEL_NOT_CLAIM.test(t)) return false;
  if (!DEL_DONE.test(t)) return false;
  // 第三人称转述（他/她/它/某人 + 删）放过：那是描述别人做的事，不是她宣称自己删了
  if (/(?:他|她|它|对方|某人|有人|群友|管理员)\s*(?:把[^，。！？\n]{0,16})?\s*(?:已经|已|刚刚|刚才)?\s*(?:删|撤|清)/.test(t)) return false;
  return true;
}

// 对方在问 QQ 号吗（主人 2026-10-23 修）：
// 以前一律「回复里不许出现 QQ 号」，群友问「qq号是什么」，她只能答「主人的QQ号就是主人和主人」。
// 现在：没人问就不主动报，**问了就照实答**——报不报号交给这一轮的提示词，不靠硬拦。
const ASK_QQ_RE = /(?:qq|扣扣|抠抠|丘丘|企鹅号)/i;
function asksQQ(t) {
  const s = String(t || '');
  if (!ASK_QQ_RE.test(s)) return false;                       // 连「QQ」都没提，不算
  return /(号|多少|几|是什么|什么|加上?|告诉|发给?)/.test(s) || /[?？]/.test(s);
}

function atNameConvert(ans, ev) {              // @ 当名字：@ 别人转成文本名字；@ 对方/自己保留真 @
  const c = cfgLive();
  const people = c.people || {};
  let out = String(ans).replace(/@(\d{5,12})/g, (m, qq) => {
    const q = String(qq);
    // 「回复里不 @ 正在说话的人 / 不 @ 主人 / 不 @ 自己」这三条已经在 2026-10-23 整体撤销
    // （主人原话：「你这条完全理解错了，整条产出的内容都不要」）——该 @ 谁就 @ 谁，不再拦。
    // 原设计只有两条：正在跟你说话的人、你自己 → 保留真 @（发送层转成 OneBot 的 at 段，能点开跳转）；
    // 其余人 → 换成文本名字，只在话里提到，不 ping 人家。
    if (q === String(ev.user_id || '') || q === String(selfId)) return '@' + q;
    const nm = people[q];
    return nm ? '@' + nm : ' ';
  });
  // 裸的 QQ 号**不再替换**（主人 2026-10-23 修，这是一处过度限制）：
  // 旧代码 `out.split(号).join('主人')` 把「主人的QQ号是 100000000 和 100000000」
  // 改成了「主人的QQ号就是主人和主人」——群友问号她答不出来，根子就在这一行。
  // 现在号原样保留；「没人问就别主动报」由提示词把关（人设优先，不做硬改）。
  return noFakeJoin(stripEchoJunk(out));
}
// 固定话术类回复的统一出口（wish / remember / approve / 触发词第一句）：
// 也走公共发送层——超时必@、@ 当名字、回声清理、进历史、留日志，一样不少。
// 区别只有一条：固定句是主人自己定的台词，不是她现编的，复读拦截不适用（拦了会把主人的台词拦掉）。
function sendFixedReply(ev, k, scope, msg, turnStart, opts) {
  let ans = stripEchoFormat(String(msg || ''));
  if (!ans) return null;
  ans = atNameConvert(applyAtTiming(ans, ev, turnStart, opts), ev);
  const r = replyTo(ev, ans);
  if (r.text) core.pushHist(k, 'assistant', r.text);
  logSent(scope, r, nameOf(ev));
  core.bumpExtract(k);
  return r;
}
// 公共规则之一「联系上下文 + 记忆 callback」的提示词原文（所有发言类回复共用，主人 2026-10-23 定）
const COMMON_REPLY_RULES = '回复前先看上面的对话和记忆，把话接在上文上。\n如果长期记忆或最近聊天里有和对方（或这个群）相关的旧事，就直接带进回复，不加解释。\n旧事必须是记忆里真有的，不许编。\n如果挑不出，就顺着对方刚说的话接。\n不许照抄最近 10 条以内别人的话。'
  // 主人 2026-10-23 定：不许用括号写动作/内心/占位。改了之后我才能判断她到底在说什么。
  + '你发出去的每一个字都是打在聊天框里的话。\n不许写「（尾巴）」「（歪头）」「（笑）」「（沉默）」这类括号动作、内心戏、表情标签。\n不许用「（看不懂）」「（嗯）」「（不知道）」这种括号占位当一句回答。'
  + '如果看不懂对方发的东西（链接、图、陌生词），就直接问一句具体的（「图上那只猫是谁呀」「这个链接是干嘛的」）。\n说不出图上什么才老实说「这个我看不太懂」。\n不许拿记忆里的作品硬套。';

// ===== 答不出来的时候怎么说话（主人 2026-10-22 定）=====
// 主人：「连不上的时候，只在私聊里直接告诉我所有可能的原因。
//        其他群只说（我现在有点忙，让我的主人替我回答吧）并且同步私聊我」
// 于是分三种收件人：
//   ① 主人/欧尼酱私聊问的 → 全部原因直接回在这儿
//   ② 群里 / 别人私聊   → 只说一句「忙」，同一个会话 60 秒最多一次
//   ③ 任何非私聊场景    → 顺手把完整报告私聊同步给主人（全局 2 分钟一条，别刷屏）
const offlineAt = boundedMap(3000);     // 会话 -> 上次说「忙」的时间
let offlineSyncAt = 0;           // 上次私聊同步给主人的时间
let offlinePending = 0;          // 节流期间又卡了几次

// 【分类 B·测试专属】答不出来/报错时私聊同步给主人（全场景测试总集合汇报类）：非回话应对，是汇报。
function offlineNotice(ev, info) {
  const c = cfg || {};
  const o = c.offline || {};
  const isPrivate = ev.message_type === 'private';
  const uid = String(ev.user_id);
  const isBoss = isMasterUid(uid) || (!!c.oniiQQ && uid === String(c.oniiQQ));
  const now = Date.now();
  const acts = [];                      // 只为了自测能验证「发给谁」（正常跑的时候没人看它）

  // 她自己凑热闹失败 → 闭嘴。没人等她回答，这时候说「我很忙」就是刷屏。
  if (info.turn && info.turn.chime) return acts;

  // ① 主人私聊：全部原因
  if (isPrivate && isBoss) { logSent('私聊答不出', replyTo(ev, info.report)); acts.push('私聊直答'); return acts; }

  // ② 群里 / 别人私聊：只说一句忙
  const key = isPrivate ? ('p' + uid) : ('g' + ev.group_id);
  const scope = isPrivate ? '私聊答不出' : ('群' + ev.group_id);
  if (lastFallbackByScope.get(scope)) {
    // 主人 2026-11-13 令：上一条发出的是兜底回复 → 这条兜底不发。
    // 不更新 offlineAt、也不落盘，「上一条发出的」仍是那条兜底，连续失败就一直不再刷。
    acts.push('说忙（上一条也是兜底，跳过）');
  } else if (now - (offlineAt.get(key) || 0) >= (o.lineCooldownMs || 60000)) {
    offlineAt.set(key, now);
    // 兜底词池（2026-11-13 主人令）：按群 / 私聊 / 某人 / 平台挑一条；
    // 池里一条都没有时仍退回 core 给的默认句，绝不会因此发空。
    let line = info.line;
    try {
      const picked = core.offlinePoolPick({
        group: isPrivate ? '' : ev.group_id, private: isPrivate, uid, plat: ev.platform || 'qq',
      });
      if (picked) line = picked;
    } catch {}
    logSent(scope, replyTo(ev, line), '', true);
    acts.push('说忙');
    // 兜底词池自动补齐（2026-11-13 主人令）：只有这句真的发出去才补；不 await、不挡回复。
    // 连续兜底抑制 / 节流跳过的那两支都不在这里，所以不会误触发。
    try { core.fbAutoFill({ group: isPrivate ? '' : ev.group_id, private: isPrivate, uid, plat: ev.platform || 'qq' }).catch(() => {}); } catch {}
  } else acts.push('说忙（节流中）');

  // ③ 同步私聊给主人
  if (o.syncToMaster === false || !c.masterQQ) return acts;
  if (now - offlineSyncAt < (o.syncCooldownMs || 120000)) { offlinePending++; acts.push('同步（节流中）'); return acts; }
  const extra = offlinePending
    ? '\n\n（刚才这段里还卡了 ' + offlinePending + ' 次，没一条条发你）'
    : '';
  offlineSyncAt = now;
  offlinePending = 0;
  sendPrivate(c.masterQQ, info.report + extra);
  acts.push('同步给主人');
  return acts;
}

/* 消息节点 → 段数组的唯一入口（2026-11-24）。
 * NapCat/OneBot 各版本、同一版本的不同接口，段数组可能叫 message（get_msg / get_forward_msg 的节点）
 * 也可能叫 content（老版 / 部分转发），纯文字节点可能只有 text。以前每个调用处各猜一遍字段，
 * get_forward_msg 的节点就只猜了 content 漏了 message → 正文全空，虚幻回「这个聊天记录是空的」。
 * 字段兼容只在这里做一次；任何要读消息内容的地方都用 parseSegments / segsOf，别再自己写 ||。 */
function arrayField(o, keys) {
  if (!o || typeof o !== 'object') return [];
  for (const k of keys) if (Array.isArray(o[k])) return o[k];
  return [];
}
function segsOf(ev) {
  const segs = arrayField(ev, ['message', 'content']);
  if (segs.length) return segs;
  if (!ev || typeof ev !== 'object') return [];
  const t = typeof ev.text === 'string' ? ev.text : (typeof ev.content === 'string' ? ev.content : '');
  return t ? [{ type: 'text', data: { text: t } }] : [];
}

function parseSegments(ev) {
  const segs = segsOf(ev);
  let text = '', atMe = false, replyId = '';
  const imgs = [], atOthers = [], forwards = [], videos = [];   // forwards：合并转发 id，主人私聊里当指令证据用
  // videos：视频段（主人 2026-11-22）。字段名各家实现不一（path/url/file/file_id 都有），全收着交给 video.js 挑
  for (const s of segs) {
    if (s.type === 'text') text += s.data.text;
    else if (s.type === 'at') {
      if (String(s.data.qq) === String(selfId)) atMe = true;
      else if (s.data.qq !== 'all') { text += `@${s.data.qq} `; atOthers.push(String(s.data.qq)); }
    }     else if (s.type === 'reply') { if (s.data && s.data.id) replyId = String(s.data.id); }
    else if (s.type === 'forward') { if (s.data && s.data.id) forwards.push(String(s.data.id)); }
    else if (s.type === 'face') text += '[表情]';
    else if (s.type === 'image') { text += '[图片]'; if (s.data && (s.data.url || s.data.file)) imgs.push({ url: s.data.url || s.data.file, file: s.data.file }); }
    else if (s.type === 'record') text += '[语音]';
    else if (s.type === 'video') {
      text += '[视频]';
      const vd = (s.data || {});
      videos.push({ url: vd.url || vd.file_url || '', file: vd.file || '', path: vd.path || '', file_id: vd.file_id || '' });
    }
    /* 文件消息（2026-11-23）：客户端发文件时把名字带出来，别让「发了文件」变成空气。
     * QQ 里的文件是独立消息（群文件/传文件），这里只认段里的 name/file。 */
    else if (s.type === 'file') {
      const fd = (s.data || {});
      const fname = String(fd.name || fd.file || '文件').replace(/[[\]\n\r]/g, '').slice(0, 60);
      text += '[文件:' + fname + ']';
    }
  }
  return { text: normalizeIncoming(text), atMe, imgs, videos, replyId, atOthers, forwards };
}

/* 自动搬屎/搬史转发（2026-11-22）：AstrBot 的 astrbot_plugin_banshi_auto / astrbot_sowing_discord
 * 跟 xuhbot 共用同一个 QQ 号，它们发的"合并转发"会以普通群消息事件送到这边，
 * user_id 就是她自己。这不是群友说话，也不是她打的字——只进普通上下文给她看"这是我自己发的"，
 * 不进回话路径。 */
function isSelfSowingForward(ev, forwards) {
  return !!ev && ev.post_type === 'message' && ev.message_type === 'group'
    && String(ev.user_id || '') === String(selfId || '')
    && Array.isArray(forwards) && forwards.length > 0;
}

/* 合并转发（聊天记录）取原文：主人私聊说「这句证明他叫X / 标错」时要看得见内容。
 * 段字段的兼容全在 segsOf 一处，这里不再猜字段。图也走正常消息那套 describeImgs
 * （图库→视觉），描述按 ［图：…］ 拼在节点正文后面，原图不塞回主消息（主人 2026-11-24 令）。
 * 识别不出 / 接口异常不静默：自查里留错误，不等 AI 自己说「空的」。 */
const forwardErrSeen = new Map();
function reportForwardErr(reason, detail) {
  const key = String(reason || '').slice(0, 40);
  const now = Date.now();
  if (now - (forwardErrSeen.get(key) || 0) < 5 * 60 * 1000) return;   // 同一原因 5 分钟内只报一次
  forwardErrSeen.set(key, now);
  if (forwardErrSeen.size > 100) forwardErrSeen.clear();
  const msg = reason + '｜' + String(detail || '').slice(0, 160);
  console.error('[转发] ' + msg);
  try { core.aiFeedback('转发记录读不出来', msg); } catch {}
}

async function fetchForwardEvidence(ids) {
  const lines = [];
  let imgBudget = 12;   // 一条消息最多识 12 张转发图，防止一串长聊天记录把视觉额度烧光
  let budgetReported = false;
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 5)) {
    try {
      const r = await callApi('get_forward_msg', { message_id: id }, 3000);
      if (!r || (r.retcode !== undefined && r.retcode !== 0)) {
        reportForwardErr('取转发接口失败', 'id=' + id + ' retcode=' + (r && r.retcode) + ' ' + (r && (r.message || r.wording || '')));
        continue;
      }
      const d = r && r.data ? r.data : {};
      const msgs = arrayField(d, ['messages', 'message']);
      if (!msgs.length) { reportForwardErr('转发接口没返回节点', 'id=' + id); continue; }
      let gotSomething = false;
      for (const m of msgs) {
        const s = m && m.sender ? m.sender : {};
        const seg = parseSegments(m);
        let body = String(seg.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const nodeImgs = (seg.imgs || []).slice(0, 3);
        if (nodeImgs.length) {
          if (imgBudget <= 0) {
            if (!budgetReported) { reportForwardErr('转发图太多，只识别前 12 张', 'id=' + id); budgetReported = true; }
          } else {
            const take = nodeImgs.slice(0, imgBudget);
            imgBudget -= take.length;
            let descs = [];
            try { descs = ((await describeImgs(take)).descs) || []; }
            catch (e) { reportForwardErr('转发图识别异常', 'id=' + id + ' ' + e.message); }
            const seen = descs.map(x => String(x || '').replace(/\s+/g, ' ').trim());
            // 跟正常消息同一套：把正文里的 [图片] 占位逐个换成 ［图：描述］，不并列留两份
            let di = 0;
            body = body.replace(/\[图片\]/g, () => {
              const d = seen[di++];
              return d ? '［图：' + d + '］' : '[图片]';
            });
            const rest = seen.slice(di).filter(Boolean);
            if (rest.length) body += (body ? ' ' : '') + rest.map(x => '［图：' + x + '］').join(' ');
            if (seen.some(Boolean)) gotSomething = true;
            else reportForwardErr('转发里的图认不出来', 'id=' + id + ' 图' + take.length + '张');
          }
        }
        if (body) gotSomething = true;
        lines.push(String(s.nickname || s.card || s.user_id || '?') + '(' + String(s.user_id || '?') + '): ' + body);
      }
      if (!gotSomething) reportForwardErr('转发节点全空', 'id=' + id + ' 节点' + msgs.length + '条');
    } catch (e) { reportForwardErr('取转发记录异常', e.message); }
  }
  return lines.slice(0, 60).join('\n');
}

/* 入消息规范化：解析完各段后统一清洗——去残留 CQ 码、折叠连续空白、收掉换行前后空白、
 * 合并连续空行。不改 atMe/atOthers/imgs 这些已解析出的结构。 */
function normalizeIncoming(t) {
  if (!t) return '';
  return String(t)
    .replace(/\[CQ:[^\]]*\]/g, '')          // 兜底去任何仍残留的 CQ 码
    .replace(/[ \t]+/g, ' ')                // 连续空格/tab 折叠
    .replace(/[ \t]*\n[ \t]*/g, '\n')       // 换行前后空白收掉
    .replace(/\n{2,}/g, '\n')               // 连续空行并成一个
    .trim();
}

/* ===== 视频段留档（主人 2026-11-22）=====
 * 聊天记录里最终只剩一段「［视频：…］」文案，可「笑点解析」要重新按全量翻一遍（全部字幕 + 全部帧），
 * 那时手里必须还有原始段（path/url/file_id）。所以收到视频时按 message_id 存一份，只留最近 60 条。 */
const _vidRefs = new Map();    // message_id -> { seg, chat, at, text }
function keepVideoRef(ev, text, seg) {
  if (!seg) return;
  const key = String((ev && ev.message_id) || '') || ('t' + Date.now() + Math.random());
  _vidRefs.set(key, {
    seg,
    chat: (ev && ev.message_type === 'private') ? 'p' + ev.user_id : 'g' + (ev && ev.group_id),
    at: Date.now(),
    text: String(text || ''),
  });
  if (_vidRefs.size > 60) _vidRefs.delete(_vidRefs.keys().next().value);
}
function recentVideoRef(chat, withinMs) {
  const now = Date.now();
  let found = null;
  for (const v of _vidRefs.values()) {
    if (v.chat === chat && now - v.at < (withinMs || 600000)) found = v;   // 越后越新
  }
  return found;
}

// ===== 图片翻译：下载 + 图库认图 + 视觉模型识别，返回 { descs, lib } =====
// 主人 2026-10-22：聊天记录、话题、给模型的上下文里都要有「图上是什么」，不能是干秃秃的[图片]。
// 主人 2026-11-05 定顺序：先看图库里的哪一张，再「有字看字，无字看情绪」；命中图库就不再调视觉模型。
// descs 与传入 imgs 按顺序对应（识别不了的给 ''）；lib 是对齐的图库相对路径（没命中 ''）。
const TABLE_VISION_MODEL = '';   // 图上有表格/数字时换它重读：当前未配置任何视觉模型（xuhbot 不配模型），故关闭
async function describeImgs(imgs) {
  const descs = [];
  const lib = [];
  if (!imgs || !imgs.length) return { descs, lib };
  const uris = [];
  const slots = [];        // uris[i] 的描述填到 descs 的哪个坑
  const longImgs = [];     // 长图单独拎出来：要切块逐块抄字，不能和普通图挤一次请求（主人 2026-11-18）
  const backfill = [];     // 图库命中但库里没 d 的：这次识完把 d 补回去（主人 2026-11-19）
  for (const im of imgs.slice(0, 3)) {
    lib.push('');          // 先占位：命中图库时改这一个，保证 lib 和 descs 严格对齐
    /* 本地文件（2026-11-23 客户端发送）：im.localPath 是客户端传上来的图，
     * 不走 QQ 图床、没有 http url，直接读盘。其余一切照旧（图库认图 / 视觉模型 / 长图切块）。 */
    const localPath = String((im && im.localPath) || '');
    let url = localPath ? '' : String((im && (im.url || im.file)) || '');
    if (!localPath && !/^https?:\/\//i.test(url) && im && im.file) {
      try {
        const r = await callApi('get_image', { file: im.file }, 3000);
        if (r && r.data && /^https?:\/\//i.test(String(r.data.url || ''))) url = r.data.url;
      } catch {}
    }
    if (!localPath && !/^https?:\/\//i.test(url)) { descs.push(''); continue; }
    try {
      let got;
      if (localPath) {
        const ext = String(path.extname(localPath) || '').toLowerCase();
        const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : '';
        got = { buf: fs.readFileSync(localPath), type: mime };
      } else try { got = await core.getBinary(url); }
      catch (e) {
        // QQ 图床 url 内的 fileid 带 rkey，过一阵就失效（400 invalid rkey）。
        // 拿 NapCat 给的 file 重新 get_image 换一个带新鲜 rkey 的 url，再下一次（2026-11-16）。
        let fresh = '';
        if (im && im.file) {
          try {
            const r = await callApi('get_image', { file: im.file }, 3000);
            if (r && r.data && /^https?:\/\//i.test(String(r.data.url || ''))) fresh = String(r.data.url);
          } catch {}
        }
        if (fresh && fresh !== url) {
          console.log('[img] url 失效（' + e.message.slice(0, 60) + '），换新 url 重试');
          got = await core.getBinary(fresh);
        } else throw e;
      }
      // 2026-11-16 主人定：大于 8MB 的图也下载、也识图，不再跳过。原来这里
      // `> 8MB 跳过` 会让大图 descs 填空串 → 提示词里只剩 [图片] → 虚幻说「图糊了看不清」。
      // 图库认图/视觉模型照常走；大图走视觉模型可能因体积上限报错，那种按正常失败填空，不阻断其它图。
      // 图库先认（2026-11-05 主人定）：先看她自己库里有没有这张，认出来就不用再看视觉模型。
      // 动图也在这儿认（PIL 直接读第一帧），认出来就不用再截帧。
      try {
        const h = await stickerPHash(got.buf, 'd16');
        // 复读链用同一套规则：文字身份＝归一化文本，图身份＝像素指纹（QQ 转存 md5 每次都变，指纹才是同一张图）。
        // 挂回 im 供 onMessage 算统一的 echoKey；buf 是原图（gif 原 buf 发出来仍是动图）。
        try { im.ih = h || ''; im.buf = got.buf; im.mime = String(got.type || '').split(';')[0].toLowerCase(); } catch {}
        const hit = h ? stickerLibHit(h) : '';
        if (hit) {
          // 判图那段字按 md5 存在 .md5.json 的 d 里（主人 2026-11-19 定）：文件名只有 9 字上限，
          // 她一改名图名就换了，描述必须挂在 md5 上才不会丢。
          const _md5 = crypto.createHash('md5').update(got.buf).digest('hex');
          let libDesc = '';
          try {
            const rec = stickerMd5Load()[_md5];
            libDesc = String((rec && rec.d) || '').replace(/\s+/g, ' ').trim().slice(0, 600);
          } catch {}
          // 例外：这次发的是同一张图但明显更清楚（大 15% 以上）→ 交给收图链路去替换库里的旧版
          // （2026-10-30 定的「同图取清晰度高的」不能因为「认出图库就跳过收图」被弄丢）
          let bigger = false;
          try { bigger = got.buf.length > fs.statSync(path.join(STICKER_DIR, hit)).size * 1.15; } catch {}
          lib[lib.length - 1] = bigger ? '' : hit;
          if (libDesc) {
            descs.push('图库里的「' + stickerLibLabel(hit) + '」（图上：' + libDesc + '）');
            console.log('[img] 图库里认出来了：' + hit + (bigger ? '（这次更清楚，交给收图替换旧版）' : ''));
            continue;
          }
          // 库里没 d（老图，或刚收还没识过）→ 不跳过，往下走一次视觉模型，识完回填 d。
          // 没有 d 时只剩一个图名，「这是什么」等于没内容可答（主人 2026-11-19）。
          // 不 continue：下面的 uris/slots/descs 会照常占位，slot 就是此刻的 descs.length。
          backfill.push({ md5: _md5, rel: hit, slot: descs.length });
          console.log('[img] 图库认出来了但没判图描述：' + hit + ' → 让视觉模型识一次，补回 d');
        }
      } catch {}
      const mime = (got.type || 'image/png').split(';')[0].toLowerCase();
      if (mime.indexOf('gif') >= 0) {
        const png = await core.gifToPng(got.buf);      // 动图先截一帧
        if (png) { uris.push(imgCache.dataUriFromB64(png, 'image/png')); slots.push(descs.length); descs.push(''); console.log('[img] 动图截了一帧'); }
        else descs.push('');
        continue;
      }
      if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) { descs.push(''); continue; }
      // 长图（高 > 2000px）单独走切块抄字：视觉模型一次抄不完（glm-4v-flash 上限 1024 token），
      // 整图还会被接口降采样到看不清字。普通图仍走下面那一批，一次发多张（主人 2026-11-18）。
      const sz = core.imageSize(got.buf);
      if (sz && sz.h > 2000) {
        longImgs.push({ slot: descs.length, buf: got.buf, mime });
        descs.push('');
        console.log('[img] 长图 ' + sz.w + 'x' + sz.h + ' → 切块抄字');
        continue;
      }
      uris.push(imgCache.dataUriFromBuffer(got.buf, mime));
      slots.push(descs.length);
      descs.push('');
    } catch (e) { console.log('[img] 下载失败：' + e.message); descs.push(''); }
  }
  // 识图按类型读全（2026-11-19 主人给的判类型规则）：图有字有图案，只翻字不够，
  // 图案 / 软件界面 / 发言人头像 / 多人对话 / 复读都要判出来，主 AI 才有完整信息、才不会瞎编。
  // 判定顺序照她的 5 步走；保留三段「字：/情绪：/是什么：」结构供下游抄字(pickTextPart)/选项图(optN)用。
  // 保留 2026-11-02 的成果：文字逐行抄、数字不许改（种族值表格当年就是靠这条抄准的）。
  const TEXT_ASK = '按下面规则看图，把该有的都写清楚，不加评价、不写与规则无关的画面细节：\n'
    + '字：把图上所有文字照原样逐行抄出来（表情包的大字、角落小字、水印都算）；表格一行一行抄，数字不改、不省、不自己编；图上一个字都没有就写「无字」\n'
    + '情绪：先写这张图本身的情绪，从这些词里选一个最接近的：哭 / 委屈 / 怒 / 震惊 / 无语 / 疑惑 / 累 / 喜欢 / 得意 / 害怕 / 笑 / 难过。再写发图人可能的情绪——可能和图相同，也可能完全相反（例：委屈的图，发图人可能是在嘲笑它）\n'
    + '是什么：按图类型分层写全——\n'
    + '  ① 先看是不是软件界面（聊天截图 / 游戏界面 / 网页 / App 都算）。不是 → 一句话说清这是什么（不超过 15 字）；图里若还有别的画面、节目里的内容，也要描述出来。\n'
    + '  ② 是软件界面 → 看界面里有没有人说话。没人说话 → 分段记录内容，重复的标出「重复」，不必每段全量照抄。有人说话 → 写出发言人名字和头像样子（头像里本身有图也要描述）；再看是不是多人对话。\n'
    + '  ③ 多人对话 → 人名去重后全部列出，每个人说的话分段写；看有没有人复读（重复别人刚说过的话），复读的标出「复读」。只有一个人说话 → 分段输出即可。';
  const flat = s => String(s).replace(/\s*\n+\s*/g, ' / ').replace(/[ \t]{2,}/g, ' ').trim();   // 换行留成 / ，表格一行一行还能分得开
  // 普通图：一次请求发 1~4 张（2026-11-18 去掉了原来 `.slice(0, 600)` 的硬截——
  // 主人定：图上的字要全输出，宁可压缩提示词也不许压缩字）
  if (uris.length) {
    try {
      const q = uris.length > 1
        ? '下面按顺序有 ' + uris.length + ' 张图。每张单独一段，开头写「图1：」「图2：」，每张都按下面的规则写全：\n' + TEXT_ASK
        : TEXT_ASK;
      // 第 4 个参数 true = 抄字优先：先把「不思考、肯逐行抄」的视觉模型排前面
      // （思考型 glm-4.1v 会把一半预算花在思路里，还自己「简化呈现」，长图上的字就会少）
      let vision = await core.seeImage(uris, q, '', true);
      if (vision) {
        // 数字特别密（≥6 个）→ 基本就是数值表/攻略表，小模型容易漏行。换会思考的视觉模型再读一遍，两次取其全。
        // 实测（2026-11-02，拿一张 7 行种族值表）：glm-4v-flash 抄对了 7 行、0.9 秒；glm-4.1v-thinking-flash 6 秒，
        // 多抄到一个标题。所以不是张张都升级，只在「表格题」上升级——表情包/截图不陪它等 6 秒。
        const cntNum = s => (String(s).match(/\d+/g) || []).length;
        if (TABLE_VISION_MODEL && uris.length === 1 && cntNum(vision) >= 6) {
          try {
            const better = await core.seeImage(uris, q, TABLE_VISION_MODEL);
            if (better && cntNum(better) >= cntNum(vision) && String(better).length > String(vision).length) {
              console.log('[img] 数字密（' + cntNum(vision) + ' 个），已改用 ' + TABLE_VISION_MODEL + ' 重读');
              vision = better;
            }
          } catch (e) { console.log('[img] 重读失败：' + e.message); }
        }
        console.log('[img] 看到了：' + String(vision).slice(0, 100));
        if (uris.length === 1) {
          descs[slots[0]] = flat(vision);
        } else {
          // 多图：按「图N：」切段，每段的所有行都归它（新格式一段三行，按行拆会只剩第一行）
          const byN = {};
          const seg = String(vision).split(/图\s*([1-9])\s*[：:．.]?\s*/);
          for (let i = 1; i < seg.length; i += 2) {
            const n = Number(seg[i]);
            const body = String(seg[i + 1] || '').trim();
            if (n && body) byN[n] = body;
          }
          if (Object.keys(byN).length) {
            slots.forEach((slot, i) => { if (byN[i + 1]) descs[slot] = flat(byN[i + 1]); });
          } else {
            descs[slots[0]] = flat(vision);
          }
        }
      }
    } catch (e) { console.log('[img] 识别失败：' + e.message); }
  }
  // 长图：逐张切块抄字，抄到的字全量进描述（不截断）
  for (const L of longImgs) {
    try {
      const d = await core.seeImageLong(L.buf, L.mime, TEXT_ASK);
      if (d) {
        descs[L.slot] = flat(d);
        console.log('[img] 长图描述 ' + String(d).length + ' 字');
      }
    } catch (e) { console.log('[img] 长图识别失败：' + e.message.slice(0, 80)); }
  }
  // 图库命中但库里没 d 的：这次视觉模型看清了，把 d 补回去（主人 2026-11-19：见没有 d 就回填）。
  // 只写 d，不动 f（改名照旧由 stickerReconcile 管），不改任何收图/去重逻辑。
  if (backfill.length) {
    try {
      const store = stickerMd5Load();
      let changed = false;
      for (const b of backfill) {
        const d = String(descs[b.slot] || '').trim();
        if (!d) continue;
        const old = store[b.md5];
        const rel = (typeof old === 'string' ? old : ((old && old.f) || '')) || b.rel;
        store[b.md5] = { f: rel, h: (old && old.h) || '', d: d.slice(0, 600) };
        changed = true;
        console.log('[img] 图库「' + rel + '」补上判图描述（' + d.length + ' 字）');
      }
      if (changed) stickerMd5Save(store);
    } catch (e) { console.log('[img] 补描述失败：' + e.message.slice(0, 80)); }
  }
  return { descs, lib };
}

// 把文本里的［图：描述］占位符摘出来（onMessage 翻译时写进去的），同时还原成 [图片]
function takeImgDescs(text) {
  const descs = [];
  const t = String(text || '').replace(/［图：([^］]*)］/g, (m, d) => { descs.push(d); return '[图片]'; });
  return { text: t, descs };
}

// 图里是不是「1、2、3… 并排的几个选项」（2026-11-03 主人定）。
// 她不接受「问模型这张图想让人干什么」——那个边界太糊，模型一律答成「展示内容给人评价」，
// 然后回一句「哇！这烤五花看起来好香啊！」，一看就是 AI 在夸。
// 改成只认**客观形态**：描述里带不带从 1 开始的连续编号。带了就是在问你选哪个。
//   识图新写的「1=生；2=三分熟…」→ 直接命中；老图抄下来的「1 2 3 / 4 5 6 / 7 8 9」→ 也命中。
// 返回最大编号（0 = 不是选项图）。只吃 1~9，从 1 开始连续才算，免得日期、价格、n网编号被误判。
function optionGraphMax(descs) {
  const s = String((descs || []).join(' '));
  if (!s) return 0;
  const hasN = n => new RegExp('(^|[^0-9])' + n + '([^0-9]|$)').test(s);
  let max = 0;
  for (let n = 1; n <= 9; n++) { if (!hasN(n)) break; max = n; }
  return max >= 3 ? max : 0;
}

// 学说话之前把图片/表情占位符剥掉——图上的内容不是主人打的字（主人 2026-10-22：学习的只有我说的）
function stripForLearn(text) {
  return String(text || '')
    .replace(/［图：[^］]*］/g, '')
    .replace(/\[图片[：:][^\]]*\]/g, '')
    .replace(/\[(图片|表情|语音)\]/g, '')
    .trim();
}

// ===== 机器人群友：欢迎机器人、群管机器人——他们说的话不是真人说的 =====
// 截图真事（2026-10-22 早）：WuuaBot 在群里发「欢迎 入群！请遵守群规，玩得开心~ 关闭欢迎」，
// 虚幻回了一句「WuuaBot说: 欢迎入群！请遵守群规，玩得开心~ 关闭欢迎」——连前缀一起原样照抄，
// 因为她把机器人群友的消息当成真人的话接了过来。现在：认出就不是人的，只记录、不接话、不进历史。
const BOT_NICK_RE = /(bot|Bot|BOT|机器人|助手|群管|管理员|管理)$/;
// 机器人群管的欢迎通知特征：🎉欢迎@xxx 加入！/ 请遵守群规 / 关闭欢迎（按钮话）/ 加入了该群
// 注意不能写太泛（「进群欢迎」会误伤真人@她说的「欢迎新人~ > 管理/开关进群欢迎」）
const BOT_MSG_RE = /(?:🎉|🚀|👏|🎊|✨)?\s*欢迎\s*@?[^，。！!~\n]{0,24}\s*(?:加入|进群|入群)[！!]?\s*$|请遵守群规|关闭欢迎|加入了?该群/;
function isBotUser(ev) {
  const list = ((cfg || {}).botQQ || []).map(String);
  if (list.indexOf(String(ev.user_id || '')) >= 0) return true;
  const nick = String((ev.sender && (ev.sender.card || ev.sender.nickname)) || '').trim();
  return BOT_NICK_RE.test(nick);
}
function looksBotMessage(text) {
  return BOT_MSG_RE.test(String(text || ''));
}

// ===== 她知道自己被欢迎（截图真事：别人 @她 说「欢迎新人」，她回「欢迎欢迎～」把欢迎还了回去）=====
// 【分类 A·群专属】欢迎新人 WELCOME_RE/isNewbie：group_increase 事件 + 群号维度，仅群内。
const WELCOME_RE = /(欢迎|迎新|新人|新成员|入群|进群|报到|来到|加入)/;
const NEWBIE_MS = 10 * 60 * 1000;      // 进群后十分钟内，她知道自己刚来、是被欢迎的那个
const newbieAt = new Map();            // gid -> 进群时间（内存）
const NEWBIE_PATH = path.join(__dirname, '..', 'data', 'bot-newbie.json');
function loadNewbie() { try { return JSON.parse(fs.readFileSync(NEWBIE_PATH, 'utf8')) || {}; } catch { return {}; } }
function markNewbie(gid) {
  newbieAt.set(String(gid), Date.now());
  try {
    const all = loadNewbie(); all[String(gid)] = Date.now();
    fs.writeFileSync(NEWBIE_PATH, JSON.stringify(all), 'utf8');
  } catch {}
}
function isNewbie(gid) {
  const t = newbieAt.get(String(gid)) || loadNewbie()[String(gid)] || 0;
  return !!t && Date.now() - t < NEWBIE_MS;
}

// 这一轮对方既没 @ 她、也没引用她 → 她不许说「你@我 / 你艾特我 / 你引用我」
// （真事 2026-10-23：主人对群友说了句「为啥」，她答「你突然@我，还问我为啥」——主人根本没@她）
function stripFalseAt(ans) {
  let out = String(ans || '')
    .replace(/(你|您)(突然|刚才)?\s*@我/g, '')
    .replace(/艾特我/g, '')
    .replace(/你引用我/g, '')
    .replace(/你@了我/g, '');
  out = out.replace(/[，,。、]{2,}/g, '，').replace(/^\s*[，,、]+\s*/, '').trim();
  return out;
}

// ===== 「群友之间的对话链」（主人 2026-10-23 定）=====
// 真事：主人 @ 了别家 AI「小肥鱼」说「测你的」，她却回主人「欸？你在测我什么呢？」——
// 把自己当成了被测的那个；后来主人对别人说「为啥」，她又答「你突然@我」——主人根本没@她。
// 根因：她不知道「主人这句话是在跟谁说话」。这里记两件事：
//   lastMsgByUid：群里每个人最后一条消息（要引用回复某人时用得到那条 id）；
//   masterTalk：主人此刻在跟谁说话（谁 @ 了主人 / 主人 @ 了谁 / 主人引用了谁）。
const lastMsgByUid = new Map();   // 'g'+群号+':'+QQ号 → {id, nick, text, t}
/* 撤回要能按 message_id 找回原话（主人 2026-11-06 定）：
 * 聊天记录是纯文本流水，不存 message_id；撤回事件只给一个 id，所以收到消息时先在内存里留一份。
 * 只留最近 500 条 / 30 分钟，够覆盖撤回的时间窗，也不吃内存。 */
const recentByMsgId = new Map();  // message_id → {text, g, uid, t}
const RECENT_MSG_MAX = 500;
function rememberMsgId(ev, text) {
  const id = String(ev.message_id || '');
  if (!id) return;
  const sd = ev.sender || {};
  recentByMsgId.set(id, {
    text: String(text || '').slice(0, 300),
    g: String(ev.group_id || ''),
    uid: String(ev.user_id || ''),
    nick: String(sd.card || sd.nickname || '').slice(0, 24),
    t: Date.now(),
  });
  if (recentByMsgId.size > RECENT_MSG_MAX) {
    const cut = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of recentByMsgId) if (v.t < cut) recentByMsgId.delete(k);
    while (recentByMsgId.size > RECENT_MSG_MAX) recentByMsgId.delete(recentByMsgId.keys().next().value);
  }
}
function handleRecall(ev) {
  const mid = String(ev.message_id || '');
  const rec = recentByMsgId.get(mid) || null;
  const text = rec ? rec.text : '';
  const g = String(ev.group_id || (rec && rec.g) || '');
  /* 2026-11-21 主人：「撤回类的标错也都是我人工撤回的，视为标错」「这是你当时就把功能写错了，改成能用的」。
   * 以前只拼一段文字，发言人（rec.uid 明明记了）和正文都被丢掉 → 89 条里 65 条「(没记下正文)」、
   * 一条都看不出是谁说的，当负例会把群友的话当成「她答错」。
   * 现在：发言人两个来源都取（收消息时留的 uid 优先，其次 group_recall 自带的 user_id），
   * 并判是不是她自己发的那条 —— 只有她说的被撤回才算「她说错了」，别人的话只能算「别学这个说法」。 */
  const sayer = String((rec && rec.uid) || ev.user_id || '');
  const sayerNick = String((rec && rec.nick) || (ev.sender && (ev.sender.card || ev.sender.nickname)) || '');
  const me = String(selfId || ev.self_id || '');
  /* 「是不是她说的」只敢用收消息时留的那份（rec.uid）来判：
   * friend_recall 事件里的 user_id 是对方，拿它判会把自己的撤回记成「别人说的」。 */
  const sureSelf = !!rec;
  const isSelf = sureSelf && !!(sayer && me && sayer === me);
  core.markRecalled(mid, text);
  const n = core.forgetStyle({ mid, text });
  const whoTxt = sayer
    ? ('；' + (isSelf ? '她说的话' : (sayerNick || ('QQ ' + sayer)) + ' 说的'))
    : '；不知道是谁说的';
  const extra = {
    emo: core.emotionOf(text),
    note: isSelf ? '这句是她说错被撤回的，别再说成这样' : '这条是别人的话被撤回，不是她说的，只当别学这个说法',
    sayer, sayerNick, sayText: text, gid: g, mid: mid,
    by: String(ev.operator_id || ''),
  };
  if (sureSelf) extra.self = isSelf;      // 判不了就不写这个字段（不猜）
  core.addIssue('待修复',
    '有消息被撤回：' + (text ? '「' + text.slice(0, 60) + '」' : '(正文没记下)')
      + whoTxt + '；已从风格样本移除 ' + n + ' 条' + (g ? '；群 ' + g : '') + (mid ? '；消息号 ' + mid : ''),
    extra);
  console.log('[撤回] ' + mid + '：' + (isSelf ? '她说的' : (sayer ? (sayerNick || sayer) + ' 说的' : '不知谁说'))
    + '，风格样本清掉 ' + n + ' 条，已记一条待修复问题');
  recentByMsgId.delete(mid);
}
const masterTalk = new Map();     // 群号 → {uid, nick, t, why}
const MASTER_TALK_TTL = 90 * 1000;       // 这段对话链 90 秒内有效（只认主人自己@了/引用了某人）
function rememberLastMsg(gid, uid, id, nick, text) {
  if (!gid || !uid || !id) return;
  lastMsgByUid.set('g' + gid + ':' + String(uid), { id: String(id), nick: nick || '', text: String(text || '').slice(0, 80), t: Date.now() });
}
function findLastMsgByNick(gid, name) {
  const want = String(name || '').trim();
  if (!want) return null;
  for (const [k, v] of lastMsgByUid) {
    if (!k.startsWith('g' + gid + ':')) continue;
    if (v.nick && (v.nick === want || v.nick.indexOf(want) >= 0)) return v;
  }
  return null;
}
function noteMasterTalk(gid, uid, nick, why) {
  // 保留函数但不再用于推断「回谁」：主人 2026-10-23 定的规矩是
  // 「主人@后回复」——**这一条**里主人@了/引用了谁，就回谁；下一条不接着猜。
  if (!gid || !uid || String(uid) === String(selfId)) return;
  masterTalk.set(String(gid), { uid: String(uid), nick: nick || '', t: Date.now(), why: why || '' });
}
// 主人此刻在跟谁说话——**一次性**：取一次就用掉（主人 2026-10-23 改：不能一直拿旧链去改「回谁」）
function masterTalkTarget(gid) {
  const mt = masterTalk.get(String(gid));
  if (!mt) return null;
  masterTalk.delete(String(gid));            // 用一次就清掉
  if (Date.now() - mt.t > MASTER_TALK_TTL) return null;
  return mt;
}

// ===== 主人 @/引用别人 → 回那个人（主人 2026-10-23 定）=====
// 回应主人、回复率独立；但主人 @/引用别人时，那不是「主人叫她」，是主人拉她进对话——
// 回复要对准被 @/被引用的那个人。这个函数把「对准谁」拼成提示词的一句（masterAim）。
// roq=引用的原文（replyOrigin）；atQ=真@到的QQ号；tAt=手打的@昵称；nickOf=atQ 在群里最近用的昵称
// 【分类 A·群专属｜本体归 H】必回对准语 masterAimLine/masterChainLine：
// 必回本体＝H 全聊天场景（主人铁律：任何群/私聊都必回），此处只对主人@别人/对话链的分岔做对准，仅群内。
function masterAimLine(opts) {
  const roq = opts.roq, atQ = opts.atQ, tAt = opts.tAt;
  const people = opts.people || {}, nickOf = opts.nickOf || '';
  let aim = '';
  if (roq) {
    let qf = String(roq.full || roq.frag || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (roq.blindImg) qf = qf.replace(/\[图片\]/g, '（不可见图）');
    aim = '主人回复（引用）了「' + (roq.nick || '别人') + '」的消息：「' + qf + '」。';
  } else if (atQ) {
    aim = '主人 @ 了「' + (people[String(atQ)] || nickOf || '这个人') + '」（QQ ' + atQ + '）。';
  } else if (tAt) {
    aim = '主人手打 @ 了「' + tAt + '」。';
  } else {
    aim = '主人在和群里别人说话。';
  }
  const who2 = atQ ? (people[String(atQ)] || nickOf || ('QQ' + atQ)) : (tAt || '那个人');
  return aim + '这句是主人说给「' + who2 + '」的，**不是对你说的**（主人只是把你拉进这段对话）。'
    + '你要回应的是「' + who2 + '」说的话和这段对话，**别对着主人答**，也别把「' + who2 + '」当成你自己。'
    + (atQ ? '回复里可以写 @' + atQ + '（会转成真@）直接对准「' + who2 + '」说话；' : '')
    + '系统会自动帮你引用「' + who2 + '」刚才那条消息，顺着那个话题说就行。'
    + '别复述主人的 @，别把这句当成主人在问你。';
}

// 「群友之间的对话链」：主人这一句是在跟群友说话，不是在跟她说（主人 2026-10-23 定）
function masterChainLine(t) {
  return '主人刚才在跟「' + (t.name || '群友') + '」说话（' + (t.why || '他在跟群友聊') + '），'
    + '这一句是对「' + (t.name || '群友') + '」说的，**不是对你说的**。'
    + '你要接的是「' + (t.name || '群友') + '」那边的话，别当成主人在问你，'
    + '系统会自动引用「' + (t.name || '群友') + '」刚才那条消息，顺着说就行。';
}


/* ===== 复读链跟风（主人 2026-10-22 定）=====
 * 群里出现复读链（同一句话被连着发，不算她自己发的）→ 她也原样跟一条；
 * 每条链最多跟一次，跟过就不许再跟（无循环）；她自己发起的复读不算链。
 * 长文复制粘贴也是梗玩法，但并非所有长文都值得跟——超长（默认 >60 字）按一半概率自己掂量。 */
const chainJoined = new Map();   // gid#ident -> 上次跟这条链的时间
/* 复读「身份」：图＝像素指纹（QQ 转存 md5 每次都变，只有 d16 指纹认得出是同一张图），
 * 文字＝归一化文本。图和文字**共用同一条复读链、同一套判定**，只是一个身份字段的来源不同——
 * 不是写两套规则。新发展条目存 ih，老条目没有 ih 就退回文本身份，行为不变。 */
function echoIdent(text, ih) {
  return ih ? ('img:' + String(ih)) : normEchoText(String(text || ''));
}
// 【分类 H·全聊天】复读链跟风 chainJoinAllowed：主人裁「复读/玩梗保持一致」＝全平台聊天。
// 主人 2026-11-23 追加：图片/gif 也复读一次（原 3045「图没法原样复读」的挡行已去掉）。
function chainJoinAllowed(gid, text, ih) {
  const t = String(text || '').trim();
  const n = echoIdent(t, ih);
  if (!n || n.length < 3 || n.length > 400) return false;             // 太短像嗯嗯啊啊，太长发不完整
  if (/^\.|\//.test(t)) return false;                                 // 指令式（.r、/命令）不跟
  if (/@\d{5,12}/.test(t)) return false;                              // 带 @ 的复读会真的 @ 到人，不跟
  // 群键必须和 noteTalk 写入时一致（'g'+群号）：2026-10-23 真事——这里原来取裸群号，
  // 永远是空数组，复读链从上线起一次都没跟过（截图里 9 人复读她没动）；单测喂的也是裸键，
  // 两边错在一处所以一直「通过」。现在真实群键优先，裸键保留兼容老调用/单测。
  const gkey = String(gid);
  const gk = /^[gp]/.test(gkey) ? gkey : 'g' + gkey;
  const log = groupLog.get(gk) || groupLog.get(gkey) || [];
  const now = Date.now();
  // 主人 2026-10-22 傍晚定（推翻中午的方案）：**不复读 AI**——只有**人类**连着发的复读，
  // 她分析后原样跟一条；别家 AI（乙，config.peerAI）发起/跟的链不算数，她自己也排除（无循环）
  const peerAI = (cfgLive().peerAI) || (cfg && cfg.peerAI) || [];
  const occ = log.filter(x => String(x.uid) !== String(selfId)
    && !x.bot && !peerAI.includes(String(x.uid))
    && echoIdent(x.text, x.ih) === n && now - x.t < 5 * 60 * 1000);
  if (occ.length < 2) return false;                                   // 得真的被复读过（≥2 条）
  if (now - occ[occ.length - 1].t > 150 * 1000) return false;         // 链还热着（最近一条 150 秒内）
  if (now - (chainJoined.get(gk + '#' + n) || 0) < 30 * 60 * 1000) return false;   // 这条链跟过一次了
  if (log.some(x => x.bot && echoIdent(x.text, x.ih) === n && now - x.t < 30 * 60 * 1000)) return false;   // 她自己刚说过 → 她发起的不跟
  if (n.length > 60 && Math.random() > 0.5) return false;             // 长文自主选择：一半概率跟
  return true;
}

// ===== 刷屏：单条连续重复 / 一个字一条 =====
// 主人 2026-10-22 定：
//   ①「禁止刷屏」只针对**单条**——一条回复不许拆成好几条；
//   ② 别人把**同一条内容**连发十几遍，机器人只回第一条，后续只记录不回（否则机器人跟着刷屏）；
//   ③ 别人一个字一条地发，是**一句话被拆开**，拼起来算一条（collectFrag）；
//   ④ 别人**明显是两个话题**的，各自都要回，一条都不许漏（core.chat 排队）。
const FRAG_MAXLEN = 2;
// 「没答案」的固定话术：自主路径（群里没人叫她）答出这种整句 → 宁可不说（主人 2026-10-22）
const EMPTY_ANS = /^(这个我记不清|我记不清|这个我不清楚|我不太清楚|不太清楚|我不确定|没查到|这个没查到|我说不好|网上说法不一样|我不记得了)[。！~～!？?\s]*$/;

/* ===== 回声格式清理（v2，主人 2026-10-22 重做）=====
 * v1 的问题：按「内容和历史一样就拦」做，但合理复读（全群复读、玩梗）也该允许，
 * 而且「把别人的话改一点点重说」根本比对不出来——限制没意义，废了。
 * v2 只治**格式**：历史行是「某某说: 原话」，模型偶尔照抄格式，发出来「主人说: xxx」。
 * 现在发送前把每行开头的「某某说：」转述前缀剥掉，剩下的正常发（纯复读/玩梗照常允许）；
 * 剥完全空（整条就只有前缀）才不发，且不留任何日志（没发出去的消息不记）。 */
const SAY_PREFIX = /^【?\[?[^\]】\n]{0,20}[\]】]?\s*(?:说|表示|问道?|回复道?)\s*[:：]\s*/;
function stripEchoFormat(ans) {
  const out = String(ans || '').split('\n').map(l => l.replace(SAY_PREFIX, '').trim()).filter(Boolean).join('\n');
  return out;   // 空字符串 = 整条只有转述前缀，调用方直接不发
}

/* ===== 复读守卫（主人 2026-10-22：最近 10 条以内，绝对不要有复读别人的话）=====
 * 只比「别人的话」（历史里 user 行），她复读自己的话不管；全群刷同一句她也不跟。
 * 拦下不发、不留日志（没发出去的消息不记）。 */
function normEchoText(s) {
  return String(s || '').replace(/[\s，。！？、；~～…·,.!?；:"'“”‘’()（）【】\[\]]/g, '');
}
// 复读比对前把 @ 段剥掉：群友喊她的话带「@虚幻之海的电子幽灵 …」，她回的时候可能带「@对方 …」——
// 不剥的话 @名字 把文本撑长，长度比掉下 0.8，复读就漏拦了（2026-10-23 实测漏过）。
function stripAtSeg(s) {
  return String(s || '')
    .replace(/@[\w一-龥]{1,20}(（@?\d{4,12}）)?/g, '')   // @昵称、名字（@QQ号）
    .replace(/（@?\d{4,12}）/g, '');                      // 残留的（QQ号）
}
/* ===== 复读白名单（主人 2026-10-23 凌晨定）=====
 * 复读消息**白名单制**：只有这几种场景允许复读——
 * ① 梗库里的（自有热梗/梗词典特征词命中）；② 确定能搜到原文一次不差的梗（自有梗库全文归一化后 ±1~2 字符）；
 * ③ 群友复读了的（复读链跟风，chainJoinAllowed 自己管，不走这里）。
 * 除此之外，10 条以内别人的话一律不许复读（repeatsOthers 拦下）。 */
// 【分类 H·全聊天】复读守卫 replayAllowed/repeatsOthers：全聊天发送层公共规则。
function replayAllowed(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const n = normEchoText(t);
  if (!n || n.length < 4) return false;
  // ① 自有梗库的全文（几乎一样才算）——长句也只认「就是梗库那句」
  for (const s of (guides.memeList ? guides.memeList() : [])) {
    for (const cand of [s.full, s.how]) {
      const nc = normEchoText(String(cand || ''));
      if (!nc) continue;
      if (nc === n) return true;
      if ((nc.includes(n) || n.includes(nc)) && Math.abs(nc.length - n.length) <= 2) return true;   // 显示问题差 1~2 个字符
    }
  }
  // ② 梗库/词典特征词命中 → 只放行**短句**（≤ 20 字）
  //    真事 2026-10-23：群友一句 40 字的自嘲（带梗词「少爷」）被她整句照抄发了出去，
  //    群里等于替对方说话。含梗词 ≠ 这句就是梗。
  if (n.length <= 20 && guides.memeWordHit(t)) return true;
  return false;
}

function repeatsOthers(k, ans) {
  const a = normEchoText(stripAtSeg(stripEchoFormat(ans)));
  if (!a || a.length < 3) return false;
  const users = (core.getHist(k) || []).filter(m => m.role === 'user').slice(-10);
  return users.some(m => {
    // 历史行格式是「某某说: 原话」，先剥前缀再比；@ 段也剥（喊她的部分不算正文）
    let u = String(m.content || '').replace(SAY_PREFIX, '');
    u = u.replace(/^（对方发了图[^）]*）/, '').replace(/^同时说：/, '');
    const n = normEchoText(stripAtSeg(u));
    if (!n || n.length < 3) return false;
    if (n === a) return true;
    // 长句改几个字重说也算复读
    const lo = Math.min(n.length, a.length), hi = Math.max(n.length, a.length);
    return lo >= 6 && hi >= 6 && (n.includes(a) || a.includes(n)) && lo / hi > 0.8;
  });
}

/* ===== 需求记录（主人 2026-10-22 定）：她提的需求要留**原文**，面板「需求记录」页看时间轴 ===== */
// 跑代码自检脚本，把结果用大白话回报给主人（主人 2026-10-22 定：私聊发「修bug/自检」触发）。
// 她能「查」+「修已知的小毛病」（自检脚本里自动修）；修不了的写清文件和原因，靠更新流程来修。
// 【分类 B·测试专属】修bug/自检 → 私聊汇报测试结果：主人裁「全场景测试总集合汇报」类。
function selfCheckReport(ev) {
  const { execFile } = require('child_process');
  execFile(process.execPath, [path.join(__dirname, '..', 'selfcheck.js')],
    { cwd: path.join(__dirname, '..'), timeout: 180000, maxBuffer: 4e6 },
    (err, stdout) => {
      const out = String(stdout || '');
      const m = out.match(/单测 (\d+)\s*\/\s*(\d+)/);
      const fixed = (out.match(/自动修了 (\d+) 处/) || [])[1];
      let msg;
      if (!out && err) msg = '查的时候自己出错了：' + String(err.message).slice(0, 80);
      else if (/结论：全过/.test(out)) msg = '查完啦' + (fixed ? '，顺手修了 ' + fixed + ' 处小毛病（缺文件/格式问题），' : '，') + '其余全正常' + (m ? '（测试 ' + m[1] + ' 条全过）' : '') + '。';
      else {
        const problems = out.split('\n').filter(l => l.includes('✗')).slice(0, 3).map(l => l.replace(/^✗\s*/, '').trim());
        msg = '查出 ' + problems.length + ' 处问题' + (fixed ? '，已自动修好 ' + fixed + ' 处' : '') + '：\n' + problems.join('\n') + '\n剩下的我修不了，等我主人来。';
      }
      logSent('私聊自检', replyTo(ev, msg), nameOf(ev));
    });
}

// 学说话的门槛（主人 2026-10-22 重定，学习规则 v2）：
//   只收**测试群（100000000）以外**的群聊发言；和 @ 无关（@ 后正常对话也收）；
//   机器人功能指令（骰子、触发词）不收——那是在用功能，不是说话。私聊不收。
function styleGate(ev, isMaster, isPrivate, text) {
  if (!isMaster || isPrivate) return false;
  if (String(ev.group_id) === String(cfg.testGroup || 100000000)) return false;
  const t = String(text || '').trim();
  if (/^[.。]/.test(t)) return false;          // 骰子 / 指令
  if (/^（对方发了/.test(t)) return false;
  if (core.matchTrigger(t, true)) return false;   // 触发词 = 在用机器人功能
  return true;
}
const FRAG_WAIT = 620;
const SPAM_MS = 8000;
const frag = new Map();          // k -> {buf:[], waiters:[], timer}
const spamLog = new Map();       // k#uid -> {t, n, at}

const normForSpam = s => String(s || '').replace(/[\s，。！？、~～…·,.!?"'“”‘’()（）【】\[\]]/g, '');

// 同一个人把同一句连发 → 返回 true 表示这条只记不回
// 【分类 A·群专属】复读刷屏 spamRepeat / 一个字一条 collectFrag：主人裁「复读刷屏＝QQ群专属」。
function spamRepeat(k, uid, text) {
  const key = k + '#' + uid;
  const now = Date.now();
  const t = normForSpam(text);
  if (!t) return false;
  const s = spamLog.get(key);
  if (!s || s.t !== t || now - s.at > SPAM_MS) {
    spamLog.set(key, { t, n: 1, at: now });
    return false;
  }
  s.n++;
  s.at = now;
  return true;                   // 第二次起不再回复
}

function collectFrag(k, text) {
  return new Promise(resolve => {
    let f = frag.get(k);
    if (!f) { f = { buf: [], waiters: [] }; frag.set(k, f); }
    f.buf.push(text);
    f.waiters.push(resolve);
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      frag.delete(k);
      const joined = f.buf.join('');
      const [first, ...rest] = f.waiters;
      if (first) first(joined);
      rest.forEach(r => r(null));     // 后面的字已经并进第一条，别重复处理
    }, FRAG_WAIT);
  });
}

// ===== 等她把话说完（主人 2026-10-22 定）=====
// 主人：「我习惯一条条说，等我把话说完机器人才接」——静默没接着说就视为说完了，
// 这时才把攒下的整段一次性答掉，中间一句都不插嘴。
// 例外（主人 2026-10-22 补充）：有人 **@ 她或秒回（引用回复）她的消息** 时直接触发回复，不排队。
// 缓冲按「会话」单键（不再按发言人分键，2026-11-13 改）：同会话所有人连着说的话都进同一个缓冲，
// flush 时再区分「主发言人」和「插话人」——主发言人的多条合并成一条回；
// 插话人默认略过，只有满足任一「需回」条件（@她/引用回复她/对准她/主人必回）才单独排队，
// 在主回复发完后紧接着发（主人 2026-11-13 定）。
const pendingTalk = new Map();   // key -> { pieces:[], firstAt, timer }
// 主人 2026-11-23 定：纯必回 6 分钟冷却。key(会话) -> 上次触发纯必回的时刻。
// 只记内存，重启归零；只对「纯必回」生效（@她/引用她/对准语/复读/命令等前面已分流，不进这里）。
const masterForceAt = new Map();

function planWaitMs(o) {
  const m = cfgLive().merge || {};
  if (m.enabled === false) return 0;
  if (o.hasImg) return 0;                       // 带图马上看，攒久了图床链接可能失效
  // 主人 2026-10-23 凌晨定：「等他说完再答」是**全场景**的——被 @ 也一样等 atMeWaitMs（默认 1.5 秒），
  // 他连着补的话才好拼成一句答；不再有「@ 就秒回」的例外。骰子和带图仍然不等。
  if (o.atMe) return Math.max(0, Number(m.atMeWaitMs != null ? m.atMeWaitMs : 1500));
  if (o.isMaster) return Math.max(0, Number(m.masterWaitMs || 0));
  return Math.max(0, Number(m.otherWaitMs || 0));
}

function pushPendingTalk(key, piece, waitMs) {
  const m = cfgLive().merge || {};
  let p = pendingTalk.get(key);
  if (!p) p = { pieces: [], firstAt: Date.now(), timer: null };
  p.pieces.push(piece);
  pendingTalk.set(key, p);
  if (p.timer) clearTimeout(p.timer);

  // 想多久 🡒 三种情况立刻发：静默到点了 / 攒太多条 / 攒太多字
  const maxMs = Math.max(1000, Number(m.maxMs || 180000));
  const left = Math.min(waitMs, Math.max(0, maxMs - (Date.now() - p.firstAt)));
  const chars = p.pieces.reduce((n, x) => n + x.text.length, 0);
  const tooMuch = p.pieces.length >= (m.maxPieces || 12) || chars >= (m.maxChars || 800);
  p.timer = setTimeout(() => flushPendingTalk(key), tooMuch ? 0 : left);
  if (p.pieces.length > 1) console.log('[merge] 他说到第 ' + p.pieces.length + ' 条，还等着（' + ((tooMuch ? 0 : left) / 1000).toFixed(1) + ' 秒后答）');
  else console.log('[merge] 先攒着等他说完（' + (waitMs / 1000) + ' 秒没接着说就答）');
}

// 一条 piece 是否满足「需要回」（判断插话人是否进回复列表，主人 2026-11-13 定）：
// @她 / 引用回复她 / 对准她 / 主人必回，任一满足就算；跟别人说话（replyOther）不算。
function pieceNeedsReply(pc) {
  return !!(pc.atMe || pc.replyMe || pc.aimTo || pc.isMaster);
}

// 选「主发言人」：主人优先（必回兜底），其次第一个@她/引用她/对准她的，都没有就回最后说话的人
function pickFocusUid(pieces) {
  const master = pieces.find(x => x.isMaster);
  if (master) return String(master.uid);
  const aimed = pieces.find(x => x.atMe || x.replyMe || x.aimTo);
  if (aimed) return String(aimed.uid);
  return String(pieces[pieces.length - 1].uid);
}

// 从一组 piece（同一发言人）构造喂给 handleTurn 的入参，以最后一条为准（沿用 引用错人 修复）
function buildTurn(pieces) {
  const joiner = (cfgLive().merge || {}).joiner || '\n';
  const text = pieces.map(x => x.text).join(joiner).trim();
  const last = pieces[pieces.length - 1];
  const imgsAll = [];
  for (const pc of pieces) if (pc.imgs && pc.imgs.length) imgsAll.push(...pc.imgs);
  return {
    text, imgs: imgsAll,
    atMe: pieces.some(x => x.atMe),
    isPrivate: last.isPrivate,
    who: last.who, rawNick: last.rawNick,
    replyOther: pieces.some(x => x.replyOther),
    replyMe: pieces.some(x => x.replyMe),
    atMeReal: pieces.some(x => x.atMeReal),
    atOtherPerson: pieces.some(x => x.atOtherPerson),
    replyOrigin: last.replyOrigin || null,
    masterLearn: (pieces.find(x => x.masterLearn && x.masterLearn.ctx) || {}).masterLearn,
    aimTo: last.aimTo || '',
    aimInfo: last.aimInfo || { name: '', uid: '', msgId: '' },
    linkNote: (pieces.find(x => x.linkNote) || {}).linkNote || '',
    merged: pieces.length,
    firstMsgAt: (pieces[0] && pieces[0].firstAt) || Date.now(),
  };
}

// 会话级缓冲 flush（主人 2026-11-13 改：缓冲按会话单键，flush 时区分主发言人与插话人）
async function flushPendingTalk(key) {
  const p = pendingTalk.get(key);
  if (!p) return;
  pendingTalk.delete(key);
  if (p.timer) clearTimeout(p.timer);
  const pieces = p.pieces;
  if (!pieces.length) return;
  if (pieces.length > 1) {
    const t = pieces.map(x => x.text).join((cfgLive().merge || {}).joiner || '\n').trim();
    console.log('[merge] ' + pieces.length + ' 条一起处理（含插话甄别）：' + t.replace(/\s+/g, ' ').slice(0, 60));
  }
  const focusUid = pickFocusUid(pieces);
  const focusPieces = pieces.filter(x => String(x.uid) === focusUid);
  // 其余发言人是插话人：满足「需回」就排队主回复后单独发，否则本轮略过
  const interSets = [];
  const seen = new Set();
  for (const pc of pieces) {
    const u = String(pc.uid);
    if (u === focusUid || seen.has(u)) continue;
    seen.add(u);
    const arr = pieces.filter(x => String(x.uid) === u);
    if (arr.some(pieceNeedsReply)) interSets.push(arr);
    else console.log('[merge] 插话人 ' + (arr[arr.length - 1].who || u) + ' 未@未引用且非必回 → 本轮略过');
  }
  // 主回复（耗时从本轮第一条消息算起，@ 时机才准）
  const mainOpts = buildTurn(focusPieces);
  mainOpts.firstMsgAt = p.firstAt;
  try { await handleTurn(focusPieces[focusPieces.length - 1].ev, mainOpts); }
  catch (e) { console.error('[merge] 主回复处理出错：' + (e && e.message)); }
  // 插话人需回的，紧接着单独发
  for (const arr of interSets) {
    try { await handleTurn(arr[arr.length - 1].ev, buildTurn(arr)); }
    catch (e) { console.error('[merge] 插话人回复出错：' + (e && e.message)); }
  }
}

// ===== 话题连续性：没人 @ 她，但话题还连着，也要接（主人 2026-10-22 定）=====
// 截图里的场景：群里在聊「电车难题」，她答过，群友回「怎么选都不对」，群主说「必须选一个」——
// 这句没 @、没疑问词、不是锐评，以前一条路径都不命中，她就不回。
// 现在：她刚参与过这段对话、话题没断、又到了该说话的间隔 → 接着话题接一句。
const recentTalk = new Map();   // scopeKey -> [{t, nick, uid, text, bot}]
const groupLog = new Map();     // scopeKey -> [{t, nick, uid, text, bot}] 即时记忆：无时间窗，cap 60
function talkRing(key) {
  const now = Date.now();
  const win = Number(((cfg || {}).topic || {}).windowMs || 90000);
  const arr = (recentTalk.get(key) || []).filter(m => now - m.t < win);
  recentTalk.set(key, arr);
  return arr;
}
function noteTalk(key, nick, uid, text, bot, ih) {
  const arr = talkRing(key);
  arr.push({ t: Date.now(), nick: String(nick || ''), uid: String(uid || ''), text: String(text || '').slice(0, 120), bot: !!bot });
  if (arr.length > 40) arr.shift();
  // 即时记忆（主人 2026-10-22 定）：群内上下文记最近 50 条，**不按时间窗过期**——
  // 有人问「刚才谁说什么了」就翻这里；找不到算没有，但答案里不许斩钉截铁（可能在她没翻到的记忆里）
  let log = groupLog.get(key);
  if (!log) { log = []; groupLog.set(key, log); }
  // 单条放到 400 字：图片的描述现在是「逐行抄下来的文字」（表格可能五六行），
  // 还按 150 字切就会把数字抄一半，后面谁问「刚才那张图」就只剩半张表。
  // ih = 图的像素指纹，复读链按它认「同一张图」（QQ 转存 md5 每次变）；文字消息不传，行为不变。
  log.push({ t: Date.now(), nick: String(nick || ''), uid: String(uid || ''), text: String(text || '').slice(0, 400), bot: !!bot, ih: String(ih || '') });
  if (log.length > 60) log.splice(0, log.length - 60);
}
// 即时记忆：最近 n 条（默认 50），带说话人；「刚才谁说」类问题查这个
function instantLog(key, n) {
  const arr = groupLog.get(key) || [];
  return arr.slice(-(Number(n) || 50));
}
// 问句里带「刚才/刚刚/谁说了」这种时间指向 → 要去翻即时记忆
const INSTANT_RE = /(刚才|刚刚|上一[句条次回]|有人(说|发|提|问|喊)|谁(说|发|在|刚|之前)|(记得|记得)不|还记得|之前(说|发|有人|那个|谁)|说啥了|说了啥|发了啥|发过什么|说过什么|什么情况|怎么回事)/;
// 主人的纠正判定：这些话一出现，说明刚才那句被误判成夸了——记进纠正本当铁律
const CORRECT_RE = /(不是夸|别记错|夸在哪|哪里夸|谁夸你|这是批评|是批评|不是夸奖|给你纠正|纠正一下)/;
// 身份纠正也算纠正（主人 2026-10-22 真事：「你是虚幻，不是大饮尽酱」——她回「我是大饮尽酱呀」）
const ID_FIX_RE = /(你是[^，。\n]{0,16}，?不是|你不是虚幻|别自称|不许自称|别把自己当)/;
// 某个人最近说过的一句（学习 @ 类样本时当上下文——主人 2026-10-22：联系上下文才学得会接话）
function lastSaidBy(key, uid) {
  const arr = talkRing(key).filter(x => !x.bot && String(x.uid) === String(uid) && String(x.text || '').trim());
  return arr.length ? arr[arr.length - 1].text.trim() : '';
}
// 这句话是不是**逐字复读**：短期历史里已经有一条每个字和标点都一模一样的（主人 2026-10-22：
// 对方在复述别人的话时，这句不算新内容——学习样本里直接只发主人的回复，不带它当上下文）
function verbatimEcho(key, t) {
  const s = String(t || '').trim();
  if (!s || s.length < 3) return false;
  let n = 0;
  try {
    for (const m of core.getHist(key)) {
      if (m.role !== 'user') continue;
      const body = String(m.content || '').replace(/^.*?说: /, '').trim();
      if (body === s) n++;
    }
  } catch { /* 历史拿不到就只看 ring */ }
  if (n >= 2) return true;
  return talkRing(key).filter(x => !x.bot && String(x.text || '').trim() === s).length >= 2;
}
// 新人物 / 新群：第一次见到的，在 data/seen.json 里记一笔，同时写进入日志（只记一次，不刷屏）
const SEEN_PATH = path.join(__dirname, '..', 'data', 'seen.json');
let seenCache = null;
function loadSeen() {
  if (seenCache) return seenCache;
  try { seenCache = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')) || {}; } catch { seenCache = {}; }
  seenCache.people = seenCache.people || [];
  seenCache.groups = seenCache.groups || [];
  return seenCache;
}
function noteFirstSight(key, kind, label) {
  const s = loadSeen();
  const arr = kind === '新群' ? s.groups : s.people;
  if (arr.indexOf(key) >= 0) return;
  arr.push(key);
  try {
    fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify(s, null, 1), 'utf8');
  } catch {}
  botWrite('data/seen.json', kind, label);
  console.log('[' + kind + '] ' + label);
}
// 暂停命令用：这个号是不是她待过的群（seen.json 里有记录）
function isKnownGroup(gid) {
  try { return (loadSeen().groups || []).indexOf('g' + String(gid)) >= 0; } catch { return false; }
}
// 【分类 H·全聊天】话题接续 topicAllowed：主人裁「话题功能全平台都要有」；
// 翻篇封禁期（said-topics.jsonl）是它的分支、仅 QQ 群 → 归 A。本函数本体归 H。
function topicAllowed(gid, text) {
  const c = (cfg && cfg.topic) || {};
  if (c.enabled === false) return false;
  if (saidToday(gid) >= Number(c.dailyMax || 60)) return false;      // 今天的量说够了就不接
  const ring = talkRing('g' + gid);
  const now = Date.now();
  const lastBot = ring.filter(m => m.bot).slice(-1)[0];
  if (!lastBot) return false;                                        // 这段对话她没参与过
  if (now - lastBot.t < Number(c.minGapMs || 8000)) return false;    // 刚说完，别连着刷
  if (!ring.some(m => m.t > lastBot.t)) return false;                // 她说完没人接，话题断了
  const t = String(text || '').trim();
  if (t.replace(/\s/g, '').length < Number(c.minLength || 3)) return false;
  if (/^[.。]/.test(t)) return false;                                // 骰子 / 指令
  if (/@\d/.test(t)) return false;                                   // 在 @ 别人，不抢话
  // 和最近几句有二字切片重合 → 话题对上了，一定接；
  // 没有重合（「必须选一个」这种短句）→ 按概率接，避免她每条都插嘴
  const set = new Set();
  const ctxCj = ring.slice(-6).map(m => m.text).join('\n').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  for (let i = 0; i < ctxCj.length - 1; i++) set.add(ctxCj.slice(i, i + 2));
  const cj = t.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  let shared = 0;
  for (let i = 0; i < cj.length - 1; i++) if (set.has(cj.slice(i, i + 2))) shared++;
  // 主人 2026-10-23 定：「我说话不是一句一句的，是要一起回的」——
  // 以前「和上文有二字重合就一定接」+ 8 秒间隔 = 群里每 8 秒插一句，看起来像每条都在回。
  // 现在重合也只是「更可能接」，仍要过概率；间隔也放宽到 20 秒（config.topic.minGapMs）。
  if (shared >= 1) return Math.random() < Number(c.hitP != null ? c.hitP : 0.6);
  return Math.random() < Number(c.p != null ? c.p : 0.25);
}

/* 收消息这一刻 QQ 事件里是有 user_id 和显示名的，写日志时这两样才丢。
 * 顺手补一张「显示名 → 号」索引（历史记录里群友头像靠它补），再比一次头像 hash。
 * 实现搬进 core.noteAvatar（2026-11-07）：B站 的人也要有头像，两个平台共用一份，
 * 不再各写一套下载 / 描述逻辑。 */
function noteQqMeta(ev) {
  const uid = String(ev.user_id || '');
  if (!uid || uid === String(selfId || '')) return;
  const nick = (ev.sender && (ev.sender.card || ev.sender.nickname)) || '';
  try { core.noteAvatar('qq', uid, nick); } catch {}
}

// ===== 好友申请 / 群邀请：自动同意（v79，主人 2026-10-23 定「我要 AI 能加群，也能自动通过好友申请」）=====
// 说明：OneBot/NapCat 没有「自己搜群号主动加群」的接口（协议层就没有这个动作），
// 能做的是——别人加她好友、别人邀请她进群 / 申请加群（她是管理员时），自动同意。
// request 事件**没有 sender 字段**（OneBot 11 只在 message 事件里给 sender），
// 所以以前那行 ev.sender?.nickname 恒等于 undefined，陌生人一律显示成「QQ 12345」。
// 昵称得自己问 NapCat 要：名单 → 群名片 → 陌生人资料 → 兜底号码。
// 一律 2.5 秒收工 + try/catch：查不到名字也必须照常同意，不许因为查名字把加群搞黄。
async function reqWho(ev) {
  const uid = String(ev.user_id || '');
  const known = (cfgLive().people || {})[uid];
  if (known) return known;
  try {
    if (ev.group_id) {
      const r = await callApi('get_group_member_info', { group_id: ev.group_id, user_id: ev.user_id, no_cache: false }, 2500);
      const d = (r && r.data) || {};
      const n = String(d.card || d.nickname || '').trim();
      if (n) return n;
    }
  } catch (e) { /* 群邀请时她还没进群，查不到是正常的 */ }
  try {
    const r = await callApi('get_stranger_info', { user_id: ev.user_id }, 2500);
    const d = (r && r.data) || {};
    const n = String(d.nickname || '').trim();
    if (n) return n;
  } catch (e) { /* 查不到就兜底号码 */ }
  return 'QQ ' + uid;
}

const onRequest = async ev => {
  const c = cfgLive().autoAccept || {};
  const who = await reqWho(ev);
  try {
    if (ev.request_type === 'friend') {
      if (c.friend === false) { console.log('[好友] 有申请，但自动同意已关闭'); return; }
      await callApi('set_friend_add_request', { flag: ev.flag, approve: true }, 4000);
      console.log('[好友] 已自动同意：' + who + '（' + ev.user_id + '）');
      core.logLine('qq', who, '[好友申请] 自动同意', false, '私聊');
      core.acceptLog({ kind: 'friend', who, uid: String(ev.user_id || ''), gid: '', sub: 'add' });
      core.master('有人加我好友：' + who + '（' + ev.user_id + '）'
        + (ev.comment ? '，留言：' + String(ev.comment).slice(0, 60) : '') + '。我自动同意了。');
      return;
    }
    if (ev.request_type === 'group') {
      if (c.groupInvite === false) { console.log('[群] 有邀请/申请，但自动同意已关闭'); return; }
      const label = (ev.sub_type === 'invite' ? '邀请我进群 ' : '申请加入群 ') + ev.group_id;
      // OneBot11 规范：事件里这个字段叫 sub_type，但 set_group_add_request 接口要的是 type。
      // NapCat 严格实现只认 type，只传 sub_type 会导致同意动作根本没发出去（“依旧不加群”的根因之一）。
      // 两个都传，兼容两种实现。
      await callApi('set_group_add_request', { flag: ev.flag, sub_type: ev.sub_type, type: ev.sub_type, approve: true }, 4000);
      console.log('[群] 已自动同意：' + who + ' ' + label);
      core.logLine('qq', who, '[群邀请] 自动同意：' + label, false, '群' + ev.group_id);
      core.acceptLog({ kind: 'group', who, uid: String(ev.user_id || ''), gid: String(ev.group_id || ''), sub: String(ev.sub_type || '') });
      core.master(who + ' ' + label + '，我同意了。');
      refreshGroupNames('同意进群');     // 同意的这个群马上补名字
    }
  } catch (e) {
    console.log('[request] 处理失败：' + e.message);
    core.aiFeedback('加群/加好友没成功', '处理 ' + (ev.request_type || '') + ' 请求失败：' + e.message);
  }
};

// ===== 拍一拍（v78，主人 2026-10-23 定）=====
// 主人问「我现在拍你你能知道吗」——以前 NapCat 的拍一拍通知根本没接，她当然不知道。
// 现在：收到拍一拍（notice: notify/poke，target 是她自己）→ 记进聊天记录和即时记忆，并且回一句。
// 永远不设「只准发言/转发」这类 QQ 功能白名单（主人 2026-10-23 铁律）：能收到的事件就接。
const pokeAt = new Map();
// 【分类 A·群专属】戳一戳 onPoke：QQ 通知事件（群/私聊都能拍，但属 QQ 平台专属互动）。
async function onPoke(ev) {
  const target = String(ev.target_id || ev.targetId || '');
  if (!target || String(target) !== String(selfId || '')) return;   // 拍的不是她
  const from = String(ev.user_id || '');
  if (!from || from === String(selfId || '')) return;               // 她自己拍的
  const c = cfgLive().poke || {};
  if (c.enabled === false) return;
  const isPrivate = !ev.group_id;
  const key = isPrivate ? 'p' + from : 'g' + ev.group_id;
  const now = Date.now();
  if (now - (pokeAt.get(key) || 0) < Number(c.cooldownMs || 3000)) return;   // 连拍只回一次
  pokeAt.set(key, now);
  const who = (cfgLive().people || {})[from] || ev.sender?.card || ev.sender?.nickname || (isPrivate ? '有人' : '群友');
  const scope = isPrivate ? '私聊' : ('群' + ev.group_id);
  const note = '（拍了拍' + (cfg.botName || '虚幻') + '）';
  core.logLine('qq', who, note, false, scope);
  noteTalk(key, who, from, note, false);
  markActive();
  console.log('[poke] ' + who + ' 拍了拍她（' + scope + '）' + (c.reply === false ? '，只记录' : '，要回一句'));
  if (c.reply === false) return;
  const ev2 = Object.assign({}, ev, { message_type: isPrivate ? 'private' : 'group' });
  await handleTurn(ev2, {
    text: note, atMe: true, imgs: [], isPrivate, who, rawNick: who,
    replyOther: false, replyOrigin: null, masterLearn: null, poke: true, aimTo: '',
  });
}

// 把连接状态写到 data/bot-status.json，管理面板顶栏那个灯读的就是它
// 记下最后一次状态，用于心跳（见下）
let curStatus = { online: false, detail: '' };
function setStatus(online, detail) {
  curStatus = { online: !!online, detail: detail || '' };
  try {
    const p = path.join(__dirname, '..', 'data', 'bot-status.json');
    let old = {};
    try { old = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch {}
    fs.writeFileSync(p,
      JSON.stringify({ online: !!online, detail: detail || '', at: new Date().toISOString(), pid: process.pid, thinking: old.thinking, thinkingAt: old.thinkingAt, muted: muteStatus() }, null, 1), 'utf8');
  } catch {}
}
// 心跳（v76）：群里长时间没人说话时，bot-status.json 的 at 就不动，
// 自查探针（selfwatch）会误判「连接层卡死了」，还会照着误判私信主人。
// 所以每分钟用当前状态刷一次时间戳——「at」表示「我活着」，不是「刚发生过事件」。
function statusHeartbeat() {
  if (hb) clearInterval(hb);
  hb = setInterval(() => setStatus(curStatus.online, curStatus.detail), 60 * 1000);
}
let hb = null;
// 「正在想答案」状态：面板状态栏会亮一个「思考中」，免得主人以为面板卡了
function setThinking(on) {
  try {
    const p = path.join(__dirname, '..', 'data', 'bot-status.json');
    let old = {};
    try { old = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch {}
    old.thinking = !!on;
    old.thinkingAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(old, null, 1), 'utf8');
  } catch {}
}

/* 群名表（2026-11-07 主人：「补群名，以后自动加」）
 * 聊天日志只存群号，会话栏要显示「群名（群号）」。一次 get_group_list 拿全部群，
 * 不逐群问、不每条消息问。什么时候刷：① 上线 ② 她自己被拉进新群 ③ 有人拉她进群。
 * （手动改群名那个功能 2026-11-19 已按主人令整套删除，客户端也不再传群名。）拿不到就留空，
 * 客户端退回「群（号）」，不编名字。 */
let groupNamesAt = 0;
function refreshGroupNames(why) {
  if (Date.now() - groupNamesAt < 60 * 1000) return;     // 一分钟内不重复问
  groupNamesAt = Date.now();
  return callApi('get_group_list', {}, 4000).then(r => {
    const arr = (r && (r.data || r.result)) || [];
    const n = qmeta.setGroups(arr);
    if (n) console.log('[QQ] ' + (why || '刷新') + '：记下 ' + n + ' 个群名');
    return n;
  }).catch(() => 0);
}

function connect() {
  const opts = {};
  if (cfg.napcatToken) opts.headers = { Authorization: `Bearer ${cfg.napcatToken}` };
  ws = new WebSocket(cfg.napcatWsUrl, opts);
  ws.on('open', () => {
    console.log('[QQ] 已连接 NapCat，上线'); setStatus(true, '已连接 NapCat');
    // 上线就把图库指纹补齐/刷新一次（只算新图，全量 415 张约 3 秒），她发图才认得出是自己库里的
    try { stickerLibRefresh(true); } catch {}
    // 上线问一次群名单：聊天日志只存群号，会话栏要显示「群名（群号）」。
    refreshGroupNames('上线');
  });
  ws.on('message', raw => {
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    // 发送回执（2026-11-09）：消息类发送的回包，成功继续回读确认，失败走重发
    if (ev.echo && sendAcks.has(ev.echo)) {
      const ok = ev.status === 'ok' || ev.retcode === 0;
      const whyRaw = String(ev.message || ev.wording || ('retcode ' + ev.retcode));
      // 2026-11-17 主人令「字数缩减可知」：日常发送被平台以"消息过长/超限"拒收 →
      // 记一笔告警，说明 QQ 字数上限可能缩了，让主人知道去测一下（测上限走 callApi，不进这里，不会误报）。
      if (!ok && /过长|超限|超出|too\s*long|message\s*too\s*large|content\s*too\s*long|字数|长度|1400|too\s*many/i.test(whyRaw)) {
        try {
          core.aiFeedback('QQ字数可能缩减', '发消息被拒，平台回：「' + whyRaw.slice(0, 80)
            + '」。QQ 上限记的是 ' + (platLimits.capOf('qq') || 600) + ' 字，可能缩了——私聊发「测上限」重测。');
          console.log('[上限] 疑似字数缩减：' + whyRaw.slice(0, 80));
        } catch {}
      }
      finishSend(ev.echo, ok, ok ? '' : ('NapCat 回包失败：' + whyRaw), ev);
      return;
    }
    // 接口回包（get_group_member_info / get_stranger_info 等）
    if (ev.echo && waiters.has(ev.echo)) {
      const w = waiters.get(ev.echo); waiters.delete(ev.echo);
      if (ev.status === 'ok' || ev.retcode === 0) w.resolve(ev);
      else w.reject(new Error(ev.message || `retcode ${ev.retcode}`));
      return;
    }
    if (ev.meta_event_type) { if (ev.self_id) selfId = ev.self_id; return; }
    // 会话总开关关闭的群（2026-11-22）：这个群不看也不回，message/notice 都不处理，直接丢。
    // 放在 echo/接口回包/meta_event 之后，避免挡住发送回执和查询回包。
    if (ev.group_id && (ev.post_type === 'message' || ev.post_type === 'notice')
        && convSettings.isOff('qq_' + ev.group_id)) {
      return;
    }
    // 加好友 / 邀请进群（v79）：自动同意
    if (ev.post_type === 'request') {
      if (ev.self_id) selfId = selfId || ev.self_id;
      onRequest(ev).catch(e => console.log('[request] ' + e.message));
      return;
    }
    // 她自己加进某个群 → 记住「我是新人」，十分钟内相关的欢迎她才知道被欢迎的是自己
    if (ev.post_type === 'notice' && ev.notice_type === 'group_increase'
        && String(ev.user_id) === String(selfId || ev.self_id || '')) {
      if (ev.self_id) selfId = ev.self_id;
      markNewbie(ev.group_id);
      selfJoinAt = Date.now();       // 真进群了，v91 的谎报闸据此放行「我进来了」
      console.log('[QQ] 我加入了群 ' + ev.group_id + '（十分钟内知道自己是新人）');
      refreshGroupNames('进了新群');   // 新群立刻补名字，会话栏不用等下次上线
      return;
    }
    // 群禁言（2026-11-05）：禁的是她自己 → 记住到期时刻，之后群里只记录、不调模型。
    // 30 秒 / 1 小时 / 30 天…都由事件里的 duration 或查询接口的时间戳决定，这里不用分辨。
    if (ev.post_type === 'notice' && ev.notice_type === 'group_ban') {
      if (ev.self_id) selfId = selfId || ev.self_id;
      if (onGroupBan(ev)) return;
    }
    // 消息被撤回（主人 2026-11-06 定）：清掉风格样本里的这条，并自动记一条待修复问题。
    // NapCat 群撤回 = group_recall，私聊撤回 = friend_recall，都带 message_id。
    if (ev.post_type === 'notice' && (ev.notice_type === 'group_recall' || ev.notice_type === 'friend_recall')) {
      handleRecall(ev);
      return;
    }
    // 群友给她的消息点表情回应（👍/👏 等任何标志）→ 直接加星（主人 2026-10-22 定）
    if (ev.post_type === 'notice' && (ev.notice_type === 'group_msg_emoji_like' || ev.notice_type === 'group_emoji_like')) {
      onEmojiLike(ev).catch(e => console.log('[星标] ' + e.message));
      return;
    }
    // 拍一拍（v78）：NapCat 两种写法都认（notify/poke 与 poke）
    if (ev.post_type === 'notice'
        && ((ev.notice_type === 'notify' && ev.sub_type === 'poke') || ev.notice_type === 'poke')) {
      if (ev.self_id) selfId = selfId || ev.self_id;
      onPoke(ev).catch(e => console.log('[poke] ' + e.message));
      return;
    }
    if (ev.post_type === 'message' && (ev.message_type === 'private' || ev.message_type === 'group')) {
      if (ev.self_id) selfId = ev.self_id;
      // 自动搬屎（默认关闭）：在任何回复闸门之前，拿原始 ev 缓存源群消息。
      // 这里必须独立于 onMessage——它不 @ 机器人、主人没说话，也要被缓存进「史」。
      try { movePoop.onMessage(ev); } catch (e) { console.log('[搬屎] 入口出错：' + e.message); }
      // 优质屎（主人 2026-11-24 原话）：判定只在群消息里做，独立于回话闸门。
      if (ev.message_type === 'group') {
        const seg = parseSegments(ev);
        // ① 虚幻搬到目标群的那条（自己发的合并转发）→ 展开登记观察
        try {
          if (isSelfSowingForward(ev, seg.forwards)) {
            noteSowForQuality(ev, seg.forwards).catch(e => console.log('[优质屎] 展开失败：' + e.message));
          }
        } catch (e) {}
        // ② 被回复：群友消息 reply 段指向虚幻那条转发消息
        try { if (seg.replyId) poopQuality.hitByMid(seg.replyId, 'reply'); } catch (e) {}
        // ③ 后续 5 分钟群聊关键词和屎重合（群友发言才算，虚幻自己的不算）
        try {
          if (String(ev.user_id) !== String(selfId || '') && seg.text) {
            poopQuality.hitByChat(seg.text, Date.now());
          }
        } catch (e) {}
      }
      // 保健提醒的触发源（她 2026-11-23 定）：被提醒的人在这个群说话后 6 分钟发一条。
      // 放最前面、独立于 onMessage：他不 @ 机器人、也没触发回话闸门，这条提醒照样要算。
      if (ev.message_type === 'group') {
        try { healthRemind.noteSpeak(ev.group_id, ev.user_id, Date.now()); } catch (e) {}
      }
      onMessage(ev).catch(e => console.error(e));
    }
  });
  ws.on('close', () => { console.log('[QQ] 断开，5 秒重连'); setStatus(false, '连接断开，正在重连'); setTimeout(connect, 5000); });
  ws.on('error', e => { console.error('[QQ]', e.message); setStatus(false, e.message); });
}

// ===== QQ 空间逛街（主人 2026-10-22 定：逛的是 QQ 真动态）=====
// 每 3 小时（config.qzone.everyHours）：调 qzone_stroll.py（qzone-sdk 走 NapCat 拿 Cookie）
// 先扫主人的说说，主人的没得发才扫好友动态；挑一条 → LLM 配一句感想（v52：每条都要发感想，
// 梗优先级：合适的热梗→固定句式梗→复制粘贴梗→本身梗→关联梗→人设回答）→ 带感想转发到自己的空间。
let qzoneFailLogged = 0;
function qzoneArgs(extra) {
  const masters = [cfg.masterQQ].concat(cfg.masters || []).map(String).filter(Boolean);
  // 2026-11-17 修路径：脚本实际在 src/scripts/qzone_stroll.py，原来少写 scripts 一级 →
  // 一直找不到文件（这就是 posts:0、动态功能跑不起来的直接原因）。
  return [path.join(__dirname, '..', 'scripts', 'qzone_stroll.py'),
    cfg.napcatWsUrl || 'ws://127.0.0.1:3001', String(cfg.masterQQ || ''), masters.join(','), String(selfId || '')]
    .concat(extra || []);
}
function runStroll(args, onDone) {
  const q = (cfg && cfg.qzone) || {};
  const py = q.pythonPath || defaultPython();
  let out = '';
  try {
    const p = require('child_process').spawn(py, args, { windowsHide: true });
    p.stdout.on('data', d => { out += String(d); });
    p.stderr.on('data', () => {});
    p.on('error', e => {
      if (Date.now() - qzoneFailLogged > 6 * 3600 * 1000) {
        qzoneFailLogged = Date.now();
        console.log('[空间] 逛不了：' + e.message + '（要装 qzone-sdk：pip install "qzone-sdk[napcat]"）');
      }
    });
    p.on('close', code => {
      let r = null;
      try { r = JSON.parse((out.match(/\{[\s\S]*\}/) || [out])[0]); } catch {}
      onDone(r, code);
    });
  } catch (e) { console.log('[空间] ' + e.message); }
}
function qzoneFailLog(r, code) {
  if (Date.now() - qzoneFailLogged > 6 * 3600 * 1000) {
    qzoneFailLogged = Date.now();
    console.log('[空间] 逛街失败：' + ((r && r.error) || ('退出码 ' + code)));
  }
}
// 【分类 D1·平台功能(QQ空间)】逛真动态/转发/发说说：只在 QQ 空间生效，不进聊天回话链。
function qzoneStroll(manual) {
  const q = (cfg && cfg.qzone) || {};
  if (q.enabled === false) return;
  // 频率硬标准（主人 2026-10-23 凌晨定）：两条转发之间至少隔 everyHours（默认 3 小时）。
  // 每次重启 3 分钟后都会首逛一次——不查上次转发时间的话，改版重启一次就多转一条（实测 33 分钟转了 3 条）。
  if (!manual) {
    const h = qzoneReadHist();
    // lastRepostAt 没有时从最后一条转发记录推算（旧档案迁移，防升级后首跳又转一次）
    const last = Number(h.lastRepostAt || 0)
      || (Array.isArray(h.reposts) && h.reposts.length ? Date.parse(h.reposts[h.reposts.length - 1].t) || 0 : 0);
    const gap = Number(q.everyHours || 3) * 3600 * 1000;
    if (last && Date.now() - last < gap) {
      console.log('[空间] 距上次转发才 ' + Math.round((Date.now() - last) / 60000) + ' 分钟（间隔 ' + (gap / 3600000) + ' 小时），这轮不转');
      return;
    }
  }
  runStroll(qzoneArgs(manual ? ['--dry'] : ['--pick']), (r, code) => {
    if (!r || !r.ok) return qzoneFailLog(r, code);
    if (!r.picked) return console.log('[空间] ' + (r.note || '这轮没得挑'));
    const pk = r.picked;
    if (manual) {        // 手动触发（--dry）只看不转，保持原行为
      console.log('[空间] （dry）会挑 ' + (pk.isMaster ? '主人' : pk.qq) + ' 的动态：' + String(pk.text).slice(0, 30));
      return;
    }
    // 第一段拿到动态 → 生成感想 → 第二段带感想转发（第 4 段带上正文，判重记录才有「同人+同文」指纹）
    core.qzoneComment(pk.text, pk.isMaster).then(comment => {
      const c = String(comment || '').trim();
      runStroll(qzoneArgs(['--do', pk.qq + '|' + pk.tid + '|' + c + '|' + String(pk.text || '')]), (r2, code2) => {
        if (r2 && r2.ok && r2.reposted) {
          qzoneNoteRepost();          // 记下这次转发时间——重启首跳靠它挡住 3 小时内的重复逛
          const who = pk.isMaster ? '主人' : (pk.name || pk.qq) + '（' + pk.qq + '）';
          console.log('[空间] 转发了 ' + who + ' 的动态' + (c ? '，感想：' + c.slice(0, 30) : '（没配上感想）'));
          botWrite('data/qzone-stroll.jsonl', 'QQ空间逛街',
            '转发了 ' + who + ' 的动态：' + String(pk.text).slice(0, 60)
            + (c ? '／感想：' + c.slice(0, 60) : '／感想生成失败，裸转了'));
          // 主人 2026-10-23 定：转**谁的**都要私聊告诉主人（只通知主人，不通知别人）
          core.master('我刚逛到 ' + who + ' 的动态，转走啦：「' + String(pk.text).slice(0, 60) + '」' + (c ? '\n感想是这么写的：' + c : ''));
          // 主人的动态 → 正文是主人的话；她自己写的感想也是她（＝主人）的口味。两处都记
          // （真人真事：主人发「进行疯狂的集邮」，她转发了，口味里却没有集邮）
          if (pk.isMaster) core.extractTasteText(String(cfg.masterQQ || ''), '主人',
            String(pk.text || '') + (c ? '\n' + c : ''));
        } else qzoneFailLog(r2, code2);
      });
    }).catch(e => {
      console.log('[空间] 感想生成失败（' + e.message + '），这次裸转');
      runStroll(qzoneArgs(['--do', pk.qq + '|' + pk.tid + '||' + String(pk.text || '')]), (r2, code2) => {
        if (r2 && r2.ok && r2.reposted) {
          qzoneNoteRepost();          // 裸转也算了时间，间隔硬标准一视同仁
          const who = pk.isMaster ? '主人' : (pk.name || pk.qq) + '（' + pk.qq + '）';
          botWrite('data/qzone-stroll.jsonl', 'QQ空间逛街',
            '转发了 ' + who + ' 的动态：' + String(pk.text).slice(0, 60) + '／感想生成失败，裸转了');
          core.master('我刚逛到 ' + who + ' 的动态，转走啦：「' + String(pk.text).slice(0, 60) + '」');
          if (pk.isMaster) core.extractTasteText(String(cfg.masterQQ || ''), '主人', String(pk.text || ''));   // 只有正文（感想没生成）
        } else qzoneFailLog(r2, code2);
      });
    });
  });
}

// ===== 逛人物列表里每个人的空间，认真留一条评论（2026-11-17 主人令）=====
// 她的规矩（原话）：
//   · 一个动态下面只发一条评论，所以必须慎重；不许发任何可能是低分的回复。
//   · 评论依据**不能带任何来自群/私聊的内容**，只能来自别的地方（对方其他空间帖子 / B站，B站下一轮）。
//   · 写完直接把链接/截图给主人，不发文字汇报。
// 做法：选人（人物列表里有 QQ 的）→ 拉他自己空间 → 挑一条没评过的 → 生成 → 低分门 → 过了才发。
// 频率：默认每 4 小时看一次、每天最多 3 条（改 src/config/features.json 的 qzone.friendComment）。
// 通知：主人 2026-11-17 定「不要客户端，走 QQ 私信」→ 发出去就把链接私聊给主人，不发文字汇报。
/* ===== 逛空间私信里的「这人是谁」（主人 2026-11-18 令）=====
 * 私信要同时说清三样：此人所在的、和虚幻的共同群 / 其他平台主页 / 仅此账号无其他相关所属。
 * 三样都从已有数据取，不另外猜：
 *   · 共同群：先看人物档案里记过他的群名片（记过 = 在群里见过他），再拿群成员名单补
 *     （群名表里虚幻所在的群，逐个问「他在不在」；groupMemberIds 自带 10 分钟缓存）。
 *   · 其他平台主页：同一人物下非 QQ 的账号。**只对能确定拼法的平台拼链接**
 *     （B站 / 微博 / Telegram），其余平台只写「平台:id」—— 不猜地址。
 *   · 两样都没有 → 明写「仅此账号，无其他相关所属」，不留空。
 *   · 群名单压根没建（群名表空）时不许说「无」，要说「查不到」—— 分不清和真没有是两回事。 */
function platHomeUrl(plat, id) {
  const u = String(id || '').trim().replace(/^@/, '');
  if (!u) return '';
  if (plat === 'bili' && /^\d+$/.test(u)) return 'https://space.bilibili.com/' + u;
  if (plat === 'weibo' && /^\d+$/.test(u)) return 'https://weibo.com/u/' + u;
  if (plat === 'telegram') return 'https://t.me/' + u;
  return '';
}

/* 群成员反查表：QQ → 他在哪些群。6 小时只建一次，之后 O(1)。
 * 为什么不逐群问：她只有 9 个群，但每条私信都问一遍 = 每条都发 9 次请求给 QQ，
 *   纯属自己给自己招风控。cache 里同时记「哪些群真拿到了名单」，
 *   拿不到的群不许算成「他不在」。 */
let _ownerIdx = null;
const OWNER_IDX_TTL = 6 * 3600 * 1000;
async function ownerMemberIndex() {
  if (_ownerIdx && Date.now() - _ownerIdx.at < OWNER_IDX_TTL) return _ownerIdx;
  const names = qmeta.groupNames() || {};
  const map = {};      // qq → [群号]
  const ok = {};       // 群号 → 1（这份名单真拿到了）
  for (const gid of Object.keys(names)) {
    let ids = [];
    try { ids = await groupMemberIds(gid); } catch {}
    if (!ids || !ids.length) continue;
    ok[gid] = 1;
    for (const id of ids) (map[id] = map[id] || []).push(gid);
  }
  // 一个群都没拿到 → 不写缓存（否则 6 小时内都以为「查不到」）
  const fresh = { map, ok, at: Object.keys(ok).length ? Date.now() : 0 };
  if (fresh.at) _ownerIdx = fresh;
  return fresh;
}

async function qzoneOwnerInfo(qq) {
  const u = String(qq || '').trim();
  const info = { groups: [], others: [], knownGroups: 0, unknownGroups: 0 };
  if (!u) return info;
  let pid = '';
  try { pid = people.findByAccount('qq', u) || ''; } catch {}
  // ① 档案里记过的群名片（他发给所在群的群名片，按群号分开记的）
  const cardGids = new Set();
  if (pid) {
    try {
      const per = people.get(pid) || {};
      for (const a of (per.accounts || [])) {
        if (a.platform === 'qq' && String(a.id) === u && a.cards) {
          Object.keys(a.cards).forEach(g => cardGids.add(String(g)));
        }
      }
    } catch {}
  }
  // ② 群名表里虚幻还在的群：群名片记过算命中，否则查成员名单
  const names = qmeta.groupNames() || {};
  const known = Object.keys(names);
  info.knownGroups = known.length;
  let idx = { map: {}, ok: {} };
  if (known.length) { try { idx = await ownerMemberIndex(); } catch {} }
  const hisGids = idx.map[u] || [];
  for (const gid of known) {
    if (cardGids.has(gid) || hisGids.indexOf(gid) >= 0) {
      info.groups.push({ gid, name: names[gid] || '' });
    } else if (!idx.ok[gid]) {
      // 名单没拿到（没连 NapCat / 接口超时）**不等于他不在**——单独记，不许混进「无」
      info.unknownGroups += 1;
    }
  }
  // 有群名片但群名表里没有的群（群解散 / 虚幻已退）也照实说，只写群号
  for (const gid of cardGids) if (known.indexOf(gid) < 0) info.groups.push({ gid, name: '' });
  // ③ 同一人物的其他平台账号
  if (pid) {
    try {
      for (const a of (people.accountsOf(pid) || [])) {
        if (a.platform === 'qq') continue;
        info.others.push({
          platform: a.platform,
          label: people.platLabel(a.platform) || a.platform,
          id: String(a.id || ''),
          url: platHomeUrl(a.platform, a.id),
        });
      }
    } catch {}
  }
  return info;
}

/* 拼成私信里那几行（和空间链接放同一条，不分两条发） */
function qzoneOwnerLines(info) {
  const gs = (info && info.groups) || [];
  const os = (info && info.others) || [];
  const known = Number(info && info.knownGroups) || 0;
  const unknown = Number(info && info.unknownGroups) || 0;
  const lines = [];
  if (gs.length) {
    lines.push('共同群：' + gs.map(g => (g.name || '（群名未知）') + '（' + g.gid + '）').join('、'));
  } else if (known === 0) {
    lines.push('共同群：查不到（群名单还没建，NapCat 上线后会自动建）');
  } else if (unknown > 0) {
    lines.push('共同群：查不到（' + unknown + ' 个群拿不到成员名单，连上 NapCat 再问）');
  } else {
    lines.push('共同群：无（虚幻在的 ' + known + ' 个群都没有他）');
  }
  if (os.length) {
    lines.push('其他平台：' + os.map(o => o.label + ' ' + (o.url || (o.id + '（这个平台没有固定主页地址）'))).join('、'));
  } else {
    lines.push('其他平台：无');
  }
  // 只有「确定查过、确实什么都没有」才说这句；查不到的情况上面已经写明，不许冒充查过
  if (!gs.length && !os.length && known > 0 && unknown === 0) lines.push('仅此账号，无其他相关所属');
  return lines;
}

// 【分类 D1·平台功能(QQ空间)】逛人物列表里每个人的空间、留评论：仅 QQ 空间。
function qzoneFriendStroll(manual, onMsg) {
  // 主体逻辑在 src/qzone-comment.js 的 runOnce（定时与私聊手动是同一份，不写第二套）：
  //   一个动态只发一条评论；依据只来自对方空间；低分门不过就不发。
  return qc.runOnce({
    gen: ctx => core.qzoneFriendComment(ctx),
    manual: !!manual,
    onMsg: onMsg,
    onSent: e => {
      // 归属信息要查群成员名单（有 10 分钟缓存），所以这里是异步的；查失败也不挡这条私信
      return Promise.resolve()
        .then(() => qzoneOwnerInfo(e.qq))
        .catch(() => ({ groups: [], others: [], knownGroups: 0 }))
        .then(info => {
          const lines = [(e.name || e.qq) + ' 的空间：' + e.link];
          if (e.comment) lines.push('评论：' + e.comment);
          lines.push(...qzoneOwnerLines(info));
          const text = lines.join('\n');
          // 手动那条是主人私聊里问的，回复在同一条会话就行；再走 master 会发两遍
          if (onMsg) onMsg(text);
          else core.master(text);
        });
    },
  });
}

// ---- 发她自己的说说（v68，主人 2026-10-23 定：像人类一样的频率和内容）----
// 频率：每天随机 0~2 条（0 四成、1 四成、2 两成——人类不是天天都发）；只在 10:00~23:30 发；
//       两条至少隔 3 小时。计划存 data/qzone-history.json 的 days 段，重启不重掷。
// 【分类 D1·平台功能(QQ空间)】发她自己的说说/转发 + 去重时间戳：仅 QQ 空间。
function qzoneNoteRepost() {            // 转发成功 → 记时间戳（重启首跳的间隔硬标准读它）
  try {
    const h = qzoneReadHist();
    h.lastRepostAt = Date.now();
    qzoneWriteHist(h);
  } catch {}
}
function qzoneDayKey(t) {
  const d = t ? new Date(t) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function qzoneReadHist() {
  try { return JSON.parse(fs.readFileSync(QZONE_HIST_PATH, 'utf8')) || {}; } catch { return {}; }
}
function qzoneWriteHist(h) {
  try { fs.writeFileSync(QZONE_HIST_PATH, JSON.stringify(h, null, 1), 'utf8'); } catch {}
}
function qzoneTodayPlan(hist) {
  const day = qzoneDayKey();
  hist.days = hist.days || {};
  if (!hist.days[day]) {
    const r = Math.random();
    const plan = r < 0.4 ? 0 : (r < 0.8 ? 1 : 2);   // 0:40% 1:40% 2:20%
    hist.days[day] = { plan, done: 0, lastAt: 0 };
    // 只留最近 14 天，文件别长
    const keys = Object.keys(hist.days).sort();
    while (keys.length > 14) delete hist.days[keys.shift()];
    qzoneWriteHist(hist);
  }
  return hist.days[day];
}
function qzoneMaybePost() {
  const q = (cfg && cfg.qzone) || {};
  if (q.enabled === false || (q.post && q.post.enabled === false)) return;
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour < 10 || hour > 23.5) return;           // 半夜不发，人类也不发
  const hist = qzoneReadHist();
  const today = qzoneTodayPlan(hist);
  if (today.done >= today.plan) return;           // 今天额度用完了
  if (Date.now() - (Number(today.lastAt) || 0) < 3 * 3600 * 1000) return;  // 两条至少隔 3 小时
  core.qzoneDynPost().then(gen => {
    // 2026-11-17 主人令：每次生成都留档（发没发成都留）——她要回看「她收到了什么提示词、做了什么思考」。
    // 记录走 src/selfpost.js（唯一存放），不在这里另拼一份结构。
    const g = gen || {};
    const text = String(g.text || '');
    const rec = {
      plat: 'qzone', kind: 'post', text, prompt: g.prompt, think: g.think, model: g.model, ms: g.ms,
      note: g.note || '', from: 'qq.js/qzoneMaybePost',
    };
    if (!text) {
      selfpost.add(Object.assign({}, rec, { ok: false, err: '没写像，这轮不发' }));
      return console.log('[空间] 今天想发的没写像，这轮先不发');   // 不硬凑
    }
    runStroll(qzoneArgs(['--post', text]), (r) => {
      if (r && r.ok && r.posted) {
        const h2 = qzoneReadHist();
        const td = (h2.days = h2.days || {})[qzoneDayKey()] || (h2.days[qzoneDayKey()] = { plan: today.plan, done: 0, lastAt: 0 });
        td.done += 1;
        td.lastAt = Date.now();
        qzoneWriteHist(h2);
        console.log('[空间] 发了条自己的动态：' + text.slice(0, 40));
        selfpost.add(Object.assign({}, rec, { ok: true, tid: String((r && r.tid) || '') }));
        botWrite('data/qzone-stroll.jsonl', 'QQ空间发动态', text.slice(0, 80));
      } else {
        console.log('[空间] 发动态失败：' + ((r && r.error) || '未知'));
        selfpost.add(Object.assign({}, rec, { ok: false, err: String((r && r.error) || '未知名错误') }));
      }
    });
  }).catch(e => console.log('[空间] 发动态生成失败：' + e.message));
}
/* 直接把一段字发成说说（日记同步到空间走这里）。
 * 和 qzoneMaybePost 的分工：那个是「她平时自己想起来发一条」，要判额度/时段/去重；
 * 这个是「主人已经点头了，就要发出去」，不判额度不问时段，失败只报错不静默。 */
function qzonePostText(text) {
  return new Promise(resolve => {
    const t = String(text || '').trim();
    if (!t) return resolve({ ok: false, error: '没内容' });
    runStroll(qzoneArgs(['--post', t]), (r) => {
      if (r && r.ok && r.posted) {
        botWrite('data/qzone-stroll.jsonl', 'QQ空间发动态', t.slice(0, 80));
        return resolve({ ok: true, tid: String((r && r.tid) || '') });
      }
      resolve({ ok: false, error: String((r && r.error) || '未知') });
    });
  });
}
// 【分类 D1·平台功能(QQ空间)】空间定时逛街的启停调度：仅 QQ 空间。
function startQzone() {
  const q = (cfg && cfg.qzone) || {};
  if (q.enabled === false) return;
  const hours = Number(q.everyHours || 3);
  setTimeout(() => {                       // 启动 3 分钟后逛第一次（等连接稳了）
    qzoneStroll(false);
    qzoneMaybePost();                      // 发不发、发几条由当天计划说了算
    setInterval(() => { qzoneStroll(false); qzoneMaybePost(); }, hours * 3600 * 1000);
    // 逛人物列表的空间留评论（主人 2026-11-17）。
    // 启动时读一次频率就按它跑，不做轮询（她 07:30：有重启后端入口，别为改个间隔吃 CPU）。
    // 面板上改了频率 → 点「重启后端」生效；额度/限额仍在 runOnce 里判。
    const fc = qc.confOf(cfg);
    if (fc.enabled) {
      setTimeout(() => qzoneFriendStroll(false).catch(() => {}), 90 * 1000);
      // 间隔就用上面那个 hours（同一个 qzone.everyHours），不另读一份
      setInterval(() => qzoneFriendStroll(false).catch(() => {}), hours * 3600 * 1000);
    }
  }, 3 * 60 * 1000);
}

// ===== 需求记录（主人 2026-10-22 晚定）：她提的需求原文第一时间落 data/requests.jsonl =====
// 落盘的目的：以前需求只留在对话里，翻 66MB 记录才能找回来——现在「需求：xxx」私聊一发就存原文。
const REQ_PATH = path.join(__dirname, '..', 'data', 'requests.jsonl');
function reqLog(text, src) {
  try {
    fs.appendFileSync(REQ_PATH, JSON.stringify({ t: new Date().toISOString(), src: src || 'qq私聊', text: String(text || '').slice(0, 500) }) + '\n', 'utf8');
    botWrite('data/requests.jsonl', '需求记录', String(text || '').slice(0, 60));
  } catch {}
}

// ===== 一键记梗（主人 2026-10-22 晚定）=====
// 用法：**引用群友那条消息**，发「记梗：解释」或「记梗 梗名：解释」。
// 入库：群友的原话自动变「举例」；引用原话 + 群上(10)下(3)（全项目统一口径）自动存「上下文」；
//       主人的解释就是「是什么」；梗名没写就取原话前 12 字。
// 【分类 F·全场景通用｜入口在QQ群】一键记梗：写进梗库（F 知识层），只是从 QQ 引用消息触发。
function jiMeng(ev, o, content) {
  const ro = o.replyOrigin || {};
  const raw = String(ro.full || ro.frag || '').replace(/@\d+\s*/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, msg: '要先把群友那条消息引用（回复）进来呀，不然我不知道记的是哪句' };
  let body = String(content || '').trim().replace(/^记梗[:：]?\s*/, '');
  let title = '', meaning = '';
  const m = body.match(/^([^：:]{1,16})[:：]\s*([\s\S]+)$/);
  if (m) { title = m[1].trim(); meaning = m[2].trim(); } else { meaning = body.trim(); }
  if (!meaning) return { ok: false, msg: '解释还没写呢——「记梗 梗名：这个梗是说…」这样发' };
  if (!title) title = raw.slice(0, 12).replace(/[，。！？、\s]+$/, '');
  const words = [];
  const w1 = raw.slice(0, 20).trim();
  if (w1 && w1 !== title) words.push(w1);
  if (title && words.indexOf(title) < 0) words.push(title);
  // 上下文：群上(10)下(3)——统一口径（主人 2026-10-22 定：所有涉及聊天记录的都用这个，不再重复）
  let ctx = '原话：' + (ro.nick || '群友') + '：' + raw;
  try {
    const arr = instantLog('g' + ev.group_id, 60);
    const tNow = arr.length ? arr[arr.length - 1].t : Date.now();
    const pre = arr.filter(x => x.t <= tNow && !x.bot).slice(-10);
    const post = arr.filter(x => x.t > tNow && !x.bot).slice(0, 3);
    const cs = pre.concat(post).map(x => uidTag(x.uid, x.nick, true) + '：' + x.text).join(' / ');
    if (cs) ctx += ' ｜当时群里：' + cs;
  } catch {}
  ctx = ctx.slice(0, 300);
  const r = guides.memeAdd({ title, words, meaning, ctx, ex: '「' + raw + '」' });
  if (r.error) return { ok: false, msg: '没记成：' + r.error };
  botWrite('data/网络热梗.md', '一键记梗', '「' + title + '」（原话：' + raw.slice(0, 30) + '）');
  console.log('[记梗] 入库「' + title + '」：' + meaning.slice(0, 40));
  return { ok: true, msg: '记好了：「' + title + '」。他的原话自动当了举例，你的解释和当时的上下文都写进去了（面板「网络热梗」里能改）。' };
}

function start(config) {
  cfg = config;
  pauseCtl.init(config);          // 暂停/允许（主人 2026-10-23 定）：数据在 data/pause.json，重启不丢
  // 把「撤回」接到指令层（2026-11-19 主人私聊说过「撤回群里这句」）：
  // nl-command 不 require 本文件（会循环），由这里注册回调。
  try { nlCommand.setRecaller(recallSent); } catch (e) { console.log('[指令] 撤回没接上：' + e.message); }
  core.setRegionResolver(lookupRegion);
  // 自动搬屎（2026-11-21）：注入 callApi/cfgLive。callApi 回包带 .data，模块内部两种都兼容。
  // 默认关闭、源/目标群空，配好 config/features.json 的 movePoop 段才动。
  try {
    movePoop.start({
      callApi: (action, params, timeout) => callApi(action, params, timeout || 4000),
      cfgLive: () => cfgLive(),
      cacheFile: path.join(__dirname, '..', 'data', 'move-poop-cache.json'),
    });
  } catch (e) { console.log('[搬屎] 启动失败：' + e.message); }
  // 优质屎（2026-11-24）：注入 cfgLive；publisher.js require 的是同一实例，isPremium 共用台账与配置。
  try {
    poopQuality.start({
      cfgLive: () => cfgLive(),
      dataFile: path.join(__dirname, '..', 'data', 'poop-quality.json'),
    });
  } catch (e) { console.log('[优质屎] 启动失败：' + e.message); }
  stickerRenamePass();            // 启动时把老表情包的「图中有/量词/md5」名字洗一遍（主人 2026-10-22 定）
  try { stickerReconcile(); } catch (e) { console.log('[对账] 失败：' + e.message); }  // 清失效场合 / 改名搬场合 / 列待补（2026-10-30 主人定）
  startQzone();                   // QQ 真动态：每 3 小时逛一次、挑喜欢的转走（主人 2026-10-22 定）
  greetOnii();                    // 每天上线第一件事：昨日数据日报 → 发主人群 @ 我（2026-11-24 主人令）
  reportOnii();                   // 每天的汇报：每天第一次上线发一次，她自己的口吻说主人努力的成果 → 发欧尼酱
  markActive();                   // 记录「最后一次活动」时间（日报已不读它，保留给别处/面板）
  statusHeartbeat();              // v76：每分钟刷一次在线时间戳，免得自查把「太久没说话」当成「连接卡死」
  // 上线日报：每分钟检查一次，0 点换天后第一次在线就发（不在线则等上线那一刻）。
  setInterval(() => { if (curStatus.online) greetOnii(); }, 60 * 1000);
  // 定时保健提醒（主人 2026-11-09/10 定）：模块只算「几点、说哪句、@谁」，发送仍走这里现成的
  // buildAtSegments + sendAction（@ 段、群禁言总闸、发送回执自动重发全都不绕过）。
  // QQ 没连上就返回 false，模块不会把这一条标成「已发」，等连上后下一跳重发，避免漏掉。
  healthRemind.start({
    send: (gid, body) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[保健提醒] QQ 还没连上，这条先不标已发，等下一跳重试');
        return false;
      }
      const segs = buildAtSegments(body);
      sendAction('send_group_msg', { group_id: Number(gid), message: segs || body });
      core.logLine('qq', '', '[保健提醒] ' + body, true, '群' + gid);
      // 她刚发过这句 → 记进这个群的对话历史，但打上「[定时保健提醒]」标记（主人 2026-11-21 定）：
      // 这是系统定时提醒，不是她在对话里说的话。不打标记模型会当成自己随口说的内容，拿来当话题接。
      try {
        const said = String(body).replace(/@\d+/g, '').trim();
        if (said) core.pushHist(core.histKey('qq', gid), 'assistant', '[定时保健提醒] ' + said, cfg.botName || '虚幻');
      } catch {}
      return true;
    },
    // 断线时不去生成：一条提醒 = 一次真模型调用，等在线的下一跳再补（不标已发）
    ready: () => !!(ws && ws.readyState === WebSocket.OPEN),
    say: o => healthSay(o),
    // 每天排几次＝昨天真改过几个模块（与每日汇报 collectReportTitles 同一份统计，主人 2026-11-23 定）。
    // 一天读一次（0 点日切时），不跟着 1 秒轮询反复扫目录。
    countChanges: (fromMs, toMs) => collectReportTitles(new Date(toMs), fromMs, toMs).length,
  });
  // 闹钟（2026-11-24 主人定）：到点把承诺兑现发回原来的群/人，走同一个发送出口（@ 段/禁言闸/回执重发都在）。
  // scope 里记了群号或私聊对象；发成功才标 done，没连上/没回执就不标，等下一跳在超时窗内补。
  alarms.start({
    send: (sc, body) => new Promise(resolve => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(false);
      const s = sc || {};
      const isPrivate = s.platform === 'qq' && String(s.scope || '').indexOf('私聊') === 0;
      const uid = Number(s.userId) || 0;
      const gid = Number(s.groupId) || 0;
      if (isPrivate && !uid) return resolve(false);
      if (!isPrivate && !gid) return resolve(false);
      let settled = false;
      const done = (ok, why) => {
        if (settled) return;
        settled = true;
        if (ok) {
          const where = isPrivate ? ('私聊' + uid) : ('群' + gid);
          core.logLine('qq', '', '[闹钟] ' + body, true, where, { to: s.who || '' });
        } else console.log('[闹钟] 没发出去（' + (why || '未知') + '），超时窗内接着补');
        resolve(!!ok);
      };
      let segs = null;
      try { if (!isPrivate) segs = buildAtSegments(body); } catch (e) {}
      const action = isPrivate ? 'send_private_msg' : 'send_group_msg';
      const params = isPrivate
        ? { user_id: uid, message: segs || body }
        : { group_id: gid, message: segs || body };
      const r = sendAction(action, params, { onResult: done });
      if (r === false) done(false, '被禁言/关群拦下');
      setTimeout(() => done(false, '等回包超时'), 40000);
    }),
    ready: () => !!(ws && ws.readyState === WebSocket.OPEN),
  });
  // 洛克王国远行商人（2026-11-21 主人定）：轮询公开数据源，本轮有棱镜球/祝福项坠/炫彩蛋就 @ 固定标签持有人。
  // 群里的 @ 不限粉丝/播放（主人同日定：「QQ不限制这个」）；稀有度只用来算 B站 那条线的每日额度。
  // @ 谁由 fixed-tags 现算，不在这里写死；发送仍走同一个 buildAtSegments + sendAction。
  rocoMerchant.start({
    // 发完要等回包才算成功（主人 2026-11-21 定：「发送失败了要 4 小时以内补，过时就不用发」）。
    // 没有回执就当没发，下一跳在时间窗内接着补；过了时间窗模块自己会放弃。
    send: (gid, body) => new Promise(resolve => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[远行商人] QQ 还没连上，这一轮先不标已处理');
        return resolve(false);
      }
      let settled = false;
      const done = (ok, why) => {
        if (settled) return;
        settled = true;
        if (!ok) {
          console.log('[远行商人] 没发成（' + (why || '未知') + '），这一轮不标已处理，时间窗内继续补');
          return resolve(false);
        }
        core.logLine('qq', '', '[远行商人] ' + body, true, '群' + gid);
        // 和保健提醒一样打标记：这是系统提醒，不是她在对话里说的话，别被当成她刚说过的话去接。
        try {
          const said = String(body).replace(/@\d+/g, '').trim();
          if (said) core.pushHist(core.histKey('qq', gid), 'assistant', '[远行商人] ' + said, cfg.botName || '虚幻');
        } catch {}
        resolve(true);
      };
      const segs = buildAtSegments(body);
      const r = sendAction('send_group_msg', { group_id: Number(gid), message: segs || body }, { onResult: done });
      if (r === false) done(false, '被禁言/关群拦下');
      setTimeout(() => done(false, '等回包超时'), 40000);
    }),
    ready: () => !!(ws && ws.readyState === WebSocket.OPEN),
  });
  // B站 评论区提醒（2026-11-21）：只在「棱镜球/祝福项坠/炫彩蛋轮次」被安排后跑；
  // 重启后若窗口还没结束，接着跑（状态在 data/roco-bili-state.json）。
  rocoBili.start();
  /* 资料卡不再定时拉（2026-11-22 她令：「下次 b站 说话时看到这个人变了再更新，QQ 也一样，
   * 不需要定时拉取」）。现在只在事件里更新：
   *   · 群消息 → saveCard 用事件里的群名片/资料卡覆盖
   *   · 私聊   → syncOneProfile（同一号 10 分钟一次，只在他说话时）
   *   · B站    → nick.nameForAccount 用事件昵称覆盖
   * syncProfilesOnce 还留着，面板/自测要手动全量刷新时可以调。 */
  connect();
}

// ===== 群友给她点表情回应 → 直接加星（主人 2026-10-22 定；2026-11-03 收进 core 统一口径）=====
// 这里只负责「取到消息正文」。免记录群不加星、key 算法与面板一致、语境回查，全在 core.stars* 里，
// 以前这三样各写一份，结果 28 条星标的 key 是 emoji+消息id，面板按 md5 算，永远对不上号。
const reactedSeen = new Set();
// 【分类 A·群专属】加表情自动加星 onEmojiLike：scope='群'+gid，仅群内。
/* 优质屎·展开搬运转发：AstrBot 把源群屎合并转发到目标群，走的是同一个 QQ 号，
 * NapCat 会以「自己发的群消息」推回这边（isSelfSowingForward 认的就是它）。
 * 展开转发拿正文 + 图片 key → poop-quality 记一条观察（mid = 目标群转发消息号）。
 * 只取文字和图 key，不识图、不调模型（零 token）。 */
async function noteSowForQuality(ev, forwards) {
  const textParts = [], imgKeys = [];
  for (const fid of (forwards || []).slice(0, 3)) {
    try {
      const r = await callApi('get_forward_msg', { message_id: fid }, 3000);
      if (!r || (r.retcode !== undefined && r.retcode !== 0)) continue;
      const d = (r && r.data) || {};
      const nodes = arrayField(d, ['messages', 'message']);
      for (const n of nodes) {
        const s = parseSegments(n);
        if (s.text) textParts.push(s.text);
        for (const im of (s.imgs || [])) {
          const k = poopQuality.imageKeyOf({ data: { file: im.file || '', url: im.url || '' } });
          if (k) imgKeys.push(k);
        }
      }
    } catch (e) { /* 单条展开失败不影响其它 */ }
  }
  poopQuality.noteSent({ mid: ev.message_id, text: textParts.join('\n'), imageKeys: imgKeys, at: Date.now() });
}

async function onEmojiLike(ev) {
  try {
    if (!ev.message_id) return;
    // 优质屎①：被点赞（虚幻搬到目标群的那条被群友点表情）。无论是不是加星都先判。
    try { poopQuality.hitByMid(ev.message_id, 'like'); } catch (e) {}
    const mid = String(ev.message_id);
    if (reactedSeen.has(mid)) return;
    reactedSeen.add(mid);
    if (reactedSeen.size > 800) reactedSeen.clear();
    const r = await callApi('get_msg', { message_id: ev.message_id }, 3000);
    const d = (r && r.data) || {};
    if (String((d.sender || {}).user_id || '') !== String(selfId || '')) return;   // 只加她自己说的消息
    const text = String((parseSegments(d).text || '')).replace(/\s+/g, ' ').trim();
    if (!text || /^\[?表情/.test(text)) return;
    const scope = '群' + ev.group_id;
    // 回查日志：拿到日志时间和「当时对方说了什么」。面板的星点要按日志时间才算得出来；
    // 学接话也要知道她是在接哪句——这两样都从这一处拿。
    const hit = core.starsFindLine(scope, text);
    const res = core.starsAdd({
      key: hit && hit.key, t: hit && hit.t, scope,
      nick: (cfg && cfg.botName) || '虚幻',
      text, prev: hit && hit.prev, prevNick: hit && hit.prevNick, by: 'emoji',
    });
    if (res === 'banned') return;      // 免记录群（赛博鱼塘）：那不算她陪人聊天，不学
    if (res === 'dup') return;
    console.log('[星标] 群友点了表情回应 → 自动加星：' + text.slice(0, 30));
    botWrite('data/chat-stars.json', '星标', '群友点表情回应 → 加星「' + text.slice(0, 40) + '」');
  } catch (e) { console.log('[星标] 加星失败：' + e.message); }
}

// ===== 每天上线第一件事：发**昨日数据日报**（2026-11-24 主人令：旧的上线播报没用且错）=====
// 数字全部来自各对象自己的记录（统计/渲染在 src/daily-stats.js，这里只发送）。
const GREET_PATH = path.join(__dirname, '..', 'data', 'greet.json');
const ACTIVE_PATH = path.join(__dirname, '..', 'data', 'onii-active.json');
let activeSavedAt = 0;
function markActive() {                        // 收到/发出消息都算「还在活动」（60 秒节流，别频繁写盘）
  const now = Date.now();
  if (now - activeSavedAt < 60000) return;
  activeSavedAt = now;
  try { fs.writeFileSync(ACTIVE_PATH, JSON.stringify({ t: now }), 'utf8'); } catch {}
}
// 【分类 B·测试专属】上线日报（昨日数据）：发主人，属测试汇报总集合。
function greetOnii() {
  try {
    if (!cfg.oniiQQ) return;
    if ((cfg.dailyReport || {}).enabled === false) return;   // 面板/配置里能直接关掉日报
    // 每天一次：按**自然日**算（本地日期，0 点换天）；当天在线就发，不在线就等上线那一刻。
    // 2026-11-24 主人令：旧播报的「离开多久/群里几句」没用且错（onii-active 被 60 秒节流、
    // 群里几句是全群全人乱数），整段删掉，换成「昨日数据日报」（统计在 src/daily-stats.js）。
    if (!ws || ws.readyState !== WebSocket.OPEN) return;     // 没连上不写 day，下一分钟自动重试
    const now = new Date();
    const day = now.getFullYear() + '-'
      + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0');
    let g = {}; try { g = JSON.parse(fs.readFileSync(GREET_PATH, 'utf8')) || {}; } catch {}
    if (g.day === day) return;                     // 今天已经发过，不重复
    let report = null;
    try {
      const drCfg = (cfgLive ? cfgLive() : cfg).dailyReport || {};
      // 留 40 字给「@主人 + 换行」，正文不超过平台上限
      const maxChars = Math.max(300, Number(drCfg.maxChars || 600) - 40);
      report = dailyStats.run({ now: now.getTime(), cfg: cfgLive ? cfgLive() : cfg, dry: true, maxChars });
    } catch (e) {
      console.log('[日报] 统计失败，不写 day，等下一跳重试：' + e.message);
      return;                                       // 不许「统计挂了也记成已发」
    }
    const text = String((report && report.text) || '').trim();
    if (!text) return;
    setTimeout(() => {                             // 等连接稳几秒再发
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 发送群跟保健提醒共用一处（features.json 的 healthRemind.groupId），换群只改那一处。
      const gid = healthRemind.targetGroup() || cfg.testGroup || 100000000;
      const body = '@' + (cfg.masterQQ || '') + '\n' + text;
      const segs = buildAtSegments(body);
      const r = sendAction('send_group_msg', { group_id: gid, message: segs || body });
      if (r === false) return;                       // 被禁言/关群拦下：不标已发，下一分钟再来
      try { dailyStats.writeSnapshot(report.stats.day, report.stats); } catch {}
      fs.writeFileSync(GREET_PATH, JSON.stringify({ day, at: new Date().toISOString() }), 'utf8');
      core.logLine('qq', '', '[日报] 在群' + gid + ' @主人发了昨日数据日报', true, '群' + gid);
      console.log('[日报] 已发：' + text.replace(/\n/g, ' | ').slice(0, 240));
    }, 8000);
  } catch (e) { console.log('[日报] 出错：' + e.message); }
}

// ===== 保健提醒的那一句话（她 2026-11-11 定）=====
// 原话：「给动作添加话术的形式不需要。如何说话应该由人设决定。提醒是必须的，但也需要当场一次普通的
// llm 发起的会话，而不是机器回话。」所以这里不写任何模板、不拼「在 X 分钟以后」——
// 走 core.buildMessages（人设 + 记忆 + 风格 + 硬限制）→ core.callLLM → core.polish，
// 和真回一条群消息是同一套。动作名由 health-remind.js 选好，这里只负责把它说成她的话。
// 用独立会话键（#健康提醒）：不覆盖群里正在进行的那个回合，也不会被当成「在回某个人」。
// 只读群历史做上下文，不写、不改任何状态；失败返回空串，由调用方重试或只发动作名。
async function healthSay(o) {
  const gid = Number(o && o.gid) || 0;
  const act = String((o && o.act) || '').trim();
  if (!gid || !act) return '';
  const k = core.histKey('qq', gid);
  const hk = k + '#健康提醒';
  core.setTurn(hk, { source: 'qq', uid: String(cfg.masterQQ || ''), gid, nick: '主人', isMaster: true });
  let recent = '';                                  // 群里刚才在聊什么（只读，让这句提醒接得上）
  try {
    const hs = core.getHist(k) || [];
    recent = hs.slice(-8).map(m => {
      const t = String(m.content || '').replace(/\s+/g, ' ').slice(0, 60);
      if (!t) return '';
      const who = m.who || (m.role === 'assistant' ? (cfg.botName || '虚幻') : '');
      return who ? who + '：' + t : t;
    }).filter(Boolean).join('\n');
  } catch {}
  const extra = [
    '这一轮没有人跟你说话。是你自己想起来，要在群里提醒他们活动一下身体。',
    '要提醒他们做的动作是「' + act + '」，只说这一个动作，别换成别的动作（比如说成另一个部位或者另一件事）。',
    // 她 2026-11-23：「『大概多久以后做』经常概率不触发，修好」。原来写「说不说随你」，
    // 模型当然经常不说。现在改成硬要求：时间必须出现；出口还会校验一次，缺了重生成。
    '这句话里必须带上「大概 ' + (Number(o.xMin) || 0) + ' 分钟以后做」这个时间——用你自己的话说出来（「过 ' + (Number(o.xMin) || 0) + ' 分钟左右再做」「等 ' + (Number(o.xMin) || 0) + ' 分钟再动」都行），但时间不能省，也不能只写「一会儿」「待会儿」糊过去。',
    '用你平时的语气说一句，像在群里随口提一句，不是在发通知。',
    '不要提「提醒」「定时」「任务」「系统」这类词，不要分条列点，不要解释为什么要做这个动作。',
    '不要复述、不要引用上面那句括号里的提示语——那句话不是给人看的。',
    '要说成一句完整的话，不能只把动作名抄一遍。',
    '最多两句话，短一点。',
    Number(o.attempt) > 0 ? '上一次那句不行（只回了动作名，或者没说清大概几分钟以后做）。这次一定是一句完整的话，而且带上「大概 ' + (Number(o.xMin) || 0) + ' 分钟以后做」这个时间。' : '',
    recent ? '群里刚才在聊（只当上下文，不用去回应它）：\n' + recent : '',
  ].filter(Boolean).join('\n');
  const cue = '（到点了：' + act + '）';
  const msgs = await core.buildMessages(hk, cue, extra);
  // buildMessages 只拼 system 块 + 历史；真回话路径里「用户那句」是历史里已经推过的那条。
  // 这里历史是空的，必须自己补一句 user，否则整串只有 system，模型会以「messages 参数非法」拒收。
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: cue });
  }
  const ans = String(core.polish(await core.callLLM(msgs, { tag: 'health' }), hk) || '').trim();
  // 出口校验（真事：第三次样本直接把「（到点了：沉肩且齐胯）」原样复述出来，那就是机器回话）。
  // 判为不能用的就返回空串，交给上层重试一次 / 最后只发动作名；宁短也不发一句念提示的。
  if (!ans) return '';
  if (/到点了/.test(ans) || /^[（(\[【]/.test(ans) || ans.length > 60) {
    console.log('[保健提醒] 这句不能用（像在念提示/带了括号/太长）：' + ans.slice(0, 40));
    return '';
  }
  // 只回了个动作名（真事：今天发出去的就是「提臀～」）——那不是说话，是机器报菜名。
  // 判空让上层带提示重生成一次；两次都不行就只发动作名（提醒不能不发）。
  const bare = ans.replace(/[\s，。、！？~～·,.!?…—\-"'“”‘’（）()]/g, '');
  if (bare === act.replace(/\s/g, '')) {
    console.log('[保健提醒] 这句不能用（只回了动作名）：' + ans);
    return '';
  }
  // 她 2026-11-23：「大概多久以后做」经常概率不出现，修好 → 出口强制校验，没时间就重生成。
  const when = Number(o.xMin) || 0;
  const hasWhen = /(\d+|[一二两三四五六七八九十半几]+)\s*(分钟|分|刻|小时|钟头|min)/i.test(ans);
  if (when > 0 && !hasWhen) {
    console.log('[保健提醒] 这句没带「大概多久以后做」：' + ans.slice(0, 40));
    return '';
  }
  return ans;
}

// ===== 真正的「汇报」（主人 2026-10-22 晚定）=====
// 这是**一次发言，不是日志搬运**：给心爱的欧尼酱看的，主人努力的成果。
// 她自己是汇报人，同时也是项目主体——用她自己的口吻说「主人今天把我教成了什么样」。
// 内容不求多但求简单精准：只取更新条目的标题（title 本来就是一句话），绝不贴 detail 正文。
// **一天一次**：按每天第一次上线算（存 day 判断），不是每次启动都发（主人 2026-10-22 傍晚纠正）。
const REPORT_PATH = path.join(__dirname, '..', 'data', 'onii-report.json');
// 汇报数据源（主人 2026-11-23 定）：她每天改的是「整个工作区 + AstrBot 插件 + DSH 插件」。
// 原来读 data/updates.jsonl，但那份从 2026-11-02 起停更、且全项目没有任何代码在写它，
// 导致汇报永远走「主人今天没改我」。改成扫这三处当天(mtime)真改过的文件。
// 【分类 B·测试专属】每日汇报（她口吻说主人今天把她教成啥样）：发欧尼酱，测试汇报总集合。

// 要扫的三个根（DSH 插件是 astrbot 插件目录里 persona_share 的软链，已在第二项覆盖，不重复扫）
const REPORT_ROOTS = [
  { dir: path.join(__dirname, '..', '..'), label: '' },                    // xuhbot 工作区根
  { dir: '/Users/zhengbowen/.astrbot/data/plugins', label: '插件' },       // AstrBot 插件（含 DSH 软链）
];
// 只认「当天真改过的源文件」：跳过备份/日志/缓存/运行时数据/依赖/测试快照/二进制，
// 否则每天光是运行写的数据文件就把汇报刷满，反而看不出主人改了什么。
const REPORT_SKIP_DIR = /(^|[/\\])(node_modules|\.git|\.venv|__pycache__|dist|build|总备份|备份|bak|logs?|日志|data|cache|tmp|runtime|plugin_data|test-?results)([/\\]|$)/i;
const REPORT_SKIP_EXT = /\.(log|jsonl|bak|bak-.*|tmp|cache|pyc|swp|pid|lock|db|sqlite|zip|gz|png|jpe?g|gif|webp|pdf|mp4|ico|woff2?|ttf)$/i;
const REPORT_SKIP_FILE = /^\.|^~\$|^#|^\.DS_Store$|^package-lock\.json$/;
// 取「本地今天 00:00」的时间戳（北京时间）；mtime 是本地时间，不能用 UTC 切片比。
function reportDayStart(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
// 扫三个根，返回指定时间段内改过的「模块名」去重列表（相对根的第一段路径，如 app / src / 插件名）。
// fromMs/toMs 不传＝今天 0 点到 now（每日汇报的用法）；保健提醒要在 0 点结算「昨天整天」，所以支持传区间。
function collectReportTitles(now, fromMs, toMs) {
  const start = Number.isFinite(Number(fromMs)) ? Number(fromMs) : reportDayStart(now);
  const end = Number.isFinite(Number(toMs)) ? Number(toMs) : now.getTime();
  const titles = [];
  const seen = new Set();
  const walk = (dir, root, depth) => {
    if (depth > 8) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const name = ent.name;
      if (REPORT_SKIP_FILE.test(name)) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (!REPORT_SKIP_DIR.test('/' + name + '/')) walk(full, root, depth + 1);
        continue;
      }
      if (!ent.isFile() || REPORT_SKIP_EXT.test(name)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < start || st.mtimeMs > end) continue;
      // 相对「本根」的第一段＝模块名；根下散文件(如 package.json)不算模块，跳过。
      const rel = path.relative(root.dir, full);
      const parts = rel.split(/[/\\]/);
      if (parts.length < 2) continue;
      let mod = parts[0];
      if (root.label) mod = root.label + '·' + mod.replace(/^astrbot[-_]plugins?[-_]?/i, '');
      const clean = mod.replace(/^v\d+[：:]\s*/, '').replace(/\s+/g, ' ').trim();
      if (clean && !seen.has(clean)) { seen.add(clean); titles.push(clean); }
    }
  };
  for (const root of REPORT_ROOTS) walk(root.dir, root, 0);
  return titles;
}
function reportOnii() {
  try {
    if (!cfg.oniiQQ) return;
    const now = new Date();
    const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    let rep = {}; try { rep = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) || {}; } catch {}
    if (rep.day === today) return;                  // 今天已经汇报过，一天就这一次
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ day: today, at: now.toISOString() }), 'utf8');
    // 今天(本地日)mtime 真改过的模块；只说模块名，不贴正文、不编内容。
    const titles = collectReportTitles(now);
    let line;
    if (titles.length >= 2) line = '欧尼酱，主人今天又为了我忙前忙后——' + titles.join('；还有，') + '。都是他努力的成果，我都学好啦，嘻嘻';
    else if (titles.length === 1) line = '欧尼酱，主人今天把我教得更好了：' + titles[0] + '。她的努力我可记着呢，嘻嘻';
    else line = '欧尼酱，我上线啦～主人今天没改我，我就乖乖陪着她，嘻嘻';
    // 字数护栏：超了就丢最旧的标题重说，绝不硬截半句（简单精准，不超字数）
    while (line.length > 100 && titles.length > 1) {
      titles.shift();
      line = '欧尼酱，主人今天把我教得更好了：' + titles.join('；还有，') + '。都是他努力的成果，嘻嘻';
    }
    setTimeout(() => {
      // 发到**测试群里** @ 欧尼酱（私聊他看不到她说了什么）
      // 她 2026-11-23：「把每日上线提醒也改到这个群」→ 跟保健提醒共用一个群号
      // （features.json 的 healthRemind.groupId），以后换群只改那一处。
      const gid = healthRemind.targetGroup() || cfg.testGroup || 100000000;
      const body = '@' + cfg.oniiQQ + ' ' + line;
      const segs = buildAtSegments(body);
      sendAction('send_group_msg', { group_id: gid, message: segs || body });
      core.logLine('qq', '', '[汇报] 在群' + gid + ' @欧尼酱发了今天的汇报「' + line + '」', true, '群' + gid);
      console.log('[汇报] 在群' + gid + '给欧尼酱发了今天的汇报');
    }, 12000);                                      // 比日报晚一点，两条不挤在一起
  } catch {}
}

/* ===== 平台改版追踪（2026-11-17 主人令）=====
 * 读 NapCat 版本号：get_version_info → data.app_version（实测 4.18.41）。
 * 这是框架版本，不是 QQ 客户端版本（主人选的就是读 NapCat），如实标注。
 * 读不到返回空串，auto-reprobe 会跳过、不判变化。 */
// 【分类 B·测试专属】平台改版追踪：读版本/自动重测/上报主人，全场景测试汇报类，非回话规则。
async function readNapcatVersion() {
  try {
    const ev = await callApi('get_version_info', {}, 4000);
    const v = ev && ev.data && ev.data.app_version;
    return v ? String(v) : '';
  } catch { return ''; }
}

/* 自动重测 QQ 聊天上限：往主人私信裸发测试串，二分逼近，写回上限表。
 * 手动「测上限」命令和版本变化自动重测都走这里，只有一份。
 * notify(text) 用来把结果告诉主人（手动=replyTo，自动=sendPrivate）。 */
async function probeQQChat(masterUid, notify) {
  const uid = String(masterUid || cfg.masterQQ || '');
  if (!uid) return { ok: false, error: '没主人 QQ 号，测试场找不到' };
  const cur = platLimits.capOf('qq') || 600;
  const sender = async (body) => {
    try { await callApi('send_private_msg', { user_id: uid, message: body }, 8000); return { ok: true }; }
    catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  };
  const r = await limitProbe.probe(sender, cur, 200, { max: 20000 });
  if (!r.ok) { try { notify && notify('测上限没跑起来：' + (r.error || '未知')); } catch {} return r; }
  const w = limitProbe.commit('qq', r);
  const msg = 'QQ 上限测完了：实测最多 ' + r.cap + ' 字（发了 ' + r.sends + ' 条测试串，'
    + (r.shrunk ? '比原来小，上限缩了' : '比原来大') + '）。'
    + (w.ok ? '已经记下，以后默认和手填都按这个数。' : '写回失败：' + w.error);
  try { notify && notify(msg); } catch {}
  core.logLine('qq', '', '[测上限] 结果：' + r.cap + ' 字，' + r.sends + ' 次，' + (r.shrunk ? '缩减' : '增长'), true, '');
  return { ok: true, cap: r.cap, sends: r.sends, shrunk: r.shrunk, write: w };
}

/* 自动重测 QQ 动态上限：发测试说说 → 拿 tid → 自删，二分逼近。每条自删（python --post-probe）。 */
async function probeQzone(notify) {
  const cur = platLimits.capOf('qzone');   // 0 = 还没实测过（原来这里 fallback 的 60 是我拍的，已删）
  const probeOne = (len) => new Promise(resolve => {
    runStroll(qzoneArgs(['--post-probe', '虚'.repeat(len)]), (r) => {
      resolve(!!(r && r.ok && r.deleted));
    });
  });
  let best = 1, lo = 1, hi = Math.max(cur * 4, 200), sends = 0;
  // 没记录值就别拿 0 去试（发空说说必失败、还会把 hi 算成 -1，整轮测不出来）——
  // 直接从 1~200 二分。
  if (cur > 0) {
    if (await probeOne(cur)) { best = cur; sends++; lo = cur + 1; hi = Math.max(hi, cur * 4); }
    else { hi = cur - 1; sends++; }
  }
  for (let i = 0; i < 4 && sends < 6; i++) {
    const mid = Math.min(10000, Math.floor((lo + hi) / 2));
    if (mid <= 0) break;
    const ok = await probeOne(mid); sends++;
    if (ok) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    if (hi < lo) break;
  }
  const cap = Math.max(1, best);
  const w = limitProbe.commit('qzone', { ok: true, cap });
  const msg = 'QQ 动态上限测完了：实测最多 ' + cap + ' 字（发了 ' + sends + ' 条测试说说，都删了）。'
    + (w.ok ? '已经记下。动态日常文案还是 40/60 字短文案，不受这个上限影响。' : '写回失败：' + w.error);
  try { notify && notify(msg); } catch {}
  core.logLine('qq', '', '[测上限] 动态结果：' + cap + ' 字，' + sends + ' 条', true, '');
  return { ok: true, cap, sends, write: w };
}

async function onMessage(ev) {
  const seg0 = parseSegments(ev);
  let { text, atMe, imgs, videos, atOthers, forwards } = seg0;
  /* 客户端发来的图/视频（2026-11-23 主人令「客户端能发图片视频文件」）：
   * 它们是本机文件，没有 QQ 图床 url → 由 describeImgs 的 localPath 分支直接读盘识图。
   * 走的是同一个 onMessage，所以合并窗口、主人必回复、落盘、学习一条都不少。 */
  if (ev && Array.isArray(ev._clientImgs) && ev._clientImgs.length) imgs = imgs.concat(ev._clientImgs);
  if (ev && Array.isArray(ev._clientVideos) && ev._clientVideos.length) videos = videos.concat(ev._clientVideos);
  const sowingSelf = isSelfSowingForward(ev, forwards);
  let replyId = seg0.replyId || '';    // 可能被下面的「残留引用校验」清空
  // 「真@她」和「引用她的话」要分开记（主人 2026-10-23）：
  // 真@ = 有人点名喊她；引用她 = 直接接她的话。主人引用她的话时回复**不用 @**（她就在回你），
  // 只有真被点名喊了才保留「超时必 @」（那时候 @ 一下是提醒主人「这句回你的」）。
  const atMeReal = !!atMe;
  // 这条消息 @ 的是「除她以外的别人」→ 那是对别人说的（主人 2026-10-23：这种不许录进约定/记忆）
  const atOtherPerson = (atOthers || []).some(q => String(q) !== String(selfId));
  if (!text && !(imgs && imgs.length) && !(forwards && forwards.length)
    && !(replyId && isMasterUid(ev.user_id))) return;   // 主人引用消息发空格也放行：可能是「引用 AI 判定通知改回人物」
  rememberMsgId(ev, text);        // 撤回时靠 message_id 找回这句话
  // 免记录群（config/features.json 的 noRecordGroups，默认赛博鱼塘 100000000）：
  // 主人 2026-11-07 定「鱼塘的人物以后都不要记录，只拿来看聊天效果」。
  // 这里提前算一次，好让下面「补昵称→号、比头像」这类人物信息也一起跳过；
  // 后面那处 noRec 复用同一个值，不再各自重算。
  // 主人 2026-11-13 定：「照常记录我」= 只要有我触发，这个群一切照常记（人物画像/好感/喜恶/约定/首见/纠正全算）。
  // 免记录群只对「别人」生效——她自己说话时 noRec 一律当 false，闸门原样保留给别人用。
  const noRecGroup = ev.message_type !== 'private'
    && ((core.readConfigFresh().noRecordGroups || []).map(Number).indexOf(Number(ev.group_id)) >= 0);
  const noRec = noRecGroup && !isMasterUid(ev.user_id);
  if (!noRec && !sowingSelf) noteQqMeta(ev);   // 补昵称→QQ号 + 比头像 hash（搬屎转发是本号，不写人物资料卡）
  /* ===== AI 账号（2026-11-21 主人定）=====
   * 名字里带关键词的账号判为 AI：只建档、记 nick/群名片，不写任何画像/判定/记录，好感恒 0。
   * 判定只用「真实名字」：people 已存的 nick + 各群群名片，加本条消息带来的资料卡名/群名片。
   * 主人本人一律不判。用 peopleLib 而不是 people —— 本函数后面（4271）有个局部 const people = cfg.people 会遮蔽模块名。 */
  const aiUserId = String(ev.user_id || '');
  let aiLevel = '', aiHitName = '';
  if (aiUserId && !isMasterUid(aiUserId)) {
    const peopleLib = require('../people');
    const pm = (() => { try { return peopleLib.getByAccount('qq', aiUserId); } catch { return null; } })();
    const acc = pm ? (pm.accounts || []).find(a => String(a.platform) === 'qq' && String(a.id) === aiUserId) : null;
    const nm = [];
    if (acc && acc.nick) nm.push(acc.nick);
    if (acc && acc.cards) for (const g of Object.keys(acc.cards)) if (acc.cards[g]) nm.push(acc.cards[g]);
    if (ev.sender && ev.sender.nickname) nm.push(ev.sender.nickname);
    if (ev.sender && ev.sender.card) nm.push(ev.sender.card);
    for (const n of nm) {
      const lv = aiMark.classifyName(n);
      if (lv && (!aiLevel || aiMark.RANK[lv] > aiMark.RANK[aiLevel])) { aiLevel = lv; aiHitName = String(n); }
    }
    if (aiLevel && !aiMark.isExempt('qq', aiUserId)) {
      const prev = aiMark.recOf('qq', aiUserId) || {};
      // 只在「首次 / 档位变了」时落盘 + 锁好感：AI 每条消息都判一次，不能每条都写盘
      if (!prev.level || prev.level !== aiLevel) {
        aiMark.mark('qq', aiUserId, aiLevel, { name: aiHitName, src: 'auto', by: 'auto' });
        // 好感恒定 0：锁住 + 清 0（favorLock 挡住群里加分 / 学习衰减；面板手动仍可改）
        if (pm && pm.pid) { try { peopleLib.setFavorLock(pm.pid, true); peopleLib.setFavor(pm.pid, 0, { force: true }); } catch {} }
      }
      // t1 / t2 首次判到 → 私信主人（t0 绝对，不报）。
      // t1 还要先看注册时间（2026-11-21 07:44 主人令）：新号直接标、不报；只有老号跟 t2 一起报。
      // 取注册时间要发 NapCat 接口，不能挡回话 → setImmediate 丢到下一轮跑。
      if (aiLevel !== 't0' && !prev.reported && !prev.silent && ev.message_type !== 'private') {
        const _u = aiUserId, _l = aiLevel, _n = aiHitName, _pm2 = pm;
        setImmediate(() => { aiReport(_u, _l, _n, _pm2).catch(() => {}); });
      }
    }
  }
  const aiUser = !!aiLevel && !aiMark.isExempt('qq', aiUserId);
  // 画像类录入统一闸：免记录群 OR AI 账号 → 跳过一切画像/判定/学习（记名字/群名片的两处不拦，见下 4055/4275）
  const skipRec = noRec || aiUser;
  // 斜杠开头的 = 命令（/点歌、/cf …）：归 AstrBot 的插件管，这边不接（2026-11-05）。
  // 为什么：NapCat 现在同时喂 AstrBot（6199）和这边（3001），命令要是两边都应，
  // 群里就会一条消息回两遍——她最烦的双份。闲聊归这边，命令归那边，一人一半。
  if (/^\s*\//.test(text)) return;
  // 链接理解（v78）先起个头：和图片翻译并行跑，主人发「图+链接」时不用等两遍
  const linkP = /https?:\/\//i.test(text) ? websearch.linkBlock(text).catch(() => '') : Promise.resolve('');
  // 群禁言（2026-11-05 她定）：自己在群里被禁言 → 图不必翻译（翻译要调模型，白花钱），
  // 只把文字记进聊天记录，后面一道闸再统一拦住「回话」。这里只读本地缓存，不发请求、不拖慢。
  const mutedHere = ev.message_type !== 'private' && botMuted(ev.group_id);
  if (ev.message_type !== 'private') ensureMuteKnown(ev.group_id);
  /* 视频/视频链接（主人 2026-11-22 定）：
   *   有明确指令（查看/看看/看完/分析这个视频…）或「笑点解析」→ 看全部（全部字幕 + 全部可截帧数）；
   *   没有指令 → 默认 3 帧 + 字幕前 60 字。
   *   链接里是视频（B站/YouTube/抖音/…/论坛帖里的 <video>）→ 抓下来真看，不只是读标题。1 条消息只翻 1 个链接。 */
  const vMode = (video.wantsFull(text) || /笑点解析/.test(text)) ? 'full' : 'brief';
  // 只有「本来就是视频站」或「普通页面但消息里明说要视频」才当视频链接处理：
  // 否则群里发个普通网页也要抓 8 秒 HTML，白慢一轮。
  const isVideoCandidate = (u, src) => {
    const k = video.linkKind(u);
    if (!k) return false;
    if (k !== 'forum') return true;
    return /视频|片段|录屏|录像|看看|查看|看完|视频里|视频中/.test(String(src || ''));
  };
  const videoUrl = (() => {
    const us = String(text || '').match(/https?:\/\/[^\s，。！？、）)】」'"<>]+/g) || [];
    return us.find(u => isVideoCandidate(u, text)) || '';
  })();
  const videoLinkP = (videoUrl && !mutedHere)
    ? video.describe({ link: videoUrl }, { mode: vMode }).catch(() => '')
    : Promise.resolve('');
  // 图片先翻译再记录（主人 2026-10-22）：聊天记录、话题、给模型的上下文里都要有「图上是什么」。
  // 机器人群友的消息也会走到这里——无所谓，翻译了也只是记录，不接话（下面 isBotUser 挡着）。
  if (imgs && imgs.length && !mutedHere) {
    // 先把证据留下：图片到底有没有进来、NapCat 给的是 url 还是光一个 file（主人 2026-10-22 问「为什么还是看不见图」）
    console.log('[img] 收到图 ' + imgs.length + ' 张：'
      + imgs.map(x => String((x && (x.url || x.file)) || '(空)').slice(0, 70)).join(' | '));
    // 图库指纹可能缺新图（她刚丢进文件夹的）→ 后台增量补，不挡这一轮（这一轮认不出就走视觉模型）
    stickerLibRefresh();
    const seen = await describeImgs(imgs);
    const descs = seen.descs || [];
    if (descs.some(Boolean)) {
      let di = 0;
      text = text.replace(/\[图片\]/g, () => {
        const d = descs[di++] || '';
        return d ? '［图：' + d + '］' : '[图片]';
      });
    }
    // 表情包自动收集（主人 2026-10-22）：小图后台收，不阻塞消息链；desc 对得上 imgs 顺序（slots 可能稀疏）
    // 命中图库的那张不用再收（本来就在库里，收了也只会被去重挡回来）
    imgs.forEach((im, i) => { if (descs[i] && !seen.lib[i]) collectSticker(im, descs[i], ev).catch(() => {}); });
  }
  /* 视频（主人 2026-11-22 定）：默认只看「字幕前 60 字 + 每 8 秒一帧、共 3 帧」。
   * 多段视频只翻第一个（一天发一串视频时全翻会把回话拖到几十秒）；其余保留 [视频] 占位。
   * 失败一律降级成 ［视频：没看出内容］，绝不抛错挡回话。禁言群不翻（和白烧模型同一个道理）。 */
  if (videos && videos.length && !mutedHere) {
    const t0 = Date.now();
    const vt = await video.describe(videos[0], { mode: vMode, callApi: (name, args, ms) => callApi(name, args, ms) });
    const hit = text.indexOf('[视频]');
    text = hit >= 0 ? text.slice(0, hit) + vt + text.slice(hit + 4) : (text ? text + ' ' + vt : vt);
    try { keepVideoRef(ev, text, videos[0]); } catch {}
    console.log('[video] 收到视频 ' + videos.length + ' 段｜mode=' + vMode + '｜' + (Date.now() - t0) + 'ms｜' + String(vt).slice(0, 120));
  } else if (videos && videos.length) {
    text = text.replace('[视频]', '［视频：没看（这条不翻）］');
  }
  // 视频链接里的视频（若有）：等上面那条链跑完，再把「她真看了什么」并进这条消息
  if (videoUrl) {
    const t1 = Date.now();
    let lvt = '';
    try { lvt = await videoLinkP; } catch { lvt = ''; }
    if (lvt) {
      text = (text ? text + ' ' : '') + lvt;
      console.log('[video] 链接『' + videoUrl.slice(0, 70) + '』｜mode=' + vMode + '｜' + (Date.now() - t1) + 'ms｜' + String(lvt).slice(0, 120));
    } else {
      console.log('[video] 链接『' + videoUrl.slice(0, 70) + '』没看出视频（只用标题/简介）');
    }
  }
  // 秒回判定：对方「引用回复」了机器人的消息 → 等同 @她，直接触发回复（不等说完）。
  // 反过来，引用的是**别人的**消息 → 他们在互聊，她不许插话（主人 2026-10-22：群友@别人时不要回复）
  // 链接理解（v78）：主人发网址时她以前只看见一串字符（截图真事：两个链接 → 硬扯《白色相簿2》）。
  // 上面已经起头并行抓了，这里收结果；抓不到就明确写「打不开」，不许拿记忆硬套。
  let linkNote = '';
  try { linkNote = await linkP; } catch (e) { console.log('[link] ' + e.message); }
  let replyOther = false;
  // 学习第一优先（主人 2026-10-22）：**主人**引用/回复别人的消息 → 把「她在回哪句」当上下文一起学
  let masterLearn = null;
  // 回复溯源（主人 2026-10-22）：带引用的消息在聊天记录里记下「回复谁、原话是什么」，
  // 面板点一下能定位原消息——像 QQ 里点引用跳原文那样
  let replyOrigin = null;
  const isMasterMsg = isMasterUid(ev.user_id);
  /* 原说话人（2026-11-22 主人定）：群友 @ 她同时又引用别人时，也要能看到被引用那条，
   * 否则「引用当前说话人 / 引用原说话人」根本无从判断。私聊非主人保持原口径，不多打接口。 */
  if (replyId && (ev.message_type !== 'private' || !atMe || isMasterMsg)) {
    try {
      const r = await callApi('get_msg', { message_id: replyId }, 2500);
      const d = r.data || {};
      const s = d.sender || {};
      // 被引用那条里的图也要翻译（主人 2026-11-09 定）：以前只取文字，图只剩「[图片]」四个字，
      // 模型没东西可答，就转去回答提示词里的身份纠偏 → 00:06:31 那句「我刚才说了什么」。
      // 复用当前消息那条现成的图片翻译链路 describeImgs（图库命中就不调视觉模型），不另起一套。
      const qSeg = parseSegments(d);
      let qText = String(qSeg.text || '').replace(/↩/g, '');
      let blindImg = false;
      let quoteText = '';       // 被引用那条里「除了图之外」的字，有字就能接（主人 2026-11-09 补）
      // 两层引用：被引用那条自己也是「引用回复」时，要看的图在**第二层**引用里，
      // parseSegments 只解当前这条 → 图是空的，模型手里一张图都没有。
      // 这里再取一层：第二层有图就补进来；两层都取不到图 → 标 blindImg，按「图没判出」处理，不许瞎编。
      if ((!qSeg.imgs || !qSeg.imgs.length) && qSeg.replyId) {
        try {
          const r2 = await callApi('get_msg', { message_id: qSeg.replyId }, 2500);
          const d2 = r2.data || {};
          const qSeg2 = parseSegments(d2);
          if (qSeg2.imgs && qSeg2.imgs.length) {
            qSeg.imgs = qSeg2.imgs;
            const t2 = String(qSeg2.text || '').replace(/↩/g, '').replace(/\[图片\]/g, '').trim();
            if (t2 && qText.indexOf(t2) < 0) qText = (qText ? qText + ' ' : '') + t2;
            console.log('[img] 两层引用：第二层取到 ' + qSeg2.imgs.length + ' 张图');
          } else {
            blindImg = true;   // 引用里套引用、两层都没有图 → 这轮没有图内容
            console.log('[img] 两层引用：第二层也没有图 → 按「图没判出」处理');
          }
        } catch (e) {
          blindImg = true;
          console.log('[img] 两层引用取图失败 → 按「图没判出」处理：' + e.message);
        }
      }
      if (qSeg.imgs && qSeg.imgs.length) {
        const qd = await describeImgs(qSeg.imgs);
        let di = 0;
        const hadSlot = /\[图片\]/.test(qText);
        qText = qText.replace(/\[图片\]/g, () => {
          const desc = String((qd.descs[di++] || '')).trim();
          return desc ? '（图上：' + desc + '）' : '（不可见图）';   // 没看清的图也别留 [图片] 占位，硬限制在代码（主人 2026-11-09）
        });
        // 图在第二层引用里时，第一层文本没有 [图片] 占位 → 描述要直接补在后面，否则翻译了也进不去
        if (!hadSlot) {
          const extra = qd.descs.map(x => String(x || '').trim()).filter(Boolean).join('；');
          qText = (qText ? qText + ' ' : '') + (extra ? '（图上：' + extra + '）' : '（不可见图）');
        }
        quoteText = String(qSeg.text || '').replace(/\[图片\]/g, '').replace(/@\d+/g, '').replace(/\s+/g, '').trim();
        // 一张图都没看清 = 这轮看不见图。还要不要开口，由 handleTurn 看「有没有文字可接」再定
        blindImg = !qd.descs.some(Boolean);
        if (blindImg) console.log('[img] 引用的图没看清');
      }
      /* 引用的那条是视频（主人 2026-11-22）：先按默认口径翻一遍（3 帧 + 字幕前 60 字），
       * 原件留着给笑点解析升级成全量。翻不出来就当没看见视频，不编内容。 */
      let qVideo = null;
      if (qSeg.videos && qSeg.videos.length) {
        qVideo = qSeg.videos[0];
        const vtxt = await video.describe(qVideo, { mode: vMode, callApi: (n, a, ms) => callApi(n, a, ms) });
        const hadV = /\[视频\]/.test(qText);
        qText = qText.replace('[视频]', vtxt);
        if (!hadV) qText = (qText ? qText + ' ' : '') + vtxt;
        console.log('[video] 引用的是视频（mode=' + vMode + '）→ ' + vtxt.slice(0, 120));
      }
      // 引用的那条里是**视频链接**（主人 2026-11-22）：同样抓下来看，失败就只留链接文字
      if (!qVideo) {
        const qUrl = (String(qText).match(/https?:\/\/[^\s，。！？、）)】」'"<>]+/g) || []).find(u => isVideoCandidate(u, qText));
        if (qUrl && !mutedHere) {
          const lvt = await video.describe({ link: qUrl }, { mode: vMode, callApi: (n, a, ms) => callApi(n, a, ms) });
          qText = (qText ? qText + ' ' : '') + lvt;
          console.log('[video] 引用的链接『' + qUrl.slice(0, 60) + '』（mode=' + vMode + '）→ ' + String(lvt).slice(0, 120));
        }
      }
      const qTime = Number(d.time || 0);      // get_msg 回包里被引用那条的真实时间（OneBot 通常按秒）
      replyOrigin = {
        nick: String(s.card || s.nickname || s.user_id || '').replace(/↩/g, '').slice(0, 20),
        frag: qText.trim().slice(0, 50),
        // 记梗用（主人 2026-10-22 晚定）：引用的原话要拿全（frag 只够聊天记录显示用），还有原话人
        full: qText.trim().slice(0, 240),
        blindImg,                            // 引用的图看不到 → handleTurn 里决定「不答」还是「答文字」
        quoteText,                           // 被引用那条里的字，图+文字时拿来接
        video: qVideo,                       // 引用的视频原件（笑点解析要拿它做全量：全部字幕 + 全部帧）
        uid: String(s.user_id || ''),
        msgId: String(d.message_id || ''),      // 引用回复要用：直接引用对方那一条
        // 以前 aimTargetFrom 在这里写 Date.now()，5 分钟新鲜度检查永远通过 →
        // 主人连发被合并时，前一条（甚至很久以前）的引用对象会被挂到本条，QQ 里就引用错人。
        // 现在带上被引用那条的真实时间；拿不到接口时间才回退到老行为。
        msgT: qTime > 1e11 ? qTime : (qTime ? qTime * 1000 : 0),
      };
      if (String(s.user_id || '') === String(selfId)) {
        atMe = true;
        replyOrigin.self = true;   // 引用的是她自己那条（主人 2026-10-22 晚纠正：不要弄错人——prompt/聊天记录里都要写明是她自己说的）
        console.log('[QQ] 她引用回复了机器人的消息 → 算秒回，直接触发');
      } else {
        replyOther = true;
        console.log('[skip] 他引用的是别人的消息，他们在互聊：' + text.slice(0, 30));
        if (isMasterMsg) {
          masterLearn = { kind: 'reply', ctx: parseSegments(d).text || '' };
        }
      }
    } catch (e) { /* 拿不到原消息就不算，继续按普通消息走 */ }
  }
  // 引用的是她自己那条 → 这一轮有人在跟她说话（群里引用她也算数，主人 2026-10-23 全通用）
  const replyMe = !!(replyOrigin && replyOrigin.self);
  /* 主人引用「AI 判定通知」→ 把那个号改回人物（2026-11-21 主人定：引用这条、回复任意内容，空格也行）。
   * 记成豁免而不是删记录：名字还带关键词，不豁免的话下条消息又会被判回来。 */
  if (isMasterMsg && replyOrigin && replyOrigin.self && /\[AI判定\]/.test(String(replyOrigin.full || ''))) {
    const _mt = String(replyOrigin.full || '').match(/QQ\s*(\d{5,})/);
    if (_mt) {
      const _uid = _mt[1];
      aiMark.unmark('qq', _uid);
      const _pl = require('../people');
      const _pm = (() => { try { return _pl.getByAccount('qq', _uid); } catch { return null; } })();
      if (_pm && _pm.pid) { try { _pl.setFavorLock(_pm.pid, false); } catch {} }
      try { core.master('已把 QQ ' + _uid + ' 改回人物。'); } catch {}
      console.log('[AI] 主人引用判定通知 → 改回人物 QQ ' + _uid);
    }
    if (!String(text || '').trim()) return;   // 空内容只用来改回人物，不往下回话
  } else if (isMasterMsg && replyOrigin && !String(text || '').trim()) {
    return;   // 放行了但引用的是别的东西 + 空内容 → 静默忽略
  }
  // 笑点解析（主人 2026-10-22 定）：触发关键词。引用别人的搞笑消息来求解析是正常用法——
  // 不算「他们在互聊」，直接当成 @ 她处理（否则引用回复路径直接被跳过，永远答不了）
  if (/笑点解析/.test(text)) { atMe = true; replyOther = false; }
  // 热度记录：被 @（含引用她）的时间戳——短时间高频 @ 时自主回复阈值降低（见 grpAutoTick）
  // （这里 isPrivate 还没声明，直接看消息类型）
  if (ev.message_type !== 'private' && atMe) recordAt(ev.group_id);
  // 不记录群（机器人群，如赛博鱼塘②塘 100000000）：这些群只接话、不往任何数据文件里写东西。
  // 聊天记录的拦截在 core.logLine 顶端统一做；认人 / 纠正 / 首见 / 学说话在这里拦（noRec 见上面）。
  const isPrivate = ev.message_type === 'private';
  const scope0 = isPrivate ? '私聊' : ('群' + ev.group_id);
  const k = core.histKey('qq', isPrivate ? ev.user_id : ev.group_id);

  /* 自然语言指令层（2026-11-19 主人令）：
   * 主人和自己的号私聊＝指令，不当对话。放在会话关闭闸之前，保证「打开这个群」这类
   * 恢复指令不会因为群已关而被吞掉；只认 isMasterMsg && isPrivate，群聊一行不碰。
   * 合并转发的聊天记录先取成证据文本，再交给指令层判代称/标错。 */
  let forwardEvidence = '';
  if (forwards && forwards.length) {
    forwardEvidence = await fetchForwardEvidence(forwards);
    if (forwardEvidence) text = (text ? text + '\n' : '') + '[转发聊天记录]\n' + forwardEvidence;
  }
  const evidence = forwardEvidence || S0(replyOrigin && replyOrigin.full) || '';

  if (sowingSelf) {
    /* 本号发出来的合并转发（自动搬屎）：
     *   · 只落聊天记录 + 一条 assistant 历史，让她在上下文里看到"这条是我自己发的"；
     *   · sowing 标记让复读/兜底/"最近这样回过"/子代理展示块把它过滤掉，不算她的发言内容；
     *   · 直接 return，不触发、不排队、不进话题/情绪/首见/学习任何回话路径。 */
    if (!convSettings.isOff(k)) {
      const shown = String(text || '[转发聊天记录]').slice(0, 1200);
      core.logLine('qq', '', shown, true, scope0, { displayOnly: true });
      core.pushHist(k, 'assistant', shown, null, { sowing: true });
    }
    console.log('[搬屎] 本号转发，只进上下文不回：' + scope0 + ' ' + String(text || '').slice(0, 20));
    return;
  }

  /* 日记草稿审批（2026-11-20 修复）：主人私聊回「发」/「重写」必须优先于指令层。
   * 老代码这段排在指令层之后，而指令层对主人私聊「没认出」也会 handled:true 直接 return，
   * 于是草稿在等审批时回「重写」被回「没认出这是哪条指令，我什么都没改」——重写永远不生效。
   * 只认 isPrivate && isMaster 且只在有草稿/在写日记时 handled，其余照常往下走。 */
  if (text && isPrivate && isMasterMsg) {
    try {
      const dr = await diaryFlow.onPrivateFromMaster(text);
      if (dr && dr.handled) return;
    } catch (e) { console.log('[diary-flow] 触发失败：' + e.message); }
  }

  const cmdCtx = {
    platform: 'qq', uid: String(ev.user_id), nick: S0(ev.sender && (ev.sender.card || ev.sender.nickname)),
    text, evidence, evidenceFull: S0(replyOrigin && replyOrigin.full), scope: scope0, convKey: k,
    isPrivate, isMaster: !!isMasterMsg, atMe: !!atMe, replyToMe: !!replyOrigin,
    // 2026-11-22：带图 / 引用 / 合并转发的消息不参与群指令识别（图会被翻成文字描述，
    // 描述里的「B站」「一开始」曾被当成「打开 bilibili」，见 handleGroup 顶部）。
    hasImg: !!(imgs && imgs.length), quoted: !!replyOrigin || !!(forwards && forwards.length),
    account: { platform: 'qq', id: String(ev.user_id) },
  };
  try {
    // 记录类（约定 / 代称 / 标错 / 记小本本）是**所有人的**：谁都能触发，群里也一样。
    // 管理类（开关、数值、群开关、撤回…）才只认主人，下面两个分支各管一半。
    const corr = await nlCommand.handleRecord(Object.assign({}, cmdCtx, { evidence: evidence || text }));
    if (corr && corr.handled) {
      // 私聊：回一条确认就结束（私聊里不当聊天）。
      // 群里：只记账不吞消息、不打断正常回话（聊天记录照常留），哪怕提的人是主人。
      if (!corr.silent) {
        logSent(scope0, replyTo(ev, corr.reply || '记下来了。'), nameOf(ev));
        return;
      }
      console.log('[指令] 群里记录类已记：' + String(corr.reply || '').split('\n')[0]);
    }
    // 主人私聊 = 指令优先；没认出也明确回一句，绝不把指令喂给模型
    if (isMasterMsg && isPrivate) {
      const out = await nlCommand.handle(cmdCtx);
      if (out && out.handled) {
        logSent(scope0, replyTo(ev, out.reply || '已处理。'), nameOf(ev));
        return;
      }
    } else if (isMasterMsg && !(corr && corr.handled)) {
      // 主人在群里发的也算指令（2026-11-19 实测：群里「上下文条数改成40条」被当闲聊答了）。
      // 只跑确定性识别：认得出才执行，认不出就照常聊天，不额外花模型钱。
      // 2026-11-20：记录类（含标错）已被上面的 handleRecord 处理过，这里再跑一遍会重复
      // 记账、发「记成约定了。」回执并 return 吞掉正常聊天——已 handled 的直接跳过。
      const out = await nlCommand.handleGroup(cmdCtx);
      if (out && out.handled) {
        replyGroupCommand(ev, out, scope0);
        return;
      }
    }
  } catch (e) {
    // 报错要能直接复制给主人修：原始报错 + 出错行（和指令层同一个格式）
    const detail = '[指令失败] ' + nlCommand.errBrief(e);
    console.log('[指令] 处理出错：' + detail);
    if (isMasterMsg) {
      logSent(scope0, replyTo(ev, '这条指令我没处理成，什么都没改。\n' + detail), nameOf(ev));
      return;
    }
  }

  // 一键关闭（不看也不回）：主人总开关关掉的会话，连记录都不落，直接丢。
  // 位置在所有记录动作（rememberLastMsg / core.logLine / noteTalk …）之前——关掉 = 既不留聊天记录、也不回话。
  // 主人的私聊关不掉（服务端在批量时已经排除），所以这里不会误伤主人的 QQ 遥控权。
  if (convSettings.isOff(k)) {
    console.log('[关闭] 不看也不回：' + scope0 + ' ' + String(text).slice(0, 24));
    return;
  }
  // 认人要在「记聊天记录」之前：群里没 @ 她的话也要留下
  const rawNick = ev.sender?.card || ev.sender?.nickname || '';
  // 群名片按群记（主人 2026-10-23 定）：一个人 1 张资料卡名（空的空着）+ 每个群各一张群名片。
  // 以前只有一个字段、几个群互相覆盖，她就「不知道每个人在这个群叫什么」。
  /* 2026-11-22 她纠正：「实际群里就要是说话就建档。b站才是回复才建档。」
   * 所以 QQ 侧（群聊 + 私聊）恢复成说话就建档——saveCard 内部只在群名片/资料卡
   * 真的变了时才落盘（「只有变了才需要写」仍然成立）。 */
  if (!noRec) {
    try { core.nick.saveCard(ev.user_id, isPrivate ? '' : ev.group_id, ev.sender?.card, ev.sender?.nickname); } catch {}
  }
  /* 私聊时顺手刷新他自己那条资料卡（真实来源，2026-11-22）：同一个号 10 分钟最多一次，
   * 不 await，不能因为拉资料卡拖慢回话。 */
  if (isPrivate && !noRec) {
    const id0 = String(ev.user_id || '');
    if (id0 && Date.now() - (_profAt.get(id0) || 0) > 10 * 60 * 1000) {
      _profAt.set(id0, Date.now());
      syncOneProfile(id0).catch(() => {});
    }
  }
  // 名字一律走 nameOf（读人物表）；cfg.people 不再当独立数据源（2026-11-21 主人令）
  const who = nameOf(ev) || rawNick || (isPrivate ? '有人' : '群友');
  // 记录别人的情绪（主人：以后要记录别人的情绪）：非免记录群，且情绪书判出情绪时，
  // 落一条判断记录（情绪记录.jsonl）。面板里审：没改 = 没错；改了判定 = 判错。60 秒内同人同句不重复。
  // 2026-11-09 主人定：**主人也记**（以前 !isMasterMsg 把她排除了，导致「我生气了几次」一个数都查不到）。
  // 但「我最近生气了几次」这种**问句**不算她生气，否则她问一次就多一次，越问越多。
  if (!skipRec && !localsearch.isMetaQuery(text)) {
    try {
      const _et = require('../emotion-tree');
      const _r = _et.judge(text);
      if (_r && _r.best) _et.record(who, text, _r, isMasterMsg ? 'master' : 'other');
    } catch {}
  }
  // 聊天记录是「记录」不是「回执」：别人说的每一条都先落盘，不管她回不回。
  // 带引用的消息把「回复谁、原话片段」记进正文（面板可点定位原消息）
  // v78（主人 2026-10-23 定）：主人 @/引用别人（不是在跟她说话）时，这条记成**虚幻自己的发言**
  // （主人＝虚幻，是她在网上的分身），并标明「说给谁」——它只算普通聊天记录，不算她的回复。
  /* 对准语（2026-11-22 主人定：不再只给主人算）：群里引用了别人、或 @ 了别人，都要知道
   * 「原说话人」是谁、是哪条消息——「引用当前说话人还是原说话人」的判定要用。
   * aimTo 仍是主人专属口径（提示词/回复对象口径不变）。 */
  const aimInfo = (replyOther || (!atMe && (isMasterMsg || !isPrivate)))
    ? aimTargetFrom(text, replyOrigin, ev.group_id)
    : { name: '', uid: '', msgId: '' };
  const aimTo = (isMasterMsg && aimInfo.name) || '';
  const masterSayToOther = !!(isMasterMsg && !atMe && (aimTo || replyOther));
  // 「群友之间的对话链」：记下每个人最后一条消息 + 主人此刻在跟谁说话
  if (!isPrivate) {
    rememberLastMsg(ev.group_id, ev.user_id, ev.message_id, who, text);
    // 注意：**不再**因为「有人 @ 了主人 / 引用了主人」就推断「主人正在跟他说话」
    // （主人 2026-10-23 报的真事，v100 查实）：主人在群里说了一句跟那个人无关的话，
    // 1 分钟前有人@过主人 → 她就当成「主人在回那个人」，回复里引用了那个人（群友）。
    // 现在只有一条硬规则：**主人自己 @ 了/引用了某人 → 回那个人**；其余不猜。
    // （不再往「对话链」里写：回谁只看这一条消息里主人@了/引用了谁，主人 2026-10-23 定）
  }
  core.logLine('qq', who,
    (replyOrigin ? (replyOrigin.self ? '↩回复她自己那条：' : '↩回复@' + replyOrigin.nick + '：') + replyOrigin.frag + '↩ ' : '') + (text || '[图片]'),
    false, scope0, masterSayToOther ? { asHer: true, to: aimTo } : null);
  // 主人的纠正判定（主人 2026-10-22 真事：「夸在哪，我去，别记错了啊」——她把调侃当成了夸）：
  // 主人明确说「不是夸」的，记进纠正本，以后当铁律；好感度判定也不许把它当夸
  if (isMasterMsg && (CORRECT_RE.test(text) || ID_FIX_RE.test(text))) {
    if (!skipRec) core.recordCorrection(text, masterLearn ? masterLearn.ctx : '', ev.user_id);
    console.log('[纠正] 主人纠正了判定：' + text.slice(0, 40));
  }
  // 新人物 / 新群：第一次见就记一条写入日志（主人 2026-10-22：遇到必写，面板「写入日志」看得到）
  if (!skipRec) noteFirstSight('u' + ev.user_id, '新人物', (who || String(ev.user_id)) + '（QQ ' + ev.user_id + '）第一次' + (isPrivate ? '私聊' : '在群里') + '说话');
  if (!skipRec && !isPrivate) noteFirstSight('g' + ev.group_id, '新群', '群 ' + ev.group_id + ' 第一次有记录');
  // 话题连续性：每个会话最近一段时间的发言都进环（她自己的回复也进，见 handleTurn）
  // 图身份跟着记（echoIh）：复读链靠它认「同一张图」，后面触发分支复用同一个变量。
  const echoIh = (imgs && imgs[0] && imgs[0].ih) || '';
  noteTalk(isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id, who, ev.user_id, text || '[图片]', false, echoIh);

  // ===== 暂停：命令先处理、闸再落地（主人 2026-10-23 说「这个暂停没有用啊」之后改的）=====
  // 以前闸在 handleTurn 里，复读链、骰子、纯情绪表情都在它前面——暂停了她还跟复读、还骰子、还发表情。
  // 现在记录完就拦：复读链 / 骰子 / 表情 / 合并 / 接话，一样都不许发。
  // 命令必须排在闸前面，否则被她自己暂停的群里永远解不开（「允许xxx」会被吞掉）。
  if (isMasterMsg) {
    const pCmdEarly = pauseCtl.parseCommand(text, people.nameMapOfQQ(), isKnownGroup);
    if (pCmdEarly) {
      console.log('[pause] 主人命令：' + String(text).slice(0, 24) + ' → ' + pCmdEarly.msg);
      logSent(scope0, replyTo(ev, pCmdEarly.msg), who);
      return;
    }
  }
  if (pauseCtl.blocked(isPrivate, ev.user_id, ev.group_id)) {
    console.log('[pause] 已暂停，只记录不回：' + scope0 + ' ' + String(text).slice(0, 24));
    return;
  }
  // 群禁言闸（2026-11-05 她定）：自己在群里被禁言 → 发出去也没人看得见，就别调模型了。
  // 位置跟「暂停」一致：聊天记录已经落完，只拦「说话」；
  // 主人的暂停/恢复命令在上一段处理，被禁言时依然生效（不然群里永远解不开）。
  if (!isPrivate && botMuted(ev.group_id)) {
    console.log('[禁言] 群里被禁言（还剩 ' + muteLeftText(ev.group_id) + '），只记录不回：' + scope0 + ' ' + String(text).slice(0, 24));
    return;
  }
  /* 按会话的开关（主人 2026-11-07：「群回复等等的开关都可以在各自界面分别调，黑名单群我也可以在这直接打标记」）。
   * 位置和暂停 / 禁言同一层：聊天记录已经落完，只拦「说话」和「学话」。
   * 键用 histKey（qq_<号>），和上下文条数那份设置是同一个文件、同一套键。 */
  if (!convSettings.replyOk(k)) {
    console.log('[' + (convSettings.isBlack(k) ? '黑名单' : '这个会话不回') + '] 只记录不回：'
      + scope0 + ' ' + String(text).slice(0, 24));
    return;
  }

  // 学习第一优先（主人 2026-10-22）：主人的消息里 @ 了别人 → kind='at'，被@的人最近那句当上下文。
  // 上下文若是逐字复读（和历史某条每个字和标点都一样）就不带——样本里只留主人的回复。
  if (isMasterMsg && !masterLearn) {
    const atOther = (String(text).match(/@(\d{5,12})/g) || [])
      .map(x => x.slice(1))
      .find(q => String(q) !== String(selfId));
    if (atOther) {
      masterLearn = { kind: 'at', ctx: lastSaidBy(isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id, atOther) };
      if (verbatimEcho(k, masterLearn.ctx)) masterLearn.ctx = '';
    }
  } else if (isMasterMsg && masterLearn && verbatimEcho(k, masterLearn.ctx)) {
    masterLearn.ctx = '';
  }
  // 普通接话也带上文（主人 2026-10-22 晚：学说话的样本没有上下文——学习是为了「根据上文给下文」）：
  // 没引用、没 @ 的主人发言，把他上一句**别人的话**当 ctx 记进样本（kind 留空 = 普通接话），
  // 这样样本线里能看到「他是在接哪句话」。自己的话/机器人的话/复读不当上下文。
  if (isMasterMsg && !(masterLearn && masterLearn.ctx)) {
    const skey = isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id;
    const prev = talkRing(skey).filter(m => !m.bot && String(m.uid) !== String(ev.user_id) && String(m.text || '').trim()).slice(-1)[0];
    if (prev && !verbatimEcho(k, prev.text)) masterLearn = masterLearn || { kind: '', ctx: prev.text };
  }

  // 机器人群友（欢迎/群管机器人）：只记录，不接话、不进她的历史——
  // 她分不清那是机器人还是人，接了就会原样复读别人的欢迎语（2026-10-22 截图真事）
  if (isBotUser(ev) || looksBotMessage(text)) {
    console.log('[bot] 机器人群友的消息，只记录不接：' + (rawNick || ev.user_id) + '：' + text.slice(0, 30));
    return;
  }

  // 内部封禁已随「动态广场」一起删除（v74）：封禁是 QQ 的功能（主人 2026-10-22 定），
  // 机器人不需要自己的一套。真要拦人，去 QQ 群管理里操作。

  // ===== 回复类型仲裁（主人 2026-11-10 定：同一句话只回一次，按她订的优先级）=====
  // 优先级高→低：① 回复被引用对象 ② 复读（都有功能性内容）③ 其余功能性回复
  //   （@她 / 引用她 / 问候 / 触发词 / 适合回复 / 提问 / 锐评）④ 强制回复主人每一句话
  //   ⑤ 概率回复（永远最低）。
  // 主人 2026-11-13 改：④ 必回**低于除「主动/概率」外的所有类型**；前方有会话排队就不进行必回
  //   （落点在 handleTurn 末尾、进 chat 之前：pureMasterForce + core.chatBusy）。
  // 四个同时出现 → 只回复被引用者；引用内容是「复读内容」→ 不接复读；引用是「复读引用」→ 只复读。
  // 「复读引用」= 主人引用对方的回复、并把对方那句原样复读了（主人 2026-11-10 亲口定义）。
  // 复读链跟风在早段、发完 return，赢了就不再进 handleTurn，天然只发一条；不另起仲裁器、不靠输出拦截。
  const echoQuote = isMasterMsg && !!replyOther && !!replyOrigin && !replyOrigin.self
    && !!normEchoText(text)
    && normEchoText(text) === normEchoText(String(replyOrigin.full || replyOrigin.frag || ''));
  const chainOk = isMasterMsg
    ? (!masterSayToOther || echoQuote)   // 主人没引用别人 → 复读优先；引用了别人 → 只有「复读引用」才只复读
    : !replyOther;                       // 群友互相引用时不跟复读链（老行为不动）
  // 复读链跟风（主人 2026-10-22 定）：群里出现复读链（同一句话被连着发），她也原样跟一条；
  // 每条链最多跟一次、她自己发起的不跟（无循环）；长文复制粘贴是梗玩法但由她自己掂量。
  // 主人 2026-11-23：图片/gif 走同一条链、同一套判定，命中后发的是原图本体（gif 保持动图）。
  if (!isPrivate && !atMe && chainOk && chainJoinAllowed(ev.group_id, text, echoIh)) {
    chainJoined.set('g' + ev.group_id + '#' + (echoIh ? 'img:' + echoIh : normEchoText(text)), Date.now());   // 键与 chainJoinAllowed 一致
    let sentEcho = true;
    if (echoIh && imgs && imgs[0] && imgs[0].buf) {
      // 发原图：直接 base64:// 送字节，不经过 replyTo 的描述文字，也不写进聊天记录正文。
      // 走 sendAction（发送唯一出口）→ 禁言/关群闸已经在里面兜住，和文字链同一口径。
      const im0 = imgs[0];
      const f = 'base64://' + im0.buf.toString('base64');
      const seg = [{ type: 'image', data: { file: f } }];
      const act = ev.message_type === 'private' ? 'send_private_msg' : 'send_group_msg';
      const prm = ev.message_type === 'private'
        ? { user_id: ev.user_id, message: seg } : { group_id: ev.group_id, message: seg };
      sentEcho = sendAction(act, prm) !== false;
      if (sentEcho) logSent(scope0, { text: '[图片]' }, who);   // 和文字链对称：面板聊天记录看得到她复读过；只记占位符，不记描述
      console.log('[复读链] 跟了一张图/gif（' + (im0.mime || '?') + '）：' + echoIh.slice(0, 16));
    } else {
      const r = replyTo(ev, String(text).trim().slice(0, 450));
      sentEcho = !!r.text;
      logSent(scope0, r, who);
      console.log('[复读链] 跟了一条：' + String(text).trim().slice(0, 30));
    }
    // 她自己的这条也记进即时记忆（带图身份），这样下次不会被当成「别人发起的链」反复跟。
    noteTalk('g' + ev.group_id, who, selfId, echoIh ? '[图片]' : String(text).trim().slice(0, 120), true, echoIh);
    if (sentEcho) { lastSpoke.set(String(ev.group_id), Date.now()); bumpSpoke(ev.group_id); }
    return;
  }

  // 骰子：群里不用 @，也不想被人设改写，直接原样回
  const diceOut = dice.handle(text, ev.user_id);
  if (diceOut) {
    logSent(scope0, replyTo(ev, diceOut), who);
    if (!isPrivate) lastSpoke.set(String(ev.group_id), Date.now());
    return;
  }

  const isMaster = isMasterUid(ev.user_id);
  /* 日记流程（2026-11-18 主人令）：一天一篇，入口有三个。
   *   · 群里出现晚安 → 任何群都算（她定「任何群都算」），只起个头，这条消息照常往下聊；
   *   · 她私信说「今天结束」这类 → 开始写；
   *   · 她私信回「发」/「重写」→ 审批，**这条要吃掉**，不能再当聊天回一遍。
   * 触发之后一直是后台跑（生成要几分钟），这里不 await 到底就返回，
   * 否则她发一句「写日记」会卡在这儿等好几分钟没响应。 */
  if (text && !isPrivate) {
    // 群里的晚安等触发「开始写日记」；主人私聊的「发/重写/今天结束」已在指令层之前处理（见上）。
    // onGroupText 是同步函数，多数分支 return null；裸 .catch() 挂在 null 上会当场抛
    // TypeError 打断整个 onMessage（2026-11-20 23:1x 全群不回话真因）。包成 Promise 再吞。
    try { Promise.resolve(diaryFlow.onGroupText(ev.group_id, text)).catch(() => {}); } catch (_) {}
  }

  const hasImg = !!(imgs && imgs.length);
  const waitMs = planWaitMs({ isMaster, atMe, hasImg });
  // 带图不等（等久了图床链接会失效），但**不能另开一条回复**：
  // 主人 2026-11-05 报的「一句话两条回复」就是这里——一句文字还在攒着，
  // 5 秒后她补了张图，图立刻自己答一条，攒着的文字到点又答一条。
  // 所以：带图且这个人手上还有攒着的话 → 并进那一段，一起答一次。
  const talkKey = k;   // 会话级缓冲：同会话所有人进同一个键，flush 时再分主发言人/插话人
  const mergeOn = (cfgLive().merge || {}).enabled !== false;
  const joinPending = hasImg && mergeOn && pendingTalk.has(talkKey);
  // 主人私聊发「修bug / 自检」→ 她自己把代码查一遍、能修的修掉，再回报（主人 2026-10-22：要的是自动修，不是记录）
  if (isMaster && isPrivate && /^(修bug|自检|检查bug|查bug)/.test(text.trim())) {
    replyTo(ev, '好，我把代码从头到尾查一遍（语法、配置、必备文件、测试），查完告诉你结果～');
    selfCheckReport(ev);
    core.logLine('qq', '', '[自检] 主人要求查一遍代码', true, scope0);
    return;
  }
  // 主人 2026-11-17 令：字数上限「缩减可知、增加靠测」。私聊发「测上限 / 测QQ上限」→
  // 往主人自己的私信递增长度发包，二分逼近 QQ 真实上限，实测值写回 platform-limits。
  // 走 callApi 裸发（拿回包 ok/fail），不经 replyTo / sendGuard，不记聊天记录、不刷屏到别人。
  if (isMaster && isPrivate && /^(测上限|测QQ上限|测qq上限)/.test(text.trim())) {
    const cur = platLimits.capOf('qq') || 600;
    replyTo(ev, '开始测 QQ 上限（当前记的是 ' + cur + ' 字）。往你私信发几条测试串，最多 '
      + limitProbe.MAX_SENDS + ' 条，测完告诉你结果～');
    core.logLine('qq', '', '[测上限] 主人要求测 QQ 字数上限，起点 ' + cur, true, scope0);
    probeQQChat(ev.user_id, m => replyTo(ev, m))
      .catch(e => { try { replyTo(ev, '测上限出错：' + e.message); } catch {} });
    return;
  }
  // QQ 空间动态上限：私聊发「测动态上限」→ 发测试说说、拿 tid、立刻自删，二分逼近。
  // 每条都自删（python --post-probe 里做），删不掉就报错，绝不在主人空间留测试串。
  if (isMaster && isPrivate && /^(测动态上限|测说说上限|测空间上限)/.test(text.trim())) {
    const cur = platLimits.capOf('qzone');       // 0 = 还没实测过（原来这里 fallback 的 60 是我拍的，已删）
    replyTo(ev, cur > 0
      ? '开始测 QQ 动态上限（当前记的是 ' + cur + ' 字）。会发几条仅自己可见的测试说说、发完立刻删掉，稍等～'
      : '开始测 QQ 动态上限（现在没有记录值，从来没测过）。会发几条仅自己可见的测试说说、发完立刻删掉，稍等～');
    core.logLine('qq', '', '[测上限] 主人要求测 QQ 动态上限，起点 ' + (cur || '(未测)'), true, scope0);
    probeQzone(m => replyTo(ev, m))
      .catch(e => { try { replyTo(ev, '测动态上限出错：' + e.message); } catch {} });
    return;
  }
  // 主人 2026-11-17 令：收到评论链接后直接回「合规」/「不合规 + 理由」就判这条。
  // 判定不是新功能：合规=进星标（正面样本）、不合规=进标错（待修复负例），走 core.qzoneJudge。
  // 只有「确实有还没判的评论」且这句话是明确判词时才拦；日常「好的/可以」照旧当聊天。
  if (isMaster && isPrivate) {
    const pv = qc.parseVerdict(text);
    if (pv) {
      const pend = core.qzonePending(10);
      const target = pend[pv.nth > 0 ? pv.nth - 1 : 0];
      if (target) {
        const r = core.qzoneJudge(qc.keyOf(target), pv.verdict, pv.note, '私信');
        if (r.ok) {
          const who = String((r.entry && (r.entry.name || r.entry.qq)) || '');
          replyTo(ev, r.action === 'issue'
            ? '记下了：' + who + ' 那条不合规' + (pv.note ? '（' + pv.note + '）' : '') + '，进标错了'
            : '记下了：' + who + ' 那条合规，进星标了');
          core.logLine('qq', '', '[空间评论] 私信判定 ' + qc.keyOf(target) + ' → ' + r.action + (pv.note ? ('：' + pv.note) : ''), true, scope0);
          return;
        }
      }
    }
  }
  // 主人 2026-11-17 令：私聊发「逛空间」→ 立刻逛一轮人物列表的空间、留一条评论，链接回给她。
  // 手动只发 1 条；同一个动态只评一次这条硬标准任何路径都生效。
  if (isMaster && isPrivate && /^(逛空间|评论空间|去空间留言)/.test(text.trim())) {
    replyTo(ev, '好，我去翻翻大家的空间，看到合适的留一句。好了直接把链接发你～');
    core.logLine('qq', '', '[空间评论] 主人要求手动逛一轮', true, scope0);
    qzoneFriendStroll(true, m => { try { replyTo(ev, m); } catch {} })
      .catch(e => { try { replyTo(ev, '逛空间出错：' + e.message); } catch {} });
    return;
  }
  // 主人 2026-11-17 令：私聊发「测空间上限」→ 重测逛空间的风控额度。
  // 只测「一次能连拉几个人」（只读、不留言）；「每天几条」「隔多久」靠真实撞顶记录学，不主动撞。
  if (isMaster && isPrivate && /^(测空间上限|测空间额度|测空间频率)/.test(text.trim())) {
    replyTo(ev, '按真实撞顶记录校对一下空间额度（不发任何请求）：');
    Promise.resolve()
      .then(() => require('../qzone-probe').probeAll())
      .then(r => { try { replyTo(ev, '测完了 —— ' + r.text); } catch {} })
      .catch(e => { try { replyTo(ev, '测失败了：' + (e && e.message)); } catch {} });
    return;
  }
  if (waitMs > 0 || joinPending) {
    // 学习规则 v2（主人 2026-10-22 定）：测试群以外的群聊就学，@ 与否无关
    if (styleGate(ev, isMaster, isPrivate, text)) {
      const ml = masterLearn || {};
      const forLearn = stripForLearn(text);
      if (!skipRec && !core.isRecalled(ev.message_id, forLearn)) {
        core.learnStyle(forLearn, { g: ev.group_id, kind: ml.kind, ctx: ml.ctx, mid: ev.message_id });
      }
    }
    // 速度优化（2026-10-22）：等他说话的这段时间（主人 ≥6 秒）足够把一次搜索跑完——
    // 像是提问就先把搜索发到后台预热，等 buildMessages 真正要搜时直接命中缓存，不用再等 1~3 秒。
    // 猜错了（后来没搜）也只是后台一次请求，不拖慢任何人；和正式搜索共用同一个缓存。
    if (isMaster && waitMs >= 3000) {
      const probe = (isPrivate ? text : text.replace(new RegExp(`@?${cfg.botName}\\s*`, 'g'), '')).trim();
      if (probe.replace(/\s/g, '').length >= 5
        && !core._isFuncAsk(probe)      // 问「你有什么功能」→ 代码直答清单，不用预热搜索
        && /(什么|怎么|如何|为什么|哪个|哪些|哪里|多少|几|推荐|攻略|教程|吗|？|\?|搜|查)/.test(probe)) {
        websearch.prewarm(probe.slice(0, 70));
      }
    }
    pushPendingTalk(talkKey, {
      uid: String(ev.user_id), isMaster, text: text.trim(), imgs: imgs || [], atMe, atMeReal, ev, isPrivate, who, rawNick, replyOther, replyMe, replyOrigin, masterLearn, aimTo, aimInfo, linkNote, atOtherPerson,
    }, waitMs);
    return;
  }
  await handleTurn(ev, { text, atMe, atMeReal, imgs, isPrivate, who, rawNick, replyOther, replyMe, replyOrigin, masterLearn, aimTo, aimInfo, linkNote, atOtherPerson });
}

/* ===== 来源询问 → 复命 → 临时代办（2026-11-13 主人定）=====
 * 她原话：署名 id 不会随使用知识爆出；只有别人问知识来源时，才主动问作者能不能公开署名；
 *         @询问只问 QQ 的、优先第一个号；询问完还要回去复命；
 *         等 1 分钟无人应答 → 记临时代办，下次被作者触发会话时再问，然后删代办（再复命一次）。
 * 返回 true = 这一轮已经处理完（别再让模型回一遍）。
 */
async function sourceAskStep(o) {
  const { k, ev, content, isPrivate, scope, who, isMaster } = o || {};
  if (!ev) return false;
  try {
    review.askExpire();                        // 超 1 分钟的询问 → 转临时代办

    // ① 作者本人说话了 → 结案（拒/同意）+ 回提问的那个会话复命
    const mine = review.askForAuthor(ev.user_id);
    if (mine && mine.state === 'asking') {
      const credit = review.isDenial(content) ? 'deny' : 'allow';
      for (const id of mine.entryIds) { try { teach.setCredit(id, credit); } catch {} }
      review.askClose(mine.id);
      const line = review.reportLine(mine.authorName, credit);
      if (/^群/.test(mine.askerScope)) {
        sendAction('send_group_msg', {
          group_id: Number(String(mine.askerScope).replace(/^群/, '')),
          message: [{ type: 'at', data: { qq: String(mine.askerUid) } }, { type: 'text', data: { text: ' ' + line } }],
        });
      } else sendPrivate(mine.askerUid, line);
      core.logLine('qq', '', '[复命] ' + line, true, mine.askerScope || scope);
      console.log('[ask] 作者表态 ' + credit + '，已复命：' + String(line).slice(0, 30));
      return true;
    }

    // ② 临时代办：作者一说话就补问 → 删代办 → 重记一条 asking（这样后面的回答还能复命）
    if (mine && mine.state === 'temp') {
      const line = review.reaskLine(who);
      sendPrivate(mine.authorId, line);
      review.askClose(mine.id);
      review.askOpen({
        entryIds: mine.entryIds, kind: mine.kind, authorPid: mine.authorPid, authorName: mine.authorName,
        authorId: mine.authorId, askerUid: mine.askerUid, askerNick: mine.askerNick, askerScope: mine.askerScope,
      });
      core.logLine('qq', '', '[代办] 补问署名：' + line, true, scope);
      console.log('[ask] 补问临时代办，已删代办');
      return false;                            // 作者这句正常话照常回
    }

    // ③ 别人问「谁教你的」→ 找到这条知识的作者，按他第一个 QQ 号去问
    if (!review.isSourceQuestion(content)) return false;
    if (isMaster) return false;                // 她自己问就不用反过来问她
    const here = teach.presentOf(k);
    const pickable = teach.listAll().filter(x => !x.fromPact && x.say);
    let cand = pickable.filter(x => {
      const ids = teach.ownerIds(x);
      for (const id of ids) if (here.has(String(id))) return true;
      return false;
    });
    // 在场名单还没算出来（这一轮是这一句先到）→ 退回「同会话」找，别因为时序漏问
    if (!cand.length) cand = pickable.filter(x => String(x.scope || '') === String(scope || ''));
    cand.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
    const pick = cand[0];
    if (!pick) return false;
    const pid = String(pick.pid || '');
    const accs = pid ? people.accountsOf(pid) : [];
    const first = accs.find(a => a.platform === 'qq');
    if (!first) return false;                  // 没有 QQ 号就不问（只问 QQ 的）
    const authorName = String(pick.nick || '');
    sendPrivate(first.id, review.askLine(authorName));
    review.askOpen({
      entryIds: [pick.id], kind: 'teach', authorPid: pid, authorName, authorId: String(first.id),
      askerUid: String(ev.user_id), askerNick: who || '', askerScope: isPrivate ? '私聊' : ('群' + ev.group_id),
    });
    // 先回提问的人一句，本轮不含署名
    const ack = ['我去问问～', '唔，这得问人家本人～', '等我问一下再告诉你哦'][Math.floor(Math.random() * 3)];
    if (isPrivate) sendPrivate(ev.user_id, ack);
    else sendAction('send_group_msg', {
      group_id: ev.group_id,
      message: [{ type: 'at', data: { qq: String(ev.user_id) } }, { type: 'text', data: { text: ' ' + ack } }],
    });
    core.logLine('qq', '', '[询问] ' + ack, true, scope);
    console.log('[ask] 已私下问作者能否公开署名（' + first.id + '）');
    return true;
  } catch (e) { console.log('[ask] 来源询问失败：' + e.message); }
  return false;
}

// ═════════════════════════════════════════════════════════════
// 【决策链·归属混合，物理不搬】handleTurn：守卫逐字钉住字符串与行序
// （iMaster < iCanAuto < iChime、仲裁①-⑦、必回①-⑥），且是「主人发言必回」铁律所在。
// 链上分支归属：必回本体=H 全聊天；masterAim/chain分岔、锐评、凑热闹、攒N条、欢迎、吐槽= A 群专属；
// 问候/嫌我蠢/提问/复读玩梗/话题接续/笑点解析/被@才回(引用语义)= H 全聊天；复读刷屏= A。
// 本函数已整段物理归位到此处（2026-11-19，原 3092–4541 → 现 4040–5489）：内部一字未改。
// 守卫钉的是字符串存在 + 相对顺序（iMaster<iCanAuto<iChime），整块搬家不破坏；
// 真正禁止的是改字符串/改行序/删分支（那才是乱删好功能），不是禁止搬家。
// ═════════════════════════════════════════════════════════════
async function handleTurn(ev, o) {
  let text = String(o.text || '');
  let atMe = !!o.atMe;
  let imgs = o.imgs || [];
  const isPrivate = ev.message_type === 'private';
  // 群禁言兜底（2026-11-05）：onMessage 那道闸只管「新来的消息」；
  // 拍一拍、攒着的话到点补答也会走到这里 —— 同一个群被禁言就一律不开口，一分 token 都不花。
  if (!isPrivate && botMuted(ev.group_id)) {
    console.log('[禁言] 跳过本轮（群 ' + ev.group_id + ' 还剩 ' + muteLeftText(ev.group_id) + '）');
    return;
  }
  const k = core.histKey('qq', isPrivate ? ev.user_id : ev.group_id);
  const scope0 = isPrivate ? '私聊' : ('群' + ev.group_id);
  // 不记录群（机器人群，如赛博鱼塘②塘 100000000）：本群只接话、不落盘。直接从群里号算，
  // 这样 onMessage / 合并后执行 / 拍一拍 三个入口都自动生效，不用每个调用方单独传。
  // 同上（主人 2026-11-13）：主人触发的那一轮，免记录群一律当正常群走完所有落盘。
  const noRec = !isPrivate
    && ((core.readConfigFresh().noRecordGroups || []).map(Number).indexOf(Number(ev.group_id)) >= 0)
    && !isMasterUid(ev.user_id);
  // AI 账号（2026-11-21）：跟免记录群同一个闸——照常回话，画像/判定/学习一律不写
  const aiUser = aiMark.isAI('qq', String(ev.user_id || ''));
  const skipRec = noRec || aiUser;
  const who = o.who;
  const rawNick = o.rawNick || '';
  // 他引用/回复的是别人的消息（onMessage 里查过原消息）→ 他们在互聊，她不许插话
  const replyOther = !!o.replyOther;
  // 「这一轮有没有人在跟她说话」= 全通用场合判定（主人 2026-10-23 定）：
  // 私聊 / 群里 @ 她 / 群里引用她的话 → 有；群里既没 @ 谁、也没引用谁 → 没有（群友之间在聊天，她自己搭话）。
  const replyMe = !!o.replyMe;
  const atMeReal = !!o.atMeReal;      // 真@她（不是「引用她的话」）
  // 这条消息 @ 了别人（不是她）→ 说给别人听的，约定/记忆一个字都不录（主人 2026-10-23 定）
  const atOtherPerson = !!o.atOtherPerson;
  const isMaster = isMasterUid(ev.user_id);

  /* 固定用法句落库（2026-11-21 冰冰冰失效事故的根因修复）：
   * 主人贴的梗百科长文里常夹一句「看到X时，直接发一句Y」——这是明确要照做的规则，
   * 但整段是长文，core 的 any-taught 不认、guides.learnTeach 也不收长文，
   * 结果像冰冰冰那样只口头答应「我记住了」却没落盘，下次就认不出。
   * 放在 handleTurn 前置、不依赖后面是否调模型（梗兜底/直接回复会跳过 buildMessages）。
   * 这条规则同时是梗教学也是应对 → core.fixedUseLand 落两处、各管一面：
   *   教学条（带署名、可复核、retrieval 轴谁说到都算）/ 梗词句.md 正本（原文＋固定用法，跨群可读）。
   * 不进「约定本体」——约定是按人取、只在他说话时注入；梗是公共的，谁说到都得认（主人 2026-11-21 定）。
   * 门槛：主人 + 有「直接发一句 / 直接回一句 / 直接回复」这种明确照做句式 +
   *       长文（梗百科）或带引号的短句——「我回复他说好的」这类闲聊一律不碰。 */
  const _quoteIn = /[「“"『'][^」”"』']{1,40}[」”"』']/.test(text || '');
  if (isMaster && text && (text.length > 200 || _quoteIn)
    && /(?:直接|就)?\s*(?:发一句|回一句|回复一句|直接发|直接回)/.test(text)) {
    try {
      const scopeFix = isPrivate ? ('私聊QQ' + ev.user_id) : ('群' + ev.group_id);
      const r = core.fixedUseLand({ text, uid: String(ev.user_id || ''), nick: who || '', scope: scopeFix });
      if (r && r.ok) {
        console.log('[teach] 固定用法句落库：' + JSON.stringify(r.fixed.when) + ' → ' + r.fixed.say
          + '｜教条' + (r.teach ? '新' : '已有') + ' 正本' + (r.note ? '新' : '已有'));
      }
    } catch (e) { console.log('[teach] 固定用法句落库失败：' + e.message); }
  }

  // 前方有会话排队（合并了多条消息，pieces > 1）→ 这一轮不按「回应主人」的特殊口径处理：
  // 不套用「主人@了/引用了谁就回谁」、不强制 mustReply 去掉 @，直接照最后一条消息正常回。
  // 否则合并里夹着一条引用过群友的消息，会把群友错当成回复/引用目标（2026-11-13 修「引用错人」）。
  const queueAhead = (o.merged || 0) > 1;
  // 「群友之间的对话链」：主人这句话到底是对谁说的（主人 2026-10-23 定）
  // ① 主人自己 @ 了/引用了某人 → 对那个人说；② 刚才有人 @ 了主人 → 主人在回应那个人。
  const aimInfo = o.aimInfo || { name: '', uid: '', msgId: '' };
  let talkTarget = null;              // {name, uid, msgId, why}
  if (!isPrivate && !atMeReal && !queueAhead) {
    // 只看**这一条消息**：谁 @ 了谁 / 引用了谁 → 原说话人就是他；没有 → 没人被指名。
    // （不再拿「上一条链」去猜——真事 2026-10-23 15:32：主人随口一句，她却引用了 1 分钟前别人@过主人那条。）
    // 2026-11-22：不再只给主人算——群友 @ 她并引用别人时，同样要有「引用原说话人」这个选项。
    if (aimInfo.name) {
      talkTarget = { name: aimInfo.name, uid: aimInfo.uid || '', msgId: aimInfo.msgId || '', msgT: Number(aimInfo.msgT || 0), why: (isMaster ? '主人' : '他') + '@了他' };
    }
  }

  // 回复对象（v78 硬限制）：主人 @/引用了别人 → 这句是回**那个人**的，记录里必须写他，不许写成主人
  const aimTo = String(o.aimTo || '');
  const replyTarget = (isMaster && aimTo) ? aimTo : who;
  markActive();                                  // 上线汇报用：只要还有消息进出，就算「还在活动」
  // @ 时机用的起点：这轮对话从哪条消息开始等（合并轮用第一条的时间，普通轮用 OneBot 事件时间）
  const turnStart = Number(o.firstMsgAt)
    || (Number(ev.time) > 1e8 ? Number(ev.time) * 1000 : Date.now());

  // 暂停/允许命令**必须排在暂停闸前面**（主人 2026-10-23 报的真 bug：
  // 他在群里喊「暂停100000000」→ 好，然后喊「允许100000000」→ 一句话都没有。
  // 原因两层：① 命令只在私聊认，群里发根本进不到解析；② 被暂停的群先把消息吞了，永远轮不到「允许」。
  // 所以：主人的暂停命令**在哪儿发都认**，而且先处理、再判暂停。
  if (isMaster) {
    const pCmd0 = pauseCtl.parseCommand(text, people.nameMapOfQQ(), isKnownGroup);
    if (pCmd0) {
      console.log('[pause] 主人命令：' + String(text).slice(0, 24) + ' → ' + pCmd0.msg);
      logSent(scope0, replyTo(ev, pCmd0.msg), who);
      core.bumpExtract(k);
      return;
    }
  }

  // 暂停闸（主人 2026-10-23 凌晨定）：被暂停的群/人，她**一切发言都停**（聊天记录照常记）。
  // 骰子、笑点解析、攻略这些功能触发也一并停——「停止一切发言」就是一切。
  // 主人的私聊不拦（遥控权永远在）：pause.blocked 里对主人豁免。
  if (pauseCtl.blocked(isPrivate, ev.user_id, ev.group_id)) {
    console.log('[pause] 已暂停，只记录不回：' + scope0 + ' ' + String(text).slice(0, 24));
    return;
  }

  // 顺手记日子（2026-11-06 主人：「以后这种重要的日子自己记」）：
  // 只有「日期 + 生日/纪念日/第一次/相遇…」同时出现才记，不调模型、不占提示词。
  // 放在暂停/禁言闸之后——被禁言、被暂停的场合她不说话，也不该偷偷记东西。
  if (!skipRec) try { core.noteDates(text, { uid: ev.user_id, nick: who, isMaster }); } catch (e) { console.log('[dates] 顺手记失败：' + e.message); }

  // 同一个人把同一条连发十几遍 → 只回第一条，后面只记录（否则机器人跟着刷屏）
  if (!/^[.。]/.test(text.trim()) && spamRepeat(k, ev.user_id, text)) {
    console.log('[spam] 同一条重复刷屏，只记录不回：' + text.slice(0, 20));
    return;
  }

  // 主人私聊管理命令（触发词 = 回复策略的整合版，v80）：在一切回复逻辑之前处理，别让模型把这些当聊天接走
  if (isMaster && isPrivate) {
    const cmdOut = core.triggerCommand(text);
    if (cmdOut) {
      logSent(scope0, replyTo(ev, cmdOut), who);
      return;
    }
    // 需求记录（主人 2026-10-22 晚定）：私聊发「需求：xxx」→ 原文落 data/requests.jsonl，面板「需求记录」页看时间轴。
    // 落盘的目的：以前需求只留在对话里，要翻几十 MB 记录才能找回来。
    const mReq = text.match(/^需求[:：]\s*([\s\S]+)$/);
    if (mReq) {
      reqLog(String(mReq[1]).trim());
      logSent(scope0, replyTo(ev, '需求记下了：' + String(mReq[1]).trim().slice(0, 60)), who);
      core.bumpExtract(k);
      return;
    }
    // 暂停/允许（已在上面统一处理，这里不再重复；留着注释说明位置变动）
    // 多端互通：主人私聊里录人物/账号（绑定 / 新人物 / 合并）。先处理，别让模型把这些当聊天接走。
    const pc = peopleCmd.parseCommand(text);
    if (pc && pc.msg) {
      logSent(scope0, replyTo(ev, pc.msg), who);
      core.bumpExtract(k);
      return;
    }
  }

  // 一键记梗（主人 2026-10-22 晚定）：引用群友的消息 + 「记梗 [梗名：]解释」→ 原话自动变举例、带上10下3的上下文。
  // 放在碎片合并/回复策略之前：这是明确命令，不许被合并攒着、也不许被「他们在互聊」拦掉。
  if (isMaster && /^记梗/.test(text.trim())) {
    const jk = jiMeng(ev, o, text);
    logSent(scope0, replyTo(ev, jk.msg), who);
    if (jk.ok) core.pushHist(k, 'assistant', jk.msg);
    core.bumpExtract(k);
    return;
  }

  // 碎片合并（主人 2026-10-22 定）：别人一个字一条地发，明显是一句话被拆开，先拼回一句再答。
  // 注意这只合并「碎片」；隔了几百毫秒发来的**不同话题**不合并，各自排队、都会回。
  if (!atMe && !(imgs && imgs.length) && text.replace(/\s/g, '').length <= FRAG_MAXLEN && !/^[.。]/.test(text.trim())) {
    const joined = await collectFrag(k, text.trim());
    if (joined == null) return;          // 它的字已经并进前面那条了
    text = joined;
    console.log('[frag] 拼起来当一句：' + text);
  }

  // 触发词里的两种策略（v80 并进统一触发词表）：命中「不用回复」→ 只记录不回；命中「一定回复」→ 没人叫她也接
  const pol = core.triggerPolicy(text, !isPrivate);
  // 「喊一声就接话」那一类触发词（比如群里有人发「虚幻」）：不受群节流限制，直接接
  const trigCall = !!(pol.hit && pol.hit.mode === 'reply');
  if (pol.noreply) {
    console.log('[policy] 命中「不用回复」，只记录不回：' + text.slice(0, 30));
    return;
  }

  // 纯情绪发言闸（主人 2026-10-23 凌晨定，覆盖被@、回复引用、私聊、自主搭话所有路）：
  // 只发表情/情绪、没有实际梗也没有能搜的关键词时，**允许**直接单发一个对应情绪的表情包，不硬凑话；
  // 常用单里没有对应情绪的图 → 安静等下一条（不许硬编一句情绪复读）。
  // 骰子（.开头）、笑点解析、攻略这些功能栏触发不算（功能不受这个限制），带图也不算。
  const isFeatureCmd = /^[.。]/.test(String(text).trim()) || /笑点解析|攻略/.test(text);
  // 问候检测（主人 2026-10-23 定）放在纯情绪闸**前面**：晚安/早安/午安在语气词表里，
  // 先认问候才不会被打表情的路截走。问候必回（群级同类型有冷却），回复指令在下面 extra 里。
  const greet = isFeatureCmd ? null : greetingHit(text);
  if (greet) console.log('[greet] 问候命中（' + greet.kind + '：' + greet.word + '）：' + text.slice(0, 24));
  // 纯情绪发言（主人 2026-10-31 改口径，分成两种情况）：
  //   ① **主人自己**发的纯情绪 → 直接甩一张对应情绪的单图，不说话（「我【哈哈】→【表情:哈哈】」）
  //   ② **别人**发的纯情绪 → 不甩图，当普通消息正常回复（她要回的是话，不是一张图）
  //   ③ 库里没有对应情绪 → 安静等下一条（不硬编一句情绪复读，2026-10-23 的口径不变）
  //   ④ 上一条已经只发了图（90 秒内）→ 这条图驳回，不发也不回（见 imgBlocked）
  if (!isFeatureCmd && !greet && !(imgs && imgs.length) && emotionOnly(text)) {
    const fromMasterEmo = isMasterUid(ev.user_id);
    const imgKey0 = imgKeyOf(ev, isPrivate);
    const st = fromMasterEmo ? pickEmotionSticker(text) : '';
    if (st) {
      if (imgBlocked(imgKey0)) {
        console.log('[sticker] 上一条已经是图，这条纯情绪不再发图（连续发图驳回）：' + st);
        return;
      }
      console.log('[sticker] 主人的纯情绪 → 单发对应表情：' + st);
      const r0 = replyTo(ev, '[表情:' + st + ']');
      logSent(scope0, r0, who);
      markOut(imgKey0, true);
      if (!isPrivate) { lastSpoke.set(String(ev.group_id), Date.now()); bumpSpoke(ev.group_id); }
      return;
    }
    if (fromMasterEmo) {
      console.log('[skip] 纯情绪、库里没有对应表情 → 等下一条：' + String(text).slice(0, 20));
      return;
    }
    console.log('[chat] 别人的纯情绪 → 正常回话（不再自动甩图）：' + String(text).slice(0, 20));
    // 不 return：落到下面的正常回复流程
  }

  // 群友（非主人非欧尼酱）说的「以后每次都要这样」→ 记成「跟他一个人」的约定（主人 2026-10-23 要求）。
  // 真事：企鹅火丁说「你以后发言的结尾还需要加个Ciallo」，她嘴上答「好的我记住了」，磁盘上一条都没有、
  // 下一句也不会加。身份改写（你是猫娘）不记，那是要当场拒的。
  // **位置有讲究**：必须放在下面「要不要回话」的判断之前——录不录约定只取决于这句话是不是冲她说的
  // （core.aimedAtMe 白名单），跟她这轮真回了没有无关。放在回话判断之后的话，
  // 群节流攒不够数、没认出是提问这类情况下她虽然听到了却什么都没记，等于白听见。

    /* 代称本人新增（2026-11-12 主人定；2026-11-13 补「名字代称没有硬分隔」）：
     * 「以后叫我 XX」「叫我 XX 就行」→ 写回 people.json。
     * 本人说的排第一位：表里还没有任何称呼 → 直接当名字（name）；已经有了 → 插到代称最前。
     * 代称仍只有这一份，前端放到「约定·代称」分支展示；pactOf 的老规矩一个字不动。
     * 2026-11-19 修污染：群里一句
     * 「叫它乙?这一叫我都觉得脸上有点挂不住喵」被老正则从腰上截出
     * 「我都觉得脸上有点挂不住喵」当名字写进了 people.json。
     * 现在统一走 nick.callMeName（只认句首/停顿后的祈使句）+ looksLikeName，
     * 「这一叫我」「他叫我」这类从句子中间截出来的不再写。 */
    {
      const add = typeof core.nick.callMeName === 'function' ? core.nick.callMeName(text) : '';
      const canStore = add && typeof core.nick.looksLikeName === 'function' && core.nick.looksLikeName(add);
      if (!skipRec && canStore) {
        try {
          const pid = people.ensure('qq', String(ev.user_id), { nick: who });
          if (pid) {
            const names = people.recognizeNamesOf(pid);
            if (names.indexOf(add) < 0) {
              /* 本人承认的才是真名（2026-11-22 她令）：直接写 name。
               * 旧真名由 people.save 的人名审计（review.nameHistory）留下，之后自动进代称当曾用名。 */
              people.setName(pid, add);
              console.log('[alias] 本人自报名字：' + add + '（写成真名）');
            }
          }
        } catch (e) { console.log('[alias] 没写上：' + e.message); }
      }
    }

  /* 观察到别人喊了就记（主人 2026-11-13：「自己喊过、观察到别人喊了就记」）。
   * 判据：别人这条消息里出现「@某人 XX」或「XX @某人」，且在 @ 前明确写了
   * 「叫/喊/称呼/唤（他|她|它|你|对方）」——XX 才是群里对这个人的叫法。
   * 只对**已经建过档**的人记（不给一个 @ 凭空造人）；表里已有就不重复；
   * 追加成代称（不占名字位），表里一条都没有时它自然就是第一个（= 当名字用）。
   * 停用词挡掉「你们 / 今天 / 那个」这类不是称呼的邻字；
   * looksLikeName 挡整句；looksLikeCallContext 挡「就说这个 @某人」「回复@某人 @某人」这种
   * 只是恰好挨着 @ 的聊天片段（真事：不好说 / 给我个管理 / 就是什么都没发才恶心）。 */
    if (!skipRec) {
    const body = String(text || '');
    const CALL_STOP = /^(你们|大家|我们|他们|她们|今天|刚才|那个|这个|什么|怎么|为什么|就是|不是|可以|没有|这样|那样|一下|一会|哈哈|草|啊|喂|真的|好吧|好的|谢谢|对不起)$/;
    const found = [];
    let mm;
    const re1 = /@(\d{5,12})\s*([\u4e00-\u9fa5A-Za-z0-9]{2,6})/g;
    while ((mm = re1.exec(body))) found.push([mm[1], mm[2], mm.index]);
    const re2 = /([\u4e00-\u9fa5A-Za-z0-9]{2,6})\s*@(\d{5,12})/g;
    while ((mm = re2.exec(body))) found.push([mm[2], mm[1], mm.index]);
    for (const [bareQQ, call, at] of found.slice(0, 3)) {
      if (CALL_STOP.test(call)) continue;
      if (typeof core.nick.looksLikeName !== 'function' || !core.nick.looksLikeName(call)) continue;
      if (typeof core.nick.looksLikeCallContext !== 'function'
          || !core.nick.looksLikeCallContext(body.slice(0, at))) continue;
      try {
        const pid = people.pidOfIdAll(String(bareQQ));
        if (!pid) continue;
        const names = people.namesOf(pid);
        if (names.indexOf(call) >= 0) continue;
        // 群名片/资料卡名就是群里看到的那个，不算新叫法
        const p = people.get(pid) || {};
        const known = (p.accounts || []).some(a => String(a.nick || '') === call
          || Object.values(a.cards || {}).some(c => String(c || '') === call));
        if (known) continue;
        people.setState(pid, { alias: names.slice(1).concat([call]).join('、') });
        console.log('[alias] 观察到别人喊「' + call + '」，记到 ' + pid);
      } catch (e) { console.log('[alias] 观察到没写上：' + e.message); }
    }
  }

  /* 来源询问的作者表态（2026-11-12）：明确拒绝才 deny，其余（同意/岔开/没回/超时）视为同意。
   * 放在所有「要不要回话」判断之前：作者回一句「不行」时就算这轮不答，署名状态也要记下。 */
  {
    const body = String(text || '');
    const bareMe = String(ev.user_id || '').replace(/^[a-z]+:/, '');
    const askState = review.pendingAsk(k);
    const authorBare = String((askState && askState.author) || '').replace(/^[a-z]+:/, '');
    if (askState && authorBare && bareMe === authorBare) {
      const res = review.onAuthorReply(k, body);
      if (res) {
        for (const id of res.ids) core.reviewCredit(id, res.credit);
        console.log('[review] 作者表态 → ' + res.credit);
      }
    }
    review.expire(k, res => { for (const id of res.ids) core.reviewCredit(id, res.credit); });
  }

  /* 原作者本人改口（2026-11-12 主人定）：**旧锁定条物理删掉**，生成新条重新 pending，
   * 再重复「附 5 条原记录 → 主人确认 → 锁定」。锁定态也放行，这是唯一允许的解除方式。
   * 判据收紧：本人署名 + 明确改口词 + 句子里提到那条知识的触发词/回话，免得日常一句「不对」误删。 */
  let authorRevised = false;
  {
    const body = String(text || '').replace(/@\d{5,12}\s*/g, ' ').replace(/\[图片\]/g, ' ').trim();
    const bare = String(ev.user_id || '').replace(/^[a-z]+:/, '');
    if (review.isRevision(body)) {
      try {
        const mine = core.teachList().filter(x => !x.fromPact
          && String(x.qq || '').replace(/^[a-z]+:/, '') === bare
          && ((x.when || []).some(w => w && body.indexOf(String(w)) >= 0)
            || (x.say && body.indexOf(String(x.say).slice(0, 4)) >= 0)
            || /(那条|刚才|重新记|改成)/.test(body)));
        const old = mine.slice(-1)[0];
        if (old) {
          const nw = core.teachRevise(old.id, {
            text: body, src: 'qq:' + String(ev.message_id || ''), t: new Date().toISOString(),
          });
          authorRevised = !!nw;
          if (nw) console.log('[teach] 本人改口：删旧 ' + old.id + ' → 新 ' + nw.id + '（重新待确认）');
        }
      } catch (e) { console.log('[teach] 本人改口失败：' + e.message); }
    }
  }
  if (core.aimedAtMe({ isPrivate, atMe, replyMe, atOtherPerson, replyOther })) {
    const pactTxt = String(text || '').replace(/@\d{5,12}\s*/g, ' ').replace(/\[图片\]/g, ' ').trim();
    // ⓪ 本人取消 / 改口（2026-11-13 主人定：「兜底不能覆盖此人的后续改口」）：
    //    他说「以后别加 Ciallo 了」这种，先把旧条删掉；发送层兜底读的是当前约定，删了就不会再补。
    //    这一轮也不再新录约定，免得取消句本身被当成新约定存下来。
    const pactOff = core.pactCancel(ev.user_id, pactTxt);
    // ① 约定：老规矩一个字不动（群友在这录，主人走下面 3646 那条；免记录群仍不录约定）
    const pact = core.pactOf(pactTxt);
    if (!authorRevised && !pactOff && !isMasterUid(ev.user_id) && String(ev.user_id) !== String(cfg.oniiQQ || '')) {
      if (pact && !skipRec) core.pactAdd(ev.user_id, who, pact, isPrivate ? '私聊' : ('群' + ev.group_id));
    }
    // ② 教学（2026-11-12 主人定）：约定认不出来的「碰到 X 就回 Y」按方向落盘，带教学者 id 署名。
    //    **免记录群照常录**（noRec 不拦这一路）；人物画像 / 约定仍照旧不记。
    //    位置仍在「要不要回话」判断之前：她听到了但没回，也照样记下来。
    if (!authorRevised && !pact) {
      try {
        const it = core.teachAdd({
          text: pactTxt, qq: ev.user_id, nick: who,
          scope: isPrivate ? '私聊' : ('群' + ev.group_id),
          src: 'qq:' + String(ev.message_id || ''),
          by: isMasterUid(ev.user_id) ? 'master' : 'other',
        });
        if (it) console.log('[teach] 录入（' + it.dir + ' / ' + it.qq + '）：' + it.say);
      } catch (e) { console.log('[teach] 录入失败：' + e.message); }
    }
  }

  // 群里没 @ 我：像提问才自动接；或者刚跟人说过话、被吐槽了，也接一句；
  // 再不然群里正常聊天，按小概率凑个热闹（主人 2026-10-22：一天三百条只回一句太闷）
  let autoAsk = false, banter = false, comment = false, chime = false, topic = false, critic = false;
  let masterAim = '';   // 主人 @/引用别人 → 回那个人（提示词对准语，主人 2026-10-23 定）
  let blindButText = false;   // 引用的图看不见、但这轮有字可接 → 答文字并说一句看不见图（主人 2026-11-09 定）
  // 我被欢迎了 / 我是这个群的新人（截图真事：被 @ 说「欢迎新人」，它回「欢迎欢迎～」把欢迎还了回去，
  // 还原样复读了 WuuaBot 的欢迎语）。这两种情况它必须知道「被欢迎的是我」。
  const plain4welcome = text.replace(/@\d+\s*/g, '');
  const welcomed = atMe
    ? WELCOME_RE.test(plain4welcome)
    : (!isPrivate && isNewbie(ev.group_id) && /(欢迎|迎新|新人|新成员|报到)/.test(plain4welcome));
  {
    const recent = !isPrivate && Date.now() - (lastSpoke.get(String(ev.group_id)) || 0) < RECENT_MS;
    const teased = BANTER.test(text);
    const isBoss = isMasterUid(ev.user_id) || String(ev.user_id) === String(cfg.oniiQQ || '');
    // 她刚说完话的时间：用来判断没点名的「有点蠢」是不是冲她去的
    const ring0 = talkRing(isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id);
    const lb0 = ring0.filter(m => m.bot).slice(-1)[0];
    const criticized = detectCriticism(text, atMe, lb0 ? lb0.t : 0);
    if (!isPrivate && !atMe) {
      // 群级节流（主人 2026-10-22）：非@消息按整个群计数，攒够 15~20 条（热度模式 4~10 条）才允许一次自主回复，
      // 优先级高于「对人的非@回复」（附和/吐槽/凑热闹全都要先过这道闸）；「适合回复」白名单除外
      const canAuto = grpAutoTick(ev.group_id);
      const atOtherHit = replyOther || /@\d+/.test(plain4welcome) || typedAtOther(plain4welcome);
      if (isMaster) {
        // 回应主人（主人 2026-10-23 定）：回复率独立——不吃群级节流、不吃凑热闹概率、
        // 不受「不用回复」名单影响，等主人说完合并后必答；但发送层「错误复读」拦截照旧生效。
        // 「你不该这么蠢」骂的是**被 @ 的那个人**，不是她（主人 2026-10-23 报的真事：
        // 主人 @ 小肥鱼 说「你不该这么蠢」，她当成自己被骂，答「我记住了，以后会注意不这么回答的」）。
        if (criticized && !atOtherHit) critic = true;
        // 主人 @/引用别人 → 不是「主人在叫她」，是主人拉她进对话：回复对准那个人（masterAim 进提示词）
        // queueAhead：前方有会话排队时不做这层特殊解析（见上面 queueAhead 说明），直接落回「必回复」
        if (atOtherHit && !queueAhead) {
          // 兜底（主人 2026-11-09 定）：引用的图看不见，就别对着「谁说的」硬答。
          // 判定只看**被引用那条**：引用的是白那条，要接的内容就在白那条里；白无字 = 没有待回复内容 → 不回。
          // 主人自己那句写了什么不算（同日纠正）。白那条图+字 → 回答文字，并说明不回图片的原因。
          // 放在这里：聊天记录、纠正本、学习上下文都在 onMessage 里写完了，return 只停「回话」，不丢数据。
          if (replyOther && o.replyOrigin && o.replyOrigin.blindImg) {
            const anyText = String(o.replyOrigin.quoteText || '').trim();
            if (!anyText) {
              console.log('[skip] 引用的图看不到内容，不回答：' + text.slice(0, 30));
              return;
            }
            blindButText = true;
            console.log('[img] 图不可见但引用那条有字：只答文字，并说明不回图片原因');
          }
          const roq = replyOther ? (o.replyOrigin || null) : null;   // 真 bug 修复：这里原来写了裸 replyOrigin（未定义），主人一引用别人就整轮崩
          const atQ = roq ? '' : (String(text).match(/@(\d{5,12})/g) || []).map(x => x.slice(1)).find(x => String(x) !== String(selfId)) || '';
          const tAt = (!roq && !atQ) ? ((String(text).match(/@[^\s\d@，。！？~～!！?？.、…:：;；,''"“”()（）]{1,30}/g) || [])[0] || '').slice(1) : '';
          let nickOf = '';
          if (atQ) {
            const nameMap = {};
            for (const mm of instantLog('g' + ev.group_id, 60)) nameMap[String(mm.uid)] = mm.nick;
            nickOf = nameMap[atQ] || '';
          }
          masterAim = masterAimLine({ roq, atQ, tAt, people: people.nameMapOfQQ(), nickOf });
          console.log('[master] 主人 @/引用了别人 → 回那个人：' + String(masterAim).slice(0, 70));
        } else if (talkTarget && !queueAhead) {
          // 「群友之间的对话链」：主人这句没 @ 谁，但刚才有人 @ 了主人 → 主人是在回应那个人。
          // 这时她要接的是那个人的话，不是主人的话（也不许说主人@了她——真事 2026-10-23）。
          masterAim = masterChainLine(talkTarget);
          console.log('[master] 主人在跟「' + talkTarget.name + '」说话 → 顺着接那边：' + String(masterAim).slice(0, 60));
        } else {
          console.log('[master] 回应主人 → 必回复（回复率独立）：' + text.slice(0, 24));
        }
      }
      // 他 @ 的是别人（不是她），或者他在引用/回复别人的消息 → 那是他们在互相聊天，
      // 她不许回、不许插话（主人 2026-10-22：「群友@别人时，不要回复对方」；
      // 「@100000000 蚁人在哪发财呢」她凑上去玩梗，还把人家的 @ 和昵称原样搬进回复——假 @ 就是这么来的）
      // （主人 2026-10-23 补：这条只管群友——主人 @/引用别人时上面已接管，回那个人）
      else if (atOtherHit) {
        console.log('[skip] 他 @ 的是别人（真@或手打@昵称）/ 在跟别人聊，不自主接话：' + text.slice(0, 30));
        return;
      }
      // 问候气氛维护（主人 2026-10-23 定）：打招呼的话必回（同类型同群 10 分钟一次防刷屏），不受群节流限制
      else if (greet && greet.kind && greetGate('g' + ev.group_id, greet.kind, isPrivate, ev.user_id)) {
        chime = true;
        console.log('[greet] 问候必回（' + greet.kind + '）：' + text.slice(0, 24));
      }
      // 「喊一声就接话」命中 → 直接接（v80：关键词触发，不受群节流限制）
      else if (trigCall) {
        chime = true;
        console.log('[trigger] 命中触发词「' + pol.hit.words.join('、') + '」，当成有人叫她：' + text.slice(0, 24));
      }
      // 「一定回复」命中 → 一定接（主人手工维护的必回清单，不受群节流限制）
      else if (pol.good) {
        chime = true;
        console.log('[policy] 命中「适合回复」，一定接：' + text.slice(0, 24));
      }
      // 攒不够数：这条消息她什么都不自主说（每条都判断、但每 4~20 条才真的回一次）
      else if (!canAuto) return;
      // 嫌我蠢优先于其他所有路径（截图真事：被当成提问去联网搜，还答成「主人是不是累了」）
      else if (criticized) critic = true;
      else if (recent && teased) banter = true;
      else if (looksLikeQuestion(text) && autoAllowed(ev.group_id)) autoAsk = true;
      // 主人在锐评（「X 是这样的」）→ 附和一句，不用 @ 也不用疑问词
      else if (isBoss && looksLikeComment(text) && autoAllowed(ev.group_id)) comment = true;
      else if (chimeAllowed(ev.group_id, text)) {
        chime = true;
        console.log('[chime] 凑个热闹（今天这个群第 ' + (saidToday(ev.group_id) + 1) + ' 句）：' + text.slice(0, 20));
      }
      // 话题还连着（她刚参与过这段对话）→ 接着话题接一句，不用 @（主人 2026-10-22 定）
      else if (topicAllowed(ev.group_id, text)) {
        topic = true;
        console.log('[topic] 接着话题说（今天这个群第 ' + (saidToday(ev.group_id) + 1) + ' 句）：' + text.slice(0, 20));
      }
      else return;
    } else if (criticized) {
      // 私聊 / 群里 @她：嫌我蠢 → 认错，不是关心
      critic = true;
    } else if (!isPrivate && atMe && teased) banter = true;
    if (critic) console.log('[critic] 对方在嫌我蠢：' + text.slice(0, 24));
  }
  // 「回应主人」顶上来的回复，**不许 @**（主人 2026-10-23 定，原话：
  // 「主人讲话必回的那条规则（仅由必回触发产生的那些回复，@触发的不算）：回复我时不需要@」）。
  // 缘由：合并等待 6 秒 + 模型说话几秒，耗时必然超过 8 秒 → 超时必 @ 的规则每次都命中，
  // 于是主人在群里每说一句，她回一句都要 ping 一下主人。@ 是给「没点名、靠上下文猜是谁」用的提示；
  // 主人刚才明明在跟她说话、这轮也是她话音刚落就接的，再 @ 一次纯属多余（还把那条奇怪的群名片又顶出来一次）。
  // 只有「被 @ 叫才答」的那部分保留原来的 @ 逻辑；她自己 @ 到主人的也要剥掉。
  const mustReply = isMaster && !atMeReal && !queueAhead;   // 主人没点名喊她（哪怕引用了她的话）→ 回她不用 @；前方排队时不强制
  const AT = mustReply ? { mustReply: true } : undefined;   // 传给固定话术出口，同一道闸
  // 群级节流：真的自主回了一句（白名单「适合回复」触发的不算）→ 重新攒（普通 15~20 条 / 热度 4~10 条）（主人 2026-10-22）
  // 主人的必回（回复率独立）不算自主发言，不重置群节流（主人 2026-10-23）
  if (!isPrivate && !atMe && !isMaster && (critic || banter || autoAsk || comment || topic || (chime && !pol.good))) grpAutoConsume(ev.group_id);
  // 图片在 onMessage 就翻译好了（记录时就要有，见 describeImgs），这里把描述摘出来，不重复下载/识别
  const taken = takeImgDescs(text);
  text = taken.text;
  const imgDescs = taken.descs;
  const cleanText = text.replace(/\[图片\]/g, '').trim();
  // 话题日志：别人说的、够长的，先当「可能是话题的内容」记下来（面板里可让它总结 / 收进话题）；图上的内容也带上
  {
    const c = (cfg && cfg.topic) || {};
    const plain = (cleanText + (imgDescs.length ? '（图上：' + imgDescs.join('；') + '）' : '')).replace(/@\d+\s*/g, '').trim();
    if (plain.length >= Number(c.minRecordLen || 10)) {
      if (!skipRec) {
        /* 参与人（主人 2026-11-13：「话题在记录时刻应该属于所有参与话题的人」）：
         * 说话的本人 + 这条里被 @ 的人。群内记录自动就是本群话题（core 按 scope 判群号），不用她改。 */
        const parts = [{ key: String(ev.user_id), name: who }];
        for (const m of String(text || '').matchAll(/@(\d{5,12})/g)) {
          if (!parts.some(x => x.key === m[1])) parts.push({ key: m[1], name: '' });
        }
        core.topicAdd({
          type: 'quote', who, qq: ev.user_id, platform: 'qq',
          scope: isPrivate ? '私聊' : ('群' + ev.group_id),
          participants: parts, text: plain,
        });
      }
    }
  }
  /* 群友关系（主人 2026-11-13）：
   *   · 被 @ 过 = 这两个人认识 → 关系表留一条痕迹（态度仍是无感，只是记下「见过互动」）
   *   · @ 某人 + 带脏词 = a 厌 b（只认明确指向，不拿口头禅当人身攻击） */
  {
    const ats = [...String(text || '').matchAll(/@(\d{5,12})/g)].map(m => m[1]).filter(id => id !== String(ev.self_id || '') && id !== String(ev.user_id));
    if (ats.length) {
      const bad = /(傻[逼比]|煞笔|智障|脑残|废物|去死|nmsl|狗东西|贱人|滚蛋|死全家)/i;
      const hit = bad.test(cleanText);
      for (const id of ats) {
        try { if (hit) core.noteInsult(ev.user_id, id); else core.touchPair(ev.user_id, id); } catch {}
      }
    }
  }
  // ===== 看图铁律（主人 2026-11-19）：图没判出内容 → 不许接话，瞎编绝对禁止 =====
  // 真事：图一张都没认出来，却照发提示词 → 模型只能靠想象编出「两个卡通人物并肩行走」
  // 「泪汪汪的皮眼」这种根本没看到图的话。硬拦在这里，不靠提示词禁令、不烧额度。
  // · 与图片类型无关；与这条消息有没有配套文字无关。
  // · 唯一例外：真被 @（atMeReal）→ 也只回一句「看不清」固定话术，不调模型、绝不描述图。
  // 前面的记录 / 学习 / 情绪 / 话题已做完，这里只停「回话」，不丢数据。
  if (imgs && imgs.length && !imgDescs.length) {
    if (!atMeReal) {
      console.log('[img] 图没判出内容、也没被@ → 不接话（杜绝瞎编）：' + scope0);
      return;
    }
    console.log('[img] 图没判出内容、被@ → 只回「看不清」，不调模型：' + scope0);
    sendFixedReply(ev, k, scope0, '这张图我没看清，你用文字跟我说说图里是什么吧', turnStart, AT);
    return;
  }
  let content;
  if (o.poke) content = '（' + who + '拍了拍你，不是说话）';
  else if (imgDescs.length) content = '（对方发了图，图上：' + imgDescs.join('；') + '）' + (cleanText ? ' 同时说：' + cleanText : '');
  else if (cleanText) content = isPrivate ? cleanText : cleanText.replace(new RegExp(`@?${cfg.botName}\\s*`, 'g'), '').trim() || '在叫我?';
  else if (imgs && imgs.length) content = '（对方发了张图，但我没看清）';
  else return;

  // 来源询问 / 复命 / 临时代办（2026-11-13）：放在所有回话判断之前，
  // 命中了就这一轮自己处理掉，别让模型再答一遍（免得把署名说漏）。
  if (!skipRec && await sourceAskStep({ k, ev, content, isPrivate, scope: scope0, who, isMaster })) return;

  // 记地区（2026-11-19 主人令）：图片上的字（如「登陆地点：西安市 未央区」）和
  // 对方直接说的住处，都按**最细原文**记进地区表、面板照原样显示；记了（新记或换地区）
  // 之后私信汇报主人一次，也报最细的那条。只有喂 AI 时才降到市/区级（core 里 briefForAI）。
  // 没变化 region.setRegion 会回 changed:false —— 不记也不报，不打扰主人。
  const prevTurn = core.getTurn(k);
  const learned = region.learnFrom(content) || (prevTurn.needRegion ? region.detectCity(content) : '');
  if (learned && !isMaster && !skipRec) {
    const chg = region.setRegion(ev.user_id, learned);
    if (chg && chg.changed) {
      const src = imgDescs.length ? '图' : '聊天';
      const label = who || String(ev.user_id);
      try { core.master('记地区：' + label + ' → ' + chg.city + '（来源：' + src + '）'); }
      catch (e) { console.error('[region] 汇报主人失败', e.message); }
    }
  }

  // 引用归属（主人 2026-10-22 晚纠正：不要弄错人）：引用内容本来不进 prompt，模型只能瞎猜
  // 引用里那段是谁说的——真事：他引用**她自己**的分析说「今天下午也是」，模型认成他查的。
  // → 明写「引用的是谁」，引用的是她自己时就写「你自己说的」，别让她把自己的话安到别人头上
  let quoteCtx = '';
  {
    const roq = o.replyOrigin;
    if (roq && (roq.full || roq.frag)) {
      let qf = String(roq.full || roq.frag || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      // 引用的图没看清（主人 2026-11-09）：别让模型对着「[图片]」猜内容，代码直接标成「（不可见图）」
      if (roq.blindImg) qf = qf.replace(/\[图片\]/g, '（不可见图）');
      const qP = isMaster ? '她' : '他';   // 主人是女生（2026-10-22 定死）：对着主人=她，别人=他
      if (roq.self) {
        quoteCtx = qP + '回复（引用）的是**你自己刚才说的**那句：「' + qf + '」。那句是你说的，不是' + qP + '说的——'
          + '别把你的话安到' + qP + '头上，也别把你自己刚说过的话当新闻再讲一遍，就当对方在回应你那句话。';
      } else if (roq.uid && isMasterUid(roq.uid)) {
        quoteCtx = qP + '回复（引用）的是**主人**说的：「' + qf + '」。是主人发的——你们都可能叫虚幻，'
          + '但那句是主人说的，不是你自己说的，也不是' + qP + '说的；对主人的话可以放心当熟悉的内容接。';
      } else if (String(roq.nick || '').trim() === (cfg.botName || '虚幻')) {
        quoteCtx = qP + '回复（引用）的是**一个昵称也叫虚幻的群友**说的：「' + qf + '」。那不是你——别把它当成你自己说过的话。';
      } else {
        quoteCtx = qP + '回复（引用）的是「' + (roq.nick || '别人') + '」说的：「' + qf + '」。'
          + '说这话的是 ' + (roq.nick || '别人') + '，不是' + qP + '也不是你——回复时「你/' + qP + '」要对准人，别弄错。';
      }
    }
  }

  // 这一轮是谁在说话：查资料卡地区、算称呼都要用
  // 留一份引用给 core.chat（opts.turn）：排队醒来时把本轮 ctx 换回来，别读到后到消息的人。
  const turnCtx = {
    source: 'qq',
    uid: ev.user_id,
    gid: isPrivate ? 0 : ev.group_id,
    nick: rawNick,
    /* 真实的群名片（2026-11-22）：空就是空。nick 可能是资料卡昵称兜底，
     * 不能拿去写群名片——实测把「金毛初华」「企鹅火丁」覆盖成了 QQ 昵称。 */
    card: isPrivate ? '' : String(ev.sender?.card || ''),
    isMaster,
    autoAsk,
    banter,
    comment,                 // 主人在锐评 → 只附和一句
    chime,                   // 没人叫她，她自己想搭一句（按概率来的）
    topic,                   // 没人叫她，但话题还连着 → 接着话题说
    critic,                  // 对方在嫌我蠢 → 认错，不是关心（截图真事 2026-10-22）
    welcomed,                // 被欢迎的是我（我是新人）→ 道谢，别复读别人的欢迎语
    atMe,                    // 私聊同步报告时写清「对方有没有 @ 她」
    atMeReal,                // 是不是真@（不是「引用她的话」）
    replyMe,                 // 他引用的是她自己那条 → 这一轮有人在跟她说话（主人 2026-10-23 全通用）
    talkTo: talkTarget ? (talkTarget.name || '') : '',   // 主人在跟谁说话（不是对她说的）
    talkMsgId: talkTarget ? (talkTarget.msgId || '') : '',   // 引用回复用：那个人最后一条消息的 id
    /* 这一轮实际回的是谁（2026-11-22）：主人在跟别人说话时是那个人，否则是发话人。
     * 她真回了 → 给这个人建档（见下面发送成功处的 seen.enroll）。 */
    aimUid: talkTarget ? String(talkTarget.uid || '') : String(ev.user_id || ''),
    quoteCtx,                // 引用的那条是谁说的（主人 2026-10-22 晚：不要弄错人）
    // 待回复人名单·②被引用人（主人 2026-11-21 定，QQ 群聊专属）：被发话人引用的那个人也算
    // 要回复的对象，短期记忆要取他的话。replyOrigin.self=引用的是她自己，不算。
    replyNick: (!isPrivate && o.replyOrigin && !o.replyOrigin.self) ? String(o.replyOrigin.nick || '') : '',
    asksQQ: asksQQ(content), // 对方在问 QQ 号 → 这一轮照实答，别绕（主人 2026-10-23 修）
    text: content,          // 判断「这句是不是上一句的碎片/重复」要用原文
  };
  core.setTurn(k, turnCtx);

  // 多个 @（主人 2026-10-22 定）：除机器人外，每个 @ 都算喊了一次名字——
  // 列出这条消息 @ 的其他人和名字，让她判断「你/他」指谁、该 @ 谁回应
  if (!isPrivate && /@\d{5,12}/.test(content)) {
    const nameMap = {};
    for (const m of instantLog('g' + ev.group_id, 60)) nameMap[String(m.uid)] = m.nick;
    const seenQ = new Set();
    const others = [];
    for (const m of String(content).matchAll(/@(\d{5,12})/g)) {
      const q = m[1];
      if (seenQ.has(q) || String(q) === String(selfId || '')) continue;
      seenQ.add(q);
      // 别人 @ 她提到主人（主人 2026-10-22 晚定：视为评价她自己）——@ 到主人的号标注「也就是你自己」
      // 名字后面带（@QQ号）：她才知道要 @ 谁回去（主人 2026-10-22 晚二定：被 @ 的两个人都要认得出）
      const nm = isMasterUid(q) ? '主人（也就是你自己）'
        : (String(q) === String(cfg.oniiQQ || '') ? '欧尼酱'
          : (core.personNameOf(q, nameMap[q] || '') || ''));
      others.push((nm ? nm : '这个人') + '（@' + q + '）');
    }
    if (others.length) core.getTurn(k).othersAt = others;
  }

  // 对话场景判定（主人 2026-10-22 晚定）：只有「主人和她对话」才认「主人」——
  // 私聊 / 群聊里回复、引用、@ 她 / 她刚刚在群里单独对主人说话、主人接话（3 分钟内）。
  // 其余场景主人的话在输出侧记成她自己说的（同一个人）；主人 @ 她被自动回复属于对话，不算「被人提到」。
  // 必须声明在**第一次用到它之前**（2026-10-23 真 bug：原来在下面才声明，上面拼即时记忆时引用，
  // 直接抛 "Cannot access 'talkingToMe' before initialization"，整轮不回话）。
  const talkingToMe = isMaster && (isPrivate || atMe || sheJustTalkedTo(k, ev.user_id));

  // 即时记忆（主人 2026-11-21 改）：不再靠字面疑问词正则 INSTANT_RE（实测没用——她要的是
  // 「提到了某个东西/某句话」就翻，不是匹配「提到了」这个词）。改成把这句抽词丢本地搜索库，
  // 搜整个 chat-log 的相关原话给她。落点 src/localsearch.js instantContext → core.js ctx.instant
  if (!isPrivate) {
    try {
      const _inst = localsearch.instantContext(cleanText || text, cleanText || text);
      if (_inst) core.getTurn(k).instant = _inst;
    } catch (e) { /* 搜不到就不塞，不白烧 token */ }
  }

  // 笑点解析（主人 2026-10-22 定）：触发词「笑点解析」。上下文口径：
  // 此人上(5)下(2)、整群上(10)下(3)，图片算一条（图片翻译已经在文本里）。
  // 先查梗库、查不到联网搜（buildMessages 里做），最后一句必须是「令人忍俊不禁喵」。
  if (/笑点解析/.test(content)) {
    const gkey = isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id;
    const arr0 = instantLog(gkey, 60);
    const trigT = arr0.length ? arr0[arr0.length - 1].t : Date.now();
    if (!isPrivate) {
      // 下文要等一等：紧跟的补刀、追加图也算素材（整群下 3）
      await new Promise(r => setTimeout(r, 6000));
    }
    const arr = instantLog(gkey, 60);
    const pre = arr.filter(x => x.t <= trigT && !x.bot);
    const post = arr.filter(x => x.t > trigT && !x.bot).slice(0, 3);
    const xd = {
      person: pre.filter(x => String(x.uid) === String(ev.user_id)).slice(-5).map(x => uidTagHist(x.uid, x.nick) + '：' + x.text),
      group: pre.slice(-10).map(x => uidTagHist(x.uid, x.nick) + '：' + x.text),
      after: post.map(x => uidTagHist(x.uid, x.nick) + '：' + x.text),
      target: '',
      scope: 'thread',            // quote → media → single → thread（主人 2026-11-22 定：整段对话只当最后兜底）
    };
    /* 要解析的目标（顺序固定，先中先选）：
     *   ① 他引用的那条（用 ro.full 全文，不是 50 字 frag）
     *   ② 最近的图 / 视频 / 视频链接
     *   ③ 最近一条他人原话（寒暄、纯表情不算）
     *   ④ 以上全无，才允许整段对话（scope='thread'）
     * 有了 ①②③ 之后，整段对话只当「背景」，prompt 里明令不许解析。 */
    const ro = o.replyOrigin;
    if (ro && (ro.full || ro.frag)) {
      const q = String(ro.full || ro.frag || '').replace(/\s+/g, ' ').trim();
      xd.target = ro.self
        ? '（他引用的消息）**你自己**之前说的：「' + q + '」（是你说的，不是他说的）'
        : '（他引用的消息）' + ro.nick + '：' + q;
      xd.scope = 'quote';
    }
    if (xd.scope !== 'quote') {
      const img = pre.slice().reverse().find(x => /［图：/.test(x.text));
      const vid = pre.slice().reverse().find(x => /［视频：/.test(x.text));
      const lnk = pre.slice().reverse().find(x => /https?:\/\//.test(String(x.text || '')));
      if (img) {
        xd.target = img.nick + ' 发的图，图上：' + ((img.text.match(/［图：([^\]］]*)］/) || [])[1] || img.text);
        xd.scope = 'media';
      } else if (vid) {
        // 最近发的是视频 → 目标就是视频（下面统一升级成全量）
        xd.target = vid.nick + ' 发的视频';
        xd.scope = 'media';
      } else if (lnk) {
        xd.target = lnk.nick + '：' + lnk.text;
        xd.scope = 'media';
      } else {
        const others = pre.filter(x => String(x.uid) !== String(ev.user_id));
        const t0 = (others.length ? others[others.length - 1] : pre[pre.length - 1]);
        const tt = String((t0 && t0.text) || '').trim();
        if (t0 && tt.length >= 2 && !/^\[图片\]$|^\[表情\]$/.test(tt)) {
          xd.target = t0.nick + '：' + tt;
          xd.scope = 'single';
        }
      }
    }
    /* 视频（主人 2026-11-22 定）：「笑点解析」要看全量——全部字幕 + 全部可截帧数。
     * 优先用他引用的那个视频；否则用本群最近 10 分钟内发的那条（且目标确实落在视频上，不抢文字的戏）。 */
    let vseg = (ro && ro.video) || null;
    const rv = vseg ? null : recentVideoRef(gkey, 600000);
    if (!vseg && rv && (/［视频：/.test(String(xd.target)) || !String(xd.target).trim())) vseg = rv.seg;
    if (vseg) {
      try {
        const full = await video.describe(vseg, { mode: 'full', callApi: (n, a, ms) => callApi(n, a, ms) });
        xd.target = ((ro && ro.video) ? '（他引用的视频）' : '（他发的视频）') + full;
        console.log('[笑点解析] 视频改成全量：' + String(full).slice(0, 200));
      } catch (e) { console.log('[笑点解析] 视频全量失败，按原目标继续：' + e.message.slice(0, 80)); }
    }
    core.getTurn(k).xd = xd;
    // 素材存档（v79）：原始原话 + 图片说明，以后「范例对应的记录/图片」永远查得到
    if (!skipRec) core.recordXiaodianMaterial(xd, {
      img: (pre.slice().reverse().find(x => /［图：/.test(x.text)) || {}).text || '',
    });
    console.log('[笑点解析] 目标(scope=' + xd.scope + ')：' + String(xd.target).slice(0, 60) + '｜群上文 ' + xd.group.length + ' 条');
  }

  const scope = isPrivate ? '私聊' : ('群' + ev.group_id);

  // 历史里说话人要消歧（输出侧专用，落盘不动）：对话场景显示「主人」，其余场景主人的话=她说的
  // uid/nick 一起带进历史（2026-11-03）：自动总结靠它分清「谁说的」，
  // 以前只有一句文本，模型把虚幻自己说的话记成了别人的喜好。
  core.pushHist(k, 'user', `${uidTag(ev.user_id, who, talkingToMe)}说: ${content}`
    + (o.linkNote ? '\n' + o.linkNote : ''), { nick: who, uid: ev.user_id });
  // 他亲口说的喜恶（我最喜欢X / 我讨厌X）→ 立刻记进《人物喜好 · 确定》
  if (!skipRec) core.learnTaste(ev.user_id, who, content);
  // 主人自己打的字 → 学她的说话方式（机器人是她在网络上的分身）。
  // 只学她群里「没 @ 她」时的自然发言（主人 2026-10-22）：私聊、@她时是在跟机器人对话，那是上下文不是说话习惯；
  // 图上的内容是翻译不是他打的字，剥掉再学——学习是为了根据上文给下文，注重连贯衔接。
  // 学习规则 v2（主人 2026-10-22 定）：图片不是不收——打字部分照学，图的翻译存成「发图品味」，
  // 以后她发图挑同类；但绝不许把图片翻译直接当文字输出。带 @ 剥号照收（style.learn 里处理）。
  if (isMaster && !o.merged && styleGate(ev, isMaster, isPrivate, cleanText || content)) {
    const imgDesc = (String(cleanText || '').match(/［图：([^］]*)］/g) || []).join('；');
    const ml = o.masterLearn || {};
    if (!skipRec && !core.isRecalled(ev.message_id, cleanText || content)) {
      core.learnStyle(cleanText || content, { g: ev.group_id, img: imgDesc, kind: ml.kind, ctx: ml.ctx, mid: ev.message_id });
    }
  }

  // 主人说「认可/对的/正确…」→ 把上一条联网结果入库，并给明确反馈
  if (!skipRec && isMaster) {
    const r = core.maybeApprove(k, content, true);
    if (r === 'SAVED' || r === 'STALE' || r === 'EMPTY') {
      const msg = r === 'SAVED' ? core.nick.approveLine(ev.user_id, { nick: rawNick })
        : r === 'STALE' ? '这个过两天就变了，我不存哦'
        : '这条我自己都没弄明白，先不记啦';
      sendFixedReply(ev, k, scope, msg, turnStart, AT);
      return;
    }
  }

  // 在场名单（2026-11-12 主人定）：私聊只有对方；群聊查群成员名单。
  // 教的人不在场 → 他教的东西一个字都不注入，也不会被别人接走。
  let presentIds = [];
  try {
    presentIds = isPrivate ? [String(ev.user_id)] : await groupMemberIds(ev.group_id);
    core.teachSetPresent(k, presentIds);
  } catch (e) { console.log('[teach] 在场名单失败：' + e.message); }

  /* 被问「这是谁教你的」→ 先按虚幻自己的口吻 @ 作者问能不能公开署名。
   * 使用知识时不带 id；本轮答复也不带署名（core.js 命中才注入的那段规则负责）。
   * 作者明确拒绝过（credit=deny）的条目不再问、永不公开。 */
  {
    const body = String(cleanText || content || '');
    if (review.isSourceQuestion(body) && !review.pendingAsk(k)) {
      const ids = new Set(presentIds.map(x => String(x).replace(/^[a-z]+:/, '')));
      const mine = core.reviewAll().filter(x => x.qq && x.say
        && ids.has(String(x.qq).replace(/^[a-z]+:/, ''))
        && review.creditOf(x) !== 'deny');
      const author = mine.length ? String(mine[0].qq).replace(/^[a-z]+:/, '') : '';
      if (author) {
        review.ask(k, mine.map(x => x.id), author);
        const nick = String(mine[0].nick || '').trim() || '你';
        const q = '@' + author + ' ' + review.askLine(nick);
        try {
          const ans = atNameConvert(applyAtTiming(q, ev, turnStart, AT), ev);
          const r = replyTo(ev, ans);
          if (r && r.text) logSent(scope, r, nameOf(ev));
          console.log('[review] 已问作者能否公开署名：' + author);
        } catch (e) { console.log('[review] 问作者没发出去：' + e.message); }
      }
    }
  }

  // 「下次遇到有人说 X 直接回复 Y」：教的人在场且本轮撞上 X → 不走模型，原样发 Y。
  // 硬短路保证一个字一个标点都不改，也省一次模型调用；禁言 / 回话开关在上面，没绕过。
  {
    const teachSay = core.teachSay(k, cleanText || content);
    if (teachSay) {
      console.log('[teach] 命中「' + String(cleanText || content).slice(0, 30) + '」→ 原样回：' + teachSay);
      sendFixedReply(ev, k, scope, teachSay, turnStart, AT);
      return;
    }
  }

  // 吩咐只认主人和欧尼酱，免得群里随口一句把记忆写脏
  const canRemember = (isMaster || String(ev.user_id) === String(cfg.oniiQQ || '')) && !skipRec;
  // 白名单制（主人 2026-10-23 定）：只有「明确冲她说的」才允许录约定/记忆——
  // ①私聊 ②群里 @ 她 / 引用她的消息 ③群里没 @ 谁、没引用谁。
  // @ 了别人、引用的是别人的话 → 那是说给别人听的，一个字都不录（真事：她 @ 某人说「许愿记得分条许」
  // 被当成「主人吩咐」记进了约定）。判定在 core.aimedAtMe，三处闸共用。
  const aimed = core.aimedAtMe({ isPrivate, atMe, replyMe, atOtherPerson, replyOther });

  // 她说「希望你下次可以说X」→ 回「好，知道啦」，X 写进《长期记忆·想听我说》（主人 2026-10-22 定）
  // 放在「小本本」前面：这句话更具体，优先按它走
  const wished = (canRemember && aimed) ? core.tryWish(k, content) : null;
  if (wished) {
    sendFixedReply(ev, k, scope, '好，知道啦', turnStart, AT);
    return;
  }

  // 「记到你的小本本上」：必须真的写进 MEMORY.md，回执里说清写了什么（主人 2026-10-22 定）
  const remembered = (canRemember && aimed) ? core.tryRemember(k, content, { quote: o.replyOrigin }) : null;
  // 群友的「以后每次都要这样」已经在上面（回话判断之前）录成约定了，这里不再重复记一次。
  if (remembered) {
    sendFixedReply(ev, k, scope, core.memAck(remembered, who), turnStart, AT);
    return;
  }
  // 「记到 X 攻略里」：识别指令 → 真写进 data/guides/X.md → 短路回执
  // 放在 tryRemember 之后、普通回复之前；和「小本本 / 想听我说」同一路短路机制
  // （根治 2026-11-01 翻车：以前只会嘴上回「已记好啦」、磁盘什么都没写，群聊再问就瞎编）
  const guided = (canRemember && aimed) ? core.tryGuideRecord(k, content) : null;
  if (guided) {
    sendFixedReply(ev, k, scope, guided, turnStart, AT);
    return;
  }
  // 主人的「以后每次都要这样」→ 记成「跟主人的约定」（主人 2026-10-23 补）。
  // 真事：主人私聊说「以后你发言结尾记得加个喵」，以前谁都没记，她下一句照样不照做。
  // 放在 tryRemember / tryWish 之后 → 同一句话只记一处（已写进小本本或「想听我说」的就不再重复记）。
  if (canRemember && aimed) {
    const pactM = core.pactOf(content);
    // byMaster：主人自己定的约定，免记录群也照常落盘（2026-11-13 她定）
    // 取消句不录：先跑一次取消判定（同一句在上面已经跑过就返回 0），避免「别加了」被当成新约定
    if (pactM && !core.pactCancel(ev.user_id, content)) {
      core.pactAdd(ev.user_id, who, pactM, scope, { byMaster: isMasterUid(ev.user_id) });
    }
  }

  // 关键词触发：先发固定话术（1 毫秒内发出，不走模型）——同样走公共发送层
  const trig = core.matchTrigger(content, !isPrivate);
  if (trig) {
    sendFixedReply(ev, k, scope, trig.say, turnStart, AT);
    if (trig.thenChat === false) return;
    await new Promise(r => setTimeout(r, 1000)); // 让第一句先落地
  }

  let extra = o.poke
    ? '对方刚在 QQ 里拍了拍你（就是 QQ 那个「拍了拍」的提示）。别当成消息。\n你能收到拍一拍。\n'
      + '- 被拍一下，回一句就够（10~25 字）：应一声、问怎么了、或者反过来「干嘛呀」都行。\n'
      + '- 不许问「什么是拍一拍」，不许说自己收不到、看不见，不许长篇大论。\n'
      + '- 不许复述「你拍了拍我」这种系统话。\n'
      + '直接回，别加解释，像被人从背后轻拍了一下肩膀。'
    : welcomed
    ? '对方在欢迎你。你才是被欢迎的那个（你刚加入这个群，你是新人）。\n谢谢对方，按你的角色打个招呼，一两句就完。\n'
      + '不许复读任何人的欢迎语。\n'
      + '不许出现「请遵守群规」「关闭欢迎」「玩得开心」这种客套话。\n'
      + '不许以群主/老成员自居去欢迎别人。'
    : (greet && greet.kind === 'closing'
      ? '对方在道晚安/说结束语（「' + greet.word + '」）。简短温柔地道一声晚安或再见就好，一两句，不用翻记忆、不用提问、不用联网。'
      : (greet && greet.kind === 'greet'
        ? '对方刚打了招呼（「' + greet.word + '」）。这句必须回。\n不许干巴巴只回一句问候。\n如果长期记忆（话题、约定、喜好）或短期记忆/最近聊天里有和对方（或这个群）相关的旧事，就直接带进问候，不加解释，比如「早上好！昨天你说今天要早起，起来了吗」。\n回忆必须是记忆里真有的。\n如果记忆是空的，就按对方最近说的话接一句。\n不许编。'
        : (topic
      ? '你刚参与过这段对话，现在接着这个话题说一句。没人问你，就像群里一个熟人顺手接过话头——接他们正在聊的那件事。'
      : (autoAsk
        ? '这句话是你在群里自己接的（对方没 @ 你，只是在提问）。\n必须先联网查到、且确实能回答才接。\n如果查不到或搜到的对不上，就别答（这种「没查到」的回答不会发出去）。\n不许编。'
        : ''))));
  // 主人 @/引用别人 → 回那个人（主人 2026-10-23 定）：对准语拼在最后
  if (masterAim) extra += '\n' + masterAim;
  // 图不可见但引用那条有字（主人 2026-11-09 定）：文案照抄她的原话，一句就够。
  // 硬限制全由代码保证：图内容已换成「（不可见图）」、无字已 return，提示词里不再写任何禁令。
  // 只在**这一轮**加，不改常驻提示词、不进历史。
  if (blindButText) extra += '\n这轮图不可见。回复文字+不回图片原因。';
  // 对方发的是链接（v78）：标题/简介已经在消息里，直接说这是什么，别装看不懂
  if (o.linkNote) {
    extra += '\n他这条发的是链接，别当成让你猜。标题/简介已经写在消息里（「标题「…」」那段）。\n直接按它说这是个什么网页。\n'
      + '如果正文确实看不到，就说「正文我看不到」。\n不许拿记忆里的游戏/作品硬套。';
  }
  // 对方发的是选项图（2026-11-03 主人定）：图里 1、2、3… 并排摆着 = 在问你选哪个。
  // 人类看一眼就回「5」；模型不懂这层，只会站旁边夸一句「好香啊」——那就是 AI 味。
  // 只在**这一轮**加一句（不改常驻提示词、不进历史），不是选项图的图一个字都不加。
  const optN = optionGraphMax(imgDescs);
  if (optN) {
    extra += '\n他发的是 1~' + optN + ' 的并排选项图，等于在问你选哪个：直接回一个号（如「5」「5，肥瘦刚好」），一句话，别超过十个字。\n'
      + '不许只夸不选（「好香啊」「看起来不错」这种等于没答）。\n不许分析整张图。';
    console.log('[opt] 选项图 1~' + optN + '：已要求直接选号，不许夸');
  }
  // 发言类回复公共规则（主人 2026-10-23 定）：联系上下文 + 记忆 callback 对**所有**回复路径统一要求，
  // 不只问候——被 @、自主接话、凑热闹、回应主人全都一样
  extra += '\n' + COMMON_REPLY_RULES;
  // 本地数据检索（主人 2026-11-09 定：「所有已经存在的数据虚幻都应该能够进行本地搜索」）：
  // 命中回溯问句（几次 / 什么时候 / 之前 / 上次 / 说过）时，先查已落盘的数据，把查到的当事实塞进来。
  // 两件真实翻车：① 她问「我最近生气了几次」，模型只看见「生气」就道歉，一个数都没查；
  //              ② 她说「非神说了你几次脑子空空」，旧版只挂情绪词，这句没有情绪词就整句没查。
  // 只在命中时加，不命中一个字都不加（不白烧 token），也不改常驻提示词。
  try {
    // 用原话（cleanText）而不是 content：content 会拼上图片描述，
    // 从描述里抽关键词会误触发（发张图就开始翻旧账）。
    const _fact = localsearch.block({ uid: ev.user_id, who, text: cleanText || text, days: 30 });
    if (_fact) { extra += '\n' + _fact; console.log('[本地检索] 命中 ' + _fact.length + ' 字：' + _fact.slice(0, 130).replace(/\n/g, ' ')); }
  } catch (e) { console.log('[本地检索] 失败：' + e.message); }
  // ===== 主人必回优先级（主人 2026-11-13 定）=====
  // 她原话：「主人必回优先级应于除了主动外的所有，且前方有会话排队就不进行主人必回」。
  // 只拦「纯必回」＝没真 @ 她、没引用她、没 @/引用别人的普通发言。被 @ / 引用她 /
  // 回复被引用对象（对准语）/ 复读链 / 骰子 / 命令 / 暂停都在前面走完，一律不受影响。
  // 好处：不再由必回那条 setTurn 顶掉正在回复的会话，引用对象 / 发言人 / 对准语不会串人。
  // 记录、认人、情绪、话题、教学、约定、小本本、学说话全在上面已做完，这里只不进 chat。
  // ===== 派活判定（2026-11-22 定稿）：@她 + 命中词表 + 好感≥100 → 这一轮换我（dsh-agent）出面 =====
  // 落点：决策链走完、core.chat 之前。这里**只判定、不接管**：判到活就把 agentTurn 交给 core.chat，
  // 排队/超时/失败兜底/输出闸全部沿用原链路；「我」在 core.js 的模型链里（askMe 拦截 dsh-agent），
  // 和 llm.json 的模型是同一个位置，人设、引用对象、上下文全部继承。
  // 不中词的 @ 不派；没 @ 的一条都不派（主人原话）。
  let _agentTurn = false;
  try {
    const _fav = (() => {
      try { const rec = people.getByAccount('qq', String(ev.user_id)); return Number((rec && rec.favor) || 0); } catch (e) { return 0; }
    })();
    const _g = require('../intent-router').gate(cleanText || text, { atMe: atMeReal, favor: _fav });
    _agentTurn = _g.action === 'work';
    if (_agentTurn) console.log('[派活] 命中（' + _g.reason + '，好感 ' + _fav + '）→ 这轮我出面');
  } catch (e) {
    console.log('[派活] 判定失败，照常走：' + (e && e.message));
  }
  const pureMasterForce = isMaster && !atMeReal && !replyMe && !aimTo && !replyOther;
  if (pureMasterForce && core.chatBusy(k)) {
    core.restoreTurn(k);                 // 本轮 setTurn 覆盖过 turns，还原给正在生成的那轮
    console.log('[master] 前方有会话排队 → 本轮不进行主人必回（只记录，不抢上下文）');
    core.bumpExtract(k);
    return;
  }
  // 主人 2026-11-23 定：纯必回 6 分钟冷却（只拦纯必回；@她/引用她/对准语/复读/命令等上面已分流，碰不到）。
  // 位置在「等他说完」的合并之后（onMessage 攒完 → flush → 这里），所以冷却永远不抢等待说完：
  // 主人在窗口内一条条说的，先由 planWaitMs/masterWaitMs 攒成一段，这里判的是「这整段要不要回」。
  // 计时点在下面回复真正发出之后记，不从触发时刻算（等待+生成的时间不算进冷却）。
  if (pureMasterForce) {
    const coolMs = Math.max(0, Number((cfgLive().merge || {}).masterCoolMs || 0));
    if (coolMs > 0) {
      const lastAt = Number(masterForceAt.get(k) || 0);
      const left = coolMs - (Date.now() - lastAt);
      if (lastAt && left > 0) {
        console.log('[master] 纯必回冷却中（还剩 ' + Math.round(left / 1000) + ' 秒）→ 本轮不回（只记录）');
        return;
      }
    }
  }
  setThinking(true);
  try {
    // 链接说明也当这句话的一部分给模型（不然她只看见一串网址，还是会硬扯记忆）
    const userTextForModel = content + (o.linkNote ? '\n' + o.linkNote : '');
    await core.chat(k, () => core.buildMessages(k, userTextForModel, extra), ans => {
      // 可以 @ 人（主人 2026-10-22 撤了「剥 @ / 禁 @」）：回复里写 @QQ号，replyTo 会转成真 @ 发出去
      // 自主路径不许发「没答案」的固定话术（主人 2026-10-22 截图：群友问喝蒙脱石散，她自主接话去搜，
      // 对不上就回了句「这个我记不清」——没人问她还插一句这个，纯属莫名其妙）。宁可不说：不发、不进历史。
      // 主人的必回不受这条约束（主人 2026-10-23：所有她的发言必回复）——但错误复读拦截下面照旧拦
      if (!isPrivate && !atMe && !welcomed && !isMaster && EMPTY_ANS.test(ans.trim())) {
        console.log('[auto] 自主接话但没答上来，取消发送：' + ans.slice(0, 40));
        return;
      }
      // 回声格式清理（v2）：把「某某说: xxx」的转述前缀剥掉再发（纯复读/玩梗允许，只治格式）；
      // 剥完全空才不发，且不留日志（主人 2026-10-22：没发出去的消息不用留日志）
      const cleaned = stripEchoFormat(ans);
      if (!cleaned) return;
      // 没删却说删了（主人 2026-11-23 报）：真删除走 nl-command 不进这里，model 出口这句必是幻觉，
      // 拦下不发、不留日志（跟复读守卫/只有@ 同一档），免得群里追着问「你删了啥」。
      if (claimsDeleted(cleaned)) {
        console.log('[out] 幻觉删除宣言拦截（没人叫她删，真删除走指令层）：' + String(cleaned).slice(0, 50));
        return;
      }
      // 别人的约定不许套（主人 2026-10-23 报）：回张三时带着跟李四约的句尾记号（Ciallo 那事）→ 剥掉。
      // 模型照着历史里自己说过的话学样改不掉，发送层兜底，出口上删干净再发。
      const cleaned2 = core.stripOtherPacts(cleaned, ev.user_id);
      if (cleaned2 !== cleaned) {
        console.log('[pact] 删掉不属于这个人的约定记号：' + String(cleaned).slice(0, 30) + ' → ' + String(cleaned2).slice(0, 30));
        ans = cleaned2;
      }
      ans = cleaned2;
      // 引用谁标记（[引用:原]/[引用:当前]/[引用:无]，主人 2026-11-22 定）：先剥出来，
      // 标记绝不当正文发出去；没有标记就按后面的证据判定。
      const _qh = takeQuoteHint(ans);
      ans = _qh.text;
      if (_qh.hint) console.log('[quote] 模型指定引用对象：' + _qh.hint);
      // 反方向兜底（2026-11-13 主人定）：这一轮真是在跟他本人说话，就把他定过的句尾记号补上。
      // 模型被超长上下文挤掉、或本地模型 500 切备用模型时经常漏 Ciallo，出口补一次才算真生效。
      if (core.aimedAtMe({ isPrivate, atMe, replyMe, atOtherPerson, replyOther })) {
        const ensured = core.ensurePactSig(ans, ev.user_id);
        if (ensured !== ans) {
          console.log('[pact] 补上这个人定过的记号：' + String(ensured).slice(-40));
          ans = ensured;
        }
      }
      // 复读守卫（主人 2026-10-23 定，白名单制）：最近 10 条以内别人的话不许复读，
      // 例外=梗库里的梗 / 能搜到原文的梗（±1~2字符）/ 群友复读链（链那条路不在发送层）；拦下不发、不留日志
      if (repeatsOthers(k, ans) && !replayAllowed(ans)) {
        console.log('[out] 复读拦截（非白名单复读）：' + String(ans).slice(0, 40));
        return;
      }
      // 只有 @ 没有正文不发（截图真事 2026-10-23 00:34：她整条只发了一个 @大狗嚼仙人）
      const bareBody = String(ans)
        .replace(/@(\d{5,12})/g, '')
        .replace(/@[\w一-龥]{1,30}(（@?\d{4,12}）)?/g, '')
        .replace(/（@?\d{4,12}）/g, '')
        .replace(/[\s，。！？~～!！?？.、…:：;；,'"“”()（）\-_*]/g, '');
      if (!bareBody) {
        console.log('[out] 只有 @ 没有正文，取消发送：' + String(ans).slice(0, 40));
        return;
      }
      // 她嘴上说「我记住了」但磁盘上其实什么都没写 → 立刻补写，用回执替掉那句空话
      const net = (canRemember && aimed) ? core.rememberNet(k, content, ans) : null;
      if (net) ans = core.memAck(net, who);
      // @ 时机 + @ 当名字（发言类回复公共规则层，主人 2026-10-23 收拢成一层）：
      // 5 秒内回的不 @；超 8 秒必须 @；5~8 秒随机；连着回同一个人只第一条 @。
      // 固定话术回复（wish/remember/触发词）走 sendFixedReply，同一层规则。
      ans = atNameConvert(applyAtTiming(ans, ev, turnStart, AT), ev);
      // 硬拦截：这一轮对方既没 @ 她、也没引用她 → 她不许说「你@我/你艾特我」（真事 2026-10-23：
      // 主人对群友说了句「为啥」，她答「你突然@我，还问我为啥」——主人根本没@她）
      if (!atMeReal && !replyMe) {
        const before2 = ans;
        ans = stripFalseAt(ans);
        if (before2 !== ans) console.log('[out] 这一轮没人@她/引用她，剥掉「你@我」：' + before2.slice(0, 30));
      }
      // 断续发送（v78）：对方这句话里有句号 → 这句回复大概率拆成几条连着发
      ans = splitOut(ans, content);
      // 引用谁（2026-11-22 主人定）：群里这一句到底在回「当前说话人」还是「被引用的那个人（原说话人）」。
      // 统一交给 pickQuoteTarget（纯函数、可测）：不再「只要有原说话人就强制引用那个人」，
      // 也不再只给主人算原说话人。顺序：模型标记 > 证据 > 默认（没原说话人就保持不引用）。
      const quoteOrigin = (replyOther && o.replyOrigin && !o.replyOrigin.self)
        ? { name: o.replyOrigin.nick, uid: o.replyOrigin.uid, msgId: o.replyOrigin.msgId, msgT: o.replyOrigin.msgT }
        : (talkTarget ? { name: talkTarget.name, uid: talkTarget.uid, msgId: talkTarget.msgId, msgT: talkTarget.msgT } : null);
      // 当前这条除了 @/引用本身，还有没有「自己的正文」（纯转发/纯 @ 她 → 只能是在答被引用那条）
      const _spkBody = String(content || '')
        .replace(/@\d{5,12}/g, '')
        .replace(/↩[^↩\n]{0,120}↩/g, '')
        .replace(/[\s\u3000]/g, '');
      const _qt = pickQuoteTarget({
        isPrivate,
        speaker: { uid: ev.user_id, name: who, msgId: ev && ev.message_id },
        speakerHasBody: !!_spkBody,
        origin: quoteOrigin,
        ans,
        hint: _qh.hint,
      });
      const replyId = _qt.id;
      if (replyId) console.log('[reply] 引用回复：' + replyId + '（'
        + (_qt.mode === 'origin' ? '原说话人「' + _qt.name + '」' : '当前说话人「' + who + '」') + '）');
      // 纯情绪回复换成单图（主人 2026-10-31 定）：对方这句是纯情绪、她自己要回的整句也是纯情绪
      //   （对方【哈哈】、她想回「哈哈哈」）→ 换成一张对应情绪的单图，不发文字；
      //   回的是正常句子（「这样就是最好的」）→ 照常发文字。
      //   上一条已经只发过图 → 驳回：图不发、话也不回。
      if (emotionOnly(content) && emotionOnly(ans) && !/[\[［]表情[:：]/.test(ans)) {
        const st2 = pickEmotionSticker(ans);
        if (st2) {
          const imgKey2 = imgKeyOf(ev, isPrivate);
          if (imgBlocked(imgKey2)) {
            console.log('[out] 上一条已经是图，这条纯情绪回复驳回（不发图、不回话）：' + st2);
            return;
          }
          console.log('[out] 纯情绪回复 → 换成单图：' + st2);
          const r2b = replyTo(ev, '[表情:' + st2 + ']', replyId ? { replyId } : undefined);
          if (r2b.text) {
            core.pushHist(k, 'assistant', r2b.text);
            // 6 分钟冷却从「真发出」起算（没发出去就不算回，下次还能回）
            if (pureMasterForce) masterForceAt.set(k, Date.now());
          }
          logSent(scope, r2b, replyTarget);
          markOut(imgKey2, true);
          if (!isPrivate) { lastSpoke.set(String(ev.group_id), Date.now()); bumpSpoke(ev.group_id); }
          return;
        }
      }
      const r2 = replyTo(ev, ans, replyId ? { replyId } : undefined);
      if (r2.text) {
        core.pushHist(k, 'assistant', r2.text);
        logSent(scope, r2, replyTarget);
        // 闹钟（2026-11-24 主人令）：她自己说的话里若有承诺 → 异步抽成闹钟；不阻塞这一轮发送。
        // 用 ans（发前原文，不含 @ 转换/引用壳）判定；来源记全：平台 / 群号 / 人 / 时刻。
        try {
          alarms.note(ans, {
            platform: 'qq',
            scope: isPrivate ? '私聊' + ev.user_id : ('群' + ev.group_id),
            groupId: isPrivate ? Number(ev.user_id) : Number(ev.group_id),
            userId: Number(ev.user_id),
            who: replyTarget || nameOf(ev),
            at: Date.now(),
          });
        } catch (e) { console.log('[闹钟] 挂判定出错（不影响回话）：' + (e && e.message || e)); }
        noteTalk(isPrivate ? 'p' + ev.user_id : 'g' + ev.group_id, cfg.botName, selfId, r2.text, true);
        // 6 分钟冷却从「真发出」起算：等他说完的窗口、以及生成耗时都不算进冷却
        if (pureMasterForce) masterForceAt.set(k, Date.now());
      } else core.aiFeedback('消息没发出去', '想回「' + String(ans).slice(0, 60) + '」但没发成（空回复）');
      markOut(imgKeyOf(ev, isPrivate), !r2.text);   // 只有图 → 记一笔「上一条是图」；有文字就清掉
      if (!isPrivate) { lastSpoke.set(String(ev.group_id), Date.now()); bumpSpoke(ev.group_id); }
    }, { onFail: function (info) { offlineNotice(ev, info); }, turn: turnCtx, agentTurn: _agentTurn });
  } finally { setThinking(false); }
  core.bumpExtract(k);
}

module.exports = { start, sendPrivate, injectClientMessage, _setCfg: c => { cfg = c; },
  _syncProfiles: syncProfilesOnce, _syncOneProfile: syncOneProfile, _knownGroupIds,   // 资料卡真实同步（自测/手动触发）
  qzonePostText,                                  // 日记同步到空间（主人点头后直接发，不判额度）
  _readNapcatVersion: readNapcatVersion, _probeQQChat: probeQQChat, _probeQzone: probeQzone,
  _healthSay: healthSay,   // 自测用：验「保健提醒这句话」到底能不能按人设生成出来
  _collectReportTitles: collectReportTitles,   // 自测用：保健提醒的「排次」和每日汇报同一份统计，要看数就调这个
  _stickerFiles: stickerFiles, _stickerHit: stickerHit, _stickerReconcile: stickerReconcile, _stickerOccasions: stickerOccasions,
  // 2026-11-01：收图公共口子（QQ + B站评论区共用同一套去重/清晰度/命名）
  _collectStickerBuf: collectStickerBuf, _collectSticker: collectSticker,
  _stickerGroups: stickerGroups, _stickerGroupOf: stickerGroupOf, _pickFromCands: pickFromCands,
  // 自测用
  _spamRepeat: spamRepeat, _collectFrag: collectFrag, _frag: frag, _looksLikeComment: looksLikeComment,
  _offlineNotice: offlineNotice, _fallbackSent: lastFallbackByScope, _chimeAllowed: chimeAllowed, _bumpSpoke: bumpSpoke, _saidToday: saidToday,
  _planWaitMs: planWaitMs, _pendingTalk: pendingTalk, _flushPendingTalk: flushPendingTalk,
  _onMessage: onMessage, _handleTurn: handleTurn, _onPoke: onPoke, _setSender: fn => { _sendHook = fn; },
  _send: sendAction,   // 自测用：验「发送唯一出口」的总闸（关闭/禁言），不真连 ws 时配合 _setSender
  _replyGroupCommand: replyGroupCommand,   // 自测用：验群指令回执走私聊（群开关）/ 回群里（其它）
  _splitOut: splitOut, _aimTargetFrom: aimTargetFrom, _nameOf: nameOf, _replyTo: replyTo,
  _stripQuoteJunk: stripEchoJunk, _atNameConvertRaw: atNameConvert,
  _noFakeJoin: noFakeJoin, _setSelfJoinAt: v => { selfJoinAt = Number(v) || 0; },
  _isBotUser: isBotUser, _looksBotMessage: looksBotMessage, _detectCriticism: detectCriticism,
  _isNewbie: isNewbie, _markNewbie: markNewbie, _looksLikeQuestion: looksLikeQuestion,
  _takeImgDescs: takeImgDescs, _stripForLearn: stripForLearn, _describeImgs: describeImgs,
  _parseSegments: parseSegments, _keepVideoRef: keepVideoRef, _recentVideoRef: recentVideoRef,   // 视频链路自测用
  _grpAutoTick: grpAutoTick, _grpAutoConsume: grpAutoConsume, _recordAt: recordAt, _isMasterUid: isMasterUid,
  _groupAtNeed: groupAtNeed, _greetOnii: greetOnii,
  _isHot: isHot, _autoNeed: autoNeed, _chainJoinAllowed: chainJoinAllowed, _stickerName: stickerName,
  _stickerMakeName: stickerMakeName, _stickerPool: stickerPool, _pickPoolByWeight: pickPoolByWeight,
  _stickerPHash: stickerPHash, _stickerMd5Load: stickerMd5Load, _stickerMd5Save: stickerMd5Save,
  _EMPTY_ANS: EMPTY_ANS, _buildAtSegments: buildAtSegments, _stripEchoFormat: stripEchoFormat, _repeatsOthers: repeatsOthers, _styleGate: styleGate, _replayAllowed: replayAllowed,
  _greetingHit: greetingHit, _greetGate: greetGate, _greetLast: greetLast,
  _qzoneOwnerInfo: qzoneOwnerInfo, _qzoneOwnerLines: qzoneOwnerLines, _platHomeUrl: platHomeUrl,
  _qzoneMaybePost: qzoneMaybePost, _qzoneTodayPlan: qzoneTodayPlan, _qzoneDayKey: qzoneDayKey, _typedAtOther: typedAtOther, _masterAimLine: masterAimLine,
  _masterChainLine: masterChainLine, _stripFalseAt: stripFalseAt,
  _rememberLastMsg: rememberLastMsg, _noteMasterTalk: noteMasterTalk, _masterTalkTarget: masterTalkTarget, _findLastMsgByNick: findLastMsgByNick,
  _pickQuoteTarget: pickQuoteTarget, _takeQuoteHint: takeQuoteHint, _stripQuoteHintTags: stripQuoteHintTags,
  _applyAtTiming: applyAtTiming, _atNameConvert: atNameConvert, _asksQQ: asksQQ, _sendFixedReply: sendFixedReply, _claimsDeleted: claimsDeleted, COMMON_REPLY_RULES: COMMON_REPLY_RULES, _qzoneNoteRepost: qzoneNoteRepost,
  _emotionOnly: emotionOnly, _emotionCategory: emotionCategory, _pickEmotionSticker: pickEmotionSticker, _autoTalkWorthy: autoTalkWorthy, _isKnownGroup: isKnownGroup,
  _stickerFiles: stickerFiles, _stickerHit: stickerHit, _stickerPool: stickerPool, _stickerMakeName: stickerMakeName, _pickPoolByWeight: pickPoolByWeight,
  _instantLog: instantLog, _noteTalk: noteTalk, _uidTag: uidTag, _setSelf: v => { selfId = String(v || ''); }, _isSelfSowingForward: isSelfSowingForward, _sheJustTalkedTo: sheJustTalkedTo, _noteHerTarget: noteHerTarget,
  // 群禁言（2026-11-05）：自测脚本要用，只读判断 + 事件入口，不暴露缓存本身
  _botMuted: botMuted, _muteLeftText: muteLeftText, _onGroupBan: onGroupBan, _muteStatus: muteStatus,
  // 图库认图（2026-11-05）：自测脚本要用
  _stickerLibHit: stickerLibHit, _stickerLibLabel: stickerLibLabel, _stickerLibRefresh: stickerLibRefresh, _hammingBits: hammingBits };
