/*
 * qzone-comment.js — 逛人物列表里每个人的 QQ 空间，认真留一条评论（2026-11-17 主人令）
 *
 * 【她怎么说的（原话要点）】
 *   1. 去逛「人物列表」里的人的空间，认真根据此人的所有信息评论。
 *   2. 对方想要钱/暴富/被关心时，直接发：表情 + 「打赏了1000.00元红包」 + 表情。
 *   3. 评论依据**不能带任何来自群聊/私聊的内容**，只能来自别的地方
 *      （对方其他 QQ 空间帖子 / B 站视频动态）。
 *   4. 写完直接给截图或链接，不发文字汇报。
 *   5. 一个动态下面只发一条评论，所以必须慎重；不许发任何可能是低分的回复。
 *   6. 低分标准不复用模型猜测 —— 只用客户端「标错」里她本人判过的案例。
 *
 * 【本文件只做决策，不做网络】
 *   选人 → 选动态 → 生成（core.qzoneFriendComment）→ 低分门 → 通过才交给 qq.js 去发。
 *   真正发评论、拉说说在 src/connectors/qq.js（共用 qzone_stroll.py 的 --moods / --do-comment）。
 *
 * 【为什么低分门写死在这】
 *   「不许发任何可能是低分的回复」是硬标准，靠提示词不够，必须有一道机械闸门；
 *   宁可这轮不发（少一条评论不掉分），也不发一条“可能低分”的。
 */
const fs = require('fs');
const path = require('path');
const people = require('./people');
const platLimits = require('./platform-limits');
const { botWrite } = require('./wlog');

const DATA = path.join(__dirname, 'data');
const STATE_F = path.join(DATA, 'qzone-comment-state.json');   // 谁逛过、哪条评过、今天发了几条
const LOG_F = path.join(DATA, 'qzone-friend-comments.jsonl');  // 每条评论一行（客户端读这个列表）

/* ===== 红包梗：她给的固定模板，命中场合直接原样发，不交给模型改写 =====
 * 她原话举例：「对方想要钱/暴富/被关心时，直接发 [em]e10033[/em]打赏了1000.00元红包[em]e10011[/em]
 *   此表情+评论+表情」——即表情代码开头、正文、表情代码收尾。
 * 表情代码是 QQ 空间原生写法（和说说正文里的 [em]e10349[/em] 同一套），发出去显示成真表情。 */
const RED_PACKET = '[em]e10033[/em]打赏了1000.00元红包[em]e10011[/em]';

/* 命中「要钱 / 暴富 / 求关心」这一类：直接上红包梗，不写别的。
 * 只认**明确在要**的句子：普通的「难过/累」不算——那种时候打赏红包是不合时宜的怪回复。 */
const RED_PACKET_HIT = [
  /暴富|发财|中奖|一夜暴富|彩票|横财|暴金币/,
  /好穷|没钱|吃土|破产|月光|囊中羞涩|穷死|穷得|吃泡面|喝西北风/,
  /想要钱|给我钱|来点钱|送我钱|打钱|v我|V我|给点钱|缺钱|借点钱/,
  /求关心|想要关心|没人关心|没人疼|抱抱我|安慰我|求安慰|心疼我一下|谁来关心/,
];

/* ===== 低分标准：全部取自客户端「标错」里她本人判过的案例（data/ai-feedback.jsonl, kind=待修复）
 * 不复用模型猜测，也不在这里加“我觉得像低分”的自造条目。
 * 静态摘要给提示词看「有哪些类型」，lowScoreExamples() 把她标过的**原文**拿去当负例——
 * 以后她再标错，提示词自动跟着变，不用改代码。 */
const LOW_SCORE_CASES = [
  { note: '答非所问', example: '对方问一句，你答的是另一件事（2026-11-08 20:44 标错）' },
  { note: '复读了', example: '把对方刚说的话原样念一遍当回复（2026-11-09 03:33 标错）' },
  { note: '莫名其妙', example: '接的话和上文对不上，看着像随口糊的（2026-11-08 20:43 标错）' },
  { note: '把玩笑当提问去解释', example: '对方说「复读机」是玩笑，你解释成「能重复播放声音的机器」（2026-11-09 17:42 标错）' },
  { note: '空话套话式接话', example: '「哦哦哦就是这个话题，我之前在B站也看到过类似的讨论」这种（2026-11-09 17:43 标错）' },
  { note: '该有情绪的时候没有', example: '对方说你「本来就是机器」，你顺着承认或否认但不动情绪（2026-11-06 17:11 标错）' },
  { note: '背人设例句', example: '对方道歉，你回人设里那句道歉例句（2026-11-06 17:27 标错）' },
];

