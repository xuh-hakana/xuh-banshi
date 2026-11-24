/*
 * state.js — 虚幻客户端的数据层
 *
 * 位置：src/server/state.js
 * 谁在用：app/main.js（Electron 主进程，通过 IPC 喂给界面）
 *
 * 铁律：这里是**唯一实现**。所有读写都直接调用已有模块，不另写一套：
 *   配置  → ../config    （四个分区：connect / features / llm / persona）
 *   触发词 → ../core      （面板与 QQ 私聊命令写的是同一份）
 *   好感度 → ../favor
 *   表情包 / 人物 / 开关 / 数值 → ./panel 里抠出来的函数
 * 面板（panel.js）也 require 同一批函数，所以两边看到的数据永远一致。
 *
 */
const fs = require('fs');
const path = require('path');
const panel = require('./panel');
const configStore = require('../config');
const core = require('../core');
const favor = require('../favor');
const people = require('../people');
const dates = require('../dates');            // 2026-11-19：删人时要连「第一次相遇」一起清
const learn = require('../learn');            // 2026-11-09：学习系统（好感事件 / 衰减 / 撤销），只转发不重写

const ROOT = path.join(__dirname, '..');

/* 出错不让整个客户端黑屏：单块数据坏了就返回错误标记，界面显示「这块读不出来 + 原因」 */
function safe(fn, fallback) {
  try { return fn(); } catch (e) { return Object.assign({ __error: e.message }, fallback || {}); }
}

/* ---------------- 读 ---------------- */

// 四块快数据（不含表情包——那个要扫 400 张图 + 对账，2 秒级，单独拉）
function snapshot() {
  return {
    at: Date.now(),
    people: safe(panel.readPeople, { list: [] }),
    // 平台表（QQ / B站 / 小红书 / 抖音 / 小黑盒…）：只有 people.js 一份，
    // 客户端建人物、加账号时的平台下拉直接读它，加平台不用改前端。
    platforms: safe(() => people.platforms(), []),
    triggers: safe(() => ({ list: core.readTriggers(), modes: core.TRIG_MODES }), { list: [], modes: {} }),
    features: safe(panel.featureStates, []),
    rules: safe(panel.rulesBook, []),
    bot: safe(() => ({
      masterQQ: String(configStore.load().masterQQ || ''),
      model: String((configStore.load().llm || {}).model || ''),
      wsUrl: String(configStore.load().napcatWsUrl || ''),
    }), {}),
  };
}

// 表情包快照（慢，单独一条 IPC）
function stickers() {
  return safe(panel.stickerSnapshot, { ok: false, imgs: [], groups: [], pools: {} });
}

/* ---------------- 写 ---------------- */

// 好感度：直接改 favor.json（和群里攒好感写的是同一个文件）
function setFavor(qq, v) {
  const id = String(qq || '').replace(/\D/g, '');
  if (!id) return { error: 'QQ 号不对' };
  const n = Math.max(-100, Math.min(100, Number(v) || 0));
  return { ok: true, qq: id, v: favor.set(id, n) };
}

// 称呼三件套：name（她确认的名字）/ alias（代称，最多 5 个）/ nick（资料卡名）
function setPerson(qq, field, value) {
  const id = String(qq || '').replace(/\D/g, '');
  if (!id) return { error: 'QQ 号不对' };
  const st = panel.readPeopleState();
  const rec = Object.assign({}, st[id] || {});
  const val = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  const f = String(field || '');
  // 旧按 QQ 的入口也要过代称锁定（客户端有的地方仍走这条）。
  if (f === 'alias') {
    const pid = people.findByAccount('qq', id);
    const p = pid ? people.get(pid) : null;
    if (p && p.review && p.review.alias && p.review.alias.state === 'locked') {
      return { error: '这个人的代称你已经确认锁定了，不许改' };
    }
  }
  if (f === 'name') { if (val) rec.name = val; else delete rec.name; }
  else if (f === 'alias') { const a = panel.normAlias(val); if (a) rec.alias = a; else delete rec.alias; }
  else if (f === 'nick') { if (val) rec.nick = val; else delete rec.nick; }
  else return { error: '只能改 name / alias / nick' };
  st[id] = rec;
  // 写盘结果必须如实回给界面（2026-11-22）：以前不管成没成都可以 ok:true。
  if (!panel.writePeopleState(st)) return { error: people.lastWriteError() || '没写进 people.json' };
  return { ok: true, qq: id, field: f, value: val };
}

