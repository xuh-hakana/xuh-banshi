'use strict';
/* ===========================================================================
 * agent-link.js — 把「一句话任务」交给 DeepSeek Harness（DSH）的 agent 执行，拿回最终文本
 *
 * 机器人怎么用（给 qq.js / intent-router 那边留的接口）：
 *   const link = require('./agent-link');
 *   await link.start();                                  // 幂等，进程里只起一次
 *   const r = await link.runTask({ text: '把今天日报整理了', sessionKey: '群_894917172' });
 *   // r = { ok, text, reason, ms, sessionId }
 *   await link.stop();                                   // 关会话 + 杀子进程（进程退出时也会兜底）
 *
 * 两条通道（都是官方支持的，不放内存里瞎猜）：
 *   A. 主通道 ACP：`dsh --profile acp` 起一个 ACP v1 JSON-RPC stdio 服务。
 *      - 常驻子进程，一次握手，多个 session 并发；同 sessionKey 复用 sessionId → 省 token、有上下文。
 *      - 协议形状全部照抄 `@deepseek-ai/dsh-acp/src/*.ts` 与 `@agentclientprotocol/sdk@1.4.0`
 *        （PROTOCOL_VERSION=1，NDJSON 一行一条，按 \n 切）。
 *   B. 兜底通道 headless：`dsh headless --permission-mode workspace-write --approval-policy never "<任务>"`，
 *      stdout 就是答案、exit 0 成功。没有会话复用；需要 DEEPSEEK_API_KEY（读不到 GUI 登录态）。
 *
 * 降级规则（写死在这里，别处不要再判断一遍）：
 *   - 配置 mode=auto：先 ACP，握手/起进程失败 → 本进程后续一律 headless；
 *   - 跑任务途中 ACP 通道坏了（子进程退出、写不进去）→ 同一个任务改走 headless 重跑一次；
 *   - 超时不重跑（避免同一件事做两遍），直接返回 reason:'timeout'。
 *
 * 配置（src/config/intent.json，缺文件/缺字段/坏 JSON 全部走默认，不抛）：
 *   { "intent": { "agent": { ... } } }   // 也兼容 { "agent": {...} } 与平铺 {...}
 *   mode             'auto' | 'acp' | 'headless'      默认 auto
 *   binary           可执行文件路径                     默认自动探测（见 DEFAULT_BINARY）
 *   acpArgs          ACP 启动参数数组                   默认 ['--profile','acp']
 *   headlessArgs     headless 启动参数数组（不含任务）    默认见 DEFAULT_HEADLESS_ARGS
 *   cwd              会话工作目录                       默认 process.cwd()
 *   timeoutMs        单任务超时                         默认 240000
 *   handshakeTimeoutMs  initialize 握手超时             默认 90000
 *   cancelGraceMs    session/cancel 后宽限多久再杀进程    默认 5000
 *   headlessJson     是否给 headless 加 --json 解 final 事件（默认 false，直接读 stdout）
 *   env              追加给子进程的环境变量（合并进 process.env）
 *   别名兼容：command / bin / dshPath；args；timeout；workdir；permissionMode；approvalPolicy
 *
 * 失败原因（reason）固定这几个，前端/日志直接认：
 *   'no-binary' | 'handshake' | 'timeout' | 'spawn' | 'stopped' | 'error'
 * =========================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* 项目根 = src 的上一级（本文件在 src/ 里）。会话默认工作目录。 */
const ROOT = path.resolve(__dirname, '..');
/* 配置由负责意图路由的同事维护；不存在时这里全走默认。 */
const CONFIG_FILE = path.join(__dirname, 'config', 'intent.json');

/* DSH 0.2.2-rc.5 的 launcher。装到别处就改 intent.json 的 binary。 */
const DEFAULT_BINARY = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const DEFAULT_ACP_ARGS = ['--profile', 'acp'];
/* 0.2.2-rc.5 实测：headless 子命令 + workspace-write + 不弹审批。 */
const DEFAULT_HEADLESS_ARGS = ['headless', '--permission-mode', 'workspace-write', '--approval-policy', 'never'];
const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 90000;
const DEFAULT_CANCEL_GRACE_MS = 5000;
/* ACP v1：@agentclientprotocol/sdk 的 PROTOCOL_VERSION 就是 1。 */
const ACP_PROTOCOL_VERSION = 1;

