/* ===========================================================================
 * platform-limits.js — 各平台「输出字数上限」的单一数据源（2026-11-17 主人令）
 *
 * 这是干什么的：QQ 聊天 / B站评论 / B站私信 三个平台各有一个当前字数上限。
 *   默认值 = 这个表里的值；主人在会话 ⚙ 手填的 chars 不能超过它。
 *   平台改版后靠「测上限」实现把实测值写回这里，全链路一起跟着变。
 *   QQ 空间动态（说说/转发感想）不进这张表——它保持独立短文案。
 *
 * 为什么单独一份：原来上限散在 core.js(600) / qq.js(600) / B站连接器(60,1000)
 *   / B站私信连接器(2000) 四处，改一个数字要翻四个文件，还容易出现「模型放了 1500、
 *   发送层又裁回 600」。收拢到这里，读写只走本模块。
 *   （2026-11-19：那两个 B站连接器已删，B站只剩 bili-api.js 的发包/收图，仍读这张表。）
 *
 * 存在哪：data/platform-limits.json，原子写（tmp + rename），改完下次发送即生效。
 *
 * 结构：
 *   { qq:    { cap, source, measuredAt },
 *     biliC:  { cap, source, measuredAt },
 *     biliD:  { cap, source, measuredAt },
 *     qzone:  { cap, source, measuredAt } }
 *   cap       当前上限（正整数）
 *   source    'initial'（现网值，未实测）| 'measured'（实测得来）| 'manual'（主人手动设）
 *   measuredAt ISO 时间；initial 为空
 *
 * 初值（现网值，source=initial，不冒充平台上限）：
 *   qq 600 / biliC 1000 / biliD 2000
 *   注：原来 bili-comment 的 60 是「日常默认短评」，不是平台上限；平台上限用注释里的 1000。
 *   **qzone 没有初值**：cap=0 = 没测过。2026-11-18 主人令——原来那个 60 是我拍的，
 *   不是官方上限，「这个没用的限制彻底删了」。cap=0 时各处一律不做长度判断，
 *   要限制就先实测（测动态上限）。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'platform-limits.json');

// 初值：现网在用的数。source=initial 明确标记「还没实测过」。
const INITIAL = {
  qq:    { cap: 600,  source: 'initial', measuredAt: '' },
  biliC: { cap: 1000, source: 'initial', measuredAt: '' },
  biliD: { cap: 2000, source: 'initial', measuredAt: '' },
  // QQ 空间动态字数（2026-11-18 主人查到的口径）：
  //   她原话「我搜了，空间动态最多1万到20万字」→ 取保守下限 10000，source=community。
  //   我原来填的 60 是我自己拍的（已删过一轮），那 60 是「文案风格短」，不是平台上限。
  //   实际影响：日记 500 字原文可以直接发空间，不需要压缩成短说说。
  qzone: { cap: 10000, source: 'community', measuredAt: '',
           note: '1万~20万字（主人 2026-11-18 查到的口径，T2）；取保守下限 1 万。要精确值走「测动态上限」实测。' },
  // QQ 空间的频率约束：2026-11-17 主人令「还不如去搜索社区最新口径来的真」。
  // 值取自公开口径（source='community'，记 note 出处），不是我拍的，也不是我连拉试的。
  //   · 我原来臆造过「一次最多连拉几个人」——社区口径里没有这个限制，
  //     真正的约束是**相邻两个请求至少隔 20 秒**；上次 501 就是没留间隔连拉 77 个。
  //   · 撞顶后的真实耗时若与口径不符，由 noteLimit + learnPassive 按实测覆盖成 measured。
  qzonePerDay:     { cap: 3,  source: 'community', measuredAt: '',
                     note: '评论每天 3 条 · 来源：AI Companion Kit 的 qzone_comment 限额说明（T2 转述）' },
  // 评论间隔不在这张表里：主人 2026-11-17「两条评论间隔和动态间隔一致」——
  // 共用 config.qzone.everyHours 那一个数（她自己设的、也是两条转发之间的间隔），
  // 表里再放一个数就变成两套数字了。
  qzoneVisitGap:   { cap: 20, source: 'community', measuredAt: '',
                     note: '逛不同人的空间至少隔 20 秒 · 来源：idctop 风控说明（T2）；触发后 15 分钟~1 小时恢复' },
};
const KEYS = ['qq', 'biliC', 'biliD', 'qzone', 'qzonePerDay', 'qzoneVisitGap'];
// 字数上限最小值 20；频率项单位是「条/秒」，从 1 起就算合法
const MIN_BY_KEY = { qzonePerDay: 1, qzoneVisitGap: 1 };
function minOf(k) { return MIN_BY_KEY[k] || 20; }

let cache = null;
let stamp = 0;

function readAll() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return clone(INITIAL); }
  if (cache && st === stamp) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = normalize(j);
  } catch { cache = clone(INITIAL); }
  stamp = st;
  return cache;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function normalize(j) {
  const out = clone(INITIAL);
  if (!j || typeof j !== 'object') return out;
  for (const k of KEYS) {
    const one = j[k];
    if (!one || typeof one !== 'object') continue;
    const n = Math.round(Number(one.cap) || 0);
    if (n > 0) out[k].cap = Math.max(minOf(k), Math.min(100000, n));
    if (['initial', 'measured', 'manual', 'community', 'unmeasured'].indexOf(one.source) >= 0) out[k].source = one.source;
    if (typeof one.measuredAt === 'string') out[k].measuredAt = one.measuredAt.slice(0, 40);
    if (typeof one.note === 'string') out[k].note = one.note.slice(0, 200);
  }
  return out;
}
function writeAll(obj) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = obj;
  try { stamp = fs.statSync(FILE).mtimeMs; } catch { stamp = 0; }
}

function validKey(k) { return KEYS.indexOf(k) >= 0; }

/* 读一个平台的上限条目：{cap, source, measuredAt} */
function get(k) {
  if (!validKey(k)) return null;
  return Object.assign({}, readAll()[k]);
}
/* 只读 cap（各处裁切用这个） */
function capOf(k) {
  const one = get(k);
  return one ? one.cap : 0;
}
/* 全部（客户端显示用） */
function all() { return clone(readAll()); }

/* 写回实测值。measured=true 标 source=measured 并记时间；否则当主人手设标 manual。
 * 只允许往上或往下按实测改，不在这里做「只升不降」——平台缩了就要如实降下来（缩减可知）。 */
function setCap(k, n, measured) {
  if (!validKey(k)) return { ok: false, error: '平台不对' };
  const cap = Math.round(Number(n) || 0);
  const lo = minOf(k);
  if (cap < lo || cap > 100000) return { ok: false, error: '上限要在 ' + lo + '~100000 之间' };
  const obj = clone(readAll());
  obj[k] = {
    cap,
    source: measured ? 'measured' : 'manual',
    measuredAt: measured ? new Date().toISOString() : '',
    note: measured ? '实测（撞顶记录/探测写回）' : (obj[k] && obj[k].note) || '',
  };
  writeAll(obj);
  return { ok: true, one: Object.assign({}, obj[k]) };
}

/* 把主人手填的 chars 夹到平台上限：超过就压到 cap，没填(<=0)返回 0 表示用默认。 */
function clampChars(k, chars) {
  const n = Math.round(Number(chars) || 0);
  if (n <= 0) return 0;
  const cap = capOf(k);
  return Math.min(cap, n);
}

module.exports = { FILE, INITIAL, KEYS, MIN_BY_KEY, minOf, get, capOf, all, setCap, clampChars, validKey };
