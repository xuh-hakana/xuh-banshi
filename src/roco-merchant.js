'use strict';
/*
 * src/roco-merchant.js —— 洛克王国「远行商人」提醒（2026-11-21 主人定）
 *
 * 原话：「往『提醒』里面加『洛克王国』：每轮出『炫彩蛋、祝福项坠』@固定的几个人」
 *       「@的成立必须是规则生效，不是你手动改出来」
 *
 * 2026-11-21 更正：商品名是「祝福项坠」不是「祝福项链」（主人自己说错了，本文件旧版跟着写错了）；
 * 另外加上「棱镜球」。稀有度 棱镜球 > 祝福项坠 > 炫彩蛋，排名与每日额度见 src/roco-rarity.js。
 *
 * 所以这里不写死任何 QQ 号：
 *   ① 每轮去公开数据源读「这一轮到底卖什么」（qi-du-shang.github.io/data.json，每天 8/12/16/20 点刷新）；
 *   ② 本轮商品命中 watchItems（棱镜球 / 祝福项坠 / 炫彩蛋）才发；
 *   ③ @ 谁 = fixed-tags 里「洛克王国」标签的持有人，再筛掉自己把 rocoMerchant 关掉的人；
 *   ④ 同一轮只发一次（状态落盘，重启不重发）；
 *   ⑤ 只在「这一轮出现的 4 小时」内发：发失败就在窗口内每跳补一次，窗口一过立刻放弃、不补。
 *      窗口 = 数据源的 startedAtBeijing → nextRefreshBeijing（北京时间，正常 4 小时）。
 *   ⑥ 正文带日期（11.21），免得第二天看到分不清是哪天的轮次。
 *
 * 数据源说明：这个页面每天 8/12/16/20 点自动同步，JSON 里有 round / startedAtBeijing /
 * nextRefreshBeijing / rounds{1..4:[商品]}。拿不到数据就跳过这一跳，不猜、不发假消息。
 * 消息正文只报事实（本轮有什么、多少钱、限购几件、几点结束），不交给人设改写，
 * 免得把商品名或价格说错——提醒的价值就在准确。
 */

const fs = require('fs');
const path = require('path');
const net = require('./net');
const configStore = require('./config');
const fixedTags = require('./fixed-tags');
const core = require('./core');
const rocoBili = require('./roco-bili');   // 稀有商品 → B站 评论区提醒（2026-11-21）

const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'roco-merchant-state.json');

let _send = null;        // qq.js 注入：(gid, body) => true/false 或 Promise<boolean>（等回执）
let _ready = null;       // qq.js 注入：() => QQ 是否连着
let _fetch = null;       // 只在自测脚本里注入，生产走 net.getJson
let _timer = null;
let _started = false;
let _busy = false;

function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function pad2(n) { return String(n).padStart(2, '0'); }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) || fb; } catch { return fb; } }
function writeJson(p, o) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) { console.log('[远行商人] 状态写不进：' + e.message); }
}

/* 当前轮次的商品。优先用 rounds[轮次]，没有就从 items 里按 rounds 数组筛。 */
function roundItems(j) {
  if (!j || typeof j !== 'object') return [];
  const r = String(j.round == null ? '' : j.round);
  const byRounds = j.rounds && j.rounds[r];
  if (Array.isArray(byRounds)) return byRounds;
  const all = Array.isArray(j.items) ? j.items : [];
  return all.filter(x => x && (!Array.isArray(x.rounds) || x.rounds.map(String).indexOf(r) >= 0));
}

/* 命中要盯的商品。名字两边都做包含判断，兼容「炫彩蛋 / 炫彩精灵蛋」「祝福项坠 / 祝福项坠礼包」。 */
function matchItems(items, watch) {
  const list = (Array.isArray(watch) ? watch : []).map(x => String(x || '').trim()).filter(Boolean);
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const n = String((it && it.name) || '').trim();
    if (!n) continue;
    const hit = list.some(w => n === w || n.indexOf(w) >= 0 || w.indexOf(n) >= 0);
    if (hit) out.push(it);
  }
  // 同名去重（rounds 结构偶尔会带重复项）
  const seen = new Set();
  return out.filter(x => { const k = String(x.name); if (seen.has(k)) return false; seen.add(k); return true; });
}

function hhmm(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  return m ? pad2(m[1]) + ':' + m[2] : '';
}

/* 「2026-11-21 12:00:00」是北京时间（数据源固定 +08:00），换成毫秒时间戳。
 * 不能直接 new Date(str)——机器时区一变就错，这里显式按 UTC+8 算。 */
function beijingToMs(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
}

