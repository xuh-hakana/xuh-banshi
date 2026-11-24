'use strict';
/*
 * knowledge.js —— 免费官方知识检索（维基百科 / Wikidata）
 *
 * 为什么单开一份：
 *   项目原来只有萌娘百科（管二次元）、PokeAPI（管宝可梦）和 Bing 抓页。
 *   虚幻要回答真实世界的知识，就需要一个覆盖面广、免 Key、免钱的知识源。
 *   维基百科与 Wikidata 都提供官方 JSON API，正是主人说的「官方网站 api」。
 *
 * 红线（主人 2026-11-07 澄清）：不许绕过官方网站 API 去爬网页。代理不是红线。
 *   所以本文件只调 api.php 的 JSON 接口，域名白名单写死，不解析 HTML、不带浏览器 UA 伪装。
 *
 * 网络：这台机器直连 zh.wikipedia.org 10 秒超时，需走代理。代理由 net.js 挑。
 *   没代理时返回空，让调用方走别的路，不拖死一条回复。
 *
 * 查询策略（2026-11-07 调过两轮）：
 *   先按标题精确查（titles=…），命中就用 —— 这样「光合作用」「北京」不会跑偏。
 *   标题没有才退回全文搜索（generator=search）。早先只用搜索时，搜「光合作用」会拿到【植物】。
 *
 * 限流（2026-11-07 实测踩到）：
 *   Wikimedia 对这个出口 IP 限制很紧，连发几次就 429。
 *   所以：两次请求至少隔 2.5 秒；一旦 429/403 就冷却 5 分钟不再打扰，直接返回空。
 *   等待发生在后台，不阻塞主回复 —— 调用方有超时兜底。
 */
const net = require('./net');

const ALLOW = new Set(['zh.wikipedia.org', 'www.wikidata.org']);
const UA = 'xuhuan-bot/1.0 (personal qq companion bot)';
const CACHE_MS = 30 * 60 * 1000;
const MIN_GAP = 2500;          // 两次维基请求的最小间隔
const COOL_MS = 5 * 60 * 1000; // 被限流后冷却多久

const cache = new Map();       // q -> { t, text }
let _lastAt = 0;
let _coolUntil = 0;

// 疑问词尾巴：搜索时要剥掉，否则整句丢给接口命中率低
const TAIL = /(是什么|是啥|是谁|什么意思|怎么回事|为什么|怎么办|怎么样|怎么读|怎么念|介绍|百科|资料|出处|来历|背景|的定义|的意思|吗|呢|吧|啊|呀|请问|帮我|查一下|搜一下|告诉我)/g;

function tidy(q) {
  let s = String(q || '').replace(/[。！？!?，,、\s]+$/g, '');
  s = s.replace(TAIL, '').replace(/[。！？!?，,、\s]+$/g, '');
  return s.trim().slice(0, 40);
}

function guard(url) {
  const u = new URL(url);
  if (!ALLOW.has(u.hostname)) throw new Error('knowledge 只许调白名单官方 API：' + u.hostname);
  return url;
}

async function throttle() {
  const now = Date.now();
  if (now < _coolUntil) throw new Error('维基刚限流，冷却中（还剩 ' + Math.ceil((_coolUntil - now) / 1000) + ' 秒）');
  const wait = _lastAt + MIN_GAP - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastAt = Date.now();
}

function isRateLimited(e) {
  return /HTTP (429|403)\b/.test(String((e && e.message) || ''));
}

async function api(params, proxy, timeout) {
  await throttle();
  const url = guard('https://zh.wikipedia.org/w/api.php?format=json&formatversion=2&' + params);
  try {
    return await net.getJson(url, { proxy, timeout: timeout || 9000, ua: UA });
  } catch (e) {
    if (isRateLimited(e)) {
      _coolUntil = Date.now() + COOL_MS;
      console.log('[kb] 维基限流，冷却 5 分钟：' + e.message.slice(0, 60));
    }
    throw e;
  }
}

const plain = s => String(s || '').replace(/\s+/g, '').toLowerCase();
const disambig = t => /可以指|可能是指|可以係|可以指代|维基百科有.*条目|是一個.*消歧義/.test(t);

