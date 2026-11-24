/*
 * public/sticker-page.js — 表情包管理页（面板与客户端共用这一份）
 *
 * 2026-11-03 从 panel-client.js 第 2644~3555 行**整段搬出**，渲染逻辑一行没改。
 * 搬的原因：客户端要做自己的表情包页，但功能一个都不能少（改描述、改图名、
 * 拖类别、情绪表、场合表、维护、生成清单……）。与其重写一遍再慢慢补，
 * 不如让两边用同一份代码。
 *
 * 用法（浏览器里全局挂 window.StickerPage）：
 *   StickerPage.mount(容器DOM, {
 *     el, toast,          // 建节点 / 提示
 *     api, POST,          // GET / POST 后端接口（面板走 fetch，客户端走 IPC）
 *     rerender,           // 整页重画
 *     openRaw,            // 打开某个文件的原文
 *   });
 *
 * 用到的后端接口（panel.js 全都有，客户端用假 req/res 直接调同一个 handler）：
 *   GET  /api/stickers  /api/stickers/maint
 *   POST /api/stickers/commit|promptlist|rename|maint|bili  /api/raw  /api/cfgset
 */
(function () {
'use strict';

/* 由 mount() 注入，名字和面板里完全一致 —— 所以下面这段原代码一个字都不用改 */
var el, toast, api, POST, renderContent, openRaw;
/* 浮层挂哪儿（2026-11-07 修）：以前一律 appendChild 到 body，
 * 但样式全写在 .sp-scope 作用域里（连 --tx2 这些变量都在里面），
 * 于是浮层既拿不到定位、也拿不到颜色 —— 图按 1080×2388 原尺寸排在页面底下，
 * 这看起来就是「点开大图只有半大 / 像坏了」。现在挂进 .sp-scope 容器里。 */
function scopeHost() {
  return document.querySelector('.sp-scope') || document.body;
}
/* 客户端顶栏已经有「表情包」这个标题了，再画一遍 crumb + h1 纯属占地方（她 2026-11-07 说版头太占空间）。
 * 面板那边没有顶栏标题，还得留着，所以用开关控制：mount 时传 hideHead: true。 */
var HideHead = false;
/* 面板时代这是「标签页对象」，存 _emoRows/_gRows/rawMode 这些临时状态。
 * 客户端没有标签页，就给它一个常驻空对象，行为一样。 */
var T = {};

/* ---------- 表情功能面板（v88，主人 2026-10-23 定）----------
 * 主人原话：「我能在面板里看到【情绪表情.json】文件，但无法在面板里直接修改它。」
 * 所以点「人设 → 情绪表情.json」不再是 JSON 原文框，直接是这一页：
 *   ① 情绪 → 触发词：纯情绪的话命中哪些词、单发哪张图（存回 情绪表情.json）
 *   ② 常用表情单：名字 → 什么场合用（存回 data/stickers/常用.md，表头原样保留）
 *   ③ 顶上实时状态：写了单子却没图 / 情绪没同名图 / 有图没写场合 —— 「改了没反应」只有这三种原因，都摆出来
 * 存盘仍走 /api/raw（JSON 校验照旧拦），所以改不坏；想碰原文点「改 JSON 原文」切回原文框。
 * 生效时间：她每 60 秒重读一次表情配置（emoMap 的缓存），不用重启。
 */
var STICKER_EMO_ID = 'data/情绪表情.json';
// 2026-10-31：两张场合表合并进 常用.md（一行一类，描述在前），普通-场合.json 已停用
var STICKER_MD_ID = 'data/stickers/常用.md';
var STK = null;                       // {imgs, occ, emo, md, missing, noOcc, noImg}
function loadStickers() {
  return api('/api/stickers').then(function (r) { if (r && !r.error) STK = r; return STK; });
}
function stkWords(s) {
  return String(s == null ? '' : s).split(/[、,，\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
}
function renderStickerPanel(t, box) {
  /* 2026-11-07 主人定：这个页拆成两个视图（表情包 / 情绪书），
   * 切换只换内容区，不影响各自的状态。 */
  var tabV = window.__stkTab || 'pack';
  var tabBar = el('div', 'stk-tabs');
  var mkTab = function (id, name) {
    var b = el('button', 'stk-tab' + (tabV === id ? ' on' : ''), name);
    b.onclick = function () { window.__stkTab = id; renderContent(); };
    tabBar.appendChild(b);
  };
  mkTab('pack', '表情包');
  mkTab('book', '情绪书');
  box.appendChild(tabBar);
  if (tabV === 'book') {
    var wrapBook = el('div', 'eb-wrap');
    box.appendChild(wrapBook);
    if (window.EmotionBook) window.EmotionBook.mount(wrapBook);
    else wrapBook.appendChild(el('div', 'empty', '情绪书脚本没加载上（public/emobook-page.js）'));
    return;
  }
  if (!HideHead) {
    box.appendChild(el('div', 'crumb')).appendChild(el('b', null, '人设'));
    box.appendChild(el('h1', 'pg', '情绪表情（表情功能）'));
  }
  if (!STK) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingStk) {
      window.__loadingStk = 1;
      loadStickers().then(function () { window.__loadingStk = 0; renderContent(); })
        .catch(function (e) { window.__loadingStk = 0; toast('读不了表情数据：' + ((e && e.message) || '')); });
    }
    return;
  }
  var imgs = STK.imgs || [], emo = STK.emo || [];
  var groups = STK.groups || [];              // 一行一类：[{desc, names, alive, auto, pool}]
  var unfiled = STK.unfiled || [];            // 还没进表的图
  var pools = STK.pools || {};
  /* —— 提示词清单（2026-11-01 主人定：另开文件、提示词只读它）——
   * 以前表情清单是每轮在代码里现拼的：家族合并、描述只留 4 段、普通池只抽 20 条、关键词只列 20 张。
   * 结果她在面板看到 164 行、提示词里只有 42 行 ——「和实际功能完全不一样」。
   * 现在生成一份真文件 data/stickers/清单.md，提示词直接读它；这一条就是它的状态。 */
  var pr = STK.prompt || null;
  var openPromptList = function () {
    var lb = el('div', 'sk-lb sk-pv');
    var sheet = el('div', 'sk-pvc');
    sheet.appendChild(el('div', 'sk-pvt', '提示词清单（她每轮看到的就是这一份）'));
    var pre = el('pre', 'sk-pvb');
    pre.textContent = pr && pr.text ? pr.text : '（还没生成，点「↻ 重生成」）';
    sheet.appendChild(pre);
    sheet.appendChild(el('div', 'sk-pvf', '文件在 data/stickers/清单.md —— 这是生成物，手改会在下次重建时被覆盖；要改内容请改上面的「一行一族」表。'));
    var bClose = el('button', 'sk-tool', '关掉');
    bClose.onclick = function () { if (lb.parentNode) lb.remove(); document.removeEventListener('keydown', onEsc); };
    sheet.appendChild(bClose);
    var onEsc = function (e) { if (e.key === 'Escape') bClose.onclick(); };
    lb.onclick = function (e) { if (e.target === lb) bClose.onclick(); };
    document.addEventListener('keydown', onEsc);
    lb.appendChild(sheet);
    scopeHost().appendChild(lb);
  };
  if (pr && pr.file) {
    var pbar = el('div', 'sk-ptb');
    var when = pr.at ? new Date(pr.at) : null;
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    var whenTxt = when ? (p2(when.getMonth() + 1) + '-' + p2(when.getDate()) + ' ' + p2(when.getHours()) + ':' + p2(when.getMinutes())) : '还没生成';
    pbar.appendChild(el('span', 'sk-ptx', pr.exists
      ? ('提示词读的就是这份：' + pr.rows + ' 行 · ' + pr.chars + ' 字 · 覆盖 ' + pr.total + ' 张 · ' + whenTxt + ' 生成')
      : '还没生成过，点右边「重生成」会按上面的表做一份'));
    if (pr.pending && pr.pending.length) {
      var bWarn = el('span', 'sk-cnt off', '表里有 ' + pr.pending.length + ' 个名字库里没有');
      bWarn.title = '这些名字写了但没有同名图，发不出去：' + pr.pending.join('、');
      pbar.appendChild(bWarn);
    }
    var bRe = el('button', 'sk-tool sm', '↻ 重生成');
    bRe.title = '改完上面的表、或往文件夹丢进新图之后点一下。平时不用点 —— 表和图一变，下次对话她会自己重建';
    bRe.onclick = function () {
      bRe.disabled = true;
      var old = bRe.textContent;
      bRe.textContent = '生成中…';
      fetch('/api/stickers/promptlist', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '失败');
          toast('清单已重生成：' + j.rows + ' 行 · ' + j.chars + ' 字');
          STK = null; renderContent();
        })
        .catch(function (e) {
          toast('重生成失败：' + ((e && e.message) || ''));
          bRe.disabled = false; bRe.textContent = old;
        });
    };
    var bSee = el('button', 'sk-tool sm', '看原文');
    bSee.title = '看提示词里真正写的是什么（只读）';
    bSee.onclick = openPromptList;
    pbar.appendChild(bRe); pbar.appendChild(bSee);
    box.appendChild(pbar);
  }
  // 名字去掉 q 前缀和结尾编号：「q害怕3」→「害怕」（和 core.js 的 stickerStem 同一套规则）
  var stkStem = function (n) { return String(n == null ? '' : n).replace(/^[qQ]/, '').replace(/\d+$/, ''); };
  // 能发出这张图的文件：一字不差，或者同情绪带编号的（情绪写「害怕」、库里有 q害怕1~4 也算有图）
  var hitFiles = function (n) {
    if (!n) return [];
    var w = String(n);
    return imgs.filter(function (f) { var b = f.split('/').pop(); return b === w || stkStem(b) === w; });
  };
  var has = function (n) { return hitFiles(n).length > 0; };
  var cmn = pools.common || 0;
  // —— 页面摘要（2026-11-01 重排）——
  // 原来这里是一大段说明文字压在表格上面；现在收成一行小标签。
  // 原文一句没删，挪到页尾「这些规则是怎么定的（点开看）」里。
  // 图地址：面板走 /api/stkimg；客户端没有 HTTP 服务，改成自己注册的协议（StickerPage.imgUrl）
  var stkImgUrl = function (n) {
    var q = String(n == null ? '' : n);
    if (window.StickerPage && window.StickerPage.imgUrl) return window.StickerPage.imgUrl(q);
    return '/api/stkimg?n=' + encodeURIComponent(q);
  };
  var folderOf = function (n) {
    var s = String(n == null ? '' : n);
    var i = s.indexOf('/');
    return i > 0 ? s.slice(0, i) + '/' : '根目录';
  };
  /* ===== 看图浮层（2026-11-07 重做，主人第 1 条「优化表情包的看图页面」）=====
   * 原来只有一个大图 + 一行「点一下关掉」：想知道这张叫什么、在哪个文件夹、能不能删，
   * 都得退出去再找一遍。现在：
   *   · 大图铺满（88vw）
   *   · 底部一条：图名 · 第 3/12 张 · 在「少用/」
   *   · ‹ › 翻同一批的上一张/下一张（键盘 ← → 也行）
   *   · 改名 / 删图（同一个确认层） / 关掉
   * 点背景关、Esc 关；点图本身不关（以前一点就没了，想看清楚反而容易误关）。 */
  var openLb = function (n, list) {
    // 表里写的常常是裸名（q无语），真实位置得现查文件夹 —— 底部那条要显示「在 少用/」
    var resolveRel = function (x) { var h = hitFiles(x); return (h && h[0]) || String(x); };
    var arr = (list && list.length) ? list.slice() : [String(n)];
    var at = arr.indexOf(String(n));
    if (at < 0) { arr.unshift(String(n)); at = 0; }
    var lb = el('div', 'sk-lb');
    var stage = el('div', 'sk-lbv');
    var im = document.createElement('img');
    im.alt = String(arr[at]);
    /* 2026-11-07 主人：「点击看大图就半大，不要铺满」——
     * 以前只写了 max-width/max-height，图本身小（160×160 那种）就按原尺寸显示，看着是「半大」。
     * 现在按窗口比例放大到 62vw / 72vh（够大、又不铺满），大图不动（CSS 的 max 已经管住）。 */
    im.onload = function () {
      try {
        var nw = im.naturalWidth || 0, nh = im.naturalHeight || 0;
        if (!nw || !nh) return;
        var k = Math.min(window.innerWidth * 0.62 / nw, window.innerHeight * 0.72 / nh);
        if (k > 1) { im.style.width = Math.round(nw * k) + 'px'; im.style.height = 'auto'; }
        else { im.style.width = ''; im.style.height = ''; }
      } catch (e) {}
    };
    stage.appendChild(im);
    lb.appendChild(stage);

    var barEl = el('div', 'sk-lbbar');
    var info = el('div', 'sk-lbinfo');
    var nm = el('div', 'sk-lbnm');
    var meta = el('div', 'sk-lbmeta');
    info.appendChild(nm); info.appendChild(meta);
    barEl.appendChild(info);

    var tools = el('div', 'sk-lbt');
    var bPrev = el('button', 'sk-tool sm', '‹');
    bPrev.title = '上一张（← 键）';
    var bNext = el('button', 'sk-tool sm', '›');
    bNext.title = '下一张（→ 键）';
    var bRn = el('button', 'sk-tool sm', '改名');
    bRn.title = '改磁盘上的真文件名（图名就是提示词里用的名字）';
    var bDel = el('button', 'sk-tool sm danger', '删掉');
    bDel.title = '把这张图删掉（挪进 回收站/，场合表里也一起去掉）';
    var bX = el('button', 'sk-tool sm', '关掉');
    bX.title = '关掉（Esc）';
    [bPrev, bNext, bRn, bDel, bX].forEach(function (b) { tools.appendChild(b); });
    barEl.appendChild(tools);
    lb.appendChild(barEl);

    var show = function (i) {
      if (i < 0) i = 0;
      if (i > arr.length - 1) i = arr.length - 1;
      at = i;
      var raw = String(arr[at]);
      var cur = resolveRel(raw);
      im.src = stkImgUrl(cur);
      im.alt = raw;
      nm.textContent = raw.split('/').pop();
      meta.textContent = (arr.length > 1 ? '第 ' + (at + 1) + ' / ' + arr.length + ' 张 · ' : '')
        + '在「' + folderOf(cur) + '」' + (cur.indexOf('/') > 0 ? '（' + cur + '）' : '');
      bPrev.disabled = at <= 0;
      bNext.disabled = at >= arr.length - 1;
    };
    var onKey = function (e) {
      if (e.key === 'Escape') shut();
      else if (e.key === 'ArrowLeft') { if (at > 0) show(at - 1); }
      else if (e.key === 'ArrowRight') { if (at < arr.length - 1) show(at + 1); }
    };
    var shut = function () {
      if (lb.parentNode) lb.remove();
      document.removeEventListener('keydown', onKey);
    };
    bPrev.onclick = function () { if (at > 0) show(at - 1); };
    bNext.onclick = function () { if (at < arr.length - 1) show(at + 1); };
    bX.onclick = shut;
    bRn.onclick = function () { var cur = resolveRel(String(arr[at])); shut(); openRename(cur); };
    bDel.onclick = function () {
      var cur = resolveRel(String(arr[at]));
      // 删完整页重画，浮层直接收掉（不留在旧数据上翻页）
      askDel(cur, shut);
    };
    lb.onclick = function (e) { if (e.target === lb) shut(); };
    document.addEventListener('keydown', onKey);
    scopeHost().appendChild(lb);
    show(at);
  };
  /* ===== 删图确认（2026-11-07 主人第 2 条：「点叉做成删图」）=====
   * 她点的那个叉以前只是「从这一类里拿掉」，图还在，所以她找不到了还以为删了。
   * 现在叉就是删图：先给她看清楚是哪一张（缩略图 + 名字），再说清后果，点一下才真删。
   * 删的是磁盘上的文件，但挪进 回收站/ 而不是直接抹掉 —— 手滑还能捡回来。 */
  var askDel = function (rel, onDone) {
    var bare = String(rel == null ? '' : rel).split('/').pop();
    var layer = el('div', 'sk-rd');
    var card = el('div', 'sk-rdc sk-delc');
    card.appendChild(el('div', 'sk-rdt', '删掉这张图？'));
    var row = el('div', 'sk-rdrow');
    var pv = el('div', 'sk-rdp');
    var im = document.createElement('img');
    im.src = stkImgUrl(rel); im.alt = bare;
    pv.appendChild(im);
    row.appendChild(pv);
    var col = el('div');
    col.style.cssText = 'flex:1;min-width:0';
    col.appendChild(el('div', 'sk-rdold', '「' + bare + '」　·　在 ' + folderOf(rel)));
    col.appendChild(el('div', 'sk-deltip', '图不会直接抹掉：会挪进 data/stickers/回收站/，想找回来还能找到。'
      + '场合表里这个名字也一起去掉（那一类还有别的图就留着）。情绪表不动 —— 以后再放一张同名图，它自己接上。'));
    row.appendChild(col);
    card.appendChild(row);
    var err = el('div', 'sk-rderr', '');
    card.appendChild(err);
    var bar2 = el('div', 'sk-rdbar');
    var bNo = el('button', 'sk-tool', '不删了');
    var bYes = el('button', 'sk-tool sk-delbtn', '删掉这张图');
    bar2.appendChild(bNo); bar2.appendChild(bYes);
    card.appendChild(bar2);
    layer.appendChild(card);

    var shut = function () {
      if (layer.parentNode) layer.remove();
      document.removeEventListener('keydown', onKey2);
    };
    var onKey2 = function (e) { if (e.key === 'Escape') shut(); };
    bNo.onclick = shut;
    bYes.onclick = function () {
      bYes.disabled = true; bYes.textContent = '删中…'; err.textContent = '';
      POST('/api/stickers/delete', { name: String(rel) }).then(function (r) {
        if (!r || r.error) {
          err.textContent = (r && r.error) || '没删成';
          bYes.disabled = false; bYes.textContent = '删掉这张图';
          return;
        }
        shut();
        toast(r.msg || ('已删「' + bare + '」'));
        STK = null;
        if (onDone) onDone();
        renderContent();
      }).catch(function () {
        err.textContent = '没删成，再试一次';
        bYes.disabled = false; bYes.textContent = '删掉这张图';
      });
    };
    layer.onclick = function (e) { if (e.target === layer) shut(); };
    card.onclick = function (e) { e.stopPropagation(); };
    document.addEventListener('keydown', onKey2);
    scopeHost().appendChild(layer);
  };
  /* 改图片名（2026-11-01 主人：「能在面板直接改图片名」）
   * 改的是**磁盘上的真文件名** —— 图名同时就是提示词、[表情:名字] 里用的那个名字，所以只能改文件。
   * 弹窗自绘（不用浏览器原生 prompt/confirm）；保存后整页重画，两张表都会带上新名字。*/
  var openRename = function (rel) {
    var bare = String(rel == null ? '' : rel).split('/').pop();
    var layer = el('div', 'sk-rd');
    var card = el('div', 'sk-rdc');
    card.appendChild(el('div', 'sk-rdt', '改图片名'));
    var row = el('div', 'sk-rdrow');
    var pv = el('div', 'sk-rdp');
    var im = document.createElement('img');
    im.src = stkImgUrl(rel); im.alt = bare;
    pv.appendChild(im);
    row.appendChild(pv);
    var col = el('div');
    col.style.cssText = 'flex:1;min-width:0';
    col.appendChild(el('div', 'sk-rdold', '现在叫：' + bare));
    var inp = document.createElement('input');
    inp.className = 'sk-rdin'; inp.value = bare;
    col.appendChild(inp);
    row.appendChild(col);
    card.appendChild(row);
    card.appendChild(el('div', 'sk-rdtip', '改的是磁盘上真正的文件名 —— 图名同时就是提示词里、[表情:名字] 里用的那个名字。'
      + '改完 ② 场合表里那一行会自动跟着改，① 情绪表同名的那条也会跟着改，你不用手碰文件。'
      + '名字里不能有 / \\ : * ? " < > |，回车保存、Esc 取消。'));
    var err = el('div', 'sk-rderr', '');
    card.appendChild(err);
    var bar = el('div', 'sk-rdbar');
    var bNo = el('button', 'sk-tool', '取消');
    var bYes = el('button', 'sk-tool on', '改这个名');
    bar.appendChild(bNo); bar.appendChild(bYes);
    card.appendChild(bar);
    layer.appendChild(card);

    var shut = function () {
      if (layer.parentNode) layer.remove();
      document.removeEventListener('keydown', onKey);
    };
    var doSave = function () {
      var to = String(inp.value || '').trim();
      if (!to) { err.textContent = '新名字不能是空的'; return; }
      if (to === bare) { err.textContent = '和原来一样，没有改'; return; }
      bYes.disabled = true; bYes.textContent = '改中…'; err.textContent = '';
      POST('/api/stickers/rename', { from: String(rel), to: to }).then(function (r) {
        if (!r || r.error) {
          err.textContent = (r && r.error) || '没改成';
          bYes.disabled = false; bYes.textContent = '改这个名'; return;
        }
        shut(); toast(r.msg || ('已改成「' + to + '」'));
        STK = null; renderContent();          // 整页重画：两张表都拿新名字
      }).catch(function () {
        err.textContent = '没改成，再试一次';
        bYes.disabled = false; bYes.textContent = '改这个名';
      });
    };
    var onKey = function (e) {
      if (e.key === 'Escape') shut();
      if (e.key === 'Enter' && document.activeElement === inp) doSave();
    };
    bNo.onclick = shut;
    bYes.onclick = doSave;
    layer.onclick = function (e) { if (e.target === layer) shut(); };
    card.onclick = function (e) { e.stopPropagation(); };
    document.addEventListener('keydown', onKey);
    scopeHost().appendChild(layer);
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  };
  /* —— 顶部数字条（2026-11-07 压缩：原来每个 chip 都带「张 · 权重 48」这种长后缀，
   * 十个 chip 占掉两行还多。现在 chip 里只留名字 + 数字，单位/权重全塞进悬停说明。
   * 对账那三个数也不再单独占一行，直接跟在后面，用小竖线隔开。 —— */
  var chipRow = el('div', 'sk-sum sk-sum-lite');
  var chip = function (name, n, cls, title) {
    var c = el('span', 'sk-chip' + (cls ? ' ' + cls : ''));
    c.appendChild(document.createTextNode(name));
    c.appendChild(el('b', null, String(n)));
    if (title) c.title = title;
    chipRow.appendChild(c);
    return c;
  };
    chip('常用', cmn, '', '她自己想添一张表情时，最常从这一池里挑 · 权重 48 · 单位：张');
    chip('虚幻', pools.self || 0, '', '虚幻形象的表情包 · 与「常用」同级，同属 main 池（权重 48）· 发哪张按 常用.md 的场合行');
  chip('可用', pools.usable || 0, '', '你发给她的图会收进这里 · 权重 6');
  chip('关键词触发', pools.kw || 0, '', '图名本身就是触发词：群里谁提到这个名（或说一半）就发这张。只有放进「关键词触发/」文件夹才算');
  chip('少用', pools.low || 0, '', '所有新图都写这里（AstrBot 落盘 + QQ 收图）。根目录已不再收发。清单里只有非 q 名的那部分算一族、占 1 行');
  chip('普通', pools.normal || 0, '', '少用/ 里名字 q 开头的情绪图，和少用同属普通池（权重 1）');
  chip('场合', groups.length, '', '场合表里一共几类（就是下面 ②）· 单位：类');

  // 对账结果（2026-10-31 主人第 8 条指定的三个数）
  //   pureDesc   纯描述 = 这一类的图名在库里一个都找不到（**可以单独留着，不删**）
  //   classified 已分类 = 表里有描述、图也在库里的张数
  //   needDesc   需描述 = 情绪类没进表、自动补也补不出来。正常恒为 0，非 0 就是 bug
  var rec = (STK && STK.rec) || {};
  var tips = [];
  tips.push('纯描述 = 这一类的图库里没有了，但描述留着（不影响别的）；已分类 = 有描述也有图；需描述 = 该有描述却补不出来的，正常永远 0');
  if ((rec.renamed || []).length) tips.push('刚接上的改名：' + rec.renamed.join('、'));
  if ((rec.needDesc || []).length) tips.push('补不出来的（去看看文件是不是坏了）：' + rec.needDesc.join('、'));
  var recRow = el('span', 'sk-recline');
  var rc = function (name, n, cls) {
    var c = el('span', 'sk-chip sk-chip-mini' + (cls ? ' ' + cls : ''));
    c.appendChild(document.createTextNode(name));
    c.appendChild(el('b', null, String(n)));
    c.title = tips.join('　');
    recRow.appendChild(c);
  };
  rc('纯描述', rec.pureDesc || 0);
  rc('已分类', rec.classified || 0, 'ok');
  rc('需描述', (rec.needDesc || []).length, (rec.needDesc || []).length ? 'bad' : '');
  chipRow.appendChild(recRow);
  box.appendChild(chipRow);

  var warn = [];
  if ((rec.needDesc || []).length) warn.push('这些图该有描述，但自动补也补不出来（只可能是文件出问题）：' + rec.needDesc.join('、'));
  if ((STK.noImg || []).length) warn.push('情绪表里的情绪没有同名图（认出情绪也空手）：' + STK.noImg.join('、'));
  if (warn.length) {
    var w = el('div', 'gy');
    w.style.cssText = 'border-left:3px solid #d48806;padding:6px 10px;margin:0 0 10px;background:#fffbf2;border-radius:6px;line-height:1.9;white-space:pre-wrap;color:var(--tx2)';
    w.textContent = '⚠ ' + warn.join('\n⚠ ');
    w.title = '正常情况这里什么都不该有。真出现了就是 bug，告诉我。';
    box.appendChild(w);
  }

  // —— 工具条：重读 / 重制 / 看原文 / 看代码 / 关键词开关 ——
  var bar = el('div', 'sk-toolbar');
  var bRe = el('button', 'sk-tool', '↻ 重读文件');
  bRe.title = '把磁盘上的文件重新读一遍（自己手改过文件、或想让状态条立刻更新时点）';
  bRe.onclick = function () { t._emoRows = null; t._gRows = null; STK = null; renderContent(); };
  bar.appendChild(bRe);
  var bRecRe = el('button', 'sk-tool', '↺ 重制');
  bRecRe.title = '把系统自动补的描述正式写进场合表（自动分类的图不再标黄），顺便重新对一遍账、三个数字归零';
  bRecRe.onclick = function () {
    bRecRe.textContent = '重制中…';
    POST('/api/stickers/commit', {}).then(function (r) {
      bRecRe.textContent = '↺ 重制';
      if (r && r.error) return toast(r.error);
      t._gRows = null; t._emoRows = null; STK = null;
      toast('重制完成：新补进表 ' + ((r && r.added) || 0) + ' 张');
      renderContent();
    }).catch(function () { bRecRe.textContent = '↺ 重制'; toast('重制失败，再试一次'); });
  };
  bar.appendChild(bRecRe);
  var bRaw = el('button', 'sk-tool', '改 JSON 原文');
  bRaw.title = '切回原来的 JSON 原文框（要复制粘贴、批量改动时用；保存前会校验格式，坏的存不进去）';
  bRaw.onclick = function () { t.rawMode = true; renderContent(); };
  bar.appendChild(bRaw);
  var bMd = el('button', 'sk-tool', '看表达式单原文');
  bMd.title = '打开 data/stickers/常用.md 原文（也可以直接在那边改）';
  bMd.onclick = function () { openRaw(STICKER_MD_ID); };
  bar.appendChild(bMd);
  var bCode = el('button', 'sk-tool', '看发图逻辑代码');
  bCode.title = '打开 connectors/qq.js：哪段负责认情绪、哪段负责挑图、哪段负责发，鼠标停在每段上看说明';
  bCode.onclick = function () { openRaw('connectors/qq.js'); };
  bar.appendChild(bCode);
  // 关键词类兜底开关（2026-11-01）：长名字说一半 / 差一两个字也能发。存 config.json → sticker.keywordFuzzy
  var kwOn = STK.kwFuzzy !== false;
  var bKw = el('button', 'sk-tool' + (kwOn ? ' on' : ''), '关键词类「说一半/说近了」：' + (kwOn ? '开' : '关'));
  bKw.title = '开：长名字的图说一段（如「三角洲」）、或差一两个字（如「蓝发女娃」）也能发；关：只认整名。'
    + '只影响「关键词触发」文件夹里的图，情绪类和场合组完全不受影响。点一下切换，立刻生效、不用重启。';
  bKw.onclick = function () {
    var next = kwOn ? 0 : 1;
    bKw.textContent = '切换中…';
    POST('/api/cfgset', { k: 'sticker.keywordFuzzy', v: next }).then(function (r) {
      if (r && r.error) { bKw.textContent = '关键词类「说一半/说近了」：' + (kwOn ? '开' : '关'); return toast(r.error); }
      STK.kwFuzzy = next === 1;
      toast(next === 1 ? '已开：长名字说一半、说近了也能发' : '已关：关键词类只认整名');
      renderContent();
    }).catch(function () {
      bKw.textContent = '关键词类「说一半/说近了」：' + (kwOn ? '开' : '关');
      toast('切换失败，再点一次');
    });
  };
  bar.appendChild(bKw);
  box.appendChild(bar);

  /* ===== 区块顺序（2026-11-07 主人第 4 条）=====
   * 「第一栏 4 指纹维护，第二栏 3 还没进的图，然后才是现在的顺序」。
   * 所以页面从上到下是：④ 指纹维护 → ③ 还没进表的图 → ① 情绪 → ② 场合表 → ⑤ B站收图。
   * 做法：每块先塞进自己的容器，最后按这个顺序一次性挂上去 ——
   * 不改各块内部任何一行逻辑，只换它挂在哪。 */
  var SEC = {
    maint: el('div', 'sk-sec'),
    unfiled: el('div', 'sk-sec'),
    emo: el('div', 'sk-sec'),
    occ: el('div', 'sk-sec'),
    bili: el('div', 'sk-sec'),
  };

  /* ===== ① 情绪 → 触发词（2026-11-01 重做：和 ② 同一套卡片，图和图名直接看得见）=====
   * 主人原话：「上面这 1 貌似没什么意义…把 1 改成 2 这样。图片名字也需要显示，因为也是提示词的一部分」。
   * 数据一个字节没动（还是 data/情绪表情.json），只把「一行两个输入框」换成一类一张卡：
   *   ⠿ 拖动 = 换顺序（顺序就是优先级，第一个命中的情绪说了算）
   *   卡片里直接排这个情绪能发的图，**图名写在图下面**（图名 = 发图、写提示词用的就是它）
   *   触发词单独一行输入框；有图/没图徽章照旧；图上点一下看大图 */
  SEC.emo.appendChild(el('div', 'tgroup', '① 情绪 → 触发词'));
  SEC.emo.appendChild(el('p', 'pgsub', '她从第一行往下找，第一个命中的词决定发哪个情绪 —— 所以常用的放上面，按住卡片左边的 ⠿ 上下拖就能换位置。'
    + '一张卡 = 一个情绪：上面是情绪名，中间直接排着这个情绪能发的图（图名写在图下面，就是提示词和 [表情:名字] 里用的那个名字），下面是触发词。'
    + '「有图 / 没图」是现查文件夹的 —— 写「害怕」、库里有 q害怕1~4，就显示「有图4」。'
    + '图名就是提示词里用的名字，**点图名能直接改**（会连文件名一起改，② 那张表跟着走）。'
    + '这张表只管一种情况：**你自己**只发一句纯情绪（哈哈哈、救命、泪目）时，她直接甩一张对应的图；群友发纯情绪她会正常回话，不甩图。'));
  var listA = el('div', 'sk-list');
  if (!t._emoRows) t._emoRows = emo.map(function (e) { return { cat: String(e.cat || ''), words: (e.words || []).join('、') }; });
  var dragE = null;                        // 正在拖的情绪卡序号（只用于换顺序）
  function drawA() {
    listA.textContent = '';
    t._emoRows.forEach(function (r, i) {
      var card = el('div', 'sk-card');
      var row = el('div', 'sk-row');

      // ⠿ 手柄：只有按这里才换顺序（顺序 = 优先级，第一个命中的词决定发哪个情绪）
      var handle = el('span', 'sk-handle', '⠿');
      handle.draggable = true;
      handle.title = '按住这里上下拖 = 换这个情绪的位置。她从上往下找，第一个命中的词决定发哪个情绪';
      handle.ondragstart = function (e) {
        dragE = i;
        try { e.dataTransfer.setData('text/plain', 'erow:' + i); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
      };
      handle.ondragend = function () { dragE = null; };

      var iCat = document.createElement('input');
      iCat.className = 'sk-desc'; iCat.value = r.cat; iCat.placeholder = '情绪名（如 开心）';
      iCat.style.cssText = 'flex:0 1 160px;min-width:80px;font-weight:600';
      iCat.title = '情绪名。要和库里那张图的名字一样（「害怕」认得出 q害怕1~4），才找得到图；改完下面的图会立刻跟着变';
      iCat.oninput = function () { r.cat = iCat.value.trim(); paint(); };

      var bd = el('span', 'sk-cnt');
      var ths = el('div', 'sk-thumbs');

      var iW = document.createElement('input');
      iW.className = 'sk-in'; iW.value = r.words;
      iW.placeholder = '触发词，多个用「、」隔开（如：哈哈、笑、好耶）';
      iW.style.cssText = 'width:100%;margin-top:8px';
      iW.title = '听到这些词（整句只有语气词时）就挑这个情绪的表情包；纯文字，不用管符号';
      iW.oninput = function () { r.words = iW.value; };

      // 徽章 + 卡片里的图：改情绪名的瞬间跟着重画（不整页重绘，输入框不会丢焦点）
      var paint = function () {
        var fs2 = hitFiles(r.cat), ok = fs2.length > 0;
        bd.textContent = ok ? (fs2.length > 1 ? '有图' + fs2.length : '有图') : '没图';
        bd.className = 'sk-cnt' + (ok ? '' : ' off');
        bd.title = ok
          ? '认出这个情绪就能发，能发的是：' + fs2.map(function (f) { return f.split('/').pop(); }).join('、')
          : '库里没有「' + (r.cat || '这个情绪') + '」的图（叫 q' + (r.cat || '情绪') + '1 这种带编号的也算有）—— 认出情绪也发不出去。往 data/stickers/ 放一张图，名字用这个情绪';
        ths.textContent = '';
        if (!ok) {
          var dp = el('div', 'sk-drop', (r.cat ? '库里没有名字对上「' + r.cat + '」的图' : '还没写情绪名')
            + ' —— 放一张同名图（叫 q' + (r.cat || '情绪') + '1 这种带编号的也算），或照 ② 用场合表发');
          dp.style.width = '100%';
          ths.appendChild(dp);
          return;
        }
        fs2.forEach(function (f) {
          var nmTxt = f.split('/').pop();
          var wrap = el('div', 'sk-thw');
          var th = el('div', 'sk-th');
          var im = document.createElement('img');
          im.loading = 'lazy'; im.src = stkImgUrl(f); im.alt = nmTxt;
          im.onerror = function () { th.classList.add('miss'); im.remove(); };
          th.appendChild(im);
          th.title = nmTxt + '　·　点一下看大图';
          // 删图（2026-11-07 第 2 条）：① 里也能删，和 ② 是同一张图，删法一样
          var bx1 = el('i', 'x', '×');
          bx1.title = '删掉这张图（先确认；图会挪进 回收站/）';
          bx1.onclick = function (e) { e.stopPropagation(); askDel(f); };
          th.appendChild(bx1);
          th.style.cursor = 'zoom-in';        // ① 里的图不能拖（换不了类），只看大图
          th.onclick = function () { openLb(f, fs2); };
          wrap.appendChild(th);
          var cap = el('div', 'sk-nm rn', nmTxt);
          cap.title = nmTxt + '（' + f + '）　·　点一下改图片名';
          cap.onclick = function () { openRename(f); };
          wrap.appendChild(cap);
          ths.appendChild(wrap);
        });
      };
      paint();

      var bU = el('button', 'sk-tool sm', '↑');
      bU.title = '上移一位（更优先）';
      bU.onclick = function () { if (i > 0) { var x = t._emoRows.splice(i, 1)[0]; t._emoRows.splice(i - 1, 0, x); drawA(); } };
      var bDn = el('button', 'sk-tool sm', '↓');
      bDn.title = '下移一位';
      bDn.onclick = function () { if (i < t._emoRows.length - 1) { var x = t._emoRows.splice(i, 1)[0]; t._emoRows.splice(i + 1, 0, x); drawA(); } };
      var bD = el('button', 'sk-tool sm danger', '删');
      bD.title = '把这一行从情绪表里去掉（图不会被删）';
      bD.onclick = function () { t._emoRows.splice(i, 1); drawA(); };
      var tools = el('div', 'sk-tools');
      tools.appendChild(bU); tools.appendChild(bDn); tools.appendChild(bD);

      row.appendChild(handle); row.appendChild(iCat); row.appendChild(bd); row.appendChild(tools);
      card.appendChild(row);
      card.appendChild(ths);
      card.appendChild(iW);

      // 卡片当放置区：拖别张卡的手柄过来 = 换到这个位置
      card.ondragover = function (e) {
        if (dragE === null || dragE === i) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (x) {}
        card.classList.add('over');
      };
      card.ondragleave = function (e) {
        if (!e.relatedTarget || !card.contains(e.relatedTarget)) card.classList.remove('over');
      };
      card.ondrop = function (e) {
        e.preventDefault(); card.classList.remove('over');
        if (dragE === null) return;
        var from = dragE; dragE = null;
        if (from === i) return;
        var moved = t._emoRows.splice(from, 1)[0];
        t._emoRows.splice(i, 0, moved);
        drawA();
      };

      listA.appendChild(card);
    });
    if (!t._emoRows.length) listA.appendChild(el('div', 'empty', '还没有一条。点下面「＋ 加一个情绪」。'));
  }
  drawA();
  SEC.emo.appendChild(listA);
  var barA = el('div', 'sk-toolbar');
  barA.style.margin = '8px 0 18px';
  var bAddA = el('button', 'sk-tool', '＋ 加一个情绪');
  bAddA.onclick = function () { t._emoRows.push({ cat: '', words: '' }); drawA(); };
  barA.appendChild(bAddA);
  var bSaveA = el('button', 'sk-tool on', '保存这张表');
  bSaveA.title = '存回 data/情绪表情.json；存的仍然是标准 JSON，格式错不了（错了服务端会拦下来）';
  bSaveA.onclick = function () {
    var out = [];
    t._emoRows.forEach(function (r) {
      var cat = String(r.cat || '').trim();
      var words = stkWords(r.words);
      if (!cat) return;                     // 名字空着的行当没填
      out.push({ cat: cat, words: words });
    });
    if (!out.length) return toast('一条都没填，没保存');
    var noWord = out.filter(function (x) { return !x.words.length; }).map(function (x) { return x.cat; });
    if (noWord.length) return toast('这些情绪还没写触发词：' + noWord.join('、'));
    bSaveA.textContent = '保存中…';
    POST('/api/raw', { id: STICKER_EMO_ID, raw: JSON.stringify(out, null, 1) + '\n' }).then(function (r) {
      bSaveA.textContent = '保存这张表';
      if (!r || r.error) return toast((r && r.error) || '没保存上');
      toast('存好了，她 1 分钟内按新表来');
      t._emoRows = null; STK = null; renderContent();
    }).catch(function () { bSaveA.textContent = '保存这张表'; toast('没保存上，再试一次'); });
  };
  barA.appendChild(bSaveA);
  SEC.emo.appendChild(barA);

  /* ===== ② 场合表（2026-11-01 重排：图直接看得见，还能在类别之间拖）=====
   * 一行 = 一类情绪。左边描述可改；下面**直接排出这一类的缩略图**（不再是「N 张」+ 悬停看名字）。
   * 把一张图拖到另一张卡片上 = 把这张图换到那一类；拖左边手柄 = 换这一类的顺序。
   * 老功能全保留：↑ ↓ 排序、并入上行、删这一整类、自动分类标黄、保存写回 常用.md（表头原样保留）。
   * 每次结构改动都记一步，可以点「撤销」退回（只退一步，防手滑）。 */
  SEC.occ.appendChild(el('div', 'tgroup', '② 场合表 · 什么时候用 → 哪一类表情'));
  SEC.occ.appendChild(el('p', 'pgsub', '一行一类，顺序就是她看提示词里的顺序。'
    + '改描述、把某张图拖到别的类别、拖左边手柄换顺序、**点图名改文件名**、点图看大图 —— 改完记得点最下面「保存这张表」。'
    + '鼠标移到某张卡片上，右边会冒出 ↑ ↓ / 并入上行 / 删。'));
  if (!t._gRows) {
    t._gRows = groups.map(function (g) {
      return { desc: g.desc, names: (g.names || []).slice(), auto: !!g.auto };
    });
    t._undo = null;
  }
  var listB = el('div', 'sk-list');
  var dragN = null;                        // 正在拖的东西：{kind:'img'|'row', name, from}
  var lastDrag = 0;                        // 刚拖完的一瞬间不要被当成「点一下看图」
  function snapG(label) {                  // 改之前先记一步（给「撤销」用）
    t._undo = { label: label, rows: JSON.parse(JSON.stringify(t._gRows)) };
  }
  var bUndo = el('button', 'sk-tool', '↶ 撤销');
  bUndo.title = '退回上一步改动（只退一步；还没保存，文件一点没动）';
  bUndo.onclick = function () {
    if (!t._undo) return;
    t._gRows = JSON.parse(JSON.stringify(t._undo.rows));
    t._undo = null; drawB(); toast('已退回上一步（还没保存，文件没动）');
  };
  var bAddB = el('button', 'sk-tool', '＋ 加一类');
  bAddB.title = '新加一个空类别：先写「什么时候用」，再把图拖进来（不拖也行，纯描述能留着）';
  bAddB.onclick = function () { snapG('加一类'); t._gRows.push({ desc: '', names: [], auto: false }); drawB(); };
  var barTop = el('div', 'sk-toolbar');
  barTop.appendChild(bUndo);
  barTop.appendChild(bAddB);
  SEC.occ.appendChild(barTop);

  function drawB() {
    bUndo.style.display = t._undo ? '' : 'none';
    bUndo.textContent = t._undo ? ('↶ 撤销「' + t._undo.label + '」') : '↶ 撤销';
    listB.textContent = '';
    t._gRows.forEach(function (r, i) {
      var card = el('div', 'sk-card' + (r.auto ? ' auto' : ''));
      var row = el('div', 'sk-row');

      // 拖拽手柄：只有按这里才换顺序（以前整行都能拖，选字时老误触）
      var handle = el('span', 'sk-handle', '⠿');
      handle.draggable = true;
      handle.title = '按住这里上下拖 = 换这一类的顺序';
      handle.ondragstart = function (e) {
        dragN = { kind: 'row', from: i };
        try { e.dataTransfer.setData('text/plain', 'row:' + i); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
      };
      handle.ondragend = function () { dragN = null; lastDrag = Date.now(); };

      var iD = document.createElement('input');
      iD.className = 'sk-desc'; iD.value = r.desc;
      iD.placeholder = '什么时候用（如：想哭、难过的时候）';
      iD.title = r.auto
        ? '这一类是系统自动补的描述（还没写进文件），改完点「↺ 重制」或保存就正式存下来'
        : '这就是「什么时候用」。这一行里冒号前后（这段描述 + 后面那些图名）都算触发词。';
      iD.oninput = function () { r.desc = iD.value; };

      var alive = (r.names || []).filter(function (n) { return has(n); });
      var nm = el('span', 'sk-cnt' + (alive.length ? '' : ' off'),
        alive.length ? (alive.length + ' 张') : (r.names && r.names.length ? '没图' : '空'));
      nm.title = r.names && r.names.length
        ? ('这一类：' + r.names.join('、') + (alive.length < r.names.length ? '（有 ' + (r.names.length - alive.length) + ' 张库里找不到，发不出去）' : ''))
        : '这一类还没有图（纯描述，可以留着，不影响别的）';

      var bU = el('button', 'sk-tool sm', '↑');
      bU.title = '上移一位';
      bU.onclick = function () { if (i > 0) { snapG('上移'); var x = t._gRows.splice(i, 1)[0]; t._gRows.splice(i - 1, 0, x); drawB(); } };
      var bDn = el('button', 'sk-tool sm', '↓');
      bDn.title = '下移一位';
      bDn.onclick = function () { if (i < t._gRows.length - 1) { snapG('下移'); var x = t._gRows.splice(i, 1)[0]; t._gRows.splice(i + 1, 0, x); drawB(); } };
      var bD = el('button', 'sk-tool sm danger', '删');
      bD.title = '只从表里去掉这一类（图不会被删）';
      bD.onclick = function () { snapG('删掉一类'); t._gRows.splice(i, 1); drawB(); };

      var tools = el('div', 'sk-tools');
      tools.appendChild(bU); tools.appendChild(bDn);
      // 并入上一行（2026-10-31）：同一类情绪被拆成好几行时，把这一行的图名并到上一行，只留一个描述。
      if (i > 0) {
        var bM = el('button', 'sk-tool sm', '并入上行');
        bM.title = '把这一类的图片名并到上一行（两行描述合成一条），适合「同一类情绪被拆成好几行」的情况';
        bM.onclick = function () {
          snapG('并入上行');
          var prev = t._gRows[i - 1], cur = t._gRows[i];
          (cur.names || []).forEach(function (n) { if (prev.names.indexOf(n) < 0) prev.names.push(n); });
          prev.auto = prev.auto || cur.auto;
          t._gRows.splice(i, 1); drawB();
        };
        tools.appendChild(bM);
      }
      tools.appendChild(bD);

      row.appendChild(handle); row.appendChild(iD); row.appendChild(nm); row.appendChild(tools);
      card.appendChild(row);

      // —— 这一类的图：缩略图直接看得见，可拖到别的类别 ——
      var ths = el('div', 'sk-thumbs');
      (r.names || []).forEach(function (n) {
        var ok = has(n);
        var th = el('div', 'sk-th' + (ok ? '' : ' miss'));
        if (ok) {
          var im = document.createElement('img');
          im.loading = 'lazy'; im.src = stkImgUrl(n); im.alt = n;
          im.onerror = function () { th.classList.add('miss'); im.remove(); };
          th.appendChild(im);
        } else {
          th.appendChild(document.createTextNode('缺'));
        }
        th.title = n + (ok ? '' : '（库里已经没有这张图了）')
          + '　·　按住拖到别的类别 = 换场合　·　点一下看大图';
        th.draggable = true;
        th.ondragstart = function (e) {
          e.stopPropagation();                       // 别把整张卡片一起拖走
          dragN = { kind: 'img', name: n, from: i };
          try { e.dataTransfer.setData('text/plain', 'img:' + n); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
          th.classList.add('dragging');
        };
        th.ondragend = function () { th.classList.remove('dragging'); dragN = null; lastDrag = Date.now(); };
        th.onclick = function (e) {
          if (e && e.target && /(^|\s)(x|rm)(\s|$)/.test(String(e.target.className || ''))) return;
          if (Date.now() - lastDrag < 350) return;   // 刚拖完的那一下不算点
          openLb(n, alive);
        };
        /* 2026-11-07 主人：「点叉做成删图，我刚刚点了个叉发现不是删」。
         * 以前的叉只是从这一类里拿掉（图还在），她找不到那张图还以为被删了。
         * 现在两个角标各管各的，图标也分开：
         *   × 右上角 = 删掉这张图（先确认；图挪进 回收站/，场合表里也一起去掉）
         *   − 左上角 = 这一类不用它（图还在库里，只是这一行不再用它）—— 老功能，一个都不丢
         * 只在鼠标移上去时冒出来，平时不挡图。 */
        var bx = el('i', 'x', '×');
        bx.title = '删掉这张图（先确认；图会挪进 回收站/，场合表里也一起去掉）';
        bx.onclick = function (e) {
          e.stopPropagation();
          askDel(n);
        };
        th.appendChild(bx);
        var brm = el('i', 'rm', '−');
        brm.title = '这一类不用它（图还在库里，只是这一行不再用它；想放回来把它拖回来就行）';
        brm.onclick = function (e) {
          e.stopPropagation();
          snapG('拿掉一张图');
          var j = r.names.indexOf(n);
          if (j >= 0) r.names.splice(j, 1);
          drawB();
        };
        th.appendChild(brm);
        // 图名写在图下面（2026-11-01 主人：图片名字也是提示词的一部分，得看得见）
        var cw = el('div', 'sk-thw');
        cw.appendChild(th);
        var cap = el('div', 'sk-nm rn', String(n));
        cap.title = String(n) + '　·　这一行写的就是它，提示词里也是这个名字　·　点一下改图片名';
        cap.onclick = function (e) {
          e.stopPropagation();
          var h0 = hitFiles(n)[0];               // 取真实路径（同名图可能在两个池里，按 常用>可用>虚幻>根目录 取第一张）
          openRename(h0 || n);
        };
        cw.appendChild(cap);
        ths.appendChild(cw);
      });
      if (!(r.names || []).length) {
        var dp = el('div', 'sk-drop', '这一类还没有图 —— 把别的类别的图拖到这里就归这一类');
        dp.style.width = '100%';
        ths.appendChild(dp);
      }
      card.appendChild(ths);

      // —— 卡片当放置区：拖图过来 = 换类；拖手柄过来 = 换顺序 ——
      card.ondragover = function (e) {
        if (!dragN) return;
        if (dragN.kind === 'row' && dragN.from === i) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (x) {}
        card.classList.add('over');
      };
      card.ondragleave = function (e) {
        if (!e.relatedTarget || !card.contains(e.relatedTarget)) card.classList.remove('over');
      };
      card.ondrop = function (e) {
        e.preventDefault(); card.classList.remove('over');
        if (!dragN) return;
        if (dragN.kind === 'row') {
          var from = dragN.from; dragN = null;
          if (from === i) return;
          snapG('换顺序');
          var moved = t._gRows.splice(from, 1)[0];
          t._gRows.splice(i, 0, moved);
          drawB(); return;
        }
        var nm2 = dragN.name, fromI = dragN.from; dragN = null;
        if (fromI === i) return;
        var src = t._gRows[fromI], dst = t._gRows[i];
        if (!src || !dst) return;
        snapG('把图挪到别的类别');
        var j = src.names.indexOf(nm2);
        if (j >= 0) src.names.splice(j, 1);
        if (dst.names.indexOf(nm2) < 0) dst.names.push(nm2);
        drawB();
        toast('「' + nm2 + '」已挪到「' + (String(dst.desc || '').slice(0, 12) || '这一类') + '」，记得点保存');
      };

      listB.appendChild(card);
    });
    if (!t._gRows.length) listB.appendChild(el('div', 'empty', '表空着 —— 她一张图都不会发。点「＋ 加一类」开始。'));
  }
  drawB();
  SEC.occ.appendChild(listB);
  var barB = el('div', 'sk-toolbar');
  barB.style.margin = '2px 0 16px';
  var bSaveB = el('button', 'sk-tool on', '保存这张表');
  bSaveB.title = '存回 data/stickers/常用.md（一行「- 描述：图名1、图名2」）';
  bSaveB.onclick = function () {
    var rows = [];
    t._gRows.forEach(function (r) {
      var d = String(r.desc || '').trim().replace(/[:：\r\n]/g, '');
      var ns = (r.names || []).filter(Boolean);
      // 2026-10-31 主人定（只增不减）：描述框空着的行**照样写盘**，不许悄悄丢。
      // 写成「- 图名1、图名2」（没冒号），对账时算「纯描述」那一类，留着等她补。
      if (!d) { if (ns.length) rows.push('- ' + ns.join('、')); return; }
      rows.push('- ' + d + '：' + ns.join('、'));
    });
    if (!rows.length) return toast('一行都没写描述');
    // 表头/说明原样留着：只替掉「- 描述：图名」这些行
    var keep = String(STK.md || '').split('\n').filter(function (l) { return !/^\s*[-*]\s+\S/.test(l); });
    while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
    var txt = keep.join('\n') + '\n\n' + rows.join('\n') + '\n';
    bSaveB.textContent = '保存中…';
    POST('/api/raw', { id: STICKER_MD_ID, raw: txt }).then(function (r) {
      bSaveB.textContent = '保存这张表';
      if (!r || r.error) return toast((r && r.error) || '没保存上');
      toast('存好了，她 3 秒内按新表来');
      t._gRows = null; STK = null; renderContent();
    }).catch(function () { bSaveB.textContent = '保存这张表'; toast('没保存上，再试一次'); });
  };
  barB.appendChild(bSaveB);
  SEC.occ.appendChild(barB);

  /* ===== ④ 指纹表维护（2026-11-01 主人：原来在 .command 黑窗口里，3 用不了、4 是重复数字 → 搬进面板）=====
   * 管两件事：
   *   1) 清理已删图的指纹 —— 图删了但指纹还留着，表会越攒越大；清理前自动备份。
   *   2) 「用模型补描述」开关 + 跑一次 —— 默认关（关着不花积分），开了才调视觉模型给缺描述的情绪图写一句话。
   * 这块只动 .md5.json 和「补描述」新加的表行，不改图、不改已有描述。 */
  (function drawMaint() {
    var wrap = el('div', 'sk-card slim');
    var hd = el('div', 'tgroup', '④ 指纹表维护（.md5.json）');
    hd.style.margin = '0 0 6px';
    wrap.appendChild(hd);
    var line = el('div');
    line.style.cssText = 'font-size:12px;color:var(--tx2);line-height:1.9;margin-bottom:8px';
    line.textContent = '正在读现状…';
    wrap.appendChild(line);
    var bar = el('div');
    bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
    wrap.appendChild(bar);
    var tip = el('div');
    tip.style.cssText = 'font-size:11px;color:var(--tx2);line-height:1.8;margin-top:8px';
    tip.textContent = '指纹 = 图的身份证，用来认「同一张图」和「你改了名还是它」。图删了记录留着会让表变大，点清理就行（会先备份）。'
      + '「用模型补描述」默认关着、不花钱；打开后才调模型给缺描述的情绪图写一句，每张调一次。';
    wrap.appendChild(tip);
    SEC.maint.appendChild(wrap);

    var cur = { on: false, dead: 0, entries: 0, size: 0, running: false };

    function paint(s) {
      if (!s || s.error) { line.textContent = '读不到：（' + ((s && s.error) || '接口没回') + '）'; return; }
      cur = s;
      var kb = (s.size / 1024).toFixed(1);
      line.innerHTML = '指纹 <b>' + s.entries + '</b> 条 · <b>' + kb + ' KB</b> · 其中已失效 <b style="color:'
        + (s.dead ? '#c0392b' : 'inherit') + '">' + s.dead + '</b> 条（图已经删了，指纹还留着）';
    }

    function load() {
      return api('/api/stickers/maint').then(function (s) { paint(s); drawBar(); return s; })
        .catch(function () { line.textContent = '读不到现状（面板接口没回）'; });
    }

    function drawBar() {
      bar.innerHTML = '';
      // 1) 清理（两下确认，不用原生弹窗）
      var bC = el('button', 'sk-tool', cur._armClean ? '再点一下确认清理' : '清理已删图的指纹');
      bC.title = '图已经删了、指纹还留着的记录清掉（会先自动备份 .md5.json；常用.md 一个字都不动）';
      if (cur._armClean) bC.style.cssText = 'background:#c0392b;color:#fff;border-color:#c0392b';
      bC.onclick = function () {
        if (!cur._armClean) { cur._armClean = true; drawBar(); setTimeout(function () { if (cur._armClean) { cur._armClean = false; drawBar(); } }, 4000); return; }
        cur._armClean = false; bC.disabled = true; bC.textContent = '清理中…';
        POST('/api/stickers/maint', { action: 'clean' }).then(function (r) {
          if (!r || r.error) { toast((r && r.error) || '没清理成'); drawBar(); return; }
          toast(r.msg || '清理好了'); paint(r); drawBar();
        }).catch(function () { toast('没清理成，再试一次'); drawBar(); });
      };
      bar.appendChild(bC);
      // 2) 开关（改了立刻生效，机器人那边读的是同一个值）
      var bS = el('button', 'sk-tool' + (cur.on ? ' on' : ''), '用模型补描述：' + (cur.on ? '开（花积分）' : '关（不花钱）'));
      bS.title = '默认关。关着按「补描述」不会跑；打开后才会调视觉模型（每张图一次，花积分）';
      if (cur.on) bS.style.cssText = 'background:#fff3cd;border-color:#e0c060';
      bS.onclick = function () {
        bS.disabled = true;
        POST('/api/stickers/maint', { action: 'switch', on: !cur.on }).then(function (r) {
          if (!r || r.error) { toast((r && r.error) || '没切成'); bS.disabled = false; return; }
          toast(r.msg || '开关变了'); paint(r); drawBar();
        }).catch(function () { toast('没切成，再试一次'); bS.disabled = false; });
      };
      bar.appendChild(bS);
      // 3) 跑一次补描述
      var bF = el('button', 'sk-tool', cur.running ? ('补描述中 ' + (cur.job ? cur.job.done : 0) + '/' + (cur.job ? cur.job.total : 0)) : '用模型补描述');
      bF.title = '给「情绪类 + 表里还没有」的图各配一句话，补进常用.md（会先备份）';
      if (!cur.on || cur.running) { bF.disabled = true; bF.style.opacity = '.55'; }
      bF.onclick = function () {
        bF.disabled = true; bF.textContent = '启动中…';
        POST('/api/stickers/maint', { action: 'fill' }).then(function (r) {
          if (!r || r.error) { toast((r && r.error) || '没启动'); drawBar(); return; }
          toast(r.msg || '开始补了');
          poll();
        }).catch(function () { toast('没启动，再试一次'); drawBar(); });
      };
      bar.appendChild(bF);
      if (cur.job && cur.job.log && cur.job.log.length) {
        var lg = el('div');
        lg.style.cssText = 'font-size:11px;color:var(--tx2);line-height:1.8;margin-top:8px;max-height:110px;overflow:auto';
        lg.textContent = cur.job.log.join('　|　');
        wrap.appendChild(lg);
      }
    }

    var timer = null;
    function poll() {
      if (timer) clearTimeout(timer);
      api('/api/stickers/maint').then(function (s) {
        paint(s);
        if (s && s.job) cur.job = s.job;
        drawBar();
        if (s && s.job && s.job.running) timer = setTimeout(poll, 1500);
        else { timer = null; STK = null; }
      }).catch(function () { timer = null; });
    }

    load();
  })();

  /* ===== ⑤ B站评论区收图（2026-11-01 主人第 7、8 条）=====
   * 做在项目这边，不进 astrbot 插件（插件一升级就把改动盖掉了）。
   * 收进来的图进根目录（普通池），和群友发的图走同一套指纹去重，不会重复。 */
  (function drawBili() {
    var wrap = el('div', 'sk-card slim');
    var hd = el('div', 'tgroup', '⑤ B站评论区收图');
    hd.style.margin = '0 0 6px';
    wrap.appendChild(hd);
    var sub = el('p', 'pgsub', '贴一个视频链接（或 BV 号 / av 号），把这个视频评论区里网友发的图收进表情包（写入 少用/，满 500 张停）。');
    wrap.appendChild(sub);
    var bar = el('div');
    bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
    var inp = document.createElement('input');
    inp.className = 'ckw';
    inp.style.cssText = 'flex:1;min-width:260px';
    inp.placeholder = '例如 https://www.bilibili.com/video/BV1xx411c7mD 或 BV1xx411c7mD';
    bar.appendChild(inp);
    var b = el('button', 'sk-tool on', '收这个视频的图');
    b.title = '只收这个视频评论区里的图片，不收别的；重复的会自动跳过';
    bar.appendChild(b);
    wrap.appendChild(bar);
    var out = el('div');
    out.style.cssText = 'font-size:11px;color:var(--tx2);line-height:1.8;margin-top:8px';
    wrap.appendChild(out);
    SEC.bili.appendChild(wrap);

    var timer = null;
    function show(s) {
      if (!s) { out.textContent = ''; return; }
      if (s.error) { out.textContent = '出错了：' + s.error; return; }
      out.textContent = '视频 ' + (s.input || '') + ' · 翻了 ' + (s.pages || 0) + ' 页 · 看到 ' + (s.seen || 0) + ' 张图 · 收了 '
        + (s.got || 0) + ' 张 · 跳过 ' + (s.skip || 0) + ' 张 · 失败 ' + (s.fail || 0) + ' 张'
        + (s.log && s.log.length ? '\n' + s.log.slice(-4).join('　|　') : '');
      out.style.whiteSpace = 'pre-wrap';
    }
    function poll() {
      if (timer) clearTimeout(timer);
      api('/api/stickers/bili').then(function (s) {
        show(s);
        if (s && s.running) timer = setTimeout(poll, 2000);
        else { timer = null; b.disabled = false; b.textContent = '收这个视频的图'; STK = null; }
      }).catch(function () { timer = null; b.disabled = false; });
    }
    b.onclick = function () {
      var v = String(inp.value || '').trim();
      if (!v) return toast('先把视频链接或 BV 号填进去');
      b.disabled = true; b.textContent = '收集中…';
      out.textContent = '正在收，稍等（每张图间隔 0.4 秒，防被 B站拦）…';
      POST('/api/stickers/bili', { v: v, pages: 2 }).then(function (r) {
        if (!r || r.error) { toast((r && r.error) || '没开始'); b.disabled = false; b.textContent = '收这个视频的图'; return; }
        toast(r.msg || '开始收了');
        poll();
      }).catch(function () { toast('没开始，再试一次'); b.disabled = false; b.textContent = '收这个视频的图'; });
    };
    api('/api/stickers/bili').then(show).catch(function () {});
  })();

  /* ===== ③ 还没进表的图（2026-10-31 主人第 10 条：两张表已经合并成一张，这里只做只读展示）=====
   * 关键词类（名字本身就是一句话/画面）不用进表 —— 名字就是触发词。
   * 情绪类点上面工具条的「↺ 重制」会自动配好描述补进表里，不用她动手。 */
  try {
    if (unfiled && unfiled.length) {
      var cardC = el('div', 'sk-card slim');
      var hdC = el('div', 'tgroup', '③ 还没进表的图（' + unfiled.length + ' 张）');
      hdC.style.margin = '0 0 6px';
      cardC.appendChild(hdC);
      cardC.appendChild(el('p', 'pgsub', '关键词类不用进表（名字本身就是触发词，谁提到都能发）；'
        + '情绪类点上面的「↺ 重制」，系统会自己配一句描述补进表里。'
        + '「少用/」里的图整池算一族，清单里只占一行，所以它们全都会出现在下面 —— 这是正常的，不是没进表。'));
      // 2026-11-03：根目录不带 q 的图机器人一律当不存在 —— 面板以前照样列，造成「看得见但永远不发」。
      var deadArr = (STK && STK.dead) || [];
      var deadSet = {};
      deadArr.forEach(function (x) { deadSet[String(x).split('/').pop()] = 1; });
      if (deadArr.length) {
        var wd = el('p', 'pgsub', '⚠ 其中 ' + deadArr.length + ' 张在根目录、名字不以 q 开头：机器人当它不存在（不会发、不进提示词）。'
          + '要让它生效，挪进「常用/」或「可用/」文件夹即可（挪完 3 秒内自动生效），或把文件名改成 q 开头。');
        wd.style.cssText = 'color:#c0392b;font-weight:600';
        cardC.appendChild(wd);
      }
      var wrapU = el('div', 'sk-unfiled');
      unfiled.forEach(function (n) {
        // 图 + 图名（图名也是提示词的一部分；点图名直接改）
        var box3 = el('div', 'sk-thw');
        var c = el('span', 'sk-th');
        c.style.cssText = 'width:42px;height:42px';
        var im = document.createElement('img');
        im.loading = 'lazy'; im.src = stkImgUrl(n); im.alt = n;
        im.onerror = function () { c.classList.add('miss'); im.remove(); };
        c.appendChild(im);
        var isDead = !!deadSet[String(n).split('/').pop()];
        c.title = n + (n.indexOf('/') >= 0 ? '（在 ' + n.split('/')[0] + ' 文件夹里）' : '（在根目录 · 普通池）')
          + (isDead ? '　⚠ 名字不带 q，机器人不会发它' : '') + '　·　点一下看大图';
        box3.style.cssText = isDead ? 'opacity:.45;outline:2px dashed #c0392b;outline-offset:2px;border-radius:6px' : '';
        c.onclick = function () { openLb(n, unfiled); };
        // 未进表的图最容易是没用的图 —— 这里也给一个删（2026-11-07 主人第 2 条，叉 = 删图）
        var bx3 = el('i', 'x', '×');
        bx3.title = '删掉这张图（先确认；图会挪进 回收站/）';
        bx3.onclick = function (e) { e.stopPropagation(); askDel(n); };
        c.appendChild(bx3);
        box3.appendChild(c);
        var cap3 = el('div', 'sk-nm rn', String(n).split('/').pop());
        cap3.title = n + '　·　点一下改图片名';
        cap3.onclick = function () { openRename(n); };
        box3.appendChild(cap3);
        wrapU.appendChild(box3);
      });
      cardC.appendChild(wrapU);
      SEC.unfiled.appendChild(cardC);
    }
  } catch (e3) {
    SEC.unfiled.appendChild(el('div', 'empty', '③ 这块没渲染出来（不影响上面的表）：' + ((e3 && e3.message) || e3)));
  }

  /* ===== 按她定的顺序挂上去（第 4 条）：④ 指纹维护 → ③ 还没进表 → ① 情绪 → ② 场合表 → ⑤ B站收图 =====
   * 空着的区块不挂（比如一张「还没进表」的图都没有时，③ 就整块不出现，不占地方）。 */
  ['maint', 'unfiled', 'emo', 'occ', 'bili'].forEach(function (k) {
    if (SEC[k] && SEC[k].childNodes.length) box.appendChild(SEC[k]);
  });

  /* ===== 注解：改完多久生效、为什么这样设计 ===== */
  var det = document.createElement('details');
  det.className = 'sk-help';
  var sumD = document.createElement('summary');
  sumD.textContent = '这些规则是怎么定的（点开看，不影响上面操作）';
  det.appendChild(sumD);
  var note = el('div', 'body');
  note.textContent = [
    '· 这一页管三件事：①「什么话算什么情绪」（你自己只发一句纯情绪时，她直接甩一张对应图）；②「什么时候用哪一类表情」（一行一类，冒号前后都算触发词）；③「关键词类的图怎么被叫出来」——`关键词触发/` 里的图，名字本身就是触发词，开了「说一半/说近了」之后，长名字说其中一段、或差一两个字也能发。图片名从文件夹自动读；点图下面的名字能在面板里直接改文件名，改完 ② 那一行、① 同名情绪会自动跟着改，不用手碰文件。',
    '· 生效时间：她每 3 秒重读一次这张表（带缓存），存完几乎立刻按新的来，不用重启机器人，也不用重开面板。',
    '· 场合表只有一张：data/stickers/常用.md，一行一类。**冒号前是「什么时候用」，冒号后是这一类的图名，两边都算触发词** —— 说中描述里的词、或直接点后面任何一个名字，都算对上，然后从这一行里挑一张。',
    '· 情绪类 vs 关键词类怎么分（按位置，不看词表）：在 常用/ 可用/ 虚幻/ 里的、以及名字带 q 的 → 情绪类，要有描述；关键词触发/ 里不带 q 的 → 关键词类，名字本身就是触发词，不用写描述。',
    '· 缺的描述自动补：库里出现没进表的图，系统会自己配一句描述补进来（面板里标黄），你改一改、点「↺ 重制」就正式存进文件。只有连补都补不出来的才算 bug（那个数字正常永远是 0）。',
    '· 怎么挑图：**先看场合对不对得上** —— 对上了就从那一行里挑一张，不看池、不看概率；只有「没人对得上、只是想添一张表情」时才按池抽。',
    '· 池权重 48 / 6 / 1（常用+虚幻 / 可用 / 普通），**只在有图的池之间按比例分**：三个池都有 → 87% / 11% / 2%；只有可用+普通 → 86% / 14%；只有常用+普通 → 98% / 2%；只有常用+可用 → 89% / 11%。',
    '· 纯情绪怎么发：**你**只发一句纯情绪（哈哈哈/救命/泪目）→ 她直接甩一张对应图、不说话；**群友**发纯情绪 → 她正常回话、不甩图；她自己想纯情绪发言（「安慰你，不哭不哭」）→ 只发图不发字；带着实质内容（「安慰你，不哭不哭。有什么话和我说说呀」）→ 图 + 文字一起。上一条已经只发过图、90 秒内又来一次纯情绪 → 图驳回，不发也不回。',
    '· 纯描述不会自动删：这一类的图删光了，描述还留着（上面「纯描述」那个数就是它），哪天把图放回来就自动接上。',
    '· 收图规则：你在群里或私聊发的图 → 【可用】；别人在群里发的、B站评论区看到的 → 【普通】（上限 500，满了私聊提醒你）。内容重复的不收（md5 + 像素指纹），同一张出现更清楚的版本会替换旧的。',
    '· 面板里只改描述：图名是自动从文件夹读的，不用你填；拖左边手柄可以换顺序，顺序就是她看到提示词里的顺序。把图拖到别的类别 = 只是「这一类不再用它、那一类开始用它」，图本身一直在库里。'
  ].join('\n');
  det.appendChild(note);
  box.appendChild(det);
}

/* ---------------- 对外 ---------------- */
window.StickerPage = {
  // 挂到容器上；有数据直接画，没有就自己去拉
  mount: function (box, ctx) {
    el = ctx.el; toast = ctx.toast; api = ctx.api; POST = ctx.POST;
    renderContent = ctx.rerender; openRaw = ctx.openRaw;
    HideHead = !!(ctx && ctx.hideHead);
    renderStickerPanel(T, box);
  },
  hasData: function () { return !!STK; },
  reset: function () { STK = null; T._emoRows = null; T._gRows = null; },
  data: function () { return STK; },
  load: function () { return loadStickers(); },
};
})();
