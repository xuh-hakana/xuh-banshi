#!/usr/bin/env node
'use strict';
/* scripts/self-intro.js —— 虚幻 B 站自我介绍片（只出片，绝不发布）
 * 流程：样本 → 多重真相四类观众 → 文案 → 配音 → 2.5D 帧 → 合成 → 投稿预演
 * 用法：node scripts/self-intro.js --build | --dry-script | --resume <jobId> | --still */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const styleSource = require('../src/mediagen/style-source');
const audience = require('../src/mediagen/audience');
const copy = require('../src/mediagen/copy');
const tts = require('../src/mediagen/tts');
const frames = require('../src/mediagen/frames');
const music = require('../src/mediagen/music');

const STICK = path.join(ROOT, 'src', 'data', 'stickers', '虚幻');
const SHOT_MAP = [
  { id: 'hook', file: '抓住我.jpg', keyout: true, scale: 0.92, eye: [0.18, 0.32, 0.84, 0.44] },
  { id: 'who', file: '这个可爱.jpg', keyout: false, scale: 0.62 },
  { id: 'serve', file: '不要.jpg', keyout: true, scale: 0.86 },
  { id: 'why', file: '奶茶不够甜.jpg', keyout: true, scale: 0.90 },
  { id: 'cta', file: '哭.jpg', keyout: true, scale: 0.82 },
];
const GAP_LINE = 0.32, GAP_SHOT = 0.55, HEAD_PAD = 0.7, TAIL_PAD = 1.1;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--build') a.build = true;
    else if (t === '--dry-script') a.dry = true;
    else if (t === '--no-bgm') a.noBgm = true;
    else if (t === '--still') { a.still = true; a.stillIdx = Number(argv[++i] || 0); }
    else if (t === '--voice') a.voice = argv[++i];
    else if (t === '--resume') a.resume = argv[++i];
    else a._.push(t);
  }
  return a;
}
function jobId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function jw(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return obj; }
function jr(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function log(...x) { console.log('[self-intro]', ...x); }

async function main() {
  const a = parseArgs(process.argv);
  const id = a.resume || jobId();
  const dir = path.join(ROOT, 'data', 'videojobs', id);
  const voDir = path.join(dir, 'vo');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(voDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const state = jr(stateFile, { id, at: new Date().toISOString(), steps: {} });
  log('job', id);

  let sources = a.resume ? jr(path.join(dir, 'sources.json'), null) : null;
  if (!sources) {
    sources = await styleSource.collect();
    jw(path.join(dir, 'sources.json'), sources);
  }
  state.steps.sources = { ok: true, notes: sources.notes };
  log('样本 tier1=' + ((sources.tier1.bili.items || []).length) + ' tier2=' + ((sources.tier2.masterExamples.items || []).length));

  let rec = a.resume ? jr(path.join(dir, 'persona.json'), null) : null;
  if (!rec) {
    rec = await audience.build({});
    jw(path.join(dir, 'persona.json'), rec);
  }
  state.steps.audience = { ok: true, missions: (rec.missions || []).length, notes: rec.notes || [] };
  log('四类观众：' + (rec.missions || []).map(m => m.who).join('、'));

  const scriptFile = path.join(dir, 'script.json');
  let script = a.resume ? jr(scriptFile, null) : null;
  if (!script) {
    const cr = await copy.make(sources, rec, {});
    if (!cr.ok) {
      state.steps.copy = { ok: false, errs: cr.errs };
      jw(stateFile, state);
      console.error('[self-intro] 文案门禁没过：\n - ' + (cr.errs || []).join('\n - '));
      process.exit(4);
    }
    script = cr.script;
    script.jobId = id;
    script.totalChars = cr.total;
    jw(scriptFile, script);
    log('文案通过门禁，' + cr.total + ' 字，用了 ' + cr.attempts + ' 版');
  }
  state.steps.copy = { ok: true, totalChars: script.totalChars };
  if (a.dry) { jw(stateFile, state); console.log(JSON.stringify(script, null, 2)); return; }

  let t = HEAD_PAD;
  const shots = [];
  for (let si = 0; si < script.shots.length; si++) {
    const s = script.shots[si];
    const map = SHOT_MAP[si] || SHOT_MAP[SHOT_MAP.length - 1];
    const shot = { id: s.id || map.id, img: path.join(STICK, map.file), keyout: map.keyout, scale: map.scale, eye: map.eye || null, seed: 1.05 + si * 0.7, t0: t, lines: [] };
    for (let li = 0; li < s.lines.length; li++) {
      const text = String(s.lines[li]).trim();
      const wav = path.join(voDir, shot.id + '_' + li + '.wav');
      let sp;
      if (a.resume && fs.existsSync(wav) && frames.probeDuration(wav) > 0.2) sp = { ok: true, durSec: frames.probeDuration(wav), engine: 'cache' };
      else sp = await tts.speak(text, wav, { voice: a.voice, rate: a.rate || '-6%' });
      if (!sp.ok) {
        state.steps.tts = { ok: false, why: sp.why || sp.notes };
        jw(stateFile, state);
        console.error('[self-intro] 配音失败：' + JSON.stringify(sp).slice(0, 300));
        process.exit(5);
      }
      shot.lines.push({ t0: t, t1: t + sp.durSec, text, wav });
      t = t + sp.durSec + GAP_LINE;
    }
    shot.t1 = t - GAP_LINE + GAP_SHOT;
    t = shot.t1;
    shots.push(shot);
  }
  const totalSec = t + TAIL_PAD;
  state.steps.tts = { ok: true, lines: shots.reduce((n, s) => n + s.lines.length, 0) };
  jw(path.join(dir, 'timeline.json'), { totalSec, shots });

  const mixWav = path.join(voDir, 'mix.wav');
  const bgmWav = path.join(dir, 'bgm.wav');
  if (!a.noBgm) { try { await music.make({ out: bgmWav, seconds: Math.ceil(totalSec) + 2, mood: 'warm' }); } catch (e) { log('BGM 失败，忽略：' + e.message); } }
  const inputs = [];
  const delays = [];
  shots.forEach(s => s.lines.forEach(l => { inputs.push(l.wav); delays.push(Math.round(l.t0 * 1000)); }));
  const parts = inputs.map((f, i) => '[' + i + ']adelay=' + delays[i] + '|' + delays[i] + ',volume=1.0[a' + i + ']');
  const mixLabels = inputs.map((_, i) => '[a' + i + ']').join('');
  let filter = parts.join(';') + ';' + mixLabels + 'amix=inputs=' + inputs.length + ':normalize=0[vo]';
  const bgmOk = fs.existsSync(bgmWav);
  if (bgmOk) filter += ';[' + inputs.length + ']volume=0.16,atrim=0:' + (totalSec + 1) + '[bg];[vo][bg]amix=inputs=2:normalize=0,alimiter=limit=0.95[aout]';
  else filter += ';[vo]alimiter=limit=0.95[aout]';
  const args = ['-y', '-v', 'error'];
  for (const f of inputs) args.push('-i', f);
  if (bgmOk) args.push('-i', bgmWav);
  args.push('-filter_complex', filter, '-map', '[aout]', '-ar', '44100', '-ac', '2', '-t', String(totalSec), mixWav);
  const mix = spawnSync('/opt/homebrew/bin/ffmpeg', args, { encoding: 'utf8' });
  if (mix.status !== 0 || !fs.existsSync(mixWav)) {
    state.steps.mix = { ok: false, err: String(mix.stderr || '').slice(-500) };
    jw(stateFile, state);
    console.error('[self-intro] 混音失败：' + String(mix.stderr || '').slice(-500));
    process.exit(6);
  }
  state.steps.mix = { ok: true, bgm: bgmOk };

  const cfgPath = path.join(dir, 'frame-config.json');
  jw(cfgPath, frames.buildCfg({ totalSec, shots, fps: 30, width: 1920, height: 1080 }));
  if (a.still) {
    const o = await frames.still(cfgPath, a.stillIdx, path.join(outDir, 'still-' + a.stillIdx + '.png'));
    jw(stateFile, state);
    log('still ' + (o.ok ? 'ok → ' + o.out : 'FAIL ' + o.err));
    return;
  }
  const mp4 = path.join(outDir, 'self-intro.mp4');
  log('渲染中… 总时长 ' + totalSec.toFixed(1) + 's');
  const ren = await frames.run(cfgPath, mp4, mixWav);
  state.steps.render = { ok: ren.ok, codePy: ren.codePy, codeFf: ren.codeFf, ffErr: ren.ffErr, pyErr: ren.pyErr };
  if (!ren.ok) {
    jw(stateFile, state);
    console.error('[self-intro] 渲染失败 py=' + ren.codePy + ' ff=' + ren.codeFf + '\n' + ren.ffErr + '\n' + ren.pyErr);
    process.exit(7);
  }

  const plan = {
    real: false,
    title: String(script.title || '').slice(0, 80),
    desc: String(script.desc || '').slice(0, 2000),
    tags: (script.tags || []).slice(0, 10),
    tid: 188,
    video: mp4,
    checks: { titleOk: Array.from(String(script.title || '')).length <= 80, descOk: Array.from(String(script.desc || '')).length <= 2000, tagsOk: (script.tags || []).length >= 1 && (script.tags || []).length <= 10 },
    howToPublishLater: 'node scripts/video-factory.js --publish   # 只演练；真发要 --publish --publish-real（本次不做）',
  };
  jw(path.join(dir, 'publish-plan.json'), plan);
  state.steps.publishPlan = { ok: true, real: false };
  state.done = true;
  jw(stateFile, state);
  log('出片完成：' + mp4 + '（' + frames.probeDuration(mp4).toFixed(1) + 's）');
  log('投稿预演：' + path.join(dir, 'publish-plan.json') + '（real=false，没发）');
}
main().catch(e => { console.error('[self-intro] 崩了：' + ((e && e.stack) || e)); process.exit(9); });
