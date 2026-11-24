/*
 * app/bot-runner.js — 让客户端把机器人本体（src/bot.js）拉起来
 *
 * 为什么要这个（2026-11-05 她定「优先做让机器人跑起来的转移」）：
 *   原来机器人靠 tools/启动机器人.command 开一个终端窗口，窗口一关就掉线，
 *   而且要先开 NapCat 再开窗口，她记不住顺序。现在：
 *     双击客户端 → 界面起来，机器人也起来
 *
 * 常驻开关（2026-11-05 晚她要的）：默认「关掉客户端后机器人继续跑」。
 *   做法：拉起来时 detached，父子关系断开，客户端退出带不走它；
 *   客户端再打开会按 data/bot.pid 认出它，不会开第二个。
 *   想恢复「关客户端就下线」，在「机器人」页把那个勾去掉。
 *
 * 只有一份代码：真正干活的是 src/bot.js，这里只负责起进程、看死活、给界面读数。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');            // xuhbot/
const SRC = path.join(ROOT, 'src');
const DATA = path.join(SRC, 'data');
const PID_FILE = path.join(DATA, 'bot.pid');           // bot.js 启动时自己写，退出时自己删
const OUT_LOG = path.join(DATA, 'bot-out.log');
const ERR_LOG = path.join(DATA, 'bot-err.log');
const STATUS_FILE = path.join(DATA, 'bot-status.json');
const UI_JSON = path.join(DATA, 'ui.json');            // 客户端外观配置；常驻开关也记在这

let child = null;        // 本客户端拉起来的那个进程
let wantRun = false;     // 希望它在跑（自动重启只看这个）
let restarts = 0;        // 连续重启次数
let lastExit = '';       // 上一次退出码
let restartTimer = null;
let watchdog = null;     // 看护定时器（2026-11-06 加：7×24 常驻必须有人守着）
let manualStop = false;  // 用户点了「停止」→ 看护不自动拉起（尊重她的意思）
let restarting = false;  // 正在主动重启（2026-11-14）：退出回调别再多排一次自动重开

/* ---------- 小工具 ---------- */

// 进程还在不在（进程号可能被系统回收给别人，所以还要看 pid 文件里的数字对不对得上）
function alive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

function readPid() {
  try {
    const s = fs.readFileSync(PID_FILE, 'utf8').trim();
    return /^\d+$/.test(s) ? Number(s) : 0;
  } catch { return 0; }
}

// 用哪个 node：WorkBuddy 自带的版本目录 → WorkBuddy 应用内的 Electron（当 node 用）
// Electron 这条兜底是必须的：这台机器 PATH 里没有 node，只认版本目录的话「重启后端」会直接失败。
const WB_ELECTRON = '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
function nodeCmd() {
  const base = path.join(process.env.HOME || '', '.workbuddy', 'binaries', 'node', 'versions');
  try {
    const list = fs.readdirSync(base).sort();
    for (let i = list.length - 1; i >= 0; i--) {
      const p = path.join(base, list[i], 'bin', 'node');
      if (fs.existsSync(p)) return { bin: p, env: {} };
    }
  } catch {}
  if (fs.existsSync(WB_ELECTRON)) return { bin: WB_ELECTRON, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { bin: 'node', env: {} };
}

// 读 bot-status.json（bot 自己写的连接状态）
function botStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) || {}; } catch { return {}; }
}

/* ---------- 常驻开关 ----------
 * 存 data/ui.json 的 botKeepAlive。默认「开」——她 2026-11-05 明确说要，
 * 所以没写过的旧配置也按开处理（只有明确写 false 才是关）。 */
function keepAlive() {
  try {
    const d = JSON.parse(fs.readFileSync(UI_JSON, 'utf8'));
    return !(d && d.botKeepAlive === false);
  } catch { return true; }
}
function setKeepAlive(on) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(UI_JSON, 'utf8')) || {}; } catch {}
  d.botKeepAlive = !!on;
  try {
    fs.mkdirSync(path.dirname(UI_JSON), { recursive: true });
    fs.writeFileSync(UI_JSON, JSON.stringify(d, null, 2) + '\n');
  } catch (e) { return { error: '存不下：' + (e && e.message || e) }; }
  return { ok: true, keepAlive: !!on };
}

