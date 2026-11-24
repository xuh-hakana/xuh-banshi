'use strict';
/* ===========================================================================
 * roco-bili.js —— 稀有商品轮次：去 B站给「刚发的洛克王国视频」留提醒（2026-11-21 主人定）
 *
 * 主人原话：「抓到祝福项坠轮次时，虚幻去b站翻1小时前2小时后刚发的所有洛克王国视频，
 *   用从新到旧的顺序在评论区发提醒，评论区不需要@任何人。注意频率健康，不要触发风控。」
 * 后续更正（同一天）：「不是祝福项链，是祝福项坠」「b站和QQ再都加上棱镜球」「b站也加上炫彩蛋」
 *   「稀有度是棱镜球、祝福项坠、炫彩蛋。根据这个排名。动态算每天的提醒额度」
 *   「一天已经发了十次稀有的，就不在下一轮发炫彩蛋这种不稀有的」
 *   「如果一天发了炫彩蛋这种不稀有的，下次就要突破限制再发棱镜球、祝福项坠」
 *   「发送数量有限，所以优先找up主粉丝数过万、up其他视频过万的」
 *
 * 触发：roco-merchant 的那一轮命中 棱镜球/祝福项坠/炫彩蛋 → arm()。同一个轮次只 arm 一次（状态落盘）。
 * 窗口：触发时刻 T 的 [T-1h, T+2h]。窗口内每 scanGapSec 扫一次搜索结果，
 *       只看这段时间新发布/刚发布的视频，按发布时间从新到旧评论，发过的不再发。
 *
 * 额度（按稀有度，见 src/roco-rarity.js）：
 *   · 稀有（棱镜球 3、祝福项坠 2）：每天 maxRarePerDay 条（默认 10），**不受 maxPerDay 总额限制**——
 *     当天发过炫彩蛋这种普通的，轮到棱镜球照样发，这就是主人说的「突破限制」。
 *   · 普通（炫彩蛋 1）：只有在「今天稀有还没发满」时才发，且吃 maxPerDay 总额——
 *     稀有发满 10 条之后，这一轮是炫彩蛋就一条都不发（主人原话第 4 条）。
 *   · 上限对比：最坏情况一天 10 稀有 + 10 普通 = 20 条，仍低于资料里「一天 >24 条有明显反垃圾识别」的线。
 *
 * 挑哪些 UP（主人原话第 5 条「发送数量有限，所以优先找up主粉丝数过万、up其他视频过万的」）：
 *   A = 粉丝 ≥1万 且 该 UP 其他视频有 ≥1万播放；B = 两者任一；C = 都不满足。
 *   默认 minTier=B（C 不发，省额度），面板能改成 C（不筛）。每个 UP 的粉丝/播放缓存 24 小时。
 *   注：QQ 群里的 @ 提醒不走这条筛选（主人：「QQ不限制这个」）。
 *
 * 为什么这么保守（都是查来的，不是我拍的）：
 *   · 掘金《B站评论助手》作者实测：评论间隔 1~2 分钟随机，建议每天不超过 10 条；
 *     风控码 12045/12008/12002 立即停任务；同 IP 读接口 >30 次/分钟 → 验证码或 -412。
 *   · B站后端错误码（bilibili-go-code）：12014=CD 时间未到不能评论、
 *     12023=短时间内发重复评论、12040=一段时间内相似内容出现过多、
 *     12027=评论进入待审、12028=大数据垃圾评论、12053=达到当前评论发送上限、
 *     -509=请求过于频繁、-412=IP 被封。→ 所以「间隔拉长 + 文案必须各不相同 + 撞到就停」。
 *   · dsh-bili-pond / dsh-bili-interactor：一天 >24 条、每轮 >5 条就有明显反垃圾识别；
 *     code=0 只代表 B站 收下了，新号/短时间大量评论会被折叠或送审（不是发失败，是别人看不到）。
 *   于是默认：间隔 150~240 秒（比 1~2 分钟更宽松）、每轮 ≤10 条、每天 ≤10 条、
 *   每条文案都由模型现写并过一遍校验（不重复、不带链接、不带 @、不提关注三连）。
 *
 * 不做的事：不 @ 任何人、不放链接、不要求关注/点赞、不评论自己的视频、同一条视频只评一次。
 *
 * 标签硬判据（2026-11-21 主人定，同日修正一次）：
 *   原话：「带『洛克王国：世界』手游标签才行，避免发到『洛克王国』页游。」
 *   再修正：「『洛克王国世界激励计划』不能当判据…是可以算的。很多人只带着一个tag。
 *          加上粉丝限制就不容易错了。」
 *   实测（tag/archive/tags，2026-11-21 23:5x 真拉）：
 *     · 手游强判据：「洛克王国：世界」(58217058)、「洛克王国世界」(58215801)
 *     · 弱判据：「洛克王国世界激励计划」——很多人只挂这一个；但页游系别赛、蹭流量的
 *       韩剧/steam 视频也挂，所以**必须再砌一道粉丝门槛**（UP 粉丝 ≥1万）才认。
 *       实测同一条搜索结果里：半块培根 2.1万粉挂激励计划 → 认；屮艸芔茻四连 237 粉 → 不认。
 *     · 页游：「洛克王国」(124135)、「洛克王国页游」(23507557)、「页游洛克王国」(35450110)
 *       带「页游」字样的 tag 一律不发；弱判据那条再加一道标题/简介软黑名单（页游/系别赛/网页版）。
 *   注意 B站 同名 tag 会有多个 id（激励计划实测 1330131 和 74360940 并存），所以按**名字**判，不按 id。
 *
 * 被回复 → 录人物表（2026-11-21 主人问「被回复后把对方录入人物表的功能在吗」）：
 *   原来没有，这次补上。自己评论过的楼，定时拉楼中楼，回复者（B站 mid）走
 *   people.ensure('bili', mid, {nick}) 建档；已存在的只补昵称，不新建、不覆盖已有名字。
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const biliApi = require('./bili-api');
const biliSpace = require('./bili-space');
const configStore = require('./config');
const core = require('./core');
const people = require('./people');
const masterExamples = require('./master-examples');   // 主人例句（只取 why 当思路，原句不进 prompt，防照抄）
const humanVoice = require('./human-voice');            // 人类逻辑：真实对话对，学口气
const replyEngine = require('./reply-engine');          // 两层回话：人类逻辑 → 虚幻逻辑（无兜底）   // 主人例句（2026-11-22，学撩人的劲，不照抄）
const rocoRarity = require('./roco-rarity');   // 稀有度排名（棱镜球 > 祝福项坠 > 炫彩蛋），额度按它分账

const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'roco-bili-state.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 给模型调用套一层超时：模型 429 / 备用链超时会让一次 tick 卡 2 分钟，
 * 文案和回评都不值得等 —— 超时就回落模板/兜底句（2026-11-22）。 */
function withTimeout(p, ms) {
  p.catch(() => {});
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms)),
  ]);
}
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rand = (a, b) => a + Math.floor(Math.random() * Math.max(1, b - a + 1));

function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; } }
function writeState(o) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { console.log('[B站提醒] 状态写不进：' + e.message); }
}

