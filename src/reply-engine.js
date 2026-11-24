'use strict';
/* reply-engine.js —— 两层回话引擎（2026-11-22 主人定，架构性改动）
 *
 * 主人原话：
 *   「群里和b站的所有人类的发言，都是去ai味的参考。我的例句才是规范。」
 *   「把『人类逻辑』和『虚幻逻辑』（撩人、让大家幸福、让别人觉得自己很重要）分开。
 *     先用人类逻辑过一遍去ai味，再虚幻逻辑过一遍加上可爱感。」
 *   「不要兜底了，发不出去就别发。」
 *
 * 所以这里不写任何「示例句子」，只跑两个阶段：
 *   ① 人类逻辑：给同类真实对话对，让模型**先观察**（长度/是否解释/是否反问/结尾软硬），
 *      再写一版普通人会怎么接。这一步只负责「不像 AI」。
 *   ② 虚幻逻辑：把草稿按「让人幸福 / 让对方觉得自己重要 / 可爱」改一遍，
 *      只动语气和落点，不加信息、不变长。
 *
 * 两级都失败 → 返回空字符串，调用方跳过这条，不补发、不兜底。
 * ======================================================================= */

const core = require('./core');
const humanVoice = require('./human-voice');
const masterExamples = require('./master-examples');
const xuhuanLogic = require('./data/xuhuan-logic.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(p, ms) {
  p.catch(() => {});
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
const clean = s => String(s || '')
  .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/* 虚幻逻辑：按对方那句话挑原则（scene 命中优先，其余 any 补足）。 */
function logicFor(text, n) {
  const s = String(text || '');
  const hit = [];
  const any = [];
  for (const x of xuhuanLogic) {
    if (!x || !x.rule) continue;
    if (x.scene && x.scene !== 'any' && s.indexOf(x.scene) >= 0) hit.push(x);
    else if (!x.scene || x.scene === 'any') any.push(x);
  }
  return hit.concat(any).slice(0, n || 4);
}

/* ---------- 第一层：人类逻辑（去 AI 味） ----------
 * 关键在「先观察再写」：样本是给人看的，不是给人抄的。
 * 所以 prompt 要求模型先总结这批人的共同点，再落笔。 */
async function humanPass(question, opt) {
  const o = opt || {};
  let samples = [];
  try { samples = humanVoice.pickByText(question, o.samples || 8); } catch { samples = []; }
  const sys = [
    '有人在B站回了你一句：「' + question + '」',
    '',
    samples.length
      ? '下面是真实的人在类似场景里怎么接的。它们是「口气参考」，不是答案：'
      : '',
    ...samples.map(x => '  「' + String(x.q).slice(0, 30) + '」→「' + x.a + '」'),
    '',
    samples.length
      ? '先在心里看一遍：他们平均几个字？有没有解释？有没有反问？结尾是硬的还是软的？有没有人先软下来？'
      : '',
    '然后按他们的口气，写一版「一个普通人会怎么接」。',
    '要求：5~25 字；像随手打字；不解释、不总结、不复述他的话；不用书面语；不提 AI；先不要表情。',
    '只输出这一句。',
  ].filter(Boolean).join('\n');
  const out = await withTimeout(
    core.callLLM([{ role: 'system', content: sys }, { role: 'user', content: '回他' }], { tag: 'other' }),
    22000,
  );
  return clean(out);
}

/* ---------- 第二层：虚幻逻辑（加可爱 / 撩） ----------
 * 只给「原则」和主人例句的 why，不给主人原句 —— 从源头断掉照抄。 */
async function xuhuanPass(question, draft, opt) {
  const o = opt || {};
  const logic = logicFor(o.kind || '', 4);
  const moves = masterExamples.list()
    .map(x => String(x.why || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const sys = [
    '草稿：「' + draft + '」',
    '',
    '现在用「虚幻」的方式说同一件事。不换信息，只调语气和落点。',
    '虚幻逻辑（这是规范，按它调，不是照抄句子）：',
    ...logic.map(x => '  · ' + x.rule + (x.why ? '（' + x.why + '）' : '')),
    moves.length ? '主人处理这类话的思路（学思路）：' : '',
    ...moves.map(x => '  · ' + x),
    '',
    '只做三件事：',
    '1) 加一个情绪词（呜 / 嘻嘻 / 哼 / 呀 / 嘛，按情况选一个）',
    '2) 把落点放到对方身上（你换到了就好 / 怕你白跑 / 你好奇我呀）',
    '3) 最后加一个可爱表情，跟最后的情绪一致',
    '不要变长；不要加第二个道理；不要解释自己是什么；不叫别人主人。',
    '只输出改完的一句。',
  ].filter(Boolean).join('\n');
  const out = await withTimeout(
    core.callLLM([{ role: 'system', content: sys }, { role: 'user', content: '改成你的说法' }], { tag: 'other' }),
    22000,
  );
  return clean(out);
}

/* 主入口：两层都过。
 * 返回 { text, stage }；text 为空表示「这轮不发」（主人：发不出去就别发）。 */
async function reply(question, opt) {
  const o = opt || {};
  const draft = await humanPass(question, o);
  if (!draft) return { text: '', stage: 'human-fail' };
  const final = await xuhuanPass(question, draft, o);
  if (!final) return { text: '', stage: 'xuhuan-fail', draft };
  return { text: final, stage: 'ok', draft };
}

module.exports = { reply, humanPass, xuhuanPass, logicFor };
