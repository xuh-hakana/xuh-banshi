'use strict';
/* ===========================================================================
 * tests/test-diag.js —— 报错上报的验收（2026-11-25）
 * 跑法：node tests/test-diag.js
 * 要成立的：① report() 真写进守望任务扫的那个日志文件
 *           ② wrap() 记一条后按兜底值继续（不再把进程带崩）
 *           ③ wrapAsync() 记一条再按原样抛（上层语义不变）
 *           ④ 进程级兜底钩子能把没人接的 Promise 拒绝也记下来
 * =========================================================================== */
const fs = require('fs');
const cp = require('child_process');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'src', 'diag', 'report.js');
const diag = require(REPORT);
const LOG = diag.LOG;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

const MARK = 'diagtest' + Date.now().toString(36);
function tail(n) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    return lines.slice(-n).join('\n');
  } catch (e) { return ''; }
}

console.log('[1] report 落盘');
const r = diag.report(MARK + '.basic', new Error('测试用的报错'), { k: 1 });
ok('report 返回成功', !!(r && r.ok === true), JSON.stringify(r));
ok('日志里有这一条', tail(6).indexOf(MARK + '.basic') >= 0, tail(6).slice(-160));
ok('日志格式和 AstrBot 一致', /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[ERRO\] \[/.test(tail(6)), tail(2).slice(-120));

console.log('[2] wrap 兜底');
const wrapped = diag.wrap(MARK + '.wrap', () => { throw new Error('内部炸了'); }, '兜底值');
ok('wrap 返回兜底值，不抛', wrapped() === '兜底值');
ok('wrap 记了线索', tail(4).indexOf(MARK + '.wrap') >= 0, tail(4).slice(-120));

console.log('[3] wrapAsync 抛回');
(async () => {
  const wa = diag.wrapAsync(MARK + '.async', async () => { throw new Error('异步炸了'); });
  let threw = '';
  try { await wa(); } catch (e) { threw = e.message; }
  ok('wrapAsync 记完仍按原样抛', threw === '异步炸了', threw);
  ok('wrapAsync 记了线索', tail(4).indexOf(MARK + '.async') >= 0, tail(4).slice(-120));

  console.log('[4] 进程级兜底');
  const code = [
    'const d=require(' + JSON.stringify(REPORT) + ');',
    'd.installProcessHooks("' + MARK + 'child");',
    'Promise.reject(new Error("没人接的拒绝"));',
    'setTimeout(()=>{},200);',
  ].join('');
  const kid = cp.spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const t0 = Date.now();
  kid.on('exit', () => {
    setTimeout(() => {
      ok('unhandledRejection 被记下来', tail(8).indexOf(MARK + 'child.unhandledRejection') >= 0, '耗时 ' + (Date.now() - t0) + 'ms');
      console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
      process.exit(fail ? 1 : 0);
    }, 200);
  });
})();
