/* 面板前端逻辑：无限嵌套标题 + 多页标签 + 红点 + 草稿卡片 */
(function () {
'use strict';

var api = function (u, o) { return fetch(u, o).then(function (r) { return r.json(); }); };
var POST = function (u, o) {
  return api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
};
var today = function () {
  var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

var FILES = [], TREES = {}, SIGS = {}, CUR = null;
var GROUPS = [];                          // （旧）左列分组，兼容保留
var NAV = [];                             // 左列导航树：7 大类 + 二级文件夹，来自 /api/all 的 nav
var FILEMETA = {};                        // {fileId: {cat,ro,kind,use,range}}
var MAP = null;                           // 触发地图（/api/triggers）
var TABLES_META = [], TABLE_DATA = { };   // 数据表：地区 / 称呼
var TABS = [], ACTIVE = -1, CLOSED = {}, DRAFTS = [];   // CLOSED: {fileId: [{titles,title,pos}]}
// 主人 2026-10-22 定：顶部标签条只放 md 文件。功能页（聊天记录/话题/约定/看每个人…）和
// 原文页（json/config/代码）不走标签，点开就在内容区显示（PAGE），状态按页面缓存
var PAGE = null, PAGE_CACHE = {};
var NEWS = {};                    // {fileId: [hash,...]}
var DRAG = null;                  // {type:'item'|'node'|'draft', ...}
var DRAG_T0 = 0;                  // 这次拖拽是从哪一刻开始的（防止「拖完松手」被当成点击）
var MOUSE0 = null;                // 按下时的坐标（手抖几像素不该被当成「点击打开这一页」）
var DATE_ON = true, DATE_VAL = today();
var TARGET = null;                // composer 目标：{fileId, path}
var SECNAME = '';

/* ---------- 小工具 ---------- */
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.classList.remove('on'); }, 1800);
}

/* ---------- 「规则 + 举例」的拆装 ----------
   文件里存的样子是：  规则一句话。举例：「例子甲」、「例子乙」
   面板里显示成两行：   规则一句话  /  例 「例子甲」、「例子乙」
   所以他只管打中文，符号由这里负责加、负责拆。 */
var EX_RE = /^([\s\S]*?)[。；;]?\s*举例[：:]\s*([\s\S]+)$/;

function splitEx(text) {
  var raw = String(text == null ? '' : text);
  var m = raw.match(EX_RE);
  if (!m) return { rule: raw, ex: '' };
  var rule = m[1].replace(/[。；;]\s*$/, '').trim();
  if (!rule) return { rule: raw, ex: '' };
  return { rule: rule, ex: m[2].trim() };
}

function joinEx(rule, ex) {
  var r = String(rule == null ? '' : rule).trim().replace(/[。；;]\s*$/, '');
  var e = String(ex == null ? '' : ex).trim();
  if (!r) return e;
  if (!e) return r;
  return r + '。举例：' + e;
}

// 他输入的例子：一行一个，自动包「」、用顿号连起来；已经带引号的原样保留
function tidyEx(ex) {
  var arr = String(ex == null ? '' : ex).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!arr.length) return '';
  return arr.map(function (s) {
    if (/[「」]/.test(s)) return s;                       // 已经自己写过引号了，别动
    s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    return s ? '「' + s + '」' : '';
  }).filter(Boolean).join('、');
}

// 一键净化：去掉对模型没用的排版符号
function tidyText(s) {
  var out = String(s == null ? '' : s);
  if (/^\s*\|/.test(out)) return out;                    // markdown 表格行，别乱动
  out = out.replace(/\*\*/g, '');                        // 加粗对模型没用，纯噪声
  out = out.replace(/\s*\|\s*/g, '、');                   // A|B → A、B
  out = out.replace(/举例\s*[:：]\s*/g, '举例：');
  out = out.replace(/、{2,}/g, '、').replace(/、\s*、/g, '、');
  out = out.replace(/、\s*([，。！？；：])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}
function hash(s) {
  var h = 5381, str = String(s || '').replace(/\s+/g, ' ').trim();
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function nodeAt(fileId, path) {
  var n = TREES[fileId];
  if (!n) return null;
  for (var i = 0; i < path.length; i++) {
    if (!n.children || !n.children[path[i]]) return null;
    n = n.children[path[i]];
  }
  return n;
}
function parentAt(fileId, path) {
  return path.length ? nodeAt(fileId, path.slice(0, -1)) : null;
}
function titlesOf(fileId, path) {
  var out = [], n = TREES[fileId];
  if (!n) return out;
  for (var i = 0; i < path.length; i++) {
    n = n.children[path[i]];
    if (!n) break;
    out.push(n.title);
  }
  return out;
}
function resolveTitles(fileId, titles) {
  var path = [], n = TREES[fileId];
  if (!n) return null;
  for (var i = 0; i < titles.length; i++) {
    var idx = -1;
    for (var j = 0; j < (n.children || []).length; j++) if (n.children[j].title === titles[i]) { idx = j; break; }
    if (idx < 0) return null;
    path.push(idx); n = n.children[idx];
  }
  return path;
}
/* 快照要跳过 _ 开头的内部字段，否则 _snap 把自己也算进去 → 永远判定为「改过」 */
function snapOf(t) {
  return JSON.stringify(t, function (k, v) { return k.charAt(0) === '_' ? undefined : v; });
}
function isDirty(fileId) {
  return !!(TREES[fileId] && TREES[fileId]._snap !== snapOf(TREES[fileId]));
}
function markDirty(fileId) {
  renderFiles();
  renderTabs();
}
/* app 根节点（文件标题层） */
function rootNode(fileId) {
  var t = TREES[fileId];
  if (!t || !t.children || !t.children.length) return null;
  return t.children[0];
}
function openRoot(fileId) {
  var p = rootPath(fileId);
  if (!p) return -1;
  return openTab(fileId, p);
}
function rootPath(fileId) {
  var t = TREES[fileId];
  if (!t || !t.children || !t.children.length) {
    // 空文件：造一个占位标题
    t.children = [{ level: 1, title: FILES.filter(function (f) { return f.id === fileId; }).map(function (f) { return f.name; })[0] || '未命名', items: [], children: [] }];
    return [0];
  }
  return [0];
}

/* ---------- 数据装载 ---------- */
function boot() {
  return api('/api/all').then(function (r) {
    if (r.error) { toast(r.error); return; }
    FILES = r.files;
    GROUPS = Array.isArray(r.groups) ? r.groups : [];
    NAV = Array.isArray(r.nav) ? r.nav : [];
    FILEMETA = r.meta || {};
    TABLES_META = r.tablesMeta || [];
    TREES = {};
    SIGS = {};
    Object.keys(r.data).forEach(function (id) {
      TREES[id] = r.data[id].tree;
      TREES[id]._snap = snapOf(TREES[id]);
      TREES[id]._src = r.data[id].src || '';
      SIGS[id] = r.data[id].sig;
    });
    NEWS = r.news || {};
    if (!CUR || !TREES[CUR]) CUR = (FILES[0] && FILES[0].id) || null;
    if (CUR) {
      var has = TABS.some(function (t) { return t.fileId === CUR; });
      if (!has) openTab(CUR, rootPath(CUR));
      else { var i = TABS.findIndex(function (t) { return t.fileId === CUR; }); ACTIVE = i; }
    }
    renderAll();
    checkUpdates();   // 打开面板先看更新说明（有没确认的才弹）
  });
}

async function reloadFile(id) {
  var r = await api('/api/file?id=' + encodeURIComponent(id));
  if (r.error) { toast(r.error); return; }
  TREES[id] = r.tree;
  TREES[id]._snap = snapOf(r.tree);
  SIGS[id] = r.sig;
  // 标签按标题链重定位
  TABS.forEach(function (t) {
    if (t.fileId !== id) return;
    var p = resolveTitles(id, t.titles);
    if (p) { t.path = p; t.title = t.titles[t.titles.length - 1] || t.title; }
    else { t.path = []; t.dead = true; }
  });
  renderAll();
}

/* ---------- 左列：7 大类 + 自由文件夹（可拖拽换类/嵌套，可新建） ---------- */
var closedGroups = {};   // 'cat:xxx' / 'folder:xxx' → 收起
var DF = null;           // 拖拽中的东西：{kind:'file'|'folder', id}

// 分类标题：图标 + 名字 + 「什么时候用」+ 条数 + 悬停出现「＋文件夹」
// 拖文件到标题 = 归到这一类；拖文件夹到标题 = 把文件夹移到这一类
function catHead(c, n) {
  var h = el('div', 'fgroup' + (closedGroups['cat:' + c.id] ? ' closed' : ''));
  h.appendChild(el('span', 'caret'));
  h.appendChild(el('span', 'gname', (c.icon ? c.icon + ' ' : '') + c.name));
  if (c.when) { var w = el('span', 'when', c.when); w.title = c.when; h.appendChild(w); }
  h.appendChild(el('span', 'gcnt', String(n)));
  var add = el('button', 'fbtn', '＋夹');
  add.title = '在这一类下面新建一个文件夹（页面里起名，不弹浏览器窗）';
  add.onclick = function (e) {
    e.stopPropagation();
    newFolderInline(h, c.id, '');
  };
  h.appendChild(add);
  h.onclick = function () { closedGroups['cat:' + c.id] = !closedGroups['cat:' + c.id]; renderFiles(); };
  h.ondragover = function (e) { if (DF) { e.preventDefault(); h.classList.add('over'); } };
  h.ondragleave = function () { h.classList.remove('over'); };
  h.ondrop = function (e) {
    if (!DF) return;
    e.preventDefault(); e.stopPropagation();
    h.classList.remove('over');
    if (DF.kind === 'folder') moveFolder(DF.id, c.id, '');
    else moveToCat(DF.id, c.id);
  };
  return h;
}
// 页面内起名（不用原生 prompt：沙箱/预览面板里会被静默屏蔽）
function newFolderInline(host, cat, parent) {
  if (host.querySelector('input')) return;
  var inp = el('input');
  inp.placeholder = parent ? '子文件夹名，回车创建' : '文件夹名，回车创建';
  inp.style.cssText = 'width:110px;border:1px solid var(--ac);border-radius:6px;padding:2px 6px;font-size:12px;background:#fff';
  var btn = host.querySelector('.fbtn');
  host.insertBefore(inp, btn || null);
  inp.focus();
  var done = function (ok) {
    var v = (inp.value || '').trim();
    if (inp.parentNode) inp.parentNode.removeChild(inp);
    if (!ok || !v) return;
    POST('/api/folder/new', { name: v, cat: cat, parent: parent }).then(function (r) {
      if (r.error) return toast(r.error);
      closedGroups['cat:' + cat] = false;
      boot();
      toast('建好了「' + v + '」，把文件拖进来就行');
    });
  };
  inp.onblur = function () { done(true); };
  inp.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); inp.onblur = null; done(false); }
  };
}
// 文件夹标题：可点击收起、可拖拽（拖到别的大类/文件夹）、双击改名、悬停可删
function folderHead(fd, depth, cat) {
  var h = el('div', 'fgroup sub' + (closedGroups['folder:' + fd.id] ? ' closed' : ''));
  h.style.paddingLeft = (12 + depth * 16) + 'px';
  h.draggable = true;
  h.appendChild(el('span', 'caret'));
  var nm = el('span', 'gname', '📂 ' + fd.name);
  nm.title = '双击改名；拖到别的大类或文件夹上就能搬走';
  nm.ondblclick = function (e) {
    e.stopPropagation();
    renameFolderInline(nm, fd);
  };
  h.appendChild(nm);
  h.appendChild(el('span', 'gcnt', String((fd.items || []).length)));
  var add = el('button', 'fbtn', '＋夹');
  add.title = '在这个文件夹里再建一个子文件夹';
  add.onclick = function (e) { e.stopPropagation(); newFolderInline(h, cat.id, fd.id); };
  h.appendChild(add);
  var del = el('button', 'fbtn', '✕');
  del.title = '删掉这个空文件夹/文件夹（里面的文件会掉回大类底下，不会删文件）';
  del.onclick = function (e) {
    e.stopPropagation();
    confirmBox('删掉文件夹「' + fd.name + '」？\n文件夹里的文件会掉回「' + cat.name + '」底下，文件本身不会删。', function () {
      POST('/api/folder/delete', { id: fd.id }).then(function (r) {
        if (r.error) return toast(r.error);
        boot();
        toast('文件夹删了，文件还在');
      });
    });
  };
  h.appendChild(del);
  h.onclick = function () { closedGroups['folder:' + fd.id] = !closedGroups['folder:' + fd.id]; renderFiles(); };
  h.ondragstart = function (e) {
    if (h.querySelector('input')) { e.preventDefault(); return; }
    DF = { kind: 'folder', id: fd.id };
    h.classList.add('drag');
    try { e.dataTransfer.setData('text/plain', 'folder:' + fd.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
  };
  h.ondragend = function () { h.classList.remove('drag'); DF = null; };
  h.ondragover = function (e) {
    if (!DF) return;
    // 文件夹拖到文件夹上 = 嵌套进去（不能拖进自己/自己的子孙，前端先拦一道）
    if (DF.kind === 'folder' && DF.id !== fd.id && !isDescendantFolder(fd.id, DF.id)) { e.preventDefault(); h.classList.add('over'); }
    else if (DF.kind === 'file') { e.preventDefault(); h.classList.add('over'); }
  };
  h.ondragleave = function () { h.classList.remove('over'); };
  h.ondrop = function (e) {
    if (!DF) return;
    e.preventDefault(); e.stopPropagation();
    h.classList.remove('over');
    if (DF.kind === 'folder') {
      if (DF.id === fd.id) return toast('不能拖进自己里面');
      if (isDescendantFolder(fd.id, DF.id)) return toast('不能拖进自己的子文件夹里');
      moveFolder(DF.id, cat.id, fd.id);
      return;
    }
    if (DF.kind === 'file') moveToFolder(DF.id, fd.id);
  };
  return h;
}
// targetId 是不是 draggedId 的后代（防止把文件夹拖进自己子孙里）
function isDescendantFolder(targetId, draggedId) {
  if (targetId === draggedId) return true;
  var dragged = null;
  NAV.forEach(function (c) {
    (c.folders || []).forEach(function (fd) { var r = findFolder(fd, draggedId); if (r && !dragged) dragged = r; });
  });
  if (!dragged) return false;
  function walk(fd) {
    if (fd.id === targetId) return true;
    return (fd.folders || []).some(walk);
  }
  return (dragged.folders || []).some(walk);
}
function renameFolderInline(host, fd) {
  if (host.querySelector('input')) return;
  var old = host.textContent.replace(/^📂\s*/, '');
  var inp = el('input');
  inp.value = old;
  inp.style.cssText = 'width:110px;border:1px solid var(--ac);border-radius:6px;padding:2px 6px;font-size:12px;background:#fff';
  host.textContent = '';
  host.appendChild(inp);
  inp.focus(); inp.select();
  var done = function (ok) {
    var v = (inp.value || '').trim();
    host.textContent = '📂 ' + (ok && v && v !== old ? v : old);
    if (!ok || !v || v === old) return;
    POST('/api/folder/rename', { id: fd.id, name: v }).then(function (r) {
      if (r.error) return toast(r.error);
      boot();
      toast('改名了');
    });
  };
  inp.onblur = function () { done(true); };
  inp.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); inp.onblur = null; done(false); }
  };
}
// 拖拽换分类（写进 config.panel.catOverride，立即生效）
function moveToCat(fid, cat) {
  DF = null;
  POST('/api/cat', { file: fid, cat: cat }).then(function (r) {
    if (r.error) return toast(r.error);
    boot();
    toast('已归到这一类');
  });
}
// 拖进文件夹
function moveToFolder(fid, folder) {
  DF = null;
  POST('/api/folder', { file: fid, folder: folder }).then(function (r) {
    if (r.error) return toast(r.error);
    boot();
    toast('放进文件夹了');
  });
}
// 移动文件夹（换大类 / 嵌套进别的文件夹）
function moveFolder(fid, cat, parent) {
  DF = null;
  POST('/api/folder/move', { id: fid, cat: cat, parent: parent }).then(function (r) {
    if (r.error) return toast(r.error);
    boot();
    toast(parent ? '挪进这个文件夹了' : '文件夹换类了');
  });
}
function catCount(c) {
  var n = (c.items || []).length;
  (c.folders || []).forEach(function (f) { n += countFolder(f); });
  return n;
}
function countFolder(fd) {
  var n = (fd.items || []).length;
  (fd.folders || []).forEach(function (f) { n += countFolder(f); });
  return n;
}
// 左列一行：view=功能页 / md=可编辑文档 / 其他=只读或可改原文
function navRow(it, cat, depth) {
  if (it.kind === 'view') return viewRow(it, depth);
  if (it.kind === 'md') return fileRow(it, depth, it.use, cat);
  return rawRow(it, depth);
}
// 功能页（触发地图 / 聊天记录 / 写入日志 / 表格）
function viewRow(it, depth) {
  var row = el('div', 'frow');
  if (depth) row.style.paddingLeft = (12 + depth * 16) + 'px';
  var nm = el('div', 'fname', it.name);
  nm.title = (it.use || '') + '\n（面板功能，点开看）';
  var fid = it.id;
  var opener = fid === '__map' ? openMap
    : fid === '__chat' ? openChat
    : fid === '__who' ? openWho
    : fid === '__log' ? openLog
    : fid === '__topic' ? openTopic
    : fid === '__topics' ? openTopics
    : fid === '__promise' ? openPromise
    : fid === '__memes' ? function () { openMemes(); } // 不能直接挂 openMemes：onclick 会把事件对象当 prefill 传进去，热梗页就每次都自动弹表单（主人 2026-10-22：输入提示消失的根因）
    : fid === '__memedict' ? openMemeDict
    : fid === '__triggers' ? openTriggers
    : fid === '__features' ? openFeatures
    : fid === '__updates' ? openUpdates
    : fid === '__reqs' ? openReqs
    : fid === '__feedback' ? openFeedback
    : fid === '__people' ? function () { openPeople(); }
    : fid === '__thinking' ? openThinking
    : fid === '__cost' ? openCost
    : (fid.indexOf('__table_') === 0 ? function () { openTable(fid.replace('__table_', '')); } : function () {});
  var cur = activeTab();
  if (cur && cur.fileId === fid) nm.style.color = 'var(--ac)';
  nm.onclick = opener;
  row.appendChild(nm);
  return row;
}
// 只读 / 可改原文（代码、config、json）：带类型徽标 + 悬停用途和区间
function rawRow(it, depth) {
  var row = el('div', 'frow');
  if (depth) row.style.paddingLeft = (12 + depth * 16) + 'px';
  var badge = el('span', 'fbadge ' + (it.ro ? 'ro' : 'rw'), it.ro ? '🔒' : '✎');
  badge.title = it.ro ? '只读：怕你碰坏它，只能看' : '可改：保存前会校验格式，坏的不让存';
  row.appendChild(badge);
  var nm = el('div', 'fname', it.name);
  var tip = (it.use || '');
  if (it.range) tip += '\n区间 / 含义：' + it.range;
  tip += '\n' + (it.ro ? '（只读，点开看原文）' : '（点开可改原文）');
  nm.title = tip;
  var cur = activeTab();
  if (cur && cur.fileId === '__raw_' + it.id) nm.style.color = 'var(--ac)';
  // html 文件：不在面板里啃源码树，给它一个自己的页——里面既能「在浏览器里打开」看成品，也能「看代码原文」
  nm.onclick = (it.kind === 'html') ? function () { openHtmlFile(it.id); } : function () { openRaw(it.id); };
  row.appendChild(nm);
  return row;
}

function renderFiles() {
  var box = document.getElementById('flist');
  var scrollTop = box.scrollTop;
  box.textContent = '';
  NAV.forEach(function (c) {
    var n = catCount(c);
    box.appendChild(catHead(c, n));
    if (closedGroups['cat:' + c.id]) return;
    if (!n) { box.appendChild(el('div', 'gnone', '这一项还是空的')); return; }
    (c.items || []).forEach(function (it) { box.appendChild(navRow(it, c, 0)); });
    (c.folders || []).forEach(function (fd) { box.appendChild(folderNode(fd, c, 1)); });
  });
  box.scrollTop = scrollTop;
}
// 文件夹递归渲染（文件夹里还能套文件夹）：返回一个片段，交给 renderFiles 统一挂
function folderNode(fd, cat, depth) {
  var frag = document.createDocumentFragment();
  frag.appendChild(folderHead(fd, depth, cat));
  if (!closedGroups['folder:' + fd.id]) {
    (fd.items || []).forEach(function (it) { frag.appendChild(navRow(it, cat, depth)); });
    (fd.folders || []).forEach(function (sub) { frag.appendChild(folderNode(sub, cat, depth + 1)); });
  }
  return frag;
}

// 一个文件现在挂在哪个「组」里（大类根 或 某个文件夹）——拖拽排序/跨组移动都要用
function groupOfFile(fid) {
  var hit = null;
  NAV.forEach(function (c) {
    if ((c.items || []).some(function (x) { return x.id === fid; })) hit = { kind: 'cat', id: c.id, name: c.name };
    (c.folders || []).forEach(function (fd) {
      if (findInFolder(fd, fid)) hit = { kind: 'folder', id: fd.id, name: fd.name, cat: c.id };
    });
  });
  return hit;
}
function findInFolder(fd, fid) {
  if ((fd.items || []).some(function (x) { return x.id === fid; })) return true;
  return (fd.folders || []).some(function (sub) { return findInFolder(sub, fid); });
}
function groupMemberIds(g) {
  if (!g) return [];
  if (g.kind === 'cat') {
    var c = NAV.find(function (x) { return x.id === g.id; });
    return c ? (c.items || []).map(function (x) { return x.id; }) : [];
  }
  var out = null;
  NAV.forEach(function (c) {
    (c.folders || []).forEach(function (fd) {
      var f = findFolder(fd, g.id);
      if (f) out = (f.items || []).map(function (x) { return x.id; });
    });
  });
  return out || [];
}
function findFolder(fd, id) {
  if (fd.id === id) return fd;
  for (var i = 0; i < (fd.folders || []).length; i++) {
    var r = findFolder(fd.folders[i], id);
    if (r) return r;
  }
  return null;
}
// 同一个组里换位置：写进 panel.order（后端 buildNav 按它排序，立刻生效）
function reorderInGroup(from, toId, after) {
  var g = groupOfFile(toId);
  var ids = groupMemberIds(g).slice();
  var i = ids.indexOf(from);
  if (i < 0) return;
  ids.splice(i, 1);
  var at = ids.indexOf(toId);
  if (at < 0) ids.push(from); else ids.splice(at + (after ? 1 : 0), 0, from);
  // 全局顺序：保持原有顺序，只把这一组成员按新序列插回原位置
  var all = FILES.map(function (f) { return f.id; });
  var others = all.filter(function (x) { return ids.indexOf(x) < 0; });
  var pos = all.findIndex(function (x) { return ids.indexOf(x) >= 0; });
  var order = pos < 0 ? others.concat(ids) : others.slice(0, pos).concat(ids, others.slice(pos));
  POST('/api/order', { order: order }).then(function () {
    boot();
    toast('换个位置');
  });
}
// 拖到一个文件行上：同组 = 排序；不同组 = 归到那个文件的组里
function moveFile(from, toId, after) {
  DF = null;
  if (!from || from === toId) return;
  var ga = groupOfFile(from), gb = groupOfFile(toId);
  if (gb && (!ga || ga.kind !== gb.kind || ga.id !== gb.id)) {
    if (gb.kind === 'cat') moveToCat(from, gb.id);
    else moveToFolder(from, gb.id);
    return;
  }
  reorderInGroup(from, toId, after);
}

function fileRow(f, depth, when, cat) {
  var row = el('div', 'frow' + (f.id === CUR ? ' on' : ''));
  if (depth) row.style.paddingLeft = (12 + depth * 16) + 'px';
  var doc = el('span', 'fbadge doc', '📄');
  doc.title = '文档：内容和结构都能改。删了不可恢复（机器人要用的文件后端会拦）';
  row.appendChild(doc);
  row.draggable = true;
  row.ondragstart = function (e) {
    if (row.querySelector('input')) { e.preventDefault(); return; }
    DF = { kind: 'file', id: f.id };
    row.classList.add('drag');
    // 带上自定义数据 + move 效果，浏览器就不会把它当成「拖拽搜索 / 拖拽打开」
    try { e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
  };
  row.ondragend = function () { row.classList.remove('drag'); DF = null; };
  row.ondragover = function (e) { if (DF && DF.kind === 'file') e.preventDefault(); };
  row.ondrop = function (e) {
    if (!DF || DF.kind !== 'file') return;
    e.preventDefault();
    var r = row.getBoundingClientRect();
    moveFile(DF.id, f.id, (e.clientY - r.top) > r.height / 2);
  };

  var nm = el('div', 'fname', f.name);
  nm.title = f.id + (when ? '\n什么时候用：' + when : '') + '\n单击打开，双击改名';
  nm.onclick = function () {
    PAGE = null;                       // 点开 md 文件 → 回到标签模式
    CUR = f.id;
    var best = -1, bestSeen = -1;
    TABS.forEach(function (x, idx) {
      if (x.fileId !== f.id) return;
      var seen = x.seen || 0;
      if (seen > bestSeen) { bestSeen = seen; best = idx; }
    });
    if (best >= 0) ACTIVE = best; else openRoot(f.id);
    renderFiles(); renderTabs(); renderContent();
  };
  nm.ondblclick = function (e) {
    e.stopPropagation();
    startRename(f, nm);
  };

  var sv = el('button', 'fbtn', isDirty(f.id) ? '保存' : '已存');
  if (isDirty(f.id)) sv.className = 'fbtn dot';
  sv.title = isDirty(f.id) ? '点一下写回文件（Ctrl+S 也一样）' : '没有改动';
  sv.onclick = function (e) {
    e.stopPropagation();
    if (!isDirty(f.id)) return toast('这个文件没有改动');
    saveFile(f.id);
  };

  var sync = el('button', 'fbtn', '↻');
  sync.title = '文件在外面被改过？点这重读';
  sync.style.opacity = '0';
  sync.dataset.sync = f.id;
  sync.onclick = function (e) { e.stopPropagation(); reloadFile(f.id); };

  var del = el('button', 'fbtn', '✕');
  del.title = '删除这个文件';
  del.onclick = function (e) {
    e.stopPropagation();
    confirmBox('删掉文件「' + f.name + '」？这个删除不可恢复。', function () {
      POST('/api/delete', { id: f.id }).then(function (r) {
        if (r.error) return toast(r.error);
        TABS = TABS.filter(function (t) { return t.fileId !== f.id; });
        if (ACTIVE >= TABS.length) ACTIVE = TABS.length - 1;
        delete TREES[f.id];
        boot();
      });
    });
  };

  row.appendChild(nm); row.appendChild(sv); row.appendChild(sync); row.appendChild(del);
  return row;
}
function startRename(f, host) {
  if (host.querySelector('input')) return;
  var inp = el('input');
  inp.value = f.name;
  host.textContent = '';
  host.appendChild(inp);
  inp.focus(); inp.select();
  var done = function (ok) {
    var v = (inp.value || '').trim();
    if (!ok || !v || v === f.name) { renderFiles(); return; }
    POST('/api/rename', { id: f.id, name: v }).then(function (r) {
      if (r.error) { toast(r.error); renderFiles(); return; }
      if (r.needRestart) toast('改名成功，重启一次机器人后生效');
      boot();
    });
  };
  inp.onblur = function () { done(true); };
  inp.onkeydown = function (e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); inp.onblur = null; done(false); }
  };
}

async function saveFile(id) {
  var tree = TREES[id];
  if (!tree) return toast('这个文件还没加载，刷新一下');
  try {
    var r = await POST('/api/save', { id: id, tree: cleanTree(tree) });
    if (r.error) return toast('没存上：' + r.error);
    tree._snap = snapOf(tree);
    TREES[id]._src = r.src || '';
    SIGS[id] = r.sig;
    renderFiles(); renderTabs();
    toast('已保存');
  } catch (e) {
    toast('没存上：' + (e && e.message ? e.message : '面板连不上自己了，刷新页面试试'));
  }
}

/* 客户端也做一遍消毒：换行压成空格、层级钳制，避免写出坏 md */
function cleanTree(root) {
  function one(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); }
  function walk(n, depth) {
    var o = {
      level: Math.max(1, Math.min(depth + 1, 12)),
      title: one(n.title) || '未命名',
      items: (n.items || []).map(function (i) {
        return {
          t: i.t === 'p' ? 'p' : 'li',
          text: one(i.text),
          d: /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(i.d || '').trim()) ? String(i.d).trim() : '',
          ind: Math.max(0, Math.min(10, parseInt(i.ind, 10) || 0))
        };
      }).filter(function (i) { return i.text; }),
      children: (n.children || []).map(function (c) { return walk(c, depth + 1); })
    };
    return o;
  }
  return { children: (root.children || []).map(function (c) { return walk(c, 0); }) };
}

/* ---------- 标签栏（只放 md 文件；功能页/原文页走 PAGE，不进标签） ---------- */
function openTab(fileId, path) {
  if (!path) return -1;
  PAGE = null;                       // 点开 md 文件 → 回到标签模式
  var key = fileId + '|' + path.join('.');
  var i = TABS.findIndex(function (t) { return t.fileId === fileId && t.path.join('.') === path.join('.'); });
  if (i >= 0) { ACTIVE = i; renderTabs(); renderContent(); return i; }
  var n = nodeAt(fileId, path);
  var name = (FILES.find(function (f) { return f.id === fileId; }) || {}).name || '';
  TABS.push({
    fileId: fileId, path: path.slice(),
    titles: titlesOf(fileId, path),
    title: n ? n.title : name,
    parent: TABS.length ? { fileId: TABS[ACTIVE] && TABS[ACTIVE].fileId, path: TABS[ACTIVE] ? TABS[ACTIVE].path.slice() : null } : null
  });
  ACTIVE = TABS.length - 1;
  renderTabs(); renderContent();
  return ACTIVE;
}

/* ---------- 已关闭：按「文件 + 层级」分行记 ---------- */
function lvKey(fid, lv) { return fid + '#' + lv; }
// 不是 md 文件的「合成页」：聊天记录 / 数据表 / 触发地图 / 话题日志 / 看某人
function isSynthetic(fid) { return fid === '__chat' || fid === '__map' || fid === '__log' || fid === '__topic' || fid === '__topics' || fid === '__promise' || fid === '__who' || fid === '__memes' || fid === '__memedict' || fid === '__triggers' || fid === '__features' || fid === '__updates' || fid === '__reqs' || fid === '__feedback' || fid === '__people' || fid === '__thinking' || fid === '__multitruth' || String(fid).indexOf('__table_') === 0 || String(fid).indexOf('__html_') === 0 || String(fid).indexOf('__raw_') === 0; }

