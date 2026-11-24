/* ===========================================================================
 * conv-settings.js — 按「会话」单独调的东西（主人 2026-11-07 定）
 *
 * 这是干什么的：一个群的上下文留多少条、这个群要不要回话、这个群是不是黑名单，
 *   全部按会话各存一份，改哪个群只影响那个群。
 *
 * 键怎么定：用 core.histKey 的写法（`qq_<群号>` / `qq_<QQ号>` / `bili_<UID>`）。
 *   为什么不用聊天页那个 `群100000000` / `p_p_master`：
 *   机器人回复时手里只有 QQ 号和群号（没有人物 id），两边要对得上只能是这一套。
 *
 * 存在哪：data/conv-settings.json，原子写（tmp + rename），改完立刻生效、不用重启。
 *
 * 五个字段（没写 = 用全局默认）：
 *   ctx    上下文条数。0 或缺 = 用 config.context.historyLimit
 *   chars  输出字数上限。0 或缺 = 用全局默认（modelLimits 点名的模型用它自己的，其余用 llm.maxTokens）；
 *          设了就以这个为准（2026-11-14 主人令：冲突时人的设置优先）。
 *   reply  false = 这个会话不回话（记录照旧，只看不回）
 *   black  true  = 黑名单：不回话，也不学说话（记录照旧，方便你事后翻）
 *   off    true  = 总开关关掉的会话：不看也不回（连聊天记录都不落，直接丢）
 *   model  'local' = 这个会话本地模型优先（本地排链首；本地断连 / 没配好时云端照常兜底回话）；
 *          缺省或任何其它值 = 全部模型（走正常优先级排序）。见 core.js callLLM。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const platLimits = require('./platform-limits');  // 2026-11-17：手填字数不能超过平台上限

/* 存在哪：src/data/conv-settings.json（和其它 data 文件同一处，跟着 data 备份一起走）。
 * 路径按 src/ 下这个文件自身算，不写死也不往外跳一级 —— 别像上次那样落到项目根的 data/。 */
const FILE = path.join(__dirname, 'data', 'conv-settings.json');

let cache = null;
let stamp = 0;

function normKey(k) {
  let s = String(k || '').trim();
  // B站私信的历史键是 bili_dm:<uid>（core.histKey('bili', 'dm:' + uid)），聊天页给人设的键是 bili_<uid>。
  // 同一个人两种写法在这里并成一个，不然面板里给他设的字数对私信不生效（2026-11-14）。
  s = s.replace(/^bili_dm:/i, 'bili_');
  // 只收「平台_号」这种形状；别的一律不认，避免把界面上的会话名误当键写进文件
  if (!/^[a-z]+_[\w.-]{1,40}$/i.test(s)) return '';
  return s;
}

function readAll() {
  let st = 0;
  try { st = fs.statSync(FILE).mtimeMs; } catch { return {}; }
  if (cache && st === stamp) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = (j && typeof j === 'object') ? j : {};
  } catch { cache = {}; }
  stamp = st;
  return cache;
}

function writeAll(obj) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = obj;
  try { stamp = fs.statSync(FILE).mtimeMs; } catch { stamp = 0; }
}

/* 读一个会话的设置。没设过返回 {}，调用方自己决定默认值。 */
function get(key) {
  const k = normKey(key);
  if (!k) return {};
  const one = readAll()[k];
  return (one && typeof one === 'object') ? one : {};
}

/* 改一个会话的设置。patch 里只写要改的字段；传 null 表示删掉这个字段（回到默认）。 */
function set(key, patch) {
  const k = normKey(key);
  if (!k) return { ok: false, error: '会话键不对' };
  const all = Object.assign({}, readAll());
  const cur = Object.assign({}, all[k] || {});
  const p = patch || {};
  if ('ctx' in p) {
    const n = Math.round(Number(p.ctx) || 0);
    if (n <= 0) delete cur.ctx; else cur.ctx = Math.min(500, Math.max(2, n));
  }
  if ('chars' in p) {
    // 0 / 空 = 删掉这个字段，回到全局默认（界面上的「用默认」就是发 0 过来）
    // 2026-11-17 主人令：手填不能超过平台本身的限制。按会话键判平台，夹到对应 cap。
    // bili_ 键评论/私信共用，取较大的 biliD，避免把私信的上限误压到评论那么小。
    const n = Math.round(Number(p.chars) || 0);
    if (n <= 0) delete cur.chars;
    else {
      const plat = /^bili_/i.test(k) ? 'biliD' : 'qq';
      const cap = platLimits.capOf(plat) || 8192;
      cur.chars = Math.min(cap, Math.max(20, n));
    }
  }
  if ('reply' in p) {
    // true = 恢复默认（删字段）；false = 只看不回；null/undefined = 恢复默认（面板「恢复默认」会传 null）。
    // 以前只认 true，传 null 会被当成 false 写进去——「恢复默认」反而把会话关成不回话（2026-11-19 查出）。
    if (p.reply === false || p.reply === 'false') cur.reply = false;
    else delete cur.reply;
  }
  if ('black' in p) {
    if (p.black === true || p.black === 'true') cur.black = true; else delete cur.black;
  }
  // 总开关：单会话关掉 = 不看也不回。以前只有 setBulk 写 off，set() 静默吞掉还回 ok，
  // 才出现「面板说关闭成功、实际没生效」。现在和批量走同一个字段，关掉后 qq.js 的 isOff 真拦。
  if ('off' in p) {
    if (p.off === true || p.off === 'true') cur.off = true; else delete cur.off;
  }
  if ('model' in p) {
    // 只认 'local'；任何其它值（含 'all' / '' / 缺省）都视为回到默认（全部模型）
    if (p.model === 'local') cur.model = 'local'; else delete cur.model;
  }
  if (Object.keys(cur).length) all[k] = cur; else delete all[k];
  writeAll(all);
  return { ok: true, key: k, one: all[k] || {} };
}

