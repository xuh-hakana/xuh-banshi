/* ===== 暂停/允许（主人 2026-10-23 凌晨定）=====
 * 主人私聊说「暂停某群的对话 / 暂停某人的私聊」→ 她在那个范围里直接停止一切发言，
 * 直到主人说「允许xx」，或者暂停时带时间单位（分钟/小时/天）到点自动恢复。
 * 范围内：所有回复、凑热闹、接话题、进群问候……全部不发；聊天记录照常记（记录不是发言）。
 * 骰子、笑点解析、攻略这类功能触发也一并停——「停止一切发言」就是一切。
 * 例外：主人的私聊命令永远能用（不然停了就解不开了）。 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data', 'pause.json');

let _cfg = null;
function init(c) { _cfg = c || {}; cleanup(); }

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function save(list) {
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 1), 'utf8'); } catch (e) { console.error('[pause] 存盘失败', e.message); }
}
function cleanup() {
  const now = Date.now();
  const list = load().filter(x => x && x.kind && x.id && (!x.until || x.until > now));
  return list;
}

function pause(kind, id, durMs) {
  const list = cleanup();
  const until = durMs > 0 ? Date.now() + durMs : 0;
  const ex = list.find(x => x.kind === kind && x.id === String(id));
  if (ex) { ex.until = until; ex.t = new Date().toISOString(); }
  else list.push({ kind, id: String(id), until, t: new Date().toISOString() });
  save(list);
}
function allow(kind, id) {
  save(cleanup().filter(x => !(x.kind === kind && x.id === String(id))));
}
// 是否被暂停：kind 'group'/'person'；0 或过去的时间戳 = 一直停到允许
function isPaused(kind, id) {
  const now = Date.now();
  return load().some(x => x.kind === kind && x.id === String(id) && (!x.until || x.until > now));
}
function listAll() { return cleanup(); }

/* 消息要不要闭嘴：isPrivate + user_id + group_id。
 * 主人（masterQQ / masters）的**私聊**永远不拦——遥控权优先，不然停了就解不开；
 * 但主人在**被暂停的群里**说话，她也得闭嘴（主人 2026-10-23 真事：
 * 「暂停100000000」之后她在群里回「我去」「看来并非」，主人当场说「这个暂停没有用啊」——
 * 因为以前主人一律豁免，群里也被豁免了）。
 * 群里解暂停靠命令：暂停/允许命令在暂停闸**之前**处理，所以照样能解开。 */
function blocked(isPrivate, uid, gid) {
  const m = _cfg || {};
  const masters = [String(m.masterQQ || ''), ...(m.masters || []).map(String)].filter(Boolean);
  if (isPrivate && masters.includes(String(uid))) return false;
  if (isPrivate) return isPaused('person', uid);
  return isPaused('group', gid);
}

const DUR_RE = /(\d+(?:\.\d+)?)\s*(分钟|分|小时|时|天|日)\s*$/;
function parseDur(s) {
  const m = String(s || '').match(DUR_RE);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === '分钟' || unit === '分') return n * 60000;
  if (unit === '小时' || unit === '时') return n * 3600000;
  return n * 86400000;                                // 天 / 日
}
function humanDur(ms) {
  if (!ms) return '';
  if (ms % 3600000 === 0 && ms >= 3600000) return (ms / 3600000) + '小时';
  if (ms % 60000 === 0) return (ms / 60000) + '分钟';
  return Math.round(ms / 60000) + '分钟';
}

/* 命令解析（只处理主人私聊）：
 *   暂停群100000000 / 暂停 100000000 / 暂停群100000000 30分钟
 *   暂停私聊100000000 / 暂停私聊 欧尼酱 / 暂停欧尼酱 2小时
 *   允许群100000000 / 允许欧尼酱
 *   暂停列表 / 查看暂停
 * 返回 null = 不是暂停命令，继续走聊天。 */
function parseCommand(text, people, isKnownGroup) {
  const t = String(text || '').trim();
  const ppl = people || {};
  const knownGroup = isKnownGroup || (() => false);

  if (/^(暂停列表|查看暂停|暂停状态)$/.test(t)) {
    const list = listAll();
    if (!list.length) return { msg: '现在没有暂停中的。' };
    return {
      msg: '暂停中的有 ' + list.length + ' 个：\n' + list.map(x =>
        '- ' + (x.kind === 'group' ? '群' : '私聊') + x.id
        + (x.until ? '（还剩 ' + humanDur(x.until - Date.now()) + '）' : '（到你允许为止）')
      ).join('\n'),
    };
  }

  const m = t.match(/^(暂停|停止|允许|开启)\s*(群|私聊)?\s*(.+?)\s*$/);
  if (!m) return null;
  const isAllow = m[1] === '允许' || m[1] === '开启';
  const kindWord = m[2] || '';
  let target = m[3].trim();

  // 目标 + 时长拆开（时长只能是数字+单位，跟在最后）
  let durMs = 0;
  const dm = target.match(DUR_RE);
  if (dm) { durMs = parseDur(target); target = target.slice(0, dm.index).trim(); }
  if (!target) return { msg: '要说清楚暂停哪个群/哪个人哦，比如「暂停群100000000 30分钟」。' };

  // 名字 → QQ（称呼表），纯数字 → 群号或QQ号
  let kind = '', id = '', shown = '';
  const nameHit = Object.entries(ppl).find(([qq, name]) => name === target);
  if (kindWord === '群' || /^\d{5,12}$/.test(target) && !nameHit && knownGroup(target)) {
    if (!/^\d{5,12}$/.test(target)) return { msg: '群要用群号暂停（我这里只认群号），比如「暂停群100000000」。' };
    kind = 'group'; id = target; shown = '群' + target;
  } else if (nameHit || /^\d{5,12}$/.test(target) || kindWord === '私聊') {
    if (nameHit) { kind = 'person'; id = nameHit[0]; shown = nameHit[1] + '（' + nameHit[0] + '）的私聊'; }
    else if (/^\d{5,12}$/.test(target)) { kind = 'person'; id = target; shown = 'QQ' + target + '的私聊'; }
    else return { msg: '这个人我不认识，用 QQ 号暂停吧：「暂停私聊 QQ号」。' };
  } else {
    return null;                                        // 不是暂停命令，当聊天继续走
  }

  if (isAllow) {
    const had = isPaused(kind, id);
    if (had) allow(kind, id);
    return { msg: had ? '好，' + shown + '恢复对话啦。' : shown + '本来就没在暂停。' };
  }
  pause(kind, id, durMs);
  return { msg: '好，' + shown + '我闭嘴啦' + (durMs ? '，' + humanDur(durMs) + '后自己恢复。' : '，你说「允许」我再开口。') };
}

module.exports = {
  init, pause, allow, isPaused, blocked, listAll, parseCommand,
  _test: { parseDur, humanDur, cleanup, DUR_RE },
};