function cfgs() {
  const c = (configStore.cfgLive().rocoBili) || {};
  return {
    enabled: c.enabled !== false,
    keyword: String(c.keyword || '洛克王国').trim(),
    // 2026-11-21 主人定：B站 也盯这三样（稀有度 棱镜球 > 祝福项坠 > 炫彩蛋）
    triggerItems: Array.isArray(c.triggerItems) && c.triggerItems.length ? c.triggerItems : ['棱镜球', '祝福项坠', '炫彩蛋'],
    windowBeforeMin: Math.max(0, num(c.windowBeforeMin, 60)),
    // 2026-11-22 主人定：一轮 4 小时，只在前 3.5 小时内发（后半小时不追，快刷新了没意义）
    windowAfterMin: Math.max(5, num(c.windowAfterMin, 210)),
    // 前 2 小时只发「过万 UP」；之后到 3.5 小时放开到小 UP，把额度花满
    bigUpUntilMin: Math.max(5, num(c.bigUpUntilMin, 120)),
    lateAllowC: c.lateAllowC !== false,
    scanGapSec: Math.max(120, num(c.scanGapSec, 420)),
    gapSecMin: Math.max(60, num(c.gapSecMin, 150)),
    gapSecMax: Math.max(60, num(c.gapSecMax, 240)),
    maxPerRound: Math.max(1, Math.min(30, num(c.maxPerRound, 10))),
    maxPerDay: Math.max(1, Math.min(30, num(c.maxPerDay, 10))),
    maxPerScan: Math.max(1, Math.min(5, num(c.maxPerScan, 2))),
    searchPages: Math.max(1, Math.min(3, num(c.searchPages, 2))),
    useModel: c.useModel === true,   // 默认模板（2026-11-22：模型慢/会漏商品/会造丑颜文字）
    // 每日额度按稀有度分账（2026-11-21）：稀有独立额度，普通只在「稀有还没发满」时才发
    maxRarePerDay: Math.max(1, Math.min(30, num(c.maxRarePerDay, 10))),
    commonOnlyWhenRareLeft: c.commonOnlyWhenRareLeft !== false,
    // 标签判据（2026-11-21）：手游白名单 + 页游黑名单，都按 tag 名判
    mobileTags: (Array.isArray(c.mobileTags) && c.mobileTags.length ? c.mobileTags : ['洛克王国：世界', '洛克王国世界'])
      .map(x => String(x || '').trim()).filter(Boolean),
    // 弱判据（2026-11-21 修正）：「洛克王国世界激励计划」可以算，但必须叠粉丝门槛
    weakTags: (Array.isArray(c.weakTags) ? c.weakTags : ['洛克王国世界激励计划'])
      .map(x => String(x || '').trim()).filter(Boolean),
    weakTagFansMin: Math.max(0, num(c.weakTagFansMin, 10000)),
    weakTagEnabled: c.weakTagEnabled !== false,
    softBlockWords: (Array.isArray(c.softBlockWords) && c.softBlockWords.length ? c.softBlockWords : ['页游', '系别赛', '网页版'])
      .map(x => String(x || '').trim()).filter(Boolean),
    blockTagWords: (Array.isArray(c.blockTagWords) && c.blockTagWords.length ? c.blockTagWords : ['页游'])
      .map(x => String(x || '').trim()).filter(Boolean),
    tagCheckPerTick: Math.max(1, Math.min(20, num(c.tagCheckPerTick, 8))),
    tagCacheHours: Math.max(1, num(c.tagCacheHours, 12)),
    // 挑 UP：粉丝/其他视频播放过万的优先（主人 2026-11-21 定），QQ 那条线不筛
    preferFansMin: Math.max(0, num(c.preferFansMin, 10000)),
    preferPlayMin: Math.max(0, num(c.preferPlayMin, 10000)),
    minTier: ['A', 'B', 'C'].indexOf(String(c.minTier || 'B').toUpperCase()) >= 0 ? String(c.minTier || 'B').toUpperCase() : 'B',
    upCacheHours: Math.max(1, num(c.upCacheHours, 24)),
    upCheckPerTick: Math.max(1, Math.min(20, num(c.upCheckPerTick, 8))),
    // 被回复 → 录人物表 + 回一句（2026-11-22 主人定：高频问题要有人味地回）
    recordRepliers: c.recordRepliers !== false,
    replyPollMin: Math.max(3, num(c.replyPollMin, 10)),
    replyWatchHours: Math.max(2, num(c.replyWatchHours, 48)),
    replyEnabled: c.replyEnabled !== false,
    replyMaxPerPoll: Math.max(0, Math.min(3, num(c.replyMaxPerPoll, 1))),
    replyMaxPerDay: Math.max(0, Math.min(30, num(c.replyMaxPerDay, 8))),
    replyGapSec: Math.max(120, num(c.replyGapSec, 300)),
    replyUseModel: c.replyUseModel !== false,
    masterBiliMid: String(c.masterBiliMid || '30895294'),
    masterBiliName: String(c.masterBiliName || '虚幻的生物'),
    replyAtMaster: c.replyAtMaster !== false,
  };
}

function beijingDay(ms) {
  const d = new Date((ms || Date.now()) + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* '2026-11-22 08:00:00'（北京时间）→ 毫秒。解析不出来返回 0，调用方退回「从现在算」。 */
function beijingMs(s) {
  const m = String(s || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}

/* '2026-11-22 08:00:00' → '8点'（整点），非整点 → '8点30分'。文案里用「8点到12点」。 */
function hourLabel(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  return mi ? h + '点' + mi + '分' : h + '点';
}

/* ---------- 搜索结果 ---------- */
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .trim();
}

async function searchVideos(keyword, pages) {
  const c = biliSpace.creds();
  if (!c.cookie) throw Object.assign(new Error('没有 B站登录态'), { code: -101 });
  const keys = await biliSpace._keys();
  const out = [];
  for (let pn = 1; pn <= pages; pn++) {
    const qs = biliSpace._sign({
      search_type: 'video', keyword, order: 'pubdate',
      page: pn, page_size: 30, platform: 'pc', web_location: 1430654,
    }, keys);
    const r = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?' + qs, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(keyword),
        Cookie: c.cookie + (c.buvid || ''),
      },
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (j.code !== 0) throw Object.assign(new Error('搜索返回 ' + j.code + '：' + (j.message || '')), { code: j.code, http: r.status });
    for (const v of ((j.data && j.data.result) || [])) {
      if (!v || v.type !== 'video' || !v.bvid) continue;
      out.push({
        bvid: String(v.bvid), aid: Number(v.aid) || 0,
        title: stripHtml(v.title), author: String(v.author || ''),
        mid: String(v.mid || ''), desc: stripHtml(v.description || '').slice(0, 120),
        pubMs: (Number(v.pubdate) || 0) * 1000,
        play: Number(v.play) || 0,
        typeid: Number(v.typeid) || 0, typename: String(v.typename || ''),
      });
    }
    if (pn < pages) await sleep(900 + Math.random() * 900);   // 读接口也留间隔，别贴 30 次/分钟
  }
  return out;
}

/* 分区必须真的是游戏内容（2026-11-21 实测发现）：有人把韩剧、娱乐视频也挂上
 * 「洛克王国世界」tag 蹭流量（实测 241 娱乐杂谈那条韩剧就带手游 tag），
 * 只判 tag 会把评论发到韩剧评论区 —— 那是真垃圾评论，会被举报。
 * 手游视频实测都在 172 手机游戏 / 65 网络游戏 / 17 单机游戏。
 * 分不清是不是游戏的（日常/生活这种混合区）宁可不发。 */
const GAME_TYPEIDS = new Set([4, 17, 65, 121, 136, 171, 172, 173]);
function isGameType(v) {
  if (!v) return false;
  if (/游戏|电竞/.test(String(v.typename || ''))) return true;
  return GAME_TYPEIDS.has(Number(v.typeid) || 0);
}

/* 标题里像不像洛克圈子——只用于日志和面板展示，**不再当发放判据**：
 * 手游视频标题经常只写「异色炫彩遁地鼠」「命定花种速刷」，不带「洛克王国」，
 * 用标题卡会漏；反过来「洛克」两字又会带进别的东西。判据统一交给 tag。 */
function looksRoco(v) {
  const hay = (v.title || '') + ' ' + (v.desc || '');
  return /洛克王国|洛克|你洛|远行商人|炫彩蛋|棱镜球|祝福项坠/.test(hay);
}

/* ---------- 标签判据（2026-11-21 主人定：只发手游，别发到页游） ---------- */
// 全角冒号/空格/大小写归一，B站 tag 名里全角冒号很常见
function normTag(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[：]/g, ':').trim();
}

