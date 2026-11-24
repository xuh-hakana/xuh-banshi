/*
 * websearch.js — 查资料：全免费链路，不含任何付费接口（2026-11-23 主人令「付费都删、免费保留」）
 * 顺序：本地知识（core.js 先跑 guides.search）→ 宝可梦/PokeAPI → 萌娘百科 → 维基百科
 *       → 通用网页源 Brave → Google CSE → SearXNG → AnySearch（匿名，免 Key，默认开）→ 抓页 Bing（默认关）。
 * 只负责「搜 + 摘录 + 判断结果相不相关」，不负责判断要不要搜（由 core 决定）。
 * 搜索源与免费额度按类登记在 src/websearch-providers.js（2026-11-22 逐条核实，出错处与正确值都写在 note 里；
 * 出处见 docs/搜索源核实表.md）。要 Key 的源只登记不调用；无 Key 源 2026-11-23 按主人令撤除。
 * 通用链路：Brave → Google CSE → SearXNG，前一家没结果才轮到下一家。
 */
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读取
const pokemon = require('./pokemon');      // 宝可梦专用数据源（0 元、免 Key，见 pokemon.js 顶部说明）
const guides = require('./guides');        // 学到的.md 真写盘：官方直取结果自动沉淀，下次不用再联网
const knowledge = require('./knowledge');  // 维基百科 / Wikidata 官方 API（走代理，0 元 0 Key，2026-11-07 加）
const { PROVIDERS, listProviders } = require('./websearch-providers');   // 源清单与核实数据（纯数据，改额度不动逻辑）

const cache = new Map();      // query -> {t, text}   成功缓存 10 分钟
const failCache = new Map();  // query -> 失败时间     失败缓存 60 秒（免得每条消息都重付一次注定失败的往返）
const inflight = new Map();   // query -> Promise     同一查询并发只发一次

function cfg() {
  try {
    const c = configStore.cfgLive();
    return { ws: c.webSearch || {}, llm: c.llm || {} };
  } catch { return { ws: {}, llm: {} }; }
}

