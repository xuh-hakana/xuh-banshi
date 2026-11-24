'use strict';
/* ===========================================================================
 * tools/dispatch.js —— 工具调度（2026-11-25）
 *
 * 模型给来 {name, arguments} → 校验参数 → 查权限 → 超时执行 → 读回自证。
 * 任何一步不过都返回 {ok:false,error}，调用方原样回喂给模型；绝不假装成功。
 * =========================================================================== */
const registry = require('./registry');

const DEFAULTS = { timeoutMs: 8000, maxArgBytes: 4000 };

/* 极简 JSON Schema 校验：只支持本仓库用到的子集（object/string/number/boolean/required/enum）。 */
function validate(schema, args) {
  const errs = [];
  const s = schema || {};
  const a = args;
  if (s.type === 'object') {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return ['参数必须是对象'];
    const props = s.properties || {};
    for (const k of (s.required || [])) {
      if (a[k] === undefined || a[k] === null || a[k] === '') errs.push('缺参数 ' + k);
    }
    if (s.additionalProperties === false) {
      for (const k of Object.keys(a)) if (!props[k]) errs.push('多出来的参数 ' + k);
    }
    for (const [k, v] of Object.entries(a)) {
      const p = props[k];
      if (!p) continue;
      const t = p.type;
      if (t === 'string' && typeof v !== 'string') errs.push(k + ' 要是字符串');
      if (t === 'number' && typeof v !== 'number') errs.push(k + ' 要是数字');
      if (t === 'boolean' && typeof v !== 'boolean') errs.push(k + ' 要是布尔');
      if (Array.isArray(p.enum) && p.enum.indexOf(v) < 0) errs.push(k + ' 只能是 ' + p.enum.join('/'));
    }
  }
  return errs;
}

/* 权限：场景 / 是否主人 / 模型白名单（模型白名单由调用方决定是否传 model） */
function allow(tool, ctx) {
  if (!tool) return '没有这个工具';
  const scene = ctx && ctx.scene;
  if (tool.scenes && scene && tool.scenes.indexOf(scene) < 0) return '这个场景不能用 ' + tool.name;
  if (tool.masterOnly && !(ctx && ctx.isMaster)) return '只有主人能用 ' + tool.name;
  if (tool.models && ctx && ctx.model && tool.models.indexOf(ctx.model) < 0) return '这个模型不能用 ' + tool.name;
  return '';
}

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: '工具超时（' + ms + 'ms）' }); } }, ms);
    Promise.resolve(p).then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } })
      .catch(e => { if (!done) { done = true; clearTimeout(timer);
        // 工具抛错要留痕：模型侧只会看到一句「工具抛错」，事后没人知道是哪次
        try { require('../diag/report').report('tool-dispatch', e, { tool: name }); } catch (e2) {}
        resolve({ ok: false, error: '工具抛错：' + (e && e.message || e) }); } });
  });
}

/* 执行一次工具调用。call = {name, arguments}（arguments 可以是对象或 JSON 串）。 */
async function run(call, ctx) {
  const name = String((call && call.name) || '').trim();
  const tool = registry.get(name);
  const denied = allow(tool, ctx);
  if (denied) return { ok: false, tool: name, error: denied };
  let args = call && call.arguments;
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; }
    catch (e) { return { ok: false, tool: name, error: '参数不是合法 JSON' }; }
  }
  args = args || {};
  const raw = JSON.stringify(args);
  if (raw.length > (tool.maxArgBytes || DEFAULTS.maxArgBytes)) {
    return { ok: false, tool: name, error: '参数太长' };
  }
  const errs = validate(tool.parameters, args);
  if (errs.length) return { ok: false, tool: name, error: '参数不对：' + errs.join('；') };
  const r = await withTimeout(tool.handler(args, ctx || {}), tool.timeoutMs || DEFAULTS.timeoutMs);
  if (!r || typeof r !== 'object') return { ok: false, tool: name, error: '工具没返回结果' };
  return Object.assign({ tool: name }, r);
}

module.exports = { run, validate, allow, DEFAULTS };
