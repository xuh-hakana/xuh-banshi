/*
 * app/main.js — 虚幻 · 桌面客户端（Electron 主进程）
 *
 * 2026-11-03 改版（她定的「丙-B」）：界面自己画，不再内嵌 8899 那个网页。
 *   ① 不再启动 panel.js、不再占 8899 —— 「不再有网页版」说的是这个
 *   ② 数据从 src/server/state.js 直接取（和面板同一份实现，不另写一套）
 *   ③ 界面在 app/renderer/，纯本地 HTML，通过 IPC 拿数据、改数据
 *   ④ 图片走自定义协议 xuh://，只允许读 src/data/stickers 下的图
 *
 * 为什么需要 node：核心逻辑（core.js）要真 node 才跑得动，Electron 自带的 node 也能跑，
 * 但客户端只在主进程 require 一次，渲染进程完全隔离（contextIsolation + 无 nodeIntegration）。
 */
const { app, BrowserWindow, Menu, shell, ipcMain, protocol, dialog, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const botRunner = require('./bot-runner');   // 机器人本体（src/bot.js）的起停，见该文件开头

const ROOT = path.resolve(__dirname, '..');          // xuhbot/
/* --tab=<页>：启动直接落到某一页（截图、定位问题时用；不给就还是默认页）。 */
const TAB_ARG = (() => {
  const hit = process.argv.filter(a => String(a).indexOf('--tab=') === 0)[0];
  if (hit) return String(hit).slice(6);
  /* macOS 用 open 起 .app 时命令行参数会被丢掉，环境变量也带不进去，
   * 所以再认一个提示文件：app/.open-tab 里写页 id（poop / stickers / chat …），读完就用。 */
  try {
    const hint = fs.readFileSync(path.join(__dirname, '.open-tab'), 'utf8').trim();
    if (hint) return hint;
  } catch (e) { /* 没有这个文件就是默认页 */ }
  return process.env.XUHBOT_TAB || '';
})();
const STICKER_DIR = path.join(ROOT, 'src', 'data', 'stickers');
const qmeta = require(path.join(ROOT, 'src', 'qq-meta.js'));   // 群友头像：客户端与机器人共用同一份缓存

/* ---------- 日志 ---------- */
const LOG_DIR = path.join(__dirname, '日志');
const LOG_FILE = path.join(LOG_DIR, '客户端.log');
function log(msg) {
  const line = new Date().toLocaleString('zh-CN') + '  ' + msg;
  console.log(msg);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const old = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n') : [];
    old.push(line);
    fs.writeFileSync(LOG_FILE, old.slice(-400).join('\n'));
  } catch {}
}

let win = null;
let STATE = null;            // 懒加载，加载失败要能在界面上看见原因

/* ---------- 数据层 ----------
 * 只有真的要用时才 require，坏掉也不至于整个 app 起不来。 */
function state() {
  if (STATE) return STATE;
  STATE = require(path.join(ROOT, 'src', 'server', 'state.js'));
  return STATE;
}
function call(fn, ...args) {
  try { return fn(...args); }
  catch (e) { log('[数据层出错] ' + (e && e.stack || e)); return { error: String(e && e.message || e) }; }
}

/* ---------- 自定义协议：xuh://stickers/<池>/<文件名> ----------
 * 只允许读表情包目录里的图片，路径里出现 .. 直接拒。 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'xuh', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/*
 * 图名 → 磁盘上的真文件。
 * 表情清单里存的是不带扩展名的名字（可能是「常用/xxx」，也可能只是「xxx」），
 * 和面板 /api/stkimg 用的是同一套规则：带斜杠按目录找，裸名按池的优先级找。
 */
/* 2026-11-08：这里只是「一个裸名解析成哪个文件」的查找顺序 —— 一个名字只能对应一个文件，
 * 不是池优先级。常用/ 和 虚幻/ 同级（同属 main、同权重 48），发图候选见 qq.js 的 pickFromCands()。 */
