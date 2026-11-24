'use strict';
/* scripts/probe-video.js —— 手动验视频链路（不接 QQ，直接喂一个本地视频文件或视频链接）
 * 用法：
 *   node scripts/probe-video.js <本地视频路径> [brief|full|both]
 *   node scripts/probe-video.js --link <视频链接> [brief|full|both]
 * 只打印结果，不写任何 data/ 文件。 */
const path = require('path');
const video = require('../src/video');

(async () => {
  const args = process.argv.slice(2);
  const isLink = args[0] === '--link';
  const f = isLink ? args[1] : args[0];
  const mode = (isLink ? args[2] : args[1]) || 'both';
  if (!f) { console.log('用法：node scripts/probe-video.js [--link] <视频路径|链接> [brief|full|both]'); process.exit(1); }
  console.log('二进制：' + JSON.stringify(video._bins()) + '｜yt-dlp：' + (isLink ? video._bins && '' : ''));
  console.log('配置：' + JSON.stringify(video._cfg()));
  const seg = isLink ? { link: f } : { path: path.resolve(f) };
  if (isLink) console.log('链接类型：' + video.linkKind(f));
  else console.log('ffprobe：' + JSON.stringify(await video.probe(path.resolve(f))));
  for (const m of (mode === 'both' ? ['brief', 'full'] : [mode])) {
    const t0 = Date.now();
    const res = await video.analyze(seg, { mode: m });
    console.log('--- ' + m + '（' + (Date.now() - t0) + 'ms）---');
    console.log(JSON.stringify({ ok: res.ok, title: res.title, durationSec: res.durationSec, subBrief: res.subBrief, subFullLen: String(res.subFull || '').length, frames: res.frames, why: res.why }, null, 1));
    console.log('文案：' + res.text);
  }
})().catch(e => { console.log('失败：' + e.message); process.exit(1); });
