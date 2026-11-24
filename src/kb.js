'use strict';
/*
 * kb.js —— 「别人教的」一个入口：检索 / 单条核实 / 单条删除。
 *
 * 主人 2026-11-13 原话：
 *   「所有别人教的类内容，都能被虚幻检索（检索人物，关键词指向全部/单条，时间，
 *     并能查看是否由我手动/联网核实过），因此只需要强制虚幻每轮检索别人的话
 *     （大于等于4字时）即可，而不是每轮全喂。」
 *
 * 数据仍在原处，不建平行总表、不复制内容：
 *   游戏攻略  data/guides/*.md 的 ## 小节（文件头 <!-- by:… --> 就是署名）
 *   学到的事  data/guides/学到的（…）.md 的 ## 小节（> 时间 / > 来源 / 核实状态）
 *   教学条    data/teach/*.jsonl（teach.js 的 listAll，review.locked = 我核实过）
 *
 * 两条路：
 *   retrieve(text, {k, scope})  ← 机器人每轮用（≥4 字才跑），只回命中的几条，给提示词；
 *   search({…})                 ← 客户端用（人物 / 关键词 / 时间 / 全部或单条 / 核实状态）。
 *
 * 核实状态只有三种：'' 未核实、manual 我手动核实、web 联网核实。
 * 手动核实 = 在那一节标题下写一行 `> 核实：主人手动 YYYY-MM-DD`（教学条 = 确认并锁定）。
 * 删除 = 真删那一节（教学条真删那一条），客户端点两下确认。
 */
const fs = require('fs');
const path = require('path');
const guides = require('./guides');
const teach = require('./teach');

const DIR = path.join(__dirname, 'data', 'guides');
const LEARN_FILE = /^学到的（.+）\.md$/;
/* 「人设条」「可用知识」这两份 md 各成独立的一格，由 specItems() 单独产条目。
   主循环跳过它们，免得同一条又在「游戏攻略」格里出现一次（不建双份）。
   主人 2026-11-13：人设条只记别人 / 角色的人设素材（认识人、分辨人、积累画像素材），
   不记虚幻自己的人设；教学条只存可用知识，梗应对归「梗词句 / 约定·说话方式」。 */
const PERSONA_FILE = '人设素材.md';
const KNOWLEDGE_FILE = '可用知识.md';
const SPECIAL_FILES = [PERSONA_FILE, KNOWLEDGE_FILE];
const TOPICS_FILE = path.join(__dirname, 'data', 'topics.jsonl');
/* 功能词典：只有这一份，不建平行文件。人设注入会剥掉 HTML 注释，
   注释里的详解平时不占 token，只在本地检索命中功能名时给（见 dictHits）。 */
const DICT_FILE = path.join(__dirname, 'soul', 'F-全场景通用主人设', '功能词典.md');
const HEAD = /^##\s+/;
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const writeAtomic = (file, data) => {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
};
const norm = s => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');
function mtimeOf(file) { try { return fs.statSync(path.join(DIR, file)).mtimeMs; } catch { return 0; } }

/* 按 ## 切小节，返回行数组和每节的行范围（删除 / 加核实行都按行改，正文原样不动）。 */
function splitSections(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (HEAD.test(lines[i])) heads.push(i);
  const sections = heads.map((start, h) => {
    const end = h + 1 < heads.length ? heads[h + 1] : lines.length;
    return {
      idx: h,
      start,
      end,
      line: start + 1,
      title: lines[start].replace(HEAD, '').trim(),
      body: lines.slice(start + 1, end).join('\n').trim(),
    };
  });
  return { lines, sections };
}

