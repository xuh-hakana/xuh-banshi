/* B站动态 publisher 自测：槽位、10 条/天、间隔、去重、筛选、日记共用。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pub-'));
process.env.BILI_DYNAMIC_DATA_DIR = TMP;
process.env.BILI_DYNAMIC_CONFIG = path.join(TMP, 'features.json');
process.env.BILI_DYNAMIC_NO_SELFPOST = '1';
fs.writeFileSync(process.env.BILI_DYNAMIC_CONFIG, JSON.stringify({ biliDynamic: { enabled: true, dailyCap: 10, gapSeconds: 600, maxImages: 9, retryMax: 5, pollSeconds: 60 } }));

const p = require('../src/bili-dynamic-publisher');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); } };

function reset() {
  for (const f of [p.QUEUE, p.POSTED, p.FILTERED]) { try { fs.rmSync(f, { force: true }); } catch {} }
  fs.rmSync(p.INBOX, { recursive: true, force: true });
  fs.mkdirSync(p.INBOX, { recursive: true });
}
let posted = [];
p._setDeps({
  judgeText: t => ({ pass: !String(t).includes('BAD'), kind: 'political', hits: String(t).includes('BAD') ? ['x'] : [] }),
  judgeImage: async f => ({ pass: !String(f).includes('bad'), kind: 'exposure', hits: String(f).includes('bad') ? ['x'] : [] }),
  isPureColloquialChat: lines => Array.isArray(lines) && lines.length >= 2 && lines.every(x => String(x).length < 20),
  postDynamic: async (text, pics) => { posted.push({ text, pics }); return { ok: true, dynId: 'D' + posted.length }; },
  uploadImage: async () => ({ img_src: 'http://x/y.png', img_width: 1, img_height: 1, img_size: 1 }),
});

function inbox(name, obj) { fs.writeFileSync(path.join(p.INBOX, name), JSON.stringify(obj), 'utf8'); }
const base = { id: 'm1', source: '100000000', mids: ['1'], at: 1, kind: 'text' };
const T0 = new Date('2026-11-23T10:05:00').getTime();

(async () => {
  // 1) 槽位
  const slots = p._planSlots('2026-11-23');
  ok('每天 10 个槽', slots.length === 10, String(slots.length));
  ok('相邻 >=600 秒', slots.every((s, i) => !i || s.at - slots[i - 1].at >= 600000));
  const hh = slots.map(s => new Date(s.at).getHours());
  ok('9-14 五个', hh.filter(h => h >= 9 && h < 14).length === 5, hh.join(','));
  ok('18-22 五个', hh.filter(h => h >= 18 && h < 22).length === 5, hh.join(','));

  // 2) 正常发布 + 内容去重
  reset(); posted = [];
  inbox('a.json', Object.assign({}, base, { text: 'hello' }));
  let r = await p.tickOnce(T0);
  ok('到槽位发布一条', r.ok && posted.length === 1 && r.used === 1, JSON.stringify(r));
  inbox('b.json', Object.assign({}, base, { id: 'm2', mids: ['2'], text: 'hello' }));
  r = await p.tickOnce(T0 + 700000);
  ok('同内容不重复', posted.length === 1, 'posted=' + posted.length);

  // 3) 间隔 >=10 分钟
  reset(); posted = [];
  inbox('c.json', Object.assign({}, base, { id: 'm3', mids: ['3'], text: 'first' }));
  await p.tickOnce(T0);
  inbox('d.json', Object.assign({}, base, { id: 'm4', mids: ['4'], text: 'second' }));
  r = await p.tickOnce(T0 + 60000);
  ok('10 分钟内不发第二条', posted.length === 1, 'posted=' + posted.length);
  r = await p.tickOnce(T0 + 700000);
  ok('超过 10 分钟后再发', posted.length === 2, 'posted=' + posted.length);

  // 4) 日记优先、共用额度
  reset(); posted = [];
  const dq = p.enqueueDiary('diary text');
  ok('日记入队', dq.ok === true && dq.queued === true);
  inbox('e.json', Object.assign({}, base, { id: 'm5', mids: ['5'], text: 'move text' }));
  await p.tickOnce(T0);
  ok('日记先发', posted.length === 1 && posted[0].text === 'diary text', JSON.stringify(posted));

  // 5) 筛选：政治、视频、纯口语、暴露图
  reset(); posted = [];
  inbox('f1.json', Object.assign({}, base, { id: 'm6', mids: ['6'], text: 'BAD text' }));
  inbox('f2.json', Object.assign({}, base, { id: 'm7', mids: ['7'], kind: 'video', text: 'video' }));
  inbox('f3.json', Object.assign({}, base, { id: 'm8', mids: ['8'], kind: 'forward', text: '', lines: [{ nick: 'a', text: '哈哈哈' }, { nick: 'b', text: '在吗' }] }));
  const badImg = path.join(TMP, 'bad.jpg'); fs.writeFileSync(badImg, Buffer.from([0xff, 0xd8, 1, 2, 3]));
  inbox('f4.json', Object.assign({}, base, { id: 'm9', mids: ['9'], text: '', kind: 'image', images: [{ path: badImg }] }));
  r = await p.tickOnce(T0);
  ok('全部被筛掉', r.pending === 0 && posted.length === 0, JSON.stringify(r));
  const fl = fs.existsSync(p.FILTERED) ? fs.readFileSync(p.FILTERED, 'utf8').trim().split('\n').length : 0;
  ok('筛掉有审计记录', fl >= 4, String(fl));

  // 6) 每天 10 条封顶
  reset(); posted = [];
  const st = p._loadState(T0);
  st.used = 10; st.slots.forEach(s => { s.used = true; });
  p._saveState(st);
  inbox('g.json', Object.assign({}, base, { id: 'm10', mids: ['10'], text: 'over cap' }));
  r = await p.tickOnce(T0);
  ok('满 10 条不再发', posted.length === 0);

  console.log('B站 publisher 自测：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
