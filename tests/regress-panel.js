// 面板回归测试：导航结构 / 标签只放 md / 话题三页 / 看每个人 / 聊天记录 / 灰底 / 触发地图
const { chromium } = require('C:/Users/user/.workbuddy/binaries/node/workspace/node_modules/playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.url()); });

  const B = process.env.PANEL_URL || 'http://127.0.0.1:8799';
  await page.goto(B, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const out = {};
  const h1 = () => page.$eval('#content h1.pg', h => h.textContent).catch(() => null);
  // 1. 左列结构 + 灰底
  out.navCats = await page.$$eval('#flist .fgroup .gname', ns => ns.map(n => n.textContent.trim()));
  out.folders = await page.$$eval('#flist .fgroup.sub .gname', ns => ns.map(n => n.textContent.trim()));
  out.folderGray = await page.$eval('#flist .fgroup', g => getComputedStyle(g).backgroundColor).catch(() => null);
  // 2. boot 会自动开第一个 md 文件 → 标签条显示、有 1 个标签（功能页不加标签）
  out.tabbarAtBoot = await page.$eval('.tabbar', b => getComputedStyle(b).display !== 'none').catch(() => 'no-tabbar');
  out.tabsAtBoot = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  // 3. 功能页不进标签：点开话题日志 / 看每个人 / 写入日志 / 聊天记录，标签条始终没有
  await page.click('#flist .frow .fname:text("话题日志")');
  await page.waitForTimeout(600);
  out.topicH1 = await h1();
  out.topicChips = await page.$$eval('#content .cbar .cchip', bs => bs.map(b => b.textContent.trim()));
  out.tabsAfterTopic = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  await page.click('#flist .frow .fname:text("看每个人")');
  await page.waitForTimeout(600);
  out.whoH1 = await h1();
  out.whoModes = await page.$$eval('#content .cbar .cchip', bs => bs.map(b => b.textContent.trim()));
  out.tabsAfterWho = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  // 看每个人：切到「只看场所」
  await page.click('#content .cchip:text("只看场所")');
  await page.waitForTimeout(400);
  out.whoScopeH1 = await h1();
  out.whoScopeEmpty = await page.$eval('#content .empty', e => e.textContent.slice(0, 20)).catch(() => null);
  await page.click('#content .cchip:text("只看人物")');
  await page.waitForTimeout(400);
  await page.click('#flist .frow .fname:text("写入日志")');
  await page.waitForTimeout(600);
  out.logH1 = await h1();
  out.tabsAfterLog = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  // 4. 聊天记录页
  await page.click('#flist .frow .fname:text("聊天记录")');
  await page.waitForTimeout(600);
  out.chatH1 = await h1();
  out.chatHasWhoSel = await page.$('#content .cbar select.cnick') !== null;
  // 5. 原文页也不进标签（chat-stars.json）
  await page.click('#flist .frow .fname:text("chat-stars.json")');
  await page.waitForTimeout(600);
  out.rawH1 = await h1();
  out.tabsAfterRaw = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  // 6. 触发地图
  await page.click('#flist .frow .fname:text("触发地图")');
  await page.waitForTimeout(500);
  out.mapH1 = await h1();
  out.mapPaths = await page.$$eval('#content .tmapcard', els => els.length).catch(() => -1);
  // 7. md 文件才进标签：点开「虚幻」→ 出现标签、标签条显示
  await page.click('#flist .frow .fname:text("虚幻")');
  await page.waitForTimeout(600);
  out.soulH1 = await h1();
  out.tabsAfterMd = await page.$$eval('#tabscroll .tab', els => els.length).catch(() => -1);
  out.tabbarShownWithMd = await page.$eval('.tabbar', b => getComputedStyle(b).display !== 'none').catch(() => 'no-tabbar');
  out.tabNames = await page.$$eval('#tabscroll .tab .lb', ns => ns.map(n => n.textContent.trim())).catch(() => []);
  // 8. 状态栏是全局独立条带：任何页面都在（功能页也不能跟着文本框一起藏）
  out.statusInCard = await page.$eval('.composer .card .statusrow', () => true).catch(() => false);
  out.statusRowExists = await page.$('.statusrow') !== null;
  out.composerCardExists = await page.$('.composer .card') !== null;
  out.statusPillCount = await page.$$eval('#statusbar .st', els => els.length).catch(() => -1);
  out.statusPills = await page.$$eval('#statusbar .st', els => els.map(e => e.textContent.trim()));
  // 切到功能页（触发地图，composer 会被藏）——状态栏照样要看得见
  await page.click('#flist .frow .fname:text("触发地图")');
  await page.waitForTimeout(600);
  out.mapH1Again = await h1();
  out.composerHiddenOnMap = await page.$eval('.composer', b => getComputedStyle(b).display === 'none').catch(() => null);
  out.statusVisibleOnMap = await page.$eval('.statusrow', b => {
    const r = b.getBoundingClientRect();
    return getComputedStyle(b).display !== 'none' && r.height > 0 && r.top >= 0;
  }).catch(() => false);
  out.statusPillCountOnMap = await page.$$eval('#statusbar .st', els => els.length).catch(() => -1);
  // 状态栏固定在页面最下层、悬浮最上层；？符号按钮已删
  out.statusbarAtBottom = await page.$eval('.statusrow', b => Math.abs(window.innerHeight - b.getBoundingClientRect().bottom) < 6).catch(() => false);
  out.symhelpGone = await page.$('#symhelp') === null;
  // 9. 话题 / 约定 / 新页面入口
  out.hasTopicsRow = await page.$('#flist .frow .fname:text("话题")') !== null;
  out.hasPromiseRow = await page.$('#flist .frow .fname:text("约定")') !== null;
  out.hasMemesRow = await page.$('#flist .frow .fname:text("网络热梗")') !== null;
  out.hasPolicyRow = await page.$('#flist .frow .fname:text("回复策略")') !== null;
  out.hasFeaturesRow = await page.$('#flist .frow .fname:text("功能日志")') !== null;
  // 10. 热梗页 / 功能日志页真的能打开
  await page.click('#flist .frow .fname:text("网络热梗")');
  await page.waitForTimeout(700);
  out.memesH1 = await h1();
  out.memeCards = await page.$$eval('#content .tcard', els => els.length).catch(() => -1);
  await page.click('#flist .frow .fname:text("功能日志")');
  await page.waitForTimeout(800);
  out.featH1 = await h1();
  out.featCards = await page.$$eval('#content .tcard', els => els.length).catch(() => -1);
  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.log('FATAL ' + e.message); process.exit(1); });