/* 小节里的元信息：时间 / 来源 / 核实 / 分类。 */
function metaOf(body) {
  const one = re => (String(body || '').match(re) || [])[1] || '';
  const time = one(/^>\s*时间[:：]\s*(.+)$/m).trim();
  const src = one(/^>\s*来源[:：]\s*(.+)$/m).trim();
  const ver = one(/^>\s*核实[:：]\s*(.+)$/m).trim();
  const dir = one(/^>\s*分类[:：]\s*(.+)$/m).trim();
  const st = one(/核实状态[:：]\s*(已核实|未核实)/);
  let verified = '';
  if (ver) verified = /联网/.test(ver) ? 'web' : (/手动|主人/.test(ver) ? 'manual' : '');
  if (!verified && st) verified = st === '已核实' ? 'web' : '';
  return { time, src, ver, verified, dir };
}
/* 「2026-11-09 05:12」是本地时间（落盘时就用本地时钟），转 ISO 存，显示再转回来。 */
function isoOf(text) {
  const m = String(text || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
/* 学到的事：「来源：非神 口述」→ 非神；联网那份 → 联网。 */
function whoOfLearn(src) {
  const s = String(src || '');
  const m = s.match(/^(.+?)\s*(?:口述|说|教)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function fileHeader(raw) {
  const m = String(raw || '').match(/<!--\s*by:([^>]*?)\s*-->/i);
  return m ? String(m[1]).trim() : '';
}

/* 所有条目（客户端列表 / 检索共用）。 */
function items() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.md')); } catch { files = []; }
  for (const f of files) {
    if (SPECIAL_FILES.indexOf(f) >= 0) continue;
    const raw = read(path.join(DIR, f));
    const learn = LEARN_FILE.test(f);
    const by = fileHeader(raw);
    const scope = learn ? (f.match(/^学到的（(.+)）\.md$/) || [])[1] || '' : '攻略';
    const { sections } = splitSections(raw);
    for (const s of sections) {
      if (!s.title || !s.body) continue;
      const m = metaOf(s.body);
      // 学到的那几份每节标题都是「有人教了我一件事 / 查到：X」，真正的内容在正文第一行。
      // 卡片上拿第一行当标题更好认（原标题留着做 kind 说明没用）。
      const firstLine = learn ? String(s.body.split('\n').find(l => l.trim() && !/^>/.test(l.trim())) || '').trim() : '';
      // 三类（主人 2026-11-13 定）：游戏攻略 / 情绪表达 / 梗词句。
      // 有「> 分类：」就照它；没有就按文件身份 + 内容判（梗词句.md 整体是梗词句，攻略文件整体是游戏攻略）。
      const topic = (teach.DIRS.indexOf(m.dir) >= 0) ? m.dir
        : (/^梗词句/.test(f) ? '梗词句'
          : (learn ? teach.guessDir(s.title + ' ' + s.body) : '游戏攻略'));
      out.push({
        id: 'md:' + f + ':' + s.idx,
        kind: learn ? 'learn' : 'guide',
        kindName: learn ? '学到的' : '游戏攻略',
        topic,
        path: 'data/guides/' + f,
        file: f,
        idx: s.idx,
        line: s.line,
        title: (firstLine || s.title).slice(0, 40),
        body: s.body,
        time: isoOf(m.time) || new Date(mtimeOf(f) || Date.now()).toISOString(),
        timeText: m.time || '',
        whoKey: learn ? '' : by,
        whoName: learn ? (whoOfLearn(m.src) || (m.verified === 'web' ? '联网' : '未署名')) : '',
        source: m.src,
        scope,
        verified: m.verified,
        say: '',
      });
    }
  }
  // 约定里打了 dir 的「碰到 X 就回 Y」：数据仍在 topics.jsonl，梗词句 / 约定页照常显示。
  // 前端「教学条」格子把它们筛掉（只搬不删，数据一行不动）。
  for (const x of teach.listAll()) {
    /* 约定本体不列进教学条（2026-11-19 主人原话「这个不是教学」）：
     * 它的数据在 topics.jsonl，列在这里删不掉——前端把格子拿掉、刷新又回来，
     * 看着像「面板删了后端没同步」。约定只在「约定」页出现；
     * 约定同步出来的梗词句副本是 teach 文件里的真数据，照常在这列出、能删。 */
    if (x.fromPact) continue;
    if (!x.say && !x.text) continue;
    const st = x.review && x.review.state;
    out.push({
      id: String(x.id),
      kind: 'teach',
      kindName: '教学',
      topic: (teach.DIRS.indexOf(String(x.dir || '')) >= 0 ? String(x.dir) : '梗词句'),
      file: '',
      idx: -1,
      line: 0,
      title: String(x.say || x.text || '').slice(0, 40),
      body: String(x.text || ''),
      time: (() => { const d = new Date(x.t || 0); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); })(),
      timeText: '',
      whoKey: String(x.qq || ''),
      whoName: '',           // 交给 decorate 按人翻成「主人（QQ …）」这种写法，跟面板一致
      nick: String(x.nick || ''),
      source: String(x.scope || ''),
      scope: String(x.scope || ''),
      verified: st === 'locked' ? 'manual' : (x.verified === 'web' ? 'web' : ''),
      say: String(x.say || ''),
      dir: String(x.dir || ''),
      locked: st === 'locked',
      fromPact: !!x.fromPact,
    });
  }
  // 人设条（别人 / 角色的人设素材）与可用知识（教学条）各成独立一格。
  for (const x of specItems(PERSONA_FILE, 'persona', '人设条', '人设素材')) out.push(x);
  for (const x of specItems(KNOWLEDGE_FILE, 'teach', '可用知识', '可用知识')) out.push(x);
  /* ⑥ 身份认知约定（「你是猫娘」类）在人设条里也看得见（主人 2026-11-13）：
   * 正本仍是 topics.jsonl 的 kind=promise / section=身份认知，这里只合成一条**展示**条目，
   * 不复制第二份数据；改内容仍走约定页。同一份数据两处可见。 */
  for (const line of read(TOPICS_FILE).split('\n')) {
    let x = null;
    try { x = JSON.parse(line); } catch { continue; }
    if (!x || x.kind !== 'promise' || String(x.section || '') !== '身份认知') continue;
    const t = new Date(x.t || x.at || 0);
    out.push({
      id: 'pact-persona:' + String(x.id || ''),
      kind: 'persona', kindName: '人设条', topic: '人设素材',
      path: 'data/topics.jsonl', file: '', idx: -1, line: 0,
      title: String(x.say || x.text || '').slice(0, 40),
      body: String(x.text || ''),
      time: Number.isNaN(t.getTime()) ? '' : t.toISOString(),
      timeText: '', whoKey: String(x.qq || ''), whoName: '',
      source: String(x.scope || ''), scope: String(x.scope || ''),
      verified: (x.review && x.review.state) === 'locked' ? 'manual' : '',
      say: '', fromPact: true,
    });
  }
  return out;
}

/* ===== 人设条 / 可用知识（主人 2026-11-13 改口径）=====
 * 她原话：「人设条应该只用来认识、分辨不同人的人设，积累素材，而不是自己的人设」；
 *        「教学条现在存的梗应对，存错了…里面应该存可用知识」。
 * 所以：人设条只读 data/guides/人设素材.md —— 每条是「谁、在哪、发过什么人设」，
 *   署群友的名，用来给分析群友画像积累素材；虚幻自己的人设（soul/F-全场景通用主人设/*.md）不再进这一格。
 *   可用知识读 data/guides/可用知识.md —— 一条能拿来用的事实 / 原理，带署名与场合。
 *   两份都按 md 的 ## 小节存，id 沿用 md:<文件>:<序号>：
 *   核实 / 单条删除 / 改内容 / 搬归属 / 看原文 全部复用现成那套，不新增接口、不建双份。
 * 「碰到 X 就回 Y」的梗应对不在这里：它们留在 topics.jsonl 的约定里，
 *   按「梗词句 / 约定 · 说话方式」展示，教学条不再重复列出（只搬不删，数据一行不动）。 */
const SPEC_META = /^>\s*(时间|来源|核实|分类|署名|场合|标签)[:：]/;
function specLine(body, key) {
  const m = String(body || '').match(new RegExp('^>\\s*' + key + '[:：]\\s*(.*)$', 'm'));
  return m ? m[1].trim() : '';
}
function specItems(file, kind, kindName, topic) {
  const raw = read(path.join(DIR, file));
  if (!raw) return [];
  const one = (body, key) => specLine(body, key);
  const out = [];
  for (const s of splitSections(raw).sections) {
    if (!s.title) continue;
    const meta = metaOf(s.body);
    const who = one(s.body, '署名');
    const place = one(s.body, '场合');
    const tags = one(s.body, '标签');
    // 正文 = 去掉 > 元信息行后剩下的部分；留空时给一句占位，方便主人在面板里往末尾放长文
    const body = s.body.split('\n').filter(l => !SPEC_META.test(l.trim())).join('\n').trim()
      || '（正文留空，主人在「改内容」里把原文放到末尾）';
    out.push({
      id: 'md:' + file + ':' + s.idx,
      kind, kindName, topic,
      path: 'data/guides/' + file,
      file, idx: s.idx, line: s.line,
      title: s.title.slice(0, 60),
      body,
      time: isoOf(meta.time) || new Date(mtimeOf(file) || Date.now()).toISOString(),
      timeText: meta.time || '',
      whoKey: who,
      whoName: '',                       // 交给 decorate 按人物表翻
      source: meta.src || place,
      scope: place,
      verified: meta.verified,
      say: '',
      tags,
      dir: topic,
      persona: kind === 'persona',
      locked: false,
      fromPact: false,
    });
  }
  return out;
}

/* 名称在客户端补（这里不 require people，避免循环依赖：kb ← guides ← people）。 */
function decorate(list) {
  let people = null;
  try { people = require('./people'); } catch { people = null; }
  return list.map(x => {
    let whoName = x.whoName || '';
    if (!whoName && x.whoKey && people) { try { whoName = people.labelOfKey(x.whoKey); } catch {} }
    if (!whoName) whoName = String(x.nick || '');
    return Object.assign({}, x, { whoName });
  });
}

function scoreOf(q, hay) {
  const nq = norm(q);
  if (!nq) return 1;
  const h = norm(hay);
  if (h.indexOf(nq) >= 0) return 3;
  if (nq.length < 2) return 0;
  let hit = 0, total = 0;
  for (let i = 0; i < nq.length - 1; i++) { total++; if (h.indexOf(nq.slice(i, i + 2)) >= 0) hit++; }
  const r = total ? hit / total : 0;
  return r >= 0.6 ? r : 0;
}

/* 客户端检索：人物 / 关键词 / 时间 / 全部或单条 / 核实状态。 */
function search(o) {
  const p = o || {};
  const q = String(p.q || '').trim();
  const who = String(p.who || '').trim();
  const since = p.since ? new Date(String(p.since) + 'T00:00:00') : null;
  const until = p.until ? new Date(String(p.until) + 'T23:59:59') : null;
  const kinds = String(p.kind || 'all');
  const topic = String(p.topic || 'all');     // 三类：游戏攻略 / 情绪表达 / 梗词句
  const only = String(p.only || '');
  const ver = String(p.verified || 'all');
  let list = decorate(items());
  if (only) list = list.filter(x => String(x.id) === only);
  if (who) {
    const w = norm(who);
    list = list.filter(x => norm(x.whoName).indexOf(w) >= 0 || norm(x.whoKey).indexOf(w) >= 0);
  }
  if (kinds !== 'all') list = list.filter(x => x.kind === kinds);
  if (topic !== 'all') list = list.filter(x => x.topic === topic);
  if (ver !== 'all') list = list.filter(x => (ver === 'none' ? !x.verified : x.verified === ver));
  if (since || until) {
    list = list.filter(x => {
      const t = Date.parse(x.time || '');
      if (!Number.isFinite(t)) return true;
      if (since && t < since.getTime()) return false;
      if (until && t > until.getTime()) return false;
      return true;
    });
  }
  if (q) {
    list = list.map(x => {
      const sc = scoreOf(q, x.title + '\n' + x.body + '\n' + (x.say || '') + '\n' + x.whoName);
      return sc ? Object.assign({}, x, { score: sc }) : null;
    }).filter(Boolean);
  }
  list.sort((a, b) => (String(b.time || '').localeCompare(String(a.time || ''))));
  if (q) list.sort((a, b) => (b.score || 0) - (a.score || 0));
  const limit = Math.max(1, Math.min(200, Number(p.limit) || 60));
  return { total: list.length, list: list.slice(0, limit).map(x => Object.assign({}, x, { body: String(x.body || '').slice(0, 1200) })) };
}

function stats() {
  const all = items();
  const n = { guide: 0, learn: 0, teach: 0 };
  const t = { 游戏攻略: 0, 情绪表达: 0, 梗词句: 0 };
  let manual = 0, web = 0, none = 0;
  for (const x of all) {
    n[x.kind] = (n[x.kind] || 0) + 1;
    if (t[x.topic] !== undefined) t[x.topic]++;
    if (x.verified === 'manual') manual++; else if (x.verified === 'web') web++; else none++;
  }
  return { total: all.length, byKind: n, byTopic: t, verified: { manual, web, none } };
}

/* ===== 单条核实 / 单条删除 ===== */
function find(id) {
  const s = String(id || '');
  if (!s) return null;
  if (!s.startsWith('md:')) {
    const x = items().find(y => y.kind === 'teach' && String(y.id) === s);
    return x ? { it: x } : null;
  }
  const m = s.match(/^md:(.+):(\d+)$/);
  if (!m) return null;
  const file = m[1], idx = Number(m[2]);
  const { lines, sections } = splitSections(read(path.join(DIR, file)));
  const sec = sections.find(x => x.idx === idx);
  if (!sec) return null;
  return { it: { file, idx, title: sec.title }, lines, sections, sec };
}

function verify(id) {
  const f = find(id);
  if (!f) return { error: '找不到这一条（文件可能改过了，刷新再试）' };
  if (f.it.kind === 'teach') {
    const it = teach.confirm(String(id));
    return it ? { ok: true, id: String(id), verified: 'manual' } : { error: '这条锁定没成功' };
  }
  const { lines, sections, sec } = f;
  const sec2 = sections.find(x => x.idx === sec.idx);
  if (!sec2) return { error: '这一节不在了' };
  const head = lines[sec2.start];
  const bodyLines = lines.slice(sec2.start + 1, sec2.end);
  const stamp = '> 核实：主人手动 ' + today();
  const at = bodyLines.findIndex(l => /^>\s*核实[:：]/.test(l));
  if (at >= 0) bodyLines[at] = stamp;
  else {
    // 放在时间 / 来源那几行之后，正文之前；没有元信息行就紧跟标题
    let pos = 0;
    while (pos < bodyLines.length && /^>/.test(bodyLines[pos].trim())) pos++;
    bodyLines.splice(pos, 0, stamp);
  }
  const out = lines.slice(0, sec2.start).concat([head], bodyLines, lines.slice(sec2.end));
  writeAtomic(path.join(DIR, f.it.file), out.join('\n'));
  guides.reset();
  return { ok: true, id: String(id), verified: 'manual' };
}

function remove(id) {
  const f = find(id);
  if (!f) {
    /* 找不到时多看一眼前面：约定本体的 id 不在 teach/*.jsonl（在 topics.jsonl），
     * 直接回「找不到」会让人以为删成功了、刷新又回来。明说该去哪删。 */
    try {
      for (const line of read(TOPICS_FILE).split('\n')) {
        let x = null;
        try { x = JSON.parse(line); } catch { continue; }
        if (x && String(x.id) === String(id) && x.kind === 'promise') {
          return { error: '这条是「约定」，不是教学条：请到「约定」页删。' };
        }
      }
    } catch {}
    return { error: '找不到这一条（文件可能改过了，刷新再试）' };
  }
  if (f.it.kind === 'teach') {
    /* 从约定来的条目（fromPact）数据在 topics.jsonl，不在 teach/*.jsonl：
     * 以前这里照走 teach.del → 找不到 → 返回「删不掉」，但前端可能已经把它从列表里拿掉，
     * 看起来像「面板删了、后端没同步」（主人 2026-11-19 报）。现在明说该去哪删。 */
    if (f.it.fromPact) {
      return { error: '这条是「约定」，不是教学条：请到「约定」页删；在教学条这里删不到 topics.jsonl 那份。' };
    }
    const ok = teach.del(String(id));
    return ok ? { ok: true, id: String(id) } : { error: '这条锁定了或删不掉' };
  }
  const { lines, sections, sec } = f;
  const s = sections.find(x => x.idx === sec.idx);
  if (!s) return { error: '这一节不在了' };
  const head = lines.slice(0, s.start);
  let rest = lines.slice(s.end);
  // 删掉后别留一串空行（正文原样，只收口子）
  while (head.length && !head[head.length - 1].trim()) head.pop();
  while (rest.length && !rest[0].trim()) rest.shift();
  const out = head.concat(head.length ? [''] : [], rest);
  writeAtomic(path.join(DIR, f.it.file), out.join('\n').replace(/\s*$/, '\n'));
  guides.reset();
  return { ok: true, id: String(id) };
}

/* ===== 机器人每轮检索（主人 2026-11-13：≥4 字才跑，只给命中的，不全喂） ===== */
function teachHits(k, text, limit) {
  const ids = teach.presentOf(k);
  const meme = [];     // 梗词句：词条，给「说法 → 接法」
  const other = [];    // 其它方向：他教过的事，给原文
  const cap = limit || 2;
  for (const x of teach.listAll()) {
    if (!x.say) continue;
    const ax = teach.axisOf(x);
    const h = teach.hit(x.when, text);
    const noWhen = !(x.when || []).length;
    let use = false;
    if (ax.retrieval && h) use = true;
    if (!use && ax.present) {
      /* 在场就用：教的人在场才可用。
       * 没触发词的（情绪表达之类）跟这轮的话有字面关系才给，不整栏全喂；
       * 有触发词的，本人在场 + 撞上就用。 */
      let here = false;
      if (ids && ids.size) {
        for (const id of teach.ownerIds(x)) if (ids.has(id)) { here = true; break; }
      }
      if (here) {
        if (noWhen) { if (scoreOf(text, x.say + ' ' + (x.text || '')) > 0) use = true; }
        else if (h) use = true;
      }
    }
    if (!use) continue;
    /* 2026-11-20 主人令：梗词句是**词条**，不是规则——
     * 只给「什么说法 → 接什么」，不加「原样回」「不许改」「这轮必须说」这些修饰。
     * 新加的梗词句走同一个格式，不用再单独适配。 */
    if (x.dir === '梗词句') {
      if (meme.length >= cap) continue;
      // 显示**这一轮真正撞上的那个触发词**（h），不是永远取 when[0]：
      // 11-21 那句命中「司凤音乐」，注入里却写成「鬼畜视频 → 冰冰冰🧊」，模型看着对不上号。
      meme.push('- ' + String(h || (x.when || [])[0] || x.text || '').slice(0, 60) + ' → ' + x.say);
      continue;
    }
    if (other.length >= cap) continue;
    other.push('- ' + String(x.text || x.say).slice(0, 120));
  }
  const out = [];
  if (meme.length) out.push('【梗词句】\n' + meme.join('\n'));
  if (other.length) out.push('【他教过的事】\n' + other.join('\n'));
  return out.join('\n');
}

/* 可用知识 / 人设素材：按条检索，命中才给（不命中 0 token，不整篇喂）。
 * 主人 2026-11-13：「教学条里面应该存可用知识」；人设条用来认识、分辨不同人。
 * 两条路共用 scoreOf，各限 1 条，合计最多再加 2 条进提示词。 */
function specHit(text, x) {
  const a = norm(text);
  const b = norm(x.title + ' ' + (x.tags || '') + ' ' + x.body);
  if (!a || !b) return false;
  // ① 标题 / 标签里 ≥2 字的整词撞上本轮的话（「随机数」「伪随机」这类）
  for (const w of String(x.title + ' ' + (x.tags || '')).split(/[^\u4e00-\u9fa5a-z0-9]+/)) {
    const n = norm(w);
    if (n.length >= 2 && a.indexOf(n) >= 0) return true;
  }
  // ② 反过来：本轮的话里 3~4 字连片撞上条目（模糊匹配，不用整句覆盖率）
  for (let len = 4; len >= 3; len--) {
    for (let i = 0; i + len <= a.length; i++) if (b.indexOf(a.slice(i, i + len)) >= 0) return true;
  }
  return false;
}
function specHits(text, limit) {
  const rows = decorate(specItems(KNOWLEDGE_FILE, 'teach', '可用知识', '可用知识')
    .concat(specItems(PERSONA_FILE, 'persona', '人设条', '人设素材')));
  const out = [];
  for (const x of rows) {
    if (!specHit(text, x)) continue;
    const who = x.whoName || x.whoKey || '未署名';
    const head = x.kind === 'persona' ? '【人设素材】' : '【可用知识】';
    out.push(head + who + '（' + (x.scope || '场合未记') + '）：' + x.title + ' — ' + String(x.body || '').replace(/\n+/g, ' ').slice(0, 300));
    if (out.length >= (limit || 1)) break;
  }
  return out.join('\n');
}

/* 功能词典详解（主人 ⑤⑥「保证清楚自己有哪些功能」「只需要让虚幻永远强大的本地检索功能」）：
 * 短索引每轮都在人设里，长解释写在 soul/F-全场景通用主人设/功能词典.md 的 HTML 注释里（core 注入时剥掉）。
 * 只有这句话真的提到某个功能名，才把那几条详解拼进来；不命中 = 空串 = 0 token。
 * 数据只有一份，不复制、不另存总表。 */
function dictHits(text, limit) {
  const q = String(text || '').trim();
  if (q.length < 2) return '';
  const cap = limit || 3;
  const raw = read(DICT_FILE);
  const blocks = raw.match(/<!--[\s\S]*?-->/g) || [];
  const out = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const m = line.match(/^【(.+?)】(.+)$/);
      if (!m) continue;
      if (q.indexOf(m[1]) < 0) continue;
      out.push('· 【' + m[1] + '】' + m[2].trim());
      if (out.length >= cap) break;
    }
    if (out.length >= cap) break;
  }
  return out.length ? '【功能词典·命中】\n' + out.join('\n') : '';
}

