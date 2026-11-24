/*
 * tests/test-dates.js — 「重要的日子」自检（会临时写数据，测完原样还原）
 *
 * 这是干什么的：改完 src/dates.js / core.js 的记忆整理 / people.js 的建档后跑一遍，确认
 *   ① 日期归一化认她写的格式（2026.10.21），垃圾日期不认
 *   ② 她自己那两个日子（生日、第一次上 B 站）真进了提示词
 *   ③ 新人第一次建档会记「第一次相遇」，老人物不补假日期
 *   ④ 跟人聊天时提示词里带「你和 X 第一次见面是哪天」，跟别人聊不带别人的
 *   ⑤ 记忆整理员抄回来的「10月21日 生日」能落成一条日子
 *
 * 什么时候跑：node tests/test-dates.js
 *
 * 为什么不能只 node --check：2026-11-04 踩过——语法过、运行时被 catch 吞掉，
 * 提示词整段消失都没人发现。这里一律打真实产物（promptLines / buildMessages）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const DATES = path.join(ROOT, 'src', 'data', 'dates.json');
const PEOPLE = path.join(ROOT, 'src', 'data', 'people.json');
const WLOG = path.join(ROOT, 'src', 'data', 'bot-writes.jsonl');
const TMP_QQ = '1000001000';          // 测试专用号，测完从 people.json 里删掉

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

const bakDates = fs.existsSync(DATES) ? fs.readFileSync(DATES) : null;
const bakPeople = fs.readFileSync(PEOPLE);
const bakWlog = fs.existsSync(WLOG) ? fs.readFileSync(WLOG) : null;
function restore() {
  try { bakDates ? fs.writeFileSync(DATES, bakDates) : fs.unlinkSync(DATES); } catch {}
  try { fs.writeFileSync(PEOPLE, bakPeople); } catch {}
  try { bakWlog ? fs.writeFileSync(WLOG, bakWlog) : fs.unlinkSync(WLOG); } catch {}
}

(async () => {
  const dates = require(path.join(ROOT, 'src', 'dates'));
  const people = require(path.join(ROOT, 'src', 'people'));
  const core = require(path.join(ROOT, 'src', 'core'));
  const cfg = require(path.join(ROOT, 'src', 'config')).load();
  core.init(cfg);
  try { require(path.join(ROOT, 'src', 'websearch')).search = async () => ''; } catch {}

  try {
    // ===== A. 日期归一化 =====
    console.log('[归一化]');
    t('2026.10.21（她写的格式）', dates.normDate('2026.10.21') === '2026-10-21');
    t('2026年10月28日', dates.normDate('2026年10月28日') === '2026-10-28');
    t('10.21 → 只到月日', dates.normDate('10.21') === '10-21');
    t('2026-13-01 不认', dates.normDate('2026-13-01') === '');
    t('2月30日 不认', dates.normDate('2026-02-30') === '');
    t('乱码不认', dates.normDate('随便哪天') === '');

    // ===== B. 她从人话里抠日期 =====
    console.log('[从人话抠]');
    let p = dates.parse('10月21日 生日');
    t('「10月21日 生日」→ 10-21 / 生日', p && p.date === '10-21' && p.what === '生日', JSON.stringify(p));
    p = dates.parse('生日是 2026.10.21');
    t('「生日是 2026.10.21」→ 10-21 / 生日是…', p && p.date === '2026-10-21', JSON.stringify(p));
    p = dates.parse('2026-11-06 · 12-03 他生日');       // 带写入日期的行，别把写入日期当事件
    t('剥掉行首写入日期，只认 12-03', p && p.date === '12-03', JSON.stringify(p));
    t('没日期 → null', dates.parse('他喜欢打游戏') === null);

    // ===== C. 她自己那两个日子 =====
    console.log('[她自己的日子]');
    const me = dates.selfItems();
    const bd = me.find(x => x.what === '生日');
    const bs = me.find(x => /B ?站/.test(x.what));
    t('生日记的是 2026-10-21', !!bd && bd.date === '2026-10-21', JSON.stringify(bd));
    t('第一次上 B 站记的是 2026-10-28', !!bs && bs.date === '2026-10-28', JSON.stringify(bs));
    const pl = dates.promptLines();
    t('常驻段里有生日', pl.includes('2026-10-21') && pl.includes('生日'));
    t('常驻段里有第一次上 B 站', pl.includes('2026-10-28'));
    t('重复写同一条不堆垃圾', dates.add({ date: '2026.10.21', what: '生日', who: 'self' }).id === bd.id);

    // ===== D. 周年判断 =====
    console.log('[周年]');
    t('2027-10-21 → 生日（第 1 年）', dates.todayLine('2027-10-21').includes('生日（第 1 年）'), dates.todayLine('2027-10-21'));
    t('2028-10-28 → 上 B 站（第 2 年）', dates.todayLine('2028-10-28').includes('第 2 年'), dates.todayLine('2028-10-28'));
    t('平常日子不报', dates.todayLine('2027-03-05') === '');

    // ===== E. 新人建档 = 第一次相遇 =====
    console.log('[第一次相遇]');
    const pid = people.ensure('qq', TMP_QQ, { nick: '测试小号' });
    t('新人建了人物卡', !!pid);
    const m = dates.meetOf(TMP_QQ);
    t('自动记了一条「第一次相遇」', !!m && m.kind === 'meet', JSON.stringify(m));
    t('日期是今天', !!m && m.date === dates.todayStr(), m && m.date);
    t('幂等：再调一次不新增', (() => {
      const n = dates.ofWho(TMP_QQ).length;
      people.ensure('qq', TMP_QQ, { nick: '测试小号' });
      return dates.ofWho(TMP_QQ).length === n;
    })());
    // 老人物（11-03 批量建档）不补假日期
    const oldQQ = Object.keys(people.load()).map(k => people.load()[k])
      .flatMap(x => (x.accounts || []).filter(a => a.platform === 'qq').map(a => a.id))
      .find(id => id && id !== TMP_QQ);
    t('老人物没被补上假相遇日', !!oldQQ && !dates.meetOf(oldQQ), oldQQ || '取样失败');

    // ===== F. 提示词按人注入 =====
    console.log('[提示词]');
    const build = async (k, ctx, text) => {
      core.setTurn(k, ctx);
      const msgs = await core.buildMessages(k, text);
      return msgs.map(x => String(x.content || '')).join('\n');
    };
    let all = await build('k_meet', { uid: TMP_QQ, gid: 1000001001, nick: '测试小号', atMe: true }, '在吗');
    t('跟他聊 → 带「你和眼前这个人的日子」', all.includes('你和眼前这个人的日子'));
    t('  且写明第一次见面日期', all.includes('第一次见面是 ' + dates.todayStr()));
    all = await build('k_other', { uid: '1000001001', gid: 1000001001, nick: '路人', atMe: true }, '在吗');
    t('跟没记录的人聊 → 不出现这段', !all.includes('你和眼前这个人的日子'));
    const sp = String(core.systemPrompt() || '');
    t('她自己的日子在常驻提示词里', sp.includes('2026-10-21') && sp.includes('2026-10-28'));

    // ===== G. 记忆整理员抄回来的日子 =====
    console.log('[自动记]');
    p = dates.parse('10月21日 生日');
    const before = dates.all().length;
    dates.add({ date: p.date, what: p.what, who: 'self', name: '虚幻', type: 'auto' });
    t('自动记的日子能落盘（去重后条数不变）', dates.all().length === before);
    const one = dates.add({ date: '03-15', what: '测试纪念日', who: TMP_QQ, name: '测试小号', kind: 'other', type: 'auto' });
    // 落盘键统一成 'platform:id'（2026-11-06 她要求 QQ 也带前缀）：
    // 老调用方照样传裸号，写进去是 qq:123，读（ofWho）两种写法都认。
    t('别人告诉的日子也记（带人）', !!one && one.who === 'qq:' + TMP_QQ, one && one.who);

    // ===== H. 聊天里顺手记（不调模型）=====
    console.log('[顺手记]');
    const n0 = dates.all().length;
    core.noteDates('我生日是10月21日', { uid: cfg.masterQQ, nick: '主人', isMaster: true });
    t('主人说「我生日是10月21日」→ 归到她自己的日子（已存在，不新增）', dates.all().length === n0 && !!dates.selfItems().find(x => x.what === '生日'));
    core.noteDates('我们第一次见面是11月1日', { uid: TMP_QQ, nick: '测试小号' });
    t('群友说「第一次见面是11月1日」→ 记在他名下', !!dates.ofWho(TMP_QQ).find(x => x.what.includes('第一次见面')));
    const n1 = dates.all().length;
    core.noteDates('10月21日上映', { uid: '1234567', nick: '路人' });
    t('「10月21日上映」不记（没有日子类关键词）', dates.all().length === n1);
    core.noteDates('生日快乐呀', { uid: '1234567', nick: '路人' });
    t('「生日快乐」没日期 → 不记', dates.all().length === n1);
    core.noteDates('我生日是10月21日', { uid: '1234567', nick: '路人' });
    t('群友说的生日记在他名下，不串到她身上', !!dates.ofWho('1234567').find(x => x.what === '生日'));
  } catch (e) {
    t('跑完不崩', false, e && e.message);
    console.error(e);
  } finally {
    restore();
  }

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
