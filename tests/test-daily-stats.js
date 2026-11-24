/* tests/test-daily-stats.js — 上线日报统计/渲染自测（2026-11-24）
 * 不调模型、不联网、不写真实 data：全部在 os.tmpdir 造的 fixture 上跑。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ds = require('../src/daily-stats');
const D = '2026-11-23';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-dailystats-'));
const dataDir = path.join(tmp, 'data');
const banshiDir = path.join(tmp, 'astrbot', 'data', 'plugins', 'astrbot_plugin_banshi_auto', 'data');
fs.mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
fs.mkdirSync(banshiDir, { recursive: true });
fs.mkdirSync(path.join(tmp, 'astrbot', 'data', 'config'), { recursive: true });

const at = (day, h) => new Date(2026, 10, day, h || 10, 0, 0).toISOString();
const DAY = (h) => at(23, h);
const PREV = (h) => at(22, h);

function wf(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }
function jl(a) { return a.map(x => JSON.stringify(x)).join('\n') + '\n'; }

// bot-writes：今天 + 昨天各一批（昨天的必须被排除）
wf(path.join(dataDir, 'bot-writes.jsonl'), jl([
  { t: DAY(9), action: '话题', text: '别人原文 · a' },
  { t: DAY(9), action: '话题', text: '自己总结 · b' },
  { t: DAY(9), action: '话题', text: '搜索到的 · c' },
  { t: DAY(9), action: '话题', text: '搜索到的 · d' },
  { t: DAY(9), action: '话题', text: '别人原文 · e' },
  { t: DAY(9), action: '约定', text: '以后叫我爸爸' },
  { t: DAY(9), action: '喜恶', text: '白：喜欢 猫' },
  { t: DAY(9), action: '喜恶', text: '白：讨厌 香菜' },
  { t: DAY(9), action: '喜恶', text: '黑：喜欢 狗' },
  { t: DAY(9), action: '关系', text: '主人 → 白：喜' },
  { t: DAY(9), action: '关系', text: '黑 → 主人：厌' },
  { t: DAY(9), action: '关系', text: '共同话题 +1：主人 / 白' },
  { t: DAY(9), action: '新人物', text: '白 第一次说话' },
  { t: DAY(9), action: '新群', text: '进了群 123' },
  { t: DAY(9), action: '表情包收集', text: '收了 a' },
  { t: DAY(9), action: '表情包收集', text: '收了 b' },
  { t: DAY(9), action: '保健提醒', text: '提臀' },
  { t: DAY(9), action: 'QQ空间发动态', text: '一条说说' },
  { t: DAY(9), action: '逛空间评论', text: '白：评一句' },
  { t: DAY(9), action: '逛空间评论', text: '黑：评一句' },
  { t: PREV(9), action: '话题', text: '别人原文 · 昨天的' },
  { t: PREV(9), action: '关系', text: '白 → 黑：喜' },
]));

wf(path.join(dataDir, '她说过的话.jsonl'), jl([1, 2, 3, 4, 5].map(i => ({ t: DAY(9), text: 'x' + i }))));
wf(path.join(dataDir, 'topics.jsonl'), jl([
  { kind: 'topic', text: '别人原文 · a' },
  { kind: 'topic', text: '搜索到的 · c' },
  { kind: 'topic', text: '自己总结 · b' },
  { kind: 'promise', text: '约定' },
]));
wf(path.join(dataDir, 'chat-stars.json'), JSON.stringify([
  { at: DAY(9), by: 'emoji' }, { at: DAY(10), by: 'emoji' },
  { at: PREV(9), by: 'emoji' }, { at: DAY(9), by: 'manual' },
]));
wf(path.join(dataDir, 'ai-feedback.jsonl'), jl([
  { t: DAY(9), kind: '待修复', text: '有消息被撤回：「x」' },
  { t: DAY(9), kind: '待修复', text: '手动标记：y' },
  { t: PREV(9), kind: '待修复', text: '有消息被撤回：「z」' },
  { t: DAY(9), kind: '消息没发出去', text: 'a' },
  { t: DAY(10), kind: '消息没发出去', text: 'b' },
  { t: PREV(9), kind: '模型余额不足', text: 'c' },
]));
wf(path.join(dataDir, 'bili-dynamic-posted.jsonl'), jl([
  { at: DAY(9), priority: 'move-poop' }, { at: DAY(10), priority: 'move-poop' },
  { at: DAY(11), priority: 'diary' }, { at: PREV(9), priority: 'move-poop' },
]));
wf(path.join(dataDir, 'qzone-history.json'), JSON.stringify({
  posts: [{ t: '2026-11-23T10:00:00' }, { t: '2026-11-23T12:00:00' }, { t: '2026-11-22T10:00:00' }],
  days: { '2026-11-23': { done: 2 } },
}));
wf(path.join(dataDir, 'qzone-friend-comments.jsonl'), jl([
  { t: DAY(9) }, { t: DAY(10) }, { t: DAY(11) }, { t: PREV(9) },
]));
wf(path.join(dataDir, 'roco-bili-state.json'), JSON.stringify({
  commented: { a: 1, b: 1, c: 1 }, replyDaily: { '2026-11-22': 5 },
}));
wf(path.join(dataDir, 'usage', 'token-usage.jsonl'), jl([
  { t: DAY(9), ok: true }, { t: DAY(10), ok: false }, { t: PREV(9), ok: true },
]));
wf(path.join(dataDir, 'move-poop-stats.jsonl'), jl([
  { t: DAY(9), mid: 'm1', sourceGroup: '111', targetGroup: 't1' },
  { t: DAY(9), mid: 'm1', sourceGroup: '111', targetGroup: 't2' },
]));
// banshi：配置在 astrbot/data/config，数据在 plugins/.../data
wf(path.join(tmp, 'astrbot', 'data', 'config', 'astrbot_plugin_banshi_auto_config.json'),
  JSON.stringify({ source_group_list: ['999'], target_group_list: ['t1', 't2'] }));
const sec = (h) => new Date(2026, 10, 23, h || 10, 0, 0).getTime() / 1000;
const prevSec = new Date(2026, 10, 22, 10, 0, 0).getTime() / 1000;
// archive：当天取了 2 条（源群 999）
wf(path.join(banshiDir, 'archive', '2026-11-23.jsonl'), jl([
  { mid: 'm1', source: '999', at: sec(9) }, { mid: 'm2', source: '999', at: sec(9) },
]));
// sent：当天 m1→t1/t2、m2→t1，脚本重试留了一条重复（必须去重）；另有一条昨天的、一条更老的
wf(path.join(banshiDir, 'sent.jsonl'), jl([
  { mid: 'm1', target: 't1', at: sec(10) },
  { mid: 'm1', target: 't2', at: sec(11) },
  { mid: 'm2', target: 't1', at: sec(12) },
  { mid: 'key:mid:m1', target: 't1', at: sec(12) },
  { mid: 'm9', target: 't1', at: prevSec },
  { mid: 'm3', target: 't2', at: prevSec },
]));

const now = new Date(2026, 10, 23, 23, 0, 0).getTime();
const base = {
  dataDir, banshiDir, day: D, now,
  people: 12, groups: 3,
  favor: { 1: 14, 2: 3, 3: 8 },
  roco: { commented: 3, today: 10, todayRare: 1, todayCommon: 9, repliers: { todayNew: 2, today: 1 } },
  diaryView: { phase: 'published', day: D, published: { bili: { ok: true }, qzone: { ok: false } }, rules: { fallbackAt: '08:00' } },
  snapshot: {
    day: '2026-11-22', people: 10, groups: 2, topics: 1, promises: 0, searched: 0,
    favor: { 1: 10, 2: 5 },
  },
  cfg: {},
};

const m = ds.collect(base);
assert.strictEqual(m.msgTotal, 5, '共发消息');
assert.strictEqual(m.commentTotal, 12, '共评论=空间4+提醒3+回评5');
assert.strictEqual(m.postTotal, 7, '共动态=空间3+B站4');
assert.strictEqual(m.errorTotal, 3, '共报错=2条今天没发出去+1条昨天余额不足');
assert.strictEqual(m.errorToday, 2, '今日报错');
assert.strictEqual(m.issues.total, 3, '标错累计');
assert.strictEqual(m.issues.today, 2, '标错今日');
assert.strictEqual(m.issues.withdrawToday, 1, '撤回今日');
assert.strictEqual(m.stars.total, 4);
assert.strictEqual(m.stars.todayEmoji, 2);
assert.strictEqual(m.bili.today, 3);
assert.strictEqual(m.bili.todayShit, 2);
assert.strictEqual(m.bili.repliedNew, 2);
assert.strictEqual(m.qq.posts, 1);
assert.strictEqual(m.qq.comments, 2);
assert.strictEqual(m.topics.topic, 3);
assert.strictEqual(m.topics.promise, 1);
assert.strictEqual(m.botwrites.records, 3, '今日记录（不含搜索到）');
assert.strictEqual(m.botwrites.searched, 2);
assert.strictEqual(m.botwrites.pacts, 1);
assert.strictEqual(m.botwrites.stancePairs, 2, '昨天的关系不算');
assert.strictEqual(m.botwrites.stanceUp, 1);
assert.strictEqual(m.botwrites.stanceDown, 1);
assert.strictEqual(m.botwrites.stanceByPerson['主人'], 2);
assert.strictEqual(m.taste.people, 2);
assert.strictEqual(m.taste.entries, 3);
assert.strictEqual(m.other.newPeople, 1);
assert.strictEqual(m.other.newGroups, 1);
assert.strictEqual(m.other.stickers, 2);
assert.strictEqual(m.other.health, 1);
assert.strictEqual(m.other.calls, 2);
assert.strictEqual(m.other.fails, 1);
assert.strictEqual(m.deltas.people, 2);
assert.strictEqual(m.deltas.groups, 1);
assert.strictEqual(m.deltas.records, 2, '3条话题-1条昨天基线');
assert.strictEqual(m.favor.count, 2);
assert.strictEqual(m.favor.max.delta, 4);
assert.strictEqual(m.favor.min.delta, -2);
assert.strictEqual(m.shi.available, true);
assert.strictEqual(m.shi.sourceGroups, 2, 'banshi 1 + move-poop 1');
assert.strictEqual(m.shi.sourceMsgs, 3, 'banshi 2 + move-poop 1');
assert.strictEqual(m.shi.targetGroups, 2);
assert.strictEqual(m.shi.max, 3, 't1: banshi2+move1');
assert.strictEqual(m.shi.min, 2, 't2: banshi1+move1');
assert.strictEqual(m.diary.bili, true);
assert.strictEqual(m.diary.qzone, false);
assert.strictEqual(m.diary.leftMin, 540, '23:00 → 次日08:00 = 9小时');

const text = ds.render(m, { maxChars: 600 });
assert.ok(text.length <= 600, '渲染不超 600：' + text.length);
for (const s of ['昨日日报 11-23', '累计 消息5', '报错', '喜厌：2 对关系变化', '喜好：2 人记了 3 条',
  '好感：2 人变了', '屎 源2群/取3条 → 2群', '日记下次 08:00', 'B站 洛克10', 'QQ 动态1']) {
  assert.ok(text.includes(s), '缺少片段：' + s + '\n' + text);
}

// 超长 → 只丢行、不截半句；标题和累计必须在
const short = ds.render(m, { maxChars: 200 });
assert.ok(short.length <= 200);
assert.ok(short.includes('累计'));
assert.ok(!short.includes('日记下次'), '应先丢最新的尾巴');
assert.ok(short.split('\n').length < text.split('\n').length);

// 没有 banshi 目录：整块降级，不抛
const m2 = ds.collect(Object.assign({}, base, { dataDir: path.join(tmp, 'empty'), banshiDir: path.join(tmp, 'nope'), snapshot: null, favor: null }));
assert.strictEqual(m2.shi.available, false);
assert.ok(ds.render(m2, { maxChars: 600 }).includes('屎 —'));
assert.strictEqual(m2.hasPrev, false);
assert.ok(ds.render(m2, { maxChars: 600 }).includes('（—）'), '首跑差值显示 —');

// 快照写读
assert.strictEqual(ds.writeSnapshot(D, m, dataDir), true);
const snap = ds.readSnapshot(dataDir);
assert.strictEqual(snap.day, D);
assert.strictEqual(snap.people, 12);
assert.strictEqual(snap.favor['1'], 14);

// run(dry) 不写快照、不抛
const r2 = ds.run(Object.assign({}, base, { dry: true }));
assert.ok(r2.text.includes('昨日日报'));
assert.strictEqual(ds.readSnapshot(dataDir).day, D, 'dry 不该写快照');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ test-daily-stats 全部通过');
