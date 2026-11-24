'use strict';
/*
 * src/health-remind.js —— 定时保健提醒：在测试群按工作日/休息日两种场景，随机时刻提醒主人和欧尼酱活动身体。
 * 这是干什么的：把「什么日子、几点、提醒谁、说哪句」全部算好，再交给 qq.js 发送；本文件不直接连 QQ。
 *
 * 为什么单独一份：场景判定、动作去重、每周配额、节假日日历、按人约定覆盖是同一件事的五个环节，
 * 放一起才不会出现「开关在 A、判定在 B、状态在 C」那种对不上的情况。
 *
 * 说哪句话**不由本文件决定**（她 2026-11-11 定：「给动作添加话术的形式不需要，如何说话应该由人设决定，
 * 但也需要当场一次普通的 llm 发起的会话，而不是机器回话」）。本文件只挑「这一跳做哪个动作」，
 * 句子交给 qq.js 注入的 say()——它走 core.buildMessages + core.callLLM，和人设、记忆、风格是同一套。
 * 预写话术池已经删掉（config 里每个动作只剩 act 一个字段）。LLM 两次都不出话时只发动作名兜底，
 * 因为「提醒是必须的」；兜底不冒充人设语气、也不拼模板。
 *
 * 数据只有三份，都不手写：
 *   src/config/features.json         的 healthRemind 段 = 所有开关、时间、数量、四个动作池（面板可改，热读）
 *   src/data/health-remind-state.json = 当天已发次数/已做过的动作/下一跳时刻/本周配额（运行时生成，重启不丢）
 *   src/data/health-holidays.json     = 联网拉来的全年法定节假日缓存（断网用旧的，再不行按星期）
 *
 * 什么时候发只有一条规则：被提醒的人在这个群说话 → 等 speakDelayMin 分钟 → 发一条 → 他进 minGapMin 冷却。
 * 没人说话就不发（2026-11-23 23:25 她「没人说话就不发，全修好」）。
 * 轮询粒度 tickIntervalSec 在配置里，面板可改。
 *
 * 约定高于默认规则：core.addonOf(uid,'healthRemind') 的单人设置优先于 features.json。
 * 只对单人生效：两人设置不同就拆成两条各 @ 各的，绝不把一个人的改动套到另一个人身上。
 */

const fs = require('fs');
const path = require('path');
const configStore = require('./config');
const net = require('./net');
const core = require('./core');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'health-remind-state.json');
const HOLIDAY_PATH = path.join(DATA_DIR, 'health-holidays.json');

let _send = null;          // qq.js 注入：(gid, bodyText) => true/false，body 里的 @数字 由发送层转成 at 段
let _say = null;           // qq.js 注入：async ({gid,act,xMin,scene,extra,uids}) => 这句话；走人设 + 普通 LLM 会话
let _countChanges = null;  // qq.js 注入：(fromMs,toMs) => 这段时间真改过的模块数（与每日汇报同一份统计）
let _ready = null;         // qq.js 注入：() => QQ 是否连着；断线时不生成（一次提醒就是一次真模型调用）
let _timer = null;
let _busy = false;         // 一跳还在生成/发送时，1 秒轮询不许再起一跳（LLM 要几秒）
let _holidayRefreshing = false;
// 触发源：被提醒的人在目标群说话（内存即可，重启后等下一次说话）。
// 她 2026-11-23 定：「间隔改成按照被提醒的人在当前群说话算，此人说话后间隔 6 分钟发，随后进冷却」。
// 20:58 补：「短时间的冷却内一起说话就一起 @」—— 同一轮等待窗里说话的都攒进 uids，发的时候一起 @；
// 时刻 at 只按第一句算，后面接话的人不会把这条往后拖。
let _speak = { at: 0, uids: [], gid: 0 };

/* ---------- 小工具 ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function minuteOf(d) { return d.getHours() * 60 + d.getMinutes(); }
// 本周一 = 一周的键。周一~周日算同一周，跨周自动重置配额。
function weekKey(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7;            // 周日(0) → 6，周一(1) → 0
  x.setDate(x.getDate() - back);
  return dayKey(x);
}
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || fallback; } catch { return fallback; }
}
function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) { console.log('[保健提醒] 状态写不进：' + e.message); }
}

/* ---------- 法定节假日 ----------
 * 主源 publicapi.xiaoai.me：daytype 0 工作日 / 1 节假日 / 2 双休日 / 3 调休补班（要上班）
 * 备源 api.jiejiariapi.com：isOffDay true 放假 / false 不放假
 * 两个都是公开 JSON 接口（不是抓网页），失败就用本地缓存，连缓存都没有就只按星期判断。
 */
