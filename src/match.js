/*
 * match.js — 「这句话和这条东西到底有没有关系」的唯一判据（2026-11-21）
 *
 * 为什么单独一份：coord.js（坐标选材）和 info-scan.js（现读：词典/梗/约定）都要判相关性。
 * 各写一份就会两处标准不一致（记忆里的铁律：不建双份）。
 *
 * 判据：**连续实字重合 ≥2 个**。由虚词拼成的片段（为什么 / 你们 / 什么 / 么会）一律不算。
 * 真实案例跑出来的头号 bug：输入「你们为什么会被警告了，」靠「为什么」三个字命中了
 * 「他们为什么打架？」——虚词当相关性。所以虚词必须先剔掉再比。
 */
const VCH = new Set('的了是在我你他她它们什么怎为吗呢吧啊呀就都也还和与或但不没要会能以可这那有个上下里一被把给对让'.split(''));

/* 弱功能词：每个字看着都「实」，配一起却没有区分度。真实案例里「应该」把
 * 「你应该接点牛逼插件」拉到「系统应该不会直接告诉你寿命」上，就是这类。
 * 只作为一个 2-gram 存在时不计相关性；拼进更长的实词段（如「应该不会」以外的实词）照常算。 */
const WEAK2 = new Set([
  '应该', '可以', '可能', '然后', '所以', '因为', '但是', '如果', '还是', '这样', '那样',
  '时候', '知道', '觉得', '现在', '真的', '其实', '已经', '一定', '肯定', '确实', '当然',
  '不过', '而且', '或者', '不会', '不能', '不是', '没有', '就是', '也要', '都会', '还会',
  '都不', '都要', '就会', '也要', '我们', '你们', '他们', '她们', '的是', '了的', '我的',
  '你的', '他的', '她的', '一个', '一下', '一点', '有点', '好像', '必须', '需要', '希望',
  '想要', '打算', '准备', '开始', '继续', '进行', '认为', '表示', '看到', '听到', '说到',
  '今天', '明天', '昨天', '刚才', '一会', '晚上', '早上', '中午', '最近', '以后', '以前',
]);

/* 能参与匹配的字符：汉字 / 字母 / 数字。标点、空格、波浪号一律不算 ——
 * 不加这条，「～ 」这种符号会被当成 2 字重合（真实案例里正是它把无关的正例拉进来）。 */
function isWordChar(ch) {
  return /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch || '');
}

/* 全是虚词？全虚的片段不作数。 */
function isVirt(g) {
  if (!g) return true;
  for (const ch of String(g)) if (!VCH.has(ch)) return false;
  return true;
}

/* 弱片段：每个 2-gram 要么全虚、要么是弱功能词。整段弱 → 不算相关性。 */
function isWeak(seg) {
  const s = String(seg || '');
  if (s.length < 2) return true;
  for (let i = 0; i + 2 <= s.length; i++) {
    const g = s.slice(i, i + 2);
    if (!isVirt(g) && !WEAK2.has(g)) return false;
  }
  return true;
}

/* 抽特征 2-gram。占位 x 单独剔掉（「不用管x」的 x 是通配）。 */
function grams(s) {
  const out = new Set();
  const t = String(s || '').toLowerCase().replace(/x(?![a-z0-9])/g, ' ');
  for (const w of (t.match(/[a-z0-9]{2,}/g) || [])) out.add(w);
  for (const seg of (t.match(/[\u4e00-\u9fa5]+/g) || [])) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2);
      if (!isVirt(g) && !WEAK2.has(g)) out.add(g);
    }
  }
  return out;
}

/* 最长公共连续子串，只认「实字且非弱功能词」的片段。全虚/全弱/带标点的一律不计。 */
function lcsLen(a, b) {
  const A = String(a || '').slice(0, 220);
  const B = String(b || '').slice(0, 220);
  if (!A || !B) return 0;
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1] && isWordChar(A[i - 1])) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          const seg = A.slice(i - cur[j], i);
          if (!isWeak(seg)) best = cur[j];
        }
      }
    }
    prev = cur;
  }
  return best;
}

/* 有没有关系：任一串与这句有 ≥2 连续实字重合。 */
function related(text, ...cands) {
  for (const c of cands) if (lcsLen(c, text) >= 2) return true;
  return false;
}

module.exports = { VCH, WEAK2, isVirt, isWeak, isWordChar, grams, lcsLen, related };