function pushClosed(fileId, t, pos) {
  var key = lvKey(fileId, t.path.length);
  var arr = CLOSED[key] || (CLOSED[key] = []);
  arr.push({ titles: t.titles.slice(), title: t.title, pos: pos == null ? arr.length : pos });
}

// 去掉无效记录：标题链已经找不到的、以及其实还开着的页面，都不算「被关掉」
function pruneClosed() {
  Object.keys(CLOSED).forEach(function (key) {
    var fid = key.split('#')[0];
    var keep = (CLOSED[key] || []).filter(function (c) {
      var p = resolveTitles(fid, c.titles.slice());
      if (!p) return false;
      return !TABS.some(function (t) { return t.fileId === fid && t.path.join('.') === p.join('.'); });
    });
    if (keep.length) CLOSED[key] = keep; else delete CLOSED[key];
  });
}

function closeTab(i) {
  if (i < 0 || i >= TABS.length) return;
  var t = TABS[i];
  if (!isSynthetic(t.fileId)) pushClosed(t.fileId, t, t.path[t.path.length - 1] || 0);
  TABS.splice(i, 1);
  if (ACTIVE > i) ACTIVE--;
  if (ACTIVE >= TABS.length) ACTIVE = TABS.length - 1;
  if (ACTIVE < 0 && TABS.length) ACTIVE = 0;
  renderTabs(); renderContent(); renderFiles();
}

function renderTabs() {
  pruneClosed();
  var box = document.getElementById('tabscroll');
  var keepScroll = box.scrollTop;
  var keeps = {};
  Array.prototype.forEach.call(box.querySelectorAll('.tstrip'), function (s) { keeps[s.dataset.key] = s.scrollLeft; });
  box.textContent = '';
  // 标签条只放 md 文件：一个 md 都没开就整条藏起来（功能页/原文页不走标签）
  var tabbar = document.querySelector('.tabbar');
  if (tabbar) tabbar.style.display = TABS.length ? '' : 'none';

  // 文件顺序跟着左列；一个页面都不剩的文件整块不显示（它的已关闭记录也一起丢掉）
  var order = [];
  FILES.forEach(function (f) { if (TABS.some(function (t) { return t.fileId === f.id; })) order.push(f.id); });
  TABS.forEach(function (t) { if (order.indexOf(t.fileId) < 0) order.push(t.fileId); });
  Object.keys(CLOSED).forEach(function (key) {
    if (order.indexOf(key.split('#')[0]) < 0) delete CLOSED[key];
  });

  order.forEach(function (fid) {
    var mine = [];
    TABS.forEach(function (t, i) { if (t.fileId === fid) mine.push({ t: t, i: i }); });
    var f = FILES.find(function (x) { return x.id === fid; }) || { name: (mine[0] && mine[0].t.name) || fid };
    // 同级内按路径排：位置稳定，不会跳来跳去
    mine.sort(function (a, b) {
      var pa = a.t.path, pb = b.t.path;
      var n = Math.max(pa.length, pb.length);
      for (var k = 0; k < n; k++) {
        var x = pa[k] == null ? -1 : pa[k], y = pb[k] == null ? -1 : pb[k];
        if (x !== y) return x - y;
      }
      return 0;
    });

    // 已经回到最上一层（只剩根页）时，之前的「已关闭」全部作废：这一行不该再挂恢复按钮
    var deepest = 0;
    mine.forEach(function (x) { if (x.t.path.length > deepest) deepest = x.t.path.length; });
    if (deepest <= 1) {
      Object.keys(CLOSED).forEach(function (key) {
        if (key.split('#')[0] === fid) delete CLOSED[key];
      });
    }

    // 按层级分行：第 1 层一行、第 2 层一行…同一级排在同一条线上
    var lvs = [];
    mine.forEach(function (x) { if (lvs.indexOf(x.t.path.length) < 0) lvs.push(x.t.path.length); });
    Object.keys(CLOSED).forEach(function (key) {
      var p = key.split('#');
      if (p[0] === fid) { var lv = Number(p[1]); if (lvs.indexOf(lv) < 0) lvs.push(lv); }
    });
    lvs.sort(function (a, b) { return a - b; });

    lvs.forEach(function (lv, idx) {
      var row = el('div', 'tabrow');
      row.style.paddingLeft = (idx * 18) + 'px';        // 下一级往右缩：上一级在左，下一级在右

      if (idx === 0 && isSynthetic(fid)) {
        row.appendChild(el('div', 'rname'));
      } else if (idx === 0) {
        var nm = el('div', 'rname', f.name);
        nm.title = f.name + '（点一下打开这个文件）';
        nm.onclick = function () {
          var has = TABS.findIndex(function (t) { return t.fileId === fid && t.path.length === 1; });
          if (has >= 0) { ACTIVE = has; renderTabs(); renderContent(); }
          else if (rootPath(fid)) { openRoot(fid); renderAll(); }
        };
        row.appendChild(nm);
      } else {
        row.appendChild(el('div', 'rname'));
      }

      var key = lvKey(fid, lv);
      var strip = el('div', 'tstrip');
      strip.dataset.key = key;
      var any = false;
      mine.forEach(function (x) {
        if (x.t.path.length !== lv) return;
        any = true;
        strip.appendChild(makeTab(x.t, x.i));
      });
      if (!any) strip.appendChild(el('div', 'noneed', '全关了'));
      row.appendChild(strip);

      // 这一行自己的「已关闭」：前3 / 后3 只算这一行，后3 从最右往左数
      var cl = CLOSED[key] || [];
      if (cl.length) {
        var cb = el('span', 'cbox');
        cb.title = cl.map(function (c) { return c.title; }).join('\n');
        cb.appendChild(el('span', 'cnt', String(cl.length)));
        [['前3', 'first'], ['后3', 'last'], ['全部', 'all']].forEach(function (b) {
          var btn = el('button', null, b[0]);
          btn.onclick = function (e) { e.stopPropagation(); restoreClosed(key, b[1]); };
          cb.appendChild(btn);
        });
        row.appendChild(cb);
      }

      if (any && !isSynthetic(fid)) {
        var rx = el('button', 'rx', '✕');
        rx.title = '关掉这一整行';
        rx.onclick = function (e) { e.stopPropagation(); closeRow(fid, lv); };
        row.appendChild(rx);
      }
      box.appendChild(row);
    });
  });

  box.scrollTop = keepScroll;
  Array.prototype.forEach.call(box.querySelectorAll('.tstrip'), function (s) {
    var v = keeps[s.dataset.key];
    if (v) s.scrollLeft = v;
  });
  var on = box.querySelector('.tab.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function makeTab(t, i) {
  var tab = el('div', 'tab' + (i === ACTIVE ? ' on' : ''));
  tab.title = t.titles.join(' › ') || t.title;
  if (t.path.length > 1) {
    var bk = el('button', 'back', '‹');
    bk.title = '回到上一级';
    bk.onclick = function (e) { e.stopPropagation(); goBack(i); };
    tab.appendChild(bk);
  }
  var lb = el('div', 'lb', t.title || '未命名');
  lb.onclick = function () { ACTIVE = i; renderTabs(); renderContent(); };
  tab.appendChild(lb);
  if (hasNewsForTab(t)) { var d = el('span', 'dot'); d.title = '机器人写过新内容'; tab.appendChild(d); }
  var x = el('button', 'x', '✕');
  x.title = '关掉这个页面';
  x.onclick = function (e) { e.stopPropagation(); closeTab(i); };
  tab.appendChild(x);
  return tab;
}

// ===== 聊天记录（只读）：只列别人说的，它怎么回的要点一下才展开 =====
var CHAT = null;

async function loadChat(all) {
  var r = await api('/api/chat' + (all ? '?all=1' : ''));
  if (r && r.list) { CHAT = r; if (all) CHAT.full = true; }
}

async function openChat() {
  openPage('__chat', function () { return { fileId: '__chat', path: [], titles: ['聊天记录'], title: '聊天记录', name: '聊天记录' }; }, function () {
    return loadChat().then(function () { return loadEmobook(); });
  });
}

/* ---------- 触发地图：它到底什么时候会说话 ---------- */
async function openMap() {
  openPage('__map', function () { return { fileId: '__map', path: [], titles: ['触发地图'], title: '触发地图', name: '触发地图' }; }, loadMap);
}
function loadMap() {
  return api('/api/triggers').then(function (r) { MAP = r && r.paths ? r : null; return MAP; });
}

/* ---------- 写入日志：它主动写进文件/记忆的每一条，可一键清空（真删） ---------- */
var LOGS = null;
function loadLogs() {
  return api('/api/logs').then(function (r) { LOGS = (r && r.list) ? r : { list: [], total: 0 }; return LOGS; });
}
async function openLog() {
  openPage('__log', function () { return { fileId: '__log', path: [], titles: ['写入日志'], title: '写入日志', name: '写入日志' }; }, loadLogs);
}
function renderLog(t, box) {
  box.appendChild(el('div', 'crumb')).appendChild(el('b', null, '我的控制台'));
  box.appendChild(el('h1', 'pg', '机器人写入日志'));
  if (!LOGS) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingLog) { window.__loadingLog = 1; loadLogs().then(function () { window.__loadingLog = 0; renderContent(); }); }
    return;
  }
  box.appendChild(el('p', 'pgsub', '它每次主动写进文件/记忆，这里就多一条，当前 ' + (LOGS.total || LOGS.list.length) + ' 条。「清空」只删这份日志，不影响它已经写进记忆/喜好的内容。'));
  var bar = el('div', 'cbar');
  var bRe = el('button', 'cdel', '↻ 刷新'); bRe.onclick = function () { loadLogs().then(renderContent); }; bar.appendChild(bRe);
  bar.appendChild(el('span', 'cspacer'));
  var bClr = el('button', 'cdel danger', '清空日志');
  bClr.title = '真的删掉 data/bot-writes.jsonl 的全部内容';
  bClr.onclick = function () {
    confirmBox('清空写入日志？\n这会真的删掉日志文件的内容（它已经写进记忆/喜好的内容不受影响）。', function () {
      POST('/api/logs/clear', {}).then(function (r) {
        if (r.error) return toast(r.error);
        toast('日志已清空');
        loadLogs().then(renderContent);
      });
    });
  };
  bar.appendChild(bClr);
  box.appendChild(bar);
  if (!LOGS.list.length) { box.appendChild(el('div', 'empty', '还没有记录。它主动记东西的时候，这里就会出现。')); return; }
  var list = el('div', 'items');
  LOGS.list.slice().reverse().forEach(function (e) {
    var card = el('div', 'cht');
    var head = el('div', 'chh');
    head.appendChild(el('span', 'chn', e.action || '写入'));
    if (e.file) head.appendChild(el('span', 'csc', e.file));
    head.appendChild(el('span', 'chtm', fmtTs(e.t)));
    card.appendChild(head);
    var tx = el('div', 'chtx'); tx.textContent = e.text || ''; card.appendChild(tx);
    list.appendChild(card);
  });
  box.appendChild(list);
}

/* ---------- 话题日志 / 话题 / 约定（长期记忆的三个入口，主人 2026-10-22 定） ----------
 * 话题日志（__topic）：可能是话题的内容——它总结的 / 别人的原文 / 搜到的 / 手动录的，没总结的可点「让它总结」
 *   总结 = 新建一条已总结话题，原来的内容挂到它底下（灰色）
 * 话题（__topics）：总结好、收进来的（长期记忆，和约定并行），聊到相关的它会接上
 * 约定（__promise）：说过的要做到（旧名「随手记的」，内容已搬进来）
 * 三页共用一套筛选：按时间 / 按群私聊 / 按会话 / 按人物，类型、会话、人物、关键词都可筛
 */
var TOPIC = null;
var topicF = { view: 'topiclog', scope: '', who: '', type: '', q: '', group: 'time', pick: false };
var TOPIC_SEL = {};                                  // 批量删除：勾上的 id（主人 2026-10-23 定）
function topicSelCount() { return Object.keys(TOPIC_SEL).length; }
function topicSelToggle(box) {                        // 一组勾的全放进/全拿出（box 里带 --tid 的复选框）
  var cbs = box.querySelectorAll('input[data-tid]');
  var on = false;
  for (var i = 0; i < cbs.length; i++) if (!cbs[i].checked) { on = true; break; }
  for (var j = 0; j < cbs.length; j++) {
    cbs[j].checked = on;
    if (on) TOPIC_SEL[cbs[j].getAttribute('data-tid')] = 1; else delete TOPIC_SEL[cbs[j].getAttribute('data-tid')];
  }
  return topicSelCount();
}

function loadTopics() {
  var q = ['view=' + topicF.view];
  if (topicF.scope) q.push('scope=' + encodeURIComponent(topicF.scope));
  if (topicF.who) q.push('who=' + encodeURIComponent(topicF.who));
  if (topicF.type) q.push('type=' + topicF.type);
  if (topicF.q) q.push('q=' + encodeURIComponent(topicF.q));
  return api('/api/topic?' + q.join('&')).then(function (r) {
    if (r && r.list) TOPIC = r;
    return TOPIC;
  });
}
async function openTopicView(view, title, fid) {
  topicF.view = view;
  openPage(fid, function () { return { fileId: fid, path: [], titles: [title], title: title, name: title }; }, loadTopics);
}
function openTopic() { return openTopicView('topiclog', '话题日志', '__topic'); }
function openTopics() { return openTopicView('topics', '话题', '__topics'); }
function openPromise() { return openTopicView('promise', '约定', '__promise'); }
function topicTypeBadge(it) {
  var tp = (TOPIC && TOPIC.types && TOPIC.types[it.type]) || { name: it.type, color: '#94a3b8' };
  var b = el('span', 'ttp', tp.name);
  b.style.background = tp.color;
  b.title = it.type === 'self' ? '它自己总结出来的'
    : it.type === 'quote' ? '别人的原文（觉得可能是话题就记下了）'
    : it.type === 'search' ? '联网搜索时记下的'
    : '手动录入的';
  return b;
}
function topicStateBadge(it) {
  var s = el('span', 'tst ' + it.state, it.state === 'kept' ? '已收进话题' : it.state === 'summed' ? '已总结' : '没总结');
  s.title = it.state === 'kept' ? '在「话题」里，每轮对话都带着'
    : it.state === 'summed' ? '总结好了，可以收进「话题」' : '还没总结，点「让它总结」';
  return s;
}
function topicTopicBadge(it) {
  if (!it.topic && !(it.pid && it.owner)) return null;
  var b = el('span', 'tpk');
  /* 约定的标签不自己编：名字永远按 qq 去人物表取（服务端算好的 owner / pid），
   * 标签串只当历史快照——人物表里改了名字，这里立刻跟着变。
   * 点一下跳到人物列表里这个人（展开他的资料卡）。 */
  var m = /^跟(.+)的约定$/.exec(String(it.topic || ''));
  // 老条目可能没写标签（空 topic）：约定挂在人身上，名字照样能从人物表现算
  if (it.pid && it.owner && (m || !it.topic)) {
    b.textContent = '＃跟' + it.owner + '的约定';
    b.className = 'tpk tpk-link';
    b.title = '跟「' + it.owner + '」的约定（名字来自人物表）· 点一下打开人物列表里的他';
    b.onclick = function (ev) { ev.stopPropagation(); openPeopleAt(it.pid); };
    return b;
  }
  b.textContent = '＃' + it.topic;
  b.title = '分类：' + it.topic;
  return b;
}
// 一条话题卡片。kid=true = 挂在已总结话题底下的原文（灰色、只能删）
function topicCard(it, box, opts) {
  opts = opts || {};
  var card = el('div', 'tcard' + (opts.kid ? ' kid' : ''));
  var head = el('div', 'chh');
  // 批量删除模式：每条前面一个勾（含挂在已总结话题底下的原文，想删也能勾）
  if (topicF.pick) {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-tid', it.id);
    cb.style.cssText = 'margin-right:6px;vertical-align:middle';
    cb.checked = !!TOPIC_SEL[it.id];
    cb.title = '勾上就是选中；底下的按钮能一次删掉勾住的全部';
    cb.onchange = function () {
      if (cb.checked) TOPIC_SEL[it.id] = 1; else delete TOPIC_SEL[it.id];
      if (window.__topicPickCount) window.__topicPickCount();
    };
    head.appendChild(cb);
  }
  head.appendChild(topicTypeBadge(it));
  if (opts.kid) {
    var raw = el('span', 'tst raw', '原文');
    raw.title = '总结前的原始内容，挂在上面那个已总结话题底下';
    head.appendChild(raw);
  } else if (topicF.view === 'promise') {
    var tb = topicTopicBadge(it);
    if (tb) head.appendChild(tb);
  } else {
    head.appendChild(topicStateBadge(it));
  }
  if (it.star) {
    var sb = el('span', 'csc', '星标联动');
    sb.title = '这条是聊天记录加星标时自动建的（星标=直接算已总结）；取消星标会一起收走';
    head.appendChild(sb);
  }
  // 署名也读人物表（约定行）：服务端给了 owner 就用它，别显示 QQ 资料卡名
  var whoTxt = it.owner || it.who;
  if (whoTxt) {
    var whoSpan = el('span', 'csc' + (it.owner && it.pid ? ' csc-link' : ''), whoTxt);
    if (it.owner && it.pid) {
      whoSpan.title = '名字来自人物表 · 点一下打开人物列表里的他';
      whoSpan.onclick = function (ev) { ev.stopPropagation(); openPeopleAt(it.pid); };
    }
    head.appendChild(whoSpan);
  }
  if (it.scope) head.appendChild(el('span', 'csc', it.scope));
  head.appendChild(el('span', 'chtm', fmtTs(it.t)));
  card.appendChild(head);
  var tx = el('div', 'chtx');
  tx.textContent = it.text;
  card.appendChild(tx);
  var bar = el('div', 'tbar');
  if (!opts.kid && it.state === 'raw') {
    var bSum = el('button', 'cdel', '让它总结');
    bSum.title = '让模型把这段概括成一句话话题；总结后会新建一条已总结话题，这段原文挂到它底下（灰色）';
    bSum.onclick = function () {
      bSum.textContent = '总结中…'; bSum.disabled = true;
      POST('/api/topic/sum', { id: it.id }).then(function (r) {
        if (r.error) { toast(r.error); bSum.textContent = '让它总结'; bSum.disabled = false; return; }
        toast('总结好了，原文挂在它底下了');
        loadTopics().then(function () { if (opts.after) opts.after(); else renderContent(); });
      });
    };
    bar.appendChild(bSum);
  }
  if (!opts.kid && it.state === 'summed') {
    var bKeep = el('button', 'cdel', '收进话题');
    bKeep.title = '移进「话题」——那是长期记忆，之后每轮对话都带着，聊到相关的它会接上';
    bKeep.onclick = function () {
      POST('/api/topic/keep', { id: it.id }).then(function (r) {
        if (r.error) return toast(r.error);
        toast('收进「话题」了');
        loadTopics().then(function () { if (opts.after) opts.after(); else renderContent(); });
      });
    };
    bar.appendChild(bKeep);
  }
  if (!opts.kid && topicF.view === 'topics') {
    var bBack = el('button', 'cdel', '挪回话题日志');
    bBack.title = '从「话题」里挪回话题日志（没收好就退回去）';
    bBack.onclick = function () {
      POST('/api/topic/unkeep', { id: it.id }).then(function (r) {
        if (r.error) return toast(r.error);
        toast('挪回话题日志了');
        loadTopics().then(function () { if (opts.after) opts.after(); else renderContent(); });
      });
    };
    bar.appendChild(bBack);
  }
  // 收进热梗（主人 2026-10-22：有一条话题本身就是一次正确的玩梗，改改就能当范例）：
  // 跳到热梗页带预填——已总结的把总结当含义、原文当范例；没总结的原文当范例
  if (!opts.kid && topicF.view !== 'promise') {
    var bMeme = el('button', 'cdel', '收进热梗');
    bMeme.title = '把这条当玩梗范例收进「网络热梗」（长期记忆）：含义、特征词接着改就行';
    bMeme.onclick = function () {
      openMemes(it.state === 'summed' ? { meaning: it.sum || '', ex: it.text } : { meaning: '', ex: it.text });
    };
    bar.appendChild(bMeme);
  }
  // 改（主人 2026-10-22 v52 定：话题总结后可以具体修改；页内弹层编辑）
  if (!opts.kid) {
    var bEdit = el('button', 'cdel', '改');
    bEdit.title = '修改这条的内容/分类（总结过的也能改，改完就是改后的算数）';
    bEdit.onclick = function () {
      editBox('修改话题', it.text, it.topic || '', function (ntxt, ntop) {
        POST('/api/topic/edit', { id: it.id, text: ntxt, topic: ntop }).then(function (r) {
          if (r.error) return toast(r.error);
          it.text = r.item.text; it.topic = r.item.topic;
          toast('改好了');
          renderContent();
        });
      });
    };
    bar.appendChild(bEdit);
  }
  var bDel = el('button', 'cdel danger', '删');
  bDel.title = opts.kid ? '删掉这段原文' : '删掉这条';
  bDel.onclick = function () {
    var msg = opts.kid ? '删掉这段原文？' : (it.state === 'summed' ? '删掉这个已总结话题？\n它底下的原文会回到话题日志里（不会连坐）。' : '删掉这条？');
    confirmBox(msg, function () {
      POST('/api/topic/del', { id: it.id }).then(function (r) {
        if (r.error) return toast(r.error);
        loadTopics().then(function () { if (opts.after) opts.after(); else renderContent(); });
      });
    });
  };
  bar.appendChild(bDel);
  card.appendChild(bar);
  // 已总结话题：原文挂在底下（灰色）
  (it.kids || []).forEach(function (k) { topicCard(k, card, { kid: true, after: opts.after }); });
  box.appendChild(card);
}
var TOPIC_META = {
  topiclog: { title: '话题日志', sub: '可能是话题的内容都记在这：它自己总结的 / 别人的原文 / 联网搜到的 / 你手动录的。没总结的点「让它总结」——会新建一条已总结话题，原文挂到它底下（灰色）。总结好了点「收进话题」。' },
  topics:   { title: '话题', sub: '总结好、记住的话题，算是长期记忆（和「约定」并行）。之后每轮对话都带着，聊到相关的它会接上，不装陌生。' },
  promise:  { title: '约定', sub: '说过的要做到：主人交代的、它自己记的，都在这。旧名「随手记的」，内容已经搬进来了。' },
};
function renderTopic(t, box) {
  if (!TOPIC || TOPIC.view !== topicF.view) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingTopic) { window.__loadingTopic = 1; loadTopics().then(function () { window.__loadingTopic = 0; renderContent(); }); }
    return;
  }
  var meta = TOPIC_META[topicF.view] || TOPIC_META.topiclog;
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '长期记忆'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', meta.title));
  var cnt = TOPIC.counts || {};
  var subTxt = meta.sub + ' 当前 ' + TOPIC.total + ' 条'
    + (topicF.view === 'topiclog' ? '（没总结的 ' + (cnt.raw || 0) + ' 条、已总结的 ' + (cnt.summed || 0) + ' 条）。'
      : topicF.view === 'topics' ? '（话题日志里还有 ' + (cnt.raw || 0) + ' 条没总结）。'
      : '。');
  box.appendChild(el('p', 'pgsub', subTxt));

  var listBox = el('div', 'clist');
  var bar = el('div', 'cbar');
  var mk = function (label, on, fn, tip) {
    var b = el('button', 'cchip' + (on ? ' on' : ''), label);
    if (tip) b.title = tip;
    b.onclick = fn;
    return b;
  };
  // 分组方式：按时间 / 按群私聊（主分类）/ 按会话 / 按人物（并行分类，可自由切换）
  bar.appendChild(mk('按时间', topicF.group === 'time', function () { topicF.group = 'time'; renderContent(); }, '按发生顺序排'));
  bar.appendChild(mk('按群/私聊', topicF.group === 'kind', function () { topicF.group = 'kind'; renderContent(); }, '群聊和私聊各自一类（主要分类）'));
  bar.appendChild(mk('按会话', topicF.group === 'scope', function () { topicF.group = 'scope'; renderContent(); }, '按每个群 / 每个私聊分开看'));
  bar.appendChild(mk('按人物', topicF.group === 'who', function () { topicF.group = 'who'; renderContent(); }, '按说话人分开看（并行分类）'));
  bar.appendChild(el('span', 'cspacer'));
  // 类型（颜色不同，悬停看类型说明）
  bar.appendChild(mk('全部类型', !topicF.type, function () { topicF.type = ''; renderContent(); }));
  Object.keys(TOPIC.types || {}).forEach(function (k) {
    var tp = TOPIC.types[k];
    var b = el('button', 'cchip' + (topicF.type === k ? ' on' : ''), tp.name);
    b.style.borderColor = tp.color;
    b.title = tp.name + '（' + (k === 'self' ? '它自己总结的' : k === 'quote' ? '别人的原文' : k === 'search' ? '联网搜到的' : '手动录入的') + '）';
    b.onclick = function () { topicF.type = topicF.type === k ? '' : k; renderContent(); };
    bar.appendChild(b);
  });
  bar.appendChild(el('span', 'cspacer'));
  // 会话 / 人物下拉
  if ((TOPIC.scopes || []).length) {
    var ss = document.createElement('select');
    ss.className = 'cnick';
    var o0 = el('option', null, '所有会话'); o0.value = ''; ss.appendChild(o0);
    TOPIC.scopes.forEach(function (s) { var o = el('option', null, s); o.value = s; ss.appendChild(o); });
    ss.value = topicF.scope || '';
    ss.title = '按群 / 私聊筛';
    ss.onchange = function () { topicF.scope = ss.value; renderContent(); };
    bar.appendChild(ss);
  }
  if ((TOPIC.whos || []).length) {
    var ws = document.createElement('select');
    ws.className = 'cnick';
    var w0 = el('option', null, '所有人'); w0.value = ''; ws.appendChild(w0);
    TOPIC.whos.forEach(function (s) { var o = el('option', null, s); o.value = s; ws.appendChild(o); });
    ws.value = topicF.who || '';
    ws.title = '按人筛';
    ws.onchange = function () { topicF.who = ws.value; renderContent(); };
    bar.appendChild(ws);
  }
  var kwInp = document.createElement('input');
  kwInp.className = 'ckw';
  kwInp.placeholder = '搜话题内容';
  kwInp.value = topicF.q || '';
  kwInp.oninput = function () {
    topicF.q = kwInp.value;
    clearTimeout(kwInp._t);
    kwInp._t = setTimeout(function () { loadTopics().then(paintTopicList); }, 200);
  };
  bar.appendChild(kwInp);
  bar.appendChild(el('span', 'cspacer'));
  var bRe = el('button', 'cdel', '↻ 刷新');
  bRe.onclick = function () { loadTopics().then(renderContent); };
  bar.appendChild(bRe);
  var bAdd = el('button', 'cdel', '＋ 录入');
  bAdd.title = topicF.view === 'promise' ? '手动记一条约定' : '手动记一条话题（比如你想到的、它没自动记的）';
  bAdd.onclick = function () { topicAddForm(box); };
  bar.appendChild(bAdd);
  var bClr = el('button', 'cdel danger', '清空');
  bClr.title = '删掉这一页的全部记录（真删）';
  bClr.onclick = function () {
    var kind = topicF.view === 'promise' ? 'promise' : 'topic';
    confirmBox('清空「' + meta.title + '」？\n这会真的删掉' + (kind === 'promise' ? '全部约定' : '话题日志和话题里的全部记录') + '，找不回来。', function () {
      POST('/api/topic/clear', { kind: kind }).then(function (r) {
        if (r.error) return toast(r.error);
        toast(meta.title + '清空了');
        loadTopics().then(renderContent);
      });
    });
  };
  bar.appendChild(bClr);
  // 批量删除（主人 2026-10-23 定）：勾多条一次删掉，不用一条一条点
  var bPick = el('button', 'cdel', topicF.pick ? '退出批量删除' : '批量删除');
  if (topicF.pick) bPick.style.borderColor = 'var(--ac)';
  bPick.title = '点了以后每条前面出现勾选框，勾完按「删掉选中的」一次清掉。删掉已总结话题时，挂在它底下的原文会回到话题日志顶层，不会连坐';
  bPick.onclick = function () { topicF.pick = !topicF.pick; TOPIC_SEL = {}; renderContent(); };
  bar.appendChild(bPick);
  box.appendChild(bar);

  // 批量删除的专属工具条（只在勾模式下出现）
  if (topicF.pick) {
    var pbar = el('div', 'cbar');
    var bAll = el('button', 'cdel', '全选本页');
    bAll.title = '把这一页显示的全部勾上（含挂在已总结话题底下的原文）';
    var bNone = el('button', 'cdel', '全部取消');
    var cntEl = el('span', 'gy', '已勾 0 条');
    cntEl.style.cssText = 'font-size:12px;align-self:center';
    var bDelSel = el('button', 'cdel danger', '删掉选中的');
    pbar.appendChild(bAll); pbar.appendChild(bNone); pbar.appendChild(cntEl);
    pbar.appendChild(el('span', 'cspacer'));
    pbar.appendChild(bDelSel);
    var updCnt = function () {
      var n = topicSelCount();
      cntEl.textContent = '已勾 ' + n + ' 条';
      bDelSel.textContent = n ? '删掉选中的 ' + n + ' 条' : '删掉选中的';
      bDelSel.disabled = !n;
    };
    window.__topicPickCount = updCnt;
    bAll.onclick = function () {
      (TOPIC.list || []).forEach(function (x) { TOPIC_SEL[x.id] = 1; (x.kids || []).forEach(function (k) { TOPIC_SEL[k.id] = 1; }); });
      renderContent();
    };
    bNone.onclick = function () { TOPIC_SEL = {}; renderContent(); };
    bDelSel.onclick = function () {
      var ids = Object.keys(TOPIC_SEL);
      if (!ids.length) return toast('先勾上要删的');
      confirmBox('删掉勾住的 ' + ids.length + ' 条？\n删了已总结话题时，挂在它底下的原文会回到话题日志顶层（不会连坐）。真删，找不回来。', function () {
        POST('/api/topic/delbatch', { ids: ids }).then(function (r) {
          if (r.error) return toast(r.error);
          TOPIC_SEL = {};
          toast('删了 ' + (r.removed || ids.length) + ' 条' + (r.freed ? '，' + r.freed + ' 段原文回到话题日志' : ''));
          loadTopics().then(renderContent);
        });
      });
    };
    box.appendChild(pbar);
  }
  box.appendChild(listBox);
  paintTopicList(listBox);
  if (topicF.pick && updCnt) updCnt();
}
function paintTopicList(box) {
  box.textContent = '';
  if (!TOPIC || !TOPIC.list.length) {
    box.appendChild(el('div', 'empty', topicF.q ? '没找到相关的' : '还没有记录。它跟人聊起来、或者你点「＋ 录入」，这里就会有。'));
    return;
  }
  var list = TOPIC.list.slice().reverse();     // 新的在前
  if (topicF.group === 'time') {
    list.forEach(function (it) { topicCard(it, box, {}); });
    return;
  }
  // 按群/私聊 / 按会话 / 按人物分组
  var keyFn = topicF.group === 'kind' ? function (it) { return it.scope ? (String(it.scope).indexOf('群') === 0 ? '群聊' : '私聊') : '（没记会话）'; }
    : topicF.group === 'scope' ? function (it) { return it.scope || '（没记会话）'; }
    : function (it) { return it.who || '（没记谁）'; };
  var label = topicF.group === 'kind' ? '' : (topicF.group === 'scope' ? '会话：' : '人物：');
  var groups = {}, order = [];
  list.forEach(function (it) {
    var k = keyFn(it);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(it);
  });
  order.forEach(function (k) {
    box.appendChild(el('div', 'tgroup', label + k + '（' + groups[k].length + '）'));
    groups[k].forEach(function (it) { topicCard(it, box, {}); });
  });
}
// 手动录入一条（页内表单，不弹浏览器窗）。类型保留、颜色不同、悬停有说明
function topicAddForm(host) {
  if (document.getElementById('topicAddForm')) return;
  var to = topicF.view === 'topics' ? 'topics' : (topicF.view === 'promise' ? 'promise' : 'log');
  var wrap = el('div', 'tadd');
  wrap.id = 'topicAddForm';
  var row1 = el('div', 'taddrow');
  var typeSel = document.createElement('select');
  typeSel.className = 'cnick';
  [['manual', '手动录入'], ['quote', '别人原文'], ['self', '自己总结'], ['search', '搜索到的']].forEach(function (o) {
    var op = el('option', null, o[1]); op.value = o[0]; typeSel.appendChild(op);
  });
  row1.appendChild(typeSel);
  var whoInp = null, scopeInp = null, tpInp = null;
  if (to === 'promise') {
    tpInp = document.createElement('input');
    tpInp.className = 'ckw'; tpInp.placeholder = '分类（如：想听我说，可空）';
    row1.appendChild(tpInp);
  } else {
    whoInp = document.createElement('input');
    whoInp.className = 'ckw'; whoInp.placeholder = '谁说的（可空）';
    row1.appendChild(whoInp);
    scopeInp = document.createElement('input');
    scopeInp.className = 'ckw'; scopeInp.placeholder = '会话：群123 / 私聊（可空）';
    row1.appendChild(scopeInp);
  }
  wrap.appendChild(row1);
  var ta = document.createElement('textarea');
  ta.className = 'ckw'; ta.rows = 2;
  ta.placeholder = to === 'promise' ? '约定内容…（说过的要做到）' : '话题内容…';
  wrap.appendChild(ta);
  var row2 = el('div', 'taddrow');
  var ok = el('button', 'cdel', '保存');
  var no = el('button', 'cdel', '取消');
  row2.appendChild(ok); row2.appendChild(no);
  wrap.appendChild(row2);
  host.appendChild(wrap);
  ta.focus();
  no.onclick = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
  ok.onclick = function () {
    var text = (ta.value || '').trim();
    if (!text) return toast('写点内容再保存');
    var body = { to: to, type: typeSel.value, text: text };
    if (to === 'promise') body.topic = (tpInp.value || '').trim();
    else { body.who = (whoInp.value || '').trim(); body.scope = (scopeInp.value || '').trim(); }
    POST('/api/topic/add', body).then(function (r) {
      if (r.error) return toast(r.error);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      toast(to === 'promise' ? '约定记下了' : '记下了');
      loadTopics().then(renderContent);
    });
  };
}