function holidayCache() { return readJson(HOLIDAY_PATH, { year: 0, at: 0, days: {} }); }

async function refreshHolidays(year) {
  if (_holidayRefreshing) return;
  _holidayRefreshing = true;
  const h = configStore.cfgLive().healthRemind || {};
  const cache = holidayCache();
  const freshEnough = cache.year === year && cache.days
    && Object.keys(cache.days).length > 0
    && Date.now() - (cache.at || 0) < num(h.holidayCacheDays, 7) * 86400000;
  if (freshEnough) { _holidayRefreshing = false; return; }

  const url = String(h.holidayUrl || '').replace('{year}', year);
  const bak = String(h.holidayBackupUrl || '').replace('{year}', year);
  let days = null, used = '';
  for (const u of [url, bak]) {
    if (!u) continue;
    try {
      const j = await net.getJson(u, { timeout: 8000 });
      if (u === url && j && j.code === 0 && Array.isArray(j.data)) {
        const out = {};
        for (const x of j.data) {
          if (!x || !x.date) continue;
          const t = Number(x.daytype);
          out[x.date] = { off: t === 1 || t === 2, makeup: t === 3, name: String(x.holiday || '') };
        }
        days = out;
      } else if (u === bak && j && typeof j === 'object' && !Array.isArray(j)) {
        const out = {};
        for (const k of Object.keys(j)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !j[k]) continue;
          out[k] = { off: !!j[k].isOffDay, makeup: false, name: String(j[k].name || '') };
        }
        days = out;
      }
      if (days && Object.keys(days).length) { used = u; break; }
    } catch (e) { console.log('[保健提醒] 节假日接口没拉到（' + u + '）：' + e.message); }
  }
  if (days && Object.keys(days).length) {
    writeJson(HOLIDAY_PATH, { year, at: Date.now(), days, source: used });
    console.log('[保健提醒] ' + year + ' 年节假日日历已缓存 ' + Object.keys(days).length + ' 天');
  } else {
    console.log('[保健提醒] 节假日接口都不可用，按星期判断（有旧缓存就继续用旧缓存）');
  }
  _holidayRefreshing = false;
}

/* ---------- 场景判定 ----------
 * 工作日 = 周一~周五 + 周日（周日是欧尼酱的工作日，她 2026-11-09 明确），且不是法定放假日。
 * 工作日 14:00–22:00 → 'work'（久坐场景，主池A）；其余非静默时间 → 'rest'（体态场景，主池B）。
 * 4:00–9:00 全静默，任何日子都不发。
 */
/* ---------- 不提醒段（静默）----------
 * 她 2026-11-23 把「不提醒开始」填成 24（＝ 0 点开始、9 点结束）。旧代码直接乘 60 当分钟用，
 * qs 变成 1440，`min >= 1440` 永远不成立 → 静默段整个失效，24 点后照发。所以这里先把小时归一化到 0~23。
 * 三种关系都要认：qs<qe（当天内）、qs>qe（跨天，例如 22→9）、qs===qe（不静默）。
 */
function quietRange(h) {
  const qs = num(h.quietStartHour, 4) % 24, qe = num(h.quietEndHour, 9) % 24;
  return { qs, qe };
}
function inQuiet(min, h) {
  const { qs, qe } = quietRange(h);
  if (qs === qe) return false;
  return qs < qe ? (min >= qs * 60 && min < qe * 60)
    : (min >= qs * 60 || min < qe * 60);          // 跨天：qs→24:00 与 00:00→qe 两段都算
}
function quietMinutes(h) {
  const { qs, qe } = quietRange(h);
  if (qs === qe) return 0;
  return qs < qe ? (qe - qs) * 60 : (1440 - qs + qe) * 60;
}

function sceneAt(d, h, hol) {
  const min = minuteOf(d);
  if (inQuiet(min, h)) return null;                             // 静默
  const wd = Array.isArray(h.workdays) ? h.workdays.map(Number) : [0, 1, 2, 3, 4, 5];
  let isWorkday = wd.indexOf(d.getDay()) >= 0;
  const info = (hol && hol.days) ? hol.days[dayKey(d)] : null;
  if (info) {
    if (info.off) isWorkday = false;                           // 法定节假日 → 休息日场景
    else if (info.makeup && num(h.makeupAsWorkday, 0) === 1) isWorkday = true; // 补班日按工作日（可调）
  }
  const ws = num(h.workStartHour, 14) * 60, we = num(h.workEndHour, 22) * 60;
  return (isWorkday && min >= ws && min < we) ? 'work' : 'rest';
}

