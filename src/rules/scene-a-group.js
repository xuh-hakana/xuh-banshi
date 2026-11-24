/*
 * rules/scene-a-group.js — 【分类 A · QQ 群专属】输出判定（群内自主回话的那一套）
 *
 * 职责：锐评附和、提问/锐评限流、凑热闹、吐槽围观、攒 N 条 + 被动热度、今日说话计数。
 * 场景：只在 QQ 群里生效（私聊不走这些闸）。群级状态表（autoLog/spokeLog/grpAuto/
 *       hotUntil/lastSpoke）也跟着本类走——私聊压根用不到，不用在启动时就分配。
 *
 * 加载方式（主人 2026-11-19「按 A/H/B/D/E/F 分类、命中才加载」）：
 *   qq.js 启动时不 require 本文件；rules/output.js 门面在**第一次碰群级判定**
 *   （如非 @ 群消息要过「攒够 N 条」闸）时才 require + createGroup()。
 *   私聊为主的进程里，本文件和这 5 张 Map 一直是冷的。
 * 零依赖注入：cfg 用 Proxy 动态读 getCfg()（面板改数值即时生效）；cfgLive() 现读文件。
 * 守卫：本文件被 tests/test-all.js 的 qqSrcWithOutput() 一起读（只扩读取范围，断言未改）。
 */
