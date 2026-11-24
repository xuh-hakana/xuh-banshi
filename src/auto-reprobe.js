/* ===========================================================================
 * auto-reprobe.js — 平台改版 → 自动重测字数上限（2026-11-17 主人令）
 *
 * 这是干什么的：定期采各平台版本号，版本一变就自动重测该平台字数上限、
 *   写回 platform-limits，并私信告诉主人。主人 2026-11-17 原话：
 *   「有版本号，QQ也是，追踪即可」「自动重测并写回」。
 *
 * 版本源：
 *   qq   NapCat get_version_info → app_version（框架版本，非 QQ 客户端版本）
 *   bili B站首页 grayVersion + nanoHash（连拉 3 次稳定）
 *
 * 触发映射：
 *   qq 版本变   → 测 QQ聊天 + QQ动态（动态发完自删）
 *   bili 版本变 → 测 B站评论 + B站私信
 *
 * 防刷屏 / 防反复：
 *   · 第一次采到版本 = 记基线，changed=false，不触发（否则一启动就刷屏）
 *   · 同一版本重复采 → changed=false，不触发
 *   · 变化后不管重测成败都把记录更新成新版本 → 不会再触发第二次
 *   · 重测失败 → 记一条告警让主人知道，但不无限重试
 *
 * 通知口径（2026-11-18 主人令）：
 *   · 只有「版本变了」「重测完成」私信主人；其余（已启动/没读到版本/读失败/写失败/出错）
 *     一律走 note() 只写日志，不私信。已启动是每次进程启动都打，不是定时器打的。
 *
 * 解耦：QQ 的发包/读版本/动态自删都在 qq.js（要 WS），本模块通过 start(ctx)
 *   注入这些回调；B站两条走 bili-probe.js（HTTP，本模块可直接调）。
 *   ctx = {
 *     readQQVersion:  async () => '4.18.41' | '',
 *     reprobeQQ:      async () => {ok,cap,error}   // QQ聊天，往主人私信发包
 *     reprobeQzone:   async () => {ok,cap,error}   // QQ动态，发完自删
 *     notify:         (text) => void               // 私信告诉主人（qq.sendPrivate）
 *     log:            (text) => void               // 写日志（可选）
 *   }
 * =========================================================================== */
const platVersion = require('./platform-version');
const biliProbe = require('./bili-probe');
const qzoneProbe = require('./qzone-probe');   // 2026-11-17：QQ 改版时连空间风控额度一起重测
const core = require('./core');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36';
const BILI_HOME = 'https://www.bilibili.com/';
const CHECK_MS = 6 * 60 * 60 * 1000;   // 每 6 小时查一次；启动后 90 秒查第一次
const FIRST_DELAY_MS = 90 * 1000;

let ctx = null;
let timer = null;
let running = false;   // 防上一轮没跑完这一轮又来

/* 读 B站网页版本：grayVersion + nanoHash 拼成一个串，任一变都算改版。 */
async function readBiliVersion() {
  try {
    const r = await fetch(BILI_HOME, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    const g = (t.match(/grayVersion["':\s]+(\d+)/) || [])[1] || '';
    const n = (t.match(/__NANO_VERSION_HASH__\s*=\s*["']([0-9a-f]+)["']/) || [])[1] || '';
    return g || n ? (g + '|' + n) : '';
  } catch { return ''; }
}

function say(text) {
  if (!text) return;
  try { ctx && ctx.notify && ctx.notify(text); } catch {}
  try { ctx && ctx.log && ctx.log(text); } catch {}
  try { core.logLine('auto-reprobe', '', text, true, ''); } catch {}
}

/* 只写日志、不私信（2026-11-18 主人令）：例行话不打扰主人。
 *   「已启动」是每次后端启动都会打的，不是定时器；以前走 say() 会每重启一次私信一条。 */
function note(text) {
  if (!text) return;
  try { ctx && ctx.log && ctx.log(text); } catch {}
  try { core.logLine('auto-reprobe', '', text, true, ''); } catch {}
}

/* 采一个平台的版本，判变化；变了就重测。one 的字段：
 *   key         'qq' | 'bili'
 *   label       给主人看的名
 *   readVersion async () => version 串
 *   reprobes    async () => [{name, run: async () => result}] —— 变化后依次跑 */
async function checkOne(one) {
  let ver = '';
  try { ver = await one.readVersion(); } catch (e) { note('[版本追踪] 读 ' + one.label + ' 版本失败：' + (e && e.message || e)); return; }
  if (!ver) { note('[版本追踪] 没读到 ' + one.label + ' 版本，本轮跳过（不判变化、不动记录）。'); return; }
  const s = platVersion.submit(one.key, ver);
  if (!s.ok) { note('[版本追踪] ' + one.label + ' 版本记录写失败：' + s.error); return; }
  if (!s.changed) return;   // 首次基线 or 版本没变

  say('[版本追踪] ' + one.label + ' 版本变了：' + (s.oldVersion || '(首次)') + ' → ' + s.version + '，自动重测字数上限…');
  const results = [];
  for (const job of one.reprobes) {
    try {
      const r = await job.run();
      results.push(job.name + '：' + (r && r.text
        ? r.text
        : (r && r.ok
          ? ('实测 ' + r.cap + ' 字' + (r.error ? '（' + r.error + '）' : ''))
          : ('没测成 ' + ((r && r.error) || '未知')))));
    } catch (e) { results.push(job.name + '：出错 ' + (e && e.message || e)); }
  }
  say('[版本追踪] ' + one.label + ' 重测完成 → ' + results.join('；'));
}

async function tick() {
  if (!ctx || running) return;
  running = true;
  try {
    await checkOne({
      key: 'qq', label: 'QQ(NapCat)',
      readVersion: () => ctx.readQQVersion(),
      reprobes: [
        { name: '聊天', run: () => ctx.reprobeQQ() },
        { name: '动态', run: () => ctx.reprobeQzone() },
        // 2026-11-17 主人令：频率/额度也随 QQ 改版重测。只读那项主动探，
        //   写操作两项只从真实记录学（撞顶代价太大，不主动撞）。
        { name: '空间额度', run: () => qzoneProbe.probeAll() },
      ],
    });
    await checkOne({
      key: 'bili', label: 'B站网页',
      readVersion: readBiliVersion,
      reprobes: [
        { name: '评论', run: () => biliProbe.probe('biliC') },
        { name: '私信', run: () => biliProbe.probe('biliD') },
      ],
    });
  } finally { running = false; }
}

/* 由 bot.js 在启动后调用。回调注入 QQ 侧能力。 */
function start(injected) {
  ctx = injected || {};
  if (timer) return;
  setTimeout(() => { tick().catch(e => note('[版本追踪] 首轮出错：' + (e && e.message || e))); }, FIRST_DELAY_MS);
  timer = setInterval(() => { tick().catch(e => note('[版本追踪] 定时出错：' + (e && e.message || e))); }, CHECK_MS);
  note('[版本追踪] 已启动：启动后 ' + (FIRST_DELAY_MS / 1000) + ' 秒查一次，之后每 ' + (CHECK_MS / 3600000) + ' 小时一次。');
}

/* 手动触发一轮（panel 测试用）；返回本轮结果文本，不私信。 */
async function runNow(injected) {
  if (injected) ctx = injected;
  if (!ctx) return { ok: false, error: '还没 start，没注入 QQ 回调' };
  await tick();
  return { ok: true, versions: platVersion.all() };
}

module.exports = { start, tick, runNow, readBiliVersion, CHECK_MS, FIRST_DELAY_MS };
