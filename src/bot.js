/*
 * bot.js — 启动入口
 * 加载 config.json，启动 QQ / B站 两个连接器，共享一个大脑。
 */
const fs = require('fs');
const path = require('path');

/* ===== 单例锁（2026-11-05 23:40 修，她报「现在更多了」）=====
 * 真事：客户端 + 我手动重启 + 终端窗口，各自拉起一份，`data/bot.pid` 只记得住最后一个，
 * 前面的实例没人知道还活着。NapCat 的 3001 被 4 个进程同时连着 → **同一条消息回四遍**，
 * 群里每条都刷 3~4 条一模一样的（`[禁言]` 日志也重复 4 次）。
 * 以前只在「启动时写 pid」,没人在启动时**读**它。现在第二个实例一进来就退，不碰任何数据。
 * 退出码 3 = 已有实例（app/bot-runner.js 认这个码，不会当崩溃去重启）。
 *
 * 2026-11-06 00:15 补一刀（还会开出两个，实测）：
 *   原来「先读 pid 判断、再写 pid」，中间隔着 require('./core') 那几秒。
 *   客户端 kill 掉旧进程后会 5 秒自动重启一份，正好卡在这几秒里读到**空文件** → 两个都放行。
 *   现在改成 O_EXCL 原子创建（`flag:'wx'` 文件已存在就抛 EEXIST）：谁先建到谁算数，
 *   后来那个一定抛错、一定去判活，不存在「都读到空」的窗口。
 *   写 pid 放在所有 require 之前——占坑要快。 */
const PID_FILE = path.join(__dirname, 'data', 'bot.pid');
function pidAlive(n) { try { process.kill(Number(n), 0); return true; } catch { return false; } }
function readPidFile() {
  try { const s = fs.readFileSync(PID_FILE, 'utf8').trim(); return /^\d+$/.test(s) ? Number(s) : 0; } catch { return 0; }
}
{
  let got = false;
  for (let i = 0; i < 2 && !got; i++) {
    try {
      fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
      fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });   // 原子：已存在 → EEXIST
      got = true;
    } catch (e) {
      if (e && e.code !== 'EEXIST') { got = true; break; }              // 写不了就别把机器人卡死
      const other = readPidFile();
      if (other && other !== process.pid && pidAlive(other)) {
        console.error('[机器人] 已经有实例在跑（pid=' + other + '），本次不再开第二个，退出');
        process.exit(3);
      }
      try { fs.unlinkSync(PID_FILE); } catch {}                         // 僵尸锁：那个进程已经死了
    }
  }
  if (!got) {
    console.error('[机器人] 抢不到 data/bot.pid（有别的实例在跑），本次退出');
    process.exit(3);
  }
}

const core = require('./core');
const qq = require('./connectors/qq');
/* 2026-11-19 主人令：B站三个连接器（直播 / 评论区召唤 / 私信）是失效旧代码，已删。
 * B站的回复由 AstrBot 的 astrbot_plugin_bilibili_ai_bot 负责（读 xuhchatrule/persona/）；
 * xuhbot 这边只剩不发模型的两件事：测字数上限的发包 + 面板收图，都在 bili-api.js 里，
 * 由 bili-probe.js / panel.js 按需 require，不在这里常驻启动。 */

/* ===== 兜底（v88，主人 2026-10-23 报的 bug：一直开着 启动.bat 却掉线）=====
 * 真事：以前这里一个兜底都没有。Node 15 以后，任何一次没人 catch 的异常、被拒的 Promise
 * 都会让进程直接退出；而 启动.bat 的窗口只是停在 pause 上（看起来还开着），
 * 所以就出现「窗口明明开着、机器人却不说话」。现在：
 *   ① 异常一律写 data/bot-err.log 然后继续跑（能救回来的就不至于整只死掉）；
 *   ② 日志里带时间戳，事后能对上「几点掉的」。
 * 进程活不活由 data/bot-status.json 里的 pid 说了算（每秒心跳会刷新它），自检和面板都查这个。
 */
