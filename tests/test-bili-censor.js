/* B站筛选自测：政治/色情强词/辱骂强词/纯口语/图片 fail-open。不打印词表内容。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../src/bili-censor');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); } return cond; };

ok('政治强词命中', c.judgeText('习近平').kind === 'political');
ok('色情强词命中', c.judgeText('口交').kind === 'sexual');
ok('色情强词命中2', c.judgeText('射精').kind === 'sexual');
ok('弱色情词放行（干）', c.judgeText('我想干你').pass);
ok('弱色情词放行（操）', c.judgeText('操死你').pass);
ok('辱骂强词命中', c.judgeText('你个logo').kind === 'insult');
ok('弱辱骂放行', c.judgeText('你他妈真废物').pass);
ok('中性词放行', c.judgeText('垃圾分类很重要').pass);
ok('正常话放行', c.judgeText('今天天气不错').pass);

ok('纯口语短记录过滤', c.isPureColloquialChat(['哈哈哈哈', '在吗', '吃了吗']) === true);
ok('有信息量的记录不过滤', c.isPureColloquialChat(['今天看到一条新闻说A股大涨', '明天开盘看看']) === false);
ok('单条不按聊天记录过滤', c.isPureColloquialChat(['哈哈哈哈']) === false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-censor-'));
const img = path.join(tmp, 'x.png');
fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZc9WQAAAABJRU5ErkJggg==', 'base64'));

(async () => {
  let r = await c.judgeImage(img, null, { seeImage: async () => '不是 JSON' });
  ok('识图失败放行', r.pass && r.failOpen);
  r = await c.judgeImage(img, null, { seeImage: async () => '{"exposed":true,"confidence":0.9,"parts":["x"],"text":""}' });
  ok('明确暴露拦截', r.pass === false && r.kind === 'exposure');
  r = await c.judgeImage(img, null, { seeImage: async () => '{"exposed":true,"confidence":0.4,"parts":["x"],"text":""}' });
  ok('低置信度放行', r.pass === true);
  r = await c.judgeImage(img, null, { seeImage: async () => '{"exposed":false,"confidence":0.9,"parts":[],"text":"习近平"}' });
  ok('图中文字也过筛', r.pass === false && r.kind === 'political');

  console.log('B站筛选自测：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
