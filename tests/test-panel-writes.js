'use strict';
/* ===========================================================================
 * tests/test-panel-writes.js —— 面板写入口护栏的验收（2026-11-25）
 * 跑法：node tests/test-panel-writes.js
 * 要成立的：① /api/ 只认 GET/POST，其它方法 405 且带 Allow
 *           ② body 不是合法 JSON 时 400，不再静默当 {} 假装成功
 *           ③ GET /api/diag/stores 能列出共享可写状态的真实计数
 *           ④ 正常 JSON 请求仍然 200 且返回合法 JSON
 * 测试起一个独立端口的面板进程（18899），不碰正在跑的 8899。
 * =========================================================================== */
const cp = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.TEST_PANEL_PORT || 18899);
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

function req(method, url, body, ctype) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method: method, headers: ctype ? { 'Content-Type': ctype, 'Content-Length': Buffer.byteLength(body || '') } : {} }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: '', error: e.message }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ code: 0, body: '', error: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

const child = cp.spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'panel.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PANEL_PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', c => { boot += String(c); });
child.stderr.on('data', c => { boot += String(c); });

function waitUp(n) {
  return req('GET', '/api/diag/stores').then((r) => {
    if (r.code) return r;
    if (n <= 0) throw new Error('面板没起来：' + boot.slice(0, 300));
    return new Promise(res => setTimeout(res, 250)).then(() => waitUp(n - 1));
  });
}

waitUp(60).then(async (first) => {
  console.log('[1] /api/diag/stores');
  ok('状态口返回 200', first.code === 200, 'code=' + first.code);
  let j = null;
  try { j = JSON.parse(first.body); } catch (e) {}
  ok('返回合法 JSON 且 ok=true', !!(j && j.ok === true), first.body.slice(0, 120));
  ok('列出了共享实体', !!(j && Array.isArray(j.stores) && j.stores.length > 0), j && j.stores ? j.stores.map(s => s.name).join(',') : '');
  const mem = j && j.stores ? j.stores.find(s => s.name === 'memory.long') : null;
  ok('记忆正本是登记在册的实体', !!mem && mem.mode === 'text', mem ? JSON.stringify(mem).slice(0, 120) : '');

  console.log('[2] 方法护栏');
  const put = await req('PUT', '/api/cat', '{}', 'application/json');
  ok('PUT /api/* 返回 405', put.code === 405, 'code=' + put.code);
  ok('405 带 Allow: GET, POST', String(put.headers && put.headers.allow || '') === 'GET, POST', String(put.headers && put.headers.allow));
  const del = await req('DELETE', '/api/cat', '', '');
  ok('DELETE /api/* 返回 405', del.code === 405, 'code=' + del.code);

  console.log('[3] body 校验');
  const bad = await req('POST', '/api/cat', '{not json', 'application/json');
  ok('坏 JSON 返回 400', bad.code === 400, 'code=' + bad.code);
  let bj = null;
  try { bj = JSON.parse(bad.body); } catch (e) {}
  ok('400 也是合法 JSON 且说明原因', !!(bj && bj.ok === false && /JSON/.test(bj.error)), bad.body.slice(0, 120));

  console.log('[4] 正常写入路径仍通');
  const okr = await req('POST', '/api/panel/send', JSON.stringify({ text: '' }), 'application/json');
  ok('正常 JSON 请求返回 200', okr.code === 200, 'code=' + okr.code);
  let oj = null;
  try { oj = JSON.parse(okr.body); } catch (e) {}
  ok('正常路径返回合法 JSON', !!oj, okr.body.slice(0, 120));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  try { child.kill('SIGKILL'); } catch (e) {}
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('  FAIL 测试没跑完：' + e.message);
  try { child.kill('SIGKILL'); } catch (e2) {}
  process.exit(1);
});
