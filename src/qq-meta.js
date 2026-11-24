/*
 * src/qq-meta.js — 群友元数据唯一正本（头像缓存 + 群名表 + 显示名索引）
 *
 * 这是干什么的：把「别人长什么样」「这个群叫什么」「这个名字是哪个号」收在一处，
 *   客户端和机器人共用同一份，不各存一份。
 *
 *   · 头像：按需取一张，缓存到 data/avatars/<键>.jpg；算 md5 记进 index.json，
 *           hash 变了 = 换过头像。不批量下载、不装包、不抓 cookie。
 *           **按「平台 + 账号」分开存**：一个人有两个 QQ 号、还有 B站 号，就有三张头像，
 *           各自记各自的（主人 2026-11-07：「两个号都有头像就分别记，其他平台的头像也都分别记，
 *           但都是同一个人」）。谁是谁的同一个人由 people.json 的 pid 决定，这里只管图。
 *   · 群名：NapCat 上线时调一次 get_group_list 存进 data/group-names.json。
 *
 * 落盘键（2026-11-07 改）：QQ 沿用裸号（19 张老图零迁移），其他平台加平台前缀防撞号 ——
 *   QQ  100000000  →  100000000.jpg
 *   B站 30895294    →  bili-30895294.jpg
 *   以后加小红书 / 抖音 同理，只是多一个前缀，代码不用再分支。
 *
 * 取图来源全部是官方公开地址，不抓网页、不逆向：
 *   QQ  → q1.qlogo.cn / q.qlogo.cn
 *   B站 → api.bilibili.com/x/web-interface/card（官方 JSON，取 card.face 再下那张图）
 *
 * 为什么单独一个文件：主进程（app/main.js 的 xuh://avatar/）、面板（/api/chat 的会话名）、
 *   机器人（qq.js 记群名 / core.js 拿头像描述）都要读它。放在一处才不会各存一份、对不上。
 *
 * 落盘：data/ 目录下，跟着 data 备份一起走；所有写都是「先写 .tmp 再 rename」的原子写。
 * 打码：提示词和界面里不给完整号；号只做文件名和查表键。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'data');
const AVATAR_DIR = path.join(DATA, 'avatars');
const INDEX_FILE = path.join(AVATAR_DIR, 'index.json');
const GROUP_FILE = path.join(DATA, 'group-names.json');
const NAME_FILE = path.join(DATA, 'qq-names.json');       // 显示名 → 账号（运行时自动补）

const AVATAR_TTL = 7 * 24 * 3600 * 1000;       // 7 天后再取一次，平时只读缓存
const CHECK_TTL = 12 * 3600 * 1000;            // 同一个号 12 小时内最多比一次 hash
const AVATAR_MAX = 300;                        // 最多缓存 300 个人，超了删最旧的

/* ---------- 平台 ----------
 * 归一规则和 people.js 的 PLATFORMS 同一口径（'B站'/'bilibili'/'哔哩哔哩' → bili）。
 * 这里不 require people：qq-meta 是更底层的模块，people 会读它写的东西，反过来依赖会绕成环。 */
function normPlat(p) {
  const s = String(p == null ? '' : p).trim().toLowerCase();
  if (!s) return 'qq';                                   // 老调用不带平台 = QQ，行为不变
  if (s === 'b站' || s === 'bilibili' || s === '哔哩哔哩' || s === 'blbl' || s === 'b23') return 'bili';
  return s;
}
/* 账号 id 能不能当账号用。QQ / B站 是纯数字；小红书、抖音这类可能带字母，放宽但仍要像个数。 */
function safeId(id, platform) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return '';
  const p = normPlat(platform);
  if (p === 'qq' || p === 'bili') return /^\d{4,15}$/.test(s) ? s : '';
  return /^[A-Za-z0-9_.\-]{1,64}$/.test(s) ? s : '';
}
// 老名字留着：别处还在按 QQ 号调它
function safeUid(uid) { return safeId(uid, 'qq'); }

/* 头像的落盘键（文件名 = 索引键）。QQ 沿用裸号，其他平台加前缀：两个人不同平台、
 * 号数字碰巧一样时不会互相覆盖头像。 */
function avKey(platform, id) {
  const p = normPlat(platform);
  return p === 'qq' ? String(id) : p + '-' + String(id);
}

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : fallback; }
  catch { return fallback; }
}
function indexAll() { return readJson(INDEX_FILE, {}); }
function indexSave(o) { atomic(INDEX_FILE, JSON.stringify(o, null, 1)); }

