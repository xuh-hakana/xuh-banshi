'use strict';
/* 图片 data URI 缓存：同一张图只 base64 一次，字符串复用。
 *
 * 为什么要它：以前每个调用点各自 fs.readFileSync(...).toString('base64') 再拼前缀，
 * 一次回复的六段重试就把同一批图编码六遍；base64 结果是 UTF-16 字符串，3MB 图 ≈ 8MB 内存，
 * 几张图叠起来就是几百 MB 的瞬时峰值。
 *
 * 这里只改「编码次数」和「复用」，输出的字符串与原来逐字节相同 —— 不发图、不改格式、不压尺寸。
 * 上限按总字节数算，超了就淘汰最老的，不会无限涨。
 */
const fs = require('fs');
const crypto = require('crypto');

const MAX_BYTES = 96 * 1024 * 1024; // 缓存总量上限
const TTL_MS = 10 * 60 * 1000;      // 10 分钟内复用
const cache = new Map();            // key(md5) -> { uri, bytes, at }
let totalBytes = 0;

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function evict() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > TTL_MS) { totalBytes -= v.bytes; cache.delete(k); }
  }
  while (totalBytes > MAX_BYTES && cache.size) {
    const [k, v] = cache.entries().next().value;
    totalBytes -= v.bytes;
    cache.delete(k);
  }
}

function memo(key, mime, make) {
  const hit = cache.get(key);
  if (hit) { hit.at = Date.now(); return hit.uri; }
  const uri = make();
  if (uri) {
    cache.set(key, { uri, bytes: uri.length * 2, at: Date.now() });
    totalBytes += uri.length * 2;
    evict();
  }
  return uri;
}

// Buffer → data URI（mime 省略时按 png，与原调用点一致）
function dataUriFromBuffer(buf, mime) {
  if (!buf || !buf.length) return '';
  const key = 'b:' + md5(buf) + ':' + (mime || 'image/png');
  return memo(key, mime, () => 'data:' + (mime || 'image/png') + ';base64,' + buf.toString('base64'));
}

// 文件 → data URI（key 用内容 md5：文件被覆盖也不会拿到旧串）
function dataUriFromFile(file, mime) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return ''; }
  return dataUriFromBuffer(buf, mime);
}

// 已经是 base64 的串 → data URI（切块/回包给的本来就是 base64，别先解码再编码）
function dataUriFromB64(b64, mime) {
  const s = String(b64 || '');
  if (!s) return '';
  const m = mime || 'image/png';
  const key = 's:' + md5(s) + ':' + m;
  return memo(key, m, () => 'data:' + m + ';base64,' + s);
}

// 文件 → 纯 base64（NapCat 的 base64:// 上传用）
function b64FromFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return ''; }
  const key = 'r:' + md5(buf);
  return memo(key, '', () => buf.toString('base64'));
}

function stats() {
  return { entries: cache.size, mb: Math.round(totalBytes / 1048576), maxMb: MAX_BYTES / 1048576 };
}

module.exports = { dataUriFromBuffer, dataUriFromFile, dataUriFromB64, b64FromFile, stats };
