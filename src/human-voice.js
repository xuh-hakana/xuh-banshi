'use strict';
/* human-voice.js —— 「人类逻辑」语料（2026-11-22 主人定）
 *
 * 主人原话：「群里和b站的所有人类的发言，都是去ai味的参考。我的例句才是规范。」
 *   「我需要把『人类逻辑』和『虚幻逻辑』（撩人、让大家幸福、让别人觉得自己很重要）分开。
 *     先用人类逻辑过一遍去ai味，再虚幻逻辑过一遍加上可爱感。」
 *
 * 所以这个模块只做一件事：**同类场景下，真人是怎么说的**（给样本，不给规则）。
 * 语料来自 data/human-lines.json（从 chat-log 抽的真实群聊发言，已排除 bot 自己）。
 * 它不是「标准」，是「口气参考」；标准在 master-examples（主人例句的 why）。
 */

const path = require('path');
const fs = require('fs');

const FILE = path.join(__dirname, 'data', 'human-lines.json');
let _cache = null;

/* 场景判定：和抽语料时的关键词保持一套，别两处各写一份。 */
const SCENES = [
  ['doubt', /你是ai|是ai吧|机器人|人机|假的吧|骗人|真的假的|凭什么|滚|烦死|别发|污染|举报|笑死|就这|？{2,}|\?{2,}/i],
  ['care', /辛苦|别急|没事|注意身体|早点睡|抱抱|别累|小心|慢慢来|不着急/],
  ['explain', /因为|所以|其实|我是说|就是说|主要是|本来|不是那个意思/],
  ['joke', /草|哈哈哈|绷不住|乐了|笑死|6{2,}|牛|离谱/],
  ['thanks', /谢谢|感谢|多谢|好人|爱你/],
  ['daily', /^(好的?|行|收到|嗯+|可以|没问题|知道了|ok)/i],
];
function sceneOf(t) {
  const s = String(t || '');
  for (const [k, re] of SCENES) if (re.test(s)) return k;
  return 'other';
}

function all() {
  if (_cache) return _cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _cache = Array.isArray(j) ? j.filter(x => x && x.a) : [];
  } catch { _cache = []; }
  return _cache;
}

/* 按对方那句话挑同类样本（现在是对话对：他说什么 → 真人怎么回）。
 * 先场景一致，再随机补 other/daily/joke 兜底；只取回话 5~40 字的（像随口说的）。 */
function pickByText(text, n) {
  const want = Math.max(1, Math.min(8, n || 5));
  const arr = all();
  if (!arr.length) return [];
  const scene = sceneOf(text);
  const ok = x => x && x.a && String(x.a).length >= 5 && String(x.a).length <= 40;
  const same = arr.filter(x => x.scene === scene && ok(x));
  const rest = arr.filter(x => x.scene !== scene && ['other', 'daily', 'joke'].indexOf(x.scene) >= 0 && ok(x));
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  const out = [];
  const seen = new Set();
  for (const x of shuffle(same).concat(shuffle(rest))) {
    const a = String(x.a).replace(/\s+/g, ' ').trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push({ q: String(x.q || '').slice(0, 40), a, scene: x.scene, src: x.src });
    if (out.length >= want) break;
  }
  return out;
}

module.exports = { all, pickByText, sceneOf, FILE };
