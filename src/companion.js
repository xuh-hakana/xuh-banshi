#!/usr/bin/env node
/**
 * 虚幻 · 陪玩服务（companion）
 * 建立：2026-11-02
 *
 * 干什么：让她「陪着主人打游戏」——Windows 那边定时截一张游戏画面发过来，
 *        这边看一眼画面、说一句话、合成语音，OBS 的浏览器源把字幕和声音播出来。
 *
 * 为什么是独立进程：跟 panel.js（面板 8899）一个道理。
 * 不碰 bot.js，QQ 群里聊天那套完全不受影响；这个服务挂了，群里的她照样活着。
 *
 * 借来的东西（都是现成的，不重复造）：
 *   core.seeImage()  看图（glm-4v-flash，免费，自带降级）
 *   core.callLLM()   说话（自带模型降级、限流退避、花费记账、余额不足自动摘链）
 *   persona/…/说话风格.md   语气（主人改了风格，这里跟着变）
 *
 * 端口：8900
 * 接口：
 *   POST /shot        收一张截图往下走（Windows 截图脚本调）
 *   GET  /live        OBS 浏览器源加载这个页面（字幕 + 声音）
 *   GET  /feed        页面轮询新台词用
 *   GET  /voice/x.wav 语音文件
 *   GET  /            状态页（人和自己看：收到了几张、说了几句、手动让她说一句）
 *   POST /say         手动让她说一句（测试用，不经过看图）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const core = require('./core');

const PORT = Number(process.env.COMPANION_PORT || 8900);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'companion');
const VOICE_DIR = path.join(DATA, 'voice');
const LOG_PATH = path.join(DATA, '直播台词.jsonl');
const STYLE_PATH = path.join(ROOT, 'persona', '1-人设正文', '说话风格.md');

// 节奏与省钱：两次说话至少隔这么久（毫秒）。直播时她大概 12~20 秒接一句最自然，
// 太密会吵、也白白烧额度（免费模型也有频率限制，撞上了会连续失败）。
const MIN_GAP = Number(process.env.COMPANION_GAP || 10000);
// 画面几乎没变就不说了——她站在那里不动的时候，没必要每 15 秒复述一遍同一句话。
const SAME_FRAME_RATIO = 0.78;
const MAX_FEED = 40;
const VOICE_KEEP = 20;

for (const d of [DATA, VOICE_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

/* ---------------------------------------------------------------- 状态 */

const feed = [];              // 最近的台词，页面轮询这个
let nextId = 1;
let lastDesc = '';            // 上一次的画面描述（判断画面有没有变）
let lastLine = '';            // 上一句台词（让她别重复）
let lastAt = 0;               // 上一次说完的时间
let busy = false;             // 正在看图+说话，新图直接丢，不排队（直播要的是现在，不是补课）
const stat = { shots: 0, said: 0, skippedSame: 0, skippedGap: 0, dropped: 0, err: 0, lastErr: '', lastShotAt: 0 };

/* ---------------------------------------------------------------- 语音 */

// 系统语音的名字在不同 macOS 版本里不一样：只写「Flo」生成的是 0 字节空文件（踩过），
// 必须是「Flo (中文（中国大陆）)」这种带语言的完整名，或者直接用语言码 zh_CN。
// 所以启动时挨个试，谁先能生成出有内容的文件就用谁。
let VOICE = null;
function pickVoice() {
  const probe = path.join(os.tmpdir(), 'xu-voice-probe.aiff');
  const cands = [
    'Flo (中文（中国大陆）)',
    'Tingting',
    'Eddy (中文（中国大陆）)',
    'zh_CN',
    'Meijia',
  ];
  for (const v of cands) {
    try {
      try { fs.unlinkSync(probe); } catch {}
      execFileSync('say', ['-v', v, '-o', probe, '好'], { timeout: 8000 });
      if (fs.statSync(probe).size > 2000) { try { fs.unlinkSync(probe); } catch {} return v; }
    } catch {}
  }
  // 全都不行就用系统默认语音（英文，但至少能出声）
  try {
    try { fs.unlinkSync(probe); } catch {}
    execFileSync('say', ['-o', probe, 'hi'], { timeout: 8000 });
    if (fs.statSync(probe).size > 2000) { try { fs.unlinkSync(probe); } catch {} return ''; }
  } catch {}
  return null;
}

