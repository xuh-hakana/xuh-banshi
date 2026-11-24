/*
 * src/nl-server.js — 指令小端口（2026-11-19 主人令）
 *
 * 为什么要单独一个：B站 的聊天归 AstrBot 插件，它要把主人的私聊/纠错回传给 xuhbot；
 * 但 xuhbot 的面板（8899）是桌面客户端才拉起来的，机器人单独跑时面板不在，
 * 指令就断了。这个端口跟着 bot.js 一起起，只监听 127.0.0.1，只认两条路：
 *   POST /api/nlcommand     主人私聊的自然语言指令
 *   POST /api/nlcorrection  任何场景的纠错
 *   POST /api/enroll        B站 等别的平台「她回复了」→ 给这个人建档（2026-11-22）
 * 和面板同源：都调 nl-command.js，不复制第二套动作。
 */
'use strict';
const http = require('http');

const PORT = Number(process.env.NL_PORT || 8898);
let started = false;

function start() {
  if (started) return;
  started = true;
  const nl = require('./nl-command');
  const server = http.createServer((req, res) => {
    const json = o => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(o));
    };
    if (req.method !== 'POST') return json({ ok: false, error: 'only POST' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let d = {};
      try { d = body ? JSON.parse(body) : {}; } catch { return json({ ok: false, error: 'bad json' }); }
      try {
        if (req.url === '/api/nlcommand') {
          // 面板级写入/开关/群开关这些是主人的：只认主人自己的号
          if (!nl.isOwner(d.platform || 'qq', d.uid)) return json({ handled: false, reason: 'not-owner' });
          return json(await nl.handle(d));
        }
        if (req.url === '/api/nlcorrection') {
          // 记录类（约定 / 代称 / 标错 / 记小本本）是所有人的，谁都能触发；
          // 内部还分「主人宽松、别人严格 + 必须在跟她说话」，这里不做主人拦截。
          return json(await nl.handleRecord(d));
        }
        /* B站「回复才建档」（2026-11-22 她定）：插件在回复成功之后调这里。
         * QQ 侧是说话就建档，不走这条。只补人 + 昵称，不碰好感/喜好。 */
        if (req.url === '/api/enroll') {
          const people = require('./people');
          const plat = String(d.platform || '').trim();
          if (!plat) return json({ ok: false, error: '要 platform' });
          const id = String(d.uid || '').replace(/\D/g, '');
          if (!id) return json({ ok: false, error: '要 uid' });
          const nick = String(d.nick || '').slice(0, 40);
          const before = people.findByAccount(plat, id);
          const pid = before || people.ensure(plat, id, nick ? { nick } : {});
          if (!pid) return json({ ok: false, error: '建不了' });
          // 已建档但昵称变了（B站 改过名）→ 更新
          if (nick) { try { people.setAccountNick(plat, id, nick); } catch {} }
          return json({ ok: true, pid, created: !before });
        }
        /* 客户端发言（2026-11-23 主人令）：
         * 桌面客户端打的字 / 发的图、视频、语音、文件，从这条口进机器人进程，
         * 当成「主人私聊」一条消息走 onMessage —— 回复照旧发到她的 QQ 私聊，不绕开 QQ。
         * 只监听本机，不接受任何「发给别人」的参数（目标固定是配置里的主人号）。 */
        if (req.url === '/api/panel/send') {
          const qq = require('./connectors/qq');
          return json(await qq.injectClientMessage(d));
        }
        return json({ ok: false, error: 'not found' });
      } catch (e) {
        return json({ handled: false, ok: false, error: e.message });
      }
    });
  });
  server.on('error', e => console.log('[指令端口] 起不来：' + e.message));
  server.listen(PORT, '127.0.0.1', () => console.log('[指令端口] http://127.0.0.1:' + PORT));
  server.unref();   // 别拿它拖着进程不退
}

module.exports = { start, PORT };