/* ---------- 取一张图 ---------- */
function fetchBuf(url, ms, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 2) return reject(new Error('跳太多次'));
    const req = https.get(url, {
      timeout: ms || 4000,
      // B站 的图床要 Referer，不然给 403；QQ 那边多带一个头也不影响
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' },
    }, res => {
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return fetchBuf(res.headers.location, ms, (depth || 0) + 1).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const bufs = [];
      let size = 0;
      res.on('data', b => { size += b.length; if (size <= 300000) bufs.push(b); });
      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        if (buf.length < 100) return reject(new Error('图太小'));
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
/* 取一段 JSON（B站 官方接口）。超过 200KB 直接断，不把无关的大响应读进内存。 */
function fetchJson(url, ms) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: ms || 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json',
      },
    }, res => {
      if (Number(res.statusCode || 0) !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; if (raw.length > 200000) req.destroy(new Error('响应太大')); });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
// QQ 官方公开头像，两个地址互为兜底；都不带登录态，不是网页逆向
const qqAvatarUrls = uid => [
  'https://q1.qlogo.cn/g?b=qq&nk=' + uid + '&s=100',
  'https://q.qlogo.cn/headimg_dl?dst_uin=' + uid + '&spec=100',
];
/* B站 头像：官方 card 接口给出 card.face 的图片地址。拿不到返回空串（客户端退剪影，不编）。 */
async function biliAvatarUrl(mid) {
  try {
    const j = await fetchJson('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(mid), 5000);
    const face = j && j.code === 0 && j.data && j.data.card && j.data.card.face;
    if (!face) return '';
    let u = String(face);
    if (u.indexOf('//') === 0) u = 'https:' + u;
    // B站 图床支持 @100w 这类尺寸后缀，取小图省流量
    return u;
  } catch { return ''; }
}

/* 缓存路径。文件在、且没过期 → 直接给路径，不联网。 */
function avatarCached(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return null;
  const f = path.join(AVATAR_DIR, avKey(p, id) + '.jpg');
  try {
    if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < AVATAR_TTL) return f;
  } catch {}
  return null;
}

/* 取图（会联网）。返回本地路径或 null；顺手记下 hash 有没有变。
 * 客户端 xuh://avatar/ 和机器人检测都走这里，不另写一份下载逻辑。 */
async function avatarFetch(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return null;
  const key = avKey(p, id);
  const cached = avatarCached(id, p);
  const idx = indexAll();
  const rec = idx[key] || {};
  if (cached && rec.checkedAt && Date.now() - Number(rec.checkedAt || 0) < CHECK_TTL) return cached;

  let buf = null;
  if (p === 'bili') {
    const face = await biliAvatarUrl(id);
    if (face) { try { buf = await fetchBuf(face, 5000); } catch {} }
  } else {
    for (const u of qqAvatarUrls(id)) {
      try { buf = await fetchBuf(u, 4000); if (buf) break; } catch {}
    }
  }
  if (!buf) return cached;
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  const changed = !!rec.hash && rec.hash !== hash;
  const file = path.join(AVATAR_DIR, key + '.jpg');
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    atomic(file, buf);                 // 二进制也走同一套原子写
  } catch { return cached; }
  idx[key] = Object.assign({}, rec, {
    hash, checkedAt: Date.now(),
    at: Date.now(),
    plat: p, id,                       // 记清这张图是哪个平台的哪个号（同一人多号时靠它分开）
    changedAt: changed ? Date.now() : (rec.changedAt || 0),
    // 换了图，旧描述立即作废；等下一次视觉描述写回
    desc: changed ? '' : (rec.desc || ''),
  });
  indexSave(idx);
  prune();
  return file;
}

/* ---------- 群头像 ----------
 * 主人 2026-11-07：「接着改QQ页面，现在还没有群头像」。
 * 来源是 QQ 官方群头像地址 p.qlogo.cn/gh/<群号>/<群号>/100 —— 公开地址、不带登录态，
 * 不是抓网页、不是逆向。落盘 data/avatars/group-<群号>.jpg，索引里 plat='group'，
 * 和人物头像用不同的键，群号和 QQ 号碰巧一样也不会互相覆盖。 */
