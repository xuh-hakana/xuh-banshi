/*
 * app/preload.js — 界面与主进程之间唯一的通道
 *
 * 渲染进程没有 node，只能调这里列出来的方法。想加能力必须在这里显式开，
 * 不会出现「界面里随手读你整块硬盘」那种事。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xuh', {
  /* 读 */
  snapshot: () => ipcRenderer.invoke('xuh:snapshot'),
  /* 派活词表（主人 2026-11-22：词要能在面板上直接改） */
  intentWords: () => ipcRenderer.invoke('xuh:intent-words'),
  intentWordsSave: words => ipcRenderer.invoke('xuh:intent-words-save', words),
  intentCfg: () => ipcRenderer.invoke('xuh:intent-cfg'),
  intentCfgSave: patch => ipcRenderer.invoke('xuh:intent-cfg-save', patch),
  stickers: () => ipcRenderer.invoke('xuh:stickers'),
  poop: () => ipcRenderer.invoke('xuh:poop'),
  /* 启动参数 --tab=<页>：只读，用来直接落到某一页 */
  tabArg: () => ipcRenderer.invoke('xuh:tab-arg'),

  /* 写 */
  favor: (qq, v) => ipcRenderer.invoke('xuh:favor', qq, v),  person: (qq, field, value) => ipcRenderer.invoke('xuh:person', qq, field, value),

  /* 多端互通：人物级操作（pid 维度，2026-11-03） */
  personFavor: (pid, v) => ipcRenderer.invoke('xuh:personFavor', pid, v),
  personFavorLock: (pid, on) => ipcRenderer.invoke('xuh:personFavorLock', pid, on),
  personField: (pid, field, value) => ipcRenderer.invoke('xuh:personField', pid, field, value),
  personAddAccount: (pid, platform, id) => ipcRenderer.invoke('xuh:personAddAccount', pid, platform, id),
  personRemoveAccount: (pid, platform, id) => ipcRenderer.invoke('xuh:personRemoveAccount', pid, platform, id),
  personMerge: (intoPid, fromPid) => ipcRenderer.invoke('xuh:personMerge', intoPid, fromPid),
  personCreate: (name, platform, id) => ipcRenderer.invoke('xuh:personCreate', name, platform, id),

  /* 学习系统（2026-11-09）：好感事件流水 / 手改分数 / 撤销一条。真身在 src/learn */
  learn: () => ipcRenderer.invoke('xuh:learn'),
  learnSetFavor: (pid, v, why) => ipcRenderer.invoke('xuh:learnSetFavor', pid, v, why),
  learnRevoke: (pid, id, why) => ipcRenderer.invoke('xuh:learnRevoke', pid, id, why),
  /* P1（2026-11-09）：每人三份档案 / 每人知识库 / 冷层记录 */
  learnStyleGet: (pid) => ipcRenderer.invoke('xuh:learnStyleGet', pid),
  learnStyleSet: (pid, key, text) => ipcRenderer.invoke('xuh:learnStyleSet', pid, key, text),
  learnKbList: (pid) => ipcRenderer.invoke('xuh:learnKbList', pid),
  learnKbAdd: (pid, item) => ipcRenderer.invoke('xuh:learnKbAdd', pid, item),
  learnKbDel: (pid, id) => ipcRenderer.invoke('xuh:learnKbDel', pid, id),
  learnKbExport: (pid) => ipcRenderer.invoke('xuh:learnKbExport', pid),
  learnActs: (opt) => ipcRenderer.invoke('xuh:learnActs', opt),
  learnActsTopics: (opt) => ipcRenderer.invoke('xuh:learnActsTopics', opt),
  learnExport: (pid, name) => ipcRenderer.invoke('xuh:learnExport', pid, name),
  trigAdd: (word, mode, opt) => ipcRenderer.invoke('xuh:trigAdd', word, mode, opt),
  trigDel: id => ipcRenderer.invoke('xuh:trigDel', id),
  trigToggle: (id, on) => ipcRenderer.invoke('xuh:trigToggle', id, on),
  setSwitch: (key, on) => ipcRenderer.invoke('xuh:switch', key, on),
  setCritic: p => ipcRenderer.invoke('xuh:critic', p),
  setKwFuzzy: on => ipcRenderer.invoke('xuh:kwfuzzy', on),
  setNum: (k, v) => ipcRenderer.invoke('xuh:num', k, v),

  /* 杂项 */
  /* 复制一段文字到剪贴板（聊天记录每条右侧「复制」用；2026-11-09 她要能复制界面文字） */
  copyText: t => ipcRenderer.invoke('xuh:copyText', t),
  /* 客户端发言（2026-11-23）：挑文件走系统选文件框；贴图取剪贴板；
     拖进来的 File 取真实路径（Electron 32+ 删了 File.path，只能用 webUtils）。 */
  pickFiles: kind => ipcRenderer.invoke('xuh:pickFiles', kind),
  clipImage: () => ipcRenderer.invoke('xuh:clipImage'),
  openMedia: name => ipcRenderer.invoke('xuh:openMedia', name),
  pathForFile: f => { try { return webUtils.getPathForFile(f) || ''; } catch { return ''; } },
  /* 后端通用接口（表情包页等都用它；后端就是面板那份 handler，不另写） */
  api: (method, url, body) => ipcRenderer.invoke('xuh:api', method, url, body),
  /* 文件导览：「这一页该改哪些文件」。读写都在命令方块里做，这里只读归属表 */
  fileMap: () => ipcRenderer.invoke('xuh:fileMap'),
  /* 攻略：客户端「攻略」页用（action + payload → guides.api 分发） */
  guides: (action, payload) => ipcRenderer.invoke('xuh:guides', action, payload),
  /* 别人教的：检索（人物/关键词/时间/全部或单条/核实状态）、单条核实、单条删除 */
  kb: (action, payload) => ipcRenderer.invoke('xuh:kb', action, payload),
  /* 回话路径 ⑦⑧：三张表 / 两份喜好表转移复制 / 喜好唯一 id 与描述 */
  replypath: (action, payload) => ipcRenderer.invoke('xuh:replypath', action, payload),
  tastecopy: (action, payload) => ipcRenderer.invoke('xuh:tastecopy', action, payload),
  tasteid: (action, payload) => ipcRenderer.invoke('xuh:tasteid', action, payload),
  /* 查梗 / 娱乐网站：内联查 + 站目录（bot 侧玩梗也用 src/meme.js 同一份） */
  memeLookup: term => ipcRenderer.invoke('xuh:memeLookup', term),
  memeSites: () => ipcRenderer.invoke('xuh:memeSites'),
  memeSitesSave: sites => ipcRenderer.invoke('xuh:memeSitesSave', sites),
  /* 词汇 · 本地词库（ci.json + restricted.json 侧车）：列出来自 ci、标记写侧车 */
  dictStats: () => ipcRenderer.invoke('xuh:dictStats'),
  dictList: (opt) => ipcRenderer.invoke('xuh:dictList', opt),
  dictSetRestricted: (p) => ipcRenderer.invoke('xuh:dictSetRestricted', p),
  dictSetExplanation: (p) => ipcRenderer.invoke('xuh:dictSetExplanation', p),
  dictImportCheck: (text) => ipcRenderer.invoke('xuh:dictImportCheck', text),
  dictImport: (text) => ipcRenderer.invoke('xuh:dictImport', text),
  dictDeleteUser: (p) => ipcRenderer.invoke('xuh:dictDeleteUser', p),
  /* 打开外链（查梗目录里的网站 / 内联结果原文）：渲染进程不碰 shell */
  openUrl: url => ipcRenderer.invoke('xuh:openUrl', url),
  openFile: rel => ipcRenderer.invoke('xuh:openFile', rel),
  /* 看原文：交给「命令方块」（只读文件浏览器），停在那一份上 */
  cmdBlock: (rel, line) => ipcRenderer.invoke('xuh:cmdBlock', rel, line),
  /* 只把命令方块叫到前面，不定位文件 */
  cmdOpen: () => ipcRenderer.invoke('xuh:cmdOpen'),
  /* 跳转提词器（ticiqi）：'app' 唤起提词器.app，否则相对 ticiqi 路径；'cb:' 前缀指 CommandBlock 数据目录 */
  ticiqiOpen: t => ipcRenderer.invoke('xuh:ticiqiOpen', t),

  /* 机器人本体：客户端一启动就自动拉起，界面上也能手动启停（2026-11-05） */
  botStatus: () => ipcRenderer.invoke('xuh:botStatus'),
  botStart: () => ipcRenderer.invoke('xuh:botStart'),
  botStop: () => ipcRenderer.invoke('xuh:botStop'),
  botRestart: () => ipcRenderer.invoke('xuh:botRestart'),
  botLog: n => ipcRenderer.invoke('xuh:botLog', n),
  botKeepAlive: on => ipcRenderer.invoke('xuh:botKeepAlive', on),

  /* 左上角那张图：读 / 换（弹系统选图框）/ 恢复默认，2026-11-05 */
  skin: () => ipcRenderer.invoke('xuh:skin'),
  skinPick: () => ipcRenderer.invoke('xuh:skinPick'),
  skinReset: () => ipcRenderer.invoke('xuh:skinReset'),
  skinSet: patch => ipcRenderer.invoke('xuh:skinSet', patch),

  /* 雨夜玻璃的窗外原图：file:// 下 <img> 本地 jpg 会污染 canvas，WebGL 拒绝上传，
     所以由主进程读成 data: URL 再交给页面（只在开屏调一次，返回字符串）。 */
  rainBackdrop: () => ipcRenderer.sendSync('xuh:rainBackdrop'),
  /* 头图取色：把当前左上角那张图读成 data: URL，交给 theme-from-art.js 提主色。
     换图后重调一次即可，主色跟着头图变（2026-11-09 她定）。同步，只在开屏/换图调。 */
  skinData: () => ipcRenderer.sendSync('xuh:skinData'),

  claim: () => ipcRenderer.invoke('xuh:claim'),
  openDir: which => ipcRenderer.invoke('xuh:openDir', which),
  logPath: () => ipcRenderer.invoke('xuh:logPath'),

  /* B站：弹幕存档（读 app/data/log/弹幕-*.jsonl，不走网络） */
  dmDays: () => ipcRenderer.invoke('xuh:dmDays'),
  dmRead: (date, limit) => ipcRenderer.invoke('xuh:dmRead', date, limit),
  dmDir: () => ipcRenderer.invoke('xuh:dmDir'),
  /* B站：评论区召唤状态（2026-11-19 起 xuhbot 不再跑召唤监听，主进程直接回「已下线」） */
  biliMention: () => ipcRenderer.invoke('xuh:biliMention'),
  onReload: cb => ipcRenderer.on('xuh:reload', cb),
});
