/*
 * people.js — 多端互通：按人物聚合全平台账号（主人 2026-11-03 定）
 *
 * 唯一主存：data/people.json，主键是人物ID（p_ 前缀）。
 *
 * 分层（为什么这么分）：
 *   人物级：name（她确认的名字）、favor（好感度，**所有账号共享一个**）、taste、facts
 *   账号级：nick（资料卡名）、cards（群名片，按群号分开）、alias（代称）、suffix
 *            —— 这些原本就是「按 QQ 号」记的：同一个人的两个 QQ 在同一个群可以有两个群名片，
 *               资料卡名也是各看各的。所以留在账号上，不上提，行为零变化。
 *
 * 同时维护两个「镜像」文件（不删、现有读取方一行不动）：
 *   data/favor.json        = 每个 QQ 账号 → {v:人物的好感度, at}
 *   data/people-state.json = 每个 QQ 账号 → {nick, cards, alias, suffix, name}
 * 这样 core.js（群名片注入）、bili-comment.js（按昵称匹配）、checks/selfwatch 等全部照旧工作。
 *
 * B站侧 affection.json（AstrBot 插件目录）不由我们改；通过人物下的 bili 账号映射
 * + panel.js 的同步桥接进来（详见 panel.syncFavorFromBili）。
 *
 * 2026-11-05 主人定（纯 B站 / 任意非 QQ 平台也要建档）：
 *   · 身份键永远是 (platform, id)，昵称只是账号级的一个显示字段 —— 不按昵称认人。
 *   · 任何平台的账号第一次产生「应记内容」都要建档，不许因为「没有 QQ 号」跳过。
 *   · 账号顺序统一 qq → bili → 其它（同平台保序），落盘前 sort（normalizeAccounts）。
 */
const fs = require('fs');
const path = require('path');
const { botWrite } = require('./wlog');

const FILE = path.join(__dirname, 'data', 'people.json');
const FAVOR_MIRROR = path.join(__dirname, 'data', 'favor.json');
const STATE_MIRROR = path.join(__dirname, 'data', 'people-state.json');
const MAX = 100;
const LIKE_AT = 60;
const BAIBAI_AT = 100;
const PERSON_LIKE_AT = 60;
/* 朋友录门槛（2026-11-22 她令：「好感 ≥ 60 → 朋友 这是面板的人物册和朋友录功能，不是让你自己编」）。
 * 面板 /api/friends 一直是 favor > 20 = 朋友录、≤ 20 = 人物册（2026-11-12 她定）。
 * 身份里的「朋友」就读这同一道线：常量只在这里定义一次，面板也读它，两边不会再分叉。 */
const FRIEND_AT = 20;

/* ===== 身份层（2026-11-22 她令：主人 / 欧尼酱 / 朋友 / 认识的人 / 陌生人）=====
 * 身份 = 「这个人是谁」，也是**称呼本身**：主人就喊「主人」、欧尼酱就喊「欧尼酱」，
 * 不再另外维护一张称呼表（她原话：「有称呼表？身份就是称呼啊」）。
 *   · 主人     —— 她本人的号（masterQQ / masters）
 *   · 欧尼酱   —— config.oniiQQ
 *   · 朋友     —— 在面板「朋友录」里（favor > FRIEND_AT）
 *   · 认识的人 —— 在面板「人物册」里（已建档、favor ≤ FRIEND_AT）
 *   · 陌生人   —— 第一次来、还没被认下的人
 * 朋友 / 人物册的分界来自面板，不自己定阈值；角色只在主人 / 欧尼酱上按号硬判。 */
const ROLES = ['master', 'onii', 'friend', 'known', 'stranger'];
const ROLE_LABEL = { master: '主人', onii: '欧尼酱', friend: '朋友', known: '认识的人', stranger: '陌生人' };
/* 主人的号 / 欧尼酱的号：5 秒缓存一次（all() 一次要判 160 多人，别每人读 4 个配置文件） */
let _idCfg = { at: 0, masterQQs: [], oniiQQ: '10000000003' };
function idConfig() {
  if (_idCfg.at && Date.now() - _idCfg.at < 5000) return _idCfg;
  try {
    const cfg = require('./config').cfgLive() || {};
    _idCfg = {
      at: Date.now(),
      masterQQs: [cfg.masterQQ].concat(cfg.masters || []).map(String).filter(Boolean),
      oniiQQ: String(cfg.oniiQQ || '1000000003'),
    };
  } catch { _idCfg = { at: Date.now(), masterQQs: [], oniiQQ: '10000000003' }; }
  return _idCfg;
}
function roleOf(pidOrRecord) {
  const p = typeof pidOrRecord === 'string' ? get(pidOrRecord) : pidOrRecord;
  if (!p) return 'stranger';
  const { masterQQs, oniiQQ } = idConfig();
  const qqIds = (p.accounts || []).filter(a => normPlat(a.platform) === 'qq').map(a => normId(a.id));
  if (qqIds.some(i => masterQQs.indexOf(i) >= 0)) return 'master';
  if (oniiQQ && qqIds.some(i => i === oniiQQ)) return 'onii';
  const fav = clamp(p.favor);
  const named = !!String(p.name || '').trim();
  /* 陌生人只留给「刚建档、还没被认下」的人（没确认名、没好感）。
   * 一旦有了确认名或进过朋友录，就不会再被当陌生人。 */
  if (String(p.role || '') === 'stranger' && !named && fav <= 0) return 'stranger';
  if (fav > FRIEND_AT) return 'friend';    // 朋友录
  return 'known';                          // 人物册
}
function setRole(pid, role) {
  const r = String(role || '');
  if (ROLES.indexOf(r) < 0) return null;
  /* 「朋友」不再手写（她 2026-11-22：朋友录是面板功能，不是编出来的身份）。
   * 要把人加进朋友录 → 改好感（> FRIEND_AT），身份自然跟着走。 */
  if (r === 'friend') return null;
  const o = load();
  const p = o[String(pid)];
  if (!p) return null;
  p.role = r;
  save(o);
  return r;
}
function roleLabel(role) { return ROLE_LABEL[String(role || '')] || ''; }

/* ===== 性别（2026-11-22 她令）=====
 * 之前根本没有性别。现在：AI 全是女、主人是女、其他人都默认男（她已经确认过）。
 * 以后新建档一律先猜男（sexSrc='guess'）：对话里发现是女 → 改女（'said'）；
 * 本人明确说自己是男 → 标成确认（'confirmed'）。 */
const SEXES = ['male', 'female'];
const SEX_LABEL = { male: '男', female: '女' };
const SEX_SRC_LABEL = { guess: '猜的', said: '听本人说的', confirmed: '已确认' };
function sexOf(pidOrRecord) {
  const p = typeof pidOrRecord === 'string' ? get(pidOrRecord) : pidOrRecord;
  if (!p) return 'male';
  const v = String(p.sex || '');
  if (SEXES.indexOf(v) >= 0) return v;
  // 没写过性别：主人的号是女，其余按「默认猜男」
  const { masterQQs } = idConfig();
  const hit = (p.accounts || []).some(a => normPlat(a.platform) === 'qq' && masterQQs.indexOf(normId(a.id)) >= 0);
  return hit ? 'female' : 'male';
}
function sexLabel(sex) { return SEX_LABEL[String(sex || '')] || ''; }
function sexSrcOf(pid) {
  const p = get(pid);
  if (!p) return '';
  return String(p.sexSrc || (p.sex ? 'confirmed' : 'guess'));
}
function setSex(pid, sex, src) {
  const v = String(sex || '');
  if (SEXES.indexOf(v) < 0) return null;
  const s = ['guess', 'said', 'confirmed'].indexOf(String(src || '')) >= 0 ? String(src) : 'said';
  const o = load();
  const p = o[String(pid)];
  if (!p) return null;
  p.sex = v;
  p.sexSrc = s;
  p.at = Date.now();
  save(o);
  return { sex: v, sexSrc: s };
}
/* 改确认名（2026-11-22：主人身份是「主人」、名字叫「虚幻」；欧尼酱身份、名字 NaNa。
 * 名字只是「她叫什么」，跟身份、称呼分开存，别再拿名字当身份用）。 */
function setName(pid, name) {
  const o = load();
  const p = o[String(pid)];
  if (!p) return false;
  const v = String(name == null ? '' : name).replace(/[\r\n]+/g, ' ').trim().slice(0, 30);
  if (v) p.name = v; else delete p.name;
  // 「只有她本人能改人名」那道闸照走：这是她在面板 / 让我代改的操作，等同 user
  save(o, { allowIdentity: 'user' });
  return true;
}
/* 按任意键（裸 QQ / qq:123 / bili:123）取身份，取不到就按陌生人算 */
function roleOfKey(keyOrUid) {
  try {
    const pid = pidOfKey(keyOrUid);
    return pid ? roleOf(pid) : 'stranger';
  } catch { return 'stranger'; }
}

