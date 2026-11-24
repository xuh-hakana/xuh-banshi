/*
 * dice.js — TRPG 骰子（COC 7 版为主）
 *
 * 前缀认半角「.」和全角「。」两种，群里不用 @ 也能用：
 *   .r  1d100          自由投骰（支持 3d6+2、1d6+1d4、3d6*5）
 *   .rc 侦查 60        技能/属性检定（.ra 同义）
 *   .sc 1/1d6          理智检定，成功扣左边、失败扣右边，自动记 SAN
 *   .st san 60         设置自己的理智值
 *
 * 检定规则按 COC 7 规则书（房规 0）：出 1 大成功；
 * 技能<50 时 96-100 大失败，技能>=50 时只有 100 大失败。
 *
 * ===== 2026-10-23 接入 SealDice 官方引擎（npm: dicescript）=====
 * 主人报「我的骰子是不是不全」——群里另一个 bot（海豹TRPG助手）能掷
 * .rb100（奖励骰）、.ww100（WOD 无限规则）等，我们只会 .r/.rc/.sc/.st。
 * 查过：SealDice 官方开源了它的骰子表达式引擎，Node 版就是 npm 上的 dicescript
 * （github.com/sealdice/dicescript，Apache-2.0，零依赖），语法和输出格式完全一致。
 * 所以直接接它，不自己重写一套。
 * 现在支持：b/p（奖励/惩罚骰）、a/k/m（WOD 无限）、c（双十字）、f（Fate 命运骰）、
 * d20优势/d20劣势、k/q（取高/取低）、!>=（重掷）、#（多轮）等 SealDice 全套语法。
 * 原来的 .rc/.sc/.st 和 COC 分级判定**一个字没改**（那是本项目自己的规矩）。
 */
const fs = require('fs');
const path = require('path');
// 2026-11-03：dice.js 已并入 src/，与 wlog.js、data/ 同级，直接用同目录写法。
const { botWrite } = require('./wlog');
const SAN_PATH = path.join(__dirname, 'data', 'trpg.json');

// ===== SealDice 官方引擎（npm: dicescript）=====
// 它是 ESM 包，Node 22 支持 require(ESM)，所以这里直接同步 require。
let DS = null;
let DS_READY = false;

// 找 dicescript 的入口文件。
// 2026-11-02：node_modules 统一提到了 xuhbot/ 这一层共享，所以不能只认「自己目录下的 node_modules」，
// 要逐级往上找（dice → xuhprojrct → xuhbot），最后再交给 Node 自己的解析兜底。
function findDicescriptMain() {
  const bases = [
    __dirname,                        // src/node_modules/...（若将来在此单独装包）
    path.join(__dirname, '..'),       // xuhbot/node_modules/...  ← 现在实际在这
    path.join(__dirname, '..', '..'), // xuhbot/node_modules/...  ← 现在实际在这
    path.join(__dirname, '..', '..', '..'),
  ];
  for (const b of bases) {
    const p = path.join(b, 'node_modules', 'dicescript', 'dist', 'main.mjs');
    if (fs.existsSync(p)) return p;
  }
  try { return require.resolve('dicescript/dist/main.mjs'); } catch (e) { /* 兜底也失败就算了 */ }
  return null;
}

function ds() {
  if (DS_READY) return DS;
  DS_READY = true;
  try {
    // 这个包的 exports 只声明了 import 条件、子路径也被 exports 挡住 →
    // 直接按绝对路径指到 dist/main.mjs（Node 22 支持 require(ESM)，能同步拿到）
    const main = findDicescriptMain();
    if (!main) throw new Error('找不到 dicescript（往上各级 node_modules 里都没有）');
    DS = require(main);
    const cfg = DS.newConfig();
    cfg.EnableDiceWoD = true;        // WOD 无限规则（.ww）
    cfg.EnableDiceCoC = true;        // COC 奖励/惩罚骰（b/p）
    cfg.EnableDiceFate = true;       // 命运骰（f）
    cfg.EnableDiceDoubleCross = true;// 双十字（.dx）
    const vm = DS.newVM();
    vm.SetConfig(cfg);
    DS = { vm, cfg };
  } catch (e) {
    console.error('[dice] SealDice 引擎加载失败：' + e.message);
    DS = null;
  }
  return DS;
}

