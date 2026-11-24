/* 情绪书面板（2026-11-07 主人定）
 * 6 大类分页 + 搜索 + 拖图换叶 + 外部拖入 + 大图设优先级/改名 + 两列词编辑。
 * 不改表情包页的结构，只在它上面加一个 tab。 */
(function () {
  var API = '/api/emobook';
  var BOOK = null;        // { tree, imgs, recent, ratio }
  var CORE = '';          // 当前分页 '' = 全部
  var Q = '';             // 搜索词
  var DIRTY = false;

  function el(t, c, txt) {
    var e = document.createElement(t || 'div');
    if (c) e.className = c;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function toast(msg) {
    var t = document.getElementById('eb-toast');
    if (!t) { t = el('div', 'eb-toast'); t.id = 'eb-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  /* 客户端没有 HTTP 服务（file:// 里 fetch 会 Failed to fetch），
   * 走 preload 开出来的 window.xuh.api —— 后端就是面板那份 handler，不另写。 */
  function post(url, body) {
    if (window.xuh && window.xuh.api) return Promise.resolve(window.xuh.api('POST', url, body || {}));
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  }
  function get(url) {
    if (window.xuh && window.xuh.api) return Promise.resolve(window.xuh.api('GET', url));
    return fetch(url).then(function (r) { return r.json(); });
  }

  /* 图地址：跟表情包页同一个入口（客户端是 xuh://stickers/，面板是 /api/stkimg） */
  function imgUrl(rel) {
    var s = String(rel || '');
    if (window.StickerPage && window.StickerPage.imgUrl) return window.StickerPage.imgUrl(s);
    return '/api/stkimg?n=' + encodeURIComponent(s);
  }
  function bareOf(rel) { return String(rel).replace(/\.[^.]+$/, '').split('/').pop(); }
  function poolOf(rel) {
    var s = String(rel);
    if (s.indexOf('常用/') === 0 || s.indexOf('虚幻/') === 0) return '常用';
    if (s.indexOf('可用/') === 0) return '可用';
    if (s.indexOf('关键词触发/') === 0) return '关键词';
    return '少用';
  }

  /* 一个叶子上挂的真实图：files 里的族名 → 前缀匹配 */
  function imgsOf(leaf) {
    var fams = leaf.files || [];
    if (!fams.length) return [];
    return (BOOK.imgs || []).filter(function (f) {
      var b = bareOf(f);
      return fams.some(function (fam) { return fam && (b === fam || b.indexOf(fam) === 0); });
    });
  }

  function load() {
    return get(API).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '读不出来');
      BOOK = j;
      return j;
    });
  }

  function save() {
    if (!BOOK) return Promise.resolve();
    return post(API + '/save', { book: BOOK.tree }).then(function (j) {
      if (!j || !j.ok) { toast('存失败：' + ((j && j.error) || '未知')); return; }
      DIRTY = false;
      toast('已存 · ' + j.leaves + ' 个叶');
    });
  }
  function markDirty() {
    DIRTY = true;
    var b = document.getElementById('eb-save');
    if (b) { b.classList.add('dirty'); b.textContent = '保存 *'; }
  }

  /* ================= 渲染 ================= */
  function render(box) {
    box.innerHTML = '';
    var head = el('div', 'eb-head');

    var tabs = el('div', 'eb-tabs');
    var mk = function (id, name) {
      var t = el('button', 'eb-tab' + (CORE === id ? ' on' : ''), name);
      t.onclick = function () { CORE = id; render(box); };
      tabs.appendChild(t);
    };
    mk('', '全部');
    (BOOK.tree.cores || []).forEach(function (c) { mk(c.id, c.name); });
    head.appendChild(tabs);

    var sr = el('div', 'eb-search');
    var inp = document.createElement('input');
    inp.type = 'search';
    inp.placeholder = '搜图名 / 叶名 / 词';
    inp.value = Q;
    var tm = null;
    inp.oninput = function () {
      clearTimeout(tm);
      tm = setTimeout(function () { Q = inp.value.trim(); render(box); var i2 = box.querySelector('.eb-search input'); if (i2) { i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); } }, 220);
    };
    sr.appendChild(inp);
    head.appendChild(sr);

    var btn = el('button', 'eb-save' + (DIRTY ? ' dirty' : ''), DIRTY ? '保存 *' : '保存');
    btn.id = 'eb-save';
    btn.onclick = function () { save().then(function () { render(box); }); };
    head.appendChild(btn);
    box.appendChild(head);

    var list = el('div', 'eb-list');
    var leaves = (BOOK.tree.leaves || []).slice();
    /* 分页 + 搜索 */
    if (CORE) leaves = leaves.filter(function (l) { return l.core === CORE; });
    if (Q) {
      var q = Q.toLowerCase();
      leaves = leaves.filter(function (l) {
        if (String(l.name).toLowerCase().indexOf(q) >= 0) return true;
        if (String(l.branchName || '').toLowerCase().indexOf(q) >= 0) return true;
        var words = (l.self || []).concat(l.other || []);
        if (words.some(function (w) { return String(w).toLowerCase().indexOf(q) >= 0; })) return true;
        return imgsOf(l).some(function (f) { return bareOf(f).toLowerCase().indexOf(q) >= 0; });
      });
    }

    var coreName = {};
    (BOOK.tree.cores || []).forEach(function (c) { coreName[c.id] = c.name; });

    if (!leaves.length) list.appendChild(el('div', 'eb-empty', '这一类还没叶。'));

    leaves.forEach(function (leaf) { list.appendChild(card(leaf, coreName, box)); });
    box.appendChild(list);

    /* 底部：别人的情绪记录（可审：没错 / 判错） */
    var recs = (BOOK.recent || []).slice(0, 30);
    if (recs.length) {
      var wrap = el('div', 'eb-rec');
      wrap.appendChild(el('div', 'eb-rt', '最近判出的情绪（别人的话）· 没审的标黄，点「没错 / 判错」审'));
      var ul = el('div', 'eb-rl');
      recs.forEach(function (r) {
        var row = el('div', 'eb-ri' + (r.review === 'new' ? ' new' : ''));
        row.appendChild(el('b', null, r.leaf || '?'));
        row.appendChild(el('span', 'eb-rq', '「' + String(r.text || '').slice(0, 22) + '」'));
        row.appendChild(el('i', 'eb-rw', r.word || ''));
        var st = el('span', 'eb-rst ' + (r.review === 'new' ? 'n' : (r.review === 'wrong' ? 'w' : 'o')),
          r.review === 'new' ? '未看' : (r.review === 'wrong' ? ('判错' + (r.reviewLeaf ? '→' + r.reviewLeaf : '')) : '没错'));
        row.appendChild(st);
        if (r.review === 'new') {
          var ob = el('button', 'eb-rbtn', '没错');
          ob.onclick = function (e) { e.stopPropagation(); review(r.t, 'ok', box); };
          var wb = el('button', 'eb-rbtn w', '判错');
          wb.onclick = function (e) { e.stopPropagation(); pickWrong(r, box); };
          row.appendChild(ob); row.appendChild(wb);
        }
        if (r.review === 'new') {
          var ob = el('button', 'eb-rbtn', '没错');
          ob.onclick = function (e) { e.stopPropagation(); review(r.t, 'ok', box); };
          var wb = el('button', 'eb-rbtn w', '判错');
          wb.onclick = function (e) { e.stopPropagation(); pickWrong(r, box); };
          row.appendChild(ob); row.appendChild(wb);
        }
        // 应对（推理↔应对）：这一类情绪书里写的应对，紧跟在推理下面
        var reps = leafReplies(r.leaf);
        if (reps.length) {
          var rd = el('div', 'eb-rrep');
          rd.appendChild(el('span', 'eb-rrep-h', '应对：'));
          reps.slice(0, 4).forEach(function (t) { rd.appendChild(el('span', 'eb-rrep-i', t)); });
          row.appendChild(rd);
        }
        ul.appendChild(row);
      });
      wrap.appendChild(ul);
      box.appendChild(wrap);
    }
  }

  /* 一个叶 = 一张卡 */
  function card(leaf, coreName, box) {
    var c = el('div', 'eb-card');
    c.dataset.leaf = leaf.name;
    /* 审核（主人 2026-11-07 纠正：标黄 = 没看过；判错 = 主人改过才记）
     * rv.unread>0 → 整块标黄（还有没审的判断记录）；rv.wrong>0 → 单独的「判错」标记 */
    var rv = (BOOK.review && BOOK.review[leaf.name]) || { unread: 0, wrong: 0 };
    if (rv.unread) { c.classList.add('unseen'); c.title = '这一类还有 ' + rv.unread + ' 条情绪判断没审过（未看）'; }

    var h = el('div', 'eb-ch');
    var t = el('div', 'eb-ct');
    t.appendChild(el('b', null, leaf.name));
    t.appendChild(el('span', 'eb-cb', coreName[leaf.core] + ' · ' + (leaf.branchName || leaf.branch)));
    h.appendChild(t);

    var pr = el('span', 'eb-pr', '优先级 ' + (leaf.priority || 5));
    pr.title = '数字越小越优先：同一个词命中多个叶时，小的先选；挑图也按这个顺序';
    if (rv.unread) {
      var ub = el('span', 'eb-seen', '未看 ' + rv.unread);
      ub.title = '还有 ' + rv.unread + ' 条情绪判断没审（去下面「最近判出的情绪」里审）';
      h.appendChild(ub);
    }
    if (rv.wrong) {
      var bd = el('span', 'eb-bad', '判错 ' + rv.wrong);
      bd.title = '这一类主人审过、判成 AI 错了 ' + rv.wrong + ' 次';
      h.appendChild(bd);
    }
    h.appendChild(pr);
    c.appendChild(h);

    /* 图 */
    var imgs = imgsOf(leaf);
    var row = el('div', 'eb-imgs');
    imgs.slice(0, 40).forEach(function (f) {
      var th = el('div', 'eb-th');
      if (rv.unread) { th.classList.add('dot'); }
      th.draggable = true;
      var im = document.createElement('img');
      im.src = imgUrl(f); im.alt = bareOf(f); im.loading = 'lazy';
      th.appendChild(im);
      th.title = bareOf(f) + '　·　拖到别的叶 = 换族；点一下看大图';
      th.onclick = function () { openBig(f, leaf, box); };
      th.ondragstart = function (e) {
        e.dataTransfer.setData('text/plain', JSON.stringify({ from: leaf.name, file: f }));
        e.dataTransfer.effectAllowed = 'move';
      };
      row.appendChild(th);
    });
    if (!imgs.length) row.appendChild(el('span', 'eb-ni', '这一族库里没有图'));
    if (imgs.length > 40) row.appendChild(el('span', 'eb-ni', '还有 ' + (imgs.length - 40) + ' 张'));
    c.appendChild(row);

    /* 拖进来：换族 / 外部图 */
    c.ondragover = function (e) { e.preventDefault(); c.classList.add('drop'); };
    c.ondragleave = function () { c.classList.remove('drop'); };
    c.ondrop = function (e) {
      e.preventDefault(); c.classList.remove('drop');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        uploadFiles(e.dataTransfer.files, leaf, box);
        return;
      }
      var raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      var d = null; try { d = JSON.parse(raw); } catch (x) { return; }
      if (!d || !d.file || d.from === leaf.name) return;
      moveFile(d.file, d.from, leaf, box);
    };

    /* 词：自己 / 别人 */
    c.appendChild(wordRow(leaf, 'self', '自己说的（按顺序挑第一句）', box));
    c.appendChild(wordRow(leaf, 'other', '别人说的（额外增加，不重复写）', box));

    /* 应对 */
    var rp = el('div', 'eb-rp');
    var rl = el('span', 'eb-rl2', '应对');
    rp.appendChild(rl);
    (leaf.replies || []).forEach(function (id) {
      var chip = el('span', 'eb-chip rp');
      var isLeaf = String(id).charAt(0) === '@';
      chip.textContent = isLeaf ? '→ ' + id.slice(1) : id;
      chip.title = isLeaf ? '点开跳到那个叶' : '点开看递归展开的应对内容';
      chip.onclick = function () { if (isLeaf) jumpTo(id.slice(1), box); else showReplies(id); };
      rp.appendChild(chip);
    });
    var addR = el('button', 'eb-mini', '＋应对');
    addR.title = '把别的叶拖到这张卡上，就记成它的应对';
    addR.onclick = function () { addReply(leaf, box); };
    rp.appendChild(addR);
    c.appendChild(rp);

    return c;
  }

  function wordRow(leaf, key, tip, box) {
    var w = el('div', 'eb-words');
    var lab = el('span', 'eb-wl', key === 'self' ? '自己' : '别人');
    lab.title = tip;
    w.appendChild(lab);
    (leaf[key] || []).forEach(function (word, i) {
      var chip = el('span', 'eb-chip ' + key);
      chip.textContent = word;
      var x = el('i', 'eb-x', '×');
      x.title = '删掉这个词（只从表里删，不影响图）';
      x.onclick = function (e) {
        e.stopPropagation();
        leaf[key].splice(i, 1); markDirty(); render(box);
      };
      chip.appendChild(x);
      w.appendChild(chip);
    });
    var add = el('button', 'eb-mini', '＋');
    add.onclick = function () { inlineAdd(w, leaf, key, box); };
    add.title = '加一个词';
    w.appendChild(add);
    return w;
  }

  function inlineAdd(w, leaf, key, box) {
    if (w.querySelector('.eb-addin')) return;
    var inp = document.createElement('input');
    inp.className = 'eb-addin';
    inp.placeholder = '输入词或整句，回车加';
    inp.onkeydown = function (e) {
      if (e.key === 'Escape') { inp.remove(); return; }
      if (e.key !== 'Enter') return;
      var v = inp.value.trim();
      if (!v) { inp.remove(); return; }
      if ((leaf[key] || []).indexOf(v) < 0) { leaf[key] = leaf[key] || []; leaf[key].push(v); markDirty(); }
      render(box);
    };
    w.insertBefore(inp, w.querySelector('.eb-mini'));
    inp.focus();
  }

  function addReply(leaf, box) {
    /* 自画一层：选一个叶当应对（不弹系统框） */
    var layer = el('div', 'eb-lay');
    var box2 = el('div', 'eb-box');
    box2.appendChild(el('div', 'eb-bt', '把哪个叶记成「' + leaf.name + '」的应对'));
    var sel = document.createElement('select');
    sel.appendChild(new Option('（选一个叶）', ''));
    (BOOK.tree.leaves || []).forEach(function (l) {
      if (l.name !== leaf.name) sel.appendChild(new Option(l.name, l.name));
    });
    box2.appendChild(sel);
    var bar = el('div', 'eb-bar');
    var ok = el('button', 'eb-ok', '记上');
    ok.onclick = function () {
      var v2 = sel.value;
      if (v2) {
        leaf.replies = leaf.replies || [];
        var ref = '@' + v2;
        if (leaf.replies.indexOf(ref) < 0) leaf.replies.push(ref);
        markDirty();
      }
      layer.remove(); render(box);
    };
    var no = el('button', 'eb-no', '算了');
    no.onclick = function () { layer.remove(); };
    bar.appendChild(ok); bar.appendChild(no);
    box2.appendChild(bar);
    layer.appendChild(box2);
    layer.onclick = function (e) { if (e.target === layer) layer.remove(); };
    document.body.appendChild(layer);
  }

  /* 按叶名取应对文案（递归展开，和 showReplies 同逻辑）；返回字符串数组。
   * 主人 2026-11-07 定：把「推理（为什么判成这叶）」和「情绪表的应对」联系起来。 */
  function leafReplies(name) {
    var lf = (BOOK.tree.leaves || []).filter(function (l) { return l.name === name; })[0];
    if (!lf || !lf.replies || !lf.replies.length) return [];
    var map = {};
    (BOOK.tree.replies || []).forEach(function (r) { if (r && r.id) map[r.id] = r; });
    var out = [], seen = {};
    var walk = function (k) {
      if (seen[k]) return; seen[k] = 1;
      var r = map[k];
      if (!r) return;
      if (r.text) out.push(r.text);
      (r.ref || []).forEach(walk);
    };
    lf.replies.forEach(walk);
    return out;
  }

  /* 应对递归展开（不把全文铺在面板上） */
  function showReplies(id) {
    var map = {};
    (BOOK.tree.replies || []).forEach(function (r) { if (r && r.id) map[r.id] = r; });
    var out = [], seen = {};
    var walk = function (k) {
      if (seen[k]) return; seen[k] = 1;
      var r = map[k];
      if (!r) { out.push({ id: k, text: '（找不到这一条）' }); return; }
      out.push({ id: k, text: r.text || '' });
      (r.ref || []).forEach(walk);
    };
    walk(id);
    var layer = el('div', 'eb-lay');
    var box = el('div', 'eb-box');
    box.appendChild(el('div', 'eb-bt', '应对 · ' + id));
    out.forEach(function (o) {
      var li = el('div', 'eb-rl3');
      li.appendChild(el('b', null, o.id));
      li.appendChild(el('div', 'eb-rt2', o.text));
      box.appendChild(li);
    });
    var bar = el('div', 'eb-bar');
    var no = el('button', 'eb-no', '关掉');
    no.onclick = function () { layer.remove(); };
    bar.appendChild(no);
    box.appendChild(bar);
    layer.appendChild(box);
    layer.onclick = function (e) { if (e.target === layer) layer.remove(); };
    document.body.appendChild(layer);
  }

  function jumpTo(name, box) {
    var leaf = (BOOK.tree.leaves || []).filter(function (l) { return l.name === name; })[0];
    if (!leaf) return;
    CORE = '';
    Q = name;
    render(box);
  }

  /* ================= 大图：优先级 / 改名 / 换叶 ================= */
  function openBig(file, leaf, box) {
    var layer = el('div', 'eb-lay big');
    var box2 = el('div', 'eb-bigbox');

    var im = document.createElement('img');
    im.src = imgUrl(file);
    im.className = 'eb-bigimg';
    box2.appendChild(im);

    var nm = el('div', 'eb-bigname', bareOf(file));
    box2.appendChild(nm);

    var meta = el('div', 'eb-bigmeta',
      '在 ' + poolOf(file) + '　·　属于叶「' + leaf.name + '」　·　' + (leaf.branchName || leaf.branch));
    box2.appendChild(meta);

    /* 优先级 */
    var pr = el('div', 'eb-bigrow');
    pr.appendChild(el('span', 'eb-bl', '优先级'));
    var pi = document.createElement('input');
    pi.type = 'number'; pi.min = '1'; pi.max = '9'; pi.className = 'eb-num';
    pi.value = leaf.priority || 5;
    pi.onchange = function () {
      leaf.priority = Math.max(1, Math.min(9, Number(pi.value) || 5));
      markDirty();
      prune(); render(box);
      toast('优先级改成 ' + leaf.priority + '（记得保存）');
    };
    pr.appendChild(pi);
    pr.appendChild(el('span', 'eb-bhint', '1 最先选'));
    box2.appendChild(pr);

    /* 改名 */
    var rn = el('div', 'eb-bigrow');
    rn.appendChild(el('span', 'eb-bl', '改名'));
    var ni = document.createElement('input');
    ni.className = 'eb-txt'; ni.value = bareOf(file);
    rn.appendChild(ni);
    var bR = el('button', 'eb-ok', '改');
    bR.onclick = function () {
      var to = ni.value.trim();
      if (!to || to === bareOf(file)) { toast('名字没变'); return; }
      post('/api/stickers/rename', { from: file, to: to }).then(function (j) {
        if (!j || j.error) { toast('改名失败：' + ((j && j.error) || '')); return; }
        toast('改好了');
        layer.remove();
        reload(box);
      });
    };
    rn.appendChild(bR);
    box2.appendChild(rn);

    var bar = el('div', 'eb-bar');
    var no = el('button', 'eb-no', '关掉');
    no.onclick = function () { layer.remove(); };
    bar.appendChild(no);
    box2.appendChild(bar);

    layer.appendChild(box2);
    layer.onclick = function (e) { if (e.target === layer) layer.remove(); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { layer.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(layer);
  }

  /* 拖图换族：改名到目标叶的主族 */
  function moveFile(file, fromLeaf, toLeaf, box) {
    var fam = (toLeaf.files && toLeaf.files[0]) || toLeaf.name;
    var oldBare = bareOf(file);
    var ext = (String(file).match(/\.[^.]+$/) || ['.jpg'])[0];
    var maxN = 0;
    (BOOK.imgs || []).forEach(function (f) {
      var b = bareOf(f);
      if (b.indexOf(fam) === 0) {
        var n = Number(b.slice(fam.length)) || 0;
        if (n > maxN) maxN = n;
      }
    });
    var to = fam + (maxN + 1);
    if (oldBare === to) { toast('已经在这一族了'); return; }
    post('/api/stickers/rename', { from: file, to: to }).then(function (j) {
      if (!j || j.error) { toast('挪不动：' + ((j && j.error) || '')); return; }
      toast(oldBare + ' → ' + to);
      reload(box);
    });
  }

  /* 外部拖图：上传 → 落到目标叶的族 */
  function uploadFiles(files, leaf, box) {
    var fam = (leaf.files && leaf.files[0]) || leaf.name;
    var arr = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!arr.length) { toast('不是图片'); return; }
    var maxN = 0;
    (BOOK.imgs || []).forEach(function (f) {
      var b = bareOf(f);
      if (b.indexOf(fam) === 0) { var n = Number(b.slice(fam.length)) || 0; if (n > maxN) maxN = n; }
    });
    var i = 0;
    var next = function () {
      if (i >= arr.length) { toast('收了 ' + arr.length + ' 张 → ' + fam); reload(box); return; }
      var f = arr[i++];
      var fr = new FileReader();
      fr.onload = function () {
        maxN++;
        post('/api/stickers/upload', { data: fr.result, name: fam + maxN }).then(function (j) {
          if (!j || !j.ok) toast('存图失败：' + ((j && j.error) || ''));
          next();
        });
      };
      fr.readAsDataURL(f);
    };
    next();
  }

  function prune() {
    /* 叶上重复的词去重（自己/别人分开算） */
    (BOOK.tree.leaves || []).forEach(function (l) {
      ['self', 'other'].forEach(function (k) {
        if (!Array.isArray(l[k])) l[k] = [];
        l[k] = l[k].filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      });
    });
  }

  function reload(box) {
    return load().then(function () { render(box); }).catch(function (e) { toast('读不出来：' + e.message); });
  }

  /* 审一条：没错 / 判错（判错 = 主人改了判定，AI 判错了） */
  function review(t, action, box) {
    post(API + '/review', { t: t, action: action }).then(function (j) {
      if (!j || !j.ok) { toast('存失败：' + ((j && j.error) || '')); return; }
      reload(box);
    });
  }
  /* 判错：选正确的叶（主人改了判定 = 判错） */
  function pickWrong(r, box) {
    var layer = el('div', 'eb-lay');
    var b2 = el('div', 'eb-box');
    b2.appendChild(el('div', 'eb-bt', '这条判错了，正确情绪是？'));
    b2.appendChild(el('div', 'eb-rt2', '原句：「' + String(r.text || '').slice(0, 40) + '」　原判：' + (r.leaf || '?')));
    var sel = document.createElement('select');
    sel.appendChild(new Option('（选正确的叶）', ''));
    (BOOK.tree.leaves || []).forEach(function (l) { if (l.name !== r.leaf) sel.appendChild(new Option(l.name, l.name)); });
    b2.appendChild(sel);
    var bar = el('div', 'eb-bar');
    var ok = el('button', 'eb-ok', '记成判错');
    ok.onclick = function () {
      var v = sel.value;
      if (!v) { toast('先选一个正确的叶'); return; }
      post(API + '/review', { t: r.t, action: 'wrong', leaf: v }).then(function (j) {
        if (!j || !j.ok) { toast('存失败：' + ((j && j.error) || '')); return; }
        layer.remove(); reload(box);
      });
    };
    var no = el('button', 'eb-no', '算了');
    no.onclick = function () { layer.remove(); };
    bar.appendChild(ok); bar.appendChild(no);
    b2.appendChild(bar); layer.appendChild(b2);
    layer.onclick = function (e) { if (e.target === layer) layer.remove(); };
    document.body.appendChild(layer);
  }

  window.EmotionBook = {
    load: load,
    render: function (box) { render(box); },
    mount: function (box) {
      load().then(function () { render(box); }).catch(function (e) {
        box.innerHTML = '';
        box.appendChild(el('div', 'eb-empty', '情绪书读不出来：' + e.message));
      });
    },
  };
})();
