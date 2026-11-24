'use strict';
/* ===========================================================================
 * asr.js — 语音转文字（本地 whisper.cpp，不花钱、不联网）
 *
 * 为什么用本地：主人 2026-11-23 让客户端能发语音，虚幻得听懂说什么。
 * 云端 ASR 要 Key、按次计费；本机已经装了 whisper.cpp（brew whisper-cpp）和 ffmpeg，
 * 模型放 src/data/models/ggml-*.bin（优先 large-v3-turbo），谁的模型都认。
 *
 * 两条路，先快后稳：
 *   ① whisper-server 常驻（127.0.0.1:8910）：模型只加载一次，短语音 1~2 秒出字；
 *      第一次转写时自动拉起，机器人退出时跟着关。
 *   ② whisper-cli 单跑：server 起不来 / 请求失败时退回；每次要重新加载 1.5G 模型，约 15 秒。
 *
 * 用法：
 *   asr.ready()                         // { ok, model, mode }
 *   await asr.transcribe('/abs/x.wav')  // { ok, text, error, ms, mode }
 * 不支持 / 没模型时**不抛**，返回 ok:false + error，调用方降级成「（没听清）」。
 * =========================================================================== */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MODEL_DIR = path.join(__dirname, 'data', 'models');
const WHISPER = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const WHISPER_SERVER = process.env.WHISPER_SERVER_BIN || '/opt/homebrew/bin/whisper-server';
const FFMPEG = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const SRV_PORT = Number(process.env.WHISPER_PORT || 8910);

let _modelCache = null;      // { at, file }
let _srv = null;             // 子进程
let _srvReadyAt = 0;         // 起来的时间（用于判断是否还在加载）
let _srvBroken = false;      // 一次起不来就别反复折腾，本次运行直接走 CLI
let _killHooked = false;     // process exit 钩子只挂一次

/* 挑一个模型：large-v3-turbo > medium > small > base > 其它，同级按体积大的优先。 */
function pickModel() {
  const now = Date.now();
  if (_modelCache && now - _modelCache.at < 30000) return _modelCache.file;
  let best = '';
  try {
    const files = fs.readdirSync(MODEL_DIR).filter(f => /^ggml-.*\.bin$/.test(f));
    const rank = f => /large-v3-turbo/.test(f) ? 0 : /large/.test(f) ? 1 : /medium/.test(f) ? 2 : /small/.test(f) ? 3 : /base/.test(f) ? 4 : 5;
    files.sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d) return d;
      try { return fs.statSync(path.join(MODEL_DIR, b)).size - fs.statSync(path.join(MODEL_DIR, a)).size; } catch { return 0; }
    });
    best = files.length ? path.join(MODEL_DIR, files[0]) : '';
  } catch {}
  _modelCache = { at: now, file: best };
  return best;
}

function ready() {
  const model = pickModel();
  const hasBin = fs.existsSync(WHISPER);
  const hasSrv = fs.existsSync(WHISPER_SERVER);
  const hasFfm = fs.existsSync(FFMPEG);
  return {
    ok: !!(model && hasBin && hasFfm),
    model: model ? path.basename(model) : '',
    bin: hasBin, server: hasSrv, ffmpeg: hasFfm,
    mode: hasSrv ? 'server' : (hasBin ? 'cli' : ''),
    error: !hasBin ? '没装 whisper-cli（brew install whisper-cpp）'
      : !hasFfm ? '没装 ffmpeg（brew install ffmpeg）'
        : !model ? '没模型：往 src/data/models/ 放 ggml-*.bin' : '',
  };
}

function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* ---------- 文字清洗 ---------- */
/* whisper 中文偶尔给繁体，虚幻一直说简体，混着很怪；另外会吐 [BLANK_AUDIO]、(音乐) 这类非人声。 */
const T2S = {
  '這': '这', '說': '说', '麼': '么', '嗎': '吗', '個': '个', '們': '们', '為': '为', '會': '会',
  '對': '对', '時': '时', '來': '来', '後': '后', '裡': '里', '點': '点', '開': '开', '關': '关',
  '發': '发', '現': '现', '實': '实', '覺': '觉', '過': '过', '還': '还', '聽': '听', '讓': '让',
  '給': '给', '從': '从', '話': '话', '語': '语', '誰': '谁', '樣': '样', '種': '种', '該': '该',
  '歡': '欢', '愛': '爱', '錯': '错', '難': '难', '經': '经', '應': '应', '張': '张', '臉': '脸',
  '頭': '头', '腳': '脚', '體': '体', '車': '车', '門': '门', '問': '问', '題': '题', '買': '买',
  '賣': '卖', '錢': '钱', '價': '价', '東': '东', '舊': '旧', '應': '应', '讓': '让', '還': '还',
};
const T2S_RE = new RegExp('[' + Object.keys(T2S).join('') + ']', 'g');
function cleanText(s) {
  const t = String(s || '')
    .replace(/\[(?:BLANK_AUDIO|Silence|silence|MUSIC|音乐|音乐声|掌声|笑声|SOUND)\]/g, '')
    .replace(/\((?:音乐|杂音|笑声|掌声|silence|music)\)/gi, '')
    .replace(/[\u200b-\u200f]/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t.replace(T2S_RE, c => T2S[c] || c);
}

/* ---------- ① 常驻 server ---------- */
function startServer() {
  if (_srv || _srvBroken) return _srv;
  const model = pickModel();
  if (!model || !fs.existsSync(WHISPER_SERVER) || !fs.existsSync(FFMPEG)) { _srvBroken = true; return null; }
  try {
    _srv = spawn(WHISPER_SERVER, ['-m', model, '--host', '127.0.0.1', '--port', String(SRV_PORT), '-t', '6'],
      { stdio: 'ignore', detached: false });
    _srvReadyAt = Date.now();
    _srv.on('exit', () => { _srv = null; });
    _srv.on('error', () => { _srv = null; _srvBroken = true; });
    if (!_killHooked) {
      _killHooked = true;
      process.once('exit', () => { try { if (_srv) _srv.kill(); } catch {} });
    }
    console.log('[asr] whisper-server 起了，端口 ' + SRV_PORT);
  } catch (e) {
    _srvBroken = true;
    _srv = null;
    console.log('[asr] whisper-server 起不来（' + e.message + '），改用逐条转写');
  }
  return _srv;
}

/* 等 server 能接请求：加载 1.5G 模型要几秒，用 / 探测 http 端口通了就算好。 */
function waitServer(ms) {
  const deadline = Date.now() + (ms || 20000);
  return new Promise(resolve => {
    const tick = () => {
      const rq = http.request({ host: '127.0.0.1', port: SRV_PORT, path: '/', method: 'GET', timeout: 1200 }, rs => {
        rs.resume();
        resolve(true);
      });
      rq.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 400);
      });
      rq.on('timeout', () => { try { rq.destroy(); } catch {} });
      rq.end();
    };
    tick();
  });
}