/* ---------- 网络热梗（长期记忆）：梗库卡片页 ----------
 * 数据就是 data/网络热梗.md（一节一个梗），这里加/改/删都是改那个文件，她立刻用新的。
 * 有「怎么接」= 接梗型（别人发它就按接法回）；只有「含义」= 词典型（只帮理解，不接管回复）。
 */
var MEMES = null;
var MEME_PREFILL = null;   // 从话题卡片「收进热梗」带过来的预填
function loadMemes() { return api('/api/meme').then(function (r) { if (r && r.list) MEMES = r.list; return MEMES; }); }
function openMemes(prefill) {
  MEME_PREFILL = prefill || null;
  openPage('__memes', function () {
    return { fileId: '__memes', path: [], titles: ['网络热梗'], title: '网络热梗', name: '网络热梗' };
  }, loadMemes);
}
function memeRow(lab, val) {
  var r = el('div', 'mrow');
  r.appendChild(el('span', 'mkey', lab));
  var v = el('span', 'mval');
  v.textContent = val || '（没写）';
  v.title = val || '';
  if (!val) v.style.opacity = '.45';
  r.appendChild(v);
  return r;
}
function memeForm(host, it) {
  var old = document.getElementById('memeForm');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  it = it || MEME_PREFILL || {};
  var wrap = el('div', 'tadd');
  wrap.id = 'memeForm';
  wrap.appendChild(el('div', 'dlgsub', '含义写清楚一点，AI 就懂这个梗。有「怎么接」= 别人发它就按接法回；没有 = 词典型，只帮理解不接管回复。'));
  // 常驻标签（短名）+ 占位符只放说明：占位符一打字就没了，说明必须写在标签上才不会「输入后提示消失」
  var mkInp = function (ph, val, rows) {
    var x = document.createElement(rows ? 'textarea' : 'input');
    x.className = 'ckw'; if (rows) x.rows = rows; x.placeholder = ph; x.value = val || '';
    return x;
  };
  var fTitle = mkInp('必填', it.title);
  var fWords = mkInp('顿号隔开；消息里命中才认出这个梗', Array.isArray(it.words) ? it.words.join('、') : it.words);
  var fMeaning = mkInp('这个梗是什么意思（给人看，也给 AI 看）', it.meaning, 2);
  var fCtx = mkInp('可空；这梗当时怎么来的（引用原话+群上10下3，记梗功能自动填）', it.ctx, 2);
  var fHow = mkInp('别人发这个梗时怎么回（可空 = 词典型）', it.how, 2);
  var fFull = mkInp('可空；写了它 = 别人只发一截时她会直接背全文（不过模型）', it.full, 3);
  var fPlay = mkInp('她自己想玩这个梗时怎么用（可空）', it.play, 2);
  var fEx = mkInp('示范句（只用来校验，不会照抄进回复）', it.ex, 2);
  [['梗名', fTitle], ['特征词', fWords], ['含义', fMeaning], ['上下文', fCtx], ['怎么接', fHow], ['全文', fFull], ['怎么玩', fPlay], ['范例', fEx]].forEach(function (f) {
    wrap.appendChild(el('div', 'hint', f[0]));
    wrap.appendChild(f[1]);
  });
  var row2 = el('div', 'taddrow');
  var ok = el('button', 'cdel', '保存');
  var no = el('button', 'cdel', '取消');
  row2.appendChild(ok); row2.appendChild(no);
  wrap.appendChild(row2);
  host.appendChild(wrap);
  fTitle.focus();
  no.onclick = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); MEME_PREFILL = null; };
  ok.onclick = function () {
    var body = { title: fTitle.value.trim(), words: fWords.value, meaning: fMeaning.value.trim(), ctx: fCtx.value.trim(), how: fHow.value.trim(), full: fFull.value.trim(), play: fPlay.value.trim(), ex: fEx.value.trim() };
    if (!body.title) return toast('梗名得写一个');
    var done = function (r) {
      if (r.error) return toast(r.error);
      toast('热梗存好了');
      MEME_PREFILL = null;
      loadMemes().then(renderContent);
    };
    // 注意顺序：body.title 是新梗名，必须放在后面用 origTitle 带原名（主人 2026-10-22：
    // 之前 Object.assign({title:原名}, body) 被 body.title 覆盖 → 服务端拿新名查旧节 → 「找不到」）
    if (it._edit) POST('/api/meme/update', Object.assign({}, body, { origTitle: it._orig })).then(done);
    else POST('/api/meme/add', body).then(done);
  };
}
function memeCard(box, m) {
  var card = el('div', 'tcard');
  var head = el('div', 'chh');
  var nm = el('span', 'ttp', m.how ? '接梗' : '词典');
  nm.style.background = m.how ? '#7c9cff' : '#a3a58a';
  nm.title = m.how ? '别人发这个梗，她会按「怎么接」接管回复' : '只把含义注给她理解，不接管回复';
  head.appendChild(nm);
  head.appendChild(el('b', null, m.title));
  if (m.play) {
    var w = el('span', 'tst raw', '可自玩');
    w.title = '写了「怎么玩」，她自己想玩的时候照那个来';
    head.appendChild(w);
  }
  var tm = el('span', 'chtm', '');
  tm.style.marginLeft = 'auto';
  head.appendChild(tm);
  card.appendChild(head);
  card.appendChild(memeRow('含义', m.meaning));
  if (m.ctx) card.appendChild(memeRow('上下文', m.ctx));
  if (m.how) card.appendChild(memeRow('怎么接', m.how));
  if (m.full) card.appendChild(memeRow('全文', m.full));
  if (m.play) card.appendChild(memeRow('怎么玩', m.play));
  card.appendChild(memeRow('特征词', (m.words || []).join('、')));
  if (m.ex) card.appendChild(memeRow('范例', m.ex));
  var bar = el('div', 'tbar');
  var bE = el('button', 'cdel', '改');
  bE.title = '改这一节（直接写回梗库文件）';
  bE.onclick = function () { memeForm(box, Object.assign({}, m, { _edit: true, _orig: m.title })); };
  var bD = el('button', 'cdel danger', '删');
  bD.onclick = function () {
    confirmBox('删掉「' + m.title + '」？', function () {
      POST('/api/meme/del', { title: m.title }).then(function (r) {
        if (r.error) return toast(r.error);
        loadMemes().then(renderContent);
      });
    });
  };
  bar.appendChild(bE); bar.appendChild(bD);
  card.appendChild(bar);
  return card;
}
function renderMemes(t, box) {
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '长期记忆'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', '网络热梗'));
  box.appendChild(el('p', 'pgsub', '她认识的梗都在这（长期记忆）：聊天里遇到会按「怎么接」接住，平时也可能自己玩一下。想教她一个梗，把含义写清楚就行。当前 ' + ((MEMES && MEMES.length) || 0) + ' 个。'));
  var bar = el('div', 'cbar');
  var bAdd = el('button', 'cdel', '＋ 加一个梗');
  bAdd.onclick = function () { memeForm(box); };
  bar.appendChild(bAdd);
  var bRe = el('button', 'cdel', '↻ 刷新');
  bRe.onclick = function () { loadMemes().then(renderContent); };
  bar.appendChild(bRe);
  box.appendChild(bar);
  if (MEME_PREFILL) memeForm(box);
  var list = el('div', 'clist');
  if (!MEMES || !MEMES.length) list.appendChild(el('div', 'empty', '梗库还空着。点「＋ 加一个梗」，或在话题日志里点「收进热梗」。'));
  (MEMES || []).slice().reverse().forEach(function (m) { list.appendChild(memeCard(box, m)); });
  box.appendChild(list);
}

/* ---------- 梗词典（CHIME 开源数据集，1455 条；主人 2026-10-22：放「网络热梗」下面） ---------- */
function openMemeDict() {
  openPage('__memedict', function () {
    return { fileId: '__memedict', path: [], titles: ['梗词典'], title: '梗词典', name: '梗词典' };
  });
}
function renderMemeDict(t, box) {
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '长期记忆'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', '梗词典'));
  box.appendChild(el('p', 'pgsub', 'CHIME 开源中文梗数据集（1455 条）。词典型：她遇到会按意思理解，不会抢着玩；她自己梗库里的优先。搜梗名 / 含义 / 类型都行。'));
  var bar = el('div', 'cbar');
  var inp = document.createElement('input');
  inp.className = 'ckw'; inp.placeholder = '搜梗名、含义、类型…（如：谐音）';
  bar.appendChild(inp);
  var cnt = el('span', 'pgsub', '');
  cnt.style.margin = '0 6px';
  bar.appendChild(cnt);
  box.appendChild(bar);
  var list = el('div', 'clist');
  box.appendChild(list);
  var timer = null;
  function search() {
    var q = inp.value.trim();
    api('/api/memedict?q=' + encodeURIComponent(q)).then(function (r) {
      cnt.textContent = '共 ' + (r.total || 0) + ' 条，命中 ' + (r.shown || 0) + ' 条' + ((r.shown || 0) > (r.list || []).length ? '（只显示前 300）' : '');
      list.textContent = '';
      if (!(r.list || []).length) { list.appendChild(el('div', 'empty', '没搜到')); return; }
      r.list.forEach(function (x) {
        var d = el('div', 'drow');
        var h = el('div');
        h.appendChild(el('span', 'dm', x.meme));
        if (x.type) h.appendChild(el('span', 'dt', x.type));
        if (x.offense) { var o = el('span', 'do', '冒犯'); o.title = '数据集标注：这个梗带冒犯性，她只理解不使用'; h.appendChild(o); }
        d.appendChild(h);
        d.appendChild(el('div', 'dmv', x.meaning || '（数据集里没写含义）'));
        list.appendChild(d);
      });
    });
  }
  inp.oninput = function () { clearTimeout(timer); timer = setTimeout(search, 250); };
  search();
}

/* ---------- 更新说明弹窗 + 需求记录（主人 2026-10-22 定）----------
 * ① 每次代码更新都先在面板弹窗用大白话说明改了什么，主人点「知道了」才算数（读 data/updates.jsonl，ack 过的不再弹）；
 * ② 需求记录：他提的需求原文留存 + 简化时间轴（QQ 私聊发「需求：xxx」自动记）；
 * ③ 术语都有灰字小解释（gy()），鼠标放上去看完整说明。 */
function gy(term, tip) {
  var s = el('span', 'gy', term);
  s.title = tip;
  return s;
}
// **文字** → 加粗（主人 2026-10-23：面板里到处显示「**」星号，改正）。
// 返回 DocumentFragment，装进任何容器都行；别的标记不解析，只管加粗。
function mdBold(text) {
  var frag = document.createDocumentFragment();
  String(text == null ? '' : text).split(/(\*\*[^*\n]+\*\*)/).forEach(function (p) {
    if (/^\*\*[^*\n]+\*\*$/.test(p)) frag.appendChild(el('b', null, p.slice(2, -2)));
    else if (p) frag.appendChild(document.createTextNode(p));
  });
  return frag;
}
function boldDiv(text, css) {
  var d = el('div');
  if (css) d.style.cssText = css;
  d.appendChild(mdBold(text));
  return d;
}

var UPD_CHECKED = false;
function checkUpdates() {
  if (UPD_CHECKED) return;
  UPD_CHECKED = true;
  api('/api/updates').then(function (r) {
    var un = (r && r.list || []).filter(function (x) { return !x.ack; });
    if (un.length) showUpdatePop(un);
  }).catch(function () {});
}
function showUpdatePop(items) {
  var d = document.getElementById('dlg');
  d.textContent = '';
  d.appendChild(el('h3', null, '更新说明'));
  var tip = el('p', 'gy', '每次更新代码都会先告诉你改了什么，你看完点下面的按钮面板才会继续用。灰字是术语的小解释。');
  d.appendChild(tip);
  items.forEach(function (x) {
    var c = el('div', null);
    c.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;margin:8px 0';
    var t1 = el('div', null, x.title); t1.style.fontWeight = '600';
    c.appendChild(t1);
    c.appendChild(boldDiv(x.detail, 'white-space:pre-wrap;font-size:12.5px;margin-top:4px'));
    var s1 = el('div', 'gy', '更新时间：' + String(x.t || '').replace('T', ' ').slice(0, 16));
    s1.style.marginTop = '6px';
    c.appendChild(s1);
    d.appendChild(c);
  });
  var acts = el('div', 'acts');
  var bOk = el('button', 'main', '知道了，继续用');
  bOk.onclick = function () {
    Promise.all(items.map(function (x) { return POST('/api/updates/ack', { id: x.id }); }))
      .then(function () { closeDlg(); toast('已确认'); })
      .catch(function () { closeDlg(); });
  };
  acts.appendChild(bOk);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}

function renderUpdates(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '更新说明'));
  box.appendChild(el('p', 'pgsub', '每次代码更新的通俗说明。打开面板时的弹窗就是从这里取的最新一条；历史全在这。'));
  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);
  api('/api/updates').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    var list = (r && r.list) || [];
    if (!list.length) { box.appendChild(el('div', 'empty', '还没有更新记录')); return; }
    list.forEach(function (x) {
      var c = el('div', null);
      c.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;margin:8px 0';
      var t1 = el('div', null, x.title + (x.ack ? '' : '　（还没确认）'));
      t1.style.fontWeight = '600';
      c.appendChild(t1);
      c.appendChild(boldDiv(x.detail, 'white-space:pre-wrap;font-size:12.5px;margin-top:4px'));
      var s1 = el('div', 'gy', String(x.t || '').replace('T', ' ').slice(0, 16) + (x.ack ? ' · 已确认' : ' · 未确认'));
      s1.style.marginTop = '6px';
      c.appendChild(s1);
      box.appendChild(c);
    });
  });
}
/* ---------- 她的思考（v79，主人 2026-10-23 定） ----------
 * 只做一件事：把模型自己给的 reasoning_content **原样**摆出来，一个字不改、不总结、不美化。
 * 默认不开思考（开了又慢、正文还容易空），所以平时这里是空的；
 * 想看她怎么想的，点「让她下一轮想给我看」，下一轮她说话时开着思考，原文就落到这儿。
 * 只留最近 5 条，core 写的时候已经裁过，前端再 slice 一次只是兜底。 */
function openThinking() {
  openPage('__thinking', function () {
    return { fileId: '__thinking', path: [], titles: ['她的思考'], title: '她的思考', name: '她的思考' };
  }, function () {});
}
function renderThinking(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '她的思考'));
  box.appendChild(el('p', 'pgsub', '模型自己给的思考原文，原样摆着，一个字没改。只留最近 5 条，多了自动删。'));

  var bar = el('div', 'taddrow');
  var ask = el('button', 'cdel', '让她下一轮想给我看');
  ask.title = '点一下，她下一轮回答时会开着思考；想的内容会存进这一页（只生效一轮，不会一直开着的）';
  bar.appendChild(ask);
  var mtb = el('button', 'cdel', '看多重真相');
  mtb.title = '后台那条流水线（接话复核 / 群友视角 / 记录员）到底看到了什么';
  mtb.onclick = function () { openMultiTruth(); };
  bar.appendChild(mtb);
  box.appendChild(bar);
  var hint = el('div', 'gy', '平时是关着的——开着思考会慢好几秒，正文还容易空。所以想看的时候点一下，再去跟她说话。');
  hint.style.margin = '6px 0 10px';
  box.appendChild(hint);

  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);

  ask.onclick = function () {
    ask.disabled = true;
    POST('/api/thinking/ask', {}).then(function (r) {
      ask.disabled = false;
      if (!r || !r.ok) { toast((r && r.error) || '没打开，再点一次'); return; }
      toast('好啦，你下一轮跟她说话，她就会想给你看');
      setTimeout(function () { renderContent(); }, 1200);
    }).catch(function () { ask.disabled = false; toast('没打开，再点一次'); });
  };

  api('/api/thinking').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    var list = (r && r.list) || [];
    if (!list.length) {
      box.appendChild(el('div', 'empty', '还没有记录——点上面那个按钮，然后去跟她说句话'));
      return;
    }
    list.slice(0, 5).forEach(function (x, i) {
      var c = el('div', null);
      c.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;margin:8px 0';
      var hd = el('div', null, '最近第 ' + (i + 1) + ' 条　·　' + String(x.model || '') + '　·　' + String(x.t || '').replace('T', ' ').slice(0, 19));
      hd.style.cssText = 'font-size:12px;color:var(--sub);margin-bottom:6px';
      c.appendChild(hd);

      c.appendChild(el('div', 'tgroup', '她当时的思考（原文）'));
      var pre = el('div', null, String(x.reason || '（这一轮模型没给思考内容）'));
      pre.style.cssText = 'white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;padding:8px 10px;margin:4px 0 8px';
      c.appendChild(pre);
      if (x.note) {
        var nt = el('div', 'gy', x.note);
        nt.style.margin = '-4px 0 8px';
        c.appendChild(nt);
      }

      if (x.reply) {
        c.appendChild(el('div', 'tgroup', '最后说出口的话'));
        c.appendChild(boldDiv(String(x.reply), 'white-space:pre-wrap;font-size:12.5px;color:var(--tx);margin-bottom:8px'));
      }
      if (x.ctx) {
        var d = el('details');
        var s = el('summary', null, '她当时看到的那几句（点开看）');
        s.style.cssText = 'font-size:12px;color:var(--sub);cursor:pointer';
        d.appendChild(s);
        var ctx = el('div', null, String(x.ctx));
        ctx.style.cssText = 'white-space:pre-wrap;font-size:12px;line-height:1.55;color:var(--sub);padding:6px 0 0';
        d.appendChild(ctx);
        c.appendChild(d);
      }
      box.appendChild(c);
    });
  }).catch(function () {
    loading.parentNode && loading.parentNode.removeChild(loading);
    box.appendChild(el('div', 'empty', '读不出来，刷新一下试试'));
  });
}

/* ---------- 多重真相（2026-11-25） ----------
 * 后台那条流水线到底看到了什么：接话复核（judge）、群友视角（views）、记录员结论（recorder），
 * 外加当前会话 inbox 的尾巴。只读展示，一个字的判断都不在这里做。 */
function openMultiTruth() {
  openPage('__multitruth', function () {
    return { fileId: '__multitruth', path: [], titles: ['多重真相'], title: '多重真相', name: '多重真相' };
  }, function () {});
}
function renderMultiTruth(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '多重真相'));
  box.appendChild(el('p', 'pgsub', '后台按三个角色看的：接话复核、群友各自视角、记录员结论。只读，判断都在后台图里做。'));

  var bar = el('div', 'taddrow');
  var run = el('button', 'cdel', '现在跑一次');
  run.title = '拿最近那个群的 inbox 立刻跑一遍；两次之间至少隔 10 秒，10 秒内点了会说「节流中」';
  bar.appendChild(run);
  var back = el('button', 'cdel', '回到她的思考');
  back.onclick = function () { openThinking(); };
  bar.appendChild(back);
  box.appendChild(bar);

  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);

  var status = el('div', 'gy', '');
  box.appendChild(status);
  var kickK = '';

  run.onclick = function () {
    if (!kickK) { toast('还不知道是哪个群，先等这页读出来'); return; }
    run.disabled = true;
    POST('/api/multitruth/kick', { k: kickK }).then(function (r) {
      run.disabled = false;
      if (!r || !r.ok) { toast((r && r.error) || '没跑起来'); return; }
      toast('已经派给后台了，跑完刷新这页看');
      status.textContent = '已派出：' + kickK + '（后台跑，几秒到十几秒）';
    }).catch(function () { run.disabled = false; toast('没跑起来'); });
  };

  function sec(title, body, emptyText) {
    var d = el('details');
    d.open = true;
    var s = el('summary', null, title);
    s.style.cssText = 'font-size:13px;font-weight:600;cursor:pointer;margin:14px 0 6px';
    d.appendChild(s);
    var pre = el('div', null, body ? String(body) : (emptyText || '（还没有内容）'));
    pre.style.cssText = 'white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;padding:8px 10px';
    d.appendChild(pre);
    return d;
  }

  api('/api/multitruth?n=20').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    var latest = (r && r.latest) || null;
    var inbox = (r && r.inbox) || [];
    if (inbox.length && inbox[0] && inbox[0].k) kickK = String(inbox[0].k);
    else if (latest && latest.k) kickK = String(latest.k);

    if (latest) {
      var hd = el('div', 'gy', '记录员最近一次结论：' + String(latest.k || '') + '　·　' +
        (latest.at ? new Date(Number(latest.at)).toLocaleString() : '时间未知') +
        (latest.stale ? '　·　可能已经旧了' : ''));
      hd.style.margin = '8px 0';
      box.appendChild(hd);
    } else {
      box.appendChild(el('div', 'empty', '后台还没产出过结论——等群里有动静，或点上面「现在跑一次」'));
    }

    box.appendChild(sec('接话复核（judge）', (r && r.judge) || ''));
    box.appendChild(sec('群友视角（views）', (r && r.views) || ''));
    box.appendChild(sec('记录员结论（recorder）', (r && r.recorder) || ''));

    var rows = inbox.map(function (x) {
      var tt = String(x.t || '').replace('T', ' ').slice(0, 19);
      return tt + '　' + (x.nick || x.uid || '?') + '：' + String(x.text || '').slice(0, 120);
    }).join('\n');
    box.appendChild(sec('最近的消息队列（' + inbox.length + ' 条）', rows, '（这个群还没有待分析的消息）'));
  }).catch(function () {
    loading.parentNode && loading.parentNode.removeChild(loading);
    box.appendChild(el('div', 'empty', '读不出来，刷新一下试试'));
  });
}

function openUpdates() {
  openPage('__updates', function () {
    return { fileId: '__updates', path: [], titles: ['更新说明'], title: '更新说明', name: '更新说明' };
  }, function () {});
}

/* ---------- 需求记录（主人 2026-10-22 晚定） ----------
 * 他提的需求原文留存 + 简化时间轴：QQ 私聊发「需求：xxx」自动记；这里也能补录。落盘的目的：
 * 以前需求只留在对话里，要翻几十 MB 的会话记录才能找回来。 */
function openReqs() {
  openPage('__reqs', function () {
    return { fileId: '__reqs', path: [], titles: ['需求记录'], title: '需求记录', name: '需求记录' };
  }, function () {});
}
function renderReqs(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '需求记录'));
  box.appendChild(el('p', 'pgsub', '你提过的需求都在这（原文留存，时间倒序）。QQ 私聊发「需求：xxx」自动记，下面也能补一条。'));
  var inp = el('input', 'ckw');
  inp.placeholder = '在这里补一条需求，回车或点「记下」';
  var add = el('button', 'cdel', '记下');
  var row = el('div', 'taddrow');
  inp.style.flex = '1';
  row.appendChild(inp); row.appendChild(add);
  box.appendChild(row);
  var doAdd = function () {
    var v = inp.value.trim();
    if (!v) return toast('先写需求内容');
    POST('/api/reqs/add', { text: v }).then(function (r) {
      if (r && r.ok) { toast('需求记下了'); renderContent(); } else toast('没记上，再试一次');
    }).catch(function () { toast('没记上，再试一次'); });
  };
  add.onclick = doAdd;
  inp.onkeydown = function (e) { if (e.key === 'Enter') doAdd(); };
  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);
  api('/api/reqs').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    var list = (r && r.list) || [];
    if (!list.length) { box.appendChild(el('div', 'empty', '还没有记录——私聊发「需求：xxx」或在这里补')); return; }
    list.forEach(function (x) {
      var c = el('div', null);
      c.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;margin:8px 0';
      var h = el('div', null);
      h.style.cssText = 'font-weight:600;white-space:pre-wrap;word-break:break-word';
      h.appendChild(mdBold(x.text || ''));
      c.appendChild(h);
      var s = el('div', 'gy', (x.src || '') + '　' + String(x.t || '').replace('T', ' ').slice(0, 16));
      s.style.marginTop = '5px';
      c.appendChild(s);
      box.appendChild(c);
    });
  }).catch(function () { loading.textContent = '没读到（面板接口出错了）'; });
}

/* ---------- 花费账（v80，主人 2026-10-31 定）----------
 * 每一笔大模型调用花了多少 token：按功能排、按天看、按哪套机器人分。
 * 数字来自接口自己返回的 usage（core.js 每次调用后记一笔），不是数字符估算。
 * 关键看两点：①「回一句话」后面跟了几次「重说」——重说一次就把整份提示词重发一遍；
 * ②「看图」——群里每张图都是一笔。
 */