/* ---------- 动作（只挑动作，不挑句子）----------
 * 她 2026-11-11 定：不给动作配预写话术，怎么说话由人设决定。所以这里只回答「这一跳做哪个动作」，
 * 句子交给当场一次普通 LLM 会话（见下面的 sayLine）。同一天尽量不重复同一个动作；
 * 池子比当天的条数还少时才允许重来一轮（不重复发同一句是旧功能，这里保的是「不重复同一个动作」）。
 */
function actsOf(pool) {
  const out = [];
  for (const it of (Array.isArray(pool) ? pool : [])) {
    if (!it) continue;
    const a = String(it.act || it.text || '').trim();
    if (a) out.push(a);
  }
  return out;
}
/* used = 今天已经发过的动作；recent = 最近发过的动作（跨天不清，存状态文件）。
 * 为什么要有 recent：她 2026-11-11 说「为什么两次都是提臀，应该随机，不要按顺序」。
 * 抽签本身是均匀随机（pick = Math.random 取下标，没有游标、不按顺序），
 * 但只防「当天重复」→ 昨天抽中的今天照样能再抽中，看上去就像在轮着来。所以加一层跨天记忆。
 * 排除范围取「本池里最近的 n-1 个」：池子只有 6 个时也不会把整池排掉、永远有得选，
 * 同时保证连续 n-1 条不会撞同一个动作。
 */
function chooseAct(h, scene, extra, used, recent) {
  const key = extra
    ? (scene === 'work' ? 'extraWork' : 'extraRest')
    : (scene === 'work' ? 'mainWork' : 'mainRest');
  let acts = actsOf(h[key]);
  if (!acts.length) acts = actsOf(scene === 'work' ? h.mainWork : h.mainRest);   // 补充池空 → 退回主池
  if (!acts.length) return '';
  const list = Array.isArray(used) ? used : [];
  const seen = (Array.isArray(recent) ? recent : []).filter(a => acts.indexOf(a) >= 0);
  const keep = Math.max(0, Math.min(seen.length, acts.length - 1));
  const block = seen.slice(seen.length - keep);
  // 三档放宽，任何一档非空就停：① 今天没发过 且 最近没发过 → ② 只排除今天 → ③ 今天清空重来（只避最近）
  let free = acts.filter(a => list.indexOf(a) < 0 && block.indexOf(a) < 0);
  if (!free.length) free = acts.filter(a => list.indexOf(a) < 0);
  if (!free.length) { list.length = 0; free = acts.filter(a => block.indexOf(a) < 0); }
  if (!free.length) free = acts.slice();
  return pick(free);
}

/* ---------- 这一句怎么来：当场一次普通 LLM 会话 ----------
 * 最多试 3 次（她 2026-11-23 要求「大概多久以后做」必须出现，多给一次生成机会）。
 * 为什么保留兜底：她明确「提醒是必须的」——不能因为模型没接上就一条都不发。
 * 兜底只发动作名本身，不套模板、不冒充她的语气（她说「不是机器回话」，那就宁可只给动作）。
 */
async function sayLine(o) {
  if (!_say) return o.act;                       // 没注入生成器：提醒照发，只给动作名
  for (let i = 0; i < 3; i++) {
    try {
      // attempt 传下去：第二次生成时让生成器知道「上一句不合格」，换更强的话再说一遍
      const t = String((await _say(Object.assign({}, o, { attempt: i }))) || '').trim();
      if (t) return t;
      console.log('[保健提醒] 第 ' + (i + 1) + ' 次没生成出话' + (i ? '' : '，重试一次'));
    } catch (e) {
      console.log('[保健提醒] 生成失败（第 ' + (i + 1) + ' 次）：' + e.message);
    }
  }
  return o.act;
}

/* ---------- 按人约定 ----------
 * 返回 [{uids:[...], override}] 分组。两人设置一致 → 一条同时 @；不一致 → 各发各的。
 * 某人 enabled=false → 整组不出现，等于只关掉他一个人的提醒（约定高于默认开关）。
 */
function groupsFor(atUids) {
  const map = new Map();
  for (const uid of atUids) {
    if (!uid) continue;
    let ov = null;
    try { ov = core.addonOf(String(uid), 'healthRemind'); } catch { ov = null; }
    if (ov && ov.enabled === false) continue;
    const key = JSON.stringify(ov || {});
    if (!map.has(key)) map.set(key, { uids: [], override: ov });
    map.get(key).uids.push(String(uid));
  }
  return Array.from(map.values());
}
/* atKeys 里两项都能写：connect.json 的键名（masterQQ / oniiQQ），或直接写 QQ 号。
 * 她 2026-11-23 要把群友直接加进来（「加入 1000000002、和另一个 o 开头的群友」），
 * 写号不用先去 connect.json 造一个键名。 */
