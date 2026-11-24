/*
 * src/nl-command.js — 主人私聊「自然语言 = 指令」统一层（2026-11-19 主人令）
 *
 * 为什么要有这一层：
 *   主人原话：「我在私聊里肯定不会和虚幻聊天，都是发的这种指令，不要识别成对话，优先识别成指令。」
 *   面板的写入 / 修改 / 开关动作散在 app.js 的 data-act、panel.js 的 /api/*、state.js 的 setSwitch/setNum
 *   和几个零散命令函数里。这里不复制第二套落盘逻辑，只做「听懂人话 → 找到唯一动作 → 调原来的函数」。
 *
 * 硬边界：
 *   ① 管理类只有主人的号能进（QQ masterQQ/masters，B站 p_master 的号）；记录类（约定 / 换回约定 / 代称 /
 *      小本本 / 喜好 / 人设）对所有人生效（2026-11-19 主人令：「记录的」里都是所有人都能触发的改动数据的指令）。
 *   ② 命中即执行、回一条确认、不再喂模型；没认出也回一句「没改」，绝不把指令当聊天答。
 *   ③ 所有写动作都复用既有函数；执行后读回校验，校验不过不许报成功。
 *   ④ 纠错（标错）在所有场景都能进，但只记待修复 + 约定，不替主人删任何没点名的东西。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = __dirname;
const LOG = path.join(ROOT, 'data', 'nl-command.jsonl');
const S = v => String(v == null ? '' : v).trim();

/* 失败时回一行「可直接复制」的诊断串（主人 2026-11-19：「对不上就回具体报错啊，我好直接复制给你修」）。
 * 只放定位用的短值，不放整句原文，免得把聊天内容抄进群里。 */
function diag(action, o) {
  try { return '[指令失败] ' + JSON.stringify(Object.assign({ action: S(action) }, o || {})); }
  catch { return '[指令失败] ' + S(action); }
}
function errBrief(e) {
  const m = S(e && e.message) || String(e);
  const at = S((e && e.stack || '').split('\n')[1] || '').trim().replace(/^at\s+/, '');
  return m + (at ? ' @' + at.slice(0, 120) : '');
}

function logAction(o) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(Object.assign({ t: new Date().toISOString() }, o)) + '\n', 'utf8');
  } catch (e) { console.log('[指令] 日志写不进：' + e.message); }
}

/* 动作目录：LLM 只许从这里挑，不许自己发明接口。 */
const ACTIONS = [
  { id: 'alias_set', hint: '把某个号/某人记成另一个名字、代称、称呼；举证「这句话证明他叫X」' },
  { id: 'mark_wrong', hint: '标错、说错了、记错了、这条不对、以后别这么说；可带理由' },
  { id: 'recall', hint: '撤回她自己刚发出去的话：撤回、撤掉、把刚才那句删了；可指明「群里那句」' },
  { id: 'undo_last', hint: '撤销刚下的上一条指令（3 分钟内、所有人可用）：把这个约定删了、取消刚才那条约定、撤掉刚记的称呼' },
  { id: 'undo_ref', hint: '撤回回执里点名的那条指令（说话人自己的上一条，不限时间次数、所有人可用）：撤回这一条、撤掉这条' },
  { id: 'group_off', hint: '关闭某个群：不看也不回、停掉这个群、这个群别回了' },
  { id: 'group_on', hint: '打开/恢复某个群：重新看这个群、恢复这个群' },
  { id: 'persona_set', hint: '改虚幻的人设/长相/性格/身份（你是猫娘、你变成狐狸、你的发型改成短发）：主人改的是默认值，别人只改他自己看到的' },
  { id: 'persona_reset', hint: '把虚幻恢复原样：别这样了、变回原来的样子、人设恢复默认' },
  { id: 'switch_set', hint: '开/关功能开关：自动接话、凑热闹、话题、合并、联网搜索、学习' },
  { id: 'num_set', hint: '把某个数值改成多少：等待秒数、概率、上下文条数、字数上限' },
  { id: 'cfg_set', hint: '改面板里的任意一项（数值给 value、开关给 on）：参数 key 必须用目录里的键' },
  { id: 'trigger_add', hint: '加触发词：不用回复、适合回复、一定回复、喊我、固定话术' },
  { id: 'trigger_del', hint: '删触发词' },
  { id: 'person_name', hint: '给某个号/人物改名、确认名字；params: uid 或 pid + name' },
  { id: 'person_favor', hint: '把某人的好感度改成某个数；params: uid 或 pid + value' },
  { id: 'person_role', hint: '把某人的身份标成 认识的人 / 陌生人（朋友由朋友录决定，标朋友＝把好感调到 20 以上）；params: uid 或 pid + role' },
  { id: 'person_sex', hint: '把某人的性别标成 男 / 女；params: uid 或 pid + sex' },
  { id: 'ai_mark', hint: '把某个号标成 AI 账号（只建档、好感锁0、不记画像喜好）：ai账号123456、把123456标记成AI、标记某某为AI；params: uid 或 pid + platform' },
  { id: 'ai_unmark', hint: '把某个 AI 号改回人物（记豁免、解锁、以后不再自动判）：把123456改回人物、取消某某的AI标记；params: uid 或 pid + platform' },
  { id: 'person_call', hint: '主人给某人起/改称呼（「我喊他大萌新」「以后我管他叫X」）；params: uid 或 pid + call' },
  { id: 'person_lock', hint: '锁定/解锁某人的好感；params: uid 或 pid + on' },
  { id: 'person_region', hint: '把某人的所在地改成某个市/区；params: uid 或 pid + city' },
  { id: 'taste_add', hint: '记一条某人的喜好/讨厌；params: uid + sec(likeConf/hateConf) + text' },
  { id: 'fallback_add', hint: '往兜底词池加一句；params: line' },
  { id: 'conv_set', hint: '改某个会话的设置：这个群上下文几条、只看不回、拉黑、用本地模型、恢复默认；params: key + field + value' },
  { id: 'pause', hint: '暂停闭嘴：暂停群/私聊/某人，可带时长' },
  { id: 'allow', hint: '恢复说话：允许群/私聊/某人' },
  { id: 'memory_log', hint: '记到工作日志/小本本/长期记忆' },
  { id: 'pact_add', hint: '记成约定：以后每次都要这样' },
  { id: 'pact_switch', hint: '换回之前定过的那条约定：换回句尾加喵、改回原来那句；不删旧的，只把它排回最前' },
  { id: 'none', hint: '不是指令，只是普通聊天（主人私聊里很少见，但别硬猜）' },
];
const IDS = new Set(ACTIONS.map(a => a.id));

/* 主人的号：QQ 走 connect.json，B站走 people.json 里 p_master 的账号。 */
function isOwner(platform, uid) {
  const p = S(platform).toLowerCase() || 'qq';
  const id = S(uid);
  if (!id) return false;
  try {
    if (p === 'qq') {
      const c = require('./config').load();
      if (String(c.masterQQ || '') === id) return true;
      return (c.masters || []).map(String).indexOf(id) >= 0;
    }
    const people = require('./people');
    const master = people.get('p_master') || {};
    return (master.accounts || []).some(a => people.normPlat(a.platform) === people.normPlat(p) && String(a.id) === id);
  } catch { return false; }
}

/* 撤回通道由平台连接器注册（qq.js 启动时接上），避免 nl-command ↔ qq.js 循环依赖。 */
let recaller = null;
function setRecaller(fn) { recaller = typeof fn === 'function' ? fn : null; }

/* 从「翻译证据」里认人和号。转发记录每行形如：昵称(123456): 话。
 * 返回带位置，供 targetAccount() 判断「被叫的是哪个号」。 */
function extractAccounts(text) {
  const out = [];
  const src = String(text || '');
  // 号后面可能直接跟中文、没有空格：「2650321894叫皮皮」「123456说」——
  // 以前后瞻只认空白/标点，这种粘连写法整个号都对不上，指令层就回「没认出」（2026-11-19 主人实测踩到）。
  const re = /(?:^|[\s(（【\[，,:：])(?:@|qq|q号|q|bilibili|bili|号)?\s*([0-9]{5,12})(?=[)\）】\]\s:：，,。！？!?]|$|[\u4e00-\u9fa5])/gi;
  let m;
  while ((m = re.exec(src))) {
    const whole = String(m[0]);
    const prefix = S(whole.replace(/[0-9]{5,12}/, '')).toLowerCase();
    const platform = /bili/.test(prefix) ? 'bili' : 'qq';
    const id = S(m[1]);
    const at = m.index + whole.indexOf(id);
    const dup = out.find(x => x.id === id);
    if (dup) dup.hits.push(at); else out.push({ platform, id, at, hits: [at] });
  }
  return out;
}

/* 「证明 654321 叫 xxx」「这句话里 123456 这么说，证明他叫 xxx」——被叫的是哪个号？
 * 判据优先级：① 离「叫/喊/称呼」最近、且在它前面的那个号；② 全文只剩一个号时就是它。
 * 两个号都在、又都离得远 → 返回 null，让上层回一句问清楚，绝不靠猜记错人。 */
function targetAccount(text) {
  const src = String(text || '');
  const accs = extractAccounts(src);
  if (!accs.length) return null;
  const kw = /(叫|喊|称呼|叫做)/g;
  let kAt = -1, m;
  while ((m = kw.exec(src))) kAt = m.index;      // 取最后一个「叫」：通常是「证明…叫X」那句
  if (kAt >= 0) {
    let best = null;
    for (const a of accs) {
      for (const h of a.hits) {
        if (h < kAt && kAt - h <= 60) {
          if (!best || h > best.h) best = { a, h };
        }
      }
    }
    if (best) return { platform: best.a.platform, id: best.a.id };
  }
  // 兜底：全文只有一个号，才敢认
  const ids = Array.from(new Set(accs.map(a => a.id)));
  if (ids.length === 1) return { platform: accs[0].platform, id: accs[0].id };
  return null;
}

/* 「名字改成 X」「改名叫 X」「姓名设为 X」——改的是**名字位**（面板第一列），不是代称。
 * 主人 2026-11-19 实测：「直接发某人叫什么改不了」——以前只认「叫」写成代称，
 * 面板名字列没变，看着就是没改。这里把「名字/姓名/大名/真名 + 改成/叫/是」单独认出来。 */
function extractRenameName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(?:名字|姓名|大名|真名|名称)\s*(?:改成|改为|换成|换为|设成|设为|调成|叫做|叫|是|为)\s*[「『"']?([^\s，。！？、,!?；;：:"」』]{1,16})/)
    || t.match(/改名(?:叫|为|成|作)?\s*[「『"']?([^\s，。！？、,!?；;：:"」』]{1,16})/);
  if (!m) return '';
  const n = S(m[1]).replace(/^(?:做|为|作|叫)/, '');
  if (!n || /^(?:什么|啥|谁|哪个|哪位|什么名字|啥名|多少)$/.test(n)) return '';
  if (/[。！？!?，,；;：:]/.test(n)) return '';
  return n;
}

/* 「把小明改名叫大明」里的「小明」——要改名的那个人（名字或号）。 */
function extractRenameTarget(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(?:把|给|帮)\s*[「『"']?([^\s，。！？、,!?；;：:「」『』"']{1,20})[」』"']?\s*(?:的)?\s*(?:名字|姓名|大名|真名|名称|改名)/)
    || t.match(/^[「『"']?([^\s，。！？、,!?；;：:「」『』"']{1,20})[」』"']?\s*(?:的)?\s*(?:名字|姓名|大名|真名|名称|改名)/);
  return m ? S(m[1]) : '';
}

/* 触发词的自然说法 → 已有命令格式（core.triggerCommand 认的是「不用回复：xxx」）。
 * 「加个触发词 不用回复 天王盖地虎」→「不用回复：天王盖地虎」。 */
function normalizeTrigger(text) {
  let s = S(text).trim();
  s = s.replace(/^(?:请|帮我|给我)?\s*(?:加|添加|新增|记)\s*个?\s*触发词\s*[:：]?\s*/, '');
  s = s.replace(/^(不用回复|适合回复|一定回复|必须回复|喊我|叫我|接话|固定话)\s*[:：]?\s*/, '$1：');
  return s;
}

/* 触发词动作的「真命令」判定（2026-11-25）：
 * 只认 core.triggerCommand 真正支持的写法；认不出就返回空串，让上层判失败或放回聊天。
 * 顺带吃掉模型自造的参数键（trigger / word / words / triggerWord）——
 * semantic 会把 params 原样合并进 cmd，模型写什么键都有可能出现。 */
function triggerCommandOf(cmd) {
  const c = cmd || {};
  const first = [c.command, c.trigger, c.word, c.words, c.triggerWord]
    .map(x => S(x)).filter(Boolean)[0] || '';
  if (!first) return '';
  const s = normalizeTrigger(first);
  if (/^(不用回复|适合回复|一定回复|必须回复|喊我|叫我|接话|固定话)[：:]\s*\S/.test(s)) return s;
  if (/^(看)?(回复策略|触发词)$/.test(s)) return s;
  if (/^删(触发词|不用回复|适合回复|一定回复)\s*\d+$/.test(s)) return s;
  return '';
}

