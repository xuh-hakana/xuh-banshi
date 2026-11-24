'use strict';
/* ===========================================================================
 * anchor.js —— 本轮锚定（2026-11-25 主人令「别再说莫名其妙的话」）
 *
 * 真因（已查证）：历史行格式是「谁说: 内容」——**一个字的时间都没有**，
 * 而提示词还让人「继续往上翻 40 条」。2026-11-25 02:05 的一张旧表情和
 * 02:47 的一张新照片因此相邻出现在同一段上下文里，被拼成了一句话。
 *
 * 这份文件只做四件事：
 *   1) 历史渲染带时间：每行加「[02:47]」，超时加「（旧）」，本轮那条标「【本轮】」；
 *   2) 旧图描述降级：不是这一轮的图，描述换成「（旧图，不是这一轮；内容已省略）」；
 *   3) 启动/重连闸：进程起来或 NapCat 重连后一段时间只被动回复，不主动接话；
 *   4) 出口闸：非必回的一轮，回复里引用到旧图内容 → 不发（宁可不说）。
 *
 * 配置在 config/features.json 的 anchor 段，缺省即下面 DEFAULTS（改了立刻生效）。
 * =========================================================================== */
const FEATURES = require('./config');
const DEFAULTS = {
  // 超过多少分钟算「旧」：旧图和刚发的图在提示词里必须长得不一样
  staleMin: 10,
  // 启动/重连后多少秒内只被动回复（@她 / 私聊 / 指令 / 引用她）
  warmSec: 120,
  // 出口闸：非必回轮次引用了旧图内容就不发。false = 只记日志
  strict: true,
  // 旧图描述是否省略（关掉只加「（旧）」标记，描述保留）
  omitOldImages: true,
};

function conf() {
  let raw = null;
  try { raw = (FEATURES.cfgLive() || {}).anchor || null; } catch (e) { raw = null; }
  const c = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  c.staleMin = Math.max(1, Number(c.staleMin) || DEFAULTS.staleMin);
  c.warmSec = Math.max(0, Number(c.warmSec) || 0);
  c.strict = c.strict !== false;
  c.omitOldImages = c.omitOldImages !== false;
  return c;
}

/* ------------------------------------------------------------ 启动/重连闸 */
let _warmUntil = 0;
function markConnected() {
  const ms = conf().warmSec * 1000;
  _warmUntil = ms > 0 ? Date.now() + ms : 0;
  if (ms > 0) console.log('[anchor] 刚启动/重连：' + conf().warmSec + ' 秒内只被动回复，不主动接话');
}
function inWarm() { return _warmUntil > Date.now(); }
function warmLeftSec() { return Math.max(0, Math.ceil((_warmUntil - Date.now()) / 1000)); }

/* ------------------------------------------------------------ 时间标记 */
const pad2 = n => String(n).padStart(2, '0');
function hhmm(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* 图片描述的匹配：［图：xxxx］，描述里不会出现半角 ］ */
const IMG_BLOCK = /［图：[^］]*］/g;
const OLD_IMG = '（旧图，不是这一轮；内容已省略）';

function hasImage(s) { return /［图：/.test(String(s || '')); }

/* 把 getHist() 的条目渲染成「给模型看」的副本：不改原对象、不动原文，
 * 只在每行前面加时间锚，旧图描述换掉。返回新数组。 */
function renderHistory(entries) {
  const c = conf();
  const list = Array.isArray(entries) ? entries : [];
  const now = Date.now();
  const staleMs = c.staleMin * 60 * 1000;
  // 本轮 = 最后一条 user（qq.js 先把这一轮 push 进历史，再 buildMessages）
  let curIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') { curIdx = i; break; }
  }
  return list.map((m, i) => {
    if (!m || typeof m !== 'object') return m;
    const ts = Number(m.ts) || 0;
    const age = ts ? (now - ts) : 0;
    const isCur = i === curIdx;
    const old = !isCur && ts > 0 && age > staleMs;
    let content = String(m.content == null ? '' : m.content);
    if (old && c.omitOldImages && hasImage(content)) content = content.replace(IMG_BLOCK, OLD_IMG);
    // 时间锚：本轮写「【本轮 · 02:47】」，旧话写「（02:05 · 旧）」，其余写「[02:47]」
    let mark;
    if (isCur) mark = '【本轮 · ' + hhmm(ts || now) + '】';
    else if (old) mark = '（' + hhmm(ts) + ' · 旧）';
    else mark = '[' + hhmm(ts || now) + ']';
    const offline = m.offline ? '（离线前）' : '';
    return Object.assign({}, m, { content: mark + offline + ' ' + content });
  });
}

