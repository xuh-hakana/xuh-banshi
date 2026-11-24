// 图片下载去重缓存（2026-11-24 主人定：同一张图不要重复下载）
// 为什么要「先于下载」的 id：QQ 图床 url 里的 fileid 对同一张图稳定，rkey 会过期；
// 原来 describeImgs 是「先 getBinary 再算 md5/d16」，图重发一次就重下一次。
// 这里用 fileid（无则退 file / url 去 rkey）当键，存 md5 + 指纹 + 描述 + 库文件相对路径：
// 命中就直接出描述，0 次 HTTP、0 次模型。
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data', 'media-cache.json');
const MAX = 20000;
const SAVE_MS = 1000;
let _db = null, _dirty = false, _timer = null;

function ensure() {
  if (_db) return _db;
  try { _db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { _db = null; }
  if (!_db || typeof _db !== 'object' || Number(_db.v) !== 1 || !_db.byKey || typeof _db.byKey !== 'object') _db = { v: 1, byKey: {} };
  return _db;
}

function saveNow() {
  if (!_db) return false;
  try {
    const keys = Object.keys(_db.byKey);
    if (keys.length > MAX) {
      keys.sort((a, b) => (Number(_db.byKey[b].t) || 0) - (Number(_db.byKey[a].t) || 0));
      for (const k of keys.slice(MAX)) delete _db.byKey[k];
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db), 'utf8');
    fs.renameSync(tmp, FILE);
    _dirty = false;
    return true;
  } catch (e) {
    try { require('./err-log.js').logErr('media-cache', 'save failed', { msg: e.message }); } catch (e2) {}
    return false;
  }
}

function scheduleSave() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; if (_dirty) saveNow(); }, SAVE_MS);
  if (_timer.unref) _timer.unref();
}

// 从 url 里取稳定 id：fileid 优先（同一张图不变），其次 md5，再去掉 rkey 的 url
function keyFromUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const fid = u.searchParams.get('fileid') || u.searchParams.get('file_id') || u.searchParams.get('md5');
    if (fid && fid.length >= 8) return 'q:' + fid.slice(0, 160);
    u.searchParams.delete('rkey');
    u.searchParams.delete('t');
    u.searchParams.delete('time');
    const bare = u.origin + u.pathname + (u.search || '');
    return bare.length > 20 ? 'u:' + bare.slice(0, 200) : '';
  } catch (e) {
    return s.length > 20 ? 'u:' + s.replace(/[?&]rkey=[^&]*/g, '').slice(0, 200) : '';
  }
}

// seg: OneBot image 段或 {mid,url,file,localPath}
function keyOf(seg) {
  if (!seg) return '';
  const mid = String(seg.mid || '');
  if (/^[0-9a-f]{32}$/i.test(mid)) return 'm:' + mid.toLowerCase();
  const lp = String(seg.localPath || '');
  if (lp) return 'l:' + path.basename(lp).slice(0, 120);
  const k = keyFromUrl(seg.url);
  if (k) return k;
  const f = String(seg.file || '').trim();
  if (f) return 'f:' + f.slice(0, 160);
  return '';
}

const cleanKey = k => String(k || '').replace(/[^0-9A-Za-z_:.\/-]/g, '').slice(0, 220);

function lookup(key) {
  const k = cleanKey(key);
  if (!k) return null;
  const db = ensure();
  const r = db.byKey[k];
  if (!r) return null;
  if (r.d || r.m || r.h) return Object.assign({}, r);
  return null;
}

// rec: {m: md5, h: d16 指纹, d: 描述, r: 库内相对路径, k: image|sticker|blocked}
function remember(key, rec) {
  const k = cleanKey(key);
  if (!k || !rec) return false;
  const db = ensure();
  const r = db.byKey[k] || (db.byKey[k] = { t: 0 });
  r.t = Date.now();
  if (rec.m) r.m = String(rec.m).slice(0, 40);
  if (rec.h) r.h = String(rec.h).slice(0, 40);
  if (rec.d) r.d = String(rec.d).replace(/\s+/g, ' ').trim().slice(0, 600);
  if (rec.r) r.r = String(rec.r).slice(0, 200);
  if (rec.k) r.k = String(rec.k).slice(0, 16);
  // md5 别名：客户端/台账只给 mid（=md5）时也能命中同一张图
  if (rec.m && /^[0-9a-f]{32}$/i.test(String(rec.m))) {
    const mk = 'm:' + String(rec.m).toLowerCase();
    if (mk !== k) db.byKey[mk] = Object.assign({}, r);
  }
  _dirty = true;
  scheduleSave();
  return true;
}

function stats() {
  const db = ensure();
  const keys = Object.keys(db.byKey);
  let withDesc = 0, withRel = 0;
  for (const k of keys) { const r = db.byKey[k]; if (r && r.d) withDesc++; if (r && r.r) withRel++; }
  return { total: keys.length, withDesc, withRel, file: FILE };
}

function prune(maxAgeDays) {
  const db = ensure();
  const days = Number(maxAgeDays) > 0 ? Number(maxAgeDays) : 90;
  const cut = Date.now() - days * 86400000;
  let n = 0;
  for (const k of Object.keys(db.byKey)) {
    const r = db.byKey[k];
    if (!r || Number(r.t) < cut) { delete db.byKey[k]; n++; }
  }
  if (n) { _dirty = true; saveNow(); }
  return n;
}

module.exports = { keyOf, lookup, remember, stats, prune, saveNow, FILE };
