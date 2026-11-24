/* src/localsearch.js — 本地数据检索（主人 2026-11-09 定）
 *
 * 这是干什么的：她说「所有已经存在的数据虚幻都应该能够进行本地搜索」。
 * 起因两件真事（都在 2026-11-09）：
 *   11:38 她问「我最近生气了几次」，机器人回「主人你生气了？」——只看见「生气」两个字。
 *   11:47 她说「非神说了你几次脑子空空」，机器人回「你眼睛瞎了还能战斗，那不是武神是什么？」
 *        ——句子里有「几次」，但没有情绪词，所以旧版直接不查。
 * 结论：触发条件不能只挂「情绪」，得挂「任何回溯问句」；查的也不能只有情绪，得有原话。
 *
 * 这个文件只读不写：把**已经落盘**的数据按条件查出来，拼成一段事实给模型。
 * 不新建数据文件、不改任何数据源、不写盘。
 *
 * 数据源：
 *   data/chat-log.jsonl   全群全人流水，格式「ISO时间 [qq][会话][昵称] 内容」
 *   data/qq-names.json    显示名 → {platform, id}（按 QQ 号反查用过的所有名字）
 *   data/people.json      人物正本（昵称 / 群名片 / 别名）
 *   data/情绪记录.jsonl    判出来的情绪（2026-11-09 起主人也记）
 *
 * 匹配必须精确相等：数据里同时有「那就是死了」和「那就是死了已被移出群聊」，
 * 是两个不同的号，用包含匹配会串人。
 */
const fs = require('fs');
const path = require('path');
const et = require('./emotion-tree');

const ROOT = __dirname;
const CHATLOG = path.join(ROOT, 'data', 'chat-log.jsonl');
const NAMES = path.join(ROOT, 'data', 'qq-names.json');
const PEOPLE = path.join(ROOT, 'data', 'people.json');

const LINE_RE = /^(\S+)\s+\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s*([\s\S]*)$/;
/* 整个 chat-log 纳入本地搜索库。读全文；size+mtime 缓存保证同版本只读一次。
 * 触发落点 src/connectors/qq.js handleTurn（原 INSTANT_RE 处）→ 本文件 instantContext
 * → 注入落点 src/core.js buildMessages 的 ctx.instant 块。 */
const TAIL = 0;   // 0 = 读全文（原 2MB 窗口作废）

/* 机器人自己的 nick：统计「谁说过」时不能把自己算进去，否则问一句就多一条。 */
const BOT_NICKS = new Set(['虚幻', '你自己（虚幻）']);

/* 问「几次 / 什么时候」的句子：这是**查询**，不是说话人自己在表达情绪。
 * 必须排除，否则她问一次「我生气了几次」，统计就多一次，越问越多。 */
const COUNT_RE = /(几次|多少次|几回|多少回)/;
const WHEN_RE = /(什么时候|哪天|多久了|上次|上一次)/;
/* 回溯词：出现任何一个就值得去翻旧记录（主人 2026-11-09 11:47 那句就靠这个救）。
 * 「刚才 / 刚刚」故意不收：日常随口一句就带这两个字，收了等于每句话都去扫盘。 */
const BACK_RE = /(之前|以前|上次|上一次|说过|提过|讲过|记得|还记得)/;

/* 抽关键词时要剥掉的骨架词：问法、人称、量词、说话动词、助词、指示词。
 * 从长到短删，避免「次」先删掉「几次」的一半。 */
const SKELETON = [
  '多少次', '多少回', '什么时候', '上一次', '几次', '几回', '上次', '之前', '以前',
  '说过', '提过', '讲过', '记得', '还记得', '叫什么', '是什么',
  '说', '讲', '提', '问', '聊', '叫',
  '你', '我', '他', '她', '它', '你们', '我们',
  '的', '了', '吗', '呢', '啊', '呀', '吧', '嘛', '是', '有', '在', '和', '跟', '对',
  '什么', '那些', '那个', '这个', '哪些', '哪个', '这', '那', '个', '次',
];

