/* ===========================================================================
   头图取色 → 界面主色
   ---------------------------------------------------------------------------
   这是干什么的：她 2026-11-09 定「唯一不改的只有头图，主色应随头图变化」。
   本脚本从头图里提取主色与次色，写成 <html> 上的 --accent / --accent-2。
   白天这套粉色元素（按钮 / 导航计数 / 焦点）会跟着头图变，她 2026-11-09 已认可；
   夜间由 game.css 消费做发光 / 描边 / 选中态。换头图即换主色，
   不用改一句 CSS、也不用提示词。

   为什么走 data: URL：页面是 Electron loadFile 的 file://，头图平时挂在
   xuh://skin/... 自定义协议上；把这种图直接画进 2D canvas 会被判为跨源污染，
   getImageData 抛 SecurityError（上几轮雨背景踩过同一个坑）。主进程把当前
   头图读成 data: URL 再交给页面，data: 同源、不污染画布。

   取色失败（没图 / 图坏 / 画布污染）一律静默保留 game.css 里的兜底粉莓色，
   不抛异常、不打断界面。
   =========================================================================== */
(function () {
  'use strict';

  var SIZE = 40;      // 采样网格，够准且几乎不耗时
  var BINS = 24;      // 色相桶数
  var root = document.documentElement;
  var timer = 0;

  /* ---------- 拿到当前头图的 data: URL ---------- */
  function artUri() {
    // ① 真客户端：主进程按 src/data/ui.json 读当前那张图
    try {
      if (window.xuh && typeof window.xuh.skinData === 'function') {
        var u = window.xuh.skinData();
        if (u) return u;
      }
    } catch (e) { /* 没这条通道就往下走 */ }

    // ② 页面上 #brand-art 此刻挂的那张图。优先读它，换图就能立刻重取色；
    //    只认 data:（同源、不污染画布），xuh:// 这类自定义协议留给 ① 的主进程通道。
    var inline = '';
    try {
      var el = document.getElementById('brand-art');
      var bg = el && el.style.backgroundImage;
      var m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) inline = m[1];
    } catch (e) { /* 忽略 */ }
    if (inline.indexOf('data:') === 0) return inline;

    // ③ 设计预览稿：页面自己注入同一张图的 data:
    if (window.__ART_DATA_URI__) return window.__ART_DATA_URI__;
    return '';
  }

  /* ---------- 颜色换算 ---------- */
  function rgb2hsl(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2, h = 0, s = 0;
    if (d > 0) {
      s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: (h + 1) % 1, s: s, l: l };
  }
  function hsl2rgb(h, s, l) {
    if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
    var q = l < .5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(function (x) {
      return Math.max(0, Math.min(255, Math.round(x * 255)));
    });
  }
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* ---------- 主色提取 ----------
   * 过滤掉近黑（勾线）、近白（背景）、低饱和（灰），剩下的按色相分桶；
   * 面积最大的桶 = 主色，色相离它最远的次大桶 = 次色（当前头图就是粉 + 红）。
   * 最后把亮度拉到深底上能发光的区间、饱和度给下限，避免取出来的是一坨灰粉。 */
  function extract(img) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = SIZE;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, SIZE, SIZE);

    var data;
    try { data = ctx.getImageData(0, 0, SIZE, SIZE).data; }
    catch (e) { return null; }              // 画布被污染：静默兜底

    var bins = [], i;
    for (i = 0; i < BINS; i++) bins.push({ n: 0, hw: 0, sw: 0, lw: 0, w: 0 });
    for (var p = 0; p < data.length; p += 4) {
      var c = rgb2hsl(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255);
      if (c.l < .16 || c.l > .93 || c.s < .13) continue;
      var k = Math.min(BINS - 1, Math.floor(c.h * BINS));
      var w = c.s * (1 - Math.abs(c.l - .55) * .8);   // 饱和、中亮的像素权重更高
      var o = bins[k];
      o.n += 1; o.hw += c.h * w; o.sw += c.s * w; o.lw += c.l * w; o.w += w;
    }

    var ranked = bins.map(function (o, idx) { return { i: idx, o: o }; })
      .filter(function (x) { return x.o.n >= 3 && x.o.w > 0; })
      .sort(function (a, b) { return b.o.n - a.o.n; });
    if (!ranked.length) return null;

    var main = ranked[0];
    var second = null;
    for (i = 1; i < ranked.length; i++) {
      var dist = Math.abs(ranked[i].i - main.i);
      dist = Math.min(dist, BINS - dist);
      if (dist >= 3) { second = ranked[i]; break; }
    }

    function tone(x, loL, hiL, minS) {
      var h = x.o.hw / x.o.w;
      var s = clamp(x.o.sw / x.o.w, minS, .92);
      var l = clamp(x.o.lw / x.o.w, loL, hiL);
      return { rgb: hsl2rgb(h, s, l), h: h, s: s, l: l };
    }
    return {
      main: tone(main, .62, .72, .42),
      second: second ? tone(second, .50, .60, .50) : null
    };
  }

  function setVar(name, value) { root.style.setProperty(name, value); }

  function apply(res) {
    if (!res) return;                        // 保留 game.css 兜底色
    var a = res.main.rgb;
    setVar('--accent', 'rgb(' + a.join(', ') + ')');
    setVar('--accent-rgb', a.join(', '));
    if (res.second) {
      var b = res.second.rgb;
      setVar('--accent-2', 'rgb(' + b.join(', ') + ')');
      setVar('--accent-2-rgb', b.join(', '));
    }
    root.dataset.artAccent = a.join(',');   // 调试可读，不参与样式
  }

  function run() {
    var uri = artUri();
    if (!uri) return;
    var img = new Image();
    img.onload = function () { try { apply(extract(img)); } catch (e) { /* 静默 */ } };
    img.onerror = function () { /* 静默兜底 */ };
    img.src = uri;
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(run, 120); }

  /* 换图入口 paintSkin() 每次都会重写 #brand-art 的 backgroundImage，
     监听它的 style 就能自动跟上，完全不用改 app.js 的业务逻辑。 */
  function watch() {
    var el = document.getElementById('brand-art');
    if (!el || !window.MutationObserver) return;
    new MutationObserver(schedule).observe(el, {
      attributes: true, attributeFilter: ['style']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(); watch(); });
  } else { run(); watch(); }
  // 头图是异步加载的（loadSkin 走 await），补一次，避免开屏第一帧还是兜底色
  setTimeout(run, 600);
})();
