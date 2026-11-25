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
 *
 * 2026-11-25 改：读写统一走 src/state/entities.js 的实体（单例 + 跨进程锁 + 原子写）。
 * 面板、机器人、定时任务三个进程都可能同时写记忆，以前各写各的会互相盖；
 * 现在只有一份真源，写之前先在实体锁里读最新再落盘。import 与对外接口没变。
 */
const fs = require('fs');
const path = require('path');
const { ent, memoryLog } = require('./state/entities');

const ROOT = __dirname;
const MEM_DIR = path.join(ROOT, 'data', '记忆');
const LONG_PATH = path.join(MEM_DIR, 'MEMORY.md');
const LOG_DIR = path.join(MEM_DIR, '日志');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ① 长期正本：只把「## 每轮给模型看的」那一段给模型，档案段不进提示词。
 * 原文由实体按 mtime+size 缓存，这里再缓存一次"切好的那一段"，避免每轮切字符串。 */
let _long = { raw: null, text: '' };
function longForPrompt() {
  try {
    const raw = ent().memoryLong.read();
    if (raw === _long.raw) return _long.text;
    const lines = String(raw || '').split('\n');
    const start = lines.findIndex(l => /^##\s*每轮给模型看的\s*$/.test(l));
    const out = [];
    if (start >= 0) {
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        const t = lines[i].trim();
        if (t && !t.startsWith('<!--')) out.push(lines[i].trim());
      }
    }
    _long = { raw: raw, text: out.join('\n').trim() };
    return _long.text;
  } catch { return ''; }
}

function readLongRaw() {
  try { return ent().memoryLong.read(); } catch { return ''; }
}

function saveLongRaw(raw) {
  try {
    ent().memoryLong.replace(String(raw || ''));
    _long = { raw: null, text: '' };
    return { ok: true };
  } catch (e) {
    try { require('./diag/report').report('memory.save', e); } catch (e2) {}
    return { error: e.message };
  }
}

/* ③ 按天工作日志：只追加，不覆盖、不删历史。
 * kind 是分类（决定 / 改动 / 修好 / 问题 / 手动），text 是一句话说清发生了什么。
 * 追加放在实体的锁里做（读最新再拼），两个进程同时写也不会吞行。 */
function appendLog(kind, text, at) {
  try {
    const d = String(at || today()).slice(0, 10);
    // 行内时间也按本地时区写，别和上面的本地日期差 8 小时
    const now = new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(x => String(x).padStart(2, '0')).join(':');
    const line = '- ' + t + ' [' + String(kind || '决定').replace(/[\[\]\n]/g, '').slice(0, 8) + '] '
      + String(text || '').replace(/[\n\r]+/g, ' ').trim().slice(0, 300) + '\n';
    memoryLog(d).mutate((cur) => {
      const base = (cur && String(cur).length) ? String(cur) : ('# 工作日志 ' + d + '\n\n');
      return base + line;
    });
    return { ok: true, day: d, line: line.trim() };
  } catch (e) {
    try { require('./diag/report').report('memory.appendLog', e); } catch (e2) {}
    return { error: e.message };
  }
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
  try { return memoryLog(d).read(); } catch { return ''; }
}

module.exports = {
  MEM_DIR, LONG_PATH, LOG_DIR,
  longForPrompt, readLongRaw, saveLongRaw,
  appendLog, listDays, readDay, today,
};
