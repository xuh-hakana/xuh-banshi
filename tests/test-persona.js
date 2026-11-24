/*
 * tests/test-persona.js — 人设提示词构建自检（纯只读）
 *
 * 这是干什么的：改完人设文件、或 core.js 里跟提示词有关的代码后跑一遍，确认
 *   ①「应对」三块真的进了提示词，不是只剩个标题
 *   ② 按说话人挑对块：主人 → 我，群友 → 别人
 *   ③ 单人约定只给本人，不串给所有人
 *
 * 什么时候跑：node tests/test-persona.js（用 __dirname 定位，不挑当前目录）
 *
 * 为什么要有它（2026-11-04 真事）：readResponseBlocks 的缓存变量被声明成 const，
 *   函数内却重新赋值 → 运行时报错被 catch 静默吞掉 → 三块全空、整个人设「应对」
 *   从提示词里消失。当时 node --check 通过、独立脚本复刻逻辑也通过，都没测出来。
 *   所以这里一律打真实运行时产物（systemPrompt / buildMessages），不复刻实现。
 *
 * 和另外两个脚本分工（各管各的，不重叠）：
 *   test-all.js    = 约定 / 话题 / 日志的「写入」链路（会临时改数据再还原）
 *   test-people.js = 人物模型：好感 / 合并 / 分层 / 镜像
 *   本脚本         = 提示词「怎么拼」+ 源码守卫（只读，钉住不许退回）；不写数据、不调模型、不联网
 *   注：「主人必回」6 条守卫放这里，因为 test-all.js 依赖 8799 面板、独立跑不了；
 *       守卫只核对源码落点在不在，不复刻实现、不发 LLM、不占 token。改实现时同步改断言，别删断言。
 *
 * 失败先查：node --check src/core.js → 再看 readResponseBlocks / systemPrompt /
 *   buildMessages 三处有没有被动过。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);                 // core 里有按相对路径读 data/ 的地方，统一对齐
const DOC = path.join(ROOT, 'src', 'soul', 'H-全聊天', '3-应对.md');

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

// 只从文档取「每块第一条规则」当对照文本；判断本身一律打在运行时产物上。
// 这里解析文件是为了拿对照句，不是验证解析逻辑，跟上次踩的坑不是一回事。
function docFirstRules() {
  const raw = fs.readFileSync(DOC, 'utf8');
  const b = { 公共: [], 我: [], 别人: [] };
  let cur = '';
  for (const line of raw.split('\n')) {
    const m = line.match(/^##\s*(公共|我|别人)\s*$/);
    if (m) { cur = m[1]; continue; }
    if (cur) b[cur].push(line);
  }
  const first = k => (b[k] || []).find(l => /^\s*-\s+\S/.test(l)) || '';
  return { 公共: first('公共'), 我: first('我'), 别人: first('别人') };
}

(async () => {
  const core = require(path.join(ROOT, 'src', 'core'));
  const guides = require(path.join(ROOT, 'src', 'guides'));
  const cfg = require(path.join(ROOT, 'src', 'config')).load();
  core.init(cfg);                    // 必须走真实初始化：裸 require 时 cfg 还没赋值
  // 断网桩：问攻略那句会让 buildMessages 真去联网搜（还会撞 429）。
  // 只改内存里的这个函数，不写文件、不碰线上进程——自检保持「不联网」。
  try { require(path.join(ROOT, 'src', 'websearch')).search = async () => ''; } catch {}
  // 落盘桩（2026-11-07 补）：buildMessages 命中「别人教她」时会真调 guides.learnTeach 写
  // data/guides/学到的.md 和工作日志。自检不写数据，这里直接拦掉，只验提示词。
  const _learnOrig = guides.learnTeach;
  guides.learnTeach = () => ({ ok: false, dry: true });

  // ===== A. 文档本体 =====
  t('应对文档存在', fs.existsSync(DOC), DOC);
  const rules = docFirstRules();
  t('公共 / 我 / 别人 三块都有规则', !!(rules.公共 && rules.我 && rules.别人),
    '有一块是空的；检查 ## 标题是不是写成严格的「## 公共」等');

  // ===== B. 全局层：systemPrompt（公共常驻、单人约定不进全局）=====
  const sp = String(core.systemPrompt() || '');
  t('systemPrompt 能生成', sp.length > 1000, '长度=' + sp.length);
  t('公共块标题进了 systemPrompt', sp.includes('## 应对·公共（对所有人都这样）'),
    '公共块整块没进提示词；回顾 2026-11-04 的 readResponseBlocks const bug');
  t('公共块正文真进去了（不是空壳）', !!rules.公共 && sp.includes(rules.公共.trim()),
    '只有标题、没有正文');
  t('公共块没被重复灌两遍', (sp.match(/## 应对·公共/g) || []).length === 1,
    'readSoul 可能又把 3-应对.md 拼了一遍');
  t('全局提示词不含单人约定 Ciallo', !/Ciallo/i.test(sp),
    '带 qq 的单人约定漏进全局，会串给所有人');
  t('systemPrompt 不含 per-turn 的「应对·本场」', !sp.includes('## 应对·本场'));

  // ===== C. 按说话人层：buildMessages =====
  const master = String(cfg.masterQQ || (cfg.masters || [])[0] || '');
  async function turn(label, uid, nick) {
    const k = 'persona_selfcheck_' + label;   // 只是内存 Map 的键，不落盘
    core.setTurn(k, { uid, nick, gid: '100000000', atMe: true, scope: '群100000000' });
    const msgs = await core.buildMessages(k, '你好呀');
    // 第一条是 systemPrompt 本体，后面才是这一轮按人注入的；分开看才判得准
    return msgs.slice(1).map(m => String(m.content || '')).join('\n');
  }
  const HIS_SIG = 'Ciallo～(∠・ω< )⌒☆';                    // 完整记号：～ 和括号都不许少
  const HIS_PACT = '- 回他时结尾原样带上「' + HIS_SIG + '」';   // 2026-11-06 改成结构化注入（原话→原样说出口的那截）
  const PACT_HEAD = '- 回他时结尾原样带上';                 // 结构化注入的行首（别人那块里只会出现引用原文，不会以这个开头）
  const NO_COPY = '不许套用到眼前这个人身上';

  const me = await turn('master', master, '主人');
  // 2026-11-07：长期记忆正本必须每轮真读（不是摆设文件），且只进「给模型看的」那一小段。
  const mem = require(path.join(ROOT, 'src', 'memory'));
  const lm = String(mem.longForPrompt() || '');
  // 2026-11-09 她定：第一档做不到就别删第二档。这句改由「发送前整理提示词的代码」生成，正本里不留内容。
  t('长期记忆正本留两段结构、给模型看的那段为空', (() => {
    const raw = String(mem.readLongRaw() || '');
    return /^##\s*每轮给模型看的\s*$/m.test(raw)
      && /^##\s*项目档案（不进提示词）\s*$/m.test(raw)
      && !String(mem.longForPrompt() || '').trim();
  })());
  t('第 2 档不删：那句由第 1 档的代码拼进提示词，不用输出拦截/重发', (() => {
    const c = require('fs').readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    const RULE = '主人定的规矩不能改写成自己的话去解释；被问到就按规矩做，不背规矩原文。';
    // 第 1 档：buildMessages 里由代码生成，和正本内容并成同一块（不新增提示块、通道保留）
    const first = c.includes("const builtIn = '- " + RULE + "'")
      && c.includes('[builtIn, fromFile].filter(Boolean).join') && c.includes('if (lm) msgs.push');
    // 第 2 档：这句真的进了这一轮提示词
    const second = me.includes('## 一直记着的事') && me.includes(RULE);
    // 最低两档不许用：闸门里不许再出现「逐字背规矩」「内部设定」两类判断
    const noLast = !/if \(\['主人定的规矩/.test(c) && !c.includes('我被(?:设定|设置)成');
    return first && second && noLast;
  })());
  // 00:06:31 根因（2026-11-09 定位）：模型在答提示词里「谁说过什么话」的否定句。
  t('本轮事实不再写「有没有引用你的话：**没有**」这类否定式问答', (() => {
    const c = require('fs').readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    return !c.includes('对方有没有引用你的话') && !c.includes('群里既没有 @ 你，也没有引用你的话')
      && c.includes('## 本轮事实') && c.includes("- 这一轮：");
  })());
  t('项目档案段不进提示词', !me.includes('项目档案（不进提示词）') && !me.includes('物理分离到'),
    '档案段进提示词会白占 token');
  t('主人这轮注入的是「我」块',
    me.includes('这一轮跟你说话的是**主人本人**') && !!rules.我 && me.includes(rules.我.trim()),
    '没注入我块，或注入的是空块');
  t('主人这轮没拿到别人的 Ciallo 约定', !me.includes(PACT_HEAD));
  t('主人这轮有「不许套用」提醒', me.includes(NO_COPY));

  const qh = await turn('qiehuo', '100000000', '企鹅火丁');
  t('企鹅火丁这轮注入的是「别人」块',
    qh.includes('这一轮跟你说话的不是主人') && !!rules.别人 && qh.includes(rules.别人.trim()));
  t('企鹅火丁拿到他自己的 Ciallo 约定', qh.includes(HIS_PACT), '按对应人物回没生效');
  t('企鹅火丁这轮不弹「不许套用」', !qh.includes(NO_COPY));

  const cy = await turn('coufei', '100000000', '凑肥鱼');
  t('凑肥鱼这轮注入的是「别人」块', cy.includes('这一轮跟你说话的不是主人'));
  t('凑肥鱼没拿到企鹅火丁的 Ciallo 约定', !cy.includes(PACT_HEAD), '约定串人了');
  t('凑肥鱼这轮有「不许套用」提醒', cy.includes(NO_COPY));

  // ===== D. 数据层：按人取约定 =====
  t('pactLines(企鹅火丁) 有 Ciallo', /Ciallo/i.test(String(core.pactLines('100000000') || '')));
  t('pactLines(凑肥鱼) 为空', String(core.pactLines('100000000') || '').trim() === '');
  t('otherPactHints 拿得到企鹅火丁的记号',
    (core.otherPactHints('0') || []).some(x => String(x.sig || '').includes('Ciallo')));

  // ===== D2. 应对场合物理分离（2026-11-07 主人定：后续会越积越多，趁现在拆文件）=====
  // 盯四件事：①正本不再有 scene 标记 ②五份场合文件都在且非空
  // ③命中才注入、未命中不灌（省 token）④她的举例逐字搬到新文件里了
  const RESP_DIR = path.join(ROOT, 'src', 'soul', 'H-全聊天', '应对');
  const sceneFiles = ['我-被夸.md', '我-被怪.md', '别人-被围观.md', '被提问-被需要.md', '被教会-学到了.md'];
  t('3-应对.md 正本里不再有 scene 标记', !/<!--\s*scene:/.test(fs.readFileSync(DOC, 'utf8')),
    '场合段没搬干净，正本里还留着标记');
  t('五份场合文件都在且非空', sceneFiles.every(f => {
    try { return fs.readFileSync(path.join(RESP_DIR, f), 'utf8').trim().length > 20; } catch { return false; }
  }), 'soul/H-全聊天/应对/ 缺文件，那个场合就没规矩了');
  t('她的举例逐字搬到了我-被夸.md',
    fs.readFileSync(path.join(RESP_DIR, '我-被夸.md'), 'utf8').includes('才、才没有呢，真的吗？')
    && fs.readFileSync(path.join(RESP_DIR, '我-被夸.md'), 'utf8').includes('嘻嘻，躲过去了'));
  t('她的道歉举例逐字搬到了我-被怪.md',
    fs.readFileSync(path.join(RESP_DIR, '我-被怪.md'), 'utf8').includes('对不起嘛…我刚刚嘴太快了'));
  const masterSay = async (key, text) => {
    core.setTurn(key, { uid: master, nick: '主人', gid: '100000000', atMe: true });
    const msgs = await core.buildMessages(key, text);
    return msgs.slice(1).map(m => String(m.content || '')).join('\n');
  };
  const praise = await masterSay('resp_praise', '哇你也太厉害了');
  t('主人夸 → 注入我-被夸，不注入道歉举例',
    praise.includes('才、才没有呢，真的吗？') && !praise.includes('对不起嘛…我刚刚嘴太快了'));
  const blame = await masterSay('resp_blame', '你怎么这么说，这话说得真难听');
  t('主人质问 → 注入我-被怪，不注入被夸例句',
    blame.includes('对不起嘛…我刚刚嘴太快了') && !blame.includes('才、才没有呢，真的吗？'));
  const calm = await masterSay('resp_calm', '今天天气不错');
  t('普通闲聊 → 三份场合段都不灌',
    !calm.includes('才、才没有呢，真的吗？') && !calm.includes('对不起嘛…我刚刚嘴太快了')
    && !calm.includes('我是幽灵啦'));
  core.setTurn('resp_watch', { uid: '100000000', nick: '凑肥鱼', gid: '100000000', atMe: true });
  const watch = (await core.buildMessages('resp_watch', '这机器人是不是 AI 啊'))
    .slice(1).map(m => String(m.content || '')).join('\n');
  t('群友围观 → 注入别人-被围观', watch.includes('我是幽灵啦'));
  t('场合段不带文件头注释', !watch.includes('<!-- 场合') && !praise.includes('<!-- 场合'));

  // 2026-11-07 新增两个场合（她定：被提问＝被需要、被教会＝学到了，这两个是她存在的理由）
  // 关键点：both=true，主人和陌生人一视同仁，不许对陌生人敷衍。
  const NEED = '有人问我事情，就是有人需要我';
  const TEACH = '有人教我，就是学到了新东西';
  core.setTurn('resp_ask_stranger', { uid: '100000000', nick: '凑肥鱼', gid: '100000000', atMe: true });
  const askStranger = (await core.buildMessages('resp_ask_stranger', '光合作用是什么呀'))
    .slice(1).map(m => String(m.content || '')).join('\n');
  t('陌生人提问 → 注入「被需要」', askStranger.includes(NEED),
    '陌生人问事不给她「被需要」，等于对陌生人和熟人两套脸');
  const askMaster = await masterSay('resp_ask_master', '这个是怎么回事');
  t('主人提问 → 同样注入「被需要」', askMaster.includes(NEED));
  core.setTurn('resp_teach', { uid: '100000000', nick: '凑肥鱼', gid: '100000000', atMe: true });
  const taught = (await core.buildMessages('resp_teach', '我教你啊，猫其实怕黄瓜'))
    .slice(1).map(m => String(m.content || '')).join('\n');
  t('别人教她 → 注入「学到了」', taught.includes(TEACH));
  t('普通闲聊不灌「被需要 / 学到了」',
    !calm.includes(NEED) && !calm.includes(TEACH) && !blame.includes(NEED) && !blame.includes(TEACH),
    '这两个场合段平时不该进提示词，否则每轮白烧 token');
  t('被提问段里带了「不许编」的硬话', askStranger.includes('不许编数字'), '查不到就编，比不答更糟');

  // ===== E. 按使用场景挑段（2026-11-05 加）=====
  // 2-说话.md 的「答游戏攻略」「什么时候兴奋」不再常驻，改成关键词命中才注入。
  // 这里盯两件事：①平时不灌（省 token）②命中时真给（不是摘了忘接）。
  // 禁令类小节（唱歌、记东西）必须还常驻——摘掉等于让坏行为回潮。
  t('常驻不含场景节「答游戏攻略」', !sp.includes('答游戏攻略'),
    '还在常驻里；stripScenes 没摘到（标题被改名？）');
  t('常驻不含场景节「什么时候兴奋」', !sp.includes('什么时候兴奋'));
  t('禁令节「唱歌和翻唱」仍常驻', sp.includes('唱歌和翻唱'),
    '禁令被误摘，群里点歌就会照唱');
  t('禁令节「记东西」仍常驻', sp.includes('### 记东西'));
  // 接龙（2026-11-22 加）：群友发 byd，虚幻回了「比亚迪」，把缩写展开成正经答案，链当场就断了。
  // 钉四件事：①按形式接龙这条常驻 ②只发那一个词 ③接不完隔三句、想不出就不回 ④负面规则（不许展开全称）在。
  t('常驻含接龙规则：按形式接、只发一个词、隔三句、想不出就不回',
    sp.includes('接龙就接同形式的词') && sp.includes('只发那个词')
    && sp.includes('隔三句再回一个') && sp.includes('想不到合适的词或成语就不回'),
    '接龙规则被摘掉或删了，群里再起一个 byd 又会答成比亚迪');
  t('接龙里钉死了「不许展开全称」', sp.includes('不许把缩写展开成全称'),
    '负面规则没了，模型就会好心把梗解释一遍，接龙照样死');
  // 成语接龙（2026-11-22 加）：群友整条只发一个四字成语，她接一个成语，末字抵首字（同音也行）。
  // 但四个字的普通词不触发——不许把「今天好累」当成语硬凑一个回去。
  t('常驻含成语接龙：只认成语、末字抵首字',
    sp.includes('起成语接龙') && sp.includes('只认成语') && sp.includes('末字'),
    '成语接龙规则没了，群里发个成语她只会解释一遍');
  t('四字词语不触发成语接龙',
    sp.includes('四个字的普通词') && sp.includes('隔三句再回一个'),
    '触发边界没了，四个字的普通词也会被当成接龙硬接');
  // 结束词（2026-11-22 加）：接龙要把词往表里引，由她自己发出收尾，发完不再接。
  // 三个词来自 3-接龙结束词.md —— 能读到就说明 readSoul 把 F 层新文件自动收进来了。
  t('常驻含结束词规则：自己引、自己发、一轮只收一次',
    sp.includes('把链往结束词上引') && sp.includes('我自己发出来') && sp.includes('一轮接龙只收一次'),
    '结束词规则没了，链会一直拖着收不了尾');
  t('常驻里有结束词表（为所欲为/有一说一/原神牛逼）',
    sp.includes('为所欲为') && sp.includes('有一说一') && sp.includes('原神牛逼'),
    '3-接龙结束词.md 没被读进提示词，她自己不知道往哪收');

  const say = async (key, text) => {
    core.setTurn(key, { uid: '100000000', nick: '凑肥鱼', gid: '100000000', atMe: true });
    const msgs = await core.buildMessages(key, text);
    return msgs.slice(1).map(m => String(m.content || '')).join('\n');
  };
  const game = await say('scene_game', '水系那个boss满级多少');
  t('问攻略 → 场景节注入', game.includes('这一轮用得上的规矩') && game.includes('满级 60'),
    '摘出去了却没接回来，问攻略会按闲聊答');
  const plain = await say('scene_plain', '今天好困呀');
  t('普通闲聊 → 不注入场景节', !plain.includes('这一轮用得上的规矩'));

  // 认节四级兜底 + 认不出就报警（2026-11-06 定：不静默退回常驻，直接私信主人）。
  // 这 3 条防两件事：①真改了标题却没人发现（认不出会私信）②标记注释漏进提示词白白占 token。
  const sst = core.sceneStatus();
  t('两节都认得出（不会误发私信）', sst.found.length === 2 && sst.lost.length === 0,
    '认不出的节会私信主人：' + JSON.stringify(sst.lost));
  t('常驻里没有认节标记注释', !sp.includes('scene:game') && !sp.includes('scene:hype'),
    '标记漏进提示词，白占 token');
  t('命中注入的正文也不带标记', !game.includes('scene:game'));

  // ===== F2. 攻略标记（2026-11-06 加）=====
  // 规矩「新增攻略都要打标记」，但缺了由机器人静默自愈，不私信、不打扰她。
  // 这 4 条锁住：①三份攻略都打了标记 ②检索进提示词的正文不带标记 ③标记写在文件第一行 ④缺标记能自愈且不丢正文。
  const gst = core.guideStatus();
  t('攻略都打了标记', gst.found.length >= 3 && gst.lost.length === 0,
    '漏打标记的攻略：' + JSON.stringify(gst.lost));
  t('攻略搜索（注入提示词）不带标记注释', !guides.search('折射 钓鱼 大食人鱼 满级', 3).includes('<!-- guide:'),
    '标记漏进提示词，白占 token');
  t('攻略标记写在文件第一行', (gst.found || []).every(n =>
    (guides.guideRead(n).content || '').trimStart().startsWith('<!-- guide:')),
    '标记没放在第一行，认节不稳');

  // 真造一份没标记的，验证机器人自己补好、正文一个字不动（不再私信打扰）
  const tmpName = '自检临时攻略';
  const tmpFile = path.join(ROOT, 'src', 'data', 'guides', tmpName + '.md');
  try {
    fs.writeFileSync(tmpFile, '# 自检临时攻略\n\n## 小节\n- 正文必须原样保留\n', 'utf8');
    const before = guides.guideStatus();
    const healed = guides.guideHeal();
    const after = guides.guideStatus();
    const raw = fs.readFileSync(tmpFile, 'utf8');
    t('缺标记 → 静默自动补、正文原样保留', before.lost.includes(tmpName)
      && healed.fixed.includes(tmpName) && after.lost.length === 0
      && raw.trimStart().startsWith('<!-- guide:' + tmpName + ' -->')
      && raw.includes('正文必须原样保留'),
      '自愈没补上 / 正文被改坏');
  } finally { guides.guideDelete(tmpName); }

  // ===== G. 场景→反应类约定：他没 @ 她、她自己扑上去接的话，也要带上（2026-11-06 加）=====
  // 真事（她 11-06 问「和白的约定 够童！呢」）：白教过「碰到童站评论就回够童」，
  // 当时白是直接甩一句「何意味？」，没 @ 她，她自己凑上去接的话。
  // 老逻辑 addressedToMe=false → 整段约定不注入 → 她只会解释「什么意思」，白纠正了两次。
  // 口径（不破坏 2026-10-23 那条）：句尾记号类（sig 非空）仍只在他真跟她说话时注入；
  // 「碰到 X 就 Y」这类规矩（sig 为空）只要这一轮接的是他的话，就注入。
  const BAI = '100000000';
  // 键是 'platform:id'（qq:100000000），不拿裸号硬比；按白的键集找他名下的约定
  const baiKeys = (core._whoKeys(BAI).keys || []);
  const hasBai = (core.readPromises() || []).some(x => x.qq
    && baiKeys.indexOf(String(x.qq)) >= 0 && /够童/.test(String(x.text)));
  if (hasBai) {
    core.setTurn('persona_selfcheck_bai', { uid: BAI, nick: '白', gid: '100000000', chime: true, atMe: false });
    const baiTail = (await core.buildMessages('persona_selfcheck_bai', '何意味？'))
      .slice(1).map(m => String(m.content || '')).join('\n');
    t('白没@她、她自己接话 → 仍带出「够童」', baiTail.includes('够童'),
      'addressedToMe 又把规矩类一起挡住了');
    t('  并且只说「条件对上才用」，不硬塞', /条件对上了才用/.test(baiTail));
  } else {
    console.log('· 跳过：白的「够童」约定不在（面板里被删了？）');
  }

  // 老口径不能破：句尾记号类（Ciallo）不能因为她主动接火丁的话就带出来
  core.setTurn('persona_selfcheck_qh2', { uid: '100000000', nick: '企鹅火丁', gid: '100000000', chime: true, atMe: false });
  const qh2 = (await core.buildMessages('persona_selfcheck_qh2', '今天好热'))
    .slice(1).map(m => String(m.content || '')).join('\n');
  t('火丁没@她、她自己接话 → 不带 Ciallo（老口径没破）', !qh2.includes(HIS_SIG));

  // ===== F. 风格块的优先级（2026-11-06 她定：只要优先级没问题）=====
  // 她自己写的那段里举了「够童！」当短评例子（她的原话，不许改），
  // 2026-11-06 她又要求「重排说法」：把两个维度拆成两列编号，
  // 「说什么」（内容）和「怎么说」（形式）各算各的，别混成一条链。
  const styleMod = require(path.join(ROOT, 'src', 'style.js'));
  const sb = String(styleMod.block() || '');
  t('说什么：1 约定原样说 ＞ 2 星标 ＞ 3 风格',
    /说什么：1 约定要求原样说的话[^\n]*2 星标过的做法[^\n]*3 /.test(sb), sb.slice(-220));
  t('怎么说：1 她写的 ＞ 2 星标 ＞ 3 总结/样本',
    /怎么说：1 主人自己写的[^\n]*2 星标过的做法[^\n]*3 /.test(sb), sb.slice(-220));
  t('两列各算各的（写明不混算）', /两列各算各的/.test(sb));
  if (sb.includes('主人自己写的')) {
    t('她手写那段标成「怎么说第 1 档」，不压约定',
      /主人自己写的（怎么说按它，第 1 档/.test(sb), sb.split('\n').find(l => l.includes('主人自己写的')));
  } else {
    console.log('· 跳过：她手写的风格段是空的');
  }
  t('短评例子注明是口味方向、不是口头禅', /口味方向/.test(sb));
  const sbr = String(styleMod.brief() || '');
  t('B站精简版带同一套两列编号',
    /说什么 1 约定要求原样说的话/.test(sbr) && /怎么说 1 主人自己写的/.test(sbr), sbr.slice(-200));

  // ===== F2. QQ 表情包格式（*名字*）不是说话风格，2026-11-06 她纠正过 =====
  // 她原话：「这是我发的QQ格式的表情包，不是我的说话风格」「根本没这个功能，删了」。
  // 之前误把 *…* 当成「星号动作样本」加了优先权，已删。
  // 前两条打真实 learn()：整条只是表情包时提前 return false、不写盘，所以跑测试不留脏数据。
  t('整条只是 QQ 表情包（半角）→ 不进样本', styleMod.learn('*自测表情包*', { g: '0' }) === false);
  t('整条只是 QQ 表情包（全角）→ 不进样本', styleMod.learn('＊自测表情包＊', { g: '0' }) === false);
  // 混着打字的会写盘，这里只做源码守卫：不许再出现「给表情包加成」的标记。
  const styleSrc = fs.readFileSync(path.join(ROOT, 'src', 'style.js'), 'utf8');
  t('没有「表情包当动作样本加分」的残留', !/item\.star|\.star\b/.test(styleSrc));
  t('表情包在学之前被剥掉（半角/全角都剥）', /\[\*＊\]\[\^\*＊/.test(styleSrc));

  // ===== H. B站评论区那条路（2026-11-19 主人令：整条删除）=====
  // 原来这里守的是 connectors/bili-comment.js 的 personaSay（精简版提示词）有没有带
  // 约定 / 星标 / 自动总结。2026-11-19 主人说「xuhbot 没有B站连接器，如果有那就是失效旧代码」，
  // 查证后那条链路从来没成功过一次（-101），B站回复本来就由 AstrBot 插件负责，
  // 所以连接器连同 personaSay 一起删了 —— 被守的实现不存在，这 6 条断言随之作废。
  // 不是「删断言图省事」：功能没了才没有断言对象；要用回精简版提示词请先恢复实现再恢复断言。

  // ===== H2. 主人的发言必回复：精确说法 1~6 的源码守卫（2026-11-10 她令「改成精确说法」）=====
  // 她原话（src/data/requests.jsonl:28,38）：所有她的发言必回复、回复率独立；绝对不能乱删好的功能。
  // 编号对齐 `.workbuddy/memory/MEMORY.md`《『主人的发言必回复』精确说法》。
  // 只核对落点在不在，不复刻实现、不改提示词、不占 token；改实现要同步改断言，不许删断言。
  const qqSrc = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'qq.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
  const iMaster = qqSrc.indexOf('if (isMaster) {');
  const iCanAuto = qqSrc.indexOf('else if (!canAuto) return;');
  t('必回① 触发按 QQ 号认主人，不要求 @ / 引用',
    qqSrc.includes('const isMasterMsg = isMasterUid(ev.user_id)') && iMaster > 0);
  t('必回② 必回分支独立于群级节流 / 凑热闹概率',
    qqSrc.includes('回应主人（主人 2026-10-23 定）：回复率独立')
      && qqSrc.includes("console.log('[master] 回应主人 → 必回复（回复率独立）")
      && qqSrc.includes('不受「不用回复」名单影响')
      && iMaster > 0 && iCanAuto > iMaster,   // 节流 return 在 else 链里，主人分支走不到
    '必回分支被挪到节流后面＝回复率不再独立');
  t('必回② 空答取消发送 / 重置节流都不拦主人',
    qqSrc.includes('!welcomed && !isMaster && EMPTY_ANS.test')
      && qqSrc.includes('!atMe && !isMaster && (critic || banter'));
  t('必回③ 主人 @/引用别人走对准语、对话链走另一条',
    qqSrc.includes('masterAim = masterAimLine(') && qqSrc.includes('masterAim = masterChainLine(')
      && qqSrc.includes('function masterAimLine(opts)') && qqSrc.includes('function masterChainLine(t)'));
  t('必回④ 顶上来的回复不带 @',
    qqSrc.includes('if (o.noAt || o.mustReply)')
      && qqSrc.includes('const mustReply = isMaster && !atMeReal')
      && qqSrc.includes('const AT = mustReply ? { mustReply: true } : undefined'));
  t('必回⑤ 错误复读拦截照旧，没因必回被绕过',
    qqSrc.includes('但发送层「错误复读」拦截照旧生效') && qqSrc.includes('但错误复读拦截下面照旧拦'));
  t('必回⑥ 两块场合提示词还在（不许整块删掉）',
    coreSrc.includes('## 本轮事实') && coreSrc.includes('## 这一轮：没人跟你说话'));
  t('必回⑥ 图片兜底的 return 只用在「主人引用别人且那条无字」',
    qqSrc.includes('if (replyOther && o.replyOrigin && o.replyOrigin.blindImg)')
      && qqSrc.includes('if (!anyText) {') && qqSrc.includes('引用的图看不到内容，不回答')
      && qqSrc.indexOf('if (replyOther && o.replyOrigin && o.replyOrigin.blindImg)') > iMaster,
    'return 被挪出主人引用分支＝主人消息可能整轮不回');
  // 2026-11-10 按她令把 MEMORY.md 分割成「索引 + 5 份主题原话文件」。
  // 守卫查的是「她的原话正本还在不在项目记忆里」，所以读整组 MEMORY*.md，不删断言、不写死单个文件名。
  const memSrc = (() => {
    try {
      const d = path.join(ROOT, '.workbuddy', 'memory');
      return fs.readdirSync(d).filter(f => /^MEMORY.*\.md$/.test(f))
        .map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
    } catch { return ''; }
  })();
  t('必回⑥ 精确说法正本还在（她的原话 + 什么算删了它）',
    memSrc.includes('## 『主人的发言必回复』精确说法')
      && memSrc.includes('所有我的发言，ai必回复，回复率独立')
      && memSrc.includes('什么算「删了它」') && memSrc.includes('绝对不能乱删好的功能'));
  t('不乱删⑥ 优先度判据正本还在（同级只做一个）',
    memSrc.includes('如果花费量没区别就是同级别的优先度，只做其中一个'));
  // 她 2026-11-10 定：概率回复优先级永远低于所有类型回复（有内容的回复不能被硬凑盖掉）。
  t('回复优先级：概率回复在决策链最后', (() => {
    const iChime = qqSrc.indexOf('else if (chimeAllowed(ev.group_id, text))');
    return iChime > 0 && iCanAuto > iMaster && iChime > iCanAuto;
  })(), '概率回复被挪到前面＝硬凑会盖掉有内容的回复');
  // 回复类型仲裁（她 2026-11-10 定）：同一句只回一次；回被引用者/复读 > 强制必回 > 概率。
  t('仲裁① 优先级表写进代码（①被引用者 ②复读 ③其余功能性 ④必回 ⑤概率）',
    qqSrc.includes('优先级高→低：① 回复被引用对象 ② 复读') && qqSrc.includes('概率回复（永远最低）'));
  t('仲裁② 「复读引用」按她的定义判定：主人引用对方 + 原样复读了对方',
    qqSrc.includes('const echoQuote = isMasterMsg && !!replyOther && !!replyOrigin && !replyOrigin.self')
      && qqSrc.includes('normEchoText(text) === normEchoText(String(replyOrigin.full || replyOrigin.frag'));
  t('仲裁③ 引用别人时只有复读引用才只复读；群友老行为没删',
    qqSrc.includes('(!masterSayToOther || echoQuote)') && qqSrc.includes(': !replyOther;'));
  t('仲裁④ 复读链发完 return（赢了就不进 handleTurn，只发一条）',
    /\[复读链\] 跟了一条[\s\S]{0,200}?\n\s*return;/.test(qqSrc),
    '去掉 return 会再走一次 LLM 回复＝一句话回两次');
  // 2026-11-13 她定：主人必回低于除主动外的所有；前方有会话排队就不进行必回。
  t('仲裁⑤ 主人必回降级 + 排队就不进行',
    qqSrc.includes('pureMasterForce') && qqSrc.includes('core.chatBusy(k)')
    && qqSrc.includes('低于除「主动/概率」外的所有类型'),
    '去掉排队判据＝必回又会顶掉正在回复的会话，引用错人复发');
  // 引用错人根因：turns 全局覆盖 + chat 排队延后 build → 排队轮读到后到消息的人。
  t('仲裁⑥ 排队轮读自己的上下文（引用错人根因已堵）',
    qqSrc.includes('turn: turnCtx') && qqSrc.includes('const turnCtx = {')
    && coreSrc.includes('function chatBusy(k)') && coreSrc.includes('function restoreTurn(k)')
    && coreSrc.includes('turn: next.turn') && coreSrc.includes('const running = activeTurns.get(k)'),
    '排队项不带本轮 ctx＝喜好/教学/好感仍会记到别人名下');
  t('仲裁⑦ 引用消息带真实时间，旧引用不许挂到本条',
    qqSrc.includes('msgT: qTime > 1e11 ? qTime') && qqSrc.includes("msgT: Number(replyOrigin.msgT || 0) || Date.now()")
    && qqSrc.includes('改引当前这条'),
    '用 Date.now() 当被引用消息时间＝5 分钟新鲜度形同虚设');
  // 2026-11-23 她定：纯必回 6 分钟冷却（只拦纯必回，@她/引用她/命令等不受限）。
  t('仲裁⑧ 纯必回 6 分钟冷却还在（只拦纯必回）',
    qqSrc.includes('masterCoolMs') && qqSrc.includes('masterForceAt')
    && qqSrc.includes('纯必回冷却中')
    && qqSrc.indexOf('const pureMasterForce') < qqSrc.indexOf('纯必回冷却中')
    && qqSrc.indexOf('纯必回冷却中') < qqSrc.indexOf('setThinking(true)', qqSrc.indexOf('纯必回冷却中')),
    '冷却闸被删或挪出纯必回分支＝主人连发又会被句句秒回');

  // ===== G. 否词化：只报告，不判失败 =====
  // 她亲笔写的例子里若带「只」类字也不能改，所以这里不拿来当失败条件。
  const hit = [];
  fs.readFileSync(DOC, 'utf8').split('\n').forEach((l, i) => {
    if (/只|必须|绝对|直接|即可|仅仅/.test(l)) hit.push(i + 1);
  });
  console.log('\n· 否词化扫描：命中 ' + hit.length + ' 行'
    + (hit.length ? '（行号 ' + hit.join(',') + '；含她原话例子的不判失败）' : ''));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  guides.learnTeach = _learnOrig;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检自身出错：', e.message); process.exit(2); });
