/* ===========================================================================
 * prompt-slots.js — 聊天记录页「本轮输出的提示词」槽位正本（2026-11-13 主人令）
 *
 * 这是干什么的：每轮回复前拼好、真正发给大模型的那组提示词，按来源钉住一条给主人看。
 *   - 分三区写：群 / 私聊 / 平台（按群/私聊/平台分类各写一次）。
 *   - 每个来源（k）一个槽位、只存一条**完整**提示词（整组消息，不压空白、不截断）。
 *   - 写满后不再覆盖：她正在看的那轮不会被下一轮刷掉。
 *   - 她删掉某槽 → 槽位空 → 这个来源下一轮回复时自动补一条新的（缺位后自动补一次）。
 *
 * 为什么单独一份文件：机器人进程（core.js）写、面板进程（panel.js）读 / 删，
 *   两边共用这一处的路径与结构，不各写一套（铁律：不能有双份）。
 *   跨进程同步用 mtime 缓存 + 原子写（tmp + rename），和 conv-settings.js 同一套。
 *
 * 存在哪：src/data/prompt-slots.json（跟着 data 备份一起走；运行时才生成，不预建空文件）。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'prompt-slots.json');
const CATS = ['group', 'private', 'platform'];
const CAT_LABEL = { group: '群', private: '私聊', platform: '平台' };

let cache = null;
let stamp = 0;

function blank() { return { group: {}, private: {}, platform: {} }; }

function readAll() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return blank(); }
  if (cache && st === stamp) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const o = blank();
    if (j && typeof j === 'object') {
      for (const c of CATS) if (j[c] && typeof j[c] === 'object') o[c] = j[c];
    }
    cache = o;
  } catch { cache = blank(); }
  stamp = st;
  return cache;
}

/* 浅拷一层再改：readAll 返回的是缓存引用，直接改会让别的读者看到写了一半的状态。 */
function copyOf(src) {
  const o = blank();
  for (const c of CATS) o[c] = Object.assign({}, src[c] || {});
  return o;
}

function writeAll(o) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = o;
  try { stamp = fs.statSync(FILE).mtimeMs; } catch { stamp = 0; }
}

/* 只认「平台_号」形状。selfcheck 的自检键是 'selfcheck#probe'（带 #），
 * 一律不收——它不该占一个槽位。和 conv-settings.js 同一把尺子。 */
function normKey(k) {
  const s = String(k || '').trim();
  if (!/^[a-z]+_[\w.-]{1,40}$/i.test(s)) return '';
  return s;
}

/* 分类只认三处事实，不靠猜：
 *   k 不以 qq_ 开头            → 平台（bili_room / 其它平台）
 *   qq_ 且本轮 ctx.gid > 0     → 群
 *   qq_ 其余                   → 私聊
 * turnCtx 来自 core.chat 的 activeTurns.get(k)：qq.js setTurn 时写了 source / gid，
 * 私聊 gid 固定为 0（见 connectors/qq.js turnCtx）。
 * 注意：k 本身是 qq_<群号> / qq_<QQ号>，光看键分不出群和私聊，必须借 ctx.gid。 */
function catOf(k, turnCtx) {
  const key = normKey(k);
  if (!key) return '';
  if (!/^qq_/i.test(key)) return 'platform';
  const gid = Number((turnCtx || {}).gid || 0);
  return gid > 0 ? 'group' : 'private';
}

/* 显示名兜底（前端会优先用聊天记录里现成的 convLabel 覆盖它，这里不编名字）：
   群名查 qmeta 群名表；私聊 / 平台直接写键。查不到就退回「群号 / 私聊 号 / 键」。 */
function labelOf(cat, k) {
  const key = normKey(k);
  if (cat === 'group') {
    const gid = key.replace(/^qq_/i, '');
    try {
      const g = require('./qq-meta').groupLabel('群' + gid);
      if (g && g !== '群' + gid) return g + ' · ' + gid;
    } catch {}
    return '群' + gid;
  }
  if (cat === 'private') return '私聊 ' + key.replace(/^qq_/i, '');
  return key;
}

/* 每轮调一次：槽位空才写，写满直接跳过（钉住语义）。
 * msgs 是 buildMessages() 产出的整组 {role,content}，原样存，不压 \s、不截断。
 * content 可能是多模态数组，也原样留着（JSON 能装）。 */
function record(k, msgs, turnCtx) {
  const key = normKey(k);
  const cat = catOf(k, turnCtx);
  if (!key || !cat || !Array.isArray(msgs) || !msgs.length) return { ok: false, why: '空或键不合规' };
  const all = copyOf(readAll());
  if (all[cat][key]) return { ok: false, why: '已钉住' };
  const messages = msgs.map(m => ({
    role: String((m && m.role) || ''),
    content: (m && m.content !== undefined) ? m.content : '',
  }));
  all[cat][key] = {
    t: new Date().toISOString(),
    k: key,
    cat,
    label: labelOf(cat, key),
    trigger: String((turnCtx || {}).text || ''),   // 触发这轮的那句话，原样不截断（方便认是哪一轮）
    messages,
  };
  writeAll(all);
  return { ok: true, cat, k: key };
}

/* 删一个槽。删前强制重读一次盘（绕过 mtime 缓存），免得把机器人刚写的一条覆盖掉。 */
function remove(cat, k) {
  const c = String(cat || '');
  const key = normKey(k);
  if (CATS.indexOf(c) < 0 || !key) return { ok: false, error: '参数不对' };
  cache = null; stamp = 0;
  const all = copyOf(readAll());
  if (!all[c][key]) return { ok: true, removed: false };
  delete all[c][key];
  writeAll(all);
  return { ok: true, removed: true };
}

function list() { return readAll(); }

module.exports = { FILE, CATS, CAT_LABEL, catOf, labelOf, record, remove, list };
