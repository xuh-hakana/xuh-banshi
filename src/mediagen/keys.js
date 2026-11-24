'use strict';
/*
 * keys.js —— 视频工坊取 key（2026-11-25）
 *
 * 复用 src/llm-astrbot.js 的同一条路子：读 AstrBot 的 ~/.astrbot/data/cmd_config.json，
 * 那里 provider_sources[] 每个源都有 { provider, key, api_base }。
 * 视频/图/音乐/配音都从这里取，不新建第二套密钥通道。
 *
 * 安全：key 只在内存里用，不打印、不进日志、不写盘。
 *      需要覆盖时在 src/config/media.json 的 keys 段写，优先级高于 AstrBot。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASTRBOT_CFG = path.join(os.homedir(), '.astrbot', 'data', 'cmd_config.json');
const MEDIA_CFG = path.join(__dirname, '..', 'config', 'media.json');

let _cache = { at: 0, mtime: 0, map: null };

function pick(v) {
  if (Array.isArray(v)) return String(v[0] || '').trim();
  return String(v || '').trim();
}

function mediaCfg() {
  try { return JSON.parse(fs.readFileSync(MEDIA_CFG, 'utf8')); } catch { return {}; }
}

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(ASTRBOT_CFG).mtimeMs; } catch { mtime = 0; }
  if (_cache.map && _cache.mtime === mtime && Date.now() - _cache.at < 60000) return _cache.map;

  const map = {};
  // 1) AstrBot 源
  try {
    const j = JSON.parse(fs.readFileSync(ASTRBOT_CFG, 'utf8'));
    for (const s of j.provider_sources || []) {
      const k = pick(s.key);
      if (k) map[String(s.provider || s.id || '').trim()] = {
        key: k, base: String(s.api_base || '').trim(), from: 'astrbot', enable: s.enable !== false,
      };
    }
  } catch { /* AstrBot 没装 / 文件坏 → 只用 media.json */ }

  // 2) media.json 覆盖
  const mc = mediaCfg();
  for (const [name, v] of Object.entries(mc.keys || {})) {
    if (v && typeof v === 'object' && v.key) {
      map[name] = { key: String(v.key), base: String(v.base || (map[name] || {}).base || ''), from: 'media.json', enable: true };
    } else if (typeof v === 'string' && v.trim()) {
      map[name] = { key: v.trim(), base: (map[name] || {}).base || '', from: 'media.json', enable: true };
    }
  }

  _cache = { at: Date.now(), mtime, map };
  return map;
}

function get(provider) {
  const e = load()[String(provider || '').trim()];
  return e && e.enable !== false ? e.key : '';
}

function base(provider) {
  const e = load()[String(provider || '').trim()];
  return e ? e.base : '';
}

function has(provider) { return !!get(provider); }

function providers() {
  const m = load();
  return Object.keys(m).filter((k) => m[k].key && m[k].enable !== false);
}

/** 只报「有没有」，绝不回 key 本身 —— 给自检/面板用 */
function status() {
  const m = load();
  return Object.keys(m).map((k) => ({ provider: k, keySet: !!m[k].key, from: m[k].from, base: m[k].base }));
}

module.exports = { get, base, has, providers, status, load };