// 念出来的东西和写出来的东西不一样：emoji 会被念成乱码或直接吞掉，
// 各种括号动作（（笑））也不该念。所以念之前先洗一遍。
function forSpeech(t) {
  return String(t || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[（(][^）)]{0,10}[）)]/g, '')
    .replace(/^\s*[「『"]|[」』"]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tts(text, id) {
  return new Promise((resolve) => {
    const say = forSpeech(text);
    if (!say) return resolve('');
    const aiff = path.join(VOICE_DIR, id + '.aiff');
    const wav = path.join(VOICE_DIR, id + '.wav');
    const args = VOICE ? ['-v', VOICE, '-o', aiff, say] : ['-o', aiff, say];
    execFile('say', args, { timeout: 20000 }, (err) => {
      if (err) { console.log('[tts] say 失败：' + err.message.slice(0, 80)); return resolve(''); }
      // 浏览器只认 wav/mp3，aiff 放不出来，转一道
      execFile('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiff, wav], { timeout: 20000 }, (e2) => {
        try { fs.unlinkSync(aiff); } catch {}
        if (e2) { console.log('[tts] 转换失败：' + e2.message.slice(0, 80)); return resolve(''); }
        promiseTrimVoices();
        resolve(id + '.wav');
      });
    });
  });
}

// 语音文件只留最近几条，不然一场直播下来几百兆
function promiseTrimVoices() {
  try {
    const files = fs.readdirSync(VOICE_DIR).filter(f => f.endsWith('.wav'))
      .map(f => ({ f, t: fs.statSync(path.join(VOICE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(VOICE_KEEP)) { try { fs.unlinkSync(path.join(VOICE_DIR, x.f)); } catch {} }
  } catch {}
}

/* ---------------------------------------------------------------- 语气 */

// 她的说话风格文件里有「现在的样子」「主人自己补的」两段。
// 主人自己补的优先级最高（文件里写着的规矩），所以两段都要读。
function styleText() {
  try {
    const t = fs.readFileSync(STYLE_PATH, 'utf8');
    const m = t.split(/^## /m).filter(s => /现在的样子|主人自己补的/.test(s));
    const body = m.join('\n').replace(/^现在的样子|^主人自己补的/gm, '')
      .split('\n').filter(l => l.trim() && !l.startsWith('>')).join('\n').trim();
    return body.slice(0, 800) || '短句，口语，偶尔用「我去」「为啥」。';
  } catch {
    return '短句，口语，偶尔用「我去」「为啥」。';
  }
}

const LIVE_RULES = `你是「虚幻」，现在坐在主人旁边看她打游戏，边看边嘀咕两句。

【说话的味道】
${styleText()}

【硬规矩】
1. 只能说你看到的。画面描述里没写的人名、招式、boss 名、剧情，一律不许编——不认识就说不认识。
2. 只说一句话，20 字以内。像旁边那个人随口说的，不是解说，不是旁白。
3. 不要复述画面。「主人被击败了」是病句，应该说「哎哟」。
4. 不要每句都问问题，不喊「加油」「稳住」这种空话。
5. 不写括号动作，不写书面语。
6. 不许和第 2 条里给的「上一句」重复。

只输出台词本身，不要引号，不要解释。`;

/* ---------------------------------------------------------------- 看图说话 */

// 问视觉模型的问题要跟表情包那套分开：VISION_PROMPT 是「逐字抄字」，
// 游戏画面要的是「现在是什么局面」，所以自己写一条。
const SHOT_PROMPT = '这是主人正在玩的游戏画面。用两句话说：第一句，画面上正在发生什么（谁在打谁、她状态如何、有没有字弹出来）；第二句，画面上任何看得见的文字，原样抄下来。看不清就直说看不清。不要猜游戏名字，不要评论。';

function charSet(s) {
  return new Set(String(s || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase().split(''));
}
// 画面变了没：两次描述共有的字占比。
function similarity(a, b) {
  const A = charSet(a), B = charSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const c of A) if (B.has(c)) hit++;
  return hit / Math.max(A.size, B.size);
}

function push(text, desc) {
  const id = String(nextId++);
  const item = { id, text, desc: desc || '', at: Date.now(), wav: '' };
  feed.push(item);
  if (feed.length > MAX_FEED) feed.shift();
  lastLine = text;
  stat.said++;
  // 顺手记一份带时间戳的流水：后期剪视频时能对着时间轴找「她当时说了什么」
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), text, desc }) + '\n');
  } catch {}
  return item;
}

