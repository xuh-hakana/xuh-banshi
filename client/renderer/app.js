/*
 * app/renderer/app.js — 虚幻客户端界面
 *
 * 五块：表情包 / 好感度 / 触发地图 / 开关 / 数值。
 *
 * 表情包那一页**不在这里画**：直接用 public/sticker-page.js —— 和面板同一份代码，
 * 所以改描述、改图名、拖类别、情绪表、场合表、维护、生成清单全都在。
 * 这里的职责只有：给它一块 DOM、把接口接到 IPC 上、把图地址接到自定义协议上。
 *
 * 其余四页是这里画的，数据来自 window.xuh.snapshot()（IPC → state.js → 面板那份实现）。
 */
'use strict';

const $ = s => document.querySelector(s);
const view = $('#view');
const toastEl = $('#toast');

const S = {
  /* 派活词表（2026-11-22）：面板「所有数值」页直接增删，读 src/config/intent.json */
  intentWords: null,
  intentCfg: null,
  /* 主页 = 聊天记录常驻画布（2026-11-16 做完她 11-14 的整块排版需求）。
   * panel 非空 = 左栏那块「人物列表」被接管面板取代；关掉就回主视图。
   * level 是「一级 / 二级 / 三级 / 四级五级」面包屑，不封顶。 */
  home: {
    panel: '', cls: '', mode: 'sum', level: [], sel: '', conv: '__all', splitKey: '',
    convW: 0, from: 'chat', settings: false,
  },
  accept: { open: false, items: [], count: 0, loading: false, jump: 0 },
  // 2026-11-14 主人令：聊天记录设为主页面（打开客户端先看聊天）
  tab: 'stickers',
  snap: null,
  openPerson: null,
  // 悬浮卡（主人 2026-11-13 §4）：话题从内嵌长列表改成「图形入口 + 悬浮卡」，一页只留一个入口。
  // 2026-11-13 ⑨ 自查：①「增加 / 合并人物账号」前端本来就有（朋友录展开区 add-acc / merge-into / rm-acc），
  // 不另造第二个入口。这里只加「回话路径」这一个全局图形入口。
  float: { friendsTopic: false, chatTopic: false, replypath: false },
  // 回话路径 ⑦⑧：三张表 / 两份喜好表 / 唯一 id 与四栏描述 / 优先级与阈值
  rp: { loaded: false, tab: 'emotion', kind: 'emotion', core: '', form: null, desc: null, word: null, data: null, err: '' },
  // 约定 / 聊天记录（2026-11-06 她要求「做回客户端」）：数据走面板同一套 API，不另存一份
  pacts: { loaded: false, list: [], counts: {}, q: '', kind: 'all' },
  // 信息识别（2026-11-21）：左栏新分组，四页共用一套树状 UI；言外之意/信息量/梗含量/自我表达
  info: { vtab: 'intents', pages: {} },   // pages[key] = {loaded, data}；惰性加载
  // 逻辑（2026-11-21 07:09）：左栏顶级页，页内「逻辑 / 案例」两栏切换；案例=星标(正) + 标错(负)
  logic: { vtab: 'rules', casesLoaded: false, cases: { stars: [], issues: [] } },
  // 记录的（2026-11-12）：带 id 署名、按方向另存、只在教的人在场时用。数据源 /api/teach
  teach: { loaded: false, list: [], dirs: [], sections: [], counts: {}, q: '', dir: 'all', section: 'all', edit: null, axis: {} },
  // 朋友录（2026-11-12）：好感度 + 约定合并汇总，补上人物喜好厌恶；数据走 /api/friends
  friends: { loaded: false, list: [], common: [], counts: {}, sections: [], dirs: [], q: '', zone: 'all', open: null, purge: null,
    // 话题（2026-11-13）：三级（单人 / 群 / 通用）+ 按群分类总开关；我的口味（主人＝虚幻共用）
    groupBy: false, mine: null, mineEdit: null },
  // 复核（2026-11-12）：教学 / 约定 / 话题三类共用一套状态与弹层；数据走 /api/review
  review: { loaded: false, list: [], stateCount: {}, counts: {}, dirs: [], sections: [], q: '', kind: 'all', open: null, busy: false, delAsk: null },
  // 学习（2026-11-09）：每个人的好感事件流水，能看理由、能撤销。数据在 src/data/learn/
  learn: { loaded: false, data: null, busy: '' },
  // 写入日志（2026-11-11 修）：以前 S.logs 根本没建过 → render() 读 S.logs.loaded 抛异常，
  // 点「写入日志」整页画不出来，看着就是「没反应」。这里补上初始状态。
  logs: { loaded: false, list: [], total: 0 },
  // 日记写法与禁用词（2026-11-17 主人令：不许我单方面定，必须给她能改的入口）。
  // 正本是 src/data/diary-rules.json，这里只存「读回来的那一份」，不另存副本。
  diaryRules: null,
  diaryPlugin: null,
  diaryFlow: null,      // 一天一篇日记的流程状态（阶段 / 待审草稿 / 上次发平台成没成），只读
  movePoop: null,       // 自动搬屎配置：config/features.json 的 movePoop 段，前端只读写这一段
  poop: null,           // 搬屎页（2026-11-25）：xuh:poop 读回来的那一份，只读展示
  // 机器人页内两屏（她 11-18 令：日记不要下拉）：body=机器人本体+最近日志，diary=日记写法。
  botSub: 'body',
  // 参数页（2026-11-13 起改为悬浮浮层，状态在独立 PARAM，不再占 S）：开关 / 数值 / 触发地图。
  // conv：当前会话（'__all' 全部 / 'g<群号>' 单个群 / 'p_<人物id>' 某个私聊对象）；会话名由服务端按好感度页规则算好
  // traceOpen / showLog / starItem / issueItem：同一套自绘弹层的几种内容
  // starPicked / issuePicked：加星和标错共用的「多选上下文」，两边各存一份，互不干扰
  chat: { loaded: false, list: [], total: 0, q: '', conv: '__all', onlyBot: false, onlyStar: false, limit: 200, open: new Set(),
    /* 三个分段（主人 2026-11-19 定）：「QQ群」「私信」「B站」。
     * 私信 = 全平台私聊合成一列（QQ 私聊 / B站私信 / 别的平台），不再按平台分组。
     * B站 = 原来左栏那个 B站页，整块搬进来（左栏不再单占一格）。
     * segConv 记「每个分段上次选的是谁」，来回切不会把位置丢掉。 */
    // 默认落在「全部消息」（她原来打开聊天记录看到的就是全部，别改她的习惯）
    tab: 'all', segConv: {},
    // 分片（2026-11-21：面板不显示分区 UI，只整合显示 + 往上翻自动读更早）：
    // 打开只读最近一批分片（不整份读主文件，不卡）；往上翻到顶 → skip 前移，再读更早一批并按时间并进来。
    //  - olderSkip: 下次往上翻从第几段读起；hasMore: 还有没有更早的分片；olderBusy: 防并发
    olderSkip: 0, hasMore: false, olderBusy: false,
    shardSegs: 0, shardTotal: 0, mode: 'recent',
    issues: [], fbList: [], issueItem: null, issuePicked: new Set(), issueNote: '', issueIntents: '', showIssues: false,
    // 兜底词池（2026-11-13 主人令）：聊天记录页里能增 / 删 / 改，按群 / 私聊 / 某人 / 平台分配
    fbOpen: false, fbPool: [], fbDefault: '', fbErr: '', fbBusy: false,
    traceOpen: false, traceLoading: false, traceItem: null,
    showLog: false, logLoading: false, logDays: [], logDay: '', logRaw: '',
    memRaw: '', memPrompt: '',
    // 滚动位置（主人 2026-11-11 定）：每个会话各记一份 {top, bottom, pages}，最多留 10 个会话
    //   pos = 位置表 / posKeys = 先进先出顺序 / pinBottom = 下一次画完强制贴底（切筛选、搜索、刷新这类重置动作）
    //   pages = 这个会话已经往下翻了几页（每页 200 条，翻到顶再加一页）
    //   anchor = 加页后要把原来最上面那条钉在原处 / moreBusy = 加页节流时间戳
    starItem: null, starPicked: new Set(), starNote: '', pos: {}, posKeys: [], pinBottom: false,
    // 客户端发言（2026-11-23 主人令）：输入框草稿 / 待发附件 / 发送中 / 提示语 / 拖拽高亮。
    // 只对「主人私聊」这一个会话显示输入条；别的会话不给，免得拿虚幻的号给别人发话。
    comp: { text: '', atts: [], busy: false, hint: '', drag: false },
    anchor: null, moreBusy: 0, hitTotal: 0, limitNow: 200, groupEdit: null,
    // 聊天记录 ↔ 情绪（主人 2026-11-07 定：能改情绪、能补漏判、和星标/判错联动）
    emo: '', emoBook: null, emoEdit: null, emoWord: '', leakKeys: {},
    emoScan: null, emoScanLoading: false,
    // 花费（2026-11-11）：按会话的 token 合计，服务端算好折合人民币一起带回来（'qq_123' → {rmb,total,in,out}）
    cost: {},
    // 实时思考（2026-11-11）：{ item } = 这个会话最近一条模型思考原文；开关在 cfg.liveThink
    live: { item: null },
    // 聊天记录 ↔ 约定（主人 2026-11-08 定：打开会话看这个会话的约定，并能看到是哪条消息生成的约定）
    pact: false, pactOpen: true, pactById: {}, pactSrc: {},
    // 聊天记录里的话题总览（2026-11-13）：默认收起，展开后按群分类，不出群；筛选按 短期/长期/单人/群/通用/已过期
    topicOpen: false, topicFilter: 'all',
    // 聊天记录里点某人的名字 / 头像 → 就地弹这个人的卡（朋友录 + 记录的），不跳页（主人 2026-11-13）
    person: null,
    // 按会话设置（主人 2026-11-07）：convSettings = 服务端那份 data/conv-settings.json 的快照；
    // convSet = 正在改哪一行（{key, label, kind, uid, n, scopeKey}），null 表示弹层没开
    convSettings: {}, convDefault: { ctx: 30, chars: 600 }, convSet: null, convSetCtx: '', convSetReply: true, convSetBlack: false, convSetModel: false, convDel: false,
    // 回复总开关（2026-11-11 主人定「聊天记录面板里一键关全部 / 私聊 / 群回复」）：replyToggle = 弹层开着
    replyToggle: false,
    // 显示设置（2026-11-10）：值存在机器人端 config（随 /api/chat 带回），这里不另存一份；showSet = 设置弹层开着
    cfg: { imgDescChars: 1200, chatShowLimit: 200, historyLimit: 60, historyChars: 8000 }, showSet: false,
    // 各平台输出字数上限（2026-11-17）：默认=平台上限、手填不能超；打开显示设置时 GET 一份。
    platLimits: null, plProbe: { busy: '', msg: '' },
    // 各平台版本号（2026-11-17）：改版追踪。打开显示设置时跟上限表一起 GET。
    platVersions: null,
    // 保健提醒的设置（2026-11-10 她令「我只需要聊天页面加个时间、次数、分人打开关闭设置就行」）：
    // 打开显示设置时顺带 GET 一份（cfg + people），保存时数值 POST /api/healthremind、
    // 分人开关 POST /api/healthremind/pact。同源同一份 features.json / topics.jsonl，不另存第二套。
    hrCfg: null, hrPeople: [], hrLoadErr: '',
    // 本轮提示词（2026-11-13）：prompts=null=还没拉过，一次性拉取、不轮询、不裁条数；
    // promptFold=区块展开没；promptFull={'群/私聊/平台:来源键':true}=哪些卡片展开了全文。
    prompts: null, promptFold: false, promptFull: {}, promptCats: null, promptCatLabel: null,
    // 右下角浮层（2026-11-14 主人定）：思考 / 话题 / 约定 / 提示词 / 状态 五个标签页；消息流顶部永远不塞任何东西
    dockTab: 'think', liveFold: false,
    // 当前状态（2026-11-14，按人改）：全局（本体外貌）+ 这个人/这个群，两段分开显示。convState=null=还没拉过
    convState: null, stateEdit: null,
    // 消息窗口化（2026-11-14）：每个会话在 list 里的 {start,end} 下标，DOM 只渲染这一屏，翻到边再加载/裁掉相邻页
    win: {}, winTotal: {} },
  bili: { loaded: false, loading: false, days: [], date: '', items: [], total: 0, job: null, dir: '', input: '', mention: null },
  // 攻略：数据走 guides.api（不在 snapshot 里），各自单独拉
  guides: { loaded: false, list: [], status: { found: [], lost: [] }, edit: null, draft: '' },
  // 记录的（2026-11-13）：攻略 / 学到的 / 教学条 单条检索 + 单条核实 + 单条删除
  // 数据走 kb.api（跟机器人每轮检索同一份实现），检索在本地过滤，不每敲一个字打一次接口
  kb: { loaded: false, list: [], stats: null, files: [], q: '', who: '', since: '', until: '', ver: 'all', kind: 'all', only: '', err: '', edit: null, spec: null },
  // 文件（命令方块）：只读归属表列「功能→文件」，点一下在命令方块里打开；读写不在这做
  files: { loaded: false, groups: [], total: 0 },
  // 查梗 / 娱乐网站：内联查 + 站点目录（站目录走 xuh:memeSites，读坏就空着）
  // edit: null=不编辑 | { idx: -1 新增 / >=0 编辑原数组下标, site: {...} }
  meme: { loaded: false, sites: [], term: '', edit: null, vtab: 'meme' },
  // 词汇 · 本地词库（ci.json + restricted.json 侧车）：搜全部 / 只看受限 / 单条判定受限，写回侧车
  // 已并入【查梗】页作为子标签（vtab: 'meme' | 'vocab'），不再单独占一个导航项
  vocab: { loaded: false, q: '', restrictedOnly: false, offset: 0, limit: 100, rows: [], total: 0, restrictedTotal: 0, busy: false },
  // 我的词（user-words.json）：主人专属单独文件，批量导入 / 单条新增 / 编辑 / 删除都在这一层
  user: { loaded: false, q: '', offset: 0, limit: 100, rows: [], total: 0, busy: false, importText: '', importResult: null, adding: false },
  // 提醒（2026-11-10 起叫保健提醒，2026-11-21 主人定改成「提醒」的子类）：
  // tab = health（保健提醒）/ alarm（闹钟）/ roco（洛克王国远行商人）；配置走 /api/healthremind、/api/alarms、/api/roco，
  // 固定标签走 /api/fixedtags。客户端不另存第二份。
  health: { loaded: false, cfg: null, people: [], note: '', pactNote: {}, del: null, newAct: {},
    tab: 'health', roco: null, fixed: [], fixedNote: '', rocoPreview: null, rocoBusy: false,
    bili: null, biliBusy: false, biliScan: null, biliCfg: {},
    alarm: null, alarmCfg: null, alarmNew: { content: '', dueAt: '', scope: '', who: '' },
    unlockKey: '', unlockToken: '', unlockExp: 0 },
  // 模型来源（2026-11-10 她令「直接接入 AstrBot」）：只读 AstrBot 配置，Key 不会回客户端。
  // 现在放进 PARAM.llm（见参数浮层模块），不占 S。
};

/* ---------------- 小工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function num(n) { return Number(n || 0).toLocaleString('zh-CN'); }
// 转义 + 保留换行（\n → <br>），用于词库释义这类多行文本
function escBr(s) { return esc(s).replace(/\n/g, '<br>'); }

/* 给 sticker-page.js 用的节点工厂（面板里也有一个同名的，签名一样） */
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

let toastTimer = null;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.className = 'toast is-on' + (isErr ? ' is-err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, isErr ? 4000 : 2600);
}

/* ---------------- 数据 ---------------- */
/* 派活词表（2026-11-22 主人：「词也需要能增减，词让我能在面板上直接改」）*/
/* dsh agent 卡（2026-11-22）：模式开关 + 兜底句 + 派活词，全在「机器人」页 */
async function loadIntentCfg() {
  try {
    const r = await window.xuh.intentCfg();
    if (r && !r.error) S.intentCfg = r.cfg || null;
  } catch (e) { S.intentCfg = S.intentCfg || null; }
}

async function loadIntentWords() {
  try {
    const r = await window.xuh.intentWords();
    if (r && !r.error) S.intentWords = r.words || { search: [], calc: [], negate: [] };
  } catch (e) { S.intentWords = S.intentWords || { search: [], calc: [], negate: [] }; }
}

async function loadSnapshot() {
  const r = await window.xuh.snapshot();
  if (!r || r.error) { toast('数据读不出来：' + (r && r.error || '未知原因'), true); return; }
  S.snap = r;
  if (!S.intentWords) await loadIntentWords();
  if (!S.intentCfg) await loadIntentCfg();
  paintChrome();
  render();
  loadStatus();
  paramRender();
}

/* ---------------- 顶栏 / 左栏计数 ---------------- */
function paintChrome() {
  const s = S.snap;
  const p = (s && s.people && s.people.list) || [];
  const tr = (s && s.triggers && s.triggers.list) || [];
  const ft = (s && s.features) || [];
  const rl = Array.isArray(s && s.rules) ? s.rules : [];
  const ruleCount = rl.reduce((a, x) => a + ((x.rules || []).length), 0);

  const spData = window.StickerPage && window.StickerPage.data && window.StickerPage.data();
  /* 2026-11-17：回退成固定左栏后，表情包入口 id 是 c-meme（RAIL_SPEC），旧的 c-stickers
   * 已不存在。原来直接写 $('#c-stickers').textContent → 对 null 赋值抛错，整个 paintChrome
   * 从这里中断（表现为左栏计数全是「—」+ 日志两条 unhandledrejection）。改成兜底 + null 保护。 */
  const elStickers = $('#c-meme') || $('#c-stickers');
  if (elStickers) elStickers.textContent = spData ? num((spData.imgs || []).length) : '—';
  // 好感度 + 约定已合并成一个「朋友录」入口（2026-11-12），侧栏只报人数。
  const elFriends = $('#c-friends');
  if (elFriends) elFriends.textContent = S.friends.loaded
    ? num((S.friends.list || []).length) : (s ? num(p.length) : '—');
  // 参数页一个入口（2026-11-11 三页合并）：侧栏只报最常看的那个数——开着的开关数/总数。
  // 数值有多少条、触发词多少条，进页面看顶上那三条分段就知道。
  const elCtrl = $('#c-controls');
  if (elCtrl) elCtrl.textContent = s ? (ft.filter(x => x.state && x.state.indexOf('启用') === 0).length + '/' + ft.length) : '—';
  // 悬浮参数图标（2026-11-13）：常驻角落小图标，snapshot 一刷新就把摘要写进悬浮提示，不用等开面板
  const elParamBar = $('#fabParam');
  if (elParamBar) elParamBar.title = '参数 · ' + paramBarSummary();
  // 约定 / 聊天记录：这两块不走 snapshot（各自单独拉，见 loadPacts / loadChat）
  // 约定并入朋友录，不再单独占一个计数（S.pacts 仍保留给聊天页的「哪条消息生成了约定」用）。
  const elChat = $('#c-chat');
  if (elChat) elChat.textContent = S.chat.loaded ? num(S.chat.total || (S.chat.list || []).length) : '—';
  // 攻略页 2026-11-13 并进「记录的」：导航不再单独占一格，计数合到 c-teach（见 loadTeach / loadGuides）。
  const elFiles = $('#c-files');
  if (elFiles) elFiles.textContent = S.files.loaded ? num(S.files.total || 0) : '—';
  const elLearn = $('#c-learn');
  if (elLearn) elLearn.textContent = S.learn.loaded ? num(((S.learn.data || {}).users || []).length) : '—';

  const ws = (s && s.bot && s.bot.wsUrl) || '';
  const pillBot = $('#pill-bot');
  if (pillBot) {
    pillBot.textContent = ws ? 'QQ ' + ws.replace('ws://', '') : 'QQ 未配';
    pillBot.classList.toggle('is-off', !ws);
  }

  /* 2026-11-14 主人令：「不要显示主人账号」。左边只留模型名（她在意的是用哪个模型在回话），
   * 账号类信息属于隐私，状态栏常驻不合适。 */
  const stL = $('#status-left');
  if (stL) stL.textContent = (s && s.bot && s.bot.model) ? s.bot.model : '—';
  const stR = $('#status-right');
  if (stR) stR.textContent = s ? '数据时间 ' + new Date(s.at).toLocaleTimeString('zh-CN') : '';
  paintStatus();
}

/* 底部状态栏中间那排药丸（2026-11-14 重做）
 * ---------------------------------------------------------------------------
 * 她的话：「状态栏太分散了，且做错了。不要显示主人账号。加群显示的错了，应该是热加载自动同意…
 *          老面板可不止这几个状态栏气泡，没有全搬过来」。
 * 所以这里按老面板（public/panel-client.js 的 renderStatus）补齐，一个不少：
 *   连接 / 正在想 / 暂停中 / 自动同意 / 待确认口味 / 喜好重合 / 好感 满·喜欢 / 自查
 * 每条都能点：点哪儿就去哪儿看，不再是死数字。
 * 数来自 /api/status（面板那份聚合实现，客户端不重复算）。
 */
function paintStatus() {
  const el = $('#status-mid');
  if (!el) return;
  const st = S.status;
  if (!st) { el.innerHTML = ''; return; }
  const pills = [];
  /* go：点了去哪一页；act：点了调哪个函数 */
  const P = (label, cls, opt) => {
    const o = opt || {};
    const attrs = (o.go ? ' data-act="status-go" data-view="' + o.go + '"' : '')
      + (o.act ? ' data-act="' + o.act + '"' : '');
    return '<span class="st st-' + cls + '"' + attrs + ' title="' + esc(o.tip || label) + '">' + label + '</span>';
  };

  // ① 连接：在线 / 离线。离线是最要紧的一条，放最左
  const on = !!st.online;
  pills.push(P(on ? '● 在线' : '● 离线', on ? 'on' : 'off',
    { tip: on ? '机器人进程活着，NapCat 也连着。点一下去机器人页看细节' : '没连上：进程死了或 NapCat 断了。点一下去机器人页', go: 'bot' }));

  // ② 正在想
  if (st.thinking) pills.push(P('正在想…', 'think', { tip: '它正在等模型回话，界面照常能用', go: 'chat' }));

  // ③ 暂停中（她闭嘴的群 / 人）：点开看是哪几个
  if (Array.isArray(st.paused) && st.paused.length) {
    pills.push(P('暂停中 ' + st.paused.length, 'paused', { tip: '这些地方她暂时不回话：' + st.paused.join('、'), go: 'chat' }));
  }

  // ④ 自动同意（热加载自动同意的好友 / 群邀请）：点了列出「同意的都是哪些」，有几条列几条
  if (typeof st.reqNew === 'number' && st.reqNew > 0) {
    pills.push(P('自动同意 ' + st.reqNew, 'req', { tip: '最近自动同意了 ' + st.reqNew + ' 条（加好友 / 被拉进群）。点一下列出是哪几个', act: 'status-accept' }));
  }

  // ⑤ 待确认口味（老面板有，之前没搬）
  if (typeof st.pending === 'number' && st.pending > 0) {
    pills.push(P('待确认口味 ' + st.pending, 'self', { tip: '她提过的喜好里还没表态的条数。点一下去朋友录里看', go: 'friends' }));
  }

  // ⑦ 喜好重合（同一节里描述打架的两条，要主人决定留哪条）
  if (typeof st.clashN === 'number' && st.clashN > 0) {
    pills.push(P('喜好重合 ' + st.clashN, 'self', { tip: '同一节里说法打架的喜好对数。点一下去朋友录里裁决', go: 'friends' }));
  }

  // ⑧ 好感：几个满 / 几个喜欢
  if (typeof st.favFull === 'number' || typeof st.favLike === 'number') {
    const f = Number(st.favFull || 0), l = Number(st.favLike || 0);
    if (f || l) pills.push(P('好感 ' + f + ' 满 · ' + l + ' 喜欢', 'fav', { tip: '满 = 好感 100（宝宝）；喜欢 = 好感 ≥60。点一下看名单', go: 'friends' }));
  }

  // ⑨ 自查：她自己的定期体检
  if (typeof st.selfBad === 'number' && st.selfBad > 0) {
    pills.push(P('自查 ' + st.selfBad, 'self', { tip: '她自己体检发现的问题条数。点一下看', act: 'status-self' }));
  }

  el.innerHTML = pills.join('');
}
async function loadStatus() {
  try {
    const r = await window.xuh.api('GET', '/api/status');
    if (r && !r.error) { S.status = r; paintStatus(); }
  } catch (e) {}
}

/* ---------------- 路由 ---------------- */
const TITLES = {
  bot: '机器人', stickers: '表情包', people: '好感度', pacts: '约定', friends: '朋友录', teach: '记录的', chat: '聊天记录',
  controls: '参数 · 开关 / 数值 / 触发地图', bili: 'B站',
  files: '命令方块（改文件的地方）', meme: '查梗 · 娱乐网站',
  poop: '搬屎',
  learn: '学习 · 好感是怎么变的',
  logs: '写入日志',
  persona: '人设编辑',
  reqs: '需求记录',
  health: '提醒',
  info: '信息识别',
  logic: '逻辑',
  more: '其他',
};

function go(tab) {
  /* 2026-11-19 主人令：B站页不再单占左栏，搬进聊天记录页当第三/第四页。
   * 所有老的 data-view="bili" 入口照旧能用，只是落到聊天页的「B站」分段。 */
  if (tab === 'bili') { S.chat.tab = 'bili'; if (!S.bili.loaded) loadBili(); tab = 'chat'; }
  // 离开聊天页前先把手上的滚动位置记下来（滚完立刻点别处时，scroll 事件可能还没派发）
  if (S.tab === 'chat' && tab !== 'chat') {
    stopLivePoll();                              // 离开聊天页就别再问了
    const msgs = view.querySelector('.msgs');
    if (msgs) chatPosSave(S.chat.conv, msgs);
  }
  S.tab = tab;
  const backBtn = $('#homeBack');
  if (backBtn) backBtn.hidden = (tab === 'chat');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-on', b.dataset.view === tab));
  $('#view-title').textContent = TITLES[tab] || tab;
  view.scrollTop = 0;
  if (tab === 'bot') loadBot();
  if (tab === 'pacts' && !S.pacts.loaded) loadPacts();
  if (tab === 'friends' && !S.friends.loaded) loadFriends();
  if (tab === 'friends' && !S.review.loaded) loadReview();   // 话题（三级）和约定卡片都从复核列表来
  if (!S.review.loaded) loadReview();          // 复核徽标：教学页 / 朋友录页 / 聊天页话题段共用
  if (tab === 'teach' && !S.teach.loaded) loadTeach();
  if (tab === 'info') loadInfoPage(S.info.vtab);
  // 逻辑（2026-11-21）：两栏各自惰性加载——规则走 /api/info/logic，案例走 /api/logic/cases
  if (tab === 'logic') {
    if (!(S.info.pages.logic && S.info.pages.logic.loaded)) loadLogicRules();
    if (!S.logic.casesLoaded) loadLogicCases();
  }
  if (tab === 'teach' && !S.guides.loaded) loadGuides();   // 攻略页并进「记录的」（2026-11-13）
  if (tab === 'teach' && !S.kb.loaded) loadKb();           // 单条检索 / 核实 / 删除（2026-11-13）
  if (tab === 'chat' && !S.chat.loaded) loadChat();
  if (tab === 'files' && !S.files.loaded) loadFiles();
  if (tab === 'meme' && !S.meme.loaded) loadMeme();
  // 词汇·本地词库已并入【查梗】页子标签（vtab: vocab），进入 meme 后再惰性加载
  if (tab === 'learn' && !S.learn.loaded) loadLearn();
  if (tab === 'logs' && !S.logs.loaded) loadLogs();
  if (tab === 'health' && !S.health.loaded) loadHealth();
  render();
  pageHeadSync();        // 页头面包屑 / 上一级跟着当前页走（2026-11-16 四类改版）
  railTickTo();          // 左栏收起时的小标跟着换位置（2026-11-14）
}

/* 同类只留一个图形入口；打开的卡悬浮；点外面关；悬浮卡不做关闭按键（主人 2026-11-13 §4）。 */
function floatBtn(v, title, big) {
  return `<button class="float-btn${big ? ' is-big' : ''}${S.float[v] ? ' is-on' : ''}"`
    + ` data-act="float-topic" data-v="${v}" title="${esc(title)}">◈</button>`;
}
function htmlFloatCards() {
  const out = [];
  /* 全局入口已收进 index.html 的 #fabDock（工具坞，可拖动），这里不再画独立圆钮 ——
   * 她 2026-11-14 令：「右下角入口全堆在一起」「以后加悬浮窗口必须全都可拖动」。
   * ⇄ 的亮/灭状态由 paintFloats() 里的 syncDock() 同步到坞里的按钮上。 */
  if (S.float.friendsTopic) out.push(`<div class="float-card" data-float="friendsTopic">
    <div class="float-card__head"><span class="float-card__t">话题</span>
      <span class="float-card__n">单人 / 群 / 通用 · 按群分类 · 不出群</span></div>
    <div class="float-card__body">${htmlTopicsBlock(S.friends.zone, S.friends.q)}</div></div>`);
  if (S.float.chatTopic) out.push(`<div class="float-card" data-float="chatTopic">
    <div class="float-card__head"><span class="float-card__t">话题</span>
      <span class="float-card__n">只列当前会话 · 不出群</span></div>
    <div class="float-card__body">${htmlChatTopics(S.chat && S.chat.conv)}</div></div>`);
  if (S.float.replypath) out.push(htmlRpCard());
  if (S.accept.open) out.push(htmlAcceptCard());
  if (S.kb.spec) out.push(htmlKbSpec());
  return out.join('');
}
/* 自动同意清单（2026-11-14 主人令）
 * 「加群显示的错了，应该是热加载自动同意，我点击跳转查看同意的是哪些，有几次就跳几次」。
 * 数据来自 /api/accept（面板那份：比 auto-accept-read.json 时间戳新的记录才算未读，
 * items 是最近 20 条，倒序）。点开一条不跳页、不折叠 —— 有几条就列几条。
 * 外壳走 .float-card，所以自动获得「可拖动 + 位置记住」。
 */
async function acceptOpen() {
  S.accept.open = true;
  S.accept.loading = true;
  paintFloats();
  try {
    const r = await window.xuh.api('GET', '/api/accept');
    if (r && !r.error) {
      S.accept.items = Array.isArray(r.items) ? r.items : [];
      S.accept.count = Number(r.count || 0);
    }
  } catch (e) {}
  S.accept.loading = false;
  paintFloats();
}

/* 状态栏「自动同意 N」→ 清单里点一条就跳一条：她 11-14 原话「我点击跳转查看同意的是哪些，
 * 有几次就跳几次」。清单本身保留（几条列几条），跳转按记录逐条走，不删记录。 */
function acceptJump(row) {
  const gid = String(row.dataset.gid || ''), uid = String(row.dataset.uid || '');
  const m = (S.chat.list || []).find(x =>
    (gid && String(x.gid || '') === gid) || (uid && String(x.uid || '') === uid));
  if (!m) { toast('这条还没有对应的聊天记录（可能还没说过话）'); return; }
  const cv = chatConvOf(m);
  S.accept.jump++;
  S.accept.open = false;
  S.home.panel = ''; S.home.sel = ''; S.home.level = [];
  S.chat.conv = cv; S.chat.pinBottom = true;
  go('chat');
  render();
  toast('第 ' + S.accept.jump + ' 次跳转 → ' + (m.convLabel || m.nick || cv));
}

function htmlAcceptCard() {
  const its = S.accept.items || [];
  const body = S.accept.loading
    ? '<div class="loading">读自动同意记录中…</div>'
    : (its.length ? its.map(x => {
        const kind = x.kind === 'group' ? '进群' : '加好友';
        const who = x.who || x.uid || '—';
        const where = x.gid ? '（群 ' + x.gid + '）' : '';
        const when = x.t ? fmtTime(x.t) : '';
        return '<div class="acc-row is-link"'
          + ' data-gid="' + esc(x.gid || '') + '" data-uid="' + esc(x.uid || '') + '"'
          + ' title="点这条跳到对应的聊天记录（有几条就能跳几次）">'
          + '<span class="acc-kind ' + (x.kind === 'group' ? 'is-group' : 'is-friend') + '">' + kind + '</span>'
          + '<span class="acc-who">' + esc(who) + esc(where) + '</span>'
          + '<span class="acc-t">' + esc(when) + '</span></div>';
      }).join('') : '<div class="loading">最近没有自动同意的记录。</div>');
  return `<div class="float-card" data-float="accept">
    <div class="float-card__head"><span class="float-card__t">自动同意</span>
      <span class="float-card__n">最近 ${num(its.length)} 条 · 未看 ${num(S.accept.count)} 条</span>
      <button class="win__x" data-act="accept-read" title="全部标记为已看（不清记录，只清零状态栏那个数）">✓</button>
      <button class="win__x" data-act="accept-close" title="收起">×</button></div>
    <div class="float-card__body">${body}</div></div>`;
}

/* 悬浮卡挂在 body 下的 #floats，跟 #view 分开画（参数浮层同一套做法）：
 * 开关浮层不重绘底下那页，也不会把输入框里没保存的字冲掉。 */
function render() { renderView(); paintFloats(); floatWinApplyAll(); pageHeadSync(); }
function paintFloats() {
  let box = document.getElementById('floats');
  if (!box) { box = document.createElement('div'); box.id = 'floats'; document.body.appendChild(box); }
  box.innerHTML = htmlFloatCards();
  syncDock();
  floatWinApplyAll();
}
/* 工具坞里的 ⇄ 亮/灭（原先是自己画的 .rp-fab 圆钮，现在收进 #fabDock） */
function syncDock() {
  const b = document.getElementById('fabReply');
  if (b) {
    b.classList.toggle('is-on', !!S.float.replypath);
    b.setAttribute('aria-pressed', S.float.replypath ? 'true' : 'false');
  }
}
function renderView() {
  /* 人物页（她 11-14 原话「点击头像进此人单独此选项的页面」）：真页，不是弹层 */
  if (S.tab === 'person' && PG.person) {
    view.classList.remove('is-sticker');
    view.innerHTML = htmlPersonPage();
    return;
  }
  if (S.tab === 'stickers') { renderStickers(); return; }
  /* 搬屎页（2026-11-25）：只读展示，数据走 xuh:poop；刷新按钮在 PoopPanel 里自己绑 */
  if (S.tab === 'poop') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.poop && S.poop.loaded
      ? PoopPanel.html(S)
      : '<div class="loading">读出搬屎状态中…</div>';
    if (!S.poop || !S.poop.loaded) PoopPanel.load();
    else PoopPanel.bind(view);
    return;
  }
  if (S.tab === 'bot') {
    renderBotPage(view);
    return;
  }
  // 文件页不依赖 snapshot：只读归属表，机器人没起来也能看
  // 学习页也不依赖 snapshot：读 src/data/learn，机器人没起来也能看
  if (S.tab === 'learn') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.learn.loaded ? htmlLearn() : '<div class="loading">读出学习记录中…</div>';
    if (S.learn.loaded) bindLearn();
    return;
  }
  if (S.tab === 'files') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.files.loaded ? htmlFiles() : '<div class="loading">读功能对照表中…</div>';
    return;
  }
  if (S.tab === 'logs') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.logs.loaded ? htmlLogs() : '<div class="loading">读出写入日志中…</div>';
    return;
  }
  // 提醒不依赖 snapshot：机器人没起来也能看能改（配置是 config/features.json，接口自己读）
  if (S.tab === 'health') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.health.loaded ? htmlHealth() : '<div class="loading">读出提醒配置中…</div>';
    return;
  }
  // 信息识别（2026-11-21）：左栏新分组，四页共用一套树状 UI
  if (S.tab === 'info') {
    view.classList.remove('is-sticker');
    const tabs = `<div class="meme-tabbar" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">`
      + INFO_TABS.map(([v, n]) => `<button class="meme-tab ${S.info.vtab === v ? 'is-on' : ''}" data-act="info-vtab" data-v="${v}">${n}</button>`).join('') + `</div>`;
    const pg = S.info.pages[S.info.vtab];
    const body = (pg && pg.loaded) ? htmlInfoPage(S.info.vtab) : '<div class="loading">读出中…</div>';
    view.innerHTML = tabs + body;
    view.querySelectorAll('[data-act="info-vtab"]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.v; if (S.info.vtab === v) return;
      S.info.vtab = v;
      if (!S.info.pages[v]) loadInfoPage(v).then(render);
      else render();
    }));
    return;
  }

  // 逻辑（2026-11-21 07:09 主人令）：从「信息识别」里挪出来，单占左栏；页内「逻辑 / 案例」切换
  if (S.tab === 'logic') {
    view.classList.remove('is-sticker');
    const tabs = `<div class="meme-tabbar" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">`
      + [['rules', '逻辑'], ['cases', '案例']].map(([v, n]) =>
        `<button class="meme-tab ${S.logic.vtab === v ? 'is-on' : ''}" data-act="logic-vtab" data-v="${v}">${n}</button>`).join('') + `</div>`;
    let body;
    if (S.logic.vtab === 'cases') body = S.logic.casesLoaded ? htmlLogicCases() : '<div class="loading">读出案例中…</div>';
    else {
      const pg = S.info.pages.logic;
      body = (pg && pg.loaded) ? htmlInfoPage('logic', { noStars: true, noAgg: true }) : '<div class="loading">读出中…</div>';
    }
    view.innerHTML = tabs + body;
    view.querySelectorAll('[data-act="logic-vtab"]').forEach(b => b.addEventListener('click', async () => {
      const v = b.dataset.v; if (S.logic.vtab === v) return;
      S.logic.vtab = v;
      if (v === 'cases' && !S.logic.casesLoaded) { await loadLogicCases(); }
      else if (v === 'rules' && !(S.info.pages.logic && S.info.pages.logic.loaded)) { await loadLogicRules(); }
      render();
    }));
    return;
  }
  // 记录的：机器人没起来也能看（直接读 src/data/teach/*.jsonl），不依赖 snapshot
  if (S.tab === 'teach') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.teach.loaded ? htmlTeach() : '<div class="loading">读出教学列表…</div>';
    return;
  }
  // 朋友录（好感度 + 约定合并）：同样只读文件，不依赖 snapshot / 机器人是否在线。
  if (S.tab === 'friends' || S.tab === 'people' || S.tab === 'pacts') {
    view.classList.remove('is-sticker');
    view.innerHTML = S.friends.loaded ? htmlFriends() : '<div class="loading">读出朋友录…</div>';
    return;
  }
  // QQ空间（2026-11-17）：评论记录 + 判合规（合规进星标、不合规进标错）
  if (S.tab === 'qzone') {
    view.classList.remove('is-sticker');
    renderQzonePage(view);
    return;
  }
  if (!S.snap) { view.innerHTML = '<div class="loading">读出数据中…</div>'; return; }
  view.classList.remove('is-sticker');
  switch (S.tab) {
    case 'chat': {
      /* 左栏会话列表的滚动位置要留住（2026-11-19）：点一个靠底的会话（或 B站私信会话）后
       * 整块 innerHTML 重画，aside 会弹回顶部，看着像「列表被重置了」。重画前后接一下。 */
      const oldConvs = view.querySelector('.chat-convs');
      const keepTop = oldConvs ? oldConvs.scrollTop : 0;
      view.innerHTML = htmlChat();
      const newConvs = view.querySelector('.chat-convs');
      if (newConvs && keepTop) newConvs.scrollTop = keepTop;
      /* B站那一页：B站主页/评论/私信整块由 bili-page.js 画进这个容器（2026-11-19 搬进聊天页） */
      if (S.chat.tab === 'bili') {
        const host = view.querySelector('#chatBiliHost');
        if (host) renderBiliPage(host);
      }
      stickChatBottom(); pollLiveThink(); loadPromptSlots(); loadConvState(); chatSplitInit(); break;
    }
    // 参数页（2026-11-13 起）：不再占主视图，改成悬浮状态栏 + 浮层抽屉（见参数浮层模块）。
    // B站页（2026-11-17 主人令，2026-11-19 搬进聊天记录页的「B站」分段）：主页时间线（动态+视频混排）
    // ＋ 评论楼中楼 ＋ 私信，页面在 bili-page.js；底下三段（召唤/收图/弹幕）还是本文件的 htmlBili()。
    case 'bili': S.chat.tab = 'bili'; S.tab = 'chat'; view.innerHTML = htmlChat(); {
      const host = view.querySelector('#chatBiliHost');
      if (host) renderBiliPage(host);
      stickChatBottom(); break;
    }
    case 'meme': view.innerHTML = htmlMeme(); bindMeme(); break;
    case 'persona': view.classList.remove('is-sticker'); renderPersonaPage(view); break;
    case 'reqs': view.classList.remove('is-sticker'); renderReqsPage(view); break;
  }
}

/* 聊天区自己滚：QQ 里最新一句在最底下，重画完贴回底部。
 * 用户手动往上翻时不再强行拉回（离底 >120px 就算在翻旧账），滚回底部又自动跟随。 */
async function loadLogs() {
  const r = await window.xuh.api('GET', '/api/logs?limit=400');
  if (!r || r.error) { toast('写入日志读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.logs = { loaded: true, list: r.list || [], total: r.total || 0 };
  if (S.tab === 'logs') render();
}

async function logsClear() {
  if (!window.confirm('确定清空写入日志？这会删除 data/bot-writes.jsonl（不可恢复）。')) return;
  const r = await window.xuh.api('POST', '/api/logs/clear');
  if (!r || r.error) { toast('没清空：' + ((r && r.error) || '未知原因'), true); return; }
  S.logs = { loaded: true, list: [], total: 0 };
  render();
  toast('写入日志已清空');
}

function htmlLogs() {
  const L = S.logs.list || [];
  const rows = L.length ? L.slice().reverse().map(x => {
    const t = x.t ? new Date(x.t).toLocaleString('zh-CN') : '';
    const file = x.file ? esc(String(x.file)) : '';
    const action = x.action ? esc(String(x.action)) : '';
    const text = x.text ? esc(String(x.text)) : '';
    return '<div class="log-row"><span class="log-t">' + t + '</span>'
      + (file ? ' <span class="log-file">' + file + '</span>' : '')
      + (action ? ' <span class="log-act">' + action + '</span>' : '')
      + '<div class="log-text">' + text + '</div></div>';
  }).join('') : '<div class="empty">还没有写入记录。</div>';
  return '<div class="logs-page">'
    + '<div class="logs-bar"><span class="logs-n">共 ' + (S.logs.total || 0) + ' 条（显示最近 ' + L.length + '）</span>'
    + '<button class="btn btn-quiet" data-act="logs-refresh">↻ 刷新</button>'
    + '<button class="btn btn-quiet" data-act="logs-clear">清空日志</button></div>'
    + '<div class="logs-list">' + rows + '</div></div>';
}

/* 聊天区滚动位置（主人 2026-11-11 定）：
 *   ① 第一次进这个会话 → 最底（QQ 的逻辑，最新的在最下面）
 *   ② 滚上去看旧消息 → 换页再回来 / 切到别的会话再切回 → 回到原位置，不许弹回顶部
 *   ③ 其它「重置」动作（切筛选、搜索、刷新）→ 永远最底，并从第 1 页重新开始
 *   ④ 往上翻到最顶 → 再渲染 200 条更早的，且原来最上面那条钉在原处不跳
 * 每个会话各记一份位置，最多留 10 个（第 11 个进来就丢最早那个）。
 * 以前只有一个 stick 布尔：滚上去 = false，重画时就不滚 → 新 DOM 自然停在顶部，看着像被拉回去了。 */
const CHAT_POS_MAX = 10;

// 这个会话已经渲染了几页（1 页 = 200 条；翻到顶 +1 页）
// LRU：最近用过的排最后，超过 10 个会话就丢最早的（位置一起丢）
function chatTouch(cv) {
  const C = S.chat, ks = C.posKeys;
  const i = ks.indexOf(cv);
  if (i >= 0) ks.splice(i, 1);
  ks.push(cv);
  while (ks.length > CHAT_POS_MAX) delete C.pos[ks.shift()];
}

function chatPosSave(cv, box) {
  if (!cv || !box) return;
  const C = S.chat;
  const r = C.pos[cv] || (C.pos[cv] = { pages: 1 });   // 保住 pages，别被一次滚动记丢了
  r.top = box.scrollTop;
  r.bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  chatTouch(cv);
}

/* 重置动作：画完贴底 + 窗口回到最新一屏（主人 2026-11-14 定：窗口化后不再有「页」） */
function chatResetView() {
  S.chat.pinBottom = true;
  delete S.chat.win[S.chat.conv];
  delete S.chat.winTotal[S.chat.conv];
}

/* 窗口化加载（主人 2026-11-14 定）：往上翻到顶 → 窗口上移一页（多取更早、裁掉最底下溢出的）；
 * 往下翻到底 → 窗口下移一页（多取更新的、裁掉最顶上溢出的）。DOM 节点数恒定，不卡。
 * 向上用锚点钉住原来最上面那条；向下贴回最新一屏（QQ 行为）。 */
function chatMore(dir) {
  const C = S.chat;
  if (Date.now() - (C.moreBusy || 0) < 300) return;          // 节流：一次滚动别触发好几次
  const box = view.querySelector('.msgs');
  if (!box) return;
  const cv = C.conv;
  const total = C.winTotal[cv] || (C.list || []).length;
  const w = C.win[cv];
  if (!w) return;
  const WINDOW = Math.max(20, C.limitNow || 200);
  const PAGE = Math.min(WINDOW, 120);
  if (dir === 'up') {
    if (w.start <= 0) {                                       // 已加载到当前这批的顶 → 再往前读一批分片
      if (C.hasMore && !C.olderBusy) loadOlderChat();
      return;
    }
    const first = box.querySelector('.msg');
    C.anchor = first ? { id: first.id, gap: first.getBoundingClientRect().top - box.getBoundingClientRect().top } : null;
    const ns = Math.max(0, w.start - PAGE);
    w.end = Math.min(total, ns + WINDOW);
    w.start = ns;
  } else {
    if (w.end >= total) return;                               // 已经到最新了
    const ne = Math.min(total, w.end + PAGE);
    w.start = Math.max(0, ne - WINDOW);
    w.end = ne;
    C.pinBottom = true;                                       // 往下到顶 = 回到最新一屏
  }
  C.moreBusy = Date.now();
  render();
}

/* 往上翻到顶 → 从后端再读更早一批分片并并进列表（2026-11-21 主人令：面板只显示整合记录、
 * 不手动分区，往上翻自动读）。分片按「满75行+静默14min」分段（11-21 02:40 改），同会话跨段
 * 要么攒过75行、要么静默≥14min，merge 窗口才 2 分钟，所以跨批边界不会出现「本该合并却被拆开」
 * 的连续消息——按时间重排 + 按 key 去重即可。钉住原来最上面那条，加载后视觉不跳。 */
async function loadOlderChat() {
  const C = S.chat;
  if (C.olderBusy || !C.hasMore) return;
  C.olderBusy = true;
  try {
    const box = view.querySelector('.msgs');
    const first = box && box.querySelector('.msg');
    // anchor 必须在 render 之前设好：render 末尾 stickChatBottom 会消费它，把原第一条钉在原处
    if (first) C.anchor = { id: first.id, gap: first.getBoundingClientRect().top - box.getBoundingClientRect().top };
    const r = await window.xuh.api('GET', '/api/chat?skip=' + C.olderSkip + '&recent=12');
    if (!r || r.error || !Array.isArray(r.list) || !r.list.length) {
      C.hasMore = false;   // 读不到就别再反复请求
      return;
    }
    const before = (C.list || []).length;
    // 按 key 去重合并：跨批边界同会话必隔 ≥4h（分段规则），不会拆开该合并的连续消息，按 t 重排即可
    const seen = new Set();
    const merged = [];
    for (const x of r.list.concat(C.list || [])) {
      if (!x) continue;
      const k = x.key || (String(x.t || '') + '|' + String(x.nick || '') + '|' + String(x.text || '').slice(0, 40));
      if (seen.has(k)) continue;
      seen.add(k); merged.push(x);
    }
    merged.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    const added = merged.length - before;
    C.list = merged;
    C.olderSkip = Number(r.nextSkip || C.olderSkip);
    C.hasMore = !!r.hasMore;
    // 窗口往上扩一页：能看到新加载的更早消息，同时原第一条（索引 added）仍在窗口内被 anchor 钉住，视觉不跳
    const win = C.win[C.conv];
    if (win && added > 0) {
      const WINDOW = Math.max(20, C.limitNow || 200);
      const PAGE = Math.min(WINDOW, 120);
      win.start = Math.max(0, added - PAGE);
      win.end = Math.min(merged.length, win.start + WINDOW);
    }
    // 主文件签名没变，chatNewSig 不动（跟新轮询靠 /api/chat/sig，不受插入更早消息影响）
    buildPactLinks();
    if (S.tab === 'chat') render();
  } catch (e) { /* 读更早失败就安静退回，不打断浏览 */ }
  finally { C.olderBusy = false; }
}

/* ---------- 花费（2026-11-11 主人令）----------
 * 口径全在服务端（panel.js：折合 DeepSeek V4.1-Flash 谷时：输入 1 元/百万、输出 4 元/百万），
 * 这边只负责显示，不自己乘一次，避免两处算法不一致。
 * 小于一分钱时显示到「0.0001」这一档，不然一顿聊下来全是 ¥0.00，看着像没算。 */
function fmtRmb(y) {
  const v = Number(y) || 0;
  if (!v) return '¥0';
  if (v < 0.01) return '¥' + v.toFixed(4);
  if (v < 1) return '¥' + v.toFixed(3);
  return '¥' + v.toFixed(2);
}
// 当前会话在机器人那边的键（qq_群号 / qq_号），取这个会话最后一条消息的 scopeKey
function chatScopeKeyOf(cv) {
  const arr = (S.chat.list || []).filter(m => chatConvOf(m) === cv);
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].scopeKey) return arr[i].scopeKey;
  return '';
}

/* ---------- 实时思考（2026-11-11 主人令）----------
 * 开关管的是「要不要花 token 想」，不是「想完藏起来」：关掉时 core.js 根本不发 thinking，
 * 一个思考 token 都不花（见 core.js liveThinkOn）。
 * 打开后每 4 秒问一次这个会话最近一条思考，直接改 DOM、不重画整个列表（否则滚动位置会跳）。
 * 生成完的那条会同时写进那一句的「推理」里（trace.reason），所以这里只显示最近 30 分钟的。 */
let liveThinkTimer = null, liveThinkBusy = false;
function liveThinkOn() { return Number(((S.chat.cfg || {}).liveThink) || 0) === 1; }
function stopLivePoll() { if (liveThinkTimer) { clearTimeout(liveThinkTimer); liveThinkTimer = null; } }

async function pollLiveThink() {
  stopLivePoll();
  if (S.tab !== 'chat') return;
  if (liveThinkOn()) {
    const k = chatScopeKeyOf(S.chat.conv);
    if (k && !liveThinkBusy) {
      liveThinkBusy = true;
      try {
        const r = await window.xuh.api('GET', '/api/chat/live?k=' + encodeURIComponent(k));
        if (r && !r.error) S.chat.live = { item: r.item || null };
      } catch {}
      liveThinkBusy = false;
    }
    liveThinkTimer = setTimeout(pollLiveThink, 4000);
  }
  paintLiveThink();
}

// 只换这一块的内容，不动聊天列表
function paintLiveThink() {
  const box = view.querySelector('.chat-think-box');
  if (!box) return;
  box.innerHTML = liveThinkBody();
}

function liveThinkBody() {
  if (!liveThinkOn()) {
    return '<div class="think-off">关着：虚幻这一轮不会想，也不花一个思考 token。点右上角打开才想。</div>';
  }
  const it = (S.chat.live || {}).item;
  if (!it) return '<div class="think-off">开着：等这个会话下一句话，想完就显示在这里。</div>';
  if (it.note && !it.reason) return '<div class="think-off">' + esc(it.note) + '</div>';
  const t = it.t ? fmtTime(it.t) : '';
  return '<div class="think-meta">' + esc(it.model || '') + (t ? ' · ' + esc(t) : '')
    + '<span class="dim"> · 生成完就归到那一条的「推理」里</span></div>'
    + '<div class="think-text">' + esc(it.reason || '（这条没有正文）') + '</div>';
}

/* 右下角浮层（2026-11-14 主人定）：把思考 / 话题 / 约定 / 提示词 / 状态 收进一个常驻浮层，
 * 消息流顶部从此永远不塞任何东西（约定也从顶部搬进来了）。
 * 折叠只切 class，不重渲染消息列表；标签切换也是纯前端 class 切换，避免把滚动位置弹回底部。 */
function curConvMeta() {
  const cv = S.chat.conv;
  if (!cv || cv === '__all' || cv === '__group' || cv === '__private' || cv === '__orphan') return { uid: '', kind: '' };
  const m = (S.chat.list || []).find(x => chatConvOf(x) === cv);
  return { uid: m && m.uid ? m.uid : '', kind: m && m.convKind ? m.convKind : '' };
}
/* 思考标签页：复用 liveThinkBody / paintLiveThink（它们只认 .chat-think-box）。
 * 用 .dock-think 包裹（非 fixed），否则会嵌一层 fixed 浮层。 */
function dockThink() {
  return `<div class="dock-think">
    <div class="chat-think-head">
      <b>实时思考</b>
      <span class="small dim">这个会话</span>
      <button class="toggle" data-act="chat-livethink" aria-pressed="${liveThinkOn()}"
              title="${liveThinkOn() ? '关掉：下一句起不再让模型思考，省 token' : '打开：每句都让模型思考（真花 token）'}"></button>
      <span class="small dim">${liveThinkOn() ? '开着 = 每句都想（花 token）' : '关着 = 不想（不花 token）'}</span>
    </div>
    <div class="chat-think-box">${liveThinkBody()}</div>
  </div>`;
}
/* 「状态」标签页（2026-11-14 主人定，和「约定」同一套按人逻辑）：
 * 上面一段是**全局**（本体外貌：发型 / 眼睛 / 体型…，是「她自己」，每个会话、两种模型都注入）；
 * 下面一段是**这个人 / 这个群**名下的（多账号、跨平台算同一个人，不按账号分）。
 * 每轮只注入最近 N 条的 N 在这里改（改完即存）。 */
function dockState() {
  const cv = S.chat.conv;
  const specific = cv && cv !== '__all' && cv !== '__group' && cv !== '__private' && cv !== '__orphan';
  const st = S.chat.convState || { globals: [], mine: [], show: 4, who: '', whoLabel: '' };
  const globals = st.globals || [];
  const mine = st.mine || [];
  const gRows = globals.length ? globals.map(stateCard).join('')
    : '<div class="dock-empty">还没有全局状态。点下面加一条（发型、眼睛、体型这种「她自己」的都放全局）。</div>';
  const mRows = mine.length ? mine.map(stateCard).join('')
    : `<div class="dock-empty">${specific ? '「' + esc(st.whoLabel || '这个人') + '」这里还没有单独的状态。' : '选一个具体会话（群 / 私聊），才能记这个人的状态。'}</div>`;
  return `<div class="state-head">
      <span class="small dim">全局 ${num(globals.length)} 条 · 这里 ${num(mine.length)} 条</span>
      <span class="state-show">这里每轮注入最近 <input class="field" id="state-show-n" type="number" min="1" max="999" value="${Math.max(1, Number(st.show) || 4)}" style="width:56px"> 条
        <button class="btn btn-quiet" data-act="chat-state-show" title="改完点这里生效">应用</button></span>
    </div>
    <div class="state-sub">全局 · 本体外貌（每个会话都带<b>全部</b>这几条，不分本地 / 云端，不会被下面的条数挤掉）</div>
    <div class="state-list">${gRows}</div>
    <button class="btn btn-quiet state-add" data-act="chat-state-add" data-who="global" style="margin-top:6px">＋ 加一条全局</button>
    <div class="state-sub" style="margin-top:12px">${specific ? esc(st.whoLabel || '这个会话') : '具体会话'} · 按人记（多账号、跨平台算同一个人）</div>
    <div class="state-list">${mRows}</div>
    ${specific ? `<button class="btn btn-quiet state-add" data-act="chat-state-add" data-who="here" style="margin-top:6px">＋ 加一条状态</button>` : ''}`;
}
function stateCard(s) {
  const isGlobal = !s.who;
  const local = s.kind === 'local';
  const badge = s.persona
    ? '<span class="state-kind kind-normal" title="人设层：会取代人设正文，优先级高于约定（约定是长文本兜底）">人设</span>'
    : (isGlobal
      ? '<span class="state-kind kind-normal">通用</span>'
      : `<span class="state-kind ${local ? 'kind-local' : 'kind-normal'}">${local ? '本地模型' : '普通'}</span>`);
  return `<div class="state-card${local && !isGlobal ? ' is-local' : ''}">
    <div class="state-row">
      ${badge}
      ${s.topic ? `<span class="state-topic">${esc(s.topic)}</span>` : ''}
      <span class="state-time">${esc(fmtTime(s.t))}</span>
    </div>
    <div class="state-text">${esc(s.text || '')}</div>
    <div class="state-acts">
      <button class="chip" data-act="chat-state-edit" data-id="${esc(s.id)}">改</button>
      <button class="chip is-danger" data-act="chat-state-del" data-id="${esc(s.id)}">删</button>
    </div>
  </div>`;
}
/* 加 / 改 状态的弹层（自绘，不弹原生 prompt）。
 * e.who：'' = 全局；'p:<pid>' / 'g:<群号>' = 这个人 / 这个群。 */
function htmlStateModal() {
  const e = S.chat.stateEdit;
  if (!e) return '';
  const local = e.kind === 'local';
  const isGlobal = !e.who;
  return `<div class="modal-veil"><div class="modal-card" style="width:min(460px,92vw)">
    <h3>${e.id ? '改这条状态' : (isGlobal ? '加一条全局状态' : '加一条当前状态')}</h3>
    <div class="small dim" style="margin:-4px 0 10px">${isGlobal ? '全局：本体外貌这种，每个会话、两种模型都注入' : '只记在 ' + esc(e.whoLabel || '这个人') + ' 名下（多账号、跨平台算同一个人）'}</div>
    <label class="modal-label">类型</label>
    <div style="display:flex;gap:6px">
      <button class="chip${!local ? ' is-on' : ''}" data-act="state-kind" data-k="normal">普通 / 云端</button>
      <button class="chip${local ? ' is-on' : ''}" data-act="state-kind" data-k="local">本地模型</button>
    </div>
    ${isGlobal ? '' : '<div class="small dim" style="margin-top:6px">本地模型只看「本地模型」这条，普通只看「普通」这条，两边不串。</div>'}
    <label class="modal-label" style="margin-top:12px">主题（可不填；填了同一主题会自动覆盖旧的那条）</label>
    <input id="state-topic" class="field" style="width:100%" value="${esc(e.topic || '')}" placeholder="比如 心情 / 正在做的事 / 发型">
    <div class="small dim" style="margin-top:4px">主题写「名字」= 只改她自己的名字（人设层，压过身份铁律）；主人名字不变</div>
    <label class="modal-label" style="margin-top:10px">状态内容</label>
    <textarea id="state-text" class="field" rows="3" style="width:100%">${esc(e.text || '')}</textarea>
    <div class="modal-btns" style="margin-top:14px">
      <button class="btn" data-act="state-save">${e.id ? '保存' : '加上'}</button>
      <button class="btn btn-quiet" data-act="state-cancel">取消</button>
    </div>
  </div></div>`;
}
function htmlChatDock() {
  /* 2026-11-16 她原话：「悬浮窗只留当前提示词、ai思考、ai状态，这类只要汇总显示就无意义的。
   * 所以现在悬浮的情绪表这些别放这」。话题 / 约定 / 情绪表都是汇总性质，挪去左栏入口
   * （点开取代人物列表，收成小图标碰到才显示全），这里只留三条「当前这一刻」的内容。 */
  const ONLY = ['prompt', 'think', 'state'];
  const tab = ONLY.indexOf(S.chat.dockTab) >= 0 ? S.chat.dockTab : 'prompt';
  const fold = !!S.chat.liveFold;
  const T = [['prompt', '当前提示词'], ['think', 'AI 思考'], ['state', 'AI 状态']];
  const tabs = T.map(([k, l]) =>
    `<button class="dock-tab${tab === k ? ' is-on' : ''}" data-act="dock-tab" data-dock="${k}">${l}</button>`).join('');
  return `<div class="chat-dock is-slim${fold ? ' is-fold' : ''}" data-tab="${tab}">
    <div class="dock-bar">
      <div class="dock-tabs">${tabs}</div>
      <button class="dock-fold" data-act="chat-live-fold" title="${fold ? '展开' : '收起'}">${fold ? '▲' : '▼'}</button>
    </div>
    <div class="dock-body">
      <div class="dock-panel" data-tab="prompt">${htmlPromptSlots()}</div>
      <div class="dock-panel" data-tab="think">${dockThink()}</div>
      <div class="dock-panel" data-tab="state">${dockState()}</div>
    </div>
  </div>`;
}
/* 只重画浮层，不碰消息列表（避免滚动位置被弹回底部）。 */
function paintDock() {
  const d = view.querySelector('.chat-dock');
  if (!d) return;
  d.outerHTML = htmlChatDock();
  floatWinApplyAll();          // 新节点，把拖到的位置摆回去
}
/* 拉「状态」：全局一段 + 这个会话/这个人一段（后端按人合并账号，不按账号分）。 */
async function loadConvState() {
  const meta = curConvMeta();
  try {
    const r = await window.xuh.api('POST', '/api/conv/state', { conv: S.chat.conv, uid: meta.uid });
    if (r && r.ok) S.chat.convState = { globals: r.globals || [], mine: r.mine || [], show: r.show || 4, who: r.who || '', whoLabel: r.whoLabel || '' };
    else S.chat.convState = { globals: [], mine: [], show: 4, who: '', whoLabel: '' };
  } catch { S.chat.convState = { globals: [], mine: [], show: 4, who: '', whoLabel: '' }; }
  if (S.tab === 'chat') paintDock();
}

function stickChatBottom() {
  const box = view.querySelector('.msgs');
  if (!box) return;
  const C = S.chat;
  const cv = C.conv;
  /* B站私信视图（2026-11-19）：进来就贴底看最新一句；它没有 QQ 那套「翻到顶加载更早一页」，
   * 所以不绑翻页（绑了会去动 S.chat 的分页状态，页面会乱）。 */
  if (/^bdm_/.test(String(cv))) {
    box.onscroll = () => chatPosSave(cv, box);
    box.scrollTop = box.scrollHeight;
    chatPosSave(cv, box);
    return;
  }
  const bind = () => {
    box.onscroll = () => {
      chatPosSave(C.conv, box);
      if (box.scrollTop <= 2) chatMore('up');                                                  // 翻到最顶 → 加载更早的一页
      else if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) chatMore('down');     // 翻到底 → 加载更新的一页
    };
  };

  const anchor = C.anchor;                         // 刚加了一页：钉住原来最上面那条
  C.anchor = null;
  if (anchor) {
    let target = null;
    const msgs = box.querySelectorAll('.msg');
    for (let i = 0; i < msgs.length; i++) if (msgs[i].id === anchor.id) { target = msgs[i]; break; }
    if (target) {
      box.scrollTop = 0;                           // 新 DOM 本来就是从 0 开始，按内容坐标反推
      box.scrollTop = Math.max(0,
        (target.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchor.gap);
      chatPosSave(cv, box);
      bind();
      return;
    }
  }

  const rec = C.pos[cv];
  // 重置动作 / 没记过这个会话 / 上次就停在底部 → 贴底；否则回原位
  if (C.pinBottom || !rec || rec.bottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = rec.top;
  C.pinBottom = false;
  chatPosSave(cv, box);                            // 记下这次的位置（含「在不在底部」）
  bind();
}

/* ---------------- 查梗 · 娱乐网站 ----------------
 * 内联查（站点 API 命中才出结果）是加分项，查不到就退回到下面的目录，
 * 点开网站照样能查——所以「能连上并查到」这一条，靠目录就能兜底。 */
async function loadMeme() {
  const r = await window.xuh.memeSites();
  S.meme.sites = (r && Array.isArray(r)) ? r : [];
  S.meme.loaded = true;
  if (S.tab === 'meme') render();
}

function memeRelLabel(rel) {
  return ({ alive: '已验证', doubtful: '接口失效', dead: '已停用' })[rel] || rel || '未知';
}

/* 站点目录：按可靠度排序（能用 → 站点在但查不到 → 已停用）。
 * 排序只影响显示，编辑/删一律用「原数组下标」data-idx，不会点错站。 */
function memeDirHtml(sites, term) {
  if (!sites || !sites.length) return '<div class="meme-empty">站点目录没加载出来（机器人可能没启动）。</div>';
  const order = { alive: 0, doubtful: 1, dead: 2 };
  const relClass = { alive: 'is-alive', doubtful: 'is-doubtful', dead: 'is-dead' };
  const sorted = sites.map((s, i) => ({ s, i })).sort((a, b) =>
    ((order[a.s.reliability] ?? 3) - (order[b.s.reliability] ?? 3))
    || (a.s.name || '').localeCompare(b.s.name || '', 'zh'));
  return sorted.map(({ s, i }) => {
    const rel = s.reliability || 'doubtful';
    const hasSearch = !!s.search;
    const goUrl = (hasSearch && term) ? s.search.replace('{q}', encodeURIComponent(term)) : (s.url || '');
    const goLabel = (hasSearch && term) ? '搜一下' : '去网站';
    const showHome = s.url && s.url !== goUrl;
    const name = esc(s.name || s.domain || '未命名站点');
    const note = esc(s.note || '');
    return `
      <div class="meme-site">
        <div class="meme-site-main">
          <div class="meme-site-name">${name}<span class="meme-badge ${relClass[rel]}">${memeRelLabel(rel)}</span></div>
          ${note ? `<div class="meme-site-note">${note}</div>` : ''}
        </div>
        <div class="meme-site-acts">
          ${goUrl ? `<button class="meme-btn meme-btn-go" data-act="meme-site" data-url="${esc(goUrl)}">${goLabel}</button>` : ''}
          ${showHome ? `<button class="meme-btn" data-act="meme-site" data-url="${esc(s.url)}">官网</button>` : ''}
          <button class="meme-btn" data-act="meme-edit" data-idx="${i}">编辑</button>
          <button class="meme-btn" data-act="meme-del" data-idx="${i}">删</button>
        </div>
      </div>`;
  }).join('');
}

/* 新增 / 编辑站点的自绘表单（不用系统弹窗）。每个输入框下面一句说明：这是填什么的。 */
function memeEditHtml() {
  const ed = S.meme.edit;
  if (!ed) return '';
  const s = ed.site || {};
  const isNew = ed.idx < 0;
  const rel = s.reliability || 'alive';
  const relOpts = [
    ['alive', '能用'], ['doubtful', '站点在但查不到'], ['dead', '已停用'],
  ].map(([v, label]) => `<option value="${v}" ${v === rel ? 'selected' : ''}>${label}</option>`).join('');
  return `
    <div class="sheet meme-edit">
      <div class="sheet-head"><h2>${isNew ? '加一个梗站' : '编辑：' + esc(s.name || '')}</h2>
        <span class="hint">保存后自动同步到 search 面板，不用改文件、也不用双击同步脚本</span></div>
      <div class="sheet-body">
        <div class="me-grid">
          <label class="me-f"><span>站名</span>
            <input class="field" id="me-name" value="${esc(s.name || '')}" placeholder="例：梗百科">
            <em>目录里显示的名字</em></label>
          <label class="me-f"><span>网址</span>
            <input class="field" id="me-url" value="${esc(s.url || '')}" placeholder="https://…">
            <em>点「官网」时打开的页面，要带 https://</em></label>
          <label class="me-f"><span>搜索网址（可空）</span>
            <input class="field" id="me-search" value="${esc(s.search || '')}" placeholder="https://…/search?q={q}">
            <em>点「搜一下」用的地址；{q} 会自动换成你查的词。留空就只留「官网」</em></label>
          <label class="me-f"><span>查询接口（可空）</span>
            <input class="field" id="me-api" value="${esc(s.api || '')}" placeholder="https://…/api.php?…&amp;titles={q}">
            <em>能直接返回词条解释的官方地址；留空则不参与内联查，只靠点开网站查</em></label>
          <label class="me-f"><span>状态</span>
            <select class="field" id="me-rel">${relOpts}</select>
            <em>按实跑结果选；拿不准就选「站点在但查不到」</em></label>
          <label class="me-f"><span>备注（可空）</span>
            <input class="field" id="me-note" value="${esc(s.note || '')}" placeholder="例：偏 ACG 词条">
            <em>给自己看的说明，显示在站名下面</em></label>
        </div>
        <div class="me-acts">
          <button class="btn btn-primary" data-act="meme-save">保存</button>
          <button class="btn btn-quiet" data-act="meme-cancel">取消</button>
        </div>
      </div>
    </div>`;
}

function htmlMeme() {
  const term = S.meme.term || '';
  const tabBar = `
    <div class="meme-tabs">
      <button class="meme-tab ${S.meme.vtab === 'meme' ? 'is-on' : ''}" data-act="meme-vtab" data-v="meme">查梗</button>
      <button class="meme-tab ${S.meme.vtab === 'vocab' ? 'is-on' : ''}" data-act="meme-vtab" data-v="vocab">本地词库</button>
      <button class="meme-tab ${S.meme.vtab === 'user' ? 'is-on' : ''}" data-act="meme-vtab" data-v="user">我的词</button>
    </div>`;
  if (S.meme.vtab === 'vocab') {
    return `<div class="meme-wrap">${tabBar}${htmlVocab()}</div>`;
  }
  if (S.meme.vtab === 'user') {
    return `<div class="meme-wrap">${tabBar}${htmlUser()}</div>`;
  }
  return `
    <div class="meme-wrap">
      ${tabBar}
      <div class="meme-search">
        <input class="field meme-input" id="meme-input" placeholder="输入梗名，或粘一句带梗的话"
               value="${esc(term)}" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-act="meme-go">查</button>
      </div>
      <div class="meme-result" id="meme-result"></div>
      ${memeEditHtml()}
      <div class="meme-dir-head">
        <span>娱乐 / 梗站目录（点开即查，按可靠度分级）</span>
        <button class="btn btn-quiet meme-add-btn" data-act="meme-add">+ 加站点</button>
      </div>
      <div class="meme-dir" id="meme-dir">${memeDirHtml(S.meme.sites, term)}</div>
    </div>`;
}

function bindMeme() {
  // 子标签切换：查梗 / 本地词库·受限词（后者首次进入时惰性加载词库）
  view.querySelectorAll('[data-act="meme-vtab"]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.v;
    if (S.meme.vtab === v) return;
    S.meme.vtab = v;
    if (v === 'vocab') { if (!S.vocab.loaded) loadVocab(); else render(); }
    else if (v === 'user') { if (!S.user.loaded) loadUser(); else render(); }
    else render();
  }));
  if (S.meme.vtab === 'vocab') { bindVocab(); return; }
  if (S.meme.vtab === 'user') { bindUser(); return; }

  const input = document.getElementById('meme-input');
  if (input) {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') memeGo(); });
    input.addEventListener('input', () => {
      S.meme.term = input.value.trim();
      const dir = document.getElementById('meme-dir');
      if (dir) dir.innerHTML = memeDirHtml(S.meme.sites, S.meme.term);
    });
  }
  // 编辑表单：边打边存回 state，切页再回来不会丢掉没保存的内容
  const form = document.querySelector('.meme-edit');
  if (form) form.addEventListener('input', e => {
    const map = {
      'me-name': 'name', 'me-url': 'url', 'me-search': 'search',
      'me-api': 'api', 'me-rel': 'reliability', 'me-note': 'note',
    };
    const key = map[e.target.id];
    if (key && S.meme.edit) S.meme.edit.site[key] = e.target.value;
  });
}

async function memeGo() {
  const input = document.getElementById('meme-input');
  const term = (input ? input.value : '').trim();
  const box = document.getElementById('meme-result');
  if (!term) { if (box) box.innerHTML = '<div class="meme-empty">先输入梗名，或粘一句带梗的话。</div>'; return; }
  S.meme.term = term;
  const dir = document.getElementById('meme-dir');
  if (dir) dir.innerHTML = memeDirHtml(S.meme.sites, term);
  if (box) box.innerHTML = '<div class="meme-empty">正在查…</div>';
  let r = null;
  try { r = await window.xuh.memeLookup(term); } catch (e) { r = { error: String(e && e.message || e) }; }
  if (!r || r.error) {
    if (box) box.innerHTML = '<div class="meme-empty">连不上查梗接口（' + esc(r && r.error || '未知') + '）。下面目录里点开网站照样能查。</div>';
    return;
  }
  if (r && r.title) {
    const link = r.url ? `<span class="meme-link" data-act="meme-site" data-url="${esc(r.url)}">查看原文 ↗</span>` : '';
    if (box) box.innerHTML =
      `<div class="meme-src">${esc(r.source || '查梗')}</div>` +
      `<div class="meme-title">${esc(r.title)}</div>` +
      (r.summary ? `<div class="meme-summary">${esc(r.summary)}</div>` : '') + link;
  } else {
    if (box) box.innerHTML = '<div class="meme-empty">站点接口暂时没查到（有的站会限流/抽风）。下面目录里点开网站照样能查。</div>';
  }
}

/* ---------------- 词汇 · 本地词库（ci.json + 受限侧车）----------------
 * 数据走主进程 xuh:dictList / xuh:dictSetRestricted（src/data/dict/）。
 * 列出来自 ci.json（~30万条），受限标记来自 restricted.json 侧车（不污染 ci.json）。
 * 单条「受限/正常」按钮：写回侧车；bot 侧 src/dict.js 读侧车做「模型侧不输出粗俗词」软约束。 */
async function loadVocab() {
  S.vocab.busy = true;
  if (S.tab === 'meme' && S.meme.vtab === 'vocab') render();
  const r = await window.xuh.dictList({ q: S.vocab.q, restrictedOnly: S.vocab.restrictedOnly, offset: S.vocab.offset, limit: S.vocab.limit });
  S.vocab.busy = false;
  if (!r || r.error) { toast('词库读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.vocab.rows = r.rows || [];
  S.vocab.total = r.total || 0;
  S.vocab.restrictedTotal = r.restrictedTotal || 0;
  S.vocab.loaded = true;
  if (S.tab === 'meme' && S.meme.vtab === 'vocab') render();
}

function htmlVocab() {
  const v = S.vocab;
  const pages = Math.max(1, Math.ceil(v.total / v.limit));
  const cur = Math.floor(v.offset / v.limit) + 1;
  const rows = v.rows.length ? v.rows.map(e => `
    <div class="vocab-row ${e.restricted ? 'is-rest' : ''}">
      <div class="vocab-main">
        <div class="vocab-ci">${esc(e.ci)} ${e.poly ? '<span class="vocab-poly">多义</span>' : ''}</div>
        <div class="vocab-expl">${escBr(e.explanation || '')}</div>
        ${e.restricted && e.reason ? `<div class="vocab-reason">标记理由：${esc(e.reason)}</div>` : ''}
      </div>
      <div class="vocab-act">
        <button class="vocab-btn ${e.restricted ? 'is-on' : ''}" data-act="vocab-toggle" data-ci="${esc(e.ci)}" data-on="${e.restricted ? 1 : 0}">${e.restricted ? '受限' : '正常'}</button>
        <button class="vocab-btn" data-act="vocab-edit" data-ci="${esc(e.ci)}" data-source="ci">编辑</button>
      </div>
    </div>`).join('') : '<div class="vocab-empty">没有匹配的词汇。</div>';
  return `
    <div class="vocab-wrap">
      <div class="vocab-bar">
        <input class="field vocab-input" id="vocab-input" placeholder="搜词或释义…" value="${esc(v.q)}" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-act="vocab-go">搜</button>
        <label class="vocab-toggle"><input type="checkbox" id="vocab-only" ${v.restrictedOnly ? 'checked' : ''}> 只看受限（${num(v.restrictedTotal)}）</label>
      </div>
      <div class="vocab-stat">共 ${num(v.total)} 条 · 第 ${cur}/${pages} 页${v.busy ? ' · 读取中…' : ''}</div>
      <div class="vocab-list" id="vocab-list">${rows}</div>
      <div class="vocab-pager">
        <button class="btn btn-quiet" data-act="vocab-prev" ${v.offset <= 0 ? 'disabled' : ''}>上一页</button>
        <span class="vocab-pagenum">${cur} / ${pages}</span>
        <button class="btn btn-quiet" data-act="vocab-next" ${(v.offset + v.limit) >= v.total ? 'disabled' : ''}>下一页</button>
      </div>
    </div>`;
}

function bindVocab() {
  const wrap = view.querySelector('.vocab-wrap');
  if (!wrap) return;
  const input = wrap.querySelector('#vocab-input');
  if (input) {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') vocabGo(); });
    let t;
    input.addEventListener('input', (e) => { if (e.isComposing) return; clearTimeout(t); t = setTimeout(() => { S.vocab.q = input.value.trim(); S.vocab.offset = 0; loadVocab(); }, 300); });
  }
  const only = wrap.querySelector('#vocab-only');
  if (only) only.addEventListener('change', () => { S.vocab.restrictedOnly = only.checked; S.vocab.offset = 0; loadVocab(); });
  wrap.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'vocab-go') vocabGo();
    else if (act === 'vocab-prev') { S.vocab.offset = Math.max(0, S.vocab.offset - S.vocab.limit); loadVocab(); }
    else if (act === 'vocab-next') { S.vocab.offset = Math.min(Math.max(0, S.vocab.total - S.vocab.limit), S.vocab.offset + S.vocab.limit); loadVocab(); }
    else if (act === 'vocab-toggle') {
      const ci = btn.dataset.ci, on = btn.dataset.on === '1';
      btn.disabled = true;
      const r = await window.xuh.dictSetRestricted({ ci, restricted: !on });
      if (!r || r.error) { btn.disabled = false; toast('标记失败：' + ((r && r.error) || '未知'), true); return; }
      loadVocab();
    } else {
      vocabRowClick(act, btn);
    }
  });
}

async function vocabGo() {
  const input = document.getElementById('vocab-input');
  S.vocab.q = (input ? input.value : '').trim();
  S.vocab.offset = 0;
  await loadVocab();
}

/* ---------------- 我的词（user-words.json，主人专属单独文件）----------------
 * 批量导入 / 单条新增 / 编辑 / 删除都落这份；bot 运行时并回主词典。
 * 这份文件按主人令「之后禁止我（助手）查看/编辑/删除」，所以只在用户操作时由 IPC 写它，我从不读它内容。 */
async function loadUser() {
  S.user.busy = true;
  if (S.tab === 'meme' && S.meme.vtab === 'user') render();
  const r = await window.xuh.dictList({ source: 'user', q: S.user.q, offset: S.user.offset, limit: S.user.limit });
  S.user.busy = false;
  if (!r || r.error) { toast('我的词读不出来：' + ((r && r.error) || '未知'), true); return; }
  S.user.rows = r.rows || [];
  S.user.total = r.total || 0;
  S.user.loaded = true;
  if (S.tab === 'meme' && S.meme.vtab === 'user') render();
}

function htmlUser() {
  const u = S.user;
  const pages = Math.max(1, Math.ceil(u.total / u.limit));
  const cur = Math.floor(u.offset / u.limit) + 1;
  const rows = u.rows.length ? u.rows.map(e => `
    <div class="vocab-row">
      <div class="vocab-main">
        <div class="vocab-ci">${esc(e.ci)} ${e.poly ? '<span class="vocab-poly">多义</span>' : ''}</div>
        <div class="vocab-expl">${escBr(e.explanation || '')}</div>
      </div>
      <div class="vocab-act">
        <button class="vocab-btn" data-act="vocab-edit" data-ci="${esc(e.ci)}" data-source="user">编辑</button>
        <button class="vocab-btn vocab-del" data-act="vocab-del" data-ci="${esc(e.ci)}">删除</button>
      </div>
    </div>`).join('') : '<div class="vocab-empty">还没有「我的词」。用下面的框批量导入，或点「+ 新增」。</div>';
  const chk = u.importResult;
  const checkHtml = chk ? `<div class="import-result ${chk.errors.length ? 'is-err' : 'is-ok'}">
      ${chk.errors.length ? ('校验未通过：' + chk.errors.length + ' 处错误，修好才能导入') : ('校验通过：可导入 ' + chk.entries.length + ' 条')}
      ${chk.errors.slice(0, 8).map(x => `<div class="import-err">第 ${x.line} 行：${esc(x.msg)}</div>`).join('')}
    </div>` : '';
  const addHtml = u.adding ? `<div class="add-box">
      <input class="field" id="add-ci" placeholder="新词（如：显眼包）" autocomplete="off" spellcheck="false">
      <textarea id="add-expl" class="import-area" placeholder="释义（可多行，自由复制粘贴）"></textarea>
      <div class="import-btns">
        <button class="btn btn-primary" data-act="user-add-save">保存新增</button>
        <button class="btn btn-quiet" data-act="user-add-cancel">取消</button>
      </div>
    </div>` : '';
  return `
    <div class="user-wrap">
      <div class="user-bar">
        <input class="field" id="user-q" placeholder="搜我的词…" value="${esc(u.q)}" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-act="user-go">搜</button>
        <button class="btn btn-quiet" data-act="user-add">+ 新增</button>
      </div>
      ${addHtml}
      <div class="import-box">
        <div class="import-head">批量导入（落进单独文件 user-words.json，主人专属）</div>
        <textarea id="user-import" class="import-area" placeholder="两种格式都行：&#10;① JSON 数组：[{&quot;ci&quot;:&quot;词&quot;,&quot;explanation&quot;:&quot;释义&quot;}]&#10;② 每行：词&lt;Tab 或 ：或 : 或 ｜ 或 丨&gt;释义">${esc(u.importText)}</textarea>
        <div class="import-btns">
          <button class="btn btn-quiet" data-act="user-check">校验格式</button>
          <button class="btn btn-primary" data-act="user-import">导入</button>
        </div>
        ${checkHtml}
      </div>
      <div class="vocab-list" id="user-list">${rows}</div>
      <div class="vocab-pager">
        <button class="btn btn-quiet" data-act="user-prev" ${u.offset <= 0 ? 'disabled' : ''}>上一页</button>
        <span class="vocab-pagenum">${cur} / ${pages}</span>
        <button class="btn btn-quiet" data-act="user-next" ${(u.offset + u.limit) >= u.total ? 'disabled' : ''}>下一页</button>
      </div>
    </div>`;
}

function bindUser() {
  const wrap = view.querySelector('.user-wrap');
  if (!wrap) return;
  const q = wrap.querySelector('#user-q');
  if (q) {
    q.addEventListener('keydown', e => { if (e.key === 'Enter') userGo(); });
    let t; q.addEventListener('input', (e) => { if (e.isComposing) return; clearTimeout(t); t = setTimeout(() => { S.user.q = q.value.trim(); S.user.offset = 0; loadUser(); }, 300); });
  }
  const imp = wrap.querySelector('#user-import');
  if (imp) imp.addEventListener('input', () => { S.user.importText = imp.value; S.user.importResult = null; });
  wrap.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'user-go') userGo();
    else if (act === 'user-prev') { S.user.offset = Math.max(0, S.user.offset - S.user.limit); loadUser(); }
    else if (act === 'user-next') { S.user.offset = Math.min(Math.max(0, S.user.total - S.user.limit), S.user.offset + S.user.limit); loadUser(); }
    else if (act === 'user-check') userImportCheck();
    else if (act === 'user-import') userImport();
    else if (act === 'user-add') { S.user.adding = !S.user.adding; render(); }
    else if (act === 'user-add-cancel') { S.user.adding = false; render(); }
    else if (act === 'user-add-save') userAddSave();
    else vocabRowClick(act, btn);
  });
}

async function userGo() {
  const input = document.getElementById('user-q');
  S.user.q = (input ? input.value : '').trim();
  S.user.offset = 0;
  await loadUser();
}
async function userImportCheck() {
  const ta = document.getElementById('user-import');
  const text = ta ? ta.value : '';
  S.user.importText = text;
  const r = await window.xuh.dictImportCheck(text);
  if (!r || r.error) { toast('校验失败：' + ((r && r.error) || '未知'), true); return; }
  S.user.importResult = { entries: r.entries || [], errors: r.errors || [] };
  render();
}
async function userImport() {
  const ta = document.getElementById('user-import');
  const text = ta ? ta.value : '';
  if (!text.trim()) { toast('先粘点内容再导入', true); return; }
  const r = await window.xuh.dictImport(text);
  if (!r || r.error) { toast('导入失败：' + ((r && r.error) || '未知'), true); return; }
  if (r.errors && r.errors.length) { toast('有 ' + r.errors.length + ' 行格式不对，没导入', true); S.user.importResult = { entries: [], errors: r.errors }; render(); return; }
  toast(`导入完成：新增 ${r.added} · 追加多义 ${r.appended} · 同义跳过 ${r.skipped} · 共 ${r.total} 条`);
  S.user.importText = ''; S.user.importResult = null;
  S.user.offset = 0; S.user.loaded = false;
  await loadUser();
}
async function userAddSave() {
  const ci = (document.getElementById('add-ci') || {}).value || '';
  const expl = (document.getElementById('add-expl') || {}).value || '';
  if (!ci.trim() || !expl.trim()) { toast('词和释义都要填', true); return; }
  const r = await window.xuh.dictSetExplanation({ ci: ci.trim(), explanation: expl, source: 'user' });
  if (!r || r.error) { toast('新增失败：' + ((r && r.error) || '未知'), true); return; }
  toast('已新增：' + ci.trim());
  S.user.adding = false; S.user.offset = 0; S.user.loaded = false;
  await loadUser();
}

/* 行内编辑：编辑/保存/取消/删除，ci 与 user 两层共用。
 * 编辑把该行的 .vocab-main 换成 textarea（自由复制粘贴、可多行）；保存写回对应文件，取消/删除后重载列表。 */
async function vocabRowClick(act, btn) {
  if (act === 'vocab-edit') {
    const ci = btn.dataset.ci, source = btn.dataset.source || 'ci';
    const rowEl = btn.closest('.vocab-row');
    const row = (source === 'user' ? S.user.rows : S.vocab.rows).find(r => r.ci === ci);
    const cur = row ? (row.explanation || '') : '';
    const main = rowEl && rowEl.querySelector('.vocab-main');
    if (!main) return;
    main.innerHTML = `<textarea class="vocab-edit-area" placeholder="输入释义，可多行，自由复制粘贴">${esc(cur)}</textarea>
      <div class="vocab-edit-btns">
        <button class="btn btn-primary" data-act="vocab-save" data-ci="${esc(ci)}" data-source="${source}">保存</button>
        <button class="btn btn-quiet" data-act="vocab-cancel">取消</button>
      </div>`;
    const ta = main.querySelector('textarea');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  } else if (act === 'vocab-save') {
    const ci = btn.dataset.ci, source = btn.dataset.source || 'ci';
    const rowEl = btn.closest('.vocab-row');
    const ta = rowEl && rowEl.querySelector('textarea');
    if (!ta) return;
    btn.disabled = true;
    const r = await window.xuh.dictSetExplanation({ ci, explanation: ta.value, source });
    if (!r || r.error) { btn.disabled = false; toast('保存失败：' + ((r && r.error) || '未知'), true); return; }
    toast('已保存：' + ci);
    if (source === 'user') loadUser(); else loadVocab();
  } else if (act === 'vocab-cancel') {
    if (S.meme.vtab === 'user') loadUser(); else loadVocab();
  } else if (act === 'vocab-del') {
    const ci = btn.dataset.ci;
    if (!confirm('从「我的词」删除：' + ci + '？')) return;
    btn.disabled = true;
    const r = await window.xuh.dictDeleteUser({ ci });
    if (!r || r.error) { btn.disabled = false; toast('删除失败：' + ((r && r.error) || '未知'), true); return; }
    toast('已删除：' + ci); loadUser();
  }
}


/* ---------------- ② 约定：长期记忆里「说过的要做到」那批 ----------------
 * 数据源和面板同一个接口（/api/topic?view=promise），所以两边看到的一模一样。
 * 只读：这里不改内容，改内容去面板（避免两边同时写覆盖）。 */
async function loadPacts() {
  const r = await window.xuh.api('GET', '/api/topic?view=promise&limit=500');
  if (!r || r.error) { toast('约定读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.pacts.list = Array.isArray(r.list) ? r.list : [];
  S.pacts.counts = r.counts || {};
  S.pacts.platforms = Array.isArray(r.platforms) ? r.platforms : [];
  S.pacts.loaded = true;
  paintChrome();
  if (S.tab === 'pacts') render();
}

// 这条约定挂在谁名下。键统一是 'platform:id'（qq:1033830163 / bili:434882781 / xhs:xxx），
// 名字由服务端算好放在 whoName 里（平台注册表只有 people.js 一份，加新平台这里不用改）；
// 拿不到才在这里兜底拼一次，平台名也读接口给的表，不写死 QQ / B站。
function pactWhoName(x) {
  if (!x) return '所有人';
  const k = String(x.qq || '').trim();
  if (!k) return '所有人';
  // 名字跟随人物表（2026-11-21 主人）：「主人」「企鹅火丁」这种人物表里的名字，
  // 不是 QQ 资料卡名、也不是标签串里那几个字。owner 是服务端按号现算的。
  if (x.owner) return x.owner;
  if (x.whoName) return x.whoName;
  const cut = k.indexOf(':');
  const plat = cut > 0 ? k.slice(0, cut) : '';
  const id = cut > 0 ? k.slice(cut + 1) : k;
  const list = (S.snap && S.snap.people && S.snap.people.list) || [];
  // 必须平台和号都对上：只比 id 会让 QQ 123 和 B站 123 认成同一个人
  const p = list.find(x2 => (x2.accounts || []).some(a =>
    String(a.platform) === String(plat) && String(a.id) === String(id)));
  const who = p && (p.name || p.nick) ? (p.name || p.nick) : '';
  const tb = (S.pacts.platforms || []).find(v => String(v.key) === String(plat));
  const tag = (tb ? tb.label : (plat || '账号')) + ' ' + id;
  return who ? who + '（' + tag + '）' : tag;
}

// 三种，和 core 的判据对齐：说话方式类（有句尾记号/结尾加个…）、碰到就做（有触发条件或要说的话）、
// 其余是自动整理出来的「随手记」（没有明确条件，只是留个记录），单独标出来免得混在一起看。
function pactKindOf(x) {
  if (String(x.sig || '')) return 'style';
  if (/(结尾|句尾|末尾|加个|加上|带上|叫我|称呼|语气|口癖)/.test(String(x.text || ''))) return 'style';
  if ((Array.isArray(x.when) && x.when.length) || String(x.say || '').trim()) return 'scene';
  return 'note';
}

function htmlPacts() {
  const P = S.pacts;
  if (!P.loaded) return '<div class="loading">读出约定中…</div>';
  const all = (P.list || []).slice().reverse();        // 新的在上
  const k = P.kind, q = P.q.trim().toLowerCase();
  const list = all.filter(x => {
    const kind = pactKindOf(x);
    if (k === 'person' && !x.qq) return false;
    if (k === 'common' && x.qq) return false;
    if (k === 'style' && kind !== 'style') return false;
    if (k === 'scene' && kind !== 'scene') return false;
    if (!q) return true;
    return (String(x.text || '') + ' ' + String(x.say || '') + ' ' + (x.when || []).join(' ')).toLowerCase().indexOf(q) >= 0;
  });
  const nPerson = all.filter(x => x.qq).length;
  const nScene = all.filter(x => pactKindOf(x) === 'scene').length;
  const nStyle = all.filter(x => pactKindOf(x) === 'style').length;
  // 只有两类（主人 2026-11-11 定）：条件明确（碰到 X 就做 Y）、说话方式（句尾/称呼/语气）。
  // 自动总结出来的「日常感想」那种废话已从数据里删掉，页面也不再给它们留位置。
  const counters = `
  <div class="counters">
    <div class="counter"><div class="counter-n">${num(all.length)}</div><div class="counter-l">全部约定</div>
      <div class="counter-sub">说过的要做到</div></div>
    <div class="counter"><div class="counter-n${nScene ? '' : ' is-zero'}">${num(nScene)}</div><div class="counter-l">条件明确</div>
      <div class="counter-sub">碰到什么就做什么</div></div>
    <div class="counter"><div class="counter-n${nStyle ? '' : ' is-zero'}">${num(nStyle)}</div><div class="counter-l">说话方式</div>
      <div class="counter-sub">回他时带上句尾 / 称呼</div></div>
    <div class="counter"><div class="counter-n${nPerson ? '' : ' is-zero'}">${num(nPerson)}</div><div class="counter-l">按人</div>
      <div class="counter-sub">只对那个人生效</div></div>
  </div>`;
  const kinds = [['all', '全部'], ['scene', '条件明确'], ['style', '说话方式'], ['person', '按人'], ['common', '通用']];
  const chips = `<div class="pact-bar">
    <input class="field" id="pact-q" placeholder="搜约定内容（人名、触发词、要说的话）" value="${esc(P.q)}" style="width:300px">
    <span class="pact-tabs">${kinds.map(([v, n]) =>
      `<button class="chip${P.kind === v ? ' is-on' : ''}" data-act="pact-kind" data-kind="${v}">${n}</button>`).join('')}</span>
  </div>`;
  const rows = list.length ? list.map(x => {
    const kind = pactKindOf(x);
    const when = Array.isArray(x.when) ? x.when.filter(Boolean) : [];
    const say = String(x.say || '').trim();
    const note = String(x.note || '').trim();
    const KIND_NAME = { style: '说话方式', scene: '条件明确' };
    const whenTxt = when.length
      ? '触发：' + when.slice(0, 3).map(w => '「' + w + '」').join(' ')
        + (when.length > 3 ? ' 共 ' + when.length + ' 条' : '')
      : (kind === 'style' ? '回他的时候带' : '');
    return `<div class="pact">
      <div class="pact-top">
        <span class="badge ${x.qq ? 'badge-blue' : ''}">${x.qq ? '按人' : '通用'}</span>
        ${x.pid
          ? `<span class="pact-who is-link" data-act="chat-person-goto" data-pid="${esc(x.pid)}" title="名字来自人物表 · 点一下去朋友录里看他">${esc(pactWhoName(x))}</span>`
          : `<span class="pact-who">${esc(pactWhoName(x))}</span>`}
        <span class="badge${kind === 'scene' ? ' badge-blue' : ''}">${KIND_NAME[kind] || '条件明确'}</span>
        <span class="small dim pact-time">${esc(fmtTime(x.t))}</span>
      </div>
      ${say ? `<div class="pact-say" title="要原样说出口的话（符号、括号、标点都不改）">${esc(say)}</div>` : ''}
      ${whenTxt ? `<div class="pact-when" title="${esc(when.join(' / '))}">${esc(whenTxt)}</div>` : ''}
      ${note ? `<div class="pact-note">另外：${esc(note)}</div>` : ''}
      <div class="pact-raw" title="磁盘上的原文">${esc(String(x.text || '').slice(0, 120))}</div>
    </div>`;
  }).join('') : '<div class="empty">这一类还没有约定。群里跟她说「以后碰到 X 就回 Y」（条件明确）或「以后结尾加个 XX」（说话方式），它会自己记。</div>';
  return counters + chips + `<div class="pacts">${rows}</div>`;
}

/* ---------------- 信息识别四功能（2026-11-21 主人定）----------------
 * 言外之意 / 信息量 / 梗含量 / 自我表达：树状+情绪分组+词典/约定现读联动。
 * 四页共用一套 UI，只换文案与 key。数据走 /api/info/:key；标错弹层顺带加的进言外之意。 */
const INFO_TABS = [['intents', '言外之意'], ['infoamount', '信息量'], ['memecontent', '梗含量'], ['selfexpress', '自我表达']];
/* 标错 / 星标弹层要能记的 5 项（逻辑已挪到左栏独立页，但记录入口仍在这两个弹层里）。 */
const RECORD_TABS = INFO_TABS.concat([['logic', '逻辑']]);
const INFO_META = {
  intents:     { note: '话这么说、其实是这个意思。谁说左边那类话，虚幻按右边理解；只用来理解，不念出来。', p: '这么说（占位用 x，例：不用管x）', ph: '不用管x', m: '其实是这个意思', mph: '关于x的所有，都可以随意理解、处置' },
  infoamount:  { note: '判断这句话信息量多少，决定该给多少实质内容。只用来判断，不念出来。', p: '这类话（占位用 x）', ph: '比如：嗯嗯 / 具体数据', m: '信息量判断', mph: '比如：几乎没信息 / 有实质内容' },
  memecontent: { note: '判断这句话的梗含量，决定正经答还是接梗。只用来判断，不念出来。', p: '这类话（占位用 x）', ph: '比如：绷不住了', m: '梗含量判断', mph: '比如：纯玩梗 / 没梗' },
  selfexpress: { note: '判断这句话是在表达他自己，还是在说客观事/别人。只用来理解，不念出来。', p: '这类话（占位用 x）', ph: '比如：我觉得…', m: '表达判断', mph: '比如：在表达自己 / 在说客观事' },
  logic:       { note: '你写的逻辑放这里（只认你写的，我不编）。判断时把这句话先算成一个坐标，先去「信息识别」五页、情绪表达（情绪书 + 教过的）、星标/标错案例、记过的人里按相关性筛选，取多条一起看；以后新增的内容自动进这个池子。', p: '这类话（占位用 x）', ph: '比如：他说「你自己看着办」', m: '该有的判断', mph: '比如：这是在设条件，不是随口说' },
};
async function loadInfoPage(key) {
  const r = await window.xuh.api('GET', '/api/info/' + key);
  if (!r || r.error) { toast('读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.info.pages[key] = { loaded: true, data: r.data || { groups: [] } };
}
function htmlInfoPage(key, opts) {
  const opt = opts || {};
  const pg = S.info.pages[key] || { data: { groups: [] } };
  const meta = INFO_META[key] || INFO_META.intents;
  const groups = (pg.data && pg.data.groups) || [];
  const EMO_NAME = { any: '不受情绪影响', happy: '开心', surprise: '惊讶', angry: '生气', sad: '伤心', fear: '害怕', disgust: '厌恶' };
  let total = 0;
  const groupsHtml = groups.length ? groups.map(g => {
    const items = g.items || []; total += items.length;
    const emo = String(g.emotion || 'any');
    const rows = items.map(x => `
      <div style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px 0;border-top:1px solid rgba(128,128,128,.15)">
        <div style="flex:1">
          <div class="pact-say">「${esc(x.phrase)}」</div>
          <div class="pact-note" style="margin-top:4px">${esc(x.meaning)}</div>
        </div>
        <button class="btn btn-quiet btn-danger" data-act="intent-del" data-key="${key}" data-id="${esc(x.id)}" title="删掉这条">删</button>
      </div>`).join('');
    return `<div class="review-card" style="padding:12px 14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px">${esc(g.name || EMO_NAME[emo] || emo)} <span class="small dim">· ${emo === 'any' ? '永远生效' : '仅' + (EMO_NAME[emo] || emo) + '时'} · ${items.length} 条</span></div>
      ${rows || '<div class="small dim">（这一组还没条目）</div>'}
    </div>`;
  }).join('') : '<div class="empty">这一页还没有规则。下面加一条。</div>';
  const emoOpts = [['any', '不受情绪影响（永远生效）'], ['happy', '开心'], ['surprise', '惊讶'], ['angry', '生气'], ['sad', '伤心'], ['fear', '害怕'], ['disgust', '厌恶']]
    .map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
  const link = (pg.data && pg.data.readLink && pg.data.readLink.length)
    ? ' · 联动现读：' + pg.data.readLink.join('、') : '';
  // 星标样本（2026-11-21）：她星标自己说的话时勾了「这一项到位」，按方面各存一条正例。
  const stars = opt.noStars ? [] : ((pg.data && pg.data.stars) || []);
  const starsHtml = stars.length ? `<div class="review-card" style="padding:12px 14px;margin-bottom:12px">
    <div style="font-weight:600;margin-bottom:6px">星标样本 · ${stars.length} 条 <span class="small dim">（被星标过、这一项到位的原话，当正面示范）</span></div>
    ${stars.slice().reverse().map(s => `<div style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px 0;border-top:1px solid rgba(128,128,128,.15)">
      <div style="flex:1">
        <div class="pact-say">「${esc(s.text)}」</div>
        ${s.note ? `<div class="pact-note" style="margin-top:4px">${esc(s.note)}</div>` : ''}
        <div class="small dim" style="margin-top:4px">${esc(s.scope || '')} · ${esc(fmtTime(s.t))}</div>
      </div>
      <button class="btn btn-quiet btn-danger" data-act="info-delstar" data-key="${key}" data-id="${esc(s.id)}" title="删掉这条样本">删</button>
    </div>`).join('')}
  </div>` : '';
  // 逻辑页：整合这一页所有项（含以后新增的），只读，去各自页改。
  const agg = (!opt.noAgg && key === 'logic' && Array.isArray(pg.aggregate)) ? pg.aggregate : null;
  const aggHtml = agg ? `<div class="review-card" style="padding:12px 14px;margin-bottom:12px">
    <div style="font-weight:600;margin-bottom:8px">坐标池来源 · 已启用 ${agg.filter(d => d.total || d.stars).length}/${agg.length} 项 <span class="small dim">（只读，去各自页改；以后新增的自动进来）</span></div>
    ${agg.map(d => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid rgba(128,128,128,.15)">
      <span style="flex:1">${esc(d.label)}</span>
      <span class="small dim">${d.total} 条规则 · ${d.stars} 条星标样本</span>
      <button class="btn btn-quiet" data-act="info-goto" data-key="${d.key}">去这页</button>
    </div>`).join('')}
  </div>` : '';
  // 逻辑页的坐标池说明（2026-11-21）：让她看得见「这句话在跟什么比远近」。
  const coordHtml = (key === 'logic') ? `<div class="review-card" style="padding:12px 14px;margin-bottom:12px">
    <div style="font-weight:600;margin-bottom:8px">坐标池 <span class="small dim">（这句话先算成一个坐标，再去下面这些里挑最近的几条；以后新增的自动进来）</span></div>
    <div class="small" style="line-height:1.9">
      · <b>信息识别</b>：言外之意 / 信息量 / 梗含量 / 自我表达的条目和星标<span class="dim">（以后新增的页自动进）</span><br>
      · <b>情绪表达</b>：情绪书里的表达词和应对方式 + 教过的情绪表达 / 梗词句 / 攻略<br>
      · <b>主人例句</b>：主人亲自写的「对方这么说 → 我会怎么回」，优先级最高（学劲，不照抄）<br>
      · <b>案例</b>：被星标过的<i>她的话</i>（正面）/ 被标错、被撤回<i>她的话</i>（负面，带错在哪）<br>
      · <b>记过的人</b>：这句提到就必带；没提到极少带（号码打码）<br>
      · <b>现读</b>：词典 / 梗词典 / 约定，命中才进（注入约定本体，不是触发词）
    </div>
    <div class="small dim" style="margin-top:8px">先过<b>相关性门槛</b>：这句和条目要有 ≥2 个连续实字重合（「为什么」「应该」「今天」这类虚词/弱词不算）；属于情绪表达且这句正是那个情绪，可以不走字面。过了门槛才按 <b>字面 55% · 来源 20% · 情绪 15% · 优先 10%</b> 排序。没有一条过门槛就整段不出现（不占 token，也不乱塞人）。</div>
  </div>` : '';
  // 主人例句（2026-11-22）：放在逻辑页顶部——这是主人亲自写的「对方这么说 → 我会怎么回」，
  // 比星标高一级；只学劲，不照抄。案例页不再重复显示。
  const mxList = (key === 'logic' && Array.isArray(S.logic.master)) ? S.logic.master : [];
  const masterHtml = (key === 'logic') ? `<div class="review-card" style="padding:12px 14px;margin-bottom:12px;border:1px solid rgba(194,24,91,.35)">
    <div style="font-weight:600;margin-bottom:6px">主人例句 ${num(mxList.length)} 条 <span class="small dim">（最高一级：对方这么说 → 主人会怎么回；学劲，不照抄）</span></div>
    ${mxList.length ? mxList.map(x => `<div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid rgba(128,128,128,.15)">
      <div style="flex:1">
        <div class="pact-say">「${esc(x.q)}」</div>
        <div class="pact-say" style="margin-top:4px;color:#c2185b">→ ${esc(x.a)}</div>
        ${x.why ? `<div class="pact-note" style="margin-top:4px">${esc(x.why)}</div>` : ''}
        <div class="small dim" style="margin-top:4px">${esc(x.scene || 'any')}${x.t ? ' · ' + esc(fmtTime(x.t)) : ''}</div>
      </div>
      <button class="btn btn-quiet btn-danger" data-act="master-del" data-id="${esc(x.id)}" title="删掉这条">删</button>
    </div>`).join('') : '<div class="small dim">还没有主人例句。</div>'}
  </div>` : '';
  return `<div style="max-width:820px;margin:0 auto;padding:8px 4px 40px">
    <div class="modal-note" style="margin-bottom:14px">${esc(meta.note)} 和情绪书联动——挂了情绪的只在那种情绪下生效，「不受情绪影响」的永远生效。${esc(link)}</div>
    ${masterHtml}
    <div class="review-card" style="padding:14px;margin-bottom:16px">
      <label class="modal-label">${esc(meta.p)}</label>
      <input class="field" id="intent-phrase" placeholder="${esc(meta.ph)}" style="width:100%">
      <label class="modal-label" style="margin-top:10px">${esc(meta.m)}</label>
      <input class="field" id="intent-meaning" placeholder="${esc(meta.mph)}" style="width:100%">
      <label class="modal-label" style="margin-top:10px">哪种情绪下生效</label>
      <select class="field" id="intent-emotion" style="width:100%">${emoOpts}</select>
      <div style="margin-top:12px"><button class="btn btn-primary" data-act="intent-add" data-key="${key}">加上这条</button></div>
    </div>
    ${aggHtml}
    ${coordHtml}
    ${starsHtml}
    <div class="small dim" style="margin-bottom:8px">共 ${total} 条 · ${groups.length} 组</div>
    ${groupsHtml}
  </div>`;
}

/* ---------------- 逻辑（2026-11-21 07:09 主人定：左栏顶级页）----------------
 * 页内两栏：「逻辑」= 她写的规则（树状+情绪，跟信息识别同一套引擎，只是单独一页）；
 *          「案例」= 星标（她认过的做对了）+ 标错（她否过的），只读，都读原来的池。
 * 她原话：「我写的那些才是逻辑，你的例子不是」「把星标和标错作为案例也放这页」。 */
async function loadLogicRules() {
  await loadInfoPage('logic');
  // 主人例句（2026-11-22）：逻辑页顶部要显示，和规则一起看
  try {
    const r = await window.xuh.api('GET', '/api/logic/master');
    if (r && r.ok) S.logic.master = Array.isArray(r.items) ? r.items : [];
  } catch {}
}
async function loadLogicCases() {
  const r = await window.xuh.api('GET', '/api/logic/cases');
  if (!r || r.error) { toast('案例读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.logic.cases = {
    stars: Array.isArray(r.stars) ? r.stars : [],
    issues: Array.isArray(r.issues) ? r.issues : [],
    master: Array.isArray(r.masterExamples) ? r.masterExamples : [],
  };
  S.logic.casesLoaded = true;
  if (S.tab === 'logic') render();
}
function htmlLogicCases() {
  const C = S.logic.cases || { stars: [], issues: [] };
  const row = (x, sign) => `<div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid rgba(128,128,128,.15)">
    <div style="flex:1">
      <div class="pact-say">${sign}${esc(String(x.text || '').replace(/@\d{5,12}\s*/g, '').slice(0, 180))}</div>
      ${x.note ? `<div class="pact-note" style="margin-top:4px">${esc(x.note)}</div>` : ''}
      <div class="small dim" style="margin-top:4px">${esc(x.scope || '')}${x.t ? ' · ' + esc(fmtTime(x.t)) : ''}</div>
    </div>
  </div>`;
  const good = (C.stars || []).length
    ? C.stars.slice(0, 60).map(x => row(x, '✓ ')).join('')
    : '<div class="small dim">还没有星标案例。去聊天记录里给虚幻说得好的那句加星，就是「做对了」的案例。</div>';
  const bad = (C.issues || []).length
    ? C.issues.slice(0, 60).map(x => row(x, '✗ ')).join('')
    : '<div class="small dim">还没有标错案例。</div>';
  return `<div style="max-width:820px;margin:0 auto;padding:8px 4px 40px">
    <div class="modal-note" style="margin-bottom:14px">案例不是规则，是实例：星标=她做到过、被认可；标错=她做错、被否过。主人例句在「逻辑」栏顶部。</div>
    <div class="review-card" style="padding:12px 14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px">正面案例 · 星标 ${num((C.stars || []).length)} 条</div>
      ${good}
    </div>
    <div class="review-card" style="padding:12px 14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px">负面案例 · 标错 ${num((C.issues || []).length)} 条</div>
      ${bad}
    </div>
  </div>`;
}

/* ---------------- ②-2 记录的（2026-11-12 主人定）----------------
 * 每条带教学者 id 署名，按方向另存在 src/data/teach/<方向>.jsonl；
 * 只在教的人在场的私聊 / 群聊里用（在场按群成员名单判，机器人端算）。
 * 约定里打了 dir 的条目（如「够童！」→ 梗）只读展示，不复制一份数据。 */
async function loadTeach() {
  const r = await window.xuh.api('GET', '/api/teach');
  if (!r || r.error) { toast('教学列表读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.teach.list = Array.isArray(r.list) ? r.list : [];
  S.teach.dirs = Array.isArray(r.dirs) ? r.dirs : [];
  S.teach.sections = Array.isArray(r.sections) ? r.sections : [];
  S.teach.counts = r.counts || {};
  S.teach.axis = r.axis || {};
  S.teach.loaded = true;
  teachBadge();
  if (S.tab === 'teach') render();
}

/* 「记录的」计数 = 教学条 + 攻略份（攻略页 2026-11-13 并进来，两处加载都刷这一个数）。 */
function teachBadge() {
  const badge = $('#c-teach');
  if (!badge) return;
  const n = (S.teach.list || []).length + (S.guides.loaded ? (S.guides.list || []).length : 0);
  badge.textContent = num(n);
}

/* ---------------- ②-1b 记录的：单条检索 / 核实 / 删除（2026-11-13 主人定） ----------------
 * 攻略（游戏攻略等）、学到的事、教学条三类都在这里按「人物 / 关键词 / 时间 / 核实状态」查；
 * 每条能单独核实（记成「我手动核实过」）和单独删。
 * 机器人那边用同一份 kb.retrieve：每轮 ≥4 字才查、只喂命中的几条，不再整栏塞提示词。 */
async function loadKb() {
  const r = await window.xuh.kb('list', { limit: 500 });
  if (!r || r.error) { S.kb.err = (r && r.error) || '未知原因'; S.kb.loaded = true; render(); return; }
  S.kb.list = Array.isArray(r.list) ? r.list : [];
  S.kb.stats = r.stats || null;
  S.kb.files = Array.isArray(r.files) ? r.files : [];
  S.kb.err = '';
  S.kb.loaded = true;
  if (S.tab === 'teach') render();
}

/* 「记录的 · 学到的」三类（主人 2026-11-13）：游戏攻略 / 情绪表达 / 梗词句 + 教学条。
 * 分类由后端按「> 分类：」或内容判出来（kb.items 的 topic 字段），这里只做筛选，不重判。 */
const KB_TOPICS = ['游戏攻略', '情绪表达', '梗词句'];
const KB_KIND = { guide: '游戏攻略', learn: '学到的', teach: '教学' };
/* 人设条 / 可用知识：只认别人 / 角色的人设素材、别人教的可用知识，都带署名。
 * 这两格 id 是 md:人设素材.md:N / md:可用知识.md:N，走 kb 的 spec-* 写入动作。 */
const SPEC_FILES = ['人设素材.md', '可用知识.md'];
const isSpec = x => !!x && /^md:(人设素材|可用知识)\.md:\d+$/.test(String(x.id || ''));
const SPEC_KIND = { persona: '人设素材', teach: '可用知识' };
function kbRows() {
  const K = S.kb;
  const q = String(K.q || '').trim().toLowerCase();
  const who = String(K.who || '').trim().toLowerCase();
  let list = (K.list || []).slice();
  if (K.kind === 'teach') list = list.filter(x => x.kind === K.kind && !x.fromPact);
  else if (K.kind === 'persona') list = list.filter(x => x.kind === K.kind);
  else if (KB_TOPICS.indexOf(K.kind) >= 0) list = list.filter(x => x.topic === K.kind);
  else if (K.kind !== 'all') list = list.filter(x => x.kind === K.kind);
  if (K.only) list = list.filter(x => String(x.id) === String(K.only));
  if (who) list = list.filter(x => (String(x.whoName || '') + ' ' + String(x.whoKey || '')).toLowerCase().indexOf(who) >= 0);
  if (K.ver !== 'all') list = list.filter(x => (K.ver === 'none' ? !x.verified : x.verified === K.ver));
  if (K.since || K.until) {
    const s = K.since ? new Date(K.since + 'T00:00:00').getTime() : 0;
    const u = K.until ? new Date(K.until + 'T23:59:59').getTime() : Infinity;
    list = list.filter(x => { const t = Date.parse(x.time || ''); return !Number.isFinite(t) || (t >= s && t <= u); });
  }
  if (q) {
    list = list.filter(x => (String(x.title || '') + ' ' + String(x.body || '') + ' ' + String(x.say || '') + ' ' + String(x.whoName || '')).toLowerCase().indexOf(q) >= 0);
  }
  // 人设条 / 可用知识按时间正常排，不再一律压到最后（原来那一百多条自己人设已不进这一格）。
  return list;
}

function htmlKbBlock() {
  const K = S.kb;
  if (!K.loaded) return '<div class="loading">读出学到的…</div>';
  if (K.err) return `<div class="empty">读不出来：${esc(K.err)}</div>`;
  const st = K.stats || { verified: {} };
  const v = st.verified || {};
  const rows = kbRows();
  const VER = { manual: ['已核实 · 我手动', 'badge-blue'], web: ['已核实 · 联网', 'badge-blue'], '': ['未核实', 'badge-grey'] };
  const chip = (act, val, cur, label) =>
    `<button class="chip${cur === val ? ' is-on' : ''}" data-act="${act}" data-v="${esc(val)}">${esc(label)}</button>`;
  const list = rows.length ? rows.map(x => {
    const vb = VER[x.verified || ''] || VER[''];
    const body = String(x.body || '').replace(/\n+/g, ' ').slice(0, 160);
    const spec = isSpec(x);
    const pactPersona = String(x.id || '').indexOf('pact-persona:') === 0;
    const where = spec
      ? (esc(SPEC_KIND[x.kind] || x.kind) + ' · 署名 ' + esc(x.whoName || x.whoKey || '未署名')
        + (x.scope ? ' · 场合 ' + esc(x.scope) : '') + (x.tags ? ' · 标签 ' + esc(x.tags) : '')
        + ' · ' + esc(x.file || '') + ' 第 ' + num(x.line || 0) + ' 行')
      : (pactPersona ? ('约定 · 身份认知' + (x.scope ? ' · ' + esc(x.scope) : '') + ' · 正本 topics.jsonl')
        : (x.kind === 'teach'
          ? ('教学 · ' + esc(x.dir || '') + (x.scope ? ' · ' + esc(x.scope) : ''))
          : ('data/guides/' + esc(x.file || '') + ' · 第 ' + num(x.line || 0) + ' 行')));
    return `<div class="pact">
      <div class="pact-top">
        <span class="badge badge-blue">${esc(x.kindName || KB_KIND[x.kind] || x.kind)}</span>
        <span class="badge ${vb[1]}">${esc(vb[0])}</span>
        <span class="pact-who">${esc(x.whoName || x.whoKey || '未署名')}</span>
        <span class="small dim pact-time">${esc(fmtTime(x.time))}</span>
        ${x.locked ? '<span class="badge badge-grey">已锁定</span>' : ''}
      </div>
      <div class="pact-say">${esc(x.title || '')}</div>
      ${body ? `<div class="pact-raw">${esc(body)}</div>` : ''}
      <div class="pact-note">${where}</div>
      <div class="pact-when" style="margin-top:6px">
        ${spec ? `
          <button class="btn btn-quiet" data-act="kb-spec-edit" data-id="${esc(x.id)}">改 / 补正文</button>
          ${x.verified === 'manual' ? '<span class="small dim">这条已经核实过</span>'
            : `<button class="btn btn-quiet" data-act="kb-verify" data-id="${esc(x.id)}">核实（记我手动核实过）</button>`}
          ${x.path ? `<button class="btn btn-quiet" data-act="kb-open" data-path="${esc(x.path)}" data-line="${esc(x.line || 0)}">看原文</button>` : ''}
          <button class="btn btn-quiet" data-act="kb-only" data-id="${esc(x.id)}">只查这条</button>
          <button class="btn btn-danger" data-act="kb-spec-del" data-id="${esc(x.id)}">删</button>
        ` : `
        ${pactPersona ? `<span class="small dim" title="身份认知约定：正本在 topics.jsonl，改内容去「约定」页；这里只让人设条里也能看见">约定正本</span>`
          : (x.verified === 'manual' ? '<span class="small dim">这条已经核实过</span>'
            : `<button class="btn btn-quiet" data-act="kb-verify" data-id="${esc(x.id)}">核实（记我手动核实过）</button>`)}
        ${x.kind === 'teach' ? `<button class="btn btn-quiet" data-act="review-open" data-id="${esc(x.id)}">查看 / 改</button>` : ''}
        ${x.file && x.kind !== 'persona' ? `<button class="btn btn-quiet" data-act="kb-edit" data-id="${esc(x.id)}">改内容 / 搬归属</button>` : ''}
        ${x.path ? `<button class="btn btn-quiet" data-act="kb-open" data-path="${esc(x.path)}" data-line="${esc(x.line || 0)}">看原文</button>` : ''}
        <button class="btn btn-quiet" data-act="kb-only" data-id="${esc(x.id)}">只查这条</button>
        ${pactPersona ? '' : `<button class="btn btn-danger" data-act="kb-del" data-id="${esc(x.id)}">删</button>`}
        `}
      </div>
    </div>`;
  }).join('') : '<div class="empty">这个条件没有条目。换个关键词 / 人物试试，或把时间放宽。</div>';

  return `<div class="sheet"><div class="sheet-head">
      <h2>学到的 · 单条检索（${num(rows.length)} / ${num((K.list || []).length)} 条）</h2>
      <span class="hint">机器人每轮只查这里命中的几条（≥4 字才查），不再整栏塞进提示词；核实用的是「主人手动」，联网核实自动标</span></div>
    <div class="sheet-body">
      <div class="pact-bar" style="margin-bottom:6px">
        <input class="field" id="kb-q" placeholder="关键词（可指向单条）" value="${esc(K.q)}" style="width:220px">
        <input class="field" id="kb-who" placeholder="人物 / 号" value="${esc(K.who)}" style="width:150px">
        <span class="small dim">时间</span>
        <input class="field" id="kb-since" type="date" value="${esc(K.since)}" style="width:140px">
        <span class="small dim">→</span>
        <input class="field" id="kb-until" type="date" value="${esc(K.until)}" style="width:140px">
      </div>
      <div class="pact-bar" style="margin-bottom:6px">
        <span class="small dim">范围</span>
        <span class="pact-tabs">${['all'].concat(KB_TOPICS, ['persona', 'teach']).map(k => {
          const cnt = (k === 'teach' || k === 'persona') ? ((st.byKind || {})[k] || 0) : ((st.byTopic || {})[k] || 0);
          const label = k === 'all' ? '全部（含人设 / 教学）' : (k === 'teach' ? '教学条 ' + num(cnt) : (k === 'persona' ? '人设条 ' + num(cnt) : k + ' ' + num(cnt)));
          return chip('kb-kind', k, K.kind, label);
        }).join('')}</span>
        <span class="small dim">核实</span>
        <span class="pact-tabs">${chip('kb-ver', 'all', K.ver, '全部')}${chip('kb-ver', 'manual', K.ver, '我手动 ' + num(v.manual || 0))}${chip('kb-ver', 'web', K.ver, '联网 ' + num(v.web || 0))}${chip('kb-ver', 'none', K.ver, '未核实 ' + num(v.none || 0))}</span>
        ${K.only ? `<button class="btn btn-quiet" data-act="kb-clear">取消单条筛选</button>` : ''}
        <button class="float-btn" data-act="kb-spec-new" title="记一条：人设素材＝别人 / 角色的人设（用来认识、分辨人、攒画像素材）；可用知识＝能拿来用的知识。点开选种类，正文以后随时补到末尾">＋</button>
      </div>
      <div class="small dim">共 ${num(st.total || 0)} 条：游戏攻略 ${num((st.byTopic || {}).游戏攻略 || 0)} · 情绪表达 ${num((st.byTopic || {}).情绪表达 || 0)} · 梗词句 ${num((st.byTopic || {}).梗词句 || 0)} · 教学 ${num((st.byKind || {}).teach || 0)} · 人设素材 ${num((st.byKind || {}).persona || 0)}</div>
    </div>
    <div class="pacts">${list}</div></div>${htmlKbEdit()}`;
}

/* md 类（攻略 / 学到的）改内容 + 搬归属（2026-11-13 主人：「所有内容我都能…修改内容」）。
 * 归属是二级：先选搬到哪份文件（群X / 私聊QQ号 / 平台 / 联网 / 攻略），再改标题和正文。 */
/* 人设素材 / 可用知识：新增、改署名场合标签、把长正文补到末尾。
 * 一条只写一份：写完存回 data/guides/ 那一份 md 的小节，不建平行表。 */
function htmlKbSpec() {
  const s = S.kb.spec;
  if (!s) return '';
  const isNew = !!s.isNew;
  return `<div class="float-card" data-float="kbSpec">
    <div class="float-card__head"><span class="float-card__t">${isNew ? '记一条' : '改这一条'}</span>
      <span class="float-card__n">${esc(SPEC_KIND[s.kind] || '')}</span></div>
    <div class="float-card__body">
      <label>种类</label>
      <select class="field" id="kbs-kind"${isNew ? '' : ' disabled'} title="人设素材＝别人 / 角色的人设；可用知识＝能拿来用的知识">
        <option value="persona"${s.kind === 'persona' ? ' selected' : ''}>人设素材</option>
        <option value="teach"${s.kind === 'teach' ? ' selected' : ''}>可用知识</option>
      </select>
      <label>名字 / 这条是什么</label>
      <input class="field" id="kbs-title" value="${esc(s.title || '')}" placeholder="一个名字" title="给这条起个短名字，正文以后能补到末尾">
      <label>署名</label>
      <input class="field" id="kbs-who" value="${esc(s.who || '')}" placeholder="platform:id 或名字" title="人物表里的 platform:id，或直接写名字">
      <label>场合</label>
      <input class="field" id="kbs-scope" value="${esc(s.scope || '')}" placeholder="群号 / 私聊 / 平台" title="这条是在哪个场合出现的">
      <label>标签</label>
      <input class="field" id="kbs-tags" value="${esc(s.tags || '')}" placeholder="斜杠分隔" title="给分析画像用，斜杠分隔">
      <label>来源</label>
      <input class="field" id="kbs-source" value="${esc(s.source || '')}" placeholder="谁在哪说的" title="这条出自谁、哪段对话">
      <label>正文</label>
      <textarea class="field" id="kbs-body" rows="10" placeholder="可以留空" title="长文直接贴这儿，或以后点「改 / 补正文」放到末尾">${esc(s.body || '')}</textarea>
      <div class="modal-btns">
        <button class="btn btn-primary" data-act="kb-spec-save">保存</button>
      </div>
    </div></div>`;
}

/* ================= 回话路径（2026-11-13 ⑦⑧）=================
 * 后端真身在 src/replypath.js / tastecopy.js / tasteid.js，这里只画和转。
 * §4：一个图形入口固定右下、说明进 hover、卡悬浮、点外面关、不做关闭键。
 * 三级：一级（三表 / 两份喜好 / 设置）→ 二级（三张表 / 目录）→ 三级（条目表单 / 四栏描述）。
 * 主人 2026-11-15 纠正：回话路径 = 「情绪应对表 / 动作应对表 / 信息对齐表 / 虚幻喜好表」
 * **四张表平级**统一成一个入口，不是「三张表 + 两份喜好 + 设置」。
 * 配置（优先级 / 例外 / 阈值）收进 ⚙ 图形子页；第 ⑧ 条的两表转移复制收进虚幻喜好表的折叠区。
 * 情绪应对表的内容来自情绪书（同一个功能）：纯文字、无图、按 6 大类分级、能选更多应对方式。
 * 阈值五字段进折叠（同类 >3 进分级）。 */
const RP_TABS = [['emotion', '情绪应对表'], ['action', '动作应对表'], ['align', '信息对齐表'], ['taste', '虚幻喜好表']];
const RP_META = [['source', '来源'], ['understand', '对其理解'], ['reason', '理由'], ['condition', '附加条件']];
const RP_TH = [['trigger', '触发'], ['limit', '上限'], ['suppress', '抑制'], ['exception', '例外'], ['visible', '外显']];

async function rpCall(mod, action, payload) {
  try { return await window.xuh[mod](action, payload || {}); }
  catch (e) { return { error: String((e && e.message) || e) }; }
}
async function loadRp() {
  const [list, ids, mine, local, diff, status, cols] = await Promise.all([
    rpCall('replypath', 'list'), rpCall('tasteid', 'list'),
    rpCall('tastecopy', 'list', { which: 'mine' }), rpCall('tastecopy', 'list', { which: 'local' }),
    rpCall('tastecopy', 'diff'), rpCall('tastecopy', 'status'), rpCall('tastecopy', 'cols'),
  ]);
  const bad = [list, ids, mine, local, diff, status, cols].find(x => x && x.error);
  S.rp.data = { list: list || {}, ids: ids || { items: [] }, mine: mine || { rows: [] }, local: local || { rows: [] }, diff: diff || {}, status: status || {}, cols: (cols && cols.cols) || [] };
  S.rp.err = bad ? String(bad.error) : '';
  S.rp.loaded = true;
  paintFloats();
}
function rpChip(act, v, on, label, title) {
  return `<button class="chip${on ? ' is-on' : ''}" data-act="${act}" data-v="${esc(v)}" title="${esc(title || '')}">${esc(label)}</button>`;
}
function rpIdWord(id) {
  const it = ((S.rp.data || {}).ids || {}).items || [];
  const x = it.find(y => String(y.id) === String(id));
  return x ? x.word : String(id || '');
}
function htmlRpForm() {
  const R = S.rp, d = R.data || {}, f = R.form || {};
  const ids = (d.ids && d.ids.items) || [];
  const sel = new Set((f.tasteIds || []).map(String));
  const opts = R.kind === 'emotion' ? ((((d.list || {}).tables || {}).emotion || {}).book || {}).rows || [] : [];
  const kindName = (RP_TABS.find(x => x[0] === R.kind) || [])[1] || '';
  return `<div class="rp-sub">
    <button class="float-btn" data-act="rp-back" title="回上一级，不关这张卡">‹</button>
    <span class="small dim">${esc(kindName)} · ${f.id ? '改这一条' : '记一条'}</span></div>
    <label>名字</label><input class="field" id="rp-name" value="${esc(f.name || '')}" title="给这条起个短名字">
    <label>说法 / 内容</label><textarea class="field" id="rp-text" rows="3" title="这条要怎么应对、对齐什么信息">${esc(f.text || '')}</textarea>
    ${opts.length ? `<label>从情绪书挑一句（纯文字，选了就填进上面）</label>
      <select class="field" id="rp-opt" title="情绪书和情绪应对是同一个功能；这里把图的说法列成纯文字，方便多选"><option value="">不挑</option>${opts.slice(0, 200).map(o => `<option value="${esc(o.text)}">${esc(o.core)} / ${esc(o.leaf)} · ${esc(o.text)}</option>`).join('')}</select>` : ''}
    <label>关联偏好（按住 Ctrl / Cmd 可多选）</label>
    <select class="field" id="rp-taste" multiple size="4" title="每条喜好有唯一 id；这里挂的是 id，不是词，改词也不会串">${ids.map(x => `<option value="${esc(x.id)}"${sel.has(String(x.id)) ? ' selected' : ''}>${esc(x.word)} · ${esc(x.id)}</option>`).join('')}</select>
    <details class="rp-details"><summary title="触发 / 上限 / 抑制 / 例外 / 外显：先只记录不做，不参与这一轮怎么回">强度阈值（只记录不做）</summary>
      ${RP_TH.map(([k, n]) => `<label>${n}</label><input class="field" id="rp-th-${k}" value="${esc(f[k] || '')}" title="${n}：只记录，不做判定">`).join('')}
    </details>
    <div class="rp-btns"><button class="btn btn-primary" data-act="rp-save" title="存进这张表">保存</button></div>
  </div>`;
}
function htmlRpDesc() {
  const R = S.rp, f = R.desc || {}, m = f.meta || {};
  return `<div class="rp-sub">
    <button class="float-btn" data-act="rp-back" title="回上一级，不关这张卡">‹</button>
    <span class="small dim">${esc(f.word || '')} · ${esc(f.id || '')} 的具体描述</span></div>
    ${RP_META.map(([k, n]) => `<label>${n}</label><input class="field" id="rp-meta-${k}" value="${esc(m[k] || '')}" title="${n}：平时不给模型，只在检索命中这条时带出来">`).join('')}
    <div class="small dim">没填的按最小参数类型给默认模版；这里写什么由你定，我不替你填。</div>
    <div class="rp-btns"><button class="btn btn-primary" data-act="rp-desc-save" title="只存描述，不改喜好表正文">保存描述</button></div>
  </div>`;
}
/* ⑧「每个词/句对应的其他表条目也会随双方修改同步」：
 * 改词保留 id（正本正文跟着改、旧词仍回指同一 id），并把引用这个 id 的条目列出来。 */
function htmlRpTid() {
  const R = S.rp, w = R.word || {}, links = (w.links || {}).items || [];
  return `<div class="rp-sub">
    <button class="float-btn" data-act="rp-tid-back" title="回上一级，不关这张卡">‹</button>
    <span class="small dim">${esc(w.word || '')} · ${esc(w.id || '')}</span></div>
    <label>改成什么词（id 不变，其他表挂的关联照旧跟着）</label>
    <input class="field" id="rp-tid-word" value="${esc(w.word || '')}" title="只改词不换 id；正本正文同步改，本地副本已上锁不跟着改">
    <div class="rp-btns"><button class="btn btn-primary" data-act="rp-tid-save" title="改完其他表里挂这个 id 的条目还是同一条">改词（保留 id）</button></div>
    <div class="small dim" title="按 ⑩ 本地副本已上锁，这边不动；旧词仍回指同一个 id，差异由 diff 记成「只在副本」">本地副本已上锁，不跟着改；旧词仍回指同一个 id。</div>
    <details class="rp-details" open><summary title="情绪 / 动作 / 信息对齐三张表里引用这个 id 的条目">关联条目 · ${num(links.length)} 条</summary>
      ${links.length ? links.map(x => `<div class="rp-row"><div class="rp-row__t">【${esc(x.kindLabel || x.kind || '')}】${esc(x.name || '')}</div>
        <div class="rp-row__b">${esc(x.text || '')}</div></div>`).join('') : '<div class="small dim">还没有别的表挂这个 id。</div>'}</details>
  </div>`;
}
/* 四张表各自的页面。说明全进 title；同类 >3 进分级（6 大类 chip + 分支内折叠）。 */
function htmlRpBook(R, d) {
  const t = (((d.list || {}).tables || {}).emotion) || {};
  const book = t.book || { cores: [], rows: [], total: 0 };
  const cores = book.cores || [];
  const cur = R.core || '';
  const shown = cur ? cores.filter(c => c.name === cur) : cores;
  const chips = `<div class="rp-tabs">${cores.map(c => rpChip('rp-core', c.name, cur === c.name, c.name,
    '只展开这一大类；情绪书 6 大类')).join('')}${rpChip('rp-core', '', !cur, '全部', '展开 6 大类')}</div>`;
  const groups = shown.map(c => `<div class="rp-book__core"><div class="small dim">${esc(c.name)}</div>
    ${(c.branches || []).map(b => `<details class="rp-details"><summary title="纯文字说法，无图">${esc(b.name)}
      <span class="dim">· ${num((b.leaves || []).reduce((n, l) => n + (l.says || []).length, 0))} 条</span></summary>
      ${(b.leaves || []).map(l => `<div class="rp-book__leaf"><span class="small dim">${esc(l.name)}</span>
        ${(l.says || []).map(s => `<label class="rp-book__say" title="勾了就选进情绪应对表；${esc(s.src)}＝情绪书里 self / other 的来源">
          <input type="checkbox" name="rp-emochk" value="${esc(s.id)}">${esc(s.text)}</label>`).join('')}</div>`).join('')}
    </details>`).join('')}</div>`).join('');
  const ids = (d.ids && d.ids.items) || [];
  return chips + `<div class="small dim" title="情绪书和情绪应对是同一个功能，这里把图的说法全列成纯文字">情绪书纯文字说法 ${num(book.total || 0)} 条 · 已选进表 ${num(t.picked || 0)} 条</div>
    <label>给这次选的说法挂偏好（可多选；挂了就是「有自己偏好的应对」）</label>
    <select class="field" id="rp-pick-taste" multiple size="3" title="每条喜好有唯一 id，改词也不串">${ids.map(x => `<option value="${esc(x.id)}">${esc(x.word)} · ${esc(x.id)}</option>`).join('')}</select>
    <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-pick" title="把勾中的纯文字说法选进情绪应对表，带情绪书引用、不复制正文">选进表</button></div>
    <div class="rp-book">${groups || '<div class="small dim">情绪书还没读到</div>'}</div>`;
}
function htmlRpEmotion() {
  const R = S.rp, d = R.data || {};
  const t = (((d.list || {}).tables || {}).emotion) || { items: [] };
  const rows = (t.items || []).map(x => `<div class="rp-row">
    <div class="rp-row__t">${esc(x.name || '')} <span class="rp-row__ids" title="关联偏好 id">${(x.tasteIds || []).map(i => esc(rpIdWord(i))).join('、')}</span></div>
    <div class="rp-row__b">${esc(x.text || '')}${x.builtin ? ' <span class="dim" title="来自情绪书，同一个功能">· 情绪书</span>' : ''}</div>
    <div class="rp-row__a"><button class="float-btn" data-act="rp-edit" data-id="${esc(x.id)}" title="改这一条">✎</button>
      <button class="float-btn" data-act="rp-del" data-id="${esc(x.id)}" data-arm="0" title="删这一条（点两次确认）">×</button></div></div>`).join('');
  return `<div class="rp-sub"><span class="small dim">已选 / 自己写的 ${num((t.items || []).length)} 条</span>
    <button class="float-btn" data-act="rp-new" title="不挑情绪书，自己写一条应对">＋</button></div>
    ${rows ? `<div class="rp-list">${rows}</div>` : '<div class="small dim" title="下面按 6 大类展开，勾说法就能选进来">表里还没有条目，从下面选</div>'}
    ${htmlRpBook(R, d)}`;
}
function htmlRpTable(kind) {
  const d = S.rp.data || {};
  const t = (((d.list || {}).tables || {})[kind]) || { items: [] };
  const name = (RP_TABS.find(x => x[0] === kind) || [])[1] || '';
  const rows = (t.items || []).map(x => `<div class="rp-row">
    <div class="rp-row__t">${esc(x.name || '')} <span class="rp-row__ids" title="关联偏好 id">${(x.tasteIds || []).map(i => esc(rpIdWord(i))).join('、')}</span></div>
    <div class="rp-row__b">${esc(x.text || '')}</div>
    <div class="rp-row__a"><button class="float-btn" data-act="rp-edit" data-id="${esc(x.id)}" title="改这一条">✎</button>
      <button class="float-btn" data-act="rp-del" data-id="${esc(x.id)}" data-arm="0" title="删这一条（点两次确认）">×</button></div></div>`).join('');
  return `<div class="rp-sub"><span class="small dim" title="${esc(name)}：和虚幻喜好表按唯一 id 联动">${num((t.items || []).length)} 条</span>
    <button class="float-btn" data-act="rp-new" title="在这张表里记一条">＋</button></div>
    ${rows ? `<div class="rp-list">${rows}</div>` : '<div class="small dim" title="这张表的内容由你写，我不替你编">这张表还没内容</div>'}`;
}
function htmlRpTaste() {
  const d = S.rp.data || {};
  const t = ((d.list || {}).tables || {}).taste || { items: [], cols: [], total: 0 };
  const ids = (d.ids && d.ids.items) || [], df = d.diff || {}, st = d.status || {};
  const bySec = {};
  for (const x of (t.items || [])) { (bySec[x.sec] = bySec[x.sec] || []).push(x); }
  const colsHtml = (t.cols || []).map(c => {
    const arr = bySec[c.key] || [];
    return `<div class="rv-taste-sec"><div class="rv-taste-h">${esc(c.label)} <span class="dim">${num(arr.length)}</span></div>
      ${arr.length ? arr.map(x => `<div class="rp-row"><div class="rp-row__t"><button class="my-word" data-act="rp-desc" data-id="${esc(x.id)}" data-word="${esc(x.word)}" title="写来源 / 对其理解 / 理由 / 附加条件；平时不进提示词">${esc(x.word)}</button>
        <span class="rp-row__ids">${esc(x.id)}</span>${x.meta && Object.keys(x.meta).length ? '<span class="dim" title="已写具体描述">✎</span>' : ''}</div>
        <div class="rp-row__a"><button class="float-btn" data-act="rp-tid" data-id="${esc(x.id)}" data-word="${esc(x.word)}" title="改这个词但保留 id；同时看其他表里挂这个 id 的条目">⇄</button></div></div>`).join('') : '<div class="small dim">（空）</div>'}</div>`;
  }).join('');
  return `<div class="small dim" title="虚幻喜好表正本；副本是第 ⑧ 条的本地模型专用表，不占这四张表的位置">七栏共 ${num(t.total || 0)} 条 · 点词写四栏描述</div>
    ${colsHtml}
    <details class="rp-details"><summary title="这张表能加 / 删词条；拖动挪位在「我的喜好」页，同一份数据">在这份表里加 / 删词条</summary>
      <label>新词条</label><input class="field" id="rp-new-word" placeholder="一个词或一句" title="只写词或一句，长解释交给检索">
      <label>放进哪栏</label><select class="field" id="rp-new-sec" title="七栏和喜好表一一对应">${(t.cols || []).map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select>
      <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-taste-add" title="加进虚幻喜好表正本">加</button></div>
      <label>选一个词（删 / 换栏用）</label><select class="field" id="rp-word" title="两表共用一个 id">${ids.filter(x => !x.gone).map(x => `<option value="${esc(x.word)}">${esc(x.word)}</option>`).join('')}</select>
      <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-taste-del" data-arm="0" title="从正本删掉选中的词（点两次确认）">删选中的词</button></div>
    </details>
    <details class="rp-details"><summary title="第 ⑧ 条：本地模型专用副本的转移 / 复制，收在这里不占一级">两表转移 / 复制（本地模型副本）</summary>
      <div class="small dim" title="正本＝虚幻喜好表；副本＝本地模型专用，可以大量删减省 token">正本 ${num((d.mine || {}).rows ? d.mine.rows.length : 0)} 条 · 副本 ${num((d.local || {}).rows ? d.local.rows.length : 0)} 条 · 共有 ${num(df.both || 0)} 条${st.locked ? ' · 副本已上锁' : ''}</div>
      <label>方向</label><select class="field" id="rp-dir" title="从哪份表到哪份表"><option value="mine>local">正本 → 副本</option><option value="local>mine">副本 → 正本</option></select>
      <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-copy" title="两边都留着这份词条">复制</button>
        <button class="btn btn-quiet" data-act="rp-move" title="从源表挪走，只留在目标表">转移</button></div>
      <div class="small dim" title="${esc((df.mineOnly || []).join('、'))}">只在正本 ${num((df.mineOnly || []).length)} 条</div>
      <div class="small dim" title="${esc((df.localOnly || []).join('、'))}">只在副本 ${num((df.localOnly || []).length)} 条</div>
      <details class="rp-details"><summary title="她要能大量删副本词条省 token，也能单独加新喜好">在副本里加 / 删词条</summary>
        <label>改哪份</label><select class="field" id="rp-which" title="正本＝虚幻喜好表；副本＝本地模型专用"><option value="mine">正本（虚幻）</option><option value="local">副本（本地模型）</option></select>
        <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-word-add" title="加进选中的那份表；另一份不动">加</button>
          <button class="btn btn-quiet" data-act="rp-word-del" data-arm="0" title="从选中的那份表删掉上面选的词（点两次确认）">删选中的词</button></div>
      </details>
    </details>`;
}
function htmlRpConfig() {
  const L = ((S.rp.data || {}).list) || {}, th = L.thresholds || {}, ex = L.exceptions || [];
  return `<div class="small dim" title="${esc((L.priority || []).join(' > '))}">冲突优先级：${esc((L.priority || []).slice(0, 5).join(' > '))}</div>
    <label>例外项目（偏好 id）</label><input class="field" id="rp-ex-id" placeholder="t1" title="这个 id 的优先级由你定，压过上面的顺序">
    <input class="field" id="rp-ex-note" placeholder="例外说明" title="为什么它是例外">
    <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-exception" title="设／改这条例外；留空 id 不生效">设例外</button></div>
    <div class="small dim">已有例外 ${num(ex.length)} 条</div>
    <label>强度阈值记录</label><input class="field" id="rp-th-text" placeholder="触发 / 上限 / 抑制 / 例外 / 外显" title="先只记录不做：写进来只存档，不参与回话判定">
    <div class="rp-btns"><button class="btn btn-quiet" data-act="rp-threshold" title="只存档，不生效">记一条</button></div>
    <div class="small dim" title="主人 2026-11-13：先只记录不做">${esc(th.mode || '只记录不做')} · 已记 ${num((th.items || []).length)} 条</div>`;
}
function htmlRpCard() {
  const R = S.rp, d = R.data || {};
  const tabTitle = {
    emotion: '情绪之间怎么应对；和情绪书是同一个功能，纯文字无图，能选更多应对方式',
    action: '动作应对表：和虚幻喜好表按唯一 id 联动',
    align: '信息对齐表：和虚幻喜好表按唯一 id 联动',
    taste: '虚幻喜好表：七栏词条、四栏描述、两表转移复制',
  };
  const tabs = `<div class="rp-tabs">${RP_TABS.map(([v, n]) => rpChip('rp-tab', v, R.tab === v, n, tabTitle[v])).join('')}
    <button class="float-btn${R.tab === 'config' ? ' is-on' : ''}" data-act="rp-tab" data-v="config" title="冲突优先级 / 例外项目 / 强度阈值（只记录不做）">⚙</button>
    <button class="float-btn" data-act="rp-refresh" title="重新读一次四张表">↻</button></div>`;
  let body = '';
  if (!R.loaded || R.err) body = `<div class="small dim">${R.err ? esc(R.err) : '读中…'}</div><div class="rp-btns"><button class="btn btn-quiet" data-act="rp-refresh">重试</button></div>`;
  else if (R.form) body = htmlRpForm();
  else if (R.desc) body = htmlRpDesc();
  else if (R.word) body = htmlRpTid();
  else if (R.tab === 'emotion') body = htmlRpEmotion();
  else if (R.tab === 'action' || R.tab === 'align') body = htmlRpTable(R.tab);
  else if (R.tab === 'taste') body = htmlRpTaste();
  else body = htmlRpConfig();
  return `<div class="float-card" data-float="replypath">
    <div class="float-card__head"><span class="float-card__t">回话路径</span>
      <span class="float-card__n" title="四张表统一入口；每条喜好唯一 id，改词不串；命中才进本地检索">⇄ 四张表 · 一个入口</span></div>
    <div class="float-card__body">${tabs}${body}</div></div>`;
}

function htmlKbEdit() {
  const e = S.kb.edit;
  if (!e) return '';
  const files = S.kb.files || [];
  return `<div class="modal-veil"><div class="modal-card">
    <h3>改内容 / 搬归属</h3>
    <label>归属（换一份文件 = 换掉它算谁教的）</label>
    <select class="field" id="kbe-file">
      ${files.map(f => `<option value="${esc(f)}"${f === e.file ? ' selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
    <label>分类（三类；空着就按内容自动判）</label>
    <select class="field" id="kbe-topic">
      <option value="">（自动）</option>
      ${KB_TOPICS.map(t => `<option value="${esc(t)}"${e.topic === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
    </select>
    <label>标题</label>
    <input class="field" id="kbe-title" value="${esc(e.title || '')}">
    <label>正文</label>
    <textarea class="field" id="kbe-body" rows="8">${esc(e.body || '')}</textarea>
    <div class="modal-btns">
      <button class="btn btn-primary" data-act="kb-save" data-id="${esc(e.id)}">保存</button>
      <button class="btn btn-quiet" data-act="kb-editclose">关掉</button>
    </div>
  </div></div>`;
}

/* 「约定」并进「记录的」页（主人 2026-11-13：「「约定」类在「记录的」页内」）。
 * 六个同级分区：说话方式 / 身份认知 / 情绪认知与应对 / 禁止回复 / 常态情绪 / 代称。
 * 数据仍在 topics.jsonl（kind=promise）和 people.json 的 alias，不复制一份。
 * 每条都用同一张复核卡片：能改归属（二级目录选）、改内容、看 5 条原记录、确认锁定。 */
function htmlPactSections() {
  const secs = (S.review.sections && S.review.sections.length) ? S.review.sections
    : ['说话方式', '身份认知', '情绪认知与应对', '禁止回复', '常态情绪', '代称'];
  // 主人 2026-11-13：「约定·代称」只显示被本人改过的人物列，没改过的不进。
  // 标记由 core.reviewAll() 合成：人物级 name 只有本人自己说或主人手改才写得进，AI 猜的 alias 不算。
  const all = reviewItemsOf('promise').concat(reviewItemsOf('alias').filter(x => !!x.selfEdited));
  const cur = String(S.teach.section || 'all');
  const count = {};
  all.forEach(x => { const s = x.section || '说话方式'; count[s] = (count[s] || 0) + 1; });
  const chips = ['all'].concat(secs).map(s =>
    `<button class="chip${cur === s ? ' is-on' : ''}" data-act="teach-section" data-sec="${esc(s)}">`
    + esc(s === 'all' ? '全部' : s) + ' ' + num(s === 'all' ? all.length : (count[s] || 0)) + '</button>').join('');
  const rows = all.filter(x => cur === 'all' || (x.section || '说话方式') === cur);
  const body = rows.length ? rows.map(x => htmlReviewCard(x)).join('') : '<div class="empty">这个分区还没有。</div>';
  return '<div class="sheet-head" style="margin-top:14px"><h2>约定 · 按分区</h2>'
    + '<span class="hint">新增的约定会按内容自动归一个分区；这里能改归属（搬到教学知识 / 换分区）、改内容、确认锁定</span></div>'
    + `<div class="pact-bar"><span class="pact-tabs">${chips}</span></div>`
    + `<div class="pacts">${body}</div>`;
}

function htmlTeach() {
  const T = S.teach;
  // 「碰到 X 就回 Y」的梗应对不算教学条：正本在 topics.jsonl 的约定里，
  // 按「梗词句 / 约定 · 说话方式」展示（只搬不删，数据一行不动）。计数也跟着重算。
  const all = (T.list || []).filter(x => !x.fromPact).slice().reverse();
  const counts = {};
  all.forEach(x => { counts[x.dir] = (counts[x.dir] || 0) + 1; });
  const q = String(T.q || '').trim().toLowerCase();
  const list = all.filter(x => {
    if (T.dir !== 'all' && x.dir !== T.dir) return false;
    if (!q) return true;
    return (String(x.text || '') + ' ' + String(x.say || '') + ' ' + (x.when || []).join(' ')
      + ' ' + String(x.nick || '') + ' ' + String(x.qq || '')).toLowerCase().indexOf(q) >= 0;
  });
  const chips = ['all'].concat(T.dirs).map(d =>
    `<button class="chip${T.dir === d ? ' is-on' : ''}" data-act="teach-dir" data-dir="${esc(d)}">`
    + esc(d === 'all' ? '全部' : d) + ' ' + num(d === 'all' ? all.length : (counts[d] || 0)) + '</button>').join('');
  const counters = `<div class="counters">
    <div class="counter"><div class="counter-n">${num((S.kb.stats || {}).total || all.length)}</div><div class="counter-l">学到的</div>
      <div class="counter-sub">游戏攻略 / 情绪表达 / 梗词句 · 每条带署名</div></div>
    <div class="counter"><div class="counter-n">${num(T.dirs.length)}</div><div class="counter-l">方向分区</div>
      <div class="counter-sub">${esc(T.dirs.join(' / '))}</div></div>
    <div class="counter"><div class="counter-n">${num((T.sections || []).length)}</div><div class="counter-l">同级分区</div>
      <div class="counter-sub">${esc((T.sections || []).join(' / '))}</div></div>
  </div>`;
  const rows = list.length ? list.map(x => {
    // 教学条走统一复核卡片（改归属 / 改内容 / 5 条原记录 / 确认锁定）。
    // 约定里打了 dir 的「够童！」不在复核列表里，仍按原来的只读展示走下面那张卡。
    const rv = reviewOf(x.id);
    if (rv) return htmlReviewCard(rv);
    const when = Array.isArray(x.when) ? x.when.filter(Boolean) : [];
    return `<div class="pact">
      <div class="pact-top">
        <span class="badge badge-blue">${esc(x.dir || '其他')}</span>
        <span class="pact-who">${esc(x.whoName || x.nick || x.qq || '未署名')}</span>
        <span class="small dim">${esc(String(x.qq || ''))}</span>
        <span class="small dim pact-time">${esc(fmtTime(x.t))}</span>
      </div>
      ${x.say ? `<div class="pact-say" title="要原样说出口的话">${esc(x.say)}</div>` : ''}
      ${when.length ? `<div class="pact-when">触发：${esc(when.slice(0, 4).join(' / '))}${when.length > 4 ? ' 共 ' + num(when.length) + ' 条' : ''}</div>` : ''}
      <div class="pact-raw">${esc(String(x.text || '').slice(0, 120))}</div>
      <div class="pact-note">${x.fromPact ? '这条在约定里，只按方向展示（不复制数据）' : esc(String(x.scope || '') + (x.src ? ' · ' + x.src : ''))}</div>
      <button class="btn btn-quiet" data-act="teach-open" data-id="${esc(x.id)}">查看 / 改</button>
    </div>`;
  }).join('') : '<div class="empty">这一类还没有。群里 @ 她说「下次遇到有人说「X」直接回复「Y」」，她会自己记，带教学者的号。</div>';
  /* 整栏切「检索式命中」（2026-11-13 主人：「我可以把「在场就用」的栏目 / 单独条目加入「检索式命中」」）。
   * 单条在卡片上切；整栏在这里切，存 data/teach/axis.json，改完即时生效。 */
  const AXIS_DEF = { 梗: true, 游戏攻略: true, 情绪表达: false, 其他: false };
  const axisBar = `<div class="pact-bar" style="margin-top:-4px">
      <span class="small dim">整栏加入「检索式命中」：</span>
      <span class="pact-tabs">${(T.dirs.length ? T.dirs : ['游戏攻略', '情绪表达', '梗词句']).map(d => {
        const ov = (T.axis || {})[d] || {};
        const on = ov.retrieval === undefined ? !!AXIS_DEF[d] : !!ov.retrieval;
        return `<button class="chip${on ? ' is-on' : ''}" data-act="teach-axis-dir" data-dir="${esc(d)}" data-on="${on ? '1' : '0'}" title="整栏切换：${esc(d)} 的每一条都会跟着变（单条仍可单独覆盖）">${esc(d)}${on ? ' ✓' : ''}</button>`;
      }).join('')}</span>
      <span class="small dim">点一下就切；单条还能在卡片上单独覆盖</span>
    </div>`;
  return counters + htmlKbBlock()
    + htmlPactSections()
    + '<div class="sheet-head" style="margin-top:14px"><h2>教学条（按方向 / 生效轴）</h2>'
    + '<span class="hint">这里管「谁教的、什么时候用」；核实和删除也可以在上面单条列表里做，两处同一条数据</span></div>'
    + `<div class="pact-bar">
      <input class="field" id="teach-q" placeholder="搜教学者、触发词、要说的话" value="${esc(T.q)}" style="width:300px">
      <span class="pact-tabs">${chips}</span>
      <button class="btn btn-quiet" data-act="teach-new">+ 手动加一条</button>
    </div>` + axisBar + `<div class="pacts">${rows}</div>`
    + (S.guides.loaded ? htmlGuidesBlock() : '<div class="loading">读出攻略中…</div>')
    + htmlTeachModal() + htmlReviewModal();
}

function htmlTeachModal() {
  const e = S.teach.edit;
  if (!e) return '';
  const isNew = !!e.isNew;
  const ro = !!e.fromPact;
  const dirs = S.teach.dirs.length ? S.teach.dirs : ['游戏攻略', '情绪表达', '梗词句'];
  const opts = dirs.map(d => `<option value="${esc(d)}"${e.dir === d ? ' selected' : ''}>${esc(d)}</option>`).join('');
  return `<div class="modal-veil"><div class="modal-card">
    <h3>${isNew ? '手动加一条' : (ro ? '这条在约定里（只读展示）' : '改这一条')}</h3>
    ${ro ? '<div class="empty">数据在 topics.jsonl 的约定里，这里只按方向展示；要改内容去「约定」页。</div>' : `
      <label>原话（写「下次遇到有人说「X」直接回复「Y」」，会自动拆触发词和回话）</label>
      <input class="field" id="te-text" value="${esc(e.text || '')}" placeholder="下次遇到有人说「刀盾」直接回复「我的刀盾」">
      <label>教学者 QQ（id 署名）</label>
      <input class="field" id="te-qq" value="${esc(e.qq || '')}" placeholder="1000000002">
      <label>方向</label>
      <select class="field" id="te-dir">${opts}</select>
      <label>要原样回的话</label>
      <input class="field" id="te-say" value="${esc(e.say || '')}">
      <label>触发词（逗号分隔）</label>
      <input class="field" id="te-when" value="${esc((e.when || []).join('，'))}">
      <label>修饰（别解释 之类）</label>
      <input class="field" id="te-note" value="${esc(e.note || '')}">
    `}
    <div class="modal-btns">
      ${ro ? '' : `<button class="btn btn-primary" data-act="teach-save" data-new="${isNew ? '1' : ''}">保存</button>
      ${isNew ? '' : '<button class="btn btn-quiet" data-act="teach-del">删掉</button>'}`}
      <button class="btn btn-quiet" data-act="teach-close">关掉</button>
    </div>
  </div></div>`;
}

/* ---------------- ②-3 朋友录 + 三类知识复核（2026-11-12 主人定）----------------
 * 好感度 + 约定合并成一页：朋友录(>20) / 人物册(<=20) / 通用约定。
 * 教学 / 约定 / 话题三类共用一套复核卡片与弹层：改归属、改内容、看 5 条原记录、确认锁定。
 * 锁定后服务端硬拒一切删改，前端这里也把编辑控件整个收起来（显示层 + 数据层两道）。 */
const TASTE_SECS = [
  ['likeConf', '喜欢 · 确定'], ['hateConf', '讨厌 · 确定'], ['likePerson', '喜欢（人）'],
  ['pending', '待确认'], ['likeGuess', '喜欢 · 可能'], ['hateGuess', '讨厌 · 可能'],
];
async function loadFriends() {
  const r = await window.xuh.api('GET', '/api/friends');
  if (!r || r.error) { toast('朋友录读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.friends.list = Array.isArray(r.people) ? r.people : [];
  S.friends.common = Array.isArray(r.common) ? r.common : [];
  S.friends.counts = r.counts || {};
  S.friends.sections = Array.isArray(r.sections) ? r.sections : [];
  S.friends.dirs = Array.isArray(r.dirs) ? r.dirs : [];
  S.friends.loaded = true;
  loadMine();               // 我的口味（人设层）一起拉：和这份朋友录没有依赖，读失败也不影响
  paintChrome();
  if (['friends', 'people', 'pacts'].indexOf(S.tab) >= 0) render();
}
/* 我的口味（主人＝虚幻共用那一份，2026-11-13 主人令「我的喜好表里有几行喜欢的内容，你没接入」）。
 * 数据源是 soul/段/0-我的喜好.md，和机器人读的是同一份；「喜欢的人」按人物各记各的，不共用。 */
async function loadMine() {
  try {
    const r = await window.xuh.api('GET', '/api/taste/mine');
    if (r && !r.error) {
      S.friends.mine = {
        like: r.like || [], hate: r.hate || [], pending: r.pending || [],
        specialLike: r.specialLike || [], likeConf: r.likeConf || [], likeGuess: r.likeGuess || [],
        neutral: r.neutral || [], hateConf: r.hateConf || [], hateGuess: r.hateGuess || [], specialHate: r.specialHate || [],
        persons: r.persons || [], cols: r.cols || [], cfg: r.cfg || {},
      };
      if (['friends', 'people', 'pacts'].indexOf(S.tab) >= 0) render();
    }
  } catch {}
}
async function loadRelation(who) {
  const w = String(who || '');
  if (!w) return;
  const r = await window.xuh.api('GET', '/api/relation/list?who=' + encodeURIComponent(w));
  if (!r || r.error) { toast('关系表没读出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.friends.rel = Object.assign({}, S.friends.rel || {}, { [w]: r.list });
  render();
}
async function loadReview() {
  const r = await window.xuh.api('GET', '/api/review');
  if (!r || r.error) return;                 // 别的页没读到不影响主流程
  S.review.list = Array.isArray(r.list) ? r.list : [];
  S.review.stateCount = r.stateCount || {};
  S.review.counts = r.counts || {};
  S.review.dirs = Array.isArray(r.dirs) ? r.dirs : [];
  S.review.sections = Array.isArray(r.sections) ? r.sections : [];
  S.review.loaded = true;
  if (['friends', 'people', 'pacts', 'teach', 'chat'].indexOf(S.tab) >= 0) render();
}
function reviewOf(id) {
  return (S.review.list || []).find(x => String(x.id) === String(id)) || null;
}
function reviewItemsOf(kind, o) {
  const opt = o || {};
  return (S.review.list || []).filter(x => {
    if (kind && x.rkind !== kind) return false;
    if (opt.scope && String(x.scope || '') !== opt.scope) return false;
    if (opt.ids && opt.ids.indexOf(String(x.id)) < 0) return false;
    if (opt.q) {
      const hay = String(x.text || '') + ' ' + String(x.say || '') + ' ' + String(x.whoName || '')
        + ' ' + String(x.qq || '') + ' ' + (x.when || []).join(' ');
      if (hay.toLowerCase().indexOf(opt.q.toLowerCase()) < 0) return false;
    }
    return true;
  });
}
const RV_KIND = { teach: '教学知识', promise: '约定', topic: '话题', alias: '代称' };
/* 两条轴（2026-11-13）：默认值跟后端 teach.AXIS 保持一致；单条写了就按单条。 */
const RV_AXIS = { 游戏攻略: [true, true], 情绪表达: [false, true], 梗词句: [true, true], 其他: [false, true] };
function axisOfRow(x) {
  const d = RV_AXIS[(x && x.dir) || ''] || RV_AXIS['其他'];
  return {
    retrieval: (x && x.retrieval === undefined) ? d[0] : !!x.retrieval,
    present: (x && x.present === undefined) ? d[1] : !!x.present,
  };
}
function rvStateName(s) { return s === 'locked' ? '已锁定' : (s === 'pending' ? '待确认' : '未复核'); }

/* 一条复核卡片。教学页 / 朋友录页 / 聊天记录页的话题段都用它，不各写一份。 */
function htmlReviewCard(x) {
  const st = x.state || 'legacy', locked = st === 'locked';
  const ev = (x.review && x.review.evidence) || [];
  const dir = x.dir || '';
  const sec = x.section || '';
  const topic = x.topic || '';
  const when = Array.isArray(x.when) ? x.when.filter(Boolean) : [];
  const raw = String(x.sum || x.text || '').slice(0, 140);
  const isTopic = x.rkind === 'topic';
  const lv = topicLevelOf(x);
  const delAsk = S.review.delAsk === x.id;
  return `<div class="pact review-card rv-${esc(st)}">
    <div class="pact-top">
      <span class="badge${locked ? '' : ' badge-blue'}">${rvStateName(st)}</span>
      <span class="badge">${esc(RV_KIND[x.rkind] || x.rkind || '')}</span>
      ${isTopic ? `<span class="badge">${esc(({ single: '单人话题', group: '群话题', common: '通用话题' })[lv] || '通用话题')}</span>` : ''}
      ${dir ? `<span class="badge" title="方向归属（教学条）">方向·${esc(dir)}</span>` : ''}
      ${sec ? `<span class="badge" title="约定分区归属">分区·${esc(sec)}</span>` : ''}
      ${topic && !isTopic ? (() => {
        /* 约定上的名字按号去人物表取（2026-11-21 主人：「名字跟随人物表，而不是新表」）。
         * 标签串只是落盘时的快照；人物表里改了名，这里跟着变。点一下去朋友录里这个人。 */
        const pm = /^跟(.+)的约定$/.exec(String(topic));
        const nm = x.owner || '';
        if (x.rkind === 'promise' && pm && nm) {
          return x.pid
            ? `<span class="badge badge-blue is-link" data-act="chat-person-goto" data-pid="${esc(x.pid)}" title="名字来自人物表 · 点一下去朋友录里看他">跟${esc(nm)}的约定</span>`
            : `<span class="badge badge-blue" title="名字来自人物表">跟${esc(nm)}的约定</span>`;
        }
        return `<span class="badge badge-blue" title="话题归属（主人手动判的）">话题·${esc(topic)}</span>`;
      })() : ''}
      <span class="pact-who">${esc(x.whoName || x.nick || x.qq || '未署名')}</span>
      <span class="small dim pact-time">${esc(fmtTime(x.t))}</span>
    </div>
    ${x.say ? `<div class="pact-say" title="要原样说出口的话">${esc(x.say)}</div>` : ''}
    ${raw ? `<div class="pact-raw">${esc(raw)}</div>` : ''}
    ${when.length ? `<div class="pact-when">触发：${esc(when.slice(0, 4).join(' / '))}</div>` : ''}
    ${x.rkind === 'teach' ? (() => {
      const ax = axisOfRow(x);
      return `<div class="pact-when">生效轴：
        <button class="chip${ax.retrieval ? ' is-on' : ''}" data-act="teach-axis" data-id="${esc(x.id)}" data-f="retrieval" data-on="${ax.retrieval ? '1' : '0'}">检索式命中${ax.retrieval ? ' ✓' : ''}</button>
        <button class="chip${ax.present ? ' is-on' : ''}" data-act="teach-axis" data-id="${esc(x.id)}" data-f="present" data-on="${ax.present ? '1' : '0'}">在场就用${ax.present ? ' ✓' : ''}</button>
      </div>`;
    })() : ''}
    ${isTopic ? (() => {
      const lvs = topicLevelsOf(x);
      const parts = Array.isArray(x.participants) ? x.participants : [];
      const ttl = String(x.ttl || 'short');
      const LVN = { single: '单人', group: '群', common: '通用' };
      return `<div class="pact-when">话题级别（能多选：单人 / 群 / 通用可以重合）：
        ${['single', 'group', 'common'].map(k => `<button class="chip${lvs.indexOf(k) >= 0 ? ' is-on' : ''}" data-act="topic-level" data-id="${esc(x.id)}" data-lv="${k}"${locked ? ' disabled' : ''}>${LVN[k]}</button>`).join('')}
        <button class="chip${ttl === 'long' ? ' is-on' : ''}" data-act="topic-ttl" data-id="${esc(x.id)}" data-v="${ttl === 'long' ? 'short' : 'long'}"${locked ? ' disabled' : ''}>${ttl === 'long' ? '长期（不过期）' : '短期（按条数过期）'}</button>
        ${x.expired ? '<span class="small dim">已过期：不注入，改成长期能恢复</span>' : ''}
      </div>
      <div class="pact-when">参与人：
        ${parts.length ? parts.map(pp => `<span class="badge">${esc(pp.name || pp.key)}<button class="chip" data-act="topic-part-del" data-id="${esc(x.id)}" data-key="${esc(pp.key)}" title="取消这个人的参与"${locked ? ' disabled' : ''}>×</button></span>`).join('') : '<span class="small dim">没记参与人（老条目）</span>'}
        <span class="small dim">话题在记录那刻属于所有参与的人；判错的点 × 取消</span>
      </div>`;
    })() : ''}
    ${x.rkind === 'alias' ? (() => {
      /* 代称卡（主人 2026-11-13）：「没显示全我的QQ？只需要和「朋友录」的对应就可以了。」
       * 账号行跟朋友录一模一样（QQ 1000000002 · QQ 1000000005 · B站 30895294）；
       * 称呼行把名字和代称摆在同一条线上，第一个就是名字。 */
      const acc = (x.accounts || []).map(a => plab(a.platform) + ' ' + a.id).join(' · ') || '（没有账号）';
      const list = String(x.text || '').split('、').filter(Boolean);
      return `<div class="pact-note">账号：${esc(acc)}</div>
        <div class="pact-note">名字：<b>${esc(x.name || list[0] || '（还没写）')}</b>　代称：${esc(list.slice(1).join('、') || '（还没有）')}</div>`;
    })() : ''}
    ${x.scope ? `<div class="pact-note">场合：${esc(x.scope)}${x.credit === 'deny' ? ' · 作者拒绝公开署名' : ''}</div>` : ''}
    ${ev.length ? `<div class="rv-ev"><div class="rv-ev-h">附带的 ${ev.length} 条原记录（确认后只删这份快照，聊天原始日志不动）</div>
      ${ev.map(e => `<div class="rv-ev-row"><span class="mono dim">${esc(e.line)}</span> ${esc(e.who || '')}：${esc(String(e.text || '').slice(0, 80))}</div>`).join('')}</div>` : ''}
    <div class="rv-btns">
      <button class="btn btn-quiet" data-act="review-open" data-id="${esc(x.id)}">查看 / 改</button>
      ${ev.length ? '' : `<button class="btn btn-quiet" data-act="review-evidence" data-id="${esc(x.id)}">找 5 条原记录</button>`}
      ${locked ? '<span class="small dim">已锁定，AI 和助手都不许删改</span>'
        : `<button class="btn btn-primary" data-act="review-confirm" data-id="${esc(x.id)}">确认并锁定</button>
        <button class="btn btn-quiet${delAsk ? ' btn-danger' : ''}" data-act="review-del" data-id="${esc(x.id)}" title="单条删除，点两下确认">${delAsk ? '真的删？' : '删'}</button>`}
    </div>
  </div>`;
}

/* 共用的复核弹层：改归属 / 改内容 / 改方向 / 判成漏记的教学或约定分支。
 * 话题的「私密 / 公开」主人 2026-11-13 已废（「那条没意义」），这里不再给这个下拉。 */
function htmlReviewModal() {
  const x = S.review.open;
  if (!x) return '';
  const locked = (x.state || 'legacy') === 'locked';
  const dirs = (S.review.dirs.length ? S.review.dirs : ['游戏攻略', '情绪表达', '梗词句']);
  const secs = (S.review.sections.length ? S.review.sections : ['说话方式', '身份认知', '情绪认知与应对', '禁止回复', '常态情绪', '代称']);
  const ev = (x.review && x.review.evidence) || [];
  const dirOpts = dirs.map(d => `<option value="${esc(d)}"${x.dir === d ? ' selected' : ''}>${esc(d)}</option>`).join('');
  const secOpts = secs.map(s => `<option value="${esc(s)}"${x.section === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
  /* 二级目录选（主人 2026-11-13：「做成二级目录选，不要所有选项摆一页」）：
   * 一级只选「教学知识 / 约定 / 话题」，二级才出对应的方向或分区。 */
  const cur = x._type || (x.rkind === 'teach' ? 'teach' : (x.rkind === 'promise' ? 'promise' : 'topic'));
  const subOpts = cur === 'teach' ? dirOpts
    : (cur === 'promise' ? secOpts : '<option value="">（话题不分二级）</option>');
  return `<div class="modal-veil"><div class="modal-card rv-modal">
    <h3>${esc(RV_KIND[x.rkind] || '')} · ${rvStateName(x.state || 'legacy')}</h3>
    ${locked ? '<div class="empty">这条你已经确认锁定了。虚幻 AI 和助手都不许删改，只有原作者本人改口才会删旧条、生成新的一条重走复核。</div>' : (x.rkind === 'alias' ? `
      <label>账号（跟「朋友录」一样，几个号都列出来）</label>
      <div class="small dim" style="margin-bottom:6px">${esc((x.accounts || []).map(a => plab(a.platform) + ' ' + a.id).join(' · ') || '（没有账号）')}</div>
      <label>名字、代称（同一行，第一个是名字）</label>
      <input class="field" id="rv-text" value="${esc(x.text || '')}">
      <div class="small dim">顿号隔开就行。第一个当名字，后面全是代称；只有代称时，第一个代称就当名字。虚幻喊人优先第一个，偶尔喊代称。</div>
    ` : `
      <label>归属（教学者 id 署名，可重新判断）</label>
      <input class="field mono" id="rv-qq" value="${esc(x.qq || '')}" placeholder="qq:1000000002">
      <label>场合（不出群）</label>
      <input class="field" id="rv-scope" value="${esc(x.scope || '')}" placeholder="群143620228 / 私聊">
      <label>归属（一级选类，二级选方向 / 分区）</label>
      <div class="pact-bar" style="margin:0 0 8px">
        <select class="field" id="rv-type" data-act="rv-type" style="width:44%">
          <option value="teach"${cur === 'teach' ? ' selected' : ''}>教学知识</option>
          <option value="promise"${cur === 'promise' ? ' selected' : ''}>约定</option>
          <option value="topic"${cur === 'topic' ? ' selected' : ''}>话题</option>
        </select>
        <select class="field" id="rv-sub" style="width:52%">${subOpts}</select>
      </div>
      <label>要原样回的话</label>
      <input class="field" id="rv-say" value="${esc(x.say || '')}">
      <label>触发词（逗号分隔）</label>
      <input class="field" id="rv-when" value="${esc((x.when || []).join('，'))}">
      <label>内容 / 原话</label>
      <textarea class="field" id="rv-text" rows="3">${esc(x.text || '')}</textarea>
    `)}
    <div class="rv-ev-h">附带的原记录（确认后删快照）</div>
    ${ev.length ? ev.map(e => `<div class="rv-ev-row"><span class="mono dim">${esc(e.line)}</span> ${esc(e.who || '')}：${esc(String(e.text || '').slice(0, 90))}</div>`).join('')
      : '<div class="small dim">还没取。点「找 5 条原记录」从聊天日志按时间/场合/触发词抓同群前后 5 行。</div>'}
    <div class="modal-btns">
      ${locked ? '' : `<button class="btn btn-quiet" data-act="review-evidence" data-id="${esc(x.id)}">找 5 条原记录</button>
        <button class="btn btn-primary" data-act="review-save" data-id="${esc(x.id)}">保存</button>
        <button class="btn btn-primary" data-act="review-confirm" data-id="${esc(x.id)}">确认并锁定</button>
        <button class="btn btn-quiet" data-act="review-del" data-id="${esc(x.id)}">删掉</button>`}
      <button class="btn btn-quiet" data-act="review-close">关掉</button>
    </div>
  </div></div>`;
}

/* 一个人的喜恶六节（之前只在好感度页只读展示，这里能加、能改文字、能换节、能删）。 */
function htmlTasteRows(p) {
  const secs = p.taste || [];
  const bySec = {}; secs.forEach(s => { bySec[s.sec] = s; });
  return `<div style="grid-column:1/-1"><label>人物喜好厌恶（六节，可改 / 可换节 / 可删）</label>
    ${TASTE_SECS.map(([sec, label]) => {
      const items = (bySec[sec] || {}).items || [];
      return `<div class="rv-taste-sec"><div class="rv-taste-h">${esc(label)} <span class="dim">${items.length} 条</span>
        <button class="btn btn-quiet" data-act="taste-add" data-pid="${esc(p.pid)}" data-sec="${esc(sec)}">+ 加一条</button></div>
        ${items.length ? items.map(i => `<div class="rv-taste-row">
          <span class="grow">${esc(i.t)}</span>
          <select class="field rv-taste-sel" data-act="taste-move" data-pid="${esc(p.pid)}" data-sec="${esc(sec)}" data-old="${esc(i.t)}">
            ${TASTE_SECS.map(([s2, l2]) => `<option value="${esc(s2)}"${s2 === sec ? ' selected' : ''}>${esc(l2)}</option>`).join('')}
          </select>
          <button class="btn btn-quiet" data-act="taste-edit" data-pid="${esc(p.pid)}" data-sec="${esc(sec)}" data-old="${esc(i.t)}">改</button>
          <button class="btn btn-quiet" data-act="taste-del" data-pid="${esc(p.pid)}" data-sec="${esc(sec)}" data-old="${esc(i.t)}">删</button>
        </div>`).join('') : '<div class="small dim">（空）</div>'}
      </div>`;
    }).join('')}</div>`;
}
function htmlTasteModal() {
  const e = S.friends.tasteEdit;
  if (!e) return '';
  return `<div class="modal-veil"><div class="modal-card">
    <h3>${e.isNew ? '加一条喜恶' : '改这条喜恶'}</h3>
    <label>内容</label>
    <input class="field" id="tt-text" value="${esc(e.text || '')}">
    <div class="modal-btns">
      <button class="btn btn-primary" data-act="taste-save">保存</button>
      <button class="btn btn-quiet" data-act="taste-close">关掉</button>
    </div>
  </div></div>`;
}

function htmlFriendRow(p) {
  const open = S.openPerson === p.pid;
  const v = Number(p.favor) || 0;
  const qq = String(p.qq || '');
  const accounts = p.accounts || [];
  const accText = accounts.map(a => plab(a.platform) + ' ' + a.id).join(' · ');
  const pacts = p.pacts || [];
  const aliasSt = (p.aliasReview || {}).state || 'legacy';
  const detail = open ? `<div class="detail">
    <div style="grid-column:1/-1"><label>真名（本人承认的名字，喊人优先用它）</label>
      <input class="field" data-pf="name" data-pid="${esc(p.pid)}" value="${esc(p.name || '')}" placeholder="空着就喊当前可见名">
      <div class="small dim">真名只有本人承认 / 你确认才写。资料卡、群名片、平台名、别人喊的、曾用名都自动算「代称」——<b>代称只用来认人，不拿来喊</b>；喊人用真名 → 当前可见名。</div>
      <div class="small dim">现在的代称（自动收集）：${(p.names || []).slice(1).length ? esc((p.names || []).slice(1).join('、')) : '（还没有）'}</div>
      <div class="form-row" style="margin-top:6px"><input class="field" data-pf="masterCall" data-pid="${esc(p.pid)}" value="${esc(p.masterCall || '')}" placeholder="你怎么喊他（例：大萌新）">
        <span class="small dim">主人称呼方式：注入里「昵称」就是它，虚幻跟着喊</span></div>
      <div class="form-row" style="margin-top:6px"><input class="field" data-pf="alias" data-pid="${esc(p.pid)}" value="${esc(p.alias || '')}" placeholder="别人喊过他的名字（顿号隔开）"${aliasSt === 'locked' ? ' disabled' : ''}>
        <button class="btn btn-quiet" data-act="alias-confirm" data-pid="${esc(p.pid)}"${aliasSt === 'locked' ? ' disabled' : ''}>确认锁定代称</button>
        ${aliasSt === 'locked' ? `<button class="btn btn-quiet" data-act="alias-unlock" data-pid="${esc(p.pid)}">解锁</button>` : ''}</div>
      <div class="small dim">${aliasSt === 'locked' ? '代称已确认锁定，不许改。' : '这里只记「别人喊他的名」；群名片/资料卡/平台名/曾用名会自动当代称，不用手填。'}</div></div>
    <div><label>身份（身份就是称呼）</label>
      ${(p.role === 'master' || p.role === 'onii' || p.role === 'friend')
        ? `<div class="small dim" style="padding:6px 0">${esc(p.roleLabel || '')}${p.role === 'friend' ? '（在朋友录里：好感 > 20；要移出就把好感调到 20 以下）' : '（按号认出来的，不在这里改）'}</div>`
        : `<select class="field" data-pf="role" data-pid="${esc(p.pid)}">
            <option value="known"${p.role === 'known' ? ' selected' : ''}>认识的人（人物册）</option>
            <option value="stranger"${p.role === 'stranger' ? ' selected' : ''}>陌生人（第一次来的）</option>
          </select>`}
      <div class="small dim">主人 / 欧尼酱 按号认；朋友 = 在朋友录里（好感 &gt; 20）；认识的人 = 在人物册里。</div></div>
    <div><label>性别</label>
      <select class="field" data-pf="sex" data-pid="${esc(p.pid)}">
        <option value="female"${p.sex === 'female' ? ' selected' : ''}>女</option>
        <option value="male"${p.sex === 'male' ? ' selected' : ''}>男</option>
      </select>
      <div class="small dim">AI 全是女、主人是女，其他人先默认男（${esc(p.sexSrcLabel || '猜的')}）；对话里发现是女会自动改成女。</div></div>
    <div><label>资料卡名（QQ 上的真实昵称，自动同步）</label><input class="field" data-pf="nick" data-pid="${esc(p.pid)}" value="${esc(p.nick || '')}"></div>
    <div><label>所在地（地区表 · 按这个人记，查天气用）</label>
      <div class="form-row"><input class="field" data-region-pid="${esc(p.pid)}" value="${esc(p.region || '')}" placeholder="有多细填多细，例如 西安市 未央区；留空=清掉">
        <button class="btn btn-quiet" data-act="save-region" data-pid="${esc(p.pid)}">保存地区</button></div>
      <div class="small dim">图上写的「登陆地点：西安市 未央区」、他自己说住哪，AI 也会自动记并私信告诉你</div></div>
    <div><label>好感度（0~100，&gt;20 进朋友录，≤20 进人物册）</label>
      <div class="form-row"><input class="field mono" data-pf="favor" data-pid="${esc(p.pid)}" value="${v}" inputmode="numeric" style="width:80px">
        <button class="btn btn-primary" data-act="save-person" data-pid="${esc(p.pid)}">保存</button>
        <button class="btn btn-quiet" data-act="favor-lock" data-pid="${esc(p.pid)}" data-on="${p.favorLock ? '0' : '1'}">${p.favorLock ? '解锁好感' : '锁定好感'}</button>
        ${p.role === 'friend'
          ? `<button class="btn btn-quiet" data-act="out-friend" data-pid="${esc(p.pid)}" title="好感降到 20，回到人物册（身份跟着变）">移出朋友录</button>`
          : `<button class="btn btn-quiet" data-act="to-friend" data-pid="${esc(p.pid)}" title="好感调到 21，进朋友录（身份跟着变）">加入朋友录</button>`}</div>
      <div class="small dim">${p.favorLock ? '已锁定：群里夸她、衰减结算都改不动；面板手动改仍可（删人物前先看一眼）' : '未锁定：群里的加分和衰减会改它'}</div></div>
    <div style="grid-column:1/-1"><label>平台账号（${accounts.length} 个，可加可删，AI 按这张表认人）</label>
      <div class="acc-list">${accounts.length ? accounts.map(a => `<span class="badge">${esc(plab(a.platform))} ${esc(a.id)}
        <button class="chip" data-act="rm-acc" data-pid="${esc(p.pid)}" data-plat="${esc(a.platform)}" data-aid="${esc(a.id)}" title="从这个人名下移掉这个号">×</button></span>`).join('')
        : '<span class="small dim">（还没有账号）</span>'}</div>
      <div class="form-row" style="margin-top:6px">
        <select class="field" id="ap-plat-${esc(p.pid)}" style="width:130px">
          ${platTable().map(x => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('')}
        </select>
        <input class="field mono" id="ap-id-${esc(p.pid)}" placeholder="账号 / UID" style="width:190px">
        <button class="btn btn-quiet" data-act="add-acc" data-pid="${esc(p.pid)}">加账号</button>
      </div>
      <div class="form-row" style="margin-top:6px">
        <select class="field" id="mg-${esc(p.pid)}" style="width:240px">
          <option value="">— 把另一个人合并进来 —</option>
          ${(S.friends.list || []).filter(x => String(x.pid) !== String(p.pid)).map(x => `<option value="${esc(x.pid)}">${esc(x.label || x.name || x.pid)}</option>`).join('')}
        </select>
        <button class="btn btn-quiet" data-act="merge-into" data-pid="${esc(p.pid)}">合并</button>
      </div>
      <div class="small dim">合并会把对方的账号搬过来、好感相加（封顶 100），名字保留这个人的。同一张人物表，不另存一份。</div>
    </div>
    <div style="grid-column:1/-1"><label>AI 标记</label>
      <div class="small dim">名字带关键词的账号会自动标成 AI（判到会私信告诉你）。标成 AI 只建档、不记任何画像、好感恒 0。误判就移除。</div>
      <div class="form-row" style="margin-top:6px">
        ${p.isAI
          ? `<button class="btn btn-quiet" data-act="ai-unmark" data-pid="${esc(p.pid)}">移除 AI（改回人物）</button>`
          : `<button class="btn btn-quiet" data-act="ai-mark" data-pid="${esc(p.pid)}">标记 AI</button>`}
      </div></div>
    <div style="grid-column:1/-1"><label>删掉这个人（不可撤销）</label>
      <div class="small dim">人物、好感、喜好厌恶、事实、代称、跟他的约定和话题一起删；记录的知识和署名保留。</div>
      <button class="btn btn-danger" data-act="person-purge-open" data-pid="${esc(p.pid)}" style="margin-top:6px">删除这个人的全部数据</button></div>
    ${p.isMaster ? htmlRelationBlock(p) : htmlTasteRows(p)}
    ${(p.facts || []).length ? `<div style="grid-column:1/-1"><label>长期记忆里的事实</label>
      <div class="small dim">${p.facts.map(f => '· ' + esc(f)).join('<br>')}</div></div>` : ''}
    ${(() => { const rv = reviewOf('alias:' + p.pid); return rv ? `<div style="grid-column:1/-1"><label>约定 · 代称（和另外三类走同一套复核）</label>${htmlReviewCard(rv)}</div>` : ''; })()}
    <div style="grid-column:1/-1"><label>跟这个人的约定（${pacts.length} 条，可重新判断归属 / 改内容 / 确认锁定）</label>
      ${pacts.length ? pacts.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">（还没有约定）</div>'}</div>
    ${(() => {
      // 话题进朋友录（2026-11-13 主人令）：跟这个人有关的话题和约定一样两页都能看到，
      // 三级（单人 / 群 / 通用）在卡片上直接改。
      const bare = s => String(s || '').replace(/^[a-z]+:/, '');
      const ids = new Set((p.accounts || []).map(a => String(a.id)));
      const tp = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped' && !x.parent
        && (String(x.pid || '') === p.pid || ids.has(bare(x.qq))));
      return `<div style="grid-column:1/-1"><label>跟这个人的话题（${tp.length} 条，可改级别 / 换归属）</label>
        ${tp.length ? tp.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">（还没有话题）</div>'}</div>`;
    })()}
  </div>` : '';
  return `<div>
    <div class="row friend-row" data-act="friend-row" data-pid="${esc(p.pid)}" style="cursor:pointer">
      <span class="friend-av" data-act="friend-open" data-pid="${esc(p.pid)}"${qq ? ` style="--conv-avatar:url('xuh://avatar/qq/${esc(qq)}')"` : ''}></span>
      <span class="grow trunc">${esc(p.label || p.name || '（没名字）')}
        ${p.isMaster ? '<span class="badge badge-blue">主人</span>' : ''}
        ${p.roleLabel ? `<span class="badge" title="身份就是称呼">${esc(p.roleLabel)}</span>` : ''}
        ${p.sexLabel ? `<span class="badge" title="AI 女、主人女、其他人默认男">${esc(p.sexLabel)}</span>` : ''}
        ${p.isAI ? `<span class="badge" style="background:#ffe3e3;color:#c0392b" title="已标为 AI：只建档、不记任何画像、好感恒 0">AI</span>` : ''}
        ${p.alias ? `<span class="small dim">（${esc(p.alias)}）</span>` : ''}
        <span class="small dim mono" style="margin-left:8px">${esc(accText)}</span>
        ${pacts.length ? `<span class="small dim"> · ${num(pacts.length)} 条约定</span>` : ''}</span>
      <span class="bar${v < 0 ? ' is-neg' : ''}"><i style="width:${Math.min(100, Math.abs(v))}%"></i></span>
      <span class="favor-v">${v}</span>
    </div>${detail}</div>`;
}

/* 我的口味（主人＝虚幻共用这一份，2026-11-13 主人令「我的喜好表里有几行喜欢的内容，你没接入」）。
 * 「喜欢的人」另放一块：按人物各记各的，和口味不共用（她原话：「我们喜欢的人不共用」）。 */
/* 我的口味（主人＝虚幻共用这一份）。
 * 2026-11-13 改七栏：特别·喜欢 / 喜欢（确定）/ 喜欢（可能）/ 中立 / 讨厌（确定）/ 讨厌（可能）/ 特别·讨厌。
 * 「可能 / 中立」量大，机器人平时不注入，只在她问的时候展开——这页照样全给，她要看全的。
 * 栏可以拖动换位置（顺序存 data/喜好参数.json，正文行序不动）；参数也在这页调；锁只有她能开。 */
function htmlMyTaste() {
  const m = S.friends.mine;
  if (!m) return '';
  const cols = (m.cols || []).map(c => ({ key: c.key, label: c.label }));
  const cfg = m.cfg || {};
  const show = cfg.show || {};
  const locked = !!cfg.locked;
  const row = c => {
    const arr = m[c.key] || [];
    return `<div class="my-taste-row" draggable="true" data-act="mine-col" data-sec="${esc(c.key)}" title="拖这一行可以换位置">
      <span class="my-taste-h">${esc(c.label)}<span class="small dim"> ${num(arr.length)}</span></span>
      <span class="my-taste-words">${arr.length
        ? arr.map(t => `<button class="my-word" draggable="true" data-act="mine-word" data-sec="${esc(c.key)}" data-t="${esc(t)}" title="拖动能换位置；点一下改 / 删 / 换栏">${esc(t)}</button>`).join('')
        : '<span class="small dim">（空）</span>'}</span>
      <button class="btn btn-quiet" data-act="mine-add" data-sec="${esc(c.key)}">+ 加一条</button>
    </div>`;
  };
  const persons = m.persons || [];
  return `<div class="sheet"><div class="sheet-head"><h2>我的口味 · 我和虚幻共用这一份</h2>
    <span class="hint">写在 soul/段/0-我的喜好.md；拖左边那栏能换位置。${locked ? ' <b>已上锁</b>：自动抽取和脚本都改不动，只有你在这页能改。' : ''}</span>
    <button class="btn ${locked ? 'btn-quiet' : 'btn-primary'}" data-act="mine-lock" data-on="${locked ? '0' : '1'}">${locked ? '解锁喜好表' : '给喜好表上锁'}</button></div>
    <div class="sheet-body">
      ${cols.map(row).join('')}
      <div class="my-taste-row is-plain">
        <span class="my-taste-h">注入参数</span>
        <span class="my-taste-words">
          <label class="small">确定栏最多给 <input class="field mono" data-cfg="confLimit" value="${num(show.confLimit || 12)}" style="width:60px" inputmode="numeric"></label>
          <label class="small">问起来展开 <input class="field mono" data-cfg="askLimit" value="${num(show.askLimit || 60)}" style="width:60px" inputmode="numeric"></label>
          <label class="small"><input type="checkbox" data-cfg="showGuess"${show.showGuess ? ' checked' : ''}> 平时也给「可能」</label>
          <label class="small"><input type="checkbox" data-cfg="showNeutral"${show.showNeutral ? ' checked' : ''}> 平时也给「中立」</label>
          <button class="btn btn-quiet" data-act="mine-cfg-save">存参数</button>
        </span>
      </div>
      ${persons.length ? `<div class="my-taste-row"><span class="my-taste-h">我喜欢的人</span>
        <span class="my-taste-words">${persons.map(x => `<span class="my-word is-plain" title="${esc(x.from || '')}">${esc(x.t)}</span>`).join('')}</span>
        <span class="small dim">按人物各记各的，不共用</span></div>` : ''}
    </div></div>`;
}
/* 喜 / 无感 / 厌 人物表（主人 2026-11-13）：只从当前人物表里选，无感默认隐藏。
 * 这是「谁看谁」，跟口味表是两回事；主人自己的表不进虚幻的提示词。 */
function htmlRelationBlock(p) {
  const acc = (p.accounts || [])[0];
  const key = acc ? (String(acc.platform || 'qq') + ':' + String(acc.id)) : '';
  const r = key ? (S.friends.rel || {})[key] : null;
  const showN = !!S.friends.relShowNeutral;
  const cell = (list, st, label) => (list && list.length ? `<div class="rel-row"><span class="badge">${esc(label)} ${num(list.length)}</span>
    ${list.map(x => `<span class="my-word is-plain" title="${esc(x.name)}${x.n ? ' · 共同话题 ' + num(x.n) : ''}${x.why ? ' · ' + esc(x.why) : ''}">
      ${esc(x.name)}<button class="chip" data-act="rel-set" data-a="${esc(key)}" data-b="${esc(x.key)}" data-s="neutral" title="改成无感">×</button></span>`).join('')}</div>`
    : `<div class="small dim">${esc(label)}：空</div>`);
  if (!r) {
    return `<div style="grid-column:1/-1"><label>喜 / 无感 / 厌 人物表</label>
      <div class="small dim">还没读。点下面按钮读出这个人对其他人的态度（无感默认不显示）。</div>
      <button class="btn btn-quiet" data-act="rel-load" data-who="${esc(key)}">读关系表</button></div>`;
  }
  return `<div style="grid-column:1/-1"><label>喜 / 无感 / 厌 人物表（他对别人）</label>
    ${cell(r.like, 'like', '喜')}${cell(r.hate, 'hate', '厌')}
    <button class="btn btn-quiet" data-act="rel-toggle-neutral">${showN ? '收起无感' : '显示无感（默认隐藏）'}</button>
    ${showN ? cell(r.neutral, 'neutral', '无感') : ''}
    <div class="small dim" title="共同话题过 2 条自动变喜；辱骂：非喜→厌，喜→降无感并清零重新计话题数、攒到阈值才升回；厌因共同话题升级只到无感，不当场升喜。这里也能手动改。">ⓘ 规则</div></div>`;
}
function htmlMineModal() {
  const e = S.friends.mineEdit;
  if (!e) return '';
  const SECN = { like: '喜欢', hate: '讨厌', pending: '还没表态' };
  return `<div class="modal-veil"><div class="modal-card">
    <h3>${e.isNew ? '加一条' + SECN[e.sec] : '改这条' + SECN[e.sec]}</h3>
    <label>内容</label>
    <input class="field" id="mt-text" value="${esc(e.text || '')}">
    ${e.isNew ? '' : `<label>换到哪一行</label>
      <select class="field" id="mt-sec">${Object.keys(SECN).map(k => `<option value="${k}"${e.sec === k ? ' selected' : ''}>${SECN[k]}</option>`).join('')}</select>`}
    <div class="modal-btns">
      <button class="btn btn-primary" data-act="mine-save">保存</button>
      ${e.isNew ? '' : '<button class="btn btn-danger" data-act="mine-del">删掉这条</button>'}
      <button class="btn btn-quiet" data-act="mine-close">关掉</button>
    </div>
  </div></div>`;
}
/* 话题块：三级（单人 / 群 / 通用）+ 按群分类总开关。
 * 注入口径：单人 = 本人在场就给（群里他说 / 他私聊你都给）；群 = 只在该群；通用 = 哪儿都给。 */
function topicLevelsOf(x) {
  if (x && Array.isArray(x.levels) && x.levels.length) return x.levels;
  const lv = topicLevelOf(x);
  return lv ? [lv] : [];
}
function topicLevelOf(x) {
  // 和 core.levelsOfParts 同一口径：有群号=群话题，私聊/只挂人=单人，都没挂=通用
  if (x.levels && x.levels.length) return x.levels[0];
  if (x.level) return x.level;
  const s = String(x.scope || '');
  if (!s) return x.qq ? 'single' : 'common';
  if (/私聊|private/.test(s)) return 'single';
  if (/群\s*\d+/.test(s)) return 'group';
  return x.qq ? 'single' : 'common';
}
function htmlTopicCards(list, title, hint) {
  if (!list.length) return '';
  return `<div class="sheet"><div class="sheet-head"><h2>${esc(title)}（${num(list.length)} 条）</h2>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>
    <div class="sheet-body">${list.map(htmlReviewCard).join('')}</div></div>`;
}
/* 话题入口（主人 2026-11-13 ①）：内嵌长列表改成「一个图形入口 + 悬浮卡」。
 * 含义全进 title，页面不堆说明文字；同类只留这一个入口。 */
function htmlTopicEntryCard(v, n, title) {
  return `<div class="sheet"><div class="sheet-head"><h2>话题</h2></div>
    <div class="sheet-body" style="display:flex;align-items:center;gap:10px">
      ${floatBtn(v, title, true)}<span class="small dim">${num(n)} 条</span>
    </div></div>`;
}
function htmlTopicsBlock(zone, q) {
  const F = S.friends;
  const all = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped' && !x.parent);
  const hit = q ? all.filter(x => (String(x.text || '') + ' ' + String(x.sum || '') + ' ' + String(x.whoName || x.who || '')).toLowerCase().indexOf(q) >= 0) : all;
  const single = hit.filter(x => topicLevelOf(x) === 'single');
  const group = hit.filter(x => topicLevelOf(x) === 'group');
  const common = hit.filter(x => topicLevelOf(x) === 'common');
  if (zone === 'common') return htmlTopicCards(common, '通用话题', '不挂人、不挂群，哪儿都能用');
  // 「全部」页只摆最近的几条（392 条全画出来会卡）；点「全部话题」再看全量。
  const cap = zone === 'all' ? 6 : 0;
  const cut = arr => (cap && arr.length > cap) ? arr.slice(-cap) : arr;
  const more = (cap && hit.length > cap) ? `<div class="small dim" style="padding:6px 2px">这里只摆最近 ${cap} 条（共 ${num(hit.length)} 条），全部话题在顶上「全部话题」里看。</div>` : '';
  const bar = `<div class="pact-bar" style="margin:0 0 10px">
    <span class="small dim">按群分类</span>
    <button class="chip${F.groupBy ? ' is-on' : ''}" data-act="friend-groupby" data-v="${F.groupBy ? '0' : '1'}">${F.groupBy ? '开' : '关'}</button>
    <span class="small dim">单人 ${num(single.length)} · 群 ${num(group.length)} · 通用 ${num(common.length)}</span>
  </div>`;
  if (!F.groupBy) {
    return bar + htmlTopicCards(cut(single), '单人话题', '只在私聊 / 只对他本人时用')
      + htmlTopicCards(cut(group), '群话题', '只在那一个群里注入')
      + htmlTopicCards(cut(common), '通用话题', '不挂人、不挂群，哪儿都能用') + more;
  }
  // 按群分类：同一个群号下的群话题 + 属于该群成员的单人话题摆一起；私聊 / 通用各占一块
  const byScope = new Map();
  for (const x of (cap ? hit.slice(-80) : hit)) {
    const s = String(x.scope || '').trim() || '（没写场合 · 通用）';
    if (!byScope.has(s)) byScope.set(s, []);
    byScope.get(s).push(x);
  }
  const order = [...byScope.keys()].sort((a, b) => (a.indexOf('（') === 0 ? 1 : 0) - (b.indexOf('（') === 0 ? 1 : 0) || a.localeCompare(b, 'zh'));
  return bar + order.map(s => {
    const list = byScope.get(s);
    const nS = list.filter(x => topicLevelOf(x) === 'single').length;
    const nG = list.filter(x => topicLevelOf(x) === 'group').length;
    const nC = list.length - nS - nG;
    return `<div class="sheet"><div class="sheet-head"><h2>${esc(s)}（${num(list.length)} 条 · 单人 ${num(nS)} / 群 ${num(nG)} / 通用 ${num(nC)}）</h2></div>
      <div class="sheet-body">${cut(list).map(htmlReviewCard).join('')}</div></div>`;
  }).join('') + more;
}

/* 群聊人物列表（主人 ①「我有合并的账号人物表 / 群聊人物列表 / 吗？以后直接读表，不要另补」）。
 * 这一页不建任何新数据源：群号直接取 people.json 里每个账号的群名片 cards 的键，
 * 同一个人多个号（合并过的）都归到同一行，全部账号一次显示全，别的号改了也照样认得出。
 * 悬浮 / 多级：一个群一个折叠，无关闭键；点名字跳回朋友录展开改。 */
function htmlFriendGroups(all, q) {
  const byG = new Map();
  for (const p of all) {
    if (q && (String(p.label || '') + ' ' + String(p.name || '') + ' '
      + (p.accounts || []).map(a => String(a.id) + ' ' + Object.keys(a.cards || {}).map(g => a.cards[g]).join(' ')).join(' ')
    ).toLowerCase().indexOf(q) < 0) continue;
    const gids = new Set();
    for (const a of (p.accounts || [])) for (const g of Object.keys(a.cards || {})) {
      if (a.cards[g]) gids.add(String(g));
    }
    for (const g of gids) {
      if (!byG.has(g)) byG.set(g, []);
      byG.get(g).push(p);
    }
  }
  const keys = [...byG.keys()].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
  if (!keys.length) return `<div class="sheet"><div class="sheet-head"><h2>群聊人物列表</h2></div>
    <div class="sheet-body"><div class="empty">人物表里还没有带群名片的群。群里有人说过话、记下群名片后，这里会自动按群列出来（数据直接读人物表，不另存一份）。</div></div></div>`;
  const row = (p, g) => {
    const cards = [];
    for (const a of (p.accounts || [])) {
      const c = (a.cards || {})[g];
      if (c) cards.push(`群 ${esc(g)} 名片「${esc(c)}」· ${esc(plab(a.platform))} ${esc(a.id)}`);
    }
    const accText = (p.accounts || []).map(a => esc(plab(a.platform)) + ' ' + esc(a.id)).join(' · ') || '（没有账号）';
    const nAcc = (p.accounts || []).length;
    const merged = nAcc > 1 ? ` <span class="badge" title="合并过的账号：${num(nAcc)} 个号都认这一个人，后续改任一号也照样认得出">⧉ ${num(nAcc)} 号</span>` : '';
    const v = Number(p.favor) || 0;
    return `<div><div class="row friend-row" style="cursor:pointer" data-act="friend-group-open" data-pid="${esc(p.pid)}"
        title="跳回朋友录展开这个人：改名字 / 加号 / 删号 / 合并账号">
      <span class="grow trunc">${esc(p.label || p.name || '（没名字）')}${merged}
        ${p.isMaster ? '<span class="badge badge-blue">主人</span>' : ''}</span>
      <span class="small dim mono">${accText}</span>
      <span class="bar${v < 0 ? ' is-neg' : ''}"><i style="width:${Math.min(100, Math.abs(v))}%"></i></span>
      <span class="favor-v">${v}</span></div>
      <div class="small dim" style="padding:0 2px 6px 10px">${cards.length ? cards.join('　/　') : '这个群没记群名片'}</div></div>`;
  };
  return `<div class="sheet"><div class="sheet-head"><h2>群聊人物列表 · ${num(keys.length)} 个群</h2>
    <span class="hint" title="数据直接读 people.json 的账号与群名片，不另存一份；合并过的多个号归同一行">直接读人物表 · 合并账号归同一行 · 全部账号显示全</span></div>
    <div class="sheet-body">${keys.map(g => {
      const ps = byG.get(g).slice().sort((a, b) => (Number(b.favor) || 0) - (Number(a.favor) || 0));
      return `<details class="rp-details"${keys.length === 1 ? ' open' : ''}><summary title="这个群里记过群名片的人；点开看全部账号与名片">▸ 群 ${esc(g)} · ${num(ps.length)} 人</summary>
        ${ps.map(p => row(p, g)).join('')}</details>`;
    }).join('')}</div></div>`;
}

function htmlFriends() {
  const F = S.friends;
  if (!F.loaded) return '<div class="loading">读出朋友录…</div>';
  const all = (F.list || []).slice();
  const q = String(F.q || '').trim().toLowerCase();
  // 搜索也扫约定正文（2026-11-13）：不然搜「Ciallo」找不到挂在人身上的那条约定
  const matchP = p => !q || (String(p.label || '') + ' ' + String(p.name || '') + ' ' + String(p.alias || '')
    + ' ' + (p.accounts || []).map(a => a.id).join(' ')
    + ' ' + (p.pacts || []).map(x => String(x.text || '')).join(' ')).toLowerCase().indexOf(q) >= 0;
  const ai = all.filter(p => p.isAI && matchP(p));      // AI 单独一栏（2026-11-21）
  const friend = all.filter(p => p.zone === 'friend' && !p.isAI && matchP(p));
  const book = all.filter(p => p.zone === 'book' && !p.isAI && matchP(p));
  const common = (F.common || []).filter(x => !q || String(x.text || '').toLowerCase().indexOf(q) >= 0);
  const nCommonTopic = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped'
    && !x.parent && topicLevelOf(x) === 'common').length;
  const st = S.review.stateCount || {};
  const counters = `<div class="counters">
    <div class="counter"><div class="counter-n">${num(friend.length)}</div><div class="counter-l">朋友录</div><div class="counter-sub">好感 &gt; 20</div></div>
    <div class="counter"><div class="counter-n${book.length ? '' : ' is-zero'}">${num(book.length)}</div><div class="counter-l">人物册</div><div class="counter-sub">好感 ≤ 20</div></div>
    <div class="counter"><div class="counter-n${nCommonTopic ? '' : ' is-zero'}">${num(nCommonTopic)}</div><div class="counter-l">通用话题</div><div class="counter-sub">不挂人、不挂群</div></div>
    <div class="counter"><div class="counter-n${(st.pending || 0) ? '' : ' is-zero'}">${num(st.pending || 0)}</div><div class="counter-l">待确认</div>
      <div class="counter-sub">已锁定 ${num(st.locked || 0)} · 未复核 ${num(st.legacy || 0)}</div></div>
  </div>`;
  const zones = [['all', '全部'], ['friend', '朋友录'], ['book', '人物册'], ['ai', 'AI'], ['group', '群聊人物'], ['topic', '全部话题'], ['pact', '全部约定'], ['common', '通用话题'], ['taste', '全部人的喜好']];
  const bar = `<div class="pact-bar">
    <input class="field" id="friend-q" placeholder="搜人名、代称、账号、约定 / 话题正文" value="${esc(F.q)}" style="width:300px">
    <span class="pact-tabs">${zones.map(([v, n]) => `<button class="chip${F.zone === v ? ' is-on' : ''}" data-act="friend-zone" data-zone="${v}">${n}</button>`).join('')}</span>
  </div>`;
  const zone = F.zone;
  const secs = [];
  if (zone === 'all' || zone === 'friend' || zone === 'book') secs.push(htmlMyTaste());
  if ((zone === 'all' || zone === 'friend') && friend.length) secs.push(`<div class="sheet"><div class="sheet-head"><h2>朋友录 · 好感 &gt; 20（${num(friend.length)} 人）</h2>
    <span class="hint">点头像或这一行，展开改约定 / 代称 / 喜好厌恶 / 好感（能锁定）</span></div><div class="sheet-body flush">${friend.map(htmlFriendRow).join('')}</div></div>`);
  if ((zone === 'all' || zone === 'book') && book.length) secs.push(`<div class="sheet"><div class="sheet-head"><h2>人物册 · 好感 ≤ 20（${num(book.length)} 人）</h2>
    <span class="hint">同一份数据，只是按好感分了区</span></div><div class="sheet-body flush">${book.map(htmlFriendRow).join('')}</div></div>`);
  if ((zone === 'all' || zone === 'ai') && ai.length) secs.push(`<div class="sheet"><div class="sheet-head"><h2>AI · ${num(ai.length)} 人</h2>
    <span class="hint">名字带关键词被标成 AI：只建档，不记好感/喜好/情绪/约定/标错/话题/代称，好感恒 0。点进去可移除（改回人物）</span></div><div class="sheet-body flush">${ai.map(htmlFriendRow).join('')}</div></div>`);
  if (zone === 'all' || zone === 'topic' || zone === 'common') {
    const nTopic = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped' && !x.parent).length;
    secs.push(htmlTopicEntryCard('friendsTopic', nTopic,
      '话题：单人 / 群 / 通用三级可重合；按群分类、不出群；过期不注入。点开看全量'));
  }
  /* 全部约定（2026-11-13 主人令）：Ciallo 这类挂在好感 0 的人名下，被「人物册 / 朋友录」分区藏了，
   * 她说「改去哪里显示了，没了」。这里平铺所有人的约定（含无主的），一排到底、带归属人，搜正文也能搜到。 */
  /* 全部人的喜好（2026-11-13 主人令「其他人的喜好为什么完全没有？记。」）：
   * 以前只在展开某个人时才看得到，她说「完全没有」——这里平铺，一条不藏。 */
  /* 群聊人物列表（①）：按群分级，数据直接读 people.json，不另建数据源。 */
  if (zone === 'group') {
    secs.length = 0;
    secs.push(htmlFriendGroups(all, q));
  }
  if (zone === 'taste') {
    secs.length = 0;
    const withTaste = all.filter(x => ((x.taste || []).reduce((a, s) => a + ((s.items || []).length), 0)) > 0 && (!q || matchP(x)));
    secs.push(`<div class="sheet"><div class="sheet-head"><h2>全部人的喜好 · ${num(withTaste.length)} 人</h2>
      <span class="hint">六节：确定 / 喜欢的人 / 待确认 / 可能。他们的「话题」大多就是喜欢或中立，照着调</span></div>
      <div class="sheet-body">${withTaste.length ? withTaste.map(x => `<div class="pact-flat"><div class="pact-flat-owner">${esc(x.label || x.name || x.pid)}</div>${htmlTasteRows(x)}</div>`).join('') : '<div class="small dim">还没有记过别人的喜好。</div>'}</div></div>`);
  }
  if (zone === 'pact') {
    const flat = [];
    for (const p of all) for (const x of (p.pacts || [])) flat.push(Object.assign({ ownerLabel: p.label || p.name || p.pid, ownerPid: p.pid }, x));
    for (const x of (F.common || [])) flat.push(Object.assign({ ownerLabel: '所有人', ownerPid: '' }, x));
    const hit = q ? flat.filter(x => (String(x.text || '') + ' ' + String(x.ownerLabel || '') + ' ' + String(x.whoName || '')).toLowerCase().indexOf(q) >= 0) : flat;
    secs.length = 0;
    secs.push(`<div class="sheet"><div class="sheet-head"><h2>全部约定 · 不分人（${num(hit.length)} / ${num(flat.length)} 条）</h2>
      <span class="hint">跟某个人的、无主的都在这里；按人和分区看只是同一份数据的另一种摆法。每条都能单独删</span></div>
      <div class="sheet-body">${hit.length ? hit.map(x => `<div class="pact-flat"><div class="pact-flat-owner">${esc(x.ownerLabel)}</div>${htmlReviewCard(x)}</div>`).join('') : '<div class="small dim">没有匹配的约定。</div>'}</div></div>`);
  }
  if (!secs.length) secs.push('<div class="empty">这一类还没有内容。</div>');
  return counters + bar + secs.join('') + htmlReviewModal() + htmlTasteModal() + htmlMineModal() + htmlPurgeModal();
}

/* 删掉这个人（2026-11-13 主人令）：点开先说清删什么、不删什么，再点确认才动手。
 * 补充（同日）：「删除人物前所有绑定的数据内容都能点击跳转到修改」——每条绑定数据都带「去改」，
 * 点一下关弹层、在朋友录里展开这个人，改完再回来删。不做「输入名字才算确认」那种花活。 */
function htmlPurgeModal() {
  const g = S.friends.purge;
  if (!g) return '';
  const p = (S.friends.list || []).find(x => x.pid === g.pid);
  if (!p) return '';
  const bare = s => String(s || '').replace(/^[a-z]+:/, '');
  const ids = new Set((p.accounts || []).map(a => String(a.id)));
  const nPact = (p.pacts || []).length;
  const nTopic = (S.review.list || []).filter(x => x.rkind === 'topic'
    && (String(x.pid || '') === p.pid || ids.has(bare(x.qq)))).length;
  const nTeach = (S.review.list || []).filter(x => x.rkind === 'teach'
    && (String(x.pid || '') === p.pid || ids.has(bare(x.qq)))).length;
  const nTaste = (p.taste || []).reduce((a, s) => a + ((s.items || []).length), 0);
  const nFacts = (p.facts || []).length;
  const bound = [
    ['约定', nPact, 'w'], ['话题', nTopic, 'w'], ['喜欢 / 讨厌', nTaste, 'w'],
    ['长期记忆的事实', nFacts, 'w'], ['他教过的记录（不删，署名保留）', nTeach, 'k'],
  ];
  return `<div class="modal-veil"><div class="modal-card">
    <h3>删掉「${esc(p.label || p.pid)}」的全部数据</h3>
    <div class="modal-line">不可撤销。删之前看清楚范围，绑定的东西都能点开先改：</div>
    <div class="small" style="line-height:1.9;margin:8px 0">
      <div><b>会删</b>：人物档案、好感 ${num(p.favor || 0)}、喜欢 / 讨厌、长期记忆里的事实、代称、跟他的约定和话题、好感流水与学习档案、people-state / favor 两个镜像里的记录。</div>
      <div><b>不删</b>：记录的知识（那条留着，署名也留着）、聊天记录（全群对话的完整性）。</div>
    </div>
    <div class="rv-ev-h">绑定的数据（点「去改」先逐项核对）</div>
    ${bound.map(([name, n, k]) => `<div class="rv-ev-row"><span class="grow">${esc(name)} · ${num(n)} 条</span>
      <button class="btn btn-quiet" data-act="purge-goto" data-pid="${esc(p.pid)}" data-focus="${k === 'k' ? 'teach' : ''}">去改</button></div>`).join('')}
    <div class="modal-btns">
      <button class="btn btn-danger" data-act="person-purge-do" data-pid="${esc(p.pid)}">确认删除</button>
      <button class="btn" data-act="person-purge-close">取消</button>
    </div>
  </div></div>`;
}

/* 聊天记录页自动跟新（2026-11-13 建，2026-11-21 改轻量）：
 * 原来每 8 秒 GET 整份 /api/chat 比签名——后端整份 read+parse+序列化，这是卡顿主因。
 * 现在改比后端 /api/chat/sig（只读主文件大小+mtime，毫秒级），变了才真正 loadChat。 */
let chatNewSig = '';
let chatNewBusy = false;
async function pollChatNew() {
  const C = S.chat;
  if (S.tab !== 'chat' || !C.loaded || chatNewBusy) return;
  if (C.starItem || C.issueItem || C.showIssues || C.traceOpen || C.showLog || C.convSet
    || C.showSet || C.replyToggle || C.person || C.groupEdit || C.emoEdit || C.convDel) return;
  chatNewBusy = true;
  try {
    const s = await window.xuh.api('GET', '/api/chat/sig');
    const sig = s && s.sig;
    if (!sig) return;
    if (!chatNewSig || sig === chatNewSig) { chatNewSig = sig; return; }
    chatNewSig = sig;
    await loadChat(sig);     // 真有新记录才整页刷新，并把基线传进去避免重复拉
  } catch {} finally { chatNewBusy = false; }
}

/* 聊天记录范围：面板只整合显示、不手动分区。打开/跟新都读最近一批分片；
 * 更早的靠往上翻（chatMoreOlder）传 skip 增量读，不走这里。 */
function chatScopeQ() { return ''; }

/* ---------------- ③ 聊天记录：谁说了什么、她怎么回的 ---------------- */
async function loadChat(sigOverride) {
  const q = chatScopeQ();
  const r = await window.xuh.api('GET', '/api/chat' + q);
  if (!r || r.error) { toast('聊天记录读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.chat.list = Array.isArray(r.list) ? r.list : [];
  S.chat.mode = r.mode || 'recent';
  S.chat.shardSegs = Number(r.shardSegs || 0);
  S.chat.shardTotal = Number(r.shardTotal || 0);
  S.chat.olderSkip = Number(r.nextSkip || 0);   // 下次往上翻从这批之后接着读
  S.chat.hasMore = !!r.hasMore;
  chatNewSig = sigOverride || (await window.xuh.api('GET', '/api/chat/sig').catch(() => null) || {}).sig || '';
  S.chat.total = Number(r.total || S.chat.list.length);
  S.chat.bot = r.bot || '虚幻';
  S.chat.convSettings = (r.convSettings && typeof r.convSettings === 'object') ? r.convSettings : {};
  S.chat.cost = (r.cost && typeof r.cost === 'object') ? r.cost : {};
  S.chat.convDefault = (r.convDefault && typeof r.convDefault === 'object') ? r.convDefault : { ctx: 30, chars: 600 };
  // 机器人端那四个数：改完保存会重新拉一次，界面和机器人读的是同一份
  if (r.cfg && typeof r.cfg === 'object') S.chat.cfg = Object.assign({}, S.chat.cfg, r.cfg);
  S.chat.loaded = true;
  await loadIssues();      // 待修复问题一起拉，共用这一个页面，不另起一套
  loadEmobook();          // 情绪书（叶 + 应对）一起拉，改情绪 / 显示应对要用
  await loadPacts().catch(() => {});   // 约定一起拉：打开会话看这个会话的约定用
  await loadReview().catch(() => {});  // 话题（三级）也从复核列表来，聊天页要用
  buildPactLinks();       // 算「哪条消息生成了哪条约定」的映射（靠 scope/qq + 时间反推）
  paintChrome();
  if (S.tab === 'chat') render();
}
/* 情绪书数据（叶 + 应对），改情绪 / 显示应对时要用。开聊天页时拉一次缓存（主人 2026-11-07 定）。 */
async function loadEmobook() {
  if (S.chat.emoBook) return;
  try {
    const r = await window.xuh.api('GET', '/api/emobook');
    if (r && r.tree) S.chat.emoBook = r.tree;
  } catch {}
}
/* 按叶名取应对文案（递归展开）；返回字符串数组 */
function leafReplies(name) {
  const bk = S.chat.emoBook; if (!bk || !bk.leaves) return [];
  const lf = (bk.leaves || []).find(x => x.name === name);
  if (!lf || !lf.replies || !lf.replies.length) return [];
  const map = {}; (bk.replies || []).forEach(r => { if (r && r.id) map[r.id] = r; });
  const out = [], seen = {};
  const walk = id => {
    if (seen[id]) return; seen[id] = 1;
    const r = map[id]; if (!r) return;
    if (r.text) out.push(r.text);
    (r.ref || []).forEach(walk);
  };
  lf.replies.forEach(walk);
  return out;
}

/* 约定挂在哪个会话：群按 scope 精确对（'群894917172'），私聊按人 qq 对，
 * 通用约定（scope 空）对谁都算。聊天页筛选 / 内联面板都走这一个。 */
function pactsForConv(conv) {
  const all = (S.pacts.list || []);
  if (conv === '__all') return all.filter(p => !p.scope);            // 通用约定
  if (conv.indexOf('群') === 0) return all.filter(p => p.scope === conv);
  const set = new Set();
  (S.chat.list || []).forEach(m => {
    if (chatConvOf(m) === conv) {
      const u = String(m.uid || m.qq || '').replace(/[^0-9]/g, '');
      if (u) set.add(u);
    }
  });
  return all.filter(p => {
    if (!p.scope) return true;                                       // 通用对所有人生效
    const pq = String(p.qq || '').replace(/^[^:]+:/, '').replace(/[^0-9]/g, '');
    return pq && set.has(pq);
  });
}

/* 算「哪条聊天消息生成了哪条约定」的映射：约定数据里没有源消息键，
 * 只能靠 scope/qq 挂到会话，再在同会话、同人、记录在之前最近的那条（30 分钟内）反推。
 * 是推断，UI 里标「📜约」时说明这是推断来源，不假装 100% 准。 */
function buildPactLinks() {
  const C = S.chat;
  const byId = {}, src = {};
  (S.pacts.list || []).forEach(p => {
    byId[p.id] = p;
    if (!p.scope && !p.qq) return;                                   // 通用 / 随手记：没有来源消息
    const cv = (p.scope && p.scope.indexOf('群') === 0) ? p.scope : null;
    const pq = String(p.qq || '').replace(/^[^:]+:/, '').replace(/[^0-9]/g, '');
    const pt = Date.parse(p.t || '');
    if (isNaN(pt)) return;
    let best = null, bestDt = Infinity;
    (C.list || []).forEach(m => {
      const mt = Date.parse(m.t || '');
      if (isNaN(mt) || mt > pt) return;
      if (m.bot) return;                                       // 源消息是人的请求句，不是机器人自己的回复
      if (cv) { if (chatConvOf(m) !== cv) return; }
      else if (pq) { const mu = String(m.uid || m.qq || '').replace(/[^0-9]/g, ''); if (mu !== pq) return; }
      else return;
      const sameWho = (p.who && String(m.nick || '').replace(/[\u2066-\u2069\u200e\u200f]/g, '') === String(p.who))
        || (pq && String(m.uid || m.qq || '').replace(/[^0-9]/g, '') === pq);
      if (!sameWho) return;
      const dt = pt - mt;
      if (dt <= 24 * 3600000 && dt < bestDt) { bestDt = dt; best = m; }   // 放宽到 24h：安静群里请求和记录可能隔较久
    });
    if (best) { const k = chatKey(best); (src[k] = src[k] || []).push(p.id); }
  });
  C.pactById = byId; C.pactSrc = src;
}

/* 内联「本会话约定」面板：打开一个会话时显示它相关的约定（通用 + 群 / 按人）。点标题收起。 */
function htmlChatPacts(conv) {
  const list = pactsForConv(conv);
  if (!list.length) return '';
  const open = S.chat.pactOpen;
  const cards = list.map(p => {
    const who = p.whoName || pactWhoName(p);
    const say = String(p.say || '').trim();
    const when = (Array.isArray(p.when) ? p.when : []).filter(Boolean);
    const note = String(p.note || '').trim();
    const kind = pactKindOf(p);
    const KN = { style: '说话方式', scene: '条件明确' };
    return `<div class="chat-pact">
      <div class="pact-top">
        <span class="badge ${p.qq ? 'badge-blue' : ''}">${p.qq ? '按人' : '通用'}</span>
        <span class="pact-who">${esc(who)}</span>
        ${p.scope ? `<span class="badge badge-grey">${esc(p.scope)}</span>` : ''}
        <span class="small dim pact-time">${esc(fmtTime(p.t))}</span>
      </div>
      ${say ? `<div class="pact-say" title="要原样说出口的话（符号、括号、标点都不改）">${esc(say)}</div>` : ''}
      ${when.length ? `<div class="pact-when" title="${esc(when.join(' / '))}">触发：${esc(when.slice(0, 3).map(w => '「' + w + '」').join(' '))}${when.length > 3 ? ' 共 ' + when.length + ' 条' : ''}</div>` : (kind === 'style' ? '<div class="pact-when">回他时带</div>' : '')}
      ${note ? `<div class="pact-note">另外：${esc(note)}</div>` : ''}
      <div class="pact-raw" title="磁盘上的原文">${esc(String(p.text || '').slice(0, 120))}</div>
      <div class="rv-btns">
        <button class="btn btn-quiet" data-act="review-open" data-id="${esc(p.id)}">查看 / 改</button>
        <button class="btn btn-quiet${S.review.delAsk === p.id ? ' btn-danger' : ''}" data-act="review-del" data-id="${esc(p.id)}" title="单条删除，点两下确认">${S.review.delAsk === p.id ? '真的删？' : '删'}</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="chat-pacts">
    <button class="jump-all" data-act="home-panel" data-panel="pact"
      title="碰到就跳到约定那一页的位置，查看全部相关（汇总与「只看约定条」两个都留着）">◈ 共 ${num(list.length)} 条相关 · 碰一下看全部</button>
    <button class="chat-pact-head" data-act="chat-pact-collapse" title="这个会话相关的约定（含通用）。点一下收起 / 展开">
      <span>本会话约定 ${num(list.length)} 条</span>
      <span class="dim">${open ? '收起 ▲' : '展开 ▼'}</span>
    </button>
    ${open ? `<div class="chat-pacts-body">${cards}</div>` : ''}
  </div>`;
}

/* 待修复问题（主人 2026-11-06 定）：群里撤回消息自动记一条，手动标错误也记一条。
 * 都落在「虚幻自查」ai-feedback.jsonl 里（kind='待修复'），不新建文件。
 * /api/feedback 已倒序返回，idx 就是 /api/feedback/del 要的索引，别重排。 */
async function loadIssues() {
  const r = await window.xuh.api('GET', '/api/feedback');
  const list = (r && Array.isArray(r.list)) ? r.list : [];
  S.chat.fbList = list;
  S.chat.issues = list.map((x, i) => Object.assign({}, x, { idx: i }))
    .filter(x => x && x.kind === '待修复');
}

/* 「推理」按回复原文 + 这条记录的时间找轨迹。和 /api/thinking 不是一回事：
 * 那个只留最近 5 条模型思考原文（老功能），这个是每轮都记的代码决策轨迹。 */
async function openTrace(m) {
  const C = S.chat;
  C.traceOpen = true; C.traceLoading = true; C.traceItem = null;
  C.issueItem = null; C.showIssues = false; C.showLog = false;
  render();
  const q = '?text=' + encodeURIComponent(String(m.text || '')) + '&t=' + encodeURIComponent(String(m.t || ''));
  const r = await window.xuh.api('GET', '/api/trace' + q);
  C.traceItem = (r && r.item) || null;
  C.traceLoading = false;
  render();
}
/* 工作日志：按天读原文；同一份文件也自动被撤回 / 待修复 / 代码更新追加。 */
async function openLog(day) {
  const C = S.chat;
  C.showLog = true; C.logLoading = true; C.traceOpen = false;
  C.issueItem = null; C.showIssues = false;
  render();
  const r = await window.xuh.api('GET', '/api/memory/log?day=' + encodeURIComponent(day || C.logDay || ''));
  C.logDays = (r && Array.isArray(r.days)) ? r.days : [];
  C.logDay = (r && r.day) || C.logDay || '';
  C.logRaw = (r && r.raw) || '';
  // 同一个弹层里也读长期记忆正本：改完能立刻看到「每轮注入」变成什么，不用去文件页翻
  const m = await window.xuh.api('GET', '/api/memory');
  C.memRaw = (m && m.raw) || '';
  C.memPrompt = (m && m.prompt) || '';
  C.logLoading = false;
  render();
}

const chatKey = m => m.key || (m.t + '|' + m.nick + '|' + String(m.text || '').slice(0, 20));

function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t || '').slice(0, 16);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDay(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return '更早';
  const p = n => String(n).padStart(2, '0');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + wd;
}

/* 会话按「虚幻的视角」分。键和名字都由服务端按好感度页的规则算好：
 * 群 = 群号，名字是「群名（群号）」；私聊 = 人物 id，名字是「人名（QQ 号）」。
 * 日志只存显示名，服务端用 people.json + 运行时昵称索引反查回号和人物；
 * 同一个人的两个号并成一个会话，虚幻自己回的那句也跟着对方走。
 * 服务端还没重启时（旧数据没有 conv 字段）退回原来的按 scope 分。 */
function chatConvOf(m) {
  if (m && m.conv) return String(m.conv);
  const sc = String((m && m.scope) || '');
  return sc.indexOf('群') === 0 ? sc : '__private';
}

/* 可多选的上下文：同一会话里这条前后各几句，按聊天顺序排好，默认一句都不选。
 * 加星（学习用）和标错（修 bug 用）共用这一份，不写两套。 */
function nearbyOf(m) {
  const C = S.chat, cv = chatConvOf(m);
  const same = (C.list || []).filter(x => chatConvOf(x) === cv);
  const i = same.findIndex(x => chatKey(x) === chatKey(m));
  if (i < 0) return [];
  // 上文 12 句（2026-11-13 主人令「上文聊天记录再加 6 条」）；下文 3 句、最多选 8 句不变。
  return same.slice(Math.max(0, i - 12), i + 4)
    .filter(x => chatKey(x) !== chatKey(m))
    .map(x => ({
      key: chatKey(x), nick: String(x.nick || '?'), text: String(x.text || ''), bot: !!x.bot, t: x.t,
      uid: x.uid || '', avPlat: x.avPlat || (x.uid ? 'qq' : ''), avId: x.avId || x.uid || '',
    }));
}
const starNearby = nearbyOf;   // 老名字留着，别处还在用

/* 多选行 = QQ 那种样子（主人 2026-11-07：「多选用 QQ 的样式」）：
 * 左边一个圆形选择圈（没选=灰边空心，选了=蓝底白勾），右边是这个人 + 这条消息本身，
 * 选中整行淡蓝底。不是普通网页那种方框打勾。 */
function qqPickRows(m, picked, act) {
  const rows = nearbyOf(m).map(x => {
    const on = picked && picked.has(x.key);
    // 有号就用那个平台的头像（一个人多个号时各用各的）；虚幻自己用 哭.jpg（和气泡那边的头像同一张）；
    // 都没查到号就留淡灰块
    const avStyle = x.avId
      ? `--pick-avatar:url('xuh://avatar/${x.avPlat || 'qq'}/${String(x.avId).replace(/[^0-9A-Za-z_.-]/g, '')}')`
      : (x.bot ? '--pick-avatar:var(--bot-avatar)' : '');
    return `<button type="button" class="qq-pick${on ? ' is-on' : ''}${x.bot ? ' is-bot' : ''}"${avStyle ? ` style="${avStyle}"` : ''}
      data-act="${esc(act)}" data-key="${esc(x.key)}" title="点一下选中 / 取消">
      <span class="qq-pick-radio" aria-hidden="true"></span>
      <span class="qq-pick-av" aria-hidden="true"></span>
      <span class="qq-pick-body">
        <span class="qq-pick-top"><span class="qq-pick-n">${esc(x.nick)}</span><span class="qq-pick-t">${esc(fmtTime(x.t).slice(11))}</span></span>
        <span class="qq-pick-x">${esc(x.text.replace(/\s+/g, ' ').slice(0, 80))}</span>
      </span>
    </button>`;
  }).join('');
  return `<div class="qq-picks">${rows || '<div class="empty">附近没有别的消息</div>'}</div>`;
}
/* 选中条数那一行（QQ 多选时顶部的「已选 N 条」） */
function pickCount(n, max) {
  return `<div class="qq-pick-bar"><span class="qq-pick-count${n ? ' is-on' : ''}">已选 ${num(n)} 条</span>
    <span class="small dim">最多 ${num(max)} 条，选它们是为了让虚幻看到当时的上下文</span></div>`;
}

/* 话题放进聊天记录页（2026-11-12 主人定）：按当前会话的群 / 私聊分类，**不出群**。
 * 「全部消息 / 全部群聊 / 全部私聊」这种跨会话视图不给话题，免得 A 群的事跑到 B 群。
 * 筛选维度和教学、约定不同：按 级别（单人/群/通用）+ 时效，没有「私密/公开」。 */
function chatTopicScope(conv) {
  const c = String(conv || '');
  if (c === '__all' || c === '__group' || c === '__private' || !c) return '';
  const m = (S.chat.list || []).find(x => chatConvOf(x) === c);
  return m ? String(m.scope || '') : '';
}
function htmlChatTopics(conv) {
  const scope = chatTopicScope(conv);
  const all0 = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped' && !x.parent);
  // 话题的筛选维度和教学 / 约定不一样（主人 2026-11-13）：
  // 「被漏记 / 记错」不是筛选项，是在卡片里判出来直接转成教学知识或约定的分支。
  /* 筛选维度（2026-11-13 主人令）：不设「私密 / 公开」——那条没意义、已废；改成
   * 短期 / 长期 / 单人 / 群 / 通用 / 已过期。一到三级可以重合，所以一条可能同时出现在两个筛选项里。 */
  const TF = S.chat.topicFilter || 'all';
  const pass = x => {
    if (TF === 'all') return true;
    if (TF === 'short') return String(x.ttl || 'short') === 'short' && !x.expired;
    if (TF === 'long') return String(x.ttl || '') === 'long';
    if (TF === 'expired') return !!x.expired;
    return topicLevelsOf(x).indexOf(TF) >= 0;
  };
  /* 同类筛选项 >3 就分级（主人 2026-11-13 §4）：分成「级别 / 时效」两组，不在一行平铺 7 个。 */
  const grp = arr => arr.map(([v, n]) =>
    `<button class="chip${TF === v ? ' is-on' : ''}" data-act="chat-topic-filter" data-v="${v}">${n}</button>`).join('');
  const chips = `<span class="pact-tabs" style="margin-left:8px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">
    <span class="small dim">级别</span>${grp([['all', '全部'], ['single', '单人'], ['group', '群'], ['common', '通用']])}
    <span class="small dim">时效</span>${grp([['short', '短期'], ['long', '长期'], ['expired', '已过期']])}</span>`;
  const all = all0.filter(pass);
  if (!scope) {
    /* 没选具体会话时给「按群聊分类」的总览（主人 2026-11-13：「放入聊天记录页，按群聊分类，不出群」）。
     * 每块只列本群的话题，不跨群看。 */
    const pub = all;
    const by = new Map();
    for (const x of pub) {
      const s = String(x.scope || '').trim();
      const g = (s.match(/群\s*\d+/) || [])[0] || (/^私聊/.test(s) ? s : '通用（不挂群）');
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(x);
    }
    const open = !!S.chat.topicOpen;
    return `<div class="chat-pacts">
      <button class="jump-all" data-act="home-panel" data-panel="topic" title="碰到就跳到话题那一页，查看全部相关">◈ 共 ${num(pub.length)} 条相关 · 碰一下看全部</button>
      <button class="chat-pact-head" data-act="chat-topic-collapse" title="话题按群分类，不出群：点一下收起 / 展开">
        <span>话题 · 按群分类 ${num(pub.length)} 条</span>
        <span class="dim">${open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      <div style="padding:6px 12px 0">${chips}</div>
      ${open ? `<div class="chat-pacts-body">${pub.length
        ? [...by.entries()].map(([g, list]) => `<div class="chat-topic-grp">
            <div class="pact-top"><span class="badge">${esc(g)}</span><span class="small dim">${num(list.length)} 条 · 只在这个场合用</span></div>
            ${list.map(htmlReviewCard).join('')}</div>`).join('')
        : '<div class="small dim">还没有话题。</div>'}</div>` : ''}
    </div>`;
  }
  // 选了具体会话：只看这一处（本场合 + 通用），单人话题只在本人身上才算相关
  const list = all.filter(x => String(x.scope || '') === scope
    || (topicLevelOf(x) === 'common' && !String(x.scope || '')));
  const nExp = list.filter(x => x.expired).length;
  return `<div class="chat-topics"><button class="jump-all" data-act="home-panel" data-panel="topic" title="碰到就跳到话题那一页，查看全部相关">◈ 共 ${num(list.length)} 条相关 · 碰一下看全部</button>
    <div class="chat-topics-h">${esc(scope)} 的话题 · ${num(list.length)} 条${chips}
    <span class="dim">（过期 ${num(nExp)} 不注入；群话题不出群，单人话题只在本人出现的场合用）</span>
    <span class="dim">判成「漏记/记错」时，在弹层里直接转成教学知识或约定的分支</span></div>
    ${list.length ? list.map(htmlReviewCard).join('') : '<div class="small dim">这一处还没有话题。</div>'}</div>`;
}

/* ---------- 本轮输出的提示词（2026-11-13 主人令）----------
 * 后端每轮把发给大模型的整组提示词按来源钉进「群 / 私聊 / 平台」三个分区，每个来源只钉一条；
 * 写满不覆盖，主人删掉某条后，这个来源下一轮回复时自动补一条（缺位后自动补一次）。
 * 前端只做一次性展示：进聊天页拉一次，不轮询、不裁条数（她否了「留最近 4 条」）。
 * 多行原文按前端坑单渲染：不压 \s、用 white-space:pre-wrap 的容器、默认短显但给显式「展开全文」。 */
let promptSlotsBusy = false;
async function loadPromptSlots(force) {
  if (promptSlotsBusy) return;
  if (!force && S.chat.prompts !== null) return;      // 一次性：拉过就不再打接口
  promptSlotsBusy = true;
  try {
    const r = await window.xuh.api('GET', '/api/chat/prompts');
    S.chat.prompts = (r && r.slots) ? r.slots : { group: {}, private: {}, platform: {} };
    S.chat.promptCats = (r && r.cats) || ['group', 'private', 'platform'];
    S.chat.promptCatLabel = (r && r.labels) || { group: '群', private: '私聊', platform: '平台' };
  } catch {
    /* 接口没通就保持 null：页面显示「读取中…」，下次进页再试一次（无定时器，不是轮询）。
     * 不伪装成「这一类还没有」——那是接口挂了却装成机器人没发过轮，是假的确定性。 */
  }
  promptSlotsBusy = false;
  if (S.tab === 'chat') paintPromptSlots();
}

/* 只重画这一块，不动整页：聊天页 200 条消息 + 各会话的滚动位置都在，
 * 整页 render() 会走 stickChatBottom 贴底，刚展开的内容会被滚走（和 paintLiveThink 同一个道理）。 */
function paintPromptSlots() {
  const box = view.querySelector('.chat-prompts');
  if (!box) return;
  box.outerHTML = htmlPromptSlots();
}

function promptSlotText(it) {
  const msgs = (it && Array.isArray(it.messages)) ? it.messages : [];
  const txt = m => {
    const c = m && m.content;
    return typeof c === 'string' ? c : (c == null ? '' : JSON.stringify(c, null, 2));
  };
  return msgs.map(m => '【' + String((m && m.role) || '') + '】\n' + txt(m)).join('\n\n');
}

function promptSlotFind(id) {
  const p = String(id || '').split(':');
  const cat = p.shift(), k = p.join(':');
  const slots = S.chat.prompts || {};
  return (slots[cat] || {})[k] || null;
}

function htmlPromptSlots() {
  const slots = S.chat.prompts;
  const cats = S.chat.promptCats || ['group', 'private', 'platform'];
  const total = slots ? cats.reduce((n, c) => n + Object.keys(slots[c] || {}).length, 0) : 0;
  const open = !!S.chat.promptFold;
  return `<div class="chat-prompts">
    <button class="chat-pact-head" data-act="chat-prompt-fold" title="本轮输出的提示词：按群 / 私聊 / 平台分槽钉住，每个来源一条；每条可删，删后下一轮自动补">
      <span>本轮提示词 · ${num(total)} 条</span>
      <span class="dim">${open ? '收起 ▲' : '展开 ▼'}</span>
    </button>
    ${open ? `<div class="chat-prompts-body">${promptSlotsBody()}</div>` : ''}
  </div>`;
}

function promptSlotsBody() {
  const slots = S.chat.prompts;
  if (!slots) return '<div class="small dim">读取中…</div>';
  const cats = S.chat.promptCats || ['group', 'private', 'platform'];
  const L = S.chat.promptCatLabel || { group: '群', private: '私聊', platform: '平台' };
  return cats.map(c => {
    const entries = Object.entries(slots[c] || {});
    return `<div class="prompt-cat">
      <div class="prompt-cat-h"><span class="badge">${esc(L[c] || c)}</span>
        <span class="small dim">${num(entries.length)} 条 · 每个来源钉一条</span></div>
      ${entries.length ? entries.map(([k, it]) => htmlPromptSlot(c, k, it)).join('')
        : '<div class="small dim">这一类还没有。这个来源下一轮回复后会自动补上一条。</div>'}
    </div>`;
  }).join('') + '<div class="small dim prompt-note">每条钉住的是那一轮发给模型的完整提示词，下一轮不会覆盖；点「删除」清空这个槽，之后该来源再回复一轮就自动补一条新的。</div>';
}

function htmlPromptSlot(cat, k, it) {
  const id = cat + ':' + k;
  const full = !!S.chat.promptFull[id];
  const fullText = promptSlotText(it);
  const chars = fullText.length;
  // 前端聊天记录里已算好 convLabel（群名 / 人名），优先用它；平台类匹配不到就用后端兜底 label。
  const hit = (S.chat.list || []).find(m => m.scopeKey === k
    && (cat === 'group' ? m.convKind === 'group' : (cat === 'private' ? m.convKind !== 'group' : true)));
  const label = (hit && hit.convLabel) || it.label || k;
  const cut = 600;
  const show = full ? fullText : fullText.slice(0, cut);
  const tail = (!full && chars > cut) ? `\n…（还有 ${num(chars - cut)} 字，点「展开全文」看全部）` : '';
  return `<div class="prompt-slot">
    <div class="prompt-slot-h">
      <b>${esc(label)}</b>
      <span class="small dim">${esc(k)} · ${it.t ? esc(fmtTime(it.t)) : ''} · ${num(chars)} 字 · ${num((it.messages || []).length)} 块</span>
      <span class="prompt-slot-acts">
        <button class="chip" data-act="chat-prompt-copy" data-id="${esc(id)}" title="复制这一轮的完整提示词（所有块，不截断）">复制</button>
        <button class="chip" data-act="chat-prompt-full" data-id="${esc(id)}" title="${full ? '收起全文' : '展开全文'}">${full ? '收起' : '展开全文'}</button>
        <button class="chip is-danger" data-act="chat-prompt-del" data-id="${esc(id)}" data-cat="${esc(cat)}" data-k="${esc(k)}" title="删掉这一条：槽位空出来，这个来源下一轮回复后自动补一条">删除</button>
      </span>
    </div>
    ${it.trigger ? `<div class="prompt-trigger">触发这句：${esc(it.trigger)}</div>` : ''}
    <pre class="prompt-full">${esc(show + tail)}</pre>
  </div>`;
}

function htmlChat() {
  const C = S.chat;
  if (!C.loaded) return '<div class="loading">读出聊天记录中…</div>';
  const all = C.list || [];
  /* 四个分段（主人 2026-11-19 定）：全部消息 / QQ群 / 私信 / B站。
   * 「私信」= 全平台私聊合成一列（QQ 私聊 + B站私信 + 别的平台），不再按平台分家。
   * 「B站」= 原来左栏那个 B站页整块搬进来（左栏不再单占一格）。
   * 「其他各自也都全部」→ 每段顶上都有自己的「全部」：全部群聊 / 全部私信 / 全部消息。 */
  const TAB = ['all', 'group', 'private', 'bili'].indexOf(String(C.tab)) >= 0 ? String(C.tab) : 'all';
  if (!C.bdm) { C.bdm = { list: [], err: '', loading: false, msgs: {}, busy: {} }; loadBiliDm(); }

  /* 左侧会话栏：只列具体会话，不做「全部群聊」这种二次归类（主人 2026-11-07）。
   * 群显示群名 + 群号，私聊显示人名 + 「平台 号」，都是服务端按好感度页的规则算好的 convLabel。
   * kind 由服务端给（group / qq / bili / 其它平台 / orphan），客户端不再靠猜前缀。 */
  const kindOf = m => {
    if (m && m.convKind) return String(m.convKind);
    const cv = chatConvOf(m);
    return cv.indexOf('群') === 0 ? 'group' : 'qq';
  };
  const convMap = new Map();
  all.forEach(m => {
    const cv = chatConvOf(m);
    if (cv === '__all' || cv === '__group') return;
    const kind = kindOf(m);
    const cur = convMap.get(cv) || {
      label: m.convLabel || cv, n: 0, last: '', kind, platLabel: m.platLabel || '',
      uid: m.uid || '', pid: m.pid || '', scopeKey: m.scopeKey || '', t: 0,
    };
    cur.n++;
    cur.t = Math.max(Number(cur.t) || 0, Number(m.t) || 0);
    cur.last = String(m.text || '').replace(/\s+/g, ' ').slice(0, 18);
    if (m.convLabel) cur.label = m.convLabel;
    if (!cur.uid && m.uid) cur.uid = m.uid;
    if (!cur.pid && m.pid) cur.pid = m.pid;
    if (!cur.scopeKey && m.scopeKey) cur.scopeKey = m.scopeKey;
    convMap.set(cv, cur);
  });
  /* 私信按人合并（主人 2026-11-19「私信现在没有把单人的私信消息合并显示」）：
   * 服务端 parseChatLine 给每条 QQ 私聊带了 pid（人物表 id），B站私信会话带 s.person.pid。
   * 同一个 pid 就是同一个人 → 左栏并成一行、右侧一处看全部（QQ + B站）。不新建对应关系。 */
  const pidToConv = new Map();
  convMap.forEach((v, k) => { if (v.pid && v.kind !== 'group' && v.kind !== 'orphan') pidToConv.set(String(v.pid), k); });
  const bdmReal = ((C.bdm && C.bdm.list) || []).filter(s => !/^84\d{13,}$/.test(String(s.uid)));
  const bdmPids = new Set(bdmReal.filter(s => s.person && s.person.pid).map(s => String(s.person.pid)));
  const findBdmByPid = pid => bdmReal.find(s => s.person && String(s.person.pid) === String(pid));
  // 选中的是 B站私信会话、或选中了「已合并 B站私信的 QQ 会话」→ 把那个 B站会话的消息拉一次（每个只拉一次）
  {
    let needUid = '';
    if (/^bdm_/.test(String(C.conv))) needUid = String(C.conv).slice(4);
    else if (/^p_/.test(String(C.conv)) && convMap.has(C.conv)) {
      const bs = findBdmByPid(String(C.conv).slice(2));
      if (bs) needUid = String(bs.uid);
    }
    if (needUid && !C.bdm.msgs[needUid] && !C.bdm.busy[needUid]) loadBiliDmMsgs(needUid);
  }
  /* 会话头像（主人 2026-11-07：「现在还没有群头像」）：
   * 群 = QQ 官方群头像 p.qlogo.cn/gh/<群号>…；人 = 那个号的平台头像。
   * 取不到就不设这个变量，CSS 退回原来的字徽标（不编、也不留空白）。 */
  const convAvatar = (key, v) => {
    /* 2026-11-16 补回真头像：以前这里只往 style 写 --conv-avatar，CSS 根本没引用这个变量，
     * 会话列表就只剩一个首字方块 → 她说的「人物头像现在没了」。
     * 现在直接放 <img>，加载失败由全局 error 捕获移除，露出底下的字徽标，不留空白。 */
    if (v.kind === 'group') {
      const gid = String(key).replace(/\D/g, '');
      return gid ? `<img class="conv-av__img" src="xuh://avatar/group/${esc(gid)}" alt="">` : '';
    }
    const id = String(v.uid || '').replace(/[^0-9A-Za-z_.-]/g, '');
    if (!id) return '';
    const plat = (v.kind && v.kind !== 'orphan') ? v.kind : 'qq';
    return `<img class="conv-av__img" src="xuh://avatar/${esc(plat)}/${esc(id)}" alt="">`;
  };
  // 名字和号分行：名字再长也只是第二行被截，群号 / 号永远完整可见（主人 2026-11-07「也显示号」）
  const convItem = (key, label, n, sub, badge, kind, v) => {
    const mm = String(label).match(/^(.*?)（(?:QQ |B站 )?(\d+)）$/);
    const nm = mm ? mm[1] : label;
    // 这个会话花了多少（折合 DeepSeek 谷时人民币，服务端算好的）：
    //   「全部消息」= 所有会话合计；单个群/私聊 = 它自己的账。后台类调用（日记/记忆）不算进任何会话。
    const costAll = Object.keys(C.cost || {}).reduce((a, k) => a + (Number((C.cost[k] || {}).rmb) || 0), 0);
    const rmbv = v ? (v.scopeKey && C.cost[v.scopeKey] ? (Number(C.cost[v.scopeKey].rmb) || 0) : null) : costAll;
    const costTxt = (rmbv === null || !rmbv) ? '' : ' · ' + fmtRmb(rmbv);
    const line = (mm ? '号 ' + mm[2] + (sub ? ' · ' + sub : '') : sub) + costTxt;
    // 这个会话单独设过什么（主人 2026-11-07：开关按会话各调、黑名单直接打标记）
    const one = (v && v.scopeKey && C.convSettings[v.scopeKey]) || null;
    const muted = !!one && (one.black || one.reply === false);
    const localFirst = !!one && one.model === 'local';
    const avStyle = v ? convAvatar(key, v) : '';
    const gear = (v && v.scopeKey)
      ? `<span class="conv-set" data-act="chat-conv-set" data-conv="${esc(key)}" title="这个会话单独设：上下文条数 / 输出字数 / 要不要回话 / 黑名单 / 模型">⚙</span>`
      : '';
    const muteTag = muted ? (one.black ? '黑名单' : '不回话') : (localFirst ? '本地模型优先' : '');
    return `<button class="conv${C.conv === key ? ' is-on' : ''}${muted ? ' is-muted' : ''}" data-act="chat-conv" data-conv="${esc(key)}" title="${esc(label)}${muteTag ? '（' + muteTag + '）' : ''}">
    <span class="conv-av is-${esc(kind)}">${avStyle}${esc(badge)}</span>
    <span class="conv-main"><span class="conv-name">${esc(nm)}${muted ? `<span class="conv-mute">${one.black ? '黑' : '静'}</span>` : (localFirst ? `<span class="conv-mute conv-local">本</span>` : '')}</span><span class="conv-last" title="${esc(line)}">${esc(line)}</span></span>
    <span class="conv-n">${num(n)}</span>
    ${gear}
  </button>`;
  };
  const convs = [...convMap.entries()];
  const realConvs = convs.filter(([, v]) => v.kind !== 'orphan');
  const oConvs = convs.filter(([, v]) => v.kind === 'orphan');
  /* 选中的会话没了（记录被删、或者键随这次分平台改过名）→ 退回当前分段的「全部」，
   * 不然界面会停在一个永远空着的会话上，看着像坏了。
   * B站 私信会话（bdm_<UID>）不在 convMap 里，是另一份数据，不能跟着被重置。 */
  const isBdm = /^bdm_/.test(String(C.conv));
  const isSpecial = C.conv === '__all' || C.conv === '__group' || C.conv === '__private';
  if (!isBdm && !isSpecial && !convMap.has(C.conv)) C.conv = TAB === 'group' ? '__group' : (TAB === 'private' ? '__private' : '__all');
  /* 分段和选中项对不上（比如上次在私信段，这次点进来又在群段）→ 拉回本段的「全部」，
   * 免得「QQ群」这一页右边显示的是某个人的私聊。 */
  if (TAB === 'group' && C.conv === '__all') C.conv = '__group';
  if (TAB === 'private' && (C.conv === '__all' || C.conv === '__group')) C.conv = '__private';
  if (TAB === 'all' && (C.conv === '__group' || C.conv === '__private')) C.conv = '__all';

  // 计数：每组几个人 / 几个群、多少条，删记录后立刻反映真实数量（主人 2026-11-07「计数要保留」）
  const sum = arr => arr.reduce((a, [, v]) => a + (Number(v.n) || 0), 0);
  const grp = k => convs.filter(([, v]) => v.kind === k);
  const gConvs = grp('group');
  const privConvs = realConvs.filter(([, v]) => v.kind !== 'group');
  const platKinds = [...new Set(privConvs.map(([, v]) => v.kind))];
  /* B站私信：和 B站页同一份数据（/api/bili/dm，只读）。
   * 系统通知号（8444249301xxxxx：创作助手 / 服务通知 / 社区中心）不是人，不进私信列表，
   * 只在标题里报个数，免得把真人的会话挤下去。 */
  const bdm = C.bdm || { list: [], err: '', loading: false };
  const bdmFolk = bdmReal;   // 真人会话（已排除系统通知号），和下面少数派口径一致
  // 按人合并：person.pid 已能在 QQ 私聊里找到的，就不单独占一行（它并进那行 QQ 会话里显示）
  const bdmSolo = bdmFolk.filter(s => !(s.person && s.person.pid && pidToConv.has(String(s.person.pid))));
  const bdmMergedN = bdmFolk.length - bdmSolo.length;
  const bdmPeople = bdmSolo;  // 左栏真正单独列出的 B站私信行
  const bdmSys = (bdm.list || []).length - bdmFolk.length;
  const platName = k => {
    if (k === 'qq') return 'QQ';
    const hit = privConvs.find(([, v]) => v.kind === k);
    return (hit && hit[1].platLabel) || k;
  };
  const badgeOf = v => {
    if (v.kind === 'group') return '群';
    if (v.kind === 'qq') return 'Q';
    return String(v.platLabel || v.kind || '?').slice(0, 1);
  };
  // 会话行：一个平台一个角标，混在同一列里也能分清是哪来的
  // 有 B站私信并进来的（v.pid 命中），名字后加「B」角标 + 合并条数，点开右边能看到两平台全部消息
  const qqRow = (k, v) => {
    const bs = v.pid && findBdmByPid(v.pid);
    const label = (bs && v.label) ? v.label : v.label;
    // convItem 用 sub 那行显示号/摘要；把 B站角标塞进 badge 不破坏角标宽度，改用 last 前缀提示
    const sub = (bs ? 'B站+QQ · ' : '') + v.last;
    return convItem(k, label, v.n + (bs ? Number(bs.unread) || 0 : 0), sub, badgeOf(v), v.kind, v);
  };
  const bdmRow = s => {
    const k = 'bdm_' + s.uid;
    // 人物表里没记 QQ 号的人会带「（没存号）」后缀，列在私信里太吵，显示时去掉（不改数据）
    const who = String((s.person && s.person.name) ? s.person.name : (s.name || s.uid)).replace(/（没存号）$/, '');
    const av = s.face ? `<img class="conv-av__img" src="${esc(s.face)}" alt="">` : '';
    const qqTag = (s.person && s.person.qq && s.person.qq.length)
      ? `<span class="conv-mute conv-local" title="同一个人在 QQ 也有号：${esc(s.person.qq.join('、'))}">QQ</span>` : '';
    return `<button class="conv${String(C.conv) === k ? ' is-on' : ''}" data-act="chat-bdm" data-uid="${esc(s.uid)}" title="B站私信 · ${esc(who)}${s.person && s.person.qq.length ? ' · QQ ' + esc(s.person.qq.join('、')) : ''}">
      <span class="conv-av is-bili">${av}${s.face ? '' : 'B'}</span>
      <span class="conv-main"><span class="conv-name">${esc(who)}${qqTag}</span><span class="conv-last" title="${esc(s.preview || '')}">${esc(String(s.preview || '（没有文字）').slice(0, 18))}</span></span>
      <span class="conv-n">${Number(s.unread) ? num(s.unread) : ''}</span>
    </button>`;
  };
  // 混排：按「最后说话时间」倒序（B站私信只有会话时间，QQ 用最后一条消息时间）
  const byTime = (a, b) => (Number(b.t) || 0) - (Number(a.t) || 0);
  const rowsOf = arr => arr.map(x => x.html).join('');

  /* ---- 分段栏（主人 2026-11-19：「QQ群」「私信」「B站」，全部消息也独立成页）---- */
  const seg = (k, label, n, tip) =>
    `<button class="chat-seg${TAB === k ? ' is-on' : ''}" data-act="chat-seg" data-tab="${k}" title="${esc(tip)}">${label}<span class="chat-seg-n">${n}</span></button>`;
  const segBar = `<div class="chat-segs">
    ${seg('all', '全部消息', num(all.length), '所有群 + 私聊 + 别的平台，混在一起按时间排')}
    ${seg('group', 'QQ群', num(gConvs.length), '只列群聊')}
    ${seg('private', '私信', num(privConvs.length + bdmPeople.length), '全平台私信在一起：QQ 私聊 + B站 + 别的平台')}
    ${seg('bili', 'B站', '→', 'B站主页 / 评论楼中楼 / 私信（原来左栏那一页，现在住这里）')}
  </div>`;

  /* B站段：整块 B站页（主页时间线 + 评论楼中楼 + 私信 + 收图/弹幕），
   * 左栏那个「B站」不再单占一格，从这里进（主人 2026-11-19「把左栏的b站挪进去」）。 */
  if (TAB === 'bili') {
    if (!S.bili.loaded && !S.bili.loading) loadBili();
    return segBar + `<div class="chat-bili" id="chatBiliHost"><div class="loading">读 B站 主页中…</div></div>`;
  }

  const dmErr = bdm.err
    ? `<div class="conv-empty" title="${esc(bdm.err)}">B站私信读不到：${esc(String(bdm.err).slice(0, 50))}</div>`
    : (bdm.loading && !bdmPeople.length ? `<div class="conv-empty">B站私信 · 读会话中…</div>` : '');

  let headLabel = '全部消息';
  let convRows = '';
  if (TAB === 'all') {
    headLabel = '全部会话';
    convRows = `<div class="conv-sec">最近说话 · ${num(realConvs.length + bdmPeople.length)} 个会话 · ${num(all.length)} 条</div>`
      + convItem('__all', '全部消息（一条时间线）', all.length, '所有群 + 私聊 + 别的平台混在一起', '全', 'all')
      + rowsOf([
        ...realConvs.map(([k, v]) => ({ t: v.t, html: qqRow(k, v) })),
        ...bdmPeople.map(s => ({ t: s.at, html: bdmRow(s) })),
      ].sort(byTime))
      + dmErr
      + (oConvs.length ? `<div class="conv-sec">早期记录 · ${num(sum(oConvs))} 条 · 没时间、没来源</div>`
        + oConvs.map(([k, v]) => qqRow(k, v)).join('') : '');
  } else if (TAB === 'group') {
    headLabel = 'QQ群';
    convRows = `<div class="conv-sec">群聊 · ${num(gConvs.length)} 个群 · ${num(sum(gConvs))} 条</div>`
      + convItem('__group', '全部群聊', sum(gConvs), `${gConvs.length} 个群的记录连起来看`, '群', 'all')
      + gConvs.map(([k, v]) => qqRow(k, v)).join('');
  } else {
    headLabel = '私信';
    const byPlat = platKinds.filter(k => k !== 'qq').map(k => `${platName(k)} ${num(grp(k).length)}`).join(' · ');
    convRows = `<div class="conv-sec">私信 · ${num(privConvs.length + bdmPeople.length)} 人${bdmSys ? ' · 另有 ' + num(bdmSys) + ' 条系统通知' : ''}${byPlat ? ' · ' + esc(byPlat) : ''}</div>`
      + convItem('__private', '全部私信（一条时间线）', sum(privConvs), 'QQ 私聊的记录连起来看（B站私信只读，点开单看）', '私', 'all')
      + rowsOf([
        ...privConvs.map(([k, v]) => ({ t: v.t, html: qqRow(k, v) })),
        ...bdmPeople.map(s => ({ t: s.at, html: bdmRow(s) })),
      ].sort(byTime))
      + dmErr;
  }
  const convBar = S.home.panel ? htmlHomePanel() : `<aside class="chat-convs">
    <div class="conv-head">${esc(headLabel)} <span class="dim">虚幻的视角</span><button class="chip" data-act="chat-bdm-reload" style="margin-left:auto;padding:0 7px;height:19px;font-size:11px" title="重新拉一次 B站私信会话（B站 接口连着打会 412，所以平时走缓存）">↻</button></div>
    ${convRows}
  </aside>`;

  const q = C.q.trim().toLowerCase();
  /* 筛选按「会话类型」判，不再拿 cv 跟字面量比 —— 服务端现在每条都带 conv（如 qq_30895294、
   * 群894917172），`cv !== '__private'` 这种老写法一条都匹配不上：
   *   「全部群聊」会漏掉群、「全部私信」直接是空的（2026-11-19 实测踩到）。 */
  let list = all.filter(m => {
    const cv = chatConvOf(m);
    if (C.conv === '__group') {
      const v = convMap.get(cv);
      if (!v || v.kind !== 'group') return false;
    } else if (C.conv === '__private') {
      const v = convMap.get(cv);
      if (!v || v.kind === 'group' || v.kind === 'orphan') return false;
    } else if (C.conv !== '__all' && cv !== C.conv) return false;
    if (C.onlyStar && !m.starred) return false;
    if (C.onlyBot && !m.bot) return false;
    // 情绪筛选（主人 2026-11-07 定：聊天记录能和情绪书联动）
    if (C.emo === 'has' && !m.emo) return false;
    if (C.emo === 'leak') { const lk = C.leakKeys || {}; if (!m.emo && !lk[chatKey(m)]) return false; }
    // 约定筛选：只看「生成了约定的那句话」（源消息反推命中）
    if (C.pact && !((C.pactSrc || {})[chatKey(m)])) return false;
    if (!q) return true;
    return (String(m.nick || '') + ' ' + String(m.text || '')).toLowerCase().indexOf(q) >= 0;
  });
  /* 按人合并：选中的是「已并进 B站私信的 QQ 会话」→ 把那个 B站会话的消息转成同构对象注入，
   * 和 QQ 记录按时间混排成一条（主人 2026-11-19「私信按人合并，点开看全部」）。
   * _bdm 标记让下面窗口化/渲染知道它是只读的 B站消息：不给星标/情绪/推理这些写操作按钮。
   * 只在具体人会话（p_）注入；__all/__private 这类聚合页仍各看各的，避免把只读消息混进可写记录。 */
  let bdmInjected = 0;
  if (/^p_/.test(String(C.conv))) {
    const bs = findBdmByPid(String(C.conv).slice(2));
    if (bs) {
      const box = (C.bdm.msgs || {})[String(bs.uid)];
      const who = bdmWho(bs, bs.uid);
      if (box && !box.err && (box.list || []).length) {
        box.list.forEach(m => {
          const type = Number(m.type) || 0;
          const raw = String(m.text || '').trim();
          const recall = type === 5 || /^\d{16,20}$/.test(raw);   // 撤回提醒，正文是 msg_key
          list.push({
            _bdm: true, uid: String(bs.uid), plat: 'bili',
            t: Number(m.t) || 0,
            nick: m.mine ? (C.bot || '虚幻') : who,
            text: recall ? `（${m.mine ? '这边' : '对方'}撤回了一条消息）` : (raw || `（${type} 类型消息，没有文字）`),
            bot: !!m.mine, mine: !m.mine,   // B站私信里「我方发的」= 虚幻 → bot 气泡；对方 → mine 气泡
            recall: !!recall,
          });
          bdmInjected++;
        });
        list.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
      }
    }
  }
  const hit = list.length;
  // 窗口化渲染（QQ 逻辑，主人 2026-11-14 定）：DOM 里只保留一个固定窗口（上限 = 显示设置里的每页条数），
  // 往上翻到顶再取更早的一页、同时把窗口另一头溢出的裁掉；往下翻到底再取更新的一页、裁掉最顶上。
  // 这样无论历史多长，DOM 节点数恒定，不卡（旧的「pages×条数」会越翻越堆、越卡）。
  const SHOW_LIMIT = Math.max(20, Number((C.cfg || {}).chatShowLimit) || C.limit || 200);
  const WINDOW = SHOW_LIMIT;                           // DOM 里最多这么多条
  const PAGE = Math.min(WINDOW, 120);                  // 每次翻到边再加载/裁掉一页
  if (!S.chat.win[C.conv]) S.chat.win[C.conv] = { start: Math.max(0, list.length - WINDOW), end: list.length };
  const w = S.chat.win[C.conv];
  w.start = Math.max(0, Math.min(w.start, Math.max(0, list.length - 1)));
  w.end = Math.max(w.start + 1, Math.min(list.length, w.end));
  if (w.end - w.start > WINDOW) w.end = w.start + WINDOW;
  if (w.end > list.length) { w.end = list.length; if (w.end - w.start > WINDOW) w.start = Math.max(0, w.end - WINDOW); }
  // 停在底部（或刚重置）时窗口始终贴着最新一屏：新消息来了能直接看到，不被窗口卡在旧位置
  if (C.pinBottom || (C.pos[C.conv] && C.pos[C.conv].bottom)) {
    w.end = list.length;
    w.start = Math.max(0, w.end - WINDOW);
  }
  S.chat.winTotal[C.conv] = list.length;
  C.hitTotal = hit;                                    // 给 chatMore 判断「还有没有更早的」
  C.limitNow = WINDOW;
  const winList = list.slice(w.start, w.end);
  const older = w.start;                               // 窗口上面还有多少条更早的
  const newer = list.length - w.end;                   // 窗口下面还有多少条更新的
  const olderTip = (older > 0 || newer > 0)
    ? `<div class="small dim" style="text-align:center;padding:8px 0">`
      + (older > 0 ? `↑ 上面还有 ${num(older)} 条更早的，往上翻到顶自动加载` : '')
      + (older > 0 && newer > 0 ? '　' : '')
      + (newer > 0 ? `↓ 下面还有 ${num(newer)} 条更新的（往下翻回去看）` : '')
      + `</div>`
    : '';
  /* 2026-11-16：她原话「聊天记录页面上方的选项卡也没必要」「做成选择后直接显示如兜底、
   * 显示设置栏」「汇总改成小图标，和左侧栏类似的碰到才显示全」。
   * 12 个 chip 一个不删，默认折成一个小图标；碰到展开；左栏选过任一项后直接摊开。 */
  const chipBtns = `
    <button class="chip${C.onlyStar ? ' is-on' : ''}" data-act="chat-onlystar" title="星标 = 这句直接算已总结，联动话题日志">★ 只看星标</button>
    <button class="chip${C.onlyBot ? ' is-on' : ''}" data-act="chat-onlybot">只看她说的</button>
    <button class="chip${C.emo === 'has' ? ' is-on' : ''}" data-act="chat-emo-has" title="只看已经判出 / 手改过情绪的记录">有情绪</button>
    <button class="chip${C.emo === 'leak' ? ' is-on' : ''}" data-act="chat-emo-leak" title="只看「能判出情绪但还没记」的漏判">漏判</button>
    <button class="chip" data-act="chat-emo-scan" title="扫一遍聊天记录，找出「能判出情绪但还没记」的漏判，预览后可一键加进去">🔍 补漏判</button>
    <button class="chip${C.pact ? ' is-on' : ''}" data-act="chat-pact" title="只看「生成了约定的那句话」；本会话相关的约定也会在消息上方列出来">约定 ${num((pactsForConv(C.conv) || []).length)}</button>
    <button class="chip${(C.issues || []).length ? ' is-on' : ''}" data-act="chat-issues">待修复 ${num((C.issues || []).length)}</button>
    <button class="chip" data-act="chat-log" title="按天工作日志：今天真发生过的事，只追加不覆盖，不进提示词">工作日志</button>
    <button class="chip" data-act="chat-show-set" title="图片翻译文字显示多少字、页面显示多少条、机器人读多少条上下文，都在这改（存机器人端，改完两边一起生效）">⚙ 显示设置</button>
    <button class="chip" data-act="chat-reply-toggle" title="一键关掉全部 / 群 / 私聊的回话：关掉 = 虚幻不看也不回（连聊天记录都不落），下一句生效">💤 回复总开关</button>
    <button class="chip" data-act="chat-fb-open" title="答不出来时说什么：加任意多条兜底，按全部 / 某个群 / 私聊 / 某个人 / 平台分别配，能删能改能停用">🛟 兜底</button>
    `;
  const chips = `<div class="pact-bar${S.home.sel ? ' is-selected' : ''}">
    <input class="field" id="chat-q" placeholder="搜聊天内容 / 人名" value="${esc(C.q)}" style="width:230px">
    <div class="chip-fold" data-sel="${S.home.sel ? '1' : ''}" title="碰到展开全部设置：星标 / 情绪 / 约定 / 兜底 / 显示设置 / 总开关；选中的那一项由左侧面板直接显示">
      <span class="chip-fold__icon">⋯</span><div class="chip-fold__row">${chipBtns}</div>
    </div>
    <span class="small dim" style="margin-left:auto">${/^bdm_/.test(String(C.conv))
      ? (() => { const b = (C.bdm.msgs || {})[String(C.conv).slice(4)]; return 'B站私信 · 只读' + (b && b.list ? ' · 这个会话共 ' + num(b.list.length) + ' 条（最近 100 条）' : ''); })()
      : `已读 ${num(C.list.length)} 条（库里共 ${num(C.total || C.list.length)}）${bdmInjected ? ' · 含 B站私信 ' + num(bdmInjected) + ' 条（只读）' : ''}，现在显示第 ${num(w.start + 1)}–${num(w.end)} / 共 ${num(list.length)} 条（窗口上限 ${num(WINDOW)}）`}</span>
  </div>`;
  let day = '';
  // 图片翻译文字（［图：…］）默认露多少字，从机器人端 config 读。
  // 原来写死 180，图上带题带答案的一大段只露开头，得点「展开全文」才看得到为什么选 D。
  // 填 0 = 整段全展开，不再折；「展开全文 / 收起」照旧留着。
  const CLIP = Math.max(0, Number((C.cfg || {}).imgDescChars) || 0);
  const clipOn = CLIP > 0;
  const rows = winList.map(m => {
    const d = fmtDay(m.t);
    const sep = d !== day ? (day = d, `<div class="msg-day">${esc(d)}</div>`) : '';
    // 注入的 B站私信（按人合并进来的）：只读气泡，只给复制，星星/情绪/推理/标错这些会写 QQ 数据的按钮都不给
    if (m._bdm) {
      const nk = String(m.nick || '?').replace(/[\u2066-\u2069\u200e\u200f]/g, '');
      const avPlat = 'bili', avId = String(m.uid || '');
      const avCls = m.mine && avId ? ' has-av' : '';
      const avVar = m.mine && avId ? ` style="--msg-avatar:url('xuh://avatar/bili/${esc(avId.replace(/[^0-9A-Za-z_.-]/g, ''))}')"` : '';
      return sep + `<div class="msg ${m.bot ? 'is-bot' : 'is-mine'} is-bdm${m.recall ? ' is-recall' : ''}${avCls}"${avVar}>
        <span class="msg-t">${esc(fmtTime(m.t).slice(11) || '—')}</span>
        <span class="msg-n">${esc(nk)}<span class="msg-plat">B站</span></span>
        <span class="msg-x">${esc(m.text)}</span>
        <span class="msg-acts"><button class="msg-copy" data-act="chat-copy-text" data-text="${esc(m.text)}" title="复制这句原文">复制</button></span>
      </div>`;
    }
    const cls = m.bot ? 'is-bot' : (m.mine ? 'is-mine' : '');
    // 标签：群里显示「群 894917172」，QQ 私聊显示「私聊」，别的平台显示平台名（B站 / 小红书…）
    const tag = m.scope
      ? (m.scope.indexOf('私聊') === 0 ? '私聊' : m.scope.replace(/^群/, '群 '))
      : (m.plat && m.plat !== 'qq' ? (m.platLabel || m.plat) : '');
    const nick = String(m.nick || '?').replace(/[\u2066-\u2069\u200e\u200f]/g, '');   // 清掉方向控制符，不然昵称会被挤成两行
    const full = String(m.text || '');
    const key = chatKey(m);
    const isOpen = C.open && C.open.has(key);
    const shown = clipOn && full.length > CLIP && !isOpen ? full.slice(0, CLIP) : full;
    const more = clipOn && full.length > CLIP
      ? `<span class="msg-more" data-act="chat-more" data-key="${esc(key)}">${isOpen ? '收起' : '展开全文（' + full.length + ' 字）'}</span>`
      : '';
    // 已加星点 ★ 仍是「一键取消」；没加星点 ☆ 先开弹层，可以写理由、多选上下文
    const star = `<button class="msg-star${m.starred ? ' is-on' : ''}" data-act="${m.starred ? 'chat-star' : 'chat-star-open'}" data-key="${esc(key)}" title="${m.starred ? '取消星标：连带收回话题日志里那条「已总结」' : '加星标：可写为什么值得学、可多选上下文'}">${m.starred ? '★' : '☆'}</button>`;
    // 复制这一句的原文（她 2026-11-09 要能复制客户端里的文字）：只给正文，不带时间、昵称、按钮
    const copyBtn = `<button class="msg-copy" data-act="chat-copy" data-key="${esc(key)}" title="复制这句话的原文（不带时间、昵称、这些按钮）">复制</button>`;
    const issue = `<button class="msg-issue" data-act="chat-issue" data-key="${esc(key)}" title="标为错误：加待修复问题并移除这条记录">标错</button>`;
    // 情绪徽标（主人 2026-11-07 定：聊天记录 ↔ 情绪书联动）。有情绪显叶名，没情绪显「＋情绪」可加。
    const emoBtn = m.emo
      ? `<button class="msg-emo ${m.emo.source === 'review' ? ' is-wrong' : (m.emo.source === 'user' ? ' is-user' : '')}" data-act="chat-emo" data-key="${esc(key)}" title="情绪：${esc(m.emo.leaf)}${m.emo.word ? '（命中「' + esc(m.emo.word) + '」）' : ''} · 点一下改 / 看应对">💢${esc(m.emo.leaf)}</button>`
      : `<button class="msg-emo is-add" data-act="chat-emo" data-key="${esc(key)}" title="给这条加情绪（用情绪书判 / 手选叶）">＋情绪</button>`;
    // 「推理」只挂在虚幻自己说的那句上：轨迹记录的是「这一轮为什么发出这句」。
    const traceBtn = m.bot ? `<button class="msg-issue msg-trace" data-act="chat-trace" data-key="${esc(key)}" title="看这一轮代码实际做了什么：命中场合、注入了哪些段、用了哪个模型、最后发了什么">推理</button>` : '';
    // 约定来源徽标：这条消息反推出来「生成了」某条约定（数据里没有源键，靠 scope/qq + 时间推断）。点开看是哪条。
    const srcPacts = (C.pactSrc || {})[key];
    const pactBtn = (srcPacts && srcPacts.length)
      ? `<button class="msg-pact" data-act="chat-pact-src" data-id="${esc(srcPacts[0])}" title="这条生成了 ${num(srcPacts.length)} 条约定（推断来源）· 点开看">📜约</button>`
      : '';
    // 对方头像：按「平台 + 号」取（同一个人两个号各有各的头像），没查到号时 CSS 退回人形剪影
    const avPlat = m.avPlat || (m.uid ? 'qq' : '');
    const avId = m.avId || m.uid || '';
    const avCls = (!m.bot && avId) ? ' has-av' : '';
    const avVar = (!m.bot && avId)
      ? ` style="--msg-avatar:url('xuh://avatar/${esc(avPlat)}/${esc(String(avId).replace(/[^0-9A-Za-z_.-]/g, ''))}')"`
      : '';
    /* 回复别人的具体某条（主人 2026-11-07：「接着做QQ页面，没有回复别人的具体某条」）。
     * 日志里一直有「↩回复@昵称：片段↩」，服务端 2026-11-08 起把它带出来了 → 这里照 QQ 的样子，
     * 在气泡顶上贴一小条引用，点一下跳到被回复的那条原文。 */
    const quote = m.replyTo
      ? `<span class="msg-quote" data-act="chat-jump" data-frag="${esc(String(m.replyTo.frag || '').slice(0, 24))}" title="这句是回他的：点一下跳到被回复的那条"><b>${esc(String(m.replyTo.nick || '?').slice(0, 14))}</b>：${esc(String(m.replyTo.frag || '').slice(0, 44))}</span>`
      : '';
    // 这一句花了多少 token（2026-11-11 主人令）：只给虚幻自己说的那句，数字来自接口返回的 usage，
    // 和同一会话里时间最近的一笔调用匹配（±90 秒）；对不上的老记录不显示，不估算。
    const tok = (m.bot && m.tok)
      ? `<span class="msg-tok" title="这一轮模型调用：输入 ${num(m.tok.in)} + 输出 ${num(m.tok.out)} tokens，折合 ${esc(fmtRmb(m.tok.rmb))}">${num(m.tok.total)} tok</span>`
      : '';
    /* 媒体（2026-11-23 主人令「发出去的要能看缩略图、能播放」）：
     * 服务端从正文里摘出 ［媒体:文件名］，这里按类型渲染图片 / 播放器 / 文件卡。
     * 文件真身在 src/data/client-media/，走 xuh://media/<文件名>。 */
    const mediaHtml = (m.media || []).map(x => {
      const u = 'xuh://media/' + encodeURIComponent(String(x.file || ''));
      if (x.kind === 'image') return `<img class="msg-media" src="${u}" data-act="msg-media" data-url="${u}" title="点一下用系统看图打开原图">`;
      if (x.kind === 'video') return `<video class="msg-media msg-media--v" src="${u}" controls preload="metadata"></video>`;
      if (x.kind === 'audio') return `<audio class="msg-media msg-media--a" src="${u}" controls preload="none"></audio>`;
      return `<span class="msg-filecard">📄 ${esc(x.file)}</span>`;
    }).join('');
    /* 点名字 = 就地查 / 改这个人（主人 2026-11-13）：不跳页、不丢当前会话位置。
     * 朋友录（名字/代称/好感/喜好厌恶/跟他的约定）和记录的（按人筛）在同一个弹层里。 */
    const canOpen = !m.bot && !!m.uid;
    const nTitle = esc((m.whoName || nick) + (tag ? ' · ' + tag : ''));
    return sep + `<div class="msg ${cls}${m.starred ? ' is-starred' : ''}${avCls}"${avVar} id="msg-${esc(key)}">
      <span class="msg-t">${esc(fmtTime(m.t).slice(11) || '—')}</span>
      <span class="msg-n${canOpen ? ' is-link' : ''}"${canOpen ? ` data-act="chat-person" data-uid="${esc(m.uid)}"` : ''} title="${canOpen ? nTitle + ' · 点一下查 / 改他的朋友录、记录的' : nTitle}">${esc(nick)}</span>
      <span class="msg-x">${quote}${esc(shown)}${more}${m.to ? `<span class="msg-to">→ ${esc(m.to)}</span>` : ''}${tok}${mediaHtml}</span>
      <span class="msg-acts">${copyBtn}${star}${emoBtn}${pactBtn}${traceBtn}${issue}</span>
    </div>`;
  }).join('');
  /* 选中的是 B站 私信会话（bdm_<UID>）：左栏照样是「QQ 会话 + B站私信」同一列，
   * 右侧换成这个人的 B站私信原文。只读 —— 发消息还在 B站 / AstrBot 那边，这里不动写接口。 */
  if (/^bdm_/.test(String(C.conv))) {
    return segBar + chips + `<div class="chat-wrap">${convBar}<div class="chat-split" data-act="chat-split" title="按住拖动，调人物列表 / 消息记录的宽度（会记住）"><i></i></div><div class="msgs">${htmlChatBdmBody()}</div>${htmlChatDock()}</div>` + htmlChatModal() + htmlReviewModal() + htmlChatPerson() + htmlStateModal();
  }
  return segBar + chips + `<div class="chat-wrap">${convBar}<div class="chat-split" data-act="chat-split" title="按住拖动，调人物列表 / 消息记录的宽度（会记住）"><i></i></div><div class="msgs">${olderTip}${rows || '<div class="empty">这个会话还没有记录。</div>'}</div>${htmlComposer()}${htmlChatDock()}</div>` + htmlChatModal() + htmlReviewModal() + htmlChatPerson() + htmlStateModal();
}

/* ===========================================================================
 * 客户端发言（2026-11-23 主人令）
 * ---------------------------------------------------------------------------
 * 她原话：「给我的虚幻客户端加可以直接发送全类型消息和QQ一样的功能」「我要的是走QQ，不是绕过」。
 *
 * 链路：这里打的字 / 挑的图 → POST /api/panel/send → 机器人进程 8898 →
 *       qq.injectClientMessage 当成「主人私聊」喂进 onMessage → 回复照旧发到她的 QQ 私聊。
 * 所以：不是另开一个聊天系统，客户端只是「替主人在 QQ 里说这句话」的另一个入口。
 *
 * 只开在「主人私聊」这一个会话：其它会话（群 / 群友 / B站私信）不给输入条 ——
 * 虚幻的号在群里说话就是虚幻在说话，不能拿它当万能发信器。
 * =========================================================================== */
function compOf() {
  const C = S.chat;
  if (!C.comp) C.comp = { text: '', atts: [], busy: false, hint: '', drag: false };
  return C.comp;
}

/* 当前会话是不是「跟主人的 QQ 私聊」：判据全用日志里现成的字段，不另存一份主人 id。 */
function compConvOk() {
  const C = S.chat;
  const cv = String(C.conv || '');
  if (!cv || cv.indexOf('__') === 0) return false;
  if (cv.indexOf('p_') !== 0) return false;                 // 只认私聊会话键
  const rows = (C.list || []).filter(m => chatConvOf(m) === cv);
  if (!rows.length) return false;
  if (String(rows[0].convKind || '') !== 'qq') return false; // B站私信那边还是只读
  return rows.some(m => m.mine);                            // 这个会话里有主人自己说过的话
}

function compKindOf(name) {
  const n = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/.test(n)) return 'image';
  if (/\.(mp4|mov|mkv|webm|avi|flv)$/.test(n)) return 'video';
  if (/\.(mp3|wav|m4a|amr|silk|flac|ogg|aiff|aac)$/.test(n)) return 'audio';
  return 'file';
}
const COMP_ICON = { image: '🖼', video: '🎬', audio: '🎤', file: '📄' };
const COMP_KIND = { image: '图片', video: '视频', audio: '语音', file: '文件' };
function compSize(n) {
  n = Number(n) || 0;
  return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n > 1024 ? Math.round(n / 1024) + 'KB' : (n ? n + 'B' : '');
}

function compAttsHtml() {
  const K = compOf();
  return K.atts.map((a, i) => `<span class="cp-att cp-att--${esc(a.kind)}" title="${esc(COMP_KIND[a.kind] || '文件')}：${esc(a.name)}${a.size ? ' · ' + esc(compSize(a.size)) : ''}"><b>${COMP_ICON[a.kind] || '📄'}</b>${esc(a.name)}<i data-act="comp-att-del" data-i="${i}" title="不发这个">×</i></span>`).join('');
}

function htmlComposer() {
  if (!compConvOk()) return '';
  const K = compOf();
  return `<div class="chat-composer">
    <div class="cp-atts">${compAttsHtml()}</div>
    <div class="cp-row">
      <button class="cp-tool" data-act="comp-pick" data-kind="image" title="发图片（也可以直接拖进来，或 Ctrl+V 贴图）">🖼</button>
      <button class="cp-tool" data-act="comp-pick" data-kind="video" title="发视频">🎬</button>
      <button class="cp-tool" data-act="comp-pick" data-kind="audio" title="发语音：先转成文字给她看，她收到的是「语音 + 你说的内容」">🎤</button>
      <button class="cp-tool" data-act="comp-pick" data-kind="file" title="发文件：她会真去读里面的内容（文本直接读，其它交给 DSH），大文件要等一会">📎</button>
      <button class="cp-send" data-act="comp-send"${K.busy ? ' disabled' : ''} title="Enter 也能发">${K.busy ? '发送中…' : '发送'}</button>
      <textarea id="cpInput" class="cp-input" rows="1" placeholder="跟她说点什么…（Enter 发送，Shift+Enter 换行）">${esc(K.text)}</textarea>
    </div>    <div class="cp-hint">${esc(K.hint)}</div>
  </div>`;
}

/* 只重画会变的那几块：整页重绘会把正在打字的输入框冲掉（光标、内容全没）。 */
function paintComp() {
  const box = document.querySelector('.chat-composer');
  if (!box) return;
  const K = compOf();
  const atts = box.querySelector('.cp-atts');
  if (atts) atts.innerHTML = compAttsHtml();
  const btn = box.querySelector('.cp-send');
  if (btn) { btn.disabled = !!K.busy; btn.textContent = K.busy ? '发送中…' : '发送'; }
  const hint = box.querySelector('.cp-hint');
  if (hint) { hint.textContent = K.hint || ''; hint.classList.toggle('is-err', /没|失败|超时|读不出/.test(K.hint || '')); }
}

function compAdd(files, kind) {
  const K = compOf();
  let n = 0;
  for (const f of (files || [])) {
    const p = String((f && f.path) || '');
    if (!p) continue;
    if (K.atts.length >= 9) { toast('一次最多带 9 个，多的分两次发'); break; }
    const name = String(f.name || p.split('/').pop() || '文件');
    K.atts.push({ path: p, name, size: Number(f.size) || 0, kind: kind || compKindOf(name) });
    n++;
  }
  if (n) { K.hint = ''; paintComp(); }
  return n;
}

async function compPick(kind) {
  let r = null;
  try { r = await window.xuh.pickFiles(kind || 'file'); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || r.ok === false) { if (r && r.error) toast(r.error, true); return; }
  compAdd(r.files, kind && kind !== 'file' ? kind : '');
}

async function compPasteImage() {
  let r = null;
  try { r = await window.xuh.clipImage(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { toast((r && r.error) || '剪贴板里没有图片', true); return; }
  compAdd([r], 'image');
}

/* 发出去：一条请求到机器人进程。图片/视频/语音/文件的读取都在那一步同步做完，
 * 所以带文件或语音时要等（界面上显示「在读文件 / 转写语音」）。 */
async function compSend() {
  const K = compOf();
  if (K.busy) return;
  const text = String(K.text || '').trim();
  if (!text && !K.atts.length) { K.hint = '写点什么，或者带个图 / 文件'; paintComp(); return; }
  if (!compConvOk()) { toast('这个会话不能发', true); return; }
  const long = K.atts.some(a => a.kind === 'file' || a.kind === 'audio');
  K.busy = true;
  K.hint = long ? '发送中…（在读文件 / 转写语音，可能要等十几秒）' : '发送中…';
  paintComp();
  let r = null;
  try {
    r = await window.xuh.api('POST', '/api/panel/send', {
      text,
      files: K.atts.map(a => ({ path: a.path, name: a.name, kind: a.kind })),
    });
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  K.busy = false;
  if (!r || r.ok === false || r.error) {
    K.hint = '没发出去：' + ((r && (r.error || r.__raw)) || '未知原因');
    paintComp();
    toast(K.hint, true);
    return;
  }
  K.text = ''; K.atts = [];
  const ta = document.querySelector('#cpInput');
  if (ta) ta.value = '';
  const miss = (r.notes || []).filter(n => n.asrError || n.digestError || n.ok === false);
  K.hint = miss.length
    ? '发出去了；这几样没读出来（她只看得到文件名）：' + miss.map(n => n.name).join('、')
    : '发出去了，等她想一想…（回复发到你的 QQ 私聊，这里同步显示）';
  paintComp();
  /* 这一句进记录后签名就变了，pollChatNew 到点会自己重拉；这里再补一次，免得等最多 8 秒。 */
  setTimeout(() => { try { loadChat(); } catch {} }, 1200);
}

/* ---- 输入条的事件（只认自己那几个 id / data-act，不动别的页） ---- */
view.addEventListener('input', e => {
  const t = e.target;
  if (t && t.id === 'cpInput') compOf().text = t.value;
});
view.addEventListener('keydown', e => {
  const t = e.target;
  if (!t || t.id !== 'cpInput') return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); compSend(); }
});
view.addEventListener('paste', e => {
  const t = e.target;
  if (!t || t.id !== 'cpInput') return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let hasImg = false;
  for (const it of items) if (String(it.type || '').indexOf('image/') === 0) hasImg = true;
  if (hasImg) { e.preventDefault(); compPasteImage(); }
});
view.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'comp-pick') { compPick(b.dataset.kind); return; }
  if (act === 'comp-att-del') { compOf().atts.splice(Number(b.dataset.i), 1); paintComp(); return; }
  if (act === 'comp-send') { compSend(); return; }
  if (act === 'msg-media') {
    /* 图 / 视频 / 语音点一下用系统默认程序打开原文件（和 QQ 里「打开」一个意思） */
    const u = String(b.dataset.url || '');
    const name = decodeURIComponent(u.replace(/^xuh:\/\/media\//, ''));
    if (name) window.xuh.openMedia(name);
    return;
  }
});
/* 拖文件进来：Electron 32+ 拿不到 File.path，只能让 preload 里的 webUtils 转真实路径 */
view.addEventListener('dragover', e => {
  const box = document.querySelector('.chat-composer');
  if (!box) return;
  e.preventDefault();
  box.classList.add('is-drag');
});
view.addEventListener('dragleave', e => {
  const box = document.querySelector('.chat-composer');
  if (box && !box.contains(e.relatedTarget)) box.classList.remove('is-drag');
});
view.addEventListener('drop', e => {
  const box = document.querySelector('.chat-composer');
  if (!box) return;
  e.preventDefault();
  box.classList.remove('is-drag');
  const fl = (e.dataTransfer && e.dataTransfer.files) || [];
  const files = [];
  for (const f of fl) {
    const p = window.xuh.pathForFile(f);
    if (p) files.push({ path: p, name: f.name, size: f.size });
  }
  if (files.length) compAdd(files, '');
  else toast('拖进来的不是本机文件', true);
});
/* 拖到窗口别处时别让 Electron 当成「用浏览器打开这个文件」 */
document.addEventListener('dragover', e => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) e.preventDefault(); });
document.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) e.preventDefault(); });

/* 「显示设置」里的保健提醒（2026-11-10 她定：只要时间、次数、分人打开关闭三组）。
 * 数据同源：打开弹层时 GET /api/healthremind 拿 cfg + people，保存时数值 POST /api/healthremind、
 * 分人开关 POST /api/healthremind/pact，都只传变动项；四池与逐句说法仍在「保健提醒」页改。
 * 字段名与单位复用 HR_NUMS，不另抄一份标签。 */
const HR_SET_HOURS = ['workStartHour', 'workEndHour', 'quietStartHour', 'quietEndHour'];
const HR_SET_COUNTS = ['dailyMin', 'dailyMax'];

function hrLabelOf(k) {
  const it = HR_NUMS.find(x => x[0] === k);
  return it ? [it[1], it[2]] : [k, ''];
}

/* 各平台输出字数上限（2026-11-17 主人令）：默认=平台上限、手填不能超、改版靠测。
 * 显示当前值+来源+手设框；B站两项能点「测」（评论发到私密视频、私信发到主人）；
 * QQ 测试走私聊命令「测上限」，这里给提示；qzone 只显示不手设。 */
function htmlPlatLimitsInSet() {
  const head = `<h3 style="margin-top:20px">输出字数上限（跟随平台）</h3>
    <div class="modal-line">默认字数 = 平台本身的限制，会话 ⚙ 里手填的也不能超过它。平台改版后：缩减会自动告警；增加靠「测」——实测值记下来，全链路跟着变。</div>`;
  const L = S.chat.platLimits;
  if (!L) return head + `<div class="modal-note">上限表读出中…</div>`;
  const srcText = s => s === 'measured' ? '实测校正' : s === 'manual' ? '手设' : s === 'community' ? '社区口径（T2）' : '现网值（未实测）';
  const one = (key, label, tip, canSet, canProbe) => {
    const o = L[key] || { cap: 0, source: 'initial' };
    const setBox = canSet
      ? `<input class="field" id="pl-cap-${key}" type="number" min="20" max="100000" value="${esc(o.cap)}" style="width:110px" title="手设上限，不能超过平台真实限制；测过之后以实测为准">`
      : `<span class="dim">${esc(o.cap)} 字（记录值，不参与裁切）</span>`;
    return `<div class="modal-line" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <b style="min-width:90px">${esc(label)}</b>${setBox}
      <span class="small dim">来源：${esc(srcText(o.source))}${o.measuredAt ? ' · ' + esc(String(o.measuredAt).slice(0, 10)) : ''}</span>
      ${canProbe ? `<button class="chip" data-act="pl-probe" data-key="${key}" title="${esc(tip)}">${S.chat.plProbe && S.chat.plProbe.busy === key ? '测…' : '测上限'}</button>` : ''}
    </div>`;
  };
  const probeTip = S.chat.plProbe && S.chat.plProbe.msg
    ? `<div class="modal-note" style="color:${/失败|错|没成功/.test(S.chat.plProbe.msg) ? '#c33' : '#2a7'}">${esc(S.chat.plProbe.msg)}</div>` : '';
  const V = S.chat.platVersions;
  const verBlock = `<h3 style="margin-top:20px">改版追踪（版本号）</h3>
    <div class="modal-line">记着每个平台最近一次见到的版本号，变了就自动重测该平台字数上限并写回。首次只记基线、不触发；每 6 小时查一次。</div>`
    + (V
      ? `<div class="modal-line"><b style="min-width:90px">QQ(NapCat)</b><span class="small dim">版本：${esc(V.qq && V.qq.version || '还没采到')}${V.qq && V.qq.seenAt ? ' · ' + esc(String(V.qq.seenAt).slice(0, 16).replace('T', ' ')) : ''}</span></div>
         <div class="modal-line"><b style="min-width:90px">B站网页</b><span class="small dim">版本：${esc(V.bili && V.bili.version || '还没采到')}${V.bili && V.bili.seenAt ? ' · ' + esc(String(V.bili.seenAt).slice(0, 16).replace('T', ' ')) : ''}</span></div>`
      : `<div class="modal-note">版本号读出中…</div>`)
    + `<div class="modal-note">QQ 读的是 NapCat 框架版本（不是 QQ 客户端本身）；B站读首页的 grayVersion + 构建号。采不到时跳过、不误判。</div>`;
  /* 逛空间的风控额度（2026-11-17 主人令「适用上限规则 = 按版本更新重测」）：
   * 和字数上限同一张表、同一份来源标记，只是单位不是「字」。只显示不手设——
   * 这三项的值必须来自实测或真实撞顶记录，手填就成了我编的数字。 */
  const quota = (key, label, unit) => {
    const o = L[key] || { cap: 0, source: 'initial' };
    return `<div class="modal-line" style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <b style="min-width:90px">${esc(label)}</b><span class="dim">${esc(o.cap)} ${unit}</span>
      <span class="small dim">来源：${esc(srcText(o.source))}${o.measuredAt ? ' · ' + esc(String(o.measuredAt).slice(0, 10)) : ''}</span>
      ${o.note ? `<div class="small dim" style="flex-basis:100%;padding-left:98px;opacity:.7">${esc(o.note)}</div>` : ''}
    </div>`;
  };
  const quotaBlock = `<h3 style="margin-top:16px">逛空间节奏（跟随平台）</h3>
    <div class="modal-line">这两项是平台侧的真实约束，值是社区公开口径（第三方实现与风控说明，非腾讯官方文档，标 T2）。运行时代码硬执行。两条评论之间的间隔不在这张表里：它跟发说说共用你在空间页设的那一个间隔。</div>`
    + quota('qzonePerDay', '每天最多评', '条')
    + quota('qzoneVisitGap', '逛不同人至少隔', '秒')
    + `<div class="modal-note">不主动试探（官方规则：30 天内被「禁止他人访问」3 次以上不支持解封，为测数字冒这个险不值）。只做校正：真撞到限流时，脚本会把当时的时间和额度记下来，下轮按真实数据覆盖成「实测校正」。私聊发「测空间上限」可立刻校对一次（不发请求）。</div>`;
  return head
    + one('qq', 'QQ 聊天', 'QQ 上限要在主人 QQ 私聊里发「测上限」（这里测不了：QQ 发送走机器人连接，不在本进程）', true, false)
    + one('biliC', 'B站评论', '发几条测试串到虚幻自己的私密视频（BV 号已记在服务端），按成功/失败逼近上限', true, true)
    + one('biliD', 'B站私信', '发几条测试串到主人的 B站私信，按成功/失败逼近上限', true, true)
    + one('qzone', 'QQ 动态', '发测试说说、发完立刻自删；在主人 QQ 私聊里发「测动态上限」', false, false)
    + probeTip
    + `<div class="modal-note">QQ 测试：私聊虚幻发「测上限」（动态是「测动态上限」）。测试串会发到你的私信 / 私密视频，测完按实际结果写回这里。</div>`
    + quotaBlock
    + verBlock;
}

function htmlHrNumsInSet() {
  const head = `<h3 style="margin-top:20px">提醒 · 保健提醒</h3>
    <div class="modal-line">和左侧「提醒 → 保健提醒」读的是同一份配置，改完机器人热读、不用重启；四个池和逐句说法在那一页改。</div>`;
  if (S.chat.hrLoadErr) return head + `<div class="modal-note">保健设置读不出来：${esc(S.chat.hrLoadErr)}（上面四项照常能改）</div>`;
  if (!S.chat.hrCfg) return head + `<div class="modal-note">保健设置读出中…</div>`;
  const c = S.chat.hrCfg;
  const num = k => {
    const rg = HR_NUM_RANGE[k] || [0, 999999];
    const lb = hrLabelOf(k);
    return `<label class="modal-label">${esc(lb[0])}（${esc(lb[1])}）</label>
      <input class="field" id="set-hr-${esc(k)}" type="number" min="${rg[0]}" max="${rg[1]}" step="1" value="${esc(c[k] == null ? '' : c[k])}" style="width:100%">
      <div class="modal-note">可填 ${rg[0]}~${rg[1]}</div>`;
  };
  const people = (S.chat.hrPeople || []).map(p => {
    const on = !(p.override && p.override.enabled === false);
    return `<label class="hr-check" style="margin-top:6px"><input type="checkbox" id="set-hr-who-${esc(p.key)}" ${on ? 'checked' : ''}>给「${esc(p.name)}」发提醒（${esc(p.qq || '没配 QQ')}）</label>`;
  }).join('');
  return head
    + '<div class="hr-pool-note">时间</div>' + HR_SET_HOURS.map(num).join('')
    + '<div class="hr-pool-note">次数</div>' + HR_SET_COUNTS.map(num).join('')
    + '<div class="hr-pool-note">分人打开 / 关闭</div>'
    + (people || '<div class="modal-note">没读到人（主人 / 欧尼酱的 QQ 号没配）</div>')
    + '<div class="modal-note">取消勾选 = 只对这个人不发，另一个人照常；总开关关着时谁都不发。</div>';
}

/* 回复总开关（2026-11-11 主人定）：把聊天记录里出现过的会话键按 kind 分桶，
 * 算每个粒度下「已关（off:true，不看也不回）」和「总数」。all = 群 ∪ 私聊，不含 B站。 */
function replyToggleState() {
  const map = { group: new Set(), qq: new Set() };
  (S.chat.list || []).forEach(m => {
    const k = m.scopeKey, kind = m.convKind;
    if (k && (kind === 'group' || kind === 'qq')) map[kind].add(k);
  });
  const calc = set => {
    let off = 0;
    set.forEach(k => { const o = S.chat.convSettings[k]; if (o && o.off) off++; });
    return { off, total: set.size };
  };
  const all = new Set([...map.group, ...map.qq]);
  return { all: calc(all), group: calc(map.group), qq: calc(map.qq) };
}

/* 批量应用：scope = all/group/qq；turn = on(清 off 标志→回到 reply/black 各自决定) / off(设 off:true 不看也不回)。
 * 主人的私聊由服务端排除，前端也顺手从 keys 去掉，让界面计数和后端一致。 */
async function replyBulk(scope, turn) {
  const map = { group: new Set(), qq: new Set() };
  (S.chat.list || []).forEach(m => {
    const k = m.scopeKey, kind = m.convKind;
    if (k && (kind === 'group' || kind === 'qq')) map[kind].add(k);
  });
  let keys = [];
  if (scope === 'all') keys = [...map.group, ...map.qq];
  else if (scope === 'group') keys = [...map.group];
  else if (scope === 'qq') keys = [...map.qq];
  if (!keys.length) { toast('这个分类下没有会话可改'); return; }
  const r = await window.xuh.api('POST', '/api/conv/setbulk', { keys, off: turn === 'off' });
  if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
  await loadChat();                                 // 重新拉 convSettings + 会话列表，界面和机器人读同一份
  S.chat.replyToggle = false;
  const label = { all: '全部', group: '群', qq: '私聊' }[scope] || scope;
  toast(label + (turn === 'on' ? '回复已开启' : '已关（不看也不回）') + '（' + num(r.count || 0) + ' 个会话）');
  render();
}

/* ---------- B站私信（聊天记录页里，2026-11-19 主人令）----------
 * 她原话：「要在聊天记录页里加 b站页。QQ 和 b站的私聊是显示在一块的，现在也没有」。
 * 所以：左栏同一列里 QQ 会话 + B站私信并排放；点 B站那个会话，右边直接是这个人的私信原文。
 * 数据只读，接口和 B站页共用（/api/bili/dm、/api/bili/dm/msgs），登录号 = AstrBot 插件那份配置。
 * 不往 chat-log.jsonl 写一个字：B站 私信仍归 AstrBot 管，这里只负责「看得见」。 */
function bdmWho(s, uid) {
  if (s && s.person && s.person.name) return s.person.name;
  if (s && s.name) return s.name;
  return 'UID ' + uid;
}
function htmlChatBdmBody() {
  const C = S.chat, uid = String(C.conv).slice(4);
  const s = (C.bdm.list || []).find(x => String(x.uid) === uid) || { uid };
  const box = C.bdm.msgs[uid];
  const who = bdmWho(s, uid);
  const qq = (s.person && s.person.qq) || [];
  const btn = (act, label, title) => `<button class="chip" data-act="${act}"${title ? ` title="${esc(title)}"` : ''} style="margin-left:8px;padding:0 7px;height:19px;font-size:11px">${label}</button>`;
  const head = `<div class="msg-day">B站私信 · ${esc(who)}`
    + (qq.length ? `　同一个人也有 QQ：${esc(qq.join('、'))}` : '')
    + `　<span class="dim">UID ${esc(uid)} · 只读（发消息还在 B站 那边）</span>`
    + btn('chat-bdm-reload', '↻ 重新拉', 'B站 接口连着打会 412，所以平时走缓存')
    + btn('status-go', '打开 B站页', 'B站主页 / 评论楼中楼 / 私信都在那一页');
  if (!box) return head + '<div class="empty">读这个人的私信…</div>';
  if (box.err) return head + `<div class="empty">读不出来：${esc(box.err)}</div>`;
  const list = box.list || [];
  if (!list.length) return head + '<div class="empty">这个会话还没有消息。</div>';
  return head + list.map(m => {
    // msg_type 5 = 撤回提醒，正文就是被撤回那条的 msg_key（一串数字），不能当人说的话显示
    const recall = Number(m.type) === 5 || /^\d{16,20}$/.test(String(m.text || '').trim());
    const txt = recall ? `（${m.mine ? '这边' : '对方'}撤回了一条消息）` : String(m.text || '').trim();
    return `<div class="msg${m.mine ? ' is-mine' : ''}${recall ? ' is-recall' : ''}">
      <span class="msg-t">${esc(fmtTime(m.t).slice(11) || '—')}</span>
      <span class="msg-n">${esc(m.mine ? (C.bot || '虚幻') : who)}</span>
      <span class="msg-x">${esc(txt || `（${Number(m.type) || 0} 类型消息，没有文字）`)}</span>
    </div>`;
  }).join('');
}
async function loadBiliDm(force) {
  const C = S.chat;
  if (!C.bdm || C.bdm.loading) return;
  if (!force && (C.bdm.list || []).length) return;
  C.bdm.loading = true;
  let r = null;
  try { r = await window.xuh.api('GET', '/api/bili/dm'); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  C.bdm.loading = false;
  if (!r || !r.ok) C.bdm.err = (r && r.error) || '读不到 B站私信（先看 B站 登录态还在不在）';
  else { C.bdm.list = r.list || []; C.bdm.err = ''; }
  if (S.tab === 'chat') render();
}
async function loadBiliDmMsgs(uid, force) {
  const C = S.chat, u = String(uid || '');
  if (!C.bdm || !u || C.bdm.busy[u]) return;
  if (!force && C.bdm.msgs[u]) return;
  C.bdm.busy[u] = true;
  let r = null;
  try { r = await window.xuh.api('GET', '/api/bili/dm/msgs?uid=' + encodeURIComponent(u) + '&size=100'); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  C.bdm.busy[u] = false;
  C.bdm.msgs[u] = (r && r.ok) ? { list: r.list || [] } : { err: (r && r.error) || '读不到' };
  // 两种选中态都要重画：独立的 B站会话（bdm_<uid>），或按人合并进来的 QQ 会话（p_<pid> 且这个 pid 的 B站会话就是 u）
  const cur = String(S.chat.conv);
  const mergedHere = /^p_/.test(cur) && (() => { const bs = (C.bdm.list || []).find(s => s.person && String(s.person.pid) === cur.slice(2)); return bs && String(bs.uid) === u; })();
  if (S.tab === 'chat' && (cur === 'bdm_' + u || mergedHere)) render();
}

/* 聊天记录里就地看 / 改这个人（主人 2026-11-13：「点人物头像也可直接查看修改此人的朋友录/人物册数据」）。
 * 以前这里只有「去朋友录页改名字 / 好感」一个跳转按钮——她要的是**在这里就能改**：
 * 名字、代称、好感（含锁定）、喜好厌恶、跟他的约定与话题、他教过的知识，全在这一张卡里。
 * 数据源不新开：朋友录 /api/friends 的人 + 复核 /api/review 的三类；写回走各页同一套接口。 */
function htmlChatPerson() {
  const pid = S.chat.person;
  if (!pid) return '';
  const p = (S.friends.list || []).find(x => x.pid === pid);
  if (!p) {
    return `<div class="modal-veil"><div class="modal-card">
      <h3>这个人不在朋友录里</h3>
      <div class="modal-line">号还没建档，或者刚被删掉。</div>
      <div class="modal-btns"><button class="btn" data-act="person-close">关掉</button></div>
    </div></div>`;
  }
  const bare = s => String(s || '').replace(/^[a-z]+:/, '');
  const ids = new Set((p.accounts || []).map(a => String(a.id)));
  const pacts = p.pacts || [];
  const teachList = (S.review.list || []).filter(x => x.rkind === 'teach'
    && (String(x.pid || '') === pid || ids.has(bare(x.qq))));
  const topicList = (S.review.list || []).filter(x => x.rkind === 'topic' && x.state !== 'dropped' && !x.parent
    && (String(x.pid || '') === pid || ids.has(bare(x.qq))));
  const accText = (p.accounts || []).map(a => plab(a.platform) + ' ' + a.id).join(' · ');
  const aliasSt = (p.aliasReview || {}).state || 'legacy';
  return `<div class="modal-veil"><div class="modal-card person-modal" style="max-height:88vh;overflow-y:auto">
    <h3>${esc(p.label || '（没名字）')}${p.alias ? `<span class="small dim">（${esc(p.alias)}）</span>` : ''}</h3>
    <div class="modal-line">${esc(accText)} · 好感 ${num(p.favor || 0)} · ${Number(p.favor) > 20 ? '朋友录' : '人物册'}${p.favorLock ? ' · 好感已锁定' : ''}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0">
      <div style="grid-column:1/-1"><label>真名（本人承认的名字，喊人优先用它）</label>
        <input class="field" data-pf="name" data-pid="${esc(p.pid)}" value="${esc(p.name || '')}" placeholder="空着就喊当前可见名">
        <div class="small dim">代称自动收集：其他资料卡、群名片、平台名、别人喊的、曾用名——只用来认人，不拿来喊。</div>
        <div class="form-row" style="margin-top:6px"><input class="field" data-pf="masterCall" data-pid="${esc(p.pid)}" value="${esc(p.masterCall || '')}" placeholder="你怎么喊他（例：大萌新）">
          <span class="small dim">主人称呼方式，虚幻跟着喊</span></div>
        <div class="form-row" style="margin-top:6px"><input class="field" data-pf="alias" data-pid="${esc(p.pid)}" value="${esc(p.alias || '')}" placeholder="别人喊过他的名字（顿号隔开）"${aliasSt === 'locked' ? ' disabled' : ''}>
          <span class="small dim">${aliasSt === 'locked' ? '代称已锁定' : ''}</span></div></div>
      <div><label>身份 / 性别</label>
        <div class="small dim" style="padding:4px 0">${esc(p.roleLabel || '—')} · ${esc(p.sexLabel || '—')}${p.sex === 'male' && p.sexSrc === 'guess' ? '（猜的）' : ''}</div>
        ${(p.role === 'master' || p.role === 'onii' || p.role === 'friend')
          ? '<div class="small dim">主人 / 欧尼酱 按号认；朋友 = 在朋友录里（改好感即可）</div>'
          : `<select class="field" data-pf="role" data-pid="${esc(p.pid)}">
              <option value="known"${p.role === 'known' ? ' selected' : ''}>认识的人（人物册）</option>
              <option value="stranger"${p.role === 'stranger' ? ' selected' : ''}>陌生人</option>
            </select>`}
        <select class="field" data-pf="sex" data-pid="${esc(p.pid)}" style="margin-top:4px">
          <option value="female"${p.sex === 'female' ? ' selected' : ''}>女</option>
          <option value="male"${p.sex === 'male' ? ' selected' : ''}>男</option>
        </select></div>
      <div><label>资料卡名（QQ 真实昵称，自动同步）</label>
        <input class="field" data-pf="nick" data-pid="${esc(p.pid)}" value="${esc(p.nick || '')}"></div>
      <div><label>所在地（地区表 · 按这个人记，查天气用）</label>
        <div class="form-row"><input class="field" data-region-pid="${esc(p.pid)}" value="${esc(p.region || '')}" placeholder="有多细填多细，例如 西安市 未央区；留空=清掉">
          <button class="btn btn-quiet" data-act="save-region" data-pid="${esc(p.pid)}">保存地区</button></div>
        <div class="small dim">图上写的「登陆地点：西安市 未央区」、他自己说住哪，AI 也会自动记并私信告诉你</div></div>
      <div style="grid-column:1/-1"><label>好感度（0~100）</label>
        <div class="form-row"><input class="field mono" data-pf="favor" data-pid="${esc(p.pid)}" value="${Number(p.favor) || 0}" inputmode="numeric" style="width:80px">
          <button class="btn btn-primary" data-act="save-person" data-pid="${esc(p.pid)}">保存名字 / 代称 / 好感</button>
          <button class="btn btn-quiet" data-act="favor-lock" data-pid="${esc(p.pid)}" data-on="${p.favorLock ? '0' : '1'}">${p.favorLock ? '解锁好感' : '锁定好感'}</button>
        ${p.role === 'friend'
          ? `<button class="btn btn-quiet" data-act="out-friend" data-pid="${esc(p.pid)}" title="好感降到 20，回到人物册（身份跟着变）">移出朋友录</button>`
          : `<button class="btn btn-quiet" data-act="to-friend" data-pid="${esc(p.pid)}" title="好感调到 21，进朋友录（身份跟着变）">加入朋友录</button>`}</div>
        <div class="small dim">${p.favorLock ? '锁定中：群里夸她、衰减都不动' : '未锁定：群里的加分和衰减会改它'}</div></div>
    </div>

    ${htmlRelationBlock(p)}

    <h3 style="margin-top:16px">跟他的约定 · ${num(pacts.length)} 条</h3>
    ${pacts.length ? pacts.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">还没有约定。</div>'}

    <h3 style="margin-top:16px">跟他有关的话题 · ${num(topicList.length)} 条</h3>
    ${topicList.length ? topicList.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">还没有话题。</div>'}

    <h3 style="margin-top:16px">记录的 · 他教过的 · ${num(teachList.length)} 条</h3>
    ${teachList.length ? teachList.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">没有他教过的知识。</div>'}

    <div class="modal-btns">
      <button class="btn" data-act="chat-person-goto" data-pid="${esc(p.pid)}">去朋友录页看完整分区</button>
      <button class="btn btn-quiet" data-act="person-purge-open" data-pid="${esc(p.pid)}">删除这个人</button>
      <button class="btn" data-act="person-close">关掉</button>
    </div>
  </div></div>`;
}

/* 自绘弹层（不用 prompt / confirm / alert）：一屏只开一个，点按钮才关。
 * 内容：① 标成错误 ② 待修复清单 ③ 这一轮的决策轨迹 ④ 按天工作日志 ⑤ 加星标（理由 + 多选上下文） ⑥ 给群标名字 ⑦ 回复总开关。 */
/* ===== 兜底词池（2026-11-13 主人令）=====
 * 一个图形入口（聊天记录页 🛟 兜底）→ 自画弹层里增删改，不另开第二个入口。
 * 草稿 {id,text,type,target,on}；存盘时转成 {id,text,scope,enabled}。
 * type：'' 全部 / g 某个群 / private 所有私聊 / p 某个人 / bili B站私信 / other 其它平台。
 * 2026-11-13 主人令：B站平台公开评论 / 弹幕不设兜底（攒着等应答），只有 B站私信才配兜底。 */
function fbDraftOf(x) {
  const s = String((x && x.scope) || '');
  let type = '', target = '';
  if (/^g\d+$/.test(s)) { type = 'g'; target = s.slice(1); }
  else if (/^p\d+$/.test(s)) { type = 'p'; target = s.slice(1); }
  else if (s === 'private') type = 'private';
  else if (s === 'bili') type = 'bili';
  else if (s) { type = 'other'; target = s; }
  return { id: String((x && x.id) || ''), text: String((x && x.text) || ''),
    type, target, on: !(x && x.enabled === false) };
}
function fbScopeOf(p) {
  const t = String(p.target || '').trim();
  const digits = t.replace(/\D/g, '');
  if (p.type === 'g') return digits ? 'g' + digits : '';
  if (p.type === 'p') return digits ? 'p' + digits : '';
  if (p.type === 'private') return 'private';
  if (p.type === 'bili') return 'bili';
  if (p.type === 'other') return t.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
  return '';
}
/* 重画弹层前先把输入框里没保存的字收回来，否则点「＋」/ 删一条会把刚改的丢掉 */
function fbCollect() {
  document.querySelectorAll('[data-fb-k]').forEach(el => {
    const i = Number(el.dataset.i), k = el.dataset.fbK;
    const p = (S.chat.fbPool || [])[i];
    if (!p) return;
    p[k] = k === 'on' ? !!el.checked : String(el.value || '');
  });
}

function htmlChatModal() {
  const C = S.chat;

  /* ⑪ 兜底词池（2026-11-13 主人令）：聊天记录页里加任意多条，按群 / 私聊 / 某人 / 平台私信分别配。B站公开评论不兜底。 */
  if (C.fbOpen) {
    const pool = C.fbPool || [];
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
    const rows = pool.map((p, i) => `<div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <input type="checkbox" data-fb-k="on" data-i="${i}" ${p.on ? 'checked' : ''} title="不勾 = 先停用这条，留着不删">
      <textarea class="field" data-fb-k="text" data-i="${i}" rows="2" style="flex:1;min-width:180px;resize:vertical" placeholder="答不出来时说这句" title="这句就是模型全失败时发出去的话，可换行">${esc(p.text)}</textarea>
      <select class="field" data-fb-k="type" data-i="${i}" style="width:112px" title="这条兜底用在哪：先找精确作用域，没有就用「全部」的">
        ${opt('', '全部', p.type)}${opt('g', '某个群', p.type)}${opt('private', '所有私聊', p.type)}${opt('p', '某个人', p.type)}${opt('bili', 'B站私信', p.type)}${opt('other', '其它平台', p.type)}
      </select>
      <input class="field" data-fb-k="target" data-i="${i}" value="${esc(p.target)}" style="width:104px" title="某个群填群号 / 某个人填 QQ 号 / 其它平台填平台名；其余类型留空" placeholder="群号 / QQ / 平台">
      <button class="btn btn-quiet" data-act="fb-del" data-i="${i}" title="删掉这条">✕</button>
    </div>`).join('');
    return `<div class="modal-veil"><div class="modal-card" style="max-height:86vh;overflow-y:auto;min-width:620px">
      <h3 title="答不出来时从这些句子里挑一条：先按精确作用域（某个群 / 某个人 / 平台），没有就用「全部」的；池子清空或全关时才用默认兜底。保存后下一句就生效，不用重启。">兜底词池 · ${num(pool.length)} 条</h3>
      ${C.fbErr ? `<div class="modal-note" style="color:#c33">${esc(C.fbErr)}</div>` : ''}
      ${rows || '<div class="empty" style="padding:12px 0">池子空了，会用下面那句默认兜底</div>'}
      <button class="chip" data-act="fb-add" title="加一条新的兜底回复">＋</button>
      <div class="modal-note" title="这条既是未设置内容时的默认兜底，本身也在池子里，可以改、可以删">默认兜底：<b>${escBr(C.fbDefault || '')}</b></div>
      <div class="modal-btns">
        <button class="btn btn-primary" data-act="fb-save" title="存到机器人端 config，改完不用重启">保存</button>
        <button class="btn btn-quiet" data-act="fb-close">关闭</button>
      </div>
    </div></div>`;
  }

  /* ⑨ 显示设置（2026-11-10 主人定「加入口到聊天记录页给我自己设置」）：
   * 值存在机器人端 config（config/features.json → context），这里只是入口，不另存一份。
   * 四项一起改：图片翻译文字露多少字、页面列多少条、机器人读多少条上下文、上下文最多多少字。
   * 单个群/私聊的 ctx 覆盖仍在会话栏 ⚙ 那个弹层，不动它。 */
  if (C.showSet) {
    const g = C.cfg || {};
    const val = (k, d) => (g[k] === undefined || g[k] === null || g[k] === '' ? d : g[k]);
    const row = (id, label, v, tip, min, max) => `<label class="modal-label">${label}</label>
      <input class="field" id="${id}" type="number" min="${min}" max="${max}" value="${esc(v)}" style="width:100%">
      <div class="modal-note">${tip}</div>`;
    return `<div class="modal-veil"><div class="modal-card" style="max-height:86vh;overflow-y:auto">
      <h3>显示设置</h3>
      <div class="modal-line">改完机器人端和这个页面一起生效，不用重启。单个群 / 私聊在左边会话栏 ⚙ 里单独设。</div>
      ${row('set-imgchars', '图片翻译文字默认显示多少字', val('imgDescChars', 1200), '填 0 = 整段全展开。调大能一眼看完图上的题和答案；超出的部分仍可点「展开全文」。', 0, 20000)}
      ${row('set-showlimit', '这个会话显示最近多少条', val('chatShowLimit', 200), '每次只画当前会话的这么多条（默认 200）。填大翻得更远，DOM 也更长。', 20, 5000)}
      ${row('set-histlimit', '机器人能读多少条上下文', val('historyLimit', 60), '虚幻回复时最多看多少条历史；会话栏 ⚙ 里给单个群设的会盖过这里。', 6, 500)}
      ${row('set-histchars', '上下文最多留多少字', val('historyChars', 8000), '历史总字数上限；图片翻译很长时，调大才不会被挤掉。', 1200, 100000)}
      ${htmlPlatLimitsInSet()}
      ${htmlHrNumsInSet()}
      <div class="modal-btns">
        <button class="btn btn-primary" data-act="chat-show-set-ok">保存</button>
        <button class="btn btn-quiet" data-act="chat-show-set-close">关闭</button>
      </div>
    </div></div>`;
  }

  /* ⑩ 回复总开关（2026-11-11 主人定「聊天记录面板里一键关全部 / 私聊 / 群回复」）：
   * 复用按会话的 off 标志（关 = 不看也不回，连聊天记录都不落），一次批量置好。
   * 三个粒度：全部 / 群 / 私聊；实时算「已关 N/共 M」。主人的私聊遥控不被批量关掉（服务端排除）。 */
  if (C.replyToggle) {
    const st = replyToggleState();
    const row = (scope, label, note) => {
      const s = st[scope] || { off: 0, total: 0 };
      const allOff = s.total > 0 && s.off === s.total;
      const turn = allOff ? 'on' : 'off';          // 全关 → 显示「开启」；否则 → 「关闭」
      const btn = s.total === 0
        ? `<button class="btn btn-quiet" disabled>无会话</button>`
        : `<button class="btn ${allOff ? 'btn-primary' : 'btn-danger'}" data-act="reply-bulk" data-scope="${scope}" data-turn="${turn}">${allOff ? '开启' : '关闭'}回复</button>`;
      return `<div class="reply-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0">
        <div class="reply-meta" style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>${esc(label)}</b><span class="small dim">已关 ${num(s.off)} / 共 ${num(s.total)}</span>${note ? `<span class="small dim">· ${esc(note)}</span>` : ''}</div>
        ${btn}
      </div>`;
    };
    return `<div class="modal-veil"><div class="modal-card">
      <h3>回复总开关</h3>
      <div class="modal-line">一键关掉某类会话的回话。关掉 = 虚幻连看都不看、也不回话：这条会话的新消息不记录、不回复。下一句生效，不用重启。要恢复时在这里点「开启」，或事后去左边会话栏 ⚙ 单会话处理。</div>
      ${row('all', '全部回复', '')}
      ${row('group', '群回复', '')}
      ${row('qq', '私聊回复', '主人的私聊遥控不受影响')}
      <div class="modal-note">黑名单会话不在这里动（去 ⚙ 单会话取消黑名单）。</div>
      <div class="modal-btns"><button class="btn btn-quiet" data-act="reply-toggle-close">关掉</button></div>
    </div></div>`;
  }

  /* ③ 推理：这一轮代码实际做过什么。模型默认关思考，没原文就如实写「没给」，不编心路。 */
  if (C.traceOpen) {
    const x = C.traceItem;
    const row = (k, v) => `<div class="trace-row"><span class="trace-k">${esc(k)}</span><span class="trace-v">${esc(v)}</span></div>`;
    const body = C.traceLoading
      ? '<div class="empty">读这一轮的轨迹中…</div>'
      : (!x
        ? '<div class="modal-note">这一条没有轨迹。通常是加功能之前的旧记录，或不是走 QQ 主链路发出的（B 站、兜底、别处转发）。轨迹从 2026-11-07 起才有，按天存在 data/推理/。</div>'
        : `<div class="trace-grid">
            ${row('记录时间', fmtTime(x.t))}
            ${row('这句怎么来的', x.how || '模型回复')}
            ${row('模型', x.model || '（没调模型 / 没记到）')}
            ${row('调用耗时', x.llmMs ? x.llmMs + ' ms' : '—')}
            ${row('听到的话', x.in || '（空）')}
            ${row('说话人', x.who || '—')}
            ${row('判出的情绪', x.emo || '—')}
            ${row('命中应对场合', (x.scenes || []).join('、') || '没命中')}
            ${row('命中人设场景', (x.soulScenes || []).join('、') || '没命中')}
            ${row('反省教训', x.lesson ? '这一轮回灌了 1 条短教训' : '没有')}
          </div>
          <div class="modal-label" style="margin-top:12px">给模型看了哪些段（按顺序，只记段标题）</div>
          <div class="trace-blocks">${(x.blocks || []).length
            ? x.blocks.map(b => `<div class="trace-b">${esc(b)}</div>`).join('')
            : '<div class="dim">（没记到）</div>'}</div>
          <div class="modal-label" style="margin-top:12px">模型思考原文</div>
          <div class="modal-quote">${esc(x.reason || '这一轮模型没给思考原文。glm-4.5-flash 默认关思考，不是漏记；手动点「让她下一轮想给我看」才会有。')}</div>
          <div class="modal-label">最后发出</div>
          <div class="modal-quote">${esc(x.out || '')}</div>
          <div class="modal-note">${esc(x.note || '')}</div>`);
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>这一轮为什么这样回</h3>
      <div class="modal-line">下面是代码里真实发生、可逐条核对的事实；没有编造模型的内心独白。</div>
      ${body}
      <div class="modal-btns"><button class="btn btn-quiet" data-act="chat-modal-close">关掉</button></div>
    </div></div>`;
  }

  /* ④ 按天工作日志：只追加不覆盖、不进提示词。日期做成按钮，全部走同一套点击分发。 */
  if (C.showLog) {
    const days = C.logDays || [];
    const chips = days.length
      ? days.map(d => `<button class="chip${d === C.logDay ? ' is-on' : ''}" data-act="log-day" data-day="${esc(d)}">${esc(d)}</button>`).join('')
      : '<span class="small dim">还没有日志文件</span>';
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>工作日志</h3>
      <div class="modal-line">按天一份，只追加不覆盖，不进提示词。自动记：撤回 / 待修复问题 / 代码更新；也可以自己记一条。</div>
      <div class="pact-bar" style="margin:0 0 8px">${chips}<span class="small dim" style="margin-left:auto">${num(days.length)} 天</span></div>
      <pre class="trace-pre">${esc(C.logLoading ? '读日志中…' : (C.logRaw || '这一天还没有记录。'))}</pre>
      <div class="log-add">
        <input class="field" id="log-text" placeholder="记一条今天做过的事" style="flex:1">
        <button class="btn btn-primary" data-act="log-add">记一条</button>
      </div>
      <div class="modal-label" style="margin-top:14px">长期记忆正本 · data/记忆/MEMORY.md（只有「## 每轮给模型看的」进提示词）</div>
      <textarea class="mem-raw" id="mem-raw" spellcheck="false">${esc(C.memRaw)}</textarea>
      <div class="log-add">
        <span class="small dim">现在每轮注入 ${num((C.memPrompt || '').length)} 字 · 改完下一句生效，不用重启</span>
        <button class="btn btn-primary" data-act="mem-save" style="margin-left:auto">保存长期记忆</button>
      </div>
      <div class="modal-btns"><button class="btn btn-quiet" data-act="chat-modal-close">关掉</button></div>
    </div></div>`;
  }

  /* ⑤ 加星标：像标错一样能写一句描述，还能多选前后几句当上下文。
   * 描述与上下文都进 chat-stars.json，学话时接在原来那一行星标样例里，不新增段落。 */
  if (C.starItem) {
    const m = C.starItem;
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>加星标：这句值得学</h3>
      <div class="modal-line">${esc(fmtTime(m.t))} · ${esc(String(m.nick || ''))}</div>
      <div class="modal-quote">${esc(String(m.text || '').slice(0, 200))}</div>
      <label class="modal-label">为什么值得学（可不填，给虚幻一个理由参考）</label>
      <input class="field" id="star-note" placeholder="例：被调侃时先接梗，再一句话收住" value="${esc(C.starNote)}" style="width:100%">
      <label class="modal-label">上下文（多选，一起存进星标，最多 8 句）</label>
      ${pickCount(C.starPicked.size, 8)}
      ${qqPickRows(m, C.starPicked, 'star-toggle')}
      <label class="modal-label" style="margin-top:12px">这句在哪些方面到位了（勾了就记成那一项的正面样本，可多选）</label>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:4px">
        ${RECORD_TABS.map(([ik, iname]) => `<label class="small" style="display:flex;gap:5px;align-items:center"><input type="checkbox" class="star-info" value="${ik}"> ${esc(iname)}</label>`).join('')}
      </div>
      <div class="modal-note">确认后：加星、话题日志建一条「已总结」；描述和上下文一起进星标样例给虚幻参考。勾了的方面会各记一条正面样本（信息识别那几页能看到）。</div>
      <div class="modal-btns">
        <button class="btn btn-primary" data-act="star-ok">加星标</button>
        <button class="btn btn-quiet" data-act="chat-modal-close">取消</button>
      </div>
    </div></div>`;
  }
  /* ② 标成错误：和加星同一套多选（主人 2026-11-07：「错误也能多选」）。
   * 语义不变：主条移除 + 记一条待修复；多选的那些只当「当时的语境」一起记进去，不删。 */
  if (C.issueItem) {
    const m = C.issueItem;
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>把这条标成错误</h3>
      <div class="modal-line">${esc(fmtTime(m.t))} · ${esc(String(m.nick || ''))}</div>
      <div class="modal-quote">${esc(String(m.text || '').slice(0, 200))}</div>
      <label class="modal-label">哪里错了（可不填）</label>
      <input class="field" id="issue-note" placeholder="例：答非所问 / 提了不该提的爱好" value="${esc(C.issueNote || '')}" style="width:100%">
      <label class="modal-label">上下文（多选，一起记进待修复问题，最多 8 句）</label>
      ${pickCount(C.issuePicked.size, 8)}
      ${qqPickRows(m, C.issuePicked, 'issue-toggle')}
      <label class="modal-label" style="margin-top:12px">顺带记进「信息识别」（可不填，一行一条：说法 → 判断；下面 5 项各管各的）</label>
      ${RECORD_TABS.map(([ik, iname]) => {
        const mt = INFO_META[ik] || {};
        return `<div style="margin-top:8px">
          <div class="small dim">${esc(iname)} · ${esc(mt.m || '')}</div>
          <textarea class="field" id="issue-info-${ik}" rows="2" placeholder="${esc(mt.ph || '说法')} → ${esc(mt.mph || '判断')}" style="width:100%"></textarea>
        </div>`;
      }).join('')}
      <div class="modal-note">确认后：加一条待修复问题（带上选的上下文），移除这句聊天记录，并清掉它学进风格样本的那份。选中的上下文不会被删。上面填的分项会分别存进「信息识别」对应页。</div>
      <div class="modal-btns">
        <button class="btn btn-danger" data-act="issue-ok">记问题并移除这条</button>
        <button class="btn btn-quiet" data-act="issue-close">取消</button>
      </div>
    </div></div>`;
  }
  if (C.showIssues) {
    const list = C.issues || [];
    // 带上下文的那几条（标错时多选的），把当时在聊什么一起摊开，修的时候不用再翻记录
    const rows = list.length ? list.map(x => {
      const cx = Array.isArray(x.ctx) ? x.ctx : [];
      const cxHtml = cx.length ? `<div class="issue-ctx" style="grid-column:1/-1">${cx.map(c =>
        `<div class="issue-ctx-row"><span class="issue-ctx-n">${esc(c.nick || '')}</span><span class="issue-ctx-x">${esc(c.text || '')}</span></div>`).join('')}</div>` : '';
      return `<div class="issue-row">
      <span class="issue-t">${esc(fmtTime(x.t))}</span>
      <span class="issue-x">${esc(String(x.text || '').slice(0, 160))}</span>
      <button class="btn btn-quiet" data-act="issue-resolve" data-idx="${Number(x.idx)}">已修好</button>
      ${cxHtml}
    </div>`;
    }).join('') : '<div class="empty">现在没有待修复问题。</div>';
    return `<div class="modal-veil"><div class="modal-card">
      <h3>待修复问题 ${num(list.length)}</h3>
      <div class="modal-note">群里撤回消息会自动加一条；你也可以在聊天记录里手动标。</div>
      <div class="issue-list">${rows}</div>
      <div class="modal-btns"><button class="btn btn-quiet" data-act="issue-close">关掉</button></div>
    </div></div>`;
  }
  /* ⑦ 改 / 加 聊天记录的情绪（主人 2026-11-07 定：聊天记录里能直接改情绪、能看应对）。
   * 弹层里：① 当前「推理」（触发词→叶）② 该叶的「应对」（情绪书 replies）③ 选叶 ④ 触发词。
   * 改完回写 chat-emotion.json；之前是机器人判的、且改了叶 → 自动记成判错（联动表情包页徽标）。 */
  if (C.emoEdit) {
    const m = C.emoEdit;
    const cur = m.emo || null;
    const lf = (S.chat.emoBook && S.chat.emoBook.leaves) || [];
    const opts = lf.map(l => {
      const sel = (cur && cur.leaf === l.name) ? ' selected' : '';
      const bn = l.branchName || l.branch || '';
      return `<option value="${esc(l.name)}"${sel}>${esc(l.name)}${bn ? ' · ' + esc(bn) : ''}</option>`;
    }).join('');
    const reps = leafReplies(cur ? cur.leaf : '');
    const repHtml = reps.length
      ? `<div class="emo-rep">这一类（${esc(cur.leaf)}）的应对：${reps.map(t => `<span class="emo-rep-i">${esc(t)}</span>`).join('')}</div>`
      : (cur ? `<div class="emo-rep emo-rep-empty">这一类在情绪书里还没写应对。</div>` : '');
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>${cur ? '改这条的情绪' : '给这条加情绪'}</h3>
      <div class="modal-line">${esc(fmtTime(m.t))} · ${esc(String(m.nick || ''))}</div>
      <div class="modal-quote">${esc(String(m.text || '').slice(0, 200))}</div>
      ${cur ? `<div class="emo-info">当前：<b>${esc(cur.leaf)}</b>${cur.word ? `<span class="emo-w">（命中「${esc(cur.word)}」）</span>` : ''}<span class="emo-src">${cur.source === 'review' ? '判错' : (cur.source === 'user' ? '手改' : '机器人判的')}</span></div>` : ''}
      ${repHtml}
      <label class="modal-label">改成 / 加一个叶</label>
      <select class="field" id="emo-leaf" style="width:100%">${opts}</select>
      <label class="modal-label">触发词（可空，记下为什么判成这叶）</label>
      <input class="field" id="emo-word" placeholder="例：委屈 / 你怎么这样" value="${esc(cur ? (cur.word || '') : '')}" style="width:100%">
      <div class="modal-note">选好叶 + 填触发词，点「保存」即回写；把机器人判错的叶改成正确的，会自动记成判错（表情包页 / 情绪书页的「判错」徽标会亮）。</div>
      <div class="modal-btns">
        ${cur ? `<button class="btn btn-quiet" data-act="chat-emo-clear">清空情绪</button>` : ''}
        <button class="btn btn-primary" data-act="chat-emo-set">保存</button>
        <button class="btn btn-quiet" data-act="chat-emo-close">关闭</button>
      </div>
    </div></div>`;
  }
  /* 🔍 补漏判预览（主人：「给所有漏判的加情绪」）：列出能判出但还没记的，确认才应用。 */
  if (C.emoScan) {
    const list = C.emoScan || [];
    const rows = list.length ? list.slice(0, 300).map(x => `<div class="emo-leak-i"><b>${esc(x.leaf)}</b><span class="emo-w">←${esc(x.word)}</span><span class="emo-leak-t">「${esc(String(x.text || '').slice(0, 30))}」</span></div>`).join('')
      : '<div class="empty">没有漏判（都判过了）。</div>';
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>扫到 ${num(list.length)} 条漏判</h3>
      <div class="modal-note">能判出情绪、但聊天记录里还没记的那些（机器人没当场听到 / 历史记录）。确认后一次性加进去。</div>
      <div class="emo-leak">${rows}</div>
      <div class="modal-btns">
        ${list.length ? `<button class="btn btn-primary" data-act="chat-emo-scan-apply">应用 ${num(list.length)} 条</button>` : ''}
        <button class="btn btn-quiet" data-act="chat-emo-close">先不</button>
      </div>
    </div></div>`;
  }
  /* ⑧ 这个会话单独设（主人 2026-11-07）：
   * ① 「虚幻的可读上下文可以在聊天界面按各自群聊/私聊分别单独改容量。按我在这个页面看到的条数，给我来填数字。」
   * ② 「群回复等等的开关都可以在各自界面分别调，黑名单群我也可以在这直接打标记。」
   * ③ 「我可以删除全组内容。」
   * 三件事放同一个弹层里，因为都是「只对这一个会话生效」的东西，分开摆只会让人多点两次。 */
  if (C.convSet) {
    const v = C.convSet;
    const df = (C.convDefault && C.convDefault.ctx) || 30;
    const dfc = (C.convDefault && C.convDefault.chars) || 600;
    const one = (v.scopeKey && C.convSettings[v.scopeKey]) || {};
    const cur = one.ctx ? String(one.ctx) : '';
    const curChars = one.chars ? String(one.chars) : '';
    return `<div class="modal-veil"><div class="modal-card">
      <h3>这个会话单独设</h3>
      <div class="modal-line">${esc(v.label || v.key)} · 现在这个页面上有 ${num(v.n)} 条</div>
      <label class="modal-label">虚幻这一轮能读多少条上下文</label>
      <input class="field" id="conv-ctx" type="number" min="2" max="500" value="${esc(cur)}" placeholder="不填 = 用默认 ${num(df)} 条" style="width:100%">
      <div class="modal-note">想让她记住多少句就填多少（这个会话在页面上有 ${num(v.n)} 条）。填得越大，占的 token 越多。</div>
      <label class="modal-label">虚幻这一轮最多说多少字</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="field" id="conv-chars" type="number" min="20" max="8192" value="${esc(curChars)}" placeholder="不填 = 用默认 ${num(dfc)} 字" style="flex:1">
        <button class="btn btn-quiet" data-act="conv-set-default" title="清掉这个会话单独设的字数，立刻回到默认 ${num(dfc)} 字">用默认</button>
      </div>
      <div class="modal-note">填了就以这个为准（人的设置优先）：管住模型正文、QQ 每条、B站评论 / 私信这几道裁切。她话说不停被截断 → 调大。</div>
      <label class="modal-label">这个会话的开关</label>
      <label class="conv-sw"><input type="checkbox" id="conv-reply"${C.convSetReply ? ' checked' : ''}><span>要回话（关掉 = 只看不回，记录照旧）</span></label>
      <label class="conv-sw"><input type="checkbox" id="conv-black"${C.convSetBlack ? ' checked' : ''}><span>黑名单（不回话、也不学说话，记录照旧）</span></label>
      <label class="conv-sw"><input type="checkbox" id="conv-model"${C.convSetModel ? ' checked' : ''}><span>本地模型优先（开 = 本地模型排最前，本地断连时自动换其它模型接着回；关 = 全部模型，按正常优先级排序）</span></label>
      <div class="modal-note">只影响这一个会话，别的群 / 私聊照旧。改完下一句生效，不用重启。</div>
      <div class="modal-btns">
        <button class="btn btn-primary" data-act="conv-set-ok">保存</button>
        ${C.convDel
          ? `<button class="btn btn-danger" data-act="conv-del-ok">确认删掉这 ${num(v.n)} 条</button>`
          : `<button class="btn btn-quiet" data-act="conv-del-ask">删掉这个会话的全部记录</button>`}
        <button class="btn btn-quiet" data-act="conv-set-close">关闭</button>
      </div>
    </div></div>`;
  }
  /* 约定详情：从聊天记录的「📜约」徽标点进来，看这条约定从哪句话来的、要做什么。 */
  if (C.pactDetail) {
    const p = (C.pactById && C.pactById[C.pactDetail]) || null;
    if (!p) return `<div class="modal-veil"><div class="modal-card"><h3>约定</h3><div class="empty">没找到这条约定。</div><div class="modal-btns"><button class="btn btn-quiet" data-act="chat-pact-close">关掉</button></div></div></div>`;
    const who = p.whoName || pactWhoName(p);
    const say = String(p.say || '').trim();
    const when = (Array.isArray(p.when) ? p.when : []).filter(Boolean);
    const note = String(p.note || '').trim();
    return `<div class="modal-veil"><div class="modal-card modal-card-wide">
      <h3>这条约定从哪句话来的</h3>
      <div class="modal-line">${esc(fmtTime(p.t))} · ${esc(who)}</div>
      <div class="pact-top"><span class="badge ${p.qq ? 'badge-blue' : ''}">${p.qq ? '按人' : '通用'}</span>${p.scope ? `<span class="badge badge-grey">${esc(p.scope)}</span>` : '<span class="badge badge-grey">通用</span>'}</div>
      ${say ? `<div class="modal-label">要原样说的话</div><div class="pact-say">${esc(say)}</div>` : ''}
      ${when.length ? `<div class="modal-label">触发条件</div><div class="pact-when">${esc(when.map(w => '「' + w + '」').join(' '))}</div>` : ''}
      ${note ? `<div class="modal-label">另外</div><div class="pact-note">${esc(note)}</div>` : ''}
      <div class="modal-label">磁盘原文</div>
      <div class="pact-raw">${esc(String(p.text || ''))}</div>
      <div class="modal-note">约定挂在「${esc(p.scope || '通用')}」；生成它的那句话在聊天记录里标了「📜约」，回去能找到。</div>
      <div class="modal-btns"><button class="btn btn-quiet" data-act="chat-pact-close">关掉</button></div>
    </div></div>`;
  }
  return '';
}

/* ---------------- ④ 攻略：客户端「攻略」页（增删改查都走 guides.api） ---------------- */
async function loadGuides() {
  const r = await window.xuh.guides('list');
  if (!r || r.error) { toast('攻略读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  const st = await window.xuh.guides('status');
  S.guides.list = r.list || [];
  S.guides.status = (st && !st.error) ? { found: st.found || [], lost: st.lost || [] } : { found: [], lost: [] };
  S.guides.loaded = true;
  teachBadge();
  if (S.tab === 'teach') render();
}

/* 署名怎么给人看：数据里存 platform:id，这里翻成「B站 30895294」这种写法，不改数据。 */
function sigLabel(by) {
  const s = String(by || '').trim();
  if (!s) return '';
  const i = s.indexOf(':');
  if (i < 0) return s;
  const plat = s.slice(0, i).toLowerCase();
  const name = { qq: 'QQ', bili: 'B站' }[plat] || s.slice(0, i);
  return name + ' ' + s.slice(i + 1);
}

/* ---------------- ④ 攻略：已并入「记录的」（2026-11-13 主人定） ----------------
 * 数据仍在 data/guides/*.md，增删改查走 guides.api；这页只画成一段，不再单独占导航格。
 * 每份带署名（platform:id，跟教学同一条规矩），署名藏在 `<!-- by:… -->` 注释里，不进检索、不进提示词。 */
const GUIDE_BY_MASTER = 'qq:1000000002';   // 面板新建的攻略默认记她名下（她的第一个号）

function htmlGuidesBlock() {
  const G = S.guides;
  const list = G.list || [];
  const nSec = list.reduce((a, g) => a + (g.sections || 0), 0);
  const ed = G.edit;

  const editor = ed ? `<div class="sheet"><div class="sheet-head"><h2>${ed.isNew ? '新建攻略' : '编辑攻略：' + esc(ed.name)}</h2>
      <span class="hint">${ed.isNew ? '保存时自动补标记，署名记在你名下' : '改完点保存，标记和署名自动保留'}</span></div>
    <div class="sheet-body">
      ${ed.isNew ? '<div class="form-row" style="gap:8px;align-items:center;margin-bottom:8px"><input class="field" id="g-name" placeholder="攻略名（中文 / 字母 / 数字，例：洛克王国）" style="width:300px"></div>' : ''}
      <textarea class="field" id="g-content" style="width:100%;min-height:320px;font-family:var(--mono);font-size:12.5px;line-height:1.65">${esc(G.draft || '')}</textarea>
      <div class="form-row" style="margin-top:8px;gap:8px;align-items:center">
        <button class="btn btn-primary" data-act="guide-save">保存</button>
        <button class="btn btn-quiet" data-act="guide-close">取消</button>
      </div>
    </div></div>` : '';

  const head = `<div class="sheet"><div class="sheet-head"><h2>攻略（${num(list.length)} 份 · ${num(nSec)} 节）</h2>
      <span class="hint">本地资料，命中才读；新建或把 .md 直接丢进 data/guides/，标记都会自动补；标「自动」的是机器人自己记的（别人教 / 联网查到），一样能编辑、看原文、删</span></div>
    <div class="sheet-body"><button class="btn btn-primary" data-act="guide-new">+ 新建攻略</button></div></div>`;

  const rows = list.length ? list.map(g => {
    const isAuto = g.auto;
    const sig = sigLabel(g.by);
    return `<div class="pact">
      <div class="pact-top">
        <span class="badge badge-blue">攻略</span>
        <span class="pact-who">${esc(g.name)}</span>
        <span class="small dim">${num(g.sections)} 节 · ${num(g.chars)} 字</span>
        ${isAuto ? '<span class="badge badge-grey">自动</span>' : ''}
        ${sig ? `<span class="badge ${g.mine ? 'badge-blue' : 'badge-grey'}">${g.mine ? '我的 · ' : '署名 '}${esc(sig)}</span>` : '<span class="badge badge-grey">没署名</span>'}
      </div>
      <div class="pact-raw" title="磁盘上的原文路径">data/guides/${esc(g.file)}</div>
      <div class="pact-when" style="margin-top:6px">
        <button class="btn btn-quiet" data-act="guide-edit" data-name="${esc(g.name)}">编辑</button>
        <button class="btn btn-quiet" data-act="guide-open" data-name="${esc(g.name)}">看原文</button>
        <button class="btn btn-danger" data-act="guide-delete" data-name="${esc(g.name)}">删</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">还没有攻略。点上面「新建攻略」加第一份。</div>';

  return head + editor + `<div class="pacts">${rows}</div>`;
}

/* ---------------- ⑤ 文件：带她去「命令方块」 ----------------
 * 2026-11-07 她定：读写只在命令方块里做（那是她自己的工具，有自己的编辑器）；
 * 客户端这页只干一件事——按功能列出「该改哪些文件」，点一下在命令方块里打开那一份。
 * 归属表 命令方块/归属表.json 是唯一一份，主进程读它（xuh:fileMap），这里只管画。 */
async function loadFiles() {
  const r = await window.xuh.fileMap();
  if (!r || r.error) {
    S.files.loaded = true;
    toast('读不到功能对照表：' + ((r && r.error) || '未知原因'), true);
    paintChrome(); render(); return;
  }
  S.files.groups = Array.isArray(r.groups) ? r.groups : [];
  S.files.total = Number(r.total || 0);
  S.files.loaded = true;
  paintChrome(); render();
}

/* 点文件 → 唤起命令方块并停在那一份上（复用它的窗口，不开第二个） */
async function gotoFile(rel) {
  if (!rel) return;
  const r = await window.xuh.cmdBlock(rel);
  if (!r || r.error) { toast('打不开：' + ((r && r.error) || '未知原因'), true); return; }
  toast(r.fallback ? '没找到命令方块，已用默认程序打开' : '已在命令方块里打开');
}

function htmlFiles() {
  const groups = S.files.groups || [];
  if (!groups.length) {
    return '<div class="empty">读不到功能对照表：命令方块/归属表.json 里没有 features。</div>';
  }
  const cards = groups.map(g => `
    <div class="sheet fmap-card">
      <div class="sheet-head"><h2>${esc(g.name)}</h2><span class="hint">${esc(g.note || '')}</span></div>
      <div class="sheet-body">
        ${(g.items || []).length ? `<div class="fmap-files">${g.items.map(f => `
          <button class="fmap-file" data-act="file-goto" data-rel="${esc(f.rel)}" title="${esc(f.rel)}">
            <span class="fmap-name">${esc(f.name)}</span><span class="fmap-go">打开</span>
          </button>`).join('')}</div>`
          : '<div class="empty">这页没有对应的 src 文件（规则写在代码里）。</div>'}
      </div>
    </div>`).join('');

  return `<div class="fmap-top">
      <div class="small dim">读写都在「命令方块」里做（它自带编辑器）。这里点一下，命令方块直接跳到那一份原文。</div>
      <button class="btn btn-primary" data-act="file-open-cb">打开命令方块</button>
    </div>${cards}`;
}

/* ---------------- ① 表情包：交给共用模块 ---------------- */
function renderStickers() {
  if (!window.StickerPage) {
    view.innerHTML = '<div class="loading">表情包页没加载出来（public/sticker-page.js 找不到）</div>';
    return;
  }
  view.classList.add('is-sticker');
  view.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'sp-scope sp-page';
  view.appendChild(box);

  window.StickerPage.imgUrl = name =>
    'xuh://stickers/' + String(name).split('/').map(encodeURIComponent).join('/');

  window.StickerPage.mount(box, {
    el: el,
    toast: toast,
    // 顶栏已经有「表情包」这个标题，页里不再画一遍 crumb + h1（她 2026-11-07 说版头太占空间）
    hideHead: true,
    api: u => window.xuh.api('GET', u),
    POST: (u, d) => window.xuh.api('POST', u, d),
    rerender: () => render(),
    // 看原文 / 看表达式单 / 看发图逻辑：都交给命令方块，停在那一份原文上（只读，不会误改）
    openRaw: id => window.xuh.cmdBlock(id).then(r => {
      if (r && r.error) toast(r.error, true);
      else if (r && r.note) toast(r.note);
      return r;
    }),
  });

  // 表情包是自己异步拉的，拉完把左边计数补上（不轮询，就补三次）
  [500, 1600, 4200].forEach(t => setTimeout(paintChrome, t));
}

/* ---------------- ② 好感度（按人物：一个人挂多个平台账号，共享一个好感度） ---------------- */
// 快照还没到时的兜底（正常都走 S.snap.platforms = people.js 那份注册表）
const PLAT_LABEL = { qq: 'QQ', bili: 'B站' };
const platTable = () => ((S.snap && S.snap.platforms && S.snap.platforms.length)
  ? S.snap.platforms
  : [{ key: 'qq', label: 'QQ', digit: true }, { key: 'bili', label: 'B站', digit: true }]);
// 平台名不写死：加小红书/抖音/小黑盒时，前端这里一行都不用改
const plab = p => {
  const k = String(p || '');
  const tb = platTable().find(x => String(x.key) === k);
  return tb ? tb.label : (PLAT_LABEL[k] || k);
};
// 建人物 / 加账号的平台下拉，同样从注册表生成
const platOptions = cur => platTable().map(x =>
  `<option value="${esc(x.key)}"${String(x.key) === String(cur) ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
/* 账号号的规矩由 people.js 定（QQ/B站 纯数字，小红书/抖音/小黑盒允许字母数字）：
 * 前端只挡空值 + 明显不合法，不再写死「纯数字 4~12 位」（那样小红书号会被挡在外面）。 */
function accIdError(id, plat) {
  const s = String(id || '').trim();
  if (!s) return '账号号不能空';
  const tb = platTable().find(x => String(x.key) === String(plat));
  const digit = tb ? !!tb.digit : true;
  if (digit && !/^\d{1,20}$/.test(s)) return (tb ? tb.label : '这个平台') + ' 的账号号是纯数字';
  if (!digit && !/^[A-Za-z0-9_.\-]{1,64}$/.test(s)) return '账号号只能用字母、数字、下划线、点、横杠';
  return '';
}
const firstAcc = x => (x && x.accounts && x.accounts[0]) || null;
const personLabel = x => x.name || x.nick || (firstAcc(x) ? plab(firstAcc(x).platform) + ' ' + firstAcc(x).id : '（没有账号）');

/* ---------------- 学习 · 好感事件（2026-11-09） ----------------
 * 她定的第一条：每个人独立好感——动态分数、时间衰减、事件触发修正、变更理由归档、可撤销。
 * 这一页只读 src/data/learn/users/<pid>/favor.jsonl，以及 people.js 里的当前分数。
 * 不给机器人加任何新提示词：注入的那一小段由 learn.hot() 生成，这里只是给人看的。 */
async function loadLearn() {
  const r = await window.xuh.learn();
  S.learn.data = (r && !r.error)
    ? r
    : { users: [], enabled: false, error: (r && r.error) || '读不到' };
  S.learn.loaded = true;
  if (S.tab === 'learn') render();
}

function learnTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0')
    + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function learnEventHtml(pid, e) {
  const d = Number(e.delta) || 0;
  const color = d > 0 ? 'var(--good, #d24)' : (d < 0 ? 'var(--bad, #2a7)' : 'var(--dim, #888)');
  return `<div class="small" style="display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line)">
    <span class="mono dim" style="width:78px;flex:none">${esc(learnTime(e.ts))}</span>
    <span class="mono" style="width:46px;flex:none;color:${color}">${d > 0 ? '+' : ''}${d}</span>
    <span style="flex:1">${esc(e.reason || '（没写理由）')}</span>
    <span class="dim" style="flex:none">${esc(e.by === 'master' ? '你改的' : '自动')}</span>
    ${e.undone
      ? '<span class="dim" style="flex:none">已撤销</span>'
      : `<span class="dim" style="flex:none;cursor:pointer" data-act="learn-revoke" data-pid="${esc(pid)}" data-id="${esc(e.id)}" title="撤回这次变化（不会删记录，会留一条反向记录）">撤销</span>`}
  </div>`;
}

function htmlLearnDsh(d) {
  const st = d.dshState || {};
  const rows = [
    { k: '写作风格卡', v: st.hasCard, p: (st.paths || {}).card },
    { k: '写作风格档案', v: st.hasWriting, p: (st.paths || {}).writing },
  ];
  const body = rows.map(r => `
    <div class="form-row" style="gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid rgba(0,0,0,.05)">
      <span style="flex:none;width:110px">${esc(r.k)}</span>
      <span style="flex:none;width:78px">${r.v ? '<b style="color:#2a7a2a">已有内容</b>' : '<span class="dim">空的</span>'}</span>
      <span class="mono small dim" style="flex:1;word-break:break-all">${esc(r.p || '')}</span>
    </div>`).join('');
  return `
  <div class="sheet" style="margin-top:12px"><div class="sheet-head"><h2>桌面 harness 的风格档案</h2>
    <span class="hint">${d.dsh ? '接进提示词：开' : '接进提示词：关'}</span></div>
    <div class="sheet-body">
      <div class="small dim">这两份档案由 DeepSeek Harness 里装的风格插件学出来、自己维护，虚幻<b>只读不改</b>。
      有内容时每轮自动出现在提示词里，排在「对某个人的好感」前面——先定怎么说，再说对谁什么态度。</div>
      <div style="margin-top:8px">${body}</div>
      ${st.err ? `<div class="small" style="color:#c33;margin-top:6px">读取出错：${esc(st.err)}</div>` : ''}
      ${(!st.hasCard && !st.hasWriting) ? '<div class="small" style="margin-top:8px">现在两份都是空的，所以提示词里还没有这一段。<br>让它有内容：打开 <b>DeepSeek Harness</b> → 改一段 AI 写的稿子（或在会话里说「学一下这段的风格」）→ 学完这里就有东西了，虚幻下一轮就会照着说。</div>' : ''}
    </div>
  </div>`;
}

function htmlLearn() {
  const d = S.learn.data || {};
  const users = d.users || [];
  const decaying = users.filter(u => u.decay && Number(u.decay.rate) > 0).length;
  const start = `
  <div class="counters">
    <div class="counter"><div class="counter-n">${num(users.length)}</div><div class="counter-l">有记录的人</div></div>
    <div class="counter"><div class="counter-n">${num(decaying)}</div><div class="counter-l">正在掉分</div></div>
    <div class="counter"><div class="counter-n">${num(users.filter(u => u.favor >= 60).length)}</div><div class="counter-l">亲近（≥60）</div></div>
    <div class="counter"><div class="counter-n">${num(d.actsTotal || 0)}</div><div class="counter-l">冷层记录（说过什么）</div></div>
    <div class="counter"><div class="counter-n">${num(users.reduce((n, u) => n + ((u.kb && u.kb.total) || 0), 0))}</div><div class="counter-l">知识库总条数</div></div>
  </div>

  <div class="row" style="border:0;padding:4px 0 8px">
    <button class="btn" data-act="param-open" title="打开参数浮层：开关 / 数值 / 触发词">⚙ 打开参数（开关 / 数值 / 触发词）</button>
    <span class="small dim">好感度衰减总开关在「参数 · 开关」；这里看每人掉分详情</span>
  </div>

  <div class="sheet"><div class="sheet-head"><h2>这些记录是怎么来的</h2>
    <span class="hint">${d.enabled ? '学习：开' : '学习：关'} · 衰减：${d.decay ? '开' : '关'}${d.warm ? ' · 知识库检索：开' : ''}${d.acts ? ' · 冷层：开' : ''}</span></div>
    <div class="sheet-body">
      <div class="small dim">三层各管一件事，每轮只把前一层塞进提示词：<br>
      <b>热层</b>（每轮都进）：这个人是谁／跟他说话不许做什么／他自己怎么说话（三份档案，排在好感前面），加一句好感摘要。<br>
      <b>温层</b>（命中才进）：这个人的知识库，按他这句话去检索，最多 3 条，查不到就不给，不硬凑。<br>
      <b>冷层</b>（不进提示词）：说过什么话题、对谁说的、依据哪条原话——只给你查账用。<br>
      模型读的是已经写好的结论，不现场重算。掉分规则：掉一次之后每天按那次掉的量继续掉，直到来一次加分才停。撤销不删记录，留一条反向的。</div>
      ${d.error ? `<div class="small" style="color:#c33;margin-top:6px">读失败：${esc(d.error)}</div>` : ''}
      ${d.emb && d.emb.cooling ? '<div class="small dim" style="margin-top:6px">向量检索：本地 Ollama 没连上，现在只走字面命中（同义说法会漏）。</div>' : ''}
    </div>
  </div>
  ${htmlLearnDsh(d)}`;

  if (!users.length) {
    return start + '<div class="empty">还没有好感记录。等群里有人说话、分数变了，这里会长出来。</div>';
  }

  const cards = users.map(u => {
    const rate = Number((u.decay || {}).rate) || 0;
    const evs = (u.events || []).slice(0, 12).map(e => learnEventHtml(u.pid, e)).join('');
    return `
    <div class="sheet" style="margin-top:12px">
      <div class="sheet-head">
        <h2>${esc(u.name || u.pid)} · ${num(u.favor)}（${esc(u.level || '')}）</h2>
        <span class="hint">${(u.accounts || []).map(a => esc(a)).join(' · ')}${rate ? '　正在按每天 -' + rate + ' 掉' : ''}</span>
      </div>
      <div class="sheet-body">
        <div class="form-row" style="gap:8px;align-items:center">
          <input class="field mono" id="lf-${esc(u.pid)}" value="${num(u.favor)}" style="width:90px" title="直接改分数：差额会记成一条「你改的」记录">
          <button class="btn" data-act="learn-set" data-pid="${esc(u.pid)}">改成这个分</button>
          <button class="btn" data-act="learn-archive" data-pid="${esc(u.pid)}" data-name="${esc(u.name || u.pid)}">档案 / 知识库${u.style && u.style.has ? '（已写）' : ''}</button>
          <span class="small dim">手动改也会留记录，能撤销${u.kb && u.kb.total ? '　知识库 ' + u.kb.total + ' 条' : ''}</span>
        </div>
        <div id="la-${esc(u.pid)}" style="margin-top:10px"></div>
        <div style="margin-top:8px">${evs || '<div class="small dim">还没有变化记录</div>'}</div>
      </div>
    </div>`;
  }).join('');

  return start + cards;
}

function bindLearn() {
  view.querySelectorAll('[data-act="learn-revoke"]').forEach(el => {
    el.addEventListener('click', async () => {
      const pid = el.dataset.pid, id = el.dataset.id;
      // 不用 window.prompt：Electron 渲染进程不支持它，弹不出来等于按钮是死的
      el.textContent = '撤回中…';
      const r = await window.xuh.learnRevoke(pid, id, '客户端手动撤销');
      if (r && r.error) { toast('撤销失败：' + r.error); el.textContent = '撤销'; return; }
      toast('已撤销');
      await loadLearn();
    });
  });
  view.querySelectorAll('[data-act="learn-set"]').forEach(el => {
    el.addEventListener('click', async () => {
      const pid = el.dataset.pid;
      const input = document.getElementById('lf-' + pid);
      const v = Number(input && input.value);
      if (!isFinite(v)) { toast('填个数字'); return; }
      el.textContent = '写入中…';
      const r = await window.xuh.learnSetFavor(pid, v, '客户端手改');
      el.textContent = '改成这个分';
      if (r && r.error) { toast('没改成：' + r.error); return; }
      toast('改好了');
      await loadLearn();
    });
  });
  // 档案 / 知识库：展开在这一行下面（openArchive 在下面定义）
  view.querySelectorAll('[data-act="learn-archive"]').forEach(el => {
    el.addEventListener('click', () => openArchive(el.dataset.pid, el.dataset.name));
  });
}

/* ---------- 每人档案 / 知识库（2026-11-09 P1） ----------
 * 点一下就展开在这张卡片下面，不弹新窗口：她要看的是「这个人记了什么」，
 * 在同一个页面里对照分数和事件更直观。
 * 三份档案每轮都进提示词（排在好感前面），知识库命中才进（最多 3 条）。 */
async function openArchive(pid, name) {
  const box = document.getElementById('la-' + pid);
  if (!box) return;
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
  box.dataset.open = '1';
  box.innerHTML = '<div class="small dim">读取中…</div>';
  const st = await window.xuh.learnStyleGet(pid);
  const kb = await window.xuh.learnKbList(pid);
  if ((st && st.error) || (kb && kb.error)) {
    box.innerHTML = '<div class="small" style="color:#c33">读取失败：' + esc((st && st.error) || (kb && kb.error)) + '</div>';
    return;
  }
  const clean = (st && st.clean) || {};
  const field = (key, hint) => `
    <div style="margin-top:10px">
      <div class="small dim"><b>${esc(key)}</b> · ${esc(hint)}</div>
      <textarea class="field mono" id="ls-${esc(pid)}-${esc(key)}" rows="3" style="width:100%;margin-top:4px">${esc(clean[key] || '')}</textarea>
      <button class="btn" data-act="learn-style-save" data-pid="${esc(pid)}" data-key="${esc(key)}">存这一份</button>
    </div>`;
  const items = (kb && kb.items) || [];
  const rows = items.slice(0, 20).map(it => `
    <div class="small" style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
      <span class="dim" style="flex:none">${esc(it.day || String(it.ts || '').slice(0, 10))}</span>
      <span class="dim" style="flex:none">${esc(it.kind === 'pref' ? '偏好' : it.kind === 'exp' ? '经验' : '事实')}</span>
      <span style="flex:1">${esc(it.text)}</span>
      <span style="flex:none;cursor:pointer;color:#c33" data-act="learn-kb-del" data-pid="${esc(pid)}" data-id="${esc(it.id)}">删</span>
    </div>`).join('');
  box.innerHTML = `
    <div class="sheet"><div class="sheet-head"><h2>${esc(name)} 的档案</h2>
      <span class="hint">每轮都进提示词，排在好感摘要前面 · 一句一条，写短</span></div>
      <div class="sheet-body">
        ${field('角色性格', '这个人是谁：身份、脾气、在意什么')}
        ${field('允许&禁止', '跟这个人说话不许做的事，禁令放句首')}
        ${field('例句', '他自己说过的原话，只学味道，不许照样念')}
        <div class="small dim" style="margin-top:8px">存一份只换那一份；旧内容会留一份 .bak，写错能回退。三份全空就不进提示词。</div>
      </div></div>
    <div class="sheet" style="margin-top:10px"><div class="sheet-head"><h2>知识库（${items.length} 条）</h2>
      <span class="hint">命中才进提示词，最多 3 条 · 按人隔离，别人看不到</span></div>
      <div class="sheet-body">
        <div class="form-row" style="gap:8px;align-items:center;flex-wrap:wrap">
          <input class="field" id="lk-${esc(pid)}" placeholder="记一条：他说过 / 他偏好 / 他的经验" style="flex:1;min-width:220px">
          <select class="field" id="lk-kind-${esc(pid)}" style="width:96px">
            <option value="fact">事实</option><option value="pref">偏好</option><option value="exp">经验</option>
          </select>
          <button class="btn btn-primary" data-act="learn-kb-add" data-pid="${esc(pid)}">记下</button>
          <button class="btn" data-act="learn-kb-export" data-pid="${esc(pid)}" data-name="${esc(name)}">导出 JSON</button>
        </div>
        <div style="margin-top:8px">${rows || '<div class="small dim">还没有。记下之后，聊到相关的话才会用到。</div>'}</div>
      </div></div>`;
  bindArchive(box, pid, name);
}

// 动态插进来的那几个按钮，单独绑（它们不在 render 时的那批里）
function bindArchive(box, pid, name) {
  box.querySelectorAll('[data-act="learn-archive"]').forEach(() => {});
  box.querySelectorAll('[data-act="learn-style-save"]').forEach(el => {
    el.addEventListener('click', async () => {
      const key = el.dataset.key;
      const ta = document.getElementById('ls-' + pid + '-' + key);
      el.textContent = '存…';
      const r = await window.xuh.learnStyleSet(pid, key, ta ? ta.value : '');
      el.textContent = '存这一份';
      if (r && r.error) { toast('没存上：' + r.error); return; }
      toast('存好了，下一句就生效');
      await loadLearn();
    });
  });
  box.querySelectorAll('[data-act="learn-kb-add"]').forEach(el => {
    el.addEventListener('click', async () => {
      const input = document.getElementById('lk-' + pid);
      const sel = document.getElementById('lk-kind-' + pid);
      const text = input ? input.value.trim() : '';
      if (!text) { toast('先写点什么'); return; }
      el.textContent = '记…';
      const r = await window.xuh.learnKbAdd(pid, { text, kind: sel ? sel.value : 'fact' });
      el.textContent = '记下';
      if (r && r.error) { toast('没记上：' + r.error); return; }
      toast(r && r.duplicate ? '这条已经记过了' : '记下了');
      await loadLearn();
      const box2 = document.getElementById('la-' + pid);
      if (box2) { box2.dataset.open = '0'; openArchive(pid, name); }
    });
  });
  box.querySelectorAll('[data-act="learn-kb-del"]').forEach(el => {
    el.addEventListener('click', async () => {
      el.textContent = '删…';
      const r = await window.xuh.learnKbDel(pid, el.dataset.id);
      if (r && r.error) { toast('没删掉：' + r.error); return; }
      toast('删了');
      await loadLearn();
      const box2 = document.getElementById('la-' + pid);
      if (box2) { box2.dataset.open = '0'; openArchive(pid, name); }
    });
  });
  box.querySelectorAll('[data-act="learn-kb-export"]').forEach(el => {
    el.addEventListener('click', async () => {
      el.textContent = '导出中…';
      const r = await window.xuh.learnExport(pid, name);
      el.textContent = '导出 JSON';
      if (r && r.canceled) return;
      if (r && r.error) { toast('导出失败：' + r.error); return; }
      toast('已导出 ' + (r.count || 0) + ' 条：' + (r.file || ''));
    });
  });
}

function htmlPeople() {
  const list = (S.snap.people && S.snap.people.list) || [];
  const head = `
  <div class="counters">
    <div class="counter"><div class="counter-n">${num(list.length)}</div><div class="counter-l">人物</div></div>
    <div class="counter"><div class="counter-n">${num(list.filter(x => x.isMaster).length)}</div><div class="counter-l">主人号</div></div>
    <div class="counter"><div class="counter-n">${num(list.filter(x => x.favor > 0).length)}</div><div class="counter-l">好感 &gt; 0</div></div>
    <div class="counter"><div class="counter-n">${num(list.filter(x => (x.accounts || []).length > 1).length)}</div><div class="counter-l">多端同一人</div></div>
  </div>

  <div class="row" style="border:0;padding:4px 0 8px">
    <button class="btn" data-act="param-open" title="打开参数浮层：开关 / 数值 / 触发词">⚙ 打开参数（开关 / 数值 / 触发词）</button>
    <span class="small dim">好感度衰减总开关在「参数 · 开关」；逐人好感锁定在这里改</span>
  </div>

  <div class="sheet"><div class="sheet-head"><h2>新建人物</h2>
    <span class="hint">同一个人在 QQ 和 B站 各有一个号 → 建成一个人物，好感度共享</span></div>
    <div class="sheet-body">
      <div class="form-row" style="flex-wrap:wrap;gap:8px;align-items:center">
        <input class="field" id="np-name" placeholder="名字（可空）" style="width:150px">
        <select class="field" id="np-plat" style="width:110px">${platOptions('qq')}</select>
        <input class="field mono" id="np-id" placeholder="账号号（QQ/B站是数字）" style="width:170px">
        <button class="btn btn-primary" data-act="person-create">新建</button>
      </div>
    </div>
  </div>`;

  if (!list.length) return head + '<div class="empty">还没有记录过任何人。等群里有人说话，这里会长出来。</div>';

  const rows = list.map(p => {
    const accounts = p.accounts || [];
    const name = personLabel(p);
    const v = Number(p.favor) || 0;
    const w = Math.min(100, Math.abs(v));
    const open = S.openPerson === p.pid;
    const aliases = p.alias ? p.alias.split('、').filter(Boolean) : [];
    const accText = accounts.map(a => plab(a.platform) + ' ' + a.id).join(' · ');
    const chips = accounts.map(a => `<span class="small" style="display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin:2px 6px 2px 0">
        <span class="dim">${esc(plab(a.platform))}</span><span class="mono">${esc(a.id)}</span>
        <span class="dim" data-act="rm-acc" data-pid="${esc(p.pid)}" data-plat="${esc(a.platform)}" data-aid="${esc(a.id)}" title="把这个账号从这个人物里移走" style="cursor:pointer">✕</span>
      </span>`).join('');
    const others = list.filter(x => x.pid !== p.pid);

    const detail = open ? `
      <div class="detail">
        <div>
          <label>名字（你确认过的）</label>
          <input class="field" data-pf="name" data-pid="${esc(p.pid)}" value="${esc(p.name || '')}" placeholder="没确认就空着">
        </div>
        <div>
          <label>代称（最多 5 个，用、隔开）</label>
          <input class="field" data-pf="alias" data-pid="${esc(p.pid)}" value="${esc(p.alias || '')}" placeholder="例：小夏、夏夏">
        </div>
        <div>
          <label>资料卡名</label>
          <input class="field" data-pf="nick" data-pid="${esc(p.pid)}" value="${esc(p.nick || '')}">
        </div>
        <div>
          <label>所在地（地区表 · 按这个人记，查天气用）</label>
          <div class="form-row"><input class="field" data-region-pid="${esc(p.pid)}" value="${esc(p.region || '')}" placeholder="有多细填多细，例如 西安市 未央区；留空=清掉">
            <button class="btn btn-quiet" data-act="save-region" data-pid="${esc(p.pid)}">保存地区</button></div>
          <div class="small dim">图上写的「登陆地点：西安市 未央区」、他自己说住哪，AI 也会自动记并私信告诉你</div>
        </div>
        <div>
          <label>好感度（0 ~ 100，满 100 日常叫「宝宝」）</label>
          <div class="form-row">
            <input class="field mono" data-pf="favor" data-pid="${esc(p.pid)}" value="${v}" inputmode="numeric" style="width:80px">
            <button class="btn btn-primary" data-act="save-person" data-pid="${esc(p.pid)}">保存</button>
          </div>
        </div>
        <div style="grid-column:1/-1">
          <label>平台账号（这个人在这几个平台的身份）</label>
          <div>${chips}</div>
          <div class="form-row" style="margin-top:6px;flex-wrap:wrap;gap:6px;align-items:center">
            <select class="field" id="ap-plat-${esc(p.pid)}" style="width:110px">${platOptions('qq')}</select>
            <input class="field mono" id="ap-id-${esc(p.pid)}" placeholder="账号号（QQ/B站是数字）" style="width:170px">
            <button class="btn" data-act="add-acc" data-pid="${esc(p.pid)}">加到这个人</button>
          </div>
        </div>
        ${others.length ? `
        <div style="grid-column:1/-1">
          <label>合并（把另一个人的账号并进来，好感度相加封顶 100）</label>
          <div class="form-row" style="flex-wrap:wrap;gap:6px;align-items:center">
            <select class="field" id="mg-${esc(p.pid)}" style="max-width:280px">
              ${others.map(x => `<option value="${esc(x.pid)}">${esc(personLabel(x))}（${esc((firstAcc(x) || {}).id || '')}）</option>`).join('')}
            </select>
            <button class="btn" data-act="merge-into" data-pid="${esc(p.pid)}">合并进来</button>
          </div>
        </div>` : ''}
        ${(p.taste || []).length ? `
        <div style="grid-column:1/-1">
          <label>口味（她记下来的）</label>
          <div class="small" style="display:flex;flex-wrap:wrap;gap:4px 10px">
            ${p.taste.map(s => `<span><span class="dim">${esc(s.label)}：</span>${(s.items || []).map(i => esc(i.t) + (i.fromQQ ? `<span class="dim mono">（${esc(plab(i.fromPlatform || 'qq'))} ${esc(i.fromQQ)}）</span>` : '')).join('、')}</span>`).join('')}
          </div>
        </div>` : ''}
        ${(p.facts || []).length ? `
        <div style="grid-column:1/-1">
          <label>长期记忆里的事实</label>
          <div class="small dim">${p.facts.map((f, i) => '· ' + esc(f) + (p.factFrom && p.factFrom[i] ? ` <span class="dim mono">（${esc(plab((p.factPlat && p.factPlat[i]) || 'qq'))} ${esc(p.factFrom[i])}）</span>` : '')).join('<br>')}</div>
        </div>` : ''}
        ${Object.keys(p.cards || {}).length ? `
        <div style="grid-column:1/-1">
          <label>群名片（每个群各一张）</label>
          <div class="small dim">${Object.entries(p.cards).map(([g, n]) => '群 ' + esc(g) + '：' + esc(n)).join('　')}</div>
        </div>` : ''}
      </div>` : '';

    return `
      <div>
        <div class="row" data-act="person" data-pid="${esc(p.pid)}" style="cursor:pointer">
          <span class="grow trunc">
            ${esc(name)}
            ${p.isMaster ? '<span class="badge badge-blue">主人</span>' : ''}
            ${aliases.length ? `<span class="small dim">（${esc(aliases.join('、'))}）</span>` : ''}
            ${accText ? `<span class="small dim mono" style="margin-left:8px">${esc(accText)}</span>` : ''}
          </span>
          <span class="bar${v < 0 ? ' is-neg' : ''}"><i style="width:${w}%"></i></span>
          <span class="favor-v">${v}</span>
        </div>
        ${detail}
      </div>`;
  }).join('');

  return head + `<div class="sheet"><div class="sheet-head"><h2>按好感排</h2>
    <span class="hint">点一行展开：改称呼 / 好感度 / 加账号 / 合并</span></div>
    <div class="sheet-body flush">${rows}</div></div>`;
}

/* ---------------- ③ 参数（开关 / 数值 / 触发地图 三合一，2026-11-11 主人令）----------------
 * 为什么合并：这三页原来各占一个侧栏入口，其实都是「改机器人的参数」，来回点很碎。
 * 现在一个入口、顶上三段切换，每段保留原来的内容和操作，一个功能都没删。
 * 顶部先把三段的规模报出来（几个开关开着 / 多少条数值 / 多少条触发词），不用点进去也能看出量。 */
/* ===========================================================================
 * 参数浮层（2026-11-13 主人令）：
 *   - 入口从左侧导航「参数」改成悬浮工具坞里的 ⚙（#fabParam），点开是浮层抽屉（#paramPanel），
 *     面板可拖动、位置记住（浮窗系统 floatWin，2026-11-14）；
 *     都挂在 body 下、在 #view 之外 —— 显示/收起/改开关 都不会触发底下那页重渲染。
 *   - 数据复用全量 snapshot（S.snap），改动走各自 IPC；每次改动只刷新 S.snap + 浮层自身，
 *     绝不调 render()（那会重写 #view）。
 *   - 好感度衰减开关（learn.decay 等）由后端 featureStates 提供，这里直接能拨。
 * =========================================================================== */
const PARAM = {
  open: false,
  tab: 'features',
  trigMode: '',
  newTrigMode: 'say',
  llm: { loaded: false, data: null },
};

function paramBarSummary() {
  const fs = (S.snap && S.snap.features) || [];
  const on = fs.filter(x => x.state && x.state.indexOf('启用') === 0).length;
  const decay = fs.find(x => x.key === 'learn.decay');
  const decayOn = !!(decay && decay.state && decay.state.indexOf('启用') === 0);
  const tr = (S.snap && S.snap.triggers && S.snap.triggers.list) || [];
  const trOn = tr.filter(x => x.enabled).length;
  if (!fs.length) return '读数中…';
  return on + '/' + fs.length + ' 开 · 衰减 ' + (decayOn ? '开' : '关') + ' · 触发 ' + trOn + '/' + tr.length;
}

function paramRender() {
  const bar = document.getElementById('fabParam');
  if (bar) bar.title = '参数 · ' + paramBarSummary();
  const body = document.getElementById('paramBody');
  if (!body) return;
  if (!S.snap) { body.innerHTML = '<div class="loading">读出数据中…</div>'; return; }
  body.innerHTML = htmlControls();
  if (!PARAM.llm.loaded) loadLlm();
}

function paramOpen() {
  floatWinExclusive('param');
  PARAM.open = true;
  const p = document.getElementById('paramPanel');
  if (p) {
    p.hidden = false;
    floatWinApply(p);            // 先把上次拖到的位置摆回去，再淡入
    requestAnimationFrame(() => p.classList.add('is-open'));
  }
  paramRender();
}
function paramClose() {
  PARAM.open = false;
  const p = document.getElementById('paramPanel');
  if (p) { p.classList.remove('is-open'); setTimeout(() => { if (!PARAM.open) p.hidden = true; }, 200); }
}
function paramToggle() { PARAM.open ? paramClose() : paramOpen(); }

/* 改动后只刷新 snapshot 数据 + 浮层自身；不调 render()，底下那页原地不动 */
async function paramRefresh() {
  try {
    const r = await window.xuh.snapshot();
    if (r && !r.error) { S.snap = r; paintChrome(); }
  } catch (e) {}
  paramRender();
}

/* 浮层自己的点击委托（#view 的监听抓不到这里，因为浮层在 #view 之外） */
function bindParamPanel() {
  const bar = document.getElementById('fabParam');
  const panel = document.getElementById('paramPanel');
  if (bar) {
    bar.addEventListener('click', paramToggle);
  }
  if (!panel) return;
  panel.addEventListener('click', async e => {
    const rule = e.target.closest('.rule');
    if (rule && !e.target.closest('[data-act="num-edit"]') && !e.target.closest('form')) {
      const open = rule.dataset.open === '1';
      rule.dataset.open = open ? '0' : '1';
      rule.classList.toggle('is-open', !open);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'param-close') { paramClose(); return; }
    /* 自动同意清单（2026-11-14）：× 收起；✓ 只把「未看」清零，记录一条都不删。
     * 原面板那颗药丸点一下就是清零（见 public/panel-client.js 的 accept-read），这里保留同一份行为。 */
    if (act === 'accept-close') { S.accept.open = false; paintFloats(); return; }
    if (act === 'accept-read') {
      const r = await window.xuh.api('POST', '/api/accept-read', {});
      if (r && !r.error) { S.accept.count = 0; loadStatus(); toast('已标记为看过（记录没删）'); }
      else toast('标不了：' + ((r && r.error) || '未知原因'), true);
      paintFloats();
      return;
    }
    if (act === 'param-go-learn') { paramClose(); go('learn'); return; }
    if (act === 'param-go-friends') { paramClose(); go('friends'); return; }
    if (act === 'ctrl-tab') { PARAM.tab = btn.dataset.tab || 'features'; paramRender(); return; }

    if (act === 'switch') {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      const r = await window.xuh.setSwitch(btn.dataset.key, on);
      if (r && r.error) { toast('改不了：' + r.error, true); return; }
      btn.setAttribute('aria-pressed', String(on));
      toast(on ? '已打开' : '已关闭');
      await paramRefresh();
      return;
    }
    if (act === 'trig-toggle') {
      const on = btn.dataset.on !== '1';
      const r = await window.xuh.trigToggle(btn.dataset.id, on);
      if (r && r.error) { toast('改不了：' + r.error, true); return; }
      await paramRefresh();
      return;
    }
    if (act === 'trig-del') {
      if (btn.dataset.arm !== '1') {
        btn.dataset.arm = '1'; btn.textContent = '确认删';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
        return;
      }
      const r = await window.xuh.trigDel(btn.dataset.id);
      if (r && r.error) { toast('删不掉：' + r.error, true); return; }
      toast('已删');
      await paramRefresh();
      return;
    }
    if (act === 'trig-add') {
      const r = await window.xuh.trigAdd($('#nt-word').value, $('#nt-mode').value,
        { say: $('#nt-say').value, groupOnly: $('#nt-group').checked });
      if (r && r.error) { toast(r.error, true); return; }
      toast('加好了');
      await paramRefresh();
      return;
    }
    if (act === 'critic') {
      const r = await window.xuh.setCritic($('#critic-p').value);
      if (r && r.error) { toast('改不了：' + r.error, true); return; }
      toast('已保存：' + r.p);
      await paramRefresh();
      return;
    }
    if (act === 'num-edit') {
      const cell = btn.closest('.num-cell');
      if (cell.querySelector('form')) return;
      const k = cell.dataset.k;
      const cur = cell.querySelector('.v').textContent;
      const label = cell.querySelector('.k').textContent;
      const old = cell.innerHTML;
      cell.innerHTML = '<span class="k">' + esc(label) + '</span><form><input class="field mono" value="' + esc(cur) + '" inputmode="decimal"><button class="btn btn-primary" type="submit">存</button></form>';
      const form = cell.querySelector('form');
      const input = form.querySelector('input');
      input.focus(); input.select();
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const r = await window.xuh.setNum(k, input.value);
        if (r && r.error) { toast('改不了：' + r.error, true); return; }
        toast('已保存');
        await paramRefresh();
      });
      form.addEventListener('keydown', ev => { if (ev.key === 'Escape') cell.innerHTML = old; });
      return;
    }
  });
  panel.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'trig-mode') { PARAM.trigMode = t.value; paramRender(); }
    else if (t.id === 'nt-mode') { PARAM.newTrigMode = t.value; }
  });
}

function paramInit() {
  bindParamPanel();
  paramRender();
}

function htmlControls() {
  const C0 = PARAM;
  const fs2 = S.snap.features || [];
  const onN = fs2.filter(x => x.state && x.state.indexOf('启用') === 0).length;
  const T = S.snap.triggers || {};
  const trigList = T.list || [];
  const trigOn = trigList.filter(x => x.enabled).length;
  const secs = Array.isArray(S.snap.rules) ? S.snap.rules : [];
  const ruleN = secs.reduce((a, x) => a + ((x.rules || []).length), 0);
  const tabs = [
    ['features', '开关', onN + '/' + fs2.length + ' 开'],
    ['numbers', '数值', ruleN + ' 条'],
    ['triggers', '触发地图', trigOn + '/' + trigList.length + ' 条'],
  ];
  const bar = `<div class="pact-bar">
    <span class="pact-tabs">${tabs.map(([v, n, sub]) =>
      `<button class="chip${C0.tab === v ? ' is-on' : ''}" data-act="ctrl-tab" data-tab="${v}">${n}
        <span class="small dim" style="margin-left:6px">${esc(sub)}</span></button>`).join('')}</span>
    <span style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
      <button class="btn btn-quiet" data-act="param-go-friends" title="朋友录：逐人好感锁定 / 好感度">去朋友录 ›</button>
      <button class="btn btn-quiet" data-act="param-go-learn" title="好感度衰减的每人掉分详情在这里">去学习·好感怎么变 ›</button>
      <span class="small dim">改完立刻生效（机器人端现读配置）</span>
    </span>
  </div>`;
  const body = C0.tab === 'numbers' ? htmlNumbers()
    : C0.tab === 'triggers' ? htmlTriggers()
      : htmlFeatures();
  return bar + body;
}

/* ---------------- ③ 触发地图 ---------------- */
function htmlTriggers() {
  const T = S.snap.triggers || {};
  const list = T.list || [];
  const modes = T.modes || {};
  const modeKeys = Object.keys(modes);
  const byMode = {};
  modeKeys.forEach(k => { byMode[k] = list.filter(x => x.mode === k); });

  const counters = `
  <div class="counters">
    ${modeKeys.map(k => `
      <div class="counter">
        <div class="counter-n${(byMode[k] || []).length ? '' : ' is-zero'}">${num((byMode[k] || []).length)}</div>
        <div class="counter-l">${esc(modes[k].name)}</div>
        <div class="counter-sub">${esc(modes[k].use)}</div>
      </div>`).join('')}
  </div>`;

  const shown = PARAM.trigMode ? list.filter(x => x.mode === PARAM.trigMode) : list;
  const rowsHtml = shown.length ? shown.map(t => `
    <div class="row">
      <span class="grow trunc">
        ${(t.words || []).map(w => `<span class="mono" style="font-size:12px">${esc(w)}</span>`).join('<span class="dim"> · </span>')}
        ${t.groupOnly ? '<span class="badge">只群聊</span>' : ''}
      </span>
      <span class="badge ${t.mode === 'say' ? 'badge-blue' : ''}">${esc((modes[t.mode] || {}).name || t.mode)}</span>
      ${t.say ? `<span class="small dim trunc" style="max-width:220px" title="${esc(t.say)}">「${esc(t.say)}」</span>` : ''}
      <button class="toggle" data-act="trig-toggle" data-id="${esc(t.id)}" data-on="${t.enabled ? 1 : 0}"
              aria-pressed="${!!t.enabled}" aria-label="启用这条"></button>
      <button class="btn btn-danger" data-act="trig-del" data-id="${esc(t.id)}">删</button>
    </div>`).join('') : '<div class="empty">这一类还没有词。</div>';

  const form = `
  <div class="sheet">
    <div class="sheet-head"><h2>加一条</h2>
      <span class="hint">词可以用「、」隔开写多个</span></div>
    <div class="sheet-body">
      <div class="form-row">
        <label class="f"><span>词</span>
          <input class="field" id="nt-word" placeholder="例：晚安、睡了" style="width:220px">
        </label>
        <label class="f"><span>模式</span>
          <select class="field" id="nt-mode">
            ${modeKeys.map(k => `<option value="${k}"${PARAM.newTrigMode === k ? ' selected' : ''}>${esc(modes[k].name)}</option>`).join('')}
          </select>
        </label>
        <label class="f"><span>说什么（只有「固定话术」必须填）</span>
          <input class="field" id="nt-say" placeholder="命中后发这句话" style="width:260px">
        </label>
        <label class="f"><span>&nbsp;</span>
          <div style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="nt-group">
            <span class="small dim">只在群里生效</span>
          </div>
        </label>
        <button class="btn btn-primary" data-act="trig-add">加进去</button>
      </div>
    </div>
  </div>`;

  return counters + `
  <div class="toolbar">
    <select class="field" id="trig-mode">
      <option value="">全部模式</option>
      ${modeKeys.map(k => `<option value="${k}"${PARAM.trigMode === k ? ' selected' : ''}>${esc(modes[k].name)}</option>`).join('')}
    </select>
    <span class="small dim">共 ${num(list.length)} 条，启用 ${num(list.filter(x => x.enabled).length)} 条</span>
  </div>
  <div class="sheet"><div class="sheet-body flush">${rowsHtml}</div></div>` + form;
}

/* ---------------- ④ 开关 ---------------- */
/* 模型来源（2026-11-10）：AstrBot 里配好的源和模型，xuhbot 靠「模型名」直接用。
 * 只读 AstrBot 的配置，Key 一个字都不回客户端。 */
async function loadLlm() {
  try {
    const r = await window.xuh.api('GET', '/api/llmpool');
    PARAM.llm = { loaded: true, data: r || null };
  } catch (e) {
    PARAM.llm = { loaded: true, data: { error: e.message || '读不到' } };
  }
  // 模型来源只在「参数 · 开关」这一段显示，读完刷浮层（不碰主视图）
  if (PARAM.open) paramRender();
}

function llmPoolHtml() {
  if (!PARAM.llm.loaded) {
    return `<div class="sheet"><div class="sheet-head"><h2>模型来源（AstrBot）</h2></div>
      <div class="sheet-body"><div class="loading">读 AstrBot 配置中…</div></div></div>`;
  }
  const d = PARAM.llm.data;
  if (!d || d.error) {
    return `<div class="sheet"><div class="sheet-head"><h2>模型来源（AstrBot）</h2></div>
      <div class="sheet-body"><div class="small dim">读不到 AstrBot 配置：${esc((d && d.error) || '未知原因')}</div></div></div>`;
  }
  const cur = d.current || {};
  const ab = d.astrbot || {};
  const srcs = (ab.sources || []).map(s => s.name).join(' / ') || '（没有）';
  const models = ab.models || [];
  return `
  <div class="sheet">
    <div class="sheet-head"><h2>模型来源（AstrBot）</h2>
      <span class="hint">只读 AstrBot 配置；Key 不在这页显示</span></div>
    <div class="sheet-body">
      <div class="row"><span class="grow">当前默认模型</span><span class="mono small">${esc(cur.model || '未配')}</span></div>
      <div class="row"><span class="grow">接口地址</span><span class="mono small trunc">${esc(String(cur.endpoint || '').replace(/^https?:\/\//, ''))}</span></div>
      <div class="row"><span class="grow">自己配的 Key</span><span class="badge${cur.hasKey ? ' badge-blue' : ' badge-red'}">${cur.hasKey ? '已填' : '没填'}</span></div>
      <div class="row"><span class="grow">AstrBot 配好的源（${(ab.sources || []).length}）</span><span class="small dim trunc">${esc(srcs)}</span></div>
      <div class="row"><span class="grow">AstrBot 已配模型（${models.length}）</span><span class="small dim trunc">${esc(models.map(m => m.model).join('、') || '（没有）')}</span></div>
      <div class="small dim" style="margin-top:8px;line-height:1.7">
        怎么用：在 llm.json 的 model / fallbackModels 里直接写模型名（如 glm-4.5-flash）。
        想用 AstrBot 里配了 Key 但没加模型条目的源，写「源名/模型名」，例如 deepseek/deepseek-chat、moonshot/moonshot-v1-8k。
      </div>
    </div>
  </div>`;
}

function htmlFeatures() {
  const list = S.snap.features || [];
  const kinds = [];
  list.forEach(x => { if (kinds.indexOf(x.kind) < 0) kinds.push(x.kind); });

  const blocks = kinds.map(k => {
    const items = list.filter(x => x.kind === k);
    const on = items.filter(x => x.state && x.state.indexOf('启用') === 0).length;
    return `
    <details class="group" open>
      <summary>${esc(k)}<span class="cnt">${on}/${items.length} 开</span></summary>
      ${items.map(x => {
        const writable = x.key && x.key.charAt(0) !== '_';
        const isOn = x.state && x.state.indexOf('启用') === 0;
        const extra = x.state && x.state.indexOf('·') > 0 ? x.state.split('·').slice(1).join('·') : '';
        return `
        <div class="row">
          <span class="grow trunc">${esc(x.name)}${extra ? ` <span class="small dim">${esc(extra)}</span>` : ''}</span>
          ${writable
            ? `<button class="toggle" data-act="switch" data-key="${esc(x.key)}" aria-pressed="${isOn}" aria-label="${esc(x.name)}"></button>`
            : `<span class="badge${isOn ? ' badge-blue' : ' badge-red'}">${isOn ? '开' : '关'}</span>`}
        </div>`;
      }).join('')}
    </details>`;
  }).join('');

  const criticOn = (list.find(x => x.key === 'critic') || {}).state === '启用';
  return `
  ${llmPoolHtml()}
  <div class="sheet">
    <div class="sheet-head"><h2>功能总览</h2>
      <span class="hint">带滑块的可改；带「开/关」标签的是自动判断，改不了</span></div>
    <div class="sheet-body flush">${blocks}</div>
  </div>
  <div class="sheet">
    <div class="sheet-head"><h2>识别「嫌我蠢」的概率</h2></div>
    <div class="sheet-body">
      <div class="form-row">
        <label class="f"><span>0 = 关掉，0.15 = 每 100 句里挑 15 句重看</span>
          <input class="field mono" id="critic-p" value="${criticOn ? '0.15' : '0'}" style="width:120px">
        </label>
        <button class="btn" data-act="critic">保存</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- ⑤ 数值 ---------------- */
function htmlNumbers() {
  const secs = Array.isArray(S.snap.rules) ? S.snap.rules : [];
  if (!secs.length) return '<div class="empty">读不到规矩手册。</div>';
  let total = 0;

  const blocks = secs.map((sec, i) => {
    const rules = sec.rules || [];
    total += rules.length;
    return `
    <details class="group"${i === 0 ? ' open' : ''}>
      <summary>${esc(sec.name)}<span class="cnt">${rules.length} 条</span></summary>
      ${rules.map(r => `
        <div class="rule" data-act="rule" data-open="0">
          <div class="rule-n">${esc(r.n)}</div>
          ${r.d ? `<div class="rule-d">${esc(r.d)}</div>` : ''}
          ${(r.e || []).length ? `<div class="nums">${r.e.map(numCell).join('')}</div>` : ''}
          ${r.t ? `<div class="rule-t">${esc(r.t)}</div>` : ''}
        </div>`).join('')}
    </details>`;
  }).join('');

  return `<div class="sheet">
    <div class="sheet-head"><h2>所有数值</h2>
      <span class="hint">共 ${num(total)} 条 · 点标题展开说明，点「改」直接改</span></div>
    <div class="sheet-body flush">${blocks}</div>
  </div>`;
}

/* 派活词表：@她 + 命中词 + 好感满 100 才把这一轮交给我。
 * 一行一个词，改完点保存立刻生效（机器人端现读配置，不用重启）。 */
/* 「机器人 → dsh agent」卡：六组二选一 + 兜底句 + 词表 + 状态 */
function htmlAgentCard() {
  const C = S.intentCfg || {};
  const M = C.mode || {};
  const rows = [
    ['webOkWho', '老闸搜到了，谁答', 'free', '免费模型（不经过我）', 'agent', '我'],
    ['webMissWho', '老闸没搜到，谁查', 'agent', '我去查', 'free', '免费模型不查、直接说不知道'],
    ['dispatchPersona', '派活轮我成功，口吻', false, '直接给结果', true, '套 xuhbot 人设'],
    ['dispatchFail', '派活轮我失败', 'code', '纯代码兜底句', 'free', '交回免费模型'],
    ['chatPersona', '聊天轮我自主派活成功，口吻', true, 'xuhbot 人设', false, '直接给结果'],
    ['chatFail', '聊天轮我失败', 'code', '纯代码兜底句', 'free', '回原有兜底流程'],
    ['webSources', '通用网页搜索（Brave / Google / SearXNG）', true, '开', false, '关（只留官方三源）'],
  ];
  const cur = (k) => (M[k] === undefined ? '' : M[k]);
  const seg = ([k, label, va, ta, vb, tb]) => {
    const v = cur(k);
    const on = (x) => String(v) === String(x) ? ' is-on' : '';
    return `<div class="form-row" style="align-items:center;gap:10px;flex-wrap:wrap">
      <span class="small" style="min-width:210px">${esc(label)}</span>
      <button class="chip${on(va)}" data-act="intent-mode" data-k="${k}" data-v="${va}">${esc(ta)}</button>
      <button class="chip${on(vb)}" data-act="intent-mode" data-k="${k}" data-v="${vb}">${esc(tb)}</button>
    </div>`;
  };
  return `<div class="sheet">
    <div class="sheet-head"><h2>dsh agent</h2>
      <span class="hint">${C.enabled === false ? '派活总开关是关的（config 里 intent.enabled=false）' : '当前生效'} · 改完立刻生效（热读）</span></div>
    <div class="sheet-body">
      ${rows.map(seg).join('')}
      <div class="form-row" style="align-items:center;margin-top:8px">
        <label class="f" style="flex:1"><span>失败兜底句（纯代码，不进提示词）</span>
          <input class="field" id="ia-failtext" value="${esc(C.failText || '')}" style="width:100%"></label>
        <button class="btn" data-act="intent-cfg-save">保存</button>
      </div>
      <div class="small dim" style="margin-top:6px">好感满 ${esc(String(C.whitelistFavor || 100))} 的人 @她且命中词才派活；不中词的 @ 不派。</div>
    </div>
  </div>` + htmlIntentWords();
}

function htmlIntentWords() {
  const W = S.intentWords || { search: [], calc: [], negate: [] };
  const box = (k, title, hint) => `
    <label class="f" style="flex:1;min-width:220px"><span>${title}<span class="small dim" style="margin-left:6px">${hint}</span></span>
      <textarea class="field mono" id="iw-${k}" rows="6" style="width:100%">${esc((W[k] || []).join('\n'))}</textarea>
    </label>`;
  return `<div class="sheet">
    <div class="sheet-head"><h2>派活词（@她 + 命中词 + 好感满 100 才派给我）</h2>
      <span class="hint">一行一个词 · 不中词的 @ 不派</span></div>
    <div class="sheet-body">
      <div class="form-row" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
        ${box('search', '搜索/查证', '搜、查、核实、评分、账号…')}
        ${box('calc', '算数', '算、多少、像素、换算…')}
        ${box('negate', '排除（命中就不派）', '别搜、开玩笑…')}
      </div>
      <div class="form-row"><button class="btn" data-act="intent-words-save">保存词表</button>
        <span class="small dim">保存后立刻生效，不用重启</span></div>
    </div>
  </div>`;
}

function numCell(e) {
  return `<span class="num-cell" data-k="${esc(e.k)}" data-scale="${e.scale}" data-unit="${esc(e.unit || '')}">
    <span class="k">${esc(e.label)}</span>
    <span class="v">${esc(e.v)}</span>
    <span class="u">${esc(e.unit || '')}</span>
    <button class="edit" data-act="num-edit" title="${esc(e.tip || e.k)}">改</button>
  </span>`;
}

/* ---------------- ⑥ B站（评论区收图 + 直播弹幕记录） ---------------- */
const DM_KIND = { danmu: '弹幕', enter: '进场', gift: '礼物', sim: '测试' };

function fmtDmTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function loadBili() {
  // 2026-11-19：这一页被搬进聊天记录后，render 会被频繁触发；正在读就别重复发一遍。
  if (S.bili.loading) return;
  S.bili.loading = true;
  const r = await window.xuh.dmDays();
  if (r && r.error) { S.bili.loading = false; toast(r.error, true); return; }
  S.bili.days = (r && r.days) || [];
  S.bili.dir = (r && r.dir) || '';
  if (!S.bili.date) S.bili.date = S.bili.days[0] || '';
  if (S.bili.date) {
    const d = await window.xuh.dmRead(S.bili.date, 800);
    if (d && !d.error) { S.bili.items = d.items || []; S.bili.total = d.total || 0; }
  }
  S.bili.loaded = true;
  S.bili.loading = false;
  S.bili.mention = (await window.xuh.biliMention()) || null;
  if (S.tab === 'chat' && S.chat.tab === 'bili') render();
  paintBiliCount();
}

function paintBiliCount() {
  const el2 = $('#c-bili');
  if (!el2) return;
  el2.textContent = S.bili.loaded ? num(S.bili.items.length) : '—';
}

/* 收图任务进度：后端 /api/stickers/bili 的 GET 返回 {running,got,seen,skip,fail,log} */
let biliPollTimer = null;
async function pollBiliJob() {
  clearTimeout(biliPollTimer);
  const r = await window.xuh.api('GET', '/api/stickers/bili');
  if (r && r.error) { toast('查进度失败：' + r.error, true); return; }
  S.bili.job = r;
  if (S.tab === 'chat' && S.chat.tab === 'bili') render();
  if (r && r.running) biliPollTimer = setTimeout(pollBiliJob, 1500);
  else {
    const g = (r && r.got) || 0;
    toast(g ? '收完了：新进 ' + g + ' 张' : '收完了，没有新图（可能都是重复的）');
    if (S.tab === 'chat' && S.chat.tab === 'bili') render();
  }
}

function htmlBili(onlyMention) {
  const B = S.bili;
  const dayOpts = B.days.length
    ? B.days.map(d => `<option value="${esc(d)}"${d === B.date ? ' selected' : ''}>${esc(d)}</option>`).join('')
    : '<option value="">还没有记录</option>';

  const rows = B.items.length
    ? B.items.slice().reverse().map(x => `
      <div class="row">
        <span class="grow trunc">
          <span class="mono" style="font-size:12px">${esc(x.nick || '观众')}</span>
          <span class="dim">：</span>${esc(x.text)}
        </span>
        <span class="badge${x.kind === 'danmu' ? ' badge-blue' : ''}">${esc(DM_KIND[x.kind] || x.kind || '弹幕')}</span>
        <span class="small dim mono">${esc(fmtDmTime(x.t))}</span>
      </div>`).join('')
    : '<div class="empty">这一天还没有记录。陪玩接到弹幕就会自动写进来。</div>';

  const job = B.job;
  const jobHtml = job ? `
    <div class="small" style="margin-top:10px;white-space:pre-wrap;line-height:1.7">
      <span class="dim">${job.running ? '正在收…' : '上一轮结束'}　
      新收 ${num(job.got || 0)} 张 / 看到 ${num(job.seen || 0)} 张 / 跳过 ${num(job.skip || 0)} / 失败 ${num(job.fail || 0)}</span>
      ${(job.log || []).slice(-10).map(l => '\n· ' + esc(l)).join('')}
    </div>` : '';

  /* 评论区召唤：监听跑在 QQ 机器人进程里，这里只显示它写下的状态 */
  const M = B.mention;
  const mState = (!M || M.empty) ? '机器人还没启动过 —— 召唤要 QQ 机器人开着才生效' : (M.state || '未知状态');
  const mLast = (M && M.lastCheckAt) ? fmtDmTime(M.lastCheckAt) : '—';
  const mEvery = (M && M.everySec) ? M.everySec : 60;
  const mErr = (M && M.lastError) ? `<div class="small" style="color:#b4462f;margin-top:6px">上次没成功：${esc(M.lastError)}</div>` : '';
  const mTrig = (M && M.triggers) || [];
  const mRows = mTrig.length
    ? mTrig.slice(0, 8).map(t => `
      <div class="row">
        <span class="grow" style="min-width:0">
          <span class="trunc" style="display:block">
            <span class="mono" style="font-size:12px">${esc(t.from || '有人')}</span>
            <span class="dim">：</span>${esc(t.text || '')}
            <span class="dim">　${t.favor !== '' && t.favor !== undefined && t.favor !== null ? '好感 ' + t.favor + '　' : ''}${esc(t.note || '')}</span>
          </span>
          ${t.reply ? `<span class="small dim" style="display:block;white-space:normal;line-height:1.6">↳ ${esc(t.reply)}</span>` : ''}
        </span>
        <span class="badge${t.got > 0 ? ' badge-blue' : ''}">${t.got > 0 ? '+' + t.got + ' 张' : '0 张'}</span>
        <span class="small dim mono">${esc(fmtDmTime(t.at))}</span>
      </div>`).join('')
    : '<div class="empty">还没有人召唤过。去任意视频评论区 @虚幻 发【收图】试试。</div>';

  // 评论区分区只要「召唤」这一张 sheet（其余收图/弹幕留在 B站页页尾）——避免同页出现两份召唤
  if (onlyMention) return `
  <div class="sheet">
    <div class="sheet-head"><h2>评论区召唤</h2>
      <span class="hint">在任意视频评论区 @虚幻 发【收图】，机器人自己去收那个视频的图，再按人设回一句（说清收了几张）</span></div>
    <div class="sheet-body">
      <div class="form-row">
        <span class="badge${M && M.enabled ? ' badge-blue' : ''}">${esc(mState)}</span>
        <span class="small dim">上次检查 ${esc(mLast)}　每 ${num(mEvery)} 秒看一次</span>
        <button class="btn btn-quiet" data-act="bili-mention-refresh" style="margin-left:auto">刷新状态</button>
      </div>
      <div class="small dim" style="margin-top:6px">谁算数：她本人（B站 mid 白名单）+ 好感大于 60 的人；昵称对不上的一律不响应。话里点名视频也行，例如「@虚幻 收图 BV1xx411c7mD」。</div>
      ${mErr}
    </div>
    <div class="sheet-body flush">${mRows}</div>
  </div>`;

  return `
  <div class="sheet">
    <div class="sheet-head"><h2>B站评论区收图</h2>
      <span class="hint">贴一个视频链接 / BV 号 / av 号，收这个视频评论区里网友发的图</span></div>
    <div class="sheet-body">
      <div class="form-row">
        <label class="f" style="flex:1"><span>视频</span>
          <input class="field" id="bili-input" value="${esc(B.input)}" placeholder="例：BV1xx411c7mD 或 https://www.bilibili.com/video/BV..." style="width:100%">
        </label>
        <label class="f"><span>翻几页评论</span>
          <input class="field mono" id="bili-pages" value="2" inputmode="numeric" style="width:80px">
        </label>
        <button class="btn btn-primary" data-act="bili-collect">开收</button>
      </div>
      <div class="small dim" style="margin-top:6px">收进来的图进「表情包 → 少用 / 关键词触发」，两个文件夹各自最多 500 张；大于 8MB 的图单独进「大图」。和群友发的图同一套去重，重复的不会进来。</div>
      ${jobHtml}
    </div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>直播弹幕记录</h2>
      <span class="hint">陪玩接到弹幕就按天存档，这里翻历史</span></div>
    <div class="sheet-body">
      <div class="form-row">
        <label class="f"><span>哪一天</span>
          <select class="field" id="bili-date" style="width:160px">${dayOpts}</select>
        </label>
        <span class="small dim" style="align-self:flex-end;padding-bottom:8px">
          这一天共 ${num(B.total)} 条，下面显示最近 ${num(B.items.length)} 条</span>
        <button class="btn btn-quiet" data-act="bili-dmdir" style="margin-left:auto">打开存档目录</button>
      </div>
    </div>
    <div class="sheet-body flush">${rows}</div>
  </div>`;
}

/* ---------------- ⑦ 机器人（客户端负责起停） ----------------
 * 2026-11-05 她定「优先做让机器人跑起来的转移」：
 *   双击客户端 = 界面起来，机器人本体也跟着起来；关客户端 = 一起停。
 * 真正起进程的是 app/bot-runner.js，这里只显示状态 + 两个按钮，不自己写一套逻辑。 */

/* ---------------- 左上角那张图（2026-11-05） ----------------
 * 图本体在 src/data/ui/，配置在 src/data/ui.json（由主进程读写）。
 * 这里只做两件事：把地址贴到 CSS 上、点一下换个图。
 * 地址带 ?v=时间戳，换完立刻能看到新图（否则会吃缓存显示旧的）。 */
function paintSkin(r) {
  const rail = $('#rail');
  const artEl = $('#brand-art');
  if (!rail || !artEl || !r) return;
  if (!r.url) { rail.classList.remove('has-art'); return; }
  rail.style.setProperty('--art-o', String(typeof r.opacity === 'number' ? r.opacity : 0.58));
  art.url = r.url;
  art.pos = parsePos(r.pos || '50% 30%');
  art.apply();
  artEl.style.backgroundImage = 'url("' + r.url + '")';
  // 撤掉类 → 强制回流 → 再加回来：这样每次换图都会重新淡入一次
  rail.classList.remove('has-art');
  void artEl.offsetWidth;
  rail.classList.add('has-art');
}
async function loadSkin() {
  const r = await window.xuh.skin();
  if (!r || r.error) return;
  paintSkin(r);
}
async function pickSkin() {
  const r = await window.xuh.skinPick();
  if (!r || r.canceled) return;
  if (r.error) { toast('换不了：' + r.error, true); return; }
  paintSkin(r);
  toast('换好了');
}

/* ---------------- 调头图位置（2026-11-05 她要「可以自己调整」） ----------------
 * 存的是两个百分比（背景图取景位置），不是像素 —— 换多大的图都能对上。
 * X/Y 变大 = 看到图的更靠右/更靠下那部分（也就是图整体往左上走）。
 * 左边那块和浮层里的预览共用同一份 art.pos，所以拖预览框里的图，
 * 关掉浮层左栏就已经是新的了。 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function parsePos(str) {
  const map = { center: 50, left: 0, right: 100, top: 0, bottom: 100 };
  const parts = String(str || '').trim().split(/\s+/).filter(Boolean);
  const one = (t, dflt) => {
    if (t == null) return dflt;
    if (map[t] != null) return map[t];
    const n = parseFloat(t);
    return isNaN(n) ? dflt : clamp(n, 0, 100);
  };
  if (!parts.length) return { x: 50, y: 30 };
  // 也认 "top center" / "left bottom" 这种先写上下的写法
  if (parts[0] === 'top' || parts[0] === 'bottom') {
    return { x: one(parts[1], 50), y: one(parts[0], 50) };
  }
  return { x: one(parts[0], 50), y: one(parts[1], 30) };
}

const art = {
  url: '',
  pos: { x: 50, y: 30 },
  apply() {
    const p = Math.round(this.pos.x) + '% ' + Math.round(this.pos.y) + '%';
    const railEl = $('#brand-art');
    if (railEl) railEl.style.backgroundPosition = p;
    const stage = $('#art-stage');
    if (stage) stage.style.backgroundPosition = p;
  },
};

async function artSave() {
  const r = await window.xuh.skinSet({ pos: Math.round(art.pos.x) + '% ' + Math.round(art.pos.y) + '%' });
  if (r && r.error) toast('存不下：' + r.error, true);
}

function artOpen() {
  const stage = $('#art-stage');
  if (!stage) return;
  if (art.url) stage.style.backgroundImage = 'url("' + art.url + '")';
  art.apply();
  $('#art-modal').hidden = false;
}
function artClose() { $('#art-modal').hidden = true; }

/* 拖动：按“把图挪走”的手感算 —— 往右拖，图就往右走（取景位置百分比变小） */
(function bindArtDrag() {
  const stage = $('#art-stage');
  if (!stage) return;
  let drag = null;
  stage.addEventListener('pointerdown', e => {
    drag = { sx: e.clientX, sy: e.clientY, px: art.pos.x, py: art.pos.y };
    try { stage.setPointerCapture(e.pointerId); } catch {}
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    art.pos.x = clamp(drag.px - (e.clientX - drag.sx) / r.width * 100, 0, 100);
    art.pos.y = clamp(drag.py - (e.clientY - drag.sy) / r.height * 100, 0, 100);
    art.apply();
  });
  const end = () => { if (!drag) return; drag = null; artSave(); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', end);
})();

/* ---------------- 事件 ---------------- */
document.querySelectorAll('.nav-item').forEach(b => {
  b.addEventListener('click', () => go(b.dataset.view));
});

$('#btn-check').addEventListener('click', async () => {
  const r = await window.xuh.api('POST', '/api/checkup');
  if (!r || r.error) { toast('体检没跑成：' + ((r && r.error) || '未知原因'), true); return; }
  const n = (r.issues ? r.issues.length : 0);
  toast('体检完成：' + n + ' 项问题' + (r.fixed ? '，已自动修 ' + r.fixed + ' 处' : ''));
});
$('#btn-tidy').addEventListener('click', async () => {
  const r = await window.xuh.api('POST', '/api/tidy-all');
  if (!r || r.error) { toast('净化没跑成：' + ((r && r.error) || '未知原因'), true); return; }
  toast('净化完成：清了 ' + (r.total || 0) + ' 处排版符号');
});
$('#reload').addEventListener('click', () => {
  if (window.StickerPage && window.StickerPage.reset) window.StickerPage.reset();
  chatResetView();                               // 刷新 = 重置：贴底 + 回到第 1 页
  loadSnapshot();
  toast('已刷新');
});
$('#status-mid').addEventListener('click', e => {
  const b = e.target.closest('[data-act="status-go"]');
  if (b) { go(b.dataset.view); return; }
  const a = e.target.closest('[data-act="status-accept"]');
  if (a) { acceptOpen(); return; }
  const sf = e.target.closest('[data-act="status-self"]');
  if (sf) { go('bot'); toast('自查明细在「机器人」页的体检结果里'); return; }
});
/* 换左上角那张图：入口只有左下角这一处（图本身压在按钮下面、不可点，避免挡点击） */
$('#open-skin').addEventListener('click', pickSkin);
$('#open-artpos').addEventListener('click', artOpen);

/* 调头图位置的浮层：点 × 或点空白关掉；四个方向键一次挪 4% */
$('#art-modal').addEventListener('click', e => {
  if (e.target.id === 'art-modal') { artClose(); return; }
  const btn = e.target.closest('[data-act],[data-art]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'art-close') { artClose(); return; }
  if (act === 'art-reset') { art.pos = { x: 50, y: 30 }; art.apply(); artSave(); toast('已复位'); return; }
  const dir = btn.dataset.art;
  if (dir) {
    const step = 4;
    if (dir === 'up') art.pos.y = clamp(art.pos.y + step, 0, 100);
    if (dir === 'down') art.pos.y = clamp(art.pos.y - step, 0, 100);
    if (dir === 'left') art.pos.x = clamp(art.pos.x + step, 0, 100);
    if (dir === 'right') art.pos.x = clamp(art.pos.x - step, 0, 100);
    art.apply();
    artSave();
  }
});
document.addEventListener('keydown', e => {
  const m = $('#art-modal');
  if (e.key === 'Escape' && m && !m.hidden) artClose();
});
$('#open-data').addEventListener('click', () => window.xuh.openDir('data'));
$('#open-stickers').addEventListener('click', () => window.xuh.openDir('stickers'));

view.addEventListener('change', async e => {
  const t = e.target;
  // 喜恶条目换节：把「待确认」拖到「喜欢·确定」= 她认下了（六节仍是同一份 md）。
  if (t.dataset && t.dataset.act === 'taste-move') {
    const r = await window.xuh.api('POST', '/api/taste/set', {
      mode: 'edit', qq: t.dataset.pid, sec: t.dataset.sec, oldText: t.dataset.old,
      text: t.dataset.old, targetSec: t.value,
    });
    if (!r || r.error) { toast('没换节：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends(); toast('换节了'); return;
  }
  if (t.id === 'bili-date') { S.bili.date = t.value; loadBili(); }
  else if (t.id === 'bot-keep') {
    // 常驻开关：关掉客户端后机器人继续跑 / 一起停
    window.xuh.botKeepAlive(t.checked).then(r => {
      if (r && r.error) { t.checked = !t.checked; toast('改不了：' + r.error, true); return; }
      toast(t.checked ? '已开：关掉客户端机器人也继续跑' : '已关：关掉客户端会一起停');
      setTimeout(loadBot, 300);
    }).catch(() => { t.checked = !t.checked; toast('改不了', true); });
  }
});

// 搜索框：边打边筛。整页重画会丢焦点，所以画完把焦点和光标放回去。
view.addEventListener('input', e => {
  const t = e.target;
  if (e.isComposing || e.keyCode === 229) return;   // IME 拼音合成中不要重画，否则输入框被销毁、拼音打不出来
  if (['pact-q', 'chat-q', 'teach-q', 'friend-q', 'kb-q', 'kb-who'].indexOf(t.id) < 0) return;
  const id = t.id, v = t.value, pos = t.selectionStart;
  if (id === 'pact-q') S.pacts.q = v;
  else if (id === 'teach-q') S.teach.q = v;
  else if (id === 'kb-q') S.kb.q = v;
  else if (id === 'kb-who') S.kb.who = v;
  else if (id === 'friend-q') S.friends.q = v;
  else { S.chat.q = v; chatResetView(); }   // 搜索 = 重置，画完贴底 + 回到第 1 页
  render();
  const again = document.getElementById(id);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
});

// 时间范围（date 输入在 Chromium 里不一定发 input，单独接 change）
view.addEventListener('change', e => {
  const t = e.target;
  /* 二级目录联动（主人 2026-11-13）：一级换「教学知识 / 约定 / 话题」，二级立刻换成对应方向 / 分区，
   * 不把所有选项摆一页。选中值记在弹层对象上，重绘后还在。 */
  if (t.id === 'rv-type' && S.review.open) {
    S.review.open._type = t.value;
    render();
    return;
  }
  if (t.id !== 'kb-since' && t.id !== 'kb-until') return;
  if (t.id === 'kb-since') S.kb.since = t.value; else S.kb.until = t.value;
  render();
});

/* 我的口味：拖一行换位置（2026-11-13 主人令「前端的各喜好位置，需要能随意拖动挪位」）。
 * 只换栏序（存 data/喜好参数.json），正文的行序一个字节都不动。 */
view.addEventListener('dragstart', e => {
  const w = e.target.closest && e.target.closest('[data-act="mine-word"]');
  if (w) { S.friends.dragWord = { sec: w.dataset.sec || '', t: w.dataset.t || '' }; S.friends.dragSec = ''; try { e.dataTransfer.effectAllowed = 'move'; } catch {} return; }
  const el = e.target.closest && e.target.closest('[data-act="mine-col"]');
  if (!el) return;
  S.friends.dragSec = el.dataset.sec || '';
  S.friends.dragWord = null;
  try { e.dataTransfer.effectAllowed = 'move'; } catch {}
});
view.addEventListener('dragover', e => {
  const el = e.target.closest && e.target.closest('[data-act="mine-col"]');
  if (el && S.friends.dragSec) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch {} }
});
view.addEventListener('drop', async e => {
  // 词条：拖到同一栏的另一个词上 → 换到那个位置
  const dw = S.friends.dragWord;
  const tw = e.target.closest && e.target.closest('[data-act="mine-word"]');
  if (dw && tw && tw.dataset.sec === dw.sec && tw.dataset.t !== dw.t) {
    e.preventDefault();
    S.friends.dragWord = null;
    const arr = ((S.friends.mine || {})[dw.sec] || []);
    const to = arr.indexOf(tw.dataset.t);
    const r = await window.xuh.api('POST', '/api/taste/mine', { mode: 'move', sec: dw.sec, text: dw.t, toIdx: to });
    if (!r || r.error) { toast('挪不了：' + ((r && r.error) || '未知原因'), true); return; }
    await loadMine(); toast('位置换了'); return;
  }
  S.friends.dragWord = null;
  const el = e.target.closest && e.target.closest('[data-act="mine-col"]');
  const from = S.friends.dragSec;
  S.friends.dragSec = '';
  if (!el || !from) return;
  e.preventDefault();
  const to = el.dataset.sec || '';
  if (!to || to === from) return;
  const order = ((S.friends.mine || {}).cols || []).map(c => c.key).filter(k => k !== from);
  const at = order.indexOf(to);
  order.splice(at < 0 ? order.length : at, 0, from);
  const r = await window.xuh.api('POST', '/api/taste/mine', { mode: 'order', order });
  if (!r || r.error) { toast('挪不了：' + ((r && r.error) || '未知原因'), true); return; }
  await loadMine(); toast('顺序改了');
});
/* 点一下外面就关（主人 2026-11-13 §4）：卡内、图形入口、录入入口都不算「外面」。
 * 只重画 #floats，不动 #view —— 不会把底下那页没保存的输入冲掉。 */
document.addEventListener('mousedown', e => {
  if (!S.float.friendsTopic && !S.float.chatTopic && !S.float.replypath && !S.kb.spec) return;
  const t = e.target;
  if (t.closest && (t.closest('.float-card') || t.closest('[data-act="float-topic"]')
    || t.closest('[data-act="kb-spec-new"]') || t.closest('.fab-dock'))) return;
  S.float.friendsTopic = false; S.float.chatTopic = false;
  S.float.replypath = false; S.kb.spec = null;
  paintFloats();
});
document.addEventListener('click', async e => {
  // 数值说明折叠
  const rule = e.target.closest('.rule');
  if (rule && !e.target.closest('[data-act="num-edit"]') && !e.target.closest('form')) {
    const open = rule.dataset.open === '1';
    rule.dataset.open = open ? '0' : '1';
    rule.classList.toggle('is-open', !open);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  /* ===== 主页 / 左栏 / 接管面板（2026-11-16） ===== */
  if (act === 'home-close') { homeClose(); return; }
  if (act === 'home-back') { homeBack(); return; }
  if (act === 'home-mode') { S.home.mode = btn.dataset.mode || 'sum'; render(); return; }
  if (act === 'home-panel') { homeOpenPanel(btn.dataset.panel, {}); return; }
  if (act === 'home-drill') { homeDrill(btn.dataset.view); return; }
  if (act === 'page-up') { pageUp(); return; }
  if (act === 'more-open') {
    const mid = btn.dataset.id;
    const cur = { id: 'more', label: '其他' };
    PG.stack = [cur];
    const it = (typeof MORE_ITEMS !== 'undefined' ? MORE_ITEMS : []).find(x => x.id === mid);
    if (it) PG.stack.push({ id: mid, label: it.label });
    const sp = { logs: { page: 'logs' }, vocab: { page: 'meme' } }[mid] || { page: 'logs' };
    if (mid === 'vocab') S.meme.vtab = 'vocab';
    go(sp.page);
    pageHeadSync();
    return;
  }
  if (act === 'home-person') { return; }
  if (act === 'home-split-pick') {
    S.home.splitKey = btn.dataset.conv || '';
    S.chat.conv = btn.dataset.conv || '__all';
    S.chat.pinBottom = true;
    render();
    toast('已按这一条分开显示，聊天记录也跟着切过来了');
    return;
  }
  if (act === 'accept-jump') { acceptJump(btn); return; }
  if (act === 'chat-split') return;
  /* 话题 / 记录的：一个图形入口开一张悬浮卡，一屏只留一张（主人 2026-11-13 §4）。 */
  if (act === 'float-topic') {
    floatWinExclusive('float');
    const v = btn.dataset.v;
    const on = !S.float[v];
    S.float.friendsTopic = false; S.float.chatTopic = false; S.kb.spec = null;
    S.float.replypath = false;
    if (on) S.float[v] = true;
    if (on && v === 'replypath') { S.rp.form = null; S.rp.desc = null; S.rp.word = null; loadRp(); }
    paintFloats();
    return;
  }
  // 一屏只开一个自绘弹层：打开待修复 / 标错 / 推理 / 工作日志时，先收起加星弹层
  if (['chat-issues', 'chat-issue', 'chat-log', 'chat-trace'].indexOf(act) >= 0) S.chat.starItem = null;
  /* 聊天页的「重置」动作：换筛选、只看某类，画完一律贴着最底、从第 1 页重新开始（主人 2026-11-11 定）。
   * 切会话不在此列——切会话要保留各会话自己的位置和已翻的页数（见 stickChatBottom）。 */
  if (['chat-onlystar', 'chat-onlybot', 'chat-emo-has', 'chat-emo-leak', 'chat-pact'].indexOf(act) >= 0) chatResetView();

  /* 实时思考开关（2026-11-11 主人令）：改的是机器人端 config.context.liveThink，
   * 关掉 = 机器人真的不再生成思考（省 token），不是这边藏起来。 */
  /* 本轮提示词（2026-11-13）：折叠 / 展开全文 / 复制 / 删除。
   * 删除只清这一个槽，不碰别的来源；清完后该来源下一轮回复由 core 自动补一条。 */
  if (act === 'chat-prompt-fold') { S.chat.promptFold = !S.chat.promptFold; paintPromptSlots(); return; }
  if (act === 'chat-prompt-full') {
    const id = btn.dataset.id;
    S.chat.promptFull[id] = !S.chat.promptFull[id];
    paintPromptSlots(); return;
  }
  if (act === 'chat-prompt-copy') {
    const it = promptSlotFind(btn.dataset.id);
    if (!it) return;
    await window.xuh.copyText(promptSlotText(it));
    toast('已复制这一轮的完整提示词'); return;
  }
  if (act === 'chat-prompt-del') {
    const cat = btn.dataset.cat, k = btn.dataset.k, id = btn.dataset.id;
    const r = await window.xuh.api('POST', '/api/chat/prompts/del', { cat, k });
    if (!r || r.ok === false || r.error) {
      toast('删不掉：' + ((r && (r.error || '')) || '未知原因'), true); return;
    }
    delete S.chat.promptFull[id];
    // 先本地移除，点了立刻看得见；再主动重拉一次对齐后端（不是轮询）。
    const cur = S.chat.prompts || {};
    if (cur[cat]) delete cur[cat][k];
    paintPromptSlots();
    await loadPromptSlots(true);
    toast('已删掉这一条；这个来源下一轮回复后会自动补一条');
    return;
  }
  /* 浮层标签切换：纯前端 class 切换，不重渲染消息列表（保留滚动位置） */
  if (act === 'dock-tab') {
    S.chat.dockTab = btn.dataset.dock || 'think';
    const d = view.querySelector('.chat-dock');
    if (d) {
      d.dataset.tab = S.chat.dockTab;
      d.querySelectorAll('.dock-tab').forEach(b => b.classList.toggle('is-on', b.dataset.dock === S.chat.dockTab));
    }
    return;
  }
  /* ===== 当前状态（2026-11-14 按人改，和约定同一套）=====
   * 全局（who=''）= 本体外貌，每个会话都注入；这里（who=p:<人> / g:<群>）= 只对这个人/这个群。
   * 更新制：同主题自动覆盖；总数无上限；每轮注入最近 N 条。 */
  if (act === 'chat-state-add') {
    const st = S.chat.convState || {};
    const wantHere = btn.dataset.who === 'here';
    // 「这里」但后端没算出归属（这个会话认不出是谁）→ 别默默记成全局，说清楚
    if (wantHere && !st.who) { toast('这个会话还认不出是谁，只能记「全局」', true); return; }
    S.chat.stateEdit = { text: '', topic: '', kind: 'normal', who: wantHere ? st.who : '', whoLabel: st.whoLabel || '' };
    render(); return;
  }
  if (act === 'chat-state-edit') {
    const id = btn.dataset.id;
    const st = S.chat.convState || {};
    const s = (st.globals || []).concat(st.mine || []).find(x => x.id === id); if (!s) return;
    S.chat.stateEdit = { id, text: s.text || '', topic: s.topic || '', kind: s.kind || 'normal', who: s.who || '', whoLabel: s.whoLabel || '' };
    render(); return;
  }
  if (act === 'chat-state-del') {
    const id = btn.dataset.id;
    const r = await window.xuh.api('POST', '/api/conv/state/del', { id });
    if (!r || r.ok === false || r.error) { toast('删不掉：' + ((r && (r.error || '')) || '未知原因'), true); return; }
    await loadConvState(); toast('已删这条状态'); return;
  }
  if (act === 'chat-state-show') {
    const el = document.getElementById('state-show-n'); const n = el ? Number(el.value) : 0;
    if (!n || n < 1) { toast('数字要 ≥ 1'); return; }
    const r = await window.xuh.api('POST', '/api/conv/state/show', { show: n });
    if (!r || r.ok === false || r.error) { toast('改不了：' + ((r && (r.error || '')) || '未知原因'), true); return; }
    await loadConvState(); toast('每轮注入条数已改成 ' + n); return;
  }
  if (act === 'state-kind') { if (S.chat.stateEdit) { S.chat.stateEdit.kind = btn.dataset.k === 'local' ? 'local' : 'normal'; render(); } return; }
  if (act === 'state-cancel') { S.chat.stateEdit = null; render(); return; }
  if (act === 'state-save') {
    const e = S.chat.stateEdit; if (!e) return;
    const el = document.getElementById('state-text'); const text = el ? String(el.value || '').trim() : '';
    const tpEl = document.getElementById('state-topic'); const topic = tpEl ? String(tpEl.value || '').trim() : '';
    if (!text) { toast('状态内容不能为空'); return; }
    const meta = curConvMeta();
    // 改已有那条不动归属；新加按弹层里的「全局 / 这里」
    const who = e.id ? e.who : (e.who || '');
    const body = { text, topic, skind: e.kind, who, conv: S.chat.conv, uid: meta.uid };
    if (e.id) { body.id = e.id; }
    const url = e.id ? '/api/conv/state/update' : '/api/conv/state/add';
    const r = await window.xuh.api('POST', url, body);
    if (!r || r.ok === false || r.error) { toast('存不上：' + ((r && (r.error || '')) || '未知原因'), true); return; }
    S.chat.stateEdit = null;
    await loadConvState(); toast(e.id ? '已更新这条状态' : '已加上这条状态'); return;
  }
  /* 浮层折叠：只切 class，不重渲染消息列表（保留滚动位置） */
  if (act === 'chat-live-fold') {
    S.chat.liveFold = !S.chat.liveFold;
    const d = view.querySelector('.chat-dock');
    if (d) { d.classList.toggle('is-fold', S.chat.liveFold); const f = d.querySelector('.dock-fold'); if (f) f.textContent = S.chat.liveFold ? '▲' : '▼'; }
    return;
  }
  if (act === 'chat-livethink') {
    const to = liveThinkOn() ? 0 : 1;
    const r = await window.xuh.api('POST', '/api/cfgset', { k: 'context.liveThink', v: to });
    if (!r || r.error) { toast('改不了：' + ((r && r.error) || '未知原因'), true); return; }
    S.chat.cfg = Object.assign({}, S.chat.cfg, { liveThink: to });
    if (!to) S.chat.live = { item: null };
    paintDock();
    pollLiveThink();
    toast(to ? '实时思考已打开：每句都会想（花 token）' : '实时思考已关闭：不再生成，不花 token');
    return;
  }
  /* 约定：分类切换（只筛界面，不改数据） */
  if (act === 'pact-kind') { S.pacts.kind = btn.dataset.kind || 'all'; render(); return; }
  /* ===== 朋友录 + 三类知识复核（2026-11-12）=====
   * 一个弹层管三类；确认锁定后服务端硬拒，前端也不再给编辑控件。 */
  const rvVal = id => { const el = $('#' + id); return el ? String(el.value || '') : ''; };
  const rvSplit = s => String(s || '').split(/[，,、\n]/).map(x => x.trim()).filter(Boolean);
  const reloadAll = async () => {
    S.review.loaded = false; S.friends.loaded = false; S.teach.loaded = false;
    await Promise.all([loadReview(), loadFriends(), loadTeach()].map(p => p.catch(() => {})));
    render();
  };
  const friendQQ = pid => {
    const p = (S.friends.list || []).find(x => String(x.pid) === String(pid));
    return p ? String(p.qq || '') : '';
  };
  if (act === 'friend-zone') { S.friends.zone = btn.dataset.zone || 'all'; render(); return; }
  /* AI 标记 / 移除（2026-11-21 主人定）：只动单独那份 ai-marks.json；标记顺手把好感清 0 并锁住。 */
  if (act === 'ai-mark') {
    const pid = btn.dataset.pid;
    const r = await window.xuh.api('POST', '/api/ai/mark', { pid });
    if (!r || r.error) { toast('没标上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends();
    toast('已标为 AI，好感清零并锁 0');
    return;
  }
  if (act === 'ai-unmark') {
    const pid = btn.dataset.pid;
    const r = await window.xuh.api('POST', '/api/ai/unmark', { pid });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends();
    toast('已改回人物（以后不再自动判成 AI）');
    return;
  }
  /* 群聊人物列表点某个人 → 回朋友录展开同一个 pid（改名字 / 加号 / 合并账号是同一套入口）。 */
  if (act === 'friend-group-open') {
    S.friends.zone = 'friend';
    S.openPerson = btn.dataset.pid || null;
    S.friends.q = '';
    render(); return;
  }
  /* 话题「按群分类」总开关（2026-11-13 主人令）+ 我的口味三条（加 / 改 / 换行 / 删） */
  if (act === 'friend-groupby') { S.friends.groupBy = btn.dataset.v === '1'; render(); return; }
  if (act === 'mine-add') { S.friends.mineEdit = { isNew: true, sec: btn.dataset.sec || 'like', oldText: '', text: '' }; render(); return; }
  if (act === 'mine-open') { S.friends.mineEdit = { isNew: false, sec: btn.dataset.sec || 'like', oldText: btn.dataset.t || '', text: btn.dataset.t || '' }; render(); return; }
  if (act === 'mine-close') { S.friends.mineEdit = null; render(); return; }
  if (act === 'mine-save') {
    const e = S.friends.mineEdit;
    if (!e) return;
    const txt = ($('#mt-text') || {}).value || '';
    const body = e.isNew
      ? { mode: 'add', sec: e.sec, text: txt }
      : { mode: 'edit', sec: e.sec, oldText: e.oldText, text: txt, targetSec: ($('#mt-sec') || {}).value || e.sec };
    const r = await window.xuh.api('POST', '/api/taste/mine', body);
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.mineEdit = null; await loadMine(); toast('存好了'); return;
  }
  if (act === 'mine-del') {
    const e = S.friends.mineEdit;
    if (!e) return;
    const r = await window.xuh.api('POST', '/api/taste/mine', { mode: 'del', sec: e.sec, text: e.oldText });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.mineEdit = null; await loadMine(); toast('删掉了'); return;
  }
  /* 喜好表：锁 / 参数（2026-11-13 主人令「参数我可以直接在这页调」「上锁，禁止你修改、查看」） */
  if (act === 'mine-lock') {
    const on = btn.dataset.on === '1';
    const r = await window.xuh.api('POST', '/api/taste/cfg', { locked: on });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    await loadMine(); toast(on ? '已上锁：自动抽取和脚本都改不动，只有你能改' : '已解锁'); return;
  }
  if (act === 'mine-cfg-save') {
    const numOf = k => { const el = view.querySelector('[data-cfg="' + k + '"]'); return el ? Number(el.value) || 0 : 0; };
    const boxOn = k => { const el = view.querySelector('[data-cfg="' + k + '"]'); return !!(el && el.checked); };
    const r = await window.xuh.api('POST', '/api/taste/cfg', {
      show: { confLimit: numOf('confLimit') || 12, askLimit: numOf('askLimit') || 60, showGuess: boxOn('showGuess'), showNeutral: boxOn('showNeutral') },
    });
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    await loadMine(); toast('参数存好了'); return;
  }
  if (act === 'rel-load') { await loadRelation(btn.dataset.who || ''); return; }
  if (act === 'rel-toggle-neutral') { S.friends.relShowNeutral = !S.friends.relShowNeutral; render(); return; }
  if (act === 'rel-set') {
    const r = await window.xuh.api('POST', '/api/relation/set', { a: btn.dataset.a, b: btn.dataset.b, s: btn.dataset.s || 'neutral' });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    await loadRelation(btn.dataset.a); toast('改好了'); return;
  }
  /* 聊天记录里点名字 / 会话头像（主人 2026-11-13）：就地弹这个人的卡，不跳页。
   * 跳走会丢当前会话位置，她要的是「直接查、改」。 */
  if (act === 'chat-person') {
    const uid = String(btn.dataset.uid || '');
    if (!S.friends.loaded) await loadFriends();
    if (!S.review.loaded) await loadReview();
    const p = (S.friends.list || []).find(x => (x.accounts || []).some(a => String(a.id) === uid));
    if (!p) { toast('这个号还没在朋友录里建档', true); return; }
    S.chat.person = p.pid; render(); return;
  }
  if (act === 'person-close') { S.chat.person = null; render(); return; }
  /* 删掉这个人（2026-11-13）：先把清单摆出来，确认后才发请求。删完四份缓存一起失效再重拉。 */
  if (act === 'person-purge-open') { S.friends.purge = { pid: String(btn.dataset.pid || '') }; render(); return; }
  if (act === 'person-purge-close') { S.friends.purge = null; render(); return; }
  /* 删人物前逐项核对（2026-11-13 主人令：绑定的数据都能点开改）：
   * 关弹层 → 在朋友录里展开这个人（约定 / 话题 / 喜好 / 事实 / 代称都在那张详情里）。 */
  if (act === 'purge-goto') {
    const pid = String(btn.dataset.pid || '');
    S.friends.purge = null;
    if (S.tab !== 'friends') { go('friends'); }
    S.friends.zone = 'all';
    S.openPerson = pid;
    render();
    toast('已展开这个人：约定 / 话题 / 喜好 / 事实都在里面，改完再回来删');
    return;
  }
  if (act === 'person-purge-do') {
    const pid = String(btn.dataset.pid || '');
    const r = await window.xuh.api('POST', '/api/person/purge', { pid, confirm: 'DELETE' });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.purge = null; S.friends.loaded = false; S.review.loaded = false;
    S.teach.loaded = false; S.openPerson = null; S.chat.person = null;
    await loadFriends();
    await loadReview();
    try { await loadTeach(); } catch { /* 教学页没开也不影响删除结果 */ }
    const rm = r.removed || {};
    toast('已删：人物 ' + num(rm.person || 0) + ' · 约定/话题 ' + num(rm.topics || 0)
      + ' · 喜好 ' + num(rm.taste || 0) + ' · 事实 ' + num(rm.facts || 0)
      + (rm.skippedMulti ? '（' + num(rm.skippedMulti) + ' 行同时提到别人，没动）' : ''));
    return;
  }
  if (act === 'chat-person-goto') {
    const pid = String(btn.dataset.pid || '');
    S.chat.person = null;
    if (!S.friends.loaded) await loadFriends();
    if (S.tab !== 'friends') go('friends');
    S.openPerson = pid; render(); return;
  }
  if (act === 'friend-row' || act === 'friend-open') {
    let pid = btn.dataset.pid || '';
    if (!pid && btn.dataset.uid) {
      const uid = String(btn.dataset.uid);
      if (!S.friends.loaded) await loadFriends();
      const p = (S.friends.list || []).find(x => (x.accounts || []).some(a => String(a.id) === uid));
      pid = p ? p.pid : '';
      if (!pid) { toast('这个号还没在朋友录里建档', true); return; }
      // 在聊天页点会话头像 → 就地开卡；在朋友录页才展开那一行
      if (S.tab === 'chat') {
        if (!S.review.loaded) await loadReview();
        S.chat.person = pid; render(); return;
      }
      if (S.tab !== 'friends') go('friends');
      S.openPerson = pid; render(); return;
    }
    S.openPerson = S.openPerson === pid ? null : pid;
    render(); return;
  }
  if (act === 'alias-confirm' || act === 'alias-unlock') {
    const r = await window.xuh.api('POST', '/api/alias/' + (act === 'alias-confirm' ? 'confirm' : 'unlock'), { pid: btn.dataset.pid });
    if (!r || r.error) { toast('没改上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends();
    toast(act === 'alias-confirm' ? '代称已确认锁定' : '代称已解锁'); return;
  }
  if (act === 'taste-add' || act === 'taste-edit') {
    S.friends.tasteEdit = { isNew: act === 'taste-add', pid: btn.dataset.pid, sec: btn.dataset.sec,
      oldText: btn.dataset.old || '', text: btn.dataset.old || '' };
    render(); return;
  }
  if (act === 'taste-close') { S.friends.tasteEdit = null; render(); return; }
  if (act === 'taste-save') {
    const e = S.friends.tasteEdit;
    if (!e) return;
    const r = await window.xuh.api('POST', '/api/taste/set', {
      mode: e.isNew ? 'add' : 'edit', qq: e.pid, sec: e.sec,
      oldText: e.oldText, text: rvVal('tt-text'), targetSec: e.sec,
    });
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.tasteEdit = null; S.friends.loaded = false; await loadFriends();
    toast('喜恶存好了'); return;
  }
  if (act === 'taste-del') {
    const r = await window.xuh.api('POST', '/api/taste/del', {
      qq: friendQQ(btn.dataset.pid), sec: btn.dataset.sec, t: btn.dataset.old,
    });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends(); toast('删掉了'); return;
  }
  if (act === 'review-open') {
    if (!S.review.loaded) await loadReview();
    S.review.open = reviewOf(btn.dataset.id);
    if (!S.review.open) { toast('这条还没进复核列表，先刷新一下', true); return; }
    S.chat.person = null;   // 一层只开一个：点卡片就收起人物弹层，免得叠在一起
    render(); return;
  }
  // 两条轴单条切换（2026-11-13）：检索式命中 / 在场就用，互不覆盖
  if (act === 'teach-axis') {
    const on = btn.dataset.on === '1';
    const body = { id: btn.dataset.id };
    body[btn.dataset.f] = !on;
    const r = await window.xuh.api('POST', '/api/review/edit', body);
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    S.review.loaded = false; S.teach.loaded = false;
    await Promise.all([loadReview(), loadTeach()]);
    S.review.open = reviewOf(btn.dataset.id);
    render(); toast(!on ? '已打开' : '已关掉'); return;
  }
  if (act === 'review-close') { S.review.open = null; render(); return; }
  // 整栏切轴（2026-11-13）：一条命令改整个方向，持久在 data/teach/axis.json
  if (act === 'teach-axis-dir') {
    const on = btn.dataset.on === '1';
    const r = await window.xuh.api('POST', '/api/teach/axis', { dir: btn.dataset.dir, field: 'retrieval', value: !on });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    S.teach.loaded = false; S.review.loaded = false;
    await Promise.all([loadTeach(), loadReview()]);
    toast('「' + btn.dataset.dir + '」整栏' + (!on ? '已加入' : '已退出') + '检索式命中'); return;
  }
  if (act === 'review-evidence') {
    const r = await window.xuh.api('POST', '/api/review/evidence', { id: btn.dataset.id });
    if (!r || r.error) { toast('原记录没取到：' + ((r && r.error) || '未知原因'), true); return; }
    S.review.loaded = false; await loadReview();
    S.review.open = reviewOf(btn.dataset.id);
    render(); toast('取到 ' + ((r.evidence || []).length) + ' 条同会话原记录'); return;
  }
  if (act === 'review-confirm') {
    const r = await window.xuh.api('POST', '/api/review/confirm', { id: btn.dataset.id });
    if (!r || r.error) { toast('没锁上：' + ((r && r.error) || '未知原因'), true); return; }
    S.review.open = null; await reloadAll(); toast('已确认锁定：5 条证据快照删掉，AI 和助手都不许删改'); return;
  }
  if (act === 'review-del') {
    const id = String(btn.dataset.id || '');
    // 单条删除点两下（2026-11-13 主人令「约定等等内容都需要可单条删除」；卡片上直接删，别逼她进弹层）
    if (S.review.delAsk !== id) { S.review.delAsk = id; render(); toast('再点一下「真的删？」才删'); return; }
    S.review.delAsk = null;
    const r = await window.xuh.api('POST', '/api/review/del', { id });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    S.review.open = null; await reloadAll(); toast('删掉了'); return;
  }
  if (act === 'topic-level') {
    // 多选：点一下加/减一级（2026-11-13 主人令「单人/群/通用话题重合」）
    const cur = reviewOf(btn.dataset.id);
    const has = topicLevelsOf(cur || {});
    const lv = String(btn.dataset.lv || '');
    const next = has.indexOf(lv) >= 0 ? has.filter(x => x !== lv) : has.concat([lv]);
    if (!next.length) { toast('至少留一级', true); return; }
    const r = await window.xuh.api('POST', '/api/topic/level', { id: btn.dataset.id, levels: next });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    await reloadAll(); return;
  }
  if (act === 'topic-ttl') {
    const r = await window.xuh.api('POST', '/api/topic/ttl', { id: btn.dataset.id, ttl: btn.dataset.v });
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    await reloadAll(); toast(btn.dataset.v === 'long' ? '已转长期：不再过期' : '已转短期：按条数过期'); return;
  }
  if (act === 'topic-part-del') {
    const cur = reviewOf(btn.dataset.id);
    const list = ((cur && cur.participants) || []).filter(pp => String(pp.key) !== String(btn.dataset.key));
    const r = await window.xuh.api('POST', '/api/topic/participants', { id: btn.dataset.id, participants: list });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    await reloadAll(); toast('已取消这个人的参与'); return;
  }
  if (act === 'review-save') {
    const x = S.review.open;
    if (!x) return;
    const want = rvVal('rv-type') || x.rkind;
    const sub = rvVal('rv-sub') || '';
    const common = {
      qq: rvVal('rv-qq'), nick: '', scope: rvVal('rv-scope'),
      say: rvVal('rv-say'), text: rvVal('rv-text'), when: rvSplit(rvVal('rv-when')),
    };
    /* 一级类变了 = 真搬家（教学知识 ↔ 约定 ↔ 话题，先造后删、不留双份）；
     * 同一类只换二级（方向 / 分区）= 原地改。两者都不许碰锁定条（后端硬拒）。 */
    if (want !== x.rkind && x.rkind !== 'alias') {
      const r = await window.xuh.api('POST', '/api/review/reclass', {
        id: x.id, target: Object.assign({ type: want, dir: sub, section: sub }, common),
      });
      if (!r || r.error) { toast('没搬成：' + ((r && r.error) || '未知原因'), true); return; }
      S.review.open = null; await reloadAll();
      toast('已搬到 ' + ({ teach: '教学知识', promise: '约定', topic: '话题' }[want] || want) + (sub ? ' · ' + sub : ''));
      return;
    }
    const body = Object.assign({ id: x.id }, common);
    if (x.rkind === 'teach') body.dir = sub;
    else if (x.rkind !== 'alias') body.section = sub;
    const r = await window.xuh.api('POST', '/api/review/edit', body);
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    S.review.open = null;            // 列表重载后旧引用会显示旧内容，存完就收起弹层
    await reloadAll(); toast('存好了'); return;
  }

  /* 记录的：切方向 / 打开 / 保存 / 删除 / 关弹层（2026-11-12） */
  if (act === 'teach-dir') { S.teach.dir = btn.dataset.dir || 'all'; render(); return; }
  /* 约定分区筛选（2026-11-13：「约定」并进「记录的」页，六个同级分区） */
  if (act === 'teach-section') { S.teach.section = btn.dataset.sec || 'all'; render(); return; }
  if (act === 'teach-close') { S.teach.edit = null; render(); return; }
  if (act === 'teach-new') {
    S.teach.edit = { isNew: true, dir: '梗词句', when: [], say: '', text: '', qq: '' };
    render(); return;
  }
  if (act === 'teach-open') {
    S.teach.edit = (S.teach.list || []).find(x => String(x.id) === String(btn.dataset.id)) || null;
    render(); return;
  }
  if (act === 'teach-save' || act === 'teach-del') {
    const val = id => { const el = $('#' + id); return el ? String(el.value || '') : ''; };
    const isNew = btn.dataset.new === '1';
    if (act === 'teach-del') {
      const r = await window.xuh.api('POST', '/api/teach/del', { id: S.teach.edit && S.teach.edit.id });
      if (!r || r.error || !r.ok) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    } else {
      const body = {
        text: val('te-text'), qq: val('te-qq'), say: val('te-say'), note: val('te-note'),
        dir: val('te-dir'), when: val('te-when').split(/[，,、\n]/).map(s => s.trim()).filter(Boolean),
      };
      let r;
      if (isNew) {
        if (!body.qq.trim()) { toast('填一下教学者的号（id 署名）', true); return; }
        r = await window.xuh.api('POST', '/api/teach/add', body);
        if (r && r.ok && !r.item) r.error = '原话拆不出触发词和回话';
      } else {
        r = await window.xuh.api('POST', '/api/teach/edit', Object.assign({ id: S.teach.edit && S.teach.edit.id }, body));
      }
      if (!r || r.error || !r.ok) { toast('没存上：' + ((r && r.error) || '原话拆不出触发词和回话'), true); return; }
    }
    S.teach.edit = null;
    await loadTeach();
    toast(act === 'teach-del' ? '删掉了' : '存好了');
    return;
  }
  /* 聊天记录：左侧会话栏切换（群 / 私聊 / 单个群），只筛界面、不动数据。
   * 切会话不改位置（主人 2026-11-11 定）：切回某个会话就回到它上次停的地方；没看过的会话才贴底。 */
  /* 左栏点 B站私信会话（2026-11-19）：右侧换成这个人的私信原文，QQ 会话照样在上面那一列 */
  if (act === 'chat-bdm') {
    const uid = String(btn.dataset.uid || '');
    if (!uid) return;
    S.chat.conv = 'bdm_' + uid;
    S.chat.convState = null;
    loadBiliDmMsgs(uid);
    render(); return;
  }
  /* ↻ 重新拉 B站私信（会话列表 + 当前这个人的消息），平时走缓存不重拉，避免 412 */
  if (act === 'chat-bdm-reload') {
    S.chat.bdm = S.chat.bdm || { list: [], err: '', loading: false, msgs: {}, busy: {} };
    S.chat.bdm.list = [];
    S.chat.bdm.err = '';
    if (/^bdm_/.test(String(S.chat.conv))) loadBiliDmMsgs(String(S.chat.conv).slice(4), true);
    loadBiliDm(true);
    toast('重新拉 B站私信…');
    return;
  }
  /* 切分段（2026-11-19 主人令：分成「全部消息 / QQ群 / 私信 / B站」四页，不再往人物列表里塞）。
   * 每段记着自己上次选的是谁，来回切不丢位置。 */
  if (act === 'chat-seg') {
    const t = btn.dataset.tab || 'all';
    const cur = ['all', 'group', 'private', 'bili'].indexOf(String(S.chat.tab)) >= 0 ? String(S.chat.tab) : 'all';
    if (t === cur) return;
    if (!S.chat.segConv) S.chat.segConv = {};
    S.chat.segConv[cur] = S.chat.conv;
    S.chat.tab = t;
    const def = t === 'group' ? '__group' : (t === 'private' ? '__private' : (t === 'all' ? '__all' : S.chat.conv));
    const back = S.chat.segConv[t];
    S.chat.conv = back || def;
    S.chat.pinBottom = true;
    S.chat.convState = null;
    if (t === 'bili' && !S.bili.loaded) loadBili();
    render(); return;
  }
  if (act === 'chat-conv') {
    // 切走之前先把当前会话停在哪儿记下来（滚动事件是下一帧才派发的，点得快就来不及记）
    const old = view.querySelector('.msgs');
    if (old) chatPosSave(S.chat.conv, old);
    S.chat.conv = btn.dataset.conv || '__all';
    S.chat.convState = null;   // 切会话先清空，loadConvState 会按新会话重拉
    render(); return;
  }
  if (act === 'logs-refresh') { S.logs.loaded = false; render(); loadLogs(); return; }
  if (act === 'diary-flow') { diaryFlowAct(btn.dataset.what || ''); return; }
  /* 机器人组切换标签（她 11-18 令）+ 第三方署名问号 */
  if (act === 'bot-group-tab') { activateBotGroupTab(btn.dataset.id || ''); return; }
  if (act === 'credit') { openCredit(btn.dataset.key || ''); return; }
  if (act === 'credit-close') { closeCredit(); return; }
  if (act === 'diary-rules-save') { saveDiaryRules(); return; }
  if (act === 'chat-bans-save') { saveChatBans(); return; }
  if (act === 'mp-toggle') {
    const on = btn.dataset.on === '1';
    btn.dataset.on = on ? '0' : '1';
    btn.setAttribute('aria-pressed', on ? 'false' : 'true');
    btn.classList.toggle('is-on', !on);
    btn.textContent = on ? '已关闭' : '已开启';
    return;
  }
  if (act === 'move-poop-save') { saveMovePoop(); return; }
  if (act === 'logs-clear') { logsClear(); return; }
  if (act === 'status-go') { go(btn.dataset.view); return; }
  if (act === 'param-open') { paramOpen(); return; }

  /* 会话栏的齿轮 / 删除全组（主人 2026-11-07）：
   * 「虚幻的可读上下文可以按各自群聊/私聊分别单独改容量」「开关都在各自界面分别调，
   * 黑名单群我也可以在这直接打标记」「我可以删除全组内容」。 */
  if (act === 'chat-conv-set') {
    const key = btn.dataset.conv || '';
    const one = (S.chat.list || []).filter(m => chatConvOf(m) === key);
    const first = one[0] || {};
    const scopeKey = first.scopeKey || '';
    const st = (scopeKey && S.chat.convSettings[scopeKey]) || {};
    S.chat.convSet = {
      key, label: first.convLabel || key, kind: first.convKind || '', uid: first.uid || '',
      n: one.length, scopeKey,
    };
    S.chat.convSetCtx = st.ctx ? String(st.ctx) : '';
    S.chat.convSetReply = st.reply !== false;
    S.chat.convSetBlack = !!st.black;
    S.chat.convSetModel = st.model === 'local';
    S.chat.convDel = false;
    // 一屏只开一个弹层：别的先收起来
    S.chat.starItem = null; S.chat.issueItem = null; S.chat.showIssues = false;
    S.chat.traceOpen = false; S.chat.showLog = false; S.chat.groupEdit = null;
    S.chat.emoEdit = null; S.chat.emoScan = null;
    S.chat.replyToggle = false;
    render(); return;
  }
  if (act === 'conv-set-close') { S.chat.convSet = null; S.chat.convDel = false; render(); return; }
  /* 「用默认」：一键清掉这个会话单独设的字数，立刻回默认（2026-11-14 主人令）。
   * 只发 chars:0，别的项（条数 / 回话 / 黑名单 / 模型）一个字不动。 */
  if (act === 'conv-set-default') {
    const v = S.chat.convSet;
    if (!v) return;
    const r = await window.xuh.api('POST', '/api/conv/set', { conv: v.key, uid: v.uid, kind: v.kind, chars: 0 });
    if (!r || r.error) { toast('没改回默认：' + ((r && r.error) || '未知原因'), true); return; }
    if (r.key) S.chat.convSettings[r.key] = r.one || {};
    const d = (S.chat.convDefault && S.chat.convDefault.chars) || 600;
    toast('这个会话已回到默认：最多 ' + num(d) + ' 字');
    render(); return;
  }
  if (act === 'conv-set-ok') {
    const v = S.chat.convSet;
    if (!v) return;
    const el = $('#conv-ctx');
    const raw = el ? String(el.value || '').trim() : '';
    const elc = $('#conv-chars');
    const rawc = elc ? String(elc.value || '').trim() : '';
    const rep = $('#conv-reply'), blk = $('#conv-black'), mdl = $('#conv-model');
    const r = await window.xuh.api('POST', '/api/conv/set', {
      conv: v.key, uid: v.uid, kind: v.kind,
      ctx: raw === '' ? 0 : Number(raw),          // 空 = 回到全局默认
      chars: rawc === '' ? 0 : Number(rawc),      // 空 = 回到默认字数
      reply: rep ? !!rep.checked : true,
      black: blk ? !!blk.checked : false,
      model: mdl && mdl.checked ? 'local' : 'all', // 'local' = 本地模型优先；'all' = 回到默认（全部模型）
    });
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    if (r.key) S.chat.convSettings[r.key] = r.one || {};
    S.chat.convSet = null; S.chat.convDel = false;
    await loadChat();
    const o = (r.one || {});
    toast('已保存：' + (o.ctx ? '读 ' + o.ctx + ' 条' : '用默认条数')
      + '｜' + (o.chars ? '最多 ' + o.chars + ' 字' : '默认字数')
      + '｜' + (o.black ? '黑名单' : (o.reply === false ? '只看不回' : '正常回话'))
      + (o.model === 'local' ? '｜本地模型优先' : '｜全部模型'));
    return;
  }
  if (act === 'conv-del-ask') { S.chat.convDel = true; render(); return; }
  if (act === 'conv-del-ok') {
    const v = S.chat.convSet;
    if (!v) return;
    const r = await window.xuh.api('POST', '/api/chat/clear', { conv: v.key });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    S.chat.convSet = null; S.chat.convDel = false; S.chat.conv = '__all';
    await loadChat();
    toast('已删掉这个会话的 ' + num(r.removed || 0) + ' 条记录');
    return;
  }
  /* 回复引用条：点一下跳到被回复的那条原文（主人 2026-11-07） */
  if (act === 'chat-jump') {
    const frag = String(btn.dataset.frag || '');
    if (!frag) return;
    const m = (S.chat.list || []).find(x => String(x.text || '').indexOf(frag) >= 0);
    if (!m) { toast('被回复的那条已经不在现在的记录里了'); return; }
    const el = document.getElementById('msg-' + chatKey(m));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  /* 查梗：查一下 / 打开站点（去网站或内联结果原文） */
  if (act === 'meme-go') { memeGo(); return; }
  if (act === 'meme-site') {
    const u = btn.dataset.url;
    if (u) { window.xuh.openUrl(u); toast('已在新窗口打开网站'); }
    return;
  }

  /* 查梗 · 站点目录增删：全在客户端里改，保存走 xuh:memeSitesSave（自动同步 search 副本） */
  if (act === 'meme-add') {
    S.meme.edit = { idx: -1, site: { reliability: 'alive' } };
    render(); return;
  }
  if (act === 'meme-edit') {
    const i = Number(btn.dataset.idx);
    if (!S.meme.sites[i]) return;
    S.meme.edit = { idx: i, site: Object.assign({}, S.meme.sites[i]) };
    render(); return;
  }
  if (act === 'meme-cancel') { S.meme.edit = null; render(); return; }
  if (act === 'meme-save') {
    const ed = S.meme.edit;
    if (!ed) return;
    const name = (($('#me-name') || {}).value || '').trim();
    const url = (($('#me-url') || {}).value || '').trim();
    if (!name || !url) { toast('站名和网址得填', true); return; }
    if (!/^https?:\/\//i.test(url)) { toast('网址要以 https:// 开头', true); return; }
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* 手填不规范就留空 */ }
    const site = Object.assign({}, ed.site, {
      name, domain: domain || ed.site.domain || '', url,
      search: (($('#me-search') || {}).value || '').trim(),
      api: (($('#me-api') || {}).value || '').trim(),
      reliability: (($('#me-rel') || {}).value || 'alive'),
      note: (($('#me-note') || {}).value || '').trim(),
    });
    const sites = (S.meme.sites || []).slice();
    if (ed.idx >= 0) sites[ed.idx] = site; else sites.push(site);
    const r = await window.xuh.memeSitesSave(sites);
    if (!r || r.error) { toast('存不了：' + ((r && r.error) || '未知'), true); return; }
    S.meme.edit = null;
    S.meme.loaded = false;
    await loadMeme();
    toast(r.synced ? '已保存，也同步到 search 面板了' : '已保存（search 面板不在这台机上，打包时各带一份）');
    return;
  }
  if (act === 'meme-del') {
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1'; btn.textContent = '确认删';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
      return;
    }
    const i = Number(btn.dataset.idx);
    if (!S.meme.sites[i]) return;
    const gone = S.meme.sites[i].name || '这个站';
    const sites = (S.meme.sites || []).slice();
    sites.splice(i, 1);
    const r = await window.xuh.memeSitesSave(sites);
    if (!r || r.error) { toast('删不掉：' + ((r && r.error) || '未知'), true); return; }
    S.meme.edit = null;
    S.meme.loaded = false;
    await loadMeme();
    toast('已删「' + gone + '」，也同步到 search 面板了');
    return;
  }
  /* 聊天记录：只看星标 */
  if (act === 'chat-onlystar') { S.chat.onlyStar = !S.chat.onlyStar; render(); return; }
  /* 聊天记录 ↔ 情绪（主人 2026-11-07 定） */
  if (act === 'chat-emo-has') { S.chat.emo = S.chat.emo === 'has' ? '' : 'has'; render(); return; }
  if (act === 'chat-emo-leak') {
    S.chat.emo = S.chat.emo === 'leak' ? '' : 'leak';
    if (S.chat.emo === 'leak' && !Object.keys(S.chat.leakKeys || {}).length) {
      const r = await window.xuh.api('POST', '/api/chat/emotion/scan', { apply: false });
      if (r && Array.isArray(r.list)) { const k = {}; r.list.forEach(x => k[x.key] = 1); S.chat.leakKeys = k; }
    }
    render(); return;
  }
  if (act === 'chat-emo-scan') {
    S.chat.emoScanLoading = true; render();
    const r = await window.xuh.api('POST', '/api/chat/emotion/scan', { apply: false });
    S.chat.emoScanLoading = false;
    if (!r || r.error) { toast('扫漏判失败：' + ((r && r.error) || '未知原因'), true); render(); return; }
    S.chat.emoScan = r.list || [];
    render(); return;
  }
  if (act === 'chat-emo-scan-apply') {
    const r = await window.xuh.api('POST', '/api/chat/emotion/scan', { apply: true });
    if (!r || r.error) { toast('应用失败：' + ((r && r.error) || '未知原因'), true); return; }
    S.chat.emoScan = null; S.chat.leakKeys = {}; S.chat.emo = '';
    await loadChat(); toast('已加 ' + num(r.count || 0) + ' 条情绪进去'); return;
  }
  if (act === 'chat-emo') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    S.chat.emoEdit = m; S.chat.emoWord = (m.emo && m.emo.word) || '';
    S.chat.starItem = null; S.chat.issueItem = null; S.chat.showIssues = false;
    S.chat.traceOpen = false; S.chat.showLog = false; S.chat.groupEdit = null;
    render(); return;
  }
  if (act === 'chat-emo-set') {
    const m = S.chat.emoEdit; if (!m) return;
    const lf = $('#emo-leaf'), wd = $('#emo-word');
    const leaf = lf ? String(lf.value || '').trim() : '';
    const word = wd ? String(wd.value || '').trim() : (m.emo ? (m.emo.word || '') : '');
    const r = await window.xuh.api('POST', '/api/chat/emotion', { key: chatKey(m), nick: m.nick, text: m.text, leaf, word });
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    m.emo = leaf ? { leaf, word, source: r.source || 'user' } : null;
    S.chat.emoEdit = null;
    render();
    toast('已改：' + leaf + (r.source === 'review' ? '（记成判错，表情包页会亮）' : '')); return;
  }
  if (act === 'chat-emo-clear') {
    const m = S.chat.emoEdit; if (!m) return;
    const r = await window.xuh.api('POST', '/api/chat/emotion', { key: chatKey(m), nick: m.nick, text: m.text, leaf: '' });
    if (!r || r.error) { toast('没清掉：' + ((r && r.error) || '未知原因'), true); return; }
    m.emo = null; S.chat.emoEdit = null; render(); toast('已清空这条的情绪'); return;
  }
  if (act === 'chat-emo-close') { S.chat.emoEdit = null; S.chat.emoScan = null; render(); return; }
  /* 聊天记录 ↔ 约定（主人 2026-11-08 定）：打开会话看这个会话的约定，并能看到是哪条消息生成的约定 */
  if (act === 'chat-pact') { S.chat.pact = !S.chat.pact; render(); return; }
  if (act === 'chat-pact-collapse') { S.chat.pactOpen = !S.chat.pactOpen; paintDock(); return; }
  if (act === 'chat-topic-collapse') { S.chat.topicOpen = !S.chat.topicOpen; paintDock(); return; }
  if (act === 'chat-topic-filter') { S.chat.topicFilter = btn.dataset.v || 'all'; S.chat.topicOpen = true; render(); return; }
  if (act === 'chat-pact-src') {
    const id = btn.dataset.id || '';
    if (!id) { toast('这条约定没 id', true); return; }
    S.chat.pactDetail = id; render(); return;
  }
  if (act === 'chat-pact-close') { S.chat.pactDetail = null; render(); return; }
  /* 聊天记录：加星标先开弹层（写理由 + 多选上下文），和标错共用一套自绘弹层。
   * 后端 /api/chat/star 会同时联动话题日志里的「已总结」；本地只改这一条，不整页重拉。 */
  if (act === 'chat-star-open') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    S.chat.starItem = m; S.chat.starNote = ''; S.chat.starPicked = new Set();
    S.chat.issueItem = null; S.chat.showIssues = false; S.chat.traceOpen = false; S.chat.showLog = false;
    render(); return;
  }
  /* 多选上下文：加星和标错各存一份，互不干扰；重画弹层时把已输入的理由带上，别清空 */
  if (act === 'star-toggle' || act === 'issue-toggle') {
    const isStar = act === 'star-toggle';
    const set = isStar ? S.chat.starPicked : S.chat.issuePicked;
    const k = btn.dataset.key || '';
    if (set.has(k)) set.delete(k);
    else if (set.size < 8) set.add(k);
    else { toast('最多选 8 句', true); return; }
    const el = $(isStar ? '#star-note' : '#issue-note');
    if (el) { if (isStar) S.chat.starNote = el.value; else S.chat.issueNote = el.value; }
    render(); return;
  }
  if (act === 'star-ok') {
    const m = S.chat.starItem;
    if (!m) return;
    const el = $('#star-note');
    const note = el ? String(el.value || '').trim() : String(S.chat.starNote || '');
    const near = starNearby(m);
    const ctx = near.filter(x => S.chat.starPicked.has(x.key))
      .map(x => ({ nick: x.nick, text: x.text, bot: x.bot }));
    // 勾了的方面（2026-11-21）：这句在哪些方面到位，各记一条正面样本进「信息识别」对应页。
    const infos = Array.from(document.querySelectorAll('.star-info')).filter(x => x.checked).map(x => x.value);
    const r = await window.xuh.api('POST', '/api/chat/star', { on: true, item: m, note, ctx, infos });
    if (!r || r.error) { toast('星标没存上：' + ((r && r.error) || '未知原因'), true); return; }
    m.starred = true;
    S.chat.starItem = null; S.chat.starPicked = new Set(); S.chat.starNote = '';
    for (const k of infos) delete S.info.pages[k];   // 那几页的星标样本数变了
    S.logic.casesLoaded = false;                     // 逻辑页的案例也要跟着变
    render();
    loadPacts().catch(() => {});
    toast((ctx.length ? '已加星标：连 ' + ctx.length + ' 句上下文一起存了' : '已加星标：这句算已总结')
      + (infos.length ? '，还记进 ' + infos.length + ' 个方面' : ''));
    return;
  }
  /* 聊天记录：复制这一句的原文（她 2026-11-09 要能复制客户端里的文字）。
   * 取 m.text 而不是屏幕上那段：长内容默认折到 180 字，复制要拿全文。 */
  if (act === 'chat-copy') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    const text = String(m.text || '');
    const r = await window.xuh.copyText(text);
    if (!r || r.error) { toast('复制不了：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已复制（' + text.length + ' 字）');
    return;
  }
  // B站私信（按人合并进来的只读消息）复制：文本就在 data-text 上，不进 S.chat.list，走不到上面的 chat-copy
  if (act === 'chat-copy-text') {
    const text = String(btn.dataset.text || '');
    const r = await window.xuh.copyText(text);
    if (!r || r.error) { toast('复制不了：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已复制（' + text.length + ' 字）');
    return;
  }
  /* 已加星的点 ★ 直接取消（老行为不变） */
  if (act === 'chat-star') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    const on = !m.starred;
    const r = await window.xuh.api('POST', '/api/chat/star', { on, item: m });
    if (!r || r.error) { toast('星标没存上：' + ((r && r.error) || '未知原因'), true); return; }
    m.starred = on;
    render();
    loadPacts().catch(() => {});   // 后端联动写进话题日志的那条「已总结」，约定页数据一起刷新
    toast(on ? '已加星标：这句算已总结，话题日志也记了一条' : '已取消星标');
    return;
  }
  /* 聊天记录：只看她说的 */
  if (act === 'chat-onlybot') { S.chat.onlyBot = !S.chat.onlyBot; render(); return; }
  /* 聊天记录：长内容展开 / 收起 */
  if (act === 'chat-more') {
    const k = btn.dataset.key || '';
    if (S.chat.open.has(k)) S.chat.open.delete(k); else S.chat.open.add(k);
    render();
    return;
  }
  /* 兜底词池（2026-11-13 主人令）：聊天记录页 🛟 一个入口 → 增 / 删 / 改 / 停用，存机器人端 config */
  if (act === 'chat-fb-open') {
    // 一屏只开一个弹层：别的先收起来
    S.chat.showSet = false; S.chat.replyToggle = false; S.chat.starItem = null;
    S.chat.issueItem = null; S.chat.showIssues = false; S.chat.traceOpen = false;
    S.chat.showLog = false; S.chat.groupEdit = null; S.chat.emoEdit = null;
    S.chat.emoScan = null; S.chat.convSet = null; S.chat.pactDetail = null;
    S.chat.fbOpen = true; S.chat.fbErr = ''; S.chat.fbBusy = true;
    render();
    try {
      const r = await window.xuh.api('GET', '/api/fallbackpool');
      if (r && r.ok) {
        S.chat.fbPool = (r.pool || []).map(fbDraftOf);
        S.chat.fbDefault = r.defaultLine || '';
      } else S.chat.fbErr = (r && r.error) || '读不出来';
    } catch (e) { S.chat.fbErr = e.message || '请求失败'; }
    S.chat.fbBusy = false;
    if (S.chat.fbOpen) render();
    return;
  }
  if (act === 'fb-close') { S.chat.fbOpen = false; S.chat.fbErr = ''; render(); return; }
  if (act === 'fb-add' || act === 'fb-del') {
    fbCollect();
    if (act === 'fb-add') {
      if (S.chat.fbPool.length >= 60) { toast('最多 60 条', true); return; }
      S.chat.fbPool.push({ id: 'fb-' + Date.now() + '-' + S.chat.fbPool.length,
        text: '', type: '', target: '', on: true });
    } else {
      const i = Number(btn.dataset.i);
      if (Number.isInteger(i) && i >= 0) S.chat.fbPool.splice(i, 1);
    }
    render(); return;
  }
  if (act === 'fb-save') {
    if (S.chat.fbBusy) return;
    fbCollect();
    const pool = S.chat.fbPool.map(p => ({
      id: p.id, text: String(p.text || '').trim(),
      scope: fbScopeOf(p), enabled: !!p.on,
    })).filter(p => p.text);
    S.chat.fbBusy = true; render();
    try {
      const r = await window.xuh.api('POST', '/api/fallbackpool', { pool });
      if (!r || !r.ok) {
        S.chat.fbBusy = false; S.chat.fbErr = (r && r.error) || '没保存成'; render(); return;
      }
      S.chat.fbPool = (r.pool || []).map(fbDraftOf);
      S.chat.fbDefault = r.defaultLine || S.chat.fbDefault;
      S.chat.fbOpen = false; S.chat.fbBusy = false; S.chat.fbErr = '';
      render();
      toast('兜底词池已保存 ' + num((r.pool || []).length) + ' 条，下一句就生效');
    } catch (e) {
      S.chat.fbBusy = false; S.chat.fbErr = e.message || '请求失败'; render();
    }
    return;
  }
  /* 聊天记录：显示设置（值写机器人端 config，走现成 /api/cfgset；core.js 用 cfgLive 热读，不用重启） */
  if (act === 'chat-show-set') {
    S.chat.fbOpen = false;
    S.chat.showSet = true;
    S.chat.hrCfg = null; S.chat.hrPeople = []; S.chat.hrLoadErr = '';
    // 一屏只开一个弹层：别的先收起来
    S.chat.starItem = null; S.chat.issueItem = null; S.chat.showIssues = false;
    S.chat.traceOpen = false; S.chat.showLog = false; S.chat.groupEdit = null;
    S.chat.emoEdit = null; S.chat.emoScan = null; S.chat.convSet = null; S.chat.pactDetail = null;
    S.chat.replyToggle = false;
    render();
    // 保健那三组（时间 / 次数 / 分人开关）一起带上；读失败只影响这一节，上面四项照常能改
    try {
      const rh = await window.xuh.api('GET', '/api/healthremind');
      if (rh && !rh.error && rh.cfg) { S.chat.hrCfg = rh.cfg; S.chat.hrPeople = rh.people || []; }
      else S.chat.hrLoadErr = (rh && rh.error) || '未知原因';
    } catch (e) { S.chat.hrLoadErr = e.message || '请求失败'; }
    // 各平台字数上限一起读（2026-11-17）
    try {
      const pl = await window.xuh.api('GET', '/api/platform-limits');
      S.chat.platLimits = (pl && pl.limits) || null;
    } catch (e) { S.chat.platLimits = null; }
    // 各平台版本号一起读（2026-11-17 改版追踪）
    try {
      const pv = await window.xuh.api('GET', '/api/platform-version');
      S.chat.platVersions = (pv && pv.versions) || null;
    } catch (e) { S.chat.platVersions = null; }
    if (S.chat.showSet) render();
    return;
  }
  if (act === 'chat-reply-toggle') {
    S.chat.fbOpen = false;
    S.chat.replyToggle = true;
    // 一屏只开一个弹层：别的先收起来
    S.chat.showSet = false; S.chat.convSet = null; S.chat.traceOpen = false; S.chat.showLog = false;
    S.chat.starItem = null; S.chat.issueItem = null; S.chat.showIssues = false; S.chat.groupEdit = null;
    S.chat.emoEdit = null; S.chat.emoScan = null; S.chat.pactDetail = null;
    render(); return;
  }
  if (act === 'reply-toggle-close') { S.chat.replyToggle = false; render(); return; }
  if (act === 'reply-bulk') {
    const scope = btn.dataset.scope, turn = btn.dataset.turn;
    if (!scope || !turn) return;
    await replyBulk(scope, turn);
    return;
  }
  /* 测 B站字数上限（2026-11-17）：只在你点按钮时才发测试串，不自动跑。 */
  if (act === 'pl-probe') {
    const key = btn.dataset.key || 'biliC';
    if (S.chat.plProbe && S.chat.plProbe.busy) { toast('正在测，等这次测完'); return; }
    S.chat.plProbe = { busy: key, msg: '开始测 ' + (key === 'biliC' ? 'B站评论' : 'B站私信') + '，会发几条测试串，稍等…' };
    render();
    try {
      const r = await window.xuh.api('POST', '/api/platform-limits/probe-bili', { which: key });
      if (!r || r.error) S.chat.plProbe = { busy: '', msg: '测失败：' + ((r && r.error) || '未知原因') };
      else {
        const src = r.shrunk ? '上限缩了' : '上限涨了或持平';
        S.chat.plProbe = { busy: '', msg: '测完：实测 ' + r.cap + ' 字（发了 ' + r.sends + ' 条，' + src + '），已记下' };
        if (r.write && r.write.ok) {
          const g = await window.xuh.api('GET', '/api/platform-limits');
          if (g && g.limits) S.chat.platLimits = g.limits;
        }
      }
    } catch (e) { S.chat.plProbe = { busy: '', msg: '测失败：' + (e.message || '请求出错') }; }
    render();
    return;
  }
  if (act === 'chat-show-set-close') { S.chat.showSet = false; render(); return; }
  if (act === 'chat-show-set-ok') {
    const raw = id => { const el = $(id); return el ? String(el.value || '').trim() : ''; };
    const items = [
      ['context.imgDescChars', '图片翻译文字显示字数', raw('#set-imgchars'), 0, 20000],
      ['context.chatShowLimit', '页面显示条数', raw('#set-showlimit'), 20, 5000],
      ['context.historyLimit', '上下文条数', raw('#set-histlimit'), 6, 500],
      ['context.historyChars', '上下文总字数', raw('#set-histchars'), 1200, 100000],
    ];
    // 先全校验再逐个写，免得填错一个数时前面几项已经存进去、后面没存
    const todo = [];
    for (const it of items) {
      const [k, label, s, lo, hi] = it;
      if (s === '') continue;                 // 空 = 这项保持原样，不清空
      const n = Number(s);
      if (!Number.isFinite(n) || n < lo || n > hi) { toast(label + '要填 ' + lo + '~' + hi + ' 的数', true); return; }
      todo.push([k, label, n]);
    }
    /* 保健：时间 / 次数两组数值（2026-11-10 她定「只要时间、次数、分人打开关闭」）。
     * 与上面同样先校验、再写，且只写改动过的项，不出现「context 存了、保健没存」的半成品。 */
    const hrTodo = [];
    for (const k of HR_SET_HOURS.concat(HR_SET_COUNTS)) {
      const s = raw('#set-hr-' + k);
      if (s === '') continue;
      const rg = HR_NUM_RANGE[k] || [0, 999999];
      const n = Number(s);
      if (!Number.isFinite(n) || n < rg[0] || n > rg[1]) { toast('「' + hrLabelOf(k)[0] + '」要填 ' + rg[0] + '~' + rg[1] + ' 的数', true); return; }
      if (!S.chat.hrCfg || String(S.chat.hrCfg[k]) !== String(n)) hrTodo.push([k, n]);
    }
    // 分人打开 / 关闭：只对勾选状态真变了的人发请求，没变的不刷约定记录
    const whoTodo = [];
    for (const p of (S.chat.hrPeople || [])) {
      const el = $('#set-hr-who-' + p.key);
      if (!el) continue;
      const on = !!el.checked;
      const was = !(p.override && p.override.enabled === false);
      if (on !== was) whoTodo.push([p, on]);
    }
    for (const [k, label, n] of todo) {
      const r = await window.xuh.api('POST', '/api/cfgset', { k, v: n });
      if (!r || r.error) { toast('「' + label + '」没存上：' + ((r && r.error) || '未知原因'), true); return; }
    }
    if (hrTodo.length) {
      const patch = {};
      for (const [k, n] of hrTodo) patch[k] = n;
      const r = await window.xuh.api('POST', '/api/healthremind', { cfg: patch, note: '聊天记录页显示设置' });
      if (!r || r.error) { toast('保健提醒数值没存上：' + ((r && r.error) || '未知原因'), true); return; }
    }
    for (const [p, on] of whoTodo) {
      const r = await window.xuh.api('POST', '/api/healthremind/pact', { who: p.key, enabled: on, note: '聊天记录页显示设置' });
      if (!r || r.error) { toast('「' + p.name + '」的开关没存上：' + ((r && r.error) || '未知原因'), true); return; }
    }
    // 各平台字数上限（2026-11-17）：只写改动过的，没动的不碰（实测值不被手设覆盖）
    for (const k of ['qq', 'biliC', 'biliD']) {
      const el = $('#pl-cap-' + k);
      if (!el) continue;
      const n = Number(String(el.value || '').trim());
      const old = S.chat.platLimits && S.chat.platLimits[k] && S.chat.platLimits[k].cap;
      if (!Number.isFinite(n) || n < 20 || n > 100000) { toast('平台上限要填 20~100000 的数', true); return; }
      if (old === n) continue;
      const r = await window.xuh.api('POST', '/api/platform-limits/set', { key: k, cap: n });
      if (!r || r.error) { toast('平台 ' + k + ' 上限没存上：' + ((r && r.error) || '未知原因'), true); return; }
    }
    S.chat.showSet = false;
    S.chat.hrCfg = null; S.chat.hrPeople = [];   // 下次打开重读，跟机器人端对齐
    await loadChat();                        // 重新拉一次：值和机器人端对齐，页面按新值重画
    toast('已保存：机器人端和这个页面都生效了');
    return;
  }
  /* 聊天记录：看这一轮的决策轨迹（2026-11-07） */
  if (act === 'chat-trace') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    await openTrace(m); return;
  }
  /* 按天工作日志：看原文、切日期、自己记一条 */
  if (act === 'chat-log') { await openLog(); return; }
  if (act === 'log-day') { await openLog(btn.dataset.day || ''); return; }
  if (act === 'log-add') {
    const el = $('#log-text');
    const text = el ? String(el.value || '').trim() : '';
    if (!text) { toast('写点什么再记', true); return; }
    const r = await window.xuh.api('POST', '/api/memory/log', { kind: '手动', text });
    if (!r || r.error) { toast('没记上：' + ((r && r.error) || '未知原因'), true); return; }
    await openLog(S.chat.logDay);
    toast('已记进今天的工作日志');
    return;
  }
  /* 长期记忆正本：原子写落盘，mtime 热读，下一句就生效；保存也会自动补一条工作日志 */
  if (act === 'mem-save') {
    const el = $('#mem-raw');
    const raw = el ? String(el.value || '') : '';
    const r = await window.xuh.api('POST', '/api/memory/save', { raw });
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    await openLog(S.chat.logDay);
    toast('长期记忆已存，下一句生效');
    return;
  }
  /* 一屏只开一个弹层：统一关掉，不用系统弹窗 */
  if (act === 'chat-modal-close' || act === 'issue-close') {
    S.chat.issueItem = null; S.chat.showIssues = false;
    S.chat.issuePicked = new Set(); S.chat.issueNote = '';
    S.chat.traceOpen = false; S.chat.showLog = false;
    S.chat.starItem = null; S.chat.starPicked = new Set(); S.chat.starNote = ''; S.chat.groupEdit = null;
    S.chat.pactDetail = null;
    render(); return;
  }
  /* 聊天记录：手动标错误 / 看待修复问题 */
  if (act === 'chat-issues') {
    S.chat.showIssues = true; S.chat.issueItem = null;
    S.chat.traceOpen = false; S.chat.showLog = false; render(); return;
  }
  if (act === 'chat-issue') {
    const k = btn.dataset.key || '';
    const m = (S.chat.list || []).find(x => chatKey(x) === k);
    if (!m) { toast('没找到这条记录', true); return; }
    S.chat.issueItem = m; S.chat.showIssues = false;
    S.chat.issuePicked = new Set(); S.chat.issueNote = ''; S.chat.issueIntents = '';   // 每次打开从空白开始
    S.chat.starItem = null;
    S.chat.traceOpen = false; S.chat.showLog = false; render(); return;
  }
  if (act === 'issue-ok') {
    const m = S.chat.issueItem;
    if (!m) return;
    const noteEl = $('#issue-note');
    // 多选的上下文只当「当时的语境」一起记进待修复问题，不删它们（主人 2026-11-07）
    const ctx = nearbyOf(m).filter(x => S.chat.issuePicked.has(x.key))
      .map(x => ({ nick: x.nick, text: x.text, bot: x.bot }));
    // 顺带记「信息识别」5 项（主人 2026-11-21）：每项一个框，一行一条「说法 → 判断」，后端按项拆行入库。
    const infos = {};
    for (const [ik] of RECORD_TABS) {
      const el = $('#issue-info-' + ik);
      const v = el ? String(el.value || '').trim() : '';
      if (v) infos[ik] = v;
    }
    const r = await window.xuh.api('POST', '/api/chat/issue', {
      item: { t: m.t, nick: m.nick, text: m.text }, note: noteEl ? noteEl.value : S.chat.issueNote, ctx, infos
    });
    if (r && r.error) { toast('没记上：' + r.error, true); return; }
    S.chat.issueItem = null; S.chat.issuePicked = new Set(); S.chat.issueNote = ''; S.chat.issueIntents = '';
    for (const [ik] of RECORD_TABS) delete S.info.pages[ik];   // 哪项可能变了，下次打开重读
    S.logic.casesLoaded = false;                               // 标错会进案例，下次打开重读
    await loadChat();
    let ni = (r && r.addedIntents && r.addedIntents.length) || 0;
    const ai = (r && r.addedInfo) || {};
    for (const k of Object.keys(ai)) ni += Number(ai[k]) || 0;
    toast((ctx.length ? '已记待修复问题（含 ' + ctx.length + ' 句上下文）' : '已记待修复问题')
      + (ni ? '，顺带记了 ' + ni + ' 条信息识别规则' : '') + '，这条记录也移除了');
    return;
  }
  if (act === 'intent-add') {
    const key = btn.dataset.key || S.info.vtab;
    const pEl = $('#intent-phrase'), mEl = $('#intent-meaning'), eEl = $('#intent-emotion');
    const phrase = pEl ? pEl.value.trim() : '', meaning = mEl ? mEl.value.trim() : '';
    const emotion = eEl ? eEl.value : 'any';
    if (!phrase || !meaning) { toast('两栏都要填', true); return; }
    const r = await window.xuh.api('POST', '/api/info/' + key, { items: [{ phrase, meaning, emotion }] });
    if (!r || r.error) { toast('没加上：' + ((r && r.error) || '未知原因'), true); return; }
    await loadInfoPage(key); render(); toast('已加一条' + (emotion === 'any' ? '（不受情绪影响）' : '（' + emotion + '时）')); return;
  }
  if (act === 'intent-del') {
    const key = btn.dataset.key || S.info.vtab;
    const id = btn.dataset.id;
    const r = await window.xuh.api('POST', '/api/info/' + key + '/del', { id });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    await loadInfoPage(key); render(); toast('已删'); return;
  }
  // 删一条星标样本（2026-11-21）：只动这一页的样本，不动 chat-stars 里的星标本体。
  if (act === 'master-del') {
    const id = btn.dataset.id;
    const r = await window.xuh.api('POST', '/api/logic/master', { action: 'del', id });
    if (!r || r.error || r.ok === false) { toast('没删掉：' + ((r && (r.error || r.why)) || '未知原因'), true); return; }
    await loadLogicCases(); return;
  }
  if (act === 'info-delstar') {
    const key = btn.dataset.key || S.info.vtab;
    const id = btn.dataset.id;
    const r = await window.xuh.api('POST', '/api/info/' + key + '/delstar', { id });
    if (!r || r.error) { toast('没删掉：' + ((r && r.error) || '未知原因'), true); return; }
    await loadInfoPage(key); render(); toast('已删这条样本'); return;
  }
  // 逻辑页的「去这页」：切到对应子页并按需加载。
  if (act === 'info-goto') {
    const v = btn.dataset.key;
    if (!v) return;
    S.info.vtab = v;
    if (!S.info.pages[v] || !S.info.pages[v].loaded) { await loadInfoPage(v); }
    render(); return;
  }
  if (act === 'issue-resolve') {
    const r = await window.xuh.api('POST', '/api/feedback/del', { idx: Number(btn.dataset.idx) });
    if (r && r.error) { toast('没删掉：' + r.error, true); return; }
    await loadIssues(); render();
    toast('已标为修好');
    return;
  }

  /* 机器人：启动 / 停止 / 重启 / 刷新（起停后要几秒才连上 NapCat，所以分两次取状态） */
  if (act === 'bot-start' || act === 'bot-stop' || act === 'bot-refresh' || act === 'bot-restart') {
    btn.disabled = true;
    let r = null;
    if (act === 'bot-start') r = await window.xuh.botStart();
    else if (act === 'bot-stop') r = await window.xuh.botStop();
    else if (act === 'bot-restart') {
      toast('正在重启后端…');
      r = await window.xuh.botRestart();
    }
    if (r && r.error) toast(r.error, true);
    else if (act === 'bot-stop') toast('已停');
    else if (act === 'bot-restart') toast('已重启，正在连 QQ…');
    else if (act === 'bot-start') toast(r && r.note ? r.note : '正在启动…');
    setTimeout(loadBot, act === 'bot-refresh' ? 0 : 2500);
    setTimeout(loadBot, 6500);
    return;
  }

  if (act === 'person') {
    const pid = btn.dataset.pid;
    S.openPerson = S.openPerson === pid ? null : pid;
    render();
    return;
  }

  if (act === 'favor-lock') {
    const r = await window.xuh.personFavorLock(btn.dataset.pid, btn.dataset.on === '1');
    if (!r || r.error) { toast('没改上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends();
    toast(btn.dataset.on === '1' ? '好感已锁定：群里夸她、衰减都不动了' : '好感已解锁'); return;
  }
  /* 加入 / 移出朋友录（2026-11-22）：身份里的「朋友」就是朋友录（favor > 20），
   * 所以这里只改好感，不另存一个身份字段——面板和朋友录永远是同一份数据。 */
  if (act === 'to-friend' || act === 'out-friend') {
    const pid = btn.dataset.pid;
    const to = act === 'to-friend';
    const r = await window.xuh.personFavor(pid, to ? 21 : 20);
    if (!r || r.error) { toast('没改上：' + ((r && r.error) || '未知原因'), true); return; }
    S.friends.loaded = false; await loadFriends();
    toast(to ? '已加入朋友录（好感 21）' : '已移到人物册（好感 20）'); return;
  }
  /* 地区表（2026-11-19）：人物卡里自己加 / 改 / 清掉所在地。按人物存，跟人物表一一对应。
   * 2026-11-22：保存后**读回校验**——接口回 ok 不等于真落盘，读回来不一致必须红字说出来。 */
  if (act === 'save-region') {
    const pid = btn.dataset.pid;
    const inp = view.querySelector(`[data-region-pid="${pid}"]`);
    const city = String((inp && inp.value || '').trim());
    const oldTxt = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await window.xuh.api('POST', '/api/region/set', { pid, city });
      if (!r || r.error) { toast('地区没存上：' + ((r && r.error) || '未知原因'), true); return; }
      S.friends.loaded = false; await loadFriends();   // 三张人物卡都读 /api/friends，改完一起刷新
      const back = (S.friends.list || []).find(x => x.pid === pid) || {};
      const got = String(back.region || '');
      if (got !== city) { toast('地区没落地：读回来是「' + (got || '空') + '」', true); return; }
      toast(city ? '地区已保存' : '地区已清掉');
    } finally { btn.disabled = false; btn.textContent = oldTxt; }
    return;
  }

  if (act === 'save-person') {
    const pid = btn.dataset.pid;
    const inputs = view.querySelectorAll(`[data-pf][data-pid="${pid}"]`);
    const PF_LABEL = { name: '名字', alias: '代称', nick: '资料卡名', masterCall: '你喊他的方式', sex: '性别', role: '身份', suffix: '后缀', favor: '好感度' };
    const expect = {};            // 字段 → 期望读回的值（保存后逐项核对）
    let favVal = null;
    const oldTxt = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      for (const inp of inputs) {
        if (inp.disabled) continue;          // 锁定的代称框不解禁就别去写，写了只会报「已锁定」
        const f = inp.dataset.pf;
        if (f === 'favor') { favVal = inp.value; continue; }
        if (f === 'names') {
          // 一行「名字、代称1、代称2」→ 第一个写 name，其余写 alias（还是原来那两份数据）
          const list = String(inp.value || '').split(/[、｜|,，;；]/).map(x => x.trim()).filter(Boolean);
          let rr = await window.xuh.personField(pid, 'name', list[0] || '');
          if (rr && rr.error) { toast('名字没存上：' + rr.error, true); return; }
          expect.name = list[0] || '';
          rr = await window.xuh.personField(pid, 'alias', list.slice(1).join('、'));
          if (rr && rr.error) { toast('代称没存上：' + rr.error, true); return; }
          expect.alias = list.slice(1).join('、');
          continue;
        }
        const r = await window.xuh.personField(pid, f, inp.value);
        if (r && r.error) { toast((PF_LABEL[f] || '这一项') + '没存上：' + r.error, true); return; }
        expect[f] = String(inp.value == null ? '' : inp.value).replace(/[\r\n]+/g, ' ').trim();
      }
      if (favVal !== null) {
        const r = await window.xuh.personFavor(pid, favVal);
        if (r && r.error) { toast('好感度没存上：' + r.error, true); return; }
        expect.favor = Math.max(0, Math.min(100, Number(favVal) || 0));
      }
      await loadSnapshot();
      S.friends.loaded = false; await loadFriends();   // 朋友录读的是 /api/friends，改完好感/代称要同步
      /* 读回校验：接口说 ok 也要看文件里到底变没变（2026-11-22 的静默失败就是这么漏的）。 */
      const back = (S.friends.list || []).find(x => x.pid === pid) || {};
      const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
      const normList = s => String(s || '').split(/[、｜|,，;；]/).map(x => x.trim()).filter(Boolean).sort().join('、');
      const bad = [];
      if (expect.name !== undefined && !same(back.name, expect.name)) bad.push('名字');
      if (expect.nick !== undefined && !same(back.nick, expect.nick)) bad.push('资料卡名');
      if (expect.masterCall !== undefined && !same(back.masterCall, expect.masterCall)) bad.push('你喊他的方式');
      if (expect.suffix !== undefined && !same(back.suffix, expect.suffix)) bad.push('后缀');
      if (expect.alias !== undefined && normList(back.alias) !== normList(expect.alias)) bad.push('代称');
      if (expect.sex !== undefined && !same(back.sex, expect.sex)) bad.push('性别');
      if (expect.role !== undefined && !same(back.role, expect.role)) bad.push('身份');
      if (expect.favor !== undefined && Number(back.favor) !== Number(expect.favor)) bad.push('好感度');
      if (bad.length) { toast('没落地：' + bad.join(' / ') + '（再点一次保存）', true); return; }
      toast('已保存');
    } finally { btn.disabled = false; btn.textContent = oldTxt; }
    return;
  }

  if (act === 'person-create') {
    const name = ($('#np-name') || {}).value || '';
    const plat = ($('#np-plat') || {}).value || 'qq';
    const id = String(($('#np-id') || {}).value || '').trim();
    const bad = accIdError(id, plat);
    if (bad) { toast(bad, true); return; }
    const r = await window.xuh.personCreate(name, plat, id);
    if (r && r.error) { toast('建不了：' + r.error, true); return; }
    toast('建好了');
    await loadSnapshot();
    return;
  }

  if (act === 'add-acc') {
    const pid = btn.dataset.pid;
    const plat = ($('#ap-plat-' + pid) || {}).value || 'qq';
    const id = String(($('#ap-id-' + pid) || {}).value || '').trim();
    const bad = accIdError(id, plat);
    if (bad) { toast(bad, true); return; }
    const r = await window.xuh.personAddAccount(pid, plat, id);
    if (r && r.error) { toast('加不上：' + r.error, true); return; }
    toast('加好了');
    await loadSnapshot(); await loadFriends();
    return;
  }

  if (act === 'rm-acc') {
    const r = await window.xuh.personRemoveAccount(btn.dataset.pid, btn.dataset.plat, btn.dataset.aid);
    if (r && r.error) { toast('移不掉：' + r.error, true); return; }
    toast('移掉了');
    await loadSnapshot(); await loadFriends();
    return;
  }

  if (act === 'intent-words-save') {
    const pick = k => String(($('#iw-' + k) || {}).value || '').split('\n')
      .map(x => x.trim()).filter(Boolean);
    const words = { search: pick('search'), calc: pick('calc'), negate: pick('negate') };
    const r = await window.xuh.intentWordsSave(words);
    if (r && r.error) { toast('存不了：' + r.error, true); return; }
    S.intentWords = (r && r.words) || words;
    toast('词表已保存（共 ' + (words.search.length + words.calc.length) + ' 个派活词）');
    render();
    return;
  }

  if (act === 'intent-mode') {
    const k = btn.dataset.k;
    let v = btn.dataset.v;
    if (v === 'true') v = true; else if (v === 'false') v = false;
    const patch = { mode: {} }; patch.mode[k] = v;
    const r = await window.xuh.intentCfgSave(patch);
    if (r && r.error) { toast('改不了：' + r.error, true); return; }
    S.intentCfg = (r && r.cfg) || S.intentCfg;
    toast('已切换');
    if (typeof loadBot === 'function') await loadBot(); else render();
    return;
  }

  if (act === 'intent-cfg-save') {
    const ft = ($('#ia-failtext') || {}).value || '';
    const r = await window.xuh.intentCfgSave({ failText: ft });
    if (r && r.error) { toast('存不了：' + r.error, true); return; }
    S.intentCfg = (r && r.cfg) || S.intentCfg;
    toast('已保存');
    if (typeof loadBot === 'function') await loadBot(); else render();
    return;
  }

  if (act === 'merge-into') {
    const pid = btn.dataset.pid;
    const from = ($('#mg-' + pid) || {}).value || '';
    if (!from) { toast('先选要合并进来的人', true); return; }
    const r = await window.xuh.personMerge(pid, from);
    if (r && r.error) { toast('合并不了：' + r.error, true); return; }
    toast('合并好了（好感度相加，封顶 100）');
    await loadSnapshot(); await loadFriends();
    return;
  }

  if (act === 'trig-toggle') {
    const on = btn.dataset.on !== '1';
    const r = await window.xuh.trigToggle(btn.dataset.id, on);
    if (r && r.error) { toast('改不了：' + r.error, true); return; }
    await loadSnapshot();
    return;
  }

  if (act === 'trig-del') {
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1';
      btn.textContent = '确认删';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
      return;
    }
    const r = await window.xuh.trigDel(btn.dataset.id);
    if (r && r.error) { toast('删不掉：' + r.error, true); return; }
    toast('已删');
    await loadSnapshot();
    return;
  }

  if (act === 'trig-add') {
    const r = await window.xuh.trigAdd($('#nt-word').value, $('#nt-mode').value,
      { say: $('#nt-say').value, groupOnly: $('#nt-group').checked });
    if (r && r.error) { toast(r.error, true); return; }
    toast('加好了');
    await loadSnapshot();
    return;
  }

  if (act === 'switch') {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    const r = await window.xuh.setSwitch(btn.dataset.key, on);
    if (r && r.error) { toast('改不了：' + r.error, true); return; }
    btn.setAttribute('aria-pressed', String(on));
    toast(on ? '已打开' : '已关闭');
    await loadSnapshot();
    return;
  }

  if (act === 'critic') {
    const r = await window.xuh.setCritic($('#critic-p').value);
    if (r && r.error) { toast('改不了：' + r.error, true); return; }
    toast('已保存：' + r.p);
    await loadSnapshot();
    return;
  }

  if (act === 'bili-collect') {
    const v = ($('#bili-input') || {}).value || '';
    S.bili.input = v.trim();
    if (!S.bili.input) { toast('先贴一个视频链接 / BV 号', true); return; }
    if (S.bili.job && S.bili.job.running) { toast('上一轮还在跑，等它跑完', true); return; }
    const pages = Number(($('#bili-pages') || {}).value) || 2;
    const r = await window.xuh.api('POST', '/api/stickers/bili', { v: S.bili.input, pages: pages });
    if (r && r.error) { toast(r.error, true); return; }
    S.bili.job = { running: true, got: 0, seen: 0, skip: 0, fail: 0, log: ['开始收…'] };
    render();
    pollBiliJob();
    return;
  }

  if (act === 'bili-mention-refresh') {
    S.bili.mention = (await window.xuh.biliMention()) || null;
    render();
    toast('已刷新召唤状态');
    return;
  }

  if (act === 'bili-dmdir') {
    const r = await window.xuh.dmDir();
    if (r && r.error) { toast(r.error, true); return; }
    toast('已打开存档目录');
    return;
  }

  if (act === 'num-edit') {
    const cell = btn.closest('.num-cell');
    if (cell.querySelector('form')) return;
    const k = cell.dataset.k;
    const cur = cell.querySelector('.v').textContent;
    const label = cell.querySelector('.k').textContent;
    const old = cell.innerHTML;
    cell.innerHTML = `<span class="k">${esc(label)}</span>
      <form>
        <input class="field mono" value="${esc(cur)}" inputmode="decimal">
        <button class="btn btn-primary" type="submit">存</button>
      </form>`;
    const form = cell.querySelector('form');
    const input = form.querySelector('input');
    input.focus(); input.select();
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const r = await window.xuh.setNum(k, input.value);
      if (r && r.error) { toast('改不了：' + r.error, true); return; }
      toast('已保存');
      await loadSnapshot();
    });
    form.addEventListener('keydown', ev => { if (ev.key === 'Escape') cell.innerHTML = old; });
  }

  /* 回话路径（2026-11-13 ⑦⑧）：悬浮卡里的按钮也走这套委托。
   * 卡挂在 #floats，事件不冒泡到 #view —— 主委托已提到 document，这里才收得到。 */
  if (act.indexOf('rp-') === 0) {
    const R = S.rp, d = R.data || {};
    const gv = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    const done = async msg => { await loadRp(); if (msg) toast(msg); };
    if (act === 'rp-refresh') { R.form = null; R.desc = null; R.word = null; await loadRp(); return; }
    if (act === 'rp-tab') {
      R.tab = btn.dataset.v || 'emotion';
      if (R.tab !== 'config') R.kind = R.tab;   // 表单 / 改 / 删都按当前这张表走
      R.form = null; R.desc = null; R.word = null; paintFloats(); return;
    }
    if (act === 'rp-core') { R.core = btn.dataset.v || ''; paintFloats(); return; }
    if (act === 'rp-pick') {
      const picked = Array.from(document.querySelectorAll('input[name="rp-emochk"]:checked') || []).map(x => x.value);
      if (!picked.length) { toast('先勾几条说法', true); return; }
      const sel = document.getElementById('rp-pick-taste');
      const tasteIds = sel ? Array.from(sel.selectedOptions || []).map(o => o.value) : [];
      const r = await rpCall('replypath', 'pick', { ids: picked, tasteIds });
      if (!r || r.error) { toast('没选进去：' + ((r && r.error) || '未知原因'), true); return; }
      R.core = ''; await done('选进情绪应对表 ' + num(r.added || 0) + ' 条'); return;
    }
    if (act === 'rp-taste-add' || act === 'rp-taste-del') {
      const word = act === 'rp-taste-add' ? gv('rp-new-word') : gv('rp-word');
      if (!word) { toast('先写 / 选一个词', true); return; }
      if (act === 'rp-taste-del' && btn.dataset.arm !== '1') {
        btn.dataset.arm = '1'; btn.textContent = '确认删';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删选中的词'; } }, 3000);
        return;
      }
      const p = { word };
      if (act === 'rp-taste-add') p.sec = gv('rp-new-sec') || 'likeConf';
      const r = await rpCall('replypath', act === 'rp-taste-add' ? 'taste-add' : 'taste-del', p);
      if (!r || r.error) { toast('没成：' + ((r && r.error) || '未知原因'), true); return; }
      await done(act === 'rp-taste-add' ? '加进虚幻喜好表了' : '删了'); return;
    }
    if (act === 'rp-back') { R.form = null; R.desc = null; R.word = null; paintFloats(); return; }
    if (act === 'rp-new') { R.form = { kind: R.kind, name: '', text: '', tasteIds: [] }; paintFloats(); return; }
    if (act === 'rp-edit') {
      const it = (((d.list || {}).tables || {})[R.kind] || { items: [] }).items.find(x => String(x.id) === String(btn.dataset.id));
      if (it) { R.form = Object.assign({}, it, { kind: R.kind }); paintFloats(); }
      return;
    }
    if (act === 'rp-save') {
      const f = R.form || {};
      const el = document.getElementById('rp-taste');
      const tasteIds = el ? Array.from(el.selectedOptions || []).map(o => o.value) : (f.tasteIds || []);
      const opt = gv('rp-opt'), text = gv('rp-text') || (opt && !f.text ? opt : '');
      const p = { kind: R.kind, id: f.id, name: gv('rp-name'), text, tasteIds };
      for (const [k] of RP_TH) p[k] = gv('rp-th-' + k);
      const r = await rpCall('replypath', f.id ? 'save' : 'add', p);
      if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
      R.form = null; await done('存好了'); return;
    }
    if (act === 'rp-del') {
      if (btn.dataset.arm !== '1') {
        btn.dataset.arm = '1'; btn.textContent = '?';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '×'; } }, 3000);
        return;
      }
      const r = await rpCall('replypath', 'del', { kind: R.kind, id: btn.dataset.id });
      if (!r || r.error) { toast('删不掉：' + ((r && r.error) || '未知原因'), true); return; }
      await done('已删这一条'); return;
    }
    if (act === 'rp-copy' || act === 'rp-move') {
      const word = gv('rp-word'), dir = gv('rp-dir').split('>');
      if (!word || dir.length !== 2) { toast('先选一个词和方向', true); return; }
      const r = await rpCall('tastecopy', act === 'rp-move' ? 'move' : 'copy',
        { from: dir[0], to: dir[1], words: [word], by: 'master' });
      if (!r || r.error) { toast((act === 'rp-move' ? '转移' : '复制') + '没成：' + ((r && r.error) || '未知原因'), true); return; }
      await done(act === 'rp-move' ? '已转移' : '已复制'); return;
    }
    if (act === 'rp-word-add' || act === 'rp-word-del') {
      const which = gv('rp-which') || 'mine';
      const word = act === 'rp-word-add' ? gv('rp-new-word') : gv('rp-word');
      if (!word) { toast('先写 / 选一个词', true); return; }
      if (act === 'rp-word-del' && btn.dataset.arm !== '1') {
        btn.dataset.arm = '1'; btn.textContent = '确认删';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删选中的词'; } }, 3000);
        return;
      }
      const p = { which, words: [word], by: 'master' };
      if (act === 'rp-word-add') p.sec = gv('rp-new-sec') || 'likeConf';
      const r = await rpCall('tastecopy', act === 'rp-word-add' ? 'add' : 'del', p);
      if (!r || r.error) { toast((act === 'rp-word-add' ? '加' : '删') + '没成：' + ((r && r.error) || '未知原因'), true); return; }
      await done(act === 'rp-word-add' ? '加进去了，另一份表没动' : '删了，另一份表没动'); return;
    }
    /* 改词保留 id + 反查关联条目（⑧）：改完其他表里挂这个 id 的条目还是同一条。 */
    if (act === 'rp-tid') {
      const r = await rpCall('replypath', 'lookup', { id: btn.dataset.id });
      R.form = null; R.desc = null;
      R.word = { id: btn.dataset.id, word: btn.dataset.word || rpIdWord(btn.dataset.id), links: r || { items: [] } };
      paintFloats(); return;
    }
    if (act === 'rp-tid-back') { R.word = null; paintFloats(); return; }
    if (act === 'rp-tid-save') {
      const w = R.word || {}, nw = gv('rp-tid-word');
      if (!nw) { toast('词不能为空', true); return; }
      const r = await rpCall('tasteid', 'rename', { id: w.id, word: nw });
      if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
      R.word = null;
      const tail = r.mineSync ? '（正本正文没同步：' + r.mineSync + '）'
        : (r.localSkipped ? '（本地副本已上锁，没跟着改）' : '');
      await done('改好了，id 没变，关联条目照旧' + tail); return;
    }
    if (act === 'rp-desc') {
      const word = btn.dataset.word || gv('rp-word');
      const id = btn.dataset.id || '';
      const it = (((d.ids || {}).items) || []).find(x => (id && String(x.id) === id) || x.word === word);
      if (!it) { toast('先点一个词', true); return; }
      R.desc = { id: it.id, word: it.word, meta: it.meta || {} }; paintFloats(); return;
    }
    if (act === 'rp-desc-save') {
      const f = R.desc || {}, p = { id: f.id };
      for (const [k] of RP_META) p[k] = gv('rp-meta-' + k);
      const r = await rpCall('tasteid', 'meta', p);
      if (!r || r.error) { toast('描述没存上：' + ((r && r.error) || '未知原因'), true); return; }
      R.desc = null; await done('描述存好了，只在检索命中时给'); return;
    }
    if (act === 'rp-exception') {
      const id = gv('rp-ex-id');
      if (!id) { toast('先填偏好 id', true); return; }
      const r = await rpCall('replypath', 'exception', { id, note: gv('rp-ex-note') });
      if (!r || r.error) { toast('例外没设上：' + ((r && r.error) || '未知原因'), true); return; }
      await done('例外记下了'); return;
    }
    if (act === 'rp-threshold') {
      const text = gv('rp-th-text');
      if (!text) { toast('先写内容', true); return; }
      const r = await rpCall('replypath', 'threshold', { kind: R.kind, text });
      if (!r || r.error) { toast('没记上：' + ((r && r.error) || '未知原因'), true); return; }
      await done('记下了（只记录不做）'); return;
    }
    return;
  }

  /* 人设素材 / 可用知识：新增、改、补正文、删（2026-11-13） */
  if (act === 'kb-spec-close') { S.kb.spec = null; paintFloats(); return; }
  if (act === 'kb-spec-new') {
    floatWinExclusive('float');
    S.float.friendsTopic = false; S.float.chatTopic = false;
    S.kb.spec = { isNew: true, kind: 'persona',
      title: '', who: '', scope: '', tags: '', source: '', body: '' };
    paintFloats(); return;
  }
  if (act === 'kb-spec-edit') {
    const r = await window.xuh.kb('spec-get', { action: 'spec-get', id: btn.dataset.id });
    if (!r || r.error) { toast('读不出全文：' + ((r && r.error) || '未知'), true); return; }
    S.kb.spec = { isNew: false, id: r.id, kind: r.kind, title: r.title, who: r.who,
      scope: r.scope, tags: r.tags, source: r.source, body: r.body };
    paintFloats(); return;
  }
  if (act === 'kb-spec-save') {
    const s = S.kb.spec;
    if (!s) return;
    const gv = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const kind = gv('kbs-kind') || s.kind;
    const action = s.isNew ? 'spec-add' : 'spec-save';
    const payload = {
      action, id: s.id, kind, title: gv('kbs-title'), who: gv('kbs-who'),
      scope: gv('kbs-scope'), tags: gv('kbs-tags'), source: gv('kbs-source'), body: gv('kbs-body'),
    };
    if (!String(payload.title || '').trim()) { toast('给这条起个名字', true); return; }
    const r = await window.xuh.kb(action, payload);
    if (!r || r.error) { toast('没存上：' + ((r && r.error) || '未知原因'), true); return; }
    S.kb.spec = null;
    await loadKb();
    toast(s.isNew ? '记下了，正文以后随时能补到末尾' : '存好了');
    return;
  }
  if (act === 'kb-spec-del') {
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1'; btn.textContent = '确认删';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
      return;
    }
    const r = await window.xuh.kb('spec-del', { action: 'spec-del', id: btn.dataset.id });
    if (!r || r.error) { toast('删不掉：' + ((r && r.error) || '未知'), true); return; }
    await loadKb();
    toast('已删掉这一条');
    return;
  }

  /* 记录的：单条检索 / 核实 / 删除（2026-11-13） */
  if (act === 'kb-kind') { S.kb.kind = btn.dataset.v || 'file'; render(); return; }
  if (act === 'kb-ver') { S.kb.ver = btn.dataset.v || 'all'; render(); return; }
  if (act === 'kb-only') { S.kb.only = btn.dataset.id || ''; render(); return; }
  if (act === 'kb-clear') { S.kb.only = ''; S.kb.q = ''; S.kb.who = ''; S.kb.since = ''; S.kb.until = ''; render(); return; }
  if (act === 'kb-verify') {
    const r = await window.xuh.kb('verify', { id: btn.dataset.id });
    if (!r || r.error) { toast('核实没记上：' + ((r && r.error) || '未知'), true); return; }
    toast('记下了：这条算你手动核实过');
    await loadKb();
    return;
  }
  if (act === 'kb-open') {
    // path 是相对 src 的路径：攻略 data/guides/x.md、人设 soul/段/3-应对.md
    const pth = btn.dataset.path || ('data/guides/' + (btn.dataset.file || ''));
    const r = await window.xuh.cmdBlock(pth, Number(btn.dataset.line) || 0);
    if (r && r.error) toast(r.error, true);
    else toast(r && r.fallback ? '没找到命令方块，已用默认程序打开' : '已在命令方块里打开');
    return;
  }
  /* md 类改内容 / 搬归属（2026-11-13）：先改正文，再按需搬到另一份文件 */
  if (act === 'kb-edit') {
    const x = (S.kb.list || []).find(y => String(y.id) === String(btn.dataset.id));
    if (!x) return;
    S.kb.edit = { id: x.id, file: x.file, title: x.title, body: x.body, topic: x.topic || '' };
    render(); return;
  }
  if (act === 'kb-editclose') { S.kb.edit = null; render(); return; }
  if (act === 'kb-save') {
    const e = S.kb.edit;
    if (!e) return;
    const gv = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const file = gv('kbe-file') || e.file;
    const r1 = await window.xuh.kb('edit', { id: e.id, title: gv('kbe-title') || e.title, body: gv('kbe-body'), topic: gv('kbe-topic') });
    if (!r1 || r1.error) { toast('没存上：' + ((r1 && r1.error) || '未知原因'), true); return; }
    if (file && file !== e.file) {
      const r2 = await window.xuh.kb('move', { id: e.id, file });
      if (!r2 || r2.error) { toast('内容存了，但没搬成：' + ((r2 && r2.error) || '未知原因'), true); return; }
    }
    S.kb.edit = null;
    await loadKb();
    S.guides.loaded = false; await loadGuides();
    toast('存好了' + (file && file !== e.file ? '，并搬到 ' + file : ''));
    return;
  }
  if (act === 'kb-del') {
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1'; btn.textContent = '确认删';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
      return;
    }
    const r = await window.xuh.kb('delete', { id: btn.dataset.id });
    if (!r || r.error) { toast('删不掉：' + ((r && r.error) || '未知'), true); return; }
    toast('已删掉这一条');
    S.guides.loaded = false;
    await loadGuides();
    await loadKb();
    return;
  }

  /* 攻略：新建 / 编辑 / 保存 / 看原文 / 删（数据走 guides.api） */
  if (act === 'guide-new') { S.guides.edit = { name: '', isNew: true }; S.guides.draft = ''; render(); return; }
  if (act === 'guide-close') { S.guides.edit = null; S.guides.draft = ''; render(); return; }
  if (act === 'guide-edit') {
    const name = btn.dataset.name;
    const r = await window.xuh.guides('read', { name });
    if (!r || r.error) { toast('读不到：' + ((r && r.error) || '未知'), true); return; }
    S.guides.edit = { name }; S.guides.draft = r.content || ''; render();
    return;
  }
  if (act === 'guide-save') {
    const ed = S.guides.edit;
    const isNew = !!(ed && ed.isNew);
    const name = isNew ? ((($('#g-name') || {}).value || '').trim()) : (ed ? ed.name : (($('#g-name') || {}).value || '').trim());
    const content = ($('#g-content') || {}).value || '';
    if (!name) { toast('先写攻略名', true); return; }
    // 新建的默认记她名下（她的第一个号）；改老的传 undefined，后端沿用文件里原有署名
    const r = await window.xuh.guides('write', isNew ? { name, content, by: GUIDE_BY_MASTER } : { name, content });
    if (!r || r.error) { toast('存不了：' + ((r && r.error) || '未知'), true); return; }
    toast(isNew ? '建好了（已自动打标记 + 署名）' : '已保存');
    S.guides.edit = null; S.guides.draft = ''; S.guides.loaded = false;
    await loadGuides();
    return;
  }
  if (act === 'guide-open') {
    // 看原文统一交给命令方块（和表情包页的「看原文」同一套），不另开系统编辑器
    const r = await window.xuh.cmdBlock('data/guides/' + btn.dataset.name + '.md');
    if (r && r.error) toast(r.error, true);
    else toast(r && r.fallback ? '没找到命令方块，已用默认程序打开' : '已在命令方块里打开');
    return;
  }
  if (act === 'guide-delete') {
    if (btn.dataset.arm !== '1') {
      btn.dataset.arm = '1'; btn.textContent = '确认删';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = '0'; btn.textContent = '删'; } }, 3000);
      return;
    }
    const r = await window.xuh.guides('delete', { name: btn.dataset.name });
    if (!r || r.error) { toast('删不掉：' + ((r && r.error) || '未知'), true); return; }
    toast('已删');
    S.guides.loaded = false; await loadGuides();
    return;
  }

  /* 文件（命令方块）：只负责带路——点文件跳过去，或者直接打开命令方块 */
  if (act === 'file-goto') { await gotoFile(btn.dataset.rel); return; }
  if (act === 'file-open-cb') { await window.xuh.cmdOpen(); return; }
});

/* 菜单里的「刷新数据」 */
if (window.xuh.onReload) {
  window.xuh.onReload(() => {
    if (window.StickerPage && window.StickerPage.reset) window.StickerPage.reset();
    chatResetView();                             // 菜单「刷新数据」= 重置：贴底 + 回到第 1 页
    loadSnapshot();
  });
}

/* 机器人状态：左栏计数和顶栏那盏灯每 5 秒跟一次（只读状态，不碰进程）。
 * 公开版只剩表情包 / 搬屎两页 + 参数浮层，机器人页整页删掉了，
 * 所以这里不再轮询机器人状态（原来的 loadBot / paintBot / htmlBot 都在 bot-page.js 里）。 */

/* 屏幕右下就一块地方：参数抽屉和浮卡同一时刻只留一个。
 * 她 2026-11-14 原话「右下角入口全堆在一起」——入口并成一个坞解决了，窗口本身也不能叠。
 * 两个都是可拖的，但默认位都在右下角，同时开会正好压在一起，所以开一个就收另一个。
 * keep: 'param' 留参数抽屉 / 'float' 留浮卡（话题、回话路径、知识条）。 */
function floatWinExclusive(keep) {
  if (keep === 'float') { if (PARAM.open) paramClose(); return; }
  if (keep === 'param'
    && (S.float.friendsTopic || S.float.chatTopic || S.float.replypath || S.kb.spec)) {
    S.float.friendsTopic = false; S.float.chatTopic = false;
    S.float.replypath = false; S.kb.spec = null;
    paintFloats();
  }
}

/* ===========================================================================
 * 浮窗系统（2026-11-14 主人令）
 * ---------------------------------------------------------------------------
 * 她原话：「右下角入口全堆在一起」「以后如果要加这种悬浮窗口，必须全都改成可拖动的」。
 *
 * 四条规矩，加新浮窗时照着来：
 *   ① 入口只许进 #fabDock（工具坞），不许再新起一个 position:fixed 的圆钮；
 *   ② 新浮窗的外壳必须有 .win 或下列同族之一，并且有一个「把手」元素
 *      （.win__bar / .param-panel__head / .float-card__head / .dock-bar / .rain-tune__head），
 *      把手的 pointerdown 就是拖动起点 —— 不用另写拖拽代码；
 *   ③ 位置存 localStorage（key 'xuh.win.pos.v1'），下次打开原样还原；
 *   ④ 松手贴边（12px 内自动靠边）+ 收进窗内，绝不会拖丢到看不见的地方。
 *
 * 为什么用「事件委托 + 注册表」而不是给每个浮窗绑一次：
 *   聊天浮层（.chat-dock）和悬浮卡（.float-card）每次重画都是新的 DOM 节点，
 *   绑在节点上的监听会跟着节点一起消失。委托到 document 就永远有效。
 * =========================================================================== */
const WIN_POS_KEY = 'xuh.win.pos.v1';
/* 把手：按住这里 = 拖这个窗 */
const WIN_HEAD_SEL = '.win__bar, .param-panel__head, .float-card__head, .dock-bar, .rain-tune__head';
/* 窗本体：把手往上找最近的一个 */
const WIN_BODY_SEL = '.win, .param-panel, .float-card, .chat-dock, .rain-tune';

const FloatWin = {
  pos: {},
  /* 每个窗一个稳定 key：不跟着 DOM 重画变（重画后靠 key 把位置摆回去） */
  keyOf(el) {
    if (!el) return '';
    if (el.id === 'fabDock') return 'dock';
    if (el.id === 'paramPanel') return 'param';
    if (el.id === 'rainTune') return 'rain';
    if (el.classList && el.classList.contains('chat-dock')) return 'chatdock';
    const f = el.getAttribute && el.getAttribute('data-float');
    return f ? 'float:' + f : '';
  },
  load() {
    try { this.pos = JSON.parse(localStorage.getItem(WIN_POS_KEY) || '{}') || {}; }
    catch (e) { this.pos = {}; }
  },
  save() {
    try { localStorage.setItem(WIN_POS_KEY, JSON.stringify(this.pos)); } catch (e) {}
  },
};

/* 收进窗内：横向至少留 keepX 像素看得见（够抓手/看出一角），纵向至少留住把手。
 * 高/宽拿不到（元素还在 hidden 里）时按默认值算，不会算成负数。 */
function winClamp(x, y, w, h) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const W = w || 320, H = h || 140;
  const keepX = Math.min(120, W);
  const keepY = Math.min(46, H);
  return {
    x: Math.round(Math.min(Math.max(x, keepX - W), vw - keepX)),
    y: Math.round(Math.min(Math.max(y, 0), vh - keepY)),
  };
}

/* 把一个窗摆到它上次的位置；没拖过就什么都不做（用 CSS 默认位） */
function floatWinApply(el) {
  if (!el) return;
  const key = FloatWin.keyOf(el);
  if (!key) return;
  const p = FloatWin.pos[key];
  if (!p) return;
  const r = el.getBoundingClientRect();
  const c = winClamp(p.x, p.y, r.width, r.height);
  el.style.left = c.x + 'px';
  el.style.top = c.y + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}
/* 重画之后统一摆位（聊天浮层 / 悬浮卡每次都是新节点，必须重摆） */
function floatWinApplyAll() {
  document.querySelectorAll('#fabDock, #paramPanel, #rainTune, .chat-dock, .float-card')
    .forEach(floatWinApply);
}

(function initFloatWin() {
  FloatWin.load();
  let drag = null;

  /* 鼠标落点是不是某个浮窗的把手？返回窗本体（或 null） */
  function hitWin(t) {
    if (!t || !t.closest) return null;
    const dock = t.closest('#fabDock');
    if (dock) return t.closest('.fab') ? null : dock;   // 坞里的图标按钮要点，不能拖
    const head = t.closest(WIN_HEAD_SEL);
    if (!head) return null;
    /* 把手里的按钮 / 输入不抢（×、标签页、收起都在把手里，必须照常可点） */
    if (t.closest('button, input, select, textarea, a, label')) return null;
    return head.closest(WIN_BODY_SEL);
  }

  function onDown(e) {
    if (drag || (e.button !== undefined && e.button !== 0)) return;
    const win = hitWin(e.target);
    if (!win) return;
    const r = win.getBoundingClientRect();
    drag = {
      el: win, key: FloatWin.keyOf(win), id: e.pointerId,
      dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height,
    };
    win.classList.add('is-dragging');
    document.body.classList.add('is-win-drag');
    try { win.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();          // 拖动时不要顺带选中文字
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.el.style.left = Math.round(e.clientX - drag.dx) + 'px';
    drag.el.style.top = Math.round(e.clientY - drag.dy) + 'px';
    drag.el.style.right = 'auto';
    drag.el.style.bottom = 'auto';
  }

  function onUp(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    d.el.classList.remove('is-dragging');
    document.body.classList.remove('is-win-drag');
    const r = d.el.getBoundingClientRect();
    let x = r.left, y = r.top;
    const snap = 12;
    if (x < snap) x = 0;
    if (y < snap) y = 0;
    if (x + r.width > window.innerWidth - snap) x = window.innerWidth - r.width;
    if (y + r.height > window.innerHeight - snap) y = window.innerHeight - r.height;
    const c = winClamp(x, y, r.width || d.w, r.height || d.h);
    d.el.style.left = c.x + 'px';
    d.el.style.top = c.y + 'px';
    if (d.key) { FloatWin.pos[d.key] = c; FloatWin.save(); }
  }

  /* capture 阶段接：页面里任何 stopPropagation 都挡不住拖动 */
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  /* 窗口变大小：把拖到边上的窗收回来，不留半个在外面 */
  window.addEventListener('resize', () => floatWinApplyAll());

  floatWinApplyAll();
})();

/* ===========================================================================
 * 主页 + 左栏分级导航（2026-11-16；做完 11-14 整块排版需求 + 11-16 六句补充）
 * ---------------------------------------------------------------------------
 * 她定的三件事，这里一次做全：
 *   ① 主页＝聊天记录常驻画布。左栏的入口不是「切到 13 个平级页面」，而是给画布选
 *      单人 / 群 / 平台 / 汇总内容；碰了就算选中，主画布显示对应的聊天记录。
 *   ② 二级目录要能用、能往下钻：一级 → 二级 → 三级 → 四级五级，不封顶。
 *      点头像 = 进「此人单独此选项的页面」。
 *   ③ 点任一入口 = 取代原本的人物列表（不是弹浮窗），可关闭后恢复主视图。
 *
 * 修掉的可用性坑（11-14 版）：
 *   - .rail-fly 的 display:flex 盖掉了 UA 的 [hidden]{display:none} → 隐形的 268px
 *     面板一直压在 x=232 处挡鼠标。app.css 已补 .rail-fly[hidden]{display:none}。
 *   - 左栏右缘 218px、二级菜单 left:232px，中间 14px 空隙；鼠标一跨过去就触发
 *     rail.mouseleave → 当场 railFlyHide()，二级菜单永远点不到。现在 left 改成
 *     216px 压住接缝，且 mouseleave 只排延迟、不立刻隐藏。
 * =========================================================================== */
const RAIL = { open: false, closeTimer: 0, selectTimer: 0, flyTimer: 0, pickView: '', view: 'chat', level: [] };

function railEl() { return $('#rail'); }

function railOffsetTop(el, root) {
  let y = 0, cur = el;
  while (cur && cur !== root) { y += cur.offsetTop; cur = cur.offsetParent; }
  return y;
}

/* 小标：选中项在窗口左边缘留一条 3px 竖线，position:fixed，不占布局 */
function railTickTo() {
  const rail = railEl(), tick = $('#railTick');
  const on = document.querySelector('.nav-item.is-on');
  if (!rail || !tick) return;
  if (!on) { tick.style.opacity = '0'; return; }
  const y = railOffsetTop(on, rail);
  tick.style.top = Math.round(rail.getBoundingClientRect().top + y + on.offsetHeight / 2) + 'px';
  tick.style.opacity = '';
}

function railOpen() {
  const rail = railEl();
  if (!rail) return;
  clearTimeout(RAIL.closeTimer);
  clearTimeout(RAIL.flyTimer);
  if (RAIL.open) return;
  RAIL.open = true;
  rail.classList.add('is-open');
  document.body.classList.add('rail-open');
}
function railClose(delay) {
  clearTimeout(RAIL.closeTimer);
  RAIL.closeTimer = setTimeout(() => {
    const rail = railEl();
    if (!rail) return;
    RAIL.open = false;
    rail.classList.remove('is-open');
    document.body.classList.remove('rail-open');
    railFlyHide();
    railTickTo();
  }, delay == null ? 320 : delay);
}
function railFlyHide() {
  const fly = $('#railFly');
  if (!fly) return;
  clearTimeout(RAIL.flyTimer);
  fly.classList.remove('is-open');
  fly.hidden = true;
}
function railFlyKeep() {
  clearTimeout(RAIL.closeTimer);
  clearTimeout(RAIL.flyTimer);
}

/* 碰某个入口 = 选中它（她 11-14 原话）。不切 S.tab —— 主页是常驻画布，
 * 切页就把它降级成「默认选中某一页」了。这里只换画布内容与小标位置。 */
function railHoverSelect(item) {
  const view = item.dataset.view;
  clearTimeout(RAIL.selectTimer);
  RAIL.pickView = view;
  RAIL.selectTimer = setTimeout(() => {
    if (RAIL.pickView !== view) return;
    S.home.sel = view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
    $('#view-title').textContent = item.querySelector('.nav-label').textContent;
    if (S.tab === 'chat') render();      // 选择后直接显示对应的设置栏 / 聊天记录
    railTickTo();
  }, 90);
}

/* ---------------------------------------------------------------------------
 * 层级数据：不编内容，全部从现有数据生成。
 *   level 0 = 全部 + 单人 / 群 / 平台（聊天记录里的真实会话）
 *   level 1 = 这个入口下的功能分类（约定 / 话题 / 喜好 / 状态 / 设置…）
 *   level 2 = 分类下的方向（约定的「说话方式 / 条件明确」、话题的「单人 / 群 / 通用」…）
 *   level 3 = 具体条目；level 4 = 这一条的原文字段 → 至少到第五级，且结构不封顶
 * --------------------------------------------------------------------------- */
const RAIL_CATS = {
  chat:    ['约定', '话题', '情绪', '状态', '设置'],
  teach:   ['约定', '话题', '喜好', '学到的', '状态'],
  friends: ['约定', '话题', '喜好', '好感', '资料'],
  bili:    ['约定', '话题', '设置'],
  health:  ['保健提醒', '洛克王国', '固定标签'],
  learn:   ['好感事件', '设置'],
};

function railDirsOf(cat) {
  if (cat === '约定') {
    const n = { '说话方式': 0, '条件明确': 0, '其他': 0 };
    ((S.pacts && S.pacts.list) || []).forEach(p => {
      const k = pactKindOf(p) === 'style' ? '说话方式' : (pactKindOf(p) === 'scene' ? '条件明确' : '其他');
      n[k] = (n[k] || 0) + 1;
    });
    /* 三个方向固定都在，0 条也列。她 11-14 原话点名「记录的 · 约定 · 说话方式」这条三级
     * 路径；只按现有数据统计的话，某一类一条都没有时这条路径会整条消失，等于没做。 */
    return Object.keys(n).map(k => ({ kind: 'dir', label: k, sub: n[k] + ' 条', cls: 'dir' }));
  }
  if (cat === '话题') return ['单人', '群', '通用'].map(k => ({ kind: 'dir', label: k, sub: '三级', cls: 'dir' }));
  if (cat === '学到的') return ((S.teach && S.teach.dirs && S.teach.dirs.length) ? S.teach.dirs : ['游戏攻略', '情绪表达', '梗词句'])
    .map(k => ({ kind: 'dir', label: k, sub: '三级', cls: 'dir' }));
  return ['说话方式', '条件明确', '其他'].map(k => ({ kind: 'dir', label: k, sub: '三级', cls: 'dir' }));
}
function railLeavesOf(cat, dir) {
  const pool = cat === '约定' ? ((S.pacts && S.pacts.list) || []) : ((S.review && S.review.list) || []);
  const arr = cat === '约定'
    ? pool.filter(p => (pactKindOf(p) === 'style' ? '说话方式' : '条件明确') === dir)
    : pool.slice(0, 30);
  return arr.slice(0, 40).map(p => ({
    kind: 'leaf', label: String(p.say || p.text || p.name || '（未填）').slice(0, 18),
    sub: p.whoName || pactWhoName(p) || '', cls: 'leaf', id: p.id,
  }));
}
function railFieldsOf(id) {
  const it = [].concat((S.pacts && S.pacts.list) || [], (S.review && S.review.list) || []).find(x => x.id === id);
  if (!it) return [];
  return [['触发', (it.when || []).join(' / ')], ['原文', String(it.say || it.text || '')], ['时间', it.t ? fmtTime(it.t) : '']]
    .filter(x => x[1]).map(x => ({ kind: 'field', label: x[0] + '：' + String(x[1]).slice(0, 20), sub: '五级', cls: 'field' }));
}
function railLevelItems(view, level) {
  const cats = RAIL_CATS[view] || ['约定', '话题', '设置'];
  const L = level.length;
  if (L === 0) {
    const out = [{ kind: 'all', label: '全部', sub: '这个入口的所有内容', cls: 'all' }];
    const byConv = new Map();
    (S.chat.list || []).forEach(m => {
      const cv = chatConvOf(m);
      if (!cv || cv === '__all' || cv === '__private' || cv === '__group') return;
      if (!byConv.has(cv)) byConv.set(cv, {
        n: 0, name: m.convLabel || m.whoName || m.nick || cv,
        cls: m.convKind === 'group' ? 'group' : ((m.plat && m.plat !== 'qq') ? 'plat' : 'private'),
        uid: m.uid || '', avPlat: m.avPlat || m.plat || 'qq', avId: m.avId || m.uid || '',
      });
      byConv.get(cv).n++;
    });
    const ORDER = { private: 0, group: 1, plat: 2 };
    [...byConv.entries()]
      .sort((a, b) => (ORDER[a[1].cls] - ORDER[b[1].cls]) || (b[1].n - a[1].n))
      .forEach(([cv, v]) => out.push(Object.assign({ kind: 'conv', label: v.name, sub: v.n + ' 条', conv: cv }, v)));
    /* 「按内容」这一组才让「记录的 · 约定」「记录的 · 约定 · 说话方式」走得到：
     * 点约定 → 说话方式 / 条件明确 → 具体条目 → 触发/原文/时间，最多五级且不封顶。 */
    cats.forEach(c => out.push({ kind: 'cat', label: c, sub: '按内容 · 二级', cls: 'cat', sec: '按内容' }));
    return out;
  }
  const isCat = cats.indexOf(level[0]) >= 0;
  if (L === 1) return isCat ? railDirsOf(level[0]) : cats.map(c => ({ kind: 'cat', label: c, sub: '二级', cls: 'cat' }));
  const cat = isCat ? level[0] : (level[1] || '');
  const dir = isCat ? (level[1] || '') : (level[2] || '');
  if (L === 2) return isCat ? railLeavesOf(cat, dir) : railDirsOf(cat);
  if (L === 3) return isCat ? railFieldsOf(RAIL.pickedId) : railLeavesOf(cat, dir);
  return railFieldsOf(RAIL.pickedId);
}

/* 头像补回（她 11-16：「人物头像现在没了，补回来」）：
 * 有号就用 xuh://avatar/ 真头像，取不到退回首字方块，绝不空白。 */
function railAvatar(g) {
  const initial = esc(String(g.label || '?').slice(0, 1));
  if (g.kind === 'conv' && (g.avId || g.conv)) {
    const id = String(g.avId || g.conv).replace(/[^0-9A-Za-z_.-]/g, '');
    if (id) return '<span class="rail-fly__av is-' + esc(g.cls || 'private') + ' has-photo"'
      + ' data-act="rail-person" data-conv="' + esc(g.conv || '') + '" data-uid="' + esc(g.uid || '') + '"'
      + ' title="点头像进这个人单独此选项的页面">'
      + '<img class="rail-fly__photo" src="xuh://avatar/' + esc(g.avPlat === 'group' ? 'group' : (g.avPlat || 'qq')) + '/' + esc(id) + '" alt="">'
      + initial + '</span>';
  }
  return '<span class="rail-fly__av is-' + esc(g.cls || 'all') + '">' + initial + '</span>';
}

function railFlyRow(g) {
  return '<button class="rail-fly__row' + (g.kind === 'all' ? ' is-all' : '') + '"'
    + ' data-rail-kind="' + g.kind + '"'
    + (g.conv ? ' data-rail-conv="' + esc(g.conv) + '"' : '')
    + (g.uid ? ' data-rail-uid="' + esc(g.uid) + '"' : '')
    + (g.id ? ' data-rail-id="' + esc(g.id) + '"' : '')
    + ' data-rail-label="' + esc(g.label) + '"'
    + ' title="' + esc(g.label + ' · ' + g.sub) + '">'
    + railAvatar(g) + '<span class="rail-fly__t">' + esc(g.label) + '</span>'
    + '<span class="rail-fly__n">' + esc(g.sub) + '</span>'
    + (g.kind === 'conv' || g.kind === 'cat' || g.kind === 'dir' ? '<span class="rail-fly__go">›</span>' : '')
    + '</button>';
}

/* 朋友录二级目录（她 11-17 原话：触碰朋友录浮出里面全部的二级目录）。
 * 数据源与朋友录页签完全相同（htmlFriends 的 zones，app.js:2479），不另造第二套。 */
const FRIEND_ZONES = [
  ['all', '全部'], ['friend', '朋友录'], ['book', '人物册'], ['group', '群聊人物'],
  ['topic', '全部话题'], ['pact', '全部约定'], ['common', '通用话题'], ['taste', '全部人的喜好'],
];
function railFlyFriends(itemEl) {
  const fly = $('#railFly');
  const rows = FRIEND_ZONES.map(([z, label]) =>
    '<button class="rail-fly__row is-all" data-fzone="' + esc(z) + '" title="进朋友录 · ' + esc(label) + '">'
    + '<span class="rail-fly__av is-all">' + esc(label.slice(0, 1)) + '</span>'
    + '<span class="rail-fly__t">' + esc(label) + '</span>'
    + '<span class="rail-fly__go">›</span></button>').join('');
  fly.dataset.view = 'friends';
  fly.innerHTML = '<div class="rail-fly__head"><span>朋友录 · 二级目录</span></div>'
    + '<div class="rail-fly__hint">点一项进朋友录对应分区</div>'
    + '<div class="rail-fly__body">' + rows + '</div>';
  fly.hidden = false;
  const rail = railEl();
  fly.style.top = Math.max(12, Math.round(rail.getBoundingClientRect().top + railOffsetTop(itemEl, rail) - 8)) + 'px';
  fly.classList.add('is-open');
}

function railFlyShow(view, itemEl) {
  const fly = $('#railFly');
  if (!fly) return;
  if (view === 'friends') return railFlyFriends(itemEl);   // 朋友录：真实二级目录
  const items = railLevelItems(view, RAIL.level);
  const SEC = { private: '单人', group: '群', plat: '平台' };
  let last = '';
  const body = items.map(g => {
    const sec = (g.kind === 'conv' && SEC[g.cls]) ? SEC[g.cls] : (g.sec || '');
    const head = (sec && sec !== last) ? (last = sec, '<div class="rail-fly__sec">' + sec + '</div>') : '';
    return head + railFlyRow(g);
  }).join('');
  const crumb = [esc(TITLES[view] || view)].concat(RAIL.level.map(x => esc(x))).join(' <span class="rail-fly__sep">·</span> ');
  const back = RAIL.level.length
    ? '<button class="rail-fly__back" data-act="rail-back" title="回上一级">← 上一级</button>' : '';
  fly.dataset.view = view;
  fly.innerHTML = '<div class="rail-fly__head"><span>' + crumb + '</span>' + back + '</div>'
    + '<div class="rail-fly__hint">碰着选 · 点一条取代人物列表 · 点头像进他单独页</div>'
    + '<div class="rail-fly__body">' + (body || '<div class="rail-fly__sec">这一级没有更细的了</div>') + '</div>';
  fly.hidden = false;
  const rail = railEl();
  fly.style.top = Math.max(12, Math.round(rail.getBoundingClientRect().top + railOffsetTop(itemEl, rail) - 8)) + 'px';
  fly.classList.add('is-open');
}

/* ---------------------------------------------------------------------------
 * 接管面板：点任一入口 → 取代原本的人物列表；× 关闭恢复主视图。
 * A 类（both）同时给「汇总 / 分开显示」两种；B 类（sum）只有汇总。
 * 内容全部复用现有渲染函数与数据，不新造第二套。
 * --------------------------------------------------------------------------- */
const HOME_PANELS = {
  pact:     { label: '约定',       view: 'pacts',    cls: 'both', sum: () => htmlHomePactSum() },
  topic:    { label: '话题',       view: 'meme',     cls: 'both', sum: () => htmlHomeTopicSum() },
  emotion:  { label: '情绪表',     view: 'emotion',  cls: 'both', sum: () => htmlHomeEmotion() },
  stickers: { label: '表情包',     view: 'stickers', cls: 'both', sum: () => htmlHomeStub('stickers') },
  logs:     { label: '写入日志',   view: 'logs',     cls: 'both', sum: () => htmlHomeStub('logs') },
  dict:     { label: '查词典',     view: 'meme',     cls: 'sum',  sum: () => htmlHomeStub('dict') },
  files:    { label: '命令方块',   view: 'files',    cls: 'sum',  sum: () => htmlHomeStub('files') },
  persona:  { label: '人设编辑',   view: 'persona',  cls: 'sum',  sum: () => htmlHomeStub('persona') },
  reqs:     { label: '需求记录',   view: 'reqs',     cls: 'sum',  sum: () => htmlHomeStub('reqs') },
  bot:      { label: '机器人',     view: 'bot',      cls: 'sum',  sum: () => htmlHomeStub('bot') },
  settings: { label: '被移动的全部', view: '',       cls: 'sum',  sum: () => htmlHomeSettings() },
};

function homeOpenPanel(id, o) {
  const h = S.home, cfg = HOME_PANELS[id] || HOME_PANELS.settings;
  o = o || {};
  h.panel = id; h.cls = cfg.cls; h.mode = o.mode || 'sum';
  h.level = o.level || []; h.sel = id; h.splitKey = o.splitKey || ''; h.settings = !!o.settings;
  if (o.conv) { h.conv = o.conv; S.chat.conv = o.conv; S.chat.pinBottom = true; }
  if (S.tab !== 'chat') go('chat'); else render();
  /* 汇总面板依赖约定 / 复核两份数据。聊天数据已就绪、这两份却还没拉到时
   * （从别的页第一次直接点汇总入口、或上一次拉取失败），补拉一次并在到货后重绘，
   * 否则面板会停在「0 条」的空态不再刷新。chat 自己没加载时 go('chat') 的 loadChat
   * 已经串着这两次拉取，这里不重复发请求。 */
  if (S.chat.loaded && !S.pacts.loaded) {
    loadPacts().then(() => { if (S.home.panel && S.tab === 'chat') render(); }).catch(() => {});
  }
  if (S.chat.loaded && !S.review.loaded) loadReview().catch(() => {});
  railTickTo();
}
function homeClose() {
  S.home.panel = ''; S.home.level = []; S.home.sel = ''; S.home.splitKey = ''; S.home.settings = false;
  render(); railTickTo();
}
/* 下钻老页面：从主页进一级页面，顶栏出现「← 主页」 */
function homeDrill(tab) {
  if (!tab) return;
  S.home.from = 'chat';
  go(tab);
  const b = $('#homeBack'); if (b) b.hidden = false;
}
function homeBack() {
  const b = $('#homeBack'); if (b) b.hidden = true;
  go('chat');
}

/* 汇总 + 关联显示两个都留（她 11-14 原话：「一个关联显示，一个只看约定条，
 * 只留一个会丢功能」）。这里给全部约定/话题的汇总，下面接本会话的关联显示。 */
function htmlHomePactSum() {
  const list = (S.pacts && S.pacts.list) || [];
  const rel = htmlChatPacts(S.chat.conv);
  const rows = list.length ? '<div class="home-list">' + list.slice(0, 50).map(p =>
      '<div class="home-list__row"><span>' + esc(String(p.say || p.text || '（未填）').slice(0, 20)) + '</span>'
      + '<span class="dim">' + esc(p.whoName || pactWhoName(p) || '') + '</span></div>').join('') + '</div>' : '';
  return '<div class="home-sum"><div class="home-sum__n">' + num(list.length) + ' <span>条约定</span></div>'
    + '<div class="small dim">汇总：全部约定。下面这段是「本会话关联显示」，两个都在。</div>'
    + rows + (rel || '<div class="small dim">本会话暂时没有关联的约定。</div>')
    + '<button class="btn" data-act="home-drill" data-view="pacts">打开约定页看全部</button></div>';
}
function htmlHomeTopicSum() {
  const list = ((S.review && S.review.list) || []).filter(x => x.rkind === 'topic');
  const rel = htmlChatTopics(S.chat.conv);
  return '<div class="home-sum"><div class="home-sum__n">' + num(list.length) + ' <span>条话题</span></div>'
    + '<div class="small dim">汇总：全部话题。下面是当前会话的相关话题。</div>'
    + '<div class="home-list">' + list.slice(0, 50).map(x =>
        '<div class="home-list__row">' + esc(String(x.text || x.name || '—').slice(0, 22)) + '</div>').join('') + '</div>'
    + (rel || '') + '<button class="btn" data-act="home-drill" data-view="meme">打开话题页看全部</button></div>';
}

function htmlHomeStub(id) {
  const cfg = HOME_PANELS[id] || {};
  let n = 0, extra = '';
  if (id === 'stickers') n = (S.snap && S.snap.stickers && S.snap.stickers.total) || 0;
  if (id === 'logs') { n = (S.logs.list || []).length; extra = '按天只追加不覆盖'; }
  if (id === 'dict') { n = (S.kb && S.kb.list ? S.kb.list.length : 0) || 0; extra = '本地词库 / 查梗词汇'; }
  if (id === 'files') { n = (S.files && S.files.list ? S.files.list.length : 0) || 0; }
  if (id === 'reqs') { n = (S.reqs && S.reqs.list ? S.reqs.list.length : 0) || 0; }
  return '<div class="home-sum"><div class="home-sum__n">' + num(n) + ' <span>条</span></div>'
    + '<div class="home-sum__t">' + esc(cfg.label || id) + (extra ? ' · ' + extra : '') + '</div>'
    + '<div class="small dim">汇总显示：这一项只有汇总，不按人 / 群 / 平台分开。</div>'
    + '<button class="btn" data-act="home-drill" data-view="' + esc(cfg.view || '') + '"'
    + ' title="进这一页，看能改的全部">打开这一页看全部</button></div>';
}
function htmlHomeEmotion() {
  const d = (S.rp && S.rp.data) || {};
  const tables = (d.list && d.list.tables) || {};
  const rows = (tables.emotion && tables.emotion.book && tables.emotion.book.rows) || [];
  return '<div class="home-sum"><div class="home-sum__n">' + num(rows.length) + ' <span>条</span></div>'
    + '<div class="home-sum__t">情绪应对表</div>'
    + '<div class="small dim">情绪表 / 动作应对 / 信息对齐 / 喜好表都在这一个入口里。</div>'
    + (rows.length ? '<div class="home-list">' + rows.slice(0, 40).map(r =>
        '<div class="home-list__row">' + esc(r.name || r.word || '—') + '</div>').join('') + '</div>' : '')
    + '<button class="btn" data-act="home-mode" data-mode="split">按单人 / 群 / 平台分开看</button></div>';
}
function htmlHomeSettings() {
  const moved = Object.keys(HOME_PANELS).filter(k => k !== 'settings');
  return '<div class="home-sum"><div class="home-sum__t">被移动的全部 · ' + num(moved.length) + ' 项</div>'
    + '<div class="small dim">这些不含单人 / 群 / 平台分级，全部收在这一处。点一项进它那一页。</div>'
    + '<div class="home-list">' + moved.map(k => {
        const c = HOME_PANELS[k];
        return '<button class="home-list__row is-link" data-act="home-panel" data-panel="' + k + '"'
          + ' title="在人物列表这里打开 ' + esc(c.label) + ' 的' + (c.cls === 'both' ? '汇总 / 分开显示' : '汇总') + '">'
          + esc(c.label) + '<span class="dim">' + (c.cls === 'both' ? '汇总 + 分开' : '只有汇总') + '</span></button>';
      }).join('') + '</div>'
    + '<div class="home-sum__switches"><div class="small dim">总开关（全部 / 群 / 私聊）</div>'
    + '<button class="chip" data-act="chat-reply-toggle" title="一键关掉全部 / 群 / 私聊的回话">💤 回复总开关</button>'
    + '<button class="chip" data-act="chat-show-set" title="显示设置：字数上限 / 每页条数 / 上下文条数">⚙ 显示设置</button>'
    + '<button class="chip" data-act="chat-fb-open" title="兜底词池：按全部 / 群 / 私聊 / 某人 / 平台分别配">🛟 兜底</button></div></div>';
}
/* 分开显示：按单人 / 群 / 平台列，点一条只看这一条的相关内容 */
function htmlHomeSplit(id) {
  const cfg = HOME_PANELS[id] || {};
  const byConv = new Map();
  (S.chat.list || []).forEach(m => {
    const cv = chatConvOf(m);
    if (!cv || cv === '__all') return;
    if (!byConv.has(cv)) byConv.set(cv, {
      n: 0, name: m.convLabel || m.whoName || m.nick || cv,
      cls: m.convKind === 'group' ? 'group' : ((m.plat && m.plat !== 'qq') ? 'plat' : 'private'),
    });
    byConv.get(cv).n++;
  });
  const SEC = { private: '单人', group: '群', plat: '平台' };
  const arr = [...byConv.entries()].sort((a, b) =>
    ({ private: 0, group: 1, plat: 2 }[a[1].cls] - { private: 0, group: 1, plat: 2 }[b[1].cls]) || b[1].n - a[1].n);
  let last = '';
  return '<div class="home-split">' + arr.map(([cv, v]) => {
    const head = (SEC[v.cls] !== last) ? (last = SEC[v.cls], '<div class="rail-fly__sec">' + SEC[v.cls] + '</div>') : '';
    return head + '<button class="home-list__row is-link' + (S.home.splitKey === cv ? ' is-on' : '') + '"'
      + ' data-act="home-split-pick" data-conv="' + esc(cv) + '"'
      + ' title="只看 ' + esc(v.name) + ' 在这一项里的相关">'
      + esc(v.name) + '<span class="dim">' + num(v.n) + ' 条 · ' + esc(cfg.label || id) + '</span></button>';
  }).join('') + '</div>';
}

function htmlHomePanel() {
  const h = S.home, cfg = HOME_PANELS[h.panel] || HOME_PANELS.settings;
  const crumb = [esc(TITLES[RAIL.view] || '聊天记录')].concat(h.level.map(x => esc(x))).join(' <span>·</span> ');
  const tabs = cfg.cls === 'both'
    ? '<div class="home-panel__tabs">'
      + '<button class="home-tab' + (h.mode === 'sum' ? ' is-on' : '') + '" data-act="home-mode" data-mode="sum">汇总</button>'
      + '<button class="home-tab' + (h.mode === 'split' ? ' is-on' : '') + '" data-act="home-mode" data-mode="split">分开显示</button>'
      + '</div>' : '<div class="home-panel__only">只有汇总显示</div>';
  let body = h.mode === 'split' && cfg.cls === 'both' ? htmlHomeSplit(h.panel) : cfg.sum();
  if (!String(body).trim()) body = '<div class="home-empty">这一项暂时没有内容。'
    + '<button class="btn" data-act="home-drill" data-view="' + esc(cfg.view || '') + '">打开这一页看全部</button></div>';
  return '<aside class="home-panel" data-panel="' + esc(h.panel) + '">'
    + '<div class="home-panel__head"><span class="home-panel__crumb">' + crumb + '</span>'
    + '<button class="home-panel__x" data-act="home-close" title="关闭，恢复主视图（人物列表）">×</button></div>'
    + tabs
    + '<div class="home-panel__body">' + body + '</div></aside>';
}

/* ---------------------------------------------------------------------------
 * 接线
 * --------------------------------------------------------------------------- */
/* ===========================================================================
 * 四类 · 左栏唯一数据源（她 2026-11-16 定）
 * ---------------------------------------------------------------------------
 *   cls 1 = 只要汇总显示就无意义  → 不进左栏，只留在悬浮窗（当前提示词 / AI 思考 / AI 状态）
 *   cls 2 = 同时有全记录、和单人物记录 → 进左栏；一级＝该项全记录，点头像＝此人的该项
 *   cls 3 = 只有全记录、无人物分区   → 进左栏；只有一级，不给人物入口
 *   cls 4 = 其他不含改动操作（只读） → 收进「其他」一处，点开显示被收走的全部
 * page 一律指向真实页面 id：每一项点进去都是整页，不是空壳（上轮就是错在这里）。
 * =========================================================================== */
const RAIL_SPEC = [
  { id: 'stickers', label: '表情包', page: 'stickers' },
  { id: 'poop',     label: '搬屎',   page: 'poop' },
  /* 开关不占左栏：右下角 ⚙（#fabParam）打开参数浮层，开关 / 数值 / 触发词都在里面。
   * 其余页面（聊天记录 / 朋友录 / 机器人 …）连同页面文件一起删掉了。 */
];
const RAIL_BY = {};
RAIL_SPEC.forEach(x => { RAIL_BY[x.id] = x; });
const RAIL_IC = {
  stickers: '<path d="M4 5.5h16v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><circle cx="9" cy="10" r="1.1"/><circle cx="15" cy="10" r="1.1"/><path d="M9 14c1.6 1.2 4.4 1.2 6 0"/>',
  chat:    '<path d="M4.5 6.5h15v9h-8l-4 3v-3h-3z"/><path d="M8 10h8M8 12.8h5"/>',
  teach:   '<path d="M5 4.5h11l3 3V19H5z"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  friends: '<path d="M5 5.5h9a3 3 0 0 1 3 3V19H8a3 3 0 0 1-3-3z"/><path d="M17 8.5h2v10.5h-9"/>',
  bili:    '<rect x="4" y="6" width="16" height="13" rx="3"/><path d="M9 3.5 12 6l3-2.5M10 11l4 2.2-4 2.2z"/>',
  health:  '<path d="M12 19s-7-4.2-7-8.6A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.4C19 14.8 12 19 12 19z"/>',
  learn:   '<path d="M4.5 19V9M9.5 19V5.5M14.5 19v-6M19.5 19V8"/>',
  meme:    '<path d="M4 5.5h16v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><circle cx="9" cy="10" r="1.1"/><circle cx="15" cy="10" r="1.1"/><path d="M9 14c1.6 1.2 4.4 1.2 6 0"/>',
  persona: '<circle cx="12" cy="9" r="3.6"/><path d="M5 19.5c1.4-3.2 4-4.8 7-4.8s5.6 1.6 7 4.8"/>',
  reqs:    '<path d="M6 20V5.5l6 2.5 6-2.5V13l-6 2.5L6 13"/><path d="M9 10v4"/>',
  info:    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z"/><path d="M12 10.5v6M12 7.3h.01"/>',
  logic:   '<path d="M5 4.5h6v5H5zM13 14.5h6v5h-6z"/><path d="M8 9.5v5.5h5M13 17h-5"/>',
  logs:    '<path d="M6 4.5h9l3.5 3.5V19.5H6z"/><path d="M9 9.5h6M9 13h6M9 16.5h4"/>',
  files:   '<path d="M4.5 7.5 12 4l7.5 3.5V17L12 20.5 4.5 17z"/><path d="M4.5 7.5 12 11l7.5-3.5M12 11v9.5"/>',
  bot:     '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V5M9 13h.01M15 13h.01M9.5 16h5"/>',
  poop:    '<path d="M7 18h10M8.5 18v-3.2c0-1.4 1.1-2.3 2.2-2.9-1.6-.8-2.2-2.2-1.4-3.4.9-1.4 3.2-1.5 4.2-.2.7.9.5 2-.4 2.9 1.5.6 2.9 1.6 2.9 3.4V18"/>',
  qzone:   '<circle cx="12" cy="12" r="8"/><path d="M12 7.6l1.4 2.9 3.2.4-2.3 2.2.6 3.1-2.9-1.6-2.9 1.6.6-3.1-2.3-2.2 3.2-.4z"/>',
};

/* 左栏 DOM 由 RAIL_SPEC 生成：段标题 = 四类里的 2/3/4，cls 1 不出现在这里 */
function renderRail() {
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = RAIL_SPEC.map(x =>
    '<button class="nav-item" type="button" data-view="' + esc(x.id) + '" data-page="' + esc(x.page) + '">'
    + '<svg class="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
    + (RAIL_IC[x.id] || '') + '</g></svg>'
    + '<span class="nav-label">' + esc(x.label) + '</span>'
    + '<span class="nav-count" id="c-' + esc(x.id) + '">—</span>'
    + '</button>').join('');
}

/* 页面栈：只存「从哪一级进来的」，用来画面包屑与上一级；层级不封顶（她 11-14 原话） */
const PG = { stack: [] };

function goPage(id) {
  const s = RAIL_BY[id];
  if (!s) return;
  if (s.pre) s.pre();
  PG.stack = [{ id: id, label: s.label }];
  go(s.page);                       // 整页：走原有 render()，功能一条不丢
  pageHeadSync();
}

function pageUp() {
  /* 顺序：先退页内层级（约定 → 说话方式），再退人物页，最后回主页 */
  if (pageUpSub()) { render(); pageHeadSync(); return; }
  if (PG.person) {
    PG.person = null;
    if (PG.stack.length > 1) PG.stack.pop();
    const cur = PG.stack[PG.stack.length - 1];
    if (cur && RAIL_BY[cur.id]) go(RAIL_BY[cur.id].page);
    else { PG.stack = []; go('chat'); }
    pageHeadSync();
    return;
  }
  if (PG.stack.length > 1) {
    PG.stack.pop();
    const cur = PG.stack[PG.stack.length - 1];
    if (cur && RAIL_BY[cur.id]) go(RAIL_BY[cur.id].page);
    pageHeadSync();
    return;
  }
  PG.stack = [];
  go('chat');
  pageHeadSync();
}

/* 页内子层级（如 记录的 · 约定 · 说话方式）退一级：先退页内过滤，再退页面 */
function pageUpSub() {
  if (S.tab === 'teach') {
    if (S.teach.section && S.teach.section !== 'all') { S.teach.section = 'all'; return true; }
    if (S.teach.dir && S.teach.dir !== 'all') { S.teach.dir = 'all'; return true; }
  }
  if (S.tab === 'friends' && S.friends.zone && S.friends.zone !== 'all') { S.friends.zone = 'all'; return true; }
  return false;
}

/* 页内子层级 → 面包屑。只取真实存在的过滤状态，不编层级 */
function pageSubParts() {
  const out = [];
  if (S.tab === 'teach') {
    if (S.teach.dir && S.teach.dir !== 'all') out.push(String(S.teach.dir));
    if (S.teach.section && S.teach.section !== 'all') out.push(String(S.teach.section));
  }
  if (S.tab === 'friends' && S.friends.zone && S.friends.zone !== 'all') out.push(String(S.friends.zone));
  return out;
}

function pageHeadSync() {
  const head = $('#pageHead');
  if (head) head.hidden = true;
  return;
  const crumb = $('#pageCrumb'), up = $('#pageUp');
  if (!head || !crumb) return;
  const home = (S.tab === 'chat' && !PG.stack.length && !PG.person);
  head.hidden = home;
  if (home) { PG.stack = []; return; }
  const parts = ['主页'];
  if (PG.stack.length) PG.stack.forEach(x => parts.push(x.label));
  else if (S.tab !== 'chat') parts.push(TITLES[S.tab] || S.tab);
  pageSubParts().forEach(x => parts.push(x));
  crumb.innerHTML = parts.map((p, i) => (i ? '<span class="page-crumb__sep">›</span>' : '')
    + '<button class="page-crumb__b" type="button" data-act="crumb" data-i="' + i + '">' + esc(p) + '</button>').join('');
  if (up) up.hidden = (parts.length <= 1);
  /* 面包屑同时是「二级页入口」：点中间任一级就回到那一级 */
  crumb.querySelectorAll('[data-act="crumb"]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (i === 0) { PG.stack = []; PG.person = null; go('chat'); pageHeadSync(); return; }
      while (pageUpSub()) { /* 先把页内层级退干净 */ }
      PG.person = null;
      render(); pageHeadSync();
    });
  });
}

/* 第 4 类索引页：被收走的全部只读项都在这，点一个进它自己的整页 */
function htmlMorePage() {
  return `<div class="more-page">
    <div class="more-hint">这一类都只看不改，所以收在同一处，不各占左栏一个位置。点一项进它自己的页。</div>
    <div class="more-grid">${MORE_ITEMS.map(x => `<button class="more-card" type="button" data-act="more-open" data-id="${esc(x.id)}">
      <svg class="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${RAIL_IC[x.id] || ''}</g></svg>
      <span><span class="more-card__t">${esc(x.label)}</span><span class="more-card__s">${esc(x.desc)}</span></span>
    </button>`).join('')}</div>
  </div>`;
}

/* 点头像 → 此人单独这一项的整页（二级）。不是弹层、不是替换人物列表 */
function goPerson(conv, uid) {
  const cur = PG.stack.length ? PG.stack[PG.stack.length - 1]
    : { id: S.home.sel || S.tab, label: TITLES[S.tab] || '当前项' };
  const c = (S.chat.list || []).find(x => String(x.key || x.conv || x.id || '') === String(conv)) || {};
  PG.person = { conv: String(conv || ''), uid: String(uid || ''), pid: '' };
  PG.stack = [cur, { id: 'person', label: c.name || c.title || c.label || uid || '这个人' }];
  if (!S.chat.loaded) loadChat();
  if (!S.review.loaded) loadReview();
  if (!S.friends.loaded) loadFriends();
  S.tab = 'person';
  render(); pageHeadSync();
}

function htmlPersonPage() {
  const p = PG.person || {};
  const conv = p.conv, uid = p.uid;
  const F = S.friends.list || [];
  const f = F.find(x => (x.accounts || []).some(a => String(a.id) === uid))
    || F.find(x => String(x.pid || '') === String(p.pid || ''));
  const nm = (f && (f.label || f.name)) || uid || conv;
  const teach = (S.review.list || []).filter(x => x.rkind === 'teach'
    && ((uid && String(x.qq || '').replace(/^[a-z]+:/, '') === uid) || (f && String(x.pid || '') === String(f.pid))));
  return `<div class="person-page">
    <div class="pp-head">
      <div class="pp-name">${esc(nm)}</div>
      <div class="pp-sub">${esc(conv || '')}${f ? ' · 好感 ' + num(f.favor || 0) : ''}</div>
      <div class="pp-hint">这是这个人自己的页：下面每一块都只算他/她这一份。要回去看全部，点左上「上一级」。</div>
    </div>
    <div class="pp-sec"><div class="pp-t">约定</div>
      ${htmlChatPacts(conv) || '<div class="small dim">这个会话还没有约定。</div>'}</div>
    <div class="pp-sec"><div class="pp-t">话题</div>
      ${htmlChatTopics(conv) || '<div class="small dim">这个会话还没有话题。</div>'}</div>
    <div class="pp-sec"><div class="pp-t">记录的 · 他教过的 · ${num(teach.length)} 条</div>
      ${teach.length ? teach.map(x => htmlReviewCard(x)).join('') : '<div class="small dim">没有他教过的。</div>'}</div>
  </div>`;
}

function railInit() {
  const hot = $('#railHot'), rail = railEl(), fly = $('#railFly');
  if (!rail) return;
  renderRail();
  if (hot) {
    hot.addEventListener('mouseenter', railOpen);
    hot.addEventListener('click', railOpen);
  }
  rail.addEventListener('mouseenter', railFlyKeep);
  /* 只排延迟，不立刻隐藏二级菜单 —— 11-14 版就是这一句让二级目录永远点不到 */
  rail.addEventListener('mouseleave', () => { railClose(); RAIL.flyTimer = setTimeout(railFlyHide, 420); });
  rail.querySelectorAll('.nav-item').forEach((b, i) => {
    b.style.setProperty('--i', i);
    b.addEventListener('mouseenter', () => {
      /* 固定左栏下 RAIL.open 恒 false；原来那句 if(!RAIL.open)return 让二级永远弹不出来。
       * 她 11-17「慢慢来」：本轮只做朋友录碰出真实二级目录，其他入口保持单击进页。 */
      if (b.dataset.view !== 'friends') return;
      clearTimeout(RAIL.flyTimer);
      RAIL.view = b.dataset.view;
      RAIL.level = [];
      railFlyShow('friends', b);
    });
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      railFlyKeep();
      document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('is-on', x === b));
      S.home.sel = v;
      railClose(160);
      if (v === 'friends') S.friends.zone = 'all';   // 单击朋友录 = 查看全部
      go(b.dataset.page || v);                       // 其余入口照旧：平级整页
      railFlyHide();
      railTickTo();
    });
  });
  if (fly) {
    fly.addEventListener('mouseenter', railFlyKeep);
    fly.addEventListener('mouseleave', () => { RAIL.flyTimer = setTimeout(railFlyHide, 260); railClose(); });
    fly.addEventListener('click', e => {
      e.stopPropagation();
      const fz = e.target.closest('[data-fzone]');
      if (fz) {
        S.friends.zone = fz.dataset.fzone || 'all';
        railFlyHide(); railClose(120);
        go('friends');
        return;
      }
      const back = e.target.closest('[data-act="rail-back"]');
      if (back) { RAIL.level.pop(); railFlyShow(RAIL.view, document.querySelector('.nav-item[data-view="' + RAIL.view + '"]') || rail); return; }
      const av = e.target.closest('[data-act="rail-person"]');
      if (av) {
        const cv = av.dataset.conv || '';
        homeOpenPanel('pact', { level: [TITLES[RAIL.view] || RAIL.view, av.dataset.uid || '这个人', '约定'], splitKey: cv, conv: cv });
        railFlyHide(); railClose(120); return;
      }
      const row = e.target.closest('.rail-fly__row');
      if (!row) return;
      const kind = row.dataset.railKind, label = row.dataset.railLabel;
      if (kind === 'leaf') RAIL.pickedId = row.dataset.railId || '';
      if (kind === 'all') {
        RAIL.level = []; S.chat.conv = '__all'; S.chat.pinBottom = true;
        homeOpenPanel('pact', { level: [] });
      } else if (kind === 'conv') {
        RAIL.level.push(label);
        homeOpenPanel('pact', { level: RAIL.level.slice(), conv: row.dataset.railConv, splitKey: row.dataset.railConv });
        if (S.chat.conv !== row.dataset.railConv) { S.chat.conv = row.dataset.railConv; S.chat.pinBottom = true; render(); }
      } else if (kind === 'cat' || kind === 'dir') {
        RAIL.level.push(label);
        railFlyShow(RAIL.view, document.querySelector('.nav-item[data-view="' + RAIL.view + '"]') || rail);
        homeOpenPanel(kind === 'cat' && label === '约定' ? 'pact' : (label === '话题' ? 'topic' : 'pact'),
          { level: RAIL.level.slice() });
      } else {
        RAIL.level.push(label);
        homeOpenPanel('pact', { level: RAIL.level.slice() });
      }
      railFlyHide(); railClose(120);
    });
  }
  window.addEventListener('resize', () => { if (!RAIL.open) railTickTo(); });
  railTickTo();
}

/* 会话栏宽度：拖柄改 --conv-w，存 localStorage，下次打开还是上次调的 */
function chatSplitInit() {
  const wrap = view.querySelector('.chat-wrap');
  if (!wrap) return;
  let w = Number(localStorage.getItem('xuh.chat.convW') || 0);
  if (w >= 180 && w <= 520) { wrap.style.setProperty('--conv-w', w + 'px'); S.home.convW = w; }
  const bar = wrap.querySelector('.chat-split');
  if (!bar) return;
  bar.addEventListener('mousedown', e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = wrap.getBoundingClientRect().width && Number(getComputedStyle(wrap).getPropertyValue('--conv-w').replace('px','')) || 250;
    const move = ev => {
      const nw = Math.max(180, Math.min(520, w0 + ev.clientX - x0));
      wrap.style.setProperty('--conv-w', nw + 'px');
      S.home.convW = nw;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('xuh.chat.convW', String(S.home.convW || 250));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* 头像加载失败兜底（2026-11-16）：xuh://avatar/ 取不到图时把 <img> 摘掉，
 * 底下那一个首字方块照常显示。CSP 的 script-src 'self' 禁止内联 onerror，所以用捕获监听。 */
document.addEventListener('error', e => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && (t.classList.contains('conv-av__img') || t.classList.contains('rail-fly__photo'))) {
    t.remove();
  }
}, true);

/* 启动 */
loadSkin();
railInit();
paramInit();
/* 2026-11-14：默认页是聊天记录，而聊天记录的数据是「进这一页才懒加载」的
 * （见 go() 里的 loadChat）。启动时先按默认页走一遍路由，否则主页面会一直停在
 * 「读出聊天记录中…」——快照里没有聊天记录，没人去拉它。 */
go(S.tab);
loadSnapshot();

/* 启动参数 --tab=<页>：落完默认页再切过去（只在带了参数时生效） */
if (window.xuh && window.xuh.tabArg) {
  window.xuh.tabArg().then(function (r) {
    const t = r && r.tab;
    if (t && document.querySelector('.nav-item[data-view="' + t + '"]')) go(t);
  }).catch(function () {});
}

/* ---------------- 白天 / 夜晚切换 ----------------
 * 夜晚模式才挂雨夜玻璃（rain-night.js 看 html[data-theme] 自己启停）。
 * 状态存本地，下次打开还是上次选的；默认白天，不改变她现在的样子。 */
(function initThemeToggle() {
  const btn = $('#themeBtn');
  const root = document.documentElement;
  function paint(theme) {
    const night = theme === 'night';
    root.dataset.theme = night ? 'night' : 'day';
    if (btn) {
      btn.textContent = night ? '昼' : '夜';
      btn.title = night ? '切换回白天模式' : '切换到夜晚模式（含雨夜玻璃）';
    }
  }
  /* 打开时按「当下的钟点」定白天 / 夜晚，不再沿用上次关闭时的选择（她 2026-11-09 定）。
     06:00–17:59 算白天，其余算夜晚；其余状态照旧沿用上次。
     不读也不写本地：打开后手动切换只在本会话生效，下次打开仍按钟点来。 */
  const DAY_START = 6;
  const DAY_END = 18;
  function timeTheme() {
    const h = new Date().getHours();
    return (h >= DAY_START && h < DAY_END) ? 'day' : 'night';
  }
  paint(timeTheme());
  if (btn) btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'night' ? 'day' : 'night';
    paint(next);
  });
})();

/* ---------------- 开场入场动画（与主题切换完全解耦） ----------------
 * 目标：打开时看到一次 26px 上浮 + 淡入，昼夜都播；且绝不能出现「第一帧完整、下一帧才回跳」。
 * 两个前提：
 *   ① 第一帧就得停在起始态 —— 靠 index.html 上静态的 boot-hold（纯 CSS，不进动画时间轴，
 *      窗口藏多久都不会自己播完）；
 *   ② 换手必须同一帧完成 —— 同时摘 boot-hold、加 game-boot-anim，两组数值一致，视觉不跳。
 * 为什么还要等 visible：主进程 show:false 建窗、ready-to-show 才 show（main.js:156/163），
 * 而动画时间轴按真实时间走 —— 窗口还藏着时起动画，就是「看不见地播完」。
 * 为什么用 class 不用 data-theme：点「夜/昼」只换配色，绝不重播，位置一像素不动。
 * 单独成段而不塞进主题那段：万一主题逻辑抛错，这里仍会把 boot-hold 摘掉，
 * 不会把界面永远按在下移 + 半透明态。 */
(function initBootAnim() {
  const root = document.documentElement;
  let booted = false;
  function beginBoot() {
    if (booted) return;
    booted = true;
    root.classList.remove('boot-hold');
    root.classList.add('game-boot-anim');
    /* 兜底摘类：全场最晚一条是 .62s + .20s 延迟 = .82s，留裕量到 1.2s。
       实测很关键——渲染时钟若被冻住，动画会停在起始帧，靠它把界面还原。 */
    setTimeout(() => root.classList.remove('game-boot-anim'), 1200);
  }
  /* 双 rAF：等这一帧真的画出来（画出来的就是 boot-hold 起始态），下一帧再起动画。 */
  function armBoot() {
    if (booted) return;
    requestAnimationFrame(() => requestAnimationFrame(beginBoot));
  }
  if (document.visibilityState === 'visible') {
    armBoot();
  } else {
    document.addEventListener('visibilitychange', function onVis() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVis);
      armBoot();
    });
  }
  /* 兜底一：窗口拿到焦点 / 有任何输入也立刻起（覆盖 visibility 判定异常）。 */
  window.addEventListener('focus', armBoot, { once: true });
  window.addEventListener('pointerdown', armBoot, { once: true });
  /* 兜底二：10s 始终没起来就无条件放开定格 —— 绝不能把界面一直按在下移 + 半透明态。 */
  setTimeout(beginBoot, 10000);
})();

/* ===========================================================================
 * 保健提醒（2026-11-10 主人定）
 * 这是干什么的：这一页能看能改保健提醒的全部时间、数量、四个动作池，以及按人约定。
 * 数据只有一份：机器人端 src/config/features.json 的 healthRemind 段 + topics.jsonl 的单人约定。
 * 客户端不存第二份，全部走 window.xuh.api → 面板的 /api/healthremind，改完机器人热读、不用重启。
 * 事件全用 data-h* 前缀，单独委托，不碰其它页的 data-act 分支。
 * =========================================================================== */
const HR_POOLS = [
  { k: 'mainWork', name: '主池A · 上班久坐', hint: '工作日 14–22 点用这一组' },
  { k: 'mainRest', name: '主池B · 体态', hint: '其余时间、周六、法定节假日用这一组' },
  { k: 'extraWork', name: '补充池 · 上班场景', hint: '每周至少出现一次；可以加进两个主池' },
  { k: 'extraRest', name: '补充池 · 下班/休息场景', hint: '每周至少出现一次；可以加进两个主池' },
];
const HR_NUMS = [
  ['workStartHour', '上班时段开始', '点'], ['workEndHour', '上班时段结束', '点'],
  ['quietStartHour', '不提醒开始', '点'], ['quietEndHour', '不提醒结束', '点'],
  ['minGapMin', '两条之间最少隔', '分钟'], ['speakDelayMin', '他说话后等几分钟发', '分钟'],
  ['dailyMin', '一天至少', '条'],
  ['dailyMax', '一天最多', '条'], ['weeklyExtraMin', '每周至少补充池', '条'],
  ['delayMinMin', '「大概多久以后做」最小', '分钟'], ['delayMaxMin', '「大概多久以后做」最大', '分钟'],
  ['tickIntervalSec', '检查间隔', '秒'],
  ['holidayCacheDays', '节假日日历缓存', '天'],
];
const HR_WEEK = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];
// 可填范围（只用于输入校验与提示；聊天记录页「显示设置」那三组也复用这张表，不另写一份）
const HR_NUM_RANGE = {
  workStartHour: [0, 23], workEndHour: [0, 23], quietStartHour: [0, 24], quietEndHour: [0, 23],
  minGapMin: [1, 1440], speakDelayMin: [0, 1440], dailyMin: [0, 50], dailyMax: [0, 50], weeklyExtraMin: [0, 20],
  delayMinMin: [0, 1440], delayMaxMin: [0, 1440],
  tickIntervalSec: [1, 3600], holidayCacheDays: [1, 365],
};

async function loadHealth() {
  const soft = async (p) => { try { return await window.xuh.api('GET', p); } catch { return null; } };
  const r = await soft('/api/healthremind');
  if (!r || r.error) { toast('提醒配置读不出来：' + ((r && r.error) || '未知原因'), true); return; }
  S.health.cfg = r.cfg || {};
  S.health.people = r.people || [];
  const rr = await soft('/api/roco');
  if (rr && !rr.error) {
    S.health.roco = rr.cfg || {};
    S.health.rocoPeople = rr.people || [];
    S.health.rocoState = rr.state || {};
    S.health.bili = rr.bili || null;
    S.health.biliCfg = rr.biliCfg || {};
  }
  const rf = await soft('/api/fixedtags');
  if (rf && !rf.error) S.health.fixed = rf.people || [];
  // 闹钟（2026-11-24）：四组 + 配置，和保健/洛克同一页不同子类，不另存一份
  const ra = await soft('/api/alarms');
  if (ra && !ra.error) { S.health.alarm = ra.groups || null; S.health.alarmCfg = ra.cfg || {}; }
  S.health.loaded = true;
  S.health.del = null;
  render();
}

function hrPoolHtml(p) {
  const list = (S.health.cfg[p.k] || []);
  const rows = list.map((it, i) => `
    <div class="hr-act">
      <div class="hr-act-top">
        <input class="field hr-name" data-hact="${p.k}:${i}" value="${esc(it.act || '')}" aria-label="动作名">
        <button class="btn btn-quiet" data-hact-del="${p.k}:${i}">删动作</button>
      </div>
      ${p.k.indexOf('extra') === 0 ? `<div class="hr-act-foot">
        <button class="btn btn-quiet" data-hjoin="${p.k}:${i}:mainWork">加进主池A</button>
        <button class="btn btn-quiet" data-hjoin="${p.k}:${i}:mainRest">加进主池B</button>
      </div>` : ''}
    </div>`).join('');
  return `
  <details class="group" open>
    <summary>${esc(p.name)}<span class="cnt">${list.length} 个动作</span></summary>
    <div class="hr-pool-note">${esc(p.hint)}</div>
    ${rows || '<div class="empty">这一池还是空的。</div>'}
    <div class="hr-add">
      <input class="field" id="hr-new-${p.k}" placeholder="新动作名，比如：靠墙静蹲" aria-label="新动作名">
      <button class="btn" data-hact-add="${p.k}">+ 新增动作</button>
    </div>
  </details>`;
}

/* 提醒页的两个子类（2026-11-21 主人定：「保健提醒」改成「提醒」的子类）。
 * 左栏只有「提醒」一个入口；点进来先选子类，改的还是各自原来那份配置。 */
function reminderTabs() {
  const t = ['health', 'alarm', 'roco'].indexOf(S.health.tab) >= 0 ? S.health.tab : 'health';
  return `<div class="meme-tabbar" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">`
    + `<button class="meme-tab ${t === 'health' ? 'is-on' : ''}" data-htab="health">保健提醒</button>`
    + `<button class="meme-tab ${t === 'alarm' ? 'is-on' : ''}" data-htab="alarm">闹钟</button>`
    + `<button class="meme-tab ${t === 'roco' ? 'is-on' : ''}" data-htab="roco">洛克王国</button>`
    + `</div><div class="small dim" style="margin:0 0 12px">「提醒」下面按子类分开：保健提醒（到点活动身体）、闹钟（她答应过的事，到点自己去兑现）、洛克王国（远行商人到货）。</div>`;
}

/* 闹钟页（2026-11-24）：她自己承诺 → 自己定时 → 到点兑现。
 * 四组：待兑现 / 已兑现 / 失败 / 太久不定。每条写全来源：平台·群/人·内容·承诺时间·到期时间。
 * 数据在服务端 src/data/alarms.json 唯一一份，这里只读展示 + 显式改状态/手加/删。 */
function alarmTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '没写';
  const d = new Date(n);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function alarmRow(x, group) {
  const where = esc(x.platform || 'qq') + ' · ' + esc(x.scope || '没记来源') + (x.who ? ' · ' + esc(x.who) : '');
  const title = esc(x.content || x.text || '（没写内容）');
  const raw = x.fallback ? '<span class="small" style="color:#b46">（原话没给时间，兜底 ' + esc(x.dueRaw || '') + '）</span>' : '';
  let acts = '';
  if (group === 'pending') acts = `<button class="btn btn-quiet" data-adone="${esc(x.id)}">标完成</button> <button class="btn btn-quiet" data-afail="${esc(x.id)}">标失败</button>`;
  else acts = `<button class="btn btn-quiet" data-apending="${esc(x.id)}">放回待兑现</button>`;
  return `<div class="hr-act" style="margin-bottom:8px">
    <div class="hr-act-top"><strong>${title}</strong><span class="small dim">${esc(x.id)}</span></div>
    <div class="small dim" style="margin:3px 0">${where}</div>
    <div class="small">承诺 ${esc(alarmTime(x.createdAt))} · 到期 ${esc(alarmTime(x.dueAt))} ${raw}</div>
    ${x.note ? '<div class="small dim">' + esc(x.note) + '</div>' : ''}
    <div class="me-acts" style="margin-top:6px">${acts}<button class="btn btn-danger" data-adel="${esc(x.id)}">删</button></div>
  </div>`;
}
function htmlAlarms() {
  const g = S.health.alarm || { pending: [], done: [], failed: [], too_far: [] };
  const c = S.health.alarmCfg || {};
  const groups = [
    ['pending', '待兑现', g.pending || []],
    ['done', '已兑现', g.done || []],
    ['failed', '失败 / 过时', g.failed || []],
    ['too_far', '太久 · 不定', g.too_far || []],
  ];
  const body = groups.map(([key, name, rows]) => `
    <details class="group" ${key === 'pending' ? 'open' : ''}>
      <summary>${esc(name)}<span class="cnt">${rows.length} 条</span></summary>
      <div class="hr-pool-note">${key === 'too_far' ? '超过上限（默认 6 个月）的，记下来但不定闹钟。' : key === 'failed' ? '到点没发出去、或超时没发的，归这里。' : ''}</div>
      ${rows.map(x => alarmRow(x, key)).join('') || '<div class="empty">这一组还是空的。</div>'}
    </details>`).join('');
  const na = S.health.alarmNew || {};
  return `
  <div class="sheet">
    <div class="sheet-head"><h2>提醒 · 闹钟</h2><span class="hint">她答应过的事，到点自己去兑现；改完即时生效</span></div>
    <div class="sheet-body">
      <div class="hr-note">她发的话里带承诺（「等16分钟提醒你们」「回头查到了再跟你说」）就会自己记一条闹钟。
        没给时间的按兜底时长设；超过 <strong>${esc(c.maxDays == null ? 180 : c.maxDays)} 天</strong>的不定，单独归「太久 · 不定」。
        每条都写明是哪个平台、哪个群/人、答应了什么、什么时候。到点她自己发一句兑现回原处，发不出去或超时归「失败」。</div>
    </div>
  </div>
  <div class="sheet">
    <div class="sheet-head"><h2>设置</h2><span class="hint">机器人热读，不用重启</span></div>
    <div class="sheet-body">
      <div class="me-grid">
        <label class="me-f"><span>总开关（关掉就不再记新闹钟）</span>
          <button class="toggle" data-atoggle aria-pressed="${c.enabled !== false}"></button></label>
        <label class="me-f"><span>上限天数（超过就不定，默认180＝6个月）</span>
          <input class="field mono" data-anum="maxDays" type="number" step="1" value="${esc(c.maxDays == null ? 180 : c.maxDays)}"></label>
        <label class="me-f"><span>没给时间时兜底（小时）</span>
          <input class="field mono" data-anum="fallbackHours" type="number" step="1" value="${esc(c.fallbackHours == null ? 24 : c.fallbackHours)}"></label>
        <label class="me-f"><span>轮询秒数</span>
          <input class="field mono" data-anum="tickSec" type="number" step="1" value="${esc(c.tickSec == null ? 30 : c.tickSec)}"></label>
        <label class="me-f"><span>超时小时（过了还没发出去算失败）</span>
          <input class="field mono" data-anum="overdueHours" type="number" step="1" value="${esc(c.overdueHours == null ? 48 : c.overdueHours)}"></label>
      </div>
      <div class="me-acts" style="margin-top:8px"><button class="btn btn-primary" data-asave>保存设置</button></div>
    </div>
  </div>
  <div class="sheet">
    <div class="sheet-head"><h2>手动加一条</h2><span class="hint">不写到期时间就按上面的兜底时长</span></div>
    <div class="sheet-body">
      <label class="me-f"><span>答应了什么</span><input class="field" data-anew="content" value="${esc(na.content || '')}" placeholder="比如：明天把攻略整理好"></label>
      <label class="me-f"><span>到期时间（本地时间，如 2026-11-25 15:30；留空＝兜底）</span><input class="field" data-anew="dueAt" value="${esc(na.dueAt || '')}" placeholder="2026-11-25 15:30"></label>
      <label class="me-f"><span>来源群号 / 私聊号（可留空）</span><input class="field mono" data-anew="scope" value="${esc(na.scope || '')}" placeholder="群858455686"></label>
      <label class="me-f"><span>谁的（可留空）</span><input class="field" data-anew="who" value="${esc(na.who || '')}"></label>
      <div class="me-acts" style="margin-top:8px"><button class="btn" data-aadd>加上</button></div>
    </div>
  </div>
  <div class="sheet">
    <div class="sheet-head"><h2>清单</h2></div>
    <div class="sheet-body flush">${body}</div>
  </div>`;
}

function htmlRoco() {
  const c = S.health.roco || {};
  const ppl = S.health.rocoPeople || [];
  const st = S.health.rocoState || {};
  const pv = S.health.rocoPreview;
  const on = c.enabled !== false;
  const watch = (c.watchItems || []).join('、');
  // 稀有度排名：配置里有就用配置，没有就用默认（棱镜球 3 > 祝福项坠 2 > 炫彩蛋 1）
  const rareMap0 = (c.rarity && typeof c.rarity === 'object' && Object.keys(c.rarity).length)
    ? c.rarity : { '棱镜球': 3, '祝福项坠': 2, '炫彩蛋': 1 };
  const unlocked = (qq, tag) => S.health.unlockKey === qq + '|' + tag && Date.now() < S.health.unlockExp;
  const rows = ppl.map(p => `
    <div class="hr-person">
      <div class="hr-person-top"><strong>${esc(p.name || p.qq)}</strong><span class="small dim">${esc(p.qq)}</span></div>
      <div class="small dim">固定标签：${esc((p.tags || []).join('、') || '无')}</div>
      <label class="hr-check"><input type="checkbox" data-rp-on="${esc(p.qq)}" ${p.accepted ? 'checked' : ''}>接受这个提醒（关掉就不再 @ 他）</label>
      <div class="hr-person-foot"><span class="small dim">${p.accepted ? '已接受' : '没接受，不会 @'}</span></div>
    </div>`).join('');
  const fixedPeople = (S.health.fixed || []).map(p => `
    <div class="hr-person">
      <div class="hr-person-top"><strong>${esc(p.name || p.qq || '')}</strong><span class="small dim">${esc(p.qq || '')}</span></div>
      <div class="hr-checks">${(p.tags || []).map(t => `<span class="hr-check">${esc(t.tag)}
        <button class="btn btn-quiet" data-ftag-del="${esc(p.qq || '')}|${esc(t.tag)}">${unlocked(p.qq, t.tag) ? '再点一次确认取消' : '取消'}</button></span>`).join('')}</div>
    </div>`).join('');
  const pvHtml = pv ? `
    <div class="hr-note">
      ${pv.error ? '预览失败：' + esc(pv.error) : `
      本轮：第 ${esc(pv.round == null ? '?' : pv.round)} 轮（${esc(pv.startedAt || '')}）${pv.stale ? ' · 数据源标记过期' : ''}<br>
      在售：${esc((pv.items || []).map(x => x.name).join('、') || '空')}<br>
      命中要提醒的：${esc((pv.hits || []).join('、') || '无')}　·　将 @：${esc((pv.uids || []).join('、') || '无')}<br>
      ${pv.body ? '发出去会是这样：' + esc(pv.body) : ''}`}
    </div>` : '';
  const bl = S.health.bili || {};
  const bc = S.health.biliCfg || {};
  const bTask = bl.task || null;
  const rareMap = (bl.rarity || c.rarity || { '棱镜球': 3, '祝福项坠': 2, '炫彩蛋': 1 });
  const rarityLine = Object.keys(rareMap).sort((a, b) => (rareMap[b] || 0) - (rareMap[a] || 0))
    .map(k => k + '(' + rareMap[k] + ')').join(' > ');
  const tierOpts = [['A', 'A：粉丝和其他视频都过万'], ['B', 'B：粉丝/播放任一过万（默认）'], ['C', 'C：不筛，谁都发']]
    .map(([v, t]) => `<option value="${v}" ${String(bc.minTier || 'B').toUpperCase() === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const biliHtml = `
  <div class="sheet">
    <div class="sheet-head"><h2>B站评论区提醒</h2><span class="hint">棱镜球 / 祝福项坠 / 炫彩蛋轮次跑：一轮 4 小时只在前 3.5 小时发；前 2 小时只发过万 UP，之后小 UP 也发、把额度花满。从新到旧留言，不@人；只发手游内容，页游不发</span></div>
    <div class="sheet-body">
      ${bTask ? `<div class="hr-note">这次任务：第 ${esc(bTask.round == null ? '?' : bTask.round)} 轮 · 「${esc(bTask.item || '未知商品')}」（${bTask.slot === 'common' ? '普通' : '稀有'}）· 窗口 ${esc(new Date(bTask.windowStart).toLocaleString('zh-CN'))} → ${esc(new Date(bTask.windowEnd).toLocaleString('zh-CN'))}<br>
        已发 ${esc((bTask.counts && bTask.counts.sent) || 0)} 条（轮上限 ${esc(bl.maxPerRound || 10)}）· 今天稀有 ${esc(bl.todayRare || 0)}/${esc(bl.maxRarePerDay || 10)}、普通 ${esc(bl.todayCommon || 0)}<br>
        ${Date.now() >= (bTask.stageAEnd || 0) ? '现在：后 1.5 小时，小 UP 也发（把额度花满）' : '现在：前 2 小时，只发粉丝 / 其他视频过万的 UP'}</div>`
      : '<div class="hr-note">现在没有 B站 任务。棱镜球 / 祝福项坠 / 炫彩蛋那一轮被抓到时会自动安排。</div>'}
      <div class="small dim">稀有度（数字越大越稀有）：${esc(rarityLine)}。稀有每天走独立额度（默认 ${esc(bc.maxRarePerDay == null ? 10 : bc.maxRarePerDay)} 条，不受每天总数限制）：普通发满 10 条后，稀有照样再发 10 条（突破额度）；反过来稀有发满 10 条后，普通（炫彩蛋）这一轮一条都不发。</div>
      <div class="small dim">节奏：评论间隔 150~240 秒随机，每轮 ≤${esc(bl.maxPerRound || 10)} 条；撞到 B站 风控码（12014 CD、12040 相似内容过多、12028 垃圾评论、-509 / -412）立刻整轮停。${bl.lastResult ? '上次：' + esc(bl.lastResult) : ''}</div>
      <div class="small dim">标签判据：带「${esc(((bl.tags && bl.tags.mobile) || ['洛克王国：世界', '洛克王国世界']).join('」「'))}」的直接发；只有「${esc(((bl.tags && bl.tags.weak) || ['洛克王国世界激励计划']).join('」「'))}」的算弱判据，必须 UP 粉丝 ≥${esc((bl.tags && bl.tags.weakFansMin) || 10000)} 且标题/简介不带页游字样才发；带「${esc(((bl.tags && bl.tags.block) || ['页游']).join('」「'))}」字样的一律不发（「洛克王国」两边都在用，不算判据）。已查过 ${esc((bl.tags && bl.tags.checked) || 0)} 条视频的标签。</div>
      <div class="small dim">挑 UP：发送数量有限，粉丝 ≥${esc((bl.pick && bl.pick.preferFansMin) || 10000)} 且其他视频有 ≥${esc((bl.pick && bl.pick.preferPlayMin) || 10000)} 播放的排最前，其次任一达标；QQ 群里的 @ 不筛这个。已存 ${esc((bl.pick && bl.pick.ups) || 0)} 个 UP 的粉丝/播放。</div>
      <div class="small dim">被回复：${esc((bl.repliers && bl.repliers.count) || 0)} 个人已按 B站 账号录入人物表（只补昵称，不改已有的名字）。回评：今天 ${esc((bl.repliers && bl.repliers.today) || 0)}/${esc((bl.repliers && bl.repliers.maxPerDay) || 8)} 条，每天上限、间隔 ≥${esc(bc.replyGapSec == null ? 300 : bc.replyGapSec)} 秒；问「主人是谁」时顺带 @${esc((bl.repliers && bl.repliers.masterAt) || '@虚幻的生物')}。${bl.repliers && bl.repliers.lastResult ? '上次：' + esc(bl.repliers.lastResult) : ''}</div>
      <div class="me-grid">
        <label class="me-f"><span>每轮上限（条）</span><input class="field mono" data-bnum="maxPerRound" type="number" value="${esc(bc.maxPerRound == null ? 10 : bc.maxPerRound)}"></label>
        <label class="me-f"><span>每天上限（条，普通商品吃这个）</span><input class="field mono" data-bnum="maxPerDay" type="number" value="${esc(bc.maxPerDay == null ? 10 : bc.maxPerDay)}"></label>
        <label class="me-f"><span>稀有每天上限（条）</span><input class="field mono" data-bnum="maxRarePerDay" type="number" value="${esc(bc.maxRarePerDay == null ? 10 : bc.maxRarePerDay)}"></label>
      </div>
      <div class="me-grid">
        <label class="me-f"><span>间隔最小（秒）</span><input class="field mono" data-bnum="gapSecMin" type="number" value="${esc(bc.gapSecMin == null ? 150 : bc.gapSecMin)}"></label>
        <label class="me-f"><span>间隔最大（秒）</span><input class="field mono" data-bnum="gapSecMax" type="number" value="${esc(bc.gapSecMax == null ? 240 : bc.gapSecMax)}"></label>
        <label class="me-f"><span>弱判据粉丝门槛</span><input class="field mono" data-bnum="weakTagFansMin" type="number" value="${esc(bc.weakTagFansMin == null ? 10000 : bc.weakTagFansMin)}"></label>
        <label class="me-f"><span>UP 粉丝门槛（排档）</span><input class="field mono" data-bnum="preferFansMin" type="number" value="${esc(bc.preferFansMin == null ? 10000 : bc.preferFansMin)}"></label>
        <label class="me-f"><span>其他视频播放门槛</span><input class="field mono" data-bnum="preferPlayMin" type="number" value="${esc(bc.preferPlayMin == null ? 10000 : bc.preferPlayMin)}"></label>
        <label class="me-f"><span>发到哪一档</span><select class="field" data-bsel="minTier">${tierOpts}</select></label>
        <label class="me-f"><span>被回复后回一句</span><select class="field" data-bbool="replyEnabled"><option value="1"${bc.replyEnabled !== false ? ' selected' : ''}>回（有人味，不装 AI）</option><option value="0"${bc.replyEnabled === false ? ' selected' : ''}>不回</option></select></label>
        <label class="me-f"><span>回评每天上限（条）</span><input class="field mono" data-bnum="replyMaxPerDay" type="number" value="${esc(bc.replyMaxPerDay == null ? 8 : bc.replyMaxPerDay)}"></label>
        <label class="me-f"><span>回评间隔（秒）</span><input class="field mono" data-bnum="replyGapSec" type="number" value="${esc(bc.replyGapSec == null ? 300 : bc.replyGapSec)}"></label>
      </div>
      <div class="me-acts">
        <button class="btn btn-quiet" data-bili-save>保存设置</button>
        <button class="btn btn-quiet" data-bili-scan ${S.health.biliBusy ? 'disabled' : ''}>只看候选（不发）</button>
        <button class="btn btn-quiet" data-bili-run ${S.health.biliBusy ? 'disabled' : ''}>现在跑一跳（会真发）</button>
        <button class="btn btn-quiet" data-bili-stop>停掉这次任务</button>
      </div>
      ${S.health.biliScan ? `<div class="hr-note">${S.health.biliScan.error ? '出错了：' + esc(S.health.biliScan.error) : ('窗口内查了 ' + esc(S.health.biliScan.checked || 0) + ' 条，能发 ' + esc(S.health.biliScan.count) + ' 条（门槛 ' + esc(S.health.biliScan.minTier || 'B') + ' 档）：<br>' + (S.health.biliScan.items || []).map(x => esc(x.pub + ' · ' + x.title.slice(0, 26) + ' · ' + x.author) + (x.tier ? ' · ' + esc(x.tier) + ' 档 · 粉丝 ' + esc(x.fans || 0) + ' · 最高播放 ' + esc(x.maxPlay || 0) : '') + ' · ' + (x.pass ? '<b>发</b>（' + esc(x.why) + '）' : '<span class="dim">不发（' + esc(x.why) + '）</span>')).join('<br>'))}</div>` : ''}
    </div>
  </div>`;
  return `
  <div class="sheet">
    <div class="sheet-head"><h2>提醒 · 洛克王国</h2><span class="hint">远行商人一天四轮（8/12/16/20 点），每轮只在 +5、+35 分查一次；本轮的 4 小时内没发成会一直补，过点不补</span></div>
    <div class="sheet-body">
      <div class="row">
        <span class="grow"><strong>总开关</strong><div class="small dim">关掉就不查也不发；固定标签不受影响</div></span>
        <button class="toggle" data-rtoggle aria-pressed="${on}" aria-label="洛克王国远行商人总开关"></button>
      </div>
      <div class="hr-note">@ 谁不是写死的：发之前现查「固定标签＝${esc(c.tag || '洛克王国')}」的持有人，再筛掉没接受 / 自己关掉的人。想加人就在下面直接加固定标签，再由本人接受。</div>
      <div class="me-grid">
        <label class="me-f"><span>发到群号</span><input class="field mono" data-rnum="groupId" type="number" value="${esc(c.groupId == null ? '' : c.groupId)}"></label>
        <label class="me-f"><span>每轮查的分钟点（一天只四轮，逗号隔开）</span><input class="field mono" data-rlist="offsetsMin" value="${esc((c.offsetsMin || [5, 35]).join(','))}"></label>
        <label class="me-f"><span>没发成的补发间隔（秒，窗口内才补）</span><input class="field mono" data-rnum="retrySec" type="number" value="${esc(c.retrySec == null ? 300 : c.retrySec)}"></label>
      </div>
      <label class="me-f"><span>要盯的商品（逗号或顿号隔开，名字含就算）</span><input class="field" data-rwatch value="${esc(watch)}"></label>
      <div class="small dim">稀有度（数字越大越稀有，B站 那条线按它分每天的额度）：${esc(Object.keys(rareMap0).sort((a, b) => (rareMap0[b] || 0) - (rareMap0[a] || 0)).map(k => k + '(' + rareMap0[k] + ')').join(' &gt; '))}。稀有每天独立额度、普通只在稀有没发满时才发；群里的 @ 不按稀有度筛人。</div>
      <label class="me-f"><span>标签词（@ 名单按这个词查固定标签）</span><input class="field" data-rstr="tag" value="${esc(c.tag || '洛克王国')}"></label>
      <label class="me-f"><span>数据源（公开 JSON）</span><input class="field mono" data-rstr="dataUrl" value="${esc(c.dataUrl || '')}"></label>
      <div class="me-acts">
        <button class="btn btn-quiet" data-rcheck ${S.health.rocoBusy ? 'disabled' : ''}>${S.health.rocoBusy ? '查询中…' : '现在查一次（只看不发）'}</button>
        <button class="btn btn-primary" data-rsave>保存设置</button>
      </div>
      ${pvHtml}
      ${st.lastSentAt ? `<div class="small dim">上次真发：${esc(new Date(st.lastSentAt).toLocaleString('zh-CN'))} · ${esc(st.lastResult || '')}</div>` : ''}
    </div>
  </div>
  ${biliHtml}

  <div class="sheet">
    <div class="sheet-head"><h2>谁会收到</h2><span class="hint">固定标签持有人 + 本人接受</span></div>
    <div class="sheet-body">${rows || '<div class="empty">还没有人带「' + esc(c.tag || '洛克王国') + '」固定标签。在下面加。</div>'}</div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>固定标签</h2><span class="hint">主人可直接加；取消只有本人原话能删，面板取消要先解锁一次</span></div>
    <div class="sheet-body">
      <div class="hr-note">固定标签不会被模型猜、也不会被自动抽取删掉。本人在聊天里说「我不玩 X 了 / 不喜欢 X 了」才会取消。</div>
      ${fixedPeople || '<div class="empty">还没有固定标签。</div>'}
      <div class="hr-sub">直接加一条</div>
      <div class="me-grid">
        <label class="me-f"><span>QQ 号</span><input class="field mono" id="ft-new-qq" placeholder="比如 3060185965"></label>
        <label class="me-f"><span>标签词</span><input class="field" id="ft-new-tag" placeholder="比如 洛克王国"></label>
      </div>
      <label class="me-f"><span>名字（可不填）</span><input class="field" id="ft-new-name" placeholder="方便认人"></label>
      <div class="me-acts"><button class="btn btn-primary" data-ftag-add>加固定标签</button></div>
    </div>
  </div>`;
}

function htmlHealth() {
  const tabs = reminderTabs();
  if (S.health.tab === 'alarm') return tabs + htmlAlarms();
  if (S.health.tab === 'roco') return tabs + htmlRoco();
  const c = S.health.cfg || {};
  const on = c.enabled !== false;
  const wd = (c.workdays || []).map(String);
  const nums = HR_NUMS.map(([k, n, unit]) => `
    <label class="me-f"><span>${esc(n)}（${esc(unit)}）</span>
      <input class="field mono" data-hnum="${k}" type="number" step="1" value="${esc(c[k] == null ? '' : c[k])}">
    </label>`).join('');
  const week = HR_WEEK.map(([v, n]) => `
    <label class="hr-check"><input type="checkbox" data-hweek="${v}" ${wd.indexOf(v) >= 0 ? 'checked' : ''}>${n}</label>`).join('');
  const people = (S.health.people || []).map(p => {
    const ov = p.override || {};
    return `
    <div class="hr-person">
      <div class="hr-person-top">
        <strong>${esc(p.name)}</strong>
        <span class="small dim">${esc(p.qq || '没配 QQ 号')}</span>
      </div>
      <label class="hr-check"><input type="checkbox" data-hp-on="${esc(p.key)}" ${ov.enabled === false ? '' : 'checked'}>对他提醒（约定高于上面的总开关）</label>
      <label class="me-f"><span>这次改动说明</span>
        <input class="field" data-hp-note="${esc(p.key)}" value="${esc(S.health.pactNote[p.key] || '')}" placeholder="比如：欧尼酱说下午别提醒他">
      </label>
      <div class="hr-person-foot">
        <span class="small dim">${ov.changes && ov.changes.length ? '上次改了：' + esc(ov.changes.join('；')) : '还没提过要求'}</span>
        <button class="btn btn-primary" data-hp-save="${esc(p.key)}">记成约定（只对这一人）</button>
      </div>
    </div>`;
  }).join('');
  return tabs + `
  <div class="sheet">
    <div class="sheet-head"><h2>提醒 · 保健提醒</h2><span class="hint">改完点最底下「保存」；机器人热读，不用重启</span></div>
    <div class="sheet-body">
      <div class="row">
        <span class="grow"><strong>总开关</strong><div class="small dim">关掉就一条都不发（某人自己的约定仍优先）</div></span>
        <button class="toggle" data-htoggle aria-pressed="${on}" aria-label="保健提醒总开关"></button>
      </div>
      <div class="hr-note">工作日＝周一到周五 + <strong>周日</strong>（欧尼酱周日上班），且不是法定节假日；工作日 14–22 点用主池A，其余时间用主池B；每天 4–9 点完全不提醒。每条提醒是「@两人 + 这一跳选中的动作」，<strong>这句话由人设当场生成</strong>（走一次普通模型会话），不存预写话术。</div>
    </div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>时间与数量</h2><span class="hint">全部可改</span></div>
    <div class="sheet-body">
      <div class="me-grid">${nums}</div>
      <div class="hr-sub">算工作日的七天</div>
      <div class="hr-checks">${week}</div>
      <label class="hr-check"><input type="checkbox" data-hmakeup ${String(c.makeupAsWorkday) === '1' ? 'checked' : ''}>调休补班日也算工作日（默认关，照字面按周六/周日走）</label>
      <div class="hr-sub">@ 谁、发到哪个群</div>
      <label class="me-f"><span>发到群号（0 = 跟随 connect.json 的测试群）</span>
        <input class="field mono" data-hnum="groupId" type="number" step="1" value="${esc(c.groupId == null ? 0 : c.groupId)}"></label>
      <label class="me-f"><span>@ 的人（填 connect.json 里的键名，逗号隔开；masterQQ＝主人、oniiQQ＝欧尼酱）</span>
        <input class="field mono" data-hat value="${esc((c.atKeys || []).join(', '))}"></label>
      <div class="hr-sub">法定节假日日历（公开 JSON 接口，断网按星期）</div>
      <label class="me-f"><span>主接口</span><input class="field mono" data-hstr="holidayUrl" value="${esc(c.holidayUrl || '')}"></label>
      <label class="me-f"><span>备用接口</span><input class="field mono" data-hstr="holidayBackupUrl" value="${esc(c.holidayBackupUrl || '')}"></label>
    </div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>四个动作池</h2><span class="hint">这里只填「做什么动作」；怎么说这句话由人设当场生成，这里不写话术</span></div>
    <div class="sheet-body flush">${HR_POOLS.map(hrPoolHtml).join('')}</div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>按人约定</h2><span class="hint">约定高于上面的开关，只对这一人生效，不影响另一个人</span></div>
    <div class="sheet-body">${people || '<div class="empty">读不到人，检查 connect.json 里的 masterQQ / oniiQQ。</div>'}</div>
  </div>

  <div class="sheet">
    <div class="sheet-head"><h2>保存</h2></div>
    <div class="sheet-body">
      <label class="me-f"><span>这次改动说明（会记进写入日志）</span>
        <input class="field" data-hnote value="${esc(S.health.note || '')}" placeholder="比如：把间隔改成 40 分钟"></label>
      <div class="me-acts">
        <button class="btn btn-primary" data-hsave>保存全部设置</button>
        <button class="btn btn-quiet" data-hreload>放弃改动、重新读</button>
      </div>
    </div>
  </div>

  ${S.health.del ? `<div class="hr-modal" data-hmodal>
    <div class="hr-modal-box">
      <h3>删掉「${esc(S.health.del.name)}」？</h3>
      <p>这个动作和它的全部说法会从这一池移除，点「保存全部设置」之后才真删。</p>
      <div class="me-acts"><button class="btn btn-danger" data-hdel-ok>删掉</button><button class="btn btn-quiet" data-hdel-no>取消</button></div>
    </div></div>` : ''}`;
}

/* 保健提醒页的事件：单独委托，前缀 data-h*，不干扰其它页 */
view.addEventListener('change', e => {
  const t = e.target;
  if (!t.dataset) return;
  // 闹钟子类（2026-11-24）：配置在 S.health.alarmCfg，先攒着，点「保存设置」才写回
  if (t.dataset.anum) {
    const ac = S.health.alarmCfg || (S.health.alarmCfg = {});
    const n = Number(t.value);
    if (Number.isFinite(n)) ac[t.dataset.anum] = n;
    return;
  }
  if (t.dataset.anew) {
    const an = S.health.alarmNew || (S.health.alarmNew = {});
    an[t.dataset.anew] = t.value;
    return;
  }
  // 洛克王国子类（2026-11-21）：配置在 S.health.roco，和保健那份分开
  if (t.dataset.rnum) {
    const rc = S.health.roco || (S.health.roco = {});
    const n = Number(t.value);
    if (Number.isFinite(n)) rc[t.dataset.rnum] = n;
    return;
  }
  if (t.dataset.bnum) {
    const bc = S.health.biliCfg || (S.health.biliCfg = {});
    const n = Number(t.value);
    if (Number.isFinite(n)) bc[t.dataset.bnum] = n;
    return;
  }
  // 2026-11-22：开关型下拉（1/0）
  if (t.dataset.bbool) {
    const bc = S.health.biliCfg || (S.health.biliCfg = {});
    bc[t.dataset.bbool] = String(t.value) === '1';
    return;
  }
  // 2026-11-21：发到哪一档（A/B/C）是个下拉，不是数字
  if (t.dataset.bsel) {
    const bc = S.health.biliCfg || (S.health.biliCfg = {});
    bc[t.dataset.bsel] = String(t.value || 'B').toUpperCase();
    return;
  }
  if (t.dataset.rstr) { const rc = S.health.roco || (S.health.roco = {}); rc[t.dataset.rstr] = String(t.value || ''); return; }
  if (t.dataset.rlist) {
    const rc = S.health.roco || (S.health.roco = {});
    rc[t.dataset.rlist] = String(t.value || '').split(/[,，、\s]+/).map(x => Number(x)).filter(n => Number.isFinite(n));
    return;
  }
  if (t.dataset.rwatch) {
    const rc = S.health.roco || (S.health.roco = {});
    rc.watchItems = String(t.value || '').split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean);
    return;
  }
  if (t.dataset.rpOn) {
    const qq = t.dataset.rpOn, on = !!t.checked;
    const p = (S.health.rocoPeople || []).find(x => x.qq === qq) || {};
    (async () => {
      const r = await window.xuh.api('POST', '/api/roco/pact', { qq, enabled: on, name: p.name || qq, note: '面板设置远行商人提醒' });
      if (!r || r.error) { toast('没记成：' + ((r && r.error) || '未知原因'), true); t.checked = !on; return; }
      toast(on ? '已接受，远行商人会 @ 他' : '已关掉，不再 @ 他');
      loadHealth();
    })();
    return;
  }
  const c = S.health.cfg; if (!c) return;
  if (t.dataset.hnum) { const n = Number(t.value); if (Number.isFinite(n)) c[t.dataset.hnum] = n; }
  else if (t.dataset.hstr) c[t.dataset.hstr] = String(t.value || '');
  else if (t.dataset.hat) c.atKeys = String(t.value || '').split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
  else if (t.dataset.hweek) {
    const v = t.dataset.hweek, arr = (c.workdays || []).map(String);
    c.workdays = t.checked ? HR_WEEK.map(x => x[0]).filter(k => arr.indexOf(k) >= 0 || k === v) : arr.filter(k => k !== v);
  }
  else if (t.dataset.hmakeup != null) c.makeupAsWorkday = t.checked ? 1 : 0;
  else if (t.dataset.hact) { const [p, i] = t.dataset.hact.split(':'); if (c[p] && c[p][+i]) c[p][+i].act = String(t.value || ''); }
});
view.addEventListener('input', e => {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.hnote) S.health.note = t.value;
  else if (t.dataset.hpNote) S.health.pactNote[t.dataset.hpNote] = t.value;
});
view.addEventListener('click', async e => {
  const b = e.target.closest('[data-htab],[data-htoggle],[data-rtoggle],[data-rsave],[data-rcheck],[data-bili-save],[data-bili-scan],[data-bili-run],[data-bili-stop],[data-ftag-del],[data-ftag-add],[data-hsave],[data-hreload],[data-hact-del],[data-hact-add],[data-hjoin],[data-hp-on],[data-hp-save],[data-hmodal],[data-hdel-ok],[data-hdel-no],[data-atoggle],[data-asave],[data-aadd],[data-adone],[data-afail],[data-apending],[data-adel]');
  if (!b) return;
  const d = b.dataset;
  if (d.htab) { S.health.tab = ['health', 'alarm', 'roco'].indexOf(d.htab) >= 0 ? d.htab : 'health'; S.health.rocoPreview = null; render(); return; }
  // ===== 闹钟（2026-11-24）=====
  if (d.atoggle != null) {
    const ac = S.health.alarmCfg || (S.health.alarmCfg = {});
    ac.enabled = ac.enabled === false; render(); return;
  }
  if (d.asave != null) {
    const ac = S.health.alarmCfg || {};
    const r = await window.xuh.api('POST', '/api/alarms', { action: 'cfg', cfg: ac, note: '提醒·闹钟设置' });
    if (!r || r.error) { toast('没保存上：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已保存：' + (((r.changed || []).join('、')) || '无改动')); loadHealth(); return;
  }
  if (d.aadd != null) {
    const an = S.health.alarmNew || {};
    const content = String(an.content || '').trim();
    if (!content) { toast('先写「答应了什么」', true); return; }
    let dueAt = 0;
    if (an.dueAt && String(an.dueAt).trim()) {
      const ms = Date.parse(String(an.dueAt).trim().replace(' ', 'T') + (/\+\d\d:\d\d$/.test(an.dueAt) ? '' : '+08:00'));
      if (Number.isFinite(ms)) dueAt = ms; else { toast('到期时间看不懂，用 2026-11-25 15:30 这个格式', true); return; }
    }
    const scope = String(an.scope || '').trim();
    const isGroup = /^群/.test(scope);
    const num = Number(scope.replace(/^[群私聊]+/, ''));
    const r = await window.xuh.api('POST', '/api/alarms', { action: 'add', content, dueAt,
      scope: scope || '手动记的', groupId: isGroup ? num : 0, userId: isGroup ? 0 : num,
      who: an.who || '', platform: 'qq' });
    if (!r || r.error) { toast('没加上：' + ((r && r.error) || '未知原因'), true); return; }
    S.health.alarmNew = { content: '', dueAt: '', scope: '', who: '' };
    toast(r.row && r.row.tooFar ? '记下了，但超过上限没设定时' : '加上了'); loadHealth(); return;
  }
  if (d.adone || d.afail || d.apending || d.adel) {
    const id = d.adone || d.afail || d.apending || d.adel;
    const payload = d.adel ? { action: 'del', id } : { action: 'status', id, status: d.adone ? 'done' : d.afail ? 'failed' : 'pending' };
    const r = await window.xuh.api('POST', '/api/alarms', payload);
    if (!r || r.error) { toast('没改成：' + ((r && r.error) || '未知原因'), true); return; }
    toast(d.adel ? '删了' : '改好了'); loadHealth(); return;
  }
  if (d.rtoggle != null) {
    const rc = S.health.roco || (S.health.roco = {});
    rc.enabled = !(rc.enabled !== false);
    render(); return;
  }
  if (d.biliSave != null) {
    const r = await window.xuh.api('POST', '/api/roco/bili', { action: 'cfg', cfg: S.health.biliCfg || {} });
    if (!r || r.error) { toast('没保存上：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已保存：' + (((r.changed || []).join('、')) || '无改动') + '；下一跳生效');
    loadHealth(); return;
  }
  if (d.biliScan != null) {
    S.health.biliBusy = true; S.health.biliScan = null; render();
    const r = await window.xuh.api('POST', '/api/roco/bili', { action: 'scan' });
    S.health.biliBusy = false;
    S.health.biliScan = r || { error: '接口没回' };
    render(); return;
  }
  if (d.biliRun != null) {
    S.health.biliBusy = true; S.health.biliScan = null; render();
    const r = await window.xuh.api('POST', '/api/roco/bili', { action: 'run' });
    S.health.biliBusy = false;
    if (!r || r.error) toast('没跑成：' + ((r && r.error) || '未知原因'), true);
    else toast('跑完一跳：' + ((r.result && r.result.skip) || '完成'));
    loadHealth(); return;
  }
  if (d.biliStop != null) {
    const r = await window.xuh.api('POST', '/api/roco/bili', { action: 'stop' });
    if (!r || r.error) { toast('没停成：' + ((r && r.error) || '未知原因'), true); return; }
    toast('这次 B站 任务已停掉');
    loadHealth(); return;
  }
  if (d.rsave != null) {
    const rc = S.health.roco || {};
    const r = await window.xuh.api('POST', '/api/roco', { cfg: rc, note: '提醒 · 洛克王国 保存设置' });
    if (!r || r.error) { toast('没保存上：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已保存：' + ((r.changed || []).join('、') || '无改动') + '；机器人热读，不用重启');
    loadHealth(); return;
  }
  if (d.rcheck != null) {
    S.health.rocoBusy = true; render();
    const r = await window.xuh.api('GET', '/api/roco/preview');
    S.health.rocoBusy = false;
    S.health.rocoPreview = r || { error: '接口没回' };
    render(); return;
  }
  if (d.ftagAdd != null) {
    const qqEl = $('#ft-new-qq'), tagEl = $('#ft-new-tag'), nameEl = $('#ft-new-name');
    const qq = qqEl ? String(qqEl.value || '').replace(/\D/g, '') : '';
    const tag = tagEl ? String(tagEl.value || '').trim() : '';
    const name = nameEl ? String(nameEl.value || '').trim() : '';
    if (!qq || !tag) { toast('QQ 号和标签词都要填', true); return; }
    const r = await window.xuh.api('POST', '/api/fixedtags', { action: 'add', qq, tag, name });
    if (!r || r.error) { toast('没加成：' + ((r && r.error) || '未知原因'), true); return; }
    toast('已给 ' + qq + ' 加固定标签「' + tag + '」' + (r.created ? '' : '（本来就有，更新了说明）'));
    loadHealth(); return;
  }
  if (d.ftagDel) {
    const parts = String(d.ftagDel).split('|');
    const qq = parts[0], tag = parts.slice(1).join('|');
    const key = qq + '|' + tag;
    const unlocked = S.health.unlockKey === key && Date.now() < S.health.unlockExp;
    if (!unlocked) {
      const u = await window.xuh.api('POST', '/api/fixedtags', { action: 'unlock', qq, tag });
      if (!u || u.error) { toast('解锁没成：' + ((u && u.error) || '未知原因'), true); return; }
      S.health.unlockKey = key;
      S.health.unlockToken = u.token;
      S.health.unlockExp = Date.now() + (Number(u.ttlSec) || 120) * 1000;
      toast('已解锁一次（2 分钟内有效）——再点一次按钮就真删');
      render(); return;
    }
    const r = await window.xuh.api('POST', '/api/fixedtags', { action: 'remove', qq, tag, token: S.health.unlockToken });
    if (!r || r.error) { toast('没删成：' + ((r && r.error) || '未知原因'), true); return; }
    S.health.unlockKey = ''; S.health.unlockToken = ''; S.health.unlockExp = 0;
    toast('已取消固定标签「' + tag + '」');
    loadHealth(); return;
  }
  if (!S.health.cfg) return;
  const c = S.health.cfg;
  if (d.htoggle != null) { c.enabled = !(c.enabled !== false); render(); return; }
  if (d.hreload != null) { S.health.loaded = false; S.health.note = ''; loadHealth(); return; }
  if (d.hsave != null) {
    const r = await window.xuh.api('POST', '/api/healthremind', { cfg: c, note: S.health.note || '' });
    if (!r || r.error) { toast('没保存上：' + ((r && r.error) || '未知原因'), true); return; }
    S.health.note = '';
    toast('已保存：' + (r.changed || []).join('、') + '；机器人热读，不用重启');
    loadHealth(); return;
  }
  if (d.hactDel) {
    const [p, i] = d.hactDel.split(':');
    const it = (c[p] || [])[+i];
    if (it) { S.health.del = { p, i, name: it.act || '未命名动作' }; render(); }
    return;
  }
  if (d.hmodal) { if (e.target === b) { S.health.del = null; render(); } return; }
  if (d.hdelNo != null) { S.health.del = null; render(); return; }
  if (d.hdelOk != null) {
    const q = S.health.del;
    if (q && c[q.p]) { c[q.p].splice(q.i, 1); S.health.del = null; render(); toast('已从这一池移除，记得点保存'); }
    return;
  }
  if (d.hactAdd) {
    const el = $('#hr-new-' + d.hactAdd);
    const name = el ? String(el.value || '').trim() : '';
    if (!name) { toast('先写个动作名', true); return; }
    (c[d.hactAdd] = c[d.hactAdd] || []).push({ act: name });
    render(); return;
  }
  if (d.hjoin) {
    const [from, i, to] = d.hjoin.split(':');
    const it = (c[from] || [])[+i];
    if (!it) return;
    (c[to] = c[to] || []).push(JSON.parse(JSON.stringify(it)));
    render(); toast('「' + it.act + '」已加进' + (to === 'mainWork' ? '主池A' : '主池B') + '（原池保留）'); return;
  }
  if (d.hpSave) {
    const p = (S.health.people || []).find(x => x.key === d.hpSave);
    if (!p) return;
    const box = view.querySelector('input[data-hp-on="' + d.hpSave + '"]');
    const enabled = !!box && !!box.checked;
    const r = await window.xuh.api('POST', '/api/healthremind/pact', {
      who: d.hpSave, enabled, note: S.health.pactNote[d.hpSave] || '',
    });
    if (!r || r.error) { toast('约定没记成：' + ((r && r.error) || '未知原因'), true); return; }
    S.health.pactNote[d.hpSave] = '';
    toast('已记成约定，只对' + p.name + '生效：' + (r.changes || []).join('，'));
    loadHealth(); return;
  }
});
