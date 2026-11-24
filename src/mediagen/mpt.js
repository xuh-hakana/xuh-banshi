'use strict';
/*
 * mpt.js —— 调 MoneyPrinterTurbo 的 CLI（一句话成片这条场景的轮子）
 *
 * 为什么不自己写剪辑：MPT 已经做完了「配音 + 字幕 + 转场 + 混音 + 合成」，
 * 还自带 local 素材源（--video-source local --video-materials <目录>），
 * 正好把智谱 CogVideoX 生成的 AI 片段喂进去。我们只当调度。
 *
 * 两个坑（实测踩过）：
 *   1. mpt 包的 Python 模块叫 app，和本仓库顶层 app/（Electron）同名 → 必须在 site-packages 目录下
 *      起进程，否则 import 到我们的 app/ 直接炸。
 *   2. --task-id 必须是合法 UUID，不是随便的字符串。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const keys = require('./keys');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'data', 'vendor');
const VENV = path.join(VENDOR, 'mpt-venv');
const PY = path.join(VENV, 'bin', 'python');
const SITE = path.join(VENV, 'lib', 'python3.11', 'site-packages');
// MPT 安装版默认把配置与产物写到 ~/Library/Application Support/MoneyPrinterTurbo，
// 沙箱里写不了；paths.py 认 MPT_HOME，指到工作区内。
const MPT_HOME = process.env.MPT_HOME_FORCE || path.join(VENDOR, 'mpt-home');
const CFG = path.join(MPT_HOME, 'config.toml');
const EXAMPLE = path.join(SITE, 'app', '_assets', 'config.example.toml');
const STORAGE = path.join(MPT_HOME, 'storage');

function mediaCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'media.json'), 'utf8')); } catch { return {}; }
}

function installed() {
  return fs.existsSync(PY) && fs.existsSync(SITE);
}

/** 把 config.toml 补齐：LLM 用已有 key 的源（默认 moonshot），不写 key 到日志 */
function ensureConfig() {
  if (!installed()) throw new Error('MPT 没装：先跑 node scripts/setup-video.js');
  if (!fs.existsSync(CFG)) {
    if (!fs.existsSync(EXAMPLE)) throw new Error('找不到 config.example.toml');
    fs.mkdirSync(MPT_HOME, { recursive: true });
    fs.copyFileSync(EXAMPLE, CFG);
  }
  let txt = fs.readFileSync(CFG, 'utf8');
  const cfg = mediaCfg();
  const provider = String((cfg.llm && cfg.llm.provider) || 'moonshot');
  const model = String((cfg.llm && cfg.llm.model) || '');
  const key = keys.get(provider);
  const before = txt;

  const setKV = (k, v) => {
    const re = new RegExp('^' + k + '\\s*=.*$', 'm');
    if (re.test(txt)) txt = txt.replace(re, k + ' = ' + JSON.stringify(v));
    else txt += '\n' + k + ' = ' + JSON.stringify(v) + '\n';
  };

  setKV('llm_provider', provider);
  if (key) setKV(provider + '_api_key', key);
  if (model) setKV(provider + '_model_name', model);

  if (txt !== before) fs.writeFileSync(CFG, txt, { mode: 0o600 });
  return { provider, modelSet: !!model, keySet: !!key, path: CFG };
}

/** MPT 只认自己 resource/fonts 下的字体文件，先把自带字体搬进去 */
function ensureFonts() {
  const src = path.join(SITE, 'app', '_assets', 'resource', 'fonts');
  const dst = path.join(MPT_HOME, 'resource', 'fonts');
  fs.mkdirSync(dst, { recursive: true });
  if (!fs.existsSync(src)) return dst;
  for (const n of fs.readdirSync(src)) {
    const s = path.join(src, n), d = path.join(dst, n);
    try { if (fs.statSync(s).isFile() && !fs.existsSync(d)) fs.copyFileSync(s, d); } catch {}
  }
  return dst;
}

/** 挑一个中文字体文件名（带扩展名，MPT 校验的就是这个） */
function pickFont() {
  const cfg = mediaCfg();
  const dir = ensureFonts();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.(ttf|otf|ttc)$/i.test(n)) : [];
  const want = cfg.video && cfg.video.fontName ? String(cfg.video.fontName) : '';
  if (want && files.includes(want)) return want;
  const hit = files.find((n) => /(yahei|msyh|hei|noto.*(sc|cjk)|source.*han|wqy|siyuan)/i.test(n));
  return hit || files[0] || '';
}

