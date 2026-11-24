'use strict';
/* mediagen/style-source.js —— 自我介绍片的风格样本（分级）
 * 优先级（主人 2026-11-25 原话）：主人在 B 站发的动态 + 主人给的案例 > 其他主人发言 > 虚幻人设本身。
 * 只读，不改任何被读的东西。失败一律降级并记录，不抛。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOUL = path.join(ROOT, 'src', 'soul');
const SOUL_FILES = [
  'F-全场景通用主人设/虚幻.md',
  'F-全场景通用主人设/1-性格.md',
  'F-全场景通用主人设/2-说话.md',
  'H-全聊天/3-应对.md',
];

function timeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms))]);
}
function read(rel) { try { return fs.readFileSync(path.join(SOUL, rel), 'utf8').trim(); } catch (e) { return ''; } }
function pickDynText(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return String(x.text || x.content || x.desc || x.description || (x.card && x.card.desc) || '').trim();
}

/* 一级：主人 B 站动态（她自己写的话，最像她） */
async function biliDynamics(pages) {
  try {
    const bs = require('../bili-space');
    const me = await timeout(Promise.resolve(bs.me()), 20000);
    const mid = (me && (me.mid || me.uid)) || bs.defaultMid && bs.defaultMid();
    if (!mid) return { ok: false, why: '拿不到 mid' };
    const list = await timeout(Promise.resolve(bs.dynamics(mid, pages || 2)), 30000);
    const arr = (Array.isArray(list) ? list : (list && list.items) || [])
      .map(pickDynText).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 4);
    return { ok: arr.length > 0, mid, items: arr.slice(0, 20), why: arr.length ? '' : '动态里没有正文' };
  } catch (e) { return { ok: false, why: e.message }; }
}

/* 二级：主人例句（最高一级案例，学的是「劲」不是句子） */
function masterExamples() {
  try {
    const mx = require('../master-examples');
    const arr = mx.list().map(x => ({ q: x.q, a: mx.renderText(x.a), why: x.why || '' }));
    return { ok: arr.length > 0, items: arr };
  } catch (e) { return { ok: false, why: e.message, items: [] }; }
}

/* 三级：人设本身（兜底，只给规则不给句子） */
function soulRules() {
  const parts = SOUL_FILES.map(read).filter(Boolean);
  return { ok: parts.length > 0, text: parts.join('\n').slice(0, 12000) };
}

async function collect() {
  const [bili, mx] = [await biliDynamics(2), masterExamples()];
  const soul = soulRules();
  const out = {
    at: new Date().toISOString(),
    tier1: { bili, canUse: bili.ok },
    tier2: { masterExamples: mx },
    tier3: { soul: soul.ok },
    soulText: soul.text,
    notes: [],
  };
  if (!bili.ok) out.notes.push('bili:unavailable ' + (bili.why || ''));
  if (!mx.ok) out.notes.push('masterExamples:unavailable ' + (mx.why || ''));
  return out;
}
module.exports = { collect, biliDynamics, masterExamples, soulRules, SOUL_FILES };
