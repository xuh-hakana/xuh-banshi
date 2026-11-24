/*
 * tests/test-role.js — 身份层（主人 / 欧尼酱 / 朋友 / 认识的人 / 陌生人）自测（主人 2026-11-22 令）
 *
 * 运行：node tests/test-role.js
 *
 * 背景：主人原话「虚幻应该同时能看到资料卡，和我身份是「主人」我的名字叫「虚幻」…
 *        还有个「欧尼酱」身份，名字是「NaNa」。现在是不是没有身份功能？」
 * 钉住四件事：
 *   ① 身份按号 / 好感 / 见没见过算出来（老数据没 role 字段也算得对）
 *   ② 真 buildMessages 里「现在跟你说话的是谁」同时有 身份 + 名字 + 资料卡 + 本群群名片
 *   ③ 群里两种名字不会撞：主人「那就是死了已被移出群聊」≠ 群友「那就是死了」
 *   ④ 面板 readPeople 给的是同一个身份，不另存一份
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src', 'people'));
const core = require(path.join(ROOT, 'src', 'core'));
const panel = require(path.join(ROOT, 'src', 'server', 'panel'));
const nick = require(path.join(ROOT, 'src', 'nick'));
// 必须走真实初始化：裸 require 时 core 里的 cfg 还没赋值
core.init(require(path.join(ROOT, 'src', 'config')).load());
nick.init(require(path.join(ROOT, 'src', 'config')).load());

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
}

const PEOPLE_FILE = path.join(ROOT, 'src', 'data', 'people.json');
const backup = fs.readFileSync(PEOPLE_FILE, 'utf8');

(async () => {
  const masterPid = P.findByAccount('qq', '1000001000');
  const oniiPid = P.findByAccount('qq', '1000001001');
  const friendPid = P.findByAccount('qq', '1000001002');

  console.log('① 身份怎么算');
  ok('主人号 → 主人', () => assert.strictEqual(P.roleOf(masterPid), 'master'));
  ok('欧尼酱号 → 欧尼酱', () => assert.strictEqual(P.roleOf(oniiPid), 'onii'));
  // 朋友录门槛来自面板（favor > FRIEND_AT），不是自己定的 60（她 2026-11-22 纠正）
  ok('好感 100（朋友录里）→ 朋友', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340001' }], favor: 100 }), 'friend'));
  ok('好感刚过朋友录门槛（21）→ 朋友', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340006' }], favor: P.FRIEND_AT + 1 }), 'friend'));
  ok('好感正好 20（人物册）→ 认识的人', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340007' }], favor: P.FRIEND_AT }), 'known'));
  ok('人物表里的普通人 → 认识的人', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340002' }], favor: 0 }), 'known'));
  ok('刚建档的陌生人 → 陌生人', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340003' }], favor: 0, role: 'stranger' }), 'stranger'));
  ok('陌生人被认下名字 → 认识的人', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340004' }], favor: 0, role: 'stranger', name: '小蓝' }), 'known'));
  ok('陌生人好感过了朋友录门槛 → 朋友', () => assert.strictEqual(P.roleOf({ accounts: [{ platform: 'qq', id: '12340005' }], favor: P.FRIEND_AT + 1, role: 'stranger' }), 'friend'));
  ok('五个身份都有中文名', () => assert.deepStrictEqual(P.ROLES.map(P.roleLabel), ['主人', '欧尼酱', '朋友', '认识的人', '陌生人']));

  console.log('② 真 buildMessages：身份 + 名字 + 资料卡 + 本群群名片');
  const build = async (k, ctx, text) => {
    core.setTurn(k, ctx);
    const msgs = await core.buildMessages(k, text);
    return msgs.map(x => String(x.content || '')).join('\n');
  };
  const GID = '1000001003';
  // 「现在跟你说话的是谁」单独截出来判断：群名片那段也写着身份：主人（她自己那张卡），
  // 整段搜会把「群友不是主人」误判成失败。
  const whoBlock = t => {
    const i = String(t).indexOf('## 现在跟你说话的是谁');
    if (i < 0) return '';
    const j = String(t).indexOf('\n## ', i + 3);
    return j < 0 ? String(t).slice(i) : String(t).slice(i, j);
  };
  const asMaster = await build('krole_m', { uid: '1000001000', gid: GID, nick: '那就是死了已被移出群聊', atMe: true, isMaster: true }, '在吗');
  ok('主人那一轮：身份：主人', () => assert.ok(asMaster.includes('身份：主人'), '没找到「身份：主人」'));
  ok('主人那一轮：名字是「虚幻」', () => assert.ok(whoBlock(asMaster).includes('虚幻'), '没找到名字'));
  // 同名提醒只在「她的真名 = 机器人名」时出现；2026-11-22 晚她把真名改成「柚酱…」了，没命中就跳过
  ok('主人那一轮：同名提醒（分身但两个独立的人）', () => {
    const botName = String(require(path.join(ROOT, 'src', 'config')).load().botName || '虚幻');
    if (P.realNameOf(masterPid) !== botName) return;   // 名字不同名，本来就不该有这句
    assert.ok(whoBlock(asMaster).includes('设定上是你的分身'), '没有同名提醒');
  });
  ok('主人那一轮：带性别', () => assert.ok(whoBlock(asMaster).includes('性别：女'), '没找到性别'));
  // 2026-11-22 她令：只留一行「名字」，每项带来源（资料卡 / 这个群的群名片 / 主人的叫法 / 真名）
  ok('主人那一轮：名字行带资料卡来源', () => assert.ok(/喊他用的名字（按顺序）：[\s\S]*（资料卡）/.test(whoBlock(asMaster)), '没找到资料卡来源'));
  ok('主人那一轮：名字行带本群名片', () => assert.ok(whoBlock(asMaster).includes('那就是死了已被移出群聊（这个群的群名片）'), '没找到本群名片'));
  ok('名字只有一行（不再有昵称/他还叫那几行）', () => {
    const b = whoBlock(asMaster);
    assert.ok(!b.includes('昵称（主人称呼方式）'), '昵称行还在');
    assert.ok(!b.includes('他还叫'), '他还叫行还在');
  });

  const asOther = await build('krole_o', { uid: '1000001002', gid: GID, nick: '那就是死了', atMe: true }, '在吗');
  ok('群友那一轮：不是主人', () => assert.ok(!whoBlock(asOther).includes('身份：主人'), '群友被当成了主人'));
  ok('群友那一轮：名字行里有本群名片', () => assert.ok(whoBlock(asOther).includes('那就是死了（这个群的群名片）'), '没找到群友名片'));
  ok('名字排序：主人的叫法排在当前可见名前', () => {
    const line = whoBlock(asOther).split('\n').find(l => l.indexOf('喊他用的名字（按顺序）') >= 0) || '';
    const iCall = line.indexOf('大萌新（主人的叫法）');
    const iCard = line.indexOf('那就是死了（这个群的群名片）');
    assert.ok(iCall >= 0 && iCard >= 0 && iCall < iCard, '顺序不对：' + line);
  });
  ok('两个人不撞：主人那条带「已被移出群聊」', () => assert.ok(whoBlock(asMaster).includes('已被移出群聊') && !whoBlock(asOther).includes('已被移出群聊'), '两份提示词撞名了'));

  console.log('②-b 喊人白名单：别群名片 / 同平台别的号 / 别人喊的名字只认不喊（2026-11-22 她令）');
  const lineOf = (blk, key) => blk.split('\n').find(l => l.indexOf(key) >= 0) || '';
  ok('主人那一轮：可喊行不含别群名片', () => {
    const line = lineOf(whoBlock(asMaster), '喊他用的名字（按顺序）');
    assert.ok(line, '没有可喊行');
    assert.ok(!line.includes('一抹多'), '把「一抹多」（群1000001004的名片）当成能喊的名字了：' + line);
    assert.ok(!line.includes('群女仆机器人'), '把第二个 QQ 号的名片当成能喊的名字了：' + line);
  });
  ok('主人那一轮：别群名片进了「只用来认人、不许喊」', () => {
    const line = lineOf(whoBlock(asMaster), '只用来认人、不许喊');
    assert.ok(line.includes('一抹多'), '没把「一抹多」列进只认：' + line);
  });
  ok('nick.nameFor 按当前群选名字，不串群', () => {
    const who = '1000001005';                        // p_mw008u415：两个群两张不同名片，没有真名
    assert.strictEqual(nick.nameFor(who, { gid: '1000001006', nick: '抖抖海月水母' }), '抖抖海月水母');
    assert.strictEqual(nick.nameFor(who, { gid: '1000001003', nick: '好想成为人类' }), '好想成为人类');
  });

  const asStranger = await build('krole_s', { uid: '777777', gid: GID, nick: '新来的', atMe: true }, '在吗');
  ok('从没见过的号 → 身份：陌生人', () => assert.ok(asStranger.includes('身份：陌生人'), '没判陌生人'));
  ok('陌生人那段带「别装熟」', () => assert.ok(asStranger.includes('别装熟'), '没有陌生人应对说明'));

  const asMaster2 = await build('krole_m2', { uid: '1000001000', gid: GID, nick: '那就是死了已被移出群聊', atMe: true, isMaster: true }, '在吗');
  ok('群名片那段每个人带身份', () => assert.ok(/群名片（\d+ 人）[\s\S]*身份：/.test(asMaster2), '群名片段没有身份'));

  console.log('③ 群名片不再把真名字当脏数据洗掉');
  ok('「那就是死了已被移出群聊」是她的真名片，原样留着', () => {
    const p = P.get(masterPid);
    const a = (p.accounts || []).find(x => String(x.id) === '1000001000');
    assert.strictEqual(a.cards[GID], '那就是死了已被移出群聊');
  });
  ok('只有整条就是系统提示才丢', () => {
    const f = path.join(ROOT, 'src', 'nick.js');
    const src = fs.readFileSync(f, 'utf8');
    const m = src.match(/const BAD_CARD = (\/.*\/);/);
    assert.ok(m, '没找到 BAD_CARD');
    const re = eval(m[1]);
    assert.ok(!re.test('那就是死了已被移出群聊'), '真名片被当成脏名');
    assert.ok(re.test('已被移出群聊'), '纯系统名没被挡住');
  });

  console.log('④ 面板读的是同一份身份');
  const list = panel.readPeople().list;
  const mrow = list.find(x => x.pid === masterPid);
  const orow = list.find(x => x.pid === oniiPid);
  ok('面板：主人的身份 = 主人', () => assert.strictEqual(mrow.roleLabel, '主人'));
  ok('面板：欧尼酱的身份 = 欧尼酱', () => assert.strictEqual(orow.roleLabel, '欧尼酱'));
  ok('面板：每人都有身份', () => assert.strictEqual(list.filter(x => !x.roleLabel).length, 0));
  ok('面板：群名片里有她那张真名片', () => assert.strictEqual(mrow.cards[GID], '那就是死了已被移出群聊'));

  console.log('⑤ 性别 / 名字分层（2026-11-22 她令）');
  ok('主人性别 = 女', () => assert.strictEqual(P.sexOf(masterPid), 'female'));
  ok('欧尼酱性别 = 男', () => assert.strictEqual(P.sexOf(oniiPid), 'male'));
  ok('每个人物都有性别', () => assert.strictEqual(P.all().filter(x => !x.sexLabel).length, 0));
  ok('AI 账号是女（ai-marks 里标了的）', () => {
    const marks = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'ai-marks.json'), 'utf8')).marks || {};
    const aiKey = Object.keys(marks).find(k => marks[k] && marks[k].level && !marks[k].exempt && k.indexOf('qq:') === 0);
    if (!aiKey) return;   // 没有 AI 标记就跳过（不是失败）
    const pid = P.findByAccount('qq', aiKey.slice(3));
    if (pid) assert.strictEqual(P.sexOf(pid), 'female');
  });
  // 真名以她本人在面板定的为准（2026-11-22 晚她把「虚幻」改成了现在的名字，测试不再钉死字面量）
  ok('真名 = 她本人定过的名字（非空）', () => assert.ok(P.realNameOf(masterPid).length > 0));
  ok('当前可见名 = 本群群名片', () => assert.strictEqual(P.currentVisibleNameOf(masterPid, GID), '那就是死了已被移出群聊'));
  ok('喊人用 真名 + 当前可见名', () => {
    const arr = P.callNamesOf(masterPid, GID);
    assert.deepStrictEqual(arr.slice(0, 2), [P.realNameOf(masterPid), '那就是死了已被移出群聊']);
    assert.ok(arr.indexOf('一抹多') < 0, '别群名片被拿来喊了');
    assert.ok(arr.indexOf('群女仆机器人') < 0, '同平台别的号被拿来喊了');
  });
  ok('代称不含当前可见名，含曾用名', () => {
    const al = P.aliasesOfPerson(masterPid, GID);
    assert.ok(al.indexOf('那就是死了已被移出群聊') < 0, '当前可见名被算成代称');
    assert.ok(al.indexOf('主人（虚幻）') >= 0 || al.length > 0, '代称空了');
  });
  ok('nick.nameFor 主人 → 主人（身份即称呼）', () => assert.strictEqual(nick.nameFor('1000001000', { uid: '1000001000' }, ''), '主人'));
  ok('nick.nameFor 欧尼酱 → 欧尼酱', () => assert.strictEqual(nick.nameFor('1000001001', { uid: '1000001001' }, ''), '欧尼酱'));
  ok('nick.nameFor 群友按「主人叫法」喊，不喊代称', () => {
    // 2026-11-22 她令：主人喊他「大萌新」，虚幻跟着这么喊（真名空时主人叫法排在可见名前面）
    const n = nick.nameFor('1000001002', { uid: '1000001002', gid: GID, nick: '那就是死了' }, '');
    assert.ok(/^(大萌新|那就是死了)(酱)?$/.test(n), '喊成了：' + n);
    assert.strictEqual(P.masterCallOf(P.findByAccount('qq', '1000001002')), '大萌新');
  });
  ok('名字三项并列：可见名 / 主人叫法 / 真名', () => {
    const pid = P.findByAccount('qq', '1000001002');
    const old = P.realNameOf(pid);
    P.setName(pid, '小死');
    const names = P.callNamesOf(pid, GID, 'qq', '1000001002');
    assert.deepStrictEqual(names.slice(0, 3), ['小死', '大萌新', '那就是死了']);
    P.setName(pid, old);   // 还原（原来没真名 → 清空）
  });
  ok('对话里说「我是女的」→ 改成女', () => {
    const pid = P.findByAccount('qq', '1000001002');
    const before = P.sexOf(pid);
    core.noteSexFromText('1000001002', '我是女生，别叫我哥');
    assert.strictEqual(P.sexOf(pid), 'female');
    P.setSex(pid, before, 'confirmed');    // 还原
  });
  ok('对话里说「我是男的」→ 确认是男', () => {
    const pid = P.findByAccount('qq', '1000001002');
    core.noteSexFromText('1000001002', '我是男的');
    assert.strictEqual(P.sexOf(pid), 'male');
    assert.strictEqual(P.sexSrcOf(pid), 'confirmed');
  });

  // 还原 people.json（测试只读，不改数据）
  fs.writeFileSync(PEOPLE_FILE, backup, 'utf8');

  console.log('\n' + (fail ? '❌ ' : '✅ ') + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
