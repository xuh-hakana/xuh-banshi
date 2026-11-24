'use strict';
/*
 * config/index.js —— 配置统一读写入口（2026-11-01 拆分）
 *
 * 为什么有这个文件：
 *   以前所有配置挤在一个 config.json 里。两个面板/两个窗口同时改，后写的会把整份冲掉
 *   （2026-10 就出过一次：模型配置被另一个窗口覆盖回旧值）。
 *   现在按用途拆成 4 个分区文件，改一类只动对应文件，互不干扰：
 *     persona.json   人设 / 文件指向 / 面板展示
 *     llm.json       模型、Key、超时、备用链、联网搜索
 *     connect.json   端口、QQ 号、主人/熟人名单、对端 AI
 *     features.json  说话相关的所有开关（chime/merge/topic/critic/autoAsk/triggers…）
 *
 * 对外只暴露这几个方法，业务代码不用关心文件怎么分：
 *   load()            启动时一次性合并（同旧 config.json 形状），给 bot.js 当初始 cfg
 *   cfgLive()         每次调用都重读（按 mtime 缓存），面板/手工改了立刻生效
 *   readConfigFresh() cfgLive 的别名（core.js / qq.js 历史叫法）
 *   partOf(key)       某个配置项在哪个分区
 *   patch(k,v,who)    改一个键 → 自动落到对应分区，原子写
 *   patchMany(obj)    一次改多个键 → 按分区归并后各自原子写
 *   writeFull(obj)    整份写回（读-改-写模式用），每个键回自己分区
 *   mtime()           四个分区里最新修改时间
 */
const fs = require('fs');
const path = require('path');

// intent 段（2026-11-22 加）：意图判定这一块的开关/词表/模型路径，见同目录 intent.json。
// 单独一个分区是为了「改意图阈值只动一个文件」，不用碰 features.json 里几百行说话开关。
const PARTS = ['persona', 'llm', 'connect', 'features', 'intent'];
const DIR = __dirname;

let _cache = { at: 0, data: null };

function _partPath(p) { return path.join(DIR, p + '.json'); }

function _readPart(p) {
  try { return JSON.parse(fs.readFileSync(_partPath(p), 'utf8')); }
  catch (e) { return {}; }
}

function _maxMtime() {
  let m = 0;
  for (const p of PARTS) {
    try { const s = fs.statSync(_partPath(p)); if (s.mtimeMs > m) m = s.mtimeMs; } catch (e) {}
  }
  return m;
}

// 启动时一次性合并（同旧 config.json 的形状），给 bot.js 当初始 cfg 用
function load() {
  const data = {};
  for (const p of PARTS) {
    const d = _readPart(p);
    for (const k of Object.keys(d)) data[k] = JSON.parse(JSON.stringify(d[k])); // 深拷贝，调方随便改不污染源
  }
  return data;
}

// 每次调用都重新读（按 mtime 缓存）。面板/手工改了任意分区文件，mtime 一变立刻重读。
// 返回的是缓存引用，仅用于「读」，不要拿它去做 read-modify-write。
function cfgLive() {
  const m = _maxMtime();
  if (_cache.at === m && _cache.data) return _cache.data;
  const data = load();
  _cache = { at: m, data };
  return data;
}

// 兼容别名：core.js / qq.js 历史都叫 readConfigFresh
function readConfigFresh() { return cfgLive(); }

function mtime() { return _maxMtime(); }

// 免记录群判断（她 2026-11-03 定，2026-11-10 收紧语义）：这些群里**不记人物画像**
// （好感/喜好/人物信息/星标/纠正/首见/约定/地域），但聊天记录照常落盘（主人要照常查看）。
// 判定只放这一处，core / nick / qq 都调它，免得各写一份对不上。
function isNoRecordGid(gid) {
  const n = Number(String(gid || '').replace(/\D/g, ''));
  if (!n) return false;
  return (cfgLive().noRecordGroups || []).map(Number).indexOf(n) >= 0;
}

// 某个配置项在哪个分区（用于把写操作路由到正确的文件）
function partOf(key) {
  for (const p of PARTS) {
    const d = _readPart(p);
    if (Object.prototype.hasOwnProperty.call(d, key)) return p;
  }
  return null;
}

// 原子写：写临时文件再 rename，不会出现半截文件
function _writePart(part, mutator) {
  const p = _partPath(part);
  let cur = _readPart(part);
  mutator(cur);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  _cache = { at: _maxMtime(), data: null }; // 让下一次 cfgLive 重新读
  return true;
}

// 改一个键：先按 partOf 找到它所在的分区，再 读-改-原子写。
// 同一分区被两个窗口同时改不同键时，因为先读再改并用 Object.assign 合并，不会互相覆盖。
function patch(key, value, who) {
  const part = partOf(key);
  if (!part) return { ok: false, error: '未知配置项：' + key };
  _writePart(part, cur => { cur[key] = value; });
  return { ok: true, part, key, who: who || '' };
}

// 一次改多个键（面板批量保存用）。同一个分区的键合并后一次写。
function patchMany(obj, who) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: '参数不是对象' };
  const byPart = {};
  for (const k of Object.keys(obj)) {
    const part = partOf(k);
    if (!part) return { ok: false, error: '未知配置项：' + k };
    (byPart[part] = byPart[part] || {})[k] = obj[k];
  }
  for (const part of Object.keys(byPart)) {
    _writePart(part, cur => { Object.assign(cur, byPart[part]); });
  }
  return { ok: true, who: who || '' };
}

// 整份写回（读-改-写模式用）：把每个顶层键路由回自己的分区
function writeFull(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: '参数不是对象' };
  const byPart = {};
  for (const k of Object.keys(obj)) {
    const part = partOf(k);
    if (!part) continue; // 不认识的键直接丢弃，绝不写进未知文件
    (byPart[part] = byPart[part] || {})[k] = obj[k];
  }
  for (const part of Object.keys(byPart)) {
    _writePart(part, cur => { Object.assign(cur, byPart[part]); });
  }
  return { ok: true };
}

module.exports = { PARTS, DIR, load, cfgLive, readConfigFresh, mtime, isNoRecordGid, partOf, patch, patchMany, writeFull };
