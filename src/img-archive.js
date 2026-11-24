// 图片归档索引（2026-11-22 主人定）：一张图只认一次，类型（表情/截图/插画）+ 识图描述都存下来。
// 作用：1) 识图描述复用，同一张图不再反复调视觉模型；2) 描述原文当文字去重依据（搬屎那边用）；
//       3) 判成非表情包的图统一进被拦图目录（blocked-store，默认 src/data/blocked，可配置），不占表情包池、不进清单。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'img-archive.json');
const SCRIPTS = path.join(__dirname, 'scripts');
const MAX_ITEMS = 20000;

let _cache = null;
let _dirty = 0;
let _timer = null;

function emptyIndex() { return { v: 1, byMd5: {}, byHash: {} }; }

function load() {
  if (_cache) return _cache;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch {}
  if (!j || typeof j !== 'object' || j.v !== 1) j = emptyIndex();
  if (!j.byMd5 || typeof j.byMd5 !== 'object') j.byMd5 = {};
  if (!j.byHash || typeof j.byHash !== 'object') j.byHash = {};
  _cache = j;
  return _cache;
}

function saveNow() {
  const j = load();
  const keys = Object.keys(j.byHash);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => (j.byHash[a].t || 0) - (j.byHash[b].t || 0));
    for (const k of keys.slice(0, keys.length - MAX_ITEMS)) delete j.byHash[k];
  }
  const mk = Object.keys(j.byMd5);
  if (mk.length > MAX_ITEMS * 2) {
    mk.sort((a, b) => (j.byMd5[a].t || 0) - (j.byMd5[b].t || 0));
    for (const k of mk.slice(0, mk.length - MAX_ITEMS * 2)) delete j.byMd5[k];
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, INDEX_PATH);
    _dirty = 0;
    return true;
  } catch (e) {
    console.log('[图档] 写索引失败：' + String(e.message || e).slice(0, 60));
    return false;
  }
}

function saveLater() {
  _dirty++;
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; if (_dirty) saveNow(); }, 1500);
  if (_timer.unref) _timer.unref();
}

function pyOf(opt) {
  const p = opt && opt.python;
  if (p) return p;
  if (process.env.STICKER_PYTHON) return process.env.STICKER_PYTHON;
  return 'python3';
}

function _probe(buf, script, opt, extra) {
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), 'ia_' + Date.now() + Math.random().toString(36).slice(2));
    try { fs.writeFileSync(tmp, buf); } catch { return resolve(null); }
    const args = [path.join(SCRIPTS, script), tmp].concat(extra || []);
    execFile(pyOf(opt), args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, so) => {
      try { fs.unlinkSync(tmp); } catch {}
      try { const j = JSON.parse(String(so || '')); resolve(j && j.ok ? j : null); } catch { resolve(null); }
    });
  });
}

function dhashOf(buf, opt) { return _probe(buf, 'sticker_hash.py', opt, ['d16']).then(j => (j && j.h) || ''); }
function kindOf(buf, opt) { return _probe(buf, 'sticker_kind.py', opt, []); }

function descOf(key) {
  const j = load();
  const k = String(key || '');
  if (!k) return '';
  const a = j.byMd5[k];
  if (a && a.d) { a.t = Date.now(); return a.d; }
  const b = j.byHash[k];
  if (b && b.d) { b.t = Date.now(); return b.d; }
  return '';
}

function kindAt(key) {
  const j = load();
  const k = String(key || '');
  if (!k) return '';
  const a = j.byMd5[k] || j.byHash[k];
  return (a && a.k) || '';
}