/* ---------------- 多端互通：人物级操作（pid 维度，2026-11-03） ---------------- */
function personSetFavor(pid, v) {
  if (!people.get(pid)) return { error: '人物不存在' };
  const n = Math.max(0, Math.min(100, Number(v) || 0));
  // 面板手动改 = 主人的明确意图，带 force 越过锁定（锁定只拦机器人自动加/减，2026-11-13）
  return { ok: true, pid, v: people.setFavor(pid, n, { force: true }) };
}
/* 好感锁定开关（2026-11-13 主人令）：锁了以后群里夸她、衰减结算都改不动，只有面板手动改能变。 */
function personSetFavorLock(pid, on) {
  if (!people.get(pid)) return { error: '人物不存在' };
  return people.setFavorLock(pid, !!on);
}
function personSetField(pid, field, value) {
  const p = people.get(pid);
  if (!p) return { error: '人物不存在' };
  const f = String(field || '');
  /* 主人对某人的专属叫法（2026-11-22 她令）：注入里「昵称（主人称呼方式）」就是它。 */
  if (f === 'masterCall') {
    const ok = people.setMasterCall(pid, value);
    return ok ? { ok: true, pid, field: f, value: people.masterCallOf(pid) } : { error: '没写进去' };
  }
  /* 性别 / 身份（2026-11-22 她令）：面板人物卡里能直接改。
   * 身份只留「认识的人 / 陌生人」——朋友由朋友录（好感 > FRIEND_AT）决定，主人 / 欧尼酱按号认。 */
  if (f === 'sex' || f === 'role') {
    const raw = String(value == null ? '' : value).trim();
    if (f === 'sex') {
      const want = /女|female/.test(raw) ? 'female' : /男|male/.test(raw) ? 'male' : '';
      const r = want ? people.setSex(pid, want, 'confirmed') : null;
      return r ? { ok: true, pid, field: f, value: want, sexLabel: people.sexLabel(want) } : { error: '性别只能是 男 / 女' };
    }
    if (raw === 'friend') return { error: '朋友由朋友录决定：好感调到 20 以上就进朋友录了' };
    const r = people.setRole(pid, raw);
    return r ? { ok: true, pid, field: f, value: r } : { error: '身份只能选 认识的人 / 陌生人' };
  }
  if (!['name', 'nick', 'alias', 'suffix'].includes(f)) return { error: '只能改 name / nick / alias / suffix / sex / role' };
  // 代称属于「约定·代称」分支，锁定后不许改（主人 2026-11-12）。
  // 客户端走 IPC 直写 people.json，不经过 /api/people/set，所以这道闸必须放在这里。
  if (f === 'alias' && p.review && p.review.alias && p.review.alias.state === 'locked') {
    return { error: '这个人的代称你已经确认锁定了，不许改' };
  }
  const val = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  const patch = {};
  patch[f] = (f === 'alias') ? panel.normAlias(val) : val;
  // byUser：这条是她在面板里手动改的。people.save 的人名硬限制只认这个标记，
  // 脚本 / 模型 / 自动化改 name/nick/suffix 会被直接拒绝落盘（2026-11-13 主人令）。
  const ok = people.setState(pid, patch, { byUser: true });
  if (!ok) return { error: '没写进 people.json（人名只有面板手动改才生效，详见 bot 日志）' };
  return { ok: true, pid, field: f, value: val };
}
async function personAddAccount(pid, platform, id) {
  if (!people.get(pid)) return { error: '人物不存在' };
  const ok = people.addAccount(pid, platform, id);
  if (!ok) return { error: '账号已存在或无效' };
  /* 非 QQ 平台：加完立刻拉一次真实昵称（2026-11-22 她令：B站昵称也要进名字表）。
   * 拉不到不报错——账号已经加上了，昵称等下一次定时同步补。 */
  try { await require('../profile-sync').refreshOne(pid, platform, id); } catch {}
  return { ok: true, pid };
}
function personRemoveAccount(pid, platform, id) {
  if (!people.get(pid)) return { error: '人物不存在' };
  const accs = ((people.get(pid) || {}).accounts || []).map(a => ({ platform: String(a.platform), id: String(a.id) }));
  accs.push({ platform: String(platform), id: String(id) });
  const ok = people.removeAccount(pid, platform, id);
  if (!ok) return { error: '账号不存在' };
  /* 2026-11-19（主人问「面板是不是漏显示数据」查出来的）：
   * 删掉最后一个号时 people.json 里的人物会消失，可这个号在别的表里的残影还在——
   * favor.json 的好感、dates.json 的「第一次相遇」、qzone 的逛空间记录、learn 的学习目录。
   * 面板只读 people.json，所以这些残影「看不见」但活着；下次同一个号再出现，
   * 旧好感/旧相遇记录就一起回来了。人删了，残影必须一起清。 */
  if (!people.get(pid)) purgePersonLeftovers(pid, accs);
  return { ok: true, pid };
}

