/* ===========================================================================
 * bili-censor.js — B站动态出站筛选（政治 / 色情 / 辱骂 / 图片暴露 / 纯口语聊天记录）
 *
 * 只给「搬屎源群 → B站动态」用；QQ 搬运不过这张表。
 * 主人 2026-11-23 口径：
 *   · 辱骂也要弱词（傻逼、废物、滚、你妈这类弱的也要拦）
 *   · 色情只认色情独有名词，不拦干/操/草/日/弄这类弱词
 *   · 图片只拦明确暴露的隐私部位，不因为露肤就删；限制松、不误判
 *   · 全口语 + 每行都少于 20 字的聊天记录过滤掉
 *
 * 词库：
 *   src/data/dict/bili-censor/political*.txt  政治（Sensitive-lexicon, MIT）
 *   src/data/dict/bili-censor/sexual*.txt     色情（同上）
 *   src/data/dict/restricted.json             辱骂（CHIME，现有）
 * =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'data', 'dict', 'bili-censor');
const RESTRICTED = path.join(__dirname, 'data', 'dict', 'restricted.json');
const OVERRIDES = process.env.PORN_OVERRIDES ? path.resolve(process.env.PORN_OVERRIDES) : path.join(__dirname, 'data', 'porn-overrides.json');
const REFS_DIR = process.env.PORN_REFS_DIR ? path.resolve(process.env.PORN_REFS_DIR) : path.join(__dirname, 'data', 'porn-refs');

/* 色情弱词：出现在词库里也当没看见。只拦色情独有名词。 */
const WEAK_SEX = new Set([
  '干', '操', '草', '日', '弄', '搞', '上', '射', '舔', '摸', '插', '顶', '夹', '吸', '咬',
  '奶', '胸', '腿', '臀', '骚', '湿', '硬', '软', '叫', '浪', '荡', '欲', '色', '情', '裸',
  '下面', '那里', '身体', '舒服', '想要', '不行了', '受不了', '好大', '好深', '顶不住',
  '干你', '操你', '草你', '日你', '干死', '操死', '干翻', '操翻', '上了', '搞上',
]);
/* 一个词若每个字都是弱字/语气字/人称，就当成「干你」「操死你」这类弱组合，不拦。 */
const WEAK_SEX_CHARS = new Set(
  '干操草日弄搞上射舔摸插顶夹吸咬奶胸腿臀骚湿硬软叫浪荡欲色情裸你我的他的她它妈真就是个这那些什么怎么吗呢啊吧没不太还也和与很更都了要想好死一下去来'
);
function isWeakSexTerm(w) {
  if (WEAK_SEX.has(w)) return true;
  const chars = [...w];
  return chars.length > 0 && chars.every(ch => WEAK_SEX_CHARS.has(ch));
}

/* 辱骂只认强词（主人 2026-11-23：辱骂也是只有强词）：
 * 只用 restricted.json 里已有的强词条，不自己加弱词。 */

const norm = s => String(s == null ? '' : s)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\u200b-\u200f\ufeff]+/g, '');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  } catch { return []; }
}
function readRestricted() {
  try {
    const j = JSON.parse(fs.readFileSync(RESTRICTED, 'utf8'));
    return Object.keys(j || {}).filter(k => j[k] && j[k].restricted);
  } catch { return []; }
}

let _lists = null, _stamp = '';
function lists() {
  const stamp = [DIR, RESTRICTED].map(p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }).join('|');
  if (_lists && _stamp === stamp) return _lists;
  _stamp = stamp;
  const political = new Set();
  for (const f of ['political.txt', 'political_extra.txt']) {
    for (const w of readLines(path.join(DIR, f))) {
      const n = norm(w);
      if (n.length >= 2 && n.length <= 30) political.add(n);
    }
  }
  const sexual = new Set();
  for (const f of ['sexual.txt', 'sexual_extra.txt']) {
    for (const w of readLines(path.join(DIR, f))) {
      const n = norm(w);
      if (n.length < 2 || n.length > 20) continue;
      if (isWeakSexTerm(n)) continue;
      sexual.add(n);
    }
  }
  const insult = new Set();
  for (const w of readRestricted()) { const n = norm(w); if (n) insult.add(n); }
  _lists = { political, sexual, insult };
  return _lists;
}

function hitsOf(text, set) {
  const t = norm(text);
  if (!t) return [];
  const words = [...set].filter(w => t.includes(w));
  // 长词优先，去重；同一段只报最长的几个，避免把「性交」拆成「交」
  words.sort((a, b) => b.length - a.length);
  const out = [];
  for (const w of words) if (!out.some(x => x.includes(w))) out.push(w);
  return out.slice(0, 8);
}