/* 返回 { block, kinds }：block 直接进提示词；没有任何命中就是空串（0 token）。 */
function retrieve(text, opt) {
  const t = String(text || '').trim();
  if (t.length < 4) return { block: '', kinds: [] };     // 主人定的门槛：≥4 字才检索
  const o = opt || {};
  /* 可选「他真正打的字」（o.said）：不传就跟 text 一样。
   * 现在默认不传——图上的字照样参与触发词匹配（主人 2026-11-19 认可「图片判是对的」），
   * 跨群问题不靠剥图解决，靠约定副本的 in-person 轴（见 teachHits 的 present 分支）。 */
  const said = String(o.said === undefined || o.said === null ? t : o.said).trim();
  const parts = [];
  const kinds = [];
  let g = '';
  try { g = guides.search(t, 2, 900, 0.45); } catch {}
  if (g) { parts.push('【游戏攻略】\n' + g); kinds.push('guide'); }
  let l = '';
  try { l = guides.learnSearch(t, o.scope, 1, 450, 0.45); } catch {}
  if (l) { parts.push('【学到的】\n' + l); kinds.push('learn'); }
  let th = '';
  try { th = teachHits(o.k, said, 2); } catch {}
  if (th) { parts.push(th); kinds.push('teach'); }   // teachHits 自带小标题（认梗段单独一段）
  let sh = '';
  try { sh = specHits(t, 1); } catch {}
  if (sh) { parts.push(sh); kinds.push('spec'); }
  /* 回话路径（四张表）：命中才给，不命中 0 token。
   * 先把这句话命中的喜好词转成唯一 id 传进去，挂了这些 id 的应对条目优先 =
   * 她原话「和喜好表的联动是有自己偏好的应对」。阈值字段不参与，retrieve 只给内容不做判定。 */
  let rp = '';
  try {
    const ids = [];
    for (const h of require('./taste').mineSearch(t)) if (h && h.id) ids.push(String(h.id));
    rp = require('./replypath').retrieve(t, ids);
  } catch {}
  if (rp) { parts.push('【回话路径】\n' + rp); kinds.push('replypath'); }
  /* 功能词典详解：命中功能名才给；放最前面，免得被 1500 字上限切掉。 */
  const dict = dictHits(t, 3);
  if (dict) { parts.unshift(dict); kinds.unshift('dict'); }
  let block = parts.join('\n\n');
  if (block.length > 1500) block = block.slice(0, 1500);
  return { block, kinds };
}

