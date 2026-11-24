#!/usr/bin/env node
/*
 * my-search.js — 我的免费检索通道（0 元、无 Key），和虚幻共用同一套源与同一套顺序
 * 为什么不再自己实现一遍：两处实现必然漂移（顺序/额度/冷却各改各的）。这里直接调 src/websearch 的 search()，
 * 虚幻回复时走的是同一条链路，所以「我查到的」和「她查到的」口径一致。
 * 链路（2026-11-23 定，排序优先级：通用 > 快速 > 兼容）：
 *   宝可梦 PokeAPI（0ms 本地命中）
 *   → 垂直源（命中词表才跑：StackExchange 报错 / arXiv 论文 / OpenLibrary 书 / HN 创业）
 *   → 维基百科+萌娘百科（并发，3.5s 封顶，权威且快）
 *   → SearXNG 自建（配了 SEARX_URL 才走，最快、不限量）
 *   → AnySearch 匿名（通用网页、中英文、1.5s、1,000 次/日）
 *   → Mwmbl（英文开放索引，2.2s）
 *   → Bing 抓页（红线，默认关）
 * 跑法：
 *   node scripts/my-search.js "查什么"
 *   node scripts/my-search.js "查什么" --json     # 给程序读
 */
const web = require('../src/websearch');

(async () => {
  const q = process.argv[2];
  if (!q || q.startsWith('--')) {
    console.log('用法：node scripts/my-search.js "查询词" [--json]');
    process.exit(1);
  }
  const t = Date.now();
  const text = await web.search(q);
  const ms = Date.now() - t;
  if (!text) {
    console.error('没查到（链路跑完是空的，可能是全部源当天额度用完或网络不通）用时 ' + ms + 'ms');
    process.exit(2);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ query: q, ms, text }, null, 2));
    return;
  }
  console.log('== ' + q + '（' + ms + 'ms）\n');
  console.log(text);
})().catch(e => { console.error('搜索失败：' + e.message); process.exit(1); });
