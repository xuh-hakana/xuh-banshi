'use strict';
/**
 * 命令方块 · 雨夜玻璃（夜晚模式专用）
 * 这是干什么的：调用第三方库 raindrop-fx，在夜晚模式叠一层会流动、会合并、会折射的真实雨珠。
 *
 * 背景 = 官方 demo 的原图（web/img/rain-backdrop.jpg，作者 SardineFish 的示例配图「Ash / 灰」）。
 *   不再程序生成光斑。这张图先由 Image 载入、画进 canvas，再交给库当背景贴图：
 *   走 canvas 这条通道可绕开库的 fetch 路径（库直接收字符串会走 fetch，曾经挂死过）。
 *
 * 层叠：canvas 在最底层当「窗外」（z-index 1），界面在它上面（z-index 2，见 night.css）。
 *   库把背景图当「折射源」：输出里只有雨珠带 alpha，其余透明。所以雨珠浮在窗外、
 *   不遮挡界面；界面面板半透明，能透过面板看见会动的雨。
 *   注意 backgroundBlurSteps 不能为 0 —— 实测为 0 时库整个背景不渲染，画布全空。
 *
 * 鼠标视差：指针移动时画布整体位移（scale 1.32，位移量由调参面板「晃动幅度」控制），
 *   同时把库的 raindropLightPos 跟着指针改，让雨珠高光也移动，不是一张静态图。
 *
 * 可调参数：顶栏「雨」按钮打开面板，6 项（晃动幅度 / 窗口模糊 / 窗口底色 /
 *   窗外亮度 / 雨珠大小 / 雨量）拖动即时生效，存 localStorage，重开还在。
 *   模糊/底色/亮度写 CSS 变量（night.css 按倍率派生到各面板），
 *   晃动幅度写 transform，雨珠大小/雨量写库 options。
 *
 * 接线位置：index.html 末尾两个 script + night.css 的 .rain-fx-* 规则。
 * 回滚方法：删掉 index.html 那两个 script 标签。本脚本不运行 → rain-fx-on 类不出现
 *   → 原先的 CSS 手绘水珠层自动恢复，视觉回到装库前，不留残留。
 *
 * 运行约束：只在夜晚且页面可见时渲染；白天 / 页面隐藏时停止，不占显存。
 *   WebGL2 不可用、库缺失、背景图载入失败或系统要求减少动态效果时，静默回退到 CSS 手绘水珠。
 */

