/* ===== 自查（主人 2026-10-23 凌晨定）=====
 * 「以前版本有的功能，后来删除或 bug 了，她会私信提醒我」——
 * 定期体检：配置/必备文件/梗库/表情单/模型连通性，坏一项记一项；
 * 同一个问题**攒够 10 分钟还在**才发一条私信（和缺表情提醒一个节奏，不刷屏）；
 * 修好之前每 60 分钟再提一次，修好安静。
 * 提醒的口吻是她自己的（发给主人私聊，由 bot.js 接 sendPrivate）。
 *
 * v76（主人 2026-10-23 定）：自查发现的问题**必须同时进她的反馈**（data/ai-feedback.jsonl），
 * 否则主人不盯私聊就永远看不到——面板「虚幻自查」页和状态栏读的就是这份反馈 + 这里的 state 文件。
 * 只在「刚坏」和「修好」两个时刻各记一条，中间不重复刷。
 */
const fs = require('fs');
const path = require('path');
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读取
const astrbotLlm = require('./llm-astrbot.js');   // AstrBot 接入：Key 在 AstrBot 配置里，llm.json 可为空

const ROOT = path.join(__dirname);
const HOLD_MS = 10 * 60 * 1000;          // 问题持续 10 分钟才提醒
const REMIND_EVERY = 60 * 60 * 1000;     // 还没修好的话，每小时提一次
const STATE_PATH = path.join(ROOT, 'data', 'selfwatch-state.json');   // 当前没解决的问题（面板读）

let timer = null;
let remind = null;                        // (text) => void
let feedback = null;                      // (kind, text) => void  —— 写进她的反馈（面板看）
let opts = { skip: [] };                  // 测试可跳过联网类探针
// key -> { since, desc, lastRemind }
const open = new Map();

/* ===== 自动触发的深度定位（主人 2026-10-23 要求）=====
 * 上面这些探针只负责「哪一块坏了」，报得很粗（「模型连不上」）。
 * 真要修，得知道「具体哪一项、怎么修」——所以探到问题就把共享引擎 checks.js 跑一遍，
 * 和手动 `node selfcheck.js --deep` 用的是同一份检查，两边结论永远一致。
 * 只在**真有问题**时跑（正常时一点不花），10 分钟最多一次，别把机器拖慢。
 */
let checks = null;
try { checks = require('./checks'); } catch { }
let lastLocate = 0;
let lastFix = [];

async function locate() {
  if (!checks) return [];
  try {
    const items = await checks.runAll({ initCore: 'auto', net: false });   // 在 bot 进程里：不重新 init、不探网络
    const s = checks.summarize(items);
    const bad = items.filter(x => !x.ok);
    try {
      fs.writeFileSync(path.join(ROOT, 'data', 'auto-check-latest.json'),
        JSON.stringify({ t: new Date().toISOString(), source: 'auto', summary: s, items: bad }, null, 1), 'utf8');
    } catch { }
    lastLocate = Date.now();
    return bad.slice(0, 3).map(x => '· ' + x.name + '：' + (x.fix || x.detail));
  } catch { return []; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; }
}
function fileOk(p, minLen) {
  try { return fs.statSync(path.join(ROOT, p)).size >= (minLen || 1); } catch { return false; }
}
function fb(kind, text) {
  try { if (feedback) feedback(String(kind), String(text).slice(0, 300)); } catch { }
}
// 写 state 文件：面板据此显示「当前没解决的问题」，重启也不能丢（文件在，数据就在）
function saveState() {
  try {
    const list = [...open.entries()].map(([key, it]) => ({ key, desc: it.desc, since: new Date(it.since).toISOString() }));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ t: new Date().toISOString(), open: list }, null, 1), 'utf8');
  } catch { }
}