function all() { return Object.assign({}, readAll()); }

/* 上下文条数：设过就用设的，没设返回 0（调用方回落到 config.context.historyLimit） */
function limitOf(key) {
  const n = Math.round(Number(get(key).ctx) || 0);
  return n > 0 ? n : 0;
}

/* 输出字数上限：设过就用设的，没设返回 0（调用方回落到 modelLimits / llm.maxTokens） */
function charsOf(key) {
  const n = Math.round(Number(get(key).chars) || 0);
  return n > 0 ? n : 0;
}

/* 这个会话要不要回话：黑名单一律不回；reply:false 不回。 */
function replyOk(key) {
  const one = get(key);
  if (one.black) return false;
  return one.reply !== false;
}

/* 这个会话是不是黑名单（学习、记录人物信息也该一并停掉） */
function isBlack(key) { return !!get(key).black; }

/* 这个会话是不是被总开关关掉了（不看也不回）：关掉 = 连记录都不落。 */
function isOff(key) { return !!get(key).off; }

/* 批量改：把一组会话的 off 标志一起置成 off（true = 不看也不回：连聊天记录都不落，直接丢；
 * false = 清掉 off 标志 → 回到「按 reply / black 各自决定」的默认）。一次读、一次写，不循环 rename。
 * 不动 reply / black：那是主人单独打的标记，总开关不该抹掉。skip：关闭时（off=true）要跳过的一组键
 * （比如主人的私聊，保持 QQ 遥控权，和 pause 一致：主人私聊命令永远能解开）。 */
function setBulk(keys, off, skip) {
  const arr = Array.isArray(keys) ? keys : [];
  const skipSet = (skip && typeof skip === 'object') ? skip : null;
  const all = Object.assign({}, readAll());
  let count = 0;
  for (const k0 of arr) {
    const k = normKey(k0);
    if (!k) continue;                                  // 形状不对的键不认，避免误写
    if (skipSet && skipSet.has(k)) continue;
    const cur = Object.assign({}, all[k] || {});
    if (off === true) {
      if (!cur.off) { cur.off = true; count++; }          // 不看也不回
    } else {
      if (cur.off) { delete cur.off; count++; }           // 回到默认（按 reply/black 决定）
    }
    if (Object.keys(cur).length) all[k] = cur; else delete all[k];
  }
  writeAll(all);
  return { ok: true, count };
}

/* 把聊天页那个会话键翻译成设置键（两边唯一的桥）。
 * 群：群100000000 → qq_894917172
 * QQ 私聊：p_<人物id> → qq_<QQ号>（必须带 uid，translater 拿不到 uid 就返回空）
 * 别的平台：bili_<人物id> → bili_<UID>
 * 早期记录 / 全部消息：没有可设的东西，返回空。 */
function keyOfConv(conv, uid, kind) {
  const cv = String(conv || '');
  const id = String(uid || '').replace(/[^0-9A-Za-z_.-]/g, '');
  if (!cv || cv === '__all' || cv === '__orphan' || cv === '__private' || cv === '__group') return '';
  if (cv.indexOf('群') === 0) {
    const gid = cv.slice(1).replace(/\D/g, '');
    return gid ? 'qq_' + gid : '';
  }
  if (!id) return '';
  const plat = String(kind || 'qq');
  return normKey(plat + '_' + id);
}

module.exports = { get, set, all, limitOf, charsOf, replyOk, isBlack, isOff, keyOfConv, setBulk, FILE };
