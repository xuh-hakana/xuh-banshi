/*
 * taste.js — 按人物记录喜恶（确定 / 待确认 / 可能 分开存）
 *
 * 存成两个 markdown，因为主人要能像别的文件一样在面板里直接改、删、拖：
 *   data/人物喜好.md      别人的口味，原文一节一个 QQ（她认得出 QQ 号，不改成机器生成）
 *   soul/F-全场景通用主人设/0-我的喜好.md  主人＝虚幻自己的口味（人设层，跟「我是谁」一起注入）
 * 结构固定成六节，代码只认这六节的标题（顺序固定，面板里拖动不会影响读写）：
 *   ### 喜欢（确定）  她自己亲口说过的——明确好恶
 *   ### 讨厌（确定）  她自己亲口说过的——明确好恶
 *   ### 喜欢（人物）  好感度过 60 的人自动进来（对应人物表的 QQ；主人 2026-10-22 定）
 *   ### 待确认      她提到过但没表态的——等主人在面板里选；没选之前算中立
 *   ### 喜欢（可能）  机器人从语气/反复提到里猜的——较中立但有偏好
 *   ### 讨厌（可能）  机器人从语气/反复提到里猜的——较中立但有偏好
 *
 * 2026-11-04 按人物聚合（原文格式/内容一律不动）：
 *   · 读：byPerson() 把人物（people.json）名下所有账号的六节**全留**合并，每条标来源；
 *         注入模型时（block/mine/listMine/vsStance）按 PRIO + POL 去重取一条，避免自相矛盾。
 *   · 写：add()/addPerson() 归一到人物的主账号那一节；老节不删，不再新增散落的分节。
 *   · 主人两个号在 core.js 已归一到 masterQQ 一节，主人那份人设层口味这轮完全不碰。
 *
 * 2026-11-05 纯 B站用户（没有 QQ 号）也能记全部内容：
 *   · 节标题带平台前缀区分：## 名字（B站 30895294）；没有前缀的 ## 名字（123456）仍是 QQ，
 *     她手写的老节一个字不动（B站 UID 也是纯数字，不加前缀会和 QQ 号串）。
 *   · 人物没有 QQ 账号时，写入目标就是它的第一个账号（B站），不再「拒绝写入」。
 *   · 去重检查覆盖人物名下**所有账号**的节：副号/旧节里已有的同内容，不会在主号再写一条。
 *
 * 主人 2026-10-22 定：喜恶表里没有的就是中立；待确认的等选了才算数；猜的算有点偏好但没坐定。
 * 人物和事物**分开记**（不记混）；同内容不重复写（不记重）；
 * 描述**重合**（比如「神秘园」和「神秘园森林」）的两条都留着，主人在面板决定——状态栏会显示重合对数。
 */
const fs = require('fs');
const path = require('path');
const people = require('./people');
const tastecfg = require('./tastecfg');
const fixedTags = require('./fixed-tags');   // 2026-11-21：固定标签，跟可猜的喜好表分开注入
const { botWrite } = require('./wlog');

// 两张表，别混：
//   FILE      data/人物喜好.md       —— 别人的口味，一节一人，按好感度排（黑名单群的人不进表）
//   MINE_FILE soul/F-全场景通用主人设/0-我的喜好.md  —— 主人＝虚幻自己的口味（人设层，和「我是谁」一起注入）
// 谁是主人由 core.js 启动时 setMasters() 告诉这里；没告诉之前一律按「别人」处理。
const FILE = path.join(__dirname, 'data', '人物喜好.md');
const MINE_FILE = path.join(__dirname, 'soul', 'F-全场景通用主人设', '0-我的喜好.md');
const PEOPLE_FILE = people.FILE;
let MASTERS = new Set();
function setMasters(list) {
  MASTERS = new Set((list || []).map(x => String(x || '').replace(/\D/g, '')).filter(Boolean));
}
/* 该写哪张表。platform 必须是**这条内容来源账号**的平台（'bili:30895294' 就传 bili），
 * 不是「写入归一之后主账号」的平台 —— 否则把某个 B站 账号挂到主人名下后，
 * 归一会把主账号变成 qq:<主人号>，这个 B站 用户的话就会被判成主人、写进人设层。
 * 主人只可能是 QQ 号：非 QQ 平台即使 UID 和主人 QQ 号相同也算「不是主人」。
 * 注意：这是「防串号」，**不是拒绝建档** —— 非 QQ 账号照样建档、照样记全部内容，
 * 只是落在 data/人物喜好.md（别人的）而不是人设层。 */
function fileFor(uid, platform) {
  if (platform && String(platform) !== 'qq') return FILE;
  return MASTERS.has(String(uid || '').replace(/\D/g, '')) ? MINE_FILE : FILE;
}
/* ===== 平台标识（2026-11-05：纯 B站用户也要能记）=====
 * 节标题两种写法，靠括号里有没有平台前缀区分：
 *   ## 名字（1000000002）      老格式，没有前缀 = QQ（她手写的节全是这种，一个字不动）
 *   ## 名字（B站 30895294）    新格式，有前缀 = 那个平台（B站 UID 也是纯数字，没前缀会和 QQ 串号）
 * 平台名统一小写存：qq / bili；以后抖音、微博等按同样写法加，解析不用改。 */
/* 平台表**不在这里另写一份**（2026-11-06）：统一用 people.js 那张注册表，
 * 以后加小红书 / 抖音 / 小黑盒，这里一行都不用改。
 * 节标题里存的是给人看的名字（B站 / 小红书），解析时按别名归一。 */
const normPlat = people.normPlat;
const platLabel = people.platLabel;
/* 节标题：名字 + （[平台 ]账号）。名字非贪婪、末尾锚定，兼容名字里自带括号。
 * 账号不再限定纯数字（2026-11-06）：小红书号、抖音号可能带字母；
 * 老格式（纯数字、没平台前缀）照样匹配，她手写的节一个字不动。 */
const H2_RE = /^##\s+(.+?)\s*[（(](?:([^\s（()）\d]{1,10})\s*)?([A-Za-z0-9_.\-]{1,64})[）)]\s*$/;
/* 'qq:123' / 'bili:456' / 裸数字（当 QQ） → { platform, id }；认不出返回 null */
function splitKey(key) {
  const s = String(key == null ? '' : key).trim();
  if (!s) return null;
  const i = s.indexOf(':');
  if (i > 0) {
    const platform = normPlat(s.slice(0, i));
    const id = s.slice(i + 1).trim();
    return (platform && id) ? { platform, id } : null;
  }
  // 裸号：纯数字按 QQ（老格式）；带字母的问档案是哪个平台，查不到就认不出
  // （不去掉字母硬拼数字——那样会把「小红书 abc123」当成 QQ 123）
  if (/^\d+$/.test(s)) return { platform: 'qq', id: s };
  const plat = people.platOfId(s);
  return plat ? { platform: plat, id: s } : null;
}
const keyOf = a => (a && a.platform && a.id) ? String(a.platform) + ':' + String(a.id) : '';

