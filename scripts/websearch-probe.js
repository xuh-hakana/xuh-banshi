#!/usr/bin/env node
/*
 * websearch-probe.js — 搜索源探针（只读，不改配置）
 * 跑法：node scripts/websearch-probe.js ["查询词"]
 * 三段输出：开关现状 → 链路与垂直源配置 → 实测（只测没配也免 Key 的那几个）。
 * 额度出处见 docs/搜索源核实表.md；改额度前先回官网复核。
 */
const web = require('../src/websearch');
const configStore = require('../src/config');
const net = require('../src/net');

const CAT = {
  api: '① Key 制 API（要 Key，代码不调）',
  nokey: '② 零配置免 Key',
  selfhost: '③ 自托管（无 Key，填地址即可）',
  github: '④ 参考项目',
};
const q = process.argv[2] || 'searxng json format';

function loadWs() {
  try { return configStore.cfgLive().webSearch || {}; } catch { return {}; }
}

(async () => {
  const ws = loadWs();
  const on = ws.enabled !== false;

  console.log('== 开关（llm.json → webSearch）');
  console.log('  enabled: ' + (on ? '开' : '关 —— search() 直接返回空，下面全不跑'));
  console.log('  AnySearch 匿名: ' + (ws.anysearch !== false ? '开（免费，1,000 次/日）' : '关'));
  console.log('  Mwmbl: ' + (ws.mwmbl !== false ? '开（英文索引）' : '关'));
  console.log('  Bing 抓页: ' + (ws.bing === true ? '开（实测相关率低，多数结果会被相关度过滤丢掉）' : '关'));
  console.log('  count: ' + (ws.count || 5) + ' 条/次');

  console.log('\n== 链路顺序（我和虚幻共用 src/websearch.js，排序：通用 > 快速 > 兼容）');
  const base = String(ws.searxUrl || '').replace(/\/+$/, '');
  for (const [n, s2] of [
    ['1 PokeAPI', '专用，本地判定 0ms'],
    ['2 萌娘百科', '二次元最准，约 0.9s'],
    ['3 垂直源', 'StackExchange/arXiv/OpenLibrary/HN + GitHub/npm/crates/HF，命中词表才跑'],
    ['4 维基百科', '通用知识，约 0.7s（走代理）'],
    ['5 SearXNG', base ? '已配 ' + base + '（最快、不限量）' : '未配（searxUrl 为空）'],
    ['6 AnySearch', '通用网页，中英文，约 1.5s，1,000 次/日'],
    ['7 Mwmbl', '通用英文索引，约 2.2s'],
    ['8 Bing 抓页', ws.bing === true ? '开（红线区）' : '关（红线，默认关）'],
  ]) console.log('  ' + n.padEnd(14) + s2);

  for (const cat of ['api', 'nokey', 'selfhost', 'github']) {
    console.log('\n== ' + CAT[cat]);
    for (const p of web.listProviders().filter(r => r.cat === cat)) {
      console.log('  ' + p.verified + ' ' + p.name + ' | Key:' + p.needKey
        + ' | 接入:' + (p.usable ? '是' : '否') + ' | ' + p.quota);
    }
  }

  console.log('\n== 实测（查询「' + q + '」）');
  if (!on) return console.log('  跳过：webSearch.enabled=false');
  try {
    const out = await web._anysearch(q, { count: 3 });
    console.log('  AnySearch 匿名: ' + (out ? '通，' + out.split('\n【').length + ' 条' : '没结果（402/429＝当天额度或限流）'));
  } catch (e) { console.log('  AnySearch 匿名: 失败 ' + String(e.message).slice(0, 60)); }
  if (base) {
    try {
      const j = await net.getJson(base + '/search?format=json&q=' + encodeURIComponent(q), { proxy: '', timeout: 8000 });
      const n = (j.results || []).length;
      console.log('  SearXNG: 通，' + n + ' 条' + (n ? '' : '（0 条看 engines 是否开着）'));
    } catch (e) {
      const m = String(e.message).slice(0, 60);
      console.log('  SearXNG: 失败 ' + m + (/403/.test(m) ? ' → settings.yml 的 formats 要加 json' : ''));
    }
  }
  try {
    const j = await net.getJson('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=2&site=stackoverflow&q=' + encodeURIComponent(q), { timeout: 8000 });
    console.log('  StackExchange: 通，' + (j.items || []).length + ' 条（剩 ' + (j.quota_remaining === undefined ? '?' : j.quota_remaining) + ' 次额度）');
  } catch (e) { console.log('  StackExchange: 失败 ' + String(e.message).slice(0, 50)); }
})().catch(e => { console.error('探针失败：' + e.message); process.exit(1); });