/* ---------- 起进程 ---------- */

function spawnNow() {
  if (child && alive(child.pid)) return { ok: true, already: true, pid: child.pid };
  const nodeInfo = nodeCmd();
  const bin = nodeInfo.bin;
  let out, err;
  try {
    out = fs.openSync(OUT_LOG, 'a');
    err = fs.openSync(ERR_LOG, 'a');
  } catch {}
  // cwd 必须是 src：所有模块按 __dirname 找数据，但 qzone 等脚本会读 cwd
  const c = spawn(bin, ['bot.js'], {
    cwd: SRC,
    env: Object.assign({}, process.env, nodeInfo.env),
    stdio: ['ignore', out || 'ignore', err || 'ignore'],
    // 独立会话：客户端一退，系统不会连着把它收走（常驻就靠这个）
    detached: true,
  });
  child = c;
  // 日志 fd 已经交给子进程，父进程必须关掉自己那份：
  // 以前每拉起一次泄漏 2 个 fd，重启几十次就攒下上百个句柄。
  try { if (out) fs.closeSync(out); } catch {}
  try { if (err) fs.closeSync(err); } catch {}
  // 断开引用：客户端退出时不会等它、也不会带走它
  try { c.unref(); } catch {}
  // 这里**不写** bot.pid（2026-11-05 修）：文件由 bot.js 自己独占写，
  // 否则 runner 抢先写成新 pid，bot.js 的单例锁读到的就是自己 → 拦不住第二个实例。
  lastExit = '';
  console.log('[机器人] 已拉起 pid=' + c.pid + '（' + bin + '）');

  c.on('error', e => {
    console.log('[机器人] 起不来：' + (e && e.message || e));
    lastExit = String(e && e.message || e);
  });
  c.on('exit', code => {
    // 2026-11-14：这个回调只认它自己那个进程。主动重启时旧进程的 exit 迟到一步，
    // 若还按模块级 child 处理，会把刚拉起的新进程引用清成 null（看护于是再开一个）。
    if (child !== c) return;
    // 退出码 3 = bot.js 的单例锁发现「已经有一个在跑」，主动退出。
    // 这不是崩溃，不能重启（否则 5 秒一次地开、开完又退，日志刷满）。
    if (code === 3) {
      lastExit = '已有实例在跑';
      console.log('[机器人] 已有实例在跑，本次不重复拉起');
      child = null;
      wantRun = false;
      return;
    }
    lastExit = '退出码 ' + code;
    console.log('[机器人] 进程退出：' + lastExit);
    child = null;
    if (!wantRun || restarting) return;   // 主动重启时由 restart() 自己拉起，不排自动重开
    restarts++;
    const wait = restarts > 5 ? 60000 : 5000;
    if (restarts > 5) restarts = 0;      // 连崩 5 次后歇一分钟，再从头数
    restartTimer = setTimeout(() => { if (wantRun) spawnNow(); }, wait);
  });
  return { ok: true, pid: c.pid };
}

/* ---------- 对外 ---------- */

// 界面看的全部信息：在不在跑、连没连上 QQ、日志末尾
function status() {
  const pid = child ? child.pid : readPid();
  const running = alive(pid);
  const st = botStatus();
  return {
    ok: true,
    running,
    pid: running ? pid : 0,
    online: !!(running && st.online),
    detail: (running ? (st.detail || '') : (lastExit ? '上次：' + lastExit : '没在跑')),
    at: st.at || '',
    mine: !!(child && alive(child.pid)),
    restarts,
    node: nodeCmd().bin,
    keepAlive: keepAlive(),
    // 群禁言（2026-11-05）：机器人自己被禁言的群，面板上直接写明「这个群不回话是因为禁言」
    muted: (running && Array.isArray(st.muted)) ? st.muted : [],
  };
}

