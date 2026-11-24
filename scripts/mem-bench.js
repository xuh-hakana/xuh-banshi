#!/usr/bin/env node
// 图片进请求体的内存基准：mode=old 每次重试都重新读文件+base64；mode=new 按 md5 编码一次复用。
// 用法：node scripts/mem-bench.js [old|new] [图片数] [每张MB]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const mode = process.argv[2] || 'old';
const n = Number(process.argv[3] || 6);
const mb = Number(process.argv[4] || 3);
const RETRIES = 6; // 与 reply-retry 的六段一致

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbench-'));
const files = [];
for (let i = 0; i < n; i++) {
  const f = path.join(dir, 'p' + i + '.jpg');
  fs.writeFileSync(f, crypto.randomBytes(mb * 1024 * 1024));
  files.push(f);
}

const cache = new Map();
function md5(f) {
  return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
}
function uriOld(f) {
  return 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
}
function uriNew(f) {
  const key = md5(f);
  let s = cache.get(key);
  if (!s) {
    s = 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
    cache.set(key, s);
  }
  return s;
}

const t0 = Date.now();
let body = '';
for (let r = 0; r < RETRIES; r++) {
  const msgs = [{ role: 'system', content: 'bench' }, { role: 'user', content: [] }];
  for (const f of files) {
    msgs[1].content.push({ type: 'image_url', image_url: { url: mode === 'old' ? uriOld(f) : uriNew(f) } });
  }
  msgs.push({ role: 'system', content: 'retry ' + r });
  body = JSON.stringify(msgs);
}
const elapsed = Date.now() - t0;
const mu = process.memoryUsage();
console.log(JSON.stringify({
  mode, images: n, sizeMB: mb, retries: RETRIES,
  rssMB: Math.round(mu.rss / 1048576),
  heapMB: Math.round(mu.heapUsed / 1048576),
  bodyMB: Math.round(body.length / 1048576),
  elapsedMs: elapsed,
}));
fs.rmSync(dir, { recursive: true, force: true });
