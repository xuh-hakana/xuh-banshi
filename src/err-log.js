// 错误台账（2026-11-23 主人定）：难以溯源的关键环节统一记这里，别再 catch {} 静默吞掉。
// 写 data/err-log.jsonl（一行一条）+ data/err-stats.json（按 scope 计数），超 2MB 轮转一份。
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const LOG = path.join(DATA, 'err-log.jsonl');
const STATS = path.join(DATA, 'err-stats.json');
const MAX_BYTES = 2 * 1024 * 1024;
let _stats = null;

function loadStats() {
  if (_stats) return _stats;
  try { _stats = JSON.parse(fs.readFileSync(STATS, 'utf8')) || {}; } catch (e) { _stats = {}; }
  if (!_stats.v) _stats = { v: 1, scopes: {}, last: 0 };
  if (!_stats.scopes) _stats.scopes = {};
  return _stats;
}

function saveStats() {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATS, JSON.stringify(_stats), 'utf8'); } catch (e) {}
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG);
    if (st.size < MAX_BYTES) return;
    try { fs.renameSync(LOG, LOG.replace(/\.jsonl$/, '.1.jsonl')); } catch (e) {}
  } catch (e) {}
}

function logErr(scope, msg, extra) {
  const now = Date.now();
  const st = loadStats();
  try {
    const one = { at: now, t: new Date(now).toISOString(), scope: String(scope || '?'), msg: String(msg || '').slice(0, 400) };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (k === 'stack') { one.stack = String(extra.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 300); continue; }
        one[k] = String(extra[k] == null ? '' : extra[k]).slice(0, 200);
      }
    }
    fs.mkdirSync(DATA, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG, JSON.stringify(one) + '\n', 'utf8');
    st.scopes[one.scope] = (st.scopes[one.scope] || 0) + 1;
    st.total = (st.total || 0) + 1;
    st.last = now;
    saveStats();
    return true;
  } catch (e) {
    try { console.log('[报错] 记不下来：' + String(e.message || e).slice(0, 80) + ' / ' + scope + ':' + msg); } catch (e2) {}
    return false;
  }
}

// 最近 N 条（面板用），从文件尾部取，不整读大文件
function recent(n) {
  const want = Math.max(1, Math.min(200, Number(n) || 20));
  let raw = '';
  try {
    const st = fs.statSync(LOG);
    const start = Math.max(0, st.size - 64 * 1024);
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out.slice(-want).reverse();
}

function count24h() {
  const cut = Date.now() - 86400000;
  return recent(200).filter(x => Number(x.at) >= cut).length;
}

function snapshot() {
  const st = loadStats();
  return { total: st.total || 0, byScope: st.scopes || {}, last: st.last || 0, count24h: count24h(), recent: recent(20) };
}

module.exports = { logErr, recent, count24h, snapshot, LOG };
