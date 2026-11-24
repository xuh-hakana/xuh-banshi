// src/dict.js
// 通用中文词典：本地中文语料快速检索（成语 / 歇后语 / 汉字 / 词语）。
// 数据来自开源 chinese-xinhua（成语 / 歇后语 / 汉字）+ mapull/chinese-dictionary（词语，MIT）
//   + CHIME 中文网络梗数据集（MIT，github.com/yuboxie/chime）+ 少量常见新词整理稿。
// 全 JSON：约 31k 成语 + 14k 歇后语 + 16k 汉字 + 305k 词语（文言语词 / 现代常用词 / 2020+ 网络新词）。
//
// 设计原则（对齐 guides.glossaryHit 的「词典型」范式）：
//   1. 全部懒加载 + 内存索引，第一次用到才读文件、之后缓存；启动零负担。
//   2. 命中时才把含义注入提示词帮 AI 理解，不接管回复、不进面板。
//   3. 语料本身不进 prompt —— 只在消息里真出现某个成语/歇后语时才把那一条释义打进去，
//      从而把原本要常驻在提示词里的「情绪规则发言规范 / 示例语料」移出上下文，按需检索。
//   4. 任一数据文件缺失/损坏都不影响主流程（返回空）。
//
// 暴露：
//   dictGloss(text)         —— 被动命中：从一句话里捡出成语/歇后语/被提问的字词，返回 [{title, meaning}]
//   lookupIdiom / lookupXiehouyu / lookupChar / lookupWord —— 主动查询（供其它模块/工具调用）

const fs = require('fs');
const path = require('path');

const DICT_DIR = path.join(__dirname, 'data', 'dict');

// ---------- 懒加载缓存 ----------
let _idiomMap = null, _idiomStamp = 0;
let _xiehouMap = null, _xiehouByFirst = null, _xiehouStamp = 0;
let _charMap = null, _charStamp = 0;
let _ciMap = null, _ciStamp = 0;
let _restrictedMap = null, _restrictedStamp = 0;

function mtime(name) { try { return fs.statSync(path.join(DICT_DIR, name)).mtimeMs; } catch { return -1; } }

function loadJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DICT_DIR, name), 'utf8')); }
  catch { return null; }
}

// 成语：word -> { pinyin, explanation, derivation }
function loadIdioms() {
  const p = 'idiom.json';
  if (_idiomMap && _idiomStamp === mtime(p)) return _idiomMap;
  _idiomStamp = mtime(p);
  const arr = loadJson(p);
  const m = new Map();
  if (Array.isArray(arr)) for (const e of arr) {
    if (e && e.word) m.set(String(e.word), {
      pinyin: e.pinyin || '',
      explanation: (e.explanation || '').replace(/\s+/g, ' ').trim(),
      derivation: (e.derivation || '').replace(/\s+/g, ' ').trim(),
    });
  }
  _idiomMap = m;
  return m;
}

// 歇后语：riddle -> [answer]，并按首字建索引加速「消息里是否含某谜面」的检测
function loadXiehou() {
  const p = 'xiehouyu.json';
  if (_xiehouMap && _xiehouStamp === mtime(p)) return;
  _xiehouStamp = mtime(p);
  const arr = loadJson(p);
  const m = new Map();
  const byFirst = new Map();
  if (Array.isArray(arr)) for (const e of arr) {
    if (!e || !e.riddle) continue;
    const r = String(e.riddle), a = String(e.answer || '');
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(a);
    const fc = r[0];
    if (!byFirst.has(fc)) byFirst.set(fc, []);
    byFirst.get(fc).push(r);
  }
  _xiehouMap = m;
  _xiehouByFirst = byFirst;
}