const HEAD = '# 人物喜好';
const LABEL = {
  likeConf: '喜欢（确定）',
  hateConf: '讨厌（确定）',
  likePerson: '喜欢（人物）',
  pending: '待确认',
  likeGuess: '喜欢（可能）',
  hateGuess: '讨厌（可能）',
};
const ORDER = ['likeConf', 'hateConf', 'likePerson', 'pending', 'likeGuess', 'hateGuess'];
// 优先级：确定(3) > 可能(2) > 待确认(1)；极性：喜欢 +1 / 讨厌 -1 / 待确认 0
const PRIO = { likeConf: 3, hateConf: 3, likeGuess: 2, hateGuess: 2, pending: 1 };
const POL = { likeConf: 1, hateConf: -1, likeGuess: 1, hateGuess: -1, pending: 0 };

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 速度优化（2026-10-22）：喜恶表每条消息被解析 2~3 次（口味注入/翻篇检测），
// 加 mtime 缓存——文件没改就不再重读重解析；面板改了、机器人写了，mtime 变了自动失效。
const _cache = new Map();          // path -> { at, text }
function readOne(file) {
  try {
    const st = fs.statSync(file).mtimeMs;
    const c = _cache.get(file);
    if (c && c.at === st) return c.text;
    const text = fs.readFileSync(file, 'utf8');
    _cache.set(file, { at: st, text });
    return text;
  } catch { return ''; }
}
// 解析时两张表一起看：按 QQ 找人，不管他住在哪张表里
function readAll() {
  return [readOne(FILE), readOne(MINE_FILE)].filter(x => x.trim()).join('\n\n');
}

function seed() {
  return [
    HEAD,
    '',
    '> 每个人一节。**（确定）**＝她自己亲口说过（「我最喜欢…」「我讨厌…」）；**（可能）**＝机器人从语气、反复提到里猜的，较中立但有偏好；**（待确认）**＝她提到过但没表态的，等主人选，没选之前算中立。',
    '> 每一行末尾括号里是日期和来源。面板里可以直接改、删、拖动——把「待确认」里的拖到上面两节，就算她认下了。',
    '',
  ].join('\n');
}