async function lookAndTalk(imgBuf, mime) {
  const t0 = Date.now();
  const dataUri = require('./img-cache').dataUriFromBuffer(imgBuf, mime || 'image/jpeg');
  const desc = await core.seeImage([dataUri], SHOT_PROMPT);
  const t1 = Date.now();
  if (!desc) throw new Error('看图没有返回内容');

  // 画面没动就别重复说一遍（省额度、也免得观众听她复读）
  if (lastDesc && similarity(desc, lastDesc) >= SAME_FRAME_RATIO) {
    stat.skippedSame++;
    console.log('[看] 画面没变，跳过（' + Math.round(similarity(desc, lastDesc) * 100) + '%）');
    return null;
  }

  const before = lastLine;
  const msgs = [
    { role: 'system', content: LIVE_RULES },
    { role: 'user', content: '【画面】' + desc + (before ? '\n【上一句】' + before : '') },
  ];
  let line = String(await core.callLLM(msgs, { tag: 'other' }) || '').trim();
  const t2 = Date.now();
  line = line.replace(/^[「『"]|[」』"]$/g, '').replace(/\n+/g, ' ').trim();
  if (!line) throw new Error('没说出话');
  if (line.length > 60) line = line.slice(0, 60);
  if (line === before) { stat.skippedSame++; return null; }

  lastDesc = desc;
  const item = push(line, desc);
  console.log('[说] ' + line + '  (看图 ' + (t1 - t0) + 'ms + 想话 ' + (t2 - t1) + 'ms = ' + (Date.now() - t0) + 'ms)');
  // 语音异步补上，不挡着下一句
  tts(line, item.id).then(w => { if (w) item.wav = w; });
  return item;
}

/* ---------------------------------------------------------------- 页面 */

function livePage() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>虚幻 · 直播</title><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#wrap{position:absolute;left:44px;right:44px;bottom:56px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
#bubble{max-width:880px;background:rgba(18,18,22,.86);color:#fff;padding:20px 28px;border-radius:18px;
  font-size:34px;line-height:1.55;letter-spacing:.5px;opacity:0;transform:translateY(10px);
  transition:opacity .35s ease,transform .35s ease;box-shadow:0 6px 26px rgba(0,0,0,.35)}
