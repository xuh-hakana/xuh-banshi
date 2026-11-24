'use strict';
/* ===========================================================================
 * multi-truth/index.js —— 「多重真相」的机器人侧（2026-11-25 主人令）
 *
 * 分工：
 *   同步（毫秒级，在机器人里）：接话判断的**快判**用现有正则先验，不阻塞回复。
 *   异步（插件里跑）：群友视角 / 记录 / 接话复核 —— 由 DSH 的 workflow-lite 图 +
 *     dsh-orchestrator 在后台跑，产出写回 data/multi-truth/out/<会话>.json。
 *   回话（机器人主链）：把最近一次产出当「记录员的结论」注入提示词，标时效。
 *
 * 本文件只做四件事：投递 inbox、取最新结论、拼四个角色的提示词、给提示词用的摘要。
 * 判断逻辑一律不在这里（它在图里、在角色提示词里）。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const persona = require('../persona');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'multi-truth');
const INBOX = path.join(DIR, 'inbox');
const OUT = path.join(DIR, 'out');
const MAX_LINES = 200;     // 单会话 inbox 上限（去抖用，跑完由插件标 consumed）

function safeKey(k) { return String(k || '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default'; }
function ensure(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function conf() {
  try { return require('../config').cfgLive().multiTruth || {}; } catch (e) { return {}; }
}
function enabled() { const f = conf(); return f.enabled !== false; }

/* 投递一条待分析的群消息（异步流水线的入口）。失败不影响聊天。 */
function inbox(k, entry) {
  if (!enabled()) return { ok: false, why: 'multiTruth 关着' };
  // 非 QQ 平台（B站/其他）不投：多重真相是群视角流水线，别混进别的平台的消息
  if (entry && entry.plat) return { ok: false, why: '非 QQ 平台不投' };
  if (entry && entry.skip) return { ok: false, why: '调用方标记跳过' };
  if (!entry || !String(entry.text || '').trim()) return { ok: false, why: '空消息不投' };
  try {
    ensure(INBOX);
    const file = path.join(INBOX, safeKey(k) + '.jsonl');
    const rec = {
      t: new Date().toISOString(),
      k: String(k || ''),
      uid: String((entry && entry.uid) || ''),
      nick: String((entry && entry.nick) || ''),
      text: String((entry && entry.text) || ''),
      ts: Number((entry && entry.ts) || Date.now()),
    };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    // 只留最后 MAX_LINES 行：inbox 是队列不是档案
    // 2026-11-25：裁剪是「读-改-写」，进跨进程锁 + 原子替换，否则工作流正在读时会被写坏
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        require('../util/lock').withLock(file, () => {
          const again = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
          if (again.length <= MAX_LINES) return;
          require('../util/atomic').writeFileAtomic(file, again.slice(-MAX_LINES).join('\n') + '\n');
        }, { ttlMs: 5000, waitMs: 2000 });
      }
    } catch (e) {}
    return { ok: true, file };
  } catch (e) { return { ok: false, why: e.message }; }
}

/* 最近一次记录员的产出（可能不是这一轮的，所以要带时效） */
function latest(k) {
  try {
    // 先找这个会话的文件；没有就退回工作流写的 latest.json（里面带 k）
    let raw = null;
    try { raw = fs.readFileSync(path.join(OUT, safeKey(k) + '.json'), 'utf8'); } catch (e) { raw = null; }
    let j = null;
    if (raw) { try { j = JSON.parse(raw); } catch (e) { j = null; } }
    if (!j) {
      try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'latest.json'), 'utf8')); } catch (e) { j = null; }
      if (j && j.k && String(j.k) !== String(k)) return null;   // 是别的群那一份，不当成本群的
    }
    if (!j || typeof j !== 'object') return null;
    const age = Date.now() - (Number(j.at) || 0);
    return Object.assign({}, j, { ageMs: age, stale: age > 10 * 60 * 1000 });
  } catch (e) { return null; }
}

/* 给提示词用的一段（≤300 字）：只给结论，不给过程 */
function debrief(k) {
  const j = latest(k);
  if (!j) return '';
  const emo = j.emotions && typeof j.emotions === 'object'
    ? Object.entries(j.emotions).slice(0, 6).map(([u, m]) => u + '=' + m).join('、') : '';
  const layers = (j.layers || []).slice(0, 4).map(x => (x && x.point) || '').filter(Boolean);
  const offer = (j.canOffer || []).slice(0, 3).join('；');
  const mustNot = (j.mustNot || []).slice(0, 3).join('；');
  const parts = [];
  if (j.replyTarget) parts.push('该回：' + j.replyTarget);
  if (emo) parts.push('各人情绪：' + emo);
  if (layers.length) parts.push('对话要点：' + layers.join('；'));
  if (offer) parts.push('能提供：' + offer);
  if (mustNot) parts.push('别说：' + mustNot);
  if (!parts.length) return '';
  const head = j.stale ? '## 记录员上次的结论（' + Math.round((j.ageMs || 0) / 60000) + ' 分钟前，只作背景）'
    : '## 记录员的结论（这一轮）';
  // 按行裁：整行整行地取，累加到 300 字就停，绝不切半句
  const LIMIT = 300;
  const keep = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length > LIMIT) break;
    keep.push(p);
    used += p.length + 1;
  }
  if (!keep.length) keep.push(String(parts[0]).slice(0, LIMIT));
  return head + '\n' + keep.join('\n');
}