function jload(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; }
}

/* QQ 号 → 这个号用过的所有显示名（精确相等才认）。
 * 主人有多个号（masterQQ + masters），每个号在每个群的名片可能都不一样，
 * chat-log 记的是名片名，不是 QQ 号，所以查询前必须先展开成名字集合。 */
function namesOf(uid) {
  const id = String(uid || '').trim();
  const out = new Set();
  if (!id) return [];
  const nm = jload(NAMES, {});
  for (const [name, v] of Object.entries(nm || {})) {
    if (v && String(v.platform) === 'qq' && String(v.id) === id) out.add(String(name).trim());
  }
  const pp = jload(PEOPLE, {});
  for (const p of Object.values(pp || {})) {
    for (const a of (p.accounts || [])) {
      if (String(a.platform) !== 'qq' || String(a.id) !== id) continue;
      // 只在**这个号真在这个人物下**时才取人物级名字，否则会把别人的名字吃进来
      if (a.nick) out.add(String(a.nick).trim());
      for (const c of Object.values(a.cards || {})) out.add(String(c).trim());
      if (String(p.name || '').trim()) out.add(String(p.name).trim());
      // 别名前缀（「主人（欧尼酱的女朋友）」→「主人」）也认，历史里有直接叫「主人」的行
      const al = String(a.alias || '').split(/[（(]/)[0].trim();
      if (al) out.add(al);
    }
  }
  out.delete('');
  return [...out];
}

/* 显示名 → QQ 号（全量，带 mtime 缓存）。用来在句子里认出「这句话在说谁」。
 * 「非神说了你几次脑子空空」→ 认出「非神」= 2770187994。 */
let _idx = { mt: 0, map: null };
function allNameIndex() {
  let mt = 0;
  try { mt = fs.statSync(NAMES).mtimeMs + fs.statSync(PEOPLE).mtimeMs; } catch { mt = 0; }
  if (_idx.map && mt === _idx.mt) return _idx.map;
  const map = {};
  const nm = jload(NAMES, {});
  for (const [name, v] of Object.entries(nm || {})) {
    const n = String(name || '').trim();
    if (n && v && String(v.platform) === 'qq') map[n] = String(v.id);
  }
  const pp = jload(PEOPLE, {});
  for (const p of Object.values(pp || {})) {
    for (const a of (p.accounts || [])) {
      if (String(a.platform) !== 'qq' || !a.id) continue;
      const id = String(a.id);
      if (String(p.name || '').trim()) map[String(p.name).trim()] = id;
      if (a.nick) map[String(a.nick).trim()] = id;
      for (const c of Object.values(a.cards || {})) { const n = String(c).trim(); if (n) map[n] = id; }
    }
  }
  _idx = { mt, map };
  return map;
}

/* 读 chat-log 尾部一块。带 size+mtime 缓存：同一个文件版本只读一次，
 * 否则一句话触发一次检索就要重读 2MB（群里连问几句就明显卡）。 */
let _raw = { key: '', text: '' };
function readRaw() {
  try {
    const st = fs.statSync(CHATLOG);
    const key = st.size + ':' + st.mtimeMs;
    if (_raw.key === key) return _raw.text;
    const start = TAIL > 0 ? Math.max(0, st.size - TAIL) : 0;   // TAIL=0 → 整个文件
    const fd = fs.openSync(CHATLOG, 'r');
    let raw = '';
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);   // 掐掉切进中间的半行
    } finally { fs.closeSync(fd); }
    _raw = { key, text: raw };
    return raw;
  } catch { return ''; }
}

/* 读最近 days 天的聊天流水（默认 30 天） */
function readLines(days) {
  const lim = Math.max(1, Number(days) || 30);
  const since = Date.now() - lim * 86400000;
  const out = [];
  for (const l of readRaw().split('\n')) {
    if (!l.trim()) continue;
    const m = l.match(LINE_RE);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (t && t < since) continue;
    out.push({ t, iso: m[1], scope: m[3] || '', nick: String(m[4] || '').trim(), text: String(m[5] || '') });
  }
  return out;
}

