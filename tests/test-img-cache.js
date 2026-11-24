'use strict';
// 金标等价测试：缓存版产出的 data URI 必须与旧写法逐字节相同。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const m = require('../src/img-cache');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcache-'));
const f = path.join(dir, 'a.bin');
fs.writeFileSync(f, Buffer.from('xuhbot-image-bytes'));

const buf = fs.readFileSync(f);
const refPng = 'data:image/png;base64,' + buf.toString('base64');
const refJpg = 'data:image/jpeg;base64,' + buf.toString('base64');
assert.strictEqual(m.dataUriFromBuffer(buf, 'image/png'), refPng);
assert.strictEqual(m.dataUriFromBuffer(buf, 'image/jpeg'), refJpg);
assert.strictEqual(m.dataUriFromFile(f, 'image/jpeg'), refJpg);
assert.strictEqual(m.dataUriFromB64(buf.toString('base64'), 'image/png'), refPng);
assert.strictEqual(m.b64FromFile(f), buf.toString('base64'));
// 复用：同一张图第二次返回同一个字符串对象（引用相等）
assert.strictEqual(m.dataUriFromBuffer(buf, 'image/png'), m.dataUriFromBuffer(buf, 'image/png'));
assert.strictEqual(m.dataUriFromFile(f, 'image/png'), refPng);
// 文件被覆盖后必须拿到新内容（不能吃旧缓存）
fs.writeFileSync(f, Buffer.from('changed'));
assert.strictEqual(m.dataUriFromFile(f, 'image/png'), 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
// 读不到就是空串，与原行为一致
assert.strictEqual(m.dataUriFromFile(path.join(dir, 'missing.png'), 'image/png'), '');
assert.strictEqual(m.b64FromFile(path.join(dir, 'missing.png')), '');
console.log('img-cache 金标测试通过', JSON.stringify(m.stats()));
fs.rmSync(dir, { recursive: true, force: true });