/* ------------------------------------------------------------ 四个角色 */
function personCard(member) {
  const m = member || {};
  const parts = [];
  if (m.nick) parts.push('昵称：' + m.nick);
  if (m.uid) parts.push('号：' + m.uid);
  if (m.alias) parts.push('代称：' + m.alias);
  if (m.note) parts.push('资料：' + m.note);
  if (m.recent) parts.push('他最近说过：\n' + String(m.recent).slice(0, 300));
  return parts.join('\n');
}

const build = {
  judge: (turn) => persona.rolePrompt('judge') + '\n\n【这一轮】\n' + String((turn && turn.text) || ''),
  groupmate: (member, turn) => persona.rolePrompt('groupmate')
    + '\n\n【你在扮演的人】\n' + personCard(member)
    + '\n\n【这一轮的对话】\n' + String((turn && turn.text) || ''),
  recorder: (turn, views) => persona.rolePrompt('recorder')
    + '\n\n【这一轮的对话】\n' + String((turn && turn.text) || '')
    + '\n\n【各人视角（可互相矛盾，矛盾本身也是信息）】\n' + JSON.stringify(views || [], null, 0).slice(0, 2000),
  reply: (turn, k) => debrief(k) + '\n\n【这一轮】\n' + String((turn && turn.text) || ''),
};

/* ------------------------------------------------------------ 触发后台分析 */
/* 让 DSH 跑那张 workflow-lite 图（多重真相）。默认不自动调，避免每条消息都花一次 agent；
 * features.multiTruth.autoRun=true 时才由 inbox 的节流器（10 秒 1 次、每 10 条 1 次）调用。 */
const _kickAt = new Map();     // k -> 上次触发时刻
const _sinceKick = new Map();  // k -> 距上次触发攒了几条
function shouldKick(k) {
  const now = Date.now();
  const c = conf();
  const gapMs = Math.max(1000, Number(c.minGapSec || 10) * 1000);
  const minMsgs = Math.max(1, Number(c.minMsgs || 10));
  const n = (_sinceKick.get(k) || 0) + 1;
  _sinceKick.set(k, n);
  const last = Number(_kickAt.get(k) || 0);
  if (last && now - last < gapMs) return false;
  if (n < minMsgs && last && now - last < 10 * 60 * 1000) return false;
  // 判过就把时间与计数钉住：同一进程里连调两次只有第一次算（防止重复派活）
  _kickAt.set(k, now);
  _sinceKick.set(k, 0);
  return true;
}
async function kick(k) {
  if (!shouldKick(k)) return { ok: false, why: '节流中' };
  _kickAt.set(k, Date.now());
  _sinceKick.set(k, 0);
  const inboxFile = 'src/data/multi-truth/inbox/' + safeKey(k) + '.jsonl';
  const text = [
    '跑工作流「多重真相」，只分析这个会话的 inbox 文件：' + inboxFile,
    '步骤按图走（接话复核 → 群友视角 → 记录员），最终产出 src/data/multi-truth/out/latest.json；',
    'latest.json 里的 k 必须写成 ' + JSON.stringify(String(k)) + '。',
    '只做这一件事，别顺手改别的文件。',
  ].join('');
  const budgetMs = Math.max(1000, Number(conf().budgetMs || 6000));
  try {
    const link = require('../agent-link');
    await link.start();
    // budgetMs 真的传给 agent-link（原来是死配置：取出来没人用）
    const r = await link.runTask({ text, sessionKey: 'multi-truth:' + safeKey(k), timeoutMs: budgetMs });
    const ok = !!(r && r.ok);
    if (!ok) {
      // 失败要看得见：后台流水线静默失败＝「莫名其妙」再次发生
      const why = (r && (r.reason || r.why)) || '未知原因';
      console.log('[multi-truth] kick 失败（' + k + '）：' + why);
      try { require('../diag/report').report('multi-truth', 'kick 失败：' + why, { k }); } catch (e2) {}
    }
    return { ok, text: (r && r.text || '').slice(0, 200), reason: r && (r.reason || r.why) };
  } catch (e) {
    console.log('[multi-truth] kick 异常（' + k + '）：' + e.message);
    try { require('../diag/report').report('multi-truth', e, { k, stage: 'kick-throw' }); } catch (e2) {}
    return { ok: false, why: e.message };
  }
}

module.exports = { DIR, INBOX, OUT, enabled, inbox, latest, debrief, build, personCard, safeKey, shouldKick, kick };
