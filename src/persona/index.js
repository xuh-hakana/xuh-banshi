'use strict';
/* ===========================================================================
 * persona/index.js —— 人设层清单的读取与校验（2026-11-25 重构）
 *
 * 单一来源：persona/manifest.json。物理文件仍在 src/soul/（F/H/D 分区不动），
 * 这里只声明「哪一层、哪些文件、哪个角色用哪些层、什么场景注入哪份」。
 *
 * 与 config/persona.json 的关系：panel.order 是给人看的展示顺序，
 * 必须能在 manifest 里找到对应文件；对不上就报错（自检可见），不静默。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');   // = src/（与 core.js 的 ROOT 同一个）
const FILE = path.join(__dirname, 'manifest.json');

let _cache = { at: 0, data: null };

function readManifest() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch (e) { return null; }
  if (_cache.data && _cache.at === st) return _cache.data;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _cache = { at: st, data: j && typeof j === 'object' ? j : null };
  } catch (e) {
    console.error('[persona] manifest.json 读不出来：' + e.message);
    _cache = { at: st, data: null };
  }
  return _cache.data;
}

/* 一层里的文件绝对路径 */
function filesOf(layerId) {
  const m = readManifest();
  const l = m && m.layers && m.layers[layerId];
  if (!l) return [];
  return (l.files || []).map(f => path.join(ROOT, l.dir, f));
}

/* 某个角色要哪些层 / 提示词 / 是否带场景段 */
function roleOf(name) {
  const m = readManifest();
  const r = m && m.roles && m.roles[name];
  return r || null;
}

/* 子 agent 的角色卡：人设层正文 + 角色说明（groupmate 用群友资料，由调用方给） */
function rolePrompt(name) {
  const r = roleOf(name);
  if (!r) return '';
  const parts = [];
  if (r.desc) parts.push('【角色】' + r.desc);
  for (const l of (r.layers || [])) {
    for (const f of filesOf(l)) {
      try { parts.push(fs.readFileSync(f, 'utf8').trim()); }
      catch (e) { console.log('[persona] 层文件读不到：' + f + '（' + e.message + '）'); }
    }
  }
  if (r.prompt) parts.push(r.prompt);
  return parts.filter(Boolean).join('\n\n');
}

/* 某场景用的是哪份场合文件（H 层的 应对/ 目录） */
function sceneOf(id) {
  const m = readManifest();
  return (m && Array.isArray(m.scenes) ? m.scenes.find(s => s.id === id) : null) || null;
}

/* 校验：文件都在、场景文件都在；与 config/persona.json 的 panel.order 对得上。
 * 只报问题、不抛错（自检/启动都能调）。返回 {ok, missing:[], unknownInPanel:[]} */
function validate() {
  const m = readManifest();
  if (!m) return { ok: false, missing: ['manifest.json'], unknownInPanel: [], why: '清单读不出来' };
  const missing = [];
  for (const [id, l] of Object.entries(m.layers || {})) {
    for (const f of (l.files || [])) {
      const p = path.join(ROOT, l.dir, f);
      let ok = false;
      try { ok = fs.statSync(p).isFile(); } catch (e) { ok = false; }
      if (!ok) missing.push(id + '/' + f);
    }
  }
  const respDir = path.join(ROOT, 'soul', 'H-全聊天', '应对');
  for (const s of (m.scenes || [])) {
    if (!s.file) continue;
    let ok = false;
    try { ok = fs.statSync(path.join(respDir, s.file)).isFile(); } catch (e) { ok = false; }
    if (!ok) missing.push('H/应对/' + s.file);
  }
  // 面板展示顺序里的 soul/ 文件必须在 manifest 里登记过（对不上 = 两套数据在漂）
  const known = new Set();
  for (const l of Object.values(m.layers || {})) for (const f of (l.files || [])) known.add(l.dir + '/' + f);
  for (const s of (m.scenes || [])) if (s.file) known.add('soul/H-全聊天/应对/' + s.file);
  // 场合目录里多出来的文件 = 清单没登记（加了 md 忘了登记，就是「静默不生效」）
  const undeclaredScenes = [];
  try {
    for (const f of fs.readdirSync(respDir)) {
      if (!f.endsWith('.md')) continue;
      if (!known.has('soul/H-全聊天/应对/' + f)) undeclaredScenes.push(f);
    }
  } catch (e) { /* 目录没了已由 missing 报 */ }
  const unknownInPanel = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'persona.json'), 'utf8'));
    for (const rel of ((pj.panel && pj.panel.order) || [])) {
      if (!String(rel).startsWith('soul/')) continue;
      if (!known.has(String(rel))) unknownInPanel.push(String(rel));
    }
  } catch (e) { /* 面板配置坏了不是这里的错 */ }
  return { ok: missing.length === 0 && undeclaredScenes.length === 0, missing, undeclaredScenes, unknownInPanel };
}

module.exports = { FILE, readManifest, filesOf, roleOf, rolePrompt, sceneOf, validate };
