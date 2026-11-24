/* 干跑：9 张图走现网 B站图片审核，只输出判定，不输出画面描述/图中文字原文。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const censor = require('../src/bili-censor');
const core = require('../src/core');

const O = '/Users/zhengbowen/.dsh/attachments/v1/objects';
const FILES = [
  ['A1 q累16', O + '/f0/f0c2c51a112b474ea78637a805c1be7020d5927943a05385b0b7237e80258699'],
  ['A2 q累17', O + '/02/024e2e7bb4b3657f2a7e47c6a38c4a722061dd891c0af81d20438436dcb9fab7'],
  ['A3 q累25', O + '/b1/b109cc0203a6a881efc210e0e454a7829fce49d4688c434f8290a6ff6894d5fc'],
  ['A4 q累15', O + '/d2/d21fb10c807c9d2874b172ab5254e9b3baec2d9be82fb2fa850d934149dc0e8b'],
  ['A5 q累11', O + '/5d/5d83b910eb52abd2933d329469a8ecff0fe4f6458a65d44f878e5774cba3e4ff'],
  ['A6 q累12', O + '/3a/3ae3a68cff38e58655f9eb4e9d695f0723bc23db3cba6ca6dd39d5952bd9b703'],
  ['A7 q害怕64', O + '/6b/6ba239f9713a0c68975dac53ba0ff89bce51b1dbd14630b9975fdcd9932af9cf'],
  ['A8 q害怕65', O + '/3d/3dcdc5b15939bf63a05fe75d1f9ed8cb3575888923cbdab564b0775ecdc1c1ab'],
  ['A9 q害怕33', O + '/20/20450ff13055f0c79854d7eb9c74395f6914922c67e17a01a20dc7b3a3668ca0'],
];

(async () => {
  const rows = [];
  for (let i = 0; i < FILES.length; i++) {
    const label = FILES[i][0];
    const file = FILES[i][1];
    let r = null;
    for (let k = 0; k < 2; k++) {
      try { r = await censor.judgeImage(file, core); } catch (e) { r = { pass: true, failOpen: true, why: '异常：' + (e && e.message) }; }
      if (r && !r.failOpen) break;
    }
    if (!r) r = { pass: true, failOpen: true, why: '无返回' };
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const hasText = !!String(r.ocrText || '').trim();
    const row = {
      n: i + 1, label, file, md5,
      pass: !!r.pass,
      kind: String(r.kind || ''),
      exposed: !!r.exposed,
      confidence: (typeof r.confidence === 'number' ? Math.round(r.confidence * 100) / 100 : null),
      failOpen: !!r.failOpen,
      why: String(r.why || ''),
      hasText,
      parts: Array.isArray(r.hits) ? r.hits.length : 0,
    };
    rows.push(row);
    console.log(JSON.stringify({ n: row.n, label: row.label, pass: row.pass, kind: row.kind, exposed: row.exposed, conf: row.confidence, failOpen: row.failOpen, hasText, why: row.why.slice(0, 30) }));
  }
  const blocked = rows.filter(x => !x.pass);
  const keywordSend = blocked.filter(x => !x.hasText);
  const out = '/tmp/dryrun-verdicts.json';
  fs.writeFileSync(out, JSON.stringify({ rows, blocked, keywordSend }, null, 1));
  console.log('SUMMARY', JSON.stringify({ total: rows.length, blocked: blocked.length, failOpen: rows.filter(x => x.failOpen).length, keywordSend: keywordSend.length }));
  console.log('OUT', out);
})().catch(e => { console.error('干跑异常：' + (e && e.stack || e)); process.exit(1); });