function atUidsOf(h, fullCfg) {
  const keys = Array.isArray(h.atKeys) ? h.atKeys : ['masterQQ', 'oniiQQ'];
  const out = [];
  for (const k of keys) {
    const s = String(k == null ? '' : k).trim();
    if (!s) continue;
    if (/^\d{5,12}$/.test(s)) { out.push(s); continue; }      // 直接写号
    if (fullCfg[s]) out.push(String(fullCfg[s]));
  }
  return Array.from(new Set(out));
}

/* ---------- 触发源：被提醒的人在目标群说话 ----------
 * 她 2026-11-23 定：「间隔改成按照被提醒的人在当前群说话算，此人说话后间隔 6 分钟发，随后进冷却」。
 * 四个条件全满足才算一次有效触发：
 *   ① 是目标群；② 说话的人在被 @ 名单里；③ 不在静默段；④ 不在冷却期
 *   （冷却中说的话不作数 —— 否则冷却一结束就会因为那句老话立刻发一条）。
 * 时刻只放内存：重启后等下一次说话，不值得为它写状态文件（这个群消息不少）。
 */
function noteSpeak(gid, uid, atMs) {
  try {
    const full = configStore.cfgLive();
    const h = full.healthRemind || {};
    if (!h.enabled) return false;
    const target = num(h.groupId, 0) || num(full.testGroup, 0);
    if (!target || Number(gid) !== Number(target)) return false;
    if (atUidsOf(h, full).indexOf(String(uid)) < 0) return false;
    const now = new Date(num(atMs, Date.now()));
    if (!sceneAt(now, h, holidayCache())) return false;             // 静默段说话不算
    const st = readJson(STATE_PATH, {});
    /* 冷却按人算（她 2026-11-23 20:58：「1.5 小时是针对个人的」）。
     * 原来用的是全局 state.lastSentAt：谁发完都一起冷却 1.5 小时，A 刚被 @ 过，B 说话也不给发。
     * 现在每人一条记录：这个人自己被 @ 之后 1.5 小时内说话不算数，别人不受影响。 */
    const cool = (st.cool && typeof st.cool === 'object') ? st.cool : {};
    const gapMs = Math.max(1, num(h.minGapMin, 30)) * 60000;
    if (now.getTime() - num(cool[String(uid)], 0) < gapMs) return false;  // 这个人自己在冷却
    /* 这一轮还没发出去（at > 0，发出/日切都会清空）时又有人说话 → 一起 @ 上他。
     * 她 2026-11-23 20:58：「短时间的冷却内一起说话就一起 @」。
     * 不重置 at：等待时间仍从第一句算，不然一直有人接话就永远发不出去。 */
    const at = num(_speak.at, 0);
    const cur = Array.isArray(_speak.uids) ? _speak.uids.slice() : [];
    /* 这一轮如果一直发不出去（排次已满 / 那人进冷却 / 发送反复失败），会永远挂着不散，
     * 后果是此后所有人说话都被吞进那一轮、连日志都不打 —— 她 2026-11-23 23:15「怎么没生效」
     * 就是这个：21 点攒的那轮卡到 23 点，她 23:13 在群里说话没有任何记录。
     * 所以一轮最多挂 30 分钟（且至少是等待时间的 3 倍），超了就作废、按新的第一句重开。 */
    const stale = at > 0 && now.getTime() - at > Math.max(30 * 60000, num(h.speakDelayMin, 2) * 60000 * 3);
    if (at && !stale) {
      if (cur.indexOf(String(uid)) < 0) {
        cur.push(String(uid));
        _speak = { at, uids: cur, gid: Number(gid) };
        console.log('[保健提醒] ' + uid + ' 这轮也在群里说话 → 这条一起 @（共 ' + cur.length + ' 人：' + cur.join('、') + '）');
      }
      return true;
    }
    _speak = { at: now.getTime(), uids: [String(uid)], gid: Number(gid) };
    console.log('[保健提醒] ' + uid + ' 在群 ' + gid + ' 说话 → ' + num(h.speakDelayMin, 2) + ' 分钟后发一条');
    return true;
  } catch (e) {
    console.log('[保健提醒] 记「谁说话了」失败：' + e.message);
    return false;
  }
}