/* 每项探针返回 null = 正常，字符串 = 问题描述（说人话） */
function probeAll() {
  const bad = [];
  const skip = x => opts.skip.indexOf(x) >= 0;

  // 1. 配置与关键数据文件能解析、字段齐
  const cfg = configStore.cfgLive();
  if (!cfg) bad.push(['config', 'config.json 读不了或格式坏了']);
  else {
    // 2026-11-11（修）：AstrBot 接入模式下 Key 在 AstrBot 配置里，llm.json 的 apiKey 为空不算毛病
    const _keyEmpty = !cfg.llm || !cfg.llm.apiKey || String(cfg.llm.apiKey).includes('在这里填');
    if (_keyEmpty) {
      let aLive = false;
      try { aLive = astrbotLlm.list().length > 0; } catch { }
      if (!aLive) bad.push(['config', '模型 API Key 没填或被清掉了']);
    }
    if (!cfg.masterQQ) bad.push(['config', 'masterQQ 丢了，私聊遥控会失灵']);
    if (!cfg.botName) bad.push(['config', 'botName 丢了']);
  }
  for (const [p, name] of [['data/people-state.json', '称呼状态'], ['data/style-samples.json', '学说话样本']]) {
    // v76 修：以前只报「格式坏了」，文件整个不见了反而不吭声——丢文件也是毛病，要说清楚
    if (readJson(p) === null) {
      bad.push([name, fileOk(p)
        ? name + '（' + p + '）格式坏了，功能会用默认值'
        : name + '（' + p + '）不见了，功能会用默认值']);
    }
  }

  // 2. 必备文件在且非空（以前丢过的：笑点解析范例被存空过）
  if (!fileOk('soul/F-全场景通用主人设/虚幻.md', 200)) bad.push(['人设', '人设文件 soul/F-全场景通用主人设/虚幻.md 不见了或被清空——她就没有灵魂了']);
  // 人设按层切开（2026-11-21）：F 层基底少一块那段规矩就整段没了
  for (const f of ['soul/F-全场景通用主人设/1-性格.md', 'soul/F-全场景通用主人设/2-说话.md']) {
    if (!fileOk(f, 100)) bad.push(['人设', f + ' 不见了或被清空——人设缺一块，对应规矩全丢（从备份补回来）']);
  }
  // H 层应对正本 + 场合段各一份，缺一份那种场合就没规矩（命中也不注入）
  if (!fileOk('soul/H-全聊天/3-应对.md', 100)) bad.push(['人设', 'soul/H-全聊天/3-应对.md 不见了或被清空——应对语气底色丢了，空间评论/B站评论会没风格']);
  for (const f of ['soul/H-全聊天/应对/我-被夸.md', 'soul/H-全聊天/应对/我-被怪.md', 'soul/H-全聊天/应对/别人-被围观.md',
                   'soul/H-全聊天/应对/被提问-被需要.md', 'soul/H-全聊天/应对/被教会-学到了.md']) {
    if (!fileOk(f, 20)) bad.push(['人设', f + ' 不见了或被清空——这个场合的应对规矩全丢（从备份补回来）']);
  }
  if (!fileOk('data/笑点解析范例.md', 50)) bad.push(['笑点解析', '笑点解析范例丢了或被清空，笑点解析质量会掉']);
  if (!fileOk('data/stickers/常用.md', 20)) bad.push(['表情包', '场合表 data/stickers/常用.md 丢了，她一张表情都发不出']);
  if (!fileOk('data/网络热梗.md', 20)) bad.push(['热梗', '自有梗库 data/网络热梗.md 丢了']);
  if (!fileOk('data/梗词典.jsonl', 10000)) bad.push(['梗词典', '梗词典 data/梗词典.jsonl 丢了（自由搭话的关键词闸靠它）']);

  // 3. 梗库/情绪表情能解析（解析坏了 = 相关功能静默失效，这里提前揪出来）
  try {
    const guides = require('./guides');
    const own = guides.memeList ? guides.memeList().length : -1;
    if (own < 0) bad.push(['梗库', '自有梗库加载失败（guides.memeList 出错）']);
    else if (own < 1) bad.push(['梗库', '自有梗库是空的（data/网络热梗.md 一条都没有）']);
  } catch (e) { bad.push(['梗库', '梗库模块加载失败：' + e.message]); }
  {
    const dict = fs.readFileSync(path.join(ROOT, 'data', '梗词典.jsonl'), 'utf8').split('\n').filter(l => l.trim()).length;
    if (dict < 1000) bad.push(['梗词典', '梗词典只剩 ' + dict + ' 条（正常 1400+），检索会变笨']);
  }
  const emo = readJson('data/情绪表情.json');
  if (!Array.isArray(emo) || !emo.length) {
    bad.push(['情绪表情', fileOk('data/情绪表情.json')
      ? 'data/情绪表情.json 格式坏了（一栏情绪一栏触发词），纯情绪发言发不出对应表情'
      : 'data/情绪表情.json 不见了（一栏情绪一栏触发词），纯情绪发言发不出对应表情']);
  } else for (const e of emo) if (!e || !e.cat || !Array.isArray(e.words) || !e.words.length) { bad.push(['情绪表情', '情绪表情表里有不完整的条目（缺 cat 或 words），那条不生效']); break; }

  // 4. NapCat 连接（bot-status.json 由 qq.js 写，3 分钟内没更新 = 连接层出问题了）
  // 2026-11-13 主人令「只是 napcat 断连不要来提醒我」：重连期间 online=false 来回翻，
  // 每翻一次就写一条「发现问题 / 已恢复」，刷屏。单纯断连不算问题，去掉；
  // 进程没起来 / 心跳卡死是真问题，两条保留。
  if (!skip('napcat')) {
    const st = readJson('data/bot-status.json');
    if (!st || !st.at) bad.push(['连接', '读不到运行状态（data/bot-status.json），进程可能没起来']);
    else if (Date.now() - new Date(st.at).getTime() > 3 * 60 * 1000) bad.push(['连接', '状态超过 3 分钟没更新，连接层可能卡死了']);
  }

  // 5. 模型连通（每 6 轮探一次，一次小请求，别烧太多）
  if (!skip('llm')) {
    // 2026-11-13 主人令「我现在有本地模型，不可能出现全都没法用的情况」：
    // AstrBot 接入时 llm.json 的 apiKey 本来就是空的、模型链由 AstrBot 池动态填，
    // 这条粗探针只认 llm.json → 探谁都失败，误报「所有主备模型都失败」。
    // 2026-11-14 跟进：连「全部哑火」这类预言式告警也不要——探针失败 ≠ 真没回，
    // AstrBot 模式下整条探针跳过；非 AstrBot 模式下探针照跑但只做内部自保、不进 bad 列表。
    // 真有消息没回，由 qq.js 的未回复追踪精确报「哪条消息没回」（含原话），不靠猜。
    const astrbotMode = (() => { try { return astrbotLlm.list().length > 0; } catch { return false; } })();
    if (!astrbotMode) {
      _probeRound = (_probeRound + 1) % 6;
      if (_probeRound === 0) {
        _llmProbing = true;
        probeLLM(cfg).then(() => { _llmProbing = false; })
          .catch(() => { _llmProbing = false; });
      }
    }
  }
  return bad;
}
let _probeRound = 0, _llmBad = null, _llmProbing = false;

