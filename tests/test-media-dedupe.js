'use strict';
/* 图片下载去重验收（2026-11-24）：同一张图重发（rkey 变、fileid 不变）只能下载 1 次。
 * 断网络：core.getBinary / core.seeImage 都替身，只数 getBinary 调用次数。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const core = require('../src/core.js');
const mediaCache = require('../src/media-cache.js');

const fixture = (() => {
  const dir = path.join(__dirname, '..', 'src', 'data', 'stickers');
  for (const sub of ['', '常用']) {
    const d = path.join(dir, sub);
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) {}
    const hit = names.find(n => /\.(jpg|jpeg|png)$/i.test(n));
    if (hit) return path.join(d, hit);
  }
  return '';
})();
if (!fixture) { console.log('SKIP: 没有夹具图（src/data/stickers 空）'); process.exit(0); }
const buf = fs.readFileSync(fixture);

let gets = 0, seen = 0;
const origGet = core.getBinary, origSee = core.seeImage;
core.getBinary = async () => { gets++; return { buf: buf, type: 'image/jpeg' }; };
core.seeImage = async () => { seen++; return '字：去重测试图'; };

const qq = require('../src/connectors/qq.js');
const tag = 'TESTDEDUPE' + Date.now();
const u = (rkey) => 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=' + tag + '&rkey=' + rkey;

(async () => {
  try {
    const r1 = await qq._describeImgs([{ url: u('k1'), file: 'a.image' }], {});
    assert.strictEqual(gets, 1, '第一次应下载 1 次，实际 ' + gets);
    assert.ok(r1.descs[0], '第一次应有描述');
    const seen1 = seen;

    const r2 = await qq._describeImgs([{ url: u('k2'), file: 'a.image' }], {});
    assert.strictEqual(gets, 1, '同 fileid 重发应 0 次下载，实际累计 ' + gets);
    assert.strictEqual(seen, seen1, '同 fileid 重发不该再调视觉模型');
    assert.ok(r2.descs[0], '缓存命中也要有描述');

    // 收表情包不能把这张图再下一次：有 im.buf 就直接用
    const before = gets;
    await qq._collectSticker({ url: u('k1'), file: 'a.image', buf: buf, mime: 'image/jpeg' }, '字：去重测试图', { group_id: 1 });
    assert.strictEqual(gets, before, '收图不该重复下载同一条消息的图');

    // 同一张图换成 mid（客户端/台账路径）也要命中
    const r3 = await qq._describeImgs([{ mid: require('crypto').createHash('md5').update(buf).digest('hex'), url: '' }], {});
    assert.ok(r3.descs[0], '按 md5 也应命中');

    await qq._describeImgs([{ url: u('k3') + 'x', file: 'b.image' }], {});
    // 不同 fileid：要再下载一次
    await qq._describeImgs([{ url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=' + tag + '-other&rkey=z' }], {});
    assert.strictEqual(gets, 2, '不同图应各下载 1 次，实际累计 ' + gets);

    const st = mediaCache.stats();
    console.log('PASS 去重：下载次数=' + gets + ' 视觉模型次数=' + seen + ' 缓存条目=' + st.total);
  } finally {
    core.getBinary = origGet; core.seeImage = origSee;
    // 清掉本条测试写进去的缓存，避免污染真实缓存（先落盘再改）
    try {
      mediaCache.saveNow();
      const db = JSON.parse(fs.readFileSync(mediaCache.FILE, 'utf8'));
      for (const k of Object.keys(db.byKey)) if (k.indexOf(tag) >= 0) delete db.byKey[k];
      fs.writeFileSync(mediaCache.FILE, JSON.stringify(db));
    } catch (e3) {}
  }
})().catch(e => { console.error('FAIL', e.message); try { core.getBinary = origGet; core.seeImage = origSee; } catch (e2) {} process.exit(1); });