/* 一句话里要动的是谁：先按号（离关键词最近），没有再按名字找（唯一命中）。 */
function resolveTarget(text, kwSrc) {
  const acc = accountNear(text, kwSrc);
  if (acc) return acc;
  const t = String(text || '');
  const who = extractRenameTarget(t) || (t.match(/(?:把|给|帮)\s*[「『"']?([^\s，。！？、,!?；;：:「」『』"']{1,20})/) || [])[1];
  const per = who ? personByName(who) : null;
  return per ? { platform: per.platform, id: per.id, pid: per.pid } : null;
}

/* 「离某组关键词最近、且在它前面的号」。改名 / 好感 / 触发词这些句子不一定带「叫」，
 * 不能复用 targetAccount（它只认「叫/喊/称呼」）。 */
function accountNear(text, kwSrc) {
  const src = String(text || '');
  const accs = extractAccounts(src);
  if (!accs.length) return null;
  const ids = Array.from(new Set(accs.map(a => a.id)));
  if (ids.length === 1) return { platform: accs[0].platform, id: accs[0].id };
  const kwRe = new RegExp(kwSrc, 'g');
  let kAt = -1, m;
  while ((m = kwRe.exec(src))) kAt = m.index;
  if (kAt < 0) return null;
  let best = null;
  for (const a of accs) for (const h of a.hits) {
    if (h < kAt && kAt - h <= 60) { if (!best || h > best.h) best = { a, h }; }
  }
  return best ? { platform: best.a.platform, id: best.a.id } : null;
}

/* 按名字 / 资料卡名 / 群名片找人（话里没带号时用）。只有唯一命中才认，重名不猜。 */
function personByName(name) {
  const nm = S(name).replace(/\s+/g, '');
  if (!nm || nm.length > 20) return null;
  let people;
  try { people = require('./people'); } catch { return null; }
  const hits = [];
  for (const row of people.all()) {
    const pool = [];
    for (const x of people.namesOf(row.pid)) pool.push(x);
    for (const a of (row.accounts || [])) {
      pool.push(a.nick);
      for (const c of Object.values(a.cards || {})) pool.push(c);
    }
    if (pool.map(x => String(x || '').replace(/\s+/g, '')).indexOf(nm) >= 0) hits.push(row);
  }
  if (hits.length !== 1) return null;
  const row = hits[0];
  const acc = (row.accounts || []).find(a => a && a.id) || null;
  return { pid: row.pid, platform: acc ? people.normPlat(acc.platform) : 'qq', id: acc ? String(acc.id) : '' };
}

/* AI 标记专用认人（2026-11-23 主人原话「ai账号4015881213」）：
 * 通用 extractAccounts 要求号码前面是空白/标点/@/qq/号，而「账号4015881213」的号紧贴在「账」后，
 * 抠不出来；所以这里单独放宽——直接认「(ai|机器人)?账号 + 数字」和动作词后面的裸号，
 * 认不到再退回 personByName（按名字）。返回 { platform, id, pid } 或 null。
 * 只在 AI 标记的分支里用，不改通用认人，避免放宽后影响别的指令。 */
function resolveAiTarget(text) {
  const src = String(text || '');
  // 「ai账号4015881213」「AI账号 4015881213」「机器人账号123456」——号紧贴「账号」也能抠
  const m = src.match(/(?:ai|机器人|robot)?\s*账号\s*[:：]?\s*([0-9]{5,12})/i)
    // 动作词 + 号：「标记123456」「改回123456」「取消123456」
    || src.match(/(?:标记|标成|标为|设为|设成|改回|恢复|取消|解除)\s*[:：]?\s*([0-9]{5,12})/)
    // 号 + 动作词：「123456标记成AI」「123456改回人物」（主人原话顺序）
    || src.match(/([0-9]{5,12})\s*(?:标记|标成|标为|设为|设成|改回|恢复|取消|解除)/);
  if (m) return { platform: 'qq', id: String(m[1]) };
  // 没带「账号」二字的：认「把/给/帮 + 号」，或全文唯一的号
  const acc = resolveTarget(src, 'AI|ai|标记|账号|机器人|人物');
  return acc || null;
}

function extractCallName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();

  // 问句不改名：「592667172 叫什么」「他叫啥」「这人叫什么名字」都是提问，
  // 以前会把「什么」当成名字写进代称（2026-11-19 主人测出来的）。
  if (/(叫什么|叫啥|叫什么呢|叫什么名字|叫啥名|名字叫什么|是哪位|是谁)/.test(t)
    && !/(改成|改为|记成|记下来|以后就|以后叫|就叫)/.test(t)) return '';

  // 本人自报优先：「以后叫我 XX」「就叫我 XX 就行」。
  // 单独先扫一遍是为了不吃掉「我」——通用式里「叫我 X」会截到「我」。
  const self = t.match(/叫我\s*[「『"']?\s*([^\s，。！？、,!?；;：:"」』]{1,16})/);
  if (self) {
    const n = S(self[1]).replace(/^(?:做|为|作)/, '');
    if (n && !/^(?:就行|就好了?|吧|啊|呀|哦|什么|啥|谁)$/.test(n) && !/[。！？!?，,；;：:]/.test(n)) return n;
  }

  // 「证明他叫Ayami」「说明这个号叫萌梓哥哥」「以后叫他 FromGod Jungle」
  const m = t.match(/(?:证明|说明|可见|就是|所以|原来|应该是)?\s*(?:这(?:个|位|句)|他|她|它|某人|某号|这个号|那个号)?\s*(?:叫|喊|称呼(?:为|作)?|叫做)\s*[「『"']?([^\s，。！？、,!?；;：:"」』]+)[」』"']?/);
  if (!m) return '';
  const name = S(m[1]).replace(/^(?:做|为|作)/, '');
  // 名字最多 16 字、不许带整句标点/动词短语；疑问词不是名字；面板手写的怪名照样放行
  if (!name || /^(?:什么|啥|谁|哪个|哪位|什么名字|啥名)$/.test(name)
    || name.length > 16 || /[。！？!?，,；;：:]/.test(name)) return '';
  return name;
}

/* 「我（就）叫 XX」——自报名字（2026-11-19 主人令：别人 @ 她之后说自己叫什么，第一优先）。 */
function extractSelfName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/我\s*(?:就|平时|一般|其实|真的)?\s*叫\s*[「『"']?([^\s，。！？、,!?；;：:"」』]{1,16})/);
  if (!m) return '';
  const n = S(m[1]);
  if (!n) return '';
  if (/^(?:什么|啥|谁|什么名字|啥名|多少)$/.test(n)) return '';
  if (/^[你他她它]/.test(n)) return '';            // 「我叫你小明」不是自报
  if (/[。！？!?，,；;：:]/.test(n)) return '';
  return n;
}

/* 「你是一个猫娘」「你变成猫娘了」「你的发型改成短发」——改变人设 / 长相的话（2026-11-19 主人令）。
 * 能归到某一项上的 → 落状态的人设层（按人挂，取代默认；同一个 who 只有一条，细节并进去越记越细）。
 * 一条装不下的那部分才落「约定」——约定是兜底（见 conv-state 的 PERSONA_CAP）。
 * 问句（你是谁 / 你是猫娘吗 / 你是不是…）、假设（如果你是…）、否定（你不是…）一律不动。 */
const PERSONA_TOPICS = ['头发弯曲度', '发型', '发色', '发丝', '前发', '头发', '眼睛颜色', '眼睛', '体型', '性别', '本质', '身体颜色', '长相', '外貌', '性格', '身份', '名字', '姓名', '名称', '自称'];
function extractPersona(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // 问句 / 假设 / 否定 ——— 都不是设定
  if (/(吗|嘛)[？?]?\s*$/.test(t)) return null;
  if (/[?？]\s*$/.test(t) && !/(改成|改为|变成|设为)/.test(t)) return null;
  if (/(你是谁|你是啥|你是哪|你是干|你是咋|你是怎|你是为|你是多|你是几|你是男|你是女|你是做什么|你是什么|你是不是|你算不算|像不像|你能不能|你可不可以|你会不会)/.test(t)) return null;
  if (/(如果|假如|要是|假设|比如|就像|好像|感觉|觉得)/.test(t)) return null;
  if (/(你不是|你不再是|你才不是|你不是要)/.test(t)) return null;

  // ① 单项：你的发型改成短发 / 眼睛变成蓝色 / 性格改成傲娇
  const one = t.match(new RegExp('(?:虚幻|你)的?\\s*(' + PERSONA_TOPICS.join('|') + ')\\s*(?:改成|改为|改回|换成|换回|变成|成了|设为|设成|是|为|叫)\\s*[「『"\']?([^，。！？、,!?；;：:"」』]{1,40})'));
  if (one) {
    const v = S(one[2]).replace(/^(?:一(?:个|只|位|名|条)?)/, '').replace(/[吧啊呀哦呢了]+$/, '');
    // 「名字改回默认 / 原来的」不是设定，交给 persona_reset 恢复默认
    if (/^(?:默认|原来|原本|原来的|原本的|以前那个|以前)$/.test(v)) return null;
    if (v && !/^(?:什么|啥|谁|哪|多少)$/.test(v)) return { topic: S(one[1]), text: v };
  }

  // ② 整体：你是一个猫娘 / 你是猫娘 / 你变成狐狸了
  const all = t.match(/(?:虚幻|小虚幻|你)\s*(?:以后|现在|从此|之后|今天起)?\s*(?:就|已经|真)?\s*(?:是|变成|成为|化身成|化身)\s*(?:一(?:个|只|位|名|条))?\s*[「『"']?([^，。！？、,!?；;：:"」』]{1,40})/);
  if (all) {
    const v = S(all[1]).replace(/[吧啊呀哦呢了]+$/, '');
    // 「你是对的」「你是好人」「你是真的」这类日常应答不是人设
    if (!v || /^(?:对的?|错的?|真的|假的|好人|坏蛋|笨蛋|傻子|傻的|要的|行的|可以的|没事|什么|啥|谁|哪|多少|不是)$/.test(v)) return null;
    if (/^我/.test(v)) return null;
    return { topic: '人设', text: v };
  }
  return null;
}

/* 「变回原来的样子」——恢复默认（主人删全局，别人删他自己的那份）。 */
function extractPersonaReset(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (/(约定|代称|状态)/.test(t) && /(恢复|还原|重置|取消|删掉|忘掉)/.test(t)) return '';
  // 名字恢复默认（2026-11-25）：只认「恢复/还原/重置/删掉」和「改回默认/原来的」；「名字改回虚幻」是设定，不是恢复
  if (/(名字|姓名|名称|自称)/.test(t) && /(恢复|还原|重置|取消|删掉|忘掉)/.test(t)) return '名字';
  if (/(名字|姓名|名称|自称)/.test(t) && /改回(?:原来|原本|默认)/.test(t)) return '名字';
  if (/(人设|设定)/.test(t) && /(恢复|还原|重置|取消|删掉|忘掉)/.test(t)) return '人设';
  if (/(变回|恢复成?)(?:原来|原本|默认)(?:的)?(?:样子|人设|虚幻)/.test(t)) return '人设';
  return '';
}

function extractReason(text) {
  const t = String(text || '');
  const m = t.match(/(?:理由|原因|因为)[:：]?\s*([^\n]{1,120})/);
  if (m) return S(m[1]);
  const tail = t.split(/[，,；;]/).slice(-1)[0];
  return S(tail).slice(0, 120);
}

/* 群号从哪来：① 话里直接带的号；② 话里说的群名（group-names.json 反查）。
 * 2026-11-19 修：以前这里还有一条「拿当前会话键当群号」的兜底——私聊里说的话，
 * convKey 是 qq_<主人QQ>，那条兜底会把主人的遥控私聊当成群关掉，等于自己掐断遥控。
 * 现在私聊场景（ctx.isPrivate）一律不走会话键兜底：认不出群就回一句问，不乱关。 */
function extractGid(text, ctx) {
  const t = String(text || '');
  let m = t.match(/(?:群|group)\s*[:：]?\s*([0-9]{5,12})/i) || t.match(/@([0-9]{5,12})/);
  if (m) return S(m[1]);

  // 按群名找：话里出现哪个群名就是哪个群（取最长的那个，避免「翰加班」误中「翰加班 宅禁送」）
  try {
    const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'group-names.json'), 'utf8')) || {};
    const hit = Object.entries(names)
      .filter(([, n]) => S(n) && t.indexOf(S(n)) >= 0)
      .sort((a, b) => S(b[1]).length - S(a[1]).length)[0];
    if (hit) return S(hit[0]);
  } catch { /* 没有群名表就只认号 */ }

  if (ctx && !ctx.isPrivate && /^qq_(\d+)$/.test(S(ctx.convKey))) return S(ctx.convKey).slice(3);
  return '';
}

/* 确定性识别：主人最常说的三类，不花模型钱、不受模型心情影响。
 * inGroup：这条消息来自群里（2026-11-19 放宽到「主人任何场景都能下令」）。
 * 群里判据分两半（主人 2026-11-19 定）：
 *   记录类（约定 / 代称 / 标错 / 记小本本）**所有人的，必须松**——群里「记下来了吗」也算约定；
 *   管理类（开关 / 数值 / 群开关 / 撤回 / 触发词 / 暂停）才是主人的，群里要自己带标识，
 *   免得一句「关掉」「不对」就把当前群关了或者打断闲聊。 */