function openCost() {
  openPage('__cost', function () {
    return { fileId: '__cost', path: [], titles: ['花费账'], title: '花费账', name: '花费账' };
  }, function () {});
}
function num(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }
function renderCost(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '花费账'));
  box.appendChild(el('p', 'pgsub', '每一笔都是接口自己报回来的用量，不是估算。注意两点：「回一句话」后面跟几次「重说」，花费就是几倍（重说会把整份提示词原样再发一遍）；「看图」是群里每张图单独算一笔。'));
  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);

  api('/api/cost').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    r = r || {};
    var today = r.today || {}, d7 = r.d7 || {}, d30 = r.d30 || {};

    // ① 三张数字：今天 / 近 7 天 / 近 30 天
    box.appendChild(el('div', 'tgroup', '一共用了多少'));
    var cards = el('div', null);
    cards.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 12px';
    [[ '今天', today ], [ '近 7 天', d7 ], [ '近 30 天', d30 ]].forEach(function (p) {
      var s = p[1];
      var c = el('div', null);
      c.style.cssText = 'flex:1;min-width:150px;border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;background:var(--bg)';
      c.appendChild(el('div', 'gy', p[0]));
      var big = el('div', null, num(s.total) + ' token');
      big.style.cssText = 'font-size:17px;font-weight:700;margin:3px 0';
      c.appendChild(big);
      c.appendChild(el('div', 'gy', '输入 ' + num(s.in) + ' · 输出 ' + num(s.out)));
      c.appendChild(el('div', 'gy', '共 ' + num(s.calls) + ' 次调用' + (s.fails ? '（其中 ' + s.fails + ' 次没成功：限流/超时/Key 被拒）' : '')));
      cards.appendChild(c);
    });
    box.appendChild(cards);

    // ② 两个关键指标
    var keys = el('div', null);
    keys.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;margin-bottom:12px';
    keys.appendChild(el('div', null, '平均每次请求送进去　' + num(r.avgIn) + ' token（这一份就是人设 + 聊天记录 + 当时的情况）'));
    var rt = el('div', null, '重说占比　' + num(r.retryN) + ' 次重说 ÷ ' + num(r.replyN) + ' 次正常回复'
      + (r.replyN ? '　≈ 每回一句话要重说 ' + (Math.round(r.retryN / r.replyN * 100) / 100) + ' 次' : ''));
    rt.style.marginTop = '4px';
    keys.appendChild(rt);
    box.appendChild(keys);

    // ③ 按功能排行（近 7 天）
    box.appendChild(el('div', 'tgroup', '哪个功能最费（近 7 天）'));
    var list = r.byScene || [];
    if (!list.length) {
      box.appendChild(el('div', 'empty', '还没有记录——等机器人说上几句话，这里就有数了'));
    } else {
      list.forEach(function (c) {
        var row = el('div', null);
        row.style.cssText = 'margin:6px 0';
        var head = el('div', null);
        head.style.cssText = 'display:flex;justify-content:space-between;font-size:12.5px';
        var nm = el('div', null, c.name + '　·　' + num(c.calls) + ' 次' + (c.fails ? '（失败 ' + c.fails + '）' : ''));
        nm.title = '场景标签：' + c.scene;
        head.appendChild(nm);
        head.appendChild(el('div', 'gy', num(c.in) + ' token　' + c.pct + '%'));
        row.appendChild(head);
        var bar = el('div', null);
        bar.style.cssText = 'height:6px;border-radius:3px;background:var(--bd2);margin-top:3px;overflow:hidden';
        var fill = el('div', null);
        fill.style.cssText = 'height:100%;background:var(--ac);width:' + Math.max(1.5, c.pct) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        box.appendChild(row);
      });
    }

    // ④ 最近 10 次明细
    box.appendChild(el('div', 'tgroup', '最近 10 次'));
    var recent = r.recent || [];
    if (!recent.length) {
      box.appendChild(el('div', 'empty', '还没有'));
    } else {
      recent.forEach(function (x) {
        var line = el('div', null);
        line.style.cssText = 'font-size:12px;padding:4px 0;border-bottom:1px solid var(--bd2);display:flex;gap:8px;flex-wrap:wrap';
        line.appendChild(el('span', 'gy', String(x.t || '').replace('T', ' ').slice(5, 19)));
        var nm = el('span', null, x.name + '　' + num(x.in) + ' → ' + num(x.out) + ' token');
        nm.style.minWidth = '230px';
        line.appendChild(nm);
        line.appendChild(el('span', 'gy', (x.model || '') + '　' + (Number(x.ms) || 0) + 'ms' + (x.ok ? '' : '　❌ ' + (x.err || '失败'))));
        box.appendChild(line);
      });
    }

    // ⑤ 设置：开关 / 保留天数 / 账本目录
    box.appendChild(el('div', 'tgroup', '记账设置'));
    var u = r.usage || {};
    var sw = el('input');
    sw.type = 'checkbox'; sw.checked = u.enabled !== false;
    var swRow = el('div', 'taddrow');
    swRow.appendChild(sw);
    swRow.appendChild(el('span', null, '继续记账（关掉就一笔都不记了）'));
    box.appendChild(swRow);

    var daysRow = el('div', 'taddrow');
    daysRow.appendChild(el('span', null, '保留天数'));
    var days = el('input', 'ckw');
    days.type = 'number'; days.min = '1'; days.value = String(u.keepDays || 30);
    days.style.width = '90px';
    daysRow.appendChild(days);
    box.appendChild(daysRow);

    var dirRow = el('div', 'taddrow');
    dirRow.appendChild(el('span', null, '账本目录'));
    var dir = el('input', 'ckw');
    dir.value = String(u.dir || '');
    dir.style.flex = '1';
    dirRow.appendChild(dir);
    box.appendChild(dirRow);

    var save = el('button', 'cdel', '保存设置');
    var msg = el('span', 'gy', '');
    var saveRow = el('div', 'taddrow');
    saveRow.appendChild(save); saveRow.appendChild(msg);
    box.appendChild(saveRow);
    save.onclick = function () {
      save.disabled = true;
      POST('/api/cost/set', { enabled: sw.checked, keepDays: days.value, dir: dir.value }).then(function (rr) {
        save.disabled = false;
        if (rr && rr.ok) { msg.textContent = '已保存，下一笔就按这个来'; toast('记账设置保存了'); renderContent(); }
        else { msg.textContent = (rr && rr.error) || '没存上，再点一次'; }
      }).catch(function () { save.disabled = false; msg.textContent = '没存上，再点一次'; });
    };

    box.appendChild(el('div', 'tgroup', '账本原件'));
    box.appendChild(el('div', 'gy', String(r.file || '')));
    box.appendChild(el('div', 'gy', '一行一笔，两套机器人写同一本账（用 app 字段区分是谁花的）。改完上面的目录，新记录就写到新地方。'));
  }).catch(function () { loading.textContent = '没读到（面板接口出错了）'; });
}

/* ---------- 虚幻自查（主人 2026-10-23 定，原名「她的反馈」）----------
 * 她自己发现的事都汇在这一页：
 *   ① 每 5 分钟一次的定期自查，查到还没修好的毛病（排在页面最上面）
 *   ② 想发但没发出去的（表情库里没这张、剥完表情成空回复了）
 *   ③ 模型本身出故障（Key / IP 白名单不对、被限流、全部答不上来）
 * 只在面板看，QQ 里不会出现。状态栏那个「虚幻自查」灯点进来就是这儿。
 */
function openFeedback() {
  openPage('__feedback', function () {
    return { fileId: '__feedback', path: [], titles: ['虚幻自查'], title: '虚幻自查', name: '虚幻自查' };
  }, function () {});
}
function renderFeedback(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '虚幻自查'));
  box.appendChild(el('p', 'pgsub', '她自己发现的问题都在这：定期自查查出来的毛病排最上面，往下是没发出去的内容和模型故障。只在面板看，QQ 里不会出现。'));
  var top = el('div', null); box.appendChild(top);
  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);
  api('/api/feedback').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    if (!r) { box.appendChild(el('div', 'empty', '没读到（面板接口出错了）')); return; }

    // —— 一、现在还没解决的问题（她自己查出来的，红着摆在最上面）——
    var open = r.open || [];
    top.appendChild(el('div', 'tgroup', '现在还没解决（' + open.length + '）'));
    if (!open.length) {
      top.appendChild(el('div', 'empty', '没有——定期自查这一轮没查出什么毛病'));
    } else {
      top.appendChild(el('p', 'pgsub', '这下面是她每 5 分钟自己查一遍查出来的。修好了会自动记一条「已恢复」挪到下面去。'));
      open.forEach(function (x) {
        var c = el('div', 'tcard');
        c.style.borderColor = 'var(--warn,#e8a33d)';
        var mins = Math.max(0, Math.round((Date.now() - Date.parse(x.since || Date.now())) / 60000));
        var h = el('div', 'chh');
        var tag = el('span', 'ttp', '没解决');
        tag.style.background = '#e05252';
        h.appendChild(tag);
        var tm = el('span', 'chtm', (isNaN(mins) ? '' : (mins < 60 ? mins + ' 分钟' : Math.round(mins / 60) + ' 小时') + '前开始'));
        tm.style.marginLeft = 'auto';
        h.appendChild(tm);
        c.appendChild(h);
        var b = el('div', 'chtx');
        b.appendChild(mdBold(x.desc || ''));
        b.style.whiteSpace = 'pre-wrap';
        c.appendChild(b);
        top.appendChild(c);
      });
    }

    // —— 二、全部记录（新的在前）——
    box.appendChild(el('div', 'tgroup', '全部记录'));
    var bar = el('div', 'cbar');
    var bRe = el('button', 'cdel', '↻ 刷新');
    bRe.onclick = function () { openFeedback(); };
    bar.appendChild(bRe);
    var clr = el('button', 'cdel danger', '清空');
    clr.title = '删掉全部记录（真删，找不回来）';
    clr.onclick = function () {
      confirmBox('清空「虚幻自查」的全部记录？\n还没解决的问题仍会留在最上面（那是她重新查出来的），这里只是清掉历史文字。', function () {
        POST('/api/feedback/clear', {}).then(function () { toast('已清空'); openFeedback(); }).catch(function () { toast('清空失败'); });
      });
    };
    bar.appendChild(clr);
    box.appendChild(bar);

    var list = (r && r.list) || [];
    if (!list.length) { box.appendChild(el('div', 'empty', '还没有记录——该有的都有了，或者她还没想说')); return; }
    list.forEach(function (x, i) {
      var c = el('div', 'tcard');
      var h = el('div', 'chh');
      var k = String(x.kind || '其他');
      var bad = /没解决|用不了|限流|答不上来|没发出去/.test(k);
      var tag = el('span', 'ttp', k);
      tag.style.background = /恢复|好了/.test(k) ? '#3aa76d' : (bad ? '#e05252' : 'var(--ac)');
      h.appendChild(tag);
      var tt = el('span', 'chtm', String(x.t || '').replace('T', ' ').slice(0, 16));
      tt.style.marginLeft = 'auto';
      h.appendChild(tt);
      var del = el('button', 'cdel', '删');
      del.style.cssText = 'font-size:11px;padding:2px 8px';
      del.title = '删掉这一条';
      del.onclick = function () {
        POST('/api/feedback/del', { idx: i }).then(function (res) {
          if (res && res.error) return toast(res.error);
          toast('删了'); openFeedback();
        }).catch(function () { toast('删除失败'); });
      };
      h.appendChild(del);
      c.appendChild(h);
      var b = boldDiv(x.text || '', 'white-space:pre-wrap');
      b.className = 'chtx';
      c.appendChild(b);
      box.appendChild(c);
    });
  }).catch(function () { loading.textContent = '读取失败'; });
}

/* ---------- 触发词：一张表管所有「命中什么词 → 做什么」（v80，主人 2026-10-23 定） ----------
 * 主人原话：「【回复策略】现在0条。你应该把这个功能和其他触发词功能整合，而不是继续新增文件。」
 * 所以「不用回复 / 适合回复」不再单独一个页、也不再有单独的数据文件——全部并进 config.triggers，
 * 和其他触发词（固定话术、喊一声就接话）放在同一张表里，四种类型只是 mode 不同。
 */
var TRIG = null;
function loadTrigs() { return api('/api/triglist').then(function (r) { TRIG = r || null; return TRIG; }); }
function openTriggers() {
  openPage('__triggers', function () {
    return { fileId: '__triggers', path: [], titles: ['触发词'], title: '触发词', name: '触发词' };
  }, loadTrigs);
}
var TRIG_ORDER = ['reply', 'say', 'noreply', 'good'];
var TRIG_TIP = {
  reply: '有人发这几个词，就当有人叫她——直接接一句（走模型，不受群节流限制）。比如群里发「虚幻」。',
  say: '命中就发这句话，不走模型，文案一个字都不会变。',
  noreply: '命中就不接，只记进聊天记录（优先级最高，私聊也拦）。',
  good: '命中就一定接，哪怕没人 @她，也不占每天凑热闹的额度。',
};
function renderTriggers(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '触发词'));
  box.appendChild(el('p', 'pgsub', '一张表管所有「命中什么词 → 做什么」。多个词用「、」隔开。私聊发「触发词」也能看，发「不用回复：xxx / 喊我：xxx / 固定话：词=话」也能加。'));

  // —— 添加 ——
  var addCard = el('div', 'tcard');
  var bar = el('div', 'cbar');
  var inp = document.createElement('input');
  inp.className = 'ckw';
  inp.placeholder = '触发词，多个用「、」隔开（如：虚幻）';
  inp.style.flex = '1';
  var sel = document.createElement('select');
  sel.className = 'ckw';
  TRIG_ORDER.forEach(function (m) {
    var o = document.createElement('option');
    o.value = m; o.textContent = (TRIG && TRIG.modes && TRIG.modes[m] ? TRIG.modes[m].name : m);
    sel.appendChild(o);
  });
  sel.value = 'reply';
  var sayInp = document.createElement('input');
  sayInp.className = 'ckw';
  sayInp.placeholder = '这句固定发什么（只有「固定话术」要填）';
  sayInp.style.flex = '1';
  sayInp.style.display = 'none';
  sel.onchange = function () { sayInp.style.display = sel.value === 'say' ? '' : 'none'; };
  var bAdd = el('button', 'cdel', '＋ 添加');
  bar.appendChild(inp); bar.appendChild(sel); bar.appendChild(sayInp); bar.appendChild(bAdd);
  addCard.appendChild(bar);
  var tip = el('div', 'gy', TRIG_TIP.reply);
  tip.style.marginTop = '6px';
  addCard.appendChild(tip);
  sel.onchange = function () {
    sayInp.style.display = sel.value === 'say' ? '' : 'none';
    tip.textContent = TRIG_TIP[sel.value] || '';
  };
  box.appendChild(addCard);

  bAdd.onclick = function () {
    var w = inp.value.trim();
    if (!w) return toast('先写触发词');
    if (sel.value === 'say' && !sayInp.value.trim()) return toast('「固定话术」要写清发哪句话');
    POST('/api/trig/add', { word: w, mode: sel.value, say: sayInp.value.trim() }).then(function (r) {
      if (!r || r.error) return toast((r && r.error) || '没加上');
      toast('加好了');
      inp.value = ''; sayInp.value = '';
      loadTrigs().then(renderContent);
    }).catch(function () { toast('没加上，再试一次'); });
  };
  inp.onkeydown = function (e) { if (e.key === 'Enter') bAdd.click(); };

  // —— 列表（按类型分组）——
  var list = (TRIG && TRIG.list) || [];
  if (!list.length) {
    box.appendChild(el('div', 'empty', '现在 0 条。上面加一条试试——比如触发词「虚幻」+ 类型「喊一声就接话」，群里谁发「虚幻」她就接一句。'));
    return;
  }
  TRIG_ORDER.forEach(function (mode) {
    var items = list.filter(function (x) { return x.mode === mode; });
    if (!items.length) return;
    var g = el('div', 'tgroup', (TRIG.modes && TRIG.modes[mode] ? TRIG.modes[mode].name : mode) + '（' + items.length + '）');
    box.appendChild(g);
    box.appendChild(el('p', 'pgsub', TRIG_TIP[mode] || ''));
    var host = el('div', 'clist');
    items.forEach(function (x) {
      var card = el('div', 'tcard');
      var head = el('div', 'chh');
      var st = el('span', 'fst ' + (x.enabled ? 'on' : 'off'), x.enabled ? '开' : '关');
      st.title = x.enabled ? '点一下关掉（词留着，暂时不生效）' : '点一下打开';
      st.style.cursor = 'pointer';
      st.onclick = function () {
        POST('/api/trig/toggle', { id: x.id, on: !x.enabled }).then(function () { loadTrigs().then(renderContent); });
      };
      head.appendChild(st);
      var wd = el('span', null, x.words.join('、'));
      wd.style.fontWeight = '600';
      head.appendChild(wd);
      var tm = el('span', 'chtm', x.groupOnly ? '只在群里' : '');
      tm.style.marginLeft = 'auto';
      head.appendChild(tm);
      var bD = el('button', 'cdel danger', '删');
      bD.style.cssText = 'font-size:11px;padding:2px 8px;margin-left:8px';
      bD.onclick = function () {
        POST('/api/trig/del', { id: x.id }).then(function () {
          toast('删了'); loadTrigs().then(renderContent);
        });
      };
      head.appendChild(bD);
      card.appendChild(head);
      if (x.mode === 'say' && x.say) {
        var b = boldDiv('→ ' + x.say, 'white-space:pre-wrap');
        b.className = 'chtx';
        card.appendChild(b);
      }
      if (x.note) card.appendChild(el('div', 'gy', x.note));
      host.appendChild(card);
    });
    box.appendChild(host);
  });
}

/* ---------- 功能与规矩（主人 2026-10-23 定）：规矩手册 + 功能列表 + 变更记录 ----------
 * 规矩手册数据来自 /api/rules——**数字全部服务端现读 config**，页面上永远和实际行为一致。
 * 悬停 = 页内浮层（多行、带具体数值）；原生 title 换行不可靠，不用。
 * 排版紧凑（主人：别全是空位）：行式列表 + 两栏网格。
 */
var FEAT = null;
var featOff = 0;
var RULES = null;               // { sections:[{name, rules:[{n,d,t}]}] }
var FEAT_FILTER = '全部';       // 变更记录筛选
var rtipEl = null;
function loadFeatures(more) {
  return api('/api/features?offset=' + featOff + '&limit=50').then(function (r) {
    if (!r || !r.states) return FEAT;
    if (more && FEAT) FEAT.list = FEAT.list.concat(r.list);
    else FEAT = r;
    return FEAT;
  });
}
function loadRules() {
  if (RULES) return Promise.resolve(RULES);
  return api('/api/rules').then(function (r) { if (r && r.sections) RULES = r; return RULES; });
}
// 页内悬停浮层：多行排版（换行 + 空行分段），跟随鼠标、自动避让屏幕边
function showRtip(ev, title, body) {
  hideRtip();
  rtipEl = el('div', 'rtip');
  var h = el('div', 'rt-h', title);
  rtipEl.appendChild(h);
  var bodyEl = el('div', 'rt-b');
  bodyEl.style.whiteSpace = 'pre-wrap';
  String(body || '').split('\n').forEach(function (line, i) {
    if (i) bodyEl.appendChild(document.createElement('br'));
    bodyEl.appendChild(mdBold(line));
  });
  rtipEl.appendChild(bodyEl);
  document.body.appendChild(rtipEl);
  moveRtip(ev);
}
function moveRtip(ev) {
  if (!rtipEl) return;
  var w = rtipEl.offsetWidth, h2 = rtipEl.offsetHeight;
  var x = Math.min(ev.clientX + 14, window.innerWidth - w - 10);
  var y = ev.clientY + 16;
  if (y + h2 > window.innerHeight - 8) y = Math.max(8, ev.clientY - h2 - 12);
  rtipEl.style.left = x + 'px';
  rtipEl.style.top = y + 'px';
}
function hideRtip() { if (rtipEl) { rtipEl.remove(); rtipEl = null; } }
// 规矩行：名字 + 一句话；悬停浮层 = 详细规矩（多行）+ 具体数值；带可改数值的行尾有「改」按钮（v71）
function ruleRow(r) {
  var row = el('div', 'rrow');
  row.appendChild(el('span', 'rn', r.n));
  row.appendChild(el('span', 'rd', r.d));
  if (r.e && r.e.length) {
    var b = el('span', 'rcfg', '改');
    b.title = '点这里改这条规矩里的数值';
    b.onclick = function (ev) {
      ev.stopPropagation();
      hideRtip();
      cfgEditBox(r.n, r.e, function () { renderContent(); });
    };
    row.appendChild(b);
  }
  row.title = '';   // 说明走页内浮层
  row.onmouseenter = function (e) { showRtip(e, r.n, r.t || r.d || ''); };
  row.onmousemove = moveRtip;
  row.onmouseleave = hideRtip;
  return row;
}
// 数值编辑弹层（v71，不用原生 prompt——沙箱/预览里会被静默屏蔽）。
// fields = [{k,label,unit,scale,v,tip}]；界面填的数 × scale = config 里的值。
function cfgEditBox(title, fields, done) {
  var d = document.getElementById('dlg');
  d.textContent = '';
  var h = el('p', null, title); h.style.fontWeight = '600';
  d.appendChild(h);
  var inputs = [];
  fields.forEach(function (f) {
    var row = el('div', null);
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0';
    var lab = el('span', null, f.label + '：');
    lab.style.cssText = 'flex:0 0 auto;font-size:12px';
    lab.title = f.tip || '';
    var inp = document.createElement('input');
    inp.type = 'text'; inp.inputMode = 'decimal';
    inp.style.cssText = 'width:90px';
    inp.value = (f.v == null ? '' : String(Math.round(f.v / f.scale * 1000) / 1000));
    var un = el('span', null, f.unit);
    un.style.cssText = 'font-size:12px;opacity:.7;flex:0 0 auto';
    row.appendChild(lab); row.appendChild(inp); row.appendChild(un);
    d.appendChild(row);
    inputs.push({ f: f, inp: inp });
  });
  var hint = el('div', null, '改完点保存立刻生效（写进 config.json，不用重启机器人）。等待类的填 0 = 不等。');
  hint.style.cssText = 'font-size:12px;opacity:.65;margin-top:4px';
  d.appendChild(hint);
  var acts = el('div', 'acts');
  var bNo = el('button', null, '取消'); bNo.onclick = closeDlg;
  var bOk = el('button', 'main', '保存');
  bOk.onclick = function () {
    var vals = [];
    for (var i = 0; i < inputs.length; i++) {
      var x = inputs[i];
      var s = String(x.inp.value).trim();
      var n = Number(s);
      if (!s || !isFinite(n)) { toast('「' + x.f.label + '」要填数字'); return; }
      vals.push({ k: x.f.k, v: n });
    }
    var seq = Promise.resolve();
    vals.forEach(function (it) {
      seq = seq.then(function () { return POST('/api/cfgset', { k: it.k, v: it.v }); }).then(function (r) {
        if (r && r.error) throw new Error(r.error);
      });
    });
    seq.then(function () {
      closeDlg();
      RULES = null;
      toast('数值改好了，立刻生效');
      if (done) done();
    }).catch(function (e) { toast('没存上：' + (e.message || e)); });
  };
  acts.appendChild(bNo); acts.appendChild(bOk);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}
function openFeatures() {
  featOff = 0;
  FEAT_FILTER = '全部';
  openPage('__features', function () {
    return { fileId: '__features', path: [], titles: ['功能与规矩'], title: '功能与规矩', name: '功能与规矩' };
  }, function () { return Promise.all([loadFeatures(false), loadRules()]); });
}
function renderRulesBook(box) {
  box.appendChild(el('div', 'tgroup', '规矩手册（悬停看完整规矩和具体数值 · 数字现读配置，改了就跟着变）'));
  if (!RULES || !RULES.sections) { box.appendChild(el('div', 'empty', '正在读取…')); return; }
  RULES.sections.forEach(function (sec) {
    var g = el('div', 'rgrp', sec.name);
    var list = el('div', 'rlist');
    sec.rules.forEach(function (r) { list.appendChild(ruleRow(r)); });
    box.appendChild(g);
    box.appendChild(list);
  });
}
// 功能列表：按类别分组（连接 / 聊天回应 / 学习 / 内容与记忆 / 定时任务 / 工具）
function renderFeatureList(box) {
  box.appendChild(el('div', 'tgroup', '功能列表（按类别 · 现在的状态）'));
  if (!FEAT || !FEAT.states) { box.appendChild(el('div', 'empty', '正在读取…')); return; }
  var byKind = {};
  var order = [];
  FEAT.states.forEach(function (s) {
    var k = s.kind || '其他';
    if (!byKind[k]) { byKind[k] = []; order.push(k); }
    byKind[k].push(s);
  });
  order.forEach(function (k) {
    var g = el('div', 'rgrp', k + '（' + byKind[k].length + '）');
    var grid = el('div', 'flist2');
    byKind[k].forEach(function (s) {
      var on = s.state === '启用';
      var row = el('div', 'frow2');
      var st = el('span', 'fst ' + (on ? 'on' : 'off'), on ? '开' : (s.state.indexOf('停用') === 0 ? '停用' : '关'));
      st.title = s.state;
      row.appendChild(st);
      row.appendChild(el('span', 'fn', s.name));
      row.title = '';
      row.onmouseenter = function (e) { showRtip(e, s.name, '当前状态：' + s.state + '\n这个状态从 ' + fmtTs(s.since) + ' 开始（面板启动时记录）'); };
      row.onmousemove = moveRtip;
      row.onmouseleave = hideRtip;
      grid.appendChild(row);
    });
    box.appendChild(g);
    box.appendChild(grid);
  });
}
// 变更记录：筛选（全部/启用/禁用/配置变更/快照）+ 倒序紧凑行
function renderFeatChanges(box) {
  if (!FEAT) return;
  box.appendChild(el('div', 'tgroup', '变更记录（共 ' + FEAT.total + ' 条 · 改 config 十几秒内记一条）'));
  var bar = el('div', null, '');
  bar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap';
  ['全部', '启用', '禁用', '配置变更', '启动快照'].forEach(function (f) {
    var c = el('span', 'chip' + (FEAT_FILTER === f ? ' act' : ''), f);
    c.onclick = function () { FEAT_FILTER = f; renderContent(); };
    bar.appendChild(c);
  });
  box.appendChild(bar);
  var list2 = el('div', 'rlist');
  var shown = FEAT.list.filter(function (x) { return FEAT_FILTER === '全部' || x.action === FEAT_FILTER; });
  if (!shown.length) list2.appendChild(el('div', 'empty', '这一类还没有记录'));
  shown.forEach(function (x) {
    var row = el('div', 'rrow');
    var tm = el('span', 'rv', fmtTs(x.t));
    row.appendChild(el('span', 'rn', x.name));
    row.appendChild(el('span', 'rd', (x.action === '配置变更' ? '参数改了（开关没变）' : x.detail || '')));
    row.appendChild(tm);
    row.title = '';
    row.onmouseenter = function (e) { showRtip(e, x.name + ' · ' + x.action, (x.detail || '') + '\n时间：' + fmtTs(x.t) + '\n当时状态：' + (x.state || '—')); };
    row.onmousemove = moveRtip;
    row.onmouseleave = hideRtip;
    list2.appendChild(row);
  });
  box.appendChild(list2);
  if (FEAT.list.length < FEAT.total) {
    var more = el('button', 'cdel', '加载更多（还有 ' + (FEAT.total - FEAT.list.length) + ' 条）');
    more.onclick = function () { featOff = FEAT.list.length; loadFeatures(true).then(renderContent); };
    box.appendChild(more);
  }
}
function renderFeatures(t, box) {
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '我的控制台'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', '功能与规矩'));
  box.appendChild(el('p', 'pgsub', '她的全部规矩（悬停看细则和数值）+ 功能现状 + 开关记录。规矩里的数字是实时读的配置，面板里改了就跟着变。'));
  renderRulesBook(box);
  renderFeatureList(box);
  renderFeatChanges(box);
}

/* ---------- 看每个人 / 看每个场所（短期记忆，主人 2026-10-22 定） ----------
 * 单开一个入口，两种看法可切换：
 *   只看人物：选一个人 → 他说的全部话（私聊和群聊都算），可用场所再收窄（某群 / 私聊）
 *   只看场所：选一个群或私聊 → 那个场合里所有人的完整对话
 * 机器人回复时会自动带上说话人最近说过的话当短期记忆（core.shortTermBlock）
 */
var WHO = null;   // {bot, list}
function loadWho() {
  return api('/api/who').then(function (r) { if (r && r.list) WHO = r; return WHO; });
}
async function openWho() {
  var first = (WHO && WHO.list.indexOf('主人') >= 0) ? '主人' : ((WHO && WHO.list[0]) || '');
  openPage('__who', function () {
    return { fileId: '__who', path: [], titles: ['看每个人'], title: '看每个人', name: '看每个人', mode: 'who', who: first, scope: '' };
  }, function () { return Promise.all([loadWho(), loadChat()]); });
}
// 场景里出现过的所有场所（群 + 私聊），按出现顺序
function chatScopes() {
  var out = [];
  (CHAT && CHAT.list || []).forEach(function (e) {
    if (e.scope && out.indexOf(e.scope) < 0) out.push(e.scope);
  });
  return out;
}
// 把聊天记录按「谁说的」分组：每条真人消息 + 紧跟其后的它的回话
function chatGroups(list, match) {
  var groups = [], cur = null;
  list.forEach(function (e) {
    if (e.bot) {
      var host = null;
      if (e.to) {
        for (var i = groups.length - 1; i >= 0 && groups.length - i <= 15; i--) {
          if (groups[i].e.nick === e.to) { host = groups[i]; break; }
        }
      }
      host = host || cur;
      if (host) host.reps.push(e);
      return;
    }
    if (!match(e)) { cur = null; return; }
    cur = { e: e, reps: [] };
    groups.push(cur);
  });
  return groups;
}
function chatCard(g, box) {
  var card = el('div', 'cht');
  var head = el('div', 'chh');
  head.appendChild(el('span', 'chn', g.e.nick || '未知'));
  if (g.e.scope) head.appendChild(el('span', 'csc', g.e.scope));
  if (g.e.mine) { var me = el('span', 'csc', '我'); me.title = '主人自己说的'; head.appendChild(me); }
  var nPieces = (g.e.pieces || []).length;
  if (nPieces > 1) head.appendChild(el('span', 'csc', nPieces + ' 条一起说'));
  if (g.e.img) head.appendChild(el('span', 'csc', '图'));
  head.appendChild(el('span', 'chtm', fmtTs(g.e.t)));
  if (CHAT.linked && CHAT.linked[g.e.key]) {
    var lk = el('span', 'csc', '曾联动');
    lk.title = '这条星标过 → 已经算总结过（话题日志里有对应条目）';
    head.appendChild(lk);
  }
  var star = el('button', 'cst' + (g.e.starred ? ' on' : ''), g.e.starred ? '★' : '☆');
  star.title = g.e.starred ? '取消星标（联动的话题也会一起收走）' : '标个星（星标 = 直接算已总结）';
  star.onclick = function (ev) {
    ev.stopPropagation();
    POST('/api/chat/star', { item: g.e, on: !g.e.starred }).then(function (r) {
      if (r.error) return toast(r.error);
      g.e.starred = !g.e.starred;
      star.textContent = g.e.starred ? '★' : '☆';
      star.classList.toggle('on', g.e.starred);
      if (CHAT.linked) { if (g.e.starred) CHAT.linked[g.e.key] = '1'; else delete CHAT.linked[g.e.key]; }
    });
  };
  head.appendChild(star);
  var bTopic = el('button', 'cst', '→话题');
  bTopic.title = '把这条收进话题日志（长期记忆 → 话题日志）';
  bTopic.onclick = function (ev) {
    ev.stopPropagation();
    POST('/api/topic/add', { text: g.e.text, who: g.e.nick || '', nick: g.e.nick || '', scope: g.e.scope || '', type: 'quote', to: 'log' }).then(function (r) {
      if (r.error) return toast(r.error);
      toast('收进话题日志了');
    });
  };
  head.appendChild(bTopic);
  card.appendChild(head);
  var tx = el('div', 'chtx');
  tx.textContent = g.e.text || '（空）';
  card.appendChild(tx);
  g.reps.forEach(function (r) {
    var wrap = el('div', 'chrline');
    wrap.appendChild(el('span', 'chrto', '回 → ' + (r.to || '…')));
    var line = el('div', 'chr');
    line.textContent = r.text || '（空）';
    wrap.appendChild(line);
    card.appendChild(wrap);
  });
  box.appendChild(card);
}
function renderWho(t, box) {
  if (!CHAT || !WHO) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingChat) { window.__loadingChat = 1; Promise.all([loadChat(), loadWho()]).then(function () { window.__loadingChat = 0; renderContent(); }); }
    return;
  }
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '我的控制台'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', '看每个人 / 看每个场所'));
  box.appendChild(el('p', 'pgsub', '短期记忆：单开看某个人说过的全部话（私聊群聊都算），或某个场合的完整对话。'
    + '机器人回复时会自动带上说话人最近说过的话——他提「之前 / 上次」的时候接得上。'
    + '（认人表、约定、话题那些是长期记忆，在「长期记忆」文件夹里。）'));

  var listBox = el('div', 'clist');
  var bar = el('div', 'cbar');
  var mk = function (label, on, fn, tip) {
    var b = el('button', 'cchip' + (on ? ' on' : ''), label);
    if (tip) b.title = tip;
    b.onclick = fn;
    return b;
  };
  // 看法切换：只看人物 / 只看场所
  bar.appendChild(mk('只看人物', t.mode !== 'scope', function () { t.mode = 'who'; renderContent(); }, '选一个人，看他全部的话'));
  bar.appendChild(mk('只看场所', t.mode === 'scope', function () { t.mode = 'scope'; renderContent(); }, '选一个群或私聊，看那个场合的完整对话'));
  bar.appendChild(el('span', 'cspacer'));
  var scopes = chatScopes();
  if (t.mode === 'scope') {
    // 场所下拉（必选）
    var ss = document.createElement('select');
    ss.className = 'cnick';
    scopes.forEach(function (s) { var o = el('option', null, s); o.value = s; ss.appendChild(o); });
    if (!scopes.length) { var o0 = el('option', null, '（还没有记录）'); o0.value = ''; ss.appendChild(o0); }
    ss.value = t.scope && scopes.indexOf(t.scope) >= 0 ? t.scope : (scopes[0] || '');
    t.scope = ss.value;
    ss.title = '选个群或私聊';
    ss.onchange = function () { t.scope = ss.value; renderContent(); };
    bar.appendChild(ss);
  } else {
    // 人物下拉 + 场所收窄
    var ws = document.createElement('select');
    ws.className = 'cnick';
    (WHO.list || []).forEach(function (n) { var o = el('option', null, n); o.value = n; ws.appendChild(o); });
    if (!(WHO.list || []).length) { var w0 = el('option', null, '（还没有人）'); w0.value = ''; ws.appendChild(w0); }
    ws.value = t.who && (WHO.list || []).indexOf(t.who) >= 0 ? t.who : ((WHO.list || [])[0] || '');
    t.who = ws.value;
    ws.title = '看谁（认人表里的 + 聊过天的都算）';
    ws.onchange = function () { t.who = ws.value; renderContent(); };
    bar.appendChild(ws);
    var ss2 = document.createElement('select');
    ss2.className = 'cnick';
    var a0 = el('option', null, '全部场所'); a0.value = ''; ss2.appendChild(a0);
    scopes.forEach(function (s) { var o = el('option', null, s); o.value = s; ss2.appendChild(o); });
    ss2.value = t.scope || '';
    ss2.title = '收窄到某个群 / 私聊（不选 = 私聊群聊全看）';
    ss2.onchange = function () { t.scope = ss2.value; renderContent(); };
    bar.appendChild(ss2);
  }
  var bRe = el('button', 'cdel', '↻ 刷新');
  bRe.onclick = function () { Promise.all([loadChat(), loadWho()]).then(renderContent); };
  bar.appendChild(bRe);
  bar.appendChild(el('span', 'cspacer'));
  var bAll = el('button', 'cdel', '在全部聊天记录里看');
  bAll.onclick = function () { openChat(); };
  bar.appendChild(bAll);
  box.appendChild(bar);
  box.appendChild(listBox);

  listBox.textContent = '';
  var groups;
  if (t.mode === 'scope') {
    if (!t.scope) { listBox.appendChild(el('div', 'empty', '还没有聊天记录。')); return; }
    groups = chatGroups(CHAT.list, function (e) { return e.scope === t.scope; });
    if (!groups.length) { listBox.appendChild(el('div', 'empty', '这个场合还没有记录。')); return; }
  } else {
    if (!t.who) { listBox.appendChild(el('div', 'empty', '还没有可看的人。他在群里或私聊里说过话之后，这里就会出现。')); return; }
    groups = chatGroups(CHAT.list, function (e) {
      if (e.nick !== t.who) return false;
      if (t.scope && e.scope !== t.scope) return false;
      return true;
    });
    if (!groups.length) {
      listBox.appendChild(el('div', 'empty', t.scope ? '这个人在这个场合还没有记录。' : '还没有这个人的记录。他在群里或私聊里说过话之后，这里就会出现。'));
      return;
    }
  }
  groups.reverse();
  groups.forEach(function (g) { chatCard(g, listBox); });
}