async function fetchTags(bvid) {
  const c = biliSpace.creds();
  if (!c.cookie) throw Object.assign(new Error('没有 B站登录态'), { code: -101 });
  const r = await fetch('https://api.bilibili.com/x/tag/archive/tags?bvid=' + encodeURIComponent(bvid), {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.bilibili.com/video/' + bvid,
      Cookie: c.cookie + (c.buvid || ''),
    },
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (j.code !== 0) throw Object.assign(new Error('标签接口返回 ' + j.code + '：' + (j.message || '')), { code: j.code, http: r.status });
  return (Array.isArray(j.data) ? j.data : []).map(x => String((x && x.tag_name) || '')).filter(Boolean);
}

/* 只看 tag 的判定 → {level, hit, why, tags}
 *   strong = 手游白名单精确命中（「洛克王国：世界」「洛克王国世界」）→ 直接发
 *   weak   = 只挂了「洛克王国世界激励计划」这类弱判据 → 还要叠 UP 粉丝门槛才能定（见 judgeWithUp）
 *   none   = 没有可用的 tag（含：带「页游」字样）
 * 为什么把弱判据拆出来：判它要查 UP 粉丝，一次 HTTP，不能放在纯函数里。 */
function judgeTags(names, c) {
  const cfg = c || cfgs();
  const list = (names || []).map(normTag).filter(Boolean);
  const white = cfg.mobileTags.map(normTag);
  // 注意「网页游戏」里正好连着「页游」两个字，不是页游标签（实测踩到），比之前先剔掉
  const blocked = list.find(n => {
    const t = n.replace(/网页游戏/g, '');
    return cfg.blockTagWords.some(w => t.indexOf(normTag(w)) >= 0);
  });
  if (blocked) return { hit: false, level: 'none', why: '带页游标签「' + blocked + '」', tags: names || [] };
  const got = list.find(n => white.indexOf(n) >= 0);
  if (got) return { hit: true, level: 'strong', why: '手游标签「' + got + '」', tags: names || [] };
  if (cfg.weakTagEnabled !== false) {
    const weakList = (cfg.weakTags || []).map(normTag);
    const w = list.find(n => weakList.indexOf(n) >= 0);
    if (w) return { hit: false, level: 'weak', weakTag: w, why: '只挂了「' + w + '」，要叠粉丝门槛', tags: names || [] };
  }
  return { hit: false, level: 'none', why: '没有手游标签', tags: names || [] };
}

/* tag 判定 + UP 数据 → 最终发不发。
 * 强判据直接发（tag 名精确，实测没串过）；弱判据要三件事同时成立：
 *   ① UP 粉丝 ≥ weakTagFansMin（默认 1 万，主人 2026-11-21 定的「加上粉丝限制就不容易错了」）
 *   ② 标题/简介里没有页游字样（页游系别赛视频也挂激励计划，实测过）
 *   ③ 分区真是游戏（外面 pool 已经筛过）
 * 实测支撑：半块培根 21440 粉 / 28 条过万播放，挂激励计划 → 认；
 *          屮艸芔茻四连 237 粉、云朵吖h 536 粉 → 不认。 */
function judgeWithUp(v, jd, up, c) {
  const cfg = c || cfgs();
  if (!jd) return { hit: false, level: 'none', why: '没查标签' };
  if (jd.level === 'strong' || (jd.hit && jd.level !== 'weak')) return Object.assign({}, jd, { hit: true });
  if (jd.level !== 'weak') return Object.assign({}, jd, { hit: false });
  const hay = String((v && v.title) || '') + ' ' + String((v && v.desc) || '');
  const bad = (cfg.softBlockWords || []).find(w => w && hay.indexOf(w) >= 0);
  if (bad) return Object.assign({}, jd, { hit: false, why: '只有「' + jd.weakTag + '」，但标题/简介带「' + bad + '」（像页游，不发）' });
  const fans = Number(up && up.fans) || 0;
  if (fans < cfg.weakTagFansMin) {
    return Object.assign({}, jd, { hit: false, why: '只有「' + jd.weakTag + '」，UP 粉丝 ' + fans + ' 不到 ' + cfg.weakTagFansMin + '（不认弱判据）' });
  }
  return Object.assign({}, jd, { hit: true, why: '「' + jd.weakTag + '」+ UP 粉丝 ' + fans + '（弱判据成立）' });
}

/* UP 数据：粉丝数 + 该 UP 其他视频的播放（用来排 A/B/C 三档，见文件头）。
 * 两次读接口（card + 空间视频列表），每个 mid 缓存 upCacheHours 小时，缓存放状态文件里跨重启。 */
async function upStats(mid, bvid, c) {
  const cfg = c || cfgs();
  const key = String(mid || '');
  if (!key) return { fans: 0, maxPlay: 0, over: 0, n: 0, at: 0 };
  let j = null;
  try { j = await biliSpace.profile(key); } catch { j = null; }   // 内部也缓存 1 小时
  const fans = Number(j && j.fans) || 0;
  let maxPlay = 0, over = 0, n = 0;
  try {
    const vs = await biliSpace.videos(key, 1);
    const others = vs.filter(x => x && x.id !== bvid);
    n = others.length;
    for (const x of others) {
      const p = Number(x.play) || 0;
      if (p > maxPlay) maxPlay = p;
      if (p >= cfg.preferPlayMin) over++;
    }
  } catch { /* 空间关了就只看粉丝，别把整跳搞挂 */ }
  return { fans, maxPlay, over, n, at: Date.now() };
}

/* 三档：A = 粉丝过万且其他视频过万；B = 任一；C = 都不满足。 */
function tierOf(up, c) {
  const cfg = c || cfgs();
  const f = Number(up && up.fans) || 0;
  const p = Number(up && up.maxPlay) || 0;
  const fOk = f >= cfg.preferFansMin, pOk = p >= cfg.preferPlayMin;
  if (fOk && pOk) return 'A';
  if (fOk || pOk) return 'B';
  return 'C';
}
const TIER_RANK = { A: 0, B: 1, C: 2 };

/* ---------- 文案 ---------- */
/* 2026-11-22 主人定：「几点到几点的x，记得换+可爱的颜文字」「要有对话的感觉」
 *              「一轮命中几样时…应该全写，又不费啥」「发送时不要讲话像 AI」。
 *
 * 所以文案由三块拼：时间（这一轮 8点到12点）+ 全部命中的商品（棱镜球、祝福项坠）+ 颜文字。
 * 模板只做兜底（模型限流/没 Key 时用）；正常走模型，但**一次生成一批**，
 * 不再一条评论一次请求（原来 10 条评论 = 10 次 LLM，纯粹费 token 费 CPU）。 */
const KAOMOJI = ['(๑•̀ㅂ•́)و✧', '٩(๑>◡<๑)۶', '(≧▽≦)', '(๑´ㅂ`๑)', '(｡･ω･｡)ﾉ', '(๑>؂<๑)',
  '[tv_doge]', '[笑哭]', '[害羞]', '🎉', '✨', '😋'];

const TEMPLATES = [
  '{time}的远行商人有{items}，记得换{kao}',
  '对了，{time}远行商人刷{items}了，缺的赶紧去{kao}',
  '{time}这轮有{items}，我刚看到就来说一声{kao}',
  '提醒下，{time}远行商人有{items}，别白跑一趟{kao}',
  '{time}的{items}，远行商人还有，手快的去{kao}',
  '刷到你这期想起来，{time}远行商人有{items}{kao}',
  '{time}远行商人上了{items}，记得换{kao}',
  '刚好看到你在更洛克，{time}远行商人有{items}{kao}',
  '{time}这轮别错过，远行商人有{items}{kao}',
  '顺手说一句，{time}远行商人有{items}，要的去看看{kao}',
  '{time}远行商人那边有{items}，还挂着没换的可以去{kao}',
  '看了下，{time}远行商人有{items}，缺的去补{kao}',
];
const usedTexts = new Set();

/* 本轮全部命中的商品名（去重、最多 3 个）。主人：「一轮命中几样…应该全写」。 */
function itemNames(ctx) {
  const list = ((ctx && ctx.items) || [])
    .map(x => String((x && x.name) || '').trim())
    .filter(Boolean);
  const uniq = [];
  for (const n of list) {
    if (!uniq.some(u => u === n || u.indexOf(n) >= 0 || n.indexOf(u) >= 0)) uniq.push(n);
  }
  if (!uniq.length && ctx && ctx.item) uniq.push(String(ctx.item));
  return uniq.slice(0, 3);
}
function itemsText(ctx) {
  const l = itemNames(ctx);
  return l.length ? l.join('、') : String((ctx && ctx.item) || '');
}
/* 「8点到12点」；拿不到轮次时间就退回「这一轮」。 */
function timeText(ctx) {
  return String((ctx && ctx.timeLabel) || '这一轮');
}

function validText(t, ctx) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 8 || s.length > 80) return '';
  if (/https?:\/\/|www\.|@|关注|三连|点赞|投币|加群|私信|机器人|人工智能|\bAI\b/i.test(s)) return '';
  // 必须带上本轮真实商品名（模型现写也过这一关，免得说成别的东西）
  const names = itemNames(ctx);
  // 全都要写：一轮有棱镜球+祝福项坠，就不能只提一个（2026-11-22 主人定）
  if (names.length && !names.every(n => s.indexOf(n) >= 0)) return '';
  // 必须带上本轮时间段（实测模型会偷懒写成「这轮」「12点前」甚至「晚上12点」，
  // 主人要的是「几点到几点的x」，所以不过这一关就回落模板）
  const tl = String((ctx && ctx.timeLabel) || '');
  if (tl) {
    const fromH = tl.split('到')[0];                  // 「8点」
    if (s.indexOf(tl) < 0 && s.indexOf(fromH) < 0) return '';
    if (/晚上\s*12\s*点/.test(s)) return '';         // 12 点是中午，写成晚上就错了
  }
  if (!names.length && !/棱镜球|祝福项坠|炫彩蛋|炫彩精灵蛋|远行商人/.test(s)) return '';
  if (usedTexts.has(s)) return '';
  return s;
}