/* 这句是不是在「问自己的情绪次数 / 时间」——情绪类的查询句，不当作情绪表达 */
function isMetaQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (!COUNT_RE.test(t) && !WHEN_RE.test(t)) return false;
  return !!et.judge(t).best;      // 还带情绪词才算，不然「说了几次话」不该走这条
}

/* 图片占位符（［图：图库里的「生气」］）不是情绪表达：发一张生气的表情包
 * 不等于她生气。真事 2026-11-09 统计时这两条把「怒」从 1 次虚报成 3 次。 */
function isImageLine(t) {
  return /［图[:：]|\[图片\]/.test(String(t || ''));
}

/* 某个名字集合在最近 days 天里被判成 core 的记录（跳过查询句、跳过图片） */
function countEmotion(names, core, days) {
  const set = new Set((Array.isArray(names) ? names : [names]).map(s => String(s || '').trim()).filter(Boolean));
  if (!set.size) return [];
  const out = [];
  for (const r of readLines(days)) {
    if (!set.has(r.nick)) continue;
    if (isMetaQuery(r.text)) continue;
    if (isImageLine(r.text)) continue;
    const j = et.judge(r.text);
    if (!j.best) continue;
    if (core && j.best.node.core !== core) continue;
    out.push({ t: r.iso, scope: r.scope, text: r.text.slice(0, 40), leaf: j.best.node.name, word: j.best.w, core: j.best.node.core });
  }
  return out;
}

/* 原话检索：names 为空 = 所有人（排除机器人自己）；kw 为空 = 不筛内容；
 * exclude = 当前这句提问本身，要排掉（不然她问一句「X 说了几次脑子空空」，
 * 这句话自己就成了一条命中记录）。 */
function searchLines(names, kw, days, exclude) {
  const list = (Array.isArray(names) ? names : (names ? [names] : [])).map(s => String(s || '').trim()).filter(Boolean);
  const set = new Set(list);
  const k = String(kw || '').trim();
  const ex = String(exclude || '').trim();
  return readLines(days)
    .filter(r => {
      if (BOT_NICKS.has(r.nick)) return false;
      if (isImageLine(r.text)) return false;   // 图片描述不是原话，搜「游戏」会命中一堆截图说明
      // 问次数的句子不是内容陈述：她问两遍「我说过几次修复」，第一遍那句不能算成第二遍的命中
      if (COUNT_RE.test(r.text)) return false;
      if (ex && r.text.trim() === ex) return false;
      if (set.size && !set.has(r.nick)) return false;
      if (k) {
        // 单字关键词（「对」）只数「整句就是它」的，避开「对的 / 不对」噪声；
        // 多字（「我去」「存在意义」）用包含匹配。
        if (k.length <= 1) { if (r.text.trim() !== k) return false; }
        else if (r.text.indexOf(k) < 0) return false;
      }
      return true;
    })
    .map(r => ({ t: r.iso, scope: r.scope, nick: r.nick, text: r.text.slice(0, 60) }));
}

/* 把一句问话拆成「问谁 / 问什么 / 要不要计数」。
 * 例：「非神说了你几次脑子空空」→ { count:true, people:['非神'], kw:['脑子空空'] }
 *     「之前说的那个游戏叫什么」→ { count:false, people:[], kw:['游戏叫'] }
 * 不是回溯问句就返回 null（一个字都不查）。 */