/* 这一轮的「出现窗口」：开始 → 下次刷新。数据源没说下次刷新就按 4 小时兜底。 */
function windowOf(j) {
  const start = beijingToMs(j && j.startedAtBeijing);
  let end = beijingToMs(j && j.nextRefreshBeijing);
  const span = Math.max(1, num(j && j.durationHours, 4)) * 3600 * 1000;
  if (start && !end) end = start + span;
  if (start && end && end <= start) end = start + span;
  return { start, end };
}

/* 日期只写 11.21 这种短格式（主人 2026-11-21 定：提醒正文要带日期）。 */
function mdOf(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (+m[2]) + '.' + m[3] : '';
}

function beijingNowMd(ms) {
  const d = new Date((ms || Date.now()) + 8 * 3600 * 1000);
  return pad2(d.getUTCMonth() + 1).replace(/^0/, '') + '.' + pad2(d.getUTCDate());
}

/* 一条只报事实的提醒正文。@ 段由发送层转成真正的 at。 */
function bodyFor(uids, j, hits) {
  const items = hits.map(x => {
    const bits = [];
    if (x.priceRaw || x.price) bits.push(String(x.priceRaw || x.price));
    if (x.limit) bits.push('限' + x.limit);
    return String(x.name) + (bits.length ? '（' + bits.join('·') + '）' : '');
  });
  const from = hhmm(j && j.startedAtBeijing), to = hhmm(j && j.nextRefreshBeijing);
  const window = from && to ? '本轮 ' + from + '–' + to + '，' : '';
  const round = (j && j.round != null) ? '第' + j.round + '轮' : '这一轮';
  const date = mdOf(j && j.startedAtBeijing) || beijingNowMd();   // 11.21 这种
  return uids.map(u => '@' + u).join(' ') + ' ' + date + ' 洛克王国远行商人' + round + '有：'
    + items.join('、') + '。' + window + '要买趁现在。';
}

/* 谁该收到：固定标签持有人 ∩ 自己没关掉这个提醒。
 * addonOf(uid,'rocoMerchant') 没有记录 = 没接受过 → 不发；enabled=false = 本人关掉 → 不发。
 * 当前两位是主人明确让他们接受、已写入约定（enabled:true），以后谁的标签被主人加上，
 * 还要本人接受（或主人在面板勾上）才会进 @ 名单——这就是「规则生效」。 */
function recipients(tag) {
  const out = [];
  for (const qq of fixedTags.holders(tag)) {
    let ov = null;
    try { ov = core.addonOf(qq, 'rocoMerchant'); } catch { ov = null; }
    if (!ov || ov.enabled === false) continue;
    out.push(qq);
  }
  return out;
}

