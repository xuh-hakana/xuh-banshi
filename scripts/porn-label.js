/* 主人改判：把某张图钉成色图/非色图，写进 src/data/porn-overrides.json，判定时直接命中。
 * 用法：node scripts/porn-label.js <图片路径> porn|normal [--append-eval <名字>] */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OV = path.join(ROOT, 'src', 'data', 'porn-overrides.json');
const MAN = path.join(__dirname, 'porn-eval-labels.json');

function usage() {
  console.error('用法: node scripts/porn-label.js <图片路径> porn|normal [--append-eval <名字>]');
  process.exit(2);
}
const args = process.argv.slice(2);
const file = args[0];
const label = String(args[1] || '').toLowerCase();
if (!file || !fs.existsSync(file)) usage();
if (label !== 'porn' && label !== 'normal') usage();
const porn = label === 'porn';
const buf = fs.readFileSync(file);
const md5 = crypto.createHash('md5').update(buf).digest('hex');

let map = {};
try { map = JSON.parse(fs.readFileSync(OV, 'utf8')) || {}; } catch {}
map[md5] = porn;
fs.mkdirSync(path.dirname(OV), { recursive: true });
fs.writeFileSync(OV, JSON.stringify(map, null, 1) + '\n');

const ai = args.indexOf('--append-eval');
if (ai > 0) {
  const name = String(args[ai + 1] || path.basename(file));
  try {
    const man = JSON.parse(fs.readFileSync(MAN, 'utf8'));
    const id = (porn ? 'P' : 'N') + String(man.items.filter(x => x.label === (porn ? 'porn' : 'normal')).length + 1).padStart(2, '0');
    man.items.push({ id, name, label: porn ? 'porn' : 'normal', src: path.resolve(file) });
    fs.writeFileSync(MAN, JSON.stringify(man, null, 1) + '\n');
    console.log('已追加评测集 ' + id + ' ' + name);
  } catch (e) { console.log('追加评测集失败：' + e.message); }
}
console.log(md5 + ' -> ' + (porn ? 'porn' : 'normal') + '（' + Object.keys(map).length + ' 条改判）');
