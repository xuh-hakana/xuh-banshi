/*
 * websearch.js — 查资料：免费链优先，付费智谱只做兜底（2026-11-07 主人定：付费的用不起，只能兜底）
 * 顺序：本地知识（core.js 先跑 guides.search）→ 免 Key 官方 API（PokeAPI / 萌娘百科）
 *       → 免费抓页 Bing → 以上全没结果、且 webSearch.paidFallback=true 时才打智谱（0.01 元/次）。
 * 默认 paidFallback 关：一次查询 0 元。付费代码保留不删，只改调用顺序。
 * 只负责「搜 + 摘录 + 判断结果相不相关」，不负责判断要不要搜（由 core 决定）。
 * 搜索源与免费额度按类登记在文件中部的 PROVIDERS（2026-11-22 逐条核实，出错处与正确值都写在 note 里；
 * 出处见 docs/搜索源核实表.md）。要 Key 的源一律只登记不调用，当前只接 AnySearch（匿名）与 SearXNG。
 * 通用链路：Brave → Google CSE → SearXNG → AnySearch，前一家没结果才轮到下一家。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读取
const pokemon = require('./pokemon');      // 宝可梦专用数据源（0 元、免 Key，见 pokemon.js 顶部说明）
const guides = require('./guides');        // 学到的.md 真写盘：官方直取结果自动沉淀，下次不用再联网
const knowledge = require('./knowledge');  // 维基百科 / Wikidata 官方 API（走代理，0 元 0 Key，2026-11-07 加）
/* ===== 搜索源注册表（2026-11-22 逐条核实；出处与实测见 docs/搜索源核实表.md）=====
 * 分类 cat：api=有免费额度的 Key 制 API｜nokey=零配置免 Key｜selfhost=自托管｜github=参考项目
 * verified：✅核实（官网原文如此）｜⚠️部分（说法与官网有出入，note 里写正确值）｜❌不实（说法错）｜⛔失效
 * usable：当前代码是否真的能调它。只接 needKey==='none' 且实测通的源；要 Key 的一律只登记不调用。
 * 额度随时会变，每条都带 source，别删出处。改额度前先去官网复核。 */
