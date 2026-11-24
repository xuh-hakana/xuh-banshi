#!/usr/bin/env node
'use strict';
/* tests/test-selfintro.js —— 自我介绍片自检（离线，不花钱）
 * 用法: node tests/test-selfintro.js [jobId] */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const copy = require('../src/mediagen/copy');
const frames = require('../src/mediagen/frames');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function jobs() {
  const d = path.join(ROOT, 'data', 'videojobs');
  try { return fs.readdirSync(d).filter(x => fs.existsSync(path.join(d, x, 'script.json'))).sort(); } catch (e) { return []; }
}
(async () => {
  const id = process.argv[2] || jobs().slice(-1)[0];
  console.log('自介绍片自检，job=' + (id || '(无)'));
  let dir = id ? path.join(ROOT, 'data', 'videojobs', id) : null;

  /* 1 文案门禁 */
  let script = null;
  try { script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')); } catch (e) {}
  ok('script.json 存在可解析', !!script);
  if (script) {
    const v = copy.check(script);
    ok('文案过门禁（禁词/长度/标签）', v.ok, (v.errs || []).slice(0, 4).join('；'));
    ok('5 段结构', script.shots.length === 5, '实际 ' + script.shots.length);
    ok('每段有台词且单句 ≤' + copy.LINE_MAX + ' 字', script.shots.every(s => s.lines.length && s.lines.every(l => Array.from(l).length <= copy.LINE_MAX)));
  }

  /* 2 多重真相：四类观众 */
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')); } catch (e) {}
  ok('persona.json 存在', !!rec);
  if (rec) {
    const ms = rec.missions || [];
    ok('四类观众齐', ms.length === 4, '实际 ' + ms.length);
    ok('每类都有 日常/需求/期待', ms.every(m => m.daily && m.needs && m.expect), JSON.stringify(ms.map(m => [m.who, !!m.daily, !!m.needs, !!m.expect])));
    ok('多重真相格式在位（k/at/layers/mustNot）', rec.k === 'bili-selfintro' && typeof rec.at === 'number' && Array.isArray(rec.layers) && Array.isArray(rec.mustNot));
    ok('落点在 multi-truth/out 里', fs.existsSync(path.join(ROOT, 'src', 'data', 'multi-truth', 'out', 'bili-selfintro.json')));
  }

  /* 3 时间轴 */
  let tl = null;
  try { tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')); } catch (e) {}
  ok('timeline.json 存在', !!tl);
  if (tl) {
    const lines = [];
    (tl.shots || []).forEach(s => (s.lines || []).forEach(l => lines.push(l)));
    let mono = true;
    for (let i = 1; i < lines.length; i++) if (lines[i].t0 < lines[i - 1].t1 - 0.001) mono = false;
    ok('台词时间轴单调不重叠', mono);
    ok('时间轴不超出总时长', lines.every(l => l.t1 <= tl.totalSec + 0.01));
    ok('时长 40-120 秒', tl.totalSec >= 40 && tl.totalSec <= 120, tl.totalSec.toFixed(1) + 's');
    ok('每句都有配音文件', lines.every(l => l.wav && fs.existsSync(l.wav)));
  }

  /* 4 单帧 smoke：真渲染一帧 1080p */
  const STICK = path.join(ROOT, 'src', 'data', 'stickers', '虚幻', '抓住我.jpg');
  const cfg = { width: 1920, height: 1080, fps: 30, totalSec: 2, bg: { c1: [252, 232, 241], c2: [255, 248, 251] },
    shots: [{ id: 'smoke', img: STICK, keyout: true, scale: 0.9, t0: 0, t1: 2, lines: [{ t0: 0.1, t1: 1.9, text: '嘻嘻，这是一帧' }] }] };
  const tmp = path.join(ROOT, 'data', 'videojobs', '_smoke.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  const png = path.join(ROOT, 'data', 'videojobs', '_smoke.png');
  const s = await frames.still(tmp, 20, png);
  ok('liveframe 渲染单帧', s.ok, s.err);
  if (s.ok) {
    const r = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], { encoding: 'utf8' });
    ok('单帧尺寸 1920x1080', String(r.stdout || '').trim() === '1920,1080', String(r.stdout || '').trim());
    try { fs.unlinkSync(png); fs.unlinkSync(tmp); } catch (e) {}
  }

  /* 5 成片 */
  const mp4 = dir ? path.join(dir, 'out', 'self-intro.mp4') : null;
  if (mp4 && fs.existsSync(mp4)) {
    const dur = frames.probeDuration(mp4);
    ok('成片存在且时长 40-120s', dur >= 40 && dur <= 120, dur.toFixed(1) + 's');
    const pr = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate', '-of', 'csv=p=0', mp4], { encoding: 'utf8' });
    const info = String(pr.stdout || '');
    ok('成片 h264 1920x1080 30fps', /h264/.test(info) && info.includes('1920,1080') && info.includes('30/1'), info.replace(/\n/g, ' | '));
    const pp = JSON.parse(fs.readFileSync(path.join(dir, 'publish-plan.json'), 'utf8'));
    ok('投稿预演 real=false（没发布）', pp.real === false);
  } else {
    console.log('  - 成片还没生成，跳过成片断言');
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