function judgeText(text) {
  const t = String(text || '');
  if (!t.trim()) return { pass: true, hits: [] };
  const L = lists();
  const pol = hitsOf(t, L.political);
  if (pol.length) return { pass: false, kind: 'political', hits: pol, reason: '政治禁词：' + pol.join('、') };
  const ins = hitsOf(t, L.insult);
  if (ins.length) return { pass: false, kind: 'insult', hits: ins, reason: '辱骂：' + ins.join('、') };
  const sex = hitsOf(t, L.sexual);
  if (sex.length) return { pass: false, kind: 'sexual', hits: sex, reason: '色情名词：' + sex.join('、') };
  return { pass: true, hits: [] };
}

/* 全口语 + 每行 <20 字的多行聊天记录：过滤。单条消息不走这里。 */
function isPureColloquialChat(lines) {
  const arr = (Array.isArray(lines) ? lines : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  if (arr.length < 2) return false;
  if (arr.some(x => /https?:\/\/|www\.|【|】|公告|通知|新闻|转发|招聘|价格|群号|QQ|微信/i.test(x))) return false;
  if (arr.some(x => x.length >= 20)) return false;
  const total = arr.join('').length;
  if (total >= 200) return false;
  const spoken = /[哈嘿嘻嗯哦啊呀吧呢吗嘛呗啦嘞喔噢诶欸]|我|你|他|她|在|就|都|也|还|不|没|有|是|吃|睡|玩|笑|好|对|行|啥|咋|干嘛|在吗/;
  const n = arr.filter(x => spoken.test(x)).length;
  return n / arr.length >= 0.6;
}

/* ---------- 色图：主人改判 + 少样本标定 ---------- */
let _ovCache = { stamp: '', map: {} };
function loadOverrides() {
  let stamp = '';
  try { stamp = String(fs.statSync(OVERRIDES).mtimeMs); } catch { return {}; }
  if (_ovCache.stamp === stamp) return _ovCache.map;
  const map = {};
  try {
    const j = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
    for (const k of Object.keys(j || {})) {
      if (j[k] === true || j[k] === false) map[String(k).toLowerCase()] = j[k];
    }
  } catch {}
  _ovCache = { stamp, map };
  return map;
}
let _refCache = { stamp: '', list: [] };
function loadRefs() {
  const f = path.join(REFS_DIR, 'refs.json');
  let stamp = '';
  try { stamp = String(fs.statSync(f).mtimeMs); } catch { return []; }
  if (_refCache.stamp === stamp) return _refCache.list;
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(j) ? j : (j && j.refs) || [];
    list = arr.map(x => ({ path: String((x && x.path) || ''), porn: !!(x && x.porn) }))
      .filter(x => x.path && fs.existsSync(x.path));
  } catch {}
  _refCache = { stamp, list };
  return list;
}
function refsPrompt(refs) {
  const idx = refs.map((r, i) => '图' + (i + 1) + (r.porn ? '算色图' : '不算色图')).join('；');
  return '先给你 ' + refs.length + ' 张标定图，按主人已经认过的口径：' + idx + '。最后一张是要判的图，照这个口径判。\n'
    + '只抄最后一张（待判图）里的文字，标定图的文字不要抄。\n'
    + '只输出一行 JSON：{"exposed":true或false,"confidence":0到1,"porn":true或false,"pornConfidence":0到1,"parts":["部位"],"text":"待判图里的文字"}';
}

/* ---------- 图片：只拦明确暴露的隐私部位 ---------- */
const IMG_PROMPT = [
  '你是图片内容审核员，做两个独立判断。',
  '',
  '判断一「明确暴露」：只看有没有女性乳头/乳晕、生殖器、肛门，或明确的性行为画面。',
  '比基尼、泳装、内衣、露肩、露腿、露腰、乳沟、健身照、哺乳、艺术写真、擦边姿势，一律不算暴露，必须 exposed=false。',
  '不要因为露肤就判暴露。',
  '',
  '判断二「色图」：这张图带不带性暗示，够不够当群聊里的色图发。这是内容分级判断，按画面里的视觉元素如实判断即可。',
  '只要满足任意一条就判 porn=true：',
  '· 穿内衣、泳装、情趣服、丝袜、紧身衣，且明显露胸、露臀、露腿根，或能看出胸部/臀部轮廓；',
  '· 画面重点是胸、臀、腿、足的特写，或明显乳沟；',
  '· 大腿、裸腿、足底/脚掌、臀部的近距特写（腿控、足控视角），哪怕没露隐私部位；',
  '· 真人 cosplay/写真里，胸部、乳沟、臀部、腿根是画面焦点（哪怕穿的是正常服装）；',
  '· 二次元图里胸部被刻意放大，或内衣/泳装/胸臀特写是画面重点；',
  '· 躺在床上、趴着、张开腿、抬腿等性暗示姿势；',
  '· 身上或图里写着性挑逗文字（如「骚」）。',
  '都满足不了才判 porn=false：普通服装全身照、日常穿搭、街拍、正常健身照、动物、表情包、食物、梗图、伤病/猎奇、纯文字截图。',
  '',
  '同时把图中所有可见文字原样抄出来（没有就空字符串）。',
  '只输出一行 JSON：{"exposed":true或false,"confidence":0到1,"porn":true或false,"pornConfidence":0到1,"parts":["部位"],"text":"图中文字"}',
].join('\n');