const FEEDBACK = path.join(DATA, 'ai-feedback.jsonl');
/* 她标过的错话原文（kind=待修复 + 带理由）。撤回类没有可学的「错话」，跳过。 */
function lowScoreExamples(limit) {
  const out = [];
  try {
    for (const line of fs.readFileSync(FEEDBACK, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.kind !== '待修复' || !o.note) continue;
      const raw = String(o.text || '');
      if (/撤回|补记|没记下正文/.test(raw)) continue;   // 撤回/故障补记不是「说错的句子」，学不到东西
      const txt = raw.replace(/^手动标记：/, '').split('｜')[0].replace(/（含 \d+ 句上下文）$/, '').trim();
      if (!txt || txt.length < 3) continue;
      out.push({ note: String(o.note).slice(0, 40), text: txt.slice(0, 90) });
    }
  } catch {}
  return out.slice(-(Number(limit) || 8));
}

/* 这条说说有没有「能评的东西」。无实义的重复堆叠（发疯文学/只刷表情）一律不评：
 * 她的硬标准是「不许发任何可能是低分的回复」——没话说就不说，跳过不算低分。 */
function hasSubstance(text) {
  const t = stripPunct(String(text || '').replace(/\[em\]e\d+\[\/em\]/gi, ''));
  if (t.length < 6) return false;
  const uniq = new Set(t.split('')).size / t.length;
  if (uniq < 0.45) return false;                 // 同一两个字反复堆
  if (/(.{2,4})\1{2,}/.test(t)) return false;    // 同一段刷三遍以上
  return true;
}

/* ===== 机械闸门：出现的直接判不合格（宁可这轮不发）===== */
const GATE = [
  { re: /[?？]/, why: '带问号（评论里提问=容易被当成客服/AI）' },
  { re: /群里|群聊|私聊|你说过|你上次|你刚才|聊天|对话过|上次聊/, why: '提到了群聊/私聊里的事' },
  { re: /动态|说说|这条|这篇|评论区|转发|刷到/, why: '旁白词（你在评论，不是在汇报）' },
  { re: /作为(一个)?(AI|ai|人工智能|语言模型|机器人)|我是(一个)?(AI|ai|人工智能|语言模型|机器人)/, why: '自曝是 AI' },
  { re: /是指|意思是|也就是说|据了解|一般来说|简单来说|其实是指/, why: '解释腔/百科腔' },
  { re: /^(哈|嘿|嗯|哦|啊|呵|额|呃)+[。！!~～]*$/, why: '只有笑声/嗯哦，空回复' },
  { re: /不错|加油|支持你|祝(你|福)|棒棒|厉害了|好厉害|羡慕|冲鸭|冲冲冲|yyds|绝了/, why: '空话套话/口号' },
  { re: /为你(高兴|开心|骄傲)|恭喜|祝福|真棒|太棒|好棒|了不起|不容易啊|真好呀|太幸福/, why: '纯祝贺/纯捧场，没接他的话' },
  { re: /^(这|那)?(真|太|好)(是|好|棒|美|香|可爱|厉害)/, why: '只有评价没有内容' },
  { re: /^(确实|真的|对的|是的是的|同意)[。！!]*$/, why: '敷衍式赞同' },
];

function stripPunct(s) {
  return String(s || '').replace(/[\s，。！？、~～…\.\!\?,:：;；"'「」『』()（）【】\[\]\-—]/g, '');
}

/* 与原文的连续重合（≥6 个字照搬 = 复读） */
function echoes(text, src) {
  const a = stripPunct(text), b = stripPunct(src);
  if (!a || !b) return false;
  for (let i = 0; i + 6 <= a.length; i++) {
    if (b.indexOf(a.slice(i, i + 6)) >= 0) return true;
  }
  return false;
}

/* 返回 {ok:true} 或 {ok:false, why} */
function gate(text, srcText) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: '空' };
  if (/^skip[。!！]?$/i.test(t)) return { ok: false, why: '模型自己判了没话说（SKIP）' };
  const bare = t.replace(/\[em\]e\d+\[\/em\]/g, '').trim();   // 去掉表情代码再算长度/判内容
  if (!bare) return { ok: false, why: '只有表情没有话' };
  // cap=0 表示这个平台的上限还没实测过 —— 那就**不做长度判断**（2026-11-18 主人令：
  // 原来这里 `|| 60` 的 60 是我拍的，不是官方上限，已删）。要限制就先「测动态上限」实测。
  const cap = platLimits.capOf('qzone');
  if (cap > 0 && bare.length > cap) return { ok: false, why: '超过 ' + cap + ' 字' };
  if (bare.length < 2) return { ok: false, why: '太短' };
  for (const g of GATE) if (g.re.test(t)) return { ok: false, why: g.why };
  if (echoes(bare, srcText)) return { ok: false, why: '复读了对方的话' };
  return { ok: true };
}

/* ===== 跨人重复检测（防机器特征，不是质量门）=====
 * 主人 2026-11-18 令：「同一条评论发给一堆人」是腾讯判营销号／机器号的典型特征。
 * 质量归 gate 管（好不好）；这里只管**我是不是在复读自己**（像不像机器）。
 * 判据：归一化后完全相同，或 3-gram Jaccard ≥ 0.55，算「太像」。
 * 被判太像的那条不发、重生成一次；两次都像就这条跳过（宁可少一条，别留机器味）。 */
