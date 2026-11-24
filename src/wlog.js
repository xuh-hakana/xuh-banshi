/* wlog.js — 机器人写入日志（管理面板「我的控制台 → 写入日志」看的就是 data/bot-writes.jsonl）
 * 主人 2026-10-22 定：话题、约定、新人物、新群……凡是机器人主动写文件/记忆，都必须在这里记一条
 * ——它到底写了什么、写哪儿了，主人能看见、能一键清空（真删）。
 * 各模块（core / taste / nick / region / style / dice / qq 连接器）共用这一个入口，避免有的写了不记。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'bot-writes.jsonl');

function botWrite(file, action, text) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({
      t: new Date().toISOString(),
      file: String(file || ''),
      action: String(action || ''),
      text: String(text || '').slice(0, 240),
    }) + '\n', 'utf8');
  } catch (e) { console.error('[wlog] 写日志失败', e.message); }
}

module.exports = { botWrite, FILE };