async function tickAt(now) {
  if (_busy) return { skip: '上一跳还没完成' };
  _busy = true;
  try {
    const full = configStore.cfgLive();
    const c = full.rocoMerchant || {};
    if (!c.enabled) return { skip: '开关关着' };
    const url = String(c.dataUrl || '').trim();
    if (!url) return { skip: '没配数据源' };
    const gid = num(c.groupId, 0) || num(full.testGroup, 0);
    if (!gid || !_send) return { skip: '没有群号或发送函数没注入' };

    let j = null;
    try { j = await (_fetch ? _fetch(url) : net.getJson(url, { timeout: 10000 })); } catch (e) { return { skip: '数据源没拉到：' + e.message }; }
    if (!j || typeof j !== 'object') return { skip: '数据源格式不对' };
    if (j.stale && c.skipStale !== false) return { skip: '数据源标记为过期，等下一跳' };

    const roundKey = String(j.round == null ? '?' : j.round) + '@' + String(j.startedAtBeijing || j.nextActiveBeijing || '');
    const nowMs = (now instanceof Date ? now.getTime() : Date.now());
    const win = windowOf(j);
    let state = readJson(STATE_PATH, {});
    if (state.roundKey === roundKey) return { skip: '这一轮已经处理过', roundKey };

    // 时间窗外一律不发（主人 2026-11-21 定）：过点就不再补，宁可漏掉也不发一条过期消息。
    if (win.end && nowMs >= win.end) {
      if (state.expiredKey !== roundKey) {
        state = Object.assign({}, state, {
          expiredKey: roundKey, lastCheckAt: nowMs,
          lastResult: '这一轮时间窗已过（' + hhmm(j.nextRefreshBeijing) + ' 结束），不补发',
          round: j.round, startedAt: j.startedAtBeijing,
        });
        writeJson(STATE_PATH, state);
        console.log('[远行商人] 第' + j.round + '轮时间窗已过（' + hhmm(j.nextRefreshBeijing) + ' 结束），这轮不补发');
      }
      return { skip: '这一轮时间窗已过，不补发', roundKey };
    }
    if (win.start && nowMs < win.start - 5 * 60 * 1000) return { skip: '还没到这一轮开始时间', roundKey };

    const items = roundItems(j);
    // 商品签名：数据源在轮次开头可能先给半份，过几分钟才补齐。没有命中时按签名记一笔，
    // 签名变了（补上了棱镜球/祝福项坠）还会再看一次；签名没变就不重复打接口。
    const sig = items.map(x => String((x && x.name) || '') + ':' + String((x && (x.priceRaw || x.price)) || '')).join('|');
    if (state.noHitKey === roundKey && state.noHitSig === sig) return { skip: '这一轮看过，没有要盯的商品', roundKey };

    const hits = matchItems(items, c.watchItems);
    if (!hits.length) {
      state = Object.assign({}, state, {
        noHitKey: roundKey, noHitSig: sig,
        lastCheckAt: Date.now(), lastResult: '本轮没有要盯的商品', round: j.round, startedAt: j.startedAtBeijing,
      });
      writeJson(STATE_PATH, state);
      return { skip: '本轮没有要盯的商品', roundKey };
    }

    // 稀有商品这一轮（棱镜球/祝福项坠/炫彩蛋）：除了群里 @，还要去 B站 给刚发的洛克王国视频留提醒
    // （主人 2026-11-21 定）。不管群消息发没发成，B站 那条线独立走；同轮只安排一次（roco-bili 自己按 roundKey 去重），
    // 额度按稀有度算的那套规则也由 roco-bili 判（普通商品发不发看当天稀有额度还剩多少）。
    try { rocoBili.arm({ roundKey, round: j.round, items: hits, startedAt: j.startedAtBeijing, nextRefresh: j.nextRefreshBeijing }); } catch (e) { console.log('[远行商人] 安排 B站 任务失败：' + e.message); }

    const uids = recipients(String(c.tag || '洛克王国'));
    if (!uids.length) {
      state = Object.assign({}, state, { lastCheckAt: Date.now(), lastResult: '有商品但没人接受这个提醒', round: j.round });
      writeJson(STATE_PATH, state);
      return { skip: '有商品但没人接受这个提醒', hits: hits.map(x => x.name) };
    }
    if (_ready && !_ready()) return { skip: 'QQ 没连上，这一轮先不标已处理', roundKey, retry: true };

    const body = bodyFor(uids, j, hits);
    let done = false;
    try {
      const r = _send(gid, body);
      done = (r && typeof r.then === 'function') ? !!(await r) : (r !== false);   // 发送层要回执：Promise 才算真发成
    } catch (e) { console.log('[远行商人] 发送失败：' + e.message); }
    if (!done) {
      // 没发成也照样不标已发：下一跳在时间窗内接着补；窗口过了上面那段会直接放弃。
      const leftMin = win.end ? Math.max(0, Math.round((win.end - nowMs) / 60000)) : 0;
      state = Object.assign({}, state, {
        lastCheckAt: nowMs, lastSendError: '发送没成功', round: j.round, startedAt: j.startedAtBeijing,
        lastResult: '没发出去，窗口内继续补（还剩 ' + leftMin + ' 分钟）',
      });
      writeJson(STATE_PATH, state);
      return { skip: '没发出去，时间窗内继续补', leftMin, roundKey, retry: true };
    }

    state = Object.assign({}, state, {
      roundKey, round: j.round, startedAt: j.startedAtBeijing,
      lastSentAt: Date.now(), lastResult: '已发：' + hits.map(x => x.name).join('、'),
      lastBody: body, lastUids: uids,
    });
    writeJson(STATE_PATH, state);
    console.log('[远行商人] ' + (now ? now.toISOString() : '') + ' → 群' + gid + ' @' + uids.join(',')
      + ' 「' + hits.map(x => x.name).join('、') + '」');
    return { sent: { uids, items: hits.map(x => x.name), body }, roundKey };
  } catch (e) {
    console.log('[远行商人] 这一跳出错：' + e.message);
    return { error: e.message };
  } finally {
    _busy = false;
  }
}

