'use strict';
/* 人类逻辑语料 v2：不抽单句，抽「对话对」（A 说 X → B 回 Y）。
 * 单句抽样会混进大量无关技术讨论；对话对才是「人类怎么回应这类话」。 */
/* 重建人类语料：node scripts/build-human.js
 * 数据源：src/data/chat-log.jsonl（群聊存档）；输出 src/data/human-lines.json。
 * 抽「A 说 X → B 回 Y」的对话对，不是抽单句（单句会混进大量无关技术讨论）。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src/data/human-lines.json');
const raw = fs.readFileSync(path.join(ROOT, 'src/data/chat-log.jsonl'), 'utf8').split('\n').filter(Boolean);

const rows = [];
for (const line of raw) {
  const m = line.match(/^\S+\s+\[([a-z]+)\](?:\[([^\]]*)\])*?\[([^\]]+)\]\s+([\s\S]+)$/);
  if (!m) continue;
  const t = Date.parse(line.slice(0, line.indexOf(' ')));
  if (!Number.isFinite(t)) continue;
  const platform = m[1];
  // 昵称是最后一个方括号，scope 是中间那个（可能是私聊/群号）
  const segs = [...line.matchAll(/\[([^\]]*)\]/g)].map(x => x[1]);
  const nick = segs[segs.length - 1] || '';
  const scope = segs.length >= 3 ? segs[segs.length - 2] : 'main';
  const text = m[4].replace(/\s+/g, ' ').trim();
  if (!nick || !text) continue;
  rows.push({ t, platform, scope, nick, text });
}

const SCENES = [
  ['doubt', /你是ai|是ai吧|机器人|人机|假的吧|骗人|真的假的|凭什么|滚|烦死|别发|污染|举报|就这|？{2,}|\?{2,}/i],
  ['care', /辛苦了|别急|没事吧|注意身体|早点睡|抱抱|别累|不着急/],
  ['explain', /为什么|为啥|怎么|什么意思|解释|说说/i],
  ['joke', /草|哈哈哈|绷不住|乐了|笑死|离谱|6{3,}/],
  ['thanks', /谢谢|感谢|多谢|好人/],
  ['daily', /^(好的?|行|收到|嗯+|可以|没问题|知道了|ok)/i],
];
function sceneOf(t) {
  const s = String(t || '');
  for (const [k, re] of SCENES) if (re.test(s)) return k;
  return 'other';
}
const bad = /^\[(图片|表情|语音|视频|文件|红包)\]|^[\/.。]|https?:\/\//;
const clean = s => String(s || '').replace(/@\d{5,12}\s*/g, '').replace(/\s+/g, ' ').trim();

const seen = new Set();
const pairs = [];
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (a.platform !== b.platform || a.scope !== b.scope) continue;
  if (b.t - a.t > 180000) continue;                 // 3 分钟内的接话
  if (a.nick === b.nick) continue;                  // 同一个人连发不算
  if (/虚幻/.test(a.nick) || /虚幻/.test(b.nick)) continue;   // 排除 bot 自己
  const q = clean(a.text), ans = clean(b.text);
  if (q.length < 3 || q.length > 60) continue;
  if (ans.length < 5 || ans.length > 50) continue;
  if (bad.test(a.text) || bad.test(b.text)) continue;
  const key = (q + '|' + ans).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  pairs.push({ q, a: ans, scene: sceneOf(q), src: a.platform, nick: b.nick.slice(0, 20) });
}

const by = {};
for (const p of pairs) (by[p.scene] = by[p.scene] || []).push(p);
const picked = [];
for (const k of Object.keys(by)) picked.push(...by[k].slice(-160));
const final = picked.slice(-800);
fs.writeFileSync(OUT, JSON.stringify(final, null, 1));
console.log('对话对', pairs.length, '入库', final.length);
for (const k of Object.keys(by)) console.log(' ', k, Math.min(by[k].length, 160));
console.log('样例:', final.filter(x => x.scene === 'doubt').slice(0, 5));
