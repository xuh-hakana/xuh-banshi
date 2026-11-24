'use strict';
/* src/poop-stats.js — 搬屎统计的唯一真源。
 *
 * 背景（2026-11-25 主人定）：搬屎的群统计原来散在四处各算一套，其中面板还把缓存路径写错
 * （读的是 <repo>/data，真身是 src/data），队列恒 0。现在只在这里读文件、只在这里算：
 *   · 面板 /api/board       → poopStats()
 *   · 公开客户端 / 私有客户端 → poopStats()（经 client/poop-data.js）
 *   · 日报                  → forwardTotals()
 *
 * 两个口径不要混：
 *   queue     = 缓存里「近 1 小时还可能搬」的去重队列（按来源群计数，看现在堵着多少）
 *   forwarded = move-poop-stats.jsonl 里「真的搬成功了」的流水（按目标群计数，日报用）
 * 默认路径与 src/move-poop.js 完全一致（__dirname + data），所以改 XUHBOT_ROOT 也不用动这里。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE = path.join(__dirname, 'data', 'move-poop-cache.json');
const DEFAULT_STATS = path.join(__dirname, 'data', 'move-poop-stats.jsonl');

/* 读文件按 mtime+size 记一次，面板 60 秒轮询不重复解析；读失败留上一次的好结果 */
const memo = new Map();
function readMemo(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }              // 文件不存在 = 正常空态
  const key = st.mtimeMs + ":" + st.size;
  const hit = memo.get(file);
  if (hit && hit.key === key) return hit.value;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return hit ? hit.value : null; }
  memo.set(file, { key: key, value: text });
  return text;
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function keyOfDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayKey(now) { return keyOfDate(new Date(Number(now) || Date.now())); }
function dayRange(day) {
  const p = String(day).split("-").map(Number);
  const start = new Date(p[0], p[1] - 1, p[2], 0, 0, 0, 0).getTime();
  return { start: start, end: start + 24 * 3600 * 1000 };
}
function toMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (n && !isNaN(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(v);
  return isNaN(d) ? 0 : d;
}

/* 缓存兼容 5 种老形状：数组 / items / seen / msgs / {mid:{at,groupId}} */
function cacheItems(cache) {
  if (!cache) return [];
  let list = [];
  if (Array.isArray(cache)) list = cache;
  else if (Array.isArray(cache.items)) list = cache.items;
  else if (cache.seen && typeof cache.seen === "object") {
    list = Object.keys(cache.seen).map(function (k) { return { id: k, t: cache.seen[k] }; });
  } else if (cache.msgs && typeof cache.msgs === "object") {
    list = Object.keys(cache.msgs).map(function (k) { return { id: k, t: cache.msgs[k] }; });
  } else if (typeof cache === "object") {
    list = Object.keys(cache).map(function (k) {
      const v = cache[k];
      return (v && typeof v === "object") ? Object.assign({ id: k }, v) : { id: k, t: v };
    });
  }
  return list.map(function (x) {
    return {
      id: String(x.id || x.message_id || ""),
      at: toMs(x.at != null ? x.at : x.t),
      group: String(x.groupId || x.group_id || x.group || x.from || ""),
    };
  });
}

function poopStats(opts) {
  opts = opts || {};
  const cacheFile = opts.cacheFile || DEFAULT_CACHE;
  const statsFile = opts.statsFile || DEFAULT_STATS;
  const windowSec = Number(opts.windowSec) || 3600;
  const now = Number(opts.now) || Date.now();
  const out = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    cacheFile: cacheFile,
    statsFile: statsFile,
    total: 0,
    queue: { total: 0, windowSec: windowSec, byGroup: [] },
    forwarded: { total: 0, today: 0, byGroup: {}, todayByGroup: {}, lastAt: null },
    recent: [],
  };

  /* ── 去重缓存：记忆条数 + 近 1 小时队列 ── */
  try {
    const text = readMemo(cacheFile);
    if (text) {
      const items = cacheItems(JSON.parse(text));
      out.total = items.length;
      const by = {};
      let qTotal = 0;
      for (const it of items) {
        if (!it.at) continue;
        if (now - it.at > windowSec * 1000) continue;
        qTotal++;
        const g = it.group || "?";
        const one = by[g] || (by[g] = { groupId: g, count: 0, oldestSec: 0 });
        one.count++;
        const sec = Math.round((now - it.at) / 1000);
        if (sec > one.oldestSec) one.oldestSec = sec;
      }
      out.queue.total = qTotal;
      out.queue.byGroup = Object.keys(by).map(function (k) { return by[k]; })
        .sort(function (a, b) { return b.count - a.count || b.oldestSec - a.oldestSec; });
      out.recent = items.slice()
        .sort(function (a, b) { return b.at - a.at; })
        .slice(0, 30)
        .map(function (x) {
          return { id: x.id, when: x.at ? new Date(x.at).toLocaleString("zh-CN") : "", group: x.group };
        });
    }
  } catch (e) {
    out.ok = false;
    out.error = "搬屎缓存读不出来：" + (e && e.message || e);
  }

  /* ── 转发流水：累计 / 今日 / 按目标群 ── */
  try {
    const text = readMemo(statsFile);
    const tk = todayKey(now);
    if (text) {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        const t = toMs(r && r.t);
        if (!t) continue;
        out.forwarded.total++;
        if (!out.forwarded.lastAt || t > out.forwarded.lastAt) out.forwarded.lastAt = t;
        const g = String(r.targetGroup || "?");
        out.forwarded.byGroup[g] = (out.forwarded.byGroup[g] || 0) + 1;
        if (keyOfDate(new Date(t)) === tk) {
          out.forwarded.today++;
          out.forwarded.todayByGroup[g] = (out.forwarded.todayByGroup[g] || 0) + 1;
        }
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = (out.error ? out.error + "；" : "") + "搬屎流水读不出来：" + (e && e.message || e);
  }

  return out;
}

/* 日报口径：某一天搬成功了多少、涉及几个源群/目标群（perGroup 是「目标群 → 条数」） */
function forwardTotals(opts) {
  opts = opts || {};
  const statsFile = opts.statsFile || DEFAULT_STATS;
  const day = opts.day || todayKey();
  const range = dayRange(day);
  const out = { sourceGroups: 0, sourceMsgs: 0, targetGroups: 0, perGroup: {} };
  let text = null;
  try { text = readMemo(statsFile); } catch { text = null; }
  if (!text) return out;
  const srcs = new Set(), mids = new Set(), tgts = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = toMs(r && r.t);
    if (!t || t < range.start || t >= range.end) continue;
    if (r.sourceGroup) srcs.add(String(r.sourceGroup));
    if (r.mid) mids.add(String(r.mid));
    if (r.targetGroup) {
      const g = String(r.targetGroup);
      tgts.add(g);
      out.perGroup[g] = (out.perGroup[g] || 0) + 1;
    }
  }
  out.sourceGroups = srcs.size;
  out.sourceMsgs = mids.size;
  out.targetGroups = tgts.size;
  return out;
}

module.exports = { poopStats: poopStats, forwardTotals: forwardTotals, DEFAULT_CACHE: DEFAULT_CACHE, DEFAULT_STATS: DEFAULT_STATS };