#bubble.on{opacity:1;transform:translateY(0)}
#tag{color:#8fd8bd;font-size:20px;padding-left:6px;opacity:0;transition:opacity .35s}
#tag.on{opacity:.95}
</style></head><body>
<div id="wrap"><div id="tag">虚幻</div><div id="bubble"></div></div>
<script>
var since=0,timer=null,bubble=document.getElementById('bubble'),tag=document.getElementById('tag'),started=false;
// 先播一段 0 秒静音：OBS 的浏览器源不这么做，后面自动放语音会被浏览器拦掉
try{var u=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=');u.volume=0;u.play().catch(function(){});}catch(e){}
function show(t){
  bubble.textContent=t;bubble.classList.add('on');tag.classList.add('on');
  clearTimeout(timer);
  timer=setTimeout(function(){bubble.classList.remove('on');tag.classList.remove('on');},9000);
}
function poll(){
  fetch('/feed?since='+since).then(function(r){return r.json()}).then(function(j){
    var items=j.items||[];
    if(!started){
      // OBS 刚打开时不要把之前说过的全播一遍，只记住位置
      items.forEach(function(it){since=Math.max(since,+it.id)});
      started=true;return;
    }
    items.forEach(function(it){
      since=Math.max(since,+it.id);show(it.text);
      if(it.wav){var a=new Audio('/voice/'+it.wav+'?t='+Date.now());a.volume=1;a.play().catch(function(e){console.log('播放被拦',e)});}
    });
  }).catch(function(){});
}
setInterval(poll,1500);poll();
// 想先看看字幕长什么样：打开 /live?demo
if(location.search.indexOf('demo')>=0){setTimeout(function(){show('我去，这 boss 也太狠了吧，一刀都没躲开');},400);}
</script></body></html>`;
}

function homePage() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>虚幻 · 陪玩状态</title>
<style>
body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#faf9f7;color:#22211f}
.wrap{max-width:760px;margin:0 auto;padding:32px 24px 60px}
h1{font-size:20px;font-weight:500;margin:0 0 4px}
.sub{color:#7a7873;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.card{background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:16px}
.k{font-size:12px;color:#7a7873;margin-bottom:6px}
.v{font-size:22px;font-weight:500}
.live{background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:16px;margin-bottom:16px}
.live b{color:#0f6e56;font-weight:500}
.row{display:flex;gap:8px;margin-top:10px}
input{flex:1;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit}
button{padding:10px 18px;border:0;border-radius:8px;background:#0f6e56;color:#fff;font-size:14px;cursor:pointer;font-family:inherit}
button:hover{background:#0b5544}
ol{padding-left:20px;margin:0}
li{margin-bottom:10px;font-size:14px;line-height:1.6}
li span{color:#7a7873;font-size:12px}
</style></head><body><div class="wrap">
<h1>虚幻 · 陪玩</h1>
<div class="sub">这个页面是给你自己看的：她收到几张图、说了几句话。直播画面里看不到这个。</div>
<div class="grid">
  <div class="card"><div class="k">收到截图</div><div class="v" id="s1">-</div></div>
  <div class="card"><div class="k">说了几句</div><div class="v" id="s2">-</div></div>
  <div class="card"><div class="k">画面没变跳过</div><div class="v" id="s3">-</div></div>
</div>
<div class="live">
  <div>状态：<b id="st">读取中…</b></div>
  <div class="row">
    <input id="say" placeholder="手动让她说一句（测试用，比如：这个boss好难啊">
    <button onclick="sayIt()">让她说</button>
  </div>
</div>
<div class="live"><div style="font-size:13px;color:#7a7873;margin-bottom:10px">最近说的话</div><ol id="list"></ol></div>
</div><script>
function refresh(){
  fetch('/status').then(r=>r.json()).then(j=>{
    document.getElementById('s1').textContent=j.shots;
    document.getElementById('s2').textContent=j.said;
    document.getElementById('s3').textContent=j.skippedSame;
    document.getElementById('st').textContent=j.state;
    document.getElementById('list').innerHTML=(j.recent||[]).map(x=>
      '<li>'+x.text+' <span>'+new Date(x.at).toLocaleTimeString('zh-CN')+'</span></li>').join('')||'<li style="color:#7a7873">还没说过话</li>';
  }).catch(()=>{document.getElementById('st').textContent='连不上服务，看看启动窗口还在不在'});
}
function sayIt(){
  var t=document.getElementById('say').value.trim();if(!t)return;
  fetch('/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});
  document.getElementById('say').value='';setTimeout(refresh,600);
}
setInterval(refresh,2000);refresh();
</script></body></html>`;
}

