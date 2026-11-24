/*
 * people-cmd.js — 聊天里录入人物 / 全平台账号（多端互通，2026-11-03）
 *
 * 主人在私聊里发这三种：
 *   绑定 <平台> <账号> 到 <人物名>     把这个账号挂到那个人物名下（没有这个人物就新建）
 *   新人物 <名字> <平台> <账号>         新建一个人物并挂上这个账号
 *   把 <人物A> 合并到 <人物B>           A 的账号并进 B（B 保留），好感度相加封顶 100
 *
 * 平台写 qq / bili（QQ、企鹅、腾讯、B站、哔哩哔哩 都认）。
 * 人物可以用：人物ID / 名字 / 昵称 / 代称 / 账号号 来指。
 * 返回 {msg} = 要回她的话；返回 null = 这句话不是命令，交给别处处理。
 */
const people = require('./people');
const { botWrite } = require('./wlog');

const PLAT = {
  qq: 'qq', 'qq': 'qq', '企鹅': 'qq', '企鹅号': 'qq', 'qq号': 'qq', '腾讯': 'qq', '腾讯qq': 'qq',
  bili: 'bili', bilibili: 'bili', 'b站': 'bili', '哔哩': 'bili', '哔哩哔哩': 'bili',
};
function plat(s) {
  const raw = String(s || '').trim();
  return PLAT[raw.toLowerCase()] || PLAT[raw] || '';
}
const PLAT_CN = { qq: 'QQ', bili: 'B站' };

function label(pid) {
  const p = people.get(pid);
  if (!p) return '（没了）';
  if (p.name) return p.name;
  const accs = p.accounts || [];
  const withNick = accs.find(a => a.nick);
  if (withNick) return withNick.nick;
  const a = accs[0];
  return a ? (PLAT_CN[a.platform] || a.platform) + ' ' + a.id : '（没名字）';
}
function accText(pid) {
  const p = people.get(pid);
  if (!p) return '';
  return (p.accounts || []).map(a => (PLAT_CN[a.platform] || a.platform) + ' ' + a.id).join('、');
}

/* 按 人物ID / 名字 / 昵称 / 代称 / 账号号 找人。找不到返回 null；有多个同名返回 {ambiguous:[...]} */
function findPerson(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const o = people.load();
  if (o[k]) return { pid: k };
  if (/^\d{4,12}$/.test(k)) {
    const pid = people.findByAccount('qq', k) || people.findByAccount('bili', k);
    if (pid) return { pid };
  }
  const hit = Object.keys(o).filter(pid => {
    const p = o[pid];
    const accs = p.accounts || [];
    const al = accs.flatMap(a => String(a.alias || '').split(/[、｜|,，;；]/).map(x => x.trim()).filter(Boolean));
    const nicks = accs.map(a => String(a.nick || '')).filter(Boolean);
    return (p.name && p.name === k) || nicks.includes(k) || al.includes(k);
  });
  if (hit.length === 1) return { pid: hit[0] };
  if (hit.length > 1) return { ambiguous: hit.map(pid => label(pid)) };
  return null;
}
function bad(res, key) {
  if (res && res.ambiguous) {
    return '「' + key + '」有好几个：' + res.ambiguous.join('、') + ' —— 说具体点';
  }
  return '没找到「' + key + '」这个人';
}

function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  /* 把 A 合并到 B */
  let m = t.match(/^(?:把)?\s*(.+?)\s*合并到\s*(.+?)\s*$/);
  if (m) {
    const a = findPerson(m[1]), b = findPerson(m[2]);
    if (!a) return { msg: bad(a, m[1]) };
    if (!b) return { msg: bad(b, m[2]) };
    if (a.pid === b.pid) return { msg: '这两个本来就是同一个人，不用合' };
    const kept = label(b.pid), gone = label(a.pid);
    people.merge(b.pid, a.pid);          // A 并进 B，B 保留
    botWrite('data/people.json', '人物', '合并 ' + gone + ' → ' + kept);
    return { msg: '合好了：' + kept + ' 现在有 ' + accText(b.pid) + '，好感度 ' + people.getFavor(b.pid) };
  }

  /* 新人物 <名字> <平台> <账号> */
  m = t.match(/^新人物\s+(.+?)\s+(\S+)\s+(\d{4,12})\s*$/);
  if (m) {
    const nm = m[1].trim(), pf = plat(m[2]), id = m[3];
    if (!pf) return { msg: '平台只认 qq 或 bili（QQ、企鹅、B站、哔哩哔哩 都行）' };
    const owner = people.findByAccount(pf, id);
    if (owner) {
      return { msg: (PLAT_CN[pf] || pf) + ' ' + id + ' 已经在「' + label(owner) + '」名下了 —— 要归到别处就用「把X合并到Y」' };
    }
    // 同名人物已存在就直接挂上去，不造重复的人
    const exist = findPerson(nm);
    let pid;
    if (exist && exist.pid) { pid = exist.pid; people.addAccount(pid, pf, id); }
    else { pid = people.ensure(pf, id, { name: nm }); }
    botWrite('data/people.json', '人物', '新建 ' + nm + '（' + (PLAT_CN[pf] || pf) + ' ' + id + '）');
    return { msg: '记好了：「' + label(pid) + '」现在有 ' + accText(pid) + '，好感度 ' + people.getFavor(pid) };
  }

  /* 绑定 <平台> <账号> 到 <人物名> */
  m = t.match(/^绑定\s+(\S+)\s+(\d{4,12})\s*到\s+(.+?)\s*$/);
  if (m) {
    const pf = plat(m[1]), id = m[2], target = m[3].trim();
    if (!pf) return { msg: '平台只认 qq 或 bili（QQ、企鹅、B站、哔哩哔哩 都行）' };
    const owner = people.findByAccount(pf, id);
    const tgt = findPerson(target);
    if (tgt && tgt.ambiguous) return { msg: bad(tgt, target) };
    if (!tgt) {
      // 人物还没有 → 直接建一个
      const pid = people.ensure(pf, id, { name: target });
      botWrite('data/people.json', '人物', '新建 ' + target + '（' + (PLAT_CN[pf] || pf) + ' ' + id + '）');
      return { msg: '「' + target + '」是新人物，记好了：' + accText(pid) + '，好感度 ' + people.getFavor(pid) };
    }
    if (owner && owner !== tgt.pid) {
      return { msg: (PLAT_CN[pf] || pf) + ' ' + id + ' 现在在「' + label(owner) + '」名下 —— 想并过去就说「把' + label(owner) + '合并到' + label(tgt.pid) + '」' };
    }
    const added = people.addAccount(tgt.pid, pf, id);
    if (!added) return { msg: (PLAT_CN[pf] || pf) + ' ' + id + ' 已经在「' + label(tgt.pid) + '」名下了' };
    botWrite('data/people.json', '人物', '绑定 ' + (PLAT_CN[pf] || pf) + ' ' + id + ' → ' + label(tgt.pid));
    return { msg: '绑好了：「' + label(tgt.pid) + '」现在有 ' + accText(tgt.pid) + '，好感度 ' + people.getFavor(tgt.pid) };
  }

  return null;
}

module.exports = { parseCommand, findPerson, PLAT_CN };
