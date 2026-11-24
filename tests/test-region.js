/*
 * tests/test-region.js — 地区表按人物 + AI 记地区（2026-11-19 主人令）
 *
 * 验四件事：
 *   ① 地区表按人物：一个人多个账号（QQ / B站）共用一份；老裸 QQ 键读得到、写时挪走
 *   ② 从图上的字 / 直接说的话里认地区，**保留最细原文**（面板上有多细显示多细）：
 *      「登陆地点：西安市 未央区」→ 存「西安市 未央区」，不砍成「西安」
 *   ③ 没变化就不记（setRegion 回 changed:false）→ 不记就不汇报
 *   ④ 只有喂 AI 才降级：briefForAI 砍到市/区级；buildMessages 里图上 OCR 原文不进
 *
 * 什么时候跑：node tests/test-region.js（用 __dirname 定位）。不联网、不写线上数据
 *   —— region 指到临时文件，跑完删；buildMessages 断网桩。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

(async () => {
  const region = require(path.join(ROOT, 'src', 'region'));
  const people = require(path.join(ROOT, 'src', 'people'));
  const core = require(path.join(ROOT, 'src', 'core'));
  const cfg = require(path.join(ROOT, 'src', 'config')).load();

  // 临时地区表，绝不碰线上 data/people-region.json
  const tmp = path.join(os.tmpdir(), 'xuh-region-test-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify({
    '100000000': '鞍山',     // 老数据：裸 QQ 号
  }), 'utf8');
  region._setFile(tmp);

  // ===== ① 认地区（保留最细原文）=====
  t('图上的字：登陆地点：西安市 未央区 → 原样保留到区级',
    region.learnFrom('字：登陆地点：西安市 未央区 / 情绪：委屈 / 是什么：正义小红花界面') === '西安市 未央区',
    '得到 ' + region.learnFrom('字：登陆地点：西安市 未央区 / 情绪：委屈'));
  t('图上更细的街道也留下（面板有多细显示多细）',
    region.learnFrom('登陆地点：西安市 未央区小寨路街道') === '西安市 未央区小寨路街道',
    '得到 ' + region.learnFrom('登陆地点：西安市 未央区小寨路街道'));
  t('IP属地 → 省', region.learnFrom('IP属地：四川') === '四川', '得到 ' + region.learnFrom('IP属地：四川'));
  t('直接说住哪 → 成都', region.learnFrom('我在成都啊') === '成都');
  t('直接说住处带区 → 原样保留', region.learnFrom('我住成都武侯区') === '成都武侯区',
    '得到 ' + region.learnFrom('我住成都武侯区'));
  t('坐标杭州 → 杭州', region.learnFrom('坐标杭州') === '杭州');
  t('没地区不瞎猜', region.learnFrom('今天天气不错哈') === '');
  t('「登陆地点：暂无」不乱收', region.learnFrom('登陆地点：暂无') === '',
    '得到 ' + region.learnFrom('登陆地点：暂无'));

  // ===== ①b 只有喂 AI 才降级（市/区级）=====
  t('briefForAI：西安市 未央区小寨路街道 → 西安市 未央区',
    region.briefForAI('西安市 未央区小寨路街道') === '西安市 未央区',
    '得到 ' + region.briefForAI('西安市 未央区小寨路街道'));
  t('briefForAI：成都武侯区 → 成都武侯区',
    region.briefForAI('成都武侯区') === '成都武侯区');
  t('briefForAI：只有市级就保持市级', region.briefForAI('西安') === '西安');
  t('briefForAI：省也认', region.briefForAI('四川') === '四川');
  t('briefForAI：空不炸', region.briefForAI('') === '');

  // ===== ② 按人物对应 =====
  // 用真实人物表里的一个「多账号」人物，不改它，只借用身份映射
  const multi = (people.all().find(p => (p.accounts || []).length >= 2) || {});
  const pid = multi.pid;
  const accs = (multi.accounts || []).map(a => a.platform + ':' + a.id);
  if (pid && accs.length >= 2) {
    const r = region.setRegion(pid, '绵阳');
    t('按人物写：changed=true', r.changed === true && r.city === '绵阳', JSON.stringify(r));
    t('这个人换一个账号查，还是同一份地区', region.getRegion(accs[1]) === '绵阳',
      accs[1] + ' → ' + region.getRegion(accs[1]));
    const again = region.setRegion(accs[0], '绵阳');
    t('没变化就不记（changed=false）→ 不会汇报', again.changed === false, JSON.stringify(again));
    const moved = region.setRegion(accs[1], '宜宾');
    t('换城市才算变化（changed=true）', moved.changed === true && moved.prev === '绵阳', JSON.stringify(moved));
    t('一个人只留一条地区（同人其它账号键清掉）', (() => {
      const keys = Object.keys(JSON.parse(fs.readFileSync(tmp, 'utf8')));
      const samePersonKeys = keys.filter(k => accs.some(a => a === k || a.endsWith(':' + k)) || k === pid);
      return samePersonKeys.length === 1 && samePersonKeys[0] === pid;
    })());
    t('清掉地区', (region.clearRegion(pid), region.getRegion(accs[0]) === ''));
  } else {
    t('人物表里有多个账号的人物可测', false, '没找到多账号人物');
  }

  // 老数据：裸 QQ 号仍读得到；一写就挪到人物键
  const legacyUid = '100000000';
  t('老数据裸 QQ 键读得到', region.getRegion(legacyUid) === '鞍山', '得到 ' + region.getRegion(legacyUid));
  const mig = region.setRegion(legacyUid, '鞍山');
  t('老数据没变化不重写', mig.changed === false);

  // ===== ③ 存储是全的、面板读全的；只有进提示词才降级到市/区级 =====
  core.init(cfg);
  try { require(path.join(ROOT, 'src', 'websearch')).search = async () => ''; } catch {}
  if (pid) {
    const full = '西安市 未央区小寨路街道';
    region.setRegion(pid, full);
    t('存储/面板读到的仍是最细原文', region.getRegion(pid) === full,
      '得到 ' + region.getRegion(pid));
    const k = 'region_prompt_' + process.pid;
    core.setTurn(k, { uid: accs[0], nick: multi.name || '测试', gid: '100000000', atMe: true, scope: '群100000000' });
    const msgs = await core.buildMessages(k, '你好呀');
    const all = msgs.map(m => String(m.content || '')).join('\n');
    t('提示词里有市/区级那条', all.includes('## 眼前这个人所在地') && all.includes('\n西安市 未央区'),
      '没找到所在地块');
    t('提示词里没有街道门牌（只喂到区级）', !all.includes('小寨路街道'));
    t('用途写明：认识所在地 / 天气 / 大型活动',
      /认识对方所在地/.test(all) && /天气/.test(all) && /大型活动/.test(all));
    t('图上 OCR 原文不进提示词', !all.includes('登陆地点：'));
  }

  // ===== ④ 源码守卫：汇报只在真变化时；三张人物卡都有地区输入 =====
  const qqSrc = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'qq.js'), 'utf8');
  t('QQ 侧先判 changed 再汇报主人',
    /chg\s*&&\s*chg\.changed/.test(qqSrc) && /core\.master\('记地区：'/.test(qqSrc));
  const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'app.js'), 'utf8');
  t('客户端三张人物卡都有地区输入 + 保存按钮',
    (appSrc.match(/data-region-pid=/g) || []).length >= 3
    && /act === 'save-region'/.test(appSrc));
  const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'panel.js'), 'utf8');
  t('后端有地区读写接口，且按人物取',
    /\/api\/region\/set/.test(panelSrc) && /region\.getRegion\(p\.pid\)/.test(panelSrc));

  try { fs.unlinkSync(tmp); } catch {}
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
