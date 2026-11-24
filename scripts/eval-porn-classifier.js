/* 色图判定评测：29 张带标签图走真实视觉模型，输出混淆矩阵与误判清单。
 * 用法：node scripts/eval-porn-classifier.js [--only positives]
 * 退出码 0 = 正样本全中且负样本 0 误判。 */
'use strict';
const fs = require('fs');
const path = require('path');
const censor = require('../src/bili-censor');
const core = require('../src/core');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'porn-eval-labels.json');
const CACHE = path.join(ROOT, 'data', 'temp', 'porn-eval');
const OUT = '/tmp/porn-eval-result.json';
const THRESHOLD = 0.6;

function localCopy(it) {
  try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}
  const dest = path.join(CACHE, it.id + '.img');
  if (!fs.existsSync(dest)) fs.copyFileSync(it.src, dest);
  return dest;
}

(async () => {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
  const noRefs = process.argv.includes('--no-refs');
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const items = man.items.filter(x => !only || (only === 'positives' ? x.label === 'porn' : x.label === 'normal'));
  const rows = [];
  for (const it of items) {
    const file = localCopy(it);
    let r = null;
    for (let k = 0; k < 2; k++) {
      try { r = await censor.judgeImage(file, core, { noRefs }); } catch (e) { r = { pass: true, failOpen: true, why: '异常：' + (e && e.message) }; }
      if (r && !r.failOpen) break;
    }
    if (!r) r = { pass: true, failOpen: true, why: '无返回' };
    const conf = typeof r.pornConfidence === 'number' ? Math.round(r.pornConfidence * 100) / 100 : 0;
    const called = !!r.porn;
    const blocked = called && conf >= THRESHOLD && !!r.pass;
    const row = {
      id: it.id, name: it.name, label: it.label,
      porn: called, conf, exposed: !!r.exposed, pass: !!r.pass,
      blocked, failOpen: !!r.failOpen, why: String(r.why || ''),
      overridden: !!r.overridden,
      hasText: !!String(r.ocrText || '').trim(),
    };
    rows.push(row);
    console.log([row.id, row.name, row.label, 'porn=' + row.porn, 'conf=' + row.conf, 'exposed=' + row.exposed, row.failOpen ? 'FAILOPEN' : 'ok'].join(' '));
  }
  const P = rows.filter(r => r.label === 'porn');
  const N = rows.filter(r => r.label === 'normal');
  const tp = P.filter(r => r.blocked).length;
  const fn = P.length - tp;
  const fp = N.filter(r => r.blocked).length;
  const tn = N.length - fp;
  const fails = rows.filter(r => r.failOpen);
  const summary = {
    total: rows.length, tp, fn, fp, tn,
    recall: P.length ? Math.round(tp / P.length * 1000) / 10 : null,
    specificity: N.length ? Math.round(tn / N.length * 1000) / 10 : null,
    accuracy: rows.length ? Math.round((tp + tn) / rows.length * 1000) / 10 : null,
    failOpen: fails.length, threshold: THRESHOLD,
    refs: !noRefs, overridden: rows.filter(r => r.overridden).length,
  };
  console.log('SUMMARY ' + JSON.stringify(summary));
  if (fn) console.log('FN ' + P.filter(r => !r.blocked).map(r => r.id + ':' + r.name + '(porn=' + r.porn + ',conf=' + r.conf + ')').join(' | '));
  if (fp) console.log('FP ' + N.filter(r => r.blocked).map(r => r.id + ':' + r.name + '(conf=' + r.conf + ')').join(' | '));
  if (fails.length) console.log('FAILOPEN ' + fails.map(r => r.id + ':' + r.why.slice(0, 40)).join(' | '));
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
  console.log('OUT ' + OUT);
  process.exit(tp === P.length && fp === 0 ? 0 : 2);
})().catch(e => { console.error('评测异常：' + (e && e.stack || e)); process.exit(1); });
