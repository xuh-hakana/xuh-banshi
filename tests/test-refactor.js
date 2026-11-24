'use strict';
/* 2026-11-25 重构回归：提示词注册表 / 人设清单 / 工具调度 / 多重真相。 */
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; }
}

// ① 提示词注册表：无 ctx 全量、B站 裁 QQ 专属、问到了才给参考段
const reg = require('../src/prompt/registry');
const FULL = '# 虚幻\n身份\n\n## 你在 QQ 里能做什么\n拍\n\n## 检索与联网\n搜\n';

ok('注册表：无场景 = 全量（守卫兼容）', () => {
  assert.strictEqual(reg.filterText(FULL, null, ''), FULL);
});
ok('注册表：B站 裁掉 QQ 专属段', () => {
  const out = reg.filterText(FULL, { source: 'bili' }, '你好');
  assert(out.indexOf('你在 QQ 里能做什么') < 0, 'QQ 段没裁掉');
  assert(out.indexOf('虚幻') >= 0, '开头段被误裁');
});
ok('注册表：问到「搜一下」才注入检索段', () => {
  assert(reg.filterText(FULL, { source: 'qq' }, '帮我搜一下') .indexOf('检索与联网') >= 0, '该给的没给');
  assert(reg.filterText(FULL, { source: 'qq' }, '今天好热') .indexOf('检索与联网') < 0, '没问到也塞了');
});
ok('兼容外壳 rules/prompt-scenes 与注册表是同一份', () => {
  assert.strictEqual(require('../src/rules/prompt-scenes'), reg);
});

// ② 人设清单：文件都在、场景不缺、角色卡取得到
const persona = require('../src/persona');
ok('人设清单校验通过（文件齐、场合都有登记、面板顺序对得上）', () => {
  const v = persona.validate();
  assert(v.ok, JSON.stringify(v));
});
ok('回话角色拿到完整人设（F+H > 8000 字）', () => {
  assert(persona.rolePrompt('reply').length > 8000);
});
ok('接话判断角色不带人设正文（省 token）', () => {
  const t = persona.rolePrompt('judge');
  assert(t.length < 500, 'judge 角色带了人设：' + t.length);
  assert(t.indexOf('JSON') >= 0);
});

// ③ 工具调度：schema / 权限 / 失败自证
const reg2 = require('../src/tools/registry');
const disp = require('../src/tools/dispatch');
(async () => {
  ok('工具表有 specs 且形状合法', () => {
    const s = reg2.specs('qq');
    assert(s.length >= 1 && s.every(x => x.type === 'function' && x.function.name && x.function.parameters));
  });
  ok('未知工具 → 失败（不报成功）', async () => {
    const r = await disp.run({ name: 'nope', arguments: {} }, {});
    assert(r.ok === false);
  });
  return run2();
})();

async function run2() {
  const r1 = await disp.run({ name: 'remember_note', arguments: { text: 'x' } }, { scene: 'qq' });
  ok('内容太短 → 拒绝（不写）', () => assert(r1.ok === false));
  const r2 = await disp.run({ name: 'remember_note', arguments: '{oops' }, { scene: 'qq' });
  ok('参数不是 JSON → 拒绝', () => assert(r2.ok === false));
  const r3 = await disp.run({ name: 'remember_note', arguments: { text: '测试', extra: 1 } }, { scene: 'qq' });
  ok('多出未声明参数 → 拒绝', () => assert(r3.ok === false));
  const r4 = await disp.run({ name: 'remember_note', arguments: { text: '测试内容' } }, { scene: 'biliRestricted' });
  ok('场景不允许 → 拒绝', () => assert(r4.ok === false));

  // ④ 多重真相：投递 → 只在开的时候写、debrief 没结论时一个字都不加
  const mt = require('../src/multi-truth');
  ok('多重真相：没有结论时 debrief 为空串', () => assert.strictEqual(mt.debrief('qq_9999999'), ''));
  ok('多重真相：四个角色提示词都能拼出来', () => {
    assert(mt.build.judge({ text: 'a' }).length > 20);
    assert(mt.build.groupmate({ nick: 'A' }, { text: 'a' }).length > 20);
    assert(mt.build.recorder({ text: 'a' }, []).length > 20);
  });
  ok('多重真相：inbox 只写 data/multi-truth/inbox，键名被清洗', () => {
    assert.strictEqual(mt.safeKey('qq_1/../x'), 'qq_1_.._x');
    assert(mt.INBOX.indexOf('multi-truth') >= 0);
  });

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
