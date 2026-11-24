'use strict';
/* 首次运行引导：缺配置就从模板复制，缺目录就建。
 * 用法：node scripts/init-config.js        （npm start 前会自动跑一次，见 package.json 的 prestart） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'src', 'config');
const DATA = path.join(ROOT, 'src', 'data');

function copyExamples() {
  let made = [];
  let names = [];
  try { names = fs.readdirSync(CFG); } catch (e) { return made; }
  for (const n of names) {
    if (!/\.example\.json$/.test(n)) continue;
    const real = path.join(CFG, n.replace(/\.example\.json$/, '.json'));
    if (fs.existsSync(real)) continue;
    fs.copyFileSync(path.join(CFG, n), real);
    made.push('src/config/' + path.basename(real));
  }
  return made;
}

function ensureDirs() {
  const dirs = [
    'stickers', 'stickers/常用', 'stickers/可用', 'blocked',
    'guides', 'usage', 'chat-shards',
  ];
  for (const d of dirs) { try { fs.mkdirSync(path.join(DATA, d), { recursive: true }); } catch (e) {} }
}

function main() {
  ensureDirs();
  const made = copyExamples();
  if (made.length) console.log('[init] 已从模板生成：' + made.join('、'));
  else console.log('[init] 配置齐全');
  console.log('[init] 下一步：填 src/config/llm.json 的 Key（或接 AstrBot 池）、src/config/connect.json 的 NapCat 地址与 QQ 号，然后 npm start');
}
if (require.main === module) main();
module.exports = { main, copyExamples, ensureDirs };
