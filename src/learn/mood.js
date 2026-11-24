'use strict';
/*
 * src/learn/mood.js —— 心情 → 语气（2026-11-22）
 *
 * 由来（主人原话）：「按心情改语气、定心情……我都缺。」
 * 心情本身不在这里定——AstrBot 的自主学习插件已经在定（每日 6 点换一次、
 * 10 种类型、群里 /set_mood 能立刻改），这里只负责**把心情翻译成说话方式**，
 * 塞进提示词。这样不出现第二套心情状态机，两边也不会打架。
 *
 * 两条规矩：
 *   1. 没心情数据就不写这段——不许编一个心情出来；
 *   2. 心情只改语气，不改「回不回」、不改事实、不改底线。心情再差也不许阴阳怪气。
 */
const TONE = {
  happy: '更跳一点，多用「～」，表情多一个，可以主动接话；别端着',
  playful: '爱闹、爱接梗，敢逗人，短句带点得瑟',
  calm: '平稳，不多话，不硬撩，句子短一点',
  curious: '多问一句，追着细节问，别急着下结论',
  excited: '感叹号多一点，话稍多，语速快，情绪外露',
  angry: '短、硬、少表情，不主动撩，别撒娇',
  anxious: '小心，短句，少承诺，别把话说满',
  sad: '话少一点，软，不闹，别硬撑开心',
  nostalgic: '慢一点，爱提以前的事，语气软',
  serious: '不玩梗，不卖萌，直接答，别加语气词',
};

const LABEL = {
  happy: '开心', playful: '想闹', calm: '平静', curious: '好奇',
  excited: '兴奋', angry: '生气', anxious: '不安', sad: '难过',
  nostalgic: '怀旧', serious: '认真',
};

function block(mood, maxChars) {
  if (!mood || !mood.type) return '';
  const type = String(mood.type);
  const tone = TONE[type];
  if (!tone) return '';                       // 不认识的心情：宁可不写
  const lim = Number(maxChars) > 0 ? Number(maxChars) : 200;
  const label = LABEL[type] || type;
  const pct = Math.round((Number(mood.intensity) || 0) * 100);
  const head = '## 你现在的心情';
  const line1 = label + (pct ? '（强度 ' + pct + '%）' : '') + (mood.description ? '——' + mood.description : '');
  const line2 = '说话时：' + tone + '。';
  const out = [head, line1, line2].join('\n');
  if (out.length <= lim) return out;
  return out.slice(0, Math.max(0, lim - 1)) + '…';
}

module.exports = { block, TONE, LABEL };