function fillTemplate(ctx) {
  const names = itemNames(ctx);
  const tpl = TEMPLATES[rand(0, TEMPLATES.length - 1)];
  return tpl
    .replace(/\{time\}/g, timeText(ctx))
    .replace(/\{items\}/g, names.join('、') || String((ctx && ctx.item) || '货'))
    .replace(/\{kao\}/g, KAOMOJI[rand(0, KAOMOJI.length - 1)]);
}

/* 一次生成一批（主人 2026-11-22：「一轮命中几样…又不费啥」「别绕远路费 token」）。
 * 只发 1 个请求让模型写 n 条不同说法；解析不出来就回落模板，不影响发送。 */
async function makeTexts(vs, ctx, n) {
  // 进程长跑时 usedTexts 会一直涨，涨到几百条模板就凑不出新句了；超量清空（旧评论早沉了）
  if (usedTexts.size > 300) usedTexts.clear();
  const want = Math.max(1, Math.min(10, n || vs.length || 1));
  const out = [];
  const names = itemsText(ctx);
  const time = timeText(ctx);
  if (ctx.useModel !== false) {
    const sys = [
      '你是B站一个普通玩家，刚看完一条洛克王国视频，顺手留句评论提醒别人。',
      '这一轮（' + time + '）远行商人有：' + names + '。',
      '像人说话：口语、12~45 字、有对话感；末尾带一个可爱的符号表情（直接写符号，不要写「颜文字」三个字）；',
      '每条都必须自然写出时间段「' + time + '」（可以放开头），不写这个时间就不合格；',
      '注意 12 点是中午，别写成「晚上12点」；',
      '不要@人、不要放链接、不要让关注/点赞/三连、别提自己是AI或机器人；',
      '不要复述视频标题；不要用「作为」「总之」「希望对你有帮助」这种腔调。',
      '每条说法都要不一样（句式、开头都换），别让 B站 判成重复内容。',
      '只输出 ' + want + ' 行，每行一条，以「- 」开头，不要编号、不要解释。',
    ].join('\n');
    const usr = '视频：' + vs.map(v => v.title).join(' / ').slice(0, 120);
    try {
      const raw = await withTimeout(core.callLLM([{ role: 'system', content: sys }, { role: 'user', content: usr }], { tag: 'other' }), 45000);
      for (const line of String(raw || '').split('\n')) {
        const t = validText(line.replace(/^\s*[-•*\d.、]+\s*/, ''), ctx);
        if (t) { usedTexts.add(t); out.push(t); }
        if (out.length >= want) break;
      }
    } catch (e) {
      // 模型限流 / 没 Key：这一批全走模板，别一条一条等 30 秒
      if (/BUSY|429|NO_KEY|AUTH|timeout/i.test(String(e && e.message || ''))) ctx.useModel = false;
    }
  }
  while (out.length < want) {
    let t = '';
    for (let i = 0; i < 30 && !t; i++) t = validText(fillTemplate(ctx), ctx);
    if (!t) break;
    usedTexts.add(t);
    out.push(t);
  }
  return out;
}

async function makeText(v, ctx) {
  const l = await makeTexts([v], ctx, 1);
  return l[0] || '';
}

/* ---------- 风控码：哪些要整轮停，哪些只跳过这条视频 ---------- */
const STOP_CODES = {
  '-412': 'IP 被 B站 临时封（-412）', '-352': '签名/风控校验失败（-352）', '-101': '登录态失效（-101）',
  '-509': '请求过于频繁（-509）', 12014: '评论 CD 未到（12014）', 12015: '要验证码（12015）',
  12016: '内容被词表挡（12016）', 12027: '评论进待审（12027）', 12028: '被判大数据垃圾评论（12028）',
  12040: '相似内容出现过多（12040）', 12053: '已达当前评论发送上限（12053）',
};
const SKIP_CODES = {
  12002: '评论区关了', 12003: '被 UP 拉黑/禁言', 12009: '评论区类型不合法', 12023: '重复评论',
  12025: '字数不合适', 12026: '含链接', 12035: '被 UP 拉黑', 12051: '重复评论',
};
function codeOf(why) { const m = String(why || '').match(/^(-?\d+)/); return m ? m[1] : ''; }

/* ---------- 被回复 → 录人物表（2026-11-21 补） ---------- */
async function fetchRepliesRaw(aid, root) {
  const c = biliSpace.creds();
  if (!c.cookie) throw Object.assign(new Error('没有 B站登录态'), { code: -101 });
  const url = 'https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + encodeURIComponent(aid)
    + '&root=' + encodeURIComponent(root) + '&pn=1&ps=20';
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.bilibili.com/',
      Cookie: c.cookie + (c.buvid || ''),
    },
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (j.code !== 0) throw Object.assign(new Error('楼中楼返回 ' + j.code + '：' + (j.message || '')), { code: j.code, http: r.status });
  const list = ((j.data && j.data.replies) || []);
  return list.map(x => ({
    rpid: String((x && x.rpid) || ''),
    mid: String((x && x.mid) || (x && x.member && x.member.mid) || ''),
    nick: String((x && x.member && x.member.uname) || '').trim().slice(0, 40),
    text: String((x && x.content && x.content.message) || '').replace(/\s+/g, ' ').slice(0, 60),
    t: Number((x && x.ctime) || 0) * 1000,
  })).filter(x => x.rpid && x.mid);
}

/* ===========================================================================
 * 被回复：录人物 + 回一句（2026-11-21 录人物 / 2026-11-22 加回评）
 *
 * 主人原话（2026-11-22）：「被问到『为什么发』『你主人是谁』『真的假的』，
 *   或者被质问『你发这个在污染评论区』『ai讨厌』…如果回答的好那就不管」
 *   「问到主人时，回复的内容里可以顺带@我」「回复别人的评论时要有人味」
 *   「说主人是谁时，就像是开玩笑装作自己是ai的人类，而不是真的ai」「发送时不要讲话像AI」。
 *
 * 所以这里做三件事：
 *   ① 分类（关键词规则，不额外花一次模型判断）：rude / ai / master / fake / why / other；
 *   ② 回一句：模型写，喂了五类参考语气 + 「假装是 AI 的人类」这个人设；模型挂掉就用兜底句；
 *   ③ 控频：每 10 分钟最多回 replyMaxPerPoll(1) 条、每天 ≤ replyMaxPerDay(8)、两条间隔 ≥300 秒，
 *      回评也吃 B站 的评论风控（撞 STOP_CODES 就停）。
 *
 * 为什么不回每一条：回评同样是评论，密度翻倍会被判垃圾/相似内容（12040/12028），
 * 而且评论区里「谢谢」「哈哈」这种搭话不值得花风控额度。所以只挑 48 小时内、有内容的回。
 * =========================================================================== */

