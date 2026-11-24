/*
 * websearch-providers.js — 搜索源清单与免费额度（纯数据，不联网、不依赖别的模块）
 * 2026-11-22 逐条核实，出处与实测见 docs/搜索源核实表.md；改额度前先回官网复核。
 * 分类 cat：api=有免费额度的 Key 制 API｜nokey=零配置免 Key｜selfhost=自托管｜github=参考项目
 * verified：✅核实（官网原文如此）｜⚠️部分（说法与官网有出入，note 里写正确值）｜❌不实（说法错）｜⛔失效
 * usable：当前代码是否真的能调它。要 Key 的源（0 元红线外）一律 usable:false，只登记不调用。
 */
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
  { id: 'brave', name: 'Brave Search API', cat: 'api', needKey: 'required', usable: false, verified: '⚠️部分',
    quota: '免费档每月最多 $20 调用额度（旧注释「2,000 次/月」是旧价目，已不准确）',
    source: 'https://brave.com/search/api/',
    note: '2026-11-23 按主人令从代码删除（要 Key）。要恢复就在 GENERIC_SOURCES 里加回一跳。' },
  { id: 'googlecse', name: 'Google CSE', cat: 'api', needKey: 'required', usable: false, verified: '✅核实',
    quota: '100 次/日（Custom Search JSON API 免费层）',
    source: 'https://developers.google.com/custom-search/v1/overview',
    note: '2026-11-23 按主人令从代码删除（要 Key）。' },
  { id: 'youcom', name: 'You.com', cat: 'api', needKey: 'none', usable: false, verified: '⚠️部分',
    quota: '免费档 100 次/日，无 Key、无账号、无信用卡 —— 但只走 MCP 通道',
    source: 'https://you.com/pricing',
    note: '没有直连 REST 的免 Key 端点，本仓库没有 MCP 客户端，所以不接。' },

  // —— ② 零配置免 Key（本项目一个都不接）——
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

  // —— ⑤ 零配置免 Key 且在跑（2026-11-23 主人令「付费都删、免费保留」）——
  { id: 'stackexchange', name: 'Stack Exchange API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '300 次/日/IP（匿名无 Key，配 Key 提到 10,000 次/日）',
    source: 'https://api.stackexchange.com/docs',
    note: '2026-11-23 实测 200；只吃英文技术词，中文查询返回 0 条 → 只在命中「报错/error/exception」时才跑。' },
  { id: 'arxiv', name: 'arXiv API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；官方要求每秒不超过 1 次、别狂刷',
    source: 'https://info.arxiv.org/help/api/index.html',
    note: '只给 Atom XML（没有 JSON），代码里用 getText 粗抽标题/摘要。必须走 https，http 会 301。' },
  { id: 'openlibrary', name: 'Open Library API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；官方建议礼貌使用（大批量请走 dump）',
    source: 'https://openlibrary.org/developers/api',
    note: '2026-11-23 实测 200；只查书/作者，命中「书/作者/isbn」才跑。' },
  { id: 'hn-algolia', name: 'Hacker News (Algolia)', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；每 IP 每小时 10,000 次',
    source: 'https://hn.algolia.com/api',
    note: '2026-11-23 实测 200；只能搜 HN 上已提交的条目/评论，命中「hacker news/创业/融资」才跑。' },
  { id: 'github', name: 'GitHub Search API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '未认证 10 次/分钟（搜索接口）；配 token 提到 30 次/分钟',
    source: 'https://docs.github.com/en/rest/search',
    note: '2026-11-23 实测 200；命中「github/仓库/开源项目」才跑。走 fetch（net.getJson 在这家会崩）。' },
  { id: 'npm', name: 'npm Registry', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；官方建议批量用 replicate，不压接口',
    source: 'https://registry.npmjs.org/-/v1/search',
    note: '2026-11-23 实测 200；命中「npm/package.json/前端依赖」才跑。注意 net.getJson 在这家会打崩进程（exit 139），必须走 fetch。' },
  { id: 'cratesio', name: 'crates.io API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；官方要求带 UA 并控制频率（1 次/秒）',
    source: 'https://crates.io/data-access',
    note: '2026-11-23 实测 200；命中「cargo/crate/rust」才跑。同样必须走 fetch。' },
  { id: 'huggingface', name: 'Hugging Face Models API', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '免费、无 Key；匿名有速率限制（够个人用）',
    source: 'https://huggingface.co/docs/hub/api',
    note: '2026-11-23 实测 200；命中「hugging face/大模型/微调」才跑。中文查询基本搜不到，英文模型名才准。' },
  { id: 'mwmbl', name: 'Mwmbl', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '开源索引，免费无 Key、无硬性额度（官方请求别压太大）',
    source: 'https://api.mwmbl.org/docs',
    note: '2026-11-23 实测 200；索引只有英文网页，中文查询返回 [] → 带中文就不跑，参数是 ?s= 不是 ?q=。' },
  { id: 'anysearch', name: 'AnySearch', cat: 'nokey', needKey: 'none', usable: true, verified: '✅核实',
    quota: '匿名 1,000 次/日、10 QPS（按 IP 限流，不绑卡不要 Key）',
    source: 'https://www.anysearch.com/docs/auth',
    note: 'POST https://api.anysearch.com/v1/search，不带 Authorization 就是匿名档。2026-11-22 本机实测 200 有结果；ws.anysearch=false 可关。' },
];

// 注册表只读副本：给探针脚本 / 面板显示用
function listProviders() {
  return PROVIDERS.map(p => ({ id: p.id, name: p.name, cat: p.cat, needKey: p.needKey,
    quota: p.quota, usable: p.usable, verified: p.verified, source: p.source, note: p.note }));
}

module.exports = { PROVIDERS, listProviders };
