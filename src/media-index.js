// 媒体台账（2026-11-23 主人定）：收图/视频/聊天记录只记 id 与分类，0 次模型调用；
// 要读图/图进上下文时才让图跑一次模型，结果回填到这里当文字去重依据。
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data', 'media-index.json');
const MAX = 20000;
const KIND_OK = { image: 1, video: 1, record: 1, sticker: 1 };
let _idx = null, _dirty = false, _timer = null;

function ensure() {
  if (_idx) return _idx;
  try { _idx = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { _idx = null; }
  if (!_idx || typeof _idx !== 'object') _idx = {};
  if (Number(_idx.v) !== 1) _idx = { v: 1, byId: {} };
  if (!_idx.byId || typeof _idx.byId !== 'object') _idx.byId = {};
  return _idx;
}

function saveNow() {
  if (!_idx) return;
  try {
    const keys = Object.keys(_idx.byId);
    if (keys.length > MAX) {
      keys.sort((a, b) => (Number(_idx.byId[b].t) || 0) - (Number(_idx.byId[a].t) || 0));
      for (const k of keys.slice(MAX)) delete _idx.byId[k];
    }
    // 走实体：跨进程锁 + 原子写，面板/机器人都写这张台账时不会写坏
    require('./state/entities').ent().mediaIndex.replace(_idx);
    _dirty = false;
  } catch (e) {
    try { require('./err-log.js').logErr('media-index', 'save failed', { msg: e.message }); } catch (e2) {}
  }
}

function scheduleSave() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; if (_dirty) saveNow(); }, 800);
  if (_timer.unref) _timer.unref();
}

function rec(id) {
  const k = String(id || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 64);
  if (!k) return null;
  const idx = ensure();
  return idx.byId[k] || (idx.byId[k] = { t: Date.now() });
}

// list: [{id, kind, grp, desc, hash}] —— 只记账，不跑模型
function record(list) {
  if (!list || !list.length) return 0;
  let n = 0;
  const now = Date.now();
  for (const it of list) {
    if (!it) continue;
    const r = rec(it.id || it.key);
    if (!r) continue;
    r.t = now;
    r.k = KIND_OK[it.kind] ? it.kind : (r.k || 'image');
    if (it.grp) r.g = String(it.grp).slice(0, 32);
    if (it.desc) r.d = String(it.desc).slice(0, 300);
    if (it.hash) r.h = String(it.hash).slice(0, 20);
    if (typeof it.n === 'number') r.n = it.n;
    n++;
  }
  if (n) { _dirty = true; scheduleSave(); }
  return n;
}

function get(id) {
  const r = rec(id);
  return r ? Object.assign({}, r) : null;
}

function descOf(id) {
  const r = rec(id);
  return (r && r.d) || '';
}

function markRead(id, desc) {
  const r = rec(id);
  if (!r) return false;
  r.d = String(desc || '').slice(0, 300);
  r.rt = Date.now();
  _dirty = true; scheduleSave();
  return true;
}

function markNsfw(id, score) {
  const r = rec(id);
  if (!r) return false;
  r.n = Math.max(0, Math.min(10, Math.round(Number(score) || 0)));
  _dirty = true; scheduleSave();
  return true;
}

function counts() {
  const idx = ensure();
  const ids = Object.keys(idx.byId);
  let read = 0, unread = 0, nsfw = 0;
  for (const k of ids) {
    const r = idx.byId[k];
    if (!r) continue;
    if (r.d) read++; else unread++;
    if (Number(r.n) > 0) nsfw++;
  }
  return { total: ids.length, read, unread, nsfw };
}

function byKind() {
  const idx = ensure();
  const out = {};
  for (const k of Object.keys(idx.byId)) {
    const r = idx.byId[k]; if (!r) continue;
    const kk = r.k || 'image';
    out[kk] = (out[kk] || 0) + 1;
  }
  return out;
}

module.exports = { record, get, descOf, markRead, markNsfw, counts, byKind, saveNow, FILE };