/* 情绪表情表：点开它直接进表情功能页（页面代码在 sticker-page.js，面板与客户端共用） */
var STICKER_EMO_ID = 'data/情绪表情.json';

/* ---------- 原文页：看/改 代码、config、json（代码只读，config/json 可改带校验） ---------- */
var RAW = {};
function loadRaw(id) {
  return api('/api/raw?id=' + encodeURIComponent(id)).then(function (r) {
    if (r.error) { toast(r.error); return null; }
    RAW[id] = r; return r;
  });
}
/* ---------- html 文件自己的页（主人 2026-10-22 22:37 铁律） ----------
 * 一个入口两用：既能看成品、也能查代码原文，不再为「看代码」多开一条左列。
 */
function openHtmlFile(id) {
  openPage('__html_' + id, function () {
    return { fileId: '__html_' + id, path: [], titles: [id], title: id, name: id, htmlId: id };
  }, function () {});
}
function renderHtmlFile(t, box) {
  var id = t.htmlId;
  var m = FILEMETA[id] || {};
  var nm = (FILES.find(function (f) { return f.id === id; }) || {}).name || id;
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', nm));
  if (m.use) box.appendChild(el('p', 'pgsub', m.use));
  var bar = el('div', 'cbar');
  bar.style.margin = '8px 0 12px';
  var b1 = el('button', 'cdel', '在浏览器里打开');
  b1.title = '用浏览器新标签页打开这个 html（原样的成品页面）';
  b1.onclick = function () { window.open('/view/' + encodeURIComponent(id), '_blank'); };
  bar.appendChild(b1);
  var b2 = el('button', 'cdel', '看这个文件的代码原文');
  b2.title = '就在面板里读这个文件；代码会按段切开，鼠标放上去看这一段是干嘛的';
  b2.onclick = function () { openRaw(id); };
  bar.appendChild(b2);
  box.appendChild(bar);
  box.appendChild(el('div', 'gy', '这两个都在这个入口里，左边不会再多出一条——「看代码」和「看成品」是一个文件的两面。'));
}

async function openRaw(id) {
  var nm = id.split('/').pop();
  openPage('__raw_' + id, function () {
    return { fileId: '__raw_' + id, rawId: id, path: [], titles: [nm], title: nm, name: nm };
  }, function () { return loadRaw(id); });
}
function renderRaw(t, box) {
  var id = t.rawId;
  // 表情功能：点开「情绪表情.json」直接进表情总页（v88）。要碰原文点页里的「改 JSON 原文」→ t.rawMode
  if (id === STICKER_EMO_ID && !t.rawMode) {
    window.StickerPage.mount(box, { el: el, toast: toast, api: api, POST: POST,
      rerender: renderContent, openRaw: openRaw });
    return;
  }
  var meta = RAW[id];
  box.appendChild(el('div', 'crumb')).appendChild(el('b', null, '其他 / 系统文件'));
  box.appendChild(el('h1', 'pg', id.split('/').pop()));
  if (!meta) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingRaw) { window.__loadingRaw = 1; loadRaw(id).then(function () { window.__loadingRaw = 0; renderContent(); }); }
    return;
  }
  var sub = el('p', 'pgsub');
  sub.textContent = (meta.use || '') + (meta.range ? '　·　区间 / 含义：' + meta.range : '');
  box.appendChild(sub);
  var bar = el('div', 'tbar');
  if (!meta.ro) {
    var ta = document.createElement('textarea');
    ta.value = meta.raw || '';
    ta.style.cssText = 'width:100%;min-height:50vh;border:1px solid var(--bd2);border-radius:10px;padding:12px 14px;font:12.5px/1.7 ui-monospace,Consolas,monospace;resize:vertical;background:#fcfcfe;color:var(--tx)';
    var bSave = el('button', 'tsave off', '保存');
    ta.oninput = function () { bSave.classList.remove('off'); };
    bSave.onclick = function () {
      bSave.classList.add('off'); bSave.textContent = '保存中…';
      POST('/api/raw', { id: id, raw: ta.value }).then(function (r) {
        bSave.textContent = '保存';
        if (r.error) { toast(r.error); bSave.classList.remove('off'); return; }
        toast('已保存'); loadRaw(id);
      });
    };
    var bRe = el('button', null, '重读'); bRe.onclick = function () { loadRaw(id).then(renderContent); };
    bar.appendChild(bSave); bar.appendChild(bRe);
    // 表情表看过原文之后，一键回到表格页（不另开入口，还是这一页）
    if (id === STICKER_EMO_ID) {
      var bBack = el('button', null, '← 回到表情表格');
      bBack.title = '回表格式的编辑页（推荐：改表格不会碰到 JSON 符号）';
      bBack.onclick = function () { t.rawMode = false; renderContent(); };
      bar.appendChild(bBack);
    }
    box.appendChild(bar);
    box.appendChild(ta);
  } else {
    box.appendChild(el('p', 'pgsub', '🔒 这是只读文件——怕你碰坏它，所以只能看。真要改，让虚幻的主人改代码。' + (meta.segs ? '鼠标停在任意一段上，会显示这一段是干嘛的。' : '')));
    var pre;
    if (meta.segs && meta.segs.length) {
      // 代码文件按段渲染：每段一个块，悬停显示大白话说明（主人 2026-10-23 定）
      var wrap = el('div');
      wrap.style.cssText = 'width:100%;min-height:50vh;overflow:auto;border:1px solid var(--bd);border-radius:10px;padding:6px;background:#fbfbfd;margin:0';
      meta.segs.forEach(function (s) {
        var d = el('div', 'segblk');
        d.title = s.tip || '（这一段还没有专门说明）';
        pre = document.createElement('pre');
        pre.textContent = s.code;
        pre.style.cssText = 'font:12.5px/1.7 ui-monospace,Consolas,monospace;color:var(--tx2);margin:0;white-space:pre-wrap;word-break:break-word';
        d.appendChild(pre);
        wrap.appendChild(d);
      });
      box.appendChild(wrap);
    } else {
      pre = document.createElement('pre');
      pre.textContent = meta.raw || '（空）';
      pre.style.cssText = 'width:100%;min-height:50vh;overflow:auto;border:1px solid var(--bd);border-radius:10px;padding:12px 14px;font:12.5px/1.7 ui-monospace,Consolas,monospace;background:#fbfbfd;color:var(--tx2);margin:0;white-space:pre-wrap;word-break:break-word';
      box.appendChild(pre);
    }
  }
}

function renderMap(t, box) {
  box.appendChild(el('div', 'crumb')).appendChild(el('b', null, '数据与日志'));
  box.appendChild(el('h1', 'pg', '触发地图'));
  if (!MAP) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingMap) {
      window.__loadingMap = 1;
      loadMap().then(function () { window.__loadingMap = 0; renderContent(); });
    }
    return;
  }
  var c = MAP.chime || {};
  box.appendChild(el('p', 'pgsub',
    '它想说话有 ' + MAP.paths.length + ' 个入口。数字是现读 config 的，改完不用刷新文档。'
    + (c.enabled ? '「凑个热闹」开着：每句约 ' + (c.p * 100).toFixed(1) + '% 概率接，两条间隔 ≥'
      + c.cooldownMin + ' 分钟，每群每天最多 ' + c.dailyMax + ' 句。' : '「凑个热闹」现在是关的。')));

  var wrap = el('div', 'tmap');
  MAP.paths.forEach(function (p) {
    var card = el('div', 'tmapcard');
    var h = el('div', 'tmaph');
    h.appendChild(el('span', 'tmapt', p.title));
    var badge = el('span', 'tmapm ' + (p.color || ''), p.mode);
    h.appendChild(badge);
    card.appendChild(h);
    [['条件', p.cond], ['限流', p.limit], ['用到的文件', p.file], ['说的', p.note]].forEach(function (kv) {
      if (!kv[1] || kv[1] === '—') return;
      var r = el('div', 'tmapr');
      r.appendChild(el('span', 'tmapk', kv[0]));
      r.appendChild(el('span', 'tmapv', kv[1]));
      card.appendChild(r);
    });
    wrap.appendChild(card);
  });
  box.appendChild(wrap);

  box.appendChild(el('p', 'pgsub', '觉得它话太少 / 太多，改 config.json 里的 autoAsk 和 chime：p 是概率（0.02 ≈ 每 50 句搭一句）、cooldownMs 是两条之间至少隔多久、dailyMax 是每群每天主动说话上限。'));
}

function fmtTs(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 16);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

var chatF = {
  scope: '', nick: '', star: false, kw: '',
  desc: true,        // true=新的在前（倒序），false=正序
  hideMe: false,     // 只去掉我（主人自己说的不显示）
  onlyImg: false,    // 只看图片
  onlyMerged: false, // 只看多条一起说的
  onlyReply: false,  // 只看带引用回复的（主人 2026-10-22 定）
  days: 0,           // 时间筛选：0=全部，1=今天，3/7/30=最近 N 天
  emo: ''            // ''=不过滤 | 'has'=有情绪 | 'leak'=漏判（扫出来还没加）
};
/* 情绪书数据（叶 + 应对），聊天记录页改情绪 / 显示应对时要。开聊天页时拉一次缓存。 */
var EMOBOOK = null;
function loadEmobook() {
  if (EMOBOOK) return Promise.resolve(EMOBOOK);
  return api('/api/emobook').then(function (r) {
    if (r && r.tree) { EMOBOOK = r.tree; return EMOBOOK; }
    return null;
  }).catch(function () { return null; });
}
/* 按叶名取应对文案（递归展开，和情绪书页同逻辑）；返回字符串数组 */
function leafReplies(name) {
  if (!EMOBOOK || !EMOBOOK.leaves) return [];
  var lf = EMOBOOK.leaves.find(function (x) { return x.name === name; });
  if (!lf || !lf.replies || !lf.replies.length) return [];
  var map = {}; (EMOBOOK.replies || []).forEach(function (r) { if (r && r.id) map[r.id] = r; });
  var out = [], seen = {};
  lf.replies.forEach(function walk(id) {
    if (seen[id]) return; seen[id] = 1;
    var r = map[id]; if (!r) return;
    if (r.text) out.push(String(r.text));
    (r.ref || []).forEach(walk);
  });
  return out;
}

function hlNodes(text, kw) {
  var s = String(text == null ? '' : text);
  if (!kw) return [document.createTextNode(s)];
  var out = [], low = s.toLowerCase(), k = kw.toLowerCase(), i = 0;
  while (i < s.length) {
    var p = low.indexOf(k, i);
    if (p < 0) { out.push(document.createTextNode(s.slice(i))); break; }
    if (p > i) out.push(document.createTextNode(s.slice(i, p)));
    out.push(el('mark', null, s.slice(p, p + k.length)));
    i = p + k.length;
  }
  return out;
}

// 按当前筛选条件过滤（合并消息 pieces 里任意一条命中就算）
function chatKeep(e) {
  if (e.bot) return false;
  if (chatF.scope && e.scope !== chatF.scope) return false;
  if (chatF.nick && e.nick !== chatF.nick) return false;
  if (chatF.star && !e.starred) return false;
  if (chatF.hideMe && e.mine) return false;
  if (chatF.onlyImg && !e.img) return false;
  if (chatF.onlyMerged && (e.pieces || []).length < 2) return false;
  if (chatF.onlyReply && !e.replyTo) return false;
  if (chatF.days) {
    var t = Date.parse(e.t);
    if (!isNaN(t) && t < Date.now() - chatF.days * 86400000) return false;
  }
  // 情绪筛选（主人 2026-11-07 定：聊天记录能和情绪书联动）
  if (chatF.emo === 'has' && !e.emo) return false;
  if (chatF.emo === 'leak') {
    var lk = window.__leakKeys || {};
    if (!e.emo && !lk[e.key]) return false;   // 漏判 = 没情绪映射、且扫出来能判出叶
  }
  return true;
}

function renderChat(t, box) {
  if (!CHAT) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingChat) {
      window.__loadingChat = 1;
      loadChat().then(function () { window.__loadingChat = 0; renderContent(); });
    }
    return;
  }
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, '聊天记录'));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', '聊天记录'));

  var ppl = CHAT.list.filter(function (e) { return !e.bot; }).length;
  var merged = CHAT.list.filter(function (e) { return !e.bot && (e.pieces || []).length > 1; }).length;
  var starred = CHAT.list.filter(function (e) { return e.starred && !e.bot; }).length;
  var lastT = CHAT.list.length ? fmtTs(CHAT.list[CHAT.list.length - 1].t) : '';
  box.appendChild(el('p', 'pgsub', '只列别人说的（' + ppl + ' 条，共 ' + (CHAT.total || CHAT.list.length) + ' 行，其中 ' + merged
    + ' 条是一口气连着说的）· 星标 ' + starred + ' 条'
    + (lastT ? '· 最后一条 ' + lastT : '') + '。它怎么回的，点「看它怎么回的」才展开。'));

  var listBox = el('div', 'clist');

  // ---- 筛选行 ----
  var bar = el('div', 'cbar');
  var scopes = [];
  CHAT.list.forEach(function (e) { if (e.scope && scopes.indexOf(e.scope) < 0) scopes.push(e.scope); });
  var nickSet = [];
  CHAT.list.forEach(function (e) { if (!e.bot && e.nick && nickSet.indexOf(e.nick) < 0) nickSet.push(e.nick); });

  var mk = function (label, on, fn, tip) {
    var b = el('button', 'cchip' + (on ? ' on' : ''), label);
    if (tip) b.title = tip;
    b.onclick = fn;
    return b;
  };
  var anyF = chatF.scope || chatF.nick || chatF.star || chatF.hideMe || chatF.onlyImg || chatF.onlyMerged || chatF.onlyReply || chatF.days;
  bar.appendChild(mk('全部', !anyF, function () {
    chatF.scope = ''; chatF.nick = ''; chatF.star = false;
    chatF.hideMe = false; chatF.onlyImg = false; chatF.onlyMerged = false; chatF.onlyReply = false; chatF.days = 0;
    renderContent();
  }));
  scopes.forEach(function (s) {
    bar.appendChild(mk(s, chatF.scope === s, function () { chatF.scope = chatF.scope === s ? '' : s; renderContent(); }));
  });
  bar.appendChild(mk('★ 只看星标', chatF.star, function () {
    chatF.star = !chatF.star;
    // 星标可能标在很早的记录上，默认只拉了最后 2000 条，会一颗都翻不到 → 第一次点先拉全量
    if (chatF.star && !(CHAT && CHAT.full)) { loadChat(true).then(function () { renderContent(); }); return; }
    renderContent();
  }));
  bar.appendChild(mk('去掉我', chatF.hideMe, function () { chatF.hideMe = !chatF.hideMe; renderContent(); }, '把我自己说的那些藏起来，只看别人的'));
  bar.appendChild(mk('只看图', chatF.onlyImg, function () { chatF.onlyImg = !chatF.onlyImg; renderContent(); }, '只留带图片的消息'));
  bar.appendChild(mk('只看连着说的', chatF.onlyMerged, function () { chatF.onlyMerged = !chatF.onlyMerged; renderContent(); }, '只留一口气发了好几条的（机器人把它们合成一条答）'));
  bar.appendChild(mk('只看有回复的', chatF.onlyReply, function () { chatF.onlyReply = !chatF.onlyReply; renderContent(); }, '只留带引用回复的消息（点蓝色「↩ 回复 xx」能定位原消息）'));
  bar.appendChild(mk('有情绪', chatF.emo === 'has', function () { chatF.emo = chatF.emo === 'has' ? '' : 'has'; renderContent(); }, '只看已经判出 / 手改过情绪的记录'));
  bar.appendChild(mk('漏判', chatF.emo === 'leak', function () {
    chatF.emo = chatF.emo === 'leak' ? '' : 'leak';
    if (chatF.emo === 'leak' && !window.__leakKeys) { chatScanLeak(); return; }   // 第一次点先扫
    renderContent();
  }, '只看「能判出情绪、但还没记」的漏判（点旁边 🔍 补漏判来扫）'));

  // 时间筛选
  var dsel = document.createElement('select');
  dsel.className = 'cnick';
  [['0', '全部时间'], ['1', '今天'], ['3', '3 天内'], ['7', '7 天内'], ['30', '30 天内']].forEach(function (o) {
    var op = el('option', null, o[1]); op.value = o[0]; dsel.appendChild(op);
  });
  dsel.value = String(chatF.days);
  dsel.title = '按时间筛';
  dsel.onchange = function () { chatF.days = Number(dsel.value) || 0; renderContent(); };
  bar.appendChild(dsel);

  // 人物（只看某人）
  if (nickSet.length) {
    var sel = document.createElement('select');
    sel.className = 'cnick';
    var op0 = el('option', null, '所有人'); op0.value = ''; sel.appendChild(op0);
    nickSet.forEach(function (n) { var o = el('option', null, n); o.value = n; sel.appendChild(o); });
    sel.value = chatF.nick || '';
    sel.title = '只看某一个人说的';
    sel.onchange = function () { chatF.nick = sel.value; renderContent(); };
    bar.appendChild(sel);
  }

  // 正序 / 倒序
  bar.appendChild(mk(chatF.desc ? '↓ 新→旧' : '↑ 旧→新', true, function () {
    chatF.desc = !chatF.desc; renderContent();
  }, '按时间正序还是倒序看'));

  var kwInp = document.createElement('input');
  kwInp.className = 'ckw';
  kwInp.placeholder = '搜内容（它说的也算）';
  kwInp.value = chatF.kw || '';
  kwInp.oninput = function () {
    chatF.kw = kwInp.value;
    clearTimeout(kwInp._t);
    kwInp._t = setTimeout(function () { paintChatList(listBox); }, 180);   // 只重画列表，输入框不丢焦点
  };
  bar.appendChild(kwInp);

  bar.appendChild(el('span', 'cspacer'));

  var bLeak = el('button', 'cdel', '🔍 补漏判');
  bLeak.title = '扫一遍聊天记录，找出「能判出情绪但还没记」的漏判，预览后可一键加进去';
  bLeak.onclick = function () { chatScanLeak(true); };
  bar.appendChild(bLeak);

  var bRe = el('button', 'cdel', '↻ 刷新');
  bRe.title = '重新读一遍聊天记录（新消息才看得到）';
  bRe.onclick = function () { loadChat().then(renderContent); };
  bar.appendChild(bRe);

  var b7 = el('button', 'cdel', '清空 7 天前');
  b7.title = '只保留最近 7 天的记录';
  b7.onclick = function () {
    confirmBox('删掉 7 天前的聊天记录？\n（星标那几条也会一起没，因为它删的是原始日志）', function () {
      POST('/api/chat/clear', { scope: 'old7' }).then(function (r) {
        if (r.error) return toast(r.error);
        toast('删了 ' + r.removed + ' 行，留下 ' + r.kept + ' 行');
        loadChat().then(renderContent);
      });
    });
  };
  bar.appendChild(b7);

  var bAll = el('button', 'cdel danger', '清空全部');
  bAll.title = '把聊天记录整个清掉';
  bAll.onclick = function () {
    confirmBox('把聊天记录全部清空？\n这个删掉就找不回来了。', function () {
      POST('/api/chat/clear', { scope: 'all' }).then(function (r) {
        if (r.error) return toast(r.error);
        toast('已清空 ' + r.removed + ' 行');
        loadChat().then(renderContent);
      });
    });
  };
  bar.appendChild(bAll);
  box.appendChild(bar);
  box.appendChild(listBox);

  paintChatList(listBox);
}

function paintChatList(box) {
  box.textContent = '';
  var kw = (chatF.kw || '').trim();

  // 分组：别人说的 + 它的回话。
  // v78 硬限制（主人 2026-10-23 定）：回话按记录里的触发人 [→X] 挂到 X 名下，
  // 不再按「时间上紧挨着谁」猜——她回得慢，群里 0.1 秒一条，顺序猜必然记错人。
  // 旧记录没有 [→X]，才回退到「挂给上一条」的老办法。
  var groups = [], cur = null;
  CHAT.list.forEach(function (e) {
    if (e.bot) {
      var host = null;
      if (e.to) {
        for (var i = groups.length - 1; i >= 0 && groups.length - i <= 15; i--) {
          var g0 = groups[i];
          if (g0.e.nick === e.to && (!e.scope || g0.e.scope === e.scope)) { host = g0; break; }
        }
      }
      host = host || cur;
      if (host) host.reps.push(e);
      return;
    }
    if (!chatKeep(e)) { cur = null; return; }
    cur = { e: e, reps: [], autoOpen: false };
    groups.push(cur);
  });

  // 关键词过滤：别人说的、它说的，任意一个命中就算
  if (kw) {
    var k = kw.toLowerCase();
    groups = groups.filter(function (g) {
      var selfHit = String(g.e.text || '').toLowerCase().indexOf(k) >= 0;
      var repHit = g.reps.some(function (r) { return String(r.text || '').toLowerCase().indexOf(k) >= 0; });
      g.autoOpen = repHit && !selfHit;      // 只有它的话命中 → 自动展开，不然看不出为什么搜出来
      return selfHit || repHit;
    });
  }

  // 正序 / 倒序（分组在时间轴上做，展示再翻）
  if (chatF.desc) groups = groups.slice().reverse();

  if (!groups.length) {
    box.appendChild(el('div', 'empty',
      kw ? '没找到包含「' + kw + '」的记录' :
      (chatF.star ? '还没有星标的记录（在每条右边点 ☆）' : '这个筛选下没有记录')));
    return;
  }

  groups.forEach(function (g) {
    var card = el('div', 'cht');
    var head = el('div', 'chh');
    head.appendChild(el('span', 'chn', g.e.nick || '未知'));
    if (g.e.scope) head.appendChild(el('span', 'csc', g.e.scope));
    if (g.e.mine) { var me = el('span', 'csc', '我'); me.title = '主人自己说的'; head.appendChild(me); }
    if (g.e.asHer) {
      var ash = el('span', 'csc', '记成虚幻说的');
      ash.title = '这是主人对别人说的话——记录里按「虚幻自己说的」记（主人＝虚幻，她是她在网上的分身），它只是普通聊天记录，不算她的回复';
      head.appendChild(ash);
    }
    var nPieces = (g.e.pieces || []).length;
    if (nPieces > 1) {
      var mg = el('span', 'csc', nPieces + ' 条一起说');
      mg.title = '他一口气发了 ' + nPieces + ' 条，机器人把它们当成一条来答';
      head.appendChild(mg);
    }
    if (g.e.img) { var im = el('span', 'csc', '图'); im.title = '这条带图片'; head.appendChild(im); }
    if (g.e.replyTo) {
      var rb = el('span', 'csc repb', '↩ 回复 ' + (g.e.replyTo.nick || '某人'));
      rb.title = '他是在回复「' + (g.e.replyTo.frag || '…') + '」——点一下定位原消息';
      rb.onclick = function () { locateReplyChat(g.e.replyTo); };
      head.appendChild(rb);
    }
    head.appendChild(el('span', 'chtm', fmtTs(g.e.t) + (nPieces > 1 && g.e.tEnd && g.e.tEnd !== g.e.t ? ' ~ ' + fmtTs(g.e.tEnd) : '')));
    // 情绪徽标（主人 2026-11-07 定：聊天记录能和情绪书联动）。点它改情绪 / 看应对。
    if (g.e.emo) {
      var eb = el('span', 'emo-tag' + (g.e.emo.source === 'review' ? ' wrong' : (g.e.emo.source === 'user' ? ' user' : '')));
      eb.appendChild(el('span', 'emo-ic', '💢'));
      eb.appendChild(el('span', null, g.e.emo.leaf));
      if (g.e.emo.word) eb.appendChild(el('span', 'emo-w', '←' + g.e.emo.word));
      eb.title = '情绪：' + g.e.emo.leaf + (g.e.emo.word ? '（命中「' + g.e.emo.word + '」）' : '')
        + '\n点一下改情绪 / 看这一类的应对';
      eb.onclick = function (ev) { ev.stopPropagation(); openEmoDialog(g.e); };
      head.appendChild(eb);
    }
    card._key = g.e.t + '|' + g.e.nick;

    // 曾联动（主人 2026-10-22 v52 定：星标内容直接算已总结，聊天记录不动，只多这个标记）
    if (CHAT.linked && CHAT.linked[g.e.key]) {
      var lk = el('span', 'csc', '曾联动');
      lk.title = '这条星标过 → 已经算总结过（话题日志里有对应条目）';
      head.appendChild(lk);
    }

    var star = el('button', 'cst' + (g.e.starred ? ' on' : ''), g.e.starred ? '★' : '☆');
    star.title = g.e.starred ? '取消星标（联动的话题也会一起收走）' : '标个星（星标 = 直接算已总结，会联动进话题日志）';
    star.onclick = function (ev) {
      ev.stopPropagation();
      POST('/api/chat/star', { item: g.e, on: !g.e.starred }).then(function (r) {
        if (r.error) return toast(r.error);
        g.e.starred = !g.e.starred;
        star.textContent = g.e.starred ? '★' : '☆';
        star.classList.toggle('on', g.e.starred);
        if (CHAT.linked) { if (g.e.starred) CHAT.linked[g.e.key] = '1'; else delete CHAT.linked[g.e.key]; }
        if (chatF.star) paintChatList(box);
      });
    };
    head.appendChild(star);
    // 收进话题（主人 2026-10-22 v52 定：聊天记录可以直接选择变话题）
    var bTopic = el('button', 'cst', '→话题');
    bTopic.title = '把这条收进话题日志（长期记忆 → 话题日志，之后可让它总结）';
    bTopic.onclick = function (ev) {
      ev.stopPropagation();
      POST('/api/topic/add', { text: g.e.text, who: g.e.nick || '', nick: g.e.nick || '', scope: g.e.scope || '', type: 'quote', to: 'log' }).then(function (r) {
        if (r.error) return toast(r.error);
        toast('收进话题日志了（长期记忆 → 话题日志）');
      });
    };
    head.appendChild(bTopic);
    card.appendChild(head);

    var tx = el('div', 'chtx');
    hlNodes(g.e.text || '（空）', kw).forEach(function (n) { tx.appendChild(n); });
    card.appendChild(tx);

    if (g.reps.length) {
      var body = el('div', 'chrep');
      var open = !!g.autoOpen;
      body.style.display = open ? 'block' : 'none';
      g.reps.forEach(function (r) {
        var wrap = el('div', 'chrline');
        var mb = el('span', 'chrto', '回 → ' + (r.to || '…'));
        mb.title = '这条是回「' + (r.to || '没记下') + '」的（记录里写死的触发人，不按时间猜）';
        wrap.appendChild(mb);
        var line = el('div', 'chr');
        hlNodes(r.text || '（空）', kw).forEach(function (n) { line.appendChild(n); });
        wrap.appendChild(line);
        body.appendChild(wrap);
      });
      var btn = el('button', 'chb', open ? '收起' : ('看它怎么回的（' + g.reps.length + '）'));
      btn.onclick = function () {
        var on = body.style.display === 'none';
        body.style.display = on ? 'block' : 'none';
        btn.textContent = on ? '收起' : ('看它怎么回的（' + g.reps.length + '）');
      };
      card.appendChild(btn);
      card.appendChild(body);
    }
    box.appendChild(card);
  });
}

