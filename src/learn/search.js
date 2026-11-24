/*
 * src/learn/search.js —— 混合检索的算分（纯函数，不读盘、不写盘）
 *
 * 这是干什么的：给每人知识库（kb.js）和冷层（acts.js）共用一套打分。
 * 为什么要两路：中文不用分词，纯字面会漏同义说法；纯向量又吃不到专名。
 *
 * 两路分数 → RRF 融合（倒数排名融合）：只比「排名第几」，不比原始分量纲，
 * 比加权求和稳（加权求和要先归一化，归一化一变权重全歪）。
 *
 * 向量从哪来：embed() 默认读 localhost Ollama；没装就返回 null，
 * 这时只剩字面一路照样能用。装完 Ollama 不用改调用方，只改配置。
 */
const http = require('http');

/* ---------- 切词：中文按字、英文数字按词 ---------- */
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const re = /[\u4e00-\u9fa5]+|[a-z0-9]+/g;
  let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    if (/^[a-z0-9]+$/.test(w)) { out.push(w); continue; }
    if (w.length === 1) { out.push(w); continue; }
    for (let i = 0; i < w.length - 1; i += 1) out.push(w.slice(i, i + 2));   // 二元组
  }
  return out;
}

/* ---------- 关键词一路：BM25-lite ---------- */
// 每个查询词按「出现它的文档数」给权重：到处都有的词不算线索
function bm25(docs, q, opts) {
  const k1 = (opts && opts.k1) || 1.2;
  const b = (opts && opts.b) || 0.75;
  const qs = [...new Set(tokens(q))];
  if (!qs.length || !docs.length) return docs.map(() => 0);
  const toks = docs.map(d => tokens(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / toks.length || 1;
  const df = {};
  qs.forEach(t => { df[t] = toks.filter(x => x.includes(t)).length; });
  const N = docs.length;
  return docs.map((_, i) => {
    const tf = {};
    toks[i].forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    let sc = 0;
    qs.forEach(t => {
      const f = tf[t] || 0;
      if (!f) return;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      sc += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks[i].length / avg));
    });
    return sc;
  });
}

/* ---------- 向量一路（装 Ollama 才有值） ---------- */
const EMB = { base: 'http://127.0.0.1:11434', model: 'nomic-embed-text', off: 0 };
const net = require('net');

// 先探端口再发请求：没装 Ollama 时 HTTP 要等 1.2 秒超时才失败，
// 而这个函数挂在每轮回复的路径上——200 毫秒探不到就直接放弃，别拖慢聊天。
function probe() {
  return new Promise(resolve => {
    let done = false;
    const fin = ok => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(ok); };
    const s = net.connect({ host: '127.0.0.1', port: 11434 });
    s.setTimeout(200, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}

// 失败后冷却：一开始 60 秒，连续失败就 5 分钟，别每轮都去探一次
function embed(text) {
  return new Promise(async resolve => {
    if (Date.now() < EMB.off) return resolve(null);
    if (!(await probe())) { EMB.off = Date.now() + 300000; return resolve(null); }
    const body = JSON.stringify({ model: EMB.model, prompt: String(text || '').slice(0, 2000) });
    const req = http.request({
      host: '127.0.0.1', port: 11434, path: '/api/embeddings', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const v = j.embedding || (j.embeddings && j.embeddings[0]);
          if (Array.isArray(v) && v.length) return resolve(v);
        } catch (e) { /* 落到下面的 null */ }
        EMB.off = Date.now() + 60000;
        resolve(null);
      });
    });
    req.setTimeout(1500, () => { req.destroy(); });
    req.on('error', () => { EMB.off = Date.now() + 60000; resolve(null); });
    req.write(body);
    req.end();
  });
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/* ---------- 融合：RRF ---------- */
// 两路各排一次名，名次越靠前加越多；k 取 60 是 RRF 的常用值（压住头部差距）
function rrf(lists, k) {
  const K = Number(k) || 60;
  const acc = {};
  lists.forEach(list => {
    list.forEach((idx, rank) => { acc[idx] = (acc[idx] || 0) + 1 / (K + rank + 1); });
  });
  return Object.keys(acc).map(i => ({ i: Number(i), score: acc[i] }))
    .sort((a, b) => b.score - a.score);
}

function rankIdx(scores, floor) {
  return scores.map((s, i) => ({ i, s }))
    .filter(x => x.s > (floor || 0))
    .sort((a, b) => b.s - a.s)
    .map(x => x.i);
}

/* ---------- 对外：一次检索 ---------- */
/* docs: [{text, vec?}]；返回 [{i, score, how}]
 * 没装 Ollama（拿不到向量）时只走关键词，结果里 how='kw'，调用方据此说明可信度。 */
async function search(docs, q, opts) {
  const o = opts || {};
  const kw = bm25(docs, q, o);
  const kwIdx = rankIdx(kw, 0);
  const qv = o.useVec === false ? null : await embed(q);
  if (!qv || !docs.some(d => d.vec)) {
    return kwIdx.slice(0, o.n || 5).map(i => ({ i, score: kw[i], how: 'kw' }));
  }
  const vecScores = docs.map(d => cosine(qv, d.vec));
  const vecIdx = rankIdx(vecScores, 0.2);
  const fused = rrf([kwIdx, vecIdx], o.rrfK);
  return fused.slice(0, o.n || 5).map(x => ({ i: x.i, score: x.score, how: 'rrf' }));
}

function conf() { return { base: EMB.base, model: EMB.model, cooling: Date.now() < EMB.off }; }
function setModel(m) { if (m) EMB.model = String(m); }

module.exports = { tokens, bm25, cosine, rrf, embed, search, conf, setModel };
