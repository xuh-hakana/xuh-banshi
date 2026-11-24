/* ===========================================================================
 * bili-api.js — B站「发包 / 收图」工具（2026-11-19 主人令：删掉失效的 B站连接器）
 *
 * 主人 2026-11-19 06:32 原话：「xuhbot 没有B站连接器，如果有那就是失效旧代码」。
 * 查证属实：connectors/bili.js（直播）、bili-comment.js（评论区召唤/回评）、
 *   bili-dm.js（私信）三条回复链路从来没成功过一次 ——
 *   data/bili-dm.json state=「已关闭」replyCount=0，data/bili-mention.json
 *   lastError=「B站接口返回 -101：账号未登录」，因为读的 ../app/bili-config.json
 *   是 2026-10-30 的过期快照。
 *   B站的回复本来就由 AstrBot 的 astrbot_plugin_bilibili_ai_bot 负责（它读的是
 *   xuhchatrule/persona/ 那份人设），xuhbot 不该再插一条 LLM 链路去抢着回。
 * 所以三个连接器整个删掉，只把**还活着、且不需要模型**的两件事搬到这里：
 *   ① 测字数上限（bili-probe.js / auto-reprobe.js / 面板按钮）要真发包；
 *   ② 面板「B站评论区收图」要真拉评论 + 存图。
 *
 * 登录态唯一来源：bili-space.creds()（AstrBot 插件那份活 cookie → 旧快照兜底）。
 *   以前每个连接器各写一份 cookieStr() + 各读一份旧快照，四处不同步；
 *   现在只走 bili-space 一处，插件 COOKIE_AUTO_REFRESH 刷新后这里自动跟着新。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const core = require('./core');
const platLimits = require('./platform-limits');
const biliSpace = require('./bili-space');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
// 收图闸门**只有一个**：qq.collectStickerBuf 里的「已收图总量 50GB 封顶」
// （2026-11-17 主人定：取消各文件夹 500 张上限，改总量 50GB）。
// 这里不再自己数张数 —— 2026-11-19 07:0x 之前那版抄了张过期的 500 张上限，
// 会在 QQ 侧还照收的时候先把 B站这条路掐死（少用/ 已 534 张），典型的双闸门打架。
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 登录态（唯一来源） ---------- */
function cookieStr() { return String((biliSpace.creds() || {}).cookie || ''); }
function cookieStatus() {
  const c = biliSpace.creds() || {};
  return { ok: !!c.cookie, from: c.from || '', mid: c.mid || '' };
}
function csrfVal() { return ((/bili_jct=([0-9a-zA-Z]+)/.exec(cookieStr()) || [])[1] || ''); }

function hdr(extra, referer) {
  const h = { 'User-Agent': UA, Referer: referer || 'https://www.bilibili.com/' };
  const ck = cookieStr();
  if (ck) h.Cookie = ck;
  return Object.assign(h, extra || {});
}

/* 调 B站接口：带 UA / Referer / 登录 Cookie，不带就会被 412 挡回来 */
async function api(url, referer) {
  const r = await fetch(url, { headers: hdr(null, referer) });
  const j = await r.json();
  if (j.code !== 0) throw new Error('B站接口返回 ' + j.code + '：' + (j.message || j.msg || ''));
  return j.data;
}

