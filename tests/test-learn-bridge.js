/*
 * tests/test-learn-bridge.js —— 风格/心情桥的离线自检（2026-11-22）
 *
 * 为什么要有它：桥的失败方式是「静默返回空」——学了半天没人读，界面上也看不出。
 * 所以这里造两个现场：① 一个假的 AstrBot SQLite（心情/表达/已审风格三张表）
 * ② 一份假的 Writing-Style 档案，钉住「有就读出来、没有就空串、表缺了不崩」。
 *
 * 什么时候跑：node tests/test-learn-bridge.js（不联网；只在临时目录和仓库
 *   Writing-Style/__test__ 下建东西，跑完删干净）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const astrbot = require(path.join(ROOT, 'src', 'learn', 'astrbot'));
const bridge = require(path.join(ROOT, 'src', 'learn', 'bridge'));

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

const now = Math.floor(Date.now() / 1000);

function buildDb(file, sql) {
  execFileSync('/usr/bin/sqlite3', [file, sql], { timeout: 5000 });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-test-bridge-'));
const dbFull = path.join(tmpRoot, 'full.db');
const dbThin = path.join(tmpRoot, 'thin.db');

const sqlFull = [
  'create table bot_mood (id integer primary key, group_id text, mood_type text, mood_intensity real, mood_description text, timestamp real, is_active integer);',
  "insert into bot_mood values (1,'111','happy',0.62,'今天心情特别好'," + (now - 60) + ',1);',
  "insert into bot_mood values (2,'222','sad',0.5,'很久以前的心情'," + (now - 72 * 3600) + ',1);',
  "insert into bot_mood values (3,'111','angry',0.9,'旧的不该被读到'," + (now - 300) + ',0);',
  'create table expression_patterns (id integer primary key, group_id text, situation text, expression text, weight real);',
  "insert into expression_patterns values (1,'111','我每天起来都有','是不是只要在群里发了就有',2.0);",
  "insert into expression_patterns values (2,'111','看这个','三十秒的小动画',1.8);",
  "insert into expression_patterns values (3,'111','@大肥鱼(1000001000) 你猜','猜不到吧',1.6);",
  "insert into expression_patterns values (4,'111','似的','似的',1.5);",
  "insert into expression_patterns values (5,'111','今天吃啥','火锅吧',1.2);",
  "insert into expression_patterns values (6,'111','下班了','快跑',1.0);",
  "insert into expression_patterns values (7,'222','别理他','嗯',0.5);",
  'create table style_learning_reviews (id integer primary key, group_id text, learned_patterns text, status text);',
  "insert into style_learning_reviews (id, group_id, learned_patterns, status) values (1,'111','[{\"situation\":\"被夸\",\"expression\":\"嘿嘿谢谢\"}]','approved');",
  "insert into style_learning_reviews (id, group_id, learned_patterns, status) values (2,'111','[{\"situation\":\"没审的\",\"expression\":\"不该读到这句\"}]','pending');",
].join('\n');

const sqlThin = [
  'create table bot_mood (id integer primary key, group_id text, mood_type text, mood_intensity real, mood_description text, timestamp real, is_active integer);',
  "insert into bot_mood values (1,'333','calm',0.4,'只有心情表'," + now + ',1);',
].join('\n');

(async () => {
  buildDb(dbFull, sqlFull);
  buildDb(dbThin, sqlThin);

  /* ---------- AstrBot 读取器 ---------- */
  const r = await astrbot.refresh({ dbPath: dbFull, force: true });
  t('能读到库（ok=true）', r.ok === true, JSON.stringify(r.counts));
  t('心情覆盖两个群', r.counts.moods === 2, String(r.counts.moods));

  const m1 = astrbot.moodFor('111');
  t('命中该群当前心情', m1 && m1.type === 'happy' && Math.abs(m1.intensity - 0.62) < 1e-6, JSON.stringify(m1));
  t('is_active=0 的旧心情不算', !(m1 && m1.type === 'angry'));
  t('超过 48 小时的心情不注入', astrbot.moodFor('222') === null);
  t('没这个群就不借别群心情', astrbot.moodFor('404') === null);

  const ex = astrbot.exprFor('111', 5);
  t('表达样本按群取，最多 5 条', ex.length > 0 && ex.length <= 5, String(ex.length));
  t('太短的样本被丢掉（「哇」→「啊」这种当不了参考）', ex.every(x => x.expression.length >= 5 && x.situation.length >= 3));
  t('表达样本去掉 @昵称(数字)', ex.every(x => !/@[^\s]{1,20}[（(]\d{4,}/.test(x.situation + x.expression)));
  t('自己对自己的样本丢掉', ex.every(x => !(x.situation && x.situation === x.expression)));

  const st = astrbot.styleFor('111', 3);
  t('只读已通过审查的风格', st.length === 1 && st[0].indexOf('嘿嘿谢谢') >= 0, JSON.stringify(st));
  t('待审的不读', st.join('').indexOf('不该读到这句') < 0);

  const s = astrbot.state();
  t('state() 只给条数不给原文', typeof s.counts.moods === 'number' && JSON.stringify(s).indexOf('嘿嘿谢谢') < 0);

  const thin = await astrbot.refresh({ dbPath: dbThin, force: true });
  t('缺表不崩，还读到心情', thin.ok === true && astrbot.moodFor('333') !== null);
  t('缺表时表达样本为空', astrbot.exprFor('333', 5).length === 0);

  const none = await astrbot.refresh({ dbPath: path.join(tmpRoot, 'nope.db'), force: true });
  t('库不存在 → ok=false 不抛', none.ok === false);

  /* ---------- Writing-Style 档案 ---------- */
  const wdir = path.join(ROOT, 'Writing-Style', '__test__');
  try {
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'profiles.json'), JSON.stringify({
      version: 1,
      activeName: 'test',
      profiles: { test: { title: '测试风格', profile: { summary: '短句，不解释，结尾不带句号' } } },
    }));
    const bt = await bridge.refresh();
    t('有档案时读得出写作风格', String(bt.wstyle || '').indexOf('短句，不解释') >= 0, String(bt.wstyle || '').slice(0, 40));
    t('state 里能看到档案来源', String(bridge.state().writingFrom || '').indexOf('__test__') >= 0);
  } finally {
    try { fs.rmSync(path.join(ROOT, 'Writing-Style'), { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
  }
  const bt2 = await bridge.refresh();
  t('档案删掉后回到空串（不残留）', bt2.wstyle === '', String(bt2.wstyle || '').slice(0, 40));

  /* ---------- 收尾 ---------- */
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  console.log('FAIL', e && e.stack || e);
  process.exit(1);
});
