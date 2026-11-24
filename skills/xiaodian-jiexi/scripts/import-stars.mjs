#!/usr/bin/env node
// 把机器人里的星标/热梗/解析留档整理成「群友幽默发言学习」表行。零依赖。
// node import-stars.mjs [--root /path/to/bot] [--dry] [--limit 120] [--out 文件]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const LIMIT = Number(argOf('--limit', '120')) || 120;
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(here, '..', 'references', '群友幽默发言学习.md');
const OUT = argOf('--out', DEFAULT_OUT);

function norm(s) { return String(s || '').replace(/[\s\p{P}\p{S}]/gu, ''); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function findDataDir() {
  const tries = [];
  const r = argOf('--root', '');
  if (r) tries.push(path.join(r, 'src', 'data'), path.join(r, 'data'));
  for (const e of ['XUHBOT_ROOT', 'DSH_WORKSPACE']) if (process.env[e]) tries.push(path.join(process.env[e], 'src', 'data'), path.join(process.env[e], 'data'));
  tries.push(path.join(process.cwd(), 'src', 'data'), path.join(process.cwd(), 'data'));
  for (const n of ['xuhbot', '.xuhbot', 'qq-companion-bot']) tries.push(path.join(os.homedir(), n, 'src', 'data'));
  for (const d of tries) if (exists(path.join(d, 'chat-stars.json'))) return d;
  let dir = path.resolve(process.cwd());
  for (let k = 0; k < 6; k++) {
    for (const d of [path.join(dir, 'src', 'data'), path.join(dir, 'data')]) {
      if (exists(path.join(d, 'chat-stars.json'))) return d;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const dataDir = findDataDir();
const rows = [];
const seen = new Set();
function push(who, text, ctx, src) {
  const t = String(text || '').trim();
  if (!t || t.length > 160 || t.length < 2) return;
  const key = norm(t);
  if (!key || seen.has(key)) return;
  seen.add(key);
  rows.push({ who: String(who || '群友').trim().slice(0, 20), text: t, ctx: String(ctx || '').trim().slice(0, 60), src });
}

const stats = { stars: 0, starsPrev: 0, memes: 0, history: 0 };
if (dataDir) {
  const p1 = path.join(dataDir, 'chat-stars.json');
  if (exists(p1)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p1, 'utf8'));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : Array.isArray(raw.list) ? raw.list : [];
      stats.stars = list.length;
      for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        if (e.prev && e.prevNick) { stats.starsPrev++; push(e.prevNick, e.prev, e.text, 'star.prev'); }
      }
    } catch (e) { console.error('chat-stars.json 解析失败: ' + e.message); }
  }
  const p2 = path.join(dataDir, '网络热梗.md');
  if (exists(p2)) {
    const raw = fs.readFileSync(p2, 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*[-*]\s*([^：:\n]{1,20})[：:]\s*(.+)$/.exec(line);
      if (m) { stats.memes++; push(m[1], m[2], '', '热梗'); continue; }
      const q = /[「“]([^」”]{2,80})[」”]/.exec(line);
      if (q) { stats.memes++; push('群友', q[1], '', '热梗'); }
    }
  }
  const p3 = path.join(dataDir, 'xiaodian-history.jsonl');
  if (exists(p3)) {
    for (const line of fs.readFileSync(p3, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const tgt = String(o.target || o.tgt || '');
        const m = /【聊天记录】([\s\S]*?)(【解析】|$)/.exec(tgt);
        const block = m ? m[1] : tgt;
        for (const l of String(block).split('\n')) {
          const r2 = /^\s*([^：:\n]{1,20})[：:]\s*(.+)$/.exec(l);
          if (r2) { stats.history++; push(r2[1], r2[2], '解析留档', 'history'); }
        }
      } catch { /* 跳过坏行 */ }
    }
  }
}

rows.length = Math.min(rows.length, LIMIT);
const table = rows.map((r) => '| ' + [r.who, r.text.replace(/\|/g, '｜'), r.ctx || '—', '（待标注机制）', '中', r.src].join(' | ') + ' |').join('\n');

if (DRY || !dataDir) {
  console.log('数据目录: ' + (dataDir || '未找到'));
  console.log('统计: ' + JSON.stringify(stats) + '  收集到 ' + rows.length + ' 条');
  console.log(rows.slice(0, 5).map((r) => '- [' + r.src + '] ' + r.who + '：' + r.text.slice(0, 40)).join('\n') || '(无)');
  if (DRY) process.exit(0);
}
if (!dataDir) { console.error('没找到数据目录，先跑 data-locate.mjs 或传 --root'); process.exit(1); }
if (!exists(OUT)) { console.error('模板不存在: ' + OUT); process.exit(1); }
const md = fs.readFileSync(OUT, 'utf8');
const head = md.split(/^## 数据$/m)[0];
const header = '| 群友 | 原话 | 当时语境 | 为什么好笑（机制） | 可复用度（高/中/低） | 备注 |\n|---|---|---|---|---|---|';
const body = head + '## 数据\n\n> 自动导入 ' + rows.length + ' 条（' + new Date().toISOString().slice(0, 10) + '，来源 ' + dataDir + '）。机制列待人工/模型标注。\n\n' + header + '\n' + table + '\n';
fs.writeFileSync(OUT, body);
console.log('已写入 ' + OUT + '（' + rows.length + ' 条）');
