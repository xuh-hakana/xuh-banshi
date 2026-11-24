'use strict';
/* ===========================================================================
 * util/lock.js —— 跨进程写锁（2026-11-25）
 *
 * 机器人进程和面板/客户端是两个进程，改同一份配置/队列时得排队：
 * 用 O_EXCL 抢 <file>.lock，抢不到就短暂退避重试；锁文件超过 ttlMs 视为
 * 上一个写者已死（崩了没删锁），直接接管，不让一次崩溃把文件永久锁死。
 *
 *   withLock(file, fn, {ttlMs, waitMs}) → fn() 的返回值
 *   fn 抛错时锁照样释放。
 * =========================================================================== */
const fs = require('fs');

function _sleep(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { /* 同步退避：调用方是同步读改写 */ }
}

function _stale(p, ttlMs) {
  try { return Date.now() - fs.statSync(p).mtimeMs > ttlMs; } catch (e) { return true; }
}

function withLock(file, fn, opts) {
  const o = opts || {};
  const ttlMs = Math.max(1000, Number(o.ttlMs) || 10000);
  const waitMs = Math.max(0, Number(o.waitMs) || 3000);
  const lockPath = file + '.lock';
  const deadline = Date.now() + waitMs;
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid) + ' ' + new Date().toISOString(), 'utf8');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (_stale(lockPath, ttlMs)) { try { fs.unlinkSync(lockPath); } catch (e2) {} continue; }
      if (Date.now() >= deadline) throw new Error('等锁超时：' + lockPath);
      _sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (e) {}
    try { fs.unlinkSync(lockPath); } catch (e) {}
  }
}

module.exports = { withLock };
