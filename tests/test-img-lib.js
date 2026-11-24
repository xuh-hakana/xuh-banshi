#!/usr/bin/env node
/**
 * 图库认图自测（2026-11-05 主人定「发图先认是不是自己库里的那张」）
 * 纯只读：不写 data/、不改图库，只在 /tmp 生成两张临时图，跑完删掉。
 * 跑法：node tests/test-img-lib.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const qq = require(path.join(ROOT, 'src', 'connectors', 'qq.js'));
const DIR = path.join(ROOT, 'src', 'data', 'stickers');
const PY = 'python3';
const TMP = path.join(require('os').tmpdir(), 'testlib-' + process.pid);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
}
const hashOf = buf => qq._stickerPHash(buf, 'd16');
const reload = () => { try { delete require.cache[require.resolve(path.join(ROOT, 'src', 'connectors', 'qq.js'))]; } catch {} };

(async () => {
  console.log('图库认图自测\n');

  // 1) 索引覆盖：目录里该被认的图，索引里都有
  console.log('[索引]');
  const idxPath = path.join(DIR, '.phash.json');
  // 先把索引补到最新（机器人平时自己会补，这里手动补一次，免得「她刚发了几张图」让本测试误报红）
  try {
    const j = JSON.parse(execFileSync(PY, [path.join(ROOT, 'src', 'scripts', 'sticker_hash_index.py'), DIR, idxPath],
      { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    if (j.ok) fs.writeFileSync(idxPath, JSON.stringify(j.index));
  } catch {}
  ok('索引文件存在', fs.existsSync(idxPath));
  const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
  ok('索引版本 = 2', idx.__v === 2, '拿到 ' + idx.__v);
  const idxKeys = Object.keys(idx).filter(k => k !== '__v');
  const files = qq._stickerFiles();
  ok('索引条数 = 图库张数（' + files.length + '）', idxKeys.length === files.length,
    '索引 ' + idxKeys.length + ' 条');
  const missing = files.filter(f => !idx[f]);
  ok('没有漏索引的图', missing.length === 0, missing.slice(0, 3).join('、'));

  // 2) 库里的图能被认出来，标签干净
  console.log('[认得出来]');
  const picks = ['常用/悲伤.jpg', '可用/q哭1.jpg', '少用/q害怕1.jpg', '常用/开心.jpg']
    .filter(f => fs.existsSync(path.join(DIR, f)));
  ok('图库里有可测的样张', picks.length > 0);
  for (const rel of picks) {
    const h = await hashOf(fs.readFileSync(path.join(DIR, rel)));
    const hit = qq._stickerLibHit(h);
    ok('认出 ' + rel + (hit ? ' → ' + hit : ''), !!hit);
  }

  // 3) 标签解析
  console.log('[标签]');
  ok('q悲伤1 → 悲伤', qq._stickerLibLabel('可用/q悲伤1.gif') === '悲伤');
  ok('蓝发小女孩2 → 蓝发小女孩', qq._stickerLibLabel('关键词触发/蓝发小女孩2.jpg') === '蓝发小女孩');
  ok('空值不炸', qq._stickerLibLabel('') === '');

  // 4) 同图重压缩 / 缩放还认得出（QQ 每次转存都会重编码）
  console.log('[转存后仍认得出]');
  fs.mkdirSync(TMP, { recursive: true });
  const src = path.join(DIR, picks[0]);
  const base = await hashOf(fs.readFileSync(src));
  for (const q of [60, 40]) {
    const out = path.join(TMP, 'q' + q + '.jpg');
    execFileSync(PY, ['-c', 'from PIL import Image;Image.open(r"' + src + '").convert("RGB").save(r"' + out + '",quality=' + q + ')']);
    const h = await hashOf(fs.readFileSync(out));
    const hit = qq._stickerLibHit(h);
    ok('重压 q=' + q + ' 距离 ' + qq._hammingBits(base, h) + ' → ' + (hit || '没认出'), !!hit);
  }

  // 5) 库里没有的图不能瞎认（纯色图 / 别的图）
  console.log('[不瞎认]');
  const plain = path.join(TMP, 'plain.png');
  execFileSync(PY, ['-c', 'from PIL import Image;Image.new("RGB",(64,64),(20,200,90)).save(r"' + plain + '")']);
  const hPlain = await hashOf(fs.readFileSync(plain));
  ok('纯色图认不出', !qq._stickerLibHit(hPlain));
  const stripes = path.join(TMP, 'stripes.png');
  execFileSync(PY, ['-c', 'from PIL import Image\nim=Image.new("RGB",(64,64))\nfor y in range(64):\n  for x in range(64):\n    im.putpixel((x,y),(255,255,255) if (x//8+y//8)%2 else (0,0,0))\nim.save(r"' + stripes + '")']);
  ok('棋盘图认不出', !qq._stickerLibHit(await hashOf(fs.readFileSync(stripes))));

  // 6) 汉明距离自检
  console.log('[距离]');
  ok('同一串距离 0', qq._hammingBits('ffffffffffffffff', 'ffffffffffffffff') === 0);
  ok('全差距离 256', qq._hammingBits('0'.repeat(64), 'f'.repeat(64)) === 256);

  // 7) 整条链路：describeImgs 先看图库，命中就不调视觉模型
  console.log('[整条链路]');
  const core = require(path.join(ROOT, 'src', 'core.js'));
  const oldGet = core.getBinary, oldSee = core.seeImage;
  let seeCalls = 0;
  core.getBinary = async () => ({ buf: fs.readFileSync(src), type: 'image/jpeg' });
  core.seeImage = async () => { seeCalls++; return '字：无字\n情绪：难过\n是什么：哭脸表情'; };
  try {
    const r1 = await qq._describeImgs([{ url: 'http://x/1.jpg' }]);
    ok('命中图库：描述写成「图库里的「X」」', /^图库里的「.+」$/.test(r1.descs[0]), JSON.stringify(r1.descs));
    ok('命中图库：lib 记下相对路径', r1.lib[0] === '常用/悲伤.jpg', JSON.stringify(r1.lib));
    ok('命中图库：没调视觉模型（省一次钱）', seeCalls === 0, 'seeImage 被调了 ' + seeCalls + ' 次');

    core.getBinary = async () => ({ buf: fs.readFileSync(plain), type: 'image/png' });
    const r2 = await qq._describeImgs([{ url: 'http://x/2.png' }]);
    ok('库里没有：走视觉模型', seeCalls === 1);
    ok('库里没有：描述是「字/情绪/是什么」', /字：/.test(r2.descs[0]) && /情绪：/.test(r2.descs[0]), JSON.stringify(r2.descs));
    ok('库里没有：lib 为空（照常收进库）', r2.lib[0] === '');

    let n = 0;
    core.getBinary = async () => (n++ === 0
      ? { buf: fs.readFileSync(src), type: 'image/jpeg' }
      : { buf: fs.readFileSync(plain), type: 'image/png' });
    const r3 = await qq._describeImgs([{ url: 'http://x/a.jpg' }, { url: 'http://x/b.png' }]);
    ok('两张混发：lib 与 descs 对齐', r3.descs.length === 2 && r3.lib.length === 2
      && r3.lib[0] === '常用/悲伤.jpg' && r3.lib[1] === '', JSON.stringify(r3.lib));
  } finally {
    core.getBinary = oldGet; core.seeImage = oldSee;
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