/* ---------------------------------------------------------------- 状态 */

const state = {
  started: false,
  mode: null,            // 'acp' | 'headless'
  ready: false,
  child: null,           // ACP 常驻子进程
  binary: '',
  config: null,          // 本进程解析后的配置（start 时定格；runTask 的显式入参仍可覆盖超时）
  pending: new Map(),    // JSON-RPC id → { resolve, reject, timer, label }
  sessions: new Map(),   // sessionKey → { key, sessionId, queue, creating }
  turns: new Map(),      // sessionId → { chunks: string[] }  当前这一轮正文缓冲
  acpBroken: false,
  acpBrokenReason: '',
  nextId: 1,
  stopping: false,
  stopPromise: null,
  startPromise: null,
  exitHookInstalled: false,
};

/* ---------------------------------------------------------------- 日志 */

/* 只走 stderr，且固定 [派活] 前缀：stdout 是协议/答案，不能被日志污染。 */
function _log(msg) {
  try { console.error('[派活] ' + msg); } catch (e) { /* 忽略：日志失败不能影响主流程 */ }
}

function _delay(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

function _num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function _strArr(v, d) {
  if (Array.isArray(v)) {
    const out = v.filter((x) => x !== undefined && x !== null).map(String);
    if (out.length) return out;
  }
  return d.slice();
}

function _abs(p) {
  try { return path.resolve(String(p || process.cwd())); } catch (e) { return process.cwd(); }
}

/* ---------------------------------------------------------------- 配置 */

/* 从 intent.json 里抠出 agent 段；三种挂法都认，读不出来就给 {}。 */
function _readIntentAgent() {
  let data;
  try { data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const cands = [
    data.intent && data.intent.agent,
    data.agent,
    data, // 平铺写法：intent.json 直接就是 agent 段
  ];
  for (const c of cands) {
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  }
  return {};
}

/* 显式入参 > 配置文件 > 默认值；别名按顺序试。 */
function _first(opts, raw, names, dflt) {
  for (const n of names) {
    if (opts && opts[n] !== undefined && opts[n] !== null) return opts[n];
  }
  for (const n of names) {
    if (raw && raw[n] !== undefined && raw[n] !== null) return raw[n];
  }
  return dflt;
}

/* 合并出这一次启动用的配置。start(opts) 的 opts 给测试/探针覆盖用。 */
function _settings(opts) {
  const o = opts || {};
  const raw = _readIntentAgent();

  const modeRaw = String(_first(o, raw, ['mode'], 'auto')).toLowerCase();
  const mode = (modeRaw === 'acp' || modeRaw === 'headless') ? modeRaw : 'auto';

  const binary = String(_first(o, raw, ['binary', 'command', 'bin', 'dshPath'], '') || '');
  const acpArgs = _strArr(_first(o, raw, ['acpArgs', 'args'], null) || DEFAULT_ACP_ARGS, DEFAULT_ACP_ARGS);

  /* headlessArgs 没配时，用 permissionMode/approvalPolicy 现拼，方便只改策略不改整串。 */
  let headlessArgs = _first(o, raw, ['headlessArgs'], null);
  if (!Array.isArray(headlessArgs) || !headlessArgs.length) {
    const pm = String(_first(o, raw, ['permissionMode'], 'workspace-write'));
    const ap = String(_first(o, raw, ['approvalPolicy'], 'never'));
    headlessArgs = ['headless', '--permission-mode', pm, '--approval-policy', ap];
  } else {
    headlessArgs = headlessArgs.filter((x) => x !== undefined && x !== null).map(String);
  }

  const envRaw = _first(o, raw, ['env'], null);
  const env = (envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)) ? envRaw : {};

  return {
    mode,
    binary,
    acpArgs,
    headlessArgs,
    cwd: _abs(_first(o, raw, ['cwd', 'workdir'], process.cwd())),
    timeoutMs: _num(_first(o, raw, ['timeoutMs', 'timeout'], DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
    handshakeTimeoutMs: _num(_first(o, raw, ['handshakeTimeoutMs'], DEFAULT_HANDSHAKE_TIMEOUT_MS), DEFAULT_HANDSHAKE_TIMEOUT_MS),
    cancelGraceMs: _num(_first(o, raw, ['cancelGraceMs'], DEFAULT_CANCEL_GRACE_MS), DEFAULT_CANCEL_GRACE_MS),
    headlessJson: !!_first(o, raw, ['headlessJson'], false),
    env,
  };
}

/* 配置里的路径 → 真正能 spawn 的命令。
 * 优先级：intent.json 显式路径 > 环境变量 DSH_AGENT_BIN/DSH_BIN > 本机默认装法 > PATH 里的 'dsh'。
 * 显式配置了却不存在时**不再往下兜底**——不偷偷改用别的 dsh（免得派给错的进程）。 */
function _resolveBinary(cfg) {
  if (cfg.binary) return String(cfg.binary);
  const envBin = process.env.DSH_AGENT_BIN || process.env.DSH_BIN || '';
  if (envBin) return String(envBin);
  try { fs.accessSync(DEFAULT_BINARY, fs.constants.X_OK); return DEFAULT_BINARY; }
  catch (e) { return 'dsh'; }
}

/* 绝对路径/带目录的命令先看存在性；裸命令先当真（PATH 里可能真有）。 */
function _binaryUsable(bin) {
  const s = String(bin || '');
  if (!s) return false;
  if (s.indexOf('/') < 0 && s.indexOf('\\') < 0) return true;
  try { fs.accessSync(s, fs.constants.X_OK); return true; } catch (e) { return false; }
}

function _childEnv(cfg) {
  const env = Object.assign({}, process.env);
  if (cfg && cfg.env) Object.assign(env, cfg.env);
  return env;
}

/* ---------------------------------------------------------------- ACP 收发 */

/* 发一条 JSON-RPC 消息（请求/通知都行）。写不进去返回 false，由调用方判失败。 */
function _writeObj(obj) {
  const child = state.child;
  if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
  try {
    child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    _log('写 ACP stdin 失败：' + (e && e.message));
    return false;
  }
}

/* 发请求并等响应。timeoutMs<=0 表示调用方自己管超时（session/prompt 要用）。 */
function _request(method, params, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const entry = { resolve, reject, timer: null, label: label || method };
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        state.pending.delete(id);
        reject({ reason: 'timeout', message: `${entry.label} 超时（${timeoutMs}ms）` });
      }, timeoutMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    state.pending.set(id, entry);
    if (!_writeObj({ jsonrpc: '2.0', id, method, params })) {
      if (entry.timer) clearTimeout(entry.timer);
      state.pending.delete(id);
      reject({ reason: 'spawn', message: 'ACP 子进程不可写' });
    }
  });
}

