'use strict';
/*
 * sticker-filter.js —— 收图闸的分辨逻辑集中在这里（2026-11-25 主人定）
 *
 * 主人说「后续会优化分辨逻辑」：所以判定只写在这一个文件，qq.js 只负责调用。
 *   descBlockKind(desc)  描述（识图）兜底判定：截图 / 插画 → 拦
 *   kindBlock(kind,simple) 结构判定：截图/插画/复杂漫画页 → 拦
 *   probe(buf,opt)       起一次判图脚本（路径来自配置 stickerProbeScript，不写死）
 * 阈值/关键字要改，改这里；判图脚本本身换了，改配置里的脚本路径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sp = require('./sticker-paths');

let errLog = null;
try { errLog = require('./err-log'); } catch (e) { errLog = null; }

const DESC_SCREENSHOT = /截图|聊天记录|评论区|论坛帖子|网页|界面|对话框|弹幕列表/;
const DESC_ILLUSTRATION = /插画|立绘|原画|壁纸|海报|画作|绘画作品|艺术图|插图/;

// 描述兜底：返回 '' | 'screenshot' | 'illustration'
function descBlockKind(desc) {
  const t = String(desc || '');
  if (!t) return '';
  if (DESC_SCREENSHOT.test(t)) return 'screenshot';
  if (DESC_ILLUSTRATION.test(t)) return 'illustration';
  return '';
}

// 结构判定：返回 '' | kind
function kindBlock(kind, simple) {
  const k = String(kind || '');
  if (k === 'screenshot' || k === 'illustration') return k;
  if (k === 'manga_page' && (simple === false || simple === 0)) return k;
  return '';
}

const _cache = new Map();
// 跑一次判图脚本（同一 md5 复用结果）。opt.py = python 路径
function probe(buf, opt) {
  opt = opt || {};
  const b = buf || [];
  const md5 = crypto.createHash('md5').update(b).digest('hex');
  const hit = _cache.get(md5);
  if (hit) return Promise.resolve(hit);
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), 'sp_' + Date.now() + Math.random().toString(36).slice(2));
    try { fs.writeFileSync(tmp, b); } catch (e) { return resolve({ ok: false }); }
    const py = opt.py || 'python3';
    const script = sp.probeScript();
    require('child_process').execFile(py, [script, tmp], { timeout: 30000 }, (err, so) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      let j = { ok: false };
      try { j = JSON.parse(String(so || '')) || { ok: false }; } catch (e) {}
      if (j && j.ok) {
        if (_cache.size > 500) _cache.clear();
        _cache.set(md5, j);
      } else {
        try { if (errLog) errLog.logErr('probe', '判图算不出来', { h: j.h_err || '', k: j.k_err || '', script: sp.relOf(script) }); } catch (e) {}
      }
      resolve(j);
    });
  });
}

module.exports = { descBlockKind, kindBlock, probe, DESC_SCREENSHOT, DESC_ILLUSTRATION };
