/*
 * tests/test-panel-sync.js — 面板与虚幻「同一份数据」自测（主人 2026-11-21 令）
 *
 * 运行：node tests/test-panel-sync.js
 *
 * 背景：主人实测发现「虚幻认错人 / 漏登记群，面板却是对的」，
 * 根因不是数据存了两份文件，而是**同一个数据被两套读法读**：
 *   · 认人：虚幻读 config.people（早没人写，永远 {}）→ 掉回 QQ 昵称；
 *           面板读 people.json 的人物名 → 两边不一致。
 *   · 群名片：正本在 people.json 的 accounts[].cards，面板读的却是人物级 p.cards（不存在）→ 永远 0 张。
 * 这个测试钉住三件事，以后谁再另起一套读法就会红：
 *   ① 面板 readPeople 的 cards == people.json 账号级 cards 的合并
 *   ② 面板 label / 虚幻 personNameOf 都等于人物表里的名字
 *   ③ 面板聊天记录里的「主人」判定认的是人物表（主号 pid），不是配置里的名字串
 */
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src', 'people'));
const core = require(path.join(ROOT, 'src', 'core'));
const panel = require(path.join(ROOT, 'src', 'server', 'panel'));

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
}

const all = P.load();
const pids = Object.keys(all);

console.log('① 群名片：面板读的 == people.json 账号级正本');
const peopleList = panel.readPeople().list;
const byPid = Object.fromEntries(peopleList.map(x => [x.pid, x]));
let checked = 0;
for (const pid of pids) {
  const p = all[pid];
  const want = {};
  for (const a of (p.accounts || [])) {
    const cs = (a && a.cards) || {};
    for (const g of Object.keys(cs)) if (cs[g] && !want[g]) want[g] = cs[g];
  }
  const got = (byPid[pid] && byPid[pid].cards) || {};
  ok('人 ' + pid + ' 的群名片同步', () => assert.deepStrictEqual(got, want));
  checked++;
  if (checked >= 8 && Object.keys(want).length === 0) break;   // 抽查够 8 个、且覆盖无卡的人
}

console.log('② 名字：面板 label 与虚幻 personNameOf 同源');
let named = 0;
for (const pid of pids) {
  const p = all[pid] || {};
  const name = String(p.name || '').trim();
  if (!name) continue;
  const qq = (p.accounts || []).find(a => P.normPlat(a.platform) === 'qq');
  if (!qq) continue;
  ok('人 ' + pid + ' 两边都叫「' + name + '」', () => {
    assert.strictEqual(core.personNameOf(String(qq.id), 'QQ昵称兜底'), name);
    const row = byPid[pid];
    assert.ok(row, '面板里找不到这个人');
    assert.strictEqual(row.label, name);
    assert.strictEqual(row.name, name);
  });
  named++;
  if (named >= 5) break;
}

console.log('③ 认人：面板按人物表认主人，不按名字串');
{
  const cfg = require(path.join(ROOT, 'src', 'config')).load();
  const masterPid = P.findByAccount('qq', cfg.masterQQ);
  const mrow = masterPid ? P.get(masterPid) : null;
  ok('主号在人物表里有档案', () => assert.ok(mrow, '主号没有 people.json 档案'));
  const card = mrow && (mrow.accounts || []).map(a => (a.cards || {})).map(c => Object.values(c)).flat().filter(Boolean)[0];
  const idx = panel.chatNameIndex();
  if (card) {
    const line = '2026-11-21T15:16:08.072Z [qq][群100000000][' + card + '] 测试一句';
    const r = panel.parseChatLine(line, idx, '虚幻', '主人', null);
    ok('「' + card + '」被认成主人（mine）', () => assert.strictEqual(r.e.mine, true));
  } else {
    console.log('  (主人还没有群名片，跳过)');
  }
  const line2 = '2026-11-21T15:16:08.072Z [qq][群100000000][那就是死了已被移出群聊] 测试一句';
  const r2 = panel.parseChatLine(line2, idx, '虚幻', '主人', null);
  ok('脏昵称「那就是死了已被移出群聊」也归主人（按 pid，不按名字）', () => assert.strictEqual(r2.e.mine, true));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