const ERR_LOG = path.join(__dirname, 'data', 'bot-err.log');
function logErr(tag, e) {
  const line = new Date().toISOString() + ' [' + tag + '] ' + ((e && e.stack) || e) + '\n';
  try { fs.appendFileSync(ERR_LOG, line); } catch {}
  try { console.error('[兜底] ' + tag + '：' + ((e && (e.message || e)) || '')); } catch {}
}
process.on('uncaughtException', e => logErr('没人接的异常', e));
process.on('unhandledRejection', e => logErr('没人接的 Promise', e));
// 被关窗口/任务管理器杀掉时留个话，事后一眼看出「不是自己崩的」
// 派活用到的两个子进程（意图分类器 / DSH agent 通道）必须跟着主进程一起收掉，
// 否则重启机器人会留下孤儿 python / dsh 进程，下次起两个一起抢。
function stopAgentChannels() {
  try { require('./agent-link').stop(); } catch {}
}
process.on('SIGINT', () => { logErr('收到退出信号', 'SIGINT（窗口被 Ctrl+C / 关闭）'); stopAgentChannels(); process.exit(0); });
process.on('SIGTERM', () => { logErr('收到退出信号', 'SIGTERM（被外部结束）'); stopAgentChannels(); process.exit(0); });

/* ===== 进程号落盘（2026-11-05）：让「客户端」和「启动机器人.command」都能判断
 * 「是不是已经有一个在跑了」。原来靠 data/bot-status.json 里的 pid，但那是连上
 * NapCat 之后才写的——进程刚起、或正在重连时是旧值，于是会开出第二个机器人，
 * 一条消息回两遍（她最烦的双份）。
 * 2026-11-06：写 pid 已挪到文件最开头（单例锁用 O_EXCL 原子占坑），这里只负责退出时删。
 * 删之前核对号码：别的实例后来覆盖过 pid 文件的话，不能把它删掉。 */
function clearPid() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {}
}
process.on('exit', clearPid);

const configStore = require('./config');
const cfg = configStore.load();   // 从 config/ 四个分区合并（同旧 config.json 形状）
const BUILD = 'v101 · 2026-10-23（接入 SealDice 官方引擎：骰子语法补全，.rb100/.ww100 能掷了）';
const BUILD_TAG = 'v101-2026-10-23';
core.init(cfg);
core.netCheck();   // 开机自检：DNS + 能否连到接口（不花 token）

// 私发主人：日记 / 缺表情提醒等 → QQ 私聊真发给主人（v64 修：以前只打到控制台，主人根本收不到），控制台留档
core.setMasterDeliver(text => {
  console.log('[发给主人]\n' + text);
  const to = String(cfg.masterQQ || '');
  if (to) { try { qq.sendPrivate(to, String(text)); } catch (e) { console.error('[发给主人] 私聊发不出去：' + e.message); } }
});

/* 日记：一天一篇，全流程交给 src/diary-flow.js（2026-11-18 主人令）
 *
 * 她的原话：「一天只需要一篇完整的。等群里出现晚安/我直接私信发给虚幻今天结束等
 *   表示一天结束时/时间确实到了8:00时。时间限制是作为1天的兜底。如果22:00时且群里
 *   长时间静默，虚幻自己要来询问我是否结束今天并写日记。我可以发「重写」驳回写的差的。
 *   我认为可以就发「发」。然后此通过的日记同步发QQ空间、b站动态。」
 *
 * 这里只负责「定时叫醒」：08:00 兜底补、22:00 静默问她。群晚安和她的私信在 qq.js 里触发。
 * 老的两套定时器（00:05 写昨天 / 攒够条数写多篇）已删 —— 她定一天一篇，多篇那套作废。 */
const diaryFlow = require('./diary-flow');
const biliPublisher = require('./bili-dynamic-publisher');   // 搬屎/日记 → B站动态，共用每天 10 条额度
biliPublisher.start();
diaryFlow.ensureInit();                     // 首次启用：游标从当前这条开始，不追历史
function diaryTick() {
  try { diaryFlow.tick(); } catch (e) { console.error('[diary-flow] tick 出错：' + e.message); }
}
setInterval(diaryTick, 60 * 1000);
setTimeout(diaryTick, 90 * 1000);           // 开机 90 秒补一次（等连接器起来、别和自检抢）

// 话题日志自动总结（v64，主人定「记录文件不许没下文」）：每 30 分钟后台整一批，
// 开机 90 秒先整一次；走备用模型不抢主模型。面板里手动总结照旧可用。
setInterval(() => {
  core.topicAutoSum().catch(() => {});
}, 30 * 60 * 1000);
setTimeout(() => { core.topicAutoSum().catch(() => {}); }, 90 * 1000);