/* ===== md 类条目的改内容 / 搬归属（2026-11-13 主人：「所有内容我都能…修改内容」）=====
 * 攻略与学到的事是 md 的 ## 小节：改内容 = 换这一节正文（时间/来源/核实 那几行保留）；
 * 搬归属 = 这一节物理搬到另一份 md（群X / 私聊QQ号 / 平台 / 联网 / 攻略），原文件删掉不留双份。 */
function files() {
  try {
    return fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.md')).sort();
  } catch { return []; }
}
function sectionLines(id) {
  if (String(id).indexOf('md:') !== 0) return null;
  const f = find(id);
  if (!f) return null;
  const s = f.sections.find(x => x.idx === f.sec.idx);
  return s ? { f, s } : null;
}
function editSection(id, patch) {
  const hit = sectionLines(id);
  if (!hit) return { error: '找不到这一条（文件可能改过了，刷新再试）' };
  const o = patch || {};
  const { f, s } = hit;
  const oldBody = f.lines.slice(s.start + 1, s.end);
  const isMeta = l => /^>\s*(时间|来源|核实|分类)[:：]/.test(String(l).trim());
  const metas = oldBody.filter(isMeta);
  const cur = oldBody.filter(l => !isMeta(l)).join('\n').trim();
  const body = String(o.body === undefined ? cur : o.body).replace(/\r/g, '').trim();
  const title = String(o.title === undefined ? s.title : o.title).trim().slice(0, 60) || s.title;
  if (!body) return { error: '正文不能空（要删整条请用删）' };
  /* 分类也能改（主人 2026-11-13：「任何「记录的」里的内容后续都要正确记录、并正确分类」）：
   * 传了 topic 就重写 `> 分类：X` 那一行；没传就保留原来那行和顺序。 */
  const wanted = String(o.topic || '');
  const keep = metas.filter(l => wanted ? !/^>\s*分类[:：]/.test(String(l).trim()) : true);
  const withTopic = wanted && teach.DIRS.indexOf(wanted) >= 0
    ? (() => {
      const at = keep.findIndex(l => /^>\s*(核实)[:：]/.test(String(l).trim()));
      const row = '> 分类：' + wanted;
      const arr = keep.slice();
      if (at >= 0) arr.splice(at, 0, row); else arr.push(row);
      return arr;
    })()
    : keep;
  const next = ['## ' + title, ''].concat(withTopic, withTopic.length ? [''] : [], body.split('\n'));
  const out = f.lines.slice(0, s.start).concat(next, f.lines.slice(s.end));
  writeAtomic(path.join(DIR, f.it.file), out.join('\n').replace(/\s*$/, '\n'));
  guides.reset();
  return { ok: true, id: String(id) };
}
/* 搬归属：只认 data/guides 下已有的 md（不凭空造文件，免得多一份空档）。 */
function moveSection(id, file) {
  const hit = sectionLines(id);
  if (!hit) return { error: '找不到这一条' };
  const to = String(file || '');
  if (!to || files().indexOf(to) < 0) return { error: '目标文件不在 data/guides 里' };
  const { f, s } = hit;
  if (to === f.it.file) return { error: '已经在这个文件里' };
  const chunk = f.lines.slice(s.start, s.end);
  let rest = f.lines.slice(0, s.start).concat(f.lines.slice(s.end));
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  writeAtomic(path.join(DIR, f.it.file), rest.join('\n').replace(/\s*$/, '\n') + '\n');
  const dest = path.join(DIR, to);
  let raw = read(dest).replace(/\s*$/, '');
  raw += '\n\n' + chunk.join('\n').replace(/^\n+/, '') + '\n';
  writeAtomic(dest, raw);
  guides.reset();
  return { ok: true, id: String(id), file: to };
}