const clamp = v => Math.max(0, Math.min(MAX, Math.round(Number(v) || 0)));
const normId = id => String(id == null ? '' : id).trim();
/* ===== 平台注册表（2026-11-06 她要求「QQ 号也要加前缀，后续加小红书/抖音/小黑盒都不能有问题」）=====
 * 加一个平台**只改这张表**：别名归一、落盘键（'qq:123' / 'xhs:abc'）、面板和客户端显示名全跟着走。
 *   key   = 落盘用的短标识（'qq:1033830163' 里的 qq，字母小写）
 *   label = 显示给人看的中文名
 *   digit = 账号 id 是否必须是纯数字（QQ / B站 UID 是数字；小红书号、抖音号可能带字母）
 * 不在这张表里的平台也能用（key 原样小写保留、id 允许字母数字），只是显示名等于 key。 */
const PLATFORMS = [
  { key: 'qq',        label: 'QQ',       digit: true,  alias: ['qq'] },
  { key: 'bili',      label: 'B站',      digit: true,  alias: ['bili', 'b站', '哔哩哔哩', 'bilibili', 'blbl', 'b23'] },
  { key: 'xhs',       label: '小红书',   digit: false, alias: ['xhs', '小红书', '红书', 'xiaohongshu', 'redbook', 'red'] },
  { key: 'douyin',    label: '抖音',     digit: false, alias: ['douyin', '抖音', 'dy', 'tiktok'] },
  { key: 'xiaoheihe', label: '小黑盒',   digit: false, alias: ['xiaoheihe', '小黑盒', 'heihe', 'hh'] },
  { key: 'weibo',     label: '微博',     digit: false, alias: ['weibo', '微博'] },
  { key: 'wechat',    label: '微信',     digit: false, alias: ['wechat', '微信', 'wx', 'weixin'] },
  { key: 'kook',      label: 'KOOK',     digit: false, alias: ['kook', '开黑'] },
  { key: 'discord',   label: 'Discord',  digit: false, alias: ['discord', 'dc'] },
  { key: 'telegram',  label: 'Telegram', digit: false, alias: ['telegram', 'tg', '电报'] },
];
/* 和 taste.js 的 PLAT_ALIAS 同一口径，但这里自己写一份——
 * people.js 是底层，**不能** require('./taste')（taste 依赖 people，会循环）。 */
const PLAT_ALIAS = (() => {
  const m = {};
  for (const p of PLATFORMS) for (const a of p.alias) m[a] = p.key;
  return m;
})();
const PLAT_BY_KEY = (() => { const m = {}; for (const p of PLATFORMS) m[p.key] = p; return m; })();
/* 平台标识归一（写入端用）：'B站'/'bili'/'哔哩哔哩' → bili，'小红书' → xhs，其它保留小写原值。 */
function normPlat(platform) {
  const k = String(platform == null ? '' : platform).trim().toLowerCase();
  if (!k) return '';
  return PLAT_ALIAS[k] || k;
}
/* 平台给人看的名字：认识的给中文名，不认识的原样（首字母大写没必要，库里是它自己） */
function platLabel(platform) {
  const k = normPlat(platform);
  return (PLAT_BY_KEY[k] && PLAT_BY_KEY[k].label) || String(platform == null ? '' : platform).trim() || k;
}
/* 这个平台的账号 id 该怎么校验 */
function isDigitPlat(platform) {
  const k = normPlat(platform);
  return !!(PLAT_BY_KEY[k] ? PLAT_BY_KEY[k].digit : true);
}
/* 账号 id 能不能当账号用。
 * 不传平台（老调用）→ 只认纯数字，行为和以前一模一样（'NaN'、''、' abc '、null 一律不合法 → 不落盘）。
 * 传平台 → 按平台判：QQ/B站/未知平台仍是纯数字；小红书/抖音/小黑盒等允许字母、数字、下划线、点、连字符。 */
function isAccId(id, platform) {
  const s = normId(id);
  if (!s || s === 'NaN' || s === 'undefined' || s === 'null') return false;
  if (platform == null || platform === '') return /^\d+$/.test(s);
  if (isDigitPlat(platform)) return /^\d+$/.test(s);
  return /^[A-Za-z0-9_.\-]{1,64}$/.test(s);
}
const accEq = (a, p, id) => a && normPlat(a.platform) === normPlat(p) && normId(a.id) === normId(id);
const newPid = () => 'p_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

/* 账号顺序（主人 2026-11-05 定）：「分第一次看到的平台按账号记录，优先排成 QQ-b」。
 * qq 排最前、bili 次之、其它平台按插入顺序排最后；**同平台保持插入顺序**（稳定）。
 * 这样 accounts[0] 一定是 QQ（有 QQ 时），主账号 / 节标题 / 面板显示都稳。 */
const PLAT_RANK = { qq: 0, bili: 1 };
function platRank(platform) {
  const k = normPlat(platform);
  return Object.prototype.hasOwnProperty.call(PLAT_RANK, k) ? PLAT_RANK[k] : 2;
}
/* 原地排好人物的 accounts（稳定排序：同平台按原插入顺序）。
 * 顺手把 platform 归一（'B站'→bili、'QQ'→qq）：老数据里写成中文/大写的，
 * 下次落盘就自动修好，不会和 'bili' 分裂成两个平台。 */
function normalizeAccounts(p) {
  if (!p || !Array.isArray(p.accounts)) return p;
  for (const a of p.accounts) {
    if (!a) continue;
    const np = normPlat(a.platform);
    if (np && np !== a.platform) a.platform = np;
  }
  p.accounts = p.accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (platRank(x.a && x.a.platform) - platRank(y.a && y.a.platform)) || (x.i - y.i))
    .map(x => x.a);
  return p;
}
/* 在内存对象里按账号反查人物（load 一次查出全部，避免每条都重读文件） */
function findIn(o, platform, id) {
  for (const pid of Object.keys(o || {})) {
    const p = o[pid] || {};
    if ((p.accounts || []).some(a => accEq(a, platform, id))) return pid;
  }
  return null;
}
/* 账号级 nick：只在「空的」时候补，绝不覆盖已经记下的名字 */
function fillNickIn(o, pid, platform, id, nick) {
  if (!pid || !nick) return false;
  const p = o[pid];
  if (!p) return false;
  const acc = (p.accounts || []).find(a => accEq(a, platform, id));
  if (!acc || acc.nick) return false;
  acc.nick = nick;
  p.at = Date.now();
  return true;
}

/* 直接从磁盘读，绕过缓存。只有「落盘前比对人名」这类必须看真实文件的场合用。 */
function loadDisk() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}
/* 读盘 + mtime/大小缓存（2026-11-19）：
 * 原因：people.json 一条消息被读 20+ 次，每次 readFileSync+JSON.parse 约 148µs
 *       → 单条消息白烧 3ms 以上 CPU、约 1MB 重复读盘。这是实测出来的头号热点。
 * 语义不变：① 面板/别的进程改了文件（mtime 或大小变）→ 下一次 load() 自动重读；
 *           ② 自己 save() 之后缓存立刻作废（成功失败都作废），下一轮读新文件。
 * 写路径约定：现有全部是 load() → 改 → save()；save 里比对用 loadDisk()（真实磁盘），
 *   所以「不许改人名」那道闸不会因为拿到缓存对象而比成自己、放行非法改名。 */
let _plCache = null, _plMtime = 0, _plSize = -1;
/* 最后一次写盘失败的人话原因（2026-11-22）：面板写入口拿它回给界面，
 * 不能再出现「接口回 ok、文件没改」的静默失败。成功写盘会清空。 */
let _lastWriteError = '';
function lastWriteError() { return _lastWriteError; }
function load() {
  try {
    const st = fs.statSync(FILE);
    if (_plCache && _plMtime === st.mtimeMs && _plSize === st.size) return _plCache;
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    _plCache = o; _plMtime = st.mtimeMs; _plSize = st.size;
    return o;
  } catch { return {}; }
}
/* ===== 人名硬限制（2026-11-13 主人令：「不许改朋友录内的所有人名」）=====
 * name / nick / cards / suffix 四类**称呼**只有她能在面板里改，别的路径一律改不动：
 *   allowIdentity:'user' = 她在面板/IPC 手动改 → 放行，并把旧值→新值记进 review.nameHistory（审计）
 *   allowIdentity:'sync' = 机器人从 QQ 同步真实昵称 → 只许「原本空 → 补上」，不许覆盖已有值
 *   不传 = 脚本 / 模型 / 自动化 → 直接拒绝落盘，打日志把差异写清楚，文件一个字节不动
 * alias（代称）不在此列：它属于「约定·代称」分支，有自己的锁定与复核。
 * 放在 save 这一层，是因为所有写 people.json 的路径最后都经过它，绕不过去。 */