/* 学习系统：好感衰减结算（2026-11-09，主人定的规则）
 * 「触发一次掉好感后每天按那次的数量掉，直到触发加好感」。
 * 每 30 分钟醒一次，只有真的跨过整天才会写一条，平时是空跑。
 * 放在聊天热路径之外：一轮回复不因为它变慢。 */
const learn = require('./learn');
const learnTickMin = Number((cfg.learn || {}).tickMin) || 30;
setInterval(() => { try { learn.tick(); } catch (e) {} }, learnTickMin * 60 * 1000);
setTimeout(() => { try { learn.tick(); } catch (e) {} }, 20 * 1000);

// 冷层补录（2026-11-09 P1）：每 3 分钟把 chat-log 新增的行补进 acts，不碰发送热路径。
// 只读文本流水 + 追加写，失败只 warn；第一次跑会从头补，之后按游标增量。
const learnActsSync = () => {
  if (((cfg.learn || {}).acts) === false) return;
  try {
    const r = learn.acts.syncFromChatLog();
    if (r && r.added) console.log('[learn] 冷层补录 ' + r.added + ' 条');
  } catch (e) { try { console.warn('[learn] 冷层补录失败：' + (e && e.message)); } catch (_) {} }
};
setInterval(learnActsSync, 3 * 60 * 1000);
setTimeout(learnActsSync, 45 * 1000);

// 自查（v66，主人 2026-10-23 定）：功能坏了/被删了 → 攒够 10 分钟私信提醒主人，修好前每小时再提一次
const selfwatch = require('./selfwatch');
selfwatch.start({
  remind: text => {
    console.log('[自查→主人]\n' + text);
    const to = String(cfg.masterQQ || '');
    if (to) { try { qq.sendPrivate(to, text); } catch (e) { console.error('[自查] 私聊发不出去：' + e.message); } }
  },
  // v76（主人 2026-10-23 定）：自查发现/修好的每一件事都写进她的反馈，面板「虚幻自查」页看得见
  feedback: (kind, text) => core.aiFeedback(kind, text),
});

qq.start(cfg);

/* 派活（2026-11-22 主人定）：「这条消息是不是真活」由意图分类器判，真活交给 DSH agent 真去干，
 * 闲聊照旧交给免费模型。两个子进程都在这里起：分类器（python 常驻）+ DSH 通道（acp 常驻）。
 * 起不来不影响机器人本身——qq.js 那边的调用点已经用 try/catch + fail-closed 兜住了。 */
try {
  // intent-router 已改成纯判定（同步读配置，不需要起进程）；这里只起 DSH 通道。
  require('./agent-link').start();
} catch (e) { console.log('[派活] 通道没起来：' + (e && e.message)); }

// 2026-11-19：这三行（bili.start / biliComment.start / biliDm.start）随失效连接器一起删除。
// 原来 biliComment.start() 是被无条件调用的，导致每 60 秒打一次注定 -101 的请求还重写状态文件。

/* 指令小端口（2026-11-19 主人令）：B站 的聊天在 AstrBot 那边，它要把主人的私聊指令和
 * 任何场景的纠错回传给 xuhbot。面板 8899 只有桌面客户端开着时才有，机器人单独跑时没有，
 * 所以这里跟着机器人起一个只监听本机的 8898，专门接这两条路。 */
try { require('./nl-server').start(); } catch (e) { console.log('[指令端口] 没起来：' + e.message); }

// 平台改版追踪（2026-11-17 主人令）：版本号变了就自动重测字数上限并写回。
// QQ 侧能力（读 NapCat 版本 / 往主人私信发包 / 发说说自删）只有 bot 进程有 WS，注入进去。
const autoReprobe = require('./auto-reprobe');
autoReprobe.start({
  readQQVersion: () => qq._readNapcatVersion(),
  reprobeQQ: () => qq._probeQQChat(cfg.masterQQ, t => { try { qq.sendPrivate(String(cfg.masterQQ || ''), t); } catch {} }),
  reprobeQzone: () => qq._probeQzone(t => { try { qq.sendPrivate(String(cfg.masterQQ || ''), t); } catch {} }),
  notify: t => { try { qq.sendPrivate(String(cfg.masterQQ || ''), t); } catch {} },
  log: t => console.log('[版本追踪] ' + t),
});

console.log(`== BUILD ${BUILD_TAG} ==`);
console.log(`后端已启动（${cfg.botName}）｜版本 ${BUILD}`);
console.log('QQ → NapCat 需先开启 3001 WebSocket 服务器；B站 → 填好 config.json 的 bilibili 段');