// 表达式白名单：只放行「骰子记号」该有的东西。
// 引擎本身很宽松（不认识的词当变量算，会返回 "null"），所以我们自己先卡一道，
// 免得群里打错一个字就得到一个莫名其妙的数字。
// 规则：① 字符只能有数字、骰子记号字母、运算符、比较符、#、!、% 和中文「优势/劣势」；
//      ② 中文只允许「优势」「劣势」两个词；
//      ③ 字母只允许单个骰子记号 d/b/p/a/k/m/q/c/f/e（去掉重掷记号和多轮记号后剩下的）。
const DS_EXPR_OK = /^[0-9a-zA-Z%+\-*/()#!<>=,.\s\u4e00-\u9fa5]*$/;
const DS_LETTERS = 'dbpaqkmcfe';
function dsExprSane(e) {
  if (!e) return false;
  if (!DS_EXPR_OK.test(e)) return false;
  if (/[+\-*/(),#!<>=\s]$/.test(e)) return false;   // 结尾不能是运算符
  if (/^[+\-*/(),#!<>=\s]/.test(e)) return false;   // 开头也不能是运算符
  if (/[+\-*/]{2,}/.test(e)) return false;            // 不许连续运算符
  // 中文只允许「优势」「劣势」
  for (const c of (e.match(/[\u4e00-\u9fa5]+/g) || [])) {
    if (c !== '优势' && c !== '劣势') return false;
  }
  // 把重掷记号（!>=9>=8）和多轮记号（3#d6）去掉后，剩下的字母必须是单个骰子记号
  const rest = e
    .replace(/![<>=]*[0-9]+/g, '')
    .replace(/#[a-zA-Z0-9]+/g, '')
    .replace(/[0-9]+/g, '')
    .replace(/[+\-*/()%<>=,.\s]/g, '')
    .replace(/[\u4e00-\u9fa5]/g, '');
  for (const ch of rest) {
    if (DS_LETTERS.indexOf(ch.toLowerCase()) < 0) return false;
  }
  return true;
}

// 用引擎掷一条表达式。返回 {total, detail} 或 null（表达式看不懂）。
function dsRoll(expr) {
  const d = ds();
  if (!d) return null;
  const e = String(expr || '').trim();
  if (!e) return null;
  if (!dsExprSane(e)) return null;
  try {
    d.vm.Run(e);
    if (d.vm.Error) { d.vm.Error = null; return null; }   // 报错 = 表达式看不懂
    const ret = d.vm.Ret;
    if (!ret) return null;
    const total = ret.ToString();
    // 引擎把不认识的词当变量求值，会返回字符串 "null" —— 那就是「看不懂」，不当骰子
    if (total === 'null' || total === '' || total === 'undefined') return null;
    // 明细在 GetDetailText()；有的表达式（如 1d100）不产生明细，那就自己拼一个
    let detail = '';
    try { detail = d.vm.GetDetailText() || ''; } catch (e2) { detail = ''; }
    if (!detail) detail = e + '=' + total;
    return { total, detail };
  } catch (err) {
    console.error('[dice] 引擎出错：' + err.message);
    return null;
  }
}

const d = n => Math.floor(Math.random() * n) + 1;

// ===== 理智值存档（按 QQ 号，没存过就按 60 起） =====
function readStore() {
  try { return JSON.parse(fs.readFileSync(SAN_PATH, 'utf8')) || {}; } catch { return {}; }
}
function writeStore(j) {
  try { fs.writeFileSync(SAN_PATH, JSON.stringify(j, null, 1), 'utf8'); } catch (e) { console.error('[dice] 写 SAN 失败', e.message); }
}
function getSan(uid) {
  const v = Number((readStore()[String(uid)] || {}).san);
  return Number.isFinite(v) && v > 0 ? v : 60;
}
function setSan(uid, v) {
  const j = readStore();
  const k = String(uid);
  const now = Math.max(0, Math.min(99, Math.round(v)));
  j[k] = Object.assign({}, j[k], { san: now });
  writeStore(j);
  botWrite('data/trpg.json', '骰子', k + ' 的理智值 → ' + now);
  return j[k].san;
}

// ===== 骰子表达式 =====
// 只支持「项 + - * / 项」，项是 NdM 或整数。够用了，也不容易解析出歧义。
function evalDice(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const parts = s.match(/(\d*d\d+|\d+|[+\-*/])/g);
  if (!parts || parts.join('') !== s) return null;

  const list = [];
  let sign = 1, pending = null;
  for (const p of parts) {
    if (p === '+') { sign = 1; continue; }
    if (p === '-') { sign = -1; continue; }
    if (p === '*' || p === '/') { pending = p; continue; }

    const m = p.match(/^(\d*)d(\d+)$/);
    let item;
    if (m) {
      const n = m[1] ? +m[1] : 1;
      const sides = +m[2];
      if (n < 1 || n > 50 || sides < 2 || sides > 1000) return null;
      const rolled = Array.from({ length: n }, () => d(sides));
      item = { kind: 'dice', label: p, rolled, val: rolled.reduce((a, b) => a + b, 0) };
    } else {
      const v = +p;
      if (!Number.isFinite(v)) return null;
      item = { kind: 'num', label: p, val: v };
    }

    // 乘除并到前一项上（3d6*5、1d100/2）
    if (pending && list.length) {
      const last = list[list.length - 1];
      const v = pending === '*' ? last.val * item.val : (item.val ? last.val / item.val : NaN);
      if (!Number.isFinite(v)) return null;
      last.val = Math.floor(v);
      last.label += pending + item.label;
      if (item.kind === 'dice') last.rolled = last.rolled.concat(item.rolled);
      pending = null;
      continue;
    }
    pending = null;
    list.push(Object.assign(item, { sign }));
    sign = 1;
  }
  if (!list.length) return null;

  const total = list.reduce((a, x) => a + x.sign * x.val, 0);
  const bits = list.map((x, i) => {
    const sgn = i === 0 ? (x.sign < 0 ? '-' : '') : (x.sign < 0 ? ' - ' : ' + ');
    let body;
    if (x.kind === 'num') body = String(x.val);
    else if (/[*/]/.test(x.label)) body = String(x.val);        // 3d6*5 这种直接给结果
    else if (x.rolled.length === 1) body = String(x.rolled[0]);
    else if (x.rolled.length <= 12) body = '[' + x.rolled.join(',') + ']';
    else body = String(x.val);
    return sgn + body;
  }).join('');
  return { total, text: `${s} = ${bits}${bits === String(total) ? '' : ' = ' + total}` };
}

// 表达式能打出的最大值（大失败要扣满）
function maxOf(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  const parts = s.match(/(\d*d\d+|\d+|[+\-*/])/g);
  if (!parts) return 0;
  let sign = 1, acc = 0;
  for (const p of parts) {
    if (p === '+') { sign = 1; continue; }
    if (p === '-') { sign = -1; continue; }
    if (p === '*' || p === '/') continue;
    const m = p.match(/^(\d*)d(\d+)$/);
    acc += sign * (m ? (m[1] ? +m[1] : 1) * +m[2] : +p);
    sign = 1;
  }
  return Math.max(0, acc);
}

// ===== COC 7 检定等级 =====
function cocLevel(roll, target) {
  if (roll === 1) return '大成功';
  const failLine = target >= 50 ? 100 : 96;
  if (roll >= failLine) return '大失败';
  if (roll <= Math.floor(target / 5)) return '极难成功';
  if (roll <= Math.floor(target / 2)) return '困难成功';
  if (roll <= target) return '普通成功';
  return '失败';
}

// ===== 命令解析 =====
// "侦查 60" / "侦查60" / "60" / "侦查"
function parseCheck(arg) {
  const s = String(arg || '').trim();
  if (!s) return null;
  const m = s.match(/^(.*?)[\s　]*(\d{1,3})\s*$/);
  let name = '', target = null;
  if (m) { name = m[1].trim(); target = +m[2]; }
  else name = s;
  if (!name) name = '检定';
  if (target != null) target = Math.max(1, Math.min(999, target));
  return { name, target };
}

// "1/1d6" / "1d10/1d100" / "1d6"（只有失败损失）
function parseSc(arg) {
  const s = String(arg || '').trim();
  if (!s) return { ok: '1', bad: '1d6' };          // 什么都不写按最常见的 1/1d6
  if (!s.includes('/')) return { ok: '0', bad: s };
  const [ok, bad] = s.split('/');
  return { ok: ok.trim() || '0', bad: bad.trim() || '0' };
}

function scOut(npc, uid, label) {
  const okExpr = npc.ok, badExpr = npc.bad;
  const san = getSan(uid);
  const roll = d(100);
  const lv = cocLevel(roll, san);
  const greatFail = lv === '大失败';

  let loss = 0, lossText = '';
  if (lv === '失败' || greatFail) {
    loss = greatFail ? maxOf(badExpr) : (evalDice(badExpr) || { total: 0 }).total;
    lossText = greatFail ? `取满 ${badExpr}=${loss}` : `${badExpr}=${loss}`;
  } else {
    loss = (evalDice(okExpr) || { total: 0 }).total;
    lossText = `${okExpr}=${loss}`;
  }
  const after = setSan(uid, san - loss);

  const head = `${label ? label + ' ' : ''}理智检定 d100 = ${roll} / ${san} → ${lv}`;
  const parts = [`🎲 ${head}`, `💔 理智 -${loss}（${lossText}）`, `SAN ${san} → ${after}`];
  if (after <= 0) parts.push('⚠ 理智归零，永久疯狂');
  return parts.join(' ｜ ');
}

/**
 * 处理一条消息。命中骰子命令返回要发出去的文本；不是命令返回 null。
 * @param {string} text 原始消息
 * @param {string|number} uid 说话人 QQ
 */
function handle(text, uid) {
  const s = String(text || '').trim();
  // 命令表（2026-10-23 补齐 SealDice 全套）：
  //   r  自由投骰（引擎全套语法）  rc/ra 检定  sc 理智检定  st 理智值
  //   rb 奖励骰  rp 惩罚骰  ww WOD 无限  dx 双十字  rsr 暗影狂奔  ek 共鸣性怪异
  const m = s.match(/^[.。]\s*(rc|ra|sc|st|rsr|rw|rb|rp|r|ww|dx|ek)(?![a-z])/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = s.slice(m[0].length).trim();

  try {
    if (cmd === 'r') {
      if (!arg) {
        const r = d(100);
        return `🎲 1d100 = ${r}（写 .r 3d6+2 可以指定骰子）`;
      }
      // 允许「.r 砍刀伤害 1d6+2」这种带理由的写法：找出哪一段是表达式，剩下的当理由
      const parts = arg.split(/\s+/).filter(Boolean);
      const idx = parts.findIndex(p => evalDice(p) || dsRoll(p));
      if (idx < 0) return `🎲 「${arg}」这个骰子表达式我看不懂，试试 .r 1d100 / .r 3d6+2`;
      const expr = parts[idx];
      const label = parts.filter((_, i) => i !== idx).join(' ').trim();
      // 先走本项目的老解析器（简单 NdM，格式清楚：3d6+2 = [3,4,6] + 2 = 15）；
      // 老解析器看不懂的（b/p/a/k/m/c/f/优势劣势/重掷/多轮…）再交给 SealDice 引擎。
      const own = evalDice(expr);
      if (own) return `🎲 ${label ? label + ' ' : ''}${own.text}`;
      const eng = dsRoll(expr);
      if (eng) {
        const body = eng.detail ? eng.detail : expr + '=' + eng.total;
        return `🎲 ${label ? label + ' ' : ''}${body}`;
      }
      return `🎲 「${arg}」这个骰子表达式我看不懂，试试 .r 1d100 / .r 3d6+2`;
    }

    // ===== 奖励骰 / 惩罚骰（SealDice：b/p）=====
    // 语义跟 SealDice 完全一致（群里那个 bot 也是这套）：
    //   .rb      → b1（1 颗奖励骰）      .rb100 → b100（100 颗奖励骰）
    //   .rb2 70  → b2，再拿 70 当成功率做一次 COC 分级判定
    if (cmd === 'rb' || cmd === 'rp') {
      const kind = cmd === 'rb' ? '奖励' : '惩罚';
      const parts = arg.split(/\s+/).filter(Boolean);
      let num = 1, target = null;
      if (parts[0] && /^\d{1,3}$/.test(parts[0])) {
        num = Math.max(0, Math.min(100, +parts[0]));
        parts.shift();
      }
      if (parts[0] && /^\d{1,3}$/.test(parts[0])) { target = +parts[0]; parts.shift(); }
      const expr = (cmd === 'rb' ? 'b' : 'p') + num;
      const eng = dsRoll(expr);
      if (!eng) return `🎲 「${arg}」这个骰子表达式我看不懂`;
      let out = `🎲 ${kind}骰 ${num} 颗：${eng.detail || eng.total}`;
      if (target != null) {
        const roll = +eng.total;
        const lv = cocLevel(roll, target);
        out += ` → 检定 ${roll} / ${target} → ${lv}`;
      }
      return out;
    }

    // ===== WOD 无限规则（SealDice：.ww）=====
    // .ww5 → 5a10（默认加骰线 10、成功线 8）；.ww 100a10k8m10 → 全参数
    if (cmd === 'ww') {
      const a = arg.replace(/\s+/g, '');
      if (!a) return '🎲 用法：.ww 5（5 个 d10）或 .ww 100a10k8m10';
      const expr = /^\d+[amkq]/.test(a) ? a : a + 'a10';   // 没写加骰线就补默认 a10
      const eng = dsRoll(expr);
      if (!eng) return `🎲 「${arg}」这个骰子表达式我看不懂`;
      return `🎲 ${eng.detail || expr + '=' + eng.total}`;
    }

    // ===== 双十字（SealDice：.dx）=====
    if (cmd === 'dx') {
      const a = arg.replace(/\s+/g, '');
      if (!a) return '🎲 用法：.dx 4c3m7';
      const expr = /^\d+[cm]/.test(a) ? a : a + 'm10';
      const eng = dsRoll(expr);
      if (!eng) return `🎲 「${arg}」这个骰子表达式我看不懂`;
      return `🎲 ${eng.detail || expr + '=' + eng.total}`;
    }

    // ===== 暗影狂奔 / 共鸣性怪异（SealDice：.rsr / .ek）=====
    if (cmd === 'rsr' || cmd === 'ek') {
      const a = arg.replace(/\s+/g, '');
      const expr = a || (cmd === 'rsr' ? '6d6' : '5d10');
      const eng = dsRoll(expr);
      if (!eng) return `🎲 「${arg}」这个骰子表达式我看不懂`;
      return `🎲 ${eng.detail || expr + '=' + eng.total}`;
    }

    if (cmd === 'rc' || cmd === 'ra') {
      const c = parseCheck(arg);
      if (!c) return '🎲 用法：.rc 侦查 60（只写 .rc 60 也行）';
      const target = c.target == null ? 50 : c.target;
      const roll = d(100);
      const lv = cocLevel(roll, target);
      const tip = c.target == null ? '（没给技能值，按 50 算）' : '';
      return `🎲 ${c.name} d100 = ${roll} / ${target} → ${lv}${tip}`;
    }

    if (cmd === 'sc') {
      const npc = parseSc(arg);
      return scOut(npc, uid, '');
    }

    if (cmd === 'st') {
      const mm = arg.match(/^san\s*([+\-]?\s*\d+)$/i);
      if (!mm) return '🎲 用法：.st san 60（改自己的理智值）';
      const v = Number(mm[1].replace(/\s+/g, ''));
      const now = /^[+\-]/.test(mm[1].trim()) ? getSan(uid) + v : v;
      const after = setSan(uid, now);
      return `🎲 理智值已设为 ${after}`;
    }
  } catch (e) {
    console.error('[dice]', e.message);
    return '🎲 骰子卡住了，再试一次';
  }
  return null;
}

module.exports = { handle, evalDice, cocLevel, getSan, setSan, dsRoll };
