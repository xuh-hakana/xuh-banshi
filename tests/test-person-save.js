/*
 * test-person-save.js — 面板存人（名字 / 地区）必须真落盘
 *
 * 背景（2026-11-22）：她报「面板改名字、地区等内容全都不保存」。
 * 查出来一类静默失败：接口回 {ok:true}，people.json 一个字没动。
 * 这个测试把三个模块（people / region / wlog）和一份数据复制到临时目录跑，
 * **绝不碰真实 src/data**，专门守住这几条：
 *   ① 面板手动改（byUser / mode:'user'）必须写进文件；
 *   ② 同步档（sync）改已有名字必须被拒，而且能拿到人话原因（以前只有 false）；
 *   ③ 写盘失败/不存在的人要能报错，不许悄悄造人；
 *   ④ 地区表按人物写、读回一致，清空真的是清空；
 *   ⑤ 同一秒里连写两次，后一次不能丢（/Volumes 外置卷 mtime 粗粒度）。
 *
 * 跑法：node tests/test-person-save.js（npm test 末尾会跑）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-person-save-'));

function copyIn(rel, destRel) {
  const from = path.join(SRC, rel);
  const to = path.join(TMP, destRel === undefined ? rel : destRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
}

// 三个模块 + 它们要的数据，全搬进临时目录（people.js 按 __dirname/data 找文件）
copyIn('people.js');
copyIn('region.js');
copyIn('wlog.js');
for (const f of ['people.json', 'favor.json', 'people-state.json', 'people-region.json']) {
  copyIn(path.join('data', f), path.join('data', f));
}

const people = require(path.join(TMP, 'people.js'));
const region = require(path.join(TMP, 'region.js'));
const FILE = path.join(TMP, 'data', 'people.json');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function readName(pid) {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8'))[pid].name || ''; } catch { return ''; }
}

const pids = Object.keys(people.load());
const pid = pids[0];
const qq = String(((people.get(pid) || {}).accounts || [])[0].id || '');
console.log('用例数据：' + pid + ' / qq ' + qq + '（临时目录 ' + TMP + '）');

// ① 面板手动改名字：必须落盘
{
  const want = '测试名字-面板' + Date.now();
  const r = people.setState(pid, { name: want }, { byUser: true });
  ok('① byUser 改名字返回 true', r === true, JSON.stringify(r));
  ok('① 名字真的写进 people.json', readName(pid) === want, readName(pid));
}

// ② 同步档改已有名字：必须被拒，且给出原因
{
  const before = readName(pid);
  const st = people.stateView();
  st[qq] = Object.assign({}, st[qq], { name: '测试名字-同步' });
  const r = people.writeStateView(st);              // 默认 sync
  ok('② 同步档改已有名字被拒', r === false, JSON.stringify(r));
  ok('② 文件没被改', readName(pid) === before, readName(pid));
  ok('② 拒了之后有人话原因', !!people.lastWriteError(), people.lastWriteError());
}

// ③ 面板档（user）走同一个 QQ 入口：必须成功
{
  const want = '测试名字-面板QQ' + Date.now();
  const st = people.stateView();
  st[qq] = Object.assign({}, st[qq], { name: want });
  const r = people.writeStateView(st, { mode: 'user' });
  ok('③ mode:user 改已有名字成功', r === true, JSON.stringify(r));
  ok('③ 名字真的写进 people.json', readName(pid) === want, readName(pid));
}

// ④ 不存在的人 / 陌生 QQ：不许造人
{
  const beforeCount = Object.keys(people.load()).length;
  const r = people.setState('p_不存在的人', { name: '幽灵' }, { byUser: true });
  ok('④ 不存在的人物改名字返回失败', r === false, JSON.stringify(r));
  ok('④ 陌生 QQ 查不到人', !people.findByAccount('qq', '99999999999'));
  ok('④ 没有凭空多出人物', Object.keys(people.load()).length === beforeCount);
}

// ⑤ 地区表：写 / 读回 / 清空
{
  const city = '西安市 未央区';
  const w = region.setRegion(pid, city);
  ok('⑤ 写地区返回 changed', !!(w && w.changed), JSON.stringify(w));
  ok('⑤ 读回一致', region.getRegion(pid) === city, region.getRegion(pid));
  const c = region.clearRegion(pid);
  ok('⑤ 清空地区', c === true && region.getRegion(pid) === '', String(c) + '/' + region.getRegion(pid));
}

// ⑥ 同一秒连写两次：后一次不能丢
{
  const a = '测试名字-连写A' + Date.now();
  const b = '测试名字-连写B' + Date.now();
  people.setState(pid, { name: a }, { byUser: true });
  people.setState(pid, { name: b }, { byUser: true });
  const got = readName(pid);
  ok('⑥ 同秒连写后是最后一次的值', got === b, got);
}

// 收尾：临时目录删掉
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + (fail ? '失败 ' + fail + ' 条' : '全部通过') + '（通过 ' + pass + ' 条）');
process.exit(fail ? 1 : 0);