function newTaskId() { return crypto.randomUUID(); }

/** 把外面目录里的素材搬进 MPT 的 storage/local_videos，返回目标目录 */
function stageDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const exts = /\.(mp4|mov|mkv|webm|avi|jpg|jpeg|png|webp)$/i;
  for (const n of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, n);
    if (!fs.statSync(s).isFile() || !exts.test(n)) continue;
    fs.copyFileSync(s, path.join(dstDir, n));
  }
  return dstDir;
}

/**
 * 生成成片
 * @param {object} o { subject, script, terms, materialsDir, bgmFile, taskId, aspect, clipDuration, fontName, extraArgs }
 */
function generate(o = {}) {
  ensureConfig();
  const taskId = o.taskId || newTaskId();
  const cfg = mediaCfg();
  const v = cfg.video || {};
  const t = cfg.tts || {};
  const args = [
    '--video-subject', String(o.subject || ''),
    '--video-script', String(o.script || ''),
    '--video-terms', String(o.terms || o.subject || ''),
    '--video-language', 'zh-CN',
    '--video-aspect', String(o.aspect || '16:9'),
    '--video-clip-duration', String(o.clipDuration || v.shotSeconds || 5),
    '--video-transition-mode', String(o.transition || 'fade-in'),
    '--voice-name', String(o.voice || t.voice || 'zh-CN-XiaoxiaoNeural'),
    '--voice-rate', String(typeof t.rate === 'number' ? t.rate : 1.0),
    '--subtitle-enabled',
    '--task-id', taskId,
  ];
  // MPT 只认自己 storage 里的素材/配乐（实测 CLI 会直接拒绝对外路径），先搬进去
  if (o.materialsDir) {
    const staged = stageDir(o.materialsDir, path.join(STORAGE, 'local_videos', taskId));
    // --video-materials 要的是「逗号分隔的文件路径」，不是目录
    const files = fs.readdirSync(staged).filter((n) => /\.(mp4|mov|mkv|webm|avi|jpg|jpeg|png|webp)$/i.test(n))
      .sort().map((n) => path.join(staged, n));
    if (!files.length) throw new Error('素材目录里没有可用文件：' + o.materialsDir);
    args.push('--video-source', 'local', '--video-materials', files.join(','));
  }
  if (o.bgmFile && fs.existsSync(o.bgmFile)) {
    const bg = path.join(STORAGE, 'bgm', taskId + path.extname(o.bgmFile));
    fs.mkdirSync(path.dirname(bg), { recursive: true });
    fs.copyFileSync(o.bgmFile, bg);
    args.push('--bgm-type', 'custom', '--bgm-file', bg, '--bgm-volume', '0.25');
  } else args.push('--bgm-type', 'none');
  const font = o.fontName || pickFont();
  if (!font) args.push('--no-subtitle-background-enabled');
  else args.push('--font-name', font);
  if (o.stopAt) args.push('--stop-at', String(o.stopAt));
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs.map(String));

  const py = [
    'import sys',
    'sys.path.insert(0, ' + JSON.stringify(SITE) + ')',
    'from app import cli',
    'sys.exit(cli.run_cli(' + JSON.stringify(args) + '))',
  ].join('\n');

  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(PY, ['-c', py], { cwd: SITE, env: { ...process.env, MPT_HOME, PYTHONIOENCODING: 'utf-8', IMAGEIO_FFMPEG_EXE: '/opt/homebrew/bin/ffmpeg' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const finals = findFinals(taskId);
      resolve({
        ok: code === 0 && finals.length > 0,
        code, taskId, finals,
        ms: Date.now() - started,
        log: out.split('\n').filter((l) => l.trim()).slice(-25).join('\n'),
      });
    });
  });
}

/** 找某个 task 产出的 mp4（final 优先） */
function findFinals(taskId) {
  const base = path.join(STORAGE, 'tasks', String(taskId));
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, n.name);
      if (n.isDirectory()) walk(f);
      else if (/\.mp4$/i.test(n.name)) out.push(f);
    }
  };
  walk(base);
  return out.sort((a, b) => {
    const fa = /final/i.test(a) ? 0 : 1, fb = /final/i.test(b) ? 0 : 1;
    return fa - fb || fs.statSync(b).size - fs.statSync(a).size;
  });
}

module.exports = { installed, ensureConfig, generate, findFinals, newTaskId, pickFont, PY, SITE, STORAGE, CFG, MPT_HOME };
