'use strict';
/*
 * net.js —— 带代理的 HTTP 请求（只用 Node 自带模块，不装第三方包）
 *
 * 为什么需要它：
 *   境外官方 API（维基百科、Wikidata）免 Key、免钱，但这台机器直连 10 秒超时。
 *   主人 2026-11-07 明确：红线是「不许绕过官方网站 API 去爬网页」，代理不是红线。
 *   所以这里给「官方 API」一条能出网的通道，代理只是通路，不改变数据来源的合法性。
 *
 * 红线边界（写死，不靠自觉）：
 *   本文件只做传输，不抓网页、不解析 HTML、不带浏览器 UA 去伪装。
 *   只允许调「官方 JSON API」，域名白名单在 knowledge.js 里。
 *
 * 代理从哪来（按顺序挑，找到能用的第一个）：
 *   1. 配置 src/config/llm.json 的 proxy.url（主人手填，优先）
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   3. 本机常见代理端口自动探测（Clash 7890、V2ray 1087、SS 1080 等），必须真能建立 CONNECT 隧道才算数
 *   proxy.auto === false 时只认第 1、2 步，不自动探测。
 *   探测结果缓存 10 分钟。
 *
 * 2026-11-07 踩过的三个坑（别再踩）：
 *   ① http.request 的 `agent: false` 会新建默认 Agent，传进去的 createConnection 被忽略 → 隧道没接上，请求挂死。
 *   ② 用 https.Agent 覆写 createConnection 能接上，但发出去的请求仍被 Wikimedia 判成爬虫，稳定 403
 *      （同样 UA、同样代理，curl 与手写原始 HTTP 都 200）。所以这里不走 http.request，直接手写 HTTP/1.1。
 *   ③ 隧道建不起来时请求会一直挂着 → 必须有外部截止时间（withDeadline）。
 */
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');

const PROBE_TTL = 10 * 60 * 1000;
const COMMON_PORTS = [7890, 7891, 7897, 1087, 1080, 6152, 8889, 8118, 8080];
const TEST_HOST = 'zh.wikipedia.org';   // 用真实目标验隧道，避免把「随便一个本地端口」当代理
const UA = 'xuhuan-bot/1.0 (personal qq companion bot)';

let _probe = { at: 0, proxy: '', tried: false };

function tcpAlive(host, port, ms) {
  return new Promise(res => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = v => { if (done) return; done = true; s.destroy(); res(v); };
    s.setTimeout(ms || 400);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

/* 在代理上开一条到 host:port 的隧道（HTTP CONNECT）。成功返回裸 socket。 */
function connectTunnel(proxyUrl, host, port, ms) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxyUrl); } catch (e) { return reject(new Error('代理地址不合法：' + proxyUrl)); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('只支持 http:// 代理（SOCKS 请让代理软件开混合端口）'));
    const pPort = Number(u.port) || 8080;
    const sock = net.connect({ host: u.hostname, port: pPort });
    let done = false;
    const fail = e => { if (done) return; done = true; sock.destroy(); reject(e); };
    sock.setTimeout(ms || 6000);
    sock.once('timeout', () => fail(new Error('代理连接超时')));
    sock.once('error', e => fail(e));
    sock.once('connect', () => {
      let buf = '';
      const onData = d => {
        buf += d.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > 4096) fail(new Error('代理返回异常')); return; }
        sock.removeListener('data', onData);
        sock.setTimeout(0);
        const line = buf.slice(0, buf.indexOf('\r\n'));
        if (!/^HTTP\/1\.[01]\s+2\d\d/.test(line)) return fail(new Error('代理拒绝转发：' + line));
        if (done) return;
        done = true;
        resolve(sock);
      };
      sock.on('data', onData);
      const auth = u.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(
            decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64') + '\r\n'
        : '';
      sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n'
        + 'Host: ' + host + ':' + port + '\r\n'
        + auth
        + 'Proxy-Connection: keep-alive\r\n\r\n');
    });
  });
}

function tlsWrap(sock, host, ms) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: sock, servername: host }, () => { s.setTimeout(0); resolve(s); });
    s.setTimeout(ms || 8000, () => s.destroy(new Error('TLS 握手超时')));
    s.once('error', reject);
  });
}

