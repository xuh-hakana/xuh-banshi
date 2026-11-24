#!/usr/bin/env node
'use strict';
/*
 * setup-video.js —— 视频工坊依赖安装（幂等，2026-11-25）
 *
 * 三件套，各管一个场景：
 *   1. data/vendor/mpt-venv     MoneyPrinterTurbo（一句话成片：配音+字幕+剪辑）
 *   2. data/vendor/biliup       biliup（B 站投稿）
 *   3. data/vendor/uv           uv（装 python，不动系统 brew，因为 /opt/homebrew 权限不给写）
 *
 * 用法：
 *   node scripts/setup-video.js           # 装缺的
 *   node scripts/setup-video.js --check   # 只看装没装
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'data', 'vendor');
const UV = path.join(VENDOR, 'uv', 'uv');
const MPT_PY = path.join(VENDOR, 'mpt-venv', 'bin', 'python');
const BILIUP = path.join(VENDOR, 'biliup', 'biliupR-v1.3.5-aarch64-macos', 'biliup');
const BILIUP_URL = 'https://github.com/biliup/biliup/releases/download/v1.3.5/biliupR-v1.3.5-aarch64-macos.tar.xz';

const CHECK_ONLY = process.argv.includes('--check');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs || 900000, ...opts, cwd: opts.cwd || ROOT });
  return { ok: r.status === 0, code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim(), err: (r.stderr || '').trim() };
}
const say = (s) => console.log(s);

function env() {
  return {
    ...process.env,
    UV_CACHE_DIR: path.join(VENDOR, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(VENDOR, 'pythons'),
    UV_TOOL_DIR: path.join(VENDOR, 'uv-tools'),
  };
}

function check() {
  const st = [];
  st.push({ name: 'uv', ok: fs.existsSync(UV), path: UV });
  st.push({ name: 'python3.11 venv', ok: fs.existsSync(MPT_PY), path: MPT_PY });
  let mptOk = false;
  if (st[1].ok) mptOk = run(MPT_PY, ['-c', 'import mpt'], { timeoutMs: 120000 }).ok;
  st.push({ name: 'mpt (MoneyPrinterTurbo)', ok: mptOk, path: 'pip: mpt' });
  let edgeOk = false;
  if (st[1].ok) edgeOk = run(MPT_PY, ['-c', 'import edge_tts'], { timeoutMs: 60000 }).ok;
  st.push({ name: 'edge-tts (配音)', ok: edgeOk, path: 'pip: edge-tts' });
  st.push({ name: 'biliup (投稿)', ok: fs.existsSync(BILIUP), path: BILIUP });
  return st;
}

function print(st) {
  say('\n视频工坊依赖状态：');
  for (const s of st) say(`  ${s.ok ? '✅' : '❌'} ${s.name.padEnd(24)} ${s.path}`);
  const bad = st.filter((s) => !s.ok).map((s) => s.name);
  say(bad.length ? `\n缺：${bad.join('、')}` : '\n全齐。');
  return bad.length === 0;
}

function ensureUv() {
  if (fs.existsSync(UV)) return true;
  say('[1/3] 装 uv（放到 data/vendor/uv，不动系统目录）…');
  fs.mkdirSync(path.join(VENDOR, 'uv'), { recursive: true });
  const r = run('bash', ['-lc', `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${VENDOR}/uv" UV_UNMANAGED_INSTALL="${VENDOR}/uv" sh`]);
  if (!fs.existsSync(UV)) { say('  ❌ uv 没装上：' + r.out.slice(-400)); return false; }
  say('  ✅ ' + run(UV, ['--version']).out);
  return true;
}

function ensureMpt() {
  if (fs.existsSync(MPT_PY) && run(MPT_PY, ['-c', 'import mpt'], { timeoutMs: 120000 }).ok) {
    say('[2/3] mpt 已装，跳过');
    return true;
  }
  say('[2/3] 建 python3.11 venv 并装 mpt（约 5-15 分钟，别关）…');
  const e = env();
  const v = run(UV, ['venv', '--python', '3.11', path.join(VENDOR, 'mpt-venv')], { env: e });
  if (!v.ok) { say('  ❌ venv 失败：' + v.out.slice(-500)); return false; }
  const p = run(UV, ['pip', 'install', '--python', MPT_PY, 'mpt'], { env: e });
  if (!p.ok) { say('  ❌ pip install mpt 失败：' + p.out.slice(-800)); return false; }
  const ok = run(MPT_PY, ['-c', 'import mpt'], { timeoutMs: 120000 });
  say(ok.ok ? '  ✅ mpt 可 import' : '  ❌ mpt import 失败：' + ok.out.slice(-400));
  return ok.ok;
}

function ensureBiliup() {
  if (fs.existsSync(BILIUP)) { say('[3/3] biliup 已装，跳过'); return true; }
  say('[3/3] 下载 biliup（mac arm64）…');
  const dir = path.join(VENDOR, 'biliup');
  fs.mkdirSync(dir, { recursive: true });
  const r = run('bash', ['-lc', `cd "${dir}" && curl -sL -o biliup.tar.xz "${BILIUP_URL}" && tar xf biliup.tar.xz`]);
  if (!fs.existsSync(BILIUP)) { say('  ❌ 下载/解压失败：' + r.out.slice(-400)); return false; }
  try { fs.chmodSync(BILIUP, 0o755); } catch {}
  run('bash', ['-lc', `xattr -d com.apple.quarantine "${BILIUP}" 2>/dev/null || true`]);
  const v = run(BILIUP, ['--version']);
  say('  ✅ ' + (v.out || '').split('\n')[0]);
  return true;
}

function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  if (CHECK_ONLY) { process.exit(print(check()) ? 0 : 1); }
  ensureUv();
  ensureMpt();
  ensureBiliup();
  process.exit(print(check()) ? 0 : 1);
}

main();
