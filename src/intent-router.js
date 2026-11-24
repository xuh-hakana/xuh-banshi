'use strict';
/* ===========================================================================
 * intent-router.js —— 派活判定（主人 2026-11-22 定稿，第二次改：砍掉分类器）
 *
 * 判定（2026-11-23 主人改：「我和其他好感大于100的人应该优先喊出 dsh agent」）：
 *   ① 这条消息是真 @ 她（不是引用、不是自动接话）；
 *   ② 说话人好感 ≥ whitelistFavor（默认 100；主人的号好感锁满，所以不用单独放行）。
 *   两条同时成立就派活，不再要求命中词表——高好感的人 @ 她就是喊 agent 出来接管。
 * 旧规则（2026-11-22）：还要命中词表（搜/查/核实/评分… 或 算/多少/像素…）才派，
 *   「不中词的 @ 不派」。主人 11-23 作废了这条：像「你触发什么关键词了」这种问机器人
 *   自身机制的话，词表里的搜/查都命中不了，结果被当闲聊走联网搜、免费模型瞎答——
 *   这类话本就该让 dsh agent 读自己的配置回答，所以改成高好感 @ 一律派。
 * 没 @ 的消息仍然一条都不派，保持闲聊零干扰。negate 否决词（别搜/别查/开玩笑）仍优先。
 *
 * 为什么不用 ONNX 分类器了（2026-11-22 实测）：
 *   zh-setfit-v2 是「AI 编码代理」专用路由器，判的域是 coding/ops；
 *   而这里要判的是「要不要联网搜/算」，域不对；真实群 145 条里它对闲聊过度自信
 *   （47 条 ≥0.70 落 coding/ops）。分类器产物已停用，worker 不再启动（省 117MB / 2.5s 冷启）。
 *
 * 词表在面板上直接改：src/config/intent.json 的 intent.words，热读（mtime），
 * 面板走 /api/intent/words 写回（原子写：临时文件 + rename）。代码里不许内置第二份。
 *
 * 落点：qq.js handleTurn 里调用 gate()，判到活就把 agentTurn:true 交给 core.chat；
 *       真正的「我」在 core.js 的模型链里（askOnce 拦截 dsh-agent）。
 * =========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'config', 'intent.json');

const DEFAULT_WORDS = { search: [], calc: [], negate: [] };
const stats = { gateCalls: 0, work: 0, chat: 0, reasons: {} };

/* 配置：每次现读（cfgLive 按 mtime 热读），读不到就当没开。绝不抛异常。 */
function conf() {
  let it = null;
  try {
    const c = require('./config');
    const live = (typeof c.cfgLive === 'function') ? c.cfgLive() : c.load();
    it = live && live.intent;
  } catch (e) { it = null; }
  if (!it) {
    try { it = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).intent; } catch (e) { it = null; }
  }
  const src = (it && typeof it === 'object') ? it : {};
  const words = (src.words && typeof src.words === 'object') ? src.words : DEFAULT_WORDS;
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    enabled: src.enabled !== false,
    whitelistFavor: num(src.whitelistFavor, 100),
    agentTurnOnHit: src.agentTurnOnHit !== false,
    // 深度私聊派给 dsh agent（2026-11-25）：主人私聊的长思辨题不 @ 也派，
    // 由 DSH 的子 agent 各自带人设分视角答。置 false 可整条关掉。
    deepAsk: src.deepAsk !== false,
    words: { search: list(words.search), calc: list(words.calc), negate: list(words.negate) },
  };
}

function hitOf(text, list) {
  const s = String(text || '');
  for (const w of list) { if (w && s.indexOf(w) >= 0) return w; }
  return '';
}

/*
 * 判定入口。
 * opts.atMe    真 @ 她（qq.js 的 atMeReal）
 * opts.favor   说话人好感（people 里的 favor，缺省 0）
 * 返回 { action:'work'|'chat', reason, hit }
 * 任何异常 → chat（宁可不派，不能把闲聊送去干活）。
 */
/* 深度私聊判据：够长 + 带思辨/推理词。放在 gate 上面，便于单独测。 */
const DEEP_WORDS = /(为什么|怎么理解|是不是|会不会|如果|假设|推理|真相|理论|观点|有没有|该怎么)/;
function isDeepAsk(text) {
  const s = String(text || '').trim();
  return s.length >= 80 && DEEP_WORDS.test(s);
}