async function search(query) {
  const { ws } = cfg();
  if (ws.enabled === false) return '';
  // 全免费链，不需要任何 key；ws.enabled===false 才整条关掉
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
      // 全免费链：官方免 Key API（宝可梦/萌娘/维基）→ 通用网页源（含 AnySearch 匿名）→ 抓页。
      const free = await freeFallback(q, ws);
      const miss = !!free && /^（联网查过了/.test(free);   // 这是「查过了但没查到」的说明，不是答案
      if (free && !miss) { failCache.delete(q); return free; }

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

// 代理：只给要过墙的官方 API 用（自建 SearXNG 是本机地址，走代理反而绕远）；没配就自动探测。
async function proxyFor(ws) {
  try {
    if (!ws || !ws.proxy || ws.proxy.enabled === false) return '';
    if (ws.proxy.url) return String(ws.proxy.url);
    const net = require('./net');
    return await net.resolveProxy(ws.proxy);
  } catch (e) { return ''; }
}

// 给「查官方数据」这一段封顶：萌娘/维基内部是 9s+9s+8s 三段串行，最坏能把回复卡 20 多秒。
// 宁可这段没查到（后面还有通用网页源/Bing/交给 agent），也不能让主人干等。
function withCap(p, ms, fallback) {
  let tm;
  const cap = new Promise(r => { tm = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, cap]).finally(() => clearTimeout(tm));
}

function fmtHits(hits, limit) {
  return hits.slice(0, limit || 5).map((r, i) =>
    `【${i + 1}】${r.title || ''}\n${(r.content || '').trim()}\n来源：${r.link || ''}`).join('\n\n');
}


// ===== AnySearch：零配置免 Key 的通用网页搜索（2026-11-22 核实后接入，2026-11-23 按主人令恢复）=====
// 匿名模式：不带 Authorization 头就能搜，额度 1,000 次/日、按 IP 限流（docs/auth 原文）。
// 响应 {data:{results:[{title,url,snippet,content}]}}（docs/api-endpoints/v1-search.md）。
// POST 要 body，net.js 只有 GET → 用全局 fetch（这条不走代理）。
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

/* ===== 通用网页搜索（0 元官方 API，2026-11-22 加）=====
 * 顺序：Brave → Google CSE → 自建 SearXNG；三家都只调官方 JSON 接口，不解析 HTML、不伪装 UA（守 2026-11-07 红线）。
 * 配置在 llm.json 的 webSearch：braveKey / googleKey / googleCx / searxUrl；proxy 沿用现有那套。
 * 表驱动：加源只往 GENERIC_SOURCES 里加一条，顺序＝数组顺序，前一家没结果才轮到下一家。 */
const GENERIC_SOURCES = [
  {
    id: 'SearXNG',
    ready: ws => !!ws.searxUrl,
    async run(q, ws, net, proxy, want, timeout) {
      const base = String(ws.searxUrl).replace(/\/+$/, '');
      const j = await net.getJson(base + '/search?format=json&q=' + encodeURIComponent(q), { proxy: '', timeout });
      return (j.results || []).map(r => ({ title: r.title, content: r.content, link: r.url }));
    },
    // 403/格式错基本就一个原因：settings.yml 的 search.formats 默认只有 html，没加 json
    hint: e => (/403/.test(String(e.message)) ? '（settings.yml 的 formats 要加 json）' : ''),
  },
  {
    id: 'AnySearch',                                  // 零配置免 Key，匿名 1,000 次/日，默认开（ws.anysearch=false 可关）
    ready: ws => ws.anysearch !== false,
    async run(q, ws, net, proxy, want) { return anysearchSearch(q, ws); },
  },
  {
    id: 'Mwmbl',                                     // 开放索引、免 Key；索引只有英文网页，中文查询必空
    ready: ws => ws.mwmbl !== false,
    async run(q, ws, net, proxy, want) {
      if (/[\u4e00-\u9fa5]/.test(q)) return [];        // 中文它一次都搜不到，别白等两秒
      const j = await net.getJson('https://api.mwmbl.org/search?s=' + encodeURIComponent(q), { proxy, timeout: 8000 });
      return (j || []).map(r => ({
        title: (r.title || []).map(t => t.value).join(''),
        content: (r.extract || []).map(t => t.value).join('').slice(0, 300),
        link: r.url,
      })).filter(h => h.link);
    },
  },
];

async function generalWeb(q, ws) {
  const net = require('./net');
  const proxy = await proxyFor(ws);
  const timeout = 8000;
  const want = Number(ws.count || 5);
  for (const src of GENERIC_SOURCES) {
    if (!src.ready(ws)) continue;                      // 没配 key/地址就跳过，不发请求
    try {
      const hits = await src.run(q, ws, net, proxy, want, timeout);
      if (typeof hits === 'string') { if (hits) return hits; continue; }   // 源自己已经排好版（AnySearch 直接给文本）
      if (hits.length) { console.log('[web] ' + src.id + ' 搜到 ' + hits.length + ' 条「' + q + '」'); return fmtHits(hits, want); }
    } catch (e) {
      const msg = String(e.message).slice(0, 40);
      console.log('[web] ' + src.id + ' 失败：' + msg + (src.hint ? src.hint(e) : ''));
    }
  }
  return '';
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


// ===== 垂直免费源（2026-11-23 加，全部零 Key、零费用）=====
// 只在问题明显属于该领域时才跑（命中词表才调用），避免把技术/论文答案塞进闲聊。
// 额度：StackExchange 300 次/日、arXiv/OpenLibrary 无限但请轻用、HN 无限制但只能搜已提交的条目。
// net.getJson 在 crates.io / registry.npmjs.org 上会把进程直接打崩（exit 139），
// 这两个站用全局 fetch 取（fetch 自己处理 gzip/分块），失败也不影响别的源。
async function fetchJson(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms || 8000), headers: { 'Accept': 'application/json', 'User-Agent': 'xuhbot-search' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function plain(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

const VERTICAL = [
  {
    id: 'StackExchange',
    hit: q => /(报错|错误|异常|失败|不生效|未定义|undefined is not|error|exception|traceback|stackoverflow)/i.test(q),
    async run(q, net) {
      const u = 'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=3'
        + '&site=stackoverflow&filter=withbody&q=' + encodeURIComponent(q);
      const j = await net.getJson(u, { timeout: 8000 });
      return (j.items || []).map(it => ({ title: plain(it.title), content: plain(it.body).slice(0, 320), link: it.link }));
    },
  },
  {
    id: 'arXiv',
    hit: q => /(论文|预印本|文献|arxiv|paper|preprint)/i.test(q),
    async run(q, net) {
      const u = 'https://export.arxiv.org/api/query?search_query=all:' + encodeURIComponent(q) + '&max_results=3';
      // arXiv 只给 Atom XML，没有 JSON 接口 → 用 getText 抓回来粗抽（只取标题/摘要/链接，不解析完整 XML）
      const xml = await net.getText(u, { timeout: 9000 });
      const out = [];
      const re = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = re.exec(xml)) && out.length < 3) {
        const e = m[1];
        const title = plain((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
        const sum = plain((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]);
        const link = plain((e.match(/<id>([\s\S]*?)<\/id>/) || [])[1]);
        if (title && link) out.push({ title, content: sum.slice(0, 320), link });
      }
      return out;
    },
  },
  {
    id: 'OpenLibrary',
    hit: q => /(书|图书|作者|isbn|book|novel|小说)/i.test(q),
    async run(q, net) {
      const j = await net.getJson('https://openlibrary.org/search.json?limit=3&q=' + encodeURIComponent(q), { timeout: 8000 });
      return (j.docs || []).map(d => ({
        title: d.title + (d.author_name && d.author_name.length ? '（' + d.author_name[0] + '）' : ''),
        content: ['初版 ' + (d.first_publish_year || '不详'), (d.subject || []).slice(0, 4).join('、')].filter(Boolean).join('；'),
        link: 'https://openlibrary.org' + (d.key || ''),
      }));
    },
  },
  {
    id: 'HackerNews',
    hit: q => /(hacker ?news|黑客新闻|hn\b|创业|融资|startup)/i.test(q),
    async run(q, net) {
      const j = await net.getJson('https://hn.algolia.com/api/v1/search?hitsPerPage=3&query=' + encodeURIComponent(q), { timeout: 8000 });
      return (j.hits || []).map(h => ({
        title: plain(h.title || h.story_title || ''),
        content: plain(h.comment_text || h.story_text || '').slice(0, 300) || ('热度 ' + (h.points || 0) + '、评论 ' + (h.num_comments || 0)),
        link: h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
      })).filter(h => h.title);
    },
  },
  {
    id: 'GitHub',
    hit: q => /(github|仓库|开源项目|repo|star数)/i.test(q),
    async run(q, net) {
      const j = await fetchJson('https://api.github.com/search/repositories?per_page=3&q=' + encodeURIComponent(q));
      return (j.items || []).map(r => ({
        title: r.full_name + '  ★' + r.stargazers_count,
        content: [r.description, r.language, r.updated_at && ('更新 ' + String(r.updated_at).slice(0, 10))].filter(Boolean).join(' · '),
        link: r.html_url,
      }));
    },
  },
  {
    id: 'npm',
    hit: q => /(npm|package\.json|node 包|nodejs 库|前端依赖)/i.test(q),
    async run(q, net) {
      const j = await fetchJson('https://registry.npmjs.org/-/v1/search?size=3&text=' + encodeURIComponent(q));
      return (j.objects || []).map(o => ({
        title: o.package.name + ' ' + (o.package.version || ''),
        content: [o.package.description, o.package.date && ('发布 ' + String(o.package.date).slice(0, 10))].filter(Boolean).join(' · '),
        link: (o.package.links && o.package.links.npm) || ('https://www.npmjs.com/package/' + o.package.name),
      }));
    },
  },
  {
    id: 'crates.io',
    hit: q => /(cargo|crates?\.io|rust 库|rust crate)/i.test(q),
    async run(q, net) {
      const j = await fetchJson('https://crates.io/api/v1/crates?per_page=3&q=' + encodeURIComponent(q));
      return (j.crates || []).map(c => ({
        title: c.name + ' ' + (c.max_version || ''),
        content: [c.description, c.downloads && ('下载 ' + c.downloads)].filter(Boolean).join(' · '),
        link: 'https://crates.io/crates/' + c.name,
      }));
    },
  },
  {
    id: 'HuggingFace',
    hit: q => /(hugging ?face|大模型|微调|模型权重|checkpoint|safetensors)/i.test(q),
    async run(q, net) {
      const j = await fetchJson('https://huggingface.co/api/models?limit=3&search=' + encodeURIComponent(q));
      return (j || []).map(m => ({
        title: m.id,
        content: ['likes ' + (m.likes || 0), m.pipeline_tag, m.lastModified && ('更新 ' + String(m.lastModified).slice(0, 10))].filter(Boolean).join(' · '),
        link: 'https://huggingface.co/' + m.id,
      }));
    },
  },
];

// 垂直源按词表触发；命中才跑，跑不到就安静地交给后面的通用链
async function verticalLookup(q, ws) {
  const net = require('./net');
  for (const v of VERTICAL) {
    if (!v.hit(q)) continue;
    try {
      const hits = await v.run(q, net);
      if (hits.length) { console.log('[web] ' + v.id + ' 搜到 ' + hits.length + ' 条「' + q + '」'); return fmtHits(hits, 5); }
    } catch (e) { console.log('[web] ' + v.id + ' 失败：' + String(e.message).slice(0, 40)); }
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
  // 三路并发开跑，谁的活干完都不耽搁：垂直源（词表触发）、百科（权威）、通用网页（覆盖广）。
  // 排序按「通用 > 快速 > 兼容」决定「先取谁的结果」，并发只影响等待时间，不影响优先级。
  const vp = verticalLookup(q, ws).catch(() => '');   // 命中词表才真发请求，没命中立刻返回空
  const gp = generalWeb(q, ws).catch(() => '');
  // 萌娘与维基都是「按标题直取」，互不依赖 → 并发跑，萌娘的结果仍优先。
  // 3.5 秒封顶：实测命中多在 1 秒内，超过这个点基本就是查不到，别让它把整条搜索拖到 8 秒。
  const [moe, kb] = await withCap(Promise.all([
    ws.moegirl !== false ? moegirlLookup(q).catch(() => '') : '',
    // 维基百科 / Wikidata：官方 JSON API，0 元 0 Key，走代理（主人 2026-11-07 要求加代理）。
    // 结果优先级放在萌娘之后：二次元问题萌娘更准，通用知识维基覆盖更广。
    ws.wikipedia !== false ? knowledge.lookup(q, { proxyCfg: ws.proxy }).catch(() => '') : '',
  ]), 3500, ['', '']);
  if (moe) {
    rememberOfficial(q, moe, '萌娘百科官方 API');
    cache.set(q, { t: Date.now(), text: moe });
    return moe;
  }
  const v = await vp;                                 // 垂直源：报错/论文/书/HN，精确度高于通用网页
  if (v) { cache.set(q, { t: Date.now(), text: v }); return v; }
  if (kb) {
    rememberOfficial(q, kb, kb.includes('Wikidata') ? 'Wikidata 官方 API' : '维基百科官方 API');
    cache.set(q, { t: Date.now(), text: kb });
    return kb;
  }
  // 通用网页搜索（0 元官方 API，2026-11-22 加）：官方三源没命中时兜底；面板开关 webSources 关掉就不跑
  {
    let _mode = {};
    try { _mode = (configStore.cfgLive().intent || {}).mode || {}; } catch (e) { _mode = {}; }
    if (_mode.webSources !== false) {
      const g = await gp;
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
const BING_NOTE = '（联网兜底搜到的，来源杂、可能不准，判断不了就讲已知、给方向）\n\n';   // 两处兜底结果共用同一段说明，别各写一遍
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
        const text = BING_NOTE + fmtHits(retry, ws.count || 5);
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
  const text = BING_NOTE + fmtHits(alt, ws.count || 5);
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

module.exports = { search, prewarm, sniffLink, linkBlock, listProviders, _providers: PROVIDERS, _anysearch: anysearchSearch,
  _relevant: relevant, _bingQuery: bingQuery, _looseQuery: looseQuery, _moegirl: moegirlLookup, _moeTitles: moeTitles };
