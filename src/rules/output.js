/*
 * rules/output.js — 回话「输出判定」门面（按场景类惰性加载）
 *
 * 主人 2026-11-19 两条令：
 *   ①「记录和输出分开」→ 输出判定独立于 core.js / qq.js 的记录逻辑（本目录）。
 *   ②「做这么多是为了按需调用、减少消耗，不是标注下就算完成」→ 本文件**不再一次性
 *      建出全部判定函数**，而是按场景类拆到子文件，第一次真正用到才 require：
 *        · scene-h-chat.js  【H 全聊天】手打@识别 / 嫌我蠢 / 自动提问
 *        · scene-a-group.js 【A QQ群专属】锐评 / 限流 / 凑热闹 / 攒N条 / 热度 / 今日计数
 *      QQ 私聊为主的进程里，群类文件和它的 5 张 Map 一直是冷的；反过来只跑群、没触发
 *      「嫌我蠢」时，聊天类也不加载。
 *
 * 为什么能省：Node 的 require 是解析 + 编译 + 执行，模块越大启动越慢；状态 Map 也是
 *   第一次碰群级判定才分配。把冷门类挪出启动路径，加载量和常驻内存都降。
 *   （注：单次判定的 CPU 只有几十纳秒，省的主要是启动/加载与常驻内存，别把它吹成
 *     「每条消息快很多」——真实账本见 docs/回话规则分类清单-待核对.md 的实测。）
 *
 * 兼容性：createOutput(deps) 的签名与原有 29 个符号名一字不改，qq.js 用**同名解构代理**
 *   接住（见 qq.js 顶部），所以决策链里的调用点、守卫字符串、相对顺序全部不变。
 *   qq.js 里实际只用到一部分符号；没用到的（autoLog/spokeLog/dayKey/spokeState/
 *   hotUntil/randBetween/grpConf/grpAuto）仍在本门面上保留，供自测/面板按需取。
 */
const RECENT_MS = 5 * 60 * 1000;

// 【H 全聊天】类符号（第一次取用时才建 scene-h-chat）
const CHAT_SYMBOLS = [
  'typedAtOther', 'CRITIC_RE', 'detectCriticism',
  'AUTO_ASK_DEFAULT', 'NOT_QUESTION_RE', 'looksLikeQuestion',
];
// 【A QQ群专属】类函数
const GROUP_FN = [
  'looksLikeComment', 'autoAllowed', 'dayKey', 'spokeState', 'bumpSpoke', 'saidToday',
  'autoTalkWorthy', 'chimeAllowed', 'recordAt', 'isHot', 'randBetween', 'autoNeed',
  'grpAutoTick', 'grpAutoConsume', 'grpConf',
];
// 【A QQ群专属】类常量/状态表（RECENT_MS 只是数字常量，留在门面，读它不加载群类）
const GROUP_VALUE = ['COMMENT_RE', 'BANTER'];
const GROUP_MAP = ['autoLog', 'spokeLog', 'lastSpoke', 'grpAuto', 'hotUntil'];

// Map 的惰性视图：qq.js 里只会 .get/.set（计数/时间戳），换来「不碰群级判定就不分配 Map」。
function lazyMap(pick) {
  return {
    get(k) { return pick().get(k); },
    set(k, v) { pick().set(k, v); return this; },
    has(k) { return pick().has(k); },
    delete(k) { return pick().delete(k); },
    get size() { return pick().size; },
    forEach(fn, thisArg) { return pick().forEach(fn, thisArg); },
  };
}

function createOutput({ getCfg, cfgLive, guides } = {}) {
  const deps = { getCfg, cfgLive, guides };
  let chatMod = null;    // scene-h-chat 实例
  let groupMod = null;   // scene-a-group 实例
  const chat = () => chatMod || (chatMod = require('./scene-h-chat').createChat(deps));
  const group = () => groupMod || (groupMod = require('./scene-a-group').createGroup(deps));

  const api = { RECENT_MS };
  const def = (name, get) => Object.defineProperty(api, name, {
    get, enumerable: true, configurable: true,
  });

  for (const n of CHAT_SYMBOLS) def(n, () => chat()[n]);
  for (const n of GROUP_FN) def(n, () => group()[n]);
  for (const n of GROUP_VALUE) def(n, () => group()[n]);
  for (const n of GROUP_MAP) {
    let m = null;
    def(n, () => m || (m = lazyMap(() => group()[n])));   // 视图只建一次，身份稳定
  }

  // 自检/测试用：看哪一类已经真正加载（不是「有没有定义」，是「文件被 require 过没有」）
  api.loaded = () => ({
    chat: !!chatMod,
    group: !!groupMod,
    files: {
      chat: !!require.cache[require.resolve('./scene-h-chat')],
      group: !!require.cache[require.resolve('./scene-a-group')],
    },
  });
  return api;
}

module.exports = { createOutput, RECENT_MS, CHAT_SYMBOLS, GROUP_FN, GROUP_VALUE, GROUP_MAP };