const POOLS = ['常用', '可用', '虚幻', '关键词触发', '少用', ''];
const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
function resolveSticker(name) {
  const clean = decodeURIComponent(String(name || '')).replace(/^[/\\]+/, '');
  if (!clean) return null;
  const bases = clean.includes('/')
    ? [path.resolve(STICKER_DIR, clean)]
    : POOLS.map(d => path.resolve(STICKER_DIR, d, clean));
  for (const b of bases) {
    if (b !== STICKER_DIR && !b.startsWith(STICKER_DIR + path.sep)) continue;
    for (const f of [b, ...EXTS.map(e => b + e)]) {
      try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

/* ---------- 左上角那张图（2026-11-05 她要的） ----------
 * 她要的是：客户端左上角显示一张图，渐隐地显（不像贴纸那样硬边），也能换别的图。
 *
 * 落点：图片统一放 src/data/ui/（和别的数据一处，备份 data 就带上），
 *       配置写 src/data/ui.json，只有三个字段，别加花样：
 *         brandImg     图片文件名（就在 src/data/ui/ 下，不带路径）
 *         brandOpacity 不透明度，0~1（越小越「隐约」）
 *         brandPos     取景位置（默认 center 40%：方图铺在 212×150 的横条里，上下会各裁一点）
 *
 * 换图流程：系统选图 → 复制成 left.<扩展名> → 删掉旧的 left.* → 写 ui.json。
 * 复制而不是引用原路径：她可能把原图挪走/删掉，引用会变成白框。
 */
const UI_DIR = path.join(ROOT, 'src', 'data', 'ui');
const UI_JSON = path.join(ROOT, 'src', 'data', 'ui.json');
const SKIN_DEFAULT = path.join(STICKER_DIR, '虚幻', '哭.jpg');   // 首次默认用这张
const SKIN_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const SKIN_MAX_MB = 12;

function uiCfg() {
  try {
    const d = JSON.parse(fs.readFileSync(UI_JSON, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}
function uiCfgSave(patch) {
  const next = Object.assign({}, uiCfg(), patch || {});
  try {
    fs.mkdirSync(path.dirname(UI_JSON), { recursive: true });
    fs.writeFileSync(UI_JSON, JSON.stringify(next, null, 2) + '\n');
  } catch (e) { log('[左上角图] 写配置失败 ' + e.message); }
  return next;
}
/* 文件名 → 磁盘路径。只许一层文件名，带斜杠或 .. 一律不认（防止协议被拿来越权读） */
function skinPath(name) {
  const n = String(name || '');
  if (!n || n !== path.basename(n) || n.startsWith('.')) return null;
  const p = path.join(UI_DIR, n);
  return p.startsWith(UI_DIR + path.sep) ? p : null;
}
function skinState() {
  const cfg = uiCfg();
  const p = skinPath(cfg.brandImg);
  const has = !!(p && fs.existsSync(p));
  return {
    ok: true,
    url: has ? 'xuh://skin/' + encodeURIComponent(cfg.brandImg) + '?v=' + Date.now() : '',
    name: has ? cfg.brandImg : '',
    opacity: typeof cfg.brandOpacity === 'number' ? cfg.brandOpacity : 0.58,
    pos: typeof cfg.brandPos === 'string' && cfg.brandPos ? cfg.brandPos : 'center 40%',
    dir: UI_DIR,
  };
}
/* 没有图时把默认那张放进去；已经有图就一个字节都不动 */
function ensureSkin() {
  const st = skinState();
  if (st.url) return st;
  try {
    if (!fs.existsSync(SKIN_DEFAULT)) return st;
    fs.mkdirSync(UI_DIR, { recursive: true });
    const dest = path.join(UI_DIR, 'left.jpg');
    fs.copyFileSync(SKIN_DEFAULT, dest);
    uiCfgSave({ brandImg: 'left.jpg' });
    log('[左上角图] 已放入默认图 ' + SKIN_DEFAULT);
  } catch (e) { log('[左上角图] 放默认图失败 ' + e.message); }
  return skinState();
}

/* ---------- 窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1220, height: 820, minWidth: 900, minHeight: 600,
    title: '虚幻',
    backgroundColor: '#E7EAEE',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  const startPage = TAB_ARG || '';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), startPage ? { hash: startPage } : undefined);
  /* 截图钩子：XUHBOT_SHOT=/tmp/x.png 时载完页拍一张就退（验界面用，不影响正常启动） */
  const SHOT = process.env.XUHBOT_SHOT;
  if (SHOT) {
    /* 截图模式下把渲染进程的报错也写进日志，不然页卡住只看到一片空白 */
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) log('[页面报错] ' + message); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        for (const sel of String(process.env.XUHBOT_SHOT_CLICK || '').split(',').filter(Boolean)) {
          await win.webContents.executeJavaScript('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); if(e) e.click(); return 1;})()');
          await new Promise(r => setTimeout(r, 800));
        }
        if (process.env.XUHBOT_SHOT_THEME === 'night') {
          await win.webContents.executeJavaScript("var b=document.getElementById('themeBtn'); if(b&&document.documentElement.dataset.theme!=='night') b.click(); 1");
          await new Promise(r => setTimeout(r, 3000));
        }
        const diag = await win.webContents.executeJavaScript("JSON.stringify({nav:[...document.querySelectorAll('#nav .nav-item .nav-label')].map(e=>e.textContent),title:(document.getElementById('view-title')||{}).textContent,view:(document.getElementById('view')||{}).textContent.slice(0,120),hash:location.hash})");
        log('[截图] 界面=' + diag);
        fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG());
        log('[截图] 已写出 ' + SHOT);
      } catch (e) { log('[截图] 失败 ' + e.message); }
      setTimeout(() => app.quit(), 400);
    }, Number(process.env.XUHBOT_SHOT_DELAY || 3500)));
  }
  win.webContents.on('did-finish-load', () => {
    log('[客户端] 界面已加载' + (TAB_ARG ? '（启动参数 tab=' + TAB_ARG + '）' : ''));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => log('[客户端] 加载失败 ' + code + ' ' + desc));

  /* 右键菜单（她 2026-11-09 要「能复制客户端里的文字」）。
     Electron 默认一个右键菜单都不弹，字选中了也没有「复制」入口，所以这里补一份标准的：
     · 有选中 → 复制 / 全选
     · 在输入框里 → 多给剪切 / 粘贴
     菜单只由主进程建，渲染进程不开 node，符合原来的权限分工。 */
  win.webContents.on('context-menu', (_e, p) => {
    const hasSel = !!(p.selectionText && p.selectionText.trim());
    const tpl = [];
    if (p.isEditable) tpl.push({ role: 'cut', label: '剪切' });
    if (hasSel) tpl.push({ role: 'copy', label: '复制' });
    tpl.push({ role: 'selectAll', label: hasSel ? '全选' : '全选这一页' });
    if (p.isEditable) tpl.push({ role: 'paste', label: '粘贴' });
    Menu.buildFromTemplate(tpl).popup({ window: win });
  });
  win.on('closed', () => { win = null; });
}

/* ---------- 雨夜玻璃的窗外原图 ----------
 * 页面是 loadFile 进来的 file://，直接 <img src="rain-backdrop.jpg"> 会把 2D canvas
 * 标记为「被污染」，库再拿这张画当 WebGL 纹理上传时浏览器直接拒绝 —— 实测表现是
 * 雨一颗都不画。由主进程把同一张图读成 data: URL 交给页面：data: 同源、不污染画布，
 * CSP 里 img-src 也已经放行 data:。同步 IPC，只在开屏读一次，不进渲染循环。 */
ipcMain.on('xuh:rainBackdrop', (e) => {
  try {
    const file = path.join(__dirname, 'renderer', 'rain-backdrop.jpg');
    e.returnValue = 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
  } catch (err) {
    e.returnValue = '';               // 读不到就交回给页面走原名，不抛异常打断界面
  }
});

/* ---------- 头图取色：游戏感皮肤的主色 ----------
 * 她 2026-11-09 定「主色应随头图变化」。头图平时挂在 xuh://skin/... 自定义协议上，
 * 渲染进程把它画进 2D canvas 会被判跨源污染、getImageData 直接抛错，所以沿用上面
 * 同一条路：由主进程按 src/data/ui.json 读当前那张图，转成 data: 再交给页面。
 * 换图后页面会重新调一次，主色自动跟着换。同步 IPC，不进渲染循环。 */
ipcMain.on('xuh:skinData', (e) => {
  try {
    const p = skinPath(uiCfg().brandImg);
    if (!p || !fs.existsSync(p)) { e.returnValue = ''; return; }
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : 'image/jpeg';
    e.returnValue = 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
  } catch (err) {
    e.returnValue = '';               // 取不到就保留 game.css 的兜底粉莓色
  }
});

/* ---------- IPC ----------
 * 约定：一律返回 {ok:true,...} 或 {error:'人话'}，界面按这个显示，不抛异常。 */
function ipc(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return fn(...args); }
    catch (e) { log('[IPC ' + name + '] ' + (e && e.stack || e)); return { error: String(e && e.message || e) }; }
  });
}

ipc('xuh:snapshot', () => call(() => state().snapshot()));
ipc('xuh:stickers', () => call(() => state().stickers()));
/* 搬屎页（只读）：唯一真源 src/poop-stats.js（缓存 / 流水都只在那里读，界面不另算一套） */
ipc('xuh:poop', () => call(() => require(path.join(ROOT, 'src', 'poop-stats.js')).poopStats()));
/* 启动参数里的 --tab=，渲染进程启动时问一次 */
ipc('xuh:tab-arg', () => ({ ok: true, tab: TAB_ARG }));
/* 派活词表（2026-11-22）：面板「所有数值」页直接增删词。
 * 复用 src/intent-router.js 的 words()/saveWords()（原子写 + 校验），代码里不写死第二份词表。 */
