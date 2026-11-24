/*
 * coord.js — 「坐标向量」选材引擎（2026-11-21 主人定；同日按真实案例重写）
 *
 * 她的话：「要做成坐标向量选取所有「信息识别」「情绪表达」里面的内容」（不是每页抓一条，是取多条）。
 *
 * 旧版为什么没用（2026-11-21 用真实案例跑出来的）：
 *   ① 分数线 0.34 低于「零相关」的基线分 —— any 情绪 0.55×0.40 + 来源 0.80×0.15 + 优先 0.80×0.10 ≈ 0.42，
 *      也就是说**任何条目什么都不用沾就能过线**，门槛等于没有；
 *   ② 「你们为什么会被警告了」靠「为什么」三个字命中了「他们为什么打架？」——虚词当相关性；
 *   ③ 案例每轮随机抖 → 同一句提示词每轮不同，不可复现；没信号也硬塞人物。
 *
 * 现在：相关性改成**硬门槛**（gate），分数只负责排序。
 *   gate：这句与条目有 ≥2 个连续实字重合（虚词组成的不算），或属于「情绪表达」且这句正是那个情绪。
 *   排分：0.55*字面 + 0.20*来源 + 0.15*情绪 + 0.10*优先 —— 只在通过 gate 的条目里排序。
 *   选择：完全确定（不再 Math.random）→ 同一句永远同样输出，可复现、可调试。
 *
 * 真源（不落第二份）：
 *   信息识别 5 页 → info-scan 读盘；情绪表达 → 情绪书（emotion-tree）+ teach/*.jsonl；
 *   词典/梗/约定 = 现读，deps 由 core 注入（避免循环依赖）。
 */
const fs = require('fs');
const path = require('path');
const infoScan = require('./info-scan');
const { isVirt, grams, lcsLen } = require('./match');   // 相关性判据只有一份（info-scan 也用同一份）

const ROOT = __dirname;

const W = { rel: 0.55, src: 0.20, emo: 0.15, pri: 0.10 };
const SRC = { master: 1.0, xuhuan: 1.0, logic: 1.0, human: 0.95, emoexpr: 0.95, teach: 0.95, star: 0.90, bad: 0.90, rule: 0.85, live: 0.80, person: 0.80 };

function emoScore(itemEmo, curEmo) {
  const a = String(itemEmo || 'any');
  const b = String(curEmo || '');
  if (a === 'any') return 0.55;
  if (b && a === b) return 1.0;
  return 0.15;
}

function priScore(p) {
  const n = Number(p) || 5;
  return Math.max(0, Math.min(1, (6 - n) / 5));
}

/* 教学库某类（游戏攻略 / 情绪表达 / 梗词句）：取最近 n 条。 */
function teachRows(dir, n) {
  try {
    const p = path.join(ROOT, 'data', 'teach', dir + '.jsonl');
    if (!fs.existsSync(p)) return [];
    const rows = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch {}
    }
    return rows.slice(-(n || 200));
  } catch { return []; }
}

/* 情绪书这一句命中的叶子：表达词 + 应对方式。只读，不改情绪书。 */
function emoTrees(text) {
  try {
    const et = require('./emotion-tree');
    const r = et.judge(text);
    if (!r || !r.best) return [];
    const out = [];
    const nodes = [];
    const seen = new Set();
    const push = n => { if (n && n.name && !seen.has(n.name)) { seen.add(n.name); nodes.push(n); } };
    push(r.best.node);
    for (const h of (r.hits || [])) push(h && h.node);
    for (const n of nodes.slice(0, 3)) {
      const self = (n.self || []).slice(0, 4);
      const other = (n.other || []).slice(0, 3);
      const rp = (function () { try { return et.repliesOf(n.name); } catch { return []; } })()
        .map(x => x && x.text).filter(Boolean).slice(0, 2);
      out.push({
        leaf: n.name,
        branch: n.branchName || '',
        core: n.core || '',
        priority: n.priority,
        self, other, replies: rp,
      });
    }
    return out;
  } catch { return []; }
}

/* ===== 自动发现（她：「以后的所有新增内容也都进」）=====
 * ① src/data/*.json 里带 emotionLink / readLink 的识别树（groups + items[phrase,meaning]）
 * ② src/data/teach/*.jsonl 全部分类
 * info-scan 的 SPECS 加一项 → collect 遍历 KEYS 自动带上；情绪叶/人物/约定/星标本来就实时读。 */
function discoverTrees(emo) {
  const out = [];
  const known = new Set(Object.keys(infoScan.SPECS).map(k => (infoScan.SPECS[k] || {}).file));
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, 'data')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    if (known.has(f)) continue;
    if (f.indexOf('.bak') >= 0) continue;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch { continue; }
    if (!j || !Array.isArray(j.groups)) continue;
    if (!('emotionLink' in j) && !('readLink' in j)) continue;
    const label = String(j.title || j.name || f.replace(/\.json$/, ''));
    for (const g of j.groups) {
      const ge = String(g.emotion || 'any');
      if (ge !== 'any' && !(emo && ge === emo)) continue;
      for (const it of (g.items || [])) {
        if (!it || !it.phrase || !it.meaning) continue;
        out.push({
          src: 'rule', label,
          text: '「' + String(it.phrase).slice(0, 40) + '」→ ' + String(it.meaning).slice(0, 70),
          m: it.phrase + ' ' + it.meaning,
          emo: ge, pri: 5,
        });
      }
    }
  }
  return out;
}

