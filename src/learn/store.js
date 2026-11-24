/*
 * src/learn/store.js —— 学习数据的读写底座
 *
 * 这是干什么的：所有 learn 数据文件的读写都从这里过，保证三件事：
 *   ① 原子写（先写 .tmp 再 rename），不会留下半截 JSON；
 *   ② JSONL 只追加（append-only），历史记录永远不改、不删；
 *   ③ 目录按人切（users/<pid>/），一个人一份，物理隔离。
 *
 * 为什么不直接用 fs：这三个规矩散到各模块里早就不一致了，收成一份最省事。
 */
const fs = require('fs');
const path = require('path');
const S = require('./schema');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function readJSON(p, def) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    if (!s.trim()) return def;
    return JSON.parse(s);
  } catch (e) { return def; }
}

// 原子写：和她定的配置写规矩一致，先 tmp 再 rename
function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

function appendJSONL(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  return true;
}

// 读 JSONL：limit 给正整数就是最后 N 条，0/不传就是全部
function readJSONL(p, limit) {
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
  const lines = raw.split('\n').filter(l => l.trim());
  if (limit > 0) return lines.slice(-limit).map(parseLine).filter(Boolean);
  return lines.map(parseLine).filter(Boolean);
}
function parseLine(l) { try { return JSON.parse(l); } catch (e) { return null; } }

function userDir(pid) {
  const d = path.join(S.PATHS.users, String(pid));
  ensureDir(d);
  return d;
}
function userPath(pid, name) { return path.join(userDir(pid), name); }

function listUserIds() {
  try {
    return fs.readdirSync(S.PATHS.users).filter(n => !n.startsWith('.'));
  } catch (e) { return []; }
}

// 本地时区的日期键（别用 toISOString，那是 UTC，差 8 小时会把凌晨算到前一天）
function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function monthKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function iso(ts) { return new Date(ts || Date.now()).toISOString(); }

/* 把 ISO 时间串（UTC）转成本地日期 YYYY-MM-DD。
 * 为什么要这一步：iso() 存的是 UTC，本地凌晨 2 点写的东西 UTC 还在前一天，
 * 直接 slice(0,10) 会显示成昨天——她看记录会以为记漏了一天。 */
function localDate(tsIso) {
  if (!tsIso) return '';
  const d = new Date(tsIso);
  if (isNaN(d.getTime())) return String(tsIso).slice(0, 10);
  return dayKey(d.getTime());
}

// 短随机尾巴：同一毫秒写两条也不会撞 id
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = {
  ensureDir, readJSON, writeJSON, appendJSONL, readJSONL,
  userDir, userPath, listUserIds, dayKey, monthKey, iso, localDate, uid,
};