/* multipart 手拼（只为这一段，不引依赖） */
function srvInfer(wav, opt) {
  return new Promise((resolve, reject) => {
    let buf;
    try { buf = fs.readFileSync(wav); } catch (e) { return reject(e); }
    const bd = '----xuhasr' + Date.now();
    const fields = { response_format: 'json', language: String(opt.lang || 'zh'), temperature: '0' };
    const parts = [];
    for (const k of Object.keys(fields)) {
      parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
    }
    parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'));
    parts.push(buf);
    parts.push(Buffer.from('\r\n--' + bd + '--\r\n'));
    const body = Buffer.concat(parts);
    const rq = http.request({
      host: '127.0.0.1', port: SRV_PORT, path: '/inference', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + bd, 'Content-Length': body.length },
      timeout: Number(opt.timeoutMs) || 180000,
    }, rs => {
      let b = '';
      rs.setEncoding('utf8');
      rs.on('data', c => { b += c; });
      rs.on('end', () => {
        if (rs.statusCode !== 200) return reject(new Error('HTTP ' + rs.statusCode + '：' + b.slice(0, 120)));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('回包不是 JSON：' + b.slice(0, 120))); }
      });
    });
    rq.on('error', reject);
    rq.on('timeout', () => { try { rq.destroy(); } catch {} reject(new Error('转写超时')); });
    rq.write(body);
    rq.end();
  });
}

/* ---------- ② 逐条 CLI 兜底 ---------- */
async function cliTranscribe(wav, opt) {
  const outp = wav.replace(/\.wav$/, '') + '-cli';
  const w = await run(WHISPER, ['-m', pickModel(), '-f', wav, '-l', String(opt.lang || 'zh'), '-nt', '-otxt', '-of', outp,
    '--prompt', '以下是普通话的句子。'], Number(opt.timeoutMs) || 300000);
  let text = '';
  try { text = fs.readFileSync(outp + '.txt', 'utf8'); } catch {}
  if (!text && w.stdout) text = String(w.stdout).replace(/^\[[\d:.\s\-&gt;]+\]\s*/gm, '');
  try { fs.unlinkSync(outp + '.txt'); } catch {}
  if (!text && w.err) throw new Error(String(w.err.message || '').slice(0, 120));
  return text;
}

/* 主入口 */
async function transcribe(file, opt) {
  const t0 = Date.now();
  const o = opt || {};
  const src = String(file || '');
  if (!src || !fs.existsSync(src)) return { ok: false, error: '音频文件不在', ms: 0 };
  const st = ready();
  if (!st.ok) return { ok: false, error: st.error, ms: Date.now() - t0 };

  const tag = 'asr-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const wav = path.join(os.tmpdir(), tag + '.wav');
  try {
    const ff = await run(FFMPEG, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 120000);
    if (ff.err || !fs.existsSync(wav)) {
      const why = (ff.stderr || '').split('\n').filter(l => /error|Error|Invalid/.test(l)).slice(-1)[0] || (ff.err && ff.err.message) || '转码失败';
      return { ok: false, error: 'ffmpeg：' + String(why).slice(0, 120), ms: Date.now() - t0 };
    }
    let text = '', mode = '';
    if (!_srvBroken && fs.existsSync(WHISPER_SERVER)) {
      startServer();
      /* 刚 spawn 出来的要等模型加载（约 4 秒，给 25 秒余量）；
       * 没 spawn 成（端口被别人占了 / 上次的还在跑）就只探一下，探到能连就直接用那个。 */
      if (await waitServer(_srv ? 25000 : 1200)) {
        try {
          const r = await srvInfer(wav, o);
          text = String((r && (r.text || r.transcription)) || '');
          mode = 'server';            // 请求成功就算 server 通道（哪怕没听出字，也不该再跑一遍 CLI 白等 15 秒）
        } catch (e) { console.log('[asr] server 转写失败（' + e.message + '），改 CLI'); }
      }
    }
    if (!mode) { text = await cliTranscribe(wav, o); mode = 'cli'; }
    text = cleanText(text);
    if (!text) return { ok: false, error: '没听出字（可能没声音）', mode, ms: Date.now() - t0 };
    return { ok: true, text: text.slice(0, 2000), model: path.basename(pickModel()), mode, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 160), ms: Date.now() - t0 };
  } finally {
    try { fs.unlinkSync(wav); } catch {}
  }
}

module.exports = { ready, transcribe, pickModel, cleanText, MODEL_DIR, SRV_PORT };