/* ===== 人设素材 / 可用知识：前端写入（主人 2026-11-13）=====
 * 她在面板里新增一条、改署名 / 场合 / 标签、把长正文补到末尾，不用手改文件。
 * 一条 = 一个 ## 小节；> 元信息行原样保留，只替换正文与那几行元信息。 */
function localStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function specAdd(o) {
  const p = o || {};
  const file = p.kind === 'teach' ? KNOWLEDGE_FILE : PERSONA_FILE;
  const title = String(p.title || '').trim().slice(0, 60);
  if (!title) return { error: '给这条起个名字' };
  const meta = [
    '> 时间：' + localStamp(),
    '> 来源：' + String(p.source || '主人在面板录入').trim().slice(0, 120),
    '> 署名：' + String(p.who || '').trim().slice(0, 60),
    '> 场合：' + String(p.scope || '').trim().slice(0, 60),
    '> 标签：' + String(p.tags || '').trim().slice(0, 120),
  ];
  const body = String(p.body || '').replace(/\r/g, '').trim();
  const full = path.join(DIR, file);
  const raw = read(full);
  const chunk = ['## ' + title, ''].concat(meta, [''], body, ['']).join('\n');
  try { writeAtomic(full, raw.replace(/\s*$/, '') + '\n\n' + chunk + '\n'); }
  catch (e) { return { error: '写不进去：' + e.message }; }
  guides.reset();
  return { ok: true, file, title };
}
function specSave(id, o) {
  const p = o || {};
  const m = String(id || '').match(/^md:(.+):(\d+)$/);
  if (!m || SPECIAL_FILES.indexOf(m[1]) < 0) return { error: '这条不是人设素材 / 可用知识' };
  const file = m[1], idx = Number(m[2]);
  const full = path.join(DIR, file);
  const { lines, sections } = splitSections(read(full));
  const sec = sections.find(x => x.idx === idx);
  if (!sec) return { error: '这一条不在了，刷新再试' };
  const title = String(p.title || sec.title).trim().slice(0, 60) || sec.title;
  // 字段名是中文（> 来源：…），前端传的是英文键，这里映射一次，避免不传时把原值抹掉。
  const KEY_CN = { source: '来源', who: '署名', scope: '场合', tags: '标签' };
  const keep = (k, fallback) => String(p[k] === undefined ? (specLine(sec.body, KEY_CN[k] || k) || fallback || '') : p[k]).trim();
  const meta = [
    '> 时间：' + (specLine(sec.body, '时间') || localStamp()),
    '> 来源：' + keep('source', '主人在面板录入').slice(0, 120),
    '> 署名：' + keep('who').slice(0, 60),
    '> 场合：' + keep('scope').slice(0, 60),
    '> 标签：' + keep('tags').slice(0, 120),
  ];
  const ver = specLine(sec.body, '核实');
  if (ver) meta.push('> 核实：' + ver);
  const body = String(p.body === undefined
    ? sec.body.split('\n').filter(l => !SPEC_META.test(l.trim())).join('\n').trim()
    : p.body).replace(/\r/g, '').trim();
  const chunk = ['## ' + title, ''].concat(meta, [''], body, ['']);
  const out = lines.slice(0, sec.start).concat(chunk, lines.slice(sec.end));
  try { writeAtomic(full, out.join('\n').replace(/\s*$/, '\n')); }
  catch (e) { return { error: '存不上：' + e.message }; }
  guides.reset();
  return { ok: true, id: String(id), file };
}
/* 特条删除走现成 remove()（md: 前缀按小节删），这里单独挡一道：
 * 只允许删这两份，免得误删攻略。 */
