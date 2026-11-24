/*
 * rules/prompt-scenes.js — 常驻提示词「按场景选择注入」路由表
 *
 * 为什么有这个文件（主人 2026-11-19 令「按需调用、减少消耗，不是标注下就算完成工作」）：
 *   以前 core.js 的 systemPrompt() 对每次模型调用都把 1.6 万字常驻段一字不差全灌，
 *   不分 QQ 群 / QQ 私聊 / B站私信 / 直播间 / 自检。真花钱的是这里，不是 rules/output.js
 *   那种纯 CPU 判定（它们从不进 prompt，搬它一分钱省不下来）。
 *
 * 做法沿用项目已授权的模式：SOUL_SCENES / RESP_SCENES（主人 2026-11-05 定「按使用场景拆分」，
 *   命中才注入、平时不灌省 token）。这里同样只决定「这一段这一轮注不注入」，
 *   **段内文字一个字不改**，全部原文仍在 core.js 的 systemPrompt() 里。
 *
 * 守卫兼容（关键）：自检 / test-persona / test-dates 都是 `core.systemPrompt()` 无参调用，
 *   本路由在「没有场景信号」时一律返回 full=true = 全量注入，老断言一条不破。
 *   只有真实链路 buildMessages() 传了 ctx 才按场景裁。
 *
 * 场景信号来自 core.getTurn(k)：ctx.source ('qq'/'bili')、ctx.gid、ctx.private。
 */
'use strict';

// 平台专属段：只在 QQ 场景注入。B站私信 / 直播间用不到 QQ 的 @号/表情/加群/群名片规矩。
// key 是 core.js systemPrompt() 里那一段的标题前缀（含 '## '，不含换行）。
// 这些段原文一个字不动，只是 B站/自检场景不拼进来。
const PLATFORM_ONLY = [
  { head: '## 你在 QQ 里能做什么', why: 'QQ 平台能力（拍一拍/加群/@号/表情），B站用不到' },
  { head: '## 聊天记录的规矩', why: 'QQ 聊天记录的引用格式、@、退群名，B站没有这套格式' },
  // 表情包清单 2252 字：[表情:名字] 只有 qq.js 发送层解析；bili-dm.js 明写「别硬加表情」，
  //   B站私信/直播根本不发 QQ 表情包 → 这段在 B站 100% 白烧。段首带 <!-- sticker-list sig --> 注释，
  //   filterSystem 切段时连注释一起切走。
  { head: '## 表情包（库里', why: 'QQ 专属表情清单 2252 字，B站不解析 [表情:名字]，纯浪费' },
];

// 「问到才用」的参考段：默认不注入，只有这一轮真的问到才给。
// 命中词放宽：宁可多注入，也不能因为没命中就让模型答不出（主人「压了会掉功能」红线）。
// 来源都是 soul/功能词典.md 里的节；原文在 readSoul() 拼出来的 personaText 里，
// 这里只记标题前缀，由 core.js 决定摘不摘。
const REFERENCE_SEGMENTS = [
  { head: '## 功能名索引（我有哪些功能 · 归到哪一类）',
    re: /有哪些功能|什么功能|能做什么|会做什么|你能干什么|你怎么(帮|做|弄)|功能索引|分类代表|>m<.*功能/i },
  { head: '## 检索与联网',
    re: /搜|查一下|查查|搜一下|百度|谷歌|维基|是什么|是谁|资料|出处| wikipedia|联网/i },
  { head: '## 回话路径（四张表，同一个入口）',
    re: /回话路径|四张表|怎么回|该不该回|回话规则/i },
];

// 判断一段（'## ' 开头的标题行）在当前场景要不要注入。
// ctx 为空 / 无 source / scene='full' → 全量（守卫与自检兼容线）。
function want(headLine, ctx, userText) {
  if (!ctx || !ctx.source || ctx.source === 'full') return true;   // 无场景 = 全量
  const head = String(headLine || '').trim();

  const plat = PLATFORM_ONLY.find(p => head.startsWith(p.head));
  if (plat && ctx.source !== 'qq') return false;                   // QQ 专属，非 QQ 不灌

  const ref = REFERENCE_SEGMENTS.find(r => head.startsWith(r.head));
  if (ref && !ref.re.test(String(userText || ''))) return false;   // 参考段，没问到不灌

  return true;
}

/* 把 systemPrompt 全量串按 '\n## ' 切成段，逐段决定注不注入，再原样拼回。
 * 段边界与 core.js systemPrompt() 的数组项一致：每项要么以 '\n## 标题' 开头，
 * 要么是 personaText 内部自带的 '## 标题'。开头第一段（'# 虚幻'）永远保留。
 * 关键：只丢整段、不改段内任何字符；拼回用相同分隔符，未命中的场景与全量逐字相同。 */
function filterSystem(full, ctx, userText) {
  const s = String(full || '');
  if (!s) return s;
  // 切段：'## ' 前一定有 '\n'；若标题前紧挨一行 <!-- 注释 -->（表情清单的 sig 标记），
  // 让注释跟着标题归到同一段，裁段时一起走，避免注释残留。拼回用 join('') 逐字还原。
  const pieces = s.split(/(?=\n(?:<!--[^\n]*-->\n)?## )/);
  const out = [];
  for (const piece of pieces) {
    // piece 形如 '\n## 标题\n正文' 或 '\n<!-- 注释 -->\n## 标题\n正文'；开头段是 '# 虚幻\n...'
    const m = piece.match(/^\n?(?:<!--[^\n]*-->\n)?(## [^\n]*)/);
    if (!m) { out.push(piece); continue; }              // 开头段 / 无标题 → 保留
    if (want(m[1], ctx, userText)) out.push(piece);     // 命中 → 原样保留整段（含它的注释）
  }
  let result = out.join('');
  // 表情清单被裁时，它的 sig 签名注释可能孤立残留（注释物理上夹在两段之间）。
  // 该注释是给人看的签名、不是给模型的规则（systemPrompt 对 personaText 同样剥 <!-- -->），
  // 只在「表情段确实被裁掉」时剥掉这条孤立注释；表情段保留的场景一个字不动。
  if (ctx && ctx.source && ctx.source !== 'full'
      && !want('## 表情包（库里', ctx, userText)) {
    result = result.replace(/\n<!--\s*sticker-list[^\n]*-->/g, '');
  }
  return result;
}

// 给自检 / 面板看的表：谁被裁、为什么。
function explain() {
  return {
    platformOnly: PLATFORM_ONLY.map(p => ({ head: p.head, why: p.why, only: 'qq' })),
    reference: REFERENCE_SEGMENTS.map(r => ({ head: r.head, when: String(r.re) })),
    compat: 'ctx 为空或 source=full → 全部注入，守卫不破',
  };
}

module.exports = { want, filterSystem, explain, PLATFORM_ONLY, REFERENCE_SEGMENTS };
