/* tests/test-self-forward.js — 搬屎转发只进上下文、不算发言（2026-11-22）
 * 纯逻辑 + 真实 buildMessages 产物，不连 QQ、不调模型。
 * 会往 chat-log / chat-shards / 她说过的话 追加测试行 → 跑完按大小截回去。
 */
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '..', 'src');
process.chdir(BASE);

const DATA = path.join(BASE, 'data');
const CHAT = path.join(DATA, 'chat-log.jsonl');
const SPEECH = path.join(DATA, '她说过的话.jsonl');
const SHARD_DIR = path.join(DATA, 'chat-shards');

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return -1; } }
const chatSize = sizeOf(CHAT);
const speechSize = sizeOf(SPEECH);
const shardBefore = {};
if (fs.existsSync(SHARD_DIR)) {
  for (const f of fs.readdirSync(SHARD_DIR)) {
    const p = path.join(SHARD_DIR, f);
    try { if (fs.statSync(p).isFile()) shardBefore[p] = sizeOf(p); } catch {}
  }
}
function restore() {
  try { if (chatSize >= 0) fs.truncateSync(CHAT, chatSize); } catch {}
  try { if (speechSize >= 0) fs.truncateSync(SPEECH, speechSize); } catch {}
  for (const [p, s] of Object.entries(shardBefore)) { try { fs.truncateSync(p, s); } catch {} }
  try {
    for (const f of fs.readdirSync(SHARD_DIR)) {
      const p = path.join(SHARD_DIR, f);
      if (shardBefore[p] === undefined) { try { fs.unlinkSync(p); } catch {} }
    }
  } catch {}
}

const qq = require(path.join(BASE, 'connectors', 'qq.js'));
const core = require(path.join(BASE, 'core.js'));
core.init(require(path.join(BASE, 'config')).load());
qq._setSelf('1000001000');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const ev = (o) => Object.assign({ post_type: 'message', message_type: 'group', user_id: '1000001000' }, o || {});

(async () => {
  console.log('一、识别：只有本号发的群合并转发才算搬屎');
  ok('本号 + 群合并转发 → 是', qq._isSelfSowingForward(ev(), ['123']) === true);
  ok('别人 + 群合并转发 → 不是', qq._isSelfSowingForward(ev({ user_id: '123456' }), ['123']) === false);
  ok('本号 + 纯文字 → 不是', qq._isSelfSowingForward(ev(), []) === false);
  ok('本号 + 私聊转发 → 不是', qq._isSelfSowingForward(ev({ message_type: 'private' }), ['1']) === false);

  console.log('二、历史：进普通上下文，但不进复读/兜底/最近回过');
  const K = 'qq_zz_self_forward';
  core.history.delete(K);
  const FORWARD = '[转发聊天记录]\n群友A(10001): 笑死我了';
  core.pushHist(K, 'assistant', FORWARD, null, { sowing: true });
  ok('sowing 条目进了历史（她能看到是自己发的）',
    core.getHist(K).length === 1 && core.getHist(K)[0].role === 'assistant' && core.getHist(K)[0].sowing === true);

  ok('不算她说过的话（复读检测跳过）', core._repeatHit(K, FORWARD) === '');
  ok('不算她说过的话（isRepeat 跳过）', core._isRepeat(K, FORWARD) === false);

  core.setTurn(K, { source: 'qq', uid: '1000001000', gid: 0, nick: '虚幻', isMaster: false });
  const msgs = await core.buildMessages(K, '刚才那串是啥');
  const all = msgs.map(m => String(m.content || '')).join('\n');
  ok('普通上下文里能看到这条转发', all.indexOf('笑死我了') >= 0);
  ok('sowing 不会单独变成"你最近这样回过"', all.indexOf('你最近这样回过') < 0);

  console.log('三、正常回复照旧，最近回过只列真回复');
  core.pushHist(K, 'assistant', '我在呢');
  const msgs2 = await core.buildMessages(K, '嗯');
  const lastBlock = msgs2
    .filter(m => m.role === 'system' && String(m.content || '').startsWith('你最近这样回过'))
    .map(m => String(m.content)).join('\n');
  ok('"最近这样回过"块存在且含真回复', lastBlock.indexOf('我在呢') >= 0, lastBlock.slice(0, 80));
  ok('"最近这样回过"块不含搬屎转发', lastBlock.indexOf('笑死我了') < 0);

  console.log('四、聊天记录只落流水，不进口语语料');
  const before = sizeOf(SPEECH);
  core.logLine('qq', '', '测试搬屎转发不该进语料', true, '群1000001001', { displayOnly: true });
  ok('displayOnly 不写「她说过的话.jsonl」', sizeOf(SPEECH) === before);

  restore();
  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => { try { restore(); } catch {} console.error(e); process.exit(1); });
