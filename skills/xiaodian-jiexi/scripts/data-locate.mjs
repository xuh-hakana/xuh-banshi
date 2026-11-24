#!/usr/bin/env node
// 只读定位机器人数据目录（换台电脑也能找到）。零依赖。
// node data-locate.mjs [--root /path/to/bot] [--json]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILES = ['chat-stars.json', '网络热梗.md', 'xiaodian-history.jsonl', '说话风格.md', '人物喜好.md'];

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function dataDirOf(root) {
  for (const d of [path.join(root, 'src', 'data'), path.join(root, 'data')]) {
    if (exists(path.join(d, 'chat-stars.json'))) return d;
  }
  return null;
}

function candidates() {
  const list = [];
  const add = (p) => { if (p) list.push(path.resolve(String(p))); };
  const ai = process.argv.indexOf('--root');
  if (ai >= 0) add(process.argv[ai + 1]);
  add(process.env.XUHBOT_ROOT);
  add(process.env.XUHBOT_PATH);
  add(process.env.DSH_WORKSPACE);
  add(process.cwd());
  const home = os.homedir();
  for (const n of ['xuhbot', '.xuhbot', 'qq-companion-bot', 'xuhbot2']) add(path.join(home, n));
  return [...new Set(list)];
}

function upward(from) {
  const hits = [];
  let dir = path.resolve(from);
  for (let k = 0; k < 5; k++) {
    const d = dataDirOf(dir);
    if (d) hits.push({ root: dir, dataDir: d });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return hits;
}

const seen = new Set();
const found = [];
for (const c of candidates()) {
  for (const h of upward(c)) {
    const key = h.dataDir;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(h);
  }
}

const report = { found: found.map((h) => ({ root: h.root, dataDir: h.dataDir, files: FILES.map((f) => { const p = path.join(h.dataDir, f); let size = 0; let mtime = ''; if (exists(p)) { size = fs.statSync(p).size; mtime = new Date(fs.statSync(p).mtimeMs).toISOString().slice(0, 10); } return { name: f, path: p, exists: size > 0, size, mtime }; }) })), candidates: candidates() };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.found.length) {
  for (const h of report.found) {
    console.log('数据目录: ' + h.dataDir);
    for (const f of h.files) console.log('  ' + (f.exists ? '[有]' : '[无]') + ' ' + f.name + (f.exists ? '  ' + f.size + 'B  ' + f.mtime : ''));
  }
  console.log('\n导入群友发言: node scripts/import-stars.mjs --root "' + report.found[0].root + '" --dry');
} else {
  console.log('没找到机器人数据目录。已尝试:');
  for (const c of report.candidates) console.log('  - ' + c);
  console.log('手动指定: node scripts/data-locate.mjs --root /path/to/bot');
}
process.exit(0);