async function probeLLM(cfg) {
  try {
    const llm = (cfg && cfg.llm) || {};
    if (!llm.apiKey) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const models = [llm.model, ...(llm.fallbackModels || [])].filter(Boolean);
    for (const m of models.slice(0, 2)) {
      try {
        const res = await fetch(llm.endpoint || 'https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + llm.apiKey },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: ctrl.signal,
        });
        if (res.ok) { clearTimeout(timer); return true; }
      } catch {}
    }
    clearTimeout(timer);
    return false;
  } catch { return false; }
}

async function tick() {
  let bad;
  try { bad = probeAll(); } catch (e) { console.error('[自查] 探针出错', e.message); return; }
  const now = Date.now();

  // 自动触发定位：探到问题 → 把 details 跑出来（10 分钟最多一次）
  if (bad.length && now - lastLocate > 10 * 60 * 1000) {
    lastFix = await locate();
    if (lastFix.length) {
      fb('自查定位', '自动定位到最该先修的 ' + lastFix.length + ' 条：' + lastFix.map(x => x.replace(/^· /, '')).join('；').slice(0, 260));
    }
  }

  for (const [key, desc] of bad) {
    if (!open.has(key)) {
      open.set(key, { since: now, desc, lastRemind: 0 });
      fb('自查发现问题', desc);                 // 刚坏：立刻进她的反馈（面板看得见）
    } else open.get(key).desc = desc;
  }
  for (const [key, it] of [...open]) {
    if (!bad.some(([k]) => k === key)) {        // 修好了
      const mins = Math.round((now - it.since) / 60000);
      open.delete(key);
      fb('自查已恢复', it.desc + '（坏了 ' + (mins < 1 ? '不到 1' : mins) + ' 分钟，现在好了）');
      continue;
    }
    const held = now - it.since;
    if (held >= HOLD_MS && now - it.lastRemind >= REMIND_EVERY) {
      it.lastRemind = now;
      const mins = Math.round(held / 60000);
      const text = '主人，我自查到有个问题持续 ' + mins + ' 分钟了没好：「' + it.desc + '」。'
        + (lastFix.length ? '\n我自己定位了一下，最该先看这几条：\n' + lastFix.join('\n') : '')
        + '\n你看到了来修一下我，我先自己盯着。';
      try { if (remind) remind(text); } catch (e) { console.error('[自查] 提醒发送失败', e.message); }
    }
  }
  saveState();
}

function start(o) {
  opts = o && o.skip ? o : opts;
  remind = (o && o.remind) || remind;
  feedback = (o && o.feedback) || feedback;   // v76：面板「虚幻自查」的写入通道
  loadState();                                // 接着上次的记：重启后旧问题还在就能报「已恢复」，不会永远红着
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 5 * 60 * 1000);
  setTimeout(tick, 90 * 1000);           // 开机 90 秒先查一遍（等连接稳）
}
// 把上次进程里「还没解决」的问题接过来（面板不会因此长期显示已经修好的红卡）
function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {};
    for (const it of (st.open || [])) {
      if (!it || !it.key || open.has(it.key)) continue;
      open.set(it.key, {
        since: Date.parse(it.since) || Date.now(),
        desc: it.desc || '',
        lastRemind: Date.now(),        // 刚起来别立刻催主人，等下一个周期再说
      });
    }
  } catch { }
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, probeAll, saveState, locate, _lastFix: () => lastFix, _setOpts: o => { opts = o || opts; } };
