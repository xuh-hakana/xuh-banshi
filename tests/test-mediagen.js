'use strict';
/*
 * test-mediagen.js —— 视频工坊离线自检（不联网、不花钱、不开子进程跑 AI）
 * 只验证「编排层不会瞎跑」：参数校验、降级、密钥不外泄、WAV 头对不对。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const keys = require(path.join(ROOT, 'src', 'mediagen', 'keys'));
const music = require(path.join(ROOT, 'src', 'mediagen', 'music'));
const llm = require(path.join(ROOT, 'src', 'mediagen', 'llm'));
const bili = require(path.join(ROOT, 'src', 'mediagen', 'bili'));
const mpt = require(path.join(ROOT, 'src', 'mediagen', 'mpt'));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + (e && e.message)); }
}

(async () => {
  console.log('视频工坊离线自检');

  await t('keys.status 只报有没有，不带 key 值', () => {
    const s = keys.status();
    assert(Array.isArray(s));
    for (const x of s) {
      assert(typeof x.provider === 'string');
      assert(typeof x.keySet === 'boolean');
      const json = JSON.stringify(x);
      assert(!/[A-Za-z0-9]{32,}/.test(json), '疑似把 key 打印出来了：' + json.slice(0, 80));
    }
  });

  await t('程序化编曲生成的 wav 头合法', async () => {
    const out = path.join(os.tmpdir(), 'mediagen-test-' + Date.now() + '.wav');
    const r = music.synth({ out, seconds: 2, bpm: 120, mood: 'calm' });
    const buf = fs.readFileSync(r);
    assert.strictEqual(buf.slice(0, 4).toString(), 'RIFF');
    assert.strictEqual(buf.slice(8, 12).toString(), 'WAVE');
    assert.strictEqual(buf.readUInt16LE(22), 2, '应当立体声');
    assert.strictEqual(buf.readUInt32LE(24), 44100, '应当 44.1kHz');
    assert(buf.length > 44 + 44100, '数据太短');
    fs.unlinkSync(r);
  });

  await t('llm.extractJson 能从围栏/废话里抠 JSON', () => {
    const fenced = '好的：\n' + String.fromCharCode(96,96,96) + 'json\n{"a":1}\n' + String.fromCharCode(96,96,96);
    assert.deepStrictEqual(llm.extractJson(fenced), { a: 1 });
    assert.deepStrictEqual(llm.extractJson('前言 {"b":[2]} 后语'), { b: [2] });
    assert.throws(() => llm.extractJson('没有 json'));
  });

  await t('投稿参数校验：没成片/标题过长/标签超 10 个都要拦', async () => {
    const tmp = path.join(os.tmpdir(), 'mediagen-fake-' + Date.now() + '.mp4');
    fs.writeFileSync(tmp, 'x');
    await assert.rejects(() => bili.upload({ video: '/no/such/file.mp4', title: 'a', tag: 'b' }), /成片不存在/);
    await assert.rejects(() => bili.upload({ video: tmp, title: 'x'.repeat(81), tag: 'a' }), /80/);
    await assert.rejects(() => bili.upload({ video: tmp, title: 'ok', tag: Array(12).fill('t').join(',') }), /10/);
    await assert.rejects(() => bili.upload({ video: tmp, title: 'ok', tag: 'a', tid: 'abc' }), /数字/);
    fs.unlinkSync(tmp);
  });

  await t('投稿演练（dryRun）只回参数，不碰网络', async () => {
    const tmp = path.join(os.tmpdir(), 'mediagen-fake2-' + Date.now() + '.mp4');
    fs.writeFileSync(tmp, 'x');
    const r = await bili.upload({ video: tmp, title: '测试标题', tag: 'AI,测试', tid: 188, desc: '简介', dryRun: true });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.plan.tid, '188');
    assert.deepStrictEqual(r.plan.tags, ['AI', '测试']);
    assert(!('cookie' in r.plan), '演练结果不该带 cookie');
    fs.unlinkSync(tmp);
  });

  await t('mpt.findFinals 对不存在的 task 返回空数组（不抛）', () => {
    assert.deepStrictEqual(mpt.findFinals('no-such-task-0000'), []);
  });

  await t('mpt.installed 返回布尔', () => {
    assert.strictEqual(typeof mpt.installed(), 'boolean');
  });

  console.log('\n' + (fail ? '❌ ' : '✅ ') + 'pass ' + pass + ' / fail ' + fail);
  process.exit(fail ? 1 : 0);
})();
