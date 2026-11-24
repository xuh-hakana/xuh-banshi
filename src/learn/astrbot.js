'use strict';
/*
 * src/learn/astrbot.js —— 把 AstrBot 自主学习插件学到的东西读回来（2026-11-22）
 *
 * 由来（主人原话）：「astrbot 和 dsh 的总结风格插件我都没用上。」
 * 查实的原因不是插件没学，是学了没人读：AstrBot 的自主学习插件一直在抓 QQ 群消息、
 * 提炼表达样本 / 风格学习 / Bot 心情，可 QQ 聊天是虚幻（xuhbot）在回，AstrBot 只接 /
 * 命令（astrbot_plugin_qq_slash_only 定的），学到的东西根本进不了虚幻的提示词。
 *
 * 所以这个文件只做一件事：**只读**那个 SQLite，把三样东西读成内存缓存，
 * 给 learn/index.js 的 hot() 拼提示词用。
 *   bot_mood                → 她今天的心情（定心情 + 按心情改语气）
 *   expression_patterns     → 这个群的人平时怎么接话（口气参考）
 *   style_learning_reviews  → 已通过审查的风格规矩（学规矩，不照抄句子）
 *
 * 四条纪律：
 *   1. 只读。绝不写 AstrBot 的任何文件；原件打不开就复制到临时目录读副本，读完删；
 *   2. 读不到就返回空，绝不抛错——AstrBot 没装 / 没在跑 / 表改了，都不该影响回话；
 *   3. 不打印群聊原文：日志和 state() 里只有条数、类型分布；
 *   4. hot() 是同步的，所以这里只读内存，真正查库放在 refresh()（tick 里 30 分钟一次，
 *      再加 60 秒节流；hot() 第一次调用会顺手踢一次后台刷新）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SQLITE = '/usr/bin/sqlite3';
const TTL_MS = 60 * 1000;              // 两次真查库之间至少隔 60 秒
const MOOD_MAX_AGE_MS = 48 * 3600 * 1000;

function defaultDb() {
  return path.join(os.homedir(), '.astrbot', 'data', 'plugin_data',
    'astrbot_plugin_self_learning', 'messages.db');
}
function dbPath() { return process.env.XUHBOT_ASTRBOT_DB || defaultDb(); }

const cache = {
  ok: false,
  at: 0,
  err: '',
  db: '',
  mood: {},      // group_id → { type, intensity, description, at(ms) }
  expr: {},      // group_id → [{ situation, expression }]
  style: {},     // group_id → [string]
  counts: { moods: 0, expr: 0, styles: 0 },
};
let inflight = null;

/* ---------- 查库（用系统 sqlite3，免依赖） ---------- */

function run(db, sql, allowReadOnly) {
  return new Promise(resolve => {
    const args = allowReadOnly ? ['-readonly', '-json', db, sql] : ['-json', db, sql];
    execFile(SQLITE, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, err: String(err.message || err) });
      const s = String(stdout || '').trim();
      if (!s) return resolve({ ok: true, rows: [] });
      try {
        const j = JSON.parse(s);
        return resolve({ ok: true, rows: Array.isArray(j) ? j : [] });
      } catch (e) {
        return resolve({ ok: false, err: '输出不是 JSON' });
      }
    });
  });
}

/* 复制 db(+wal/shm) 到临时目录。副本用普通方式打开（不加 -readonly）：
 * WAL 库只读连接建不了 shm，会报 unable to open database file，实测踩过。 */
function copyToTemp(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-astrbot-'));
  for (const suf of ['', '-wal', '-shm']) {
    const src = db + suf;
    try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, path.basename(db) + suf)); } catch (e) { /* 缺的跳过 */ }
  }
  return dir;
}

async function query(db, sql) {
  const a = await run(db, sql, true);
  if (a.ok) return a;
  let dir = '';
  try {
    dir = copyToTemp(db);
    const tmp = path.join(dir, path.basename(db));
    const b = await run(tmp, sql, false);
    if (b.ok) return b;
    return { ok: false, err: b.err || a.err };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ } }
  }
}

/* 探列：表不在 / 列被改名就跳过，别让半张表把整次刷新搞挂 */
async function tableCols(db, table) {
  const r = await query(db, "pragma table_info('" + table + "')");
  if (!r.ok) return null;
  const cols = r.rows.map(x => String(x.name || ''));
  return cols.length ? cols : null;
}

function clean(s, max) {
  let t = String(s || '')
    .replace(/@[^\s()（）]{1,20}[（(]\d{4,12}[）)]/g, '')   // @昵称(123456)
    .replace(/@\d{4,12}/g, '')                            // @123456
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max);
  return t;
}

/* ---------- 刷新 ---------- */

