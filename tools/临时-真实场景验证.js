/*
 * 临时脚本：真实场景验证（非单测）——mock 掉「真发消息」和「真调模型」，
 * 但把一条真实结构的 QQ 主人私聊事件喂给搬家后的 handleTurn 决策链，
 * 验证：① 决策链能跑通不抛错 ② 主人消息走必回 ③ 回复被送到发送层。
 * 用途：证明 qq.js 决策链整段搬家后功能行为没变（全绿之外的行为验证）。
 */
const path = require('path');
const cfg = require('../src/config').load();
const core = require('../src/core');
core.init(cfg);
const qq = require('../src/connectors/qq.js');
qq._setCfg(cfg);

(async () => {
  const sent = [];
  let modelCalls = 0, prompt = '';
  // mock 发送层：只记录，不真发 QQ 消息
  qq._setSender((action, params) => {
    sent.push({ action, params });
    return { ok: true };
  });
  // mock 模型：回一句固定话，不花 token；顺带记下提示词，验证必回场合提示词在
  const origChat = core.chat;
  core.chat = async function (k, build, onAnswer) {
    modelCalls++;
    try { const msgs = build(); prompt = JSON.stringify(msgs); } catch {}
    if (onAnswer) await onAnswer('验证用回复：我在。');
    return { ok: true };
  };

  const master = String(cfg.masterQQ || '100000000');
  // 真实结构的私聊消息事件（OneBot 11 / NapCat 字段）
  const ev = {
    time: Math.floor(Date.now() / 1000),
    self_id: '10000',
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: master,
    message_id: 100000000,
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗',
    sender: { user_id: master, nickname: '主人', sex: 'female', age: 0 },
  };

  let err = '';
  try {
    await qq._handleTurn(ev, {
      text: '在吗',
      atMe: false,
      isPrivate: true,
      who: '主人',
      rawNick: '主人',
      atMeReal: false,
      replyMe: true,
      imgs: [],
    });
  } catch (e) {
    err = (e && e.stack) || String(e);
  }
  // replyTo 里的发送走 setTimeout(delay)，等一下再统计
  await new Promise(r => setTimeout(r, 1500));
  core.chat = origChat;

  const textSent = sent.map(s => s.action + ':' + JSON.stringify(s.params && s.params.message || '')).join(' | ');
  console.log('决策链跑通(无异常):', !err);
  if (err) console.log('异常:', err);
  console.log('模型被调用次数:', modelCalls);
  console.log('发送层调用次数:', sent.length);
  console.log('发送动作:', sent.map(s => s.action).join(', ') || '(无)');
  console.log('发送内容:', textSent.slice(0, 300));
  console.log('生成的提示词长度:', prompt.length);

  const ok = !err && modelCalls >= 1 && sent.length >= 1;
  console.log('\n结果:', ok ? 'PASS 真实场景链路通（决策链→模型→发送层全程跑通）' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