function deterministic(text, ctx) {
  const t = String(text || '');
  const full = t + '\n' + S(ctx && ctx.evidence);
  const inGroup = !!(ctx && ctx.isPrivate === false);

  // 2026-11-20 主人令：「把这个约定删了」是**命令**——撤销 3 分钟以内刚下的上一条指令，
  // 不是新增约定，也不是撤回一条已发出的消息，更不是闲聊。所有人均可撤（记录类）。
  // 收窄到「约定 / 称呼」这两个数据对象，避免撞上 recall 的「把刚才那句删了」（那是撤消息）。
  // 必须放在撤回 / 约定判定之前。
  if (/(约定|称呼)/.test(t)
    && /(删[掉除]|删了|去掉|撤掉|清除|取消|不要了)/.test(t)
    && !/(换回|换成|换掉|更换|捞回)/.test(t)) {
    return { action: 'undo_last', scope: S(ctx && ctx.scope), text: t };
  }

  // 「撤回这一条」= 撤回**回执里点名的那条指令**（说话人自己的上一条），不限时间/次数、所有人可用。
  // 用「这一条 / 这条 / 那条 / 它」指代指令，跟 recall 的「这句 / 那句」(撤她发出去的消息) 区分开。
  // 放在 recall 判定之前，避免被当成撤消息。2026-11-21 主人令。
  if (/(撤回|撤掉|撤销)\s*(这|那|上)?\s*一?\s*(条|个指令|条指令)/.test(t)
    && !/(被撤回|撤回了一条|已经撤回|别撤回|不要撤回|不用撤回)/.test(t)) {
    return { action: 'undo_ref', scope: S(ctx && ctx.scope), text: t };
  }

  // 撤回（2026-11-19 主人在私聊真的发过「撤回群里这句」，当时被回成「没认出指令」）
  if (/(撤回|撤掉|撤销)/.test(t) && !/(被撤回|撤回了一条|已经撤回|别撤回|不要撤回|不用撤回)/.test(t)) {
    const q = t.match(/[「『"“]([^」』"”]{2,60})[」』"”]/);
    // 主人 2026-11-20 实测：「哈哈哈哈笑死…🤣撤回这句」原话没加引号 → 老代码只认引号，
    // match 落空 → 回「不确定撤哪条」。现在没引号就把「撤回/这句」这些指令词剥掉，剩下的当原话。
    const stripCmd = s => String(s || '')
      .replace(/(帮我|帮忙|请)?\s*(撤回|撤掉|撤销)\s*(刚才在群里|刚才在群|的)?\s*(群里|群里那句|群里这句|群里那条|群里那条消息|这句|那句|刚才那句|这条|刚才那条|的那句|的这句|一下)*\s*[。！!？?~～]*,?$/g, '')
      .replace(/^\s*(帮我|帮忙|请)?\s*(撤回|撤掉|撤销)\s*(刚才在群里|刚才在群|的)?\s*(群里|群里那句|群里这句|群里那条|群里那条消息|这句|那句|刚才那句|这条|刚才那条|的那句|的这句|一下)*\s*/g, '')
      .replace(/^\s*(把|将)\s*/, '')
      .trim();
    const plain = q ? '' : stripCmd(t);
    return {
      action: 'recall',
      inGroup: /群(里|内)|群里那句|刚才在群/.test(t),
      match: q ? q[1] : (plain || S(ctx && (ctx.evidenceFull || ctx.evidence)) || ''),
      text: t,
    };
  }

  // 标错优先：其他场景任何人纠错也走这里（qq.js 对全体消息调 handleCorrection）
  const corrRe = inGroup
    ? /(标错|说错了|说错话|记错了|答错了|不准确)/      // 群里只认明确的纠错词
    : /(标错|说错|记错|错了|不对|不准确|不该这么|别这么说|以后别说)/;
  if (corrRe.test(t)) {
    return { action: 'mark_wrong', target: S(ctx && (ctx.evidenceFull || ctx.evidence)) || t.slice(0, 200), reason: extractReason(t), text: t };
  }

  // 人设（2026-11-19 主人令）：这里是「谁改谁生效」的分水岭 ——
  //   主人说的写默认值（全局，所有人看到都变）；别人说的只挂在他自己名下（换个人说话还是默认的虚幻）。
  // 短的明确设定落状态（优先），长文本判不清归属的才落到下面的约定（兜底）。
  // 说了「约定」二字的让给下面的 pact_add（约定是长文本、说不清归属时的兜底）。
  if (!/(群名|群名片|昵称|约定)/.test(t)) {
    const pr = extractPersona(t);
    if (pr) {
      const byMaster = !!(ctx && (ctx.isMaster || ctx.fromPanel
        || isOwner(S(ctx.platform) || 'qq', ctx.uid)));
      return { action: 'persona_set', topic: pr.topic, setting: pr.text, byMaster, text: t };
    }
    const rs = extractPersonaReset(t);
    if (rs) {
      const byMaster = !!(ctx && (ctx.isMaster || ctx.fromPanel
        || isOwner(S(ctx.platform) || 'qq', ctx.uid)));
      return { action: 'persona_reset', topic: rs, byMaster, text: t };
    }
  }

  // 改名（面板「名字」位，不是代称）：必须显式说「名字/姓名/大名/真名」或「改名叫 X」。
  // 放在代称前面——「改名叫X」里也有「叫」，不先拦就会被写成代称，面板名字列看着没变。
  // 群名/群名片不归这里管，跳过。
  if (!/(群名|群名片|昵称|资料卡)/.test(t)) {
    const nm = extractRenameName(t);
    if (nm) {
      let acc = accountNear(full, '名字|姓名|大名|真名|名称|改名');
      if (!acc) {
        const who = extractRenameTarget(t);
        const per = who ? personByName(who) : null;
        if (per) acc = { platform: per.platform, id: per.id, pid: per.pid };
      }
      if (acc) return { action: 'person_name', platform: acc.platform, uid: acc.id, pid: acc.pid || '', name: nm, text: t };
      if (/(把|给|帮)/.test(t)) return { action: 'person_name_ask', name: nm, text: t };
    }
  }

  // 好感度（面板人物行上那个数）：带号，或带名字（唯一命中）
  {
    const m = t.match(/(?:好感度?)\s*(?:改成|改为|调到|调成|设成|设为|变成|是|到|加|减)?\s*([0-9]{1,3})/);
    // 好感锁定 / 解锁（面板上那把锁）
    if (/好感/.test(t) && /(锁定|锁上|锁住|锁起来)/.test(t) && !/(解锁|解除)/.test(t)) {
      const acc = resolveTarget(full, '好感|锁');
      if (acc) return { action: 'person_lock', platform: acc.platform, uid: acc.id, pid: acc.pid || '', on: true, text: t };
    }
    if (/(好感).{0,6}(解锁|解除锁定|取消锁定)/.test(t)) {
      const acc = resolveTarget(full, '好感|锁');
      if (acc) return { action: 'person_lock', platform: acc.platform, uid: acc.id, pid: acc.pid || '', on: false, text: t };
    }
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) {
        const acc = resolveTarget(full, '好感');
        if (acc) return { action: 'person_favor', platform: acc.platform, uid: acc.id, pid: acc.pid || '', value: v, text: t };
      }
    }
  }

  // AI 账号标记 / 改回人物（2026-11-23 主人补做：只有自动判+面板按钮+引用解除，没有发话入口）。
  // 认主人原话格式「ai账号4015881213」和带动作词的说法。改回优先——「取消XX的AI标记」里也有「AI」。
  // 管理类：由 handle/handleGroup 的 isOwner 挡住非主人，这里不判断权限。
  if (/(?:AI|ai|机器人|robot)\s*账号\s*[0-9]{5,12}/.test(t)
    || /(标记|标成|标为|设为|设成)\s*(?:[^，。！？、\s]{1,12})?\s*(?:为)?\s*(?:AI|ai|机器人)/.test(t)
    || /(?:改回人物|恢复成人物|取消.{0,16}AI标记|取消.{0,16}机器人标记|解除.{0,16}(?:AI|机器人)标记)/.test(t)) {
    const isUnmark = /(改回人物|恢复成人物|取消|解除)/.test(t);
    const acc = resolveAiTarget(full);
    if (acc) return { action: isUnmark ? 'ai_unmark' : 'ai_mark', platform: acc.platform, uid: String(acc.id), pid: acc.pid || '', text: t };
  }

  // 问这个人叫什么（带号）：回答，不改数据。私聊里主人也会这么问，别回「没认出指令」。
  if (/(叫什么|叫啥|叫什么名字|叫啥名|名字是啥)/.test(t) && !/(改成|改为|记成|记下来)/.test(t)) {
    const acc = extractAccounts(t)[0];
    if (acc) return { action: 'person_query', platform: acc.platform, uid: acc.id, text: t };
  }

  // 地区（面板人物页「所在地」）：只到市/区级；「住在哪」这种问句不算
  {
    const m = t.match(/(?:地区|所在地|城市|住址|住在)\s*(?:改成|改为|换成|设为|设成|是|在|到)?\s*([^\s，。！？、,!?；;：:]{1,12})/);
    const city = m ? S(m[1]).replace(/^(?:改成|改为|换成|设为|设成|是|在|到)/, '') : '';
    if (city && !/^(?:哪|哪里|哪儿|什么|啥|什么地方|哪个城市)$/.test(city)) {
      const acc = resolveTarget(full, '地区|所在地|城市|住址|住在');
      if (acc) return { action: 'person_region', platform: acc.platform, uid: acc.id, pid: acc.pid || '', city, text: t };
    }
  }

  // 喜好（面板人物页 👍/👎）：必须是「记/加/写」这种明确要落数据的说法，单纯「我喜欢猫」是聊天
  {
    const like = t.match(/(喜欢|讨厌|不喜欢)\s*[：:]?\s*([^\s，。！？、,!?；;：:]{1,20})/);
    if (like && /(记|加|写|补|记下来|记住)/.test(t.slice(Math.max(0, like.index - 30), like.index))) {
      const acc = resolveTarget(full, '喜欢|讨厌|记|加');
      if (acc) {
        return {
          action: 'taste_add', platform: acc.platform, uid: acc.id, pid: acc.pid || '',
          sec: like[1] === '喜欢' ? 'likeConf' : 'hateConf', text: like[2], raw: t,
        };
      }
    }
  }

  // 兜底词池（聊天记录页 🛟）：加一句 / 换掉默认那句
  if (/兜底/.test(t) && /(加|添|写|补|换)/.test(t)) {
    const q = t.match(/[「『"“]([^」』"”]{2,80})[」』"”]/);
    const line = q ? q[1] : S(t.replace(/^.*?(?:兜底|加|添|写|补|换)[^：:]*[：:]?\s*/, '')).trim();
    if (line) return { action: 'fallback_add', line, text: t };
  }

  // 「123456 叫 皮皮」——主人/面板说的这句 = 给这个号定名字（写**名字位**，面板第一列会变）。
  // 以前一律写成代称，主人发「2650321894叫皮皮」后看面板名字没变，就说「改不了」（2026-11-19）。
  // 举证式（证明/这句/转发/也/还）仍走下面的代称；别人说的也只是代称，不能改名字位。
  {
    const m = t.match(/(\d{5,12})\s*(?:就叫|就叫做|叫做|叫|喊|称呼为?)\s*[「『"']?([^\s，。！？、,!?；;：:"」』]{1,16})/);
    const proving = /(证明|说明|可见|这句|这条|记录|转发|别名|代称|外号|也称|也叫|还叫)/.test(t);
    const byMaster = !!(ctx && (ctx.isMaster || ctx.fromPanel || isOwner(S(ctx.platform) || 'qq', ctx.uid)));
    if (m && !proving && byMaster) {
      const nm = S(m[2]).replace(/^(?:做|为|作|叫)/, '');
      if (nm && !/^(?:什么|啥|谁|哪个|哪位)$/.test(nm)) {
        const acc = extractAccounts(t)[0];
        return {
          action: 'person_name',
          platform: acc ? acc.platform : 'qq', uid: m[1], pid: '', name: nm, text: t,
        };
      }
    }
  }

  // 代称举证：「这句话里某人这么说，证明某号叫xxx」（可带转发的聊天记录当证据）
  // 或者本人自报：「以后叫我 XX」。
  // 这是「记录类」指令，**谁都能触发**（主人 2026-11-19 定），群里也认，不做主人专属收紧。
  // 但判据本身不放水：话里得有能对上的号（或本人自报），「他叫小明」这种没号的照样不落地。
  {
    const name = extractCallName(full);
    const selfCall = !/触发词/.test(t) && /(?:以后|大家|就|请|都|可以)?\s*叫我\s*[^\s，。！？、,!?]{1,16}/.test(t);
    const proving = /(证明|说明|可见|这句|这条|记录|转发)/.test(t);
    if (name) {
      const acc = targetAccount(full) || (selfCall && ctx && ctx.account ? ctx.account : null);
      if (acc) return { action: 'alias_set', platform: acc.platform, uid: acc.id, name, text: t };
      // 明确在举证、却没有能对上的号：别猜，回一句问清楚
      if (extractAccounts(full).length > 1 || proving)
        return { action: 'alias_ask', name, text: t };
    }
  }

  // 群开关：动词在前在后都认（「关闭XX群」「把XX这个群关掉」）。
  // 群名本身就是标识，所以不强制话里带「群」字（「把赛博鱼塘②塘恢复一下」也算）。
  // 认不出是哪个群也照样进 group_off，由 execute 回一句问清楚——总比当成聊天答好。
  // 群里恒有「当前群号」兜底，所以群里必须自己带「群」字，避免一句「关掉」就把当前群关了。
  {
    const gid = extractGid(t, ctx);
    const looksGroup = /(群|group)/i.test(t) || (!inGroup && !!gid);
    if (looksGroup && /(关闭|关掉|停用|停掉|别回|不要回|不看也不回|闭嘴|静默|停一下)/.test(t))
      return { action: 'group_off', gid, text: t };
    if (looksGroup && /(开启|打开|重新开|解禁|继续回|恢复)/.test(t) && !/(恢复默认|全部默认|重置)/.test(t))
      return { action: 'group_on', gid, text: t };
  }

  // 会话设置（面板聊天记录页 ⚙，按会话一份）：上下文条数、字数上限、只看不回、黑名单、本地模型。
  // 只在点了「这个群/这个会话/这里」或给了群号时动；没点明就当全局设置，交给下面的数值项。
  {
    const looksScope = /(群|会话)/.test(t);
    const gid = looksScope ? extractGid(t, ctx) : '';
    // 「这个群」只在群里才有所指；私聊里说「这个群」要么给了群号，要么当没说清
    const here = /(这个会话|这个聊天|当前会话)/.test(t)
      || (inGroup && /(这个群|这群|本群|当前群|这里)/.test(t));
    const nameable = here || !!gid;
    if (nameable) {
      const convKey = S(ctx && ctx.convKey);
      const key = (gid ? 'qq_' + gid : '') || (inGroup ? convKey : (here ? convKey : ''));
      if (key) {
      if (/(取消拉黑|解除黑名单|移出黑名单)/.test(t))
        return { action: 'conv_set', key, field: 'black', value: null, text: t };
      if (/(拉黑|黑名单)/.test(t))
        return { action: 'conv_set', key, field: 'black', value: true, text: t };
      if (/(恢复回话|恢复回复|可以回话|正常回话)/.test(t))
        return { action: 'conv_set', key, field: 'reply', value: null, text: t };
      if (/(只看不回|不回复|别回了|不要回|闭嘴|不吭声)/.test(t) && !/(关闭|不看也不回)/.test(t))
        return { action: 'conv_set', key, field: 'reply', value: false, text: t };
      if (/(本地模型|用本地的?模型)/.test(t))
        return { action: 'conv_set', key, field: 'model', value: /(不用|别用|关掉|取消|恢复)/.test(t) ? null : 'local', text: t };
      const nc = t.match(/(?:上下文).{0,8}?([0-9]{1,3})\s*条/) || t.match(/([0-9]{1,3})\s*条.{0,6}上下文/);
      if (nc) return { action: 'conv_set', key, field: 'ctx', value: Number(nc[1]), text: t };
      const nw = t.match(/(?:字数|最多说|上限).{0,8}?([0-9]{1,4})\s*字/);
      if (nw) return { action: 'conv_set', key, field: 'chars', value: Number(nw[1]), text: t };
      if (/(恢复默认|全部默认|重置设置)/.test(t))
        return { action: 'conv_set', key, reset: true, text: t };
      }
    }
  }

  // 已有的文字命令直接复用，不另造语义
  if (/^\s*(?:不用回复|适合回复|一定回复|必须回复|喊我|叫我|接话|固定话|看触发词|触发词|删触发词)/.test(t)
    || /(?:加|添加|新增|记)\s*个?\s*触发词/.test(t)
    || /(?:删|删除|去掉)\s*个?\s*触发词/.test(t))
    return { action: /(?:删|删除|去掉)/.test(t) ? 'trigger_del' : 'trigger_add', command: normalizeTrigger(t), text: t };
  if (/^\s*(?:暂停|停止|允许|开启|恢复)\s/.test(t))
    return { action: /^\s*(?:允许|恢复|开启)\s/.test(t) ? 'allow' : 'pause', command: t, text: t };

  // 功能开关 / 数值（自然语言「把自动接话关了」「等待改成8秒」）
  const sw = matchSwitch(t);
  if (sw) return Object.assign({ action: 'switch_set', text: t }, sw);
  const bn = matchBoolNum(t);
  if (bn) return Object.assign({ action: 'num_set', text: t }, bn);
  const num = matchNum(t);
  if (num) return Object.assign({ action: 'num_set', text: t }, num);
  if (/^\s*(?:记到小本本|记到工作日志|记到长期记忆)/.test(t))
    return { action: 'memory_log', text: t };
  // 约定是「记录类」，谁都能立（主人 2026-11-19 定：必须松）。
  // 群里「记下来」「记住」也算，不再只认「约定 / 以后每次」。
  /* 「换回原来那句」（2026-11-19 主人令）：
   * 「约定会全部保留，对方要求换就能捞回来原句。但指定要更换，而不是使用时，才是更改约定。」
   * → 使用不算改；明确说「换 / 捞回」才动**排序**（原文一个字不删）。
   * 必须排在新建立前面判，否则「换回句尾加喵」会被当成又记一条新约定。 */
  if (/(换回|换成|换掉|更换|捞回)/.test(t)
    && /(约定|句尾|结尾|称呼|那句|那条)/.test(t)
    && t.length > 3)
    return { action: 'pact_switch', text: t };
  if (/(以后每次|约定|记下来|记住)/.test(t) && t.length > 3)
    return { action: 'pact_add', text: t };
  return null;
}

