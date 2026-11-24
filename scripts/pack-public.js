'use strict';
/* 发布打包：把「能装能跑」的那部分挑出来放到 dist/xuhbot-public-<version>/
 * 原则：只发代码 + 模板 + 文档；媒体（src/data 下 2.5G）、本机备份、Electron 安装包、真实密钥一律不发。
 * 用法：npm run pack:public        产物目录会先清空再重建。
 * 打包完自动跑 scripts/scan-secrets.js，有命中就退出码 1（不会产出干净的包）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const OUT = path.join(ROOT, 'dist', 'xuhbot-public-' + pkg.version);

const SKIP_ANY = /(^|\/)(node_modules|\.git|__pycache__|\.DS_Store)(\/|$)/;
const SKIP_FILE = /\.(log|tmp|bak|bak2|swp)$|\.bak[^/]*$/i;

// 用 statSync 解引用软链接：integrations 下有些目录是指向别处的软链，statSync 能当普通目录递归；
// seen 防软链环。
function walk(rel, filter, out, seen) {
  const abs = path.join(ROOT, rel);
  const set = seen || new Set();
  let real = abs;
  try { real = fs.realpathSync(abs); } catch (e) { return out; }
  if (set.has(real)) return out;
  set.add(real);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of ents) {
    const r = rel + '/' + d.name;
    if (SKIP_ANY.test(r)) continue;
    if (SKIP_FILE.test(d.name)) continue;
    let st = null;
    try { st = fs.statSync(path.join(abs, d.name)); } catch (e) { continue; }
    if (st.isDirectory()) walk(r, filter, out, set);
    else if (filter(r, d.name)) out.push(r);
  }
  return out;
}

function copyOne(rel) {
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dst);
}

const SECRET_KEY = /^(apiKey|api_key|apikey|key|token|secret|password|cookie|session|accessToken|refreshToken|napcatToken)$/i;
const ID_KEY = /(QQ|qq|uid|uin|groupId|Group)$/;

function clean(v, key) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(x => clean(x, key));
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clean(v[k], k); return o; }
  if (typeof v === 'string') {
    if (SECRET_KEY.test(key)) return '';
    if (ID_KEY.test(key) && /^\d{5,12}$/.test(v)) return '';
    return v;
  }
  if (typeof v === 'number') {
    if (ID_KEY.test(key) && v > 9999 && v < 1e11) return 0;
    return v;
  }
  return v;
}

function configExamples() {
  const dir = path.join(ROOT, 'src', 'config');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const made = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith('.example.json')) continue;
    if (/local_priority|local-persona/.test(n)) continue;
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { continue; }
    const outRel = 'src/config/' + n.replace(/\.json$/, '.example.json');
    const dst = path.join(OUT, outRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify(clean(j), null, 2) + '\n', 'utf8');
    made.push(outRel);
  }
  return made;
}

const DATA_README = "# 运行时数据目录（不放代码）\n\n公开包里这里是空的：表情包、图库索引、聊天记录、花费账本、模型都在本地生成，\n换台机器跑起来会自己重建，不需要从作者那拷。\n\n| 子目录 | 放什么 | 是否可删 |\n|---|---|---|\n| stickers/ | 收集到的表情包（常用/ 可用/ 等池子） | 删了等于清空表情包库，会重新收 |\n| blocked/ | 被拦下的截图/插画/色图（默认留 30 天） | 可删 |\n| guides/ | 攻略/知识库 | 可删 |\n| usage/ | token 花费账本 | 可删 |\n| models/ | 可选：whisper 语音识别模型（ggml-*.bin） | 不用语音就可不放 |\n\nmedia-cache.json：图片 id（fileid）→ md5/指纹/描述 的缓存，保证同一张图只下一次。删了只会让下次重下一遍。\n";

/* 把复制进来的文件里的「本机痕迹」擦掉：
 * ① 作者本机绝对路径 → . / ~；② 真实 QQ 号/群号 → 中性号码（同一号码换同一个替身，测试里的比较逻辑不塌）。 */
function ownerNumbers() {
  const out = new Set();
  const add = v => { const s = String(v == null ? '' : v); if (/^\d{6,12}$/.test(s)) out.add(s); };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'connect.json'), 'utf8'));
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (v && typeof v === 'object') { for (const kk of Object.keys(v)) add(vv = v[kk]); }
      else add(v);
    }
  } catch (e) {}
  return out;
}

