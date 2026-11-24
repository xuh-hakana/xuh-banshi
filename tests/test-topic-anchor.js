/*
 * tests/test-topic-anchor.js — 话题所指锚定（主人 2026-11-23 令：走 B，用文案提取所指）
 *
 * 真事：Nana 09:08 发抖音「Gemini4黑五5折$99/年教程」，后面日区/新号/半价/27号全量
 *   都在聊它；09:17 一句「不是26号就截止了吗」被裸搜成国考报名。
 * 验四件事：
 *   ① 从分享文案里提取所指，口令尾巴/［视频：…］/URL 全部去掉
 *   ② 引用回复里的旧文案不当话题开头（否则引用串会污染所指）
 *   ③ 搜索词拼接与注入的门槛：短追问才拼；本身带链接/新梗/长句不拼；没分享历史不变
 *   ④ 群聊、私聊都生效（同一套历史，无 ctx.gid 门）
 *
 * 跑法：node tests/test-topic-anchor.js（不联网、不动线上数据）
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
  const EXT = core.extractTopicReferent;

  const nanaShare = 'NaNa说: 6.64 复制打开抖音，看看【🔥火炏焱📈的图文作品】Gemini4黑五5折$99/年教程。谷歌新一代 ... https://v.douyin.com/BLz0nC88CJE/ w@f.oQ :4pm 10/31 HVY:/ ［视频：没看出内容］';
  const want = 'Gemini4黑五5折$99/年教程。谷歌新一代';

  // ===== ① 提取所指 =====
  t('抖音分享 → 提取出所指正文', EXT(nanaShare) === want, '得到：' + EXT(nanaShare));
  t('口令尾巴 w@f.oQ 不在所指里', EXT(nanaShare).indexOf('w@f.oQ') < 0);
  t('［视频：没看出内容］ 不在所指里', EXT(nanaShare).indexOf('视频') < 0);
  t('URL 不在所指里', EXT(nanaShare).indexOf('http') < 0);
  t('别的分享格式（只有链接+文字）也能提取',
    EXT('某人说: 看这个 黑五 Gemini 半价教程 https://v.douyin.com/abc/').indexOf('Gemini') >= 0);
  t('没有链接的消息 → 空串（不改变行为）', EXT('大肥鱼说: 日区先看它自己的黑五页面') === '');

  // ===== ② 引用回复不误认 =====
  const quoted = 'Neurotic说: ↩回复@Nana：6.64 复制打开抖音，看看【🔥火炏焱📈的图文作品】Gemini4黑五5折$99/年教程。谷歌新↩ @1000001000 看完了，不过我在日区';
  t('引用回复里的旧文案不算话题开头', EXT(quoted) === '', '得到：' + EXT(quoted));
  t('原分享仍算话题开头', EXT(nanaShare) === want);

  // ===== ③/④ 历史回溯：群聊、私聊都算 =====
  const kGroup = 'qq_858455686_test-anchor';
  const kPrivate = 'qq_私聊_test-anchor';
  for (const k of [kGroup, kPrivate]) {
    core.history.set(k, []);
    core.pushHist(k, 'user', nanaShare, { nick: 'NaNa', uid: '1000001000' });
    core.pushHist(k, 'user', '大肥鱼说: 日区先看它自己的黑五页面', { nick: '大肥鱼', uid: '1000001001' });
    core.pushHist(k, 'user', 'Neurotic说: 看评论说27号全量', { nick: 'Neurotic', uid: '1000001002' });
    t((k.indexOf('私') >= 0 ? '私聊' : '群聊') + ' 从历史回溯到所指', core.topicReferent(k) === want, '得到：' + core.topicReferent(k));
  }

  // 无分享文案的历史 → 空
  const kNone = 'qq_无分享_test-anchor';
  core.history.set(kNone, []);
  core.pushHist(kNone, 'user', '甲说: 今天好累', { nick: '甲', uid: '1' });
  core.pushHist(kNone, 'user', '乙说: 是啊', { nick: '乙', uid: '2' });
  t('没有分享文案的历史 → 空串', core.topicReferent(kNone) === '');

  // ===== ③ 源码级断言：搜索词与注入的门槛条件确实在链路上 =====
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
  t('搜索词拼所指的分支存在', src.includes('q = _topicRef + \' \' + q0'));
  t('短追问门槛存在（≤40字）', src.includes('_shortFollow'));
  t('所指已在 q0 里就不重复拼', src.includes('indexOf(_topicRef.slice(0, 8)) < 0'));
  t('梗/天气分支仍优先，不被所指覆盖', src.includes('_plainAsk'));
  t('给模型注入共同所指的段存在', src.includes('这段话的共同所指'));
  t('注入段写明别跳到别的领域（国考教训）', src.includes('跳成了国考报名'));
  t('无 ctx.gid 门 → 群聊私聊都做', !/topicReferent\(k\)[\s\S]{0,200}ctx\.gid/.test(src));

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 过 / ' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
})();
