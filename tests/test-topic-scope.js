/*
 * tests/test-topic-scope.js — 话题三级注入口径（2026-11-19 主人令）
 *
 * 主人的正确规则（handover/ledger.md 原文）：
 *   「单人话题按此人所在的群 / 平台等场合出现，或私聊出现；群话题不出群；平台 / 通用话题随意出现。」
 * 也就是说：
 *   · single 单人话题 → 本人在群里说给、他私聊你也给（「也可以给本人私聊」），别人一个字都看不到；
 *   · group  群话题   → 只在该群，本人私聊也不给；
 *   · common 通用话题 → 哪儿都给。
 * 另外守一条：「私密 / 公开」旧概念 2026-11-13 已废，代码里不许再有这条判定
 *   （以前注释写「private 不进提示词」，实际没实现，纯属残留）。
 *
 * 跑法：node tests/test-topic-scope.js
 * 不碰线上 topics.jsonl —— 拦 fs，只喂合成数据。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

const FAKE = [
  { id: 'T_single', kind: 'topic', state: 'kept', level: 'single', qq: '111', scope: '私聊', sum: '单人测试条', t: '2026-11-19T00:00:00Z' },
  { id: 'T_group', kind: 'topic', state: 'kept', level: 'group', qq: '111', scope: '群888', sum: '群测试条', t: '2026-11-19T00:00:00Z' },
  { id: 'T_common', kind: 'topic', state: 'kept', level: 'common', sum: '通用测试条', t: '2026-11-19T00:00:00Z' },
  // 老数据里可能挂着 review.privacy='private'：旧概念已废，不许再影响注入
  { id: 'T_priv', kind: 'topic', state: 'kept', level: 'group', qq: '111', scope: '群888', sum: '旧私密条', t: '2026-11-19T00:00:00Z', review: { privacy: 'private' } },
].map(x => JSON.stringify(x)).join('\n') + '\n';

// 只拦 topics.jsonl，别的文件照常读
const stat = { mtimeMs: 1000001000, size: FAKE.length };
const origStat = fs.statSync.bind(fs);
const origRead = fs.readFileSync.bind(fs);
fs.statSync = function (p, ...a) {
  if (String(p).endsWith(path.join('data', 'topics.jsonl'))) return stat;
  return origStat(p, ...a);
};
fs.readFileSync = function (p, ...a) {
  if (String(p).endsWith(path.join('data', 'topics.jsonl'))) return FAKE;
  return origRead(p, ...a);
};

const core = require(path.join(ROOT, 'src', 'core'));
core.init(require(path.join(ROOT, 'src', 'config')).load());

const got = (gid, uid) => core.keptTopicLines(gid, x => x, uid);
const has = (txt, s) => String(txt || '').includes(s);

// ① 本人私聊：单人话题 + 通用给，群话题不给（群话题不出群）
{
  const out = got('', '111');
  t('本人私聊：给单人话题', has(out, '单人测试条'));
  t('本人私聊：不给群话题（群话题不出群）', !has(out, '群测试条'));
  t('本人私聊：给通用话题', has(out, '通用测试条'));
}
// ② 本人在群里：三级都给
{
  const out = got('888', '111');
  t('本人在本群：给单人话题', has(out, '单人测试条'));
  t('本人在本群：给本群群话题', has(out, '群测试条'));
  t('本人在本群：给通用话题', has(out, '通用测试条'));
}
// ③ 本人去别的群：单人跟着人走，群话题留在原群
{
  const out = got('999', '111');
  t('本人去别的群：单人话题照样给（按人走）', has(out, '单人测试条'));
  t('本人去别的群：原群话题不给', !has(out, '群测试条'));
}
// ④ 别人私聊：单人、群话题都看不到，只有通用
{
  const out = got('', '222');
  t('别人私聊：看不到单人话题', !has(out, '单人测试条'));
  t('别人私聊：看不到群话题', !has(out, '群测试条'));
  t('别人私聊：只有通用话题', has(out, '通用测试条'));
}
// ⑤ 旧的 private 标记不再有任何作用（概念 2026-11-13 已废）
{
  const out = got('888', '111');
  t('旧的「私密」标记不再挡注入（概念已废）', has(out, '旧私密条'));
  const src = origRead(path.join(ROOT, 'src', 'core.js'), 'utf8');
  t('core.js 里不再有 privacy 判定分支', !/privacy\s*===\s*'private'/.test(src));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
