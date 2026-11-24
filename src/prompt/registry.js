'use strict';
/* ===========================================================================
 * prompt/registry.js —— 常驻提示词「段注册表」（2026-11-25 重构）
 *
 * 以前：core.systemPrompt() 拼出一大串，再由 rules/prompt-scenes.js 按
 * 「## 标题」前缀字符串切段、匹配正则决定这一轮注不注入。规则和正文分散两地，
 * 新增一段要同时改两处，改错一处就静默失效（真发生过）。
 *
 * 现在：一段一条声明 —— 哪一层（persona/people/scene/platform/rules/dynamic）、
 * 哪些平台/场景要、这一轮要不要（when）、正文在哪。正文暂时仍由 core.systemPrompt()
 * 产出（逐字节不变），本文件先接管**路由**，段级正文按段分批搬。
 *
 * 守卫兼容（关键）：ctx 为空 / source=full → 全量注入，自检与面板老断言一条不破。
 * =========================================================================== */

/* 平台专属段：只在 QQ 场景注入。head = core.systemPrompt() 里那一段的标题（含 '## '）。 */
const PLATFORM_ONLY = [
  { id: 'qq.powers', head: '## 你在 QQ 里能做什么', why: 'QQ 平台能力（拍一拍/加群/@号/表情），B站用不到' },
  { id: 'qq.records', head: '## 聊天记录的规矩', why: 'QQ 聊天记录的引用格式、@、退群名，B站没有这套格式' },
  { id: 'qq.stickers', head: '## 表情包（库里', why: 'QQ 专属表情清单 2252 字，B站不解析 [表情:名字]，纯浪费' },
];

/* 「问到才用」的参考段：默认不注入，只有这一轮真问到了才给（命中词放宽，宁可多给）。 */
const REFERENCE_SEGMENTS = [
  { id: 'ref.features', head: '## 功能名索引（我有哪些功能 · 归到哪一类）',
    re: /有哪些功能|什么功能|能做什么|会做什么|你能干什么|你怎么(帮|做|弄)|功能索引|分类代表|>m<.*功能/i },
  { id: 'ref.search', head: '## 检索与联网',
    re: /搜|查一下|查查|搜一下|百度|谷歌|维基|是什么|是谁|资料|出处| wikipedia|联网/i },
  { id: 'ref.replypath', head: '## 回话路径（四张表，同一个入口）',
    re: /回话路径|四张表|怎么回|该不该回|回话规则/i },
];

/* 一条规则 = 一段的注册项。 */
const SECTIONS = [
  ...PLATFORM_ONLY.map(x => Object.assign({ layer: 'platform', scenes: ['qq'] }, x)),
  ...REFERENCE_SEGMENTS.map(x => Object.assign({ layer: 'scene', scenes: ['ask'] }, x)),
];

/* 判断一段（'## 开头的标题行'）在当前场景要不要注入。 */
function want(headLine, ctx, userText) {
  if (!ctx || !ctx.source || ctx.source === 'full') return true;   // 无场景 = 全量
  const head = String(headLine || '').trim();
  const plat = PLATFORM_ONLY.find(p => head.startsWith(p.head));
  if (plat) return ctx.source === 'qq';
  const ref = REFERENCE_SEGMENTS.find(r => head.startsWith(r.head));
  if (ref) return ref.re.test(String(userText || ''));
  return true;
}

/* 把拼好的全量串按段过滤：只丢整段、不改段内一个字，拼回用相同分隔符。
 * 段边界与 core.systemPrompt() 的数组项一致；开头 '# 虚幻' 段永远保留。 */
function filterText(full, ctx, userText) {
  const s = String(full || '');
  if (!s) return s;
  const pieces = s.split(/(?=\n(?:<!--[^\n]*-->\n)?## )/);
  const out = [];
  for (const piece of pieces) {
    const m = piece.match(/^\n?(?:<!--[^\n]*-->\n)?(## [^\n]*)/);
    if (!m) { out.push(piece); continue; }
    if (want(m[1], ctx, userText)) out.push(piece);
  }
  let result = out.join('');
  // 表情清单被裁时签名注释会孤立残留：只在确实裁掉时剥掉（与旧实现逐字一致）
  if (ctx && ctx.source && ctx.source !== 'full' && !want('## 表情包（库里', ctx, userText)) {
    result = result.replace(/\n<!--\s*sticker-list[^\n]*-->/g, '');
  }
  return result;
}

/* 按注册表拼一段「临时 system」（新段一律走这里，不再往大函数里塞字符串）。 */
function compose(items) {
  return (Array.isArray(items) ? items : [])
    .filter(it => it && it.text && (typeof it.when !== 'function' || it.when()))
    .map(it => String(it.text))
    .filter(Boolean)
    .join('\n');
}

/* 给自检 / 面板看：谁被裁、为什么。 */
function explain() {
  return {
    sections: SECTIONS.map(s => ({ id: s.id, layer: s.layer, head: s.head })),
    platformOnly: PLATFORM_ONLY.map(p => ({ head: p.head, why: p.why, only: 'qq' })),
    reference: REFERENCE_SEGMENTS.map(r => ({ head: r.head, when: String(r.re) })),
    compat: 'ctx 为空或 source=full → 全部注入，守卫不破',
    note: '正文目前仍由 core.systemPrompt() 产出；本文件接管场景路由（逐字节等价）。',
  };
}

module.exports = { SECTIONS, PLATFORM_ONLY, REFERENCE_SEGMENTS, want, filterText, filterSystem: filterText, compose, explain };