/* ---------- 认视频 / 取 aid ---------- */
function parseTarget(input) {
  if (input && typeof input === 'object') {
    if (input.bvid) return { bvid: String(input.bvid) };
    if (input.aid) return { aid: Number(input.aid) };
  }
  const s = String(input || '').trim();
  const bv = (s.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  const av = (s.match(/av(\d+)/i) || [])[1] || (s.match(/^(\d{5,})$/) || [])[1];
  if (bv) return { bvid: bv };
  if (av) return { aid: Number(av) };
  throw new Error('看不出是哪个视频 —— 贴 BV 号、av 号或视频链接都行');
}

async function fetchAid(bvid) {
  const d = await api('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
  return Number((d && d.aid) || 0);
}

async function resolveAid(t) {
  if (t.aid) return t.aid;
  const aid = await fetchAid(t.bvid);
  if (!aid) throw new Error('取不到这个视频的 aid');
  return aid;
}

/* ---------- 发评论（测上限用） ----------
 * 不裁字数：limit-probe 靠「发多长会失败」反推平台上限，一旦在这里 slice
 * 就等于把探测结果锁死在裁剪长度上（旧代码 slice(0,60)，所以 biliC 永远测不到 1000）。
 * opt.max 只在调用方明确要「按现网上限发」时才传。 */
async function commentVideo(aid, message, opt) {
  const o = opt || {};
  const ct = csrfVal();
  if (!ct) return { ok: false, why: '没有 B站登录态（bili_jct 缺失），评论不了' };
  let text = String(message || '').trim();
  if (!text) return { ok: false, why: '没内容，不评论' };
  if (o.max > 0 && text.length > o.max) text = text.slice(0, o.max);
  try {
    // opt.root / opt.parent：回楼中楼时传（root=我方一级评论的 rpid，parent=对方那层的 rpid）。
    // 不传就是发一级评论（root=parent=0）。2026-11-22 加，用于「被回复后回一句」。
    const body = new URLSearchParams({
      oid: String(aid), type: '1',
      root: String(o.root || 0), parent: String(o.parent || 0),
      message: text,
      plat: '1',
    });
    // 真正的 @ 需要 at_name_to_mid（{"昵称": mid} 的 JSON 串），只写文本「@昵称」不会通知对方。
    // 来源：dsh-bili-eyes 的 bili_comment(mention) / BiliSail 评论协议文档 / OpenCLI clis/bilibili/comment.js。
    // 2026-11-22 加：主人问「确认没有 at 段就搜 dsh 侧插件」——搜到了，就是这个字段。
    const at = (o.at && typeof o.at === 'object') ? o.at : null;
    if (at && Object.keys(at).length) {
      const map = {};
      for (const [name, mid] of Object.entries(at)) {
        if (!name || !mid) continue;
        map[String(name).trim()] = String(mid).replace(/\D/g, '');
      }
      if (Object.keys(map).length) body.set('at_name_to_mid', JSON.stringify(map));
    }
    const r = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: hdr({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'https://www.bilibili.com/video/av' + aid + '/'),
      body: body.toString() + '&csrf=' + encodeURIComponent(ct) + '&csrf_token=' + encodeURIComponent(ct),
    });
    const j = await r.json();
    if (j.code === 0) return { ok: true, rpid: Number((j.data && j.data.rpid) || 0) };
    return { ok: false, why: String(j.code) + ' ' + String(j.message || j.msg || '') };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 80) }; }
}

/* ---------- 发私信（测上限用） ----------
 * 同样不裁：旧代码按 platform-limits 的 cap 裁，探测永远顶不破现网值，
 * 平台把上限**调大**了就永远测不出来（正是「测上限不生效」的一半原因）。
 * 2026-11-19 实测：只发 receiver 那几个字段，B站恒回 -400「请求错误」；
 *   必须同时带 msg[sender_uid] + msg[dev_id] + msg[timestamp] 才 code=0。
 *   dev_id 是客户端自报的设备号，固定一个常量即可（同一台机器永远同一个）。 */
const DEV_ID = '3F8B1D2A-4C6E-4B1F-9A3D-0C1E5F7A9B21';
async function sendDm(uid, message, opt) {
  const o = opt || {};
  const ct = csrfVal();
  const me = String((biliSpace.creds() || {}).mid || '');
  if (!ct) return { ok: false, why: '没有 B站登录态（bili_jct 缺失），发不了私信' };
  if (!me) return { ok: false, why: '登录态里没有 DedeUserID，发不了私信' };
  let text = String(message || '').trim();
  if (!text) return { ok: false, why: '没内容，不发' };
  if (o.max > 0 && text.length > o.max) text = text.slice(0, o.max);
  try {
    const body = new URLSearchParams({
      'msg[sender_uid]': me,
      'msg[receiver_id]': String(uid),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[dev_id]': DEV_ID,
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[content]': JSON.stringify({ content: text }),
      csrf: ct, csrf_token: ct,
    });
    const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: hdr({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'https://message.bilibili.com/'),
      body: body.toString(),
    });
    // 先读原文：msg_key 是 19 位数字，JSON.parse 会丢精度（…8982265 → …8982000），
    // 那样撤回就撤不掉。必须从原始文本正则取精确字符串。
    const raw = await r.text();
    let j = {};
    try { j = JSON.parse(raw); } catch { return { ok: false, why: '响应不是 JSON：' + raw.slice(0, 60) }; }
    if (j.code === 0) {
      const mk = (raw.match(/"msg_key":(\d+)/) || [])[1] || '';
      return { ok: true, msgKey: mk };
    }
    return { ok: false, why: String(j.code) + ' ' + String(j.message || j.msg || '') };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 80) }; }
}