const IDENT_FIELDS = ['nick', 'cards', 'suffix'];
function identOf(p) {
  const out = { name: String((p && p.name) || ''), acc: {} };
  for (const a of ((p && p.accounts) || [])) {
    out.acc[normPlat(a.platform) + ':' + normId(a.id)] = {
      nick: String(a.nick || ''), cards: JSON.stringify(a.cards || {}), suffix: String(a.suffix || ''),
    };
  }
  return out;
}
/* 返回 [{pid, field, from, to}]。新建的人（旧文件里没有这个 pid）不算改人名。 */
function identDiff(old, now) {
  const out = [];
  for (const pid of Object.keys(now || {})) {
    const a = old && old[pid] ? identOf(old[pid]) : null;
    if (!a) continue;
    const b = identOf(now[pid]);
    if (a.name !== b.name) out.push({ pid, field: 'name', from: a.name, to: b.name });
    for (const k of Object.keys(b.acc)) {
      if (!a.acc[k]) continue;                    // 新账号的初始昵称属于建档，不是改人名
      for (const f of IDENT_FIELDS) {
        if (a.acc[k][f] !== b.acc[k][f]) out.push({ pid, field: k + '.' + f, from: a.acc[k][f], to: b.acc[k][f] });
      }
    }
  }
  return out;
}
function save(o, opt) {
  const oo = opt || {};
  try {
    _lastWriteError = '';
    // 落盘前统一排账号顺序（qq → bili → 其它；同平台保序），读到的每个文件都已经是这个顺序
    for (const pid of Object.keys(o || {})) normalizeAccounts(o[pid]);
    const diff = identDiff(loadDisk(), o);   // 必须比真实磁盘：load() 可能正是调用方改过的那个共享对象
    if (diff.length) {
      if (!oo.allowIdentity) {
        console.error('[people] 拒改人名（只有主人能在面板里改）：'
          + diff.map(d => d.pid + ' ' + d.field + ' ' + JSON.stringify(d.from) + '→' + JSON.stringify(d.to)).join(' | ').slice(0, 400));
        _lastWriteError = '人名 / 称呼只能在她面板里手动改，脚本和模型改不动';
        _plCache = null; _plMtime = 0; _plSize = -1;   // 拒绝落盘 → 缓存里可能是脏改动，作废
        return false;
      }
      if (oo.allowIdentity === 'sync') {
        // 群名片是「每个群一格」：从 {} 加一格、或某个群的格换了，都不算覆盖人名。
        // 只要原有键一个都没被删/改，就放行（2026-11-13：以前这条把群名片全挡在门外）。
        const isCardGrow = d => {
          if (!/\.cards$/.test(d.field)) return false;
          try {
            const a = JSON.parse(d.from || '{}') || {}, b = JSON.parse(d.to || '{}') || {};
            return Object.keys(a).every(k => b[k] === a[k]);
          } catch { return false; }
        };
        const bad = diff.filter(d => String(d.from || '') !== '' && !isCardGrow(d));
        if (bad.length) {
          console.error('[people] 同步只许补空，不许覆盖已有称呼：'
            + bad.map(d => d.pid + ' ' + d.field + ' ' + JSON.stringify(d.from) + '→' + JSON.stringify(d.to)).join(' | ').slice(0, 400));
          _lastWriteError = '同步只许补空，不许覆盖已有称呼（要改请在面板里手动改）';
          _plCache = null; _plMtime = 0; _plSize = -1;   // 同上：拒绝落盘就作废缓存
          return false;
        }
      }
      /* QQ 真实资料同步（2026-11-22 她令：「群名片和人物表要读真实的资料卡更新的」）。
       * 和 'sync' 的区别：QQ 是权威源，允许**覆盖**已有的 nick / 某群的群名片，
       * 但绝不许动 name（真名只有本人承认才算）。被覆盖的旧值进 acc.nickHistory，
       * 之后当「曾用名」参与认人，优先度排在其他真实资料卡名后面。 */
      if (oo.allowIdentity === 'qqsync') {
        const bad = diff.filter(d => !/\.(nick|cards)$/.test(String(d.field || '')));
        if (bad.length) {
          console.error('[people] QQ 资料同步只许改 nick / cards：'
            + bad.map(d => d.pid + ' ' + d.field).join(' | ').slice(0, 300));
          _lastWriteError = 'QQ 资料同步只许改昵称 / 群名片';
          _plCache = null; _plMtime = 0; _plSize = -1;
          return false;
        }
        const at = new Date().toISOString();
        for (const d of diff) {
          const m = /^([a-z0-9]+):(.+)\.(nick|cards)$/.exec(String(d.field || ''));
          if (!m) continue;
          const p = o[d.pid];
          if (!p) continue;
          const acc = (p.accounts || []).find(a => normPlat(a.platform) === m[1] && normId(a.id) === m[2]);
          if (!acc) continue;
          acc.nickHistory = Array.isArray(acc.nickHistory) ? acc.nickHistory : [];
          const pushOld = (v, kind, gid) => {
            const old = String(v || '').trim();
            if (!old || old === String(d.to || '').trim()) return;
            if (acc.nickHistory.some(x => x.v === old && x.kind === kind && String(x.gid || '') === String(gid || ''))) return;
            acc.nickHistory.push({ v: old, kind, gid: gid ? String(gid) : undefined, at });
          };
          if (m[3] === 'nick') pushOld(d.from, 'nick');
          else {
            try {
              const a = JSON.parse(d.from || '{}') || {}, b = JSON.parse(d.to || '{}') || {};
              for (const g of Object.keys(a)) if (a[g] && String(a[g]) !== String(b[g] || '')) pushOld(a[g], 'card', g);
            } catch {}
          }
          acc.nickHistory = acc.nickHistory.slice(-20);
        }
      }
      // 手动改：留一条审计（谁、什么时候、哪一项、旧→新），不复制名字本身到别处
      if (oo.allowIdentity === 'user') {
        const at = new Date().toISOString();
        for (const d of diff) {
          const p = o[d.pid];
          if (!p) continue;
          p.review = p.review || {};
          p.review.nameHistory = (p.review.nameHistory || []).slice(-19);
          p.review.nameHistory.push({ at, field: d.field, from: String(d.from || '').slice(0, 60), to: String(d.to || '').slice(0, 60), by: 'master' });
        }
      }
    }
    /* 「只有变了才需要写」（2026-11-22 她令）：内容和磁盘一字不差就直接返回，
     * 不写文件、不刷镜像、不产生任何审计——避免「说一句话就落一次盘」。 */
    try {
      const nextRaw = JSON.stringify(o, null, 1);
      if (fs.readFileSync(FILE, 'utf8') === nextRaw) return true;
    } catch { /* 读不到就照常写 */ }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 1), 'utf8');
    syncMirrors(o);
    _plCache = null; _plMtime = 0; _plSize = -1;     // 落盘后作废：下一位 load() 读新文件
    return true;
  } catch (e) {
    console.error('[people] 存失败', e.message);
    _lastWriteError = '磁盘写不进 people.json：' + (e && e.message || e);
    _plCache = null; _plMtime = 0; _plSize = -1;
    return false;
  }
}
/* 带原因的版本：写盘成功 { ok:true }，失败 { ok:false, error:'人话' }。
 * 面板 / IPC 的写入口用它，才能把真实原因回给界面（2026-11-22 修静默失败）。 */
function saveEx(o, opt) {
  const ok = save(o, opt);
  return ok ? { ok: true } : { ok: false, error: _lastWriteError || '没写进 people.json' };
}

/* 新建一个账号记录（账号级字段都从这儿起步）。平台在这里归一，保证落盘的永远是 qq/bili 这种短名。 */
function makeAccount(platform, id) {
  return { platform: normPlat(platform) || String(platform || ''), id: normId(id), nick: '', cards: {}, alias: '', suffix: '' };
}
/* 在 o 里建一个人物（带一个账号），返回 pid。不落盘。 */
function makePerson(o, platform, id, opts) {
  const pid = newPid();
  o[pid] = Object.assign(
    // sex 默认猜男（2026-11-22 她令：以后给所有人都默认记男，对话里发现是女再改）
    { name: '', accounts: [makeAccount(platform, id)], favor: 0, taste: '', facts: '', at: Date.now(), role: 'stranger', sex: 'male', sexSrc: 'guess' },
    opts || {}
  );
  return pid;
}

/* 新人建档那一刻 = 第一次见（2026-11-06 主人要求「和别人第一次相遇的日子也要记」）。
 * 只在新建时记：老的 68 人是 11-03 批量建档，那天不是真实相遇日，不能补假日期。
 * 键跟 core.whoUidOf 一致：QQ 用裸号，其他平台带前缀（bili:123），免得 B站 UID 撞 QQ 号。 */
function markMeet(platform, id, name) {
  try { require('./dates').meet(platform === 'qq' ? id : (platform + ':' + id), String(name || '')); } catch {}
}

/* 镜像：把人物数据摊平成旧的两个文件（只摊 QQ 账号，B站账号不进镜像） */
function syncMirrors(o) {
  const st = {};
  const fv = {};
  for (const pid of Object.keys(o)) {
    const p = o[pid] || {};
    for (const a of (p.accounts || [])) {
      if (normPlat(a.platform) !== 'qq') continue;
      const id = normId(a.id);
      if (!id) continue;
      const rec = { nick: a.nick || '', cards: a.cards || {}, alias: a.alias || '', suffix: a.suffix || '' };
      if (p.name) rec.name = p.name;
      st[id] = rec;
      fv[id] = { v: clamp(p.favor || 0), at: p.at || Date.now() };
    }
  }
  try {
    fs.writeFileSync(STATE_MIRROR, JSON.stringify(st, null, 1), 'utf8');
    fs.writeFileSync(FAVOR_MIRROR, JSON.stringify(fv, null, 1), 'utf8');
  } catch (e) { console.error('[people] 镜像同步失败', e.message); }
}

