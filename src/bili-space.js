/* ===========================================================================
 * bili-space.js — B站「虚幻自己的主页」+ 评论楼中楼 + 私信（2026-11-17 主人令）
 *
 * 这是干什么的：客户端「B站」页要按真实时间排她的动态和视频、点开展开评论区（楼层像B站）、
 *   私信并到 QQ。这里只负责**读**B站接口，不写一条数据、不发任何东西。
 *
 * 登录态从哪来（2026-11-17 实测，别再问她）：
 *   AstrBot 的 B站插件配置里有成套的登录态，字段 SESSDATA / BILI_JCT / DEDE_USER_ID，
 *   拼起来就是能用的 cookie（实测 nav 返回 isLogin=true）。路径见 CONF_ASTRBOT。
 *   旧快照 ../app/bili-config.json 早就过期（nav=-101），只当兜底，不当正源。
 *
 * 为什么必须 wbi 签名（T0 实测）：
 *   空间接口不带签名 → HTTP 412；签名算错 → code -352。签名 = nav 给的 img_url/sub_url
 *   按 mixinKeyEncTab 打乱后取前 32 位当密钥，再 md5(排序后的 query + 密钥)。
 *   另外要 buvid3/buvid4（x/frontend/finger/spi）+ Referer 带 mid + timezone_offset。
 *
 * 限频（T0 实测）：连着打几次就 -412。所以**拉一次就落缓存**，客户端只读缓存，
 *   手动「刷新」才真拉，并且 10 分钟内不重复拉；失败时返回上次缓存 + 实话（风控/登录失效）。
 *
 * 缓存：data/bili-space-cache.json（{mid, at, me, items}），跟着 data 备份走。
 * =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE = path.join(DATA_DIR, 'bili-space-cache.json');
const RISK = path.join(DATA_DIR, 'bili-risk.json');   // 被 -412 封到什么时候（IP 级，实测几分钟到半小时）
const CONF_ASTRBOT = path.join(os.homedir(), '.astrbot', 'data', 'config', 'astrbot_plugin_bilibili_ai_bot_config.json');
const CONF_LEGACY = path.resolve(__dirname, '..', '..', 'app', 'bili-config.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const MIN_GAP_MS = 10 * 60 * 1000;          // 10 分钟内不重复冲接口（风控实测）

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* B站 的时间戳三种都有（秒 / 毫秒 / 微秒），统一成毫秒 */
function tsMs(v) {
  const n = Number(v) || 0;
  if (!n) return 0;
  if (n > 1e15) return Math.round(n / 1000);       // 微秒
  if (n > 1e11) return n;                          // 毫秒
  return n * 1000;                                 // 秒
}

/* 私信内容可能是纯文本，也可能是一包 JSON（周报/通知/分享卡） */
function msgText(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  if (s[0] !== '{' && s[0] !== '[') return s.replace(/\\n/g, '\n');
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      const t = j.title || j.text || j.content || j.desc || j.face_text || '';
      const sub = j.text && j.title ? ('：' + String(j.text).slice(0, 60)) : '';
      return String(t + sub).replace(/\\n/g, '\n').slice(0, 200);
    }
  } catch {}
  return s.slice(0, 120);
}

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

/* ---------- 登录态 ---------- */
function creds() {
  // ① AstrBot 插件（正源）。文件带 BOM，先剥掉再 parse。
  try {
    const j = JSON.parse(fs.readFileSync(CONF_ASTRBOT, 'utf8').replace(/^\uFEFF/, ''));
    const s = String(j.SESSDATA || ''), c = String(j.BILI_JCT || ''), u = String(j.DEDE_USER_ID || '');
    if (/^[0-9a-zA-Z%*,_-]{10,}$/.test(s) && /^\d{4,20}$/.test(u)) {
      // buvid3/buvid4 用插件里那套（= 登录这台设备的指纹）。以前每次现拉 spi 生成一个新的，
      // 和登录态对不上，空间接口容易 -412；插件有就直接带上（2026-11-19 修动态拉不到）。
      const b3 = String(j.BUVID3 || ''), b4 = String(j.BUVID4 || '');
      const bv = b3 ? ('buvid3=' + b3 + '; ' + (b4 ? 'buvid4=' + b4 + '; ' : '')) : '';
      return {
        cookie: 'SESSDATA=' + s + '; bili_jct=' + c + '; DedeUserID=' + u + ';',
        mid: u, from: 'astrbot', buvid: bv, csrf: c,
      };
    }
  } catch {}
  // ② 旧快照（只兜底）
  try {
    const j = JSON.parse(fs.readFileSync(CONF_LEGACY, 'utf8'));
    const ck = String(j.cookie || '');
    const m = /DedeUserID=(\d+)/.exec(ck);
    const jc = /bili_jct=([0-9a-f]{32})/i.exec(ck);
    if (/SESSDATA=[^;\s]{6,}/i.test(ck)) return { cookie: ck, mid: m ? m[1] : '', from: 'app', csrf: jc ? jc[1] : '' };
  } catch {}
  return { cookie: '', mid: '', from: '', csrf: '' };
}