function normalizeProxy(s) {
  let v = String(s || '').trim();
  if (!v) return '';
  v = v.replace(/^socks5?h?:\/\//i, 'http://');
  if (!/^[a-z]+:\/\//i.test(v)) v = 'http://' + v;
  return v;
}

function envProxy() {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = String(process.env[k] || '').trim();
    if (v) return normalizeProxy(v);
  }
  return '';
}

/* 挑一个真能用的代理。并发试所有候选，谁先成功用谁（串行会把启动拖到 5 秒以上）。 */
async function resolveProxy(cfgProxy) {
  const o = cfgProxy || {};
  if (o.enabled === false) return '';
  if (o.url && String(o.url).trim()) return normalizeProxy(o.url);
  const now = Date.now();
  if (_probe.tried && now - _probe.at < PROBE_TTL) return _probe.proxy;
  if (o.auto === false) return '';

  const cands = [];
  const env = envProxy();
  if (env) cands.push(env);
  for (const p of COMMON_PORTS) cands.push('http://127.0.0.1:' + p);

  const tryOne = async c => {
    let u;
    try { u = new URL(c); } catch { return Promise.reject(new Error('skip')); }
    if (!(await tcpAlive(u.hostname, Number(u.port) || 80, 300))) return Promise.reject(new Error('skip'));
    const sock = await connectTunnel(c, TEST_HOST, 443, 3500);
    sock.destroy();
    return normalizeProxy(c);
  };

  let found = '';
  try {
    found = await Promise.any(cands.map(tryOne));
  } catch { found = ''; }

  _probe = { at: Date.now(), proxy: found, tried: true };
  console.log(found ? '[net] 代理可用：' + found : '[net] 没找到可用代理（境外官方 API 会走直连，大概率超时）');
  return found;
}

/* 给任意 Promise 加硬截止时间：隧道挂死时必须能自己掐断，不能拖死一条回复。 */
function withDeadline(p, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || '请求') + '超时（' + ms + 'ms）')), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const j = buf.indexOf('\r\n', i);
    if (j < 0) break;
    const size = parseInt(buf.slice(i, j).toString('latin1').trim(), 16);
    if (!size || isNaN(size)) break;
    const start = j + 2;
    out.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

/* GET 一个地址，返回文本。opt: { timeout, proxy, ua, header }
 * proxy 传 '' 表示直连；传具体地址表示走它。header 是额外请求头（字符串，每行一个，含 \r\n）。 */
async function getText(url, opt) {
  const o = opt || {};
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const timeout = o.timeout || 8000;

  return withDeadline((async () => {
    let sock = o.proxy
      ? await connectTunnel(o.proxy, u.hostname, port, Math.min(timeout, 6000))
      : net.connect({ host: u.hostname, port });
    if (isHttps) sock = await tlsWrap(sock, u.hostname, timeout);

    // 请求头顺序固定手写：跟实测能过 robot policy 的形态一致，别随手加头
    const lines = [
      'GET ' + (u.pathname + u.search) + ' HTTP/1.1',
      'Host: ' + u.hostname,
      'User-Agent: ' + (o.ua || UA),
      'Accept: */*',
      'Accept-Encoding: gzip',
      'Connection: close',
    ];
    if (o.header) lines.push(String(o.header).replace(/\r?\n$/, ''));
    const req = lines.join('\r\n') + '\r\n\r\n';

    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch {}
        fn(v);
      };
      sock.setTimeout(timeout, () => done(reject, new Error('无响应 ' + timeout + 'ms')));
      sock.on('data', d => {
        chunks.push(d);
        size += d.length;
        if (size > 3 * 1024 * 1024) done(reject, new Error('响应过大'));
      });
      sock.on('error', e => done(reject, e));
      sock.on('end', () => {
        const buf = Buffer.concat(chunks);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return done(reject, new Error('响应格式异常'));
        const head = buf.slice(0, sep).toString('latin1');
        let body = buf.slice(sep + 4);
        const status = Number((head.match(/^HTTP\/1\.[01]\s+(\d+)/) || [])[1] || 0);
        const headers = {};
        for (const line of head.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (/chunked/i.test(headers['transfer-encoding'] || '')) {
          try { body = dechunk(body); } catch {}
        }
        try {
          const enc = String(headers['content-encoding'] || '').toLowerCase();
          if (enc.includes('gzip')) body = zlib.gunzipSync(body);
          else if (enc.includes('deflate')) body = zlib.inflateSync(body);
          else if (enc.includes('br')) body = zlib.brotliDecompressSync(body);
        } catch (e) { return done(reject, new Error('解压失败：' + e.message)); }
        const text = body.toString('utf8');
        if (status < 200 || status >= 300) {
          return done(reject, new Error('HTTP ' + status + '：' + text.replace(/\s+/g, ' ').slice(0, 160)));
        }
        done(resolve, text);
      });
      sock.write(req);
    });
  })(), timeout + 2000, 'GET ' + u.hostname);
}

async function getJson(url, opt) {
  const txt = await getText(url, opt);
  return JSON.parse(txt);
}

/* 当前用的哪个代理（给面板/自检显示用）。不触发探测。 */
function current() { return _probe.proxy || ''; }

module.exports = { getText, getJson, resolveProxy, connectTunnel, normalizeProxy, withDeadline, current, COMMON_PORTS, UA };
