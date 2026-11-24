/* ===== 深度检查引擎（checks.js，2026-10-23）=====
 * 为什么单独抽出来：现在有两个入口要用**同一份**检查——
 *   ① 手动：node selfcheck.js --deep（「自检」→ 深度巡检）
 *   ② 自动：selfwatch.js 探到毛病时，立刻跑一次定位，把「哪一项坏了、怎么修」写进私信和面板
 * 检查逻辑只能有一份，否则两个入口的结论早晚对不上（主人铁律：同一功能优先整合，不建平行系统）。
 *
 * 铁律：这个文件**只读不写**——不改配置、不改数据、不重启进程。
 * 要修的话由调用方决定（selfcheck 会提示命令，selfwatch 只负责报告）。
 *
 * 返回格式永远是数组，一项一条：
 *   { g: 分组, name: 检测项, ok: 布尔, level: 'ok'|'warn'|'error', detail: 人话, fix: 怎么修 }
 * 分组固定五类（主人 2026-10-23 要求）：
 *   运行环境与依赖 / 配置与数据完整性 / 网络与接口 / 核心功能 / 日志与异常定位
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const dns = require('dns');

const ROOT = __dirname;
const stickerPaths = require('./sticker-paths');   // 表情包根从配置解析（2026-11-25，不再写死 data/stickers）
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读取
const G_ENV = '运行环境与依赖';
const G_CFG = '配置与数据完整性';
const G_NET = '网络与接口';
const G_CORE = '核心功能';
const G_LOG = '日志与异常定位';

const it = (g, name, ok, detail, fix, level) =>
  ({ g, name, ok: !!ok, level: level || (ok ? 'ok' : 'error'), detail: detail || '', fix: ok ? '' : (fix || '') });
const readJson = p => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; } };
const sizeMB = p => { try { return fs.statSync(path.join(ROOT, p)).size / 1048576; } catch { return -1; } };
const listFiles = (dir, ext) => {
  try { return fs.readdirSync(path.join(ROOT, dir)).filter(f => ext.some(e => f.endsWith(e))); } catch { return []; }
};

/* ========== 一、运行环境与依赖 ========== */
function checkEnv() {
  const out = [];
  const major = Number(String(process.versions.node).split('.')[0]);
  out.push(it(G_ENV, 'Node 版本', major >= 18, 'v' + process.versions.node,
    '升级到 18 以上（现在是 ' + process.versions.node + '，很多新 API 用不了）'));

  // 依赖：package.json 里声明过的必须真的能 require（装了一半最常见）
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}; } catch { }
  const names = Object.keys(deps);
  if (!names.length) out.push(it(G_ENV, '依赖声明', true, 'package.json 没有外部依赖', '', 'warn'));
  for (const m of names) {
    try { require(m); out.push(it(G_ENV, '依赖 ' + m, true, '可加载 ' + deps[m])); }
    catch (e) {
      out.push(it(G_ENV, '依赖 ' + m, false, '加载失败：' + String(e.message).split('\n')[0].slice(0, 70),
        '在机器人目录执行 npm install'));
    }
  }

  try {
    const st = fs.statfsSync ? fs.statfsSync(ROOT) : null;
    if (st) {
      const freeGB = (st.bavail * st.bsize) / 1073741824;
      out.push(it(G_ENV, '磁盘剩余', freeGB > 1, freeGB.toFixed(1) + ' GB',
        '只剩 ' + freeGB.toFixed(1) + ' GB，清一下日志/备份', freeGB > 1 ? undefined : 'warn'));
    }
  } catch { }

  // panel.js 2026-11-02 搬去了 xuhbot/xuhctrl/（面板代码和机器人代码分开放），
  // 这里还按老位置找会一直报「不见了」，然后每小时的自动查岗就误报一次。
  for (const p of ['config/index.js', 'bot.js', 'server/panel.js', 'core.js', 'connectors/qq.js', 'soul/F-全场景通用主人设/虚幻.md']) {
    const ok = fs.existsSync(path.join(ROOT, p));
    out.push(it(G_ENV, '关键文件 ' + p, ok, ok ? '在' : '不见了', '项目文件缺失，从备份恢复'));
  }
  for (const d of ['data', 'connectors', 'soul', 'docs']) {
    const ok = fs.existsSync(path.join(ROOT, d));
    out.push(it(G_ENV, '目录 ' + d + '/', ok, ok ? '在' : '不见了', '建回来：缺目录会让所有写入静默失败'));
  }
  // 表情包根：默认 src/data/stickers，可在配置 stickerDir 改（2026-11-25 主人定「不能写死路径」）
  const sdRel = path.relative(ROOT, stickerPaths.stickerRoot()).split(path.sep).join('/');
  const sdOk = fs.existsSync(stickerPaths.stickerRoot());
  out.push(it(G_ENV, '目录 ' + sdRel + '/（表情包）', sdOk, sdOk ? '在' : '不见了', '建回来：缺目录会让所有表情包写入静默失败'));
  return out;
}