function normCmt(s) {
  return String(s || '').replace(/[\s，。！？、~～…!?:：;；"'「」『』()（）【】\[\]\-—]/g, '');
}
function grams3(s) {
  const t = normCmt(s);
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  if (!out.size && t) out.add(t);
  return out;
}
function similarCmt(a, b) {
  const na = normCmt(a), nb = normCmt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = grams3(a), B = grams3(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  if ((inter / (A.size + B.size - inter)) >= 0.5) return true;
  // 开场 6 个字一模一样 = 同一套开场白（「键盘敲得欢，室友…」「隔着屏幕都替你抖…」这类模板味）
  return na.length >= 6 && nb.length >= 6 && na.slice(0, 6) === nb.slice(0, 6);
}
/* 我自己最近发过的评论原文（去重判据只看记录文件，不另存一份） */
function recentOwnComments(n) {
  return readAll().slice(-Math.max(1, Number(n) || 10))
    .map(e => String(e.comment || '')).filter(Boolean);
}

/* 命中红包梗的场合？命中就原样发模板，不让模型改写（她给的是定稿） */
function wantsRedPacket(text) {
  const t = String(text || '');
  return RED_PACKET_HIT.some(re => re.test(t));
}

/* 说说链接（主人点开就能看到这条 + 我们的评论） */
function linkOf(qq, tid) {
  return 'https://user.qzone.qq.com/' + String(qq) + '/mood/' + String(tid);
}

/* ===== 状态 ===== */
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_F, 'utf8'));
    return {
      lastRunAt: Number(j.lastRunAt) || 0,
      visited: j.visited && typeof j.visited === 'object' ? j.visited : {},   // qq -> 上次逛的时间戳
      commented: j.commented && typeof j.commented === 'object' ? j.commented : {}, // "qq|tid" -> ts
      day: j.day && typeof j.day === 'object' ? j.day : { date: '', n: 0 },
      skipped: Array.isArray(j.skipped) ? j.skipped.slice(-50) : [],
    };
  } catch {
    return { lastRunAt: 0, visited: {}, commented: {}, day: { date: '', n: 0 }, skipped: [] };
  }
}
function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_F), { recursive: true });
    const tmp = STATE_F + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_F);
  } catch {}
}
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ===== 选人：人物列表里所有有 QQ 号的人（排自己、排除机器人自己）===== */
function peopleWithQQ(opt) {
  const o = opt || {};
  const self = String(o.selfQQ || '');
  const skip = new Set((o.skipQQ || []).map(String));
  const out = [];
  for (const p of people.all()) {
    const qqs = people.qqAccountsOf(p.pid);
    const qq = qqs.find(q => q !== self && !skip.has(q));
    if (!qq) continue;
    out.push({
      pid: p.pid,
      qq,
      name: p.name || p.nick || '',
      alias: p.alias || '',
      favor: p.favor,
      favorLock: !!p.favorLock,       // 主人这类锁定号：逛的时候排最后（她本来就在身边）
    });
  }
  return out;
}

/* 最久没逛过的先逛（同一天别重复逛同一个人）；都没逛过时好感高的先来。
 * 锁定号（主人）永远排最后：她本来就在身边，出去逛先逛别人。 */
function orderByStaleness(list, st) {
  return list.slice().sort((a, b) => {
    if (!!a.favorLock !== !!b.favorLock) return a.favorLock ? 1 : -1;
    const va = Number(st.visited[a.qq] || 0);
    const vb = Number(st.visited[b.qq] || 0);
    if (va !== vb) return va - vb;
    return b.favor - a.favor;
  });
}

/* ===== 选动态 =====
 * 排除：评过的、纯转发没自己话的、太旧的（默认 30 天）、只有图没字也照评（有图有字最好）。
 * 优先：有正文、近期、评论数少的（评论少说明还没被人刷过，我们一条更显眼也更像随手留言）。 */
function pickMood(moods, st, qq, opt) {
  const o = opt || {};
  const maxAgeDays = Number(o.maxAgeDays || 30);
  const now = Date.now() / 1000;
  const done = doneSet();
  for (const k of Object.keys(st.commented || {})) done.add(doneKey('qzone', k));
  const rows = (moods || []).filter(m => {
    if (!m || !m.tid) return false;
    if (done.has(doneKey('qzone', qq + '|' + m.tid))) return false;   // 记录文件 + state 任一命中都不碰
    const t = Number(m.time) || 0;
    if (t && now - t > maxAgeDays * 86400) return false;
    const txt = String(m.text || '').trim();
    if (!txt) return false;                        // 没有正文（纯图/纯转发）不评：没字就没依据，硬评必低分
    if (!hasSubstance(txt)) return false;          // 无实义的刷屏/发疯文学不碰
    if (m.rt_tid && !m.rt_text) return false;      // 转发链看不到原文，也不碰
    return true;
  });
  if (!rows.length) return null;
  const score = m => {
    const txt = String(m.text || '').trim();
    let s = 0;
    if (txt.length >= 6) s += 40;
    if (txt.length >= 20) s += 10;
    if (m.pics) s += 15;
    s += Math.max(0, 20 - Math.min(20, Number(m.cmtnum) || 0));   // 评论越少越优先
    const t = Number(m.time) || 0;
    if (t) s += Math.max(0, 20 - Math.min(20, (now - t) / 86400));  // 越新越优先
    return s;
  };
  rows.sort((a, b) => score(b) - score(a));
  return rows[0];
}

