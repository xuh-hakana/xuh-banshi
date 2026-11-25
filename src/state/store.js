'use strict';
/* ===========================================================================
 * src/state/store.js —— 全局记忆 / 共享可写状态的唯一入口（2026-11-25）
 *
 * 解决的问题：各模块各写各的文件，没有锁、写一半掉电就坏、两个进程同时写互相盖。
 * 做法：
 *   - 每个共享文件在进程内只有一个 Store 实例（同名不同路径直接抛 STORE_CONFLICT，
 *     防止有人另起一份"副本"记忆）。
 *   - 所有写操作走 <file>.lock 跨进程锁，写 tmp -> fsync -> rename，读的人永远看到
 *     完整的旧版或完整的新版，不会读到半截。
 *   - 读有 mtime+size 缓存，读多写少的场景不重复解析。
 *   - 任何解析失败 / 写失败都上报 diag，并保留 .corrupt-时间戳 备份，不静默丢数据。
 *
 * 模式：mode:'json'（默认，读写对象）| mode:'text'（读写字符串，例如 MEMORY.md）
 * 接口：open(name, opts) read() mutate(fn) mutateAsync(fn) replace(v) append(text)
 *       stats() list()
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const { withLock, withLockAsync } = require('./lock');

const registry = new Map();

function diagErr(area, e) {
  try {
    const r = require('../diag/report');
    if (r && typeof r.report === 'function') r.report(area, e);
  } catch (e2) {}
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

class Store {
  constructor(name, opts) {
    const o = opts || {};
    this.name = name;
    this.file = path.resolve(o.file);
    this.mode = o.mode === 'text' ? 'text' : 'json';
    this.pretty = o.pretty !== false;
    this.defaultValue = o.defaultValue !== undefined
      ? o.defaultValue
      : (this.mode === 'text' ? '' : {});
    this.waitMs = Number(o.waitMs) || 5000;
    this.ttlMs = Number(o.ttlMs) || 10000;
    this.enc = o.encoding || 'utf8';
    this._cacheKey = null;
    this._cacheVal = undefined;
    this.ops = { reads: 0, writes: 0, appends: 0, lockTimeouts: 0, corrupt: 0, lastWrite: 0, lastError: null };
    registry.set(name, this);
  }

  pathOf() { return this.file; }

  _key() {
    try {
      const s = fs.statSync(this.file);
      return s.mtimeMs + ':' + s.size;
    } catch (e) {
      return 'absent';
    }
  }

  _parse(raw) {
    if (this.mode === 'text') return raw;
    const s = String(raw).trim();
    if (!s) return this.defaultValue;
    return JSON.parse(s);
  }

  _serialize(v) {
    if (this.mode === 'text') return String(v == null ? '' : v);
    return JSON.stringify(v === undefined ? this.defaultValue : v, null, this.pretty ? 2 : 0) + '\n';
  }

  _fresh() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, this.enc);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return this.mode === 'text' ? '' : this.defaultValue;
      }
      this.ops.lastError = e.message;
      diagErr('store:' + this.name, e);
      return this.mode === 'text' ? '' : this.defaultValue;
    }
    try {
      return this._parse(raw);
    } catch (e) {
      this.ops.corrupt++;
      const bad = this.file + '.corrupt-' + stamp();
      try { fs.writeFileSync(bad, raw, this.enc); } catch (e2) {}
      this.ops.lastError = '解析失败，已备份到 ' + bad;
      diagErr('store:' + this.name, e, { backup: bad });
      return this.mode === 'text' ? String(raw) : this.defaultValue;
    }
  }

  read() {
    const k = this._key();
    if (k === this._cacheKey) return this._cacheVal;
    const v = this._fresh();
    this._cacheKey = k;
    this._cacheVal = v;
    this.ops.reads++;
    return v;
  }

  _put(v) {
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    const body = this._serialize(v);
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, body, this.enc);
      try { fs.fsyncSync(fd); } catch (e) {}
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
      try { fs.unlinkSync(tmp); } catch (e2) {}
      this.ops.lastError = e.message;
      diagErr('store:' + this.name, e);
      throw e;
    }
    this.ops.writes++;
    this.ops.lastWrite = Date.now();
    this._cacheKey = this._key();
    this._cacheVal = v;
    return v;
  }

  _mutate(fn) {
    const self = this;
    const run = function () {
      const cur = self._fresh();
      const next = fn(cur);
      return self._put(next === undefined ? cur : next);
    };
    try {
      return withLock(this.file, run, { waitMs: this.waitMs, ttlMs: this.ttlMs });
    } catch (e) {
      if (e && e.code === 'E_LOCK_TIMEOUT') {
        this.ops.lockTimeouts++;
        diagErr('store:' + this.name, e);
      }
      throw e;
    }
  }

  async _mutateAsync(fn) {
    const self = this;
    const run = async function () {
      const cur = self._fresh();
      const next = await fn(cur);
      return self._put(next === undefined ? cur : next);
    };
    try {
      return await withLockAsync(this.file, run, { waitMs: this.waitMs, ttlMs: this.ttlMs });
    } catch (e) {
      if (e && e.code === 'E_LOCK_TIMEOUT') {
        this.ops.lockTimeouts++;
        diagErr('store:' + this.name, e);
      }
      throw e;
    }
  }

  mutate(fn) { return this._mutate(fn); }
  mutateAsync(fn) { return this._mutateAsync(fn); }
  replace(v) { return this._mutate(() => v); }
  replaceAsync(v) { return this._mutateAsync(() => v); }

  append(text) {
    const self = this;
    const run = function () {
      const cur = self._fresh();
      const next = String(cur == null ? '' : cur) + String(text);
      self.ops.appends++;
      return self._put(next);
    };
    return withLock(this.file, run, { waitMs: this.waitMs, ttlMs: this.ttlMs });
  }

  stats() {
    return {
      name: this.name,
      file: this.file,
      mode: this.mode,
      reads: this.ops.reads,
      writes: this.ops.writes,
      appends: this.ops.appends,
      lockTimeouts: this.ops.lockTimeouts,
      corrupt: this.ops.corrupt,
      lastWrite: this.ops.lastWrite || null,
      lastError: this.ops.lastError || null,
    };
  }
}

function open(name, opts) {
  if (!name || typeof name !== 'string') throw new Error('store.open 需要实体名');
  if (!opts || !opts.file) throw new Error('store.open 需要 file：' + name);
  const abs = path.resolve(opts.file);
  const cur = registry.get(name);
  if (cur) {
    if (path.resolve(cur.file) !== abs) {
      const e = new Error('STORE_CONFLICT：实体 ' + name + ' 已绑定 ' + cur.file + '，这次要求 ' + abs);
      e.code = 'STORE_CONFLICT';
      diagErr('store:' + name, e);
      throw e;
    }
    return cur;
  }
  return new Store(name, opts);
}

function get(name) { return registry.get(name) || null; }
function list() { return Array.from(registry.values()).map((s) => s.stats()); }

module.exports = { open, get, list, Store };
