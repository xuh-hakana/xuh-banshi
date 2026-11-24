'use strict';
/* mediagen/audience.js —— 多重真相：四类 B 站观众扮演 + 记录员汇总
 * 复用 src/multi-truth 的产出位置与格式（DIR/OUT + k/at/layers/canOffer/mustNot），
 * 写进 src/data/multi-truth/out/bili-selfintro.json，文案侧用 multiTruth.latest() 读回。 */
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const mt = require('../multi-truth');
const persona = require('../persona');

const K = 'bili-selfintro';
const EVIDENCE = path.join(__dirname, '..', 'data', 'bili-audience.json');

const PERSONAS = [
  { id: 'otaku', who: '宅男', look: '20 出头，房间堆满手办和快递箱，凌晨两点还在看番、抽卡、看二创。嘴上说摆烂，看到喜欢的角色会认真考据。' },
  { id: 'office', who: '普通上班族', look: '早八地铁，工位摸鱼刷 B 站，午饭看搞笑和美食，下班路上听歌。最怕领导消息，最懂“好累”。' },
  { id: 'dev', who: '程序员', look: '看技术区和数码区，装过一堆本地模型，键盘挑轴，遇事第一反应是“这有开源方案吗”。嘴上刻薄，其实想被理解。' },
  { id: 'teen', who: '青少年', look: '高中生，课间刷短视频，弹幕礼仪背得比课文熟，喜欢整活和表情包，被说教一句就跑。' },
];

function loadEvidence() {
  try { return JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')); } catch (e) { return null; }
}

/* 演一个人：他说自己的日常、需求、对虚幻的期待 */
async function play(p, ev) {
  const sys = persona.rolePrompt('groupmate')
    + '\n\n【你在扮演】' + p.who + '。' + p.look
    + '\n【网络查到的 B 站人群画像（可参考，标 inferred 的别当事实）】\n' + JSON.stringify((ev && ev.personas && ev.personas[p.id]) || {}, null, 0)
    + '\n\n只输出 JSON，不要解释：{"daily":"他今天在过的日子，一句话，20字内","needs":"他最想要什么，一句话，20字内","expect":"他期待虚幻这样的账号给他什么，一句话，25字内","bored":"他会划走什么，一句话，20字内"}';
  const r = await llm.chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: '现在你就是' + p.who + '，说你自己。' }], temperature: 0.9, maxTokens: 500 });
  let j = null;
  try { j = llm.extractJson(r.text || r); } catch (e) { j = null; }
  if (!j) j = { daily: '', needs: '', expect: '', bored: '', raw: String(r.text || r).slice(0, 200) };
  return Object.assign({ id: p.id, who: p.who, look: p.look }, j);
}

/* 记录员：压成给文案用的一段（与 multi-truth debrief 的结构一致） */
function settle(missions, ev, notes) {
  const layers = missions.map(m => ({ point: m.who + '：' + (m.needs || '') + '；期待 ' + (m.expect || '') }));
  return {
    k: K,
    at: Date.now(),
    stale: false,
    emotions: {},
    layers,
    canOffer: missions.map(m => m.who + ' 想被 ' + (m.expect || '接住')),
    mustNot: ['别群发式套话', '别念参数和履历', '别自称人工智能', '别对青少年说教'],
    missions,
    evidence: ev || null,
    notes: notes || [],
  };
}

async function build(opts) {
  const o = opts || {};
  const ev = o.evidence || loadEvidence();
  const notes = [];
  if (!ev || !ev.ok) notes.push('web_search/抓取没拿到正文，四类画像按常理推断（inferred:true）');
  const missions = [];
  for (const p of PERSONAS) {
    try { missions.push(await play(p, ev)); } catch (e) { notes.push(p.who + ' 扮演失败：' + e.message); missions.push(Object.assign({ id: p.id, who: p.who, look: p.look }, { daily: '', needs: '', expect: '' })); }
  }
  const rec = settle(missions, ev, notes);
  try {
    fs.mkdirSync(mt.OUT, { recursive: true });
    fs.writeFileSync(path.join(mt.OUT, mt.safeKey(K) + '.json'), JSON.stringify(rec, null, 2));
  } catch (e) { notes.push('落盘失败：' + e.message); }
  return rec;
}
module.exports = { build, PERSONAS, K, loadEvidence, EVIDENCE };