/* 发通知（不要响应）。 */
function _notify(method, params) {
  return _writeObj({ jsonrpc: '2.0', method, params });
}

/* 拒掉所有挂起请求（kill / stop 时用），reason 原样给调用方。 */
function _rejectAll(reason, message) {
  for (const [id, entry] of state.pending) {
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.reject({ reason: reason, message: message || 'ACP 通道已关闭' }); } catch (e) { /* 已结算 */ }
    state.pending.delete(id);
  }
}

/* 一条从 DSH 来的消息：通知 / 服务端请求 / 响应。 */
function _onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.method === 'string') {
    if (msg.id === undefined || msg.id === null) _onNotification(msg);
    else _onServerRequest(msg);
    return;
  }
  if (msg.id !== undefined && msg.id !== null) _onResponse(msg);
}

function _onNotification(msg) {
  if (msg.method !== 'session/update') {
    _log('忽略未知通知：' + msg.method);
    return;
  }
  const p = msg.params || {};
  const u = p.update || {};
  /* 只认 assistant 正文。thought/tool_call/usage 等一律不进最终文本。 */
  if (u.sessionUpdate !== 'agent_message_chunk') return;
  if (!u.content || u.content.type !== 'text' || typeof u.content.text !== 'string') return;
  const turn = state.turns.get(p.sessionId);
  if (!turn) return; // 不在本轮（历史补发/别的轮次）→ 丢弃
  turn.chunks.push(u.content.text);
}

