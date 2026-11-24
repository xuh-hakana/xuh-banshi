/*
 * style.js — 学主人怎么说话
 * 主人 2026-10-22：机器人是「我在网络上的分身」，说话方式和语气要学他，但不能是固定的一句。
 *
 * 做法：
 *   1. 收主人自己打的字（style-samples.json，最多 200 条，去重）
 *   2. 每 15 条让模型总结一次「他是怎么说话的」→ 写进 data/说话风格.md 的「现在的样子」
 *   3. 说话时注入「风格描述 + 随机抽 4 条样本」——随机抽就保证不是固定的
 *   4. 「主人自己补的」那一段永远不覆盖，优先级最高
 */
const fs = require('fs');
const path = require('path');
const { botWrite } = require('./wlog');

const ROOT = __dirname;
const SAMPLE_FILE = path.join(ROOT, 'data', 'style-samples.json');
const STYLE_FILE = path.join(ROOT, 'data', '说话风格.md');
const MAX_SAMPLES = 200;

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const norm = s => String(s || '').replace(/\s+/g, '').trim();

// 速度优化（2026-10-22）：说话风格.md 和 style-samples.json 每条消息都会被读+解析（拼 prompt 用），
// 加 mtime 缓存——文件没改就直接用；写回时 mtime 变了自动失效。
const _rc = new Map();   // path -> { at, data }
function readCachedJson(p, fallback) {
  try {
    const st = fs.statSync(p).mtimeMs;
    const c = _rc.get(p);
    if (c && c.at === st) return c.data;
    const data = JSON.parse(read(p) || fallback);
    _rc.set(p, { at: st, data });
    return data;
  } catch { return fallback; }
}
function readCachedText(p) {
  try {
    const st = fs.statSync(p).mtimeMs;
    const c = _rc.get(p);
    if (c && c.at === st) return c.data;
    const data = read(p);
    _rc.set(p, { at: st, data });
    return data;
  } catch { return ''; }
}

const DEFAULT_MD = `# 说话风格（学自主人）

> 机器人是主人在网络上的**分身**，说话的味道要像他。
> 「现在的样子」由机器人自己从主人的聊天里总结，会**定期更新**（不是死的）。
> 「主人自己补的」这一段永远不会被覆盖，优先级最高——想让它怎么说话，直接写在这里。

## 现在的样子

## 主人自己补的

## 表情偏好

`;

function loadSamples() {
  const a = readCachedJson(SAMPLE_FILE, '[]');
  return Array.isArray(a) ? a.slice() : [];   // 返回副本：调用方会原地改（learnImg push），别污染缓存
}
function saveSamples(a) {
  try { fs.writeFileSync(SAMPLE_FILE, JSON.stringify(a.slice(-MAX_SAMPLES), null, 1), 'utf8'); } catch {}
}

/* 收一条主人说的话（返回 true 表示是新样本）。
 * 学习规则 v2（主人 2026-10-22 重定）：
 *   - 只收**测试群（1000000004）以外**的群聊发言（调用点判断群号，learn 里存 meta.g 留档）；
 *   - 和 @ 无关：@ 后正常对话照收；
 *   - 机器人功能指令（骰子、触发词等）不收——那是在用功能，不是说话；
 *   - 图片不是不收：打字部分照学，图的翻译存进 meta.img 当「发图品味」（以后发同类图），
 *     但**不许把图片翻译直接当文字输出**；
 *   - 复制粘贴不收：超长（>60 字）、带链接、多行大段都不要；
 *   - 去重。
 * 学习规则 v3（主人 2026-10-22 定）：**最优先**的是他对别人的「回复」和「@」——
 *   - meta.kind：'reply'=他引用/回复了别人；'at'=@了别人。这两类单独标记，抽样本时优先给；
 *   - meta.ctx：上下文（他回的是哪句 / 被@的人刚说了什么），跟着样本一起存——学的是「根据上文给下文」；
 *   - 对方那句若是逐字复读（和历史某条每个字和标点都一样），调用点会把 ctx 清空——样本里只留他自己的话。 */