ipc('xuh:intent-words', () => call(() => {
  const r = require('../src/intent-router');
  return { ok: true, words: r.words(), whitelistFavor: r.status().whitelistFavor };
}));
ipc('xuh:intent-words-save', words => call(() => {
  const r = require('../src/intent-router');
  return { ok: true, words: r.saveWords(words || {}) };
}));
/* dsh agent 的模式开关（2026-11-22）：机器人页那张卡读写同一份 intent.json */
ipc('xuh:intent-cfg', () => call(() => {
  const r = require('../src/intent-router');
  return { ok: true, cfg: r.cfg() };
}));
ipc('xuh:intent-cfg-save', patch => call(() => {
  const r = require('../src/intent-router');
  return { ok: true, cfg: r.saveCfg(patch || {}) };
}));
/* 复制一段文字到系统剪贴板（她 2026-11-09 要能复制客户端里的文字）。
 * 走主进程而不是浏览器 navigator.clipboard：file:// 下权限弹窗不一定给，主进程这条路没有门槛。 */
ipc('xuh:copyText', text => {
  const s = String(text == null ? '' : text);
  if (!s) return { error: '没有可复制的文字' };
  clipboard.writeText(s);
  return { ok: true, chars: s.length };
});
/* 机器人本体（2026-11-05）：起停、状态、日志尾巴都在 app/bot-runner.js 里 */
ipc('xuh:botStatus', () => botRunner.status());
ipc('xuh:botStart', () => botRunner.start());
ipc('xuh:botStop', () => botRunner.stop());
/* 一键重启（2026-11-14 主人令）：改完代码不用再关客户端重开，界面点一下就换新进程 */
ipc('xuh:botRestart', () => botRunner.restart());
ipc('xuh:botLog', n => botRunner.tail(n));
/* 常驻开关：关掉客户端后机器人继续跑（默认开） */
ipc('xuh:botKeepAlive', on => botRunner.setKeepAlive(on));
/* 左上角那张图（2026-11-05）：读 / 换 / 恢复默认 */
ipc('xuh:skin', () => call(() => ensureSkin()));
ipc('xuh:skinPick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选一张图放在左上角',
    buttonLabel: '用这张',
    defaultPath: fs.existsSync(STICKER_DIR) ? STICKER_DIR : UI_DIR,
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  const ext = (path.extname(src) || '.jpg').toLowerCase();
  if (!SKIN_EXTS.includes(ext)) return { error: '这个格式放不了，选 png / jpg / gif / webp' };
  try {
    const mb = fs.statSync(src).size / 1048576;
    if (mb > SKIN_MAX_MB) return { error: '图太大（' + mb.toFixed(1) + 'MB），换张小的' };
  } catch (e) { return { error: '读不到这个文件：' + e.message }; }
  const dest = path.join(UI_DIR, 'left' + ext);
  try {
    fs.mkdirSync(UI_DIR, { recursive: true });
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    // 换了扩展名会留下旧的那份，顺手清掉（只删 left.*，不碰别的）
    for (const f of fs.readdirSync(UI_DIR)) {
      if (/^left\./i.test(f) && f !== path.basename(dest)) {
        try { fs.unlinkSync(path.join(UI_DIR, f)); } catch {}
      }
    }
    uiCfgSave({ brandImg: 'left' + ext });
  } catch (e) { return { error: '存不下：' + e.message }; }
  log('[左上角图] 换成 ' + src);
  return skinState();
});
ipc('xuh:skinReset', () => {
  try {
    if (fs.existsSync(UI_DIR)) {
      for (const f of fs.readdirSync(UI_DIR)) {
        if (/^left\./i.test(f)) { try { fs.unlinkSync(path.join(UI_DIR, f)); } catch {} }
      }
    }
    uiCfgSave({ brandImg: '' });
  } catch (e) { return { error: e.message }; }
  const st = ensureSkin();
  log('[左上角图] 恢复默认');
  return st;
});
/* 自己调头图位置（2026-11-05）：只收取景位置这一项，别的字段一律不认，
 * 值必须形如 "35% 60%"，防止界面上手滑把配置写坏。 */
ipc('xuh:skinSet', patch => {
  const p = patch && typeof patch === 'object' ? patch : {};
  const allow = {};
  if (typeof p.pos === 'string' && /^\d{1,3}%\s+\d{1,3}%$/.test(p.pos.trim())) {
    const [x, y] = p.pos.trim().split(/\s+/).map(v => Math.max(0, Math.min(100, parseInt(v, 10))));
    allow.brandPos = x + '% ' + y + '%';
  }
  if (typeof p.opacity === 'number' && isFinite(p.opacity)) {
    allow.brandOpacity = Math.max(0.15, Math.min(1, p.opacity));
  }
  if (!Object.keys(allow).length) return { error: '这个值不接受' };
  uiCfgSave(allow);
  return skinState();
});
ipc('xuh:favor', (qq, v) => call(() => state().setFavor(qq, v)));
/* 学习系统（2026-11-09）：好感事件流水 / 手改分数 / 撤销一条。真身全在 src/learn，这里只转发 */
ipc('xuh:learn', () => call(() => state().learnView()));
ipc('xuh:learnSetFavor', (pid, v, why) => call(() => state().learnSetFavor(pid, v, why)));
ipc('xuh:learnRevoke', (pid, id, why) => call(() => state().learnRevoke(pid, id, why)));
// P1（2026-11-09）：每人三份档案 / 知识库 / 冷层，全在 src/learn，这里只转发
ipc('xuh:learnStyleGet', (pid) => call(() => state().learnStyleGet(pid)));
ipc('xuh:learnStyleSet', (pid, key, text) => call(() => state().learnStyleSet(pid, key, text)));
ipc('xuh:learnKbList', (pid) => call(() => state().learnKbList(pid)));
ipc('xuh:learnKbAdd', (pid, item) => call(() => state().learnKbAdd(pid, item)));
ipc('xuh:learnKbDel', (pid, id) => call(() => state().learnKbDel(pid, id)));
ipc('xuh:learnKbExport', (pid) => call(() => state().learnKbExport(pid)));
ipc('xuh:learnActs', (opt) => call(() => state().learnActs(opt)));
ipc('xuh:learnActsTopics', (opt) => call(() => state().learnActsTopics(opt)));
/* 导出某个人的知识库成 JSON（她 2026-11-09 要求「可导出 JSON」）。
 * 走系统保存对话框：她选哪就存哪，不往项目目录乱丢文件。 */
