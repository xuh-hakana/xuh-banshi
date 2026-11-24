/*
 * tests/test-roster.js — 「模型不认识人」回归（2026-11-19 她报「模型不认识人」）
 *
 * 根因：提示词里「## 你认得的人」读的是早已废弃的 cfg.people（={}），
 *       永远输出「（这轮没有需要认的人）」→ 模型谁都不认识。
 *
 * 最终口径（她逐条纠正后定的，别再改回打码/过滤）：
 *   ① 全聊天场景通用，不止群聊 —— 群聊 / 私聊 / B站 都列人物表里的人
 *   ② **人物信息完全全部显示**：名字 / 别称 / 网名 / 各平台号（明文，不打码）/ 所在地
 *   ③ 所在地只到市/区级（briefForAI），街道门牌与图上 OCR 原文不进提示词
 *   ④ 隐私只管「说不说出口」，号和地区同一条线：**只有本人能聊自己的**——
 *      问自己的号/住哪/自己那边天气可以说；问别人的号或住哪、主动说别人，一律不报（含主人问）
 *
 * 验的事：
 *   ① 源码守卫：roster 不再读 cfg.people、不再被打码（redactPrivateQQ 已按新口径删除）
 *   ② 群聊：名单不空、能对上人、带所在地、号明文
 *   ③ 私聊：同样认识人、同样明文号、同样带所在地（全场景一致）
 *   ④ 隐私铁律真的写进了提示词（号与地区同一条线）
 *   ⑤ 街道门牌不进名单
 *   ⑥ 任何段落都不再出现打码占位（不外泄）
 *   ⑦ 别人的私聊话题/约定不外泄到群里（她 2026-11-19：「［私聊不外泄］」说的是这个，不是号）
 *
 * 跑法：node tests/test-roster.js（只读真实人物表 / 地区表，不写任何数据）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

(async () => {
  const core = require(path.join(ROOT, 'src', 'core'));
  const cfg = require(path.join(ROOT, 'src', 'config')).load();
  const peopleMod = require(path.join(ROOT, 'src', 'people'));
  const regionMod = require(path.join(ROOT, 'src', 'region'));
  const nickMod = require(path.join(ROOT, 'src', 'nick'));
  core.init(cfg);
  try { require(path.join(ROOT, 'src', 'websearch')).search = async () => ''; } catch {}

  // ===== ① 源码守卫 =====
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
  t('roster 不再读废弃的 cfg.people', !/Object\.entries\(cfg\.people\s*\|\|\s*\{\}\)/.test(coreSrc));
  t('roster 改用人物表 people.all()', /for \(const per of people\.all\(\)\)/.test(coreSrc));
  t('roster 不再被 redactPrivateQQ 打码',
    !/const roster = redactPrivateQQ\(/.test(coreSrc), '又被套上打码了');
  t('打码函数已按新口径删除（不再有调用）',
    !/redactPrivateQQ\s*\(/.test(coreSrc), '还有地方在打码');
  t('roster 用 briefForAI 降到市/区级',
    /region\.briefForAI\(regMap\[/.test(coreSrc), '没找到地区降级调用');

  // 只截「你认得的人」这一段（到下一个 ## 标题为止）——
  // 后面「长期记忆 / 约定」那些块走的是另一套打码（2026-11-06 隐私令），别混进来判。
  const segOf = (all) => {
    const i = all.indexOf('你认得的人');
    if (i < 0) return '';
    const rest = all.slice(i);
    const j = rest.indexOf('\n## ', 3);
    return j > 0 ? rest.slice(0, j) : rest.slice(0, 5000);
  };

  // 挑一个「有地区」的人当被测对象——否则「名单带所在地」那条会被静默跳过，
  // 看着全绿其实啥也没验（2026-11-19 踩过：第一次跑就挑到没地区的主人）。
  const regAll = regionMod.all() || {};
  const hasReg = (p) => {
    const accs = (p.accounts || []).filter(a => a && a.id);
    if (!accs.length) return false;
    return !!(regAll[p.pid] || accs.map(a => regAll[String(a.id)]).find(Boolean));
  };
  const pickable = peopleMod.all().filter(p => (p.accounts || []).length && (p.name || p.accounts[0].nick));
  const who = pickable.find(hasReg) || pickable[0];
  t('被测对象有地区（保证「带所在地」真的被验到）', !!(who && hasReg(who)),
    '人物表里没有一个有地区的人，这条验不到');
  if (!who) { t('人物表里有可测的人', false, '人物表为空'); }
  else {
    const sid = String(who.accounts[0].id);
    const label = String(who.name || who.accounts[0].nick || '').trim();
    const regMap = regAll;
    const regRaw = regMap[who.pid]
      || (who.accounts || []).map(a => regMap[String(a && a.id)]).find(Boolean) || '';
    const regBrief = String(regionMod.briefForAI(regRaw) || '').trim();
    t('被测对象确实取到了地区原文', !!regBrief, '地区原文为空：' + JSON.stringify(regRaw));

    // ===== ② 群聊 =====
    const gid = '100000000';
    const k = 'roster_grp_' + process.pid;
    core.teachSetPresent(k, [sid]);
    core.setTurn(k, { uid: sid, nick: label, gid, atMe: true, scope: '群' + gid });
    const gall = (await core.buildMessages(k, '在吗')).map(m => String(m.content || '')).join('\n');
    const gseg = segOf(gall);
    t('「你认得的人」不再是「这轮没有需要认的人」',
      !gseg.includes('（这轮没有需要认的人）'), gseg.slice(0, 100));
    t('群聊能对上人物表里的人', gseg.includes(label), '没找到 ' + label);
    t('群聊号明文（不打码）', !gseg.includes('不外泄'), gseg.slice(0, 200));
    if (regBrief) {
      t('群聊名单带所在地（市/区级）', new RegExp('所在地：' + regBrief.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(gseg),
        '期望 所在地：' + regBrief);
    }

    // ===== ③ 私聊（同一份人物信息，不打折） =====
    const k2 = 'roster_dm_' + process.pid;
    core.teachSetPresent(k2, [sid]);
    core.setTurn(k2, { uid: sid, nick: label, gid: '', atMe: true, scope: '私聊' });
    const dall = (await core.buildMessages(k2, '在吗')).map(m => String(m.content || '')).join('\n');
    const dseg = segOf(dall);
    t('私聊也认识人物表里的人（全场景通用，不止群聊）', dseg.includes(label), '没找到 ' + label);
    t('私聊号也明文（跟群聊一致，不打折）',
      dseg.includes(sid), '没出现 ' + sid);
    t('私聊名单也不打码', !dseg.includes('不外泄'), dseg.slice(0, 200));
    if (regBrief) {
      t('私聊名单也带所在地', new RegExp('所在地：' + regBrief.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(dseg),
        '期望 所在地：' + regBrief);
    }

    // ===== ④ 隐私铁律（号与地区同一条线：只有本人能聊自己的） =====
    t('铁律：号和所在地一样是隐私，只有本人能聊自己的',
      /号[^\n]*和所在地一样是隐私，只有本人能聊自己的/.test(dall));
    t('铁律：别人问第三个人的号或住哪，一律不说', /别人问第三个人的号或住哪/.test(dall));
    t('铁律：问的人就算是主人，也一样不报', /问的人就算是主人/.test(dall));
    t('铁律：名单里的号是给对号/@人/认人用的', /对号、@ 人、认人/.test(dall));
    t('铁律：分界线是「问的人是不是他本人」', /分界线只有一个/.test(dall));
    t('铁律：名单外的人别编', /名单外的人别编/.test(dall));
    t('任何段落都不再打码（长期记忆也不再留「不外泄」占位）',
      !dall.includes('不外泄') && !dall.includes('非本群成员'), '还留着打码占位');

    // ===== ④b 说清「现在跟你说话的是谁」（没这段就分不清「我的号」和「别人的号」）=====
    t('提示词说清了现在跟你说话的是谁（带他自己的号）',
      /## 现在跟你说话的是谁/.test(dall) && new RegExp('号：' + sid).test(dall),
      '缺身份段或没带 ' + sid);
    t('身份段写明这是他自己、只有他能聊',
      /这是[他她]\*\*自己\*\*的号/.test(dall), '没写清归属');

    // ===== ④b2 全平台/多账号资料卡 + 其他所有名字（她 2026-11-19 令）=====
    // 名单要逐个账号列资料卡名（不能只报主账号那张），并把名字/代称全部给出；
    // 眼前这个人按当前 (platform,id) 精确对上他那张资料卡，换号不串。
    t('名单逐账号列出资料卡名', /（资料卡：/.test(gseg), '没有资料卡段');
    t('名单给出全部名字/代称', /（全部名字：/.test(gseg), '没有全部名字段');
    // 2026-11-22 晚（她令）：名单里的名字只用来认人，不能当称呼喊
    t('名单里的名字标了「只用来认人，不能当称呼喊」',
      /（全部名字：[\s\S]*?这些只用来认人，不能当称呼喊）/.test(gseg), '没有「只用来认人」的限定');
    t('身份段给出当前账号的资料卡名（或明确没有）',
      /这个号在资料卡上写的是|（没有昵称）/.test(dall), '身份段缺资料卡名');

    // 主人在 B站 也该拿到 B站 那张资料卡（不是 QQ 那张）：用真实人物表里
    // 有 B站 账号的人造一轮 bili 上下文，确认提示词带的是 B站 号那一行。
    const withBili = peopleMod.all().find(p => (p.accounts || []).some(a => a.platform === 'bili' && a.nick));
    if (withBili) {
      const ba = withBili.accounts.find(a => a.platform === 'bili' && a.nick);
      const kB = 'roster_bili_' + process.pid;
      core.setTurn(kB, { source: 'bili', uid: String(ba.id), nick: String(ba.nick), atMe: true });
      const ball = (await core.buildMessages(kB, '在吗')).map(m => String(m.content || '')).join('\n');
      t('B站场景也认识人（全聊天场景通用）',
        segOf(ball).includes(String(ba.nick)), 'B站 名单没找到 ' + ba.nick);
      t('B站身份段对上 B站 号与资料卡名',
        new RegExp('号：' + ba.id).test(ball) && ball.includes(String(ba.nick)),
        '没对上 bili:' + ba.id + ' / ' + ba.nick);
    }

    // 代称污染守卫：喊人记录功能曾把整句写进 name/alias/cards，摘脏值后不得回流。
    const coreSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
    const qqSrc = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'qq.js'), 'utf8');
    t('qq.js 的「叫我 XX」只从 nick.callMeName 取候选',
      /core\.nick\.callMeName\(text\)/.test(qqSrc), '没走句首/停顿祈使句闸');
    t('qq.js 的「观察到别人喊」写代称前过 looksLikeName 闸',
      /if \(typeof core\.nick\.looksLikeName !== 'function' \|\| !core\.nick\.looksLikeName\(call\)\) continue;/.test(qqSrc), '闸被拆了');
    t('qq.js 的「观察到别人喊」必须带明确称呼动词',
      /looksLikeCallContext\(body\.slice\(0, at\)\)/.test(qqSrc), '只靠 looksLikeName 还会把 @ 邻字写进代称');
    t('「这一叫我…」不会被截成名字',
      nickMod.callMeName('叫它乙?这一叫我都觉得脸上有点挂不住喵') === '',
      '又从句子腰上截出 ' + nickMod.callMeName('叫它乙?这一叫我都觉得脸上有点挂不住喵'));
    t('「叫我 XX」祈使句照旧认',
      nickMod.callMeName('以后大家就叫我 Ayami') === 'Ayami', '合法祈使句被误挡');
    t('@ 邻字没有「叫/喊」动词就不记',
      !nickMod.looksLikeCallContext('↩回复@白：我也有这个警告↩ ')
      && !nickMod.looksLikeCallContext('@100000000 就是什么都没发才恶心'),
      '还是把聊天片段当称呼上下文');
    t('@ 前面写「叫他/喊她/称呼对方」才记',
      nickMod.looksLikeCallContext('叫他 ') && nickMod.looksLikeCallContext('喊她')
      && nickMod.looksLikeCallContext('称呼对方'), '合法称呼动词被误挡');
    t('人物表已无整句脏代称（抓走你/什么鬼造型等）',
      !/什么鬼造型|抓走你|左下角像某个|没图说个JB/.test(JSON.stringify(peopleMod.all())), '脏值回流了');

    // ===== ④c 降级模型的「数值闸」不能把号 / 住址挡成「记不准」=====
    // 真事 2026-11-19：Ayami 私聊问自己的号，落到备用模型 → 命中「多少」→ 答「这个数我记不准」。
    {
      const guarded = core.withNumGuard([{ role: 'user', content: '我QQ号是多少' }]);
      t('数值闸不挡「我QQ号是多少」', !guarded.some(m => /降级/.test(String(m.content || ''))),
        '被数值闸拦成记不准');
      const g2 = core.withNumGuard([{ role: 'user', content: '我住哪你知道吗' }]);
      t('数值闸不挡「我住哪」', !g2.some(m => /降级/.test(String(m.content || ''))));
      const g3 = core.withNumGuard([{ role: 'user', content: '烈空坐种族值多少' }]);
      t('数值闸照旧挡真数值题（没搜到就别编）', g3.some(m => /降级/.test(String(m.content || ''))));
    }

    // ===== ⑥ 私聊的话题、约定不外泄（她 2026-11-19：那个占位说的是这个，不是号）=====
    // 隔离靠作用域（single 只给本人 / group 只在该群），不靠给号打码——
    // 打码只替换数字，从来防不住内容外泄。这条守住「别人的私聊内容不进这场对话」。
    // （「私密 / private」旧概念 2026-11-13 已废，代码里没有这条判定，别按它写守卫。）
    const topicsFile = path.join(ROOT, 'src', 'data', 'topics.jsonl');
    if (fs.existsSync(topicsFile)) {
      const rows = fs.readFileSync(topicsFile, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const hasGroup = s => /群\s*\d+/.test(String(s || ''));
      // 同一个人的号 = 他自己，不算「别人」（topicOwnerIs 也是这么判的）
      const samePerson = qq => {
        try {
          const a = peopleMod.pidOfKey(String(qq || '')), b = peopleMod.pidOfKey(String(sid));
          return !!(a && b && a === b);
        } catch { return false; }
      };
      const others = rows.filter(x => x.state !== 'dropped' && !hasGroup(x.scope)
        && x.qq && !samePerson(x.qq));
      const leaked = others.filter(x => {
        const tx = String(x.sum || x.text || '').trim();
        return tx.length >= 12 && gall.includes(tx);   // 太短的词会撞词（真事：「DeepSeek」两个字撞上人设里的模型名）
      });
      t('别人的私聊话题/约定不外泄到群里（' + others.length + ' 条待验）',
        leaked.length === 0,
        '泄了 ' + leaked.length + ' 条：' + leaked.slice(0, 3).map(x => String(x.text || '').slice(0, 12)).join(' / '));
    }

    // ===== ⑤ 街道门牌不进名单 =====
    const streetPid = Object.keys(regMap).find(pid => /街道|路\d|号/.test(String(regMap[pid] || '')));
    if (streetPid) {
      const raw = String(regMap[streetPid]);
      const brief = String(regionMod.briefForAI(raw) || '');
      const bad = brief ? new RegExp(brief.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*街道').test(gseg) : false;
      t('街道门牌不进名单（降到市/区级）', !bad,
        '原文 ' + raw + ' → 名单 ' + brief);
    }
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
