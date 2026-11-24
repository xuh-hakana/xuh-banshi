/*
 * tests/test-pacts.js — 约定拆件 / 命中 / 符号保护 自测（2026-11-06）
 *
 * 她原话：「那一长串都能触发回【够童！】而不是只有何意味。以及【Ciallo～(∠・ω< )⌒☆】和
 * 【够童！】的符号不要丢。以后的约定也都识别好了哪些是约定的符号，哪些是修饰。」
 *
 * 纯只读 + 可写（pactAdd 会落盘，跑完自动还原 topics.jsonl）。
 * 不调模型，断言打在 core.pactSplit / pactHit / pactLines / stripOtherPacts 的真实产物上。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'core.js');
const TOPICS = path.join(ROOT, 'src', 'data', 'topics.jsonl');
const WRITES = path.join(ROOT, 'src', 'data', 'bot-writes.jsonl');
const PEOPLE = path.join(ROOT, 'src', 'data', 'people.json');
const DATES = path.join(ROOT, 'src', 'data', 'dates.json');

const origTopics = fs.readFileSync(TOPICS, 'utf8');
const origWrites = fs.existsSync(WRITES) ? fs.readFileSync(WRITES, 'utf8') : null;
const origPeople = fs.readFileSync(PEOPLE, 'utf8');
const origDates = fs.existsSync(DATES) ? fs.readFileSync(DATES, 'utf8') : null;

const core = require(CORE);
const cfg = require(path.join(ROOT, 'src', 'config')).load();
core.init(cfg);

const BAI = '100000000';        // 白
const HD = '100000000';          // 企鹅火丁
const MASTER = '100000000';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !extra ? '' : '  『' + extra + '』'));
  cond ? pass++ : fail++;
};

try {
  /* ---------- 1. 拆件：哪些是话术、哪些是修饰 ---------- */
  console.log('[拆件]');
  const a = core.pactSplit('碰到童站评论就回一句「够童！」，别解释');
  t('say = 够童！（带感叹号）', a.say === '够童！', JSON.stringify(a.say));
  t('note = 别解释（修饰不混进话术）', a.note === '别解释' && a.say.indexOf('别解释') < 0);
  t('when = 童站评论', a.when.length === 1 && a.when[0] === '童站评论', JSON.stringify(a.when));
  t('场景类没有 sig（发送层不会剥它）', a.sig === '' && a.kind === 'scene');

  const b = core.pactSplit('你以后发言的结尾还需要加个Ciallo～(∠・ω< )⌒☆');
  t('说话方式类：say 保留 ～ 和括号', b.say === 'Ciallo～(∠・ω< )⌒☆', JSON.stringify(b.say));
  t('说话方式类：sig 与 say 一致', b.sig === b.say && b.kind === 'style');

  const c = core.pactSplit('每次他叫我都要叫他「老板」');
  t('引号里的才算记号（不是「他老板」）', c.sig === '老板', JSON.stringify(c.sig));

  const d = core.pactSplit('以后每条结尾都加个喵～');
  t('短记号也保留符号（喵～）', d.say === '喵～', JSON.stringify(d.say));

  /* ---------- 2. 命中：那一长串每一条都算 ---------- */
  console.log('[命中]');
  // 键现在是 'platform:id'（qq:100000000），不再拿裸号硬比对——按 topic 找，
  // 归属对不对由下面「白白两个号读同一份」「别人拿不到」那几项去验。
  const p = core.pactParts(core.readPromises().find(x => x.qq && /白的约定/.test(String(x.topic))) || {});
  t('约定里存了整串条件（≥15 条）', (p.when || []).length >= 15, (p.when || []).length + ' 条');
  const hitCases = ['何意味？', '我这5级号能进吗', '我想体验一下已读乱回', '什么游戏', '他们为什么打架',
    '不是哥们', 'yy在哪', '点赞', '合影', '问了吗', '童站评论', '让我看看你的相册第3张图'];
  const missCases = ['今天好热', '晚上吃什么', '你主人呢'];
  for (const s of hitCases) t('触发：' + s, !!core.pactHit(p, s));
  for (const s of missCases) t('不触发：' + s, !core.pactHit(p, s));

  /* ---------- 3. 注入：给原话，不写成强制命令（2026-11-20 主人令）---------- */
  console.log('[注入]');
  const line = core.pactLines(BAI, { text: '何意味？' });
  t('注入里有「够童！」带感叹号', line.includes('「够童！」'), line);
  t('注入只给他的原话，不写「原样回 / 不许改」这种命令', !/原样回|不许改/.test(line), line);
  t('没撞上条件时一个字都不提（省 token）', core.pactLines(BAI, { text: '今天好热' }) === '');

  const hdLine = core.pactLines(HD, { text: '在吗' });
  t('火丁：注入完整 Ciallo（～ 和 ∠・ω< 都在）', hdLine.includes('Ciallo～(∠・ω< )⌒☆'), hdLine);
  t('火丁：注入里不带「不许改不许省」', !/一个都不许改/.test(hdLine), hdLine);

  t('约定不串人：凑肥鱼没有白的', core.pactLines('100000000', { text: '何意味？' }) === '');

  /* ---------- 4. 发送层：剥别人的记号，别剥自己的话 ---------- */
  console.log('[发送层]');
  const leaked = core.stripOtherPacts('好的我知道啦 Ciallo～(∠・ω< )⌒☆', MASTER);
  t('回主人时把火丁的记号剥干净', leaked.indexOf('Ciallo') < 0, leaked);
  t('回主人时正文没被误删', leaked.includes('好的我知道啦'), leaked);
  const keep = core.stripOtherPacts('够童！', BAI);
  t('白的「够童！」不会被当成别人的记号剥掉', keep === '够童！', keep);
  const keep2 = core.stripOtherPacts('够童！', MASTER);
  t('回主人时的「够童！」也不剥（场景类不收 sig）', keep2 === '够童！', keep2);

  /* ---------- 5. 自动识别：以后她说「碰到 X 就回 Y」也要能录进来 ---------- */
  console.log('[自动识别]');
  t('认场景类：碰到这些评论，你回复一个够童就行', !!core.pactOf('碰到这些评论，你回复一个够童就行'));
  t('认场景类：看到有人刷屏就说别刷了', !!core.pactOf('看到有人刷屏就说别刷了'));
  t('认说话方式类：以后每条结尾都加个喵～', !!core.pactOf('以后每条结尾都加个喵～'));
  t('不误收：今天遇到一只猫', !core.pactOf('今天遇到一只猫'));
  t('不误收：如果你不来我就走', !core.pactOf('如果你不来我就走'));

  /* ---------- 6. 落盘：新约定自动带上拆好的字段 ---------- */
  console.log('[落盘]');
  const TMP = '100000000';
  const it = core.pactAdd(TMP, '自测小人', '碰到测试词就回一句「测试话！」', '自测', { when: ['测试词'] });
  t('pactAdd 落盘成功', !!it && it.kind === 'promise');
  t('落盘带 say（含标点）', it && it.say === '测试话！', it && JSON.stringify(it.say));
  t('落盘带 when', it && Array.isArray(it.when) && it.when[0] === '测试词');
  t('场景类落盘 sig 为空', it && it.sig === '');

  /* ---------- 7. 全平台：同一个人 QQ / B站 两头共用一份约定 ----------
   * 她原话（2026-11-06）：「100000000 白的b站。请保证约定和喜好等等都是全平台生效」。
   * 造一个临时人物 + 两个账号来测，不动真实的人；跑完还原 people.json。 */
  console.log('[全平台]');
  const TMPQ = '100000000', TMPB = '100000000';
  const people = require(path.join(ROOT, 'src', 'people'));
  const pid = people.ensure('qq', TMPQ, { nick: '自测甲' });
  people.addAccount(pid, 'bili', TMPB);
  t('临时人物的键集含两个平台', (people.keySetOf('bili:' + TMPB).keys || []).indexOf(TMPQ) >= 0);

  core.pactAdd(TMPQ, '自测甲', '碰到自测算就回一句「自测好！」', '自测', { when: ['自测算'] });
  t('QQ 记的约定，B站 号这边也读得到',
    core.pactLines('bili:' + TMPB, { text: '自测算' }).includes('自测好！'));
  // 她 2026-11-06 追加：「QQ 号也要加这个前缀，后续增加小红书抖音小黑盒平台都不能有问题」
  const itQ = core.pactAdd(TMPQ, '自测甲', '碰到自测算零就回一句「自测零！」', '自测', { when: ['自测算零'] });
  t('QQ 落盘键也带前缀（qq:123，不裸存）', !!itQ && itQ.qq === 'qq:' + TMPQ, itQ && itQ.qq);
  // 老数据的裸号键必须还能读（存量 198 条裸 QQ 键，一条都不迁）
  fs.appendFileSync(TOPICS, JSON.stringify({
    id: 'Trawkey' + Date.now().toString(36), t: new Date().toISOString(),
    kind: 'promise', type: 'manual', state: 'kept', who: '自测甲', qq: TMPQ,
    scope: '自测', nick: '自测甲', topic: '跟自测甲的约定',
    text: '碰到自测裸号就回一句「裸号好！」', sig: '', say: '裸号好！', when: ['自测裸号'], note: '',
  }) + '\n', 'utf8');
  t('老数据的裸号键仍能读到（不迁移也不丢）',
    core.pactLines('qq:' + TMPQ, { text: '自测裸号' }).includes('裸号好！')
    && core.pactLines(TMPQ, { text: '自测裸号' }).includes('裸号好！'));

  const it2 = core.pactAdd('bili:' + TMPB, '自测甲', '碰到自测算二就回一句「自测二！」', '自测', { when: ['自测算二'] });
  t('B站 落盘键带平台前缀（不裸存 UID）', !!it2 && it2.qq === 'bili:' + TMPB, it2 && it2.qq);
  t('B站 记的约定，QQ 号这边也读得到',
    core.pactLines(TMPQ, { text: '自测算二' }).includes('自测二！'));
  t('同一个人的两个号不算「别人定的」，不重复提醒',
    !core.otherPactHints('bili:' + TMPB).some(x => /自测/.test(String(x.nick || ''))));

  // 真实档案（白）：QQ 定的「够童」在 B站 侧也命中；别人的约定不许串过来
  t('白的 QQ 约定在 B站 号上命中',
    core.pactLines('bili:100000000', { text: '何意味？' }).includes('够童！'));
  t('白的两个号读到同一份（QQ / B站 输出一致）',
    core.pactLines('bili:100000000') === core.pactLines(BAI));
  t('B站 号也不串火丁的记号',
    !core.stripOtherPacts('Ciallo～(∠・ω< )⌒☆', 'bili:100000000').includes('Ciallo'));
  t('白的记号在 B站 侧不被剥', core.stripOtherPacts('够童！', 'bili:100000000') === '够童！');

  /* ---------- 8. 以后加平台（小红书 / 抖音 / 小黑盒）不能有问题 ----------
   * 她原话（2026-11-06）：「后续增加小红书抖音小黑盒平台都不能有问题」。
   * 验三件事：账号 id 带字母能建档、落盘键带自己的平台前缀、跨平台读得到同一份。 */
  console.log('[扩展平台]');
  const XHS = 'xhs_self_test_01', DY = '88887777';
  t('小红书号（带字母）能挂到人物下', people.addAccount(pid, 'xhs', XHS));
  t('抖音号（纯数字）能挂到人物下', people.addAccount(pid, 'douyin', DY));
  t('中文平台名归一（小红书 → xhs）', people.splitUid('小红书:' + XHS).platform === 'xhs');
  const itX = core.pactAdd('xhs:' + XHS, '自测甲', '碰到自测小红书就回一句「小红书好！」', '自测', { when: ['自测小红书'] });
  t('小红书落盘键是 xhs:xxx', !!itX && itX.qq === 'xhs:' + XHS, itX && itX.qq);
  t('小红书记的约定，QQ / B站 / 抖音 都读得到',
    core.pactLines(TMPQ, { text: '自测小红书' }).includes('小红书好！')
    && core.pactLines('bili:' + TMPB, { text: '自测小红书' }).includes('小红书好！')
    && core.pactLines('douyin:' + DY, { text: '自测小红书' }).includes('小红书好！'));
  t('一条约定只认自己那个人（小红书号没串到别人）',
    !core.pactLines('qq:100000000', { text: '自测小红书' }).includes('小红书好！'));
  // 档案里有的号按档案认平台；档案里没有、又带字母的，不许猜成 QQ（猜错会把小红书号写成 qq:xxx）
  t('档案里的号按档案认平台', people.keyOf(XHS) === 'xhs:' + XHS, people.keyOf(XHS));
  t('查不到的字母裸号不冒充 QQ',
    people.keyOf('nobody_xyz_9') === 'nobody_xyz_9', people.keyOf('nobody_xyz_9'));
} finally {
  fs.writeFileSync(TOPICS, origTopics, 'utf8');
  fs.writeFileSync(PEOPLE, origPeople, 'utf8');
  if (origDates !== null) fs.writeFileSync(DATES, origDates, 'utf8');
  if (origWrites !== null) fs.writeFileSync(WRITES, origWrites, 'utf8');
}

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
