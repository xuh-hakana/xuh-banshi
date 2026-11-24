/* ===========================================================================
 * diary-publish.js — 把「主人点头通过的日记」发到 QQ空间 和 B站动态
 * （2026-11-18 主人令：「然后此通过的日记同步发QQ空间、b站动态」）
 *
 * 【为什么单独一份】
 *   发到两个平台的动作要能单独测、单独关，不能塞进 core 的日记生成里。
 *   core 只管写，这里只管发。
 *
 * 【两个平台的能力来源，别搞混】
 *   · QQ空间：走 `connectors/qq.js` 的 `qzonePostText()`，底下是 `scripts/qzone_stroll.py --post`
 *     （这是项目里原本就有的发说说能力，不新写）。
 *   · B站动态：走 B站自己的 `POST /x/dynamic/feed/create/dyn`（`scene:1` 纯文本）。
 *     **这个能力本项目原来没有** —— 原来只有弹幕/评论/私信。档案写进 selfpost 好回看。
 *
 * 【字数】
 *   2026-11-18 主人查到的口径：「空间动态最多1万到20万字」（T2，已记进 platform-limits 的
 *   qzone.note，cap 取保守下限 10000）。我原来填的 60 是我自己拍的，已删。
 *   所以两个平台**都发日记全文**，不压缩：日记 500 字远在空间上限之内。
 *   真被平台拒收就照它的原话报错，不假装成功、不偷偷截断。
 * =========================================================================== */
const fs = require('fs');
const path = require('path');
const selfpost = require('./selfpost');

const BILI_CONF = path.resolve(__dirname, '../../app/bili-config.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* B站登录态：唯一正源 = bili-space.creds()（AstrBot 插件那份活 cookie）。
 * 2026-11-19 修：原来读 app/bili-config.json（过期快照，早不存在），postBili 从来没发成功过。
 * 现在跟发动态/拉评论/测字数共用同一份凭证，插件刷新后自动跟着新。csrf 也由 creds() 出。 */
function biliCred() {
  const bili = require('./bili-space');
  const c = bili.creds();
  return { cookie: c.cookie || '', csrf: String(c.csrf || ''), uid: String(c.mid || '') };
}

/* 发一条纯文本动态。返回 { ok, dynId, error } */
async function postBili(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '没内容' };
  let cred;
  try { cred = biliCred(); } catch (e) { return { ok: false, error: '读不到B站登录态：' + e.message }; }
  if (!cred.csrf) return { ok: false, error: 'B站登录态里没有 bili_jct（发动态要它做 csrf）' };
  const url = 'https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=' + encodeURIComponent(cred.csrf);
  const body = {
    dyn_req: {
      scene: 1,                                   // 1 = 纯文本（2 带图 / 4 转发）
      content: { contents: [{ raw_text: t }] },
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
  };
  const t0 = Date.now();
  let j = null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cred.cookie,
        'User-Agent': UA,
        'Referer': 'https://t.bilibili.com/',
        'Origin': 'https://t.bilibili.com',
      },
      body: JSON.stringify(body),
    });
    j = await r.json();
  } catch (e) {
    return { ok: false, error: '请求失败：' + e.message, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (j && j.code === 0) {
    const d = j.data || {};
    return { ok: true, dynId: String(d.dyn_id_str || d.dynamic_id_str || d.dyn_id || ''), ms };
  }
  // 常见码照原意翻成人话，别的原样带号码回去（不猜）
  const code = j && j.code;
  const map = {
    '-101': '账号未登录（SESSDATA 失效）',
    '-111': 'csrf 校验失败（bili_jct 对不上）',
    '-400': '请求格式不对',
    '4126021': '账号没绑手机号，B站不让发动态',
    '4101001': '发布参数错误（多半是正文太长或含非法内容）',
  };
  return {
    ok: false,
    error: (map[String(code)] || ('B站返回 code ' + code + '：' + ((j && j.message) || ''))),
    code, ms,
  };
}

/* 发一条空间说说。走 qq 连接器（惰性 require —— qq.js 那头也会 require 本模块，不能顶层循环引）。 */
async function postQzone(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '没内容' };
  let qq;
  try { qq = require('./connectors/qq'); } catch (e) { return { ok: false, error: '加载 qq 连接器失败：' + e.message }; }
  if (typeof qq.qzonePostText !== 'function') return { ok: false, error: 'qq 连接器没有 qzonePostText（没接上发说说）' };
  try {
    const r = await qq.qzonePostText(t);
    return r || { ok: false, error: '没返回' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* 一条日记 → 两个平台都发。返回逐平台结果，一个失败不影响另一个。
 * 两个平台都发全文（空间上限 1 万~20 万字，500 字日记放得下），不压缩。 */
async function publishDiary({ day, title, text }) {
  const out = { qzone: null, bili: null };
  const head = `（${day || ''}${title ? ' · ' + title : ''}）`;

  try {
    const r = await postQzone(text);
    out.qzone = r;
    selfpost.add({
      plat: 'qzone', kind: 'post', text: String(text || ''), tid: String((r && r.tid) || ''),
      ok: !!r.ok, err: r.ok ? '' : String(r.error || ''),
      note: '日记同步上空间' + head, from: 'diary-publish',
      prompt: null, think: '', model: '',
    });
  } catch (e) {
    out.qzone = { ok: false, error: e.message };
  }

  // B站：日记单独发，不进搬屎的 10 条额度队列（主人 2026-11-24 令）；和 diary-flow 运行时路径一致。
  try {
    const r = await postBili(text);
    out.bili = r;
    selfpost.add({
      plat: 'bili', kind: 'dynamic', text: String(text || ''), tid: String((r && r.dynId) || ''),
      ok: !!r.ok, err: r.ok ? '' : String(r.error || ''),
      note: '日记单独发B站动态' + head,
      from: 'diary-publish', prompt: null, think: '', model: '',
    });
  } catch (e) {
    out.bili = { ok: false, error: e.message };
  }

  return out;
}

module.exports = { postBili, postQzone, publishDiary, BILI_CONF };
