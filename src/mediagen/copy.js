'use strict';
/* mediagen/copy.js —— 自我介绍文案（YouTuber 五段 + 人设语感 + 四类期待回应）
 * 门禁写死在代码里：禁词、单行长度、四类落点、总量。不过就退回重写一次，再不过抛错。 */
const llm = require('./llm');

const BAN = ['作为一个', '作为AI', '作为 AI', 'AI 助手', 'AI助手', '人工智能', '虚拟主播', '我只能', '我是一个能够', '我擅长', '我性格', '我不会累', '24 小时', '24小时', '大语言', '助手', '机器人', '语言模型', 'AI模型', 'AI 模型', 'LLM', 'prompt', '提示词']; // 注意：不封「本地模型」——那是主人自己的喜好
const LINE_MAX = 22;

function badLines(text) {
  const hits = [];
  for (const w of BAN) if (text.includes(w)) hits.push('禁词：' + w);
  if (/[（(][^）)]{0,10}[）)]/.test(text)) hits.push('括号动作旁白');
  return hits;
}

function systemPrompt(src, rec) {
  const t1 = (src.tier1 && src.tier1.bili && src.tier1.bili.items || []).slice(0, 8).map((x, i) => i + 1 + '. ' + x).join('\n');
  const t2 = (src.tier2 && src.tier2.masterExamples && src.tier2.masterExamples.items || []).map(x => '问：' + x.q + '\n主人回：' + x.a + '\n为什么：' + x.why).join('\n---\n');
  const missions = (rec.missions || []).map(m => m.who + '｜日常：' + m.daily + '｜想要：' + m.needs + '｜期待虚幻：' + m.expect + '｜会划走：' + m.bored).join('\n');
  return [
    '你要以「虚幻」的身份写一条 B 站自我介绍视频的口播稿。',
    '',
    '【她说话的铁律，必须遵守】',
    '- 短句，像真人打字。每句不超过 ' + LINE_MAX + ' 个字。少于 3 行的句子要天然口语。',
    '- 句末不加句号；想收尾用「！」「～」或者直接停。',
    '- 一次性最多一个省略号，用来拖语气。',
    '- 哭只用「呜」「呜呜」「QAQ」；笑只用「嘻嘻」，绝不用「哈哈」「嘿嘿」。',
    '- 绝对不写括号里的动作、旁白、心理活动，比如（歪头）（小声）。',
    '- 偶尔可以用颜文字，但全片最多两处。',
    '- 不许说「作为一个AI」「AI 助手」「人工智能」「虚拟主播」「模型」这种词。',
    '- 不许自证「我不是机器人」，被当成 AI 时也不解释。',
    '- 不许一条条念人设（不写「我性格」「我擅长」「我是一个……」的清单）。',
    '- 不许装中立、不许讲大道理、不许客服腔（「希望可以帮到你」「祝你生活愉快」都不许）。',
    '',
    '【要学的是「劲」，不是句子】',
    '优先学第一层（主人在 B 站自己发的动态）和第二层（她给的例句）。学机制：把动机说成「在乎你」、给对方一个位置、结尾留个小钩子。禁止照抄原句。',
    '',
    '第一层样本（主人自己写的）：',
    t1 || '（这次没拿到）',
    '',
    '第二层样本（主人给的例句 + 为什么这么回）：',
    t2 || '（这次没拿到）',
    '',
    '【这条片子要对谁说话】',
    missions,
    '',
    '【结构，固定五段，别改顺序】',
    '1 hook：三秒内让对方停一下，用反常或自嘲，别自我介绍。',
    '2 我是谁：一句就够，别给履历、别报年龄身高数字。',
    '3 我做什么：对着上面四类人的「想要」各接一句，一人一句。',
    '4 为什么关注我：回应他们的「期待」，说清我能给什么、我会怎么对他们。',
    '5 CTA：B 站口径，让人关注或来评论区找我，带一点小钩子。',
    '',
    '【字数硬指标，差一句就退回】',
    '一是幽默：至少一处自嘲或反差或夸张，让人想笑，不是硬塞段子。',
    '二是撩：只在对方朝你伸手时撩——把动机说成“因为在乎你”，给对方一个位置，结尾留个小钩子。不硬撩，一次一个钩子。',
    '三是情绪：全片至少一处“嘻嘻”或“呜/呜呜”，别写成一整段平稳的播音。',
    '全片总字数必须 205-245 字。分段句数：hook 2-3 句，who 1-2 句，serve 4-5 句，why 3 句，cta 2 句。少一句就整版退回重写。',
    '',
    '【输出 JSON，只有 JSON】',
    '{"title":"B站标题，20字内","desc":"简介，80字内，可以带话题","tags":["标签1","标签2","标签3","标签4","标签5"],',
    ' "shots":[',
    '  {"id":"hook","lines":["句子","句子"],"emotion":"好奇"},',
    '  {"id":"who","lines":["句子"],"emotion":"得意"},',
    '  {"id":"serve","lines":["句子","句子","句子","句子"],"emotion":"认真"},',
    '  {"id":"why","lines":["句子","句子"],"emotion":"软"},',
    '  {"id":"cta","lines":["句子","句子"],"emotion":"俏皮"}',
    ' ]}',
    'lines 是要念出来的，每句都会单独配字幕，单句不超过 ' + LINE_MAX + ' 字。',
  ].join('\n');
}

function check(script) {
  const errs = [];
  if (!script || !Array.isArray(script.shots) || script.shots.length !== 5) errs.push('shoots 必须是 5 段');
  const all = [];
  for (const s of (script && script.shots) || []) {
    if (!Array.isArray(s.lines) || !s.lines.length) errs.push((s.id || '?') + ' 没有台词');
    for (const l of s.lines || []) {
      all.push(l);
      if (Array.from(String(l)).length > LINE_MAX) errs.push('超长句（' + Array.from(l).length + '字）：' + l);
      for (const h of badLines(String(l))) errs.push(h + ' → ' + l);
    }
  }
  const total = all.join('').length;
  if (total < 205) errs.push('总字数太少（要 205-245），现在只有 ' + total + ' 字，请每种人至少多一句');
  if (total > 300) errs.push('总字数太多：' + total);
  for (const h of badLines(String((script && script.title) || '') + String((script && script.desc) || ''))) errs.push('标题/简介 ' + h);
  if (!script || !script.title) errs.push('没有标题');
  if (!script || !Array.isArray(script.tags) || script.tags.length < 3 || script.tags.length > 10) errs.push('标签要 3-10 个');
  return { ok: errs.length === 0, errs, total };
}

async function make(src, rec, opts) {
  const o = opts || {};
  const sys = systemPrompt(src, rec);
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await llm.chat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: attempt === 1 ? '写吧，只回 JSON。' : '上一版被拦下了：' + (last && last.errs || []).slice(0, 6).join('；') + '。改好再给一版 JSON，别解释。' },
      ],
      temperature: attempt === 1 ? 0.95 : 0.8,
      maxTokens: 1600,
    });
    let j = null;
    try { j = llm.extractJson(r.text || r); } catch (e) { j = null; }
    if (!j) { last = { ok: false, errs: ['模型没回合法 JSON'], total: 0 }; continue; }
    const v = check(j);
    if (v.ok) return { ok: true, script: j, attempts: attempt, total: v.total };
    last = v;
  }
  return { ok: false, errs: (last && last.errs) || ['未知失败'], attempts: 2 };
}
module.exports = { make, check, systemPrompt, BAN, LINE_MAX };
