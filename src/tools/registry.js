'use strict';
/* ===========================================================================
 * tools/registry.js —— 声明式工具表（2026-11-25 重构，方案 1）
 *
 * 一条工具 = name + 描述 + JSON Schema 参数 + 平台/权限 + handler。
 * handler **必须读回自证**：没真做成返回 {ok:false,error}，不许报成功
 * （这个仓库的老规矩：写了但读回来对不上，不许报成功）。
 *
 * 现在只登记「已经有实现、签名确认过」的能力；新能力加一条，不改判断链。
 * =========================================================================== */
const memory = require('../memory');
const teach = require('../teach');

function str(v) { return String(v == null ? '' : v).trim(); }

const TOOLS = [];

function define(t) {
  if (!t || !t.name) throw new Error('tool 缺 name');
  if (!t.parameters || t.parameters.type !== 'object') throw new Error('tool ' + t.name + ' 缺 parameters');
  if (typeof t.handler !== 'function') throw new Error('tool ' + t.name + ' 缺 handler');
  const i = TOOLS.findIndex(x => x.name === t.name);
  if (i >= 0) TOOLS[i] = t; else TOOLS.push(t);
  return t;
}

function list(scene) {
  return TOOLS.filter(t => !scene || !t.scenes || t.scenes.indexOf(scene) >= 0);
}

function get(name) { return TOOLS.find(t => t.name === name) || null; }

/* 给模型看的 tools 数组（OpenAI function-calling 形状）。 */
function specs(scene) {
  return list(scene).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/* ------------------------------------------------------------ 内置工具 */
// 记一条工作日志（她的长期记忆正本，memory.appendLog 有落盘与回读）
define({
  name: 'remember_note',
  description: '把值得长期记住的一件事写进长期记忆。写给「一个人」的事实/喜好/约定都走这个。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要记的内容，一句话，写清是谁的什么事' },
      kind: { type: 'string', description: '分类：人物/喜好/约定/日常/日期，缺省 日常' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  scenes: ['qq', 'bili'],
  handler: async (args, ctx) => {
    const text = str(args.text);
    if (text.length < 2) return { ok: false, error: '内容太短，没记' };
    const kind = str(args.kind) || '日常';
    const line = memory.appendLog(kind, text, ctx && ctx.at);
    // 读回自证：appendLog 返回落盘行；没有就说明没写成
    if (!line) return { ok: false, error: '没写进去（appendLog 返回空）' };
    return { ok: true, kind, text, wrote: String(line).slice(0, 200) };
  },
});

// 教别人教过的东西（带署名、可复核）；重复不重复落
define({
  name: 'teach_save',
  description: '把别人教的知识记下来（带署名，之后谁问到都算）。只记对方明确教过的，不要自己编。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '对方教的原话或整理后的知识点' },
      qq: { type: 'string', description: '教的人的号（没有就留空）' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  scenes: ['qq', 'bili'],
  handler: async (args, ctx) => {
    const text = str(args.text);
    if (text.length < 4) return { ok: false, error: '太短，不像知识点' };
    const rec = teach.add({ text, qq: str(args.qq) || (ctx && ctx.uid) || '' });
    if (!rec) return { ok: false, error: '解析失败，没落盘' };
    return { ok: true, text: str(rec.text || '').slice(0, 200) };
  },
});

module.exports = { TOOLS, define, list, get, specs };