/* DSH 现在只会发 session/request_permission；其它一律回 -32601，别让它挂着。 */
function _onServerRequest(msg) {
  const method = msg.method;
  if (method === 'session/request_permission') {
    const options = (msg.params && Array.isArray(msg.params.options)) ? msg.params.options : [];
    const choice = _pickAllow(options);
    if (!choice) {
      _log('权限请求没有 allow 选项，回 cancelled');
      _writeObj({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    /* 线上形状（照抄 dsh-acp src/index.ts）：{"outcome":{"outcome":"selected","optionId":"allow-once"}} */
    _writeObj({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: choice.optionId } } });
    _log(`权限请求已自动允许：${choice.optionId}（kind=${choice.kind || '?'}）`);
    return;
  }
  _writeObj({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'client does not implement ' + method },
  });
}

/* allow_once 优先，其次 allow_always，再其次任何 kind 以 allow 开头；绝不挑 reject。 */
function _pickAllow(options) {
  const list = Array.isArray(options) ? options.filter((o) => o && o.optionId) : [];
  const byKind = (k) => list.find((o) => o.kind === k);
  return byKind('allow_once')
    || byKind('allow_always')
    || list.find((o) => String(o.kind || '').indexOf('allow') === 0)
    || null;
}

function _onResponse(msg) {
  const entry = state.pending.get(msg.id);
  if (!entry) return; // 迟到的响应（可能已经被超时结算）
  state.pending.delete(msg.id);
  if (entry.timer) clearTimeout(entry.timer);
  if (msg.error) {
    entry.reject({
      reason: 'error',
      message: (msg.error && msg.error.message) || ('JSON-RPC 错误 ' + (msg.error && msg.error.code)),
      code: msg.error && msg.error.code,
    });
    return;
  }
  entry.resolve(msg.result);
}

/* ---------------------------------------------------------------- ACP 生命周期 */

/* 起 ACP 子进程 + 完成 initialize 握手。失败 reject {reason}，不抛普通异常。 */
function _startAcp(cfg) {
  return new Promise((resolve, reject) => {
    if (!_binaryUsable(state.binary)) {
      reject({ reason: 'no-binary', message: '找不到 dsh 可执行文件：' + state.binary });
      return;
    }
    let child;
    try {
      child = spawn(state.binary, cfg.acpArgs, {
        cwd: cfg.cwd,
        env: _childEnv(cfg),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject({ reason: (e && e.code === 'ENOENT') ? 'no-binary' : 'spawn', message: e && e.message });
      return;
    }
    state.child = child;

    let handshakeDone = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    /* stdout 只认协议行：按 \n 切，半行留到下一块（DSH 侧是 LineBuffer，行为一致）。 */
    let outBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBuf += chunk;
      let idx = outBuf.indexOf('\n');
      while (idx >= 0) {
        const line = outBuf.slice(0, idx);
        outBuf = outBuf.slice(idx + 1);
        if (line.trim()) {
          let msg = null;
          try { msg = JSON.parse(line); }
          catch (e) { _log('stdout 非协议行（已忽略）：' + line.slice(0, 200)); }
          if (msg) _onMessage(msg);
        }
        idx = outBuf.indexOf('\n');
      }
    });
    child.stdout.on('end', () => {
      if (outBuf.trim()) {
        try { _onMessage(JSON.parse(outBuf)); } catch (e) { /* 残行丢掉 */ }
        outBuf = '';
      }
    });

    /* stderr 只记日志，绝不进协议缓冲。 */
    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBuf += chunk;
      let idx = errBuf.indexOf('\n');
      while (idx >= 0) {
        const line = errBuf.slice(0, idx);
        errBuf = errBuf.slice(idx + 1);
        if (line.trim()) _log('dsh: ' + line.replace(/\s+$/, ''));
        idx = errBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      const reason = (err && err.code === 'ENOENT') ? 'no-binary' : 'spawn';
      if (!handshakeDone) {
        finish({ reason: reason, message: err && err.message });
      } else {
        _log('ACP 子进程错误：' + (err && err.message));
        state.acpBroken = true;
        state.acpBrokenReason = reason;
        state.ready = false;
        _rejectAll(reason, err && err.message);
      }
    });

    child.on('exit', (code, signal) => {
      const wasReady = handshakeDone;
      handshakeDone = true;
      if (state.child === child) state.child = null;
      state.ready = false;
      if (!settled) {
        /* 握手阶段就退出 → 算握手失败（最容易出现的「提前退出」）。 */
        _rejectAll('handshake', `ACP 子进程提前退出（code=${code}）`);
        finish({ reason: 'handshake', message: `ACP 子进程提前退出（code=${code} signal=${signal || ''}）` });
        return;
      }
      _log(`ACP 子进程退出：code=${code} signal=${signal || ''}`);
      state.acpBroken = true;
      state.acpBrokenReason = 'spawn';
      state.sessions.clear();
      state.turns.clear();
      _rejectAll(state.stopping ? 'stopped' : 'spawn', `ACP 子进程退出（code=${code}）`);
      if (wasReady) _log('ACP 通道已断开，后续任务走 headless');
    });

    /* initialize：clientCapabilities 只声明我们真的会做的事（不读文件、不开终端）。 */
    const initParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    };
    _request('initialize', initParams, cfg.handshakeTimeoutMs, 'initialize')
      .then((result) => {
        handshakeDone = true;
        if (!result || typeof result.protocolVersion !== 'number') {
          finish({ reason: 'handshake', message: 'initialize 响应缺 protocolVersion' });
          return;
        }
        _log(`ACP 握手成功：protocolVersion=${result.protocolVersion} agent=${(result.agentInfo && result.agentInfo.name) || '?'}`);
        finish(null);
      })
      .catch((e) => {
        _rejectAll('handshake', 'init 失败');
        finish({ reason: (e && e.reason === 'timeout') ? 'handshake' : ((e && e.reason) || 'handshake'), message: e && e.message });
      });
  });
}