ipc('xuh:learnExport', async (pid, name) => {
  try {
    const data = call(() => state().learnKbExport(pid));
    if (!data || data.error) return data || { error: '导出失败' };
    const r = await dialog.showSaveDialog({
      title: '导出这个人的知识库',
      defaultPath: String(name || pid || 'knowledge') + '-知识库.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, file: r.filePath, count: data.count };
  } catch (e) { log('[IPC xuh:learnExport] ' + (e && e.stack || e)); return { error: String(e && e.message || e) }; }
});
ipc('xuh:person', (qq, f, v) => call(() => state().setPerson(qq, f, v)));
/* 多端互通：人物级操作（一个人物挂多个平台账号，共享一个好感度） */
ipc('xuh:personFavor', (pid, v) => call(() => state().personSetFavor(pid, v)));
ipc('xuh:personFavorLock', (pid, on) => call(() => state().personSetFavorLock(pid, on)));
ipc('xuh:personField', (pid, f, v) => call(() => state().personSetField(pid, f, v)));
ipc('xuh:personAddAccount', (pid, platform, id) => call(() => state().personAddAccount(pid, platform, id)));
ipc('xuh:personRemoveAccount', (pid, platform, id) => call(() => state().personRemoveAccount(pid, platform, id)));
ipc('xuh:personMerge', (intoPid, fromPid) => call(() => state().personMerge(intoPid, fromPid)));
ipc('xuh:personCreate', (name, platform, id) => call(() => state().personCreate(name, platform, id)));
ipc('xuh:trigAdd', (w, m, o) => call(() => state().trigAdd(w, m, o)));
ipc('xuh:trigDel', id => call(() => state().trigDel(id)));
ipc('xuh:trigToggle', (id, on) => call(() => state().trigToggle(id, on)));
ipc('xuh:switch', (k, on) => call(() => state().setSwitch(k, on)));
ipc('xuh:critic', p => call(() => state().setCritic(p)));
ipc('xuh:kwfuzzy', on => call(() => state().setKwFuzzy(on)));
ipc('xuh:num', (k, v) => call(() => state().setNum(k, v)));
/* 通用接口：表情包页要调十几个后端接口，全部转给面板的 handler 处理，不重写逻辑 */
ipc('xuh:api', async (method, url, body) => {
  try {
    const r = await state().apiCall(method, url, body);
    try { return JSON.parse(r.body); }
    catch { return { __raw: String(r.body || '').slice(0, 800), __code: r.code }; }
  } catch (e) { log('[API] ' + url + ' → ' + e.message); return { error: String(e && e.message || e) }; }
});
/* 攻略：客户端「攻略」页的增删改查都走 guides.api（不另写一套逻辑） */
const guides = require(path.join(ROOT, 'src', 'guides'));
ipc('xuh:guides', (action, payload) => call(() => guides.api(action, payload)));
/* 别人教的（2026-11-13）：攻略 / 学到的 / 教学条统一检索、单条核实、单条删除都走 kb.api */
const kb = require(path.join(ROOT, 'src', 'kb'));
ipc('xuh:kb', (action, payload) => call(() => kb.api(action, payload)));
/* 回话路径 ⑦⑧（2026-11-13）：三张表 / 两份喜好表 / 唯一 id，各走自己的 api，不重写逻辑 */
const replypath = require(path.join(ROOT, 'src', 'replypath'));
ipc('xuh:replypath', (action, payload) => call(() => replypath.api(action, payload)));
const tastecopy = require(path.join(ROOT, 'src', 'tastecopy'));
ipc('xuh:tastecopy', (action, payload) => call(() => tastecopy.api(action, payload)));
const tasteid = require(path.join(ROOT, 'src', 'tasteid'));
ipc('xuh:tasteid', (action, payload) => call(() => tasteid.api(action, payload)));
/* 查梗 / 娱乐网站：内联查 + 站目录都走 src/meme.js（bot 侧玩梗也用同一份） */
const meme = require(path.join(ROOT, 'src', 'meme'));
ipc('xuh:memeLookup', async term => {
  try { return await meme.lookup(term); } catch (e) { return { error: String(e && e.message || e) }; }
});
ipc('xuh:memeSites', () => { try { return meme.sites(); } catch (e) { return { error: String(e && e.message || e) }; } });
ipc('xuh:memeSitesSave', sites => { try { return meme.saveSites(sites); } catch (e) { return { error: String(e && e.message || e) }; } });

/* 词汇 · 本地词库（ci.json + 受限侧车 restricted.json）。
 * 列表每次按需读 ci.json 并过滤（~30万行，<100ms），不常驻内存；侧车很小直接读。
 * 标记只写 restricted.json，绝不碰 ci.json 本体（bot 靠 src/dict.js 读侧车做模型侧软约束）。 */
const DICT_DIR = path.join(__dirname, '..', 'src', 'data', 'dict');
let _dictArr = null, _dictStamp = 0, _restObj = null, _restStamp = 0;
function dictLoad() {
  const cp = path.join(DICT_DIR, 'ci.json');
  const cm = fs.existsSync(cp) ? fs.statSync(cp).mtimeMs : 0;
  if (!_dictArr || _dictStamp !== cm) { _dictStamp = cm; try { _dictArr = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch { _dictArr = []; } }
  const rp = path.join(DICT_DIR, 'restricted.json');
  const rm = fs.existsSync(rp) ? fs.statSync(rp).mtimeMs : 0;
  if (!_restObj || _restStamp !== rm) { _restStamp = rm; try { _restObj = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { _restObj = {}; } }
}
ipc('xuh:dictStats', () => {
  dictLoad();
  const rest = _restObj || {};
  return { ok: true, total: (_dictArr || []).length, restricted: Object.values(rest).filter(v => v && v.restricted).length };
});
// 用户单独词库（user-words.json）：主人的批量导入/新增都落这份，bot 运行时并入主词典。
// 注意：这份文件按主人令「之后禁止查看/编辑/删除」，由 IPC 在主人首次写入时惰性创建，我（助手）从不碰它。
function userWordsPath() { return path.join(DICT_DIR, 'user-words.json'); }
function loadUserWords() {
  try {
    const p = userWordsPath();
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter(e => e && typeof e.ci === 'string' && e.ci && typeof e.explanation === 'string');
  } catch { return []; }
}
// 批量导入 / 校验：解析纯文本或 JSON 数组，返回 {entries, errors}。不写文件。
function parseImport(text) {
  const raw = String(text || '');
  const entries = [], errors = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.words) ? j.words : null);
      if (list) {
        list.forEach((it, i) => {
          if (!it || typeof it !== 'object') { errors.push({ line: i + 1, msg: '不是对象' }); return; }
          const ci = typeof it.ci === 'string' ? it.ci.trim() : (typeof it.word === 'string' ? it.word.trim() : '');
          const ex = typeof it.explanation === 'string' ? it.explanation
            : (typeof it.mean === 'string' ? it.mean : (typeof it.释义 === 'string' ? it.释义 : ''));
          if (!ci) { errors.push({ line: i + 1, msg: '缺 ci/word 字段' }); return; }
          if (!ex) { errors.push({ line: i + 1, msg: '缺 explanation/释义 字段' }); return; }
          entries.push({ ci, explanation: ex.trim() });
        });
        return { entries, errors };
      }
    } catch { /* 不是合法 JSON，落到按行解析 */ }
  }
  // 按行解析：每行「词<Tab 或 ：或 : 或 ｜ 或 丨>释义」
  raw.split(/\r?\n/).forEach((ln, i) => {
    const s = ln.trim();
    if (!s) return;
    const m = s.match(/^(.+?)(?:[\t：:｜丨])(.+)$/);
    if (!m) { errors.push({ line: i + 1, msg: '无法拆出「词 + 释义」（需要 词 后接 Tab/：/:/｜/丨 再接释义）' }); return; }
    const ci = m[1].trim(), ex = m[2].trim();
    if (!ci || !ex) { errors.push({ line: i + 1, msg: '词或释义为空' }); return; }
    entries.push({ ci, explanation: ex });
  });
  return { entries, errors };
}

