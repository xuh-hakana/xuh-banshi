/*
 * rules/scene-h-chat.js — 【分类 H · 全聊天】输出判定（私聊 / 群内 @ / 公开评论都算「聊天」）
 *
 * 职责：嫌我蠢认错、手打@识别、自动提问。都是「这一句话该怎么判」的即时判定，不写盘。
 * 场景：QQ 私聊、QQ 群（含被 @）、B站私信/评论——凡是有来有回的聊天都适用。
 *
 * 加载方式（主人 2026-11-19「按 A/H/B/D/E/F 分类、命中才加载」）：
 *   qq.js 不再在启动时 require 本文件；rules/output.js 里的门面在**第一次真正调用**
 *   本类函数时才 require + createChat()。纯群聊没用到「嫌我蠢」时不解析本文件。
 *   零依赖注入方式与 output.js 一致：cfg 用 Proxy 动态读 getCfg()，面板改数值即时生效。
 * 守卫：本文件被 tests/test-all.js 的 qqSrcWithOutput() 一起读（读取范围扩大，断言条件未改）。
 */
function createChat({ getCfg, cfgLive, guides }) {
  const cfg = new Proxy({}, {
    get: (_, k) => { const c = getCfg() || {}; return c[k]; },
    has: (_, k) => k in (getCfg() || {}),
  });

  // ============ 以下为原 rules/output.js 函数体，逐字搬运 ============

// 手打的「@昵称」（不是真 @ 段，没有 QQ 号数字）也算 @ 了别人：截图真事 2026-10-23 00:34，
// 群友手打「@yaksame …欢迎欢迎」欢迎别人，她以为在欢迎自己（新人期），插话还复读了对白。
// @ 的是她（昵称含「虚幻」）除外。真 @ 段是 @QQ号数字，在别处已经拦了。
function typedAtOther(text) {
  const ats = String(text || '').match(/@[^\s\d@，。！？~～!！?？.、…:：;；,''"“”()（）]{1,30}/g) || [];
  const mine = String((cfg && cfg.botName) || '').toLowerCase();
  return ats.some(x => {
    const nm = x.slice(1).toLowerCase().trim();
    if (!nm) return false;
    if (mine && (nm.includes(mine) || mine.includes(nm))) return false;   // @ 的是她
    return true;
  });
}

// 【分类 H·全聊天】嫌我蠢→认错 detectCriticism：群（非@）与私聊/@两条路都判。
// ===== 对方在嫌我蠢（截图真事：主人说「怎么感觉有点蠢」，它却回「主人是不是累了」）=====
// 「有点蠢」不是提问、不是心情低落，是在评价它刚才的表现——认错，不是关心。
const CRITIC_RE = /(有点?蠢|好蠢|太蠢|蠢爆|蠢材|好傻|太傻|傻逼|智障|弱智|逆天|离谱|抽象|阴间|迷惑|有大病|有病|尬住|好尬|翻车|搞砸|好憨|憨批|笨蛋|没用|废物|蠢得)/;
function detectCriticism(text, atMe, lastBotSpokeAt) {
  const t = String(text || '').trim();
  if (!CRITIC_RE.test(t)) return false;
  if (t.replace(/\s/g, '').length > 24) return false;    // 长文里的「蠢」多半不是在说我
  if (/[？?]/.test(t)) return false;                      // 带问号先当提问
  if (/@\d/.test(t)) return false;                        // 在 @ 别人，不抢
  if (typedAtOther(t)) return false;                      // 手打 @昵称（@小肥鱼）→ 骂的是那个人，不抢
  if (atMe) return true;                                  // 点名说她 → 一定是在说她
  // 没点名：她刚在这一小段时间里说过话，这话才可能是冲她去的；而且挑着接（主人 2026-10-22 定）
  const c = (cfg && cfg.critic) || {};
  const win = Number(c.windowMs || 10000);
  const p = Number(c.p != null ? c.p : 0.3);
  if (!lastBotSpokeAt || Date.now() - lastBotSpokeAt >= win) return false;
  return Math.random() < p;
}

// 【分类 H·全聊天】自动提问 looksLikeQuestion：主人裁「攒N条、自动提问＝全聊天场景」。
// ===== 群里不用 @ 也能自动接的提问（关键词 + 限流）=====
const AUTO_ASK_DEFAULT = /(怎样|怎么样|怎么|如何|啥样|啥|是啥|是什么|什么样|为什么|哪有|哪里|哪个|多少|几条|几级|几个|哪一种|是不是|能不能|会不会|有没有|吗|呢|\?|？)/;
// 抱怨/评价句式，不算提问：「怎么感觉有点蠢」「感觉有点怪」「好尬啊」
const NOT_QUESTION_RE = /(怎么)?(感觉|觉得)(有点?|好|太)?(蠢|傻|怪|奇怪|离谱|抽象|阴间|尬|尴尬|笨|呆|菜|迷惑)|(有点?|好|太)(尬|尴尬|怪|阴间|离谱|抽象|迷惑)/;
// 「怎么X了」＝问现状/惊讶（「怎么禁言了」＝发现被禁言了），不是 how-to 提问（「怎么禁言」）。
// 主人 2026-11-23 令：这种带「了」的不算问句，不触发自动接话/联网。
// 末尾不许带问号——「怎么禁言了？」是明确提问，照旧算问句；「怎么了」中间无字，也照旧算。
const PAST_TENSE_EXCL = /^怎么.{1,12}了\s*[。！!～~]?\s*$/;

function looksLikeQuestion(text) {
  const a = cfg.autoAsk || {};
  if (a.enabled === false) return false;
  const t = String(text || '').trim();
  if (t.length < (a.minLength || 5)) return false;
  // 「怎么感觉有点蠢」这种是抱怨/评价，不是提问（截图真事：被当成提问去联网搜，还答错了腔）
  if (NOT_QUESTION_RE.test(t)) return false;
  if (PAST_TENSE_EXCL.test(t)) return false;   // 新增 2026-11-23：「怎么X了」问现状，不是提问
  const re = Array.isArray(a.keywords) && a.keywords.length ? new RegExp(a.keywords.join('|')) : AUTO_ASK_DEFAULT;
  return re.test(t);
}

  return { typedAtOther, CRITIC_RE, detectCriticism, AUTO_ASK_DEFAULT, NOT_QUESTION_RE, PAST_TENSE_EXCL, looksLikeQuestion };
}

module.exports = { createChat };
