#!/usr/bin/env node
// 确定性自检：解析体六项结构 + 四项内容。零依赖。
// 用法: node check.mjs 答案.md --target "目标原话" [--json]
//       node check.mjs --self-test
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOLLOW = ['笑点在于', '正是笑点所在', '这才是笑点', '妙就妙在', '精髓在于', '说白了就是好笑'];
const PLACEHOLDER = /^(代称|昵称|某人|群友)(?=[：:])/;
const REC_LINE = /^([^：:\n]{1,24})[：:]([\s\S]+)$/;

function norm(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

export function checkAnswer(text, opts = {}) {
  const target = opts.target || '';
  const errs = [];
  const warns = [];
  const t = String(text || '');
  const i = t.indexOf('【聊天记录】');
  const j = t.indexOf('【解析】');
  if (i < 0) errs.push('缺少【聊天记录】');
  if (j < 0) errs.push('缺少【解析】');
  if (errs.length) return { ok: false, errs, warns, layers: 0 };
  if (j < i) errs.push('【解析】出现在【聊天记录】之前');
  const recPart = t.slice(i + '【聊天记录】'.length, j);
  const ansPart = t.slice(j + '【解析】'.length);
  const recLines = recPart.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!recLines.length) errs.push('【聊天记录】为空');
  for (const line of recLines) {
    if (PLACEHOLDER.test(line)) { errs.push('记录行用了占位符昵称: ' + line); continue; }
    const m = REC_LINE.exec(line);
    if (!m) { errs.push('记录行不是「昵称：原话」: ' + line); continue; }
    const quote = m[2].trim();
    if (/^［?\[?图\/视频/.test(quote)) continue;
    if (norm(quote).length < 2) errs.push('记录行原话太短: ' + line);
    if (target && norm(target).length > 0 && !norm(target).includes(norm(quote))) {
      errs.push('记录里的原话在目标里找不到: ' + line);
    }
  }
  if (/代称/.test(ansPart)) errs.push('解析正文出现占位符「代称」');
  if (!/^\s*资料[：:]\s*\S/m.test(ansPart)) errs.push('缺少非空的「资料：」行');
  const marks = [...ansPart.matchAll(/此为(\d+)层笑点/g)];
  const nums = marks.map((m) => Number(m[1]));
  nums.forEach((n, k) => { if (n !== k + 1) errs.push('层号不连续: 第' + (k + 1) + '个标记写的是 ' + n); });
  if (/另[:：]\s*此为/.test(ansPart)) warns.push('层标记前多了「另：」，统一格式');
  if (!marks.length) {
    warns.push('没有层：仅有资料行+末句，确认四问真的答不出');
  }
  const bodies = [];
  const SHIFT = /(当成|当作|错位|换成|换了|偷换|谐音|反过来|反着|误以为|理解成|双关|打脸|对不上|念起来|不是一回事)/;
  for (let k = 0; k < marks.length; k++) {
    const start = k === 0 ? 0 : marks[k - 1].index + marks[k - 1][0].length;
    const body = ansPart.slice(start, marks[k].index)
      .split('\n').filter((l) => !/^\s*资料[：:]/.test(l)).join('\n')
      .replace(/令人忍俊不禁喵?[。，]?/g, '').trim();
    const tailTo = k + 1 < marks.length ? marks[k + 1].index : ansPart.length;
    const tailSeg = ansPart.slice(marks[k].index + marks[k][0].length, tailTo);
    bodies.push({ body, tailSeg });
    const subst = norm(body).length;
    if (subst < 12) errs.push('第' + (k + 1) + '层没有实质内容（去掉壳只剩 ' + subst + ' 字）');
    if (subst < 30 && !SHIFT.test(body)) errs.push('第' + (k + 1) + '层只翻译了原话，没指出谁把什么当成了什么');
    for (const h of HOLLOW) {
      if (body.includes(h) && subst < 40) errs.push('第' + (k + 1) + '层疑似空话（' + h + '）');
    }
  }
  for (let k = 0; k < marks.length - 1; k++) {
    if (!/令人忍俊不禁/.test(bodies[k].tailSeg)) errs.push('第' + (k + 1) + '层结尾缺「令人忍俊不禁」');
  }
  const tail = ansPart.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
  if (!/令人忍俊不禁喵[。！!．]?$/.test(tail)) errs.push('最后一句必须是「令人忍俊不禁喵」');
  if (target) {
    const nTarget = norm(target);
    const nAns = norm(ansPart);
    let grounded = false;
    for (let s = 0; s + 4 <= nTarget.length; s++) {
      if (nAns.includes(nTarget.slice(s, s + 4))) { grounded = true; break; }
    }
    if (!grounded) errs.push('解析正文没有引用目标原话（至少 4 个字连续）');
  }
  return { ok: errs.length === 0, errs, warns, layers: marks.length };
}

function selfTest() {
  const good = [
    '【聊天记录】', '主人：司凤，你死冯了', '【解析】',
    '资料：谐音（剧名角色「司凤」）',
    '对话中主人说「司凤，你死冯了」，字面是司凤死了，但「死冯」念起来就是「死」，主人把「凤」换成同音的「冯」，把名字本身也判了死刑，此为1层笑点，令人忍俊不禁。',
    '而蠢蠢的ai，回复「司凤是谁」。没有理解这是在用谐音宣布角色死讯，令人忍俊不禁喵。',
  ].join('\n');
  const empty = [
    '【聊天记录】', '主人：随便', '【解析】', '资料：（没查到明确资料）',
    '对话中主人说「随便」意思是都行，此为1层笑点，令人忍俊不禁。',
    '而蠢蠢的ai，回复「好」。没有理解，令人忍俊不禁喵。',
  ].join('\n');
  const ph = good.replace('主人：司凤，你死冯了', '代称：司凤，你死冯了');
  const noTail = good.replace('，令人忍俊不禁喵。', '。');
  const layers = [
    '【聊天记录】', '甲：随便', '【解析】', '资料：双关',
    '甲说「随便」，字面上是放手让你自己决定，实际是不想把选择权揽过来，同一个词被当成两种意思用，此为1层笑点，令人忍俊不禁。',
    '而蠢蠢的ai，回复「好」。没有理解，令人忍俊不禁喵。',
  ].join('\n');
  const cases = [
    ['合格样例', good, true],
    ['空话样例（资料行为空话/无错位）', empty, false],
    ['占位符昵称', ph, false],
    ['缺末句喵', noTail, false],
    ['合格样例带层尾', layers, true],
  ];
  let bad = 0;
  for (const [name, text, expectOk] of cases) {
    const got = checkAnswer(text);
    const pass = got.ok === expectOk;
    if (!pass) bad++;
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (got.ok ? ' [合格]' : ' [不合格] ' + got.errs.slice(0, 3).join(' / ')));
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const bad = selfTest();
    process.exit(bad ? 1 : 0);
  }
  const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--target');
  const ti = argv.indexOf('--target');
  const target = ti >= 0 ? argv[ti + 1] || '' : '';
  if (!file) {
    console.error('用法: node check.mjs 答案.md [--target "原话"] [--json]');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const r = checkAnswer(text, { target });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(r.ok ? '合格（' + r.layers + ' 层）' : '不合格');
    r.errs.forEach((e) => console.log(' - ' + e));
    r.warns.forEach((w) => console.log(' ? ' + w));
  }
  process.exit(r.ok ? 0 : 1);
}
