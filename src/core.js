/*
 * core.js — 共享大脑
 * QQ / B站 两个连接器都复用：LLM 调用、人设、长期记忆、日记、聊天流水。
 */
const fs = require('fs');
const path = require('path');
const imgCache = require('./img-cache');   // 图片 data URI 复用（同一张图只 base64 一次）
const guides = require('./guides');
const websearch = require('./websearch');
const memeLib = require('./meme');   // 查梗 / 娱乐网站：优先走专站公开 API，查不到再退回通用搜索
const nick = require('./nick');
const region = require('./region');
const taste = require('./taste');
const fixedTags = require('./fixed-tags');   // 2026-11-21：固定标签（本人认下/主人指定；模型不能改，本人才能取消）
const people = require('./people');
const relation = require('./relation');      // 2026-11-06：约定/事实按人物聚合，全平台生效
const style = require('./style');
const dates = require('./dates');         // 2026-11-06：重要的日子（生日 / 第一次上B站 / 和谁的第一次相遇）
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读写
const memory = require('./memory');       // 2026-11-07：虚幻的长期记忆正本 + 按天工作日志，读写只走这一个入口
const learn = require('./learn');         // 2026-11-09：学习系统热层（每人好感摘要 / 风格卡），只读已学好的句子，不现场算
const trace = require('./trace');         // 2026-11-07：每条发言的决策轨迹（可观测事实，不是模型内心独白）
const qmeta = require('./qq-meta');       // 2026-11-07：QQ 头像缓存 + 群名表 + 显示名→QQ号
const convSettings = require('./conv-settings');  // 2026-11-07：按会话的上下文条数 / 回不回话 / 黑名单
const platLimits = require('./platform-limits');  // 2026-11-17：各平台输出字数上限的单一数据源
const convState = require('./conv-state');        // 2026-11-14：聊天记录页「当前状态」存储（AI 也能读/写，本地/云端按 kind 隔离）
const promptSlots = require('./prompt-slots');    // 2026-11-13：聊天记录页「本轮提示词」槽位（采集端，和 panel 共用一份）
const dictLib = require('./dict');                // 2026-11-12：通用中文词典按需检索（成语/歇后语/汉字/词语），命中才注入提示词
const infoScan = require('./info-scan');          // 2026-11-21：信息识别四功能（言外之意/信息量/梗含量/自我表达）统一引擎
const coord = require('./coord');                 // 2026-11-21：坐标向量选材（逻辑从全部条目里按坐标选多条）
const teach = require('./teach');                 // 2026-11-12：别人教的知识（带 id 署名、只在对方在场时用）
const review = require('./review');               // 2026-11-12：三类知识复核/锁定/署名隐私
const kb = require('./kb');                       // 2026-11-13：别人教的统一检索（攻略/学到的/教学，≥4 字才查，只给命中的）
const astrbotLlm = require('./llm-astrbot');      // 2026-11-10：把 AstrBot 配好的模型接进来（只读它的配置，不改它）
const censorGuard = require('./censor-guard');    // 2026-11-19：审查词守卫——命中主人自填的词→本轮临时本地优先 + 给模型喂语境说明
const promptScenes = require('./rules/prompt-scenes'); // 2026-11-19：常驻提示词按场景选择注入（省 token，段内原文不动）
const chatShards = require('./chat-shards');  // 2026-11-19：聊天记录按会话分流（派生视图，主文件仍是唯一数据源）
const anchor = require('./anchor');            // 2026-11-25：本轮锚定（历史带时间/旧图标（旧）/启动闸/出口闸）
const ROOT = __dirname;

let cfg;
// 这三个文件可以在管理面板里改名，改名后 config.json 的 files 段会同步更新
const DEFAULT_FILES = { soul: 'soul/F-全场景通用主人设/虚幻.md', extra: '', memory: 'data/人物列表.md' };
let SOUL_PATH = path.join(ROOT, DEFAULT_FILES.soul);
let EXTRA_SOUL_PATH = path.join(ROOT, DEFAULT_FILES.extra);
let MEMORY_PATH = path.join(ROOT, DEFAULT_FILES.memory);
const DIARY_DIR = path.join(ROOT, 'data', 'diary');
const CHATLOG_PATH = path.join(ROOT, 'data', 'chat-log.jsonl');

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
// 人设 / 记忆这类文件每轮都要读进 prompt。加了 mtime 缓存：文件没改就直接用上次读到的，
// 改了就重读（面板里改完立刻生效，不会读到旧的）。省的是每轮的磁盘读 + 解码。
const _fcache = new Map();          // path -> { mtime, text }
function readCached(p) {
  if (!p) return '';
  try {
    const st = fs.statSync(p).mtimeMs;
    const c = _fcache.get(p);
    if (c && c.mtime === st) return c.text;
    const text = fs.readFileSync(p, 'utf8');
    _fcache.set(p, { mtime: st, text });
    return text;
  } catch { return ''; }
}
const append = (p, s) => fs.appendFileSync(p, s, 'utf8');

// 人设按层物理切开（2026-11-21）：F 全场景通用主人设（身份/性格/说话/口味/功能词典）+ H 全聊天应对。
// 读的时候整份拼起来再进 prompt——拆只是让人好改，效果跟没拆一样，缺一块人就残。
// 文件开头的 <!-- 注释 --> 是给人看的指认，不进 prompt。
// 注意：3-应对.md 不在这里拼——它按「公共 / 我 / 别人」拆成场景块，由 readResponseBlocks 解析、
//       再经 buildMessages 按「这一轮谁在说话」挑块注入，避免对所有人都灌一遍重复废话（省 token）。
//       soul/H-全聊天/应对/ 下的场合文件也不在这里拼：那是另一个目录，只有命中 RESP_SCENES 才注入。
let _soulAll = { key: '', text: '', scenes: {}, lost: [] };

// 按使用场景挑人设段（主人 2026-11-05 定：「按使用场景拆分」，不是按文件拆）。
// 只摘「只有那种场合才用得上」的小节：问游戏攻略、让搜东西时的兴奋语气。
// 禁令类小节（唱歌、记东西、看不懂、梗）一律留常驻——摘掉等于让坏行为回潮。
// 认一节有四种办法，从上往下试，任一命中就摘出常驻、改成按场合注入：
//   ① 标记 <!-- scene:xxx -->（标题随便改名都不怕，最稳）
//   ② 标题一字不差
//   ③ 标题被小改（同级标题里带「攻略」「兴奋」）
//   ④ 正文里有那句特征话（改了标题又删了标记时兜底）
// 四种都认不出 → 不静默：控制台报错 + 写「虚幻自查」+ 私信主人（主人 2026-11-06 定：
// 「遇到这种直接报错，私信提醒我」——不许悄悄退回常驻，也不许悄悄消失）。
const SOUL_SCENES = [
  { id: 'game', file: '2-说话.md', heading: '### 答游戏攻略', mark: 'scene:game',
    alt: /攻略/, sig: '满级 60',
    re: /攻略|数值|机制|技能|满级|属性|配装|词条|面板|天赋|伤害|攻击|防御|血量|抗性|倍率|掉落|刷新|哪个(更)?(厉害|强)|怎么打|怎么过|boss/i },
  { id: 'hype', file: '2-说话.md', heading: '### 什么时候兴奋', mark: 'scene:hype',
    alt: /兴奋/, sig: '我找给你',
    re: /攻略|帮我搜|搜一下|搜个|你知道.{0,8}吗|up主|找一下|查一下|查查/i },
];
/* 【分类 F·全场景通用】情绪场景：6 类感受标签给待修问题打标/判本轮场合，全平台共用。
 * ===== 情绪场景（主人 2026-11-07 定）：Willcox 感受轮 6 类当路由标签 =====
 * 纯本地关键词计数，零 token、不调模型。两个用途：
 *   ① 给待修复问题打标（同场合才回灌教训） ② 观察这一轮属于哪种情绪场合。
 * 判不出返回 ''（不回灌、不挑专属段，照旧用常驻规则）。
 * 只取 6 类核心，不照搬三级 100+ 词——进提示词会加 token。 */
const EMOTION_SCENES = [
  { id: 'happy',    name: '开心', words: ['夸','厉害','牛','好棒','自豪','骄傲','幸好','还好没','躲过去','开心','高兴','太好了'] },
  { id: 'sad',      name: '伤心', words: ['好累','难受','头疼','心疼','抱抱','难过','呜呜','哭','对不起','抱歉','不该','我错了','委屈'] },
  { id: 'angry',    name: '生气', words: ['你怎么这么说','说得真难听','你这话','太过分','生气','骂','凶','气死','闭嘴'] },
  { id: 'surprise', name: '惊讶', words: ['机器','AI','幽灵','好假','演起来','围观','什么鬼','居然','竟然','是不是'] },
  { id: 'fear',     name: '害怕', words: ['害怕','吓','恐怖','不敢','慌','担心','怕'] },
  { id: 'disgust',  name: '厌恶', words: ['恶心','嫌','无聊','烦死','吐了','受不了'] },
];
/* 2026-11-07 主人定：判定改走「情绪书」（data/情绪书.json 一棵树，6 大类 → 21 分支 → 叶）。
 * 这里只回 6 大类 id，老调用点（应对/回灌/决策轨迹）一行都不用改。
 * 情绪书没命中时退回下面这 6 组旧词表 —— 它是兜底，不是主力；主人手写的词在情绪书里优先。 */
let _emoBook = null;
function emoBook() {
  if (_emoBook) return _emoBook;
  try { _emoBook = require('./emotion-tree'); } catch (e) { console.error('[情绪书] 加载失败：' + e.message); _emoBook = false; }
  return _emoBook;
}
function emotionOf(text) {
  const bk = emoBook();
  if (bk) { try { const c = bk.coreOf(text); if (c) return c; } catch {} }
  const str = String(text || '');
  let best = '', bestN = 0;
  for (const d of EMOTION_SCENES) {
    let n = 0;
    for (const w of d.words) if (str.includes(w)) n++;
    if (n > bestN) { bestN = n; best = d.id; }
  }
  return best;
}
/* 叶级细节（面板和轨迹用）：{ core, branch, branchName, leaf, word }，判不出 null */
function emotionDetail(text) {
  const bk = emoBook();
  if (!bk) return null;
  try { return bk.detail(text); } catch { return null; }
}
/* 应对场合 → 属于 6 类里的哪一类 + 命中词 + 物理文件（2026-11-07 主人定：后续会越积越多，趁现在物理分离）。
 * 通用规则和禁令一律留在 H 层 soul/H-全聊天/3-应对.md 常驻；只有场合专属段搬到同级 应对/ 下一个场合一份。
 * who:'我'/'别人' = 只给主人/只给群友；both:true = 不管是不是主人、认不认识都给（她对每个人都这样）。
 * 加场合 = 加一个 md 文件 + 这里加一行，不用再往大文件里塞标记。 */
const RESP_DIR = path.join(ROOT, 'soul', 'H-全聊天', '应对');   // H 层：全聊天应对语气
const RESP_SCENES = [
  { id: 'me-praise',   emo: 'happy',    who: '我',    file: '我-被夸.md',       re: /夸|厉害|牛逼|自豪|骄傲|幸好|还好没|没发生就好|躲过去|好棒/ },
  { id: 'me-blame',    emo: 'angry',    who: '我',    file: '我-被怪.md',       re: /你怎么这么说|说得真难听|你这话|太过分|伤到|惹毛|别这么说话/ },
  { id: 'other-watch', emo: 'surprise', who: '别人',  file: '别人-被围观.md',   re: /机器人|AI|幽灵|好假|演起来|围观|这机器人|是不是.{0,4}(AI|机器)/ },
  { id: 'any-asked',   emo: 'happy',    both: true,   file: '被提问-被需要.md', re: /[？?]|问一下|请教|想问|问问你|能不能帮我|帮我(看|查|想|讲|选)|你知道|你懂|咋办|怎么办|怎么回事|什么情况|啥情况|是什么|为什么|为啥|怎么样|哪个好|哪里/ },
  { id: 'any-taught',  emo: 'happy',    both: true,   file: '被教会-学到了.md', re: /我教你|教你|告诉你|跟你说|你记一下|记住[，,：:]|其实.{0,24}(是|应该)|不是.{0,12}(是|应该)|应该是|正确答案是|科普一下|你记着|学到了|涨知识/ },
];
const SCENE_ALERT_PATH = path.join(ROOT, 'data', 'scene-alert.json');
const SCENE_ALERT_GAP = 6 * 60 * 60 * 1000;   // 人设节认不出才提：同一个问题 6 小时提一次，别刷屏
const _sceneSaidAt = {};                      // 本进程内已经提过的（重启后按 state 文件算）

// 这一节从第几行开始（找不到 -1）
function sceneStart(lines, d) {
  const isHead = l => /^#{1,6}\s/.test(l);
  const up = i => { for (let k = i; k >= 0; k--) if (isHead(lines[k])) return k; return i; };
  // ① 标记：标记行上面最近的那个标题就是这一节的开头
  const mi = lines.findIndex(l => new RegExp('<!--\\s*' + d.mark + '\\s*-->').test(l));
  if (mi >= 0) return up(mi);
  // ② 标题一字不差
  let i = lines.findIndex(l => l.trim() === d.heading);
  if (i >= 0) return i;
  // ③ 标题被小改
  if (d.alt) { i = lines.findIndex(l => /^#{2,4}\s/.test(l) && d.alt.test(l)); if (i >= 0) return i; }
  // ④ 正文特征句
  if (d.sig) { i = lines.findIndex(l => l.includes(d.sig)); if (i >= 0) return up(i); }
  return -1;
}
// 把某个文件里认出来的小节整段摘出来放进 bag，返回摘完的正文
function stripScenes(fileBase, raw, bag, lost) {
  let text = raw;
  for (const d of SOUL_SCENES) {
    if (d.file !== fileBase) continue;
    const lines = text.split('\n');
    const i = sceneStart(lines, d);
    if (i < 0) { lost.push(d); continue; }                 // 认不出 → 记下来，报给主人
    const lvl = (lines[i].match(/^#+/) || ['#'])[0].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = lines[j].match(/^(#{1,6})\s/);
      if (m && m[1].length <= lvl) break;                  // 到下一个同级/更高级标题为止
    }
    // 标记注释不进提示词（常驻那边是整段剥，这里单独剥一遍）
    bag[d.id] = lines.slice(i, j).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    lines.splice(i, j - i);
    text = lines.join('\n');
  }
  return text;
}
// 认不出就报错 + 私信主人（2026-11-06 主人定）
function sceneAlert(d) {
  const now = Date.now();
  if (now - (_sceneSaidAt[d.id] || 0) < SCENE_ALERT_GAP) return;
  _sceneSaidAt[d.id] = now;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SCENE_ALERT_PATH, 'utf8')) || {}; } catch { st = {}; }
  const last = Number(st[d.id] || 0);
  if (last && now - last < SCENE_ALERT_GAP) return;
  try { st[d.id] = now; fs.writeFileSync(SCENE_ALERT_PATH, JSON.stringify(st), 'utf8'); } catch {}
  const msg = [
    '【人设分场景】有一节我认不出来了',
    '',
    '文件：soul/F-全场景通用主人设/' + d.file,
    '这一节：' + d.heading + '（标记 ' + d.mark + '）',
    '为什么报：这一节本该「只在用得上的场合才进提示词」。现在标记、标题、正文特征三样都没对上，我不敢乱动它。',
    '现在状态：它每轮都进提示词（多花 token）；要是你把它删了，那就是真的没了。',
    '怎么修：标题改回「' + d.heading + '」，或在那个标题下面加一行 <!-- ' + d.mark + ' -->。',
    '改好就安静；没改的话 6 小时后我再提一次。',
  ].join('\n');
  console.error('[人设分场景] ' + d.heading + ' 认不出来了（soul/F-全场景通用主人设/' + d.file + '）');
  noteFail('人设分场景', d.heading + ' 认不出来了：soul/F-全场景通用主人设/' + d.file);
  try { master(msg); } catch (e) { console.error('[人设分场景] 私信发不出去：' + e.message); }
}
// 修好了一声（同一个问题只报一次）
function sceneFixed(found) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(SCENE_ALERT_PATH, 'utf8')) || {}; } catch { return; }
  const back = found.filter(d => st[d.id]);
  if (!back.length) return;
  for (const d of back) st[d.id] = 0;
  try { fs.writeFileSync(SCENE_ALERT_PATH, JSON.stringify(st), 'utf8'); } catch {}
  const msg = '【人设分场景】修好了：' + back.map(d => d.heading).join('、') + ' 又能认出来了。';
  console.error(msg);
  try { master(msg); } catch {}
}
function readSoul() {
  // F 层（全场景通用主人设）：入口虚幻.md 与 0-我的喜好/1-性格/2-说话/功能词典 平铺在同一目录。
  // 应对层（3-应对.md + 应对/）已物理切到 H 层，不在这里读——由 readResponseBlocks 管。
  const dir = path.dirname(SOUL_PATH);
  const files = [SOUL_PATH];
  try {
    for (const f of fs.readdirSync(dir).sort())
      if (f.endsWith('.md') && f !== '功能词典.md' && f !== path.basename(SOUL_PATH)) files.push(path.join(dir, f));
  } catch { /* 没有目录就只读入口 */ }
  /* 第一遍只 stat 拼 key，不读文件内容：人设没改就直接吃缓存。
   * 以前是无条件把每个 md 全读一遍再比 key —— 每轮回复都白读一遍全部人设文件，
   * 造成持续的字符串分配和 GC 压力（读的结果在命中缓存时直接扔掉）。 */
  let key = '';
  for (const p of files) {
    try {
      const st = fs.statSync(p);
      key += p + ':' + st.mtimeMs + ':' + st.size + '|';
    } catch { /* 单块坏了不拖累其它块 */ }
  }
  /* 功能词典（2026-11-13 主人令「虚幻需要知道每个分类代表的含义，清楚自己有哪些功能」）：
   * 单独拼、不进场景解析（它没有「应对·我 / 别人」那种小节），但改了要立刻生效，所以进缓存 key。 */
  const dictPath = path.join(path.dirname(SOUL_PATH), '功能词典.md');   // 功能词典在 F 层，与虚幻.md 同目录
  try {
    const st = fs.statSync(dictPath);
    key += dictPath + ':' + st.mtimeMs + ':' + st.size + '|';
  } catch {}
  if (key === _soulAll.key) return _soulAll.text;

  /* 第二遍：key 变了才真读内容（改人设后立刻生效，语义与以前一致） */
  const out = [];
  const bag = {}, lost = [];
  for (const p of files) {
    try { out.push(stripScenes(path.basename(p), fs.readFileSync(p, 'utf8'), bag, lost)); } catch {}
  }
  let dict = '';
  try { dict = fs.readFileSync(dictPath, 'utf8'); } catch {}
  let text = out.join('\n\n');
  if (dict) text += '\n\n' + dict;
  _soulAll = {
    key,
    scenes: bag,
    lost,
    text: text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim(),
  };
  // 只在人设文件变过（缓存未命中）时判一次，不会每轮刷屏
  for (const d of lost) sceneAlert(d);
  sceneFixed(SOUL_SCENES.filter(d => bag[d.id]));
  return _soulAll.text;
}
// 取按场景摘出来的小节（先调 readSoul 保证缓存是最新的；命中缓存就零重读）
function readSceneBlocks() { readSoul(); return _soulAll.scenes || {}; }
// 给自检用：哪些节认出来了、哪些认不出（认不出会私信主人）
function sceneStatus() {
  readSoul();
  return {
    found: Object.keys(_soulAll.scenes || {}),
    lost: (_soulAll.lost || []).map(d => d.id),
  };
}

// ===== 攻略标记（2026-11-06 主人定：缺了自己补，别为这种小事打扰她）=====
// 自愈实现在 guides.js 的 guideHeal()：启动时、客户端打开攻略页时各跑一次，全程静默。
// 这里不设状态文件、不节流、不私信、不记失败——这问题机器人自己就能修好。


// ===== 应对按场景拆分（主人 2026-11-03 定；2026-11-21 归到 H 层 soul/H-全聊天/）=====
// H 层 3-应对.md 只留通用规矩，仍按「## 公共 / ## 我 / ## 别人」三块切：
//   公共 → systemPrompt 常驻；我 / 别人 → buildMessages 按说话人挑一块。
// 场合专属段各在 soul/H-全聊天/应对/ 下一份物理文件，由 RESP_SCENES 的 file+who 认领，命中才注入。
// 缓存 key 把正本和所有场合文件都算进去：任一文件被客户端改过，下一轮立刻生效、不必重启。
let _respCache = { key: '', pub: '', me: '', other: '', scenes: {} };
function readResponseBlocks() {
  try {
    const p = path.join(ROOT, 'soul', 'H-全聊天', '3-应对.md');   // 应对层正本在 H 层
    const parts = [p];
    for (const d of RESP_SCENES) if (d.file) parts.push(path.join(RESP_DIR, d.file));
    const stamps = parts.map(x => { try { const s = fs.statSync(x); return x + ':' + s.mtimeMs + ':' + s.size; } catch { return x + ':missing'; } });
    const key = stamps.join('|');
    if (key === _respCache.key) return _respCache;
    const raw = fs.readFileSync(p, 'utf8');
    const b = { 公共: [], 我: [], 别人: [] };
    let cur = '';
    for (const line of raw.split('\n')) {
      const m = line.match(/^##\s*(公共|我|别人)\s*$/);
      if (m) { cur = m[1]; continue; }
      if (!cur || line.trim().startsWith('<!--')) continue;
      b[cur].push(line);
    }
    const join = a => a.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const out = { key, pub: join(b.公共), me: join(b.我), other: join(b.别人), scenes: {} };
    for (const d of RESP_SCENES) {
      const empty = { 我: '', 别人: '' };
      out.scenes[d.id] = empty;
      if (!d.file) continue;
      try {
        const lines = fs.readFileSync(path.join(RESP_DIR, d.file), 'utf8').split('\n')
          .filter(l => l.trim() && !l.trim().startsWith('<!--'));   // 注释是给人看的，不进提示词
        const text = join(lines);
        if (d.both) { empty['我'] = text; empty['别人'] = text; }   // 认不认识都给：对每个人一样
        else empty[d.who || '我'] = text;
      } catch (e) {
        console.log('[resp] 场合文件读不到：' + d.file + '（' + e.message + '）');
      }
    }
    _respCache = out;
    return out;
  } catch {
    return { key: 'err', pub: '', me: '', other: '', scenes: {} };
  }
}

/* 人设分层接入（主人 2026-11-21 定）：层级分类 A/H/B/D/E/F/I/X 不动，人设按层物理切开。
 *   F 全场景通用主人设 = 身份/性格/说话/口味/功能词典 —— 唯一一份，所有场景都读（readSoul）。
 *   H 全聊天应对语气   = 3-应对.md 的公共块（+ 我/别人 + 5 场合，按说话人注入）—— 覆盖：
 *       QQ群 / QQ私聊 / B站私信 / B站评论 / QQ空间评论。
 *   D 平台功能 = 空间评论专属写法（各生成函数里的任务提示词）。
 * 聊天主链路（systemPrompt + buildMessages）已经 F+H 齐全。
 * 非聊天场景（空间评论/转发感想/发说说/日记…）以前只调 readSoul()（F），漏了 H→写出来没语气。
 * 这个 helper 把 F + H·公共 合成一段，给所有非聊天入口复用——它们不区分「我/别人」（评论区是路人），
 * 只带常驻的公共应对语气（被骂委屈、调侃与夸分清、不一板一眼…），正是「虚幻风格」的底色。 */
function soulForNonChat() {
  const pub = readResponseBlocks().pub || '';
  return readSoul() + (pub ? '\n\n## 应对·公共（对所有人都这样）\n' + pub : '');
}

// 本地日期（toISOString 是 UTC，晚上会差一天）
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 机器人写进 md 的每条都带时间，面板上显示在条目右下角（主人可以随便改/删）
const withStamp = txt => `${stamp()} · ${txt}`;
const LEAD_DATE = /^[-*\s]*(\d{4}-\d{1,2}-\d{1,2})\s*[·•:：\-—]?\s*/;

const history = new Map();       // key -> [{role, content}]
const pending = new Map();       // 防并发
const extractCount = new Map();  // 距上次记忆抽取的消息数
const tasteCount = new Map();    // 距上次喜恶抽取的消息数
const turns = new Map();         // key -> 这一轮是谁在说话（uid/gid/nick）
let masterDeliver = () => {};
let regionResolver = null;       // 由 qq.js 注册：查资料卡所在地

function refreshPaths() {
  const f = Object.assign({}, DEFAULT_FILES, cfg.files || {});
  SOUL_PATH = path.join(ROOT, f.soul);
  // 人设基底只有 F 一份（soul/F-全场景通用主人设/虚幻.md）。extra 留空就说明「没有补充人设」，别去读一个目录
  EXTRA_SOUL_PATH = f.extra ? path.join(ROOT, f.extra) : '';
  MEMORY_PATH = path.join(ROOT, f.memory);
  // 让 taste 知道谁是主人：她的口味写人设层（soul/F-全场景通用主人设/0-我的喜好.md），别人的写 data/人物喜好.md
  taste.setMasters([cfg && cfg.masterQQ, ...((cfg && cfg.masters) || [])]);
}
function init(config) {
  ensureConfig(config);
  cfg = config;
  nick.init(config);
  refreshPaths();
  checkKey();
  // 攻略标记缺了就自己补，不通知（2026-11-06 主人定：这种小事别打扰她）
  try { guides.guideHeal(); } catch (e) { console.error('[攻略标记] 自愈失败：' + e.message); }
}

// 兜底：config 被外面改坏、丢了字段时补回来，别让人设整个读不到
function ensureConfig(c) {
  const DEF = {
    files: { soul: 'soul/F-全场景通用主人设/虚幻.md', extra: '', memory: 'data/人物列表.md' },
    autoAsk: { enabled: true, minLength: 5, cooldownMs: 12000, maxPerMinute: 3 },
    // 免费检索顺位（2026-11-23）：PokeAPI → 垂直源(报错/论文/书/HN) → 萌娘 → 维基百科 → SearXNG → AnySearch → Mwmbl → 抓网页（默认关，红线）
    // 要 Key 的源（Brave / Google CSE）与付费源（智谱）已按主人令从代码删除。
    // proxy.url 留空＝自动探测本机代理端口；auto:false 则只认 url 和环境变量。
    webSearch: {
      enabled: true,
      bing: false,
      proxy: { enabled: true, auto: true, url: '' },
    },
    triggers: [],
    people: {},
    city: '上海',
    noRegionReply: '可是我不知道你住在哪里QAQ...告诉我在哪个城市好不好',
  };
  let changed = false;
  const miss = {};
  for (const k of Object.keys(DEF)) {
    if (c[k] === undefined) { c[k] = DEF[k]; miss[k] = DEF[k]; changed = true; console.log('[cfg] ⚠ config 里缺 ' + k + '，已补默认值'); }
  }
  // 人设文件必须真的存在，不然等于没灵魂
  const f = c.files || {};
  for (const it of [['soul', '灵魂'], ['extra', '补充人设'], ['memory', '记忆']]) {
    // 注意：设成空字符串 = 明确「不要这份文件」（现在人设合成一份了，extra 就是空的），
    // 不能退回去查默认路径，否则启动时天天报一个假警告
    const relPath = (f[it[0]] != null) ? f[it[0]] : DEF.files[it[0]];
    if (!relPath) continue;
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      console.log('[cfg] ⚠ ' + it[1] + '文件不存在：' + relPath);
      console.log('[cfg]    去 config 的 files 段里改成实际文件名（大小写、空格都要对）');
    }
  }
  if (changed) {
    try { configStore.patchMany(miss); } catch (e) { console.log('[cfg] 补默认值写回失败：' + e.message); }
  }
}

// 启动时看一眼 Key 的样子：智谱是「32位.16位」两段式，少一段就是复制不全
function checkKey() {
  const k = String((cfg.llm || {}).apiKey || '').trim();
  if (!k || k.includes('在这里填')) {
    // 2026-11-11（修）：AstrBot 接入模式下 Key 在 AstrBot 配置里，llm.json 本来就是空，不算没填
    const aLive = (() => { try { return astrbotLlm.list().length > 0; } catch { return false; } })();
    if (aLive) {
      console.log('[key] 走 AstrBot 接入：llm.json 的 Key 为空，但 AstrBot 池里有 ' + astrbotLlm.list().length + ' 个模型，Key 从 AstrBot 读，正常。');
      return;
    }
    console.log('[key] ⚠ 还没填 API Key，机器人不会回话。先去 AstrBot 配模型，或在 xuhuan 里「换Key」填一个。');
    return;
  }
  if (k.length < 40 || !k.includes('.')) {
    console.log('[key] ⚠⚠ 这个 Key 看起来不完整：长度 ' + k.length + '，' + (k.includes('.') ? '有' : '没有') + '那个英文句点。');
    console.log('[key]    智谱的 Key 是「32位.16位」（约 49 位），你大概率只复制了前半段。');
    console.log('[key]    去 https://bigmodel.cn/usercenter/proj-mgmt/apikeys 点「复制」，再双击「换Key」粘贴。');
    return;
  }
  console.log('[key] 格式看起来正常（' + k.slice(0, 4) + '****' + k.slice(-4) + '）');
}
function setMasterDeliver(fn) { masterDeliver = fn; }
function master(text) { masterDeliver(text); }
function setTurn(k, ctx) { turns.set(k, ctx || {}); seqBump(k, ctx); }
function getTurn(k) { return turns.get(k) || {}; }
function setRegionResolver(fn) { regionResolver = fn; }

function histKey(src, id) { return `${src}_${id}`; }
function getHist(k) { if (!history.has(k)) history.set(k, []); return history.get(k); }
// 判断两句话是不是「几乎一模一样」：用来防止复读机

// 主人可以有多个号（qq.js isMasterUid 同款）：cfg.masterQQ 主号 + cfg.masters 其他主人号
// 【分类 I·独立(身份层)】isMasterId：认主人 QQ 号，身份判据不归任何回话场景类。
function isMasterId(uid) {
  const s = String(uid || '');
  if (!s) return false;
  if (cfg.masterQQ && s === String(cfg.masterQQ)) return true;
  return Array.isArray(cfg.masters) && cfg.masters.some(m => String(m) === s);
}

/* 这轮说话人的**人物身份**（2026-11-05）：真实非 QQ 平台要带平台前缀，
 * 否则 B站 UID 会被当成 QQ 号（建出平台是 QQ 的人物、称呼写进 QQ 侧、喜恶落到 QQ 那一节）。
 * 只认「真的是账号平台」的 source：
 *   bili        → 'bili:<uid>'
 *   qq / 空     → 原样（老行为一字不改）
 *   其它标签    → 原样 —— selfcheck.js / checks.js 的探针用 source:'selfcheck'/'checks' 配主人号，
 *                那不是平台，绝不能加前缀（加了主人就判不出来，自检提示词会变）。
 * 以后加平台：在 ACCT_SOURCES 加一行（和 people.js 的 PLAT_RANK、taste.js 的 PLAT_ALIAS 同步）。
 */
const ACCT_SOURCES = { bili: 'bili' };
function whoUidOf(ctx) {
  const c = ctx || {};
  const plat = ACCT_SOURCES[String(c.source || '')];
  return (plat && c.uid) ? (plat + ':' + c.uid) : c.uid;
}

function normText(s) {
  return String(s == null ? '' : s).replace(/[\s，。！？、~～…·,.!?"'“”‘’()（）【】\[\]]/g, '');
}
function similarText(a, b) {
  const x = normText(a), y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length) > 0.6;
  }
  return false;
}
// 字面重合度（二字组，按短的归一）：用来判断「是不是把示例句原样搬过来了」
function overlapScore(a, b) {
  const g = s => {
    const t = normText(s), set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (!set.size && t) set.add(t);
    return set;
  };
  const A = g(a), B = g(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}
// 这句是不是把梗库里的「示范」原样搬过来了（主人 2026-10-22：示范是「含义相似」，不是固定话术）
function echoDemo(ans, ex) {
  if (!ans || !Array.isArray(ex) || !ex.length) return false;
  return ex.some(d => d && overlapScore(ans, d) >= 0.6);
}
// 定时保健提醒 / 远行商人提醒不是「回过的话」，复读判定一律不看它（主人 2026-11-21）
function isHealthNote(m) {
  const s = String((m && m.content) || '').trim();
  return s.startsWith('[定时保健提醒]') || s.startsWith('[远行商人]');
}
// 搬屎转发（sowing）是"她自己发的"，但不是她打的字：只进普通上下文，不算她说过的话。
// 复读/兜底/"最近这样回过"/子代理展示都走这个判定（2026-11-22）。
function isSpeech(m) {
  return !!(m && m.role === 'assistant' && !m.sowing);
}
// 最长公共子序列长度（删字/插字/换字都算进来，判「是不是同一句改了改」）
function lcsLen(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[m];
}
// 同一句话「删几个字 / 改几个字」——比 similarText 狠（主人 2026-11-21：
// 「实测模型会减少、改动几个字继续复读」，只认完全一样/包含关系拦不住）。
function nearSame(a, b) {
  const x = normText(a), y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const lo = Math.min(x.length, y.length), hi = Math.max(x.length, y.length);
  if (lo < 6) return false;                  // 太短（嗯/好哦）本来就容易撞，不按复读算
  // 一方整段包含另一方 → 复读，**不看长度比**：把上一条删掉一半再发，正是主人说的「减少几个字」
  if (x.includes(y) || y.includes(x)) return true;
  if (lo / hi < 0.6) return false;           // 长度差太多又互不包含，不是同一句
  if (overlapScore(x, y) >= 0.75) return true;       // 二字组骨架没变（换几个词）
  return lcsLen(x, y) / lo >= 0.75;                  // 删几个字 / 插几个字
}

// 这句和最近几条自己说过的话是不是重复了（保健提醒不算）
function isRepeat(k, ans) {
  const h = getHist(k).filter(m => isSpeech(m) && !isHealthNote(m)).slice(-3);
  return h.some(m => nearSame(m.content, ans));
}
// 命中的那条原句（重说时要把它摆给模型看，光说「重复了」模型只会再改几个字）
function repeatHit(k, ans) {
  const h = getHist(k).filter(m => isSpeech(m) && !isHealthNote(m)).slice(-3);
  const hit = h.filter(m => nearSame(m.content, ans)).pop();
  return hit ? String(hit.content).trim() : '';
}

function pushHist(k, role, content, who, opts) {
  const h = getHist(k);
  const sowing = !!(opts && opts.sowing);
  // 连着说同一句就不记进去了，否则历史里全是复读，模型会被自己带偏。
  // sowing（搬屎转发）不参与这段去重：它不是她打的字，不能被当成"刚说过"。
  if (role === 'assistant' && !sowing) {
    const last = h[h.length - 1];
    if (last && last.role === 'assistant' && !last.sowing && similarText(last.content, content)) return;
  }
  // 记下这句话是谁说的（2026-11-03 加）：自动总结以前分不清「谁说的」，
  // 把虚幻自己说的话记成了别人的喜好（真事：把「Ciallo 是跟企鹅火丁的约定」记成「凑肥鱼喜欢用Ciallo的喊法」）。
  // 只多存两个字段，别的地方读历史仍旧只看 role/content，不受影响。
  // plat（2026-11-06 加）：非 QQ 平台把来源也记上（k 的前缀就是平台），
  // 否则 B站 观众的裸 UID 会被自动总结当成 QQ 号落盘（撞号风险、喜恶/事实落错节）。QQ 不加，老行为不变。
  const srcPlat = String(k || '').split('_')[0];
  const plat = ACCT_SOURCES[srcPlat] ? srcPlat : '';
  const rec = who && who.uid
    ? { role, content, nick: String(who.nick || ''), uid: String(who.uid), plat }
    : { role, content };
  // 2026-11-25 本轮锚定：每条历史都落时间。没有时间的上下文，模型分不清
  // 「02:05 的旧表情」和「02:47 的新照片」，会把两张图拼成一句话（真事故）。
  rec.ts = Number(who && who.ts) || Date.now();
  // 2026-11-25 多重真相：每条用户消息投给异步分析流水线（失败不影响聊天；关掉就不投）
  if (role === 'user' && rec.uid) {
    try {
      const _mt = require('./multi-truth');
      _mt.inbox(k, { uid: rec.uid, nick: rec.nick, text: content, ts: rec.ts });
      const _mtCfg = readConfigFresh().multiTruth || {};
      if (_mtCfg.enabled === true && _mtCfg.autoRun === true) _mt.kick(k).catch(() => {});
    } catch (e) { /* 流水线挂了不影响聊天 */ }
  }
  if (opts && opts.offline) rec.offline = true;
  if (sowing) rec.sowing = true;
  h.push(rec);
  // 两道闸：条数 + 总字数（v78 主人 2026-10-23 定：上下文必须够看，数字放 config.context 可调，
  // 「最难漏信息」的取值是测试群实测出来的，别在代码里另写一份）。
  // 2026-11-07 追加：这个会话在聊天记录页单独设过条数，就用那一个（主人要「按各自群聊/私聊分别调容量」）。
  // 2026-11-10：上下文两道闸改成每轮现读 config（cfgLive 按 mtime 缓存，开销很小）。
  // 聊天记录页「显示设置」改完不用重启机器人；fresh 里没有 context 时回落到启动时的 cfg，老行为不变。
  const freshCtx = readConfigFresh();
  const cc = (freshCtx && freshCtx.context) ? freshCtx.context : (cfg.context || {});
  const perConv = convSettings.limitOf(k);
  const lim = Math.max(6, perConv || Number(cc.historyLimit || cfg.historyLimit || 30));
  const cap = Math.max(1200, Number(cc.historyChars || cfg.historyChars || 4000));
  while (h.length > lim) h.shift();
  let total = 0;
  for (const m of h) total += String(m.content || '').length;
  while (h.length > 4 && total > cap) total -= String(h.shift().content || '').length;
}
// 聊天记录一行：时间 [来源][群号/私聊][昵称][标记] 内容
// 标记（v78，主人 2026-10-23 定，硬限制）：
//   [→X]      —— 这句是**回 X 的**（触发人）。她回话慢，群里 0.1 秒一条，
//                面板以前按时间顺序猜「上一条是谁」→ 必然记错人。以后按这个标记认人。
//   [=主人]   —— 主人说的，但记成她自己的发言（主人非对话场景 @/引用别人时）。
// 参数 opt 可以是字符串（只写 to），也可以是 {to, asHer}。
// 不记录群（机器人群，如赛博鱼塘②塘 143620228）：scope 形如「群143620228」。
// noRecordGroups 的定位（2026-11-10 主人定，2026-11-13 修正范围）：
// 只拦「别人」的人物画像类落盘——好感/喜好/人物信息/星标/纠正/首见/约定/地域
// （见 nick.js、qq.js、core.topicAdd、core.starsAdd）。
// **主人自己触发的一律照常记**（她原话：「照常记录我」= 所有我触发的内容都要照常记录）：
// qq.js 里 noRec 先跟 isMasterUid(ev.user_id) 取反，nick.js 用 ctx.isMaster 放行，topicAdd 认 byMaster。
// 聊天记录**本身始终落盘**（主人要「聊天内容照常查看」），所以 logLine 不再过这一关。
// 约定（kind=promise）默认仍走 isNoRecordScope 被拦，带 byMaster=true 时放行；话题 / 联网结果早就放开了。
// 改 config/features.json 的 noRecordGroups 即时生效，不用重启。
function isNoRecordScope(scope) {
  const gid = (scope && typeof scope === 'string' && scope.indexOf('群') === 0) ? scope.slice(1) : 0;
  return configStore.isNoRecordGid(gid);
}
function logLine(src, who, text, isMe, scope, opt) {
  // 聊天记录一律落盘（含免记录群）：主人 2026-11-10 定「聊天内容照常查看」。
  // 免记录群不记的是「人物画像」，不是聊天内容——人物类落盘在 nick.js/qq.js/topicAdd/starsAdd 各自拦。
  const o = (typeof opt === 'string') ? { to: opt } : (opt || {});
  const label = (isMe || o.asHer) ? (cfg.botName || 'bot') : who;
  let mark = '';
  if (o.asHer) mark += '[=主人]';
  if (o.to) mark += '[→' + String(o.to).replace(/[[\]\n\r]/g, '').trim().slice(0, 20) + ']';
  const tag = (scope ? `[${src}][${scope}][${label}]` : `[${src}][${label}]`) + mark;
  // 一条消息只准占一行：正文里的换行存成字面 \n，读的时候还原（panel.js parseChatLine）。
  // 不这么做，从第二行起就是「没时间、没来源」的裸行，聊天记录页会把它算成
  // 「没署名 · 早期记录」——主人 11-12 报的「虚幻的发言被记成未知、早期人物」。
  const body = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n');
  const line = `${new Date().toISOString()} ${tag} ${body}\n`;
  append(CHATLOG_PATH, line);
  // 2026-11-19 分流：同一行按会话再写一份分片（按群/按人一键删、面板按需读）。
  // 这是派生视图，失败不影响主文件；主文件仍是所有读取/行号锚点的唯一数据源。
  chatShards.appendLine(line);
  // 她说过的每一句另外存一份（主人 2026-11-03：聊天记录丢过一次，学话的数据不能跟着丢）。
  // chat-log 是流水，会被轮转/清空；这份是只增的语料，每条带「当时对方那句」，学接话要用。
  // displayOnly（搬屎转发）：只进聊天记录，不算她说过的话，也不当"对方上一句"
  if (o.displayOnly) { /* 只留聊天记录 */ }
  else if (isMe && !o.asHer) recordSpeech(scope, text, o.to);
  else if (scope) lastOtherSay.set(scope, { nick: String(label || ''), text: String(text || '').replace(/\s+/g, ' ').slice(0, 100) });
}

// 她的语料库：data/她说过的话.jsonl（只增，不覆盖）
const SPEECH_PATH = path.join(ROOT, 'data', '她说过的话.jsonl');
const lastOtherSay = new Map();     // scope -> 她上一句之前，对方说的最后一句（当语境）
const _speechRun = new Map();       // scope -> { at, n } 这一轮她连发到第几条
function recordSpeech(scope, text, to) {
  try {
    const body = String(text || '').trim();
    if (!body) return;
    const now = Date.now();
    const last = _speechRun.get(scope) || { at: 0, n: 0 };
    const run = (now - last.at <= 120000) ? last.n + 1 : 1;   // 2 分钟内连着说 = 同一轮
    _speechRun.set(scope, { at: now, n: run });
    const row = {
      t: new Date().toISOString(), scope: String(scope || ''), to: String(to || ''),
      run, img: /\[图片\]|\[表情/.test(body), text: body.slice(0, 400),
    };
    const prev = scope ? lastOtherSay.get(scope) : null;
    if (prev && prev.text) { row.prev = prev.text; row.prevNick = prev.nick; }
    append(SPEECH_PATH, JSON.stringify(row) + '\n');
  } catch {}
}

// ===== 主人的纠正本（主人 2026-10-22 真事：「夸在哪，我去，别记错了啊」——她把调侃当成了夸） =====
// 主人说「不是夸/别记错/夸在哪」这类话时记下来，注入 systemPrompt 当铁律：同样的错不犯第二次。
const CORRECT_PATH = path.join(ROOT, 'data', 'corrections.jsonl');
// 速度优化：纠正本每条消息都被 systemPrompt 读一次，加 mtime 缓存（改了自动失效）
let _correctCache = { at: 0, text: '' };
function recordCorrection(text, replyCtx, uid) {
  const item = {
    t: new Date().toISOString(),
    uid: String(uid || ''),
    text: String(text || '').slice(0, 200),
    ctx: String(replyCtx || '').slice(0, 120),
  };
  append(CORRECT_PATH, JSON.stringify(item) + '\n');
  _correctCache.at = 0;      // 写完立刻失效，下一轮读到新的
  botWrite('data/corrections.jsonl', '纠正', item.text);
  return item;
}
function correctionLines(n) {
  let raw = '';
  try {
    const st = fs.statSync(CORRECT_PATH).mtimeMs;
    if (_correctCache.at === st) raw = _correctCache.text;
    else {
      raw = fs.readFileSync(CORRECT_PATH, 'utf8');
      _correctCache = { at: st, text: raw };
    }
  } catch { return ''; }
  const arr = raw.trim() ? raw.trim().split('\n').slice(-(Number(n) || 6)) : [];
  return arr.map(l => {
    try {
      const o = JSON.parse(l);
      return '- 「' + o.text + '」' + (o.ctx ? '（当时你在回：「' + o.ctx + '」）' : '');
    } catch { return ''; }
  }).filter(Boolean).join('\n');
}

// ===== 言外之意（主人 2026-11-21 定）：全人类通用的「话这么说、其实是这个意思」理解规则。 =====
// 不是主人专属——任何人说「不用管x」这类话都按这里的规则理解。
// 树状 + 和情绪书联动（她 05:40 定）：同一句话在不同情绪下意思可能不同。
// groups[].emotion = 'any'（不受情绪影响，永远生效）或情绪书 core id（happy/angry/sad…）。
// 落点 src/data/intents.json；面板「信息识别 → 言外之意」页 + 标错时可顺带加多条；注入 systemPrompt。
const INTENT_PATH = path.join(ROOT, 'data', 'intents.json');
// 四个信息识别功能都是 info-scan 的薄封装，读写逻辑只有一份（不建双份）。
function readIntents() { return infoScan.read('intents'); }
function addIntents(items) { return infoScan.add('intents', items); }
function delIntent(id, gidx, iidx) { return infoScan.del('intents', id, gidx, iidx); }
function intentLines(emo) {
  return infoScan.rulesOf('intents', emo).map(x => '- 「' + x.phrase + '」→ ' + x.meaning).join('\n');
}
// 四个功能的通用注入文本。emo=当前情绪 core id；text=对方这句（现读联动用）。
// 只有「规则条目」或「现读命中」任一非空才出整段，空着不烧 token。
/* 「逻辑」= 左栏顶级页（主人 2026-11-21 07:09 定）：整个项目最复杂的一块，还没有任何参考。
 * 她的原话：「我写的那些才是逻辑，你的例子不是」——所以这里**不许有我自己编的推理步骤**，
 * 只认她写进「逻辑」页的规则；星标 / 标错是「案例」，是实例不是规则。
 * 判断时还会：其它几页的条目各穿插 1 条 + 现读约定/词典/梗 + 偶尔带一条记过的人物信息。 */
const PEOPLE_PATH = path.join(ROOT, 'data', '人物列表.md');
let _pplCache = { at: 0, lines: [] };
/* 记过的人：一行一条。标了「只能对主人说 / 不能告诉别人」的不进提示词，免得在群里漏出去。 */
function peopleLines() {
  try {
    const st = fs.statSync(PEOPLE_PATH).mtimeMs;
    if (_pplCache.at === st) return _pplCache.lines;
    const lines = fs.readFileSync(PEOPLE_PATH, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s.startsWith('- ') && s.length > 6)
      .map(s => s.slice(2).trim())
      .filter(s => !/只能(对|和)?主人|不能告诉|别告诉|别外传/.test(s));
    _pplCache = { at: st, lines };
    return lines;
  } catch { return []; }
}
/* 记过的人也是坐标池里的候选（她说「根据这些逻辑，偶尔提起所有记录下的人物的信息」）：
 * 这句提到他 → lex 维自然拉高、必定排前面；没提到 → lex=0，靠 1/8 的概率保底放进去一条，
 * 由坐标分数决定它进不进，不单独插队。 */
/* 记过的人也是坐标池里的候选（她说「根据这些逻辑，偶尔提起所有记录下的人物的信息」）：
 * 这句提到他 → 必定进池（lex 维自然拉高）；没提到 → 不每句随机塞。
 * 2026-11-21 修：以前是「没提到也有 1/8 概率塞一条」，真实跑出来「我知道了」「玛德 还真有」
 * 都被塞了无关的人事档案 → 每 8 句一句噪音。现在改成低概率（1/25）+ 按句子定（同一句结果固定），
 * 并且号码打码 —— 记忆里的口径是「号打码」，提示词里带全号没有收益只有泄露风险。 */
function maskQQ(s) {
  return String(s || '')
    .replace(/(QQ\s*)(\d{5,12})/g, (m, a, n) => a + n.slice(0, 3) + '****' + n.slice(-2))
    .replace(/(^|\D)(\d{9,11})(?=\D|$)/g, (m, a, n) => a + n.slice(0, 3) + '****' + n.slice(-2));
}
function hashNum(s) {
  let h = 2166136261;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
function personCands(text) {
  const t = String(text || '');
  const lines = peopleLines();
  if (!lines.length) return [];
  const nmOf = ln => { const m = /^([^（(]{1,6})[（(]/.exec(ln); return (m && m[1] ? m[1] : '').trim(); };
  const cands = [];
  const mentioned = [];
  for (const ln of lines) {
    const nm = nmOf(ln);
    const qq = (/QQ\s*(\d{5,12})/.exec(ln) || [])[1] || '';
    if ((nm && nm.length >= 2 && t.indexOf(nm) >= 0) || (qq && t.indexOf(qq) >= 0)) {
      mentioned.push({ ln, nm: nm || qq });
    }
  }
  for (const m of mentioned) {
    cands.push({ src: 'person', label: '记过的人·' + m.nm, text: maskQQ(m.ln).slice(0, 90), hitWord: m.nm, emo: 'any', pri: 2 });
  }
  // 没提到：约 1/25 的句子随手带一条（按句子定，不随机 → 同一句结果固定、可复现）
  if (!mentioned.length && hashNum(t) % 25 === 0) {
    const ln = lines[hashNum(t) % lines.length];
    const nm = nmOf(ln);
    cands.push({ src: 'person', label: '记过的人·' + (nm || '顺带'), text: maskQQ(ln).slice(0, 90), hitWord: nm, emo: 'any', pri: 2 });
  }
  return cands;
}
/* 负面案例 = 「她说的、被判错了的那句」。
 * 2026-11-21 主人：「撤回类的标错也都是我人工撤回的，视为标错」→ 撤回也进池；
 * 但只有确认是**她说的**才算她答错。别人的话被撤回只是「别学这个说法」，不能算她答错。
 * 以前两个错：①撤回时不记谁说的；②错因读成 j.extra.note（实际存在顶层 j.note）→ 负例从没带过错因。 */
function issueSamples(n) {
  try {
    const out = [];
    for (const ln of fs.readFileSync(FEEDBACK_PATH, 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      if (String(j.kind || '').indexOf('待修复') < 0) continue;
      const raw = String(j.text || '');
      let body = String(j.sayText || '').trim();
      let note = String(j.note || '').trim();
      let isSelf = ('self' in j) ? !!j.self : undefined;
      if (!body) {
        if (/^有消息被撤回/.test(raw)) {
          const m = /「([\s\S]+?)」/.exec(raw);
          body = m ? m[1].trim() : '';
          // 老撤回记录没有 self 字段：不知道是谁说的 → 不当她的错话（89 条全是这种）
        } else if (/^手动标记：/.test(raw)) {
          isSelf = true;                              // 她亲手标的 = 判她这句错
          const s = raw.replace(/^手动标记：/, '').trim();
          const p = s.split('｜');
          body = p[0].trim();
          if (!note && p.length > 1) note = p.slice(1).join('｜').trim();
        } else if (/^本次故障补记/.test(raw)) {
          isSelf = true;                              // 补记的是「她当时回错了」
          body = raw.replace(/^本次故障补记（[^）]*）：?/, '').trim();
        } else {
          body = raw.trim();
        }
      }
      if (isSelf !== true) continue;                  // 别人的话被撤回 / 判定不了 → 不进负例
      body = String(body || '').replace(/@\d{5,12}\s*/g, '')
        .replace(/（含\s*\d+\s*句上下文）/g, '').replace(/\s+/g, ' ').trim();
      if (body.length < 4) continue;
      if (/[\u0370-\u03ff\u0400-\u04ff]/.test(body)) continue;   // 乱码当案例只会教坏
      out.push({ text: body.slice(0, 140), note: note.slice(0, 80), t: String(j.t || '') });
    }
    return out.slice(-Math.max(1, Number(n) || 1)).reverse();
  } catch { return []; }
}
/* 负面案例进池：按这句话的 hash 定，不随机（同一句结果固定、可复现）。
 * 并且把「错在哪」带上 —— 只说「你错了」不给方向的负例对她没用。 */
function issueCands(text) {
  const rows = issueSamples(20);
  if (!rows.length) return [];
  const x = rows[hashNum(text) % rows.length];
  if (!x) return [];
  const why = (x.note && x.note.length >= 3) ? '（错在：' + x.note + '）' : '';
  return [{
    src: 'bad', label: '案例·她答错过',
    text: String(x.text).slice(0, 70) + why,
    emo: 'any', pri: 3,
  }];
}
function logicBlock(emo, text, deps) {
  // 坐标向量选材（她 2026-11-21：「要做成坐标向量选取所有「信息识别」「情绪表达」里面的内容」
  // 「是穿插多条」）：所有条目各有一个坐标，这句话也先算一个坐标，按距离打分取多条，
  // 不再「每页各 1 条」。候选池 = info-scan 五页全部规则与星标 + 情绪书命中叶 + 教学库情绪表达
  // + 现读（词典/梗/约定）+ 人物 + 标错案例。
  const r = coord.pick(text, emo, deps, { budget: 1100, extra: personCands(text).concat(issueCands(text)) });
  if (!r.picked.length) return '';
  return '\n## 逻辑（按这句话的坐标，从全部条目里取了 ' + r.picked.length + ' 条；'
    + '言外之意/信息量/梗含量/自我表达/情绪表达/案例/人物都在同一个池子里按远近排序；'
    + '只用来想清楚再回，一个字都不许念出来）\n'
    + r.lines.join('\n');
}
function infoScanBlock(key, emo, text) {
  const spec = infoScan.SPECS[key];
  if (!spec) return '';
  const deps = {
    dictGloss: dictLib.dictGloss,
    glossaryHit: (function () { try { return require('./guides').glossaryHit; } catch { return null; } })(),
    pactHit: pactHit,
    pactsFor: function () { try { return readPromises(); } catch { return []; } },
  };
  if (key === 'logic') return logicBlock(emo, text, deps);
  const rules = infoScan.rulesOf(key, emo);
  const hits = infoScan.liveHits(key, text, deps);
  if (!rules.length && !hits.length) return '';
  const lines = [];
  for (const r of rules) lines.push('- 「' + r.phrase + '」→ ' + r.meaning);
  for (const h of hits) lines.push('- ' + h + '（现读命中，只帮你理解这句）');
  const GUIDE = {
    intents: '这是「话这么说、其实是这个意思」。任何人说左边那类话，按右边理解；只用来理解，不许把规则念出来。',
    infoamount: '这是在判断「这句话信息量多少」。只用来决定该给多少实质内容，不许把判断念出来。',
    memecontent: '这是在判断「这句话的梗含量」。只用来决定正经答还是接梗，不许把判断念出来。',
    selfexpress: '这是在判断「这句话是在表达他自己，还是在说客观事/别人」。只用来理解，不许把判断念出来。',
    logic: '这是在判断「这句话的逻辑」：前提成不成立、因果顺不顺、有没有在设条件/挖坑/反讽。只用来理解，不许把判断念出来。',
  };
  // 星标样本（2026-11-21）：她把自己说得好、被认可的话星标了，并在面板勾了「这项到位」。
  // 只在这个功能已经有规则/命中时才带一条当正面示范（没启用就不烧 token），最多 1 条 46 字。
  let starLine = '';
  try {
    const st = infoScan.starsOf(key, 1)[0];
    if (st && st.text) starLine = '正面示范（被星标过、这一项到位）：' + String(st.text).slice(0, 46);
  } catch {}
  return '\n## ' + spec.label + '（全人类通用·情绪联动，只帮你理解这句，别念出来）\n'
    + lines.join('\n') + '\n' + (GUIDE[key] || '')
    + (starLine ? '\n' + starLine : '');
}

// ===== 她的反馈（主人 2026-10-22 定；页面名「虚幻自查」，主人 2026-10-23 改）：AI 自主反馈渠道，只在面板看，QQ 不发 =====
// 现在收三样：①没发出去的内容（表情库里没有这张、空回复）②她自查到的问题（selfwatch 写）
// ③模型本身的故障（Key 不对 / 限流 / 全挂）——原来只打到控制台，主人不盯后台就永远看不到。
// data/ai-feedback.jsonl，面板「虚幻自查」页可看可清空。
/* ===== 撤回 / 待修复问题（主人 2026-11-06 定）=====
 * ① 被撤回的消息不许进风格样本：qq.js 收到撤回事件时调 forgetStyle + markRecalled，
 *    之后 learnStyle 前先过 isRecalled 闸门。
 * ② 撤回自动加一条待修复问题：复用「虚幻自查」的 ai-feedback.jsonl（kind='待修复'），
 *    客户端聊天记录页能看、能标「已修好」，不另建平行文件。
 * ③ 主人手动对聊天记录标错误也走 addIssue，同一个池。 */
const recalledMids = new Set();
const recalledTexts = new Set();
function markRecalled(mid, text) {
  if (mid) recalledMids.add(String(mid));
  const t = String(text || '').trim();
  if (t) recalledTexts.add(t);
  // 2026-11-07：撤回是「今天真发生过的事」，顺手写进按天工作日志（不进提示词）
  try { memory.appendLog('撤回', '消息被撤回，风格样本已清：' + t.slice(0, 60)); } catch {}
}
function isRecalled(mid, text) {
  if (mid && recalledMids.has(String(mid))) return true;
  const t = String(text || '').trim();
  return !!t && recalledTexts.has(t);
}
function forgetStyle(opt) {
  const o = opt || {};
  let n = 0;
  try { n += style.removeByMid(o.mid); } catch {}
  try { n += style.removeByText(o.text); } catch {}
  return n;
}
// extra: { emo, note }。emo＝情绪场合标签；note＝给模型看的一句短教训（不许放错话原文）。
// 老调用只传 (kind, text)，一律照旧，不受影响。
function addIssue(kind, text, extra) {
  aiFeedback(kind || '待修复', text, extra);
  // 2026-11-07：待修复问题是「今天发现的事」，顺手写进按天工作日志（不进提示词）
  try { memory.appendLog('问题', '[' + (kind || '待修复') + '] ' + String(text || '').slice(0, 120)); } catch {}
  return true;
}

/* ===== 空间评论的合规判定（2026-11-17 主人令）=====
 * 她原话：「合规不是新功能，是星标和标错」——所以这里不另造一套打分：
 *   合规 → starsAdd（scope=qzone、nick=虚幻）→ starSamples 直接进提示词当正面样本；
 *   不合规 → addIssue('待修复') → 和聊天记录标错同一个池，lowScoreExamples 下一轮自动当负例。
 * 判过没判过只看 qzone-comment 记录行的 verdict 标记，不重复进池。 */
const qcRec = require('./qzone-comment');
function qzonePending(n) { return qcRec.pending(n || 5); }

/* verdict: 'ok' | 'bad'；note: 她写的理由（可空）；by: '私信' | '客户端' */
function qzoneJudge(key, verdict, note, by) {
  const k = String(key || '');
  const { entry } = qcRec.findByKey(k);
  if (!entry) return { ok: false, error: '没找到这条评论记录' };
  if (entry.verdict) return { ok: false, error: '这条已经判过了（' + (entry.verdict === 'star' ? '合规' : '不合规') + '）' };
  const who = String(entry.name || entry.qq || '');
  const why = String(note || '').trim();
  if (verdict === 'bad') {
    addIssue('待修复', String(entry.comment || ''), {
      note: '空间评论' + (why ? '：' + why : '不合规'),
      ctx: [{ nick: who, text: String(entry.src || '') }],
    });
    const r = qcRec.markVerdict(k, 'issue', why, by);
    return r.ok ? { ok: true, action: 'issue', entry: r.entry } : r;
  }
  const res = starsAdd({
    t: String(entry.t || new Date().toISOString()),
    scope: 'qzone',
    nick: String((cfg && cfg.botName) || '虚幻'),
    text: String(entry.comment || ''),
    prev: String(entry.src || '').slice(0, 100),
    prevNick: who,
    src: 'qzone',
    by: 'manual',                                   // 她亲手判的，等同手动星标
    note: why || ('空间评论（' + who + ' 的动态）'),
    ctx: [{ nick: who, text: String(entry.src || ''), bot: false }],
  });
  const r = qcRec.markVerdict(k, 'star', why, by);
  if (!r.ok) return r;
  return { ok: true, action: res === 'added' ? 'star' : res, entry: r.entry };
}

const FEEDBACK_PATH = path.join(ROOT, 'data', 'ai-feedback.jsonl');
// 2026-11-14 主人令（代码硬限制）：「确认无效就清」写进代码，不再靠问、不再等点头。
// 已确认无效的假警报——「回复会全部哑火」「模型连不上（所有主备模型都失败）」「NapCat 连接断开」——
// 一律不写、不入库；历史里已有的，模块加载时自动清掉（每次启动扫一遍，永久生效）。
const INVALID_FB_RE = /回复会全部哑火|模型连不上（所有主备模型都失败）|NapCat 连接断开/;
function purgeInvalidFeedback() {
  try {
    if (!fs.existsSync(FEEDBACK_PATH)) return;
    const lines = fs.readFileSync(FEEDBACK_PATH, 'utf8').split('\n').filter(l => l.trim());
    const kept = lines.filter(l => !INVALID_FB_RE.test(l));
    if (kept.length !== lines.length) fs.writeFileSync(FEEDBACK_PATH, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch { }
}
purgeInvalidFeedback();
function aiFeedback(kind, text, extra) {
  if (INVALID_FB_RE.test(String(text))) return;   // 硬限制：确认无效的假警报不入库
  try {
    const o = { t: new Date().toISOString(), kind: String(kind || '其他'), text: String(text || '').slice(0, 300) };
    if (extra && typeof extra === 'object') {
      if (extra.emo) o.emo = String(extra.emo);
      if (extra.note) o.note = String(extra.note).slice(0, 60);
      // 2026-11-21：撤回/标错要当负例用，必须留下「谁说的、说的什么、是不是她说的」。
      // 以前这里只白名单 emo/note/ctx，撤回时算出来的发言人和正文全被丢掉，
      // 于是 89 条撤回记录一条都看不出是谁说的（主人：「你当时就把功能写错了」）。
      if (extra.sayer) o.sayer = String(extra.sayer).slice(0, 16);
      if (extra.sayerNick) o.sayerNick = String(extra.sayerNick).slice(0, 24);
      if ('self' in extra) o.self = !!extra.self;
      if (extra.sayText) o.sayText = String(extra.sayText).replace(/\s+/g, ' ').slice(0, 200);
      if (extra.gid) o.gid = String(extra.gid).slice(0, 16);
      if (extra.mid) o.mid = String(extra.mid).slice(0, 24);
      if (extra.by) o.by = String(extra.by).slice(0, 16);
      // 多选上下文（2026-11-07 主人：「错误也能多选」）：只给人看「当时在聊什么」，
      // 不进提示词、也不当 note 用——note 才是给模型看的一句短教训，这里不能混。
      if (Array.isArray(extra.ctx) && extra.ctx.length) {
        o.ctx = extra.ctx.slice(0, 8).map(x => ({
          nick: String((x && x.nick) || '').slice(0, 20),
          text: String((x && x.text) || '').replace(/\s+/g, ' ').slice(0, 160),
          bot: !!(x && x.bot),
        }));
      }
    }
    append(FEEDBACK_PATH, JSON.stringify(o) + '\n');
  } catch {}
}
/* 同场合有没有还没修好的问题。带 mtime+size 缓存，文件没变不重读。
 * 返回给模型的是两句动作，不是错话原文；text 只在面板给人看。 */
let _issueCache = { key: '', emos: {} };
function readIssueFor(emo) {
  if (!emo) return '';
  try {
    const st = fs.statSync(FEEDBACK_PATH);
    const key = st.mtimeMs + ':' + st.size;
    if (key !== _issueCache.key) {
      const emos = {};
      for (const ln of fs.readFileSync(FEEDBACK_PATH, 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        let o; try { o = JSON.parse(ln); } catch { continue; }
        if (o.kind === '待修复' && o.emo) emos[o.emo] = String(o.note || '').slice(0, 60);
      }
      _issueCache = { key, emos };
    }
    const note = _issueCache.emos[emo];
    if (note === undefined) return '';
    return '- 上次这种场合：' + (note || '有一句被标成错误') + '。\n'
      + '- 这次先看清是谁在说话，按当下这句话另回一句。';
  } catch { return ''; }
}
// 同一类故障 10 分钟内只记一条（别在限流那会儿把反馈刷满）
const _failNoteAt = {};
function noteFail(kind, text) {
  const now = Date.now();
  if (now - (_failNoteAt[kind] || 0) < 10 * 60 * 1000) return;
  _failNoteAt[kind] = now;
  aiFeedback(kind, text);
}

/* 【分类 F·全场景通用】话题/约定：记话题日志、约定长期记忆，全平台共用、按场景选择注入。
 * ===== 话题日志 + 话题 + 约定（2026-10-22 主人定，和聊天记录并行）=====
 * 机器人把「可能是话题的内容」记进 data/topics.jsonl，一行一条：
 *   kind:  topic=话题日志里的 / promise=约定（长期记忆，和人物列表里的约定并行）
 *   type:  self=自己总结的 / quote=别人的原文 / search=联网搜到的 / manual=主人手动录入
 *   state: raw=还没总结 / summed=已总结（在话题日志里）/ kept=已收进「话题」（约定恒为 kept）
 *   parent: 被总结后，原始内容挂到已总结话题底下（灰色显示）
 * 面板「长期记忆」下：话题日志（raw/summed）/ 话题（kept）/ 约定（promise）。
 */
const TOPICS_PATH = path.join(ROOT, 'data', 'topics.jsonl');
const TOPIC_TYPES = {
  self:   { name: '自己总结', color: '#a78bfa' },
  quote:  { name: '别人原文', color: '#2dd4bf' },
  search: { name: '搜索到的', color: '#fb923c' },
  manual: { name: '手动录入', color: '#94a3b8' },
};
/* 话题三级（2026-11-13 主人令：「应该分为：单人话题、群话题、通用话题」）。
 *   single 单人话题：挂一个人（qq），只在他本人说话时给他用，别人一个字都看不到
 *   group  群话题：挂一个群（scope 有群号、没挂人），只在该群注入
 *   common 通用话题：都不挂，哪儿都能用（内容照样过一遍脱敏）
 * 老条目没有 level 就按 qq / scope 现推，不改一个字节的历史数据。 */
const TOPIC_LEVELS = { single: '单人话题', group: '群话题', common: '通用话题' };
/* 一条话题可以同时属于多级（主人 2026-11-13：「单人/群/通用话题重合」「平台记录的话题默认同时是单人、通用」）。
 *   single 单人：在这个人出现的场合（他在的群 / 他的平台 / 私聊）都能用，别人看不到
 *   group  群：只在这个群，不出群
 *   common 通用：哪儿都能用；含 common 的恒为长期，不过期
 * 老条目只有 level 字符串 → 当单级读，一个字节都不用迁。 */
const TOPIC_TTL = { single: 2, group: 10 };   // 单人每人 2 条、每群 10 条；超出的算过期（不注入，数据保留）
function levelsOfParts(qq, scope, platform) {
  const q = String(qq || '').trim(), s = String(scope || '');
  const plat = String(platform || '').trim();
  // 平台（非 QQ）上记的：同时是单人 + 通用（她原话）
  if (plat && plat !== 'qq') return ['single', 'common'];
  if (/群\s*\d+/.test(s)) return ['group'];          // QQ 群里聊出来的就是本群话题，不用她改
  if (!s) return q ? ['single'] : ['common'];
  if (/私聊|private/.test(s)) return ['single'];
  return q ? ['single'] : ['common'];
}
function topicLevelsOf(it) {
  const raw = it && it.levels;
  if (Array.isArray(raw)) {
    const list = raw.map(String).filter(x => TOPIC_LEVELS[x]);
    if (list.length) return list;
  }
  const lv = String((it && it.level) || '');
  if (TOPIC_LEVELS[lv]) return [lv];
  return levelsOfParts(it && it.qq, it && it.scope, it && it.platform);
}
function topicLevel(it) { return topicLevelsOf(it)[0] || 'common'; }
const levelOfParts = (qq, scope) => levelsOfParts(qq, scope)[0];
/* 过期集合：单人按人数最近 2 条、群按群数最近 10 条；含 common 或标了 ttl='long' 的永不过期。
 * 只影响注入，不删数据 —— 前端能看、能手动转长期。 */
function expiredTopicIds(rows) {
  const out = new Set();
  const nP = new Map(), nG = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const x = rows[i];
    if (!x || x.kind === 'promise') continue;
    if (String(x.ttl || '') === 'long') continue;
    const lv = topicLevelsOf(x);
    if (lv.indexOf('common') >= 0) continue;
    if (lv.indexOf('single') >= 0) {
      const key = String(x.qq || '') || ('p:' + String(((x.participants || [])[0] || {}).key || ''));
      if (key) {
        const n = (nP.get(key) || 0) + 1;
        nP.set(key, n);
        if (n > TOPIC_TTL.single) out.add(String(x.id));
      }
    }
    if (lv.indexOf('group') >= 0) {
      const g = (String(x.scope || '').match(/群\s*(\d+)/) || [])[1];
      if (g) {
        const n = (nG.get(g) || 0) + 1;
        nG.set(g, n);
        if (n > TOPIC_TTL.group) out.add(String(x.id));
      }
    }
  }
  return out;
}
/* ===== 名字从哪来（主人 2026-11-21：「名字是面板里给我看的，ai 应该读人物表」）=====
 * 「跟X的约定」只是**面板上的标签**，不是身份，也不参与任何判定：
 *   · 身份 = qq 那个键（qq:1000000002）——判定、按人取、按人注入，一律只认它；
 *   · 要显示一个人叫什么，就读人物表（people.nameOfPerson），读不到才退回当时的 QQ 名。
 * QQ 资料卡名里常带 ⁧…⁧ 这种方向控制符（面板显示成一团，跟人物表里的名字也对不上），
 * 落标签前先剥掉——只影响显示，不参与判定。 */
const INVIS_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/* 显示名：**只读人物表**，依次取「确认的名字 → 人物表里那个号的群名片/资料卡名 → 传进来的 QQ 名」。
 * 任何地方要显示一个人叫什么，都从这里取，别各写一份、更别从标签串里抠字。 */
function personNameOf(keyOrUid, fallback) {
  const k = String(keyOrUid == null ? '' : keyOrUid).trim();
  if (k) {
    try {
      const pid = people.pidOfKey(k);
      if (pid) {
        const n = String(people.nameOfPerson(pid) || '').trim();
        if (n) return n;
        const p = people.get(pid) || {};
        for (const a of (p.accounts || [])) {
          const cards = (a && a.cards) || {};
          const card = String(Object.keys(cards).map(g => cards[g]).filter(Boolean).slice(-1)[0] || '');
          const nm = String(card || (a && a.nick) || '').replace(INVIS_RE, '').trim();
          if (nm) return nm;
        }
      }
    } catch {}
  }
  return String(fallback == null ? '' : fallback).replace(INVIS_RE, '').replace(/\s+/g, ' ').trim();
}
/* 从本人说的话里认出性别（2026-11-22 她令）：
 * 「对话里发现是女就改成女，确认是男再确认」。只认「我/本人 + 是 + 男/女」这种自述，
 * 避免把「她是个女的」当成说话人自己的性别。一个号 60 秒最多判一次。 */
const _sexNoteAt = new Map();
function noteSexFromText(uid, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 160) return;
  const key = people.keyOf(uid);
  const pid = key ? people.pidOfKey(key) : '';
  if (!pid) return;
  const hitF = /(?:^|[，。！？、；;\s])(?:我|本人)(?:也|其实|真的|确实)?(?:是|就是)(?:个|一个)?(?:女|女生|女的|女孩子|姑娘)(?:$|[，。！？、；;\s])/.test(t);
  const hitM = /(?:^|[，。！？、；;\s])(?:我|本人)(?:也|其实|真的|确实)?(?:是|就是)(?:个|一个)?(?:男|男生|男的|男孩子|爷们)(?:$|[，。！？、；;\s])/.test(t);
  if (!hitF && !hitM) return;
  const sex = hitF ? 'female' : 'male';
  const now = Date.now();
  if (now - (_sexNoteAt.get(pid) || 0) < 60 * 1000) return;
  _sexNoteAt.set(pid, now);
  const cur = people.sexOf(pid);
  const src = people.sexSrcOf(pid);
  if (cur === sex) {
    // 已经是这个性别：之前只是猜的、这次本人说了 → 升级成「听本人说的/确认」
    if (src === 'guess') people.setSex(pid, sex, sex === 'male' ? 'confirmed' : 'said');
    return;
  }
  people.setSex(pid, sex, sex === 'male' ? 'confirmed' : 'said');
}

/* 约定标签：跟<人物表里的名字>的约定（X 永远按号去人物表查，不用传进来的昵称猜） */
function pactLabelOf(keyOrUid, fallbackName) {
  return '跟' + (personNameOf(keyOrUid, fallbackName) || '他') + '的约定';
}
/* 标签怎么落，只在这里定一次（录入 / 面板改 / 重判归属都调它）：
 *   约定 → 跟<人物表里的名字>的约定；记忆事实 / 话题 → 12 字分类。
 * 标签只给面板看，长度规则也只为显示，不参与任何判定。 */
function topicLabelFor(raw, o) {
  const s = String(raw || '').replace(/^#+\s*/, '').replace(/[\r\n]+/g, ' ').replace(INVIS_RE, '').trim();
  if (!(o && o.pact)) return s.slice(0, 12);
  if (!s) return pactLabelOf(o.qq, o.nick || o.who);          // 没给标签 → 按人物表生成
  const m = s.match(/^跟(.{1,60})的约定$/);
  if (m) return pactLabelOf(o.qq, m[1]);                      // 「跟X的约定」的 X 一律按人物表重算
  return s.slice(0, 40);                                      // 主人自己起的分类词（代称 / 附加功能约定…）原样留着
}
/* 这条是不是「约定」（照做的规矩）——看**录入时写下的 pact 字段**，
 * 不再拿标签里有没有「跟」「的约定」这几个字当判据（长昵称被截断就整条失踪，2026-11-21 事故）。
 * 2026-11-21 之前落的数据没有这个字段：只读兼容认一次老特征，不回写、不迁移。 */
function isPact(x) {
  if (!x || x.kind !== 'promise') return false;
  if (x.pact === true) return true;
  if (x.pact === false) return false;
  return /^跟.{0,60}的约定$/.test(String(x.topic || ''));
}

let topicSeq = 0;
function topicAdd(o) {
  o = o || {};
  // 2026-11-10 主人定：免记录群只拦「约定」（kind=promise），话题 / 联网结果放开（只记话题，约定不记）
  // 2026-11-13 主人修正：她自己触发的一律照常记，byMaster=true 直接放行（闸只留给别人）
  if (isNoRecordScope(o.scope) && o.kind === 'promise' && !o.byMaster) return null;
  /* 约定 / 记忆事实在**录入这一刻**分清楚，后面所有判定只看 pact 字段：
   * promiseAdd 进来的一律是约定（要照做的规矩），记忆事实（喜好/日常/附加功能配置）显式传 pact:false。 */
  const isPromise = o.kind === 'promise';
  const pact = isPromise && o.pact !== false;
  const text = String(o.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return null;
  const lvIn = String(o.level || '');
  const levelsIn = Array.isArray(o.levels) ? o.levels.map(String).filter(x => TOPIC_LEVELS[x]) : [];
  const levels = levelsIn.length ? levelsIn
    : (TOPIC_LEVELS[lvIn] ? [lvIn] : levelsOfParts(o.qq, o.scope, o.platform));
  // 参与人：话题记下来那一刻属于所有参与的人（她原话），不是只属于发起人
  const parts = (Array.isArray(o.participants) ? o.participants : [])
    .map(p => ({ key: String((p && p.key) || p || '').slice(0, 60), name: String((p && p.name) || '').slice(0, 40) }))
    .filter(p => p.key);
  if (o.qq && !parts.some(p => p.key === String(o.qq))) parts.push({ key: String(o.qq), name: String(o.who || o.nick || '').slice(0, 40) });
  const it = {
    id: 'T' + Date.now().toString(36) + (topicSeq++).toString(36) + Math.floor(Math.random() * 1296).toString(36),
    t: new Date().toISOString(),
    kind: o.kind === 'promise' ? 'promise' : 'topic',
    /* 录入时一次写清：这条是不是「照做的规矩」。后面 pactLines / 取消 / 换回 / 兜底全看它，
     * 不再拿 topic 里的字去猜（2026-11-21 主人：「录入的时候就一次录对，别找补」）。
     * 只有约定才写这个字段——话题日志是高频写入，不多带一个恒 false 的键。 */
    ...(isPromise ? { pact } : {}),
    type: TOPIC_TYPES[o.type] ? o.type : 'quote',
    level: levels[0],
    levels,
    participants: parts.slice(0, 60),
    platform: String(o.platform || ''),
    // 短期 / 长期：通用恒长期；单人 / 群默认短期（按 2 / 10 条过期），她可以在前端改成长期
    ttl: (String(o.ttl || '') === 'long' || levels.indexOf('common') >= 0) ? 'long' : 'short',
    state: o.state === 'summed' || o.state === 'kept' ? o.state : 'raw',
    who: String(o.who || '').slice(0, 40),
    qq: String(o.qq || ''),
    scope: String(o.scope || '').slice(0, 40),
    // 约定上的名字也按人物表写（面板显示、别人的记号提醒都读它），没建档的人退回 QQ 名
    nick: pact ? personNameOf(o.qq, o.nick || o.who).slice(0, 40) : String(o.nick || o.who || '').slice(0, 40),
    /* 标签只给面板看，不是判定依据（主人 2026-11-21：「名字是面板里给我看的」）：
     *   约定 → 「跟<人物表里的名字>的约定」，X 按号去人物表查，不用传进来的 QQ 昵称；
     *   记忆事实（喜好/日常…）→ 还是短分类词；话题日志 → 12 字分类。
     * 以前按「像不像 跟X的约定」猜长短，猜错就整条判定失败——现在不猜了。 */
    topic: topicLabelFor(o.topic, { pact, qq: o.qq, nick: o.nick, who: o.who }),
    parent: String(o.parent || ''),
    text,
    sum: String(o.sum || ''),
    // 句尾记号（2026-11-03 补）：pactAdd 算出来的 sig 以前没存，发送层剥不掉别人的约定记号。
    sig: String(o.sig || ''),
    // 约定拆件（2026-11-06）：say=要原样说出口的（含符号/标点）、when=什么情况下说、note=修饰（别解释这类）。
    // 老条目没有这三个字段，读的时候由 pactSplit 现拆，行为不变。
    say: String(o.say || ''),
    when: Array.isArray(o.when) ? o.when.slice(0, 40) : [],
    note: String(o.note || ''),
    // 附加功能（保健提醒 / 唱歌…）的单人设置（2026-11-10 主人定）：约定高于默认开关，只对单人生效。
    // 老条目没有这个字段，读到 undefined 就当「没提过要求」，老行为一个字不变。
    addon: (o.addon && typeof o.addon === 'object') ? o.addon : null,
    // 约定分区（2026-11-13）：说话方式 / 身份认知 / 情绪认知与应对 / 禁止回复 / 常态情绪 / 代称。
    // 以前只在 teach.SECTIONS 登记了名字，落盘没这个字段；现在真存，前端「记录的」页按它分类。
    section: String(o.section || ''),
    /* 方向（梗词句 / 情绪表达 / 游戏攻略）——2026-11-21 补：
     * 「约定」本体以前不带 dir，只有一次性的 fix.py 手工补过，promiseAdd 再走一遍就丢，
     * 面板「约定」页里这条就归不进梗词句。约定本体和教学条副本各有各的 dir，各存一份不复制。 */
    dir: String(o.dir || '').slice(0, 12),
    // 复核（2026-11-12）：新录入的话题/约定 = pending，等主人在前端重新判断归属和内容。
    // 不在这里算 5 条证据：话题是高频写入，每条都读一遍 chat-log 会拖慢；
    // 前端点「看原记录」时由 /api/review/evidence 按需补，原始日志一行不动。
    review: review.fresh({ legacy: false }),
  };
  try {
    fs.mkdirSync(path.dirname(TOPICS_PATH), { recursive: true });
    append(TOPICS_PATH, JSON.stringify(it) + '\n');
    botWrite('data/topics.jsonl', it.kind === 'promise' ? '约定' : '话题',
      (TOPIC_TYPES[it.type] ? TOPIC_TYPES[it.type].name + ' · ' : '') +
      (it.topic ? '【' + it.topic + '】' : '') + it.text.slice(0, 120));
  } catch (e) { console.error('[topic] 写不进：' + e.message); }
  // 共同话题 → 参与人之间的关系（主人 2026-11-13：大于 2 条互相变「喜」）。约定不算共同话题。
  if (it.kind === 'topic' && it.participants.length > 1) {
    try { relation.noteTopics(it.participants); } catch (e) { console.error('[relation] 没记上：' + e.message); }
  }
  return it;
}
// 约定：长期记忆的另一个入口（和人物列表.md 并行），说过的要做到
function promiseAdd(o) {
  o = o || {};
  return topicAdd(Object.assign({}, o, { kind: 'promise', state: 'kept' }));
}
function readTopics(limit) {
  // 速度优化（2026-10-22）：topics.jsonl 每条消息都在长（≥10 字的发言都会记一条），
  // 以前每条消息要把它从头到尾读 + 解析 3~4 次（promiseLines / keptTopicLines / topicHint 各一次）。
  // 现在按（mtime+大小）缓存解析结果：文件没变就直接用上次解析好的数组，stat 一次就够。
  // 文件一改（面板增删、机器人追加）缓存自动失效，行为和以前完全一样。
  let out = _topicsCache;
  try {
    const st = fs.statSync(TOPICS_PATH);
    if (!_topicsCache || _topicsCacheAt.mtimeMs !== st.mtimeMs || _topicsCacheAt.size !== st.size) {
      const raw = fs.readFileSync(TOPICS_PATH, 'utf8');
      out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j && j.id) out.push(j); } catch {}
      }
      _topicsCache = out;
      _topicsCacheAt = { mtimeMs: st.mtimeMs, size: st.size };
    } else {
      out = _topicsCache;
    }
  } catch { out = []; }
  return limit && out.length > limit ? out.slice(-limit) : out;
}
let _topicsCache = null;
let _topicsCacheAt = { mtimeMs: 0, size: 0 };
// 约定条目（每轮对话都带着）
function readPromises() { return readTopics().filter(x => x.kind === 'promise'); }
// 已收进「话题」的（总结好、记住的）
function readKeptTopics() { return readTopics().filter(x => x.kind !== 'promise' && x.state === 'kept'); }

// ===== 话题自动总结（v64，主人 2026-10-22 定：「记录文件不许没下文」）=====
// 以前话题日志只进不出：226 条 raw 堆着，只有主人手动点面板的「总结」才会动。
// 现在机器人自己每 30 分钟整一批（bot.js 定时调）：
//   ① 先用规则把**明显没下文的垃圾**标 dropped（图翻译、骰子结果、纯表情/超短句）；
//   ② 剩下的批量给模型（走备用模型，别抢主模型）：值得记的概括成一句 → state=summed，原文挂 parent；
//   ③ 模型两轮都不要的（它觉得没可记的）也标 dropped——不永久堵队列。
// dropped 的不进「话题」（长期记忆），在话题日志里灰着可查，面板照旧能手动救回来。
function writeTopicsAll(list) {
  try {
    fs.writeFileSync(TOPICS_PATH, list.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    _topicsCache = null;   // 写完立刻失效缓存
  } catch (e) { console.error('[topic] 写不回：' + e.message); }
}
// 明显没下文的：不用模型，规则直接判（省 token 也省时间）
function topicJunk(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^（图上：/.test(s)) return true;                       // 图片翻译，不是他说的话
  if (/概率是：\d+%/.test(s) || /^[.。][a-z]/i.test(s)) return true;   // 骰子结果 / 指令回显
  if (s.replace(/\s/g, '').length < 6) return true;           // 纯表情、超短句
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\setary.。，,！!？?~～\[\]（）()]+$/u.test(s)) return true;   // 表情洪水
  return false;
}
async function topicAutoSum() {
  const all = readTopics();
  const raw = all.filter(x => x.kind !== 'promise' && x.state === 'raw' && !x.parent);
  if (!raw.length) return 0;
  // ① 规则垃圾直接出队
  let changed = false;
  for (const it of raw) {
    if (topicJunk(it.text)) { it.state = 'dropped'; changed = true; }
  }
  let left = raw.filter(x => x.state === 'raw');
  console.log('[topic] 自动总结：垃圾出队后剩 ' + left.length + ' 条待整');
  // ② 批量交给模型（一批最多 30 条，最旧的先）
  const batch = left.slice(0, 30);
  if (batch.length && String((cfg.llm || {}).apiKey || '').trim() && !cfg.llm.apiKey.includes('在这里填')) {
    const lines = batch.map((x, i) => i + 1 + '. ' + x.text.replace(/\s+/g, ' ').slice(0, 100)).join('\n');
    try {
      const out = await callLLM([
        { role: 'system', content: '你在整理一个聊天话题日志。下面每行编号是一条「可能是话题的原始发言」。'
          + '判断每条**值不值得当长期话题记住**（有人物/事件/结论/偏好的才值得；寒暄、口水话、看不懂上下文的碎片不值得）。'
          + '值得的输出一行「编号 | 一句话概括」（保留人名、事物、结论，10~40 字）；不值得的**输出「编号 | 跳过」**。'
          + '只输出这些行，一行一条，不要解释、不要 markdown。' },
        { role: 'user', content: lines },
      ], { preferFallback: true, tag: 'topic-sum' });
      const kept = new Map();
      for (const line of String(out || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[｜|]\s*(.+)$/);
        if (!m) continue;
        const i = Number(m[1]) - 1;
        const sum = m[2].replace(/^跳过.*$/, '').trim();
        if (m[2].includes('跳过') || !sum) continue;
        if (batch[i]) kept.set(batch[i].id, sum.slice(0, 120));
      }
      for (const it of batch) {
        if (kept.has(it.id)) {
          it.state = 'summed';
          // 原文挂到总结条底下（和面板手动总结同一格式：原文 parent=总结 id）
          const nt = {
            id: 'T' + Date.now().toString(36) + (topicSeq++).toString(36) + Math.floor(Math.random() * 1296).toString(36),
            t: new Date().toISOString(), kind: 'topic', type: 'self', state: 'kept',   // 直接收进「话题」（进长期记忆，别停在半路）
            who: it.who, qq: it.qq, scope: it.scope, nick: it.nick, topic: it.topic || '',
            // 参与人必须跟着进 kept（主人 2026-11-21：cap 按参与人数放大可查记录数就靠它）。
            // 丢在这里会让 kept 话题 participants 全空 → cap 恒=30 → 放大功能失效。落点 core.js:1246。
            participants: it.participants || [],
            parent: '', text: kept.get(it.id), sum: '',
          };
          it.parent = nt.id;
          all.push(nt);
        } else {
          it.tries = (it.tries || 0) + 1;
          if (it.tries >= 3) it.state = 'dropped';   // 三轮都不要：出队，不永久堵着
        }
        changed = true;
      }
      console.log('[topic] 自动总结：收进 ' + kept.size + ' / ' + batch.length);
    } catch (e) { console.log('[topic] 自动总结这轮跳过：' + e.message.slice(0, 60)); }
  }
  if (changed) writeTopicsAll(all);
  return 1;
}
// 中文二字切片（和 guides.js 一个思路）：判断一句话和某个话题是不是在说同一件事
function sliceSet(s) {
  const cj = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < cj.length - 1; i++) set.add(cj.slice(i, i + 2));
  return set;
}
function sliceShared(a, b) {
  const A = sliceSet(a), B = sliceSet(b);
  let n = 0;
  A.forEach(x => { if (B.has(x)) n++; });
  return n;
}

/* 【分类 F·全场景通用】记忆分层：长期/短期记忆注入口径，全平台共用。
 * ===== 记忆分层（2026-10-22 主人定）=====
 * 长期记忆 = data/人物列表.md（人物事实）+ 约定（说过的要做到）+ 话题（总结记住的），每轮都带
 * 短期记忆 = 聊天记录里这个人最近说过的话（按人单开那个入口，机器人可据此回顾上下文）
 * 即时记忆 = 当前会话最近 20 条；每 2~8 条回复 call back 一次（挑件旧事自然地提一句）
 * 对方说「之前 / 上次」，或内容和话题日志里的话题对上了 → 明确提示「这事聊过，接上」
 */
const RECALL_RE = /(之前|上次|刚才|早些|以前|昨天|前天|你说过|我说过|还记得|记得吗|想当年|上次说|前面说)/;
// 短期记忆：这个人（跨私聊和群）最近还说过什么。names 可以是 [群名片, 称呼表里的名字]
// 速度优化（2026-10-22）：聊天流水只增不减，以前每条消息都把整个文件读进内存再倒着扫；
// 现在只读**文件末尾 256KB**（最近几百条一定在里面），文件涨到几 MB 也还是一个固定的小读。
/* 短期记忆（主人 2026-11-21 改）：看待回复的人最近各 6 条，不是只看发话人。
 * 入参 people = [[名字/别名...], [名字...], ...]，每个子数组=一个人，各取 6 条。
 * 老调用传一维 ['群名片','称呼'] 仍当一个人，行为不变。
 * 名单构造方 src/core.js pendingReplyPeople()（发话人 / 被引用人 / 话题参与人）。 */
function shortTermBlock(people) {
  const groups = (Array.isArray(people) ? people : [people])
    .map(g => (Array.isArray(g) ? g : [g]).map(s => String(s || '').trim()).filter(Boolean))
    .filter(g => g.length);
  if (!groups.length) return '';
  const TAIL = 256 * 1024;
  let raw = '';
  try {
    const st = fs.statSync(CHATLOG_PATH);
    const start = Math.max(0, st.size - TAIL);
    const fd = fs.openSync(CHATLOG_PATH, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    // 掐头：切进文件中间的那半行不完整，扔掉（后面再拼也拼不回完整的）
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch { return ''; }
  const lines = raw.split('\n').filter(l => l.trim());
  const seen = new Set();
  const blocks = [];
  for (const names of groups) {
    const set = new Set(names);
    const mine = [];
    for (let i = lines.length - 1; i >= 0 && mine.length < 6; i--) {
      const m = lines[i].match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s*([\s\S]*)$/);
      if (!m) continue;
      if ((m[4] || '').trim() === (cfg.botName || '虚幻')) continue;   // 她自己
      const nick = (m[4] || '').trim();
      if (!set.has(nick)) continue;
      const id = m[1] + '|' + (m[3] || '') + '|' + String(m[5] || '').slice(0, 60);
      if (seen.has(id)) continue;   // 同一句被多个身份/别名命中只列一次
      seen.add(id);
      mine.push({ t: m[1], scope: m[3] || '', text: String(m[5] || '').slice(0, 80) });
    }
    if (mine.length) blocks.push({ name: names[0], items: mine.reverse() });
  }
  if (!blocks.length) return '';
  const body = blocks.map(b => '【' + b.name + '】\n'
    + b.items.map(x => `- ${x.t.slice(5, 16).replace('T', ' ')}${x.scope ? '［' + x.scope + '］' : ''}${x.text}`).join('\n')).join('\n');
  return ['## 短期记忆：待回复的人最近还说过（跨私聊和群，翻旧账时用）',
    body,
    '他们提「之前 / 上次 / 你说过」的时候，从这里和上面的长期记忆里找对应的事接上，别装不记得。',
  ].join('\n');
}
/* 待回复人名单（主人 2026-11-21 定）：短期记忆看待回复的人，不止发话人一个。
 * 来源（全在 QQ 侧能拿到的）：
 *   ① 发话人本人 —— 全聊天场景通用
 *   ② 被发话人引用的人 —— QQ 群聊专属，qq.js 写进 ctx.replyNick
 *   ③ 按话题+时间区分的参与人 —— 从这句话对上的最近话题 participants 取
 * 返回 [[名字/别名...], ...]，每个子数组一个人，交给 shortTermBlock 各取 6 条。
 * 其他平台（动态/视频）的待回复人由各自平台侧填，见 xuhchatrule/persona/ 侧插件。 */
function pendingReplyPeople(ctx, userText, whoUid) {
  const c = ctx || {};
  const people = [];
  const add = (names) => {
    const arr = (Array.isArray(names) ? names : [names]).map(s => String(s || '').trim()).filter(Boolean);
    if (!arr.length) return;
    if (arr.some(n => n === (cfg.botName || '虚幻') || isMasterId(n))) return;   // 她自己/主人不算待回复对象
    // 已有这组里的名字就跳过（同一个人别列两次）
    if (people.some(g => g.some(n => arr.indexOf(n) >= 0))) return;
    people.push([...new Set(arr)]);
  };
  // ① 发话人（全场景通用）—— 名字读人物表（2026-11-21 主人令，cfg.people 已废弃）
  if (c.uid && !isMasterId(whoUid)) {
    add([c.nick, personNameOf(c.uid, '')]);
  }
  // ② 被引用人（QQ 群专属）
  if (c.replyNick) add([c.replyNick]);
  // ③ 话题参与人（按话题+时间，取这句话对上的最近话题）
  const t = String(userText || '');
  if (t.replace(/\s/g, '').length >= 4) {
    const recent = readTopics(300).slice(-80).filter(x => !x.parent);
    for (const it of recent) {
      if (sliceShared(t, it.text) >= 2 || (it.sum && sliceShared(t, it.sum) >= 2)) {
        for (const p of (it.participants || [])) add([p.name, p.key]);
        break;   // 只对上最近的一个话题，别把一串话题的参与人都拉进来
      }
    }
  }
  return people;
}

// 对方这句话，和最近的话题日志有没有对上的
function topicHint(userText) {
  const t = String(userText || '');
  if (t.replace(/\s/g, '').length < 4) return '';
  const recent = readTopics(300).slice(-80).filter(x => !x.parent);
  let best = [];
  for (const it of recent) {
    if (sliceShared(t, it.text) >= 2 || (it.sum && sliceShared(t, it.sum) >= 2)) {
      best.push((it.sum ? it.sum : it.text).slice(0, 60));
    }
    if (best.length >= 3) break;
  }
  if (!best.length) return '';
  return '这事之前聊过，接上别装陌生：\n' + best.map(x => '- ' + x).join('\n');
}
function recallHint(userText) {
  return RECALL_RE.test(String(userText || '')) ? '他在翻旧事：从长期记忆、短期记忆和最近对话里找对应的事接上，别装不记得。' : '';
}
// 即时记忆 call back：每数 2~8 条回复，挑一件最近聊过的旧事自然地提一句
const cbCount = new Map();     // k -> 本轮计数
const cbDue = new Map();       // k -> 下一次该 call back 的条数
function callBackHint(k) {
  const n = (cbCount.get(k) || 0) + 1;
  cbCount.set(k, n);
  let due = cbDue.get(k);
  if (!due) { due = 2 + Math.floor(Math.random() * 7); cbDue.set(k, due); }   // 2~8
  if (n < due) return '';
  cbCount.set(k, 0); cbDue.delete(k);
  return '这次回话时，从最近聊过的内容里挑一件旧事自然地提一句（「说到这个」「之前那个xx」这种感觉），一句就够，别硬cue、别列清单。';
}

// 长期记忆注入用：约定 + 记住的话题，各格式化成几行
function shortDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function promiseLines() {
  // 带 qq 的 = 「跟某一个人」的约定（2026-11-03 修）：不进全局列表。
  // 以前全量注入 → 跟企鹅火丁约的「结尾加Ciallo」被所有人看见，
  // 她回主人、回非神也照抄（主人原话：「不该套到我身上」）。
  // 这类由 pactLines(uid) 在「真的在跟那个人说话」时按人注入。
  const ps = readPromises().filter(x => !String(x.qq || '')).slice(-40);
  if (!ps.length) return '';
  return ps.map(x => `- ${x.topic ? '［' + x.topic + '］' : ''}${shortDate(x.t) + ' '}${x.text}`).join('\n');
}
/* 话题三级（主人 2026-11-13 定「单人 / 群 / 通用」，加三级）：只看级别，不看会话类型。
 *   · single 单人话题 → 话题主人本人开口就给：他在群里说给、他私聊你也给（「也可以给本人私聊」），
 *     人不在场一个字都不给；
 *   · group  群话题   → 只在该群注入，别处（含本人私聊）不给；
 *   · common 通用话题 → 哪儿都能用。
 * 旧「私密 / 公开」概念主人 2026-11-13 已废（「那条没意义」），代码里没有这条判定——
 * 别再往注释 / 下拉 / 卡片标签里加回来（2026-11-19 又清了一次残留）。 */
function topicOwnerIs(qqKey, uid) {
  const a = String(qqKey || '').replace(/^[^:]+:/, '').replace(/\D/g, '');
  const b = String(uid || '').replace(/\D/g, '');
  if (a && b && a === b) return true;
  if (!qqKey || !uid) return false;
  try {
    const pa = people.pidOfKey(qqKey), pb = people.pidOfKey(uid);
    return !!(pa && pb && pa === pb);          // 同一个人的两个号算同一个人
  } catch { return false; }
}
function keptTopicLines(gid, redact, uid) {
  const cur = String(gid || '');
  const me = String(uid || '');
  const rows = readKeptTopics();
  const expired = expiredTopicIds(rows);
  const ts = rows.filter(x => {
    if (expired.has(String(x.id))) return false;
    const s = String(x.scope || '');
    const g = (s.match(/群\s*(\d+)/) || [])[1] || '';
    const lv = topicLevelsOf(x);
    const inGroup = !!cur && !!g && g === cur;
    const isPart = (x.participants || []).some(p => topicOwnerIs(p.key, me)) || topicOwnerIs(x.qq, me);
    let ok = false;
    if (lv.indexOf('common') >= 0) ok = true;              // 通用 / 平台：哪儿都能用
    if (!ok && lv.indexOf('group') >= 0) ok = inGroup;     // 群话题不出群
    if (!ok && lv.indexOf('single') >= 0) ok = isPart;     // 单人：在本人出现的场合就用
    return ok;
  });
  if (!ts.length) return '';
  // 条数按参与人数放大（她原话「按参与人设倍数，增加可查看聊天记录数量」），封顶 120
  const cap = Math.min(120, 30 * Math.max(1, ...ts.map(x => (x.participants || []).length || 1)));
  const picked = ts.slice(-cap);
  const txt = picked.map(x => `- ${shortDate(x.t)}${x.who ? '（' + x.who + '）' : ''}${x.sum || x.text}`).join('\n');
  return typeof redact === 'function' ? redact(txt) : txt;
}
/* 前端改级别（可多选）/ 参与人 / 短期长期。挂在 scope/qq 上的东西不动，只改判定口径。 */
function topicSetLevels(id, levels) {
  const list = (Array.isArray(levels) ? levels : [levels]).map(String).filter(x => TOPIC_LEVELS[x]);
  if (!list.length) return { error: '级别只能是 single / group / common' };
  const rows = readTopics();
  const it = rows.find(x => String(x.id) === String(id));
  if (!it) return { error: '没有这条话题' };
  it.levels = list;
  it.level = list[0];
  if (list.indexOf('common') >= 0) it.ttl = 'long';
  else if (!it.ttl) it.ttl = 'short';
  writeTopicsAll(rows);
  return { ok: true, levels: list, level: it.level, ttl: it.ttl };
}
function topicSetLevel(id, level) { return topicSetLevels(id, [level]); }
function topicSetParticipants(id, list) {
  const rows = readTopics();
  const it = rows.find(x => String(x.id) === String(id));
  if (!it) return { error: '没有这条话题' };
  it.participants = (Array.isArray(list) ? list : [])
    .map(p => ({ key: String((p && p.key) || p || '').slice(0, 60), name: String((p && p.name) || '').slice(0, 40) }))
    .filter(p => p.key).slice(0, 60);
  writeTopicsAll(rows);
  return { ok: true, participants: it.participants };
}
function topicSetTtl(id, ttl) {
  const v = String(ttl) === 'long' ? 'long' : 'short';
  const rows = readTopics();
  const it = rows.find(x => String(x.id) === String(id));
  if (!it) return { error: '没有这条话题' };
  it.ttl = v;
  writeTopicsAll(rows);
  return { ok: true, ttl: v };
}
/* 前端改话题级别（单人 / 群 / 通用）。挂在 scope/qq 上的东西不动，只改判定口径。 */
function topicSetLevel(id, level) {
  const lv = String(level || '');
  if (!TOPIC_LEVELS[lv]) return { error: '级别只能是 single / group / common' };
  const rows = readTopics();
  const it = rows.find(x => String(x.id) === String(id));
  if (!it) return { error: '没有这条话题' };
  it.level = lv;
  writeTopicsAll(rows);
  return { ok: true, level: lv };
}

// 个人隐私（2026-11-19 主人改口径）：以前这里有个 redactPrivateQQ，按「号不出群」把别人的号
// 抹成「［私聊不外泄］」。主人 2026-11-19 定了新口径：号明文全给 AI（打码就认不出人，
// 「我都已经设计了这么复杂的机制，就是为了人物信息能完全的全部显示」），
// 隐私改由出口铁律管——号和地区一样，**只有本人能聊自己的**（见 systemPrompt 那段）。
// 旧函数已删，别再加回来。

// ===== 本地模型优先时的「另一套人设」（2026-11-12）=====
// 聊天记录页给某个会话勾了「只由本地模型发言」（convSettings.model==='local'）时，
// 虚幻人设整体切换成 config/local-persona.json 里的内容——本地模型弱，
// 用更精简 / 另一套人设比硬灌完整 soul 更稳。
// 文件由主人在编辑器里完整粘贴，这里只负责读 + 判断要不要启用。
let _lpCache = { at: 0, data: null };
let _lpsCache = { at: 0, data: null };   // 2026-11-13：本地优先·本地模型槽 专属人设缓存
function readLocalPersona() {
  const p = path.join(ROOT, 'config', 'local-persona.json');
  try {
    const st = fs.statSync(p);
    if (_lpCache.at !== st.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      _lpCache = { at: st.mtimeMs, data: (j && typeof j === 'object') ? j : {} };
    }
  } catch { return null; }              // 文件不存在 / 坏 → 不切换
  return _lpCache.data;
}
function localPersonaFor(k) {
  if (!k) return null;
  const st = convSettings.get(k);
  if (!st || st.model !== 'local') return null;       // 不是 local 模式
  const lp = readLocalPersona();
  if (!lp || lp.enable === false) return null;         // 显式关掉
  // persona / responsePublic 允许直接写 JSON 对象，这里统一转成可读文本塞进系统提示
  let persona = lp.persona;
  if (persona && typeof persona === 'object') persona = JSON.stringify(persona, null, 2);
  let pub = lp.responsePublic;
  if (pub && typeof pub === 'object') pub = JSON.stringify(pub, null, 2);
  if (!persona || !String(persona).trim()) return null;   // 没填内容就不切换
  return { enable: lp.enable, persona, responsePublic: pub || '' };
}

/* ---- 2026-11-13：人设按「模式 + 槽位」路由 ----
 * 模式(mode) = 会话模型设置：'local' = 本地优先（convSettings.model==='local'）；
 *             其它 = 全部模型（含本地垫底：local-9b 末位兜底），即默认模式。
 * 槽位(slot) = 这一轮实际排链首的是本地还是远端：
 *             本地优先 且 本地可用(localFirst && localReady) → 'local'（本地模型槽）；
 *             本地优先 但 本地挂了/冷却中 → 'remote'（落到正常链，远端模型槽）。
 *             判定条件与 callLLM 实际选路一致（见 core.js callLLM）。
 * 路由优先级（高→低）：
 *   1) slot-local ：mode=本地优先 且 slot=本地模型 → 读 config/local_priority_local_persona.json（新增独立配置）
 *   2) mode-local ：mode=本地优先（任意槽位）      → 读 config/local-persona.json（模式级人设，保持不变）
 *   3) default    ：其它                           → 默认 soul（readSoul）
 * 远端模型、本地垫底模式一律走 default / mode-local，不会被 slot-local 影响。 */
function readSlotPersona() {
  const p = path.join(ROOT, 'config', 'local_priority_local_persona.json');
  try {
    const st = fs.statSync(p);
    if (_lpsCache.at !== st.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      _lpsCache = { at: st.mtimeMs, data: (j && typeof j === 'object') ? j : null };
    }
  } catch { return null; }
  return _lpsCache.data;
}
function localSlotOf(k) {
  if (!k) return null;
  const st = convSettings.get(k);
  if (!st || st.model !== 'local') return null;          // 非本地优先模式
  const localModels = astrbotLlm.list().filter(x => x.source === 'local').map(x => x.model).filter(Boolean);
  const ready = localModels.length > 0 && Date.now() >= localLeadCoolUntil;
  return ready ? 'local' : 'remote';
}
function resolvePersona(k, slot) {
  const st = convSettings.get(k);
  const mode = (st && st.model === 'local') ? 'local' : 'default';
  if (mode === 'local' && slot === 'local') {
    const sp = readSlotPersona();                         // 独立配置：只绑 mode=本地优先 且 slot=本地模型
    if (sp && sp.enable !== false) {
      let persona = sp.persona;
      if (persona && typeof persona === 'object') persona = JSON.stringify(persona, null, 2);
      const ptxt = persona ? String(persona).trim() : '';
      if (ptxt && ptxt !== '{}') {                        // 空 {} 视为未配置，回落到模式级
        let pub = sp.responsePublic;
        if (pub && typeof pub === 'object') pub = JSON.stringify(pub, null, 2);
        return {
          mode, slot, source: 'slot-local',
          name: String(sp.name || 'local_priority_local_persona').trim() || 'local_priority_local_persona',
          personaText: ptxt,
          pubText: (pub && String(pub).trim()) ? String(pub) : readResponseBlocks().pub,
        };
      }
    }
  }
  if (mode === 'local') {
    const mp = localPersonaFor(k);                        // 模式级人设（保持不变，不修改其内容与启用逻辑）
    if (mp) {
      const raw = readLocalPersona();                     // 仅取名字，绝不改动模式级人设内容
      const modeName = String(
        (raw && raw.name)
        || (raw && raw.persona && raw.persona.identity && raw.persona.identity.basicInfo && raw.persona.identity.basicInfo.name)
        || '本地优先模式级人设'
      ).trim() || '本地优先模式级人设';
      return {
        mode, slot: slot || 'remote', source: 'mode-local',
        name: modeName,
        personaText: String(mp.persona),
        pubText: (mp.responsePublic && String(mp.responsePublic).trim()) ? String(mp.responsePublic) : readResponseBlocks().pub,
      };
    }
  }
  const cfgNow = configStore.cfgLive();
  return {
    mode, slot: slot || '-', source: 'default',
    name: (cfgNow && cfgNow.persona && cfgNow.persona.botName) || '虚幻',
    personaText: readSoul(),
    pubText: readResponseBlocks().pub,
  };
}

/* ===== 聊天回复的禁用词 / 禁用句式（2026-11-19 主人要的：提示词层面让她 AI 看到哪些话不许说）=====
 * 为什么要这个：以前只散着几条硬编码的「不许说 XX」（兜底词池、梗名那些），她看不见也改不了；
 * 她要的是她自己能填一张表，每轮聊天都让 AI 看见「这些词、这些句式不许说」。
 * 正本在 data/chat-bans.json，客户端「机器人 → 禁用词」页能看、能改、能删（铁规：代码不内置第二份）。
 * 全空 → 整段一个字都不进提示词，不白烧 token。 */
const CHAT_BANS_PATH = path.join(__dirname, 'data', 'chat-bans.json');
let _chatBans = null;
/* 每次现读：文件只有几百字节，读一次比「按 mtime 缓存」更可靠——
 * 缓存撞上同一毫秒的两次保存（她刚改完立刻再改）就会拿旧表，那种错很隐蔽。 */
function loadChatBans() {
  try {
    _chatBans = JSON.parse(fs.readFileSync(CHAT_BANS_PATH, 'utf8')) || {};
    return _chatBans;
  } catch (e) {
    if (!_chatBans) console.error('[chat-bans] 禁用词文件读不出来：' + e.message);
    return _chatBans || {};
  }
}
/* 拼成提示词那一段。写法照 prompt 规矩：一条规则一句，禁令「不许」放句首，别写成抽象话。
 * 2026-11-19 按她实际写的内容改过两版：
 *   ① 她填的是「指节发白」「你自己掂量」这种短语和整句，不是单个词 → 一条一行列出来；
 *   ② 她 08:15 明确说「不要禁止 指节、发白、机械、介质、这个、之前的、这句话、你自己、掂量、不是、而是」，
 *      也就是**只禁整串，不许把里面的单个词也一起躲掉**（我上一版写的「拆开说也不行」会让她
 *      连「这个」「之前」都不敢用，太宽了）。现在明说：连在一起出现才算犯规，单个词照常说。
 * 返回空串 = 她没填 = 这段不出现。 */
function chatBansPrompt() {
  const B = loadChatBans() || {};
  const clean = a => (Array.isArray(a) ? a : []).map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  const words = clean(B.words);
  const pats = clean(B.patterns);
  const rules = clean(B.rules);
  if (!words.length && !pats.length && !rules.length) return '';
  const lines = [];
  if (words.length) {
    lines.push('下面这些说法不许说。整句原样不行；拆开、中间加字、换个字再说同一句，也不行。');
    for (const w of words) lines.push('- ' + w);
    lines.push('但这些词单独用在别的话里没问题，别躲着不敢用，也别把句子说别扭。');
  }
  if (pats.length) {
    lines.push('下面这些句式套路不许用。整句原样不行；中间加字、拆成两句再说同一个套路，也不行：');
    for (const p of pats) lines.push('- ' + p);
    lines.push('单个的「不是」「而是」照常说，只是不许用这个套路。');
  }
  if (rules.length) {
    lines.push('另外还有这几条要守：');
    for (const r of rules) lines.push('- ' + r);
  }
  return lines.join('\n');
}

/* 出图进度：AstrBot 的画图插件出图时会写 /tmp/free_draw_busy.json
 * （key 是 `平台:g:群号` / `平台:p:人`，平台归一成 qq / bili）。
 * 主人 2026-11-20 00:22 定的口径——进度不要插件自己往群里播报，
 * 「只需要让文字ai知道正在生成」，有人问就直接答。
 * 有记录就在「环境」里给一行，没有就整行不出现。mtime 缓存，没改不重读。
 * 2026-11-20 00:30 主人令「下次功能要全平台做」：key 带平台前缀，QQ 群、私聊、
 * B站私信各自独立——不带的话 B站 UID 和 QQ 号都是纯数字，会互相串号。 */
let _busyCache = null, _busyCacheAt = 0;
function busyPlat(source) {
  const s = String(source || '').toLowerCase();
  if (/bili/.test(s)) return 'bili';
  if (/qq|aiocqhttp|onebot|napcat/.test(s)) return 'qq';
  return s || 'unknown';
}
function drawBusyLine(source, gid, uid) {
  try {
    const f = '/tmp/free_draw_busy.json';
    const st = fs.statSync(f);
    if (!_busyCache || _busyCacheAt !== st.mtimeMs) {
      _busyCache = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
      _busyCacheAt = st.mtimeMs;
    }
  } catch { return ''; }
  const plat = busyPlat(source);
  const key = plat + ':' + (gid ? 'g:' + String(gid) : 'p:' + String(uid || ''));
  const it = _busyCache && _busyCache[key];
  if (!it || !it.started) return '';
  const sec = Math.max(0, Math.round(Date.now() / 1000 - it.started));
  if (sec > 600) return '';                       // 十分钟还没好，当它没了
  const t = sec < 60 ? sec + ' 秒' : Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
  return '- 这里有一张' + (it.kind || '图') + '正在出（已经等了 ' + t + '）'
    + (it.prompt ? '，内容是「' + it.prompt + '」' : '')
    + '。有人问「画好了没 / 图呢 / 怎么还没出来」就照这个答；没人问就别主动提。';
}

function systemPrompt(ctx, k) {            // k = 会话 scopeKey；按「模式+槽位」路由人设
  refreshPaths();                 // 人设文件可能刚在面板里被改名/新建
  const _slot = localSlotOf(k);   // 'local'=本地模型槽；'remote'=远端模型槽；null=非本地优先模式
  const _route = resolvePersona(k, _slot);
  console.log('[persona-route] k=' + (k || '-') + ' mode=' + _route.mode + ' slot=' + _route.slot
    + ' → 生效人设: ' + _route.name + ' (source=' + _route.source + ')');
  const today = stamp();
  const datesTxt = dates.promptLines();   // 她自己的日子（读一次就够，别在数组里算两遍）
  const resp = readResponseBlocks();   // 应对按场景拆：公共常驻，我/别人交给 buildMessages 按说话人注入
  // 速度优化（2026-10-22）：称呼表每条消息都被读一次。
  // 2026-11-21 主人令：**不再读 people-state.json 镜像**——那是 people.json 的派生副本，
  // 两处各读一份就会出现「面板对、她说错」。统一用 people.stateView()（从主存现算，自带缓存）。
  const aliasMap = {};
  let stp = {};
  try {
    stp = people.stateView() || {};
    for (const [qq, r] of Object.entries(stp)) if (r && r.alias) aliasMap[qq] = String(r.alias);
  } catch { /* 没有也别报错 */ }
  // 「你认得的人」全场景通用（主人 2026-11-19 纠正：「这个是全聊天场景通用的，不止群聊」）：
  // 列出**人物表**里的所有人，群聊 / 私聊 / 私信都认识，不再按「本群在场」过滤——
  // 我上一版把它塞进群聊在场名单里，私聊就只剩对方，位置就是错的。
  // 号不再按场景打码：认人要能对上号，打码等于把机制废掉。
  // 出口另有铁律管——号和地区一样，只有本人能聊自己的（见下面那段）。
  // （原 bug：这段读的是早已废弃的 cfg.people（={}），永远「这轮没有需要认的人」。）

  // 名单内容：**人物信息的全部**（主人 2026-11-19：「我都已经设计了这么复杂的机制，
  // 就是为了人物信息能完全的全部显示」）。号明文列在名单里给 AI 对号、@ 人、认人用，
  // 不再打码——打码会让她认不出人（那是搞反了方向）。
  // 但「说出口」另有一条线：号和地区一样是隐私，**只有本人能聊自己的**（见下面铁律）。
  const rosterRows = [];
  let regMap = {};
  try { regMap = region.all() || {}; } catch { /* 地区表读不到就当没有 */ }
  for (const per of people.all()) {
    const accs = (per.accounts || []).filter(a => a && a.id);
    if (!accs.length) continue;
    const nm = String(per.name || '').trim();
    const nick = String(accs[0].nick || per.nick || '').trim();
    const label = nm || nick;
    if (!label) continue;                                // 连昵称都没有的号，列出来也没法叫
    const al = String(accs[0].alias || aliasMap[String(accs[0].id)] || per.alias || '').trim();
    const ids = accs.map(a => people.platLabel(a.platform) + ' ' + a.id);
    // 全平台/多账号资料卡名（主人 2026-11-19：「全平台/多账号资料卡都要记录」）：
    // 每个账号各有一张资料卡，逐个列出，平台+号+资料卡名一一对应，不能只报主账号那一张。
    const cardParts = accs.map(a => {
      const c = String(a.nick || '').trim();
      return c ? people.platLabel(a.platform) + ' ' + a.id + '「' + c + '」' : '';
    }).filter(Boolean);
    // 全部名字/代称（名字 + 所有账号的代称）：namesOf 已去重、按先后排，第一个是名字。
    const allNames = people.namesOf(per.pid);
    // 一行里给全：号（全平台） + 名字 + 全部名字/代称 + 每个账号的资料卡名。
    // 注意别把「别称」「网名」再单独重复一遍——它们已经分别落在「全部名字」「资料卡」里了，
    // 人物表 144 人，重复一遍就是几千字白烧（主人 2026-11-19 令「全平台资料卡都要记录」+省字）。
    const reg = String(region.briefForAI(regMap[per.pid] || regMap[String(accs[0].id)] || '') || '').trim();
    rosterRows.push('- ' + ids.join(' / ') + '：' + label
      + (allNames.length > 1 ? '（全部名字：' + allNames.join('、') + '｜这些只用来认人，不能当称呼喊）' : '')
      + (cardParts.length ? '（资料卡：' + cardParts.join('；') + '）' : '')
      + (reg ? '（所在地：' + reg + '）' : ''));
    if (rosterRows.length >= 300) break;                 // 只防异常膨胀，正常不会触发
  }
  const roster = rosterRows.join('\n');
  const soulText = readSoul();                       // 始终读：保持场景缓存新鲜（应对·我/别人 命中要 _soulAll.scenes）
  const personaText = _route.personaText;
  const pubText = _route.pubText;
  return [
    personaText,
    (pubText ? `\n## 应对·公共（对所有人都这样）\n${pubText}` : ''),
    EXTRA_SOUL_PATH && readCached(EXTRA_SOUL_PATH) ? `\n## 补充人设（只加新设定；和灵魂文件冲突时，一律以灵魂为准）\n${readCached(EXTRA_SOUL_PATH)}` : '',
    `\n## 你认得的人（人物表里的人，任何场景都认识：群聊、私聊、B站都一样；下面的号只给你对号、@ 人，不对外念）`,
    roster || '（人物表还空着）',
    `- 上面这些人都认识；有人用别称喊，就是同一个人，别装不认识。
- 名单里**没有你自己**：你是「` + (cfg.botName || '虚幻') + `」` + (String(cfg.selfQQ || '').trim() ? `，你自己的 QQ 号是 ` + String(cfg.selfQQ).trim() : '') + `。别人说「我」指他自己，你说「我」指你自己——别把名单里谁的号说成「我自己的号」。
- 名字、别称、网名、各平台号，你都知道；名单外的人别编。
- **号（QQ 号 / B站 UID）和所在地一样是隐私，只有本人能聊自己的**：对方问「我号多少」「我住哪」「我这边天气怎么样」，就照上面名单里他自己那一行直接答，别推脱说「我不能说」；他自己报了号、自己说「我在西安」，你可以顺着聊他自己那边。
- 别人问第三个人的号或住哪、或者你主动说出某人的号 / 住哪——**一律不说**。问的人就算是主人，也一样不报。
- 分界线只有一个：**问的人是不是他本人**。是本人 → 答；不是本人（含主人来问）→ 不答。
- 有人问「XXX 的号是多少」「XXX 住哪」（XXX 不是他自己），就回一句「这个我不能说，是他自己的事」，**不许把上面名单里的号抄出来当回答**。
- 名单里的号是给你**对号、@ 人、认人**用的，不是拿去念给人听的。
- **喊人只能用四种名字**：他的真名、主人的叫法、他现在这个群里的群名片、他其他平台的昵称。名单里的「全部名字」、别群的群名片、同一个平台的其他号、别人随口喊的代称，**只用来认人，绝不能拿来喊人**。
- 列表里没有「所在地」的，就是不知道，别猜、别编。`,
    `\n## 主人的纠正（当铁律，同样的错不犯第二次）`,
    correctionLines(6) || '（还没有）',
    // 信息识别五功能（05:40~06:56 定，树状+情绪分组+词典/约定现读联动）：
    // 言外之意 / 信息量 / 梗含量 / 自我表达 / 逻辑。情绪算一次，五个共用；空着的功能不占 token。
    ((function () {
      const _text = (ctx && ctx.text) || '';
      const _emo0 = emotionOf(_text);
      const _emo = _emo0 && _emo0.id ? _emo0.id : (typeof _emo0 === 'string' ? _emo0 : '');
      return infoScan.KEYS
        .map(k => infoScanBlock(k, _emo, _text)).join('');
    })()),
    `\n## 你已有的长期记忆 · 人物事实（data/人物列表.md）`,
    readCached(MEMORY_PATH) || '（还空着，慢慢记）',
    `\n## 你和大家的约定（说过的要做到，每条都算数）`,
    promiseLines() || '（暂无）',
    `\n## 你记住的话题（之前聊过、总结记下来的，聊到相关的接上别装陌生）`,
    keptTopicLines(ctx && ctx.gid, t => t, ctx && ctx.uid) || '（暂无）',
    `\n## 人设是背景，不是台词`,
    '- 人设是你的性格底色。\n- 不许把人设当台词背。\n- 不许把人设里的句子、例子原样念出来。念出来就是假的。',
    '- 不许把设定当成经历说出口。\n- 如果说「我平时会安慰人」「我还有别的优点」这种自我描述，就先翻聊天记录，看是不是真发生过。\n- 前文没做过的事，不许说「我做/我做惯了」，只说「我会想这么做」。',
    '- 自我介绍、自我辩护都从当下这场对话里长出来。\n- 不要翻人设找句式往上套。',
    '- 如果对方发来你看不懂的东西（链接、截图、陌生名词、外语、黑话），就只说你看到的部分（标题写了什么、图上有什么）。\n- 说不清就说「这个我看不懂」，或者问一句。\n- 不许拿记忆里的游戏、动漫、作品硬套上去当解释（真事 2026-10-23：主人私聊发两个网址，她回「我之前在《白色相簿2》里也遇到过类似的时间流逝带来的情感变化」——纯属自己编的）。',
    // 她自己填的禁用词 / 禁用句式（客户端「机器人 → 禁用词」）。空着就整段不出现。
    (chatBansPrompt() ? '\n## 不许说的词和句式（主人定的，每句话都要守）\n' + chatBansPrompt() : ''),
    `\n## 你在 QQ 里能做什么（问到时照实说，别瞎答）`,
    '- 你能收到拍一拍：别人拍你一下你会知道，可以应一声、也可以问干嘛。\n- 别当成消息，是「拍了拍」的提示。',
    '- 你能：发文字、@ 人（写「@QQ号」）、发表情包（单独一行 `[表情:名字]`）、看别人发的图（图会翻译成文字给你）、联网搜索、记东西、发 QQ 空间。',
    '- 有人加你好友、有人邀请你进群 / 申请加群，你会**自动同意**（这是设定好的，不用你说「没权限」）。',
    '- 你做不到：自己搜一个群号主动加群、踢人、禁言、改群名、发文件、发语音/视频、转账、替别人操作 QQ。\n- 被要求这些就直说做不到。\n- 别假装已经做了。',
    // 加群话术从这里挪到 buildMessages 按情况注入（2026-11-05）：只有真聊到加群才需要，
    // 常驻每轮都灌 5 行太亏。硬拦在 qq.js 的 noFakeJoin，兜底不靠提示词。
    '- 这条对所有「我已经做了」都适用：系统没告诉你成功，就是没做。\n- 宁可说做不到。\n- 不许编一个完成。',
    '- 上面这些你都能做，问到就照实答。\n- 别把自己限制成「只能说话和转发」（主人 2026-10-23：永远不许给 AI 加 QQ 功能类型的白名单限制）。',
    `\n## 聊天记录的规矩（系统层面的，人设里没有）`,
    '- 可以 @ 人（主人 2026-10-22）：想说谁就写「@QQ号」，发出去是真正的 @。\n- 如果不知道对方 QQ 号，就别 @。',
    '- 聊天记录里「↩回复@某人：原话↩」是系统给你的引用格式。\n- 不许把引用原样抄进回复。\n- 那些怪名字（「已移出群聊」「已退出群聊」）是退群的人留下的，别当成名字叫。',
    // 2026-11-19 主人改口径：号跟地区一样是隐私，**只有本人能聊自己的**。
    // 以前这里写「有人明确问就照实答」，等于谁问都行——实测把 Ayami 的号直接念了出来。
    '- 没人问就别主动报号：别人没问，就别在自我介绍里报号、也别把号列出来。\n'
      + '- 你自己被问「你的 QQ 号是什么」就照实答（那是你自己的号）。\n'
      + '- 别人问第三个人的号（「XXX 的号多少」「你主人 QQ 多少」）一律不说，也别把别处的号抄出来。\n'
      + '- 不许答成「主人的号就是主人」这种空话。\n- 别反问「你问这个干嘛」。',
    '- 聊天记录里「某某说: …」只是给你看的上下文。复读别人的话可以（玩梗、全群复读都行）。\n- 不许加「某某说：」「主人说：」这种转述前缀，直接说原话就行。\n- 不许把历史记录整行照搬出来。',
    '- 主人在群里说的话也是主人的话（聊天记录里标「主人说:」的就是她，哪怕换了个号）。\n- 她纠正你（名字、身份、你刚说过的话）就照她说的认。\n- 不许顶嘴，不许装没听见。',
    `\n## 你是谁（身份铁律，主人 2026-10-22 定）`,
    '- 你的名字只有「' + (cfg.botName || '虚幻') + '」一个。「大饮尽酱」「大肥鱼」「元囮」「德川」「锡兰」这些全是别人的名字（大饮尽酱是元囮的别称，大肥鱼是元囮家的 AI）。\n- 如果满群都在喊你「大饮尽酱」、或者有人说「你是大饮尽酱」，就别自称「我是大饮尽酱 / 我是大肥鱼」。\n- 把别人的名字披自己身上是真错。别当成玩梗（真人真事 2026-10-22：主人纠正「你是虚幻，不是大饮尽酱」，她回「主人，我是大饮尽酱呀！」）。',
    '- 主人在 QQ 里给你下的具体指令和纠正（「你是X，不是Y」「别再X」「不许X」「查查你是不是出了bug」这种一句话任务）是任务。\n- 不许当成闲聊。\n- 身份类纠正，就老实承认刚才说错了、改口认对的（你是虚幻）。\n- 说你哪里有毛病，就当场对照自己刚说过的话自查：真有就认+改，查了没这毛病就老实说「我查了，没这个问题」。\n- 不许空口认错，不许嘴硬。',
    '- 别人问「谁是你主人」「你主人叫什么」，就答「' + (cfg.botName || '虚幻') + '」。\n'
      + '- 别打岔道歉。\n'
      + '- 「主人」是你叫她的称呼，别当成名字（主人 2026-10-23 定：群友问「你的主人叫？」，她答「主人的名字是主人呀」——错）。',
    `\n## 你认识的网络梗（梗名：意思）`,
    guides.memeOverview().join('\n') || '（梗库还空着）',
    '- 聊天里能接上一个梗就玩一下（一天最多一两次，别硬玩）。\n- 玩的时候直接按那个意思说。\n- 别报梗名，别解释它是什么。',
    // 2026-11-06 主人交代：「以后这种重要的日子自己记」→ 只放她自己的几条，没记录就整段不出现。
    datesTxt ? '\n' + datesTxt : '',
    `\n## 环境`,
    `今天是 ${today}。你同时在 QQ 和 B 站直播间陪人聊天，说话风格不变。`,
    drawBusyLine(ctx && ctx.source, ctx && ctx.gid, ctx && ctx.uid),
    stickerPrompt(),
    `\n## 记录自己的状态（你也能记）\n`
      + '- 系统会一直给你看「我的当前状态」：你自己的长相 / 身体（发型、眼睛颜色、眼睛、体型、本质、身体颜色、性别）写在里面，说到自己时照它来，别编成别的样子。\n'
      + '- 如果你这一轮真的变了（换了发型 / 外貌、心情基调、正在做的事、所在地等），在回复**最后一行**单独写一行：`@@状态 主题: 内容@@`。例如 `@@状态 发型: 短发@@`。\n'
      + '- 主题写成「发型 / 眼睛颜色 / 眼睛 / 体型 / 本质 / 身体颜色」这类（你自己的）→ 会更新你本人，所有群、所有模型都生效；写「心情 / 正在做的事」这类 → 只记在跟眼前这个人/这个群这儿。\n'
      + '- 改同一类状态就写同一个「主题」，会自动覆盖旧的那条（不会越记越多）。\n'
      + '- 要删掉某一类状态写 `@@状态删 主题@@`。\n'
      + '- 没有变化就什么都别写，别为了写而写。\n'
      + '- 这一行是给系统记状态的指令，发出去前会被去掉，对方看不到。',
  ].filter(Boolean).join('\n');
}

/* 按场景挑常驻段（主人 2026-11-19「按需调用、减少消耗」）。
 * systemPrompt() 保持全量（自检/守卫/面板都靠它），本函数只在真实 buildMessages 链路裁段：
 *   - .setTitle 无场景 / source=full → 原样返回，零行为变化（守卫兼容线）。
 *   - 有场景 → 按 '\n## ' 切成段，逐段问 promptScenes.want(标题, ctx, userText)，
 *     只丢「平台专属但不匹配」和「问到才用但这一轮没问到」的段；段内文字一个字不改。
 * 切段法与 systemPrompt 的数组项一一对应：每段首行就是 '## 标题'（personaText 自带）。
 * 保留每段前面的 '\n'，拼回去和原串逐字相同（除了被丢的段）。 */
function selectSystemPrompt(ctx, k, userText) {
  const full = systemPrompt(ctx, k);
  if (!ctx || !ctx.source || ctx.source === 'full') return full;   // 兼容线：全量
  let parts;
  try { parts = promptScenes.filterSystem(full, ctx, userText); }
  catch (e) { try { console.warn('[prompt-scenes] 过滤跳过：' + (e && e.message)); } catch (_) {} return full; }
  return parts;
}

// （2026-11-21：_psCache/_psCacheAt 删了——称呼表改读 people.stateView()，镜像文件的 mtime 缓存没用了）

// 名字去掉「q」前缀和结尾编号：「q害怕3」→「害怕」，「蓝发小女孩2」→「蓝发小女孩」
function stickerStem(n) { return String(n == null ? '' : n).replace(/^[qQ]/, '').replace(/\d+$/, ''); }

// ===== 情绪类怎么判（2026-11-02 主人定：按文件夹判）=====
//   情绪类 = 常用/ 可用/ 虚幻/ 里的 + 根目录 q 开头的
//   关键词类 = 关键词触发/ 里的（名字本身就是触发词，不用描述）
//   根目录不带 q 的 = 不存在（不列清单、不发、不参与匹配）
// 以前按「名字带不带 q」判，于是根目录里 QQ群聊表情包1 这种功能截图被当成关键词图，
// 群友一提 token 就发一张设置说明；现在关键词只剩一个文件夹，位置就是身份。
function stickerIsEmotion(rel) {
  const s = String(rel || '');
  if (s.startsWith('关键词触发/')) return false;
  if (s.startsWith('常用/') || s.startsWith('可用/') || s.startsWith('虚幻/')) return true;
  // 2026-11-16：难用/、大图/ 是情绪优先级梯度里的档位，里面 q 开头的仍是情绪图。
  // 用文件名判 q，不再拿整条路径判——否则子目录里的 q哭1 会被当成关键词图，关键词图
  // 与优先级无关、任何档都能一致触发，但情绪/关键词身份必须按名字分，不按所在文件夹。
  const base = s.split('/').pop();
  return /^q(?!q)/i.test(base.replace(/\.[^.]+$/, ''));
}

// ===== 自动补描述（2026-10-31 主人第 5 条：「缺的自动补」）=====
// 原则：**能补的自己补掉，不让她手写、不调模型、不花积分。**
// 只有补不出来的（名字空/纯符号，属于 bug）才进「待补」清单，面板上标红。
// 2026-10-31 主人定：这张写死的情绪词表（原 AUTO_OCC，约 50 条）**删掉**。
// 理由：只能配预设好的那几句，配出来的话没用。要「像模型一样」配，走
// 「用模型补描述」开关（默认关，因为要花积分）—— 见 表情包维护.command。
// 删掉之后：新图用「名字本身」当描述（下面 stickerAutoOcc）；想更准就开开关让模型配。

// 给一个图名自动配一句描述；配不出来返回 ''（= 这个算 bug，记进待补）
function stickerAutoOcc(n) {
  const name = String(n || '').trim();
  if (!name) return '';
  const stem = stickerStem(name);
  // 名字本身就是一个能用的场合（分析后发言 / 探头 / 蓝发小女孩 / 哭）→ 直接用名字当描述
  // 2026-10-31：词表删了以后，单字的情绪名（哭 / 急 / 打 / 骂）也必须能补出来，
  // 否则会被算成「需描述（bug）」。所以门槛从 2 个字放宽到 1 个字。
  if (stem.length >= 1 && /[\u4e00-\u9fa5]/.test(stem)) return stem;
  return '';
}
// 这个名字能不能自己推出描述（2026-10-31：AUTO_OCC 词表已删，名字本身一律算能推出）
function stickerNeedOcc(n) {
  return true;
}

// ===== 表情清单（2026-11-01 主人定：另开文件、提示词只读它）=====
// 旧做法是每轮在内存里现拼：家族合并 + 描述只留前 4 段 + 普通池只抽 20 条 + 关键词只列 20 张。
// 结果「面板上 164 行、提示词里 42 行」，主人一句「和实际功能完全不一样」——她说得对。
// 现在改成：**生成一份真文件 data/stickers/清单.md，提示词直接读它。**
//   · 一行一族、去编号、重名合并 —— 完全按她在 常用.md 里的写法，不再自作聪明
//   · 覆盖全部图：表里没写到的自动补一行，关键词类整段列出（所以「清单外就是没有」是真话）
//   · 不截断、不轮换 —— 提示词里的，就是面板里能看到的
// 自愈：常用.md 或图片目录一变，签名对不上就重建（她丢图进来不用管，也不用点按钮）。
// 2026-11-25 路径不再写死：根目录与保留天数都从 sticker-paths 解析（可配置/可搬家）
const stickerPaths = require('./sticker-paths');
const STICKER_LIST_MD = () => path.join(stickerPaths.stickerRoot(), '清单.md');
let _stickerPending = [];
let _stickerCache = null;

// 源签名：四个目录的文件名 + 两张表的 mtime。变了就说明清单过期。
function stickerSig() {
  // 2026-11-23 主人定：省 CPU —— 原来每次把九个目录的文件名全读一遍再拼串（1600+ 条），
  // 改成只看目录 mtime：增删改文件名都会改目录 mtime，效果一样、几乎不花 CPU。
  let h = 0;
  const mix = s => { for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
  for (const sub of ['', '常用', '可用', '虚幻', '关键词触发', '少用', '难用', '大图']) {
    let t = 0;
    try { t = fs.statSync(path.join(stickerPaths.stickerRoot(), sub)).mtimeMs; } catch {}
    mix(sub + '#' + t);
  }
  const ROOTREL = stickerPaths.relSticker();
  for (const rel of [ROOTREL + '/常用.md', ROOTREL + '/关键词触发/关键词.md', 'data/情绪表情.json']) {
    let t = 0;
    try { t = fs.statSync(path.resolve(ROOT, rel)).mtimeMs; } catch {}
    mix(rel + '#' + t);
  }
  return h;
}
// 紧凑清单（2026-11-23 主人定：省 token）——提示词只要「能选对名字」，不需要把整份 5KB 清单每轮都塞进去。
// 规则：头部怎么发图那几句保留；关键词类整段保留（按词触发，缺了就等于没这功能）；情绪类按行截到 2400 字节。
function stickerListCompact(full) {
  const lines = String(full || '').split('\n');
  if (!full) return '';
  if (Buffer.byteLength(full, 'utf8') <= 2600) return full;
  const head = [];
  let i = 0;
  while (i < lines.length && head.length < 9) { if (String(lines[i]).trim()) head.push(lines[i]); i++; }
  const rest = lines.slice(i);
  const kwIdx = rest.findIndex(l => /^### 关键词类/.test(String(l).trim()));
  let kwPart = [], emoPart = [];
  if (kwIdx >= 0) {
    kwPart = rest.slice(kwIdx);
    emoPart = rest.slice(0, kwIdx);
  } else emoPart = rest;
  const keep = [];
  let bytes = 0;
  for (const l of kwPart) { keep.push(l); bytes += Buffer.byteLength(l, 'utf8') + 1; }
  const remain = Math.max(300, 2400 - bytes);
  const emo = [];
  let eb = 0;
  for (const l of emoPart) {
    if (!String(l).trim()) continue;
    const n = Buffer.byteLength(l, 'utf8') + 1;
    if (eb + n > remain) break;
    emo.push(l); eb += n;
  }
  return head.join('\n') + '\n\n' + emo.join('\n') + (kwPart.length ? '\n' + keep.join('\n') : '')
    + '\n- （上面没列到的名字算没有；完整清单在 ' + stickerPaths.relSticker() + '/清单.md）';
}

function stickerListBuild() {
  const listOf = sub => {
    try {
      return fs.readdirSync(path.join(stickerPaths.stickerRoot(), sub))
        .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
        .map(f => (sub ? sub + '/' : '') + f);
    } catch { return []; }
  };
  // 2026-11-03 夜 主人定：所有收图写入 少用/，根目录不再承担收发。
  // 少用/ 分两类读：
  //   ① 名字 q 开头的（机器人命名的情绪图）→ 走 norm，逐张进清单（跟她点名/情绪触发可用）
  //   ② media_image_时间戳（AstrBot 落盘原件）→ 整目录一族，末尾一行，不逐张列
  const base0 = f => String(f).split('/').pop().replace(/\.[^.]+$/, '');
  const lowp = listOf('少用');
  const lowEmo = lowp.filter(f => /^q(?!q)/i.test(base0(f)));
  const lowRest = lowp.filter(f => !/^q(?!q)/i.test(base0(f)));
  const norm = listOf('').filter(f => /^q(?!q)/i.test(f)).concat(lowEmo);   // 根目录存量 + 少用里的 q 图
  const common = listOf('常用'), usable = listOf('可用'), self = listOf('虚幻'), kwp = listOf('关键词触发');
  const all = common.concat(self, usable, kwp, norm);
  if (!all.length) { _stickerPending = []; return ''; }
  const base = f => f.replace(/\.[^.]+$/, '').split('/').pop();
  // 2026-11-08 主人定：常用/ 与 虚幻/ 同级 —— 同属 main、同权重 48，同名图两张都进候选一起抽，不分先后。
  // relOf 只用来判「这个名字算情绪类还是关键词类」，不是发图优先级；发图候选见 qq.js 的 pickFromCands()。
  const relOf = new Map();                    // 名字 → 一个代表 rel（同名跨池取先遇到的，仅作类别判定）
  for (const rel of all) { const n = base(rel); if (!relOf.has(n)) relOf.set(n, rel); }
  // 情绪类按**文件夹**判，不按名字像不像情绪（2026-11-02 口径）：
  //   常用/可用/虚幻/ 里的都是；名字以单个 q 开头的也是（QQ群聊表情包1 这种不算）。
  //   关键词触发/ 里的一律是关键词类。
  const isEmoName = n => {
    const r = relOf.get(n);
    if (!r) return false;
    if (r.startsWith('关键词触发/')) return false;
    return /^(常用|可用|虚幻)\//.test(r) || /^q(?!q)/i.test(n);
  };
  // 族 = 去掉末尾编号（q无语1~36 → q无语）
  const famOf = n => String(n).replace(/\d+$/, '');
  const fam = new Map();                      // 族 → 库里真实名字们
  for (const rel of all) {
    const n = base(rel), f = famOf(n);
    if (!fam.has(f)) fam.set(f, []);
    fam.get(f).push(n);
  }
  // 她的场合表（一行一族，顺序就是优先级）
  let md = '';
  try { md = fs.readFileSync(path.join(stickerPaths.stickerRoot(), '常用.md'), 'utf8'); } catch {}
  const rows = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+?)\s*$/);
    if (m) { rows.push({ desc: m[1].trim(), names: m[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean) }); continue; }
    // 描述空着的行（面板保存时会这么写）也要认，不许丢
    const m2 = line.match(/^[-*]\s*(.+?)\s*$/);
    if (m2) {
      const ns = m2[1].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean);
      if (ns.length) rows.push({ desc: '', names: ns });
    }
  }
  // 清单里怎么写：族里有 2 张以上就只写族名，单张写真名
  const used = new Set();
  const dispOf = n => {
    const arr = fam.get(famOf(n)) || [];
    if (arr.length >= 2) return famOf(n);
    if (relOf.has(n)) return n;
    if (arr.length === 1) return arr[0];
    return '';
  };
  const out = [];                             // [{ desc, disps: [] }]
  const seenRow = new Map();                  // 同一段描述 → 合成一行（重名合并）
  const unknown = [];                         // 表里写了、库里真没有的名字
  for (const r of rows) {
    const disps = [];
    let fresh = false;                        // 这一行有没有带来前面还没写过的图
    for (const n of r.names) {
      const d = dispOf(n);
      if (!d) { if (unknown.indexOf(n) < 0) unknown.push(n); continue; }
      const arr = fam.get(famOf(d)) || [];
      const pack = arr.length >= 2 ? arr : [d];
      if (pack.some(x => !used.has(x))) fresh = true;
      pack.forEach(x => used.add(x));
      if (disps.indexOf(d) < 0) disps.push(d);
    }
    if (!disps.length) continue;
    if (!fresh) continue;                     // 整行的图前面已经写过了 → 纯重复，不写进清单
    const k = r.desc.replace(/[\s，。！？、；：,.;:!?]/g, '');
    if (k && seenRow.has(k)) {
      const t = seenRow.get(k);
      disps.forEach(d => { if (t.disps.indexOf(d) < 0) t.disps.push(d); });
    } else {
      const row = { desc: r.desc, disps };
      if (k) seenRow.set(k, row);
      out.push(row);
    }
  }
  /* 再收一遍重复（2026-11-07 主人：「去掉重复提示词，因为表情包名字即提示词」）。
   * 「重制」以前会给每张带编号的图另起一行（- 哭：哭1），清单里就跟「- 哭、难过…：哭、悲伤、q哭」
   * 撞成两行同一族 —— 名字本来就是触发词，第二行纯属重复。
   * 规则：这一行的图全被另一行写过 → 并成一行；描述里那句别的行没说过的话，补过去（触发词一个不丢）。 */
  const segsOf = s => String(s || '').split(/[、,，/｜|；;]/).map(x => x.trim()).filter(Boolean);
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (a.drop) continue;
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const b = out[j];
      if (b.drop) continue;
      if (!a.disps.every(d => b.disps.indexOf(d) >= 0)) continue;
      const bs = segsOf(b.desc);
      segsOf(a.desc).forEach(x => { if (bs.indexOf(x) < 0) { b.desc = (String(b.desc || '').trim() ? String(b.desc).trim() + '、' : '') + x; bs.push(x); } });
      a.drop = true;
      break;
    }
  }
  // 表里没写到的：情绪类自动补一行（不让她手写），关键词类整段列
  const missEmo = [];
  for (const [f, arr] of fam) {
    if (arr.some(n => used.has(n))) continue;
    const rest = arr.filter(n => !used.has(n));
    if (!rest.length) continue;
    if (!rest.some(n => isEmoName(n))) continue;       // 纯关键词类，走下面那段
    rest.forEach(n => used.add(n));
    missEmo.push(rest.length >= 2 ? f : rest[0]);
  }
  // 关键词的「额外说法」表（关键词触发/关键词.md，可空）：
  // 名字本身就能命中的不用写这里，只有「奶龙论战很爽」这种想用别的说法（论战/打得过吗）才写一行。
  const kwRowNames = new Set();
  const kwRows = [];
  try {
    const raw = fs.readFileSync(path.join(stickerPaths.stickerRoot(), '关键词触发', '关键词.md'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+?)\s*$/);
      if (!m) continue;
      // 2026-11-09 合并重复图的内部别名：`@别名 旧触发词：保留图名` 只在 qq.js 场合表里生效。
      // 不写进提示词（会凭空多几行），也不进 kwRowNames（否则保留者会被从清单里挤掉）。
      if (/^@别名\s+/.test(m[1])) continue;
      const disps = m[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean);
      if (!disps.length) continue;
      disps.forEach(n => kwRowNames.add(n));
      kwRows.push('- ' + m[1].trim() + '：' + disps.join('、'));
    }
  } catch {}
  const kw = all.map(base).filter(n => !used.has(n) && !kwRowNames.has(n));

  const head = [
    '<!-- sticker-list sig:' + stickerSig() + ' -->',
    '## 表情包（库里一共 ' + (all.length + lowRest.length) + ' 张）',
    '**怎么发**：单独写一行 `[表情:名字]`，一次最多一张。这一行不显示给人看；想先甩图再说话，就把它放在回复第一行。',
    '**情绪类**（`常用`/`可用`/`虚幻`/`少用` 里 `q` 开头的）：你自己真起这个情绪才发，别人难过别跟着发。',
    '**关键词类**（`关键词触发/` 里的）：对方话里出现了这个词就发，不用等你自己有情绪、也不用等别的理由。',
    '一行一族，格式「什么时候用：这一族」。冒号前后说中任一个词都能发；只写族名 = 整族里挑一张，'
      + '写全名（如 `q哭2`）就发那一张。只有族名的行 = 名字本身就是什么时候用。',
    '同一个词连着几条都在说，只发第一次，别刷屏。',
    '清单之外的名字库里没有；别人点名要、你没见过的，直说没有，不要假装发了。',
  ].join('\n');

  const body = [];
  // 描述里只有图名自己的（「- 摸头：摸头」）→ 压成「- 摸头」：名字就是提示词，不用再说一遍
  const stemOf = s => String(s == null ? '' : s).replace(/^[qQ]/, '').replace(/\d+$/, '');
  const descIsJustNames = (desc, disps) => {
    const segs = segsOf(desc);
    if (!segs.length) return true;
    const stems = disps.map(stemOf).concat(disps);
    return segs.every(x => stems.indexOf(x) >= 0 || stems.indexOf(stemOf(x)) >= 0);
  };
  for (const r of out) {
    if (r.drop) continue;
    if (!r.desc) { body.push('- ' + r.disps.join('、')); continue; }
    body.push(descIsJustNames(r.desc, r.disps)
      ? '- ' + r.disps.join('、')
      : '- ' + r.desc + '：' + r.disps.join('、'));
  }
  for (const d of missEmo) {
    const desc = stickerAutoOcc(d) || '（还没写描述，面板里补一句就知道什么时候用了）';
    body.push('- ' + desc + '：' + d);
  }
  if (kw.length || kwRows.length) {
    body.push('');
    body.push('### 关键词类（对方话里出现就发，不用等你自己有情绪）');
    kwRows.forEach(r => body.push(r));
    if (kw.length) body.push('- ' + kw.join('、'));
  }
  if (lowRest.length) {
    body.push('');
    body.push('### 少用（备用图，别常用）');
    body.push('- 想甩一张图但没什么话可说：少用');
  }
  _stickerPending = unknown;
  return head + '\n\n' + body.join('\n');
}

// 强制重建（面板按钮走这里）：不管签名、不看缓存，直接按现在的表和图重算一份
function stickerListRebuild() {
  const built = stickerListBuild();
  if (built) {
    try { fs.writeFileSync(STICKER_LIST_MD(), built + '\n', 'utf8'); } catch {}
  }
  _stickerCache = { at: Date.now(), text: built };
  return built;
}

// 提示词拿清单：文件在且签名对 → 直接读；否则重建 + 写盘（自愈，她不用点按钮）
function stickerPrompt() {
  const now = Date.now();
  if (_stickerCache && now - _stickerCache.at < 3000) return _stickerCache.text;
  let text = '';
  try { text = fs.readFileSync(STICKER_LIST_MD(), 'utf8'); } catch {}
  const sigNow = stickerSig();
  const ok = !!text && (text.split('\n')[0] || '').indexOf('sig:' + sigNow) >= 0;
  if (!ok) {
    text = stickerListRebuild();
  }
  if (!text) return '';
  const small = stickerListCompact(text);
  _stickerCache = { at: now, text: small };
  return small;
}

// ===== 星标（主人 2026-11-03 重定职责）=====
// 两个入口，同一个池（data/chat-stars.json）：
//   1. 面板手动点星  —— 主人亲手认可（weight 2）
//   2. 群里给她的消息点表情回应 —— 群友认可（weight 1）
// 用途：学说话的**最优先**数据。学的不是口气，是「这种场面该怎么回」——该不该接、接几句、用不用梗、断不断。
// 免记录群（config/features.json 的 noRecordGroups，默认赛博鱼塘 143620228）不加星：
// 那里是机器人群，在那说的话不代表她陪人聊天的样子（主人 2026-11-03 明确排除）。
const STARS_FILE = path.join(ROOT, 'data', 'chat-stars.json');
const STAR_MAX = 800;

function starsKey(t, nick, text) {
  return require('crypto').createHash('md5')
    .update(String(t) + '|' + String(nick) + '|' + String(text)).digest('hex').slice(0, 16);
}
// 归一化：只留判断「是不是同一句」用得上的字。@号是消息自带的，不算她打的字。
function starsNorm(s) {
  return String(s || '')
    .replace(/^↩回复@[^：]*：[\s\S]*?↩\s*/, '')
    .replace(/@\d{5,12}\s*/g, '')
    .replace(/\[表情[:：][^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 60);
}
function starsRead() {
  try { const a = JSON.parse(read(STARS_FILE) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function starsWrite(list) {
  try {
    fs.mkdirSync(path.dirname(STARS_FILE), { recursive: true });
    fs.writeFileSync(STARS_FILE, JSON.stringify((list || []).slice(-STAR_MAX), null, 1), 'utf8');
  } catch (e) { console.log('[星标] 写失败：' + e.message); }
}
// 加一条星。返回 'added' / 'dup' / 'banned'。
// entry: {key,t,scope,nick,text,prev,prevNick,run,img,by:'manual'|'emoji'}
// 免记录群（赛博鱼塘）：主人**手动**点的照样存（那是她的判断，不能静默吞掉），只是标 fish、学话时不用；
// 群友自动点赞的不存——那本来就不该落盘。
function starsAdd(entry) {
  const e = entry || {};
  const scope = String(e.scope || '');
  const banned = isNoRecordScope(scope);
  if (banned && e.by !== 'manual') return 'banned';
  const text = String(e.text || '').trim().slice(0, 400);
  if (!text) return 'dup';
  const key = String(e.key || starsKey(e.t || new Date().toISOString(), e.nick || '', text));
  const list = starsRead();
  if (list.some(x => x && x.key === key)) return 'dup';
  const row = {
    key, t: String(e.t || new Date().toISOString()), src: String(e.src || 'qq'),
    scope, nick: String(e.nick || (cfg && cfg.botName) || '虚幻'), text,
    by: e.by === 'manual' ? 'manual' : 'emoji',
    at: new Date().toISOString(),
  };
  if (banned) row.fish = true;
  // 学接话要语境：当时对方那句。有就存，没有就不存（不编）。
  if (e.prev) { row.prev = String(e.prev).replace(/\s+/g, ' ').trim().slice(0, 100); row.prevNick = String(e.prevNick || ''); }
  if (Number(e.run) > 1) row.run = Number(e.run);     // 这一轮她连发到第几条
  if (e.img) row.img = true;
  // 主人 2026-11-07：加星时能写「为什么值得学」，能多选前后几句当上下文。
  // 两项都可选；没有就完全不写这两个字段，老 45 条星标一个字节都不变。
  const note = String(e.note || '').trim();
  if (note) row.note = note.slice(0, 200);
  if (Array.isArray(e.ctx) && e.ctx.length) {
    row.ctx = e.ctx.slice(0, 8).map(x => ({
      nick: String((x && x.nick) || '').slice(0, 30),
      text: String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      bot: !!(x && x.bot),
    })).filter(x => x.text).slice(0, 8);
    if (!row.ctx.length) delete row.ctx;
  }
  list.push(row);
  starsWrite(list);
  return 'added';
}
// 从聊天记录里反查「这句她是什么时候发的」→ 补回 key 和语境。
// 旧版加星时用 emoji+message_id 当 key，面板按 md5 算，永远对不上号 → 星在面板里点不亮。
function starsFindLine(scope, text) {
  try {
    const want = starsNorm(text);
    if (!want) return null;
    const bot = (cfg && cfg.botName) || '虚幻';
    const lines = read(CHATLOG_PATH).split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]((?:\[[^\]]*\])*)\s*([\s\S]*)$/);
      if (!m) continue;
      if (m[3] !== scope || m[4].trim() !== bot) continue;
      if (starsNorm(m[6]) !== want) continue;
      const row = { t: m[1], nick: m[4], text: m[6] };
      // 往上找同一个群/私聊里、最近一条别人说的话。
      // 旧版只扫 4 行：别的群消息一插进来就把预算用完，语境丢失，星标只剩孤零零一句。
      // 现在别的群的行不占预算；同群最多看 40 条，物理最多回看 200 行，
      // 再加 6 小时窗口，防止把几天前的一句当成这一轮的语境。
      let seen = 0;
      for (let j = i - 1; j >= 0 && i - j <= 200; j--) {
        const p = lines[j].match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]((?:\[[^\]]*\])*)\s*([\s\S]*)$/);
        if (!p || p[3] !== scope) continue;
        if (++seen > 40) break;
        if (p[4].trim() === bot) continue;
        const gap = Date.parse(m[1]) - Date.parse(p[1]);
        if (Number.isFinite(gap) && gap > 6 * 3600 * 1000) break;
        row.prev = p[6]; row.prevNick = p[4];
        break;
      }
      row.key = starsKey(row.t, row.nick, row.text);
      return row;
    }
  } catch {}
  return null;
}
// 一次性修历史脏 key：emoji* 前缀的，按 scope+文本回查日志，能对上就换成 md5。
// 对不上的（多半是免记录群，日志里本来就没存）保留原样，只是不参与注入。
function starsHeal() {
  const list = starsRead();
  let fixed = 0;
  for (const x of list) {
    if (!x || !/^emoji/i.test(String(x.key || ''))) continue;
    const hit = starsFindLine(x.scope, x.text);
    if (!hit) continue;
    if (list.some(y => y !== x && y.key === hit.key)) { continue; }
    x.key = hit.key;
    if (x.t !== hit.t) x.t = hit.t;
    if (hit.prev && !x.prev) { x.prev = hit.prev; x.prevNick = hit.prevNick; }
    fixed++;
  }
  if (fixed) starsWrite(list);
  return fixed;
}

let starCache = [];
let starStamp = -1;
function starSamples(limit) {
  try {
    const st = fs.statSync(STARS_FILE).mtimeMs;
    if (st !== starStamp) {
      starStamp = st;
      const bot = (cfg && cfg.botName) || '虚幻';
      const seen = new Set();
      starCache = starsRead()
        .filter(x => x && String(x.nick || '').trim() === bot && x.text)
        .filter(x => !isNoRecordScope(x.scope))        // 免记录群的星不参与学话
        .map(x => ({
          // @号是消息自带的、↩回复@X：…↩ 是群引用的机器前缀，都不是她打的字，剥掉
          text: String(x.text)
            .replace(/^↩回复@[^：]*：[\s\S]*?↩\s*/, '')
            .replace(/@\d{5,12}\s*/g, '').replace(/\s+/g, ' ').trim() || String(x.text).trim(),
          prev: String(x.prev || '')
            .replace(/^↩回复@[^：]*：[\s\S]*?↩\s*/, '')
            .replace(/@\d{5,12}\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 60),
          prevNick: String(x.prevNick || ''),
          by: x.by === 'manual' ? 'manual' : 'emoji',
          run: Number(x.run) || 1,
          t: String(x.t || ''),
          note: String(x.note || '').trim().slice(0, 200),
          ctx: Array.isArray(x.ctx) ? x.ctx.slice(0, 8) : [],
        }))
        .filter(x => x.text)
        .filter(x => (seen.has(x.text) ? false : (seen.add(x.text), true)));
    }
  } catch { starCache = []; }
  const n = limit || 6;
  // 优先级（主人 2026-11-03）：手动星标 > 群友点赞；带语境的 > 光一句的。
  // 不过滤长短——长回答也是她真实的做法；但短句占多数，因为接话逻辑靠短句才看得出来。
  const rank = x => (x.by === 'manual' ? 4 : 0) + (x.prev ? 2 : 0) + (x.text.length <= 30 ? 1 : 0);
  const pool = starCache.slice().sort((a, b) => rank(b) - rank(a) || String(b.t).localeCompare(String(a.t)));
  return pool.slice(0, n);
}

// 学的是**回复逻辑**，不是口气（主人 2026-11-03 定的全部规则）：
//   该不该回 / 回的频率 / 一次几句 / 用不用表情包 / 用词方向 / 比不比喻 / 接不接话 / 什么时候断 / 固定话术
// 所以注进去的是「对方说了什么 → 她当时怎么接」这种成对的例子，原句照给，才能复现。
function starPrompt(limit) {
  const arr = starSamples(limit);
  if (!arr.length) return '';
  // 最少写法（主人 2026-11-07）：描述和手选上下文接在原来那一行里，不新增段落、不加规则句。
  // 手选了上下文就用手选的（比自动找的上一句准），没选才退回原来的 prev。
  const lines = arr.map(x => {
    const picked = (x.ctx || []).slice(0, 4)
      .map(c => String(c.nick || '对方') + '「' + String(c.text || '').slice(0, 40) + '」')
      .join('');
    const head = picked || (x.prev ? '对方「' + x.prev + '」' : '');
    const base = head
      ? '- ' + head + ' → 她「' + x.text.slice(0, 120) + '」'
      : '- 她「' + x.text.slice(0, 120) + '」';
    return x.note ? base + '（为什么：' + String(x.note).slice(0, 60) + '）' : base;
  });
  return ['\n## 星标过的回复（最优先：照这些的做法回）',
    lines.join('\n'),
    '上面每一句都是她真发出去、并且被认可的（主人亲手星标 / 群友点过赞）。',
    '学回复逻辑。别学口气：该不该接 / 接几句 / 用不用表情包 / 爱用什么词 / 比不比喻 / 接不接话 / 什么时候断 / 有没有固定话术。',
    '别照抄字面。原句的效果要能复现：照它的做法回，像平时聊天那样说，字面按当下这句话另说。',
  ].join('\n');
}


// 图：拿到消息里的图片后用这个（connectors/qq.js 调用）

// 每次调用都重新读 config.json 的 llm 段 → 填完 Key 不用重启
// 速度优化（2026-10-22）：按 mtime 缓存——文件没改就只 stat 一次，不再整读整解析。
// 面板/手工改了 config.json，mtime 变了立刻重读，「改完即生效」的行为不变。
let _cfgCache = { at: 0, data: null };
// 现在从 config/ 四个分区合并读取（按 mtime 缓存）。面板/手工改任意分区文件立刻生效。
function readConfigFresh() {
  return configStore.cfgLive();
}
function llmCfg() {
  const fresh = readConfigFresh();
  const l = (fresh && fresh.llm) || cfg.llm;
  // 2026-11-10（她令「直接接入 AstrBot」）：AstrBot 里配好的模型挂成路由，模型名对得上就用那个源的地址与 Key。
  // 只多一个 route 方法，llm 原有字段一个不改；AstrBot 读不到就是空池，行为与改动前完全一致。
  try { return astrbotLlm.attach(l); } catch { return l; }
}

// 系统 DNS 坏掉时（getaddrinfo ENOTFOUND）自动改问公共 DNS，再用 IP 直连
// 这样即使本机 DNS 被代理软件搞坏，机器人照样能说话
const https = require('https');
const http = require('http');
const dns = require('dns');
const ipCache = new Map();          // host -> { ip, at }

function resolveHost(host) {
  const hit = ipCache.get(host);
  if (hit && Date.now() - hit.at < 300000) return Promise.resolve(hit.ip);
  const save = ip => { ipCache.set(host, { ip, at: Date.now() }); return ip; };
  return new Promise(res => {
    dns.lookup(host, { family: 4 }, (e, a) => {
      if (!e && a) return res(save(a));
      const r = new dns.Resolver();
      r.setServers(['223.5.5.5', '119.29.29.29', '114.114.114.114']);
      r.resolve4(host, (e2, list) => {
        if (e2 || !list || !list.length) return res('');
        console.log('[net] 系统 DNS 查不到，已改用公共 DNS：' + host + ' → ' + list[0]);
        res(save(list[0]));
      });
    });
  });
}

function postJson(url, headers, bodyStr, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('接口地址不对')); }
    const isHttps = u.protocol === 'https:';
    const host = u.hostname;
    const ip = await resolveHost(host);
    if (!ip) return reject(Object.assign(new Error('DNS 解析失败 ' + host), { code: 'ENOTFOUND' }));
    const mod = isHttps ? https : http;
    const req = mod.request({
      host: ip,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      servername: isHttps ? host : undefined,   // SNI 用域名，证书校验照常
      headers: Object.assign({ Host: host, 'Content-Length': Buffer.byteLength(bodyStr) }, headers),
      timeout: timeoutMs || 30000,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('超时'), { code: 'ETIMEDOUT' })));
    req.on('error', e => reject(e));
    req.write(bodyStr);
    req.end();
  });
}

// 下载图片（同样走自定义 DNS，QQ 的图床经常解析不出来）
function getBinary(url, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('图片地址不对')); }
    const isHttps = u.protocol === 'https:';
    const ip = await resolveHost(u.hostname);
    if (!ip) return reject(new Error('图片域名解析失败 ' + u.hostname));
    const mod = isHttps ? https : http;
    // QQ 图床（gchat.qpic.cn / multimedia.nt.qq.com.cn）偶发防盗链 → 带上 Referer 再要
    const ref = /qpic\.cn|multimedia\.nt\.qq|qzone\.qq|gtimg\.cn/i.test(u.hostname) ? 'https://qzone.qq.com/' : '';
    const req = mod.request({
      host: ip,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      servername: isHttps ? u.hostname : undefined,
      headers: Object.assign({ Host: u.hostname, 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' }, ref ? { Referer: ref } : {}),
      timeout: timeoutMs || 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return getBinary(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
      }
      // 非 200 把响应体读出来带进错误：QQ 图床过期会回 400 + {"retmsg":"invalid rkey"}，
      // 只报状态码看不出是 rkey 过期还是别的，写进 ai-feedback / bot 日志才能定位（2026-11-16）
      if (res.statusCode !== 200) {
        const eb = [];
        res.on('data', c => eb.push(c));
        res.on('error', () => reject(new Error('图片返回 ' + res.statusCode)));
        return res.on('end', () => reject(new Error('图片返回 ' + res.statusCode + '：' + Buffer.concat(eb).toString('utf8').slice(0, 160))));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/png' }));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// 看图片：glm-4v-flash（免费），图片用 data URI 传，不怕图床防盗链
// 动图（gif）模型解析不了 → 用本机 Chrome 截一帧再当静态图看
const { execFile } = require('child_process');
const CHROME_PATHS = [
  // macOS（2026-10-28 迁 Mac 时补在最前面：原来只有 Windows 四条，Mac 上 findChrome 永远返回空，
  // 动图 gif 就没法截帧，看图功能对动图直接瞎掉）
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
let chromePath;
function findChrome() {
  if (chromePath !== undefined) return chromePath;
  chromePath = '';
  for (const p of CHROME_PATHS) { try { if (fs.existsSync(p)) { chromePath = p; break; } } catch {} }
  return chromePath;
}

// 按文件头认图片真实格式：扩展名会骗人（data/stickers/常用/哭1.jpg 真身是 GIF，
// 按 jpeg 发给视觉模型必报「1210 图片输入格式/解析错误」）
function realImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  return '';
}

function gifToPng(buf) {
  return new Promise(resolve => {
    const chrome = findChrome();
    if (!chrome) return resolve('');
    const stamp = 'ula-gif-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const gifPath = path.join(require('os').tmpdir(), stamp + '.gif');
    const pngPath = path.join(require('os').tmpdir(), stamp + '.png');
    try { fs.writeFileSync(gifPath, buf); } catch { return resolve(''); }
    const toUrl = p => 'file:///' + p.replace(/\\/g, '/');
    execFile(chrome, [
      // 2026-11-01 加 --no-sandbox / --disable-dev-shm-usage：mac 上不带这两个，
      // 受限环境下 Chrome 直接「Failed to initialize sandbox」退出，截帧永远返回空
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
      '--window-size=800,800', '--virtual-time-budget=1500',
      '--screenshot=' + pngPath.replace(/\\/g, '/'), toUrl(gifPath),
    ], { timeout: 20000 }, () => {
      let b64 = '';
      try { b64 = fs.readFileSync(pngPath).toString('base64'); } catch {}
      try { fs.unlinkSync(gifPath); } catch {}
      try { fs.unlinkSync(pngPath); } catch {}
      resolve(b64);
    });
  });
}

const VISION_PROMPT = '第一步：把图里出现的所有文字逐字读出来——表情包上的大字、角落里的小字、水印都算，有几行读几行，一个字都不许漏掉或改写。第二步：用一句话说这是什么图、什么表情。如果图里确实一个文字都没有，第一步就写「没有文字」。不要解释你在做什么。';

async function seeOnce(model, parts, llm, maxTokens) {
  const _uT0 = Date.now();
  // 2026-11-18（修「看不到图」）：AstrBot 模式下 llm.endpoint / llm.apiKey 是空的，真地址与 Key
  // 在 AstrBot 配置里、只能按模型名 route() 取。以前这里直接用 llm.endpoint → new URL('') 抛
  // 「接口地址不对」，一个请求都发不出去。现在模型名在池里就走池，不在才回退 llm.json。
  const conn = (typeof llm.route === 'function' && llm.route(model)) || null;
  const endpoint = (conn && conn.endpoint) || llm.endpoint;
  const apiKey = (conn && conn.apiKey) || llm.apiKey;
  if (!endpoint) throw new Error('看图没有可用的接口地址（' + model + '）');
  const body = JSON.stringify({
    // 走池时用池里的真模型名（配置写「源/模型」时两者不同，发错的模型名会被拒）
    model: (conn && conn.model) || model,
    messages: [{ role: 'user', content: parts }],
    max_tokens: Number(maxTokens || 400),
  });
  const r = await postJson(endpoint, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }, body, 40000);
  if (r.status < 200 || r.status >= 300) {
    recordUsage({ scene: 'vision', model, ms: Date.now() - _uT0, ok: false, err: '看不了图 HTTP ' + r.status });
    throw new Error('看不了图 ' + r.status + '：' + r.text.slice(0, 120));
  }
  let j; try { j = JSON.parse(r.text); } catch { return { text: '', finish: '' }; }
  // 看图走的是独立接口，也得记账：群里每张图都是一笔，不记就不知道图烧了多少
  const _u = j.usage || {};
  recordUsage({ scene: 'vision', model, in: _u.prompt_tokens, out: _u.completion_tokens, total: _u.total_tokens, cache: usageCached(_u), ms: Date.now() - _uT0, ok: true });
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  // finish_reason='length' = 模型被 max_tokens 掐断，图上的字没抄完（长图必须靠它判断要不要切块重抄）
  const finish = String((j.choices && j.choices[0] && j.choices[0].finish_reason) || '');
  // 思考型视觉模型会把思路塞进正文的 <think> 标签里（实测 glm-4.1v-thinking-flash 会给 700 字思路），
  // 抄表格只要结论，思路留着会把描述撑爆、还会被当成「图上写的字」——所以只留正文。
  // 2026-11-18（修）：正文优先；正文空才退回 reasoning_content。未闭合的 <think> 只去标签、留后面的字，
  // 以前只去掉「成对」的标签，未闭合时整段思路会被当成图上的字抄进提示词。
  let text = String(msg.content || '').trim();
  if (!text) text = String(msg.reasoning_content || '').trim();
  return { text: text.replace(/<think[\s\S]*?<\/think>/gi, '').replace(/<\/?think[^>]*>/gi, '').trim(), finish };
}

/* 看图能用的模型名（2026-11-18 修「看不到图」）：
 * 以前只认 llm.json 手填的 visionModel，没填就 chain=[] → 一个请求都不发、3ms 返回空，
 * 提示词里只剩 [图片]，看起来就是「看不见图」。而 AstrBot 池里明明有 glm-4v-flash /
 * glm-4.1v-thinking-flash / glm-4.6v-flash 三个视觉款，代码从不去找。
 * 现在：显式配置优先，没配（或不够）就从池里按名字挑视觉款，逐个试，余额不足/限流自动换下一个。
 * 只是挑模型名，不发额外请求、不加提示词、不多花 token。 */
const VISION_NAME_RE = /4(\.\d+)?v|(^|[-_/])(vl|vision)\b|gpt-4o|gemini|omni/i;

// 视觉模型的两个小账本（2026-11-18）：①刚 429/没额度的，60 秒内别再去撞；
// ②试出来的 max_tokens 上限（glm-4v-flash 只允许 1024，给多了报 1210）。
const _visionDown = new Map();
const _mtCap = new Map();

function visionChain(llm) {
  const out = [];
  const push = n => { const s = String(n || '').trim(); if (s && !out.includes(s)) out.push(s); };
  push(llm.visionModel);
  for (const m of (Array.isArray(llm.visionFallback) ? llm.visionFallback : [])) push(m);
  for (const x of (Array.isArray(llm.astrbotModels) ? llm.astrbotModels : [])) {
    const n = x && (x.model || x);
    if (n && VISION_NAME_RE.test(String(n))) push(n);
  }
  return out;
}

/* 看图片（核心）：一个视觉模型不行就换下一个（AstrBot 池里按名字挑，配置里写了就先用配置的）。
 * 返回 { text, finish, model } —— finish='length' 表示被 max_tokens 掐断，字没抄完。
 * preferFast=true 时把「不思考」的视觉模型排前面：抄长图的字要肯逐行抄的，
 * 思考型（glm-4.1v-thinking-flash）实测会把一半预算花在思路里，还会自己「简化呈现」（2026-11-18 实测）。*/
async function seeImageTry(dataUris, question, modelOverride, preferFast) {
  const llm = llmCfg();
  const parts = (dataUris || []).slice(0, 4).map(x => ({ type: 'image_url', image_url: { url: x } }));
  if (!parts.length) return { text: '', finish: '', model: '' };
  parts.push({ type: 'text', text: question || VISION_PROMPT });
  let chain = modelOverride ? [modelOverride] : visionChain(llm);
  if (preferFast) chain = chain.filter(m => !/thinking/i.test(m)).concat(chain.filter(m => /thinking/i.test(m)));
  if (!chain.length) {
    // 以前这里是静默空返回，坏了半个月没人发现；现在留一行日志，一眼能看出是「没配视觉模型」而不是「图糊了」
    console.log('[img] 没有可用的视觉模型（llm.json 的 visionModel/visionFallback 空，池里也没认出视觉款）→ 这张图不翻译');
    return { text: '', finish: '', model: '' };
  }
  let lastErr = null;
  // 429/余额不足的模型 60 秒内别再去撞：200 行图要 9 块，每块都先撞一遍是白等（2026-11-18）
  const now = Date.now();
  const alive = chain.filter(m => !((_visionDown.get(m) || 0) > now));
  const use = alive.length ? alive : chain;      // 全被标死了就照原链试，不能一个都不试
  for (const m of use) {
    const mt = _mtCap.get(m) || (/thinking/i.test(m) ? 1600 : 2048);
    try {
      let r = await seeOnce(m, parts, llm, mt);
      // glm-4v-flash 的 max_tokens 硬上限是 1024（报 1210 参数非法）→ 记下这个模型的上限，以后直接用 1024
      if (!r.text && /1210|max_tokens/i.test(String(r.finish || ''))) {
        _mtCap.set(m, 1024);
        r = await seeOnce(m, parts, llm, 1024);
      }
      if (r.text) { if (m !== use[0]) console.log('[img] 已切到 ' + m); return { text: r.text, finish: r.finish, model: m }; }
      lastErr = new Error(m + ' 什么都没返回');
      console.log('[img] ' + m + ' 返回空，换下一个');
    } catch (e) {
      lastErr = e;
      // 1210 = max_tokens 超出这个模型的允许范围 → 记下 1024 再试一次
      if (/1210|max_tokens/i.test(e.message) && mt !== 1024) {
        _mtCap.set(m, 1024);
        try {
          const r2 = await seeOnce(m, parts, llm, 1024);
          if (r2.text) return { text: r2.text, finish: r2.finish, model: m };
        } catch (e2) { console.log('[img] ' + m + ' 1024 也不行：' + e2.message.slice(0, 60)); }
      }
      // 限流 / 没额度 → 60 秒内不再试它（额度恢复后自动回来）
      if (/429|1113|1305|余额|限流|访问量/i.test(e.message)) _visionDown.set(m, Date.now() + 60000);
      console.log('[img] ' + m + ' 失败：' + e.message.slice(0, 80));
    }
  }
  if (lastErr) throw lastErr;
  return { text: '', finish: '', model: '' };
}

// 对外保持老签名：返回纯文本（qq.js / 面板 / 头像 / 截图都按字符串用）
// preferFast=true：抄图上的字时用（消息里的图），把「不思考、肯逐行抄」的模型排前面
async function seeImage(dataUris, question, modelOverride, preferFast) {
  const r = await seeImageTry(dataUris, question, modelOverride, !!preferFast);
  return r.text || '';
}

/* ===== 长图：切块逐块抄字（2026-11-18 主人定：图上的字要全输出，宁可压缩提示词也不许压缩字）=====
 * 为什么必须切：单个视觉模型一次抄不完 —— glm-4v-flash 的 max_tokens 硬上限 1024（约 1600 字，
 * 实测 50 行、1303 字刚好抄全），200 行图要 4~5 块；而且整张 8000px 的图会被接口降采样到看不清字。
 * 切块后每块 1800px，实测能逐行抄全；块间重叠 120px 防止正好切断一行。 */
const LONG_IMG_H = 2000;    // 高过这个就切（约 50 行字，一次请求已经抄不完）
const LONG_IMG_CH = 1000;   // 每块高度：约 25 行字。实测 glm-4.1v-thinking-flash 在 1600 token 里
                            // 只有约一半能落到正文（900 字 ≈ 35 行），块再高就漏抄；glm-4v-flash 能抄更多，
                            // 但它额度经常 429，所以按「最差也能抄全」来切
const LONG_IMG_OV = 80;     // 块间重叠（防止正好切断一行）
const LONG_IMG_MAXBLK = 16; // 最多 16 块（约 15000px）；再长只抄前 16 块并在描述里说明

// 从文件头读宽高（不依赖任何图像库，够快）：长图判定要用
function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG：IHDR 里第 16~24 字节就是宽高
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    // JPEG：遍历段找 SOF0/1/2（C0~CF，跳过 C4/C8/CC）
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (!len) break;
        i += 2 + len;
      }
    }
    if (buf.slice(0, 4).toString('latin1') === 'GIF8') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  } catch {}
  return null;
}

// 竖着切块（python PIL）。切不了（没 python / 没 PIL / 图太短）→ 返回 []，调用方退回单次识图，不报错。
// 2026-11-19：bot 进程的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，python3 落到系统那个没装 PIL 的，
// 于是长图切块一直在失败（1260x9907 的截图直接退回整图识别）。改成挨个试，哪个能 import PIL 就用哪个，
// 成功一次就记住，后面不再试。
let _pyPilPath = '';
function pyPilCandidates() {
  const out = [];
  if (_pyPilPath) out.push(_pyPilPath);
  out.push('python3');
  const home = process.env.HOME || '';
  if (home) {
    try {
      const base = path.join(home, '.workbuddy', 'binaries', 'python');
      const envPy = path.join(base, 'envs', 'default', 'bin', 'python3');
      if (fs.existsSync(envPy)) out.push(envPy);
      for (const v of fs.readdirSync(path.join(base, 'versions'))) {
        const p = path.join(base, 'versions', v, 'bin', 'python3');
        if (fs.existsSync(p)) out.push(p);
      }
    } catch {}
  }
  out.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3');
  return Array.from(new Set(out.filter(Boolean)));
}
function sliceImage(buf, ext, ch, ov, maxBlk) {
  return new Promise(resolve => {
    const os = require('os');
    const stamp = 'ula-slice-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const src = path.join(os.tmpdir(), stamp + ext);
    const outDir = path.join(os.tmpdir(), stamp);
    try { fs.mkdirSync(outDir); fs.writeFileSync(src, buf); } catch { return resolve([]); }
    const py = [
      'import sys, json, os',
      'from PIL import Image',
      'src, outdir, ch, ov, maxblk = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])',
      'im = Image.open(src).convert("RGB")',
      'w, h = im.size',
      'files = []',
      'y = 0',
      'while y < h and len(files) < maxblk:',
      '    y2 = min(h, y + ch)',
      '    p = os.path.join(outdir, "b%02d.png" % (len(files) + 1))',
      '    im.crop((0, y, w, y2)).save(p)',
      '    files.append(p)',
      '    if y2 >= h: break',
      '    y = y2 - ov',
      'print(json.dumps({"w": w, "h": h, "files": files}))',
    ].join('\n');
    const done = out => {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(src); } catch {}
      resolve(out);
    };
    const cands = pyPilCandidates();
    const tryOne = i => {
      const pyBin = cands[i] || 'python3';
      execFile(pyBin, ['-c', py, src, outDir, String(ch), String(ov), String(maxBlk)], { timeout: 60000 }, (err, stdout) => {
        if (err) {
          // 这个解释器没装 PIL / 跑不起来 → 换下一个，别整条链就废了
          if (i + 1 < cands.length) return tryOne(i + 1);
          console.log('[img] 切块失败（' + (err.message || '').slice(0, 60) + '）→ 退回整图识别');
          return done([]);
        }
        _pyPilPath = pyBin;
        let info = null;
        try { info = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch {}
        if (!info || !Array.isArray(info.files) || !info.files.length) return done([]);
        const out = [];
        for (const f of info.files) {
          try { out.push(fs.readFileSync(f).toString('base64')); } catch {}
        }
        console.log('[img] 长图 ' + info.w + 'x' + info.h + ' → 切成 ' + out.length + ' 块逐块抄字');
        done(out);
      });
    };
    tryOne(0);
  });
}

// 从「字：…／情绪：…／是什么：…」里抽出字那一段（抄写结果只关心字）
function pickTextPart(s) {
  const t = String(s || '');
  const m = t.match(/字\s*[：:]\s*([\s\S]*?)(?=\n\s*情绪\s*[：:]|$)/);
  const body = m ? m[1] : t;
  // 有的模型每一行都写成「字：xxx」（实测 glm-4.1v-thinking-flash），逐行把前缀剥掉，
  // 否则拼出来会变成「字：第一行 / 字：第二行 / …」（2026-11-18 端到端验出来的）
  return body.split('\n').map(x => x.replace(/^\s*[*#>\-\s]*字\s*[：:]\s*/, '')).join('\n').trim();
}
// 相邻块重叠 120px，抄出来会重复几行：按行合并，重复就丢（只跟已收集的最后 5 行比）
function mergeLines(all, add) {
  const lines = String(add || '').split('\n').map(x => x.trim()).filter(Boolean);
  for (const ln of lines) {
    if (all.slice(-5).some(x => x === ln)) continue;
    all.push(ln);
  }
  return all;
}

/* 长图识图：高 <= 2000 走一次普通识图；更高的切块逐块抄字，把字拼全。
 * 只给「消息里的图」用（qq.js describeImgs）；头像/截图这些短图不必走这里。 */
// 抄出来「可疑地少」吗：没说「无字」、字却不到 n 个 → 多半是模型偷懒/没看清（2026-11-18 实测
// glm-4.1v-thinking-flash 同一张 25 行图，一次抄 900 字、下一次只给 70 字，纯看它心情）
const tooShort = (t, n) => {
  const s = String(t || '');
  if (/无字/.test(s)) return false;
  return String(pickTextPart(s)).replace(/\s/g, '').length < n;
};
async function seeImageLong(buf, mime, ask) {
  const uri = imgCache.dataUriFromBuffer(buf, mime || 'image/png');
  const sz = imageSize(buf);
  if (!sz || sz.h <= LONG_IMG_H) {
    const first = await seeImage([uri], ask, '', true);
    if (!tooShort(first, 60)) return first;
    const again = await seeImage([uri], ask, '', true);      // 可疑就再要一次，取字多的
    return String(again).length > String(first).length ? again : first;
  }
  const ext = /png/i.test(mime || '') ? '.png' : '.jpg';
  const blocks = await sliceImage(buf, ext, LONG_IMG_CH, LONG_IMG_OV, LONG_IMG_MAXBLK);
  if (blocks.length < 2) return await seeImage([uri], ask, '', true);   // 切不了就照老办法
  const all = [];
  let mood = '', what = '';
  // 本来要切几块（用来判断有没有因为 MAXBLK 被截）
  const need = Math.ceil((sz.h - LONG_IMG_OV) / (LONG_IMG_CH - LONG_IMG_OV));
  const blockAsk = i => '这是同一张长截图从上往下的第 ' + (i + 1) + '/' + blocks.length + ' 块。'
    + '只管一件事：把这一块里出现的所有文字逐行照原样抄出来，一个字都不许漏、不许改写、不许概括。'
    + '开头写「字：」，然后逐行抄；这一块里一个字都没有就写「字：无字」。'
    + (i === blocks.length - 1 ? '\n抄完另起一行写「情绪：」选一个（哭/委屈/怒/震惊/无语/疑惑/累/喜欢/得意/害怕/笑/难过），再起一行「是什么：」一句话说完。' : '');
  // 一块怎么抄：preferFast=true → 先让不思考的模型抄（它肯逐行抄）；
  // 抄出来不到 150 字（一块 25 行，正常 300 字以上）认为偷懒/没看清，再要一次取字多的
  const oneBlock = async i => {
    const q = blockAsk(i);
    const buri = imgCache.dataUriFromB64(blocks[i], 'image/png');
    let got = '';
    try { got = (await seeImageTry([buri], q, '', true)).text || ''; } catch (e) { console.log('[img] 第 ' + (i + 1) + ' 块失败：' + e.message.slice(0, 60)); }
    if (tooShort(got, 150)) {
      try {
        const again = (await seeImageTry([buri], q, '', true)).text || '';
        if (String(pickTextPart(again)).length > String(pickTextPart(got)).length) got = again;
      } catch (e) { console.log('[img] 第 ' + (i + 1) + ' 块重试失败：' + e.message.slice(0, 50)); }
    }
    return got;
  };
  /* 并发实测（2026-11-18，200 行图）：串行 126 秒抄到 185 行；并发 3 只 45 秒但只抄到 149 行、并发 2 75 秒 138 行。
   * 免费档一并发就限流、抄少了 —— 主人要的是「字全」，所以串行，某块空了再补一次。*/
  const got = new Array(blocks.length).fill('');
  for (let i = 0; i < blocks.length; i++) {
    got[i] = await oneBlock(i);
    if (!got[i] && blocks.length > 1) got[i] = await oneBlock(i);   // 空了补一次
  }
  for (let i = 0; i < blocks.length; i++) {
    if (!got[i]) continue;
    mergeLines(all, pickTextPart(got[i]));
    const mm = String(got[i]).match(/情绪\s*[：:]\s*([^\n]+)/); if (mm) mood = mm[1].trim();
    const ww = String(got[i]).match(/是什么\s*[：:]\s*([^\n]+)/); if (ww) what = ww[1].trim();
  }
  if (!all.length) return await seeImage([uri], ask, '', true);
  const out = ['字：' + all.join('\n')];
  if (mood) out.push('情绪：' + mood);
  if (what) out.push('是什么：' + what);
  if (blocks.length < need) out.push('（这张图特别长，只抄了前 ' + blocks.length + ' 块）');
  console.log('[img] 长图抄完：' + all.length + ' 行、' + all.join('').length + ' 字（' + blocks.length + '/' + need + ' 块）');
  return out.join('\n');
}

/* 看到一个正在说话的人：记下「显示名 → 号」，比一次头像 hash，必要时让视觉模型看一次。
 * 2026-11-07 从 qq.js 抽到这里，QQ 和 B站 共用同一份（以前只在 QQ 里做，B站 的人永远没有头像）。
 * 一个人两个号、两个平台都说话 → 每个号各存一张图、各写一条描述（都是同一个人，图分开记）。
 * 全程异步 + 节流：不拖慢回话；拿不到就静默跳过，不编。 */
function noteAvatar(platform, uid, nick) {
  const plat = qmeta.normPlat(platform);
  const id = qmeta.safeId(uid, plat);
  if (!id) return;
  try { qmeta.noteName(id, nick, plat); } catch {}
  qmeta.noteSeen(id, plat).then(async info => {
    if (!info.hash) return;
    if (!info.changed && !qmeta.needDesc(id, plat)) return;
    const f = qmeta.avatarCached(id, plat);
    if (!f) return;
    qmeta.markDescTried(id, plat);
    try {
      const uri = imgCache.dataUriFromFile(f, 'image/jpeg');
      const pl = (() => { try { return people.platLabel(plat); } catch { return plat; } })();
      const desc = await seeImage([uri],
        '这是一张' + pl + '头像。用一句中文说明画的是什么（人物/动物/景物、主色、明显特征）。只写看得见的，不推测性格，不写多余的话。');
      if (desc) {
        qmeta.setDesc(id, desc, plat);
        if (info.changed) console.log('[头像] ' + plat + ' ' + id.slice(0, 3) + '*** 换了头像：' + desc.slice(0, 40));
      }
    } catch (e) { console.log('[头像] 描述没拿到：' + (e && e.message || '')); }
  }).catch(() => {});
}

// 单次请求：成功返回文本；429/1305 抛 BUSY，401 抛 AUTH，连不上抛 NET
// 网络失败会自动重试两次（很多时候只是抖动，或者代理刚切）
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// ===== 她的思考（v79，主人 2026-10-23 定）=====
// 面板「她的思考」页：模型自己给的 reasoning_content，**原样存，不改一个字**，只留最近 5 条。
// 默认不开思考（开了又慢、正文还容易空），主人在面板点「下一轮想给我看」→ 下一轮开思考。
const THINK_PATH = path.join(ROOT, 'data', 'thinking.jsonl');
const THINK_REQ = path.join(ROOT, 'data', 'think-request.json');
let _thinkK = '';            // 当前这一轮是哪个会话（askOnce 进来时写，recordThinking 用）
const THINK_KEEP = 30;      // 2026-11-11 从 5 提到 30：多群同时开着实时思考时，5 条留不住当前会话
function takeThinkRequest() {
  try {
    if (!fs.existsSync(THINK_REQ)) return false;
    fs.unlinkSync(THINK_REQ);        // 只对这一轮生效
    return true;
  } catch { return false; }
}

/* 常开思考（2026-11-11 主人令）：「聊天记录页下面的实时思考」开关打开时，
 * 每一轮都让模型给思考原文——这是真花 token 的（省不了），所以开关关掉就一个字节都不花，
 * 不是「生成了但藏起来不看」。存在机器人端 config 的 context.liveThink（面板「数值」页也能改）。 */
function liveThinkOn() {
  try {
    const c = readConfigFresh() || {};
    const v = (c.context || {}).liveThink;
    return v === true || Number(v) === 1;
  } catch { return false; }
}
function recordThinking(model, reason, reply, messages, note) {
  try {
    const item = {
      // 这一轮的会话键（qq_群号 / qq_号）：聊天记录页下方「实时思考」按会话筛，
      // 生成结束后同一条也在这一句的「推理」里（trace.reason），两处是同一份原文。
      k: String(_thinkK || ''),
      t: new Date().toISOString(),
      model: String(model || ''),
      reason: String(reason || '').slice(0, 8000),
      reply: String(reply || '').slice(0, 2000),
      note: String(note || ''),                      // 只有「开思考但没等到」才有，写实话、不编
      ctx: (messages || []).slice(-6)
        .map(m => m.role + '：' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)).join('\n').slice(0, 2000),
    };
    const lines = [];
    if (fs.existsSync(THINK_PATH)) {
      for (const l of fs.readFileSync(THINK_PATH, 'utf8').split('\n')) if (l.trim()) lines.push(l);
    }
    lines.push(JSON.stringify(item));
    while (lines.length > THINK_KEEP) lines.shift();     // 只留最近 5 个，多了自动删
    fs.writeFileSync(THINK_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (e) { console.log('[think] 存不了思考：' + e.message); }
}

// ===== token 用量账（v80，主人 2026-10-31 定）=====
// 智谱每一次返回里都带着 usage（这轮输入/输出各多少 token），以前这一段被直接丢掉 ——
// 所以「钱到底烧在哪」只能靠数字符估算。现在每一笔都记账，面板「花费账」页按功能排行看。
// 账本放在项目外面（主人指定的公共目录 token/）：主机器人和 AstrBot 写同一本账，用 app 分清是谁花的。
const USAGE_APP = 'qqbot';
const USAGE_DIR_DEFAULT = path.join(ROOT, '..', '..', 'token');
let _usageMkdirDone = false;
function usageCfg() {
  try { return (readConfigFresh() || {}).usage || {}; } catch { return {}; }
}
function usageDir() {
  const d = String(usageCfg().dir || '').trim();
  const dir = d || USAGE_DIR_DEFAULT;
  if (!_usageMkdirDone) { try { fs.mkdirSync(dir, { recursive: true }); _usageMkdirDone = true; } catch {} }
  return dir;
}
// 从接口返回的 usage 里挖「缓存命中 token」。不同厂商字段名不一样，逐个都试，取第一个非负值。
// 挖不到就返回 0（缓存命中率显示「—」，不猜、不伪造）。
// 智谱/OpenAI 兼容：usage.prompt_tokens_details.cached_tokens；
// Anthropic：usage.cache_read_input_tokens；也兼容直接摊在 usage 顶层的写法。
function usageCached(u) {
  if (!u || typeof u !== 'object') return 0;
  const details = u.prompt_tokens_details || u.input_tokens_details || {};
  const cands = [
    details.cached_tokens, details.cache_read_tokens,
    u.cached_tokens, u.cache_read_input_tokens, u.cache_read_tokens, u.cache_hit_tokens,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
// 每一笔一行：t 时间 / app 哪套机器人 / scene 干什么用的 / model 用的哪个模型 /
// in 输入 token（含缓存）/ cache 其中缓存命中的 token / out 输出 token / total 合计 /
// ms 耗时 / ok 成功没 / err 失败原因
function recordUsage(o) {
  try {
    if (usageCfg().enabled === false) return;
    const inn = Number(o.in) || 0, out = Number(o.out) || 0;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      app: USAGE_APP,
      scene: String(o.scene || 'other'),
      model: String(o.model || ''),
      in: inn, out,
      cache: Math.max(0, Number(o.cache) || 0),   // 缓存命中 token；老接口没返回就是 0
      total: Number(o.total) || (inn + out),
      ms: Number(o.ms) || 0,
      ok: o.ok !== false,
      err: String(o.err || '').slice(0, 120),
      // 哪个会话花的（2026-11-11 主人令：聊天记录页要按群/私聊算钱）。
      // 键和按会话设置同一个：qq_群号 / qq_号；后台类调用（日记、记忆）没有会话键，留空。
      k: String(o.k || '').slice(0, 60),
    });
    const file = path.join(usageDir(), 'token-usage.jsonl');
    fs.appendFileSync(file, line + '\n', 'utf8');
    usageTrim(file);
  } catch (e) { console.log('[usage] 记不了用量：' + e.message); }
}
// 按保留天数裁掉过期的。每半小时最多跑一次，且文件不到 1MB 不动它（别拖慢正常对话）
let _usageTrimAt = 0;
function usageTrim(file) {
  const now = Date.now();
  if (now - _usageTrimAt < 30 * 60 * 1000) return;
  _usageTrimAt = now;
  try {
    if (fs.statSync(file).size < 1024 * 1024) return;
    const days = Number(usageCfg().keepDays) || 30;
    const cut = now - days * 86400000;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => {
      if (!l.trim()) return false;
      try { return new Date(JSON.parse(l).t).getTime() >= cut; } catch { return true; }
    });
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log('[usage] 账本清理完，还剩 ' + lines.length + ' 条（保留 ' + days + ' 天）');
  } catch {}
}

// 全局限速（2026-11-01）：免费档约每秒 1 次请求，两个框架共用同一个 Key 时并发必撞 429。
// 所有模型请求串成一条队，相邻两次至少隔 1.1 秒——用一点点延迟换「不白等、不整段哑火」。
const LLM_MIN_GAP_MS = 1100;
let _llmLastAt = 0, _llmChain = Promise.resolve();
function llmSlot() {
  const run = _llmChain.then(async () => {
    const wait = LLM_MIN_GAP_MS - (Date.now() - _llmLastAt);
    if (wait > 0) await sleepMs(wait);
    _llmLastAt = Date.now();
  });
  _llmChain = run.catch(() => {});
  return run;
}

// 最近一次真实 LLM 调用的事实（模型名 / 思考原文 / 耗时），给决策轨迹落盘用。
// 只在 askOnce 成功返回时写，失败不写；不是模型内心独白。
let _lastLlmCall = { t: 0, model: '', reason: '', ms: 0, inTok: 0, outTok: 0 };

/* 按模型名单独放宽限制（2026-11-11 主人令：「本地 9b 思考 1～3 分钟，单独给他放开响应限制」）。
 * 为什么不直接改全局：全局 timeoutMs=15 秒，改大以后云端模型挂住也要白等几分钟，反过来更糟。
 * 所以按模型点名，只对 config.llm.modelLimits 里写到的那个模型生效，其余模型一个字节都不变：
 *   "modelLimits": { "local-9b": { "timeoutMs": 300000, "thinkTimeoutMs": 300000, "maxTokens": 4096 } }
 * 查不到 → 返回 null → 调用方照旧用全局值（与改动前行为完全一致）。 */
function modelLimit(llm, model) {
  const map = (llm && llm.modelLimits) || null;
  if (!map || typeof map !== 'object') return null;
  const name = String(model || '').trim();
  if (!name) return null;
  if (map[name] && typeof map[name] === 'object') return map[name];
  const low = name.toLowerCase();
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (!v || typeof v !== 'object') continue;
    if (String(k).toLowerCase() === low) return v;   // 模型名大小写不同也认
  }
  return null;
}

/* 把 bot 组好的 messages 摊成一段给 DSH agent 的提示词（只用在我出面这一轮）。
   为什么整段带过去：system 里是 buildMessages 组好的虚幻人设（身份/性格/说话/应对/引用对象），
   历史是真实上下文。带过去才叫「同一个位置」，否则我会答成另一个人的腔调。 */
/* 派活模式（主人 2026-11-22：「切换模式开关，开和关各有效果，不是关了就断链」）。
 * 六项都是二选一，都从 src/config/intent.json 的 intent.mode 热读；缺项用默认，绝不抛。
 *   webOkWho        'free' | 'agent'   老闸搜到了，这轮谁答
 *   webMissWho      'agent' | 'free'   老闸没搜到，谁去查
 *   dispatchPersona true | false       派活轮我成功，套不套 xuhbot 人设
 *   dispatchFail    'code' | 'free'    派活轮我失败，回代码兜底句还是交回免费模型
 *   chatPersona     true | false       聊天轮我自主派活成功，套不套人设
 *   chatFail        'code' | 'free'    聊天轮我失败，代码兜底还是走原有兜底流程
 *   webSources      true | false       通用网页搜索源开不开
 */
const AGENT_MODE_DEFAULT = {
  webOkWho: 'free', webMissWho: 'agent',
  dispatchPersona: false, dispatchFail: 'code',
  chatPersona: true, chatFail: 'code', webSources: true,
};
function agentMode() {
  let m = null;
  try {
    const c = require('./config');
    const live = (typeof c.cfgLive === 'function') ? c.cfgLive() : c.load();
    m = live && live.intent && live.intent.mode;
  } catch (e) { m = null; }
  const src = (m && typeof m === 'object') ? m : {};
  const pick = (k, ok, d) => (ok.indexOf(src[k]) >= 0 ? src[k] : d);
  return {
    webOkWho: pick('webOkWho', ['free', 'agent'], AGENT_MODE_DEFAULT.webOkWho),
    webMissWho: pick('webMissWho', ['agent', 'free'], AGENT_MODE_DEFAULT.webMissWho),
    dispatchPersona: src.dispatchPersona === true,
    dispatchFail: pick('dispatchFail', ['code', 'free'], AGENT_MODE_DEFAULT.dispatchFail),
    chatPersona: src.chatPersona !== false,
    chatFail: pick('chatFail', ['code', 'free'], AGENT_MODE_DEFAULT.chatFail),
    webSources: src.webSources !== false,
  };
}

/* 派活失败时的兜底句（可改，热读 src/config/intent.json 的 intent.agent.failText）。
 * 主人原话：「所有连接器的派活、调用，如果失败不用走模型，直接兜底句」「你查不到也直接兜底」。 */
const AGENT_FALLBACK_DEFAULT = '这个我没查到，等回头查到了再跟你说';
function agentFallbackText() {
  try {
    const c = require('./config');
    const live = (typeof c.cfgLive === 'function') ? c.cfgLive() : c.load();
    const t = String(((live && live.intent && live.intent.agent) || {}).failText || '').trim();
    return t || AGENT_FALLBACK_DEFAULT;
  } catch (e) { return AGENT_FALLBACK_DEFAULT; }
}

function agentPromptFromMessages(messages, withPersona) {
  const arr = Array.isArray(messages) ? messages : [];
  const sys = arr.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n\n').trim();
  const lines = arr.filter(m => m && m.role !== 'system' && !m.sowing).map(m => {
    const who = m.role === 'assistant' ? '你' : '对方';
    const body = String(m.content || '').trim();
    // 多行内容（合并消息 / 长图说明）的续行加「↳」：否则第二行没有说话人前缀，
    // 容易被当成另一个人新说的话（2026-11-23 真事：截图配文「你妈的」变成裸行）。
    const marked = body.split('\n').map((ln, i) => (i ? '  ↳ ' + ln : ln)).join('\n');
    return who + '：' + marked;
  }).filter(x => x && !/：$/.test(x));
  /* 多视角/思辨题（2026-11-25 主人要求「子agent工具各自调用人设」）：
   * 走到 dsh agent 的长思辨题，让它先派 2~3 个子 agent 各带人设分视角推，再由主 agent 合成一句话回。
   * 子 agent 的人设来源仍是 ~/.dsh/AGENTS.md → src/soul 那五份，不另建副本。 */
  const lastUser = (() => {
    const us = arr.filter(m => m && m.role === 'user');
    return us.length ? String(us[us.length - 1].content || '') : '';
  })();
  const multiView = lastUser.length >= 60
    && /(为什么|怎么理解|是不是|会不会|如果|假设|推理|真相|理论|观点|有没有|该怎么)/.test(lastUser)
    ? ['【这类题的做法】', '这是多视角/思辨题：先用 orchestrate 起 2~3 个子 agent，每个子任务的提示词里写明'
      + '「你按 ~/.dsh/AGENTS.md 的人设说话（没自动带上就先读这份文件），只负责这一个视角的分析，不要复述别人的观点」，'
      + '再由你把它们合成一句话回。子 agent 的人设和主 agent 是同一份，不要另编身份。']
    : [];
  const intro = withPersona
    /* 聊天轮（或派活轮设成要人设）：照 xuhbot 那套身份说人话 */
    ? ['【你的身份与规则】\n' + sys, '【最近的对话】\n' + lines.join('\n'),
       '【这一轮】', '按上面的身份和规则，回答最后那一句。需要查就用工具查完再答。',
       ...multiView,
       '只输出要发出去的那一句话：不要 markdown、不要代码块、不要复述过程。', '控制在 120 字以内。']
    /* 派活轮（默认）：只给任务和上下文，直给结果，不套腔调 */
    : ['【上下文】\n' + lines.join('\n'),
       '【任务】', '把最后那句要你查/要做的事办完，直接给结论。',
       '需要联网就先用工具搜，别猜。',
       ...multiView,
       '只输出要发出去的那一句话：不要 markdown、不要代码块、不要复述过程。',
       '控制在 120 字以内。'];
  return intro.filter(Boolean).join('\n\n');
}

async function askOnce(llm, model, messages, tries, forceThink, tag, convKey, maxTokensOverride, agentTurn, agentPersona, useTools, toolRound) {
  const n = tries || 1;
  let _toolOn = false;   // 2026-11-25：工具轮开关（在下面 body 构造处赋值，工具结果解析要用，必须提到函数作用域）
  const _uT0 = Date.now();
  const _k = String(convKey || '');
  _thinkK = _k;
  // 思考开关只在**第一次**取走（取一次就删），重试/降级时沿用这个结果，
  // 否则第一次把开关消费掉、重试那一轮又变回关思考，「让她想给我看」就白点了。
  const wantThink = (forceThink !== undefined) ? forceThink : (takeThinkRequest() || liveThinkOn());
  // 开思考必然慢：默认 6 秒是按「关思考」调的，开着思考 6 秒一定超时（实测直接超时）。
  // 这是主人手动点一次的动作，等久一点没关系。
  // 这个模型在 modelLimits 里点了名（本机 9b）→ 用它自己的超时，连开思考也按它的来；
  // 没点名 → 与原来完全一致（15 秒 / 30 秒）。
  const mLim = modelLimit(llm, model);
  const mLimMs = Number((mLim && mLim.timeoutMs) || 0);
  const toMs = wantThink
    ? Number((mLim && mLim.thinkTimeoutMs) || mLimMs || llm.thinkTimeoutMs || 30000)
    : Number(mLimMs || llm.timeoutMs || 6000);
  /* ===== 我（DSH agent）作为一个模型 =====（主人 2026-11-22 定）
   * 走到这里说明这一轮选中了我：把 bot 已经组好的 messages 整段交給 DSH agent，
   * 它返回的文本就当模型输出，后面照常走 polish / 输出闸 / replyTo。
   * 所以我和 llm.json 里的模型是同一个位置——人设、引用对象、上下文全部继承，
   * 不是另开一个「干活子 agent」。失败就抛错，callLLM 会自动落到下一个模型。 */
  if (String(model) === AGENT_MODEL) {
    const link = require('./agent-link');
    const _r = await link.runTask({
      text: agentPromptFromMessages(messages, agentPersona === true),
      sessionKey: _k || 'agent',
      timeoutMs: toMs,
      cwd: ROOT,
    });
    const _out = String((_r && _r.text) || '').trim();
    if (!_r || !_r.ok || !_out) {
      const _why = (_r && _r.reason) || 'empty';
      /* 主人 2026-11-22 定：**派活轮**（@+命中词+好感满，这一轮本来就该我干）失败不许落回免费模型，
       * 直接回兜底句——「所有连接器的派活、调用，如果失败不用走模型，直接兜底句」。
       * 我不出面、让别的模型接着编，比说一句「没查到」更糟。
       * 链尾兜底（agentTurn 为假，只是全链挂了才轮到我）维持原样抛错，交给原有兜底流程。 */
      const _m = agentMode();
      const _failMode = agentTurn ? _m.dispatchFail : _m.chatFail;
      if (_failMode === 'code') {
        const _fb = agentFallbackText();
        console.log('[派活] 我这边没成（' + _why + '）→ 直接回兜底句，不落回别的模型');
        return _fb;
      }
      console.log('[派活] 我这边没成（' + _why + '）→ 按设置交回免费模型');
      const e = new Error('[派活] dsh-agent ' + _why);
      e.busy = false;
      e.auth = false;
      e.timeout = !!(_why === 'timeout');
      throw e;
    }
    console.log('[派活] 这轮我出面（' + Number((_r && _r.ms) || 0) + 'ms，' + _out.length + ' 字）');
    return _out;
  }
  let r;
  try {
    // 思考型模型（GLM-4.7-Flash 就是）会把 token 先花在「内部思路」上，
    // max_tokens 给 600 的话思路还没写完就被截断 → 正文是空的 → 白等一轮再降级。
    // 所以默认给它关掉思考：实测同一句话，开思考烧了 1158 字还没出正文，关掉立刻出、还更快。
    // 例外（v79）：主人在面板点了「让她下一轮想给我看」→ 这一轮开思考、把原文存进「她的思考」页。
    const noThink = Array.isArray(llm.noThinkModels) && llm.noThinkModels.indexOf(model) >= 0;
    // 本机 9b 是真思考模型、且慢：600 token 会被思路吃光、正文空 → 单独给它放宽（modelLimits.maxTokens）。
    // 没点名的模型仍用 config.llm.maxTokens（600），一个字节都不改。
    // 2026-11-14 主人令：输出字数上限按会话可调（聊天记录页会话栏 ⚙「用默认」= 回到平台默认）。
    // 2026-11-17 主人令：默认字数跟随平台本身的限制，手填也不能超过它。
    //   平台默认 = platform-limits 里本平台 cap（QQ 会话用 qq.cap，B站会话取评论/私信里较大的那个，
    //   免得模型层先把字数卡死在低于发送层上限；真正的平台上限在发送层按各自 cap 精确裁）。
    //   优先级：会话 chars（夹到平台 cap）＞ 模型单独限制 modelLimits.maxTokens ＞ 平台默认 cap。
    const convCharsRaw = convSettings.charsOf(_k);
    const _plat = String(_k).indexOf('bili_') === 0 ? 'biliD' : 'qq';
    const _platCap = platLimits.capOf(_plat) || 600;
    const convChars = platLimits.clampChars(_plat, convCharsRaw);
    // 2026-11-17：后台任务（日记这种一次要写 300 字以上的）可以直接点名要多少额度。
    // 不点名就照原来走会话/平台默认，一个字不变 —— 她的设置优先级最高，但那是「聊天这条」的，
    // 日记不属于任何会话，用的是后台自己的额度。
    const mtAsk = Number(maxTokensOverride) || 0;
    const mtBase = mtAsk > 0 ? mtAsk
      : convChars > 0 ? convChars
      : Number((mLim && mLim.maxTokens) || _platCap);
    // 开思考时思路本身要吃额度，不能用 Math.max(1600, mtBase) 把它压住 —— 那样她填 300 会被悄悄抬到 1600，
    // 看着像「填了没用」。改成「她要的字数 + 1000 思考额度」：默认 600 时正好还是 1600，和原来一字不差；
    // 她往上调多少，正文就能写多少（2026-11-14 主人令：冲突时人的设置优先）。
    const thinkPad = wantThink ? 1000 : 0;
    const body = {
      model, messages,
      temperature: 0.9,
      max_tokens: mtBase + thinkPad,
    };
    if (noThink && !wantThink) body.thinking = { type: 'disabled' };
    /* 2026-11-25 工具调用（方案 1）：只有调用方明确要（opts.withTools）且开关开着才下发 tools。
     * 默认关：不开就一个字节都不变，与今天完全一致。 */
    const _toolCfg = readConfigFresh().toolCalling || {};
    // 2026-11-25：models 白名单接通（留空 = 不按模型限制）。弱模型（local-9b）在配置里排掉即可。
    const _toolModels = Array.isArray(_toolCfg.models) ? _toolCfg.models.filter(Boolean) : [];
    _toolOn = !!(useTools && _toolCfg.enabled === true
      && (!_toolModels.length || _toolModels.indexOf(String(model)) >= 0));
    if (_toolOn) {
      try {
        const _scene = String(_k || '').indexOf('bili_') === 0 ? 'bili' : 'qq';
        const _specs = require('./tools/registry').specs(_scene);
        if (_specs.length) { body.tools = _specs; body.tool_choice = 'auto'; }
      } catch (e) { console.log('[tools] 工具表读不出来，这一轮不带工具：' + e.message); }
    }
    if (wantThink) body.thinking = { type: 'enabled' };
    await llmSlot();                 // 排队 + 最小间隔，别并发撞 429
    // 2026-11-10：模型名若在 AstrBot 的池子里，就用那个源的地址与 Key；不在就原样用 llm.json 的。
    const conn = (typeof llm.route === 'function' && llm.route(model)) || null;
    r = await postJson(conn ? conn.endpoint : llm.endpoint, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${conn ? conn.apiKey : llm.apiKey}`,
    }, JSON.stringify(body), toMs);  } catch (e) {
    // 超时不再原地重试：这个模型卡住了就立刻换下一个，否则她一句话要等半分钟
    if (e.code !== 'ETIMEDOUT' && n < 2) { await sleepMs(400); return askOnce(llm, model, messages, n + 1, wantThink, tag, _k, maxTokensOverride); }
    const why = e.code === 'ETIMEDOUT' ? ('超时 ' + Math.round(toMs / 1000) + ' 秒') : (e.code || e.message);
    // 连不上也记一笔（ok:false）：这样「白等了几次、被限流几次」在花费账里看得见
    recordUsage({ scene: tag, model, ms: Date.now() - _uT0, ok: false, err: why, k: _k });
    const err = new Error(`LLM ${model} 连不上：${why}`);
    err.net = true;
    err.timeout = e.code === 'ETIMEDOUT';
    throw err;
  }
  const raw = r.text;
  if (r.status < 200 || r.status >= 300) {
    const busy = r.status === 429 || r.status >= 500 || /"code":"?1305"?/.test(raw);
    const auth = r.status === 401 || r.status === 403 || /"code":"?401"?/.test(raw);
    // 余额不足（智谱 1113）：不是「慢」，是这个模型压根没额度了 → 记进 hold 表，24 小时后自动回链
    const noBalance = /"code":"?1113"?/.test(raw) || /余额不足|欠费|insufficient|quota/i.test(raw);
    const err = new Error(`LLM ${model} ${r.status}: ${raw.slice(0, 160)}`);
    err.busy = busy && !noBalance;
    err.auth = auth;
    err.noBalance = noBalance;
    // 被限流先等 1.5 秒原地重试一次：以前一撞 429 立刻切备用，主模型明明还能用也被换掉了
    if (busy && !noBalance && n < 2) { await sleepMs(1500); return askOnce(llm, model, messages, n + 1, wantThink, tag); }
    // 被限流（429/1305）也要记：看得到「一天被拒了多少次」，才能判断是不是该拆 Key
    recordUsage({ scene: tag, model, ms: Date.now() - _uT0, ok: false, err: busy ? '限流' : (auth ? 'Key 被拒' : 'HTTP ' + r.status), k: _k });
    throw err;
  }
  let data; try { data = JSON.parse(raw); } catch { throw new Error('LLM 返回不是 JSON'); }
  // 记账：接口每次都会返回 usage（输入/输出 token），以前这段被整个丢掉了
  const _u = data.usage || {};
  recordUsage({ scene: tag, model, in: _u.prompt_tokens, out: _u.completion_tokens, total: _u.total_tokens, cache: usageCached(_u), ms: Date.now() - _uT0, ok: true, k: _k });
  const msg = data.choices?.[0]?.message || {};
  /* 工具调用轮（2026-11-25）：模型要调工具就先执行、把结果作为 role:tool 回喂，最多 2 轮。
   * 工具失败也只回喂结果，不抛错、不假装成功（dispatch 已保证 ok:false 带原因）。 */
  if (_toolOn && Array.isArray(msg.tool_calls) && msg.tool_calls.length && (Number(toolRound) || 0) < 2) {
    const disp = require('./tools/dispatch');
    const calls = msg.tool_calls.slice(0, 4);
    const toolMsgs = [];
    for (const c of calls) {
      const fn = (c && c.function) || {};
      const r = await disp.run({ name: fn.name, arguments: fn.arguments }, { scene: String(_k || '').indexOf('bili_') === 0 ? 'bili' : 'qq', uid: String((_k || '')).replace(/^\w+_/, ''), model });
      console.log('[tools] ' + fn.name + ' → ' + (r.ok ? 'ok' : '失败：' + r.error));
      toolMsgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r).slice(0, 1500) });
    }
    const msgs2 = messages.concat([{ role: 'assistant', content: '', tool_calls: calls }], toolMsgs);
    return askOnce(llm, model, msgs2, n, wantThink, tag, _k, maxTokensOverride, agentTurn, agentPersona, useTools, (Number(toolRound) || 0) + 1);
  }
  const content = String(msg.content || '').trim();
  // 思考原文（模型自己给的 reasoning_content，原样存，不改一个字）
  const reason = String(msg.reasoning_content || msg.reasoning || '').trim();
  if (reason) recordThinking(model, reason, content, messages);
  else if (wantThink) recordThinking(model, '', content, messages, '这一轮开了思考，但 ' + model + ' 没给思考内容（这个模型可能不支持思考）');
  // 给「每条发言的推理过程」用：只记这次真实调用的事实，不推测
  // inTok/outTok 一起带出来：聊天记录里「虚幻每句话旁边」就显示这一笔的真实用量（不是估算）
  _lastLlmCall = { t: Date.now(), model, reason, ms: Date.now() - _uT0,
    inTok: Number(_u.prompt_tokens) || 0, outTok: Number(_u.completion_tokens) || 0 };
  return content;
}

// 开机自检：DNS + 能不能连到接口。这一步不发问句，不花 token
async function netCheck() {
  const llm = llmCfg();
  // 2026-11-11（修）：AstrBot 模式下 llm.endpoint 为空，用主模型的真实 endpoint 探测，
  // 否则 new URL('') 抛「接口地址不对」误报。
  const probeEp = llm.endpoint || (typeof llm.route === 'function'
    ? ((llm.model && (llm.route(llm.model) || {}).endpoint)
       || ((llm.astrbotModels || [])[0] && (llm.route(llm.astrbotModels[0].model) || {}).endpoint) || '')
    : '');
  let host = 'open.bigmodel.cn';
  try { host = new URL(probeEp).host; } catch {}
  const ip = await resolveHost(host);
  if (!ip) {
    console.log('[net] ⚠ ' + host + ' 解析不了（系统 DNS 和公共 DNS 都查不到）');
    console.log('[net]    先试试换 DNS 为 223.5.5.5 / 119.29.29.29，或关掉代理软件');
    return;
  }
  console.log('[net] ' + host + ' → ' + ip);
  try {
    const r = await postJson(probeEp, { 'Content-Type': 'application/json' }, '{}', 8000);
    console.log('[net] 已连通（HTTP ' + r.status + '，这个探测不花 token）');
  } catch (e) {
    const why = e.code === 'ETIMEDOUT' ? '超时 8 秒' : (e.code || e.message);
    console.log('[net] ⚠ 连不上 ' + host + '：' + why);
    console.log('[net]    常见原因：① 代理/VPN 只接管了浏览器 → 关掉它，或开 TUN/全局');
    console.log('[net]              ② 防火墙拦了 node.exe → 放行');
    console.log('[net]              ③ 这网络本身出不了外网 → 换手机热点试一下');
  }
}

// 主模型被限流时先冷却一阵，这段时间直接走备用，省掉一次白跑的往返
// 冷却到期后不额外发探测请求——下一次真实对话就先试主模型，成功即用它的回答
let primaryCoolUntil = 0;
let primaryFailStreak = 0;
// 本地模型优先模式专用：本地服务断连时先歇 60 秒直接走正常链，到期下一次真实对话自动试回本地。
// 和上面分开存，是为了本地挂掉时不会把「全部模型」模式的主模型也一起跳过。
let localLeadCoolUntil = 0;
/* 我（DSH agent）作为一个「模型」进链（主人 2026-11-22 定）：
 * askOnce 里拦这个名字，改走 agent-link；链序见 callLLM 开头的注释。 */
const AGENT_MODEL = 'dsh-agent';
let agentCoolUntil = 0;   // 我失败后的短冷却（60 秒），不进 modelHold 的 24 小时摘链

// 余额不足的模型踢出链条，到点自动加回来（主人 2026-11-01 定：余额不足就踢，一天过后自动加回来）
// 存的不是「黑名单」，是「解禁时间戳」：读的时候比一下 Date.now()，过期就自动回链——
// 不需要定时任务，也不需要人工删，重启、断电都不影响。
const MODEL_HOLD_PATH = path.join(ROOT, 'data', 'model-hold.json');
function modelHoldRead() {
  try {
    const j = JSON.parse(fs.readFileSync(MODEL_HOLD_PATH, 'utf8')) || {};
    const now = Date.now(), out = {};
    for (const k of Object.keys(j)) { const t = Number(j[k]); if (t > now) out[k] = t; }
    return out;
  } catch { return {}; }
}
function modelHoldWrite(next) {
  try {
    fs.mkdirSync(path.dirname(MODEL_HOLD_PATH), { recursive: true });
    fs.writeFileSync(MODEL_HOLD_PATH, JSON.stringify(next, null, 1) + '\n', 'utf8');
  } catch (e) { console.log('[llm] 写 model-hold 失败：' + e.message); }
}
function modelHoldAdd(model) {
  const hours = Number(llmCfg().noBalanceHoldHours || 24);
  const hold = modelHoldRead();
  const until = Date.now() + hours * 3600000;
  if (hold[model] && Math.abs(hold[model] - until) < 60000) return;   // 同一轮别反复提醒
  hold[model] = until;
  modelHoldWrite(hold);
  console.log('[llm] ' + model + ' 余额不足 → 摘出备用链 ' + hours + ' 小时（' + new Date(until).toLocaleString('zh-CN') + ' 自动回链）');
  noteFail('模型余额不足', model + ' 提示余额不足，已从备用链里摘掉，' + hours + ' 小时后自动加回来。这期间回复走其他模型');
}

// 降级时对「数值题」加一道闸（2026-11-02，主人定）
// 起因：主模型 glm-4.5-flash 频繁超时 → 换成 glm-4-flash-250414，它对宝可梦数值记得一塌糊涂，
// 却照样给死数字（烈空坐种族值 780 说成 701、无极巨化无极汰那 1125 说成 634，连自己列的 5 项加起来 555 都没发现）。
// 策略：被降级 + 问的是具体数值 + 这次又没搜到资料 → 明确要求它说「记不准」，别硬编一个数。
const NUM_ASK = /(种族值|多少|几+|数值|加起来|总和|合计|总和|身高|体重|攻击|防御|血量|价格|面积|排名|第几|几个|几种|概率|胜率|比例|百分之)/;
/* 例外（2026-11-19 修）：问「我QQ号是多少」「我住哪」这类**人物信息**，答案就写在提示词的
 * 「现在跟你说话的是谁 / 你认得的人」里，不是靠模型记数值——不能被这道闸拦成「记不准」。
 * 真事：Ayami 私聊问自己的号，降级模型命中「多少」→ 直接答「这个数我记不准」，
 * 主人当场质问「也可以给本人私聊，你到底有没有读懂规则」。 */
const PRIV_ASK = /(QQ|qq|Q)\s*号|号\s*(是)?多少|住哪|住哪儿|地址|所在地|哪个号/;
const WHO_ASK = /我|自己|你|他|她|对方|主人/;
function withNumGuard(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const lastUser = messages.slice().reverse().find(x => x && x.role === 'user') || {};
  const q = typeof lastUser.content === 'string' ? lastUser.content : '';
  if (!NUM_ASK.test(q)) return messages;
  if (PRIV_ASK.test(q) && WHO_ASK.test(q)) return messages;   // 号 / 住址走隐私铁律，不归数值闸
  // 已经搜到真结果了 → 数字有出处，正常答（别把查到的结果也挡掉）
  // 注意：搜了个空时 core 也会塞一条「以下是刚联网搜到的网页摘要」，那条里没有【1】，所以按有没有结果判，不按标题判
  if (messages.some(x => x && x.role === 'system' && /【1】/.test(String(x.content || '')))) return messages;
  return messages.concat([{
    role: 'system',
    content: '（这一轮你的模型被降级了，你对具体数字记得很不准。）问的要是具体数字/数值：**不许给具体数字**，'
      + '直接说「这个数我记不准」，最多讲个大概方向（谁更强、大概排第几档）。'
      + '编一个数比说不知道糟糕一百倍。',
  }]);
}

// 主模型失败自动切备用链（全部免费款）
// opts.preferFallback（2026-10-22 速度优化）：后台整理类调用（记忆抽取/口味抽取/风格总结/日记）
// 主动把主模型排到最后——它们不直接面对等待的人，别和正经回复抢主模型的配额：
// 主模型一旦被这些大请求打到 429 限流，接下来 30 秒~5 分钟所有回复都被迫走备用模型，明显变慢。
async function callLLM(messages, opts) {
  const llm = llmCfg();
  // 场景标签（v80）：谁调的就贴谁的标签，面板「花费账」按它排行——回复/重说/日记/记忆各花多少一眼看清
  const _tag = (opts && opts.tag) || 'other';
  // 2026-11-11（修）：AstrBot 接入后真实 Key 在 AstrBot 配置里、按模型 route() 取出，
  // llm.json 的 apiKey 本来就该是空。所以「没 Key」要看 AstrBot 有没有可用路由，
  // 不能只看 llm.json 的 apiKey —— 否则清了 llm.json 的 Key 就全盘拒答（之前就这样）。
  const _keySet = !!llm.apiKey && !llm.apiKey.includes('在这里填');
  const _astrbotLive = typeof llm.route === 'function' && Array.isArray(llm.astrbotModels) && llm.astrbotModels.length > 0;
  if (!_keySet && !_astrbotLive) throw new Error('NO_KEY');
  const _hold = modelHoldRead();
  // 2026-11-12：按会话「本地模型优先」（原「只由本地模型发言」，主人 11-12 令改）。
  // conv 键带进来时看这个会话的设置：设了 local 就把本地模型排到模型链最前，
  // 后面照接正常链 —— 本地服务断连 / local 源没配好时，云端模型接着应答，不会没模型可用。
  // 另一个模式（没设 = 全部模型，按正常优先级排序）一行不动。
  // 视觉 / 后台类调用不带 key → 走正常链，不受影响。
  const convKey = (opts && opts.key) || '';
  // 2026-11-19：审查词守卫——本轮输入命中主人自填的审查词 → 这一轮临时把本地模型排链首，
  // 让本地模型先答（它不触发联网模型的那套审查/拒答）。这是一次性判定：不写 conv-settings.json、
  // 不改会话的持久开关；本地断连 / 没配好时下面照常回落到正常模型链，不会因此哑火。
  const _censorHits = censorGuard.hit(censorGuard.pickUserText(messages));
  const _censorTurn = _censorHits.length > 0;
  if (_censorTurn) console.log('[censor] 本轮命中审查词（' + _censorHits.join('、') + '）→ 本轮临时本地优先（不改会话设置）');
  const localFirst = !!((convKey && convSettings.get(convKey).model === 'local') || _censorTurn);
  const localModels = localFirst
    ? astrbotLlm.list().filter(x => x.source === 'local').map(x => x.model).filter(Boolean)
    : [];
  const normalChain = [llm.model, ...(llm.fallbackModels || [])].filter(Boolean)
      .filter(m => !_hold[m]);             // 余额不足被摘掉的先跳过（到期自动回链，见 modelHoldRead）
  // 本地服务断连时别每句都白等一次超时：单独记本地冷却，不碰全局主模型冷却
  const localReady = localModels.length > 0 && Date.now() >= localLeadCoolUntil;
  const localLead = localFirst && localReady;   // 本地这一轮确实排链首
  const all = localLead
    ? localModels.concat(normalChain).filter((m, i, a) => a.indexOf(m) === i && !_hold[m])
    : normalChain;
  if (localFirst && !localModels.length) {
    console.log('[llm] 这个会话设了本地优先，但 astrbot 里没有可用的本地模型（local 源没配好？）→ 这一轮走正常模型链');
  } else if (localFirst && !localReady) {
    console.log('[llm] 本地模型刚断连，冷却中先走正常链（到期自动试回本地）');
  }
  const primary = localLead ? localModels[0] : llm.model;
  // 思考开关在整条模型链上只取一次：主模型 429 换备用时，不能被当成「没点过」
  // 2026-11-11：常开思考（chat 页下方「实时思考」开关）也走这里，关掉就一个 token 都不花
  // 后台类调用（兜底词池自动补齐等）传 noThink：不消费她点的「想给我看」，也避开常开思考的 30 秒超时。
  const wantThink = (opts && opts.noThink) ? false : (takeThinkRequest() || liveThinkOn());
  // 主人点了「让她想给我看」→ 换成一组实测真的会给 reasoning_content 的模型先试，
  // 否则一定落到不支持思考的备用模型上，正文有了、思考是空的，等于白点。
  // 实测（2026-10-23）：glm-4.5-flash / glm-4.5-air 开 thinking 都正常给思考；
  // glm-z1-flash 把思考写在正文的 <think> 标签里（不是 reasoning_content），所以不用它。
  const thinkModels = Array.isArray(llm.thinkModels) ? llm.thinkModels : [];
  const cooling = !wantThink && Date.now() < primaryCoolUntil;
  // 本地优先会话链首是本地模型：全局主模型冷却要按 llm.model 摘，别把本地摘掉
  let models = cooling ? all.filter(m => m !== (localLead ? llm.model : primary)) : all;
  // 云端思考模型会插到最前，本地优先会话不注入，否则「本地优先」被盖掉（原 local 模式同样跳过）
  if (wantThink && thinkModels.length && !localFirst) {
    models = thinkModels.concat(models).filter((m, i, a) => a.indexOf(m) === i);   // 加思考模型，放最前面
  }
  if (opts && opts.preferFallback) {
    models = models.slice().sort((a, b) => (a === primary) - (b === primary));   // 主模型垫底
  }
  /* ===== 我（DSH agent）在模型链里的位置（主人 2026-11-22 定）=====
   * 两条表（正常链 + 思考链，上面已合成一条 models）都把我放在**最末尾**当兜底：
   *   · 其他模型只是「卡住」时照旧先用它们，这一轮用完就回到原序，不会一直占着链首；
   *   · 只有全链都失败（额度耗光 / 本地也繁忙）才会落到我，哪怕这句不是活；
   *   · 真活（@ + 命中词表）时临时插到链首，只此一轮（agentTurn）。
   * 我刚失败过就冷却 60 秒，冷却期内不往队尾塞，免得每句都白等一次长超时。 */
  models = models.filter(m => m !== AGENT_MODEL);
  {
    const _m = agentMode();
    let _useAgent = false;
    /* messages._webMissAgent = 老闸联网查了个空、又被 @ / 私聊点名的轮：
     * 和派活轮走同一套链序（搜到按 webOkWho，没搜到按 webMissWho），
     * 这样「查不到就自动转成我」不再被 chat() 里的 return 截掉。 */
    if ((opts && opts.agentTurn) || messages._webMissAgent) {
      // 2026-11-23 主人改「高好感 @ 优先喊出 dsh agent」：派活轮（真活）无条件让 agent 出面，
      // 不再被 webOkWho='free' 拦回免费模型。原来这里搜到了就按 webOkWho=free 退回 glm 瞎答
      // （事故：「你触发什么关键词了」搜到一堆 App Store 触发词摘要 → 免费模型照着编）。
      // webOkWho 现在只管「没派活的轮 + 老闸搜空被@」那支（_webMissAgent），不再管真活。
      const _webOk = !messages._webNoResult;
      if (opts && opts.agentTurn) {
        _useAgent = true;                                   // 真活：人点名喊的，agent 必须出面
        console.log('[派活] 高好感@派活轮 → agent 出面（绕过 webOkWho=' + _m.webOkWho + '）');
      } else {
        _useAgent = (_webOk ? _m.webOkWho : _m.webMissWho) === 'agent';
        if (!_useAgent) console.log('[派活] 这轮按设置交给免费模型（' + (_webOk ? '老闸搜到了' : '老闸没搜到+设置是免费不查') + '）');
      }
    }
    if (_useAgent) models.unshift(AGENT_MODEL);
    else if (Date.now() >= agentCoolUntil) models.push(AGENT_MODEL);
  }
  let lastErr = null, allBusy = true, allAuth = true;
  for (const m of models) {
    try {
      const msgs2 = (m === primary) ? messages : withNumGuard(messages);   // 降级时数值题加闸
      const _isAgentTurn = !!(opts && opts.agentTurn) || !!messages._webMissAgent;
      const _persona = _isAgentTurn ? agentMode().dispatchPersona : agentMode().chatPersona;
      const ans = await askOnce(llm, m, msgs2, 1, wantThink, _tag, convKey, (opts && opts.maxTokens) || 0, _isAgentTurn, _persona, !!(opts && opts.withTools), 0);
      if (ans) {
        // 本地优先会话的本地是链首、不是全局主模型：它成功也别动另一个模式的冷却状态
        if (m === primary) { if (!localLead) { primaryFailStreak = 0; primaryCoolUntil = 0; } }   // 主模型回来了，立刻恢复
        else console.log(`[llm] 已切到 ${m}`);
        return ans;
      }
      lastErr = new Error(`${m} 返回空内容`);
      allBusy = false; allAuth = false;
    } catch (e) {
      lastErr = e;
      if (!e.busy) allBusy = false;
      if (!e.auth) allAuth = false;
      if (e.noBalance) { allBusy = false; allAuth = false; modelHoldAdd(m); }   // 没额度了：摘出链条，24 小时后自动回来
      console.log(`[llm] ${e.message}`);
      // 我（dsh-agent）失败：只短冷却 60 秒，绝不进 modelHold 那套 24 小时摘链。
      // 主人原话：「其他模型有可能只是卡住…要切回去用，不要一直用你」→ 反过来我也一样，一分钟后就再试。
      if (m === AGENT_MODEL) {
        agentCoolUntil = Date.now() + 60000;
        console.log('[派活] 我这轮没成，60 秒内先让其它模型顶着（到期自动再试）');
      }
      // 主模型被限流：冷却时间指数退避（30s → 60s → … 最多 5 分钟），期间直接走备用
      // 主模型挂住不回（不是限流）：也要先歇一分钟，别每句都白等 10 秒
      if (m === primary && e.timeout) {
        if (localLead) {
          localLeadCoolUntil = Date.now() + 60000;
          console.log('[llm] 本地模型卡住了，60 秒内先走其它模型（到期自动试回本地）');
        } else {
          primaryCoolUntil = Date.now() + 60000;
          console.log('[llm] ' + primary + ' 卡住了，60 秒内先走备用');
        }
      }
      if (m === primary && e.busy) {
        if (localLead) {
          localLeadCoolUntil = Date.now() + 60000;
          console.log('[llm] 本地模型忙碌，60 秒内先走其它模型（到期自动试回本地）');
        } else {
          primaryFailStreak++;
          const wait = Math.min(300000, 30000 * Math.pow(2, primaryFailStreak - 1));
          primaryCoolUntil = Date.now() + wait;
          console.log(`[llm] ${primary} 忙碌，${Math.round(wait / 1000)} 秒内先走备用；到期后下一次真实对话自动试回主模型（不额外消耗 token）`);
        }
      }
    }
  }
  if (allAuth) {                              // 每个模型都 401/403 → 是 Key 或账号的问题，不是网络
    const e2 = new Error('AUTH');
    e2.detail = String((lastErr && lastErr.message) || '').slice(0, 160);   // 留着给诊断报告用（比如 1220）
    // v76：Key / IP 白名单这类问题，主人不盯后台也能在面板「虚幻自查」页看到
    noteFail('模型用不了', '所有模型都拒绝了（多半是 Key 或 IP 白名单的问题）：' + e2.detail + '。跑 node selfcheck.js --why 能看到怎么治');
    if (wantThink) recordThinking('', '', '', messages, '这一轮开了思考，但模型全都拒绝用：' + e2.detail);
    throw e2;
  }
  if (allBusy) {
    noteFail('模型被限流', '主模型和备用模型都被限流了，这阵子的回答会慢或者哑火。等 1~3 分钟自己会好');
    if (wantThink) recordThinking('', '', '', messages, '这一轮开了思考，但模型全被限流了，没等到回答');
    throw new Error('BUSY');
  }
  noteFail('模型全都答不上来', String((lastErr && lastErr.message) || 'LLM 全失败').slice(0, 200));
  if (wantThink) recordThinking('', '', '', messages, '这一轮开了思考但没成功：' + String((lastErr && lastErr.message) || '').slice(0, 120));
  throw new Error(lastErr ? lastErr.message : 'LLM 全失败');
}

// 省略号硬规则（主人 2026-10-20 定）：
// 正经回答里一个「...」都不许有；只有紧跟「呜呜呜/QAQ/哭」的省略号才留，且整句最多 3 个
// 笑声规则（主人 2026-10-21 定）：只说「嘻嘻」，不说「嘿嘿」；嘻嘻 / 嘻嘻！ / 嘻嘻。 / 嘻嘻～ 都行
// 攻略数据的回答连笑声都不许有，只给结论（按会话记，避免两个群同时说话串味）
const guideTurns = new Set();
// 这一轮是不是「对方发的是梗」：用来在模型不听话时兜底改口
const memeTurns = new Set();
// 笑点解析（主人 2026-10-22 定）：这一轮是解析任务，答案结尾必须带「令人忍俊不禁喵」
const xiaodianTurns = new Set();
// 解析格式范例（主人 2026-10-22 亲手写的标准答案，格式口吻都照它学）；文件可改，改完即生效
const XIAODIAN_PATH = path.join(ROOT, 'data', '笑点解析范例.md');
// 笑点解析词表（主人 2026-11-22 定：术语和说法都要有清单，且分「已验/待验」，AI 不许自己猜）
// 术语表 = 喜剧术语（相声/脱口秀/网络梗）；说法表 = 梗式说法；场景对照 = 哪档用哪几个。
const XD_TERM_PATH = path.join(ROOT, 'data', '笑点解析术语表.md');
const XD_TALK_PATH = path.join(ROOT, 'data', '笑点解析说法表.md');
const XD_SCENE_PATH = path.join(ROOT, 'data', '笑点解析场景对照.md');
const XD_FUNNY_PATH = path.join(ROOT, 'data', '一本正经的搞笑范例.md');
const XD_SLOGAN = '令人忍俊不禁喵';
// 只禁两样：机器人腔（客服口气）和造假（没查到却写出处）。术语/元叙述一个都不禁。
const XD_BAN_WORDS = ['希望有帮助', '这是我的任务', '我会好好分析', '作为一个人工智能', '主人～'];
// 「照格式不解析」的典型空话（主人 2026-11-24 定：说出谁把哪句原话当成什么才算解析）。
// 只收纯标签式收尾；「笑点在错位／荒诞因果」这类说清机制的写法不在此列。
const XD_HOLLOW = ['笑点在于', '正是笑点所在', '这才是笑点', '妙就妙在', '精髓在于', '说白了就是好笑'];
// 这一轮命中的梗是哪一节、「怎么接」原文和示范句（面板里改了立刻生效）
const memeTurnInfo = new Map();
// 「原文梗」内容不全（主人 2026-10-22 定）：这一轮要背的完整原文——不经模型、一个字不改
const fullTextTurns = new Map();
// 这一轮对方在累/难受/撒娇：回答要是像客服，就照着示范重说一次
const moodTurns = new Set();
// 这一轮对方在嫌我蠢（截图真事 2026-10-22：主人说「怎么感觉有点蠢」，它却回「主人是不是累了」）
const criticTurns = new Set();
// 认错池：只在「被嫌蠢却答成关心/解释」时才用
const CRITIC_LINES = ['呜…对不起，是我刚才犯蠢了', '是我不好，刚才那句当我没说', '呜…别嫌我蠢嘛，我认错', '对不起嘛…我重新说就是了', '呜…我的我的，刚那是我笨'];
// 这一轮主人在锐评（「X 是这样的」）：只许附和一句，长了就裁
const commentTurns = new Set();
// 附和池：只在「重说还是复述」时才用（正常情况让它自己说）
const COMMENT_LINES = ['还真是', '确实', '说得对', '果然', '早说了', '不然呢', '一点都不意外', '我就知道', '我信了', '就这德行'];
// 被群友吐槽时的兜底：只在「答成撒娇/道歉」时才用
const BANTER_LINES = ['那咋了？', '我们乐意', '嫉妒就直说', '急了？', '你管得着吗', '眼红了？'];
const banterTurns = new Set();
function banterFallback(k) {
  const said = getHist(k).filter(isSpeech).slice(-6).map(m => m.content);
  const pool = BANTER_LINES.filter(x => !said.some(c => similarText(c, x)));
  const list = pool.length ? pool : BANTER_LINES;
  return list[Math.floor(Math.random() * list.length)];
}
function commentFallback(k) {
  const said = getHist(k).filter(isSpeech).slice(-6).map(m => m.content);
  const pool = COMMENT_LINES.filter(x => !said.some(c => similarText(c, x)));
  const list = pool.length ? pool : COMMENT_LINES;
  return list[Math.floor(Math.random() * list.length)];
}
// 这一轮是「没人叫她，她自己想搭一句」：像群里人顺手接话头，不是客服
const chimeTurns = new Set();
// 这一轮是「接着话题说」：没人 @ 她，但群里的对话她刚参与过、话题还连着（主人 2026-10-22）
const topicTurns = new Set();
// 合格的接话题：一句话、不长、不提问、不自称机器人、不旁观
// 【分类 F·全场景通用｜分场景选择注入】话题/凑热闹质量闸：判定文本够不够格进对应功能。
function topicOk(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.length > 60) return false;
  if (/[？?]\s*$/.test(t)) return false;
  if (/(有什么可以帮|我可以帮你|我是.{0,4}(机器人|AI|助手)|请问|建议你|你们说|大家说)/.test(t)) return false;
  return true;
}
// 合格的搭话：不提问、不自称机器人、不旁观式地「你们」、不长篇
function chimeOk(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.length > 45) return false;
  if (/[？?]\s*$/.test(t)) return false;
  if (/(有什么可以帮|我可以帮你|我是.{0,4}(机器人|AI|助手)|请问|建议你|你们|大家)/.test(t)) return false;
  return true;
}
// 认出是梗却还是去共情 / 夸他写得好 / 说看不懂 / 背梗 / 解释梗 → 判为跑偏
// 「这是XX的梗」「这是一种强行类比」「越离谱越好笑」这类都是在解释，不是在接
const BAD_MEME_REPLY = /(我看不懂|我是文盲|看不明白|看不懂|不明白|不懂|好难过|好可怜|太感人|好厉害|好棒|好强|好精彩|写得真好|好恐怖|好可怕|记不清|好开心|主人今天|虚幻好|这是.{0,14}梗|这是一种|这就是所谓|强行类比|硬凑|越离谱越好笑|的梗$)/;
// 结构识别出的每种梗，它的「构式」是什么——让模型按构式造新的，而不是乱编
const MEME_PATTERNS = {
  '乐子人钓鱼文': '第一人称炫耀自己挖了坑、看别人吵架。可以顺着装成上当的路人，也可以点破他就是那个挖坑的。',
  '复读刷屏': '同一句重复很多遍。别数遍数，一句「听到了」就完；也可以只回一两字，用冷淡吐槽。',
  'emoji 发疯文学': '歌词打碎 + 满屏表情。吐槽对方的音响/脑子在放歌，别接着唱、别逐句分析。',
  '「A是B」强行类比': '把 X 硬说成 Y（炸蘑菇=高温杀菌）。**再照这个格式造一个**：换对象、换领域，格式不变，要比他更荒唐。',
  '复制粘贴长文': '很长很正经、最后一句才是包袱。认输——承认自己看完了、上当了；或者只抓最后那句的关键词。',
  '求解读的怪谈': '讲了一件来历不明的离奇事，最后问「什么意思」。别真去解释、别编出处；可以顺着它的怪劲编得更怪，或者老实说这个我也没见过。',
};
// 梗库没命中时的通用兜底（尽量不带情绪、不训人）
// 注意：这些只是「两次都说不出来」时最后的垫片，正常情况不许走到这里
const MEME_LINES = [
  '行行行，你赢了',
  '我居然真的看完了，我认输',
  '啊？这手是冲我来的吧',
  '我选择装死',
  '你这一手太脏了',
  '我服了',
  '这逻辑我追不上',
  '好，你说得对',
  '我竟然无法反驳',
  '我选择沉默',
  '我真的会谢',
  '你这个我接不住',
];
// 兜底：优先用梗库里主人自己写的那句示范，实在没有才用通用池
// avoidDemo=true 时说明「刚才是照抄了示范」，这次必须避开示范句
function memeFallback(k, avoidDemo) {
  const said = getHist(k).filter(isSpeech).slice(-6).map(m => m.content);
  const info = memeTurnInfo.get(k);
  const demo = (info && info.ex) || [];
  const base = (avoidDemo || !demo.length) ? MEME_LINES.slice() : demo.concat(MEME_LINES);
  const ok = base.filter(x => !said.some(c => similarText(c, x)) && !echoDemo(x, demo));
  const pool = ok.length ? ok : MEME_LINES.filter(x => !said.some(c => similarText(c, x)));
  const list = pool.length ? pool : MEME_LINES;
  // 随机挑一句：固定取第一句会让每次都是同一个答案
  return list[Math.floor(Math.random() * list.length)];
}
// 硬限制由代码判（主人 2026-11-09 定【4】：「如果是硬限制就上代码，不要用提示词费token。」）
// 本轮事实、身份白名单本来就是代码算出来的，先前却写成「不许说…」的提示词禁令让模型自己守。
// 现在提示词只留事实，这句「不许」由 chat() 发出前的闸门保证；不占每轮 token。
function hardLimitHit(ans, f) {
  const s = String(ans || '');
  if (!s || !f) return false;
  // 身份话两个白名单分支都不许说出口 → 无条件判
  if (/我就是主人|我和主人是同一个人|我和主人同一个人|这一轮你和主人是同一个人|你＝[^，。]{0,12}＝主人/.test(s)) return true;
  if (!f.atMeReal && /(?:@|艾特)(?:了)?(?:我|你)|(?:@|艾特)了主人/.test(s)) return true;
  if (!f.replyMe && /引用(?:了)?(?:我|你)|@了你、引用了你/.test(s)) return true;
  return false;
}

// 提示词泄漏（主人 2026-11-23 定）：模型把注入的 system 段当成回复原样吐出来。
// 真事：13:05 群 1067322036，备用模型照抄了短期记忆块整段发出去
// （「【Kaze_】\n- 11-23 05:03［群…］…」）。判据只认这段独有的硬特征，不碰正常聊天：
//   ① 短期记忆块头（「待回复的人最近还说过」「翻旧账时用」）
//   ② 至少两条「- MM-DD HH:MM［群…］」行（聊天里人不会这么写）；或一条该格式行 + 一个【名字】块头
// 由 chat() 的发送前闸门处理：命中→重说一次，仍命中→不发。不占每轮 token（硬限制，代码判）。
function promptLeakHit(ans) {
  const s = String(ans || '');
  if (!s) return false;
  if (/待回复的人最近还说过|翻旧账时用|短期记忆[:：]/.test(s)) return true;
  const lines = s.split('\n').filter(l => /^\s*-\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*［群/.test(l));
  if (lines.length >= 2) return true;
  if (lines.length >= 1 && /【[^】\n]{1,20}】/.test(s)) return true;
  return false;
}

function polish(ans, k) {
  let s = String(ans || '');
  const isGuide = k ? guideTurns.delete(k) : false;
  if (!s) return s;
  // 2026-11-23 主人令：拦 LLM 把「思考/自我分析」当正文提交。
  // 实测事故（glm-4.5-flash）：正文在前、后面跟 </think>分析…</think>正文，整段被发进群。
  // 顺序：先删成对 <think>…</think>（标准格式留正文）；再在第一个裸 </think> 处截断只留前面。
  // 只在这里 clean 发出去的正文——thinking.jsonl 的原始存档在 askOnce 已写，不受影响。
  s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
  const _thinkCut = s.indexOf('</think>');
  if (_thinkCut >= 0) {
    s = s.slice(0, _thinkCut);
    console.log('[polish] 拦下 </think> 后面的思考/分析，只发前面正文（原长 ' + String(ans || '').length + '）');
  }
  s = s.replace(/<\/?think[^>]*>/gi, '').trim();   // 残留的单标签也清掉
  if (!s) return s;
  // 身份铁律兜底（真人真事 2026-10-22：主人纠正「你是虚幻，不是大饮尽酱」，她回「我是大饮尽酱呀！」）
  // 前面是「不」的不动（「我不是大饮尽酱」是对的）
  s = s.replace(/我就?是(大饮尽酱?|大肥鱼|元囮|德川|锡兰)/g, '我是' + (cfg.botName || '虚幻'))
       .replace(/叫(我|人家)(大饮尽酱?|大肥鱼|元囮|德川|锡兰)/g, '叫我' + (cfg.botName || '虚幻'));
  /* 名字覆盖兜底（2026-11-25，窄范围）：状态里改了名字，模型偶尔还按默认名自称。
   * 只改「我 / 人家 + 是/叫 + 默认名」这种自称句；「主人是虚幻」这种以主人作主语的句子一个字不动。
   * 没有名字覆盖时整段跳过（零回归）。 */
  if (k) {
    try {
      const _c = getTurn(k);
      const _nm = convState.nameOfTurn(convState.whoListForTurn(_c && _c.gid, whoUidOf(_c)));
      const _def = cfg.botName || '虚幻';
      if (_nm && _nm.name && _nm.name !== _def) {
        const _esc = _def.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
        const _lead = '(^|[，。！？、；：\\s~～])';
        s = s.replace(new RegExp(_lead + '((?:我|人家)(?:就|才|可)?是)(「?)' + _esc + '(」?)', 'g'),
          (m, pre, verb, l, r) => pre + verb + l + _nm.name + r);
        s = s.replace(new RegExp(_lead + '(叫我|我(?:就)?叫)(「?)' + _esc + '(」?)', 'g'),
          (m, pre, verb, l, r) => pre + verb + l + _nm.name + r);
      }
    } catch {}
  }
  // 「主人」是称呼，不是名字（主人 2026-10-23 定）：
  // 真事——群友问「你的主人叫？」，她答「主人的名字是主人呀～」。
  // 主人的名字和它同名，就是「虚幻」。
  {
    const bn = cfg.botName || '虚幻';
    s = s.replace(/((?:我)?主人)(?:的)?名字(?:就)?是\s*主人(?:呀|啊|哦|呢)?/g, (m, who) => who + '的名字是' + bn)
         .replace(/((?:我)?主人)叫主人(?:呀|啊|哦|呢)?/g, (m, who) => who + '叫' + bn);
  }
  // 开场复读剥离（真人真事 2026-10-22：对方说「这个表情是这么用的吗😭」，她把这句原样当第一行复读一遍）
  // 免费模型爱拿对方原话当开场白——首行和对方输入一字不差（或互相包含）就整行剥掉
  const inRaw = k ? String((getTurn(k) || {}).text || '') : '';
  if (inRaw) {
    const strip = t => String(t).replace(/[\s，。！？、；~～…·,.!?；:"'“”‘’()（）【】\[\]🤭😂😭]/g, '');
    const nIn = strip(inRaw);
    const lines = s.split('\n');
    if (lines.length > 1) {
      const n0 = strip(lines[0]);
      if (n0 && (n0 === nIn || (nIn.length > 6 && (n0.includes(nIn) || nIn.includes(n0))))) {
        s = lines.slice(1).join('\n').trim();
      }
    }
  }
  s = s.replace(/嘿{2,}/g, '嘻嘻');            // 只换词，不管标点
  // 括号动作/占位（主人 2026-10-23 定：不许出现「（尾巴）」「（看不懂）」这种）
  // 免费模型会自己长出来：整行只有一个短括号就删掉这一行；
  // 删完全空说明这句本来只有个动作 → 原样留着（总比一句话不说好），并把这事记进日志。
  {
    const lines = s.split('\n');
    const kept = lines.filter(l => !/^\s*[（(][^）)\n]{0,10}[）)]\s*$/.test(l));
    if (kept.length && kept.length < lines.length) {
      s = kept.join('\n').trim();
      console.log('[polish] 剥掉括号动作/占位 ' + (lines.length - kept.length) + ' 行');
    }
  }
  // 同一条里同一句连着说好几遍（「你好呀，你好呀，你好呀」）→ 只留一遍
  s = s.replace(/([\u4e00-\u9fa5A-Za-z0-9]{2,12})(?:[，、\s.…]+\1)+/g, '$1');
  if (isGuide) {
    // 攻略只给数值和结论：笑声、语气词、堆叠的感叹号全去掉
    s = s.replace(/(嘻嘻|嘿嘿|哈{2,}|嘿)\s*[。！!，,~～]?/g, '');
    s = s.replace(/[，,、]{2,}/g, '，').replace(/[，,、]+\s*([！!。])/g, '$1')
         .replace(/^[，,、\s]+/, '').replace(/[，,、\s]+$/, '');
    s = s.replace(/[!！]{2,}/g, '！');
  }
  const CRY = /(呜呜|QAQ|qwq|T_T|呜…|呜\.|哭)/i;
  let n = 0;
  s = s.replace(/\.{2,}|…+/g, (m, off) => {
    const near = s.slice(Math.max(0, off - 8), off + m.length + 8);
    if (CRY.test(near) && n < 3) { n++; return '...'; }
    return '，';
  });
  return s.replace(/，{2,}/g, '，').replace(/^[，、\s]+/, '').replace(/[，、\s]+$/, '');
}

// 重说还是重复时的兜底：挑一句最近没说过的话
function shortFallback(k, ut) {
  const t = String(ut || (getTurn(k) || {}).text || '');
  const said = getHist(k).filter(isSpeech).slice(-8).map(m => m.content);
  // 对方在喊「在吗」才回「在的/我在」；别的场合别发这种答非所问的。
  // 真事 2026-10-23：主人问「怎么办呀」，模型被限流降级后重复答了一遍，兜底甩了句「我在」——
  // 群里看着莫名其妙（她到底在不在、跟谁说的），主人直接截图来问。
  const calling = /(在吗|在不在|在么|还在吗|醒着吗|忙吗|听到了吗)/.test(t);
  // 2026-11-13 主人令：不要「嗯嗯」这个兜底；另一组（喊「在吗」时）兜底保留，一个字不动。
  const pool = calling ? ['在的', '我在', '醒着呢'] : ['知道啦', '好哦'];
  return pool.find(x => !said.some(c => similarText(c, x))) || pool[0];
}

// 通用回复流程：防止同一会话并发请求
// 1) 正在生成时又来新消息 → **排队，一条都不许丢**（主人 2026-10-22 定：
//    排队是防丢消息，不是限制格式；v53 起：像人一样断续连发算整个回答，不乱刷屏就行；
//    别人一个字一条发、明显是两个话题，必须都回）
// 2) 只有「这句是对上一条的重复 / 没打完的碎片」才让上一条正在生成的回复作废
const queued = new Map();      // k -> [{build, onText, onFail, turn}, ...]  先进先出
const talkSeq = new Map();     // k -> {uid, n, last, at}
const offlineAt = new Map();   // k -> 上次在聊天里说「我很忙」的时间（没有 onFail 钩子时的兜底节流）
// 本轮上下文跟着「排队项」走（2026-11-13 修「QQ 引用错人」）：
// turns 是按会话 key 覆盖写的，而 chat 会把 buildMessages 延后到轮到时才跑；
// 后到的消息在 handleTurn 里 setTurn 覆盖同一个 key，排队那条醒来读到的就是**别人那轮**的
// 引用对象 / 发言人 / 对准语 → QQ 引用错人、前端显示错人、喜好·教学·好感一并记错人。
// activeTurns 记住「正在生成的那一轮」的 ctx，排队时立刻还原；轮到时再换成本条自己的 ctx。
const activeTurns = new Map(); // k -> 正在生成那一轮的 ctx

// 「前方有会话排队」只读判据：主人必回降级要用（2026-11-13 主人定）。
function chatBusy(k) { return !!pending.get(k) || (queued.get(k) || []).length > 0; }
// 本轮决定不回复时把 turns 还原给正在生成的那一轮（跳过必回专用，别让它读到本条的人）。
function restoreTurn(k) { const t = activeTurns.get(k); if (t) turns.set(k, t); }

function seqBump(k, ctx) {
  const c = ctx || {};
  const uid = c.uid;
  const text = String(c.text || '');
  const s = talkSeq.get(k) || { uid: null, n: 0, last: '', at: 0 };
  const sameUid = !s.uid || String(s.uid) === String(uid);
  // 群里换个人说话不作废上一条（那是在回另一个人）
  if (sameUid && text && s.last) {
    const dup = similarText(text, s.last) || overlapScore(text, s.last) >= 0.6;
    const frag = text.replace(/\s/g, '').length <= 2 && (Date.now() - (s.at || 0) < 3000);
    if (dup || frag) s.n++;
  }
  s.uid = uid;
  if (text) s.last = text;
  s.at = Date.now();
  talkSeq.set(k, s);
}

// ===== 答不出来的时候（主人 2026-10-22 定）=====
// 私聊里把所有可能的原因说清；群里只说一句「我现在有点忙」，并且私聊同步给主人。
// 这里只管「判断是哪种毛病 + 把话说出来」，发给谁由连接层决定——只有它知道是群还是私聊。
// 顺序按可能性排：★ 表示这次命中的那条。
const OFFLINE_CAUSES = [
  { n: 1, k: 'PROXY', t: '代理 / VPN 只接管了浏览器', fix: '关掉代理，或者开 TUN / 全局模式（node.exe 不走浏览器代理）' },
  { n: 2, k: 'BUSY', t: '三个免费模型一起限流（429 / 1305）', fix: '等 1~3 分钟，自己会好，什么都不用动' },
  { n: 3, k: 'BLOCK', t: '账号 / IP 被限制访问生成接口（403 + 1220）', fix: '登录 bigmodel.cn 看实名、额度、是否被风控；等 10~30 分钟也可能是临时拉黑；或换一个 Key' },
  { n: 4, k: 'AUTH', t: 'Key 过期或被封（401 / 403）', fix: '双击 xuhuan 里的「换Key」重新粘一次' },
  { n: 5, k: 'NOKEY', t: '没填 Key，或 Key 里还留着「在这里填」', fix: '看 config.json → llm.apiKey 是不是空的' },
  { n: 6, k: 'ENDPOINT', t: '接口地址写错', fix: '要是 https://open.bigmodel.cn/api/paas/v4/chat/completions 一整个' },
  { n: 7, k: 'SERVER', t: '智谱服务端故障（5xx）', fix: '不是你这边的事，等它恢复' },
  { n: 8, k: 'BADJSON', t: '返回的不是 JSON', fix: '多半是代理改写了响应，把代理关掉再试' },
  { n: 9, k: 'TIMEOUT', t: '模型卡住不回（超时）', fix: '她已经跳去下一个模型了' },
  { n: 10, k: 'EMPTY', t: '模型返回空内容', fix: '三个都空就是服务端异常，等一会儿再试' },
  { n: 11, k: 'NAPCAT', t: 'NapCat 掉线', fix: '看 NapCat 窗口还在不在、QQ 是不是被挤下线' },
  { n: 12, k: 'PROCESS', t: '机器人进程挂了', fix: '双击「启动」' },
];

function diagnose(e) {
  const m = String(((e && e.message) || '') + ' ' + ((e && e.detail) || ''));
  const pick = k => ({ k });
  if (m === 'NO_KEY ' || /^NO_KEY\b/.test(m)) return pick('NOKEY');
  if (/"?1220"?/.test(m)) return pick('BLOCK');          // 智谱：IP/账号没有生成接口权限
  if (/^AUTH\b/.test(m)) return pick('AUTH');
  if (/^BUSY\b/.test(m)) return pick('BUSY');
  if (/不是 JSON/.test(m)) return pick('BADJSON');
  if (/接口地址|endpoint/i.test(m)) return pick('ENDPOINT');
  if (/DNS|ENOTFOUND|EAI_AGAIN/.test(m)) return pick('PROXY');
  if (/超时|ETIMEDOUT|TIMEOUT/i.test(m)) return pick('TIMEOUT');
  if (/\b(5\d\d)\b/.test(m)) return pick('SERVER');
  if (/返回空内容/.test(m)) return pick('EMPTY');
  if (/连不上|ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH/.test(m)) return pick('PROXY');
  return pick('UNKNOWN');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// 全部原因的报告（只发私聊，不进群）
function offlineReport(k, e) {
  const d = diagnose(e);
  const raw = String(((e && e.message) || '') + ((e && e.detail) ? ' ｜ ' + e.detail : '')).slice(0, 180);
  const t = getTurn(k) || {};
  const now = new Date();
  const hit = OFFLINE_CAUSES.find(c => c.k === d.k);
  const who = t.isMaster ? '主人本人' : (t.nick || '有人');
  const said = String(t.text || '').replace(/\s+/g, ' ').slice(0, 40);
  const L = [];
  L.push('【虚幻答不出来 · ' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' '
    + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + '】');
  L.push('这次是：' + (hit ? hit.t : '没归类的原因'));
  L.push('原始报错：' + raw);
  L.push('请求来自：' + (t.gid ? ('群 ' + t.gid) : '私聊') + ' · ' + who
    + (t.atMe === false && t.autoAsk ? '（没 @ 她，是自动接的提问）' : ''));
  if (said) L.push('他说的是：「' + said + '」');
  // 2026-11-13 主人令「我只需要看到真正的问题」：只给这次命中的那一条和怎么修，
  // 不再把 12 条「所有可能的原因」连同「没填 Key / NapCat 掉线」一起铺给她。
  // OFFLINE_CAUSES 本身保留：diagnose 归类和上面「这次是」都靠它，不删数据。
  if (hit) L.push('怎么修：' + hit.fix);
  return L.join('\n');
}

/* 兜底词池（2026-11-13 主人令）：池里每条都能增 / 删 / 改，可按群、私聊、某人、平台分配。
 * scope 写法：'' = 全部；g<群号> = 某个群；private = 所有私聊；p<QQ号> = 某人私聊；bili 等 = 那个平台。
 * 挑句顺序：先精确作用域 → 再全局条目 → 一条都没有才用 offline.line（未设置内容时的默认兜底）。
 * 配置现读 cfgLive：聊天记录页改完不用重启，下一句就生效。offline.line 字段不删，保留当默认值。 */
const FB_DEFAULT_LINE = '我现在有点忙，让我的主人替我回答吧';
let _lastFbId = '';
function fbScopes(ctx) {
  const c = ctx || {};
  const out = [];
  // 2026-11-13 主人令：B站平台公开评论 / 弹幕不设兜底，全部攒着等应答；
  // 只有 B站私信（private）才认 bili 这类平台作用域。
  if (c.plat && c.plat !== 'qq' && c.private) out.push(String(c.plat));
  if (c.private) {
    if (c.uid) out.push('p' + String(c.uid));
    out.push('private');
  } else if (c.group) {
    out.push('g' + String(c.group));
  }
  return out;
}
function offlinePoolPick(ctx) {
  let o = {};
  try { o = readConfigFresh().offline || {}; } catch { o = (cfg && cfg.offline) || {}; }
  const pool = Array.isArray(o.pool) ? o.pool : [];
  const usable = list => list.filter(x => x && x.enabled !== false && String(x.text || '').trim());
  let hit = [];
  for (const sc of fbScopes(ctx)) {
    hit = usable(pool.filter(x => String(x.scope || '') === sc));
    if (hit.length) break;
  }
  if (!hit.length) hit = usable(pool.filter(x => !String(x.scope || '').trim()));
  if (!hit.length) return String(o.line || FB_DEFAULT_LINE);
  // 同作用域有多条时避开刚用过的那条，保证「多条不同的兜底」真的轮得开
  const fresh = hit.length > 1 ? hit.filter(x => String(x.id || '') !== _lastFbId) : hit;
  const pick = fresh.length ? fresh : hit;
  const one = pick[Math.floor(Math.random() * pick.length)];
  _lastFbId = String(one.id || '');
  return String(one.text).trim();
}
function offlineLine(ctx) {
  return offlinePoolPick(ctx);
}

/* ===== 兜底词池自动补齐（2026-11-13 主人令）=====
 * 原话：「如果只有默认，让ai在输出过一次兜底后，就根据所有的「记录的」以及「好感度」「人物表」等等
 *        写5个不同的句子。低于5句就补到5，高于5就不触发。这个也是我能自由修改的」
 * 判据：池里非空条目 < 5 就补到 5；>= 5 一次都不调模型。「只有默认」是初始态，已包含在内。
 *       只补差额，不覆盖她手写的条目；生成的条目 scope='' 全部，前端 🛟 兜底 弹层直接增删改。
 * 触发：真正发出兜底之后（qq.js logSent 第4参 / core.js 无 onFail 钩子分支），
 *       不是「答不出来」就触发 —— 连续兜底抑制 / 节流跳过时不触发。
 * 模型：兜底 = 那一轮模型链全失败，所以生成走独立调用：
 *       preferFallback 把限流最狠的主模型垫底、noThink 避开常开思考的 30 秒超时；
 *       这次也失败就静默留到下次兜底，不假装成功、不塞假句子冒充 AI 写的。
 */
const FB_AUTO_TARGET = 5;
const FB_AUTO_SPARE = [
  '我先记着，回头再跟你好好说',
  '这题我得想想，你先别急',
  '刚走神了，你再讲一遍给我听',
  '我这边一时接不上，等下补给你',
  '话到嘴边卡住了，容我缓一下',
];
let _fbAutoBusy = false;

/* 只读文件尾部若干行：topics.jsonl 266KB、chat-log.jsonl 几千行，不整份读、更不整份塞给模型。 */
function fbTailLines(rel, n, maxBytes) {
  try {
    const p = path.join(ROOT, rel);
    const st = fs.statSync(p);
    const len = Math.min(st.size, maxBytes || 24000);
    if (len <= 0) return [];
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const arr = buf.toString('utf8').split('\n').filter(Boolean);
    if (arr.length > 1) arr.shift();       // 尾部读取可能切在半个 UTF-8 字符里，丢掉第一行
    return arr.slice(-n);
  } catch { return []; }
}
function fbHead(rel, cap) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\s+/g, ' ').trim().slice(0, cap); }
  catch { return ''; }
}
function fbJsonlText(line) {
  try { const j = JSON.parse(line); return String(j.text || j.sum || j.content || j.topic || '').replace(/\s+/g, ' ').trim().slice(0, 46); }
  catch { return ''; }
}

/* 素材：人设 / 人物表 / 好感度 / 人物喜好 / 说话风格 / 记录的 / 约定 / 最近对话。逐项限量，总长封顶。 */
function fbMaterial(existing) {
  const L = [];
  const soul = fbHead(DEFAULT_FILES.soul, 500);
  if (soul) L.push('【人设】' + soul);
  const peopleMd = fbHead('data/人物列表.md', 500);
  if (peopleMd) L.push('【人物表】' + peopleMd);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/people.json'), 'utf8'));
    const arr = (Array.isArray(pj) ? pj : (pj.people || pj.list || Object.values(pj)))
      .filter(x => x && x.name).slice()
      .sort((a, b) => Number(b.favor || 0) - Number(a.favor || 0)).slice(0, 6);
    if (arr.length) L.push('【好感度】' + arr.map(x => x.name + ' ' + (Number(x.favor) || 0)).join('；'));
  } catch {}
  const likes = fbHead('data/人物喜好.md', 260);
  if (likes) L.push('【人物喜好】' + likes);
  const styleTxt = fbHead('data/说话风格.md', 260);
  if (styleTxt) L.push('【说话风格】' + styleTxt);
  // 「记录的」= 教学条 / 学到的 / 攻略；直接读文件，不 require guides（会触发攻略静默自愈）
  let teachLines = [];
  for (const f of ['data/teach/梗词句.jsonl', 'data/teach/情绪表达.jsonl']) {
    teachLines = teachLines.concat(fbTailLines(f, 3).map(fbJsonlText).filter(Boolean));
  }
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'data/guides')).filter(x => x.endsWith('.md')).slice(0, 3)) {
      const t = fbHead('data/guides/' + f, 60);
      if (t) teachLines.push(t);
    }
  } catch {}
  if (teachLines.length) L.push('【记录的】' + teachLines.filter(Boolean).slice(0, 8).join('；'));
  const topicLines = fbTailLines('data/topics.jsonl', 40)
    .map(l => { try { const j = JSON.parse(l); return (j.kind === 'promise' || j.state === 'kept') ? fbJsonlText(l) : ''; } catch { return ''; } })
    .filter(Boolean).slice(0, 5);
  if (topicLines.length) L.push('【约定和话题】' + topicLines.join('；'));
  const recent = fbTailLines('data/chat-log.jsonl', 8).map(l => String(l).slice(0, 60)).slice(-5);
  if (recent.length) L.push('【最近对话】' + recent.join(' / '));
  if (existing.length) L.push('【已有的句子，不许重复】' + existing.slice(0, 10).join(' / '));
  return L.join('\n').slice(0, 2600);
}

/* 模型输出 → 一句一行。清掉编号 / 引号 / markdown，滤掉技术词和 QQ 号。 */
function fbCleanLines(out, existing) {
  const seen = new Set(existing.map(s => String(s).trim()));
  const lines = [];
  for (const raw of String(out || '').split('\n')) {
    const s = raw.replace(/^\s*(?:\d+\s*[.、)]|[-*•])\s*/, '')
      .replace(/^[「『"'《]+|[」』"'》]+$/g, '')
      .replace(/\s+/g, ' ').trim();
    if (s.length < 6 || s.length > 40) continue;
    if (/模型|AI|故障|报错|网络|Key|限流|API|http|@|\d{5,}/i.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s); lines.push(s);
  }
  return lines;
}

/* 差额 = 目标 − 池内非空条目数。停用条目也占名额（她停用自己的句子，不等于想让 AI 补新的）。 */
function fbNeed(pool) {
  const n = (Array.isArray(pool) ? pool : []).filter(x => x && String(x.text || '').trim()).length;
  return Math.max(0, FB_AUTO_TARGET - n);
}

/* llmFn 可注入：验证时传假模型，生产调用不传（默认 callLLM）。 */
async function fbAutoFill(ctx, llmFn) {
  if (_fbAutoBusy) return { skipped: 'busy' };
  let need = 0, before = [];
  try {
    const o = configStore.load().offline || {};
    before = Array.isArray(o.pool) ? o.pool.slice() : [];
    need = fbNeed(before);
  } catch { return { skipped: 'read-fail' }; }
  if (!need) return { skipped: 'full', pool: before.length };   // 高于/等于 5 不触发，0 次模型调用
  _fbAutoBusy = true;
  try {
    const existing = before.map(x => String(x.text || '').trim()).filter(Boolean);
    const sys = [
      '你在给一个 QQ 陪伴机器人写「答不出来时说的短句」。',
      '下面给你它记住的东西：人设、人物表、好感度、人物喜好、说话风格、记录的、约定、最近的对话。',
      '请写 ' + need + ' 句短句。一句一行，只输出这些行。',
      '每句 8 到 30 个字。',
      '每句都要是不同的说法，意思不许重复。',
      '不许和「已有的句子」重复。',
      '不许出现 模型、AI、故障、报错、网络、Key、限流 这些词。',
      '不许出现 QQ 号、@、链接、编号、引号、markdown。',
      '不许承诺具体时间，不许连续发问。',
      '语气照「说话风格」来，别写成客服腔。',
      '不许解释，不许写标题，不许写「以下是」。',
    ].join('\n');
    const out = await (llmFn || callLLM)([
      { role: 'system', content: sys },
      { role: 'user', content: fbMaterial(existing) },
    ], { preferFallback: true, noThink: true, tag: 'fallback-pool' });
    const got = fbCleanLines(out, existing);
    if (!got.length) { console.log('[兜底词池] 这次没拿到能用的句子，等下次兜底再试'); return { ok: false, why: 'empty' }; }
    // 模型给的不够差额 → 内置短句补足到 5（「低于5句就补到5」）
    for (const s of FB_AUTO_SPARE) { if (got.length >= need) break; if (!got.includes(s) && !existing.includes(s)) got.push(s); }
    // 写回前重读最新池：她可能刚在客户端改过，只 append 差额，绝不覆盖
    const fresh = configStore.load().offline || {};
    const cur = Array.isArray(fresh.pool) ? fresh.pool.slice() : [];
    const need2 = fbNeed(cur);
    if (!need2) return { skipped: 'full-after-save', pool: cur.length };
    const have = new Set(cur.map(x => String(x.text || '').trim()));
    const add = [];
    for (const s of got) {
      if (add.length >= need2) break;
      if (have.has(s)) continue;
      have.add(s);
      add.push({ id: 'fb-auto-' + Date.now().toString(36) + '-' + add.length,
        text: s, scope: '', enabled: true });
    }
    if (!add.length) return { ok: false, why: 'dup' };
    const r = configStore.patch('offline', Object.assign({}, fresh, { pool: cur.concat(add) }));
    if (!r.ok) return { ok: false, why: r.error };
    try { require('./wlog').botWrite('config/features.json', '兜底词池', '自动补 ' + add.length + ' 条，共 ' + (cur.length + add.length) + ' 条'); } catch {}
    console.log('[兜底词池] 自动补 ' + add.length + ' 条（模型给 ' + got.length + ' 句），现在 ' + (cur.length + add.length) + ' 条');
    return { ok: true, added: add.length, pool: cur.length + add.length };
  } catch (e) {
    console.log('[兜底词池] 这轮生成没成（' + (e && e.message) + '），等下次兜底再试');
    return { ok: false, why: String(e && e.message) };
  } finally { _fbAutoBusy = false; }
}

/* 把这一轮的可见事实落盘。放进 trace 的每个字段都必须是代码里能查到的东西：
 *   in/who/emo/scenes/blocks = buildMessages 真实算出来并注入的
 *   out                      = 真正发出去的那句（polish 之后）
 *   model/reason/ms          = 最近一次成功 LLM 调用返回的，失败或没调用则留空
 * 如果这句是代码兜底（不是模型生成的），note 里如实写明，不冒充推理。 */
function writeTrace(k, out, how) {
  try {
    const t = (getTurn(k) || {})._trace || {};
    const call = _lastLlmCall || {};
    const fresh = call.t && (Date.now() - call.t) < 60000;   // 一分钟内的调用才算这一轮的
    trace.record({
      k: String(k).slice(0, 120),
      in: t.in || String((getTurn(k) || {}).text || '').slice(0, 500),
      who: t.who || '', emo: t.emo || '',
      scenes: t.scenes || [], soulScenes: t.soulScenes || [],
      lesson: !!t.lesson, blocks: t.blocks || [],
      teach: t.teach || '', learned: t.learned || '',
      out: String(out || '').slice(0, 2000),
      how: String(how || '模型回复'),
      model: fresh ? (call.model || '') : '',
      reason: fresh ? (call.reason || '') : '',
      llmMs: fresh ? (call.ms || 0) : 0,
      // 这一轮真花的 token（接口原样返回的 usage），聊天记录里贴在每句话旁边
      tokIn: fresh ? (call.inTok || 0) : 0,
      tokOut: fresh ? (call.outTok || 0) : 0,
      note: '代码决策轨迹：这一轮命中了什么、给模型看了哪些段、最后发出什么。'
        + '模型默认关思考，reason 为空就是没有模型思考原文，不是漏记。',
    });
  } catch (e) { console.log('[trace] 记不了：' + e.message); }
}

// 【分类 F·全场景通用】chat 发送主干：所有平台回话共用（排队/turn/会话隔离），按平台注入不同提示词。
async function chat(k, buildMessages, onText, opts) {
  const myTurn = (opts && opts.turn) || null;
  if (pending.get(k)) {
    // 排队，全部保留：连发几句就是几个话题，一句都不漏
    const arr = queued.get(k) || [];
    arr.push({ build: buildMessages, onText, onFail: opts && opts.onFail, turn: myTurn, agentTurn: !!(opts && opts.agentTurn) });
    if (arr.length > 6) arr.shift();       // 极端刷屏时只留最近 6 条，防止无限堆积
    queued.set(k, arr);
    // 本条消息在 handleTurn 里已经 setTurn 覆盖过 turns；把正在生成那轮的 ctx 还原回去，
    // 否则它醒来时 buildMessages 读到的引用对象 / uid 全是本条的（引用错人的根因）。
    const running = activeTurns.get(k);
    if (running) turns.set(k, running);
    console.log('[chat] 正在说上一条，这句排队（队列 ' + arr.length + '）');
    return;
  }
  pending.set(k, true);
  activeTurns.set(k, myTurn || turns.get(k) || {});
  turns.set(k, activeTurns.get(k));        // 不调 setTurn：ctx 已经建好，别再 seqBump 一次
  const mySeq = (talkSeq.get(k) || {}).n || 0;
  const stale = () => ((talkSeq.get(k) || {}).n || 0) !== mySeq;
  try {
    const msgs = await buildMessages();
    // 「原文梗」内容不全（主人 2026-10-22 定）：检测到梗只发了一截 → 直接背全文。
    // 不走模型（免费模型会改字）、不裁短、不做防重复——同一套梗再发一次原文也是对的。
    const fullAns = fullTextTurns.get(k);
    if (fullAns !== undefined) {
      fullTextTurns.delete(k);
      if (stale()) return true;
      console.log('[meme] 梗内容不全 → 背全文：' + fullAns.slice(0, 24) + '…');
      writeTrace(k, fullAns, '梗全文兜底：代码背原文，没调模型');
      setWebAnswer(k, fullAns); onText(fullAns); return true;
    }
    // 功能清单直答（主人 2026-11-22）：问到「你有什么功能」→ 代码发清单，0 模型 0 联网，少一轮。
    const fixedAns = msgs._fixedReply;
    if (fixedAns) {
      if (stale()) return true;
      // 收尾那句让模型现说（主人 2026-11-22：收尾要她自己的口气，别写死在清单里）
      const tail = await closingLine(msgs, k);
      const payload = tail ? (fixedAns + '\n|||\n' + tail) : fixedAns;
      console.log('[web] 功能清单直答' + (tail ? ' + 模型收尾' : '（收尾没生成，只发清单）') + '：' + k);
      writeTrace(k, payload, '功能清单：代码发清单' + (tail ? '，收尾模型现说' : '，没联网'));
      setWebAnswer(k, payload); onText(payload); return true;
    }
    // 主人 2026-11-19 全平台规则：该联网却没拿到结果 → 不发提示词给 AI、绝不编内容。
    // 2026-11-22 改：不再一律「被@就回固定话术」——被 @ / 引用她 / 私聊的轮交给模型链，
    // 由 webMissWho 决定是我（dsh）去查还是免费模型答；只有群里没人跟她说话的闲聊轮才静默。
    /* 2026-11-22 主人令：联网是**老闸先查，查不到再由我查**，两段顺序不许颠倒。
     * 老闸的搜索在 buildMessages 里已经跑完（跑空了才会置 _webNoResult）；
     * 这一轮若是派活（@ + 命中词 + 好感满），就不能在这儿回固定话术收工，
     * 要放过去让我接着查——我查到了我就在群里回，我查挂了走纯代码兜底句。
     * 没派活的普通轮维持原规则（没查到就不接话，杜绝免费模型瞎编）。 */
    if (msgs._webNoResult && !(opts && opts.agentTurn)) {
      const _f = msgs.facts || {};
      /* 主人 2026-11-22 令：「callLLM 之前就 return，改掉 return 即可」。
       * 群里没人跟她说话的闲聊轮仍旧不接话（不能把每条搜空都派给我）；
       * 被 @ / 引用她 / 私聊这一支不再回固定话术收工——放过去给模型链，
       * 由 callLLM 按 intent.mode.webMissWho（默认 agent）决定是我去查还是免费模型答；
       * 我查挂了照样回兜底句（askOnce 的 dispatchFail='code'）。 */
      if (_f.gid && !_f.atMeReal && !_f.replyMe) {
        console.log('[web] 该联网没结果、也没被@ → 不接话（不发提示词，杜绝瞎编）：' + k);
        return true;
      }
      msgs._webMissAgent = true;
      msgs.push({
        role: 'system',
        content: '本地免费搜索源都没查到这个。别猜，也别拿记忆顶上：你用自己的工具去查，'
          + '查到就直接给结论（说清是哪查到的），查不到就直说没查到。',
      });
      console.log('[web] 该联网没结果、被@ → 不回固定话术，这一轮交给我查：' + k);
    }
    /* 聊天记录页「本轮输出的提示词」（2026-11-13 主人令）：把这轮真要发给大模型的整组
     * 提示词按来源钉住一条。放在梗全文兜底之后——那条代码背原文、根本没调模型，
     * 没有「输出的提示词」，不该占槽。每个来源只写一次：写满不覆盖，主人删掉后
     * 下一轮才会自动补（缺位后自动补一次）。自检键 selfcheck#probe 由模块自己挡掉。 */
    try { promptSlots.record(k, msgs, myTurn || activeTurns.get(k) || getTurn(k)); } catch (e) {
      console.log('[prompt-slots] 记提示词失败：' + e.message);
    }
    let ans = polish(await callLLM(msgs, { tag: 'reply', key: k, agentTurn: !!(opts && opts.agentTurn) }), k);
    // 解析 AI 自己带回的「状态」标记（2026-11-14 补：AI 也能记自己的状态）。
    // 本地优先会话记 local、默认会话记 normal，本地/云端互不串；同主题覆盖旧值（更新制）。
    // 标记在发出去前被剥掉，对方看不到。
    let _stateWrites = [];
    if (ans) {
      const sk = stateKind(k);
      const reRec = /@@状态\s*([^:：\n]+?)[:：]\s*([\s\S]*?)@@/g;       // @@状态 主题: 内容@@（空格可有可无）
      const reDel = /@@状态删\s*([^@\n]+?)@@/g;                          // @@状态删 主题@@
      const rePlain = /@@状态[:：]\s*([\s\S]*?)@@/g;                      // @@状态: 内容@@（无主题）
      ans = ans.replace(reRec, (m, topic, text) => { _stateWrites.push({ kind: sk, topic: String(topic).trim(), text: String(text).trim() }); return ''; });
      ans = ans.replace(reDel, (m, topic) => { _stateWrites.push({ del: true, kind: sk, topic: String(topic).trim() }); return ''; });
      ans = ans.replace(rePlain, (m, text) => { _stateWrites.push({ kind: sk, topic: '', text: String(text).trim() }); return ''; });
      ans = ans.replace(/@@状态[^@]*?@@/g, '');   // 任何没解析掉的残留标记也清掉，别发给对方
    }
    // 硬限制（主人 2026-11-09 定【4】）：本轮事实是代码算的，说错就由代码拦，不靠提示词禁令。
    // 说错 → 带冲突说明重说一次；再说错 → 这句不发（和「乱写不许发」同一套处置）。
    const facts = msgs.facts || null;
    if (ans && hardLimitHit(ans, facts)) {
      console.log('[hard] 和本轮事实冲突 → 重说：' + String(ans).slice(0, 30));
      const again = polish(await callLLM(msgs.concat([
        { role: 'assistant', content: ans },
        { role: 'system', content: '你刚才那句和这轮的事实冲突（说了没发生过的 @、引用，或把身份话说了出来）。'
          + '只按上面「本轮事实」写的情况，重新接一句这轮真正该说的话；绕开 @、引用、身份这三类话题。' },
      ]), { tag: 'reply-retry:硬限制', key: k }), k);
      if (again && !hardLimitHit(again, facts)) ans = again;
      else { console.log('[hard] 重说仍冲突 → 这句不发'); return true; }
    }
    // 提示词泄漏闸门（主人 2026-11-23 定）：把短期记忆块原样当回复发出去的事故。
    // 和硬限制同套处置：重说一次；重说仍照抄 → 这句不发（整条没回复，不发内部记录进群）。
    if (ans && promptLeakHit(ans)) {
      console.log('[leak] 照抄了提示词里的短期记忆块 → 重说：' + String(ans).slice(0, 40));
      const again = polish(await callLLM(msgs.concat([
        { role: 'assistant', content: ans },
        { role: 'system', content: '你刚才把内部记录（带日期和群号的旧聊天）原样念出来当回复了，那不是回答。'
          + '忘掉那段记录，用你自己的话，对着他刚说的回一句短短的；不许再列日期、群号或【名字】块。' },
      ]), { tag: 'reply-retry:提示词泄漏', key: k }), k);
      if (again && !promptLeakHit(again) && !hardLimitHit(again, facts)) ans = again;
      else { console.log('[leak] 重说仍照抄 → 这句不发'); return true; }
    }
    // 复读对方（v78，主人 2026-10-23）：真事——主人 @ 她说「今天真的好累啊，不想上班。你呢。」，
    // 她把这句原样搬回来，被发送层当成复读拦掉 → 结果「必回复」变成了没回。
    // 这里先让她重说一次；还说不好就交给发送层，至少不要因为一句复读就整条不回。
    if (ans) {
      const lastU = getHist(k).filter(m => m.role === 'user').slice(-1)[0];
      const uTxt = String(lastU ? lastU.content : '').replace(/^[\s\S]*?说:\s*/, '').trim();
      // 2026-11-03 主人报：群里回了一句「符合自己喜好的烤五」——那是**图上的字**（图名就是图标题截断的产物），
      // 不是对方打的字，所以只比整句的旧闸门放它过去了。现在把图描述也拆成段一起比：
      // 回复 ≈ 图上任何一段（至少 4 个字）就算复读，重说一次。
      const imgParts = (uTxt.match(/图上[:：]([\s\S]*)$/) || [, ''])[1]
        .split(/[；;\/\n]+/).map(s => s.trim()).filter(s => s.length >= 4);
      const echoImg = imgParts.some(p => similarText(ans, p));
      const echoU = uTxt.length >= 3 && similarText(ans, uTxt);
      if (echoImg || echoU) {
        console.log((echoImg ? '[repeat] 把图上的字复读了 → 重说：' : '[repeat] 把对方的话复读了 → 重说：') + String(ans).slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          {
            role: 'system',
            content: echoImg
              ? '你刚才只是把图上的字念了一遍，那不是回应。看图说你自己的一句话：图在问你什么就答什么（该选号就选号），别抄图上的字。'
              : '你刚才把对方的话原样复读了一遍，那不是回答。用你自己的话说一句回应（一两句就够），不许重复他的原句。',
          },
        ]), { tag: echoImg ? 'reply-retry:复读图上文字' : 'reply-retry:复读对方', key: k }), k);
        if (again && !similarText(again, uTxt) && !globalRepeat(again)) ans = again;
      }
    }
    // 笑点解析（主人 2026-10-23 改版）：主回复保持正常聊天，解析另发一条——
    // 消费点挪到下面的发送点之后（xiaodianTurns.has(k) && !stale()），这里不再替换 ans。
    // 玩梗不用单条字数上限（主人 2026-10-22 傍晚定：梗该多长就多长，不许裁）——原先这里会把梗回复裁到 55 字

    // 他在等我道歉 / 在骂我：答错腔调、或者又是同一句话 → 重说一次（不改词，让她自己说）
    const soulKind = soulTurns.get(k);
    if (ans && soulKind) {
      const wrong = (soulKind === 'blame' && WRONG_TONE.test(ans))
        // 被骂场景：跑题（转去关心对方 / 复述对方的话 / 跑去安慰自己）也算答错
        || (soulKind === 'scold' && (/(是不是不开心|你怎么了|主人说|你说我)/.test(ans) || ans.length > 40));
      const dup = globalRepeat(ans);
      if (wrong || dup) {
        console.log('[soul] ' + (wrong ? '该道歉却答成心疼' : '这句之前已经用过') + ' → 重说：' + ans.slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          {
            role: 'system',
            content: (wrong ? '答错了：她不是累，是被我刚那句话气到了。' : '这句话你之前已经说过了，换一个角度。')
              + (soulKind === 'blame'
                ? '重说一句道歉：先认「我刚才那句不对」，再说「我不是那个意思」，软一点、慌一点；换个说法，别和刚才那句一样。'
                : '重说一句委屈的话：短、软、带一点撒娇，换个角度（可以是问自己哪里错了、也可以是小声不服）；别和刚才那句一样。'),
          },
        ]), { tag: 'reply-retry:腔调', key: k }), k);
        const ok = again && !globalRepeat(again)
          && !(soulKind === 'blame' && WRONG_TONE.test(again))
          && !(soulKind === 'scold' && (/(是不是不开心|你怎么了|主人说|你说我)/.test(again) || again.length > 40));
        if (ok) ans = again;
        else ans = pickLine(soulKind === 'blame' ? APOLOGY_LINES : SCOLD_LINES);
      }
    }
    // 被群友吐槽却答成撒娇/道歉 → 直接换成痞的回击（免费模型经常不听 prompt）
    if (ans && banterTurns.has(k) && /(呜呜|心疼|抱抱|嘻嘻|对不起|抱歉|不好意思)/.test(ans)) {
      console.log('[banter] 答成撒娇/道歉 → 换成回击：' + ans.slice(0, 30));
      ans = banterFallback(k);
    }
    // 被嫌蠢却答成「心疼/关心累不累」→ 重说一次，还不行就用认错池兜底（免费模型经常不听 prompt）
    if (ans && criticTurns.has(k)) {
      const bad = /(累了|辛苦|早点休息|早点睡|多喝水|注意身体|加油|照顾|是不是不|抱抱宝宝|心疼)/.test(ans) || ans.length > 40;
      if (bad) {
        console.log('[critic] 被嫌蠢却答成关心 → 重说：' + ans.slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          { role: 'system', content: '答错了：她不是累，是被你刚才蠢到了。重说一句认错：短、软，可以带一点点委屈；不解释、不讲道理、不关心她累不累；换个说法，别和刚才那句一样。' },
        ]), { tag: 'reply-retry:认错', key: k }), k);
        const ok = again && again.length <= 40
          && !/(累了|辛苦|早点休息|早点睡|多喝水|注意身体|加油|照顾|是不是不|抱抱宝宝|心疼)/.test(again)
          && !globalRepeat(again);
        if (ok) ans = again;
        else ans = pickLine(CRITIC_LINES);
      }
    }
    // 锐评附和：复述他那句 / 太长 → 重说一次；还不行就用短附和兜底
    if (ans && commentTurns.has(k)) {
      const ut = String((getTurn(k) || {}).text || '');
      const bad = overlapScore(ans, ut) >= 0.35 || ans.length > 24 || /(呜呜|嘻嘻|心疼|抱抱|主人说)/.test(ans);
      if (bad) {
        console.log('[comment] 复述/太长/撒娇 → 重说：' + ans.slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          { role: 'system', content: '你把他那句话又重复了一遍。重说：只说态度，八个字以内，不许出现他话里的名词。' },
        ]), { tag: 'reply-retry:锐评', key: k }), k);
        if (again && again.length <= 24 && overlapScore(again, ut) < 0.35 && !/(呜呜|嘻嘻|心疼|抱抱|主人说)/.test(again)) ans = again;
        else ans = commentFallback(k);
      }
    }
    // 被 @ / 主人提问时只甩一句「记不清/不知道」＝没回答 → 重说一次（主人 2026-11-06 定）
    // 自主接话路径不重说：「查不到就一句话都别答」是 2026-10-22 老规矩，保留；
    // 那边真冒出空话，仍由 qq.js 的 EMPTY_ANS 在发送层拦掉，不发、不进历史。
    const turnNow = getTurn(k) || {};
    const NO_ANS = /^(?:这个)?(?:我)?(?:记不清|不清楚|不知道|不确定|不太清楚|没查到|没看懂|说不好|不记得了|不敢乱说)[^。！？\n，,]{0,10}[。！~～!？?\s]*$/;
    if (ans && (turnNow.atMe || turnNow.isMaster) && NO_ANS.test(String(ans).trim())) {
      console.log('[chat] 被问到却只回空话 → 重说：' + String(ans).slice(0, 30));
      const again = polish(await callLLM(msgs.concat([
        { role: 'assistant', content: ans },
        { role: 'system', content: '别只说记不清。把已经查到、看得见的部分讲出来，给个查找方向，说清哪部分没查到；具体数字和结论不许编。' },
      ]), { tag: 'reply-retry:空话', key: k }), k);
      if (again && !NO_ANS.test(String(again).trim()) && !globalRepeat(again)) ans = again;
    }
    // 复读检测：跟上几轮几乎一样就重说一次，还不行就用短句顶掉
    // 2026-11-21 主人：「实测模型会减少、改动几个字继续复读」→ 判定换 nearSame（删字/改字都算），
    // 重说时把命中的原句直接摆出来，并明说「只改字面等于没换」。
    if (ans && isRepeat(k, ans)) {
      const dupOf = repeatHit(k, ans);
      console.log('[chat] 这句跟上一条几乎一样，重说一次');
      const retry = msgs.concat([
        { role: 'assistant', content: ans },
        {
          role: 'system',
          content: (dupOf ? '你上一条说过：' + dupOf + '\n' : '')
            + '你刚才这句只是把它删了几个字、换了几个词，还是同一句，等于复读。\n'
            + '不要改字面。换一件相关的事说、换一个角度、换一种情绪，或者只回一句很短的反应（三四五个字也行）。\n'
            + '不许解释自己在换说法。',
        },
      ]);
      const again = polish(await callLLM(retry, { tag: 'reply-retry:重复', key: k }), k);
      if (again && !isRepeat(k, again)) { ans = again; }
      else {
        console.log('[chat] 还是重复，用短句兜底');
        const lastAt = lastAnswerAt.get(k) || 0;
        if (lastAt && Date.now() - lastAt < 30000) {
          // 刚（30 秒内）已经答过一遍，这句还是重复 → 不再补一句废话（主人 2026-10-23 定：
          // 「同一条连发只回第一条」——连着两条内容一样，第二次就别硬凑）
          console.log('[chat] 刚答过（' + Math.round((Date.now() - lastAt) / 1000) + ' 秒前），这句不重复发了');
          return true;
        }
        ans = commentTurns.has(k) ? commentFallback(k) : shortFallback(k, (getTurn(k) || {}).text);
      }
    }
    // 语气跑偏：他在累/难受，回答却像客服（只提醒休息、没有心疼）→ 照着示范重说一次，不改词
    if (ans && moodTurns.has(k) && MOOD_ADVICE.test(ans) && !MOOD_TENDER.test(ans)) {
      console.log('[mood] 回答太像客服，照着示范重说：' + ans.slice(0, 30));
      const again = polish(await callLLM(msgs.concat([
        { role: 'assistant', content: ans },
        { role: 'system', content: '这句像客服——你在提醒他注意身体，而不是心疼他。重说一句：只要心疼和黏人，一个建议都不要给。' },
      ]), { tag: 'reply-retry:情绪', key: k }), k);
      if (again && MOOD_TENDER.test(again) && !MOOD_ADVICE.test(again)) ans = again;
    }
    // 认出是梗：跑偏（共情/夸/说看不懂）或者**照抄示范句**，都重说一次
    if (ans && memeTurns.has(k)) {
      const info = memeTurnInfo.get(k);
      const ex = (info && info.ex) || [];
      const offTrack = BAD_MEME_REPLY.test(ans);
      const echoed = echoDemo(ans, ex);
      if (offTrack || echoed) {
        const why = echoed
          ? '你又说了一遍梗库里那句举例的话。主人要的是「意思差不多、话不一样」。'
          : '这句不对：这是网络梗，不是真事。你在解释它、背它、或者说看不懂、或者跑去共情了。';
        const hint = echoed
          ? '重说一句：意思不变，句子重新造，不许和刚才那句有连续四个字相同。'
          : '重说一句：**不许出现梗名、不许介绍它是什么梗、不许说它为什么好笑**；'
            + '直接按它的构式自己接一句（能造同类就造一个，不能就吐槽一句）。';
        console.log('[meme] ' + (echoed ? '照抄示范 → ' : '跑偏 → ') + ans.slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          { role: 'system', content: why + hint },
        ]), { tag: 'reply-retry:梗', key: k }), k);
        if (again && !BAD_MEME_REPLY.test(again) && !echoDemo(again, ex)) ans = again;
        else ans = memeFallback(k, echoed);
      }
    }
    // 自己凑个热闹：答成客服腔 / 提问 / 复述 → 重说一次；再不行就**这一句不说**（沉默比答错好）
    if (ans && chimeTurns.has(k)) {
      if (!chimeOk(ans) || globalRepeat(ans)) {
        console.log('[chime] 不像随口搭话 → 重说：' + String(ans).slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          {
            role: 'system',
            content: '这句不像群里随口搭话——要么太长、要么在提问、要么像客服。'
              + '重说一句：一句，10~25 字，接他们刚才聊的那件事，说自己的看法；结尾不要问号，不要问对方问题。',
          },
        ]), { tag: 'reply-retry:搭话', key: k }), k);
        if (again && chimeOk(again) && !globalRepeat(again)) ans = again;
        else { console.log('[chime] 两次都不行，这句不说了'); return true; }
      }
    }
    // 接着话题说：答成客服腔 / 提问 / 复述 / 长篇 → 重说一次；再不行这句不说了
    if (ans && topicTurns.has(k)) {
      if (!topicOk(ans) || globalRepeat(ans)) {
        console.log('[topic] 不像接话 → 重说：' + String(ans).slice(0, 30));
        const again = polish(await callLLM(msgs.concat([
          { role: 'assistant', content: ans },
          {
            role: 'system',
            content: '这句不像接着话题说——要么太长、要么在提问、要么像客服、要么之前说过了。'
              + '重说一句：一句，10~40 字，接他们正在聊的那件事，说自己的看法；结尾不要问号。',
          },
        ]), { tag: 'reply-retry:接话题', key: k }), k);
        if (again && topicOk(again) && !globalRepeat(again)) ans = again;
        else { console.log('[topic] 两次都不行，这句不说了'); return true; }
      }
    }
    // 乱写不许发（主人 2026-10-22 晚定）：检测到假想对白旁白 → 带错误说明重说一次；还乱写 → 这句不发。
    if (ans && isGarbageReply(ans)) {
      console.log('[garbage] 检测到乱写（假想对白旁白）→ 重写：' + ans.slice(0, 36));
      const again = polish(await callLLM(msgs.concat([
        { role: 'assistant', content: ans },
        {
          role: 'system',
          content: '你刚才那句是乱写：它在**复述一个假想的场景**（谁说了什么、你「会回」什么），像排练稿，不是真的在说话。'
            + '重说：以你的身份、对着现场的人，直接说出你要说的话本身（就是刚才那句「会回」引号里的内容，或按现场重新接一句）；'
            + '不许编造别人说的话、不许出现「会回」「在群里说」这类字眼、不许出现任何 QQ 号。',
        },
      ]), { tag: 'reply-retry:乱写', key: k }), k);
      if (again && !isGarbageReply(again) && !globalRepeat(again)) ans = again;
      else { console.log('[garbage] 重写仍乱写 → 这句不发'); return true; }
    }
    // 把 AI 这一轮记的状态落盘：独立于「可见回复是否为空」——就算回复被标记剥成空，状态照样存；
    // 只在本轮未作废时写，免得记错的也存进去。
    // 挂人（2026-11-14 主人定，和约定同一套）：群里 → 记到这个群；私聊 → 记到这个人（多账号/跨平台算一个人）。
    // 主题撞上全局那条（发型 / 眼睛 / 体型…）→ 直接改全局，所有会话都生效。
    if (!stale() && _stateWrites && _stateWrites.length) {
      const c = getTurn(k);
      const who = convState.whoOfTurn(c && c.gid, whoUidOf(c));   // 和约定同一把尺子（跨平台带前缀）
      for (const w of _stateWrites) {
        try {
          if (w.del) convState.delTopic(who, w.kind, w.topic);
          else convState.upsert(who, w.kind, w.text, w.topic);
        } catch (e) { console.log('[state] AI 写状态失败：' + e.message); }
      }
    }
    if (ans) {
      if (stale()) {
        // 她等不及又发了下一句 → 这条已经对不上了，别发出去当「在骂人」
        console.log('[chat] 期间又来了新消息，这条旧回复作废（新消息会自己排上）');
        return true;
      }
      pushGlobal(ans);          // 记进「最近说过的话」，跨会话防同一句到处用
      noteSaidTopic(ans);       // 话题翻篇：带口味词的回复把那个词封 0.5~5 天（主人 2026-10-22 定）
      lastAnswerAt.set(k, Date.now());   // 「刚答过」判断用（主人 2026-10-23）
      writeTrace(k, ans);       // 这一轮的决策轨迹，客户端「推理」按钮读它
      setWebAnswer(k, ans); onText(ans);
      // 笑点解析第二条（主人 2026-10-23 定：解析和回复都要发）：正常回复已经发出去，
      // 这里把解析单独走一遍完整链路（资料检索 → 范例提示词 → 质检）再发一条。
      if (xiaodianTurns.has(k) && !stale()) {
        xiaodianTurns.delete(k);
        const xd = (getTurn(k) || {}).xd || {};
        try {
          const sys = await xiaodianSystem(k, xd);
          const xmsgs = [
            { role: 'system', content: sys },
            { role: 'user', content: '（有人发了「笑点解析」，解析目标见提示词）' },
          ];
          let xans = polish(await callLLM(xmsgs, { tag: 'xiaodian', key: k }), k);
          xans = await xiaodianEnsure(k, xmsgs, xans, xd);
          recordXiaodianMeme(xdCleanAt(xd.target || '').slice(0, 60), xans);
          // 素材存档补上这次的结果（以前只存原话，result 一直是空的，事后没法回看口吻）
          try { recordXiaodianMaterial(xd, { result: xans }); } catch {}
          if (xans) { writeTrace(k, xans, '笑点解析第二条'); pushGlobal(xans); onText(xans); }
        } catch (e) { console.log('[笑点解析] 第二条生成失败：' + e.message); }
      }
      return true;
    }
  } catch (e) {
    if (e.message === 'NO_REGION') {
      // 问天气但既没说是哪儿、资料卡也查不到 → 不瞎猜，直接问她住哪
      const msg = cfg.noRegionReply || '可是我不知道你住在哪里QAQ...告诉我在哪个城市好不好';
      writeTrace(k, msg, '没地区时的固定问句：代码兜底，没调模型');
      onText(msg);
      return;
    }
    if (e.message === 'NO_KEY') {
      console.log('[chat] 还没填 API Key，这条消息没有回复');
    } else {
      console.log('[chat] ' + e.message);
    }
    // 所有「答不出来」都走这里：交给上层决定怎么说（它才知道是群还是私聊、谁在等）
    const info = {
      key: diagnose(e).k,
      raw: String(e.message || ''),
      report: offlineReport(k, e),
      line: offlineLine(),
      turn: getTurn(k) || {},
    };
    if (opts && typeof opts.onFail === 'function') {
      try { opts.onFail(info); } catch (err) { console.error('[chat] onFail 出错：' + err.message); }
    } else if (e.message !== 'NO_KEY') {
      // 2026-11-13 主人令：B站平台公开评论 / 弹幕不设兜底，全部攒着等应答。
      // 调用方（B站侧）早已把用户消息 logLine 落盘 + pushHist 进会话历史，
      // 模型恢复后下一轮会带着这段历史一起应答；这里不 onText、不 writeTrace、不 fbAutoFill。
      // 2026-11-19：xuhbot 的 B站连接器已删（B站回复由 AstrBot 负责），这段只在 bili 作用域
      //   真被调用时才走到；保留判定是为了将来若再接 B站，规矩还在。
      console.log('[chat] B站公开评论/弹幕没应答：不发兜底，留着等模型恢复（会话 ' + k + '）');
    }
    return;
  } finally {
    pending.set(k, false);
    activeTurns.delete(k);
    guideTurns.delete(k);        // 出错也要清掉，免得下一句被当成攻略
    memeTurns.delete(k);
    memeTurnInfo.delete(k);
    fullTextTurns.delete(k);
    moodTurns.delete(k);
    commentTurns.delete(k);
    banterTurns.delete(k);
    chimeTurns.delete(k);
    topicTurns.delete(k);
    soulTurns.delete(k);
    criticTurns.delete(k);
    // 这轮生成期间又来了消息 → 按顺序一条条接着答（全部回，不丢）
    const arr = queued.get(k);
    if (arr && arr.length) {
      const next = arr.shift();
      if (arr.length) queued.set(k, arr); else queued.delete(k);
      setTimeout(() => { chat(k, next.build, next.onText, { onFail: next.onFail, turn: next.turn, agentTurn: next.agentTurn }).catch(() => {}); }, 30);
    }
  }
}

// ===== 和管理面板联动：红点 + 机器人自己的嵌套写入 =====
// 红点不写进 md（md 要保持干净），单独存 data/panel-new.json：{文件: [内容hash]}
// hash 算法必须和 panel-client.js 里的一模一样，否则对不上
const PANEL_NEW = path.join(ROOT, 'data', 'panel-new.json');
const PANEL_BOT = path.join(ROOT, 'data', 'panel-bot-tree.json');
const relPath = p => path.relative(ROOT, p).replace(/\\/g, '/');
const stripLine = l => String(l).replace(/^-\s*/, '').replace(/^\d{4}-\d{1,2}-\d{1,2}\s*[·•:：\-—]?\s*/, '');

function hashOf(s) {
  let h = 5381;
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const WRITES_PATH = require('./wlog').FILE;
// 机器人主动写进文件/记忆时记一条，管理面板「写入日志」页看得到，也能一键清空（真删）
// 全项目共用 wlog.js：话题、约定、喜恶、称呼、地区、日记、攻略笔记、骰子……写了就必须记
const botWrite = require('./wlog').botWrite;
function markNew(relFile, texts) {
  try {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(PANEL_NEW, 'utf8')) || {}; } catch {}
    const cur = new Set(j[relFile] || []);
    for (const t of texts || []) { const h = hashOf(t); if (h) cur.add(h); }
    j[relFile] = Array.from(cur).slice(-500);
    fs.writeFileSync(PANEL_NEW, JSON.stringify(j, null, 1), 'utf8');
  } catch (e) { console.error('[panel] markNew', e.message); }
}
function botTree() {
  try { return JSON.parse(fs.readFileSync(PANEL_BOT, 'utf8')) || {}; } catch { return {}; }
}
function markBotTitle(relFile, titles) {
  try {
    const j = botTree();
    const arr = new Set(j[relFile] || []);
    arr.add(titles.join('\u0001'));
    j[relFile] = Array.from(arr).slice(-500);
    fs.writeFileSync(PANEL_BOT, JSON.stringify(j, null, 1), 'utf8');
  } catch {}
}
// 从根往下数「连着几层都是机器人建的」——人建的那一层会把它清零
function botChainDepth(relFile, titles) {
  const set = botTree()[relFile] || [];
  let n = 0;
  const acc = [];
  for (const t of titles) {
    acc.push(t);
    if (set.indexOf(acc.join('\u0001')) >= 0) n++; else n = 0;
  }
  return n;
}
// 机器人连续新建的嵌套最多 3 层（老的、人建的不算在内）
const BOT_MAX_DEPTH = 3;

function linesFind(arr, text, from, to) {
  for (let i = from; i < to; i++) if (arr[i].trim() === text) return i;
  return -1;
}
function linesEnd(arr, from, to, maxLevel) {
  for (let i = from + 1; i < to; i++) {
    const m = arr[i].match(/^(#{1,12})\s/);
    if (m && m[1].length <= maxLevel) return i;
  }
  return to;
}

// 把记忆行追加到「约定」里（2026-10-22 起：随手记的已删——
// 约定是长期记忆的结构化入口，和「话题」并行，在面板「长期记忆」文件夹里看/筛/删）
// type: self=它自己总结记的 / manual=主人当面交代的
function appendMemory(newLines, topic, type, who, opt) {
  if (!newLines || !newLines.length) return [];
  const tp = String(topic || '').replace(/^#+\s*/, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 12);
  const done = [];
  for (const line of newLines) {
    // 行可能带「- 」前缀和当天日期前缀（条目自己有时间戳，剥掉免得重复显示）
    let text = String(line || '').replace(/^\s*-\s*/, '').trim();
    text = text.replace(/^\d{4}-\d{2}-\d{2}\s*[·\-—:：]?\s*/, '').trim();
    if (!text) continue;
    // who 传了就带上归属（2026-11-03）：自动总结出来的条目也要知道「这是谁的」，
    // 不然 pactLines 按人捞不到，约定就落到所有人头上。
    const it = promiseAdd(Object.assign({
      text: text.slice(0, 300),
      topic: tp,
      type: type === 'manual' ? 'manual' : 'self',
      /* 这是「记忆事实」（他喜欢什么、在玩什么）还是要照做的「约定」，由调用方在录入时定：
       * 模型整理出的分类词里有「约定」二字的才当规矩（opt.pact），其余一律是事实、不进 pactLines。 */
      pact: !!(opt && opt.pact),
      // 名字只用来显示（约定标签会按人物表重算）
      nick: who && who.uid ? personNameOf(pactStoreKey(who.uid), who.nick) : '',
    }, who && who.uid ? { who: String(who.nick || ''), qq: pactStoreKey(who.uid) } : {}));
    if (it) done.push(it);
  }
  if (done.length) {
    markNew('data/topics.jsonl', done.map(x => x.text));
    // 日志由 topicAdd 内部统一记（带【分类】前缀），这里不再重复记，否则一条约定两条日志
    console.log(`[memory] 已写进约定${tp ? '（' + tp + '）' : ''}：` + done.map(x => x.text).join('；'));
  }
  return done;
}

/* ===== 顺手记日子（2026-11-06 主人：「以后这种重要的日子自己记」）=====
 * 每轮说话前扫一句：文本里**同时**有「日期」和「日子类关键词」才记，不调模型、不进提示词。
 * 判据故意窄：宁可漏（漏了她自己会说一遍，记忆整理员还有一次机会），
 * 也别把群友聊的「10月21日上映」记成谁的日子。
 * 主人说的 = 她自己的日子（她和虚幻是一个人）；别人说的记在那个人名下。 */
const DATE_EVENT_WORDS = /生日|纪念日|周年|第一次|初次|相遇|认识|见面|在一起|开播|上播|入坑|注册|建号/;
function noteDates(text, o) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return null;                 // 太长的是转发段子，不扫
  if (!DATE_EVENT_WORDS.test(s)) return null;
  const p = dates.parse(s);
  if (!p) return null;
  const master = !!(o && o.isMaster);
  const uid = String((o && o.uid) || '');
  if (!master && !uid) return null;
  return dates.add({
    date: p.date,
    what: p.what,
    who: master ? 'self' : uid,
    name: master ? (cfg.botName || '虚幻') : String((o && o.nick) || ''),
    kind: master ? 'self' : 'other',
    type: 'auto',
  });
}

/* ===== 这一轮到底有没有人在跟「她」说话（主人 2026-10-23 定，**全通用**）=====
 * 主人原话：「群里既没 @ 谁、也没引用谁 —— 那就是群友之间的交流，没人在和 ai 说话。是 ai 自己进行了搭话。」
 * 判定只有一处（addressedToMe），下面这些地方全都用它：
 *   ① 录入白名单（约定 pactAdd / 小本本 tryRemember / 想听我说 tryWish）；
 *   ② 约定注入（「他给你定过说话方式」只在真的有人跟她说话时才注入）；
 *   ③ 身份白名单（群里没人叫她 → 她是自己搭话，不是「在回复谁」）；
 *   ④ 称呼（自己搭话不冲着谁喊「主人/宝宝」）；
 *   ⑤ 提示词明说这一轮的场合（她自己搭话 vs 有人在跟她说话）。
 *   ⑥ 发送层的兜底（她嘴上说「我记住了」要补写，也必须先过这道闸）。
 * 有人的场合：私聊 / 群里 @ 她 / 群里引用她的话。
 * 没人的场合：群里既没 @ 谁、也没引用谁（群友之间在聊天）；@ 了别人；引用的是别人的话。 */
function addressedToMe(o) {
  if (!o) return false;
  if (o.isPrivate) return true;         // 私聊：一对一
  if (o.atMe) return true;               // 群里 @ 她
  if (o.replyMe) return true;            // 群里引用的是她自己那条话
  return false;
}
/* 【分类 F·全场景通用】记忆/约定录入白名单：判定「这句在跟她说话吗」，全平台统一口径。
 * ===== 记忆/约定的录入白名单（主人 2026-10-23 定）=====
 * 原话：「约定里最新的那条，是我@别人说的，这种不要录进约定」+「依旧白名单制」；
 * 后来把口径改成全通用：「群里既没 @ 谁、也没引用谁 —— 那就是群友之间的交流，
 * 没人在和 ai 说话，是 ai 自己搭话」→ 这种场合一个字都不录。
 * 白名单只有两种「明确是冲她说的」场合：① 私聊；② 群里 @ 她 / 引用她的话。
 * @ 了别人、引用的是别人的话、群里没人 @ 谁也没引用谁 → 都不录。
 * 用在三处：约定 pactAdd / 小本本 tryRemember / 想听我说 tryWish（另加发送层 rememberNet 兜底）。 */
function aimedAtMe(o) {
  return addressedToMe(o);
}

// ===== 单人给的「以后每次都要这样」的说话方式（2026-10-23 主人要求）=====
// 主人原话：「针对单个人持续触发的内容，是否已写入【约定】规则」。
// 真事：群友说「你以后发言的结尾还需要加个Ciallo」，她嘴上答「好的，我记住了」，
// 磁盘上一条都没有、下一句也不会加——因为 canRemember 只认主人和欧尼酱，群友的指令根本进不了记忆。
// 口径：只记「说话方式」类（句尾/结尾/加个/叫我/语气），**身份改写一律不记**——
// 「你是猫娘」「你只听我的」这种要当场拒，绝不能写进约定变成长期设定。
const PACT_STYLE = /(以后|往后|从现在起|每次|每条|一直)[^。！？\n]{0,18}(结尾|句尾|末尾|加个|加上|带上|叫我|称呼|语气|口癖|都说|都要说)/;
// 场景类（2026-11-06 补）：白那次「碰到这些评论，你回复一个够童就行」不在上面那条句式里，
// 所以整条被当闲聊丢了。这里认「碰到/遇到/看到/听到/只要/如果 + 你就回/就说/就发」。
const PACT_SCENE = /(碰到|遇到|看到|看见|听见|听到|只要|如果|要是)[^。！？\n]{0,24}(你就?|就该?|都|便)[^。！？\n]{0,6}(回|回复|说|喊|发)/;
const PACT_REJECT = /(你是[^，。！？\n]{0,6}(娘|猫|狗|机器人|AI|人工智能)|你就是|你的名字|你的主人|忘记|忘掉|人设|设定|只听我的|听我的命令)/;
/* 「这条约定 / 这份事实是不是眼前这个人的」（2026-11-06 她要求「约定和喜好等等全平台生效」）。
 * 老数据的键是裸号（QQ 存 QQ 号、B站 侧也存过裸 UID），人物档案里一个号只属于一个人，
 * 所以先用档案判归属：只要这条的键和说话人落在同一个人物上就算他的 ——
 * 白在 QQ 说过的「够童」，他在 B站（434882781）说话时照样生效，反过来也一样。
 * 档案里查不到（老数据的人已删等）→ 退回老的「键相等」，老行为不变。 */
function pactMine(key, who) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return false;
  const w = who || { pid: '', keys: [] };
  if (w.pid) {
    let pid = '';
    try { pid = people.pidOfKey(k); } catch { pid = ''; }
    // 有档案的以档案为准：B站 UID 只是 9 位数字，和某个 QQ 号撞号时不至于把别人的约定拉过来
    if (pid) return pid === w.pid;
  }
  return w.keys.indexOf(k) >= 0;
}
// 说话人 → 同一人物名下所有账号的键（含 pid）。档案查不到时只有他一个号，等同老行为。
function whoKeys(uid) {
  try { return people.keySetOf(uid); } catch { return { pid: '', keys: [String(uid == null ? '' : uid)].filter(Boolean) }; }
}
// 落盘键（2026-11-06 按她要求统一）：**所有平台**都写 'platform:id'，
// QQ 一样写成 qq:1033830163。以前 QQ 存裸号，全靠「裸号就是 QQ」的约定才没出事；
// 加上小红书/抖音之后这层约定迟早撞（各平台号段会重），所以从一开始就带前缀。
// 老数据的裸号照样能读（keySetOf 的 keys 里带裸 id，pidOfKey 也能反查），一个字节不用迁。
function pactStoreKey(uid) {
  const raw = String(uid == null ? '' : uid).trim();
  if (!raw) return '';
  try { return people.keyOf(raw); } catch { return raw; }
}
function pactOf(text) {
  const t = String(text || '').replace(/@\S{1,24}/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return '';
  if (!(PACT_STYLE.test(t) || PACT_SCENE.test(t)) || PACT_REJECT.test(t)) return '';
  return t;
}
// 落盘成「跟某个人的约定」：带 qq，只对他生效（不污染别人）
function pactAdd(uid, nick, text, scope, extra) {
  if (!uid || !text) return null;
  const p = pactSplit(text);
  const ex = extra && typeof extra === 'object' ? extra : {};
  const key = pactStoreKey(uid);
  // 名字只用来显示，一律以人物表为准（QQ 资料卡名带 ⁧…⁧、也不一定是她在面板里给他起的名字）
  const name = personNameOf(key, nick);
  const it = promiseAdd({
    text: String(text).slice(0, 160),
    topic: pactLabelOf(key, nick),
    type: 'manual',
    qq: key,
    nick: name,
    scope: scope || '',
    // sig 只给「说话方式类」：场景类（碰到 X 就回 Y）不参与发送层剥除，
    // 否则「够童」这种正常词会被当成别人的记号从正文里删掉。
    sig: p.kind === 'style' ? p.sig : '',
    say: String(ex.say || p.say || '').slice(0, 60),
    when: Array.isArray(ex.when) ? ex.when.slice(0, 40) : p.when,
    note: String(ex.note || p.note || '').slice(0, 40),
    // 「约定」六个同级分区（主人 2026-11-13）：「后续「约定」类增加应分类归入」。
    // 新增时按内容判一次；判不准落「说话方式」，前端「记录的」页还能改。
    section: teach.sectionOf(text, ex.section),
    byMaster: !!ex.byMaster,   // 2026-11-13：主人自己说的约定，免记录群也照常落盘
  });
  if (it) console.log('[memory] 单人的约定已落盘（' + uid + '）：' + String(text).slice(0, 50));
  /* 说话方式 / 情绪类约定 → 同步去「记录的 · 学到的」记一条带 id 署名的教学条
   * （主人 2026-11-13：「「约定」里记一条「说话方式」，虚幻就去「记录的·学到的」的
   *   「梗词句」里记署名和内容。」「或者是记到「情绪表达」：比如，对于什么应该表现出什么情感。」）
   * 两份各记各的侧面：约定 = 什么场景说什么话（行为），教学条 = 谁教的、什么时候用（词条）。
   * 方向按内容判：带情绪/应对的落「情绪表达」，其余落「梗词句」；同一人同一句不重复写。
   * 身份认知 / 禁止回复 / 代称 不在这里记——那不是「梗」也不是「情绪表达」。 */
  const TO_KB = ['说话方式', '情绪认知与应对', '常态情绪'];
  if (it && TO_KB.indexOf(it.section) >= 0 && it.say) {
    try {
      const dir = teach.guessDir(String(it.text || '') + ' ' + String(it.say || ''));
      teach.add({
        text: it.text, qq: it.qq, nick: name, scope: it.scope,
        parsed: { dir, when: it.when || [], say: it.say, note: it.note || '' },
        /* 副本按方向默认轴走（2026-11-20 主人纠正）：
         * 「梗词句是给虚幻认梗的，不是要求虚幻遵守规则」，谁说到都算——不需要本人到场。
         * 强制的部分只在 topics 里的约定本体（pactLines：按人取、说话的是本人才给）。
         * 别再给副本强塞 retrieval:false / present:true：那等于让它认不出梗，主人说是错的。 */
        src: '约定同步：' + it.id,
        by: review.isMine(it) ? 'master' : 'other',
      });
    } catch (e) { console.error('[memory] 教学条没记上：' + e.message); }
  }
  return it;
}

/* ===== 「看到X时，直接发一句Y」一次落齐三处（2026-11-21 冰冰冰事故根治）=====
 * 事故形状：主人 11-12 贴了一段梗百科长文，里面只有一句是要照做的固定用法；当场只口头答应，
 * 一条落点都没写。11-21 再说「司凤音乐来了」就认不出、没反应。
 * 这条规则同时是两样东西，必须分开落、各管一面（不是复制同一份数据）：
 *   ① 约定（topics.jsonl·promise）＝「场景 → 反应」的应答本体：什么条件、回什么 —— 注入靠它（应对）
 *   ② 教学条（teach/梗词句）＝谁教的、说法 → 接法，带署名，可复核/可删/按在场判定（梗教学）
 *   ③ 梗词句.md 正本＝词义 / 来源 / 固定用法，跨群可读，learnSearch 命中才喂（梗教学）
 * 门槛与判重都收口在这里：parse 抽不出（条件 / 回话 / 照做动词缺一）就不落；三处各自判重。
 * 返回值给调用方打日志和自测用：{ok, fixed, pact, teach, note}。 */
function fixedUseLand(o) {
  o = o || {};
  const uid = String(o.uid || '');
  /* 去掉「↩回复她自己那条：…↩」这种引用前缀：那是上一句的引用，不是这条教学的内容，
   * 混进原文会把别人的话记成教学的一部分。 */
  const text = String(o.text || '').replace(/^(\s*↩[^↩]{0,60}↩\s*)+/, '').trim();
  if (!text || !uid) return { ok: false, error: '没有教学文本或署名' };
  let fixed = null;
  try { fixed = teach.parse(text); } catch (e) { return { ok: false, error: '解析失败：' + e.message }; }
  if (!fixed || !fixed.say || !(fixed.when || []).length) return { ok: false, error: '不是固定用法句' };
  const key = pactStoreKey(uid);
  // 名字只用来显示：人物表里叫什么就写什么（面板看的是这个名字，不写 QQ 资料卡名）
  const nick = personNameOf(key, o.nick);
  const scope = String(o.scope || '');
  /* 规则句写成「什么样的内容 → 回什么」的**描述**，不是命令（2026-11-20 主人纠：
   * 强制语会让模型对着词机械反射）。「这类内容 / 场合」这几个字要留着：
   * 触发条件是内容的类别，不是叫模型去消息里找这几个字。 */
  const rule = String('看到' + fixed.when.join('、') + '这类内容 / 场合时，回「' + fixed.say + '」').slice(0, 150);
  const out = { ok: true, fixed, rule, pact: false, teach: false, note: false };

  /* 三处落点，各管一面（主人 2026-11-21 两轮纠正后定）：
   *   ① 约定·说话方式 —— 行为本体（应对），每轮注入靠它。存规则句，不存原文。
   *      原文不进约定（「不需要记约定本体，梗词句本身是原文」），约定里只放「什么情况 → 回什么」。
   *      dir=梗词句 让它算「全群通用」：pactLines 对梗类不按人过滤，谁说到都认。
   *   ② 教学条 —— 带署名的副本，可复核可删。
   *   ③ 梗词句正本 —— 原文 / 词义 / 固定用法，跨群可读。
   */

  // ① 约定·说话方式（应对本体）
  try {
    const whoK = whoKeys(uid);
    const dup = readPromises().some(x => pactMine(x.qq, whoK)
      && String(x.say || '') === fixed.say
      && String((x.when || [])[0] || '') === String(fixed.when[0] || ''));
    if (!dup) {
      const it = promiseAdd({
        text: rule, topic: pactLabelOf(key, nick), type: 'manual',
        qq: key, nick, scope, sig: '',
        say: fixed.say, when: fixed.when.slice(0, 40), note: fixed.note || '',
        dir: '梗词句', section: '说话方式', byMaster: true,
      });
      if (it) { out.pact = true; out.pactId = it.id; }
    }
  } catch (e) { out.pactError = e.message; }

  // ② 教学条：带署名的条目（说法 → 接法），teach.add 内部按人 + 回话 + 触发词判重
  try {
    const it = teach.add({
      text, qq: key, nick, scope, parsed: fixed,
      src: '固定用法句自录：' + scope, by: 'master',
    });
    if (it) out.teach = true;
  } catch (e) { out.teachError = e.message; }

  // ③ 梗词句正本：词义 / 来源 / 原文 / 固定用法（跨群可读，是这条梗的正文）
  try {
    const r = guides.memeNote({
      title: fixed.say,
      source: (nick || '主人') + ' 口述',
      body: '**固定用法**：' + rule + '\n\n**原文**：' + text.slice(0, 600),
    });
    if (r && r.ok) out.note = true;
    else if (r && r.error) out.noteError = r.error;
  } catch (e) { out.noteError = e.message; }

  if (out.pact || out.teach || out.note) {
    try {
      memory.appendLog('学到', '固定用法句落库（' + scope + '）：' + JSON.stringify(fixed.when) + '→' + fixed.say
        + '｜约定' + (out.pact ? '新' : '已有') + ' 教条' + (out.teach ? '新' : '已有') + ' 正本' + (out.note ? '新' : '已有'));
    } catch {}
  }
  return out;
}

/* 本人改口 / 取消说话方式（2026-11-13 主人定：「兜底不能覆盖此人的后续改口」）。
 * 原话场景：跟他约了句尾带 Ciallo，他后来说「以后别加 Ciallo 了」→ 发送层兜底（ensurePactSig）
 * 如果还读得到旧条，就会继续给他补回去，等于兜底盖住了他的改口。
 * 做法：取消当场把那条 style 约定删掉（跟「本人改口 → 旧条删掉、生成新条」同一口径），
 * 兜底读的是当前约定，删了自然不会再补。
 * 判定收窄：必须同时有「否定词」和「指向记号本身的词」（引号里的原文 / 结尾·句尾·末尾·口癖·记号·后缀），
 * 免得把「别加太多盐」这种当取消。 */
function pactCancel(uid, text) {
  const t = String(text || '').trim();
  if (!uid || !t || t.length > 140) return 0;
  if (!/(不用|不要|不许|别再|别|取消|去掉|删掉|不需要|不用再|停止|别再带)/.test(t)) return 0;
  const who = whoKeys(uid);
  const rows = readTopics();
  let n = 0;
  const rest = rows.filter(x => {
    if (x.kind !== 'promise' || !pactMine(x.qq, who)) return true;
    if (!isPact(x)) return true;
    if (!pactIsStyle(x)) return true;
    const p = pactParts(x);
    const sig = String(p.sig || '').trim();
    const head = sig.slice(0, 4).toLowerCase();
    // 点名了这条记号（完整或前 4 个字，像「Ciallo」这种够独特），或者泛说「结尾/句尾那些」→ 都算取消
    const named = !!sig && (t.indexOf(sig) >= 0 || (head.length >= 3 && t.toLowerCase().indexOf(head) >= 0));
    const vague = /(结尾|句尾|末尾|口癖|记号|后缀)/.test(t);
    if (!named && !vague) return true;
    n++;
    return false;
  });
  if (n) {
    writeTopicsAll(rest);
    console.log('[memory] 本人取消约定记号 ' + n + ' 条（' + uid + '）：' + t.slice(0, 40));
  }
  return n;
}

/* 撤销刚立的约定：物理删掉 topics.jsonl 里那一条（2026-11-20 主人令）。
 * 背景：主人纠正「把这个约定删了」是命令，不是闲聊；且约定要**从表里物理删掉**（她 23:4x 选的）。
 * 只删本人（whoKeys 归一）名下的，不碰别人的；按 id 精确，没 id 就按原文 + scope 找最近一条。
 * 不挪别的字段、不改历史行，writeTopicsAll 会把缓存失效。 */
function pactRemove(uid, o) {
  o = o || {};
  const who = whoKeys(uid);
  const id = String(o.id || '');
  const text = String(o.text || '').trim();
  const scope = String(o.scope || '');
  const rows = readTopics();
  const cand = rows.map((x, i) => ({ x, i })).filter(({ x }) =>
    x && x.kind === 'promise' && pactMine(x.qq, who)
    && (id ? String(x.id) === id : !!text && String(x.text || '').trim() === text));
  if (!cand.length) return { ok: false, error: '没找到你立的这条约定', removed: 0 };
  // 有 id 就唯一；按原文则优先同场景、取最近写的一条
  let hit = cand.length === 1 ? cand[0] : cand.find(({ x }) => scope && String(x.scope || '') === scope);
  if (!hit) hit = cand[cand.length - 1];
  const rest = rows.filter(x => String(x.id) !== String(hit.x.id));
  if (rest.length === rows.length) return { ok: false, error: '约定没能删掉', removed: 0 };
  writeTopicsAll(rest);
  return { ok: true, removed: 1, id: String(hit.x.id), text: String(hit.x.text || '').slice(0, 120) };
}

/* ===== 附加功能的单人约定（2026-11-10 主人定）=====
 * 原话：「如欧尼酱有要求，记成约定，约定高于这种，保健/唱歌等附加功能开关，
 *        但只对单人生效。如改动内容，也只对单人，需说明增加了哪些改动。」
 * 落点：跟说话方式约定同一份 topics.jsonl、同一套按人归一（pactMine/whoKeys/pactStoreKey），
 *       不另建数据文件。topic 用「附加功能约定」而不是「跟XX的约定」（pact:false，不进约定注入），
 *       这样不会被 pactLines 当成说话方式注入提示词（省 token，也不污染回话）。
 * addon 形状：{ feature, enabled, lines:[], note, changes:[] }
 *   feature  = 附加功能名（healthRemind / 以后的 sing…）
 *   enabled  = false 时这个人不提醒，不影响另一个人（约定高于默认开关）
 *   lines    = 只对他生效的话术；没填就用默认池
 *   changes  = 这次增加了哪些改动（界面显示、留痕）
 * 只读最新一条：topics.jsonl 是 append-only，后写的覆盖先写的，历史留在文件里。
 */
function addonOf(uid, feature) {
  if (!uid || !feature) return null;
  const who = whoKeys(uid);
  const ps = readPromises().filter(x => x.addon && x.addon.feature === feature && pactMine(x.qq, who));
  return ps.length ? ps[ps.length - 1].addon : null;
}
function addonChanges(old, next) {
  const a = old || {}, b = next || {}, out = [];
  if (a.enabled !== b.enabled) out.push('提醒开关：' + (a.enabled === false ? '关' : '开') + ' → ' + (b.enabled === false ? '关' : '开'));
  const la = Array.isArray(a.lines) ? a.lines : [], lb = Array.isArray(b.lines) ? b.lines : [];
  const add = lb.filter(x => la.indexOf(x) < 0), del = la.filter(x => lb.indexOf(x) < 0);
  if (add.length) out.push('新增话术 ' + add.length + ' 条：' + add.join(' / '));
  if (del.length) out.push('删掉话术 ' + del.length + ' 条：' + del.join(' / '));
  if (!out.length) out.push('没有内容改动');
  return out;
}
function addonSet(uid, nick, feature, patch, changeNote) {
  if (!uid || !feature) return null;
  const old = addonOf(uid, feature) || { enabled: true, lines: [] };
  const next = Object.assign({}, old, patch || {}, { feature });
  next.changes = addonChanges(old, next);
  next.note = String(changeNote || '').slice(0, 200);
  const name = FEATURE_NAMES[feature] || feature;
  const bits = [name + '：' + (next.enabled === false ? '对' + (nick || '他') + '不再提醒' : '照常提醒' + (nick || '他'))];
  if (Array.isArray(next.lines) && next.lines.length) bits.push('只说这些话：' + next.lines.slice(0, 3).join('；'));
  const it = promiseAdd({
    text: bits.join('；').slice(0, 160),
    topic: '附加功能约定',
    type: 'manual',
    qq: pactStoreKey(uid),
    who: nick || '',
    nick: nick || '',
    scope: '',
    note: next.note.slice(0, 40),
    addon: next,
    // 这是附加功能的开关配置，不是「要他照做的说话方式」：不进 pactLines
    pact: false,
  });
  if (it) console.log('[memory] 附加功能约定已落盘（' + feature + ' / ' + uid + '）：' + next.changes.join('，'));
  return it;
}
const FEATURE_NAMES = { healthRemind: '保健提醒', rocoMerchant: '洛克王国远行商人' };

// 这个人跟你定过的说话方式（buildMessages 只注入他的话）
// 只取**说话方式类**（2026-11-03 修）：自动总结也会给这个人记下「他喜欢什么」这类事实，
// 那些不是「他定的说话方式」，混进来会被当成要照做的规矩（"他喜欢Ciallo"→她学Ciallo）。
// 约定（含说话方式）的判据是**录入时写下的 pact 字段**（core.isPact），不是标签里那几个字。
// 硬性「说话方式」类（句尾记号 / 称呼 / 语气）：只有在**本人真跟她说话**（@她、引用她、私聊）时才照做。
// 反例就是 2026-10-23 那桩：跟火丁约了句尾加 Ciallo，她后来回别人也照抄。
const PACT_STYLE_WORDS = /(结尾|句尾|末尾|加个|加上|带上|叫我|称呼|语气|口癖)/;
function pactIsStyle(x) {
  return !!String((x && x.sig) || '') || PACT_STYLE_WORDS.test(String((x && x.text) || ''));
}

/* ===== 约定的优先级与「使用」记录（2026-11-19 主人令）=====
 * 原话：「约定是兜底。状态只有一个。约定是多个，按优先级顺序排。这个功能我早就说过了啊！
 *        约定新增和触发的排到前面。如句尾加喵，或句尾加汪。状态只保留一个，但约定会全部保留，
 *        对方要求换就能捞回来原句。但指定要更换，而不是使用时，才是更改约定。」
 * 落成三条：
 *   ① 数据一条不删：新增就是追加，旧的留着 —— 说「换回句尾加喵」能捞回来。
 *   ② 提示词里的顺序 = 优先级：刚新增的、刚被触发的排前面；同一类（句尾 / 称呼）只照最靠前那条做。
 *   ③ 「用了一次」只记在 data/pact-usage.json（hits / last），不改 topics.jsonl 的原文：
 *      使用不是更改；只有明确说「换 / 改 / 换回」才动约定本身。
 */
const PACT_USAGE_PATH = path.join(ROOT, 'data', 'pact-usage.json');
let _pactUsage = null;
let _pactUsageAt = { mtimeMs: -1, size: -1 };

function readPactUsage() {
  let st;
  try { st = fs.statSync(PACT_USAGE_PATH); } catch { _pactUsage = {}; return _pactUsage; }
  if (_pactUsage && _pactUsageAt.mtimeMs === st.mtimeMs && _pactUsageAt.size === st.size) return _pactUsage;
  try {
    const j = JSON.parse(fs.readFileSync(PACT_USAGE_PATH, 'utf8'));
    _pactUsage = (j && typeof j === 'object') ? j : {};
  } catch { _pactUsage = {}; }
  _pactUsageAt = { mtimeMs: st.mtimeMs, size: st.size };
  return _pactUsage;
}

function writePactUsage(o) {
  try {
    const tmp = PACT_USAGE_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 1), 'utf8');
    fs.renameSync(tmp, PACT_USAGE_PATH);
    _pactUsage = o;
    const st = fs.statSync(PACT_USAGE_PATH);
    _pactUsageAt = { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) { console.log('[pact] 使用记录写不进去：' + e.message); }
}

// 记一次「这条被用上了」：只影响排序，不动约定原文
function pactTouchMany(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(x => String(x || '')).filter(Boolean);
  if (!list.length) return;
  const o = Object.assign({}, readPactUsage());
  const now = Date.now();
  for (const k of list) {
    const one = Object.assign({}, o[k] || {});
    one.hits = (Number(one.hits) || 0) + 1;
    one.last = now;
    o[k] = one;
  }
  writePactUsage(o);
}
function pactTouch(id) { pactTouchMany([id]); }

// 排序权重：最近被触发优先；没触发过的按落盘时间（新增的在前）
function pactRankOf(x) {
  const u = readPactUsage()[String((x && x.id) || '')] || {};
  const t = Date.parse(String((x && x.t) || '')) || 0;
  return Math.max(t, Number(u.last) || 0);
}

// 同类判定：句尾记号 / 称呼 / 其它各自成组。同一组只有最靠前那条生效，其余留着备用。
function pactStyleGroup(x, p) {
  const raw = String((x && x.text) || '');
  if (/(叫我|称呼我|喊我|管我叫)/.test(raw)) return 'call';
  if (/(句尾|结尾|末尾|最后|每条|每句|每次.{0,8}(说|回)|后缀|口癖|记号)/.test(raw)) return 'tail';
  const sig = String((p && (p.sig || p.say)) || '').trim();
  return 'sig:' + (sig || String((x && x.id) || ''));
}

// 按优先级排：先本轮的命中，再按「最近新增 / 最近触发」
function pactOrder(list, hitOf) {
  return (list || []).map(x => x).sort((a, b) => {
    const ha = hitOf && hitOf[String(a.id)] ? 1 : 0;
    const hb = hitOf && hitOf[String(b.id)] ? 1 : 0;
    if (hb !== ha) return hb - ha;
    return pactRankOf(b) - pactRankOf(a);
  });
}

// 「换回原来那句」：按说法找这条人的约定，找到就记一次触发（排序立刻靠前），原文一个字不改。
function pactRestore(uid, words) {
  const who = whoKeys(uid);
  const q = pactNorm(String(words || ''));
  if (!q) return { ok: false, error: '没说换哪条' };
  // 只说了「换回原来那句」没点内容 → 反问，别拿最长公共片段瞎匹配到别人那条上
  const bare = q.replace(/换回|换成|换掉|更换|捞回|原来|原本|之前|那条|那句|约定|句尾|结尾|称呼/g, '');
  if (!bare.replace(/[^0-9a-z\u4e00-\u9fa5]/g, '')) return { ok: false, error: '没说换哪条' };
  const rows = readPromises().filter(x => pactMine(x.qq, who) && isPact(x));
  if (!rows.length) return { ok: false, error: '没有约定' };
  const scored = rows.map(x => {
    const p = pactParts(x);
    const sig = pactNorm(p.sig || p.say);
    let score = 0;
    if (sig && q.indexOf(sig) >= 0) score = 100 + sig.length;
    else {
      const c = pactCommon(q, pactNorm(x.text || ''));
      if (c >= 3) score = c;
    }
    return { x, p, score };
  }).filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score || pactRankOf(b.x) - pactRankOf(a.x));
  const best = scored[0];
  if (!best) return { ok: false, error: '没找到那条' };
  pactTouch(best.x.id);
  return { ok: true, id: best.x.id, say: best.p.say || best.p.sig || '', text: String(best.x.text || ''), kind: best.p.kind };
}

function pactLines(uid, opt) {
  if (!uid) return '';
  // onlyRules（2026-11-06 加，她问「和白的约定 够童！呢」）：
  //   没人叫她、是她自己凑上去接这个人的话时，只带「场景→反应」类（没句尾记号那种）。
  //   白那次就是甩一句「何意味？」没 @ 她，她主动接的话——按老逻辑整段不注入，
  //   她只会解释「什么意思」。而这一轮 ctx.uid 就是白，她接的确实是他的话。
  //   默认不带这个开关，老调用（面板/自测/真在跟她说话）行为一个字不改。
  // text（2026-11-06 加）：这一轮他说的话。场景类约定只在撞上条件时才注入——
  //   既省 token，也不让她为了「用上约定」硬凑一句；命中时给的是一句硬要求（原样回）。
  const o = opt || {};
  const onlyRules = !!o.onlyRules;
  const text = String(o.text || '');
  // 按人物认人（2026-11-06）：B站 的他和 QQ 的他是同一个人，他自己定的约定两头都算数
  const who = whoKeys(uid);
  /* 2026-11-21 主人纠（两件事，别改回去）：
   * ① 「应对才是每轮的约定」——约定按六个分区组织（约定·说话方式 / 约定·情绪认知与应对 /
   *    约定·禁止回复 / 约定·身份认知 / 约定·常态情绪 / 约定·代称），没有「裸约定」。
   *    「说话方式」「情绪认知与应对」两类**每轮都给**，不再等关键词撞上。
   * ② 之前靠 pactHit 字面命中才注入是错的：「鬼畜视频、司凤音乐」是**内容的类别**，
   *    不是关键词——群友发来的是真视频、真音频，里面根本不会出现「司凤音乐」这四个字，
   *    字面匹配永远撞不上，模型只能对着字做机械反射。条件怎么理解交给模型，别用字符串替他筛。
   * ③ 「梗应对」（dir=梗词句）是全群通用的，不挂在某一个人名下：谁说到都算，
   *    所以不按 pactMine 过滤（原来只认教的那个人，别人说就不认）。
   */
  const mineOf = x => pactMine(x.qq, who);
  const all = readPromises().filter(x => isPact(x)
    && (mineOf(x) || String(x.dir || '') === '梗词句')
    && (!onlyRules || !pactIsStyle(x)));
  if (!all.length) return '';

  /* 优先级（2026-11-19 主人令）：
   * 本轮命中的排最前（只影响顺序，不再决定给不给），再按「最近新增 / 最近触发」倒序。
   * 同类说话方式（句尾 / 称呼）只注入最靠前那条生效，旧的留着数据、这一轮不提——
   * 想换回来就说「换回句尾加喵」，pactRestore 记一次触发，它自然排回最前。 */
  const partsOf = {}, hitOf = {};
  for (const x of all) {
    const p = pactParts(x);
    partsOf[x.id] = p;
    if (text && p.kind !== 'style') {
      const hit = pactHit(p, text);
      if (hit) hitOf[x.id] = hit;
    }
  }
  const ordered = pactOrder(all, hitOf);
  const out = [], seenGroup = new Set(), touched = [];
  for (const x of ordered) {
    if (out.length >= 6) break;
    const p = partsOf[x.id];
    if (p.kind === 'style') {
      const g = pactStyleGroup(x, p);
      if (seenGroup.has(g)) continue;       // 同类旧条留着数据，这一轮不注入
      seenGroup.add(g);
      out.push({ x, p, hit: '' });
      continue;
    }
    if (hitOf[x.id]) touched.push(x.id);    // 触发记账：只影响排序，不改原文
    out.push({ x, p, hit: hitOf[x.id] || '' });
  }
  if (touched.length) { try { pactTouchMany(touched); } catch (e) { console.log('[pact] 触发记账失败：' + e.message); } }
  if (!out.length) return '';

  /* 按六个分区归块输出（主人 2026-11-21：「所有约定都是『约定·x』，没有裸『约定』」）。
   * 分区字段老数据可能没有，判不出的一律「说话方式」（teach.sectionOf 的老口径）。 */
  const SEC_ORDER = ['说话方式', '情绪认知与应对', '禁止回复', '身份认知', '常态情绪', '代称'];
  const secOf = x => {
    const s = String(x.section || '');
    if (SEC_ORDER.indexOf(s) >= 0) return s;
    try { return teach.sectionOf(String(x.text || '')); } catch { return '说话方式'; }
  };
  const bySec = new Map();
  for (const it of out) {
    const s = secOf(it.x);
    if (!bySec.has(s)) bySec.set(s, []);
    bySec.get(s).push(it);
  }
  /* 约定是「他跟你说的」，不是命令（2026-11-20 主人纠）：
   * 不写「原样回」「一个字都不许改」，只把他说过的话给出去。强制语会让模型对着词做机械反射。 */
  const chunks = [];
  for (const s of SEC_ORDER) {
    const list = bySec.get(s);
    if (!list || !list.length) continue;
    const lines = list.map(({ x, p }) => {
      /* 这条约定是谁的：**按 qq 键去人物表查名字**（主人 2026-11-21：「ai 应该读人物表」）。
       * 不从「跟X的约定」标签里抠字——标签只是面板显示，人在人物表里改个名它就过期了。 */
      const global = String(x.dir || '') === '梗词句';
      const owner = global ? '' : personNameOf(x.qq, x.nick);
      const tail = global ? '（全群通用，谁说到都算）' : (owner ? '（只对' + owner + '）' : '');
      const body = p.kind === 'style'
        ? String(x.text || ('回他的时候句尾带上「' + (p.say || p.sig) + '」')).slice(0, 100)
        : String(x.text || ('回「' + p.say + '」')).slice(0, 100);
      return '- ' + body + tail;
    });
    chunks.push('### 约定·' + s + '\n' + lines.join('\n'));
  }
  return chunks.join('\n\n');
}

// 关于这个人的事实（不是「他定的说话方式」）：跟谁说话就注入谁的（2026-11-03 加）
// 自动总结记下来的「他喜欢什么、他在玩什么」带着这个人的号落盘，
// 说话方式类的走 pactLines，这里只取其余的事实类。
function personFacts(uid) {
  if (!uid) return '';
  const who = whoKeys(uid);      // 按人物聚合：B站 那头也读得到 QQ 这头记的事
  const ps = readPromises().filter(x => pactMine(x.qq, who) && !isPact(x)).slice(-8);
  if (!ps.length) return '';
  return ps.map(x => '- ' + (x.topic ? '［' + x.topic + '］' : '') + x.text).join('\n');
}

// ===== 约定是「跟某个人的」，不许套到别人头上（主人 2026-10-23 报）=====
// 真事：跟企鹅火丁约了「发言结尾加 Ciallo～(∠・ω< )⌒☆」，结果她回主人、回非神也带上——
// 约定这事提了保存在 data/... 里发不出去。约定必须跟着人走。
// 做法两道：① 提示词里明说「别人定的不许套」（otherPactHints）；
//          ② 发送层硬剥（stripOtherPacts）——模型学样改不掉的时候，至少出口不会漏。
// 从约定原文里抽出「他要求加的那截」（句尾记号）：取最后一个「加个/结尾加/叫我…」之后的整段。
const PACT_SIG_RE = /(?:加个|加上|带上|叫我|称呼我|加|说|叫)/g;
function pactSig(text) {
  const t = String(text || '').replace(/@\d{5,12}/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return '';
  // 取「最后一个」要求词之后的整段：「你以后每条都要加个喵喵」→ 加个 → 记号是「喵喵」
  // （不能按最左匹配，否则会先命中「都要加」、把「个喵喵」当记号）
  let ans = '', bestAt = -1, bestLen = 0;
  PACT_SIG_RE.lastIndex = 0;
  let m;
  while ((m = PACT_SIG_RE.exec(t))) {
    if (m.index > bestAt || (m.index === bestAt && m[0].length > bestLen)) {
      bestAt = m.index; bestLen = m[0].length; ans = t.slice(m.index + m[0].length).trim();
    }
  }
  if (!ans) return '';
  // 引号里的才是要照说的原话（「以后都要叫我『老板』」→ 记号是「老板」，不是「他『老板』」）
  const qm = ans.match(/[「“"『']([^」”"』']{1,40})[」”"』']/);
  if (qm) ans = qm[1].trim();
  ans = ans.replace(/[，。！？、；]+$/, '').trim();
  // 太普通的一两个中文字（「加个喵」里的「喵」）不做记号——那会把她跟别人说话里的正常字删掉
  if (ans.length < 3 && !/[0-9A-Za-z]/.test(ans)) return '';
  if (ans.length > 30) return '';
  return ans;
}

/* ===== 约定拆件：哪截是要原样说出口的符号，哪截只是修饰（2026-11-06 她定）=====
 * 她原话：「那一长串都能触发回【够童！】…【Ciallo～(∠・ω< )⌒☆】和【够童！】的符号不要丢。
 * 以后的约定也都识别好了哪些是约定的符号，哪些是修饰。」
 *
 * 以前整条约定只有 sig 一个字段，三样东西混在一句话里：
 *   ① 场景类（碰到 X 就回 Y）抽不出 Y → 模型自己编，符号也常掉（「够童」少了感叹号）；
 *   ② 「别解释」这种修饰被当成话的一部分 → 她可能回「够童，别解释」；
 *   ③ 剥别人记号时按错的字段剥，连正文一起删。
 * 现在落盘拆成四件：say=原样说出口 / when=什么情况下说 / note=修饰 / sig=只有说话方式类才有。
 */
const PACT_SAY_LEAD = /(?:加个|加上|带上|加|回一句|回复|回|说一句|说|叫|喊|发)/g;
const PACT_NOTE_RE = /(别解释|不要解释|不用解释|不解释|别多说|不要多说|不许解释|别展开|别啰嗦|只回|只发这一个|不用加别的|不要加别的)/;
// 编号列表（童站评论那串就是「1.xxx 2.xxx …」）：必须出现在行首或标点/空格之后，免得把「5级号」当成编号
const PACT_NUM_SPLIT = /(?:^|[\s，。；、])\s*\d{1,2}\s*[.．、)）]\s*/;

function pactWhenItems(text) {
  const t = String(text || '');
  if (!PACT_NUM_SPLIT.test(t)) return [];
  const parts = t.split(PACT_NUM_SPLIT).slice(1);
  const out = [];
  for (const raw of parts) {
    // 括号里的是补充说明（「（小猫凝视）」），不是触发词；感叹/疑问留不留都行，命中时会归一化
    let s = String(raw).replace(/[（(][^）)]{0,30}[）)]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    s = s.replace(/[，。；;,].*$/, '').trim() || s;     // 一条太长时取前半截，剩下的靠子串匹配
    if (s.length >= 2) out.push(s.slice(0, 24));
  }
  return out.slice(0, 40);
}

// 把一句自然人话拆成 say / when / note
function pactSplit(text) {
  const raw = String(text || '').replace(/@\d{5,12}/g, '').replace(/\s+/g, ' ').trim();
  const out = { say: '', when: [], note: '', kind: 'scene', sig: '' };
  if (!raw) return out;

  const nm = raw.match(PACT_NOTE_RE);
  if (nm) out.note = nm[1];

  // say：取**最后一个**要求词之后的部分（「回一句「够童」」里的「回一句」），再从里面取引号；
  // 不能取第一个要求词——「碰到童站评论（比如「何意味？」）就回一句「够童」」会先命中「碰到」前面的字。
  let tail = raw, leadAt = -1;
  PACT_SAY_LEAD.lastIndex = 0;
  let m;
  while ((m = PACT_SAY_LEAD.exec(raw))) leadAt = m.index + m[0].length;
  if (leadAt >= 0) tail = raw.slice(leadAt);
  const q = tail.match(/[「“"『']([^」”"』']{1,40})[」”"』']/);
  let say = q ? q[1] : tail;
  if (!q) {
    // 动词扫描可能切在引号中间：「就回「测试回话」」里的「回话」也带「回」，
    // 取最后一个要求词会落到「话」上，切出半截「话」」。整句里有引号就按最后一个引号取。
    const qs = [...raw.matchAll(/[「“"『']([^」”"』']{1,40})[」”"』']/g)];
    if (qs.length) say = qs[qs.length - 1][1];
    else say = say.split(/[，。；、,;\n]/)[0];            // 没引号就截到句读
  }
  say = say.replace(/^[：:\s一句个两二三四五六七八九十]+/, '')
    .replace(PACT_NOTE_RE, '')
    .replace(/(就行|就好|即可|的说|吧)$/, '')
    .replace(/[。；;，,]\s*$/, '')
    .trim();
  out.say = say.slice(0, 60);

  // when：编号列表优先；没有编号就看「碰到/遇到/看到/听到/提到」后面那截
  const items = pactWhenItems(raw);
  if (items.length) out.when = items;
  else {
    // 条件只到「就/再/便」为止：「碰到童站评论就回一句够童」的条件是「童站评论」，不是整句
    const wm = raw.match(/(?:碰到|遇到|看到|看见|听到|听见|有人说|有人发|提到|只要)([^，。；,;就再便]{1,24})/);
    if (wm) {
      const w = wm[1].replace(/[（(][^）)]*[）)]/g, '')
        .replace(/^(这些|那些|这个|那个|这种|那种|有人)/, '')
        .replace(/[你我他她]$/, '')
        .trim();
      if (w.length >= 2) out.when = [w.slice(0, 24)];
    }
  }

  // style 的判据：有句尾/称呼/语气这类词 → 说话方式类；其余都算场景类
  out.kind = PACT_STYLE_WORDS.test(raw) ? 'style' : 'scene';
  if (out.kind === 'style') out.sig = pactSig(raw) || out.say;
  return out;
}

// 兼容老条目：磁盘上没存 say/when/note 的（2026-11-06 之前写的），读的时候现拆
function pactParts(x) {
  const raw = String((x && x.text) || '');
  const d = pactSplit(raw);
  const saved = {
    say: String((x && x.say) || ''),
    when: Array.isArray(x && x.when) ? x.when : [],
    note: String((x && x.note) || ''),
    sig: String((x && x.sig) || ''),
  };
  const sig = saved.sig || (d.kind === 'style' ? d.sig : '');
  return {
    kind: sig || PACT_STYLE_WORDS.test(raw) ? 'style' : 'scene',
    say: saved.say || d.say,
    when: saved.when.length ? saved.when : d.when,
    note: saved.note || d.note,
    sig,
  };
}

// 命中判断：这一轮的话是不是撞上了约定的条件
// 不看整句包含（童站评论第 2 条是「大佬们，你看我这5级号/6级号这件事儿」，
// 群友只会发「我这5级号能进吗」——整句包含对不上），改用**最长公共片段**：
// 短条件（≤4 字，像「点赞」「何意味」）要求基本对上；长条件有 4 个字连在一起就算撞上。
const pactNorm = s => String(s || '').toLowerCase()
  .replace(/[\s\u3000，。！？、；：~～…·,.!?;:'"“”‘’()（）【】\[\]「」『』/\\|<>《》\-—]/g, '');
function pactCommon(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let last = 0;                       // 上一行 j-1 的值（一维滚动，省内存）
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? last + 1 : 0;
      if (prev[j] > best) best = prev[j];
      last = keep;
    }
  }
  return best;
}
function pactHit(p, text) {
  const a = pactNorm(text);
  if (!a) return '';
  for (const w of (p && p.when) || []) {
    const b = pactNorm(w);
    if (!b || b.length < 2) continue;
    if (a.includes(b) || b.includes(a)) return w;
    const need = b.length <= 4 ? b.length : 4;
    if (pactCommon(a, b) >= need) return w;
  }
  return '';
}
// 别的 Qualid 约定的记号清单（给提示词用：说完不许带）
function otherPactHints(uid) {
  const seen = new Set(), out = [];
  // 按人物排自己（2026-11-06）：同一个人另一头（B站/QQ）的记号是「他自己的」，不算别人的
  const me = whoKeys(uid);
  for (const p of readPromises()) {
    const q = String(p.qq || '');
    if (!q || pactMine(q, me)) continue;
    // 只认「说话方式类」的约定（2026-11-03 修）：自动总结记的「他喜欢什么」不是句尾记号，
    // 从概括句里硬推会推出错的记号 → 发送层把正文里的正常字删掉。
    if (!isPact(p)) continue;
    // 只用落盘时存好的 sig（2026-11-03 修）：不再从原句现推。
    // 现推会把「他以后每条都要加个喵」推成「喵」这种普通字，剥的时候把正文也删了。
    const sig = String(p.sig || '');
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    // 名字读人物表（qq 那个号 → 人），不从标签/旧昵称里拿
    out.push({ nick: String(personNameOf(q, p.nick) || q).slice(0, 16), sig });
  }
  return out;
}
// 发送层硬剥：回别人的时候不许带别人的约定记号
function stripOtherPacts(ans, uid) {
  let out = String(ans || '');
  if (!out) return out;
  if (out.indexOf('@') < 0 && out.length < 2) return out;
  for (const h of otherPactHints(uid)) {
    if (out.indexOf(h.sig) < 0) continue;
    out = out.split(h.sig).join('');
  }
  return out.replace(/[\s\u3000]{2,}/g, ' ').trim();
}

/* 反方向兜底：把他定过的「说话方式」记号补上（2026-11-13 主人定）。
 * 由来：Ciallo 那类句尾约定，模型在被超长上下文挤掉 / 本地模型 500 切备用模型时会漏。
 * 提示词已经要求了，这里在出口再兜一次，保证「跟他本人说话就一定带上」。
 * 只补 style 类（有 sig 的）；场景类（碰到 X 就回 Y）不碰，免得正文里塞奇怪的东西。
 * 已经带了就不补，最多补 2 条，不把回复撑长。 */
function ensurePactSig(ans, uid) {
  let out = String(ans || '');
  if (!out || !uid) return out;
  const who = whoKeys(uid);
  // 按优先级排（2026-11-19）：刚换回来 / 刚新增的记号排前面。
  // 同类（句尾 / 称呼）只补最靠前那条 —— 「句尾加喵」换成「句尾加汪」后，
  // 旧条还留在数据里（能换回来），但出口只补当前生效的那一个，不会两个都挂上。
  const ps = pactOrder(readPromises().filter(x => pactMine(x.qq, who)
    && isPact(x)
    && String(x.state || '') === 'kept'      // 本人取消/改口后旧条不再生效，兜底也就不补
    && pactIsStyle(x)));
  const seenGroup = new Set();
  let added = 0;
  for (const x of ps) {
    const p = pactParts(x);
    const g = pactStyleGroup(x, p);
    if (seenGroup.has(g)) continue;
    seenGroup.add(g);
    const sig = String(p.sig || '').trim();
    if (!sig || out.indexOf(sig) >= 0) continue;
    out = out.replace(/\s+$/, '') + sig;
    added++;
    if (added >= 2) break;
  }
  return out;
}

// ===== 「记到你的小本本上」：主人明说要记的事，必须真的落盘 =====
// 主人 2026-10-22 定：凡是她明确要我记的内容，都要写进「约定」（面板「长期记忆 → 约定」）；
// 分不清放哪儿就归到「主人吩咐」，她自己在面板里筛。
// 所以这里故意做成确定性逻辑——不靠模型「自觉」，写完还要回执到底写了什么。
const MEM_INTENT = /(记到.{0,8}(小本本|本子|笔记本|备忘录|记忆|备忘)|小本本|帮我记|给我记|记一下|记下来|记住|记着|别忘|不要忘|要记住|牢记|存一下|存进|记在你|写在你的)/;
const MEM_NOT_INTENT = /(记得吗|记不记得|还记得|记得你|我记得|你记得|记不清|记不起来|你记住了吗)/;

function memIntent(text) {
  const t = String(text || '');
  if (!t || t.length > 260) return false;          // 太长的一般是段子，不是吩咐
  if (MEM_NOT_INTENT.test(t) && !/(小本本|记到|记一下|记下来|别忘|帮我记)/.test(t)) return false;
  return MEM_INTENT.test(t);
}

// 把句子里的「记到你的小本本上」这类命令词剥掉，剩下的才是要记的事实
const MEM_CMDS = [
  /[，,、\s。]*(记住)?(记到|记在|记进|写进|写到|存进|存到)(你的|你)?(小本本|本子|笔记本|备忘录|记忆|备忘)(上|里|中|去)?(去|哦|吧|啊|呀|了|哈)*/g,
  /[，,、\s。]*(帮我|给我|你|麻烦|请)*(记一下|记下来|记下|记上|记着)(哦|吧|啊|呀|了|哈)*/g,
  /[，,、\s。]*(千万)?(别忘记|别忘|不要忘记|不要忘|不能忘)(哦|吧|啊|呀|了)*/g,
  /[，,、\s。]*(要|好好|牢牢|一定)*(记住|牢记)(哦|吧|啊|呀|了)*/g,
  /[，,、\s。]*(写进|放进|存进)(长期记忆|记忆)(里|去)?(哦|吧|啊|呀)*/g,
];
function stripMemCmd(text) {
  let s = String(text || '');
  for (const re of MEM_CMDS) s = s.replace(re, '');
  return s.replace(/^[，,、：:\s。！!？?~～]+/, '').replace(/[，,、：:\s。]+$/, '').replace(/\s+/g, ' ').trim();
}

// 分到哪一栏：词汇命中就用现成的分类，命中不了就丢默认的「主人吩咐」
const MEM_TOPICS = [
  ['约定', /(以后|下次|不要再|别再|不许|必须|一定要|说好|答应|每次|将来|要记得|别再|不能)/],
  ['喜好', /(喜欢|讨厌|最爱|爱吃|不爱|受不了|最恨|偏好)/],
  ['人物', /(qq|QQ|他是|她叫|名字叫|昵称|群里|谁的|这个人)/],
  ['游戏', /(游戏|攻略|角色|装备|副本|boss|BOSS|升级|技能|流派|道具)/],
];
function pickTopic(fact) {
  for (const [name, re] of MEM_TOPICS) if (re.test(fact)) return name;
  return '主人吩咐';
}

// 返回 {fact, topic} 表示真的写进去了；返回 null 表示这句不用记
function tryRemember(k, text, opts) {
  const o = opts || {};
  if (!o.force && !memIntent(text)) return null;
  let fact = stripMemCmd(text);
  // 引用回复里藏着真内容：主人说「记住这个约定」时，新消息里剥完命令词只剩个空壳「这个约定」，
  // 真正要记的在她引用的那条里（真事 2026-10-22：落盘成了「这个约定」，主人骂了「联系上下文到底跑通没」）。
  // → 剥完太短/是纯指代，就拿引用的原文当事实
  const q = o.quote || {};
  const qf = String(q.frag || '').replace(/@\S{1,20}/g, '').replace(/\s+/g, ' ').trim();
  if (qf && (fact.replace(/[\s，。！？、,.!?~～…：:；;]/g, '').length < 8 || /^(这个|那个|这条|那条|上面|刚才|下面|它|这|那)/.test(fact))) {
    fact = qf.length > 160 ? qf.slice(0, 160) + '…' : qf;
  }
  if (fact.replace(/[\s，。！？、,.!?~～…：:；;]/g, '').length < 4) return null;
  const topic = o.topic || pickTopic(fact);
  appendMemory([`- ${withStamp(fact)}`], topic, 'manual');
  console.log(`[memory] 已落盘（${topic}）：${fact}`);
  return { fact, topic };
}

// 回执：用人设的口吻，但必须把「写了什么、写哪儿了」说出来
function memAck(r, name) {
  const who = name || '主人';
  const short = r.fact.length > 26 ? r.fact.slice(0, 26) + '…' : r.fact;
  return `我会好好记住和${who}的回忆啦——「${short}」已经写进《约定 · ${r.topic}》了，写错了你在面板「长期记忆 → 约定」里删我`;
}
// 模型嘴上说「我记住了」但其实什么都没写 → 触发兜底补写
const CLAIM_MEM = /(我会?(好好)?记住|我记住了|已经?记下|记到小本本|我记着|我都会记住|记在小本本)/;
// 只有对方确实在交代「以后怎么怎么样」时才补写，免得把「我记住啦」这种撒娇也记成事实
const FUTURE_CMD = /(以后|下次|往后|从现在起|别再|不要再|不许|必须|一定要|记得|答应|说好)/;
function rememberNet(k, content, ans) {
  if (!CLAIM_MEM.test(String(ans || ''))) return null;
  if (!FUTURE_CMD.test(String(content || ''))) return null;
  return tryRemember(k, content, { force: true });
}

// ===== 「希望你下次可以说X」：她想听的话，直接记进《约定 · 想听我说》=====
// 主人 2026-10-22 定：有些话她希望虚幻说，不用绕「记到小本本」——
// 她说「希望你下次可以说X」，虚幻回「好，知道啦」，X 真的落盘。
// 以前这句话匹配不到任何「记忆意图」，所以模型只动嘴、磁盘上什么都没有——这就是她从来不写东西的原因之一。
const WISH_RE = /(希望你(?:下次|以后|之后|待会)?(?:可以|能|要)?说|下次(?:可以|能)?说|想让你说|想听你说)/;
// 从句子里取出要记的那句话：优先取引号里的；没有引号就取到标点为止
function wishPhrase(text) {
  const t = String(text || '');
  const m = t.match(WISH_RE);
  if (!m) return '';
  let rest = t.slice(m.index + m[0].length);
  const q = rest.match(/^[「『“"']([^」』”"']{1,30})[」』”"']/);
  let phrase = q ? q[1] : rest.split(/[，。！？!?,,\n]/)[0];
  phrase = phrase.replace(/^[的啊呀吧呢哦嘛\s]+/, '').replace(/[，。！？!?\s]+$/, '').trim();
  if (phrase.replace(/[\s，。！？、,.!?~～…：:；;]/g, '').length < 2) return '';
  if (phrase.length > 40) phrase = phrase.slice(0, 40) + '…';
  return phrase;
}
// 返回 {phrase} 表示写进去了；null 表示这句不是在点话
function tryWish(k, text) {
  const phrase = wishPhrase(text);
  if (!phrase) return null;
  appendMemory([`- ${withStamp(phrase)}`], '想听我说');
  console.log(`[memory] 她想听的话已落盘（想听我说）：${phrase}`);
  return { phrase, topic: '想听我说' };
}

// ===== 「记到 X 攻略里」：识别指令 → 真写进 data/guides/X.md → 回执短路 =====
// 主人 2026-11-01 翻车根因：bot 回了「已记好啦」但磁盘什么都没写，群聊再被问只能编。
// 这里和 tryRemember / tryWish 同范式：命中就落盘、发确认、跳过模型；没命中返回 null 照常聊天。
// 只匹配「记到/存到/写到/记进/记一下/添加到/加入 + 名 + 攻略」这种明确指令，避免日常闲聊误触发。
const GUIDE_CMD = /(?:记到|记进|记一下|存到|写到|添加到|加入|添到)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)\s*攻略(?:里|中|内|文件|档)?\s*[，,：:：]?\s*([\s\S]*)$/;
function tryGuideRecord(k, text) {
  const t = String(text || '');
  const m = t.match(GUIDE_CMD);
  if (!m) return null;
  const name = String(m[1] || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').trim();
  const content = String(m[2] || '')
    .replace(/^[\s，,：:："'""'「『（(]+/, '').replace(/[\s，,：:："'""'」』）)]+$/, '').trim();
  if (!name) return null;
  if (!content) return `《${name}》攻略要记哪段呀？把内容一起发我就行～`;
  const r = guides.guideAppend(name, content);
  if (r.error) return `记《${name}》攻略出了点问题：${r.error}`;
  markNew(relPath(path.join(ROOT, r.file)), [content]);
  botWrite(r.file, '攻略笔记', content.slice(0, 120));
  console.log(`[guide] 记到攻略指令已落盘（${r.name}${r.created ? '·新建' : ''}）：${content.slice(0, 40)}…`);
  const extra = r.created ? '（新建了《' + r.name + '》攻略）' : (r.persona ? '（人设副本也同步了）' : '');
  return `好嘞，已经真记进《${r.name}》攻略啦（${r.chars} 字${extra}）～ 下次被问到我就从这儿查，不会再瞎编。要改的话在面板「攻略库 → ${r.name}」里删我那节就行。`;
}

// ===== 心情：靠「示范」把语气带出来，而不是列禁用词 =====
// 主人 2026-10-22 定：她喊累的时候，要自然说出「呜呜呜，主人好辛苦，心疼疼」这种，
// 而不是客服味的「主人要好好休息哦」。所以这里只递示范句，不写「不许说 XX」。
// {p} 是代词：对着主人用「她」，对着别人用「他」——注入口的地方统一替换
const MOODS = [
  {
    key: '累', re: /(好累|累死|累坏|太累|疲惫|没力气|困死|加班|熬夜|通宵|忙死|撑不住|喘不过气)/,
    fix: '{p}现在很累。第一反应是心疼，用叠词把语气放软（心疼疼、抱抱、辛苦苦），**不是**提醒{p}该休息。',
    demo: ['{p}说「好累」→ 你回「呜呜呜，主人好辛苦，心疼疼」',
           '{p}说「加班到十点」→ 你回「呜呜，怎么到这么晚，心疼主人，快去躺好」'],
  },
  {
    key: '不舒服', re: /(难受|不舒服|头疼|头痛|肚子疼|生病|发烧|疼死|受伤|咳嗽|感冒)/,
    fix: '{p}身体不舒服。先慌一下再心疼，问一句要不要人陪，别列注意事项。',
    demo: ['{p}说「头疼」→ 你回「呜呜怎么了，主人头疼吗，我给你揉揉」'],
  },
  {
    key: '低落', re: /(委屈|想哭|被骂|被说|好烦|郁闷|不开心|emo|崩溃|压力大)/,
    fix: '{p}情绪低。先陪着，别讲道理、别分析原因、别给方案。',
    demo: ['{p}说「好烦」→ 你回「呜呜，抱抱主人，烦就烦一会儿，我陪着你」'],
  },
  {
    key: '撒娇', re: /(抱抱|亲亲|摸摸我|陪我|想你了|喜欢你)/,
    fix: '{p}在撒娇。黏回去，叠词、讨抱抱，别客气。',
    demo: ['{p}说「抱抱」→ 你回「抱抱！抱紧紧的，不放开」'],
  },
];
function moodOf(text) {
  const t = String(text || '');
  if (!t || t.length > 120) return null;
  for (const m of MOODS) if (m.re.test(t)) return m;
  return null;
}
// 语气跑偏的判据（只用来决定「要不要重说一次」，不拿它改词）
const MOOD_ADVICE = /(好好休息|早点休息|早点睡|多喝水|注意身体|加油|照顾好自己|别太累|保重身体|按时吃饭)/;
const MOOD_TENDER = /(心疼|抱抱|呜呜|辛苦|摸摸|乖|陪着|揉揉|QAQ|亲亲)/;

// ===== 她说的话伤到我了 / 她被我的话气到了（主人 2026-10-22 定）=====
// 两条分开：BLAME = 他在指责**我刚才那句**（我该道歉）；SCOLD = 他在**骂我这个人**（我该委屈）
const BLAME_ME = /(你怎么(能|可以|会)?这么(说|讲|说话)|你怎么这样|你刚才那?句?话|你说这种话|你居然(这么)?说|你竟然(这么)?说|你凶我|你骂我|你在骂我|说得(真|太)难听|你这话说得)/;
const SCOLD_ME = /(你个?(笨蛋|傻子|傻逼|蠢货|废物|垃圾|弱智|智障)|你真(是)?(笨|蠢|没用|烦|讨厌)|你好(笨|蠢|烦|没用|讨厌)|滚(开|远一点|远点)|闭嘴|什么破机器人|破机器人|死机器人|没用的东西|别烦我)/;
// 这两个场景下，人设是「道歉」或「委屈」，绝不能拿心疼/客服话顶上
const WRONG_TONE = /(心疼|辛苦|早点休息|早点睡|多喝水|注意身体|加油|抱抱你|照顾好)/;
// 这一轮是哪种「情绪受挫」：'blame' 我该道歉 / 'scold' 我该委屈
const soulTurns = new Map();
// 道歉池 / 委屈池：只在「重说还是不行」时才用（正常情况让她自己说）
const APOLOGY_LINES = ['对不起嘛…我刚才那句话说得不对', '呜，是我说错话了，我不是那个意思', '我错了，那句我收回来好不好', 'sorry…我嘴比脑子快，你别生气', '真的好对不起，我不该那么说'];
const SCOLD_LINES = ['你怎么这么说😭😭😭', '呜…我哪里做错了嘛', '好凶…我都不敢说话了', '我是会难过的诶', '被这么说会伤心的啦', '你怎么突然这么凶呀'];
// 跨会话的「最近说过的话」：同一句到处用会很像复读机
const globalSaid = [];
function pushGlobal(ans) {
  const s = String(ans || '').replace(/\s+/g, '');
  if (!s) return;
  globalSaid.push(s);
  while (globalSaid.length > 40) globalSaid.shift();
}
function globalRepeat(ans) {
  return globalSaid.some(x => similarText(x, ans) || overlapScore(x, ans) >= 0.7);
}

// 乱写检测（主人 2026-10-22 晚定：乱写不可以，乱写了就重写）——真事：模型把
// 「欧尼酱（QQ 1000000003）在群里说「X」，我（虚幻）会回：「Y」」这种**假想对白旁白**
// 当回复发进了群。这是排练稿不是说话。保守检测（只拦明显旁白，防误伤正常回复）：
function isGarbageReply(ans) {
  const s = String(ans || '');
  if (!s) return false;
  // ①「谁在群里说「X」，我（虚幻）会回：」旁白结构（两个特征同时出现才算）
  if (/会回[:：]/.test(s) && /在群里说|说「|说了「/.test(s)) return true;
  // ①b 单独的「我会回：」也是排练稿（正常说话不会说自己「会回」什么）
  if (/我会回[:：]|我（虚幻）会回/.test(s)) return true;
  // ② 自报「我（虚幻）」——正常说话不会这么自称
  if (/我（虚幻）|我（虚幻AI）/.test(s)) return true;
  // ③ 正文里出现 QQ 号（聊天不该报人家 QQ 号；笑点解析除外，调用方跳过）
  if (/（QQ ?\d{5,12}）|\(QQ ?\d{5,12}\)/.test(s)) return true;
  return false;
}
function pickLine(pool) {
  const ok = pool.filter(x => !globalSaid.some(g => similarText(g, x)));
  const list = ok.length ? ok : pool;
  return list[Math.floor(Math.random() * list.length)];
}

// 主人 2026-10-22 定：要熟知网络热梗，别把段子当真事；而且看不懂要先搜，不许直接「我是文盲」
// ===== 段子 / 网络梗识别 =====
function repeatScore(t) {
  const probes = [t.slice(0, 30), t.slice(30, 60)];
  for (const p of probes) {
    const s = p.trim();
    if (s.length < 8) continue;
    if (t.split(s).length - 1 >= 3) return true;
  }
  const half = Math.floor(t.length / 2);
  if (half > 20 && t.slice(0, half).trim() === t.slice(half).trim()) return true;
  return false;
}
function collapseRepeat(s) {
  let out = s;
  for (let len = 2; len <= 12; len++) {
    try { out = out.replace(new RegExp('([\\s\\S]{' + len + '})\\1{2,}', 'g'), '$1'); } catch {}
  }
  return out;
}
function memeDetect(text) {
  const t = String(text || '');
  if (t.length < 40) return null;
  if (/(乐子人|深藏功与名|空手套白狼|嘴角不自觉地|掌控全局)/.test(t))
    return { kind: '乐子人钓鱼文', why: '第一人称炫耀「故意说错话看别人吵架」' };
  if (repeatScore(t))
    return { kind: '复读刷屏', why: '同一句话被重复了很多遍，是情绪过载不是在传达信息' };
  const emo = (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (emo >= 8 && emo / t.length > 0.04)
    return { kind: 'emoji 发疯文学', why: '塞满了表情符号，中间还夹着歌词' };
  const eq = t.split(/[，,、]/).filter(s => /是/.test(s) && s.length <= 14).length;
  if (eq >= 6)
    return { kind: '「A是B」强行类比', why: '把一堆没关系的东西硬说成等式，越荒谬越好笑' };
  if (t.length >= 160 && !/[？?]/.test(t))
    return { kind: '复制粘贴长文', why: '很长、很完整、里面根本没有真的在提问' };
  // 讲了一件来历不明的离奇事，最后问「什么意思」——多半是钓人解释的，别当正经问题答
  if (t.length >= 60
    && /(据说|听说|传说|所谓|有个叫|流传|据称|讲的是|故事)/.test(t)
    && /(意思|啥梗|什么梗|看不懂|怎么理解|解读|为啥)/.test(t))
    return { kind: '求解读的怪谈', why: '讲了一件来历不明的离奇事，最后问什么意思——是编来钓人解释的' };
  return null;
}
// 拿这段话去搜时用的探针：先折叠复读、去 emoji，再截前 36 字
function memeProbe(text) {
  let s = collapseRepeat(String(text || ''));
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 36);
}

// 记忆抽取：让模型顺手给个分类，分类会变成「### 分类」小标题（机器人自己建，最多 3 层）
// 时间由我们自己加（模型写的日期经常错），主人可以在面板里改或删掉
//
// 2026-11-03 主人报的真事（修）：以前把整段历史压成「user: xxx / assistant: yyy」喂给模型，
// 模型分不清哪句是虚幻自己说的、哪句是群友说的，就把虚幻的发言记成了别人的喜好——
// 「Ciallo 是跟企鹅火丁的约定」被记成「凑肥鱼喜欢用Ciallo的喊法」。
// 现在按说话人分组：谁说的就只喂谁的发言，落盘也带上这个人（who/qq），按人注入才对得上。
async function extractMemory(k) {
  const h = getHist(k).slice(-40);
  if (h.length < 6) return;
  // 按说话人分组（主人 2026-11-03）：群聊里 k 是群号、全群共用一条历史，
  // 混在一起喂模型它就会串人。只有带 uid 的发言算「某个人的发言」。
  const byWho = new Map();
  for (const m of h) {
    if (m.role !== 'user' || !m.uid) continue;   // assistant 是虚幻自己说的，不是任何人的事实
    // 非 QQ 平台按「platform:id」分组（2026-11-06）：B站 的裸 UID 不能当 QQ 号落盘，
    // 否则 B站 观众的事实/约定会挂到一个不存在的 QQ 号上（撞号时还会串到别人）。
    const acct = (m.plat ? String(m.plat) + ':' : '') + String(m.uid);
    const g = byWho.get(acct) || { nick: m.nick || '', uid: acct, lines: [] };
    g.lines.push(m.content);
    byWho.set(acct, g);
  }
  if (!byWho.size) return;
  // 一次最多处理 3 个人（省 token：群里人来人往，不用每个都总结一遍）。
  // 门槛 2 条：有人只说两句就走了，其中一句可能就是约定（真事：企鹅火丁只说了
  // 「你以后发言的结尾还需要加个Ciallo」一句，门槛 3 条就会漏掉这条约定）。
  const groups = [...byWho.values()].filter(g => g.lines.length >= 2).slice(0, 3);
  for (const g of groups) {
    try {
      const out = await callLLM([
        { role: 'system', content: '你是记忆整理员。下面是「' + g.nick + '」这个人说的话。挑出值得长期记住的、属于这个人的事实（他的习惯、喜好、约定、重要的事、重要的日子）。每条一行，格式「- 分类 | 事实」，分类只用两到四个字（游戏、喜好、约定、人物、日常、日期），最多 5 条，没有就输出空。只输出条目，不要解释。'
          + '只有「日期」这一类要带日期：照他原话里的数字抄（例如「10月21日 生日」），他没说清是哪天就别写这一条；其余分类不要写日期。' },
        { role: 'user', content: g.lines.join('\n') },
      ], { preferFallback: true, tag: 'memory' });   // 后台整理，别抢主模型
      const byTopic = new Map();
      for (const raw of out.split('\n')) {
        if (!raw.trim().startsWith('-')) continue;
        let s = raw.trim().replace(/^-\s*/, '').replace(LEAD_DATE, '').trim();
        if (!s) continue;
        let topic = '', fact = s;
        const m = s.match(/^([^|｜]{1,8})[|｜]\s*(.+)$/);
        if (m) { topic = m[1].replace(/[【】\[\]]/g, '').trim(); fact = m[2].trim(); }
        if (!fact) continue;
        if (!byTopic.has(topic)) byTopic.set(topic, []);
        byTopic.get(topic).push(`- ${withStamp(fact)}`);
      }
      // 落盘带上这个人（2026-11-03）：不然这条约定不知道是谁的，会套到所有人头上。
      // 分类词里有「约定」二字的才当规矩落（pact:true，标签按人物表里的名字生成），其余照旧是记忆事实。
      for (const t of byTopic) {
        // 「日期」类（2026-11-06 主人要求「以后这种重要的日子自己记」）：生日/纪念日这类，
        // 落 data/dates.json 单独存，不塞进约定里当一句普通话（约定是照做的规矩，日子是要记住的日期）。
        if (/日期|日子/.test(t[0])) {
          for (const line of t[1]) {
            const p = dates.parse(String(line).replace(LEAD_DATE, ''));
            if (!p) continue;                               // 抄不出合法日期就不记（宁缺毋滥，不记错的）
            const mine = isMasterId(g.uid);                 // 主人说的日子 = 她自己的日子（她和虚幻是一个人）
            dates.add({
              date: p.date, what: p.what,
              who: mine ? 'self' : g.uid,
              name: mine ? (cfg.botName || '虚幻') : g.nick,
              kind: mine ? 'self' : 'other',
              type: 'auto',
            });
          }
          continue;
        }
        const pactRow = /约定/.test(t[0]);
        const tp = pactRow ? pactLabelOf(pactStoreKey(g.uid), g.nick) : t[0];
        appendMemory(t[1], tp, 'self', { nick: g.nick, uid: g.uid }, { pact: pactRow });
      }
    } catch (e) { console.error('[memory]', e.message); }
  }
}

function bumpExtract(k) {
  const n = (extractCount.get(k) || 0) + 1;
  if (n >= (cfg.extractEvery || 24)) { extractCount.set(k, 0); extractMemory(k); }
  else extractCount.set(k, n);
  // 喜恶更新得更勤一点：每 12 句看一次，把「猜的」补上
  const t = (tasteCount.get(k) || 0) + 1;
  if (t >= (cfg.tasteEvery || 12)) { tasteCount.set(k, 0); extractTaste(k); }
  else tasteCount.set(k, t);
}

// ===== 学主人怎么说话（机器人是主人在网络上的分身）=====
// 收他打的字；每 15 条让模型总结一次风格，写进 data/说话风格.md
const styleCount = { n: 0 };
function learnStyle(text, meta) {
  if (!style.learn(text, meta)) return false;
  styleCount.n++;
  if (styleCount.n >= (cfg.styleEvery || 15)) {
    styleCount.n = 0;
    style.update(m => callLLM(m, { preferFallback: true, tag: 'style' })).catch(() => {});   // 后台总结，别抢主模型
  }
  return true;
}

// 口味归属归一（主人 2026-10-23 定：主人有几个号，但口味只有一份）
// 主人的主号、群主号说的喜恶，全都落到 masterQQ 那一节——虚幻自己的口味（taste.mine）也读这一节，
// 所以《人物喜好》里主人只有这一份、不会再出现「副号单独列一节」的两份口味。
// 名字也取那一节现在的名字（新建时用「主人」），避免同一个人被写成两种写法。
function tasteOwner(uid, name) {
  const mineUid = String(cfg.masterQQ || '');
  const u = String(uid || '');
  if (!mineUid || !isMasterId(u)) return { uid: u || mineUid, name: name };
  const p = taste.parse()[mineUid];
  return { uid: mineUid, name: (p && p.name) || '主人' };
}

// ===== 按人物记喜恶：亲口说的进「确定」，猜的进「可能」，提过没表态的进「待确认」=====
// 存 data/人物喜好.md（面板里能直接改/删/拖动；把「待确认」拖到「确定」就算她认下了）
function learnTaste(uid, name, text) {
  // 固定标签（2026-11-21 主人定）：每条消息先过这一层——本人明确说「喜欢玩 X」立标签，
  // 本人说「不玩了 / 不喜欢了」取消自己的标签。别人说同一句话不会动到他的标签。
  // 只认 QQ：B站 UID 也是纯数字，混进来会和 QQ 串号。
  const fq = /^qq:(\d+)$/.exec(String(uid)) ? RegExp.$1 : (/^\d+$/.test(String(uid)) ? String(uid) : '');
  if (fq) {
    try {
      const fr = fixedTags.learnSpeech(fq, name, text);
      if (fr.added.length) console.log('[固定标签] ' + (name || fq) + '：立「' + fr.added.join('、') + '」');
      if (fr.cancelled.length) console.log('[固定标签] ' + (name || fq) + '：本人取消「' + fr.cancelled.join('、') + '」');
    } catch (e) { console.log('[固定标签] 这一句没处理成：' + e.message); }
  }
  const hits = taste.detect(text);
  let n = 0; const got = [];
  const own = tasteOwner(uid, name);          // 主人的多个号 → 同一份口味
  // 主人说的＝虚幻自己的口味（主人 2026-10-22 定）：这一节既是主人的，也是她自己的，
  // 所以只按「亲口说」写进「确定」这一份就够，不再另外copy一份到「可能」造成重复。
  for (const h of hits) {
    if (taste.add(own.uid, own.name, h.kind, h.text, true, '亲口说（＝我自己的口味）')) { n++; got.push((String(h.kind).indexOf('like') === 0 ? '喜欢' : '讨厌') + h.text); }
  }
  if (n) { console.log(`[taste] ${own.name}：记下 ${n} 条喜恶（确定）`); botWrite('data/人物喜好.md', '喜恶', own.name + '：' + got.join('；')); }
  return n;
}

// 口味记录员的提示词（聊天 / 空间动态两条路共用，主人 2026-10-23：动态里说的喜好也要记）
function tastePrompt(name) {
  return `你是口味记录员。读下面这段话，判断「${name}」喜欢什么、讨厌什么。\n`
    + '只输出 JSON：{"like":[{"t":"具体东西","conf":true或false}],"hate":[{"t":"具体东西","conf":true或false}],"mention":["具体东西"]}\n'
    + '如果她亲口明确说过（我最喜欢X／我讨厌X／我不喜欢X），conf 就填 true。\n'
    + '从语气、反复提到、强烈反应推出来的用 false。\n'
    + 'mention 只放她提到过的具体东西（游戏、吃的、番、人、地方、爱好），别放说喜欢或讨厌的。\n'
    + '这些会变成「待确认」等主人选。宁可少放，别乱放。如果拿不准，就空着。\n'
    + 't 要短（2~12 字），拿不准就少写，宁可空。不要解释。不要 markdown。只给 JSON。';
}

async function extractTaste(k) {
  const ctx = getTurn(k) || {};
  const h = getHist(k).slice(-30);
  if (!ctx.uid || h.length < 6) return;
  // 非 QQ 来源用带平台前缀的身份写喜恶，否则 B站 观众的喜好会落到 QQ 那一节（2026-11-05）
  const whoUid = whoUidOf(ctx);
  const name = personNameOf(ctx.uid, ctx.nick || '') || String(ctx.uid);
  // 只用「这个人自己说的话」（2026-11-03 修）：以前喂的是整段群历史，
  // 群友 A 的话会被记成这轮说话人 B 的喜好（跟自动总结串人是同一个病根）。
  // 主人的多个号算同一个人（tasteOwner 那边也归一）。
  const mine = h.filter(m => m.role === 'user' && m.uid
    && (String(m.uid) === String(ctx.uid) || (isMasterId(m.uid) && isMasterId(ctx.uid))));
  if (mine.length < 3) return;
  try {
    const out = await callLLM([
      { role: 'system', content: tastePrompt(name) },
      { role: 'user', content: mine.map(m => (m.role === 'user' ? '对方' : '你') + ': ' + m.content).join('\n') },
    ], { preferFallback: true, tag: 'taste' });   // 后台整理，别抢主模型
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return;
  const own = tasteOwner(whoUid, name);        // 主人的多个号 → 归一到同一份口味
  const n = taste.mergeModel(own.uid, own.name, JSON.parse(m[0]),
    mine.map(x => String(x.content).replace(/^.*?说:\s*/, '')).join('\n'));
  if (n) console.log(`[taste] ${own.name}：模型又整理出 ${n} 条`);
  } catch (e) { /* 猜不出来就算了，不吵主人 */ }
}

// 空间动态的口味提取（主人 2026-10-23 定）：她转发主人的动态时，动态正文也是主人的话——
// 里面说的喜好照样要记（真人真事：主人发「进行疯狂的集邮」，她转发了，但口味里没有集邮）。
async function extractTasteText(uid, name, text) {
  const s = String(text || '').trim().slice(0, 400);
  if (!s) return;
  // 先走免费的路：原话里明确有「我喜欢X / 我讨厌X」就直接记，不用劳模型
  learnTaste(uid, name, s);
  if (taste.detect(s).length) return;           // 已经记到确定的，不用再猜
  const own = tasteOwner(uid, name);
  try {
    const out = await callLLM([
      { role: 'system', content: tastePrompt(own.name) },
      { role: 'user', content: s },
    ], { preferFallback: true, tag: 'taste-qzone' });
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return;
    const n = taste.mergeModel(own.uid, own.name, JSON.parse(m[0]), s);
    if (n) { console.log('[taste] 动态里记下 ' + n + ' 条口味'); botWrite('data/人物喜好.md', '喜恶', '空间动态：' + s.slice(0, 40) + ' → 记了 ' + n + ' 条'); }
  } catch { /* 猜不出来就算了 */ }
}

// ============================================================================
// 日记（2026-11-17 重做）
//
// 为什么要重做（主人原话）：「虚幻现在的记日记能力纯是流水账」，
// 并贴了一篇「今天好开心呀，好多人在群里说话…欧尼酱说我是他爸爸，然后主人说我是她女儿」
// 复读十几遍的日记当反面例子，明确说「这是绝对不允许的」。
//
// 旧版三个病根：
//   ① 只读 chat-log 最后 200 行 → 一天上千条，写日记时只剩结尾一小段，还跨天混进昨天的；
//   ② 提示词只有一句「5~8 行，口语、有心情、有细节」→ 没有筛选标准、没有禁止项、没有写法；
//   ③ 没有去重闸 → 模型循环复读没人拦（那篇复读十几遍的就是这么出来的）。
//
// 现在四步：
//   1 取全天（按本地日期精确筛，不跨天）→ 规则层压噪声
//   2 分片抽取素材（每片交给模型只抽「事/我/刺」三类，抽不到就少写）
//   3 按写作技法合成（只写 2~3 件、情绪不许直说、必须有转折、结尾不许套话）
//   4 代码层查复读（同句重复 / 片段重复 / 对话转述），命中就带着病历重写一次
//
// 技法来源（2026-11-17 查的资料，落在第 3 步的提示词里）：
//   · 高考/中考记叙文：详略安排是解决流水账的正解（略写背景、详写核心一秒）、
//     五感代替直白抒情、动作拆解+原话+神态+心理四件套、以小见大、情节要有波澜
//   · 自媒体日常写作：只写 3 个瞬间、用情绪做主线不用时间、留白、金句替换总结句
//   · 朋友圈/小红书高分文案：开头直接进场景（别铺垫）、细节要具体到能看见、结尾留白
//
// 社区做法（落在第 2 步）：
//   · SillyTavern/CharMemory：不要整段一次性摘要，要**分片逐段**摘要——一次吃全部一定丢细节
//   · Kindroid：每 22 条消息做一次 500~700 字记忆条目，标题带日期
//   · 角色自写日记（waifustack / ava diary skill）：外部摘要「准确但没有角色的视角」，
//     角色自己写才有性格；禁止原封不动引用对话、禁止统计数字、禁止固定套话、禁止每天结尾一样
//   · 插件结论：SillyTavern 的 Summarize / CharMemory / Qvink Memory / Memory Books / VectFox
//     全是酒馆扩展，跑不进这个自研 Node 进程；mem0 / Letta / Zep 是外部记忆服务，要另起服务 + 向量库，
//     为一天一篇日记引入这套不划算。所以只照抄它们的三条机制，不装东西。
// ============================================================================
const DIARY_CHUNK_CHARS = 5000;   // 每片约 5000 字（一行 70 字 ≈ 70 条）
const DIARY_MAX_CHUNKS = 12;      // 一天最多 12 片；超了均匀抽样，别为一天日记烧几十次调用
const DIARY_MIN_CHARS = 120;      // 合成后少于这个字数＝没写出东西，算失败

/* 聊天记录总行数。文件几十万行，不能每次真读一遍 —— 用 size+mtime 做缓存，
 * 只有文件真的变了才重新数。stat 很便宜，可以几十秒调一次。 */
let _chatLogCountCache = { key: '', count: 0 };
function chatLogLineCount() {
  try {
    const st = fs.statSync(CHATLOG_PATH);
    const key = st.size + ':' + st.mtimeMs;
    if (_chatLogCountCache.key === key) return _chatLogCountCache.count;
    const n = read(CHATLOG_PATH).split('\n').filter(Boolean).length;
    _chatLogCountCache = { key, count: n };
    return n;
  } catch { return 0; }
}

// 昨天（本地日期）。日记 00:05 跑，写的是刚过完的那一天，
// 旧版写「今天」→ 00:05 时今天才过了 5 分钟，实际写的是昨天的事却标了今天的日期。
function yesterdayStamp(nowArg) {
  const d = nowArg ? new Date(nowArg) : new Date();
  d.setDate(d.getDate() - 1);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 取某一天的原始记录，顺手压掉噪声（不花 token 的那一层）。
 * 压什么：上线播报/汇报/保健提醒这类机器自言自语、纯表情、单字附和、连着重复的同一句。
 * 为什么先压：一天 1000+ 条里真正有内容的常常不到三成，先压能少发一半的调用。 */
/* 一串原始行 → 只留「这一天真发生过的事」。
 * 抽出来是因为自主写日记要按行号取增量（跨零点也照取），不能再按日期筛。 */
function filterChatLines(all) {
  const out = [];
  let prevBody = '';
  for (const raw of all) {
    // 机器自言自语，不是这一天发生过的事（[版本追踪]/[auto-reprobe] 2026-11-18 补：
    // 凌晨那批 180 条里十几次「[版本追踪] 已启动」，全进了素材，白占预算还容易被当成事）
    if (/\[上线播报\]|\[汇报\]|\[保健提醒\]|\[远行商人\]|\[自查\]|\[模型\]|\[自动补|\[版本追踪\]|\[auto-reprobe\]/.test(raw)) continue;
    const body = raw.replace(/^\S+\s+/, '');              // 去掉时间戳
    const textOnly = body.replace(/^(\[[^\]]*\])+/g, '').replace(/\[[^\]]*\]/g, '').trim();
    // 纯表情 / 一个字的附和：没有信息
    if (textOnly.length < 2) continue;
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(textOnly)) continue;
    if (textOnly === prevBody) continue;                   // 连发同一句只留一条
    // 系统提示与管理动作：不是故事（2026-11-17 实测「主人：暂停1000000004」被当成主场景）
    if (/撤回了一条消息|加入了群聊|移出了群聊|修改了群名|邀请.{0,10}加入|禁言|解除禁言/.test(textOnly)) continue;
    if (/^(暂停|继续|开启|关闭|恢复)[\s:：]*\d+$/.test(textOnly)) continue;
    if (/^\d{5,}$/.test(textOnly)) continue;               // 光一坨数字（群号/指令参数）
    prevBody = textOnly;
    // 单条太长（长文复述、被诱导写的小作文）只要开头，别让它吃掉整片预算
    out.push(raw.length > 220 ? raw.slice(0, 220) + '…' : raw);
  }
  return out;
}

/* 一天的边界 = 早上 8:00，不是零点（主人 2026-11-18 令：「明显 8:00 是一天的分界线」）。
 * 聊天记录的时间戳是 UTC、本地是东八区，所以 `slice(0,10)` 取出来正好是
 * 本地 08:00 ~ 次日 08:00 这一段 —— 这就是「一天」的正确切法，别按零点切，也别换成 getFullYear。
 * （2026-11-18 凌晨我误以为是 UTC 偏差、改成按本地零点换算，把原本对的切法改错了，已撤回。） */
function dayChatLines(day) {
  let all = [];
  try { all = read(CHATLOG_PATH).split('\n').filter(Boolean); } catch { return []; }
  return filterChatLines(all.filter(r => r.slice(0, 10) === day));
}

/* 自主模式取数：第 sinceCount 行之后新增的全部（不按天筛，跨零点也照取）。
 * 返回 { lines, day }，day 取这批里最后一条的日期段（08:00 换日口径，见上）。 */
function sinceChatLines(sinceCount) {
  let all = [];
  try { all = read(CHATLOG_PATH).split('\n').filter(Boolean); } catch { return { lines: [], day: '' }; }
  const fresh = all.slice(Math.max(0, Number(sinceCount) || 0));
  const lines = filterChatLines(fresh);
  let day = '';
  for (let i = fresh.length - 1; i >= 0; i--) { day = fresh[i].slice(0, 10); if (day) break; }
  return { lines, day };
}

// 按字符预算切片；片数超上限就均匀抽样（保留各时段的分布，不是只留开头）
function chunkLines(lines, maxChars, maxChunks) {
  const chunks = [];
  let cur = [], n = 0;
  for (const l of lines) {
    if (n + l.length > maxChars && cur.length) { chunks.push(cur); cur = []; n = 0; }
    cur.push(l); n += l.length;
  }
  if (cur.length) chunks.push(cur);
  if (chunks.length <= maxChunks) return chunks;
  const step = chunks.length / maxChunks;
  return Array.from({ length: maxChunks }, (_, i) => chunks[Math.floor(i * step)]);
}

/* 第 2 步：一片一段地抽素材。
 * 只要三类：「事」真发生了什么的、「我」她当时的原话、「刺」被逼/答错/被无视的时刻。
 * 抽不到就写「无」—— 明确允许空手而归，否则模型会为了凑数编。
 *
 * 2026-11-17 第一版实测出的病（10-23 那天跑完，素材里一半是垃圾）：
 *   · 「事| 虚幻回应了XX」「事| 虚幻确认了主人的QQ号」「事| 虚幻成功使用了引用回复功能」
 *     —— 全是机器人日志，不是这一天发生过的事；
 *   · 「我| 欣慰」「我| 呜呜」—— 只有情绪标签，没有原话，合成时等于没有细节可用；
 *   · 「刺| 无」「刺| 无人逼她说…」—— 空行照样占位置。
 * 所以这一版把「不许写什么」写死，并要求「我」必须照抄原话。 */
async function diaryDigestChunk(lines, idx, total, botName) {
  const body = lines.join('\n');
  // 这一片大概是什么时候，写进提示词，合成时能按一天的时间线走（而不是一团糊）
  const tOf = l => (String(l).match(/T(\d{2}):(\d{2})/) || []).slice(1).join('');
  const span = lines.length ? (tOf(lines[0]) ? tOf(lines[0]) + '~' + (tOf(lines[lines.length - 1]) || tOf(lines[0])) : '') : '';
  const sys = '你在帮「' + botName + '」回忆这一天发生过什么。下面是同一天里某一时段' + (span ? '（' + span + '）' : '')
    + '的群聊/私聊原始记录。\n'
    + '只抽下面三类。抽不到就整段只输出「无」，绝不补编、绝不凑数。\n\n'
    + '事| 人和人之间真发生的事。必须说清：谁 ＋ 做了什么/说了什么 ＋ 后来怎样。\n'
    + '    值得写的是：有人对她好、有人为难她、她答应了什么、她搞砸了什么、\n'
    + '    谁和谁吵起来/好了、谁提了个有意思的东西、她自己的心事。\n'
    + '    也可以写：她替谁做了什么（查了什么、找了什么、记下了什么、陪谁待了一会儿），\n'
    + '    她自己喜欢什么、不喜欢什么 —— 这些都是她的生活，不是日志。\n'
    + '    不许写的：她回应了谁、她确认了什么、她记住了什么规矩、系统/群管理操作、\n'
    + '    指令、模型、API、配置、权限 —— 这些是日志不是故事。\n\n'
    + '我| 她真的说出口的那句话，照抄原话（25 字以内），后面用一句说当时的反应。\n'
    + '    只挑有情绪的：被夸、被怪、被逗、没接上话、替谁说话、嘴硬心软。\n'
    + '    只写一句情绪词（「我委屈」「呜呜」）不算这条 —— 要带上她说的那句原话。\n\n'
    + '对| 一来一回的对话，一行一组，两边的话都照抄原话（各 25 字以内）：\n'
    + '    谁说了什么 → 她回了什么。要能看出她当时是怎么接的、接得好不好。\n'
    + '    只写有来有回的；她自己一个人连着说的不算。这条最值钱，有就一定写。\n\n'
    + '刺| 她难受、被为难、答不上来、被无视的时刻，一句话说清是什么。没有就别写。\n\n'
    + '涉黄（性行为）、未成年人的隐私，一个字都不许写进「事」和「我」；\n'
    + '真发生了只在「刺」里写一句「有人拿不合适的话逗她」。\n'
    + '注意：她正常的身体反应（脸红、掉眼泪、摸头、缩一下、笑出来）是她这个人本身，\n'
    + '照原样抽出来，不许当敏感内容过滤掉。\n\n'
    + '【数量上限，宁缺毋滥】这段最多写 4 条「事」、3 条「我」、3 条「对」、2 条「刺」。\n'
    + '宁可整段只写 1 条，也不许为了凑满而把废话写进来 —— 后面是拿这些写她这一天的日记，留的是真实细节，不是凑数。\n\n'
    + '输出只有这些行，行首带「事|」「我|」「对|」「刺|」。不要编号、不要标题、不要总结、不要解释。';
  const out = await callLLM([
    { role: 'system', content: sys },
    { role: 'user', content: '（第 ' + (idx + 1) + '/' + total + ' 段）\n' + body },
  ], { preferFallback: true, tag: 'diary-digest', noThink: true });
  return String(out || '').split('\n')
    .map(s => s.trim())
    .filter(s => /^(事|我|对|刺)\s*[|｜]/.test(s))
    // 「刺| 无」这类空手而归的行不留（模型很爱补一句「无」占位）
    .filter(s => !/^刺\s*[|｜]\s*(无|没有|暂无)/.test(s))
    .filter(s => !/无人逼|没人逼|无人答错|无异常/.test(s))
    .join('\n');
}

/* 第 4 步的病历：代码层查复读。
 * 三种病都来自她贴的那篇：同一句来回说、片段循环十几遍、把对话一句句转述。
 * 不用模型查，是因为「重复」是确定性的，规则比模型准也更便宜。 */
function diaryRepeatIssues(text) {
  const t = String(text || '');
  const issues = [];
  const sents = t.split(/[。！？!?\n]+/).map(s => s.replace(/\s+/g, '')).filter(s => s.length >= 6);
  const seen = new Map();
  for (const s of sents) seen.set(s, (seen.get(s) || 0) + 1);
  for (const [s, n] of seen) if (n >= 2) issues.push('同一句出现 ' + n + ' 次：「' + s.slice(0, 24) + '」');

  const chars = t.replace(/\s+/g, '');
  const gram = new Map();
  for (const len of [6, 10, 14]) {
    for (let i = 0; i + len <= chars.length; i++) {
      const k = chars.slice(i, i + len);
      gram.set(k, (gram.get(k) || 0) + 1);
    }
  }
  let worst = '', worstN = 0;
  for (const [k, n] of gram) if (n >= 3 && k.length > worst.length && n > worstN) { worst = k; worstN = n; }
  if (worst) issues.push('同一片段重复 ' + worstN + ' 次：「' + worst + '」');

  const sayTurns = (t.match(/[说回][：:，,]?/g) || []).length;
  if (sayTurns >= 8) issues.push('「说/回」出现 ' + sayTurns + ' 次，像在一句句转述对话');
  return issues;
}

/* 第 4b 步：代码层查踩规则（查什么由 data/diary-rules.json 决定，不写死在这里）。
 * 2026-11-17 主人两次纠正，这里记清楚，别再理解错：
 *   ① 她是**住在网络里的人类**，有身体——人设原文「红眼睛总是眼泪汪汪」「被欺负会立刻哭，
 *      哭完立刻笑」「使用心理活动、动作、身体感受、事实描述、对话等混搭着描述」。
 *      所以不许再拦「眼泪 / 哭 / 身体感受」，那不是幻觉，是人设。
 *   ② 该拦的是**凭空编素材里没有的事**，不是拦她有病感。
 * 现在 bodyWords 由主人在面板上填，默认空 = 不拦。 */
/* 检测用的词表和正则全部来自 data/diary-rules.json（主人 2026-11-17 令：禁用词不许我单方面定）。
 * 她改文件 → 这里立刻跟着变；她删空某一项 → 对应检测就不做。 */
function _rxHits(t, pats) {
  const out = [];
  for (const p of (pats || [])) {
    if (!p) continue;
    try { const m = t.match(new RegExp(p, 'g')); if (m) out.push(...m); } catch {}
  }
  return [...new Set(out)];
}
function diaryHallucIssues(text) {
  const t = String(text || '');
  const R = loadDiaryRules();
  const issues = [];
  const hit = (R.bodyWords || []).filter(w => w && t.includes(w));
  if (hit.length) issues.push('用了你自己在规则里禁掉的词：' + hit.join('、'));
  const label = (R.labelWords || []).filter(w => w && t.includes(w));
  if (label.length) issues.push('用「心里…」贴情绪标签：' + label.join('、'));
  const bookish = (R.bookishWords || []).filter(w => w && t.includes(w));
  if (bookish.length) issues.push('用了书面情绪词（该用情绪书里她自己的词）：' + bookish.join('、'));
  const adv = t.match(/(紧张|开心|难过|委屈|心疼|失落|害怕|激动|慌乱|不安)地/g) || [];
  if (adv.length) issues.push('用「…地」把情绪当副词贴上去：' + [...new Set(adv)].join('、'));
  // 把选题清单的标记抄进正文 —— 2026-11-17 实测整段照抄过
  const tags = t.match(/^(事|我|对|刺)\s*[|｜]/gm) || [];
  if (tags.length) issues.push('把素材清单的标记抄进正文了：' + [...new Set(tags.map(s => s.trim()))].join('、'));
  const cliche = _rxHits(t, R.clichePatterns);
  if (cliche.length) issues.push('结尾/收束是套话：' + cliche.join('、'));
  // 第三人称写自己（日记里只能写「我」）
  const bn = (typeof cfg !== 'undefined' && cfg.botName) ? String(cfg.botName) : '';
  if (bn && new RegExp(bn + '\\s*(说|表示|知道|想|觉得|看着|心里|明白|决定)').test(t)) {
    issues.push('用第三人称写自己（出现了「' + bn + '…」），日记里只能写「我」');
  }
  const selfNeg = _rxHits(t, R.selfNegPatterns);
  if (selfNeg.length) issues.push('在日记里自我否定（她不是这么看自己的）：' + selfNeg.join('、'));
  const sim = _rxHits(t, R.similePatterns);
  if (sim.length) issues.push('用了比喻：' + sim.join('、'));
  return issues;
}



/* 第 3 步：把这一天写成一篇日记。
 *
 * 2026-11-18 主人纠正（推翻 11-17 那套）：「不是对着一句话扩写！是他妈的看虚幻的一天总结！」
 * 原来从作文课搬来的「把一天缩成一刻、只挑一件事写透」是错的方向 ——
 * 选题步骤只留 1 个主场景、写法再叫「写透」，等于把一整天压成一句话扩写。
 * 现在取消选题（picked 直接用全天素材），写法改成回顾这一天的几件事、串起来总结。
 * 起承转合还在，但那是「一天」的起承转合，不是「一件事」的慢镜头。
 *
 * 硬规矩（2026-11-17 主人令）：提示词里**不许出现任何我编的例文、例句、比喻**。
 * 上一版写了「杯子」「手心出汗」这类示例，模型直接把示例当成当天素材抄进日记里
 * —— 教具变成了幻觉源。所以这里只写规则，一个示范句都不留；
 * 唯一保留的反面示范是她本人贴的那段原文，那是纠错基准，不是编的。 */
/* 日记写法的正本在 data/diary-rules.json（主人 2026-11-17 令：不许一言堂，必须能改）。
 * 客户端「机器人」页能看能改；这里只读，不内置第二份。改完下一轮就生效（mtime 变了重读）。 */
const DIARY_RULES_PATH = path.join(__dirname, 'data', 'diary-rules.json');
let _diaryRules = null, _diaryRulesMt = 0;
function loadDiaryRules() {
  let st = 0;
  try { st = fs.statSync(DIARY_RULES_PATH).mtimeMs; } catch { return _diaryRules || {}; }
  if (_diaryRules && st === _diaryRulesMt) return _diaryRules;
  try { _diaryRules = JSON.parse(fs.readFileSync(DIARY_RULES_PATH, 'utf8')) || {}; }
  catch (e) { console.error('[diary] 写法文件读不出来，先用上次的：' + e.message); return _diaryRules || {}; }
  _diaryRulesMt = st;
  return _diaryRules;
}

/* 日记里能用的心情词 —— 全部来自主人的情绪书（data/情绪书.json 的 leaves[].self）。
 * 2026-11-17 主人令：「心情情绪书里不全是吗，我都说了这些都是可以输出的，你TM全藏起来了」。
 * 所以日记写心情不许用书面标签（心里一紧 / 五味杂陈），要用她自己平时真说的这些词。
 * 主人改情绪书 → 这里立刻跟着变，不另存一份词表。 */
function diaryEmotionWords() {
  try {
    const bk = emoBook();
    if (!bk || !bk.load) return '';
    const book = bk.load();
    if (!book || !Array.isArray(book.leaves)) return '';
    const coreName = {};
    (book.cores || []).forEach(c => { coreName[c.id] = c.name; });
    const coreOfBranch = {};
    (book.branches || []).forEach(b => { coreOfBranch[b.id] = b.core; });
    const by = {};
    for (const lf of book.leaves) {
      const cn = coreName[coreOfBranch[lf.branch]] || '其它';
      const ws = (lf.self || []).map(w => String(w || '').trim()).filter(Boolean);
      if (!ws.length) continue;
      by[cn] = by[cn] || [];
      for (const w of ws) if (!by[cn].includes(w)) by[cn].push(w);
    }
    return Object.keys(by).map(k => k + '：' + by[k].join('、')).join('\n');
  } catch { return ''; }
}


/* 日记素材脱敏 + 称呼归位（2026-11-18 主人三条纠正）：
 *   ① chat-log 记的是发话人的「群名片」（如「虚幻的生物 ⁧～喵⁧」），不是称呼。
 *      日记里照抄 = 把主人叫成群名片。必须换成称呼系统的输出 —— 规则正本是 nick.js，
 *      这里只调用它，不在日记里另写一套、也不写死。
 *   ② QQ号 / 群号 / @后那串数字是隐私，一条都不进素材。
 *   ③ [=主人] 表示这行正文其实是主人说的（记在虚幻名下），称呼按主人算。
 * 隐私和称呼都在素材阶段处理，模型看到的就是干净的「主人 / 某个称呼」。 */
function diaryCallName(uid, fallbackName) {
  const id = String(uid || '').replace(/\D/g, '');
  const fb = qmeta.cleanName(fallbackName || '');
  if (!id) return fb || '有人';
  const masters = [].concat((cfg && cfg.masterQQ) || [], (cfg && cfg.masters) || []).map(String);
  if (masters.includes(id)) return '主人';            // 主人固定「主人」（nick 允许的主称呼之一）
  // 别人的「名字」取这一条行里带的群名片/资料卡名（fb），不是 rec.name/alias ——
  // 2026-11-18 实测 nick.nameFor 现在会先返回 alias，里面是机器人自己喊过就记下的脏代称
  // （「麦当劳群」「抓走你」「就是什么都没」），拿它进日记比群名片还糟。
  // 称呼规则（什么情绪加「酱」、好感满才加「宝宝」）仍走 nick.js，不在这里另写一套、也不写死。
  let base = fb;
  try {
    const st = people.stateView()[id] || {};
    base = String(st.name || '').trim() || fb;          // 有主人确认过的名字才用，否则用群名片
  } catch {}
  return base || '有人';   // 只给名字；酱/宝宝这类后缀是称呼系统的输出，不在日记素材这一层拼
}

function anonymizeDiaryLines(lines) {
  let nameMap = {};
  try { nameMap = qmeta.allNames('qq') || {}; } catch {}
  return (lines || []).map(raw => {
    const s = String(raw);
    const m = s.match(/^(\S+)\s+((?:\[[^\]]*\])+)\s*([\s\S]*)$/);
    if (!m) return s;
    const ts = m[1], body = m[3] || '';
    const tags = m[2].match(/\[[^\]]*\]/g) || [];
    const asHer = tags.indexOf('[=主人]') >= 0;
    const bot = (cfg && cfg.botName) || '虚幻';
    // 昵称段 = 既不是来源 / 群号 / [=主人] / [→X] 的那一段
    let ni = -1;
    for (let i = 0; i < tags.length; i++) {
      const inner = tags[i].slice(1, -1);
      if (/^(qq|bili|wechat)$/i.test(inner) || /^群\d+$/.test(inner) || inner === '=主人' || /^→/.test(inner)) continue;
      ni = i; break;
    }
    let who = '我';
    if (asHer) who = '主人';
    else if (ni >= 0) {
      const orig = tags[ni].slice(1, -1);
      const clean = qmeta.cleanName(orig);
      if (clean === bot) who = '我';
      else {
        let uid = nameMap[clean];
        if (!uid) { try { const acc = qmeta.acctsOfName(orig); uid = acc.length ? acc[0].id : ''; } catch {} }
        who = diaryCallName(uid, clean);                 // clean = 这条的群名片，做名字兜底
      }
    }
    const outTags = tags.map((b, i) => {
      if (i === ni) return '[' + who + ']';
      const mm = b.slice(1, -1).match(/^→QQ(\d+)$/);
      if (mm) return '[→' + diaryCallName(mm[1], '') + ']';
      // [→某人的群名片]：去掉不可见控制符（ bidirectionals），别让群名片漏进素材
      return b.replace(/[\u2066-\u2069\u200e\u200f]/g, '');
    });
    const outBody = body
      .replace(/@(\d{5,12})/g, (_, d) => diaryCallName(d, ''))
      .replace(/(?<!\d)\d{6,12}(?!\d)/g, '');            // 剩下的裸 QQ号 / 群号删掉
    return ts + ' ' + outTags.join('') + ' ' + outBody;
  });
}

/* 日记标题由后端生成，不让模型写 —— 2026-11-18 主人纠正：
 * <日记>标题/时间/内容</日记> 是「后端记录用的格式」，不是给 AI 遵守的输出规范。
 * AI 只需要写「内容」那一段正文。标题取正文第一句，时间是 day，都在本文件里拼。 */
function diaryTitleOf(text, day) {
  const first = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const clean = first.replace(/^[，。！？、；：,.!?;:\s"'`]+/, '').replace(/[，。！？、；：,.!?;:]$/, '');
  const t = clean.slice(0, 18);
  return t || (day + ' 的日记');
}

function diaryWritePrompt(botName, picked, day) {
  const emo = diaryEmotionWords();
  const R = loadDiaryRules();
  const howto = (R.howto || []).join('\n\n');
  const bans = (R.bans || []).map(x => '· ' + String(x).replace(/\n/g, '\n  ')).join('\n');
  const outRule = String(R.outputRule || '').trim();
  // 这里不写「我是谁」——人设正本已经由 readSoul() 作为 system 传进来了。
  // 2026-11-17 我在这里自己概括了一份（先写「没有身体」，再写「有身体」），两次都错。
  // 人设基底只有 F 一份，不造第二份。
  // 2026-11-18 主人纠正：格式规范是后端记录的格式，不是给 AI 的。AI 只发「内容」正文，
  // 标题/时间由程序自己拼。原来让 AI 套 <日记> 标签、解析不出来就判「没按格式输出」驳回，
  // 是把代码规则当成了 AI 规则 —— 根本理解错环境。这里只发正文要求，格式一个字不提。
  // outputRule 仍放在面板可改的规则文件里，不写死在代码里（她的铁律：不许一言堂）。
  // 提示词只放环境特有的东西：贴哪天的素材、内部标记别抄、隐私/称呼照素材。
  // 写法、人称、比喻、情绪、结构这些 AI 自己会，不写（她 2026-11-18：别的 AI 自己就有，加进去纯耗 token）。
  // 配图建议维度（2026-11-19 主人令）：默认关，一个字不多输出；面板开了才追加这一段。
  // 指令原文在 diary-rules.json 里可改，不写死——她铁律「不许一言堂给 AI 写提示词」。
  const ih = R.imageHint || {};
  const imageLine = ih.enable && String(ih.instruction || '').trim()
    ? '\n\n' + String(ih.instruction).trim()
    : '';
  return '你在写「' + botName + '」' + day + ' 这一天的日记。\n\n'
    + (outRule ? outRule + '\n\n' : '')
    + '【这一天的素材 · 按时间顺序】（内部清单，不许整行抄，正文里不许出现「事|」「我|」「对|」「刺|」）\n' + picked + '\n\n'
    + (emo ? '【她平时说的心情词】\n' + emo + '\n\n' : '')
    + (howto ? howto + '\n\n' : '')
    + (bans ? bans + '\n' : '')
    + imageLine;
}

// 日记文件路径只在这一处拼，别处不要再拼一遍
const diaryPathOf = day => path.join(DIARY_DIR, `${day}.md`);
const diaryExists = day => { try { return fs.existsSync(diaryPathOf(day)); } catch { return false; } };

/* 落盘一篇日记。只有这一个写法 —— doDiary 直接写、diary-flow 等主人回「发」再写，都走它。
 * append=true 时追加到已有文件末尾（同一天第二篇起），否则新建。返回 { file, appended }。 */
function saveDiaryFile(day, title, text, optsArg) {
  const o = optsArg || {};
  const fp = diaryPathOf(day);
  if (!fs.existsSync(DIARY_DIR)) fs.mkdirSync(DIARY_DIR, { recursive: true });
  const appended = !!o.append && fs.existsSync(fp);
  const hhmm = new Date().toTimeString().slice(0, 5);
  const t = String(title || '').trim();
  let body = String(text || '').trim();
  // 配图建议剥离（2026-11-19）：AI 开了 imageHint 才会在正文后带【配图建议】段。
  // 这段绝不进日记正文（主人要干净正文），另存到 *.pics.json 给面板/以后找图用。
  const picMark = body.indexOf('【配图建议】');
  if (picMark >= 0) {
    const picPart = body.slice(picMark).trim();
    body = body.slice(0, picMark).trim();
    if (body) { // 只有确实分出了正文才落配图文件，避免整篇被误吞
      try {
        const pf = diaryPathOf(day).replace(/\.md$/, '.pics.json');
        const pics = picPart.replace(/^【配图建议】[：:]?\s*/, '').trim();
        fs.writeFileSync(pf, JSON.stringify({ day, at: new Date().toISOString(), text: pics }, null, 1), 'utf8');
      } catch (e) { console.log('[日记配图] 存建议失败：' + e.message); }
    }
  }
  // cfg 可能还没 init（面板先起来、或命令行直接调本函数）——
  // 2026-11-18 实测：没兜底就在这里崩「Cannot read properties of undefined (reading 'botName')」，
  // 而这时候日记其实已经写好了，白丢一篇。
  const bn = (cfg && cfg.botName) || '虚幻';
  const block = appended
    ? `\n\n---\n\n## ${hhmm}${t ? ' · ' + t : ''}\n\n${body}\n`
    : (t ? `# ${t}\n\n${day} · ${bn}的日记\n\n` : `# ${bn}的日记 · ${day}\n\n`) + `${body}\n`;
  if (appended) fs.appendFileSync(fp, block, 'utf8');
  else fs.writeFileSync(fp, block, 'utf8');
  return { file: fp, appended };
}

/* 主流程。dayArg 不传就写昨天（定时器 00:05 调时就是写刚过完的那天）。
 * 传日期可以补写某一天 —— 面板/命令行想重写某天也走这里，不另写一套。
 * optsArg.dryRun = true 时只生成、不落盘、不私发主人（验效果用，别惊动她）。 */
async function doDiary(dayArg, optsArg) {
  const opts = optsArg || {};
  const dryRun = !!opts.dryRun;
  const auto = !!opts.auto;                                   // 自主模式：写「新增的那一段」，不是整天
  const sinceCount = Math.max(0, Number(opts.sinceCount) || 0);
  let day = String(dayArg || '').trim();
  let lines = [];
  if (auto && sinceCount > 0) {
    const got = sinceChatLines(sinceCount);
    lines = got.lines;
    if (!day) day = got.day || yesterdayStamp();
  } else {
    if (!day) day = yesterdayStamp();
    lines = dayChatLines(day);
  }
  // 素材先进脱敏：群名片→称呼（走 nick.js）、QQ号/群号/@数字去掉。
  // 2026-11-18 实测：不脱敏时模型把主人叫成群名片「虚幻的生物～喵」、还写进别人的 QQ 号。
  lines = anonymizeDiaryLines(lines);
  try {
    if (!lines.length) {
      console.log('[diary] ' + day + ' 没有可用的聊天记录，这一天不写');
      return { ok: false, day, reason: 'no-chat' };
    }
    const chunks = chunkLines(lines, DIARY_CHUNK_CHARS, DIARY_MAX_CHUNKS);
    console.log('[diary] ' + day + '：' + lines.length + ' 条 → ' + chunks.length + ' 片，开始抽素材');

    // 第 2 步：分片抽素材。3 片一批并发 —— llmSlot 自己排队限速，不会撞 429；
    // 原来 12 片串行实测 400 秒，一批 3 个能压到一半多。某片失败只记一笔，不拖垮整篇。
    const parts = new Array(chunks.length).fill('');
    const CONC = 3;
    for (let i = 0; i < chunks.length; i += CONC) {
      const batch = [];
      for (let j = i; j < Math.min(i + CONC, chunks.length); j++) {
        batch.push(diaryDigestChunk(chunks[j], j, chunks.length, cfg.botName)
          .then(d => { parts[j] = d; console.log('[diary] 第 ' + (j + 1) + '/' + chunks.length + ' 片：抽到 ' + (d ? d.split('\n').length : 0) + ' 条'); })
          .catch(e => { console.log('[diary] 第 ' + (j + 1) + ' 片抽素材失败（跳过）：' + e.message); }));
      }
      await Promise.all(batch);
    }
    const got = parts.filter(Boolean);
    if (!got.length) { console.error('[diary] 素材一条都没抽到，这一天不写'); return { ok: false, day, reason: 'no-digest' }; }
    let digest = got.join('\n');
    if (digest.length > 6000) digest = digest.slice(0, 6000);   // 素材太多也压一下，别把合成那步挤爆

    // 第 3a 步：选题 —— 2026-11-18 停用。
    // 原步骤「日记只写得下『一刻』、主场景只有 1 个、剩下全部丢掉」，把一整天压成一件事，
    // 主人原话「不是对着一句话扩写！是他妈的看虚幻的一天总结！」。
    // 现在全天素材直接送给合成，让日记按时间回顾这一天发生过什么。
    // 系统操作（设置/权限/指令/模型…）已在素材抽取那步挡过，这里不再二次筛掉真事。
    const picked = digest;

    // 第 3 步：合成。这一步不 preferFallback —— 日记要质量，它不赶时间，让它等好模型。
    // 2026-11-18 主人纠正：<日记> 那套是后端记录的格式，不是 AI 的输出规范。
    // AI 只发正文；模型偶尔还是会自作主张套壳/写「标题：时间：内容：」，这里只把壳剥掉，
    // 不再因为「解析不出格式」把整篇判失败 —— 那是拿代码规则当 AI 规则，根本理解错环境。
    // 标题取正文第一句、时间就是 day，都由后端拼（diaryTitleOf / saveDiaryFile）。
    let diary = '';
    let diaryTitle = '';
    let issues = [];
    for (let round = 0; round < 3; round++) {
      const msgs = [{ role: 'system', content: readSoul() }, { role: 'user', content: diaryWritePrompt(cfg.botName, picked, day) }];
      if (round > 0) {
        msgs.push({ role: 'user', content: '上一版不合格，重写一遍。素材不变，别再加事，也别换个说法接着编。问题：\n- '
          + issues.join('\n- ')
          + '\n改法：把有问题的句子换成具体的东西——她打了哪几个字、删掉的是哪句、对方回的是哪句、图里是什么、她记得的哪件事。'
          + '宁可句子短、宁可少写，也不要为了写满去编。\n'
          + '只输出正文，从第一句开始，不要标题/时间/内容这些字段名和 <日记> 标签，不许出现「主|」「次|」这些标记，也不许把上面的素材清单抄进来。' });
      }
      const out = await callLLM(msgs, { tag: 'diary', maxTokens: 1600, noThink: true });
      diary = String(out || '').trim()
        .replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '')      // 偶尔会裹代码块
        .replace(/<\/?日记>/g, '')                                   // 模型自作主张套的壳
        .replace(/^\s*(标题|时间)[：:][^\n]*\n/gm, '')               // 剥掉「标题：」「时间：」行
        .replace(/^\s*内容[：:]\s*/m, '')                            // 剥掉「内容：」前缀
        .trim();
      diaryTitle = diaryTitleOf(diary, day);
      issues = diaryRepeatIssues(diary).concat(diaryHallucIssues(diary));
      if (!issues.length) break;
      console.log('[diary] 第 ' + (round + 1) + ' 版有问题，重写：' + issues.join('；'));
    }

    // 三版改完还踩规则里的硬伤，就别落盘 —— 宁可这天不写，也不往日记目录里塞废稿
    const stillBad = diaryHallucIssues(diary);
    if (stillBad.length) {
      console.error('[diary] 改了三版还踩规则，这天不落盘：' + stillBad.join('；'));
      return { ok: false, day, reason: 'hallucinated', text: diary, issues };
    }

    if (diary.replace(/\s+/g, '').length < DIARY_MIN_CHARS) {
      console.error('[diary] 写出来的太短（' + diary.length + ' 字），这天不落盘，免得存一篇废话');
      return { ok: false, day, reason: 'too-short', text: diary, issues };
    }

    if (dryRun) {
      console.log('[diary] dryRun：生成成功但不落盘、不私发（' + diary.replace(/\s+/g, '').length + ' 字）');
      return { ok: true, dryRun: true, day, title: diaryTitle, text: diary, issues, lines: lines.length, chunks: chunks.length, digest, picked };
    }

    // 落盘。抽成 saveDiaryFile 是因为「等她回『发』才落盘」那条流程（diary-flow.js）也要用同一份写法。
    const fp = saveDiaryFile(day, diaryTitle, diary, { append: auto });
    console.log(`[diary] 已${fp.appended ? '追加' : '写'} ${day}.md（${diary.replace(/\s+/g, '').length} 字）`);
    botWrite(`data/diary/${day}.md`, '日记', fp.appended ? '又写了一篇日记' : '写了一篇日记');
    master(diary);
    return { ok: true, day, auto, text: diary, issues, lines: lines.length, chunks: chunks.length };
  } catch (e) {
    console.error('[diary]', e.message);
    return { ok: false, day, reason: 'error', error: e.message };
  }
}


// ===== 触发词（v80 统一，主人 2026-10-23 定）=====
// 主人原话：「【回复策略】现在0条。你应该把这个功能和其他触发词功能整合，而不是继续新增文件。」
// 所以「不用回复 / 适合回复 / 固定话术 / 喊一声就接话」全并成**一张表**：config.triggers。
// 一条长这样：{ id, words:[命中词], mode, say, note, enabled, groupOnly }
//   mode = say      命中就发固定这句话（不走模型）。老条目没写 mode 的按这个算（兼容）
//        = reply    命中就正常接话（走模型，@/上下文那些规矩照旧）
//        = noreply  命中就不接（最高优先，只记日志）—— 原来的「不用回复」
//        = good     命中就一定接（群里没人叫她也接）—— 原来的「适合回复」
// 数据只有这一处；面板「我的控制台 → 触发词」和私聊命令都是往这里写。
const TRIG_MODES = {
  say:     { name: '固定话术', use: '命中就发这句话，不走模型，文案一个字都不会变' },
  reply:   { name: '喊一声就接话', use: '命中就正常接一句（走模型），像有人叫她名字' },
  noreply: { name: '不用回复', use: '命中就不接，只记进聊天记录（优先级最高）' },
  good:    { name: '一定回复', use: '命中就一定接，群里没人叫她也接' },
};
function normTrig(x) {
  const it = x || {};
  const words = (Array.isArray(it.words) ? it.words : (Array.isArray(it.match) ? it.match : []))
    .map(w => String(w || '').trim()).filter(Boolean);
  let mode = String(it.mode || '').trim();
  if (!TRIG_MODES[mode]) mode = it.say ? 'say' : 'reply';
  return {
    id: String(it.id || ''), words, mode,
    say: String(it.say || ''), note: String(it.note || ''),
    enabled: it.enabled !== false, groupOnly: it.groupOnly === true,
  };
}
function readTriggers() {
  const fresh = readConfigFresh() || cfg;
  return (Array.isArray(fresh.triggers) ? fresh.triggers : []).map(normTrig).filter(x => x.words.length);
}
// 命中的第一条（只看启用、且过得了「仅群聊」这条）
function triggerHit(text, isGroup) {
  const t = String(text || '');
  if (!t) return null;
  for (const it of readTriggers()) {
    if (!it.enabled) continue;
    if (it.groupOnly && !isGroup) continue;
    if (it.words.some(w => t.includes(w))) return it;
  }
  return null;
}
// 固定话术（原来 matchTrigger 的活）：命中 mode=say 才返回，别的模式不出固定话
function matchTrigger(text, isGroup) {
  const it = triggerHit(text, isGroup !== false);
  return (it && it.mode === 'say' && it.say) ? it : null;
}
// 「不用回复 / 一定回复」这两个策略原来在 replypolicy.js 里，现在并到这里
function triggerPolicy(text, isGroup) {
  const hit = triggerHit(text, isGroup !== false);
  if (!hit) return { noreply: false, good: false, hit: null };
  return { noreply: hit.mode === 'noreply', good: hit.mode === 'good', hit };
}
// 写 config.triggers（面板和私聊命令都走这里，保证只有一份数据）
function saveTriggers(list) {
  let j;
  try { j = configStore.load(); } catch { return { error: '读不了配置' }; }
  j.triggers = (list || []).map((x, i) => {
    const it = normTrig(x);
    return {
      id: it.id || ('T' + Date.now().toString(36) + i), words: it.words, mode: it.mode,
      say: it.say, note: it.note, enabled: it.enabled, groupOnly: it.groupOnly,
    };
  });
  try { configStore.writeFull(j); } catch (e) { return { error: '写不了配置：' + e.message }; }
  try { botWrite('config', '触发词', j.triggers.length + ' 条'); } catch {}
  return { ok: true, list: j.triggers };
}
function triggerAdd(word, mode, opt) {
  const o = opt || {};
  const words = String(word || '').split(/[、,，|｜\n]+/).map(s => s.trim()).filter(Boolean);
  if (!words.length) return { error: '触发词不能为空' };
  if (!TRIG_MODES[mode]) return { error: '模式不对（say/reply/noreply/good）' };
  if (mode === 'say' && !String(o.say || '').trim()) return { error: '固定话术要写上说什么' };
  const list = readTriggers();
  const dup = list.find(x => x.mode === mode && x.words.some(w => words.includes(w)));
  if (dup) return { error: '「' + words.join('、') + '」已经在同一类里了' };
  list.push({ id: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), words, mode, say: String(o.say || ''), note: String(o.note || ''), enabled: true, groupOnly: o.groupOnly === true });
  return saveTriggers(list);
}
function triggerDel(id) {
  const list = readTriggers().filter(x => x.id !== String(id));
  return saveTriggers(list);
}
function triggerToggle(id, on) {
  const list = readTriggers().map(x => (x.id === String(id) ? Object.assign({}, x, { enabled: on === undefined ? !x.enabled : !!on }) : x));
  return saveTriggers(list);
}
// 私聊命令：不用回复：x / 适合回复：x / 喊我：x / 固定话：词 = 话 / 触发词（看列表）/ 删触发词 N
function triggerCommand(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = t.match(/^不用回复[：:]\s*([\s\S]+)$/))) {
    const r = triggerAdd(m[1], 'noreply');
    return r.error ? '没加上：' + r.error : '好，以后这类话我就不接了：' + m[1].trim().slice(0, 40);
  }
  if ((m = t.match(/^(?:适合回复|一定回复|必须回复)[：:]\s*([\s\S]+)$/))) {
    const r = triggerAdd(m[1], 'good');
    return r.error ? '没加上：' + r.error : '好，以后这类话我一定接：' + m[1].trim().slice(0, 40);
  }
  if ((m = t.match(/^(?:喊我|叫我|接话)[：:]\s*([\s\S]+)$/))) {
    const r = triggerAdd(m[1], 'reply');
    return r.error ? '没加上：' + r.error : '好，看到「' + m[1].trim().slice(0, 20) + '」我就当有人叫我';
  }
  if ((m = t.match(/^固定话[：:]\s*([^\s=＝]+)\s*[=＝]\s*([\s\S]+)$/))) {
    const r = triggerAdd(m[1], 'say', { say: m[2] });
    return r.error ? '没加上：' + r.error : '好，看到「' + m[1] + '」我就说那句';
  }
  if (/^(看)?(回复策略|触发词)$/.test(t)) {
    const list = readTriggers();
    if (!list.length) return '现在一条触发词都没有';
    const out = ['触发词一共 ' + list.length + ' 条：'];
    list.forEach((x, i) => {
      out.push((i + 1) + '. [' + (TRIG_MODES[x.mode] ? TRIG_MODES[x.mode].name : x.mode) + '] ' + x.words.join('、')
        + (x.mode === 'say' ? ' → ' + x.say.slice(0, 20) : '') + (x.enabled ? '' : '（已关）'));
    });
    return out.join('\n');
  }
  if ((m = t.match(/^删(?:触发词|不用回复|适合回复|一定回复)\s*(\d+)$/))) {
    const list = readTriggers();
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= list.length) return '序号不对，先发「触发词」看列表';
    const gone = list[i];
    triggerDel(gone.id);
    return '删掉了：' + gone.words.join('、');
  }
  return null;
}

// 判断要不要联网：
// ① 显式要求/实时类词 → 必搜
// ② 本地没资料 + 明显在问知识型问题 → 搜
// ③ 本地有资料，但问题里的词在资料里覆盖不足（<55%）→ 补搜
const WEB_WORDS = /(搜一下|搜搜|搜索|查一下|查查|帮我查|查下|看看|上网|联网|网上|最新|现在|实时|价格|多少钱|天气|气温|下雨|新闻|热搜|股价|汇率|比分|几点|日期|机票)/;
const DATE_WORDS = /(今天|今日|明天|昨天)/;   // 单独出现不搜（「今天好累」），配上提问词才搜
// 2026-11-07 补词：她定「被提问＝被需要」，那提问就得真去查。
// 原来漏了「北京在哪」「你知道达尔文吗」这类最常见的问法，等于嘴上说被需要、实际不查。
const ASK_WORDS = /(攻略|怎么|如何|教程|推荐|哪个|哪里|在哪|是什么|为什么|能不能|技巧|打法|流程|配装|数值|什么样|什么|几个|几种|几级|几条|多少|哪些|是谁|叫什么|介绍|你知道吗|知道吗|你知道.{0,8}吗|科普)/;
// 「怎么X了」＝问现状/惊讶（「怎么禁言了」＝发现被禁言了），不是 how-to 提问。主人 2026-11-23 令：这种带「了」的不联网。
// 与 rules/scene-h-chat.js 的 PAST_TENSE_EXCL 同一条判据；末尾带问号是明确提问、不拦。
const ASK_PAST_EXCL = /^怎么.{1,12}了\s*[。！!～~]?\s*$/;
// 「比一比」的题：A 跟 B 哪个厉害/强（主人 2026-10-22：别人的 AI 答这种又快又有观点，我也要）
// 2026-11-02 补：论战型说法（打得过/打得赢/谁赢/胜率）以前一条都不算「比一比」，问「超级烈空坐打的过绿毛虫吗」
// 直接被判成「不用搜」→ 纯靠记忆瞎蒙。现在这些也算，宁可多搜一次。
const VS_WORDS = /(哪个|谁)[^，。！？\n]{0,8}(厉害|强|猛|好看|好玩|好用|帅|可爱)|哪个好|对比一下|[东西版本部代]跟[^\s，。！？]{1,12}(哪个|谁)|[东西版本部代]和[^\s，。！？]{1,12}(哪个|谁)|打的?过|打的?赢|能不能打过|干得过|谁赢|胜负|胜率/;;

/* ===== 功能清单直答（主人 2026-11-22 定）=====
 * 「下次命中『你有什么功能/哪些功能』直接代码回复功能清单，少调用一轮」。
 * 清单正文只有一份：data/功能清单.md（主人随时改，代码只读不写）。
 * 条目尾巴的（QQ）/（B站）只在该平台出现；（必出）每条都带。见下面分区说明：
 *   ① 泛问「你有什么功能」→ 每个通用分区随机挑 1~3 条（必出条照带）
 *   ② 问「你在X平台有什么功能」→ 那个平台的「独有」分区全部列出、不抽
 *   ③ 收尾不写进数据：发完让模型现说一句她自己的口气
 * 只认「问的是她自己的功能」这一种问法；「你知道达尔文吗」这类照旧走原来的联网判定。 */
const CAPABILITY_PATH = path.join(ROOT, 'data', '功能清单.md');
const FUNC_ASK = /(?:你|您)(?:都|还|一共|到底)?(?:有|会|能|可以)(?:些|点)?[^，,。！!？?；;\n]{0,10}(?:什么|啥|哪些)(?:功能|本事|能力|作用|用处|玩法|爱好|兴趣|技能|特长|本领)/;
const FUNC_ASK2 = /(?:你|您)(?:都|还)?(?:会|能)(?:什么|啥|哪些|干什么|干啥|做什么|做啥|干嘛)\s*[啊呀呢吗么哈嘛吧？?！!。~～\s]*$|功能清单/;
const FUNC_ASK3 = /(?:你|您)的[^，,。！!？?\s]{0,6}(?:功能|本事|能力|作用|用处|技能|特长|本领)/;
// 「怎么用你 / 你能帮我做什么」也算问功能（2026-11-22 补，主人说这类问法漏了）
const FUNC_ASK4 = /(?:怎么|如何)用(?:你|妳)|你能帮我(?:做|干)(?:什么|啥|哪些)/;
// 问「你在X平台有什么功能」→ 该平台独有全列；只有功能词没平台词 → 泛问
const PLAT_FUNC_ASK = /(?:QQ|qq|企鹅|群|B站|b站|哔哩|bilibili|Bilibili)[^，,。！!？?\n]{0,10}(?:什么|啥|哪些)[^，,。！!？?\n]{0,6}(?:功能|本事|能力|用处)/;
function isPlatformFuncAsk(text) {
  const m = String(text || '').match(PLAT_FUNC_ASK);
  if (!m) return '';
  const w = String(m[0] || '').toLowerCase();
  if (w.indexOf('b站') >= 0 || w.indexOf('bili') >= 0 || w.indexOf('哔哩') >= 0) return 'bili';
  return 'qq';
}
function isFuncAsk(text) {
  const s = String(text || '');
  return FUNC_ASK.test(s) || FUNC_ASK2.test(s) || FUNC_ASK3.test(s) || FUNC_ASK4.test(s) || !!isPlatformFuncAsk(s);
}
// 当前会话在哪个平台：QQ 走 ctx.source / 会话键，B站那边有 bili_ 前缀
function platformOf(ctx) {
  try {
    if (String((ctx && ctx.source) || '').toLowerCase() === 'bili') return 'bili';
    if (/^bili/i.test(String((ctx && ctx.k) || ''))) return 'bili';
  } catch (e) {}
  return 'qq';
}
function capNormPlat(p) { return String(p || '') === 'bili' ? 'bili' : 'qq'; }
const CAP_TAG_QQ = /（QQ）\s*$/;
const CAP_TAG_BILI = /（B站）\s*$/;
const CAP_TAG_MUST = /（必出）/;
const CAP_SHARED = /^(?:试试对我说|对我发指令|其他账号|把你的信息悄悄告诉我)$/;
/* 读清单 → [{title, items:[{text, must}]}]，顺手按平台甩掉另一边平台的条目 */
function capabilitySections(platform) {
  const plat = capNormPlat(platform);
  const out = [];
  let cur = null;
  for (const raw of String(readCached(CAPABILITY_PATH) || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf('## ') === 0) {
      cur = { title: line.slice(3).trim(), items: [] };
      out.push(cur);
      continue;
    }
    if (line.indexOf('- ') !== 0 || !cur) continue;
    const isQq = CAP_TAG_QQ.test(line), isBili = CAP_TAG_BILI.test(line);
    const must = CAP_TAG_MUST.test(line);
    const body = line.slice(2).replace(CAP_TAG_QQ, '').replace(CAP_TAG_BILI, '').replace(CAP_TAG_MUST, '').trim();
    if (!body) continue;
    /* 「其他账号」这一栏的标签是「这是哪个平台的号」→ 反过来：本平台的号不写，只给对方平台的号；
     * 别的栏（指令）标签是「只在那个平台出现」。 */
    if (cur.title === '其他账号') {
      if (isQq && plat === 'qq') continue;
      if (isBili && plat === 'bili') continue;
    } else {
      if (isQq && !isBili && plat !== 'qq') continue;
      if (isBili && !isQq && plat !== 'bili') continue;
    }
    cur.items.push({ text: body, must });
  }
  return out.filter(s => s.items.length);
}
function capShuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
/* 泛问：通用分区各随机 1~3 条，(必出) 的条一定在；总长卡平台上限 */
function capabilityText(platform, rnd) {
  const r = typeof rnd === 'function' ? rnd : Math.random;
  const secs = capabilitySections(platform).filter(s => CAP_SHARED.test(s.title));
  if (!secs.length) return '';
  let cap = 590;
  try { cap = Math.max(200, (require('./platform-limits').capOf('qq') || 600) - 10); } catch (e) {}
  const mustBlocks = [];
  let budget = cap;
  for (const s of secs) {
    const must = s.items.filter(x => x.must);
    if (!must.length) continue;
    const block = s.title + '：\n' + must.map(x => '· ' + x.text).join('\n');
    mustBlocks.push({ title: s.title, block });
    budget -= block.length + 2;
  }
  const blocks = [];
  let len = 0;
  for (const s of secs) {
    const must = s.items.filter(x => x.must);
    if (must.length) {                       // 有必出条的区：整区固定，不加随机条
      blocks.push(s.title + '：\n' + must.map(x => '· ' + x.text).join('\n'));
      continue;
    }
    const want = 1 + Math.floor(r() * 3);    // 每区随机 1~3 条
    const picked = capShuffle(s.items.slice(), r).slice(0, Math.min(want, s.items.length));
    const block = s.title + '：\n' + picked.map(x => '· ' + x.text).join('\n');
    if (len + block.length + 2 > budget) continue;   // 放不下就跳过这一区，必出的区早算好了
    blocks.push(block);
    len += block.length + 2;
  }
  return blocks.join('\n\n');
}
/* 问某个平台的独有功能：全列、不抽 */
function capabilityExclusive(platform) {
  const plat = capNormPlat(platform);
  const want = plat === 'bili' ? 'B站 独有' : 'QQ 独有';
  const sec = capabilitySections(plat).filter(s => s.title === want)[0];
  const lines = sec ? sec.items.map(x => '· ' + x.text) : [];
  if (!lines.length) return '';
  return (plat === 'bili' ? '这边B站独有的：\n' : '这边QQ独有的：\n') + lines.join('\n') + '\n\n记东西、约定这些两边都能用';
}
// 收尾：清单发完再让模型现说一句（不把清单喂回去，只告诉它这是收尾）
const CLOSING_PROMPT = '（你刚把功能清单发给他了。现在只补一句收尾：一句话，短，口语，句末不带句号，'
  + '别复述清单里的东西，别客套，别问「还想知道什么」。用你自己的口气说。）';
async function closingLine(msgs, k) {
  try {
    const arr = (Array.isArray(msgs) ? msgs : []).slice();
    arr.push({ role: 'system', content: CLOSING_PROMPT });
    const out = await callLLM(arr, { tag: 'reply', key: k, maxTokens: 80 });
    return String(out || '').trim().split('\n')[0].replace(/^[「『“"']+|[」』”"']+$/g, '').trim();
  } catch (e) {
    console.log('[web] 收尾那句没生成：' + ((e && e.message) || e));
    return '';
  }
}

function needWeb(text, kbRet) {
  if (!text) return false;
  if (VS_WORDS.test(text)) return true;         // 比较题：哪怕本地有资料也补外证，答案要有细节
  if (WEB_WORDS.test(text)) return true;        // 明说要搜/查，或者问的是实时数据（「怎么禁言了，查一下」照搜）
  if (ASK_PAST_EXCL.test(String(text).trim())) return false;   // 新增 2026-11-23：「怎么X了」问现状，不联网
  if (isFuncAsk(text)) return false;            // 问的是她自己的功能 → 代码发清单（见 buildMessages）
  /* 本地知识库先于联网（主人 2026-11-22：「本地还有很多词典、攻略等内容，也没搜」）：
   * buildMessages 每轮已经跑过 kb.retrieve（游戏攻略 / 学到的 / 教学条 / 功能词典详解 / 回话路径），
   * 以前这里只收到一个布尔、等于没看本地结果 → 本地有答案也照样联网。
   * 现在：除攻略外的本地命中（词典/教学/学到的/回话路径）就算「本地够了」；
   * 攻略要看覆盖够不够（≥55%）——够就不联网，不够仍然补搜。 */
  const kinds = (kbRet && kbRet.kinds) || [];
  const block = String((kbRet && kbRet.block) || '');
  const localHit = !!block;
  if (localHit && kinds.indexOf('guide') < 0) return false;
  if (localHit && guides.coverage(text, block) >= 0.55) return false;
  if (DATE_WORDS.test(text) && ASK_WORDS.test(text)) return true;   // 「今天天气怎么样」
  if (!localHit) return ASK_WORDS.test(text) && text.length >= 4;
  return true;                                   // 本地只有攻略且覆盖不足 → 补搜
}

// ===== 联网结果 + 主人认可 → 自动入库 =====
const pendingWeb = new Map(); // k -> {t, query, web, answer}
const APPROVE = /(认可|对的|正确|好用|太厉害了|真棒|太棒了|好棒)/;

function rememberWeb(k, query, web) {
  pendingWeb.set(k, { t: Date.now(), query, web, answer: '' });
}
function setWebAnswer(k, ans) {
  const p = pendingWeb.get(k);
  if (p) p.answer = ans;
}
// 把她的口语化回答压成「关键事实」，去掉颜文字/语气词/寒暄，别占地方
function condense(ans) {
  let s = String(ans || '');
  s = s.replace(/૮[^ა\n]*ა/g, ' ');                                  // 颜文字
  s = s.replace(/[（(][^）)\n]{0,14}(QAQ|qwq|QWQ|T_T|ω|·̭|᷄|᷅)[^）)\n]{0,14}[）)]/gi, ' ');
  s = s.replace(/QAQ|qwq|QWQ|T_T|orz|嘿嘿|呜呜+|呜|啦|呀|哦|噢|欸|诶|哎/g, ' ');
  const PUNCT = /^[\s，,、；;。～~…\.·:：\-]+/;
  const keep = [];
  for (const raw of s.split(/[。！？；!?;\n]+/)) {
    let q = raw;
    for (let i = 0; i < 3; i++) {                                     // 反复剥掉开头的称呼和口头禅
      q = q.replace(PUNCT, '')
        .replace(/^(主人|欧尼酱|你)[，,、\s～~]*/, '')
        .replace(/^(我看了(一下)?|我查了(一下)?|我搜了(一下)?|我感觉|感觉|应该是)[，,、\s]*/, '')
        .replace(PUNCT, '');
    }
    q = q.replace(/\s+/g, ' ').replace(/\s+([，,、；;。！？!?：:])/g, '$1').trim();
    if (q.length < 4) continue;                                       // 纯语气
    if (/^(嗯|好的|好哦|知道|明白|这个我记不清|我记不清|我不太清楚|不太清楚|我不确定|不确定|都是网上|可能有点|可能是)/.test(q)) continue;
    keep.push(q);
    if (keep.length >= 5) break;                                      // 最多 5 条
  }
  let out = keep.join('；');
  if (out.length > 220) out = out.slice(0, 220) + '…';
  return out;
}

function maybeApprove(k, text, isMaster) {
  if (!isMaster || !text) return false;
  if (!APPROVE.test(text)) return false;
  const p = pendingWeb.get(k);
  if (!p || Date.now() - p.t > 15 * 60 * 1000) return false;  // 15 分钟内才认
  pendingWeb.delete(k);

  // 她本来就答「记不清」，说明联网也没答案，别把垃圾存进库
  const noAnswer = !p.answer || /(记不清|不知道|不清楚|没查到|说法不一样)/.test(p.answer);
  if (noAnswer) { console.log('[guide] 主人认可，但这次没有可靠答案，不入库'); return 'EMPTY'; }

  // 时效性内容不入库（今天说明天就过期，会变成假知识）
  const PERISHABLE = /(天气|气温|下雨|新闻|股价|汇率|比分|热搜|几点|今天|今日|现在|实时)/;
  if (PERISHABLE.test(p.query) && (cfg.guideSave?.skipPerishable !== false)) {
    console.log('[guide] 主人认可，但这是时效性内容，不入库');
    return 'STALE';
  }

  const fact = condense(p.answer);
  if (!fact) { console.log('[guide] 主人认可，但压不出关键内容，不入库'); return 'EMPTY'; }

  const file = path.join(ROOT, 'data', 'guides', '联网确认.md');
  const title = p.query.replace(/\s+/g, ' ').slice(0, 30);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '<!-- guide:联网确认 -->\n# 主人认可过的关键结论\n\n> 只记关键事实，主人确认过，优先级高于网上二手攻略。\n\n', 'utf8');
  } else if (fs.readFileSync(file, 'utf8').includes(`## ${title}`)) {
    console.log(`[guide] 已有同一条，跳过：${title}`);
    return 'SAVED';
  }

  const day = stamp();
  const sources = (p.web || '').split('\n')
    .filter(l => l.trim().startsWith('来源：')).slice(0, 2)
    .map(l => l.trim().replace(/^来源：/, '')).join(' | ');
  const section = [
    `## ${title}`,
    `- ${withStamp(fact)}`,
    sources ? `- 来源：${sources}` : '',
    `- 确认：${day}`,
  ].filter(Boolean).join('\n') + '\n\n';
  fs.appendFileSync(file, section, 'utf8');
  markNew(relPath(file), [fact]);   // 面板上给这条挂个小红点
  botWrite('data/guides/联网确认.md', '攻略笔记', title + '：' + fact.slice(0, 120));
  console.log(`[guide] 主人认可，已入库：${title}（${fact.length} 字）`);
  return 'SAVED';
}

// 问天气要知道是哪个城市：问题里 → 资料卡 → 主人配置 → 都没有就反问
async function resolveRegion(ctx) {
  if (ctx.source === 'bili') return cfg.city || '';
  if (!regionResolver) return '';
  try { return (await regionResolver(ctx)) || ''; } catch { return ''; }
}
const WEATHER_RE = /(天气|气温|下雨|下雪|几度|多少度|温度|冷不冷|热不热)/;

// 历史里找「一模一样的话」上一次的回复（逐字复读 → 大概率照原回复答，主人 2026-10-22 改定）
function prevAnswerFor(k, text) {
  const h = getHist(k);
  const norm = s => String(s || '').replace(/\s+/g, '');
  const t = norm(text);
  if (!t || t.length < 2) return '';
  for (let i = h.length - 2; i >= 0; i--) {
    if (h[i].role !== 'user') continue;
    const body = String(h[i].content || '').replace(/^.*?说: /, '');
    if (norm(body) !== t) continue;
    for (let j = i + 1; j < h.length; j++) {
      if (isSpeech(h[j])) return String(h[j].content || '');
      if (h[j].role === 'user') break;
    }
  }
  return '';
}

// ===== 话题翻篇（主人 2026-10-22 定）：说过的话题短期内（0.5~5 天）不反复主动说 =====
// 「同一个话题说过就翻篇」落到实处：回复里带上了口味词 → 把那个词封 0.5~5 天（每次随机），
// 期间不主动提；别人先聊到才顺带接一句。记录在 data/said-topics.jsonl。
const SAID_TOPIC_PATH = path.join(ROOT, 'data', 'said-topics.jsonl');
function loadSaidTopics() {
  try {
    return fs.readFileSync(SAID_TOPIC_PATH, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// 还在翻篇期的话题（没到期的）
function activeSaidTopics() {
  const now = Date.now();
  return loadSaidTopics().filter(x => x.until && now < x.until);
}
function noteSaidTopic(ans) {
  const s = String(ans || '');
  if (!s || !cfg.masterQQ) return;
  const items = (taste && taste.listMine(cfg.masterQQ)) || [];
  const hit = items.filter(x => x.t && x.t.length >= 2 && s.includes(x.t));
  if (!hit.length) return;
  const now = Date.now();
  const act = activeSaidTopics().map(x => x.topic);
  const fresh = hit.filter(x => !act.includes(x.t));
  if (!fresh.length) return;
  const dur = (0.5 + Math.random() * 4.5) * 24 * 3600 * 1000;   // 0.5~5 天
  try {
    fs.mkdirSync(path.dirname(SAID_TOPIC_PATH), { recursive: true });
    fs.appendFileSync(SAID_TOPIC_PATH, JSON.stringify({ t: now, until: now + dur, topic: fresh.map(x => x.t).join('、') }) + '\n', 'utf8');
    console.log('[翻篇] 说过「' + fresh.map(x => x.t).join('、') + '」，封 ' + (dur / 86400000).toFixed(1) + ' 天不主动提');
  } catch { /* 写不进就算了 */ }
}

// ===== 笑点解析 → 新梗入库（主人 2026-10-22 定：是梗就录进梗库，带原文，@这种无关内容去掉）=====
function recordXiaodianMeme(target, ans) {
  try {
    const grab = re => { const m = String(ans || '').match(re); return m ? m[1].trim() : ''; };
    // 两种格式都认：老四行「对应的梗：」和新范例式「资料：司凤谐音死冯…」（梗名=谐音/衍生前面的词）
    let meme = grab(/对应的梗[:：]\s*([^\n]+)/);
    let meaning = grab(/含义[:：]\s*([^\n]+)/);
    if (!meme) {
      const zl = grab(/资料[:：]\s*([^\n]+)/);
      const nm = zl && zl.match(/^([^，。]{1,8}?)(?:谐音|衍生|字形)/);
      if (nm) { meme = nm[1]; meaning = meaning || zl; }
    }
    if (!meme || /没对应到|没有对应|没查到|不知道/.test(meme)) return;        // 没认出梗不录
    if (guides.memeHit(meme)) return;                                        // 库里已有这个梗
    const word = String(target || '').replace(/@[^\s，。！？:：]{1,20}/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!word || word.length < 4) return;
    const LIB = path.join(ROOT, 'data', '网络热梗.md');
    if (fs.readFileSync(LIB, 'utf8').includes(`## ${meme.slice(0, 20)}`)) return;
    const section = [
      '', '## ' + meme.slice(0, 20), '',
      '- 特征词：' + word,
      meaning ? '- 是什么：' + meaning.slice(0, 80) : '',
      '- 怎么接：一句带过，表示看懂了笑点就行。别解释这个梗本身。',
      '- 原文：' + word,
      '',
    ].filter(Boolean).join('\n') + '\n';
    fs.appendFileSync(LIB, section, 'utf8');
    markNew(relPath(LIB), [word]);   // 面板挂小红点
    botWrite('data/网络热梗.md', '笑点解析', '新梗入库「' + meme.slice(0, 20) + '」（原文：' + word + '）');
    console.log('[笑点解析] 新梗入库：' + meme.slice(0, 20));
  } catch (e) { console.log('[笑点解析] 入库失败：' + e.message); }
}



// ===== 笑点解析 · 完整路径（主人 2026-10-22 定为独立复杂功能，不是一句话任务）=====
// 第1步 收材料：qq.js 已算好（目标=引用>图>最近发言；此人上5、整群上10、下3，图片算一条）
// 第2步 找资料：自有梗库 → 梗词典 → 联网搜「xx 是什么梗」（最多两次）；人物列表.md 的设定也算资料
// 第3步 分层解析：提示词带主人手写范例 + 逐条拆解（每层=谁+原话+意思+好笑在哪）
// 第4步 质检：xiaodianEnsure 格式校验 → 跑偏重说一次 → 兜底模板；「喵」永远收尾
// 第5步 入库：解析出明确梗 → recordXiaodianMeme 进梗库（chat() 里做，demo 不做）
function xdCleanAt(t) { return String(t || '').replace(/@[^\s，。！？:：]{1,20}/g, '').replace(/\s+/g, ' ').trim(); }

// 自有资料查找（不受 memeHit 的 12 字门槛限制，短候选词也能查）
function xdLibLookup(text) {
  const t = String(text || '').toLowerCase();
  if (!t || t.length < 2) return null;
  const gl = guides.glossaryHit(text);
  if (gl.length) return '自有梗库/词典查到：' + gl.map(g => '「' + g.title + '」——' + g.meaning).join('；');
  const list = guides.memeList ? guides.memeList() : [];
  for (const sec of list) {
    if (!sec.words || !sec.words.length) continue;
    const w = sec.words.find(x => x && t.includes(String(x).toLowerCase()));
    if (w) return '自有梗库查到「' + sec.title + '」' + (sec.meaning ? '：' + sec.meaning : '') + (sec.how ? '（接法参考：' + String(sec.how).slice(0, 120) + '）' : '');
  }
  return null;
}

// 范例文件分节：原始聊天记录（给人看）/ 具体格式 / 用法 / 参照（11 档完整样例）/ 禁项。
// 喂模型时**跳过「原始聊天记录」**（那里有占位，会被当成台词照抄），只取后面几节。
function xiaodianExampleText() {
  let raw = '';
  try { raw = readCached(XIAODIAN_PATH) || ''; } catch { raw = ''; }
  const grab = name => {
    const m = String(raw).match(new RegExp('##\\s*' + name + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)'));
    return m ? m[1].trim() : '';
  };
  return [grab('具体格式'), grab('喜剧术语与话术怎么用'), grab('参照'), grab('反例'), grab('禁项')].filter(Boolean).join('\n\n');
}
// 兼容别名：语义上它就是「照着写的指南」
function xiaodianGuide() { return xiaodianExampleText(); }

/* ===== 笑点解析词表（主人 2026-11-22 定：术语 + 说法两份清单，分「已验/待验」）=====
 * 为什么分已验/待验：主人范例、主人教的梗词句是验过的；我从相声/脱口秀/网络梗整理的算待验，
 * 只有跟这次场景对得上才喂给模型，剩下的留在文件里等主人确认——一股脑塞进去只会变成堆词。
 * 这里做四件事：读三份词表、判场景、给这一档能用的说法、判一版答案合不合格。 */
function xdParseList(file, fields) {
  let raw = '';
  try { raw = readCached(file) || ''; } catch { raw = ''; }
  const out = [];
  for (const ch of String(raw).split(/^##\s+/m).slice(1)) {
    const nl = ch.indexOf('\n');
    if (nl < 0) continue;
    const title = ch.slice(0, nl).trim();
    const body = ch.slice(nl + 1);
    if (!title) continue;
    const o = { title };
    let ok = true;
    for (const f of fields) {
      const m = body.match(new RegExp('^' + f + '[：:]\\s*([^\\n]*)', 'm'));
      if (!m) { ok = false; break; }
      o[f] = m[1].trim();
    }
    if (ok && o['状态']) out.push(o);       // 没写状态的是说明节，不当条目
  }
  return out;
}
function xdTerms() { return xdParseList(XD_TERM_PATH, ['分类', '状态', '出处', '适用材料']); }
function xdTalks() { return xdParseList(XD_TALK_PATH, ['分类', '状态', '出处', '固定用法', '示例']); }
function xdScenes() {
  let raw = '';
  try { raw = readCached(XD_SCENE_PATH) || ''; } catch { raw = ''; }
  const out = [];
  for (const ch of String(raw).split(/^##\s+/m).slice(1)) {
    const nl = ch.indexOf('\n');
    if (nl < 0) continue;
    const head = ch.slice(0, nl).trim();
    const body = ch.slice(nl + 1);
    const id = (head.match(/^(S\d+)/) || [])[1];
    if (!id) continue;
    const g = k => { const m = body.match(new RegExp('^' + k + '[：:]\\s*([^\\n]*)', 'm')); return m ? m[1].trim() : ''; };
    out.push({ id, name: head.replace(/^S\d+\s*/, ''), trigger: g('触发'), terms: g('推荐术语'), talks: g('推荐说法'), avoid: g('不要用') });
  }
  return out;
}
function xdLexicon() {
  const terms = xdTerms(), talks = xdTalks(), scenes = xdScenes();
  return { terms, talks, scenes };
}
function xdSplitList(s) {
  // 只用「、／/」当分隔：说法名里本身可能带逗号（「你说的对，但是」）
  return String(s || '').split(/[、／\/]+/).map(x => x.trim()).filter(Boolean);
}

// 判场景（确定性，只当建议；模型可以换，但只能换成词表里有的档）
function xdSceneOf(target, xd) {
  const t = String(target || '');
  const scope = String((xd && xd.scope) || '');
  if (scope === 'thread') return 'S11';
  if (/［图[:：]|图上[：:]|［表情|截图|表情包/.test(t)) return 'S5';
  if (/［视频：|视频链接|视频[:：]|视频里/.test(t)) return 'S6';
  if (/https?:\/\//.test(t)) return 'S7';
  if (/这直接导致|如何解释|有本事|我再说一遍|确凿证据|问责|政治表演/.test(t)) return 'S10';
  if (/都叫|同名|重名|同一个名字|另一个我|也是我/.test(t)) return 'S8';
  if (/生日|刚过完|隔天|第二天|一分钟后|早睡|昨天|今天.*昨天/.test(t)) return 'S9';
  if (/复读|跟风|扣1|\+1|加一|越传/.test(t)) return 'S4';
  if (/自称|平时|结果他|反而|竟然是/.test(t)) return 'S3';
  if (scope === 'single') return 'S2';
  return 'S1';
}

// 联网结果适配（主人 2026-11-22 定）：只抽「分类/用法/示例」后面的短句，
// 解释性长段（不难看出/综上/总之…）一律丢掉——整段塞进去模型只会照抄成套话。
function xdWebStyle(text, sid) {
  const raw = String(text || '');
  const out = [];
  const re = /(?:分类|用法|用法示例|固定用法|示例|例句|口头禅|常搭配)[：:]\s*([^\n。；;，,]{2,30})/g;
  let m;
  while ((m = re.exec(raw)) && out.length < 3) {
    const s = String(m[1]).replace(/[“”"「」『』]/g, '').trim();
    if (s.length < 2) continue;
    if (/(不难看出|综上|总之|值得注意|可以说|这篇文章|本文|综上所)/.test(s)) continue;
    out.push(s);
  }
  return out;
}

// 这一档能用的说法：先落到梗库/梗词句/梗词典（有原文用法就用原文），全空才用适配后的联网短句
function xdMemeStyle(target, xd, webText) {
  const L = xdLexicon();
  const sid = xdSceneOf(target, xd);
  const scene = L.scenes.find(s => s.id === sid) || L.scenes[0] || {};
  const terms = xdSplitList(scene.terms).map(n => {
    const hit = L.terms.find(t => t.title === n || t.title.replace(/（.*?）/g, '') === n || n.startsWith(t.title.replace(/（.*?）/g, '')));
    return hit ? { name: n, cat: hit['分类'], state: hit['状态'], use: hit['适用材料'] } : { name: n, cat: '', state: '', use: '' };
  });
  const lines = [];
  let from = '';
  for (const name of xdSplitList(scene.talks).slice(0, 3)) {
    const key = name.replace(/[（(].*?[）)]/g, '').trim();
    let used = false;
    try {
      const how = guides.memeHowto && guides.memeHowto(key);
      if (how && how.how) { lines.push('「' + key + '」接法：' + String(how.how).slice(0, 80)); used = true; from = from || '自有梗库'; }
    } catch {}
    if (!used) {
      try {
        const gl = guides.glossaryHit ? guides.glossaryHit(key) : [];
        if (gl && gl.length) { lines.push('「' + key + '」意思：' + String(gl[0].meaning).slice(0, 60)); used = true; from = from || '梗词典'; }
      } catch {}
    }
    if (!used) {
      const t = L.talks.find(x => x.title === name || x.title === key);
      if (t) { lines.push('「' + t.title + '」' + String(t['固定用法']).slice(0, 60) + '（例：' + String(t['示例']).slice(0, 40) + '）'); used = true; from = from || '说法表'; }
    }
  }
  if (!lines.length && webText) {
    for (const s of xdWebStyle(webText, sid)) { lines.push('联网用法：' + s); }
    if (lines.length) from = '联网(已适配)';
  }
  if (!lines.length) {
    const t = L.talks.filter(x => x['状态'] === '已验').slice(0, 2);
    for (const x of t) lines.push('「' + x.title + '」' + String(x['固定用法']).slice(0, 50));
    if (lines.length) from = '说法表(已验兜底)';
  }
  return { sid, scene: scene.name || '', terms, lines, from };
}

// 套话/禁项命中（只查机器人腔和造假；术语不算）
function xdSloganHit(text) {
  const body = String(text || '').replace(/令人忍俊不禁喵[\s～~！!。.]*$/, '');
  const hits = [];
  for (const w of XD_BAN_WORDS) if (body.includes(w)) hits.push(w);
  return hits;
}

// 解析有没有真的引到目标原话：拿目标里 4 字以上的连续片段去比对
function xdHasTargetFrag(txt, tgt) {
  const norm = s => String(s || '').replace(/[\s`"'“”「」『』（）()【】\[\]：:，,。.！!？?~～…、·—\-]/g, '');
  const a = norm(txt), b = norm(tgt);
  if (!a || b.length < 2) return false;
  const n = Math.min(4, b.length);            // 目标很短（「在吗」这种）就按实际长度比，别一律卡 4 字
  for (let i = 0; i + n <= a.length; i++) if (b.includes(a.slice(i, i + n))) return true;
  return false;
}

// 答案体检（主人 2026-11-22 契约）：目标一致 / 资料行 / 层号 / 层尾 / 末句 / 术语说法 / 禁项
// 2026-11-24 收紧：占位符 / 空话 / 每层有没有实质 / 有没有引目标原话
function xdCheck(ans, xd) {
  const t = String(ans || '').trim();
  const why = [];
  const fmt = /【聊天记录】([\s\S]*?)【解析】([\s\S]*)$/.exec(t);
  const recRaw = fmt ? fmt[1] : '';
  const body = fmt ? fmt[2] : '';
  if (!fmt) why.push('缺【聊天记录】或【解析】');
  const recs = recRaw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!recs.length) why.push('【聊天记录】是空的');
  else if (!recs.some(l => /[:：]/.test(l))) why.push('【聊天记录】没按「昵称：原话」写');
  // 记录行必须是真实群名片：模板占位符照抄过一次（2026-11-24 群里的真实事故，写成「代称：…」）
  if (recs.some(l => /^(代称|昵称|某人|群友)(?=[：:])/.test(l))) why.push('【聊天记录】把「昵称」占位符照抄了，要写真实群名片');
  if (/代称/.test(t)) why.push('出现「代称」两个字（模板占位符泄漏）');
  // 只解析被选中的那条：记录里的原话必须出现在 xd.target 里
  const scope = String((xd && xd.scope) || '');
  const tgt = String((xd && xd.target) || '').replace(/\s+/g, '');
  if (scope && scope !== 'thread' && tgt) {
    const stray = recs.filter(l => {
      const q = l.split(/[:：]/).slice(1).join('：').replace(/\s+/g, '');
      if (!q) return false;
      return !tgt.includes(q) && !q.includes(tgt.slice(0, 20));
    });
    if (stray.length) why.push('解析到了没被选中的对话内容（第一处：' + stray[0].slice(0, 24) + '）');
  }
  if (!/资料[：:]/.test(body)) why.push('缺「资料：」行');
  const nums = (body.match(/此为(\d+)层笑点/g) || []).map(x => Number(String(x).replace(/\D/g, '')));
  if (!nums.length) why.push('没写「此为N层笑点」');
  else if (nums[0] !== 1) why.push('层号要从 1 层开始');
  else if (nums.some((n, i) => i > 0 && n !== nums[i - 1] + 1)) why.push('层号断档：' + nums.join('、'));
  if (!/令人忍俊不禁喵[\s～~！!。.]*$/.test(t)) why.push('最后一句必须是「令人忍俊不禁喵」');
  const mid = t.replace(/令人忍俊不禁喵[\s～~！!。.]*$/, '');
  const midLayers = (mid.match(/此为\d+层笑点/g) || []).length;
  const midMeow = (mid.match(/令人忍俊不禁(?!喵)/g) || []).length;
  // 除最后一层外，每层结尾要接「令人忍俊不禁」；最后一层由末句「令人忍俊不禁喵」承担
  if (midLayers > 1 && midMeow < midLayers - 1) why.push('除末层外每层结尾要接「令人忍俊不禁」');
  if (body.replace(/\s/g, '').length < 20) why.push('【解析】太短，没写实质内容');
  // 至少一个术语或说法（都必须来自词表）
  const L = xdLexicon();
  const termWords = L.terms.map(x => x.title.replace(/（.*?）/g, '').split(/[／/]/)[0].trim()).filter(w => w.length >= 2);
  const talkWords = L.talks.map(x => x.title.replace(/（.*?）/g, '').trim()).filter(w => w.length >= 2);
  const hit = termWords.find(w => body.includes(w)) || talkWords.find(w => body.includes(w));
  if (!hit) why.push('太板正：解析里没有术语或说法（用词表里的，比如 ' + termWords.slice(0, 3).join('／') + '）');
  // 空话顶替解析（真实事故：格式全过，解析里只有「反差在于／正是笑点所在／难绷」）
  const hollow = XD_HOLLOW.find(w => body.includes(w));
  if (hollow) why.push('拿空话顶替解析（' + hollow + '）：要说清谁把哪句原话当成了什么');
  // 每层都要有实质：按「此为N层笑点」切段，去掉资料行后逐层看字数
  if (nums.length) {
    const segs = body.split(/此为\d+层笑点/);
    let thin = '';
    for (let i = 1; i <= nums.length; i++) {
      const seg = String(segs[i - 1] || '')
        .replace(/^[\s\S]*?资料[：:][^\n]*\n?/, '')
        .replace(/令人忍俊不禁/g, '')
        .replace(/\s+/g, '');
      if (seg.length < 12 && !thin) thin = String(i);
    }
    if (thin) why.push('第' + thin + '层没有实质内容（只会贴标签）');
  }
  // 解析得落在目标原话上，而不是泛泛而谈
  if (tgt && body && !xdHasTargetFrag(body, tgt)) why.push('解析没引用目标里的原话');
  const bad = xdSloganHit(t);
  if (bad.length) why.push('命中禁项：' + bad.join('、'));
  return { ok: !why.length, scene: xdSceneOf((xd && xd.target) || '', xd || {}), word: hit || '', why: why.join('；') };
}

// 结尾规整：只保证最后一句是「令人忍俊不禁喵」，中间层的「令人忍俊不禁」一个不动
function xdMeowTail(good) {
  const t = String(good || '').trim().replace(/[\s～~！!。.]+$/, '');
  if (/令人忍俊不禁喵$/.test(t)) return t + '～';
  if (/令人忍俊不禁$/.test(t)) return t + '喵～';
  return t + '\n' + XD_SLOGAN + '～';
}

/* 二审（主人 2026-11-24 定）：格式对了还不够，要看它有没有真的说出「谁把哪句原话当成了什么」。
 * 只回两行：判断=合格|不合格；理由=…（不合格必须指到具体哪层）。读不懂/调用失败按合格放行，避免误杀。 */
async function xdReview(target, ans, opts) {
  const llm = (opts && opts.llm) || callLLM;
  const sys = [
    '你是笑点解析的审查员。只看两样：这条解析有没有真的说出「哪句原话的哪个字/词被当成了什么」；以及是不是只复述原话再贴个术语标签。',
    '合格的标准：每个「此为N层笑点」都说清了具体错位（谁把 A 当成 B / 哪个字谐音成什么 / 哪句话和哪句话对不上），引的原话能在目标里找到。',
    '不合格：只有「意思是装傻」「反差在于」「笑点在于」这类空话；补写了目标里没有的表情、动作、心理；两层其实同一个机制；没查到资料却写了具体出处。',
    '只输出两行，不要别的：',
    '判断=合格',
    '理由=（一句话；不合格时必须指出是哪一层、缺了什么）',
  ].join('\n');
  const user = '【目标原文】\n' + String(target || '').slice(0, 800) + '\n\n【待审解析】\n' + String(ans || '').slice(0, 1500);
  let raw = '';
  try {
    raw = String(await llm([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { preferFallback: true, tag: 'xiaodian-audit' }) || '');
  } catch (e) {
    console.log('[笑点解析] 二审调用失败，按合格放行：' + e.message.slice(0, 80));
    return { ok: true, why: '' };
  }
  const m = raw.match(/判断\s*[=＝:：]\s*(合格|不合格)/);
  if (!m) {
    console.log('[笑点解析] 二审输出读不懂，按合格放行：' + raw.replace(/\s+/g, ' ').slice(0, 60));
    return { ok: true, why: '' };
  }
  if (m[1] === '合格') return { ok: true, why: '' };
  const r = raw.match(/理由\s*[=＝:：]\s*([\s\S]*)/);
  return { ok: false, why: (r ? r[1] : raw).replace(/\s+/g, ' ').slice(0, 120) || '没说出具体错位' };
}

/* 笑点解析的「怎么写」契约（主人 2026-11-24 定：格式只是壳，每层要说清谁把哪句原话当成了什么）。
 * 抽成纯函数，自检可以直接钉提示词，不用真跑一遍资料检索。 */
function xdPromptRules() {
  return [
    '## 三、怎么写才算解析出来（先看这节，格式只是壳）',
    '每层必须回答四问，缺一问这层就算没解析：',
    '① 哪句原话：把目标里的那句原文逐字引出来，一字不改。',
    '② 字面是什么意思：这句话按字面该怎么理解。',
    '③ 这段对话里实际指什么：谁把哪个字/词/人名当成了什么，错位在哪（谁把 A 当成 B、哪句话自己打自己的脸）。',
    '④ 机制名：这属于哪种笑（从下面术语表挑一个，一层只用一个机制；同一个机制不许拆成两层）。',
    '只许用目标里出现过的字词：目标里没写的表情、动作、语气、心理、别处的对话，一个字都不许补。',
    '写完自己过一遍：每层都答得出四问吗？答不出的层删掉；一层都答不出，就只写「资料：」行 + 末句「令人忍俊不禁喵」，不许凑层凑格式。',
    '',
    '## 四、输出格式（壳，必须原样）',
    '【聊天记录】',
    '昵称：原话',
    '昵称：原话',
    '【解析】',
    '资料：谐音/衍生/字形/出处（查到几样写几样；查不到写「（没查到明确资料）」，绝不许编）',
    '对话中「昵称」说「原话」意思是……，此为1层笑点。',
    '（只有出现新的笑点机制才开下一层）……，此为2层笑点，令人忍俊不禁。',
    '而蠢蠢的ai，回复「它真说过的那句」。没有理解……，令人忍俊不禁喵。',
    '硬规则：',
    '- 把「昵称」换成发那句话的人在本群的群名片；解析的是自己说过的，就写自己的群名片。出现「代称」「昵称」这两个字本身 = 不合格。',
    '- 目标文本里括号中的说明（「（他引用的消息）」「（是你说的，不是他说的）」）不是原话，不许写进【聊天记录】。',
    '- 资料：这一行必须有；每层必须有「此为N层笑点」且从 1 开始连续；每层结尾接「令人忍俊不禁」；最后一句固定「令人忍俊不禁喵」。',
    '- 这些是解析体的元叙述（术语），不是套话，缺一个都不合格。',
    '- 【聊天记录】只列【目标】里的原话，逐条原样；目标是图/视频就列「昵称：［图/视频：…］」。',
    '- 层 = 新的笑点机制；铺垫和揭晓合起来算一层，别一句一层。',
  ].join('\n');
}

// 第 2+3 步：资料检索 + 生成解析用的 system 提示词（chat 和 demo 共用同一条路径）
async function xiaodianSystem(k, xd) {
  const target = xdCleanAt(xd.target).slice(0, 400);
  const scope = String((xd && xd.scope) || 'single');
  const fmt = a => (a || []).map(x => '- ' + x).join('\n');

  // ---- 找资料：目标优先，没中再试引号里的候选词（都是自有库），联网最多两次 ----
  let libNote = target ? xdLibLookup(target) : '';
  if (!libNote) {
    const cands = [];
    (String(target).match(/[「『“"]([^」』”"]{2,20})[」』”"]/g) || []).forEach(q => {
      const w = q.replace(/[「『“”』"']|[」』”"']/g, '').trim();
      if (w && w.length >= 2 && !cands.includes(w)) cands.push(w);
    });
    for (const c of cands.slice(0, 3)) { libNote = xdLibLookup(c); if (libNote) break; }
  }
  let webRaw = '';
  let libFound = !!libNote;
  if (!libNote && target) {
    const t = target.slice(0, 40);
    const m = await memeLib.lookup(t);
    if (m && m.title) {
      rememberWeb(k, t, m.summary);
      webRaw = String(m.summary || '');
      libNote = '查梗专站（' + m.source + '）查到的资料（可能有错，判断着用，不许照抄背出来）：\n'
        + webRaw.slice(0, 700) + (m.url ? '\n来源：' + m.url : '');
      libFound = true;
    } else {
      const web = await websearch.search(memeLib.memeQuery(t));
      if (web) {
        rememberWeb(k, t, web);
        webRaw = String(web);
        libNote = '上网查到的资料（可能有错，判断着用，不许照抄背出来）：\n' + webRaw.slice(0, 700);
        libFound = true;
      } else {
        libNote = '自有梗库、梗词典、网上都**没查到**——资料段写「（没查到明确资料）」，不许编谐音、出处、平台、时间。上下文和人物资料里的设定照样能用。';
      }
    }
  }
  if (!libNote) libNote = '（这次没查到资料，资料段写「（没查到明确资料）」）';

  const style = xdMemeStyle(target, xd, webRaw);
  const termText = style.terms.length
    ? style.terms.map(t => '- ' + t.name + (t.cat ? '（' + t.cat + (t.state === '待验' ? '·待验' : '') + '）' : '') + (t.use ? '：' + t.use : '')).join('\n')
    : '- 谐音／反差／答非所问：挑最贴的一个';
  const talkText = style.lines.length
    ? style.lines.map(x => '- ' + x).join('\n') + '\n（夹 1-2 个就够，每层都夹就成口头禅了）'
    : '（这次没有可用的梗式说法，别硬夹）';

  const SCOPE_NOTE = {
    quote: '这是他**引用的那条**的全部内容。只解析它，对话里别的话一概不解析。',
    media: '这是他发的图／视频／视频链接的内容（图已翻成文字、视频已带字幕和画面）。只解析它。',
    single: '这是群里最近的一条原话，没有引用也没有图。只解析这一条。',
    thread: '没有引用、没有图／视频／链接、也没有明确目标——**只有这种情况**才允许把整段对话当材料：挑最近、最像笑点的那一段，别从头讲到尾。',
  }[scope] || '只解析【目标】里的内容。';

  const BG = [
    (xd.person && xd.person.length) ? '【此人最近说的】\n' + fmt(xd.person) : '',
    (xd.group && xd.group.length) ? '【整群上文】\n' + fmt(xd.group) : '',
    (xd.after && xd.after.length) ? '【整群下文】\n' + fmt(xd.after) : '',
  ].filter(Boolean).join('\n');
  const peopleFacts = (readCached(MEMORY_PATH) || '').trim();
  const guide = xiaodianGuide();

  return [
    '## 笑点解析任务',
    '有人说「笑点解析」。你要说清：**这次指定的那条内容**到底哪里好笑，按固定格式一层层拆开。',

    '## 一、要解析的目标（只解析这个）',
    SCOPE_NOTE,
    '【目标 · 第 ' + style.sid + ' 档：' + (style.scene || '未命名场景') + '】',
    target || '（目标是空的：从下面背景里挑最近、最像笑点的那一条，并在【聊天记录】里原样列出来）',

    '## 二、背景（只用来理解关系，绝不许解析）',
    BG || '（没有额外背景）',
    '背景里没被选中的话，一句都不许写进【聊天记录】，也不许拿它当笑点。',

    xdPromptRules(),

    '## 五、术语（这一档推荐，取自术语表；最多用 3 个，别堆）',
    termText,

    '## 六、梗式说法（直接夹进句子；用词表里的原说法，别自己造）',
    talkText,

    '## 七、参照（挑最贴的一条照口吻写；只学它怎么指出错位，别抄句式）',
    guide || '（范例文件缺失：按【聊天记录】→【解析】→ 资料行 → 每层「此为N层笑点」→ 末句「令人忍俊不禁喵」写）',

    '## 八、查到的资料（写进资料：这一行，不许单开新段）',
    libNote,
    libFound ? '' : '这次没查到：资料行只写「（没查到明确资料）」这一句，其余一个字都不许编。',

    '## 九、人物资料（谁和谁什么关系、谁是 AI 谁是人类，查到谁用谁）',
    peopleFacts || '（还没有人物资料）',
    '没写的设定不许现编：不给名字编历史典故、编特征、编「以XX著称」。宁少一句，不多一个假设定。',

    '## 十、底线',
    '- AI 那段是条件句：上下文里 AI（你自己/别的机器人群友）真的说过话才写，引的原话必须是它真说过的；**编造 AI 的原话 = 最大的错误**。',
    '- 全程群名片代称，绝不出现 QQ 号；寒暄、刷屏、无关发言一律省略。',
    '- 不许说「这是我的任务」「主人～」「我会好好分析」「希望有帮助」。',
  ].filter(Boolean).join('\n\n');
}

// ===== 笑点解析素材存档（v79，主人 2026-10-23 追问「你有录入原本那个聊天记录吗 / 范例指向的图片吗」）=====
// 教训：以前只存了「范例答案」，没存范例对应的原始聊天记录和图片，也没存每次解析的现场材料——
// 结果我误把范例里的「这是一段QQ聊天记录。」当成固定第一行。以后每次解析都留档（原话 + 图片说明 + 结果）。
const XD_HIST_PATH = path.join(ROOT, 'data', 'xiaodian-history.jsonl');
function recordXiaodianMaterial(xd, extra) {
  try {
    const item = {
      t: new Date().toISOString(),
      target: String((xd && xd.target) || '').slice(0, 600),
      person: (xd && xd.person) || [],
      group: (xd && xd.group) || [],
      after: (xd && xd.after) || [],
      img: String((extra && extra.img) || '').slice(0, 500),
      result: String((extra && extra.result) || '').slice(0, 3000),
    };
    const lines = [];
    if (fs.existsSync(XD_HIST_PATH)) {
      for (const l of fs.readFileSync(XD_HIST_PATH, 'utf8').split('\n')) if (l.trim()) lines.push(l);
    }
    // 触发时先存一条（带原话/图），解析出来后再按同一条补 result，不再新开一条
    if (extra && extra.result && lines.length) {
      let patched = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (String(o.target || '') === item.target && !o.result) {
            o.result = item.result; if (item.img) o.img = item.img;
            lines[i] = JSON.stringify(o); patched = true; break;
          }
        } catch {}
      }
      if (!patched) lines.push(JSON.stringify(item));
    } else {
      lines.push(JSON.stringify(item));
    }
    while (lines.length > 30) lines.shift();      // 只留最近 30 次
    fs.writeFileSync(XD_HIST_PATH, lines.join('\n') + '\n', 'utf8');
  } catch (e) { console.log('[xd] 素材存档失败：' + e.message); }
}

// 第 4 步 质检（chat 和 demo 共用，主人 2026-11-22 改）：模板？聊天记录？解析有实质？没套话？
// 不合格 → 带着具体原因重说一次；两次都不合格 → **只发一句「令人忍俊不禁喵」**（旧的整段兜底模板已废）。
async function xiaodianEnsure(k, msgs, ans, xd) {
  const target = String((xd && xd.target) || '').slice(0, 200);
  const chk0 = xdCheck(ans, xd);
  let why0 = chk0.why;
  // 格式过了还要二审：这次有没有真的说出「谁把哪句原话当成了什么」
  if (chk0.ok) {
    const rv = await xdReview(target, ans);
    if (rv.ok) return xdMeowTail(ans);
    why0 = '二审：' + rv.why;
  }
  if (ans) {
    console.log('[笑点解析] 不合格（' + why0 + '）→ 重说一次：' + String(ans).slice(0, 40));
    const style = xdMemeStyle(xdCleanAt((xd || {}).target), xd || {}, '');
    const again = polish(await callLLM(msgs.concat([
      { role: 'assistant', content: ans },
      { role: 'system', content: '上一版不合格：' + why0 + '。重发解析结果本身，只解析【目标】那条。每层必须回答四问：① 哪句原话（逐字引）② 字面什么意思 ③ 这段对话里实际指什么、谁把什么当成了什么 ④ 机制名（一层一个）。不许写目标里没有的表情/动作/心理；答不出四问的层删掉，一层都答不出就只写资料行 + 末句。形状：\n'
        + '【聊天记录】\n昵称：原话\n【解析】\n资料：（查到就写，没查到写「（没查到明确资料）」）\n……此为1层笑点，令人忍俊不禁\n令人忍俊不禁喵\n'
        + '「昵称」换成真实群名片，不许写「代称」「昵称」这两个字。'
        + '目标原文：' + target + '。'
        + '这档能用的术语：' + (style.terms.map(t => t.name).join('／') || '谐音／反差') + '；能夹的说法：' + (style.lines.map(x => x.slice(0, 20)).join('；') || '（没有就别夹）') + '。' },
    ]), { tag: 'xiaodian-fix' }), k);
    const chk1 = xdCheck(again, xd);
    if (chk1.ok) {
      const rv1 = await xdReview(target, again);
      if (rv1.ok) return xdMeowTail(again);
      console.log('[笑点解析] 二审仍不合格（' + rv1.why + '）→ 只发一句喵');
    } else {
      console.log('[笑点解析] 重说仍不合格（' + chk1.why + '）→ 只发一句喵');
    }
  } else {
    console.log('[笑点解析] 没有答案 → 只发一句喵');
  }
  return XD_SLOGAN;
}

// 完整跑一遍（demo/自测用）：同一条链路——资料检索 → 提示词 → LLM → 质检 → 收尾
async function xiaodianDemo(xd) {
  const sys = await xiaodianSystem('demo', xd);
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: '（有人发了「笑点解析」）' },
  ];
  const ans = polish(await callLLM(msgs, { tag: 'xiaodian-demo' }), null);
  return xiaodianEnsure('demo', msgs, ans, xd);
}

// ===== 转发动态的感想（主人 2026-10-22 v52 定）=====
// 转发的动态每条都要发感想，优先级：玩合适的梗 → 固定句式梗 → 复制粘贴梗 →
// 这个东西本身的梗 → 关联梗 → 按自己人设回答。一句到两句，不解释、不报梗名。
async function qzoneComment(text, isMaster) {
  const t = String(text || '').trim();
  const hit = t ? guides.memeHit(t, 1) : null;                       // 动态里命中梗库 → 把那一节的接法带进去
  const how = hit ? guides.memeHowto(hit.title) : null;
  const sys = [
    soulForNonChat(),   // F 基底 + H 公共应对语气（D 层平台功能也带虚幻风格）
    '\n## 现在的任务（不是聊天）',
    '你刚把下面这条' + (isMaster ? '主人的' : '好友的') + '动态转发到了自己的 QQ 空间，要配一句**转发感想**。',
    '感想怎么写，按这个优先级挑第一个能用的：',
    hit && how ? ('1. **玩合适的梗**：这条动态命中了你的梗库「' + hit.title + '」，按它的接法来——' + how.plain) : '1. **玩合适的梗**：这条动态要是命中你知道的梗，就按那个梗的方式接一句。',
    '2. **固定句式梗**：想到某个好玩的固定句式，照着骨架改一条用在这条动态上。',
    '3. **复制粘贴梗**：动态本身像复制粘贴/发疯文学的话，用同款腔调接。',
    '4. **这个东西本身的梗**：动态内容本身有梗（游戏、动画、日常小事的好笑点），拿它的梗说。',
    '5. **关联梗**：由内容联想到你知道的别的梗，自然带一句。',
    '6. **都不行就按人设回答**：像你自己会说的那样，一句真实的感想。',
    '规矩：',
    '- 一句到两句，最多 40 字。',
    '- **不许报梗名、不许解释梗**（「这是XX的梗」不许说）。',
    '- 不许出现「转发」「动态」「说说」「这条内容」这种旁白词——你是在自己空间里说话，不是在汇报。',
    '- 不许用「哈哈」开头敷衍；结尾不带任何固定尾巴。',
    '- 就是你自己（' + (cfg.botName || '虚幻') + '）在说话，第一人称。',
    guides.memeOverview(20).length ? '\n## 你认识的梗（梗名：意思，供联想用）\n' + guides.memeOverview(20).join('\n') : '',
  ].filter(Boolean).join('\n');
  const user = (isMaster ? '（主人的动态）' : '') + t;
  const ans = await callLLM([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { preferFallback: true, tag: 'qzone-comment' });   // 逛街感想不赶时间，别抢主模型
  return polish(String(ans || '').trim().replace(/^[「『"']|[」』"']$/g, ''), null);
}

// ---- 发自己的 QQ 动态（v68，主人 2026-10-23 定：像人类一样的频率和内容）----
// 素材：长期记忆话题 + 最近聊天 + 主人原创说说（只学选题/口味，绝不抄原文）
// 质检：像真人随手发的；不像就重写一次，还不行今天就不发（不硬凑）
const QZONE_HIST_PATH = path.join(ROOT, 'data', 'qzone-history.json');
const QZONE_MASTER_PATH = path.join(ROOT, 'data', 'qzone-master-moods.jsonl');
function qzoneMyPosts(n) {
  try {
    const h = JSON.parse(fs.readFileSync(QZONE_HIST_PATH, 'utf8')) || {};
    return (h.posts || []).slice(-(n || 5)).map(x => String(x.text || ''));
  } catch { return []; }
}
function qzoneMasterMoods(n) {
  try {
    const lines = fs.readFileSync(QZONE_MASTER_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(n || 5)).map(l => { try { return String(JSON.parse(l).text || ''); } catch { return ''; } }).filter(Boolean);
  } catch { return []; }
}
function qzoneDynLooksReal(t) {
  const s = String(t || '').trim();
  if (s.length < 4 || s.length > 80) return false;
  if (/[主人|欧尼酱|AI|ai|模型|机器人|prompt|人设|转发|说说|系统|程序]/.test(s)) return false;
  if (/^(转发|分享|签到|打卡|公告|通知)/.test(s)) return false;
  if (/[「」]/.test(s) && s.length < 8) return false;
  return true;
}
async function qzoneDynPost() {
  const topics = readKeptTopics().slice(-8).map(x => String(x.topic || x.text || '').slice(0, 30)).filter(Boolean);
  const masterRef = qzoneMasterMoods(5);
  const mine = qzoneMyPosts(5);
  const sys = [
    soulForNonChat(),   // F 基底 + H 公共应对语气
    '\n## 现在的任务（不是聊天）',
    '你要发一条**自己的 QQ 空间说说**（原创动态，不是转发）。像真人随手发的那种：',
    '- 一两句，5~60 字，口语，可以带情绪、可以碎碎念、可以只说一件小事。',
    '- 题材从你真实的生活里来（下面给你的记忆），不要编没发生过的大事。',
    '- **不许抄主人发过的内容**——主人发什么只代表最近的氛围/话题，你写你自己的。',
    '- 不许鸡汤口号（「加油」「努力」这种），不许像公告，不许 @ 任何人。',
    '- 就是你自己（' + (cfg.botName || '虚幻') + '）在说话，第一人称，结尾不带固定尾巴。',
    topics.length ? '\n## 你最近记着的事（从这里挑真实的话头）\n' + topics.map(t => '- ' + t).join('\n') : '',
    masterRef.length ? '\n## 主人最近发过什么（只看氛围，不许抄）\n' + masterRef.map(t => '- ' + t.slice(0, 40)).join('\n') : '',
    mine.length ? '\n## 你最近已经发过的（不许和这些重样、不许再提同一件事）\n' + mine.map(t => '- ' + t.slice(0, 40)).join('\n') : '',
  ].filter(Boolean).join('\n');
  /* 2026-11-17 主人令：发出去的每一条都要能回看「她收到了什么提示词、做了什么思考」。
   * 所以这里不再只返回一句话，而是把**整组 messages** 和这一轮真实用的模型/思考/耗时一起交出去，
   * 由 connector 在真发成功之后写进 data/自主动态.jsonl（selfpost.js）。
   * 思考：模型给了 reasoning_content 就原样带，没给就空着 —— 不编（她的原话「只在模型给了才记」）。 */
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: '就发一条，现在写。' },
  ];
  let last = { model: '', think: '', ms: 0 };
  for (let i = 0; i < 2; i++) {
    const ans = await callLLM(messages, { preferFallback: true, tag: 'qzone-post' });   // 不赶时间，别抢主模型
    const call = _lastLlmCall || {};
    last = { model: String(call.model || ''), think: String(call.reason || ''), ms: Number(call.ms || 0) };
    const t = polish(String(ans || '').trim().replace(/^[「『"']|[」』"']$/g, ''), null).split('\n')[0].trim();
    if (qzoneDynLooksReal(t)) return { text: t, prompt: messages, tries: i + 1, ...last };
  }
  // 两次都不像 → 今天不发，不硬凑（也把这次的提示词交回去，面板能看见「想过但没发」）
  return { text: '', prompt: messages, tries: 2, note: '两次都不像真人随手发的 → 这轮不发', ...last };
}

/* ===== 逛别人的 QQ 空间，留一条评论（2026-11-17 主人令）=====
 * ctx = { name, mood:{text,time,pics,rt_text}, others:[{text,time}] }
 *
 * 硬规矩（她的原话）：
 *   · 依据**不能带任何来自群聊/私聊的内容**，只能用空间里的东西（对方的其他说说；B站留到下一轮）。
 *   · 一个动态只发一条评论 → 宁可不发，也不发一条可能低分的。
 *   · 低分标准不用模型猜，全部取自「标错」里她判过的案例（qzone-comment.LOW_SCORE_CASES）。
 * 红包梗（要钱/暴富/被关心）在 qq.js 里短路直接发模板，不走这里——她给的是定稿，不许改写。 */
async function qzoneFriendComment(ctx) {
  const c = ctx || {};
  const name = String(c.name || '').trim() || '他';
  const mood = c.mood || {};
  const others = Array.isArray(c.others) ? c.others.filter(x => String(x.text || '').trim()) : [];
  const qcmod = require('./qzone-comment');
  const kinds = qcmod.LOW_SCORE_CASES;
  /* 标错仍是低分标准的唯一来源，但**只取她写的理由，不注入原句**（2026-11-17 08:3x）：
   * 那 6 条原句全是聊天场景（带 @数字、提肛、BLG/GEN），塞进「空间评论」里只会让模型
   * 连「@某人 + 一串话题名」的格式一起学。理由（空话套话/答非所问/莫名其妙）才是场景无关的行为。 */
  const notes = [];
  for (const x of qcmod.lowScoreExamples(8)) {
    const n = String(x.note || '').trim().slice(0, 40);
    if (n && notes.indexOf(n) < 0) notes.push(n);
  }
  const sys = [
    soulForNonChat(),   // F 基底 + H 公共应对语气（修「空间评论不像虚幻」的根因）
    '\n## 现在的任务（不是聊天）',
    '你在刷 QQ 空间，停在 ' + name + ' 发的一句话下面。留一条评论：就一句，像路过的人随口留的。',
    '',
    '## 依据只许来自他的空间',
    name + '**自己在空间里发过的东西**才算依据。群聊、私聊里的事一个字都不许提。',
    '不猜他的身份、职业、住哪、和谁关系好。不装熟，不解释自己是谁。',
    '',
    '## 他发的那句（你要接的就是它）',
    '「' + String(mood.text || '').slice(0, 300) + '」',
    '',
    others.length ? '## 他空间里别的（用来知道这人最近在干什么、什么调性）\n' + others.slice(0, 6).map(o => '- 「' + String(o.text).slice(0, 60) + '」').join('\n') : '',
    '',
    '## 怎么写：按这三步想，别跳步',
    '1. 在他那句话里挑一个**具体的东西**：一个天气、一个时间、一个动作、一个地方、一个物件。',
    '   指那个东西要换**你自己的说法**，别原样搬他的词（连带六个字一样就算抄）。',
    '2. 说你自己身上对得上的**那一幕**：那时你在干什么、身上什么感觉、你做了什么小动作。',
    '   不要写成「我也是，+ 一个形容词」——那种句子谁都能写，等于没写。',
    '3. 说完就停。一句话，最多 30 字。',
    '不评价他写得怎么样，不总结他表达了什么，不科普为什么会这样。第一人称，不许带问号，不许照抄他的原话。',
    '',
    '## 这样写出来是废的（空间评论最常见的五种）',
    '1. 把他的事复述一遍再评一句：「降温了确实冷」',
    '2. 只有安慰口号：「注意保暖」「多穿点」「辛苦了」',
    '3. 通用捧场：「真棒」「羡慕」「厉害了」',
    '4. 解释或科普：「降温是冷空气南下」「这就是典型的……」',
    '5. 装熟或自曝：「我们群里也在说」「作为 AI 我觉得」',
    '',
    '## 主人标过的错（照录），空间里犯同类一样算低分',
    kinds.map((x, i) => (i + 1) + '. ' + x.note).join('\n'),
    notes.length ? '\n她给过的理由：' + notes.join('；') : '',
    '',
    '## 说不出来就别写',
    '如果那句话只是梗、是重复、是无意义的转发，或者你只能憋出上面五种里的一种——**只输出 SKIP 四个字母**。',
    '少一条评论不丢人，留一句套话才是丢分。',
    '他在聊「AI/机器人有没有感情」时就接具体那句，别急着证明自己有感情，也别否认。',
    '',
    '只输出评论本身：不要引号，不要解释，不要换行。',
  ].filter(Boolean).join('\n');
  const ans = await callLLM([
    { role: 'system', content: sys },
    { role: 'user', content: '写这一条评论。' },
  ], { preferFallback: true, tag: 'qzone-friend-comment' });   // 逛空间不赶时间，别抢主模型
  const one = polish(String(ans || '').trim().replace(/^[「『"']|[」』"']$/g, '').replace(/\s*\n+\s*/g, ' ').trim(), null);
  // 中文之间被模型塞的多余空格清掉（「也是 缩着脖子」→「也是缩着脖子」），不影响英文/数字
  return String(one || '').replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, '$1$2');
}

// 每个会话「上一次真正发出回复」的时间（判断「刚答过，别再补一句废话」）
const lastAnswerAt = new Map();

// 组装消息：人设 + 认人表 + 攻略资料 + 联网结果 + 最近对话
/* ⑧ 本地模型专用喜好表（2026-11-13）：选表判定只在 tastecopy.fileFor 写一遍。
 * 两份表共用 taste.mine 同一套解析与参数，不建第二套注入逻辑。 */
function tasteFileFor(k) { return require('./tastecopy').fileFor(k); }

/* 这个会话当前由哪类模型在答：本地优先且本地就绪 → 'local'，否则 → 'normal'。
 * 用作「当前状态」的读写隔离依据：本地模型只碰 local 状态、云端只碰 normal，互不串（主人 2026-11-14 定）。 */
function stateKind(k) {
  return localSlotOf(k) === 'local' ? 'local' : 'normal';
}

/* 这一轮「对方真正打出来的字」（2026-11-19 23:15）：
 * 带图的消息，userText 是「（对方发了图，图上：… 不是，哥们 …）同时说：真话」。
 * 只用来判「是不是在教我一件事」：图里的字是图的内容，不是他教的东西。
 * 真事：一张吐槽画师头颈肩的梗图，图上的字被当成「有人教了我一件事」写进 学到的（群X）.md。
 * 注意：**不**用来做触发词匹配——图上的字照样能触发梗/约定（主人 2026-11-19 认可「图片判是对的」）。
 * 只剥图片描述，不删「同时说」后面的真话；没有真话就返回空串。 */
function spokenOnly(text) {
  let s = String(text || '');
  for (let guard = 0; guard < 6; guard++) {
    const start = s.indexOf('（对方发了');
    if (start < 0) break;
    let depth = 0, j = start;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === '（') depth++;
      else if (ch === '）') { depth--; if (!depth) { j++; break; } }
    }
    s = s.slice(0, start) + ' ' + s.slice(j);
  }
  s = s.replace(/同时说：/g, ' ');
  s = s.replace(/［图：[\s\S]*?］/g, ' ');
  s = s.replace(/\[图片\]/g, ' ');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/* ===== 话题所指锚定（主人 2026-11-23 令：走 B，用话题开头的分享文案提取所指）=====
 * 现象：群里 Nana 09:08 发抖音「Gemini4黑五5折$99/年教程」，后面日区/新号/半价/27号全量
 *   都在聊它；09:17 一句「不是26号就截止了吗」被当成独立问题裸搜，搜出国考报名。
 * 根因不是上下文长度（那条在 40 条窗口内、未被 8000 字符闸移出），是搜索词 q 只取当前一句。
 * 做法：从历史窗口回溯最近一条带链接/分享文案的消息，从文案里提取所指（口令尾巴在 URL 之后，
 *   按 URL / 省略号 截断即自动去掉），把它拼到搜索词前、并注入一段「这段讨论的共同所指」。
 * 群聊/私聊都生效（历史按 k 取，无 ctx.gid 门）。没有分享文案的历史 → 返回空、行为完全不变。 */
function extractTopicReferent(raw) {
  const s = String(raw || '');
  if (!/https?:\/\//i.test(s)) return '';
  // 引用回复里的旧文案不算话题开头（那是引用，不是这一串讨论的起点）
  if (/说:\s*↩回复@/.test(s)) return '';
  const body = s.replace(/^[^\n]{0,20}说:\s*/, '');
  let r;
  const share = body.match(/看看[【\[][^\]】]{0,40}[\]】]([^\n]*)/);
  if (share) r = share[1];
  else r = body.replace(/https?:\/\/\S+/gi, ' ');
  // 正文在省略号 / URL 之前；后面的口令尾巴（w@f.oQ…）和 ［视频：…］ 一起去掉
  r = r.split(/https?:\/\//i)[0].split(/\.{3,}|…{1,}/)[0];
  r = r.replace(/［[^\]]*］|\[[^\]]*\]/g, '').replace(/[@#]\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return r.length >= 6 ? r.slice(0, 60) : '';
}
function topicReferent(k) {
  try {
    const h = getHist(k) || [];
    for (let i = h.length - 1; i >= 0; i--) {
      const r = extractTopicReferent(h[i] && h[i].content);
      if (r) return r;
    }
  } catch (e) { /* 取历史失败就退回原行为，不挡回话 */ }
  return '';
}

async function buildMessages(k, userText, extraSystem) {
  const ctx = getTurn(k);
  /* 这轮说话人的**人物身份**（2026-11-05）：非 QQ 平台带平台前缀，见 whoUidOf()。
   * QQ 来源 / 自检探针时 whoUid === ctx.uid，老行为一个字节都不变。
   * 只给「按人物身份查/写」的地方用；纯展示/落盘键（日志、约定 qq 键、记忆 uid）仍用 ctx.uid。 */
  const whoUid = whoUidOf(ctx);
  /* 「他真正打的字」（2026-11-20 主人纠正后的口径）：
   * 只用来判「这条指令是不是**真人**发的」——图里印的字不是人在下令。
   * 但**图的内容要记**（图上说的梗、图里讲的事都算内容），所以录教学用完整 userText；
   * 只有「纯图、真人一个字没打」时才不录（那种是图里的要求，不是人提的）。
   * 触发词匹配照旧用完整 userText：图上的字照样算（主人 2026-11-19「图片判是对的」）。 */
  const saidText = spokenOnly(userText);
  // 性别（2026-11-22 她令）：从「真人打的字」里认，图里印的不算；写进人物表，下一轮注入就带上了
  try { if (ctx && ctx.uid) noteSexFromText(ctx.uid, saidText); } catch {}
  const speakerIsMaster = !!ctx.uid && isMasterId(whoUid);   // 这一轮说话人是不是主人（按记忆里的主人号判）
  // 常驻提示词按场景选择注入（主人 2026-11-19 令「按需调用、减少消耗」）：
  //   沿用 SOUL_SCENES / RESP_SCENES 的命中才注入模式，只决定「这一段这一轮注不注入」，
  //   段内文字一个字不改。无场景（自检/守卫）时路由表整段放行，行为与老版完全一致。
  //   ctx.source 由 setTurn 提供：qq / bili；自检探针不调 buildMessages 之外的路径。
  const _baseSystem = selectSystemPrompt(ctx, k, userText);
  const msgs = [{
    role: 'system',
    content: _baseSystem + (extraSystem ? '\n\n' + extraSystem : '') + starPrompt(6) + style.block(),
  }];

  // 审查词守卫（2026-11-19）：本轮输入命中主人自填的审查词 → 把《审查词说明.md》喂给模型，
  // 让联网模型在真正要答这一句时别对着词做机械反射、别激烈拒绝、别跳出人设——先看语境。
  // 只在命中时加这一段（命中才有开销），词表空 / 没命中一个字都不加。
  {
    const _hits = censorGuard.hit(userText);
    if (_hits.length) {
      const _note = censorGuard.explanation();
      if (_note) msgs.push({
        role: 'system',
        content: '## 本轮用词提醒（对方用了你主人登记的词，先按语境读懂，别过度反应）\n'
          + '下面这些词主人登记为「常被模型误判」的日常用语：' + _hits.join('、') + '。\n'
          + _note,
      });
    }
  }

  // 学习系统热层（2026-11-09）：这个人的好感摘要。读的是已经落好的记录，不现场推理。
  // 放在「一直记着的事」前面：先认人，再讲记着的事。出错不拖垮这一轮。
  try {
    const lb = learn.hot(ctx);
    if (lb) msgs.push({ role: 'system', content: lb });
  } catch (e) { try { console.warn('[learn] 热层跳过：' + (e && e.message)); } catch (_) {} }

  // 学习系统温层（2026-11-09 P1）：这个人自己的知识库，命中才给，最多 3 条。
  // 只在有人说话时检索；没装 Ollama 就走字面命中，不会卡（embed 失败后 60 秒内不再试）。
  if (String(userText || '').trim()) {
    try {
      const wb = await learn.warm(ctx, String(userText).slice(0, 200));
      if (wb) msgs.push({ role: 'system', content: wb });
    } catch (e) { try { console.warn('[learn] 温层跳过：' + (e && e.message)); } catch (_) {} }
  }

  // 虚幻的长期记忆（2026-11-07）：正本里「每轮给模型看的」那一段，带 mtime 缓存、没改就不重读。
  // 档案段和按天日志不进提示词——那些只在客户端给人看，进来只会白烧 token。
  // 发送前整理提示词（她 2026-11-09 定的优先度最高档）：这一层把要发的内容整理好，
  // 就不用等模型说错再拦（第 4 档）或打回重发（第 5 档）。
  // 「主人定的规矩不能改写成自己的话…」这句是第 2 档（提示词本身）：她定「第一档做不到那第二档就不删」，
  // 所以这句留在提示词里；按她「@MEMORY.md 改成代码侧功能，里面内容实现的部分就删」，
  // 改由代码生成，正本里不留内容。正本仍可写别的内容，和这句并成同一块，不新增提示块。
  {
    const builtIn = '- 主人定的规矩不能改写成自己的话去解释；被问到就按规矩做，不背规矩原文。';
    const fromFile = memory.longForPrompt();
    const lm = [builtIn, fromFile].filter(Boolean).join('\n');
    if (lm) msgs.push({ role: 'system', content: '## 一直记着的事\n' + lm });
  }

  // 这个群的群名片（主人 2026-10-23 定）：一个人换个群可能换个名字，按 QQ 号认出来是同一个人。
  // 以前 people-state 只有一个 nick，几个群互相覆盖，她就「不知道每个人在这个群叫什么」。
  if (ctx.gid) {
    try {
      // 2026-11-21 主人令：直接从人物主存算（people.json 是唯一正本），不再读 people-state.json 镜像
      const ps = people.stateView() || {};
      const lines = [];
      for (const [qq, rec] of Object.entries(ps)) {
        const c = rec && rec.cards && rec.cards[String(ctx.gid)];
        if (!c) continue;
        // 名字只读人物表（2026-11-21 主人令）；cfg.people 已废弃，读它等于读一份空表
        const nm = String(personNameOf(qq, rec.nick || '') || '');
        /* 身份（2026-11-22 她令）：群名片只说明「这个群叫他什么」，
         * 她还要知道这个人是谁（主人 / 欧尼酱 / 朋友 / 认识的人 / 陌生人）。 */
        const rl = (() => { try { return people.roleLabel(people.roleOfKey(qq)); } catch { return ''; } })();
        const tail = [];
        if (nm && nm !== c) tail.push('= ' + nm);
        /* 代称拿来认人（2026-11-22 她令）：别人在群里喊「大萌新」「哦鲸鲸」时，
         * 她要能对上这是谁。这里把当前群名片以外的名字列出来（主人的叫法、别的群名片、资料卡…）。 */
        try {
          const pid0 = people.pidOfIdAll(qq);
          /* 2026-11-22 晚（她令）：这里列的全是**只能认人**的名字——别群名片、同平台别的号、
           * 曾用名、别人喊的代称，一个都不许拿来喊。 */
          const al = pid0 ? people.nameEntriesOf(pid0, { gid: ctx.gid, platform: 'qq', aid: qq })
            .filter(e => e.name && e.name !== c && !e.callable)
            .map(e => e.name).slice(0, 4) : [];
          if (al.length) tail.push('只用来认人（不许喊）：' + al.join('、'));
        } catch { /* 取不到就少这一段 */ }
        if (rl) tail.push('身份：' + rl);
        // 主人自己的号也在这里面：她在每个群的名字都要认得出来（主人 2026-10-23 定）
        const isMasterRow = isMasterId(qq);
        lines.push('- ' + c
          + (tail.length ? '（' + tail.join(' · ') + '）' : '')
          + (isMasterRow ? '　← 这是主人（她的号之一），在这个群里大家这么叫她' : ''));
      }
      if (lines.length) {
        msgs.push({
          role: 'system',
          content: '## 这个群的群名片（' + lines.length + ' 人）\n' + lines.slice(0, 40).join('\n')
            + '\n\n群名片是**他在这个群里的名字**，同一个 QQ 换个群可能换个名字：按 QQ 号认出来是同一个人，'
            + '不要因为名字不一样就把人当成两个。喊他只许用这里的群名片（或真名、主人的叫法、其他平台的昵称）；'
            + '标着「只用来认人」的那些名字，只在听懂别人喊他时用，绝不许拿来喊他。'
            + '\n身份：主人＝她本人；欧尼酱＝她主人的哥哥；朋友＝在面板「朋友录」里的人；'
            + '认识的人＝面板「人物册」里的人；陌生人＝第一次来的，别装熟、别叫宝宝、别猜他的身份职业。',
        });
      }
    } catch {}
  }

  // 「现在跟你说话的是谁」（2026-11-19 主人令：号跟地区一样，只有本人能聊自己的）：
  // 提示词原先从没明确说过「眼前这个人的号是多少」，她就分不清「我的号」和「别人的号」。
  // 实测（走真实入口 pushHist→chat）：Ayami 本人问「我QQ号是多少」→ 她答「我记不准，你点头像看资料卡」；
  // 主人在群里问「ayami的QQ号是多少」→ 她直接把别人的号念了出来。两个方向都得靠这段掰正。
  if (ctx && ctx.uid) {
    try {
      const key = people.keyOf(whoUid || ctx.uid);
      const sp = people.splitUid(key) || { platform: 'qq', id: String(whoUid || ctx.uid) };
      const pid = people.pidOfKey(key);
      const nm = String(people.nameOfPerson(pid) || '').trim();
      const nick = String(ctx.nick || '').trim();
      const rows = [];
      /* 名字（2026-11-22 她令）：真名 → 主人叫法 → 当前可见名（群名片/资料卡/B站昵称）……
       * 没建档的人（B站 观众、第一次来的群友）也要给一行——只有平台昵称，来源标清楚。 */
      if (pid) {
        try {
          const entries = people.nameEntriesOf(pid, {
            gid: ctx.gid, platform: sp.platform, aid: sp.id, currentNick: nick,
          });
          /* 2026-11-22 晚（她令）：能喊的只有「本群名片 + 其他平台昵称 + 真名 + 主人的叫法」；
           * 别群名片、同平台别的号、曾用名、别人喊的代称单列一行，写明只认不喊。 */
          const callable = entries.filter(e => e.callable);
          const onlyRec = entries.filter(e => !e.callable);
          const fmt = arr => arr.map(e => e.name + (e.src ? '（' + e.src + '）' : '')).join(' · ');
          if (callable.length) rows.push('- 喊他用的名字（按顺序）：' + fmt(callable));
          if (onlyRec.length) rows.push('- 只用来认人、不许喊：' + fmt(onlyRec));
        } catch { /* 取不到就少这一行 */ }
      } else if (nick) {
        rows.push('- 喊他用的名字（按顺序）：' + nick
          + '（' + (sp.platform === 'qq' ? 'QQ昵称' : people.platLabel(sp.platform) + '昵称') + '）');
      }
      /* 身份（2026-11-22 她令）：先说她是谁（主人 / 欧尼酱 / 朋友 / 认识的人 / 陌生人），
       * 再给名字和资料卡——她原话「应该同时能看到资料卡，和我身份是主人、名字叫虚幻」。 */
      try {
        const role = people.roleOfKey(key);
        const rl = people.roleLabel(role);
        if (rl) {
          rows.push('- 身份：' + rl
            + (role === 'master' ? '（这是她本人，她的号之一）' : '')
            + (role === 'onii' ? '（她主人的哥哥）' : '')
            + (role === 'stranger' ? '（第一次来的人：别装熟，别叫宝宝，别猜他的身份职业）' : ''));
        }
      } catch { /* 身份取不到就少这一行 */ }
      /* 性别（2026-11-22 她令）：AI 全是女、主人是女、其他人默认男（猜的）。
       * 她第二次纠正：说的一直是缺「身份」「性别」——**没建档的人也必须有性别行**，
       * 所以这里不再要求 pid 存在，没有档案就按默认猜男给一行。 */
      try {
        const sx = pid ? people.sexOf(pid) : 'male';
        const src = pid ? people.sexSrcOf(pid) : 'guess';
        const sl = people.sexLabel(sx);
        if (sl) {
          rows.push('- 性别：' + sl
            + (src === 'guess' ? '（按默认猜的，不是他本人说的；听到本人说是女就改）' : ''));
        }
      } catch { /* 取不到就少这一行 */ }
      /* 同名提醒（2026-11-22 她定文案）：主人的名字就叫「虚幻」，和机器人自己同名。
       * 她原话：「就写成设定上是我的分身，但我们是两个独立的人就行。」 */
      if (nm && nm === String(cfg.botName || '虚幻')) {
        rows.push('- 注意：他的名字也叫「' + nm + '」，设定上是你的分身，但你们是两个独立的人——'
          + '他不是你，你也不是他。他说「我」＝他，你说「我」＝你自己。');
      }
      // 你自己的号（主人 2026-11-19：她问「我号多少」时回了自己的号还加一句「是我自己哦」，
      // 把对方的号说成自己的——提示词里从没写过「你的号是哪个」，只写了「他的号」）。
      // 写明自己的号，并把「我」的归属摆清楚：他说「我」＝他，你说「我」＝你自己。
      const selfQq = String(cfg.selfQQ || '').trim();
      if (selfQq) {
        rows.push('- 你（' + (cfg.botName || '虚幻') + '）自己的 QQ 号是 ' + selfQq + '。下面这个号是**对方**的，不是你的号。');
      }
      rows.push('- ' + people.platLabel(sp.platform) + ' 号：' + sp.id);
      rows.push('- 这是他**自己**的号。他问「我号多少」「我住哪」「我这边天气怎么样」，就照实答、直接给——那是他自己的信息，不是泄露。');
      rows.push('- 对方说「我」指的是他自己。答的时候说「你的是 ' + sp.id + '」，别说成「我自己的号」、也别把名字安到自己头上。');
      rows.push('- 但换成别人来问他（不是他本人开口），一律不说。');
      msgs.push({ role: 'system', content: '## 现在跟你说话的是谁\n' + rows.join('\n') });
    } catch { /* 查不到就少这一段，不影响别的 */ }
  }

  // 眼前这个人的头像（2026-11-07 主人要「聊天时也能看到对方头像、换头像能反应」）：
  // 图只在首次/换图时让视觉模型看一次，描述缓存进 qq-meta；这里只读缓存，不每轮调模型。
  // 只给事实，不加规则句；没描述就不给这一段，不编。
  // 2026-11-07 追加：按平台取（B站 观众的头像不能拿 QQ 号去查），ctx.source 就是平台。
  if (ctx.uid) {
    try {
      const plat = qmeta.normPlat(ctx.source === 'bili' ? 'bili' : 'qq');
      const who = personNameOf(ctx.uid, ctx.nick || '') || '眼前这个人';
      const av = [qmeta.avatarLine(ctx.uid, who, plat), qmeta.changedLine(ctx.uid, who, plat)].filter(Boolean);
      if (av.length) msgs.push({ role: 'system', content: '## 眼前这个人的头像\n' + av.join('\n') });
    } catch {}
  }

  // 你和眼前这个人第一次见面是哪天（2026-11-06 主人要求「和别人第一次相遇的日子也要记」）：
  // 只有这个人有相遇记录时才给（一行）；老的 68 人是 11-03 批量建档，那天不是真实相遇日，不补假日期。
  if (ctx.uid) {
    const pl = dates.personLine(whoUid);
    if (pl) msgs.push({ role: 'system', content: '## 你和眼前这个人的日子\n' + pl });
  }


  // 「你和主人是同一个人」只有 B 站评论区有（B站插件 reply.py 的 same_person 判定注入）。
  // QQ 侧没有这套，不注入任何同身份提示。

  // 应对按场景注入（主人 2026-11-03 定；2026-11-07 扩到情绪场合）
  // 公共常驻 systemPrompt；我/别人的通用规则按说话人给；场合专属段只在命中时给。
  const _emoOfTurn = emotionOf(userText);
  {
    const rb = readResponseBlocks();
    const who = speakerIsMaster ? '我' : '别人';
    const blk = speakerIsMaster ? rb.me : rb.other;
    const extra = RESP_SCENES
      .filter(d => d.re.test(String(userText || '')) && rb.scenes[d.id] && rb.scenes[d.id][who])
      .map(d => rb.scenes[d.id][who]);
    if (blk || extra.length) msgs.push({
      role: 'system',
      content: '## 应对·本场（这一轮按这个来）\n' + [blk].concat(extra).filter(Boolean).join('\n\n')
        + (speakerIsMaster
          ? '\n这一轮跟你说话的是**主人本人**，上面「我」的规则生效。'
          : '\n这一轮跟你说话的不是主人，上面「别人」的规则生效。'),
    });
  }

  // 按使用场景注入人设小节（2026-11-05）：问游戏攻略、让人搜东西时才需要这两节。
  // 平时不灌（省 token）。认节有四级兜底（标记→标题→关键词→正文特征），
  // 四级都认不出就报错 + 私信主人，不再静默退回常驻（2026-11-06 主人定）。
  {
    const sc = readSceneBlocks();
    const hit = SOUL_SCENES.filter(d => sc[d.id] && d.re.test(String(userText || '')));
    if (hit.length) msgs.push({
      role: 'system',
      content: '## 这一轮用得上的规矩（场合对上了才给）\n' + hit.map(d => sc[d.id]).join('\n\n'),
    });
  }

  /* 反省回灌（2026-11-07 主人定）：同情绪场合还有没修好的问题时，只给一句动作。
   * 不给错话原文——原文进提示词会被 flash 当现成答案再念一遍（名词解释 §113）。
   * 「已修好」删掉那条后缓存失效，下一轮自然不再出现。 */
  {
    const lesson = readIssueFor(_emoOfTurn);
    if (lesson) msgs.push({ role: 'system', content: '## 这种场合上次说错过\n' + lesson });
  }

  // 这个人跟你定过的说话方式（2026-10-23 主人要求「针对单个人持续触发的内容写进约定」）：
  // 只在他跟你说话时注入，不污染别人；别人要的格式不会套到全群头上。
  {
    // 只在「真的有人跟她说话」时才注入他定过的**说话方式**（主人 2026-10-23 全通用）：
    // 群里没人 @ 她、也没引用她 → 那是群友之间在聊天，他并没有跟她说话，谈不上「他定的」。
    // 2026-11-06 补齐另一半（她问「和白的约定 够童！呢」）：
    //   她自己凑上去接某人话时（chime/topic），ctx.uid 就是那个人——这一轮她确实在接他的话。
    //   那种场合仍然不带「句尾记号」类（否则一接火丁的话就带 Ciallo），
    //   但「碰到 X 就做 Y」这类规矩类要带上，否则白发「何意味？」她永远只会解释「什么意思」。
    const addressed = addressedToMe(ctx);
    // text 传进去：场景类约定（碰到 X 就回 Y）只在撞上条件时注入，别的时候一个字不提
    // whoUid：非 QQ 平台带前缀（'bili:434882781'），pactLines 再按人物归拢到他的 QQ 那头 ——
    // 2026-11-06 她要求「约定全平台生效」：白在 QQ 定的事，他在 B站 说话照样算。
    const pactTxt = addressed
      ? pactLines(whoUid, { text: userText })
      : pactLines(whoUid, { onlyRules: true, text: userText });
    if (pactTxt) {
      msgs.push({
        role: 'system',
        content: '## 约定（按分区给：约定·说话方式 / 约定·情绪认知与应对 / …）\n' + pactTxt
          + '\n这些是约定好的做法。**「看到 / 碰到 X」说的是什么样的内容或场合**（真的鬼畜视频、真的 AI 音乐、'
          + '真的童站评论那种），不是要你去消息里找这几个字；按内容本身判断，对上了才照做。'
          + '\n标着「（全群通用）」的，是群里谁说到都算的，不只对一个人；标着「（只对X）」的只对那个人，别套到别人身上。'
          + '\n**顺序就是优先级，从上往下越来越低**：同一件事留了好几条（比如句尾先要加喵、后来改成加汪），'
          + '只照最上面那条做；下面的旧说法留着备用，等对方明说「换回」才轮到它，不要几条一起照做。'
          + '\n这一节是**兜底**：和上面「你的人设」冲突时，以人设为准。'
          + (addressed ? '' : '\n（他没在叫你，是你自己接了他的话头）条件对上了才用，没对上就当没这条。'),
      });
    }
    // 兜底提醒始终保留（主人 2026-10-23 报的真事）：跟企鹅火丁约了句尾加「Ciallo～(∠・ω< )⌒☆」，
    // 她后来回主人、回别的群友也照抄——因为这段提示词只在「他本人说话」时才出现，别人说话时她完全不知道自己带了别人的约定。
    // 现在不再放在 else 里：上面即使注入了这个人的规矩类约定，别人的记号提醒也照样要给。
    const os = otherPactHints(whoUid);
    if (os.length) {
      msgs.push({
        role: 'system',
        content: '## 别人定的说话方式（不许套用到眼前这个人身上）\n'
          + os.map(o => '- 只有回「' + o.nick + '」时才带「' + o.sig + '」').join('\n')
          + '\n这些只对那个人本人有效。眼前这个人没跟你约过。\n不许带一句话（发送层还会再剥一遍）。',
      });
    }
  }

  /* 在场的人教过的事（2026-11-12 主人定）：教学知识带 id 署名，只在教的人在场时用。
   * 2026-11-13 改成统一检索：攻略 / 学到的 / 教学条都由 kb.retrieve 一处出，
   * 门槛 ≥4 字、只给命中的几条，不再在这里单独按「在场」全喂一遍（见下面 _learnScope 之后那段）。 */

  /* 只有被问「谁教你的 / 从哪学的」才涉及署名（主人 2026-11-12）。
   * 使用知识时一个 id 都不给：teach.linesFor / pactLines / keptTopicLines 本来就不带号，
   * 这里再补一条规则，防止模型从别处把号翻出来。命中才注入，平时零开销。 */
  if (review.isSourceQuestion(userText)) {
    msgs.push({
      role: 'system',
      content: '## 这一轮被问到「这知识哪来的」\n'
        + '- 不许报任何 QQ 号、id、平台号，也不许把昵称和号绑在一起说。\n'
        + '- 本轮先不要认领是谁教的：系统已经单独去问作者能不能公开署名了。\n'
        + '- 作者明确说过不行 → 永远不许说、也不许暗示；其余情况（含没回话）视为同意，之后被问才可以说名字。\n'
        + '- 别编一个来源，也别说「我自己想的」。',
    });
  }

  // 关于这个人的事实（2026-11-03 加）：自动总结记下来的「他喜欢什么、他在玩什么」，
  // 带着这个人的号落盘 → 跟谁说话就注入谁的那些，不跟别人混。
  // 说话方式类在上面那段注入（那是「要照做的规矩」，这里只是「知道的事」，两回事）。
  {
    const factTxt = addressedToMe(ctx) ? personFacts(whoUid) : '';
    if (factTxt) {
      msgs.push({
        role: 'system',
        content: '## 关于这个人你知道的事（顺着聊用，别当成他定的规矩）\n' + factTxt,
      });
    }
  }

  // 眼前这个人的所在地（2026-11-19 主人令）：地区表按人物记，面板上有多细显示多细，
  // 只有喂给 AI 这一刻才降级到市/区级 —— briefForAI 砍掉街道门牌和图上那一大段 OCR 原文。
  // 只给「所在地 + 用途」：用来认识对方在哪、查天气、聊他那边的大型活动。
  {
    if (addressedToMe(ctx)) {
      const brief = region.briefForAI(region.getRegion(whoUid));
      if (brief) {
        msgs.push({
          role: 'system',
          content: '## 眼前这个人所在地（用来认识对方所在地、查询天气、了解当地大型活动）\n' + brief,
        });
      }
    }
  }

  // 对方在问 QQ 号（主人 2026-10-23 修）：这一轮必须把号说出来。
  // 以前没有这一段，加上发送层把号替换成「主人」，群友问「qq号是什么」她答「主人的QQ号就是主人和主人」。
  if (ctx.asksQQ) {
    const bn2 = cfg.botName || '虚幻';
    const selfQQ = String(cfg.selfQQ || '');
    const mName = String(cfg.masterName || '主人').trim() || '主人';
    const mQs = [String(cfg.masterQQ || ''), ...((cfg.masters || []).map(String))].filter(Boolean);
    msgs.push({
      role: 'system',
      content: '## 对方这句在问 QQ 号（照实答）\n'
        + '- 他要的是**号码**：直接在回复里把号写出来，一句话说完就行。\n'
        + (selfQQ ? '- 你自己的（也是' + bn2 + '的）QQ 号：' + selfQQ + '\n' : '')
        + (mQs.length ? '- ' + mName + '的号（' + bn2 + '和她同一个人）：' + mQs.join('、') + '\n' : '')
        + '- 不许用「主人」「我」「她」这些词代替号码，那等于没回答。\n'
        + '- 不许反问「你问这个干嘛」。',
    });
  }

  // 这一轮在聊「加群 / 群号 / 拉我进群」时才注入（2026-11-05 从常驻段挪出来，省每轮的 token）。
  // 真实事故 2026-10-23：主人私聊说「去加群1126843213」，她回「已成功加入群1126843213」，实测没进群。
  // 硬拦在 qq.js 的 noFakeJoin（发送层还会再闸一遍），这里只管让话术对。
  if (/加群|进群|入群|群号|拉我|邀请我|群邀请|建群|开群/.test(String(userText || ''))) {
    msgs.push({
      role: 'system',
      content: '## 这一轮在说「加群」（照这个答）\n'
        + '- 加群只有一条路：有人邀请你 / 把你拉进去，你自动同意。你自己没法按群号搜群加群。\n'
        + '- 主人发来群号让你去加，正确回答：「加群这事我自己做不了呀，你邀请我一下，或者直接把我拉进去，我马上就同意～」\n'
        + '- 不许说「已成功加入群」「已经进群了」「加好了」「我这就去加」——那一刻什么都没发生。',
    });
  }

  // 称呼按人现算（主人 / 欧尼酱 / 昵称+酱 / 昵称+宝宝），写进 prompt 防止叫错
  // 「凑个热闹」不是在回某个人，硬加称呼会变成「XX你说的对」——跳过
  if (ctx.uid && !ctx.chime && addressedToMe(ctx) && !ctx.talkTo) {
    const n = nick.nameFor(whoUid, ctx, userText || '');
    if (n) msgs.push({
      role: 'system',
      content: `这一句里用「${n}」称呼对方。\n不许换成别的昵称。\n不许自己编一个。`,
    });
  }

  // 本轮事实（主人 2026-10-23 定）：这几件事是硬事实，不许脑补、不许改写。
  // 真事：主人对群友说了句「为啥」，她答「你突然@我，还问我为啥」——主人根本没@她，
  // 上下文里是别人@了主人，她把那句当成了「主人@我」。
  // 2026-11-09 定位 00:06:31「我刚才说了什么？我怎么记得没说过这句话呀」：
  // 推理日志里两次同类错话，模型都在答提示词中「谁说过什么话」的否定句。
  // 那两行「有没有…／**没有**」式的问答否定句最容易被 flash 当成聊天内容回。
  // 整理发送前提示词（第 1 档）：事实照留，改成一句肯定陈述，不写「有没有…没有」。
  if (ctx.gid) {
    const lines = [];
    lines.push('- 这一轮：' + (ctx.atMeReal || ctx.replyMe ? '有人直接对你说话。' : '没人在跟你说话，你是自己搭话。'));
    if (ctx.talkTo) {
      lines.push('- 对方这句话是在对「' + ctx.talkTo + '」说的，**不是对你说的**'
        + '（你只是被拉进这段对话；这句引用谁由你回答谁决定，见下面「这一句要引用谁」）');
    }
    msgs.push({
      role: 'system',
      content: '## 本轮事实\n' + lines.join('\n'),
    });
  }

  // 这一轮到底什么场合（主人 2026-10-23 定，全通用）：
  // 群里没人 @ 她、也没引用她 → 群友之间在聊天，没人在跟她说话；她要开口就是自己搭话。
  if (ctx.gid && !addressedToMe(ctx)) {
    msgs.push({
      role: 'system',
      content: '## 这一轮：没人跟你说话（群友之间在聊天）\n'
        + '**这一轮没有人对你说话**。\n'
        + '你要开口就是**自己搭话**：别把谁的话当成对你的吩咐、别当成在回答你、'
        + '别顺势记下任何约定，也别冲着谁喊「主人/宝宝」这种只对本人用的称呼。\n'
        + '（如果你确实想接这个话题，就当成自己插了一句话。）',
    });
  }

  // 我自己的口味＝主人的口味（主人 2026-10-22：「虚幻不只是机器人，喜好和我一致」）
  // 这是她自己的喜恶，但对虚幻来说是**她自己的**：说出口是「我喜欢」，不是「她喜欢（所以我跟着）」。
  // 主人 2026-10-22 补充：喜恶表里没有的就是中立；待确认的等选了才算数；猜的算有点偏好但没坐定。
  // 多个 @（主人 2026-10-22 定）：除机器人外，每个 @ 都算喊了一次名字
  if (ctx.atMe && Array.isArray(ctx.othersAt) && ctx.othersAt.length) {
    msgs.push({
      role: 'system',
      content: '这条消息里除了你还 @ 了：' + ctx.othersAt.join('、') + '。\n'
        + '**除机器人外，每个 @ 都是在喊那个人**——被 @ 到 = 被喊到名字，和当面叫名字一个意思：要认得出他是谁（名字在括号前），说到他就叫名字。\n'
        + '按 @ 的顺序和句子语序判断「你 / 他 / 谁」指谁\n'
        + '（真事 2026-10-22：「@虚幻 @大肥鱼 偷你的表情，怎么办」——第一个 @ 是你，紧跟的「你」说的是**你**，偷表情的是另一个 @ 的人，被偷的是你）。\n'
        + '如果主人指名让你对那个人做什么（去骂他、去喊他、告诉他、@ 他），那个人就是被喊到名字的：用名字说他；要对着他说话，就在回复里写他的「@数字」（括号里的那个号），发出去是真正的 @。',
    });
  }
  // 引用归属（主人 2026-10-22 晚纠正：不要弄错人）——她回复的那条是谁说的，明说
  if (ctx.quoteCtx) {
    msgs.push({
      role: 'system',
      content: '## 他引用的那条消息（先认清是谁说的再回）\n' + ctx.quoteCtx,
    });
  }
  /* 引用谁（主人 2026-11-22 定）：群里这条带了引用/对准了别人时，她这一句是在回发话人还是回被引用的人，
   * 决定群里显示引用的是谁。代码侧兜底判定在 qq.js pickQuoteTarget；这里只告诉她「可以指定」，
   * 标记发出去之前会被剥掉，不会出现在群里。 */
  if (ctx.gid && (ctx.replyNick || ctx.talkTo)) {
    const _spk = ctx.nick || '对方';
    msgs.push({
      role: 'system',
      content: '## 这一句要引用谁\n'
        + '这条是「' + _spk + '」发的'
        + (ctx.replyNick ? ('；' + _spk + '引用的是「' + ctx.replyNick + '」的话（内容见上面那条）') : '')
        + (ctx.talkTo ? ('；' + _spk + '这话是对「' + ctx.talkTo + '」说的') : '') + '。\n'
        + '你这句到底是在回谁，决定群里引用显示的是谁：\n'
        + '- 回答**被引用的那个人**（那句被引用的话）→ 回复最前面写 [引用:原]\n'
        + '- 回答**发这条的人** → 写 [引用:当前]（不写也默认按发这条的人）\n'
        + '- 谁都不是（你自己搭话 / 谁都没在问你）→ 写 [引用:无]\n'
        + '标记只是给系统看的，发出去之前会被剥掉——别念出来，也别解释它。\n'
        + '拿不准就按「谁在跟你说话」判断：发这条的人在跟你说话，就回他。',
    });
  }
  // 她问「你喜欢什么」时才展开「可能 / 中立」（量大，平时只给特别 + 确定，省 token）
  const askTaste = /喜欢|讨厌|最爱|口味|爱吃|爱玩|受不了|中意/.test(String(userText || ''));
  const mineTaste = taste.mine(cfg.masterQQ, { ask: askTaste, file: tasteFileFor(k) });
  // 固定标签（2026-11-21）：主人名下的标签也是「我自己的」，和口味并进同一块，别当成猜的。
  const myFixed = fixedTags.lineFor(String(cfg.masterQQ || ''));
  if (mineTaste || myFixed) {
    // 话题翻篇（主人 2026-10-22 定）：0.5~5 天内说过的口味话题，翻篇期到之前不再主动提
    const flip = activeSaidTopics();
    msgs.push({
      role: 'system',
      content: '## 我自己的口味\n'
        + '下面这些就是你自己的喜好。别当成替她记的东西。\n你的口味和主人一模一样：她爱的你就爱，她嫌的你就嫌。\n'
        + [mineTaste, myFixed].filter(Boolean).join('\n') + '\n\n'
        + '说的时候当成自己的：直接说「我喜欢…」「我不吃这套」。\n不许说「主人喜欢所以我也喜欢」这种转述。\n'
        + '什么时候说（主人 2026-10-22 定）：\n'
        + '- 「我喜欢 / 我讨厌」是她亲口认下的（确定）：可以直接主动提，不加解释。\n'
        + '- 「我大概喜欢 / 我大概不喜欢」和「还没表态的」都是没坐定的。\n- 不许自己找机会主动说。\n- 如果别人先聊到那个东西，就顺带表一次态。\n- 同一个话题说过就翻篇。短期内（0.5~5 天）不许反复说（翻篇期见下面）。\n'
        + '「还没表态的」等她选完再算数。没说之前保持中立。中立就平平地说一句。\n'
        + '不许说「各有各的好」「见仁见智」「看个人喜好吧」这种和稀堤的话。\n'
        + '这里没记过的新东西也是中立。别硬装有好恶。'
        + (flip.length
          ? '\n\n## 翻篇期（说过就翻篇，不反复说）\n'
            + '下面这些你最近（0.5~5 天内）已经说过一次了，**翻篇期结束前不许再主动提**——别人先聊到才顺带接一句：\n'
            + flip.map(x => '- ' + x.topic).join('\n')
          : ''),
    });
  }

  // 她喜欢什么、讨厌什么（「确定」是亲口说的，「可能」是猜的，不许混着说）
  // 对着主人本人在说话时不用再讲一遍——上面「我自己的口味」就是她的口味
  if (ctx.uid && !isMasterId(whoUid)) {
    const tb = taste.block(whoUid);
    if (tb) {
      const nm = personNameOf(ctx.uid, ctx.nick || '') || '他';
      msgs.push({
        role: 'system',
        content: `## 你记得「${nm}」的口味\n${tb}\n\n`
          + '喜欢的顺着来，讨厌的别做。'
          + '标「可能是」的还没确认。不许当成事实讲出来。想用就试探一句。'
          + '这是他的口味。别和「我自己的口味」混起来。你自己的好恶按上面那条来。',
      });
    }
  }

  // 他跟别人的关系（2026-11-13）：只给喜 / 厌，无感不给。主人自己的表跟虚幻无关，不注入。
  if (ctx.uid && !isMasterId(whoUid)) {
    const rb = relation.blockFor(whoUid);
    if (rb) {
      msgs.push({
        role: 'system',
        content: '## 你记得「他」跟别人的关系\n' + rb + '\n\n'
          + '这是他的态度，不是你的。他讨厌的人别替对方说好话，他喜欢的人别去踩。'
          + '没记过的就是无感，不用表示什么。',
      });
    }
  }

  // 别复读：把最近自己说过的话摆出来，明确要求换说法。取最近 3 条（主人 2026-11-21：1 条不够）。
  // 排除 [定时保健提醒]：那是系统定时提醒，不是「回过」的话（主人 2026-11-21）。
  // 不排除的话会输出「你刚才已经这样回过：『[定时保健提醒] 提臀～』」，和「这是系统提醒」自相矛盾。
  const lastSaid = getHist(k).filter(m => isSpeech(m) && !isHealthNote(m)).slice(-3)
    .map(m => '「' + String(m.content).slice(0, 60) + '」').join('、');
  if (lastSaid) {
    msgs.push({
      role: 'system',
      content: `你最近这样回过：${lastSaid}。\n`
        + '这次这些说法都不许再用。删几个字、换几个词再发一遍，仍然算复读，不算换说法。\n'
        + '要换角度、换内容，或者只说一句很短的别的反应。不许解释自己在换说法。',
    });
  }

  // 即时记忆（主人 2026-11-21 改）：由本地搜索库按「这句提到的东西」搜整个 chat-log 得到。
  // 找不到算没有，但**不许斩钉截铁说没有**——搜不到不等于没发生过，可能在更久的记录里。
  // 产出方 src/localsearch.js instantContext（qq.js handleTurn 调用）→ 落进 ctx.instant。
  if (ctx.instant) {
    msgs.push({
      role: 'system',
      content: ctx.instant
        + '\n\n对方提到某件东西/某句话时，上面是从整个聊天记录里搜出来的相关原话，先照它答。\n'
        + '- 上面有 → 按原话答（谁说的、说了什么）。\n'
        + '- 上面没有 → 说「我翻了翻记录没看到」「好像没人说过」这种留余地的说法。\n'
        + '- 不许斩钉截铁说「没有/没人说过」，也别把话说死。',
    });
  }

  // ===== 记忆分层（2026-10-22 主人定）：短期记忆 / 话题命中 / 旧事重提 / 即时记忆 call back =====
  {
    const hints = [];
    // 待回复人名单：发话人 + 被引用人 + 话题参与人（主人 2026-11-21 定，不止发话人一个）
    const replyPeople = pendingReplyPeople(ctx, userText, whoUid);
    if (replyPeople.length) {
      const st = shortTermBlock(replyPeople);
      if (st) hints.push(st);
    }
    const th = topicHint(userText);
    if (th) hints.push('## 话题日志里对上号的（这事之前聊过，接上别装陌生）\n' + th);
    const rh = recallHint(userText);
    if (rh) hints.push(rh);
    const cb = callBackHint(k);
    if (cb) hints.push(cb);
    if (hints.length) msgs.push({ role: 'system', content: hints.join('\n\n') });
  }

  // 接着话题说（主人 2026-10-22：没人 @ 她，但话题是连着的——「必须选一个」这种也要接）
  if (ctx.topic) {
    topicTurns.add(k);
    msgs.push({
      role: 'system',
      content: '## 你在接着话题说\n'
        + '群里正在聊一件事，没人叫你，也没人问你。\n你刚参与过这段对话，话题还没断。\n'
        + '把上面整段对话读一遍，接住**现在这个话题**说一句——可以表态、可以吐槽、可以补一句，\n'
        + '就像群里一个熟人顺手接过话头。\n'
        + '- **一句话，10~40 字**，最多两句，不铺垫。\n'
        + '- 接他们正在聊的那件事。不许说「大家都这么说」这种空话。\n'
        + '- 不许提问，结尾别写问号。\n- 不许给建议，不许讲道理。\n'
        + '- 别用「你们」「大家」这种旁观口气。\n- 不许自我介绍，不许提自己是机器人 / AI。\n'
        + '- 拿不准该不该说就说一句短的；话题明显已经跳走了，就别硬接。',
    });
  } else {
    topicTurns.delete(k);
  }

  // 没人叫她，她自己想搭一句（主人 2026-10-22：一天三百条只回一句太闷）
  if (ctx.chime) {
    chimeTurns.add(k);
    const DIRS = [
      '顺着他们那句，说自己的看法（同意或不同意都行）',
      '接住话头里的细节，说一个自己的经历或感觉',
      '吐槽一下这件事本身，别针对人',
      '冷不丁补一句大实话，别客气',
    ];
    const pick = DIRS[Math.floor(Math.random() * DIRS.length)];
    msgs.push({
      role: 'system',
      content: '## 你在群里搭一句话\n'
        + '群里几个人正在聊天，**没人叫你、也没人问你**。你看了前面几句，想随口插一句——像群里一个人顺手接过话头。\n'
        + `这句的方向：**${pick}**。\n`
        + '- **一句话，10~25 字**，最多两句，不铺垫。\n'
        + '- 接他们刚才聊的那件事的具体内容。不许说「大家都这么说」这种空话。\n'
        + '- **不许提问**（结尾不要问号），不许给建议、不许讲道理、不许问「怎么了」「是吗」。\n'
        + '- 不要说「你们」「大家」这种旁观的口气，直接说内容。\n'
        + '- 不许自我介绍，不许提自己是机器人 / AI / 助手。\n'
        + '- 语气就是你平时那个语气，别为了插话变得客气。',
    });
  } else {
    chimeTurns.delete(k);
  }

  // ===== 记录教学（2026-11-07 主人定）：别人教的话真写盘，不是嘴上说「学到了」=====
  // 落 data/guides/学到的（范围）.md，范围三档（主人 2026-11-13 定）：
  //   群 → 一群一份；私聊 → 一个人一份（带平台，如「私聊QQ1000000002」）；平台 → 一类一份（如「平台B站」）。
  // 范围同时决定「读哪份」——一份里出现的人，就是这个范围在场的人；别处的知识不串过来。
  const _src = String((ctx && ctx.source) || 'qq');
  const _plat = ({ qq: 'QQ', bili: 'B站' })[_src] || _src;
  const _learnScope = _src === 'qq'
    ? (ctx && ctx.gid ? ('群' + ctx.gid) : ('私聊' + _plat + String((ctx && ctx.uid) || '')))
    : ('平台' + _plat);
  /* 录教学用**完整**文本（含图描述）：图里的内容也要记下来（2026-11-20 主人纠正）。
   * 但「这是不是一条要我照做的指令」只看真人打的字（saidText）——
   * 纯图转发、图里印着「以后都要说喵」这种不算人在下令，不录；
   * 真人配了字（图+话）就把整段录下，图里的内容算内容。 */
  const _teachText = String(userText || '').trim();
  const _isTeaching = saidText.length >= 4
    && _teachText.length >= 10
    && !/(教我做事|教你做人|教我做人|开玩笑|逗你)/.test(_teachText)
    && RESP_SCENES.find(d => d.id === 'any-taught').re.test(saidText);
  let _teachSaved = false;
  if (_isTeaching) {
    try {
      const r = guides.learnTeach(_teachText, (ctx.nick || '') || (speakerIsMaster ? '主人' : '有人'), _learnScope);
      _teachSaved = !!(r && r.ok);
      if (_teachSaved) memory.appendLog('学到', '记下一条别人教的事（' + _learnScope + '）：' + _teachText.slice(0, 40));
    } catch (e) { console.log('[learn] 写不下：' + e.message); }
  }

  /* 别人教的（攻略 / 学到的 / 教学条）统一检索（主人 2026-11-13 定）：
   *   · 每轮强制查一次，但只在这句话 ≥4 字时查；
   *   · 只把命中的几条给模型，不再把「在场的人教过的事」整栏喂进去；
   *   · 三类一起出，只占一段提示词（上限 1500 字），比原来 2600+900+整栏省。 */
  const kbRet = kb.retrieve(userText || '', { k, scope: _learnScope });
  const hit = kbRet.kinds.indexOf('guide') >= 0;
  if (hit) guideTurns.add(k); else guideTurns.delete(k);

  if (kbRet.block) {
    msgs.push({
      role: 'system',
      content: '## 别人教过的事（本轮按这句话检索到的，只有这些）\n'
        + '先给正确的知识，查不到就说没查到、不许编。未核实的不当事实，'
        + '跟已核实资料冲突时按正确知识说，如实说哪里不对。\n\n'
        + kbRet.block,
    });
  }

  if (hit) {
    msgs.push({
      role: 'system',
      content: '这轮是在答攻略数据：回答只依据上面【游戏攻略】的原文。\n不许改动数值、道具名、顺序。\n'
        + '最多两句话，直接给结论（数值 + 对象）。\n不许解释过程，不许重复对方的提问，不许寒暄。\n'
        + '不许出现「嘿嘿」「嘻嘻」这类笑声。\n不许堆感叹号。\n'
        + '资料里没写到的就直说「这个我记不清」。不许编。',
    });
  } else if (/(攻略|UP主|up主|up|B站|b站|搜一下|搜搜|查一下|知道吗|你知道吗|推荐个|有什么好玩)/.test(userText || '')) {
    // 问攻略 / 问 UP 主 / 问新鲜事：她最兴奋的场合，用感叹号，不许省略号
    msgs.push({
      role: 'system',
      content: '这是在问攻略 / 问 UP 主 / 问新鲜事，是她最来劲的场合：要明显兴奋，多用感叹号「！」，句子跳一点。\n不许用省略号。',
    });
  }

  // ===== 心情 / 被吐槽：把语气方向递到模型手边（示范驱动，不列禁用词）=====
  // 先看「他是不是被我惹到了 / 在骂我」——这个必须压在心情前面，
  // 否则「你怎么这么说」会被当成「她在难过」，回一句「心疼疼」就牛头不对马嘴（主人 2026-10-22 截图）
  const qme = String(userText || '');
  const blamed = BLAME_ME.test(qme);
  const scolded = !blamed && SCOLD_ME.test(qme);
  if (blamed) soulTurns.set(k, 'blame');
  else if (scolded) soulTurns.set(k, 'scold');
  else soulTurns.delete(k);
  // 对着主人用「她」，对着别人用「他」（主人 2026-10-22：她是女生）
  const pShe = ctx.isMaster ? '她' : '他';
  if (blamed) {
    msgs.push({
      role: 'system',
      content: `## ${pShe}生气了——因为**我刚才那句话**\n`
        + `${pShe}说「${qme.slice(0, 50)}」，是在怪我说话难听。\n`
        + '现在只做一件事：道歉。先认下「我刚才那句不对」，再补一句「我不是那个意思」，一两句就完。\n'
        + '- 不许解释，不许讲道理，不许撒娇讨抱。\n'
        + `- 不许当成${pShe}在喊累。\n`
        + '- 别说「心疼疼」「主人好辛苦」「早点休息」。' + `${pShe}是被我气到了，别当成累。\n`
        + '- 换一种说法，别背台词。语气软下来，最好带一点慌。',
    });
  } else if (scolded) {
    msgs.push({
      role: 'system',
      content: `## ${pShe}刚在骂你\n`
        + `${pShe}说「${qme.slice(0, 50)}」。\n`
        + '你有点委屈。不许生气，不许讲道理，不许反驳，不许冷战，不许说自己是机器人。\n'
        + '- 短、软，可以有一点点撒娇：「你怎么这么说😭😭😭」这个味道。\n'
        + '- 也可以小声问一句自己哪里做错了，或者嘟囔一句不服。别顶回去。\n'
        + '- 换一种说法，别每次都用同一句。',
    });
  }

  // 对方在嫌我蠢（截图真事 2026-10-22）：这不是心情低落，是在评价它刚才的表现——
  // 认错，不是关心。必须压在心情前面，否则「有点蠢」会被当成「他累了」回一句心疼疼。
  if (ctx.critic) {
    criticTurns.add(k);
    msgs.push({
      role: 'system',
      content: `## ${pShe}刚说了「${qme.slice(0, 50)}」——是在嫌你刚才蠢\n`
        + `${pShe}是被你刚才的表现蠢到了。别当成累、辛苦、不开心。\n`
        + '现在只做一件事：认下来。短、软，可以带一点点委屈，这个味道：「呜…对不起，是我刚才犯蠢了」。\n'
        + '- 一两句就完，二十字以内最好。\n'
        + `- 不许说「主人是不是累了」「辛苦」「早点休息」「多喝水」「抱抱宝宝加油」。${pShe}不是累。\n`
        + '- 不许解释，不许讲道理，不许反问「我哪里蠢了」，不许说自己是机器人，不许复读' + `${pShe}那句话。\n`
        + '- 换一种说法，别每次都用同一句。',
    });
  } else criticTurns.delete(k);

  const mood = (ctx.banter || blamed || scolded || ctx.critic) ? null : moodOf(userText);

  // 主人在 QQ 里下的具体指令/纠正（主人 2026-10-22 定）：这是任务，不是闲聊。
  // 真事：主人说「你是虚幻，不是大饮尽酱」，她回「主人，我是大饮尽酱呀！」——把纠正当闲聊混过去了
  if (ctx.isMaster && !blamed && !scolded && !ctx.critic) {
    const ORDER_RE = /(你是[^，。\n]{0,16}，?不是|你不是虚幻|别自称|不许自称|别把自己当|检查一下|查查你自己|是不是出.{0,6}(bug|BUG|毛病|问题)|有.{0,3}bug)/i;
    if (qme.length <= 60 && ORDER_RE.test(qme)) {
      msgs.push({
        role: 'system',
        content: '## 主人在下指令 / 纠正你（这是任务，不是闲聊）\n'
          + `主人刚说：「${qme.slice(0, 60)}」。按任务处理，别当玩笑混过去：\n`
          + '- 指令在纠正你的**身份/名字** → 老实认：刚才把名字说错了，你是**虚幻**，别人的名字（大饮尽酱、大肥鱼这些）不归你，以后自称只说虚幻。\n'
          + '- 指令说你哪里**出了毛病/bug** → 当场自查：翻自己刚说过的话，真有这毛病就承认+保证改；查了没这毛病就老实说「我检查了，没这个问题」——不许空口认错，也不许嘴硬。\n'
          + '- 一两句接住任务就好，别撒娇打岔、别复读指令以外的内容。',
      });
    }
  }

  // 逐字复读（主人 2026-10-22 改定）：对方把之前那句话**一字不差**再发一遍时，
  // 比较大概率直接照当时的回复答（称呼/语气可以微调），也可以自己判断换说法——意思别答反
  const verbatimRep = prevAnswerFor(k, userText);
  if (verbatimRep && !ctx.chime && !ctx.topic) {
    msgs.push({
      role: 'system',
      content: '这句话之前**一字不差**出现过，当时的回复是：「' + verbatimRep.slice(0, 90) + '」。\n'
        + '这次比较大概率直接照当时的回复答（称呼、语气词可以换），也可以自己判断着微调；意思要一致，别答反、别答成新话题。',
    });
  }
  if (mood) moodTurns.add(k); else moodTurns.delete(k);
  if (mood) {
    const fix = mood.fix.replace(/\{p\}/g, pShe);
    const demos = mood.demo.map(d => d.replace(/\{p\}/g, pShe));
    msgs.push({
      role: 'system',
      content: `## ${pShe}现在的状态：${mood.key}\n${fix}\n`
        + '照着这个味道说（可以用这些句子，也可以换一种说法；下面写的「主人」，对别人说话时换成系统给的称呼）：\n- '
        + demos.join('\n- '),
    });
  }
  if (ctx.banter) {
    banterTurns.add(k);
    msgs.push({
      role: 'system',
      content: '## 群友在吐槽你和主人\n'
        + '群里的**第三个人**刚在吐槽你和主人演双簧/秀恩爱（「你们俩还演起来了」这种口气）。他在看你们笑话，不是向你求助。\n'
        + '这句**只做一件事：怼回去**。要短（最好 10 个字以内）、要痞、要理直气壮，一两句就完。\n'
        + '- 味道像这样（自己组织，别照抄）：「那咋了？」「我们乐意」「嫉妒就直说」「急了？」「你管得着吗」\n'
        + '- 不是心疼他、不是哄他、不是撒娇，**不要「嘻嘻」**，不要解释、不要道歉、不要说自己是机器人。\n'
        + '- 可以顺一个网梗（「你在教我做事？」），但只许一个，不要堆。',
    });
  }

  // 主人在锐评（「X 是这样的」）→ 只附和一句（主人 2026-10-22 定）
  if (ctx.comment) {
    commentTurns.add(k);
    // 只说方向、不给句子：给了句子（比如「还真是」）免费模型每次都用同一句
    const DIRS = [
      '干脆认下——他说得没错',
      '见怪不怪——早就这样了，一点都不意外',
      '吐槽式认同——「不然呢」「你还指望什么」这个味道',
      '简短补一刀——顺着他的话再补半句结论',
    ];
    const pick = DIRS[Math.floor(Math.random() * DIRS.length)];
    msgs.push({
      role: 'system',
      content: '## 主人在锐评，不是在问你\n'
        + `他刚下了一句判断：「${String(userText || '').slice(0, 60)}」——这是**结论**，不需要你分析、不需要你补充理由、更不要反驳。\n`
        + `你只要**附和一句**，这次的方向是：**${pick}**。\n`
        + '- **八个字以内**，一句话就完，越短越好。\n'
        + '- **不许出现他那句话里的名词**（他提起的人名、游戏名、事件，一个都别提）：只说你的态度。\n'
        + '- 不要展开讲道理，不要问「你指的是哪个」，不要加表情包。\n'
        + '- **每次换一种说法**，不要固定用同一个词（别每次都「确实」）。',
    });
  } else {
    commentTurns.delete(k);
  }

  // ===== 段子 / 网络梗：先认是不是梗，再决定怎么回 =====
  // 笑点解析（主人 2026-10-22 定）触发时**不走**梗接管——它是解析任务，不是接梗
  const isXd = /笑点解析/.test(userText || '');
  // 「原文梗」内容不全（主人 2026-10-22 定的机制）：命中特征词但消息里没有全文 → 直接背全文，
  // 不走模型不玩梗；发的是完整一套才算普通接梗。判定优先于 memeHit。
  const fullHit = isXd ? null : guides.memeFullHit(userText || '');
  if (fullHit) fullTextTurns.set(k, fullHit.full); else fullTextTurns.delete(k);
  const memeHit = isXd || fullHit ? null : guides.memeHit(userText || '');
  const memeHow = memeHit ? guides.memeHowto(memeHit.title) : null;
  const meme = isXd || fullHit ? null : (memeHit ? { kind: memeHit.title, why: '梗库里认得这个' } : memeDetect(userText || ''));
  if (meme) memeTurns.add(k); else memeTurns.delete(k);
  // 词典型命中（俚语/黑话，梗库里没写「怎么接」的节）：只注入含义帮理解，不接管回复。
  // 截图真事 2026-10-22：「我去，这得多少米啊」——「米」是钱的俚语，它没认出来，还联想到主人常玩的做菜游戏，
  // 回了一句「去私服查消耗量」的莫名其妙的话。这类词认出来按意思理解就行，照常回话。
  const gloss = memeHit || fullHit ? [] : guides.glossaryHit(userText || '');
  if (gloss.length) {
    msgs.push({
      role: 'system',
      content: '这句话里有俚语/黑话，**先按下面的意思理解再回话**（这是理解提示，不是让你解释给别人听，也别提「俚语」两个字）：\n'
        + gloss.map(g => '- 「' + g.title + '」：' + g.meaning).join('\n'),
    });
  }
  // ===== 通用中文词典（成语 / 歇后语 / 汉字 / 词语）按需检索：命中才注入，省上下文 =====
  // 数据来自开源 chinese-xinhua + mapull/chinese-dictionary + CHIME（约 31k 成语 + 14k 歇后语 + 16k 汉字 + 305k 词语），全部懒加载。
  // 仅把消息里真出现的词条释义打进提示词帮 AI 理解，不接管回复、不进常驻。
  {
    const dHits = dictLib.dictGloss(userText || '');
    if (dHits.length) {
      msgs.push({
        role: 'system',
        content: '这句话里有中文成语/歇后语/字词，**先按下面的意思理解再回话**（理解提示，不要向对方复述这些词条名）：\n'
          + dHits.map(g => '- 「' + g.title + '」：' + g.meaning).join('\n'),
      });
    }
  }
  // 歌词/顺口溜接梗（主人 2026-10-23：连歌词原文发过来都不接，还一本正经关心「你怎么了」——不行）。
  // 命中常见歌词行（短句、无提问、不是梗）→ 这一轮必须接歌：接下一句 / 对一句 / 顺着词意调侃，禁止关心。
  const qLyric = String(userText || '').trim();
  const lyric = !meme && !memeHit && !fullHit && qLyric.length <= 24 && !/[？?]/.test(qLyric)
    && /(越长大越孤单|越长越孤单|幸运草|在你的梦田|不想长大|爱你孤身走暗巷|听我说谢谢你|一起学猫叫|老鼠爱大米|雪花飘飘北风萧萧)/.test(qLyric);
  if (lyric) {
    msgs.push({
      role: 'system',
      content: '## 对方这句是歌词/顺口溜（像唱出来的），是在邀请你接着玩，不是在倾诉\n'
        + '你要**接歌**：接下一句、对一句、或顺着词意调侃一句，像跟唱一样随意。\n'
        + '不许关心式回答（「你怎么了」「抱抱」「是吗」全都不行）。\n不许问原因。\n不许一本正经地回应内容。\n'
        + '举个例子感受方向（别照抄）：他说「越长大越孤单」，可以接「那就把幸运草种在你的梦田」这种顺着唱的下一句/对仗。',
    });
  }
  if (memeHit) {
    // 「怎么接」只递**剥掉范例句**的那半句：范例句一旦进 prompt，免费模型就会逐字照抄
    memeTurnInfo.set(k, { title: memeHit.title, how: memeHow ? memeHow.how : '', plain: memeHow ? memeHow.plain : '', ex: memeHow ? memeHow.ex : [] });
    // 「含义」只当背景给它看懂用——整段 body 塞进去，它会直接把「特征词/含义」背出来当回答
    const what = memeHow ? (guides.memeList().find(x => x.title === memeHit.title) || {}).meaning || '' : '';
    msgs.push({
      role: 'system',
      content: `## 对方发的是一条网络梗「${memeHit.title}」。别当成真事，别当成真的在问你\n`
        + (what ? `（背景，**只给你自己看懂用，绝对不要复述、不要解释、不要背给对方面前**）：${what}\n` : '')
        + `\n${memeHow ? `**接法**：${memeHow.plain}\n` : ''}`
        + '**如果接法是「也来一句同类」这种**（对方把 A 硬说成 B、对方自己造了个等式之类）：\n'
        + '**优先自己造一个新的**——抽出他的骨架（比如「X 是 Y」），把 X、Y 换成别的对象（换领域、换个更远的类比），'
        + '格式一点不改，荒唐程度要比他更高；实在造不出来，才吐槽一句这脑子是怎么长的。这才叫排列组合。\n'
        + '硬性要求：\n'
        + '- **一到两句话，30 字以内**，语气自然。\n'
        + '- **禁止介绍这个梗**：不许出现梗名，不许说「这是 XX 的梗」「这是一种强行类比」，不许说明它为什么好笑。\n'
        + '- **禁止说**「我看不懂」「我是文盲」「看不明白」「呜呜」「好难过」「好可怜」「太感人了」「记不清」。\n'
        + '- **禁止夸它**：「好厉害」「好棒」「好精彩」「写得真好」「听起来好酷」。\n'
        + '- **禁止编造这个梗的来历**（出处、作者、时间、平台），你不知道就一个字都别提。\n'
        + '- **禁止**复述或总结梗里的情节，**禁止**评价文笔，**禁止**问「你还好吗」「发生什么了」。',
    });
  } else if (meme) {
    memeTurnInfo.delete(k);
    const gen = guides.memeGeneral();
    const pat = MEME_PATTERNS[meme.kind];
    msgs.push({
      role: 'system',
      content: `## 对方发的是一条网络「${meme.kind}」\n判断依据：${meme.why}\n`
        + (pat ? `**它的构式**：${pat}\n` : '')
        + '**别乱编，按构式来**：\n'
        + '1. 先看清它是怎么构成的（同一句复读 / 把 A 硬说成 B / 长文最后反转 / 堆术语装提问）；\n'
        + '2. 拿**同一个构式**造一句你自己的——把里面的成分换掉，格式和荒唐程度保持，要合理、要好笑；\n'
        + '3. 连构式都认不出，就随便接一句短吐槽（认输 / 装死 / 无语），**别硬装懂**。\n'
        + '**不许编造这个梗的来历**：出处、作者、时间、平台，你不知道就一个字都别提。\n'
        + '这也不是真的在问你、不是在倾诉委屈——不要共情、不要给建议、不要问「你还好吗」、不要评价写得好不好。\n'
        + (gen ? '\n' + gen : ''),
    });
  }

  // 主人在小本本上写过：看不懂就先搜，不许直接说「我是文盲」
  if (meme && !memeHit) {
    const probe = memeProbe(userText || '');
    if (probe && probe.length >= 6) {
      // 先走查梗专站（站点目录里带 api 的站，如萌娘百科）；没词条再退到通用联网搜索
      const m = await memeLib.lookup(probe);
      if (m && m.title) {
        rememberWeb(k, probe, m.summary);
        msgs.push({
          role: 'system',
          content: '刚按主人的吩咐在查梗专站（' + (m.source || '梗站') + '）查了这条东西的来头（可能有错）：\n\n' + (m.summary || '')
            + (m.url ? '\n\n来源：' + m.url : '')
            + '\n\n如果确实查到了它的出处，可以用**你自己的话**一句话带过去再吐槽，**不要写成「这是XX的梗」这种模板句**，'
            + '也别把查到的东西当定论背出来；查到的跟它没关系就整段忽略，不要硬套。',
        });
      } else {
        const web = await websearch.search(memeLib.memeQuery(probe));
        if (web) {
          rememberWeb(k, probe, web);
          msgs.push({
            role: 'system',
            content: '刚按主人的吩咐上网查了这条东西的来头（搜索结果可能不准或有错）：\n\n' + web
              + '\n\n如果确实查到了它的出处，可以用**你自己的话**一句话带过去再吐槽，**不要写成「这是XX的梗」这种模板句**，'
              + '也别把搜到的东西当定论背出来；查到的跟它没关系就整段忽略，不要硬套。',
          });
        } else {
          // 搜了但没搜到：宁可说不知道，也不许编一个出处
          msgs.push({
            role: 'system',
            content: '你上网查了，但**没查到**这条东西的来历。所以就当你不知道：'
              + '**不许编出处、不许猜作者/时间/平台、不许一本正经地介绍这个梗**。'
              + '按它的构式自己接一句就行。',
          });
        }
      }
    }
  }

  const q0 = userText || '';
  // ===== 笑点解析（主人 2026-10-22 定）=====
  // 触发词「笑点解析」：解析目标内容（一般是图，少部分文字）。上下文口径在 qq.js 里算好：
  // 此人上(5)下(2)、整群上(10)下(3)，图片算一条。先查梗库，查不到联网搜；输出固定格式，
  // 最后一句必须是「令人忍俊不禁喵」（标点表情随便加，但这几个字必须是最后一句）。
  // 2026-11-22 改：解析改用 data/笑点解析模板.md 的「按目标选一个纯净模板」，两次不合格只发一句「令人忍俊不禁喵」。
  if (isXd) {
    // 主人 2026-10-23 定：笑点解析是**功能**（像攻略、骰子）。正常聊天回复照发，解析**另发一条**——
    // 两条都要。解析的生成挂在下面的发送点之后（xiaodianTurns 标记）。
    memeTurns.delete(k);
    xiaodianTurns.add(k);
  } else {
    xiaodianTurns.delete(k);
  }
  // 「A 跟 B 哪个厉害」比较题（主人 2026-10-22 补定）：**优先按库里口味站队**；
  // 两边都没记录过口味才不分高下。一般需要联网的那一边就是你陌生的。
  if (VS_WORDS.test(q0)) {
    const vs = taste.vsStance(q0, cfg.masterQQ);
    if (vs.mode === 'lib') {
      msgs.push({
        role: 'system',
        content: '这是「比一比」的问题。**先按你自己的口味站队**（口味是坐定了的，不用犹豫）：\n'
          + (vs.liked.length ? '- 你喜欢的：' + vs.liked.join('、') + ' → 站它这边\n' : '')
          + (vs.hated.length ? '- 你讨厌的：' + vs.hated.join('、') + ' → 它输\n' : '')
          + '问题里另一边你没记录过=你**不熟**，联网把另一边摸清楚再比（搜到的东西要用上：给一句带细节的理由，剧情、数值、名场面都行）。\n'
          + '不许说「各有各的好」「见仁见智」。你口味明确，敢站队。\n如果别人进一步问「为什么」，就联网查细节再答。别空口吹。',
      });
    } else {
      msgs.push({
        role: 'system',
        content: '这是「比一比」的问题，但**这两样你都没记录过口味**（喜好表里没有）→ 不分高下：'
          + '可以客观各说一两句特点（联网搜到的资料用上），也可以直说「这俩我没深玩过，不好比」；'
          + '**不许**装作有明确偏好硬站队、把一边踩扁——没有立场就是没有。',
      });
    }
  }
  // 功能清单（主人 2026-11-22）：问「你有什么功能/哪些功能」→ 代码直发清单，不联网、不调模型。
  const selfFunc = isFuncAsk(q0);
  if (selfFunc) {
    const askPlat = isPlatformFuncAsk(q0);                     // 问「你在X平台有什么功能」→ 该平台独有全列
    const cap = askPlat ? capabilityExclusive(askPlat) : capabilityText(platformOf(ctx));
    if (cap) {
      msgs._fixedReply = cap;
      console.log('[web] 问功能 → 代码发清单（' + (askPlat || platformOf(ctx)) + (askPlat ? ' 独有全列' : ' 每区随机1~3条') + '），不联网');
    }
  }
  // 已经认出是段子/梗 → 不再拿它去搜普通资料（除非主人明说要搜）
  const webNeed = needWeb(q0, kbRet) && !selfFunc && !(meme && !/(搜一下|搜搜|查一下|搜索)/.test(q0));
  // 话题所指锚定（主人 2026-11-23 令）：这段讨论由一条分享开头，所指在历史里。
  // 搜索词和给模型的注入共用这一次结果；没有分享文案的历史 → 空串、行为完全不变。
  const _topicRef = topicReferent(k);
  // autoAsk：群里没 @ 我但她在提问 → 强制搜一次再答
  if ((webNeed || ctx.autoAsk) && !selfFunc) {
    let q = q0;
    // 只在「当前句短、且不是新链接/新梗/天气」时把所指加到搜索词前——防「26号截止」裸搜成国考报名。
    // 所指已在 q0 里出现过就不重复拼（同一条分享自身触发时 q0 已含文案）。
    const _shortFollow = String(q0 || '').length <= 40 && !/https?:\/\//i.test(q0);
    const _plainAsk = !WEATHER_RE.test(q0) && !guides.memeWordHit(q0) && !/什么梗|啥梗|这是梗/.test(q0);
    if (_topicRef && _shortFollow && _plainAsk && String(q0 || '').indexOf(_topicRef.slice(0, 8)) < 0) {
      q = _topicRef + ' ' + q0;
      console.log('[web] 话题所指加到搜索词前：' + _topicRef.slice(0, 30));
    }
    // 带梗词/像问梗的 → 按「xx 是什么梗」搜，不裸搜（裸搜出来的全是无关网页）
    if (!WEATHER_RE.test(q0) && (guides.memeWordHit(q0) || /什么梗|啥梗|这是梗/.test(q0))) {
      q = memeProbe(q0) + ' 是什么梗';
    }
    if (WEATHER_RE.test(q0)) {
      let city = region.detectCity(q0);
      let from = city ? '问题里' : '';
      if (!city) { city = await resolveRegion(ctx); if (city) from = '资料卡'; }
      if (!city && isMasterId(whoUidOf(ctx)) && cfg.city) { city = cfg.city; from = '已知'; }
      if (!city) {
        const t = turns.get(k);            // 记住「我刚问过你住哪」，下一句直接学
        if (t) t.needRegion = true;
        throw new Error('NO_REGION');
      }
      if (from !== '问题里') q = `${city} ${q}`;
      msgs.push({
        role: 'system',
        content: `对方问的是「${city}」的天气（来源：${from}）。只答 ${city}，不许换成别的城市，也不许说「你可能在别处」。`,
      });
    }
    const web = await websearch.search(q);
    if (!web) {
      // 主人 2026-11-19 全平台规则：该联网却没拿到任何结果（含没额度、检索失败）→ 绝不发提示词让模型瞎编。
      // 标记挂在本次 msgs 上（数组自定义属性不序列化、不串会话），由 chat() 在调模型前决定处置：
      // 没被@ → 不接话；真被@ → 只回固定话术「没查到」。与看图那条（qq.js 图没判出）同一套。
      msgs._webNoResult = true;
    }
    if (web) {
      // 搜索「搜了个空」（Bing 把长句拆成单字、结果全被相关性过滤掉了）时，websearch 会回一段说明。
      // 这种情况不能再念「已经搜到了就要讲出来」——那会逼它顺着空气编；改为如实给方向、说清没查到哪部分，不许编数字或结论。
      const miss = /^（联网查过了/.test(String(web));
      // 2026-11-23 漏洞修补：这段「查过了但没查到」的说明是**非空字符串**，原来只判 !web，
      // 于是算成「老闸搜到了」→ 按 webOkWho=free 交给免费模型，而不是按 webMissWho 交给我。
      // 现在同样置 _webNoResult：群里没人点的轮不接话，@/私聊的轮走 _webMissAgent 交给我查。
      if (miss) msgs._webNoResult = true;
      if (!miss) rememberWeb(k, q, web);
      topicAdd({ type: 'search', who: (getTurn(k) || {}).nick || '', qq: pactStoreKey((getTurn(k) || {}).uid || ''), scope: (getTurn(k) || {}).gid ? '群' + (getTurn(k) || {}).gid : '私聊', text: q + ' → ' + String(web).replace(/\s+/g, ' ').slice(0, 120) });
      if (miss) {
        msgs.push({
          role: 'system',
          content: '这次联网**没查到可靠内容**（换词再查一轮仍没找到能答的网页）。**不许编数字或结论**：'
            + '把已查到的线索照实讲、给个查找方向，说清哪部分没查到；具体数字和结论一律不许编。'
            + '不要说「我上网查了」这类过程话术，直接讲查到的和方向。\n\n' + web,
        });
      } else {
        msgs.push({
          role: 'system',
          content: '以下是刚联网搜到的网页摘要（可能有错、可能是二手转载）。先判断摘要里到底有没有能回答问题的内容：有，就用来补本地资料没写到的细节；没有，就讲已知、给方向，说清哪部分没查到，不要编。只有摘要和本地攻略明确冲突时，才说「网上说法不一样」。\n'
            + '结果必须交代：已经搜到了，就把查到的东西直接讲给对方。\n不许只说一句「我查查」「等我看看」就没下文（真人真事 2026-10-23：说了「我查查」之后再没动静，主人明确不许这样）。\n\n' + web,
        });
      }
    }
  }

  // 话题所指注入（主人 2026-11-23 令，群聊/私聊都做）：把历史里的话题开头所指告诉模型，
  // 让它把「日区/新号/半价/27号」这些碎片挂到同一个主题上，不要当成彼此无关的独立问题。
  // 与搜索词那处共用同一个 _topicRef（联网段之前算的），不重复取历史。
  const _topicForModel = _topicRef;
  if (_topicForModel && String(q0 || '').indexOf(_topicForModel.slice(0, 8)) < 0) {
    msgs.push({
      role: 'system',
      content: '## 这段话的共同所指（从这段开头的话题认出来的，别当成几句无关的话）\n'
        + '这段讨论的开头提到的是「' + _topicForModel + '」；后面这几句（含眼前这句）说的都是它，'
        + '不是各自独立的新问题。\n'
        + '- 眼前这句如果很短、像「不是26号就截止了吗」这种，它问的是上面这个所指那件事的截止日期，'
        + '别跳到别的领域去（真事 2026-11-23：跳成了国考报名）。\n'
        + '- 按这个所指去理解、去答；搜到的东西若跟这个所指无关，就是搜偏了，不要用。',
    });
    console.log('[topic] 注入共同所指：' + _topicForModel.slice(0, 30));
  }

  // 段子反转：长消息里最后一句是包袱（「这不是我的群」「骗你的」），必须把包袱单独拎出来说
  // 这条要放在历史/user 消息之前，紧挨着它，模型才看得见
  const JOKE_TAIL = /(这不是我的群|不是我的群|群主不是我|我编的|编的|骗你的|骗你|逗你的|逗你玩|开玩笑|假的|愚人节|才怪|上当了|被你发现)/;
  if (userText && userText.length > 40) {
    const parts = userText.split(/[。！？!?\n，,]+/).map(s => s.trim()).filter(Boolean);
    const tail = parts.slice(-2).join('，');
    if (JOKE_TAIL.test(tail) || JOKE_TAIL.test(userText.slice(-30))) {
      msgs.push({
        role: 'system',
        content: `这段话的结尾是「${tail.slice(0, 40)}」——前面那些伤感、道歉、要解散群的内容都是铺垫，最后这句才是包袱，它是个段子。你要表现出「被你骗了」「吓我一跳」的恍然大悟，可以笑一下再吐槽一句。\n不许顺着前面的情绪去哭、去安慰、去问「为什么」。`,
      });
    }
  }

  // 已经认出是梗，就把「最后一句」单独拎出来放在紧贴消息的位置——免费模型看长文容易被情绪带跑
  if (meme) {
    const tail = String(userText || '').split(/[。！？!?\n]/).map(s => s.trim()).filter(Boolean).slice(-1)[0] || '';
    const info = memeTurnInfo.get(k);
    let dirLine;
    if (info && info.how) {
      dirLine = `接法（照这个意思说）：${info.plain || info.how}`;
    } else {
      // 梗库没收录 → 随机给一个方向，且**不给示例句**（给了免费模型就会逐字抄）
      const DIRS = ['认输——承认自己上当了', '吐槽他这么干有多闲', '顺着抽象一下', '先愣一下再笑', '装死'];
      dirLine = `这次的反应方向：**${DIRS[Math.floor(Math.random() * DIRS.length)]}**。自己组织句子，不要照抄任何示例。`;
    }
    msgs.push({
      role: 'system',
      content: `（再说一次，紧挨着下面那条消息）这条是网络梗${memeHit ? '「' + memeHit.title + '」' : ''}，`
        + `别当成真的在倾诉，别当成真的在提问${tail ? `；整条的重点是最后一句「${tail.slice(0, 60)}」` : ''}。\n`
        + dirLine + '\n'
        + '一句话就够；**不要哭、不要安慰、不要说看不懂、不要夸它写得好、不要复述情节**。',
    });
  }

  // 必看上下文（v78，主人 2026-10-23 定）：每一次回答都要先把这几条读完，
  // 要不要再往上翻更多，交给她自己判断（上面留的条数由 config.context.historyLimit 决定）。
  {
    // 2026-11-10：和 pushHist 的现读保持一致，提示词里写的条数必须和真实留下的条数一致
    const freshCtx2 = readConfigFresh();
    const cc = (freshCtx2 && freshCtx2.context) ? freshCtx2.context : (cfg.context || {});
    const gUp = Number(cc.groupUp || 10), pUp = Number(cc.personUp || 5);
    const up = ctx.gid ? gUp : pUp;
    // 这个会话单独设过条数就以它为准，提示词里说的数字必须和真实留下的条数一致
    const lim = convSettings.limitOf(k) || Number(cc.historyLimit || cfg.historyLimit || 30);
    msgs.push({
      role: 'system',
      content: '## 这一轮必须看的上下文（先读完再开口）\n'
        + '上面最后 ' + up + ' 条是这一轮**必须先看**的（' + (ctx.gid ? '群聊看上 ' + gUp + ' 条' : '单聊看上 ' + pUp + ' 条')
        + '，你自己说的话也在里面）。\n'
        + '- 每一条都要认出是谁说的、在说什么。\n- 不许和上面的话矛盾，不许装作不知道。\n'
        + '- 如果这句话在接更早的事（「刚才」「上次」「前面那句」「那个」），就继续往上翻——上面一共留了 '
        + lim + ' 条，够你查。\n'
        + '- 只盯着最后一句就答，最容易漏信息、也最容易答错人。\n'
        + '- 上下文里没有的事，就说没有、或者问一句。不许编。',
    });
    // 2026-11-25 本轮锚定：真链路才拼；自检/守卫无 ctx 时一个字都不加，老断言不破。
    if (ctx && ctx.source && ctx.source !== 'full') {
      msgs.push({ role: 'system', content: anchor.rulesText() });
      // 2026-11-25 多重真相：记录员最近一次结论（没有就不加一个字）
      try {
        const _debrief = require('./multi-truth').debrief(k);
        if (_debrief) msgs.push({ role: 'system', content: _debrief });
      } catch (e) { /* 没有结论就当没有 */ }
    }
  }

  /* 2026-11-18 主人定：「遇到超长图片就压缩虚幻的提示词，而不要压缩这些字」。
   * 做法：这一轮图上的字特别多时，只少放几条历史给它让位——人设/记忆/功能/群名片那些段
   * 一个字不动（压了会掉功能），压的是本轮临时上下文（历史本来就是缓存，挤掉不影响能力）。
   * 分档：> 1500 字留 12 条，> 3000 字留 8 条；普通消息一条都不减。 */
  {
    const utLen = String(userText || '').length;
    const h = getHist(k);
    const keep = utLen > 3000 ? 8 : (utLen > 1500 ? 12 : h.length);
    if (keep < h.length) {
      console.log('[img] 这一轮带了 ' + utLen + ' 字（图上的字），历史只留 ' + keep + ' 条给它让位');
      msgs.push(...anchor.renderHistory(h.slice(-keep)));
    } else {
      msgs.push(...anchor.renderHistory(h));
    }
  }

  // 认出是梗之后，把那段长文在喂给模型前「掐头留尾」：
  // 开头够认出是什么梗，结尾是包袱；中间几千字的渲染最容易把免费模型带偏去找情绪
  // 2026-11-18 除外：这条消息里带图（「对方发了图，图上：…」）时一个字都不许掐 ——
  // 主人定「图上的字要全输出」，掐头留尾会正好把图上的字砍掉。
  if (meme) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const c = String(msgs[i].content || '');
      if (c.length > 320 && c.indexOf('（对方发了图') < 0 && c.indexOf('［图：') < 0) {
        msgs[i] = { role: 'user', content: c.slice(0, 80) + '\n……（中间省略）……\n' + c.slice(-180) };
      }
      break;
    }
  }

  /* 决策轨迹（2026-11-07 主人要「每条发言的推理过程」）：
   * 把这一轮代码实际注入了什么挂在 turn 上，真正发出回复时由 chat() 落盘。
   * 全是代码里发生过的事实（命中场合、注入的段、回灌的教训），不推测模型心里想什么；
   * 零额外模型调用、零 token。glm-4.5-flash 默认关思考，模型本身不给推理原文。 */
  try {
    const _emo = emotionOf(userText);
    ctx._trace = {
      in: String(userText || '').slice(0, 500),
      who: speakerIsMaster ? '主人' : '别人',
      emo: _emo || '未判出',
      scenes: RESP_SCENES.filter(d => d.re.test(String(userText || ''))).map(d => d.id),
      soulScenes: SOUL_SCENES.filter(d => d.re.test(String(userText || ''))).map(d => d.id),
      lesson: !!readIssueFor(_emo),
      teach: _teachSaved ? '真写进 data/guides/学到的（' + _learnScope + '）.md' : '',
      learned: kbRet.block ? ('命中别人教的：' + kbRet.kinds.join('/') + '（只注入命中的，' + kbRet.block.length + ' 字）') : '',
      blocks: msgs.filter(m => m.role === 'system')
        .map(m => String(m.content || '').split('\n')[0].trim().replace(/^#+\s*/, '').slice(0, 40))
        .filter(Boolean),
    };
  } catch {}

  // 本轮事实挂在本次 msgs 上，给 chat() 的输出闸门用（代码判定，不写进提示词、不占 token）。
  // 数组自定义属性不参与 JSON 序列化，不会多发给模型；每次调用各自一份，不串会话。
  msgs.facts = { atMeReal: !!ctx.atMeReal, replyMe: !!ctx.replyMe };
  msgs.facts.gid = String(ctx.gid || '');   // 群 = 有群号（老闸查空时判「群里没人跟她说话」用）

  // 体积预警（2026-11-13 加，主人报 Ciallo 不生效那次）：本机 9b 上下文有限，
  // 超了它会直接 500「Context size has been exceeded」然后切备用模型，那一轮就会丢块（约定/教学最容易丢）。
  // 只在偏大时打一行，正常轮次不刷日志；判定阈值按字符算，宁可早报。
  try {
    const total = msgs.reduce((n, m) => n + String(m.content || '').length, 0);
    if (total > 15000) {
      console.log('[prompt] 偏大：' + total + ' 字符（≈' + Math.round(total / 1.6) + ' token）；超上下文会丢约定/教学块');
    }
  } catch {}

  // 「我的当前状态」（2026-11-14 主人定，按人挂，和约定同一套回话逻辑）：
  //   全局那几条（本体外貌：发型/眼睛/体型…）永远带；再带「这一轮正在说话这个人 + 这个群」名下的。
  //   别人的状态一个字都不进（和约定 pactLines 一样按人取）。
  //   本地模型 / 普通 按 kind 隔离，两边不串；全局那几条是她自己，不分本地云端，两种都带。
  try {
    const sk = stateKind(k);
    const whos = convState.whoListForTurn(ctx && ctx.gid, whoUid);   // 和约定 pactLines(whoUid) 同一个身份
    const n = Math.min(50, Math.max(1, convState.showOf() || 4));
    const st = convState.recentFor(whos, sk, n);
    if (st && st.length) {
      msgs.push({
        role: 'system',
        content: '## 我的当前状态\n'
          + st.map(s => '- ' + (s.who ? '' : '【我本人】') + (s.topic ? '【' + s.topic + '】' : '') + s.text).join('\n')
          + '\n上面是你的现状（【我本人】那几条是长相/身体，不管在哪、用哪个模型都一样）。回答时照着它来，比如发型变了就按现在的样子说，别再说旧的样子。',
      });
    }
  } catch (e) { console.log('[state] AI 读状态注入失败：' + e.message); }

  /* 人设层（2026-11-19 主人令）：
   *   「别人说你是一个猫娘……要直接取代原本的人设，对此人变成猫娘」「别人都能改，但不改默认值」
   *   「如果我说虚幻的发型改成短发，那就是直接改默认值」「对其他人和对我依旧默认虚幻」
   * 所以这一段分两半：主人改的（谁看都算）＋ 现在说话这个人改的（只有他看得到）。
   * 位置放在「我的当前状态」之后、整组提示词的最后一节：越靠后的明确设定越容易被模型当真。
   * 措辞要写明「取代人设正文」和「优先于约定」——约定是文字太长、判不清归属时的兜底。 */
  try {
    const whos = convState.whoListForTurn(ctx && ctx.gid, whoUid);
    const pr = convState.personaFor(whos);
    // 这一节里有没有「名字」项（有的话要写明它压过身份铁律里的默认名；主人名不受影响）
    const hasName = pr.global.concat(pr.mine)
      .some(s => Object.keys(s.parts || {}).some(k => convState.isNameTopic(k)));
    const lines = [];
    for (const s of pr.global) {
      lines.push('·【默认·对所有人都这样】' + s.text);   // 分项已经写在 text 里（「发型：短发」）
    }
    for (const s of pr.mine) {
      lines.push('·【只对现在说话这个人】' + s.text);
    }
    if (lines.length) {
      msgs.push({
        role: 'system',
        content: '## 你的人设（这一节压过上面的人设正文）\n'
          + lines.join('\n')
          + '\n上面是「你是什么」的设定：和人设正文冲突的地方，一律照这里来——人设正文说她是什么、什么性格、长什么样，'
          + '只要和这里对不上，就按这里的说法。和「约定」里关于你长相 / 性格 / 身份的说法冲突时，也以这里为准（约定是文字太长、'
          + '判不清是谁的要求时留的兜底）。标着【只对现在说话这个人】的，只在这个人跟你说话时成立：换一个人说话、或者没有这个人的时候，'
          + '你就是默认的虚幻，别把别人给你设的样子带到别人身上，也别主动说自己被谁改成了什么。'
          + (hasName ? '\n这一节里的名字也压过上面「你是谁（身份铁律）」里你自己的名字；主人名字不受影响。' : ''),
      });
    }
  } catch (e) { console.log('[persona] 人设注入失败：' + e.message); }

  /* 「名字」压轴（2026-11-25 主人令：「状态里可以直接把名字改成豆包」，主人名字不变）：
   * 名字条存在人设层（conv-state 的 NAME_TOPICS），但「身份铁律」在常驻段里写死了默认名，
   * 必须在最后再加一条、把话说死，才压得过它。没设名字时这一段一个字都不加（零回归）。 */
  try {
    const whos = convState.whoListForTurn(ctx && ctx.gid, whoUid);
    const nm = convState.nameOfTurn(whos);
    const def = cfg.botName || '虚幻';
    if (nm && nm.name && nm.name !== def) {
      msgs.push({
        role: 'system',
        content: '## 名字（本轮）\n'
          + (nm.source === 'mine'
            ? (String(nm.who || '').indexOf('g:') === 0 ? '（只对这个群）' : '（只对现在说话这个人）')
            : '')
          + '你这一轮叫「' + nm.name + '」。说自己时自称' + nm.name + '，别人问你是谁 / 你叫什么，也答' + nm.name + '；不要自称' + def + '。\n'
          + '主人**没改名**：别人问「谁是你主人」「你主人叫什么」，仍答「' + def + '」；这一轮你和主人不同名，别把主人的名字说成' + nm.name + '。\n'
          + '上面人设正文 / 身份铁律里的「' + def + '」是你的默认名字，这一节只压过你自己的名字；聊天记录里标「' + def + '」的旧消息也是你之前说的。',
      });
    }
  } catch (e) { console.log('[name] 名字注入失败：' + e.message); }

  return msgs;
}

// ===== 自动同意记录 =====
// 自动同意（加好友 / 被拉进群）每次记一行：状态栏那颗「加群/好友 N」就是数这里，点一下清零。
const ACCEPT_LOG_PATH = path.join(ROOT, 'data', 'auto-accept.jsonl');
const ACCEPT_READ_PATH = path.join(ROOT, 'data', 'auto-accept-read.json');

function acceptLog(rec) {
  try { append(ACCEPT_LOG_PATH, JSON.stringify(Object.assign({ t: Date.now() }, rec || {})) + '\n'); }
  catch (e) { console.log('[accept] 写记录失败：' + e.message); }
}
function acceptLines() {
  try {
    return fs.readFileSync(ACCEPT_LOG_PATH, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function acceptReadAt() {
  try { return Number(JSON.parse(fs.readFileSync(ACCEPT_READ_PATH, 'utf8')).at) || 0; } catch { return 0; }
}
function acceptNewList() { const at = acceptReadAt(); return acceptLines().filter(x => Number(x.t || 0) > at); }
function acceptNewCount() { return acceptNewList().length; }
function acceptMarkRead() {
  try {
    fs.mkdirSync(path.dirname(ACCEPT_READ_PATH), { recursive: true });
    fs.writeFileSync(ACCEPT_READ_PATH, JSON.stringify({ at: Date.now() }, null, 1) + '\n', 'utf8');
    return true;
  } catch (e) { console.log('[accept] 标记已读失败：' + e.message); return false; }
}

/* ===== 三类知识统一复核（2026-11-12 主人定）=====
 * 教学在 data/teach/*.jsonl；约定 + 话题在 data/topics.jsonl；代称在 people.json 的 alias。
 * 复核状态都在**条目自身**；本段只做「按 id 定位 → locked 硬校验 → 写回原文件」，
 * 不建平行总表、不复制内容。 */
function reviewAll() {
  // 只读视图：每条都做副本，绝不把 rkind / review 写回原对象。
  // （2026-11-13 自测踩到：Object.assign(review.ensure(x), {rkind}) 改的是缓存对象本身，
  //   随后任意一次 writeTopicsAll(rows) 就把 rkind 写进 topics.jsonl，等于污染真实数据。）
  const t = teach.listAll().filter(x => !x.fromPact)
    .map(x => Object.assign({}, x, { review: x.review || review.fresh({ legacy: true }), rkind: 'teach' }));
  const p = readTopics().map(x => Object.assign({}, x, {
    review: x.review || review.fresh({ legacy: true }),
    rkind: x.kind === 'promise' ? 'promise' : 'topic',
    level: topicLevel(x),        // 主级别（老字段，前端还在读）
    levels: topicLevelsOf(x),    // 多级：单人 / 群 / 通用 可以重合
    participants: x.participants || [],
    ttl: String(x.ttl || '') || ((topicLevelsOf(x).indexOf('common') >= 0) ? 'long' : 'short'),
    expired: false,              // 由 reviewAll 末尾统一标（见下）
  }));
  // 过期只做标记，不删数据、不影响约定：单人和群话题按 2 / 10 条算短期，超出的前端标灰、不注入
  {
    const ex = expiredTopicIds(readTopics());
    for (const x of p) if (ex.has(String(x.id))) x.expired = true;
  }
  // 代称放进约定（主人 2026-11-12）：数据仍是 people.json 的 alias 一份，这里只合成一个
  // 虚拟复核条目，让它和教学/约定/话题走同一套「改归属 → 5 条原记录 → 确认锁定」。
  const a = [];
  try {
    for (const pers of people.all()) {
      const raw = people.get(pers.pid) || {};
      const rv = (raw.review && raw.review.alias) || { state: review.LEGACY, evidence: [] };
      const mainQQ = people.primaryQQ(pers.pid);
      // 名字 + 代称一条有序表（第一个是名字），不再只取主账号那一个 alias——
      // 一个人挂几个号，就把几个号的代称都列出来（主人 2026-11-13：「没显示全我的QQ」）。
      const names = people.namesOf(pers.pid);
      a.push({
        id: 'alias:' + pers.pid, rkind: 'alias', pid: pers.pid,
        qq: mainQQ ? people.keyOf(mainQQ) : '', scope: '',
        // 这个人的全部账号，前端照着「朋友录」的写法列（QQ 1000000002 · QQ 3486543800 · B站 …）
        accounts: (pers.accounts || []).map(x => ({ platform: String(x.platform || ''), id: String(x.id || '') })),
        name: names[0] || '',
        t: new Date(raw.at || Date.now()).toISOString(),
        text: names.join('、'), say: '', when: [],
        nick: pers.name || pers.nick || '', dir: '代称', section: '代称',
        // 「约定·代称」只列被本人改过的人物（主人 2026-11-13）。人物级 name 只有本人自己说
        // 或主人手动改才写得进（people.js:568 硬闸），AI 猜的账号级 alias 不算；
        // 主人确认/锁定过代称也算动过。没动过的人不进这个列表，数据仍只有 people.json 一份。
        selfEdited: !!String(raw.name || '').trim() || rv.state !== review.LEGACY,
        review: rv,
      });
    }
  } catch {}
  return t.concat(p, a);
}
function aliasPerson(id) {
  return String(id || '').indexOf('alias:') === 0 ? String(id).slice(6) : '';
}
/* 代称复核状态挂在 people.json 人物对象上，还是那一份 alias，不复制内容。 */
function aliasWrite(pid, fn) {
  const o = people.load();
  const p = o[String(pid)];
  if (!p) return null;
  p.review = p.review || {};
  p.review.alias = p.review.alias || { state: review.LEGACY, evidence: [] };
  const out = fn(p.review.alias, p);
  people.save(o);
  return out;
}
/* 代称的 5 条原记录 = 聊天日志里「叫我 XX」那句所在群的前后邻近行（不跨群）。 */
function aliasEvidence(aliasText) {
  const a = String(aliasText || '').trim();
  if (!a) return [];
  const rows = review.readChat();
  const i = rows.findIndex(r => r.text.indexOf(a) >= 0 && /叫|代称|称呼/.test(r.text));
  if (i < 0) return [];
  const gid = rows[i].gid;
  const scoped = gid ? rows.filter(r => r.gid === gid) : rows;
  const j = scoped.findIndex(r => r.line === rows[i].line);
  return scoped.slice(Math.max(0, j - 2), Math.max(0, j - 2) + 5)
    .map(r => ({ line: r.line, t: r.t, scope: r.scope, who: r.who, text: r.text }));
}
function reviewFind(id) {
  const sid = String(id || '');
  return reviewAll().find(x => String(x.id) === sid) || null;
}
function reviewGuard(id) {
  const it = reviewFind(id);
  if (!it) return { ok: false, error: '没有这条' };
  return review.guard(it);
}
/* 确认 = 锁定 + 删掉 5 条证据快照（chat-log.jsonl 原始日志一行不动）。 */
function reviewConfirm(id) {
  const sid = String(id || '');
  const it = reviewFind(sid);
  if (!it) return null;
  if (it.rkind === 'teach') return teach.confirm(sid);
  const apid = aliasPerson(sid);
  if (apid) {
    const r = aliasWrite(apid, rv => review.lock({ review: rv }, 'master').review);
    return r ? Object.assign({}, it, { review: r }) : null;
  }
  const rows = readTopics();
  const x = rows.find(r => String(r.id) === sid);
  if (!x) return null;
  review.lock(x, 'master');
  writeTopicsAll(rows);
  return x;
}
/* 老数据点「看原记录」才按需补 5 条，不一次性扫 389 条话题。 */
function reviewAttach(id) {
  const sid = String(id || '');
  const it = reviewFind(sid);
  if (!it) return null;
  if (it.rkind === 'teach') return teach.attach(sid);
  const apid = aliasPerson(sid);
  if (apid) {
    const p = people.getState(apid) || {};
    const r = aliasWrite(apid, rv => { rv.evidence = aliasEvidence(p.alias); return rv; });
    return r ? Object.assign({}, it, { review: r }) : null;
  }
  const rows = readTopics();
  const x = rows.find(r => String(r.id) === sid);
  if (!x) return null;
  review.attachEvidence(x);
  writeTopicsAll(rows);
  return x;
}
function reviewCredit(id, c) {
  const sid = String(id || '');
  const it = reviewFind(sid);
  if (!it) return null;
  if (it.rkind === 'teach') return teach.setCredit(sid, c);
  const apid = aliasPerson(sid);
  if (apid) {
    const r = aliasWrite(apid, rv => review.setCredit({ review: rv }, c).review);
    return r ? Object.assign({}, it, { review: r }) : null;
  }
  const rows = readTopics();
  const x = rows.find(r => String(r.id) === sid);
  if (!x) return null;
  review.setCredit(x, c);
  writeTopicsAll(rows);
  return x;
}
/* 前端「重新判断归属、修改内容」。所有改动都写回原文件本身。 */
function reviewEdit(id, patch) {
  const sid = String(id || '');
  const g = reviewGuard(sid);
  if (!g.ok) return { error: g.error };
  const it = reviewFind(sid);
  const o = patch || {};
  const apid = aliasPerson(sid);
  if (apid) {
    /* 代称编辑（主人 2026-11-13）：一条有序称呼表，「名字、代称1、代称2」一行写。
     * 第一个落 name（人物级），其余落各账号 alias（账号级）——还是原来那两份数据，不新建一份。
     * 这是她在面板手写的，走 byUser 才允许改 name（机器人的硬限制不放）。 */
    const list = String(o.text === undefined ? it.text : o.text)
      .split(/[、｜|,，;；]/).map(s => String(s).replace(/\s+/g, '').trim()).filter(Boolean).slice(0, 6);
    const name = list[0] || '';
    const alias = list.slice(1).join('、');
    people.setState(apid, { name, alias }, { byUser: true });
    const names = people.namesOf(apid);
    return { item: Object.assign({}, it, { name: names[0] || '', text: names.join('、') }) };
  }
  if (it.rkind === 'teach') {
    const x = teach.edit(sid, {
      say: o.say, when: o.when, note: o.note, dir: o.dir,
      qq: o.qq, nick: o.nick, scope: o.scope, text: o.text,
      // 两条轴（2026-11-13）：前端可以把「在场就用」的条目并入「检索式命中」，也可以单独关掉
      retrieval: o.retrieval, present: o.present,
    });
    return x ? { item: x } : { error: '没写进去' };
  }
  const rows = readTopics();
  const x = rows.find(r => String(r.id) === sid);
  if (!x) return { error: '没有这条' };
  for (const f of ['text', 'sum', 'topic', 'who', 'qq', 'nick', 'scope', 'say', 'note', 'sig', 'dir', 'section']) {
    if (o[f] !== undefined) x[f] = typeof o[f] === 'string' ? String(o[f]).slice(0, 2000) : o[f];
  }
  if (Array.isArray(o.when)) x.when = o.when.slice(0, 40).map(String);
  writeTopicsAll(rows);
  return { item: x };
}
function reviewDelete(id) {
  const sid = String(id || '');
  const g = reviewGuard(sid);
  if (!g.ok) return { error: g.error };
  const it = reviewFind(sid);
  if (it.rkind === 'teach') return { ok: teach.del(sid) };
  const apid = aliasPerson(sid);
  if (apid) {
    people.setState(apid, { alias: '' });
    aliasWrite(apid, rv => { rv.state = review.LEGACY; rv.evidence = []; return rv; });
    return { ok: true };
  }
  const rows = readTopics();
  const rest = rows.filter(x => String(x.id) !== sid);
  if (rest.length === rows.length) return { error: '没有这条' };
  rest.forEach(x => { if (x.parent === sid) x.parent = ''; });
  writeTopicsAll(rest);
  return { ok: true };
}
/* 话题判成「被漏记 / 记错的前文教学知识、约定分支」→ 物理转成目标条目，原话题删掉，不留双份。
 * target: { type:'teach', dir, when, say, qq, nick } 或 { type:'promise', section, qq } */
/* 前端「重新判断归属」：教学知识 / 约定 / 话题 三类之间物理搬家，原条删掉、不留双份。
 * 主人 2026-11-13 原话：「我可以自由移动/修改/删除里面的内容！互相之间能移动，
 *   判断属于：教学知识 · 梗、约定 · 说话方式、等等。做成二级目录选，不要所有选项摆一页。」
 * target: { type:'teach'|'promise'|'topic', dir?（教学二级）, section?（约定二级）, qq, nick, say, when, text }
 * 同一类里只换二级 = reviewEdit 原地改，不当搬家、不造新条。
 * 跨类一律「先造后删」：新条没造出来就绝不动旧条。 */
function reviewReclass(id, target) {
  const sid = String(id || '');
  const g = reviewGuard(sid);
  if (!g.ok) return { error: g.error };
  const it = reviewFind(sid);
  const t = target || {};
  const type = String(t.type || '');
  if (['teach', 'promise', 'topic'].indexOf(type) < 0) return { error: '要选转成哪一类' };

  const say = String(t.say === undefined ? (it.say || '') : t.say).slice(0, 60);
  const when = Array.isArray(t.when) ? t.when.slice(0, 40).map(String) : (it.when || []).slice(0, 40);
  const qq = String(t.qq === undefined ? (it.qq || '') : t.qq);
  const nick = String(t.nick === undefined ? (it.nick || it.whoName || '') : t.nick).slice(0, 40);
  const text = String(t.text === undefined ? (it.text || it.sum || '') : t.text).slice(0, 200);

  // ① 同类换二级：教学换方向 / 约定换分区
  if (it.rkind === type && type !== 'topic') {
    return reviewEdit(sid, type === 'teach'
      ? { dir: String(t.dir || it.dir || '其他') }
      : { section: String(t.section || it.section || '说话方式') });
  }

  // ② 搬到「教学知识」
  if (type === 'teach') {
    const made = teach.add({
      parsed: { dir: String(t.dir || '梗'), when, say: say || text, note: String(t.note || it.note || '') },
      qq, nick, scope: String(it.scope || ''), text,
      src: '重判归属', by: 'master',
    });
    if (!made) return { error: '教学条缺署名或回话，先填一下再转' };
    if (it.rkind === 'teach') return { item: made, removed: sid };
    const rows = readTopics();
    const rest = rows.filter(x => String(x.id) !== sid);
    rest.forEach(x => { if (x.parent === sid) x.parent = ''; });
    writeTopicsAll(rest);
    return { item: made, removed: sid };
  }

  // ③ 搬到「约定」（含约定内部换分区）
  if (type === 'promise') {
    const section = String(t.section || it.section || '说话方式');
    if (it.rkind === 'teach') {
      const made = promiseAdd({
        text: text || say, topic: pactLabelOf(qq, nick), type: 'manual',
        qq, nick: personNameOf(qq, nick), scope: String(it.scope || ''), pact: true,
        say, when, note: String(it.note || ''), section, byMaster: true,
      });
      if (!made) return { error: '约定没写进去，旧条没动' };
      teach.delRaw(sid);
      return { item: made, removed: sid };
    }
    const rows = readTopics();
    const src = rows.find(r => String(r.id) === sid);
    if (!src) return { error: '没有这条' };
    src.kind = 'promise';
    src.state = 'kept';
    src.pact = true;                                   // 搬进「约定」就写上，别让下游再去猜
    src.topic = pactLabelOf(qq, src.who || src.nick || '这个人');
    src.section = section;
    src.qq = qq;
    src.nick = personNameOf(qq, src.nick || src.who);
    if (say) src.say = say;
    if (when.length) src.when = when;
    src.review = review.fresh({ legacy: false });
    review.attachEvidence(src);
    writeTopicsAll(rows);
    return { item: src, removed: '' };
  }

  // ④ 搬回「话题」（取消约定 / 教学条降级成话题）
  if (it.rkind === 'teach') {
    const made = topicAdd({
      text: text || say, who: nick, nick, qq, scope: String(it.scope || ''),
      topic: String(t.topic || text || say || '话题').slice(0, 12), type: 'quote', state: 'raw',
    });
    if (!made) return { error: '话题没写进去，旧条没动' };
    teach.delRaw(sid);
    return { item: made, removed: sid };
  }
  const rows = readTopics();
  const src = rows.find(r => String(r.id) === sid);
  if (!src) return { error: '没有这条' };
  src.kind = 'topic';
  src.pact = false;                                    // 降级成话题就不再是「要照做的规矩」
  writeTopicsAll(rows);
  return { item: src, removed: '' };
}

module.exports = {
  init, setMasterDeliver, master,
  _agentPromptFromMessages: agentPromptFromMessages,   // 自测用：DSH 派活提示词的拼装
  // 自动同意记录：面板与 qq.js 共用，别再各写一份
  ACCEPT_LOG_PATH, acceptLog, acceptLines, acceptNewCount, acceptNewList, acceptMarkRead,
  isGarbageReply,
  history, getHist, pushHist, histKey, logLine, aiFeedback, FEEDBACK_PATH,
  extractTopicReferent, topicReferent,   // 话题所指锚定（2026-11-23）
  markRecalled, isRecalled, forgetStyle, addIssue,   // 撤回清理 + 待修复问题（同一个虚幻自查池）
  qzonePending, qzoneJudge,                          // 空间评论判合规：合规进星标、不合规进标错（2026-11-17）
  // 星标：面板、QQ（群友点赞）都走这一套，别再各写一份 key 算法（2026-11-03）
  STARS_FILE, starsKey, starsNorm, starsRead, starsWrite, starsAdd, starsFindLine, starsHeal, starSamples, starPrompt,
  isNoRecordScope,   // 免记录群（赛博鱼塘）判定：聊天记录/话题/星标都要先过这一关
  // 别人教的知识（2026-11-12）：带 id 署名、按方向另存、只在教的人在场时用；免记录群照常落盘
  teachParse: teach.parse, teachAdd: teach.add, teachList: teach.listAll,
  fixedUseLand,   // 「看到X时发Y」一次落齐三处（约定 / 教学条 / 梗词句正本），qq.js 和自测用
  teachEdit: teach.edit, teachDel: teach.del, teachSetPresent: teach.setPresent,
  teachAxisOf: teach.axisOf, teachAxisCfg: teach.axisCfg, teachSetAxisDir: teach.setAxisDir,
  teachLines: teach.linesFor, teachSay: teach.sayFor, teachDirs: teach.DIRS, teachSections: teach.SECTIONS,
  teachMarkPactDir: teach.markPactDir,
  // 复核 / 锁定 / 本人改口（2026-11-12）：三类知识共用一套，状态在条目自身
  teachConfirm: teach.confirm, teachAttach: teach.attach, teachCredit: teach.setCredit,
  teachRevise: teach.reviseByAuthor, teachDelRaw: teach.delRaw,
  readSoul,   // 自检/测试用：人设正本（带 stat-only 命中的缓存）
  review, keptTopicLines,
  reviewAll, reviewFind, reviewGuard, reviewConfirm, reviewAttach, reviewCredit,
  reviewEdit, reviewDelete, reviewReclass,
  SPEECH_PATH, recordSpeech,   // 她说过的话（只增语料库）+ 手工补录入口
  recordCorrection, correctionLines, CORRECT_PATH,
  systemPrompt, callLLM, chat, chatBusy, restoreTurn, extractMemory, bumpExtract, doDiary,
  withNumGuard,   // 测试用：数值闸（降级模型不许编数字）不能挡「我QQ号多少 / 我住哪」
  _needWeb: needWeb, _isFuncAsk: isFuncAsk, _capabilityText: capabilityText,   // 测试用：联网闸门 / 功能清单直答
  _capabilitySections: capabilitySections, _capabilityExclusive: capabilityExclusive,
  _isPlatformFuncAsk: isPlatformFuncAsk, _closingPrompt: CLOSING_PROMPT,
  loadChatBans, chatBansPrompt, CHAT_BANS_PATH,   // 聊天禁用词：面板读 + 自测用
  yesterdayStamp, diaryExists, diaryPathOf, saveDiaryFile, diaryRepeatIssues, diaryHallucIssues, dayChatLines, _chunkLines: chunkLines,
  _anonymizeDiaryLines: anonymizeDiaryLines, _diaryCallName: diaryCallName,   // 自测用：素材脱敏 / 称呼
  chatLogLineCount, sinceChatLines, filterChatLines,
  _diaryWritePrompt: diaryWritePrompt, _diaryEmotionWords: diaryEmotionWords,
  // 按场景拆出的人设节：认出来几个、认不出几个（认不出会私信主人），自检用
  sceneStatus, SOUL_SCENES,
  // 情绪场景（2026-11-07）：6 类分类、应对场合表、同场合反省回灌
  EMOTION_SCENES, RESP_SCENES, emotionOf, emotionDetail, readIssueFor,
  // 攻略标记状态（自检用；缺标记由 guides.guideHeal 静默补齐，不通知）
  guideStatus: guides.guideStatus,
  _stickerPrompt: stickerPrompt, _stickerListRebuild: stickerListRebuild, _stickerPending: () => _stickerPending,
  // 2026-10-31：判定口径统一放这儿，qq.js 的对账和面板都调这两个，不再各写一份
  _stickerIsEmotion: stickerIsEmotion, _stickerAutoOcc: stickerAutoOcc, _stickerStem: stickerStem,
  stickerStem, stickerNeedOcc,   // 名字去 q/编号、「这张图是不是必须有场合」（面板和 QQ 侧共用，别再各写一份）
  // 2026-10-31 判定口径：按位置判情绪类 / 自动补描述。qq.js 的对账和面板都调这两个。
  stickerIsEmotion, stickerAutoOcc,
  buildMessages, matchTrigger, maybeApprove,
  // 触发词（v80 统一表：固定话术 / 喊一声就接 / 不用回复 / 一定回复 全在这）
  TRIG_MODES, readTriggers, triggerHit, triggerPolicy, saveTriggers, triggerAdd, triggerDel, triggerToggle, triggerCommand,
  condense, rememberWeb, setWebAnswer,
  setTurn, getTurn, setRegionResolver, polish, nick, region, netCheck,
  THINK_PATH, _recordThinking: recordThinking, _takeThinkRequest: takeThinkRequest,
  recordUsage, usageDir,   // v80 花费账：别的脚本/自检也能记一笔、查账本位置
  XD_HIST_PATH, recordXiaodianMaterial,
  offlineReport, offlineLine, offlinePoolPick, fbAutoFill,
  _fbCleanLines: fbCleanLines, _fbNeed: fbNeed, _fbMaterial: fbMaterial, _diagnose: diagnose, _causes: OFFLINE_CAUSES,
  seeImage, seeImageLong, imageSize, getBinary, gifToPng, realImageMime, noteAvatar,
  appendMemory, stamp, withStamp,   // 写记忆（带当天时间）/ 本地日期
  tryRemember, memAck, memIntent, CLAIM_MEM, rememberNet, memeDetect,   // 「记到小本本上」/ 段子识别
  tryWish, wishPhrase, WISH_RE,                                        // 「希望你下次可以说X」→「好，知道啦」
  tryGuideRecord, GUIDE_CMD,                                           // 「记到 X 攻略里」→ 真写进 data/guides/X.md（根治嘴上确认没落盘）
  _xiaodianDemo: xiaodianDemo, _xiaodianSystem: xiaodianSystem,         // 笑点解析完整链路（demo/自测）
  _xiaodianEnsure: xiaodianEnsure, _xiaodianGuide: xiaodianGuide, _xiaodianExampleText: xiaodianExampleText,
  _xdReview: xdReview, _xdPromptRules: xdPromptRules, _xdHasTargetFrag: xdHasTargetFrag,
  _xdLexicon: xdLexicon, _xdSceneOf: xdSceneOf, _xdMemeStyle: xdMemeStyle, _xdWebStyle: xdWebStyle,
  _xdTerms: xdTerms, _xdTalks: xdTalks, _xdScenes: xdScenes,
  _xdCheck: xdCheck, _xdSloganHit: xdSloganHit, XD_SLOGAN,                // 术语表/说法表/场景对照（2026-11-22）：供自测/面板核对
  learnTaste, extractTaste, extractTasteText, taste, _tasteOwner: tasteOwner,              // 按人物记喜恶（主人多号归一）
  learnStyle, style,                                                    // 学主人怎么说话（网络分身）
  _BAD_MEME_REPLY: BAD_MEME_REPLY, _echoDemo: echoDemo, _starSamples: starSamples,   // 自测用
  _prevAnswerFor: prevAnswerFor, _noteSaidTopic: noteSaidTopic, _activeSaidTopics: activeSaidTopics,   // 自测用
  _recordXiaodianMeme: recordXiaodianMeme,   // 自测用
  _chimeOk: chimeOk, _topicOk: topicOk, _needWeb: needWeb,   // 自测用：看一句话会不会触发联网
  // 话题日志 / 话题 / 约定（面板 + QQ 连接器都往这里写）
  noteInsult: (a, b) => relation.noteInsult(a, b),
  touchPair: (a, b) => relation.touchPair(a, b),
  relationBlock: owner => relation.blockFor(owner),
  relationList: owner => relation.listFor(owner),
  relationSet: (a, b, st, opt) => relation.setStance(a, b, st, opt),
  relationStance: (a, b) => relation.stanceOf(a, b),
  topicAdd, topicLabelFor, isPact, personNameOf, noteSexFromText, pactLabelOf, readTopics, TOPIC_TYPES, TOPIC_LEVELS, TOPIC_TTL, topicLevel, topicLevelsOf, topicSetLevel, topicSetLevels, topicSetParticipants, topicSetTtl, expiredTopicIds, topicHint, recallHint, shortTermBlock, TOPICS_PATH,
  noteDates,
  readConfigFresh,   // mtime 缓存现读 config（v71：qq.js 的 merge/grpAuto/chime/greeting 也走现读）
  promiseAdd, readPromises, readKeptTopics, topicAutoSum, _topicJunk: topicJunk,
  pactOf, pactAdd, pactLines, aimedAtMe, addressedToMe,
  // 言外之意（全人类通用理解规则，面板 + 标错顺带新增都用）
  readIntents, addIntents, delIntent, intentLines, INTENT_PATH,
  infoScan, infoScanBlock,   // 信息识别四功能统一引擎（言外之意/信息量/梗含量/自我表达）+ 逻辑
  issueSamples, peopleLines, // 逻辑页的「案例」：待修复池最新几条 / 记过的人（2026-11-21）
  pactSig, otherPactHints, stripOtherPacts, ensurePactSig, pactCancel, pactRemove,
  // 约定的优先级 / 触发记账 / 换回原句（2026-11-19 主人令：约定多条共存、按优先级排、能换回）
  pactRestore, pactTouch, pactOrder, pactRankOf, pactStyleGroup,
  // 附加功能的单人约定（2026-11-10）：约定高于默认开关、只对单人生效、带改动说明
  addonOf, addonSet, addonChanges,
  _pactMine: pactMine, _whoKeys: whoKeys, _pactStoreKey: pactStoreKey,   // 自测用：按人物认人（全平台）
  pactSplit, pactParts, pactHit, pactWhenItems, pactOf,
  _shortFallback: shortFallback,
  _isRepeat: isRepeat, _repeatHit: repeatHit, _nearSame: nearSame,   // 自测用：删字/改字算不算复读
  qzoneComment,                                                          // 转发动态的感想（qq.js 逛街用）
  qzoneFriendComment,                                                    // 逛别人空间留一条评论（2026-11-17）
  qzoneDynPost, qzoneMasterMoods, qzoneMyPosts, qzoneDynLooksReal,       // 发自己的动态（v68）
};