function winPage() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Windows 这边要做的</title>
<style>
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#faf9f7;color:#22211f}
.wrap{max-width:680px;margin:0 auto;padding:36px 24px 70px}
h1{font-size:22px;font-weight:500;margin:0 0 6px}
.sub{color:#7a7873;font-size:14px;margin-bottom:26px;line-height:1.7}
.dl{display:flex;gap:12px;margin-bottom:30px;flex-wrap:wrap}
a.btn{flex:1;min-width:220px;display:block;text-align:center;padding:16px;background:#0f6e56;color:#fff;
  text-decoration:none;border-radius:10px;font-size:15px}
a.btn.alt{background:#fff;color:#0f6e56;border:1px solid #0f6e56}
a.btn small{display:block;font-size:12px;opacity:.8;margin-top:4px}
.step{background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:18px 20px;margin-bottom:12px}
.step b{display:block;font-weight:500;margin-bottom:8px;font-size:15px}
.step p{margin:0;font-size:14px;line-height:1.75;color:#454440}
.warn{background:#fdf4e7;border:1px solid #f0d9b5;border-radius:12px;padding:18px 20px;font-size:14px;line-height:1.75}
.warn b{color:#8a5a12}
code{background:#f1efea;padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
</style></head><body><div class="wrap">
<h1>Windows 这边要做的事</h1>
<div class="sub">一共三个文件、两次双击。左边这两个是给你的，右边那个 OBS 你自己装。</div>

<div class="dl">
  <a class="btn" href="/win/start.bat" download>下载 启动陪玩.bat<small>双击这个就行</small></a>
  <a class="btn alt" href="/win/shot.ps1" download>下载 companion-shot.ps1<small>被 .bat 调用，别单独动它</small></a>
</div>

<div class="step"><b>1. 先把游戏设成「无边框窗口」</b>
<p>全屏独占模式下 Windows 截不到游戏画面，只能截到黑的。游戏里：设置 → 画面 → 显示模式 → 无边框窗口（Borderless）。设置一次，以后不用管。</p></div>

<div class="step"><b>2. 两个文件放同一个文件夹，双击「启动陪玩.bat」</b>
<p>会弹出一个黑窗口，先自检：截一张看看大小正不正常、连不连得上 Mac。都通过就开始每 15 秒发一张图。<br>
要停就按 <code>Ctrl + C</code>。黑窗口别关，关了就不发了。</p></div>

<div class="step"><b>3. OBS 加一个「浏览器」源</b>
<p>来源 → 加 → 浏览器 → 网址填 <code>http://192.168.124.24:8900/live</code> → 宽 1920 高 1080。<br>
这个源就是她的字幕和声音，放在画面上层。声音走这个源，不用装虚拟声卡。</p></div>

<div class="warn"><b>黑屏 / 发不出去怎么办</b><br>
· 截图全黑 → 游戏还是全屏独占，回去做第 1 步<br>
· 连不上 Mac → 两台要连同一个路由器；Mac 上那个跑陪玩的黑窗口要开着<br>
· 想看效果 → 在 Windows 浏览器打开 <code>http://192.168.124.24:8900</code>，是她自己的状态页</div>
</div></body></html>`;
}

/* ---------------------------------------------------------------- HTTP */

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': b.length });
  res.end(b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('图片太大（超过 ' + Math.round(limit / 1048576) + 'MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  try {
    if (p === '/live') {
      const b = Buffer.from(livePage());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    if (p === '/') {
      const b = Buffer.from(homePage());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    if (p === '/win') {
      const b = Buffer.from(winPage());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    // Win 那边不用复制粘贴：浏览器打开 /win 直接下载这两个文件
    if (p === '/win/shot.ps1' || p === '/win/start.bat') {
      const isPs = p.endsWith('.ps1');
      const fp = path.join(ROOT, 'win', isPs ? 'companion-shot.ps1' : '启动陪玩.bat');
      if (!fs.existsSync(fp)) return json(res, 404, { ok: false, why: '文件没找到：' + fp });
      const buf = fs.readFileSync(fp);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + (isPs ? 'companion-shot.ps1' : encodeURIComponent('启动陪玩.bat')),
      });
      return res.end(buf);
    }

    if (p === '/status') {
      return json(res, 200, {
        shots: stat.shots, said: stat.said, skippedSame: stat.skippedSame,
        skippedGap: stat.skippedGap, dropped: stat.dropped, err: stat.err, lastErr: stat.lastErr,
        voice: VOICE === null ? '没有可用语音' : (VOICE || '系统默认'),
        gap: MIN_GAP,
        state: busy ? '正在看图…' : (stat.shots ? '待命中（等你传画面）' : '还没收到画面，检查 Win 那边脚本有没有跑起来'),
        recent: feed.slice(-10).reverse(),
      });
    }

    if (p === '/feed') {
      const since = Number(u.searchParams.get('since') || 0);
      const items = feed.filter(x => Number(x.id) > since).map(x => ({ id: x.id, text: x.text, wav: x.wav, at: x.at }));
      return json(res, 200, { items });
    }

    if (p.startsWith('/voice/')) {
      const name = path.basename(p.slice(7));
      const fp = path.join(VOICE_DIR, name);
      if (!fs.existsSync(fp)) return json(res, 404, { ok: false });
      const b = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    }

    if (p === '/say' && req.method === 'POST') {
      const raw = await readBody(req, 1 << 20);
      const j = JSON.parse(raw.toString('utf8') || '{}');
      const text = String(j.text || '').trim();
      if (!text) return json(res, 400, { ok: false, why: '空的' });
      const item = push(text.slice(0, 80), '(手动)');
      tts(item.text, item.id).then(w => { if (w) item.wav = w; });
      return json(res, 200, { ok: true, id: item.id });
    }

    if (p === '/shot' && req.method === 'POST') {
      const raw = await readBody(req, 12 << 20);
      let b64 = '', mime = 'image/jpeg';
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        const j = JSON.parse(raw.toString('utf8'));
        b64 = String(j.img || '');
        if (j.mime) mime = String(j.mime);
      } else {
        // 直接发原始图片字节也收（curl 传文件方便测）
        b64 = raw.toString('base64');
        if (ct.startsWith('image/')) mime = ct.split(';')[0];
      }
      let data = b64;
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b64);
      if (m) { mime = m[1]; data = m[2]; }
      if (!data) return json(res, 400, { ok: false, why: '没有图' });
      const buf = Buffer.from(data, 'base64');
      if (buf.length < 1000) return json(res, 400, { ok: false, why: '图太小，可能没截到' });

      stat.shots++;
      stat.lastShotAt = Date.now();

      if (busy) { stat.dropped++; return json(res, 200, { ok: true, skipped: '正在说上一句' }); }
      const gap = Date.now() - lastAt;
      if (gap < MIN_GAP) { stat.skippedGap++; return json(res, 200, { ok: true, skipped: '太频繁，' + Math.ceil((MIN_GAP - gap) / 1000) + ' 秒后再来' }); }

      busy = true;
      lastAt = Date.now();   // 按「开始这句」算间隔，不是「说完」——不然处理本身要 5 秒，会把下一张白白挤掉
      lookAndTalk(buf, mime)
        .catch(e => { stat.err++; stat.lastErr = String(e.message || e).slice(0, 120); console.log('[错] ' + stat.lastErr); })
        .finally(() => { busy = false; });
      // 立刻回 200，不让截图脚本干等——它那边还要继续截下一张
      return json(res, 202, { ok: true, queued: true });
    }

    json(res, 404, { ok: false, why: '没有这个地址' });
  } catch (e) {
    stat.err++; stat.lastErr = String(e.message || e).slice(0, 120);
    console.log('[错] ' + stat.lastErr);
    try { json(res, 500, { ok: false, why: stat.lastErr }); } catch {}
  }
});

VOICE = pickVoice();
server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  } catch {}
  console.log('==============================================');
  console.log(' 虚幻陪玩 已启动');
  console.log(' 语音：' + (VOICE === null ? '（没有可用语音，只会出字）' : (VOICE || '系统默认')));
  console.log(' 间隔：最少 ' + (MIN_GAP / 1000) + ' 秒说一句');
  console.log('');
  console.log(' 你自己看： http://127.0.0.1:' + PORT + '/');
  for (const ip of ips) console.log(' OBS 浏览器源：http://' + ip + ':' + PORT + '/live');
  console.log('');
  console.log(' s1日志：' + LOG_PATH);
  console.log('==============================================');
});