function pickExtract(pages, q) {
  const list = (pages || []).filter(p => p && p.extract && p.extract.trim().length >= 30);
  if (!list.length) return null;
  let pick = list[0];
  if (disambig(pick.extract)) pick = list.find(p => !disambig(p.extract)) || null;
  if (!pick) return null;
  // 相关性校验：查询词得在标题或正文开头出现，否则宁可不答，也不拿别的条目凑
  const key = plain(q);
  const inTitle = plain(pick.title).includes(key) || key.includes(plain(pick.title));
  const inBody = plain(pick.extract).slice(0, 200).includes(key);
  if (!inTitle && !inBody) return null;
  return pick;
}

function fmt(pick) {
  const body = pick.extract.replace(/\s+/g, ' ').trim().slice(0, 600);
  return '【' + pick.title + '】' + body + '\n来源：维基百科中文版官方 API（zh.wikipedia.org）';
}

/* 第一步：按标题精确查。命中率高，且不会跑偏到别的条目。 */
async function byTitle(q, proxy) {
  const j = await api('action=query&redirects=1&titles=' + encodeURIComponent(q)
    + '&prop=extracts&exintro=1&explaintext=1', proxy, 9000);
  const pages = (j && j.query && j.query.pages) || [];
  const pick = pickExtract(pages, q);
  return pick ? fmt(pick) : '';
}

/* 第二步：标题没有，才退回全文搜索。 */
async function bySearch(q, proxy) {
  const j = await api('action=query&redirects=1&generator=search&gsrsearch=' + encodeURIComponent(q)
    + '&gsrlimit=3&gsrnamespace=0&prop=extracts&exintro=1&explaintext=1', proxy, 9000);
  const pick = pickExtract((j && j.query && j.query.pages) || [], q);
  return pick ? fmt(pick) : '';
}

async function wikidata(q, proxy) {
  await throttle();
  const url = guard('https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json'
    + '&language=zh&uselang=zh&limit=3&search=' + encodeURIComponent(q));
  const j = await net.getJson(url, { proxy, timeout: 8000, ua: UA });
  const list = (j && j.search) || [];
  const good = list.filter(x => x && (x.label || x.description) && (x.description || '').trim());
  if (!good.length) return '';
  const key = plain(q);
  const hit = good.find(x => plain(x.label) === key || plain(x.label).includes(key) || key.includes(plain(x.label)));
  if (!hit) return '';
  const lines = good.slice(0, 3).map(x => '- ' + (x.label || x.id) + (x.description ? '：' + x.description : ''));
  return '【实体】\n' + lines.join('\n') + '\n来源：Wikidata 官方 API（wikidata.org）';
}

/* 主入口：返回可直接塞进提示词的文本；没查到返回 ''（不编）。 */
async function lookup(query, opt) {
  const o = opt || {};
  const q = tidy(query);
  if (!q || q.length < 2) return '';
  const hit = cache.get(q);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.text;
  if (Date.now() < _coolUntil) return '';

  const proxy = o.proxy !== undefined ? o.proxy : await net.resolveProxy(o.proxyCfg);

  let text = '';
  try {
    text = await byTitle(q, proxy);
    if (!text) text = await bySearch(q, proxy);
  } catch (e) {
    console.log('[kb] 维基百科没查到「' + q + '」：' + e.message.slice(0, 70));
  }
  if (!text) {
    try { text = await wikidata(q, proxy); } catch (e) { console.log('[kb] Wikidata 没查到「' + q + '」：' + e.message.slice(0, 70)); }
  }
  if (!text) return '';
  cache.set(q, { t: Date.now(), text });
  console.log('[kb] 查到「' + q + '」（' + text.length + ' 字，来源：' + (text.includes('Wikidata') ? 'Wikidata' : '维基百科') + '）');
  return text;
}

/* 给自检/面板看当前状态：冷却到什么时候、用的哪个代理 */
function status() {
  return {
    cooling: Date.now() < _coolUntil,
    coolLeftSec: Math.max(0, Math.ceil((_coolUntil - Date.now()) / 1000)),
    proxy: net.current(),
    cached: cache.size,
  };
}

module.exports = { lookup, byTitle, bySearch, wikidata, tidy, status, ALLOW };