/* 分类顺序有讲究：先判骂人的（即使他同时提到 AI，也按「软处理」回），再判 AI，再判主人。 */
const REPLY_KIND = [
  { k: 'rude', re: /污染|刷评论|水军|广告|别发|滚|烦死|举报|蹭|引流|没素质|恶心/ },
  { k: 'ai', re: /\bai\b|机器人|人机|gpt|生成|一眼假|脚本|自动回复/i },
  { k: 'master', re: /主人|你主|谁是你|谁让你|谁在背后|背后是谁|老板|上司|谁派|你的号/ },
  { k: 'fake', re: /真的假的|真假|假的吧|骗人|尊嘟|确定吗|真的吗|不信|吹吧|糊弄/ },
  { k: 'why', re: /为什么|为啥|怎么发|发这个|干什么|干嘛|关你|谁问|有必要/ },
];
function classifyReply(text) {
  const s = String(text || '');
  const hit = REPLY_KIND.find(x => x.re.test(s));
  return hit ? hit.k : 'other';
}
const KIND_DESC = {
  rude: '对方觉得你在污染评论区 / 刷广告',
  ai: '对方怀疑你是 AI、机器人',
  master: '对方问你主人是谁、谁让你发的',
  fake: '对方问是不是真的',
  why: '对方问你为什么发这个',
  other: '普通搭话',
};
/* 虚幻在 B 站评论区说话的样子（照 soul/2-说话.md：短句、句末不用句号、笑只「嘻嘻」、
 * 哭用「呜/QAQ」、不用括号写动作、不叫别人主人、被说机器人不解释不自证）。 */
/* ===== 回话：只走两层引擎，没有兜底（2026-11-22 主人定）=====
 * 主人原话：「太ai了，不要兜底了，发不出去就别发。」
 * 所以这里不再有模板句子、不再补表情、不再「凑一句」。两层都失败 → 返回空，
 * 调用方跳过这条视频，这一跳少发一条，不补。
 * 风格全部交给 reply-engine（人类逻辑 → 虚幻逻辑）；这里只留最少的硬底线。 */
const usedReplies = new Set();

function validReply(t, c) {
  const cfg = c || cfgs();
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 4 || s.length > 80) return '';
  if (/https?:\/\/|www\.|关注|三连|点赞|投币|加群|私信/.test(s)) return '';
  // AI 腔（主人：「发送时也不要讲话像AI」）
  if (/作为|总之|希望对你有帮助|我是人工智能|AI助手|语言模型|总结一下|首先|其次|此外/.test(s)) return '';
  // 回怼（实测出现过「你不就想看嘛」）
  if (/爱看不看|随便你|关你屁事|活该|不就想看/.test(s)) return '';
  // 只允许 @主人，别的 @ 一律不要
  const at = '@' + (cfg.masterBiliName || '虚幻的生物');
  if (s.split(at).join('').indexOf('@') >= 0) return '';
  if (usedReplies.has(s)) return '';
  return s;
}

async function makeReply(r, c) {
  if (usedReplies.size > 200) usedReplies.clear();
  const kind = classifyReply(r.text);
  const at = '@' + (c.masterBiliName || '虚幻的生物');
  let out = '';
  try {
    const got = await replyEngine.reply(r.text, { kind });
    out = String((got && got.text) || '');
  } catch { out = ''; }
  // 唯一的兜底（2026-11-22 主人定）：被问主人时，只发「@虚幻的生物」。
  // 其他情况两层都失败就不发，不凑句子。
  if (!out && kind === 'master' && c.replyAtMaster !== false) out = at;
  if (!out) return { text: '', kind };                 // 发不出去就不发
  // 问主人的：文本里没 @主人 就补上（真 @ 由发送端带 at_name_to_mid）
  if (kind === 'master' && c.replyAtMaster !== false && out.indexOf(at) < 0) {
    out = (out.trim() + ' ' + at).slice(0, 80);
  }
  const t = validReply(out, c);
  if (!t) return { text: '', kind };
  usedReplies.add(t);
  return { text: t, kind };
}

async function pollReplies() {
  const c = cfgs();
  if (c.recordRepliers === false && c.replyEnabled === false) return { skip: '录人物和回评都关着' };
  const st = readState();
  const now = Date.now();
  const commented = st.commented || {};
  const mine = Object.entries(commented)
    .filter(([, v]) => v && v.aid && v.rpid && (now - num(v.at, 0) < c.replyWatchHours * 3600 * 1000))
    .sort((a, b) => num(b[1].at, 0) - num(a[1].at, 0))
    .slice(0, 5);
  if (!mine.length) return { skip: '没有要看的楼' };

  const seen = st.repliers || {};
  const selfMid = String((biliSpace.creds() || {}).mid || '');
  let got = 0, added = 0, fail = 0;
  const todo = [];       // 还没回过的回复（带上 aid/root/parent）
  for (const [, v] of mine) {
    let list;
    try { list = await (_replies ? _replies(v.aid, v.rpid) : fetchRepliesRaw(v.aid, v.rpid)); }
    catch (e) { fail++; await sleep(1500 + Math.random() * 1500); continue; }
    for (const r of list) {
      if (!r.mid || r.mid === selfMid) continue;      // 不吃自己回的
      if (seen[r.rpid]) {
        // 已经记过但还没回：仍要进待回池（下次轮询补上）
        if (!seen[r.rpid].repliedAt && c.replyEnabled !== false) todo.push({ r, v });
        continue;
      }
      seen[r.rpid] = { at: now, mid: r.mid, nick: r.nick, bvid: v.bvid || '', text: r.text };
      got++;
      try { if (people.ensure('bili', r.mid, { nick: r.nick })) added++; } catch {}
      if (c.replyEnabled !== false) todo.push({ r, v });
      await sleep(500 + Math.random() * 800);
    }
    await sleep(1200 + Math.random() * 1800);
  }

  st.repliers = seen;
  for (const k of Object.keys(seen)) {   // 只留 90 天，别越长越大
    if (now - num(seen[k] && seen[k].at, 0) > 90 * 24 * 3600 * 1000) delete seen[k];
  }

  // ---- 回评：每轮最多 replyMaxPerPoll 条、每天 replyMaxPerDay、两条间隔 replyGapSec ----
  const day = beijingDay(now);
  st.replyDaily = st.replyDaily || {};
  let replied = 0, replyWhy = '';
  const todayReplied = num(st.replyDaily[day], 0);
  if (c.replyEnabled !== false && todo.length) {
    if (todayReplied >= c.replyMaxPerDay) replyWhy = '今天回评到上限（' + c.replyMaxPerDay + ' 条）';
    else if (now - num(st.lastReplyAt, 0) < c.replyGapSec * 1000) replyWhy = '离上一条回评还不到 ' + c.replyGapSec + ' 秒';
    else if (st.replyCooldownUntil && now < st.replyCooldownUntil) replyWhy = '回评冷却中';
    else {
      // 新的优先（刚被回的更容易接上话）
      const queue = todo.filter(x => x.r && x.r.rpid)
        .sort((a, b) => num(b.r.t, 0) - num(a.r.t, 0))
        .slice(0, c.replyMaxPerPoll);
      for (const it of queue) {
        const { text, kind } = await makeReply(it.r, c);
        if (!text) continue;
        await sleep(rand(1500, 4000));     // 发包前停一下
        let res;
        try {
          // 问主人的那条：真 @ 要带 at_name_to_mid（只写文本不会通知对方）
          const atMap = (kind === 'master' && c.replyAtMaster !== false)
            ? { [c.masterBiliName || '虚幻的生物']: c.masterBiliMid || '30895294' }
            : null;
          res = await (_replyComment
            ? _replyComment(it.v.aid, text, it.v.rpid, it.r.rpid)
            : biliApi.commentVideo(it.v.aid, text, { root: it.v.rpid, parent: it.r.rpid, at: atMap }));
        } catch (e) { res = { ok: false, why: e.message }; }
        if (res && res.ok) {
          seen[it.r.rpid] = Object.assign({}, seen[it.r.rpid], {
            repliedAt: Date.now(), replyText: text, replyKind: kind, replyRpid: res.rpid || 0,
          });
          st.replyDaily[day] = num(st.replyDaily[day], 0) + 1;
          st.lastReplyAt = Date.now();
          replied++;
          console.log('[B站回复] 回 ' + (it.r.nick || it.r.mid) + '（' + kind + '）：' + text);
        } else {
          const code = codeOf(res && res.why);
          if (STOP_CODES[code]) {
            st.replyCooldownUntil = Date.now() + (code === 12014 ? 10 * 60000 : 2 * 3600 * 1000);
            replyWhy = '回评撞风控：' + (STOP_CODES[code] || res.why);
            break;
          }
          replyWhy = '回评失败：' + ((res && res.why) || '未知');
        }
      }
    }
  }

  st.lastReplyPollAt = now;
  st.lastReplyResult = '拉回复：新回复 ' + got + ' 条，建档/补名 ' + added + ' 人'
    + (replied ? '，回了 ' + replied + ' 条' : '')
    + (fail ? '，失败 ' + fail + ' 楼' : '')
    + (replyWhy ? '；' + replyWhy : '');
  writeState(st);
  if (got || replied) console.log('[B站提醒] ' + st.lastReplyResult);
  return { ok: true, got, added, fail, replied, todo: todo.length, why: replyWhy };
}

