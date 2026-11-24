/*
 * src/trace.js — 每条发言的「推理过程」（可观测的决策轨迹）
 *
 * 这是干什么的：把这一轮代码实际做过的事，按一条发言一条记下来，客户端点「推理」能看原文。
 *
 * 必须说清的边界（不许含糊）：
 *   - glm-4.5-flash 默认关思考（llm.noThinkModels），模型**不给** reasoning_content。
 *     所以这里不是「模型心里怎么想」，是「代码为什么把这句话发出去」：命中场合、注入了哪些段、
 *     用了哪个模型、耗时、检索命中、最终输出。全是代码里真实发生、可逐条核对的事实。
 *   - 模型真给了思考原文（手动点「让她下一轮想给我看」）时，原样存在 reason 字段，一个字不改。
 *     没给就留空，并在 note 里写明「这个模型默认没开思考」，绝不编一段心路。
 *   - 和 data/thinking.jsonl 分工：那份只留最近 5 条模型思考原文（老功能不动）；
 *     这份是每轮都记的决策轨迹，按天分文件（越积越多也不会撑爆单个文件）。
 *
 * 存储：data/推理/YYYY-MM-DD.jsonl，append-only，只加不改。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const TRACE_DIR = path.join(ROOT, 'data', '推理');

/* 按**本地日期**切文件，不用 ISO 的 UTC 前 10 位：
 * 本机 UTC+8，凌晨 0–8 点的发言在 UTC 还是「昨天」，会和 memory.js 的按天日志差一天。
 * t 字段本身仍存完整 ISO（带时区），前端 fmtTime 会按本地时间显示。 */
function dayOf(t) {
  const d = t ? new Date(t) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const ensure = () => { try { fs.mkdirSync(TRACE_DIR, { recursive: true }); } catch {} };

/* 记一条。item 里全是代码给的事实，不要传任何推测值。 */
function record(item) {
  try {
    ensure();
    const o = Object.assign({ t: new Date().toISOString() }, item || {});
    // 防止把整份提示词塞进去：只留段标题和字数，要看全文去文件页翻对应的人设文件
    o.blocks = (o.blocks || []).slice(0, 40);
    const p = path.join(TRACE_DIR, dayOf(o.t) + '.jsonl');
    fs.appendFileSync(p, JSON.stringify(o) + '\n', 'utf8');
    return { ok: true, day: dayOf(o.t) };
  } catch (e) { return { error: e.message }; }
}

/* 按回复原文找这一轮的轨迹；同一句重复发过就取最近的一条。 */
function findByReply(text, t) {
  try {
    const want = String(text || '').trim();
    if (!want) return null;
    // 聊天记录里的正文可能比发出时多了换行/空格（合并、图片标记），先精确、再去空白兜底。
    const norm = s => String(s || '').replace(/\s+/g, '').trim();
    const exact = [], loose = [];
    const days = fs.readdirSync(TRACE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse().slice(0, 7);
    for (const f of days) {
      for (const ln of fs.readFileSync(path.join(TRACE_DIR, f), 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        try {
          const o = JSON.parse(ln);
          const got = String(o.out || '').trim();
          if (got === want) exact.push(o);
          else if (norm(got) && norm(got) === norm(want)) loose.push(o);
        } catch {}
      }
      if (exact.length) break;               // 最近那天有精确命中就够，不往下翻
    }
    const out = exact.length ? exact : loose;
    if (!out.length) return null;
    if (t) {
      const ts = Date.parse(t);
      if (!isNaN(ts)) {
        const near = out.slice().sort((a, b) => Math.abs(Date.parse(a.t) - ts) - Math.abs(Date.parse(b.t) - ts));
        return near[0];
      }
    }
    return out[out.length - 1];
  } catch { return null; }
}

function listDays() {
  try {
    return fs.readdirSync(TRACE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => f.slice(0, -6)).sort().reverse();
  } catch { return []; }
}

module.exports = { TRACE_DIR, record, findByReply, listDays };
