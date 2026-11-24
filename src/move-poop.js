/*
 * move-poop.js — 自动搬屎/搬史（复刻自 618 星 anka-afk/astrbot_sowing_discord）
 *
 * 主人 2026-11-21 令：「找顶尖的自动搬屎插件，接入 xuhbot 而不是 astrbot，
 *                     功能简单就这一轮复刻。」
 * 原版是 AstrBot 的 Python 插件，xuhbot 没有插件系统 → 直接把算法复刻成 Node 模块。
 *
 * 两种模式（mode 配置，默认 plain）：
 *   plain（无脑搬，主人 2026-11-21 定，她的源群一般 0 表情）：
 *     ① 源群消息 → 缓存 message_id + 时间戳（落盘，重启不丢）
 *     ② 短等待（默认 2 秒，可调到 0）后直接转发，跳过表情评价
 *     ③ forward_group_single_msg 合并转发到每个目标群
 *     ④ 每条间隔 1 秒；冷却默认关，可调（源群热闹时建议开防刷屏）
 *   emoji（原版算法，留作可切换）：
 *     ② 等 WAITING_TIME（600s）让群友贴表情
 *     ③ fetch_emoji_like 逐个表情查数量 → 好评表 >= 差评表才放行
 *     ④ 转发 + 昼夜动态冷却（白天 600s / 夜间 3600s）
 *
 * 比原版强的地方：
 *   - 支持无脑搬模式（原版只有表情筛选，0 表情源等于空等 10 分钟）
 *   - 表情查询并发分批（原版串行 167 次），不阻塞事件循环
 *   - 默认 enabled=false、源群/目标群空 → 绝不误转发，主人配好才动
 *   - 支持 allowedTypes 白名单过滤（text/image/video/forward）
 *   - 全程依赖注入（callApi / cfgLive），不强耦合 qq.js，可单测
 *
 * 配置写在 config/features.json → movePoop 段（字段见 DEFAULT_CFG）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 原版 core/evaluation/rules.py 的好/差评表情表（逐字提取，这是她评价体系的判据）
const GOOD_IDS = [4,8,12,14,16,21,24,28,29,30,42,43,49,53,60,63,66,74,75,76,78,79,85,89,99,101,109,116,118,122,124,125,129,144,147,171,175,179,180,182,183,201,203,212,214,219,222,227,232,243,246,277,281,282,289,290,293,294,297,298,299,305,306,307,314,315,318,319,320,324,9728,9749,9786,10024,127801,127817,127822,127827,127836,127838,127847,127866,127867,127881,128046,128051,128053,128076,128077,128079,128089,128102,128104,128147,128157,128164,128170,128235,128293,128513,128514,128516,128522,128524,128536,128538,128540,128541];
const BAD_IDS  = [5,9,10,23,25,26,27,32,33,34,38,39,41,96,97,98,100,102,103,104,106,111,120,123,173,174,176,181,240,262,264,265,266,267,268,270,272,273,278,284,285,287,322,326,10060,10068,128027,128074,128166,128168,128527,128530,128531,128532,128557,128560,128563];
// 表情查询全集：原版 type1_ids + type2_ids（好+差的并集不够，中性的也要查来做差评对照）
const ALL_IDS = [4,5,8,9,10,12,14,16,21,23,24,25,26,27,28,29,30,32,33,34,38,39,41,42,43,49,53,60,63,66,74,75,76,78,79,85,89,96,97,98,99,100,101,102,103,104,106,109,111,116,118,120,122,123,124,125,129,144,147,171,173,174,175,176,179,180,181,182,183,201,203,212,214,219,222,227,232,240,243,246,262,264,265,266,267,268,269,270,271,272,273,277,278,281,282,284,285,287,289,290,293,294,297,298,299,305,306,307,314,315,318,319,320,322,324,326,9728,9749,9786,10024,10060,10068,127801,127817,127822,127827,127836,127838,127847,127866,127867,127881,128027,128046,128051,128053,128074,128076,128077,128079,128089,128102,128104,128147,128157,128164,128166,128168,128170,128235,128293,128513,128514,128516,128522,128524,128527,128530,128531,128532,128536,128538,128540,128541,128557,128560,128563];
const TYPE2_SET = new Set([9728,9749,9786,10024,10060,10068,127801,127817,127822,127827,127836,127838,127847,127866,127867,127881,128027,128046,128051,128053,128074,128076,128077,128079,128089,128102,128104,128147,128157,128164,128166,128168,128170,128235,128293,128513,128514,128516,128522,128524,128527,128530,128531,128532,128536,128538,128540,128541,128557,128560,128563]);
const GOOD_SET = new Set(GOOD_IDS);
const BAD_SET = new Set(BAD_IDS);
// 转发成功的流水（日报用）。这是「对象本身不计数」的补写：move-poop 原来只 console.log。
const POOP_STATS = path.join(__dirname, 'data', 'move-poop-stats.jsonl');

const DEFAULT_CFG = {
  enabled: false,                 // 默认关：主人配好源群/目标群再开
  mode: 'plain',                  // plain=无脑搬（默认，0表情源适合）；emoji=原版表情筛选
  pollSeconds: 3,                 // 轮询间隔（秒）；plain 模式决定搬运响应速度
  sourceGroups: [],               // 史的源群（数字或字符串群号）
  targetGroups: [],               // 搬到的目标群；空 = 默认不搬任何地方（比原版"空=全部群"更安全）
  waitSeconds: 2,                 // plain 模式短等待（秒）；emoji 模式建议设 600=原版观察期
  cacheMaxSeconds: 300,           // 超过这个时长还没转发就丢弃（plain 默认 5 分钟；原版 3600）
  cooldownDaySeconds: 0,          // 白天冷却（plain 默认关；emoji 模式原版 600）
  cooldownNightSeconds: 0,        // 夜间冷却（plain 默认关；emoji 模式原版 3600）
  cooldownDayStart: '09:00',      // 白天起点
  cooldownNightStart: '01:00',    // 夜间起点
  minGoodMinusBad: 0,             // emoji 模式：好评-差评 >= 这个数才搬（原版 >=0）
  allowedTypes: ['text','image','video','forward'],  // 允许搬运的消息类型白名单
  batchSize: 24,                  // 表情查询并发批大小（emoji 模式用，原版串行）
};

let callApi = null;   // 注入：(action, params, timeoutMs) => Promise<response.data>
let cfgLive = null;   // 注入：() => 现读的 config 对象
let cacheFile = null;
let timer = null;
let running = false;
let inFlight = false;   // 转发任务互斥（原版 forward_lock）
let cache = {};         // { messageId: {at, groupId, senderId} }

function cfg() {
  const c = (cfgLive && cfgLive()) || {};
  return Object.assign({}, DEFAULT_CFG, c.movePoop || {});
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function loadCache() {
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; }
  catch { cache = {}; }
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch (e) { console.log('[搬屎] 缓存落盘失败：' + e.message); }
}

// 消息类型白名单预检：原版 _is_allowed_msg_type 的等价实现（直接吃 OneBot 消息段数组）
function allowedMsgType(message, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return false;
  if (typeof message === 'string') {
    const has = t => message.includes('[CQ:' + t);
    let ok = true;
    for (const t of ['image','video','forward']) if (has(t) && !allowed.includes(t)) ok = false;
    const plain = message.replace(/\[CQ:.*?\]/g, '').trim();
    if (!plain && !(has('image') || has('video') || has('forward'))) return false;
    return ok;
  }
  if (!Array.isArray(message)) return false;
  const found = new Set();
  for (const seg of message) {
    const t = seg && seg.type;
    if (t === 'image') found.add('image');
    else if (t === 'video') found.add('video');
    else if (t === 'forward' || t === 'node') found.add('forward');
    else if (t === 'text' || t === 'face' || t === 'at' || t === 'reply') {
      if (t === 'text' && !String((seg.data && seg.data.text) || '').trim()) continue;
      found.add('text');
    }
  }
  for (const t of ['image','video','forward']) if (found.has(t) && !allowed.includes(t)) return false;
  for (const t of found) if (!allowed.includes(t) && t !== 'text') return false;
  return [...found].some(t => allowed.includes(t));
}

// 从源群事件里收一条消息进缓存（在 qq.js 消息分发处调用，拿的是原始 OneBot ev）
function onMessage(ev) {
  try {
    const c = cfg();
    if (!c.enabled) return;
    // 本号自己发的（AstrBot 搬屎/搬史插件也共用这个 QQ 号）不缓存，避免把自己的搬运再搬一遍
    if (String(ev.user_id) === String(ev.self_id || '')) return;
    if (ev.post_type !== 'message' || ev.message_type !== 'group') return;
    const gid = String(ev.group_id);
    if (!(c.sourceGroups || []).map(String).includes(gid)) return;
    const mid = ev.message_id;
    if (mid == null) return;
    if (!allowedMsgType(ev.message, c.allowedTypes)) return;
    cache[String(mid)] = { at: Date.now(), groupId: gid, senderId: String(ev.user_id || '') };
    saveCache();
  } catch (e) { console.log('[搬屎] 缓存消息出错：' + e.message); }
}

// 并发查全部表情的好/差数量。NapCat 实测必须 emojiId + emojiType 一起传。
async function countEmoji(messageId, c) {
  const goodSet = GOOD_SET, badSet = BAD_SET;
  let good = 0, bad = 0;
  const batch = Math.max(1, num(c.batchSize, 24));
  for (let i = 0; i < ALL_IDS.length; i += batch) {
    const slice = ALL_IDS.slice(i, i + batch);
    const results = await Promise.all(slice.map(id => {
      const emojiType = TYPE2_SET.has(id) ? 2 : 1;
      return callApi('fetch_emoji_like', { message_id: Number(messageId), emojiId: String(id), emojiType }, 5000)
        .then(r => {
          const list = (r && r.emojiLikesList) || (r && r.data && r.data.emojiLikesList) || [];
          return { id, n: Array.isArray(list) ? list.length : 0 };
        })
        .catch(() => ({ id, n: 0 }));   // 单个表情查询失败当 0，不连累整条
    }));
    for (const { id, n } of results) {
      if (goodSet.has(id)) good += n;
      else if (badSet.has(id)) bad += n;
    }
  }
  return { good, bad };
}

// 白天/夜间动态冷却：白天段内用 day 秒，其余用 night 秒（原版 _get_banshi_interval_dynamic）
function cooldownMs(c) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const parse = (s, d) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : d;
  };
  const dayStart = parse(c.cooldownDayStart, 9 * 60);
  const nightStart = parse(c.cooldownNightStart, 1 * 60);
  const isDay = mins >= dayStart || mins < nightStart;
  return Math.max(0, num(isDay ? c.cooldownDaySeconds : c.cooldownNightSeconds, isDay ? 600 : 3600)) * 1000;
}

// 一轮转发任务：逐条到期消息 → 复核 → 评价 → 转发 → 冷却
async function tick() {
  if (inFlight) return;
  const c = cfg();
  if (!c.enabled || !(c.targetGroups || []).length) { inFlight = false; return; }
  const now = Date.now();
  const waitMs = Math.max(1, num(c.waitSeconds, 600)) * 1000;
  const maxMs = Math.max(waitMs, num(c.cacheMaxSeconds, 3600) * 1000);
  const due = Object.keys(cache).filter(id => {
    const at = Number((cache[id] || {}).at) || 0;
    return now - at >= waitMs;
  });
  if (!due.length) return;
  inFlight = true;
  try {
    for (const id of due) {
      const cur = cfg();
      if (!cur.enabled) break;
      const entry = cache[id];
      if (!entry) continue;
      const age = now - Number(entry.at || 0);
      if (age > maxMs) { delete cache[id]; saveCache(); continue; }

      // 转发前再取一次原消息：确认还在、类型仍合规（原版二次校验）
      let detail;
      try {
        detail = await callApi('get_msg', { message_id: Number(id) }, 4000);
      } catch { delete cache[id]; saveCache(); continue; }
      const msg = (detail && (detail.message || (detail.data && detail.data.message))) || [];
      const ts = Number(detail && (detail.time || (detail.data && detail.data.time))) || 0;
      if (!msg.length || !allowedMsgType(msg, cur.allowedTypes) || (ts && Date.now() / 1000 - ts > maxMs / 1000)) {
        delete cache[id]; saveCache(); continue;
      }

      // 评价：plain 无脑搬直接放行（0 表情源）；emoji 模式才查表情、按好评-差评判定
      let good = 0, bad = 0;
      if (cur.mode !== 'plain') {
        try { ({ good, bad } = await countEmoji(id, cur)); }
        catch (e) { console.log('[搬屎] 表情评价失败，跳过：' + e.message); delete cache[id]; saveCache(); continue; }
        if (good - bad < num(cur.minGoodMinusBad, 0)) { delete cache[id]; saveCache(); continue; }
      }

      // 转发到每个目标群。forward_group_single_msg 是 NapCat 专有，实测可用。
      let sent = 0;
      for (const target of (cur.targetGroups || [])) {
        // 会话关闭（不看也不回）的群不搬（2026-11-21）：转发也是往这个群发东西，
        // 它不走 sendAction，必须在自己的出口单独拦一道。
        try {
          if (require('./conv-settings').isOff('qq_' + target)) {
            console.log('[搬屎] 群 ' + target + ' 已关（不看也不回），跳过');
            continue;
          }
        } catch {}
        try {
          await callApi('forward_group_single_msg', { group_id: Number(target), message_id: Number(id) }, 6000);
          sent++;
          try {
            fs.appendFileSync(POOP_STATS, JSON.stringify({
              t: new Date().toISOString(), mid: String(id),
              sourceGroup: String(entry.groupId || ''), targetGroup: String(target), mode: cur.mode,
            }) + '\n', 'utf8');
          } catch {}
          const sc = cur.mode === 'plain' ? '' : '（好评 ' + good + ' / 差评 ' + bad + '）';
          console.log('[搬屎] 已把 ' + id + ' 搬到群 ' + target + sc);
          await new Promise(r => setTimeout(r, 1000));   // 每条间隔 1 秒，防刷屏
        } catch (e) { console.log('[搬屎] 搬到群 ' + target + ' 失败：' + e.message); try { require('./err-log.js').logErr('poop-forward', '搬到群失败', { group: target, msg: e.message }); } catch (e2) {} }
      }
      delete cache[id]; saveCache();
      if (sent) {
        const cd = cooldownMs(cur);
        if (cd) {
          console.log('[搬屎] 冷却 ' + Math.round(cd / 1000) + 's');
          await new Promise(r => setTimeout(r, cd));
        }
      }
    }
  } finally { inFlight = false; }
}

function start(opts) {
  callApi = opts.callApi;
  cfgLive = opts.cfgLive;
  cacheFile = opts.cacheFile || path.join(__dirname, 'data', 'move-poop-cache.json');
  loadCache();
  if (running) return;
  running = true;
  // 轮询间隔用启动时的配置（cfgLive 可能还没注入完整）；cfgLive 就绪后每次 tick 末尾自校准
  const pollMs = () => {
    let c = {};
    try { c = (cfgLive && cfgLive() && cfgLive().movePoop) || {}; } catch {}
    return Math.max(1, num(c.pollSeconds, 3)) * 1000;
  };
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(() => {
      tick().catch(e => { console.log('[搬屎] tick 出错：' + e.message); try { require('./err-log.js').logErr('poop-tick', 'tick 出错', { msg: e.message }); } catch (e2) {} }).finally(schedule);
    }, pollMs());
  };
  schedule();
  console.log('[搬屎] 已启动（默认关闭，主人配好 sourceGroups/targetGroups 并 enabled=true 才生效；mode=' + cfg().mode + '）');
}
function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }

module.exports = {
  start, stop, onMessage,
  // 自测用（导出纯函数/内部量）
  _allowedMsgType: allowedMsgType, _cooldownMs: cooldownMs,
  _countEmoji: countEmoji, _tick: tick, _cache: () => cache,
  _GOOD_SET: GOOD_SET, _BAD_SET: BAD_SET, _ALL_IDS: ALL_IDS,
  _DEFAULT_CFG: DEFAULT_CFG, _STATS: POOP_STATS,
};
