/* ===========================================================================
 * platform-version.js — 各平台「版本号」的单一数据源（2026-11-17 主人令）
 *
 * 这是干什么的：记住每个平台上次见到的版本号。版本一变 = 平台可能改版 →
 *   自动重测该平台的字数上限、写回 platform-limits。主人 2026-11-17 原话：
 *   「有版本号，QQ也是，追踪即可」「版本变化 → 自动重测并写回」。
 *
 * 版本从哪读（本模块只读不采，采样在调用方，因为它要 WS / fetch）：
 *   qq    NapCat callApi('get_version_info').data.app_version —— 实测 4.18.41（retcode 0）
 *         注意：这是 NapCat 框架版本，不是 QQ 客户端版本（主人选的就是读 NapCat）。
 *   bili  B站首页 HTML 的 grayVersion + __NANO_VERSION_HASH__ —— 实测 319318 / b237bb82，
 *         连拉 3 次一致。任一变都算改版。
 *
 * 结构（data/platform-version.json）：
 *   { qq:    { version, seenAt },
 *     bili:  { version, seenAt } }
 *   version  "4.18.41" / "319318|b237bb82"（拼成一个串，任一分量变就变）
 *   seenAt   首次见到该版本的时间
 *
 * 判据（sampleAndDetect 的语义）：
 *   · 第一次（没记录）→ 只记基线，changed=false，不触发重测（防启动就刷屏）
 *   · 版本不同 → changed=true，返回新旧值，并把记录更新为新版本
 *     （不管重测成败都更新，避免同一版本反复触发；失败由调用方记告警让主人手动测）
 *   · 读不到版本（WS断/网页改了字段）→ changed=false，不动记录，记 lastError
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'platform-version.json');
const KEYS = ['qq', 'bili'];
const EMPTY = () => ({ qq: { version: '', seenAt: '' }, bili: { version: '', seenAt: '' } });

let cache = null;
let stamp = 0;

function readAll() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return cache || EMPTY(); }
  if (cache && st === stamp) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = EMPTY();
    for (const k of KEYS) {
      const one = j && j[k];
      if (!one || typeof one !== 'object') continue;
      out[k].version = typeof one.version === 'string' ? one.version.slice(0, 120) : '';
      out[k].seenAt = typeof one.seenAt === 'string' ? one.seenAt.slice(0, 40) : '';
    }
    cache = out;
  } catch { cache = cache || EMPTY(); }
  stamp = st;
  return cache;
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

function get(k) {
  if (KEYS.indexOf(k) < 0) return null;
  const one = readAll()[k];
  return { version: one.version, seenAt: one.seenAt };
}
function all() {
  const a = readAll();
  return { qq: Object.assign({}, a.qq), bili: Object.assign({}, a.bili) };
}

/* 喂进一个新采到的版本串，判定是否变化。空串当"没采到"，不判变化、不写。 */
function submit(k, version) {
  if (KEYS.indexOf(k) < 0) return { ok: false, error: '平台不对' };
  const v = String(version || '').trim().slice(0, 120);
  if (!v) return { ok: false, error: '没采到版本' };
  const obj = JSON.parse(JSON.stringify(readAll()));
  const old = obj[k].version;
  if (old === v) return { ok: true, changed: false, version: v, seenAt: obj[k].seenAt };
  const first = !old;                 // 第一次见到 = 记基线，不算改版
  const seenAt = new Date().toISOString();
  obj[k] = { version: v, seenAt };
  writeAll(obj);
  return { ok: true, changed: !first, first, version: v, oldVersion: old, seenAt };
}

module.exports = { FILE, KEYS, get, all, submit, EMPTY };