const PROVIDERS = [
  // —— ① 有免费额度的 Key 制 API（不接：要 Key，0 元红线之外）——
  { id: 'tavily', name: 'Tavily', cat: 'api', needKey: 'required', usable: false, verified: '✅核实',
    quota: '1,000 credits/月（basic 搜索 1 credit/次 ≈1,000 次；advanced 2 credits/次 = 500 次）',
    source: 'https://docs.tavily.com/documentation/api-credits',
    note: '免信用卡，每月重置。方案里的「1,000 次/月」基本准确，但 advanced 会翻倍扣。' },
  { id: 'exa', name: 'Exa', cat: 'api', needKey: 'required', usable: false, verified: '❌不实',
    quota: '每月 $10 信用额度（每月 1 号重置）≈ 2,500 次 Lite 搜索（$4/1k）',
    source: 'https://exa.ai/docs/reference/pricing',
    note: '不是「1,000 次/月」。按美元额度算，搜索深度不同扣费不同。' },
  { id: 'websearchapi', name: 'WebSearchAPI.ai', cat: 'api', needKey: 'required', usable: false, verified: '✅核实',
    quota: '2,000 search credits/月（Free 档，$0/月）',
    source: 'https://websearchapi.ai/pricing',
    note: '和方案一致。1 credit ≠ 1 次，深度检索会多扣。' },
  { id: 'serper', name: 'Serper', cat: 'api', needKey: 'required', usable: false, verified: '❌不实',
    quota: '注册一次性 2,500 次，不按月重置、用完即止',
    source: 'https://serper.dev/',
    note: '官网只写「Get 2,500 free queries」，没有任何每月恢复。' },
  { id: 'brave', name: 'Brave Search API', cat: 'api', needKey: 'required', usable: true, verified: '⚠️部分',
    quota: '免费档每月最多 $20 调用额度（旧注释「2,000 次/月」是旧价目，已不准确）',
    source: 'https://brave.com/search/api/',
    note: '代码里已在用（ws.braveKey）；额度按美元折算，1 次查询约 $0.005 上下。' },
  { id: 'googlecse', name: 'Google CSE', cat: 'api', needKey: 'required', usable: true, verified: '✅核实',
    quota: '100 次/日（Custom Search JSON API 免费层）',
    source: 'https://developers.google.com/custom-search/v1/overview',
    note: '代码里已在用（ws.googleKey + ws.googleCx）。' },
  { id: 'youcom', name: 'You.com', cat: 'api', needKey: 'none', usable: false, verified: '⚠️部分',
    quota: '免费档 100 次/日，无 Key、无账号、无信用卡 —— 但只走 MCP 通道',
    source: 'https://you.com/pricing',
    note: '没有直连 REST 的免 Key 端点，本仓库没有 MCP 客户端，所以不接。' },

  // —— ② 零配置免 Key（能接的都接了）——
  { id: 'anysearch', name: 'AnySearch', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '匿名 1,000 次/日（按 IP 限流，10 QPS）；带 Key 走付费额度',
    source: 'https://www.anysearch.com/docs/auth',
    note: 'POST https://api.anysearch.com/v1/search，不带 Authorization 就是匿名档。2026-11-22 本机实测 200 有结果。' },
  { id: 'marginalia', name: 'Marginalia', cat: 'nokey', needKey: 'required', usable: false, verified: '⚠️部分',
    quota: '要 API-Key 头；开发可用公共 key「public」，但限流、不能自定义过滤',
    source: 'https://about.marginalia-search.com/article/api/',
    note: '不是「无密钥端点」。2026-11-22 实测公共 key 直接 429 QPM Limit Exceeded。' },
  { id: 'duckduckgo', name: 'DuckDuckGo', cat: 'nokey', needKey: 'none', usable: false, verified: '❌不实',
    quota: 'Instant Answer API 只返回摘要/话题，不是网页搜索结果',
    source: 'https://duckduckgo.com/api',
    note: '想拿网页结果只能抓 html/lite 端点 —— 那是对抗性抓页（2026-11-07 红线），不接。' },
  { id: 'firecrawl', name: 'Firecrawl', cat: 'nokey', needKey: 'required', usable: false, verified: '❌不实',
    quota: '免费档 1,000 credits/月（≈500 次搜索），/v2/search 必须带 API Key',
    source: 'https://www.firecrawl.dev/pricing',
    note: '「/v2/search 无需 Key」不成立，匿名调用会 401。' },

  // —— ③ 自托管（完全免费，但要自己跑进程）——
  { id: 'searxng', name: 'SearXNG', cat: 'selfhost', needKey: 'none', usable: true, verified: '✅核实',
    quota: '自建不限量、无 Key；但 settings.yml 默认 formats 只有 html，必须加 json 才有 JSON 接口',
    source: 'https://docs.searxng.org/admin/settings/settings_search.html',
    note: '代码里已接（ws.searxUrl，如 http://127.0.0.1:8888）。内存「约 200MB」未实测，不写进结论。' },
  { id: 'crw', name: 'CRW (fastcrw/crw)', cat: 'selfhost', needKey: 'none', usable: false, verified: '✅核实',
    quota: '本地 Rust 二进制，免费、免账号；云版 1,000 免费 credits',
    source: 'https://github.com/fastcrw/crw',
    note: '是本地进程/MCP 工具，不是本仓库能直接 fetch 的 REST；要用得单独部署。' },
  { id: 'infomesh', name: 'InfoMesh', cat: 'selfhost', needKey: 'none', usable: false, verified: '✅核实',
    quota: 'P2P 网络，永久免费无上限，但必须跑自己的节点',
    source: 'https://github.com/dotnetpower/infomesh',
    note: '只有 Python MCP 包（pip install infomesh），没有公开 REST；不接。' },

  // —— ④ GitHub 参考项目（只登记，不当数据源）——
  { id: 'searxng-rest', name: 'pratyay360/searchapi', cat: 'github', needKey: 'none', usable: false, verified: '✅核实',
    quota: 'SearXNG 驱动的可部署 REST 封装，免费', source: 'https://github.com/pratyay360/searchapi',
    note: '等于把 SearXNG 包一层 HTTP，本仓库已有 searxUrl，不必再套。' },
  { id: 'search-mcp', name: 'denysvitali/search-mcp', cat: 'github', needKey: 'required', usable: false, verified: '✅核实',
    quota: 'Tavily 的 MCP 封装，额度沿用 Tavily', source: 'https://github.com/denysvitali/search-mcp',
    note: '仓库真实存在，但不是免 Key 方案。' },
];

// 当前生效的免 Key 源（只这些会被 generalWeb 调用）
const USE_ANYSEARCH = ws => ws.anysearch !== false;   // AnySearch 匿名：默认开
const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const cache = new Map();      // query -> {t, text}   成功缓存 10 分钟
const failCache = new Map();  // query -> 失败时间     失败缓存 60 秒（免得每条消息都重付一次注定失败的往返）
const inflight = new Map();   // query -> Promise     同一查询并发只发一次
let wsDeadUntil = 0;          // 智谱搜索额度用完（429/1113）→ 这段时间直接走免费兜底，不再白撞

function cfg() {
  try {
    const c = configStore.cfgLive();
    return { ws: c.webSearch || {}, llm: c.llm || {} };
  } catch { return { ws: {}, llm: {} }; }
}

async function search(query) {
  const { ws, llm } = cfg();
  if (ws.enabled === false) return '';
  // 免费链不需要 key；只有付费兜底才检查 llm.apiKey（见 paidSearch）
  const q = String(query || '').slice(0, 70);
  if (!q) return '';

  const hit = cache.get(q);
  if (hit && Date.now() - hit.t < (hit.ttl || 10 * 60 * 1000)) return hit.text;   // 「没搜到」只缓存 2 分钟
  const fail = failCache.get(q);
  if (fail && Date.now() - fail < 60 * 1000) return '';   // 刚失败过：一分钟内别再白跑
  if (failCache.size > 300) failCache.clear();            // 失败表别无限涨
  const flying = inflight.get(q);
  if (flying) return flying;                              // 同一句已经有人在搜了，等它

  const p = (async () => {
    try {
      // 免费链先跑（0 元）：免 Key 官方 API → 免费抓页。付费智谱只在全空且开关打开时才碰。
      const free = await freeFallback(q, ws);
      const miss = !!free && /^（联网查过了/.test(free);   // 这是「查过了但没查到」的说明，不是答案
      if (free && !miss) { failCache.delete(q); return free; }

      if (ws.paidFallback === true && llm.apiKey) {
        const paid = await paidSearch(q, ws, llm);
        if (paid) { failCache.delete(q); return paid; }
      }
      if (free) { failCache.delete(q); return free; }   // 没查到就照实给方向，不许编
      failCache.set(q, Date.now());
      return '';
    } catch (e) {
      console.log('[web] 查资料失败', e.message);
      failCache.set(q, Date.now());
      return '';
    } finally {
      inflight.delete(q);
    }
  })();
  inflight.set(q, p);
  return p;
}

