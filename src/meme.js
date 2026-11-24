/*
 * meme.js — 查梗 / 娱乐网站核心模块（bot 侧玩梗 和 客户端查梗页 共用）
 *
 * 站点目录：单一数据源在 xuhbot/src/data/meme-sites.json（权威）。
 *   search（Python 面板）那份是它的同步副本，由「同步梗站清单.command」生成；
 *   改站点只改权威那份、再跑同步脚本。两个 app 各自打包时各带自己的副本。
 *
 * 现实（2026-11-09 实测）：有两个站提供官方 JSON 接口，都填在目录的 api 字段里：
 *   萌娘百科 api.php（MediaWiki，偏 ACG/游戏，间歇可达）
 *   墨鱼词典 /wp-json/wp/v2/posts（WordPress REST，普通网络梗，稳定）
 *   cnmeme.wiki 全 404；梗百科搜索靠前端渲染；梗图网 / 鲸吼被 Cloudflare 挡
 *   → 这 4 站没有官方查询接口，仍只走「目录点开查」，不硬做成源出空卡。
 *
 * “虚幻侧会用网站玩梗”的落地：lookup 遍历所有带 api 的站，按接口格式分派解析，
 *   谁先查到用谁；查不到时 core.js 走 memeQuery()——一个“偏向活站域名”的
 *   通用联网搜索查询，让结果优先来自这些梗站。目录则始终兜底“能连上并查到”。
 */

const fs = require('fs');
const path = require('path');

const SITES_PATH = path.join(__dirname, 'data', 'meme-sites.json');
// 同机开发版 search 面板的副本；单独打包发布时这个目录不存在，跳过同步即可
const SEARCH_COPY = path.resolve(__dirname, '../../search/server/meme_sites.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TIMEOUT_MS = 6000;

/** 读站点目录（每次都从磁盘读，最新）。读坏返回空数组，不抛。 */
function loadSites() {
  try {
    const arr = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 站点目录里所有「填了官方 JSON 接口」的站（按目录顺序）。 */
function apiSites() {
  return loadSites().filter(s => s && typeof s.api === 'string' && s.api.trim());
}

/** 去掉词条摘要里的 HTML 标签和常见实体，只留正文。 */
function stripTags(raw) {
  return String(raw || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

/** WordPress REST：返回数组，每条有 title / link / excerpt。
 *  search 是全文模糊匹配，只认标题包含查询词的结果，避免「查破防 → 返回雀润」。 */
function parseWordPress(site, data, term) {
  if (!Array.isArray(data)) return null;
  for (const post of data) {
    if (!post || typeof post !== 'object') continue;
    const title = stripTags(post.title && post.title.rendered);
    const excerpt = stripTags(post.excerpt && post.excerpt.rendered);
    if (!title || !excerpt || !title.includes(term)) continue;
    let summary = excerpt;
    if (summary.length > 480) summary = summary.slice(0, 480).trim() + '…';
    return { source: site.name || '梗站', title, url: post.link || '', summary };
  }
  return null;
}

/** MediaWiki：返回 query.pages，每条有 title / extract。 */
function parseMediaWiki(site, data, term) {
  const pages = (data && data.query && data.query.pages) || {};
  for (const p of Object.values(pages)) {
    if (!p || typeof p !== 'object') continue;
    const extract = String(p.extract || '').trim();
    if (!extract) continue;
    const title = p.title || term;
    let summary = extract.replace(/\s+/g, ' ').trim();
    if (summary.length > 480) summary = summary.slice(0, 480).trim() + '…';
    const base = (site.url || '').replace(/\/$/, '');
    return {
      source: site.name || '梗站',
      title,
      url: base ? base + '/' + encodeURIComponent(title.replace(/ /g, '_')) : '',
      summary,
    };
  }
  return null;
}

/**
 * 查一个梗：按顺序遍历所有带 api 的站，按接口地址特征分派解析器，谁先查到用谁。
 * 查到返回 { source, title, url, summary }；全都没查到 / 挂了 / 超时 → null（交给上层兜底）。
 */
async function lookup(termRaw) {
  const term = String(termRaw || '').trim();
  if (!term) return null;
  const sites = apiSites();
  if (!sites.length) return null;
  for (const site of sites) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(site.api.replace('{q}', encodeURIComponent(term)), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const hit = /wp-json|\/posts/.test(site.api)
        ? parseWordPress(site, data, term)
        : parseMediaWiki(site, data, term);
      if (hit) return hit;
    } catch {
      // 某个站挂了 / 超时 → 试下一个，都不行就返回 null
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 内联没查到时，给调用方一个「去哪个站搜」的链接：
 * 优先已验证且带 search 字段的站，其次任意带 search 的站。
 */
function searchUrl(term) {
  const t = String(term || '').trim();
  if (!t) return null;
  const sites = loadSites();
  const pick = sites.find(s => s && s.reliability === 'alive' && s.search)
    || sites.find(s => s && s.search);
  if (!pick || !pick.search) return null;
  return pick.search.replace('{q}', encodeURIComponent(t));
}

/**
 * 玩梗兜底查询：自然语言问法为主，括号里带「已验证活站」的域名，
 * 给搜索引擎一个“更想要这些梗站结果”的软偏好（不会因站点无结果而清零）。
 * 这样“用网站玩梗”真正落到这些活站，而不是裸搜。
 */
function memeQuery(termRaw) {
  const term = String(termRaw || '').trim();
  if (!term) return term;
  const alive = loadSites().filter(s => s.reliability === 'alive' && s.domain).slice(0, 3);
  const hint = alive.map(s => s.domain).join(' / ');
  return hint ? `${term} 是什么梗 出处 含义（${hint}）` : `${term} 是什么梗 出处 含义`;
}

/**
 * 覆盖保存站点目录（客户端「查梗」页增删用）。不是数组 / 写坏 → 返回 {error}。
 * 保存后自动同步到同机开发版 search 面板的副本：
 *   - 副本目录存在 → 一起写，两个 app 立刻一致（不用再双击同步脚本）
 *   - 副本目录不存在（各自单独打包发布）→ 跳过，不影响本次保存
 * 各 app 打包时仍各带自己那份副本，这里只是开发期的自动同步。
 */
function saveSites(sites) {
  if (!Array.isArray(sites)) return { error: '站点目录必须是数组' };
  const text = JSON.stringify(sites, null, 2) + '\n';
  try {
    fs.mkdirSync(path.dirname(SITES_PATH), { recursive: true });
    fs.writeFileSync(SITES_PATH, text, 'utf8');
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
  let synced = false;
  try {
    if (fs.existsSync(SEARCH_COPY)) {
      fs.writeFileSync(SEARCH_COPY, text, 'utf8');
      synced = true;
    }
  } catch { /* 副本写不进不影响权威源已保存 */ }
  return { ok: true, synced };
}

module.exports = { lookup, sites: loadSites, searchUrl, memeQuery, saveSites, loadSites };