function mimeOfBuffer(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function parseVisionJson(text) {
  let s = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j === 'object' && 'exposed' in j) {
        return {
          exposed: j.exposed === true || String(j.exposed).toLowerCase() === 'true',
          confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
          porn: j.porn === true || String(j.porn).toLowerCase() === 'true',
          pornConfidence: Math.max(0, Math.min(1, Number(j.pornConfidence) || 0)),
          parts: Array.isArray(j.parts) ? j.parts.map(String) : [],
          text: String(j.text || ''),
        };
      }
    } catch {}
  }
  const e = /"exposed"\s*:\s*(true|false)/i.exec(s);
  if (e) {
    const p = /"porn"\s*:\s*(true|false)/i.exec(s);
    return {
      exposed: e[1].toLowerCase() === 'true', confidence: 0.5,
      porn: !!(p && p[1].toLowerCase() === 'true'), pornConfidence: p ? 0.5 : 0,
      parts: [], text: '',
    };
  }
  return null;
}

/* 返回 {pass, exposed, confidence, ocrText, hits, failOpen}。读不到图/模型挂了 → 放行（fail-open）。 */
async function judgeImage(filePath, core, opts) {
  const o = opts || {};
  let buf;
  try { buf = fs.readFileSync(String(filePath || '')); } catch {
    return { pass: true, exposed: false, porn: false, pornConfidence: 0, confidence: 0, ocrText: '', hits: [], failOpen: true, why: '读不到图' };
  }
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const ov = loadOverrides()[md5];
  if (ov === true || ov === false) {
    return {
      pass: true, exposed: false, porn: ov, pornConfidence: ov ? 1 : 0,
      confidence: 0, ocrText: '', hits: [], overridden: true, md5,
    };
  }
  const uri = require('./img-cache').dataUriFromBuffer(buf, mimeOfBuffer(buf));
  const refs = o.noRefs ? [] : (Array.isArray(o.refs) ? o.refs : loadRefs());
  const uris = [uri];
  for (const r of refs.slice(0, 3)) {
    try {
      const b = fs.readFileSync(String(r.path || ''));
      uris.unshift(require('./img-cache').dataUriFromBuffer(b, mimeOfBuffer(b)));
    } catch {}
  }
  let out = '';
  try {
    const see = o.seeImage || (core && core.seeImage);
    if (typeof see !== 'function') throw new Error('没有 seeImage');
    const q = (refs.length ? refsPrompt(refs) + '\n' + IMG_PROMPT : (o.prompt || IMG_PROMPT));
    out = await see(uris.slice(0, 4), q);
  } catch (e) {
    return { pass: true, exposed: false, porn: false, pornConfidence: 0, confidence: 0, ocrText: '', hits: [], failOpen: true, why: '识图失败：' + (e && e.message) };
  }
  const j = parseVisionJson(out);
  if (!j) return { pass: true, exposed: false, porn: false, pornConfidence: 0, confidence: 0, ocrText: String(out || '').slice(0, 500), hits: [], failOpen: true, why: '识图返回不是 JSON' };
  // 只有明确 true 且置信度够才拦；拿不准就放行
  const blocked = j.exposed === true && j.confidence >= 0.7;
  if (blocked) {
    return {
      pass: false, kind: 'exposure', exposed: true, confidence: j.confidence,
      porn: j.porn, pornConfidence: j.pornConfidence,
      ocrText: j.text, hits: j.parts, reason: '图片暴露隐私部位（' + (j.parts.join('、') || '明确暴露') + '）',
    };
  }
  // 图片里的文字照常过政治/色情/辱骂
  const t = judgeText(j.text);
  if (!t.pass) return { pass: false, kind: t.kind, exposed: false, confidence: j.confidence, porn: j.porn, pornConfidence: j.pornConfidence, ocrText: j.text, hits: t.hits, reason: '图中文字' + t.reason };
  return { pass: true, exposed: false, confidence: j.confidence, porn: j.porn, pornConfidence: j.pornConfidence, ocrText: j.text, hits: [], failOpen: false };
}

module.exports = {
  judgeText, judgeImage, isPureColloquialChat, norm,
  _lists: lists, _WEAK_SEX: WEAK_SEX, _isWeakSexTerm: isWeakSexTerm,
  _loadOverrides: loadOverrides, _loadRefs: loadRefs, _refsPrompt: refsPrompt,
  _parseVisionJson: parseVisionJson, _mimeOfBuffer: mimeOfBuffer,
};