/* ---------- buvid（防风控要用；缓存 1 小时）---------- */
let _buvid = { at: 0, v: '' };
async function buvidValue() {
  if (_buvid.v && Date.now() - _buvid.at < 3600 * 1000) return _buvid.v;
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const b3 = (j && j.data && j.data.b_3) || '';
    if (b3) _buvid = { at: Date.now(), v: 'buvid3=' + b3 + '; buvid4=' + ((j.data && j.data.b_4) || '') + '; ' };
  } catch {}
  return _buvid.v;
}

/* ---------- wbi 密钥（缓存 20 分钟）---------- */
let _wbi = { at: 0, img: '', sub: '' };
async function wbiKeys() {
  if (_wbi.img && _wbi.sub && Date.now() - _wbi.at < 20 * 60 * 1000) return _wbi;
  const c = creds();
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, ...(c.cookie ? { Cookie: c.cookie } : {}) },
  });
  const j = await r.json();
  const w = j && j.data && j.data.wbi_img;
  if (!w || !w.img_url || !w.sub_url) throw httpErr(412, '拿不到 wbi 签名密钥（nav 没给 img_url/sub_url）');
  const pick = n => n.slice(n.lastIndexOf('/') + 1, n.lastIndexOf('.'));
  _wbi = { at: Date.now(), img: pick(w.img_url), sub: pick(w.sub_url) };
  return _wbi;
}

function signedQuery(params, keys) {
  const raw = keys.img + keys.sub;
  const mix = mixinKeyEncTab.map(i => raw[i]).join('').slice(0, 32);
  const q = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const qs = Object.keys(q).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]).replace(/[!'()*]/g, '')))
    .join('&');
  return qs + '&w_rid=' + crypto.createHash('md5').update(qs + mix).digest('hex');
}

/* -412 是接口级临时封（实测「request was banned」，几分钟到半小时）。封着的时候别再打。
 * 2026-11-19 分级：动态接口（/feed/space）比视频接口敏感得多，它被封不该连累整个 B站页
 * —— 所以冷却记 scope：'dynamic' 只挡动态，'all' 挡全部。 */
function readRisk(scope) {
  const j = readJson(RISK, null);
  const t = Number((j && j.until) || 0);
  if (t <= Date.now()) return 0;
  const s = String((j && j.scope) || 'all');
  if (s === 'all' || s === String(scope || '')) return t;
  return 0;
}
function markRisk(ms, scope) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RISK, JSON.stringify({
      until: Date.now() + (ms || 10 * 60 * 1000), at: new Date().toISOString(), scope: scope || 'all',
    }, null, 1));
  } catch {}
}
function riskMsg(until) {
  const d = new Date(until);
  const p2 = n => String(n).padStart(2, '0');
  return 'B站风控封着（-412 request was banned），解封时间约 ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + '，这之前刷新只会更久';
}

function httpErr(code, msg) {
  const e = new Error(msg || ('HTTP ' + code));
  e.code = code;
  e.risk = (code === 412 || code === -412 || code === -352);
  return e;
}

