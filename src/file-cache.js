'use strict';
/* 小 JSON/文本文件的读取缓存：同一个文件在 mtime + size 没变时直接给上次解析好的对象。
 *
 * 只解决「每条消息都 readFileSync + JSON.parse 一遍几 MB 的表」——文件改了就重新读，
 * 所以行为与直接读完全一致，只是重复读同一份内容时不再花 CPU 和临时内存。
 */
const fs = require('fs');

const cache = new Map(); // path -> { mtimeMs, size, value }
const MAX_ENTRIES = 200;

function statKey(file) {
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

function remember(file, key, value) {
  if (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(file, { ...key, value });
  return value;
}

// 读 JSON：解析失败照旧抛/交给调用方 catch，与原来一致
function readJson(file) {
  const key = statKey(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === key.mtimeMs && hit.size === key.size) return hit.value;
  return remember(file, key, JSON.parse(fs.readFileSync(file, 'utf8')));
}

function readText(file) {
  const key = statKey(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === key.mtimeMs && hit.size === key.size) return hit.value;
  return remember(file, key, fs.readFileSync(file, 'utf8'));
}

function clear() { cache.clear(); }

module.exports = { readJson, readText, clear };
