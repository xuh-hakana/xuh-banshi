/*
 * profile-sync.js — 非 QQ 平台的**真实昵称**同步（2026-11-22 她令）
 *
 * 为什么：她要求「群名片和人物表要读真实的资料卡更新的」，也要 B站 昵称进名字表。
 * 群里/私聊的 QQ 资料卡由 connectors/qq.js 的 syncProfilesOnce 拉；
 * B站没有事件就一直空着，所以这里用 B站 的公开资料接口补：
 *   GET https://api.bilibili.com/x/web-interface/card?mid=<uid>  → card.name（昵称）
 * 走 bili-space.profile（已有 1 小时缓存 + 风控退避），不登录也能读。
 *
 * 写入：people.save(o, { allowIdentity: 'qqsync' }) —— 允许覆盖 nick（真实资料是权威），
 * 旧值进 nickHistory，之后当「曾用名」参与认人，不碰真名。
 */
const people = require('./people');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 拉一个 B站 账号的真实昵称，写进人物表。返回 true = 有变化。 */
async function refreshOne(pid, platform, id) {
  const plat = String(platform || '').toLowerCase();
  if (plat !== 'bili') return false;
  const mid = String(id || '').replace(/\D/g, '');
  if (!mid) return false;
  let prof = null;
  try { prof = await require('./bili-space').profile(mid); } catch { return false; }
  const name = String((prof && prof.name) || '').trim().slice(0, 40);
  if (!name) return false;
  const o = people.load();
  const p = o[String(pid)];
  if (!p) return false;
  const acc = (p.accounts || []).find(a => String(a.platform) === 'bili' && String(a.id) === mid);
  if (!acc) return false;
  if (String(acc.nick || '') === name) return false;
  acc.nick = name;
  p.at = Date.now();
  const ok = people.save(o, { allowIdentity: 'qqsync' });
  if (ok) console.log('[资料卡] B站昵称更新：' + mid + ' → ' + name);
  return ok;
}

/* 批量刷新所有已建档 B站 账号的昵称。
 * 限量 + 串行：B站 对 /x/web-interface/card 也会风控（412），一次最多 20 个、间隔 1.2 秒。 */
async function syncBiliNames(opt) {
  const o = opt || {};
  const limit = Math.max(1, Math.min(60, Number(o.limit) || 20));
  const list = [];
  for (const p of people.all()) {
    for (const a of (p.accounts || [])) {
      if (String(a.platform) !== 'bili') continue;
      list.push({ pid: p.pid, id: String(a.id), nick: String(a.nick || '') });
    }
  }
  let changed = 0, tried = 0;
  for (const it of list.slice(0, limit)) {
    tried++;
    try { if (await refreshOne(it.pid, 'bili', it.id)) changed++; } catch { /* 单个失败不影响别的 */ }
    await sleep(1200);
  }
  console.log('[资料卡] B站昵称同步：' + tried + '/' + list.length + ' 个，更新 ' + changed + ' 个');
  return { ok: true, total: list.length, tried, changed };
}

module.exports = { refreshOne, syncBiliNames };
