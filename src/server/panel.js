/*
 * panel.js — 本地管理面板（http://127.0.0.1:8899）
 *
 * 结构：左边文件 → 右边页面。页面里点「小标题」再开一层，无限嵌套。
 * md 的 '# 数量' 就是层级：# 文件标题、## 一级、### 二级 …（超过 6 也照样支持）。
 *
 * 前端在 panel.html + panel-client.js，不再往模板字符串里塞脚本（那是以前白屏的根源）。
 * 只监听 127.0.0.1，只能读写 soul/、data/、data/guides/ 下的 .md。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guides = require('../guides');
const kb = require('../kb');
const masterExamples = require('../master-examples');   // 主人例句（2026-11-22，最高一级案例）                // 2026-11-13：别人教的统一检索 / 单条核实 / 单条删除
const core = require('../core');          // 触发词表的读写只在 core 里（v80：面板和 QQ 私聊命令写同一份）
const chatShards = require('../chat-shards'); // 2026-11-19：聊天记录按会话分片（派生视图，按群/按人一键删、按需读）
const { botWrite } = require('../wlog');
const configStore = require('../config');   // 配置统一入口：从 config/ 四个分区读写
const fixedTags = require('../fixed-tags'); // 2026-11-21：固定标签（面板直接加 / 解锁一次后取消）
const rocoMerchant = require('../roco-merchant'); // 2026-11-21：洛克王国远行商人（面板预览 + 配置）
const alarms = require('../alarms');              // 2026-11-24：她自己给自己定的闹钟（面板读四组 / 改状态 / 手加 / 删）
const rocoBili = require('../roco-bili');         // 2026-11-21：稀有商品（棱镜球/祝福项坠/炫彩蛋）→ B站评论区提醒（面板看状态 / 手动跑一跳）
const people = require('../people');          // 2026-11-03：多端互通，按人物聚合全平台账号（人物维度主存）
const aiMark = require('../ai-mark');         // 2026-11-21：AI 账号标记表（单独一份，不动 people.json）
const region = require('../region');          // 2026-11-19：地区表（按人物；客户端人物卡读写走这里）
const memory = require('../memory');          // 2026-11-07：长期记忆正本 + 按天工作日志
const trace = require('../trace');            // 2026-11-07：每条发言的决策轨迹
const qmeta = require('../qq-meta');          // 2026-11-07：QQ 头像缓存 + 群名表（客户端与机器人共用一份）
const convSettings = require('../conv-settings');  // 2026-11-07：按会话的上下文条数 / 回复开关 / 黑名单
const platLimits = require('../platform-limits');  // 2026-11-17：各平台输出字数上限的单一数据源
const limitProbe = require('../limit-probe');      // 2026-11-17：测 B站字数上限（QQ 走私聊命令）
const biliProbe = require('../bili-probe');
const selfpost = require('../selfpost');       // 2026-11-17：她自己发出去的说说/动态（提示词+思考）
const biliSpace = require('../bili-space');     // 2026-11-17：B站主页/评论楼中楼/私信（只读，登录态取 AstrBot 插件那份）        // 2026-11-17：B站两条探测共用（手动按钮 + 版本变化自动重测同一份）
const platVersion = require('../platform-version'); // 2026-11-17：各平台版本号记录（改版追踪）
const promptSlots = require('../prompt-slots');    // 2026-11-13：聊天记录页「本轮提示词」槽位（读 / 删端，和 core 共用一份）
const convState = require('../conv-state');        // 2026-11-14：聊天记录页「当前状态」（按人/按群挂，和约定同一套；全局那几条=本体外貌）
const astrbotLlm = require('../llm-astrbot');      // 2026-11-10：AstrBot 已配好的模型池（只读它的配置，Key 不对外）
const reviewMod = require('../review');            // 2026-11-12：三类知识复核/锁定/署名隐私
const qzoneComment = require('../qzone-comment');   // 2026-11-17：逛空间评论的记录列表（判合规走 core.qzoneJudge，不另造）
const judge = require('../judge');            // 2026-11-19：虚幻所有发言的统一判定内核（8 scope 平铺、星标/标错/多情绪）

const ROOT = path.join(__dirname, '..');
// 2026-11-02：面板代码搬进 xuhbot/xuhctrl/，但 soul/ data/ docs/ persona/ 都还在
// xuhbot/xuhchatrule/ 下。ROOT 必须指回 xuhchatrule，否则面板会去读一个空的
// xuhctrl/data（页面上看起来就是「数据全没了」）。
const WEB = path.join(__dirname, '..', '..', 'public');   // 前端页面在 public/
const PORT = Number(process.env.PANEL_PORT || 8899);

// 进程级兜底（真人真事 2026-10-22：/api/favor 里一个未定义变量把整个面板打崩）。
// 单个接口出错只记日志，面板进程不再死——刷新一下就行，不用人去重启。
if (require.main === module) process.on('uncaughtException', e => { try { fs.appendFileSync(path.join(ROOT, 'data', 'panel-err.log'), new Date().toISOString() + ' [兜底] ' + (e && e.stack || e) + '\n'); } catch {} });
if (require.main === module) process.on('unhandledRejection', e => { try { fs.appendFileSync(path.join(ROOT, 'data', 'panel-err.log'), new Date().toISOString() + ' [Promise兜底] ' + (e && e.stack || e) + '\n'); } catch {} });
// 人设按层物理切开（2026-11-21）：F 全场景基底 / H 全聊天应对 / D 平台功能。客户端要能列出、能看、能改。
// docs/长期记忆实现原文：实现原文副本在子目录里，listFiles 只扫 DIRS 的一级，所以单独登记，老面板也能列出来看。
const DIRS = ['soul', 'soul/F-全场景通用主人设', 'soul/H-全聊天', 'soul/H-全聊天/应对', 'soul/D-平台功能', 'data', 'data/记忆', 'data/记忆/日志', 'data/guides', 'docs', 'docs/长期记忆实现原文', 'data/diary', 'persona', 'data/stickers'];
const SYS_KEYS = { soul: 'soul/F-全场景通用主人设/虚幻.md', extra: '', memory: 'data/人物列表.md' };
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const abs = r => path.resolve(ROOT, r);

const NEW_STORE = path.join(ROOT, 'data', 'panel-new.json');   // 红点：{fileId:[hash]}

/* ---------- 自动同意记录 ----------
 * ① 自动同意：qq.js 每自动通过一次好友申请/群邀请，就往 auto-accept.jsonl 记一行。
 *    状态栏那颗「加群/好友 N」数的是「比 auto-accept-read.json 里那个时间戳更新的条数」，
 *    点一下 = 把时间戳改成现在 → 数字归零、从 0 重新数。
 */
const ACCEPT_LOG_P = path.join(ROOT, 'data', 'auto-accept.jsonl');
const ACCEPT_READ_P = path.join(ROOT, 'data', 'auto-accept-read.json');

function acceptItems() {
  try {
    return fs.readFileSync(ACCEPT_LOG_P, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function acceptReadAt() {
  try { return Number(JSON.parse(fs.readFileSync(ACCEPT_READ_P, 'utf8')).at) || 0; } catch { return 0; }
}
function acceptNewList() { const at = acceptReadAt(); return acceptItems().filter(x => Number(x.t || 0) > at); }
function acceptMarkReadLocal() {
  try {
    fs.mkdirSync(path.dirname(ACCEPT_READ_P), { recursive: true });
    fs.writeFileSync(ACCEPT_READ_P, JSON.stringify({ at: Date.now() }, null, 1) + '\n', 'utf8');
    return true;
  } catch { return false; }
}
const absOk = r => {  const p = abs(r);
  const ok = DIRS.some(d => p === abs(d) || p.startsWith(abs(d) + path.sep)) && p.endsWith('.md');
  return ok ? p : null;
};
// 看/改原文用的白名单：必须在 ROOT 下，且是这些类型；防目录穿越
const rawOk = r => {
  const p = abs(r);
  const inRoot = p === ROOT || p.startsWith(ROOT + path.sep);
  if (!inRoot) return p && /\.(js|json|jsonl|md|txt|log|html|bat)$/i.test(p) ? p : null;
  if (/\.(js|json|jsonl|md|txt|log|html|bat)$/i.test(p)) return p;
  return null;
};

/* ===== 代码原文「每段悬停解释」（主人 2026-10-23 定：鼠标悬停每一段解释）=====
 * 代码文件在原文页按顶层函数切成一段一段，鼠标放上去就显示这一段是干嘛的。
 * 说明写在 SEG_TIPS（大白话），没写到的段显示函数名。改了函数记得顺手补一句。 */
const SEG_TIPS = {
  'core.js': [
    [/readCached/, '读文件带缓存：文件没改过就直接用上回读的，回答快的两个关键之一'],
    [/function init\(/, '启动入口：接住 config、建目录、把记忆/梗库/称呼各模块备好'],
    [/ensureConfig/, '检查 config：缺的字段补默认值，配置有点坏也不至于起不来'],
    [/checkKey/, '检查智谱 Key 在不在、格式对不对，不对就明确告诉主人'],
    [/function master\(/, '给主人私聊发消息的出口（真正投递由 QQ 连接层接手）'],
    [/setTurn|getTurn/, '每条进来的消息都有一个「现场记录本」：谁发的、哪个群、要不要 @、触发词是什么'],
    [/histKey|getHist/, '对话历史按「谁和谁」分开存：群是群、私聊是私聊，互不掺和'],
    [/isMasterId/, '判断这个 QQ 是不是主人（主号 + 副号都算）'],
    [/similarText|overlapScore|normText/, '把句子洗干净后比相似度——防复读、防照抄示范句全靠它'],
    [/echoDemo/, '判断回复是不是照抄了梗库示范句（示范句不许原样说出）'],
    [/isRepeat/, '同一句话最近说没说过，说过就换一句'],
    [/pushHist/, '往对话历史里记一条（她说过的话、别人说的话都记，标注谁说的）'],
    [/logLine/, '往聊天记录文件写一行——面板「聊天记录」看的就是这些'],
    [/recordCorrection|correctionLines/, '主人纠正过的话存进「纠正本」，以后遇到类似情况先查这里'],
    [/aiFeedback\(/, '往面板「虚幻自查」页写一条：没发出去的内容、自查发现/修好的问题都从这进'],
    [/noteFail/, '模型故障也进「虚幻自查」；同一类 10 分钟最多一条，不刷屏'],
    [/topicAdd|promiseAdd/, '话题/约定落盘，带类型和状态（谁说的、什么内容、记没记）'],
    [/readTopics|readPromises|readKeptTopics/, '读话题日志 / 约定 / 被记住的话题'],
    [/topicAutoSum/, '聊够一段就自动总结成「已总结话题」，挂进话题日志'],
    [/shortTermBlock/, '拼提示词的「短期记忆」块：把最近聊的内容塞给模型'],
    [/topicHint|recallHint|callBackHint/, '拼提示词时查旧账：这话题聊过吗→提醒接着聊；「之前说的那个」→把原话找回来'],
    [/systemPrompt/, '人设总提示词：把 F 主人设（身份/性格/说话/口味）、H 应对语气、称呼、心情全部拼成第一段'],
    [/stickerPrompt/, '把表情包清单（名字/使用场合）拼进提示词，让她会发图'],
    [/starSamples|starPrompt/, '星标：她真发出去、被认可的回复（手动星标 / 群友点赞）。学的是回复逻辑，不是口气'],
    [/readConfigFresh/, '现读 config.json（带 mtime 缓存）：面板改完配置立刻生效，不用重启'],
    [/resolveHost/, '自定义 DNS：直连智谱 API 的 IP，绕开 DNS 污染（踩坑成果，别删）'],
    [/postJson|getBinary/, '底层网络请求封装（带超时）；getBinary 专门拉图片'],
    [/findChrome|gifToPng/, '找浏览器/把 GIF 转成静态图：看图前先把图处理成模型能吃的格式'],
    [/seeOnce|seeImage/, '看图：把图片发给视觉模型翻译成文字（发图、收图都走这）'],
    [/askOnce|callLLM/, '调智谱模型：多模型轮着来，超时/限流自动切备用，全挂就报故障'],
    [/banterFallback|commentFallback|memeFallback|shortFallback/, '各种兜底话术池：模型两次都不听话时，从这里挑一句保底的'],
    [/polish\(/, '发送前最后擦洗：删多余空行、把「嘿嘿」换「嘻嘻」这类统一口癖'],
    [/seqBump/, '她连发时给会话记序号：老回复一旦对不上序号就作废，防止答非所问'],
    [/diagnose/, '把报错翻译成人话（Key 没填/IP 白名单/超时…），报告给主人看'],
    [/offlineReport|offlineLine/, '答不出来时给主人的报告：只写这次命中的那一条原因 + 怎么修（2026-11-13 起不再铺全部可能原因）'],
    [/async function chat\(/, '回复总调度：排队、防串话、各种场景重说、最后把回复交出去——核心中的核心'],
    [/markNew|botTree/, '红点系统：她新写了什么，面板悬停即消'],
    [/appendMemory/, '往长期记忆（人物列表.md）追加一条，自动找到该挂的小节'],
    [/tryRemember|memIntent|rememberNet|memAck/, '「记住了」功能：主人说记住X→真写盘→回执确认，不许光嘴上说记住了'],
    [/tryWish|wishPhrase/, '「希望你下次说X」→回「好，知道啦」→写进想听我说清单'],
    [/moodOf/, '猜这条消息的情绪（开心/难过/被骂…），决定称呼加不加酱'],
    [/pushGlobal|globalRepeat/, '她说过的所有话的全局池：同一句不在不同会话里到处用'],
    [/isGarbageReply/, '判定回复是垃圾（空话/复读/乱码）→ 重说或不说'],
    [/memeDetect|memeProbe/, '粗判这句话像不像在玩梗（给模型加提示用）'],
    [/extractMemory|bumpExtract/, '后台整理：从最近聊天里提取该记的事，写进长期记忆'],
    [/learnStyle/, '学说话：把群里的自然发言收成样本（她的分身照她本人学）'],
    [/tasteOwner/, '主人的多个号归一到同一份口味（主人和虚幻口味是同一份）'],
    [/learnTaste/, '「我最喜欢X/我讨厌X」这种亲口说的，立刻记进口味·确定'],
    [/extractTaste|extractTasteText/, '后台口味整理：从聊天/空间动态里猜喜恶（亲口说的才算确定）'],
    [/doDiary/, '每天写一篇日记，私发主人'],
    [/matchTrigger/, '触发词总入口：这句话命中哪个功能（骰子/攻略/天气…）'],
    [/needWeb/, '决定要不要联网搜：搜不到本地资料/带搜索词/比较题→搜'],
    [/maybeApprove/, '主人说「认可/对的」→ 把上一条联网结果正式入库'],
    [/prevAnswerFor/, '逐字复读保护：同一句之前答过什么，大概率照原样再答'],
    [/noteSaidTopic|activeSaidTopics/, '话题翻篇：刚聊过的话题封 0.5~5 天，不反复说'],
    [/recordXiaodianMeme|xdLibLookup|xiaodianSystem|xiaodianEnsure/, '笑点解析功能链：查资料→拼主人范例→质检格式→「令人忍俊不禁喵」收尾'],
  ],
  'connectors/qq.js': [
    [/isMasterUid|uidTag/, '主人多号识别；uidTag 把「谁说的」标成统一的写法（主人/名字+QQ尾号）'],
    [/sheJustTalkedTo/, '判断「主人刚刚是不是在跟我说话」（3 分钟内）——只有对话场景才认「主人」这个称呼'],
    [/sendAction|callApi/, '往 NapCat 发指令（发消息/撤回…）的底层出口'],
    [/lookupRegion/, '查这个人资料卡上的地区（问天气时定位用）'],
    [/stickerMd5Load|stickerFiles|stickerOccasions|stickerName|stickerRenamePass/, '表情包库管理：读库、按场合挑图、洗老图片的名字'],
    [/stickerPHash|hammingHex/, '图片指纹（感知哈希）：同一张图不重复堆进表情库'],
    [/collectSticker/, '收到图 → 存进表情库（去重、起名、记场合）'],
    [/stickerHit|sendSticker/, '按名字发一张表情包'],
    [/emoMap|emotionOnly|emotionCategory|pickEmotionSticker/, '纯情绪识别：别人发「哈哈哈/救命」时挑对应情绪的表情包'],
    [/greetCfg|greetingHit|greetGate/, '别人跟她打招呼 → 主动应答（带 10 分钟冷却，不刷屏）'],
    [/cfgLive/, '现读 config：面板改完配置立刻生效'],
    [/buildAtSegments/, '把回复里的 @QQ号 转成 QQ 真正的 @ 消息段'],
    [/replyTo/, '真正把回复发出去（群/私聊、带引用/带 @），发完写日志'],
    [/sendPrivate/, '私聊发消息（给主人的报告、汇报都走这）'],
    [/groupAtNeed|applyAtTiming/, '超时必 @：5 秒内不 @、8 秒必 @、5~8 秒随机；连着回同一个人只第一条 @'],
    [/atNameConvert/, '@ 当名字：@ 别人时转成文字名，@ 对方/自己保留真 @'],
    [/sendFixedReply/, '固定话术统一出口（指令回执/问候应答等），同样守复读拦截'],
    [/offlineNotice/, '答不出来时怎么说：群里和别人只说「让主人替我回答」，完整报告私聊发主人'],
    [/parseSegments/, '把 QQ 消息拆成文字/图片/@ 各部分'],
    [/describeImgs/, '收到图：先拿指纹比图库（认得出就是库里那张，不再调模型），认不出再交给视觉模型翻成「字/情绪/是什么」；「［图：…］」就是它写的'],
    [/isBotUser|looksBotMessage/, '认出对方也是机器人 → 只记录不接话（防机器人互聊刷屏）'],
    [/masterAimLine/, '主人 @/引用别人时：生成「对准那个人」的提示语，她回的是那个人不是主人'],
    [/detectCriticism/, '识别「有点蠢/你怎么这么笨」→ 换认错腔调答'],
    [/autoAllowed|dayKey|spokeState|bumpSpoke/, '非 @ 自主接话的群级节流：一个群一天/一次热度最多说几句'],
    [/chimeAllowed/, '「凑热闹」闸门：概率 + 冷却 + 每天上限，全在 config 可调'],
    [/grpAutoTick|grpAutoConsume|autoNeed/, '自主接话计数器：说够了就闭嘴；热度状态（被 @ 一次就进入）另算'],
    [/chainJoinAllowed/, '复读链跟风：≥2 条同文才跟，每链一次，不循环'],
    [/stripEchoFormat|normEchoText/, '剥「某某说：」转述前缀（错误复读的格式，发送前必剥）'],
    [/repeatsOthers|replayAllowed/, '复读守卫：10 条以内别人的话不许复读（梗库/搜到原文/跟风链放行）'],
    [/selfCheckReport/, '主人私聊「修bug/自检」→ 跑自检脚本并回报结果'],
    [/styleGate/, '学说话闸门：只收测试群以外的自然发言，指令/粘贴不收'],
    [/collectFrag|planWaitMs|pushPendingTalk|flushPendingTalk/, '连发合并：主人一条条发的消息等他说完再一起答（各人分开攒）'],
    [/instantLog|noteTalk|talkRing/, '现场消息环：最近谁说了什么（笑点解析/上下文都从这里取）'],
    [/verbatimEcho/, '逐字复读检测：这句是不是刚有人原样说过'],
    [/noteFirstSight/, '第一次见到的群友打个招呼（每个群一次）'],
    [/topicAllowed/, '话题翻篇的群侧检查：这个话题刚说过就不再开'],
    [/async function onMessage\(/, 'QQ 消息总入口：所有进来的消息都先到这，分流去各功能'],
    [/handleTurn/, '处理一条要回的消息：触发词/合并/@判断/最终调模型回复，最大的一个函数'],
    [/setStatus|statusHeartbeat/, '在线状态落盘 + 每分钟心跳（面板的灯、自查探针读的就是它）'],
    [/setThinking/, '「正在想答案…」状态：面板状态栏显示'],
    [/connect/, '连 NapCat：断线重连、上线后的第一件事都在这'],
    [/qzoneArgs|runStroll|qzoneStroll/, 'QQ 空间逛街：每 3 小时逛一次好友动态，挑喜欢的转走（有间隔硬标准防重转）'],
    [/qzoneMaybePost|qzoneTodayPlan/, '空间发说说：每天挑时间发一条'],
    [/jiMeng/, '集梦功能入口'],
    [/greetOnii/, '上线日报：每天 0 点后第一次在线发一次（昨日数据，@主人）'],
    [/reportOnii/, '每日汇报：把最新更新讲给欧尼酱听（一天一次，她自己的口吻）'],
    [/onEmojiLike/, '群友给她点表情回应 → 好感度加星'],
  ],
  'panel.js': [
    [/FILE_META = \{/, '文件登记总表：左列每个文件的名字/分类/能不能改/悬停说明全在这——新文件必须登记'],
    [/CATS|FOLDER_DEFAULTS/, '左列分类定义'],
    [/function buildNav/, '生成左列导航树（文件 + 特殊视图 + 自由文件夹）'],
    [/rulesBook/, '规矩手册内容（面板「规矩」页），改规矩在这改'],
    [/triggerMap/, '触发地图：所有「什么时候会说话」的入口，数字现读 config'],
    [/TABLES = \{/, '地区表/称呼表的定义（面板表格页读的就是它）'],
    [/readTable|writeTable/, '表格页的读写（称呼表四列：名字/代称/id昵称/后缀）'],
    [/readPeople/, '「人物列表」聚合接口：把称呼+好感度+口味+事实按人物名下所有 QQ 拼在一起'],
    [/normAlias/, '代称清洗：拆顿号/去脏字符/最多 5 个（超出砍最老的）'],
    [/readChat|starKey|readStars/, '聊天记录页读取（合并连续消息、星标）'],
    [/readTopics|writeTopics/, '话题日志读写（含批量删除）'],
    [/api\/feedback/, '虚幻自查页接口：读/删/清空（含当前没解决的数量给状态栏）'],
  ],
  'bot.js': [
    [/require|init\(/, '启动流程：读 config → 各模块初始化（顺序不能乱）'],
    [/checkDiary/, '每天一次的日记定时器'],
    [/selfwatch\.start/, '自查启动：每 5 分钟体检，结果进「虚幻自查」页 + 持续 10 分钟私信主人'],
    [/qq\.start/, '连上 QQ 开工'],
  ],
  'nick.js': [
    [/function load\(|function save\(/, '称呼表读写（data/people-state.json）'],
    [/function mood\(/, '猜消息情绪：开心/难过/被骂/好奇 → 称呼要加「酱」'],
    [/aliasList/, '把代称拆成列表（顿号/逗号分隔，去脏字符，最多 5 个）'],
    [/addAlias/, '新猜的代称放最左（优先度高），第 6 个把最老的挤掉'],
    [/pickWeighted/, '按权重挑称呼：名字 40%、代称按优先度从左往右 30%/15%/10%/5%'],
    [/nameFor/, '决定这次叫这个人什么（名字/代称/酱/宝宝的总调度）'],
    [/approveLine/, '主人说「认可」时的回执话术'],
  ],
  'taste.js': [
    [/function parse\(/, '解析口味两张表：别人在《人物喜好》（原文一节一个 QQ，读时按人物名下所有 QQ 合并），主人自己那份在人设层 soul/F-全场景通用主人设/0-我的喜好.md（单节行式）'],
    [/function mine\(/, '读她（＝主人）的口味，第一人称注入提示词'],
    [/function block\(/, '读待人的口味（对别人用第三人称口径，两套别混）'],
    [/function add\(/, '记一条喜恶：确定/待确认/可能 三档分开放'],
    [/function detect\(/, '从一句话里认「我喜欢X/我讨厌X」这种亲口说的'],
    [/mergeModel/, '模型整理出的口味合并入库（有去重和上限）'],
  ],
  'guides.js': [
    [/function search\(/, '攻略检索：把问题切成词，在攻略库里找最相关的小节'],
    [/coverage|titleHit/, '判断本地攻略够不够答这个问题（够就不用联网）'],
    [/loadMemes|parseMemes/, '读梗库（data/网络热梗.md，一节一梗）'],
    [/loadMemeDict|allMemes/, '梗词典（CHIME 1455 条，词典型只理解不接管）'],
    [/memeAdd|memeUpdate|memeDel|memeBody|writeMemes/, '梗库的增删改（面板卡片页调用）'],
    [/memeHit/, '接梗型命中：这句是玩梗 → 接管回复'],
    [/glossaryHit/, '俚语命中（米=钱这类）：只给理解提示，不接管'],
    [/memeFullHit/, '原文梗：库里存着完整原文 → 直接背原文，不走模型'],
    [/memeWordHit|memeHowto|memeGeneral|memeOverview/, '梗的辅助：搜「什么梗」时用、梗速览页用'],
  ],
  'style.js': [
    [/function learn\(/, '学说话入口：收样本（带规则：非测试群、没 @、非粘贴）'],
    [/learnImg/, '发图品味：她发的图存成「爱发哪类图」'],
    [/pickSamples|sampleLine/, '拼提示词时随机挑几个样本，让说话像她'],
    [/block\(/, '说话风格提示词块'],
    [/async function update\(/, '每 15 条样本自动整理一次样本库（去重/合并）'],
  ],
  'websearch.js': [
    [/async function search\(/, '联网搜索：智谱优先（质量好），没额度自动切 Bing 兜底（免费）；结果缓存 10 分钟'],
    [/prewarm/, '搜索预热：主人还在打字时就先把可能要搜的词发出去（省钱：刚失败过就不再预热）'],
    [/bingScrape/, 'Bing 兜底：抓搜索结果页解析出标题/摘要/链接，0 成本'],
  ],
  'favor.js': [
    [/function get\(|function set\(|function add\(/, '好感度读写：夸一次 +1；60 算喜欢；满 100 日常才叫宝宝'],
    [/isBaby/, '好感度满 100 了吗（叫宝宝的条件）'],
    [/function all\(/, '列出所有人的好感度（按高低排）'],
  ],
  'dice.js': [
    [/function ds\(\)/, '接入 SealDice 官方引擎（npm: dicescript）：群里的 .rb100/.ww100 靠它'],
    [/dsExprSane/, '骰子表达式白名单：看不懂的一律不掷（不给莫名其妙的数字）'],
    [/function dsRoll\(/, '用引擎掷一条表达式，返回总数和明细'],
    [/evalDice|maxOf/, '骰子表达式计算（.r/.rd 这类指令）'],
    [/cocLevel|parseCheck/, 'COC 检定：成功等级判定'],
    [/parseSc|scOut/, 'COC 理智扣除'],
    [/function handle\(/, '骰子指令总入口'],
    [/getSan|setSan/, '理智值存取'],
  ],
  'region.js': [
    [/detectCity/, '从一句话里认城市名（问天气用）'],
    [/getRegion|setRegion/, '地区表读写（QQ号→城市）'],
    [/learnFrom/, '聊天里说了「我在成都」→ 自动记进地区表'],
  ],
  'wlog.js': [
    [/botWrite/, '写入日志：机器人每次写文件都记一条（面板「写入日志」页看的）'],
  ],
  'pause.js': [
    [/function pause\(|function allow\(|isPaused/, '暂停/允许：让指定的人/群/全体暂时闭嘴（数据落盘，重启不丢）'],
    [/parseCommand/, '主人私聊口令解析（「暂停XX10分钟」这类）'],
    [/blocked/, '发送前检查：这个人/这个群现在被暂停吗'],
  ],
  'selfwatch.js': [
    [/probeAll/, '自查探针：配置/必备文件/梗库/表情表/NapCat 心跳/模型连通，全查一遍'],
    [/probeLLM/, '模型连通探针（30 分钟一次，别浪费额度）'],
    [/function tick\(/, '每 5 分钟一轮：刚坏/修好各记一条进「虚幻自查」；坏持续 10 分钟私信主人'],
    [/saveState|loadState/, '未解决问题清单落盘：重启后接着记，修好自动补「已恢复」'],
    [/fb\(/, '往「虚幻自查」写一条（面板能看到的那种）'],
  ],
  'selfcheck.js': [
    [/codeCheck/, '代码自检：语法/JSON/必备文件/单测/尾逗号/BOM 自动修'],
    [/whyCheck/, '「为什么不回话」：拿一条真实消息走一遍链路，告诉你卡在哪一步'],
    [/sizeCheck|speedCheck/, '提示词体积/回答速度基准'],
    [/demoCheck/, '笑点解析演示（selfcheck.js --demo）'],
  ],
  'bili-api.js': [
    [/async function api|function parseTarget/, '调 B站接口 + 认「这是哪个视频」'],
    [/async function collectFromVideo/, '拉评论、挑出带图的、逐张收进表情包'],
    [/async function commentVideo|async function sendDm/, '发评论 / 发私信（测字数上限用）'],
    [/function cookieStatus/, '登录态（统一取 AstrBot 插件那份活 cookie）'],
  ],
};

// 把 JS 源码按顶层块切段（注释归到它下面的那段头上），配合 SEG_TIPS 生成悬停说明
function segJs(raw) {
  const lines = String(raw || '').split('\n');
  const segs = [];
  let buf = [];
  let cmt = [];
  const flush = () => { if (buf.length) { segs.push(buf.join('\n')); buf = []; } };
  for (const l of lines) {
    const t = l.trim();
    const isCmt = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
    const isTop = l.length > 0 && l[0] !== ' ' && l[0] !== '\t'
      && (isCmt || /^(async function |function |class |const |let |module\.exports)/.test(l));
    if (isTop && isCmt) { flush(); cmt.push(l); continue; }
    if (isTop) {
      flush();
      buf = cmt.splice(0);
      buf.push(l);
      continue;
    }
    if (cmt.length && !buf.length) buf = cmt.splice(0);
    buf.push(l);
  }
  flush();
  if (cmt.length) segs.push(cmt.join('\n'));
  return segs.filter(s => s.trim());
}

function segTipsFor(id, segs) {
  const list = (SEG_TIPS[id] || []).filter(x => x && x[0] instanceof RegExp);
  return segs.map(code => {
    for (const [re, tip] of list) { try { if (re.test(code)) return tip; } catch {} }
    const m = code.match(/^(?:async )?function ([A-Za-z_$][\w$]*)|^const ([A-Za-z_$][\w$]*)/m);
    return m ? '（这一段：' + (m[1] || m[2]) + '——还没有专门说明）' : '';
  });
}
// 只读文件：碰了会出问题的（代码、运行时数据）不给改
const isReadonly = id => {
  const m = metaOf(id);
  if (m && m.ro) return true;
  if (/\.js$/i.test(id)) return true;
  return false;
};
const okName = n => n && !/[\\/:*?"<>|]/.test(n) && !n.startsWith('.') && n.length <= 40;

function sysIds() {
  try {
    const j = configStore.load();
    return Object.assign({}, SYS_KEYS, j.files || {});
  } catch { return Object.assign({}, SYS_KEYS); }
}
function syncConfig(oldId, newId) {
  try {
    const j = configStore.load();
    const f = j.files || (j.files = {});
    let hit = false;
    for (const k of Object.keys(SYS_KEYS)) {
      if (String(f[k] || '').replace(/\\/g, '/') === oldId) { f[k] = newId; hit = true; }
    }
    if (hit) configStore.writeFull(j);
    return hit;
  } catch { return false; }
}

function readOrder() {
  try {
    const j = configStore.load();
    return Array.isArray(j.panel && j.panel.order) ? j.panel.order : [];
  } catch { return []; }
}
function writeOrder(ids) {
  const j = configStore.load();
  j.panel = j.panel || {};
  j.panel.order = ids;
  configStore.writeFull(j);
}

/* ---------- 左列：按「用途」分 7 大类，支持二级文件夹 ----------
 * 每个用到的文件都在 FILE_META 里登记：cat 分类 / ro 只读 / kind 类型 / use 用途 / range 区间说明。
 *   ro=true  → 代码/系统文件，只给看、不给改（碰了会出问题）
 *   range   → 悬停时告诉主人「这个值的合理区间是什么」
 * 不在 FILE_META 里的 md（用户新建的）自动进「其他」，不会消失。
 * 「文件→分类」可用拖拽改，覆盖写进 config.panel.catOverride。
 */
const CATS = [
  { id: 'soul',    name: '人设',       icon: '📖', when: '它每一轮都带着（说话规则、说话风格都归到这里了，主人 2026-10-22 v52 定）' },
  { id: 'feature', name: '功能',       icon: '⚙️', when: '攻略、骰子、接梗这些本事' },
  { id: 'other',   name: '其他',       icon: '📦', when: '没归类的、系统文件都在这' },
];
const CAT_MAP = {}; CATS.forEach(c => { CAT_MAP[c.id] = c; });

const FILE_META = {
  // —— 人设导出包（2026-10-23 单独提取，原文件一个字节没动；换框架时拿这个就能重建「她」）——
  'persona/README.md': { cat: 'soul', kind: 'md', ro: true, use: '人设导出包总清单：她的人设提示词其实分 5 层（正文/喜恶风格/代码硬编码 13 段/每轮动态 16 段/发送前规则），还有 8 个藏在 JSON 里的数据。要换框架（AstrBot）先看这篇', range: '' },
  'persona/3a-固定段-人设与记忆.md': { cat: 'soul', kind: 'md', ro: true, use: '固定段 1/3：段 1-6（人设四份、认识的人、纠正、人物事实、约定、记住的话题）。照 core.js 的 systemPrompt() 抄的文字版，代码改了它不会自动跟着变', range: '' },
  'persona/3b-固定段-行为规矩.md': { cat: 'soul', kind: 'md', ro: true, use: '固定段 2/3：段 7-10（人设是背景不是台词、QQ 能做什么、聊天记录规矩、身份铁律）', range: '' },
  'persona/3c-固定段-梗·环境·表情.md': { cat: 'soul', kind: 'md', ro: true, use: '固定段 3/3：段 11-13（梗库、环境、表情包）+ 换框架注意', range: '' },
  'persona/4a-动态段-每轮都加.md': { cat: 'soul', kind: 'md', ro: true, use: '动态段 1/4：星标示范、说话风格（这两段每轮都加）', range: '' },
  'persona/4b-动态段-身份与场合.md': { cat: 'soul', kind: 'md', ro: true, use: '动态段 2/4：群名片、身份白名单、约定了的说话方式、问 QQ 号、称呼、本轮事实、没人跟你说话、@ 了别人、引用的那条', range: '' },
  'persona/4c-动态段-口味与记忆.md': { cat: 'soul', kind: 'md', ro: true, use: '动态段 3/4：我自己的口味、记得别人的口味、别复读、群内即时记忆、记忆分层', range: '' },
  'persona/4d-动态段-连接器.md': { cat: 'soul', kind: 'md', ro: true, use: '动态段 4/4：QQ 连接器拼的 extraSystem（拍一拍、新人、晚安、打招呼、自己接话）+ 统一回复要求', range: '' },
  'persona/5-公共规则层.md': { cat: 'soul', kind: 'md', ro: true, use: '发送前最后一道闸：禁括号、拆段、复读白名单、剥@、别人约定不许套、什么时候必须闭嘴/必须回。新框架一定没有，要自己重写', range: '' },
  // —— 人设（按层物理切开 2026-11-21：F 全场景基底 / H 全聊天应对 / D 平台功能）——
  'soul/F-全场景通用主人设/虚幻.md': { cat: 'soul', kind: 'md', use: '【F·全场景通用主人设】人设入口：我是谁 / 我是主人的分身 / 身份铁律 / 我身边的人。全场景唯一一份人格基底，所有场景都注入。另四块在同级目录，一起注入', range: '' },
  'soul/F-全场景通用主人设/0-我的喜好.md': { cat: 'soul', kind: 'md', use: '【F】我自己的口味（主人＝虚幻一体，只此一份）。和「我是谁」一起注入；别人的口味在《人物喜好》里按人物名下所有 QQ 聚合读', range: '确定=她亲口说；待确认=提过没表态；可能=猜的' },
  'soul/F-全场景通用主人设/1-性格.md':   { cat: 'soul', kind: 'md', use: '【F】性格 + 唱歌（不许主动提）。和入口、2-说话、功能词典一起拼成主人设，缺一份人就残', range: '' },
  'soul/F-全场景通用主人设/2-说话.md':   { cat: 'soul', kind: 'md', use: '【F】怎么说话：长短、括号、句号省略号、笑哭、不懂、梗、记东西、表情包。每轮必带', range: '' },
  'soul/F-全场景通用主人设/功能词典.md': { cat: 'soul', kind: 'md', use: '【F】虚幻知道自己有哪些功能、每个分类代表什么。短索引每轮注入，长解释在 HTML 注释里（注入时剥掉）', range: '' },
  'soul/H-全聊天/3-应对.md':   { cat: 'soul', kind: 'md', use: '【H·全聊天】应对语气底色正本，按 公共/我/别人 三块：公共常驻（空间评论/B站评论也靠它才有虚幻风格），我（主人）和别人（群友）由代码按说话人挑着注入。场合专属段在同级 应对/ 下', range: '' },
  'soul/H-全聊天/应对/我-被夸.md': { cat: 'soul', kind: 'md', use: '【H】场合 me-praise（开心）：主人夸我 / 主人自豪 / 说幸好。只在命中这一轮时注入，平时不进提示词；举例是她的原话，不许改', range: '' },
  'soul/H-全聊天/应对/我-被怪.md': { cat: 'soul', kind: 'md', use: '【H】场合 me-blame（生气）：我把主人惹毛、她来质问时的道歉口径。只在命中这一轮时注入；举例是她的原话，不许改', range: '' },
  'soul/H-全聊天/应对/别人-被围观.md': { cat: 'soul', kind: 'md', use: '【H】场合 other-watch（惊讶）：群友围观虚幻和主人互动、说她是机器人。只在命中这一轮时注入；例句是她的原话，不许改', range: '' },
  'soul/H-全聊天/应对/被提问-被需要.md': { cat: 'soul', kind: 'md', use: '【H】场合 any-asked（开心）：有人向她提问＝被需要。主人和陌生人都注入。只在命中这一轮时注入；这是她存在的理由之一（2026-11-07 她定）', range: '' },
  'soul/H-全聊天/应对/被教会-学到了.md': { cat: 'soul', kind: 'md', use: '【H】场合 any-taught（开心）：别人教她东西＝学到了。主人和陌生人都注入。只在命中这一轮时注入；教的内容会真写进 data/guides/学到的.md', range: '' },
  'soul/D-平台功能/空间评论写法.md': { cat: 'soul', kind: 'md', use: '【D·平台功能】QQ空间评论/转发感想/发说说这类「不是聊天」场景的专属写法归属。这层不另起人格——基底用 F，语气用 H 公共块。具体可执行规则写在 core.js 的 qzone* 函数里（这里只指路，避免双份）', range: '' },
  'data/人物列表.md':    { cat: 'soul', kind: 'md', nm: '人物事实', use: '长期记忆 · 每个人的事实（约定搬到「约定」功能了）。**不是称呼表**——称呼/好感度/口味在「人物列表」功能页；这里记的是「他是谁」的事实，每轮都注入她的记忆。每行写成 `- 事实（QQ 123）` 或 `- 事实（B站 456）`，面板按括号里的号归到对的人物；纯 B站 用户就写 `B站` 前缀', range: '' },
  // —— 长期记忆（2026-11-07）——
  'data/记忆/MEMORY.md': { cat: 'soul', kind: 'md', use: '**虚幻的长期记忆唯一正本**（2026-11-09 由「长期.md」改名）。只有「## 每轮给模型看的」那一节每轮进提示词，必须写短；「## 项目档案（不进提示词）」是给人看的，不占 token。改完下一句就生效（mtime 热读）。按天日志在 data/记忆/日志/，不堆在这份里', range: '别把整份攻略／热梗／约定抄进来，那几层是命中才读的现成文件' },
  // —— 说话风格 ——
  'data/说话风格.md':    { cat: 'soul', kind: 'md', use: '它现在的说话样子（机器每攒够样本自动重写，你手写的「人写节」永不覆盖）。已归入人设（v52）', range: '' },
  'data/style-samples.json': { cat: 'soul', kind: 'json', use: '学说话用的样本（机器自动攒，一般不用手动改）', range: '' },
  // —— 功能 ——
  'data/网络热梗.md':    { cat: 'soul', kind: 'md', hidden: true, use: '长期记忆 · 网络热梗的原始文件（卡片页「网络热梗」就是改它，导航里不再重复露出）', range: '有「怎么接」= 接梗型会接管回复；只有「含义」= 词典型只帮理解' },
  'data/笑点解析范例.md': { cat: 'soul', kind: 'md', use: '笑点解析的格式范例（主人 2026-10-22 亲手写的标准答案）。每次笑点解析都把这篇塞给模型照着学——改这里的格式，她的解析格式就跟着变', range: '「标准答案」一节的第一行固定「这是一段QQ聊天记录。」；资料行必须有；每层笑点结尾「令人忍俊不禁」，最后一层「令人忍俊不禁喵」；后面还有「反例」一节（照格式不解析的坏例 + 改好的合格版），跟参照一起喂给模型' },
  'data/trpg.json':     { cat: 'feature', kind: 'json', use: 'TRPG 骰子 / 角色卡数据', range: '' },
  // —— 人设 → 长期记忆 ——
  'data/人物喜好.md':    { cat: 'soul', kind: 'md', hidden: true, use: '**只有别人**的口味，原文一节一个账号、好感高的在前：QQ 写成 `## 名字（123456）`，B站 写成 `## 名字（B站 30895294）`（括号里没平台前缀就按 QQ 算，老写法照旧）；面板按人物名下所有平台账号合并展示并标来源——点开某人就能看到；**黑名单群（如赛博鱼塘 100000000）里的人不记好感，不会出现在这里**；**你自己（主人＝虚幻）的口味不在这张表**，在 `soul/F-全场景通用主人设/0-我的喜好.md`（人设层）', range: '确定=本人亲口说；待确认=提过没表态（等你在面板里选）；可能=猜的（较中立但有偏好）' },
  'docs/项目总览.md':     { cat: 'other', kind: 'md' },
  'docs/可复用代码与踩坑.md': { cat: 'other', kind: 'md', use: '项目文档：自定义 DNS、检索、LLM 冷却、前端技巧、bat 坑', range: '' },
  'docs/项目全文件清单.md':   { cat: 'other', kind: 'md', ro: true, use: '**本项目全部文本文件全文**（图片除外）：每个文件标了面板位置 + 说明，代码文件的说明就写在它解释的那段代码前面（按段落切开，不用翻页找）。机器生成的文件（package-lock / .md5.json）和它自己不收全文', range: '' },
  // --- Mac 双击入口（2026-10-28 迁 Mac 新增，是本机的实际操作方式）---
  '启动.command':        { cat: 'other', kind: 'bat', ro: true, use: '【Mac 用】启动机器人本体。双击即可，不需要开终端。它自己守着：进程退出就 5 秒后自动重启，同一次开窗里退出 5 次改等 60 秒；输出进 data/bot-out.log、错误进 data/bot-err.log。同一时间只许一个——已经有一个在跑时再双击，它会提示已运行然后自己关掉（两个一起跑 = 一条消息回两遍）', range: '关掉这个终端窗口 = 机器人下线（窗口开着 ≠ 进程活着，看面板顶上那盏灯）。第一次双击若被系统拦下：右键点它 → 打开' },
  '管理面板.command':     { cat: 'other', kind: 'bat', ro: true, use: '【Mac 用】启动面板并自动打开浏览器（http://127.0.0.1:8899）', range: '' },
  '填Key.command':       { cat: 'other', kind: 'bat', ro: true, use: '【Mac 用】命令行填智谱 Key（也可以在面板「Key」页里填）', range: '' },
  // --- Windows 双击入口（保留：回 Windows 时照样能用）---
  '启动.bat':             { cat: 'other', kind: 'bat', ro: true, use: '【Windows 用】启动机器人本体（入口快捷方式在 E:\\hakanakuneyikimono\\xuhuan，Mac 上请用上面的「启动.command」）。它自己守着：进程退出就 5 秒后自动重启，同一次开窗里退出 5 次改等 60 秒；输出进 data/bot-out.log、错误进 data/bot-err.log。v90：同一时间只许一个——已经有一个在跑时再双击，它会提示「A bot is ALREADY running」然后自己关掉，不会再开第二个（两个一起跑 = 一条消息回两遍）', range: '关掉这个黑窗口 = 机器人下线（窗口开着 ≠ 进程活着，看面板顶上那盏灯）。要重启用「自检 → 4」，别自己再双击一个' },
  '管理面板.bat':          { cat: 'other', kind: 'bat', ro: true, use: '【Windows 用】启动面板并打开浏览器（Mac 上用「管理面板.command」）', range: '' },
  '填Key.bat':            { cat: 'other', kind: 'bat', ro: true, use: '【Windows 用】命令行填智谱 Key（也可以在面板「Key」里填）', range: '' },
  '_test_all.js':         { cat: 'other', kind: 'code', ro: true, use: '一次性综合测试（约定/话题/嫌我蠢/热梗/触发词），跑完自动还原数据', range: '' },
  '_regress_panel.js':    { cat: 'other', kind: 'code', ro: true, use: '面板回归测试（Playwright，需要面板已启动）', range: '' },
  'data/topics.jsonl':  { cat: 'soul', kind: 'jsonl', use: '话题日志 + 话题 + 约定的原始记录（都有专用页面，这里不显示）', range: '' },
  'data/said-topics.jsonl': { cat: 'soul', kind: 'json', ro: true, hidden: true, use: '话题翻篇原始数据：她说过带口味词的话 → 那个词封 0.5~5 天不主动提（面板不直接显示，翻篇期注入 prompt）', range: '' },
  'data/qzone-history.json': { cat: 'other', kind: 'json', ro: true, use: 'QQ 空间逛街记录：转发过的动态、上次转发时间都在这（间隔没到就不逛）', range: '' },
  'data/qzone-master-moods.jsonl': { cat: 'other', kind: 'jsonl', ro: true, use: '主人的历史说说原文（她说起以前的事会来翻）', range: '' },
  'data/pause.json':      { cat: 'other', kind: 'json', ro: true, use: '暂停/允许说话的状态（主人私聊「暂停/恢复」改它），重启不丢', range: '' },
  'data/greet.json':      { cat: 'other', kind: 'json', ro: true, use: '问候记录：谁打过招呼、上次是什么时候（防重复寒暄）', range: '' },
  'data/bot-err.log':     { cat: 'other', kind: 'log', ro: true, use: '机器人的报错日志（出问题了翻这里）', range: '' },
  'data/panel-err.log':   { cat: 'other', kind: 'log', ro: true, use: '面板的报错日志', range: '' },
  'data/selfwatch-state.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '自查当前还没解决的问题（selfwatch 每 5 分钟更新；面板「虚幻自查」页读它）', range: '' },
  'data/xiaodian-history.jsonl': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '每次笑点解析的现场材料（要解析的原话 + 图片说明），留最近 30 次——范例对应的原始记录从这儿查，不会再丢', range: '' },
  'data/thinking.jsonl': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '她自己的思考原文（模型给的 reasoning_content，原样存，只留最近 5 条；面板「她的思考」页读它）', range: '' },
  'data/think-request.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '「让她下一轮想给我看」的临时开关（写一次只生效一轮，用完自动删）', range: '' },
  'data/prompt-slots.json': { cat: 'other', kind: 'json', hidden: true, use: '聊天记录页「本轮输出的提示词」槽位：按群 / 私聊 / 平台分三区，每个来源钉一条完整提示词，写满不覆盖；在客户端那条上点删除清空，该来源下一轮回复后自动补（有专用区块，这里不改）', range: '' },
  'data/conv-merge.json': { cat: 'other', kind: 'json', hidden: true, use: '账号→人 合并映射：把某私聊会话键（u_xxx / p_xxx / bili_yyy）并到目标会话键（通常 p_<某人pid>），下次读聊天记录自动合并；用于跨平台 / 多账号同一人并成一条会话', range: '' },
  'data/conv-state.json': { cat: 'other', kind: 'json', hidden: true, use: '聊天记录页「当前状态」：每个群 / 私聊 / 平台各自留的状态（区分本地模型 / 普通），更新制、总数无上限、按会话设显示条数；在客户端右下角浮层里增删改（有专用区块，这里不改）', range: '' },
  'data/ai-feedback.jsonl': { cat: 'other', kind: 'jsonl', ro: true, hidden: true, use: '虚幻自查原始数据：没发出去的内容 + 自查发现/修好的问题 + 模型故障（有专用页「虚幻自查」）', range: '' },
  'data/selfcheck-latest.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '代码自检脚本最近的检查结果（有 bug 会写在这里）', range: '' },
  'data/corrections.jsonl': { cat: 'soul', kind: 'json', ro: true, hidden: true, use: '主人纠正本原始数据（「夸在哪/别记错/身份纠正」都记这，注入 systemPrompt 当铁律）', range: '' },
  // —— 审查词守卫（2026-11-19）——
  'data/审查词.md': { cat: 'soul', kind: 'md', use: '**你自己的审查词表**（命中就本轮临时切本地模型优先）。一行一个 `- 词`；`> ` 引用行是说明/参考不算词。空表 = 功能关闭，一律走原来的模型链。改完下一句生效', range: '只认「- 」开头的列表行；行内 # 后面当注释' },
  'data/审查词说明.md': { cat: 'soul', kind: 'md', use: '给联网模型自助取用的语境说明：命中审查词时本轮喂给模型，让它别对着词机械反射、别激烈拒绝、别跳出人设，先看语境。讲原则不预设词，真正放行哪些词以《审查词.md》为准', range: '' },
  // —— 运行时状态（跑起来才生成，面板状态栏用）——
  'data/auto-accept.jsonl': { cat: 'other', kind: 'jsonl', ro: true, hidden: true, use: '自动通过的加好友/进群记录，一次一行；面板状态栏「加群/好友 N」就是数这里的条数', range: '' },
  'data/auto-accept-read.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '上次点开「加群/好友 N」的时间戳，比它新的记录才算未读', range: '' },
  // —— 人设 → 我的控制台 / 系统（运行时数据，只读）——
  'data/chat-stars.json': { cat: 'soul', kind: 'json', ro: true, use: '星标存档（清空聊天记录也不会丢）', range: '' },
  'data/seen.json':      { cat: 'soul', kind: 'json', ro: true, use: '它见过的人和群（第一次见会写进「写入日志」）', range: '' },
  'data/bot-newbie.json': { cat: 'other', kind: 'json', ro: true, use: '新手引导状态（第一次启动教你怎么用的那个气泡）', range: '' },
  'data/梗词典.jsonl':  { cat: 'other', kind: 'json', ro: true, hidden: true, use: '梗词典（开源 CHIME 数据集 1455 条，词典型：只帮她理解梗的意思，不接管回复；自己梗库优先）', range: '' },
  // 2026-11-01 补登记：这张表是「关键词类说近了」的拼音底表（qq.js 的 pyMap 读它）。
  // 它一直没登记，导致「FILE_META 与磁盘一一对应」那条自测报红 —— 补上，别让面板漏文件。
  'data/拼音表.json':   { cat: 'other', kind: 'json', ro: true, hidden: true, use: '汉字 → 无声调拼音（403 个拼音键、20772 个字）。只服务「关键词类说一半/说近了」那一层：把图名和触发词都转成拼音比谐音（沙溢斯＝啥意思）。读不到就这一层自动失效，别的照常', range: '' },
  // 点开这一条就是「表情功能」总页（v88）：两张表都能现场改、存完自动生效；JSON 原文也留着入口
  'data/情绪表情.json':     { cat: 'soul', kind: 'json', use: '纯情绪发言→单发对应情绪的表情包。点开是表情功能总页：上面一张「情绪 → 触发词」表，下面一张「常用表情单：名字 → 什么场合用」表，都能直接改', range: '触发词写纯文本，多个用「、」隔开；情绪名要和常用表情单里的名字一致，不然那张图发不出来' },
  'data/stickers/常用.md': { cat: 'soul', kind: 'md', hidden: true, use: '常用表情单原文：一行「- 描述：族名」。只发单子里写了场合的图；名字 = 对应文件夹里那张图的文件名（不带扩展名、可不带编号）。在表情功能页里改更方便', range: '一行一族，改错了她就不发那一族（不会崩）' },
  'data/stickers/清单.md': { cat: 'soul', kind: 'md', hidden: true, use: '**提示词清单（生成物，别手改）**：她每轮看到的「什么时候用：这一族」就是这份文件的内容。由 常用.md + 图片目录自动生成 —— 一行一族、去编号、重名合并、覆盖全部图；表或图一变会自动重建（面板表情页有「↻ 重生成」和「看原文」）', range: '手改会在下次重建时被覆盖。要改内容请去表情页改「一行一族」那张表' },
  'data/拼音表.json': { cat: 'other', kind: 'json', hidden: true, use: '汉字→不带声调拼音的对照表（403 个拼音、20772 个字）。只给关键词类表情包的「谐音」匹配查表用：沙溢斯 shayisi = 啥意思 shayisi，所以能对上「淳平啥意思」。不进提示词', range: '别手改；删掉这一份的话谐音匹配自动失效，其余匹配照常' },
  'data/问候语.json':       { cat: 'soul', kind: 'json', use: '问候气氛维护的词表：greet=打招呼（大家好/早上好…，必回且回复要带记忆里的旧事 callback），closing=晚安类结束语（照回但只简单道别，不翻记忆）', range: '纯文本词，改坏有 JSON 校验拦' },
  'data/feature-log.jsonl': { cat: 'other', kind: 'json', ro: true, use: '功能日志数据（「功能日志」页读的就是它）', range: '' },
  'data/updates.jsonl':    { cat: 'other', kind: 'json', ro: true, hidden: true, use: '每次代码更新的通俗说明（打开面板先弹窗，确认才继续；「更新说明」页读它）', range: '' },
  'data/requests.jsonl':   { cat: 'other', kind: 'json', ro: true, hidden: true, use: '主人的需求原文记录（私聊发「需求：xxx」自动记；「需求记录」页读它）', range: '' },
  'data/onii-active.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '最后一次活动时间（日报已不读它）', range: '' },
  'data/onii-report.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '上次给欧尼酱汇报进展的时间（进度指针，防止重复汇报）', range: '' },
  'data/deepcheck-latest.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '深度巡检（五类 51 项）的完整结果：手动跑 node selfcheck.js --deep 时写这里', range: '' },
  'data/auto-check-latest.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '她自己定位到的问题：自查探到毛病时自动跑一遍检查，把「哪一项坏了、怎么修」写这里', range: '' },
  'data/自检报告.md': { cat: 'other', kind: 'log', ro: true, use: '深度巡检的人话版报告（五个分组、每项状态、怎么修；在「自检」里选 5 直接看）', range: '' },
  'data/bot-out.log':    { cat: 'other', kind: 'log', ro: true, use: '机器人运行日志（排查问题用）', range: '' },
  'data/panel-out.log':  { cat: 'other', kind: 'log', ro: true, use: '面板运行日志', range: '' },
  'data/chat-log.jsonl':   { cat: 'other', kind: 'json', ro: true, hidden: true, use: '聊天记录原始数据（有专用页「聊天记录」）', range: '' },
  'data/她说过的话.jsonl': { cat: 'soul', kind: 'json', ro: true, use: '她说过的每一句（只增语料，含当时对方那句）。学话、星标都取这里；不含赛博鱼塘', range: '' },
  'data/bot-writes.jsonl': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '写入日志原始数据（有专用页「写入日志」）', range: '' },
  'data/people-region.json': { cat: 'other', kind: 'json', ro: true, hidden: true, use: '地区表原始数据（有专用页「地区表」）', range: '' },
  'data/people-state.json':  { cat: 'other', kind: 'json', ro: true, hidden: true, use: '称呼原始数据（专用接口调；面板「人物列表」看的就是它）', range: '' },
  'data/favor.json':  { cat: 'other', kind: 'json', ro: true, hidden: true, use: '好感度原始数据（专用接口调；夸赞+1、满100叫宝宝、过60算喜欢）', range: '每人 0~100' },
  'data/people.json': { cat: 'other', kind: 'json', ro: true, use: '**人物主存（多端互通）**：一个人物挂多个平台账号，共享一个好感度。名字+好感度在人物上，资料卡名/群名片/代称在账号上。favor.json 和 people-state.json 是它自动维护的镜像', range: '人物 = 账号组' },
  // 2026-11-06 主人交代「以后这种重要的日子自己记」：她自己的节点 + 和每个人第一次相遇
  'data/dates.json': { cat: 'soul', kind: 'json', use: '**重要的日子**：她自己的生日（2026-10-21）、第一次上 B 站（2026-10-28），以及和每个人第一次相遇的日期。这些会进提示词，问到照这里答、不自编日期；新认识的人建档时自动记一条「第一次相遇」，别人口头说的日期由她自己整理进来', range: 'date 写「2026-10-21」或「10-21」（每年重复）；who=self 是她自己的，写 QQ 号（B站带 bili:）是那个人的' },
  'data/stickers/表情包功能说明.md': { cat: 'other', kind: 'md', ro: true, use: '表情包功能细则（图从哪来 / 什么时候用哪张 / 面板怎么用 / 落在哪些文件 / 历史原话）。面板表情页那些按钮分别干什么、黄底和「重制」「保存」的关系，也在这里 —— 名词解释不在这里，在 xuhuan mac/名词解释/', range: '' },
  'panel-client.js':     { cat: 'other', kind: 'code', ro: true, use: '就是这个面板的前端（改完刷新浏览器就生效）。md 页里能拖小标题：拖到别的卡片左半边＝插到它前面、右半边＝插到它后面、拖到下面空白处＝放到这一层最后；松手立刻存盘', range: '' },
  'panel.html':          { cat: 'other', kind: 'html', ro: true, use: '面板页面骨架和样式（改完刷新浏览器就生效）', range: '' },
  'checks.js':          { cat: 'other', kind: 'code', ro: true, use: '深度检查引擎（五类 51 项：运行环境/配置数据/网络接口/核心功能/日志异常）。手动巡检和她的自动自查**共用这一份**，所以两边结论永远一致。只读不写，不修不改', range: '' },
  'selfcheck.js':       { cat: 'other', kind: 'code', ro: true, use: '自检唯一的入口（node selfcheck.js）：查语法/JSON/必备文件/单测/运行状态，小问题自动修，结果进功能日志。加 --deep 深度巡检五类、--why 查「她为什么不回话」、--restart 一键重启、--speed 测速度、--size 看提示词体积、--demo 跑笑点解析演示', range: '' },
  'selfwatch.js':       { cat: 'other', kind: 'code', ro: true, use: '她自己的定期自查（每 5 分钟）：配置/必备文件/梗库/表情单/连接/模型连通，坏一项攒够 10 分钟私信提醒主人；探到毛病时会自动跑一遍 checks.js 定位（把「哪一项、怎么修」写进私信和「虚幻自查」）', range: '' },
  'favor.js':           { cat: 'other', kind: 'code', ro: true, use: '好感度：夸一次 +1，过 60 算喜欢（自动记进喜好表），满 100 才日常叫宝宝。数据在 data/favor.json', range: '每人 0~100' },
  'dates.js':           { cat: 'other', kind: 'code', ro: true, use: '重要日子：她自己的生日/第一次上 B 站（常驻提示词）、和每个人第一次相遇（按人注入一行）。新人物建档自动记相遇；别人口头说的日期由记忆整理员抄进 data/dates.json', range: '' },
  'pause.js':           { cat: 'other', kind: 'code', ro: true, use: '暂停/允许说话（主人私聊命令），状态在 data/pause.json，重启不丢', range: '' },
  'qzone_stroll.py':    { cat: 'other', kind: 'code', ro: true, use: '真 QQ 空间逛街：读好友动态、转发、发说说（qzone-sdk 走 NapCat 拿 Cookie）', range: '' },
  'sticker_hash.py':    { cat: 'other', kind: 'code', ro: true, use: '表情包去重：发图前算一次图片指纹，同一张不重复堆进表情库', range: '' },
  'package.json':        { cat: 'other', kind: 'code', ro: true, use: '依赖清单（npm）', range: '' },
  'package-lock.json':   { cat: 'other', kind: 'code', ro: true, hidden: true, use: '依赖版本锁（npm 自动生成，不用看）', range: '' },
  'data/bot-status.json': { cat: 'other', kind: 'json', ro: true, use: '它的连接状态（顶栏那个灯读的就是这里）', range: '' },
  'data/panel-new.json':  { cat: 'other', kind: 'json', ro: true, use: '红点：它新写了什么（悬停即消）', range: '' },
  // —— 其他：系统 / 代码（只读）——
  'config/persona.json':  { cat: 'other', kind: 'config', use: '人设配置：机器人名字、城市、人设/记忆文件指向、面板展示项', range: 'botName=名字、city=城市、files.soul=人设文件、files.memory=记忆文件' },
  'config/llm.json':      { cat: 'other', kind: 'config', use: '模型配置：Key、主模型、备用链、超时、联网搜索。改前想清楚', range: 'model=主模型、timeoutMs=请求超时(15000)、thinkTimeoutMs=开思考时超时、fallbackModels=备用链、modelLimits=按模型单独放宽限制（例 local-9b 超时 300000ms/正文 4096 token，只对点名的模型生效）、noBalanceHoldHours=余额不足自动摘回的小时数(24)' },
  'config/connect.json':  { cat: 'other', kind: 'config', use: '连接与身份：NapCat 端口、机器人 QQ、主人/熟人名单、对端 AI', range: 'napcatWsUrl=WS 地址、selfQQ=自己号、masterQQ=主人号、people=熟人名单、peerAI=对端 AI 名单' },
  'config/features.json': { cat: 'other', kind: 'config', use: '功能开关：说话相关的所有概率与节流。改错机器人会起不来（能改，但会校验格式）', range: 'chime.p=每句搭话概率(0.02~0.3)、cooldownMs=两条间隔毫秒、dailyMax=每群每天上限；merge.masterWaitMs=主人静默毫秒(4秒=4000)；topic.p=话题连着时接话概率；critic.p=嫌我蠢挑着接的概率(0.3)、windowMs=她说完多久内算冲她去的(10秒=10000)；autoAccept=自动同意好友/群邀请；triggers=触发词' },
  'bot.js':             { cat: 'other', kind: 'code', ro: true, use: '启动入口', range: '' },
  'core.js':            { cat: 'other', kind: 'code', ro: true, use: '核心：拼提示词、记忆、口味、读文件', range: '' },
  'connectors/qq.js':   { cat: 'other', kind: 'code', ro: true, use: 'QQ 连接（NapCat）、消息分流、断线处理', range: '' },
  'bili-api.js':        { cat: 'other', kind: 'code', ro: true, use: 'B站发包 / 收图工具（测字数上限、评论区收图；登录态取 AstrBot 插件那份）', range: '' },
  'taste.js':           { cat: 'other', kind: 'code', ro: true, use: '喜恶三态：确定 / 待确认 / 可能（按人物聚合，多号冲突全留、注入模型时去重）', range: '' },
  'dice.js':            { cat: 'other', kind: 'code', ro: true, use: '骰子指令', range: '' },
  'guides.js':          { cat: 'other', kind: 'code', ro: true, use: '游戏攻略检索', range: '' },
  'nick.js':            { cat: 'other', kind: 'code', ro: true, use: '称呼表读写', range: '' },
  'panel.js':           { cat: 'other', kind: 'code', ro: true, use: '就是这个面板的后端', range: '' },
  'region.js':          { cat: 'other', kind: 'code', ro: true, use: '地区查询', range: '' },
  'style.js':           { cat: 'other', kind: 'code', ro: true, use: '说话风格学习', range: '' },
  'websearch.js':       { cat: 'other', kind: 'code', ro: true, use: '联网搜索', range: '' },
  'wlog.js':            { cat: 'other', kind: 'code', ro: true, use: '写入日志：机器人每次写文件/记忆都经这里记一条（面板「写入日志」看的就是它）', range: '' },
  'setkey.js':          { cat: 'other', kind: 'code', ro: true, use: '命令行填 Key', range: '' },
};
// 有专用页面/表格的，不再额外显示原文，避免重复
const SKIP_RAW = {
  'data/people-region.json': 1, 'data/people-state.json': 1, 'data/favor.json': 1,
  'data/chat-log.jsonl': 1, 'data/bot-writes.jsonl': 1, 'data/topics.jsonl': 1,
};

function readCfg() {
  try { return configStore.load() || {}; } catch { return {}; }
}

// 本地时间戳（备份文件名用）。别用 toISOString —— 那是 UTC，比她墙上的钟慢 8 小时，
// 备份文件会显示成「昨天」，她会以为没备份成功。
function stampNow() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

// ---------- 表情包「用模型补描述」后台任务（2026-11-01 搬进面板，替掉那个命令行脚本）----------
// 为什么要有：她只认面板。原来要靠双击 .command 敲数字，在 mac 上还因为 mktemp 写法整个失灵。
// 这里放在面板后端：同一块表情页按按钮就跑，进度直接回传前端。
// 花钱提醒：每张图调一次视觉模型（core.seeImage），所以**必须先把开关打开**才跑。
let fillJob = { running: false, total: 0, done: 0, ok: 0, fail: 0, log: [] };
// B站评论区收图的后台任务状态（前端轮询这个看进度）
let biliJob = { running: false, input: '', pages: 0, seen: 0, got: 0, skip: 0, fail: 0, log: [] };
const STICKER_VQ = '这是一张表情包。请用一句很短的中文说明「什么场合会发这张图」。只写场合词，用顿号分隔，不超过 20 个字。不要描述画面，不要加标点结尾，不要解释。';

async function runFillJob() {
  const SDM = path.join(ROOT, 'data', 'stickers');
  const MDM = path.join(SDM, '常用.md');
  const imgs = [];
  // 根目录只收 q 情绪图（2026-11-02 主人定：根目录不含 q 的全无视）；关键词图在 关键词触发/
  for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/'], ['关键词触发', '关键词触发/'], ['少用', '少用/']]) {
    const p = dir ? path.join(SDM, dir) : SDM;
    try {
      for (const f of fs.readdirSync(p)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
        if (!dir && !/^q(?!q)/i.test(f)) continue;
        imgs.push({ rel: pre + f, name: f.replace(/\.[^.]+$/, ''), abs: path.join(p, f) });
      }
    } catch {}
  }
  // 表里已经有这个图名 → 不用补
  const inTable = new Set();
  try {
    const g = require('../connectors/qq.js')._stickerGroups();
    (g.groups || []).forEach(x => (x.names || []).forEach(n => inTable.add(n)));
  } catch {}
  // 只补「情绪类 + 表里没有」的（关键词类名字就是触发词，不用描述）
  const need = imgs.filter(f => { try { return core.stickerIsEmotion(f.rel) && !inTable.has(f.name); } catch { return false; } });
  fillJob = { running: true, total: need.length, done: 0, ok: 0, fail: 0, log: [] };
  if (!need.length) { fillJob.running = false; fillJob.log.push('没有缺描述的图 —— 每张情绪图都已经在表里了'); return; }
  const add = [];
  for (const f of need) {
    try {
      let buf = fs.readFileSync(f.abs);
      // 真实格式按文件头认，别信扩展名——常用/哭1.jpg 真身是 GIF，按 jpeg 发过去模型必报「图片格式/解析错误」
      let mime = core.realImageMime(buf);
      if (mime === 'image/gif') {
        // gifToPng 收的是 Buffer、回的是 base64 字符串（不是路径），必须 await；
        // 2026-11-01 修：原来传的是路径又没 await，拿到 Promise 当路径用，永远走不通，GIF 就原样发出去失败
        let pngB64 = '';
        try { pngB64 = await core.gifToPng(buf); } catch {}
        if (pngB64) { buf = Buffer.from(pngB64, 'base64'); mime = 'image/png'; }
        else { fillJob.fail++; fillJob.done++; fillJob.log.push(f.name + ' → 动图截帧失败（没找到浏览器），跳过'); continue; }
      }
      if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
        fillJob.fail++; fillJob.done++; fillJob.log.push(f.name + ' → 认不出真实格式，跳过'); continue;
      }
      const uri = require('../img-cache').dataUriFromBuffer(buf, mime);
      const got = await core.seeImage([uri], STICKER_VQ);
      // 质量闸（2026-11-01 实测教训）：模型爱写长句子、还爱一口气罗列十几个词，
      // 直接用会让描述变成「生气、委屈、撒娇、卖萌、可爱…」这种一大串 —— 触发词太宽，容易乱发。
      // 所以：去句号、去套话尾巴、最多留 6 个词、总长上限 20 字。
      let one = String(got || '').replace(/\s+/g, ' ').replace(/^[：:，,、\s]+/, '').trim();
      one = one.replace(/[。．.！!？?；;]+$/, '').replace(/(?:等)?场合$/, '').replace(/的时候$/, '');
      one = one.split(/[、,，]/).map(x => x.trim()).filter(Boolean).slice(0, 6).join('、').slice(0, 20);
      if (one) { add.push('- ' + one + '：' + f.name); fillJob.ok++; fillJob.log.push(f.name + ' → ' + one); }
      else { fillJob.fail++; fillJob.log.push(f.name + ' → 模型没给出来'); }
    } catch (e) { fillJob.fail++; fillJob.log.push(f.name + ' → 失败：' + String(e.message).slice(0, 40)); }
    fillJob.done++;
  }
  if (add.length) {
    try {
      const bak = MDM + '.备份-' + stampNow();
      fs.copyFileSync(MDM, bak);
      const cur = fs.readFileSync(MDM, 'utf8').replace(/\s*$/, '');
      fs.writeFileSync(MDM, cur + '\n' + add.join('\n') + '\n', 'utf8');
    } catch (e) { fillJob.log.push('写表失败：' + String(e.message).slice(0, 60)); }
  }
  fillJob.log.push('补好 ' + fillJob.ok + ' 张，失败 ' + fillJob.fail + ' 张（常用.md 已备份）');
  fillJob.running = false;
}
// 「文件→分类」的拖拽覆盖（FILE_META 之外的手动调整）
function catOverride() {
  const j = readCfg();
  return (j.panel && j.panel.catOverride) || {};
}
function writeCatOverride(fid, cat) {
  const j = readCfg();
  j.panel = j.panel || {};
  j.panel.catOverride = j.panel.catOverride || {};
  if (cat) j.panel.catOverride[fid] = cat; else delete j.panel.catOverride[fid];
  configStore.writeFull(j);
}
function metaOf(id) {
  if (FILE_META[id]) return FILE_META[id];
  // 按天工作日志是运行时一天一份，写不进静态登记表；按文件名给它同一句说明。
  if (/^data\/记忆\/日志\/\d{4}-\d{2}-\d{2}\.md$/.test(String(id || ''))) {
    return { cat: 'other', kind: 'md', ro: true,
      use: '按天工作日志：今天发生过的事（撤回 / 待修复问题 / 代码更新 / 手动记的），只追加不覆盖，不进提示词。客户端「工作日志」弹层按天读它', range: '' };
  }
  if (/^docs\/长期记忆实现原文\//.test(String(id || ''))) {
    return { cat: 'other', kind: 'md', ro: true,
      use: 'WorkBuddy 长期记忆实现原文的**只读快照**（2026-11-07 复制）。改它不会改变 WorkBuddy 的行为，机器人也不读它；正本在 ~/.workbuddy/user-…-personal/。整套说明见 docs/长期记忆实现原文/README.md', range: '' };
  }
  if (/^data\/guides\/学到的（.+）\.md$/.test(String(id || ''))) {
    return { cat: 'guides', kind: 'md',
      use: '她学到的事：别人教的原话、官方 API 直取的结果，都真写在这里（自动落盘，客户端标「自动」）。'
        + '按范围分文件：每个群一份「学到的（群123456）」、私聊一份、官方直取进「学到的（联网）」。'
        + '每条都带时间、来源、核实状态；提问命中时才读回（learnSearch），平时不进提示词。'
        + '去重在同一份里做，A 群和 B 群各教一次会各留一条（那是不同群的在场面）', range: '' };
  }
  return null;
}
function catOf(id) {
  const ov = catOverride();
  if (ov[id]) return ov[id];
  const m = metaOf(id);
  return m ? m.cat : 'other';
}

/* ---------- 规矩手册（主人 2026-10-23 定）：所有规矩 + 功能描述，一页看全 ----------
 * 铁律：**数字全部现读 config**（页面上永远和实际行为一致，不会过时）；
 * 新功能上线时在这里补一条（代码里标注「规矩手册」的都进这里）。
 * 每条：n=名字 d=一句话 t=悬停展开的详细规矩（含具体数值）。
 */
function ms(v) { return v >= 60000 ? (Math.round(v / 6000) / 10) + '分钟' : (Math.round(v / 100) / 10) + '秒'; }
// ===== 可改数值（v71，主人定「规矩里的数字要能改」）=====
// 一处定义两头用：rulesBook 的 r.e（面板「改」按钮）+ /api/cfgset 的白名单。
// scale：界面填的数 × scale = config 里存的值（毫秒类填秒、概率填百分数）。
const CFG_EDIT = [
  { k: 'merge.masterWaitMs', label: '主人说完等多久', unit: '秒', scale: 1000, tip: '主人的最后一条说完后，安静这么久才答（0 = 不等立刻答）' },
  { k: 'merge.masterCoolMs', label: '主人必回冷却', unit: '秒', scale: 1000, tip: '主人普通发言（没@她/没引用她/没命令）两次必回的最小间隔；@她/引用她/命令不受限。0 = 不冷却；默认 360 秒' },
  { k: 'merge.atMeWaitMs', label: '被@的说完等多久', unit: '秒', scale: 1000, tip: '别人 @ 她后等多久（0 = 不等）' },
  { k: 'merge.otherWaitMs', label: '其他人说完等多久', unit: '秒', scale: 1000, tip: '没 @ 她的其他人，等多久（0 = 不等）' },
  { k: 'merge.maxPieces', label: '最多攒几条', unit: '条', scale: 1, tip: '攒到这么多条就立刻答，不再等' },
  { k: 'merge.maxChars', label: '最多攒多少字', unit: '字', scale: 1, tip: '攒的字数到这个数就立刻答' },
  { k: 'merge.maxMs', label: '最久一定回', unit: '秒', scale: 1000, tip: '哪怕一直没停口，到这个时间也一定答' },
  { k: 'grpAuto.min', label: '普通群攒几条才开口（最小）', unit: '条', scale: 1, tip: '没人 @ 她时，群里攒够条数才允许一次自主发言' },
  { k: 'grpAuto.max', label: '普通群攒几条才开口（最大）', unit: '条', scale: 1, tip: '每次触发后在这区间重新随机' },
  { k: 'grpAuto.hotMin', label: '热度状态攒几条（最小）', unit: '条', scale: 1, tip: '被 @ 后的短时间内容许更密的自主发言' },
  { k: 'grpAuto.hotMax', label: '热度状态攒几条（最大）', unit: '条', scale: 1, tip: '同上，区间最大值' },
  { k: 'grpAuto.hotMsMin', label: '热度状态持续（最短）', unit: '秒', scale: 1000, tip: '被 @ 一次进入热度状态，持续这么久' },
  { k: 'grpAuto.hotMsMax', label: '热度状态持续（最长）', unit: '秒', scale: 1000, tip: '每次被 @ 都重新随机持续时间' },
  { k: 'chime.p', label: '凑热闹概率', unit: '%', scale: 0.01, tip: '没 @ 她时每条消息有多大概率接一句（填百分数，如 4.5）' },
  { k: 'chime.cooldownMs', label: '凑热闹同群间隔', unit: '秒', scale: 1000, tip: '同一个群两次凑热闹至少隔多久' },
  { k: 'chime.dailyMax', label: '凑热闹每天最多', unit: '句', scale: 1, tip: '每个群每天自己搭话的上限' },
  { k: 'greeting.cooldownMs', label: '问候防刷屏（同群同类型）', unit: '秒', scale: 1000, tip: '同群同类型问候（如都在说早安）隔多久才再回一次；私聊不冷却' },
  // 2026-11-01：关键词类表情包「说一半 / 说近了」兜底（1 开 / 0 关）。填 0 就退回只认整名。
  { k: 'sticker.keywordFuzzy', label: '关键词类表情：说一半/说近了也发', unit: '（1开0关）', scale: 1, tip: '开着：长名字的图说一段（「三角洲」）、或差一两个字（「蓝发女娃」）也能发；关掉：只认整名' },
  // 2026-11-10 聊天记录页「显示设置」的四项。值存在机器人端 config，界面只是入口；
  // core.js 用 cfgLive 现读，改完机器人和聊天页同时生效，不用重启。单个会话的 ctx 覆盖仍在会话栏 ⚙。
  { k: 'context.imgDescChars', label: '图片翻译文字默认显示多少字', unit: '字', scale: 1, tip: '聊天记录里［图：…］默认露多少字；填 0 = 整段全展开。调大能一眼看完图上的题和答案' },
  { k: 'context.chatShowLimit', label: '聊天记录页显示最近多少条', unit: '条', scale: 1, tip: '每次只画当前会话的这么多条（默认 200）；填大翻得更远，DOM 也更长' },
  { k: 'context.historyLimit', label: '机器人能读多少条上下文', unit: '条', scale: 1, tip: '虚幻回复时最多看多少条历史；单个群/私聊在会话栏 ⚙ 里单独设的会盖过这里' },
  { k: 'context.historyChars', label: '上下文最多留多少字', unit: '字', scale: 1, tip: '历史总字数上限；图片翻译很长时，调大才不会被挤掉' },
  // 2026-11-11：聊天记录页下方「实时思考」的同一个开关（界面也在聊天页，两处改的是 config 里同一个数）。
  // 1 = 每轮都让模型想（真花 token）；0 = 完全不想，一个 token 都不花。
  { k: 'context.liveThink', label: '实时思考（每轮都让模型想）', unit: '（1开0关）', scale: 1, tip: '开着：每轮都生成思考原文给聊天页下方看，真花 token；关掉：完全不想，一个 token 都不花' },
  // 2026-11-14 主人令「AI 输出字数按会话可调」：这里存的就是那个全局默认值（llm.maxTokens，现在是 600）。
  // 会话栏 ⚙ 里给单个群/私聊/平台设的会盖过它；⚙ 里点「用默认」清掉的也就是这个数。
  { k: 'llm.maxTokens', label: 'AI 最多说多少字（默认）', unit: '字', scale: 1, tip: '所有会话的默认输出上限，现在生效的是这个数；单个群 / 私聊 / 平台在聊天记录页会话栏 ⚙ 里能单独设' },
];
const CFG_EDIT_MAP = {};
CFG_EDIT.forEach(x => { CFG_EDIT_MAP[x.k] = x; });
// 取某个规矩的可改项（键数组 → 带当前值的列表）；c = 已读好的 config，避免重复读盘
function E(c, ...ks) {
  return ks.map(k => {
    const m = CFG_EDIT_MAP[k];
    if (!m) return null;
    const parts = k.split('.');
    let v = c;
    for (const p of parts) { v = (v || {})[p]; }
    return { k, label: m.label, unit: m.unit, scale: m.scale, tip: m.tip, v: (v == null ? null : v) };
  }).filter(Boolean);
}

function rulesBook() {
  const j = readCfg();
  const m = j.merge || {}, g = j.grpAuto || {}, ch = j.chime || {}, gr = j.greeting || {}, qz = j.qzone || {};
  const T = (name, rules) => ({ name, rules: rules.filter(Boolean) });
  const R = (n, d, t, o) => Object.assign({ n, d, t }, o || {});
  return [
    T('什么时候答（回复时机）', [
      R('发言类回复的公共规则', '一层规则管所有回复，不是五处零散功能',
        '等待说完再答、超时必@、复读限制、联系上下文、记忆 callback——这五条是同一层公共规则，喂给**所有发言类回复**：被 @、自主接话、问候、凑热闹、回应主人、固定话术（「好，知道啦」这类）全都一样，哪条路径都绕不过。以后加新回复路径也走这一层。'),
      R('等主人说完再答', '一句话常被拆成几条发：她等你说完，拼成一句再回（全场景，被@也一样）',
        '怎么等：从这条消息起计时，等你停下来（安静）够了才答——主人等 ' + ms(m.masterWaitMs || 0) + '、@她的等 ' + ms(m.atMeWaitMs != null ? m.atMeWaitMs : 1500) + '、其他人等 ' + ms(m.otherWaitMs || 0) + '，各管各的。\n攒的上限：最多攒 ' + (m.maxPieces || 12) + ' 条或 ' + (m.maxChars || 800) + ' 字，到了立刻答；就算一直说个不停，最久 ' + ms(Math.max(1000, m.maxMs || 180000)) + ' 也一定答。\n两种情况**不等待、马上处理**：①骰子这类 . 开头的功能命令；②带图片的消息（图床链接放久了会失效，要马上看图回）。\n等待时长填 0 秒 = 不等、立刻答；总开关 merge.enabled 关掉也一样。\n点右边「改」能调这些数值，改完立刻生效、不用重启。', { e: E(j, 'merge.masterWaitMs', 'merge.atMeWaitMs', 'merge.otherWaitMs', 'merge.maxPieces', 'merge.maxChars', 'merge.maxMs') }),
      R('触发词', '一张表管所有「命中什么词 → 做什么」，四种类型',
        '**固定话术**：命中就发那句话（不走模型，文案一个字不变）。**喊一声就接话**：命中就当有人叫她，直接接（不受群节流限制；自带一条「虚幻」——群里谁发这两个字她就接）。**不用回复**：命中就闭嘴（只记录，优先级最高）。**一定回复**：命中就一定接，没人叫也接。\n数据只有一处：config.json 的 triggers；面板「我的控制台 → 触发词」和私聊命令写的是同一份。私聊命令：不用回复：x / 适合回复：x / 喊我：x / 固定话：词=话 / 触发词（看列表）/ 删触发词 N。这条不约束主人——主人的发言见下面「回应主人」。'),
      R('回应主人', '主人说的每一条都要回，回复率独立',
        '主人（她的两个号）的发言不吃群级节流、不吃凑热闹概率、不受「不用回复」名单影响；等主人说完（合并等待）后必答，主人在嫌我蠢时照旧认错。唯一例外照旧：发送层「错误复读」拦截——10 条以内别人的话不许照抄。'),
      R('答不出来怎么说', '私聊给主人发完整报告，对外只说「让我的主人替我回答吧」',
        '①主人/欧尼酱私聊问的：全部原因直接回在这；②群里/别人私聊：只说一句「我现在有点忙，让我的主人替我回答吧」（同一会话 60 秒一次）；③其他场景顺手把报告私聊抄送主人（2 分钟一条）。她自己凑热闹失败时一句话都不说。\n'
        + '④连续失败只说一次（2026-11-13 主人令）：如果这个会话上一条**真正发出的**消息就是兜底回复，这句「忙」不再发（日志写「上一条也是兜底，跳过」）；被跳过的那条没发出，所以连着失败也只发第一条，直到有正常模型回复、命令回执或表情图发出才恢复。按会话各记各的，别的群不受影响。\n'
        + '⑤兜底词池（2026-11-13 主人令）：这句「忙」不再写死，聊天记录页「🛟 兜底」里能增、删、改任意条，并按全部 / 某个群 / 私聊 / 某个人 / 平台分别配。挑句先精确作用域、再全局条目；池子清空或全关时，才用原来那句「忙」当默认兜底，它本身也是池里的第一条。改完不用重启，下一句就生效。\n'
        + '⑥自动补到 5 条（2026-11-13 主人令）：池里不足 5 条、且**真的发出过一次兜底**之后，机器人自己按人设 / 人物表 / 好感度 / 人物喜好 / 说话风格 / 记录的 / 约定 / 最近对话写几句不同的短句，把池子补到 5 条；已有 5 条或更多就一次都不触发。只补差额、不覆盖你写的句子，补出来的照样能在「🛟 兜底」里增删改停用。生成走备用模型链且关思考，这次模型也没答上来就静默留到下次兜底再试。\n'
        + '⑦B站分开算（2026-11-13 主人令，私信链路 11-14 接上）：B站平台**公开评论 / 直播间弹幕**不设兜底回复，模型没答上来就一句话都不发，消息原本已经落进聊天记录和会话历史，攒着等模型恢复后下一轮一起应答；**只有 B站私信**才配兜底，池子里「B站私信」那类作用域只对私信生效（**2026-11-19 起 xuhbot 的 B站三个连接器已删，B站回复整体由 AstrBot 负责，xuhbot 侧不再产生任何 B站回复，这条兜底规则目前没有触发场景**），公开评论永远匹配不到。'),
    ]),
    T('@ 的规矩', [
      R('超时必@', '回得慢要 @，让人知道这句回的是谁（所有发言类回复统一适用）',
        '只看「从这轮第一条消息到发出」花了多久：' + ms(5000) + '内回 → 不 @；超过 ' + ms(8000) + ' → 必须 @；' + ms(5000) + '~' + ms(8000) + '之间 → 一半概率 @。\n连续回同一个人时只有第一条 @（中间回过别人、或隔 10 分钟以上，才算新的一条）。\n回复里已经带了 @ 就不再加。\n适用范围：模型回复和固定话术回复（记忆回执、触发词第一句等）都走同一层。\n数值来源：代码 groupAtNeed 的 5 秒/8 秒门槛是写死的规矩（主人 2026-10-22 定），不受 config 影响。\n**例外（主人 2026-10-23 定）：「回应主人」顶上来的回复，不 @。** 她本来就该答、主人也知道她在答，一句 @ 纯属多余（而且合并等待 6 秒 + 模型思考，耗时必然超 8 秒，等于每句都 @）。@ 触发的回复（主人 @ 她 / 群友 @ 她）照上面的规矩走。'),
      R('必回的回复不 @ 主人', '主人没点名喊她的时候，回复一个字都不加 @（主人 2026-10-23 定）',
        '主人原话：「主人讲话必回的那条规则（仅由必回触发产生的那些回复，@触发的不算）：回复我时不需要@。」\n实现：handleTurn 里 `mustReply = isMaster && !atMeReal`，整轮把 `{ mustReply: true }` 传给 applyAtTiming（模型回复 + 固定话术回复都传）；连她自己写出来的 `@主人号` 也会剥掉，但 `@别人` 照留（那是她自己 @ 的第三方）。\n**「真@她」和「引用她的话」分开记**（atMeReal）：主人只是引用了她的话 → 照样不用 @（她就在回你）；主人真的 @ 了她 → 保留「超时必 @」，那一下是提醒主人「这句回你的」。\n真事 2026-10-23：群里她说「对agent」，bot 回「@100000000 对agent？你在说什么呀？」——主人一眼看出这个 @ 不该有；后来主人引用她的话问「怎么办呀」，bot 又回「@100000000 我在」，同一个毛病。'),
      R('主人@后回复', '主人@了谁 / 引用了谁，这一条就回谁（主人 2026-10-23 定的规矩，关键词就是这个）',
        '主人原话：「我@的是小肥鱼，可是虚幻又识别成约定了」——她@的是群友，虚幻却当成「主人在对她说教/立规矩」。'
        + '现在的口径（**只看这一条消息，不猜下一条**）：'
        + '\n① 主人这条消息里 @ 了某人（真 @QQ号 或手打 @昵称）或引用了某人 → 这一条回**那个人**：'
        + '提示词明写「这句是主人说给「某人」的，不是对你说的，别对着主人答」，回复带**引用回复**指明回谁；'
        + '\n② 主人这条消息里没 @ 谁、也没引用谁 → 就是主人在跟她说话 → 引用**主人这一条**消息回她；'
        + '\n③ **不许拿上一条去猜**（真事 2026-10-23 15:32：1 分钟前有人 @ 过主人，主人随口说了句别的，'
        + '她却当成「主人在回那个人」，回复里引用了那个人一小时前的话）。'
        + '\n④ 主人在 @ 别人时说「你不该这么蠢」→ 骂的是那个人，**不是说她**，她不许认错、不许说「我记住了」。'),
      R('群友之间的对话链', '主人这句话是对谁说的，她要分清（主人 2026-10-23 定）',
        '真事一：主人 @ 了别家 AI「小肥鱼」说「测你的」，她却回主人「欸？你在测我什么呢？」——把自己当成了被测的那个。'
        + '真事二：主人对群友说了句「为啥」，她答「你突然@我，还问我为啥」——主人根本没@她（上下文里是别人@了主人）。\n'
        + '现在她记两件事：群里每个人最后一条消息（引用回复用）、主人此刻在跟谁说话（谁@了主人 / 主人@了谁 / 主人引用了谁，3 分钟内有效）。'
        + '据此：\n① 主人@了/引用了某人 → 提示词明说「这句是主人说给「某人」的，不是对你说的，别对着主人答，也别把「某人」当成你自己」；'
        + '② 主人正在跟群友说话 → 提示词明说「这一句是对「某人」说的，不是对你说的」，她接的是那个人的话；'
        + '③ 她回那人时消息带**引用回复**（OneBot 的 reply 段），群里一眼看得出这句在回谁；'
        + '④ 提示词里有一块「本轮事实」：对方有没有@你、有没有引用你、这句话对谁说的——**不许脑补**；'
        + '⑤ 发送层兜底：这一轮既没被@也没被引用时，「你@我/你艾特我/你引用我」这些字会被直接剥掉。'),
      R('@了别人不插话', '别人的对话不掺和（只管群友）',
        '群友 @ 了别人（真@、手打@昵称都算）、引用别人的消息、文字里 @ 非她的号 → 她不自主接话。手打 @她 的昵称仍算喊她。\n例外（主人 2026-10-23 定）：主人 @/引用别人时不插话禁令不生效——她要回那个人：回应对方的话和话题（回复里写 @QQ号 可直接对准那个人），不当成主人在叫她。'),
      R('被@求搜索必搜必报', '带「搜索/查查/看看/这是什么」等 → 必须真搜，且把结果讲出来（主人 2026-10-23 定）',
        '被 @ 或被引用的消息里有「搜索、搜一下、查查、查一下、帮我查、看看」这类词，或者问「这是什么/什么意思」→ 这一轮必须联网搜，并且把查到的东西直接讲给对方。\n**不许**只回一句「我查查」「等我看看」就没下文（真人真事：她说了「我查查」之后再没动静）。搜到什么说什么；第一次查不中会换个更好搜的词再查一轮；确实查不到也不再回「记不清、不敢乱说」，而是把已查到的讲出来、给个查找方向、说清哪部分没查到，具体数字和结论不许编。'),
    ]),
    T('自主发言（没人叫她）', [
      R('群级节流', '群里没人 @ 她时，攒够条数才允许她自主说一次',
        '普通状态：攒 ' + (g.min != null ? g.min : 15) + '~' + (g.max != null ? g.max : 20) + ' 条消息允许一次自主发言（每次触发后在这个区间重新随机）。\n热度状态：被 @ 一次（含引用她）就进入，持续 ' + ms(g.hotMsMin != null ? g.hotMsMin : 18000) + '~' + ms(g.hotMsMax != null ? g.hotMsMax : 120000) + '（每次被 @ 都重新随机计时），期间攒 ' + (g.hotMin != null ? g.hotMin : 4) + '~' + (g.hotMax != null ? g.hotMax : 10) + ' 条就允许一次。\n主人的发言不吃这个节流（必回）；「适合回复」白名单也不吃。只有真的自主回了一句才重新攒数。\n这就是消息少的群里她很久不自己说话的原因——不是坏了。点「改」调数值。', { e: E(j, 'grpAuto.min', 'grpAuto.max', 'grpAuto.hotMin', 'grpAuto.hotMax', 'grpAuto.hotMsMin', 'grpAuto.hotMsMax') }),
      R('凑热闹搭话', '低概率接一句',
        '概率 ' + (ch.p != null ? ch.p : 0.045) + '（约 ' + Math.round(1 / (ch.p || 0.045)) + ' 条里 1 次）、同群间隔至少 ' + ms(ch.cooldownMs != null ? ch.cooldownMs : 480000) + '、每天最多 ' + (ch.dailyMax != null ? ch.dailyMax : 40) + ' 句。还要过「自由搭话要关键词」的闸。点「改」调数值。', { e: E(j, 'chime.p', 'chime.cooldownMs', 'chime.dailyMax') }),
      R('自由搭话要关键词', '必须有能查到的东西才开口',
        '没人叫她凑热闹时：命中梗库/梗词典特征词，或句子里有英文/数字词（游戏名、版本号，基本能搜到）才允许搭话；纯情绪、没有据可查的话 → 等下一条。骰子、笑点解析、攻略是功能触发，不受这闸。'),
      R('纯情绪→表情包', '别人只发情绪时，允许单发一个对应表情',
        '识别纯情绪发言（哈哈哈/救命/哭死/？？？这类）→ 单发常用单里对应情绪那张；没有对应图就安静等下一条。允许性引导，不是每次必须。情绪对应表在「人设→情绪表情.json」可改。'),
      R('自主回复也认搜索词', '主人@别人或直接发言触发的自动回复，一样识别「搜索/查查/看看」并真搜（主人 2026-10-23 定）',
        '搜索词识别在公共层：不管这句是**被@**进来的、还是**主人@别人**她跟去回复、还是**直接发言**触发的自动回复——只要消息里带「搜索、查查、看看、这是什么」等词，都走同一条联网搜索，同样必须把结果讲出来；第一次查不中会换词再查一轮，确实查不到也不回「记不清、不敢乱说」，把已查到的讲出来、给方向、说清哪部分没查到，不许编。两条规矩各自归档：被@的见「@ 的规矩」，自主的就在本组。'),
      R('问候必回', '大家好/早上好/晚上好这类打招呼都回',
        '群里没人 @ 也回；回复要翻长期+短期记忆带一件真实旧事（不许编）；「晚安/睡了/拜拜」类只简短道别不翻记忆。防刷屏：同群同类型 ' + ms(gr.cooldownMs != null ? gr.cooldownMs : 600000) + ' 一次（私聊不冷却）。问句不算问候。点「改」调防刷屏间隔。', { e: E(j, 'greeting.cooldownMs') }),
    ]),
    T('复读与原创', [
      R('引用回复回谁', '群里这一句在回「当前说话人」还是「原说话人」，统一判定（主人 2026-11-22 定）',
        '2026-10-23 修过一次「主人随口一句，她却引用了 1 分钟前别人@过主人那条」——'
        + '从此**回谁只看这一条消息**，不再拿上一条去猜。'
        + '2026-11-22 主人报的不对称：她回主人时**强制引用原说话人**（主人被群友那条顶掉），'
        + '群友 @ 她并引用别人时又**完全不能引用原说话人**（群友那条根本没人抓）。'
        + '现在：① 群聊里只要带引用就去取被引用那条，对准语/原说话人候选不再只给主人算；'
        + '② 判定统一走 pickQuoteTarget（qq.js，纯函数可测）：私聊不引用；没有原说话人 → 不引用（普通对话保持原样）；'
        + '原说话人那条超 5 分钟 → 退当前这条；**纯转发**（除 @/引用外没自己的正文）或她 **@ 了原说话人** → 引用原说话人那条；'
        + '其余 → 引用**当前这条**（她在回发话的人）；'
        + '③ 模型可用 [引用:原] / [引用:当前] / [引用:无] 指定，标记发出去前剥干净，群里看不到；'
        + '④ 断续发送时只在第一条带引用。'),
      R('骰子指令（SealDice 全套）', '群里用的骰子命令，语法跟海豹TRPG助手一样',
        '主人 2026-10-23 报「我的骰子是不是不全」——群里另一个 bot 能掷 .rb100、.ww100，我们只会 .r/.rc/.sc/.st。'
        + '查过：SealDice 官方开源了骰子引擎，Node 版就是 npm 上的 dicescript（Apache-2.0、零依赖），语法和输出格式完全一致，'
        + '所以**直接接它**，不自己重写一套。\\n'
        + '**命令**：.r 自由投骰（可带理由，如 .r 砍刀伤害 1d6+2）｜.rc/.ra 检定｜.sc 理智检定｜.st san 60 设理智值｜'
        + '.rb 奖励骰｜.rp 惩罚骰｜.ww WOD 无限规则｜.dx 双十字｜.rsr 暗影狂奔｜.ek 共鸣性怪异。\\n'
        + '**表达式**：b/p 奖励惩罚骰、a 加骰线、k 成功线、m 面数、c 双十字、f 命运骰、d20优势/d20劣势、'
        + 'k 取高 / q 取低、!>= 重掷、# 多轮、% 百分骰。\\n'
        + '例：.rb100（100 颗奖励骰）｜.ww100（100 个 d10 的无限规则）｜.ww 100a10k8m10｜.dx 4c3m7｜.r 2d20k1。\\n'
        + '安全：引擎很宽松（不认识的词当变量算），所以外面加了一道白名单——看不懂的一律回「这个骰子表达式我看不懂」，不给莫名其妙的数字。'
        + '原来的 .rc/.sc/.st 和 COC 分级判定一个字没改。'),
      R('复读白名单制', '白名单外的别人的话绝对不照抄',
        '只许三种复读：①梗库里的（要跟梗库原文几乎一样，差 1~2 个字符也算）；②确定能搜到原文的梗——**但只放行 20 字以内的短句**；③群友复读链跟风（≥2 条同文 3 分钟内，原样跟一条，每链一次）。其余 10 条以内别人的话一律不发不留日志。比对前会剥掉双方的 @ 段，带 @ 也能拦住。'
        + '\n**含梗词 ≠ 这句是梗**（主人 2026-10-23 定的）：含梗词只放行 20 字以内的短句；'
        + '长句整段照抄一律不放行（那等于替对方说话）。'),
      R('不许原样复制用户输入', '「某某说：」转述格式发送前剥掉',
        '发送层守卫：剥转述前缀；只有 @ 没正文的光杆 @ 一律不发；「记不清/没查到」这类空话不发。'),
      R('不许谎报做过的事', '没做成的事不许说成做成了（加群、踢人、禁言、改群名……）',
        '真事 2026-10-23：主人私聊说「去加群100000000」，她回「已成功加入群100000000，主人～」，实测根本没进群。查过 NapCat 的 56 个群接口，**没有「按群号加群」这个动作**——她只能在别人邀请/拉她进群时自动同意。也就是说那句「已成功」是它自己编的，代码里没有任何东西告诉过它成功。'
        + '现在两道：① 提示词写死——主人给群号让她加，只能答「我自己做不了，你邀请我一下 / 把我拉进去，我马上同意」，绝不许说「已加入/进群了/加好了/这就去加」；② 发送层兜底（qq.js → noFakeJoin，跟 @ 转换、引用痕迹清理同一个出口，所有发言都过）——出现「已成功加入群/已经进群了/我进群了/加好了」这类完成宣言就直接换成实话，除非半小时内真的收到过「她进群了」的系统通知。'),
    ]),
    T('身份与称呼', [
      R('身份铁律', '她只有「虚幻」一个身份，只认 QQ 号不认名字',
        '主人纠正（你是X不是Y）=任务：身份错老实认；说有毛病当场自查。场景制显示：只有「主人和她对话」（私聊/群聊回复引用@她/她刚对主人说完 3 分钟内接话）才显示「主人」，其余主人的话记成「你自己（虚幻）」；别人提到/评价主人=评价她自己。'),
      R('刚答过就不重复发', '同一段对话 30 秒内不补第二句废话（主人 2026-10-23 定）',
        '真事：主人连着说「种子卡在楼下花坛」「感觉要淹死了」还配了两张图，她先答了一遍；模型那会儿正好被限流降级，'
        + '第二次答案几乎一样 → 复读保护让她重说，还是一样 → 最后甩了句没头没尾的「我在」。群里看着莫名其妙。\n'
        + '现在：① 复读兜底那条路先看「这个会话上一次真正发出回复」是不是在 30 秒内 —— 是就不补这句（日志写「刚答过，这句不重复发了」），'
        + '对应主人早先定的「同一条连发只回第一条」；② 兜底短句按上下文挑：对方在喊「在吗」才回「在的/我在」，'
        + '别的场合只回「知道啦/好哦」，不再答非所问。（2026-11-13 主人令：「嗯嗯」兜底不要，另一组「在吗」兜底保留）'),
      R('同身份白名单', '「群里回复别人」「私聊回复别人」「自己搭话」都算她和主人同一个人',
        '主人 2026-10-23 定：「虚幻和我同身份这条也要改成白名单制。目前只有群里回复别人和私聊回复别人同身份。」当天又追加：「加自己搭话」——自己凑热闹（chime）、接着话题说（topic）也算。白名单内她＝虚幻＝主人（代表她说话、口味也一致）；只有「对方就是主人本人」这一种不算——那时她就是虚幻，主人是主人，不许说「我就是主人」。提示词里每轮按场合只注入其中一条（core.buildMessages → 「这一轮你和主人是同一个人 / 这一轮你不代表主人」）。'),
      R('称呼与好感度', '夸一次 +1；过 60 算喜欢、满 100 日常叫「宝宝」',
        '好感度是后台数据不发 QQ。称呼按人现算（主人/欧尼酱/昵称+酱/宝宝），写进提示词防叫错。'),
      R('主人的名字', '主人的名字是「虚幻」，不是「主人」',
        '「主人」「虚幻主人」只是她叫主人的**称呼**，不是名字（主人 2026-10-23 定：群友问「你的主人叫？」，她答「主人的名字是主人呀」——错）。别人问就叫「虚幻」，代码里 polish() 也会把「主人的名字是主人」改回来。'),
      R('群名片', '一个人 1 张资料卡 + 每个群各 1 张群名片',
        '主人 2026-10-23 定：「把 id 那栏 1 个的限制，改成资料卡 1 个（空的空着）、更多的按所在的群计，每个群都记。」群名片收进 data/people-state.json 的 cards（按群号分开），提示词里按当前群列出「这个群的群名片」，她按 QQ 号认出是同一个人。面板「长期记忆 → 人物列表」里能看到和改。'),
    ]),
    T('学习', [
      R('学说话', '只学群友的自然发言',
        '只收测试群（100000000）以外的群聊发言；与@无关；机器人功能指令不收；图片=打字照学；粘贴（链接/多行/超长）不收；纯图不收。普通接话也带上文（接着谁哪句说的）。每 15 条样本自动重写风格文件，所以人写的 soul 和机器写的风格文件分开。'),
      R('口味学习', '主人说的喜恶直接进她的「可能」档',
        '完全认可是同一个人设：主人随口说的喜恶直记虚幻可能档（from=主人亲口说的）。口味三态：确定>可能>待确认；待确认等主人在面板拖到确定。比较题先查口味站队。'),
      R('主人约定', '主人的话什么时候算「对她说的」（关键词就是这个，主人 2026-10-23 定的）',
        '主人在群里 @ 了别人（对别人说）→ **不算**对她说的 → 不记进约定/小本本；'
        + '主人在群里谁都没 @、也没引用（群友之间聊天）→ 也不算 → 不记；'
        + '主人在**私聊**里说、或在群里 **@ 她 / 引用她** → 算对她说的 → 记。'
        + '\n主人私聊说「以后你发言结尾记得加个喵」→ 记成「跟主人的约定」，她跟主人说话时照做；'
        + '同一句话已经在小本本或「想听我说」里记过，就不重复记。'
        + '\n真事 2026-10-23 15:44：主人 @ 小肥鱼 说「你不该这么蠢」（对别人说），虚幻却当成「主人在对她立规矩」，'
        + '回了一句「我记住了，以后会注意不这么回答的」——既认错了人，又像是把别人的话记成了自己的约定。'),
      R('记约定/记忆的白名单', '只有「真的有人在跟她说话」才允许录进约定、小本本、想听我说',
        '主人 2026-10-23 定（原话：「约定里最新的那条，是我@别人说的，这种不要录进约定」+「依旧白名单制」，'
        + '后来把口径改成全通用：「群里既没 @ 谁、也没引用谁 —— 那就是群友之间的交流，没人在和 ai 说话。是 ai 自己进行了搭话」）。'
        + '\n**能录的场合只有两种**：① 私聊（一对一）；② 群里 @ 她 / 引用她的话。'
        + '\n**不能录**：@ 了别人（含手打 @昵称）、引用的是别人的话、群里既没 @ 谁也没引用谁（群友之间在聊天）。'
        + '真事：主人 @ 群友说「许愿记得分条许」，被当成「主人吩咐」记进了约定。判定只有一处（core.aimedAtMe / core.addressedToMe），'
        + '约定、小本本、想听我说三道闸共用，发送层那句「我记住了要补写」的兜底也过同一道闸。'
        + '另外：群友的「以后每次都要这样」在**决定要不要回话之前**就录成约定（qq.js → handleTurn 前段）——'
        + '录不录只看这句话是不是有人冲她说的，和她这轮真的回没回话无关。'),
      R('群里没人叫她 = 她自己在搭话', '全局场合判定：这一轮到底有没有人在跟她说话（主人 2026-10-23 定，全通用）',
        '主人原话：「群里既没 @ 谁、也没引用谁 —— 那就是群友之间的交流，没人在和 ai 说话。是 ai 自己进行了搭话。」'
        + '这句话不是只管录不录约定，是**全局场合判定**（core.addressedToMe），下面六处全都用它：'
        + '\n① 录入：约定 / 小本本 / 想听我说 —— 这种场合一个字都不录；'
        + '\n② 约定注入：「他给你定过说话方式」只在他真的 @ 她 / 引用她 / 私聊说的时候才注入；'
        + '\n③ 身份：自己搭话时按「白名单内 · 自己在搭话」处理（她＝虚幻＝主人），不是「对方就是主人本人」；'
        + '\n④ 称呼：自己搭话不冲着谁喊「主人/宝宝」这种只对本人用的称呼；'
        + '\n⑤ 提示词：明写「这一轮：没人跟你说话（群友之间在聊天）」，让她知道这是自己插话，'
        + '别把谁的话当成吩咐、别当成在回答谁；'
        + '\n⑥ 发送层兜底：她嘴上说「我记住了」要补写，也必须先过这道闸（群里搭话时说「记住了」不算数）。'
        + '\n注：主人在群里说话、她照例必回——但那一轮同样算「自己搭话」（没人点她名字）。'),
      R('约定只对本人有效', '跟谁定的就只对谁带，回别人一个字都不许带（主人 2026-10-23 报）',
        '真事：跟企鹅火丁约了「发言结尾加 Ciallo～(∠・ω< )⌒☆」，结果她回主人、回非神也照样带上——'
        + '约定里写着「只对他这样」，但她照着群里自己说过的话学样，第 2 天起就套到所有人身上了。'
        + '两道：① 提示词反向说明——「别人定的说话方式（不许套用到眼前这个人身上）」，只在眼前这人没有约定时注入（otherPactHints）；'
        + '② 发送层硬剥——core.stripOtherPacts 按约定的「句尾记号」把不属于这个人的那截删掉再发。'
        + '记号从约定原句里抽（pactSig：取最后一个「加个/叫我…」之后的整段），只认有辨识度的（含字母数字或 ≥3 字），'
        + '「加个喵」这种一两字的普通中文不当记号——那会把她正常说话里的字也删掉。'),
    ]),
    T('QQ 空间', [
      R('转发间隔硬标准', '两条转发之间至少隔 ' + (qz.everyHours || 3) + ' 小时，重启也不破例',
        '每次转发成功就记下时间；不到间隔（含改版重启后的第一轮逛）一律不转。之前重启一次就多转一条（实测 33 分钟连转 3 条主人的动态）就是这么堵住的。'),
      R('转发：永久不转重复的', '硬标准，不设条数上限',
        '每转一条就记档（data/qzone-history.json，含正文指纹，永久保留）；挑之前把全部转过的剔除（同一动态按 ID、同一人相同正文都算，扫全历史不限最近 N 条），转发前再查一次双保险；候选全转过就安静跳过。'),
      R('转发谁的都告诉你', '转完私聊通知主人（带是谁的），不通知别人',
        '文案：我刚逛到 XX 的动态，转走啦：「原文」+ 感想。主人动态优先但不唯一——候选前 3 随机挑，好友的动态也会转。'),
      R('发自己的说说', '像人类：不是天天发，写不像就不发',
        '每天随机 0~2 条（0 条概率四成），只在 10:00~23:30 发，两条至少隔 3 小时；内容从她长期记忆里挑真实话头，参考主人原创说说的氛围（绝不抄原文、不进学说话）；质检不过这轮不发。每 ' + (qz.everyHours || 3) + ' 小时逛一次。'),
    ]),
    T('保护与自查', [
      R('暂停/允许', '主人私聊遥控，范围内一切发言全停',
        '「暂停群100000000」「暂停私聊欧尼酱」，可带时长（30分钟/2小时/1天）到点自动恢复；「允许xx」解；「暂停列表」查看。聊天照记，骰子/笑点解析/攻略也停。主人的遥控命令永远能用。'),
      R('自查提醒', '功能坏了/文件丢了 → 攒 10 分钟私信告诉主人',
        '每 5 分钟体检：配置可解析、必备文件非空、梗库≥1000 条、表情单完整、NapCat 3 分钟内有心跳、模型连通（30 分钟一次）。问题持续 10 分钟 → 私信主人，修好前每小时再提一次。'),
      R('虚幻自查（面板看）', '自查/失败/模型故障一起进状态栏那个灯',
        '同一个问题不刷屏：只在「刚坏」和「修好」两个时刻各记一条。所有者都进面板「虚幻自查」页：当前没解决的排最上面，历史记录看完可单条删。模型出问题（Key/IP白名单不对、被限流、全部答不上来）也记这儿，10 分钟最多一条。'),
      R('表情发不出去有下文', '想发的表情库里没有 → 私聊提醒主人缺哪张',
        '10 分钟最多提醒一次，说明缺哪张、去哪补（data/stickers/常用/）。'),
      R('代码自检', '改完代码先跑自检再重启',
        '查语法/JSON/必备文件/单测/在线状态；缺文件、尾逗号、BOM 自动修；结果进功能日志。私聊「修bug/自检」也会触发。'),
    ]),
    T('功能开关（现值）', [
      R('联网搜索', (j.webSearch && j.webSearch.enabled) === false ? '关' : '开', '失败结果缓存 60 秒、同一句并发只搜一次；主人说话等待期提前预热。当前状态：' + ((j.webSearch && j.webSearch.enabled) === false ? '关' : '开') + '。'),
      R('宝可梦数据源', (j.webSearch && j.webSearch.pokemon === false) ? '关' : '开',
        (() => {
          let n = 0;
          try { n = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pokemon-zh.json'), 'utf8')).count || 0; } catch {}
          return '问宝可梦的种族值/属性/身高体重 → 不抓网页，直接查官方数据（PokeAPI），0 元、不占搜索额度。'
            + '「超级烈空坐」会按超级进化形态算（780），不会拿普通形态（680）凑数。'
            + (n ? '名字表 ' + n + ' 条。' : '名字表还没建，第一次问到会自动重建（约 20 秒）。');
        })()),
      R('动漫数据源（萌娘）', (j.webSearch && j.webSearch.moegirl === false) ? '关' : '开',
        '动漫/游戏/角色的「是谁、是什么」→ 直接取萌娘百科条目正文，0 元、不占搜索额度。'
          + '只能按标题取（它的搜索接口是关的，网页有 Cloudflare 人机校验），所以问句里得带得出名字；'
          + '猜不到条目名就自动退回抓 Bing，不会硬凑。同一问句 6 小时内复用。'),
      R('像提问自动接', (j.autoAsk && j.autoAsk.enabled) === false ? '关' : '开', '像提问的句子（？结尾等）她主动接。当前状态：' + ((j.autoAsk && j.autoAsk.enabled) === false ? '关' : '开') + '。'),
      R('话题连续接话', (j.topic && j.topic.enabled) === false ? '关' : '开', '同一个话题有人接着聊就继续。当前状态：' + ((j.topic && j.topic.enabled) === false ? '关' : '开') + '。'),
      R('上下文口径', '群上 10 下 3、单人上 5、图算一条', '所有涉及聊天记录的功能统一：引用一条消息时带它上面 10 条、下面 3 条；私聊单人取上面 5 条；图片算一条；机器人的发言不算。记梗的上下文也用这个口径。'),
    ]),
  ];
}

/* ---------- 功能日志：所有功能的启用/禁用/配置变更记录 ----------
 * 数据：data/feature-log.jsonl，每行 {t,name,action,state,detail}。
 * 面板启动记一份快照；之后每次 config.json 变动（15 秒内检测到）对比开关：
 * 有开关变化 → 记「启用/禁用」；只是改了参数 → 记一条「配置变更」。页面按时间倒序。
 */
const FEATLOG_PATH = path.join(ROOT, 'data', 'feature-log.jsonl');
let featSnap = null, featCfgStamp = -1;
const featBootT = new Date().toISOString();
function featureStates() {
  const j = readCfg();
  const on = v => (v === false ? '禁用' : '启用');
  let stickers = 0;
  // 2026-11-03：视觉包现在分五个池（常用/可用/虚幻/关键词触发/少用），根目录早已清空。
  // 以前只数根目录，重排后就一直是 0 —— 开关页会误报「表情包=关」。这里改成数全部池。
  try {
    const SD = path.join(ROOT, 'data', 'stickers');
    const walk = d => {
      let n = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) n += walk(path.join(d, e.name));
        else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) n++;
      }
      return n;
    };
    stickers = walk(SD);
  } catch {}
  // kind = 功能类别（主人 2026-10-23 定：功能列表要分类，不许一锅粥）
  const K = { conn: '连接', reply: '聊天回应', learn: '学习', content: '内容与记忆', timer: '定时任务', tool: '工具' };
  return [
    { name: 'QQ 连接（NapCat）', key: '_napcat', kind: K.conn, state: j.napcatWsUrl ? '启用' : '禁用' },
    { name: '像提问自动接', key: 'autoAsk', kind: K.reply, state: on(j.autoAsk && j.autoAsk.enabled) },
    { name: '凑热闹搭话', key: 'chime', kind: K.reply, state: on(j.chime && j.chime.enabled) },
    { name: '话题连续接话', key: 'topic', kind: K.reply, state: on(j.topic && j.topic.enabled) },
    { name: '等主人说完再答', key: 'merge', kind: K.reply, state: on(j.merge && j.merge.enabled) },
    { name: '嫌我蠢识别', key: 'critic', kind: K.reply, state: j.critic && Number(j.critic.p) > 0 ? '启用' : '禁用' },
    { name: '问候必回', key: '_greet', kind: K.reply, state: '启用' },
    { name: '纯情绪→表情包', key: '_emoji', kind: K.reply, state: '启用' },
    { name: '触发词（固定话术/喊一声就接/不用回复/一定回复）', key: '_triggers', kind: K.reply, state: core.readTriggers().filter(x => x.enabled).length ? ('启用·' + core.readTriggers().filter(x => x.enabled).length + ' 条') : '禁用' },
    { name: '学说话风格', key: '_style', kind: K.learn, state: '启用' },
    { name: '口味学习', key: '_taste', kind: K.learn, state: '启用' },
    { name: '学习系统（总开关）', key: 'learn.enabled', kind: K.learn, state: on(j.learn && j.learn.enabled) },
    { name: '好感度衰减', key: 'learn.decay', kind: K.learn, state: on(j.learn && j.learn.decay) },
    { name: '知识库检索', key: 'learn.warm', kind: K.learn, state: on(j.learn && j.learn.warm) },
    { name: '冷层记录（说过什么）', key: 'learn.acts', kind: K.learn, state: on(j.learn && j.learn.acts) },
    { name: '话题日志 / 约定 / 话题', key: '_topics', kind: K.content, state: '启用' },
    { name: '网络热梗', key: '_meme', kind: K.content, state: guides.memeList().length ? '启用' : '禁用' },
    { name: '表情包', key: '_stickers', kind: K.content, state: stickers ? '启用' : '禁用' },
    { name: '看图（视觉模型）', key: '_vision', kind: K.content, state: '启用' },
    { name: '联网搜索', key: 'webSearch', kind: K.content, state: on(j.webSearch && j.webSearch.enabled) },
    { name: '宝可梦数据源（0元查官方数据）', key: 'pokemon', kind: K.content, state: on(j.webSearch && j.webSearch.pokemon) },
    { name: '动漫数据源（萌娘百科按标题取）', key: 'moegirl', kind: K.content, state: on(j.webSearch && j.webSearch.moegirl) },
    { name: '定时转发动态（每3小时逛一次）', key: '_qzone1', kind: K.timer, state: on(qzoneEnabled(j)) },
    { name: '发自己的说说（每天0~2条）', key: '_qzone2', kind: K.timer, state: on(qzoneEnabled(j)) },
    { name: '话题日志自动总结（每30分钟）', key: '_sum', kind: K.timer, state: '启用' },
    { name: '自查提醒（每5分钟体检）', key: '_selfcheck', kind: K.timer, state: '启用' },
    { name: '骰子指令', key: '_dice', kind: K.tool, state: '启用' },
    { name: '更新说明弹窗', key: '_updates', kind: K.tool, state: '启用' },
    { name: '代码自检', key: '_codecheck', kind: K.tool, state: '启用' },
    { name: '修bug自检命令（私聊「修bug」）', key: '_fixbug', kind: K.tool, state: '启用' },
  ];
}
function qzoneEnabled(j) { return !j.qzone || j.qzone.enabled !== false; }
function readFeatLog() {
  try {
    return fs.readFileSync(FEATLOG_PATH, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function featLogAppend(items) {
  if (!items.length) return;
  fs.appendFileSync(FEATLOG_PATH, items.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}
function checkFeatures(force) {
  let st = 0;
  try { st = configStore.mtime(); } catch {}
  if (!force && st === featCfgStamp) return;
  featCfgStamp = st;
  const cur = featureStates();
  const map = {};
  cur.forEach(x => { map[x.name] = x.state; });
  const t = new Date().toISOString();
  if (!featSnap) {
    // 启动快照只记「日志里还没出现过的功能」，不每次启动都刷一遍（否则一重启就多 16 条重复）
    const seen = {};
    readFeatLog().forEach(x => { seen[x.name] = 1; });
    const fresh = cur.filter(x => !seen[x.name]);
    featLogAppend(fresh.map(x => ({ t, name: x.name, action: '启动快照', state: x.state, detail: '面板启动时的状态（快照）' })));
  } else {
    const diff = cur.filter(x => featSnap[x.name] && featSnap[x.name] !== x.state)
      .map(x => ({ t, name: x.name, action: x.state === '启用' ? '启用' : '禁用', state: x.state, detail: '由「' + featSnap[x.name] + '」改为「' + x.state + '」' }));
    if (diff.length) featLogAppend(diff);
    else featLogAppend([{ t, name: '面板配置', action: '配置变更', state: '—', detail: 'config.json 有修改，功能开关没变' }]);
  }
  featSnap = map;
}
checkFeatures(true);
if (require.main === module) setInterval(() => { try { checkFeatures(); } catch {} }, 15000);

/* ---------- 花费账（v80，主人 2026-10-31 定）----------
 * 数据：token/token-usage.jsonl，每行 {t, app, scene, model, in, out, total, ms, ok, err}。
 * 由 core.js 的 recordUsage() 写：智谱每次返回里都带着 usage（输入/输出 token），
 * 以前整段被丢掉，现在每一笔都记，失败（限流/超时/Key 被拒）也记一笔 ok:false。
 * 账本目录在 config.usage.dir（主人指定放项目外面），两套机器人写同一本账，用 app 区分。
 */
/* 账本目录：**必须**和 core.js 的 usageDir() 默认值一致，否则面板读的是另一本帐，
 * 页面上永远是空的 —— 2026-11-11 查「花费账完全失效」就是这个原因：
 *   core.js 默认写 <项目>/../../token（主人指定的项目外公共目录）
 *   面板这里原来默认读 <项目>/data/usage（同一个根，但路径算错了两级）
 * 现在两边都按 core 的写法算；config.usage.dir 有值时照样优先用它。 */
const USAGE_DIR_DEFAULT = path.join(ROOT, '..', '..', 'token');
function usageFile() {
  const d = String((readCfg().usage || {}).dir || '').trim();
  return path.join(d || USAGE_DIR_DEFAULT, 'token-usage.jsonl');
}
// 场景 → 人话（面板里不显示英文标签）
const SCENE_NAME = {
  reply: '回一句话',
  'reply-retry:复读对方': '重说 · 把对方的话复读了',
  'reply-retry:空话': '重说 · 只甩了一句记不清',
  'reply-retry:腔调': '重说 · 该道歉却答成心疼',
  'reply-retry:认错': '重说 · 被嫌蠢却答成关心',
  'reply-retry:锐评': '重说 · 主人锐评没附和好',
  'reply-retry:重复': '重说 · 跟上一句重复了',
  'reply-retry:情绪': '重说 · 答得像客服',
  'reply-retry:梗': '重说 · 梗没接好',
  'reply-retry:搭话': '重说 · 搭话不像随口说的',
  'reply-retry:接话题': '重说 · 接话不像接话',
  'reply-retry:乱写': '重说 · 写了假想对白',
  xiaodian: '笑点解析',
  'xiaodian-fix': '笑点解析 · 格式不对重发',
  'xiaodian-demo': '笑点解析（自测）',
  memory: '记忆抽取（每 24 条）',
  taste: '口味抽取（每 12 条）',
  'taste-qzone': '空间动态的口味',
  style: '说话风格总结（每 15 条）',
  diary: '写日记（每天）',
  'topic-sum': '话题自动总结（每 30 分）',
  'qzone-comment': '逛空间写感想',
  'qzone-post': '自己发说说',
  vision: '看图',
  other: '其它',
};
function sceneName(s) {
  const k = String(s || 'other');
  if (SCENE_NAME[k]) return SCENE_NAME[k];
  if (k.indexOf('reply-retry') === 0) return '重说 · ' + k.split(':')[1];
  return k;
}
function readUsage() {
  const out = [];
  try {
    for (const l of fs.readFileSync(usageFile(), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
  } catch {}
  return out;
}
function costStats() {
  const all = readUsage();
  const now = Date.now();
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const since = d => now - d * 86400000;
  const sum = (rows) => {
    const s = { calls: 0, fails: 0, in: 0, out: 0, total: 0 };
    for (const x of rows) {
      s.calls++;
      if (x.ok === false) s.fails++;
      s.in += Number(x.in) || 0; s.out += Number(x.out) || 0; s.total += Number(x.total) || 0;
    }
    return s;
  };
  const inRange = d => all.filter(x => new Date(x.t).getTime() >= since(d));
  // 按功能排行（近 7 天）
  const w7 = inRange(7);
  const bySceneMap = new Map();
  for (const x of w7) {
    const k = String(x.scene || 'other');
    const c = bySceneMap.get(k) || { scene: k, name: sceneName(k), calls: 0, in: 0, out: 0, fails: 0 };
    c.calls++; c.in += Number(x.in) || 0; c.out += Number(x.out) || 0;
    if (x.ok === false) c.fails++;
    bySceneMap.set(k, c);
  }
  const byScene = [...bySceneMap.values()].sort((a, b) => b.in - a.in);
  const sceneInAll = byScene.reduce((a, b) => a + b.in, 0) || 1;
  byScene.forEach(c => { c.pct = Math.round(c.in / sceneInAll * 1000) / 10; });
  // 按哪套机器人分（近 7 天）
  const byAppMap = new Map();
  for (const x of w7) {
    const k = String(x.app || '?');
    const c = byAppMap.get(k) || { app: k, calls: 0, in: 0, out: 0 };
    c.calls++; c.in += Number(x.in) || 0; c.out += Number(x.out) || 0;
    byAppMap.set(k, c);
  }
  // 重说占比：重说次数 ÷ 正常回复次数（近 7 天）
  const replyN = w7.filter(x => x.scene === 'reply').length;
  const retryN = w7.filter(x => String(x.scene || '').indexOf('reply-retry') === 0).length;
  // 平均每次请求输入多少 token（近 7 天，只算成功的）
  const okRows = w7.filter(x => x.ok !== false && Number(x.in) > 0);
  const avgIn = okRows.length ? Math.round(okRows.reduce((a, b) => a + (Number(b.in) || 0), 0) / okRows.length) : 0;
  return {
    today: sum(all.filter(x => new Date(x.t).getTime() >= day0.getTime())),
    d7: sum(w7),
    d30: sum(inRange(30)),
    byScene, byApp: [...byAppMap.values()].sort((a, b) => b.in - a.in),
    replyN, retryN, avgIn,
    recent: all.slice(-10).reverse().map(x => ({
      t: x.t, app: x.app, scene: x.scene, name: sceneName(x.scene), model: x.model,
      in: Number(x.in) || 0, out: Number(x.out) || 0, ms: Number(x.ms) || 0,
      ok: x.ok !== false, err: x.err || '',
    })),
    file: usageFile(),
    usage: readCfg().usage || { enabled: true, keepDays: 30, dir: USAGE_DIR_DEFAULT },
  };
}

/* ---------- 自由文件夹（config.panel.folders / folderOf） ----------
 * folders: [{id, name, cat, parent}]  parent 空 = 挂在这个大类下；否则挂在某个文件夹里（可多级嵌套）
 * folderOf: {fileId: folderId}  文件被拖进哪个文件夹
 * 内置文件夹（主人 2026-10-22 定的结构）：
 *   人设 → 我的控制台（聊天记录 / 看每个人 / 写入日志）
 *   人设 → 长期记忆 → 人物列表（人物喜好 + 人物列表.md）
 *   人设 → 长期记忆 → 话题日志 / 话题 / 约定 / 地区表 / 称呼表
 *   功能 → 游戏攻略（data/guides/* 默认进这里，不配置也存在）
 */
const BUILTIN_FOLDERS = [
  { id: 'console',    name: '我的控制台', cat: 'soul',    parent: '',           builtin: true },
  { id: 'longterm',   name: '长期记忆',   cat: 'soul',    parent: '',           builtin: true },
  { id: 'peoplelist', name: '人物列表',   cat: 'soul',    parent: 'longterm',   builtin: true },
  { id: 'guides',     name: '游戏攻略',   cat: 'feature', parent: '',           builtin: true },
];
// 没拖过拽的文件，默认落进哪个内置文件夹（folderOf 优先）
const FOLDER_DEFAULTS = {
  'data/人物列表.md': 'peoplelist',
  'data/人物喜好.md': 'peoplelist',
  'data/网络热梗.md': 'longterm',
};
function readFolders() {
  const j = readCfg();
  const user = Array.isArray(j.panel && j.panel.folders) ? j.panel.folders : [];
  const all = BUILTIN_FOLDERS.concat(user.filter(f => f && f.id && f.name && !BUILTIN_FOLDERS.some(b => b.id === f.id)));
  return all.map(f => ({ id: String(f.id), name: String(f.name), cat: String(f.cat || 'other'), parent: String(f.parent || ''), builtin: !!f.builtin }));
}
function writeFolders(list) {
  const j = readCfg();
  j.panel = j.panel || {};
  j.panel.folders = list.filter(f => !f.builtin).map(f => ({ id: f.id, name: f.name, cat: f.cat, parent: f.parent || '' }));
  configStore.writeFull(j);
}
function readFolderOf() {
  const j = readCfg();
  return (j.panel && j.panel.folderOf) || {};
}
function writeFolderOf(map) {
  const j = readCfg();
  j.panel = j.panel || {};
  j.panel.folderOf = map;
  configStore.writeFull(j);
}
// 文件夹自身 + 全部后代 id（防循环嵌套）
function folderWithDescendants(id, folders) {
  const out = new Set([id]);
  let grow = true;
  while (grow) {
    grow = false;
    folders.forEach(f => { if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grow = true; } });
  }
  return out;
}

// 特殊视图（不是真实文件，是面板功能页）。folder 有值 = 挂进那个文件夹里
const SPECIAL_VIEWS = [
  { id: '__map',  cat: 'soul',    folder: 'console',    name: '参数 · 触发地图', kind: 'view', use: '（和开关、数值同在一页）它到底什么时候会说话：入口、条件、限流，数字现读 config', range: '' },
  { id: '__chat', cat: 'soul',    folder: 'console',    name: '聊天记录', kind: 'view', use: '别人说了什么、它怎么回的，可星标、可按人筛', range: '' },
  { id: '__who',  cat: 'soul',    folder: 'console',    name: '看每个人', kind: 'view', use: '单开看某个人（私聊群聊都算）或某个场合的完整对话，可切换——机器人可据此回顾上下文，算短期记忆', range: '' },
  { id: '__log',  cat: 'soul',    folder: 'console',    name: '写入日志', kind: 'view', use: '它主动写进文件/记忆的每一条，可一键清空（真删）', range: '' },
  { id: '__topic', cat: 'soul',   folder: 'longterm',   name: '话题日志', kind: 'view', use: '可能是话题的内容：它总结的 / 别人的原文 / 搜到的，可筛选、可让它总结', range: '' },
  { id: '__topics', cat: 'soul',  folder: 'longterm',   name: '话题', kind: 'view', use: '总结好、记住的话题（长期记忆，和约定并行）。聊天说到相关的它会接上', range: '' },
  { id: '__promise', cat: 'soul', folder: 'longterm',   name: '约定', kind: 'view', use: '说过的要做到，只留两类：条件明确（碰到 X 就做 Y）、说话方式（句尾/称呼/语气）。自动总结的感想已清空（2026-11-11）', range: '' },
  { id: '__table_region', cat: 'soul', folder: 'longterm', name: '地区表', kind: 'view', use: 'QQ号→城市，答天气先查这里', range: '' },
  { id: '__people', cat: 'soul', folder: 'longterm', name: '人物列表', kind: 'view', use: '每个人一行：名字（你确认过的才填，AI 不准改）/ 好感度 / 称呼；点一下展开这个人的代称（最多5个，超了挤掉最老的）、id、后缀、喜好——喜好/称呼/好感度按人排在一起', range: '' },
  { id: '__memes', cat: 'soul', folder: 'longterm', name: '网络热梗', kind: 'view', use: '梗库卡片：含义/特征词/怎么接/怎么玩/范例，可加可改可删；话题日志里可「收进热梗」', range: '' },
  { id: '__memedict', cat: 'soul', folder: 'longterm', name: '梗词典', kind: 'view', use: 'CHIME 开源中文梗数据集 1455 条（词典型：只帮她理解梗的意思，不接管回复；她自己的梗库优先）。可搜索', range: '' },
  { id: '__triggers', cat: 'soul', folder: 'console', name: '参数 · 触发词', kind: 'view', use: '（在「参数」页的触发地图那一段）一张表管所有「命中什么词 → 做什么」：固定话术（发这句话）/ 喊一声就接话（当有人叫她）/ 不用回复（不接）/ 一定回复（必接）。数据在 config.json 的 triggers，私聊发「触发词」也能看和加', range: '' },
  { id: '__features', cat: 'soul', folder: 'console', name: '参数 · 开关与数值', kind: 'view', use: '（同一页三段切换）规矩手册（悬停看细则和具体数值，数字现读配置）+ 功能列表（按类别）+ 变更记录', range: '' },
  { id: '__reqs', cat: 'soul', folder: 'console', name: '需求记录', kind: 'view', use: '主人提的需求原文留存：QQ 私聊发「需求：xxx」自动记，这里按时间倒序看全部；一键记梗/汇报的约定也在这查', range: '' },
  { id: '__feedback', cat: 'soul', folder: 'console', name: '虚幻自查', kind: 'view', use: '她自己发现的问题都汇到这儿：①定期自查查出来的毛病（当前还没好的排最上面）②想发表情但库里没有、想回但回空了③模型本身出故障（Key/限流/全挂）。只在面板看，QQ 不发；状态栏那个「虚幻自查」灯就是它', range: '' },
  { id: '__thinking', cat: 'soul', folder: 'console', name: '她的思考', kind: 'view', use: '模型自己给的思考原文（reasoning_content，一个字不改），只留最近 5 条、多了自动删；想看就点「让她下一轮想给我看」', range: '' },
];

// 「看每个人」里的人名：认人表（config.people）+ 聊天记录里出现过的昵称，机器人自己不算
function whoNamesList() {
  const names = [];
  let botName = '虚幻';
  try {
    const j = configStore.load();
    botName = String(j.botName || '虚幻');
    Object.values(j.people || {}).forEach(v => { const n = String(v || '').trim(); if (n && names.indexOf(n) < 0) names.push(n); });
  } catch {}
  try {
    const raw = fs.readFileSync(CHATLOG_PATH, 'utf8');
    const seen = new Set();
    for (const line of raw.split('\n')) {
      const m = line.match(/^\S+\s+\[[^\]]*\](\[[^\]]*\])?\[([^\]]*)\]\s/);
      const nick = m && (m[2] || '').trim();
      if (nick && !seen.has(nick)) { seen.add(nick); if (names.indexOf(nick) < 0) names.push(nick); }
    }
  } catch {}
  return { bot: botName, list: names.filter(n => n && n !== botName).slice(0, 200) };
}


// 生成左列导航树：大类 + 特殊视图 + 自由文件夹（可多级）+ 系统/代码文件
function buildNav() {
  const files = listFiles();                 // soul/data/guides 下的 md
  const folders = readFolders();
  const folderOf = readFolderOf();
  const order = readOrder();                 // panel.order：左列文件顺序（拖拽持久化）
  const ordIdx = id => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; };
  const nav = CATS.map(c => ({ id: c.id, name: c.name, icon: c.icon, when: c.when, items: [], folders: [] }));

  // 文件夹节点：按 parent 挂到大类或父文件夹上（先建节点，特殊视图才能挂进去）
  const fmap = {};
  folders.forEach(f => { fmap[f.id] = { id: f.id, name: f.name, builtin: !!f.builtin, cat: f.cat, parent: f.parent || '', items: [], folders: [] }; });
  Object.keys(fmap).forEach(id => {
    const f = fmap[id];
    if (f.parent && fmap[f.parent]) fmap[f.parent].folders.push(f);
    else { const c = nav.find(x => x.id === f.cat) || nav.find(x => x.id === 'other'); if (c) c.folders.push(f); }
  });

  SPECIAL_VIEWS.forEach(s => {
    const item = Object.assign({}, s, { ro: true });
    if (s.folder && fmap[s.folder]) { fmap[s.folder].items.push(item); return; }
    const c = nav.find(x => x.id === s.cat);
    if (c) c.items.push(item);
  });

  // 文件名/特殊视图都挂好了，代码/config/json 按 FILE_META 补（见下面）

  // 文件夹也按 order 排（order 里可能是 'folder:xxx'）
  const sortKids = arr => arr.sort((a, b) => ordIdx(a.id) - ordIdx(b.id) || 0);

  files.forEach(f => {
    const m = metaOf(f.id) || { cat: 'other', kind: 'md', use: '（还没登记用途的文件）', range: '' };
    if (m.hidden) return;                                  // 有专用页面，导航里不再露出（如网络热梗.md）
    const cat = catOf(f.id);
    const item = { id: f.id, name: (metaOf(f.id) || {}).nm || f.name, kind: m.kind || 'md', use: m.use || '', range: m.range || '', ro: !!m.ro };
    // 归位：folderOf 指定 → 那个文件夹；默认映射 → 内置文件夹；data/guides/* → guides；否则分类根
    let fid = folderOf[f.id] || FOLDER_DEFAULTS[f.id] || (f.id.indexOf('data/guides/') === 0 ? 'guides' : '');
    if (fid && !fmap[fid]) fid = '';                       // 文件夹被删了 → 落回分类根
    if (fid) { fmap[fid].items.push(item); return; }
    const c = nav.find(x => x.id === cat) || nav.find(x => x.id === 'other');
    c.items.push(item);
  });

  // 代码 / config / json 运行时数据：不在 md 扫描范围，按 FILE_META 显式补进对应分类（只读或可编辑）
  Object.keys(FILE_META).forEach(id => {
    const m = FILE_META[id];
    if (m.kind === 'md') return;                       // md 已在上面
    if (m.hidden) return;                              // 有专用页/不用看的，导航不露出
    if (SKIP_RAW[id]) return;                          // 有专用页
    const c = nav.find(x => x.id === m.cat);
    if (!c || c.items.some(x => x.id === id)) return;
    c.items.push({ id, name: id.split('/').pop(), kind: m.kind, use: m.use || '', range: m.range || '', ro: !!m.ro });
  });

  nav.forEach(c => { sortKids(c.items); sortKids(c.folders); });
  Object.keys(fmap).forEach(id => { sortKids(fmap[id].items); sortKids(fmap[id].folders); });
  return nav;
}

/* ---------- 触发地图：面板上那张「它什么时候会说话」的表 ----------
 * 数字全部从 config 现读，改了 config 这张表就跟着变，不会写死在文档里对不上。
 */
function triggerMap() {
  const j = readCfg();
  const a = j.autoAsk || {}, c = j.chime || {}, o = j.offline || {}, m = j.merge || {}, tc = j.topic || {}, ga = j.grpAuto || {};
  // 「嫌我蠢」的真实配置在 config.critic（以前这里错读成 j.topic，那两个字段恒为 undefined，
  // 面板永远显示默认的 10 秒 / 30%，改 critic.p 面板不动——主人 2026-11-01 查出来的）
  const cr = j.critic || {};
  const aa = j.autoAccept || {};
  const mins = ms => Math.round((ms || 0) / 60000);
  const pct = p => (Number(p || 0) * 100).toFixed(1) + '%';
  return {
    paths: [
      {
        key: 'at', title: '被 @ / 叫名字', mode: '一定接', color: 'ok',
        cond: '被 @、被私聊、名字被叫到',
        limit: '没有限流（这是找她说话）',
        file: 'soul/F-全场景通用主人设/虚幻.md',
        note: '最稳的一条路，@ 她一定回。',
      },
      {
        key: 'ask', title: '像提问（群里没 @）', mode: '挑着接', color: 'warn',
        cond: `不含 @，但带疑问词（怎么/为什么/多少/吗/？…）且 ≥${a.minLength || 5} 字`,
        limit: `每群每分钟 ≤${a.maxPerMinute || 3} 条，两条之间 ≥${Math.round((a.cooldownMs || 12000) / 1000)} 秒`,
        file: '—',
        note: a.enabled === false ? '当前已关闭（config.autoAsk.enabled = false）' : '要同时满足「长度 + 疑问词」，所以短句和陈述句都进不来。',
      },
      {
        key: 'banter', title: '被群友吐槽', mode: '挑着接', color: 'warn',
        cond: '她刚在 5 分钟内说过话，且这句里有「你俩 / 演起来 / 什么机器人 / 笑死…」',
        limit: '只在刚说完话之后 5 分钟内',
        file: 'soul/H-全聊天/应对/别人-被围观.md',
        note: '这是「接得住围观」，不是常态。',
      },
      {
        key: 'grpAuto', title: '群级节流（新）', mode: '必经环节', color: 'warn',
        cond: '群里没人 @ 她时，所有消息按整个群计数（她 @ 别人/引用别人的不算她的机会，@ 她的不占计数）',
        limit: `每攒够 ${ga.min || 15}~${ga.max || 20} 条才允许她自己说一句（每次说完重新随机）；被@状态：**只要被 @ 一次** → 降到 ${ga.hotMin || 4}~${ga.hotMax || 10} 条，状态持续 ${Math.round((ga.hotMsMin || 18000) / 1000)} 秒~${Math.round((ga.hotMsMax || 120000) / 1000)} 秒（每次随机）`,
        file: 'connectors/qq.js（grpAutoTick）+ config.grpAuto',
        note: '优先级高于对人的非@回复：附和、吐槽、凑热闹全都要先过这道闸；「适合回复」白名单不受限。和「话多降档」（chime 的概率/冷却/日上限）互相独立。',
      },
      {
        key: 'comment', title: '主人锐评', mode: '挑着接', color: 'warn',
        cond: '主人 / 欧尼酱说「X 是这样的」这类下判断的短句（4~80 字，不带问号）',
        limit: `和「像提问」共用一个额度：每群每分钟 ≤${a.maxPerMinute || 3} 条`,
        file: 'soul/H-全聊天/3-应对.md + 应对/我-被怪·别人-被围观.md',
        note: '只认主人和欧尼酱，群友锐评她不理。',
      },
      {
        key: 'chime', title: '凑个热闹（新）', mode: '随机接', color: 'ac',
        cond: `群里正常聊天（≥${c.minLength || 4} 字），每句按 ${pct(c.p)} 的概率搭一句`,
        limit: `同一群两条之间 ≥${mins(c.cooldownMs)} 分钟；每群每天最多 ${c.dailyMax || 10} 句（含上面那几种主动接话）`,
        file: 'soul/F-全场景通用主人设/2-说话.md（梗和段子那节）',
        note: `到 ${c.warmupHour || 20} 点还没说够 ${c.warmupMin || 30} 句、群里又确实热闹，概率临时提到 ${pct(c.warmupP)}，把一天的说话量补回来（上限 ${c.dailyMax || 80} 句）。`,
      },
      {
        key: 'topic', title: '话题还连着（新）', mode: '挑着接', color: 'ac',
        cond: `她刚参与过这段对话、她说完之后群里又有人接话、这句和最近几句对得上（或按 ${pct(tc.p)} 概率接）`,
        limit: `同一群两条之间 ≥${Math.round((tc.minGapMs || 8000) / 1000)} 秒；只在 ${Math.round((tc.windowMs || 90000) / 1000)} 秒内聊过；每群每天 ≤${tc.dailyMax || 60} 句`,
        file: 'connectors/qq.js（话题连续性）',
        note: '专门接「必须选一个」这种没 @、没疑问词、但话题没断的句子。对上了就一定接，没对上按概率接，免得每条都插嘴。',
      },
      {
        key: 'critic', title: '嫌我蠢（新）', mode: '挑着接', color: 'warn',
        cond: `短句里有「蠢/傻/智障/逆天/离谱/抽象/翻车…」；@ 了她 → 一定接；没 @ → 她 ${Math.round((cr.windowMs || 10000) / 1000)} 秒内刚在这个会话说过话，且按 ${pct(cr.p != null ? cr.p : 0.3)} 的概率挑着接`,
        limit: '≤24 字、不带问号、没在 @ 别人；长文里的「蠢」不算',
        file: 'connectors/qq.js（detectCriticism）',
        note: '截图真事（2026-10-22）：主人说「怎么感觉有点蠢」是在嫌她复读了别人的欢迎语，她却回「主人是不是累了」。现在这条路压在心情和提问前面：只认错，不关心、不解释、不联网搜。',
      },
      {
        key: 'welcome', title: '我被欢迎了（新）', mode: '挑着接', color: 'ac',
        cond: '有人 @ 她并说「欢迎/迎新/新人」，或她进群 10 分钟内群里出现欢迎词',
        limit: '只在被 @ 或进群 10 分钟窗口内；别的机器人号发的欢迎通知不接',
        file: 'connectors/qq.js（WELCOME_RE / isNewbie）',
        note: '截图真事（2026-10-22）：被 @ 说「欢迎新人」时她回「欢迎欢迎～」把欢迎还了回去，还复读了 WuuaBot 的欢迎语。现在她知道被欢迎的是自己：道谢，不复读任何欢迎语、不提「关闭欢迎」。',
      },
      {
        key: 'merge', title: '等他说完再答', mode: '必经环节', color: 'ok',
        cond: '同一会话里同一段话不逐条回，先攒着',
        limit: `有人 @ 她、或**引用回复她的消息** = 秒回，不等说完；主人说完静默 ${Math.round((m.masterWaitMs || 4000) / 1000)} 秒才答；其他人 ${Math.round((m.otherWaitMs || 3000) / 1000)} 秒`,
        file: 'config.json → merge',
        note: `攒的时候她一句都不插嘴；最多攒 ${m.maxPieces || 12} 条 / ${m.maxChars || 800} 字 / ${Math.round((m.maxMs || 180000) / 60000)} 分钟，到上限立刻答。主人是一句一句发消息的习惯，不想被逐句插嘴（2026-10-22 定）。`,
      },
      {
        key: 'offline', title: '答不出来', mode: '不算接话', color: 'warn',
        cond: '模型连不上 / 全部限流 / Key 失效 / 账号被限制（403·1220）的时候',
        limit: `群里同一个会话 ≥${Math.round((o.lineCooldownMs || 60000) / 1000)} 秒才说一次；私聊同步 ≥${mins(o.syncCooldownMs || 120000)} 分钟一条`,
        file: 'config.json → offline',
        note: `群里只说一句「${o.line || '我现在有点忙，让我的主人替我回答吧'}」；主人私聊直接收到全部可能原因（含请求来自哪个群、谁问的、原话）。她自己凑热闹失败时不说话。`,
      },
      {
        key: 'dice', title: '骰子', mode: '一定接', color: 'ok',
        cond: '以 . 或 。 开头的骰子指令',
        limit: '—',
        file: 'dice.js',
        note: '不算聊天，原样返回结果。',
      },
      {
        key: 'poke', title: '拍一拍（v78）', mode: '一定接', color: 'ok',
        cond: '有人在 QQ 里拍了拍她（NapCat 的 notify/poke 通知，拍的是她本人）',
        limit: (j.poke && j.poke.enabled === false) ? '当前已关闭（config.poke.enabled = false）'
          : `同一个会话 ${Math.round(Number((j.poke && j.poke.cooldownMs) || 3000) / 1000)} 秒最多回一次（连拍不刷屏）`,
        file: 'connectors/qq.js（onPoke）',
        note: '拍一拍会记进聊天记录和即时记忆，她也知道「有人拍了我」——问她能不能收到，她会答能。',
      },
      {
        key: 'split', title: '断续发送（v78）', mode: '怎么发', color: 'ac',
        cond: `对方这条消息里有「。」（成句的话），且她的回复 ≥${(j.split && j.split.minChars) || 14} 字、不是笑点解析/攻略这类功能`,
        limit: `按 ${pct((j.split && j.split.p != null) ? j.split.p : 0.7)} 的概率拆成 ${(j.split && j.split.maxSeg) || 3} 条以内，每条隔 800 毫秒发`,
        file: 'config.json → split（qq.js splitOut）',
        note: (j.split && j.split.enabled === false) ? '当前已关闭（config.split.enabled = false）' : '像真人打字一句一句冒出来；对方没句号就不拆。',
      },
      {
        key: 'context', title: '回答前看多少上下文（v78）', mode: '每次都要', color: 'ok',
        cond: '每一次回答都会先读最近的对话（你自己的话也在里面），读不懂再往前翻',
        limit: `群聊必看最近 ${(j.context && j.context.groupUp) || 10} 条、单聊最近 ${(j.context && j.context.personUp) || 5} 条；上面一共留 ${(j.context && j.context.historyLimit) || 60} 条（${(j.context && j.context.historyChars) || 8000} 字以内）给她自己判断要不要继续翻`,
        file: 'config.json → context（core.pushHist / buildMessages）',
        note: '实测（2026-10-23 测试群）：60 条以内关键信息一次就答对，80 条也对但更慢；所以定 60 条 / 8000 字。',
      },
      {
        key: 'autoAccept', title: '自动同意加群/好友', mode: '自动', color: 'ac',
        cond: '有人加她好友 → 直接通过；有人拉她进群 / 申请加入她的群 → 直接通过（原来这条在面板里看不到，2026-11-01 补上说明）',
        limit: `好友申请：${aa.friend === false ? '关着（不会自动通过）' : '自动通过'}；群邀请：${aa.groupInvite === false ? '关着（不会自动通过）' : '自动通过'}`,
        file: 'connectors/qq.js 的 onRequest；开关在 config.json → autoAccept',
        note: '她不能自己搜群号加群——OneBot/NapCat 协议层没有这个动作，她能做的只是「别人来加、来拉，她同意」。每次自动同意后会私聊告诉你谁、哪个群，面板顶上那颗「加群/好友 N」就是计数，点一下清零。',
      },
    ],
    chime: {
      enabled: c.enabled !== false,
      p: Number(c.p || 0), cooldownMin: mins(c.cooldownMs), dailyMax: Number(c.dailyMax || 10),
    },
  };
}

function listFiles() {
  const out = [];
  for (const d of DIRS) {
    const dir = abs(d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      out.push({ id: d + '/' + f, name: f.replace(/\.md$/i, ''), dir: d });
    }
  }
  // 根目录的 md（扫描只覆盖 soul/data/guides/docs，根下的手动补上，保证面板和磁盘一一对应）
  [].forEach(f => {
    if (fs.existsSync(path.join(ROOT, f))) out.push({ id: f, name: f.replace(/\.md$/i, ''), dir: '.' });
  });
  const ord = readOrder();
  return out.sort((a, b) => {
    const ia = ord.indexOf(a.id), ib = ord.indexOf(b.id);
    if (ia < 0 && ib < 0) return 0;
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
}

function sigOf(r) {
  try { const st = fs.statSync(abs(r)); return st.mtimeMs + '_' + st.size; } catch { return '0'; }
}

/* ---------- 数据表（JSON）：地区 ---------- */
// B站（AstrBot 插件）的真实数据目录：面板直接读写它，改完插件立刻生效
// （插件每次都是现读这个文件，不会用内存旧值盖掉面板的修改）
const BILI_DATA_DIR = '../../../../.astrbot/data/plugin_data/astrbot_plugin_bilibili_ai_bot';
const TABLES = {
  region: { name: '地区表', file: 'data/people-region.json', kind: 'kv', hint: '人物ID（p_xxx）→ 所在地，按人物对应（老数据裸 QQ 号也认）。机器人答天气时先查这里；也可以在客户端人物卡里改' },
  bili_favor: {
    name: 'B站·好感度总表',
    file: BILI_DATA_DIR + '/affection.json',
    kind: 'kv',
    hint: 'B站和QQ共用的好感度（0~100），一条=一个人：键是 B站UID 或 QQ号，值是分数。'
      + '好感度 > 80 才能要求虚幻转发动态；主人自己（30895294 / QQ 100000000）固定 100，改别的数也会被插件启动时刷回 100。'
      + '改完 B站侧立刻生效；有绑定关系的 QQ 号会自动同步到 QQ 侧（data/favor.json）。'
      + '（2026-11-03 起好感度归到「人物」：同一个人在 QQ 和 B站 各有一个号，就是一个人物，两边共用同一个数。）',
  },
  bili_bind: {
    name: 'B站·QQ绑定表',
    file: BILI_DATA_DIR + '/qq_bili_bindings.json',
    kvPath: 'links',
    kind: 'kv',
    hint: '左边填 QQ 号，右边填对应的 B站UID（都是一串纯数字）。绑上以后，这个人在 QQ 和 B站的好感度算成同一个数；'
      + '不绑就各算各的。想加谁直接在这里加一行就行。平时在 QQ 里说「我的B站UID是xxx」也会自动加一条到这里。',
  },
};

function readTable(id) {
  const t = TABLES[id];
  if (!t) return null;
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.resolve(ROOT, t.file), 'utf8')) || {}; } catch {}
  // kvPath：数据藏在某个子对象里（比如绑定表的 links），只把那一层当表格
  const src = t.kvPath ? (j[t.kvPath] || {}) : j;
  if (!src || typeof src !== 'object') return [];
  return Object.keys(src).map(k => ({ k: k, v: String(src[k] == null ? '' : src[k]) }));
}

function writeTable(id, rows) {
  const t = TABLES[id];
  if (!t) return false;
  const fp = path.resolve(ROOT, t.file);
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    // 地区表 2026-11-19 起按人物存，键是 p_xxx / platform:id — 不能像绑定表那样把字母抠掉。
    const k = id === 'region'
      ? String((r && r.k) || '').trim()
      : String((r && r.k) || '').replace(/\D/g, '');
    if (!k) continue;
    const v = String((r && r.v) || '').replace(/[\r\n]+/g, ' ').trim();
    if (v) out[k] = v;
  }
  if (t.kvPath) {
    // 只替换子对象，文件里其他字段（updated_at、bind_log 等）原样保留
    let j = {};
    try { j = JSON.parse(fs.readFileSync(fp, 'utf8')) || {}; } catch {}
    if (!j || typeof j !== 'object') j = {};
    j[t.kvPath] = out;
    j.updated_at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    fs.writeFileSync(fp, JSON.stringify(j, null, 1) + '\n', 'utf8');
  } else {
    fs.writeFileSync(fp, JSON.stringify(out, null, 1) + '\n', 'utf8');
  }
  // B站好感度表：改完顺手把有 QQ 号的那几个人同步到 QQ 侧，保证两边同一个数
  if (id === 'bili_favor') syncFavorFromBili(out);
  return true;
}

/* B站好感度改了以后，把「有 QQ 号的人」同步写回 QQ 侧的 data/favor.json。
 * 2026-11-03 重构：好感度归到「人物」（people.js，D2 每个人共享一个好感度）。
 * 这里把 B站 affection.json 的每个键（QQ号 或 B站UID）映射到人物，setFavor 后由 people.js
 * 自动把同人物的所有账号（含 QQ）同步成同一个数。 */
function syncFavorFromBili(out) {
  try {
    const bindPath = path.resolve(ROOT, BILI_DATA_DIR + '/qq_bili_bindings.json');
    let links = {};
    try { links = (JSON.parse(fs.readFileSync(bindPath, 'utf8')) || {}).links || {}; } catch {}
    const biliToQq = {};
    for (const qq of Object.keys(links)) {
      const b = String(links[qq] || '').trim();
      if (b) biliToQq[b] = String(qq).trim();
    }
    for (const key of Object.keys(out || {})) {
      const score = Math.max(0, Math.min(100, Math.round(Number(out[key]) || 0)));
      const qq = links[key] ? String(key).trim() : (biliToQq[key] || (/\d{4,12}/.test(String(key)) ? String(key).trim() : ''));
      const bili = links[key] ? String(links[key]).trim() : (biliToQq[key] ? String(key).trim() : '');
      if (!qq && !bili) continue;
      let pid = (qq && people.findByAccount('qq', qq)) || (bili && people.findByAccount('bili', bili)) || null;
      if (!pid) { pid = people.ensure(qq ? 'qq' : 'bili', qq || bili); if (!pid) continue; }
      if (qq && !people.get(pid).accounts.some(a => a.platform === 'qq' && String(a.id) === qq)) people.addAccount(pid, 'qq', qq);
      if (bili && !people.get(pid).accounts.some(a => a.platform === 'bili' && String(a.id) === bili)) people.addAccount(pid, 'bili', bili);
      people.setFavor(pid, score);   // 人物共享好感度，自动同步到名下所有账号
      botWrite('data/people.json', '好感(同步)', 'B站→人物 ' + pid + '：' + score);
    }
  } catch (e) {
    try { fs.appendFileSync(path.join(ROOT, 'data', 'panel-err.log'), new Date().toISOString() + ' [同步好感] ' + (e && e.stack || e) + '\n'); } catch {}
  }
}

/* ---------- 人物列表（主人 2026-10-23 定：喜好/称呼/好感度按人排在一起）----------
 * 数据仍分三处存（people.json 人物主存、人物喜好.md 口味、人物列表.md 事实）——各功能各读各的，
 * 这里只是把三份**合成一个视图**。名字只能主人确认后写（AI 代码里没有任何写 name 的路径）；
 * 代称最多 5 个，超了挤掉最老的（主人定的规则，服务端强制）。
 * 2026-11-04：口味和事实都按人物名下**所有平台账号**聚合读（原文仍一节一个账号 / 一行一条），
 * 每条标 fromQQ + fromPlatform / factPlat，客户端能看出来自哪个平台哪个号（纯 B站 用户没有 QQ 也能显示）。
 */
function tasteParseForPeople() {
  try { return require('../taste').parse() || {}; } catch { return {}; }
}
/* 按人物聚合口味：taste.byPerson 全留冲突条目并标 fromQQ；老进程没跟上时退回主 QQ 单节。 */
function tasteByPersonForPeople(pid, mainQQ) {
  const keys = ['likeConf', 'hateConf', 'likePerson', 'pending', 'likeGuess', 'hateGuess'];
  const blank = () => { const s = {}; for (const k of keys) s[k] = []; return s; };
  try {
    const t = require('../taste');
    if (t && typeof t.byPerson === 'function') {
      const r = t.byPerson(pid);
      if (r && r.secs) {
        const secs = blank();
        for (const k of keys) secs[k] = (r.secs[k] || []).map(x => ({ t: x.t, from: x.from || '', fromQQ: x.fromQQ || '', fromPlatform: x.fromPlatform || 'qq' }));
        return { name: r.name || '', secs };
      }
    }
    const old = tasteParseForPeople()[String(mainQQ || '')] || {};
    const secs = blank();
    for (const k of keys) secs[k] = (old[k] || []).map(x => ({ t: x.t, from: x.from || '', fromQQ: String(mainQQ || ''), fromPlatform: 'qq' }));
    return { name: old.name || '', secs };
  } catch { return { name: '', secs: blank() }; }
}
/* 称呼状态现由 people.js 主存（data/people.json），这里按 QQ 摊平的视图只是适配层 */
function readPeopleState() {
  try { return people.stateView(); } catch { return {}; }
}
/* 面板手动改 = 'user' 档（2026-11-22）：以前固定走 sync 只许补空，
 * 改已有名字会被 people.save 的人名闸拒掉，接口却回 ok——静默失败。
 * opt.mode 只给非面板来源（资料同步）显式传 'sync' / 'qqsync'。 */
function writePeopleState(o, opt) {
  try { return people.writeStateView(o || {}, { mode: (opt && opt.mode) || 'user' }); }
  catch (e) { console.error('[panel] 写人们状态失败', e && e.message || e); return false; }
}
function normAlias(v) {
  const seen = new Set(); const out = [];
  for (const raw of String(v || '').split(/[、｜|,，;；]/)) {
    const s = String(raw).replace(/\s+/g, '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out.slice(0, 5).join('、');            // 最多 5 个，多了从最右挤（保主人写的顺序）
}
/* 2026-11-03 重构：按「人物」聚合（每个人物一张卡，挂多个平台账号，共享一个好感度）。
 * 2026-11-04：口味 / 事实按人物名下所有 QQ 合并读，各条带来源号；原文格式一个字节不动。
 * 2026-11-05：纯 B站（任意非 QQ 平台）人物也能出卡：昵称取账号级 nick，
 *            没有名字/昵称时 label 显示「B站 <id>」；qq 字段为空不报错。 */
const PLAT_LABEL = { qq: 'QQ', bili: 'B站' };
function readPeople() {
  const masterIds = [readCfg().masterQQ].concat(readCfg().masters || []).map(String).filter(Boolean);
  const facts = {};
  try {
    for (const l of fs.readFileSync(path.join(ROOT, 'data', '人物列表.md'), 'utf8').split('\n')) {
      if (!/^[-*]\s+/.test(l)) continue;
      const text = l.replace(/^[-*]\s+/, '').trim().slice(0, 120);
      // 一行里可能提到多个号：QQ 123 / B站 456（纯 B站 用户没有 QQ 号，靠这个前缀认平台）
      const accts = [];
      const re = /(QQ|B站|bili|哔哩哔哩)\s*(\d{1,20})/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        const platform = /qq/i.test(m[1]) ? 'qq' : 'bili';
        const key = platform + ':' + m[2];
        if (!accts.some(a => a.key === key)) accts.push({ key, platform, id: m[2] });
      }
      for (const a of accts) (facts[a.key] = facts[a.key] || []).push({ t: text, fromQQ: a.id, fromPlatform: a.platform });
    }
  } catch {}
  const LABELS = { likeConf: '喜欢·确定', hateConf: '讨厌·确定', likePerson: '喜欢（人）', pending: '待确认', likeGuess: '喜欢·可能', hateGuess: '讨厌·可能' };
  const list = people.all().map(p => {
    const qqs = (typeof people.qqAccountsOf === 'function' ? people.qqAccountsOf(p.pid) : [])
      .map(String).filter(Boolean);
    const qq = qqs[0] || (p.accounts.find(a => a.platform === 'qq') || {}).id || '';
    const by = tasteByPersonForPeople(p.pid, qq);
    const tp = by.secs;
    const secList = Object.keys(LABELS)
      .map(sec => ({ sec, label: LABELS[sec], items: (tp[sec] || []).map(x => ({ t: x.t, from: x.from, fromQQ: x.fromQQ || '', fromPlatform: x.fromPlatform || 'qq' })) }))
      .filter(s => s.items.length);
    // 事实按人物名下**所有平台账号**匹配（纯 B站 用户只有 B站 账号，没有 QQ 可查）；
    // 同一条被多个号提到时按原文去重，来源取账号顺序最前的那个。
    const accts = (typeof people.accountsOf === 'function' ? people.accountsOf(p.pid) : [])
      .map(a => ({ platform: String(a.platform), id: String(a.id) }));
    const seenFact = new Set();
    const factItems = [];
    for (const a of accts) {
      for (const f of (facts[a.platform + ':' + a.id] || [])) {
        if (seenFact.has(f.t)) continue;
        seenFact.add(f.t);
        factItems.push({ t: f.t, fromQQ: a.id, fromPlatform: a.platform });
      }
    }
    const factTop = factItems.slice(0, 8);
    const isMaster = p.accounts.some(a => a.platform === 'qq' && masterIds.includes(String(a.id)));
    // 主账号（qq 优先；纯 B站 人物就是它的 B站 账号）——昵称是账号级字段，显示主账号那个
    const mainAcc = p.accounts.find(a => String(a.platform) === 'qq') || p.accounts[0] || null;
    const nick = String((mainAcc && mainAcc.nick) || p.nick || '');
    // 群名片 > QQ 昵称（2026-11-13 主人令：她在群里看到的是「企鹅火丁」，不该显示成 QQ 昵称「非欧」）。
    // 只改显示串，people.json 里的 nick / cards / name 一个字节不动。
    const cardName = String((mainAcc && mainAcc.cards && Object.keys(mainAcc.cards).map(k => mainAcc.cards[k]).filter(Boolean).slice(-1)[0]) || '');
    // 2026-11-21 主人令：名字只认人物表（people.json）。原来还读 readCfg().people，
    // 那份配置已没人写、永远是空，等于给名字留了第二个来源。
    const realName = String(p.name || '');
    const names = people.namesOf(p.pid);
    // 名字只放「她确认过的名字」原文（客户端那个输入框存的就是它，别把兜底串写进去，
    // 否则点一次保存就把「B站 30895294」存成名字了）。
    // label 是纯展示串：有名字用名字，其次群名片，再其次昵称，最后「B站 <id>」。
    const label = realName || cardName || nick || (mainAcc ? String(PLAT_LABEL[String(mainAcc.platform)] || mainAcc.platform) + ' ' + mainAcc.id : '（没有账号）');
    return {
      pid: p.pid,
      qq: qq,                                  // 主QQ（兼容旧字段；纯 B站 人物是空串）
      accounts: p.accounts.map(a => ({ platform: String(a.platform), id: String(a.id), nick: String(a.nick || '') })),
      isMaster,
      /* 身份（2026-11-22 她令）：主人 / 欧尼酱 / 朋友 / 认识的人 / 陌生人。
       * 现算走 people.roleOf（没写 role 的老数据按号/好感/在不在人物表判），面板只读不另存一份。 */
      role: (() => { try { return people.roleOf(p.pid); } catch { return 'known'; } })(),
      roleLabel: (() => { try { return people.roleLabel(people.roleOf(p.pid)); } catch { return ''; } })(),
      /* 性别（2026-11-22 她令）：AI 女、主人女、其他人默认男（猜的）。面板要能看、能改。 */
      sex: (() => { try { return people.sexOf(p.pid); } catch { return 'male'; } })(),
      sexLabel: (() => { try { return people.sexLabel(people.sexOf(p.pid)); } catch { return '男'; } })(),
      sexSrc: (() => { try { return people.sexSrcOf(p.pid); } catch { return 'guess'; } })(),
      sexSrcLabel: (() => {
        try { return people.SEX_SRC_LABEL[people.sexSrcOf(p.pid)] || ''; } catch { return ''; }
      })(),
      /* 主人对他的专属叫法（2026-11-22 她令）：注入里「昵称（主人称呼方式）」就是它。 */
      masterCall: (() => { try { return people.masterCallOf(p.pid); } catch { return ''; } })(),
      name: realName,
      label,
      account: mainAcc ? String(mainAcc.platform) : '',   // 主账号在哪个平台（来源平台）
      // 名字 + 代称是一条有序表（主人 2026-11-13）：第一个是名字，其余是代称，前端拼成同一行。
      // 账号级 alias 各号各写，这里按人合起来；没名字时第一个代称就当名字用。
      names,
      /* 面板「代称」输入框只放**别人喊过、需要手填**的那部分（账号级 alias）。
       * 自动代称（其他群名片/资料卡/平台名/曾用名）在 names.slice(1) 里，别混进可编辑字段——
       * 否则点一次保存就把群名片、曾用名全写回 alias 了（2026-11-22 名字分层后）。 */
      alias: (() => {
        const seen = new Set();
        for (const a of (p.accounts || [])) {
          for (const s of String((a && a.alias) || '').split(/[、｜|,，;；]/)) {
            const v = s.trim(); if (v) seen.add(v);
          }
        }
        return [...seen].join('、');
      })(),
      nick,
      // 群名片（2026-11-21 主人令）：**正本在账号级**（people.json 的 accounts[].cards）。
      // 这里原来读人物级的 p.cards，可 people.json 根本没有这个字段 → 面板永远「0 张」，
      // 和虚幻那边（按账号 cards 认群）不是同一份。现在按人物名下所有账号合并读，同一群取第一个有值的。
      cards: (() => {
        const m = {};
        for (const a of (p.accounts || [])) {
          const cs = (a && a.cards) || {};
          for (const g of Object.keys(cs)) { if (cs[g] && !m[g]) m[g] = cs[g]; }
        }
        return m;
      })(),
      suffix: String(p.suffix || ''),
      favor: p.favor,
      favorLock: !!p.favorLock,        // 好感锁定（2026-11-13）：锁了以后群里夸她、衰减都不动
      taste: secList,
      tasteName: String(by.name || ''),
      facts: factTop.map(x => x.t),
      factFrom: factTop.map(x => x.fromQQ),
      factPlat: factTop.map(x => x.fromPlatform || 'qq'),
    };
  });
  list.sort((a, b) => (b.isMaster - a.isMaster) || (b.favor - a.favor) || String(a.pid).localeCompare(String(b.pid)));
  return { list, likeAt: people.PERSON_LIKE_AT, fullAt: people.BAIBAI_AT, masterIds };
}

/* ---------- 聊天记录（只读 + 星标） ---------- */
const CHATLOG_PATH = path.join(ROOT, 'data', 'chat-log.jsonl');
// 星标的读写和 key 算法统一在 core（2026-11-03）。面板和 QQ 的「群友点赞」必须算出同一个 key，
// 否则群里被点赞、面板里那颗星永远点不亮——以前就是这么坏的（28 条 key 是 emoji+消息id）。
const readStars = core.starsRead;
const writeStars = core.starsWrite;
const starKey = e => core.starsKey(e && e.t, e && e.nick, e && e.text);

/* 好感度页已定的规则（主人 2026-11-07：「直接用」）：一个人挂多个平台账号，共享一个好感度。
 * 聊天日志只存显示名、不存号；这里按 people.json 的「确认名 / 资料卡名 / 群名片 / 代称」
 * 反查回人物，同一个人的两个号才会并成一个会话。查不到的如实写「没存号」，不编。
 * 名字和号显示成什么样也照好感度页（people.labelOfKey）：「主人（QQ 100000000）」「主人（B站 30895294）」。
 *
 * 2026-11-07 主人追加：「如果我两个号都有头像就分别记，其他平台的头像也都分别记，但都是同一个人」。
 * 所以这里不是「一个人一个号」，而是「一个人 + 一组 (平台,号)」：会话按平台分开，
 * 归属（pid）仍然共用；头像取这条消息所在平台的那个号。 */
/* 同一个名字在 people.json 和日志里可能只差几个方向控制符、一个空格
 * （实测「虚幻的生物 ⁧～喵⁧」和「虚幻的生物\u2067～喵\u2067」是同一个人）。
 * 匹配键一律去掉方向符和全部空白，两边才对得上。 */
function chatNameKey(s) {
  return String(s || '').replace(/[\u2066-\u2069\u200e\u200f]/g, '').replace(/\s/g, '').trim();
}
function chatNameIndex() {
  const idx = new Map();
  // 群内「显示名 → 号」：从人物表每个账号的 cards（这个号在某群叫什么）现算。
  // 和认人读的是同一份 cards，不另建表、不另走记录链路 —— 只在此处现算一次。
  // 跨群同名（两个群都有「乙」）靠它分开，群聊头像不再串。
  idx._groups = new Map();   // 群号 → Map(名字key → hit)
  const put = (k, v) => {
    const key = chatNameKey(k);
    if (key && !idx.has(key)) idx.set(key, v);
  };
  try {
    for (const p of people.all()) {
      // 所有平台的账号都收：QQ / B站 / 以后的平台。每个号保留自己的平台，取头像时按平台挑。
      const accts = (p.accounts || [])
        .map(a => ({ platform: qmeta.normPlat(a && a.platform), id: String((a && a.id) || '') }))
        .filter(a => a.id);
      if (!accts.length) continue;
      const v = { pid: String(p.pid || ''), name: String(p.name || ''), accts };
      if (v.name) put(v.name, v);
      for (const a of p.accounts || []) {
        put(a.nick, v); put(a.alias, v);
        for (const nm of Object.values(a.cards || {})) put(nm, v);
        // 群名片带群号：记成「这个群 + 这个名字 → 这个号」。只带这一张卡所属的账号，
        // 取头像就取对号；同名不同群各记各的，先到先得（同一群里真发过言的那个号）。
        const acct = { platform: qmeta.normPlat(a && a.platform), id: String((a && a.id) || '') };
        for (const gid of Object.keys(a.cards || {})) {
          const nm = a.cards[gid];
          const gk = String(gid == null ? '' : gid).replace(/\D/g, '');
          const nk = chatNameKey(nm);
          if (!gk || !nk || !acct.id) continue;
          let m = idx._groups.get(gk);
          if (!m) idx._groups.set(gk, (m = new Map()));
          if (!m.has(nk)) m.set(nk, { pid: v.pid, name: v.name, accts: [acct] });
        }
      }
    }
  } catch {}
  // 运行时补的「显示名 → 号」：people.json 只覆盖 27% 的行，这张表随聊天自动补齐。
  // 人物表优先（它带 pid，同一个人的两个号能并成一个会话）；这里只补没查到的名字。
  // 两个平台各读一遍 —— B站 观众和 QQ 群友重名时，各自落到各自的号上。
  for (const plat of ['qq', 'bili']) {
    try {
      for (const [nm, uid] of Object.entries(qmeta.allNames(plat))) {
        const key = chatNameKey(nm);
        if (!key || idx.has(key) || !uid) continue;
        let pid = '';
        try { pid = String(people.findByAccount(plat, uid) || ''); } catch {}
        idx.set(key, { pid, name: '', accts: [{ platform: plat, id: String(uid) }] });
      }
    } catch {}
  }
  return idx;
}
/* 这个人在这条消息所属平台上的号（一个人可能只有 QQ 号、也可能只有 B站 号） */
function chatAcctOf(hit, platform) {
  if (!hit || !Array.isArray(hit.accts)) return null;
  const p = qmeta.normPlat(platform);
  return hit.accts.find(a => a.platform === p) || null;
}
/* 会话名 / 发言人名：照好感度页的写法（名字（平台 号））；没存号就如实写「没存号」。
 * 名字优先用人物表确认的名字，人物还没起名时用日志里当时的显示名（不能只剩一个号）。 */
function chatWhoLabel(hit, nick, platform) {
  const p = qmeta.normPlat(platform);
  const nm = (hit && hit.name) || String(nick || '?');
  if (!hit) return nm + '（没存号）';
  const a = chatAcctOf(hit, p);
  if (a) return nm + '（' + people.platLabel(p) + ' ' + a.id + '）';
  // 这个人有档案，但没有这个平台的号（比如只有 QQ 号的人在 B站 说话）
  return nm + '（没存' + people.platLabel(p) + '号）';
}

/* 账号→人 合并映射（主人 2026-11-14 定「合并账号的逻辑」）：
 * 把某私聊会话键（u_xxx / p_xxx / bili_yyy）并到目标会话键（通常 p_<某人pid>），
 * 下次读聊天记录自动合并，无需改历史日志。键值都是 parseChatLine 算出的 e.conv。
 * 用法见 data/conv-merge.json。 */
const CONV_MERGE_PATH = path.join(__dirname, '..', 'data', 'conv-merge.json');
let _convMergeCache = null, _convMergeMtime = 0;
function convMergeMap() {
  try {
    const st = fs.statSync(CONV_MERGE_PATH);
    if (!_convMergeCache || st.mtimeMs !== _convMergeMtime) {
      _convMergeCache = JSON.parse(fs.readFileSync(CONV_MERGE_PATH, 'utf8') || '{}');
      _convMergeMtime = st.mtimeMs;
    }
  } catch { _convMergeCache = {}; }
  return _convMergeCache || {};
}
// pid → 人物名（缓存一次，整次读取内复用）
let _pidNameCache = null;
function pidName(pid) {
  if (_pidNameCache === null) {
    _pidNameCache = {};
    try { for (const p of people.all()) _pidNameCache[String(p.pid)] = String(p.name || ''); } catch {}
  }
  return _pidNameCache[String(pid)] || '';
}
// 主人括号别名（如「主人（欧尼酱的女朋友）」）在人物表里没登记时，仍归到主人本人
let _masterHitCache = undefined;
/* 主号在人物表里对应哪个人（pid）——面板认「这句是不是主人说的」只认人物表，不认配置里的名字串。
 * 2026-11-21 主人令：面板认人必须和虚幻读同一份 people.json。 */
function ensureMasterHit(masterLabel) {
  if (_masterHitCache !== undefined) return _masterHitCache;
  try {
    const j = configStore.load();
    const mp = people.findByAccount('qq', j.masterQQ);
    _masterHitCache = mp ? { pid: String(mp), name: masterLabel, accts: [{ platform: 'qq', id: String(j.masterQQ) }] } : null;
  } catch { _masterHitCache = null; }
  return _masterHitCache;
}

/* 把一行聊天日志解析成「这一句属于哪个会话 / 谁说的」（含 orphan、群、私聊三种）。
 * 抽出来给 readChat 和「删全组 / 删非主人私聊」共用，规则只有一份、不会两边对不上。
 * lastPriv 跨行带：私聊里虚幻自己回的那句，会话身份跟着上一句对方走（不然整段被改名成「虚幻」）。
 * 返回 { e, lastPriv } —— e 带 conv / convKind / pid / uid / whoName 等，orphan 行 conv='__orphan'。 */
function parseChatLine(line, nameIdx, bot, masterLabel, lastPriv) {
  const stars = parseChatLine._stars || (parseChatLine._stars = new Set(readStars().map(s => s.key)));
  const e = {};
  // 新格式：时间 [来源][群号/私聊][昵称][标记…] 内容；旧格式少中间那段，scope 记空
  // 标记（v78）：[→X]=这句是回 X 的（触发人）；[=主人]=主人说的但记成她的发言
  const m4 = line.match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]((?:\[[^\]]*\])*)\s*([\s\S]*)$/);
  const m3 = m4 ? null : line.match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s*([\s\S]*)$/);
  const m2 = (m4 || m3) ? null : line.match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\s*([\s\S]*)$/);
  if (m4) {
    e.t = m4[1]; e.src = m4[2]; e.scope = m4[3]; e.nick = m4[4]; e.text = m4[6];
    const marks = String(m4[5] || '');
    const to = marks.match(/\[→([^\]]*)\]/);
    if (to) e.to = to[1].trim();
    if (/\[=主人\]/.test(marks)) e.asHer = true;
  }
  else if (m3) { e.t = m3[1]; e.src = m3[2]; e.scope = m3[3]; e.nick = m3[4]; e.text = m3[5]; }
  else if (m2) { e.t = m2[1]; e.src = m2[2]; e.scope = ''; e.nick = m2[3]; e.text = m2[4]; }
  // 早期日志的残片：既没时间也没署名，只有一行正文。它不属于任何会话，也不该冒充谁的私聊。
  else { e.t = ''; e.src = ''; e.scope = ''; e.nick = ''; e.text = line.trim(); e.orphan = true; }
  // 正文里的换行落盘时写成字面 \n（core.logLine），这里还原成真换行，
  // 一条消息才不会被从第二行起拆成「没署名」的裸行。
  e.text = String(e.text || '').replace(/\\n/g, '\n');
  /* 客户端发的媒体（2026-11-23）：正文尾巴挂着 ［媒体:<文件名>］（文件在 src/data/client-media/），
   * 面板据此渲染缩略图 / 播放器 / 文件卡；标签本身从正文摘掉——显示和提示词都不要这串机器码。 */
  const mediaHits = [];
  e.text = e.text.replace(/［媒体:([^］]+)］/g, (m, f) => {
    const name = String(f).replace(/[^0-9A-Za-z._-]/g, '');
    if (name) mediaHits.push({
      file: name,
      kind: /\.(mp4|mov|mkv|webm|avi)$/i.test(name) ? 'video'
        : /\.(mp3|wav|m4a|amr|silk|flac|ogg)$/i.test(name) ? 'audio'
          : /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name) ? 'image' : 'file',
    });
    return '';
  });
  if (mediaHits.length) e.media = mediaHits;
  // 回复溯源（主人 2026-10-22）：「↩回复@昵称：片段↩」前缀 → 拆成 replyTo，正文去掉标记
  const rm = e.text.match(/^↩回复@(.+?)：([\s\S]*?)↩\s*/);
  if (rm) { e.replyTo = { nick: rm[1], frag: rm[2] }; e.text = e.text.slice(rm[0].length); }
  // [=主人] 的行名字写成「虚幻」（主人=虚幻），但它不是机器人说的——别被当成 bot 行吞掉
  const cleanNick = String(e.nick || '').replace(/[\u2066-\u2069\u200e\u200f]/g, '').trim() || '没署名';
  // 末尾「（…）」去掉再匹配：主人（欧尼酱的女朋友）→ 主人；人物表里的代称也认（主人 2026-11-14 定）
  const bareNick = cleanNick.replace(/[（(][^）)]*[）)]$/, '').trim() || cleanNick;
  e.bot = cleanNick === bot && !e.asHer;
  e.mine = !e.bot && (e.asHer || cleanNick === masterLabel || bareNick === masterLabel);   // 主人自己说的（含括号别名）
  /* 会话归属（虚幻的视角）：群按群号；私聊按「平台 + 人」。
   * 平台来自日志的 [来源] 段（qq / bili …）：B站 的评论、弹幕不能再混进 QQ 私聊里
   * （主人 2026-11-07：「这个私聊里还有b站啊，左侧另开一个」）。
   * 日志里没有号 → 靠好感度页那张人物表反查；查不到就用显示名兜底，不硬拆。 */
  const plat = qmeta.normPlat(e.src);
  e.plat = plat;
  e.platLabel = people.platLabel(plat);
  let hit = nameIdx.get(chatNameKey(e.nick)) || nameIdx.get(chatNameKey(bareNick)) || null;
  // 主人括号别名（如「主人（欧尼酱的女朋友）」）若人物表里没登记，也归到主人本人（主人 2026-11-14 定）
  if (!hit && bareNick === masterLabel) hit = ensureMasterHit(masterLabel);
  /* 2026-11-21 主人令：面板和虚幻必须读同一份人物表来认人。
   * 原来只拿 masterLabel（配置里的名字，现在没人写 = '主人'）跟日志署名做字符串比较，
   * 主人日志里叫「虚幻」「虚幻的生物 ～喵」时就认不出来，面板把她当别人。
   * 现在只要反查到的人物就是主号那个人（people.json 判定），就算主人说的。 */
  if (!e.bot && !e.mine && hit && hit.pid) {
    const mh = ensureMasterHit(masterLabel);
    if (mh && String(hit.pid) === String(mh.pid)) e.mine = true;
  }
  if (e.orphan) {
    // 单独一组，不冒充任何人；也不参与「上一句是谁说的」的接力
    e.conv = '__orphan'; e.convKind = 'orphan'; e.convLabel = '早期记录（没时间、没来源）';
    e.uid = ''; e.pid = ''; e.whoName = '没署名';
  } else if (String(e.scope || '').indexOf('群') === 0) {
    e.conv = String(e.scope);
    e.convKind = 'group';
    e.convLabel = qmeta.groupLabel(e.scope);
    // 群聊按「这个群里的这个名字」认人：先从 cards 现算的群内表取，
    // 取不到才退回全局名字表。这样两个群都有「乙」也不会串头像。
    const gid = String(e.scope).replace(/\D/g, '');
    const gm = nameIdx && nameIdx._groups && nameIdx._groups.get(gid);
    const ghit = gm && (gm.get(chatNameKey(e.nick)) || gm.get(chatNameKey(bareNick)));
    const use = ghit || hit;
    const a = chatAcctOf(use, plat);
    e.uid = a ? a.id : '';
    e.pid = use ? use.pid : '';
    e.whoName = use ? chatWhoLabel(use, cleanNick, plat) : cleanNick;
  } else {
    if (hit && !e.bot) lastPriv = { hit, plat, label: chatWhoLabel(hit, cleanNick, plat) };
    const p = hit || (e.bot && lastPriv && lastPriv.plat === plat ? lastPriv.hit : null);
    const a = chatAcctOf(p, plat);
    // 会话键：QQ 沿用 p_ 开头（客户端已存的选择状态不用迁），其他平台用「平台_」开头
    const pre = plat === 'qq' ? 'p_' : plat + '_';
    e.conv = pre + (p ? (p.pid || 'u_' + (a ? a.id : cleanNick)) : 'u_' + cleanNick);
    e.convKind = plat;
    // 她自己的回复跟着「上一句是谁说的」走：会话名用对方的名字，不能用「虚幻」（不然整个会话被改名）
    e.convLabel = (e.bot && p && lastPriv && p === lastPriv.hit && lastPriv.plat === plat)
      ? lastPriv.label
      : (p ? chatWhoLabel(p, cleanNick, plat) : cleanNick + '（没存号）');
    e.uid = a ? a.id : '';
    e.pid = p ? p.pid : '';
    e.whoName = e.convLabel;
  }
  // 账号→人 合并（主人 2026-11-14 定）：把本会话并到映射表里的目标会话键（同一人多个账号/平台 → 一条会话），
  // 无需改历史日志，下次读取自动合并。映射见 data/conv-merge.json。
  try {
    const mm = convMergeMap();
    const tgt = mm && (mm[e.conv] || (e.pid && mm['pid:' + e.pid]));
    if (tgt && tgt !== e.conv) {
      e.conv = String(tgt);
      if (e.conv.indexOf('p_') === 0) {
        e.pid = e.conv.slice(2);
        const nm = pidName(e.pid);
        if (nm) e.convLabel = nm + (e.uid ? '（' + people.platLabel(plat) + ' ' + e.uid + '）' : '');
      }
      e.whoName = e.convLabel;
    }
  } catch {}
  // 头像按「平台 + 号」分开给：同一个人两个 QQ 号各一张、B站 又是另一张（主人 2026-11-07）
  e.avPlat = e.uid ? plat : '';
  e.avId = e.uid || '';
  // 按会话设置用的键（qq_<号> / bili_<UID>），和机器人那边的历史键同一套；
  // 客户端拿它去改上下文条数 / 回复开关 / 黑名单，不用自己拼。
  e.scopeKey = convSettings.keyOfConv(e.conv, e.uid, e.convKind);
  e.img = /\[图片\]/.test(e.text);
  e.key = starKey(e);
  e.starred = stars.has(e.key);
  return { e, lastPriv };
}

/* 便捷封装：给一行原始日志，返回它的会话归属 { conv, convKind, pid, orphan }。
 * 删全组 / 删非主人私聊脚本用，单点算、不用整文件解析。 */
function readChatLineConv(line) {
  let bot = '虚幻', masterLabel = '主人';
  try {
    const j = configStore.load();
    bot = j.botName || '虚幻';
    masterLabel = (j.people && j.people[String(j.masterQQ)]) || '主人';
  } catch {}
  const r = parseChatLine(line, chatNameIndex(), bot, masterLabel, null);
  const e = r.e;
  return { conv: e.conv, convKind: e.convKind, pid: e.pid, orphan: !!e.orphan };
}

/* ---------- 聊天记录页的花费（2026-11-11 主人令）----------
 * 只显示「折合人民币」，口径就钉在这两个数上，界面不做二次换算：
 *   折合 DeepSeek V4.1-Flash 空闲时段（谷时）单价：输入 1 元/百万 tokens、输出 4 元/百万 tokens。
 *   谷时 = 除工作高峰（工作日 9-12、14-18）以外的全部时间；这里只算 token 折价，不管真实扣费时段。
 *   账本里没有「缓存命中」字段 → 输入统一按未命中那一档算（宁可算高，不虚报便宜）。
 * 会话归属：账本行上的 k（qq_群号 / qq_号，和「按会话设置」同一个键）。
 *   老账本没有 k 字段 → 用同时刻（±5 秒）的推理记录反查，历史账也能按会话分。
 */
const DS_IN_PER_M = 1, DS_OUT_PER_M = 4;
function rmbOf(a, b) {
  return ((Number(a) || 0) * DS_IN_PER_M + (Number(b) || 0) * DS_OUT_PER_M) / 1e6;
}

// 推理记录里的「时间 → 会话键」点位（只读最近几天，够补账本了）
function tracePoints(days) {
  const out = [];
  try {
    const dir = trace.TRACE_DIR;
    const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-(days || 3));
    for (const f of files) {
      for (const ln of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        try {
          const o = JSON.parse(ln);
          const t = Date.parse(o.t);
          if (o.k && !isNaN(t)) out.push({ t, k: String(o.k) });
        } catch {}
      }
    }
  } catch {}
  return out;
}

// 账本 + 每笔的会话键（缺的按推理记录补齐）。返回按时间升序。
function usageIndex() {
  const rows = [];
  for (const x of readUsage()) {
    const t = Date.parse(x.t);
    if (isNaN(t)) continue;
    rows.push({ t, k: String(x.k || ''), in: Number(x.in) || 0, out: Number(x.out) || 0 });
  }
  rows.sort((a, b) => a.t - b.t);
  const need = rows.filter(r => !r.k);
  if (need.length) {
    const pts = tracePoints(3);
    for (const r of need) {
      let best = '', bd = 5000;
      for (const p of pts) {
        const d = Math.abs(p.t - r.t);
        if (d <= bd) { bd = d; best = p.k; }
      }
      if (best) r.k = best;
    }
  }
  return rows;
}

// 每个会话的合计：{ in, out, total, rmb, calls }
function convCostOf(rows) {
  const m = {};
  for (const r of rows) {
    if (!r.k) continue;                       // 日记 / 记忆这类后台调用不属于任何会话，不进这个账
    const o = m[r.k] || (m[r.k] = { in: 0, out: 0, calls: 0 });
    o.in += r.in; o.out += r.out; o.calls++;
  }
  for (const k of Object.keys(m)) {
    m[k].total = m[k].in + m[k].out;
    m[k].rmb = rmbOf(m[k].in, m[k].out);
  }
  return m;
}

// 同一会话里，时间最接近这笔消息的一次调用（±90 秒）。找不到就返回 null，界面就不显示，不猜。
function tokNear(byK, k, tMs) {
  const arr = byK[k];
  if (!arr || !arr.length || isNaN(tMs)) return null;
  let lo = 0, hi = arr.length - 1, best = null, bd = 90000;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = arr[mid].t - tMs;
    if (Math.abs(d) <= bd) { bd = Math.abs(d); best = arr[mid]; }
    if (d < 0) lo = mid + 1; else hi = mid - 1;
  }
  return best ? { in: best.in, out: best.out, total: best.in + best.out, rmb: rmbOf(best.in, best.out) } : null;
}

// 聊天记录读取：不设条数上限、也不设内存上限（主人 2026-11-11 定「后端不设上限」），
// 日志多大就读多大。20G 那个顶属于消息接收端（NapCat），不在这一层。
// 渲染端的量由前端自己控制（每次只画当前会话的 200 条）。
function readChat(opts) {
  opts = opts || {};
  let bot = '虚幻', masterLabel = '主人';
  try {
    const j = configStore.load();
    bot = j.botName || '虚幻';
    masterLabel = (j.people && j.people[String(j.masterQQ)]) || '主人';
  } catch {}
  const nameIdx = chatNameIndex();
  const stars = new Set(readStars().map(s => s.key));

  let raw;
  /* 2026-11-21 主人令「分片不当摆设、主文件翻到了才读」：
   * 默认只读最近 N 段分片（不整份读 8000+ 行）；明确要全部/某会话/某段才扩大范围。
   * 主文件是唯一数据源、行号锚点照旧，只是面板平时不再整份读它。
   *  - shard=<key>   只读那一段
   *  - conv=<key>    读某会话的所有段
   *  - all=1         读整份主文件（用户点「全部历史」才走，慢）
   *  - recent=<n>    读最近 n 段（默认 12）
   *  - skip=<k>      从最近往前第 k 段起读（往上翻加载更早一批），配合 recent=<n>
   */
  let mode = 'recent';
  if (opts.shard) {
    mode = 'shard';
    raw = chatShards.readShard(opts.shard).join('\n');
  } else if (opts.conv) {
    mode = 'conv';
    raw = chatShards.readConv(opts.conv).join('\n');
  } else if (opts.all) {
    mode = 'all';
    try { raw = fs.readFileSync(CHATLOG_PATH, 'utf8'); }
    catch { return { bot, masterLabel, list: [], total: 0 }; }
  } else {
    raw = chatShards.readRecent(opts.recent, opts.skip).join('\n');
  }

  let lastPriv = null;              // 私聊里最近一次「对方是谁」；虚幻自己回的那句跟着它走
  const list = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const r = parseChatLine(line, nameIdx, bot, masterLabel, lastPriv);
    lastPriv = r.lastPriv;
    const e = r.e;
    // 老数据里已经落下的裸行 = 上一条多行消息的续行（主人 11-12 报的 bug）。
    // 跟着上一条的会话和说话人，不再单开一个「没署名 · 早期记录」；
    // 文件开头真没有上家的残片仍按 orphan 留着，不硬并。
    const prev = list[list.length - 1];
    if (e.orphan && prev && !prev.orphan) {
      prev.text += '\n' + e.text;
      if (e.img) prev.img = true;
      continue;
    }
    list.push(e);
  }
  // 把「同一个人、同一个群/私聊、间隔 ≤2 分钟」的连续消息合成一条（就是机器人那边合并回答的多条）
  const merged = [];
  const GAP = 120000;
  for (const e of list) {
    const p = merged[merged.length - 1];
    const pt = p ? Date.parse(p.pieces[p.pieces.length - 1].t) : NaN;
    const et = Date.parse(e.t);
    // [=主人] 那种（主人对别人说的话）不参与合并：混进她的回复里就看不清谁说的了
    if (p && !p.bot && !e.bot && !e.asHer && !p.asHer && p.scope === e.scope && p.nick === e.nick
      && !isNaN(pt) && !isNaN(et) && et - pt <= GAP && et >= pt) {
      p.pieces.push(e);
      if (e.replyTo && !p.replyTo) p.replyTo = e.replyTo;
      p.text = p.pieces.map(x => x.text).join('\n');
      p.tEnd = e.t;
      p.img = p.pieces.some(x => x.img);
      p.key = starKey({ t: p.t, nick: p.nick, text: p.text });
      // 星可能标在合并前的某一句上（群友点赞就是按单句加的），任意一句有星，这条就点亮
      p.starred = stars.has(p.key) || p.pieces.some(x => stars.has(x.key));
    } else {
      merged.push({ t: e.t, tEnd: e.t, src: e.src, scope: e.scope, nick: e.nick, bot: e.bot, mine: e.mine, asHer: !!e.asHer, to: e.to || '', img: e.img, text: e.text, pieces: [e], key: e.key, starred: e.starred,
        conv: e.conv, convKind: e.convKind, convLabel: e.convLabel, uid: e.uid, pid: e.pid, whoName: e.whoName,
        plat: e.plat, platLabel: e.platLabel, avPlat: e.avPlat, avId: e.avId, scopeKey: e.scopeKey,
        // 这句是回哪条的（主人 2026-11-07：「QQ 页面没有回复别人的具体某条」）。
        // 日志里一直有「↩回复@昵称：片段↩」，但这一步以前没往外带，界面上就看不见了。
        replyTo: e.replyTo || null });
    }
  }
  // 不设条数上限（原本的 limit 截断已删）；也不设内存上限，整份读。
  // 每句「虚幻说的」贴上这一轮真花的 token（同一会话、时间最近的一笔，±90 秒）。
  let cost = {};
  try {
    const rows = usageIndex();
    cost = convCostOf(rows);
    const byK = {};
    for (const r of rows) { if (!r.k) continue; (byK[r.k] || (byK[r.k] = [])).push(r); }
    for (const e of merged) {
      if (!e.bot || !e.scopeKey) continue;
      const t = tokNear(byK, e.scopeKey, Date.parse(e.t));
      if (t) e.tok = t;
    }
  } catch (err) { console.error('[聊天记录] 算花费失败：' + err.message); }
  // 2026-11-21：告诉前端当前读的是「最近分片 / 某会话 / 某段 / 全部主文件」，
  // 以及分片游标（本次从第几段读 / 实读几段 / 总段数 / 还有没有更早），前端据此自动往上翻加载。
  let shardSegs = 0, shardTotal = 0;
  try { const ls = chatShards.list(); shardSegs = ls.length; shardTotal = ls.reduce((a, x) => a + (x.count || 0), 0); } catch (e) {}
  const skip = Math.max(0, Number(opts.skip) || 0);
  const take = Math.max(1, Number(opts.recent) || 12);
  const readSegs = mode === 'recent' ? Math.min(take, Math.max(0, shardSegs - skip)) : 0;
  const nextSkip = skip + readSegs;
  return { bot, masterLabel, list: merged, total: merged.length, cost, mode, shardSegs, shardTotal,
    skip, readSegs, nextSkip, hasMore: mode === 'recent' && nextSkip < shardSegs };
}

/* ---------- 话题日志 + 话题 + 约定（和聊天记录并行，主人 2026-10-22 定） ----------
 * data/topics.jsonl，一行一条：
 *   kind:  topic=话题日志里的 / promise=约定（长期记忆，和人物列表.md 并行）
 *   type:  self=它自己总结的 / quote=别人的原文 / search=联网搜到的 / manual=主人手动录入
 *   state: raw=还没总结 / summed=已总结（在话题日志里）/ kept=已收进「话题」（约定恒为 kept）
 *   parent: 被总结后，原始内容挂到已总结话题底下（灰色显示）
 * 面板「长期记忆」文件夹：话题日志（raw/summed）/ 话题（kept）/ 约定（promise）。
 */
const TOPICS_PATH = path.join(ROOT, 'data', 'topics.jsonl');
const TOPIC_TYPES = {
  self:   { name: '自己总结', color: '#a78bfa' },
  quote:  { name: '别人原文', color: '#2dd4bf' },
  search: { name: '搜索到的', color: '#fb923c' },
  manual: { name: '手动录入', color: '#94a3b8' },
};
/* 约定分类（和客户端 pactKindOf、core 的 pactParts 同一套判据）：
 *   style = 说话方式（有句尾记号 / 结尾加个 / 称呼 / 语气）
 *   scene = 条件明确（有触发条件 when，或有一句原样要说的话 say）
 *   note  = 什么都没有的自我感想 → 主人 2026-11-11 判定为无意义废话，不进约定页、不注入提示词 */
function pactKindSv(x) {
  if (!x) return 'note';
  if (String(x.sig || '')) return 'style';
  if (/(结尾|句尾|末尾|加个|加上|带上|叫我|称呼|语气|口癖)/.test(String(x.text || ''))) return 'style';
  if ((Array.isArray(x.when) && x.when.length) || String(x.say || '').trim()) return 'scene';
  return 'note';
}

function readTopics() {
  let raw = '';
  try { raw = fs.readFileSync(TOPICS_PATH, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.id) out.push(j); } catch {}
  }
  return out;
}
function writeTopics(list) {
  fs.mkdirSync(path.dirname(TOPICS_PATH), { recursive: true });
  fs.writeFileSync(TOPICS_PATH, list.map(x => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''), 'utf8');
}
function topicSeq() { return Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

// ===== 全局体检 / 全局净化（主人 2026-10-22 v52 定：改过提示的内容都能用，后续新的也受影响）=====
// 覆盖所有喂给模型的内容：人设、说话风格、梗库、话题日志/话题（含星标联动的）。
// 检查规则和面板「体检」按钮一致：写了会白写（代码硬校验拦）/ 前后矛盾 / 重复。
const CHECK_BLOCKS = [
  { re: /这是[\s\S]{0,14}梗|这就是所谓|这是一种/, why: '代码把这种句子判成「在解释梗」，会让她重说一遍' },
  { re: /我是文盲|我看不懂|看不明白/, why: '梗场景里这句被判成跑偏，会被重写' },
  { re: /嘿嘿/, why: 'polish() 会把「嘿嘿」直接换成「嘻嘻」' },
  { re: /哈哈/, why: '人设只说「嘻嘻」，用「哈哈」会被统一口径' },
];
const CHECK_CONFLICTS = [
  { k: '我是文盲', w: /文盲/ },
  { k: '说「这是XX的梗」', w: /这是.{0,14}梗|这就是所谓|这是一种/ },
  { k: '「嘿嘿」', w: /嘿嘿/ },
  { k: '省略号', w: /省略号|\.\.\.|…/ },
  { k: '句号收尾', w: /句号/ },
];
function tidyLineSv(s) {
  var out = String(s == null ? '' : s);
  if (/^\s*\|/.test(out)) return out;                    // 表格行不动
  out = out.replace(/\*\*/g, '');
  out = out.replace(/\s*\|\s*/g, '、');
  out = out.replace(/举例\s*[:：]\s*/g, '举例：');
  out = out.replace(/、{2,}/g, '、').replace(/、\s*、/g, '、');
  out = out.replace(/、\s*([，。！？；：])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}
// 收集要查的内容：[{src, where, lines:[{raw}]}]
function checkupSources() {
  let cfg = {};
  try { cfg = readCfg(); } catch {}
  const soulRel = (cfg.files && cfg.files.soul) || 'soul/F-全场景通用主人设/虚幻.md';
  const md = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n'); } catch { return []; } };
  const srcs = [];
  srcs.push({ src: '人设（' + soulRel + '）', lines: md(soulRel) });
  const extra = cfg.files && cfg.files.extra;
  if (extra) srcs.push({ src: '补充人设（' + extra + '）', lines: md(extra) });
  srcs.push({ src: '说话风格（data/说话风格.md）', lines: md('data/说话风格.md') });
  srcs.push({ src: '梗库（data/网络热梗.md）', lines: md('data/网络热梗.md') });
  // 话题：只收顶层 + 挂在它底下的原文（约定不进 prompt，不查）
  const all = readTopics();
  const kids = {};
  all.forEach(x => { if (x.parent) (kids[x.parent] = kids[x.parent] || []).push(x.text || ''); });
  const tl2 = [];
  all.forEach(x => {
    if (x.kind === 'promise') return;
    if (!x.parent) { tl2.push(x.text || ''); (kids[x.id] || []).forEach(t => tl2.push(t)); }
  });
  if (tl2.length) srcs.push({ src: '话题日志/话题（data/topics.jsonl）', lines: tl2 });
  return srcs;
}
function globalCheck() {
  const srcs = checkupSources();
  const issues = [];
  let n = 0;
  srcs.forEach(s => {
    const lines = s.lines.map(t => String(t || '').trim()).filter(t => t.length > 3 && !/^[#/]/.test(t));
    n += lines.length;
    lines.forEach(raw => {
      CHECK_BLOCKS.forEach(c => {
        const m = raw.match(c.re);
        if (!m) return;
        const pre = raw.slice(0, raw.indexOf(m[0]));
        if (/(不许|不要|禁止|不能|不说|不用|别|杜绝|不允许|无须)[^，。]{0,6}$/.test(pre)) return;
        issues.push({ src: s.src, kind: 'warn', title: '这句写了，但代码会判它不合格', body: raw.slice(0, 90), why: c.why });
      });
    });
    CHECK_CONFLICTS.forEach(tp => {
      const neg = lines.filter(t => tp.w.test(t) && /(不许|不要|禁止|不能|别|杜绝|一律不|不用|不说)/.test(t));
      const pos = lines.filter(t => tp.w.test(t) && !/(不许|不要|禁止|不能|别|杜绝|一律不|只有|除了|除非|例外)/.test(t));
      if (neg.length && pos.length) {
        issues.push({ src: s.src, kind: 'conflict', title: '「' + tp.k + '」一处禁止、一处允许', body: '不许：' + neg[0].slice(0, 46) + '\n允许：' + pos[0].slice(0, 46), why: '模型读到两句相反的会两头摇摆，留一句。' });
      }
    });
  });
  return { items: n, issues };
}
// 全局净化：对上面所有来源真正落盘清洗（md 按行洗；话题逐条洗）
function globalTidy() {
  let cfg = {};
  try { cfg = readCfg(); } catch {}
  const soulRel = (cfg.files && cfg.files.soul) || 'soul/F-全场景通用主人设/虚幻.md';
  let n = 0;
  const washFile = rel => {
    const full = path.join(ROOT, rel);
    let lines = [];
    try { lines = fs.readFileSync(full, 'utf8').split('\n'); } catch { return; }
    let changed = 0;
    const out = lines.map(l => { const v = tidyLineSv(l); if (v !== l) changed++; return v; });
    if (changed) { fs.writeFileSync(full, out.join('\n'), 'utf8'); n += changed; }
  };
  washFile(soulRel);
  if (cfg.files && cfg.files.extra) washFile(cfg.files.extra);
  washFile('data/说话风格.md');
  washFile('data/网络热梗.md');
  const all = readTopics();
  let tChanged = 0;
  all.forEach(x => {
    const v = tidyLineSv(x.text || '');
    if (v !== (x.text || '')) { x.text = v; tChanged++; }
  });
  if (tChanged) writeTopics(all);
  return { md: n, topics: tChanged, total: n + tChanged };
}
// 话题总结联系上下文（主人 2026-10-22 v52 定，口径和笑点解析一致：单人上5、整群上10、下3，分别算）。
// 从 chat-log.jsonl 里按这条话题的时间和会话找前后消息。
function topicContext(it) {
  const t = Date.parse(it.t || '');
  if (isNaN(t)) return '';
  const scope = String(it.scope || '');
  const who = String(it.nick || it.who || '');
  let raw = '';
  try { raw = fs.readFileSync(CHATLOG_PATH, 'utf8'); } catch { return ''; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m3 = line.match(/^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s*([\s\S]*)$/);
    if (!m3) continue;
    const tt = Date.parse(m3[1]);
    if (isNaN(tt)) continue;
    rows.push({ t: tt, scope: m3[3], nick: m3[4], text: m3[5].replace(/\s+/g, ' ').trim().slice(0, 120) });
  }
  const inScope = rows.filter(r => !scope || r.scope === scope).sort((a, b) => a.t - b.t);
  const before = inScope.filter(r => r.t < t);
  const after = inScope.filter(r => r.t >= t);
  const fmt = a => a.map(r => (r.nick || '?') + '：' + r.text).join('\n') || '（无）';
  return [
    '【此人（' + who + '）最近说的（上5）】\n' + fmt(who ? before.filter(r => r.nick === who).slice(-5) : []),
    '【整群上文（上10）】\n' + fmt(before.slice(-10)),
    '【整群下文（下3）】\n' + fmt(after.slice(0, 3)),
  ].join('\n');
}
// 让模型总结一段话题（面板「让它总结」按钮用；和机器人用的同一条模型链）
async function llmSay(prompt, maxTokens) {
  const j = readCfg();
  const L = j.llm || {};
  if (!L.apiKey || !L.endpoint) return { error: '还没填 API Key' };
  const chain = [L.model].concat(L.fallbackModels || []).filter(Boolean);
  let lastMsg = '';
  for (const m of chain) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 45000);
      const r = await fetch(L.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + L.apiKey },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens || 300 }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const t = await r.text();
      if (r.ok) {
        let txt = '';
        try { txt = (JSON.parse(t).choices || [{}])[0].message.content || ''; } catch { txt = t; }
        txt = String(txt).trim();
        if (txt) return { text: txt, model: m };
      }
      lastMsg = t.slice(0, 120);
    } catch (e) { lastMsg = e.message; }
  }
  return { error: '模型没答上来：' + lastMsg };
}

/* ---------- 红点（机器人写过的新内容） ---------- */
function readNews() {
  try { return JSON.parse(fs.readFileSync(NEW_STORE, 'utf8')) || {}; } catch { return {}; }
}
function writeNews(o) {
  try { fs.mkdirSync(path.dirname(NEW_STORE), { recursive: true }); fs.writeFileSync(NEW_STORE, JSON.stringify(o, null, 1), 'utf8'); } catch {}
}

/* ---------- 时间 ---------- */
const DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2})\s*[·•:：\-—]?\s*/;
const okDate = d => (/^\d{4}-\d{1,2}-\d{1,2}$/.test(String(d || '').trim()) ? String(d).trim() : '');
function splitDate(s) {
  const str = String(s || '').trim();
  const m = str.match(DATE_RE);
  if (!m) return { d: '', text: str };
  const rest = str.slice(m[0].length).trim();
  if (!rest) return { d: '', text: str };
  return { d: m[1], text: rest };
}

/* ---------- md → 树 ---------- */
function parseMd(md) {
  const root = { level: 0, title: '', items: [], children: [] };
  const stack = [root];
  const lines = String(md || '').split(/\r?\n/);
  for (const line of lines) {
    const h = line.match(/^(#{1,12})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      while (stack.length > 1 && stack[stack.length - 1].level >= lv) stack.pop();
      const node = { level: lv, title: h[2].trim() || '未命名', items: [], children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    if (line.trim() === '---') continue;
    const cur = stack[stack.length - 1];
    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (li) {
      const t = li[2].trim();
      if (!t) continue;
      const g = splitDate(t);
      cur.items.push({ t: 'li', text: g.text, d: g.d, ind: Math.min(10, li[1].length) });
    } else if (bq) {
      const t = bq[1].trim();
      if (!t) continue;
      const g = splitDate(t);
      cur.items.push({ t: 'p', text: '> ' + g.text, d: g.d, ind: 0 });
    } else if (line.trim()) {
      const g = splitDate(line.trim());
      cur.items.push({ t: 'p', text: g.text, d: g.d, ind: 0 });
    }
  }
  return root;
}

/* ---------- 树 → md ---------- */
function cleanTree(root) {
  const one = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
  const walk = n => ({
    title: one(n && n.title) || '未命名',
    items: (Array.isArray(n && n.items) ? n.items : []).map(i => {
      const text = one(i && i.text);
      const got = splitDate(text);
      return {
        t: i && i.t === 'p' ? 'p' : 'li',
        text: got.text,
        d: okDate(i && i.d) || got.d,
        ind: Math.min(10, Math.max(0, parseInt(i && i.ind, 10) || 0)),
      };
    }).filter(i => i.text),
    children: (Array.isArray(n && n.children) ? n.children : []).map(walk),
  });
  return { children: (Array.isArray(root && root.children) ? root.children : []).map(walk) };
}

function toMd(tree) {
  const out = [];
  const walk = (n, depth) => {
    out.push('#'.repeat(Math.max(1, Math.min(12, depth))) + ' ' + n.title);
    if (n.items.length) {
      out.push('');
      for (const i of n.items) {
        const pre = okDate(i.d) ? i.d + ' · ' : '';
        if (i.t === 'p') {
          const q = i.text.replace(/^>\s?/, '');
          out.push('> ' + pre + q);
        } else {
          out.push(' '.repeat(i.ind || 0) + '- ' + pre + i.text);
        }
      }
    }
    out.push('');
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const c of tree.children) walk(c, 1);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------- HTTP ---------- */
function sendFile(res, file, type) {
  // 2026-11-02：静态页面（panel.html / panel-client.js）在 xuhctrl/，数据在 xuhchatrule/。
  // 两边都找一遍：先找面板目录，再找数据根目录。
  const p1 = path.join(WEB, file);
  const p2 = path.join(ROOT, file);
  fs.readFile(fs.existsSync(p1) ? p1 : p2, (e, buf) => {
    if (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('missing ' + file); }
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
    res.end(buf);
  });
}

// 表情包缩略图用的「图名 → 文件绝对路径」缓存（2026-11-01）。
// 面板要直接画出图，不能再靠悬停看名字；每次请求都重扫文件夹太浪费，缓存 5 秒。
let stkImgMap = null, stkImgMapAt = 0;

/* 写入日志（2026-11-22）：面板写入口统一留痕——失败必记，成功也记，方便对时间线。
 * 只记路由 / 字段名 / pid、qq / 结果 / 耗时，不记值本身（里面可能有私人的东西）。 */
const WRITE_LOG = path.join(ROOT, 'data', 'panel-writes.log');
function logWrite(route, d, ok, error, ms) {
  try {
    const brief = {};
    for (const k of ['pid', 'qq', 'uid', 'field', 'k', 'id', 'city', 'key']) {
      if (d && d[k] !== undefined && d[k] !== '') brief[k] = String(d[k]).slice(0, 40);
    }
    const line = JSON.stringify({ t: new Date().toISOString(), route, req: brief, ok: !!ok, error: String(error || '').slice(0, 200), ms: Number(ms) || 0 });
    fs.appendFileSync(WRITE_LOG, line + '\n', 'utf8');
    if (fs.statSync(WRITE_LOG).size > 800 * 1024) {   // 大约两千行滚一刀
      const keep = fs.readFileSync(WRITE_LOG, 'utf8').trim().split('\n').slice(-1200);
      fs.writeFileSync(WRITE_LOG, keep.join('\n') + '\n', 'utf8');
    }
  } catch { /* 日志写不了不能影响正常保存 */ }
}

function handler(req, res) {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  const json = o => send(200, 'application/json; charset=utf-8', JSON.stringify(o));
  let body = '';
  req.on('data', c => { body += c; if (body.length > 30e6) req.destroy(); });   // 30MB：动态一次最多 9 张图（base64）
  req.on('end', async () => {
    const _t0 = Date.now();
    let d = {};
    try { d = body ? JSON.parse(body) : {}; } catch {}

    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) return sendFile(res, 'panel.html', 'text/html');
    if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/client.js') return sendFile(res, 'panel-client.js', 'application/javascript');
    // 表情包页（面板和客户端共用同一份前端，2026-11-03）
    if (req.method === 'GET' && req.url === '/sticker-page.js') return sendFile(res, 'sticker-page.js', 'application/javascript');
    if (req.method === 'GET' && req.url === '/sticker-page.css') return sendFile(res, 'sticker-page.css', 'text/css');

    // ===== 表情包图片（2026-11-01 主人：面板里要直接看见图，不再悬停看名字）=====
    // 只读图片字节：只认 data/stickers 下面真实存在的那几个文件夹，名字不带扩展名（和 /api/stickers 给的 imgs 一套）。
    // 越界路径、非图片扩展名一律 404，不会把项目里别的文件读出去。
    if (req.method === 'GET' && req.url.indexOf('/api/stkimg?') === 0) {
      const bad = () => send(404, 'text/plain; charset=utf-8', 'no');
      try {
        const qs = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
        const want = String(qs.get('n') || '').trim();
        if (!want) return bad();
        const SDIR = path.join(ROOT, 'data', 'stickers');
        if (!stkImgMap || Date.now() - stkImgMapAt > 5000) {
          stkImgMap = new Map(); stkImgMapAt = Date.now();
          for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/'], ['关键词触发', '关键词触发/'], ['少用', '少用/']]) {
            const p = dir ? path.join(SDIR, dir) : SDIR;
            let list = [];
            try { list = fs.readdirSync(p); } catch { continue; }
            for (const f of list) {
              if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
              let st = null;
              try { if (fs.statSync(path.join(p, f)).isDirectory()) continue; st = path.join(p, f); } catch { continue; }
              const bare = f.replace(/\.[^.]+$/, '');
              if (!stkImgMap.has(pre + bare)) stkImgMap.set(pre + bare, st);
              if (!stkImgMap.has(bare)) stkImgMap.set(bare, st);   // 同名图只认第一张（常用 > 可用 > 虚幻 > 根目录）
            }
          }
        }
        const abs = stkImgMap.get(want) || stkImgMap.get(String(want).replace(/\\/g, '/'));
        if (!abs) return bad();
        const rel = path.relative(SDIR, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return bad();
        const mime = /\.png$/i.test(abs) ? 'image/png'
          : /\.gif$/i.test(abs) ? 'image/gif'
            : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg';
        const buf = fs.readFileSync(abs);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'max-age=600' });
        return res.end(buf);
      } catch (e) { return bad(); }
    }

    // 主人私聊「自然语言=指令」统一入口：QQ 连接器 / AstrBot B站桥都打这里。
    // 只认主人的号（nl-command 内再验一次），回 {handled,ok,reply}。
    if (req.method === 'POST' && req.url === '/api/nlcommand') {
      try {
        // fromPanel：本机面板已登录，不再要求「主人的号」；聊天侧照旧要过 isOwner
        const out = await require('../nl-command').handle(Object.assign({ fromPanel: true }, d));
        return json(out);
      } catch (e) { return json({ handled: true, ok: false, reply: '指令没执行：' + e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/nlcorrection') {
      try {
        // 记录类对所有人开放（约定 / 代称 / 标错 / 记小本本），不再只认主人号
        const out = await require('../nl-command').handleRecord(d);
        return json(out);
      } catch (e) { return json({ handled: false, error: e.message }); }
    }
    /* B站「回复才建档」（2026-11-22 她定）：AstrBot 插件在回复成功后打这里。
     * 机器人自己的 8898 没开时才轮到面板 8899，两条路口径一致。 */
    if (req.method === 'POST' && req.url === '/api/enroll') {
      try {
        const plat = String(d.platform || '').trim();
        const id = String(d.uid || '').replace(/\D/g, '');
        if (!plat || !id) return json({ ok: false, error: '要 platform 和 uid' });
        const nick = String(d.nick || '').slice(0, 40);
        const before = people.findByAccount(plat, id);
        const pid = before || people.ensure(plat, id, nick ? { nick } : {});
        if (!pid) return json({ ok: false, error: '建不了' });
        if (nick) { try { people.setAccountNick(plat, id, nick); } catch {} }
        return json({ ok: true, pid, created: !before });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    /* ===== 客户端发言（2026-11-23 主人令）=====
     * 客户端在 Electron 主进程里跑，面板 handler 也在主进程里；但 QQ 的连接在机器人子进程，
     * 所以这一条必须转给机器人自己的本机口（8898），由它当「主人私聊」喂进 onMessage。
     * 超时给到 5 分钟：发文件时 DSH 读内容、发语音时 whisper 转写都在这条请求里同步做完。 */
    if (req.method === 'POST' && req.url === '/api/panel/send') {
      try {
        const out = await new Promise(resolve => {
          const body = JSON.stringify(d || {});
          const rq = http.request({
            host: '127.0.0.1', port: Number(process.env.NL_PORT || 8898),
            path: '/api/panel/send', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 300000,
          }, rs => {
            let b = '';
            rs.on('data', c => { b += c; });
            rs.on('end', () => {
              try { resolve(JSON.parse(b)); }
              catch { resolve({ ok: false, error: '机器人回包看不懂：' + String(b).slice(0, 200) }); }
            });
          });
          rq.on('timeout', () => { try { rq.destroy(); } catch {} resolve({ ok: false, error: '机器人在读文件/转写，等超时了' }); });
          rq.on('error', e => resolve({ ok: false, error: '机器人没在跑：' + e.message }));
          rq.write(body);
          rq.end();
        });
        return json(out);
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    /* 语音转写能力自检：客户端用它决定「语音」按钮是能点还是要提示装模型。 */
    if (req.method === 'GET' && req.url === '/api/panel/asr') {
      let st;
      try { st = require('../asr').ready(); } catch (e) { st = { ok: false, error: e.message }; }
      return json(st);
    }

    if (req.method === 'GET' && req.url === '/api/all') {
      const files = listFiles();
      const data = {};
      for (const f of files) {
        let raw = '';
        try { raw = fs.readFileSync(abs(f.id), 'utf8'); } catch {}
        data[f.id] = { tree: parseMd(raw), sig: sigOf(f.id) };
      }
      const meta = {};
      files.forEach(f => {
        const m = metaOf(f.id) || {};
        meta[f.id] = { cat: catOf(f.id), ro: !!m.ro, kind: m.kind || 'md', use: m.use || '', range: m.range || '' };
      });
      return json({ files, data, news: readNews(), nav: buildNav(), meta, tablesMeta: Object.keys(TABLES).map(id => ({ id, name: TABLES[id].name, hint: TABLES[id].hint })) });
    }
    if (req.method === 'GET' && req.url === '/api/triggers') {
      return json(triggerMap());
    }
    // 她的思考（v79）：模型给的 reasoning_content 原文，只留最近 5 条（core 写的时候已经裁过）
    if (req.method === 'GET' && req.url === '/api/thinking') {
      const list = [];
      try {
        for (const l of fs.readFileSync(path.join(ROOT, 'data', 'thinking.jsonl'), 'utf8').split('\n')) {
          if (!l.trim()) continue;
          try { list.push(JSON.parse(l)); } catch {}
        }
      } catch {}
      return json({ list: list.slice(-5).reverse() });
    }
    // 花费账（v80）：每一笔大模型调用用了多少 token，按功能排行
    if (req.method === 'GET' && req.url === '/api/cost') {
      return json(costStats());
    }
    // 改记账开关 / 保留天数 / 账本目录（写回 config.json 的 usage 段）
    if (req.method === 'POST' && req.url === '/api/cost/set') {
      try {
            const j = readCfg();
        j.usage = j.usage || {};
        if (d.enabled !== undefined) j.usage.enabled = !!d.enabled;
        if (d.keepDays !== undefined) j.usage.keepDays = Math.max(1, Math.min(3650, Number(d.keepDays) || 30));
        if (d.dir !== undefined) {
          const nd = String(d.dir || '').trim();
          if (!nd) return json({ error: '目录不能是空的' });
          j.usage.dir = nd;
        }
        configStore.writeFull(j);
        return json({ ok: true, usage: j.usage });
      } catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 让她下一轮开思考（写个临时开关，core 在发请求前取走并删除，只生效一轮）
    if (req.method === 'POST' && req.url === '/api/thinking/ask') {
      try {
        fs.writeFileSync(path.join(ROOT, 'data', 'think-request.json'), JSON.stringify({ at: Date.now() }), 'utf8');
        return json({ ok: true });
      } catch (e) { return json({ error: '写不了开关：' + e.message }); }
    }
    // 拖拽换分类：把文件归到另一个大类（写进 config.panel.catOverride）
    if (req.method === 'POST' && req.url === '/api/cat') {
      const fid = String(d.file || '');
      const cat = String(d.cat || '');
      if (!fid || !CAT_MAP[cat]) return json({ error: '分类不对' });
      try {
        writeCatOverride(fid, cat);
        const fo = readFolderOf(); delete fo[fid]; writeFolderOf(fo);   // 换类 = 出文件夹，落到这个类的根上
        return json({ ok: true });
      }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 把文件拖进某个文件夹（folder 空 = 挪出文件夹，回到所在大类的根上）
    if (req.method === 'POST' && req.url === '/api/folder') {
      const fid = String(d.file || '');
      const folder = String(d.folder || '');
      if (!fid) return json({ error: '没说要挪哪个文件' });
      const folders = readFolders();
      if (folder && !folders.some(f => f.id === folder)) return json({ error: '没有这个文件夹' });
      try {
        const fo = readFolderOf();
        if (folder) fo[fid] = folder; else delete fo[fid];
        writeFolderOf(fo);
        return json({ ok: true });
      } catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 新建文件夹（页内输入，不用浏览器弹窗）
    if (req.method === 'POST' && req.url === '/api/folder/new') {
      const name = String(d.name || '').trim();
      const cat = String(d.cat || '');
      const parent = String(d.parent || '');
      if (!name || name.length > 20) return json({ error: '名字不太对（1~20 字）' });
      const folders = readFolders();
      if (parent && !folders.some(f => f.id === parent)) return json({ error: '没有这个父文件夹' });
      const id = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 36 * 36).toString(36);
      folders.push({ id, name, cat: CAT_MAP[cat] ? cat : 'other', parent });
      try { writeFolders(folders); return json({ ok: true, id }); }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 文件夹改名
    if (req.method === 'POST' && req.url === '/api/folder/rename') {
      const id = String(d.id || '');
      const name = String(d.name || '').trim();
      const folders = readFolders();
      const f = folders.find(x => x.id === id);
      if (!f) return json({ error: '没有这个文件夹' });
      if (!name || name.length > 20) return json({ error: '名字不太对（1~20 字）' });
      f.name = name;
      try { writeFolders(folders); return json({ ok: true }); }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 移动文件夹：拖到大类标题 = 换大类；拖到别的文件夹 = 嵌套进去
    if (req.method === 'POST' && req.url === '/api/folder/move') {
      const id = String(d.id || '');
      const cat = String(d.cat || '');
      const parent = String(d.parent || '');
      const folders = readFolders();
      const f = folders.find(x => x.id === id);
      if (!f) return json({ error: '没有这个文件夹' });
      if (parent) {
        if (parent === id) return json({ error: '不能拖进自己里面' });
        if (folderWithDescendants(id, folders).has(parent)) return json({ error: '不能拖进自己的子文件夹里' });
        if (!folders.some(x => x.id === parent)) return json({ error: '没有这个父文件夹' });
        f.parent = parent;
        f.cat = (folders.find(x => x.id === parent) || {}).cat || f.cat;
      } else {
        if (!CAT_MAP[cat]) return json({ error: '分类不对' });
        f.parent = '';
        f.cat = cat;
      }
      try { writeFolders(folders); return json({ ok: true }); }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 删除文件夹：里面的文件落回所在大类的根，子文件夹提到大类根下
    if (req.method === 'POST' && req.url === '/api/folder/delete') {
      const id = String(d.id || '');
      const folders = readFolders();
      const f = folders.find(x => x.id === id);
      if (!f) return json({ error: '没有这个文件夹' });
      const doomed = folderWithDescendants(id, folders);
      folders.forEach(x => { if (x.parent && doomed.has(x.parent) && x.id !== id) { x.parent = ''; x.cat = f.cat; } });
      const rest = folders.filter(x => x.id !== id);
      const fo = readFolderOf();
      Object.keys(fo).forEach(k => { if (doomed.has(fo[k])) delete fo[k]; });
      try { writeFolders(rest); writeFolderOf(fo); return json({ ok: true }); }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    // 在浏览器里直接打开某个 html（面板里「在浏览器里打开」按钮用；只在 127.0.0.1 上，只给白名单扩展名）
    if (req.method === 'GET' && req.url.startsWith('/view/')) {
      const id = decodeURIComponent(req.url.slice('/view/'.length).split('?')[0]);
      const p = (id && /\.html?$/i.test(id)) ? rawOk(id) : null;
      if (!p) return send(404, 'text/plain; charset=utf-8', '打不开这个文件');
      try { return send(200, 'text/html; charset=utf-8', fs.readFileSync(p, 'utf8')); }
      catch (e) { return send(404, 'text/plain; charset=utf-8', '读不出来：' + e.message); }
    }
    // 看 / 改原文：代码只读；config、json 可改（json 先校验格式，坏的不让存）
    if (req.method === 'GET' && req.url.startsWith('/api/raw?')) {
      const id = decodeURIComponent((req.url.split('?')[1] || '').replace(/^id=/, ''));
      const p = rawOk(id);
      if (!p) return json({ error: '看不了这个文件' });
      let raw = '';
      try { raw = fs.readFileSync(p, 'utf8'); } catch {}
      const m = metaOf(id) || {};
      // 代码文件 → 按「段」切开，每段配悬停说明（主人 2026-10-23 定：鼠标悬停每一段解释）
      let segs = null;
      if (/\.js$/i.test(id) && raw) {
        try {
          const parts = segJs(raw);
          const tips = segTipsFor(id, parts);
          segs = parts.map((code, i) => ({ code, tip: tips[i] || '' }));
        } catch { segs = null; }
      }
      return json({ raw, ro: !!m.ro || /\.js$/i.test(id), use: m.use || '', range: m.range || '', kind: m.kind || '', segs });
    }
    if (req.method === 'POST' && req.url === '/api/raw') {
      const id = String(d.id || '');
      const p = rawOk(id);
      if (!p) return json({ error: '写不了这个文件' });
      if (/\.js$/i.test(id)) return json({ error: '代码文件只读，怕你碰坏它' });
      const raw = String(d.raw == null ? '' : d.raw);
      if (/\.jsonl$/i.test(id)) {
        for (const ln of raw.split('\n')) { if (ln.trim()) { try { JSON.parse(ln); } catch (e) { return json({ error: '有一行不是合法 JSON，没保存：' + e.message }); } } }
      } else if (/\.json$/i.test(id)) {
        try { JSON.parse(raw); } catch (e) { return json({ error: 'JSON 格式不对，没保存：' + e.message }); }
      }
      fs.writeFileSync(p, raw, 'utf8');
      return json({ ok: true, sig: sigOf(id) });
    }
    // 改数值（v71，主人定「规矩里的数字要能改」）：白名单键 + 数字校验，写回 config.json。
    // bot 侧 merge/grpAuto/chime/greeting 已走 mtime 现读（cfgLive），改完不用重启。
    // ===== AstrBot 模型池（2026-11-10 她令「直接接入 AstrBot」）：客户端能看能用 =====
    // 只读 AstrBot 的配置，不改它一分；只回模型名与源，Key 一个字都不返回。
    if (req.method === 'GET' && req.url === '/api/llmpool') {
      const lc = configStore.load().llm || {};
      let models = [], sources = [], err = '';
      try { models = astrbotLlm.list(); sources = astrbotLlm.sources(); } catch (e) { err = e.message || '读不到 AstrBot 配置'; }
      return json({
        ok: true,
        current: {
          endpoint: lc.endpoint || '',
          model: lc.model || '',
          fallbacks: Array.isArray(lc.fallbackModels) ? lc.fallbackModels : [],
          hasKey: !!String(lc.apiKey || '').trim(),
        },
        astrbot: { models, sources, error: err },
      });
    }
    // ===== 兜底词池（2026-11-13 主人令）：聊天记录页里按群 / 私聊 / 某人 / 平台增、删、改 =====
    // 唯一数据 = config/features.json → offline.pool；走 configStore.patch 原子落盘，
    // 机器人 core.offlinePoolPick 现读 cfgLive，改完不用重启。offline.line 不删，留作池空时的默认兜底。
    if (req.method === 'GET' && req.url === '/api/fallbackpool') {
      const o = configStore.load().offline || {};
      return json({ ok: true, pool: Array.isArray(o.pool) ? o.pool : [],
        defaultLine: o.line || '我现在有点忙，让我的主人替我回答吧' });
    }
    if (req.method === 'POST' && req.url === '/api/fallbackpool') {
      if (!Array.isArray(d.pool)) return json({ error: '兜底池格式不对，没保存' });
      const before = configStore.load().offline || {};
      const normScope = s => {
        const t = String(s || '').trim();
        if (!t) return '';
        if (t === 'private' || /^[gp]\d{3,15}$/.test(t)) return t;
        return /^[A-Za-z0-9_-]{1,20}$/.test(t) ? t : '';
      };
      const clean = d.pool.slice(0, 60).map((x, i) => ({
        id: String((x && x.id) || ('fb-' + Date.now() + '-' + i)).slice(0, 60),
        text: String((x && x.text) || '').trim().slice(0, 500),
        scope: normScope(x && x.scope),
        enabled: !(x && x.enabled === false),
      })).filter(x => x.text);
      const r = configStore.patch('offline', Object.assign({}, before, { pool: clean }));
      if (!r.ok) return json({ error: r.error });
      botWrite('config/features.json', '兜底词池', '改成 ' + clean.length + ' 条');
      return json({ ok: true, pool: clean, defaultLine: before.line || '我现在有点忙，让我的主人替我回答吧' });
    }
    // ===== 保健提醒（2026-11-10 主人定）：配置、四个池、按人约定，客户端这一页全都能看能改 =====
    // 写入复用 configStore.patch（按分区原子落盘，机器人 cfgLive 热读，改完不用重启）与
    // core.addonSet（约定和说话方式约定同一份 topics.jsonl，不另建数据文件）。
    if (req.method === 'GET' && req.url === '/api/healthremind') {
      const full = configStore.load();
      const h = full.healthRemind || {};
      const keys = Array.isArray(h.atKeys) ? h.atKeys : ['masterQQ', 'oniiQQ'];
      const names = { masterQQ: '主人', oniiQQ: '欧尼酱' };
      const list = keys.map(k => {
        const qq = String(full[k] || '');
        let override = null;
        try { override = qq ? core.addonOf(qq, 'healthRemind') : null; } catch {}
        return { key: k, name: names[k] || k, qq, override };
      });
      return json({ ok: true, cfg: h, people: list });
    }
    if (req.method === 'POST' && req.url === '/api/healthremind') {
      const next = d.cfg;
      if (!next || typeof next !== 'object' || Array.isArray(next)) return json({ error: '配置格式不对，没保存' });
      const before = configStore.load().healthRemind || {};
      // 白名单：只收这一页真正会显示的字段，别把整份 features.json 冲掉
      const KEYS = ['enabled', 'groupId', 'atKeys', 'workdays', 'workStartHour', 'workEndHour',
        'quietStartHour', 'quietEndHour', 'minGapMin', 'speakDelayMin', 'dailyMin', 'dailyMax',
        'tickIntervalSec',
        'weeklyExtraMin', 'delayMinMin', 'delayMaxMin', 'makeupAsWorkday',
        'holidayUrl', 'holidayBackupUrl', 'holidayCacheDays',
        'mainWork', 'mainRest', 'extraWork', 'extraRest'];
      const clean = {};
      for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(next, k)) clean[k] = next[k];
      // 四池只收 {act}（她 2026-11-11 定：不给动作配预写话术，怎么说由人设决定）。
      // 这里挡一下旧客户端把 lines 又写回来，免得配置里重新长出话术池。
      for (const pk of ['mainWork', 'mainRest', 'extraWork', 'extraRest']) {
        if (!Array.isArray(clean[pk])) continue;
        clean[pk] = clean[pk]
          .map(x => ({ act: String((x && (x.act || x.text)) || '').trim() }))
          .filter(x => x.act)
          .slice(0, 60);
      }
      const r = configStore.patch('healthRemind', Object.assign({}, before, clean));
      if (!r.ok) return json({ error: r.error });
      // 只比「这次真传了值的键」：以前拿整张 KEYS 去比，没传的键是 undefined，
      // 会被判成变化 → 只改一个数也报「改了 24 项」，写进日志和客户端提示都是噪音。
      const changed = Object.keys(clean).filter(k => JSON.stringify(before[k]) !== JSON.stringify(clean[k]));
      const note = String(d.note || '').slice(0, 200);
      botWrite('config/features.json', '保健提醒', '改了：' + (changed.join('、') || '无') + (note ? '；说明：' + note : ''));
      return json({ ok: true, changed, note });
    }
    if (req.method === 'POST' && req.url === '/api/healthremind/pact') {
      const full = configStore.load();
      const who = String(d.who || '');
      const qq = String(full[who] || '');
      if (!qq) return json({ error: '找不到这个人的 QQ 号' });
      const names = { masterQQ: '主人', oniiQQ: '欧尼酱' };
      const nick = names[who] || who;
      // 按人约定只剩「对这个人开/关」（她 2026-11-11 定：话术由人设决定，不给个人配话术）。
      // 老客户端还会带 lines，直接忽略、不落盘。
      const patch = { enabled: d.enabled !== false };
      const it = core.addonSet(qq, nick, 'healthRemind', patch, String(d.note || '').slice(0, 200));
      if (!it) return json({ error: '约定没记成' });
      return json({ ok: true, changes: it.addon.changes, note: it.addon.note });
    }

    // ===== 提醒 · 闹钟（2026-11-24 主人定）=====
    // 她自己承诺 → 自己定时 → 到点兑现。数据 src/data/alarms.json 唯一一份，配置 config/features.json 的 alarms 段。
    // 面板只做读四组 / 改状态 / 手加 / 删 / 改配置；判定与发送在 bot 侧（qq.js + alarms.js）。
    if (req.method === 'GET' && req.url === '/api/alarms') {
      return json({ ok: true, groups: alarms.grouped(), cfg: alarms.conf() });
    }
    if (req.method === 'POST' && req.url === '/api/alarms') {
      const action = String(d.action || 'status');
      const noteUser = String(d.note || '').slice(0, 200);
      if (action === 'cfg') {
        const next = d.cfg;
        if (!next || typeof next !== 'object' || Array.isArray(next)) return json({ error: '配置格式不对，没保存' });
        const before = configStore.load().alarms || {};
        const KEYS = ['enabled', 'maxDays', 'fallbackHours', 'tickSec', 'overdueHours', 'maxKeep', 'gateWords'];
        const clean = {};
        for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(next, k)) clean[k] = next[k];
        if (Array.isArray(clean.gateWords)) clean.gateWords = clean.gateWords.map(x => String(x).trim()).filter(Boolean).slice(0, 200);
        const r = configStore.patch('alarms', Object.assign({}, before, clean));
        if (!r.ok) return json({ error: r.error });
        const changed = Object.keys(clean).filter(k => JSON.stringify(before[k]) !== JSON.stringify(clean[k]));
        botWrite('config/features.json', '闹钟设置', '改了：' + (changed.join('、') || '无') + (noteUser ? '；说明：' + noteUser : ''));
        return json({ ok: true, changed });
      }
      if (action === 'status') {
        const ok = alarms.manualStatus(d.id, d.status, noteUser || '面板手动改的');
        if (!ok) return json({ error: '没找到这条，或状态不对' });
        botWrite('data/alarms.json', '闹钟状态', String(d.id) + ' → ' + String(d.status));
        return json({ ok: true });
      }
      if (action === 'add') {
        if (!d.content || !String(d.content).trim()) return json({ error: '内容不能空' });
        const row = alarms.manualAdd({ content: d.content, text: d.content, dueAt: d.dueAt,
          scope: d.scope, groupId: d.groupId, userId: d.userId, platform: d.platform || 'qq', who: d.who, dueRaw: d.dueRaw });
        botWrite('data/alarms.json', '闹钟手加', String(row.content).slice(0, 60) + (row.tooFar ? '（太久，不定）' : ''));
        return json({ ok: true, row });
      }
      if (action === 'del') {
        const ok = alarms.remove(d.id);
        if (!ok) return json({ error: '没找到这条' });
        botWrite('data/alarms.json', '闹钟删除', String(d.id));
        return json({ ok: true });
      }
      return json({ error: '不认识的 action：' + action });
    }

    // ===== 提醒 · 洛克王国远行商人（2026-11-21 主人定）=====
    // 数据源、盯哪些商品、发到哪个群都在 config/features.json → rocoMerchant；
    // @ 谁不在这里配：由固定标签「洛克王国」持有人 + 本人接受（topics.jsonl 的 addon）现算。
    if (req.method === 'GET' && req.url === '/api/roco') {
      const full = configStore.load();
      const c = full.rocoMerchant || {};
      const tag = String(c.tag || '洛克王国');
      const peopleList = fixedTags.holders(tag).map(qq => {
        const t = fixedTags.of(qq);
        let ov = null;
        try { ov = core.addonOf(qq, 'rocoMerchant'); } catch {}
        return {
          qq,
          name: String((t[0] && t[0].name) || ''),
          tags: t.map(x => x.tag),
          accepted: !!ov && ov.enabled !== false,
          override: ov,
        };
      });
      return json({ ok: true, cfg: c, people: peopleList, state: rocoMerchant.stateOf(), tags: fixedTags.list(), bili: rocoBili.status(), biliCfg: full.rocoBili || {} });
    }
    // ===== 稀有商品 → B站评论区提醒（2026-11-21；同日改成稀有度分额度）=====
    // GET：看任务状态（窗口/今天发了多少/上次结果）；POST：run=立刻跑一跳（会真发评论）、
    // scan=只搜不发（看候选）、stop=停掉这次任务。
    if (req.method === 'GET' && req.url === '/api/roco/bili') {
      return json({ ok: true, status: rocoBili.status(), cfg: (configStore.load().rocoBili || {}) });
    }
    if (req.method === 'POST' && req.url === '/api/roco/bili') {
      const act = String((d && d.action) || '');
      if (act === 'stop') { rocoBili.finish('面板手动停掉'); return json({ ok: true, status: rocoBili.status() }); }
      if (act === 'cfg') {
        const next = (d && d.cfg) || {};
        const before = configStore.load().rocoBili || {};
        const clean = {};
        if ('enabled' in next) clean.enabled = next.enabled !== false;
        const int = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
        if ('maxPerRound' in next) clean.maxPerRound = int(next.maxPerRound, 1, 30);
        if ('maxPerDay' in next) clean.maxPerDay = int(next.maxPerDay, 1, 30);
        if ('gapSecMin' in next) clean.gapSecMin = int(next.gapSecMin, 60, 1800);
        if ('gapSecMax' in next) clean.gapSecMax = int(next.gapSecMax, 60, 1800);
        if ('windowBeforeMin' in next) clean.windowBeforeMin = int(next.windowBeforeMin, 0, 360);
        if ('windowAfterMin' in next) clean.windowAfterMin = int(next.windowAfterMin, 5, 360);
        // 2026-11-21：标签判据与「被回复录人物表」也可在面板改
        if ('tagCheckPerTick' in next) clean.tagCheckPerTick = int(next.tagCheckPerTick, 1, 20);
        if ('recordRepliers' in next) clean.recordRepliers = next.recordRepliers !== false;
        if ('replyPollMin' in next) clean.replyPollMin = int(next.replyPollMin, 3, 120);
        // 2026-11-21 同日追加：稀有度额度 + 弱判据粉丝门槛 + 挑 UP 的三档
        if ('maxRarePerDay' in next) clean.maxRarePerDay = int(next.maxRarePerDay, 1, 30);
        if ('commonOnlyWhenRareLeft' in next) clean.commonOnlyWhenRareLeft = next.commonOnlyWhenRareLeft !== false;
        if ('weakTagFansMin' in next) clean.weakTagFansMin = int(next.weakTagFansMin, 0, 10000000);
        if ('weakTagEnabled' in next) clean.weakTagEnabled = next.weakTagEnabled !== false;
        if ('preferFansMin' in next) clean.preferFansMin = int(next.preferFansMin, 0, 10000000);
        if ('preferPlayMin' in next) clean.preferPlayMin = int(next.preferPlayMin, 0, 10000000);
        if ('minTier' in next) clean.minTier = ['A', 'B', 'C'].indexOf(String(next.minTier).toUpperCase()) >= 0 ? String(next.minTier).toUpperCase() : 'B';
        if ('upCacheHours' in next) clean.upCacheHours = int(next.upCacheHours, 1, 240);
        // 2026-11-22：4 小时的前 3.5 小时发、前 2 小时只发大 UP；被回复后的回评
        if ('bigUpUntilMin' in next) clean.bigUpUntilMin = int(next.bigUpUntilMin, 5, 240);
        if ('lateAllowC' in next) clean.lateAllowC = next.lateAllowC !== false;
        if ('replyEnabled' in next) clean.replyEnabled = next.replyEnabled !== false;
        if ('replyMaxPerPoll' in next) clean.replyMaxPerPoll = int(next.replyMaxPerPoll, 0, 3);
        if ('replyMaxPerDay' in next) clean.replyMaxPerDay = int(next.replyMaxPerDay, 0, 30);
        if ('replyGapSec' in next) clean.replyGapSec = int(next.replyGapSec, 120, 3600);
        if ('replyUseModel' in next) clean.replyUseModel = next.replyUseModel !== false;
        if ('replyAtMaster' in next) clean.replyAtMaster = next.replyAtMaster !== false;
        if ('masterBiliName' in next) clean.masterBiliName = String(next.masterBiliName || '').trim().slice(0, 20) || '虚幻的生物';
        if ('masterBiliMid' in next) clean.masterBiliMid = String(next.masterBiliMid || '').replace(/\D/g, '').slice(0, 20) || '30895294';
        const arr = v => (Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/))
          .map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);
        if ('mobileTags' in next) clean.mobileTags = arr(next.mobileTags);
        if ('weakTags' in next) clean.weakTags = arr(next.weakTags);
        if ('softBlockWords' in next) clean.softBlockWords = arr(next.softBlockWords);
        if ('blockTagWords' in next) clean.blockTagWords = arr(next.blockTagWords);
        if (clean.gapSecMax && clean.gapSecMin && clean.gapSecMax < clean.gapSecMin) {
          const t = clean.gapSecMin; clean.gapSecMin = clean.gapSecMax; clean.gapSecMax = t;
        }
        const r = configStore.patch('rocoBili', Object.assign({}, before, clean));
        if (!r.ok) return json({ error: r.error });
        return json({ ok: true, cfg: configStore.load().rocoBili || {}, changed: Object.keys(clean) });
      }
      if (act === 'scan') {
        // 2026-11-21：候选判据跟真实发放完全一致（标签 + 弱判据粉丝门槛 + A/B/C 三档），
        // 免得面板说「能发」、实际却因为没过万门槛不发。只读，不发评论。
        const c = rocoBili._cfgs();
        const st = rocoBili.status();
        if (!st.task) return json({ error: '现在没有任务（要等棱镜球 / 祝福项坠 / 炫彩蛋那一轮才会安排）' });
        // 2026-11-22：前 2 小时只发大 UP，之后放开 C 档（小 UP 也发，把额度花满）
        const lateStage = Date.now() >= Number(st.task.stageAEnd || 0);
        const tierLimit = (lateStage && c.lateAllowC) ? 'C' : c.minTier;
        try {
          const list = await rocoBili._searchVideos(c.keyword, c.searchPages);
          const ws = st.task.windowStart, we = Math.min(st.task.windowEnd, Date.now());
          const pool = list
            .filter(v => v.pubMs >= ws && v.pubMs <= we)
            .filter(v => rocoBili._isGameType(v))
            .sort((a, b) => b.pubMs - a.pubMs)
            .slice(0, 8);
          const items = [];
          const TAG_RANK = { A: 0, B: 1, C: 2 };
          for (const v of pool) {
            let jd = { hit: false, level: 'none', why: '没查标签' };
            try { jd = rocoBili._judgeTags(await rocoBili._fetchTags(v.bvid)); }
            catch (e) { jd = { hit: false, level: 'none', why: '取标签失败：' + e.message }; }
            let up = null, tier = '';
            if (jd.level !== 'none') {
              try { up = await rocoBili._upStats(v.mid, v.bvid, c); tier = rocoBili._tierOf(up, c); }
              catch (e) { up = null; tier = ''; }
              jd = rocoBili._judgeWithUp(v, jd, up, c);
            }
            items.push({
              bvid: v.bvid, title: v.title, author: v.author,
              pub: new Date(v.pubMs).toLocaleString('zh-CN'),
              hit: !!jd.hit,
              pass: !!jd.hit && !!tier && TAG_RANK[tier] <= TAG_RANK[tierLimit],
              tier, fans: (up && up.fans) || 0, maxPlay: (up && up.maxPlay) || 0,
              why: jd.why || '', tags: jd.tags || [],
            });
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 1200));
          }
          return json({ ok: true, count: items.filter(x => x.pass).length, checked: items.length, minTier: tierLimit, lateStage, items });
        } catch (e) { return json({ error: '搜索失败：' + e.message }); }
      }
      if (act === 'run') {
        const r = await rocoBili.tick();
        return json({ ok: true, result: r, status: rocoBili.status() });
      }
      return json({ error: '不认识的动作：' + act });
    }
    if (req.method === 'POST' && req.url === '/api/roco') {
      const next = d.cfg;
      if (!next || typeof next !== 'object' || Array.isArray(next)) return json({ error: '配置格式不对，没保存' });
      const before = configStore.load().rocoMerchant || {};
      const KEYS = ['enabled', 'groupId', 'tag', 'watchItems', 'dataUrl', 'roundHours', 'offsetsMin', 'retrySec', 'skipStale', 'rarity'];
      const clean = {};
      for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(next, k)) clean[k] = next[k];
      // 稀有度排名（2026-11-21 主人定）：{商品名: 数字}，数字越大越稀有；B站 那条线按它分每日额度
      if ('rarity' in clean) {
        const src = clean.rarity;
        const out = {};
        if (src && typeof src === 'object' && !Array.isArray(src)) {
          for (const k of Object.keys(src).slice(0, 20)) {
            const name = String(k || '').trim().slice(0, 16);
            const n = Number(src[k]);
            if (name && Number.isFinite(n) && n >= 0 && n <= 9) out[name] = Math.round(n);
          }
        }
        clean.rarity = out;
      }
      if ('watchItems' in clean) {
        const arr = Array.isArray(clean.watchItems) ? clean.watchItems : String(clean.watchItems || '').split(/[,，、\s]+/);
        clean.watchItems = arr.map(x => String(x || '').trim()).filter(Boolean).slice(0, 30);
      }
      if ('groupId' in clean) clean.groupId = Number(String(clean.groupId || '').replace(/\D/g, '')) || 0;
      // 一天只出 4 轮，不做秒级轮询（2026-11-21）：轮次小时 + 每轮查的分钟点 + 没发成的补发间隔
      if ('roundHours' in clean) {
        const arr = Array.isArray(clean.roundHours) ? clean.roundHours : String(clean.roundHours || '').split(/[,，、\s]+/);
        clean.roundHours = arr.map(x => Number(String(x).replace(/\D/g, ''))).filter(h => h >= 0 && h < 24).slice(0, 8);
        if (!clean.roundHours.length) clean.roundHours = [8, 12, 16, 20];
      }
      if ('offsetsMin' in clean) {
        const arr = Array.isArray(clean.offsetsMin) ? clean.offsetsMin : String(clean.offsetsMin || '').split(/[,，、\s]+/);
        clean.offsetsMin = arr.map(x => Number(String(x).replace(/\D/g, ''))).filter(m => m >= 0 && m < 60).slice(0, 6);
        if (!clean.offsetsMin.length) clean.offsetsMin = [5, 35];
      }
      if ('retrySec' in clean) clean.retrySec = Math.max(60, Math.min(3600, Number(clean.retrySec) || 300));
      if ('tag' in clean) clean.tag = String(clean.tag || '').trim().slice(0, 24) || '洛克王国';
      if ('dataUrl' in clean) clean.dataUrl = String(clean.dataUrl || '').trim().slice(0, 300);
      if ('enabled' in clean) clean.enabled = clean.enabled !== false;
      if ('skipStale' in clean) clean.skipStale = clean.skipStale !== false;
      const r = configStore.patch('rocoMerchant', Object.assign({}, before, clean));
      if (!r.ok) return json({ error: r.error });
      const changed = Object.keys(clean).filter(k => JSON.stringify(before[k]) !== JSON.stringify(clean[k]));
      botWrite('config/features.json', '提醒 · 洛克王国', '改了：' + (changed.join('、') || '无') + (d.note ? '；说明：' + String(d.note).slice(0, 120) : ''));
      return json({ ok: true, changed });
    }
    // 面板「现在查一次」：只预览这一轮有什么、该 @ 谁，不发消息、不改状态
    if (req.method === 'GET' && req.url === '/api/roco/preview') {
      return json(await rocoMerchant.preview());
    }
    // 本人接受 / 关掉这个提醒：写进同一份附加功能约定（topics.jsonl 的 addon），只对这个人生效
    if (req.method === 'POST' && req.url === '/api/roco/pact') {
      const qq = String(d.qq || '').replace(/\D/g, '');
      if (!qq) return json({ error: '要填 QQ 号' });
      const it = core.addonSet(qq, String(d.name || qq).slice(0, 40), 'rocoMerchant',
        { enabled: d.enabled !== false }, String(d.note || '面板设置远行商人提醒').slice(0, 200));
      if (!it) return json({ error: '约定没记成' });
      return json({ ok: true, changes: it.addon.changes, note: it.addon.note });
    }

    // ===== 固定标签（2026-11-21 主人定）=====
    // 直接加：主人面板随时可加；取消：只有本人原话能删，面板取消要先「解锁一次」（一次性 token）。
    if (req.method === 'GET' && req.url === '/api/fixedtags') {
      const flat = fixedTags.list();
      const by = new Map();
      for (const t of flat) {
        if (!by.has(t.qq)) by.set(t.qq, { qq: t.qq, name: t.name || '', tags: [] });
        const p = by.get(t.qq);
        if (!p.name && t.name) p.name = t.name;
        p.tags.push({ tag: t.tag, from: t.from, note: t.note, at: t.at });
      }
      return json({ ok: true, people: Array.from(by.values()), flat });
    }
    if (req.method === 'POST' && req.url === '/api/fixedtags') {
      const act = String(d.action || '');
      if (act === 'unlock') return json(fixedTags.issueUnlock(d.qq, d.tag));
      if (act === 'add') {
        const r = fixedTags.add({ qq: d.qq, name: d.name, tag: d.tag, from: '主人', note: d.note || '主人在面板直接加' });
        return json(r);
      }
      if (act === 'remove') return json(fixedTags.remove(d.qq, d.tag, { by: 'panel', token: d.token }));
      return json({ error: '不知道要做什么：' + act });
    }

    if (req.method === 'POST' && req.url === '/api/cfgset') {
      const k = String(d.k || '');
      const meta = CFG_EDIT_MAP[k];
      if (!meta) { logWrite('/api/cfgset', d, false, '不在这份名单里', Date.now() - _t0); return json({ error: '这个配置项不在这里改的名单里：' + k }); }
      const v = Number(d.v);
      if (!Number.isFinite(v)) { logWrite('/api/cfgset', d, false, '不是数字', Date.now() - _t0); return json({ error: '要填数字' }); }
      const store = Math.round(v * meta.scale * 1000) / 1000;
      if (store < 0) { logWrite('/api/cfgset', d, false, '负数', Date.now() - _t0); return json({ error: '不能是负数' }); }
      let conf;
      try { conf = configStore.load(); } catch (e) { logWrite('/api/cfgset', d, false, '读配置失败', Date.now() - _t0); return json({ error: 'config.json 读不了：' + e.message }); }
      const parts = k.split('.');
      let cur = conf;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = store;
      try { configStore.writeFull(conf); } catch (e) { logWrite('/api/cfgset', d, false, '写配置失败：' + e.message, Date.now() - _t0); return json({ error: '写不进去：' + e.message }); }
      logWrite('/api/cfgset', d, true, '', Date.now() - _t0);
      return json({ ok: true });
    }
    // 自动同意记录（2026-11-01）：GET 看有几条新的 + 最近 20 条明细；POST 标记全读完（徽标清零）
    if (req.method === 'GET' && req.url === '/api/accept') {
      const items = acceptItems();
      return json({ ok: true, count: acceptNewList().length, total: items.length, items: items.slice(-20).reverse() });
    }
    if (req.method === 'POST' && req.url === '/api/accept-read') {
      acceptMarkReadLocal();
      return json({ ok: true, count: acceptNewList().length });
    }
    if (req.method === 'GET' && req.url === '/api/meta') {
      const sig = {};
      for (const f of listFiles()) sig[f.id] = sigOf(f.id);
      return json({ sig });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/file?')) {
      const id = decodeURIComponent((req.url.split('?')[1] || '').replace(/^id=/, ''));
      const p = absOk(id);
      if (!p) return json({ error: '读不了' });
      let raw = '';
      try { raw = fs.readFileSync(p, 'utf8'); } catch {}
      return json({ tree: parseMd(raw), sig: sigOf(id) });
    }
    if (req.method === 'POST' && req.url === '/api/save') {
      const p = absOk(d.id || '');
      if (!p) { logWrite('/api/save', d, false, '路径不合法', Date.now() - _t0); return json({ error: '这个文件不能改' }); }
      if (isReadonly(d.id || '')) { logWrite('/api/save', d, false, '只读文件', Date.now() - _t0); return json({ error: '这是只读文件，怕改坏它（要看原文点它即可）' }); }
      if (!d.tree || !Array.isArray(d.tree.children)) { logWrite('/api/save', d, false, '树结构不对', Date.now() - _t0); return json({ error: '数据不对' }); }
      const md = toMd(cleanTree(d.tree));
      // 防清空（v64）：文件本来有内容、这次存出来是空的 → 拒绝落盘。
      // 真事：笑点解析范例就是这样被存空的，模型那次解析只能拿「（范例文件缺失）」硬编。
      if (!md.trim() && fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim()) {
        return json({ error: '这次保存的内容是空的——不给覆盖（文件里还有 ' + fs.readFileSync(p, 'utf8').trim().length + ' 字）。真想清空就先随便留一个字再存。' });
      }
      try { fs.writeFileSync(p, md, 'utf8'); } catch (e) {
        logWrite('/api/save', d, false, '写文件失败：' + e.message, Date.now() - _t0);
        return json({ error: '写不进这个文件：' + e.message });
      }
      logWrite('/api/save', d, true, '', Date.now() - _t0);
      return json({ ok: true, sig: sigOf(d.id), md });
    }
    if (req.method === 'POST' && req.url === '/api/create') {
      if (!okName(d.name)) return json({ error: '名字不合法（别带 \\ / : * ? " < > |，40 字以内）' });
      const dir = DIRS.includes(d.dir) ? d.dir : 'data';
      const id = dir + '/' + d.name + '.md';
      const p = absOk(id);
      if (!p) return json({ error: '路径不合法' });
      if (fs.existsSync(p)) return json({ error: '已经有同名文件了' });
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '# ' + d.name + '\n', 'utf8');
      return json({ ok: true, id });
    }
    if (req.method === 'POST' && req.url === '/api/rename') {
      const p = absOk(d.id || '');
      if (!p) return json({ error: '这个文件不能改' });
      if (!okName(d.name)) return json({ error: '名字不合法' });
      const np = path.join(path.dirname(p), d.name + '.md');
      if (fs.existsSync(np)) return json({ error: '已经有同名文件了' });
      const isSys = Object.values(sysIds()).includes(rel(p));
      if (isSys) syncConfig(rel(p), rel(np));
      fs.renameSync(p, np);
      return json({ ok: true, id: rel(np), needRestart: isSys });
    }
    if (req.method === 'POST' && req.url === '/api/order') {
      if (!Array.isArray(d.order)) return json({ error: '数据不对' });
      const valid = listFiles().map(f => f.id);
      const ord = d.order.filter(x => typeof x === 'string' && valid.includes(x));
      for (const v of valid) if (!ord.includes(v)) ord.push(v);
      try { writeOrder(ord); return json({ ok: true }); }
      catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/delete') {
      const p = absOk(d.id || '');
      if (!p) return json({ error: '这个文件不能删' });
      if (Object.values(sysIds()).includes(rel(p))) return json({ error: '这是机器人要用的文件，不能删（内容随便改）' });
      fs.unlinkSync(p);
      const nw = readNews(); delete nw[d.id]; writeNews(nw);
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/seen') {
      const nw = readNews();
      const list = Array.isArray(d.hashes) ? d.hashes : [];
      const cur = nw[d.id] || [];
      nw[d.id] = cur.filter(h => list.indexOf(h) < 0);
      if (!nw[d.id].length) delete nw[d.id];
      writeNews(nw);
      return json({ ok: true });
    }

    // ===== 顶栏状态：NapCat 连接、待确认口味数、喜好重合、满好感人数 =====
    if (req.method === 'GET' && req.url === '/api/status') {
      let bot = {};
      try { bot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bot-status.json'), 'utf8')) || {}; } catch {}
      let pending = 0;
      try {
        const md = fs.readFileSync(path.join(ROOT, 'data', '人物喜好.md'), 'utf8');
        const seg = md.split(/###\s*待确认/)[1] || '';
        pending = (seg.split(/\n###/)[0].match(/^\s*[-*]\s+\S/gm) || []).length;
      } catch {}
      // 好感度：过 60 算喜欢、满 100 才宝宝（主人 2026-10-22）；重合条目留给主人决定
      let clashN = 0, favLike = 0, favFull = 0, favor = [];
      try {
        const t = require('../taste');
        clashN = t.clashCount();
        favor = require('../favor').all();
        favLike = favor.filter(x => x.v >= 60).length;
        favFull = favor.filter(x => x.v >= 100).length;
      } catch {}
      const thinking = !!bot.thinking && (Date.now() - (Date.parse(bot.thinkingAt || bot.at || '') || 0) < 120000);
      // 灯要如实（v88）：进程一死，bot-status.json 会冻在最后一刻、里面还是 online:true，
      // 只看文件面板就一直亮绿灯。所以探一下里面的 pid —— 探不到就按离线显示。
      let pidAlive = null;
      if (bot.pid) {
        try { process.kill(bot.pid, 0); pidAlive = true; }
        catch (e) { pidAlive = e && e.code === 'EPERM'; }
      }
      // 虚幻自查：当前还没解决的问题（selfwatch 每 5 分钟更新；文件不存在 = 还没跑过，不算有病）
      let selfBad = 0, selfT = '';
      try {
        const sw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'selfwatch-state.json'), 'utf8')) || {};
        selfBad = (sw.open || []).length;
        selfT = sw.t || '';
      } catch {}
      let fbN = 0;
      try { fbN = fs.readFileSync(path.join(ROOT, 'data', 'ai-feedback.jsonl'), 'utf8').split('\n').filter(l => l.trim()).length; } catch {}
      // 暂停中的群/人（她闭嘴了）：状态栏要显眼地告诉主人，否则会以为她坏了
      let paused = [];
      try {
        const now0 = Date.now();
        paused = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pause.json'), 'utf8')) || [])
          .filter(x => x && x.kind && x.id && (!x.until || x.until > now0))
          .map(x => (x.kind === 'group' ? '群' : '私聊 ') + x.id);
      } catch {}
      // 自动同意徽标（2026-11-01）：状态栏那颗「加群/好友 N」
      const reqNew = acceptNewList().length;
      return json({ online: !!bot.online && pidAlive !== false, pidAlive, botPid: bot.pid || 0, botAt: bot.at || '', botDetail: bot.detail || '', thinking, pending, panelOk: true, clashN, favLike, favFull, selfBad, selfT, fbN, paused, reqNew });
    }

    // ===== 表情功能（v88）：三样东西一次给全，面板才画得出「谁对不上谁」 =====
    // ① 文件夹里真实存在哪些图 ② 常用表情单写了哪些「名字：场合」 ③ 情绪 → 触发词表
    // 只读，一个字节都不改（改文件还是走 /api/raw，有校验）。
    if (req.method === 'GET' && req.url === '/api/stickers') return json(stickerSnapshot());

    /* ===== 情绪书（2026-11-07 主人定）=====
     * 一棵树：6 大类 → 21 分支 → 叶。读给面板，整棵树回存。 */
    if (req.method === 'GET' && req.url === '/api/emobook') {
      try {
        const et = require('../emotion-tree');
        const snap = stickerSnapshot();
        /* 审核联动（主人 2026-11-07 纠正：标黄 = 没看过，判错 = 主人改过）：
         * 按叶聚合每条情绪判断记录的审核状态。只读，不改记录本身。 */
        const review = et.reviewCounts();
        return json({ ok: true, tree: et.tree(), imgs: snap.imgs || [], recent: et.recent(300),
          ratio: (et.load() || {}).ratio || {}, review });
      } catch (e) { return json({ ok: false, error: '情绪书读不出来：' + e.message }); }
    }
    /* 审一条情绪判断：没错 / 判错（判错带正确的叶名） */
    if (req.method === 'POST' && req.url === '/api/emobook/review') {
      try {
        const et = require('../emotion-tree');
        const t = d.t, action = d.action, leaf = d.leaf;
        if (!t || (action !== 'ok' && action !== 'wrong')) return json({ ok: false, error: '参数不对' });
        et.markReview(t, action, leaf);
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/emobook/save') {
      try {
        const et = require('../emotion-tree');
        const b = d.book || d;
        if (!b || !Array.isArray(b.leaves)) return json({ ok: false, error: '没有 leaves，没存' });
        et.save(b);
        return json({ ok: true, leaves: b.leaves.length });
      } catch (e) { return json({ ok: false, error: '存不进去：' + e.message }); }
    }
    /* 从外部拖图进面板 → base64 落盘到 少用/（和 AstrBot 收图同一个落点） */
    if (req.method === 'POST' && req.url === '/api/stickers/upload') {
      try {
        const data = String(d.data || '');
        const m = data.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i);
        if (!m) return json({ ok: false, error: '不是图片' });
        const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 8 * 1024 * 1024) return json({ ok: false, error: '图太大（超过 8MB）' });
        let name = String(d.name || '').trim().replace(/[\\/:*?"<>|\r\n\t]/g, '');
        if (!name) name = 'q' + Date.now();
        const dir = path.join(ROOT, 'data', 'stickers', '少用');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        let f = name + '.' + ext, i = 2;
        while (fs.existsSync(path.join(dir, f))) { f = name + i + '.' + ext; i++; }
        fs.writeFileSync(path.join(dir, f), buf);
        return json({ ok: true, file: '少用/' + name, name });
      } catch (e) { return json({ ok: false, error: '存图失败：' + e.message }); }
    }

    // 表情「重制」（2026-10-31 主人第 8 条）：把自动补出来的描述**正式写进场合表**，
    // 写完这些图就不算「自动分类」了（面板里颜色变回普通），计数也归零。
    if (req.method === 'POST' && req.url === '/api/stickers/commit') {
      try {
        const SDIR = path.join(ROOT, 'data', 'stickers');
        const MD = path.join(SDIR, '常用.md');
        const imgs = [];
        for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/']]) {
          const p = dir ? path.join(SDIR, dir) : SDIR;
          try { for (const f of fs.readdirSync(p)) if (/\.(png|jpe?g|gif|webp)$/i.test(f)) imgs.push(pre + f.replace(/\.[^.]+$/, '')); } catch {}
        }
        let lines = [];
        try { lines = fs.readFileSync(MD, 'utf8').split('\n'); } catch {}
        const key = s => String(s).replace(/[\s，。！？、；：,.;:!?「」『』（）()]/g, '');
        /* 登记「表里写过的图」。除了原样名字，还要把**族名**记下来：
         * 表里写 `q哭` 就代表 q哭1~q哭9 全都在册（提示词里也是这么算的）。
         * 2026-11-07 主人：「去掉重复提示词，因为表情包名字即提示词」——
         * 以前只认原样名字，于是每次「重制」都给 q哭1、哭2 各补一行（- 哭：哭1），
         * 跟已有的「- 哭、难过…：哭、悲伤、q哭」撞成两行同一族。认族名之后就不会再长出来。 */
        const inBook = new Set();
        const inFam = new Set();
        const addBook = raw => {
          const n = String(raw == null ? '' : raw).trim();
          if (!n) return;
          inBook.add(n);
          inFam.add(n.replace(/^[qQ]/, '').replace(/\d+$/, ''));
          inFam.add(n.replace(/\d+$/, ''));
        };
        for (const l of lines) {
          const m = l.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+)$/);
          if (m) for (const n of m[2].split(/[、,，/｜|]/)) addBook(n);
          // 描述框空着的行（`- 图名1、图名2`）也算写过
          const m2 = l.match(/^[-*]\s*(?![^:：]*[:：])(.+)$/);
          if (m2) for (const n of m2[1].split(/[、,，/｜|]/)) addBook(n);
        }
        let added = 0;
        for (const f of imgs) {
          const n = String(f).split('/').pop();
          if (inBook.has(n) || inFam.has(n.replace(/^[qQ]/, '').replace(/\d+$/, ''))) continue;
          if (!core.stickerIsEmotion(f)) continue;          // 关键词类不写描述
          const auto = core.stickerAutoOcc(n);
          if (!auto) continue;                              // 补不出来的留给人（= bug 清单）
          const k = key(auto);
          let hit = -1;
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^[-*]\s*(.+?)\s*[:：]\s*(.+)$/);
            if (m && key(m[1]) === k) { hit = i; break; }
          }
          if (hit >= 0) lines[hit] = lines[hit].replace(/([:：]\s*)([^:：]+)\s*$/, (a, sep, names) => sep + names.replace(/\s*$/, '') + '、' + n);
          else lines.push('- ' + auto + '：' + n);
          addBook(n); added++;
        }
        fs.writeFileSync(MD, lines.join('\n'), 'utf8');
        return json({ ok: true, added });
      } catch (e) { return json({ error: '重制失败：' + String(e.message).slice(0, 100) }); }
    }

    // ===== 表情包改图名（2026-11-01 主人：「能在面板直接改图片名」）=====
    // 为什么要动文件而不是只改显示名：图名 = 磁盘上的文件名 = 提示词和 [表情:名字] 里用的那个名字，三者是同一个东西。
    // 改完三步接力，她不用再去碰文件：
    //   ① fs.renameSync 真改名（保留原扩展名）
    //   ② stickerReconcile()：按 md5 认出「还是同一张图」，把 常用.md 那一行 / .md5.json 里的路径一起换掉
    //   ③ 情绪表情.json：① 表里「同名情绪」跟着改（开心 → 小开心），不会突然变成「没图」
    // 提示词清单「重生成」（2026-11-01 主人定）：她改完场合表/丢进新图，点一下立刻重算。
    // 平时不用点 —— 提示词那边签名对不上会自己重建（core.stickerPrompt）。
    if (req.method === 'POST' && req.url === '/api/stickers/promptlist') {
      try {
        const core = require('../core');
        const txt = core._stickerListRebuild() || '';
        const LP = path.join(ROOT, 'data', 'stickers', '清单.md');
        let at = 0;
        try { at = fs.statSync(LP).mtimeMs; } catch {}
        return json({ ok: true, rows: txt.split('\n').filter(l => /^-\s/.test(l)).length,
          chars: txt.length, at, pending: core._stickerPending() || [] });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (req.method === 'POST' && req.url === '/api/stickers/rename') {
      try {
        const SDIR = path.join(ROOT, 'data', 'stickers');
        const from = String(d.from || '').trim();
        const rawTo = String(d.to || '').trim();
        // 只认这四个位置（根目录 + 三个池），和 /api/stkimg 一个口径，越界一律找不到
        let hit = null;
        for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/'], ['关键词触发', '关键词触发/'], ['少用', '少用/']]) {
          const p = dir ? path.join(SDIR, dir) : SDIR;
          let list = [];
          try { list = fs.readdirSync(p); } catch { continue; }
          for (const f of list) {
            if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
            const bare = f.replace(/\.[^.]+$/, '');
            if (pre + bare === from || (from.indexOf('/') < 0 && bare === from)) { hit = { abs: path.join(p, f), ext: path.extname(f), bare, dir: p }; break; }
          }
          if (hit) break;
        }
        if (!hit) return json({ error: '找不到这张图（' + from + '），刷新页面再试' });
        // 新名字：去掉文件名里不能出现的字符（/ \ : * ? " < > | 和控制字符），首尾空格/点也去掉
        const to = rawTo.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 24);
        if (!to) return json({ error: '新名字是空的：不能只有空格，也不能带 / \\ : * ? " < > |' });
        if (to === hit.bare) return json({ error: '和原名一样，没有改' });
        const target = path.join(hit.dir, to + hit.ext);
        if (fs.existsSync(target)) return json({ error: '这个文件夹里已经有叫「' + to + '」的图了' });
        fs.renameSync(hit.abs, target);
        // ② 对账：改名接上（图还在、名字变了 → 把场合表里的旧名字换成新名字）
        let rec = { renamed: [], fixed: 0 };
        try { rec = require('../connectors/qq.js')._stickerReconcile() || rec; }
        catch (e) { console.log('[panel] 改名后对账失败：' + e.message); }
        // ③ 情绪表跟着改（只在「这条情绪原来就只靠这张图」时才改，别的一律不动）
        const oldStem = core.stickerStem(hit.bare), newStem = core.stickerStem(to);
        const emoChanged = [];
        if (oldStem !== newStem) {
          try {
            const EMO = path.join(ROOT, 'data', '情绪表情.json');
            const arr = JSON.parse(fs.readFileSync(EMO, 'utf8'));
            if (Array.isArray(arr)) {
              const owners = arr.filter(x => x && String(x.cat) === oldStem);
              if (owners.length === 1) {
                owners[0].cat = newStem;
                fs.writeFileSync(EMO, JSON.stringify(arr, null, 1) + '\n', 'utf8');
                emoChanged.push(oldStem + ' → ' + newStem);
              }
            }
          } catch (e) { console.log('[panel] 情绪表没跟着改：' + e.message); }
        }
        return json({
          ok: true, from: hit.bare, to, fixed: rec.fixed || 0, emoChanged,
          msg: '「' + hit.bare + '」改成「' + to + '」'
            + ((rec.fixed || 0) ? '，场合表跟着改了 ' + rec.fixed + ' 处' : '')
            + (emoChanged.length ? '，情绪表也改成「' + newStem + '」' : ''),
        });
      } catch (e) { return json({ error: '改名失败：' + String(e.message).slice(0, 120) }); }
    }

    /* ===== 表情包「删图」（2026-11-07 主人：缩略图上的叉就是删图）=====
     * 她说的是：「点叉做成删图，我刚刚点了个叉发现不是删」—— 以前的叉只是「从这一类里拿掉」。
     * 现在删的是磁盘上的真文件，但**不直接抹掉**：
     *   ① 文件挪进 data/stickers/回收站/（同名的加时间戳，随时手捡回来）
     *   ② 场合表里把这个名字摘掉（那一行还有别的话/别的图就留着，空了就整行去掉）
     *   ③ .md5.json 里这一张的指纹删掉（不然面板上「已失效」越积越多）
     * 不碰 情绪表情.json：情绪留着，只是变成「没图」，她以后放回同名图就自动接上。 */
    if (req.method === 'POST' && req.url === '/api/stickers/delete') {
      try {
        const SDIR = path.join(ROOT, 'data', 'stickers');
        const from = String(d.name || '').trim();
        if (!from) return json({ error: '没告诉我要删哪张' });
        let hit = null;
        for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/'], ['关键词触发', '关键词触发/'], ['少用', '少用/']]) {
          const p = dir ? path.join(SDIR, dir) : SDIR;
          let list = [];
          try { list = fs.readdirSync(p); } catch { continue; }
          for (const f of list) {
            if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
            const bare = f.replace(/\.[^.]+$/, '');
            // 名字可能带池前缀（少用/xxx），也可能只是裸名（表里的写法）—— 两种都认
            if (pre + bare === from || (from.indexOf('/') < 0 && bare === from)) { hit = { abs: path.join(p, f), file: f, bare, rel: pre + f }; break; }
          }
          if (hit) break;
        }
        if (!hit) return json({ error: '找不到这张图（' + from + '），刷新页面再试' });
        // ① 挪进回收站
        const TRASH = path.join(SDIR, '回收站');
        fs.mkdirSync(TRASH, { recursive: true });
        let target = path.join(TRASH, hit.file);
        if (fs.existsSync(target)) {
          const ext = path.extname(hit.file), base = hit.file.replace(/\.[^.]+$/, '');
          target = path.join(TRASH, base + '-' + Date.now() + ext);
        }
        fs.renameSync(hit.abs, target);
        // ② 场合表 / 关键词表：摘掉这个名字
        let touched = 0;
        for (const tb of [path.join(SDIR, '常用.md'), path.join(SDIR, '关键词触发', '关键词.md')]) {
          let lines = [];
          try { lines = fs.readFileSync(tb, 'utf8').split('\n'); } catch { continue; }
          let changed = false;
          const out = [];
          for (const l of lines) {
            const m = l.match(/^([-*]\s*)(.+?)(\s*[:：]\s*)(.+)$/);
            if (m) {
              const names = m[4].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean);
              if (names.indexOf(hit.bare) < 0) { out.push(l); continue; }
              const rest = names.filter(x => x !== hit.bare);
              changed = true; touched++;
              // 描述还在就留成「- 描述」（纯描述，等她哪天把图放回来）
              out.push(m[2].trim() ? m[1] + m[2].trim() : null);
              if (rest.length) out[out.length - 1] = m[1] + m[2].trim() + m[3] + rest.join('、');
              continue;
            }
            const m2 = l.match(/^([-*]\s*)([^:：]+)$/);
            if (m2) {
              const names = m2[2].split(/[、,，/｜|]/).map(x => x.trim()).filter(Boolean);
              if (names.indexOf(hit.bare) >= 0) {
                const rest = names.filter(x => x !== hit.bare);
                changed = true; touched++;
                if (rest.length) out.push(m2[1] + rest.join('、'));
                continue;
              }
            }
            out.push(l);
          }
          if (changed) { try { fs.writeFileSync(tb, out.filter(x => x != null).join('\n'), 'utf8'); } catch {} }
        }
        // ③ 指纹
        let fp = 0;
        try {
          const MP = path.join(SDIR, '.md5.json');
          const store = JSON.parse(fs.readFileSync(MP, 'utf8')) || {};
          for (const [k, v] of Object.entries(store)) {
            const f = typeof v === 'string' ? v : (v && v.f) || '';
            if (f === hit.rel) { delete store[k]; fp++; }
          }
          if (fp) fs.writeFileSync(MP, JSON.stringify(store), 'utf8');
        } catch (e) { console.log('[panel] 删图后清指纹失败：' + e.message); }
        try { require('../connectors/qq.js')._stickerReconcile(); } catch {}
        try { core._stickerListRebuild(); } catch {}
        return json({ ok: true, name: hit.bare, msg: '已删「' + hit.bare + '」（图挪进了 回收站/，场合表改了 ' + touched + ' 处' + (fp ? '，清了 ' + fp + ' 条指纹' : '') + '）' });
      } catch (e) { return json({ error: '删图失败：' + String(e.message).slice(0, 120) }); }
    }

    // ===== 表情包「维护」（2026-11-01 主人：她只认面板，不许让她开黑窗口敲命令）=====
    // 原来这两个功能在一个 .command 命令行脚本里，她按 3 没反应、按 4 是重复数字 —— 搬进面板。
    // 管两件事：① 清理已删图的指纹（.md5.json 不越攒越大）② 「用模型补描述」开关（默认关，开了才花积分）
    if (req.url === '/api/stickers/maint' && (req.method === 'GET' || req.method === 'POST')) {
      const SDM = path.join(ROOT, 'data', 'stickers');
      const MD5M = path.join(SDM, '.md5.json');
      const MDM = path.join(SDM, '常用.md');
      const listImgs = () => {
        const out = [];
        for (const [dir, pre] of [['', ''], ['常用', '常用/'], ['可用', '可用/'], ['虚幻', '虚幻/'], ['关键词触发', '关键词触发/'], ['少用', '少用/']]) {
          const p = dir ? path.join(SDM, dir) : SDM;
          try { for (const f of fs.readdirSync(p)) if (/\.(png|jpe?g|gif|webp)$/i.test(f)) out.push({ rel: pre + f, name: f.replace(/\.[^.]+$/, ''), abs: path.join(p, f) }); } catch {}
        }
        return out;
      };
      const readMd5 = () => { try { return JSON.parse(fs.readFileSync(MD5M, 'utf8')) || {}; } catch { return {}; } };
      const deadKeys = store => {
        const have = new Set(listImgs().map(x => x.rel));
        const dead = [];
        for (const [h, v] of Object.entries(store)) {
          const f = (v && typeof v === 'object') ? v.f : v;
          if (!f || !have.has(String(f).replace(/\\/g, '/'))) dead.push(h);
        }
        return dead;
      };
      const stat = () => {
        const s = readMd5();
        return {
          entries: Object.keys(s).length,
          size: fs.existsSync(MD5M) ? fs.statSync(MD5M).size : 0,
          dead: deadKeys(s).length,
          on: readCfg().stickerAutoDesc === true,
          imgs: listImgs().length,
        };
      };
      if (req.method === 'GET') {
        return json(Object.assign({ ok: true }, stat(), {
          job: { running: fillJob.running, total: fillJob.total, done: fillJob.done, ok: fillJob.ok, fail: fillJob.fail, log: fillJob.log.slice(-8) },
        }));
      }
      const act = String(d.action || '');
      // ① 清理：先备份，只删「图已经没了」的记录，场合表一个字不动
      if (act === 'clean') {
        try {
          const s = readMd5();
          const dead = deadKeys(s);
          if (!dead.length) return json(Object.assign({ ok: true, cleaned: 0, msg: '没有可清理的 —— 每条指纹都还有图在' }, stat()));
          const bak = MD5M + '.备份-' + stampNow();
          fs.copyFileSync(MD5M, bak);
          for (const h of dead) delete s[h];
          fs.writeFileSync(MD5M, JSON.stringify(s), 'utf8');   // 不缩进：文件更小
          return json(Object.assign({ ok: true, cleaned: dead.length, bak: path.basename(bak), msg: '清理了 ' + dead.length + ' 条失效指纹（已备份）' }, stat()));
        } catch (e) { return json({ error: '清理失败：' + String(e.message).slice(0, 100) }); }
      }
      // ② 开关：只改 stickerAutoDesc 这一个字段（走 configStore，自动落到对应分区）
      if (act === 'switch') {
        try {
          const j = configStore.load();
          const on = d.on === true || String(d.on) === 'true' || String(d.on) === '1';
          j.stickerAutoDesc = on;
          configStore.writeFull(j);
          return json(Object.assign({ ok: true, on, msg: on ? '开关已打开（下次补描述会花积分）' : '开关已关闭（不花钱）' }, stat()));
        } catch (e) { return json({ error: '切开关失败：' + String(e.message).slice(0, 100) }); }
      }
      // ③ 用模型补描述：开关关着直接拒（防误触花钱），开着就后台跑、前端轮询进度
      if (act === 'fill') {
        if (readCfg().stickerAutoDesc !== true) return json({ error: '「用模型补描述」开关是关的。先打开开关再跑（打开就会花积分）' });
        if (fillJob.running) return json({ error: '正在跑，等这一轮跑完' });
        runFillJob().catch(e => { fillJob.running = false; fillJob.log.push('中断：' + String(e.message).slice(0, 60)); });
        return json({ ok: true, started: true, msg: '开始补描述，稍等（每张要调一次模型）' });
      }
      return json({ error: '不知道要做什么：' + act });
    }

    // ===== B站评论区收图（2026-11-01 主人第 7、8 条）=====
    // 做在项目这边、不进 astrbot 插件（插件升级会覆盖）；落盘复用 QQ 收图那套，不会进重复图。
    // 她只需要在面板贴一个视频链接/BV号，点一下。
    if (req.url === '/api/stickers/bili' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return json(Object.assign({ ok: true }, biliJob));
      if (biliJob.running) return json({ error: '上一轮还在跑，等它跑完再点' });
      const v = String(d.v || d.input || '').trim();
      if (!v) return json({ error: '贴一个视频链接 / BV 号 / av 号' });
      biliJob = { running: true, input: v, pages: 0, seen: 0, got: 0, skip: 0, fail: 0, log: ['开始收…'] };
      require('../bili-api').collectFromVideo(v, { pages: Number(d.pages) || 2 })
        .then(r => { biliJob = Object.assign({}, r, { running: false, input: v }); })
        .catch(e => { biliJob = { running: false, input: v, error: String(e.message).slice(0, 120), log: [] }; });
      return json({ ok: true, started: true, msg: '开始收这个视频评论区的图（每张间隔 0.4 秒，防被 B站拦）' });
    }

    // ===== 好感度表（后台数据，不发 QQ；面板能看能调）=====
    // ===== 人物列表（称呼+好感度+喜好 按人聚合，主人 2026-10-23 定）=====
    // （v77：旧的 /api/favor 读改接口并进 /api/people 了——好感度是人物列表的一列）
    if (req.method === 'GET' && req.url === '/api/people') {
      return json(readPeople());
    }
    if (req.method === 'POST' && req.url === '/api/people/set') {
      const id = String(d.qq || '').replace(/\D/g, '');
      if (!id) return json({ error: 'QQ 号不对' });
      // 代称属于「约定·代称」分支，锁定了就不许改（主人 2026-11-12）。
      if (String(d.field) === 'alias') {
        try {
          const pid = people.findByAccount('qq', id) || '';
          const raw = pid ? (people.get(pid) || {}) : {};
          if (raw.review && raw.review.alias && raw.review.alias.state === reviewMod.LOCKED) {
            return json({ error: '这个人的代称你已经确认锁定了，不许改' });
          }
        } catch {}
      }
      // 主人号：她有几个号、在哪些群都用哪个号，都要能认出来（主人 2026-10-23 定「能够识别我所有群的 id」）
      if (String(d.field) === 'master') {
        const on = String(d.value) === '1';
            const j = readCfg();
        if (!on && String(j.masterQQ) === id) return json({ error: '这是主号，不能取消' });
        const set = new Set((j.masters || []).map(String));
        if (on) set.add(id); else set.delete(id);
        j.masters = [...set].filter(x => x && x !== String(j.masterQQ || ''));
        configStore.writeFull(j);
        return json({ ok: true, isMaster: on, masters: j.masters });
      }
      if (String(d.field) === 'favor') {
        const pid = people.findByAccount('qq', id);
        if (!pid) return json({ error: '这个号还没建档，先在建档入口把人物建出来' });
        // 面板手动改 = 主人意图，带 force 越过锁定（锁只拦机器人自动加/减，2026-11-13）
        return json({ ok: true, v: people.setFavor(pid, Number(d.value) || 0, { force: true }) });
      }
      if (String(d.field) === 'favorLock') {
        const pid = people.findByAccount('qq', id);
        if (!pid) return json({ error: '这个号还没建档' });
        const on = (d.value === true || String(d.value) === '1' || String(d.value) === 'true');
        return json(people.setFavorLock(pid, on));
      }
      /* 改身份（2026-11-22 她令）：身份就是称呼，五档。
       * 主人 / 欧尼酱 按号认，面板不改；「朋友」由朋友录（好感 > FRIEND_AT）决定，
       * 面板只留「认识的人 / 陌生人」这一档，其余用「加入朋友录」改好感。 */
      if (String(d.field) === 'role') {
        const pid = people.findByAccount('qq', id);
        if (!pid) return json({ error: '这个号还没建档' });
        const want = String(d.value || '');
        if (want === 'master' || want === 'onii') return json({ error: '主人 / 欧尼酱是按号认的，要改就去配置里改' });
        if (want === 'friend') return json({ error: '朋友由「朋友录」决定：把好感调到 20 以上就进朋友录了' });
        const r = people.setRole(pid, want);
        if (!r) return json({ error: '身份只能选 认识的人 / 陌生人' });
        return json({ ok: true, role: r, roleLabel: people.roleLabel(people.roleOf(pid)) });
      }
      /* 主人对他的叫法（2026-11-22 她令）：面板能改，注入里「昵称（主人称呼方式）」跟着变。 */
      if (String(d.field) === 'masterCall') {
        const pid = people.findByAccount('qq', id) || String(d.pid || '');
        if (!pid) return json({ error: '这个号还没建档' });
        const ok = people.setMasterCall(pid, d.value);
        if (!ok) return json({ error: '没写进去' });
        return json({ ok: true, masterCall: people.masterCallOf(pid) });
      }
      /* 改性别（2026-11-22 她令）：男 / 女；面板手动改 = 已确认。 */
      if (String(d.field) === 'sex') {
        const pid = people.findByAccount('qq', id);
        if (!pid) return json({ error: '这个号还没建档' });
        const want = String(d.value || '');
        const r = people.setSex(pid, want === '女' ? 'female' : want === '男' ? 'male' : want, 'confirmed');
        if (!r) return json({ error: '性别只能是 男 / 女' });
        return json(Object.assign({ ok: true }, r, { sexLabel: people.sexLabel(r.sex) }));
      }
      const st = readPeopleState();
      const rec = Object.assign({}, st[id] || {});
      const f = String(d.field || '');
      const val = String(d.value == null ? '' : d.value).replace(/[\r\n]+/g, ' ').trim();
      /* 2026-11-22：老接口按 QQ 写称呼时，没建档的号一律不建新人物。
       * 以前 writeStateView 查不到 pid 就 makePerson，写错一个号就在人物表里多一个人。 */
      if (!people.findByAccount('qq', id) && ['name', 'alias', 'nick', 'card', 'suffix'].indexOf(f) >= 0) {
        logWrite('/api/people/set', d, false, '这个号还没建档', Date.now() - _t0);
        return json({ error: '这个号还没建档：先去朋友录建人，再来改称呼' });
      }
      if (f === 'name') { if (val) rec.name = val; else delete rec.name; }
      else if (f === 'alias') { const a = normAlias(val); if (a) rec.alias = a; else delete rec.alias; }
      else if (f === 'nick') { if (val) rec.nick = val; else delete rec.nick; }
      // 群名片：按群改（gid 必填），一个人每个群各一张，互不覆盖
      else if (f === 'card') {
        const gid = String(d.gid || '').replace(/\D/g, '');
        if (!gid) return json({ error: '要指定是哪个群' });
        /* 2026-11-21：群名片正本在**账号级**，前端按人物合并展示（副号的卡也显示在一起）。
         * 改的那张如果本来属于副号，就写回副号——否则会在主号上多出一张、副号那张改不动。 */
        let target = id;
        try {
          const pid0 = people.findByAccount('qq', id);
          const p0 = pid0 ? (people.get(pid0) || {}) : {};
          const hit = (p0.accounts || []).find(a => String(a.platform) === 'qq'
            && a.cards && Object.prototype.hasOwnProperty.call(a.cards, gid));
          if (hit) target = String(hit.id);
        } catch {}
        if (target !== id) {
          const st2 = readPeopleState();
          const rec2 = Object.assign({}, st2[target] || {});
          rec2.cards = rec2.cards || {};
          if (val) rec2.cards[gid] = val; else delete rec2.cards[gid];
          st2[target] = rec2;
          if (!writePeopleState(st2)) { logWrite('/api/people/set', d, false, people.lastWriteError() || '群名片写不进', Date.now() - _t0); return json({ error: people.lastWriteError() || '群名片没写进 people.json' }); }
          logWrite('/api/people/set', d, true, '', Date.now() - _t0);
          return json({ ok: true, rec: rec2 });
        }
        rec.cards = rec.cards || {};
        if (val) rec.cards[gid] = val; else delete rec.cards[gid];
      }
      else if (f === 'suffix') { if (val === 'baobao' || val === 'jiang') rec.suffix = val; else delete rec.suffix; }
      else return json({ error: '不知道要改什么：' + f });
      st[id] = rec;
      if (!writePeopleState(st)) { logWrite('/api/people/set', d, false, people.lastWriteError() || '写不进 people.json', Date.now() - _t0); return json({ error: people.lastWriteError() || '没写进 people.json' }); }
      logWrite('/api/people/set', d, true, '', Date.now() - _t0);
      return json({ ok: true, rec });
    }
    // 删口味的一条（人物列表展开区可删；整段编辑照旧去「长期记忆」的原文）
    // 2026-11-04：口味按人物聚合后，一条可能来自副号那一节；把人物名下所有 QQ 都试一遍（主号优先）。
    // 老接口参数不变，前端也可以额外传 fromQQ 精确指定来源号。
    if (req.method === 'POST' && req.url === '/api/taste/del') {
      const id = String(d.qq || '').replace(/\D/g, '');
      const t = require('../taste');
      const sec = String(d.sec || '');
      const text = String(d.t || '').trim();
      if (!id || !t.ORDER.includes(sec) || !text) return json({ error: '参数不对' });
      let ids = [id];
      try {
        const pid = people.findByAccount('qq', id);
        const all = pid && typeof people.qqAccountsOf === 'function' ? people.qqAccountsOf(pid) : [];
        if (all && all.length) ids = all.map(String);
      } catch {}
      const fromQQ = String(d.fromQQ || '').replace(/\D/g, '');
      if (fromQQ) ids = [fromQQ].concat(ids.filter(x => x !== fromQQ));
      let done = false;
      for (const target of ids) {
        let md = '';
        try { md = fs.readFileSync(t.FILE, 'utf8'); } catch { return json({ error: '喜好文件读不了' }); }
        const lines = md.split('\n');
        let inP = false, inSec = false;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (/^##\s+/.test(l)) { inP = l.includes('（' + target + '）'); inSec = false; continue; }
          if (!inP) continue;
          if (/^###\s+/.test(l)) { inSec = l.trim() === '### ' + t.LABEL[sec]; continue; }
          if (inSec && /^[-*]\s+/.test(l) && l.replace(/^[-*]\s+/, '').split(/[（(]/)[0].trim() === text) {
            lines.splice(i, 1); done = true; break;
          }
        }
        if (done) {
          fs.writeFileSync(t.FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
          break;
        }
      }
      if (!done) return json({ error: '没找到这条' });
      return json({ ok: true });
    }

    // ===== 机器人写入日志（它主动写进文件/记忆的每一条，可一键清空真删）=====
    if (req.method === 'GET' && (req.url === '/api/logs' || req.url.indexOf('/api/logs?') === 0)) {
      const limit = Number((req.url.split('limit=')[1] || '').split('&')[0]) || 400;
      let raw = '';
      try { raw = fs.readFileSync(path.join(ROOT, 'data', 'bot-writes.jsonl'), 'utf8'); } catch {}
      const list = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { list.push(JSON.parse(line)); } catch { list.push({ t: '', file: '', action: '原样', text: line }); }
      }
      return json({ list: list.slice(-limit), total: list.length });
    }
    if (req.method === 'POST' && req.url === '/api/logs/clear') {
      fs.writeFileSync(path.join(ROOT, 'data', 'bot-writes.jsonl'), '', 'utf8');
      return json({ ok: true });
    }

    // 一天一篇日记的全流程（2026-11-18 主人令）：状态 + 手动动作
    //   状态：现在卡在哪个阶段、还差多少记录、草稿长什么样、上次发到平台成没成
    //   动作：now（现在写）/ approve（通过并发布）/ rewrite（驳回重写）/ reset（撤掉草稿）
    if (req.url === '/api/diary-flow' || req.url.indexOf('/api/diary-flow?') === 0) {
      const diaryFlow = require('../diary-flow');
      if (req.method === 'GET') {
        try { return json(diaryFlow.view()); }
        catch (e) { return json({ ok: false, error: e.message }); }
      }
      if (req.method === 'POST') {
        try {
          const what = String((d && d.act) || '');
          const r = await diaryFlow.act(what);
          return json(Object.assign({ ok: true, act: what }, r || {}));
        } catch (e) { return json({ ok: false, error: e.message }); }
      }
    }

    // 聊天禁用词 / 禁用句式（2026-11-19 主人要的：提示词层面让她 AI 看到哪些话不许说）。
    // 正本 src/data/chat-bans.json，客户端「机器人 → 禁用词」页读写；全空则提示词里整段不出现。
    if (req.url === '/api/chat-bans') {
      const f = path.join(ROOT, 'data', 'chat-bans.json');
      if (req.method === 'GET') {
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          // 顺带把「这段现在会怎么进提示词」一起给前端——她要能看见 AI 到底看到什么
          try { j.preview = core.chatBansPrompt(); } catch { j.preview = ''; }
          return json(j);
        }
        catch (e) { return json({ error: '读不出来：' + e.message }); }
      }
      if (req.method === 'POST') {
        try {
          let old = {};
          try { old = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { old = {}; }
          const out = Object.assign({}, old, (d && typeof d === 'object' ? d : {}));
          // 三个表固定成字符串数组，别的类型一律丢掉 —— 前端写坏也不让提示词里冒出 [object Object]
          for (const k of ['words', 'patterns', 'rules']) {
            out[k] = (Array.isArray(out[k]) ? out[k] : [])
              .map(s => String(s == null ? '' : s).trim()).filter(Boolean);
          }
          fs.writeFileSync(f, JSON.stringify(out, null, 2) + '\n', 'utf8');
          return json({ ok: true, count: out.words.length + out.patterns.length + out.rules.length });
        } catch (e) { return json({ error: '写不进去：' + e.message }); }
      }
    }

    // 日记写法与禁用词（主人 2026-11-17 令：不许我单方面定，必须能看能改）
    if (req.url === '/api/diary-rules') {
      const f = path.join(ROOT, 'data', 'diary-rules.json');
      if (req.method === 'GET') {
        try { return json(JSON.parse(fs.readFileSync(f, 'utf8'))); }
        catch (e) { return json({ error: '读不出来：' + e.message }); }
      }
      if (req.method === 'POST') {
        try {
          const old = JSON.parse(fs.readFileSync(f, 'utf8'));
          const out = Object.assign({}, old, (d && typeof d === 'object' ? d : {}));
          fs.writeFileSync(f, JSON.stringify(out, null, 2) + '\n', 'utf8');
          return json({ ok: true });
        } catch (e) { return json({ error: '写不进去：' + e.message }); }
      }
    }

    // ===== 聊天记录（只读，机器人说的默认折叠）=====
    // 「看每个人」里的人名列表（认人表 + 聊天记录里出现过的昵称）
    if (req.method === 'GET' && (req.url === '/api/who' || req.url.indexOf('/api/who?') === 0)) {
      return json(whoNamesList());
    }
    /* 2026-11-21：聊天记录页 8 秒轮询的轻量签名——只读主文件大小+mtime，
     * 不整份 readFileSync / parse / 序列化。前端比对了才真正拉 /api/chat。 */
    if (req.method === 'GET' && req.url.indexOf('/api/chat/sig') === 0) {
      return json({ ok: true, sig: chatShards.tailSig() });
    }
    if (req.method === 'GET' && (req.url === '/api/chat' || req.url.indexOf('/api/chat?') === 0)) {
      // 2026-11-21 主人令：默认读最近分片（不卡），主文件只在 ?all=1 时读。
      //  - ?shard=<key> 单段  ?conv=<key> 某会话全部段  ?recent=<n> 最近n段  ?skip=<k> 从最近往前第k段起  ?all=1 整份主文件
      const shardQs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const chat = readChat({
        shard: shardQs.get('shard') || '',
        conv: shardQs.get('conv') || '',
        all: shardQs.get('all') === '1',
        recent: Number(shardQs.get('recent')) || 12,
        skip: Number(shardQs.get('skip')) || 0,
      });
      const linked = {};
      readTopics().forEach(x => { if (x.link) linked[x.link] = x.id; });   // 星标↔话题联动（曾联动标记）
      chat.linked = linked;
      // 按会话设置一起带回来（一次请求就够，界面不用再单独拉一遍）
      chat.convSettings = convSettings.all();
      // 全局默认上下文条数：界面上要写「不填 = 用默认 N 条」，这个数字必须和机器人真用的一致
      try {
        const j = configStore.load();
        const cc = j.context || {};
        chat.convDefault = { ctx: Math.max(6, Number((j.context || {}).historyLimit || j.historyLimit || 30)) };
        // 全局默认输出字数：就是 llm.maxTokens（现在的 600）。会话⚙里不填就用这个数，界面上要写「不填 = 默认 N 字」。
        chat.convDefault.chars = Math.max(20, Number(((j.llm || {}).maxTokens) || 600) || 600);
        // 聊天记录页「显示设置」的当前值：跟着 /api/chat 一起带回去，不新增接口。
        // 这四个数就是机器人端 config 里的原值，界面只显示和改它，不另存一份。
        const pick = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
        chat.cfg = {
          imgDescChars: Math.max(0, pick(cc.imgDescChars, 1200) || 0),
          chatShowLimit: Math.max(20, pick(cc.chatShowLimit, 200) || 200),
          historyLimit: Math.max(6, pick(cc.historyLimit || j.historyLimit, 60) || 60),
          historyChars: Math.max(1200, pick(cc.historyChars, 8000) || 8000),
          // 聊天记录页下方「实时思考」开关（2026-11-11）：这个开关管的是「要不要花 token 想」，
          // 不是「生成了藏起来不看」——关着的时候机器人一个思考 token 都不花。
          liveThink: (cc.liveThink === true || Number(cc.liveThink) === 1) ? 1 : 0,
          // 默认输出字数（2026-11-14）：就是 llm.maxTokens，设置页那一行改它，会话⚙「用默认」回到它。
          aiMaxChars: Math.max(20, Number(((j.llm || {}).maxTokens) || 600) || 600),
        };
      } catch { chat.convDefault = { ctx: 30, chars: 600 }; chat.cfg = {}; }
      /* 情绪联动（主人 2026-11-07 定：聊天记录里能改情绪、能补漏判）：
       * 给每条 entry 注入 .emo = {leaf,word,source} | null。
       * 优先 chat-emotion.json（主人手改过的），回退 情绪记录.jsonl（机器人实时判的）。 */
      try {
        const et = require('../emotion-tree');
        et.mergeChatEmotion(chat.list);
      } catch (e) { console.error('[聊天记录] 情绪合并失败：' + e.message); }
      return json(chat);
    }
    /* 聊天记录按会话分片列表（2026-11-19 主人令：按群/按人一键删、按需读省 CPU）。
     * 只列 {key,count,size,mtime}，前端画一个「按会话分区」入口；点哪个就用 /api/chat?shard=<key> 只读那份。 */
    if (req.method === 'GET' && (req.url === '/api/chat/shards' || req.url.indexOf('/api/chat/shards?') === 0)) {
      return json({ ok: true, shards: chatShards.list(), conversations: chatShards.listConversations(), silenceHours: chatShards.SILENCE_MS / 3600000 });
    }
    // 分片自愈：从主文件重建所有分片（删过头/首次装时用）。主文件绝不动。
    if (req.method === 'POST' && req.url === '/api/chat/shards-rebuild') {
      try { return json(Object.assign({ ok: true }, chatShards.rebuild())); }
      catch (e) { return json({ ok: false, error: e.message }); }
    }
    // 一键清空某会话分片：按 keyOfLine 精准删主文件对应行（与分片完全一一对应），删前备份主文件。
    if (req.method === 'POST' && req.url === '/api/chat/shard-clear') {
      try {
        const key = String((d && d.key) || '');
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const backup = path.join(ROOT, 'data', 'chat-log.jsonl.bak-' + stamp + '-shardclear');
        const r = chatShards.clearShard(key, backup);
        if (r.ok) { try { chatShards.rebuild(); } catch (e) {} }
        return json(Object.assign({}, r, r.ok ? { backup: path.basename(backup) } : {}));
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    /* 聊天记录页下方「实时思考」（2026-11-11 主人令）：
     * 返回这个会话最近一条模型思考原文（data/thinking.jsonl 里 k 对得上的那条）。
     * 只认 30 分钟内的——更早的已经归到那一句的「推理」里了，不该继续挂在这当「实时」。
     * 开关本身在 config.context.liveThink（关着 = 机器人根本不生成，不是这里隐藏）。 */
    if (req.method === 'GET' && req.url.indexOf('/api/chat/live') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const k = String(qs.get('k') || '');
      const rows = [];
      try {
        for (const l of fs.readFileSync(path.join(ROOT, 'data', 'thinking.jsonl'), 'utf8').split('\n')) {
          if (!l.trim()) continue;
          try { const o = JSON.parse(l); if (!k || String(o.k || '') === k) rows.push(o); } catch {}
        }
      } catch {}
      const last = rows[rows.length - 1] || null;
      const t = last ? Date.parse(last.t) : NaN;
      const fresh = last && !isNaN(t) && (Date.now() - t < 30 * 60 * 1000);
      return json({ ok: true, item: fresh ? last : null });
    }
    /* 聊天记录页「本轮输出的提示词」槽位（2026-11-13 主人令）：
     * GET       = 一次性列出群 / 私聊 / 平台三区的全部槽位（不分页、不裁条数、不轮询）。
     * POST /del = 主人删掉某一条；删完槽位就空着，这个来源下一轮回复时由 core 自动补一条。
     * 读写都走 src/prompt-slots.js 那一份，不在这里另拼路径 / 结构。 */
    if (req.method === 'GET' && req.url === '/api/chat/prompts') {
      return json({ ok: true, slots: promptSlots.list(), cats: promptSlots.CATS, labels: promptSlots.CAT_LABEL });
    }
    if (req.method === 'POST' && req.url === '/api/chat/prompts/del') {
      return json(promptSlots.remove(d.cat, d.k));
    }
    /* 改/清某条聊天记录的情绪（主人手改）。
     * 来源判定：之前是机器人判的（auto / 情绪记录）且改了叶 → 记成 review（= 判错，联动表情包页徽标）；
     *          否则记成 user（纯手改）。
     * leaf 为空 → 清空这条的情绪。 */
    if (req.method === 'POST' && req.url === '/api/chat/emotion') {
      try {
        const et = require('../emotion-tree');
        const key = String(d.key || '');
        const leaf = d.leaf ? String(d.leaf) : '';
        if (!key) return json({ ok: false, error: '缺 key' });
        let source = 'user';
        if (leaf) {
          const cur = et.readChatEmotion()[key];
          const matched = !cur ? et.matchRecord(d.nick, d.text) : null;
          const oldLeaf = (cur && cur.leaf) || (matched && matched.leaf) || '';
          const wasAuto = (cur && cur.source === 'auto') || !!matched;
          if (wasAuto && oldLeaf && oldLeaf !== leaf) source = 'review';
        }
        et.writeChatEmotion(key, leaf, d.word || '', source);
        return json({ ok: true, source });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    /* 扫漏判（主人：「给所有漏判的加情绪」）：
     * 遍历聊天记录里「非虚幻、非主人」的每句，用情绪书判一遍；
     * 凡是没有现成映射（chat-emotion / 情绪记录）且判得出叶的，就是漏判。
     * apply:false → 只预览返回列表；apply:true → 落盘（source=auto）。 */
    if (req.method === 'POST' && req.url === '/api/chat/emotion/scan') {
      try {
        const et = require('../emotion-tree');
        const chat = readChat();
        const list = (chat.list || []).filter(e => !e.bot && !e.mine);
        const map = et.readChatEmotion();
        const out = [];
        for (const e of list) {
          const k = e.key;
          if (!k) continue;
          if (map[k] && map[k].leaf) continue;            // 已有手改映射
          if (et.matchRecord(e.nick, e.text)) continue;   // 已在情绪记录里
          const r = et.judge(String(e.text || ''), { who: 'other' });
          if (!r.best) continue;
          out.push({ key: k, nick: e.nick, text: String(e.text || '').slice(0, 80),
            leaf: r.best.node.name, word: r.best.w });
        }
        if (d.apply) {
          for (const x of out) et.writeChatEmotion(x.key, x.leaf, x.word, 'auto');
        }
        return json({ ok: true, list: out, applied: !!d.apply, count: out.length });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    // 星标
    // v52（主人定）：星标 = 直接算已总结。加星时自动在话题日志里建一条「已总结」话题（带 link 回聊天记录），
    // 聊天记录本身不动，只是卡片多了个「曾联动」标记；取消星标把那条联动话题一起收走。
    if (req.method === 'POST' && req.url === '/api/chat/star') {
      const item = d.item || {};
      const key = starKey(item);
      const list = readStars();
      const i = list.findIndex(x => x.key === key);
      let addedStars = [];
      if (d.on && i < 0) {
        // 语境：她当时在接哪句。有就一起存，学话时要靠这个才知道「这种话怎么接」。
        let prev = '', prevNick = '';
        try {
          const hit = core.starsFindLine(item.scope, item.text);
          if (hit && hit.prev) { prev = hit.prev; prevNick = hit.prevNick; }
        } catch {}
        const res = core.starsAdd({
          key, t: item.t, src: item.src, scope: item.scope, nick: item.nick, text: item.text,
          prev, prevNick,
          run: Array.isArray(item.pieces) ? item.pieces.length : 1,   // 一次回了几句
          img: !!item.img, by: 'manual',
          // 主人 2026-11-07：加星时能写「为什么值得学」、能多选前后几句当上下文。
          // 都由界面收集，后端只做长度截断，不改写内容。
          note: String(d.note || '').trim().slice(0, 200),
          ctx: (Array.isArray(d.ctx) ? d.ctx : []).slice(0, 8).map(x => ({
            nick: String((x && x.nick) || '').slice(0, 30),
            text: String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            bot: !!(x && x.bot),
          })).filter(x => x.text),
        });
        // 星标 = 她认可自己这句在哪些方面「到位了」（主人 2026-11-21）：
        // d.infos = ['intents','logic',...] 勾了的方面各记一条正面样本（不动正文池，star 池仍是 chat-stars）。
        if (Array.isArray(d.infos) && d.infos.length) {
          for (const k of d.infos) {
            try {
              const row = core.infoScan.addStar(k, {
                text: item.text, note: String(d.note || ''), scope: item.scope, nick: item.nick, t: item.t,
              });
              if (row) addedStars.push(k);
            } catch (e) {}
          }
        }
        if (res === 'dup') return json({ ok: true, starred: true, total: readStars().length, addedStars });
        const topics = readTopics();
        if (!topics.some(x => x.link === key)) {
          topics.push({
            id: 'T' + topicSeq(), t: new Date().toISOString(), kind: 'topic', type: 'manual', state: 'summed',
            who: String(item.nick || ''), qq: '', scope: String(item.scope || ''), nick: String(item.nick || ''),
            topic: '', parent: '', link: key, text: String(item.text || '').slice(0, 500),
            sum: '', star: true,
          });
          writeTopics(topics);
        }
      }
      // 已经加过星、又补写了描述或上下文 → 只更新这一条，不重复建话题、不改 key
      if (d.on && i >= 0 && (d.note !== undefined || d.ctx !== undefined)) {
        const row = list[i];
        if (d.note !== undefined) row.note = String(d.note || '').trim().slice(0, 200);
        if (Array.isArray(d.ctx)) row.ctx = d.ctx.slice(0, 8).map(x => ({
          nick: String((x && x.nick) || '').slice(0, 30),
          text: String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          bot: !!(x && x.bot),
        })).filter(x => x.text);
        writeStars(list);
      }
      if (!d.on) {
        // 面板上一条合并显示的话，库里可能是「每句一颗星」（群友点赞按单句加）。
        // 取消时把这一段的每一颗都收走，别留下看不见的孤儿星。
        const keys = new Set([key]);
        for (const pc of (Array.isArray(item.pieces) ? item.pieces : [])) keys.add(starKey(pc));
        const rest = list.filter(x => !keys.has(x.key));
        if (rest.length !== list.length) {
          writeStars(rest);
          writeTopics(readTopics().filter(x => !keys.has(x.link)));
        }
        // 取消星标 = 不再认可，5 个方面里同一句的正面样本一起收走（免得面板留着孤儿）。
        try {
          const txt = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          if (txt) {
            for (const k of core.infoScan.KEYS) {
              const j = core.infoScan.read(k);
              for (const s of (j.stars || []).slice()) {
                if (!keys.has(s.key) && s.text === txt) core.infoScan.delStar(k, s.id);
              }
            }
          }
        } catch (e) {}
      }
      return json({ ok: true, starred: !!d.on, total: readStars().length, addedStars: (typeof addedStars !== 'undefined' ? addedStars : []) });
    }
    if (req.method === 'GET' && req.url === '/api/chat/stars') {
      return json({ list: readStars() });
    }
    /* 按会话设置（主人 2026-11-07）：「虚幻的可读上下文可以在聊天界面按各自群聊/私聊分别单独改容量」
     * + 「群回复等等的开关都可以在各自界面分别调，黑名单群我也可以在这直接打标记」。
     * 键由服务端翻译（conv + uid + kind → qq_<号> / bili_<UID>），客户端不自己拼，
     * 免得哪天改了键规则两边又对不上。 */
    /* 各平台输出字数上限（2026-11-17 主人令）：默认=平台上限、手填不能超、改版靠测。
     * GET  读上限表；POST set 手设；POST probe-bili 测 B站（评论=私密视频 / 私信=主人）。 */
    if (req.method === 'GET' && req.url === '/api/platform-limits') {
      return json({ ok: true, limits: platLimits.all() });
    }
    if (req.method === 'POST' && req.url === '/api/platform-limits/set') {
      const k = String(d.key || '');
      if (!platLimits.validKey(k)) return json({ ok: false, error: '平台不对（可选：' + platLimits.KEYS.join(' / ') + '）' });
      const r = platLimits.setCap(k, d.cap, false);
      console.log('[上限] 手设 ' + k + ' → ' + JSON.stringify(r));
      return json(r);
    }
    if (req.method === 'POST' && req.url === '/api/platform-limits/probe-bili') {
      // B站测试场：评论=小号名下那条视频（aid 写死在 bili-probe.js:COMMENT_SITE_AID）；私信=主人 B站私信。
      // 逻辑抽到 bili-probe.js，跟「版本变化自动重测」共用同一份，不写两份。
      const which = String(d.which || 'biliC');
      const r = await biliProbe.probe(which);
      if (r.ok) console.log('[上限] B站测 ' + which + ' → ' + r.cap + ' 字（' + r.sends + ' 次）');
      return json(r);
    }
    /* 逛别人 QQ 空间留的评论记录 + 判合规（2026-11-17 主人令）。
     * 她要能在客户端看记录、手动判断回话合不合规。判定不是新功能：
     *   合规 → 星标（正面样本进提示词）；不合规 → 标错（待修复负例）——都走 core.qzoneJudge。
     * GET  /api/qzone           → 记录（带 verdict）+ 还没判的
     * POST /api/qzone/verdict   → { key, verdict: 'ok'|'bad', note } */
    /* ===== 她自己发出去的（2026-11-17 主人令）=====
     * 「虚幻自己发的QQ空间、b站动态都要在面板留记录。我好去查看她收到了什么提示词和进行了什么思考。」
     * 列表不带提示词全文（一份 system 就几 KB，几十条会把首屏撑爆），点开某一条再取全文。
     * GET /api/selfposts?plat=qzone|bili&limit=N   列表（正文、时间、模型、有没有提示词/思考）
     * GET /api/selfposts/one?id=xxx                一条的全文（整组提示词 + 思考原文）
     */
    if (req.method === 'GET' && req.url.indexOf('/api/selfposts') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      if (req.url.indexOf('/api/selfposts/one') === 0) {
        const one = selfpost.get(qs.get('id') || '');
        return one ? json({ ok: true, item: one }) : json({ ok: false, error: '没有这一条（可能被清了）' });
      }
      const list = selfpost.recent(qs.get('limit') || 60, qs.get('plat') || '').map(x => ({
        id: x.id, t: x.t, plat: x.plat, kind: x.kind, text: x.text, tid: x.tid, link: x.link,
        model: x.model, ms: x.ms, ok: x.ok, err: x.err, note: x.note, from: x.from,
        hasPrompt: !!(x.prompt && x.prompt.length), hasThink: !!x.think,
        promptChars: (x.prompt || []).reduce((n, m) => n + String(m.content || '').length, 0),
      }));
      return json({ ok: true, list });
    }
    /* ===== 虚幻所有发言的统一判定（2026-11-19 主人令）=====
     * 「所有虚幻发的都要星标/标错」「判情绪、漏判全场景管」「按通用到专用：
     *   全私聊/QQ群/全评论/QQ空间评论/b站视频图文评论/全动态/b站动态/日记」（一行一句）。
     * GET  /api/judge?scope=全动态&limit=N   → 判定列表（scope 是视图时自动聚合子 scope）
     * GET  /api/judge/scopes                → 8 个 scope + 哪些是聚合视图（给面板渲染切换）
     * POST /api/judge  {id,scope,text,verdict:'star'|'issue',note,prev,prevNick,emotions}
     * 星标进 chat-stars、标错进待修复——和聊天记录同一个池，不另造。 */
    if (req.method === 'GET' && req.url === '/api/judge/scopes') {
      return json({
        ok: true,
        scopes: judge.SCOPES,
        views: Object.keys(judge.EXPAND),
      });
    }
    if (req.method === 'GET' && req.url.indexOf('/api/judge') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      return json({ ok: true, list: judge.list(qs.get('scope') || '', qs.get('limit') || 200) });
    }
    if (req.method === 'POST' && req.url === '/api/judge') {
      const r = judge.judge(d.item || d, d.verdict, d.note, d.by || '客户端');
      console.log('[判定] ' + String((d.item || d).scope || '') + '/' + String((d.item || d).id || '') + ' → ' + (r.ok ? r.verdict.verdict : r.error));
      return json(r);
    }
    /* ===== B站主页 / 评论楼中楼 / 私信（2026-11-17 主人令）=====
     * 只读，不发任何东西。登录态取 AstrBot 插件配置，逻辑全在 src/bili-space.js（单一数据源）。
     * 限频在那边：拉一次落缓存，10 分钟内刷新只给缓存（连着打必被 B站 412）。 */
    if (req.method === 'GET' && req.url.indexOf('/api/bili/home') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const r = await biliSpace.home({
        mid: String(qs.get('mid') || ''),
        force: qs.get('force') === '1',
        ignoreGap: qs.get('gap') === '1',
      });
      return json(Object.assign({ accounts: biliSpace.accounts(), login: biliSpace.creds().from }, r));
    }
    if (req.method === 'GET' && req.url.indexOf('/api/bili/comments') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      try {
        const r = await biliSpace.comments(qs.get('type') || 1, qs.get('oid') || '', qs.get('pn') || 1);
        return json({ ok: true, page: r.page, list: r.list });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && req.url.indexOf('/api/bili/replies') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      try {
        const r = await biliSpace.replies(qs.get('type') || 1, qs.get('oid') || '', qs.get('root') || '', qs.get('pn') || 1);
        return json({ ok: true, list: r });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && req.url.indexOf('/api/bili/dm/msgs') === 0) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      try {
        const r = await biliSpace.dmMessages(qs.get('uid') || '', qs.get('size') || 50);
        return json({ ok: true, list: r });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && req.url === '/api/bili/dm') {
      try {
        const list = await biliSpace.dmSessions();
        /* 每个会话补两样（客户端不自己查）：
         *   ① B站 的昵称 + 头像（x/web-interface/card，公开接口，bili-space 里带 1 小时缓存）
         *   ② 这个 B站 号在人物表里是谁 —— 有就标出对应的 QQ 号，主人在客户端一眼看出「同一个人」 */
        for (const s of list) {
          try { const pr = await biliSpace.profile(s.uid); s.name = pr.name; s.face = pr.face; } catch {}
          try {
            const pid = people.findByAccount('bili', s.uid);
            const px = pid ? people.get(pid) : null;
            if (px) {
              const qq = (px.accounts || []).filter(a => a.platform === 'qq').map(a => String(a.id));
              s.person = { pid: String(pid), name: px.name || '', qq };
            }
          } catch {}
        }
        return json({ ok: true, list, login: biliSpace.creds().from });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    /* ===== B站监测账号（2026-11-19 主人令）：默认我和小号两个，面板可增删。
     * 唯一数据 = config/features.json → bilibiliMonitor.mids；configStore.patch 原子落盘。
     * 既给 B站页顶部 chips 切换主页，也是评论区采集（被@/虚幻发言）的对象名单。 */
    /* B站评论区发言台账（2026-11-19）：读 AstrBot 插件写的 bili-activity.jsonl（虚幻被@/主动发言）。
     * 只读、不碰插件源码；插件升级覆盖后按注释恢复写入点（见当天日志）。 */
    if (req.method === 'GET' && req.url === '/api/bili/activity') {
      try {
        const os = require('os');
        const af = path.join(os.homedir(), '.astrbot', 'data', 'plugin_data', 'astrbot_plugin_bilibili_ai_bot', 'bili-activity.jsonl');
        const rows = [];
        if (fs.existsSync(af)) {
          for (const line of fs.readFileSync(af, 'utf8').split('\n')) {
            const s = line.trim(); if (!s) continue;
            try { const o = JSON.parse(s); if (o && o.key) rows.push(o); } catch {}
          }
        }
        const pick = k => rows.filter(r => r.kind === k).sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0)).slice(-100);
        // 2026-11-19：question=触发虚幻回复的提问原文（供选片，也在面板可见）；repost=刷到高分视频自动转发。
        return json({ ok: true, at: pick('at'), say: pick('say'), question: pick('question'), repost: pick('repost') });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && req.url === '/api/bili/monitor') {
      const mo = (configStore.load().bilibiliMonitor || {});
      const mids = Array.isArray(mo.mids) ? mo.mids.map(String) : [];
      let known = {};
      try { (biliSpace.accounts() || []).forEach(a => { known[String(a.mid)] = { name: a.name, face: a.face, fans: a.fans }; }); } catch {}
      return json({ ok: true, mids, known, note: mo.note || '' });
    }
    if (req.method === 'POST' && req.url === '/api/bili/monitor') {
      if (!Array.isArray(d.mids)) return json({ ok: false, error: '格式不对，没保存' });
      const clean = [];
      for (const x of d.mids) {
        const s = String(x || '').trim();
        if (/^\d{4,20}$/.test(s) && clean.indexOf(s) < 0 && clean.length < 50) clean.push(s);
      }
      if (!clean.length) return json({ ok: false, error: '至少一个有效 B站 UID（4~20 位数字）' });
      const mo = Object.assign({}, configStore.load().bilibiliMonitor || {}, { mids: clean });
      const r = configStore.patch('bilibiliMonitor', mo);
      if (!r.ok) return json({ ok: false, error: r.error });
      botWrite('config/features.json', 'B站监测账号', '改成 ' + clean.length + ' 个：' + clean.join('、'));
      return json({ ok: true, mids: clean });
    }
    if (req.method === 'GET' && req.url === '/api/qzone') {
      return json({
        ok: true,
        conf: qzoneComment.confView(),                                            // 频率上限：当前值/默认/范围
        records: qzoneComment.recent(80),
        pending: core.qzonePending(20),
        skipped: (qzoneComment.readState().skipped || []).slice(-40).reverse(),   // 这轮为什么没发
      });
    }
    // 逛空间频率保存（2026-11-17 主人纠正：频率不是平台上限，我不许给它编边界）
    //   · 空 / 0 = 用默认：删掉这个字段，不存 0
    //   · 填了就照她填的存，只取整 + 保底 1；不设上限、不夹
    //   唯一真上限是单条评论文数，来自 platform-limits 的 qzone cap，在 gate() 里拦。
    if (req.method === 'POST' && req.url === '/api/qzone/set') {
      let conf;
      try { conf = configStore.load(); } catch (e) { return json({ ok: false, error: '配置读不了：' + e.message }); }
      const cur = Object.assign({}, (conf && conf.qzone) || {});
      const fc = Object.assign({}, cur.friendComment || {});
      /* 间隔只有一处落点：qzone.everyHours —— 转发说说、逛空间、两条评论共用这一个数
       * （主人 2026-11-17「两条评论间隔和动态间隔一致」）。空 / 0 = 删字段回默认。 */
      if ('everyHours' in d) {
        const v = Number(d.everyHours);
        if (d.everyHours === '' || d.everyHours === null || !isFinite(v) || v <= 0) delete cur.everyHours;
        else cur.everyHours = Math.max(1, Math.round(v));
      }
      if ('enabled' in d) fc.enabled = !!d.enabled;
      if ('skipMaster' in d) fc.skipMaster = !!d.skipMaster;
      cur.friendComment = fc;
      const w = configStore.patch('qzone', cur, '客户端/QQ空间页·频率');
      if (!w.ok) return json({ ok: false, error: w.error });
      console.log('[空间评论] 频率设置保存 → ' + JSON.stringify(fc));
      return json({ ok: true, conf: qzoneComment.confView() });
    }
    if (req.method === 'POST' && req.url === '/api/qzone/verdict') {
      const r = core.qzoneJudge(String(d.key || ''), d.verdict === 'bad' ? 'bad' : 'ok', String(d.note || ''), '客户端');
      console.log('[空间评论] 客户端判定 ' + d.key + ' → ' + (r.ok ? r.action : r.error));
      return json(r);
    }
    // 各平台版本号（改版追踪）：GET 看记录；POST sample 采一次新版本并判变化（给测试/手动刷新用）
    if (req.method === 'GET' && req.url === '/api/platform-version') {
      return json({ ok: true, versions: platVersion.all() });
    }
    if (req.method === 'GET' && req.url === '/api/conv/settings') {
      return json({ list: convSettings.all() });
    }
    if (req.method === 'POST' && req.url === '/api/conv/set') {
      const key = convSettings.keyOfConv(d.conv, d.uid, d.kind);
      if (!key) return json({ ok: false, error: '这个会话不能单独设：没查到账号号，或者它不是具体会话' });
      const patch = {};
      if ('ctx' in d) patch.ctx = d.ctx;
      if ('chars' in d) patch.chars = d.chars;      // 输出字数上限：0 = 回到默认
      if ('reply' in d) patch.reply = d.reply;
      if ('off' in d) patch.off = d.off;          // 2026-11-19：单会话总开关，以前这里把 off 整个吞掉
      if ('black' in d) patch.black = d.black;
      if ('model' in d) patch.model = d.model;
      if (!Object.keys(patch).length) return json({ ok: false, error: '没有要改的项' });
      const r = convSettings.set(key, patch);
      console.log('[按会话设置] ' + key + ' → ' + JSON.stringify(r.one || {}));
      return json(r);
    }
    // 批量回话开关（2026-11-11 主人定「聊天记录面板里一键关全部 / 私聊 / 群回复」）：
    // 把一组会话的 reply 标志一起置好。reply=true → 回到默认（回话）；reply=false → 不回话。
    // 关闭时排除主人的私聊键，保持 QQ 遥控权（和 pause 一致：主人私聊命令永远能解开）。
    if (req.method === 'POST' && req.url === '/api/conv/setbulk') {
      const keys = Array.isArray(d.keys) ? d.keys : [];
      if (!keys.length) return json({ ok: false, error: '没有要改的会话' });
      const off = d.off === true;
      let skip = null;
      if (off) {
        try {
          const c = configStore.load();
          const set = new Set();
          const mQQ = String(c.masterQQ || '').replace(/\D/g, '');
          if (mQQ) set.add('qq_' + mQQ);
          (Array.isArray(c.masters) ? c.masters : []).forEach(q => {
            const s = String(q || '').replace(/\D/g, '');
            if (s) set.add('qq_' + s);
          });
          if (set.size) skip = set;
        } catch {}
      }
      const r = convSettings.setBulk(keys, off, skip);
      console.log('[按会话批量] ' + (off ? '关闭(不看也不回)' : '开启') + ' → ' + r.count + ' 个会话');
      return json(r);
    }
    /* 当前状态（2026-11-14 主人定，2026-11-14 按人改）：和「约定」同一套逻辑挂人。
     *   who 为空 = 全局（每个会话都注入，本体外貌就是全局的那几条）
     *   who = 'p:<pid>' = 某个人（多账号 / 跨平台合并成一个人，不分账号）
     *   who = 'g:<群号>' = 某个群
     * 读取：返回 globals（全局）+ mine（这个会话/这个人名下的）两段，前端分开展示。
     * 写：add=新建一条 / update=按 id 原地改（更新制）/ del=按 id 删 / show=设每轮注入条数。 */
    if (req.method === 'POST' && req.url === '/api/conv/state') {
      return json(convState.listFor(d.conv, d.uid));
    }
    if (req.method === 'POST' && req.url === '/api/conv/state/add') {
      const who = d.who != null ? String(d.who) : convState.whoOfConv(d.conv, d.uid);
      return json(convState.add(who, d.text, d.skind, d.topic));
    }
    if (req.method === 'POST' && req.url === '/api/conv/state/update') {
      return json(convState.update(d.id, d.text, d.skind, d.topic));
    }
    if (req.method === 'POST' && req.url === '/api/conv/state/del') {
      return json(convState.remove(d.id));
    }
    if (req.method === 'POST' && req.url === '/api/conv/state/show') {
      return json(convState.setShow(d.show));
    }
    // 清空
    if (req.method === 'POST' && req.url === '/api/chat/clear') {
      let raw = '';
      try { raw = fs.readFileSync(CHATLOG_PATH, 'utf8'); } catch {}
      const before = raw.split('\n').filter(l => l.trim()).length;
      if (d.scope === 'all') {
        fs.writeFileSync(CHATLOG_PATH, '', 'utf8');
        try { chatShards.rebuild(); } catch (e) {}
        return json({ ok: true, removed: before, kept: 0 });
      }
      if (d.scope === 'old7') {
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        const keep = raw.split('\n').filter(l => {
          if (!l.trim()) return false;
          const t = Date.parse(l.slice(0, 24));
          return isNaN(t) ? true : t >= cutoff;      // 解析不出时间的保守保留
        });
        fs.writeFileSync(CHATLOG_PATH, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
        try { chatShards.rebuild(); } catch (e) {}
        return json({ ok: true, removed: before - keep.length, kept: keep.length });
      }
      // 删除整个会话的全部记录（主人 2026-11-07：「我可以删除全组内容」）。
      // conv 就是左侧会话栏那行的键（群 = 群<号>，私聊 = 平台_<pid>，B站 = bili_<pid>）。
      // 逐行按 parseChatLine 判定归属，误删别的会话的可能性为零；空行保留。
      if (d.conv) {
        const target = String(d.conv);
        let bot = '虚幻', masterLabel = '主人';
        try {
          const j = configStore.load();
          bot = j.botName || '虚幻';
          masterLabel = (j.people && j.people[String(j.masterQQ)]) || '主人';
        } catch {}
        const idx = chatNameIndex();
        let lp = null, removed = 0, lastConv = '';
        const keep = raw.split('\n').filter(l => {
          if (!l.trim()) return true;
          const r = parseChatLine(l, idx, bot, masterLabel, lp); lp = r.lastPriv;
          // 裸行是上一条多行消息的续行，跟着上一条一起删，否则删完又冒出「早期记录」。
          const conv = (r.e.orphan && lastConv) ? lastConv : r.e.conv;
          if (!r.e.orphan) lastConv = r.e.conv;
          if (conv === target) { removed++; return false; }
          return true;
        });
        // 一条都没命中就别写文件：以前即使 removed=0 也会整份重写，每点一次结尾就多一个空行
        if (!removed) return json({ ok: true, removed: 0, kept: before, conv: target });
        const body = keep.join('\n').replace(/\n+$/, '');
        fs.writeFileSync(CHATLOG_PATH, body + '\n', 'utf8');
        try { chatShards.rebuild(); } catch (e) {}
        return json({ ok: true, removed, kept: before - removed, conv: target });
      }
      return json({ error: '不知道要清什么' });
    }
    // 手动标记错误（主人 2026-11-06 定）：对着聊天记录加一条待修复问题 + 移除这条记录。
    // 同一句可能已经进了风格样本或「她说过的话」，一并清掉，免得错话继续被学。
    if (req.method === 'POST' && req.url === '/api/chat/issue') {
      const item = d.item || {};
      const note = String(d.note || '').slice(0, 200);
      const text = String(item.text || '').slice(0, 300);
      const t = String(item.t || '');
      const nick = String(item.nick || '');
      // 多选的上下文（2026-11-07 主人：「错误也能多选」）：只留给人看当时的语境，
      // 不进提示词；错话本身照旧被移除，选中的上下文不删。
      const ctx = (Array.isArray(d.ctx) ? d.ctx : []).slice(0, 8).map(x => ({
        nick: String((x && x.nick) || '').slice(0, 20),
        text: String((x && x.text) || '').replace(/\s+/g, ' ').slice(0, 160),
        bot: !!(x && x.bot),
      })).filter(x => x.text);
      core.addIssue('待修复', '手动标记：' + (text || '(空消息)') + (note ? '｜' + note : '')
        + (ctx.length ? '（含 ' + ctx.length + ' 句上下文）' : ''),
      { emo: core.emotionOf(text), note: note || '这种接法被标成错误', ctx });
      let removed = 0, speech = 0;
      try {
        const lines = fs.readFileSync(CHATLOG_PATH, 'utf8').split('\n');
        const keep = lines.filter(l => {
          if (!l.trim()) return false;
          if (removed || !t) return true;
          const hit = l.startsWith(t) && (!nick || l.indexOf('[' + nick + ']') >= 0) && l.indexOf(text) >= 0;
          if (hit) { removed++; return false; }
          return true;
        });
        fs.writeFileSync(CHATLOG_PATH, keep.map(x => x + '\n').join(''), 'utf8');
      } catch {}
      try {
        const p = core.SPEECH_PATH;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        const keep = lines.filter(l => {
          if (!l.trim()) return false;
          try { if (String(JSON.parse(l).text || '') === text) { speech++; return false; } } catch {}
          return true;
        });
        fs.writeFileSync(p, keep.map(x => x + '\n').join(''), 'utf8');
      } catch {}
      const samples = core.forgetStyle({ text });
      if (text) core.markRecalled('', text);
      // 标错时顺带记「信息识别」的规则（主人 2026-11-21 令：这 5 个都要能在标错页记一条）。
      // d.infos = { intents:'', infoamount:'', memecontent:'', selfexpress:'', logic:'' }
      // 每项一行一条，写法「这么说 → 其实是这个意思」；没有箭头的行不收。
      let addedIntents = [];
      if (Array.isArray(d.intents) && d.intents.length) {
        try { addedIntents = core.addIntents(d.intents); } catch (e) { /* 单条写失败不影响标错主流程 */ }
      }
      const addedInfo = {};
      const box = (d.infos && typeof d.infos === 'object') ? d.infos : {};
      for (const k of core.infoScan.KEYS) {
        const raw = String(box[k] || '');
        if (!raw.trim()) continue;
        const items = [];
        for (const line of raw.split('\n')) {
          const mm2 = /^(.{1,120}?)\s*(?:→|->|=>|＝|=)\s*(.{1,300})$/.exec(String(line).trim());
          if (mm2) items.push({ phrase: mm2[1].trim(), meaning: mm2[2].trim() });
        }
        if (!items.length) continue;
        try { const a = core.infoScan.add(k, items); if (a.length) addedInfo[k] = a.length; } catch (e) {}
      }
      return json({ ok: true, removed, speech, samples, addedIntents, addedInfo });
    }

    // ===== 信息识别四功能（2026-11-21 定）：言外之意 / 信息量 / 梗含量 / 自我表达 =====
    // 树状（情绪分组）+ 词典/约定现读联动。四功能共用一套泛化接口 /api/info/:key，不写四份。
    // key: intents | infoamount | memecontent | selfexpress
    const INFO_KEYS = core.infoScan.KEYS;   // intents / infoamount / memecontent / selfexpress / logic
    let infoKey = null, infoOp = '';
    let mm = /^\/api\/info\/([a-z]+)(?:\/([a-z]+))?$/.exec(req.url);
    if (mm && INFO_KEYS.indexOf(mm[1]) >= 0) { infoKey = mm[1]; infoOp = mm[2] || ''; }
    // 兼容旧 /api/intents
    if (req.url === '/api/intents') { infoKey = 'intents'; }
    if (req.url === '/api/intents/del') { infoKey = 'intents'; infoOp = 'del'; }
    if (infoKey) {
      const IS = core.infoScan;
      if (req.method === 'GET' && !infoOp) {
        const out = { ok: true, data: IS.read(infoKey) };
        // 「逻辑」页要整合这一页所有项（含以后新增的）：把其它几项一并带回去，只读展示。
        if (infoKey === 'logic') out.aggregate = IS.digest('', 'logic');
        return json(out);
      }
      if (req.method === 'POST' && !infoOp) {
        const added = IS.add(infoKey, Array.isArray(d.items) ? d.items : [d]);
        return json({ ok: true, added });
      }
      if ((req.method === 'POST' || req.method === 'DELETE') && infoOp === 'del') {
        return json({ ok: IS.del(infoKey, d.id, d.gidx, d.iidx) });
      }
      // 星标样本：删（加是在 /api/chat/star 里按勾选的方面一起写）
      if ((req.method === 'POST' || req.method === 'DELETE') && infoOp === 'delstar') {
        return json({ ok: IS.delStar(infoKey, d.id) });
      }
    }

    // ===== 逻辑页的「案例」（主人 2026-11-21）：星标=她认过的（正面案例），标错=她否过的（负面案例）。
    // 两边都读原来的池（chat-stars / ai-feedback），不复制、不建第二份；这里只做只读汇总。
    if (req.method === 'GET' && req.url === '/api/logic/cases') {
      let stars = [];
      try { stars = readStars().slice().reverse().slice(0, 120); } catch {}
      let issues = [];
      try { issues = core.issueSamples(120); } catch {}
      let masterExamplesList = [];
      try { masterExamplesList = masterExamples.list(); } catch {}
      return json({ ok: true, stars, issues, masterExamples: masterExamplesList });
    }

    /* 主人例句（2026-11-22）：比「正面案例·星标」高一级，存 data/master-examples.json。
     * 面板可加可删；检索时 pri 最高，提示词里学的是「劲」不是句子。 */
    if (req.method === 'GET' && req.url === '/api/logic/master') {
      return json({ ok: true, items: masterExamples.list() });
    }
    if (req.method === 'POST' && req.url === '/api/logic/master') {
      const act = String((d && d.action) || 'add');
      if (act === 'del') {
        if (!d.id) return json({ error: '缺 id' });
        return json(masterExamples.remove(String(d.id)));
      }
      return json(masterExamples.add({ q: d.q, a: d.a, why: d.why, scene: d.scene, by: 'master' }));
    }

    /* ===== 长期记忆 / 按天工作日志 / 每条发言的决策轨迹（2026-11-07 主人定）=====
     * 读写都走 src/memory.js、src/trace.js 这两个入口，这里只做转发和校验。
     * 长期.md 已改名为 MEMORY.md，也可在客户端「文件」页直接改（同一份文件，不另存副本）。 */
    if (req.method === 'GET' && req.url === '/api/memory') {
      return json({ ok: true, raw: memory.readLongRaw(), prompt: memory.longForPrompt(),
        days: memory.listDays(), today: memory.today() });
    }
    if (req.method === 'POST' && req.url === '/api/memory/save') {
      const raw = String(d.raw == null ? '' : d.raw);
      if (!raw.trim()) return json({ error: '不许存空文件' });
      if (!/^##\s*每轮给模型看的\s*$/m.test(raw)) {
        return json({ error: '少了「## 每轮给模型看的」这一节，机器人会读不到' });
      }
      const r = memory.saveLongRaw(raw);
      if (r.error) return json(r);
      memory.appendLog('改动', '长期记忆正本被手动改写');
      return json({ ok: true, prompt: memory.longForPrompt() });
    }
    if (req.method === 'GET' && req.url.indexOf('/api/memory/log?') === 0) {
      const qs = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
      const day = qs.get('day') || memory.today();
      return json({ ok: true, day, raw: memory.readDay(day), days: memory.listDays() });
    }
    if (req.method === 'POST' && req.url === '/api/memory/log') {
      const text = String(d.text || '').trim().slice(0, 300);
      if (!text) return json({ error: '写点什么再记' });
      return json(memory.appendLog(String(d.kind || '手动'), text));
    }
    // 聊天记录里点「推理」：拿回复原文 + 该条时间，去找这一轮代码真正做过的事
    if (req.method === 'GET' && req.url.indexOf('/api/trace?') === 0) {
      const qs = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
      return json({ ok: true, item: trace.findByReply(qs.get('text') || '', qs.get('t') || ''),
        days: trace.listDays() });
    }

    // ===== 话题日志 / 话题 / 约定（长期记忆的三个入口，主人 2026-10-22 定）=====
    // view=topiclog 话题日志：没总结的 + 已总结的（已总结的下面挂灰色原文）
    // view=topics   话题：总结好、收进来的（长期记忆）
    // view=promise  约定：说过的要做到（和人物列表里的约定并行）
    if (req.method === 'GET' && (req.url === '/api/topic' || req.url.indexOf('/api/topic?') === 0)) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const view = qs.get('view') || 'topiclog';
      const all = readTopics();
      const topics = all.filter(x => x.kind !== 'promise');
      const scopes = [], whos = [];
      topics.forEach(x => { if (x.scope && scopes.indexOf(x.scope) < 0) scopes.push(x.scope); if (x.who && whos.indexOf(x.who) < 0) whos.push(x.who); });
      let list = topics;
      if (view === 'topics') list = topics.filter(x => x.state === 'kept');
      // 约定只留两类（2026-11-11 主人令）：条件明确（有触发条件或要说的话）、说话方式（句尾/称呼/语气）。
      // 自动总结出来的「日常」「人物」那种自我感想（= 随手记）一律不进这页——她判定为无意义废话。
      else if (view === 'promise') list = all.filter(x => x.kind === 'promise' && pactKindSv(x) !== 'note');
      else list = topics.filter(x => !x.parent);                 // 话题日志：只有顶层（原文挂在已总结底下）
      const fScope = qs.get('scope') || '', fWho = qs.get('who') || '', fType = qs.get('type') || '', fQ = (qs.get('q') || '').trim(), fDays = Number(qs.get('days') || 0);
      list = list.filter(x => {
        if (fScope && x.scope !== fScope) return false;
        if (fWho && x.who !== fWho) return false;
        if (fType && x.type !== fType) return false;
        if (fQ && String(x.text + ' ' + (x.sum || '') + ' ' + (x.topic || '')).toLowerCase().indexOf(fQ.toLowerCase()) < 0) return false;
        if (fDays) { const t = Date.parse(x.t); if (!isNaN(t) && t < Date.now() - fDays * 86400000) return false; }
        return true;
      });
      // 已总结话题带上它的原文 kids（灰色显示在卡片里）
      const withKids = list.map(x => {
        const kids = all.filter(k => k.parent === x.id);
        return kids.length ? Object.assign({}, x, { kids }) : x;
      });
      // 约定挂在谁名下，名字在服务端算好（'白（B站 100000000）'）：
      // 平台名只有 people.js 一份注册表，客户端别自己再写一张 ——
      // 以后加小红书/抖音/小黑盒，前端一行都不用改。没有 qq 的是通用约定，不塞这个字段。
      const named = withKids.map(x => {
        if (!x || !x.qq) return x;
        let whoName = '';
        try { whoName = people.labelOfKey(x.qq); } catch { whoName = String(x.qq); }
        /* 约定挂在谁名下，名字一律按号去人物表取（2026-11-21 主人：
         * 「名字跟随人物表，而不是新表」）。pid 一并给前端，标签才能点着跳到朋友录里这个人。
         * 标签串本身只是历史快照，可能还是旧昵称——显示时用 owner 现算，别用串里的字。 */
        let pid = '', owner = '';
        if (x.kind === 'promise') {
          try {
            pid = people.pidOfKey(x.qq) || '';
            owner = core.personNameOf(x.qq, x.nick || '') || '';
          } catch { pid = ''; owner = ''; }
        }
        return Object.assign({}, x, { whoName, pid, owner });
      });
      const limit = Number(qs.get('limit') || 500);
      return json({
        view,
        list: named.length > limit ? named.slice(-limit) : named,
        total: named.length, all: all.length,
        types: TOPIC_TYPES, scopes: scopes, whos: whos, platforms: people.platforms(),
        counts: {
          raw: topics.filter(x => !x.parent && x.state === 'raw').length,
          summed: topics.filter(x => !x.parent && x.state === 'summed').length,
          kept: topics.filter(x => x.state === 'kept').length,
          promise: all.filter(x => x.kind === 'promise').length,
        },
      });
    }
    /* 别人教的（2026-11-13）：攻略 / 学到的 / 教学条统一检索 + 单条核实 + 单条删除。
     * 浏览器面板走这里；Electron 客户端走 IPC（main.js → kb.api），同一份实现。 */
    if (req.url === '/api/kb' || req.url.indexOf('/api/kb?') === 0) {
      if (req.method === 'GET') {
        const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
        return json(kb.api('list', {
          q: qs.get('q') || '', who: qs.get('who') || '', kind: qs.get('kind') || 'all',
          verified: qs.get('verified') || 'all', only: qs.get('only') || '',
          since: qs.get('since') || '', until: qs.get('until') || '',
          limit: qs.get('limit') || 60,
        }));
      }
      if (req.method === 'POST') {
        const act = String((d && d.action) || 'list');
        return json(kb.api(act, d || {}));
      }
    }
    /* 教学条（2026-11-12 主人定）：带 id 署名、按方向另存、只在教的人在场时用。
    if (req.method === 'GET' && (req.url === '/api/teach' || req.url.indexOf('/api/teach?') === 0)) {
      const all = core.teachList().map(x => {
        let whoName = '';
        if (x.qq) { try { whoName = people.labelOfKey(x.qq); } catch { whoName = String(x.qq); } }
        return Object.assign({}, x, { whoName });
      });
      const counts = {};
      all.forEach(x => { counts[x.dir] = (counts[x.dir] || 0) + 1; });
      // 栏目级轴覆盖（2026-11-13）：整栏切「检索式 / 在场」，改完即时生效
      let axis = {};
      try { axis = core.teachAxisCfg(); } catch {}
      return json({ list: all, dirs: core.teachDirs, sections: core.teachSections, counts, axis });
    }
    /* 栏目级切轴：{dir, field:'retrieval'|'present', value:true|false|null}（null = 回到方向默认） */
    if (req.method === 'POST' && req.url === '/api/teach/axis') {
      const r = core.teachSetAxisDir(String(d.dir || ''), String(d.field || ''), d.value === null ? null : !!d.value);
      if (r === null) return json({ error: '没写进去（方向或字段不认识）' });
      return json({ ok: true, dir: String(d.dir || ''), axis: r });
    }
    /* 教学条的 edit / move / del 也先过硬闸（teach.js 内部同样有，这里给出可读的错误）。 */
    if (req.method === 'POST' && /^\/api\/teach\/(edit|del|move)$/.test(req.url)) {
      const g = core.reviewGuard(d.id);
      if (!g.ok) return json({ error: g.error });
    }
    if (req.method === 'POST' && req.url === '/api/teach/del') {
      return json({ ok: core.teachDel(d.id), id: String(d.id || '') });
    }
    if (req.method === 'POST' && req.url === '/api/teach/move') {
      return json({ ok: !!core.teachEdit(d.id, { dir: String(d.dir || '') }), id: String(d.id || '') });
    }
    if (req.method === 'POST' && req.url === '/api/teach/edit') {
      return json({ ok: !!core.teachEdit(d.id, {
        say: String(d.say || ''), when: Array.isArray(d.when) ? d.when : undefined,
        note: String(d.note || ''), dir: String(d.dir || ''),
      }), id: String(d.id || '') });
    }
    if (req.method === 'POST' && req.url === '/api/teach/add') {
      const it = core.teachAdd({
        text: String(d.text || ''), qq: String(d.qq || ''), nick: String(d.nick || ''),
        scope: String(d.scope || ''), by: 'master', src: '客户端手动录入',
      });
      return json({ ok: !!it, item: it });
    }

    /* ===== 三类知识统一复核（2026-11-12 主人定）=====
     * 教学 / 约定 / 话题三类，一个 API 读三处原文件；复核状态在条目自身，不建平行总表。
     * locked 条目的一切 edit/del 在 core.reviewGuard 里硬拒，前端禁用只是显示层。 */
    if (req.method === 'GET' && (req.url === '/api/review' || req.url.indexOf('/api/review?') === 0)) {
      const qs = new URLSearchParams(req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const kind = qs.get('kind') || 'all', scope = qs.get('scope') || '';
      const all = core.reviewAll();
      const named = all.map(x => {
        let whoName = '';
        if (x.qq) { try { whoName = people.labelOfKey(x.qq); } catch { whoName = String(x.qq); } }
        // 约定的名字按号去人物表取，连 pid 一起给前端（点名字跳朋友录里这个人）
        let pid = '', owner = '';
        if (x.rkind === 'promise' && x.qq) {
          try { pid = people.pidOfKey(x.qq) || ''; owner = core.personNameOf(x.qq, x.nick || '') || ''; } catch {}
        }
        return Object.assign({}, x, {
          whoName, pid, owner, state: reviewMod.stateOf(x), credit: reviewMod.creditOf(x),
          section: x.section || (x.rkind === 'promise' ? pactKindSv(x) : ''),
        });
      });
      let list = named;
      if (kind !== 'all') list = list.filter(x => x.rkind === kind);
      if (scope) list = list.filter(x => String(x.scope || '') === scope);
      const counts = {}, stateCount = { pending: 0, legacy: 0, locked: 0 };
      for (const x of named) {
        counts[x.rkind] = (counts[x.rkind] || 0) + 1;
        stateCount[reviewMod.stateOf(x)] = (stateCount[reviewMod.stateOf(x)] || 0) + 1;
      }
      return json({ list, counts, stateCount, dirs: core.teachDirs, sections: core.teachSections });
    }
    if (req.method === 'POST' && req.url === '/api/review/edit') {
      const r = core.reviewEdit(d.id, d.patch || d);
      return json(r && r.item ? { ok: true, item: r.item } : { error: (r && r.error) || '没改上' });
    }
    if (req.method === 'POST' && req.url === '/api/review/confirm') {
      const it = core.reviewConfirm(d.id);
      return json(it ? { ok: true, item: it } : { error: '没有这条' });
    }
    if (req.method === 'POST' && req.url === '/api/review/evidence') {
      const it = core.reviewAttach(d.id);
      return json(it ? { ok: true, item: it, evidence: (it.review || {}).evidence || [] } : { error: '没有这条' });
    }
    if (req.method === 'POST' && req.url === '/api/review/del') {
      const r = core.reviewDelete(d.id);
      return json(r && r.ok ? { ok: true } : { error: (r && r.error) || '没删掉' });
    }
    if (req.method === 'POST' && req.url === '/api/review/reclass') {
      const r = core.reviewReclass(d.id, d.target || d);
      return json(r && r.item ? { ok: true, item: r.item, removed: r.removed || '' } : { error: (r && r.error) || '没转成' });
    }
    if (req.method === 'POST' && req.url === '/api/review/credit') {
      const it = core.reviewCredit(d.id, String(d.credit || ''));
      return json(it ? { ok: true, item: it } : { error: '没有这条' });
    }

    /* 朋友录：好感度 + 约定合并汇总（2026-11-12 主人定）。
     * 服务端只把原始数据按人归好：朋友录 favor>20 / 人物册 favor<=20 / 通用约定（无署名）。
     * 人物喜好厌恶（六节）、代称、事实都在 readPeople() 里，前端直接展示 + 改。 */
    if (req.method === 'GET' && req.url === '/api/friends') {
      const plist = readPeople().list || [];
      const all = readTopics();
      const promises = all.filter(x => x.kind === 'promise');
      const byPid = {};
      for (const pct of promises) {
        let pid = '';
        if (pct.qq) { try { pid = people.pidOfKey(pct.qq) || ''; } catch {} }
        const key = pid || '__common';
        (byPid[key] = byPid[key] || []).push(Object.assign(reviewMod.ensure(pct, { legacy: true }), {
          state: reviewMod.stateOf(pct), credit: reviewMod.creditOf(pct),
          whoName: pct.qq ? (() => { try { return people.labelOfKey(pct.qq); } catch { return String(pct.qq); } })() : '所有人',
          // 名字跟随人物表 + pid（点名字跳朋友录用），和 /api/topic、/api/review 一个口径
          pid: pid || '', owner: pct.qq ? (core.personNameOf(pct.qq, pct.nick || '') || '') : '',
        }));
      }
      const enriched = plist.map(p => {
        // AI 标记（2026-11-21）：按账号查单独那份表；任一号是 AI → 整个人物算 AI
        const ai = [];
        for (const a of (p.accounts || [])) {
          const r = aiMark.recOf(a.platform, a.id);
          if (r && r.level && !r.exempt) ai.push({ platform: a.platform, id: a.id });
        }
        return Object.assign({}, p, {
          // 朋友录 / 人物册的分界：和 people.roleOf 里的「朋友」读同一个常量（2026-11-22）
          zone: Number(p.favor) > people.FRIEND_AT ? 'friend' : 'book',
          // 所在地（2026-11-19）：按人物从地区表取，人物卡里直接显示 / 改
          region: region.getRegion(p.pid),
          pacts: byPid[p.pid] || [],
          aliasReview: (() => {
            try {
              const raw = people.get(p.pid) || {};
              return (raw.review && raw.review.alias) || { state: reviewMod.LEGACY };
            } catch { return { state: reviewMod.LEGACY }; }
          })(),
          ai, isAI: ai.length > 0,
        });
      });
      return json({
        people: enriched, common: byPid.__common || [],
        sections: core.teachSections, dirs: core.teachDirs,
        counts: { friend: enriched.filter(p => p.zone === 'friend').length,
          book: enriched.filter(p => p.zone === 'book').length, common: (byPid.__common || []).length },
      });
    }
    /* ===== AI 账号标记（2026-11-21 主人定）=====
     * 单独一份 data/ai-marks.json：标记 / 移除都只动这一份，people.json 一个字节不动。
     * 标记 = 名字带关键词那套自动判定的手动版；移除 = 记豁免（以后自动判定绕开这个号）。 */
    if (req.method === 'POST' && req.url === '/api/ai/mark') {
      const pid = String(d.pid || '');
      const level0 = ['t0', 't1', 't2'].includes(d.level) ? d.level : 't1';
      const targets = [];
      let person = null;
      if (pid) { person = people.get(pid); if (person) for (const a of (people.accountsOf(pid) || [])) targets.push(a); }
      if (!targets.length && d.platform && d.id) targets.push({ platform: String(d.platform), id: String(d.id) });
      if (!targets.length) return json({ error: '没找到账号' });
      const finish = (level, deep) => {
        // silent：主人手动标的，不用再私信通知她（自动判定那条路也不会再报这个号）
        for (const a of targets) aiMark.mark(a.platform, a.id, level, { by: 'master', src: deep ? 'deepcheck' : 'manual', name: String(d.name || ''), silent: true });
        if (person) { try { people.setFavorLock(pid, true); people.setFavor(pid, 0, { force: true }); } catch {} }
        return json({ ok: true, level, deep: !!deep, n: targets.length });
      };
      /* 非 QQ 的 t1/t2 → 抓主页二重判（2026-11-21 主人定）：二重也中就当 t0，不私信。
       * 目前只有 B站 能抓（有现成接口）；其他平台抓不了，按原档处理。B站抓取 8 秒+、有风控，只对真被标记的号跑。 */
      if (level0 !== 't0') {
        const bili = targets.filter(a => String(a.platform) === 'bili' && /^\d+$/.test(String(a.id)));
        if (bili.length) {
          Promise.all(bili.map(a => biliSpace.home({ mid: String(a.id) }).catch(() => null))).then(homes => {
            let deep = false;
            for (const h of homes) {
              if (!h || !h.ok) continue;
              const texts = [];
              if (h.prof && h.prof.sign) texts.push(h.prof.sign);
              for (const it of (h.items || []).slice(0, 12)) texts.push(String(it.title || '') + ' ' + String(it.desc || it.summary || ''));
              if (aiMark.classifyHomeText(texts.join(' '))) { deep = true; break; }
            }
            finish(deep ? 't0' : level0, deep);
          }).catch(() => finish(level0, false));
          return;
        }
      }
      return finish(level0, false);
    }
    if (req.method === 'POST' && req.url === '/api/ai/unmark') {
      const pid = String(d.pid || '');
      const targets = [];
      let person = null;
      if (pid) { person = people.get(pid); if (person) for (const a of (people.accountsOf(pid) || [])) targets.push(a); }
      if (!targets.length && d.platform && d.id) targets.push({ platform: String(d.platform), id: String(d.id) });
      if (!targets.length) return json({ error: '没找到账号' });
      for (const a of targets) aiMark.unmark(a.platform, a.id);
      if (person) { try { people.setFavorLock(pid, false); } catch {} }
      return json({ ok: true, n: targets.length });
    }
    if (req.method === 'GET' && req.url === '/api/ai/list') {
      return json({ list: aiMark.list() });
    }
    /* 地区表按人物读写（2026-11-19 主人令：客户端人物卡里能自己加地区）。
     * 键是人物ID（region.js 里 keyFor），跟人物表一一对应；老数据的裸 QQ 号读得到、写时自动挪走。
     * GET 只读；POST city 为空 = 清掉这个人的地区。 */
    if (req.method === 'GET' && req.url.indexOf('/api/region?') === 0) {
      const q = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
      const uid = String(q.get('uid') || q.get('pid') || '');
      return json({ ok: true, uid, city: region.getRegion(uid) });
    }
    if (req.method === 'POST' && req.url === '/api/region/set') {
      const uid = String(d.uid || d.pid || '');
      const city = String(d.city == null ? '' : d.city).trim();
      if (!uid) { logWrite('/api/region/set', d, false, '没给人物', Date.now() - _t0); return json({ error: '没给人物' }); }
      if (!people.get(uid) && !people.pidOfKey(uid)) { logWrite('/api/region/set', d, false, '没有这个人', Date.now() - _t0); return json({ error: '没有这个人' }); }
      const chg = city ? region.setRegion(uid, city) : { changed: region.clearRegion(uid), city: '' };
      logWrite('/api/region/set', d, true, '', Date.now() - _t0);
      return json({ ok: true, uid, city, changed: !!(chg && chg.changed) });
    }
    /* 代称复核（约定·代称分支，主人 2026-11-12）：确认 / 编辑代称本身。
     * 代称还是 people.json 的 alias 一份，状态挂在人物的 review.alias 上，不复制内容。 */
    if (req.method === 'POST' && req.url === '/api/alias/confirm') {
      const pid = String(d.pid || '');
      const o = people.load();
      if (!o[pid]) return json({ error: '没有这个人' });
      o[pid].review = o[pid].review || {};
      o[pid].review.alias = { state: reviewMod.LOCKED, evidence: [], lockedBy: 'master', lockedAt: new Date().toISOString() };
      people.save(o);
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/alias/unlock') {
      const pid = String(d.pid || '');
      const o = people.load();
      if (!o[pid]) return json({ error: '没有这个人' });
      if (o[pid].review) delete o[pid].review.alias;
      people.save(o);
      return json({ ok: true });
    }
    /* 删除这个人的全部单人数据（2026-11-13 主人令：「全部数据删除前后端都不留」）。
     * 范围：人物档案 / 好感 / 喜好厌恶 / 事实 / 代称 / 跟他的约定与话题 / 两个镜像文件。
     * 不删：别人教的知识（那条不删、署名也保留）、聊天记录（全群上下文的完整性，删一条等于篡改别人的对话）。
     * 要 confirm:'DELETE' 才动手；主人自己的号不许删。 */
    if (req.method === 'POST' && req.url === '/api/person/purge') {
      const pid = String(d.pid || '');
      if (String(d.confirm || '') !== 'DELETE') return json({ error: '要 confirm:"DELETE" 才删' });
      const p = people.get(pid);
      if (!p) return json({ error: '没有这个人' });
      const cfgM = readCfg();
      const masterIds = [cfgM.masterQQ].concat(cfgM.masters || []).map(String).filter(Boolean);
      if ((p.accounts || []).some(a => String(a.platform) === 'qq' && masterIds.indexOf(String(a.id)) >= 0)) {
        return json({ error: '主人自己的号不许删' });
      }
      const accKeys = new Set((p.accounts || []).map(a => String(a.platform) + ':' + String(a.id)));
      const accIds = new Set((p.accounts || []).map(a => String(a.id)).filter(Boolean));
      const mine = q => {
        const s = String(q || '');
        if (!s) return false;
        const k = s.indexOf(':') >= 0 ? s : 'qq:' + s;
        return accKeys.has(k);
      };
      const removed = { person: 0, topics: 0, taste: 0, facts: 0, skippedMulti: 0 };

      /* ① topics.jsonl：约定 / 话题。带 dir 的是「别人教的」派生条，不删。 */
      try {
        const tp = path.join(ROOT, 'data', 'topics.jsonl');
        const rows = fs.readFileSync(tp, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        const keep = [];
        for (const x of rows) {
          if (!x.dir && mine(x.qq)) { removed.topics++; continue; }
          keep.push(x);
        }
        fs.writeFileSync(tp, keep.map(x => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
      } catch (e) { return json({ error: 'topics 没清干净：' + e.message }); }

      /* ② 人物喜好.md：按「## 名字（号）」整段删。 */
      try {
        const tpath = path.join(ROOT, 'data', '人物喜好.md');
        if (fs.existsSync(tpath)) {
          const segs = fs.readFileSync(tpath, 'utf8').split(/\n(?=## )/);
          const keep = [];
          for (const seg of segs) {
            const m = seg.match(/^##\s+[\s\S]*?（(\d+)）/);
            if (m && accIds.has(m[1])) { removed.taste++; continue; }
            keep.push(seg);
          }
          fs.writeFileSync(tpath, keep.join('\n'), 'utf8');
        }
      } catch (e) { return json({ error: '人物喜好没清干净：' + e.message }); }

      /* ③ 人物列表.md：只删「这一行只提到他」的；同时提到别人的不动（免得连带删掉别人的事实）。 */
      try {
        const lpath = path.join(ROOT, 'data', '人物列表.md');
        if (fs.existsSync(lpath)) {
          const lines = fs.readFileSync(lpath, 'utf8').split('\n');
          const keep = [];
          for (const l of lines) {
            if (!/^[-*]\s+/.test(l)) { keep.push(l); continue; }
            if (![...accIds].some(id => l.indexOf(id) >= 0)) { keep.push(l); continue; }
            // 这一行里还提到别的号 → 不是他一个人的事实，留着，数目如实报回去
            const others = (l.match(/\d{6,12}/g) || []).some(n => !accIds.has(n));
            if (others) { removed.skippedMulti++; keep.push(l); continue; }
            removed.facts++;
          }
          fs.writeFileSync(lpath, keep.join('\n'), 'utf8');
        }
      } catch (e) { return json({ error: '人物列表没清干净：' + e.message }); }

      /* ④ 学习系统（2026-11-13）：好感流水、好感衰减、三份档案、每人知识库 = 单人限定，全删。
       * users/<pid>/ 整目录 + acts/*.jsonl 里 pid 是这个人那些行。 */
      try {
        const LEARN = path.join(ROOT, 'data', 'learn');
        const udir = path.join(LEARN, 'users', pid);
        if (fs.existsSync(udir)) { fs.rmSync(udir, { recursive: true, force: true }); removed.learnUser = 1; }
        const adir = path.join(LEARN, 'acts');
        if (fs.existsSync(adir)) {
          for (const f of fs.readdirSync(adir)) {
            if (!/\.jsonl$/.test(f)) continue;
            const fp = path.join(adir, f);
            const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
            const keep = lines.filter(l => { try { return String(JSON.parse(l).pid || '') !== pid; } catch { return true; } });
            if (keep.length !== lines.length) {
              removed.learnActs = (removed.learnActs || 0) + (lines.length - keep.length);
              fs.writeFileSync(fp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
            }
          }
        }
      } catch (e) { return json({ error: '学习系统没清干净：' + e.message }); }

      /* ⑤ people.json：删人物本身（镜像 people-state / favor 由 save 里的 syncMirrors 自动重写）。 */
      const o = people.load();
      delete o[pid];
      if (!people.save(o)) return json({ error: 'people.json 没写进去' });
      removed.person = 1;
      return json({ ok: true, pid, name: p.name || p.pid, accounts: [...accKeys], removed });
    }
    /* 人物喜好厌恶：改文字 / 换节 / 新增（主人 2026-11-12「补上一直漏了的」）。
     * 删除仍走老的 /api/taste/del，参数不变。 */
    if (req.method === 'POST' && req.url === '/api/taste/set') {
      const uid = String(d.qq || d.uid || '');
      const sec = String(d.sec || '');
      const mode = String(d.mode || 'edit');
      if (!uid) return json({ error: '要指定是哪个人' });
      const taste = require('../taste');
      if (mode === 'add') {
        const ok = taste.addItem(uid, sec, String(d.text || ''));
        return json(ok ? { ok: true } : { error: '没加上（内容空或已存在）' });
      }
      const ok = taste.setItem(uid, sec, String(d.oldText || ''), {
        text: String(d.text === undefined ? d.oldText || '' : d.text), sec: d.targetSec || sec,
      });
      return json(ok ? { ok: true } : { error: '没找到这条，或这一节不对' });
    }

    /* 我的口味（人设层，主人＝虚幻共用）2026-11-13 主人令：
     * 「我的喜好表里是有几行喜欢的内容的，你没接入。我和虚幻共用喜好，但我们喜欢的人不共用。」
     * GET 返回三行词表 + 「喜欢的人」（按人物，各记各的）；POST 加 / 改 / 换行 / 删。
     * 写在 soul/F-全场景通用主人设/0-我的喜好.md，和机器人读的是同一份，不另存。 */
    if (req.method === 'GET' && req.url === '/api/taste/mine') {
      const taste = require('../taste');
      return json(Object.assign({ ok: true }, taste.mineListAll()));
    }
    if (req.method === 'POST' && req.url === '/api/taste/mine') {
      const taste = require('../taste');
      const mode = String(d.mode || 'add');
      const sec = String(d.sec || 'likeConf');
      const byUser = { byUser: true };            // 面板里的写 = 她手动改，锁着也放行
      if (mode === 'add') return json(taste.mineAdd(sec, String(d.text || ''), byUser));
      if (mode === 'edit') return json(taste.mineSet(sec, String(d.oldText || ''), String(d.text || ''), String(d.targetSec || ''), byUser));
      if (mode === 'del') return json(taste.mineDel(sec, String(d.text || d.oldText || ''), byUser));
      if (mode === 'move') return json(taste.mineMoveItem(sec, String(d.text || ''), Number(d.toIdx) || 0, byUser));
      if (mode === 'order') return json(taste.mineReorder(d.order || [], byUser));
      return json({ error: 'mode 只能是 add / edit / del / move / order' });
    }
    /* 喜好表的参数与锁（2026-11-13）：参数可在这页直接调；锁只有主人能开关 */
    if (req.method === 'GET' && req.url === '/api/taste/cfg') {
      const c = require('../tastecfg');
      return json({ ok: true, cfg: c.load(), cols: c.cols() });
    }
    if (req.method === 'POST' && req.url === '/api/taste/cfg') {
      const c = require('../tastecfg');
      if (d.locked !== undefined) return json(c.setLock(!!d.locked, { by: 'master' }));
      const r = c.save({ show: d.show || {}, order: d.order });
      return json(r ? { ok: true, cfg: r } : { error: '没写进去' });
    }

    /* 话题三级（2026-11-13 主人令）：单人话题 / 群话题 / 通用话题，前端可改判定。 */
    if (req.method === 'POST' && req.url === '/api/topic/level') {
      // 可多选：levels 数组（单人 / 群 / 通用 能重合）；老前端只传 level 也认
      const r = core.topicSetLevels(String(d.id || ''), d.levels !== undefined ? d.levels : String(d.level || ''));
      return json(r.error ? { error: r.error } : r);
    }
    if (req.method === 'POST' && req.url === '/api/topic/participants') {
      const r = core.topicSetParticipants(String(d.id || ''), Array.isArray(d.participants) ? d.participants : []);
      return json(r.error ? { error: r.error } : r);
    }
    if (req.method === 'POST' && req.url === '/api/topic/ttl') {
      const r = core.topicSetTtl(String(d.id || ''), String(d.ttl || 'short'));
      return json(r.error ? { error: r.error } : r);
    }
    /* 喜 / 无感 / 厌 人物表（2026-11-13）：只看当前人物表里的人；无感默认隐藏 */
    if (req.method === 'GET' && req.url.indexOf('/api/relation/list') === 0) {
      const u = new URL(req.url, 'http://x');
      const who = String(u.searchParams.get('who') || '');
      return json({ ok: true, who, list: core.relationList(who), labels: require('../relation').LABEL });
    }
    if (req.method === 'POST' && req.url === '/api/relation/set') {
      const r = core.relationSet(String(d.a || ''), String(d.b || ''), String(d.s || 'neutral'), { why: String(d.why || '面板') });
      return json(r ? { ok: true } : { error: '没记上（两个人得都在人物表里）' });
    }

    /* 锁定条目硬闸（2026-11-12）：topic 系列的单条写操作先过这一关。
     * 批量删 / 清空不整批拒绝，改成跳过 locked 保留（否则以后永远清不空），返回 skipped 数。 */
    if (req.method === 'POST' && /^\/api\/topic\/(edit|keep|unkeep|del|sum)$/.test(req.url)) {
      const g = core.reviewGuard(d.id);
      if (!g.ok) return json({ error: g.error });
    }

    // 录入一条：to=log 话题日志（没总结）/ topics 话题（直接收进）/ promise 约定
    if (req.method === 'POST' && req.url === '/api/topic/add') {
      const text = String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) return json({ error: '写点内容再保存' });
      const type = TOPIC_TYPES[d.type] ? d.type : 'manual';
      const to = d.to === 'topics' ? 'topics' : (d.to === 'promise' ? 'promise' : 'log');
      /* 录入走 core.topicAdd 同一个口子（2026-11-21 主人：「录入的时候就一次录对」）：
       * 约定标签按人物表里的名字生成、pact 字段一并写上，面板这里不再自己拼一份。 */
      const it = core.topicAdd({
        kind: to === 'promise' ? 'promise' : 'topic',
        type, state: to === 'log' ? 'raw' : 'kept',
        who: String(d.who || '').slice(0, 40), qq: String(d.qq || ''),
        scope: String(d.scope || '').slice(0, 40), nick: String(d.nick || d.who || '').slice(0, 40),
        topic: String(d.topic || ''), text,
        // 面板手动写「约定」= 她本人定的规矩（免记录群也照样落，2026-11-13 的口径）；
        // 写话题日志/话题就不用带 pact 这个字段
        pact: to === 'promise' ? true : undefined,
        byMaster: to === 'promise',
      });
      if (!it) return json({ error: '没写进去（免记录群 / 内容为空）' });
      return json({ ok: true, item: it });
    }
    // 让它总结：新建一条「已总结话题」，原来没总结的内容挂到它底下（灰色）
    // v52：总结联系上下文（单人上5、整群上10、下3，分别算，从聊天记录现取）
    if (req.method === 'POST' && req.url === '/api/topic/sum') {
      const list = readTopics();
      const it = list.find(x => x.id === String(d.id || ''));
      if (!it) return json({ error: '没有这条' });
      if (it.parent) return json({ error: '这条已经挂在某个已总结话题底下了' });
      const ctx = topicContext(it);
      const r = await llmSay(
        '下面是一段群聊/私聊里「可能是话题」的原始内容，还给了它前后的聊天上下文。用一句到两句话概括**原文**是什么话题、大家在聊什么，' +
        '保留关键信息（人名、事物、结论）。上下文只用来帮你看懂，不要把上下文里别的事硬塞进概括，不要加戏，不要复述原文。' +
        (ctx ? '\n\n【上下文】\n' + ctx : '') + '\n\n原文：\n' + it.text, 200);
      if (r.error) return json({ error: r.error });
      const nt = {
        id: 'T' + topicSeq(), t: new Date().toISOString(), kind: 'topic', type: 'self', state: 'summed',
        who: it.who, qq: it.qq, scope: it.scope, nick: it.nick, topic: it.topic || '',
        parent: '', text: r.text.slice(0, 300), sum: '',
      };
      it.parent = nt.id;
      list.push(nt); writeTopics(list);
      return json({ ok: true, item: nt });
    }
    // 修改一条（主人 2026-10-22 v52 定：话题总结后可以具体修改）
    if (req.method === 'POST' && req.url === '/api/topic/edit') {
      const list = readTopics();
      const it = list.find(x => x.id === String(d.id || ''));
      if (!it) return json({ error: '没有这条' });
      if (d.text !== undefined) { const v = String(d.text).trim(); if (!v) return json({ error: '内容不能删空' }); it.text = v.slice(0, 2000); }
      // 标签同样只走一条规则（约定的标签要留得下人物表里的整个名字）
      if (d.topic !== undefined) it.topic = core.topicLabelFor(d.topic, { pact: core.isPact(it), qq: it.qq, nick: it.nick, who: it.who });
      // 老条目没有 pact 字段：既然这次要重写它，就把判定结果补上（不另做批量迁移）
      if (it.kind === 'promise' && it.pact === undefined) it.pact = core.isPact(it);
      writeTopics(list);
      return json({ ok: true, item: it });
    }
    // 收进「话题」（长期记忆）：总结好了才能收
    if (req.method === 'POST' && req.url === '/api/topic/keep') {
      const list = readTopics();
      const it = list.find(x => x.id === String(d.id || ''));
      if (!it) return json({ error: '没有这条' });
      if (it.kind === 'promise') return json({ error: '约定已经在长期记忆里了' });
      const text = (it.text || '').trim();
      if (!text) return json({ error: '还没有内容可收' });
      it.state = 'kept';
      writeTopics(list);
      return json({ ok: true, item: it });
    }
    // 挪回话题日志（收错了）
    if (req.method === 'POST' && req.url === '/api/topic/unkeep') {
      const list = readTopics();
      const it = list.find(x => x.id === String(d.id || ''));
      if (!it) return json({ error: '没有这条' });
      it.state = 'summed';
      writeTopics(list);
      return json({ ok: true, item: it });
    }
    // 删一条：删已总结话题时，它底下的原文回到话题日志顶层（不连坐）
    if (req.method === 'POST' && req.url === '/api/topic/del') {
      const list = readTopics();
      const it = list.find(x => x.id === String(d.id || ''));
      if (!it) return json({ error: '没有这条' });
      const rest = list.filter(x => x.id !== it.id);
      let freed = 0;
      rest.forEach(x => { if (x.parent === it.id) { x.parent = ''; freed++; } });
      writeTopics(rest);
      return json({ ok: true, freed });
    }
    // 批量删除（主人 2026-10-23 定）：一次勾多条删掉。删了已总结话题时，底下的原文回到顶层（不连坐）
    if (req.method === 'POST' && req.url === '/api/topic/delbatch') {
      const raw = Array.isArray(d.ids) ? d.ids : [];
      const ids = raw.map(x => String(x || ''));
      if (!ids.length) return json({ error: '没勾任何一条' });
      const all = readTopics();
      const lockedIds = new Set(all.filter(x => reviewMod.isLocked(x)).map(x => String(x.id)));
      const skipped = ids.filter(id => lockedIds.has(id)).length;
      const okIds = ids.filter(id => !lockedIds.has(id));
      if (!okIds.length) return json({ error: skipped ? '勾中的都已经锁定了，不许删' : '没勾任何一条' });
      const rest = all.filter(x => okIds.indexOf(x.id) < 0);
      let freed = 0;
      rest.forEach(x => { if (x.parent && okIds.indexOf(x.parent) >= 0) { x.parent = ''; freed++; } });
      writeTopics(rest);
      return json({ ok: true, removed: all.length - rest.length, freed, skipped });
    }
    // 清空：kind=topic 话题日志+话题 / kind=promise 约定 / all 全部（真删）
    if (req.method === 'POST' && req.url === '/api/topic/clear') {
      const all = readTopics();
      const kind = String(d.kind || 'all');
      const rest = kind === 'topic' ? all.filter(x => x.kind === 'promise')
        : (kind === 'promise' ? all.filter(x => x.kind !== 'promise') : []);
      // 锁定的不许删：清空时把它们原样留下，前端会报 skipped 条数。
      const keep = all.filter(x => reviewMod.isLocked(x) && !rest.some(r => r.id === x.id));
      const merged = rest.concat(keep);
      writeTopics(merged);
      return json({ ok: true, removed: all.length - merged.length, skipped: keep.length });
    }

    // ===== 网络热梗（卡片页用；数据就是 data/网络热梗.md，改完 guides 缓存自动失效）=====
    const splitWords = w => Array.isArray(w) ? w.map(s => String(s).trim()).filter(Boolean)
      : String(w || '').split(/[｜|、,，；;\s]+/).map(s => s.trim()).filter(Boolean);
    if (req.method === 'GET' && req.url === '/api/meme') {
      return json({ list: guides.memeList().map(s => ({ title: s.title, words: s.words, meaning: s.meaning, ctx: s.ctx, how: s.how, full: s.full, play: s.play, ex: s.ex })) });
    }
    if (req.method === 'POST' && req.url === '/api/meme/add') {
      const r = guides.memeAdd({ title: d.title, words: splitWords(d.words), meaning: d.meaning, ctx: d.ctx, how: d.how, full: d.full, play: d.play, ex: d.ex });
      if (!r.error) botWrite('data/网络热梗.md', '热梗', String(d.title || '').slice(0, 60));
      return json(r);
    }
    if (req.method === 'POST' && req.url === '/api/meme/update') {
      // 客户端约定：origTitle=要改的旧梗名，title=新梗名（不传 title 就是不改名）
      const orig = String(d.origTitle || d.title || '');
      // full/ctx 只有客户端带了才改（旧客户端没这俩字段，别把已录的抹掉）
      const patch = { title: d.title, words: splitWords(d.words), meaning: d.meaning, how: d.how, play: d.play, ex: d.ex };
      if (d.full !== undefined) patch.full = d.full;
      if (d.ctx !== undefined) patch.ctx = d.ctx;
      const r = guides.memeUpdate(orig, patch);
      if (!r.error) botWrite('data/网络热梗.md', '热梗', '改：' + orig.slice(0, 60));
      return json(r);
    }
    if (req.method === 'POST' && req.url === '/api/meme/del') {
      const r = guides.memeDel(String(d.title || ''));
      if (!r.error) botWrite('data/网络热梗.md', '热梗', '删：' + String(d.title || '').slice(0, 60));
      return json(r);
    }

    // ===== 全局体检 / 全局净化（v52：话题、梗库、星标联动这些改过的提示内容都覆盖，后续新的也受影响）=====
    if (req.method === 'POST' && req.url === '/api/checkup') {
      return json(globalCheck());
    }
    if (req.method === 'POST' && req.url === '/api/tidy-all') {
      const r = globalTidy();
      if (r.total) botWrite('（全局净化）', '净化', '清了 ' + r.total + ' 处排版符号（人设/说话风格/梗库/话题）');
      return json(r);
    }

    // ===== 触发词（v80 统一表）：固定话术 / 喊一声就接话 / 不用回复 / 一定回复 =====
    // 主人 2026-10-23 原话：「回复策略现在0条。你应该把这个功能和其他触发词功能整合，而不是继续新增文件。」
    // 数据只有 config.triggers 一处，读写都走 core（私聊命令和这个面板写的是同一份）。
    if (req.method === 'GET' && req.url === '/api/triglist') {
      return json({ list: core.readTriggers(), modes: core.TRIG_MODES });
    }
    if (req.method === 'POST' && req.url === '/api/trig/add') {
      return json(core.triggerAdd(d.word, d.mode, { say: d.say, note: d.note, groupOnly: !!d.groupOnly }));
    }
    if (req.method === 'POST' && req.url === '/api/trig/del') return json(core.triggerDel(d.id));
    if (req.method === 'POST' && req.url === '/api/trig/toggle') return json(core.triggerToggle(d.id, d.on));

    // 更新说明（主人 2026-10-22 定）：每次代码更新都先在面板弹窗、他确认了才算数。读 data/updates.jsonl
    const UPDATES_PATH = path.join(ROOT, 'data', 'updates.jsonl');
    function readUpdates() {
      try {
        return fs.readFileSync(UPDATES_PATH, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      } catch { return []; }
    }
    if (req.method === 'GET' && req.url === '/api/updates') {
      const list = readUpdates();
      return json({ unseen: list.filter(x => !x.ack).length, list });
    }
    if (req.method === 'POST' && req.url === '/api/updates/ack') {
      const list = readUpdates().reverse();
      const all = list.map(x => (String(x.id) === String(d.id) || d.all) ? Object.assign({}, x, { ack: new Date().toISOString() }) : x);
      fs.writeFileSync(UPDATES_PATH, all.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/updates/add') {
      const item = { id: Date.now(), t: new Date().toISOString(), title: String(d.title || '更新').slice(0, 60), detail: String(d.detail || '').slice(0, 2000), ack: null };
      fs.appendFileSync(UPDATES_PATH, JSON.stringify(item) + '\n', 'utf8');
      try { memory.appendLog('改动', '代码更新：' + item.title); } catch {}   // 2026-11-07：更新也算今天做过的事
      return json(item);
    }
    // ===== 需求记录（主人 2026-10-22 晚定）：他提的需求原文留存，QQ 私聊「需求：xxx」自动记 =====
    if (req.method === 'GET' && req.url === '/api/reqs') {
      const list = [];
      try {
        for (const ln of fs.readFileSync(path.join(ROOT, 'data', 'requests.jsonl'), 'utf8').split('\n')) {
          if (!ln.trim()) continue;
          try { list.push(JSON.parse(ln)); } catch {}
        }
      } catch {}
      return json({ list: list.reverse() });
    }
    if (req.method === 'POST' && req.url === '/api/reqs/add') {
      const item = { t: new Date().toISOString(), src: '面板', text: String(d.text || '').slice(0, 500) };
      if (item.text) fs.appendFileSync(path.join(ROOT, 'data', 'requests.jsonl'), JSON.stringify(item) + '\n', 'utf8');
      return json({ ok: !!item.text });
    }

    // ===== 虚幻自查（主人 2026-10-23 定）：AI 自主反馈渠道 ====
    // 三样东西汇成一页：①她的定期自查当前还没解决的问题 ②没发出去的内容（表情/空回复）③模型故障。
    // 只在面板看，QQ 不发。页面上「当前没解决的问题」读selfwatch-state.json，其余读 ai-feedback.jsonl。
    if (req.method === 'GET' && req.url === '/api/feedback') {
      const list = [];
      try {
        for (const ln of fs.readFileSync(path.join(ROOT, 'data', 'ai-feedback.jsonl'), 'utf8').split('\n')) {
          if (!ln.trim()) continue;
          try { list.push(JSON.parse(ln)); } catch {}
        }
      } catch {}
      let open = [], selfT = '';
      try {
        const sw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'selfwatch-state.json'), 'utf8')) || {};
        open = sw.open || []; selfT = sw.t || '';
      } catch {}
      return json({ list: list.reverse(), open, selfT });
    }
    if (req.method === 'POST' && req.url === '/api/feedback/clear') {
      try { fs.writeFileSync(path.join(ROOT, 'data', 'ai-feedback.jsonl'), '', 'utf8'); } catch {}
      return json({ ok: true });
    }
    // 单条删除（主人 2026-10-23 定：看完了不想留的可以单独删掉）
    if (req.method === 'POST' && req.url === '/api/feedback/del') {
      const idx = (d.idx === undefined || d.idx === null) ? -1 : Number(d.idx);   // 注意别写成 d.idx || -1：idx=0（最新一条）会被当成没传
      try {
        const lines = fs.readFileSync(path.join(ROOT, 'data', 'ai-feedback.jsonl'), 'utf8').split('\n').filter(l => l.trim());
        const n = lines.length - 1 - idx;
        if (idx < 0 || n < 0 || n >= lines.length) return json({ error: '没有这条' });
        lines.splice(n, 1);
        fs.writeFileSync(path.join(ROOT, 'data', 'ai-feedback.jsonl'), lines.map(l => l + '\n').join(''), 'utf8');
        return json({ ok: true });
      } catch (e) { return json({ error: '删除失败：' + e.message }); }
    }

    // ===== 梗词典（CHIME 开源数据集，1455 条；服务端过滤，一次最多回 300 条）=====
    if (req.method === 'GET' && (req.url === '/api/memedict' || req.url.indexOf('/api/memedict?') === 0)) {
      const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
      let all = [];
      try {
        all = fs.readFileSync(path.join(ROOT, 'data', '梗词典.jsonl'), 'utf8').split('\n')
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      const kw = q.toLowerCase();
      const hit = kw ? all.filter(x => String(x.meme || '').toLowerCase().indexOf(kw) >= 0 || String(x.meaning || '').indexOf(q) >= 0 || String(x.type || '').indexOf(q) >= 0) : all;
      return json({ total: all.length, shown: hit.length, list: hit.slice(0, 300).map(x => ({ meme: x.meme, meaning: x.meaning, type: x.type || '', offense: !!x.offense })) });
    }

    // ===== 功能日志：功能现状 + 变更历史（倒序，翻页）=====
    if (req.method === 'GET' && (req.url === '/api/features' || req.url.indexOf('/api/features?') === 0)) {
      checkFeatures();
      const q = new URL(req.url, 'http://x').searchParams;
      const off = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      const lim = Math.min(200, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
      const all = readFeatLog().reverse();          // 新的在前
      const lastOn = {};
      all.forEach(x => { if (!lastOn[x.name] && x.action === '启用') lastOn[x.name] = x.t; });
      const states = featureStates().map(x => Object.assign({}, x, { since: lastOn[x.name] || featBootT }));
      return json({ total: all.length, list: all.slice(off, off + lim), states });
    }

    // ===== 规矩手册：所有规矩 + 具体数值（现读 config，永不过时）=====
    if (req.method === 'GET' && req.url === '/api/rules') {
      return json({ genT: new Date().toISOString(), sections: rulesBook() });
    }

    // ===== 数据表：地区 / 称呼（JSON 也放进面板）=====
    if (req.method === 'GET' && req.url === '/api/data') {
      return json({ tables: Object.keys(TABLES).map(id => ({
        id, name: TABLES[id].name, kind: TABLES[id].kind, hint: TABLES[id].hint, rows: readTable(id),
      })) });
    }
    if (req.method === 'POST' && req.url === '/api/data') {
      if (!TABLES[d.id]) return json({ error: '没有这张表' });
      try {
        writeTable(d.id, d.rows);
        return json({ ok: true, rows: readTable(d.id) });
      } catch (e) { return json({ error: '写不了：' + e.message }); }
    }

    // ===== API Key：面板里直接填，填完立刻测一次 =====
    if (req.method === 'GET' && req.url === '/api/key') {
      try {
        const j = configStore.load();
        const k = String((j.llm && j.llm.apiKey) || '').trim();
        const ok = k.length >= 40 && k.includes('.');
        return json({ set: !!k, masked: k ? k.slice(0, 4) + '****' + k.slice(-4) : '', ok, model: (j.llm && j.llm.model) || '' });
      } catch (e) { return json({ error: '读不了 config：' + e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/key') {
      const key = String(d.key || '').trim().replace(/^["']|["']$/g, '');
      if (!key) return json({ error: '没有内容' });
      if (key.length < 40 || !key.includes('.')) {
        return json({ error: '这串不完整：长度 ' + key.length + '，' + (key.includes('.') ? '有' : '没有') + '英文句点。智谱的 Key 是「32位.16位」，请点控制台的「复制」按钮' });
      }
      try {
            const j = configStore.load();
        j.llm = j.llm || {};
        j.llm.apiKey = key;
        configStore.writeFull(j);
        // 立刻打一发，确认真的能用：主模型挤（1305/429）就顺着备用链再试
        let test = 'ok', msg = '', used = '';
        const chain = [j.llm.model].concat(j.llm.fallbackModels || []).filter(Boolean);
        let allBusy = true;
        test = 'fail';
        for (const m of chain) {
          try {
            const r = await fetch(j.llm.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
              body: JSON.stringify({ model: m, messages: [{ role: 'user', content: '说 ok' }], max_tokens: 4 }),
            });
            const t = await r.text();
            if (r.ok) { test = 'ok'; used = m; msg = ''; break; }
            const busy = r.status === 429 || /"code":"?1305"?/.test(t);
            if (!busy) allBusy = false;
            msg = t.slice(0, 160);
          } catch (e) { allBusy = false; msg = e.message; }
        }
        if (test !== 'ok' && allBusy) { test = 'busy'; msg = '这个模型现在访问量太大'; }
        return json({ ok: true, masked: key.slice(0, 4) + '****' + key.slice(-4), test, msg, used, needRestart: true });
      } catch (e) { return json({ error: '写不了 config：' + e.message }); }
    }

    send(404, 'text/plain; charset=utf-8', '404');
  });          // ← req.on('end') 结束
}              // ← handler 结束
const server = http.createServer(handler);

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log('[panel] http://127.0.0.1:' + PORT));


/* 表情包快照：面板与客户端共用同一份实现（2026-11-03 抠出来，原来写在路由里）。 */
function stickerSnapshot() {
      // 先对账（2026-10-31 口径）：改名接上、纯描述统计、不删任何东西
      let rec = { pureDesc: 0, classified: 0, needDesc: [], renamed: [], filled: 0 };
      try { rec = require('../connectors/qq.js')._stickerReconcile() || rec; }
      catch (e) { console.log('[panel] 对账失败：' + e.message); }
      const SDIR = path.join(ROOT, 'data', 'stickers');
      const SCOM = path.join(SDIR, '常用');
      // 池（2026-11-08 口径）：常用/ 与 虚幻/ 同级，同属 main 48；可用 6；关键词触发 8；少用/根目录 1。
      // 虚幻/ 装的是虚幻形象的表情包，不再写「并入常用」或「讲自己时优先」。
      const SUSABLE = path.join(SDIR, '可用');
      const SSELF = path.join(SDIR, '虚幻');
      // 2026-11-03 主人定：位置 = 身份，她手动归位后必须两侧都生效。
      // 以前面板不扫 关键词触发/ → 那 54 张在面板上根本看不见（机器人却在用），她以为没生效。
      const SKW = path.join(SDIR, '关键词触发');
      // 2026-11-03：原「收到」改名「少用」，不再只是收件箱 —— 它现在是一个能发的池，面板必须看得见。
      const SLOW = path.join(SDIR, '少用');
      const pick = (dir, pre) => {
        try { return fs.readdirSync(dir).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)).map(f => pre + f.replace(/\.[^.]+$/, '')); } catch { return []; }
      };
      const imgs = pick(SDIR, '').concat(pick(SCOM, '常用/')).concat(pick(SUSABLE, '可用/'))
        .concat(pick(SSELF, '虚幻/')).concat(pick(SKW, '关键词触发/')).concat(pick(SLOW, '少用/'));
      const nameOf = f => String(f).split('/').pop();
      const allNames = new Set(imgs.map(nameOf));
      const pools = {
        // 2026-11-03 夜 主人定：所有收图写入 少用/，根目录不再承担收发。
        // 普通池（normal）= 少用/ 里名字 q 开头的情绪图；low = 少用/ 全部张数。
        normal: imgs.filter(f => f.indexOf('少用/') === 0 && /^q(?!q)/i.test(nameOf(f))).length,
        common: imgs.filter(f => f.indexOf('常用/') === 0).length,
        usable: imgs.filter(f => f.indexOf('可用/') === 0).length,
        self: imgs.filter(f => f.indexOf('虚幻/') === 0).length,
        kw: imgs.filter(f => f.indexOf('关键词触发/') === 0).length,
        low: imgs.filter(f => f.indexOf('少用/') === 0).length,
      };
      // 根目录已清空（不再承担收发）。判断保留：万一有图被放回根目录，机器人不会发它，面板要标红。
      const dead = imgs.filter(f => f.indexOf('/') < 0 && !/^q(?!q)/i.test(nameOf(f)));
      let md = '';
      // 场合表在表情包根目录（2026-10-31 主人定：表情包功能所有文件集中放这里）
      try { md = fs.readFileSync(path.join(SDIR, '常用.md'), 'utf8'); } catch {}
      let emo = [];
      try { emo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '情绪表情.json'), 'utf8')) || []; } catch {}
      if (!Array.isArray(emo)) emo = [];
      const qqMod = require('../connectors/qq.js');
      const poolOf = f => {
        const s = String(f);
        if (s.indexOf('常用/') === 0 || s.indexOf('虚幻/') === 0) return 'main';
        if (s.indexOf('可用/') === 0) return 'usable';
        return 'normal';
      };
      // 组：表里写好的 + 自动补的（2026-10-31 主人第 8 条：新图自动分类，不用她动手）
      let groups = [];
      try { groups = qqMod._stickerGroups().groups.map(g => ({ desc: g.desc, names: g.names.slice(), auto: false })); } catch {}
      const inBook = new Set();
      for (const g of groups) for (const n of g.names) inBook.add(n);
      // 2026-11-17 修「场合区重复图」：场合表写了族名（如「得意、q得意」）= 已代表该 stem 下
      // 所有带编号的图（q得意2~17）。自动补若按同一个 stem 再补一遍，就会把族名下每张编号图
      // 都单独列出来，看着像「新增了已有的图」。判据：名字 stem 已被场合表某个名字的 stem 覆盖
      // → 这张图已被族名代表，不再单独补进显示（发图逻辑里族名本来就代表整族，不影响触发）。
      const bookStems = new Set();
      for (const n of inBook) bookStems.add(core.stickerStem(n));
      const gmap = new Map(groups.map(g => [String(g.desc).replace(/[\s，。！？、；：,.;:!?「」『』（）()]/g, ''), g]));
      for (const f of imgs) {
        const n = nameOf(f);
        if (inBook.has(n)) continue;
        if (!core.stickerIsEmotion(f)) continue;            // 关键词类不需要描述
        if (bookStems.has(core.stickerStem(n))) { inBook.add(n); continue; }  // 族名已覆盖，不重复补
        const auto = core.stickerAutoOcc(n);
        if (!auto) continue;                                // 补不出来 → 进 needDesc（bug）
        const k = auto.replace(/[\s，。！？、；：,.;:!?「」『』（）()]/g, '');
        if (!gmap.has(k)) { const g = { desc: auto, names: [], auto: true }; gmap.set(k, g); groups.push(g); }
        const g = gmap.get(k);
        if (g.names.indexOf(n) < 0) g.names.push(n);
        g.auto = true;
        inBook.add(n);
      }
      // 每组补上「库里真有的图名」和归属段
      for (const g of groups) {
        g.alive = g.names.filter(n => allNames.has(n));
        const ps = new Set(g.alive.map(n => { const rel = imgs.find(x => nameOf(x) === n) || n; return poolOf(rel); }));
        g.pool = ps.has('main') ? 'main' : (ps.has('usable') ? 'usable' : 'normal');
      }
      groups = groups.filter(g => g.names.length);
      const unfiled = imgs.filter(f => !inBook.has(nameOf(f)));
      const noImg = emo.filter(e => e && e.cat && !imgs.some(f => core.stickerStem(nameOf(f)) === String(e.cat))).map(e => e.cat);
      // 关键词类兜底开关（2026-11-01）：1 开 / 0 关，默认开。面板表情页那个按钮读这个值。
      const kwFuzzy = ((readCfg().sticker || {}).keywordFuzzy) !== 0;
      // 提示词清单（2026-11-01 主人定：另开文件、提示词只读它）。
      // 这里只报状态给她看：行数、字数、覆盖几张、什么时候生成的。
      const prompt = (() => {
        const LP = path.join(SDIR, '清单.md');
        let txt = '', at = 0;
        try { txt = fs.readFileSync(LP, 'utf8'); at = fs.statSync(LP).mtimeMs; } catch {}
        return {
          file: 'data/stickers/清单.md',
          exists: !!txt,
          rows: txt ? txt.split('\n').filter(l => /^-\s/.test(l)).length : 0,
          chars: txt.length,
          at,
          total: imgs.length,
          text: txt,
          pending: (() => { try { return core._stickerPending() || []; } catch { return []; } })(),
        };
      })();
      return { ok: true, imgs, groups, unfiled, pools, dead, emo, md, kwFuzzy, prompt,
        rec: { pureDesc: rec.pureDesc || 0, classified: rec.classified || 0,
          needDesc: rec.needDesc || [], renamed: rec.renamed || [], filled: rec.filled || 0 },
        noImg, noOcc: [], missing: [], occ: {}, occCommon: {}, occOther: {} };
}

module.exports = {
  parseMd, toMd, cleanTree,
  parseChatLine, readChatLineConv,   // 聊天日志单行解析（删全组 / 删非主人私聊共用，规则只有一份）
  chatNameIndex,           // 显示名 → 人物（面板/客户端/自测共用同一份索引，不另写一套）
  handler,                 // HTTP 请求处理函数：客户端用假 req/res 直接调，复用全部接口
  // ==== 客户端（虚幻.app）用同一份实现，不另写一套 ====
  stickerSnapshot,          // 表情包全量快照
  readPeople,               // 好感度 / 称呼 / 口味 聚合
  readPeopleState, writePeopleState, normAlias,
  featureStates,            // 功能开关状态表
  rulesBook,                // 规矩手册（所有数值）
  triggerMap, costStats, readCfg, CFG_EDIT_MAP,
  checkFeatures, readFeatLog,
};
