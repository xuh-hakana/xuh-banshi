/*
 * tests/test-people.js — 多端互通（按人物聚合全平台账号）自测
 *
 * 运行：node tests/test-people.js
 *
 * 测的是最容易出错的几处：
 *   ① 共享好感：同一个人名下所有账号查到同一个数
 *   ② 合并：相加封顶 100、账号搬过去、名字不被静默换掉
 *   ③ 分层：名字在人物上，资料卡名/群名片在账号上（两个 QQ 各记各的，不串）
 *   ④ 镜像：favor.json / people-state.json 跟着 people.json 走
 *   ⑤ 运行时链路：夸赞 +1、群名片记录、满 100 叫宝宝
 *   ⑥ 聊天命令：绑定 / 新人物 / 合并
 *   ⑧ 喜恶 + 事实按人物聚合：多号全留带来源、注入去重、写入归一、合并、纯 B站空
 *
 * 全程先备份 data/people.json + 两份 md 原文 + 写入日志，测完还原，**不动真实数据**。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src', 'people'));
const nick = require(path.join(ROOT, 'src', 'nick'));
const cmd = require(path.join(ROOT, 'src', 'people-cmd'));

const FILE = P.FILE;
const TASTE_MD = path.join(ROOT, 'src', 'data', '人物喜好.md');
const FACTS_MD = path.join(ROOT, 'src', 'data', '人物列表.md');
/* 2026-11-21 人设层物理切分后，喜好文件从 soul/段/ 搬到了 soul/F-全场景通用主人设/。
 * 这里两个位置都认：先找新位置，再退回旧位置（两种目录结构下测试都能跑）。 */
const SOUL_MD = (() => {
  const now = path.join(ROOT, 'src', 'soul', 'F-全场景通用主人设', '0-我的喜好.md');
  if (fs.existsSync(now)) return now;
  return path.join(ROOT, 'src', 'soul', '段', '0-我的喜好.md');
})();
const WRITES = path.join(ROOT, 'src', 'data', 'bot-writes.jsonl');
// 2026-11-06：新建人物会顺手记「第一次相遇」（people.markMeet → dates.js），
// 所以这里也要备份/还原 dates.json，否则每跑一次测试就往日子里塞十几个假人。
const DATES = path.join(ROOT, 'src', 'data', 'dates.json');
const BACKUP = path.join(ROOT, 'src', 'data', '.people-test-backup.json');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const orig = fs.readFileSync(FILE, 'utf8');
const origTaste = fs.readFileSync(TASTE_MD, 'utf8');
const origFacts = fs.readFileSync(FACTS_MD, 'utf8');
const origSoul = fs.readFileSync(SOUL_MD, 'utf8');
const origWrites = fs.readFileSync(WRITES, 'utf8');
const origDates = fs.existsSync(DATES) ? fs.readFileSync(DATES) : null;
const origTasteMtime = fs.statSync(TASTE_MD).mtime;
const origFactsMtime = fs.statSync(FACTS_MD).mtime;
const origSoulMtime = fs.statSync(SOUL_MD).mtime;

// taste.js 用 mtime 做缓存；临时写 md 时把 mtime 拨开，保证每次写入都能让缓存失效。
let clock = 0;
function put(file, text) {
  fs.writeFileSync(file, text, 'utf8');
  const at = new Date(Date.now() + (++clock) * 50);
  fs.utimesSync(file, at, at);
}
function bump(file) {
  const at = new Date(Date.now() + (++clock) * 50);
  fs.utimesSync(file, at, at);
}
function restore() {
  fs.writeFileSync(FILE, orig, 'utf8');
  P.save(P.load());            // 重算镜像
  fs.writeFileSync(TASTE_MD, origTaste, 'utf8');
  fs.writeFileSync(FACTS_MD, origFacts, 'utf8');
  fs.writeFileSync(SOUL_MD, origSoul, 'utf8');
  fs.writeFileSync(WRITES, origWrites, 'utf8');
  try { origDates ? fs.writeFileSync(DATES, origDates, 'utf8') : fs.unlinkSync(DATES); } catch {}
  fs.utimesSync(TASTE_MD, origTasteMtime, origTasteMtime);
  fs.utimesSync(FACTS_MD, origFactsMtime, origFactsMtime);
  fs.utimesSync(SOUL_MD, origSoulMtime, origSoulMtime);
  bump(FILE);
  try { fs.unlinkSync(BACKUP); } catch {}
}
fs.writeFileSync(BACKUP, orig, 'utf8');

