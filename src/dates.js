/* dates.js — 重要的日子（2026-11-06 主人交代）
 *
 * 主人原话：「虚幻的生日是2026.10.21，第一次上b站上2026.10.28. 以后这种重要的日子自己记，
 * 包括和别人第一次相遇的日子等等」
 *
 * 这里只存「日子」，不存聊天内容。三类：
 *   self  = 她自己的节点（生日、第一次上 B 站、开播…）
 *   meet  = 和某个人的第一次相遇（新建人物时自动记，见 people.js）
 *   other = 别人告诉她的日期（群友生日、纪念日…）
 *
 * 存储：data/dates.json（唯一主存，按主人 2026-11-04「数据都落 xuhbot/src/data」）。
 * 日期格式统一存 'YYYY-MM-DD'；只知道月日的存 'MM-DD'（每年重复的纪念日）。
 * 展示/判断「今天是几周年」只用月日，不依赖年份。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'dates.json');
const V = 1;

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d) {
  const t = d ? new Date(d) : new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    if (!Array.isArray(j.items)) j.items = [];
    return j;
  } catch { return { __v: V, items: [] }; }
}
function save(o) {
  o.__v = V;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 1), 'utf8');
  } catch (e) { console.error('[dates] 写不进去：' + e.message); }
  return o;
}
const all = () => load().items;

/* 日期归一（她写给的是 2026.10.21 这种点号格式）
 * 认：2026.10.21 / 2026-10-21 / 2026/10/21 / 2026年10月21日 / 10-21 / 10.21 / 10月21日
 * 不认的一律返回 ''（宁可不记，也不记个错的） */