function purgePersonLeftovers(pid, accs) {
  const ids = new Set((accs || []).map(a => String(a.id)).filter(Boolean));
  // 好感（按 QQ 号存）
  try {
    if (ids.size) {
      const f = JSON.parse(fs.readFileSync(favor.FILE, 'utf8')) || {};
      let hit = false;
      for (const k of Object.keys(f)) if (ids.has(String(k).replace(/^[a-z]+:/, ''))) { delete f[k]; hit = true; }
      if (hit) fs.writeFileSync(favor.FILE, JSON.stringify(f, null, 1), 'utf8');
    }
  } catch {}
  // 第一次相遇 / 纪念日
  try {
    const d = dates.load();
    const before = d.items.length;
    d.items = d.items.filter(x => !ids.has(String(x.who || '').split(':').pop()));
    if (d.items.length !== before) dates.save(d);
  } catch {}
  // 逛空间记录
  try {
    const qp = path.join(__dirname, '..', 'data', 'qzone-comment-state.json');
    const q = JSON.parse(fs.readFileSync(qp, 'utf8')) || {};
    let hit = false;
    for (const sec of ['visited', 'commented']) {
      if (!q[sec] || typeof q[sec] !== 'object') continue;
      for (const k of Object.keys(q[sec])) if (ids.has(String(k).split('|')[0])) { delete q[sec][k]; hit = true; }
    }
    if (Array.isArray(q.skipped)) {
      const n = q.skipped.length;
      q.skipped = q.skipped.filter(x => !ids.has(String(x.qq || '')));
      if (q.skipped.length !== n) hit = true;
    }
    if (hit) fs.writeFileSync(qp, JSON.stringify(q, null, 1), 'utf8');
  } catch {}
  // 学习目录（按 pid 存，人没了就是孤儿）
  try {
    const dir = path.join(__dirname, '..', 'data', 'learn', 'users', String(pid));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
function personMerge(intoPid, fromPid) {
  if (!people.get(intoPid) || !people.get(fromPid)) return { error: '人物不存在' };
  const ok = people.merge(intoPid, fromPid);
  return ok ? { ok: true, into: intoPid, from: fromPid } : { error: '合并失败（可能是同一个人）' };
}
function personCreate(name, platform, id) {
  const pid = people.ensure(platform, id, { name: String(name || '').trim() });
  return pid ? { ok: true, pid } : { error: '账号无效' };
}

// 触发词：增 / 删 / 开关（全部走 core，和 QQ 私聊命令同源）
function trigAdd(word, mode, opt) { return core.triggerAdd(word, mode, opt || {}); }
function trigDel(id) { return core.triggerDel(id); }
function trigToggle(id, on) { return core.triggerToggle(id, !!on); }

/*
 * 功能开关：只有 featureStates 里 key 不以 _ 开头的能改。
 * 写回 config 的对应字段（和面板改的是同一份 config）。
 */
const SWITCH_SET = {
  autoAsk: j => { j.autoAsk = j.autoAsk || {}; return j.autoAsk; },
  chime: j => { j.chime = j.chime || {}; return j.chime; },
  topic: j => { j.topic = j.topic || {}; return j.topic; },
  merge: j => { j.merge = j.merge || {}; return j.merge; },
  webSearch: j => { j.webSearch = j.webSearch || {}; return j.webSearch; },
  pokemon: j => { j.webSearch = j.webSearch || {}; return j.webSearch; },
  moegirl: j => { j.webSearch = j.webSearch || {}; return j.webSearch; },
  'learn.enabled': j => { j.learn = j.learn || {}; return j.learn; },
  'learn.decay':    j => { j.learn = j.learn || {}; return j.learn; },
  'learn.warm':     j => { j.learn = j.learn || {}; return j.learn; },
  'learn.acts':     j => { j.learn = j.learn || {}; return j.learn; },
};
function setSwitch(key, on) {
  const k = String(key || '');
  if (k.startsWith('_') || !SWITCH_SET[k]) return { error: '这一项不是开关，改不了' };
  const j = configStore.load();
  const box = SWITCH_SET[k](j);
  if (k.indexOf('.') > 0) box[k.split('.')[1]] = !!on;       // 嵌套键：learn.decay → learn.decay
  else if (k === 'pokemon' || k === 'moegirl') box[k] = !!on; // 都在 webSearch 下
  else box.enabled = !!on;
  configStore.writeFull(j);
  return { ok: true, key: k, on: !!on };
}
// 「嫌我蠢识别」是个概率值，单独一条
function setCritic(p) {
  const j = configStore.load();
  j.critic = j.critic || {};
  j.critic.p = Math.max(0, Math.min(1, Number(p) || 0));
  configStore.writeFull(j);
  return { ok: true, p: j.critic.p };
}
/*
 * 数值：rulesBook 里的 e 项（如 merge.masterWaitMs）带 k / scale / unit，
 * 换算规则和面板的 /api/cfgset 完全一致——单位交给界面显示，存的是毫秒/比例。
 */
function setNum(k, v) {
  const meta = panel.CFG_EDIT_MAP[String(k || '')];
  if (!meta) return { error: '这一项不在这里改：' + k };
  const num = Number(v);
  if (!Number.isFinite(num)) return { error: '要填数字' };
  const store = Math.round(num * meta.scale * 1000) / 1000;
  if (store < 0) return { error: '不能是负数' };
  const conf = configStore.load();
  const parts = String(k).split('.');
  let cur = conf;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = store;
  configStore.writeFull(conf);
  return { ok: true, k, v: num, stored: store };
}

// 表情包关键词模糊搜索的兜底开关（1 开 / 0 关）
function setKwFuzzy(on) {
  const j = configStore.load();
  j.sticker = j.sticker || {};
  j.sticker.keywordFuzzy = on ? 1 : 0;
  configStore.writeFull(j);
  return { ok: true, on: !!on };
}

/*
 * 通用接口调用：客户端要的表情包页有 15 个后端接口（改描述、改图名、维护、生成清单……），
 * 重写一遍必出错。这里造一对假的 req/res，直接喂给面板的 handler —— 用的是同一份代码，
 * 所以面板改了什么，客户端立刻跟着变，不存在两边行为不一致。
 * 返回 {code, body}（body 是原始字符串，调用方自己 JSON.parse）。
 */
const { PassThrough } = require('stream');
function apiCall(method, url, body) {
  return new Promise(resolve => {
    const req = new PassThrough();
    req.method = String(method || 'GET').toUpperCase();
    req.url = String(url || '/');
    req.headers = { 'content-type': 'application/json' };
    let code = 200;
    const chunks = [];
    const push = c => { if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); };
    const res = {
      writeHead(c) { code = c; },
      setHeader() {},
      getHeader() { return undefined; },
      removeHeader() {},
      write(c) { push(c); return true; },
      end(c) {
        push(c);
        resolve({ code, body: Buffer.concat(chunks).toString('utf8') });
      },
    };
    try { panel.handler(req, res); }
    catch (e) { resolve({ code: 500, body: JSON.stringify({ error: String(e && e.message || e) }) }); }
    req.end(body == null ? '' : JSON.stringify(body));
  });
}

module.exports = {
  snapshot, stickers,
  setFavor, setPerson, trigAdd, trigDel, trigToggle,
  setSwitch, setCritic, setKwFuzzy, setNum,
  SWITCH_SET,   // 2026-11-19：自然语言指令层要用它列「哪些能开能关」
  apiCall,
  personSetFavor, personSetFavorLock, personSetField, personAddAccount, personRemoveAccount, personMerge, personCreate,
  /* 学习系统（2026-11-09）：客户端「学习」页用，真身全在 ../learn */
  learnView: () => learn.view(),
  learnSetFavor: (pid, v, why) => learn.setFavor(pid, v, why),
  learnRevoke: (pid, id, why) => learn.revoke(pid, id, why),
  // P1（2026-11-09）：每人三份档案 / 每人知识库 / 冷层记录，全部只转发
  learnStyleGet: (pid) => learn.styleGet(pid),
  learnStyleSet: (pid, key, text) => learn.styleSet(pid, key, text),
  learnKbList: (pid) => learn.kbList(pid),
  learnKbAdd: (pid, item) => learn.kbAdd(pid, item),
  learnKbDel: (pid, id) => learn.kbDel(pid, id),
  learnKbExport: (pid) => learn.kbExport(pid),
  learnActs: (opt) => learn.actsList(opt),
  learnActsTopics: (opt) => learn.actsTopics(opt),
  ROOT,
};
