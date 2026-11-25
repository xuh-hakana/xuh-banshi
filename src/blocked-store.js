'use strict';
/*
 * blocked-store.js —— 被拦图（截图/插画/复杂漫画页）的独立存储（2026-11-25 主人定）
 *
 * 主人三条要求：
 *   ① 被拦图和表情包存储分开：不再放进表情包目录的「屏蔽」，改存独立根（默认 src/data/blocked，可在配置改）；
 *   ② 被拦图过 30 天自动清（blockedKeepDays，默认 30；≤0 = 不按时间清）；
 *   ③ 表情包永远不自动清：只有这个文件会调 imgArchive.pruneDir，且只清被拦根。
 * 路径全部来自 sticker-paths.js，不写死。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sp = require('./sticker-paths');

let imgArchive = null;
try { imgArchive = require('./img-archive'); } catch (e) { imgArchive = null; }
let errLog = null;
try { errLog = require('./err-log'); } catch (e) { errLog = null; }

const MAX_COUNT = 2000;                              // 兜底：条数上限之外的二级保护
const MAX_BYTES = 2 * 1024 * 1024 * 1024;            // 兜底：2GB
const PRUNE_EVERY = 24 * 3600 * 1000;                // 24 小时内最多扫一次
const TICK = 6 * 3600 * 1000;                        // 常驻进程每 6 小时有机会清一次

let _lastPrune = 0;

function _warn(msg, extra) {
  try { if (errLog) errLog.logErr('blocked-store', msg, extra || {}); } catch (e) {}
  try { console.log('[被拦图] ' + msg); } catch (e) {}
}

// 被拦图根（每次调用都重新解析，改配置立刻生效）
function dir() {
  const d = sp.blockedRoot();
  sp.ensure(d);
  return d;
}

function _extOf(buf) {
  const b = buf || [];
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
  if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50) return '.png';
  if (b.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42) return '.webp';
  return '.jpg';
}

// 存一张被拦图，返回仓库相对路径（给日志/文案用）；存不下返回 ''
function save(buf, kind, desc) {
  try {
    if (!buf || !buf.length) return '';
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const k = String(kind || 'other').replace(/[^a-z_]/gi, '') || 'other';
    const root = dir();
    const sub = path.join(root, k);
    sp.ensure(sub);
    const name = k + '-' + md5.slice(0, 10) + _extOf(buf);
    const full = path.join(sub, name);
    // 原子落盘 + 跨进程锁：抢同一张图时不会写出半截文件
    require('./state/lock').withLock(full, () => {
      const t = full + '.tmp-' + process.pid;
      fs.writeFileSync(t, buf);
      fs.renameSync(t, full);
    }, { waitMs: 3000 });
    if (desc) { try { imgArchive.remember(md5, { desc: desc, kind: k, src: 'blocked' }); } catch (e) {} }
    prune();
    return sp.relOf(full);
  } catch (e) {
    _warn('存不下：' + String(e.message || e).slice(0, 80));
    return '';
  }
}

// 按时间清一次（默认 24h 内只跑一次）。返回 {removed, items, bytes} 或 {skipped:true}
function prune(force) {
  const now = Date.now();
  if (!force && _lastPrune && now - _lastPrune < PRUNE_EVERY) return { skipped: true };
  _lastPrune = now;
  const keepDays = sp.blockedKeepDays();
  const caps = { maxCount: MAX_COUNT, maxBytes: MAX_BYTES };
  if (keepDays > 0) caps.maxAgeMs = keepDays * 86400000;
  try {
    if (!imgArchive || !imgArchive.pruneDir) return { skipped: true };
    const r = imgArchive.pruneDir(dir(), caps);
    if (r && r.removed) console.log('[被拦图] 清了 ' + r.removed + ' 张（剩 ' + r.items + ' 张，保留 ' + keepDays + ' 天）');
    return r || { removed: 0 };
  } catch (e) {
    _warn('清理失败', { msg: String(e.message || e).slice(0, 80) });
    return { removed: 0 };
  }
}

function stats() {
  const root = sp.blockedRoot();
  let files = 0, bytes = 0;
  const walk = d => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { const st = fs.statSync(p); files++; bytes += st.size; } catch (err) {}
    }
  };
  walk(root);
  return { files: files, bytes: bytes, keepDays: sp.blockedKeepDays(), dir: sp.relOf(root) };
}

// 进程活着时每 6 小时给一次机会（当天已扫过会自己跳过）
try {
  const timer = setInterval(() => { try { prune(); } catch (e) {} }, TICK);
  if (timer && timer.unref) timer.unref();
} catch (e) {}

module.exports = { dir, save, prune, stats, MAX_COUNT, MAX_BYTES };