// 改某条聊天记录的情绪（主人 2026-11-07 定：聊天记录里能直接改情绪、能看应对）。
// 弹层里：① 当前「推理」（触发词→叶）② 该叶的「应对」（情绪书 replies）③ 搜叶改/加 ④ 清空。
// 改完回写 chat-emotion.json；之前是机器人判的、且改了叶 → 自动记成判错（联动表情包页徽标）。
function openEmoDialog(e) {
  if (!EMOBOOK) { loadEmobook().then(function () { openEmoDialog(e); }); return; }
  var d = document.getElementById('dlg');
  d.textContent = '';
  var cur = e.emo || null;
  d.appendChild(el('p', null, '这条的情绪')).style.fontWeight = '600';
  if (cur) {
    var info = el('div', 'emo-info');
    info.appendChild(el('b', null, cur.leaf));
    if (cur.word) info.appendChild(el('span', 'emo-w', '（命中「' + cur.word + '」）'));
    info.appendChild(el('span', 'emo-src', cur.source === 'review' ? '判错' : (cur.source === 'user' ? '手改' : '机器人判的')));
    d.appendChild(info);
  } else {
    d.appendChild(el('p', null, '还没判出情绪。下面选一个叶加上；或者先点「🔍 补漏判」自动扫。'));
  }
  // 应对（推理↔应对）：从情绪书取该叶的 replies
  var leafName = cur ? cur.leaf : '';
  var reps = leafReplies(leafName);
  if (reps.length) {
    var rbox = el('div', 'emo-rep');
    rbox.appendChild(el('div', 'emo-rep-h', '这一类（' + leafName + '）的应对：'));
    reps.forEach(function (t) { rbox.appendChild(el('div', 'emo-rep-i', '· ' + t)); });
    d.appendChild(rbox);
  } else if (leafName) {
    d.appendChild(el('div', 'emo-rep', '这一类在情绪书里还没写应对。'));
  }
  // 选新叶（搜索）
  d.appendChild(el('div', 'emo-sep', '改成 / 加一个叶：'));
  var inp = document.createElement('input');
  inp.className = 'ckw'; inp.placeholder = '搜叶名 / 分支…';
  d.appendChild(inp);
  var list = el('div', 'emo-pick');
  d.appendChild(list);
  function renderPick(q) {
    list.textContent = '';
    var ql = (q || '').trim().toLowerCase();
    var leaves = (EMOBOOK.leaves || []).filter(function (l) {
      if (!ql) return true;
      return (l.name + ' ' + (l.branchName || '') + ' ' + (l.core || '')).toLowerCase().indexOf(ql) >= 0;
    }).slice(0, 40);
    leaves.forEach(function (l) {
      var b = el('button', 'emo-opt' + (l.name === leafName ? ' on' : ''));
      b.appendChild(el('b', null, l.name));
      b.appendChild(el('span', 'emo-opt-b', (l.core || '') + '·' + (l.branchName || '')));
      b.onclick = function () { choose(l.name); };
      list.appendChild(b);
    });
    if (!leaves.length) list.appendChild(el('div', 'empty', '没有匹配的叶'));
  }
  inp.oninput = function () { renderPick(inp.value); };
  // 触发词：记录「为什么判成这叶」（推理）
  d.appendChild(el('div', 'emo-sep', '触发词（可空，记下为什么判成这叶）：'));
  var winp = document.createElement('input');
  winp.className = 'ckw'; winp.value = cur ? (cur.word || '') : '';
  winp.placeholder = '例：委屈 / 你怎么这样';
  d.appendChild(winp);
  renderPick('');

  function choose(name) {
    var word = (winp.value || '').trim() || (cur && cur.word) || '';
    POST('/api/chat/emotion', { key: e.key, nick: e.nick, text: e.text, leaf: name, word: word })
      .then(function (r) {
        if (r.error) return toast(r.error);
        e.emo = { leaf: name, word: word, source: r.source || 'user' };
        closeDlg();
        var lb = document.querySelector('.clist');
        if (lb) paintChatList(lb);
        toast('已改：' + name + (r.source === 'review' ? '（记成判错，表情包页会亮）' : ''));
      });
  }
  var acts = el('div', 'acts');
  var bClr = el('button', null, '清空情绪');
  bClr.onclick = function () {
    POST('/api/chat/emotion', { key: e.key, nick: e.nick, text: e.text, leaf: '' })
      .then(function (r) { if (r.error) return toast(r.error); e.emo = null; closeDlg(); var lb = document.querySelector('.clist'); if (lb) paintChatList(lb); toast('已清空这条的情绪'); });
  };
  var bNo = el('button', null, '关闭'); bNo.onclick = closeDlg;
  acts.appendChild(bClr); acts.appendChild(bNo);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}

/* 扫漏判（主人：「给所有漏判的加情绪」）。
 * preview=true：弹层预览扫出来的列表，确认后才 apply；否则只把 key 存进 window.__leakKeys 供「漏判」筛选。 */
function chatScanLeak(preview) {
  toast('扫描中…');
  POST('/api/chat/emotion/scan', { apply: false }).then(function (r) {
    if (r.error) return toast(r.error);
    var keys = {}; r.list.forEach(function (x) { keys[x.key] = 1; });
    window.__leakKeys = keys;
    if (!preview) { renderContent(); return; }
    if (!r.count) { toast('没扫到漏判（都判过了）'); return; }
    var d = document.getElementById('dlg');
    d.textContent = '';
    d.appendChild(el('p', null, '扫到 ' + r.count + ' 条漏判（能判出情绪但还没记）')).style.fontWeight = '600';
    var box = el('div', 'emo-leak');
    r.list.slice(0, 200).forEach(function (x) {
      var row = el('div', 'emo-leak-i');
      row.appendChild(el('b', null, x.leaf));
      row.appendChild(el('span', 'emo-w', '←' + x.word));
      row.appendChild(el('span', 'emo-leak-t', '「' + String(x.text || '').slice(0, 30) + '」'));
      box.appendChild(row);
    });
    if (r.list.length > 200) box.appendChild(el('div', 'empty', '…还有 ' + (r.list.length - 200) + ' 条'));
    d.appendChild(box);
    var acts = el('div', 'acts');
    var bYes = el('button', 'main', '应用 ' + r.count + ' 条');
    bYes.onclick = function () {
      POST('/api/chat/emotion/scan', { apply: true }).then(function (r2) {
        if (r2.error) return toast(r2.error);
        closeDlg(); window.__leakKeys = {}; loadChat().then(renderContent);
        toast('已加 ' + (r2.count || r.count) + ' 条情绪进去');
      });
    };
    var bNo = el('button', null, '先不'); bNo.onclick = closeDlg;
    acts.appendChild(bYes); acts.appendChild(bNo);
    d.appendChild(acts);
    document.getElementById('mask').classList.add('on');
  });
}

// 定位被回复的原消息（主人 2026-10-22：像 QQ 那样点一下引用跳原文）
function locateReplyChat(rp) {
  if (!rp || !CHAT || !CHAT.list) return;
  var hit = null;
  CHAT.list.forEach(function (e) {
    if (hit) return;
    [e].concat(e.pieces || []).forEach(function (c) {
      if (hit || c.bot) return;
      if (rp.nick && c.nick !== rp.nick) return;
      var tx = String(c.text || '').replace(/↩回复@.*?↩\s*/g, '').trim();
      var frag = String(rp.frag || '').trim();
      if (!frag) return;
      if (tx.indexOf(frag) >= 0 || (frag.indexOf(tx) >= 0 && tx.length > 4)) hit = c;
    });
  });
  if (!hit) { toast('没找到原消息（可能太旧被清掉了）'); return; }
  // hit 可能是合并条目里的某一片 → 找到它所属的整条
  var parent = CHAT.list.find(function (e) { return e === hit || (e.pieces || []).indexOf(hit) >= 0; }) || hit;
  // 清掉筛选再重画，不然目标可能正被滤掉看不见
  chatF.scope = ''; chatF.nick = ''; chatF.star = false; chatF.hideMe = false;
  chatF.onlyImg = false; chatF.onlyMerged = false; chatF.onlyReply = false; chatF.days = 0;
  var listBox = document.querySelector('.clist');
  if (!listBox) { toast('先打开聊天记录页再点定位'); return; }
  paintChatList(listBox);
  var key = parent.t + '|' + parent.nick;
  var card = null;
  listBox.querySelectorAll('.cht').forEach(function (c) { if (c._key === key) card = c; });
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('locate');
    setTimeout(function () { card.classList.remove('locate'); }, 2600);
  } else {
    toast('定位到时间点：' + String(parent.t).slice(0, 16).replace('T', ' '));
  }
}
// ===== 数据表（地区 / 称呼）：JSON 也在面板里改 =====
async function openTable(id) {
  var meta = TABLES_META.find(function (x) { return x.id === id; }) || { id: id, name: id };
  openPage('__table_' + id, function () {
    return { fileId: '__table_' + id, path: [], titles: [meta.name], title: meta.name, name: meta.name, table: id };
  }, loadTables);
}

// ===== 人物列表（主人 2026-10-23 定：喜好/称呼/好感度按人排在一起）=====
// 平时一行只显【名字、好感度、称呼】；点一下展开：id / 代称（最多5个，超了挤最老）/ 后缀 / 口味 / 记过的事实
var PEOPLE_OPEN = {};
function openPeople() {
  openPage('__people', function () {
    return { fileId: '__people', path: [], titles: ['人物列表'], title: '人物列表', name: '人物列表' };
  }, function () {});
}
/* 打开人物列表并展开某一个人（从约定的标签点过来）：按 pid 找行，展开、滚到眼前 */
var PEOPLE_FOCUS = '';
function openPeopleAt(pid) {
  PEOPLE_FOCUS = String(pid || '');
  openPeople();
}
function dispName(p) {
  return p.name || (String(p.alias || '').split(/[、｜|,，;；]/)[0] || '') || p.nick || ('QQ ' + p.qq);
}
function peopleRow(p, meta) {
  var card = el('div');
  card.style.cssText = 'border:1px solid var(--bd);border-radius:var(--r);margin:7px 0;overflow:hidden';
  var head = el('div');
  head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;flex-wrap:wrap';
  var nm = el('b', null, dispName(p));
  nm.style.cssText = 'min-width:110px';
  head.appendChild(nm);
  var favTag = el('span', null, '好感 ' + p.favor);
  favTag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:6px;' + (p.favor >= meta.fullAt ? 'background:#fde68a;color:#7c4a03' : p.favor >= meta.likeAt ? 'background:var(--ac);color:#fff' : 'background:var(--bg2);color:var(--tx2)');
  head.appendChild(favTag);
  var roleTag = el('span', null, '身份：' + (p.roleLabel || '—'));
  roleTag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:6px;background:var(--bg2);color:var(--tx2)';
  roleTag.title = '身份就是称呼：主人 / 欧尼酱 按号认；朋友 = 在朋友录里（好感 > 20）；认识的人 = 在人物册里；陌生人 = 第一次来的';
  head.appendChild(roleTag);
  var sexTag = el('span', null, '性别：' + (p.sexLabel || '—'));
  sexTag.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:6px;background:var(--bg2);color:var(--tx2)';
  sexTag.title = 'AI 全是女、主人是女，其他人默认男；对话里发现是女会改成女';
  head.appendChild(sexTag);
  head.appendChild(el('span', 'gy', (p.isMaster ? '【主人的号】' : '') + '资料卡：' + (p.nick || '（空着）')
    + ' · 群名片 ' + Object.keys(p.cards || {}).length + ' 张'
    + (p.suffix === 'baobao' ? ' · 宝宝' : p.suffix === 'jiang' ? ' · 酱' : '')));
  var arrow = el('span', 'gy', PEOPLE_OPEN[p.qq] ? '▾' : '▸');
  head.appendChild(arrow);
  card.appendChild(head);

  var detail = el('div');
  detail.style.cssText = 'display:none;border-top:1px solid var(--bd);padding:10px 12px;background:var(--bg2)';
  card.appendChild(detail);
  function paintDetail() {
    detail.textContent = '';
    // —— id ——
    var idRow = el('div');
    idRow.style.cssText = 'font-size:12px;color:var(--tx2);margin-bottom:6px';
    idRow.textContent = 'id：' + p.qq + '（id 永远对应这个人——有人爱改群名片也没关系，认人只认 id）';
    detail.appendChild(idRow);
    // —— 是不是主人的号（她有几个号、每个群的群名片都要认得出）——
    var isMain = String(p.qq) === String((meta.masterIds || [])[0] || '');
    var mrow = el('div');
    mrow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap';
    mrow.appendChild(el('span', 'gy', p.isMaster
      ? '这是主人的号：她在每个群的群名片都会记在下面，认出是同一个人'
      : '不是主人的号（只是个群友）'));
    var mbtn = el('button', null, p.isMaster ? (isMain ? '主号（不能取消）' : '取消主人号') : '标成主人的号');
    mbtn.title = isMain ? '主号写在 config 的 masterQQ，不能在这里取消' : '主人的号不止一个：她每个号都标上，她说话才不会被当成普通群友';
    mbtn.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--tx2);cursor:pointer';
    if (isMain) mbtn.disabled = true;
    mbtn.onclick = function () {
      POST('/api/people/set', { qq: p.qq, field: 'master', value: p.isMaster ? '0' : '1' }).then(function (rr) {
        if (rr.error) return toast(rr.error);
        p.isMaster = !!rr.isMaster;
        toast(p.isMaster ? '已经标成主人的号' : '取消了');
        paintDetail();
      });
    };
    mrow.appendChild(mbtn);
    detail.appendChild(mrow);
    // —— 名字 / 代称 / 后缀 / 好感 ——
    function fieldRow(label, tip, input) {
      var row = el('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:5px 0';
      var lb = el('span', null, label);
      lb.style.cssText = 'font-size:12px;color:var(--tx2);min-width:52px';
      lb.title = tip;
      row.appendChild(lb);
      row.appendChild(input);
      return row;
    }
    function save(field, value, done, gid) {
      var body = { qq: p.qq, field: field, value: value };
      if (gid) body.gid = gid;                    // 群名片要带上是哪个群
      POST('/api/people/set', body).then(function (rr) {
        if (rr.error) return toast(rr.error);
        toast('已保存'); if (done) done(rr);
      }).catch(function () { toast('保存失败'); });
    }
    var nmIn = document.createElement('input');
    nmIn.className = 'tv'; nmIn.value = p.name || '';
    nmIn.placeholder = '真名（本人承认的才算；空着就喊当前可见名）';
    nmIn.style.cssText = 'flex:1';
    nmIn.onchange = function () { save('name', nmIn.value, function () { p.name = nmIn.value.trim(); nm.textContent = dispName(p); }); };
    detail.appendChild(fieldRow('真名', '真名 = 本人承认的名字（AI 不准改），喊人优先用它。资料卡和群名片是 QQ 上的真实名字，下面单独列；其余名字自动算代称，只用来认人', nmIn));
    // —— 身份（2026-11-22 她令：身份就是称呼）——
    // 主人 / 欧尼酱 按号认，不给手改；朋友由朋友录（好感>20）决定，不在这里选。
    var roleOpts = [['known', '认识的人'], ['stranger', '陌生人']];
    var roleSel = document.createElement('select');
    roleSel.className = 'tsfx';
    if (p.role === 'master' || p.role === 'onii' || p.role === 'friend') {
      var ro = el('option', null, p.roleLabel || p.role); ro.value = p.role; roleSel.appendChild(ro);
      roleSel.disabled = true;
      roleSel.title = p.role === 'friend'
        ? '朋友由「朋友录」决定：好感 > 20 就在朋友录里。要移出朋友录就把好感调到 20 以下'
        : '主人 / 欧尼酱 是按号认出来的（配置里的 masterQQ / masters / oniiQQ）';
    } else {
      roleOpts.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; roleSel.appendChild(op); });
      roleSel.value = p.role || 'known';
      roleSel.onchange = function () {
        save('role', roleSel.value, function (rr) {
          p.role = rr.role; p.roleLabel = rr.roleLabel;
          roleTag.textContent = '身份：' + (rr.roleLabel || '—');
        });
      };
    }
    detail.appendChild(fieldRow('身份', '身份就是称呼。主人 / 欧尼酱 按号认；朋友 = 在朋友录里（好感 > 20，改好感即可）；认识的人 = 在人物册里；陌生人 = 第一次来的', roleSel));
    // —— 性别（2026-11-22 她令：AI 女、主人女、其他人默认男）——
    var sexSel = document.createElement('select');
    sexSel.className = 'tsfx';
    [['female', '女'], ['male', '男']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; sexSel.appendChild(op);
    });
    sexSel.value = p.sex || 'male';
    sexSel.onchange = function () {
      save('sex', sexSel.value, function (rr) {
        p.sex = rr.sex; p.sexLabel = rr.sexLabel || '';
        sexTag.textContent = '性别：' + (rr.sexLabel || '—');
      });
    };
    detail.appendChild(fieldRow('性别', 'AI 全是女、主人是女，其他人先默认男（猜的）；对话里发现是女就改成女，本人确认是男就标成已确认', sexSel));
    // —— 群名片（一个人每个群各一张，主人 2026-10-23 定）——
    var cTitle = el('div', null, '群名片（按群分开记，互不覆盖）');
    cTitle.style.cssText = 'font-size:12px;color:var(--tx2);margin:8px 0 4px';
    detail.appendChild(cTitle);
    var cards = p.cards || {};
    var gids = Object.keys(cards);
    if (!gids.length) {
      detail.appendChild(el('div', 'gy', '还没记到这个人在任何群的群名片——他在群里说话时会自动记下来'));
    }
    gids.forEach(function (gid) {
      var ci = document.createElement('input');
      ci.className = 'tv';
      ci.style.cssText = 'flex:1';
      ci.value = cards[gid];
      ci.onchange = function () {
        save('card', ci.value, function () {
          if (!ci.value.trim()) delete cards[gid];
        }, gid);
      };
      detail.appendChild(fieldRow('群' + gid, '他在这个群里的名字。改空 = 删掉这张（下次他说话会重新记）', ci));
    });
    var alIn = document.createElement('input');
    alIn.className = 'tv'; alIn.value = p.alias || '';
    alIn.placeholder = '别人喊他的名（顿号隔开）；群名片/资料卡/平台名/曾用名会自动当代称';
    alIn.style.cssText = 'flex:1';
    var alTip = el('div', 'gy', '');
    alTip.style.cssText = 'font-size:11px;margin:-2px 0 4px 60px';
    function paintAlTip() {
      var arr = String(alIn.value || '').split(/[、｜|,，;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
      alTip.textContent = (arr.length ? '别人喊过：' + arr.join('、') + '　' : '')
        + '代称只用来认人，不拿来喊；喊人用真名和当前可见名。曾用名会自动进代称（优先度最低）。';
    }
    paintAlTip();
    alIn.oninput = paintAlTip;
    alIn.onchange = function () { save('alias', alIn.value, function (rr) { alIn.value = (rr.rec && rr.rec.alias) || ''; paintAlTip(); }); };
    detail.appendChild(fieldRow('代称', '代称 = 当前可见名以外的一切名字：其他资料卡、其他群名片、平台名、别人喊的、曾用名。只用来认人，不拿来喊', alIn));
    detail.appendChild(alTip);
    var sfx = document.createElement('select');
    sfx.className = 'tsfx';
    [['', '无后缀'], ['baobao', '宝宝'], ['jiang', '酱']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; sfx.appendChild(op);
    });
    sfx.value = p.suffix || '';
    sfx.onchange = function () { save('suffix', sfx.value); };
    detail.appendChild(fieldRow('后缀', '头衔：宝宝要好感满 100；酱是情绪场合自动加（这里手动定也行）', sfx));
    var fvIn = document.createElement('input');
    fvIn.className = 'favorinp'; fvIn.type = 'number'; fvIn.min = '0'; fvIn.max = '100'; fvIn.value = p.favor;
    fvIn.onchange = function () {
      var v = Math.max(0, Math.min(100, Math.round(Number(fvIn.value) || 0)));
      POST('/api/people/set', { qq: p.qq, field: 'favor', value: v }).then(function (rr) {
        if (rr.error) return toast(rr.error);
        p.favor = rr.v; fvIn.value = rr.v; favTag.textContent = '好感 ' + rr.v; toast('好感改成 ' + rr.v);
      });
    };
    detail.appendChild(fieldRow('好感度', '夸一次 +1；过 60 算喜欢（自动进口味表）；满 100 日常叫宝宝', fvIn));
    // —— 口味 ——
    if (p.taste && p.taste.length) {
      var tTitle = el('div', null, '口味（她记下的这个人的喜恶）');
      tTitle.style.cssText = 'font-size:12px;color:var(--tx2);margin:8px 0 4px';
      detail.appendChild(tTitle);
      p.taste.forEach(function (sec) {
        var row = el('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;margin:3px 0;flex-wrap:wrap';
        var tag = el('span', null, sec.label);
        tag.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:6px;background:var(--bg);color:var(--tx2);flex-shrink:0';
        row.appendChild(tag);
        sec.items.forEach(function (it, i2) {
          var chip = el('span', null, it.t + (it.from ? '　' : ''));
          chip.style.cssText = 'font-size:12px;padding:1px 4px';
          if (it.from) { var f = el('i', 'gy', '(' + it.from + ')'); chip.appendChild(f); }
          var x = el('button', null, '✕');
          x.title = '删掉这条口味';
          x.style.cssText = 'border:none;background:none;color:var(--tx2);cursor:pointer;font-size:11px;padding:0 2px';
          x.onclick = function () {
            POST('/api/taste/del', { qq: p.qq, sec: sec.sec, t: it.t }).then(function (rr) {
              if (rr.error) return toast(rr.error);
              sec.items.splice(i2, 1); row.removeChild(chip); row.removeChild(x); toast('删了');
            });
          };
          row.appendChild(chip); row.appendChild(x);
        });
        detail.appendChild(row);
      });
    } else {
      detail.appendChild(el('div', 'gy', '口味：还没记过这个人喜欢/讨厌什么'));
    }
    // —— 人物事实 ——
    if (p.facts && p.facts.length) {
      var fTitle = el('div', null, '记过的事实（长期记忆 · 人物事实，只读）');
      fTitle.style.cssText = 'font-size:12px;color:var(--tx2);margin:8px 0 4px';
      detail.appendChild(fTitle);
      p.facts.forEach(function (ft) {
        var fr = el('div', 'gy', '· ' + ft);
        fr.style.cssText = 'font-size:12px;line-height:1.5';
        detail.appendChild(fr);
      });
      var goF = el('button', null, '去改事实 →');
      goF.style.cssText = 'font-size:11px;padding:2px 8px;margin-top:4px;border-radius:8px;background:var(--bg);color:var(--tx2);border:1px solid var(--bd);cursor:pointer';
      goF.onclick = function () { openRoot('data/人物列表.md'); };
      detail.appendChild(goF);
    }
  }
  head.onclick = function () {
    PEOPLE_OPEN[p.qq] = !PEOPLE_OPEN[p.qq];
    if (PEOPLE_OPEN[p.qq]) { paintDetail(); detail.style.display = ''; }
    else detail.style.display = 'none';
    arrow.textContent = PEOPLE_OPEN[p.qq] ? '▾' : '▸';
  };
  if (PEOPLE_OPEN[p.qq]) { paintDetail(); detail.style.display = ''; arrow.textContent = '▾'; }
  return card;
}
function renderPeople(t, box) {
  box.appendChild(el('div', 'crumb'));
  box.appendChild(el('h1', 'pg', '人物列表'));
  box.appendChild(el('p', 'pgsub', '每个人一行：资料卡名（1 张，可以空着）/ 好感度 / 群名片张数。点一下展开代称、id、后缀、口味、记过的事实。群名片按群各记一张、互不覆盖——他换个群换个名字，她按 QQ 号认得出是同一个人。主人和虚幻自己不在这里（口味在口味那一节）。'));
  var loading = el('div', 'empty', '正在读取…');
  box.appendChild(loading);
  api('/api/people').then(function (r) {
    loading.parentNode && loading.parentNode.removeChild(loading);
    var list = (r && r.list) || [];
    if (!list.length) { box.appendChild(el('div', 'empty', '还没有人——群友说过话会自动记进来')); return; }
    var focus = PEOPLE_FOCUS; PEOPLE_FOCUS = '';
    var target = null;
    list.forEach(function (p) {
      // 从约定的标签点过来：先把它标成展开，建卡时就带着详情（不是建完再点一下）
      if (focus && String(p.pid) === String(focus)) PEOPLE_OPEN[p.qq] = true;
      var card = peopleRow(p, r);
      try { card.setAttribute('data-pid', p.pid || ''); } catch (e) {}
      box.appendChild(card);
      if (focus && String(p.pid) === String(focus)) target = card;
    });
    if (target) {
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { target.scrollIntoView(); } catch (e2) {} }
    }
  }).catch(function () { loading.textContent = '读取失败'; });
}

async function loadTables() {
  var r = await api('/api/data');
  if (r && r.tables) r.tables.forEach(function (t) {
    TABLE_DATA[t.id] = { meta: t, rows: t.rows.slice(), snap: JSON.stringify(t.rows) };
  });
}

function tableDirty(id) {
  var d = TABLE_DATA[id];
  return !!(d && JSON.stringify(d.rows) !== d.snap);
}

function markTableDirty(id) {
  var sv = document.querySelector('.tsave');
  if (!sv) return;
  var dirty = tableDirty(id);
  sv.textContent = dirty ? '保存' : '已存';
  sv.classList.toggle('off', !dirty);
}

function renderTable(t, box) {
  var d = TABLE_DATA[t.table];
  if (!d) {
    box.appendChild(el('div', 'empty', '正在读取…'));
    if (!window.__loadingTables) {
      window.__loadingTables = 1;
      loadTables().then(function () { window.__loadingTables = 0; renderContent(); });
    }
    return;
  }
  var meta = d.meta;
  var crumb = el('div', 'crumb');
  crumb.appendChild(el('b', null, meta.name));
  box.appendChild(crumb);
  box.appendChild(el('h1', 'pg', meta.name));
  box.appendChild(el('p', 'pgsub', (meta.hint || '') + ' · 共 ' + d.rows.length + ' 条'));

  var bar = el('div', 'tbar');
  var dirty = tableDirty(t.table);
  var sv = el('button', 'tsave' + (dirty ? '' : ' off'), dirty ? '保存' : '已存');
  sv.onclick = function () {
    if (!tableDirty(t.table)) return;
    POST('/api/data', { id: t.table, rows: d.rows }).then(function (r) {
      if (r.error) return toast(r.error);
      d.rows = r.rows; d.snap = JSON.stringify(r.rows);
      renderContent(); toast('已保存');
    });
  };
  bar.appendChild(sv);

  var add = el('button', 'tadd', '＋ 加一行');
  add.onclick = function () {
    d.rows.push(meta.kind === 'kv' ? { k: '', v: '' } : { k: '', name: '', alias: '', nick: '', suffix: '' });
    renderContent();
  };
  bar.appendChild(add);
  box.appendChild(bar);

  var isRegion = t.table === 'region';   // 2026-11-19：地区表按人物存，键是 p_xxx，不是纯数字
  var head = el('div', 'trow thead');
  head.appendChild(el('div', 'th', isRegion ? '人物 ID（p_xxx）' : 'QQ 号'));
  head.appendChild(el('div', 'th', '所在地'));
  head.appendChild(el('div', 'th', ''));
  box.appendChild(head);

  d.rows.forEach(function (r, idx) {
    var tr = el('div', 'trow');
    var k = document.createElement('input');
    k.className = 'tk'; k.value = r.k || ''; k.placeholder = isRegion ? '人物 ID' : 'QQ 号';
    if (!isRegion) k.inputMode = 'numeric';
    k.oninput = function () { r.k = isRegion ? k.value.trim() : k.value.replace(/\D/g, ''); markTableDirty(t.table); };
    tr.appendChild(k);

    {
      var v = document.createElement('input');
      v.className = 'tv'; v.value = r.v || ''; v.placeholder = '城市，例如 成都';
      v.oninput = function () { r.v = v.value; markTableDirty(t.table); };
      tr.appendChild(v);
    }

    var del = el('button', 'tdel', '✕');
    del.title = '删掉这一行';
    del.onclick = function () { d.rows.splice(idx, 1); renderContent(); };
    tr.appendChild(del);
    box.appendChild(tr);
  });
}

// 恢复某一行关掉的页面：first=前3（最早关的）、last=后3（最右/最近关的）、all=全部
function restoreClosed(key, kind) {
  var arr = CLOSED[key] || [];
  if (!arr.length) return;
  var fid = key.split('#')[0];
  var pick;
  if (kind === 'all') pick = arr.slice();
  else if (kind === 'first') pick = arr.slice(0, 3);
  else pick = arr.slice(-3);
  CLOSED[key] = arr.filter(function (c) { return pick.indexOf(c) < 0; });
  if (!CLOSED[key].length) delete CLOSED[key];
  pick.sort(function (a, b) { return a.pos - b.pos; }).forEach(function (c) {
    var p = resolveTitles(fid, c.titles.slice());
    if (p) openTab(fid, p);
  });
  renderTabs(); renderContent(); renderFiles();
}

// 整行关闭：关这一层，连带它下面的子孙页一起关（不然子页会悬空在没父级的地方）
function closeRow(fid, lv) {
  var act = TABS[ACTIVE] || null;
  var parents = TABS.filter(function (t) { return t.fileId === fid && t.path.length === lv; }).map(function (t) { return t.path; });
  if (!parents.length) return;
  var keep = [], n = 0;
  TABS.forEach(function (t) {
    if (t.fileId !== fid) { keep.push(t); return; }
    var hit = t.path.length === lv;
    if (!hit && t.path.length > lv) {
      hit = parents.some(function (p) { return p.every(function (v, i) { return t.path[i] === v; }); });
    }
    if (hit) { pushClosed(fid, t, t.path[t.path.length - 1] || 0); n++; }
    else keep.push(t);
  });
  if (!n) return;
  TABS = keep;
  var at = act ? TABS.indexOf(act) : -1;
  ACTIVE = at >= 0 ? at : (TABS.length ? TABS.length - 1 : -1);
  renderTabs(); renderContent(); renderFiles();
  toast('关掉了 ' + n + ' 个页面');
}

function hasNewsForTab(t) {
  var list = NEWS[t.fileId];
  if (!list || !list.length) return false;
  var n = nodeAt(t.fileId, t.path);
  if (!n) return false;
  return (n.items || []).some(function (it) { return list.indexOf(hash(it.text)) >= 0; });
}

/* ---------- 内容区 ---------- */
function activeTab() { return PAGE || TABS[ACTIVE] || null; }
// 打开一个不走标签的页面（功能页 / 原文页）：PAGE 指向它，状态缓存着（筛选项、选中的人不丢）
async function openPage(fid, make, load) {
  if (load) { try { await load(); } catch (e) { toast(e.message || '读不了'); } }
  PAGE = PAGE_CACHE[fid] || (PAGE_CACHE[fid] = make());
  renderTabs(); renderContent(); renderFiles();
}