function specRemove(id) {
  const m = String(id || '').match(/^md:(.+):(\d+)$/);
  if (!m || SPECIAL_FILES.indexOf(m[1]) < 0) return { error: '这条不是人设素材 / 可用知识' };
  return remove(id);
}

function api(action, payload) {
  const p = payload || {};
  switch (action) {
    case 'list': return Object.assign({ ok: true, stats: stats(), files: files() }, search(p));
    case 'stats': return { ok: true, stats: stats(), files: files() };
    case 'spec-get': {
      const m = String(p.id || '').match(/^md:(.+):(\d+)$/);
      if (!m || SPECIAL_FILES.indexOf(m[1]) < 0) return { error: '这条不是人设素材 / 可用知识' };
      const sec = splitSections(read(path.join(DIR, m[1]))).sections.find(x => x.idx === Number(m[2]));
      if (!sec) return { error: '这一条不在了，刷新再试' };
      const x = specItems(m[1], 'persona', '人设条', '人设素材').find(y => y.id === p.id) || {};
      return {
        ok: true, id: String(p.id), file: m[1], title: sec.title,
        body: sec.body.split('\n').filter(l => !SPEC_META.test(l.trim())).join('\n').trim(),
        who: specLine(sec.body, '署名'), scope: specLine(sec.body, '场合'),
        tags: specLine(sec.body, '标签'), source: specLine(sec.body, '来源'),
        kind: m[1] === KNOWLEDGE_FILE ? 'teach' : 'persona',
        verified: x.verified || '',
      };
    }
    case 'spec-add': return specAdd(p);
    case 'spec-save': return specSave(p.id, p);
    case 'spec-del': { const r = specRemove(p.id); return r.ok ? r : { error: r.error }; }
    case 'verify': { const r = verify(p.id); return r.ok ? r : { error: r.error }; }
    case 'delete': { const r = remove(p.id); return r.ok ? r : { error: r.error }; }
    case 'edit': return editSection(p.id, p);
    case 'move': return moveSection(p.id, p.file);
    default: return { error: '未知操作：' + action };
  }
}

module.exports = { items, search, stats, verify, remove, retrieve, api, splitSections, metaOf, isoOf, files, editSection, moveSection };