function scrubCopied() {
  const ids = ownerNumbers();
  const map = new Map();
  let n = 0;
  for (const id of ids) map.set(id, '10000000' + String(++n).padStart(2, '0'));
  const TEXT = /\.(js|json|md|txt|py|sh|command|bat|html|css|yml|yaml)$/i;
  const walkOut = dir => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walkOut(p); continue; }
      if (!TEXT.test(d.name)) continue;
      let s = '';
      try { s = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      const before = s;
      s = s.split(ROOT).join('.');
      s = s.replace(/\/Volumes\/\d+(?:\/[^\s'")]*)?/g, '外置卷');
      s = s.replace(/\/Users\/[^\/\s'"]+\//g, '~/');
      for (const [id, fake] of map) if (s.indexOf(id) >= 0) s = s.split(id).join(fake);
      // QQ 号字段一律中性化
      s = s.replace(/(["']?(?:masterQQ|selfQQ|botQQ|oniiQQ|oniiGroup|testGroup|masterUid)["']?\s*[:=]\s*["']?)(\d{5,12})/g, (m0, a, b) => a + ('10000000' + b.slice(-3)));
      // 测试夹具里的真号：tests/ 下的 9-10 位数字统一换替身，保持互不相同
      if (/\/tests\//.test(p)) {
        const seen = new Map();
        s = s.replace(/\b[1-9]\d{8,9}\b/g, num => {
          if (!seen.has(num)) seen.set(num, '100000' + String(1000 + seen.size));
          return seen.get(num);
        });
      }
      if (s !== before) fs.writeFileSync(p, s, 'utf8');
    }
  };
  walkOut(OUT);
}

function main() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = [];
  walk('src', r => !/^src\/data\//.test(r)
    && !/^src\/docs\//.test(r)
    && !/^src\/persona\/(1-人设正文|6-记忆数据)\//.test(r)
    && !/^src\/config\/.*\.json$/.test(r)
    && !/local_priority|local-persona/.test(r), files);
  walk('public', () => true, files);
  // 公开版客户端（只留壳）：node_modules / 日志 由 SKIP_ANY、SKIP_FILE 挡掉
  walk('client', () => true, files);
  walk('scripts', r => /\.(js|py)$/.test(r), files);
  walk('tools', r => /\.(js|py|sh|command|bat)$/.test(r), files);
  walk('tests', r => /\.js$/.test(r), files);
  // docs 里有一份 4 万行的本机全文件清单（含真实路径/QQ 号），不对外
  walk('docs', r => /\.md$/.test(r) && !/项目全文件清单/.test(r), files);
  walk('integrations', () => true, files);
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', '安装.md', '.env.example', '.gitignore', 'CHANGELOG.md']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(f);
  }
  // 启动就 require 的小配置文件（不是媒体）：必须发，否则新机器起不来
  for (const f of ['docs/截图/开关.png', 'docs/截图/客户端-表情包白天.png', 'docs/截图/客户端-表情包夜晚.png', 'docs/截图/客户端-搬屎.png', 'docs/截图/客户端-参数.png']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(f);
  }
  for (const f of ['src/data/xuhuan-logic.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.statSync(p).size < 512 * 1024) files.push(f);
  }
  for (const f of files) copyOne(f);

  const examples = configExamples();

  scrubCopied();


  // 人设身份配置里的 QQ 号也要清掉（结构留，号码去敏）
  for (const rel of ['src/persona/2-身份与配置.json']) {
    const p = path.join(OUT, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.writeFileSync(p, JSON.stringify(clean(j), null, 2) + '\n', 'utf8');
    } catch (e) {}
  }

  fs.mkdirSync(path.join(OUT, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'src/data/README.md'), DATA_README, 'utf8');
  for (const d of ['src/data/stickers/常用', 'src/data/stickers/可用', 'src/data/blocked', 'src/data/guides', 'src/data/usage', 'src/persona/1-人设正文', 'src/persona/6-记忆数据']) {
    fs.mkdirSync(path.join(OUT, d), { recursive: true });
    fs.writeFileSync(path.join(OUT, d, '.gitkeep'), '', 'utf8');
  }

  let bytes = 0, count = 0;
  (function size(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) size(p);
      else { count++; try { bytes += fs.statSync(p).size; } catch (e) {} }
    }
  })(OUT);

  console.log('[pack] 产物：' + path.relative(ROOT, OUT));
  console.log('[pack] 文件 ' + count + ' 个，' + (bytes / 1048576).toFixed(1) + ' MB；配置模板 ' + examples.length + ' 个');
  try {
    const r = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'scan-secrets.js'), OUT], { encoding: 'utf8' });
    console.log(r.trim());
  } catch (e) {
    console.log(String((e.stdout || '') + (e.stderr || '')).trim());
    console.log('[pack] 密钥扫描没过，包里不能有私货 —— 先修再发');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { main, OUT, clean };
