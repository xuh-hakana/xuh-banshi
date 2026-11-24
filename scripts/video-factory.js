#!/usr/bin/env node
'use strict';
/*
 * video-factory.js —— 视频工坊 CLI（一句话 → 成片 → B 站）
 *
 * 分场景各用现成轮子，这个文件只做编排：
 *   文案分镜  → llm.js（deepseek/智谱，走已有 key）
 *   AI 画面   → clips.js（智谱 CogVideoX-Flash，失败降级成图+推拉）
 *   配乐      → music.js（程序化编曲，零成本必成功；有音乐 AI key 再换）
 *   配音字幕剪辑 → MoneyPrinterTurbo CLI（mpt cli，现成轮子）
 *   投稿      → biliup（现成轮子，默认只 dry-run）
 *
 * 用法：
 *   node scripts/video-factory.js --topic "为什么AI画画这么强" --live
 *   node scripts/video-factory.js --topic "..." --script "自己写的文案" --live --shots 3
 *   node scripts/video-factory.js --resume <jobId>
 *   node scripts/video-factory.js --topic "..." --live --publish          # dry-run 投稿
 *   node scripts/video-factory.js --topic "..." --live --publish --publish-real
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const keys = require(path.join(ROOT, 'src', 'mediagen', 'keys'));
const llm = require(path.join(ROOT, 'src', 'mediagen', 'llm'));
const clips = require(path.join(ROOT, 'src', 'mediagen', 'clips'));
const music = require(path.join(ROOT, 'src', 'mediagen', 'music'));
const mpt = require(path.join(ROOT, 'src', 'mediagen', 'mpt'));
const bili = require(path.join(ROOT, 'src', 'mediagen', 'bili'));

const JOBS = path.join(ROOT, 'data', 'videojobs');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'media.json'), 'utf8')); } catch { return {}; }
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[name] = true;
    else { a[name] = next; i++; }
  }
  return a;
}

const say = (...s) => console.log(...s);
function step(name, msg) { say('  [' + name + '] ' + msg); }

function newJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}
function writeState(dir, st) {
  st.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st, null, 1));
}

const PLAN_PROMPT = (topic, n) => `你是短视频编导。围绕主题「${topic}」写一条适合 B 站的知识类短视频。
只输出 JSON，不要解释，不要 markdown 围栏。结构：
{
  "title": "≤30字的标题，有钩子",
  "desc": "≤200字简介",
  "tags": ["5到8个标签"],
  "script": "口播文案，中文，200-320字，分句用中文句号，不要序号",
  "terms": "逗号分隔的5个英文检索词",
  "shots": [{"prompt": "画面提示词，中文，描述一个具体场景", "caption": "这句画面配的那一小句文案"}]
}
shots 必须正好 ${n} 个，画面提示词要能直接给文生视频模型用（写清主体、场景、光线、镜头运动、风格）。`;

async function makePlan(args, st) {
  if (args.script) {
    const n = Number(args.shots) || (cfg().video || {}).shots || 3;
    const topic = String(args.topic || '即兴短片');
    const shots = [];
    const sents = String(args.script).split(/(?<=[。！？])/).filter((s) => s.trim());
    for (let i = 0; i < n; i++) {
      shots.push({ prompt: `${topic}，第${i + 1}个画面，电影感，柔和光线，缓慢推进`, caption: (sents[i] || sents[0] || topic).trim() });
    }
    return { title: topic.slice(0, 30), desc: String(args.script).slice(0, 200), tags: (cfg().publish || {}).tags || [], script: String(args.script), terms: topic, shots };
  }
  const n = Number(args.shots) || (cfg().video || {}).shots || 3;
  const topic = String(args.topic || '').trim();
  if (!topic) throw new Error('缺 --topic（或给 --script 自己写文案）');
  const c = cfg();
  const provider = String((c.llm || {}).provider || 'deepseek');
  step('script', '用 ' + provider + ' 写文案与 ' + n + ' 个分镜…');
  let raw = '';
  try {
    raw = await llm.chat({ provider, messages: [{ role: 'user', content: PLAN_PROMPT(topic, n) }], temperature: 0.8, maxTokens: 2200 });
  } catch (e) {
    step('script', 'LLM 失败（' + e.message.slice(0, 120) + '），退回模板文案');
    const sents = [`今天聊聊${topic}。`, `先说结论：它比你想的更近。`, `三个要点，一次讲清。`, `细节决定体验。`, `最后总结一句。`];
    const script = sents.join('');
    return { title: topic.slice(0, 30), desc: sents.join(''), tags: (c.publish || {}).tags || [], script, terms: topic, shots: sents.slice(0, n).map((s, i) => ({ prompt: `${topic}，场景${i + 1}，电影感构图，柔和光线`, caption: s })) };
  }
  const plan = llm.extractJson(raw);
  if (!plan.script) throw new Error('分镜缺 script');
  plan.shots = (plan.shots || []).slice(0, n);
  while (plan.shots.length < n) plan.shots.push({ prompt: topic + '，补充画面，电影感', caption: plan.script.slice(0, 20) });
  return plan;
}

async function makeClips(plan, dir, args) {
  const c = cfg();
  const v = c.video || {};
  const width = Number(v.width) || 1920, height = Number(v.height) || 1080;
  const fps = Number(v.fps) || 30, sec = Number(v.shotSeconds) || 5;
  const useVideo = !!args.live && !args['no-ai-video'];
  const clipsDir = path.join(dir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  const out = [];
  const queue = plan.shots.map((s, i) => ({ s, i }));
  const workers = [];
  const CONC = Math.max(1, Math.min(3, Number(args.conc) || 2));
  for (let w = 0; w < CONC; w++) {
    workers.push((async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const f = path.join(clipsDir, 'shot-' + String(item.i + 1).padStart(2, '0') + '.mp4');
        try {
          step('clips', `镜头${item.i + 1}/${plan.shots.length} ${useVideo ? 'AI视频' : 'AI插图'}…`);
          const r = await clips.makeClip(item.s.prompt, f, { useVideo, width, height, fps, seconds: sec, pollTimeoutMs: v.pollTimeoutMs || 480000 });
          out[item.i] = { path: f, kind: r.kind, notes: r.notes };
          step('clips', `镜头${item.i + 1} 完成（${r.kind}）`);
        } catch (e) {
          step('clips', `镜头${item.i + 1} 失败：${e.message.slice(0, 160)}`);
          out[item.i] = { path: '', error: e.message.slice(0, 200) };
        }
      }
    })());
  }
  await Promise.all(workers);
  return out.filter((x) => x && x.path);
}

function ffprobe(file) {
  try {
    const r = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(r);
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
    return {
      duration: Number((j.format || {}).duration || 0),
      sizeMB: Math.round(Number((j.format || {}).size || 0) / 1048576),
      vcodec: v.codec_name || '', acodec: a.codec_name || '', w: v.width || 0, h: v.height || 0,
      hasAudio: !!a.codec_name,
    };
  } catch (e) { return { error: e.message.slice(0, 200) }; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    say(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/*')[1]);
    return;
  }
  fs.mkdirSync(JOBS, { recursive: true });
  const jobId = args.resume ? String(args.resume) : newJobId();
  const dir = path.join(JOBS, jobId);
  fs.mkdirSync(dir, { recursive: true });
  let st = readState(dir) || { jobId, createdAt: new Date().toISOString(), steps: {} };
  say('\n=== 视频工坊 ' + jobId + ' ===');
  say('目录：' + dir);
  say('模式：' + (args.live ? '实跑（真调 AI）' : '演练（不调视频模型，只出图+成片）') + (args.publish ? (args['publish-real'] ? ' + 真投稿' : ' + 投稿演练') : ''));

  // 1) 文案与分镜
  if (!st.plan) {
    st.plan = await makePlan(args, st);
    st.steps.script = 'ok';
    writeState(dir, st);
  } else step('script', '已有分镜，跳过');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 1));
  say('标题：' + st.plan.title);
  say('文案：' + String(st.plan.script).slice(0, 60) + '…');

  // 2) 画面
  let clipsList = st.clips || [];
  if (!clipsList.length) {
    clipsList = await makeClips(st.plan, dir, args);
    st.clips = clipsList;
    st.steps.clips = clipsList.length ? 'ok' : 'failed';
    writeState(dir, st);
  } else step('clips', '已有 ' + clipsList.length + ' 个片段，跳过');
  if (!clipsList.length) throw new Error('一个画面都没生成出来，停在这里（看上面 clips 的报错）');

  // 3) 配乐
  const bgm = path.join(dir, 'bgm.wav');
  if (!fs.existsSync(bgm)) {
    const est = clipsList.length * (Number((cfg().video || {}).shotSeconds) || 5);
    const r = await music.make({ out: bgm, seconds: Math.max(20, est) });
    st.steps.music = 'ok';
    step('music', '程序化编曲 ' + r.bytes + ' bytes');
    writeState(dir, st);
  } else step('music', '已有配乐，跳过');

  // 4) MPT 出片
  const clipsDir = path.join(dir, 'clips');
  let final = path.join(dir, 'out', 'final.mp4');
  let mres = null;
  if (!fs.existsSync(final)) {
    step('render', '交给 MoneyPrinterTurbo 配音+字幕+合成（3-10 分钟）…');
    mres = await mpt.generate({
      subject: st.plan.title,
      script: st.plan.script,
      terms: st.plan.terms || st.plan.title,
      materialsDir: clipsDir,
      bgmFile: fs.existsSync(bgm) ? bgm : '',
    });
    if (!mres.ok || !mres.finals.length) {
      st.steps.render = 'failed';
      st.renderLog = mres.log;
      writeState(dir, st);
      throw new Error('MPT 没出成片（code=' + mres.code + '）\n' + mres.log);
    }
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.copyFileSync(mres.finals[0], final);
    st.steps.render = 'ok';
    writeState(dir, st);
  } else step('render', '已有成片，跳过');

  const info = ffprobe(final);
  fs.copyFileSync(final, path.join(dir, 'out', 'final.mp4'));
  st.output = final;
  st.probe = info;
  writeState(dir, st);
  say('\n=== 成片 ===');
  say('路径：' + final);
  say(JSON.stringify(info));

  // 5) 投稿
  if (args.publish) {
    const p = cfg().publish || {};
    const tag = (st.plan.tags && st.plan.tags.length ? st.plan.tags : p.tags || []).slice(0, 10).join(',');
    const payload = {
      video: final,
      title: String(st.plan.title).slice(0, 80),
      desc: String(st.plan.desc || st.plan.script || '').slice(0, 1900),
      tag,
      tid: String(args.tid || p.tid || 188),
      cover: fs.existsSync(path.join(dir, 'cover.jpg')) ? path.join(dir, 'cover.jpg') : '',
      dryRun: !args['publish-real'],
    };
    const r = await bili.upload(payload);
    st.publish = r;
    writeState(dir, st);
    if (r.dryRun) {
      say('\n=== 投稿演练（没真发）===');
      say(JSON.stringify(r.plan, null, 1));
      say('真发：加 --publish-real');
    } else {
      say('\n=== 投稿结果 ===');
      say(JSON.stringify(r, null, 1));
    }
  }

  say('\n完成。state：' + path.join(dir, 'state.json'));
}

main().catch((e) => { console.error('\n❌ ' + (e && e.message ? e.message : e)); process.exit(1); });
