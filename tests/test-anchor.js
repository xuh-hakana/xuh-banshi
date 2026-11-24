'use strict';
/* 2026-11-25 本轮锚定回归：一句话把 2 小时前的旧表情和刚发的照片拼成一句（真事故）。 */
const assert = require('assert');
const anchor = require('../src/anchor');

const H = 3600 * 1000;
const now = Date.now();
const OLD = { role: 'user', nick: '分不清', uid: '1', ts: now - 2.7 * H,
  content: '分不清我分不清啊说: ［图：图库里的「喜欢」/ 情绪：喜欢 / 是什么：这是一张动漫角色（有猫耳，长灰发）在街头夜市吃小吃的照片］' };
const CUR = { role: 'user', nick: '柚酱', uid: '2', ts: now - 60 * 1000,
  content: '主人说: ［图：字：四川·成都 / 金龙鱼 / 无字 / 是什么：图片中没有文字内容］' };
const hist = [OLD, { role: 'assistant', content: '好的', ts: now - 2.5 * H }, CUR];

function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); return false; }
}

let pass = 0, fail = 0;
const ok = (n, f) => { if (check(n, f)) pass++; else fail++; };

ok('旧图描述被省略，提示词里再也看不到「猫耳」', () => {
  const out = anchor.renderHistory(hist);
  const all = out.map(m => m.content).join('\n');
  assert(all.indexOf('猫耳') < 0, '旧图特征词仍在提示词里：' + all.match(/.{0,12}猫耳.{0,12}/));
  assert(all.indexOf('旧图，不是这一轮') >= 0, '缺「旧图」标记');
});

ok('旧消息带（旧）时间锚，本轮带【本轮】', () => {
  const out = anchor.renderHistory(hist);
  assert(/（\d\d:\d\d · 旧）/.test(out[0].content), '旧消息没有时间锚：' + out[0].content.slice(0, 20));
  assert(out[2].content.startsWith('【本轮 · '), '本轮没有标记：' + out[2].content.slice(0, 20));
});

ok('本轮图片描述原样保留（不许省）', () => {
  const out = anchor.renderHistory(hist);
  assert(out[2].content.indexOf('金龙鱼') >= 0, '本轮图描述被误删');
});

ok('事故回放：把旧图（猫耳）当本轮内容 → 出口判串图、不发送', () => {
  const bad = '那只猫耳小可爱在吃东西耶，看起来好好吃的样子～这条鱼好大啊，主人怎么看它觉得无语呢';
  const r = anchor.imageLeak(bad, CUR.content, hist);
  assert(r.leak === true, '没有判出串图');
  assert(r.hit.indexOf('猫耳') >= 0, '没命中猫耳：' + JSON.stringify(r.hit));
});

ok('只回本轮（金龙鱼）→ 不拦', () => {
  const good = '这条鱼好大啊，主人怎么看它觉得无语呢';
  const r = anchor.imageLeak(good, CUR.content, hist);
  assert(r.leak === false, '正常回复被误拦：' + JSON.stringify(r.hit));
});

ok('启动/重连闸：刚连上时在有窗口内，warmSec=0 时立刻结束', () => {
  anchor.markConnected();
  assert(anchor.inWarm() === true || anchor.conf().warmSec === 0, 'markConnected 后不在窗口内');
  assert(anchor.warmLeftSec() >= 0, '剩余秒数不是正数');
});

ok('规则段点名【本轮】与（旧）', () => {
  const t = anchor.rulesText();
  assert(t.indexOf('【本轮】') >= 0 && t.indexOf('（旧）') >= 0, '规则段缺锚点说明');
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
