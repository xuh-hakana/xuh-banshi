#!/usr/bin/env node
// 自取无许可的第三方资料（不打进包）。零依赖。
// node fetch-knowledge.mjs [humor|joke|all] [--list] [--force]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KNOW = path.join(here, '..', 'knowledge');
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');

const SETS = {
  humor: { dir: 'humor-master', repo: 'https://github.com/caicai688/humor.skill.git', note: '幽默大师（未声明许可，仅供本机学习）' },
  joke: { dir: 'joke-engineering', repo: 'https://github.com/ynulihao/AgentSkillOS.git', note: 'Joke Engineering（未声明许可，仅供本机学习）' },
};

if (argv.includes('--list')) {
  for (const [k, v] of Object.entries(SETS)) console.log(k + '\t' + v.repo + '\t→ knowledge/' + v.dir + '\t' + v.note);
  process.exit(0);
}

const names = argv.filter((a) => !a.startsWith('--'));
const want = names.length === 0 || names.includes('all') ? Object.keys(SETS) : names.filter((n) => SETS[n]);
if (!want.length) { console.error('未知目标，可用: ' + Object.keys(SETS).join(', ') + ', all'); process.exit(2); }

let fail = 0;
for (const name of want) {
  const cfg = SETS[name];
  const target = path.join(KNOW, cfg.dir);
  if (fs.existsSync(target) && !FORCE) { console.log('[跳过] knowledge/' + cfg.dir + ' 已存在（--force 重拉）'); continue; }
  if (fs.existsSync(target) && FORCE) fs.rmSync(target, { recursive: true, force: true });
  console.log('[拉取] ' + cfg.repo + ' → knowledge/' + cfg.dir);
  const r = spawnSync('git', ['clone', '--depth', '1', cfg.repo, target], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('[失败] ' + name + '：检查网络或手动 clone 到 knowledge/' + cfg.dir); fail++; continue; }
  fs.writeFileSync(path.join(target, 'SOURCE.txt'), cfg.repo + '\n' + cfg.note + '\n拉取时间: ' + new Date().toISOString() + '\n');
  console.log('[完成] knowledge/' + cfg.dir);
}
process.exit(fail ? 1 : 0);