/* 标记 ACP 不可用 + 杀掉子进程（SIGTERM → 3 秒 SIGKILL）。 */
function _killAcp(reason, message) {
  state.acpBroken = true;
  state.acpBrokenReason = reason || 'error';
  state.ready = false;
  _rejectAll(reason || 'error', message || 'ACP 通道已关闭');
  state.sessions.clear();
  state.turns.clear();
  const child = state.child;
  if (!child) return;
  state.child = null;
  try { child.kill('SIGTERM'); } catch (e) { /* 已经没了 */ }
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) { /* 已经没了 */ }
  }, 3000);
  if (timer.unref) timer.unref();
  child.once('exit', () => { try { clearTimeout(timer); } catch (e) { /* 忽略 */ } });
}

/* ---------------------------------------------------------------- 会话 */

function _ensureRec(key) {
  let rec = state.sessions.get(key);
  if (!rec) {
    rec = { key: key, sessionId: '', queue: Promise.resolve(), creating: null };
    state.sessions.set(key, rec);
  }
  return rec;
}

/* session/new 只在这里发；参数形状照 dsh-acp：cwd 必须绝对，mcpServers 空数组。 */
function _newSession(cwd, timeoutMs) {
  return _request('session/new', { cwd: cwd, mcpServers: [] }, Math.min(timeoutMs, 120000), 'session/new')
    .then((result) => {
      const sid = result && result.sessionId;
      if (!sid || typeof sid !== 'string') {
        throw { reason: 'error', message: 'session/new 没返回 sessionId' };
      }
      return sid;
    });
}

async function _ensureSession(rec, cwd, timeoutMs) {
  if (rec.sessionId) return rec.sessionId;
  if (!rec.creating) {
    rec.creating = _newSession(cwd, timeoutMs).then(
      (sid) => { rec.sessionId = sid; rec.creating = null; return sid; },
      (e) => { rec.creating = null; throw e; },
    );
  }
  return rec.creating;
}

/* ---------------------------------------------------------------- 任务 */

function _result(ok, text, reason, t0, sessionId) {
  return {
    ok: !!ok,
    text: text || '',
    reason: reason || '',
    ms: Date.now() - t0,
    sessionId: sessionId || '',
  };
}

/* 发 session/prompt，返回 { id, promise }；超时由 _promptOnce 管。 */
function _sendPromptRequest(sessionId, text) {
  const id = state.nextId++;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  state.pending.set(id, { resolve: resolveFn, reject: rejectFn, timer: null, label: 'session/prompt' });
  /* 线上形状：prompt 是 ContentBlock 数组，纯文本就是 [{"type":"text","text":"..."}] */
  const ok = _writeObj({
    jsonrpc: '2.0',
    id: id,
    method: 'session/prompt',
    params: { sessionId: sessionId, prompt: [{ type: 'text', text: text }] },
  });
  if (!ok) {
    state.pending.delete(id);
    promise.catch(() => {}); // 防止未处理拒绝
    return { id: id, promise: Promise.reject({ reason: 'spawn', message: 'ACP 子进程不可写' }) };
  }
  return { id: id, promise: promise };
}