/* 教学库所有分类（以后新建 .jsonl 也自动进）。 */
function teachAll() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, 'data', 'teach')).filter(f => f.endsWith('.jsonl')); } catch { return out; }
  for (const f of files) {
    const dir = f.replace(/\.jsonl$/, '');
    for (const r of teachRows(dir, 120)) {
      const when = Array.isArray(r.when) ? r.when.join(' / ') : String(r.when || '');
      const body = String(r.say || r.text || '').slice(0, 80);
      if (!body) continue;
      out.push({
        src: 'teach', label: '教过·' + dir,
        text: (when ? '碰到「' + String(when).slice(0, 24) + '」：' : '') + body,
        m: when + ' ' + body,
        emo: 'any', pri: 3,
      });
    }
  }
  return out;
}

/* 星标池（chat-stars.json）本体。 */
function starPool(n) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'chat-stars.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : [];
    return arr.slice(-(n || 200));
  } catch { return []; }
}

/* 收集全部候选。每项带 m = 拿来做相关性判断的原串（不是带标签的展示串）。 */
function collect(text, emo, deps) {
  const C = [];
  const add = x => { if (x && x.text && String(x.text).trim()) C.push(x); };

  // ⓪ 主人例句（2026-11-22 主人定：比星标高一级）。学的是「劲」，不是照抄句子。
  // 只取带对话关系的问答对，pri=1（最高），src=master（最高）。
  try {
    const mx = require('./master-examples').list();
    // 括号里的「（可怜的颜文字）」要换成对应颜文字，不是删（主人 2026-11-22）
    const mxMod = require('./master-examples');
    const clean = v => mxMod.renderText(v);
    for (const x of (mx || []).slice(-8)) {
      if (!x || !x.q || !x.a) continue;
      add({
        src: 'master', label: '主人例句（学劲，不照抄）',
        text: '「' + clean(x.q).slice(0, 40) + '」→ 主人会这样回：「' + clean(x.a).slice(0, 80) + '」',
        m: String(x.q) + ' ' + String(x.a) + ' ' + String(x.why || ''),
        emo: 'any', pri: 1,
      });
    }
  } catch {}

  // ⓪-1 虚幻逻辑（2026-11-22）：规范，不是句子。撩人 / 让人幸福 / 让对方觉得自己重要。
  try {
    const xl = require('./data/xuhuan-logic.json');
    for (const x of (xl || [])) {
      if (!x || !x.rule) continue;
      add({
        src: 'xuhuan', label: '虚幻逻辑（规范）',
        text: x.rule + (x.why ? '（' + x.why + '）' : ''),
        m: x.rule + ' ' + (x.why || ''), emo: 'any', pri: 1,
      });
    }
  } catch {}

  // ⓪-2 人类逻辑（2026-11-22 主人定）：同类场景真人怎么说的。
  // 只给「口气参考」，不当规范；规范在主人例句的 why 里。
  try {
    const hv = require('./human-voice');
    for (const x of hv.pickByText(text, 3)) {
      add({
        src: 'human', label: '人类逻辑·真人这么说',
        text: x.a, m: (x.q || '') + ' ' + x.a, emo: 'any', pri: 2,
      });
    }
  } catch {}

  // ① 信息识别 5 页的规则（含逻辑自己）+ 各页星标样本
  const seenStar = new Set();
  for (const k of infoScan.KEYS) {
    const label = (infoScan.SPECS[k] || {}).label || k;
    for (const r of infoScan.rulesOf(k, emo)) {
      add({
        src: k === 'logic' ? 'logic' : 'rule',
        key: k, label,
        text: '「' + String(r.phrase).slice(0, 40) + '」→ ' + String(r.meaning).slice(0, 70),
        m: r.phrase + ' ' + r.meaning,
        emo: r.emotion, pri: 5,
      });
    }
    for (const s of infoScan.starsOf(k, 40)) {
      const tx = String(s.text || '').replace(/@\d{5,12}\s*/g, '').replace(/\s+/g, ' ').slice(0, 70);
      if (!tx || seenStar.has(tx)) continue;
      seenStar.add(tx);
      add({ src: 'star', key: k, label: label + '·做对过', text: tx, m: tx, emo: 'any', pri: 3 });
    }
  }
  // ② 星标池本体，只取「虚幻自己说的话」（她：星标里的那些虚幻的话，证明她这几方面到位了）
  for (const s of starPool(200)) {
    if (String(s.nick || '') !== '虚幻') continue;
    const tx = String(s.text || '').replace(/@\d{5,12}\s*/g, '').replace(/\s+/g, ' ').slice(0, 70);
    if (!tx || tx.length < 4 || seenStar.has(tx) || /^\[图片\]$/.test(tx)) continue;
    seenStar.add(tx);
    add({ src: 'star', label: '案例·被星标过', text: tx, m: tx, emo: 'any', pri: 3 });
  }

  // ③ 情绪书：这句命中的叶子 —— 每叶只带 1 条，优先「怎么应对」，没有就「她该怎么说」。
  // 「别人这样是」是识别别人情绪用的，这句情绪已经判出来了，再带一遍是重复占位（真实案例里跑出过两条几乎同义）。
  for (const n of emoTrees(text)) {
    const tag = '情绪·' + (n.branch ? n.branch + '·' : '') + n.leaf;
    if (n.replies.length) {
      add({ src: 'emoexpr', label: tag + '·怎么应对', text: n.replies.join(' / ').slice(0, 90), m: n.leaf + ' ' + n.replies.join(' '), emo: n.core, pri: n.priority });
    } else if (n.self.length) {
      add({ src: 'emoexpr', label: tag + '·她会这样说', text: '这种情绪你会这样说：' + n.self.join(' / '), m: n.leaf + ' ' + n.self.join(' '), emo: n.core, pri: n.priority });
    }
  }

  // ④ 教学库全部类目 + ④-2 以后新建的识别树（自动发现）
  for (const c of teachAll()) add(c);
  for (const c of discoverTrees(emo)) add(c);

  // ⑤ 现读：词典 / 梗 / 约定（命中才算）
  try {
    const hits = infoScan.liveHits('logic', text, deps) || [];
    for (const h of hits) add({ src: 'live', label: '现读', text: String(h).slice(0, 90), m: String(h), emo: 'any', pri: 4 });
  } catch {}

  return C;
}

