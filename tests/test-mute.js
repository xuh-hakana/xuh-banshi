/*
 * tests/test-mute.js — 群禁言判定自测（纯逻辑，不连 QQ、不调模型、不写数据）
 * 只测纯逻辑：事件 → 到期时刻 → botMuted 判断。不连 QQ、不调模型、不写数据。
 */
const path = require('path');
const fs = require('fs');
const qq = require(path.join(__dirname, '..', 'src', 'connectors', 'qq.js'));

// 这个测试会调 _onGroupBan，而 onGroupBan 会顺手把禁言状态写进 data/bot-status.json
// （面板要看）。不备份的话跑一次就给面板塞进一堆假群号和假「被禁言」，线上那个 pid 也被改成测试进程。
// 所以先存一份，跑完原样还原。
const STATUS = path.join(__dirname, '..', 'src', 'data', 'bot-status.json');
const backup = (() => {
  try {
    const st = fs.statSync(STATUS);
    return { ok: true, text: fs.readFileSync(STATUS, 'utf8'), mtime: st.mtime };
  } catch { return { ok: false }; }
})();
function restoreStatus() {
  try {
    if (backup.ok) { fs.writeFileSync(STATUS, backup.text); fs.utimesSync(STATUS, backup.mtime, backup.mtime); }
    else if (fs.existsSync(STATUS)) fs.unlinkSync(STATUS);
  } catch {}
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const ME = '1000001000';
const GID = 1000001001;
qq._setSelf(ME);

const ban = (duration, sub, uid = ME, gid = GID) => ({
  post_type: 'notice', notice_type: 'group_ban', sub_type: sub || 'ban',
  group_id: gid, user_id: uid, duration, self_id: ME,
});

console.log('一、QQ 里能选的各种时长，都要认（禁言 → 立刻停）');
for (const [label, sec] of [['30 秒', 30], ['60 秒', 60], ['1 小时', 3600], ['1 天', 86400], ['30 天', 2592000], ['自定义 45 分钟', 2700]]) {
  const gid = GID + sec;
  qq._onGroupBan(ban(sec, 'ban', ME, gid));
  ok(label + ' → 判定被禁言', qq._botMuted(gid) === true);
  const left = qq._muteLeftText(gid);
  ok(label + ' → 剩余时间说得出来', !!left, left);
}

console.log('二、解禁 / 禁别人 / 别的群，不能误伤');
qq._onGroupBan(ban(86400));
ok('先禁 1 天 → 被禁言', qq._botMuted(GID) === true);
qq._onGroupBan(ban(0, 'lift_ban'));
ok('lift_ban → 立刻解除', qq._botMuted(GID) === false);
const retOther = qq._onGroupBan(ban(3600, 'ban', '123456'));
ok('禁的是别人 → 不拦（事件交给后面照常处理）', retOther === false && qq._botMuted(GID) === false);
qq._onGroupBan(ban(600, 'ban', ME, 111111));
ok('别的群被禁 → 只影响那个群', qq._botMuted(111111) === true && qq._botMuted(GID) === false);
qq._onGroupBan(ban(0, 'lift_ban', ME, 111111));

console.log('三、私聊/别的群不受连带');
qq._onGroupBan(ban(3600));
ok('本群被禁时，本群判定为真', qq._botMuted(GID) === true);
ok('未出现过的群判定为假（不误伤）', qq._botMuted(999999) === false);

console.log('四、事件没给时长（duration=0 的 ban）→ 兜底不永久卡死');
qq._onGroupBan(ban(0, 'ban', ME, 222222));
ok('duration=0 → 仍判定被禁言', qq._botMuted(222222) === true);
ok('duration=0 → 兜底按 30 天，不是永久', qq._muteLeftText(222222).indexOf('天') > 0, qq._muteLeftText(222222));

restoreStatus();   // 把 data/bot-status.json 还原成跑测试之前的样子（别让面板看见假禁言）
console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