function gate(text, opts) {
  const o = opts || {};
  let c;
  try { c = conf(); } catch (e) { return { action: 'chat', reason: 'conf-error', hit: '' }; }
  stats.gateCalls++;
  const out = (action, reason, hit) => {
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    if (action === 'work') stats.work++; else stats.chat++;
    return { action, reason, hit: hit || '' };
  };
  if (!c.enabled) return out('chat', 'disabled');
  const t = String(text || '');
  if (!t.trim()) return out('chat', 'empty');
  /* 深度私聊（2026-11-25）：主人私聊里的长思辨题（「四层真相」那种）不 @ 也交给 dsh agent，
   * 让子 agent 各自带人设分视角推理。判据三条同时成立：私聊 + 主人 + 够长且带思辨词。
   * 普通长句、带图、引用都不走这条（qq.js 传进来的 quoted/hasImg 不看，这里只管文本长度与词）。 */
  if (c.deepAsk && o.isPrivate && o.isMaster && isDeepAsk(t)) return out('work', 'deep-ask');
  if (!o.atMe) return out('chat', 'no-at');                       // 没 @ 她：一律不派
  if (Number(o.favor) < c.whitelistFavor) return out('chat', 'not-white');
  const neg = hitOf(t, c.words.negate);
  if (neg) return out('chat', 'negate:' + neg);
  const hit = hitOf(t, c.words.search) || hitOf(t, c.words.calc);
  // 2026-11-23 改：词表命中不再是派活前提，只是顺手记下 hit 供日志显示。
  // 高好感 + 真 @ 已经满足 → 无条件派活（原来不中词在这里 return 'no-word' 不派）。
  // 这样「你触发什么关键词了」这类问自身机制的话也交给 dsh agent，而不是联网瞎搜。
  return out('work', hit ? 'word:' + hit : 'high-favor-at', hit);
}

/* 词表读写（面板 /api/intent/words 用）。原子写，坏数据一律拒绝。 */
function words() { return conf().words; }

function saveWords(next) {
  if (!next || typeof next !== 'object') throw new Error('词表格式不对');
  const clean = {};
  for (const k of ['search', 'calc', 'negate']) {
    const v = next[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) throw new Error(k + ' 要是数组');
    clean[k] = v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error('intent.json 读不了：' + e.message); }
  j.intent = j.intent || {};
  j.intent.words = Object.assign({}, j.intent.words || {}, clean);
  const tmp = CONFIG_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return conf().words;
}

/* 面板「机器人 → dsh agent」卡用：一次取出模式 + 词表 + 兜底句（全部热读） */
function cfg() {
  const c = conf();
  let full = {};
  try { full = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).intent || {}; } catch (e) { full = {}; }
  return {
    enabled: c.enabled,
    whitelistFavor: c.whitelistFavor,
    mode: full.mode || {},
    words: c.words,
    failText: String(((full.agent || {}).failText) || ''),
  };
}

/* 保存模式开关 / 兜底句（只接受已知键，原子写） */
function saveCfg(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('配置格式不对');
  let j;
  try { j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error('intent.json 读不了：' + e.message); }
  j.intent = j.intent || {};
  const MODE_KEYS = ['webOkWho', 'webMissWho', 'dispatchPersona', 'dispatchFail', 'chatPersona', 'chatFail', 'webSources'];
  if (patch.mode && typeof patch.mode === 'object') {
    j.intent.mode = j.intent.mode || {};
    for (const k of MODE_KEYS) if (patch.mode[k] !== undefined) j.intent.mode[k] = patch.mode[k];
  }
  if (patch.failText !== undefined) {
    j.intent.agent = j.intent.agent || {};
    const t = String(patch.failText || '').trim();
    if (t) j.intent.agent.failText = t;
  }
  const tmp = CONFIG_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return cfg();
}

function status() {
  const c = conf();
  return { enabled: c.enabled, whitelistFavor: c.whitelistFavor, words: {
    search: c.words.search.length, calc: c.words.calc.length, negate: c.words.negate.length,
  }, stats };
}

module.exports = { gate, words, saveWords, cfg, saveCfg, status, ROOT, CONFIG_FILE };
