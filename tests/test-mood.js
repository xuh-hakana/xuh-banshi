/*
 * tests/test-mood.js —— 心情 → 语气 的离线自检（2026-11-22）
 *
 * 为什么要有它：这段是「按心情改语气」的唯一出口，写错了不会报错、只会让情绪悄悄
 * 从提示词里消失（跟 2026-11-04 那次 catch 吞掉人设块一个道理）。
 *
 * 什么时候跑：node tests/test-mood.js（不挑当前目录、不联网、不写数据）
 */
const path = require('path');
const mood = require(path.join(__dirname, '..', 'src', 'learn', 'mood'));

let pass = 0, fail = 0;
const t = (name, ok, why) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  『' + (why || '') + '』'));
};

const TYPES = ['happy', 'playful', 'calm', 'curious', 'excited', 'angry', 'anxious', 'sad', 'nostalgic', 'serious'];

t('十种心情都有语气指令', TYPES.every(k => typeof mood.TONE[k] === 'string' && mood.TONE[k].length > 4));
t('十种心情都有中文名', TYPES.every(k => typeof mood.LABEL[k] === 'string' && mood.LABEL[k].length > 0));

const blocks = TYPES.map(k => mood.block({ type: k, intensity: 0.6, description: '测试' }, 200));
t('十种心情的注入块两两不同', new Set(blocks).size === TYPES.length, new Set(blocks).size + '/' + TYPES.length);
t('块里带标题和强度', blocks[0].indexOf('## 你现在的心情') === 0 && blocks[0].indexOf('60%') > 0);

t('没心情 → 空串（不编）', mood.block(null, 200) === '');
t('空对象 → 空串', mood.block({}, 200) === '');
t('不认识的心情 → 空串', mood.block({ type: 'sleepy', intensity: 1 }, 200) === '');
t('强度缺失也能用', mood.block({ type: 'happy' }, 200).indexOf('开心') === 0 || mood.block({ type: 'happy' }, 200).indexOf('开心') > 0);

const long = mood.block({ type: 'nostalgic', intensity: 1, description: '很长的描述'.repeat(20) }, 60);
t('超长按上限截断', long.length <= 60, '实际 ' + long.length);

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