ipc('xuh:dictList', (opt) => {
  dictLoad();
  opt = opt || {};
  const source = opt.source || 'ci';
  if (source === 'user') {
    const q = String(opt.q || '').trim().toLowerCase();
    let rows = loadUserWords();
    if (q) rows = rows.filter(e => e.ci.toLowerCase().includes(q) || e.explanation.toLowerCase().includes(q));
    const total = rows.length;
    const offset = Math.max(0, opt.offset | 0), limit = Math.max(1, Math.min(500, opt.limit | 0) || 100);
    const slice = rows.slice(offset, offset + limit).map(e => ({
      ci: e.ci, explanation: String(e.explanation || '').replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
      restricted: false, reason: '', source: 'user', poly: String(e.explanation || '').includes('\n'),
    }));
    return { ok: true, total, rows: slice, restrictedTotal: 0 };
  }
  const q = String(opt.q || '').trim().toLowerCase();
  const ro = !!opt.restrictedOnly;
  const offset = Math.max(0, opt.offset | 0), limit = Math.max(1, Math.min(500, opt.limit | 0) || 100);
  const rest = _restObj || {};
  const restSet = new Set(Object.keys(rest).filter(k => rest[k] && rest[k].restricted));
  let rows = _dictArr || [];
  if (ro) rows = rows.filter(e => restSet.has(e.ci));
  else if (q) rows = rows.filter(e => String(e.ci).toLowerCase().includes(q) || String(e.explanation || '').toLowerCase().includes(q));
  const total = rows.length;
  const slice = rows.slice(offset, offset + limit).map(e => ({
    ci: e.ci, explanation: String(e.explanation || '').replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    restricted: restSet.has(e.ci),
    reason: (restSet.has(e.ci) && rest[e.ci] && rest[e.ci].reason) || '',
    source: 'ci',
    poly: !!(e.poly || String(e.explanation || '').includes('\n')),
  }));
  return { ok: true, total, rows: slice, restrictedTotal: restSet.size };
});
ipc('xuh:dictSetRestricted', (p) => {
  dictLoad();
  if (!p || !p.ci) return { error: '缺少 ci' };
  if (!_restObj) _restObj = {};
  const ci = p.ci;
  if (!_restObj[ci]) _restObj[ci] = {};
  if (p.restricted) {
    _restObj[ci].restricted = true;
    if (!_restObj[ci].flaggedBy) _restObj[ci].flaggedBy = 'user';
    _restObj[ci].at = new Date().toISOString();
    if (!_restObj[ci].reason) _restObj[ci].reason = '主人手动标记';
  } else {
    _restObj[ci].restricted = false;
  }
  const rp = path.join(DICT_DIR, 'restricted.json');
  fs.writeFileSync(rp, JSON.stringify(_restObj, null, 1), 'utf8');
  _restStamp = fs.statSync(rp).mtimeMs;
  return { ok: true, ci, restricted: !!p.restricted };
});
/* 编辑某词释义：source='ci' 写回 ci.json；source='user' 写回 user-words.json（惰性创建）。
 * 多行释义整体存；含换行即视为多义，标 poly。 */