function start() {
  wantRun = true;
  manualStop = false;
  restarts = 0;
  const pid = readPid();
  if (alive(pid) && !child) {
    // 已经有一个（可能是终端窗口开的）：接管显示，但不去动它的进程
    return { ok: true, already: true, pid, note: '机器人已经在跑了（不是客户端开的，退出客户端不会停它）' };
  }
  return spawnNow();
}

function stop() {
  wantRun = false;
  manualStop = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const pid = child ? child.pid : readPid();
  if (!alive(pid)) return { ok: true, note: '本来就没在跑' };
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { error: '停不下来：' + (e && e.message || e) }; }
  return { ok: true, pid };
}

/* ---------- 重启（2026-11-14 主人要「客户端一键重启后端」）----------
 * 改完代码必须重启后端才生效，以前只能关客户端再开（还常忘了，旧进程一跑两天）。
 * 这里按正规顺序来：SIGTERM → 等旧进程真退出（最多 10 秒）→ 再拉新的。
 * 不等它退就 spawn 会撞 bot.js 的单例锁（退出码 3），看起来像「重启失败」。
 * 实在不退才 SIGKILL 兜底，并且如实报错，不假装成功。 */
function waitGone(pid, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const step = () => {
      if (!alive(pid)) return resolve(true);
      if (Date.now() - t0 >= ms) return resolve(false);
      setTimeout(step, 200);
    };
    step();
  });
}

async function restart() {
  wantRun = true;          // 重启后要它在跑
  manualStop = false;
  restarts = 0;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const pid = child ? child.pid : readPid();
  restarting = true;
  try {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); }
      catch (e) { return { error: '停不下来：' + (e && e.message || e) }; }
      if (!await waitGone(pid, 10000)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        if (!await waitGone(pid, 3000)) {
          return { error: '旧进程杀不掉（pid ' + pid + '），请手动看一下' };
        }
      }
    }
    child = null;           // 旧的那个已经死了，别让 spawnNow 以为还在
    const r = spawnNow();
    return Object.assign({ restarted: true, oldPid: pid || 0 }, r);
  } finally {
    restarting = false;
  }
}

/* ---------- 看护（2026-11-06 加）----------
 * 她 2026-11-05 要「7×24 常驻」，但实测有个洞：客户端启动时如果发现机器人**已经在跑**
 * （终端窗口开的、我手动起的），它只是「接管显示」，child 是空的 → 那台进程一旦崩了，
 * 没有 exit 回调、没人重启，就一直躺到下次开客户端。
 * 现在客户端开着期间每 15 秒看一眼：没在跑就拉起来。
 * 她点了「停止」就不拉（manualStop），再点「启动」恢复。
 */
function watch(on) {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (on === false) return { ok: true, watching: false };
  watchdog = setInterval(() => {
    if (manualStop) return;
    if (status().running) return;
    console.log('[机器人] 看护：发现没在跑，拉起来');
    try { start(); } catch (e) { console.log('[机器人] 看护拉起失败：' + (e && e.message || e)); }
  }, 15000);
  try { watchdog.unref && watchdog.unref(); } catch {}
  return { ok: true, watching: true };
}

// 客户端退出时调用
function shutdown() {
  wantRun = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!child) return { kept: false };
  // 常驻：进程留着，只断开引用；下次开客户端按 bot.pid 认它
  if (keepAlive()) {
    console.log('[机器人] 客户端退出，常驻开着 → 机器人继续跑 pid=' + child.pid);
    try { child.unref(); } catch {}
    child = null;
    return { kept: true };
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  child = null;
  return { kept: false };
}

// 日志尾巴（界面上「最近怎么了」）：默认 40 行
function tail(n) {
  const want = Math.min(Math.max(Number(n) || 40, 10), 400);
  const read = f => {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-want);
    } catch { return []; }
  };
  return { ok: true, out: read(OUT_LOG), err: read(ERR_LOG).slice(-20) };
}

module.exports = { status, start, stop, restart, shutdown, tail, keepAlive, setKeepAlive, watch, PID_FILE };