/* ========== 二、配置与数据完整性 ========== */
function checkConfig() {
  const out = [];
  const cfg = configStore.cfgLive();
  if (!cfg) {
    out.push(it(G_CFG, 'config/ 分区', false, '读不出来（格式坏了或不见了）', '用面板「配置」页改回来，或恢复备份'));
    return out;
  }
  out.push(it(G_CFG, 'config/ 分区', true, '可解析'));

  for (const [k, label, why] of [
    ['masterQQ', '主人 QQ', '私聊遥控、必回复都靠它'],
    ['oniiQQ', '欧尼酱 QQ', '每日汇报要发给他'],
    ['botName', '机器人名字', '人设和提示词要用'],
    ['selfQQ', '她自己的 QQ 号', '群友问她 QQ 号时要答'],
  ]) {
    const v = cfg[k];
    out.push(it(G_CFG, '配置 ' + label, !!v, v ? String(v) : '没配', 'config/ 补 ' + k + '（' + why + '）'));
  }

  const llm = cfg.llm || {};
  // 2026-11-13 主人令「我只需要看到真正的问题，现在甚至还有填ky」：AstrBot 接入时
  // Key 在 AstrBot 配置里、模型链由 AstrBot 池动态填，llm.json 空是正常状态。
  // 旧判定把「模型 Key / 备用模型链」算成故障，自查定位就甩「双击换Key」给主人——不是真问题，去掉。
  let astrbotCount = 0;
  try { astrbotCount = require('./llm-astrbot.js').list().length; } catch { }
  const astrbotMode = astrbotCount > 0;
  const keyOk = astrbotMode || (!!llm.apiKey && !String(llm.apiKey).includes('在这里填'));
  out.push(it(G_CFG, '模型 Key', keyOk,
    astrbotMode ? '从 AstrBot 配置读（' + astrbotCount + ' 个模型）' : (keyOk ? '已填' : '没填 / 还是占位文字'),
    '双击「换Key」重新粘一次'));
  out.push(it(G_CFG, '备用模型链', astrbotMode || (Array.isArray(llm.fallbackModels) && llm.fallbackModels.length > 0),
    astrbotMode ? 'AstrBot 池 ' + astrbotCount + ' 个（llm.json 不用填）'
      : (llm.fallbackModels || []).length + ' 个：' + (llm.fallbackModels || []).join(' / '),
    '主模型限流时靠它顶着，config.llm.fallbackModels 至少留 2 个'));
  out.push(it(G_CFG, '思考超时', Number(llm.thinkTimeoutMs || 0) >= 15000,
    String(llm.thinkTimeoutMs || '未设'), '思考型模型 6 秒必失败，config.llm.thinkTimeoutMs 设 30000', 'warn'));

  // 所有数据文件能解析（解析坏了 = 相关功能静默失效，不报错只是不干活）
  let jsonBad = [], jsonlBad = [];
  const dirs = ['data', path.relative(ROOT, stickerPaths.stickerRoot()), 'soul'];
  for (const d of dirs) {
    for (const f of listFiles(d, ['.json'])) {
      const rel = d + '/' + f;
      try { JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
      catch { jsonBad.push(rel); }
    }
    for (const f of listFiles(d, ['.jsonl'])) {
      const rel = d + '/' + f;
      const text = String(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      // 有的「.jsonl」其实是纯文本行日志（data/chat-log.jsonl 就是「时间 [qq][群] 谁 说了什么」），
      // 不是每行 JSON——按首字符认，别把正常文件判成坏了（2026-10-23 自己踩的）。
      const first = text.trim().slice(0, 1);
      if (first !== '{' && first !== '[') continue;
      const lines = text.split('\n').filter(l => l.trim());
      const bad = lines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } }).length;
      if (bad) jsonlBad.push(rel + '（' + bad + '/' + lines.length + ' 行坏）');
    }
  }
  out.push(it(G_CFG, 'JSON 文件可解析', jsonBad.length === 0,
    jsonBad.length ? jsonBad.slice(0, 4).join('、') : '全部正常', '这些文件格式坏了，对应功能会用默认值或失效'));
  out.push(it(G_CFG, 'JSONL 每行可解析', jsonlBad.length === 0,
    jsonlBad.length ? jsonlBad.slice(0, 4).join('、') : '全部正常', '坏行会被跳过（等于丢数据），建议从备份恢复'));

  // 必备内容文件（丢了对应功能直接哑）
  for (const [p, min, label, fix] of [
    ['soul/F-全场景通用主人设/虚幻.md', 200, '人设文件', '她就没有灵魂了，从备份恢复'],
    ['data/网络热梗.md', 20, '自有梗库', '接梗靠它，恢复备份'],
    ['data/梗词典.jsonl', 10000, '梗词典', '自由搭话的关键词闸靠它，恢复备份'],
    ['data/笑点解析范例.md', 50, '笑点解析范例', '笑点解析质量会掉'],
    [path.relative(ROOT, stickerPaths.stickerRoot()) + '/常用.md', 20, '常用表情单', '她一张表情都发不出'],
  ]) {
    let size = -1;
    try { size = fs.statSync(path.join(ROOT, p)).size; } catch { }
    out.push(it(G_CFG, label, size >= min, size < 0 ? '不见了' : size + ' 字节', fix));
  }

  // 人设按层物理切开（主人 2026-11-21）：F 层全场景通用主人设，少一块人就残
  let seg = -1;
  try { seg = fs.readdirSync(path.join(ROOT, 'soul', 'F-全场景通用主人设')).filter(f => f.endsWith('.md')).length; } catch { }
  out.push(it(G_CFG, 'F 主人设齐全', seg >= 5, seg < 0 ? 'soul/F-全场景通用主人设/ 不见了' : seg + ' 份',
    '应当是 虚幻、0-我的喜好、1-性格、2-说话、功能词典 五份；缺哪份就从备份补哪份，不然那部分规矩全丢'));
  // H 层应对正本（3-应对.md）+ soul/H-全聊天/应对/ 下每场合一份，命中才注入
  let hmain = -1;
  try { hmain = fs.statSync(path.join(ROOT, 'soul', 'H-全聊天', '3-应对.md')).size; } catch { }
  out.push(it(G_CFG, 'H 应对正本在', hmain >= 100, hmain < 0 ? 'soul/H-全聊天/3-应对.md 不见了' : hmain + ' 字节',
    '应对语气底色（公共块）在 3-应对.md；空间评论/B站评论都靠它才有虚幻风格，丢了从备份恢复'));
  let scenes = -1;
  try { scenes = fs.readdirSync(path.join(ROOT, 'soul', 'H-全聊天', '应对')).filter(f => f.endsWith('.md')).length; } catch { }
  out.push(it(G_CFG, 'H 应对场合文件齐全', scenes >= 5,
    scenes < 0 ? 'soul/H-全聊天/应对/ 不见了' : scenes + ' 份',
    '我-被夸 / 我-被怪 / 别人-被围观 / 被提问-被需要 / 被教会-学到了 各一份；这是从 3-应对.md 物理分离出去的场合专属段，缺一份那种场合就没规矩'));

  // 表情表 ↔ 磁盘（2026-10-31 v104 重写）
  // 老写法拿 _stickerOccasions() 的 key（那已经是「描述」了）当图名去查 → 常用/ 里 17 张主力图
  // 全被报成「孤儿图」（其实每张都有描述）。表的格式也早就反过来了（现在是「- 描述：图名」），
  // 老提示还教主人写反的写法、还叫她「或删掉这张」—— 跟她定的「只增不减，我来减」冲突。
  // 现在直接用对账那一套（qq.js 里唯一口径），不在这儿另算一套，免得两边对不上。
  try {
    const qq = require('./connectors/qq');
    const rec = qq._stickerReconcile() || {};
    const nd = rec.needDesc || [];
    out.push(it(G_CFG, '表情表 ↔ 图片', (rec.classified || 0) > 0,
      '表里 ' + (rec.classified || 0) + ' 张图对得上、纯描述 ' + (rec.pureDesc || 0) + ' 条（没图但留着的描述，正常，不删）',
      '一行「- 描述：图名1、图名2」，图名要和 ' + stickerPaths.relSticker() + '/ 里的文件名一致'));
    if (nd.length) {
      out.push(it(G_CFG, '缺描述的表情', false, nd.length + ' 张情绪图系统配不出描述（这算 bug）：' + nd.slice(0, 6).join('、'),
        '在「常用.md」补一行「- 什么时候用：图名」，图名写全；或把文件改个一眼能懂的名字', 'warn'));
    }
  } catch (e) {
    out.push(it(G_CFG, '表情表 ↔ 图片', false, '检查不了：' + String(e.message).slice(0, 60), 'qq.js 加载失败'));
  }

  // 单人的说话约定：指向的人还在不在（键是 'platform:id'，问人物档案，别对 people-state 的裸 QQ 表）
  try {
    const peopleStore = require('./people');
    const lines = String(fs.readFileSync(path.join(ROOT, 'data', 'topics.jsonl'), 'utf8')).split('\n').filter(l => l.trim());
    const pacts = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && x.kind === 'promise' && x.qq);
    const orphan = pacts.filter(x => !peopleStore.pidOfKey(x.qq));
    out.push(it(G_CFG, '单人约定 ×' + pacts.length, orphan.length === 0,
      orphan.length ? orphan.length + ' 条指向不认识的人：' + orphan.slice(0, 3).map(x => x.qq).join('、')
        : '都指向认识的人',
      '人不在了但约定还在，提示词会让她照一个不存在的人的要求说话——删掉那条约定'));
  } catch { }

  // 数据体积（单个文件过大会拖慢每条消息的读取）
  const big = [];
  for (const d of ['data']) {
    for (const f of listFiles(d, ['.json', '.jsonl', '.log'])) {
      const mb = sizeMB(d + '/' + f);
      if (mb > 20) big.push(d + '/' + f + '（' + mb.toFixed(0) + ' MB）');
    }
  }
  out.push(it(G_CFG, '数据体积', big.length === 0, big.length ? big.join('、') : '都在 20 MB 以内',
    '这些文件每条消息都要读，太大就慢——清理或裁剪', 'warn'));
  return out;
}

