'use strict';
/* scripts/pack-win.js — 打 Windows 便携版：解压双击 xuh-banshi.exe 就出界面，且自带机器人本体。
 *
 * 用法：node scripts/pack-win.js
 * 结构：dist/xuh-banshi-win/xuh-banshi-win32-x64/
 *         xuh-banshi.exe           ← Electron 壳（client/ 打进去，在 resources/app/）
 *         resources/app/...        ← 客户端（原版雨夜玻璃界面）
 *         resources/src|public/... ← 机器人本体：client/main.js 的 ROOT 就是 resources/，直接能 require
 *         resources/src/config/*.json（由真实配置清洗后生成，等于模板）
 * 只做交叉打包：本机是 macOS，打出来没在真 Windows 上跑过。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { clean, ownerMap } = require('./pack-public.js');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const NAME = 'xuh-banshi';
const VER = pkg.version;
const OUT = path.join(ROOT, 'dist', 'xuh-banshi-win');
const APP = path.join(OUT, NAME + '-win32-x64');
const RES = path.join(APP, 'resources');

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit', cwd: ROOT }, opts || {}));
  return r.status;
}

const SKIP_ANY = /(^|\/)(node_modules|\.git|__pycache__|\.DS_Store)(\/|$)/;
const SKIP_FILE = /\.(log|tmp|bak|bak2|swp)$|\.bak[^/]*$/i;

function walkInto(rel, filter, out) {
  const abs = path.join(ROOT, rel);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of ents) {
    const r = rel + '/' + d.name;
    if (SKIP_ANY.test(r) || SKIP_FILE.test(d.name)) continue;
    let st = null;
    try { st = fs.statSync(path.join(abs, d.name)); } catch (e) { continue; }
    if (st.isDirectory()) walkInto(r, filter, out);
    else if (filter(r, d.name)) out.push(r);
  }
  return out;
}

function copyTo(srcRel, dstRel) {
  const dst = path.join(RES, dstRel || srcRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, srcRel), dst);
}

const TEXT = /\.(js|json|md|txt|py|sh|command|bat|html|css|yml|yaml)$/i;
let ID_MAP = new Map();
function scrubPaths(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { scrubPaths(p); continue; }
    if (!TEXT.test(d.name)) continue;
    let s = '';
    try { s = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const before = s;
    s = s.split(ROOT).join('.');
    s = s.replace(/\/Volumes\/\d+(?:\/[^\s'")]*)?/g, '外置卷');
    s = s.replace(/\/Users\/[^\/\s'"]+\//g, '~/');
    // 作者本机 QQ 号：值、注释、json key 全部换成替身（和 pack:public 同一套映射）
    for (const [id, fake] of ID_MAP) if (s.indexOf(id) >= 0) s = s.split(id).join(fake);
    s = s.replace(/"([1-9]\d{8,11})"(\s*:)/g, (m0, d, tail) => (ID_MAP.get(d) ? '"' + ID_MAP.get(d) + '"' + tail : m0));
    if (s !== before) fs.writeFileSync(p, s, 'utf8');
  }
}

const NOTE = [
  'xuh-banshi Windows 便携版 ' + VER,
  '',
  '一、先看界面',
  '  双击 xuh-banshi.exe。窗口一开就能看表情包池和搬屎统计（读的是本目录 resources/src/data）。',
  '',
  '二、让机器人真的上线',
  '  这个 exe 是界面壳，真正的机器人是 Node 程序，本体就在本目录的 resources 里。',
  '  1. 装 Node.js >= 22（https://nodejs.org）。',
  '  2. 在 resources 目录里开命令行，跑一次：npm install',
  '  3. 填 resources/src/config/connect.json（NapCat 地址、QQ 号）和 llm.json（模型 Key）。',
  '     缺的配置第一次跑 npm start 会自动从模板生成。',
  '  4. 跑：npm start —— 机器人上线，界面照旧用 exe 看。',
  '',
  '三、想用 NapCat',
  '  NapCat 要和机器人跑在同一台机器上，OneBot 11 反向 WS 指到 resources/src/config/connect.json 里写的端口。',
  '',
  '四、出问题看哪',
  '  resources/src/data/*.log 和 exe 同目录的日志；配置逐条含义见 resources/src/config/features.json 的注释，',
  '  手动配置说明见 resources/安装.md。',
  '',
].join('\r\n');

function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? count(p) : 1;
  }
  return n;
}

function main() {
  const elVer = require(path.join(ROOT, 'app', 'node_modules', 'electron', 'package.json')).version;
  console.log('[pack-win] ' + NAME + ' ' + VER + ' / Electron ' + elVer + ' → ' + OUT);
  fs.mkdirSync(OUT, { recursive: true });

  const env = Object.assign({}, process.env, {
    ELECTRON_CACHE: '/tmp/electron-cache',
    electron_config_cache: '/tmp/electron-cache',
    npm_config_cache: '/tmp/npmcache',
  });
  const code = run('npx', [
    '--yes', '--cache', '/tmp/npmcache', '@electron/packager',
    'client', NAME,
    '--platform=win32', '--arch=x64',
    '--electron-version=' + elVer,
    '--out=' + OUT, '--overwrite', '--asar=false',
    '--app-version=' + VER, '--build-version=' + VER,
    '--ignore=日志', '--ignore=\.log$', '--ignore=\.open-tab$', '--ignore=node_modules',
  ].concat(fs.existsSync('/tmp/electron-zip') ? ['--electron-zip-dir=/tmp/electron-zip'] : []), { env: env });

  const exe = path.join(APP, NAME + '.exe');
  if (code !== 0 || !fs.existsSync(exe)) {
    console.error('[pack-win] 失败：没生成 ' + exe + '（exit=' + code + '）');
    console.error('[pack-win] 多半是下载 win32 版 Electron 被网络挡住；联网后重跑：npm run pack:win');
    process.exit(1);
  }

  // 机器人本体注入 resources/（client/main.js 的 ROOT = resources/）
  const files = [];
  walkInto('src', r => !/^src\/data\//.test(r)
    && !/^src\/docs\//.test(r)
    && !/^src\/persona\/(1-人设正文|6-记忆数据)\//.test(r)
    && !/^src\/config\/.*\.json$/.test(r)
    && !/local_priority|local-persona/.test(r), files);
  walkInto('public', () => true, files);
  walkInto('scripts', r => /\.(js|py)$/.test(r), files);
  for (const f of ['package.json', '.env.example', '安装.md']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(f);
  }
  for (const f of files) copyTo(f);

  // 配置：真实配置清洗后写成 config/*.json + *.example.json（等于模板，不含 Key/QQ 号）
  const CFG = path.join(ROOT, 'src', 'config');
  const cfgOut = path.join(RES, 'src', 'config');
  fs.mkdirSync(cfgOut, { recursive: true });
  let cfgs = 0;
  for (const n of fs.readdirSync(CFG)) {
    if (!n.endsWith('.json') || n.endsWith('.example.json')) continue;
    if (/local_priority|local-persona/.test(n)) continue;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(CFG, n), 'utf8')); } catch (e) { continue; }
    const body = JSON.stringify(clean(j), null, 2) + '\n';
    fs.writeFileSync(path.join(cfgOut, n), body, 'utf8');
    fs.writeFileSync(path.join(cfgOut, n.replace(/\.json$/, '.example.json')), body, 'utf8');
    cfgs++;
  }

  // 运行时数据目录：只放说明和空目录
  fs.mkdirSync(path.join(RES, 'src', 'data'), { recursive: true });
  const dataReadme = fs.existsSync(path.join(ROOT, 'src', 'data', 'README.md'))
    ? fs.readFileSync(path.join(ROOT, 'src', 'data', 'README.md'), 'utf8')
    : '# 运行时数据目录\n';
  fs.writeFileSync(path.join(RES, 'src', 'data', 'README.md'), dataReadme, 'utf8');
  for (const d of ['src/data/stickers/常用', 'src/data/stickers/可用', 'src/data/blocked',
    'src/data/guides', 'src/data/usage', 'src/persona/1-人设正文', 'src/persona/6-记忆数据']) {
    fs.mkdirSync(path.join(RES, d), { recursive: true });
    fs.writeFileSync(path.join(RES, d, '.gitkeep'), '', 'utf8');
  }

  ID_MAP = ownerMap();
  scrubPaths(RES);
  fs.writeFileSync(path.join(APP, '启动Windows版.txt'), NOTE, 'utf8');

  // 自检：缺一个就失败，不让半成品进 release
  const must = [
    exe,
    path.join(RES, 'app', 'renderer', 'index.html'),
    path.join(RES, 'src', 'bot.js'),
    path.join(RES, 'src', 'config', 'features.json'),
    path.join(RES, 'public', 'sticker-page.js'),
  ];
  const miss = must.filter(p => !fs.existsSync(p));
  if (miss.length) {
    console.error('[pack-win] 自检失败，缺：' + miss.map(p => path.relative(APP, p)).join('、'));
    process.exit(1);
  }
  if (fs.existsSync(path.join(RES, '日志'))) { console.error('[pack-win] 自检失败：resources/日志 不该进包'); process.exit(1); }
  if (fs.existsSync(path.join(RES, '.open-tab'))) { console.error('[pack-win] 自检失败：.open-tab 不该进包'); process.exit(1); }
  const media = fs.readdirSync(path.join(RES, 'src', 'data')).filter(n => !/\.md$|\.gitkeep$/.test(n) && fs.statSync(path.join(RES, 'src', 'data', n)).isFile());
  if (media.length) { console.error('[pack-win] 自检失败：src/data 混入文件 ' + media.join('、')); process.exit(1); }

  const zip = path.join(ROOT, 'dist', NAME + '-win-' + VER + '.zip');
  try { fs.unlinkSync(zip); } catch (e) {}
  run('zip', ['-rq', zip, path.basename(APP)], { cwd: OUT });

  const files_n = count(APP);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log('[pack-win] 目录：' + path.relative(ROOT, APP) + '（' + files_n + ' 个文件，配置 ' + cfgs + ' 份）');
  console.log('[pack-win] 压缩包：' + path.relative(ROOT, zip) + '（' + mb + ' MB）');
}

if (require.main === module) main();
module.exports = { main };
