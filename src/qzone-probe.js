/* ===========================================================================
 * qzone-probe.js — 校对 QQ 空间的频率上限（2026-11-17 主人令）
 *
 * 她的三次纠正（按时间）：
 *   ①「你设这个四项的上限，说明你没有遵守我的规则，你纯属ai幻觉了」
 *   ②「TMD我说适用上限规则，意思是让你每次去根据版本更新重测新的上限」
 *   ③「怎么可能！你还不如去搜索社区最新口径来的真」
 *
 * 结论：**初始值取社区公开口径，不靠我连拉试探。**
 *   · 原来打算「连着拉不同人的说说，直到被拒」来测——不可行也不该做：
 *     官方《QQ空间使用规则》写明「最近 30 天内被禁止他人访问达 3 次及以上」不支持解封，
 *     累积 3 次就永久失去空间。为测一个数字冒这个险，代价和收益完全不对称。
 *   · 社区口径已给出数字（见 platform-limits.js 里每项的 note）：
 *     评论 3 条/天、两条评论 ≥10 分钟、逛不同人 ≥20 秒、触发后 15 分钟~1 小时恢复。
 *
 * 那「重测」还测什么：**只做校对，不发请求。**
 *   真实运行中若撞到限流（noteLimit 记下当时时间和当时的额度），说明口径对不上，
 *   就用真实数据覆盖成 measured——这才是有据的实测。
 *   没有撞顶记录就一直用社区口径，界面上标明「社区口径（T2）」，不冒充官方/实测。
 * =========================================================================== */
const qc = require('./qzone-comment');
const platLimits = require('./platform-limits');

const LIMIT_RE = qc.LIMIT_RE;
const COOL_MS = 30 * 60 * 1000;   // 撞顶后歇 30 分钟（社区口径 15 分钟~1 小时）

/* ===== 校对：只读记录，不发任何请求 =====
 *   · 某天出现过限流类失败 → 那天成功了几条、距上次评论隔了多久，就是真实的额度证据
 *   · 没撞过顶 → 什么都不写，保持社区口径（不拿下限冒充上限） */
function learnPassive() {
  const st = qc.readState();
  const rows = qc.readAll().filter(e => e && e.comment && e.t);
  const skips = (st.skipped || []).filter(s => LIMIT_RE.test(String(s.why || '')));
  const perDay = {};
  for (const e of rows) {
    const d = String(e.t).slice(0, 10);
    perDay[d] = (perDay[d] || 0) + 1;
  }
  const hitDays = new Set(skips.map(s => String(s.t || '').slice(0, 10)));
  const out = { perDay: 0, perDayWritten: false, hitDays: [...hitDays] };

  // 每天几条：取撞过顶那些天里最多的成功条数
  let bestHit = 0;
  for (const d of hitDays) bestHit = Math.max(bestHit, perDay[d] || 0);
  if (bestHit > 0) {
    const w = platLimits.setCap('qzonePerDay', bestHit, true);
    out.perDay = bestHit; out.perDayWritten = !!(w && w.ok);
  }
  /* 两条评论的间隔不校对：它等于主人自己设的 qzone.everyHours（与发说说共用一个数），
   * 不是平台口径数字，撞顶记录也改不了主人设的值。 */
  return out;
}

/* ===== 给自动重测（QQ 版本变）和手动命令共用：不发请求，只校对 ===== */
async function probeAll() {
  const l = learnPassive();
  const pd = platLimits.get('qzonePerDay');
  const vg = platLimits.get('qzoneVisitGap');
  const conf = qc.confOf();
  const srcName = o => (o.source === 'measured' ? '实测校正' : o.source === 'community' ? '社区口径' : '现网值');
  const parts = [
    '每天几条：' + pd.cap + ' 条（' + srcName(pd) + '）' + (l.perDayWritten ? ' ← 已按撞顶记录改成 ' + l.perDay : ''),
    '两条评论间隔：' + conf.everyHours + ' 小时（你设的间隔）',
    '逛不同人间隔：' + vg.cap + ' 秒（' + srcName(vg) + '）',
  ];
  return {
    ok: true,
    text: parts.join('；') + (l.hitDays.length ? '' : '。没有撞顶记录，保持社区口径（没发任何请求）'),
    passive: l,
  };
}

/* 运行中撞到限流时记一笔（实现只有一份，在 qzone-comment） */
function noteLimit(why, qq) { return qc.noteLimit(why, qq); }

module.exports = { learnPassive, probeAll, noteLimit, LIMIT_RE, COOL_MS };
