/*
 * test-call-names.js — 喊人的名字只能用「本群名片 + 其他平台昵称 + 真名 + 主的叫法」
 *
 * 背景（2026-11-22 她报）：「虚幻群里喊了我另一个群的名牌」——同一个人有几个号、每个号
 * 有一堆群名片，以前全被当成「按喊的顺序」喂给模型，随便挑一张就串群了。
 * 她定的规矩：能喊得别人设置的昵称只有**本群**和**其他平台账号**；
 * 当前平台的多账号、其他群名片**只能拿来认人**。
 *
 * 这个测试把 people.js 和一份假数据搬进临时目录跑，**绝不碰真实 src/data**。
 * 跑法：node tests/test-call-names.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-call-names-'));
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
for (const f of ['people.js', 'wlog.js']) fs.copyFileSync(path.join(SRC, f), path.join(TMP, f));

const PERSON = {
  p_test: {
    name: '真名',
    masterCall: '大萌新',
    favor: 10,
    at: 1700000000000,
    accounts: [
      { platform: 'qq', id: '111', nick: '一号资料卡', cards: { G1: '一群名片', G2: '二群名片' } },
      { platform: 'qq', id: '222', nick: '小号昵称', cards: { G1: '小号一群名片' } },
      { platform: 'bili', id: '999', nick: 'B站昵称' },
    ],
    review: { nameHistory: [] },
  },
};
fs.writeFileSync(path.join(TMP, 'data', 'people.json'), JSON.stringify(PERSON));

const P = require(path.join(TMP, 'people.js'));
const PID = 'p_test';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
const names = (gid, aid) => P.nameEntriesOf(PID, { gid: gid, platform: 'qq', aid: aid });
const callable = (gid, aid) => names(gid, aid).filter(e => e.callable).map(e => e.name);
const onlyRec = (gid, aid) => names(gid, aid).filter(e => !e.callable).map(e => e.name);

console.log('① 群 G1：只喊本群名片，别群名片 / 同平台小号只认人');
{
  const c = callable('G1', '111');
  ok('可喊里有一群名片', c.indexOf('一群名片') >= 0, c.join(' | '));
  ok('可喊里有真名 / 主人的叫法 / B站昵称',
    c.indexOf('真名') >= 0 && c.indexOf('大萌新') >= 0 && c.indexOf('B站昵称') >= 0, c.join(' | '));
  ok('可喊里没有二群名片', c.indexOf('二群名片') < 0, c.join(' | '));
  ok('可喊里没有同平台小号的昵称', c.indexOf('小号昵称') < 0, c.join(' | '));
  ok('只认里有一群名片以外的真实名字',
    onlyRec('G1', '111').indexOf('二群名片') >= 0 && onlyRec('G1', '111').indexOf('小号昵称') >= 0,
    onlyRec('G1', '111').join(' | '));
}

console.log('② 群 G2：可喊名跟着群换');
{
  const c = callable('G2', '111');
  ok('可喊里是二群名片', c.indexOf('二群名片') >= 0, c.join(' | '));
  ok('可喊里没有一群名片', c.indexOf('一群名片') < 0, c.join(' | '));
}

console.log('③ 私聊：用这个号自己的名字，不掺别的号');
{
  const c = callable('', '111');
  ok('可喊里有一号资料卡', c.indexOf('一号资料卡') >= 0, c.join(' | '));
  ok('可喊里没有小号昵称', c.indexOf('小号昵称') < 0, c.join(' | '));
  ok('可喊里没有群名片', c.indexOf('一群名片') < 0 && c.indexOf('二群名片') < 0, c.join(' | '));
}

console.log('④ 当前可见名只认当前这个号（不跨账号兜底）');
{
  ok('G1 + 号 111 → 一群名片', P.currentVisibleNameOf(PID, 'G1', 'qq', '111') === '一群名片');
  ok('G1 + 号 222 → 小号一群名片', P.currentVisibleNameOf(PID, 'G1', 'qq', '222') === '小号一群名片');
  ok('不给号 → 该平台主号的名片', P.currentVisibleNameOf(PID, 'G1', 'qq') === '一群名片');
  ok('G3（没名片）→ 主号自己的资料卡', P.currentVisibleNameOf(PID, 'G3', 'qq', '111') === '一号资料卡');
  ok('B站 → B站昵称', P.currentVisibleNameOf(PID, '', 'bili', '999') === 'B站昵称');
}

console.log('⑤ 认人名单仍然全（别群名片也得认得出）');
{
  const r = P.recognizeNamesOf(PID, 'G1', 'qq', '111');
  ok('认得二群名片', r.indexOf('二群名片') >= 0, r.join(' | '));
  ok('认得小号昵称', r.indexOf('小号昵称') >= 0, r.join(' | '));
  ok('认得一群名片', r.indexOf('一群名片') >= 0, r.join(' | '));
}

console.log('');
console.log((fail ? '❌ ' : '✅ ') + pass + ' 通过 / ' + fail + ' 失败（临时目录 ' + TMP + '）');
process.exit(fail ? 1 : 0);