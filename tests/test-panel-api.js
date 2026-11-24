'use strict';
/* ===========================================================================
 * tests/test-panel-api.js —— 面板「其他页读写」自检（2026-11-25）
 *
 * 两件事：
 *   A. 静态对账：客户端调的每个 /api 地址，服务端都得有对应分支（否则点了没反应）。
 *   B. 冒烟：对服务端所有 GET 接口发一次假请求，断言 200 + JSON 能解析（不碰写接口、不联网）。
 *
 * 用法：node tests/test-panel-api.js
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const P = path.join(ROOT, 'src', 'server', 'panel.js');
const C = path.join(ROOT, 'public', 'panel-client.js');
const srv = fs.readFileSync(P, 'utf8');
const cli = fs.readFileSync(C, 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(m) { pass++; }
function no(m, why) { fail++; bad.push(m + (why ? ' —— ' + why : '')); }

/* ---------- A. 静态对账 ---------- */
// 服务端声明的路由（按行抽 method + path；一个 page 里 GET/POST 混写，不能只看路径）
const srvExact = new Set();          // 任意 method
const srvPrefix = [];                // 任意 method 的前缀
const srvGet = new Set();            // GET 专用（冒烟只打这些）
const srvGetPrefix = [];
const reExact = /req\.url === '([^']+)'/g;
const rePre = /req\.url\.indexOf\('([^']+)'\)/g;
const reSt = /req\.url\.startsWith\('([^']+)'\)/g;
for (const line of srv.split('\n')) {
  if (line.indexOf('req.url') < 0) continue;
  const isGet = /req\.method === 'GET'/.test(line);
  const isPost = /req\.method === 'POST'/.test(line);
  let mm;
  reExact.lastIndex = 0;
  while ((mm = reExact.exec(line))) { srvExact.add(mm[1]); if (isGet) srvGet.add(mm[1]); }
  rePre.lastIndex = 0;
  while ((mm = rePre.exec(line))) { if (!srvPrefix.includes(mm[1])) srvPrefix.push(mm[1]); if (isGet && !srvGetPrefix.includes(mm[1])) srvGetPrefix.push(mm[1]); }
  reSt.lastIndex = 0;
  while ((mm = reSt.exec(line))) { if (!srvPrefix.includes(mm[1])) srvPrefix.push(mm[1]); if (isGet && !srvGetPrefix.includes(mm[1])) srvGetPrefix.push(mm[1]); }
}
let m;
function hasRoute(p0) {
  const u = p0.split('?')[0];
  if (srvExact.has(u) || srvExact.has(u + '?')) return true;
  // 服务端统一在入口裁过 ?query，所以带参数的路由按去参数比；再做一次前缀比对
  for (const pre of srvPrefix) {
    if (pre === '?') continue;
    if (u.startsWith(pre.split('?')[0])) return true;
  }
  return false;
}
// 客户端调用的路由（api() = GET，POST() = POST）
const cliCalls = new Set();
const reApi = /\b(?:api|POST)\('(\/api[^']*)'/g;
while ((m = reApi.exec(cli))) cliCalls.add(m[1]);
const missing = [];
for (const u of cliCalls) if (!hasRoute(u)) missing.push(u);
if (!cliCalls.size) no('客户端一处 /api 调用都没抽到', '正则失效？');
else if (!missing.length) ok();
else no('客户端调了但服务端没写分支：' + missing.join(', '));
console.log('[panel-api] 客户端调用 ' + cliCalls.size + ' 个地址，缺失 ' + missing.length + ' 个');

/* ---------- B. GET 冒烟 ---------- */
const SKIP = [
  '/api/bili/', '/api/key', '/api/checkup', '/api/llmpool', '/api/judge', '/api/kb',
  '/api/chain', '/api/selfposts', '/api/review', '/api/chat/issue', '/api/diary-flow',
  '/api/emobook', '/api/memory', '/api/chat/live', '/api/stkimg', '/api/thinking/ask',
];
function skipped(u) { return SKIP.some(s => u.startsWith(s)); }
const getRoutes = [...srvGet].filter(u => u.startsWith('/api/'))
  .concat(srvGetPrefix.filter(u => u.startsWith('/api/')))
  .filter(u => u !== '?');
const uniq = [...new Set(getRoutes)].filter(u => !skipped(u));

const panel = require(P);

function call(method, url, bodyObj) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.destroy = () => {};
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const chunks = [];
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers || {}; },
      end(b) { chunks.push(b); resolve({ code: this.code || 200, type: (this.headers || {})['Content-Type'] || '', text: chunks.join('') }); },
    };
    Promise.resolve().then(() => {
      panel.handler(req, res);
      if (body) req.emit('data', body);
      req.emit('end');
    });
    setTimeout(() => resolve({ code: 0, type: '', text: 'TIMEOUT' }), 15000);
  });
}

(async () => {
  let checked = 0, broken = [];
  for (const u of uniq) {
    const r = await call('GET', u);
    checked++;
    if (r.code !== 200) { broken.push(u + ' → HTTP ' + r.code); continue; }
    if (r.type.indexOf('json') >= 0) {
      try { JSON.parse(r.text); } catch (e) { broken.push(u + ' → JSON 坏了：' + r.text.slice(0, 60)); }
    } else if (/<html|<!DOCTYPE/i.test(r.text) === false && r.text.slice(0, 40).indexOf('HTTP') === 0) {
      broken.push(u + ' → 非 JSON 也非页面：' + r.text.slice(0, 60));
    }
  }
  if (!broken.length) ok();
  else no('GET 冒烟有坏接口：' + broken.slice(0, 8).join(' ; '));
  console.log('[panel-api] GET 冒烟 ' + checked + ' 个（跳过 ' + (getRoutes.length - uniq.length) + ' 个联网/慢接口），坏 ' + broken.length + ' 个');

  console.log('');
  if (bad.length) bad.forEach(x => console.log('  ✗ ' + x));
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