function remember(key, info) {
  const k = String(key || '');
  if (!k) return false;
  info = info || {};
  const desc = String(info.desc || '').slice(0, 400);
  const kind = String(info.kind || '');
  const src = String(info.src || '').slice(0, 40);
  if (!desc && !kind) return false;
  const j = load();
  const now = Date.now();
  const apply = rec => {
    if (desc) rec.d = desc;
    if (kind) rec.k = kind;
    if (src) rec.s = src;
    rec.t = now;
  };
  if (/^[0-9a-f]{32}$/.test(k)) {
    const cur = j.byMd5[k] || {};
    apply(cur);
    j.byMd5[k] = cur;
    const hv = String(info.h || cur.h || '');
    if (hv) {
      const hc = j.byHash[hv] || {};
      if (desc) hc.d = desc;
      if (kind) hc.k = kind;
      if (src) hc.s = src;
      hc.t = now;
      j.byHash[hv] = hc;
    }
  } else {
    const cur = j.byHash[k] || {};
    apply(cur);
    j.byHash[k] = cur;
  }
  saveLater();
  return true;
}

async function identifyMany(bufs, opt) {
  opt = opt || {};
  const list = (bufs || []).filter(b => b && b.length);
  const j = load();
  const out = [];
  const todo = [];
  for (const buf of list) {
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const rec = j.byMd5[md5];
    if (rec && (rec.d || rec.k)) {
      out.push({ md5, h: rec.h || '', kind: rec.k || '', simple: true, desc: rec.d || '', hit: true, buf });
      continue;
    }
    const slot = { md5, h: '', kind: '', simple: true, desc: '', hit: false, buf };
    out.push(slot);
    todo.push(slot);
  }
  const wantKind = opt.wantKind !== false;
  const chunk = Math.max(1, Math.min(8, opt.concurrency || 4));
  for (let i = 0; i < todo.length; i += chunk) {
    const part = todo.slice(i, i + chunk);
    await Promise.all(part.map(async slot => {
      slot.h = await dhashOf(slot.buf, opt);
      const hrec = slot.h ? j.byHash[slot.h] : null;
      if (hrec && (hrec.d || hrec.k)) {
        slot.desc = hrec.d || '';
        slot.kind = hrec.k || '';
        slot.hit = true;
      } else if (wantKind) {
        const ki = await kindOf(slot.buf, opt);
        if (ki) { slot.kind = String(ki.kind || ''); slot.simple = ki.simple !== false; }
      }
      remember(slot.md5, { h: slot.h, kind: slot.kind, desc: slot.desc, src: 'identify' });
    }));
  }
  return out.map(o => ({ md5: o.md5, h: o.h, kind: o.kind, simple: o.simple, desc: o.desc, hit: o.hit }));
}

function pruneDir(dir, caps) {
  caps = caps || {};
  const maxCount = caps.maxCount || 2000;
  const maxBytes = caps.maxBytes || 2 * 1024 * 1024 * 1024;
  // maxAgeMs（2026-11-25 加）：按时间清。只被 blocked-store 用（被拦图 30 天），
  // 不传时行为和以前完全一样 —— 表情包永远不走这条路。
  const maxAgeMs = Number(caps.maxAgeMs) > 0 ? Number(caps.maxAgeMs) : 0;
  const files = [];
  const walk = d => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      files.push({ p, size: st.size, mtime: st.mtimeMs || 0 });
    }
  };
  walk(dir);
  let bytes = files.reduce((s, f) => s + f.size, 0);
  // ① 过期的先删（跟条数/容量上限无关）
  let expired = 0;
  if (maxAgeMs > 0) {
    const cut = Date.now() - maxAgeMs;
    for (let i = files.length - 1; i >= 0; i--) {
      const f = files[i];
      if (!f.mtime || f.mtime >= cut) continue;
      try { fs.unlinkSync(f.p); files.splice(i, 1); bytes -= f.size; expired++; } catch {}
    }
  }
  if (files.length <= maxCount && bytes <= maxBytes) return { removed: 0, expired: expired, items: files.length, bytes };
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  let count = files.length;
  for (const f of files) {
    if (count <= maxCount && bytes <= maxBytes) break;
    try { fs.unlinkSync(f.p); count--; bytes -= f.size; removed++; } catch {}
  }
  return { removed, expired: expired, items: count, bytes };
}

function stats() {
  const j = load();
  return { items: Object.keys(j.byHash).length, md5: Object.keys(j.byMd5).length, dirty: _dirty };
}

module.exports = { identifyMany, descOf, kindAt, remember, pruneDir, stats, saveNow, INDEX_PATH };
