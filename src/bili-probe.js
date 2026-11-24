/* ===========================================================================
 * bili-probe.js — B站两条字数上限探测的共用实现（2026-11-17 主人令）
 *
 * 这是干什么的：B站评论 / B站私信的「测上限」逻辑放这一处。
 *   客户端手动点按钮（panel.js）和版本变化自动重测（auto-reprobe.js）都调
 *   probe(which)，不各写一份 —— 铁律「不能有双份」。
 *
 * 测试场（主人 2026-11-19 定「自己的号能评，别乱加没用的功能」＋「其他多余功能都不需要」）：
 *   biliC 评论 → 小号「虚幻世界的电子幽灵」名下 BV1Xess6pEzP（aid 写死在下面）。
 *                主人原话「用这个视频吧，以后都在这测」，所以「按主人号视频列表逐个预检、
 *                哪条能评用哪条」那套多级兜底全删了 —— 一条视频、评不了就如实报错。
 *   biliD 私信 → 主人 B站 UID（features.json → bilibiliComment.mention.masterMids[0]）
 *
 * 真发包动的是你的登录态。登录态现在统一取 AstrBot 插件那份活 cookie
 *   （bili-api.js → bili-space.creds()，插件 COOKIE_AUTO_REFRESH 会自己续）；
 *   取不到就如实返回 error，不假装测到。
 * =========================================================================== */
const limitProbe = require('./limit-probe');
const platLimits = require('./platform-limits');
const configStore = require('./config');
const biliApi = require('./bili-api');     // 发包 + 登录态的唯一来源（2026-11-19）

/* 评论测试场：BV1Xess6pEzP（小号「虚幻世界的电子幽灵」名下的视频，state=0 公开可评）。
 * 2026-11-19 主人指定：「用这个视频吧，以后都在这测 BV1Xess6pEzP」—— 改视频就改这一个数。 */
const COMMENT_SITE_AID = 117640009879831;

function masterBiliUid() {
  try {
    const c = configStore.load();
    const bc = c.bilibiliComment || {};
    const mids = (bc.mention && bc.mention.masterMids) || bc.masterMids || [];
    return String(mids[0] || '');
  } catch { return ''; }
}

/* 删探测评论。实测 2026-11-19：发完立刻删必失败（B站那边还没落库/轻微限频），
 * 隔 1 秒以上再删才成功；所以先等 1.2 秒，失败再等 1.5 秒重试一次。
 * 留在视频下面的测试串很丢人，宁可慢一点。 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wipe(aid, rpid) {
  if (!rpid) return true;
  const waits = [1200, 1500];
  for (const w of waits) {
    await sleep(w);
    const d = await biliApi.deleteComment(aid, rpid);
    if (d.ok) return true;
  }
  return false;
}

/* 2026-11-19：发包函数搬到 bili-api.js（三个失效连接器已删）。
 * 登录态由 bili-api → bili-space.creds() 统一取 AstrBot 插件那份活 cookie，
 * 不再读 ../app/bili-config.json 的过期快照（那是 -101 的根源）。 */
async function buildSender(which) {
  if (which === 'biliC') {
    const aid = COMMENT_SITE_AID;
    return async (text) => {
      const r = await biliApi.commentVideo(aid, text);
      // 发完自删：探测串不留在视频下面（B站删评论要 rpid）
      if (r.ok && r.rpid) { try { await wipe(aid, r.rpid); } catch {} }
      return r;
    };
  }
  if (which === 'biliD') {
    const uid = masterBiliUid();
    if (!uid) throw new Error('没找到主人 B站 UID（features.json → bilibiliComment.mention.masterMids）');
    return async (text) => {
      const r = await biliApi.sendDm(uid, text);
      // 发成功立刻撤回：B站撤回窗口只有 120 秒，攒着就撤不掉了（2026-11-19 踩过，
      // 留了 6 条「虚虚虚…」在主人会话里永久撤不回）。撤完才算这一探测结束。
      if (r.ok && r.msgKey) { try { await biliApi.recallDm(uid, r.msgKey); } catch {} }
      return r;
    };
  }
  throw new Error('只能测 biliC(评论) 或 biliD(私信)');
}

/* 跑一条探测并写回上限表。返回 {ok, cap?, sends?, shrunk?, trace?, write?, error?} */
async function probe(which) {
  if (which !== 'biliC' && which !== 'biliD') return { ok: false, error: '只能测 biliC 或 biliD' };
  try {
    const sender = await buildSender(which);
    const cur = platLimits.capOf(which) || (which === 'biliC' ? 1000 : 2000);
    // max 必须大于现网上限，否则「顶到 max 就停」等于永远测不出平台调大（旧 bug 的同款）。
    // biliC 现网真上限 1000（2026-11-19 实测 1100 字回 12025「删减至1000字或以下」），留到 2000 才有余量。
    const r = await limitProbe.probe(sender, cur, which === 'biliC' ? 100 : 300, { max: which === 'biliC' ? 2000 : 10000 });
    if (!r.ok) return { ok: false, error: r.error || '探测没出结果' };
    const w = limitProbe.commit(which, r);
    return { ok: true, cap: r.cap, sends: r.sends, shrunk: r.shrunk, trace: r.trace, write: w };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

// 只给外部 probe：buildSender/fetchAid/masterBiliUid 都是内部用的，没人从外面调，不再导出。
module.exports = { probe };