/* 一个 GET。412 / -412 / -352 判成风控，重试一次；仍失败就抛出（上层给缓存 + 实话）。 */
async function api(url, params, opts) {
  const o = opts || {};
  const scope = /\/feed\/space/.test(url) ? 'dynamic' : '';
  const banned = readRisk(scope);
  if (banned) throw httpErr(412, riskMsg(banned));
  const c = creds();
  const bv = c.buvid || await buvidValue();   // 插件里有真 buvid3/4 就用它，别现造一个新的
  const qs = o.signed ? signedQuery(params || {}, await wbiKeys()) : Object.keys(params || {})
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
  const full = url + (qs ? (url.indexOf('?') >= 0 ? '&' : '?') + qs : '');
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': o.referer || 'https://www.bilibili.com/',
    ...(c.cookie || bv ? { Cookie: c.cookie + bv } : {}),
  };
  for (let i = 0; i < 2; i++) {
    let res, txt;
    try {
      res = await fetch(full, { headers });
      txt = await res.text();
    } catch (e) {
      if (i) throw httpErr(0, '连不上 B站：' + e.message);
      await sleep(1200);
      continue;
    }
    if (res.status === 412) {
      if (i) { markRisk(undefined, scope); throw httpErr(412, 'B站风控拦截（HTTP 412）：这阵子请求太密，先记 10 分钟冷却'); }
      await sleep(1500);
      continue;
    }
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!j) {
      if (i) throw httpErr(res.status, 'B站返回的不是 JSON（多半也是风控）：HTTP ' + res.status);
      await sleep(1200);
      continue;
    }
    if (j.code === -412 || j.code === -352) {
      if (i) { markRisk(undefined, scope); throw httpErr(j.code, 'B站风控拦截（' + j.code + ' request was banned）：先记 10 分钟冷却'); }
      await sleep(1500);
      continue;
    }
    if (j.code !== 0) {
      const msg = j.message || j.msg || ('code ' + j.code);
      if (j.code === -101) throw httpErr(-101, 'B站登录态失效：' + msg);
      throw httpErr(j.code, 'B站接口返回 ' + j.code + '：' + msg);
    }
    return j.data;
  }
  throw httpErr(0, '取不到数据');
}

/* ---------- 账号 ---------- */
async function me() {
  const c = creds();
  if (!c.cookie) throw httpErr(-101, '没有 B站登录态（AstrBot 插件的 SESSDATA 读不到）');
  const d = await api('https://api.bilibili.com/x/web-interface/nav', {});
  const dd = d || {};
  if (!dd.isLogin) throw httpErr(-101, 'B站登录态失效（' + (c.from || '未知来源') + ' 那份 cookie 不被认可）');
  return { mid: String(dd.mid || c.mid || ''), uname: dd.uname || '', face: dd.face || '', level: dd.level_info && dd.level_info.current };
}

const _profCache = new Map();   // mid -> {at, v}：私信列表要挨个查昵称头像，别每次真打
async function profile(mid) {
  const k = String(mid || '');
  const hit = _profCache.get(k);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.v;
  const d = await api('https://api.bilibili.com/x/web-interface/card', { mid });
  const card = (d && d.card) || {};
  const v = { mid: String(card.mid || mid || ''), name: card.name || '', face: card.face || '', fans: card.fans, sign: card.sign || '' };
  _profCache.set(k, { at: Date.now(), v });
  return v;
}

/* ---------- 视频 ---------- */
const fmtDur = s => {
  const n = Number(s) || 0;
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), ss = n % 60;
  const p = x => String(x).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
};

function normVideo(v) {
  return {
    kind: 'video', id: String(v.bvid || ''), t: Number(v.created || 0) * 1000,
    aid: Number(v.aid || 0), title: String(v.title || ''), cover: String(v.pic || '').replace(/^http:/, 'https:'),
    play: Number(v.play || 0), danmaku: Number(v.video_review || 0),
    // 评论数取 comment（真实评论条数）；video_review 是弹幕数，别拿它冒充评论
    cmt: Number(v.comment || 0),
    dur: fmtDur(v.length), desc: String(v.description || '').slice(0, 200),
    link: 'https://www.bilibili.com/video/' + v.bvid,
  };
}

async function videos(mid, pages) {
  const out = [];
  const max = Math.max(1, Number(pages) || 2);
  for (let pn = 1; pn <= max; pn++) {
    const d = await api('https://api.bilibili.com/x/space/wbi/arc/search', {
      mid, ps: 30, pn, order: 'pubdate', platform: 'web', web_location: 1550101,
    }, { signed: true, referer: 'https://space.bilibili.com/' + mid + '/video' });
    const list = (d && d.list && d.list.vlist) || [];
    list.forEach(v => out.push(normVideo(v)));
    const total = (d && d.page && d.page.count) || 0;
    if (out.length >= total || !list.length) break;
    await sleep(900);
  }
  return out;
}