/* 给提示词看的那段规则（只有真链路拼；无场景/自检不加） */
function rulesText() {
  const c = conf();
  return '## 本轮锚定（先分清哪句是这一轮，再开口）\n'
    + '- 只有标着 **【本轮】** 的那一条是这一轮要回的话；其余都是背景。\n'
    + '- 标 **（旧）** 的是 ' + c.staleMin + ' 分钟以前的话，可以当背景理解，但**不许当成本轮内容去回应**，'
    + '也不许把它的内容和本轮的话拼成一句。\n'
    + '- 旧图只留一句「（旧图，不是这一轮；内容已省略）」：**不许猜它画了什么**，更不许把它和本轮的图说成同一件事。\n'
    + '- 一轮只说一件事：回谁就回谁，别把两个人的图、两句话揉进一句。\n'
    + '- 拿不准对方在说什么，就问一句；不许编。';
}

/* ------------------------------------------------------------ 出口闸 */
// 常被图片描述用到的通用词，不能当「旧图特征」比对
const GENERIC = new Set(['图上', '图片', '图片来源', '情绪', '发图人', '可能', '是什么', '内容', '没有',
  '文字', '无字', '一张', '这是', '一张图片', '表情包', '卡通', '动漫', '风格', '背景', '角色', '照片',
  '对方', '发了', '图里', '看到', '卡通形象', '图片中', '图片里', '一样', '东西', '像是', '似乎']);

/* 从一段图片描述里抽「特征词」：连续中文 2~6 字，去掉通用词与数字。
 * 只用来判断「回复是不是在说这张旧图」，不追求覆盖全部。 */
function featuresOf(desc) {
  const s = String(desc || '').replace(/［图：|］/g, '');
  const out = new Set();
  // 描述里常是「有猫耳，长灰发」这种连写：整段不是词，得拆成 2~4 字的片段才比得中
  const FUNC = /^[的了是在和与就都也很有个这那张只把被给对从到为说着过还又]+$/;
  for (const seg of s.split(/[^\u4e00-\u9fa5]+/)) {
    if (seg.length < 2) continue;
    const run = seg.slice(0, 24);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        if (GENERIC.has(g) || FUNC.test(g)) continue;
        out.add(g);
      }
    }
  }
  return out;
}

/* 非必回的一轮，回复里出现了「旧图特征词」→ 判定串图。
 * currentText = 这一轮真正带进来的文字（含本轮图描述）；history = 原始历史条目数组。
 * 返回 { leak:boolean, hit:[...] }。 */
function imageLeak(reply, currentText, history) {
  const c = conf();
  if (!c.strict) return { leak: false, hit: [] };
  const cur = String(currentText || '');
  const curImg = (cur.match(IMG_BLOCK) || []).join(' ');
  const curFeat = featuresOf(curImg);
  const text = String(reply || '');
  // 说图的话里常带指代（那只/这张图/照片…）：有指代时，两字特征也算数
  const imgCue = /这张图|那张图|这个图|那个图|图上|图里|图中|照片|画面|那只|这只|那个小|这个小|表情/.test(text);
  const hit = [];
  for (const m of (Array.isArray(history) ? history : [])) {
    if (!m || m.role !== 'user') continue;
    const mc = String(m.content || '');
    if (!hasImage(mc)) continue;
    const imgs = mc.match(IMG_BLOCK) || [];
    for (const img of imgs) {
      if (curImg && curImg.indexOf(img) >= 0) continue;      // 就是本轮那张，跳过
      for (const f of featuresOf(img)) {
        if (curFeat.has(f)) continue;                        // 本轮图里也有这个词，不算串
        if (text.indexOf(f) < 0) continue;
        if (f.length >= 3) hit.push(f);
        else if (imgCue || hit.length) hit.push(f);   // 两字词：有图指代 / 已命中一条，才算
      }
    }
  }
  return { leak: hit.length > 0, hit: hit.slice(0, 5) };
}

module.exports = {
  DEFAULTS, conf, markConnected, inWarm, warmLeftSec,
  hhmm, hasImage, renderHistory, rulesText, featuresOf, imageLeak, OLD_IMG,
};
