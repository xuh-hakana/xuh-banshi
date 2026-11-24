'use strict';
/* mediagen/tts.js —— 配音（edge-tts 本地二进制，失败降级 mac say）
 * 每段单独合成，返回 {file, durSec, words:[{t0,t1,text}]}，时间轴直接驱动字幕与口型。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const EDGE = path.join(ROOT, 'data', 'vendor', 'mpt-venv', 'bin', 'edge-tts');
const PY = path.join(ROOT, 'data', 'vendor', 'mpt-venv', 'bin', 'python');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const VOICE = 'zh-CN-XiaoyiNeural';

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) ? d : 0;
}
function parseSrt(txt) {
  const out = [];
  const blocks = String(txt || '').replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const m = b.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\s*\n([\s\S]+)/);
    if (!m) continue;
    const t0 = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const t1 = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const text = m[9].replace(/\n/g, '').trim();
    if (text) out.push({ t0, t1, text });
  }
  return out;
}
/* edge-tts 没成功时：say 出声，时间轴按字数比例硬分 */
function fallbackSay(text, outWav) {
  const aiff = outWav.replace(/\.wav$/, '.aiff');
  const r = spawnSync('say', ['-v', 'Eddy', '-r', '185', '-o', aiff, text], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(aiff)) return { ok: false, why: (r.stderr || 'say 失败').slice(0, 200) };
  const c = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', aiff, '-ar', '44100', '-ac', '1', outWav], { encoding: 'utf8' });
  try { fs.unlinkSync(aiff); } catch (e) {}
  if (c.status !== 0) return { ok: false, why: (c.stderr || 'ffmpeg 转换失败').slice(0, 200) };
  const dur = probe(outWav);
  const chars = Array.from(text);
  const per = dur / Math.max(1, chars.length);
  return { ok: true, engine: 'say', file: outWav, durSec: dur, words: chars.map((ch, i) => ({ t0: i * per, t1: (i + 1) * per, text: ch })) };
}

async function speak(text, outWav, o) {
  const opt = o || {};
  const voice = opt.voice || VOICE;
  const mp3 = outWav.replace(/\.wav$/, '.mp3');
  const srt = outWav.replace(/\.wav$/, '.srt');
  const args = ['--voice', voice, '--rate=' + (opt.rate || '+0%'), '--text', text, '--write-media', mp3, '--write-subtitles', srt];
  const r = spawnSync(EDGE, args, { encoding: 'utf8', timeout: 120000 });
  if (r.status === 0 && fs.existsSync(mp3)) {
    const c = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', mp3, '-ar', '44100', '-ac', '1', outWav], { encoding: 'utf8' });
    if (c.status === 0) {
      let words = [];
      try { words = parseSrt(fs.readFileSync(srt, 'utf8')); } catch (e) {}
      const dur = probe(outWav);
      if (dur > 0) return { ok: true, engine: 'edge-tts', voice, file: outWav, durSec: dur, words };
    }
  }
  const fb = fallbackSay(text, outWav);
  fb.notes = ['edge-tts 失败：' + String((r.stderr || r.error || '') + '').slice(0, 200)];
  return fb;
}
module.exports = { speak, probe, parseSrt, VOICE, EDGE, PY, FFMPEG };