/* ---------- 动态 ---------- */
function pickImgs(md) {
  const out = [];
  const draw = md && md.major && md.major.draw;
  if (draw && Array.isArray(draw.items)) draw.items.forEach(it => { if (it && it.src) out.push(String(it.src).replace(/^http:/, 'https:')); });
  const opus = md && md.major && md.major.opus;
  if (opus && Array.isArray(opus.pics)) opus.pics.forEach(p => { if (p && p.url) out.push(String(p.url).replace(/^http:/, 'https:')); });
  return out.slice(0, 9);
}

function normDynamic(x) {
  const md = (x.modules && x.modules.module_dynamic) || {};
  const au = (x.modules && x.modules.module_author) || {};
  const b = x.basic || {};
  const origText = (md.orig && md.orig.modules && md.orig.modules.module_dynamic && md.orig.modules.module_dynamic.desc && md.orig.modules.module_dynamic.desc.text) || '';
  const origName = (md.orig && md.orig.modules && md.orig.modules.module_author && md.orig.modules.module_author.name) || '';
  // 新版图文（DYNAMIC_TYPE_DRAW / opus）正文不在 desc.text，而在 major.opus.summary.text，
  // 只读 desc 会得到空文本 —— 2026-11-19 实测该号最新一条就是这种（stat.comment=4、desc 空）。
  const opus = (md.major && md.major.opus) || null;
  const text = String((md.desc && md.desc.text) || (opus && opus.summary && opus.summary.text) || '');
  return {
    kind: 'dynamic', id: String(b.rid_str || x.id_str || ''), t: Number(au.pub_ts || 0) * 1000,
    type: String(x.type || ''), text,
    imgs: pickImgs(md),
    origText: String(origText).slice(0, 300), origName: String(origName),
    oid: String(b.comment_id_str || b.comment_id || ''),
    commentId: String(b.comment_id_str || ''),
    repost: Number((x.modules && x.modules.module_stat && x.modules.module_stat.forward && x.modules.module_stat.forward.count) || 0),
    like: Number((x.modules && x.modules.module_stat && x.modules.module_stat.like && x.modules.module_stat.like.count) || 0),
    cmt: Number((x.modules && x.modules.module_stat && x.modules.module_stat.comment && x.modules.module_stat.comment.count) || 0),
    link: 'https://t.bilibili.com/' + String(b.rid_str || x.id_str || ''),
  };
}

async function dynamics(mid, pages) {
  const out = [];
  const max = Math.max(1, Number(pages) || 2);
  let offset = '';
  for (let i = 0; i < max; i++) {
    // 2026-11-19 修：原来只带 host_mid/timezone_offset/features=itemOpusStyle，B站对动态接口
    //   直接回 412「request was banned」（11-17 起图文一条都拉不到，缓存里那句「动态没拿到：412」就是它）。
    //   照 web 端补齐 platform / web_location / 完整 features，实测 code=0（DYNAMIC_TYPE_DRAW 也能拿到）。
    const params = {
      host_mid: mid, offset: offset || '', timezone_offset: -480, platform: 'web', web_location: '333.1387',
      features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote',
    };
    const d = await api('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space', params,
      { signed: true, referer: 'https://space.bilibili.com/' + mid + '/dynamic' });
    const items = (d && d.items) || [];
    items.forEach(x => out.push(normDynamic(x)));
    if (!(d && d.has_more) || !d.offset) break;
    offset = d.offset;
    await sleep(1200);
  }
  return out;
}

/* ---------- 评论（楼中楼）---------- */
function normReply(r) {
  const m = r.member || {};
  let text = String((r.content && r.content.message) || '');
  // 楼中楼里 B站 会把「回复 @昵称：」写在正文开头；拆出来单独上色，楼层才像B站
  const at = /^回复\s*@([^：:]{1,24})\s*[：:]\s*/.exec(text);
  const atName = at ? at[1] : '';
  if (at) text = text.slice(at[0].length);
  return Object.assign({
    rpid: String(r.rpid || ''), t: Number(r.ctime || 0) * 1000,
    nick: String(m.uname || ''), face: String(m.avatar || '').replace(/^http:/, 'https:'),
    text, atName,
    like: Number(r.like || 0), rcount: Number(r.rcount || 0), floor: Number(r.floor || 0),
    replies: [],
  });
}