async function doRefresh(db) {
  const out = {
    ok: false, at: Date.now(), err: '', db: db,
    mood: {}, expr: {}, style: {}, counts: { moods: 0, expr: 0, styles: 0 },
  };
  if (!fs.existsSync(db)) { out.err = '没有库文件'; return out; }

  /* 心情：每群一条当前心情 */
  if (await tableCols(db, 'bot_mood')) {
    const r = await query(db, 'select group_id, mood_type, mood_intensity, mood_description, timestamp'
      + ' from bot_mood where is_active = 1 order by timestamp desc limit 200');
    if (r.ok) {
      for (const x of r.rows) {
        const g = String(x.group_id || '');
        if (!g || out.mood[g]) continue;
        out.mood[g] = {
          type: String(x.mood_type || ''),
          intensity: Number(x.mood_intensity) || 0,
          description: clean(x.mood_description, 60),
          at: Number(x.timestamp) * 1000 || 0,                 // 库里是 Unix 秒
        };
        out.counts.moods++;
      }
    } else out.err = r.err;
  }

  /* 表达样本：每群按权重取前 8 条 */
  if (await tableCols(db, 'expression_patterns')) {
    const r = await query(db, 'select group_id, situation, expression, weight'
      + ' from expression_patterns order by weight desc limit 3000');
    if (r.ok) {
      for (const x of r.rows) {
        const g = String(x.group_id || '');
        const situation = clean(x.situation, 40);
        const expression = clean(x.expression, 40);
        // 太短的对（「哇」→「啊」）当不了口气参考，只会让提示词变噪音
        if (!g || situation.length < 3 || expression.length < 5) continue;
        if (situation === expression) continue;
        const arr = out.expr[g] || (out.expr[g] = []);
        if (arr.length >= 8) continue;
        if (arr.some(y => y.expression === expression)) continue;
        arr.push({ situation: situation, expression: expression });
        out.counts.expr++;
      }
    } else if (!out.err) out.err = r.err;
  }

  /* 已通过审查的风格规矩 */
  if (await tableCols(db, 'style_learning_reviews')) {
    const r = await query(db, "select group_id, learned_patterns from style_learning_reviews where status = 'approved' limit 50");
    if (r.ok) {
      for (const x of r.rows) {
        const g = String(x.group_id || '');
        let arr = null;
        try { arr = JSON.parse(x.learned_patterns || '[]'); } catch (e) { continue; }
        if (!Array.isArray(arr)) continue;
        const lines = out.style[g] || (out.style[g] = []);
        for (const p of arr) {
          const expression = clean(p && (p.expression || p.text), 40);
          if (!expression || lines.length >= 6) continue;
          if (lines.indexOf(expression) < 0) { lines.push(expression); out.counts.styles++; }
        }
      }
    } else if (!out.err) out.err = r.err;
  }

  out.ok = out.counts.moods + out.counts.expr + out.counts.styles > 0;
  if (!out.ok && !out.err) out.err = '三张表都没有数据';
  return out;
}

/* 异步刷新（可注入 dbPath，测试用）。失败保留上次结果，不抛。 */
function refresh(opt) {
  const o = opt || {};
  const db = o.dbPath || dbPath();
  if (!o.force && cache.at && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = doRefresh(db).then(r => {
    cache.ok = r.ok; cache.at = r.at; cache.err = r.err; cache.db = r.db;
    if (r.ok) { cache.mood = r.mood; cache.expr = r.expr; cache.style = r.style; cache.counts = r.counts; }
    return cache;
  }).catch(e => {
    cache.err = String(e && e.message || e); cache.at = Date.now();
    return cache;
  }).then(r => { inflight = null; return r; });
  return inflight;
}

/* 给 hot() 用：第一次没有数据就踢一次后台刷新，别让回话等它 */
function kick() {
  if (cache.at) return;
  refresh().catch(() => {});
}

/* ---------- 读（同步，只读内存） ---------- */

function norm(g) { return g === undefined || g === null ? '' : String(g); }

function moodFor(groupId) {
  const g = norm(groupId);
  let m = null;
  if (g) {
    m = cache.mood[g] || null;          // 有群号就只认这个群，别把别的群心情借来用
  } else {
    // 私聊没群号：退最近一条
    for (const k of Object.keys(cache.mood)) {
      const x = cache.mood[k];
      if (!m || (x.at || 0) > (m.at || 0)) m = x;
    }
  }
  if (!m) return null;
  if (m.at && Date.now() - m.at > MOOD_MAX_AGE_MS) return null;   // 过期心情不注入，免得装
  return { type: m.type, intensity: m.intensity, description: m.description, at: m.at };
}

function exprFor(groupId, n) {
  const g = norm(groupId);
  const arr = (g && cache.expr[g]) || [];
  return arr.slice(0, Number(n) > 0 ? Number(n) : 5);
}

function styleFor(groupId, n) {
  const g = norm(groupId);
  const arr = (g && cache.style[g]) || [];
  return arr.slice(0, Number(n) > 0 ? Number(n) : 3);
}

function state() {
  return {
    ok: cache.ok, at: cache.at, err: cache.err, db: cache.db || dbPath(),
    counts: cache.counts,
    moods: Object.keys(cache.mood).length,
    groups: Object.keys(cache.expr).length,
    styleGroups: Object.keys(cache.style).length,
  };
}

module.exports = { refresh, kick, moodFor, exprFor, styleFor, state, defaultDb, dbPath };