function learn(text, meta) {
  meta = meta || {};
  const imgDesc = String(meta.img || '').slice(0, 80);
  const kind = (meta.kind === 'reply' || meta.kind === 'at') ? meta.kind : '';
  let ctx = String(meta.ctx || '')
    .replace(/［图：[^］]*］/g, '')
    .replace(/\[(图片|表情|语音)\]/g, '')
    .replace(/@\d{5,12}\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  // 图片占位符（含翻译后的［图：…］）不是他打的字，先剥掉再判断
  const t = String(text || '')
    .replace(/［图：[^］]*］/g, '')
    .replace(/\[图片[：:][^\]]*\]/g, '')
    .replace(/\[(图片|表情|语音)\]/g, '')
    // QQ 的「表情包」在消息正文里是 *名字* 这种格式（半角 * 与全角 ＊ 都有），
    // 那是客户端把贴纸转成文字，不是她打的字（她 2026-11-06 原话：
    // 「这是我发的QQ格式的表情包，不是我的说话风格」）→ 和 [表情] 同一条路：剥掉再判断。
    .replace(/[*＊][^*＊\n]{1,40}[*＊]/g, ' ')
    // 带 @ 的样本：把被回复人的 QQ 号剥掉再记，不用整条扔（主人 2026-10-22 定）
    // 号是随消息来的机器格式（@3080513370），学说话学的是他打的字，不是这个号
    .replace(/@\d{5,12}\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    // 一句话没打、只发了图：不学说话，但图的翻译可以记成发图品味
    if (imgDesc) learnImg(imgDesc);
    return false;
  }
  if (t.length < 2 || t.length > 60) return false;        // 太长的是复制粘贴的段子，不是说话习惯
  // 整条只有一个括号（「（紧张刺激的调试）」「（尾巴）」）＝ 旁白/动作，不是说话习惯。
  // 以前收了，她就学会了用括号写动作（主人 2026-10-23 在群里看到「（尾巴）」当场问起）
  if (/^[（(][^）)\n]{0,12}[）)]$/.test(t)) return false;
  if (/^[.。]/.test(t)) return false;                     // 骰子指令
  if (/^（对方发了/.test(t)) return false;
  if (/https?:\/\/|www\./i.test(t)) return false;         // 带链接的是分享不是说话
  if ((String(text || '').match(/\n/g) || []).length > 1) return false;  // 多行大段是粘贴
  if (/(.)\1{9,}/.test(t)) return false;                  // 刷屏字符（啊啊啊啊啊啊×10 这种粘贴）
  const n = norm(t);
  if (!n) return false;
  const arr = loadSamples();
  if (arr.some(x => norm(x.t) === n)) return false;
  const item = { t, at: Date.now() };
  if (meta.g) item.g = String(meta.g);                    // 来源群留档（面板可看是哪个群说的）
  if (imgDesc) item.img = imgDesc;                        // 这条带了图：图翻的是什么（发图品味）
  if (kind) item.kind = kind;                             // 回复别人 / @别人：学习第一优先（主人 2026-10-22）
  if (ctx) item.ctx = ctx;                                // 他在回哪句（联系上下文才学得会接话）
  if (meta.mid) item.mid = String(meta.mid);              // QQ message_id：这条被撤回时按它精确删掉
  // 2026-11-06 删掉过一项「星号动作样本（*叹气*）」：那是 QQ 表情包在正文里的格式，
  // 不是她的说话风格（她原话「这是我发的QQ格式的表情包，不是我的说话风格」/「根本没这个功能」）。
  // 现在统一在上面剥掉，不进样本、也不给任何加成。
  arr.push(item);
  saveSamples(arr);
  return true;
}