function createGroup({ getCfg, cfgLive, guides }) {
  const cfg = new Proxy({}, {
    get: (_, k) => { const c = getCfg() || {}; return c[k]; },
    has: (_, k) => k in (getCfg() || {}),
  });

  // ============ 以下为原 rules/output.js 函数体，逐字搬运 ============

// 【分类 A·群专属】锐评附和 looksLikeComment：群块 + isBoss（只认主人/欧尼酱），仅群内。
// ===== 锐评附和（主人 2026-10-22 定）=====
// 主人说「白河豚是这样的」这种**下判断**的短句时，希望接一句「还真是」。
// 和「提问自动接」分开：这个不需要疑问词，但只认主人和欧尼酱，且要过同一套限流。
const COMMENT_RE = /(是这样的|就是这样|都这样|这德行|就这水平|也就那样|果然|早就说过|难怪|笑死|绷不住|典中典|逆天)/;

function looksLikeComment(text) {
  const a = (cfg && cfg.autoAsk) || {};
  if (a.enabled === false) return false;
  const t = String(text || '').trim();
  if (t.length < 4 || t.length > 80) return false;
  if (/[？?]/.test(t)) return false;                 // 带问号的是提问，走 autoAsk
  return COMMENT_RE.test(t);
}

// 【分类 A·群专属】提问/锐评共用限流 autoAllowed：按 gid 计数，仅群内。
const autoLog = new Map();      // gid -> [时间戳]，防刷屏
function autoAllowed(gid) {
  const a = cfg.autoAsk || {};
  const now = Date.now();
  const arr = (autoLog.get(gid) || []).filter(t => now - t < 60000);
  if (arr.length >= (a.maxPerMinute || 3)) return false;
  if (arr.length && now - arr[arr.length - 1] < (a.cooldownMs || 12000)) return false;
  arr.push(now);
  autoLog.set(gid, arr);
  return true;
}

// 【分类 A·群专属】凑热闹 chimeAllowed：只传 gid、按群计数+概率，仅群内。
// ===== 凑个热闹（主人 2026-10-22 定）=====
// 主人两次口径：先说「300 多条消息只回 1 句，至少 3-10 句」，后改成「500 里面 30-80」。
// 现在默认按 500 条/天 → 30~80 句 调（p=0.11 ≈ 每 9 句搭一句）。
// 前面几条路都要求「像提问 / 被吐槽 / 主人锐评」，普通的聊天她一句都插不上，
// 所以给她一条**随机的**口子：群里正常聊天，按概率搭一句。
// 用「每群每天最多几句 + 两条之间至少隔多久」压住，不会变成刷屏。
const spokeLog = new Map();      // gid -> { day:'2026-10-22', n:今日说过几句, at:上次说话时间 }

function dayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function spokeState(gid) {
  const key = String(gid);
  let s = spokeLog.get(key);
  if (!s || s.day !== dayKey()) { s = { day: dayKey(), n: 0, at: 0 }; spokeLog.set(key, s); }
  return s;
}
function bumpSpoke(gid) {
  if (!gid) return;
  const s = spokeState(gid);
  s.n++;
  s.at = Date.now();
}
function saidToday(gid) { return spokeState(gid).n; }

// ===== 自由搭话闸（主人 2026-10-23 凌晨定）=====
// 没人叫她、自己凑热闹（chime）那条路：这句话里必须有「能搜到的关键词」
// （自有梗库/梗词典的特征词，或英文/数字这类基本能搜的词），
// 或者是确实存在、能查到原文的梗。没有 → 安静等下一条消息。
// 被@/回复不在这里管（它们由纯情绪闸和提示词管）；骰子/笑点解析/攻略是功能触发，不受限。
function autoTalkWorthy(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (guides.memeWordHit(t)) return true;      // 梗：有据可查（自有热梗 + 梗词典 1455 条）
  if (/[a-zA-Z0-9]{2,}|\d+(?:\.\d+)+/.test(t)) return true;  // 英文/数字词（游戏名、版本号 1.3）基本都能搜到
  return false;
}

function chimeAllowed(gid, text) {
  const c = cfgLive().chime || {};
  if (c.enabled === false) return false;
  const t = String(text || '').trim();
  if (!autoTalkWorthy(t)) return false;        // 自由搭话：没关键词没梗就不搭（主人 2026-10-23 定）
  if (t.replace(/\s/g, '').length < (c.minLength || 4)) return false;
  if (/^[.。]/.test(t)) return false;                       // 骰子 / 指令
  if (/^(在吗|在么|在不在|人呢)[?？吗啊呀]*$/.test(t)) return false;  // 这是叫她的，走正常流程
  const st = spokeState(gid);
  const now = Date.now();
  if (st.at && now - st.at < (c.cooldownMs || 180000)) return false;
  if (st.n >= (c.dailyMax || 80)) return false;
  // 一天快过完了、这个群里她还没说够 3 句 → 概率临时调高，把量补回来
  let p = Number(c.p || 0.11);
  if (new Date().getHours() >= (c.warmupHour || 20) && st.n < (c.warmupMin || 30)) {
    p = Number(c.warmupP || 0.16);
  }
  return Math.random() < p;
}

// ===== 群里被围观/被吐槽：刚说过话就有人吐槽「你俩」，要接住（主人 2026-10-22 定）=====
// 【分类 A·群专属】吐槽围观 BANTER：两处触发都带 !isPrivate，仅群内。
const BANTER = /(演起来|你俩|你们两个|你两|俩人|秀恩爱|什么机器人|这机器人|这ai|笑死|受不了你们|好家伙|自导自演)/i;
const lastSpoke = new Map();     // gid -> 上次在这个群说话的时间

// ===== 非@自主回复按整个群节流（主人 2026-10-22：每隔 4~20 条消息才触发一次）=====
// 群里没 @ 她的消息按整个群计数，攒够 min~max 条（config.grpAuto，默认 15~20；每次触发后重新随机）
// 才允许一次自主回复；优先级高于「对人的非@回复」（附和/吐槽/凑热闹都要先过这道闸）。「适合回复」白名单除外。
// 被@状态（主人 2026-10-22 改定）：**只要被 @ 一次**（含引用她），阈值就临时降到 hotMin~hotMax 条
//（默认 4~10），状态持续 hotMsMin~hotMsMax（默认 0.3~2 分钟，每次随机）。
// 这套和「话多降档」（chime 的概率/冷却/日上限）**互相独立**：偶尔自主搭话有上限，但被@后的状态不受它影响。
const grpAuto = new Map();       // gid -> { count, need }
const hotUntil = new Map();      // gid -> 被@状态的截止时间戳
const RECENT_MS = 5 * 60 * 1000;
// 【分类 A·群专属】攒N条 + 被动热度 grpAuto/grpAutoTick：按 gid 攒够才自主回，仅群内。
function grpConf() { return cfgLive().grpAuto || {}; }
function recordAt(gid) {
  const c = grpConf();
  const dur = randBetween(
    Number(c.hotMsMin != null ? c.hotMsMin : 18000),
    Number(c.hotMsMax != null ? c.hotMsMax : 120000)
  );
  hotUntil.set(String(gid), Date.now() + dur);
}
function isHot(gid) { return Date.now() < (hotUntil.get(String(gid)) || 0); }
function randBetween(a, b) { const lo = Math.min(a, b); return lo + Math.floor(Math.random() * (Math.max(a, b) - lo + 1)); }
function autoNeed(gid) {
  const c = grpConf();
  return isHot(gid)
    ? randBetween(Number(c.hotMin != null ? c.hotMin : 4), Number(c.hotMax != null ? c.hotMax : 10))
    : randBetween(Number(c.min != null ? c.min : 15), Number(c.max != null ? c.max : 20));
}
function grpAutoTick(gid) {
  const key = String(gid);
  let st = grpAuto.get(key);
  if (!st) { st = { count: 0, need: autoNeed(gid) }; grpAuto.set(key, st); }
  st.count += 1;
  return st.count >= st.need;
}
function grpAutoConsume(gid) {
  grpAuto.set(String(gid), { count: 0, need: autoNeed(gid) });
}

  return {
    COMMENT_RE, looksLikeComment, autoAllowed, autoLog, spokeLog, dayKey, spokeState,
    bumpSpoke, saidToday, autoTalkWorthy, chimeAllowed, BANTER, lastSpoke, RECENT_MS,
    grpAuto, hotUntil, grpConf, recordAt, isHot, randBetween, autoNeed, grpAutoTick, grpAutoConsume,
  };
}

module.exports = { createGroup };