/* 撤回自己刚发的私信（测上限用完就撤，别把测试串留在主人的会话里）。
 * B站没有独立撤回接口：要再发一条 msg_type=5 的私信，content = 目标消息的 msg_key。
 * 只能撤自己发的、同一会话、且发送后 120 秒内 —— 超时回 21041「消息已超期」，
 * 所以调用方必须发完立刻调，不能攒着。 */
async function recallDm(uid, msgKey) {
  const ct = csrfVal();
  const me = String((biliSpace.creds() || {}).mid || '');
  if (!ct || !me) return { ok: false, why: '没有 B站登录态，撤不了' };
  if (!msgKey) return { ok: false, why: '没有 msg_key，撤不了' };
  try {
    const body = new URLSearchParams({
      'msg[sender_uid]': me,
      'msg[receiver_id]': String(uid),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '5',
      'msg[msg_status]': '0',
      'msg[dev_id]': DEV_ID,
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[content]': String(msgKey),
      csrf: ct, csrf_token: ct,
    });
    const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: hdr({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'https://message.bilibili.com/'),
      body: body.toString(),
    });
    const j = await r.json();
    if (j.code === 0) return { ok: true };
    return { ok: false, why: String(j.code) + ' ' + String(j.message || j.msg || '') };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 80) }; }
}

/* ---------- 删评论（测完自删，同「空间测上限发完自删」的做法） ---------- */
async function deleteComment(aid, rpid) {
  const ct = csrfVal();
  if (!ct || !rpid) return { ok: false, why: '没有 bili_jct 或 rpid' };
  try {
    const body = new URLSearchParams({ oid: String(aid), type: '1', rpid: String(rpid), csrf: ct, csrf_token: ct });
    const r = await fetch('https://api.bilibili.com/x/v2/reply/del', {
      method: 'POST',
      headers: hdr({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'https://www.bilibili.com/video/av' + aid + '/'),
      body: body.toString(),
    });
    const j = await r.json();
    if (j.code === 0) return { ok: true };
    return { ok: false, why: String(j.code) + ' ' + String(j.message || j.msg || '') };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 80) }; }
}

/* ---------- 收图：把一个视频评论区里带图的评论收进表情包池 ---------- */
async function collectFromVideo(input, opt) {
  opt = opt || {};
  const qq = require('./connectors/qq');
  const aid = await resolveAid(parseTarget(input));
  const maxPages = Math.min(Math.max(Number(opt.pages) || 2, 1), 10);
  const out = { aid, pages: 0, seen: 0, got: 0, skip: 0, fail: 0, log: [] };
  for (let pn = 1; pn <= maxPages; pn++) {
    let d;
    try {
      d = await api('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&pn=' + pn + '&sort=2&nohot=0');
    } catch (e) {
      out.log.push('第 ' + pn + ' 页拉不下来：' + String(e.message).slice(0, 70));
      break;
    }
    out.pages++;
    const list = (d && d.replies) || [];
    if (!list.length) break;
    for (const rp of list) {
      const pics = (rp && rp.content && rp.content.pictures) || [];
      if (!pics.length) continue;
      // 用评论文字当这张图的描述（比空着好，命名和以后找图都用得上）
      const text = String((rp.content && rp.content.message) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      for (const pic of pics) {
        out.seen++;
        const url = String(pic.img_src || pic.url || '');
        if (!/^https?:\/\//i.test(url)) { out.skip++; continue; }
        await sleep(400);                        // 别把 B站惹毛（同 IP 太快会 412）
        let got = null;
        try { got = await core.getBinary(url); } catch { out.fail++; continue; }
        if (!got || !got.buf) { out.fail++; continue; }
        const r = await qq._collectStickerBuf(got, {
          pool: 'normal',
          desc: text,
          sourceTag: 'B站评论区（' + aid + '）',
        });
        if (r.ok) { out.got++; out.log.push('收了 ' + r.rel + (text ? '（评论：' + text + '）' : '')); }
        else { out.skip++; out.log.push('跳过：' + (r.why || '')); }
      }
    }
    await sleep(600);
  }
  return out;
}

module.exports = {
  cookieStr, cookieStatus, csrfVal, hdr, api,
  parseTarget, fetchAid, resolveAid,
  commentVideo, sendDm, recallDm, deleteComment, collectFromVideo,
};