/* ========== 三、网络与接口 ========== */
function tcpProbe(host, port, ms) {
  return new Promise(res => {
    const s = net.connect({ host, port });
    const done = ok => { try { s.destroy(); } catch { } res(ok); };
    s.setTimeout(ms || 1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
function httpProbe(pathname, ms) {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port: 8899, path: pathname, timeout: ms || 2500 }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => res({ code: r.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); res({ code: 0, body: '' }); });
    req.on('error', () => res({ code: 0, body: '' }));
  });
}

async function checkNet(cfg) {
  const out = [];
  const llm = (cfg && cfg.llm) || {};
  let host = 'open.bigmodel.cn';
  try { host = new URL(llm.endpoint || 'https://open.bigmodel.cn/api/paas/v4/chat/completions').host; } catch { }

  // 免费知识检索（2026-11-07 加）：维基百科 / Wikidata 官方 API，0 元 0 Key。
  // 这里只读配置和已探测结果，不真发请求（自检不联网、不耗额度）。
  const ws = (cfg && cfg.webSearch) || {};
  const kbOn = ws.enabled !== false && ws.wikipedia !== false;
  let proxyNow = '';
  try { proxyNow = require('./net').current(); } catch { }
  const proxyDesc = (ws.proxy && ws.proxy.url) ? ('手填 ' + ws.proxy.url)
    : (proxyNow ? ('已探到 ' + proxyNow) : '还没探过（第一次查证时自动探）');
  out.push(it(G_NET, '免费知识检索（维基百科）', kbOn,
    kbOn ? ('已开；代理 ' + proxyDesc) : '已关，知识题只能靠本地资料',
    '要开就把 src/config/llm.json 的 webSearch.wikipedia 设成 true；'
    + '没代理时维基直连会超时（这台机器实测 10 秒超时），代理开着就能查'));

  // DNS
  try {
    const ip = await new Promise((res, rej) => dns.lookup(host, (e, a) => e ? rej(e) : res(a)));
    out.push(it(G_NET, 'DNS ' + host, true, ip));
  } catch {
    out.push(it(G_NET, 'DNS ' + host, false, '解析不了',
      '把 DNS 改成 223.5.5.5 / 119.29.29.29，或关掉代理软件'));
  }

  // 模型接口（只连 443，不花钱、不占额度）
  const tlsOk = await tcpProbe(host, 443, 2000);
  out.push(it(G_NET, '模型接口 443', tlsOk, tlsOk ? '能连上' : '连不上',
    '先关代理再试；一直不通就是网络/防火墙拦了 node.exe'));

  // NapCat（QQ 消息进出的唯一通道，3001 掉了她收不到任何消息）
  const napcat = await tcpProbe('127.0.0.1', 3001, 1200);
  out.push(it(G_NET, 'NapCat 3001', napcat, napcat ? '端口在监听' : '连不上',
    '先开 NapCat（双击「启动NapCat」），确认它是 WebSocket 服务端模式'));

  // 管理面板
  const p = await httpProbe('/api/status', 2500);
  out.push(it(G_NET, '面板 8899', p.code === 200, p.code === 200 ? '接口正常' : '返回 ' + (p.code || '连不上'),
    '双击「管理面板」；面板挂了不影响她回话，但你什么都看不见'));
  return out;
}