// 汉字：word -> { pinyin, explanation }（explanation 截短省内存）
function loadChars() {
  const p = 'word.json';
  if (_charMap && _charStamp === mtime(p)) return _charMap;
  _charStamp = mtime(p);
  const arr = loadJson(p);
  const m = new Map();
  if (Array.isArray(arr)) for (const e of arr) {
    if (!e || !e.word) continue;
    m.set(String(e.word), {
      pinyin: e.pinyin || '',
      explanation: (e.explanation || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }
  _charMap = m;
  return m;
}

// 词语（305k，单独懒加载，只有查词时才读；含 2020+ 网络新词，来源见文件头）
// 合并 user-words.json（主人的单独词库）：多义默认不覆盖，只把「不同义项」追加进去；
// 文件缺失/损坏/条目缺字段一律跳过，绝不拖垮机器人。
function loadCi() {
  const p = 'ci.json', up = 'user-words.json';
  const stamp = mtime(p) + '|' + mtime(up);
  if (_ciMap && _ciStamp === stamp) return _ciMap;
  _ciStamp = stamp;
  const arr = loadJson(p);
  const m = new Map();
  if (Array.isArray(arr)) for (const e of arr) {
    if (!e || !e.ci) continue;
    m.set(String(e.ci), String(e.explanation || '').replace(/\s+/g, ' ').trim());
  }
  const ua = loadJson(up);
  if (Array.isArray(ua)) for (const e of ua) {
    if (!e || !e.ci || typeof e.explanation !== 'string') continue;
    const ci = String(e.ci), add = e.explanation.trim();
    if (!add) continue;
    if (m.has(ci)) {
      const cur = m.get(ci);
      if (!cur.includes(add) && !add.includes(cur)) m.set(ci, cur + '；' + add);
    } else m.set(ci, add);
  }
  _ciMap = m;
  return m;
}

// 受限词侧车（restricted.json）：只存「标记」元数据，不碰 ci.json 本身。
// 面板页可改这张表；bot 侧读它做「模型侧不输出粗俗词」的软约束。
function loadRestricted() {
  const p = 'restricted.json';
  if (_restrictedMap && _restrictedStamp === mtime(p)) return _restrictedMap;
  _restrictedStamp = mtime(p);
  const o = loadJson(p);
  const m = new Map();
  if (o && typeof o === 'object') for (const k of Object.keys(o)) {
    if (o[k] && o[k].restricted) m.set(k, o[k]);
  }
  _restrictedMap = m;
  return m;
}

// ---------- 主动查询 ----------
function lookupIdiom(word) {
  const m = loadIdioms();
  return m.get(String(word)) || null;
}

function lookupXiehouyu(riddle) {
  loadXiehou();
  if (!_xiehouMap) return [];
  const r = String(riddle || '').trim();
  if (!r) return [];
  if (_xiehouMap.has(r)) return _xiehouMap.get(r);
  const out = [];                                  // 模糊：含该子串的谜面
  for (const [k, v] of _xiehouMap) {
    if (k.includes(r) || r.includes(k)) { out.push(...v); if (out.length >= 5) break; }
  }
  return out;
}

function lookupChar(ch) {
  const m = loadChars();
  return m.get(String(ch)) || null;
}

function lookupWord(term) {
  const m = loadCi();
  return m.has(term) ? m.get(term) : null;
}

// ---------- 被动命中（注入用）----------
function fmtIdiom(e) {
  let s = '';
  if (e.pinyin) s += '【拼音】' + e.pinyin + ' ';
  if (e.explanation) s += '【释义】' + e.explanation;
  return s.trim();
}

function fmtXiehou(riddle, answers) {
  return '（歇后语）' + riddle + ' → ' + answers.join('；');
}

// 从一句话里捡出可被「通用中文词典」解释的内容，返回 [{title, meaning}]（最多 6 条）。
function dictGloss(text) {
  const t = String(text || '');
  if (t.length < 2) return [];
  const out = [];

  // 1) 成语：滑窗 2~6 字精确查（长优先，避免把 4 字成语拆成 2 字误命中）
  const idiomMap = loadIdioms();
  const seen = new Set();
  for (let len = 6; len >= 2; len--) {
    for (let i = 0; i + len <= t.length; i++) {
      const seg = t.substr(i, len);
      if (seen.has(seg)) continue;
      const e = idiomMap.get(seg);
      if (e) { out.push({ title: seg, meaning: fmtIdiom(e) }); seen.add(seg); }
    }
  }

  // 2) 歇后语：谜面子串命中（按首字索引加速）
  loadXiehou();
  if (_xiehouByFirst) {
    for (const ch of new Set(t)) {
      const riddles = _xiehouByFirst.get(ch);
      if (!riddles) continue;
      for (const r of riddles) {
        if (r.length >= 2 && t.includes(r) && !seen.has(r)) {
          out.push({ title: r, meaning: fmtXiehou(r, _xiehouMap.get(r)) });
          seen.add(r);
        }
      }
    }
  }

  // 3) 显式提问：「X 怎么读 / 什么意思 / 是什么字 / 念什么 / 啥意思」→ 查汉字或词语
  const q = t.match(/(.{1,4})(?:怎么读|怎么念|念什么|什么意思|是什么意思|啥意思|是什么字|怎么写)/);
  if (q) {
    let term = q[1].trim();
    // 「X 是什么意思」会被上面的贪婪量词切成「X是」，剥掉尾部「是」再查；
    // 指代式提问（这/那/它 是…）不当词条查，保持原先「查不到」的行为。
    if (/是$/.test(term)) {
      const t2 = term.slice(0, -1);
      if (t2 && !/^[这那它其]$/.test(t2)) term = t2;
    }
    if (term && !seen.has(term)) {
      const ch = lookupChar(term);
      if (ch) { out.push({ title: term, meaning: '【读音】' + ch.pinyin + ' 【释义】' + ch.explanation }); seen.add(term); }
      else {
        const w = lookupWord(term);
        if (w) {
          let meaning = '【词语】' + w;
          // 受限词：仍让模型理解用户语义（不屏蔽用户侧内容），但提示回复时不要原样复述粗俗词
          if (loadRestricted().has(term)) meaning += '（受限词：理解用户语义即可，回复中不要原样复述该粗俗词）';
          out.push({ title: term, meaning }); seen.add(term);
        }
      }
    }
  }

  return out.slice(0, 6);
}

module.exports = { dictGloss, lookupIdiom, lookupXiehouyu, lookupChar, lookupWord };