/* ---------- 主流程 ---------- */
let _timer = null, _started = false, _busy = false;
let _search = null;    // 自测注入：搜索
let _comment = null;   // 自测注入：发评论
let _tags = null;      // 自测注入：查视频标签
let _replies = null;   // 自测注入：查楼中楼
let _up = null;        // 自测注入：查 UP 粉丝/播放
let _replyComment = null;  // 自测注入：回楼中楼

function arm(info) {
  const c = cfgs();
  if (!c.enabled) return { skip: 'B站评论关着' };
  const it = info || {};
  const items = Array.isArray(it.items) ? it.items : [];
  // 本轮命中里挑最稀有的那个（棱镜球 > 祝福项坠 > 炫彩蛋），文案和额度都按它算
  const hits = items.filter(x => c.triggerItems.some(w => String((x && x.name) || '').indexOf(String(w)) >= 0));
  if (!hits.length) return { skip: '这一轮没有触发的商品' };
  const pick = rocoRarity.rarest(hits);
  const itemName = pick.name || String((hits[0] && hits[0].name) || '');
  const rank = pick.rank || rocoRarity.of(itemName);
  const st = readState();
  if (st.task && st.task.roundKey === String(it.roundKey || '')) return { skip: '这一轮已经安排过' };
  const now = Date.now();
  // 2026-11-22 主人定：一轮 4 小时，只在前 3.5 小时内发；前 2 小时只发过万 UP，
  // 之后 1.5 小时小 UP 也发、把额度花满。所以窗口/分段都以「轮次开始」为基准，不是以 arm 时刻。
  const roundStart = beijingMs(it.startedAt);
  const roundEnd = beijingMs(it.nextRefresh);
  const base = roundStart || now;
  const windowEnd = roundEnd
    ? Math.min(roundEnd, base + c.windowAfterMin * 60000)
    : now + c.windowAfterMin * 60000;
  const stageAEnd = Math.min(windowEnd, base + c.bigUpUntilMin * 60000);
  const fromH = hourLabel(it.startedAt), toH = hourLabel(it.nextRefresh);
  const timeLabel = fromH && toH ? fromH + '到' + toH : '';
  st.task = {
    roundKey: String(it.roundKey || ''), round: it.round == null ? null : it.round,
    armAt: now,
    windowStart: now - c.windowBeforeMin * 60000,
    windowEnd,
    stageAEnd,                                   // 到这时刻前只发 A/B 档（过万 UP）
    timeLabel,
    items: hits.slice(0, 3),
    item: itemName,                                   // 本轮主推商品（额度按它算）
    rank,                                            // 稀有度（3 棱镜球 / 2 祝福项坠 / 1 炫彩蛋）
    slot: rank >= rocoRarity.RARE_MIN ? 'rare' : 'common',   // 额度分账用
    counts: { sent: 0 },
  };
  st.lastResult = '已安排：' + itemName + '（' + st.task.slot + '）窗口 '
    + new Date(st.task.windowStart).toISOString() + ' → ' + new Date(st.task.windowEnd).toISOString();
  writeState(st);
  console.log('[B站提醒] 第' + st.task.round + '轮命中「' + itemName + '」（稀有度 ' + rank + '），安排 B站 评论任务（'
    + c.windowBeforeMin + ' 分钟前 ~ ' + (timeLabel ? '本轮 ' + timeLabel + ' 的 3.5 小时内' : c.windowAfterMin + ' 分钟后')
    + (timeLabel ? '；前 2 小时只发过万 UP' : '') + '）');
  schedule(4000);
  return { ok: true, task: st.task };
}

/* 当天计数：新格式 {rare, common}；老格式是纯数字（当时只发稀有商品），按稀有的算。 */
function dayCount(st, day) {
  const v = (st && st.daily || {})[day];
  if (typeof v === 'number') return { rare: num(v, 0), common: 0 };
  return { rare: num(v && v.rare, 0), common: num(v && v.common, 0) };
}

function finish(why) {
  const st = readState();
  if (st.task) {
    st.lastTask = Object.assign({}, st.task, { endedAt: Date.now(), endWhy: why });
    delete st.task;
    st.lastResult = why;
    writeState(st);
    console.log('[B站提醒] 任务结束：' + why);
  }
}

function status(dayArg) {
  const st = readState();
  const c = cfgs();
  // dayArg：日报要「昨天」的数，不传就是今天（老调用行为不变）。
  const day = dayArg || beijingDay();
  const dc = dayCount(st, day);
  return {
    enabled: c.enabled,
    task: st.task || null,
    // 今天发了多少：稀有/普通分开算（额度按稀有度分账，2026-11-21）
    today: dc.rare + dc.common,
    todayRare: dc.rare,
    todayCommon: dc.common,
    maxPerDay: c.maxPerDay, maxPerRound: c.maxPerRound, maxRarePerDay: c.maxRarePerDay,
    commented: Object.keys(st.commented || {}).length,
    lastResult: st.lastResult || '',
    lastSentAt: st.lastSentAt || 0,
    cooldownUntil: st.cooldownUntil || 0,
    recent: (st.recent || []).slice(-5),
    commentSite: 'BV1Xess6pEzP',
    tags: {
      mobile: c.mobileTags, block: c.blockTagWords,
      weak: c.weakTags, weakFansMin: c.weakTagFansMin,
      checked: Object.keys(st.tagCache || {}).length,
    },
    pick: {
      preferFansMin: c.preferFansMin, preferPlayMin: c.preferPlayMin,
      minTier: c.minTier, ups: Object.keys(st.upCache || {}).length,
    },
    rarity: rocoRarity.map(),
    repliers: {
      count: Object.keys(st.repliers || {}).length,
      // 日报用：这一天新回她评论的人数（st.repliers 自己的 at 时间戳）
      todayNew: Object.keys(st.repliers || {}).filter(k => beijingDay(num((st.repliers[k] || {}).at, 0)) === day).length,
      dayReplied: num((st.replyDaily || {})[day], 0),
      lastAt: st.lastReplyPollAt || 0,
      lastResult: st.lastReplyResult || '',
      // 回评（2026-11-22）：今天回了几条、上限、开关
      enabled: c.replyEnabled !== false,
      today: num((st.replyDaily || {})[day], 0),
      maxPerDay: c.replyMaxPerDay,
      maxPerPoll: c.replyMaxPerPoll,
      masterAt: '@' + (c.masterBiliName || '虚幻的生物'),
    },
  };
}

function schedule(ms) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(runOnce, Math.max(1000, ms));
}
async function runOnce() {
  _timer = null;
  const r = await tick();
  if (r && r.again) return schedule(r.again);
  if (r && r.retrySec) return schedule(r.retrySec * 1000);
}

