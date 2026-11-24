'use strict';
/*
 * censor-guard.js — 审查词守卫（主人 2026-11-19 定）
 *
 * 干什么：
 *   1. 读主人自己在面板里填的《审查词.md》，检测本轮输入有没有命中（子串匹配，长词优先）。
 *   2. 命中时把《审查词说明.md》交给 core.js 注入提示词——让联网模型别对着词做机械反射、
 *      别激烈拒绝、别跳出人设，先看语境。
 *
 * 边界（别改错地方）：
 *   - 本模块只判「命中」和「给说明」，不决定模型链、不写任何持久设置。
 *   - 本轮是否走本地优先由 core.js 的 callLLM 决定，且是临时的一次性判定；
 *     会话级的「本地模型优先」开关在 conv-settings.json，是另一回事，这里绝不碰。
 *   - 词表为空 = 功能关闭，一律返回未命中，零注入、零开销。
 *
 * 词表格式（《审查词.md》，面板 markdown 编辑器可改）：
 *   - 只有「`- 词`」这种列表行才算生效词；`> ` 引用行是说明 / 参考，不算词。
 *   - `#` 开头的标题行不算；行内 `#` 后面当注释剥掉。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const WORDS_FILE = path.join(ROOT, 'data', '审查词.md');
const EXPLAIN_FILE = path.join(ROOT, 'data', '审查词说明.md');

// mtime 缓存：面板改完下一句就生效，没改就不重复读盘（跟项目里其它模块的读法一致）
let _w = { at: -1, words: [] };
let _e = { at: -1, text: '' };

/* 读生效词。传 file 走一次性读取（测试用），不进缓存。
 * 长词排前面，避免短词先命中把日志写得太难看；命中的是整组词，顺序只影响展示。 */
function loadWords(file) {
  const p = file || WORDS_FILE;
  try {
    const st = fs.statSync(p);
    if (!file && _w.at === st.mtimeMs) return _w.words.slice();
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (/^\s*>/.test(line)) continue;                 // 引用行：说明 / 参考，不算词
      if (/^\s*#/.test(line)) continue;                 // markdown 标题
      const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);    // 只有列表项里的词生效
      if (!m) continue;
      const word = m[1].split('#')[0].trim();           // 行内 # 当注释
      if (word) out.push(word);
    }
    const uniq = Array.from(new Set(out)).sort((a, b) => b.length - a.length);
    if (!file) _w = { at: st.mtimeMs, words: uniq };
    return uniq;
  } catch {
    return [];                                          // 文件读不到 = 功能关，别拖垮这一轮
  }
}

/* 输入里命中了哪些词。words 可传已加载的词表（省一次读）。未命中返回 []。 */
function hit(text, words) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const ws = Array.isArray(words) ? words : loadWords();
  if (!ws.length) return [];
  return ws.filter(w => w && s.indexOf(w) >= 0);
}

/* 从一组 {role,content} 里取最后一条 user 文本。
 * callLLM 拿不到原始 userText，只能从消息里认；buildMessages 那条链用传入的 userText 更准。 */
function pickUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/* 给联网模型自助取用的说明全文（mtime 缓存）。读不到返回空串，调用方据此跳过注入。 */
function explanation(file) {
  const p = file || EXPLAIN_FILE;
  try {
    const st = fs.statSync(p);
    if (!file && _e.at === st.mtimeMs) return _e.text;
    const text = fs.readFileSync(p, 'utf8');
    if (!file) _e = { at: st.mtimeMs, text };
    return text;
  } catch {
    return '';
  }
}

module.exports = { WORDS_FILE, EXPLAIN_FILE, loadWords, hit, pickUserText, explanation };