/* 统一身份串解析：'bili:123' / 'qq:123' / 'B站:123' → {platform, id}。
 * 裸数字 / 空串 → null（调用方自己决定要不要当 QQ），这样老调用方零改动。
 * 非 QQ 平台（B站直播/评论区）必须用带前缀的身份，否则 B站 UID 会被当成 QQ 号建档。 */
function splitUid(uid) {
  const s = String(uid == null ? '' : uid).trim();
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const platform = normPlat(s.slice(0, i));
  const id = normId(s.slice(i + 1));
  return (platform && id) ? { platform, id } : null;
}

/* 反查：哪个平台+账号属于哪个人物。平台先归一（'B站' 和 'bili' 是同一个平台，
 * 否则 HTTP 传大写/中文进来就查不回来），账号 id 不是纯数字直接当查不到。 */
function findByAccount(platform, id) {
  if (!isAccId(id, platform)) return null;
  return findIn(load(), normPlat(platform), id);
}
function getByAccount(platform, id) {
  const pid = findByAccount(platform, id);
  return pid ? get(pid) : null;
}
function get(pid) { return load()[String(pid)] || null; }
function all() {
  const o = load();
  return Object.keys(o).map(pid => {
    const p = o[pid];
    // 账号顺序 + 平台归一（老数据里可能是 B站 在前、或写成中文）：qq → bili → 其它
    normalizeAccounts(p);
    const ordered = p.accounts || [];
    // nick 是账号级字段（资料卡名各号各看各的）：面板上显示主账号的那个。
    // 纯 B站 人物没有 QQ → 显示它的 B站 昵称，不再是空的。
    const main = ordered.find(a => normPlat(a && a.platform) === 'qq') || ordered[0] || null;
    return {
      pid, name: p.name || '', favor: clamp(p.favor || 0), accounts: ordered,
      nick: String((main && main.nick) || p.nick || ''), at: p.at || 0,
      // 好感锁定（2026-11-13）：面板/客户端要在人物行上显示锁没锁
      favorLock: !!p.favorLock,
      // 代称：约定·代称分支的正本在人物上，面板显示 / 编辑都要读它
      alias: String(p.alias || ''),
      // 身份 / 性别（2026-11-22）：面板人物行要显示，且不能各算一份
      role: roleOf(p), roleLabel: roleLabel(roleOf(p)),
      sex: sexOf(p), sexLabel: sexLabel(sexOf(p)), sexSrc: sexSrcOf(pid),
      masterCall: String(p.masterCall || ''),
    };
  }).sort((a, b) => b.favor - a.favor);
}
/* 人物的主 QQ（第一个 qq 账号），给 taste / 旧接口用 */
function primaryQQ(pid) {
  const p = get(pid);
  if (!p) return '';
  const a = (p.accounts || []).find(x => normPlat(x && x.platform) === 'qq');
  return a ? normId(a.id) : '';
}
/* mainQQ 是 primaryQQ 的别名：新代码（taste.js）用这个名字，老调用方照旧用 primaryQQ */
function mainQQ(pid) { return primaryQQ(pid); }

/* ===== 名字的三层（2026-11-22 她令，取代旧的「名字+代称一条表」）=====
 * 她原话：「应该是对方当前可见名以外的其他资料卡、群名、平台名、别人喊的都是代称，
 *   本人承认的才是真名。代称拿来认人，真名和当前可见名拿来喊。以后这个人改名，
 *   曾用名就加入代称，但优先级低于其他真实的资料卡名。」
 *
 *   真名      p.name                        —— 只有本人承认 / 她在面板确认过才写
 *   当前可见名 本群群名片 → 该号资料卡名      —— 对方此刻看到的名字
 *   代称      其他群名片、各号资料卡名、平台名、别人喊的(alias)、曾用名(nickHistory/nameHistory)
 *
 * 认人：代称全部参与（曾用名也算，改过名也认得出是同一个人）
 * 喊人：只用「真名 → 当前可见名」，不拿代称喊（代称常常是别人瞎叫的）
 * 存储没变：真名 = 人物级 name；资料卡/群名片 = 账号级 nick/cards；别人喊的 = 账号级 alias。
 */
const ALIAS_SPLIT = /[、｜|,，;；]/;
const _nm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* 真名：本人承认的名字（没有就空，不拿代称顶） */
function realNameOf(pid) {
  const p = get(pid);
  return p ? _nm(p.name) : '';
}
/* 当前可见名：这个群里的群名片 → 这个号自己的资料卡名。
 * 2026-11-22 加 platform / aid：私聊和 B站 没有群名片，「当前可见」就是那个平台的昵称；
 * 群场景仍然群名片优先（QQ 群里大家看到的是群名片，不是资料卡）。
 * 2026-11-22 晚（她令「当前平台的多账号和其他群名片都不能喊，只能拿来认」）：
 * **只认当前这个号**——本群没名片就是它自己的资料卡，绝不拿同平台别的号、更不拿别的平台的号顶上。 */
function currentVisibleNameOf(pid, gid, platform, aid) {
  const p = get(pid);
  if (!p) return '';
  const ordered = p.accounts || [];
  const cardOf = a => _nm(a && a.cards && gid ? a.cards[String(gid)] : '');
  const wantPlat = platform ? normPlat(platform) : '';
  const same = wantPlat ? ordered.filter(a => normPlat(a.platform) === wantPlat) : ordered;
  const exact = aid ? same.filter(a => normId(a.id) === normId(aid)) : [];
  let pool;
  if (exact.length) pool = exact;
  else if (wantPlat) pool = same.slice(0, 1);            // 不给号就用该平台主号
  else {
    const main = ordered.find(a => normPlat(a && a.platform) === 'qq') || ordered[0];
    pool = main ? [main] : [];
  }
  for (const a of pool) { const c = cardOf(a); if (c) return c; }
  return _nm(pool[0] && pool[0].nick);
}
/* 主人对他的专属叫法（2026-11-22 她令：「『昵称』改成我的叫法『昵称（主人称呼方式）』」）。
 * 她喊他什么，虚幻就跟着认识这个叫法；它排在真名后面、当前可见名前面用来喊人。 */
function masterCallOf(pid) {
  const p = get(pid);
  return p ? _nm(p.masterCall) : '';
}
function setMasterCall(pid, v) {
  const s = _nm(v).replace(/[、｜|,，;；]/g, '').slice(0, 20);
  const o = load();
  const p = o[String(pid)];
  if (!p) return false;
  if (s) p.masterCall = s; else delete p.masterCall;
  p.at = Date.now();
  return save(o, { allowIdentity: 'user' });
}
/* 代称：当前可见名以外的一切名字（真实资料卡名、其他群名片、平台名、别人喊的、曾用名）。
 * 顺序 = 优先度：其他群/号的真实资料卡名 > 别人喊的 > 曾用名（她要求曾用名最低）。 */