/* ---------- 主动消息发哪个群 ----------
 * 她 2026-11-23：「把每日上线提醒也改到这个群」。上线日报（src/daily-stats.js）/ 开发汇报 / 保健提醒
 * 三条主动消息共用这一个群号：改 features.json 的 healthRemind.groupId 一处，三条一起变，
 * 不再各写一个群号（以前都写死 cfg.testGroup 1000000004）。
 */
function targetGroup() {
  try {
    const full = configStore.cfgLive();
    const h = full.healthRemind || {};
    return num(h.groupId, 0) || num(full.testGroup, 0) || 0;
  } catch { return 0; }
}

/* ---------- 本周非主池配额 ----------
 * 每周至少 weeklyExtraMin 条用补充池。她 2026-11-23 点名「设的最少 1，实际从未触发过」——
 * 旧版只靠 chances <= need 兜底（chances 恒约 177），等于每次 12% 撞运气，十天一条没中。
 * 现在分成硬保证 + 平时穿插：
 *   ① 本周剩余天数（含今天，周一=7 / 周日=1）<= 还差的条数 → 没得挑，这一条必用补充池；
 *   ② 剩余天数 <= 还差条数 × 2 → 再挑就来不及了，也必用；
 *   ③ 其余时间按概率穿插，补充池不会全堆在最后一天。
 * 计数只在「真抽到补充池动作」时才加，见 tickAt 的 usedExtra（抽空退回主池不算达标）。
 */
function wantExtra(state, now, h) {
  const need = Math.max(0, num(h.weeklyExtraMin, 1) - num(state.week && state.week.extraSent, 0));
  if (need <= 0) return false;
  const gap = Math.max(1, num(h.minGapMin, 30));
  const daysLeft = 7 - ((now.getDay() + 6) % 7);            // 含今天：周一 7 …… 周日 1
  if (daysLeft <= need * 2) return true;                     // ①② 硬保证，不靠运气
  // 从现在到本周日还剩多少个可发机会（粗估，扣掉每天的静默段）
  let minsLeft = 0;
  for (let off = 0; off < daysLeft; off++) {
    const perDay = 24 * 60 - (num(h.quietEndHour, 9) - num(h.quietStartHour, 4)) * 60;
    minsLeft += off === 0 ? Math.max(0, perDay - minuteOf(now)) : perDay;
  }
  const chances = Math.max(1, Math.floor(minsLeft / (gap * 1.5)));
  return Math.random() < Math.min(0.8, need / chances + 0.12);
}

/* ---------- 发送时机只有一个：被提醒的人开口 ----------
 * 她 2026-11-23 20:36 定「按说话触发，说完 2 分钟后发」；22 日那句「只有随机挑个时间段 @」
 * 之外的时间驱动、保底补发全部作废 —— 没人说话就不发。
 * 所以这里不再有「下一跳随机点」「窗口末尾硬补」「随机时间段保底」三套排点：
 *   jumpAt / nextAt / minGuard / randomSendAt / forceAt 全部删掉（2026-11-23 23:25，她「全修好」）。
 * 想改「说完多久发」改 speakDelayMin；想改「一天最多几条」改 minGapMin（一天的量 = 可发时段 ÷ 它）。
 */

/* ---------- 一天的量（浮动，不写死）----------
 * 她 2026-11-23：「不是这个数（面板一天最多 12），我刚刚改了时间段，这个上限是浮动的」→
 * 一天的量 = 可发时段 ÷ 两条之间最少隔多少分钟。可发时段 = 全天扣掉「不提醒段」。
 * 现在 9:00 → 次日 4:00 共 1140 分钟 ÷ 30 = 38 次；改不提醒段或改最小间隔，这个数自动跟着变。
 * 不用面板 dailyMax：那个数是死的，会替她决定发多少，和「浮动」正好相反。
 */
function dayCapOf(h) {
  const gap = Math.max(1, num(h.minGapMin, 30));
  return Math.max(1, Math.floor((24 * 60 - quietMinutes(h)) / gap));
}

/* ---------- 当天排几次 ----------
 * 她 2026-11-23 定：「读一次改动的数量，作为当日的排次。数量超出 1 天的量就进后面的天数。
 * 如果是 0 那就当天随机发一次，然后记 -1，第二天加上 -1」。
 *   changes = 昨天真改过的模块数（与每日汇报 collectReportTitles 同一份统计）
 *   prevCarry = 昨天结转下来的（正=排不下顺延，负=昨天那条是借的）
 *   dayCap = 一天的量，见 dayCapOf（按时间段浮动，不是面板那个死数）
 * 超量 → 排 dayCap，剩下的顺延给明天；不足 1 条 → 当天照样发一次，记 -1 明天抵。
 */