/* ========== 四、核心功能模块 ========== */
async function checkCore(opts) {
  const out = [];
  const o = opts || {};
  const cfg = configStore.cfgLive() || {};

  // 模块能不能加载（循环依赖/语法错误在这里现形）
  for (const m of ['./core', './guides', './nick', './style', './taste', './pause', './region', './websearch', './pokemon', './wlog']) {
    try { require(m); }
    catch (e) { out.push(it(G_CORE, '模块 ' + m, false, String(e.message).split('\n')[0].slice(0, 80), '这个模块加载不了，用它做的功能全废')); }
  }
  if (!out.length) out.push(it(G_CORE, '模块加载', true, '10 个核心模块都能加载'));

  let core;
  try { core = require('./core'); } catch { return out; }
  // 配置注入的三种情况（2026-10-23 踩过）：
  //   true  独立进程（selfcheck --deep）→ 直接 init
  //   'auto'自动判断（selfwatch 的 locate）→ 先试，崩了才 init；**在 bot 进程里绝不能重新 init**，会覆盖运行中的配置
  //   false 在 bot 进程里，什么都不做
  if (o.initCore === 'auto') {
    try { core.systemPrompt(); } catch { try { core.init(cfg); } catch { } }
  } else if (o.initCore) {
    try { core.init(cfg); } catch (e) { out.push(it(G_CORE, 'core.init', false, String(e.message).slice(0, 80), '配置有问题，先看上面 config 那几条')); }
  }

  try {
    const sp = core.systemPrompt();
    out.push(it(G_CORE, '提示词组装', sp.length > 2000 && sp.length < 60000,
      sp.length + ' 字符', '提示词太短=人设没读进来；太长会拖慢并挤掉上下文'));
  } catch (e) { out.push(it(G_CORE, '提示词组装', false, String(e.message).slice(0, 80), 'systemPrompt 崩了，她一句都答不出')); }

  try {
    const k = 'checks#probe';
    core.setTurn(k, { source: 'checks', uid: String(cfg.masterQQ || ''), gid: 0, nick: '主人' });
    core.pushHist(k, 'user', '在吗');
    const msgs = await core.buildMessages(k, '在吗', '');
    const sysN = msgs.filter(m => m.role === 'system').length;
    out.push(it(G_CORE, '上下文组装', msgs.length >= 2 && sysN >= 3,
      msgs.length + ' 条消息（其中系统 ' + sysN + ' 段）', 'buildMessages 没把记忆/群名片/规则装进去'));
  } catch (e) { out.push(it(G_CORE, '上下文组装', false, String(e.message).slice(0, 80), 'buildMessages 崩了，等于没法回话')); }

  try {
    const tr = core.readTriggers ? core.readTriggers() : [];
    out.push(it(G_CORE, '触发词表', true, tr.length + ' 条：' + tr.slice(0, 4).map(t => (t.words || []).join('/')).join('、')));
  } catch (e) { out.push(it(G_CORE, '触发词表', false, String(e.message).slice(0, 60), '触发词读不出来，群里喊她可能没反应')); }

  try {
    const qq = require('./connectors/qq');
    // splitOut(ans, srcText)：只有对方消息里带「。」且不是笑点解析/攻略/自检时才拆段（可返回字符串也可返回数组）
    const parts = qq._splitOut ? qq._splitOut('第一句。第二句。第三句。', '你说了三句话。听起来挺好。') : null;
    const segN = Array.isArray(parts) ? parts.length : (typeof parts === 'string' ? 1 : 0);
    out.push(it(G_CORE, '拆分发送', parts !== null && segN >= 1,
      segN + ' 段（配置：' + ((cfg.split || {}).enabled === false ? '已关闭' : '开启') + '）',
      '拆段坏了会一次刷一屏，检查 qq.splitOut'));
    const conv = qq._atNameConvert ? qq._atNameConvert('主人是 ' + String(cfg.masterQQ || ''), { message_type: 'private', user_id: '1' }) : '';
    out.push(it(G_CORE, '输出安全', !!conv && !conv.includes('主人和主人'),
      conv.includes('主人和主人') ? '出现「主人和主人」' : '正常', '号码被错误替换，检查 atNameConvert'));
    // 谎报闸（v91）：没做成的事不许说成做成了。真事 2026-10-23——主人让她加群 1126843213，
    // 她回「已成功加入群1126843213」，实测没进群；NapCat 根本没有「按群号加群」这个动作。
    const lieSample = '已成功加入群1126843213，主人～';
    const gateOut = typeof qq._noFakeJoin === 'function' ? qq._noFakeJoin(lieSample) : lieSample;
    out.push(it(G_CORE, '谎报闸（加群）', typeof qq._noFakeJoin === 'function',
      typeof qq._noFakeJoin !== 'function' ? 'qq.js 里没有 noFakeJoin'
        : (gateOut !== lieSample ? '能拦下「已成功加入群…」' : '存在；当前免检（30 分钟内真的进过群）'),
      '发送层兜底没了，她会把没做成的事说成做成了'));
  } catch (e) { out.push(it(G_CORE, '发送层', false, String(e.message).slice(0, 60), 'qq.js 的发送层加载失败')); }

  // 暂停数据（坏了 = 她要么永远不说话，要么停不下来）
  const pz = readJson('data/pause.json');
  out.push(it(G_CORE, '暂停数据', Array.isArray(pz), Array.isArray(pz) ? (pz.length ? pz.length + ' 条暂停中' : '没有暂停') : '格式坏了',
    'data/pause.json 应该是数组；坏了先备份再清空', Array.isArray(pz) ? (pz.length ? 'warn' : undefined) : 'error'));
  return out;
}

