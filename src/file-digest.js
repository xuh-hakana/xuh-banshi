'use strict';
/* ===========================================================================
 * file-digest.js — 让她「看懂」客户端发来的文件
 *
 * 主人 2026-11-23：「文件只把名字交给虚幻，不解析内容」→ 不行，要真读。
 * 分两条路，先便宜后贵：
 *   ① 纯文本类（txt/md/json/csv/log/代码…且 ≤512KB）：直接读，截断，0 成本 0 等待；
 *   ② 其它（pdf/docx/xlsx/pptx/zip/图片/音视频…）：交给 DSH（agent-link）去读，
 *      它本来就有读写文件的能力（主人 2026-11-22 接好的），读完只要它给中文摘要。
 *
 * 只读不写：提示词里明说「不许改文件」。DSH 不可用 / 超时 → ok:false，
 * 调用方降级成「只报文件名」，别把消息卡死。
 *
 * 用法：
 *   const fd = require('./file-digest');
 *   await fd.digest('/abs/a.pdf', 'a.pdf')   // { ok, via:'text'|'dsh'|'', text, error, ms }
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|ini|conf|cfg|xml|html?|css|js|mjs|cjs|ts|jsx|tsx|py|java|c|h|cpp|go|rs|sh|bat|ps1|sql|toml|env)$/i;
const MAX_TEXT_BYTES = 512 * 1024;      // 文本类上限：再大就交 DSH 摘要，别把 12 万字塞进上下文
const MAX_TEXT_CHARS = 12000;           // 进上下文的字数上限
const DSH_TIMEOUT_MS = 120000;

function kindOf(name, file) {
  const n = String(name || file || '').toLowerCase();
  if (/\.(pdf)$/.test(n)) return 'pdf';
  if (/\.(docx?|wps)$/.test(n)) return 'word';
  if (/\.(xlsx?|csv|tsv|et)$/.test(n)) return 'sheet';
  if (/\.(pptx?|dps)$/.test(n)) return 'slides';
  if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return 'archive';
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(n)) return 'image';
  if (/\.(mp3|wav|m4a|amr|silk|flac|ogg)$/i.test(n)) return 'audio';
  if (/\.(mp4|mov|mkv|avi|flv|webm)$/i.test(n)) return 'video';
  return 'file';
}

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return '';
    const buf = fs.readFileSync(file);
    // 二进制嗅探：前 4KB 里出现 NUL 就当不是文本
    if (buf.slice(0, 4096).includes(0)) return '';
    return buf.toString('utf8').slice(0, MAX_TEXT_CHARS);
  } catch { return ''; }
}

function dshPrompt(abs, name, k) {
  return [
    '你是文件阅读器，只读，不许修改、移动、删除任何文件。',
    '请读这个本地文件：' + abs,
    '（文件名：' + name + '，类型：' + k + '）',
    '用中文回答三件事，简短分段，不要客套话：',
    '1) 这是什么文件（一句话）',
    '2) 里面有什么关键内容（' + (k === 'sheet' ? '表头/列名/大致数据规模与明显规律' : k === 'archive' ? '包里有哪些文件和目录' : '要点条目，重要的数字/结论/人名照原样保留') + '）',
    '3) 有没有值得特别注意的地方（报错、异常、冲突、结论）',
    '如果文件打不开或读不出内容，就直接说读不了和原因，不要猜内容。',
  ].join('\n');
}

async function digest(file, name, opt) {
  const t0 = Date.now();
  const o = opt || {};
  const abs = path.resolve(String(file || ''));
  const nm = String(name || path.basename(abs));
  if (!fs.existsSync(abs)) return { ok: false, via: '', text: '', error: '文件不在', ms: 0 };
  const k = kindOf(nm, abs);

  // ① 纯文本直读
  if (k === 'file' && TEXT_EXT.test(nm)) {
    const t = readText(abs);
    if (t.trim()) return { ok: true, via: 'text', text: t.trim(), kind: k, ms: Date.now() - t0 };
  }

  // ② 交 DSH
  let link;
  try { link = require('./agent-link'); } catch (e) { return { ok: false, via: '', text: '', error: 'DSH 接不上：' + e.message, ms: Date.now() - t0 }; }
  const key = 'file-' + crypto.createHash('md5').update(abs).digest('hex').slice(0, 10);
  try {
    const r = await link.runTask({ text: dshPrompt(abs, nm, k), sessionKey: key, timeoutMs: Number(o.timeoutMs) || DSH_TIMEOUT_MS, cwd: ROOT });
    const out = String((r && r.text) || '').trim().slice(0, MAX_TEXT_CHARS);
    if (!r || !r.ok || !out) {
      return { ok: false, via: 'dsh', text: '', error: 'DSH 没读出内容（' + ((r && r.reason) || 'empty') + '）', ms: Date.now() - t0 };
    }
    return { ok: true, via: 'dsh', text: out, kind: k, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, via: 'dsh', text: '', error: 'DSH 出错：' + String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 };
  }
}

module.exports = { digest, kindOf, TEXT_EXT };
