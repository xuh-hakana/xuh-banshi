'use strict';
/*
 * src/learn/bridge.js —— DSH 风格插件档案桥（2026-11-10）
 *
 * 这是干什么的：DeepSeek Harness 里装了几个风格学习插件，它们把自己的「学到的风格」
 * 存成纯 JSON 文件。这个文件只做一件事——把那些 JSON 读成一段能塞进提示词的文本，
 * 让虚幻也照着同一份档案说话，不用两边各学一遍。
 *
 * 读的是这两份（都是插件自己写的，机器人只读不改）：
 *   ~/.dsh/style-memory/profile.json         ← dsh-style-memory v0.6.2
 *   ~/.dsh/Writing-Style/profiles.json       ← dsh-writing-style-learner v1.0.0
 *
 * 三条纪律：
 *   1. 读不到就返回空字符串，绝不抛错——插件没装、还没学东西，都不该影响机器人回话；
 *   2. 只读，不写。档案的真身归插件，机器人不产生第二份；
 *   3. hot() 是同步的，所以这里只做内存缓存，真正读盘放在 refresh()（启动 + 定时）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const cache = {
  card: '',        // 风格画像卡（≤400 字）
  wstyle: '',      // 写作风格档案（文本）
  cardFrom: '',    // 'plugin' 用插件自己的渲染 / 'local' 本地兜底 / '' 没有
  writingFrom: '', // 这份写作风格是从哪个 profiles.json 读来的
  at: 0,
  err: '',
};

/* ---------- 路径 ---------- */

function cardProfilePath() {
  return path.join(dshHome(), 'style-memory', 'profile.json');
}

/* 写作风格档案可能在三个地方（2026-11-22 修）：
 *   $DSH_HOME/Writing-Style/profiles.json          插件兜底的扁平写法
 *   $DSH_HOME/Writing-Style/<名字>/profiles.json   插件按名字分文件夹
 *   <仓库根>/Writing-Style/<名字>/profiles.json    插件默认写「当前会话工作区」
 * 以前只认第一条，所以东西学着学着桥这边一直是空的。按顺序找，先找到先用。 */
const REPO_ROOT = path.join(__dirname, '..', '..');

function writingProfileCandidates() {
  const out = [];
  const push = p => { if (p && out.indexOf(p) < 0) out.push(p); };
  const scan = dir => {
    push(path.join(dir, 'profiles.json'));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const n of names) {
      if (n.charAt(0) === '.') continue;
      const sub = path.join(dir, n);
      try { if (fs.statSync(sub).isDirectory()) push(path.join(sub, 'profiles.json')); } catch (e) { /* 跳过 */ }
    }
  };
  scan(path.join(dshHome(), 'Writing-Style'));
  scan(path.join(REPO_ROOT, 'Writing-Style'));
  return out;
}

// 找插件的 card.js：profile 名可能变（desktop / web / 自定义），所以扫一遍
function findCardModule() {
  const root = path.join(dshHome(), 'profiles');
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return null; }
  for (const n of names) {
    const p = path.join(root, n, 'node_modules', 'dsh-style-memory', 'lib', 'card.js');
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 继续找 */ }
  }
  return null;
}

/* ---------- 渲染：优先用插件自己的函数，找不到再本地兜底 ---------- */

// 本地兜底：只取 active 规则，按类型压成短句。字段名按 v0.6.2 的档案结构。
function localCard(profile, max) {
  const genres = (profile && profile.genres) || {};
  const rules = [];
  Object.keys(genres).forEach(g => {
    ((genres[g] || {}).rules || []).forEach(r => {
      if (!r || r.status !== 'active') return;
      const text = String(r.text || '').trim();
      if (text) rules.push({ type: r.type || '', text });
    });
  });
  if (!rules.length) return '';
  const seen = {};
  const lines = [];
  rules.forEach(r => {
    const t = r.text;
    if (seen[t]) return;
    seen[t] = 1;
    if (/^banned_phrase$/.test(r.type)) lines.push('不写「' + t + '」这类');
    else if (/^banned_pattern$/.test(r.type)) lines.push('不写这种句式：' + t);
    else if (/^preferred_phrase$/.test(r.type)) lines.push('多用「' + t + '」这样的说法');
    else lines.push(t);
  });
  let out = lines.slice(0, 12).join('；');
  if (out.length > max) out = out.slice(0, max - 1) + '…';
  return out;
}

