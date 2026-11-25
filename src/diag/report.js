'use strict';
/* ===========================================================================
 * diag/report.js —— 报错上报（2026-11-25）
 *
 * 为什么有它：有些环节出错时只在 console 打一行，进程一重启就没了，事后根本
 * 找不到源头（agent-link 失败、视觉识别失败、工具调用失败、面板写不进去…）。
 * 这里统一写进 ~/.astrbot/logs/xuhbot-error.log，格式和 AstrBot 日志一致，
 * tools/xuhuan-error-watch.py 会扫这个文件，守望任务就能看见。
 *
 * 约定：
 *   - 一律自吞异常：上报本身永远不许把主流程带崩。
 *   - 同一个 area 60 秒内只记一条，避免刷屏把日志写爆。
 *   - 行格式：[YYYY-MM-DD HH:MM:SS] [ERRO] [area] 消息
 *
 * 2026-11-25 加 wrap / wrapAsync / installProcessHooks：
 *   包一层就同时拥有"记一条 + 明确失败"，不用每个调用点手写 try/catch。
 *   进程级兜底钩子装一次，跑到一半没人接的 Promise 拒绝就不会再无声消失。
 * =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(os.homedir(), '.astrbot', 'logs', 'xuhbot-error.log');
const _last = new Map();
const GAP_MS = 60000;

function _ts(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function report(area, err, extra) {
  try {
    const a = String(area || 'unknown');
    const now = Date.now();
    if (now - Number(_last.get(a) || 0) < GAP_MS) return { ok: false, why: '限流中' };
    _last.set(a, now);
    const msg = err instanceof Error ? (err.message || String(err)) : String(err == null ? '' : err);
    let line = '[' + _ts(new Date()) + '] [ERRO] [' + a + '] ' + msg.replace(/\s+/g, ' ').slice(0, 400);
    const st = (err && err.stack) ? String(err.stack).split('\n')[1] : '';
    if (st) line += '\n  ' + st.trim().slice(0, 200);
    if (extra != null && extra !== '') line += '\n  ' + String(typeof extra === 'object' ? JSON.stringify(extra) : extra).slice(0, 300);
    try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch (e) {}
    fs.appendFileSync(LOG, line + '\n', 'utf8');
    return { ok: true, file: LOG };
  } catch (e) { return { ok: false, why: e.message }; }
}

/* wrap(area, fn, onErr)
 *   onErr 不给：记一条再往上抛（上层还有 catch 时行为不变，只是多了一条线索）
 *   onErr 是函数：它的返回值当兜底值（就地吞掉，进程不崩）
 *   onErr 是别的值：直接当兜底返回值 */
function wrap(area, fn, onErr) {
  return function wrapped() {
    try {
      return fn.apply(this, arguments);
    } catch (e) {
      report(area, e);
      if (typeof onErr === 'function') { try { return onErr.apply(this, arguments); } catch (e2) { report(area + '.fallback', e2); return undefined; } }
      if (onErr !== undefined) return onErr;
      throw e;
    }
  };
}

function wrapAsync(area, fn, onErr) {
  return async function wrappedAsync() {
    try {
      return await fn.apply(this, arguments);
    } catch (e) {
      report(area, e);
      if (typeof onErr === 'function') { try { return await onErr.apply(this, arguments); } catch (e2) { report(area + '.fallback', e2); return undefined; } }
      if (onErr !== undefined) return onErr;
      throw e;
    }
  };
}

/* 进程级兜底：装一次就够，重复装会自动跳过。
 * 以前某个 Promise 拒绝没人接、或某处同步抛出没人 catch，Node 直接打一行就退出/继续跑，
 * 事后既看不到现场也不知道是哪来的——现在统一落到错误日志里。 */
let _hooksOn = false;
function installProcessHooks(tag) {
  if (_hooksOn) return false;
  _hooksOn = true;
  const t = String(tag || 'process');
  process.on('unhandledRejection', (e) => {
    report(t + '.unhandledRejection', e instanceof Error ? e : new Error(String(e)));
  });
  process.on('uncaughtException', (e) => {
    report(t + '.uncaughtException', e instanceof Error ? e : new Error(String(e)));
  });
  return true;
}

module.exports = { report, wrap, wrapAsync, installProcessHooks, LOG };