ipc('xuh:dictSetExplanation', (p) => {
  if (!p || !p.ci) return { error: '缺少 ci' };
  const ci = p.ci;
  const explanation = String(p.explanation == null ? '' : p.explanation);
  if (p.source === 'user') {
    const up = userWordsPath();
    let arr = [];
    try { if (fs.existsSync(up)) { const a = JSON.parse(fs.readFileSync(up, 'utf8')); if (Array.isArray(a)) arr = a; } } catch { arr = []; }
    const idx = arr.findIndex(e => e && e.ci === ci);
    if (idx >= 0) arr[idx].explanation = explanation;
    else arr.push({ ci, explanation });
    fs.writeFileSync(up, JSON.stringify(arr, null, 1), 'utf8');
    return { ok: true, ci, source: 'user' };
  }
  // source === 'ci'：写回主词典（ci.json）
  dictLoad();
  const cp = path.join(DICT_DIR, 'ci.json');
  const arr = (_dictArr && Array.isArray(_dictArr)) ? _dictArr : JSON.parse(fs.readFileSync(cp, 'utf8'));
  const idx = arr.findIndex(e => e && e.ci === ci);
  if (idx < 0) return { error: '词库里没有这个词：' + ci };
  arr[idx].explanation = explanation;
  arr[idx].poly = explanation.includes('\n') || explanation.includes('；') || explanation.includes(';');
  fs.writeFileSync(cp, JSON.stringify(arr), 'utf8');
  _dictArr = arr; _dictStamp = fs.statSync(cp).mtimeMs;
  return { ok: true, ci, source: 'ci' };
});
/* 批量导入「仅校验」：解析文本，返回可导入条目数与错误行，不改任何文件。 */
ipc('xuh:dictImportCheck', (text) => {
  const r = parseImport(text);
  return { ok: true, entries: r.entries, errors: r.errors };
});
/* 批量导入：解析后惰性创建 user-words.json 并追加。多义默认不覆盖——同义（互相包含）才跳，不同则追加为第二义项。 */
ipc('xuh:dictImport', (text) => {
  const r = parseImport(text);
  if (r.errors.length) return { ok: false, errors: r.errors };
  const up = userWordsPath();
  let arr = [];
  try { if (fs.existsSync(up)) { const a = JSON.parse(fs.readFileSync(up, 'utf8')); if (Array.isArray(a)) arr = a; } } catch { arr = []; }
  let added = 0, appended = 0, skipped = 0;
  for (const e of r.entries) {
    const idx = arr.findIndex(x => x && x.ci === e.ci);
    if (idx >= 0) {
      const cur = arr[idx].explanation || '';
      if (cur.includes(e.explanation) || e.explanation.includes(cur)) { skipped++; continue; }
      arr[idx].explanation = cur + '\n' + e.explanation;
      appended++;
    } else { arr.push({ ci: e.ci, explanation: e.explanation }); added++; }
  }
  fs.writeFileSync(up, JSON.stringify(arr, null, 1), 'utf8');
  return { ok: true, added, appended, skipped, total: arr.length };
});
/* 删除「我的词」某条（只动 user-words.json，不碰主词典）。 */
ipc('xuh:dictDeleteUser', (p) => {
  if (!p || !p.ci) return { error: '缺少 ci' };
  const up = userWordsPath();
  if (!fs.existsSync(up)) return { ok: true, deleted: 0 };
  let arr = [];
  try { const a = JSON.parse(fs.readFileSync(up, 'utf8')); if (Array.isArray(a)) arr = a; } catch { return { error: '我的词文件读不出来' }; }
  const before = arr.length;
  arr = arr.filter(e => !(e && e.ci === p.ci));
  fs.writeFileSync(up, JSON.stringify(arr, null, 1), 'utf8');
  return { ok: true, deleted: before - arr.length };
});
ipc('xuh:openUrl', url => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { error: '只允许打开网页链接' };
  try { shell.openExternal(u); return { ok: true, url: u }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipc('xuh:openFile', rel => {
  const p = path.resolve(path.join(ROOT, 'src'), String(rel || ''));
  if (!p.startsWith(path.join(ROOT, 'src'))) return { error: '路径不对' };
  if (!fs.existsSync(p)) return { error: '找不到这个文件：' + rel };
  shell.openPath(p);
  return { ok: true, path: p };
});
ipc('xuh:openDir', which => {
  const map = {
    data: path.join(ROOT, 'src', 'data'),
    stickers: STICKER_DIR,
    persona: path.join(ROOT, 'src', 'persona'),
    ui: UI_DIR,
    root: ROOT,
  };
  const p = map[String(which || '')];
  if (!p) return { error: '没有这个目录' };
  shell.openPath(p);
  return { ok: true, path: p };
});
ipc('xuh:logPath', () => ({ ok: true, path: LOG_FILE }));

/* ===== 客户端发言（2026-11-23 主人令「客户端要能发图片视频文件」）=====
 * 只回本地路径 + 名字 + 大小：机器人和客户端在同一台机器上，文件不用走 HTTP 上传那一套。
 * 真正的「发给谁、怎么发」在 src/connectors/qq.js 的 injectClientMessage，这里只管挑文件。 */
ipc('xuh:pickFiles', kind => {
  const FILTERS = {
    image: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'] }],
    video: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv'] }],
    audio: [{ name: '语音', extensions: ['mp3', 'wav', 'm4a', 'amr', 'silk', 'flac', 'ogg', 'aiff', 'aac'] }],
    file: [{ name: '所有文件', extensions: ['*'] }],
  };
  const TITLE = { image: '选图片', video: '选视频', audio: '选语音', file: '选文件' };
  const k = String(kind || 'file');
  const r = dialog.showOpenDialogSync(win, {
    title: TITLE[k] || '选文件',
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS[k] || FILTERS.file,
  });
  if (!r || !r.length) return { ok: false, canceled: true, files: [] };
  const files = r.slice(0, 9).map(p => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    return { path: p, name: path.basename(p), size };
  });
  return { ok: true, files };
});
/* 贴图：Ctrl+V 时把剪贴板里的图落成临时文件，再按图片走同一条路 */
ipc('xuh:clipImage', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, error: '剪贴板里没有图片' };
    const png = img.toPNG();
    const p = path.join(app.getPath('temp'), 'xuh-clip-' + Date.now() + '.png');
    fs.writeFileSync(p, png);
    return { ok: true, path: p, name: path.basename(p), size: png.length };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
/* 聊天记录里的图 / 视频 / 语音点一下 → 用系统默认程序打开原文件（和 QQ 里点「打开」一样） */
ipc('xuh:openMedia', name => {
  const n = String(name || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!n) return { ok: false, error: '文件名不对' };
  const p = path.join(ROOT, 'src', 'data', 'client-media', n);
  if (!fs.existsSync(p)) return { ok: false, error: '文件不在了' };
  shell.openPath(p);
  return { ok: true, path: p };
});

/* ---------- 文件导览 → 唤起「命令方块」（2026-11-07 她定） ----------
 * 她说：「读写功能变成了命令方块，你只需要完善命令方块，虚幻客户端只要有入口调用，
 * 实现每个文件都能对应每个功能。」
 * 所以客户端不再自己实现读写（那是平行系统）：这里只做两件事——
 *   ① 按功能列出「这一页该改哪些文件」；② 点一下带她到命令方块里那一份原文。
 * 归属表（功能页↔源文件）只有 命令方块/归属表.json 一份，这里只读它，不复制第二份。 */
const FUNC_TABLE = path.resolve(ROOT, '..', '命令方块', '归属表.json');
const SRC_ROOT = path.join(ROOT, 'src');

/* 归属表里的路径相对 xuhuan mac（如 xuhbot/src/data/people.json），这里转成相对 src。
 * 落在 src 之外的（如 xuhbot/README.md）返回 null——客户端只管 src 里的运行数据。 */
function srcRel(p) {
  const abs = path.resolve(ROOT, '..', String(p || ''));
  const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

ipc('xuh:fileMap', () => {
  let table = null;
  try { table = JSON.parse(fs.readFileSync(FUNC_TABLE, 'utf8')); }
  catch (e) { return { error: '读不到归属表：' + e.message }; }
  const groups = [];
  for (const f of table.features || []) {
    const items = [];
    const seen = new Set();
    for (const p of f.files || []) {
      const s = String(p || '');
      if (s.endsWith('/')) {
        let ents = [];
        try { ents = fs.readdirSync(path.resolve(ROOT, '..', s), { withFileTypes: true }); } catch { continue; }
        for (const e of ents.slice().sort((x, y) => x.name.localeCompare(y.name, 'zh'))) {
          if (!e.isFile() || e.name.startsWith('.')) continue;
          const rel = srcRel(s + e.name);
          if (rel && !seen.has(rel)) { seen.add(rel); items.push({ rel, name: e.name }); }
        }
      } else {
        const rel = srcRel(s);
        if (rel && fs.existsSync(path.resolve(SRC_ROOT, rel)) && !seen.has(rel)) {
          seen.add(rel); items.push({ rel, name: path.basename(rel) });
        }
      }
    }
    groups.push({ view: String(f.view || ''), name: String(f.name || ''), note: String(f.note || ''), items });
  }
  return { ok: true, groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
});

/* ---------- 看原文 → 唤起「命令方块」 ----------
 * 2026-11-03 她定的：表情页的「看原文」不再丢给系统默认编辑器，改成在
 * 命令方块（只读的文件浏览器）里停在那一份原文上。
 *
 * 做法：命令方块.app 不认命令行参数，只认环境变量 COMMAND_BLOCK_HASH，
 * 所以直接跑 app 里的可执行文件、把 hash 传进环境。
 * hash 里的 path 是**相对命令方块当前扫描根**的（它自己 state.json 里记着），
 * 根默认是 xuhuan mac，正好把 xuhbot/src 包在里面；万一不在根里就退回系统默认程序。
 */
const http = require('http');
const CB_DIR = path.resolve(ROOT, '..', '命令方块');
const CB_APP = path.join(CB_DIR, '命令方块.app');
const CB_BIN = path.join(CB_APP, 'Contents', 'MacOS', '命令方块');
const CB_STATE = path.join(require('os').homedir(), 'Library', 'Application Support', 'CommandBlock', 'state.json');
const CB_PORT_FILE = path.join(require('os').homedir(), 'Library', 'Application Support', 'CommandBlock', 'port');

function cbRoot() {
  try {
    const st = JSON.parse(fs.readFileSync(CB_STATE, 'utf8'));
    if (st && typeof st.currentRoot === 'string' && st.currentRoot) return st.currentRoot;
  } catch { /* 没装过 / 读不到：用默认根 */ }
  return path.resolve(ROOT, '..');
}

// 向命令方块本地服务发一次 HTTP 请求（只走 127.0.0.1，短超时）
function cbHttp(method, port, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: route,
      method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(1500, () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

// 命令方块是 GUI app：已在运行时 open -a 只会把它的窗口置顶，不会开第二个
function cbActivate() {
  require('child_process').exec('open -a "' + CB_APP + '"', () => {});
}

ipc('xuh:cmdOpen', () => {
  if (!fs.existsSync(CB_BIN)) return { error: '没找到 命令方块.app（在 xuhuan mac/命令方块/ 里）' };
  cbActivate();
  return { ok: true };
});

ipc('xuh:cmdBlock', async (rel, line) => {
  const SRC = path.join(ROOT, 'src');
  const abs = path.resolve(SRC, String(rel || ''));
  if (abs !== SRC && !abs.startsWith(SRC + path.sep)) return { error: '路径不对' };
  if (!fs.existsSync(abs)) return { error: '找不到这个文件：' + rel };

  // 没有命令方块：别让按钮点了没反应，退回原来的「系统默认程序打开」
  if (!fs.existsSync(CB_BIN)) {
    shell.openPath(abs);
    return { ok: true, fallback: true, note: '没找到 命令方块.app，已用系统默认程序打开' };
  }

  /* 2026-11-13 修「点看原文不跳」：
   * 项目整棵树搬到了 外置卷，命令方块的 state.json 还指着 Documents/xuhuan mac
   * （旧副本）。原来算出 relToRoot = ../../Volumes/... → 判「不在根里」→ 只把窗口叫出来。
   * 现在：路径按真实路径比；根对不上就调 /api/root 把它的根切到项目树，再 focus。 */
  const realOr = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const relOf = root => {
    if (!root) return '';
    const r = path.relative(realOr(root), realOr(abs));
    return (r && !r.startsWith('..') && !path.isAbsolute(r)) ? r.split(path.sep).join('/') : '';
  };
  const lineNo = Math.floor(Number(line) || 0);
  const portInFile = () => {
    try { const s = fs.readFileSync(CB_PORT_FILE, 'utf8').trim(); return /^\d+$/.test(s) ? Number(s) : 0; }
    catch { return 0; }
  };
  // 根不一致就把命令方块的根切到项目树（只在真的对不上时切，平常不碰她的根）
  async function relWithFix(port) {
    let r = relOf(cbRoot());
    if (r) return r;
    const sw = await cbHttp('POST', port, '/api/root', { path: path.resolve(ROOT, '..') });
    if (!(sw.status === 200 && sw.json && sw.json.root)) return '';
    log('[命令方块] 根不一致，已切到 ' + path.resolve(ROOT, '..'));
    return relOf(path.resolve(ROOT, '..'));
  }

  // 先看命令方块是不是已经在跑：读端口文件 + 健康检查，命中就复用同一个窗口
  let port = 0;
  const pf = portInFile();
  if (pf) {
    const h = await cbHttp('GET', pf, '/api/health', null);
    if (h.status === 200 && h.json && h.json.ok) port = pf;
  }

  if (port) {
    const relPath = await relWithFix(port);
    if (!relPath) {
      cbActivate();
      return { ok: true, reused: true, note: '命令方块已在运行，但跳不过去（根目录不是项目树，切根也没成功）' };
    }
    const r = await cbHttp('POST', port, '/api/focus', { path: relPath, line: lineNo });
    cbActivate();
    if (r.status === 200 && r.json && r.json.ok) {
      log('[命令方块] 复用窗口跳转到 ' + rel);
      return { ok: true, reused: true, path: abs };
    }
    return { ok: true, reused: true, note: '命令方块已在运行，但没能跳转到该文件' };
  }

  // 没在跑：第一次启动，带 hash 唤起（保持原行为）
  const firstRel = relOf(cbRoot());
  const hash = firstRel
    ? '#/file?path=' + encodeURIComponent(firstRel) + (lineNo > 0 ? '&line=' + lineNo : '')
    : '';
  try {
    const child = require('child_process').spawn(CB_BIN, [], {
      env: Object.assign({}, process.env, { COMMAND_BLOCK_HASH: hash }),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log('[命令方块] 打开 ' + rel + (firstRel ? ' → ' + hash : '（根不一致，起来后切根再定位）'));
  } catch (e) {
    shell.openPath(abs);
    return { ok: true, fallback: true, note: '命令方块没起来（' + (e && e.message || e) + '），已用系统默认程序打开' };
  }
  // 根不一致时（hash 没带定位），等它起来 → 切根 → focus，最多 4 秒
  if (!firstRel) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const p = portInFile();
      if (!p) continue;
      const h = await cbHttp('GET', p, '/api/health', null);
      if (!(h.status === 200 && h.json && h.json.ok)) continue;
      const relPath = await relWithFix(p);
      if (relPath) await cbHttp('POST', p, '/api/focus', { path: relPath, line: lineNo });
      break;
    }
  }
  return { ok: true, hash: hash, path: abs, inRoot: !!firstRel };
});

/* ---------- 跳转提词器（ticiqi）----------
 * #9 更新说明 / #10 需求记录 这两个客户端视图已迁到提词器：只留跳转入口，不内嵌渲染。
 * renderer 传相对 ticiqi 的路径（或 'app' 启动、'cb:' 前缀指 CommandBlock 数据目录），
 * 主进程用 shell.openPath 打开，或 open -a 唤起 提词器.app。
 * 越界检查只允许 ticiqi 目录与 CommandBlock 数据目录，渲染进程够不到别处硬盘。 */
const TICIQI_DIR = path.resolve(ROOT, '..', 'ticiqi');
const TICIQI_APP = path.join(TICIQI_DIR, '提词器.app');
const CB_DATA = path.join(require('os').homedir(), 'Library', 'Application Support', 'CommandBlock');
ipc('xuh:ticiqiOpen', (target) => {
  const t = String(target || '');
  if (t === 'app') {
    if (!fs.existsSync(TICIQI_APP)) return { error: '没找到 提词器.app（应在 xuhuan mac/ticiqi/ 里）' };
    try { require('child_process').exec('open -a "' + TICIQI_APP + '"', () => {}); return { ok: true }; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }
  let abs;
  if (t.startsWith('cb:')) {
    abs = path.join(CB_DATA, t.slice(3));
  } else {
    abs = path.resolve(TICIQI_DIR, t);
    if (abs !== TICIQI_DIR && !abs.startsWith(TICIQI_DIR + path.sep)) return { error: '只能打开提词器目录内的文件' };
  }
  if (!fs.existsSync(abs)) return { error: '找不到：' + t };
  try { shell.openPath(abs); return { ok: true, path: abs }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});

/* ---------- B站弹幕存档 ----------
 * 陪玩服务（xuhuan mac/app/server.js）按天写 data/log/弹幕-YYYY-MM-DD.jsonl。
 * 客户端只读这些文件：不需要 8900 在跑，也不走网络。 */
const DM_DIR = path.resolve(__dirname, '..', '..', 'app', 'data', 'log');
function dmFileOf(dateStr) {
  const s = String(dateStr || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return path.join(DM_DIR, '弹幕-' + s + '.jsonl');
}
ipc('xuh:dmDays', () => {
  try {
    const days = fs.readdirSync(DM_DIR)
      .map(f => (/^弹幕-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f) || [])[1])
      .filter(Boolean).sort().reverse();
    return { ok: true, days, dir: DM_DIR };
  } catch (e) {
    return { ok: true, days: [], dir: DM_DIR, note: '还没有弹幕记录（陪玩没接到弹幕时这个目录会是空的）' };
  }
});
ipc('xuh:dmRead', (date, limit) => {
  const fp = dmFileOf(date);
  if (!fp) return { error: '日期格式不对，要 YYYY-MM-DD' };
  if (!fs.existsSync(fp)) return { ok: true, date, total: 0, items: [] };
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  const n = Math.min(Math.max(Number(limit) || 800, 1), 5000);
  const items = [];
  for (const ln of lines.slice(-n)) {
    try { items.push(JSON.parse(ln)); } catch { /* 坏行跳过 */ }
  }
  return { ok: true, date, total: lines.length, items };
});
ipc('xuh:dmDir', () => {
  try { fs.mkdirSync(DM_DIR, { recursive: true }); shell.openPath(DM_DIR); return { ok: true, dir: DM_DIR }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});

/* ---------- B站「评论区召唤」状态 ----------
 * 2026-11-19 主人令：xuhbot 的 B站连接器（含评论区召唤监听）是失效旧代码，已删。
 * B站的回复由 AstrBot 的 astrbot_plugin_bilibili_ai_bot 负责，xuhbot 不再写这份状态。
 * 这里保留 IPC 只为客户端不报错，返回一句实话；要彻底拿掉这块界面随时可删。 */
ipc('xuh:biliMention', () => ({
  ok: true, enabled: false,
  state: '已下线：B站由 AstrBot 负责回复，xuhbot 不再跑召唤监听',
  triggers: [],
}));

/* ---------- 菜单 ---------- */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: '虚幻', submenu: [
      { label: '刷新数据', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.send('xuh:reload') },
      { label: '打开表情包目录', click: () => shell.openPath(STICKER_DIR) },
      { label: '打开数据目录', click: () => shell.openPath(path.join(ROOT, 'src', 'data')) },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ]},
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ]},
    { label: '视图', submenu: [
      { role: 'toggleDevTools', label: '开发者工具' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------- 生命周期 ---------- */
app.whenReady().then(() => {
  // B站图片防盗链：头像/视频封面/动态配图都是 i*.hdslb.com 的直链，
  // Electron 从 file:// 加载时 Referer 为空 → CDN 返回 403 → 图片全不显示。
  // 只给 B站图片域补上 bilibili.com 的 Referer，其它请求不动（2026-11-19 修）。
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*.hdslb.com/*', '*://*.biliimg.com/*', '*://*.bilibili.com/*'] }, (details, cb) => {
      const headers = details.requestHeaders || {};
      if (!headers['Referer'] && !headers['referer']) headers['Referer'] = 'https://www.bilibili.com/';
      cb({ requestHeaders: headers });
    });
  } catch (e) { console.error('[img] B站图片 Referer 补丁失败:', e.message); }
  protocol.handle('xuh', async req => {
    const u = new URL(req.url);
    let full = null;
    if (u.hostname === 'stickers') {
      full = resolveSticker(u.pathname);
    } else if (u.hostname === 'skin') {
      // 左上角那张图：只认 src/data/ui/ 下的一层文件名
      full = skinPath(decodeURIComponent(u.pathname).replace(/^[/\\]+/, ''));
      if (full && !fs.existsSync(full)) full = null;
    } else if (u.hostname === 'avatar') {
      // 群友 / 主人的头像：xuh://avatar/<平台>/<号>（qq/1000000002、bili/30895294）。
      // 老写法 xuh://avatar/<QQ号> 仍然认（当 qq），老界面不会突然全变剪影。
      // 先读缓存，没有才按需去官方公开地址取一次；拿不到返回 404，CSS 退回剪影。
      // 不建整库、不装包、不走网页逆向；缓存文件和机器人侧用的是同一份。
      const seg = decodeURIComponent(u.pathname).replace(/^[/\\]+/, '').split('/').filter(Boolean);
      const avPlat = seg.length >= 2 ? seg[0] : 'qq';
      const avId = seg.length >= 2 ? seg.slice(1).join('/') : (seg[0] || '');
      if (avPlat === 'group') {
        // 群头像：xuh://avatar/group/<群号>（2026-11-07 加，qq-meta 里那份缓存，不另存一份）
        full = qmeta.groupCached(avId);
        if (!full) { try { full = await qmeta.groupFetch(avId); } catch {} }
      } else {
        full = qmeta.avatarCached(avId, avPlat);
        if (!full) { try { full = await qmeta.avatarFetch(avId, avPlat); } catch {} }
      }
    } else if (u.hostname === 'media') {
      /* 客户端自己发的图/视频/语音（2026-11-23）：存在 src/data/client-media/，
       * 聊天记录里靠 ［媒体:文件名］ 标记来这儿取。只认一层文件名，带斜杠或 .. 一律拒。 */
      const name = decodeURIComponent(u.pathname).replace(/^[/\\]+/, '');
      if (name && !/[/\\]|\.\./.test(name)) {
        const p = path.join(ROOT, 'src', 'data', 'client-media', name);
        try { if (fs.statSync(p).isFile()) full = p; } catch {}
      }
    } else {
      return new Response('not found', { status: 404 });
    }
    if (!full) return new Response('not found', { status: 404 });
    // 直接读文件返回：比 net.fetch(file://) 少一层网络栈，图多的时候更稳
    const ext = path.extname(full).toLowerCase();
    const MIME = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.amr': 'audio/amr',
      '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.pdf': 'application/pdf',
    };
    let mime = MIME[ext] || 'image/jpeg';
    try {
      const buf = fs.readFileSync(full);
      // 头像存成 .jpg，但 QQ 返回的可能是 PNG/GIF；按文件头认，别让浏览器拿到错的 type
      if (u.hostname === 'avatar') {
        if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
        else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
        else mime = 'image/jpeg';
      }
      return new Response(buf, { headers: { 'content-type': mime, 'cache-control': 'no-cache' } });
    } catch (e) {
      return new Response('read error', { status: 500 });
    }
  });

  log('[客户端] 启动 | ROOT=' + ROOT + ' | electron=' + process.versions.electron);

  buildMenu();
  createWindow();

  /* 客户端一起来就把机器人拉起来（她 2026-11-05 定「优先做让机器人跑起来的转移」）。
   * 已经有一个在跑（比如终端窗口开着的）→ 只接管显示，不动那个进程，也不会开第二个。 */
  try {
    const r = botRunner.start();
    log('[机器人] 自动启动：' + JSON.stringify(r));
    // 看护（2026-11-06 加）：客户端开着期间每 15 秒看一眼，掉线就拉起来。
    // 之前只有「自己 spawn 的」有 exit 重启；接管别人的那份崩了就没人管，她说的 7×24 常驻是假的。
    const w = botRunner.watch(true);
    log('[机器人] 看护：' + JSON.stringify(w));
  } catch (e) { log('[机器人] 自动启动失败：' + (e && e.message || e)); }

  app.on('activate', () => { if (!win) createWindow(); });
});

/* 关客户端 = 机器人一起停（跟原来「关掉那个终端窗口就下线」一个意思）。
 * 只停客户端自己拉起来的；终端窗口开的那个不碰。 */
let quitting = false;
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  try { botRunner.watch(false); } catch {}     // 先关看护，免得退出过程中又被拉起来
  try { botRunner.shutdown(); } catch (e) { log('[机器人] 退出时停机失败：' + (e && e.message || e)); }
});

app.on('window-all-closed', () => app.quit());