async function renderCard() {
  const p = cardProfilePath();
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return { text: '', from: '' }; }
  let profile = null;
  try { profile = JSON.parse(raw); } catch (e) { return { text: '', from: '' }; }
  const max = 400;

  const mod = findCardModule();
  if (mod) {
    try {
      const c = await import('file://' + mod);
      const text = String(c.buildCard(profile, 'global', max) || '').trim();
      if (text) return { text, from: 'plugin' };
      return { text: '', from: '' };
    } catch (e) { /* 插件版本变了就落到本地兜底 */ }
  }
  return { text: localCard(profile, max), from: 'local' };
}

// 写作风格档案：{version, activeName, profiles:{name:{title, profile, updatedAt}}}
// profile 是个分层对象，按「标题：值」展平，只保留有内容的
const TITLES = {
  summary: '风格概述',
  text_style: '文本风格',
  illustrations: '插图',
  figures: '插图',
  images: '插图',
  numbering: '编号',
  tables: '表格',
  fonts: '字体',
  structure: '结构',
  formatting: '格式',
  rules: '写作规则',
  examples: '风格示例',
};

function flatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flatValue).filter(Boolean).join('；');
  if (typeof v === 'object') {
    return Object.keys(v).map(k => {
      const inner = flatValue(v[k]);
      return inner ? (TITLES[k] || k) + '：' + inner : '';
    }).filter(Boolean).join('；');
  }
  return '';
}

/* 从一份档案里挑「激活的那套」：activeName 命中的优先，其次元素带 active:true，
 * 最后退唯一一份/最新一份。返回 {title, body, from} 或 null。 */
function pickWriting(raw, from) {
  let store = null;
  try { store = JSON.parse(raw); } catch (e) { return null; }
  if (!store || typeof store !== 'object') return null;
  const list = store.profiles;
  let rec = null, name = '';
  if (list && !Array.isArray(list) && typeof list === 'object') {
    name = String(store.activeName || '');
    if (name && list[name]) rec = list[name];
    if (!rec) {
      const keys = Object.keys(list);
      const hit = keys.find(k => list[k] && list[k].active);
      if (hit) { rec = list[hit]; name = hit; }
      else if (keys.length === 1) { rec = list[keys[0]]; name = keys[0]; }
    }
  } else if (Array.isArray(list)) {
    rec = list.find(x => x && x.active) || list[0] || null;
    name = rec ? String(rec.name || rec.title || '') : '';
  } else if (store.profile) {
    rec = store;                                  // 只有一套的最简形态
  }
  if (!rec) return null;
  const body = flatValue(rec.profile || rec);
  if (!body) return null;
  const title = String(rec.title || name || '');
  return { title: title, body: body, from: from };
}

function renderWritingStyle(max) {
  for (const p of writingProfileCandidates()) {
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const r = pickWriting(raw, p);
    if (!r) continue;
    const head = r.title ? '写作风格「' + r.title + '」' : '写作风格';
    let out = head + '：' + r.body;
    if (out.length > max) out = out.slice(0, max - 1) + '…';
    return { text: out, from: p };
  }
  return { text: '', from: '' };
}

/* ---------- 对外 ---------- */

// 异步刷新缓存。启动一次，之后跟着 learn.tick() 一起跑（默认 30 分钟）。
async function refresh() {
  const out = { card: '', wstyle: '', cardFrom: '', err: '' };
  try {
    const r = await renderCard();
    out.card = r.text;
    out.cardFrom = r.from;
    const w = renderWritingStyle(600);
    out.wstyle = w.text;
    out.writingFrom = w.from;
  } catch (e) {
    out.err = e && e.message ? e.message : String(e);
  }
  cache.card = out.card;
  cache.wstyle = out.wstyle;
  cache.cardFrom = out.cardFrom;
  cache.writingFrom = out.writingFrom || '';
  cache.at = Date.now();
  cache.err = out.err;
  return out;
}

// 同步取：只读内存。没有就返回空串。
function text(max) {
  const lim = Number(max) > 0 ? Number(max) : 700;
  const parts = [];
  if (cache.card) parts.push('【她的写作风格】' + cache.card);
  if (cache.wstyle) parts.push('【她的写作风格（详细）】' + cache.wstyle);
  const joined = parts.join('\n');
  if (joined.length <= lim) return joined;
  return joined.slice(0, lim - 1) + '…';
}

function state() {
  return {
    hasCard: !!cache.card, hasWriting: !!cache.wstyle,
    cardFrom: cache.cardFrom, writingFrom: cache.writingFrom || '',
    at: cache.at, err: cache.err,
    paths: { card: cardProfilePath(), writing: writingProfileCandidates() },
  };
}

module.exports = { refresh, text, state, localCard, dshHome };
