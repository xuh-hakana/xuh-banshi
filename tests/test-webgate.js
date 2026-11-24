/*
 * tests/test-webgate.js — 联网闸门 + 功能清单（2026-11-22 主人令）
 *
 * 验四件事：
 *   ① 问「你有什么功能/会什么」不算要联网 → 走代码直答
 *   ② 本地知识库命中就先本地，不联网
 *   ③ 老闸查空不再在 callLLM 之前 return —— 被 @ / 私聊的轮交给我（dsh）查
 *   ④ 功能清单：单份数据、每区随机 1~3、必出条照带、平台独有全列、账号按平台互换、收尾由模型现说
 *
 * 跑法：node tests/test-webgate.js（不联网、不动线上数据）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let x = Math.imul(a ^ a >>> 15, 1 | a);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 100000000;
  };
}

(async () => {
  const core = require(path.join(ROOT, 'src', 'core'));
  const empty = { block: '', kinds: [] };

  // ===== ① 问功能：不联网 =====
  const funcQs = ['你都有什么功能啊', '你有什么功能', '你会什么', '你能干什么', '你都会啥',
    '你都有哪些爱好', '你的功能有哪些', '你有什么本事', '怎么用你', '你能帮我做什么'];
  for (const q of funcQs) {
    t('问功能不联网：' + q, core._needWeb(q, empty) === false, 'needWeb=true');
    t('问功能认得出：' + q, core._isFuncAsk(q) === true, 'isFuncAsk=false');
  }

  // ===== ② 该搜的照旧搜；本地命中就先本地 =====
  const mustSearch = ['你知道达尔文吗', '北京在哪', '搜一下烈空坐种族值', '今天天气怎么样', '你有最新新闻吗'];
  for (const q of mustSearch) t('该搜照搜：' + q, core._needWeb(q, empty) === true, 'needWeb=false');
  t('「你会做饭吗」不搜（问她自己，不是查资料）', core._needWeb('你会做饭吗', empty) === false, 'needWeb=true');
  t('本地功能词典命中 → 不联网',
    core._needWeb('抽卡是什么意思啊', { block: '【功能词典·命中】· 【抽卡】……', kinds: ['dict'] }) === false);
  t('本地教学/学到的命中 → 不联网',
    core._needWeb('redstone 回路怎么做', { block: '【学到的】……', kinds: ['learn'] }) === false);
  t('本地攻略覆盖够 → 不联网',
    core._needWeb('折射怎么打', { block: '【游戏攻略】折射怎么打：按住 R 反弹', kinds: ['guide'] }) === false);
  t('本地攻略覆盖不够 → 仍然补搜',
    core._needWeb('烈空坐种族值是多少', { block: '【游戏攻略】无关的一段', kinds: ['guide'] }) === true);

  // ===== ③ 查空不再提前 return（代码路径断言）=====
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
  t('chat() 里查空分支会标记 _webMissAgent', src.includes('msgs._webMissAgent = true'));
  t('callLLM 认 _webMissAgent（和派活轮同一套链序）', src.includes('|| messages._webMissAgent'));
  t('群里闲聊轮仍旧不接话（只静默 gid + 没@ + 没引用）', /\.gid && !_f\.atMeReal && !_f\.replyMe/.test(src));
  t('固定话术不再写死在 chat() 里（只留 intent.json 的 failText 兜底）', !src.includes('onText(noWeb)'));
  t('intent.json 的 webMissWho 是 agent（查不到由我查）',
    (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/intent.json'), 'utf8')).intent.mode.webMissWho === 'agent'; } catch (e) { return false; } })());

  // ===== ④ 功能清单：数据内容 =====
  const mdPath = path.join(ROOT, 'src', 'data', '功能清单.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  t('清单里没有「可以」二字', md.indexOf('可以') < 0, '出现了「可以」');
  for (const title of ['试试对我说', '对我发指令', '其他账号', '把你的信息悄悄告诉我', 'QQ 独有', 'B站 独有']) {
    t('清单有分区：' + title, md.indexOf('## ' + title) >= 0, '缺这个分区');
  }
  t('QQ 独有写的是保健提醒', /## QQ 独有[\s\S]*?提醒活动身体/.test(md), '没写');
  t('B站 独有写的是 /收图', /## B站 独有[\s\S]*?\/收图/.test(md), '没写');
  t('不写唱歌（没接入）', md.indexOf('唱歌') < 0, '写了唱歌');

  const qqSecs = core._capabilitySections('qq');
  const biSecs = core._capabilitySections('bili');
  const secOf = (arr, name) => arr.filter(s => s.title === name)[0] || { items: [] };
  t('试试对我说 例句 ≥10 条', secOf(qqSecs, '试试对我说').items.length >= 10, '只有 ' + secOf(qqSecs, '试试对我说').items.length);
  t('对我发指令 QQ 版 ≥4 条', secOf(qqSecs, '对我发指令').items.length >= 4, '只有 ' + secOf(qqSecs, '对我发指令').items.length);
  t('信息栏两条都是必出', secOf(qqSecs, '把你的信息悄悄告诉我').items.filter(x => x.must).length === 2, '必出条不是 2');
  t('信息栏有「你别的号」', secOf(qqSecs, '把你的信息悄悄告诉我').items.some(x => x.text.indexOf('你别的号') >= 0), '没有');
  t('代称例子是「小幻」', md.indexOf('以后叫我小幻') >= 0, '不是小幻');
  t('「老板」这个例子已改掉', md.indexOf('以后叫我老板') < 0, '还留着老板');

  // 用户侧例句：只写普通用户真能触发的；触发词/教学/主人专属一律不写
  const userSide = ['以后叫我小幻', '记到小本本：我不吃香菜', '以后每次回我结尾加个喵', '换回句尾加喵那条',
    '撤掉刚才那条约定', '撤回这一条', '你是一条猫娘', '变回原来的样子', '你说错了，别这么说',
    '帮我查查XX的攻略', 'XX 和 YY 谁更厉害', '这张图里是什么', '今天西安天气'];
  for (const w of userSide) t('用户侧例句在册：' + w, md.indexOf(w) >= 0, '缺');
  for (const w of ['早上好呀', '是不是人', '当没看见']) t('触发词类例句已下线：' + w, md.indexOf(w) < 0, '还在');
  const nlc = fs.readFileSync(path.join(ROOT, 'src', 'nl-command.js'), 'utf8');
  const recLine = (nlc.match(/const RECORD_ACTIONS = new Set\(\[([^\]]*)\]\)/) || [])[1] || '';
  for (const act of ['pact_add', 'pact_switch', 'undo_last', 'alias_set', 'memory_log', 'persona_set', 'persona_reset']) {
    t('记录类指令对所有人生效：' + act, recLine.indexOf("'" + act + "'") >= 0, 'RECORD_ACTIONS 里没有');
  }

  // ===== ④ 随机手册：长度/多样性/必出/不带独有 =====
  const cap = (() => { try { return require(path.join(ROOT, 'src', 'platform-limits')).capOf('qq') - 10; } catch (e) { return 590; } })();
  const seen = new Set();
  let allOk = true, mustOk = true, accOk = true, exclOk = true;
  for (let i = 0; i < 300; i++) {
    const s = core._capabilityText('qq', mulberry32(i + 1));
    if (!s || s.length > cap) allOk = false;
    seen.add(s);
    if (s.indexOf('你别的号') < 0) mustOk = false;
    if (s.indexOf('b23.tv/6cKFSj2') < 0 || s.indexOf('100000000') >= 0) accOk = false;
    if (s.indexOf('/收图') >= 0 || s.indexOf('提醒活动身体') >= 0) exclOk = false;
  }
  t('随机 300 次都不空且 ≤ cap-10（' + cap + '）', allOk, '长度超了或为空');
  t('随机 300 次 ≥50 种（每区真在随机）', seen.size >= 50, '只有 ' + seen.size + ' 种');
  t('必出条每次都在（「你别的号」）', mustOk, '有样本漏了');
  t('QQ 版其他账号只给 B站、不给 QQ 号', accOk, '账号没换');
  t('随机手册里不带独有功能', exclOk, '混进 /收图 或 保健提醒');

  // ===== ④ 平台独有：全列、两次一致 =====
  const qqEx = core._capabilityExclusive('qq');
  const biEx = core._capabilityExclusive('bili');
  t('QQ 独有全列两次一致', qqEx === core._capabilityExclusive('qq'), '不确定');
  t('QQ 独有含保健提醒、不含 /收图', qqEx.indexOf('提醒活动身体') >= 0 && qqEx.indexOf('/收图') < 0, qqEx);
  t('B站 独有含 /收图、不含保健提醒', biEx.indexOf('/收图') >= 0 && biEx.indexOf('提醒活动身体') < 0, biEx);
  t('B站 版其他账号只给 QQ 号', biEx.length > 0 && core._capabilityText('bili', mulberry32(7)).indexOf('100000000') >= 0, '没给 QQ 号');

  // ===== ④ 平台问法识别 =====
  const platCases = [
    ['你在B站有什么功能啊', 'bili'], ['B站有什么功能', 'bili'], ['你在哔哩哔哩有哪些功能', 'bili'],
    ['你在QQ有什么功能', 'qq'], ['群里有什么功能呀', 'qq'], ['你有什么功能', ''], ['你的功能有哪些', ''],
  ];
  for (const [q, want] of platCases) t('平台问法：' + q + ' → ' + (want || '泛问'), core._isPlatformFuncAsk(q) === want, '结果是 ' + core._isPlatformFuncAsk(q));

  // ===== ④ 收尾由模型现说（代码断言）=====
  t('有收尾提示词（只让它说收尾，不喂清单）', typeof core._closingPrompt === 'string' && core._closingPrompt.indexOf('收尾') >= 0);
  t('chat() 直答分支调 closingLine 并拼进同一条', src.includes('await closingLine(msgs, k)') && src.includes("fixedAns + '\\n|||\\n' + tail"));
  t('收尾不写进数据文件', md.indexOf('收尾') < 0 || md.split('\n').filter(l => l.trim().startsWith('-') && l.indexOf('收尾') >= 0).length === 0);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 过 / ' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
})();
