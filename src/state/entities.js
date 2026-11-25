'use strict';
/* ===========================================================================
 * src/state/entities.js —— 全项目共享可写文件的实体表（2026-11-25）
 *
 * 规矩：想写下面任何一份文件，都必须从这里拿实体，走 read/mutate/replace/append，
 * 不许自己 fs.writeFileSync。这样才只有一份真源、才都带锁、才都是原子写。
 * 新增共享文件时在这里登记一行，别在业务代码里另开一条写路径。
 * =========================================================================== */
const path = require('path');
const store = require('./store');

const SRC = path.join(__dirname, '..');
const DATA = path.join(SRC, 'data');

const F = {
  memoryLong: path.join(DATA, '记忆', 'MEMORY.md'),
  memoryLogDir: path.join(DATA, '记忆', '日志'),
  convState: path.join(DATA, 'conv-state.json'),
  dailyStats: path.join(DATA, 'daily-stats.json'),
  mediaIndex: path.join(DATA, 'media-index.json'),
  alarms: path.join(DATA, 'alarms.json'),
};

let cache = null;

function ent() {
  if (cache) return cache;
  const c = {};
  c.memoryLong = store.open('memory.long', { file: F.memoryLong, mode: 'text', defaultValue: '' });
  c.convState = store.open('conv-state', { file: F.convState, defaultValue: {} });
  c.dailyStats = store.open('daily-stats', { file: F.dailyStats, defaultValue: {} });
  c.mediaIndex = store.open('media-index', { file: F.mediaIndex, defaultValue: {} });
  c.alarms = store.open('alarms', { file: F.alarms, defaultValue: {} });
  cache = c;
  return c;
}

function memoryLog(day) {
  const d = String(day || new Date().toISOString().slice(0, 10));
  return store.open('memory.log.' + d, {
    file: path.join(F.memoryLogDir, d + '.md'),
    mode: 'text',
    defaultValue: '',
  });
}

module.exports = { F, ent, memoryLog, store };
