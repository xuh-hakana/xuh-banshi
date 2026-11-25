'use strict';
/* 密钥 / 隐私扫描（发布前硬拦）：只报文件+行号+规则名，不打印命中内容本身。
 * 用法：node scripts/scan-secrets.js [目录]   （默认 dist/xuh-banshi-public-<version>）
 * 退出码 1 = 有命中，发布脚本会因此中止。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT = /\.(js|json|md|txt|py|sh|command|bat|html|css|yml|yaml)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', 'dist']);

const RULES = [
  ['sk-key', /sk-[A-Za-z0-9_-]{16,}/],
  ['abs-mac-path', /\/Volumes\/980|\/Users\/[A-Za-z0-9._-]+\/(Desktop|Documents|Downloads)/],
  // 只认「键: 值」形态，且值不像占位符（<...>、placeholder、your-xxx），避免 pad_token = "<|endoftext|>" 这种误报
  ['secret-value', /["']?(apiKey|api_key|secret|accessToken|clientSecret|password|cookie)["']?\s*[:=]\s*["'][^"']{8,}["']/i],
  ['qq-number-field', /"?(masterQQ|selfQQ|botQQ|oniiQQ|oniiGroup|testGroup)"?\s*:\s*"?\d{5,12}"?/],
];

function walk(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of names) {
    if (SKIP_DIR.has(d.name)) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (TEXT.test(d.name)) out.push(p);
  }
  return out;
}

function scan(dir) {
  const files = walk(dir, []);
  const hits = [];
  for (const f of files) {
    const isExample = /\.example\.json$/.test(f);
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [name, re] of RULES) {
        if (isExample && (name === 'secret-value' || name === 'qq-number-field')) continue;  // 模板里空值本来就要留键
        const m = re.exec(lines[i]);
        if (!m) continue;
        // 明显的占位/测试值不算泄露（'bench-not-real-key'、'SESSDATA=' + s 这类拼串）
        if (name === 'secret-value' && /(not-real|placeholder|example|dummy|fake|test|bench|xxx|your|\+\s|\$\{)/i.test(m[0])) continue;
        // 真 Key 都有一长串字母数字；'SESSDATA=' 这种拼串没有
        if (name === 'secret-value' && !/[A-Za-z0-9_-]{16,}/.test(m[0])) continue;
        // 打包时把真 QQ 号换成了 100000 开头的替身，替身不算泄露
        if (name === 'qq-number-field' && /100000\d*/.test(m[0])) continue;
        hits.push({ file: path.relative(dir, f), line: i + 1, rule: name });
      }
    }
  }
  return { files: files.length, hits };
}

const target = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'xuh-banshi-public-' + require(path.join(ROOT, 'package.json')).version));
const r = scan(target);
for (const h of r.hits.slice(0, 40)) console.log('[secret] ' + h.file + ':' + h.line + '  ' + h.rule);
if (r.hits.length) { console.log('FAIL 命中 ' + r.hits.length + ' 处（扫了 ' + r.files + ' 个文本文件）'); process.exit(1); }
console.log('PASS 无密钥/隐私命中（扫了 ' + r.files + ' 个文本文件）');
