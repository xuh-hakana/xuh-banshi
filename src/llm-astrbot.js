'use strict';
/*
 * llm-astrbot.js —— 把 AstrBot 已经配好的模型接给 xuhbot 用（她 2026-11-10 令「直接接入 AstrBot」）
 *
 * 这是干什么的：xuhbot 自己的 llm.json 只配了智谱一个源；她在 AstrBot 里已经配好 8 个源、16 个模型。
 * 这里只做一件事——把「模型名」翻译成「那个源的地址 + Key」，让 xuhbot 用上那些模型。
 *
 * 为什么不走 AstrBot 的接口（实测过，不是猜）：
 *   AstrBot 4.29.3 没有 OpenAI 兼容端点（/v1/chat/completions / /api/v1/chat/completions 全是 404），
 *   唯一的 /api/chat 要鉴权，而且会把请求塞进 AstrBot 自己的 agent 流程 → 它的人设与工具会盖掉
 *   xuhbot 的人设、好感度、表情包上下文，那才是真「掉功能」。所以改成读它的配置。
 *
 * 读哪（只读，绝不写 AstrBot 任何文件）：
 *   ~/.astrbot/data/cmd_config.json
 *     .provider_sources[] = 源   { id, type, provider, key, api_base, enable }
 *     .provider[]         = 模型 { id, enable, model, provider_source_id }
 * 注意：AstrBot 的 key / api_base 在 python 里可能是 list（实测 key 就是 ["..."]），这里统一取第一个字符串。
 *
 * 安全与降级：
 *   - AstrBot 没装 / 文件坏 / 字段缺 → 返回空池，xuhbot 照旧用 llm.json，一个字段都不变，不抛错。
 *   - Key 只在内存里用，不打印、不写日志、不返回给客户端。
 *   - 按 mtime 缓存：AstrBot 里改了配置，下次读盘自动跟上。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG_PATH = path.join(os.homedir(), '.astrbot', 'data', 'cmd_config.json');

// 只接请求体是 OpenAI 格式的源；googlegenai_chat_completion 是 Gemini 原生格式，
// xuhbot 发的是 {model, messages, temperature, max_tokens}，发过去会被拒，故不接（如实不装能）。
const OPENAI_LIKE = new Set([
  'openai_chat_completion',
  'zhipu_chat_completion',
  'longcat_chat_completion',
]);

let _cache = { mtime: 0, at: 0, pool: null };

function pick(v) {
  if (Array.isArray(v)) return String(v[0] || '').trim();
  return String(v || '').trim();
}

/* 拼出 chat/completions 完整地址。AstrBot 存的是 base（末尾带不带斜杠都有）。 */
function joinUrl(base) {
  let b = pick(base).replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

function load() {
  let st;
  try { st = fs.statSync(CFG_PATH); } catch { return { models: new Map(), sources: new Map(), list: [], srcList: [] }; }
  if (_cache.pool && st.mtimeMs === _cache.mtime) return _cache.pool;

  let cfg;
  try {
    // 这个文件带 UTF-8 BOM，直接 JSON.parse 会炸（实测踩过）
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    _cache = { mtime: st.mtimeMs, at: Date.now(), pool: { models: new Map(), sources: new Map(), list: [], srcList: [] } };
    return _cache.pool;
  }

  const srcById = new Map();
  const sources = new Map();                  // 源名（小写）→ 连接信息，供「源名/模型名」写法直取
  for (const s of Array.isArray(cfg.provider_sources) ? cfg.provider_sources : []) {
    if (!s || s.enable === false) continue;
    const type = String(s.type || '');
    if (!OPENAI_LIKE.has(type)) continue;
    const endpoint = joinUrl(s.api_base);
    if (!endpoint) continue;
    // 本机模型服务（127.0.0.1 / localhost）不需要 Key：llama.cpp / ollama / vLLM / LM Studio 都是裸 endpoint。
    // 以前这里因 key 为空把 local 源整个跳过，导致「本地模型优先」找不到本地模型。
    const isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(endpoint);
    const apiKey = pick(s.key);
    if (!apiKey && !isLocal) continue;
    const info = { endpoint, apiKey, type, provider: String(s.provider || '') };
    srcById.set(String(s.id || s.provider || ''), info);
    // 两个名字都认：源自己的 id（zhipu_source）和 provider 名（zhipu）
    for (const k of [String(s.id || ''), String(s.provider || '')]) {
      if (k) sources.set(k.toLowerCase(), info);
    }
  }

  const models = new Map();
  const list = [];
  for (const p of Array.isArray(cfg.provider) ? cfg.provider : []) {
    if (!p || p.enable === false) continue;
    const name = String(p.model || '').trim();
    if (!name) continue;
    const src = srcById.get(String(p.provider_source_id || ''));
    if (!src) continue;                       // 源没配好 / 类型不支持 → 这个模型不接
    const one = { model: name, endpoint: src.endpoint, apiKey: src.apiKey, source: src.provider, type: src.type };
    models.set(name.toLowerCase(), one);
    list.push({ model: name, source: src.provider });
  }

  const srcList = [];
  for (const [, v] of sources) {
    if (srcList.some(x => x.provider === v.provider)) continue;   // 同一个源两个名字，只列一次
    srcList.push({ name: v.provider, provider: v.provider, endpoint: v.endpoint.replace(/\/chat\/completions$/, '') });
  }

  _cache = { mtime: st.mtimeMs, at: Date.now(), pool: { models, sources, list, srcList } };
  return _cache.pool;
}

/* 模型名 → { endpoint, apiKey, source, model }；不认识就 null（调用方原样走 llm.json）。
 * 两种写法：
 *   glm-4.5-flash          → AstrBot 里已配好的模型（provider 列表里有的）
 *   deepseek/deepseek-chat → 直取某个源（只要那个源在 AstrBot 里配了 Key，没加模型条目也能用）
 * 含斜杠的模型名（如 Qwen/Qwen2.5-72B）只有当斜杠前那一段正好是源名时才按源解析，否则整体当模型名。 */
function resolve(model) {
  const name = String(model || '').trim();
  if (!name) return null;
  const p = load();
  const hit = p.models.get(name.toLowerCase());
  if (hit) return hit;
  const i = name.indexOf('/');
  if (i > 0) {
    const pre = name.slice(0, i).trim().toLowerCase();
    const rest = name.slice(i + 1).trim();
    const src = p.sources.get(pre);
    if (src && rest) {
      return { model: rest, endpoint: src.endpoint, apiKey: src.apiKey, source: src.provider, type: src.type, bySource: true };
    }
  }
  return null;
}

/* 每个模型「主擅长什么」——给面板/自检展示，不参与调用。优先读 llm.json 的 astrbotCatalog，
 * 读不到（文件坏/字段缺）就退回这份内置表，保证永远有东西可显示。 */
const MODEL_META = {
  'GLM-4.7-Flash': '最新免费，中文对话/写作综合强、响应快',
  'glm-5.3-flash': '新版免费，长文本与多轮更稳',
  'glm-4.5-flash': '稳定免费，日常陪聊与长上下文首选',
  'glm-4-flash': '轻量免费，简单问答最省',
  'glm-4-flash-250414': '轻量免费（固定版），简单问答',
  'glm-z1-flash': '数学/逻辑/推理（思考模型）',
  'glm-4v-flash': '看图说话、图片问答（免费）',
  'glm-4.1v-thinking-flash': '图片理解+推理（视觉思考）',
  'glm-4.6v-flash': '更强图片理解（免费）',
  'local-9b': '本机 9B，隐私/离线兜底',
  'deepseek/deepseek-chat': '代码与中文逻辑推理（免费）',
  'deepseek-chat': '代码与中文逻辑推理（免费）',
};
function loadMeta() {
  try {
    const cfg = require('./config/llm.json');
    const arr = cfg && cfg.llm && cfg.llm.astrbotCatalog;
    if (Array.isArray(arr)) {
      const m = {};
      for (const x of arr) if (x && x.model) m[String(x.model)] = (x.goodAt || MODEL_META[String(x.model)] || '');
      return m;
    }
  } catch {}
  return MODEL_META;
}
/* 给客户端/自检看的清单：只有模型名、来源、主擅长，没有 Key。 */
function list() {
  const meta = loadMeta();
  return load().list.map(x => ({ model: x.model, source: x.source, goodAt: meta[String(x.model)] || '' }));
}

/* AstrBot 里配好 Key、且请求格式能用的源。客户端拿它显示「可以用哪些源」。 */
function sources() {
  return load().srcList.slice();
}

/* 把路由挂到 llm 配置上。用 Object.create 保护原对象：原有字段（endpoint/apiKey/timeoutMs/
 * fallbackModels/noThinkModels…）全部原样可读，一个都不改、不删。 */
function attach(llm) {
  if (!llm || typeof llm !== 'object') return llm;
  const p = load();
  if (!p.models.size) return llm;             // AstrBot 不可用 → 原样返回，行为 0 变化
  if (typeof llm.route === 'function') return llm;  // 已经挂过，别重复包
  const wrapped = Object.create(llm);
  wrapped.route = m => resolve(m);
  wrapped.astrbotModels = p.list.slice();
  wrapped.astrbotSources = p.srcList.slice();
  // 优先级：llm.json 的 astrbotCatalog（显式声明免费模型、主擅长、参数）优先；
  // 没配 catalog 就退回 AstrBot 配置顺序。catalog 里可写「源/模型」写法（如 deepseek/deepseek-chat）
  // 直取某源的免费模型，让 workbuddy(智谱) 与 deepseek 这些已配 Key 的源也进备用链。
  let order = [];
  try {
    const cfg = require('./config/llm.json');
    const arr = cfg && cfg.llm && cfg.llm.astrbotCatalog;
    if (Array.isArray(arr) && arr.length) order = arr.map(x => x.model).filter(Boolean);
  } catch {}
  if (!order.length) order = p.list.map(x => x.model);
  if (!llm.model) wrapped.model = order[0] || '';
  if (!Array.isArray(llm.fallbackModels) || !llm.fallbackModels.length) {
    wrapped.fallbackModels = order.slice(1);
  }
  return wrapped;
}

module.exports = { resolve, list, sources, attach, joinUrl, CFG_PATH };
