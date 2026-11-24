'use strict';
/* tests/test-poop-stats.js — 搬屎统计唯一真源的验收。
 * 跑法：node tests/test-poop-stats.js（无框架，失败 throw → 非 0 退出） */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { poopStats, forwardTotals } = require(path.join(ROOT, 'src', 'poop-stats'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "poop-stats-"));
const CACHE = path.join(TMP, 'move-poop-cache.json');
const STATS = path.join(TMP, 'move-poop-stats.jsonl');

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* 缓存：10 分钟前（还在队列）+ 2 小时前（过期）+ 没有时间戳（只算记忆） */
fs.writeFileSync(CACHE, JSON.stringify({
  m1: { at: NOW - 10 * MIN, groupId: "111", senderId: "9" },
  m2: { at: NOW - 2 * HOUR, groupId: "111", senderId: "9" },
  m3: { groupId: "222", senderId: "8" },
}), "utf8");

/* 流水：今天 3 条（目标 900 ×2、901 ×1）、昨天 1 条 */
const today = new Date(NOW);
const yest = new Date(NOW - 24 * HOUR);
fs.writeFileSync(STATS, [
  JSON.stringify({ t: new Date(NOW - 5 * MIN).toISOString(), mid: "m1", sourceGroup: "111", targetGroup: "900", mode: "plain" }),
  JSON.stringify({ t: new Date(NOW - 3 * MIN).toISOString(), mid: "m2", sourceGroup: "111", targetGroup: "900", mode: "plain" }),
  JSON.stringify({ t: new Date(NOW - 2 * MIN).toISOString(), mid: "m3", sourceGroup: "222", targetGroup: "901", mode: "plain" }),
  JSON.stringify({ t: yest.toISOString(), mid: "m0", sourceGroup: "111", targetGroup: "900", mode: "plain" }),
].join("\n") + "\n", "utf8");

/* ── 1. 缓存口径 ── */
const s = poopStats({ cacheFile: CACHE, statsFile: STATS, now: NOW });
assert.strictEqual(s.ok, true, "正常文件应当 ok");
assert.strictEqual(s.total, 3, "去重记忆 = 缓存全部条数");
assert.strictEqual(s.queue.total, 1, "只有 10 分钟前那条还在 1 小时队列里");
assert.strictEqual(s.queue.byGroup.length, 1);
assert.strictEqual(s.queue.byGroup[0].groupId, "111");
assert.strictEqual(s.queue.byGroup[0].count, 1);
assert.ok(Math.abs(s.queue.byGroup[0].oldestSec - 600) <= 5, "oldestSec 约 600，实际 " + s.queue.byGroup[0].oldestSec);
assert.strictEqual(s.recent.length, 3);
assert.strictEqual(s.recent[0].id, "m1", "最近消息按时间倒序");

/* ── 2. 流水口径 ── */
assert.strictEqual(s.forwarded.total, 4, "流水累计 4 条");
assert.strictEqual(s.forwarded.today, 3, "今天 3 条");
assert.strictEqual(s.forwarded.byGroup["900"], 3);
assert.strictEqual(s.forwarded.byGroup["901"], 1);
assert.strictEqual(s.forwarded.todayByGroup["900"], 2);
assert.strictEqual(s.forwarded.todayByGroup["901"], 1);

/* ── 3. 日报口径必须和今日流水一致 ── */
const ft = forwardTotals({ statsFile: STATS, day: dayKey(today) });
assert.strictEqual(ft.sourceGroups, 2, "今天涉及 2 个源群");
assert.strictEqual(ft.sourceMsgs, 3);
assert.strictEqual(ft.targetGroups, 2);
assert.deepStrictEqual(ft.perGroup, s.forwarded.todayByGroup, "日报 perGroup 必须等于今日 byGroup");

/* ── 4. 空态 / 坏文件 ── */
const empty = poopStats({ cacheFile: path.join(TMP, "nope.json"), statsFile: path.join(TMP, "nope.jsonl"), now: NOW });
assert.strictEqual(empty.ok, true, "文件不存在算正常空态");
assert.strictEqual(empty.total, 0);
assert.strictEqual(empty.queue.total, 0);

fs.writeFileSync(path.join(TMP, 'broken.json'), '{"m1": {"at": 1', 'utf8');
const broken = poopStats({ cacheFile: path.join(TMP, "broken.json"), statsFile: STATS, now: NOW });
assert.strictEqual(broken.ok, false, "坏缓存要 ok:false 但不能抛");
assert.ok(String(broken.error || "").indexOf("缓存") >= 0);
assert.strictEqual(broken.forwarded.total, 4, "缓存坏了不影响流水统计");

/* ── 5. 老缓存形状兼容 ── */
fs.writeFileSync(path.join(TMP, 'seen.json'), JSON.stringify({ seen: { a: NOW - MIN, b: NOW - 2 * HOUR } }), 'utf8');
const legacy = poopStats({ cacheFile: path.join(TMP, "seen.json"), statsFile: STATS, now: NOW });
assert.strictEqual(legacy.total, 2);
assert.strictEqual(legacy.queue.total, 1);

/* ── 6. 唯一真源：公开客户端也走 src/poop-stats.js，不自己算一套 ── */
const mainSrc = fs.readFileSync(path.join(ROOT, "client", "main.js"), "utf8");
assert.ok(mainSrc.indexOf("src', 'poop-stats.js") >= 0, "客户端主进程必须把 xuh:poop 交给 src/poop-stats.js");
assert.ok(mainSrc.indexOf("poop-data.js") < 0, "client/poop-data.js 已删，不许再被引用");

const panelSrc = fs.readFileSync(path.join(ROOT, "client", "renderer", "poop-panel.js"), "utf8");
assert.ok(panelSrc.indexOf("move-poop") < 0, "搬屎界面不许自己拼缓存/流水路径");

/* 界面层（client / public）不许自己拼这两个文件的路径，一律走 xuh:poop。
 * 机器人内部另有写入方（move-poop.js 写缓存、daily-stats.js 写流水），它们只传路径，不算读者。 */
const readers = [];
for (const dir of ["client", "public"]) {
  (function scan(d0) {
    for (const d of fs.readdirSync(d0, { withFileTypes: true })) {
      const p = path.join(d0, d.name);
      if (d.isDirectory()) { if (!/node_modules|\.git|dist|日志/.test(d.name)) scan(p); continue; }
      if (!/\.(js|html)$/.test(d.name)) continue;
      const s = fs.readFileSync(p, "utf8");
      if (/move-poop-cache\.json|move-poop-stats\.jsonl/.test(s)) readers.push(path.relative(ROOT, p));
    }
  })(path.join(ROOT, dir));
}
assert.deepStrictEqual(readers, [], "界面层不许自己拼搬屎缓存/流水的路径");

const direct = poopStats();
console.log("PASS 搬屎统计唯一真源：缓存 3 条 / 队列 1 条 / 今日 3 条 / 日报一致 / 空态与坏文件都不抛");
console.log("     界面层自己拼缓存路径的地方：" + readers.length + " 处（必须为 0）");