// 找某个账号的那一节：[起, 止)。key 形如 'qq:123' / 'bili:456'，也接受裸 QQ 号（当 QQ）
function personRange(lines, key) {
  const k = splitKey(key);
  if (!k) return null;
  const start = lines.findIndex(l => {
    if (!/^##\s+/.test(l)) return false;
    const m = String(l).match(H2_RE);
    if (!m) return false;
    return (normPlat(m[2]) || 'qq') === k.platform && m[3] === k.id;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

/* 解析两张表，一次解析出两个视图（同一份文本、同一套逻辑，不是另起一套）：
 *   all    = { 'qq:1000000002': 节, 'bili:30895294': 节 } —— 按人物聚合用（parseAll）
 *   legacy = { '1000000002': 节 } —— 只有 QQ 节、键是裸 QQ 号（parse，老调用方零改动） */
function parseSections() {
  const all = {}, legacy = {};
  const md = readAll();
  if (!md.trim()) return { all, legacy };
  const lines = md.split('\n');
  let cur = null;
  let sec = null;
  for (const line of lines) {
    const h2 = line.match(H2_RE);
    if (h2) {
      const platform = normPlat(h2[2]) || 'qq';
      const id = h2[3];
      cur = { name: h2[1].trim(), platform, id, key: platform + ':' + id,
              likeConf: [], hateConf: [], likePerson: [], pending: [], likeGuess: [], hateGuess: [] };
      all[cur.key] = cur;
      if (platform === 'qq') legacy[id] = cur;
      sec = null;
      continue;
    }
    if (/^##\s+/.test(line)) { cur = null; sec = null; continue; }
    if (!cur) continue;
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      const t = h3[1].trim();
      sec = ORDER.find(k => LABEL[k] === t) || null;
      continue;
    }
    if (!sec) continue;
    const item = line.match(/^[-*]\s+(.+?)\s*$/);
    if (item) {
      const raw = item[1].trim();
      const m = raw.match(/^(.*?)\s*[（(]([^（()）]*)[）)]\s*$/);
      cur[sec].push(m ? { t: m[1].trim(), from: m[2].trim() } : { t: raw, from: '' });
    }
  }
  return { all, legacy };
}
/* 老接口：只给 QQ 节、键是裸 QQ 号（core.js 用 parse()[masterQQ]）—— 行为完全不变 */
function parse() {
  return parseSections().legacy;
}
/* 新接口：所有平台的节，键是 'qq:123' / 'bili:456'，给按人物聚合用 */
function parseAll() {
  return parseSections().all;
}

/* ===== 按人物聚合（2026-11-04）=====
 * 人物索引同样用 mtime 缓存（和 _cache 一个思路）：QQ → { pid, name, qqs }。
 * 聚合只在内存读，不引入新的写竞争；people.json 被面板/机器人改了，mtime 一变自动失效。 */
const _peopleCache = { at: -1, byQQ: {}, byAny: {}, byKey: {}, byPid: {}, list: [] };
function peopleIndex() {
  let st = 0;
  try { st = fs.statSync(PEOPLE_FILE).mtimeMs; } catch { return _peopleCache; }
  if (_peopleCache.at === st) return _peopleCache;
  let o = {};
  try { o = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')) || {}; } catch { o = {}; }
  const byQQ = {}, byAny = {}, byKey = {}, byPid = {}, list = [];
  for (const pid of Object.keys(o)) {
    const p = o[pid] || {};
    const accounts = (p.accounts || [])
      .map(a => ({ platform: String((a && a.platform) || ''), id: String((a && a.id) == null ? '' : a.id).trim() }))
      .filter(a => a.platform && a.id);
    const qqs = accounts.filter(a => a.platform === 'qq').map(a => a.id);
    const rec = { pid, name: String(p.name || ''), qqs, accounts };
    list.push(rec);
    byPid[pid] = rec;
    for (const qq of qqs) if (!byQQ[qq]) byQQ[qq] = rec;
    // ① 精确索引 platform:id —— 同一个数字在不同平台是不同账号，不能互相顶替
    // ② 全平台账号也登记进 byAny：纯 B站 用户就是靠它反查出来的。同一个号多平台时 QQ 优先。
    for (const a of accounts) {
      const key = a.platform + ':' + a.id;
      if (!byKey[key]) byKey[key] = rec;
      if (a.platform === 'qq') continue;
      if (!byAny[a.id]) byAny[a.id] = rec;
    }
  }
  _peopleCache.at = st; _peopleCache.byQQ = byQQ; _peopleCache.byAny = byAny;
  _peopleCache.byKey = byKey; _peopleCache.byPid = byPid; _peopleCache.list = list;
  return _peopleCache;
}
/* pid / 'qq:123' / 'bili:456' / 裸数字（当 QQ） → 人物记录；查不到返回 null。
 * 2026-11-05：带平台前缀的查询**只**按该平台查（不跨平台兜底）——否则 'bili:30895294'
 * 会被当成 QQ 号 30895294，平台身份就丢了。裸数字保持老行为（QQ 优先，再全平台兜底）。 */
function personOf(pidOrUid) {
  const idx = peopleIndex();
  const raw = String(pidOrUid == null ? '' : pidOrUid).trim();
  if (!raw) return null;
  if (idx.byPid[raw]) return idx.byPid[raw];
  if (String(raw).indexOf('p_') === 0) return null;   // 人物 ID 里的数字不是账号，别拿去反查
  if (raw.indexOf(':') > 0) {                        // 带平台前缀：只认这个平台
    const k = splitKey(raw);
    if (!k) return null;
    return idx.byKey[k.platform + ':' + k.id] || null;
  }
  const digits = raw.replace(/\D/g, '');
  return digits ? (idx.byQQ[digits] || idx.byAny[digits] || null) : null;
}
/* 人物名下所有账号（查不到人物就按 uid 自己的平台账号），给「老节不重复写」的去重检查用。
 * 返回 [{platform,id}]：纯 B站 人物只有 bili 那一条，喜恶照样能记。
 * 带前缀的 uid 不再被抹成裸数字当 QQ（那正是上一轮把 B站 号写成 QQ 号的原因）。 */
function accountsForWrite(uid) {
  const raw = String(uid == null ? '' : uid).trim();
  const rec = personOf(raw);
  const k = splitKey(raw);
  if (rec) {
    const list = rec.accounts.map(a => ({ platform: a.platform, id: a.id }));
    // 带前缀的 uid 但人物名下还没挂这个账号 → 也算进去，别漏（裸数字保持老行为，不额外加 QQ 别名）
    if (k && raw.indexOf(':') > 0 && !list.some(a => a.platform === k.platform && a.id === k.id)) {
      list.push({ platform: k.platform, id: k.id });
    }
    return list;
  }
  return k ? [{ platform: k.platform, id: k.id }] : [];
}
/* 写入归一：uid → 人物 → 主账号（QQ 优先；纯 B站 用户就用它的 B站 账号）。
 * 查不到人物就按原 uid 当 QQ 账号，老行为不变。 */
function writeTargetFor(uid) {
  const list = accountsForWrite(uid);
  if (!list.length) return null;
  return list.find(a => a.platform === 'qq') || list[0];
}

/* 把若干账号的六节原文合并成一份 secs（全留、各标来源）。all 是 parseAll() 的结果。
 * byPerson / clashCount 共用这一处，避免同样的合并逻辑写两遍、也避免重复解析 md。
 * fromQQ 沿用老字段名（客户端在读），另加 fromPlatform 标明是哪个平台。 */
function secsForAccounts(all, accts) {
  const secs = {};
  for (const sec of ORDER) secs[sec] = [];
  for (const a of (accts || [])) {
    const p = all[keyOf(a)];
    if (!p) continue;
    for (const sec of ORDER) {
      for (const x of (p[sec] || [])) {
        secs[sec].push({ t: x.t, from: x.from || '', fromQQ: String(a.id), fromPlatform: String(a.platform) });
      }
    }
  }
  return secs;
}

/* 对外：按人物聚合口味。返回 { name, secs: { likeConf: [{t,from,fromQQ}], ... } }。
 * 同一个词跨号/跨节冲突 → 两条全留、各标 fromQQ（客户端能看出来自哪个号）。
 * 边界：uid 查不到人物 → 回退「按 uid 自己的平台那一节查」；纯 B站 用户（没有 QQ 号）
 *       → 照样读它的 B站 节（2026-11-05）；uid 非数字且无平台前缀 → 空六节，不抛错。 */
function byPerson(pidOrUid) {
  const raw = String(pidOrUid == null ? '' : pidOrUid).trim();
  const rec = personOf(raw);
  // 查不到人物 → 按 uid 自己的平台回退（'bili:123' 就查 B站 那节，裸数字仍当 QQ）——
  // 不再把 B站 号当 QQ 号去找节，平台身份不会丢。
  const accts = rec ? rec.accounts.map(a => ({ platform: a.platform, id: a.id })) : accountsForWrite(raw);
  const all = parseAll();
  let name = rec && rec.name ? rec.name : '';
  if (!name) {
    for (const a of accts) {
      const p = all[keyOf(a)];
      if (p && p.name) { name = p.name; break; }
    }
  }
  return { name, secs: secsForAccounts(all, accts) };
}

/* 注入模型用的视图：同一个词（clean 后）撞了，按 PRIO + POL 只取一条，
 * 免得提示词里同时出现「喜欢猫」和「讨厌猫」。客户端展示仍用 byPerson() 的全留版本。
 * 取舍口径：① PRIO 高的赢（确定 > 可能 > 待确认）；
 *          ② 同 PRIO 取人物账号顺序最前的（主 QQ 优先，新写入都落主 QQ）；
 *          ③ 同一号同强度反 POL（喜欢↔讨厌）取后出现的一条，和 add() 的「升级删旧行」一致；
 *          ④ 完全同立场的重复词只留一条。 */
function modelView(uid) {
  const by = byPerson(uid);
  const accts = accountsForWrite(uid);
  const idxOf = (plat, id) => {
    const i = accts.findIndex(a => a.platform === String(plat || '') && a.id === String(id || ''));
    return i < 0 ? accts.length : i;
  };
  const chosen = new Map();        // 归一文本 -> { t, from, fromQQ, fromPlatform, sec, prio, pol, idx }
  for (const sec of ORDER) {
    for (const x of (by.secs[sec] || [])) {
      // 去重键用**完整**文本：clean() 会截断到 20 字，两条长词条前 20 字相同会被撞成一条、静默丢内容。
      const key = String(x.t || '').replace(/\s+/g, ' ').trim();
      if (!key) continue;
      const cand = {
        t: x.t, from: x.from || '', fromQQ: x.fromQQ || '', fromPlatform: x.fromPlatform || '',
        sec, prio: PRIO[sec], pol: POL[sec], idx: idxOf(x.fromPlatform, x.fromQQ),
      };
      const prev = chosen.get(key);
      if (!prev) { chosen.set(key, cand); continue; }
      const better = cand.prio > prev.prio
        || (cand.prio === prev.prio && cand.idx < prev.idx)
        || (cand.prio === prev.prio && cand.idx === prev.idx && cand.pol !== prev.pol);
      if (better) chosen.set(key, cand);
    }
  }
  const flat = { name: by.name };
  for (const sec of ORDER) flat[sec] = [];
  for (const c of chosen.values()) flat[c.sec].push({ t: c.t, from: c.from, fromQQ: c.fromQQ, fromPlatform: c.fromPlatform });
  return flat;
}

// 给模型看的：这个人的喜恶（没有就返回空）
function block(uid) {
  const p = modelView(uid);
  const part = (arr, tag) => (arr.length ? `${tag}：` + arr.map(x => x.t).join('、') : '');
  const rows = [
    part(p.likeConf, '亲口说喜欢'),
    part(p.hateConf, '亲口说讨厌'),
    part(p.likePerson, '她挺喜欢的人（好感过 60，对他热情一点）'),
    part(p.likeGuess, '可能是喜欢'),
    part(p.hateGuess, '可能是讨厌'),
  ].filter(Boolean);
  // 固定标签（2026-11-21）：单独一行，跟「猜的」分开，模型不能把它当「可能是」改掉。
  const k = splitKey(uid);
  const ft = (k && k.platform === 'qq') ? fixedTags.lineFor(k.id) : '';
  if (ft) rows.push(ft);
  return rows.length ? rows.join('\n') : '';
}

/* ===== 我自己的口味（七栏，主人 2026-11-13 定）=====
 * 原话：「再加两栏「特别·喜/厌」」「后期这个表会变非常多，仅在被询问喜欢哪些时，部分展示「喜欢」，
 *   其余「确认/可能」只在模型搜索时附带展示」「模型的喜好表的参数我可以直接在这页调」。
 * 七栏落在 soul/F-全场景通用主人设/0-我的喜好.md，一行一栏，顺序由 tastecfg 的 order 决定（前端可拖）。
 * 老的三行写法（喜欢 / 讨厌 / 还没表态）照样读，归到 likeConf / hateConf / neutral，一个字不用改。 */
const MINE_SECS = [
  ['specialLike', '特别·喜欢'],
  ['likeConf', '喜欢（确定）'],
  ['likeGuess', '喜欢（可能）'],
  ['neutral', '中立'],
  ['hateConf', '讨厌（确定）'],
  ['hateGuess', '讨厌（可能）'],
  ['specialHate', '特别·讨厌'],
];
const MINE_SEC_KEYS = MINE_SECS.map(x => x[0]);
const MINE_LABEL = (() => { const m = {}; for (const [k, v] of MINE_SECS) m[k] = v; return m; })();
/* 一行的小标题 → 栏 key。写宽一点，她手改标题（少个括号、写成「特别喜欢」）也认。 */
function mineSecOf(head) {
  const h = String(head || '').replace(/^[-*]\s*/, '').trim();
  if (/^特别\s*[·・.、]?\s*喜欢/.test(h)) return 'specialLike';
  if (/^特别\s*[·・.、]?\s*讨厌/.test(h)) return 'specialHate';
  if (/^喜欢\s*[（(]\s*确定/.test(h)) return 'likeConf';
  if (/^喜欢\s*[（(]\s*可能/.test(h)) return 'likeGuess';
  if (/^讨厌\s*[（(]\s*确定/.test(h)) return 'hateConf';
  if (/^讨厌\s*[（(]\s*可能/.test(h)) return 'hateGuess';
  if (/^中立|^还没表态/.test(h)) return 'neutral';
  if (/^喜欢/.test(h)) return 'likeConf';       // 老格式：- 喜欢：
  if (/^讨厌/.test(h)) return 'hateConf';       // 老格式：- 讨厌：
  return null;
}
const mineLineRe = /^[-*]\s*([^:：]+?)\s*[:：]\s*(.*)$/;
/* 读原文 → { specialLike:[], likeConf:[], ... }，词已去掉括号备注
 * 2026-11-13 ⑧：可传 file 读「本地模型专用喜好表」副本——同一份格式、同一套解析，不建第二套。 */
function mineWords(file) {
  const out = {};
  for (const k of MINE_SEC_KEYS) out[k] = [];
  for (const ln of readOne(file || MINE_FILE).split('\n')) {
    const m = ln.match(mineLineRe);
    if (!m) continue;
    const sec = mineSecOf(m[1]);
    if (!sec) continue;
    const body = m[2].replace(/[（(][^）)]*[）)]/g, '');
    for (const w of body.split(/[、,，]/)) {
      const t = w.trim();
      if (t && t !== '还没记' && out[sec].indexOf(t) < 0) out[sec].push(t);
    }
  }
  return out;
}
/* 老形状（like / hate / pending）+ 七栏：老调用方一行不用改，新调用方拿得到细分 */
function mineRows() {
  const w = mineWords();
  return Object.assign({}, w, {
    like: w.specialLike.concat(w.likeConf),
    hate: w.specialHate.concat(w.hateConf),
    pending: w.neutral.slice(),
  });
}
/* 注入模型用。opt.ask = 她在问「你喜欢什么」→ 把可能 / 中立也展开。
 * 平时只给特别栏 + 确定栏的前 confLimit 条：量大，全塞进提示词等于每轮白烧 token。
 * 剩下的走检索（mineSearch）——她说「其余只在模型搜索时附带展示」就是这个意思。 */
function mine(uid, opt) {
  const isMine = MASTERS.has(String(uid || '').replace(/\D/g, ''));
  const tasteFile = (opt && opt.file) || MINE_FILE;
  if (!isMine || !readOne(tasteFile).trim()) {
    const p = modelView(uid);
    const part = (arr, tag, soft) => (arr.length
      ? `${tag}：` + arr.map(x => x.t).join('、') + (soft ? '（还没确认，别当铁板钉钉）' : '')
      : '');
    const rows = [
      part(p.likeConf, '我喜欢'),
      part(p.hateConf, '我讨厌'),
      part(p.likeGuess, '我大概喜欢', true),
      part(p.hateGuess, '我大概不喜欢', true),
      part(p.pending, '还没表态的（别说喜欢、别说讨厌，中立）'),
    ].filter(Boolean);
    return rows.length ? rows.join('\n') : '';
  }
  const cfg = tastecfg.load();
  const show = cfg.show || {};
  const ask = !!(opt && opt.ask);
  const w = mineWords(tasteFile);
  const cut = (arr, n) => (ask ? arr : arr.slice(0, Math.max(1, Number(n) || 12)));
  const rows = [];
  const add = (sec, tag, soft) => {
    let arr = w[sec] || [];
    if (!arr.length) return;
    const limit = (sec === 'likeConf' || sec === 'hateConf') ? show.confLimit : (show.askLimit || 12);
    const shown = cut(arr, limit);
    const more = arr.length - shown.length;
    rows.push(tag + '：' + shown.join('、') + (more > 0 ? `（还有 ${more} 条，问起来再检索）` : '') + (soft ? '（还没确认，别当铁板钉钉）' : ''));
  };
  if (show.special !== false) { add('specialLike', '特别喜欢的'); add('specialHate', '特别讨厌的'); }
  add('likeConf', '我喜欢');
  add('hateConf', '我讨厌');
  if (ask || show.showGuess) { add('likeGuess', '我大概喜欢', true); add('hateGuess', '我大概不喜欢', true); }
  if (ask || show.showNeutral) add('neutral', '还没表态的（别说喜欢、别说讨厌，中立）');
  return rows.join('\n');
}
/* 检索口味：她说「其余『描述』只在模型搜索时展示」。返回命中的条目（含栏名 + 描述）。
 * 描述来自 tasteid（按唯一 id 存的四栏），没填就给最小参数类型的默认模版，不命中不占 token。 */
function mineSearch(q, opt) {
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  const w = mineWords(opt && opt.file);
  let tid = null;
  try { tid = require('./tasteid'); } catch {}
  const out = [];
  for (const k of MINE_SEC_KEYS) {
    for (const t of (w[k] || [])) {
      if (t.indexOf(s) < 0 && s.indexOf(t) < 0) continue;
      const id = tid ? tid.idOf(t) : '';
      const row = { t, sec: k, label: MINE_LABEL[k] };
      if (id) {
        row.id = id;
        const desc = tid.describe(id);
        if (desc) row.desc = desc;
      }
      out.push(row);
    }
  }
  return out;
}

// 去掉末尾标点、压短
function clean(s) {
  return String(s || '')
    .replace(/^[，,、\s「」『』“”"']+/, '')
    .replace(/[，,、。；;！!？?~～\s「」『』“”"']+$/, '')
    .replace(/(了|呀|啊|啦|哦|嘛|吧|呢|咯|噢)+$/, '')   // 「最喜欢猫了」→「最喜欢猫」
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

// 在某人这一节里找「同内容」的行：返回 { idx, kind }，没有返回 null
function findItem(lines, ps, pe, t) {
  for (let i = ps + 1; i < pe; i++) {
    const m = lines[i].match(/^[-*]\s+(.*)$/);
    if (!m) continue;
    if (clean(m[1].split(/[（(]/)[0]) !== t) continue;
    // 这一行属于哪个节：往上找最近的 ###
    let kind = null;
    for (let j = i - 1; j > ps; j--) {
      const h = lines[j].match(/^###\s+(.+?)\s*$/);
      if (h) { kind = ORDER.find(k => LABEL[k] === h[1].trim()) || null; break; }
    }
    return { idx: i, kind };
  }
  return null;
}

// 写一条。同一个人、同内容的不重复写；优先级低的让位给优先级高的（确定 > 可能 > 待确认）
function add(uid, name, kind, text, conf, from) {
  // 喜好表上锁后（2026-11-13 主人令）：只有她在面板手动写能过，模型抽取 / 观察 / 脚本一律拒
  if (!tastecfg.canWrite({ byUser: String(from || '') === '面板' })) return false;
  // 建档（2026-11-05 她定）：带平台前缀的账号**第一次**产生应记内容时，先在人物主存里建档，
  // 不许因为「不是 QQ」就 return false / 跳过。裸数字保持老行为（不凭空造人物）。
  const raw = String(uid == null ? '' : uid).trim();
  if (raw.indexOf(':') > 0) {
    const k = splitKey(raw);
    if (k && !personOf(raw)) {
      try { people.ensure(k.platform, k.id, { nick: String(name || '').trim().slice(0, 40) }); } catch {}
    }
  }
  // 写入归一：uid → 人物 → 主账号（QQ 优先；纯 B站 用户就用它的 B站 账号）。
  // 老节不删、读时按人物聚合，只是不再新增散落的分节。
  const main = writeTargetFor(uid);
  const t = clean(text);
  if (!main || !t) return false;
  // 固定标签优先（2026-11-21）：这个词已经在固定标签里，模型再猜「可能喜欢 / 可能讨厌 / 待确认」
  // 都不许往口味表里写第二份，免得同一件事出现两种说法。
  const fk = splitKey(uid);
  if (fk && fk.platform === 'qq' && fixedTags.has(fk.id, t)) return false;
  const sec = ORDER.includes(kind) ? kind : null;
  if (!sec) return false;

  /* 主人判定用**来源账号的平台**，不用归一后的主账号平台：
   * 把 bili:1000000002 挂到主人名下时，main 会归一到 qq:1000000002，
   * 若拿 main.platform 去判，这个 B站 用户的话就会被写进人设层（和上面 fileFor 的口径矛盾）。
   * 来源是 B站/任意非 QQ 平台 → 一定不是主人，只写《人物喜好》。 */
  const srcPlat = (splitKey(uid) || { platform: 'qq' }).platform;
  const target = fileFor(main.id, srcPlat);   // 主人写人设层，别人写喜好表
  if (target === MINE_FILE) return addMine(sec, t, from, String(from || '') === '面板');   // 人设层是七行式，不走六节结构
  const md = readOne(target);
  const lines = (md.trim() ? md : seed()).split('\n');

  const mainKey = keyOf(main);
  // 去重：人物名下**所有账号**的节都查（老节里已有的同内容也认）。
  // 否则写入归一到主账号后，副号/旧节里同一条会被重新写一遍，面板上同一条显示两次。
  let exist = null;
  for (const a of accountsForWrite(uid)) {
    const r = personRange(lines, keyOf(a));
    if (!r) continue;
    const f = findItem(lines, r[0], r[1], t);
    if (f) { exist = f; break; }
  }
  if (exist) {
    if (!exist.kind) return false;
    if (exist.kind === sec) return false;                                  // 同一节，不重复
    if (PRIO[exist.kind] > PRIO[sec]) return false;                        // 旧的更硬，不动
    if (PRIO[exist.kind] === PRIO[sec] && POL[exist.kind] === POL[sec]) return false;
    lines.splice(exist.idx, 1);                                            // 升级：删掉旧的（可能落在别的号那节）
  }

  let rng = personRange(lines, mainKey);
  if (!rng) {
    // 新的人：加在文件最后。QQ 沿用老写法（裸号，她认得出）；别的平台带前缀，免得和 QQ 串号。
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const tail = main.platform === 'qq' ? `（${main.id}）` : `（${platLabel(main.platform)} ${main.id}）`;
    lines.push('', `## ${clean(name) || main.id}${tail}`, '');
    rng = personRange(lines, mainKey);
    if (!rng) return false;
  }
  let [ps, pe0] = rng;

  // 找到（或造出）这一节
  const title = '### ' + LABEL[sec];
  let hs = -1, he = pe0;
  for (let i = ps + 1; i < pe0; i++) {
    if (lines[i].trim() === title) {
      hs = i;
      for (let j = i + 1; j < pe0; j++) {
        if (/^###\s+/.test(lines[j]) || /^##\s+/.test(lines[j])) { he = j; break; }
      }
      break;
    }
  }
  const line = `- ${t} （${stamp()}${from ? ' · ' + from : ''}）`;

  if (hs >= 0) {
    let ins = he;
    while (ins > hs + 1 && lines[ins - 1].trim() === '') ins--;
    lines.splice(ins, 0, line);
  } else {
    // 没有这一节：按固定顺序插到合适位置
    let ins = pe0;
    while (ins > ps + 1 && lines[ins - 1].trim() === '') ins--;
    const myOrder = ORDER.indexOf(sec);
    // 插在第一个「顺序比它大」的节前面
    for (let i = ps + 1; i < pe0; i++) {
      const h3 = lines[i].match(/^###\s+(.+?)\s*$/);
      if (!h3) continue;
      const k = ORDER.find(x => LABEL[x] === h3[1].trim());
      if (k && ORDER.indexOf(k) > myOrder) { ins = i; break; }
    }
    lines.splice(ins, 0, title, line, '');
  }

  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tidy = lines.join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n(#{2,3} )/g, '\n\n$1')      // 每个标题前面空一行
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s*$/, '\n');
    fs.writeFileSync(target, tidy, 'utf8');
    botWrite(target === MINE_FILE ? 'soul/F-全场景通用主人设/0-我的喜好.md' : 'data/人物喜好.md',
      '喜恶', (clean(name) || main.id) + '：' + (LABEL[sec] || sec) + ' ' + t);
    return true;
  } catch { return false; }
}

/* 前端「朋友录 / 人物册」改喜恶（2026-11-12 主人定：之前只读展示，一直漏了能改）。
 * 改一条文字，或把它从一节挪到另一节（「待确认」拖到「喜欢（确定）」= 她认下了）。
 * 只动 data/人物喜好.md 里这一行；主人自己的那份人设层不在这里改。 */
function setItem(uid, sec, oldText, patch) {
  const o = patch || {};
  const main = writeTargetFor(uid);
  if (!main || !ORDER.includes(sec)) return false;
  const md = readOne(FILE);
  const lines = md.split('\n');
  const rng = personRange(lines, keyOf(main));
  if (!rng) return false;
  const found = findItem(lines, rng[0], rng[1], clean(oldText));
  if (!found || found.kind !== sec) return false;
  const newT = clean(o.text === undefined ? oldText : o.text);
  if (!newT) return false;
  const toSec = ORDER.includes(o.sec) ? o.sec : sec;
  const m = lines[found.idx].match(/^[-*]\s+(.+?)\s*[（(]([^（()）]*)[）)]\s*$/);
  const from = m ? m[2].trim() : '';
  const line = '- ' + newT + (from ? ' （' + from + '）' : '');
  if (toSec === sec) {
    lines[found.idx] = line;
  } else {
    lines.splice(found.idx, 1);
    const title = '### ' + LABEL[toSec];
    let at = -1, end = lines.length;
    for (let i = rng[0] + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break; }
      if (at < 0 && lines[i].trim() === title) at = i + 1;
    }
    if (at >= 0) {
      while (at < lines.length && !lines[at].trim()) at++;
      lines.splice(at, 0, line);
    } else {
      lines.splice(end, 0, '', title, line);
    }
  }
  try {
    fs.writeFileSync(FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'), 'utf8');
    _cache.delete(FILE);
    botWrite('data/人物喜好.md', '喜恶',
      (clean(String((o.name || ''))) || main.id) + '：' + LABEL[sec] + ' → ' + LABEL[toSec] + ' ' + newT);
    return true;
  } catch { return false; }
}
/* 前端手动加一条喜恶（她的原话，默认「确定」；要放「待确认」由前端传 sec）。 */
function addItem(uid, sec, text) {
  const rec = personOf(uid);
  const name = (rec && rec.name) || '';
  return add(uid, name, ORDER.includes(sec) ? sec : 'likeConf', text, false, '面板');
}

// 人设层「我的口味」是单节行式，写法和六节结构不同：
// 只往「一行喜欢 / 一行讨厌 / 一行还没表态」的词表里加，不加日期、不建小节（加了就把人设拆乱）。
function addMine(sec, t, from, byUser) {
  if (!tastecfg.canWrite({ byUser: !!byUser })) return false;
  const key = sec === 'pending' ? '还没表态' : (String(sec).indexOf('like') === 0 ? '喜欢' : '讨厌');
  try {
    const md = readOne(MINE_FILE);
    if (!md.trim()) return false;
    const lines = md.split('\n');
    const i = lines.findIndex(l => /^[-*]\s*/.test(l) && l.replace(/^[-*]\s*/, '').startsWith(key));
    if (i < 0) {
      lines.push('- ' + key + '：' + t + (from ? '（' + from + '）' : ''));
    } else {
      const head = lines[i].match(/^([-*]\s*[^:：]*[:：])\s*(.*)$/);
      if (!head) return false;
      const cur = head[2].replace(/[（(][^）)]*[）)]/g, '').split(/[、,，]/).map(x => x.trim()).filter(Boolean);
      if (cur.includes(t)) return false;             // 已经有了，不重复
      const kept = cur.filter(x => x !== '还没记');
      kept.push(t);            // 口味表只写词，不写来源备注（主人 2026-11-13：「喜好表只需要写1个简单的词/句」）
      lines[i] = head[1].replace(/\s+$/, '') + kept.join('、');
    }
    const tidy = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
    fs.writeFileSync(MINE_FILE, tidy, 'utf8');
    botWrite('soul/F-全场景通用主人设/0-我的喜好.md', '喜恶', '我' + key + '：' + t);
    return true;
  } catch { return false; }
}

// ===== 从一句话里认出「她自己说的喜恶」=====
const STOPWORD = /^(你|您|吗|呢|什么|怎么|啥|不|这|那)/;
const LIKE_RE = /我(?:很|最|超|特别|真的|还挺|挺|蛮|太|有点)?(?:喜欢|爱|爱吃|爱喝|爱玩|爱看|爱听|迷上|就好这口)([^，。！？!?,\s]{1,16})/;
const HATE_RE = /我(?:很|最|超|特别|真的|还挺|挺|蛮|太|有点)?(?:讨厌|不喜欢|不爱|受不了|看不惯|忍不了|烦|怕|恶心|过敏)([^，。！？!?,\s]{1,16})/;

function detect(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 160) return [];
  const out = [];
  const hit = (re, kind) => {
    const m = s.match(re);
    if (!m) return;
    // 「你喜欢什么」这种是在问她，不是自述
    const at = s.indexOf(m[0]);
    const before = s.slice(Math.max(0, at - 4), at);
    if (/你|您/.test(before)) return;
    const t = clean(m[1]);
    if (!t || t.length < 1 || STOPWORD.test(t)) return;
    out.push({ kind, text: t, conf: true });
  };
  hit(LIKE_RE, 'likeConf');
  hit(HATE_RE, 'hateConf');
  return out;
}

// 这句话里她是不是**亲口**说过「我喜欢/我讨厌 X」——「确定」只认这个
const SAID_LIKE = /(喜欢|爱喝|爱吃|爱玩|爱看|爱听|迷上|就好这口)/;
const SAID_HATE = /(讨厌|不喜欢|不爱|受不了|看不惯|忍不了|烦|怕|恶心|过敏)/;
function saidIn(text, t, kind) {
  const s = String(text || '');
  if (!s || !t) return false;
  const re = kind === 'like' ? SAID_LIKE : SAID_HATE;
  for (const line of s.split('\n')) {
    const i = line.indexOf(t);
    if (i < 0) continue;
    const near = line.slice(Math.max(0, i - 14), i);
    if (/我/.test(near) && re.test(near)) return true;
  }
  return false;
}

// 合并模型给的 JSON：模型爱把猜的说成确定，所以「确定」一律以原话为准，其余进「可能」；
// 另外模型会列出「提过但没表态」的东西（mention），那些进「待确认」等主人选
function mergeModel(uid, name, obj, text) {
  let n = 0;
  const take = (arr, kind, confKind, guessKind) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr.slice(0, 8)) {
      const t = clean(typeof x === 'string' ? x : (x && (x.t || x.text)));
      if (!t) continue;
      const conf = saidIn(text, t, kind);
      if (add(uid, name, conf ? confKind : guessKind, t, conf, conf ? '亲口说' : '推测')) n++;
    }
  };
  take(obj && obj.like, 'like', 'likeConf', 'likeGuess');
  take(obj && obj.hate, 'hate', 'hateConf', 'hateGuess');
  if (Array.isArray(obj && obj.mention)) {
    for (const x of obj.mention.slice(0, 6)) {
      const t = clean(typeof x === 'string' ? x : (x && (x.t || x.text)));
      if (!t) continue;
      if (add(uid, name, 'pending', t, false, '提过没表态')) n++;
    }
  }
  return n;
}

// 好感度过 60 的人 → 自动进他那一节的「喜欢（人物）」（主人 2026-10-22 定）。
// 行长这样：- 昵称（QQ 123456） / 昵称（B站 123456） (2026-10-22 · 好感60)——能直接对上人物表；
// 同一个人只在第一次过 60 时写。uid 支持带平台前缀（'bili:123'），裸数字仍是 QQ。
function addPerson(uid, name, v) {
  const accts = accountsForWrite(uid);
  if (!accts.length) return false;
  // 写入归一到人物的主账号（QQ 优先；纯 B站 用户就是 B站 账号）；去重把名下所有账号都算上。
  const main = accts.find(a => a.platform === 'qq') || accts[0];
  const label = platLabel(main.platform);
  const cur = readAll();
  // 去重只认**这个账号自己的平台标签**（qq→QQ / bili→B站）：
  // 以前写死了 `(?:QQ|B站)` 两个都试，B站 号可能被别的 QQ 号那行的「QQ 123456」误命中。
  if (cur && accts.some(a => new RegExp(platLabel(a.platform) + '\\s*' + a.id + '(?!\\d)').test(cur))) return false;
  const nm = clean(name);
  const who = nm || (label + main.id);
  const t = who + '（' + label + ' ' + main.id + '）';
  // 非 QQ 平台写回时带上平台前缀，否则 add() 会把 B站 号当 QQ 号再查一遍
  return add(main.platform === 'qq' ? main.id : keyOf(main), who, 'likePerson', t, false, '好感' + (Number(v) || 60));
}

// 描述重合的对数（同一节里 clean 后一方包含另一方、又不是同一条）。
// 主人 2026-10-22：重合的两条都留着，让主人决定——这里只数个数给状态栏提醒。
// 2026-11-04：改走 byPerson，按人物名下所有 QQ 合起来数；不在 people.json 里的老节照旧单节数，不丢老行为。
function clashCount() {
  const all = parseAll();
  let n = 0;
  const count = secs => {
    for (const sec of ORDER) {
      const arr = ((secs && secs[sec]) || []).map(x => clean(x.t)).filter(Boolean);
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++)
          if (arr[i] !== arr[j] && (arr[i].includes(arr[j]) || arr[j].includes(arr[i]))) n++;
    }
  };
  const idx = peopleIndex();
  const covered = new Set();
  for (const rec of idx.list) {
    for (const a of rec.accounts) covered.add(keyOf(a));
    count(secsForAccounts(all, rec.accounts));
  }
  for (const key of Object.keys(all)) {
    if (covered.has(key)) continue;
    const k = splitKey(key);
    if (k) count(secsForAccounts(all, [k]));
  }
  return n;
}

// 「A 跟 B 哪个厉害」比较题的立场（主人 2026-10-22 定）：**优先按库里已有的口味算**。
// 问题文本里命中了口味词条 → 有立场（喜欢的站喜欢、讨厌的反着来）；
// 一个都没命中 → 两边都没记录过口味，不分高下（这时才允许和稀泥）。
// 「待确认」不算数（没坐定=中立）。
function vsStance(text, uid) {
  const s = String(text || '');
  const liked = [], hated = [];
  const collect = p => {
    for (const sec of ['likeConf', 'likeGuess'])
      for (const x of (p[sec] || [])) if (x.t && x.t.length >= 2 && s.includes(x.t)) liked.push(x.t);
    for (const sec of ['hateConf', 'hateGuess'])
      for (const x of (p[sec] || [])) if (x.t && x.t.length >= 2 && s.includes(x.t)) hated.push(x.t);
  };
  if (MASTERS.has(String(uid || '').replace(/\D/g, ''))) {
    const r = mineRows();                       // 主人仍以人设层单节行式为准（这轮不碰）
    for (const t of r.like) if (t.length >= 2 && s.includes(t)) liked.push(t);
    for (const t of r.hate) if (t.length >= 2 && s.includes(t)) hated.push(t);
    // 人设层没命中时，按人物聚合补查一次（正常情况下主人不在《人物喜好》里，等于没变化）。
    if (!liked.length && !hated.length) collect(modelView(uid));
    return (liked.length || hated.length) ? { mode: 'lib', liked, hated } : { mode: 'none', liked: [], hated: [] };
  }
  collect(modelView(uid));
  return (liked.length || hated.length) ? { mode: 'lib', liked, hated } : { mode: 'none', liked: [], hated: [] };
}

// 全部口味词条（给「话题翻篇」用：回复里带上了哪个口味词，就把那个词封 0.5~5 天不主动提）
function listMine(uid) {
  if (MASTERS.has(String(uid || '').replace(/\D/g, ''))) {
    const r = mineRows();
    return [
      ...r.like.map(t => ({ t, sec: 'likeConf' })),
      ...r.hate.map(t => ({ t, sec: 'hateConf' })),
      ...r.pending.map(t => ({ t, sec: 'pending' })),
    ];
  }
  const p = modelView(uid);
  const out = [];
  for (const sec of ORDER) for (const x of (p[sec] || [])) if (x.t) out.push({ t: x.t, sec });
  return out;
}

/* ===== 我的口味：前端读写（七栏）=====
 * 落盘仍是 soul/F-全场景通用主人设/0-我的喜好.md，一行一栏；读用 mineWords（去括号），写用 mineRawWords（原样留）。
 * 锁（主人 2026-11-13 令）：「给虚幻的喜好表上锁，禁止你修改、查看，不许偷删」——
 *   所有写入口先过 tastecfg.canWrite(opt)，锁着只有主人在面板手动改（opt.byUser）能过。
 *   锁不影响读：虚幻自己每轮都要读它。 */
const MINE_TITLE = {
  specialLike: '特别·喜欢', likeConf: '喜欢（确定）', likeGuess: '喜欢（可能）',
  neutral: '中立（别说喜欢也别说讨厌）', hateConf: '讨厌（确定）', hateGuess: '讨厌（可能）',
  specialHate: '特别·讨厌',
};
function mineRawWords(sec) {
  const out = [];
  for (const ln of readOne(MINE_FILE).split('\n')) {
    const m = ln.match(mineLineRe);
    if (!m || mineSecOf(m[1]) !== sec) continue;
    for (const w of String(m[2] || '').split('、')) { const t = w.trim(); if (t) out.push(t); }
    break;
  }
  return out;
}
const mineBare = s => String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[「」『』“”"']/g, '').trim();
function mineWrite(sec, words) {
  if (!MINE_LABEL[sec]) return false;
  if (!tastecfg.canWrite(arguments[2])) return false;
  try {
    let md = readOne(MINE_FILE);
    if (!md.trim()) md = '## 我的口味\n\n';
    const lines = md.split('\n');
    const body = (words || []).map(x => String(x || '').trim()).filter(Boolean).join('、');
    const line = '- ' + MINE_TITLE[sec] + '：' + body;
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(mineLineRe);
      if (m && mineSecOf(m[1]) === sec) { at = i; break; }
    }
    if (at >= 0) lines[at] = line;
    else {
      // 没有这一栏：插在最后一条口味行之后（找不到就追加到文件尾），别把注释挤乱
      let last = -1;
      for (let i = 0; i < lines.length; i++) { const m = lines[i].match(mineLineRe); if (m && mineSecOf(m[1])) last = i; }
      if (last >= 0) lines.splice(last + 1, 0, line);
      else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push('', line); }
    }
    fs.writeFileSync(MINE_FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'), 'utf8');
    _cache.delete(MINE_FILE);
    botWrite('soul/F-全场景通用主人设/0-我的喜好.md', '口味', (MINE_LABEL[sec] || sec) + ' → ' + body.slice(0, 120));
    return true;
  } catch (e) { console.error('[taste] 口味没写上：' + e.message); return false; }
}
/* 「我喜欢的人」：data/人物喜好.md 里「### 喜欢（人物）」那一节，按人物各记各的（主人 2026-11-13：
 * 「我们喜欢的人不共用」）。关系表（喜/无感/厌）是另一份，见 relation.js，别混。 */
function personLikeRows() {
  const md = readOne(FILE);
  const out = [];
  let sec = '';
  for (const ln of md.split('\n')) {
    const h = ln.match(/^###\s+(.+)$/);
    if (h) { sec = h[1].trim(); continue; }
    if (/^##\s+/.test(ln)) { sec = ''; continue; }
    if (sec.indexOf('喜欢（人物）') < 0) continue;
    const m = ln.match(/^[-*]\s+(.+?)\s*(?:[（(]([^）)]*)[）)])?\s*$/);
    if (m && m[1]) out.push({ t: m[1], from: (m[2] || '').trim() });
  }
  return out;
}
function mineListAll() {
  const w = mineWords();
  const out = {};
  for (const k of MINE_SEC_KEYS) out[k] = w[k];
  out.persons = personLikeRows();
  out.cfg = tastecfg.load();
  out.cols = colsOrdered();
  return out;
}
/* 栏序：tastecfg.order 里认得的排前面，漏掉的补后面（她拖动只改这个顺序，正文行序不动） */
function colsOrdered() {
  const cfg = tastecfg.load();
  const list = (cfg.order || []).filter(k => MINE_LABEL[k]);
  for (const k of MINE_SEC_KEYS) if (list.indexOf(k) < 0) list.push(k);
  return list.map(k => ({ key: k, label: MINE_TITLE[k] || MINE_LABEL[k] }));
}
function mineReorder(order, opt) {
  if (!tastecfg.canWrite(opt)) return { error: '喜好表已锁，只有主人能改' };
  const list = (order || []).filter(k => MINE_LABEL[k]);
  if (!list.length) return { error: '顺序里没有能认的栏' };
  const d = tastecfg.save({ order: list });
  return d ? { ok: true, order: d.order } : { error: '没写进去' };
}
function mineAdd(sec, text, opt) {
  if (!tastecfg.canWrite(opt)) return { error: '喜好表已锁，只有主人能改' };
  const t = clean(text);
  if (!t || !MINE_LABEL[sec]) return { error: '内容或栏不对' };
  const arr = mineRawWords(sec);
  if (arr.some(x => mineBare(x) === t)) return { error: '这一栏已经有了' };
  arr.push(t);
  return mineWrite(sec, arr, opt) ? { ok: true } : { error: '没写进去' };
}
function mineSet(sec, oldText, text, toSec, opt) {
  if (!tastecfg.canWrite(opt)) return { error: '喜好表已锁，只有主人能改' };
  const from = mineBare(oldText), t = clean(text);
  if (!from || !t || !MINE_LABEL[sec]) return { error: '参数不对' };
  const dst = MINE_LABEL[toSec] ? toSec : sec;
  const arr = mineRawWords(sec);
  const i = arr.findIndex(x => mineBare(x) === from);
  if (i < 0) return { error: '没找到这一条' };
  if (dst === sec) { arr[i] = t; return mineWrite(sec, arr, opt) ? { ok: true } : { error: '没写进去' }; }
  arr.splice(i, 1);
  const other = mineRawWords(dst);
  other.push(t);
  const a = mineWrite(sec, arr, opt), b = mineWrite(dst, other, opt);
  return (a && b) ? { ok: true, sec: dst } : { error: '换栏没写全' };
}
function mineDel(sec, text, opt) {
  if (!tastecfg.canWrite(opt)) return { error: '喜好表已锁，只有主人能改' };
  const from = mineBare(text);
  if (!from || !MINE_LABEL[sec]) return { error: '参数不对' };
  const arr = mineRawWords(sec).filter(x => mineBare(x) !== from);
  return mineWrite(sec, arr, opt) ? { ok: true } : { error: '没写进去' };
}
/* 词条挪位（前端拖动）：同一栏内换位置，写回原行 */
function mineMoveItem(sec, text, toIdx, opt) {
  if (!tastecfg.canWrite(opt)) return { error: '喜好表已锁，只有主人能改' };
  const from = mineBare(text);
  const arr = mineRawWords(sec);
  const i = arr.findIndex(x => mineBare(x) === from);
  if (i < 0) return { error: '没找到这一条' };
  const [x] = arr.splice(i, 1);
  const at = Math.max(0, Math.min(arr.length, Number(toIdx) || 0));
  arr.splice(at, 0, x);
  return mineWrite(sec, arr, opt) ? { ok: true } : { error: '没写进去' };
}

module.exports = { setMasters, block, mine, mineSearch, add, addItem, setItem, clean, addPerson, clashCount, detect, mergeModel, parse, parseAll, vsStance, listMine, byPerson, mineListAll, mineAdd, mineSet, mineDel, mineWords, mineRawWords, mineReorder, mineMoveItem, colsOrdered, MINE_SEC_KEYS, MINE_LABEL, MINE_TITLE, MINE_SECS, mineSecOf, FILE, MINE_FILE, ORDER, LABEL };