async function tick() {
  if (_busy) return { skip: '上一跳还在跑' };
  _busy = true;
  try {
    const c = cfgs();
    const st = readState();
    if (!c.enabled) return { skip: '关着' };
    if (!st.task) return { skip: '没有任务' };
    const now = Date.now();
    if (now > st.task.windowEnd) { finish('窗口结束（' + c.windowAfterMin + ' 分钟后）'); return { skip: '窗口结束' }; }
    if (st.cooldownUntil && now < st.cooldownUntil) {
      return { retrySec: Math.max(60, Math.round((st.cooldownUntil - now) / 1000)), skip: '风控冷却中' };
    }
    const day = beijingDay(now);
    st.daily = st.daily || {};
    const dc = dayCount(st, day);
    // 额度按稀有度分账（2026-11-21 主人定）：
    //   · 稀有（棱镜球/祝福项坠）走独立额度 maxRarePerDay，不受 maxPerDay 总额限制 —— 「突破限制」；
    //   · 普通（炫彩蛋）只有在今天稀有还没发满时才发，且吃 maxPerDay 总额 ——
    //     「一天已经发了十次稀有的，就不在下一轮发炫彩蛋这种不稀有的」。
    const pickItem = st.task.item || (rocoRarity.rarest(st.task.items || []).name || '');
    const itemName = String(pickItem || '');
    const slot = st.task.slot || (rocoRarity.of(itemName) >= rocoRarity.RARE_MIN ? 'rare' : 'common');
    if (slot === 'common') {
      if (c.commonOnlyWhenRareLeft && dc.rare >= c.maxRarePerDay) {
        const why = '今天稀有已发满 ' + c.maxRarePerDay + ' 条，「' + (itemName || '普通商品') + '」属普通，这一轮不发';
        finish(why);
        return { skip: why };
      }
      if (dc.rare + dc.common >= c.maxPerDay) { finish('今天到上限（' + c.maxPerDay + ' 条）'); return { skip: '今日上限' }; }
    } else if (dc.rare >= c.maxRarePerDay) {
      finish('今天稀有已发满 ' + c.maxRarePerDay + ' 条');
      return { skip: '稀有今日上限' };
    }
    if (num(st.task.counts && st.task.counts.sent, 0) >= c.maxPerRound) { finish('这一轮到上限（' + c.maxPerRound + ' 条）'); return { skip: '本轮上限' }; }

    const selfMid = String((biliSpace.creds() || {}).mid || '');
    let found;
    try { found = await (_search ? _search(c.keyword, c.searchPages) : searchVideos(c.keyword, c.searchPages)); }
    catch (e) {
      const code = String(e.code || '');
      if (code === '-412' || code === '-352' || code === '-509' || code === '-101') {
        st.cooldownUntil = now + 30 * 60000;
        st.lastResult = '搜索撞风控（' + code + '）：' + e.message + '，停 30 分钟';
        writeState(st);
        try { core.aiFeedback('B站提醒撞风控', st.lastResult); } catch {}
        return { retrySec: 1800, skip: '搜索撞风控' };
      }
      st.lastResult = '搜索失败：' + e.message;
      writeState(st);
      return { retrySec: c.scanGapSec, skip: '搜索失败' };
    }

    const ws = st.task.windowStart, we = Math.min(st.task.windowEnd, now);
    const commented = st.commented || {};
    const bad = st.bad || {};
    const tagCache = st.tagCache || {};
    const pool = found
      .filter(v => v.pubMs >= ws && v.pubMs <= we)
      .filter(isGameType)                       // 非游戏分区直接不要（防蹭 tag 的韩剧/娱乐视频）
      .filter(v => v.mid !== selfMid)
      .filter(v => !commented[v.bvid])
      .filter(v => num(bad[v.bvid], 0) < 2)
      .sort((a, b) => b.pubMs - a.pubMs);

    if (!pool.length) {
      st.lastScanAt = now;
      st.lastResult = '窗口里没有新视频（候选 0）';
      writeState(st);
      return { retrySec: c.scanGapSec, skip: '没有候选' };
    }

    /* 逐条查 tag + 查 UP（2026-11-21 主人定：先看标签，再看粉丝/播放）。
     *   · 强标签（手游白名单）→ 直接合格；
     *   · 弱标签（激励计划）→ 还要 UP 粉丝 ≥1万，且标题/简介没有页游字样（judgeWithUp）；
     *   · 合格的按 A/B/C 排档，低于 minTier 的不发（省额度，主人：「优先找up主粉丝数过万、up其他视频过万的」）。
     * 每跳最多查 tagCheckPerTick 条标签、upCheckPerTick 个 UP，都有缓存（tag 12 小时 / UP 24 小时）。 */
    const queue = [];
    const upCache = st.upCache || {};
    let checked = 0, upChecked = 0, tagMiss = 0, missWhy = '';
    for (const v of pool) {
      // 队列上限放宽到 8：额度有限要靠「排档」挑人，只取 2 条会漏掉后面粉丝过万的 UP
      // （实测踩到：前 4 条全是几百粉，第 8 条才是 2.1 万粉的 UP）。请求数仍由 tagCheckPerTick 卡住。
      if (queue.length >= Math.max(8, c.maxPerScan * 4) || checked >= c.tagCheckPerTick) break;
      const cache = tagCache[v.bvid];
      let jd = null;
      if (cache && (now - num(cache.at, 0) < c.tagCacheHours * 3600 * 1000)) {
        // 老缓存只有 {hit, why}，没有 level：拿缓存里的 tag 名重判一次，别拿旧结论当结论
        jd = cache.level ? cache
          : Object.assign({ at: cache.at, bvid: v.bvid, names: cache.names || [] }, judgeTags(cache.names || [], c));
      } else {
        if (checked > 0) await sleep(rand(1200, 2600));   // 读接口也留间隔，别贴 30 次/分钟
        checked++;
        try {
          const names = await (_tags ? _tags(v.bvid) : fetchTags(v.bvid));
          jd = Object.assign({ at: Date.now(), bvid: v.bvid, names }, judgeTags(names, c));
          tagCache[v.bvid] = jd;
        } catch (e) {
          const code = String(e.code || '');
          if (code === '-412' || code === '-352' || code === '-509' || code === '-101') {
            st.tagCache = tagCache;
            st.cooldownUntil = now + 30 * 60000;
            st.lastResult = '查标签撞风控（' + code + '）：' + e.message + '，停 30 分钟';
            writeState(st);
            try { core.aiFeedback('B站提醒查标签撞风控', st.lastResult); } catch {}
            return { retrySec: 1800, skip: '查标签撞风控' };
          }
          st.lastResult = '查标签失败 ' + v.bvid + '：' + e.message;
          continue;
        }
      }
      if (jd.level === 'none') { tagMiss++; missWhy = jd.why || missWhy; continue; }

      // 弱标签要粉丝；强标签要排档 —— 两种都得有 UP 数据
      let up = upCache[v.mid];
      if (!up || now - num(up.at, 0) > c.upCacheHours * 3600 * 1000) {
        // 这一跳的 UP 预算用完就停，别再白花标签请求；缓存留住，下一跳从这儿接着看
        if (upChecked >= c.upCheckPerTick) break;
        upChecked++;
        try {
          up = await (_up ? _up(v.mid, v.bvid) : upStats(v.mid, v.bvid, c));
          upCache[v.mid] = Object.assign({ mid: v.mid }, up);
          await sleep(rand(800, 1800));
        } catch (e) {
          // 空间关了 / 风控：粉丝拿不到就不能认弱判据，强判据仍然发，只是排不上档
          up = { fans: 0, maxPlay: 0, over: 0, n: 0, at: Date.now() };
        }
      }
      const jd2 = judgeWithUp(v, jd, up, c);
      tagCache[v.bvid] = Object.assign({}, tagCache[v.bvid] || { at: Date.now(), bvid: v.bvid, names: jd.tags || [] },
        { level: jd.level, weakTag: jd.weakTag, hit: jd2.hit, why: jd2.why });
      if (!jd2.hit) { tagMiss++; missWhy = jd2.why || missWhy; continue; }
      queue.push({ v, jd: jd2, up, tier: tierOf(up, c) });
    }
    // 缓存清理：超过 7 天的删掉，最多留 500 条（免得状态文件越长越大）
    for (const k of Object.keys(tagCache)) {
      if (now - num(tagCache[k] && tagCache[k].at, 0) > 7 * 24 * 3600 * 1000) delete tagCache[k];
    }
    const ck = Object.keys(tagCache);
    if (ck.length > 500) ck.sort((a, b) => num(tagCache[a].at, 0) - num(tagCache[b].at, 0)).slice(0, ck.length - 500).forEach(k => delete tagCache[k]);
    st.tagCache = tagCache;
    for (const k of Object.keys(upCache)) {
      if (now - num(upCache[k] && upCache[k].at, 0) > 7 * 24 * 3600 * 1000) delete upCache[k];
    }
    const uk = Object.keys(upCache);
    if (uk.length > 500) uk.sort((a, b) => num(upCache[a].at, 0) - num(upCache[b].at, 0)).slice(0, uk.length - 500).forEach(k => delete upCache[k]);
    st.upCache = upCache;

    if (!queue.length) {
      st.lastScanAt = now;
      st.lastResult = '查了 ' + checked + ' 条标签，没有能发的（跳过 ' + tagMiss + ' 条' + (missWhy ? '，如：' + missWhy : '') + '）';
      writeState(st);
      return { retrySec: c.scanGapSec, skip: '没有能发的视频' };
    }

    // 排档：A（粉丝+其他视频都过万）> B（任一过万）> C（都不满足）；同档内从新到旧。
    // 2026-11-22 主人定：前 2 小时只发 A/B（等大 UP）；之后 1.5 小时放开 C 档，
    // 「看到小 up 直接发满额度」；额度早就花完的话这一段自然没有可发的。
    queue.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.v.pubMs - a.v.pubMs));
    const lateStage = now >= num(st.task.stageAEnd, num(st.task.armAt, now) + c.bigUpUntilMin * 60000);
    const tierLimit = (lateStage && c.lateAllowC) ? 'C' : c.minTier;
    const ready = queue.filter(x => TIER_RANK[x.tier] <= TIER_RANK[tierLimit]);
    const lowTier = queue.length - ready.length;
    if (!ready.length) {
      st.lastScanAt = now;
      st.lastResult = '有 ' + queue.length + ' 条标签合格，但都不到粉丝/播放过万（C 档）'
        + (lateStage ? '，这一跳先等下一次扫' : '，等后 1.5 小时再放开');
      writeState(st);
      return { retrySec: c.scanGapSec, skip: '候选都不到过万门槛' };
    }

    const ctx = { items: st.task.items || [], round: st.task.round, useModel: c.useModel, item: itemName, timeLabel: st.task.timeLabel || '' };

    // 一次生成一批文案（省 token / CPU）：按「本轮还剩多少额度」算要几条，
    // 只发 1 个 LLM 请求；模型限流就整批回落模板，不影响发送。
    const dn0 = dayCount(st, day);
    const room = slot === 'rare'
      ? c.maxRarePerDay - dn0.rare
      : Math.min(c.maxPerDay - (dn0.rare + dn0.common),
        (c.commonOnlyWhenRareLeft && dn0.rare >= c.maxRarePerDay) ? 0 : 999);
    const want = Math.max(0, Math.min(ready.length, c.maxPerRound - num(st.task.counts && st.task.counts.sent, 0), room, 10));
    const batch = want > 0 ? await makeTexts(ready.slice(0, want).map(x => x.v), ctx, want) : [];

    let sent = 0, stopWhy = '';
    for (let i = 0; i < ready.length; i++) {
      const v = ready[i].v;
      // 每发一条前重算额度：这一跳中途可能刚好把稀有额度发满 / 或普通额度用尽
      const dn = dayCount(st, day);
      if (slot === 'rare') {
        if (dn.rare >= c.maxRarePerDay) break;
      } else if ((c.commonOnlyWhenRareLeft && dn.rare >= c.maxRarePerDay) || dn.rare + dn.common >= c.maxPerDay) {
        break;
      }
      if (sent >= c.maxPerRound - num(st.task.counts && st.task.counts.sent, 0)) break;
      const text = batch[i] || await makeText(v, ctx);
      if (!text) continue;
      if (sent > 0) await sleep(rand(c.gapSecMin, c.gapSecMax) * 1000);   // 条与条之间 150~240 秒
      await sleep(rand(2000, 6000));                                      // 发包前也随机停一下
      const r = await (_comment ? _comment(v.aid, text) : biliApi.commentVideo(v.aid, text));
      if (r.ok) {
        commented[v.bvid] = { at: Date.now(), rpid: r.rpid || 0, aid: v.aid, title: v.title.slice(0, 40), text };
        st.lastSentAt = Date.now();
        st.task.counts.sent = num(st.task.counts.sent, 0) + 1;
        const d2 = dayCount(st, day);
        if (slot === 'rare') d2.rare += 1; else d2.common += 1;
        st.daily[day] = d2;
        st.recent = (st.recent || []).concat([{ at: Date.now(), bvid: v.bvid, ok: true, text, item: itemName, slot }]).slice(-20);
        sent++;
        writeState(st);
        console.log('[B站提醒] 已评论 ' + v.bvid + '（' + v.title.slice(0, 24) + '）｜' + itemName + '｜' + text);
        if (st.task.counts.sent >= c.maxPerRound) break;
      } else {
        const code = codeOf(r.why);
        if (STOP_CODES[code]) {
          stopWhy = STOP_CODES[code] + '：' + r.why;
          st.cooldownUntil = Date.now() + (code === 12014 ? 10 * 60000 : 2 * 3600 * 1000);
          st.recent = (st.recent || []).concat([{ at: Date.now(), bvid: v.bvid, ok: false, why: r.why }]).slice(-20);
          writeState(st);
          break;
        }
        bad[v.bvid] = num(bad[v.bvid], 0) + 1;
        st.lastResult = '跳过 ' + v.bvid + '：' + ((SKIP_CODES[code] || '') || r.why);
        writeState(st);
      }
    }
    st.commented = commented; st.bad = bad;
    st.lastScanAt = Date.now();
    if (stopWhy) {
      st.lastResult = stopWhy;
      writeState(st);
      try { core.aiFeedback('B站提醒被风控', stopWhy); } catch {}
      finish('撞风控停机：' + stopWhy);
      return { skip: stopWhy };
    }
    const dd = dayCount(st, day);
    st.lastResult = '这一跳发了 ' + sent + ' 条（' + itemName + '），今日稀有 ' + dd.rare + '/' + c.maxRarePerDay
      + '、普通 ' + dd.common + (lowTier ? '；另有 ' + lowTier + ' 条 C 档没过万没发' : '');
    writeState(st);
    return { retrySec: c.scanGapSec, skip: '这一跳完成' };
  } catch (e) {
    console.log('[B站提醒] 这一跳出错：' + e.message);
    return { retrySec: 600, skip: e.message };
  } finally {
    _busy = false;
  }
}

