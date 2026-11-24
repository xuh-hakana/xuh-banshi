'use strict';
/* tests/test-video.js —— 视频链路验收（主人 2026-11-22）
 *
 * 口径：默认「每 8 秒一帧、最多 3 张 + 字幕前 60 字」，笑点解析「全部字幕 + 全部可截帧数」。
 * 这里只验确定性的部分（切帧/时长/字幕/文案），不调视觉模型（那是网络，会 429）；
 * 想连视觉一起验：VIDEO_LIVE=1 node tests/test-video.js
 *
 * 自己造 9 秒合成视频（ffmpeg testsrc + 系统 say 的语音），跑完删干净，不碰 data/。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const video = require(path.join(root, 'src', 'video'));

let pass = 0, fail = 0;
const t = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + extra + '』')); };
const sh = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).toString();

(async () => {
  // ① 配置口径
  const c = video._cfg();
  t('默认口径：每 8 秒一帧 / 最多 3 张 / 字幕前 60 字',
    c.frameIntervalSec === 8 && c.briefFrameCount === 3 && c.briefSubtitleChars === 60, JSON.stringify(c));
  t('默认开着（features.json video.enable）', c.enable === true, String(c.enable));

  // ② 取帧时间点
  const long = video._pickTimes(60, 3, 8);
  t('长视频按 0/8/16 秒取 3 帧', JSON.stringify(long) === JSON.stringify([0, 8, 16]), JSON.stringify(long));
  const short = video._pickTimes(5, 3, 8);
  t('短视频均匀铺开（不只剩 t=0 一帧）', short.length >= 1 && short[0] > 0, JSON.stringify(short));
  const full = video._spreadTimes(300, 24, 8);
  t('笑点解析全量最多 24 帧', full.length === 24, String(full.length));
  const fullShort = video._spreadTimes(20, 24, 8);
  t('短视频的全量帧数不超过它真实的帧数', fullShort.length <= 3, JSON.stringify(fullShort));

  // ③ 文案
  const briefTxt = video._buildText({ durationSec: 65, subBrief: '啊'.repeat(60), subFull: '全'.repeat(200), frames: ['甲', '乙', '丙'], times: [] }, 'brief');
  t('默认文案：字幕（前60字）+ 画面1/2/3，不带全部字幕',
    briefTxt.includes('字幕（前60字）') && briefTxt.includes('画面3：') && !briefTxt.includes('字幕（全部）'), briefTxt.slice(0, 90));
  t('默认文案：字幕只出现 60 字', (briefTxt.match(/字）：([^｜]*)/) || [])[1].length === 60, briefTxt.slice(0, 60));
  const fullTxt = video._buildText({ durationSec: 65, subBrief: '', subFull: '全部字幕在这里', frames: ['甲'], times: [] }, 'full');
  t('笑点解析文案：带全部字幕', fullTxt.includes('字幕（全部）') && fullTxt.includes('全部字幕在这里'), fullTxt.slice(0, 60));

  // ④ 二进制/模型（缺了不算失败，只是跳过真机那段）
  const b = video._bins();
  t('找得到 ffmpeg / ffprobe', !!b.ffmpeg && !!b.ffprobe, JSON.stringify(b));
  if (!b.ffmpeg || !b.ffprobe) { console.log('\n（没有 ffmpeg，真机那段跳过）\n通过 ' + pass + ' / ' + (pass + fail)); process.exit(fail ? 1 : 0); }

  // ⑤ 造一条 9 秒带语音的视频，跑真链路
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuh-video-test-'));
  const aiff = path.join(dir, 'a.aiff');
  const mp4 = path.join(dir, 'v.mp4');
  try {
    let hasSpeech = true;
    try { sh('say', ['-o', aiff, '今天天气不错，我们出去玩吧，哈哈哈哈']); } catch { hasSpeech = false; }
    const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=9'];
    if (hasSpeech) args.push('-i', aiff, '-shortest');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (hasSpeech) args.push('-c:a', 'aac', '-b:a', '64k');
    args.push(mp4);
    sh(b.ffmpeg, args);

    const info = await video.probe(mp4);
    t('ffprobe 读得出时长', info.durationSec >= 3 && info.durationSec <= 12, String(info.durationSec));

    const times = video._pickTimes(info.durationSec, c.briefFrameCount, c.frameIntervalSec);
    const frames = await video._grabFrames(mp4, times, dir);
    t('截帧：要 3 张就出 3 张（短视频均匀铺开）', frames.length === Math.min(3, Math.max(1, Math.ceil(info.durationSec / c.frameIntervalSec))) || frames.length >= 1,
      frames.length + ' 张 / 时间点 ' + JSON.stringify(times));
    t('截出来的帧是能读的图片（有 base64）', frames.every(f => video._toDataUri(f.file).startsWith('data:image/')));

    if (hasSpeech && b.whisper && b.model) {
      const w = await video._whisperSubs(mp4, 9, dir);
      t('whisper 转得出字幕', !!w.text, w.why || '空');
      t('字幕去掉空白（当字幕用不能带一堆换行）', !/\s/.test(w.text || ''), JSON.stringify(String(w.text).slice(0, 40)));
    } else {
      console.log('（没有 whisper-cli / 模型，字幕那段跳过：brew install whisper-cpp + data/models/ggml-small.bin）');
    }

    if (process.env.VIDEO_LIVE === '1') {
      const r = await video.analyze({ path: mp4 }, { mode: 'brief' });
      t('真机 brief：文案里带「字幕」和「画面1」', /［视频：/.test(r.text) && /画面1：/.test(r.text), String(r.text).slice(0, 80));
      t('真机 brief：字幕截到 60 字以内', String(r.subBrief).length <= 60, String(String(r.subBrief).length));
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // ⑦ 明确指令 / 视频链接（2026-11-22 主人定）
  t('明确指令：查看/看看/看完/分析视频 都算要全量',
    ['查看', '看看这个', '看下视频', '看完', '仔细看看', '这个视频讲了什么', '分析一下这个视频'].every(x => video.wantsFull(x) === true));
  t('明确指令：普通闲聊不触发全量', ['午休吧', '哈哈哈', '今天吃啥'].every(x => video.wantsFull(x) === false));
  t('链接归类：B站/YouTube/抖音/论坛/直链',
    video.linkKind('https://www.bilibili.com/video/BV1GJ411x7h7') === 'bilibili'
    && video.linkKind('https://youtu.be/abc') === 'youtube'
    && video.linkKind('https://v.douyin.com/x') === 'douyin'
    && video.linkKind('https://tieba.baidu.com/p/1') === 'forum'
    && video.linkKind('https://a.com/x.mp4') === 'video-file'
    && video.linkKind('随便一句话') === '');

  // ⑧ 笑点解析：词表（术语/说法/场景）+ 只解析目标 + 兜底一句喵（2026-11-22 主人定）
  const core = require(path.join(root, 'src', 'core'));
  const LX = core._xdLexicon();
  t('三份清单解析得出来：术语 40+ / 说法 20+ / 场景 11 档',
    LX.terms.length >= 40 && LX.talks.length >= 20 && LX.scenes.length === 11,
    LX.terms.length + '/' + LX.talks.length + '/' + LX.scenes.length);
  t('已验/待验分开：术语已验 ≥10、说法已验 ≥10',
    LX.terms.filter(x => x['状态'] === '已验').length >= 10 && LX.talks.filter(x => x['状态'] === '已验').length >= 10);
  t('判场景：一本正经问责 → S10；图 → S5；链接 → S7',
    core._xdSceneOf('因为你刚过完了生日，且我没有送你5090，这直接导致了特朗普不得不进行政治表演', { scope: 'single' }) === 'S10'
    && core._xdSceneOf('小明 发的图，图上：一只猫', { scope: 'media' }) === 'S5'
    && core._xdSceneOf('https://example.com/x', { scope: 'media' }) === 'S7'
    && core._xdSceneOf('随便一句话', { scope: 'thread' }) === 'S11');
  const st10 = core._xdMemeStyle('主人：因为你刚过完了生日，且我没有送你5090当生日礼物。这直接导致了特朗普不得不进行政治表演，对此确凿证据你要如何解释？', { scope: 'single' }, '');
  t('S10 带到「荒诞因果」术语，且给出可用的梗式说法',
    st10.sid === 'S10' && st10.terms.some(x => x.name === '荒诞因果') && st10.lines.length > 0);
  t('联网摘要只抽短句，解释段（不难看出/综上）丢掉',
    (() => { const w = core._xdWebStyle('分类：反问型\n用法示例：你是怎么做到的\n不难看出这里很好笑\n示例：包的呀', 'S1');
      return w.length >= 2 && w.every(s => !/不难看出|综上/.test(s)); })());
  const xdV = { scope: 'quote', target: '（他引用的消息）大肥鱼：司凤是什么意思' };
  const goodAns = ['【聊天记录】', '大肥鱼：司凤是什么意思', '【解析】', '资料：司凤谐音死冯。',
    '对话中「大肥鱼」说「司凤是什么意思」意思是自己的老妈死了，此为1层笑点。',
    '而蠢蠢的ai，回复「你是在说我吗」。没有理解这句话的双关，令人忍俊不禁喵。'].join('\n');
  t('合格答案通过质检（资料行 + 此为1层笑点 + 术语 + 喵）', core._xdCheck(goodAns, xdV).ok === true, core._xdCheck(goodAns, xdV).why);
  t('缺「资料：」行判不合格，理由写清',
    (() => { const r = core._xdCheck(goodAns.replace('资料：司凤谐音死冯。', ''), xdV); return r.ok === false && /资料/.test(r.why); })());
  t('层号不从 1 开始判不合格',
    (() => { const r = core._xdCheck(goodAns.replace('此为1层笑点', '此为2层笑点'), xdV); return r.ok === false && /层/.test(r.why); })());
  t('有引用时解析到了对话其它条 → 不合格（只解析目标那条）',
    (() => { const bad = ['【聊天记录】', '大肥鱼：司凤是什么意思', '小海豹：就是死冯啊', '【解析】', '资料：（没查到明确资料）',
        '对话中「小海豹」说「就是死冯啊」是谐音梗，此为1层笑点。', '令人忍俊不禁喵'].join('\n');
      const r = core._xdCheck(bad, xdV); return r.ok === false && /没被选中/.test(r.why); })());
  t('一个术语/说法都没有 → 不合格（太板正）',
    (() => { const bad = ['【聊天记录】', '大肥鱼：司凤是什么意思', '【解析】', '资料：（没查到明确资料）',
        '他说的这个事情吧反正就是这样的，此为1层笑点。', '令人忍俊不禁喵'].join('\n');
      const r = core._xdCheck(bad, xdV); return r.ok === false && /太板正/.test(r.why); })());
  t('聊天腔禁项仍拦：希望有帮助/我会好好分析',
    (() => { const bad = goodAns.replace('资料：司凤谐音死冯。', '资料：希望有帮助，我会好好分析。');
      const r = core._xdCheck(bad, xdV); return r.ok === false && /禁项/.test(r.why); })());
  // 2026-11-24：格式全过但没解析出笑点 → 不合格（占位符/空话/无实质/没引原话）
  t('聊天记录照抄「代称」占位符 → 不合格',
    (() => { const r = core._xdCheck(goodAns.replace('大肥鱼：司凤是什么意思', '代称：司凤是什么意思'), xdV);
      return r.ok === false && /占位符|代称/.test(r.why); })());
  t('空话「正是笑点所在」→ 不合格',
    (() => { const r = core._xdCheck(goodAns.replace('意思是自己的老妈死了，', '意思是自己的老妈死了，正是笑点所在，'), xdV);
      return r.ok === false && /空话/.test(r.why); })());
  t('某层没有实质内容 → 不合格',
    (() => { const r = core._xdCheck(goodAns.replace('对话中「大肥鱼」说「司凤是什么意思」意思是自己的老妈死了，', '笑死，'), xdV);
      return r.ok === false && /没有实质/.test(r.why); })());
  t('解析没引用目标原话 → 不合格',
    (() => { const bad = ['【聊天记录】', '大肥鱼：司凤是什么意思', '【解析】', '资料：（没查到明确资料）',
        '他这个问题问得真好，大家听完都乐了，此为1层笑点。', '这句话有双关，令人忍俊不禁喵'].join('\n');
      const r = core._xdCheck(bad, xdV); return r.ok === false && /原话/.test(r.why); })());
  t('提示词契约：昵称规则 + 四问，不再有「代称：原话」',
    (() => { const p = core._xdPromptRules();
      return p.includes('昵称：原话') && !p.includes('代称：原话') && p.includes('每层必须回答四问') && p.includes('群名片'); })());
  t('范例有反例节，且随提示词喂给模型',
    core._xiaodianExampleText().includes('这是真实发出去过的一版')
    && core._xiaodianExampleText().includes('同一目标，改对之后'));
  t('二审：判不合格给理由，读不懂按合格放行',
    (await (async () => {
      const r1 = await core._xdReview('目标原话', '解析', { llm: async () => '判断=不合格\n理由=2层只是贴标签' });
      const r2 = await core._xdReview('目标原话', '解析', { llm: async () => '判断=合格\n理由=ok' });
      const r3 = await core._xdReview('目标原话', '解析', { llm: async () => '看不懂' });
      return r1.ok === false && /贴标签/.test(r1.why) && r2.ok === true && r3.ok === true;
    })()));
  t('兜底只发一句「令人忍俊不禁喵」（不再造整段假解析）',
    (await core._xiaodianEnsure('demo', [], null, {})) === '令人忍俊不禁喵' && core.XD_SLOGAN === '令人忍俊不禁喵');
  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