/* ========== 五、日志与异常定位 ========== */
function checkLog() {
  const out = [];
  const p = path.join(ROOT, 'data', 'bot-out.log');
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch {
    out.push(it(G_LOG, '运行日志', false, 'bot-out.log 读不到', '她从来没启动过？双击「启动」'));
    return out;
  }
  const all = raw.split('\n');
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (/后端已启动/.test(all[i])) { start = i; break; }
  const lines = all.slice(start).slice(-3000);

  const crash = lines.filter(l => /\[merge\] 处理出错|\[fatal\]|UnhandledPromiseRejection/.test(l));
  const vars = [...new Set(crash.map(l => (l.match(/([A-Za-z_$][\w$]*) is not defined/) || [])[1]).filter(Boolean))];
  out.push(it(G_LOG, '消息处理异常', crash.length === 0,
    crash.length ? crash.length + ' 次（那几轮她直接没回话）' + (vars.length ? '：变量 ' + vars.join('、') + ' 不存在' : '')
      : '上次启动后 ' + lines.length + ' 行里 0 次',
    vars.length ? '代码里用了不存在的变量 ' + vars.join('、') + '，按日志最后一条的行号改' : '看 data/bot-out.log 里 [merge] 那几行'));

  const down = lines.filter(l => /\[llm\] .*(连不上|超时)|429|130\d\b/.test(l));
  const degrade = lines.filter(l => /已切到|先走备用/.test(l)).length;
  out.push(it(G_LOG, '模型链路异常', down.length === 0,
    down.length ? down.length + ' 次连不上/限流，降级 ' + degrade + ' 次' : '没有异常',
    '限流会自己恢复；一直限流就在面板换主模型', down.length ? 'warn' : undefined));

  const empty = lines.filter(l => /返回空|正文为空|no content/i.test(l)).length;
  out.push(it(G_LOG, '空正文', empty === 0, empty ? empty + ' 次' : '没有',
    '思考型模型把 token 烧在思考上——把模型加进 config.llm.noThinkModels', empty ? 'warn' : undefined));

  const st = readJson('data/bot-status.json') || {};
  const ageMin = st.at ? (Date.now() - Date.parse(st.at)) / 60000 : 9999;
  // 新鲜度只当提醒：状态文件是「连接变化时」才写，连得好好的可能几十分钟不动，那不是毛病。
  // 真正算错的是 online=false（NapCat 断了 / 进程没了）。
  // v88（主人 2026-10-23 报的 bug：一直开着 启动.bat 却掉线）：进程一死，状态文件就冻在最后一刻，
  // 里面还写着 online:true —— 只看文件会误判「在线」。所以对着里面的 pid 探一下，
  // 探不到就是「进程真没了、窗口还开着」，这条必须报错。
  let pidAlive = null;
  if (st.pid) {
    try { process.kill(st.pid, 0); pidAlive = true; }
    catch (e) { pidAlive = e && e.code === 'EPERM'; }
  }
  const stateOk = !!st.online && pidAlive !== false;
  out.push(it(G_LOG, '运行状态', stateOk,
    pidAlive === false ? '进程已经退了（pid ' + st.pid + ' 不在了）——启动窗口可能还开着，光看窗口看不出掉线'
      : st.online ? '在线（状态 ' + ageMin.toFixed(0) + ' 分钟前写过' + (pidAlive === true ? '，进程 ' + st.pid + ' 在跑' : '') + '）'
        : '离线：' + (st.detail || '没连上 NapCat'),
    '进程没了或离线：node selfcheck.js --restart，或关掉窗口重新双击「启动」',
    stateOk ? (ageMin > 120 ? 'warn' : undefined) : 'error'));

  const thinkMs = st.thinking && st.thinkingAt ? Date.now() - Date.parse(st.thinkingAt) : 0;
  if (thinkMs > 180000) {
    out.push(it(G_LOG, '思考状态', false, '「正在想答案」卡了 ' + Math.round(thinkMs / 60000) + ' 分钟',
      '进程多半已经没了：node selfcheck.js --restart'));
  }

  // 最近 2 小时「收到几条 / 说出几条」——她到底是没收到，还是收了不回
  try {
    const rows = String(fs.readFileSync(path.join(ROOT, 'data', 'chat-log.jsonl'), 'utf8'))
      .split('\n').filter(l => l.trim()).slice(-400);
    const since = Date.now() - 2 * 3600 * 1000;
    let got = 0, sent = 0;
    for (const r of rows) {
      const t = Date.parse(String(r).slice(0, 24));
      if (!(t >= since)) continue;
      if (/\[qq\]\[[^\]]+\]\[虚幻\]/.test(r)) sent++; else got++;
    }
    out.push(it(G_LOG, '最近 2 小时说话量', got === 0 || sent > 0,
      '收到 ' + got + ' 条 / 她说 ' + sent + ' 条',
      got > 0 && sent === 0 ? '收得到却不说话 → 99% 是被暂停、或每轮都在抛异常（看上面「消息处理异常」）' : '',
      got > 0 && sent === 0 ? 'warn' : undefined));
  } catch { }

  const mb = sizeMB('data/bot-out.log');
  out.push(it(G_LOG, '日志体积', mb >= 0 && mb < 8, mb.toFixed(1) + ' MB', '偏大，建议裁到最近 2000 行', 'warn'));
  return out;
}