/* 一次 prompt 往返：本轮正文累积 + 超时取消 + 结果判定。 */
async function _promptOnce(rec, sessionId, text, timeoutMs, t0) {
  const turn = { chunks: [] };
  state.turns.set(sessionId, turn); // 新的一轮：历史正文不会进这里
  const req = _sendPromptRequest(sessionId, text);

  const TIMEOUT = Symbol('timeout');
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });

  let outcome;
  try {
    outcome = await Promise.race([req.promise, deadline]);
  } catch (e) {
    if (timer) clearTimeout(timer);
    state.turns.delete(sessionId);
    throw e;
  }
  if (timer) clearTimeout(timer);

  if (outcome === TIMEOUT) {
    _log(`任务超时（${timeoutMs}ms），发 session/cancel`);
    _notify('session/cancel', { sessionId: sessionId });
    let graceOutcome;
    try {
      graceOutcome = await Promise.race([
        req.promise,
        _delay((state.config && state.config.cancelGraceMs) || DEFAULT_CANCEL_GRACE_MS).then(() => 'cancel-timeout'),
      ]);
    } catch (e) {
      if (e && e.reason === 'stopped') { state.turns.delete(sessionId); throw e; }
      graceOutcome = 'cancel-timeout';
    }
    if (graceOutcome === 'cancel-timeout') {
      _killAcp('timeout', '取消后仍无响应，已杀 ACP 子进程');
      state.turns.delete(sessionId);
      return _result(false, '', 'timeout', t0, sessionId);
    }
    outcome = graceOutcome; // 取消后 prompt 正常返回：下面按 stopReason 判
  }

  state.turns.delete(sessionId);
  const stopReason = outcome && outcome.stopReason;
  const finalText = turn.chunks.join('').trim();
  if (stopReason === 'cancelled') return _result(false, '', 'timeout', t0, sessionId);
  if (!finalText) return _result(false, '', 'error', t0, sessionId);
  return _result(true, finalText, '', t0, sessionId);
}

/* ACP 通道跑一个任务：按 sessionKey 串行，复用 sessionId。 */
async function _runAcpTask(o) {
  const rec = _ensureRec(o.key);
  const prev = rec.queue;
  const current = (async () => {
    await prev; // 同 key 排队：ACP 一个 session 同时只允许一个 prompt
    if (state.stopping) throw { reason: 'stopped', message: 'agent-link 已停止' };
    if (state.acpBroken) throw { reason: state.acpBrokenReason || 'spawn', message: 'ACP 通道不可用' };
    const sid = await _ensureSession(rec, o.cwd, o.timeoutMs);
    return _promptOnce(rec, sid, o.text, o.timeoutMs, o.t0);
  })();
  rec.queue = current.catch(() => {}); // 队列不被单次失败污染
  return current;
}

/* ---------------------------------------------------------------- headless 兜底 */

/* --json 模式：从 stdout 里找最后一个 final 事件（headless README 的输出契约）。 */
function _parseHeadlessJson(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev && ev.type === 'final') {
      return { text: typeof ev.text === 'string' ? ev.text : '', sessionId: ev.sessionId || '' };
    }
  }
  return null;
}

