#!/usr/bin/env node
/*
 * websearch-probe.js — 搜索源探针（只读，不改任何配置）
 * 用途：打印 PROVIDERS 注册表（分类/额度/核实状态），并实测当前免 Key 源通不通。
 * 跑法：node scripts/websearch-probe.js ["查询词"]
 * 额度与出处见 docs/搜索源核实表.md；改额度前先回官网复核，别凭记忆改。
 */
const web = require('../src/websearch');
const configStore = require('../src/config');
const net = require('../src/net');

const CAT = { api: '① Key 制 API（要 Key，代码不调）', nokey: '② 零配置免 Key', selfhost: '③ 自托管', github: '④ 参考项目' };
const q = process.argv[2] || 'SearXNG json format';

(async () => {
  const rows = web.listProviders();
  for (const cat of ['api', 'nokey', 'selfhost', 'github']) {
    console.log('\n== ' + CAT[cat]);
    for (const p of rows.filter(r => r.cat === cat)) {
      console.log('  ' + p.verified + ' ' + p.name
        + ' | Key:' + p.needKey + ' | 接入:' + (p.usable ? '是' : '否')
        + ' | 额度:' + p.quota);
    }
  }

  let ws = {};
  try { ws = (configStore.cfgLive().webSearch) || {}; } catch (e) { ws = {}; }
  console.log('\n== 实测（查询「' + q + '」）');

  const t0 = Date.now();
  const any = await web._anysearch(q, { count: 3 }).catch(e => 'ERR ' + e.message);
  console.log('  AnySearch 匿名: ' + (any ? '通（' + (Date.now() - t0) + 'ms）\n' + any.split('\n').slice(0, 4).join('\n') : '没结果（402/429 就是当天额度用完了）'));

  const base = String(ws.searxUrl || '').replace(/\/+$/, '');
  if (!base) {
    console.log('  SearXNG: 没配（webSearch.searxUrl 为空），自建后填 http://127.0.0.1:8888');
  } else {
    try {
      const j = await net.getJson(base + '/search?format=json&q=' + encodeURIComponent(q), { proxy: '', timeout: 8000 });
      const n = (j.results || []).length;
      console.log('  SearXNG: 通，' + n + ' 条' + (n ? '' : '（0 条请看 engines 是否开着）'));
    } catch (e) {
      const m = String(e.message).slice(0, 60);
      console.log('  SearXNG: 失败 ' + m + (/403/.test(m) ? ' → settings.yml 的 formats 要加 json' : ''));
    }
  }

  console.log('\n== Key 现状（Brave/Google 配了就走，属已有链路；Tavily/Exa 只登记不调用）');
  for (const k of ['braveKey', 'googleKey', 'tavilyKey', 'exaKey']) {
    const used = (k === 'braveKey' || k === 'googleKey') ? '会走' : '只登记';
    console.log('  ' + k + ': ' + (ws[k] ? '已填（' + used + '）' : '空（' + used + '）'));
  }
})().catch(e => { console.error('探针失败：' + e.message); process.exit(1); });
