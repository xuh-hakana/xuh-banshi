'use strict';
/* ===========================================================================
 * tests/test-state.js —— 全局记忆 / 写锁层的验收（2026-11-25）
 * 跑法：node tests/test-state.js
 * 四个必须成立的：①实体单例 ②多进程并发不丢写 ③等锁不烧 CPU ④杀掉进程不写坏文件
 * =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const STORE = path.join(SRC, 'state', 'store.js');
const LOCK = path.join(SRC, 'state', 'lock.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xuhbot-state-'));

/* ① 单例：同一个名字拿两次必须是同一个对象；同名换路径必须报错 */
(function t1() {
  console.log('[1] 实体单例');
  const store = require(STORE);
  const a = store.open('t.single', { file: path.join(tmp, 'single.json') });
  const b = store.open('t.single', { file: path.join(tmp, 'single.json') });
  ok('同名同路径返回同一实例', a === b);
  let conflict = '';
  try { store.open('t.single', { file: path.join(tmp, 'other.json') }); } catch (e) { conflict = e.code || ''; }
  ok('同名不同路径抛 STORE_CONFLICT', conflict === 'STORE_CONFLICT', conflict);
  a.replace({ n: 1 });
  ok('落盘可读回', b.read().n === 1);
})();

/* ② 8 个进程各加 200 次，最终必须正好 1600 —— 丢一次就说明锁没起作用 */
(function t2() {
  console.log('[2] 多进程并发 +1600');
  const file = path.join(tmp, 'counter.json');
  fs.writeFileSync(file, JSON.stringify({ n: 0 }), 'utf8');
  const code = [
    'const s=require(' + JSON.stringify(STORE) + ');',
    'const e=s.open("t.counter",{file:process.argv[1]});',
    'for(let i=0;i<200;i++) e.mutate(x=>{x.n=(x.n||0)+1;return x;});',
  ].join('');
  const kids = [];
  for (let i = 0; i < 8; i++) {
    kids.push(cp.spawn(process.execPath, ['-e', code, file], { stdio: 'ignore' }));
  }
  const t0 = Date.now();
  let done = 0;
  Promise.all(kids.map(k => new Promise(r => k.on('exit', r)))).then(() => {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')).n;
    ok('8x200 后计数为 1600', n === 1600, '实际 ' + n + '，耗时 ' + (Date.now() - t0) + 'ms');
    ok('没有残留 .lock', !fs.existsSync(file + '.lock'));
    t3();
  });
  void done;
})();

/* ③ 别人持锁 300ms，自己等锁期间不能空转烧 CPU（v1 的忙等就是这里烧的） */
function t3() {
  console.log('[3] 等锁不烧 CPU');
  const { withLock } = require(LOCK);
  const file = path.join(tmp, 'cpu.txt');
  fs.writeFileSync(file, 'x', 'utf8');
  const holder = cp.spawn(process.execPath, ['-e', [
    'const {withLock}=require(' + JSON.stringify(LOCK) + ');',
    'withLock(process.argv[1],()=>{const t=Date.now();while(Date.now()-t<300);},{});',
  ].join(''), file], { stdio: 'ignore' });
  // 等子进程真的把锁拿上再开始计时（spawn 有启动延迟，早测就白等）
  const spin0 = Date.now();
  while (!fs.existsSync(file + '.lock') && Date.now() - spin0 < 3000) {
    try { require(LOCK).sleepSync(10); } catch (e) {}
  }
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  let waited = 0;
  try {
    withLock(file, () => { waited = Date.now() - t0; }, { waitMs: 5000 });
  } catch (e) { console.log('  等锁异常：' + e.message); }
  const used = process.cpuUsage(cpu0);
  const ms = (used.user + used.system) / 1000;
  ok('真的等到了 300ms 以上', waited >= 250, 'waited=' + waited);
  ok('等待期 CPU 占用 < 50ms', ms < 50, 'cpu=' + ms.toFixed(1) + 'ms');
  holder.kill('SIGKILL');
  t4();
}

/* ④ 写入过程中被 kill -9，文件必须还是完整 JSON（tmp+rename 保证） */
function t4() {
  console.log('[4] 写一半被杀不损坏文件');
  const file = path.join(tmp, 'atomic.json');
  const big = 'x'.repeat(200000);
  fs.writeFileSync(file, JSON.stringify({ v: 0 }), 'utf8');
  const code = [
    'const s=require(' + JSON.stringify(STORE) + ');',
    'const e=s.open("t.atomic",{file:process.argv[1]});',
    'let i=0;for(;;){e.replace({v:++i,pad:process.argv[2]});}',
  ].join('');
  const kid = cp.spawn(process.execPath, ['-e', code, file, big], { stdio: 'ignore' });
  setTimeout(() => {
    kid.kill('SIGKILL');
    setTimeout(() => {
      let parsed = null, err = '';
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err = e.message; }
      ok('文件仍是完整 JSON', parsed && typeof parsed.v === 'number', err);
      const leftovers = fs.readdirSync(tmp).filter(f => f.indexOf('atomic.json.tmp-') === 0);
      ok('没有残留 tmp（被杀那一次最多一个）', leftovers.length <= 1, leftovers.join(','));
      console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      process.exit(fail ? 1 : 0);
    }, 150);
  }, 400);
}
