'use strict';
/* ===========================================================================
 * src/state/lock.js —— 跨进程写锁（v4，2026-11-25）
 *
 * 与 v1（src/util/lock.js）的差别：
 *   1. 退避不再空转：用 Atomics.wait 真睡，不烧 CPU、不占事件循环。
 *   2. 过期判定先探活：锁文件里记 pid，进程已死才接管；pid 读不出来时按放置时长兜底。
 *   3. 拿到锁用 inode 自证：创建后 fstat(fd) 的 inode 必须等于此刻 stat(路径) 的 inode。
 *      对不上说明这份锁文件已被别人删掉重建，立刻让出去——这是唯一能真正判定
 *      "锁是不是我的"的办法（只靠文件内容会被抢占窗口骗过去，实测会丢写）。
 *   4. 放锁只删自己的（inode 相同才 unlink），绝不误删别人的锁。
 *   5. withLockAsync：给 HTTP 处理用，异步退避，不阻塞别的请求。
 *
 * 锁文件放在目标文件旁边：<file>.lock，内容是 "pid token ISO时间"。
 * 抢不到锁且超过 waitMs 就抛 E_LOCK_TIMEOUT，让调用方明确失败，绝不静默覆盖。
 * =========================================================================== */
const fs = require('fs');

const SAB = new SharedArrayBuffer(4);
const TOKEN = String(process.pid) + '-' + Math.random().toString(36).slice(2, 10);

function sleepSync(ms) {
  const n = Math.max(1, Number(ms) || 1);
  Atomics.wait(new Int32Array(SAB), 0, 0, n);
}

function alive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function ageMs(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch (e) { return -1; }
}

function readLock(p) {
  try {
    const s = String(fs.readFileSync(p, 'utf8'));
    const parts = s.trim().split(/\s+/);
    const pid = parseInt(parts[0], 10);
    return { pid: Number.isFinite(pid) ? pid : 0, token: parts[1] || '' };
  } catch (e) {
    return { pid: 0, token: '' };
  }
}

/* 返回 {ino} 表示真拿到了；返回 null 表示没拿到（别人持有 / 被别人抢走）。
 *
 * 归属判定用 token：创建后立刻写自己的随机 token，再读回来核对。
 * 只比 inode 不够——APFS 会回收 inode 号，同号码被别的进程新建的锁文件复用时，
 * 老持有者放锁时会把新持有者的锁删掉，连锁重叠（2026-11-25 实测丢写就是这么来的）。 */
function tryTake(lockPath) {
  let fd = null;
  let ino = 0;
  try {
    fd = fs.openSync(lockPath, 'wx');
    ino = fs.fstatSync(fd).ino;
    fs.writeFileSync(fd, String(process.pid) + ' ' + TOKEN + ' ' + new Date().toISOString(), 'utf8');
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
    if (e.code !== 'EEXIST') {
      // 写失败了：把刚创建的那一份收掉，别留成"自己不认得的孤儿锁"
      try { fs.unlinkSync(lockPath); } catch (e2) {}
      throw e;
    }
    return null;
  }
  if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
  const now = readLock(lockPath);
  if (now.token !== TOKEN) return null;     // 已被别人接管/重建
  return { ino: ino, token: TOKEN };
}

/* 只接管真的没人管的锁：持有进程已死；pid 读不出来且放置已超过 grace */
function takeoverIfStale(lockPath) {
  const cur = readLock(lockPath);
  if (cur.token === TOKEN) {
    /* 是我自己的 token，但我此刻没持锁 —— 只可能是上一次拿锁后写失败留下的孤儿，
     * 不清理的话本进程会一直等"自己"，等到超时报错。 */
    try { fs.unlinkSync(lockPath); } catch (e) {}
    return true;
  }
  if (cur.pid) {
    if (alive(cur.pid)) return false;
  } else {
    const a = ageMs(lockPath);
    if (a < 0 || a < 3000) return false;
  }
  try { fs.unlinkSync(lockPath); } catch (e) {}
  return true;
}

/* 放锁前先核对 token，确认这仍是自己那一份才删；
 * 只比 inode 会因为 inode 号被回收而误删别人的锁（见 tryTake 注释）。 */
function release(lockPath) {
  try {
    if (readLock(lockPath).token === TOKEN) fs.unlinkSync(lockPath);
  } catch (e) {}
}

function fail(lockPath, waited) {
  const e = new Error('等锁超时：' + lockPath);
  e.code = 'E_LOCK_TIMEOUT';
  e.waitedMs = waited;
  return e;
}

function withLock(file, fn, opts) {
  const o = opts || {};
  const waitMs = Math.max(0, Number(o.waitMs) || 3000);
  const lockPath = file + '.lock';
  const t0 = Date.now();
  let held = null;
  let tries = 0;
  for (;;) {
    held = tryTake(lockPath);
    if (held) break;
    if (takeoverIfStale(lockPath)) continue;
    if (Date.now() - t0 >= waitMs) throw fail(lockPath, Date.now() - t0);
    /* 退避要跟到达速度匹配：一上来就睡 10ms 以上，8 个进程抢一把小锁时
     * 每次交接都要多等十几毫秒，忙时直接等到超时（实测这样会丢写）。 */
    tries++;
    sleepSync(tries <= 20 ? 1 : (tries <= 100 ? 2 : Math.min(20, 4 + Math.floor(Math.random() * 8))));
  }
  try {
    return fn();
  } finally {
    release(lockPath);
  }
}

async function withLockAsync(file, fn, opts) {
  const o = opts || {};
  const waitMs = Math.max(0, Number(o.waitMs) || 3000);
  const lockPath = file + '.lock';
  const t0 = Date.now();
  let held = null;
  let tries = 0;
  for (;;) {
    held = tryTake(lockPath);
    if (held) break;
    if (takeoverIfStale(lockPath)) continue;
    if (Date.now() - t0 >= waitMs) throw fail(lockPath, Date.now() - t0);
    tries++;
    await new Promise(r => setTimeout(r, tries <= 20 ? 1 : (tries <= 100 ? 2 : Math.min(24, 4 + Math.floor(Math.random() * 10)))));
  }
  try {
    return await fn();
  } finally {
    release(lockPath);
  }
}

module.exports = { withLock, withLockAsync, sleepSync, alive };