/* ========== 统一入口 ========== */
async function runAll(opts) {
  const o = opts || {};
  const cfg = configStore.cfgLive() || {};
  const out = [];
  const push = xs => { for (const x of xs || []) out.push(x); };

  push(checkEnv());
  push(checkConfig());
  if (o.net !== false) {
    try { push(await checkNet(cfg)); }
    catch (e) { out.push(it(G_NET, '网络检查', false, String(e.message).slice(0, 80), '网络检查自己出错了')); }
  }
  try { push(await checkCore(o)); }
  catch (e) { out.push(it(G_CORE, '核心检查', false, String(e.message).slice(0, 80), '核心检查自己出错了')); }
  push(checkLog());
  return out;
}

function summarize(items) {
  const err = items.filter(x => !x.ok && x.level === 'error').length;
  const warn = items.filter(x => !x.ok && x.level === 'warn').length;
  const ok = items.filter(x => x.ok).length;
  return { total: items.length, ok, err, warn, pass: err === 0 };
}

module.exports = { runAll, summarize, checkEnv, checkConfig, checkNet, checkCore, checkLog, GROUPS: [G_ENV, G_CFG, G_NET, G_CORE, G_LOG] };

/* ===== 命令行入口（给「自检」用，bat 里不写中文路径，避免 cmd 编码踩坑）=====
 *   node checks.js            直接跑一遍五类，打印摘要
 *   node checks.js -v         打印全部项
 *   node checks.js --report   打印上次深度巡检的「人话版」报告
 *   node checks.js --auto     打印机器人自己定位到的问题
 */
