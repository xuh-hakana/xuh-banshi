'use strict';
/*
 * bili.js —— B 站视频投稿（用 biliup 这个成熟轮子，不自己重写 upos 协议）
 *
 * 登录态唯一来源：src/bili-space.creds()（和 bili-api.js 同一份活 cookie）。
 * 这里只做三件事：
 *   1. 把活 cookie 转成 biliup 认的 cookies.json（写进 data/vendor/biliup/runtime，权限 600）
 *   2. 调 biliup upload 投稿（标题/简介/标签/分区/封面/定时）
 *   3. 用完立刻删 cookies.json（不落盘明文、不留残骸）
 *
 * 为什么用 biliup：投稿要走 preupload → 分片 PUT → /x/vu/web/add/v3，自己写容易在风控上栽；
 * biliup 是 Rust 写的成熟投稿器，支持 cookie 登录、封面、定时、多分 P。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'data', 'vendor', 'biliup', 'biliupR-v1.3.5-aarch64-macos', 'biliup');
const RUNTIME = path.join(ROOT, 'data', 'vendor', 'biliup', 'runtime');

function binPath() {
  if (fs.existsSync(BIN)) return BIN;
  return '';
}

/** 读活 cookie（不打印） */
function cookieString() {
  try {
    const s = require('../bili-space');
    const c = (s.creds && s.creds()) || {};
    return String(c.cookie || '');
  } catch { return ''; }
}

function parseCookie(str) {
  const out = [];
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

/** 写 biliup 认的 cookies.json，返回路径；用完必须 cleanup() */
function writeCookieFile() {
  const ck = cookieString();
  const cookies = parseCookie(ck);
  if (!cookies.length) throw new Error('没有 B 站登录态（bili-space.creds() 里没有 cookie）');
  if (!cookies.some((c) => c.name === 'SESSDATA')) throw new Error('登录态里缺 SESSDATA');
  if (!cookies.some((c) => c.name === 'bili_jct')) throw new Error('登录态里缺 bili_jct（csrf）');
  fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  const p = path.join(RUNTIME, 'cookies.json');
  const mid = (cookies.find((c) => c.name === 'DedeUserID') || {}).value || '';
  const payload = {
    cookie_info: { cookies, domains: ['.bilibili.com'] },
    sso: [],
    token_info: { access_token: '', expires_in: 0, mid: Number(mid) || 0, refresh_token: '' },
    platform: 'BiliTV',
  };
  fs.writeFileSync(p, JSON.stringify(payload), { mode: 0o600 });
  return p;
}

function cleanup(cookieFile) {
  try { if (cookieFile && fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile); } catch { /* ignore */ }
}

/** 只验证登录态：biliup list 只读，不发稿 */
function verify() {
  const bin = binPath();
  if (!bin) return { ok: false, why: '没装 biliup（data/vendor/biliup/...）' };
  let cf = '';
  try { cf = writeCookieFile(); } catch (e) { return { ok: false, why: e.message }; }
  try {
    const r = spawnSync(bin, ['-u', cf, 'list'], { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0 && !/未登录|登录失效|-101|not login/i.test(out);
    return { ok, code: r.status, head: out.split('\n').slice(0, 4).join(' | ').slice(0, 300) };
  } finally { cleanup(cf); }
}

/**
 * 投稿
 * @param {object} o { video, title, desc, tag, tid, cover, dtime, copyright, dryRun, submit }
 */
async function upload(o) {
  const bin = binPath();
  if (!bin) throw new Error('没装 biliup（先跑 node scripts/setup-video.js）');
  const video = String(o.video || '');
  if (!fs.existsSync(video)) throw new Error('成片不存在：' + video);

  const title = String(o.title || '').trim();
  if (!title) throw new Error('缺标题');
  if ([...title].length > 80) throw new Error('标题超过 80 字（现在是 ' + [...title].length + '）');
  const desc = String(o.desc || '');
  if ([...desc].length > 2000) throw new Error('简介超过 2000 字');
  const tags = String(o.tag || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!tags.length) throw new Error('缺标签');
  if (tags.length > 10) throw new Error('标签超过 10 个');
  const tid = String(o.tid || '171');
  if (!/^\d+$/.test(tid)) throw new Error('分区 tid 必须是数字');
  const cover = String(o.cover || '');
  if (cover && !fs.existsSync(cover)) throw new Error('封面不存在：' + cover);

  const args = ['upload', video,
    '--title', title,
    '--desc', desc,
    '--tag', tags.join(','),
    '--tid', tid,
    '--copyright', String(o.copyright || 1)];
  if (cover) args.push('--cover', cover);
  if (o.dtime) args.push('--dtime', String(o.dtime));
  if (o.submit) args.push('--submit', String(o.submit));

  const plan = { video, title, tags, tid, cover: !!cover, dtime: o.dtime || null, args };
  if (o.dryRun) return { ok: true, dryRun: true, plan };

  let cf = '';
  try {
    cf = writeCookieFile();
    const out = await new Promise((resolve) => {
      const p = spawn(bin, ['-u', cf, ...args], { encoding: 'utf8' });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 30 * 60 * 1000);
      p.on('close', (code) => { clearTimeout(t); resolve({ code, so, se }); });
    });
    const all = out.so + out.se;
    const bv = (/BV[0-9A-Za-z]{10}/.exec(all) || [])[0] || '';
    const ok = out.code === 0 && !/错误|失败|error/i.test(out.se);
    return { ok, code: out.code, bvid: bv, head: all.split('\n').slice(-12).join('\n').slice(-1200) };
  } finally { cleanup(cf); }
}

const TID = {
  动画: 1, 番剧: 13, 国创: 167, 音乐: 3, 舞蹈: 129, 游戏: 4, 知识: 36,
  科技: 188, 运动: 234, 汽车: 223, 生活: 160, 美食: 211, 动物圈: 217,
  鬼畜: 119, 时尚: 155, 资讯: 202, 娱乐: 5, 影视: 181, 纪录片: 177,
};

module.exports = { binPath, cookieString, verify, upload, TID };