/* 面板预览：只读一次数据源，算「这一轮有没有、该 @ 谁」，不发消息、不动状态。 */
async function preview() {
  const c = configStore.cfgLive().rocoMerchant || {};
  const url = String(c.dataUrl || '').trim();
  if (!url) return { error: '没配数据源' };
  let j = null;
  try { j = await net.getJson(url, { timeout: 10000 }); } catch (e) { return { error: '数据源没拉到：' + e.message }; }
  if (!j || typeof j !== 'object') return { error: '数据源格式不对' };
  const items = roundItems(j);
  const hits = matchItems(items, c.watchItems);
  const uids = recipients(String(c.tag || '洛克王国'));
  const win = windowOf(j);
  return {
    ok: true, round: j.round, startedAt: j.startedAtBeijing, nextRefresh: j.nextRefreshBeijing,
    fetchedAt: j.fetchedAt, stale: !!j.stale,
    date: mdOf(j.startedAtBeijing) || beijingNowMd(),
    windowEnd: win.end ? new Date(win.end).toISOString() : '',
    canSendNow: !win.end || Date.now() < win.end,     // 时间窗过了就不发（面板上也标出来）
    items: items.map(x => ({ name: x.name, price: x.priceRaw || x.price, limit: x.limit })),
    hits: hits.map(x => x.name), uids,
    body: hits.length && uids.length ? bodyFor(uids, j, hits) : '',
  };
}

function stateOf() { return readJson(STATE_PATH, {}); }

/* 一天只出 4 轮（8/12/16/20 点刷新），不做 60 秒轮询（主人 2026-11-21 定）。
 * 每轮只在两个分钟点查：默认 +5 分、+35 分——数据源要等它自己更新完（:30 左右），
 * +5 分先看一眼，+35 分再看落定。平时一天 8 次请求。
 * 只有「这一轮有货但没发成」才按 retrySec（默认 5 分钟）补，补到发出去或时间窗结束。 */
function slotTimes(fromMs) {
  const c = configStore.cfgLive().rocoMerchant || {};
  const hours = (Array.isArray(c.roundHours) ? c.roundHours : [8, 12, 16, 20])
    .map(x => num(x, -1)).filter(h => h >= 0 && h < 24);
  const offs = (Array.isArray(c.offsetsMin) ? c.offsetsMin : [5, 35])
    .map(x => num(x, -1)).filter(m => m >= 0 && m < 60);
  const out = [];
  const bj = new Date(fromMs + 8 * 3600 * 1000);   // 按北京时间的「今天/明天」排点
  const y = bj.getUTCFullYear(), mo = bj.getUTCMonth(), d = bj.getUTCDate();
  for (const day of [0, 1]) for (const h of hours) for (const m of offs) out.push(Date.UTC(y, mo, d + day, h - 8, m, 0));
  return out.sort((a, b) => a - b);
}

function nextSlotAfter(ms) {
  const list = slotTimes(ms);
  for (const t of list) if (t > ms + 2000) return t;
  return ms + 3600 * 1000;
}

function clearTimer() { if (_timer) { clearTimeout(_timer); _timer = null; } }
function scheduleAt(ms) {
  clearTimer();
  _timer = setTimeout(runOnce, Math.max(1000, ms - Date.now()));
}
async function runOnce() {
  _timer = null;
  const r = await tickAt(new Date());
  if (r && r.retry) {   // 有货没发成 / QQ 没连上：窗口内短间隔补，别等下一轮
    const c = configStore.cfgLive().rocoMerchant || {};
    const wait = Math.max(60, num(c.retrySec, 300)) * 1000;
    console.log('[远行商人] ' + (r.skip || '没发成') + ' → ' + Math.round(wait / 60000) + ' 分钟后再试');
    return scheduleAt(Date.now() + wait);
  }
  scheduleAt(nextSlotAfter(Date.now()));
}

function start(opts) {
  if (_timer || _started) return;
  _started = true;
  _send = opts && opts.send;
  _ready = (opts && opts.ready) || null;
  const c = configStore.cfgLive().rocoMerchant || {};
  const hours = (Array.isArray(c.roundHours) ? c.roundHours : [8, 12, 16, 20]).join('/');
  const offs = (Array.isArray(c.offsetsMin) ? c.offsetsMin : [5, 35]).join('、');
  scheduleAt(Date.now() + 3000);   // 启动补一次：机器人中途起来，窗口内还没发就还能补上
  console.log('[远行商人] 已启动（一天 ' + hours + ' 点四轮，每轮查 +' + offs + ' 分；没发成按 '
    + Math.round(Math.max(60, num(c.retrySec, 300)) / 60) + ' 分钟补，过窗不补；' + (c.enabled ? '' : '开关关着，不发') + '）');
}

module.exports = {
  start, tickAt, preview, stateOf,
  _roundItems: roundItems, _matchItems: matchItems, _bodyFor: bodyFor, _recipients: recipients,
  _windowOf: windowOf, _mdOf: mdOf, _beijingToMs: beijingToMs,
  _slotTimes: slotTimes, _nextSlotAfter: nextSlotAfter,
  _STATE_PATH: STATE_PATH,
  _setSend: fn => { _send = fn; },
  _setReady: fn => { _ready = fn; },
  _setFetch: fn => { _fetch = fn; },
};