function planDay(changes, prevCarry, dayCap) {
  let quota = num(changes, 0) + num(prevCarry, 0);
  let carry = 0;
  if (quota > dayCap) { carry = quota - dayCap; quota = dayCap; }
  else if (quota <= 0) { quota = 1; carry = -1; }
  return { quota, carry };
}

/* ---------- 每次轮询一跳 ----------
 * 这一跳要等 LLM 出话（几秒），所以是 async；轮询是 1 秒一次，用 _busy 挡住重入。
 */
async function tickAt(now) {
  if (_busy) return { skip: '上一跳还在生成/发送' };
  _busy = true;
  try {
    const full = configStore.cfgLive();
    const h = full.healthRemind || {};
    if (!h.enabled) return { skip: '总开关关着' };
    now = now || new Date();
    const today = dayKey(now);
    const hol = holidayCache();
    if (hol.year !== now.getFullYear() || Date.now() - (hol.at || 0) > 86400000) {
      refreshHolidays(now.getFullYear());                     // 异步，不阻塞这一跳
    }

    let state = readJson(STATE_PATH, {});
    if (state.day !== today) {
      /* 0 点结算：读「昨天整天」真改过的模块数，算今天排几次（她 2026-11-23 定）。
       * 一天只读一次（就在日切这里），不跟着 1 秒轮询反复扫目录。
       * 改动数读不到（没注入/扫描失败）就沿用上次记下的值，不让一天突然变成 0 条。 */
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const prevCarry = num(state.carry, 0);
      let changes = null;
      try {
        if (_countChanges) changes = Number(_countChanges(todayStart - 86400000, todayStart));
      } catch (e) { console.log('[保健提醒] 读改动数失败：' + e.message); }
      if (!Number.isFinite(changes)) changes = num(state.changes, 0);
      // 一天的量按当前时间段现算（她 2026-11-23：上限是浮动的，不是面板那个 12）
      const dayCap = dayCapOf(h);
      const plan = planDay(changes, prevCarry, dayCap);
      state = Object.assign({}, state, {
        day: today, sentToday: 0, used: [], model: 3,
        changes, cap: dayCap, quota: plan.quota, carry: plan.carry,
      });
      writeJson(STATE_PATH, state);                         // 新一天的状态立刻落盘，重启不重复结算
      _speak = { at: 0, uids: [], gid: 0 };                  // 昨天的说话不带到今天（否则 0 点一到就发）
      console.log('[保健提醒] 昨天改动 ' + changes + ' 项、结转 ' + prevCarry + '、一天的量（可发时段÷最小间隔）' + dayCap
        + ' → 今天排 ' + plan.quota + ' 次'
        + (plan.carry ? '（结转明天 ' + plan.carry + '）' : '')
        + (changes === 0 ? '（昨天没有改动，今天照样发一次，记 -1）' : ''));
    }
    // model<3 的老状态：used 存的是句子，现在存动作名，一次性清空（不清也不会错，只是白占地方）。
    if (state.model !== 3) {
      state.model = 3;
      state.used = [];
      writeJson(STATE_PATH, state);
    }
    if (!Array.isArray(state.used)) state.used = [];
    // 跨天记忆：不清空（清了就回到「昨天发过的今天还能再发」，她 2026-11-11 点名过这件事）。
    // 首次没有这个字段时，用今天已发过的动作播种，免得升级完第一次就撞上今天刚发的那条。
    if (!Array.isArray(state.recent)) {                     // 一次性迁移：老状态没有这个字段
      state.recent = state.used.slice(-30);
      writeJson(STATE_PATH, state);
    }
    const wk = weekKey(now);
    if (!state.week || state.week.key !== wk) state.week = { key: wk, extraSent: 0 };

    const scene = sceneAt(now, h, hol);
    if (!scene) return { skip: '静默段（' + h.quietStartHour + '–' + h.quietEndHour + ' 点不提醒）' };

    /* ---------- 今天排几次：由昨天改动数结算，判定见 planDay ---------- */
    const quota = Math.max(1, num(state.quota, 1));
    // 上一条生成好了但没发出去（QQ 断连）：30 秒内不重生成，免得每秒烧一次模型额度
    if (num(state.retryAt, 0) > now.getTime()) {
      return { skip: '上一条没发出去，' + Math.ceil((state.retryAt - now.getTime()) / 1000) + ' 秒后重试' };
    }
    /* 过期轮作废（判据同 noteSpeak）：不放在「排满就 return」之后 —— 正是排满时才最容易积住一轮。
     * 攒了几小时还没发出去的说话，不能再拿来当这一轮的触发源，也不能让它一直挡着后面的人。 */
    const speakDelayMs = Math.max(0, num(h.speakDelayMin, 2)) * 60000;
    if (num(_speak.at, 0) > 0 && now.getTime() - _speak.at > Math.max(30 * 60000, speakDelayMs * 3)) {
      console.log('[保健提醒] 上一轮攒了 ' + Math.round((now.getTime() - _speak.at) / 60000) + ' 分钟没发出去（排次已满？）→ 作废，等下一句');
      _speak = { at: 0, uids: [], gid: 0 };
    }
    // 排满当天次数就停
    if (num(state.sentToday, 0) >= quota) {
      return { skip: '今天排的 ' + quota + ' 次已经发完' };
    }
    /* ---------- 触发条件只有一个：被提醒的人在这个群说话后 N 分钟 ----------
     * 她 2026-11-23 20:36：「间隔改成按照被提醒的人在当前群说话算，此人说话后间隔 6 分钟发，随后进冷却」；
     * 23:22：「没人说话就不发」，等待时间改成 2 分钟。
     * 冷却按人算（20:58：「1.5 小时是针对个人的」）—— 这里没有全局冷却：A 刚被 @ 过，B 说话照样能触发。
     * 没人说话就什么都不发（旧的三套保底全部删除，见文件上方注释）。
     */
    const spokeUids = Array.isArray(_speak.uids) ? _speak.uids.slice() : [];
    if (!spokeUids.length) return { skip: '没人说话，剩下的等他们开口' };
    if (now.getTime() < _speak.at + speakDelayMs) {
      const passed = Math.floor((now.getTime() - _speak.at) / 1000);
      const left = Math.ceil((_speak.at + speakDelayMs - now.getTime()) / 1000);
      return { skip: '刚说完 ' + passed + ' 秒，还要 ' + left + ' 秒才满 ' + Math.round(speakDelayMs / 60000) + ' 分钟' };
    }

    /* 她 2026-11-23 20:50：「@ 只 @ 那一个说话人」；20:58 补：「短时间的冷却内一起说话就一起 @」。
     * 只 @ 这一轮攒下来的那几个人，不再有「没人说话时随机挑一人」的分支。 */
    const atAll = atUidsOf(h, full);
    const spokeIn = spokeUids.filter(u => atAll.indexOf(u) >= 0);
    if (!spokeIn.length) {
      _speak = { at: 0, uids: [], gid: 0 };                  // 说话的人已被移出名单：清掉，别卡着
      return { skip: '说话的人不在提醒名单里' };
    }
    const groups = groupsFor(spokeIn);
    if (!groups.length) {                                    // 说话的人被自己的约定关掉了
      _speak = { at: 0, uids: [], gid: 0 };                  // 清掉，否则每跳都卡在这一轮
      return { skip: '说话的人被自己的约定关掉了' };
    }
    const gid = num(h.groupId, 0) || num(full.testGroup, 0);
    if (!gid || !_send) return { skip: '没有群号或发送函数没注入' };

    const extra = wantExtra(state, now, h);
    // 只有真抽到补充池里的动作才算「本周补充池达标」：抽空退回主池不算，否则会虚报达标、
    // 下周配额被白白用掉（她 2026-11-23 要求「至少 1 条」必须是真的那 1 条）。
    const extraPool = extra ? actsOf(scene === 'work' ? h.extraWork : h.extraRest) : [];
    // X = 「大概多久以后做」这个事实。她 2026-11-23 定：这句经常概率不出现，改成必须说
    // （qq.js 的 healthSay 里提示词硬化 + 出口校验，缺时间就重生成，不再「说 不说都随你」）。
    const xMin = randInt(num(h.delayMinMin, 3), num(h.delayMaxMin, 30));
    // QQ 没连上就别去生成了：一条提醒要花一次真模型调用，断线期间每秒重试等于白烧额度。
    // 旧行为保住：不标已发、连上后下一跳照样补发。
    if (_ready && !_ready()) return { skip: 'QQ 没连上，这条不标已发，等连上再补' };
    const sent = [];
    let ok = 0, tried = 0, hitExtra = false;
    for (const g of groups) {
      const act = chooseAct(h, scene, extra, state.used, state.recent);
      if (!act) continue;
      tried++;
      const usedExtra = extraPool.indexOf(act) >= 0;
      // 当场一次普通 LLM 会话：人设 + 记忆 + 这个动作 → 这一句
      const line = await sayLine({ gid, act, xMin, scene, extra, uids: g.uids.slice() });
      if (!line) continue;
      const body = g.uids.map(u => '@' + u).join(' ') + ' ' + line;
      let done = false;
      try { done = _send(gid, body) !== false; } catch (e) { console.log('[保健提醒] 发送失败：' + e.message); }
      if (!done) continue;                                   // QQ 没连上：不标已发，等下一跳重试
      ok++;
      if (usedExtra) hitExtra = true;
      state.used.push(act);
      state.recent.push(act);                                // 跨天记忆：只留最近 30 个，文件不会越长越大
      if (state.recent.length > 30) state.recent = state.recent.slice(-30);
      sent.push({ at: g.uids, act, line });
      console.log('[保健提醒] ' + today + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds())
        + ' → 群' + gid + ' @' + g.uids.join(',') + ' 「' + line + '」（动作：' + act
        + (usedExtra ? '，补充池' : '')
        + '，' + spokeUids.join('+') + ' 说话后 ' + Math.round(speakDelayMs / 60000) + ' 分钟' + '）');
    }
    if (!ok) {
      if (tried) {
        // 生成好了但没发出去：30 秒后再试，别每秒重生成一次（一次就是一次真模型调用）
        state.retryAt = now.getTime() + 30000;
        writeJson(STATE_PATH, state);
      }
      return { skip: '没发出去，这一条没标已发，30 秒后重发' };
    }

    state.sentToday = num(state.sentToday, 0) + 1;
    state.lastSentAt = now.getTime();
    state.retryAt = 0;
    /* 冷却记在每个人自己头上（她 20:58：「1.5 小时是针对个人的」）：
     * 这条 @ 了谁，就只有谁进 1.5 小时冷却；别人照常能触发。 */
    if (!state.cool || typeof state.cool !== 'object') state.cool = {};
    for (const g of groups) for (const u of g.uids) state.cool[String(u)] = now.getTime();
    _speak = { at: 0, uids: [], gid: 0 };                     // 这次触发已用完，等下一次说话
    if (hitExtra) state.week.extraSent = num(state.week.extraSent, 0) + 1;
    // 没有按点排的下一跳：下一条什么时候发，完全看谁接着说话
    writeJson(STATE_PATH, state);
    return { sent, extra, scene, sentToday: state.sentToday };
  } catch (e) {
    console.log('[保健提醒] 这一跳出错：' + e.message);
    return { error: e.message };
  } finally {
    _busy = false;                                           // 不管成功失败都要放开，否则只发第一条
  }
}
function tick() { return tickAt(new Date()); }