/* ===== 通用网页搜索（0 元源，2026-11-22 主人令「多配几个全场景的网页、可走代理、不要付费搜索」）=====
 * 顺序：Brave（免费 2000 次/月）→ Google CSE（免费 100 次/日）→ 自建 SearXNG（Docker，不限量）。
 * 三个都只调官方 JSON 接口，不解析 HTML、不伪装 UA（守 2026-11-07 的红线）。
 * 配置在 llm.json 的 webSearch：braveKey / googleKey / googleCx / searxUrl；proxy 沿用现有那套。 */
async function proxyFor(ws) {
  try {
    if (!ws || !ws.proxy || ws.proxy.enabled === false) return '';
    if (ws.proxy.url) return String(ws.proxy.url);
    const net = require('./net');
    return await net.resolveProxy(ws.proxy);
  } catch (e) { return ''; }
}

function fmtHits(hits, limit) {
  return hits.slice(0, limit || 5).map((r, i) =>
    `【${i + 1}】${r.title || ''}\n${(r.content || '').trim()}\n来源：${r.link || ''}`).join('\n\n');
}

// ===== AnySearch：零配置免 Key 的通用网页搜索（2026-11-22 核实后接入）=====
// 匿名模式：不带 Authorization 头就能搜，额度 1,000 次/日、按 IP 限流（docs/auth 原文）。
// 响应 {data:{results:[{title,url,snippet,content}]}}（docs/api-endpoints/v1-search.md）。
// POST 要 body，net.js 只有 GET → 用全局 fetch（和 paidSearch 一样，这条不走代理）。
let anyDeadUntil = 0;   // 402 额度用完 / 429 限流 → 冷却期内不再敲，别每条消息白撞
const ANYSEARCH_API = 'https://api.anysearch.com/v1/search';