// 每个页面记住自己的滚动位置，切来切去不回到顶部
var scrollMemo = {}, lastKey = null;
function tabKey(t) { return t ? (t.fileId + '|' + (t.path || []).join('.') + '|' + (t.table || '')) : ''; }

function renderContent() {
  hideRtip();                 // 换页时收起规矩浮层，别悬在半空
  var box = document.getElementById('content');
  if (lastKey) scrollMemo[lastKey] = box.scrollTop;
  renderContentBody(box);
  var k = tabKey(activeTab());
  box.scrollTop = scrollMemo[k] || 0;
  lastKey = k;
  var t = activeTab();
  if (t) t.seen = Date.now();
}

/* ---------- 每个文件自己的「代码原文入口」（主人 2026-10-22 22:37 铁律） ----------
 * 原话：「每个对应的文件和代码，直接显示在对应面板内。如，面板中的内容【B站机器人-小白攻略】里，
 * 直接显示 B站机器人-小白攻略.html 的入口，可在此直接查代码原文。不会多出一个入口。」
 * 所以入口就在这个文件自己的页面顶上，不再为「看代码」多开一条左列。
 * html 文件：给「看代码原文」+「在浏览器里打开」，并且不再拿 md 解析器去啃它（那是乱码之源）。
 */
function fileSourceEntry(t, box) {
  var m = FILEMETA[t.fileId] || {};
  var kind = m.kind || '';
  var isHtml = kind === 'html';
  var isCodey = isHtml || kind === 'code' || kind === 'json' || kind === 'log';
  if (!isCodey) return false;                       // md 文件本身就是在看原文，不用按钮
  if (isHtml) {
    var nm = (FILES.find(function (f) { return f.id === t.fileId; }) || {}).name || t.fileId;
    box.appendChild(el('h1', 'pg', nm));
  }
  var bar = el('div', 'cbar');
  bar.style.margin = '2px 0 8px';
  var b1 = el('button', 'cdel', isHtml ? '看这个文件的代码原文' : '看代码原文');
  b1.title = '就在面板里读这个文件；代码会按段切开，鼠标放上去看这一段是干嘛的';
  b1.onclick = function () { openRaw(t.fileId); };
  bar.appendChild(b1);
  if (isHtml) {
    var b2 = el('button', 'cdel', '在浏览器里打开');
    b2.title = '用浏览器新标签页打开这个 html（原样的成品，不是源码）';
    b2.onclick = function () { window.open('/view/' + encodeURIComponent(t.fileId), '_blank'); };
    bar.appendChild(b2);
  }
  box.appendChild(bar);
  if (m.use) box.appendChild(el('p', 'pgsub', m.use));
  return isHtml;                                    // html：页面到此为止，别再用 md 解析器啃它
}

function renderContentBody(box) {
  box.textContent = '';
  var t = activeTab();
  if (!t) {
    box.appendChild(el('div', 'empty', '左边选一个文件或功能'));
    TARGET = null;
    return;
  }
  var composer = document.querySelector('.composer');
  if (t.fileId === '__chat') {
    if (composer) composer.style.display = 'none';
    renderChat(t, box); return;
  }
  if (t.fileId === '__map') {
    if (composer) composer.style.display = 'none';
    renderMap(t, box); return;
  }
  if (t.fileId === '__log') {
    if (composer) composer.style.display = 'none';
    renderLog(t, box); return;
  }
  if (t.fileId === '__topic' || t.fileId === '__topics' || t.fileId === '__promise') {
    if (composer) composer.style.display = 'none';
    renderTopic(t, box); return;
  }
  if (t.fileId === '__memes') {
    if (composer) composer.style.display = 'none';
    renderMemes(t, box); return;
  }
  if (t.fileId === '__memedict') {
    if (composer) composer.style.display = 'none';
    renderMemeDict(t, box); return;
  }
  if (t.fileId === '__triggers') {
    if (composer) composer.style.display = 'none';
    renderTriggers(t, box); return;
  }
  if (t.fileId === '__features') {
    if (composer) composer.style.display = 'none';
    renderFeatures(t, box); return;
  }
  if (t.fileId === '__thinking') {
    if (composer) composer.style.display = 'none';
    renderThinking(t, box); return;
  }
  if (t.fileId === '__multitruth') {
    if (composer) composer.style.display = 'none';
    renderMultiTruth(t, box); return;
  }
  if (t.fileId === '__updates') {
    if (composer) composer.style.display = 'none';
    renderUpdates(t, box); return;
  }
  if (t.fileId === '__reqs') {
    if (composer) composer.style.display = 'none';
    renderReqs(t, box); return;
  }
  if (t.fileId === '__cost') {
    if (composer) composer.style.display = 'none';
    renderCost(t, box); return;
  }
  if (t.fileId === '__feedback') {
    if (composer) composer.style.display = 'none';
    renderFeedback(t, box); return;
  }
  if (t.fileId === '__who') {
    if (composer) composer.style.display = 'none';
    renderWho(t, box); return;
  }
  if (t.fileId.indexOf('__html_') === 0) {
    if (composer) composer.style.display = 'none';
    renderHtmlFile(t, box); return;
  }
  if (t.fileId.indexOf('__raw_') === 0) {
    if (composer) composer.style.display = 'none';
    renderRaw(t, box); return;
  }
  if (t.fileId.indexOf('__table_') === 0) {
    if (composer) composer.style.display = 'none';
    renderTable(t, box); return;
  }
  if (t.fileId === '__people') {
    if (composer) composer.style.display = 'none';
    renderPeople(t, box); return;
  }
  if (composer) composer.style.display = '';
  if (t.dead) { box.appendChild(el('div', 'empty', '这一页对应的标题已经被删掉了')); return; }
  // 根页（还没进任何小标题）先摆上这个文件自己的「代码原文」入口；html 文件到此为止
  if (t.path.length === 1 && fileSourceEntry(t, box)) return;
  var n = nodeAt(t.fileId, t.path);
  if (!n) { box.appendChild(el('div', 'empty', '找不到这一页了')); return; }
  t.titles = titlesOf(t.fileId, t.path);
  t.title = n.title;
  TARGET = { fileId: t.fileId, path: t.path.slice() };

  // 面包屑
  var crumb = el('div', 'crumb');
  var fname = (FILES.find(function (f) { return f.id === t.fileId; }) || {}).name || '';
  var c0 = el('span', 'lnk', fname);
  c0.onclick = function () { var i = TABS.findIndex(function (x) { return x.fileId === t.fileId && x.path.length === 1; }); if (i >= 0) { ACTIVE = i; renderTabs(); renderContent(); } };
  crumb.appendChild(c0);
  t.titles.forEach(function (tt, i) {
    crumb.appendChild(el('span', 'sep', '›'));
    if (i === t.titles.length - 1) { crumb.appendChild(el('b', null, tt)); return; }
    var lk = el('span', 'lnk', tt);
    lk.onclick = function () {
      var p = t.path.slice(0, i + 1);
      var idx = TABS.findIndex(function (x) { return x.fileId === t.fileId && x.path.join('.') === p.join('.'); });
      if (idx >= 0) { ACTIVE = idx; renderTabs(); renderContent(); }
      else { openTab(t.fileId, p); }
    };
    crumb.appendChild(lk);
  });
  box.appendChild(crumb);

  // 页面标题（可双击改）
  var h = el('h1', 'pg');
  var htxt = el('span', null, n.title || '未命名');
  htxt.title = '双击改名';
  h.appendChild(htxt);
  htxt.ondblclick = function () { editInline(htxt, n.title, function (v) { n.title = v; onTextChanged(t.fileId); }); };
  box.appendChild(h);

  var sub = el('p', 'pgsub');
  var nItems = (n.items || []).length, nChild = (n.children || []).length;
  sub.textContent = nChild ? nChild + ' 个小标题 · ' + nItems + ' 条内容' : nItems + ' 条内容';
  box.appendChild(sub);

  // 子标题卡片（最后一格永远是「＋ 新小标题」）
  var grid = el('div', 'grid');
  (n.children || []).forEach(function (c, ci) {
    grid.appendChild(tile(t, c, ci));
  });
  grid.appendChild(addTile(t));
  // 拖到卡片之间的空隙、或者「＋ 新小标题」那一格：以前没有任何人接这个 drop，
  // 松手什么也不发生（还会顺手触发「新建小标题」）。现在统一按「放到这一层最后」处理。
  grid.ondragover = function (e) {
    if (DRAG && DRAG.type === 'node') { e.preventDefault(); grid.classList.add('over'); }
  };
  grid.ondragleave = function (e) { if (e.target === grid) grid.classList.remove('over'); };
  grid.ondrop = function (e) {
    e.preventDefault();
    grid.classList.remove('over');
    if (DRAG && DRAG.type === 'node') dropOnEnd(t);
  };
  box.appendChild(grid);

  // 条目
  if (nItems) {
    var list = el('div', 'items');
    (n.items || []).forEach(function (it, ii) { list.appendChild(itemRow(t, n, it, ii)); });
    box.appendChild(list);
  }
}


// 新建一层小标题：建完直接把名字选中让你改
function addTile(t) {
  var d = el('div', 'tile add');
  d.appendChild(el('div', 'tt', '＋ 新小标题'));
  d.appendChild(el('div', 'meta', '点一下，在这一层里再开一层'));
  d.onclick = function () {
    var pn = nodeAt(t.fileId, t.path);
    if (!pn) return;
    pn.children = pn.children || [];
    pn.children.push({ level: (pn.level || 1) + 1, title: '新小标题', items: [], children: [] });
    onTextChanged(t.fileId);
    setTimeout(function () {
      var tiles = document.querySelectorAll('.tile:not(.add)');
      var last = tiles[tiles.length - 1];
      var tt = last && last.querySelector('.tt > span');
      if (tt) tt.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }, 80);
  };
  return d;
}

function tile(t, c, ci) {
  var d = el('div', 'tile');
  d.draggable = true;
  var grip = el('div', 'grip', '⠿');
  d.appendChild(grip);

  var tt = el('div', 'tt');
  var txt = el('span', null, c.title || '未命名');
  txt.style.minWidth = '0';
  txt.style.overflow = 'hidden';
  txt.style.textOverflow = 'ellipsis';
  tt.appendChild(txt);
  if (nodeHasNews(t.fileId, c)) {
    var dot = el('span', 'reddot');
    dot.title = '机器人新写的';
    tt.appendChild(dot);
    d.onmouseenter = function () { clearNews(t.fileId, c); };
  }
  d.appendChild(tt);

  var meta = el('div', 'meta', (c.items || []).length + ' 条' + ((c.children || []).length ? ' · ' + (c.children || []).length + ' 层' : ''));
  d.appendChild(meta);

  var kill = el('button', 'kill', '✕');
  kill.title = '删掉这个小标题和里面所有内容';
  kill.onclick = function (e) {
    e.stopPropagation();
    confirmBox('删掉「' + c.title + '」和它下面的全部内容？', function () {
      var pn = nodeAt(t.fileId, t.path);
      pn.children.splice(ci, 1);
      // 关掉指向被删节点（及其子孙）的标签
      TABS = TABS.filter(function (x) {
        if (x.fileId !== t.fileId) return true;
        if (x.path.length <= t.path.length) return true;
        for (var k = 0; k < t.path.length; k++) if (x.path[k] !== t.path[k]) return true;
        return x.path[t.path.length] !== ci;
      });
      if (ACTIVE >= TABS.length) ACTIVE = TABS.length - 1;
      if (ACTIVE < 0) ACTIVE = 0;
      onTextChanged(t.fileId, true);   // 删小标题是结构变更，立刻落盘
    });
  };
  d.appendChild(kill);

  // 单击开页要延迟一下：不然双击改名时第一次点击就把页面打开了，改名框来不及出现
  var clkTimer = null;
  d.onmousedown = function (e) { MOUSE0 = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  d.ondblclick = function (e) {
    e.stopPropagation();
    if (clkTimer) { clearTimeout(clkTimer); clkTimer = null; }
    editInline(txt, c.title, function (v) { c.title = v; onTextChanged(t.fileId); });
  };
  d.onclick = function (e) {
    if (e.target === kill || e.target === grip) return;
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    // 刚拖完不算点击：不然拖着拖着松手，页面就被打开了，看着像「拖动没生效」
    if (Date.now() - DRAG_T0 < 700) return;
    // 手抖：按下和松开隔了 8 像素以上，那是在拖、不是在点
    if (MOUSE0 && (Math.abs(e.clientX - MOUSE0.x) > 8 || Math.abs(e.clientY - MOUSE0.y) > 8)) return;
    if (clkTimer) clearTimeout(clkTimer);
    clkTimer = setTimeout(function () {
      clkTimer = null;
      openTab(t.fileId, t.path.concat([ci]));
    }, 210);
  };

  // 拖动整个小标题
  d.ondragstart = function (e) {
    if (e.target === kill) { e.preventDefault(); return; }
    DRAG = { type: 'node', fileId: t.fileId, path: t.path.concat([ci]) };
    DRAG_T0 = Date.now();
    d.classList.add('drag');
    document.body.classList.add('dragmode');
    try { e.dataTransfer.setData('text/plain', 'node'); } catch (x) {}
  };
  d.ondragend = function () { d.classList.remove('drag'); document.body.classList.remove('dragmode'); DRAG = null; };
  d.ondragover = function (e) {
    if (DRAG && (DRAG.type === 'node' || DRAG.type === 'item' || DRAG.type === 'draft')) { e.preventDefault(); d.classList.add('over'); }
  };
  d.ondragleave = function () { d.classList.remove('over'); };
  d.ondrop = function (e) {
    e.preventDefault(); e.stopPropagation();
    d.classList.remove('over');
    document.body.classList.remove('dragmode');
    var r = d.getBoundingClientRect();
    // 卡片是横向多列（grid 自动换行）。判断「插到前面还是后面」必须看主轴：
    // 鼠标还落在这一行的上下范围内 → 按左右（X）判；跨到别的行了 → 按上下（Y）判。
    // 以前一律用 clientY：横向拖动时 Y 几乎没动、永远算「插到后面」，
    // 于是把第 2 个拖到第 1 个头上，结果是「放到第 1 个后面」＝原位不动，看着就是拖不动。
    var sameRow = (e.clientY >= r.top && e.clientY <= r.bottom);
    var after = sameRow ? (e.clientX > r.left + r.width / 2) : (e.clientY > r.top + r.height / 2);
    dropOnTile(t, ci, after);
    DRAG_T0 = Date.now();
  };
  return d;
}

function itemRow(t, n, it, ii) {
  var row = el('div', 'it');
  row.draggable = true;
  var idx = el('div', 'n', String(ii + 1));
  idx.title = '按住这里拖动这一条；按住文字可以选中';
  row.appendChild(idx);

  var isQ = /^>\s?/.test(it.text);
  var raw = it.text.replace(/^>\s?/, '');
  var parts = isQ ? { rule: raw, ex: '' } : splitEx(raw);
  var shown = parts.rule, exNow = parts.ex;
  var col = el('div', 'col');
  row.appendChild(col);

  var tx = el('div', 'tx' + (isQ ? ' quote' : ''), shown);
  tx.title = '双击改「规则」本身；例子在下面那一行';
  tx.ondblclick = function () {
    editInline(tx, shown, function (v) {
      it.text = (isQ ? '> ' : '') + (isQ ? v : joinEx(v, exNow));
      onTextChanged(t.fileId);
    });
  };
  col.appendChild(tx);

  if (exNow) {
    var exrow = el('div', 'ex');
    exrow.appendChild(el('span', 'tag', '例'));
    var v = el('div', 'v', exNow);
    // 例子分两种：纯台词（自动加引号、一行一个）和带引号的说明句（原样编辑，别破坏结构）
    var hasQuote = /[「」]/.test(exNow);
    v.title = hasQuote
      ? '双击改这段说明（原样保留，不会动你的引号）'
      : '双击改台词。好几个就换行写，引号我替你加';
    v.ondblclick = function () {
      var plain = hasQuote ? exNow : exNow.split('、').join('\n');
      editInline(v, plain, function (nv) {
        it.text = (isQ ? '> ' : '') + joinEx(shown, hasQuote ? String(nv).trim() : tidyEx(nv));
        onTextChanged(t.fileId);
      }, { multiline: true });
    };
    exrow.appendChild(v);
    var kex = el('button', 'k', '✕');
    kex.title = '去掉这条的举例（只留规则）';
    kex.onclick = function (e) {
      e.stopPropagation();
      it.text = (isQ ? '> ' : '') + shown;
      onTextChanged(t.fileId);
    };
    exrow.appendChild(kex);
    col.appendChild(exrow);
  } else if (!isQ) {
    var add = el('div', 'addex', '＋举例');
    add.title = '只写规则，它会变成客服；配一个例子，它才会用你的口气说';
    add.onclick = function (e) {
      e.stopPropagation();
      inlineEx(it, t, shown, col, add);
    };
    col.appendChild(add);
  }

  var dt = el('span', 'dt' + (it.d ? '' : ' add'), it.d || '＋时间');
  dt.title = it.d ? '点一下改时间' : '给这条加个时间';
  dt.onclick = function (e) { e.stopPropagation(); dateBox(it, t.fileId); };
  row.appendChild(dt);

  var up = el('button', 'x', '↳');
  up.title = '把这条变成一个独立的小标题（这行字当标题，可以点进去）';
  up.onclick = function (e) {
    e.stopPropagation();
    // 变标题只取「规则」那一句，别把「举例：…」也拖上去
    var txt = splitEx(it.text.replace(/^>\s?/, '')).rule;
    if (!txt) return;
    n.items.splice(ii, 1);
    n.children = n.children || [];
    n.children.push({ level: (n.level || 1) + 1, title: txt, items: [], children: [] });
    onTextChanged(t.fileId);
    toast('变成小标题了，点它可以进去');
  };
  row.appendChild(up);

  var x = el('button', 'x', '✕');
  x.onclick = function (e) {
    e.stopPropagation();
    n.items.splice(ii, 1);
    onTextChanged(t.fileId);
  };
  row.appendChild(x);

  row.ondragstart = function (e) {
    DRAG = { type: 'item', fileId: t.fileId, path: t.path.slice(), idx: ii };
    row.classList.add('drag');
    try { e.dataTransfer.setData('text/plain', 'item'); } catch (x2) {}
  };
  row.ondragend = function () { row.classList.remove('drag'); DRAG = null; };
  row.ondragover = function (e) {
    if (DRAG && (DRAG.type === 'item' || DRAG.type === 'draft')) { e.preventDefault(); row.classList.add('over'); }
  };
  row.ondragleave = function () { row.classList.remove('over'); };
  row.ondrop = function (e) {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('over');
    var r = row.getBoundingClientRect();
    var after = (e.clientY - r.top) > r.height / 2;
    var dst = nodeAt(t.fileId, t.path);
    if (!dst) return;
    if (DRAG.type === 'draft') {
      dst.items.splice(ii + (after ? 1 : 0), 0, { t: 'li', text: DRAG.text, d: DRAG.d || '', ind: 0 });
      DRAFTS.splice(DRAG.di, 1);
      renderDrafts(); onTextChanged(t.fileId); return;
    }
    if (DRAG.type !== 'item') return;
    var srcParent = nodeAt(DRAG.fileId, DRAG.path);
    if (!srcParent) return;
    var moving = srcParent.items.splice(DRAG.idx, 1)[0];
    if (!moving) return;
    var to = ii + (after ? 1 : 0);
    if (DRAG.fileId === t.fileId && DRAG.path.join('.') === t.path.join('.') && DRAG.idx < to) to--;
    dst.items.splice(to, 0, moving);
    onTextChanged(t.fileId);
  };

  // 红点
  var news = NEWS[t.fileId] || [];
  if (news.indexOf(hash(it.text)) >= 0) {
    var dot = el('span', 'reddot');
    dot.title = '机器人刚写的';
    row.insertBefore(dot, idx);
    row.onmouseenter = function () { clearNews(t.fileId, null, it); };
  }
  return row;
}

// 在条目里原地开一个「例子」输入框（不用弹窗，不打任何符号）
function inlineEx(it, t, rule, col, addBtn) {
  var exrow = el('div', 'ex');
  exrow.appendChild(el('span', 'tag', '例'));
  var ta = el('textarea', 'inline-ex');
  ta.rows = 1;
  ta.placeholder = '写一句它该说的话。好几个就换行。回车确认，Esc 取消';
  exrow.appendChild(ta);
  if (addBtn && addBtn.parentNode) addBtn.parentNode.replaceChild(exrow, addBtn);
  else col.appendChild(exrow);
  ta.focus();
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var v = tidyEx(ta.value);
    if (v) it.text = joinEx(rule, v);
    onTextChanged(t.fileId);
    renderContent();
  }
  ta.onblur = commit;
  ta.onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { done = true; renderContent(); }
  };
  ta.oninput = function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  };
}

// 一键净化当前文件的排版：去掉对模型没用的符号
// v52：在话题/梗库这类卡片页点上 = 全局净化（人设、说话风格、梗库、话题全部覆盖，真落盘）
function tidyCurrent() {
  var t = activeTab();
  if (!t) return toast('先左边选个文件');
  if (isSynthetic(t.fileId)) {
    POST('/api/tidy-all', {}).then(function (r) {
      if (r.error) return toast(r.error);
      toast(r.total ? ('全局净化：清了 ' + r.total + ' 处（人设/说话风格/梗库/话题）') : '都挺干净的，没找到多余的符号');
    });
    return;
  }
  var root = TREES[t.fileId];
  if (!root) return;
  var n = 0;
  function walk(node) {
    if (node.title) {
      var nt = tidyText(node.title);
      if (nt !== node.title) { node.title = nt; n++; }
    }
    (node.items || []).forEach(function (it) {
      var v = tidyText(it.text);
      if (v !== it.text) { it.text = v; n++; }
    });
    (node.children || []).forEach(walk);
  }
  (root.children || []).forEach(walk);
  if (!n) return toast('已经挺干净了，没找到多余的符号');
  onTextChanged(t.fileId);
  toast('清掉了 ' + n + ' 处（记得 Ctrl+S 存盘）');
}

// ===== 体检：找出前后矛盾、以及「写了但代码会判错」的句子 =====
// 2026-10-22：主人说「现在有很多都是冲突的」。人手查会漏，做成按钮。
// 两类问题分开报：
//   ① 自相矛盾 —— 同一段里既有「不许 X」又有「可以 X」的地方（按话题词归并，列出来让人看）
//   ② 写了也白写 —— 举例里出现代码硬校验要拦的句式，说了也会被重写掉
var CONFLICT_TOPICS = [
  { k: '我是文盲', w: /文盲/ },
  { k: '说「这是XX的梗」', w: /这是.{0,14}梗|这就是所谓|这是一种/ },
  { k: '「嘿嘿」', w: /嘿嘿/ },
  { k: '省略号', w: /省略号|\.\.\.|…/ },
  { k: '句号收尾', w: /句号/ },
];
var CODE_BLOCKS = [
  { re: /这是[\s\S]{0,14}梗|这就是所谓|这是一种/, why: '代码 BAD_MEME_REPLY 把这种句子判成「在解释梗」，会让她重说一遍' },
  { re: /我是文盲|我看不懂|看不明白/, why: '梗场景里这句被判成跑偏，会被重写' },
  { re: /嘿嘿/, why: 'polish() 会把「嘿嘿」直接换成「嘻嘻」' },
  { re: /哈哈/, why: '人设只说「嘻嘻」，用「哈哈」会被统一口径' },
];

function collectItems(fileId) {
  var out = [];
  var root = TREES[fileId];
  if (!root) return out;
  function walk(n, where) {
    var sec = n.title || where || '';
    (n.items || []).forEach(function (it) {
      var raw = String(it.text || '').replace(/^>\s?/, '');
      var q = /^>\s?/.test(it.text);
      var p = splitEx(raw);
      out.push({ sec: sec, raw: raw, rule: p.rule, ex: p.ex, quote: q });
    });
    (n.children || []).forEach(function (c) { walk(c, sec); });
  }
  (root.children || []).forEach(function (c) { walk(c, ''); });
  return out;
}

function bigrams(s) {
  var t = String(s || '').replace(/[\s，。、；：！？「」（）()]/g, '');
  var m = new Set();
  for (var i = 0; i < t.length - 1; i++) m.add(t.slice(i, i + 2));
  return m;
}
function simi(a, b) {
  var A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  var n = 0;
  A.forEach(function (x) { if (B.has(x)) n++; });
  return n / Math.min(A.size, B.size);
}

function runCheck(fileId) {
  var items = collectItems(fileId);
  var issues = [];

  // ② 写了也白写：举例/规则里出现代码要拦的句式
  items.forEach(function (it) {
    var body = it.raw;
    CODE_BLOCKS.forEach(function (c) {
      var m = body.match(c.re);
      if (!m) return;
      // 如果这句本身是在「禁止」它（前面有 不许/不要/禁止/不说），那是正当的规则，跳过
      var pre = body.slice(0, body.indexOf(m[0]));
      // 这句本身就是在「禁掉它」→ 是正当的规则，不是白写
      if (/(不许|不要|禁止|不能|不说|不用|别|杜绝|不允许|无须)[^，。]{0,6}$/.test(pre)) return;
      issues.push({
        kind: 'warn',
        sec: it.sec,
        title: '这句写了，但代码会判它不合格',
        body: body.slice(0, 90),
        why: c.why + '。要么改这句，要么改代码。',
      });
    });
  });

  // ① 自相矛盾：同一话题既出现「不许」又出现「可以」
  CONFLICT_TOPICS.forEach(function (tp) {
    var neg = [], pos = [];
    items.forEach(function (it) {
      if (!tp.w.test(it.raw)) return;
      var isNeg = /(不许|不要|禁止|不能|别|杜绝|一个都不许|一律不)/.test(it.raw);
      (isNeg ? neg : pos).push(it);
    });
    // 「只有…才…」「除了…」「除非…」是例外条款，不算矛盾
    var hasException = pos.some(function (x) { return /(只有|除了|除非|例外)/.test(x.raw); });
    if (neg.length && pos.length && !hasException) {
      issues.push({
        kind: 'conflict',
        sec: neg[0].sec || pos[0].sec,
        title: '「' + tp.k + '」这一件事，一处禁止、一处允许',
        body: '不许：' + neg[0].raw.slice(0, 46) + '\n允许：' + pos[0].raw.slice(0, 46),
        why: '模型读到两句相反的会两头摇摆，挑一句留、另一句删掉或改成一致。',
      });
    }
  });

  // ③ 两条说得差不多（重复维护）
  for (var i = 0; i < items.length; i++) {
    for (var j = i + 1; j < items.length; j++) {
      var a = items[i], b = items[j];
      if (a.raw.length < 12 || b.raw.length < 12) continue;
      if (a.quote || b.quote) continue;
      var s = simi(a.rule, b.rule);
      if (s >= 0.72) {
        issues.push({
          kind: 'dup',
          sec: a.sec,
          title: '这两条几乎是同一句话',
          body: a.raw.slice(0, 50) + '\n' + b.raw.slice(0, 50),
          why: '同一件事写两遍，改的时候容易只改一处，然后就打架了。留一条。',
        });
      }
    }
  }

  return { items: items.length, issues: issues };
}

function showCheck() {
  var t = activeTab();
  if (!t) return toast('先左边选个文件');
  // v52：在话题/梗库这类卡片页点上 = 全局体检（人设、说话风格、梗库、话题日志/话题一起查）
  if (isSynthetic(t.fileId)) {
    POST('/api/checkup', {}).then(function (r) { showCheckResult(r, true); });
    return;
  }
  showCheckResult(runCheck(t.fileId), false);
}
function showCheckResult(r, global) {
  var d = document.getElementById('dlg');
  d.className = 'dlg wide';
  d.textContent = '';
  d.appendChild(el('p', null, (global ? '全局体检' : '体检') + '：' + r.items + ' 条内容，' + (r.issues.length ? r.issues.length + ' 处要看看' : '没发现问题')));
  if (!r.issues.length) {
    d.appendChild(el('div', 'dlgsub', '没有前后矛盾，也没有写了会被代码判错的句子。'));
  } else {
    var box = el('div', 'ckbox');
    r.issues.forEach(function (it) {
      var c = el('div', 'ckitem ' + it.kind);
      var head = el('div', 'ckhead');
      var tag = el('span', 'cktag', it.kind === 'conflict' ? '矛盾' : (it.kind === 'dup' ? '重复' : '白写'));
      head.appendChild(tag);
      head.appendChild(el('span', 'cktitle', it.title));
      c.appendChild(head);
      if (it.src) c.appendChild(el('div', 'cksec', '来源：' + it.src));
      if (it.sec) c.appendChild(el('div', 'cksec', '位置：' + it.sec));
      var b = el('div', 'ckbody');
      b.textContent = it.body;
      c.appendChild(b);
      c.appendChild(el('div', 'ckwhy', it.why));
      box.appendChild(c);
    });
    d.appendChild(box);
  }
  var acts = el('div', 'acts');
  var ok = el('button', 'main', '知道了');
  ok.onclick = function () { closeDlg(); };
  acts.appendChild(ok);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}


function nodeHasNews(fileId, node) {
  var list = NEWS[fileId];
  if (!list || !list.length) return false;
  if ((node.items || []).some(function (i) { return list.indexOf(hash(i.text)) >= 0; })) return true;
  return (node.children || []).some(function (c) { return nodeHasNews(fileId, c); });
}

function clearNews(fileId, node, single) {
  var list = NEWS[fileId];
  if (!list || !list.length) return;
  var kill = [];
  if (single) kill.push(hash(single.text));
  else if (node) {
    (node.items || []).forEach(function (i) { kill.push(hash(i.text)); });
    (node.children || []).forEach(function (c) {
      (c.items || []).forEach(function (i) { kill.push(hash(i.text)); });
    });
  }
  NEWS[fileId] = list.filter(function (h) { return kill.indexOf(h) < 0; });
  POST('/api/seen', { id: fileId, hashes: kill });
  renderTabs();
  // 只重画受影响的那块，避免打断悬停
  var t = activeTab();
  if (t && t.fileId === fileId) renderContent();
}

var autoSaveTimer = null;
function onTextChanged(fileId, now) {
  CUR = fileId;
  renderContent();
  renderFiles();
  renderTabs();
  clearTimeout(autoSaveTimer);
  // 结构变更（拖动排序、删小标题）立刻落盘：等 1.5 秒的话，拖完马上切页/关窗就白拖了
  if (now) {
    if (TREES[fileId] && isDirty(fileId)) saveFile(fileId);
    return;
  }
  // 停下来 1.5 秒就自动落盘：不用惦记着点「保存」，也不会打断连续打字
  autoSaveTimer = setTimeout(function () {
    if (TREES[fileId] && isDirty(fileId)) saveFile(fileId);
  }, 1500);
}

