/* ===========================================================================
 * limit-probe.js — 探测各平台真实字数上限（2026-11-17 主人令）
 *
 * 这是干什么的：平台字数改版后，"缩减要能知道、增加靠测试"。本模块递增长度往
 *   指定测试场发包，按成功/失败二分逼近平台上限，把实测值写回 platform-limits。
 *
 * 测试场（主人 2026-11-17 指定，2026-11-19 改成小号自己那条视频）：
 *   qq    QQ 聊天 → 主人的 QQ 私信（发的是测试串，不是人话）
 *   biliC B站评论 → 小号「虚幻世界的电子幽灵」名下那条视频（aid 写死在 bili-probe.js）
 *   biliD B站私信 → 主人的 B站私信
 *   QQ 空间动态 → 单独走 qzone_stroll.py --post-probe，发完 delete 自删（不在此模块）
 *
 * 为什么不直接发：QQ 消息走 bot 侧 WS，本模块不碰 WS，只接受一个 sender 回调
 *   sender(text) => Promise<{ok:boolean, why?:string}>；调用方（qq.js）把裸发通道传进来。
 *   B站走 HTTP，sender 由 panel 侧注入（用 bili-api.js 的发包函数）。
 *   这样探测逻辑可单测、不依赖连接状态。
 *
 * 算法：从 Lo 起按 step 递增；连续 fail 就二分回退，连续 ok 就往上顶；
 *   取"最后一次 ok 的长度"为上限。封顶 MAX，避免无限发。
 *   发包数控制在 <= 12（主人私信/私密视频会被测试串刷屏，必须克制）。
 * =========================================================================== */
const platLimits = require('./platform-limits');

const MAX = 20000;          // 探测绝对封顶，再大没意义
const MAX_SENDS = 12;       // 最多发 12 次，防刷屏
const SAMPLE = '虚';        // 测试串字符（单字重复，长度=字数）

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 鸭舌帽：sender 返回 {ok, why}。统一成 {ok, why}，吞掉异常（异常=失败）。
 * 2026-11-19 修：原来这里只回布尔，失败原因全丢了 —— 结果是「测试场评论关着（12002）」
 *   和「上限真的缩到 0」在探测里长得一模一样，还会把假 cap 写进上限表。 */
async function send(sender, len) {
  const text = SAMPLE.repeat(len);
  try {
    const r = await sender(text);
    const ok = !!(r && r.ok !== false);
    return { ok, why: ok ? '' : String((r && r.why) || '发不出去').slice(0, 60) };
  } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 60) }; }
}

/* 二分探测。
 * startLo 起点（一般是当前 cap），step 步长。
 * 返回 {ok, cap, sends, trace}。cap = 能发出去的最大长度。 */
async function probe(sender, startLo, step, opt) {
  const o = opt || {};
  const max = Math.max(100, Math.min(MAX, Number(o.max) || MAX));
  const budget = Math.max(3, Math.min(MAX_SENDS, Number(o.maxSends) || MAX_SENDS));
  const gap = Math.max(10, Number(step) || 200);
  const trace = [];
  let sends = 0;
  let lo = Math.max(1, Math.min(max, Number(startLo) || 100));   // 已知能发（起点是现网上限，当成 ok 基线）
  let hi = Math.min(max, lo + gap);
  let bestOk = lo;

  // 先确认基线能发（起点若就发不出去，说明上限已经缩到 lo 以下，往下二分找）
  if (sends < budget) {
    const base = await send(sender, lo);
    sends++;
    trace.push({ len: lo, ok: base.ok, why: base.why || undefined });
    if (!base.ok) {
      // 缩减场景：从 lo 往下折半找最大可发。
      // bestOk 必须从 0 起算 —— 原来是 lo，一条都没发成功也会拿 lo 当答案，
      // 于是「评论功能已关闭」被写成 cap=1000 measured（2026-11-19 踩到）。
      let top = lo, bot = 1, bestOk = 0;
      while (sends < budget && top - bot > 5) {
        const mid = Math.floor((top + bot) / 2);
        const r = await send(sender, mid);
        sends++;
        trace.push({ len: mid, ok: r.ok, why: r.why || undefined });
        if (r.ok) { bestOk = mid; bot = mid + 1; } else { top = mid - 1; }
        await sleep(120);
      }
      if (!bestOk) {
        return {
          ok: false,
          error: '起点 ' + lo + ' 字就发不出去，往下二分也没一条成功（' + (base.why || '原因不明')
            + '）—— 没测到上限，上限表不动。',
          sends, trace,
        };
      }
      return { ok: true, cap: bestOk, sends, trace, shrunk: true };
    }
    bestOk = lo;
  }

  // 增加场景：往上顶到失败，再在 (lastOk, firstFail] 之间二分
  let lastOk = lo, firstFail = 0;
  while (sends < budget && hi <= max) {
    if (hi === lastOk) break;          // 已经顶到 max（hi 被 min 夹住），再发就是同一个长度空转
    const r = await send(sender, hi);
    sends++;
    trace.push({ len: hi, ok: r.ok, why: r.why || undefined });
    if (r.ok) { lastOk = hi; bestOk = hi; hi = Math.min(max, hi + gap); }
    else { firstFail = hi; break; }
    await sleep(120);
  }
  if (firstFail > 0 && sends < budget) {
    let a = lastOk, b = firstFail - 1;
    while (sends < budget && b - a > 5) {
      const mid = Math.floor((a + b) / 2);
      const r = await send(sender, mid);
      sends++;
      trace.push({ len: mid, ok: r.ok, why: r.why || undefined });
      if (r.ok) { bestOk = mid; a = mid + 1; } else { b = mid - 1; }
      await sleep(120);
    }
  }
  return { ok: true, cap: bestOk, sends, trace, shrunk: false };
}

/* 跑完写回上限表。key 必须是 qq / biliC / biliD，否则不写。 */
function commit(key, result) {
  if (!platLimits.validKey(key) || !result || !result.ok || !(result.cap > 0)) {
    return { ok: false, error: '探测没出结果' };
  }
  return platLimits.setCap(key, result.cap, true);
}

module.exports = { probe, commit, MAX, MAX_SENDS, SAMPLE, _send: send };