const groupAvatarUrls = gid => [
  'https://p.qlogo.cn/gh/' + gid + '/' + gid + '/100',
  'https://p.qlogo.cn/gh/' + gid + '/' + gid + '/0',
];
function groupKey(gid) {
  const id = String(gid || '').replace(/\D/g, '');
  return /^\d{4,15}$/.test(id) ? 'group-' + id : '';
}
/* 已经下过且在有效期内 → 直接给路径，不联网 */
function groupCached(gid) {
  const key = groupKey(gid);
  if (!key) return null;
  const f = path.join(AVATAR_DIR, key + '.jpg');
  try {
    if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < AVATAR_TTL) return f;
  } catch {}
  return null;
}
/* 取一次群头像（会联网）。拿不到返回 null，客户端退回群字徽标，不编。 */
async function groupFetch(gid) {
  const key = groupKey(gid);
  if (!key) return null;
  const id = key.slice(6);
  const cached = groupCached(id);
  const idx = indexAll();
  const rec = idx[key] || {};
  if (cached && rec.checkedAt && Date.now() - Number(rec.checkedAt || 0) < CHECK_TTL) return cached;
  let buf = null;
  for (const u of groupAvatarUrls(id)) {
    try { buf = await fetchBuf(u, 4000); if (buf) break; } catch {}
  }
  if (!buf) return cached;
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  const file = path.join(AVATAR_DIR, key + '.jpg');
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    atomic(file, buf);
  } catch { return cached; }
  idx[key] = Object.assign({}, rec, { hash, checkedAt: Date.now(), at: Date.now(), plat: 'group', id });
  indexSave(idx);
  prune();
  return file;
}

/* 只留最近 300 张，老的删掉（自己的头像文件不算摆设，但别无限涨） */
function prune() {
  try {
    const idx = indexAll();
    const keys = Object.keys(idx).sort((a, b) => Number(idx[b].at || 0) - Number(idx[a].at || 0));
    for (const k of keys.slice(AVATAR_MAX)) {
      try { fs.unlinkSync(path.join(AVATAR_DIR, k + '.jpg')); } catch {}
      delete idx[k];
    }
    if (keys.length > AVATAR_MAX) indexSave(idx);
  } catch {}
}

/* 机器人侧：这个号刚发过消息 → 比一次 hash，看是不是换了头像。
 * 节流在 avatarFetch 里，不会每条消息都联网；返回 {changed, desc}。 */
async function noteSeen(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return { changed: false, desc: '' };
  const key = avKey(p, id);
  const before = (indexAll()[key] || {}).hash || '';
  const f = await avatarFetch(id, p);
  if (!f) return { changed: false, desc: '' };
  const rec = indexAll()[key] || {};
  const after = rec.hash || '';
  return { changed: !!before && !!after && before !== after, desc: String(rec.desc || ''), hash: after };
}

function descOf(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  return id ? String((indexAll()[avKey(p, id)] || {}).desc || '') : '';
}
/* 视觉描述只在「还没描述过」或「刚换图」时调一次；失败也别每条消息重试，一天最多一次。
 * 再加一道每小时 10 次的闸：群里突然涌进几十个新号时不至于一次烧掉几十次视觉调用。 */
let descBudget = { at: 0, n: 0 };
function needDesc(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return false;
  const rec = indexAll()[avKey(p, id)] || {};
  if (rec.desc) return false;
  if (rec.descAt && Date.now() - Number(rec.descAt) < 24 * 3600 * 1000) return false;
  const now = Date.now();
  if (now - descBudget.at > 3600 * 1000) descBudget = { at: now, n: 0 };
  if (descBudget.n >= 10) return false;
  descBudget.n++;
  return true;
}
function markDescTried(uid, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return;
  const key = avKey(p, id);
  const idx = indexAll();
  idx[key] = Object.assign({}, idx[key] || {}, { descAt: Date.now(), plat: p, id });
  indexSave(idx);
}
function setDesc(uid, text, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  if (!id) return;
  const key = avKey(p, id);
  const idx = indexAll();
  idx[key] = Object.assign({}, idx[key] || {}, {
    desc: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80), plat: p, id,
  });
  indexSave(idx);
}
/* 给 buildMessages 用的一行；没描述就返回空串（不编、不占位） */
function avatarLine(uid, name, platform) {
  const d = descOf(uid, platform);
  if (!d) return '';
  return '- ' + String(name || '这个人') + '的头像：' + d;
}
function changedLine(uid, name, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p);
  const d = descOf(id, p);
  const rec = indexAll()[avKey(p, id)] || {};
  if (!rec.changedAt || Date.now() - Number(rec.changedAt) > 24 * 3600 * 1000) return '';
  return '- ' + String(name || '这个人') + '刚换了头像' + (d ? '，现在是：' + d : '') + '。';
}

