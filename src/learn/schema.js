/*
 * src/learn/schema.js —— 学习系统的结构与常量（唯一一份）
 *
 * 这是干什么的：把「目录在哪、字段叫什么、上限多少」集中在一处。
 * 别的文件一律 require 这里，不许自己写一遍字符串常量——写两遍迟早对不上。
 *
 * 三层（主人 2026-11-09 定）：
 *   热层 hot()  每轮注入：好感摘要 + 每人风格卡 + 进化结论（结论走 memory.MEMORY.md）
 *   温层 warm() 命中才检索：每人知识库、偏好、历史话题
 *   冷层 acts   只追加：说过什么、对谁、基于什么证据
 */
const path = require('path');

const V = 1;                                   // 结构版本号，改结构就 +1 并在 store.migrate 里写迁移
const ROOT = path.join(__dirname, '..', 'data', 'learn');

const PATHS = {
  root: ROOT,
  version: path.join(ROOT, 'version.json'),
  users: path.join(ROOT, 'users'),             // 每人一个目录，物理隔离
  self: path.join(ROOT, 'self'),               // 机器人自己的：身份/自我事实/世界观/信念/特质
  acts: path.join(ROOT, 'acts'),               // 冷层：输出元记录，按月一份
};

// 注入上限按字数硬截断（代码截，不靠提示词自觉）
const LIMITS = {
  hotChars: 700,
  warmChars: 500,
  summaryEvents: 2,        // 好感摘要里最多列几条最近变化
  recentEvents: 30,        // 客户端一屏最多看几条
  // 每人风格三份（2026-11-09 P1）：她要求「每轮强制注入，优先级高于普通记忆」，
  // 所以单独给一块上限，不吃好感那 700 字
  styleHotChars: 700,
  styleFileChars: 1200,    // 单份文件最多存多少字（超了客户端也不让你存，免得白写）
  styleSampleChars: 200,   // 一条例句
  kbTextChars: 300,        // 知识库一条
  actTextChars: 120,       // 冷层存的是摘要，不是全文
};

// 好感分层，口径与 data/人物喜好.md 表头一致，不许另定一套
const LEVELS = [[60, '亲近'], [1, '认识'], [0, '无记录']];
function level(v) {
  const n = Number(v) || 0;
  for (const [at, name] of LEVELS) if (n >= at) return name;
  return '无记录';
}

// 事件分类：说明「这次分数为什么变」，撤销和复盘都靠它
const TRIGGER = {
  event: '具体一件事',
  chat: '聊天表现',
  decay: '时间衰减',
  manual: '主人手改',
  revoke: '撤销前一条',
};

// 每人目录里的文件名（写死在这里，别处不许拼字符串）
const FILES = {
  profile: 'profile.json',
  favor: 'favor.jsonl',
  decay: 'decay.json',
  styleDir: 'style',
  styleFiles: ['角色性格.md', '允许&禁止行为.md', '预设发言例句.md'],
  kbDir: 'kb',
  topics: 'topics.jsonl',
};

module.exports = { V, ROOT, PATHS, LIMITS, LEVELS, TRIGGER, FILES, level };