/* 门槛：这条和这句话到底有没有关系。没关系就不进，分数再高也不进。 */
function gateOk(c, L, emo, cur) {
  if (c.src === 'person') {
    if (c.casual) return false;                                  // 随手带的，只留作「池子空时补一条」
    return !!(c.hitWord && String(cur).indexOf(String(c.hitWord)) >= 0);
  }
  if (L >= 2) return true;                                       // 有 ≥2 个连续实字重合 → 相关
  // 情绪表达：这句正是这个情绪 → 天然映射，不靠字面也进（这是「情绪表达」维度的本意）
  if (c.src === 'emoexpr' && c.emo && c.emo !== 'any' && String(emo || '') === String(c.emo)) return true;
  return false;
}

/* 选。返回 { lines, coords, picked }。
 * opt.budget 字数预算（默认 1100）；opt.extra 外部候选（人物 / 负例）。 */
function pick(text, emo, deps, opt) {
  const o = Object.assign({ budget: 1100, extra: null }, opt || {});
  const cur = String(text || '');
  const C = collect(cur, emo, deps);
  if (Array.isArray(o.extra)) {
    for (const x of o.extra) {
      if (!x || !x.text) continue;
      C.push(Object.assign({}, x, { m: x.m || x.hitWord || x.text }));
    }
  }

  const pass = [];
  const casual = [];
  for (const c of C) {
    c.L = lcsLen(c.m || c.text, cur);
    const rel = Math.min(1, c.L / 5);
    const eW = emoScore(c.emo, emo);
    const sW = SRC[c.src] != null ? SRC[c.src] : 0.8;
    const pW = priScore(c.pri);
    c.score = W.rel * rel + W.src * sW + W.emo * eW + W.pri * pW;
    c.parts = { rel, src: sW, emo: eW, pri: pW, L: c.L };
    if (c.casual) { casual.push(c); continue; }
    if (!gateOk(c, c.L, emo, cur)) continue;
    // 案例跟这句话几乎一模一样 → 学不到东西，白占字（真实案例：把她自己的话当输入时 6/6 自己命中自己）
    if (cur.length >= 8 && c.text && (c.text.indexOf(cur) >= 0 || cur.indexOf(c.text) >= 0)) continue;
    pass.push(c);
  }

  pass.sort((a, b) => b.score - a.score || String(a.text).length - String(b.text).length);

  const CAP = { star: 1, bad: 1, person: 2, emoexpr: 2 };
  const perSrc = {};
  const picked = [];
  let used = 0;
  for (const c of pass) {
    const cap = CAP[c.src] != null ? CAP[c.src] : 99;
    if ((perSrc[c.src] || 0) >= cap) continue;
    if (used + c.text.length > o.budget) continue;
    picked.push(c);
    perSrc[c.src] = (perSrc[c.src] || 0) + 1;
    used += c.text.length;
    if (used >= o.budget * 0.95) break;
  }
  // 池子空着（这句没有任何可识别的东西）→ 才考虑「偶尔想起记过的人」那一条，不跟相关内容抢位。
  if (!picked.length && casual.length && used + casual[0].text.length <= o.budget) {
    picked.push(casual[0]);
    perSrc.person = 1;
    used += casual[0].text.length;
  }

  const lines = picked.map(c => '- [' + c.label + '] ' + c.text);
  return {
    coords: { emo: String(emo || ''), pool: C.length, passed: pass.length, used, picked: picked.length, src: perSrc },
    picked,
    lines,
  };
}

module.exports = { pick, collect, grams, lcsLen, isVirt, W, SRC };