(function () {
  const CLASS_ON = 'rain-fx-on';        // 挂在 <html> 上，作为「真雨已启用」的总开关
  const canvasId = 'rainFxCanvas';
  // 官方 demo 原图（Ash / 灰）。
  // Electron 的 file:// 页面直接用相对路径的 jpg 会污染 2D canvas，库把它传进 WebGL
  // 纹理时被浏览器拒绝，雨一颗都不画。优先拿 preload 从主进程读出的 data: URL（同源、
  // 不污染画布）；拿不到再按协议退回文件/服务路径。空字符串不能喂给 img.src（会挂死）。
  // 夜晚「头图变背景」：优先用左上角头图（left.jpg，主进程转 data:）当雨的窗外折射源，
  // 这样头图在夜里铺满整窗当背景、雨珠浮在头图上；拿不到头图再退回官方 rain-backdrop 原图。
  // skinData / rainBackdrop 都是主进程 sendSync 同步读 src/data/ui.json，不依赖 app.js 的换图时机。
  let dataUri = '';
  try {
    if (window.xuh && typeof window.xuh.skinData === 'function') {
      dataUri = window.xuh.skinData() || '';
    }
  } catch (err) { /* 头图通道不可用就往下走 */ }
  if (!dataUri) {
    try {
      if (window.xuh && typeof window.xuh.rainBackdrop === 'function') {
        dataUri = window.xuh.rainBackdrop() || '';
      }
    } catch (err) { /* 通道不可用就退回路径 */ }
  }
  const BACKDROP_SRC = dataUri || ((location.protocol === 'file:')
    ? 'rain-backdrop.jpg'
    : '/img/rain-backdrop.jpg');

  let canvas = null;
  let fx = null;
  let started = false;             // 动画循环是否已在跑
  let booted = false;              // 实例是否已创建（只建一次，反复切主题不重建纹理）
  let bootFailed = false;          // 失败后不再重试，避免反复报错
  let resizeTimer = 0;
  let closeTunePanel = function () {};   // 由 initTunePanel 覆盖：切到白天时把面板收起来

  let backdrop = null;             // 已铺好原图的 canvas，交给库当背景贴图
  let backdropState = 'idle';      // idle | loading | ready | failed

  // ---------- 可调参数（顶栏「雨」按钮那个面板改的就是这里）----------
  // shift/blur/alpha/lum/drop/flow 六项：前四项与样式挂钩，后两项直接写库参数。
  // blur/alpha/lum 走 CSS 变量（night.css 里按倍率派生到每个面板），其余两项写库 options。
  // rand = 「随机变化」开关，默认 1（开）。其余六项默认值就是出厂观感，不要动。
  const DEFAULTS = { shift: 80, blur: 8, alpha: 26, lum: 50, drop: 45, flow: 240, rand: 1 };
  const STORE_KEY = 'xuh.rain.tune.v1';
  const STORE_VER = 2;             // 存档版本：1 的 rand 默认是关，升到 2 时统一打开一次
  const tune = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    Object.keys(DEFAULTS).forEach((k) => {
      if (typeof saved[k] === 'number' && isFinite(saved[k])) tune[k] = saved[k];
    });
    // 老存档（没有 v 字段，或 v < 2）里「随机」默认是关。改成默认开后，老存档强制打开一次；
    // 之后她自己关掉就记关，不再覆盖。
    if (saved.v !== STORE_VER) tune.rand = 1;
  } catch (err) { /* 存档坏了就用默认值，不影响界面 */ }

  const LERP = 0.12;               // 缓动系数，越小越飘
  // 画布放大倍数 = 视差余量。位移上限 120px（面板最大值），1.32 在 813 高的窗口下
  // 单边留 130px，够；更小的窗口由 updateSafe() 按实际尺寸收紧位移，绝不露边。
  // 注意：位图分辨率也按这个倍数超采样（见 sizeCanvas），否则放大会把雨珠糊掉。
  const SCALE = 1.32;
  let targetX = 0, targetY = 0;    // 指针归一化 -1..1
  let curX = 0, curY = 0;          // 当前插值位置
  let rafId = 0;

  let safeX = 0, safeY = 0;        // 当前视口允许的最大位移，按 SCALE 余量算，防露边

  function isNight() {
    return document.documentElement.dataset.theme === 'night';
  }

  /** 把 tune 落到样式变量与库参数上。滑一下调一次，不重建实例、不重载背景。 */
  function applyTune() {
    const root = document.documentElement.style;
    root.setProperty('--rain-blur', tune.blur + 'px');
    root.setProperty('--rain-alpha', (tune.alpha / 100).toFixed(2));
    root.setProperty('--rain-lum', (tune.lum / 100).toFixed(2));
    if (fx && fx.options) {
      // 库按画布位图给像素尺寸，所以这些值要跟着 SCALE 放大，观感才对得上。
      try {
        fx.options.spawnSize = [
          Math.round(tune.drop * SCALE),
          Math.round(tune.drop * 2.11 * SCALE),
        ];
        fx.options.dropletsPerSeconds = Math.round(tune.flow * SCALE);
      } catch (err) { /* 参数写失败不影响界面 */ }
    }
  }

  function saveTune() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({}, tune, { v: STORE_VER }))); } catch (err) { /* 存不了就算了 */ }
  }

  /**
   * 写光源位置：库原本的左上光 [-1,1,2,0] 为基准 + 指针小偏移 + 随机漂移。
   * 为什么不能直接写成指针位置：指针居中时 [0,0,2,0] 光源正对镜头，
   * 每颗水珠的镜面反射正打进眼睛 → 成片白点。
   */
  function applyLight() {
    if (!fx || !fx.options) return;
    const on = RAND.on ? RAND.cur : null;
    try {
      fx.options.raindropLightPos = [
        -1 + curX * 0.45 + (on ? on.lx : 0),
        1 - curY * 0.45 + (on ? on.ly : 0),
        2, 0,
      ];
    } catch (err) { /* 忽略 */ }
  }

  // ---------- 随机变化：雨珠大小 / 雨量 / 窗口模糊 / 高光位置 自己缓慢起伏 ----------
  // 只改「当下生效的值」，不动 tune 里的基准 —— 关掉时能精确回到你拖的那一档。
  // lx/ly 是光源位置的漂移量，叠加在「左上基准光 + 指针偏移」之上。
  const RAND = {
    on: false,
    raf: 0,
    nextAt: 0,
    last: 0,
    cur: { drop: 45, flow: 240, blur: 8, lx: 0, ly: 0 },
    tgt: { drop: 45, flow: 240, blur: 8, lx: 0, ly: 0 },
  };

  /** 重新挑一组目标值：围绕当前基准上下浮动，再夹进滑杆范围。 */
  function randPick() {
    const jitter = (base, spread, min, max) => {
      const v = base * (1 + (Math.random() * 2 - 1) * spread);
      return Math.max(min, Math.min(max, v));
    };
    RAND.tgt.drop = jitter(tune.drop, 0.34, 20, 140);
    RAND.tgt.flow = jitter(tune.flow, 0.45, 40, 600);
    // 模糊按「基准 ± max(2, 60%)」起伏，所以基准是 0 也能动起来。
    RAND.tgt.blur = Math.max(0, Math.min(20, tune.blur + (Math.random() * 2 - 1) * Math.max(2, tune.blur * 0.6)));
    // 高光漂移：左右各 0.5；纵向只往上 0~0.55。
    // 为什么纵向不给负值：光源越接近镜头正前方（[0,0,z]），镜面反射越正打进眼睛、雨珠越发白，
    // 所以永远保留一个向上的分量，最小仰角时 |光向量| 仍 ≥ 0.5，不会变成白点。
    RAND.tgt.lx = (Math.random() * 2 - 1) * 0.5;
    RAND.tgt.ly = Math.random() * 0.55;
    RAND.nextAt = performance.now() + 1800 + Math.random() * 2000;
  }

  function randFrame(now) {
    if (!RAND.on) { RAND.raf = 0; return; }
    if (now >= RAND.nextAt) randPick();
    // 按真实时间步长缓动，不按帧数 —— 否则掉帧/后台节流时几乎不动，60fps 时又冲得太快。
    // 时间常数 0.9 秒：约 2 秒走到目标九成，配合 1.8~3.8 秒换一次目标，看起来是持续缓慢起伏。
    const dt = Math.min(120, Math.max(0, now - RAND.last)) / 1000;
    RAND.last = now;
    const k = 1 - Math.exp(-dt / 0.9);
    RAND.cur.drop += (RAND.tgt.drop - RAND.cur.drop) * k;
    RAND.cur.flow += (RAND.tgt.flow - RAND.cur.flow) * k;
    RAND.cur.blur += (RAND.tgt.blur - RAND.cur.blur) * k;
    RAND.cur.lx += (RAND.tgt.lx - RAND.cur.lx) * k;
    RAND.cur.ly += (RAND.tgt.ly - RAND.cur.ly) * k;
    if (isNight() && !document.hidden) {
      document.documentElement.style.setProperty('--rain-blur', RAND.cur.blur.toFixed(2) + 'px');
      if (fx && fx.options) {
        try {
          fx.options.spawnSize = [
            Math.round(RAND.cur.drop * SCALE),
            Math.round(RAND.cur.drop * 2.11 * SCALE),
          ];
          fx.options.dropletsPerSeconds = Math.round(RAND.cur.flow * SCALE);
        } catch (err) { /* 忽略 */ }
      }
      applyLight();                     // 高光跟着漂：这里每帧写，指针不动时也会动
    }
    RAND.raf = requestAnimationFrame(randFrame);
  }

  function startRand() {
    if (RAND.on) return;
    RAND.on = true;
    RAND.cur.drop = tune.drop;
    RAND.cur.flow = tune.flow;
    RAND.cur.blur = tune.blur;
    RAND.cur.lx = 0;
    RAND.cur.ly = 0;
    RAND.last = performance.now();
    randPick();
    if (!RAND.raf) RAND.raf = requestAnimationFrame(randFrame);
  }

  function stopRand() {
    RAND.on = false;
    if (RAND.raf) cancelAnimationFrame(RAND.raf);
    RAND.raf = 0;
    RAND.cur.lx = 0;                    // 高光归位到「左上基准 + 指针」，不留随机残值
    RAND.cur.ly = 0;
    applyTune();
    applyLight();
  }

  /**
   * 顶栏「雨」按钮 → 调参面板。
   * 面板节点不存在（被删掉/回滚）时整段跳过，不影响雨本身。
   */
  function initTunePanel() {
    const btn = document.getElementById('rainTuneBtn');
    const panel = document.getElementById('rainTune');
    if (!btn || !panel) return;

    // [滑块 id, 数值 id, tune 键, 单位, 换算：显示值 ← tune 值]
    const rows = [
      ['rtShift', 'rtShiftVal', 'shift', ' px', (v) => String(Math.round(v))],
      ['rtBlur', 'rtBlurVal', 'blur', ' px', (v) => String(Math.round(v))],
      ['rtAlpha', 'rtAlphaVal', 'alpha', ' %', (v) => String(Math.round(v))],
      ['rtLum', 'rtLumVal', 'lum', ' %', (v) => String(Math.round(v))],
      ['rtDrop', 'rtDropVal', 'drop', ' px', (v) => String(Math.round(v))],
      ['rtFlow', 'rtFlowVal', 'flow', '', (v) => String(Math.round(v))],
    ].map(([id, valId, key, unit, fmt]) => ({
      input: document.getElementById(id),
      val: document.getElementById(valId),
      key, unit, fmt,
    })).filter((r) => r.input);

    // 用存下来的值初始化滑块位置与数字
    rows.forEach((r) => {
      r.input.value = String(tune[r.key]);
      if (r.val) r.val.textContent = r.fmt(tune[r.key]) + r.unit;
    });

    let saveTimer = 0;
    function changed(r) {
      const v = Number(r.input.value);
      if (!isFinite(v)) return;
      tune[r.key] = v;
      if (r.val) r.val.textContent = r.fmt(v) + r.unit;
      applyTune();
      // 随机开着时，你要拖的这三项会被下一帧的随机值覆盖、看起来像拖不动。
      // 所以把随机的当前值/目标值同步成你拖到的新值，并推迟 3 秒再起伏。
      if (RAND.on && (r.key === 'blur' || r.key === 'drop' || r.key === 'flow')) {
        RAND.cur[r.key] = v;
        RAND.tgt[r.key] = v;
        RAND.nextAt = performance.now() + 3000;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveTune, 220);
    }
    rows.forEach((r) => r.input.addEventListener('input', () => changed(r)));

    function place() {
      const rect = btn.getBoundingClientRect();
      const w = panel.offsetWidth || 302;
      const h = panel.offsetHeight || 300;
      let left = rect.right - w;                        // 右对齐按钮，贴近「皮肤」那一排
      left = Math.max(8, Math.min(left, (window.innerWidth || w) - w - 8));
      let top = rect.bottom + 8;
      if (top + h > (window.innerHeight || 800) - 8) top = Math.max(8, rect.top - h - 8);
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
    }

    function open() {
      panel.classList.add('is-open');
      btn.classList.add('is-active');
      btn.setAttribute('aria-expanded', 'true');
      place();
      /* 2026-11-14：面板改成可拖动（app.js 的浮窗系统）。
       * place() 只是「没拖过」时的默认位；拖过就把存下来的位置盖回去，
       * 不然每次打开都会跳回按钮旁边、把她拖的位置冲掉。 */
      if (typeof window.floatWinApply === 'function') window.floatWinApply(panel);
      applyTune();                                     // 打开就同步一次，防止别处改过
    }
    function close() {
      panel.classList.remove('is-open');
      btn.classList.remove('is-active');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggle() {
      if (panel.classList.contains('is-open')) close();
      else open();
    }
    closeTunePanel = close;          // 让 sync() 在切白天时能收面板

    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    // 点面板内部不关；点任何别处关。用 pointerdown 更及时。
    document.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('is-open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) close();
    });
    window.addEventListener('resize', () => {
      if (panel.classList.contains('is-open')) place();
    }, { passive: true });

    // ---- 随机变化开关（雨珠大小 / 雨量 / 窗口模糊 自己起伏）----
    const randBtn = document.getElementById('rtRand');
    const randVal = document.getElementById('rtRandVal');
    function paintRand() {
      const on = !!tune.rand;
      if (randVal) randVal.textContent = on ? '开' : '关';
      if (randBtn) {
        randBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        randBtn.classList.toggle('is-on', on);
      }
    }
    if (randBtn) {
      randBtn.addEventListener('click', () => {
        tune.rand = tune.rand ? 0 : 1;
        paintRand();
        if (tune.rand) startRand(); else stopRand();
        saveTune();
      });
    }
    paintRand();
    if (tune.rand) startRand();          // 上次开着，这次进来继续

    const reset = document.getElementById('rtReset');
    if (reset) {
      reset.addEventListener('click', () => {
        Object.assign(tune, DEFAULTS);
        rows.forEach((r) => {
          r.input.value = String(tune[r.key]);
          if (r.val) r.val.textContent = r.fmt(tune[r.key]) + r.unit;
        });
        paintRand();
        // 出厂状态就是「随机开」，所以恢复默认后随机继续开，并把起伏基准换成新的默认值。
        RAND.cur.drop = tune.drop;
        RAND.cur.flow = tune.flow;
        RAND.cur.blur = tune.blur;
        RAND.cur.lx = 0;
        RAND.cur.ly = 0;
        if (tune.rand) { if (RAND.on) randPick(); else startRand(); }
        applyTune();
        saveTune();
      });
    }
    const closeBtn = document.getElementById('rtClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * 画布位图按 SCALE 超采样：CSS 里再放大 SCALE 倍铺满视口。
   * 这样位移时是「位图原始像素 1:1」，雨珠不会被插值糊掉。
   */
  function sizeCanvas() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const rw = Math.round(w * SCALE);
    const rh = Math.round(h * SCALE);
    canvas.width = rw;
    canvas.height = rh;
    // 位移上限：画布比视口大出的那部分的一半，再留 2px 余量 —— 永远不会露出边界。
    safeX = Math.max(0, (rw - w) / 2 - 2);
    safeY = Math.max(0, (rh - h) / 2 - 2);
    return { rw, rh };
  }

  /**
   * 把原图按 cover 铺进一张半分辨率 canvas（雨珠折射本身是模糊的，省显存）。
   * 宽高比跟随当前视口，避免拉伸变形；多出来的部分居中裁掉。
   */
  function drawCover(img) {
    const W = 1400;
    const vw = window.innerWidth || 1440;
    const vh = window.innerHeight || 813;
    const H = Math.max(1, Math.round(W * vh / vw));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#05070c';           // 裁切外的余量填夜色底，不是死黑
    g.fillRect(0, 0, W, H);
    const s = Math.max(W / img.width, H / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    // 不压暗背景：库把这张图当「折射源」，雨珠亮度直接取决于它。
    // 压暗背景 = 压暗雨珠，反而看不见雨。整体暗度交给 CSS 与界面面板控制。
    return c;
  }

  /** 载入官方原图；就绪后重新 sync 一次，让正在等待的夜晚模式立刻启动。 */
  function loadBackdrop() {
    if (backdropState !== 'idle') return;
    backdropState = 'loading';
    const img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      try {
        backdrop = drawCover(img);
        backdropState = 'ready';
      } catch (err) {
        backdropState = 'failed';
      }
      sync();
    };
    img.onerror = function () {
      backdropState = 'failed';
      sync();
    };
    img.src = BACKDROP_SRC;
  }

  /** 创建唯一实例；除背景外全用库默认参数。失败返回 false，交给调用方静默回退。 */
  function boot() {
    if (booted) return !bootFailed;
    if (bootFailed || typeof window.RaindropFX !== 'function' || reducedMotion()) return false;
    // 背景图载入失败 = 这个库没法用（它强制要背景），直接回退 CSS 手绘水珠。
    if (backdropState === 'failed') { bootFailed = true; return false; }
    // 还在载入：先不建实例，等 onload 回调里的 sync()。
    if (backdropState !== 'ready' || !backdrop) return false;

    booted = true;
    try {
      canvas = document.getElementById(canvasId);
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = canvasId;
        canvas.className = 'rain-fx-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        document.body.appendChild(canvas);
      }
      sizeCanvas();
      fx = new window.RaindropFX({
        canvas: canvas,
        background: backdrop,
        // 关掉库那层不透明暗雾：留着会被 screen 叠成一整片灰、糊住文字。
        mist: false,
        backgroundBlurSteps: 2,
        // 雨量足、会滑落会合并；尺寸与生成率随 SCALE 同步放大，换分辨率观感不变。
        // 这三项由调参面板驱动（drop = 雨珠直径，flow = 每秒生成数）。
        spawnInterval: [0.18, 0.45],
        spawnSize: [Math.round(tune.drop * SCALE), Math.round(tune.drop * 2.11 * SCALE)],
        spawnLimit: 600,
        dropletsPerSeconds: Math.round(tune.flow * SCALE),
        gravity: Math.round(1800 * SCALE),
        // 光照（README 推荐区间）：雨珠要自己够亮，因为窗外背景是压暗的；
        // shadowOffset 拉高把暗边做实，浅色背景上的雨珠才有体积感。
        raindropLightPos: [-1, 1, 2, 0],
        raindropDiffuseLight: [0.62, 0.63, 0.72],
        raindropShadowOffset: 0.78,
        raindropSpecularLight: [0.80, 0.82, 0.94],
        raindropSpecularShininess: 150,
        raindropLightBump: 0.55,
        // 折射强度：稍强一点，雨珠内部的窗外景物才翻得动。
        refractBase: 0.45,
        refractScale: 0.65,
      });
      return true;
    } catch (err) {
      bootFailed = true;
      fx = null;
      // 静默回退：不打日志、不弹窗，CSS 手绘水珠保持显示。
      document.documentElement.classList.remove(CLASS_ON);
      return false;
    }
  }

  function start() {
    if (!isNight() || document.hidden || bootFailed) return;
    if (!boot()) return;
    if (started) return;
    started = true;
    try {
      Promise.resolve(fx.start()).catch(() => {
        started = false;
        document.documentElement.classList.remove(CLASS_ON);
      });
      document.documentElement.classList.add(CLASS_ON);
    } catch (err) {
      started = false;
      document.documentElement.classList.remove(CLASS_ON);
    }
  }

  function stop() {
    if (fx && started) {
      try { fx.stop(); } catch (err) { /* 已停止 */ }
    }
    started = false;
    document.documentElement.classList.remove(CLASS_ON);
  }

  /** 主题切换 / 页面可见性变化 / 背景图就绪：决定启停。 */
  function sync() {
    const live = isNight() && !document.hidden;
    if (live) start();
    else {
      stop();
      closeTunePanel();              // 雨只在夜晚：切白天顺手把参数面板收掉
    }
    // 随机起伏也只在夜晚跑帧，白天/后台不占 CPU
    if (live) {
      if (RAND.on && !RAND.raf) { RAND.last = performance.now(); RAND.raf = requestAnimationFrame(randFrame); }
    } else if (RAND.raf) {
      cancelAnimationFrame(RAND.raf);
      RAND.raf = 0;
    }
  }

  function onResize() {
    if (!fx || !isNight()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const { rw, rh } = sizeCanvas();
      try { fx.resize(rw, rh); } catch (err) { /* 尺寸变化失败不影响界面 */ }
    }, 180);
  }

  /** 视差动画：缓动逼近指针位置，再应用到背景位移与雨珠光照方向。收敛后自动停帧。 */
  function parallaxTick() {
    rafId = 0;
    curX += (targetX - curX) * LERP;
    curY += (targetY - curY) * LERP;
    if (canvas) {
      // 反向位移：指针往右，窗外景物往左退一点，是「人在窗前看外面」的视差感。
      // 先按安全上限夹住，再除以 SCALE —— transform 里的位移会被 scale 放大，
      // 除回来之后 tune.shift 就是「屏幕上真实移动多少像素」，面板里的数值所见即所得。
      const dx = Math.max(-safeX, Math.min(safeX, -curX * tune.shift));
      const dy = Math.max(-safeY, Math.min(safeY, -curY * tune.shift));
      canvas.style.transform = 'scale(' + SCALE + ') translate3d(' +
        (dx / SCALE).toFixed(2) + 'px, ' + (dy / SCALE).toFixed(2) + 'px, 0)';
    }
    // 光照：基准左上 + 指针小幅偏移 + 随机漂移，统一由 applyLight 写。
    applyLight();
    if (Math.abs(targetX - curX) > 0.0015 || Math.abs(targetY - curY) > 0.0015) {
      rafId = requestAnimationFrame(parallaxTick);
    }
  }

  function onPointerMove(e) {
    if (!isNight() || document.hidden) return;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    targetX = (e.clientX / w) * 2 - 1;
    targetY = (e.clientY / h) * 2 - 1;
    if (!rafId) rafId = requestAnimationFrame(parallaxTick);
  }

  // 主题由 app.js 的 applyTheme() 改 html[data-theme]；用观察器跟随，不去改 app.js。
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  // 先把存下来的参数落到样式上（避免开屏闪一下默认值），再接面板。
  applyTune();
  initTunePanel();

  // 真机验收用：只在 URL 带 ?raindbg=1 时暴露只读快照，正常使用没有这个全局。
  if (/[?&]raindbg=1/.test(location.search)) {
    window.__rainDebug = function () {
      return {
        rand: RAND.on,
        light: fx && fx.options ? fx.options.raindropLightPos.slice() : null,
        drop: RAND.cur.drop,
        flow: RAND.cur.flow,
        blur: RAND.cur.blur,
        curX: curX,
        curY: curY,
      };
    };
  }

  // 先载背景图；就绪回调里会 sync 一次。初始再同步一次兜住「载入很快」的情况。
  loadBackdrop();
  sync();
})();
