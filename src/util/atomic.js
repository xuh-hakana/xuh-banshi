'use strict';
/* ===========================================================================
 * util/atomic.js —— 原子写（2026-11-25）
 *
 * 目的：任何「读-改-写」的状态文件，都不能出现半截内容，也不能两个进程写同一个
 * 临时文件名互相踩（老代码统一用 file + '.tmp'，两个写者会撞车）。
 *
 *   writeFileAtomic(file, text)   唯一临时名 (.tmp-<pid>-<rand>) → fsync → rename
 *   writeJsonAtomic(file, obj)    同上，JSON.stringify(obj, null, 2) + 换行
 *   readJsonSafe(file, dflt)      读不出来/坏了就回默认值，不抛
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

function _tmpName(file) {
  return file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
}

function writeFileAtomic(file, text, opts) {
  const o = opts || {};
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const tmp = _tmpName(file);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, String(text == null ? '' : text), 'utf8');
    try { fs.fsyncSync(fd); } catch (e) {}
    fs.closeSync(fd);
    fd = null;
    // Windows/网络盘偶尔 rename 撞一下，退避一次再试
    try { fs.renameSync(tmp, file); }
    catch (e) { if (o.retry === false) throw e; const t0 = Date.now() + 30; while (Date.now() < t0) {} fs.renameSync(tmp, file); }
    return { ok: true, file };
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch (e2) {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e3) {}
    return { ok: false, error: e.message };
  }
}

function writeJsonAtomic(file, obj, opts) {
  let text;
  try { text = JSON.stringify(obj, null, 2) + '\n'; }
  catch (e) { return { ok: false, error: '序列化失败：' + e.message }; }
  return writeFileAtomic(file, text, opts);
}

function readJsonSafe(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJsonSafe };
