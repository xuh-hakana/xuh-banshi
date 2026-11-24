/* ===========================================================================
 * selfpost.js — 虚幻自己发出去的动态（2026-11-17 主人令）
 *
 * 她要什么（原话）：「虚幻自己发的QQ空间、b站动态都要在面板留记录。我好去查看她收到了
 *   什么提示词和进行了什么思考。」
 *
 * 所以每条记四样，缺一样就等于没记：
 *   ① 发出去的正文 + 平台 + 时间 + 平台的 tid（能对回空间里那一条）
 *   ② **发给模型的整组提示词**（system + user 原文，一条不裁）
 *   ③ 模型自己给的思考原文（`reasoning_content`）。模型没给就写空 + note 说明「这次没给」，
 *      绝不编一段心路 —— 和 trace.js 同一条规矩。
 *   ④ 用的哪个模型、花了多久、成没成
 *
 * 存哪：src/data/自主动态.jsonl，append-only，只加不改（老记录不覆盖）。
 * 谁写：core 生成完 → connector 发成功 → 调这里 add()。谁读：panel.js 的 /api/selfposts。
 *
 * B站动态（插件发的）目前**没有提示词来源**：AstrBot 插件不落 prompt（2026-11-17 实测）。
 * 那种记录只写内容和 note 说明出处，不假装有提示词 —— 要提示词得先给插件加存档钩子。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', '自主动态.jsonl');

function newId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36);
}

/* rec = { plat:'qzone'|'bili', kind:'post'|'repost'|'dynamic', text, tid, link,
 *         prompt:[{role,content}], think, model, ms, ok, err, note, from } */
function add(rec) {
  const r = rec || {};
  const row = {
    id: r.id || newId(),
    t: r.t || new Date().toISOString(),
    plat: String(r.plat || ''),
    kind: String(r.kind || 'post'),
    text: String(r.text || ''),
    tid: String(r.tid || ''),
    link: String(r.link || ''),
    prompt: Array.isArray(r.prompt) ? r.prompt.map(m => ({ role: String((m && m.role) || ''), content: (m && m.content) || '' })) : [],
    think: String(r.think || ''),
    model: String(r.model || ''),
    ms: Number(r.ms || 0),
    ok: r.ok !== false,
    err: String(r.err || ''),
    note: String(r.note || ''),
    from: String(r.from || ''),
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) { console.error('[自主动态] 存不进去：' + e.message); }
  return row;
}

function all() {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.id) out.push(j); } catch {}
  }
  return out;
}

/* 新的在前。plat 空 = 全部平台。 */
function recent(n, plat) {
  let list = all();
  if (plat) list = list.filter(x => String(x.plat) === String(plat));
  list.reverse();
  return list.slice(0, Math.max(1, Number(n) || 60));
}

function get(id) {
  return all().filter(x => String(x.id) === String(id))[0] || null;
}

module.exports = { FILE, add, all, recent, get };