// 发图品味：最近带图消息的翻译，最多留 12 条（她以后发图照这个方向，不许照抄文字）
function learnImg(desc) {
  try {
    const arr = loadSamples();
    const d = String(desc || '').replace(/\s+/g, ' ').trim();
    if (!d) return false;
    if (arr.some(x => (x.img || '') === d)) return false;
    arr.push({ t: '（只发了一张图）', at: Date.now(), img: d.slice(0, 80) });
    saveSamples(arr);
    return true;
  } catch { return false; }
}

function sections(md) {
  const map = {};
  for (const p of String(md || '').split(/^##\s+/m).slice(1)) {
    const i = p.indexOf('\n');
    if (i < 0) { map[p.trim()] = ''; continue; }
    map[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return map;
}

// 「表情偏好」是给她自己录的空位：模板里的括号说明是写给她看的，不能当偏好塞进提示词
function cleanEmojiSec(t) {
  return String(t || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(x => x.trim())
    .filter(x => x && !/^[（(].*[）)]$/.test(x))
    .join('\n').trim();
}

function summary() {
  const md = readCachedText(STYLE_FILE);
  if (!md) return { now: '', mine: '', emoji: '' };
  const s = sections(md);
  return { now: s['现在的样子'] || '', mine: s['主人自己补的'] || '', emoji: cleanEmojiSec(s['表情偏好']) };
}

/*
 * 表情/颜文字用得多不多、爱用哪几个（2026-11-03 她定：喜欢带，但不是每句都带，偏好照她发的来）。
 * 只做统计，不写文件——她要是自己录了「表情偏好」那段，就完全以她写的为准（见 block）。
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
function emojiStats() {
  const arr = loadSamples().slice(-120);
  if (arr.length < 10) return null;
  let hit = 0;
  const cnt = new Map();
  for (const x of arr) {
    const t = String((x && x.t) || '');
    const m = t.match(EMOJI_RE);
    if (!m) continue;
    hit++;
    for (const e of m) cnt.set(e, (cnt.get(e) || 0) + 1);
  }
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  return { total: arr.length, hit, ratio: hit / arr.length, top };
}

// 随机抽几条样本：每次不一样，所以「不是固定的」。
// 抽取优先级（主人 2026-10-22）：他回别人的、@别人的这两类**最优先**——保底一半名额给它们，剩下的普通发言补。
function pickSamples(n) {
  const arr = loadSamples().slice(-80);
  const prio = arr.filter(x => x.kind);            // 回复/@ 最优先（2026-10-22 她的规则）
  const rest = arr.filter(x => !x.kind);
  const out = [];
  const poolP = prio.slice(), poolR = rest.slice();
  const half = Math.ceil((n || 4) / 2);
  const take = pool => pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  while (out.length < half && poolP.length) out.push(take(poolP));
  while (out.length < n && poolR.length) out.push(take(poolR));
  while (out.length < n && poolP.length) out.push(take(poolP));
  return out;
}

// 一条样本长什么样：带上下文的（回复/@/普通接话）连「他在接哪句」一起展示——学的是接话方式，不是句子本身
function sampleLine(x) {
  if (x && x.ctx) {
    if (x.kind === 'reply') return '- 回「' + x.ctx + '」的时候他说：「' + x.t + '」';
    if (x.kind === 'at') return '- @人接话（对方说「' + x.ctx + '」）的时候他说：「' + x.t + '」';
    return '- 接着「' + x.ctx + '」这句，他接了一句：「' + x.t + '」';   // 普通接话（v64：没引用没@也带上文）
  }
  return '- ' + ((x && x.t) || '');
}

// 发图品味：最近带图样本里的图翻译（她发图照这个方向挑同类图，不照抄翻译文字）
function imgTaste(n) {
  const arr = loadSamples().filter(x => x.img).slice(-12);
  if (!arr.length) return [];
  const out = [];
  const pool = arr.slice();
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].img);
  }
  return out;
}

// 拼成给模型看的一段
function block() {
  const { now, mine, emoji } = summary();
  const samples = pickSamples(4);
  const imgs = imgTaste(2);
  const est = emoji ? null : emojiStats();
  if (!now && !mine && !emoji && !est && !samples.length && !imgs.length) return '';
  const parts = ['\n## 我是怎么说话的（我是主人在网络上的分身）'];
  // 2026-11-06 她要求「重排说法」：把「说什么」和「怎么说」拆成两列编号，
  // 原来一句「风格里最优先；约定、星标压过它」两个维度混在一条链里，模型和人都容易读错。
  if (mine) parts.push('**主人自己写的（怎么说按它，第 1 档；说什么让位给约定和星标，见文末优先度）**：\n' + mine);
  // 表情偏好：她自己录了就以她写的为准；没录就照她实际发的统计，只给频率和常用几个
  if (emoji) parts.push('**我自己录的表情偏好（挑表情照这个来）**：\n' + emoji);
  else if (est && est.top.length) {
    parts.push('表情/颜文字：他大约 ' + Math.round(est.ratio * 100) + '% 的话里带表情（最常 ' + est.top.join(' ')
      + '）。喜欢带表情。\n'
      + '别每句都挂。很多话一个符号都没有。\n'
      + '别每条都补一个。');
  }
  if (now) parts.push('他说话的样子（机器人自己总结的，会变）：\n' + now);
  if (samples.length) {
    parts.push('他最近打的几句（只取味道和接话方式）：\n' + samples.map(sampleLine).join('\n') + '\n别把这些句子说出来。');
  }
  if (imgs.length) {
    parts.push('他平时发的图多是这种内容：' + imgs.join('；') + '。\n你以后发图照这个方向挑同类。\n别把描述文字念出来。');
  }
  parts.push('学回复逻辑。别学口气：这种话接不接、回几句、要不要带图、用词往哪个方向、比不比喻、什么时候一句收住。\n'
    + '字面自己组织，不许把上面的句子原样说出来。\n'
    + '上面举的短评是口味方向。别碰什么都拿它当口头禅。\n'
    + '优先度（数字小的优先，两列各算各的）\n'
    + '- 说什么：1 约定要求原样说的话 ＞ 2 星标过的做法 ＞ 3 上面写的风格\n'
    + '- 怎么说：1 主人自己写的 ＞ 2 星标过的做法 ＞ 3 自动总结、随机样本');
  return parts.join('\n');
}

// 让模型总结一次，写回「现在的样子」
async function update(llmFn) {
  const arr = loadSamples().slice(-80).map(sampleLine).map(s => s.replace(/^- /, ''));
  if (arr.length < 12) return 0;
  let out = '';
  try {
    out = await llmFn([
      {
        role: 'system',
        content: '你在总结「一个人怎么回话」。学回复逻辑。别学口气（主人 2026-11-03 定的全部维度）。\n'
          + '看下面这些例子，只提炼能照着做的做法：\n'
          + '- 什么话他会接（问句 / 求助 / @他 / 挑衅 / 单纯热闹），什么话不接\n'
          + '- 一次回几句：短促连发，还是一整段\n'
          + '- 用不用表情包、爱不爱带语气词\n'
          + '- 表情/颜文字用得勤不勤（大约几句才带一次），爱用哪几个。\n- 别写成每句都带\n'
          + '- 用词往哪个方向走：具体物件、抽象情绪、还是反问回去\n'
          + '- 会不会用比喻\n'
          + '- 什么时候一句话收住、什么时候接着聊\n'
          + '- 标点和口头禅（用不用句号、省略号多不多）\n'
          + '只输出 5~8 行，每行以「- 」开头，每条 8~22 字，要具体到能照着做。别写「他很有礼貌」这种空话。\n'
          + '不要标题。\n不要解释。\n不要总结他的性格或职业。',
      },
      { role: 'user', content: arr.join('\n') },
    ]);
  } catch { return 0; }
  const lines = String(out || '').split('\n')
    .map(s => s.trim())
    .filter(s => s.startsWith('-') && s.length >= 4)
    .slice(0, 8);
  if (!lines.length) return 0;

  const md0 = read(STYLE_FILE) || DEFAULT_MD;
  const { mine } = summary();
  const emojiRaw = (sections(md0)['表情偏好'] || '').trim();   // 原样写回（含给她看的说明行）
  const md = '# 说话风格（学自主人）\n\n'
    + '> 机器人是主人在网络上的**分身**，说话的味道要像他。\n'
    + '> 「现在的样子」由机器人自己从主人的聊天里总结，会**定期更新**（不是死的）。\n'
    + '> 「主人自己补的」「表情偏好」这两段永远不会被覆盖——**怎么说**按它们（第 1 档）；**说什么**让位给约定和星标。\n\n'
    + '## 现在的样子\n\n' + lines.join('\n') + '\n\n'
    + '## 主人自己补的\n\n' + (mine ? mine + '\n' : '')
    + '\n## 表情偏好\n\n' + (emojiRaw ? emojiRaw + '\n' : '');
  try { fs.writeFileSync(STYLE_FILE, md, 'utf8'); } catch { return 0; }
  botWrite('data/说话风格.md', '说话风格', '从主人的聊天里总结了 ' + lines.length + ' 条说话特点');
  console.log('[style] 说话风格更新了 ' + lines.length + ' 条');
  return lines.length;
}

/*
 * 精简版（只回一两句话的场合用，比如 B站评论区回一句）：
 * 「主人自己补的」+ 自动总结 + 表情习惯 + 2 条样本。不带图品味，省 token。
 * 2026-11-06 她问「这些优先级都实现了吗」：以前只有前两项，
 * B站 评论区那条路拿不到第 4、5 条（自动总结 / 样本），这里补齐。
 */
function brief() {
  const { now, mine, emoji } = summary();
  const out = [];
  if (mine) out.push(mine);
  if (now) out.push('平时说话的样子（照这个，别套模板）：\n' + now);
  if (emoji) out.push('表情偏好：' + emoji);
  else {
    const est = emojiStats();
    if (est && est.top.length) {
      out.push('表情/颜文字：我大约 ' + Math.round(est.ratio * 100) + '% 的话里带（最常 '
        + est.top.join(' ') + '）。喜欢带。\n别每句都挂。');
    }
  }
  const s = pickSamples(2);
  if (s.length) out.push('最近打的几句（只取味道）。别把这些句子说出来：\n' + s.map(sampleLine).join('\n'));
  // 裁决句放最后（2026-11-06 重排）：短评例子是口味方向，两列优先度各算各的
  out.push('优先度（数字小的大）：说什么 1 约定要求原样说的话 ＞ 2 星标过的做法 ＞ 3 这个风格；'
    + '怎么说 1 主人自己写的 ＞ 2 星标过的做法 ＞ 3 自动总结、样本。'
    + '短评是口味方向。别对谁都拿它当口头禅。');
  return out.join('\n');
}

/* 撤回清理（主人 2026-11-06 定）：被撤回的消息不许留在风格样本里。
 * 新样本带 mid，按 message_id 精确删；老样本没有 mid，按文本删。
 * 写完主动清缓存——同一毫秒内连写两次时 mtime 可能不变，光靠 mtime 会读到旧数组。 */
function dropWhere(fn) {
  const arr = loadSamples();
  const keep = arr.filter(x => !fn(x));
  const n = arr.length - keep.length;
  if (n) { saveSamples(keep); _rc.delete(SAMPLE_FILE); }
  return n;
}
function removeByMid(mid) {
  if (!mid) return 0;
  return dropWhere(x => String(x.mid || '') === String(mid));
}
function removeByText(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return dropWhere(x => String(x.t || '').trim() === t);
}

// 管理面板/测试用
function stats() {
  const arr = loadSamples();
  const { now, mine } = summary();
  return { samples: arr.length, hasNow: !!now, hasMine: !!mine };
}

module.exports = { learn, learnImg, imgTaste, block, brief, update, summary, stats, pickSamples, emojiStats, removeByMid, removeByText, STYLE_FILE };
