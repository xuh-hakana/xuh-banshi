/*
 * tools/试日记.js — 用某一天的聊天记录重跑一次日记，只看效果、不落盘、不私发主人
 *
 * 用法：
 *   node tools/试日记.js 2026-10-23          # 试某一天
 *   node tools/试日记.js 2026-10-23 --digest # 连抽出来的素材一起打印（看它从记录里挑了什么）
 *   node tools/试日记.js 2026-10-23 --save   # 真的落盘（仍然不私发）
 *
 * 为什么单独放一个脚本：日记是每天 00:05 才跑一次的定时任务，想立刻看效果
 * 又不能真发到她 QQ 上，所以给它一个干跑口。逻辑全在 core.doDiary，这里不复制一份。
 */
const path = require('path');
const configStore = require(path.join(__dirname, '..', 'src', 'config'));
const core = require(path.join(__dirname, '..', 'src', 'core'));

async function main() {
  const args = process.argv.slice(2);
  const day = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || core.yesterdayStamp();
  const dryRun = !args.includes('--save');
  const showDigest = args.includes('--digest');

  core.init(configStore.load());
  console.log('=== 试写 ' + day + ' 的日记（' + (dryRun ? '干跑' : '真落盘') + '）===');
  const t0 = Date.now();
  const r = await core.doDiary(day, { dryRun });
  const sec = Math.round((Date.now() - t0) / 1000);

  if (showDigest && r.digest) {
    console.log('\n----- 抽出来的素材 -----\n' + r.digest);
  }
  console.log('\n----- 日记正文 -----');
  if (r.text) console.log(r.text);
  console.log('\n----- 体检 -----');
  console.log('成功：' + r.ok + '｜耗时：' + sec + ' 秒｜原始条数：' + (r.lines || 0) + '｜切片：' + (r.chunks || 0));
  if (r.dryRun) {
    const n = String(r.text || '').replace(/\s+/g, '').length;
    console.log('字数：' + n + '｜复读问题：' + ((r.issues && r.issues.length) ? r.issues.join('；') : '无'));
  }
  if (!r.ok) console.log('原因：' + (r.reason || '') + ' ' + (r.error || ''));
  process.exit(0);
}
main().catch(e => { console.error('挂了：' + e.message); process.exit(1); });