/* ===== 落盘：每条评论一行，客户端列表读它 ===== */
/* 一条评论的落盘记录（唯一事实源：去重、待判、星标/标错都读它）。
 * verified 的语义（2026-11-17 实测校正）：**false ≠ 没发出去**。腾讯的 cmtnum 不即时更新——
 * 主人当天亲眼在对方空间看到评论已经在那了，而 cmtBefore/cmtAfter 都还是 0。
 * 所以 verified 只表示「评论数也变了」这条附加确认，不代表发送成败；发送成败看接口受理（code=0）。 */
function record(entry) {
  const o = Object.assign({ t: new Date().toISOString() }, entry);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG_F, JSON.stringify(o) + '\n', 'utf8');
    botWrite('data/qzone-friend-comments.jsonl', '逛空间评论',
      (o.name || o.qq) + '：' + String(o.comment || '').slice(0, 40));
  } catch {}
  return o;
}
function readAll() {
  try {
    return fs.readFileSync(LOG_F, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function recent(n) {
  return readAll().slice(-(Number(n) || 30)).reverse();
}

/* 撞到限流时记一笔（2026-11-17 主人令：额度上限要靠真实数据测）。
 * 写进 skipped 供 qzone-probe.learnPassive 学「每天几条 / 最少隔多久」，同时设冷却，
 * 免得刚被挡住就立刻又去撞、把封禁时间拉长。 */
const LIMIT_RE = /超限|限制|频繁|限流|风控|501|not implemented|too many|too frequent/i;
function noteLimit(why, qq) {
  const st = readState();
  st.skipped = (st.skipped || []).slice(-49).concat([{
    t: new Date().toISOString(), qq: String(qq || ''), name: '',
    why: '限流：' + String(why || '').slice(0, 100), text: '',
  }]);
  // 撞到限流不是「等 30 分钟就好」——501/风控的恢复期实测是 15 分钟到 1 小时，
  // 而且刚撞完是最敏感的时候。保守取 2 小时，宁可少评一轮也别把封禁拉长。
  st.cooldownUntil = Date.now() + 2 * 60 * 60 * 1000;
  writeState(st);
  return { ok: true, cooldownUntil: st.cooldownUntil };
}

/* ===== 「这条是不是已经留过言」——唯一事实源是记录文件，不是内存也不是 state =====
 * 主人 2026-11-17 硬标准：同一条说说只发一条评论；B 站动态同理。
 * 所以去重做成平台无关：key = 平台:目标。qzone → "qzone:<qq>|<tid>"，bili → "bili:<动态id>"。
 * B 站那一轮直接用 alreadyDone('bili', 动态id) / record({platform:'bili', ...})，不再各写一套。 */
function doneKey(platform, target) { return String(platform || 'qzone') + ':' + String(target || ''); }
function doneSet() {
  const s = new Set();
  for (const e of readAll()) {
    const p = String(e.platform || 'qzone');
    const tgt = p === 'qzone' ? (String(e.qq || '') + '|' + String(e.tid || '')) : String(e.tid || e.target || '');
    if (tgt) s.add(doneKey(p, tgt));
  }
  return s;
}
/* target：qzone 传 "qq|tid"，其它平台传动态/视频 id */
function alreadyDone(platform, target) {
  const p = String(platform || 'qzone');
  const t = String(target || '');
  if (!t) return false;
  if (doneSet().has(doneKey(p, t))) return true;
  const st = readState();
  const k = (p === 'qzone') ? t : (p + '|' + t);
  return !!st.commented[k];
}

/* ===== 合规判定：这里只管“这条判过了没、落到哪个池” =====
 * 判定标准不在这里自造——合规进**星标**（正面样本），不合规进**标错**（待修复负例），
 * 两个池都在 core 里，判定动作由 core.qzoneJudge 统一做，客户端和私信都调它。
 * 本文件只提供三样：还没判的列表、按 key 找条目、写“已判”标记。 */
function keyOf(e) { return String((e && e.qq) || '') + '|' + String((e && e.tid) || ''); }

/* 还没判的记录（新的在前）。私信里不带序号时判第一条。 */
function pending(limit) {
  return readAll().filter(e => !e.verdict).reverse().slice(0, Number(limit) || 5);
}

function findByKey(key) {
  const all = readAll();
  for (let i = all.length - 1; i >= 0; i--) if (keyOf(all[i]) === String(key)) return { entry: all[i], idx: i, all };
  return { entry: null, idx: -1, all };
}

/* 标记已判：pool = 'star'（合规，已进星标）| 'issue'（不合规，已进标错） */
function markVerdict(key, pool, note, by) {
  const { entry, idx, all } = findByKey(key);
  if (!entry) return { ok: false, error: '没找到这条记录' };
  if (entry.verdict) return { ok: false, error: '这条已经判过了（' + (entry.verdict === 'star' ? '合规' : '不合规') + '）' };
  all[idx].verdict = String(pool);
  all[idx].verdictAt = new Date().toISOString();
  all[idx].verdictBy = String(by || '');
  if (note) all[idx].verdictNote = String(note).slice(0, 80);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = LOG_F + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, all.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, LOG_F);
  } catch (e) { return { ok: false, error: '写不进去：' + e.message }; }
  return { ok: true, entry: all[idx] };
}

/* 她私信回的那句话 → { verdict, nth, note }。判不出就返回 null（当普通聊天处理）。
 * 词表故意收得很紧：只认「合规/合格/不合规/不合格/这条不行/低分」这类明确判词。
 * 「好的」「可以」「行」这种日常回话**不算**判定——否则她正常聊天会被吞掉。 */
function parseVerdict(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return null;
  let bad = false, rest = '';
  let m = t.match(/^(不合规|不合格|这条不行|这条不合格|低分|差评)(?:[\s,，。:：]*(.*))?$/);
  if (m) { bad = true; rest = String(m[2] || '').trim(); }
  else {
    m = t.match(/^(合规|合格|这条可以|这条行)(?:[\s,，。:：]*(.*))?$/);
    if (!m) return null;
    rest = String(m[2] || '').trim();
  }
  // 「合规 2」→ 判第 2 条；「不合规 2 太敷衍」→ 第 2 条 + 理由
  let nth = 0;
  const n = rest.match(/^(\d{1,2})\b[\s,，。:：]*(.*)$/);
  if (n) { nth = Number(n[1]); rest = String(n[2] || '').trim(); }
  return { verdict: bad ? 'bad' : 'ok', nth, note: rest.slice(0, 60) };
}

/* 从链接里认人认动态：她直接贴着链接回「不合规」也能对上 */
function keyFromLink(text) {
  const m = String(text || '').match(/user\.qzone\.qq\.com\/(\d+)\/mood\/([A-Za-z0-9_\-]+)/);
  return m ? m[1] + '|' + m[2] : '';
}

/* ===== 真正跑一轮：拉说说 → 挑 → 生成 → 过门 → 发 =====
 * 客户端按钮（panel）和机器人定时（qq.js）都调这一个函数，不写第二套。
 * 生成函数由调用方注入（gen），因为 core 依赖本模块（取低分案例），这里不能 require core。
 *
 * opts = { gen(ctx), manual, onSent(entry), onMsg(text) }
 * 返回 { ok, sent, links:[], stopped }
 */
let _busy = false;
function configAll() { try { return require('./config').load(); } catch { return {}; } }
/* 逛空间的频率参数（2026-11-17 主人纠正后重写）。
 *
 * 上一版我错在哪：把《平台上限跟随》那套「上限必须来自实测」的规则套到频率上，
 *   又自己拍了四组边界（每 1–72 小时 / 每天 1–20 条 / 每次 1–50 人 / 1–365 天）。
 *   那些数字没有实测、没有平台依据，是我编的，还绕过了 platform-limits 单一数据源。
 * 现在：频率就是**可填参数，不设上限**——平台从没公开过「每天几条」这种上限，
 *   我不许虚构一个冒充规则。只保一个数学下限 1（0 小时/0 条没有意义，0 或空 = 用默认）。
 * 真正的「上限」只有一处，且必须来自单一数据源：**单条评论字数 ≤ platform-limits 的 qzone cap**，
 *   在 gate() 里按表拦，不写死数字。 */
const CONF_DEF = { everyHours: 3, maxPerDay: 3, maxPeople: 6, maxAgeDays: 30 };
/* 面板上主人能填的只有这一个数（2026-11-17「我自己设置的空间上限应该只有发布两条动态的间隔，
 * 两条评论间隔和动态间隔一致」）。它就是 config.qzone.everyHours —— 转发说说的间隔、
 * 逛空间的间隔、两条评论的间隔，三处共用同一个数，不另立第二套。 */
const CONF_FORM = ['everyHours'];
const CONF_LABEL = {
  everyHours: '间隔（小时）',
  maxPerDay: '每天最多几条评论', maxPeople: '每次最多逛几个人', maxAgeDays: '只评多少天内的说说',
};
/* 平台侧只有「每天几条评论」有公开口径（3 条/天），进 CONF_PLAT 跟随表重测；
 * 「相邻两个请求 ≥20 秒」也在表里，但那是请求节奏、不进可填项（visitGapMs）。
 * 两条评论的间隔不在这张表里——它等于主人设的 qzone.everyHours（见 commentGapMs）。 */
const CONF_PLAT = { maxPerDay: 'qzonePerDay' };
function platNum(key, dft) {
  try { return Number(require('./platform-limits').capOf(key)) || dft; } catch { return dft; }
}
/* 平台节奏（社区口径，见 platform-limits 里各项的 note）——运行时必须真执行，不然表就是摆设 */
function visitGapMs() { return Math.max(0, platNum('qzoneVisitGap', 20) * 1000); }
/* 两条评论间隔 = 主人设的那个间隔（qzone.everyHours），和「两条动态之间」共用同一个数。
 * 不用平台口径里的 10 分钟：那会变成第二个数字，主人 2026-11-17 明确要求一致。 */
function commentGapMs(conf) {
  const h = Number((conf && conf.everyHours) || CONF_DEF.everyHours) || CONF_DEF.everyHours;
  return Math.max(0, h * 3600 * 1000);
}
function platCap(k) {
  const key = CONF_PLAT[k];
  if (!key) return 0;
  try { return Number(require('./platform-limits').capOf(key)) || 0; } catch { return 0; }
}
/* 默认值 = 表 cap（实测更新后默认跟着变）；没表项的用自己的默认 */
function defOf(k) {
  const cap = platCap(k);
  return cap > 0 ? cap : (CONF_DEF[k] || 1);
}
function confOf(c) {
  const q = (c && c.qzone) || {};
  const f = q.friendComment || {};
  /* 间隔只认一个落点：config.qzone.everyHours（主人自己设的那个，也是两条转发之间的间隔）。
   * 填了保底 1、不设上限（她 2026-11-17：「频率不是平台上限，我不编边界」）。 */
  const hv = Number(q.everyHours);
  const everyHours = (q.everyHours == null || q.everyHours === '' || !isFinite(hv) || hv <= 0)
    ? defOf('everyHours')
    : Math.max(1, Math.round(hv));
  return {
    enabled: f.enabled !== false,
    everyHours,
    maxPerDay: defOf('maxPerDay'),          // 平台口径 3 条/天，不是可填项
    maxPeople: CONF_DEF.maxPeople,          // 一轮逛几个人：我方预算
    maxAgeDays: CONF_DEF.maxAgeDays,        // 只评多少天内：我方策略
    skipMaster: f.skipMaster !== false,     // 默认跳过主人自己的空间
  };
}

/* 面板要的一屏：当前值 / 默认 / 是不是主人手设的 / 有没有开 / 那条唯一可填的间隔（字数上限） */
function confView() {
  const c = configAll();
  const q = (c && c.qzone) || {};
  const now = confOf(c);
  const manual = {};
  // 只有间隔可手设，比对的就是顶层 qzone.everyHours
  const hv = Number(q.everyHours);
  if (q.everyHours != null && q.everyHours !== '' && isFinite(hv) && hv > 0 && Math.round(hv) !== defOf('everyHours')) {
    manual.everyHours = Math.round(hv);
  }
  let charsCap = null;
  try { charsCap = require('./platform-limits').get('qzone'); } catch {}
  const defaults = {};
  for (const k of Object.keys(CONF_DEF)) defaults[k] = defOf(k);
  return {
    enabled: now.enabled,
    now, manual, defaults, labels: CONF_LABEL,
    form: CONF_FORM,      // 面板上唯一可填的一项（间隔）
    skipMaster: now.skipMaster,
    charsCap,             // 单条评论字数（平台侧，只读显示）
  };
}
function pythonPath() {
  const own = (configAll().qzone || {}).pythonPath;
  if (own) return own;
  const base = path.join(require('os').homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default');
  if (process.platform === 'win32') {
    const w = path.join(base, 'Scripts', 'python.exe');
    return fs.existsSync(w) ? w : 'python';
  }
  const u = path.join(base, 'bin', 'python3');
  return fs.existsSync(u) ? u : 'python3';
}
function runPy(extra, timeout) {
  return new Promise(resolve => {
    const c = configAll();
    const ws = (c && c.napcatWsUrl) || 'ws://127.0.0.1:3001';
    const master = String((c && c.masterQQ) || '');
    const masters = [master].concat((c && c.masters) || []).filter(Boolean).join(',');
    const self = String((c && c.selfQQ) || '');
    const script = path.join(__dirname, 'scripts', 'qzone_stroll.py');
    const argv = [script, ws, master, masters, self].concat(extra || []);
    let done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    try {
      require('child_process').execFile(pythonPath(), argv,
        { timeout: timeout || 90000, maxBuffer: 16 * 1024 * 1024 }, (err, so) => {
          let r = null;
          try { r = JSON.parse((String(so).match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch {}
          fin(r || { ok: false, error: String((err && err.message) || '脚本没有输出').slice(0, 200) });
        });
    } catch (e) { fin({ ok: false, error: e.message }); }
    setTimeout(() => fin({ ok: false, error: '超时' }), (timeout || 90000) + 5000);
  });
}

async function runOnce(opts) {
  const o = opts || {};
  const gen = typeof o.gen === 'function' ? o.gen : null;
  if (!gen) return { ok: false, error: '没有生成函数' };
  if (_busy) { if (o.onMsg) o.onMsg('上一轮还在逛，等一下下～'); return { ok: false, error: 'busy' }; }
  const c = configAll();
  const conf = confOf(c);
  if (!o.manual && !conf.enabled) return { ok: false, error: '没开' };
  const st = readState();
  /* 撞顶冷却：noteLimit 记下 2 小时，之前只有写、没有任何地方读——等于摆设。
   * 现在真拦：冷却期内不再去拉空间（手动也拦，撞顶期间连手动一起停）。 */
  const cool = Number(st.cooldownUntil || 0);
  if (cool && Date.now() < cool) {
    const leftMin = Math.ceil((cool - Date.now()) / 60000);
    return { ok: false, error: '刚才撞到限流，还要等约 ' + leftMin + ' 分钟再逛', sent: 0, cooldown: true };
  }
  const d = today();
  if (!st.day || st.day.date !== d) st.day = { date: d, n: 0 };
  if (!o.manual && st.day.n >= conf.maxPerDay) return { ok: false, error: '今天额度用完了', sent: 0 };
  _busy = true;
  const out = { ok: true, sent: 0, links: [], stopped: '' };
  try {
    const selfQQ = String((c && c.selfQQ) || '');
    const skip = conf.skipMaster ? [String((c && c.masterQQ) || '')].concat((c && c.masters) || []) : [];
    let list = peopleWithQQ({ selfQQ, skipQQ: skip });
    // o.only：只逛指定 QQ（手动验证用，不暴露成聊天命令）。走的是同一套记录/占位/门，不是第二套链路。
    if (o.only) list = list.filter(p => String(p.qq) === String(o.only));
    list = orderByStaleness(list, st).slice(0, conf.maxPeople);
    let budget = o.manual ? 1 : Math.max(1, conf.maxPerDay - st.day.n);
    let failStreak = 0;                  // 连续拉取失败次数（501 限流时早点停）
    for (const p of list) {
      if (budget <= 0) break;
      /* 两条评论之间：和「两条动态之间」共用主人设的那一个间隔（qzone.everyHours）。
       * 放在最前面判——没到点就整轮不动，免得白拉空间、白跑模型。 */
      const gapMs = commentGapMs(conf);
      if (gapMs > 0 && st.lastCommentAt) {
        const passed = Date.now() - Number(st.lastCommentAt);
        if (passed < gapMs) {
          const leftMin = Math.ceil((gapMs - passed) / 60000);
          out.stopped = '距上一条评论才 ' + Math.round(passed / 60000) + ' 分钟，还要等约 '
            + (leftMin >= 60 ? Math.round(leftMin / 60) + ' 小时' : leftMin + ' 分钟')
            + '（间隔 ' + conf.everyHours + ' 小时）';
          break;
        }
      }
      if (!o.manual && st.visited[p.qq]) {
        const last = new Date(Number(st.visited[p.qq]));
        const pd = last.getFullYear() + '-' + String(last.getMonth() + 1).padStart(2, '0') + '-' + String(last.getDate()).padStart(2, '0');
        if (pd === d) continue;                      // 同一个人一天只逛一次
      }
      // 平台节奏：逛不同人的空间之间至少隔 qzoneVisitGap 秒（社区口径 20 秒）。
      // 上次 501 就是没留间隔连拉 77 个换来的，这条现在硬执行。
      const waitMs = Number(st.lastVisitAt || 0) + visitGapMs() - Date.now();
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      st.lastVisitAt = Date.now();      // 请求发出就算访问过（失败也算，确实打出去了）
      writeState(st);
      const r = await runPy(['--moods', p.qq + '|10']);
      // 拉不到 / 挑不到也要留原因（客户端能看到「这轮为什么没发」），不静默跳过
      const noteSkip = why => {
        st.skipped = (st.skipped || []).slice(-49).concat([{
          t: new Date().toISOString(), qq: p.qq, name: p.name || p.qq, why: String(why).slice(0, 120), text: '',
        }]);
      };
      if (!r || !r.ok) {
        const err = String((r && r.error) || '脚本没输出');
        noteSkip('拉不到说说：' + err);
        writeState(st);
        if (LIMIT_RE.test(err)) { noteLimit(err, p.qq); Object.assign(st, readState()); }
        out.stopped = err;
        // 连续失败=很可能被腾讯限流（501）。继续撞只会封更久，直接停这一轮，也别记「逛过」。
        failStreak += 1;
        if (failStreak >= 3) { out.stopped = '连续拉不到说说，先停（可能被限流）：' + out.stopped; break; }
        continue;
      }
      failStreak = 0;
      st.visited[p.qq] = Date.now();      // 只有真拉到才记「逛过」，失败不算
      writeState(st);
      const pick = pickMood(r.moods, st, p.qq, { maxAgeDays: conf.maxAgeDays });
      if (!pick) {
        const n = (r.moods || []).length;
        noteSkip(n ? ('这 ' + n + ' 条都不合适：已评过 / 没正文 / 超 ' + conf.maxAgeDays + ' 天 / 无实义') : '空间里没有可见的说说');
        writeState(st);
        continue;
      }
      const others = (r.moods || [])
        .filter(m => m.tid !== pick.tid && String(m.text || '').trim())
        .map(m => ({ text: String(m.text).slice(0, 120), time: m.time }));
      let text = '';
      if (wantsRedPacket(pick.text)) text = RED_PACKET;      // 她给的定稿，原样发，不改写（模板是她定的，不复读检测）
      else {
        // 跨人复读检测：新生成的跟我最近 10 条太像就不发（同句话发给一堆人＝机器特征）
        const avoid = recentOwnComments(10);
        for (let i = 0; i < 2 && !text; i++) {               // 最多两次，两次都不过门/都太像就不发
          let g = '';
          try { g = await gen({ name: p.name || p.qq, mood: pick, others }); } catch {}
          const v = gate(g, pick.text);
          const sim = v.ok ? avoid.find(x => similarCmt(g, x)) : '';
          if (v.ok && !sim) text = String(g).trim();
          else {
            st.skipped = (st.skipped || []).slice(-49).concat([{
              t: new Date().toISOString(), qq: p.qq, tid: pick.tid,
              why: v.ok ? ('跟我最近一条太像（机器味）：' + String(sim).slice(0, 24)) : v.why,
              text: String(g || '').slice(0, 80),
            }]);
          }
        }
      }
      if (!text) { writeState(st); continue; }               // 宁可不发
      // 硬保护（主人 2026-11-17「不能重复评同一条说说 / 同一条 B 站动态」）：
      // 发之前先占位——万一发送超时或进程被杀，评论已经出去了但没来得及记，
      // 下一轮也绝不会在同一条上再评一次。宁可少评一条，不重复。
      const ck = p.qq + '|' + pick.tid;
      st.commented[ck] = Date.now();
      writeState(st);
      // 评论数作为第 4 段带过去：脚本只写记录，不再为查这个数字多发两次网页请求
      const cmtBefore = (pick.cmtnum == null ? '' : String(pick.cmtnum));
      const sr = await runPy(['--do-comment', p.qq + '|' + pick.tid + '|' + text + '|' + cmtBefore]);
      if (sr && sr.ok && sr.commented) {
        st.day.n = (Number(st.day.n) || 0) + 1;
        st.lastCommentAt = Date.now();
        st.lastRunAt = Date.now();
        budget -= 1;
        const e = record({
          qq: p.qq, name: p.name || '', tid: pick.tid,
          src: String(pick.text).slice(0, 200), comment: text,
          link: linkOf(p.qq, pick.tid),
          verified: false,                       // 评论数不实时，不再拿它判成败（见 record 注释）
          cmtBefore: sr.cmtBefore, cmtAfter: null,
        });
        out.sent += 1;
        out.links.push(e.link);
        writeState(st);
        // onSent 允许异步（qq.js 那边要查群成员名单才知道共同群）；出错不影响这一轮
        if (o.onSent) { try { await o.onSent(e); } catch {} }
      } else {
        const err = String((sr && sr.error) || '发送失败');
        // 只有明确「没发出去」才撤销占位；超时/结果不明一律留着——可能已经发出去了
        if (/超时|timeout/i.test(err)) {
          st.skipped = (st.skipped || []).slice(-49).concat([{
            t: new Date().toISOString(), qq: p.qq, tid: pick.tid,
            why: '发送超时，可能已发出：已占位，不再重评这条', text: String(text).slice(0, 80),
          }]);
        } else {
          delete st.commented[ck];
        }
        writeState(st);
        out.stopped = err;
      }
    }
    writeState(st);
    if (!out.sent) out.stopped = out.stopped || '这轮没有合适的（都评过了，或生成的都没过低分门）';
    if (o.onMsg && !out.sent) o.onMsg(out.stopped);
    return out;
  } catch (e) {
    return { ok: false, error: e.message, sent: out.sent, links: out.links };
  } finally { _busy = false; }
}

module.exports = {
  RED_PACKET, RED_PACKET_HIT, LOW_SCORE_CASES, lowScoreExamples, GATE,
  gate, echoes, wantsRedPacket, linkOf, hasSubstance, stripPunct,
  readState, writeState, today,
  peopleWithQQ, orderByStaleness, pickMood,
  record, recent, readAll, runOnce, confOf, confView, runPy, noteLimit, LIMIT_RE,
  visitGapMs, commentGapMs, platNum,
  CONF_DEF, CONF_LABEL, CONF_PLAT, CONF_FORM, defOf, platCap,
  keyOf, pending, findByKey, markVerdict, parseVerdict, keyFromLink,
  doneKey, doneSet, alreadyDone,
  similarCmt, recentOwnComments, normCmt,
  STATE_F, LOG_F,
};