function _runHeadless(o) {
  return new Promise((resolve) => {
    const cfg = state.config || _settings({});
    const bin = state.binary || _resolveBinary(cfg);
    const t0 = o.t0;
    if (!_binaryUsable(bin)) {
      resolve(_result(false, '', 'no-binary', t0, ''));
      return;
    }
    const args = cfg.headlessArgs.slice();
    if (cfg.headlessJson) args.push('--json');
    /* 任务以 '-' 开头时补个 '--'，免得被 commander 当选项（README 说明只有孤立 '-' 是 stdin 标记）。 */
    if (/^-/.test(String(o.text))) args.push('--');
    args.push(o.text);

    let child;
    try {
      child = spawn(bin, args, {
        cwd: o.cwd,
        env: _childEnv(cfg),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(_result(false, '', (e && e.code === 'ENOENT') ? 'no-binary' : 'spawn', t0, ''));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderrTail = '';
    let errBuf = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      _log(`headless 超时（${o.timeoutMs}ms），杀子进程`);
      try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }, 3000);
      if (t.unref) t.unref();
      finish(_result(false, '', 'timeout', t0, ''));
    }, o.timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBuf += chunk;
      let idx = errBuf.indexOf('\n');
      while (idx >= 0) {
        const line = errBuf.slice(0, idx);
        errBuf = errBuf.slice(idx + 1);
        if (line.trim()) {
          _log('headless: ' + line.replace(/\s+$/, ''));
          stderrTail = line.trim();
        }
        idx = errBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      finish(_result(false, '', (err && err.code === 'ENOENT') ? 'no-binary' : 'spawn', t0, ''));
    });

    child.on('close', (code, signal) => {
      if (errBuf.trim()) {
        _log('headless: ' + errBuf.trim());
        stderrTail = errBuf.trim();
        errBuf = '';
      }
      let textOut = '';
      let sessionId = '';
      if (cfg.headlessJson) {
        const fin = _parseHeadlessJson(stdout);
        if (fin) { textOut = String(fin.text || '').trim(); sessionId = fin.sessionId || ''; }
      } else {
        textOut = String(stdout || '').trim();
      }
      if (code === 0 && textOut) {
        finish(_result(true, textOut, '', t0, sessionId));
      } else {
        if (code !== 0 && !stderrTail) stderrTail = `exit ${code}${signal ? ' signal ' + signal : ''}`;
        if (stderrTail) _log('headless 失败：' + stderrTail);
        finish(_result(false, textOut, 'error', t0, sessionId));
      }
    });
  });
}

/* ---------------------------------------------------------------- 对外 API */

/**
 * start(opts) — 幂等启动。ACP 优先（auto 模式），失败自动降级 headless，不抛未捕获异常。
 * @returns {Promise<{mode,ready,pid,sessions}>}
 */