if (require.main === module) {
  const arg = process.argv[2] || '';
  const read = p => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };
  if (arg === '--report') {
    const t = read('data/自检报告.md');
    console.log(t || '还没有报告：先跑一次深度巡检。');
  } else if (arg === '--auto') {
    const t = read('data/auto-check-latest.json');
    if (!t) { console.log('机器人还没自己发现过问题（自动定位只在她自查到毛病时才跑）。'); process.exit(0); }
    try {
      const r = JSON.parse(t);
      console.log('自动定位时间：' + String(r.t || '').replace('T', ' ').slice(0, 19));
      console.log('总 ' + r.summary.total + ' 项 / 通过 ' + r.summary.ok + ' / 错误 ' + r.summary.err + ' / 警告 ' + r.summary.warn);
      for (const x of (r.items || [])) console.log('- [' + x.g + '] ' + x.name + '：' + x.detail + (x.fix ? ' → ' + x.fix : ''));
    } catch { console.log('自动定位报告格式坏了，删掉 data/auto-check-latest.json 会重新生成。'); }
  } else {
    runAll({ initCore: true }).then(items => {
      const s = summarize(items);
      for (const g of [G_ENV, G_CFG, G_NET, G_CORE, G_LOG]) {
        const gs = items.filter(x => x.g === g && (arg === '-v' || !x.ok));
        if (!gs.length) continue;
        console.log('\n【' + g + '】');
        for (const x of gs) console.log('  ' + (x.ok ? '✓' : (x.level === 'error' ? '✗' : '!')) + ' ' + x.name + ' — ' + x.detail + (!x.ok && x.fix ? ' → ' + x.fix : ''));
      }
      console.log('\n' + s.total + ' 项：通过 ' + s.ok + '，错误 ' + s.err + '，警告 ' + s.warn);
      process.exitCode = s.pass ? 0 : 1;
    }).catch(e => { console.log('检查自己出错了：' + e.message); process.exitCode = 1; });
  }
}
