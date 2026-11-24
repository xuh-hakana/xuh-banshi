/* 色图判定自测：判为色图的图不发布、进共享台账（kind=porn）；低置信/开关关闭照常发。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-porn-'));
process.env.BILI_DYNAMIC_DATA_DIR = TMP;
process.env.PORN_OVERRIDES = path.join(TMP, 'porn-overrides.json');
process.env.PORN_REFS_DIR = path.join(TMP, 'no-refs');
process.env.BILI_DYNAMIC_CONFIG = path.join(TMP, 'features.json');
process.env.BILI_DYNAMIC_NO_SELFPOST = '1';
const CFG = process.env.BILI_DYNAMIC_CONFIG;
const writeCfg = extra => fs.writeFileSync(CFG, JSON.stringify({
  biliDynamic: Object.assign({ enabled: true, dailyCap: 100, gapSeconds: 0, maxImages: 9, retryMax: 5, pollSeconds: 60, blockedKeepDays: 7, blockedMaxFiles: 300 }, extra || {}),
}));
writeCfg();

const p = require('../src/bili-dynamic-publisher');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); } };

const mk = (name, byte) => { const f = path.join(TMP, name); fs.writeFileSync(f, Buffer.from([0xff, 0xd8, byte, byte, byte])); return f; };
const md5Of = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const imgPorn = mk('porn.jpg', 11);
const imgLow = mk('low.jpg', 12);
const imgOff = mk('off.jpg', 13);
const pornMd5 = md5Of(imgPorn), lowMd5 = md5Of(imgLow), offMd5 = md5Of(imgOff);

let mode = 'on';
const verdicts = f => {
  const n = path.basename(String(f));
  if (n.startsWith('porn')) return { pass: true, porn: true, pornConfidence: 0.9, ocrText: '', kind: '', hits: [] };
  if (n.startsWith('low')) return { pass: true, porn: true, pornConfidence: 0.4, ocrText: '', kind: '', hits: [] };
  return { pass: true, porn: false, pornConfidence: 0.1, ocrText: '', kind: '', hits: [] };
};
p._setDeps({
  judgeText: () => ({ pass: true, hits: [] }),
  judgeImage: async f => verdicts(f),
  isPureColloquialChat: () => false,
  postDynamic: async () => ({ ok: true, dynId: 'D' + Math.random() }),
  uploadImage: async () => ({ img_src: 'http://x/y.png', img_width: 1, img_height: 1, img_size: 1 }),
});

const inbox = (name, obj) => fs.writeFileSync(path.join(p.INBOX, name), JSON.stringify(obj), 'utf8');
const base = { source: '100000000', at: 1, kind: 'mixed' };
const T0 = new Date('2026-11-23T10:05:00').getTime();

(async () => {
  fs.rmSync(p.INBOX, { recursive: true, force: true });
  fs.mkdirSync(p.INBOX, { recursive: true });
  inbox('a.json', Object.assign({}, base, { id: 'a', mids: ['901'], images: [{ path: imgPorn }, { path: imgLow }] }));
  await p.tickOnce(T0);

  const s1 = fs.existsSync(p.BLOCKED_JSON) ? JSON.parse(fs.readFileSync(p.BLOCKED_JSON, 'utf8')) : { items: {} };
  ok('色图进共享台账', !!(s1.items || {})[pornMd5], JSON.stringify(Object.keys(s1.items || {})));
  ok('色图 kind=porn', ((s1.items || {})[pornMd5] || {}).kind === 'porn', JSON.stringify((s1.items || {})[pornMd5]));
  ok('低置信色图不拦', !(s1.items || {})[lowMd5]);

  // 关掉开关：同为色图也不拦
  writeCfg({ pornCensorEnabled: false });
  inbox('b.json', Object.assign({}, base, { id: 'b', mids: ['902'], images: [{ path: imgOff }] }));
  await p.tickOnce(T0 + 700000);
  const s2 = JSON.parse(fs.readFileSync(p.BLOCKED_JSON, 'utf8'));
  ok('开关关闭不拦色图', !(s2.items || {})[offMd5], JSON.stringify(Object.keys(s2.items || {})));

  // 主人改判通道：override 直接生效，不再问模型
  const censor = require('../src/bili-censor');
  const imgFixPorn = mk('fixporn.jpg', 31);
  const imgFixNormal = mk('fixnormal.jpg', 32);
  fs.writeFileSync(process.env.PORN_OVERRIDES, JSON.stringify({ [md5Of(imgFixPorn)]: true, [md5Of(imgFixNormal)]: false }));
  const rFixPorn = await censor.judgeImage(imgFixPorn, null);
  ok('改判 porn 直接命中', rFixPorn.porn === true && rFixPorn.overridden === true, JSON.stringify(rFixPorn));
  const rFixNormal = await censor.judgeImage(imgFixNormal, null);
  ok('改判 normal 直接放行', rFixNormal.porn === false && rFixNormal.overridden === true, JSON.stringify(rFixNormal));
  ok('没有 refs 时退回单图不报错', Array.isArray(censor._loadRefs()) && censor._loadRefs().length === 0);

  console.log((fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + (pass + fail) + ' (tmp: ' + TMP + ')');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：' + (e && e.stack || e)); process.exit(1); });