let _replyTimer = null;

function startReplyPoll() {
  if (_replyTimer) return;
  const step = () => Math.max(3, cfgs().replyPollMin) * 60000;
  const loop = async () => {
    try { await pollReplies(); } catch (e) { console.log('[B站提醒] 拉回复出错：' + e.message); }
    _replyTimer = setTimeout(loop, step());
  };
  _replyTimer = setTimeout(loop, 45000);   // 启动 45 秒后先看一次（有旧评论也能补录）
}

function start() {
  if (_started) return;
  _started = true;
  const st = readState();
  if (st.task && Date.now() < st.task.windowEnd) {
    console.log('[B站提醒] 接着跑上次没跑完的任务（结束于 ' + new Date(st.task.windowEnd).toLocaleString('zh-CN') + '）');
    schedule(6000);
  }
  startReplyPoll();   // 评论发出去以后一直有人回，跟任务窗口无关
}

module.exports = {
  start, arm, tick, status, finish, pollReplies,
  _searchVideos: searchVideos, _looksRoco: looksRoco, _validText: validText, _makeText: makeText,
  _fetchTags: fetchTags, _judgeTags: judgeTags, _normTag: normTag, _fetchReplies: fetchRepliesRaw,
  _isGameType: isGameType,
  _makeTexts: makeTexts, _itemNames: itemNames, _timeText: timeText,
  _classifyReply: classifyReply, _validReply: validReply, _makeReply: makeReply,
  // 2026-11-21：弱判据（激励计划 + 粉丝门槛）、UP 三档、稀有度额度
  _judgeWithUp: judgeWithUp, _upStats: upStats, _tierOf: tierOf, _dayCount: dayCount,
  _rarityOf: rocoRarity.of, _rarestOf: rocoRarity.rarest,
  _STATE_PATH: STATE_PATH, _cfgs: cfgs,
  _setSearch: fn => { _search = fn; },
  _setComment: fn => { _comment = fn; },
  _setTags: fn => { _tags = fn; },
  _setReplies: fn => { _replies = fn; },
  _setReplyComment: fn => { _replyComment = fn; },
  _setUp: fn => { _up = fn; },
};
