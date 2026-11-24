'use strict';
/*
 * sticker-paths.js —— 表情包 / 被拦图的存储路径统一解析（2026-11-25 主人定）
 *
 * 为什么单独一个文件：
 *   以前 qq.js / core.js / panel.js / checks.js 各自写死 data/stickers，被拦图靠目录名「屏蔽」区分。
 *   主人要求「被拦图和表情包存储分开、后续会手动移动位置、不能写死路径」，所以路径只在这里解析：
 *     - 默认值：表情包 src/data/stickers，被拦图 src/data/blocked
 *     - 配置：src/config/features.json → stickerDir / blockedDir / blockedKeepDays / stickerProbeScript
 *     - 环境变量优先：XUHBOT_STICKER_DIR / XUHBOT_BLOCKED_DIR（临时搬家不用改配置）
 *   每次调用都重新读配置（config.cfgLive 自带 mtime 缓存），所以改配置下一轮就生效，不冻结在 require 时刻。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEF_STICKER = path.join('src', 'data', 'stickers');
const DEF_BLOCKED = path.join('src', 'data', 'blocked');
const DEF_PROBE = path.join('src', 'scripts', 'sticker_probe.py');

let errLog = null;
try { errLog = require('./err-log'); } catch (e) { errLog = null; }

function _cfg() {
  try { return require('./config').cfgLive() || {}; } catch (e) { return {}; }
}
function _warn(msg, extra) {
  try { if (errLog) errLog.logErr('sticker-paths', msg, extra || {}); } catch (e) {}
  try { console.log('[路径] ' + msg); } catch (e) {}
}
// 绝对路径原样；~ 展开；相对路径按仓库根解析
function resolvePath(p, dflt) {
  let v = String(p == null ? '' : p).trim();
  if (!v) v = String(dflt || '').trim();
  if (!v) return ROOT;
  if (v === '~') return process.env.HOME || ROOT;
  if (v.indexOf('~/') === 0) v = path.join(process.env.HOME || '', v.slice(2));
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(ROOT, v);
}
function stickerRoot() {
  const c = _cfg();
  return resolvePath(process.env.XUHBOT_STICKER_DIR || c.stickerDir, DEF_STICKER);
}
function blockedRoot() {
  const c = _cfg();
  let b = resolvePath(process.env.XUHBOT_BLOCKED_DIR || c.blockedDir, DEF_BLOCKED);
  const s = stickerRoot();
  // 被拦根包含/等于表情包根 = 清理时会删表情包，必须拦下来（这是唯一会删图的地方）
  const bad = b === s || s.indexOf(b + path.sep) === 0;
  if (bad) {
    _warn('被拦图目录会覆盖表情包目录，已回落默认：' + b);
    b = path.resolve(ROOT, DEF_BLOCKED);
    if (b === s || s.indexOf(b + path.sep) === 0) b = path.resolve(ROOT, 'src', 'data', 'blocked-fallback');
  }
  return b;
}
function blockedKeepDays() {
  const c = _cfg();
  const v = Number(process.env.XUHBOT_BLOCKED_KEEP_DAYS || c.blockedKeepDays);
  return Number.isFinite(v) ? v : 30;
}
function probeScript() {
  const c = _cfg();
  return resolvePath(c.stickerProbeScript, DEF_PROBE);
}
// 判断某路径是否落在被拦图根下（配置把被拦目录放进表情包根里时，统计/清单要排除它）
function isUnderBlocked(p) {
  if (!p) return false;
  return isUnder(p, blockedRoot());
}
function isUnder(p, root) {
  const r = path.resolve(String(p || ''));
  const b = path.resolve(String(root || ''));
  return r === b || r.indexOf(b + path.sep) === 0;
}
function ensure(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch (e) { _warn('建目录失败', { dir: String(dir), msg: String(e.message || e).slice(0, 80) }); return false; }
}
function relOf(abs) {
  const r = path.relative(ROOT, path.resolve(String(abs || ROOT)));
  return (r || '.').split(path.sep).join('/');
}
function relSticker() { return relOf(stickerRoot()); }
function relBlocked() { return relOf(blockedRoot()); }
// 配置/env 变化指纹：调用方拿它决定要不要重算缓存
function stamp() {
  let mt = 0;
  try { mt = require('./config').mtime(); } catch (e) {}
  return mt + '|' + (process.env.XUHBOT_STICKER_DIR || '') + '|' + (process.env.XUHBOT_BLOCKED_DIR || '') + '|' + (process.env.XUHBOT_BLOCKED_KEEP_DAYS || '');
}

module.exports = {
  ROOT, DEF_STICKER, DEF_BLOCKED, DEF_PROBE,
  resolvePath, stickerRoot, blockedRoot, blockedKeepDays, probeScript,
  isUnderBlocked, isUnder, ensure, relOf, relSticker, relBlocked, stamp
};