const SWITCH_WORDS = [
  ['autoAsk', /(自动接话|自主回复|主动说话|自动说话)/],
  ['chime', /(凑热闹|随机接话)/],
  ['topic', /(话题功能|话题接话)/],
  ['merge', /(合并消息|消息合并)/],
  ['webSearch', /(联网|搜索功能|联网搜索)/],
  ['learn.enabled', /(学习功能|学说话)/],
];
/* 面板功能列表里名字长、口语说法却很短的那几个（面板加新开关不用动这里，
 * 名字能直接对上的由 matchSwitch 现取现认；这里只补对不上的俗名）。 */
const SWITCH_ALIAS = [
  ['pokemon', /(宝可梦)/],
  ['moegirl', /(萌娘|动漫数据源)/],
  ['learn.enabled', /(学习系统|学习功能|学说话)/],
  ['learn.decay', /好感度?.{0,4}(?:衰减|掉落|降低)/],
  ['learn.warm', /(知识库|检索)/],
  ['learn.acts', /(冷层|说过什么)/],
];
/* 「开还是关」只看话里怎么说。返回 true / false / null（说不清就不动）。 */
/* 「开」必须是动词，不能按单字判：截图描述里的「一开始」「开始」「开心」都会命中单字
 * 「开」，2026-11-22 群里发 B 站截图 → 描述含「B站」+「一开始」→ 回了「bilibili 已打开。」
 * 现在只认：打开 / 开启 / 启用 / 开一下 / 开起来 / 开了 / 开开 / 恢复 / true / on */
const ON_RE = /(打开|开启|启用|开一下|开起来|开了|开开|恢复|true|\bon\b)/i;
const OFF_RE = /(关|停|禁用|不要|别|禁止|false|\boff\b)/i;
function swState(t) {
  const off = OFF_RE.test(t);
  const on = ON_RE.test(t);
  if (on && !off) return true;
  if (off && !on) return false;
  // 「把XX关了」里的「开」可能来自别的词，取最后一个动词判断
  if (on && off) {
    const iOn = t.lastIndexOf('开'), iOff = Math.max(t.lastIndexOf('关'), t.lastIndexOf('停'));
    if (iOn >= 0 || iOff >= 0) return iOn > iOff;
  }
  return null;
}

/* 面板里「用 1/0 表示的开关」：它们不在 SWITCH_SET 里，要走 setNum 写 1 或 0。 */
const BOOL_NUM = [
  ['context.liveThink', /(实时思考|每轮都想|每轮都让模型想)/],
  ['sticker.keywordFuzzy', /(?:表情)?关键词.{0,4}模糊|模糊.{0,4}关键词/],
];
function matchBoolNum(t) {
  for (const [key, re] of BOOL_NUM) {
    if (!re.test(t)) continue;
    const s = swState(t);
    if (s == null) continue;
    return { key, value: s ? 1 : 0 };
  }
  return null;
}

function matchSwitch(t) {
  for (const [key, re] of SWITCH_WORDS) {
    if (!re.test(t)) continue;
    const s = swState(t);
    if (s != null) return { key, on: s };
  }
  for (const [key, re] of SWITCH_ALIAS) {
    if (!re.test(t)) continue;
    const s = swState(t);
    if (s != null) return { key, on: s };
  }
  // 面板「功能」列表里的中文名现取现用：面板加一个开关，这里自动跟上，不手抄第二份。
  // 只认 SWITCH_SET 里真能改的键（_napcat / _greet 这类展示项不碰）。
  try {
    const list = require('./server/panel').featureStates() || [];
    const settable = require('./server/state').SWITCH_SET || {};
    let hit = null;
    for (const f of list) {
      if (!f || !settable[f.key]) continue;
      const nm = S(f.name).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
      if (nm.length >= 3 && t.indexOf(nm) >= 0 && (!hit || nm.length > hit.len)) {
        hit = { len: nm.length, key: f.key };
      }
    }
    if (hit) {
      const s = swState(t);
      if (s != null) return { key: hit.key, on: s };
    }
  } catch { /* 面板读不到就只认别名 */ }
  return null;
}
/* 数值项：单位换算（秒→毫秒、%→小数）由面板的 CFG_EDIT_MAP.scale 负责，
 * 这里只把用户嘴里的数字原样传过去，绝不再乘一次（乘两次会变成 8000 秒）。
 * 两路命中：① 日常说法别名；② 直接说面板上的名字。 */
const NUM_ALIAS = [
  // 「上下文」两项要说清是「条」还是「字」，否则会互相抢（先把带「字」的放前面）
  ['context.historyChars', /(?:上下文|历史).{0,6}(?:留.{0,4})?字/],
  ['context.historyLimit', /(?:上下文|历史记录|能读|读多少).{0,8}(?:条数|多少条|几条|条)?/],
  ['merge.atMeWaitMs', /(?:被\s*@|被艾特|@她|@我|喊她).{0,8}(?:等待|等多久|多长时间|等)/],
  ['merge.masterCoolMs', /主人.{0,8}(?:必回|回复).{0,6}(?:冷却|间隔|隔多久|多久回一次)/],
  ['merge.masterWaitMs', /(?:主人|我).{0,6}(?:说完)?.{0,4}(?:等待|等多久|多长时间|等)|等待/],
  ['merge.otherWaitMs', /(?:其他人|别人|群友).{0,8}(?:说完)?.{0,4}(?:等待|等多久|等)/],
  ['merge.maxPieces', /(?:最多)?攒.{0,6}条/],
  ['merge.maxChars', /(?:最多)?攒.{0,6}字/],
  ['merge.maxMs', /(?:最久|最多等).{0,8}(?:多久|多长时间|一定回|回)/],
  ['grpAuto.hotMsMin', /热度.{0,8}(?:最短|最少|至少).{0,6}(?:秒|久|长)/],
  ['grpAuto.hotMsMax', /热度.{0,8}(?:最长|最多|持续).{0,6}(?:秒|久|长)/],
  ['grpAuto.hotMin', /热度.{0,8}(?:最小|最少)/],
  ['grpAuto.hotMax', /热度.{0,8}(?:最大|最多)/],
  ['grpAuto.min', /(?:普通群|接话|攒).{0,8}(?:最小|最少)/],
  ['grpAuto.max', /(?:普通群|接话|攒).{0,8}(?:最大|最多)/],
  ['chime.p', /凑热闹.{0,8}(?:概率|几率)/],
  ['chime.cooldownMs', /凑热闹.{0,8}(?:间隔|冷却)/],
  ['chime.dailyMax', /凑热闹.{0,10}(?:每天|一天).{0,6}(?:最多|上限)/],
  ['greeting.cooldownMs', /问候.{0,10}(?:间隔|防刷屏|冷却)/],
  ['context.imgDescChars', /(?:图片|看图).{0,10}(?:翻译|文字).{0,8}(?:多少字|字数)/],
  ['context.chatShowLimit', /聊天记录(?:页)?.{0,10}(?:显示|多少条)/],
  ['llm.maxTokens', /(?:字数上限|最多说多少字|输出字数|最多说几个字)/],
];
function matchNum(t) {
  if (!/(改|设|调|换成|变成|成|到)/.test(t)) return null;
  const m = t.match(/(-?[0-9]+(?:\.[0-9]+)?)\s*(秒|条|字|%|句)?/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  for (const [key, re] of NUM_ALIAS) if (re.test(t)) return { key, value: v };
  // 用户直接说面板上的项目名（按 label 最长的先认，避免短名抢长名）
  let hit = null;
  try {
    const panel = require('./server/panel');
    for (const [k, meta] of Object.entries(panel.CFG_EDIT_MAP || {})) {
      const lb = S(meta && meta.label).replace(/[（）()]/g, '');
      if (lb.length >= 3 && t.indexOf(lb) >= 0 && (!hit || lb.length > hit.len)) hit = { len: lb.length, key: k };
    }
  } catch { /* 面板读不到就只认别名 */ }
  if (hit) return { key: hit.key, value: v };
  return null;
}

/* 语义兜底：只输出目录里的动作 ID。模型坏了也不猜——私聊里「没认出」比「聊起来」安全。 */
async function semantic(text, ctx) {
  const core = require('./core');
  let groups = '';
  try {
    const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'group-names.json'), 'utf8')) || {};
    groups = Object.entries(names).slice(0, 60).map(([id, n]) => id + '=' + S(n)).join('，');
  } catch { /* 没群名表就不给 */ }
  // 面板里能改的全部项目：不手抄，现取现给，面板加一项这里自动跟上
  let nums = '', switches = '';
  try {
    const panel = require('./server/panel');
    nums = Object.entries(panel.CFG_EDIT_MAP || {})
      .map(([k, m]) => k + '=' + S(m && m.label) + (m && m.unit ? '(' + S(m.unit) + ')' : '')).join('；');
  } catch {}
  try { switches = Object.keys(require('./server/state').SWITCH_SET || {}).join('、'); } catch {}
  const prompt = [
    { role: 'system', content: [
      '你是虚拟助手的命令解析器，不是聊天机器人。',
      '主人私聊里发的都是指令。把用户最后一句话解析成一个动作。',
      '只输出一行 JSON：{"action":"id","params":{...}}。不许输出解释、不许用目录外的 action。',
      '认不出来就输出 {"action":"none","params":{}}。',
      '可用动作：' + ACTIONS.map(a => a.id + '=' + a.hint).join('；'),
      '平台：' + S(ctx && ctx.platform) + '；账号：' + S(ctx && ctx.uid) + '；当前会话：' + S(ctx && ctx.convKey),
      groups ? '已知群（号=群名）：' + groups : '',
      '涉及群的动作，params.gid 必须是数字群号；说了群名就按上表换成号，换不出来就别猜。',
      nums ? '可改的数值项（key=含义）：' + nums : '',
      switches ? '可开关的项：' + switches : '',
      '改数值用 cfg_set + {key,value}（数字按人说的原样给，别自己换算成毫秒）；开关用 cfg_set + {key,on}。',
      '代称举证用 alias_set + {platform,uid,name}；uid 必须是被叫的那个人的号。',
      '标注 AI 账号用 ai_mark + {platform,uid}（「ai账号123456」「把123456标记成AI」）；改回人物用 ai_unmark + {platform,uid}；uid 是那个号的数字。',
      '改人设用 persona_set + {topic,setting}：topic 是「人设」或「发型」「眼睛」这类单项，setting 是内容；恢复原样用 persona_reset。',
      /* 2026-11-25 补参数契约：这一轮真因就是没写参数名，模型自造了 trigger 键 + 误判动作。 */
      'params 只能放上面写明的键，不许自己造键名。',
      '加/删触发词只能这么写：trigger_add|trigger_del + {command}，command 必须是「不用回复：X」「适合回复：X」「喊我：X」「固定话：词=话」「触发词」「删触发词 3」之一。',
      '用户不是在说这类触发词指令，就不许用 trigger_add / trigger_del，改成 none。',
      '拿不准是不是指令 → none，不要猜。',
    ].filter(Boolean).join('\n') },
    { role: 'user', content: String(text || '').slice(0, 2000) },
  ];
  let out = '';
  try { out = S(await core.callLLM(prompt, { tag: 'nl-command', preferFallback: true })); } catch (e) { console.log('[指令] 语义解析失败：' + e.message); return null; }
  const j = pickJson(out);
  if (!j || !IDS.has(j.action) || j.action === 'none') return null;
  const cmd = Object.assign({ text: String(text || '') }, j.params || {}, { action: j.action });
  // 触发词动作必须先过「真命令」判定：模型常把一句问句判成 trigger_add 却给不出合法命令。
  // 判不过就当不是指令，绝不带着空命令往下执行（2026-11-25 假成功真因）。
  if ((cmd.action === 'trigger_add' || cmd.action === 'trigger_del') && !triggerCommandOf(cmd)) return null;
  return cmd;
}