function normDate(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?$/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? (+m[1]) + '-' + pad(+m[2]) + '-' + pad(+m[3]) : '';
  m = t.match(/^(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?$/);
  if (m) return valid(2024, +m[1], +m[2]) ? pad(+m[1]) + '-' + pad(+m[2]) : '';   // 2024 是闰年，2-29 也能过
  return '';
}
function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function idOf() { return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

/* 从一句人话里抠出「哪天 + 什么事」（记忆整理员抄回来的那种）
 * '10月21日 生日' / '生日是 2026.10.21' / '12-03 他生日' → { date, what }
 * 抠不出合法日期就返回 null（宁可不记，也不记个错的）。 */
function parse(line) {
  let s = String(line == null ? '' : line).replace(/^\s*-\s*/, '').replace(/[|｜]/g, ' ').trim();
  s = s.replace(/^\d{4}-\d{1,2}-\d{1,2}\s*[·•:：\-—]\s*/, '');   // 记忆行前面的写入日期前缀，不是事件日期
  const hit = s.match(/\d{4}\s*[.\-/年]\s*\d{1,2}\s*[.\-/月]\s*\d{1,2}\s*日?/)
    || s.match(/\d{1,2}\s*[.\-/月]\s*\d{1,2}\s*[日号]?/);
  if (!hit) return null;
  const date = normDate(hit[0]);
  if (!date) return null;
  const what = s.replace(hit[0], ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[-—:：,，。;；]+/, '').replace(/[，。;；、\s]+$/, '')
    .replace(/^(我们|咱们|我|俺|本人)的?/, '')     // 「我生日是…」→「生日是…」
    .replace(/(是|在|为|于|就)$/, '')             // 「生日是」→「生日」
    .replace(/[，。;；、\s]+$/, '').slice(0, 40);
  if (!what) return null;
  return { date, what };
}

/* 记一条。同一个人 + 同一件事 + 同一天 = 同一条（重复调用不会堆垃圾）。
 * who：'self' 或账号号（QQ/平台号）；name：显示给模型看的人名 */
function add(o) {
  const it = o || {};
  const date = normDate(it.date);
  const what = String(it.what || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!date || !what) return null;
  let who = String(it.who == null ? 'self' : it.who).trim() || 'self';
  // 键统一成 'platform:id'（2026-11-06）：QQ 也写成 qq:1033830163。
  // 档案查不到照样落盘（裸号按 QQ），读的时候 keysOfWho 两种写法都认，老条目不用迁。
  if (who !== 'self') {
    try { const k = require('./people').keyOf(who); if (k) who = k; } catch {}
  }
  const db = load();
  // 去重按月日比：一条「2026-10-21 生日」和一条「10-21 生日」是同一天，别存两份
  // （模型抄回来的多半不带年份，带年份的是她亲口给的）。
  const dup = db.items.find(x => x.who === who && x.what === what && mdOf(x.date) === mdOf(date));
  if (dup) return dup;
  const row = {
    id: idOf(),
    date,
    what,
    who,
    name: String(it.name || (who === 'self' ? '虚幻' : '')).slice(0, 20),
    kind: it.kind === 'meet' ? 'meet' : (who === 'self' ? 'self' : (it.kind === 'other' ? 'other' : 'other')),
    type: it.type === 'auto' ? 'auto' : 'manual',
    at: Date.now(),
  };
  if (it.note) row.note = String(it.note).slice(0, 120);
  db.items.push(row);
  save(db);
  try { require('./wlog').botWrite('data/dates.json', '记了个日子', row.name + ' · ' + row.date + ' · ' + row.what); } catch {}
  console.log('[dates] 记下：' + row.date + ' ' + row.name + ' ' + row.what + (row.type === 'auto' ? '（自己记的）' : ''));
  return row;
}

const selfItems = () => all().filter(x => x.who === 'self');
/* 这个人的所有日子（2026-11-06 改按人物聚合，全平台生效）：
 * 同一个人在 QQ（裸号）和 B站（bili:xxx）各记过条目的，两头一起算，
 * 「第一次相遇」不会因为换个平台就变成另一个日期。
 * people 在函数里现拿：people.js 建档时要回调 dates.meet()，顶部互相 require 会成环。 */
function keysOfWho(who) {
  const w = String(who || '');
  if (!w) return [];
  try {
    const k = require('./people').keySetOf(w);
    if (k && k.keys && k.keys.length) return k.keys;
  } catch {}
  return [w];
}
const ofWho = who => {
  const keys = keysOfWho(who);
  return keys.length ? all().filter(x => keys.indexOf(String(x.who || '')) >= 0) : [];
};
const meetOf = who => ofWho(who).find(x => x.kind === 'meet') || null;

/* 新人物第一次出现时记「相遇」（people.js 建档时调；老的 68 人是 2026-11-03 批量建档，
 * 那天不是真实相遇日，所以只对新人物生效，旧的不补假日期） */
function meet(who, name, date) {
  const w = String(who || '').trim();
  if (!w || w === 'self') return null;
  const had = meetOf(w);
  if (had) return had;
  return add({ date: date || todayStr(), what: '第一次相遇', who: w, name, kind: 'meet', type: 'auto' });
}

function mdOf(date) { return String(date || '').slice(-5); }          // 'YYYY-MM-DD' → 'MM-DD'
function daysBetween(a, b) {                                          // a<b 为正
  const p = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  const d = (p(b) - p(a)) / 86400000;
  return Number.isFinite(d) ? Math.round(d) : 0;
}
function yearsSince(date, today) {                                    // 只按年月日算整年
  const ay = +String(date).slice(0, 4), ad = mdOf(date);
  const ty = +String(today).slice(0, 4);
  if (!ay) return 0;
  const passed = mdOf(today) >= ad;
  return ty - ay - (passed ? 0 : 1);
}

/* 今天正好是哪个日子（周年/相遇纪念日）→ 一句话；没有就 '' */
function todayLine(today) {
  const t = today || todayStr();
  const hits = all().filter(x => mdOf(x.date) === mdOf(t) && String(x.date) !== t);   // 当年当天不算「几周年」
  const exact = all().filter(x => x.date === t);
  const out = [];
  for (const h of hits) {
    const y = yearsSince(h.date, t);
    out.push(h.what + (y > 0 ? '（第 ' + y + ' 年）' : ''));
  }
  for (const e of exact) out.push(e.what);
  return out.length ? out.join('、') : '';
}

/* 常驻提示词：她自己的日子（只有 2~4 行，没记录就整段不出现） */
function promptLines(today) {
  const me = selfItems().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!me.length) return '';
  const lines = me.map(x => '- ' + x.date + '　' + x.what).join('\n');
  const t = today || todayStr();
  const tl = todayLine(t);
  return '## 你自己的日子（你记得的，聊天里用得着就提）\n' + lines
    + (tl ? '\n- **今天就是：' + tl + '**' : '')
    + '\n有人问起就照这里答，别现编日期。';
}

/* 按人一行：这一轮跟你说话的人，你俩第一次见面是哪天（没有记录就返回 ''） */
function personLine(who, today) {
  const m = meetOf(who);
  if (!m) return '';
  const t = today || todayStr();
  const n = daysBetween(m.date, t);
  const y = yearsSince(m.date, t);
  let tail = '';
  if (mdOf(m.date) === mdOf(t) && y >= 1) tail = '，今天正好是第 ' + y + ' 年';
  else if (n >= 1) tail = '，到今天第 ' + (n + 1) + ' 天';
  return '- 你和' + (m.name || '这个人') + '第一次见面是 ' + m.date + tail + '。';
}

module.exports = {
  FILE, load, save, all, add, normDate, parse, todayStr, mdOf, daysBetween, yearsSince,
  selfItems, ofWho, meetOf, meet, todayLine, promptLines, personLine,
};