/* ---------- 行内编辑：多行自适应 ---------- */
// opts.multiline：保留换行（例子可以一行一个）；默认把换行压成空格（规则要一句话）
function editInline(host, value, onDone, opts) {
  if (host.querySelector('textarea')) return;
  var old = host.textContent;
  host.textContent = '';
  var ta = el('textarea');
  ta.value = value == null ? '' : value;
  host.appendChild(ta);
  var grow = function () { ta.style.height = 'auto'; ta.style.height = Math.max(34, ta.scrollHeight + 6) + 'px'; };
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.oninput = grow;
  var closed = false;
  var finish = function (ok) {
    if (closed) return;
    closed = true;
    var v = String(ta.value || '');
    v = (opts && opts.multiline) ? v.replace(/[ \t]+/g, ' ').trim() : v.replace(/[\r\n]+/g, ' ').trim();
    host.textContent = old;
    if (ok && v && v !== value) onDone(v);
    else renderContent();
  };
  ta.onblur = function () { finish(true); };
  ta.onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); ta.onblur = null; finish(false); }
  };
}

/* ---------- 时间 ---------- */
var dbit = null, dbfile = null;
function dateBox(it, fileId) {
  dbit = it; dbfile = fileId;
  var d = document.getElementById('dlg');
  d.textContent = '';
  d.appendChild(el('p', 'row', '这条的时间'));
  var row = el('div', 'row');
  var inp = el('input');
  inp.type = 'date';
  inp.value = it.d || today();
  row.appendChild(inp);
  d.appendChild(row);
  var acts = el('div', 'acts');
  var bToday = el('button', null, '今天');
  bToday.onclick = function () { inp.value = today(); };
  var bClear = el('button', null, '清除时间');
  bClear.onclick = function () { inp.value = ''; };
  var bNo = el('button', null, '取消');
  bNo.onclick = closeDlg;
  var bOk = el('button', 'main', '确定');
  bOk.onclick = function () {
    it.d = /^\d{4}-\d{1,2}-\d{1,2}$/.test(inp.value) ? inp.value : '';
    closeDlg();
    onTextChanged(fileId);
  };
  acts.appendChild(bClear); acts.appendChild(bToday); acts.appendChild(bNo); acts.appendChild(bOk);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}
function closeDlg() {
  document.getElementById('mask').classList.remove('on');
  document.getElementById('dlg').className = 'dlg';   // 收掉 wide，别影响下一个弹窗
  dbit = null;
}

function confirmBox(msg, ok) {
  var d = document.getElementById('dlg');
  d.textContent = '';
  var p = el('p', null, msg);
  p.style.whiteSpace = 'pre-wrap';
  d.appendChild(p);
  var acts = el('div', 'acts');
  var bNo = el('button', null, '取消'); bNo.onclick = closeDlg;
  var bOk = el('button', 'main', '确定');
  bOk.onclick = function () { closeDlg(); ok(); };
  acts.appendChild(bNo); acts.appendChild(bOk);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}

// 页内编辑弹层（不用原生 prompt——会被沙箱/预览静默屏蔽）。ok(新内容, 新分类)
function editBox(title, text, topic, ok) {
  var d = document.getElementById('dlg');
  d.textContent = '';
  var h = el('p', null, title); h.style.fontWeight = '600';
  d.appendChild(h);
  var ta = document.createElement('textarea');
  ta.style.width = '100%'; ta.style.minHeight = '110px'; ta.style.boxSizing = 'border-box';
  ta.value = text || '';
  d.appendChild(ta);
  var row = el('div', null); row.style.marginTop = '6px';
  var lab = el('span', null, '分类（可空）：'); lab.style.fontSize = '12px'; lab.style.opacity = '.7';
  var inp = document.createElement('input');
  inp.style.width = '40%'; inp.value = topic || '';
  row.appendChild(lab); row.appendChild(inp);
  d.appendChild(row);
  var acts = el('div', 'acts');
  var bNo = el('button', null, '取消'); bNo.onclick = closeDlg;
  var bOk = el('button', 'main', '保存');
  bOk.onclick = function () { closeDlg(); ok(ta.value.trim(), inp.value.trim()); };
  acts.appendChild(bNo); acts.appendChild(bOk);
  d.appendChild(acts);
  document.getElementById('mask').classList.add('on');
}

/* ---------- 拖放落点 ---------- */
// 拖到这一层的空白处 / 「＋ 新小标题」那一格 → 放到最后
function dropOnEnd(t) {
  var dp = nodeAt(t.fileId, t.path);
  if (!dp) return;
  var cl = dp.children || [];
  if (!cl.length) return;
  moveNode(DRAG.fileId, DRAG.path, t.fileId, t.path, cl.length - 1, true);
  DRAG_T0 = Date.now();
}

// 记下「这个标签现在指的是哪一串标题」（标题文字链），移动完再按文字链找回来。
// 只按索引修正是不够的：同层拖动时后面的索引会集体让位，一改就全指错。
function titleChain(fileId, p) {
  var node = TREES[fileId], out = [];
  if (!node || !p || !p.length) return null;
  for (var i = 0; i < p.length; i++) {
    var kids = node.children || [];
    node = kids[p[i]];
    if (!node) return null;
    out.push(node.title);
  }
  return out;
}
function findByTitles(fileId, titles) {
  var node = TREES[fileId], p = [];
  for (var i = 0; i < titles.length; i++) {
    var kids = (node && node.children) || [], hit = -1;
    for (var k = 0; k < kids.length; k++) if (kids[k].title === titles[i]) { hit = k; break; }
    if (hit < 0) return null;
    p.push(hit); node = kids[hit];
  }
  return p;
}

function dropOnTile(t, ci, after) {
  var targetParent = nodeAt(t.fileId, t.path);
  if (!targetParent) return;

  if (DRAG.type === 'draft') {
    var node = targetParent.children[ci];
    if (!node) return;
    node.items.push({ t: 'li', text: DRAG.text, d: DRAG.d || '', ind: 0 });
    DRAFTS.splice(DRAG.di, 1);
    renderDrafts(); onTextChanged(t.fileId); toast('放进「' + node.title + '」了');
    return;
  }
  if (DRAG.type === 'item') {
    var srcP = nodeAt(DRAG.fileId, DRAG.path);
    if (!srcP) return;
    var moving = srcP.items.splice(DRAG.idx, 1)[0];
    if (!moving) return;
    var dst = targetParent.children[ci];
    if (!dst) return;
    dst.items.push(moving);
    onTextChanged(t.fileId);
    toast('移到「' + dst.title + '」里了');
    return;
  }
  if (DRAG.type === 'node') {
    moveNode(DRAG.fileId, DRAG.path, t.fileId, t.path, ci, after);
  }
}

function moveNode(srcFile, srcPath, dstFile, dstPath, ci, after) {
  if (srcFile !== dstFile) { toast('小标题不能跨文件搬'); return; }
  // 不能搬到自己或自己的子孙里
  if (dstPath.length >= srcPath.length && srcPath.every(function (v, i) { return dstPath[i] === v; })) {
    toast('不能把小标题放进它自己里面');
    return;
  }
  var sp = nodeAt(srcFile, srcPath.slice(0, -1));
  if (!sp) return;
  var si = srcPath[srcPath.length - 1];
  // 移动前先记下每个标签指的是哪一串标题（按索引改会连锁错位：后面的索引全让位）
  var tabChains = TABS.map(function (tb) {
    if (tb.fileId !== srcFile || !tb.path || !tb.path.length) return null;
    return titleChain(srcFile, tb.path);
  });
  var node = sp.children.splice(si, 1)[0];
  if (!node) return;
  var dp = nodeAt(dstFile, dstPath);
  if (!dp) {
    sp.children.splice(si, 0, node);   // 目标层没了就退回原位，别把小标题弄丢
    return;
  }
  var to = ci + (after ? 1 : 0);
  // 同父级内移动时修正索引
  if (srcPath.slice(0, -1).join('.') === dstPath.join('.') && si < to) to--;
  dp.children.splice(to, 0, node);
  // 移动完按标题链把标签重新对回来；对不上的说明它那一页真没了，标成失效
  TABS.forEach(function (tb, i) {
    var ch = tabChains[i];
    if (!ch) return;
    var np = findByTitles(tb.fileId, ch);
    if (np) { tb.path = np; tb.dead = false; }
    else tb.dead = true;
  });
  onTextChanged(dstFile, true);   // 结构变了立刻落盘，别等 1.5 秒（拖完就切页会丢）
}

/* ---------- 底部 composer ---------- */
function renderDrafts() {
  var box = document.getElementById('drafts');
  box.textContent = '';
  DRAFTS.forEach(function (d, i) {
    var c = el('div', 'chip');
    c.draggable = true;
    c.title = '拖到页面里的条目位置就能插进去';
    var txt = el('span', 'c', d.text);
    c.appendChild(txt);
    var rm = el('button', 'rm', '✕');
    rm.onclick = function (e) { e.stopPropagation(); DRAFTS.splice(i, 1); renderDrafts(); };
    c.appendChild(rm);
    c.ondragstart = function (e) {
      DRAG = { type: 'draft', text: d.text, d: d.d, di: i };
      try { e.dataTransfer.setData('text/plain', 'draft'); } catch (x) {}
    };
    c.ondragend = function () { DRAG = null; };
    box.appendChild(c);
  });
}

function autoGrowTa() {
  var ta = document.getElementById('ntext');
  ta.style.height = 'auto';
  ta.style.height = Math.min(window.innerHeight * 0.42, Math.max(52, ta.scrollHeight)) + 'px';
  var has = ta.value.trim().length > 0;
  document.getElementById('send').classList.toggle('dim', !has);
}

function autoGrowNex() {
  var ta = document.getElementById('nex');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(window.innerHeight * 0.2, Math.max(40, ta.scrollHeight)) + 'px';
}

// 举例那一格：默认收着，不占地方
function exOpen(on) {
  var box = document.getElementById('exline');
  var btn = document.getElementById('addex');
  if (!box) return;
  box.classList.toggle('on', !!on);
  if (btn) btn.classList.toggle('on', !!on);
  if (on) { autoGrowNex(); document.getElementById('nex').focus(); }
}

function readInput() {
  var ta = document.getElementById('ntext');
  var exTa = document.getElementById('nex');
  var raw = ta.value.replace(/\r/g, '');
  var lines = raw.split('\n').map(function (s) { return s.replace(/^[-*]\s+/, '').trim(); }).filter(Boolean);
  // 在规则行里直接打了「举例：…」的，例子也自动包上「」——不用自己打引号
  lines = lines.map(function (s) {
    var sp = splitEx(s);
    if (!sp.ex) return s;
    return joinEx(sp.rule, tidyEx(sp.ex));
  });
  var ex = tidyEx(exTa ? exTa.value : '');
  if (!ex || !lines.length) return lines;
  // 一次写好几行时，例子配给最后一条（这也是人写东西时的直觉）
  var last = lines[lines.length - 1];
  var sp = splitEx(last);
  var both = sp.ex ? tidyEx(sp.ex + '\n' + ex) : ex;   // 行里已有举例就和框里的合并
  lines[lines.length - 1] = joinEx(sp.rule, both);
  return lines;
}

function addToPage(lines) {
  var t = activeTab();
  if (!t) return toast('先左边选个文件');
  var n = nodeAt(t.fileId, t.path);
  if (!n) return toast('这一页不在了');
  lines.forEach(function (s) {
    // 行首自带日期的认成时间
    var m = s.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*[·•:：\-—]?\s*/);
    var d = DATE_ON ? DATE_VAL : '';
    if (m) { d = m[1]; s = s.slice(m[0].length).trim(); }
    if (!s) return;
    n.items.push({ t: 'li', text: s, d: d, ind: 0 });
  });
  document.getElementById('ntext').value = '';
  var nex = document.getElementById('nex');
  if (nex) nex.value = '';
  exOpen(false);
  autoGrowTa();
  onTextChanged(t.fileId);
}

/* ---------- 绑定 ---------- */
function bind() {
  document.getElementById('mask').onclick = function (e) {
    if (e.target === this) closeDlg();
  };

  document.getElementById('flist').addEventListener('scroll', function () {
    var syncs = document.querySelectorAll('[data-sync]');
    var self = this;
    // 外部改动提示：只对当前文件显示 ↻
    Array.prototype.forEach.call(syncs, function (b) {
      var id = b.dataset.sync;
      b.style.opacity = (SIGS[id] && SIGS[id] !== b.dataset.sig) ? '1' : '0';
    });
  });

  document.getElementById('fkey').onclick = function () {
    var d = document.getElementById('dlg');
    d.textContent = '';
    d.appendChild(el('p', null, '智谱 API Key'));
    var sub = el('div', null, '正在读当前状态…');
    sub.style.cssText = 'font-size:11.5px;color:var(--sub);margin-bottom:10px';
    d.appendChild(sub);

    var inp = document.createElement('textarea');
    inp.rows = 3;
    inp.placeholder = '粘贴 API Key（形如 32位.16位，中间有个英文句点）';
    inp.style.cssText = 'width:100%;border:1px solid var(--bd2);border-radius:9px;padding:8px 10px;font:12.5px/1.6 ui-monospace,Consolas,monospace;resize:vertical;min-height:64px';
    d.appendChild(inp);

    var tip = el('div', null, '控制台：bigmodel.cn/usercenter/proj-mgmt/apikeys → 点「复制」按钮，别手动拖选');
    tip.style.cssText = 'font-size:11px;color:var(--sub);margin-top:8px;line-height:1.5';
    d.appendChild(tip);

    var res = el('div', null, '');
    res.style.cssText = 'font-size:12px;margin-top:10px;min-height:18px';
    d.appendChild(res);

    api('/api/key').then(function (r) {
      if (r.error) { sub.textContent = r.error; return; }
      sub.textContent = r.set
        ? '当前：' + r.masked + (r.ok ? '（格式正常）' : '（⚠ 格式不完整）') + ' · 模型 ' + r.model
        : '还没有填过 Key';
    });

    var acts = el('div', 'acts');
    var bNo = el('button', null, '取消'); bNo.onclick = closeDlg;
    var bOk = el('button', 'main', '保存并测试');
    bOk.onclick = function () {
      var v = (inp.value || '').trim();
      if (!v) { res.style.color = 'var(--danger)'; res.textContent = '先粘贴一串进来'; return; }
      bOk.disabled = true; bOk.textContent = '测试中…';
      res.style.color = 'var(--sub)'; res.textContent = '正在写入并试发一次…';
      POST('/api/key', { key: v }).then(function (r) {
        bOk.disabled = false; bOk.textContent = '保存并测试';
        if (r.error) { res.style.color = 'var(--danger)'; res.textContent = r.error; return; }
        if (r.test === 'ok') {
          res.style.color = 'var(--ok)';
          res.textContent = '✅ 已保存 ' + r.masked + '，试发成功' + (r.used && r.used !== 'GLM-4.7-Flash' ? '（用的是备用模型 ' + r.used + '）' : '') + '。关掉「启动」黑窗口重新双击一次就生效了。';
        } else if (r.test === 'busy') {
          res.style.color = 'var(--warn)';
          res.textContent = '⚠ 已保存 ' + r.masked + '。试发时模型在排长队（' + (r.msg || '1305') + '），这不代表 Key 有问题——刚才没被拒绝就说明 Key 是好的。稍等一会儿再试。';
        } else {
          res.style.color = 'var(--danger)';
          res.textContent = '❌ 已保存 ' + r.masked + '，但试发失败：' + (r.msg || '未知原因') + '。这通常是 Key 不对，去控制台重新复制一次。';
        }
      });
    };
    acts.appendChild(bNo); acts.appendChild(bOk);
    d.appendChild(acts);
    document.getElementById('mask').classList.add('on');
    inp.focus();
  };

  document.getElementById('fnew').onclick = function () {
    var d = document.getElementById('dlg');
    d.textContent = '';
    d.appendChild(el('p', null, '新建一个文件'));
    var row = el('div', 'row');
    var inp = el('input');
    inp.placeholder = '文件名（不带 .md）';
    inp.style.cssText = 'flex:1;border:1px solid var(--bd2);border-radius:9px;padding:8px 10px;font-size:13px';
    row.appendChild(inp);
    d.appendChild(row);
    var row2 = el('div', 'row');
    var sel = el('select');
    sel.style.cssText = 'flex:1;border:1px solid var(--bd2);border-radius:9px;padding:8px 10px;font-size:13px;background:#fff';
    [['data', '数据（data/）'], ['soul', '人设（soul/）'], ['data/guides', '游戏攻略（data/guides/）']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op);
    });
    sel.value = (CUR || '').indexOf('data/guides/') === 0 ? 'data/guides' : ((CUR || '').indexOf('soul/') === 0 ? 'soul' : 'data');
    row2.appendChild(sel);
    d.appendChild(row2);
    var acts = el('div', 'acts');
    var bNo = el('button', null, '取消'); bNo.onclick = closeDlg;
    var bOk = el('button', 'main', '创建');
    bOk.onclick = function () {
      var name = (inp.value || '').trim();
      if (!name) return;
      POST('/api/create', { name: name, dir: sel.value }).then(function (r) {
        if (r.error) return toast(r.error);
        closeDlg(); boot();
      });
    };
    acts.appendChild(bNo); acts.appendChild(bOk);
    d.appendChild(acts);
    document.getElementById('mask').classList.add('on');
    inp.focus();
  };

  var ta = document.getElementById('ntext');
  ta.addEventListener('input', autoGrowTa);
  ta.addEventListener('keydown', function (e) {
    // 和 QQ 一样的习惯：回车就加进页面，Shift+回车才是换行（要写好几条时用）
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      var ls = readInput();
      if (!ls.length) return toast('先写点字再回车');
      addToPage(ls);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      addToPage(readInput());
    }
    // Ctrl+S = 保存当前文件（和别处一样的习惯）
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      var t2 = activeTab();
      if (t2 && TREES[t2.fileId]) saveFile(t2.fileId);
    }
  });

  // 举例那一格：点「＋举例」才出现；Esc 收起
  var nexEl = document.getElementById('nex');
  if (nexEl) {
    nexEl.addEventListener('input', autoGrowNex);
    nexEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); exOpen(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        var lines2 = readInput();
        if (lines2.length) addToPage(lines2);
      }
    });
  }
  var addExBtn = document.getElementById('addex');
  if (addExBtn) addExBtn.onclick = function () { exOpen(!document.getElementById('exline').classList.contains('on')); };
  var closeExBtn = document.getElementById('exclose');
  if (closeExBtn) closeExBtn.onclick = function () {
    var n = document.getElementById('nex');
    if (n) n.value = '';
    exOpen(false);
  };

  // 净化排版 + 体检
  var tidyBtn = document.getElementById('tidy');
  if (tidyBtn) tidyBtn.onclick = function () { tidyCurrent(); };
  var ckBtn = document.getElementById('check');
  if (ckBtn) ckBtn.onclick = function () { showCheck(); };

  document.getElementById('send').onclick = function () {
    var lines = readInput();
    if (!lines.length) return toast('先写点字');
    addToPage(lines);
  };

  document.getElementById('stash').onclick = function () {
    var lines = readInput();
    if (!lines.length) return toast('先写点字');
    lines.forEach(function (s) {
      DRAFTS.push({ text: s, d: DATE_ON ? DATE_VAL : '' });
    });
    ta.value = '';
    autoGrowTa(); renderDrafts();
  };

  // Ctrl+S 全局也能存（焦点不在输入框时）
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      var t = activeTab();
      if (t && TREES[t.fileId] && isDirty(t.fileId)) saveFile(t.fileId);
      else if (t && TREES[t.fileId]) toast('这个文件没有改动');
    }
  });

  document.getElementById('tpick').onclick = function () {
    DATE_ON = !DATE_ON;
    this.classList.toggle('on', DATE_ON);
    document.getElementById('ndate').style.display = DATE_ON ? 'inline-block' : 'none';
    document.getElementById('tlabel').textContent = DATE_ON ? (DATE_VAL === today() ? '今天' : DATE_VAL) : '不加时间';
  };
  var nd = document.getElementById('ndate');
  nd.value = today();
  nd.onchange = function () {
    DATE_VAL = nd.value || today();
    document.getElementById('tlabel').textContent = DATE_VAL === today() ? '今天' : DATE_VAL;
  };
  document.getElementById('tpick').classList.add('on');
  nd.style.display = 'inline-block';

  document.getElementById('sectpick').onclick = function () {
    var t = activeTab();
    if (!t) return toast('先选个文件');
    var d = document.getElementById('dlg');
    d.textContent = '';
    d.appendChild(el('p', null, '加到哪里'));
    var info = el('div', null, t.titles.join(' › ') || '文件根');
    info.style.cssText = 'font-size:12px;color:var(--sub);margin-bottom:12px';
    d.appendChild(info);
    var acts = el('div', 'acts');
    var bOk = el('button', 'main', '就用当前页');
    bOk.onclick = closeDlg;
    acts.appendChild(bOk);
    d.appendChild(acts);
    document.getElementById('mask').classList.add('on');
  };

  window.addEventListener('resize', autoGrowTa);

  // 每 6 秒看一次文件指纹，外面被改了就提示
  setInterval(function () {
    api('/api/meta').then(function (r) {
      var changed = [];
      Object.keys(r.sig || {}).forEach(function (id) {
        if (SIGS[id] && SIGS[id] !== r.sig[id]) changed.push(id);
      });
      if (!changed.length) return;
      var cur = CUR;
      if (changed.indexOf(cur) >= 0 && !isDirty(cur)) {
        reloadFile(cur).then(function () { toast('文件被外面改过，已重读'); });
      } else {
        changed.forEach(function (id) {
          var b = document.querySelector('[data-sync="' + id + '"]');
          if (b) b.style.opacity = '1';
        });
        toast('有文件在外面被改了，点左边那个 ↻ 重读');
      }
      changed.forEach(function (id) { SIGS['__pending_' + id] = r.sig[id]; });
    }).catch(function () {});
  }, 6000);
}

/* ---------- 状态栏：连接 / 思考中 / 待确认 / 待收进话题 / 待刷新（像 MC 的提示灯） ---------- */
// 主人 2026-10-22：状态栏是全局的，任何页面都要看得见（之前跟着文本框被功能页一起藏了）
var BOT = { online: false, detail: '', pending: 0, thinking: false };
var TPC = { summed: 0 };        // 话题日志里「已总结但还没收进话题」的条数
var STALE = [];
function refreshStatus() {
  api('/api/status').then(function (s) {
    if (s && !s.error) {
      BOT.online = !!s.online; BOT.detail = s.detail || ''; BOT.pending = s.pending || 0; BOT.thinking = !!s.thinking;
      BOT.pidAlive = s.pidAlive;                                 // 进程还在不在（窗口开着≠进程活着）
      BOT.clashN = s.clashN || 0; BOT.favLike = s.favLike || 0; BOT.favFull = s.favFull || 0;
      BOT.selfBad = s.selfBad || 0; BOT.fbN = s.fbN || 0;      // 虚幻自查：没解决项 + 历史条数
      BOT.paused = s.paused || [];                              // 暂停中的群/人（她闭嘴了）
      BOT.reqNew = s.reqNew || 0;                               // 自动同意（加好友/被拉进群）还没看过的条数
    }
    return api('/api/meta');
  }).then(function (m) {
    if (m && m.sig) {
      STALE = [];
      Object.keys(m.sig).forEach(function (id) { if (SIGS[id] && SIGS[id] !== m.sig[id]) STALE.push(id); });
    }
    renderStatus();
  }).catch(function () {});
  // 待添加的已总结话题：limit=1 只取计数，不拉列表（每 5 秒一次）
  api('/api/topic?view=topics&limit=1').then(function (r) {
    TPC.summed = (r && r.counts && r.counts.summed) || 0;
    renderStatus();
  }).catch(function () {});
}
function renderStatus() {
  var box = document.getElementById('statusbar');
  if (!box) return;
  box.textContent = '';
  function pill(cls, led, text, tip, onClick) {
    var p = el('div', 'st ' + (cls || ''), '');
    if (led) p.appendChild(el('span', 'led'));
    p.appendChild(el('span', null, text));
    if (tip) p.title = tip;
    if (onClick) { p.classList.add('link'); p.onclick = onClick; }
    box.appendChild(p);
    return p;
  }
  // 进程还在不在（v88）：pidAlive===false 时状态文件还写着 online=true（它冻在最后一刻），
  // 只看文件会一直亮绿灯 —— 这就是「窗口一直开着却掉线」看不出来的原因，这里必须说破。
  var dead = BOT.pidAlive === false;
  pill(dead ? 'bad link' : (BOT.online ? 'ok' : 'bad'), true,
    dead ? '机器人进程已退出' : (BOT.online ? '机器人已连上 QQ' : '机器人没连上 QQ'),
    dead ? '启动窗口可能还开着，但后台那个进程已经不在了，所以看不出掉线。修：关掉那个黑窗口，重新双击「启动」；或在「自检」里选 4 一键重启'
      : (BOT.online ? 'NapCat 连接正常，消息进得来' : ('连接断开：' + (BOT.detail || '未知') + '。看左边「其他」里的启动窗口，或翻项目总览的排障表')),
    (dead || !BOT.online) ? function () { openMap(); } : null);
  // 暂停中（她闭嘴了）：最容易让人以为「她坏了」，必须显眼
  if (BOT.paused && BOT.paused.length) {
    pill('bad link', true, '暂停中：' + BOT.paused.join('、'),
      '她被暂停了，这些地方一句都不说（聊天记录照记）。点这里看怎么办：私聊她发「允许' + (BOT.paused[0] || '') + '」就恢复',
      function () { openMap(); });
  }
  if (BOT.thinking) {
    pill('think', true, '正在想答案…', '它在等模型回话。这时候面板照样能用——保存、改文件都不耽误它思考。');
  }
  // 虚幻自查（主人 2026-10-23 定：她的反馈改名虚幻自查，进状态栏）
  // 她每 5 分钟自己体检一遍：配置/文件/梗库/表情单/连接/模型，查到毛病就在这儿报警，同时私聊提醒主人。
  if (BOT.selfBad > 0) {
    pill('warn link', true, '虚幻自查：' + BOT.selfBad + ' 项没解决',
      '她自己查出 ' + BOT.selfBad + ' 个还没修好的问题（历史记录共 ' + (BOT.fbN || 0) + ' 条）。点开看是什么',
      function () { openFeedback(); });
  } else {
    pill('', true, '虚幻自查没问题', '她自己的定期体检（每 5 分钟）没查出毛病。查出问题这里会变红并提醒主人；历史记录点开也能看',
      function () { openFeedback(); });
  }
  // 自动同意（2026-11-01）：新加的好友 / 新进的群还没看过 → 显示数字；点一下清零，从 0 重新数
  if (BOT.reqNew > 0) {
    var ac = pill('warn link', true, '加群/好友 ' + BOT.reqNew,
      '自动同意了 ' + BOT.reqNew + ' 条（加好友 / 被拉进群）。点一下清零，之后从这个数重新数',
      function () { POST('/api/accept-read', {}).then(function () { BOT.reqNew = 0; renderStatus(); }); });
    // 悬停时才现查「最近几条是谁」（鼠标进来查一次，不占每 5 秒的轮询）
    ac.addEventListener('mouseenter', function () {
      if (ac.getAttribute('data-tip')) return;
      api('/api/accept').then(function (r) {
        var its = (r && r.items) || [];
        if (!its.length) return;
        ac.setAttribute('data-tip', '1');
        ac.title = '最近自动同意：\n' + its.slice(0, 3).map(function (x) {
          var when = new Date(x.t).toLocaleString();
          return '· ' + (x.kind === 'group' ? '进群 ' + (x.gid || '') : '加好友') + '：' + (x.who || x.uid || '') + '（' + when + '）';
        }).join('\n') + '\n点一下清零';
      }).catch(function () {});
    });
  }
  if (BOT.pending > 0) {
    pill('warn link', true, '待确认口味 ' + BOT.pending + ' 项',
      '它提过但没表态的喜好。点开《人物喜好》，把「待确认」里的拖到「确定」就算认下',
      function () { openTasteFile(); });
  } else {
    pill('', true, '口味无待确认', '它提过但没表态的喜好会出现在这里，点开看看', function () { openTasteFile(); });
  }
  // 待添加的已总结话题：话题日志里总结好了、还没收进「话题」（长期记忆）的几条
  if (TPC.summed > 0) {
    pill('warn link', true, '待添加的已总结话题 ' + TPC.summed + ' 项',
      '话题日志里已经总结好、还没放进「话题」的有 ' + TPC.summed + ' 条。点开后用「收进话题」把它们搬进长期记忆',
      function () { openTopic(); });
  } else {
    pill('', true, '已总结话题无待添加', '话题日志里总结好的条目会在这里显示，点开可以「收进话题」放长期记忆', function () { openTopic(); });
  }
  // 喜好重合（描述重合的两条都留着，等主人决定删哪条——主人 2026-10-22 定）
  if (BOT.clashN > 0) {
    pill('warn link', true, '喜好重合 ' + BOT.clashN + ' 对',
      '《人物喜好》里有描述重合的条目（比如「神秘园」和「神秘园森林」），都留着没合并。点开看看，删掉不要的那条',
      function () { openTasteFile(); });
  } else {
    pill('', true, '喜好无重合', '同一节里描述重合的喜好会在这里提醒，由你决定留哪条', function () { openTasteFile(); });
  }
  // 好感度：过 60 算喜欢、满 100 叫宝宝（后台数据，不发 QQ）
  pill('link', true, '好感：' + (BOT.favFull || 0) + ' 满 / ' + (BOT.favLike || 0) + ' 喜欢',
    '夸一次 +1；过 60 算喜欢（自动记进喜好表「喜欢（人物）」）；满 100 日常才叫「宝宝」。后台数据不会发到 QQ。点开称呼表可以手动调',
    function () { openTable('state'); });
  if (STALE.length) {
    pill('warn link', false, '↻ ' + STALE.length + ' 个文件外面被改了', '有文件在面板外被改过。点这里整体刷新，或点左边那行的 ↻', function () { boot(); });
  }
  pill('ok', true, '面板正常', '这个管理面板自己在跑');
  // 规矩·功能（主人 2026-10-23 定）：状态栏小角落，一页看全规矩手册 + 功能列表 + 变更记录
  pill('link', true, '规矩·功能', '点开「功能与规矩」页：她的所有规矩（悬停看细则和具体数值）、功能列表、变更记录', function () { openFeatures(); });
  var t = el('div', 'st', new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  t.style.marginLeft = 'auto';
  box.appendChild(t);
}
function openTasteFile() {
  var i = TABS.findIndex(function (t) { return t.fileId === 'data/人物喜好.md'; });
  if (i >= 0) { ACTIVE = i; renderTabs(); renderContent(); renderFiles(); return; }
  openRoot('data/人物喜好.md');
}

function renderAll() {
  renderFiles();
  renderTabs();
  renderContent();
  renderDrafts();
  autoGrowTa();
}

bind();
boot();
refreshStatus();
setInterval(refreshStatus, 5000);

})();