try {
  /* ---------- ① 共享好感 ---------- */
  const pid = P.ensure('qq', '100000000');
  ok(!!pid && P.getFavor(pid) === 0, 'ensure 新建人物 favor=0');
  P.setFavor(pid, 50);
  ok(P.getFavorByAccount('qq', '100000000') === 50, 'setFavor 后 qq 账号查到 50');
  P.addAccount(pid, 'bili', '111222');
  ok(P.getFavorByAccount('bili', '111222') === 50, '加 bili 账号后共享同一好感');
  const r = P.addFavor(pid, 15);
  ok(r.v === 65 && r.crossed === true, 'addFavor 到 65 且 crossed=true');

  /* ---------- ② 合并（相加封顶100 / 名字不换） ---------- */
  const a = P.ensure('qq', '100000000'); P.setFavor(a, 80);
  const b = P.ensure('qq', '100000000'); P.setFavor(b, 50);
  // 2026-11-13 起真名只有「她手动改 / 本人自己说」能动，测试要按面板那条路带 byUser
  P.setState(a, { name: '甲' }, { byUser: true }); P.setState(b, { name: '乙' }, { byUser: true });
  ok(P.merge(a, b) === true, 'merge 返回 true');
  ok(P.getFavor(a) === 100, '合并后好感相加封顶 100（80+50）');
  ok(P.findByAccount('qq', '100000000') === a, '被合并的账号指向保留人物');
  ok(P.get(b) === null, '来源人物已删除');
  ok(P.get(a).name === '甲', '合并不静默换名字');

  /* ---------- ③ 分层：群名片各记各的 ---------- */
  const master = P.get('p_master');
  ok(!!master && master.accounts.length === 3, '主人是3个账号（2QQ+B站）');
  ok(P.findByAccount('qq', '100000000') === 'p_master', '主QQ1 属于 p_master');
  ok(P.findByAccount('qq', '100000000') === 'p_master', '主QQ2 属于 p_master');
  ok(P.getFavor('p_master') === 100, '主人 favor=100');
  const before1 = Object.keys(P.mainAccount('p_master').cards || {}).length;
  // 2026-11-22 新规则：群名片只认事件带的 card（ctx.nick 可能是资料卡名，不许冒充群名片）
  nick.nameFor('100000000', { nick: '主2', card: '主2', gid: '77777777' }, '你好');
  const m2 = P.get('p_master');
  ok(m2.accounts.find(x => x.id === '100000000').cards['77777777'] === '主2', '第二个QQ的群名片记上了');
  ok(!m2.accounts.find(x => x.id === '100000000').cards['77777777'], '第一个QQ没被串');

  /* ---------- ④ 镜像同步 ---------- */
  P.setState(pid, { nick: '测试昵称' }, { byUser: true });   // 资料卡名也走面板那条路
  const fv = JSON.parse(fs.readFileSync(P.FAVOR_MIRROR, 'utf8'));
  const ps = JSON.parse(fs.readFileSync(P.STATE_MIRROR, 'utf8'));
  ok(fv['100000000'] && fv['100000000'].v === 65, '镜像 favor.json 跟着人物走');
  ok(ps['100000000'] && ps['100000000'].nick === '测试昵称', '镜像 people-state.json 跟着走');

  /* ---------- ⑤ 运行时链路 ---------- */
  /* 2026-11-22 新规则（她令「被回复了就给这个人建档」「说话不建档」）：
   * 陌生人说话 → 只进 seen 内存；她回复 → enroll 建档，并把看到的名字一次写全。 */
  const seen = require(path.join(ROOT, 'src', 'seen'));
  seen.note('100000000', '', '', '新人甲');
  /* 2026-11-22 她最终口径：**QQ 说话就建档**，B站 才是回复才建档。
   * 这里验证 QQ 真实链路：nameFor 一跑，新号立刻进人物表。 */
  nick.nameFor('100000000', { nick: '路人群友', card: '路人群友', gid: '88888888' }, '你好');
  ok(P.findByAccount('qq', '100000000') !== null, 'QQ 群聊：说话就建档');
  ok(P.mainAccount(P.findByAccount('qq', '100000000')).cards['88888888'] === '路人群友', '建档时带上群名片');
  ok(P.findByAccount('qq', '100000000') === null, 'seen 只是 B站 的旁路，QQ 不走它');
  ok(seen.get('100000000') && seen.get('100000000').nick === '新人甲', '内存里记下了看到的名字');
  seen.enroll('100000000', { gid: '', card: '', nick: '新人甲' });
  ok(P.findByAccount('qq', '100000000') !== null, '被回复后建档');
  const npid = P.findByAccount('qq', '100000000');
  ok(P.mainAccount(npid).nick === '新人甲', '资料卡名记上了');
  ok(P.get(npid).role === 'stranger', '新档身份 = 陌生人');
  nick.nameFor('100000000', { nick: '新人甲' }, '好聪明');
  ok(P.getFavorByAccount('qq', '100000000') === 1, '夸赞 +1 生效');
  nick.nameFor('100000000', { nick: '群里名', card: '群里名', gid: '88888888' }, '你好');
  ok(P.mainAccount(P.findByAccount('qq', '100000000')).cards['88888888'] === '群里名', '群名片记上了');
  ok(P.isBabyByAccount('qq', '100000000') === false, '好感 1 不叫宝宝');
  P.setFavorByAccount('qq', '100000000', 100);
  ok(nick.nameFor('100000000', { nick: '新人甲' }, '你好').indexOf('宝宝') > 0, '满 100 叫宝宝');

  /* ---------- ⑥ 名字归属（改 / 清空 / 不丢） ----------
   * 2026-11-13 起真名只能「她手动改 / 本人自己说」；镜像回写（writeStateView）只同步昵称/名片/代称，
   * 不许写真名。所以这里按面板真实路径 setState(..., {byUser:true}) 验证。 */
  P.setState('p_master', { name: '新名字' }, { byUser: true });
  ok(P.get('p_master').name === '新名字', '改名字生效（第二个账号没盖回来）');
  P.setState('p_master', { name: '' }, { byUser: true });
  ok(!P.get('p_master').name, '清空名字生效');
  P.setState('p_master', { name: '主人' }, { byUser: true });
  ok(P.get('p_master').name === '主人', '改回名字生效');
  /* 旧契约（镜像能改真名）已弃用：现在的规矩是「真名只有她手动改 / 本人自己说才能动」。
   * 这条断言新规则本身——绕过面板（不带 byUser）改真名必须被拒。 */
  ok('不带 byUser 改真名 → 被拒（人名闸）', () => {
    const r = P.setState('p_master', { name: '偷偷改' });
    assert.strictEqual(r, false, '竟然放过了');
    assert.notStrictEqual(P.get('p_master').name, '偷偷改');
  });
  nick.nameFor('100000000', { nick: 'x' }, '你好');
  ok(P.get('p_master').name === '主人', '运行时保存不丢名字');

  /* ---------- ⑦ 聊天命令 ---------- */
  ok(cmd.parseCommand('今天天气不错') === null, '不是命令就不接管');
  const c1 = cmd.parseCommand('绑定 bili 999888 到 清酒');
  ok(c1 && c1.msg.indexOf('绑好') >= 0, '命令：绑定');
  const c2 = cmd.parseCommand('新人物 测试乙 qq 100000000');
  ok(c2 && c2.msg.indexOf('记好') >= 0, '命令：新人物');
  const c3 = cmd.parseCommand('把 测试乙 合并到 清酒');
  ok(c3 && c3.msg.indexOf('合好') >= 0, '命令：合并');
  const c4 = cmd.parseCommand('绑定 微博 12345 到 清酒');
  ok(c4 && c4.msg.indexOf('平台') >= 0, '命令：平台不认识会提示');

  /* ---------- ⑧ 喜恶 + 事实按人物聚合（2026-11-04） ----------
   * 原文仍是「一节一个 QQ / 一行一条事实」，这里临时写一份双号样本，测完 restore() 还原。
   * 只 require 需要的模块（taste / panel），不启动机器人、不连 QQ。 */
  const T = require(path.join(ROOT, 'src', 'taste'));
  const panel = require(path.join(ROOT, 'src', 'server', 'panel'));

  const pidA = P.ensure('qq', '100000000');
  P.addAccount(pidA, 'qq', '100000000');           // 同一个人两个 QQ
  const pidB = P.ensure('qq', '100000000');         // 待合并的另一个人
  const pidC = P.ensure('bili', '100000000');       // 纯 B站人物（无 QQ）
  const o = P.load();
  o[pidA].taste = '甲口味'; o[pidB].facts = '乙事实';
  P.save(o);
  bump(FILE);                                       // 让 taste 的人物索引缓存失效

  put(TASTE_MD, [
    '# 人物喜好', '',
    '## 测试甲（100000000）', '',
    '### 喜欢（确定）', '',
    '- 猫薄荷 （2026-11-04 · 亲口说）',
    '- 奶茶 （2026-11-04 · 亲口说）', '',
    '### 讨厌（确定）', '',
    '- 香菜 （2026-11-04 · 亲口说）', '',
    '## 测试甲副号（100000000）', '',
    '### 讨厌（确定）', '',
    '- 猫薄荷 （2026-11-04 · 亲口说）', '',
    '### 喜欢（确定）', '',
    '- 榴莲 （2026-11-04 · 亲口说）', '',
    '## 测试乙（100000000）', '',
    '### 喜欢（可能）', '',
    '- 看海 （2026-11-04 · 推测）', '',
  ].join('\n'));
  put(FACTS_MD, [
    '# 人物列表', '',
    '## 人物', '',
    '- 测试甲（QQ 100000000）喜欢夜里聊天',
    '- 测试甲副号（QQ 100000000）是同一个人的小号',
    '- 测试乙（QQ 100000000）住在海边', '',
  ].join('\n'));

  // 基础：people.js 新增的两个账号查询函数
  ok(JSON.stringify(P.qqAccountsOf(pidA)) === JSON.stringify(['100000000', '100000000']), 'qqAccountsOf 按 accounts 顺序返回全部 QQ');
  ok(P.mainQQ(pidA) === '100000000' && P.primaryQQ(pidA) === '100000000', 'mainQQ/primaryQQ 都是第一个 QQ');

  // ① 两个 QQ 的口味全留、各标来源 QQ
  const byA = T.byPerson(pidA);
  const allItems = ['likeConf', 'hateConf', 'likePerson', 'pending', 'likeGuess', 'hateGuess']
    .reduce((acc, s) => acc.concat(byA.secs[s] || []), []);
  ok(allItems.length === 5, 'byPerson 把两个 QQ 的 5 条口味全留下来');
  ok(allItems.every(x => typeof x.t === 'string' && x.fromQQ), '每条口味都带 fromQQ');
  ok(new Set(allItems.map(x => x.fromQQ)).size === 2, '来源号有两个（主号 + 副号）');
  ok(byA.secs.likeConf.some(x => x.t === '榴莲' && x.fromQQ === '100000000'), '副号那节的口味也在');
  ok(byA.secs.hateConf.some(x => x.t === '猫薄荷' && x.fromQQ === '100000000'), '跨号冲突（主号喜欢 / 副号讨厌）两条都在');

  // ② 用副号调 block 能读到主号那节的「亲口说喜欢」，且注入时按 PRIO+POL 去重不自相矛盾
  const blk = T.block('100000000');
  ok(blk.indexOf('亲口说喜欢') >= 0 && blk.indexOf('猫薄荷') >= 0, '副号 block 读到主号那节的「亲口说喜欢」');
  ok(!/亲口说讨厌：[^\n]*猫薄荷/.test(blk), '冲突词注入模型时只取一条，不出现又喜欢又讨厌');
  ok(T.listMine('100000000').some(x => x.t === '猫薄荷' && x.sec === 'likeConf'), 'listMine 也按人物聚合（副号读到主号词条）');

  // ③ vsStance 两个号立场一致
  const vs1 = T.vsStance('猫薄荷和榴莲谁厉害', '100000000');
  const vs2 = T.vsStance('猫薄荷和榴莲谁厉害', '100000000');
  ok(vs1.mode === 'lib' && vs1.liked.indexOf('猫薄荷') >= 0, 'vsStance 主号：按口味站队');
  ok(vs2.mode === 'lib' && JSON.stringify(vs2.liked) === JSON.stringify(vs1.liked), 'vsStance 副号和主号立场完全一致');

  // ④ 写入归一：用副号 add 落到主 QQ 那一节，不新增散落的分节
  const beforeSecs = Object.keys(T.parse()).length;
  ok(T.add('100000000', '测试甲', 'likeConf', '写进主号的口味', false, '测') === true, '副号 add 成功');
  const parsedAfter = T.parse();
  ok((parsedAfter['100000000'] || {}).likeConf.some(x => x.t === '写进主号的口味'), 'add 写进了主 QQ 那一节');
  ok(!((parsedAfter['100000000'] || {}).likeConf || []).some(x => x.t === '写进主号的口味'), '副号那一节没被新增写入');
  ok(Object.keys(parsedAfter).length === beforeSecs, '没有新建人物节');

  // ④-b 跨号「同内容不重复写」：只在副号节里有的词，从主号 add 不能再写一条（QA P1 回归）
  const dupBefore = T.parse();
  ok(T.add('100000000', '测试甲', 'likeConf', '榴莲', false, '测') === false, '副号节已有的同内容，从主号 add 不重复写');
  const dupAfter = T.parse();
  ok(((dupAfter['100000000'] || {}).likeConf || []).length === ((dupBefore['100000000'] || {}).likeConf || []).length, '主号节没被写入重复条目');

  // ⑤ 老用例（test-all.js 同款）：写入 / 不记重 / 重合计数 / 还原
  const c0 = T.clashCount();
  ok(typeof c0 === 'number' && c0 >= 0, 'clashCount 返回数字且按人物聚合不报错');
  ok(T.addPerson('888888', '测试人物甲', 61) === true, 'addPerson 写入「喜欢（人物）」');
  ok(T.addPerson('888888', '测试人物甲改名了', 65) === false, '同 QQ 换昵称不重复写');
  ok(T.add('888888', '测试人物甲', 'likeConf', '神秘园测试条目', false, '测') === true, 'add 写入确定节');
  ok(T.add('888888', '测试人物甲', 'likeConf', '神秘园测试条目特别版', false, '测') === true, '描述重合的两条都留着');
  ok(T.clashCount() >= c0 + 1, '重合的能数出来（老用例语义不变）');

  // ⑥ 纯 B站用户（没有 QQ 号）：也要能记喜恶（2026-11-05 她定）
  const byC = T.byPerson(pidC);
  ok(['likeConf', 'hateConf', 'likePerson', 'pending', 'likeGuess', 'hateGuess']
    .every(s => Array.isArray(byC.secs[s]) && byC.secs[s].length === 0), '纯 B站人物没记过时是空六节');
  ok(T.block('100000000') === '', '纯 B站人物没记过时 block 为空');
  ok(T.add('100000000', '纯B站', 'likeConf', '喜欢看海', true, '测') === true, '纯 B站人物 add 能写入（不再拒绝）');
  const mdBili = fs.readFileSync(TASTE_MD, 'utf8');
  ok(/^## 纯B站（B站 100000000）$/m.test(mdBili), '建的是带 B站 前缀的节（和 QQ 号区分开）');
  ok(T.block('100000000').indexOf('喜欢看海') >= 0, '纯 B站人物 block 能读到');
  const byC2 = T.byPerson(pidC);
  ok(byC2.secs.likeConf.some(x => x.t === '喜欢看海' && x.fromPlatform === 'bili' && x.fromQQ === '100000000'), '按人物聚合读得到，来源标 B站');
  ok(T.add('100000000', '纯B站', 'likeConf', '喜欢看海', true, '测') === false, '纯 B站人物同内容不重复写');

  // ⑦ 查不到人物 / 非数字 uid：回退原单节查，不抛错
  ok(T.byPerson('888888').secs.likeConf.some(x => x.t === '神秘园测试条目'), '查不到人物回退按原 uid 单节查');
  ok(T.byPerson('abc').secs.likeConf.length === 0, '非数字 uid 返回空六节且不抛错');

  // ⑦-b 注入层去重键用完整文本（QA P2 回归）：面板手写的两条长词条前 20 字相同时，不能只留一条
  put(TASTE_MD, fs.readFileSync(TASTE_MD, 'utf8')
    + '\n## 长词测试（100000000）\n\n### 喜欢（确定）\n\n'
    + '- 这是一个非常非常非常非常非常非常长的口味条目甲 （测）\n'
    + '- 这是一个非常非常非常非常非常非常长的口味条目乙 （测）\n');
  const blkP2 = T.block('100000000');
  ok(blkP2.indexOf('条目甲') >= 0 && blkP2.indexOf('条目乙') >= 0, '两条长词条都在（去重键没被截断撞掉）');

  // ⑧ 合并两个人物后口味 / 事实都不丢
  ok(P.merge(pidA, pidB) === true, 'merge 两个人物成功');
  ok(P.get(pidA).taste === '甲口味' && P.get(pidA).facts === '乙事实', 'merge 不丢来源的 taste/facts 占位');
  ok(T.byPerson(pidA).secs.likeGuess.some(x => x.t === '看海' && x.fromQQ === '100000000'), '合并后被合并人的口味仍按人物读到');
  const cards = panel.readPeople().list;
  const cardA = cards.find(x => x.pid === pidA);
  ok(!!cardA, '面板能返回这张人物卡');
  ok((cardA.taste || []).some(s => (s.items || []).some(i => i.fromQQ)), '人物卡口味条目带 fromQQ');
  ok((cardA.taste || []).reduce((n, s) => n + (s.items || []).length, 0) >= 2, '人物卡显示多条口味（两个 QQ 各一条以上）');
  ok(new Set((cardA.taste || []).reduce((arr, s) => arr.concat((s.items || []).map(i => i.fromQQ)), [])).size >= 2, '人物卡口味来源号有两个');
  ok((cardA.facts || []).length >= 2 && cardA.factFrom && cardA.factFrom.length === cardA.facts.length, '事实按人物合并且每条有来源号');
  ok(cardA.factFrom.indexOf('100000000') >= 0, '合并后被合并人的事实也带来源号');

  // ⑨ 面板卡：纯 B站 用户在客户端也能看到口味和事实（来源标 B站）
  put(FACTS_MD, fs.readFileSync(FACTS_MD, 'utf8') + '\n- 纯B站（B站 100000000）常来看海\n');
  const cardC = panel.readPeople().list.find(x => x.pid === pidC);
  ok(!!cardC, '面板能返回纯 B站 人物卡');
  ok((cardC.taste || []).some(s => (s.items || []).some(i => i.t === '喜欢看海' && i.fromPlatform === 'bili')), '面板卡：纯 B站 口味带 B站 来源');
  ok((cardC.facts || []).some(f => f.indexOf('常来看海') >= 0), '面板卡：B站 账号的事实也能认到');
  ok((cardC.factPlat || [])[0] === 'bili', '面板卡：事实来源标 B站');

  /* ---------- ⑩ 纯 B站 / 任意非 QQ 平台「建档」（2026-11-05 她定） ----------
   * 她的原话：「应该把 b站用户也建档，并能记录所有应记内容」「分第一次看到的平台按账号记录，
   * 不按昵称记」「第一次记录可以来自任意平台，不应该不记」。 */

  // ⑩-① 纯 B站 用户第一次 taste.add('bili:<uid>') → 建档 + 写入 + 读得回
  bump(TASTE_MD);
  ok(T.add('bili:100000000', 'B站新人', 'likeConf', '喜欢下雨', true, '测') === true, '纯 B站 uid 第一次 add 成功（不拒绝）');
  const pidD = P.findByAccount('bili', '100000000');
  ok(!!pidD, 'taste.add 给 B站 用户建了档（people.json 里有人物）');
  const recD = pidD ? P.get(pidD) : null;
  ok(!!recD && recD.accounts.length === 1 && recD.accounts[0].platform === 'bili'
    && String(recD.accounts[0].id) === '100000000', '档案里账号是 {platform:bili, id:100000000}');
  ok(!!recD && recD.accounts[0].nick === 'B站新人', '昵称记在账号级 nick 上');
  const mdD = fs.readFileSync(TASTE_MD, 'utf8');
  ok(/^## B站新人（B站 100000000）$/m.test(mdD), '内容落在 ## 名字（B站 uid） 节（带平台前缀）');
  ok(!/^##\s+B站新人（100000000）$/m.test(mdD), '没写成 QQ 那种裸号节（B站 号没被当成 QQ 号）');
  const byD = T.byPerson('bili:100000000');
  ok(byD.secs.likeConf.some(x => x.t === '喜欢下雨' && x.fromPlatform === 'bili' && x.fromQQ === '100000000'),
    'byPerson("bili:uid") 读得到，来源标 B站');
  ok(T.add('bili:100000000', 'B站新人', 'likeConf', '喜欢下雨', true, '测') === false, '同内容不重复写（B站 也去重）');
  const cardD = panel.readPeople().list.find(x => x.pid === pidD);
  ok(!!cardD && cardD.isMaster === false, '面板卡：纯 B站 人物不是主人');
  ok(!!cardD && cardD.accounts[0].platform === 'bili' && cardD.accounts[0].nick === 'B站新人',
    '面板卡：账号来源是 bili，nick 有值');
  ok(!!cardD && cardD.label === 'B站新人', '面板卡：有昵称时 label 用昵称');
  ok(!!cardD && (cardD.taste || []).some(s => (s.items || []).some(i => i.fromPlatform === 'bili')),
    '面板卡：口味条目来源平台是 bili');

  // ⑩-② 同一数字在不同平台是两个人（qq:100000000 ≠ bili:100000000），互不顶替
  ok(P.findByAccount('qq', '100000000') === null, 'bili:100000000 没有被同时记成 qq:100000000');
  const pidQ2 = P.ensure('qq', '100000000');
  ok(pidQ2 && pidQ2 !== pidD, 'qq:100000000 和 bili:100000000 是两个不同人物');
  bump(TASTE_MD);
  ok(T.add('qq:100000000', 'QQ新人', 'likeConf', '喜欢下雪', true, '测') === true, 'qq:<同数字> add 成功');
  const byQ2 = T.byPerson('qq:100000000');
  ok(byQ2.secs.likeConf.some(x => x.t === '喜欢下雪' && x.fromPlatform === 'qq'), 'qq 那个人的口味读在 qq 上');
  ok(!byQ2.secs.likeConf.some(x => x.t === '喜欢下雨'), 'qq 那个人读不到 B站 那个人的口味（没有串）');
  ok(!T.byPerson('bili:100000000').secs.likeConf.some(x => x.t === '喜欢下雪'), 'B站 那个人也读不到 QQ 的口味（没有串）');
  ok(/^## QQ新人（100000000）$/m.test(fs.readFileSync(TASTE_MD, 'utf8')), 'QQ 那人仍用裸号节（老写法不动）');

  // ⑩-③ 账号顺序：先加 bili 后加 qq，落盘后 accounts[0] 是 QQ；两个 QQ 保持插入顺序
  const pidE = P.ensure('bili', '100000000');
  P.addAccount(pidE, 'qq', '100000000');
  const recE = P.get(pidE);
  ok(recE.accounts.length === 2 && recE.accounts[0].platform === 'qq' && recE.accounts[1].platform === 'bili',
    '先 bili 后 qq：保存后 accounts[0] 是 qq、[1] 是 bili');
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'))[pidE];
  ok(onDisk.accounts[0].platform === 'qq', '落盘的 people.json 里也是 QQ 在前（不只是内存）');
  ok(P.mainAccount(pidE).platform === 'qq', '主账号 = 第一个 QQ');
  const pidF = P.ensure('qq', '100000000');
  P.addAccount(pidF, 'qq', '100000000');
  ok(P.get(pidF).accounts.map(a => String(a.id)).join(',') === '100000000,100000000', '同平台保持插入顺序（两个 QQ 不乱）');
  const pureBili = P.get(pidD).accounts;
  ok(pureBili.length === 1 && pureBili[0].platform === 'bili', '纯 B站 人物主账号就是第一个 B站 账号');

  // ⑩-④ B站 UID 与主人 QQ 号相同 → 只写《人物喜好》，人设层一个字不动
  T.setMasters(['100000000']);
  const soulBefore = fs.readFileSync(SOUL_MD, 'utf8');
  ok(T.add('bili:100000000', 'B站撞号', 'likeConf', 'B站号撞主人QQ', true, '测') === true, 'B站 UID 撞主人 QQ 号也照样记（不是拒绝写入）');
  ok(fs.readFileSync(SOUL_MD, 'utf8') === soulBefore, '人设层 soul/段/0-我的喜好.md 一字不变（防串号）');
  const mdMaster = fs.readFileSync(TASTE_MD, 'utf8');
  ok(/^## B站撞号（B站 100000000）$/m.test(mdMaster), '撞号的 B站 用户写在《人物喜好》里，带 B站 前缀');
  ok(T.block('bili:100000000').indexOf('B站号撞主人QQ') >= 0, '撞号的 B站 用户口味能读到');
  T.setMasters([]);

  // ⑩-⑤ people.touch：第一次看到就建档 + 记昵称；重复 touch 不新建人物、不覆盖已有昵称
  const nBefore = Object.keys(P.load()).length;
  const pidG = P.touch('bili', '100000000', { nick: '观众甲' });
  ok(!!pidG, 'touch 给没见过的 B站 账号建档');
  ok(P.get(pidG).accounts[0].nick === '观众甲', 'touch 把昵称记到账号级 nick');
  ok(Object.keys(P.load()).length === nBefore + 1, '只新建了一个人物');
  const pidG2 = P.touch('bili', '100000000', { nick: '换了昵称' });
  ok(pidG2 === pidG, '重复 touch 返回同一个人物（幂等）');
  ok(Object.keys(P.load()).length === nBefore + 1, '重复 touch 不新建人物');
  ok(P.get(pidG).accounts[0].nick === '观众甲', '重复 touch 不覆盖已经记下的昵称');
  const pidG3 = P.touch('bili', '100000000');
  ok(pidG3 === pidG, '不带昵称的 touch 也不新建');
  ok(P.touch('bili', '') === null, '空账号不建档（不写脏数据）');
  const eCount = Object.keys(P.load()).length;
  const pidH = P.ensure('bili', '100000000', { nick: 'ensure昵称' });
  ok(!!pidH && P.get(pidH).accounts[0].nick === 'ensure昵称', 'ensure 也支持 opts.nick（落在账号级）');
  ok(Object.keys(P.load()).length === eCount + 1, 'ensure 只建一个人物');
  ok(P.ensure('bili', '100000000', { nick: '又改' }) === pidH && P.get(pidH).accounts[0].nick === 'ensure昵称',
    'ensure 已存在时不新建、不覆盖昵称');

  // ⑩-⑥ 跨账号去重仍有效：一个人物挂了 qq + bili，同内容从另一个账号再记不重复
  ok(T.add('qq:100000000', '戊', 'likeConf', '跨号去重词', true, '测') === true, '主账号写入成功');
  ok(T.add('bili:100000000', '戊', 'likeConf', '跨号去重词', true, '测') === false, '同内容从 B站 账号再记不重复（跨号去重仍有效）');
  const mdE = fs.readFileSync(TASTE_MD, 'utf8');
  ok((mdE.match(/跨号去重词/g) || []).length === 1, '原文里这条只出现一次');
} finally {
  restore();
}

console.log((fail ? '✗ ' : '✅ ') + '多端互通自测：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