function extractQuery(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const count = COUNT_RE.test(s);
  const when = WHEN_RE.test(s);
  const back = BACK_RE.test(s);
  if (!count && !when && !back) return null;    // 没有回溯词：不是在问旧事

  // ① 句子提到了谁（「你 / 虚幻」是机器人自己，不算「谁说过」的目标）
  const idx = allNameIndex();
  const people = [];
  for (const [name, uid] of Object.entries(idx)) {
    if (name.length < 2) continue;
    if (BOT_NICKS.has(name)) continue;
    if (s.indexOf(name) >= 0 && people.indexOf(name) < 0) people.push(name);
  }

  // ② 抽关键词
  //    次数问句（几次 / 多少回）：用「几次」当分隔符，它**之后**整段就是目标词。
  //    「我说过几次存在意义」→「存在意义」；「我说过几次我去」→「我去」；
  //    「我说过几次我说过」→「我说过」；「我说过几次对」→「对」。
  //    这样「我 / 我说过」这类问法骨架不会再被剥掉真实词（之前「对」「我去」因此被清空成不查）。
  let kw = [];
  if (count) {
    const tm = s.match(/(?:几次|多少次|几回|多少回)\s*([\s\S]*)$/);
    let t = tm ? tm[1].trim() : '';
    t = t.replace(/^(你的|我的|他的|她的|的)/, '').replace(/(了|啊|呀|吧|呢|吗|哦|哈|嘛|的)$/, '').trim();
    if (t) kw = [t];
  } else {
    // 回溯 / 时间问句：剥骨架词取关键词（给「之前说的那个游戏叫什么」这类用）
    let k = s;
    for (const w of SKELETON) k = k.split(w).join(' ');
    kw = k.split(/[\s，。！？、,.!?~～…：:；;“”"'（）()【】]+/)
      .map(x => x.trim())
      .filter(x => x.length >= 2);
    kw = kw.filter(x => !people.some(p => x.indexOf(p) >= 0));
  }

  // ③ 第一人称：问「我说过几次 X」→ 只查说话人自己，不要搜全群
  const self = /我/.test(s);

  if (!people.length && !kw.length) return null;
  return { count, when, back, people, kw, self };
}

/* 时间戳转本机时区显示（chat-log 存 UTC） */
function fmtT(iso) {
  const t = Date.parse(iso);
  const p = n => String(n).padStart(2, '0');
  if (!t) return String(iso || '').slice(5, 16).replace('T', ' ');
  const d = new Date(t);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const HEAD = '## 本地记录查到的事实（从已落盘的数据里数出来的，不是猜的）';

/* 情绪次数：她问「我最近生气了几次」这类 */
function emotionBlock(o, days) {
  const j = et.judge(o.text);
  if (!j.best) return '';
  const names = namesOf(o.uid);
  if (o.who) names.push(String(o.who));
  const core = j.best.node.core;
  const leaf = j.best.node.name;
  const who = String(o.who || '对方');
  const items = countEmotion(names, core, days);
  if (!items.length) {
    return HEAD + '\n' + who + '近 ' + days + ' 天没有判出「' + leaf + '」的记录（0 次）。'
      + '\n【必须】直接回答「你最近没' + leaf + '」（0 次）。不许说「记不清 / 不太确定」，不许编，也不许赔礼道歉。';
  }
  const last = items.slice(-3).map(x => '- ' + fmtT(x.t) + '［' + (x.scope || '') + '］' + x.text).join('\n');
  return HEAD + '\n' + who + '近 ' + days + ' 天被判为「' + leaf + '」' + items.length + ' 次：\n' + last
    + '\n【必须】第一句直接说「你最近' + leaf + '了 ' + items.length + ' 次」。不许说「记不清」。这句问句本身不算一次。';
}

/* 通用检索：说了几次 / 什么时候说过 / 之前那句是什么。
 * 按「谁说过 + 关键词」查原话，查不到就明说没有。 */
function genericBlock(q, days, selfText, uid, who) {
  let names = [];
  if (q.people.length) {
    for (const n of q.people) names = names.concat(namesOf(allNameIndex()[n] || ''));
  } else if (q.self) {
    // 「我说过几次修复」：说话人就是查询对象，别把全群的话都翻出来
    names = namesOf(uid);
    if (who) names.push(String(who));
  }
  names = [...new Set(names.filter(Boolean))];
  const kw = q.kw.length ? q.kw : [''];
  const found = [];
  for (const k of kw) {
    for (const it of searchLines(names, k, days, selfText)) found.push(Object.assign({ kw: k }, it));
    if (found.length >= 12) break;
  }
  const whoTxt = q.people.length ? q.people.join('、') : (q.self ? '你' : '记录里所有人');
  const kwTxt = q.kw.length ? '「' + q.kw.join(' / ') + '」' : '（没抽出关键词）';

  if (!found.length) {
    const obj = q.kw.length ? q.kw[0] : '这个';
    return HEAD + '\n近 ' + days + ' 天：' + whoTxt + ' 没有说过 ' + kwTxt + '（0 条）。'
      + '\n【必须】直接照此回答：告诉对方「' + whoTxt + '没说过' + obj + '」（即 0 次）。'
      + '\n不许说「记不清 / 不太确定 / 我记不清」这类话，也不许编、不许拿别的话题硬套。';
  }
  const uniq = [];
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.t + f.text)) continue;
    seen.add(f.t + f.text);
    uniq.push(f);
  }
  const lines = uniq.slice(-8).map(f => '- ' + fmtT(f.t) + '［' + (f.scope || '') + '］' + f.nick + '：' + f.text).join('\n');
  const cnt = q.count ? '共 ' + uniq.length + ' 条。' : '';
  return HEAD + '\n近 ' + days + ' 天 ' + whoTxt + ' 说到 ' + kwTxt + ' 的记录 ' + cnt + '\n' + lines
    + '\n【必须】直接用上面的条数 / 原话回答，第一句就给数字或原话。不许说「记不清 / 不太确定」。没列出来的别补，不确定就说没查到。';
}

