/*
 * src/memory.js — 虚幻的长期记忆 + 按天工作日志
 *
 * 这是干什么的：把「跨天要记住的事实」和「今天做了什么」管在一个入口里，
 * 客户端能看能改，机器人每轮真读、关键事件真写。不建第二套记忆文件。
 *
 * 三层，物理分离（主人 2026-11-07 定：后续会越积越多，趁现在分文件）：
 *   ① 正本   data/记忆/MEMORY.md          —— 唯一一份，每轮只把「给模型看的」那一段注入
 *   ② 按需   data/guides/、网络热梗、约定 —— 现成的，命中才读，不在这里另抄一份
 *   ③ 日志   data/记忆/日志/YYYY-MM-DD.md —— 按天 append-only，只加不改，越积越多也不会撑爆单文件
 *
 * 为什么这么分：正本必须短（每轮都进提示词）；日志会一直涨，按天切才能只翻当天。
 * 读写都走本文件，别处不许直接 fs.readFileSync('data/记忆/…')。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const MEM_DIR = path.join(ROOT, 'data', '记忆');
const LONG_PATH = path.join(MEM_DIR, 'MEMORY.md');
const LOG_DIR = path.join(MEM_DIR, '日志');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const ensure = () => { try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} };

/* ① 长期正本：只把「## 每轮给模型看的」那一段给模型，档案段不进提示词。
 * 带 mtime+size 缓存：文件没改就不重读（和 readSoul 一个口径）。 */
let _long = { key: '', text: '' };
function longForPrompt() {
  try {
    const st = fs.statSync(LONG_PATH);
    const key = st.mtimeMs + ':' + st.size;
    if (key === _long.key) return _long.text;
    const raw = fs.readFileSync(LONG_PATH, 'utf8');
    const lines = raw.split('\n');
    const start = lines.findIndex(l => /^##\s*每轮给模型看的\s*$/.test(l));
    let out = [];
    if (start >= 0) {
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        const t = lines[i].trim();
        if (t && !t.startsWith('<!--')) out.push(lines[i].trim());
      }
    }
    _long = { key, text: out.join('\n').trim() };
    return _long.text;
  } catch { return ''; }
}
function readLongRaw() { try { return fs.readFileSync(LONG_PATH, 'utf8'); } catch { return ''; } }
function saveLongRaw(raw) {
  // 原子写：先写临时文件再改名，避免半截 JSON/MD 落盘（她定的规矩）
  const tmp = LONG_PATH + '.tmp';
  fs.writeFileSync(tmp, String(raw || ''), 'utf8');
  fs.renameSync(tmp, LONG_PATH);
  _long = { key: '', text: '' };
  return { ok: true };
}

/* ③ 按天工作日志：只追加，不覆盖、不删历史。
 * kind 是分类（决定 / 改动 / 修好 / 问题 / 手动），text 是一句话说清发生了什么。 */
function appendLog(kind, text, at) {
  try {
    ensure();
    const d = String(at || today()).slice(0, 10);
    // 行内时间也按本地时区写，别和上面的本地日期差 8 小时
    const now = new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(x => String(x).padStart(2, '0')).join(':');
    const line = '- ' + t + ' [' + String(kind || '决定').replace(/[\[\]\n]/g, '').slice(0, 8) + '] '
      + String(text || '').replace(/[\n\r]+/g, ' ').trim().slice(0, 300) + '\n';
    const p = path.join(LOG_DIR, d + '.md');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '# 工作日志 ' + d + '\n\n', 'utf8');
    fs.appendFileSync(p, line, 'utf8');
    return { ok: true, day: d, line: line.trim() };
  } catch (e) { return { error: e.message }; }
}
function listDays() {
  try {
    return fs.readdirSync(LOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => f.slice(0, -3)).sort().reverse();
  } catch { return []; }
}
function readDay(day) {
  const d = String(day || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  try { return fs.readFileSync(path.join(LOG_DIR, d + '.md'), 'utf8'); } catch { return ''; }
}

module.exports = {
  MEM_DIR, LONG_PATH, LOG_DIR,
  longForPrompt, readLongRaw, saveLongRaw,
  appendLog, listDays, readDay, today,
};
