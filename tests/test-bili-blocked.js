/* B站动态被筛图留档自测：筛掉的图要留档，给 QQ 群关键词点图用。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-blocked-'));
process.env.BILI_DYNAMIC_DATA_DIR = TMP;
process.env.BILI_DYNAMIC_CONFIG = path.join(TMP, 'features.json');
process.env.BILI_DYNAMIC_NO_SELFPOST = '1';
fs.writeFileSync(process.env.BILI_DYNAMIC_CONFIG, JSON.stringify({
  biliDynamic: { enabled: true, dailyCap: 10, gapSeconds: 600, maxImages: 9, retryMax: 5, pollSeconds: 60, blockedKeepDays: 7, blockedMaxFiles: 300 },
}));

const p = require('../src/bili-dynamic-publisher');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); } };

const imgGood = path.join(TMP, 'good.jpg');
const imgBad = path.join(TMP, 'bad.jpg');
fs.writeFileSync(imgGood, Buffer.from([0xff, 0xd8, 1, 2, 3]));
fs.writeFileSync(imgBad, Buffer.from([0xff, 0xd8, 9, 8, 7]));
const badMd5 = crypto.createHash('md5').update(fs.readFileSync(imgBad)).digest('hex');

p._setDeps({
  judgeText: () => ({ pass: true, hits: [] }),
  judgeImage: async f => String(f).includes('bad')
    ? { pass: false, kind: 'exposure', hits: ['x'], reason: '图片暴露隐私部位', ocrText: String(f).includes('badtext') ? '水印' : '' }
    : { pass: true, kind: '', hits: [], ocrText: '' },
  isPureColloquialChat: () => false,
  postDynamic: async () => ({ ok: true, dynId: 'D1' }),
  uploadImage: async () => ({ img_src: 'http://x/y.png', img_width: 1, img_height: 1, img_size: 1 }),
});

const inbox = (name, obj) => fs.writeFileSync(path.join(p.INBOX, name), JSON.stringify(obj), 'utf8');
const base = { source: '100000000', at: 1, kind: 'mixed' };
const T0 = new Date('2026-11-23T10:05:00').getTime();

(async () => {
  fs.rmSync(p.INBOX, { recursive: true, force: true });
  fs.mkdirSync(p.INBOX, { recursive: true });
  inbox('a.json', Object.assign({}, base, { id: 'a', mids: ['111'], images: [{ path: imgGood }, { path: imgBad }] }));
  await p.tickOnce(T0);

  const store = fs.existsSync(p.BLOCKED_JSON) ? JSON.parse(fs.readFileSync(p.BLOCKED_JSON, 'utf8')) : { items: {} };
  const rec = (store.items || {})[badMd5];
  ok('被筛图有台账', !!rec, JSON.stringify(Object.keys(store.items || {})));
  ok('台账记了源 mids', rec && Array.isArray(rec.mids) && rec.mids.includes('111'), rec && JSON.stringify(rec.mids));
  ok('台账图片已落盘', rec && fs.existsSync(rec.path));
  ok('台账只记类别不记词', rec && rec.kind === 'exposure' && !JSON.stringify(rec).includes('隐私'));
  ok('无文字的被拦图 hasText=false', rec && rec.hasText === false, rec && JSON.stringify(rec.hasText));
  ok('通过初筛的图不进来', !(store.items || {})[crypto.createHash('md5').update(fs.readFileSync(imgGood)).digest('hex')]);

  // 同一张图再被筛一次：md5 去重，mids 并入
  inbox('b.json', Object.assign({}, base, { id: 'b', mids: ['222'], images: [{ path: imgBad }] }));
  await p.tickOnce(T0 + 700000);
  const store2 = JSON.parse(fs.readFileSync(p.BLOCKED_JSON, 'utf8'));
  const rec2 = (store2.items || {})[badMd5];
  ok('同图不重复占盘', Object.keys(store2.items || {}).length === 1, String(Object.keys(store2.items || {}).length));
  ok('同图 mids 并入', rec2 && rec2.mids.includes('111') && rec2.mids.includes('222'), rec2 && JSON.stringify(rec2.mids));

  // 图里带字（B站识图有文字）的被拦图：台账要记 hasText=true
  const imgTxt = path.join(TMP, 'badtext.jpg');
  fs.writeFileSync(imgTxt, Buffer.from([0xff, 0xd8, 5, 5, 5]));
  const txtMd5 = crypto.createHash('md5').update(fs.readFileSync(imgTxt)).digest('hex');
  inbox('c.json', Object.assign({}, base, { id: 'c', mids: ['333'], images: [{ path: imgTxt }] }));
  await p.tickOnce(T0 + 1400000);
  const store3 = JSON.parse(fs.readFileSync(p.BLOCKED_JSON, 'utf8'));
  const rec3 = (store3.items || {})[txtMd5];
  ok('含字被拦图 hasText=true', rec3 && rec3.hasText === true, rec3 && JSON.stringify(rec3));

  console.log((fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + (pass + fail) + ' (tmp: ' + TMP + ')');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：' + (e && e.stack || e)); process.exit(1); });
