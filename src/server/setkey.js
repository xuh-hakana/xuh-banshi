/*
 * setkey.js — 交互式填 API Key，不用手改 JSON
 * 运行：双击「填Key」，或 node setkey.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const configStore = require('../config');   // 配置统一入口：Key 写到 config/llm.json

function mask(k) {
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('把 API Key 粘贴到这里，然后回车：\n> ', ans => {
  const key = (ans || '').trim().replace(/^["']|["']$/g, '');
  if (!key) {
    console.log('\n没有输入，已取消（原配置未改动）');
    rl.close();
    return;
  }
  if (key.length < 40 || !key.includes('.')) {
    console.log(`\n❌ 这串不对：长度 ${key.length}，${key.includes('.') ? '有点' : '没有那个英文句点'}`);
    console.log('智谱的 Key 是两段式：32位.16位（中间一个英文点），约 49 位。');
    console.log('管理页：https://bigmodel.cn/usercenter/proj-mgmt/apikeys');
    console.log('你大概率只复制了前半段。请回控制台点「复制」按钮，别手动拖选。');
    console.log('（配置未改动，可以重新双击「填Key」）');
    rl.close();
    return;
  }
  try {
    const cfg = configStore.load();
    cfg.llm = cfg.llm || {};
    cfg.llm.apiKey = key;
    configStore.writeFull(cfg);
    console.log(`\n✅ 已写入 config/llm.json：${mask(key)}`);
    console.log('现在可以关掉这个窗口，去双击「启动」了。');
  } catch (e) {
    console.log('\n写入失败：' + e.message);
    console.log('可能是配置文件被记事本占用或格式损坏。');
  }
  rl.close();
});
