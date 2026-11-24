/*
 * tests/test-nl-command.js — 主人私聊「自然语言=指令」回归（2026-11-19 主人令）
 * 跑法：node tests/test-nl-command.js（只读源码 + 一个唯一测试会话键的写读还原）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
let pass = 0, fail = 0;
const t = (name, ok, why) => { ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』')); };

(async () => {
  const nl = require(path.join(ROOT, 'src', 'nl-command'));
  const cfg = require(path.join(ROOT, 'src', 'config')).load();

  t('主人的 QQ 号被认成主人', nl.isOwner('qq', String(cfg.masterQQ)), String(cfg.masterQQ));
  t('主人的 B站号也被认成主人', nl.isOwner('bili', '30895294'));
  t('别人的号不进指令层', !nl.isOwner('qq', '123456') && !nl.isOwner('bili', '999999'));

  const alias = nl.deterministic('这句话里 ayami(100000000) 这么说，证明这个号叫 Ayami', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('转发证据「证明某号叫X」识别成代称', alias && alias.action === 'alias_set' && alias.uid === '100000000' && alias.name === 'Ayami', JSON.stringify(alias));
  const wrong = nl.deterministic('标错：这句说错了。理由：语气太生硬', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('标错 + 理由识别成真正标错动作', wrong && wrong.action === 'mark_wrong' && /语气太生硬/.test(wrong.reason), JSON.stringify(wrong));
  const off = nl.deterministic('关闭群 100000000', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('自然语言「关闭某群」识别成群开关', off && off.action === 'group_off' && off.gid === '100000000', JSON.stringify(off));
  const offByName = nl.deterministic('把世界连结这个群关掉', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true });
  t('说群名也能关（「把XX这个群关掉」）', offByName && offByName.action === 'group_off' && offByName.gid === '100000000', JSON.stringify(offByName));
  const offNoId = nl.deterministic('关闭这个群', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true, convKey: 'qq_' + cfg.masterQQ });
  t('没说哪个群时不拿主人私聊键顶替', offNoId && offNoId.action === 'group_off' && !offNoId.gid, JSON.stringify(offNoId));
  const selfName = nl.deterministic('以后叫我 乙', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true, account: { platform: 'qq', id: String(cfg.masterQQ) } });
  t('本人自报「叫我X」不会截成「我」', selfName && selfName.action === 'alias_set' && selfName.name === '乙' && selfName.uid === String(cfg.masterQQ), JSON.stringify(selfName));
  const ask = nl.deterministic('证明他叫 小明', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true });
  t('举证没带号时反问，不瞎记', ask && ask.action === 'alias_ask', JSON.stringify(ask));
  const sw = nl.deterministic('把自动接话关了', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('自然语言「把自动接话关了」识别成功能开关', sw && sw.action === 'switch_set' && sw.key === 'autoAsk' && sw.on === false, JSON.stringify(sw));
  const num = nl.deterministic('等待改成8秒', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('改数值不自己换算（8秒就是 8，不是 8000）', num && num.action === 'num_set' && num.key === 'merge.masterWaitMs' && num.value === 8, JSON.stringify(num));
  const pct = nl.deterministic('凑热闹概率调到20%', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('概率按 20 传（不是 0.2）', pct && pct.key === 'chime.p' && pct.value === 20, JSON.stringify(pct));
  const think = nl.deterministic('把实时思考打开', { platform: 'qq', uid: String(cfg.masterQQ) });
  t('1/0 型开关走数值动作', think && think.action === 'num_set' && think.key === 'context.liveThink' && think.value === 1, JSON.stringify(think));
  t('目录里没有未登记的野动作', nl.catalog().every(a => /^[a-z_]+$/.test(a.id)) && nl.catalog().some(a => a.id === 'alias_set'));

  // 纠错门槛：群里随口一句不能被记成禁语（只测不落盘的反例）
  const g1 = await nl.handleCorrection({ platform: 'qq', uid: '222222', nick: '群友', text: '不对', isMaster: false, isPrivate: false, atMe: false });
  t('群友随口「不对」不算纠错', !g1.handled);
  const g2 = await nl.handleCorrection({ platform: 'qq', uid: '222222', nick: '群友', text: '你答错了吧标错', isMaster: false, isPrivate: false, atMe: false, replyToMe: false });
  t('群友说标错但没对她说，不算', !g2.handled);

  const qqSrc = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'qq.js'), 'utf8');
  const nlSrc = fs.readFileSync(path.join(ROOT, 'src', 'nl-command.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'panel.js'), 'utf8');
  const convPath = path.join(ROOT, 'src', 'conv-settings.js');
  const convSrc = fs.readFileSync(convPath, 'utf8');
  const biliSrc = fs.readFileSync('/Users/zhengbowen/.astrbot/data/plugins/astrbot_plugin_bilibili_ai_bot/core/private_messages.py', 'utf8');
  const replySrc = fs.readFileSync('/Users/zhengbowen/.astrbot/data/plugins/astrbot_plugin_bilibili_ai_bot/core/reply.py', 'utf8');

  t('QQ 主链：转发聊天记录会取原文', /fetchForwardEvidence\(forwards\)/.test(qqSrc), '转发证据没接进来');
  t('QQ 主链：主人私聊指令在会话关闭闸之前', qqSrc.indexOf('nlCommand.handle(cmdCtx)') < qqSrc.indexOf('convSettings.isOff(k)'), '顺序不对，会被关群闸吞掉');
  t('QQ 主链：记录类（所有人生效）与管理类都接了', /nlCommand\.handleRecord/.test(qqSrc) && /nlCommand\.handle\(cmdCtx\)/.test(qqSrc));
  t('面板有统一指令入口', /\/api\/nlcommand/.test(panelSrc) && /\/api\/nlcorrection/.test(panelSrc));
  const nlSrvSrc = fs.readFileSync(path.join(ROOT, 'src', 'nl-server.js'), 'utf8');
  const botSrc = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  t('机器人自带指令端口（面板没开也能用）', /8898/.test(nlSrvSrc) && /nl-server/.test(botSrc) && /isOwner/.test(nlSrvSrc));
  t('B站桥接先连机器人端口、再连面板', /8898, 8899/.test(biliSrc) && !/8799/.test(biliSrc) && !/8799/.test(replySrc));
  t('单会话设置真的写 off（不再静默吞掉）', /if \('off' in p\)/.test(convSrc));
  t('B站私聊桥接已接上', /_xuhbot_nlcommand/.test(biliSrc) && /_is_owner\(mid\)/.test(biliSrc));
  t('B站评论纠错也回写 xuhbot', /_xuhbot_nlcorrection/.test(replySrc));

  // 真写读：唯一测试键，验完立刻清掉，不碰真实会话
  const conv = require(path.join(ROOT, 'src', 'conv-settings'));
  const key = 'qq_940099';
  conv.set(key, { off: true });
  const on = conv.isOff(key);
  conv.set(key, { off: false });
  const offAgain = conv.isOff(key);
  t('「关闭某群」真写进 conv-settings 且能恢复', on === true && offAgain === false, '写入 ' + on + ' / 恢复 ' + offAgain);

  // 群场景（2026-11-19 实测暴露：主人在群里发「上下文条数改成40条」，被当成闲聊答了）
  const gidT = '940098';
  const gc = await nl.handleGroup({
    platform: 'qq', uid: String(cfg.masterQQ), text: '关闭群 ' + gidT,
    isPrivate: false, convKey: 'qq_739980743', scope: '群100000000',
  });
  t('主人在群里发的指令也执行', !!(gc && gc.handled && gc.ok), JSON.stringify(gc));
  t('群里关群真落盘', conv.isOff('qq_' + gidT) === true);
  await nl.handleGroup({
    platform: 'qq', uid: String(cfg.masterQQ), text: '恢复群 ' + gidT,
    isPrivate: false, convKey: 'qq_739980743', scope: '群100000000',
  });
  t('群里恢复群真落盘', conv.isOff('qq_' + gidT) === false);

  // 群里闲聊绝不能被当管理类指令吞掉（主人的号发也一样）
  for (const [txt, label] of [
    ['不对', '群里随口「不对」'],
    ['他叫小明', '群里陈述「他叫小明」'],
    ['这个群好吵啊', '群里感叹「这个群好吵」'],
  ]) {
    const r = await nl.handleGroup({
      platform: 'qq', uid: String(cfg.masterQQ), text: txt,
      isPrivate: false, convKey: 'qq_739980743', scope: '群100000000',
    });
    t(label + ' 不当指令', !(r && r.handled), JSON.stringify(r));
  }
  t('群里只认明确纠错词，私聊才放宽「不对」',
    nl.deterministic('不对', { isPrivate: false }) === null
    && nl.deterministic('这句标错了吧', { isPrivate: false }).action === 'mark_wrong'
    && nl.deterministic('不对', { isPrivate: true }).action === 'mark_wrong');

  /* 记录类是所有人生效的（2026-11-19 主人定：约定必须松）。
   * 归属上分两半：约定/代称/标错/记小本本 → 谁都能触发；开关/数值/群开关/撤回 → 只有主人。 */
  t('约定在群里也松（「记下来了吗」算约定）',
    (nl.deterministic('记下来了吗', { isPrivate: false }) || {}).action === 'pact_add');
  t('约定在私聊也认「记下来」',
    (nl.deterministic('记下来：以后别这样', { isPrivate: true }) || {}).action === 'pact_add');

  const recTxt = '记下来：测试约定ZZZ 以后别提这个';
  const recOut = await nl.handleRecord({
    platform: 'qq', uid: '999001', nick: '路人甲', text: recTxt,
    isPrivate: false, convKey: 'qq_739980743', scope: '群100000000',
  });
  t('别人在群里「记下来」真的记成约定（记录类对所有人开放）',
    !!(recOut && recOut.handled && recOut.ok && recOut.silent), JSON.stringify(recOut));

  const recPri = await nl.handleRecord({
    platform: 'qq', uid: '999001', nick: '路人甲', text: '约定：测试约定ZZZ 每天先问一句',
    isPrivate: true, convKey: 'qq_999001', scope: '私聊',
  });
  t('别人私聊说约定也记，且会回一句确认',
    !!(recPri && recPri.handled && recPri.ok && recPri.silent === false), JSON.stringify(recPri));

  for (const [txt, label] of [
    ['把自动接话关了', '功能开关'],
    ['上下文条数改成30条', '数值'],
    ['关闭群 940097', '群开关'],
    ['撤回这句', '撤回'],
  ]) {
    const r = await nl.handleRecord({ platform: 'qq', uid: '999001', text: txt, isPrivate: true, scope: '私聊' });
    t('别人的' + label + '不是记录类，不执行', !(r && r.handled), JSON.stringify(r));
  }
  t('记录类入口只放记录类（约定/换回约定/代称/小本本/喜好/人设），不放管理类',
    /const RECORD_ACTIONS = new Set\(\['pact_add', 'pact_switch', 'alias_set', 'memory_log', 'taste_add', 'persona_set', 'persona_reset'\]\)/.test(nlSrc));
  t('指令端口的纠错路不再卡主人号（记录类对所有人）',
    /api\/nlcorrection[\s\S]{0,320}handleRecord/.test(nlSrvSrc)
    && !/if \(!nl\.isOwner\(d\.platform \|\| 'qq', d\.uid\)\) return json\(\{ handled: false, reason: 'not-owner' \}\);[\s\S]{0,40}\/api\/nlcorrection/.test(nlSrvSrc));

  /* 面板「所有写入项都能用嘴改」（主人 2026-11-19：改名改不了）。
   * 这里只验识别 + 真落盘；管理类归主人、记录类归所有人，上一段已验。 */
  {
    const qq = '999002';   // 临时测试号，末尾统一清掉
    const rn = nl.deterministic('把 ' + qq + ' 的名字改成 测试名Z', { isPrivate: true });
    t('「把某号的名字改成 X」识别成改名（不是代称）', rn && rn.action === 'person_name' && rn.name === '测试名Z', JSON.stringify(rn));
    const rn2 = nl.deterministic(qq + ' 叫什么', { isPrivate: true });
    t('「某号叫什么」是查名字，不改名也不加代称', rn2 && rn2.action === 'person_query', JSON.stringify(rn2));
    // 主人真发过「100000000叫皮皮」，当时号后面直接跟中文、识别不出来 → 回「没认出指令」
    const glue = nl.deterministic('100000000叫皮皮', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true });
    t('「号叫名」粘连写法主人在私聊发 = 改名字位', glue && glue.action === 'person_name' && glue.name === '皮皮', JSON.stringify(glue));
    const glueOther = nl.deterministic('100000000叫皮皮', { platform: 'qq', uid: '777777', isPrivate: false });
    t('同句别人发 = 只记代称，不改名字位', glueOther && glueOther.action === 'alias_set', JSON.stringify(glueOther));
    const proof = nl.deterministic('证明 100000000 叫 Ayami', { platform: 'qq', uid: String(cfg.masterQQ), isPrivate: true });
    t('「证明…叫…」一律是代称举证', proof && proof.action === 'alias_set', JSON.stringify(proof));
    const fv = nl.deterministic('把 ' + qq + ' 好感改成 55', { isPrivate: true });
    t('「把某号好感改成 N」识别成好感', fv && fv.action === 'person_favor' && fv.value === 55, JSON.stringify(fv));
    const rg = nl.deterministic('把 ' + qq + ' 的地区改成 杭州', { isPrivate: true });
    t('「把某号地区改成 X」识别成地区', rg && rg.action === 'person_region' && rg.city === '杭州', JSON.stringify(rg));
    const lk = nl.deterministic('把 ' + qq + ' 的好感锁上', { isPrivate: true });
    t('「好感锁上」识别成锁定', lk && lk.action === 'person_lock' && lk.on === true, JSON.stringify(lk));
    const ta = nl.deterministic('记一下 ' + qq + ' 喜欢猫', { isPrivate: true });
    t('「记一下某号喜欢 X」识别成喜好', ta && ta.action === 'taste_add' && ta.text === '猫', JSON.stringify(ta));
    const fb = nl.deterministic('兜底池加一句「测试兜底ZZZ」', { isPrivate: true });
    t('「兜底池加一句」识别成兜底词', fb && fb.action === 'fallback_add' && fb.line === '测试兜底ZZZ', JSON.stringify(fb));
    const cs1 = nl.deterministic('这个群上下文改成10条', { isPrivate: false, convKey: 'qq_739980743' });
    t('群里「这个群上下文改成 N 条」改的是这个会话', cs1 && cs1.action === 'conv_set' && cs1.key === 'qq_739980743' && cs1.field === 'ctx', JSON.stringify(cs1));
    const cs2 = nl.deterministic('这个群只看不回', { isPrivate: false, convKey: 'qq_739980743' });
    t('「这个群只看不回」改会话 reply', cs2 && cs2.action === 'conv_set' && cs2.field === 'reply' && cs2.value === false, JSON.stringify(cs2));
    const ms = nl.deterministic('把 B站功能关了', { isPrivate: true });
    t('面板开关的中文名（B站/宝可梦/冷层记录）也能认', ms && ms.action === 'switch_set' && ms.key === 'bilibili' && ms.on === false, JSON.stringify(ms));
    const nm = nl.deterministic('凑热闹每天最多改成5句', { isPrivate: true });
    t('面板数值的中文名（凑热闹每天最多）也能认', nm && nm.action === 'num_set' && nm.key === 'chime.dailyMax' && nm.value === 5, JSON.stringify(nm));
    t('语义层能解析嵌套 JSON（以前非贪婪截断，永远 null）', /function pickJson/.test(nlSrc) && !/\\{\[\\s\\S\]\*\\?\\}/.test(nlSrc));
  }

  /* 人设覆盖（2026-11-19 主人令）：
   *   「别人说你是一个猫娘……对此人变成猫娘」「别人都能改，但不改默认值」
   *   「我说虚幻的发型改成短发，那就是直接改默认值」「对其他人和对我依旧默认虚幻」
   *   「约定人设属于文字很长时无法判定状态归属的兜底，优先级低于状态」 */
  {
    const convState = require(path.join(ROOT, 'src', 'conv-state'));
    const A = '999003', B = '999004';
    const prA = nl.deterministic('你是一个猫娘', { platform: 'qq', uid: A, isPrivate: true });
    t('「你是一个猫娘」识别成人设（不落约定）',
      prA && prA.action === 'persona_set' && prA.topic === '人设' && prA.setting === '猫娘' && prA.byMaster === false, JSON.stringify(prA));
    const prB = nl.deterministic('你的发型改成短发', { platform: 'qq', uid: A, isPrivate: true });
    t('「你的发型改成短发」识别成单项人设',
      prB && prB.action === 'persona_set' && prB.topic === '发型' && prB.setting === '短发', JSON.stringify(prB));
    t('问句 / 日常应答不当人设',
      nl.deterministic('你是谁', { isPrivate: true }) === null
      && nl.deterministic('你是猫娘吗', { isPrivate: true }) === null
      && nl.deterministic('你是不是傻', { isPrivate: true }) === null
      && nl.deterministic('你是对的', { isPrivate: true }) === null);
    t('约定人设带「约定」二字仍落约定（长文本兜底不抢）',
      (nl.deterministic('约定人设：你是一个住在海边的猫娘，喜欢下雨天', { isPrivate: true }) || {}).action === 'pact_add');

    const out1 = await nl.handleRecord({
      platform: 'qq', uid: A, nick: '甲', text: '你是一个猫娘',
      isPrivate: true, scope: '私聊', account: { platform: 'qq', id: A },
    });
    const mineA = convState.personaFor(convState.whoListOf(A)).mine;
    const mineB = convState.personaFor(convState.whoListOf(B)).mine;
    t('别人设的人设真落盘、只挂他自己（换个人还是默认的虚幻）',
      !!(out1 && out1.handled && out1.ok) && mineA.some(s => s.text === '猫娘') && mineB.length === 0,
      JSON.stringify({ out1, mineA, mineB }));
    t('别人改人设不动默认值', convState.personaFor([]).global.length === 0);

    // 状态只有一个（2026-11-19 主人令）：「状态只保留一个」，细节并进这一条，越记越细
    await nl.handleRecord({
      platform: 'qq', uid: A, nick: '甲', text: '你的发型改成短发',
      isPrivate: true, scope: '私聊', account: { platform: 'qq', id: A },
    });
    const mineOne = convState.personaFor(convState.whoListOf(A)).mine;
    t('人设只有一个槽：再设一项并进同一条，越记越细（不并存多条、也不丢前面记住的）',
      mineOne.length === 1 && /猫娘/.test(mineOne[0].text) && /短发/.test(mineOne[0].text), JSON.stringify(mineOne));

    // 这一条装不下的那部分 → 交回调用方落「约定」（约定是兜底，不是「除了单句设定全进约定」）
    const over = convState.upsertPersona(convState.personaWhoOf(A), '发丝', 'z'.repeat(495), '测试');
    const afterOver = convState.personaFor(convState.whoListOf(A)).mine;
    t('状态槽装不下时给 overflow（落约定），状态本身不变、不硬塞',
      !!over.overflow && afterOver.length === 1 && !/zzzz/.test(afterOver[0].text), JSON.stringify({ over: !!over.overflow, afterOver }));

    const out2 = await nl.handleRecord({
      platform: 'qq', uid: A, nick: '甲', text: '变回原来的样子',
      isPrivate: true, scope: '私聊', account: { platform: 'qq', id: A },
    });
    t('「变回原来的样子」只清他自己那份',
      !!(out2 && out2.handled && out2.ok) && convState.personaFor(convState.whoListOf(A)).mine.length === 0, JSON.stringify(out2));

    // 群里 @ 她说「变回原来的样子」，一样能清他自己的那份（2026-11-19 主人令）
    await nl.handleRecord({
      platform: 'qq', uid: B, nick: '乙', text: '你是一只狐狸',
      isPrivate: false, atMe: true, scope: '群940095', account: { platform: 'qq', id: B },
    });
    const outG = await nl.handleRecord({
      platform: 'qq', uid: B, nick: '乙', text: '变回原来的样子',
      isPrivate: false, atMe: true, scope: '群940095', account: { platform: 'qq', id: B },
    });
    t('对方在群里 @ 她说「变回原来的样子」也能清他自己的部分',
      !!(outG && outG.handled && outG.ok) && convState.personaFor(convState.whoListOf(B)).mine.length === 0,
      JSON.stringify(outG));

    // 主人改 = 默认值：写全局，别人也看得到；测完删掉
    const out3 = await nl.handle({ fromPanel: true, platform: 'qq', uid: '1', text: '你是一个猫娘' });
    t('主人说的人设写全局（改默认值）',
      !!(out3 && out3.handled && out3.ok) && convState.personaFor([]).global.some(s => s.text === '猫娘'), JSON.stringify(out3));
    await nl.handle({ fromPanel: true, platform: 'qq', uid: '1', text: '人设恢复默认' });
    t('主人「人设恢复默认」把默认值清掉', convState.personaFor([]).global.length === 0);
    convState.resetPersona('', '');   // 兜底：别留任何测试人设

    /* 注入链路：真进提示词，换个人一个字都不进 ——「对其他人和对我依旧默认虚幻」靠这一步兜住。 */
    try {
      const core = require(path.join(ROOT, 'src', 'core'));
      core.init(cfg);
      const P = 'a:qq:999006';
      convState.upsertPersona(P, '人设', '猫娘', '测试');
      core.setTurn('qq_zzpersona_a', { uid: '999006', platform: 'qq', isPrivate: true, gid: '', source: 'qq' });
      const m1 = await core.buildMessages('qq_zzpersona_a', '你好');
      core.setTurn('qq_zzpersona_b', { uid: '999007', platform: 'qq', isPrivate: true, gid: '', source: 'qq' });
      const m2 = await core.buildMessages('qq_zzpersona_b', '你好');
      convState.resetPersona(P, '');
      const s1 = (m1 || []).some(m => /你的人设/.test(String(m.content)));
      const s2 = (m2 || []).some(m => /你的人设/.test(String(m.content)));
      t('别人设的人设真进提示词；换个人一个字都不进', s1 && !s2, '本人 ' + s1 + ' / 别人 ' + s2);
    } catch (e) {
      t('别人设的人设真进提示词；换个人一个字都不进', false, e.message);
    }
  }

  /* 约定多条 / 优先级 / 换回（2026-11-19 主人令）：
   *   「约定是兜底。状态只有一个。约定是多个，按优先级顺序排。约定新增和触发的排到前面。
   *    如句尾加喵，或句尾加汪。状态只保留一个，但约定会全部保留，对方要求换就能捞回来原句。
   *    但指定要更换，而不是使用时，才是更改约定。」 */
  {
    const core = require(path.join(ROOT, 'src', 'core'));
    const U = '999008';
    const pa = core.pactAdd(U, '测试人', '以后每次说话结尾加个喵', '私聊', {});
    const pb = core.pactAdd(U, '测试人', '以后每次说话结尾加个汪', '私聊', {});
    const pc = core.pactAdd(U, '测试人', '碰到「何意味」就回复「够童！」', '私聊', {});
    const ids = [pa, pb, pc].map(x => x && x.id).filter(Boolean);
    t('约定能并存多条（不像状态只留一个）', ids.length === 3, JSON.stringify(ids));

    const tf = path.join(ROOT, 'src', 'data', 'topics.jsonl');
    const countLines = () => { try { return fs.readFileSync(tf, 'utf8').split('\n').filter(l => l.trim()).length; } catch { return 0; } };
    const n0 = countLines();
    const all = core.pactLines(U, { text: '你好' });
    t('同一类（句尾）多条时只生效最靠前那条，新增的排前面',
      /「汪」/.test(all) && !/「喵」/.test(all), all);
    const hit = core.pactLines(U, { text: '何意味？' });
    t('本轮撞上的约定排到最前面', /^\- 他这一轮说的就是/.test(String(hit).split('\n')[0] || ''), hit);
    t('用一次约定不算改约定（原文行数不变，只记触发）', countLines() === n0, n0 + ' -> ' + countLines());

    const sw = core.pactRestore(U, '换回句尾加喵');
    const back = core.pactLines(U, { text: '你好' });
    t('说「换回」能捞回原来那句（旧条没删，只换排序）',
      !!(sw && sw.ok) && /「喵」/.test(back) && !/「汪」/.test(back), JSON.stringify({ sw, back }));
    t('「换回」被识别成换回动作，不是又记一条新约定',
      (nl.deterministic('换回句尾加喵', { isPrivate: true }) || {}).action === 'pact_switch');

    // 清理：测试约定 / 触发记录 / 同步出来的教学条，一条都不留
    try {
      const kept = fs.readFileSync(tf, 'utf8').split('\n').filter(l => l.trim()
        && !ids.some(id => l.indexOf('"' + id + '"') >= 0));
      fs.writeFileSync(tf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    } catch { /* 清不掉不影响结论 */ }
    try {
      const up = path.join(ROOT, 'src', 'data', 'pact-usage.json');
      if (fs.existsSync(up)) {
        const u = JSON.parse(fs.readFileSync(up, 'utf8'));
        for (const id of ids) delete u[id];
        fs.writeFileSync(up, JSON.stringify(u, null, 1), 'utf8');
      }
    } catch { /* 同上 */ }
    try {
      const kd = path.join(ROOT, 'src', 'data', 'teach');
      if (fs.existsSync(kd)) {
        for (const f of fs.readdirSync(kd)) {
          const fp = path.join(kd, f);
          if (!/\.jsonl$/.test(f)) continue;
          const raw = fs.readFileSync(fp, 'utf8');
          if (raw.indexOf(U) < 0) continue;
          const kept = raw.split('\n').filter(l => l.trim() && l.indexOf(U) < 0);
          fs.writeFileSync(fp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
        }
      }
    } catch { /* 同上 */ }
  }

  /* 「别人 @ 她之后说自己叫什么」= 第一优先（2026-11-19 主人令）。 */
  {
    const ppl = require(path.join(ROOT, 'src', 'people'));
    const U = '999005';
    t('自报名字认得出来（「我叫X」是名字，「我叫什么」不是）',
      nl.extractSelfName('我叫小明') === '小明' && nl.extractSelfName('我叫什么') === '' && nl.extractSelfName('我叫你小明') === '');
    const r = await nl.handleRecord({
      platform: 'qq', uid: U, nick: '小测试', text: '@虚幻 我叫小测Z',
      isPrivate: false, atMe: true, scope: '群940095', account: { platform: 'qq', id: U },
    });
    const pid = ppl.pidOfIdAll(U);
    t('@她之后自报名字，第一优先记成代称',
      !!(r && r.handled && r.action === 'self_name') && !!pid && ppl.namesOf(pid).indexOf('小测Z') >= 0,
      JSON.stringify({ r, pid, names: pid ? ppl.namesOf(pid) : [] }));
    if (pid) ppl.removeAccount(pid, 'qq', U);
    // 建档时顺手写的「第一次相遇」和代称约定都清掉，不留假人假记录
    try {
      const df = path.join(ROOT, 'src', 'data', 'dates.json');
      const dd = JSON.parse(fs.readFileSync(df, 'utf8'));
      dd.items = (dd.items || []).filter(x => String(x && x.who || '').indexOf(U) < 0);
      fs.writeFileSync(df, JSON.stringify(dd, null, 1), 'utf8');
    } catch { /* 清不掉不影响结论 */ }
    try {
      const tf = path.join(ROOT, 'src', 'data', 'topics.jsonl');
      const kept = fs.readFileSync(tf, 'utf8').split('\n').filter(l => l.trim() && !/999005|小测Z/.test(l));
      fs.writeFileSync(tf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    } catch { /* 同上 */ }
  }

  /* 改群名功能整体删除（2026-11-19 主人令：「这个功能不需要，整个改群名功能都直接删」）。 */
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'app.js'), 'utf8');
    const qmetaSrc = fs.readFileSync(path.join(ROOT, 'src', 'qq-meta.js'), 'utf8');
    t('指令层没有改群名动作了', !/group_rename/.test(nlSrc) && nl.deterministic('把群 940095 的群名改成 测试群', { isPrivate: true }) === null);
    t('面板没有改群名接口，客户端没有 ✎ 入口',
      !/\/api\/group\/name/.test(panelSrc) && !/chat-group-rename/.test(appSrc) && !/group-name-ok/.test(appSrc));
    t('底层 setGroupName 也删了（只留 NapCat 自动拉群名）', !/setGroupName/.test(qmetaSrc));
  }

  // 清掉测试写进 topics.jsonl 的约定行 + 指令日志里测试号/测试群的行（别把测试轮次写进真实历史）
  try {
    const tf = path.join(ROOT, 'src', 'data', 'topics.jsonl');
    const kept = fs.readFileSync(tf, 'utf8').split('\n').filter(l => l.trim() && !/测试约定ZZZ/.test(l));
    fs.writeFileSync(tf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  } catch { /* 清不掉不影响结论 */ }
  try {
    const nf = path.join(ROOT, 'src', 'data', 'nl-command.jsonl');
    if (fs.existsSync(nf)) {
      const kept = fs.readFileSync(nf, 'utf8').split('\n').filter(l => l.trim()
        && !/99900[1-9]/.test(l) && !/94009[6-8]/.test(l) && !/"action":"recall"/.test(l));
      fs.writeFileSync(nf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
  } catch { /* 同上 */ }

  // 对不上时必须回「可直接复制」的具体报错，而不是一句含糊的「没敢报成功」
  t('对不上回可复制诊断串', /\[指令失败\]/.test(nlSrc)
    && /diag\('num_set'/.test(nlSrc) && /diag\('switch_set'/.test(nlSrc) && /diag\('group_/.test(nlSrc));
  t('执行异常带原始报错与出错行', /function errBrief/.test(nlSrc) && /errBrief\(e\)/.test(nlSrc) && /errBrief\(e\)/.test(qqSrc));
  t('群里纠错只记账不吞消息', /silent: !inPrivate/.test(nlSrc));

  // 测试用的临时会话键用完就清（不留空壳）
  try {
    const convFile = path.join(ROOT, 'src', 'data', 'conv-settings.json');
    const all = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    for (const k of ['qq_' + gidT, key]) {
      if (all[k] && Object.keys(all[k]).length === 0) delete all[k];
    }
    fs.writeFileSync(convFile, JSON.stringify(all, null, 1), 'utf8');
  } catch { /* 清不掉也不影响结论 */ }

  // 撤回（主人在私聊真的发过「撤回群里这句」，当时被回成「没认出指令」）
  const rcCmd = nl.deterministic('撤回群里这句', { isPrivate: true });
  t('「撤回群里这句」识别成撤回且指向群', rcCmd && rcCmd.action === 'recall' && rcCmd.inGroup === true, JSON.stringify(rcCmd));
  t('「别撤回」不是指令', nl.deterministic('别撤回这句', { isPrivate: true }) === null);
  const rcOut = await nl.handle({ platform: 'qq', uid: String(cfg.masterQQ), text: '撤回群里这句', isPrivate: true, scope: '私聊' });
  t('撤回没接上时回具体原因（可复制）',
    !!(rcOut && rcOut.handled && !rcOut.ok && /\[指令失败\]/.test(rcOut.reply)), JSON.stringify(rcOut));
  t('QQ 发出消息时留 message_id 供撤回', /function noteSent/.test(qqSrc) && /noteSent\(rec\.action/.test(qqSrc)
    && /nlCommand\.setRecaller\(recallSent\)/.test(qqSrc) && /delete_msg/.test(qqSrc));

  // 撤回测试用的是主人号，会在日志里留一条 recall——再清一遍，别把测试写进真实历史
  try {
    const nf = path.join(ROOT, 'src', 'data', 'nl-command.jsonl');
    if (fs.existsSync(nf)) {
      const kept = fs.readFileSync(nf, 'utf8').split('\n').filter(l => l.trim()
        && !/99900[1-9]/.test(l) && !/94009[6-8]/.test(l) && !/"action":"recall"/.test(l));
      fs.writeFileSync(nf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
  } catch { /* 同上 */ }

  // 记录类测试会在 bot-writes.jsonl 留一行「别人原文」，一并清掉
  try {
    const bf = path.join(ROOT, 'src', 'data', 'bot-writes.jsonl');
    if (fs.existsSync(bf)) {
      const kept = fs.readFileSync(bf, 'utf8').split('\n').filter(l => l.trim()
        && !/99900[1-9]|小测Z|测试约定ZZZ/.test(l));
      fs.writeFileSync(bf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
  } catch { /* 同上 */ }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