/* 从模型输出里抠 JSON。以前用 /\{[\s\S]*?\}/（非贪婪）：碰到
 * {"action":"switch_set","params":{"key":"autoAsk","on":false}} 会截到第一个 }，
 * 解析必失败 → 语义层永远返回 null，「面板所有项都能改」其实一直没通（2026-11-19 查出）。
 * 现在先整体解析，再逐个候选括号试，嵌套多深都能取到。 */
function pickJson(s) {
  const t = String(s || '').replace(/```json/gi, '```').replace(/```/g, '').trim();
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch {}
  const a = t.indexOf('{');
  if (a < 0) return null;
  let b = t.lastIndexOf('}');
  while (b > a) {
    try { const j = JSON.parse(t.slice(a, b + 1)); if (j && typeof j === 'object') return j; } catch {}
    b = t.lastIndexOf('}', b - 1);
  }
  return null;
}

/* 面板接口复用：客户端用假 req/res 直接调 handler，这里照抄同一套。 */
function panelCall(method, url, body) {
  const panel = require('./server/panel');
  return new Promise(resolve => {
    const req = new EventEmitter();
    req.method = method; req.url = url;
    const res = { writeHead() {}, end(buf) { try { resolve(JSON.parse(String(buf))); } catch { resolve({ raw: String(buf) }); } } };
    panel.handler(req, res);
    req.emit('data', JSON.stringify(body || {}));
    req.emit('end');
  });
}

async function markWrong(target, reason, ctx, text) {
  const core = require('./core');
  const uid = S(ctx && ctx.uid);
  const platform = S(ctx && ctx.platform) || 'qq';
  const who = S(ctx && ctx.nick) || '主人';
  const byMaster = !!(ctx && ctx.isMaster);
  const note = S(reason) || (byMaster ? '主人标错，没写理由' : who + ' 提出这里说错了，没写理由');
  const extra = { note, emo: '', ctx: [] };
  if (ctx && ctx.evidence) extra.ctx.push({ nick: S(ctx.nick) || '证据', text: S(ctx.evidence).slice(0, 200) });
  core.addIssue('待修复', (byMaster ? '主人纠错：' : who + ' 纠错：') + S(target).slice(0, 180) + '｜' + note, extra);
  core.recordCorrection(text || S(target), S(ctx && ctx.evidence), uid);
  core.promiseAdd({
    kind: 'promise', byMaster, section: '禁止回复',
    text: '别再说「' + S(target).slice(0, 120) + '」；理由：' + note,
    say: '', when: ['这种场合'], note,
    qq: uid, platform, scope: S(ctx && ctx.scope) || (platform === 'qq' ? '私聊' : 'bili私聊'),
    who, nick: who,
  });
  // 有聊天记录原文才删；转发证据不冒充本地聊天行，免得误删别人的话
  if (ctx && ctx.item && ctx.item.t && ctx.item.text) {
    try { await panelCall('POST', '/api/chat/issue', { item: ctx.item, note, ctx: [] }); } catch (e) { console.log('[指令] 删原记录失败：' + e.message); }
  }
  return { ok: true, reply: byMaster ? ('标错了，也记成约定：' + note) : ('记下了：这条算说错了，也记成约定。' + note) };
}

async function execute(cmd, ctx, fullText) {
  const core = require('./core');
  switch (cmd.action) {
    case 'alias_ask': {
      const nm = S(cmd.name);
      return { ok: false, reply: (nm ? '我知道要记「' + nm + '」，' : '')
        + '但没对上是哪个号。把号码一起说，比如「123456 叫 ' + (nm || '小明') + '」。我什么都没改。' };
    }
    case 'alias_set': {
      const people = require('./people');
      const platform = people.normPlat(cmd.platform || (ctx && ctx.platform) || 'qq');
      const uid = S(cmd.uid || (ctx && ctx.uid));
      const name = S(cmd.name);
      if (!uid || !name) return { ok: false, reply: '没听清是哪个号和要记成什么，我没动。' };
      let pid = people.pidOfIdAll(uid);
      if (!pid) pid = people.ensure(platform, uid, {});
      if (!pid) return { ok: false, reply: '这个号没建上，我没动。' };
      /* 判据（2026-11-22 她令）：本人承认的才是真名；别人举证 / 观察到的只能进代称。
       * ctx 里说话人就是被记的那个人 → 本人自报 → 写真名；否则 → 代称。 */
      const isSelf = String(uid) === String(S(ctx && ctx.uid));
      if (isSelf) people.setName(pid, name);
      else people.addAliasName(pid, name);
      core.promiseAdd({
        kind: 'promise', byMaster: true, section: '代称',
        text: '代称约定：' + people.platLabel(platform) + ' ' + uid + ' 叫「' + name + '」',
        say: '', when: ['说到这个人'], note: '主人举证',
        qq: uid, platform, scope: platform === 'bili' ? 'bili私聊' : '私聊',
        who: S(ctx && ctx.nick) || '主人', nick: S(ctx && ctx.nick) || '主人',
      });
      const after = people.recognizeNamesOf(pid);
      const ok = after.indexOf(name) >= 0;
      return ok ? { ok: true, reply: '记好了：' + uid + ' 也叫「' + name + '」' + (isSelf ? '（本人说的，记成真名）' : '，写进代称了。') }
        : { ok: false, reply: '写了但读回来没有这个名字。'
          + '\n' + diag('alias_set', { pid, platform, uid, name, 读回: after.slice(0, 8), 条数: after.length }) };
    }
    case 'mark_wrong':
      return await markWrong(cmd.target || fullText, cmd.reason, ctx, cmd.text || fullText);
    case 'recall': {
      const platform = S(ctx && ctx.platform) || 'qq';
      if (platform !== 'qq') {
        return { ok: false, reply: '这个平台的撤回还没接上（现在只有 QQ 能撤）。'
          + '\n' + diag('recall', { platform }) };
      }
      if (!recaller) {
        return { ok: false, reply: '撤回通道没接上。'
          + '\n' + diag('recall', { 原因: 'recaller 未注册，qq.start 没跑？' }) };
      }
      let r;
      try {
        r = await recaller({
          scope: S(ctx && ctx.scope),
          inGroup: !!cmd.inGroup || /^群/.test(S(ctx && ctx.scope)),
          match: S(cmd.match),
        });
      } catch (e) {
        return { ok: false, reply: '撤回抛错了。\n' + diag('recall', { 错误: errBrief(e) }) };
      }
      if (!r || !r.ok) {
        return { ok: false, reply: '没撤成：' + ((r && r.error) || '原因不明')
          + '\n' + diag('recall', {
            scope: S(ctx && ctx.scope),
            目标: r && r.target ? r.target.scope + ' ' + r.target.mid : '',
            原文: r && r.target ? S(r.target.text).slice(0, 40) : '',
            错误: (r && r.error) || '',
          }) };
      }
      return { ok: true, reply: '撤回了：' + S(r.target && r.target.text).slice(0, 30) + '（' + S(r.target && r.target.scope) + '）' };
    }
    case 'group_off':
    case 'group_on': {
      const conv = require('./conv-settings');
      const gid = S(cmd.gid);
      if (!/^\d{5,12}$/.test(gid)) return { ok: false, reply: '没说清是哪个群。带群号，或者直接说群名（我知道名字的群）。我什么都没改。' };
      // 硬拦：主人的号绝不能当群关掉，否则遥控私聊就断了
      if (isOwner('qq', gid)) return { ok: false, reply: '这是主人的号，不是群，我没动。' };
      const key = 'qq_' + gid;
      conv.set(key, { off: cmd.action === 'group_off' });
      const readBack = conv.isOff(key);
      const ok = readBack === (cmd.action === 'group_off');
      // allowOff：这条回执就是「群 xxx 已关闭」本身，qq.js 的关闭闸要放行（2026-11-21）。
      if (ok) return { ok: true, allowOff: true, reply: cmd.action === 'group_off' ? '群 ' + gid + ' 已关闭：不看也不回。' : '群 ' + gid + ' 已恢复。' };
      return { ok: false, reply: '群开关没真的写进去。'
        + '\n' + diag('group_' + (cmd.action === 'group_off' ? 'off' : 'on'), { key, 期望: cmd.action === 'group_off', 读回: readBack }) };
    }
    case 'conv_set': {
      const conv = require('./conv-settings');
      const key = S(cmd.key);
      if (!key) return { ok: false, reply: '没听清是哪个会话，我没动。' };
      const FIELDS = ['ctx', 'chars', 'reply', 'black', 'off', 'model'];
      const patch = {};
      if (cmd.reset) for (const f of FIELDS) patch[f] = null;
      else if (cmd.field) patch[cmd.field] = cmd.value;
      const r = conv.set(key, patch);
      if (!r || !r.ok) return { ok: false, reply: '会话设置没写进去：' + ((r && r.error) || '未知原因') };
      // 读回核对：写进去的和文件里读到的一样才算成
      const got = conv.get(key);
      let ok = true;
      if (!cmd.reset && cmd.field) {
        const want = cmd.value;
        ok = (want === null || want === undefined) ? !(cmd.field in got) : String(got[cmd.field]) === String(want);
      }
      const label = { ctx: '上下文条数', chars: '字数上限', reply: '回话', black: '黑名单', off: '不看也不回', model: '本地模型' }[S(cmd.field)] || '设置';
      if (ok) {
        return { ok: true, reply: cmd.reset ? (key + ' 的会话设置已恢复默认。') : (key + ' 的' + label + '已改成：' + JSON.stringify(got)) };
      }
      return { ok: false, reply: '写了但读回来对不上。\n'
        + diag('conv_set', { key, 字段: S(cmd.field) || '(恢复默认)', 期望: cmd.reset ? '默认' : String(cmd.value), 读回: got }) };
    }
    case 'switch_set': {
      const state = require('./server/state');
      const key = S(cmd.key);
      // 执行前先读旧值（2026-11-21「撤回这一条」要能回滚）。落点四种，跟下面读回核对同一套。
      let old = null;
      try {
        const cfg0 = require('./config').load();
        if (key === 'pokemon' || key === 'moegirl') old = (cfg0.webSearch || {})[key];
        else if (key.indexOf('.') > 0) { const [a, b] = key.split('.'); old = (cfg0[a] || {})[b]; }
        else old = (cfg0[key] || {}).enabled;
      } catch {}
      const r = state.setSwitch(key, !!cmd.on);
      if (!r || r.error) return { ok: false, reply: (r && r.error) || '这一项改不了。'
        + '\n' + diag('switch_set', { key, 期望: !!cmd.on, 错误: (r && r.error) || 'setSwitch 没返回 ok' }) };
      // 读回核对：setSwitch 的落点有四种（xxx.enabled / learn.xxx / webSearch.pokemon），
      // 按每种各自的真实位置读，不能一律当 enabled 读（以前就是这么读错的）。
      let got = null;
      try {
        const cfg = require('./config').load();
        if (key === 'pokemon' || key === 'moegirl') got = (cfg.webSearch || {})[key];
        else if (key.indexOf('.') > 0) { const [a, b] = key.split('.'); got = (cfg[a] || {})[b]; }
        else got = (cfg[key] || {}).enabled;
      } catch {}
      const ok = !!got === !!cmd.on;
      return ok ? { ok: true, reply: key + ' 已' + (cmd.on ? '打开' : '关闭') + '。', undo: { kind: 'switch', key, old: !!old } }
        : { ok: false, reply: '写了但读回来对不上。'
          + '\n' + diag('switch_set', { key, 期望: !!cmd.on, 读回: got, 接口: (r && r.ok) ? 'ok' : 'fail' }) };
    }
    case 'cfg_set':
      // 面板任意项：带 on 的走开关，带 value 的走数值
      return await execute('on' in cmd
        ? { action: 'switch_set', key: cmd.key, on: cmd.on, text: cmd.text }
        : { action: 'num_set', key: cmd.key, value: cmd.value, text: cmd.text }, ctx, fullText);
    case 'num_set': {
      const state = require('./server/state');
      const key = S(cmd.key);
      // 执行前读旧值（2026-11-21「撤回这一条」要能回滚）。num_set 存的是换算后的值，
      // 这里记磁盘原值 + scale，撤销时用「原值/scale」当显示值写回，保证和改之前逐字一致。
      let oldStored = null, scale = 1;
      try {
        let cur = require('./config').load();
        for (const p of key.split('.')) cur = cur && cur[p];
        oldStored = cur;
        const meta = require('./server/panel').CFG_EDIT_MAP[key];
        if (meta && Number(meta.scale)) scale = Number(meta.scale);
      } catch {}
      const r = state.setNum(key, Number(cmd.value));
      if (!r || !r.ok) return { ok: false, reply: '数值没写进去。'
        + '\n' + diag('num_set', { key, 期望: Number(cmd.value), 错误: (r && r.error) || 'setNum 没返回 ok' }) };
      // 读回核对：写进去的和磁盘上的一模一样才算成（不再「接口回 ok 就当成了」）
      let got = null;
      try {
        let cur = require('./config').load();
        for (const p of key.split('.')) cur = cur && cur[p];
        got = cur;
      } catch {}
      const ok = Number(got) === Number(r.stored);
      const undo = (ok && oldStored != null && Number.isFinite(Number(oldStored)))
        ? { kind: 'num', key, old: Number(oldStored) / scale } : null;
      return ok ? { ok: true, reply: key + ' 已改成 ' + got + '。', undo }
        : { ok: false, reply: '写了但读回来对不上。'
          + '\n' + diag('num_set', { key, 期望: Number(cmd.value), stored: r.stored, 读回: got }) };
    }
    case 'trigger_add':
    case 'trigger_del': {
      /* 2026-11-25 真因修复：模型把「我怎么给你加上」当触发词，参数名还自造成 trigger；
       * 老代码读 cmd.command||cmd.text → 拿整段原文 → core.triggerCommand 返回 null，
       * 却靠 '触发词已处理。' 兜底并报 ok:true，什么都没做却回成功（主人实测）。
       * 现在：命令必须是真正支持的那几种写法，否则直接失败，绝不假报成功。 */
      const raw = triggerCommandOf(cmd);
      if (!raw) {
        return { ok: false, reply: '没认出要加/删什么触发词，我什么都没改。\n'
          + diag(cmd.action, { 原文: S(cmd.text).slice(0, 40), 参数: Object.keys(cmd) }) };
      }
      const out = core.triggerCommand(raw);
      if (!out) {
        return { ok: false, reply: '这条触发词没处理成，我什么都没改。\n'
          + diag(cmd.action, { command: raw.slice(0, 60) }) };
      }
      return { ok: true, reply: out };
    }
    case 'pause':
    case 'allow': {
      const pause = require('./pause');
      const out = pause.parseCommand(S(cmd.command || cmd.text)) || {};
      return { ok: true, reply: out.msg || '已处理。' };
    }
    case 'person_name': {
      const people = require('./people');
      const uid = S(cmd.uid || (ctx && ctx.uid));
      const pid = S(cmd.pid) || (uid ? people.pidOfIdAll(uid) : '');
      if (!S(cmd.name)) return { ok: false, reply: '没听清要改成什么名字，我没动。' };
      if (!pid) return { ok: false, reply: '这个号还没在人物表里（' + uid + '），先在面板「人物」建一下档，或者用面板直接改。我什么都没动。' };
      people.setState(pid, { name: S(cmd.name) }, { byUser: true });
      const got = people.nameOfPerson(pid);
      const ok = got === S(cmd.name);
      return { ok, reply: ok ? '名字改成「' + S(cmd.name) + '」了。'
        : '名字没写进去。\n' + diag('person_name', { pid, 期望: S(cmd.name), 读回: got }) };
    }
    case 'person_name_ask':
      return { ok: false, reply: '要改谁的名字？把号或者他现在叫什么一起说，比如「把 123456 的名字改成 小明」。我什么都没改。' };
    case 'person_query': {
      const people = require('./people');
      const uid = S(cmd.uid);
      const pid = people.pidOfIdAll(uid);
      if (!pid) return { ok: true, reply: '人物表里还没有 ' + uid + '，面板上也没他的资料。' };
      const names = people.namesOf(pid);
      const p = people.get(pid) || {};
      const cards = (p.accounts || []).map(a => people.platLabel(a.platform) + ' ' + a.id + '「' + S(a.nick) + '」');
      const out = ['' + uid + ' 在人物表里叫「' + (names[0] || '没记名字') + '」'];
      if (names.length > 1) out.push('其他名字/代称：' + names.slice(1).join('、'));
      if (cards.length) out.push('资料卡：' + cards.join('；'));
      out.push('好感 ' + people.getFavor(pid) + (people.isFavorLocked(pid) ? '（已锁定）' : ''));
      return { ok: true, reply: out.join('\n') };
    }
    case 'persona_set': {
      const convState = require('./conv-state');
      const setting = S(cmd.setting || cmd.value || cmd.content);
      const topic = S(cmd.topic) || '人设';
      const uid = S(cmd.uid || (ctx && ctx.uid));
      const byMaster = !!cmd.byMaster;
      if (!setting) return { ok: false, reply: '没听清要变成什么样，我什么都没改。' };

      /* 名字（2026-11-25 主人令：「状态里可以直接把名字改成豆包」「主人是虚幻不变」）：
       * 走人设层单槽（注入时最后单独压一节）；主人改写默认值（who=''），别人写的只挂他自己名下。
       * 主人名字始终是默认名，不跟着这个名字走；回复里说清楚。 */
      if (convState.isNameTopic(topic)) {
        const nm = String(setting).replace(/^[\s「『"“']+|[\s」』"”']+$/g, '').trim();
        if (!nm || nm.length > 16 || /[，。！？、,;；]/.test(nm)) {
          return { ok: false, reply: '名字要 1~16 个字，不能带句号逗号。我什么都没改。' };
        }
        const who = byMaster ? '' : convState.personaWhoOf(uid);
        if (!who && !byMaster) return { ok: false, reply: '没认出你是谁，我什么都没改。\n' + diag('persona_set', { uid, 原因: '没有可挂的 who' }) };
        const r = convState.upsertPersona(who, topic, nm, S(ctx && ctx.nick) || (byMaster ? '主人' : '有人'));
        if (!r || !r.ok) return { ok: false, reply: '名字没写进去：' + ((r && r.error) || '未知原因') };
        const got = convState.nameOfTurn(byMaster ? [] : convState.whoListOf(uid));
        if (!got || got.name !== nm) return { ok: false, reply: '写了但读回来对不上。\n' + diag('persona_set', { who, 期望: nm, 读回: got ? got.name : '(没有)' }) };
        let defName = '虚幻';
        try { defName = require('./config').cfgLive().botName || '虚幻'; } catch {}
        return { ok: true, reply: byMaster
          ? '默认名字改成「' + nm + '」了：所有人看到你都会自称' + nm + '；主人还叫「' + defName + '」，不变。'
          : '记下了：你跟我说话的时候我叫「' + nm + '」。主人还是「' + defName + '」，别人也还是默认的。' };
      }

      /* 主人说的 = 改默认值：单项（发型 / 眼睛…）直接改本体那几条全局状态，
       * 整体（你是一个猫娘）写全局人设；别人说的只挂他自己名下，绝不碰默认。 */
      if (byMaster && topic !== '人设') {
        convState.upsert('', 'normal', setting, topic);
        const got = (convState.list().states || []).find(s => !s.who && !s.persona && s.topic === topic);
        const ok = !!got && got.text === setting;
        return ok ? { ok: true, reply: '默认的' + topic + '改成「' + setting + '」了，所有人都是这样。' }
          : { ok: false, reply: '写了但读回来对不上。\n' + diag('persona_set', { who: '(全局)', topic, 期望: setting, 读回: got ? got.text : '(没有)' }) };
      }

      let who = '';
      if (!byMaster) {
        who = convState.personaWhoOf(uid);
        if (!who) return { ok: false, reply: '没认出你是谁，我什么都没改。\n' + diag('persona_set', { uid, 原因: '没有可挂的 who' }) };
      }
      const r = convState.upsertPersona(who, topic, setting, S(ctx && ctx.nick) || (byMaster ? '主人' : '有人'));
      if (!r || !r.ok) return { ok: false, reply: '人设没写进去：' + ((r && r.error) || '未知原因')
        + '\n' + diag('persona_set', { who, topic, 期望: setting }) };
      // 状态只有一个槽，装不下的那部分落到「约定」（约定是兜底，不是「除了单句设定全进约定」）
      if (r.overflow) {
        let saved = null;
        try { saved = require('./core').pactAdd(uid, S(ctx && ctx.nick), r.overflow, S(ctx && ctx.scope), { byMaster }); }
        catch (e) { console.log('[指令] 人设溢出落约定失败：' + errBrief(e)); }
        return saved
          ? { ok: true, reply: '状态那一份装不下了，多出来的这段记成约定：' + r.overflow }
          : { ok: false, reply: '状态装不下，约定也没记进去。\n' + diag('persona_set', { topic, 溢出: r.overflow }) };
      }
      const pr = convState.personaFor(byMaster ? [] : convState.whoListOf(uid));
      const got = (byMaster ? pr.global : pr.mine)[0];
      const ok = !!got && ((got.parts && got.parts[topic] === setting) || got.text === setting);
      if (!ok) return { ok: false, reply: '写了但读回来对不上。\n'
        + diag('persona_set', { who, topic, 期望: setting, 读回: got ? got.text : '(没有)' }) };
      return { ok: true, reply: byMaster
        ? '默认人设改了：' + setting + '。所有人都会这样，直到你说恢复默认。'
        : (topic === '人设'
          ? '记下了：你跟我说话的时候我是' + setting + '。别人还是默认的虚幻，看不到这个。'
          : '记下了：你跟我说话的时候，我的' + topic + '是「' + setting + '」。别人还是默认的虚幻，看不到这个。') };
    }
    case 'persona_reset': {
      const convState = require('./conv-state');
      const uid = S(cmd.uid || (ctx && ctx.uid));
      const byMaster = !!cmd.byMaster;
      const topic = S(cmd.topic) === '人设' ? '' : S(cmd.topic);   // 空 = 整个恢复
      const who = byMaster ? '' : convState.personaWhoOf(uid);
      const r = convState.resetPersona(who, topic);
      // 名字条还可能是普通状态（面板旧数据）：按主题一并删掉，恢复默认名
      if (!topic || convState.isNameTopic(topic)) {
        for (const tp of (topic ? [topic] : convState.NAME_TOPICS)) {
          convState.delTopic(who, 'normal', tp);
          convState.delTopic(who, 'local', tp);
        }
      }
      if (byMaster) convState.restoreBody(topic);                  // 单项恢复：本体那几条回默认值
      if (convState.isNameTopic(topic)) {
        let defName = '虚幻';
        try { defName = require('./config').cfgLive().botName || '虚幻'; } catch {}
        return { ok: true, reply: byMaster
          ? '名字恢复默认了：又自称「' + defName + '」了；主人名字没动。'
          : '你看到的我恢复成原来的名字了。' };
      }
      return { ok: true, reply: byMaster
        ? ('默认人设已恢复：删了 ' + r.removed + ' 条，本体那几项也回默认了。')
        : ('你看到的我恢复成原来的虚幻了（删了 ' + r.removed + ' 条）。') };
    }
    case 'person_region': {
      const region = require('./region');
      const people = require('./people');
      const pid = S(cmd.pid) || (S(cmd.uid) ? people.pidOfIdAll(S(cmd.uid)) : '');
      const uid = pid || S(cmd.uid);
      if (!uid) return { ok: false, reply: '没听清是谁的地区，我没动。' };
      const city = S(cmd.city);
      const r = region.setRegion(uid, city);
      const got = region.getRegion(uid);
      const ok = got === city || (!!got && String(got).indexOf(city) >= 0);
      return ok ? { ok: true, reply: '地区改成「' + got + '」了。' }
        : { ok: false, reply: '地区没写进去。\n' + diag('person_region', { uid, 期望: city, 读回: got, 变更: !!(r && r.changed) }) };
    }
    case 'person_lock': {
      const people = require('./people');
      const pid = S(cmd.pid) || (S(cmd.uid) ? people.pidOfIdAll(S(cmd.uid)) : '');
      if (!pid) return { ok: false, reply: '这个号还没在人物表里，先在面板建一下档。我什么都没动。' };
      people.setFavorLock(pid, !!cmd.on);
      const got = people.isFavorLocked(pid);
      const ok = got === !!cmd.on;
      return ok ? { ok: true, reply: '好感已' + (cmd.on ? '锁定' : '解锁') + '。' }
        : { ok: false, reply: '锁没写进去。\n' + diag('person_lock', { pid, 期望: !!cmd.on, 读回: got }) };
    }
    case 'ai_mark':
    case 'ai_unmark': {
      /* AI 账号标记 / 改回（2026-11-23 主人补做）：发话入口。落盘全复用面板 /api/ai/mark|unmark，
       * 不写第二份：清好感锁 0 / 记豁免 / 关录入跟面板按钮完全同一套。裸 QQ 号（还没建档）也认——
       * 面板接口支持 { platform, id } 直接标，不必先在人物表建档。 */
      const aiMark = require('./ai-mark');
      const platform = S(cmd.platform) || 'qq';
      const uid = S(cmd.uid);
      const isUnmark = cmd.action === 'ai_unmark';
      if (!uid) return { ok: false, reply: '没听清是哪个号，我没动。说「ai账号123456」这种带号的说法就行。' };
      const r = await panelCall('POST', isUnmark ? '/api/ai/unmark' : '/api/ai/mark',
        { platform, id: uid });
      if (!r || r.error) return { ok: false, reply: (isUnmark ? '没改成：' : '没标上：') + ((r && r.error) || '未知原因') };
      // 读回校验：mark 后 isAI 必须为真；unmark 后必须为假
      const nowAI = aiMark.isAI(platform, uid);
      const ok = isUnmark ? !nowAI : nowAI;
      const who = S(cmd.pid) || uid;
      return ok
        ? { ok: true, reply: isUnmark
            ? ('已把 ' + uid + ' 改回人物：以后不再自动判成 AI，好感锁也解了。')
            : ('已把 ' + uid + ' 标成 AI 账号：只建档、好感清 0 锁住，不再记画像和喜好。') }
        : { ok: false, reply: '写了但读回没对上，可能没存进去。\n' + diag(cmd.action, { platform, uid, 现在是否AI: nowAI }) };
    }
    case 'taste_add': {
      const taste = require('./taste');
      const people = require('./people');
      const uid = S(cmd.uid) || (S(cmd.pid) ? people.primaryQQ(S(cmd.pid)) : '');
      const text = S(cmd.text);
      if (!uid || !text) return { ok: false, reply: '没听清记给谁、记什么，我没动。' };
      const sec = S(cmd.sec) || 'likeConf';
      const okAdd = taste.addItem(uid, sec, text);
      return okAdd ? { ok: true, reply: '记下了：' + uid + ' ' + (sec === 'hateConf' ? '讨厌' : '喜欢') + '「' + text + '」。' }
        : { ok: false, reply: '没加上（内容空或已存在）。\n' + diag('taste_add', { uid, sec, text }) };
    }
    case 'fallback_add': {
      const cfgStore = require('./config');
      const line = S(cmd.line).slice(0, 500);
      if (!line) return { ok: false, reply: '没听清要加哪句，我没动。' };
      const cur = cfgStore.load().offline || {};
      const pool = Array.isArray(cur.pool) ? cur.pool.slice() : [];
      pool.push({ id: 'fb-' + Date.now(), text: line, scope: '', enabled: true });
      const r = cfgStore.patch('offline', Object.assign({}, cur, { pool }));
      if (!r || !r.ok) return { ok: false, reply: '兜底池没写进去：' + ((r && r.error) || '未知原因') };
      const after = cfgStore.load().offline || {};
      const ok = (after.pool || []).some(x => S(x && x.text) === line);
      return ok ? { ok: true, reply: '兜底池加了一句：「' + line + '」，现在共 ' + after.pool.length + ' 条。' }
        : { ok: false, reply: '写了但读回来没这句。\n' + diag('fallback_add', { line, 条数: (after.pool || []).length }) };
    }
    case 'person_role': {
      /* 身份（2026-11-22 她令）：身份就是称呼。管理类，只有主人能下。
       * 主人 / 欧尼酱 按号认；「朋友」由朋友录决定（好感 > 20），不在这里手标。 */
      const people = require('./people');
      const pid = S(cmd.pid) || (S(cmd.uid) ? people.pidOfIdAll(S(cmd.uid)) : '');
      if (!pid) return { ok: false, reply: '这个号还没在人物表里，先在面板建一下档。我什么都没动。' };
      const raw = S(cmd.role);
      const MAP = { '朋友': 'friend', '认识的人': 'known', '认识': 'known', '熟人': 'known', '陌生人': 'stranger', '陌生': 'stranger', '朋友录': 'friend' };
      const want = MAP[raw] || (/^(friend|known|stranger)$/.test(raw) ? raw : '');
      if (!want) return { ok: false, reply: '身份只能标成 认识的人 / 陌生人；「朋友」由朋友录决定（好感超过 20 就进朋友录）。' };
      if (want === 'friend') {
        const v = Math.max(people.FRIEND_AT + 1, people.getFavor(pid));
        people.setFavor(pid, v, { force: true });
        return { ok: true, reply: '好感调到 ' + people.getFavor(pid) + '，' + people.nameOfPerson(pid || '') + '进朋友录了。' };
      }
      const r = people.setRole(pid, want);
      if (!r) return { ok: false, reply: '身份没写进去，那个人可能已经不在人物表里了。' };
      const got = people.roleLabel(people.roleOf(pid));
      return { ok: true, reply: '身份标成「' + got + '」了。' };
    }
    case 'person_call': {
      /* 主人对某人的专属叫法（2026-11-22 她令）：注入里「昵称（主人称呼方式）」就是它，
       * 虚幻喊人也跟着这个叫。管理类，只有主人能下。 */
      const people = require('./people');
      const pid = S(cmd.pid) || (S(cmd.uid) ? people.pidOfIdAll(S(cmd.uid)) : '');
      if (!pid) return { ok: false, reply: '这个号还没在人物表里，先在面板建一下档。我什么都没动。' };
      const call = S(cmd.call || cmd.name);
      if (!call) return { ok: false, reply: '没听清你喊他什么，我没动。' };
      if (!people.setMasterCall(pid, call)) return { ok: false, reply: '没写进去。' };
      return { ok: true, reply: '记住了：你喊他「' + people.masterCallOf(pid) + '」，我也会跟着这么叫。' };
    }
    case 'person_sex': {
      /* 性别（2026-11-22 她令）：面板能改，嘴上也该能改。管理类，只有主人能下。 */
      const people = require('./people');
      const pid = S(cmd.pid) || (S(cmd.uid) ? people.pidOfIdAll(S(cmd.uid)) : '');
      if (!pid) return { ok: false, reply: '这个号还没在人物表里，先在面板建一下档。我什么都没动。' };
      const raw = S(cmd.sex);
      const want = /女|female/.test(raw) ? 'female' : /男|male/.test(raw) ? 'male' : '';
      if (!want) return { ok: false, reply: '性别只能标成 男 / 女。' };
      const r = people.setSex(pid, want, 'confirmed');
      if (!r) return { ok: false, reply: '性别没写进去。' };
      return { ok: true, reply: '性别标成「' + people.sexLabel(r.sex) + '」了。' };
    }
    case 'person_favor': {
      const people = require('./people');
      const uid = S(cmd.uid || (ctx && ctx.uid));
      const pid = S(cmd.pid) || (uid ? people.pidOfIdAll(uid) : '');
      const v = Number(cmd.value);
      if (!Number.isFinite(v)) return { ok: false, reply: '没听清要改多少好感，我没动。' };
      if (!pid) return { ok: false, reply: '这个号还没在人物表里，先在面板建一下档。我什么都没动。' };
      people.setFavor(pid, Math.max(0, Math.min(100, Math.round(v))), { force: true });
      const got = people.getFavor(pid);
      return { ok: got === Math.max(0, Math.min(100, Math.round(v))), reply: '好感度已改成 ' + got + '。' };
    }
    case 'memory_log': {
      // appendMemory 收的是「行数组」，传字符串会被逐字拆成一条条约定（踩过一次）
      const line = S(cmd.text || fullText);
      core.appendMemory([line], '主人指令', 'promise', S(ctx && ctx.nick) || '主人');
      return { ok: true, reply: '记进工作日志了。' };
    }
    case 'pact_add': {
      const it = core.promiseAdd({
        kind: 'promise',
        // 约定谁都能立，是谁立的就是谁立的，不再一律写成「主人」
        byMaster: !!S(ctx && ctx.isMaster),
        text: S(cmd.text || fullText),
        qq: S(ctx && ctx.uid), platform: S(ctx && ctx.platform) || 'qq',
        scope: S(ctx && ctx.scope) || '私聊', who: S(ctx && ctx.nick) || (S(ctx && ctx.isMaster) ? '主人' : '有人'),
      });
      // 把写入的约定 id 带出去记进账本，「3 分钟内撤销上一条」要按 id 精确删，不能靠原文猜
      return { ok: true, reply: '记成约定了。', pactId: it && it.id };
    }
    /* 撤销上一条指令的效果（2026-11-20 主人令）。
     * 「把这个约定删了」= 命令：撤掉这个人 3 分钟以内刚下的上一条成功指令，所有人都可用。
     * 从指令账本倒着找同人、3 分钟内、成功、且属于「可撤销记录类」的一条；
     * 目前真正能反做的只有 pact_add——按它落盘时记下的 pactId 精确物理删（主人选的「从表里删掉」）。
     * 其余记录类不假装撤成功，明确回话说明还没接上，绝不动数据。 */
    case 'undo_last': {
      const platform = S(ctx && ctx.platform) || 'qq';
      const uid = S(ctx && ctx.uid);
      const WINDOW = 3 * 60 * 1000;
      const UNDOABLE = new Set(['pact_add']);
      const since = Date.now() - WINDOW;
      let lines = [];
      try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
      const rows = [];
      for (const ln of lines) {
        try { rows.push(JSON.parse(ln)); } catch (e) { /* 坏行跳过 */ }
      }
      // 已被撤销过的（有别的日志用 undoneOf 指向它）跳过，避免连说两次「删了」重复删
      const undoneSet = new Set(rows.map(r => S(r && r.undoneOf)).filter(Boolean));
      const mine = rows.slice().reverse().find(r => r
        && String(r.uid) === uid && String(r.platform || 'qq') === platform
        && r.ok === true && UNDOABLE.has(r.action)
        && !undoneSet.has(String(r.t))
        && Date.parse(r.t) >= since);
      if (!mine) {
        // 3 分钟内没有可撤的（超时 / 不是约定）→ 把这个人最近的一条指令摆出来，
        // 让人知道该拿哪条去找主人撤（2026-11-20 主人给的文案，要求「说明上一条」）。
        const recentAny = rows.slice().reverse().find(r => r
          && String(r.uid) === uid && String(r.platform || 'qq') === platform
          && r.action && r.action !== 'none' && r.action !== 'undo_last');
        if (!recentAny) {
          return { ok: false, reply: '没找到你能撤销的指令。\n'
            + diag('undo_last', { platform, uid, 窗口: '3 分钟', 可撤: 'pact_add' }) };
        }
        const ago = Math.max(0, Math.round((Date.now() - Date.parse(recentAny.t)) / 1000));
        const agoText = ago >= 60 ? (Math.round(ago / 60) + ' 分钟前') : (ago + ' 秒前');
        return { ok: false, reply: '3分钟前的指令找主人撤回吧～上一条是：'
          + S(recentAny.text).slice(0, 60) + '（' + agoText + ' · ' + S(recentAny.action) + '）'
          + '\n' + diag('undo_last', { platform, uid, 上一条: recentAny.t, 动作: S(recentAny.action) }) };
      }
      if (mine.action === 'pact_add') {
        const scope = S(ctx && ctx.scope) || S(mine.scope);
        const r = core.pactRemove(uid, { id: S(mine.pactId), text: S(mine.text), scope });
        if (!r || !r.ok) {
          return { ok: false, reply: '没撤成：' + ((r && r.error) || '约定已经不在了')
            + '\n' + diag('undo_last', { 原指令: mine.t, pactId: S(mine.pactId), 原因: (r && r.error) || '' }) };
        }
        return { ok: true, reply: '撤回了刚记的约定：' + S(r.text).slice(0, 30), undoneOf: mine.t };
      }
      return { ok: false, reply: '这一步还没接上，什么都没改。' + diag('undo_last', { 动作: mine.action }) };
    }
    /* 「撤回这一条」= 撤回**回执里点名的那条指令**（2026-11-21 主人令）。
     * 回执文案「上一条是：XXX」摆出来的就是这个人最近一条指令；她说「撤回这一条」就撤那条。
     * 跟 undo_last 的差别：不限 3 分钟、不限次数、能撤任意**带回滚数据**的指令（数值/开关/约定）。
     * 回滚数据在执行当时记进账本（out.undo / pactId）；没有回滚数据的指令不假装撤成功。
     * 只撤这个人自己（platform+uid）的，绝不撤别人的。 */
    case 'undo_ref': {
      const platform = S(ctx && ctx.platform) || 'qq';
      const uid = S(ctx && ctx.uid);
      let lines = [];
      try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
      const rows = [];
      for (const ln of lines) { try { rows.push(JSON.parse(ln)); } catch (e) { /* 坏行跳过 */ } }
      // 已被撤过的（有别的日志用 undoneOf 指向它）跳过 → 连说「撤回这一条」能一条条往前撤，不限次数
      const undoneSet = new Set(rows.map(r => S(r && r.undoneOf)).filter(Boolean));
      const target = rows.slice().reverse().find(r => r
        && String(r.uid) === uid && String(r.platform || 'qq') === platform
        && r.ok === true && !undoneSet.has(String(r.t))
        && r.action !== 'undo_last' && r.action !== 'undo_ref' && r.action !== 'none'
        && (r.undo || (r.action === 'pact_add' && r.pactId)));
      if (!target) {
        return { ok: false, reply: '没找到你能撤回的指令（最近一条要么撤过了、要么没有可回滚的数据）。\n'
          + diag('undo_ref', { platform, uid }) };
      }
      const u = target.undo || {};
      try {
        const state = require('./server/state');
        if (u.kind === 'num' && u.key && Number.isFinite(Number(u.old))) {
          const r = state.setNum(u.key, Number(u.old));
          if (!r || !r.ok) throw new Error((r && r.error) || '写回数值失败');
        } else if (u.kind === 'switch' && u.key) {
          const r = state.setSwitch(u.key, !!u.old);
          if (!r || r.error) throw new Error((r && r.error) || '写回开关失败');
        } else if (target.action === 'pact_add' && S(target.pactId)) {
          const r = core.pactRemove(uid, { id: S(target.pactId), text: S(target.text), scope: S(target.scope) });
          if (!r || !r.ok) throw new Error((r && r.error) || '约定已经不在了');
        } else {
          return { ok: false, reply: '这一条没有可回滚的数据，我没法自动撤回，什么都没改。\n'
            + diag('undo_ref', { 原指令: target.t, 动作: S(target.action) }) };
        }
      } catch (e) {
        return { ok: false, reply: '没撤成：' + errBrief(e)
          + '\n' + diag('undo_ref', { 原指令: target.t, 动作: S(target.action) }) };
      }
      const what = u.kind === 'num' ? (u.key + ' 恢复成 ' + u.old)
        : u.kind === 'switch' ? (u.key + ' 恢复成 ' + (u.old ? '开' : '关'))
        : '刚记的约定';
      return { ok: true, reply: '撤回了这一条：' + what, undoneOf: target.t };
    }
    /* 「换回原来那句」：约定全部保留，换回来只是把它排回最前，一个字的原文都不改。
     * 和「记一条新的」分开：新的是追加，换回是排序。 */
    case 'pact_switch': {
      const q = S(cmd.text || fullText);
      const r = core.pactRestore(S(ctx && ctx.uid), q);
      if (!r || !r.ok) {
        return { ok: false, reply: '没找到那条约定，我什么都没动。\n'
          + diag('pact_switch', { 找的: q.slice(0, 60), 原因: (r && r.error) || '没匹配上' }) };
      }
      return { ok: true, reply: '换回「' + S(r.say || r.text).slice(0, 40) + '」了，其他几条都还留着，想再换也行。' };
    }
    default:
      return { ok: false, reply: '没认出这是哪条指令，我什么都没改。' };
  }
}

/* 主人私聊：命中就执行；没认出也明确回一句，不落回模型聊天。 */
async function handle(ctx) {
  ctx = ctx || {};
  const platform = S(ctx.platform) || 'qq';
  const uid = S(ctx.uid);
  // 面板是本机已登录的管理入口，直接放行；聊天侧必须过主人号校验
  if (!ctx.fromPanel && !isOwner(platform, uid)) return { handled: false, reason: 'not-owner' };
  const full = [S(ctx.text), S(ctx.evidence)].filter(Boolean).join('\n');
  let cmd = null, out = null;
  try {
    cmd = deterministic(full, ctx);
    if (!cmd) cmd = await semantic(full, ctx);
    /* 2026-11-25：根本不是指令时不吞消息。
     * 真因：主人私聊一句「多个真相理论…如果你没有这个功能，我怎么给你加上」被语义层误判成
     * trigger_add，指令层 handled:true 直接 return → 正常发言永远进不了聊天模型。
     * 现在：面板（fromPanel）仍给一条回执；聊天侧返回 handled:false，让 qq.js 继续走正常聊天。 */
    if (!cmd || cmd.action === 'none') {
      if (ctx.fromPanel) return { handled: true, ok: false, action: 'none', reply: '没认出这是哪条指令，我什么都没改。' };
      return { handled: false, reason: 'not-command' };
    }
    // 走到这里的一定是主人（上面过了 isOwner）→ 人设改的是默认值
    if (cmd && (cmd.action === 'persona_set' || cmd.action === 'persona_reset')) cmd.byMaster = true;
    out = await execute(cmd || { action: 'none' }, ctx, full);
  } catch (e) {
    // 出错要能直接复制给我修：动作 + 哪个键 + 原始报错 + 出错行
    console.log('[指令] 执行异常：' + errBrief(e));
    out = { ok: false, reply: '这条指令执行时抛错了，什么都没改成。\n' + diag((cmd && cmd.action) || 'unknown', { 错误: errBrief(e), 键: (cmd && (cmd.key || cmd.gid)) || '' }) };
  }
  logAction({ platform, uid, action: (cmd && cmd.action) || 'none', ok: !!out.ok, text: S(ctx.text).slice(0, 200), scope: S(ctx.scope), pactId: S(out && out.pactId), undoneOf: S(out && out.undoneOf), undo: (out && out.undo) || undefined });
  return { handled: true, ok: !!out.ok, action: (cmd && cmd.action) || 'none', reply: out.reply };
}

/* 主人**在群里**发的指令（2026-11-19 实测暴露：主人在群里发「上下文条数改成40条」被当成闲聊答了）。
 * 群里放宽到「主人的号任何场景」，但只跑确定性识别：认得出才执行，认不出就当正常聊天，
 * 绝不因为一句闲聊调模型解析、也不吞掉主人在群的正常发言。 */
async function handleGroup(ctx) {
  ctx = ctx || {};
  // 2026-11-22：带图 / 引用 / 转发的消息不进群指令层。
  // 真因：主人发 B 站截图 → 视觉描述里含「B站」「一开始」→ 被 matchSwitch 当成
  // 「打开 bilibili」，群里回「bilibili 已打开。」（群858455686、894917172 实测）。
  // 图片描述不是用户说的话，引用/转发同理，一律不解析。
  if (ctx.hasImg || ctx.quoted) return { handled: false, reason: 'img-or-quote' };
  const platform = S(ctx.platform) || 'qq';
  const uid = S(ctx.uid);
  if (!isOwner(platform, uid)) return { handled: false, reason: 'not-owner' };
  const full = [S(ctx.text), S(ctx.evidence)].filter(Boolean).join('\n');
  let cmd = null, out = null;
  try {
    cmd = deterministic(full, ctx);
  } catch (e) { return { handled: false, reason: 'parse-error: ' + errBrief(e) }; }
  // 没认出 / 只是「要记哪个号」的反问，都不在群里插话
  if (!cmd || cmd.action === 'none' || cmd.action === 'alias_ask') return { handled: false, reason: 'not-command' };
  // 记录类（约定 / 换回 / 代称 / 小本本 / 喜好 / 人设）已由 handleRecord 在所有人身上处理过：
  // 群里 silent 只记账，私聊回一句。主人在群里时若这里再跑一遍，会重复记账，还会把
  // 「记成约定了。」当指令回执发到群里、并 return 吞掉正常聊天（2026-11-20 复读真因）。
  if (RECORD_ACTIONS.has(cmd.action)) return { handled: false, reason: 'record-by-handleRecord' };
  if (cmd.action === 'persona_set' || cmd.action === 'persona_reset') cmd.byMaster = true;   // 群里这条也是主人的号
  try {
    out = await execute(cmd, ctx, full);
  } catch (e) {
    console.log('[指令] 群内执行异常：' + errBrief(e));
    out = { ok: false, reply: '这条指令执行时抛错了，什么都没改成。\n' + diag(cmd.action, { 错误: errBrief(e), 键: (cmd.key || cmd.gid) || '' }) };
  }
  logAction({ platform, uid, action: cmd.action, ok: !!out.ok, text: S(ctx.text).slice(0, 200), scope: S(ctx.scope), from: 'group', pactId: S(out && out.pactId), undoneOf: S(out && out.undoneOf), undo: (out && out.undo) || undefined });
  return { handled: true, ok: !!out.ok, action: cmd.action, reply: out.reply, allowOff: !!out.allowOff };
}

/* 全场景纠错：任何人/主人纠错都记待修复 + 约定，但门槛不同。
 * 私聊：主人宽松（「不对」也算）；别人私聊用明确词。
 * 群里：不管是谁都只认明确词，而且必须在跟她说话（@她 / 引用她）——
 *   群里随口一句「不对」「错了」只是聊天，不能变成全群禁语，也不能把那条消息吞掉。
 * silent=true 表示「只记账，别回、别打断这条的正常聊天」。 */
const CORR_LOOSE = /(标错|说错|记错|错了|不对|不准确|不该这么|别这么说|以后别说)/;
const CORR_STRICT = /(标错|说错了|说错话|记错了|答错了|不准确|别这么说|以后别说)/;
async function handleCorrection(ctx) {
  ctx = ctx || {};
  const text = S(ctx.text);
  const byMaster = !!(ctx.isMaster || ctx.fromPanel || isOwner(S(ctx.platform) || 'qq', ctx.uid));
  const inPrivate = !!(ctx.isPrivate || ctx.fromPanel);
  const hit = inPrivate ? (byMaster ? CORR_LOOSE : CORR_STRICT) : CORR_STRICT;
  if (!hit.test(text)) return { handled: false };
  if (!inPrivate && !(ctx.atMe || ctx.replyToMe)) return { handled: false };
  const target = S(ctx.evidenceFull || ctx.evidence || ctx.replyFull || text).slice(0, 240);
  if (!target) return { handled: false };
  let out;
  try {
    out = await markWrong(target, extractReason(text), ctx, text);
  } catch (e) {
    console.log('[指令] 标错写入异常：' + errBrief(e));
    const reply = '标错没写进去，什么都没改成。\n' + diag('mark_wrong', { 错误: errBrief(e) });
    return { handled: true, ok: false, silent: !inPrivate, reply };
  }
  logAction({ platform: S(ctx.platform) || 'qq', uid: S(ctx.uid), action: byMaster ? 'correction_master' : 'correction_other', ok: true, text: text.slice(0, 200), scope: S(ctx.scope) });
  return { handled: true, ok: true, silent: !inPrivate, reply: out.reply };
}

/* 记录类动作：只「记东西」，不碰开关 / 数值 / 群开关 / 撤回 / 触发词 / 暂停。
 * 主人 2026-11-19 定：**这些是所有人的**——谁都能触发、谁都能改数据；群里也要松，
 * 不能像管理类那样只认主人的号。其余指令才是主人的，群里单独收紧（见 handleGroup）。 */
const RECORD_ACTIONS = new Set(['pact_add', 'pact_switch', 'undo_last', 'undo_ref', 'alias_set', 'memory_log', 'taste_add', 'persona_set', 'persona_reset']);

/* 全场景「记录类」指令：任何人都能触发，走确定性识别，不花模型钱。
 * 标错不在这里重复判一遍——它有自己的词表和「在跟她说话」门槛（handleCorrection）。 */
async function handleRecord(ctx) {
  ctx = ctx || {};
  const platform = S(ctx.platform) || 'qq';
  const uid = S(ctx.uid);
  if (!uid) return { handled: false, reason: 'no-uid' };
  const text = S(ctx.text);
  const full = [text, S(ctx.evidence)].filter(Boolean).join('\n');
  const inPrivate = !!(ctx.isPrivate || ctx.fromPanel);

  // 便宜预筛：这句里连一个「记东西」的字眼都没有，就不必往下解析（否则每条群消息都要读群名表）
  if (!/(约定|以后每次|记下来|记住|叫我|我叫|叫|喊|称呼|换回|换成|换掉|更换|捞回|证明|标错|说错|记错|错了|不对|不准确|不该这么|别这么说|以后别说|小本本|工作日志|长期记忆|你是|你变成|你的|变回|恢复|原来的|原本|默认|人设|设定|样子|撤回这|撤掉这|撤销这|撤回一|撤这一)/.test(text))
    return { handled: false, reason: 'no-record-hint' };

  /* 0) 「@我 我叫 XX」——别人跟她自报名字，**第一优先**（2026-11-19 主人令）。
   * 群里必须是在跟她说话（@她 / 引用她），私聊直接算。
   * 写成代称，不动名字位：名字位只有主人点名改才动。 */
  const selfName = extractSelfName(text);
  if (selfName && (inPrivate || ctx.atMe || ctx.replyToMe || ctx.fromPanel)) {
    const acc = (ctx && ctx.account) || { platform, id: uid };
    let out;
    try {
      out = await execute({ action: 'alias_set', platform: acc.platform || platform, uid: acc.id || uid, name: selfName, text }, ctx, full);
    } catch (e) {
      out = { ok: false, reply: '名字没记进去。\n' + diag('self_name', { uid, name: selfName, 错误: errBrief(e) }) };
    }
    logAction({ platform, uid, action: 'self_name', ok: !!out.ok, text: text.slice(0, 200), scope: S(ctx.scope), from: 'record' });
    return { handled: true, ok: !!out.ok, action: 'self_name', silent: !inPrivate, reply: out.reply };
  }

  // 1) 标错：走 handleCorrection（含别人的严格门槛），命中就结束
  const corr = await handleCorrection(ctx);
  if (corr && corr.handled) return corr;

  // 2) 约定 / 代称 / 记小本本
  let cmd = null;
  try { cmd = deterministic(full, ctx); } catch (e) { return { handled: false, reason: 'parse-error' }; }
  if (!cmd || !RECORD_ACTIONS.has(cmd.action)) return { handled: false, reason: 'not-record' };

  let out;
  try {
    out = await execute(cmd, ctx, full);
  } catch (e) {
    console.log('[指令] 记录类执行异常：' + errBrief(e));
    out = { ok: false, reply: '没记进去，什么都没改。\n' + diag(cmd.action, { 错误: errBrief(e) }) };
  }
  logAction({ platform, uid, action: cmd.action, ok: !!out.ok, text: text.slice(0, 200), scope: S(ctx.scope), from: 'record', pactId: S(out && out.pactId), undoneOf: S(out && out.undoneOf), undo: (out && out.undo) || undefined });
  // 群里只记账、不回话（不打断正常聊天）；私聊回一句确认
  return { handled: true, ok: !!out.ok, action: cmd.action, silent: !inPrivate, reply: out.reply };
}

module.exports = {
  handle, handleGroup, handleRecord, handleCorrection, isOwner, deterministic, semantic,
  catalog: () => ACTIONS.slice(), extractAccounts, extractCallName, extractRenameName,
  personByName, normalizeTrigger, triggerCommandOf, _execute: execute, diag, errBrief, setRecaller,
  extractSelfName, extractPersona, extractPersonaReset,
};