async function start(opts) {
  if (state.startPromise) return state.startPromise;
  if (state.started) return status();

  state.startPromise = (async () => {
    const cfg = _settings(opts || {});
    state.config = cfg;
    state.binary = _resolveBinary(cfg);

    /* 进程退出兜底：不指望调用方一定记得 stop()，别留僵尸。 */
    if (!state.exitHookInstalled) {
      state.exitHookInstalled = true;
      process.once('exit', () => {
        if (state.child) { try { state.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }
      });
    }

    if (cfg.mode === 'headless') {
      state.mode = 'headless';
      state.ready = _binaryUsable(state.binary);
      state.started = true;
      _log(`agent-link 就绪（headless，binary=${state.binary}）`);
      return status();
    }

    let acpError = null;
    try {
      _log(`启动 ACP：${state.binary} ${cfg.acpArgs.join(' ')}（cwd=${cfg.cwd}）`);
      await _startAcp(cfg);
      state.mode = 'acp';
      state.ready = true;
      state.acpBroken = false;
      state.acpBrokenReason = '';
      state.started = true;
      _log('agent-link 就绪（ACP）');
      return status();
    } catch (e) {
      acpError = e || { reason: 'handshake' };
      _log(`ACP 不可用（${acpError.reason || 'handshake'}）：${acpError.message || ''}，降级 headless`);
      _killAcp(acpError.reason || 'handshake', acpError.message);
    }

    state.mode = 'headless';
    state.ready = _binaryUsable(state.binary);
    state.started = true;
    return status();
  })().finally(() => { state.startPromise = null; });

  return state.startPromise;
}

/**
 * runTask({text, sessionKey, timeoutMs, cwd}) — 跑一句话任务，拿回最终文本。
 * @returns {Promise<{ok,text,reason,ms,sessionId}>}
 */
async function runTask(args) {
  const opt = args || {};
  const t0 = Date.now();
  const text = typeof opt.text === 'string' ? opt.text : '';
  const key = String(opt.sessionKey || 'default');

  if (!text.trim()) return _result(false, '', 'error', t0, '');

  if (!state.started) {
    await start({});
  }
  if (!state.started) return _result(false, '', 'error', t0, '');
  if (state.stopping) return _result(false, '', 'stopped', t0, '');

  const cfg = state.config || _settings({});
  const timeoutMs = _num(opt.timeoutMs, cfg.timeoutMs);
  const cwd = _abs(opt.cwd || cfg.cwd || ROOT);

  /* 通道选择：ACP 坏了就一次性 headless，绝不再折腾 ACP。 */
  if (state.mode !== 'acp' || state.acpBroken) {
    return _runHeadless({ text: text, timeoutMs: timeoutMs, cwd: cwd, t0: t0 });
  }

  try {
    return await _runAcpTask({ text: text, key: key, timeoutMs: timeoutMs, cwd: cwd, t0: t0 });
  } catch (e) {
    const reason = (e && e.reason) || 'error';
    if (reason === 'stopped') return _result(false, '', 'stopped', t0, '');
    if (reason === 'timeout') return _result(false, '', 'timeout', t0, '');
    /* 通道级失败（子进程没了/写不进去/握手失效）→ 同一任务走 headless 重跑一次。 */
    _log(`ACP 任务失败（${reason}：${(e && e.message) || ''}），改走 headless`);
    // 2026-11-25：这类失败以前只进内存日志，事后查不到源头 → 上报给守望任务
    try { require('./diag/report').report('agent-link', e && e.message || ('ACP 任务失败：' + reason), { reason, task: key }); } catch (e2) {}
    _killAcp(reason, e && e.message);
    return _runHeadless({ text: text, timeoutMs: timeoutMs, cwd: cwd, t0: t0 });
  }
}

/**
 * stop() — 幂等关闭：能关的 session 先关，再 SIGTERM，3 秒后 SIGKILL。
 */
async function stop() {
  if (state.stopPromise) return state.stopPromise;
  if (!state.started && !state.child) {
    state.ready = false;
    return;
  }
  state.stopPromise = (async () => {
    state.stopping = true;
    try {
      const recs = [...state.sessions.values()].filter((r) => r.sessionId);
      for (const rec of recs) {
        try {
          await _request('session/close', { sessionId: rec.sessionId }, 2000, 'session/close');
        } catch (e) {
          _log(`关闭会话失败（${rec.sessionId}）：${(e && e.message) || ''}`);
        }
      }
      state.sessions.clear();
      state.turns.clear();
      _rejectAll('stopped', 'agent-link 已停止');

      const child = state.child;
      if (child) {
        const exited = new Promise((resolve) => {
          let done = false;
          const onExit = () => { if (done) return; done = true; resolve(true); };
          child.once('exit', onExit);
          const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3000);
          if (t.unref) t.unref();
        });
        try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ }
        const ok = await exited;
        if (!ok) {
          _log('ACP 子进程 3 秒未退，SIGKILL');
          try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
          await _delay(200);
        }
      }
    } finally {
      state.child = null;
      state.pending.clear();
      state.acpBroken = false;
      state.acpBrokenReason = '';
      state.started = false;
      state.ready = false;
      state.mode = null;
      state.stopping = false;
      _log('agent-link 已停止');
    }
  })().finally(() => { state.stopPromise = null; });

  return state.stopPromise;
}

/**
 * status() — 当前通道、是否就绪、子进程 pid、活跃会话。
 */
function status() {
  const sessions = [];
  for (const rec of state.sessions.values()) {
    if (rec.sessionId) sessions.push({ key: rec.key, sessionId: rec.sessionId });
  }
  return {
    mode: state.mode,
    ready: !!state.ready,
    pid: (state.child && state.child.pid) ? state.child.pid : 0,
    sessions: sessions,
  };
}

/* runTask 是"派活给 DSH"的唯一出口，失败原来只 console 一行，重启就没了。
 * 包一层：出错先落进错误日志（同一个 area 一分钟一条），再按原样往上抛，
 * 上层看到的返回/异常不变。 */
const _runTaskRaw = runTask;
function runTaskTraced() {
  try {
    const r = _runTaskRaw.apply(this, arguments);
    if (r && typeof r.catch === 'function') {
      return r.catch((e) => {
        try { require('./diag/report').report('agent-link.runTask', e); } catch (e2) {}
        throw e;
      });
    }
    return r;
  } catch (e) {
    try { require('./diag/report').report('agent-link.runTask', e); } catch (e2) {}
    throw e;
  }
}

module.exports = { start, stop, runTask: runTaskTraced, status };
