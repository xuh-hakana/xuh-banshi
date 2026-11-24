'use strict';
/* scripts/shot-panel.js — 给 README 截一张客户端外壳的真界面图（不需要 GUI、不用 Electron 打包）。
 *
 * 做法：起一个只监听 127.0.0.1 的小服务（静态文件 + /api 直接转给面板那份 handler），
 * 再用本机 Chrome headless + DevTools 协议加载 client/renderer/index.html#<页面>，
 * 等页面把图渲染出来再抓图（不用 --virtual-time-budget，那个会被待加载的图卡住）。
 * 图里的数据是这台机器上真实的库，不造假图。
 *
 * 用法：node scripts/shot-panel.js [输出路径] [页面=sticker]
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "截图", "面板.png"));
const PAGE = process.argv[3] || "sticker";
const PORT = Number(process.env.SHOT_PORT || 8897);
const MIN_BYTES = Number(process.env.SHOT_MIN_BYTES || 60000);
const SHOT_W = Number(process.env.SHOT_WIDTH || 1440);
const SHOT_H = Number(process.env.SHOT_HEIGHT || 900);
/* SHOT_FIXTURE=1：把 /api/xuhpoop、/api/xuhcfg 换成一份造出来的多群数据，
 * 只为看「有数据时长什么样/会不会溢出」；默认仍然读这台机器的真库。
 * PAGE=private：渲染私有客户端那份 app/renderer/poop-panel.js。 */
const FIXTURE = process.env.SHOT_FIXTURE === "1";

function fixtureData() {
  const q = [];
  for (let i = 1; i <= 12; i++) {
    q.push({ groupId: "1000" + (200 + i * 7), count: 13 - i, oldestSec: i * 240 });
  }
  const todayByGroup = {}, byGroup = {};
  ["1000301", "1000302", "1000303"].forEach((g, i) => { todayByGroup[g] = 6 - i * 2; byGroup[g] = 30 + i * 9; });
  return {
    ok: true, generatedAt: new Date().toISOString(),
    cacheFile: "src/data/move-poop-cache.json", statsFile: "src/data/move-poop-stats.jsonl",
    total: 1286,
    queue: { total: 78, windowSec: 3600, byGroup: q },
    forwarded: { total: 1487, today: 12, byGroup, todayByGroup, lastAt: new Date().toISOString() },
    recent: [
      { id: "1234567890ABCDEF", when: "12:41", group: "1000207" },
      { id: "2234567890ABCDEF", when: "12:38", group: "1000214" },
      { id: "3234567890ABCDEF", when: "12:30", group: "1000221" },
    ],
    cfg: { enabled: true, mode: "plain", pollSeconds: 30, sourceGroups: [1,2,3,4,5], targetGroups: [6,7],
      cooldownDaySeconds: 90, cooldownDayStart: "09:00", cooldownNightSeconds: 300, cooldownNightStart: "23:30",
      batchSize: 20, minGoodMinusBad: 3 },
    quality: { enabled: true, windowSeconds: 3600, gramSize: 5 },
  };
}