async function anysearchSearch(q, ws) {
  if (Date.now() < anyDeadUntil) return '';
  const want = Number(ws.count || 5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(ANYSEARCH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, max_results: want }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 402 || res.status === 429) {
        anyDeadUntil = Date.now() + 10 * 60 * 1000;
        console.log('[web] AnySearch ' + res.status + '（匿名额度/限流）→ 10 分钟内不再敲');
      } else {
        console.log('[web] AnySearch HTTP ' + res.status);
      }
      return '';
    }
    const j = await res.json();
    const hits = (((j.data || {}).results) || []).map(r => ({
      title: String(r.title || ''),
      content: String(r.snippet || r.content || '').slice(0, 240),
      link: r.url,
    })).filter(h => h.link);
    if (!hits.length) return '';
    console.log('[web] AnySearch 搜到 ' + hits.length + ' 条「' + q + '」');
    return fmtHits(hits, want);
  } catch (e) {
    console.log('[web] AnySearch 失败：' + (e.name === 'AbortError' ? '超时' : String(e.message).slice(0, 40)));
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function generalWeb(q, ws) {
  const net = require('./net');
  const proxy = await proxyFor(ws);
  const timeout = 8000;
  const want = Number(ws.count || 5);
  // ① Brave
  if (ws.braveKey) {
    try {
      const u = 'https://api.search.brave.com/res/v1/web/search?count=' + want + '&q=' + encodeURIComponent(q);
      const j = JSON.parse(await net.getText(u, { proxy, timeout, header: 'X-Subscription-Token: ' + ws.braveKey + '\r\nAccept: application/json' }));
      const hits = ((j.web && j.web.results) || []).map(r => ({ title: r.title, content: r.description, link: r.url }));
      if (hits.length) { console.log('[web] Brave 搜到 ' + hits.length + ' 条「' + q + '」'); return fmtHits(hits, want); }
    } catch (e) { console.log('[web] Brave 失败：' + String(e.message).slice(0, 40)); }
  }
  // ② Google CSE
  if (ws.googleKey && ws.googleCx) {
    try {
      const u = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(ws.googleKey)
        + '&cx=' + encodeURIComponent(ws.googleCx) + '&num=' + want + '&q=' + encodeURIComponent(q);
      const j = await net.getJson(u, { proxy, timeout });
      const hits = (j.items || []).map(r => ({ title: r.title, content: r.snippet, link: r.link }));
      if (hits.length) { console.log('[web] Google 搜到 ' + hits.length + ' 条「' + q + '」'); return fmtHits(hits, want); }
    } catch (e) { console.log('[web] Google 失败：' + String(e.message).slice(0, 40)); }
  }
  // ③ 自建 SearXNG（ws.searxUrl，如 http://127.0.0.1:8888）
  if (ws.searxUrl) {
    try {
      const base = String(ws.searxUrl).replace(/\/+$/, '');
      const j = await net.getJson(base + '/search?format=json&q=' + encodeURIComponent(q), { proxy: '', timeout });
      const hits = (j.results || []).map(r => ({ title: r.title, content: r.content, link: r.url }));
      if (hits.length) { console.log('[web] SearXNG 搜到 ' + hits.length + ' 条「' + q + '」'); return fmtHits(hits, want); }
    } catch (e) {
      // 403/格式错基本就一个原因：settings.yml 的 search.formats 默认只有 html，没加 json
      const msg = String(e.message).slice(0, 40);
      console.log('[web] SearXNG 失败：' + msg + (/403/.test(msg) ? '（settings.yml 的 formats 要加 json）' : ''));
    }
  }
  // ④ AnySearch（零配置免 Key，匿名 1,000 次/日；实测通，见 PROVIDERS）
  if (USE_ANYSEARCH(ws)) {
    const any = await anysearchSearch(q, ws).catch(() => '');
    if (any) return any;
  }
  return '';
}

// 付费兜底：只有 webSearch.paidFallback=true 才会走到这里（0.01 元/次）。
// 2026-11-07 主人定「用不起，只能兜底」→ 原实现整段保留，只从「第一顺位」挪到「最后一顺位」。
async function paidSearch(q, ws, llm) {
  if (Date.now() < wsDeadUntil) return '';   // 额度用完，30 分钟内不白撞
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        search_query: q,
        search_engine: ws.engine || 'search_std',
        count: ws.count || 5,
        content_size: 'medium',
      }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j.search_result) || !j.search_result.length) {
      console.log('[web] 付费搜索无结果', res.status, j.error ? j.error.message : '');
      if (res.status === 429 || (j.error && String(j.error.code) === '1113')) {
        wsDeadUntil = Date.now() + 30 * 60 * 1000;
        console.log('[web] 额度用完 → 30 分钟内不再敲付费接口');
      }
      return '';
    }
    const text = j.search_result.slice(0, ws.count || 5).map((r, i) =>
      `【${i + 1}】${r.title || ''}\n${(r.content || '').trim()}\n来源：${r.link || r.url || ''}`
    ).join('\n\n');
    cache.set(q, { t: Date.now(), text });
    console.log(`[web] 付费兜底搜到 ${j.search_result.length} 条「${q}」`);
    return text;
  } catch (e) {
    console.log('[web] 付费搜索失败', e.name === 'AbortError' ? '超时' : e.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 预热（2026-10-22 速度优化）：主人说话要等「说完才答」（≥6 秒），这段时间足够把搜索跑完。
// qq.js 在等他说话时就先把可能要搜的词发出去，等 buildMessages 真正要搜时直接命中缓存。
// 结果和 search 共用同一个缓存；就算猜错白搜一次，也只是后台一次请求，不拖慢任何人。
function prewarm(query) {
  // 2026-11-07 起预热走免费链，0 元：不碰付费接口。仍要节流，免得猜词白跑一堆免费抓页。
  // 预热是「猜主人接下来会问什么」，命中率本来就不满；既然刚失败过就别再白跑一次。
  const q = String(query || '').slice(0, 70);
  if (cache.has(q)) return;                                  // 已经有结果了，不用再搜
  const fail = failCache.get(q);
  if (fail && Date.now() - fail < 5 * 60 * 1000) return;      // 5 分钟内失败过 → 不预热
  search(query).catch(() => {});
}

// ===== 免费兜底：抓 Bing 中文版搜索结果页（主人 2026-10-23 问「有没有免费的」——这就是）=====
// 智谱 search_std 要钱（0.01 元/次），没余额就 429「余额不足或无可用资源包」。
// Bing 结果页是静态 HTML，抓回来正则抽标题/摘要/链接，0 成本；只当智谱失败时才用。
async function bingScrape(q) {
  try {
    // 用国际版 + setlang/mkt 指定中文：实测 cn.bing.com 会把「越长大越孤单」拆成单字「越」，
    // 结果全是汉语字典，质量还不如没有。国际版同样免 Key，中文结果正常。
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&mkt=zh-CN';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    const strip = s => String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;|&ensp;|&emsp;|&thinsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
    while ((m = re.exec(html)) && out.length < 6) {
      const title = strip(m[2]);
      const content = strip(m[3]);
      if (!title) continue;
      // 过滤掉明显没用的：整页只有导航/空摘要
      if (content.length < 8) continue;
      out.push({ title, content: content.slice(0, 220), link: m[1].startsWith('http') ? m[1] : ('https://www.bing.com' + m[1]) });
    }
    return out;
  } catch { return []; }
}

// ===== 兜底结果相关性过滤（2026-11-02，主人定）=====
// 起因：智谱搜索一直 429（code 1113 余额不足或无可用资源包）→ 每次都落到 Bing 抓页。
// 而 Bing 抓到长中文查询时会把句子拆开、只认第一个词（实测，换 cn.bing / 去掉 mkt / 加引号都一样）：
//   「超级烈空坐」 → 超级简历、超级_百度百科
//   「烈空坐种族值」 → 烈（汉语文字）_百度百科、汉典
//   「宝可梦种族值排名」 → 宝（汉语文字）_百度百科、淘宝
//   （只搜纯名字就正常：烈空坐 / 无极汰那 / 宝可梦种族值 / 皮卡丘种族值 全对）
// 这些网页跟问题毫无关系，以前却原样喂给模型 → 模型只能用记忆里的数字硬答（701 / 634 就是这么来的）。
// 现在两道关：① 同样的意思再搜一次「只留名字」的短词（去掉超级/极巨化这类修饰、去掉种族值/排名这类尾巴）；
//            ② 结果的「二字组」覆盖率不到 1/3 的一律丢掉；两条路都空就明说「没查到」，逼它老实说记不清。

// 剥掉疑问/指令后缀，只留核心词去搜（词越短，Bing 越不容易拆错）
function bingQuery(q) {
  const s = String(q || '')
    .replace(/帮我(搜索|查|查一下|查下|搜|看看)|搜索一下|搜一下|搜索|查一下|查查|查下|搜搜|请问/g, '')
    .replace(/是多少(?!钱)|是什么梗|是什么歌|是什么意思|是什么|啥意思|什么梗|怎么样|好吗|呀|啊|吗|呢|吧/g, '')
    .replace(/^[，,。\s]+|[，,。！!？?；;：:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || String(q || '').replace(/\s+/g, ' ').trim();
}

// 再剥一层：把「超级/极巨化」这类修饰词和「种族值/排名」这类尾巴去掉，只留名字本身。
// 这一层是为 Bing 准备的——它认「烈空坐」不认「超级烈空坐种族值」。
const MOD_HEAD = /^(超级|究极|原始|极巨化|无极巨化|超级巨|伽勒尔|阿罗拉|洗翠|帕底亚|mega|Mega)/;
const ATTR_TAIL = /(种族值|种族|数值|排名|排行|排行榜|大全|图鉴|数据|资料|价格|多少钱|技能|配招|进化|属性|相性|特性|攻略|打法|介绍|区别|对比|意思|出处|多少|谁|厉害|更强|更厉害|谁赢|打得过|打的过|打得赢|能打过)$/;

function looseQuery(q) {
  let s = String(q || '').replace(/^[\s，,。]+/, '').trim();
  s = s.replace(MOD_HEAD, '').trim();
  for (let i = 0; i < 3; i++) {                    // 尾巴可能连着两层（「种族值排名」）
    const t = s.replace(ATTR_TAIL, '').trim();
    if (t === s) break;
    s = t;
  }
  return s.length >= 2 ? s : '';
}

// 切「二字组」：中文没有分词器，就按相邻两个字切，勉强够用来判相关性
function grams(s) {
  const set = new Set();
  const clean = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  for (const tok of clean.split(' ')) {
    if (tok.length < 2) continue;
    for (let i = 0; i + 1 < tok.length; i++) set.add(tok.slice(i, i + 2));
  }
  return set;
}

const RELEVANT_MIN = 0.34;   // 覆盖率门槛：实测真结果 60%~85%，拆错的结果只有「超级」这类 14%

function relevant(key, item) {
  const gs = grams(key);
  if (!gs.size) return true;                    // 只剩单字（比如「雨」）→ 判不了，别乱丢
  const hay = (String(item.title || '') + ' ' + String(item.content || ''))
    .toLowerCase().replace(/\s+/g, '');
  let hit = 0;
  for (const g of gs) if (hay.indexOf(g) >= 0) hit++;
  return hit / gs.size >= RELEVANT_MIN;
}


// ===== 萌娘百科：只能「按标题取正文」（2026-11-02，主人问「动漫这条怎么办」）=====
// 为什么只能这样接（实测数据见 名词解释 §55）：
//   网页 → Cloudflare 人机校验，脚本拿到的是 403「Just a moment...」；
//   API 的搜索/parse/revisions → action-notallowed: Unauthorized API call；
//   但 prop=extracts 还开着：初音未来 21726 字/0.6s、原神 8377 字/2.4s、FGO 21548 字/4.9s。
// 所以这条只能「按标题取正文」：先从问句猜条目名，猜中就取，猜不中就安静回去抓 Bing，绝不硬凑。
const MOE_API = 'https://zh.moegirl.org.cn/api.php';
const MOE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const moeCache = new Map();     // 条目名 -> { t, text }（空字符串=确认没这条，也缓存，免得反复问）
let moeDeadUntil = 0;           // 连续失败 → 歇一段时间，别每条消息都去撞
let moeFailN = 0;
let moeFailAt = 0;

// 只有「在问某个东西是什么」的句子才值得去萌娘查；问天气、问价钱、问代码的句子一律不碰
const MOE_HINT = /(是谁|是什么|是啥|什么梗|什么意思|介绍|百科|设定|出处|来历|背景|声优|角色|动漫|动画|漫画|番剧|轻小说|galgame|Galgame|VTuber|vtuber)/;
const MOE_CUT = /(是谁|是什么|是啥|什么梗|什么意思|的?来历|的?出处|的?设定|的?故事|的?背景|介绍|资料|百科|的?能力|的?武器|的?名字|怎么读|怎么念|好玩吗|怎么样|游戏|动漫|动画|漫画|角色|作品|番剧|轻小说|系列|呀|啊|吗|呢|吧|请问|帮我|查一下|搜一下)/g;

function moeTitles(q) {
  const raw = String(q || '');
  const out = [];
  const quoted = raw.match(/[「『“"]([^」』”"]{2,20})[」』”"]/);
  if (quoted) out.push(quoted[1]);
  const bare = raw.replace(/[「」『』“”"']/g, ' ')
    .replace(MOE_CUT, ' ')
    .replace(/[，,。！!？?；;：:、]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (bare && bare.length <= 20) out.push(bare);
  const head = bare.split(/[的和与跟]/)[0].trim();
  if (head && head !== bare && head.length >= 2) out.push(head);
  return [...new Set(out.map(s => String(s).trim()).filter(s => s.length >= 2))].slice(0, 3);
}

async function moeExtract(title) {
  const hit = moeCache.get(title);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.text;
  const url = MOE_API + '?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles='
    + encodeURIComponent(title);
  const res = await fetch(url, { headers: { 'User-Agent': MOE_UA }, signal: AbortSignal.timeout(8000) });
  const j = await res.json();
  if (j && j.error) throw new Error('api ' + j.error.code);            // action-notallowed 之类
  const page = j && j.query && j.query.pages ? Object.values(j.query.pages)[0] : null;
  if (!page || page.missing !== undefined) { moeCache.set(title, { t: Date.now(), text: '' }); return ''; }
  const text = String(page.extract || '').replace(/\r/g, '')
    .replace(/^={2,}\s*.*?\s*={2,}$/gm, '')     // 去掉 == 作品简介 == 这类标题标记，只留正文
    .replace(/\n{3,}/g, '\n\n').trim();
  const keep = text.length >= 120 ? text : '';
  moeCache.set(title, { t: Date.now(), text: keep });
  if (moeCache.size > 120) moeCache.delete(moeCache.keys().next().value);
  return keep;
}

async function moegirlLookup(q) {
  if (Date.now() < moeDeadUntil) return '';
  if (!MOE_HINT.test(String(q || ''))) return '';        // 不像「问某个东西是什么」，不碰
  for (const t of moeTitles(q)) {
    let text = '';
    try {
      text = await moeExtract(t);
    } catch (e) {
      // 超时是网络抖动（实测同一条目 0.6~7.6 秒都出现过），不算「萌娘挂了」，也就不进封禁计数
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        console.log('[moe] 取「' + t + '」超时，这次跳过');
        continue;
      }
      // 接口级错误（action-notallowed 等）：换标题也没用，记一笔就走
      moeFailN = Date.now() - moeFailAt < 5 * 60 * 1000 ? moeFailN + 1 : 1;
      moeFailAt = Date.now();
      console.log('[moe] 取「' + t + '」失败：' + String(e.message).slice(0, 40));
      if (moeFailN >= 3) {
        moeDeadUntil = Date.now() + 30 * 60 * 1000;
        console.log('[moe] 连续失败，30 分钟内不再敲萌娘');
      }
      return '';
    }
    if (!text) continue;
    // 自检：正文里必须再出现这个标题，否则可能跳到了同名的别的东西（例如问人物却拿到同名歌曲）
    if (text.indexOf(t) < 0) continue;
    moeFailN = 0;
    const body = text.length > 1200
      ? text.slice(0, 1200).replace(/[。！？\n][^。！？\n]*$/, '') + '……'
      : text;
    console.log('[moe] 命中「' + t + '」，' + text.length + ' 字');
    return '（萌娘百科条目「' + t + '」，按标题直取的正文节选，是人工维护的资料；'
      + '只许照这里说，这里没写的讲已知、给方向）\n\n' + body;
  }
  return '';
}

// 免费主路径（2026-11-07 主人定）：先看是不是「有确定数据可查」的题（宝可梦），
// 再看是不是动漫/角色类（萌娘），最后退回免费抓页。三段都 0 元、免 Key、国内实测可连。
// 为什么宝可梦排前面：抓 Bing 得到的是一堆二手网页，模型还得从里面挑；PokeAPI 给的是官方数字，
// 直接照抄就不会错。而且它在本地先判断「这句话里有没有宝可梦名」，没提到就 0 毫秒返回，不拖慢别的题。
// 官方直取的结果自动沉淀到 data/guides/学到的.md（＝主动学习）：下次同类问题搜本地就够，不用再联网。
// 抓来的网页来源杂，不沉淀，避免把二手错话写成「已核实」。
async function freeFallback(q, ws) {
  if (ws.pokemon !== false) {
    const pk = await pokemon.lookup(q).catch(() => null);
    if (pk) {
      rememberOfficial(q, pk, 'PokeAPI 官方游戏数据');
      cache.set(q, { t: Date.now(), text: pk });
      return pk;
    }
  }
  if (ws.moegirl !== false) {
    const moe = await moegirlLookup(q).catch(() => '');
    if (moe) {
      rememberOfficial(q, moe, '萌娘百科官方 API');
      cache.set(q, { t: Date.now(), text: moe });
      return moe;
    }
  }
  // 维基百科 / Wikidata：官方 JSON API，0 元 0 Key，走代理（主人 2026-11-07 要求加代理）。
  // 放在萌娘之后：二次元问题萌娘更准，通用知识维基覆盖更广。
  if (ws.wikipedia !== false) {
    const kb = await knowledge.lookup(q, { proxyCfg: ws.proxy }).catch(() => '');
    if (kb) {
      rememberOfficial(q, kb, kb.includes('Wikidata') ? 'Wikidata 官方 API' : '维基百科官方 API');
      cache.set(q, { t: Date.now(), text: kb });
      return kb;
    }
  }
  // 通用网页搜索（0 元官方 API，2026-11-22 加）：官方三源没命中时兜底；面板开关 webSources 关掉就不跑
  {
    let _mode = {};
    try { _mode = (configStore.cfgLive().intent || {}).mode || {}; } catch (e) { _mode = {}; }
    if (_mode.webSources !== false) {
      const g = await generalWeb(q, ws).catch(() => '');
      if (g) { cache.set(q, { t: Date.now(), text: g }); return g; }
    }
  }
  // 抓 Bing 结果页属于「绕过官方网站 API 直接抓网页」——主人 2026-11-07 明确这是红线。
  // 所以默认关闭，只有显式配 ws.bing === true 才走（代码保留，不删）。
  if (ws.bing !== true) return '';
  return bingFallback(q, ws);
}

function rememberOfficial(q, text, source) {
  try { guides.learnAuto(q, text, source); }
  catch (e) { console.log('[web] 学到的.md 沉淀失败：' + e.message); }
}

// ===== 第一次查不中时的补救（2026-11-06，主人：不要一查不中就回「记不清、不敢乱说」）=====
// 只在 bingFallback 判定「本来要放弃」时启动：把求助型长句压成更好搜的短词，再抓一轮 Bing。
// Bing 认短词、整句必被拆成单字（见上方注释）：剥掉「怎么办/怎么弄/如何/解决方法」求助尾巴、
// 「用了十年的」这类时量/领属前缀，只留核心词。免 Key、不多花模型调用，最多一轮、不递归、8 秒封顶。
const HELP_TAIL = /(怎么办|怎么弄|咋办|咋整|如何解决|如何|解决方法|解决办法|怎么处理|怎么解决|该咋办|怎样解决|怎么搞|求助)[。！？!?\s]*$/;
function retryKey(q) {
  let s = bingQuery(q);
  s = s.replace(HELP_TAIL, '').trim();
  s = s.replace(/[，,。！!？?；;：:\s]+$/g, '').replace(/[了的地得]+$/g, '').trim();
  s = s.replace(/^.{1,8}的/, '').trim();        // 剥「用了十年的」「我朋友的」这类修饰
  return s.length >= 2 ? s : '';
}

// 智谱用不了时的免费兜底：抓 Bing → 过滤无关结果 → 拼成给模型看的摘要
// 同时搜「原句核心」和「只留名字」两条，谁的结果真的相关就用谁（Bing 只认短词，长句一定废）
async function bingFallback(q, ws) {
  const coreQ = bingQuery(q);
  const loose = looseQuery(coreQ);
  const cands = [{ q: coreQ, key: coreQ }];
  if (loose && loose !== coreQ) cands.push({ q: loose, key: loose });
  // 「盖欧卡和固拉多谁厉害」「A 打得过 B 吗」这类对话题：Bing 认不出整句，就只搜前一半，至少拿到一边的真数据
  const side = loose.split(/(?:打的?过|打的?赢|能不能打过|vs\.?|VS|和|跟|与)/)[0];
  if (side && side.length >= 2 && side !== loose && side !== coreQ) cands.push({ q: side, key: side });

  const lists = await Promise.all(cands.map(c => bingScrape(c.q).catch(() => [])));
  let best = null;
  lists.forEach((list, i) => {
    const keep = list.filter(r => relevant(cands[i].key, r));
    if (!best || keep.length > best.keep.length) best = { q: cands[i].q, keep, raw: list.length };
  });
  const alt = (best && best.keep) || [];
  if (!alt.length) {
    if (best && best.raw) console.log(`[web] Bing 兜底 ${best.raw} 条全跟问题无关，已丢弃「${coreQ}」`);
    // 本来要放弃 → 换个更好搜的短词再抓一轮（只在此时启动；常态路径一次都不多跑）
    const rk = retryKey(q);
    if (rk) {
      let tm;
      const retry = await Promise.race([
        (async () => {
          const qs = [...new Set([rk + ' 怎么办', rk + ' 解决方法', rk])];
          const lists = await Promise.all(qs.map(x => bingScrape(x).catch(() => [])));
          let keep = [];
          lists.forEach(list => {
            const ok = list.filter(r => relevant(rk, r));   // 核心词当 key，免得长句把覆盖率拉低
            if (ok.length > keep.length) keep = ok;
          });
          return keep;
        })(),
        new Promise(r => { tm = setTimeout(() => r([]), 8000); }),   // 8 秒封顶，不拖垮回复
      ]);
      clearTimeout(tm);
      console.log(`[web] 原句查不中，换词「${rk}」再查一轮：${retry.length ? '搜到 ' + retry.length + ' 条' : '仍无相关内容'}`);
      if (retry.length) {
        const text = '（联网兜底搜到的，来源杂、可能不准，判断不了就讲已知、给方向）\n\n'
          + retry.slice(0, ws.count || 5).map((r, i) => `【${i + 1}】${r.title}\n${r.content}\n来源：${r.link}`).join('\n\n');
        cache.set(q, { t: Date.now(), text });
        return text;                    // 查到了 → core 走「非 miss」分支，把结果正常讲出来
      }
    }
    const miss = '（联网查过了，**换了词再查仍没查到可靠内容**：搜索引擎把长句拆偏了，'
      + '拿回的网页跟问题对不上。把已查到的线索照实讲、给个查找方向，说清哪部分没查到；'
      + '具体数字和结论一律不许编，也不许拿记忆顶上。）';
    cache.set(q, { t: Date.now(), text: miss, ttl: 2 * 60 * 1000 });
    return miss;
  }
  const text = '（联网兜底搜到的，来源杂、可能不准，判断不了就讲已知、给方向）\n\n'
    + alt.slice(0, ws.count || 5).map((r, i) => `【${i + 1}】${r.title}\n${r.content}\n来源：${r.link}`).join('\n\n');
  cache.set(q, { t: Date.now(), text });
  console.log(`[web] Bing 兜底搜到 ${alt.length} 条「${best.q}」${best.q !== coreQ ? '（原句搜不到，换成短词）' : ''}`);
  return text;
}

// ===== 链接理解（v78，主人 2026-10-23 定）=====
// 起因：主人私聊发了两个网址（soutubot.moe / setumax.pages.dev），她回了
// 「我之前在《白色相簿2》里也遇到过类似的时间流逝……」——纯属硬扯。
// 原因：她只看见一串 URL，网页内容一个字都没看见，又被要求「联系上下文」，就抓了记忆里的游戏顶上。
// 现在：免费抓网页的 <title> / description（不需要 Key、不花钱），抓不到就明确说打不开。
const linkCache = new Map();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function htmlEnt(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

async function sniffLink(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const hit = linkCache.get(u);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.info;
  let info = { title: '', desc: '', ok: false };
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
      redirect: 'follow',
      signal: AbortSignal.timeout(4500),
    });
    if (res.ok) {
      const ct = String(res.headers.get('content-type') || '');
      if (/html|text\/plain|json/i.test(ct)) {
        // 只读前 150KB：够拿 head 里的标题和摘要，再大也没必要
        let html = '';
        try {
          const rd = res.body.getReader();
          let n = 0;
          const dec = new TextDecoder('utf-8', { fatal: false });
          while (n < 150 * 1024) {
            const { done, value } = await rd.read();
            if (done) break;
            n += value.length;
            html += dec.decode(value, { stream: true });
            if (/<\/head>/i.test(html)) break;
          }
          try { rd.cancel(); } catch {}
        } catch {
          html = await res.text();
        }
        const pick = re => { const m = String(html).match(re); return m ? htmlEnt(m[1]) : ''; };
        const title = pick(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)
          || pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
        const desc = pick(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']{1,300})["']/i)
          || pick(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
        info = { title: title.slice(0, 120), desc: desc.slice(0, 240), ok: !!(title || desc) };
      }
    }
  } catch (e) {
    console.log('[link] 打不开 ' + u.slice(0, 60) + '：' + (e.name === 'TimeoutError' ? '超时' : e.message));
  }
  linkCache.set(u, { t: Date.now(), info });
  if (linkCache.size > 100) linkCache.delete(linkCache.keys().next().value);
  return info;
}

// 一条消息里的链接 → 给模型看的说明块（最多看 2 个，别为了一串链接等太久）
async function linkBlock(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s，。！？、）)】」'"<>]+/g) || [];
  const uniq = [...new Set(urls)].slice(0, 2);
  if (!uniq.length) return '';
  // 并行抓，别一个接一个等（主人发两条链接时串行要 9 秒，回复就明显慢了）
  const infos = await Promise.all(uniq.map(u => sniffLink(u).catch(() => null)));
  const lines = [];
  for (let i = 0; i < uniq.length; i++) {
    const u = uniq[i], info = infos[i];
    const short = u.length > 80 ? u.slice(0, 80) + '…' : u;
    if (info && info.ok) {
      lines.push('- ' + short + ' → 标题「' + (info.title || '（没有标题）') + '」'
        + (info.desc ? '；简介：' + info.desc : ''));
    } else {
      lines.push('- ' + short + ' → **打不开，看不到里面是什么**');
    }
  }
  return '（对方发来了链接，我替你打开看了：\n' + lines.join('\n') + '\n'
    + '标题就是网页的名字，可以直接说出来；简介写的它是干什么的。正文我没读，'
    + '所以只许围绕标题/简介说，说不清就讲标题简介、给方向——绝不许拿记忆里的游戏、动漫、作品硬套上去当解释。）';
}

// 注册表只读：给探针脚本 / 面板显示用；额度与核实结论见 docs/搜索源核实表.md
function listProviders() {
  return PROVIDERS.map(p => ({ id: p.id, name: p.name, cat: p.cat, needKey: p.needKey,
    quota: p.quota, usable: p.usable, verified: p.verified, source: p.source, note: p.note }));
}

module.exports = { search, prewarm, sniffLink, linkBlock, listProviders, _providers: PROVIDERS, _anysearch: anysearchSearch,
  _relevant: relevant, _bingQuery: bingQuery, _looseQuery: looseQuery, _moegirl: moegirlLookup, _moeTitles: moeTitles };