function start(opts) {
  if (_timer) return;
  _send = opts && opts.send;
  _say = (opts && opts.say) || null;
  _ready = (opts && opts.ready) || null;
  _countChanges = (opts && opts.countChanges) || null;
  refreshHolidays(new Date().getFullYear());                 // 开机拉一次全年日历，失败按星期
  const h = configStore.cfgLive().healthRemind || {};
  const step = Math.max(1, Math.round(num(h.tickIntervalSec, 1))) * 1000;
  _timer = setInterval(tick, step);                         // 秒级轮询：秒级排点才不会被量化回整分钟
  setTimeout(tick, Math.min(step, 1000));                   // 首跳 1 秒内就查，不空等固定间隔；QQ 没连上就不标已发，连上后下一秒补
  const on = !!h.enabled;
  console.log('[保健提醒] 已启动（每 ' + step / 1000 + ' 秒一跳；按人说话触发，说完 ' + num(h.speakDelayMin, 2) + ' 分钟发，'
    + '没人说话就不发；每条都当场走一次人设会话生成，不用预写话术）' + (on ? '' : '（总开关关着，不发）'));
}

module.exports = {
  start, tick, tickAt,
  // 自测钩子：不改状态就能验判定逻辑
  _sceneAt: sceneAt, _dayKey: dayKey, _weekKey: weekKey,
  _actsOf: actsOf, _chooseAct: chooseAct, _groupsFor: groupsFor, _sayLine: sayLine,
  _wantExtra: wantExtra, _holidayCache: holidayCache, _refreshHolidays: refreshHolidays,
  _planDay: planDay, _dayCap: dayCapOf,
  _inQuiet: inQuiet, _quietMinutes: quietMinutes, noteSpeak, targetGroup,
  _speak: () => _speak, _resetSpeak: () => { _speak = { at: 0, uids: [], gid: 0 }; },
  _STATE_PATH: STATE_PATH, _HOLIDAY_PATH: HOLIDAY_PATH,
  _setSend: fn => { _send = fn; },
  _setSay: fn => { _say = fn; },
  _setReady: fn => { _ready = fn; },
  _setCountChanges: fn => { _countChanges = fn; },
};