/* ---------- 显示名 → 账号 ----------
 * 为什么还要这张表：聊天日志只写显示名，people.json 只给 27% 的行反查得到号，
 * 群友头像就一直显示不出来。机器人收消息那一刻事件里是有号的，顺手记一笔，
 * 聊得越多覆盖越全；历史行按同名匹配也能一起补上，不用回改 8800 行日志。
 * 2026-11-07 起按平台存：{ "名字": {platform:"bili", id:"30895294"} }；
 * 老文件里是 { "名字": "123456" }（纯 QQ 号），读的时候当 qq，不迁文件。 */
function cleanName(s) {
  return String(s || '').replace(/[\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/[\u3000\s]+/g, ' ').trim().slice(0, 40);
}
function noteName(uid, nick, platform) {
  const p = normPlat(platform);
  const id = safeId(uid, p), nm = cleanName(nick);
  if (!id || !nm || /^\[?AI/i.test(nm)) return false;
  const map = readJson(NAME_FILE, {});
  const cur = map[nm];
  const curId = (cur && typeof cur === 'object') ? String(cur.id || '') : String(cur || '');
  const curPlat = (cur && typeof cur === 'object') ? normPlat(cur.platform) : 'qq';
  if (curId === id && curPlat === p) return false;
  map[nm] = { platform: p, id };
  atomic(NAME_FILE, JSON.stringify(map, null, 1));
  return true;
}
/* 某个平台的「显示名 → 号」。不传平台 = QQ（老调用照旧拿到 {名字: QQ号}）。 */
function allNames(platform) {
  const p = normPlat(platform);
  const j = readJson(NAME_FILE, {});
  const out = {};
  for (const nm of Object.keys(j || {})) {
    const v = j[nm];
    const id = (v && typeof v === 'object') ? String(v.id || '') : String(v || '');
    const vp = (v && typeof v === 'object') ? normPlat(v.platform) : 'qq';
    if (id && vp === p) out[nm] = id;
  }
  return out;
}
/* 这个人在这张表里登记过的所有平台账号（同一个人多平台时用） */
function acctsOfName(nick) {
  const nm = cleanName(nick);
  const j = readJson(NAME_FILE, {});
  const v = j[nm];
  if (!v) return [];
  if (typeof v === 'string') return [{ platform: 'qq', id: v }];
  return v.id ? [{ platform: normPlat(v.platform), id: String(v.id) }] : [];
}

/* ---------- 群名表 ---------- */
function groupNames() {
  const j = readJson(GROUP_FILE, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}
/* NapCat 上线时把群列表一次存进来。list: [{group_id, group_name}] */
function setGroups(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const now = groupNames();
  let n = 0;
  for (const g of list) {
    const id = String((g && (g.group_id || g.groupId)) || '').trim();
    const nm = String((g && (g.group_name || g.groupName)) || '').trim();
    if (!/^\d{4,15}$/.test(id) || !nm) continue;
    if (now[id] !== nm) { now[id] = nm; n++; }
  }
  if (n) atomic(GROUP_FILE, JSON.stringify(now, null, 1));
  return n;
}
/* 机器人没连 NapCat、群名表还空时，客户端里可以自己标一个；标完立刻生效。 */
function groupLabel(scope) {
  const s = String(scope || '');
  const m = s.match(/^群(\d+)$/);
  if (!m) return s || '私聊';
  const nm = groupNames()[m[1]];
  return (nm ? nm : '群') + '（' + m[1] + '）';
}

module.exports = {
  AVATAR_DIR, GROUP_FILE, NAME_FILE,
  normPlat, safeUid, safeId, avKey, avatarCached, avatarFetch, noteSeen,
  groupCached, groupFetch, groupKey,
  descOf, setDesc, needDesc, markDescTried, avatarLine, changedLine,
  cleanName, noteName, allNames, acctsOfName,
  groupNames, setGroups, groupLabel,
};