/* 主入口：这一轮要不要查、查到什么，返回一段可直接拼进 extra 的事实。
 * 不需要查就返回 ''（一个字都不加，不白烧 token）。 */
function block(o) {
  const opt = o || {};
  const text = String(opt.text || '');
  if (!text.trim()) return '';
  const days = Math.max(1, Number(opt.days) || 30);
  // ① 情绪次数/时间优先（她问「我生气了几次」）
  if (isMetaQuery(text)) {
    const eb = emotionBlock(opt, days);
    if (eb) return eb;
  }
  // ② 其它回溯问句（「非神说了你几次脑子空空」「之前那个叫什么」）
  const q = extractQuery(text);
  if (!q) return '';
  if (!q.people.length && !q.kw.length) return '';
  return genericBlock(q, days, text, opt.uid, opt.who);
}

/* 即时记忆入口：话里提到某物/某句话 → 抽实词搜整个 chat-log，命中原话给她。
 * 调用方 src/connectors/qq.js handleTurn（取代原 INSTANT_RE 字面正则触发，qq.js:5241）；
 * 结果注入 src/core.js buildMessages 的 ctx.instant 块（core.js:6998）。搜不到返回空。 */
function instantContext(text, exclude) {
  const s = String(text || '').trim();
  if (!s) return '';
  let k = s;
  for (const w of SKELETON) k = k.split(w).join(' ');
  const kws = k.split(/[\s，。！？、,.!?~～…：:；;"”'（）()【】\[\]]+/)
    .map(x => x.trim()).filter(x => x.length >= 2);
  if (!kws.length) return '';
  const ex = String(exclude || '').trim();
  const found = [];
  const seen = new Set();
  for (const kw of kws.slice(0, 3)) {
    for (const it of searchLines([], kw, 36500, ex)) {   // days 给足 = 搜整个库
      const id = it.t + it.nick + it.text;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(it);
      if (found.length >= 6) break;
    }
    if (found.length >= 6) break;
  }
  if (!found.length) return '';
  const lines = found.slice(-6).map(f => '- ' + fmtT(f.t) + '［' + (f.scope || '') + '］' + f.nick + '：' + f.text).join('\n');
  return '## 这句话提到的东西，本地聊天记录里搜到的原话\n' + lines
    + '\n上面是从整个聊天记录里搜出来的相关原话，用来接这句提到的东西；搜不到的别硬套。';
}

module.exports = {
  namesOf, allNameIndex, readLines, isMetaQuery, extractQuery,
  countEmotion, searchLines, block, instantContext,
};