/* otype: 1=视频(oid=aid) 11=动态(oid=动态id)。返回主楼；楼中楼按需再拉（lazy）。 */
async function comments(otype, oid, pn) {
  const d = await api('https://api.bilibili.com/x/v2/reply', {
    type: Number(otype) || 1, oid: String(oid), pn: Number(pn) || 1, ps: 14, sort: 2, nohot: 1,
  }, { referer: 'https://www.bilibili.com/' });
  const top = ((d && d.top && d.top.upper) ? [d.top.upper] : []).concat((d && d.replies) || []);
  return {
    page: (d && d.page) || {},
    list: top.map(normReply).filter(x => x.rpid),
  };
}

async function replies(otype, oid, root, pn) {
  const d = await api('https://api.bilibili.com/x/v2/reply/reply', {
    type: Number(otype) || 1, oid: String(oid), root: String(root), pn: Number(pn) || 1, ps: 20,
  }, { referer: 'https://www.bilibili.com/' });
  return ((d && d.replies) || []).map(normReply).filter(x => x.rpid);
}

/* ---------- 私信 ---------- */
async function dmSessions() {
  const d = await api('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions', {
    session_type: 1, group_id: 0,
  }, { referer: 'https://message.bilibili.com/' });
  const list = (d && d.session_list) || [];
  return list.map(s => {
    const type = Number((s.last_msg && s.last_msg.msg_type) || 0);
    /* msg_type 5 = 撤回提醒，content 里是那条消息的 msg_key（一串 16~20 位数字）。
     * 以前直接当预览显示，左栏就一直是「虚虚虚虚…」或一串数字（2026-11-19 修）。 */
    const preview = type === 5 ? '撤回了一条消息' : msgText(s.last_msg && s.last_msg.content).slice(0, 100);
    return {
      uid: String(s.talker_id || ''), at: tsMs(s.session_ts),
      unread: Number(s.unread_count || 0),
      preview, type,
      senderUid: String((s.last_msg && s.last_msg.sender_uid) || ''),
    };
  }).filter(x => x.uid);
}

async function dmMessages(talker, size) {
  const d = await api('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs', {
    talker_id: String(talker), session_type: 1, size: Math.min(200, Number(size) || 50),
  }, { referer: 'https://message.bilibili.com/' });
  // 「哪条是我发的」按**登录号**判：私信会话属于登录的这个号（实测 电子幽灵），不是主页那个号
  const myMid = String(creds().mid || '');
  let msgs = (d && d.messages) || [];
  msgs = msgs.slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
  return msgs.map(m => ({
    t: tsMs(m.timestamp), mine: String(m.sender_uid) === myMid,
    type: Number(m.msg_type || 0), text: msgText(m.content),
  }));
}

/* ---------- 主页（时间线 = 动态 + 视频按真实时间混排）----------
 * 缓存按 mid 分开存：她有两个号（虚幻的生物 30895294 / 虚幻世界的电子幽灵 3546…9477），
 * 主页默认看粉丝多的那个（真实主页），另一个也能切。别把两个号的时间线混进一条。
 * 结构：{ byMid: { "<mid>": {mid, at, me, prof, items, err} } }
 */
function readAll() { return readJson(CACHE, null) || { byMid: {} }; }
function readCache(mid) {
  const all = readAll();
  return (all.byMid && mid && all.byMid[String(mid)]) || null;
}
function writeCache(o) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const all = readAll();
    all.byMid = all.byMid || {};
    all.byMid[String(o.mid)] = o;
    const tmp = CACHE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1), 'utf8');
    fs.renameSync(tmp, CACHE);
  } catch (e) { console.error('[B站] 缓存写不进去：' + e.message); }
}

/* 主页默认号：粉丝多的那个（2026-11-17 实测 虚幻的生物 1155 粉 / 电子幽灵 2 粉）。
 * 不写死 uid —— 换号后按缓存里的粉丝数自己排；没缓存就用登录号。 */
function defaultMid() {
  const all = readAll();
  const rows = Object.keys(all.byMid || {}).map(k => all.byMid[k]).filter(x => x && x.prof);
  if (rows.length) {
    rows.sort((a, b) => (Number(b.prof.fans) || 0) - (Number(a.prof.fans) || 0));
    return String(rows[0].mid);
  }
  return String(creds().mid || '');
}