const HARNESS = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>私有客户端 · 搬屎页</title>
<link rel="stylesheet" href="/app/renderer/app.css"></head>
<body style="margin:0;background:#faf7f4">
<div id="view"></div>
<script src="/app/renderer/poop-panel.js"></script>
<script>
fetch("/api/xuhpoop").then(r => r.json()).then(d => {
  if (d && d.error) d = { loaded: true, error: d.error };
  else { d = d || {}; d.loaded = true; }
  var S = { tab: "poop", poop: d };
  var box = document.getElementById("view");
  box.innerHTML = window.PoopPanel.html(S);
  window.PoopPanel.bind(box);
  document.title = "ok";
}).catch(e => {
  document.getElementById("view").innerHTML = '<div class="empty">读不到：' + e.message + '</div>';
});
</script></body></html>`;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
};

function serveFile(p, res) {
  fs.readFile(p, function (err, buf) {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  const u = req.url.split("?")[0];
  if (u === "/harness-poop.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HARNESS);
    return;
  }
  if (u === "/api/xuhpoop") {
    // 截图/预览用：搬屎状态（只读，和客户端同一个 poop-data.js）
    try {
      const d = FIXTURE ? fixtureData() : require(path.join(ROOT, "client", "poop-data.js")).poopData();
      d.ok = true;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(d));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  if (u === "/api/xuhcfg") {
    // 截图/预览用：按 client/spec.js 的白名单读一份配置出来（只读）
    try {
      const spec = require(path.join(ROOT, "client", "spec.js"));
      const cfg = require(path.join(ROOT, "src", "config")).load();
      const out = {};
      for (const kind of Object.keys(spec.SPEC)) {
        for (const key of spec.SPEC[kind]) {
          const v = spec.getIn(cfg, key);
          if (v !== undefined) spec.setIn(out, key, v);
        }
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, cfg: out, preview: true }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  if (u.indexOf("/api/") === 0) {
    // 直接把真 req/res 交给面板那份 handler：图是二进制，转一手会碎
    try {
      require(path.join(ROOT, "src", "server", "panel.js")).handler(req, res);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  const rel = decodeURIComponent(u).replace(/^\/+/, "");
  if (rel.indexOf("..") >= 0) { res.writeHead(400); res.end("bad path"); return; }
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && abs.indexOf(ROOT + path.sep) !== 0) { res.writeHead(400); res.end("bad path"); return; }
  serveFile(abs, res);
});

function chromeBin() {
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return "";
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitJson(port, p, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + p);
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(300);
  }
  return null;
}

async function capture(bin, url, out) {
  const port = 9222 + Math.floor(Math.random() * 300);
  const tmp = path.join("/tmp", "xuhbot-shot-" + Date.now());
  const child = spawn(bin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=" + SHOT_W + "," + SHOT_H,
    "--remote-debugging-port=" + port, "--user-data-dir=" + tmp, "--crash-dumps-dir=/tmp",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const ver = await waitJson(port, "/json/version", 40);
    if (!ver) throw new Error("Chrome 的调试端口没起来");
    const list = await waitJson(port, "/json/list", 40);
    const target = (list || []).filter(t => t.type === "page")[0];
    if (!target) throw new Error("没有可用的页面目标");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("连不上调试通道")); });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise(res => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: SHOT_W, height: SHOT_H, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });

    // 等真渲染：页面上出现图 / 卡片 / 表格，或者外壳报错为止
    const expr = "document.querySelectorAll('#view img, #view .card, #view .empty, #view .row, #view table').length";
    let score = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      score = (r.result && r.result.result && r.result.result.value) || 0;
      if (score >= 10) break;
    }

    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const data = shot.result && shot.result.data;
    if (!data) throw new Error("截图返回空");
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    return { score, bytes: fs.statSync(out).size };
  } finally {
    try { child.kill("SIGKILL"); } catch (e) {}
  }
}

/* SHOT_SERVE=1：只起这个服务、不截图，用浏览器直接看客户端界面（#poop / #sticker …）。 */
if (process.env.SHOT_SERVE === "1") {
  server.listen(PORT, "127.0.0.1", function () {
    console.log("客户端预览：http://127.0.0.1:" + PORT + "/client/renderer/index.html#" + PAGE);
  });
} else server.listen(PORT, "127.0.0.1", async function () {
  const url = PAGE === "private"
    ? "http://127.0.0.1:" + PORT + "/harness-poop.html"
    : PAGE.charAt(0) === "/"
      ? "http://127.0.0.1:" + PORT + PAGE
      : "http://127.0.0.1:" + PORT + "/client/renderer/index.html#" + PAGE;
  const bin = chromeBin();
  if (!bin) {
    console.error("没找到 Chrome/Chromium/Edge。装一个，或手动开浏览器访问：" + url);
    server.close(); process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  try {
    const r = await capture(bin, url, OUT);
    server.close();
    if (r.bytes < MIN_BYTES) {
      console.error("截图太小，可能还是空白（" + r.bytes + " 字节，score=" + r.score + "）");
      process.exit(1);
    }
    console.log("截图好了：" + OUT + "（" + Math.round(r.bytes / 1024) + " KB，score=" + r.score + "）");
    process.exit(0);
  } catch (e) {
    server.close();
    console.error("截图失败：" + (e && e.message || e));
    process.exit(1);
  }
});