function aliasesOfPerson(pid, gid) {
  const p = get(pid);
  if (!p) return [];
  const out = [];
  const push = v => {
    const s = _nm(v);
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  const visible = currentVisibleNameOf(pid, gid);
  const real = realNameOf(pid);
  // ① 其他群的群名片（真实资料卡）
  for (const a of (p.accounts || [])) {
    for (const g of Object.keys((a && a.cards) || {})) {
      if (gid && String(g) === String(gid)) continue;      // 当前可见名不算代称
      push(a.cards[g]);
    }
  }
  // ② 各账号资料卡名（当前可见那个除外）
  for (const a of (p.accounts || [])) {
    const n = _nm(a && a.nick);
    if (n && n !== visible) push(n);
  }
  // ③ 别人喊的（alias，AI/她记下来的）
  for (const a of (p.accounts || [])) {
    for (const s of String((a && a.alias) || '').split(ALIAS_SPLIT)) push(s);
  }
  // ④ 平台名（B站 / 小红书…）：认人时别人可能直接说平台
  for (const a of (p.accounts || [])) {
    if (normPlat(a && a.platform) === 'qq') continue;
    const pl = platLabel(a && a.platform);
    if (pl) push(pl);
  }
  // ⑤ 曾用名：资料卡 / 群名片改过的旧值、旧真名 —— 优先度最低
  for (const a of (p.accounts || [])) {
    for (const h of (a && a.nickHistory) || []) push(h && h.v);
  }
  for (const h of (((p.review || {}).nameHistory) || [])) {
    if (String(h && h.field) === 'name') push(h.from);
  }
  return out.filter(x => x !== real);
}
/* 喊人用的名字（2026-11-22 她令，别再自己发挥）：
 *   真名 → 主人的叫法 → 本群群名片（无私聊时=这个号自己的昵称）→ 其他平台的昵称。
 * 其他群名片、当前平台的其他号、曾用名、别人喊的代称，**一律不许拿来喊**，只用来认人。
 * 判定统一在 nameEntriesOf 的 callable 字段，这里只是按它过滤。 */
function callNamesOf(pid, gid, platform, aid) {
  return nameEntriesOf(pid, { gid: gid, platform: platform, aid: aid })
    .filter(e => e.callable).map(e => e.name);
}
/* 认人用的名字：三个喊名（真名 / 主人叫法 / 当前可见名）+ 全部代称 */
function recognizeNamesOf(pid, gid, platform, aid) {
  const out = [];
  const push = v => { const s = _nm(v); if (s && out.indexOf(s) < 0) out.push(s); };
  for (const s of callNamesOf(pid, gid, platform, aid)) push(s);
  for (const s of aliasesOfPerson(pid, gid)) push(s);
  return out;
}
/* 追加一个「别人喊的名字」到代称（账号级 alias，写主账号，去重、最多 20 个）。
 * 2026-11-22 名字分层后：本人自报 → 写真名（setName）；别人举证 / AI 观察到的 → 走这里进代称。 */
function addAliasName(pid, name) {
  const v = _nm(name).replace(/[、｜|,，;；]/g, '');
  if (!pid || !v) return false;
  const p = get(pid);
  if (!p) return false;
  if (realNameOf(pid) === v) return false;
  if (aliasesOfPerson(pid).indexOf(v) >= 0) return true;    // 已经是某个群名片/资料卡名了，不用再存一份
  const o = load();
  const po = o[String(pid)];
  if (!po) return false;
  const main = (po.accounts || []).find(a => normPlat(a.platform) === 'qq') || (po.accounts || [])[0];
  if (!main) return false;
  const list = String(main.alias || '').split(ALIAS_SPLIT).map(s => s.trim()).filter(Boolean);
  if (list.indexOf(v) >= 0) return true;
  list.push(v);
  main.alias = list.slice(-20).join('、');
  po.at = Date.now();
  return save(o);
}

/* 按 (platform,id) 直接覆盖某个账号的真实昵称（2026-11-22）：
 * B站/小红书等事件带来的昵称是真实值，允许覆盖（以前只在空着时补，改过名永远跟不上）。
 * 旧值由 save 的 qqsync 档写进 nickHistory，之后当曾用名参与认人。 */
function setAccountNick(platform, aid, nick) {
  const v = _nm(nick).slice(0, 40);
  if (!v) return false;
  const plat = normPlat(platform), id = normId(aid);
  const o = load();
  for (const pid of Object.keys(o)) {
    const a = (o[pid].accounts || []).find(x => normPlat(x.platform) === plat && normId(x.id) === id);
    if (!a) continue;
    if (String(a.nick || '') === v) return false;
    a.nick = v;
    o[pid].at = Date.now();
    return save(o, { allowIdentity: 'qqsync' });
  }
  return false;
}

/* 名字全表（带来源），2026-11-22 她定：
 *   「只要把真名放第一、主人的放第二这样依次排序」「代称里你没放资料卡」
 *   「要解释另外两个是虚幻观察的」
 * 一行按「喊的顺序」排：真名 → 主人的叫法 → 当前可见名 → 其他群名片 → 资料卡 → 我听到别人喊的 → 曾用名。
 * 每项带来源，不再另起「昵称 / 资料卡 / 群名片 / 他还叫」那几行（她说太乱）。
 *   opt: { gid, platform, aid, currentNick }
 *   · gid    群场景：当前可见名 = 这个群的群名片（事件里的显示名最实时）
 *   · 无私聊  platform=qq：当前可见名 = 资料卡昵称
 *   · B站等   当前可见名 = 平台昵称
 */
/* 哪些来源可以拿来喊人（2026-11-22 她令）：
 *   真名 / 主人的叫法 / 本群群名片（=当前可见名）/ 这个号自己的资料卡 / 其他平台的昵称。
 * 其余（别群名片、同平台别的号、曾用名、别人喊的代称、平台号占位）只用来认人。 */
const CALLABLE_KINDS = new Set(['real', 'masterCall', 'visible', 'accountNick', 'otherPlatformNick']);
function nameEntriesOf(pid, opt) {
  const o = opt || {};
  const gid = o.gid ? String(o.gid) : '';
  const platform = o.platform ? normPlat(o.platform) : '';
  const aid = o.aid ? normId(o.aid) : '';
  const p = get(pid);
  if (!p) return [];
  /* 同名合并来源（2026-11-22 她令）：「抖抖海月水母（群467015277的名片）」和
   * 「（B站昵称）」是同一个名字 → 合成一项「抖抖海月水母（B站昵称、群467015277的名片）」，
   * 不能因为去重把后一个来源丢掉（那看起来就「名字没显示全」）。 */
  const out = [];
  const byName = new Map();
  const add = (v, src, kind) => {
    const s = _nm(v);
    if (!s) return;
    const k = kind || 'other';
    const hit = byName.get(s);
    if (hit) {
      if (src && hit.srcs.indexOf(src) < 0) hit.srcs.push(src);
      // 同一个名字既是「只能认」又是「能喊」的来源时，按能喊算（如本群名片 = 别群旧名片）
      if (CALLABLE_KINDS.has(k) && !CALLABLE_KINDS.has(hit.kind)) hit.kind = k;
      return;
    }
    const it = { name: s, srcs: src ? [src] : [], kind: k };
    byName.set(s, it);
    out.push(it);
  };
  const plat = platform || 'qq';
  const accs = (p.accounts || []).filter(a => normPlat(a.platform) === plat);
  const near = aid ? accs.filter(a => normId(a.id) === aid).concat(accs) : accs;
  const cardsOf = g => {
    for (const a of near) { const c = a.cards && a.cards[g]; if (c) return _nm(c); }
    for (const a of (p.accounts || [])) { const c = a.cards && a.cards[g]; if (c) return _nm(c); }
    return '';
  };
  const nickOf = () => {
    for (const a of near) if (a.nick) return _nm(a.nick);
    for (const a of accs) if (a.nick) return _nm(a.nick);
    const main = (p.accounts || []).find(a => normPlat(a.platform) === 'qq') || (p.accounts || [])[0] || {};
    return _nm(main.nick);
  };
  // 事件里带来的显示名最实时（刚改的名片还没落到 cards 时也对）；但它偶尔会是句子，过一道形
  const inbound = (() => {
    const s = _nm(o.currentNick);
    if (!s || s.length > 20 || /[。！？!?，,；;：:]/.test(s)) return '';
    return s;
  })();
  let visible = '', vsrc = '';
  if (gid) {
    const card = cardsOf(gid);
    if (inbound) { visible = inbound; vsrc = '这个群的群名片'; }
    else if (card) { visible = card; vsrc = '这个群的群名片'; }
    else { visible = nickOf(); vsrc = '资料卡'; }
  } else if (plat !== 'qq') {
    visible = nickOf();
    vsrc = platLabel(plat) + '昵称';
  } else {
    visible = nickOf();
    vsrc = '资料卡';
  }
  add(realNameOf(pid), '他本人说的真名', 'real');
  add(masterCallOf(pid), '主人的叫法', 'masterCall');
  add(visible, vsrc, 'visible');
  // 当前这个号（说话/被说的那个号）；没给 aid 就按该平台主号算
  const samePlat = (p.accounts || []).filter(a => normPlat(a.platform) === plat);
  const curAcc = (aid ? samePlat.find(a => normId(a.id) === aid) : null) || samePlat[0] || null;
  const isCur = a => !!curAcc && a === curAcc;
  // 群名片：本群本号的上面已经是「当前可见名」；本群别的号、别的群 —— 都只能认人
  for (const a of (p.accounts || [])) {
    for (const g of Object.keys(a.cards || {})) {
      if (gid && String(g) === gid) {
        if (isCur(a)) continue;
        add(a.cards[g], '群' + g + '的名片', 'samePlatformOtherNick');
        continue;
      }
      add(a.cards[g], '群' + g + '的名片', 'otherGroupCard');
    }
  }
  // 各号资料卡：当前号自己的能喊；同平台别的号只能认人；其他平台（B站等）的能喊
  for (const a of (p.accounts || [])) {
    const pl = normPlat(a.platform);
    const src = pl === 'qq' ? '资料卡' : platLabel(pl) + '昵称';
    const kind = isCur(a) ? 'accountNick' : (pl === plat ? 'samePlatformOtherNick' : 'otherPlatformNick');
    add(a.nick, src, kind);
  }
  // 旧名片 / 曾用名（真实资料，排在「别人喊的」前面：同一个名字先按真实来源归类）
  for (const a of (p.accounts || [])) {
    for (const h of (a.nickHistory || [])) {
      if (String((h && h.kind) || '') === 'card') {
        add(h.v, h.gid ? '群' + h.gid + '的旧名片' : '群名片曾用', 'historyCard');
      } else {
        add(h.v, '旧资料卡', 'historyNick');
      }
    }
  }
  for (const h of (((p.review || {}).nameHistory) || [])) {
    if (String(h && h.field) === 'name') add(h.from, '曾用名', 'formerName');
  }
  // 别人喊的 —— 虚幻自己听到/记下的，不是 QQ 上的真实字段（放最后，真实资料先占名）
  for (const a of (p.accounts || [])) {
    for (const s of String(a.alias || '').split(ALIAS_SPLIT)) add(s, '我听到别人这么喊', 'alias');
  }
  // 平台名（B站 / 小红书…）：只在该平台**还没有昵称**时当标识用（「B站 35886049」），
  // 有昵称就不要把「B站」当成名字的别名（2026-11-22：她说那样只会乱）
  for (const a of (p.accounts || [])) {
    if (normPlat(a.platform) === 'qq') continue;
    if (_nm(a.nick)) continue;
    add(platLabel(a.platform) + ' ' + a.id, '平台账号', 'platPlaceholder');
  }
  return out.map(it => ({
    name: it.name, src: it.srcs.join('、'), srcs: it.srcs.slice(),
    kind: it.kind || 'other', callable: CALLABLE_KINDS.has(it.kind || 'other'),
  }));
}

/* 兼容旧调用：名字表第一项是真名，后面是代称。
 * 旧代码只拿它做「他还叫 …」的展示和面板 names 行，语义不变。 */
function namesOf(pid) {
  const real = realNameOf(pid);
  const al = aliasesOfPerson(pid);
  return real ? [real].concat(al) : al.slice();
}
function nameOfPerson(pid) { return realNameOf(pid); }
/* 人物名下所有 QQ 账号（按 accounts 顺序），给喜恶/事实按人物聚合用；纯 B站人物返回 [] */
function qqAccountsOf(pid) {
  const p = get(pid);
  if (!p) return [];
  return (p.accounts || [])
    .filter(a => a && normPlat(a.platform) === 'qq')
    .map(a => normId(a.id))
    .filter(Boolean);
}
/* 人物名下**所有平台**账号（按 accounts 顺序）：[{platform,id}]。
 * 纯 B站用户没有 QQ，只靠这个取到账号，喜恶/事实才能按人物记。 */
function accountsOf(pid) {
  const p = get(pid);
  if (!p) return [];
  return (p.accounts || [])
    .map(a => ({ platform: String((a && a.platform) || ''), id: normId(a && a.id) }))
    .filter(a => a.platform && a.id);
}
/* 同一个人的「键」集合（2026-11-06 她要求「约定/喜好等等全平台生效」）。
 * 老数据按裸号落盘（QQ 存 QQ 号，B站 侧也存过裸 UID），新数据按 'platform:id'（qq:123 / xhs:abc）。
 * 所以每个人给**两种写法**：裸 id + 'platform:id'，两种都能对上。
 * 档案里查得到 → 把这个人名下**所有平台**账号的两种写法都放进来（两头共用一份）。
 * 档案里查不到（还没建档的人）→ 至少给「传进来那个号」的两种写法，
 * 否则新键 qq:123 和老调用方传的裸号 123 对不上（dates / 老数据的常见情况）。
 * 返回 { pid, keys }。 */
function keySetOf(uid) {
  const raw = String(uid == null ? '' : uid).trim();
  if (!raw) return { pid: '', keys: [] };
  const sp = splitUid(raw);
  let pid = '';
  if (sp) pid = findByAccount(sp.platform, sp.id) || '';
  else pid = pidOfIdAll(raw);          // 裸号不猜平台：档案里哪个平台对得上就是哪个
  const keys = [];
  const add = v => { const s = String(v == null ? '' : v).trim(); if (s && keys.indexOf(s) < 0) keys.push(s); };
  add(raw);
  if (sp) add(sp.id);                  // 'qq:123' ↔ '123'
  else { const plat = platOfId(raw); if (plat) add(plat + ':' + raw); }   // '123' → 'qq:123'
  if (pid) for (const a of accountsOf(pid)) { add(a.id); add(a.platform + ':' + a.id); }
  return { pid, keys };
}
/* 这个号（裸号或 'platform:id'）属于哪个人物；查不到返回 ''。
 * 裸号不猜平台：按人物档案里所有平台的账号逐个找（先 QQ，再按账号顺序）——
 * 老数据的键是裸 QQ 号 / 裸 B站 UID，以后加小红书也是这条，不用再加分支。 */
function pidOfIdAll(id) {
  const o = load();
  const byQq = findIn(o, 'qq', id);
  if (byQq) return byQq;
  for (const pid of Object.keys(o || {})) {
    if ((o[pid].accounts || []).some(a => normId(a && a.id) === normId(id))) return pid;
  }
  return '';
}
function pidOfKey(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return '';
  const sp = splitUid(k);
  if (sp) return findByAccount(sp.platform, sp.id) || '';
  return pidOfIdAll(k);
}
/* 一个裸号属于哪个平台：档案里查得到就按档案写，查不到：
 *   纯数字 → 按 QQ（老数据的键一直是 QQ 号，这样一件老数据都不用迁）；
 *   带字母 → 说不清是哪个平台，返回空，**不许猜成 QQ**（猜错会把小红书号写成 qq:xxx）。
 * 客户端 / 服务端拼显示名用。 */
function platOfId(id) {
  const pid = pidOfIdAll(id);
  if (pid) {
    const p = get(pid);
    const acc = (p && p.accounts || []).find(a => normId(a && a.id) === normId(id));
    if (acc && acc.platform) return normPlat(acc.platform);
  }
  return /^\d+$/.test(normId(id)) ? 'qq' : '';
}
/* ===== 落盘键（2026-11-06 她定：「QQ 号也要加这个前缀，后续加平台都不能有问题」）=====
 * 统一成 'platform:id' —— qq:1033830163 / bili:434882781 / xhs:abc123 / douyin:xyz。
 * 好处：任何平台的号都不会互相撞（B站 9 位 UID 和某个 QQ 号长得一样也不会串），
 * 以后加平台只是多一条注册表，读写代码一行不动。
 * 传进来裸号也能认：档案里有就按档案的平台，没有按 QQ（老数据的键就是 QQ 号）。 */
function keyOf(uid) {
  const raw = String(uid == null ? '' : uid).trim();
  if (!raw) return '';
  const sp = splitUid(raw);
  if (sp) return sp.platform + ':' + sp.id;
  const plat = platOfId(raw);
  return plat ? plat + ':' + raw : raw;   // 认不出平台就原样留着，不冒充成 QQ
}
/* 一条约定/事实/日子挂在谁名下，给人看的名字：'白（B站 434882781）'、'火丁（QQ 975052019）'。
 * 面板和客户端都用它，省得各处再拼一遍平台名。 */
function labelOfKey(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return '所有人';
  const sp = splitUid(k);
  const plat = sp ? sp.platform : platOfId(k);
  const id = sp ? sp.id : k;
  const pid = sp ? (findByAccount(sp.platform, sp.id) || '') : pidOfIdAll(k);
  const p = pid ? get(pid) : null;
  // 群名片 > QQ 昵称（2026-11-13 主人令）：她认的是群里那个名字，不是 QQ 资料卡名。
  // p.nick 本来就不存在（昵称在账号上），这里按「主账号 → 第一个账号」取，显示串和数据分开。
  const acc = p ? ((p.accounts || []).find(x => normPlat(x.platform) === 'qq') || (p.accounts || [])[0] || null) : null;
  const cardN = acc && acc.cards ? String(Object.keys(acc.cards).map(x => acc.cards[x]).filter(Boolean).slice(-1)[0] || '') : '';
  const name = p ? String(p.name || cardN || (acc && acc.nick) || '') : '';
  const tag = (plat ? platLabel(plat) : '账号') + ' ' + id;
  return name ? name + '（' + tag + '）' : tag;
}
/* 平台表（面板 / 客户端要显示「QQ / B站 / 小红书…」时读它，别各写一份） */
function platforms() {
  return PLATFORMS.map(p => ({ key: p.key, label: p.label, digit: !!p.digit }));
}

/* 取人物的主账号记录 */
function mainAccount(pid) {
  const p = get(pid);
  if (!p) return null;
  const a = (p.accounts || []).find(x => normPlat(x && x.platform) === 'qq') || (p.accounts || [])[0];
  return a || null;
}

/* 确保某平台账号存在，返回其人物ID（没有就新建一个独立人物）。
 * opts.nick 落到**账号级** nick（不是人物级）：昵称只是账号的一个显示字段，
 * 身份键始终是 (platform, id)。已有账号的 nick 不会被覆盖（只在空的时候补）。 */
/* 演示 / 基准 / 对照组实验的假号，一律不建档（2026-11-19 事故）。
 * 这些号是 selfcheck 基准、tests/test-all、/tmp 里的禁词对照脚本拿来构造提示词用的；
 * 以前它们每跑一次就在 people.json 里造一个人，她在面板删掉又被造回来。
 * 拦在 ensure/touch 这个唯一建档口上，比在每个脚本里各自防更可靠。 */
const DEMO_ACC = /^(?:123456|666666|777777|555555|9999999999|(?:9100|9300)\d{2})$/;
const isDemoAcc = id => DEMO_ACC.test(String(id || ''));

function ensure(platform, id, opts) {
  id = normId(id);
  platform = normPlat(platform) || 'qq';
  if (!isAccId(id, platform)) return null;   // 'NaN' / 空 / 该平台不该有的字符一律不建档（防脏人物）
  if (platform === 'qq' && isDemoAcc(id)) {  // 假号：只回已有的，没有就返回空，绝不新建
    return findIn(load(), platform, id) || null;
  }
  const opt = Object.assign({}, opts || {});
  const nick = String(opt.nick == null ? '' : opt.nick).trim().slice(0, 40);
  delete opt.nick;                       // nick 是账号级，别被 Object.assign 挂到人物上
  const o = load();
  const pid = findIn(o, platform, id);
  if (pid) {
    if (fillNickIn(o, pid, platform, id, nick)) save(o, { allowIdentity: 'sync' });
    return pid;
  }
  const np = makePerson(o, platform, id, opt);
  const acc = (o[np].accounts || []).find(a => accEq(a, platform, id));
  if (acc && nick) acc.nick = nick;
  save(o, { allowIdentity: 'sync' });
  // 新人建档这一刻 = 第一次见（2026-11-06 主人要求「和别人第一次相遇的日子也要记」）
  markMeet(platform, id, o[np].name || nick);
  return np;
}

/* 「第一次看到这个人」——建档 / 补昵称（主人 2026-11-05 定）。
 * 任何平台的账号第一次出现都能建档（不再因为「不是 QQ」就跳过）。
 * 幂等：已经有这个账号就不新建人物；nick 只在空的时候补。
 * 返回人物ID（失败返回 null），调用方不必关心成败（建档失败不该影响主流程）。 */
function touch(platform, id, opts) {
  id = normId(id);
  platform = normPlat(platform) || 'qq';
  if (!isAccId(id, platform)) return null;   // 同上：不合法账号不落盘，返回 null
  if (platform === 'qq' && isDemoAcc(id)) return null;   // 假号不建档（同 ensure）
  const nick = String((opts && opts.nick) == null ? '' : (opts && opts.nick)).trim().slice(0, 40);
  const o = load();
  const pid = findIn(o, platform, id);
  if (pid) {
    if (fillNickIn(o, pid, platform, id, nick)) save(o, { allowIdentity: 'sync' });
    return pid;
  }
  const np = makePerson(o, platform, id);
  const acc = (o[np].accounts || []).find(a => accEq(a, platform, id));
  if (acc && nick) acc.nick = nick;
  save(o, { allowIdentity: 'sync' });
  markMeet(platform, id, o[np].name || nick);
  return np;
}

/* 好感度（人物维度，D2：每个人共享一个） */
function getFavor(pid) { const p = get(pid); return p ? clamp(p.favor || 0) : 0; }
function getFavorByAccount(platform, id) { const pid = findByAccount(platform, id); return pid ? getFavor(pid) : 0; }
/* 好感锁定（2026-11-13 主人令：「能调整好感数值，并能锁定，目前我的好感就是锁定的 100」）。
 * 锁在人物上（favorLock），锁了以后群里夸她 / 衰减结算 / 面板手滑都改不动；
 * 只有主人自己在面板里显式改数值（setFavor 带 force）或先解锁才能变。 */
function isFavorLocked(pid) { const p = get(pid); return !!(p && p.favorLock); }
function setFavorLock(pid, on) {
  const o = load(); const p = o[String(pid)];
  if (!p) return { error: '没有这个人' };
  p.favorLock = !!on;
  if (!save(o)) return { error: 'people.json 没写进去' };
  return { ok: true, favorLock: !!on, favor: clamp(p.favor || 0) };
}
function setFavor(pid, v, opt) {
  const o = load(); const p = o[String(pid)];
  if (!p) return 0;
  if (p.favorLock && !(opt && opt.force)) return clamp(p.favor || 0);
  p.favor = clamp(v); p.at = Date.now(); save(o); return p.favor;
}
function setFavorByAccount(platform, id, v, opt) {
  const pid = ensure(platform, id);
  return setFavor(pid, v, opt);
}
function addFavor(pid, delta) {
  const before = getFavor(pid);
  if (isFavorLocked(pid)) return { v: before, crossed: false, locked: true };   // 锁了好感不动
  const after = setFavor(pid, before + (Number(delta) || 0));
  const crossed = before < PERSON_LIKE_AT && after >= PERSON_LIKE_AT;
  if (delta > 0) botWrite('data/people.json', '好感', '人物 ' + pid + '：' + before + ' → ' + after + (crossed ? '（过 60，算喜欢，已记进喜好表）' : ''));
  /* 学习系统留痕（2026-11-09）：分数已经改完，这里只让 learn 追加一条事件，
   * 不动分数、不改返回值。learn 出任何问题都不许影响好感本身。 */
  try { require('./learn/favor').note(pid, before, after, { trigger: 'chat', reason: (Number(delta) > 0 ? '+' : '') + delta + ' 分' }); } catch (e) {}
  return { v: after, crossed };
}
function addFavorByAccount(platform, id, delta) {
  const pid = ensure(platform, id);
  return addFavor(pid, delta);
}
function isBaby(pid) { return getFavor(pid) >= BAIBAI_AT; }
function isBabyByAccount(platform, id) { const pid = findByAccount(platform, id); return pid ? isBaby(pid) : false; }

/* 称呼类字段：名字在人物上，nick/cards/alias/suffix 在账号上 */
function getState(pid) {
  const p = get(pid);
  if (!p) return null;
  const a = mainAccount(pid) || {};
  return { name: p.name || '', nick: a.nick || '', cards: a.cards || {}, alias: a.alias || '', suffix: a.suffix || '' };
}
/* 手动改（客户端/面板用）：名字改人物；nick/alias/suffix 改这个人名下**所有 QQ 账号**
 * （手动 = 「这个人就是这样」，不是某个号的样子）
 * opt.byUser：面板里她自己点保存才为真。
 * opt.byAuthor：**本人自己在 QQ 里说的**（「以后叫我 XX」）——名字和代称没有硬分隔（主人 2026-11-13），
 *   本人说的第一个称呼可以直接落成 name；别人猜的、模型编的仍然只能进 alias。
 * nick / suffix 是 QQ 资料，任何非手动路径都不许改。 */
function setState(pid, patch, opt) {
  const o = load(); const p = o[String(pid)];
  if (!p) return false;
  const byUser = !!(opt && opt.byUser);
  const byAuthor = !!(opt && opt.byAuthor);
  if (patch.name !== undefined) {
    if (!byUser && !byAuthor) { console.error('[people] 拒改人名：name 只能是她手动改或本人自己说的（' + pid + '）'); return false; }
    const v = String(patch.name || '').trim(); if (v) p.name = v; else delete p.name;
  }
  for (const f of ['nick', 'alias', 'suffix']) {
    if (patch[f] === undefined) continue;
    if (f !== 'alias' && !byUser) { console.error('[people] 拒改人名：' + f + ' 只能在面板里手动改（' + pid + '）'); return false; }
    const v = String(patch[f] || '').trim();
    // 手动改 = 「这个人就是这样」：老行为是写到名下所有 QQ 账号。
    // 纯 B站 用户没有 QQ 账号，上面那种写法会循环空转、昵称永远改不了 →
    // 没有 QQ 账号时写到它的第一个账号（B站 等）。
    const qqs = (p.accounts || []).filter(a => normPlat(a.platform) === 'qq');
    const list = qqs.length ? qqs : (p.accounts || []).slice(0, 1);
    for (const a of list) {
      if (v) a[f] = v; else delete a[f];
    }
  }
  if (patch.cards !== undefined) {
    if (!byUser) { console.error('[people] 拒改人名：cards 只能在面板里手动改（' + pid + '）'); return false; }
    const a = mainAccount(pid);
    if (a) a.cards = patch.cards || {};
  }
  p.at = Date.now();
  // byAuthor（本人自己说的称呼）也要过 save 的人名闸：按「手动改」这一档放行，
  // 顺手把旧值→新值记进 review.nameHistory，事后能查是谁在什么时候改的。
  return save(o, (byUser || byAuthor) ? { allowIdentity: 'user' } : null);
}
function setCard(pid, gid, card) {
  const o = load(); const p = o[String(pid)];
  if (!p) return false;
  const a = mainAccount(pid);
  if (!a) return false;
  a.cards = a.cards || {};
  if (gid && card) a.cards[String(gid)] = String(card).trim().slice(0, 40);
  p.at = Date.now(); save(o, { allowIdentity: 'sync' });   // 群名片是 QQ 侧真实数据，只补不改
  return true;
}

/* 加账号到人物（D3：一个人物挂多个平台账号）。平台归一 + 账号 id 必须是纯数字。 */
function addAccount(pid, platform, id) {
  id = normId(id);
  platform = normPlat(platform);
  if (!isAccId(id, platform) || !platform) return false;
  const o = load(); const p = o[String(pid)];
  if (!p) return false;
  if (p.accounts.some(a => accEq(a, platform, id))) return false;
  p.accounts.push(makeAccount(platform, id));
  p.at = Date.now(); save(o);
  return true;
}
/* 移除人物下的某个账号（账号全没了就把人物也删掉）。平台同样先归一。 */
function removeAccount(pid, platform, id) {
  id = normId(id);
  platform = normPlat(platform);
  if (!isAccId(id, platform) || !platform) return false;
  const o = load(); const p = o[String(pid)];
  if (!p) return false;
  const before = p.accounts.length;
  p.accounts = p.accounts.filter(a => !accEq(a, platform, id));
  p.at = Date.now();
  if (p.accounts.length === 0) delete o[String(pid)];
  save(o);
  return p.accounts.length < before;
}

/* 合并：from 并入 into（D4 相加封顶100）
 * 账号整个搬过去（各账号自己的资料卡名/群名片/代称照旧跟着号走）；
 * 名字保留 into 的（名字是她确认过的身份，不静默换人）；taste/facts 两边都不丢。 */
function merge(intoPid, fromPid) {
  const o = load();
  const a = o[String(intoPid)], b = o[String(fromPid)];
  if (!a || !b || intoPid === fromPid) return false;
  a.favor = Math.min(MAX, (a.favor || 0) + (b.favor || 0));   // D4 相加封顶100
  const seen = new Set(a.accounts.map(x => normPlat(x.platform) + ':' + normId(x.id)));
  for (const x of (b.accounts || [])) {
    const k = normPlat(x.platform) + ':' + normId(x.id);
    if (seen.has(k)) continue;
    a.accounts.push(Object.assign(makeAccount(x.platform, x.id), {
      nick: x.nick || '', cards: x.cards || {}, alias: x.alias || '', suffix: x.suffix || '',
    }));
    seen.add(k);
  }
  // taste/facts 在 people.json 里只是空占位（真喜恶/真事实在 md 原文，按人物名下 QQ 聚合读，
  // 见 taste.byPerson / panel.readPeople）。这里只保证合并时两边已有内容都不丢：
  // 空的用来源补，都有内容就拼接/合并，绝不静默丢掉来源那一半。
  for (const f of ['taste', 'facts']) {
    const av = a[f], bv = b[f];
    if (!bv) continue;
    if (!av) { a[f] = bv; continue; }
    if (typeof av === 'string' && typeof bv === 'string') {
      if (av !== bv) a[f] = av + '\n' + bv;
    } else if (Array.isArray(av) && Array.isArray(bv)) {
      const seenItem = new Set(av.map(x => JSON.stringify(x)));
      for (const x of bv) {
        const k = JSON.stringify(x);
        if (seenItem.has(k)) continue;
        av.push(x); seenItem.add(k);
      }
    } else if (av && bv && typeof av === 'object' && typeof bv === 'object') {
      a[f] = Object.assign({}, bv, av);
    }
  }
  a.at = Date.now();
  delete o[String(fromPid)];
  save(o, { allowIdentity: 'user' });    // 合并是她在面板里点的操作
  return true;
}

/* 兼容旧 favor.js.all()：返回 [{qq, v, at}]（每人物的每个 QQ 账号一行） */
function favorAllByQQ() {
  const o = load(); const out = [];
  for (const pid of Object.keys(o)) {
    const p = o[pid];
    for (const a of (p.accounts || [])) {
      if (normPlat(a.platform) === 'qq') out.push({ qq: normId(a.id), v: clamp(p.favor || 0), at: p.at || 0 });
    }
  }
  return out.sort((x, y) => y.v - x.v);
}

/* 旧 `cfg.people` 的替代（2026-11-21 主人令：面板和虚幻读同一份人物表，不许再写第二份）。
 * 返回 { 'qq号': '人物表里确认的名字' }，**每次从 people.json 现算**，不落盘、不另存。
 * 以前 qq.js / core.js 有 8 处读 config 里的 people 表，那份早就没人写了（={}），
 * 于是名字全掉回 QQ 昵称（「那就是死了已被移出群聊」这种系统名）——「虚幻认错人、面板没记错」就是这么来的。 */
function nameMapOfQQ() {
  const o = load(); const m = {};
  for (const pid of Object.keys(o)) {
    const p = o[pid] || {};
    const nm = String(p.name || '').trim();
    if (!nm) continue;
    for (const a of (p.accounts || [])) {
      if (normPlat(a.platform) !== 'qq') continue;
      const id = normId(a.id);
      if (id) m[id] = nm;
    }
  }
  return m;
}

/* 给 nick.js 用的：把 people.json 摊成 qq-keyed 视图（和旧 people-state.json 同构）
 * nick/cards/alias/suffix 来自该 QQ 自己的账号记录；name 来自人物。 */
function stateView() {
  const o = load(); const st = {};
  for (const pid of Object.keys(o)) {
    const p = o[pid] || {};
    for (const a of (p.accounts || [])) {
      if (normPlat(a.platform) !== 'qq') continue;
      const id = normId(a.id);
      if (!id) continue;
      st[id] = {
        nick: a.nick || '',
        cards: a.cards || {},
        alias: a.alias || '',
        suffix: a.suffix || '',
        // 主人对他的叫法（2026-11-22）：昵称位置显示它、喊人也认它——nick.nameFor 读的就是这个视图，
        // 不带上的话运行时会永远退回群名片/资料卡，面板设了也叫不出来。
        masterCall: p.masterCall || '',
      };
      // 名字是人物级：只有真的有名字才带上这个键。
      // 「键不存在」= 显式清空（老面板清名字就是这么写的），「键在但空」= 从来没名字。
      if (p.name) st[id].name = p.name;
    }
  }
  return st;
}

/* 给 nick.js 用的：把 qq-keyed 视图写回 people.json
 * 每个 QQ 各写各的账号记录（互不串）；名字是人物级的——同一个人多个 QQ 时，
 * 取「跟当前值不一样」的那个（= 刚被改过的），都一样就保持原样。
 * opt.mode：'sync'（默认，只许补空）| 'qqsync'（QQ 真实资料，允许覆盖 nick/cards）
 *   | 'user'（**她在面板里手动点的保存**：允许改已有名字，并记 review.nameHistory）。
 *   2026-11-22 修：以前面板按 QQ 的老入口只有 sync 一档，改已有名字必被 save 的人名闸拒，
 *   接口却回 ok → 这就是「面板改名字不保存」的静默失败源。 */
function writeStateView(st, opt) {
  const o = load();
  const byPid = {};       // pid -> [qq, ...]
  const qqOf = {};        // qq -> pid
  const touched = {};     // 本次写到的人物
  for (const pid of Object.keys(o)) {
    for (const a of (o[pid].accounts || [])) {
      if (normPlat(a.platform) !== 'qq') continue;
      const id = normId(a.id);
      if (!id) continue;
      (byPid[pid] = byPid[pid] || []).push(id);
      qqOf[id] = pid;
    }
  }
  for (const id of Object.keys(st || {})) {
    let pid = qqOf[id];
    if (!pid) {
      // 这个号第一次出现（刚记下群名片/资料卡名）→ 先建人物和账号，否则称呼会丢
      pid = makePerson(o, 'qq', id);
      byPid[pid] = [id];
      qqOf[id] = pid;
    }
    const rec = st[id] || {};
    const p = o[pid];
    const acc = (p.accounts || []).find(a => normPlat(a.platform) === 'qq' && normId(a.id) === id);
    if (!acc) continue;
    acc.nick = rec.nick || '';
    acc.cards = rec.cards || {};
    acc.alias = rec.alias || '';
    acc.suffix = rec.suffix || '';
    touched[pid] = true;
  }
  // 名字：人物级 —— 一个人物**只算一次**（在所有账号都写完之后），
  // 否则同一个人第二个账号会把第一个的结果盖回去。
  // 规则：有条目带着「跟当前不一样」的名字 → 用它（= 刚被改过的）；
  //       有条目的名字键被删掉了（显式清空）→ 清掉人物的名字；
  //       都一样 / 都没名字键 → 保持原样。
  for (const pid of Object.keys(touched)) {
    const p = o[pid];
    if (!p) continue;
    const curName = String(p.name || '');
    const qids = byPid[pid] || [];
    const withName = qids.filter(q => Object.prototype.hasOwnProperty.call(st[q] || {}, 'name'));
    const cand = withName.map(q => String((st[q] || {}).name || '')).find(n => n && n !== curName);
    if (cand) p.name = cand;
    else if (withName.length && withName.length < qids.length) delete p.name;
    else if (!withName.length && curName) p.name = curName;
  }
  // 镜像回写只许补空、不许拿旧镜像覆盖主存里的人名（save 的人名硬限制会挡住覆盖）；
  // QQ 真实资料（saveCard 带 mode='qqsync'）允许覆盖，旧值在 save 里进 nickHistory。
  const mode = (opt && opt.mode) || 'sync';
  return save(o, { allowIdentity: mode });
}

module.exports = {
  FILE, FAVOR_MIRROR, STATE_MIRROR, MAX, LIKE_AT, BAIBAI_AT, PERSON_LIKE_AT, FRIEND_AT,
  load, save, saveEx, lastWriteError, syncMirrors, findByAccount, getByAccount, get, all, primaryQQ, mainQQ, qqAccountsOf, accountsOf, mainAccount,
  namesOf, nameOfPerson, realNameOf, currentVisibleNameOf, callNamesOf, recognizeNamesOf, aliasesOfPerson, addAliasName, nameEntriesOf,
  setAccountNick,
  masterCallOf, setMasterCall,
  ROLES, ROLE_LABEL, roleOf, setRole, roleLabel, roleOfKey, setName,
  SEXES, SEX_LABEL, SEX_SRC_LABEL, sexOf, sexLabel, setSex, sexSrcOf,
  keySetOf, pidOfKey, pidOfIdAll, keyOf, platOfId, labelOfKey, platforms,
  PLATFORMS, normPlat, platLabel, isDigitPlat, isAccId,
  ensure, touch, PLAT_RANK, platRank, normalizeAccounts, splitUid,
  getFavor, getFavorByAccount, setFavor, setFavorByAccount, addFavor, addFavorByAccount,
  isFavorLocked, setFavorLock,
  isBaby, isBabyByAccount, getState, setState, setCard, addAccount, removeAccount, merge, favorAllByQQ,
  stateView, writeStateView, nameMapOfQQ,
};