function accounts() {
  const all = readAll();
  return Object.keys(all.byMid || {}).map(k => {
    const x = all.byMid[k] || {};
    return { mid: String(k), name: (x.prof && x.prof.name) || (x.me && x.me.uname) || k, face: (x.prof && x.prof.face) || (x.me && x.me.face) || '', fans: (x.prof && x.prof.fans) || 0, at: x.at || 0 };
  }).sort((a, b) => (b.fans || 0) - (a.fans || 0));
}

/* force=false：缓存新鲜（10 分钟内）就直接给。
 * force=true：她点了刷新 —— 仍受 10 分钟节流（B站会 -412），除非 ignoreGap。
 * 拉的时候先视频后动态、中间隔 3 秒（连着打必被 412，实测）。 */
async function home(opts) {
  const o = opts || {};
  const midWant = String(o.mid || defaultMid() || '');
  const cache = midWant ? readCache(midWant) : null;
  const now = Date.now();

  if (!o.force && cache) return Object.assign({ ok: true, cached: true }, cache);
  if (o.force && cache && (now - (cache.at || 0) < MIN_GAP_MS) && !o.ignoreGap) {
    return Object.assign({ ok: true, cached: true, throttled: true, note: '10 分钟内刚拉过，先用上次的（B站会风控拦截）' }, cache);
  }

  try {
    const m = await me();
    const mid = midWant || String(m.mid);
    let vids = null, dyns = null, vErr = '', dErr = '';
    try { vids = await videos(mid, 1); } catch (e) { vErr = e.message; }
    await sleep(8000);   // 实测：视频拉完立刻拉动态必被 412，隔 8 秒才稳
    // 动态只拉 1 页（首屏 10~20 条够了）：B站对动态接口比视频接口严得多，
    // 连着翻页必 -412，翻页等下次刷新（2026-11-19 实测：一次请求就封，10 分钟起）。
    try { dyns = await dynamics(mid, 1); } catch (e) { dErr = e.message; }
    if (vids === null && dyns === null) throw httpErr(412, vErr || dErr || '两个列表都没拿到');
    const prof = await profile(mid).catch(() => null);
    const items = [].concat(dyns || [], vids || []).sort((a, b) => (b.t || 0) - (a.t || 0));
    const out = {
      mid, me: { mid: m.mid, uname: m.uname, face: m.face }, prof, items, at: Date.now(),
      err: [vErr ? '视频没拿到：' + vErr : '', dErr ? '动态没拿到：' + dErr : ''].filter(Boolean).join('；'),
    };
    if (items.length) writeCache(out);
    return Object.assign({ ok: true, cached: false }, out);
  } catch (e) {
    if (cache) return Object.assign({ ok: true, cached: true, stale: true, err: e.message }, cache);
    return { ok: false, error: e.message, risk: !!e.risk, mid: midWant };
  }
}

/* 注册时间（2026-11-21 主人令：t1 按注册时间分新号/老号，不能只看腾讯）。
 * B站两处都带这个字段：card.regtime / space/acc/info.jointime，但**现在都返回 0**
 * （2026-11-21 实测：6 级老号 30895294 两处全 0，腾讯以外压根不公开）。拿不到就返回 0 = 不知道，
 * 调用方按老号处理。留着是因为它随时可能恢复，恢复了自动生效，不用再改代码。 */
const _regCache = new Map();
async function regTime(mid) {
  const k = String(mid || '');
  if (!k) return 0;
  const hit = _regCache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.v;
  let ts = 0;
  try {
    const d = await api('https://api.bilibili.com/x/web-interface/card', { mid: k });
    ts = Number((d && d.card && d.card.regtime) || 0) || 0;
  } catch {}
  if (!ts) {
    try {
      const d = await api('https://api.bilibili.com/x/space/wbi/acc/info', { mid: k }, { signed: true });
      ts = Number((d && d.jointime) || 0) || 0;
    } catch {}
  }
  _regCache.set(k, { v: ts, at: Date.now() });
  return ts;
}

module.exports = {
  CACHE, CONF_ASTRBOT, creds, me, profile, regTime, videos, dynamics, comments, replies,
  dmSessions, dmMessages, home, readCache, accounts, defaultMid,
  _sign: signedQuery, _keys: wbiKeys,
};
