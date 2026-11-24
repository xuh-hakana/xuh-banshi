'use strict';
/*
 * llm.js —— 视频工坊的文案/分镜大脑（OpenAI 兼容 chat/completions）
 * key 与 base 全部来自 keys.js（AstrBot 那份），不写第二套配置。
 */
const keys = require('./keys');

const DEFAULT_BASE = {
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimaxi.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  modelscope: 'https://api-inference.modelscope.cn/v1',
};

const DEFAULT_MODEL = {
  deepseek: 'deepseek-chat',
  moonshot: 'moonshot-v1-8k',
  zhipu: 'glm-4-flash',
  minimax: 'MiniMax-Text-01',
  modelscope: 'Qwen/Qwen2.5-72B-Instruct',
};

function resolve(provider) {
  const p = String(provider || 'deepseek');
  const base = (keys.base(p) || DEFAULT_BASE[p] || '').replace(/\/+$/, '');
  return { provider: p, base, key: keys.get(p), model: DEFAULT_MODEL[p] || '' };
}

async function chat({ provider, model, messages, temperature = 0.7, maxTokens = 2000, timeoutMs = 60000 }) {
  const r = resolve(provider);
  if (!r.key) throw new Error('没有可用 key：' + r.provider);
  if (!r.base) throw new Error('不知道 ' + r.provider + ' 的 base_url（media.json.keys 里写 base）');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(r.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.key },
      body: JSON.stringify({ model: model || r.model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(r.provider + ' HTTP ' + res.status + ' ' + txt.slice(0, 300));
    const j = JSON.parse(txt);
    const c = j.choices && j.choices[0];
    return (c && c.message && c.message.content) || '';
  } finally { clearTimeout(t); }
}

/** 从可能带 ```json 围栏的回答里抠 JSON */
function extractJson(text) {
  const s = String(text || '');
  const fenced = /\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const i = body.indexOf('{'), k = body.lastIndexOf('}');
  if (i < 0 || k <= i) throw new Error('LLM 没返回 JSON');
  return JSON.parse(body.slice(i, k + 1));
}

module.exports = { chat, extractJson, resolve };
