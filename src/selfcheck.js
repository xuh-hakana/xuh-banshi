/*
 * selfcheck.js — 自检只有一个入口（主人 2026-10-23 定：同类工具的拓展一律整合到老文件，不再另起新文件）
 *
 * 用法（在机器人目录里开命令行）：
 *   node selfcheck.js          代码自检：语法 / JSON / 必备文件 / 单测 / 在线状态 + Key 与网络的快速体检
 *   node selfcheck.js --why    「她为什么不回话」诊断：真打一次模型，按错误码给结论（如智谱 1220 = IP 白名单）
 *   node selfcheck.js --all    上面两套一起跑（双击「自检」就是它）
 *   node selfcheck.js --speed  响应速度基准：一条消息在「组装提示词」上的本地耗时
 *   node selfcheck.js --size   提示词体积：systemPrompt 每一段占多少字符
 *   node selfcheck.js --demo   笑点解析演示（走线上同一条链路，不写数据）
 *
 * 只做检查（只有「能自动修的小毛病」会修：缺文件补默认、BOM、JSON 尾逗号）。
 * 单测自己会还原快照，不会弄脏数据。
 * 结果落到 data/selfcheck-latest.json（面板可看）+ 功能日志一条（只在结论变了才追加，不刷屏）。
 * 返回码：0=全过，1=有问题要人看。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const dns = require('dns');
const configStore = require('./config');   // 配置统一入口：从 config/ 四个分区读取
const https = require('https');

const ROOT = __dirname;
const NODE = process.execPath;
const MODE = process.argv[2] || '';
const results = { t: new Date().toISOString(), ok: true, checks: [], fixed: [], problems: [] };
const say = (name, ok, detail) => {
  results.checks.push({ name, ok, detail: detail || '' });
  if (!ok) results.ok = false;
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
};

/* ==================================================================
 * 一、代码自检（默认模式 + --all）
 * ================================================================== */
function walkJs(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

function codeCheck() {
  console.log('── 代码自检 ' + '─'.repeat(38));

  /* 1. 语法检查（node --check 每一个 js）+ 顺手剥 BOM（BOM 会让 --check 报假错，剥了就好——这是能自动修的） */
  const jsFiles = walkJs(ROOT, []);
  for (const p of jsFiles) {
    try {
      let src = fs.readFileSync(p, 'utf8');
      if (src.charCodeAt(0) === 0xfeff) {
        fs.writeFileSync(p, src.slice(1), 'utf8');
        results.fixed.push('剥掉 BOM：' + path.relative(ROOT, p));
        src = src.slice(1);
      }
      execFileSync(NODE, ['--check', p], { stdio: 'pipe' });
    } catch (e) {
      const m = String(e.stderr || e.message).split('\n').filter(l => /:\d+\n|^SyntaxError|Error:/.test(l)).slice(0, 3).join(' | ');
      results.problems.push({ file: path.relative(ROOT, p), what: '语法错误', detail: (e.stderr || e.message).toString().slice(0, 400) });
      say('语法 ' + path.relative(ROOT, p), false, m || e.message);
    }
  }
  say('语法检查 ×' + jsFiles.length + ' 个 js', results.problems.filter(x => x.what === '语法错误').length === 0);

  /* 2. JSON 都能读（config + data 里所有 .json）。剥 BOM / 尾逗号能自动修，修完再验一遍 */
  const jsonFiles = ['config/persona.json','config/llm.json','config/connect.json','config/features.json']
    .concat(fs.readdirSync(path.join(ROOT, 'data')).filter(f => f.endsWith('.json')).map(f => 'data/' + f));
  for (const rel of jsonFiles) {
    const p = path.join(ROOT, rel);
    try {
      let src = fs.readFileSync(p, 'utf8');
      if (src.charCodeAt(0) === 0xfeff) { fs.writeFileSync(p, src.slice(1), 'utf8'); results.fixed.push('剥掉 BOM：' + rel); src = src.slice(1); }
      try { JSON.parse(src); }
      catch (e1) {
        const fixed = src.replace(/,\s*([}\]])/g, '$1');   // 尾逗号是编辑时最常见的笔误，直接去掉
        JSON.parse(fixed);
        fs.writeFileSync(p, fixed, 'utf8');
        results.fixed.push('修掉尾逗号：' + rel);
      }
    } catch (e) {
      results.problems.push({ file: rel, what: 'JSON 坏了', detail: e.message });
      say('JSON ' + rel, false, e.message.slice(0, 120));
    }
  }
  say('JSON 检查 ×' + jsonFiles.length, !results.problems.some(x => x.what === 'JSON 坏了'));

  /* 3. 必备文件在不在：缺了就按默认值补上（这是能自动修的） */
  const MUST = {
    'data/style-samples.json': '[]',
    'data/chat-stars.json': '{}',
    'data/bot-status.json': '{"online":false,"detail":"刚补的占位","at":"1970-01-01T00:00:00.000Z"}',
    'data/updates.jsonl': '',
    'data/feature-log.jsonl': '',
  };
  for (const [rel, def] of Object.entries(MUST)) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { }
      fs.writeFileSync(p, def, 'utf8');
      results.fixed.push('补建缺失文件：' + rel);
    }
  }
  say('必备文件 ×' + Object.keys(MUST).length, true,
    results.fixed.filter(x => x.startsWith('补建')).length
      ? '补了 ' + results.fixed.filter(x => x.startsWith('补建')).join('、').replace(/补建缺失文件：/g, '')
      : '');

  /* 4. 单测全套（_test_all.js 自己会还原快照，不会弄脏数据） */
  try {
    const out = execFileSync(NODE, [path.join(ROOT, '_test_all.js')], { stdio: 'pipe', timeout: 120000 }).toString();
    const m = out.match(/(\d+)\s*\/\s*(\d+)/);
    const passed = m && m[1] === m[2];
    say('单测 ' + (m ? m[1] + '/' + m[2] : ''), !!passed, (out.trim().split('\n').pop() || '').slice(0, 80));
    if (!passed) {
      out.split('\n').filter(l => l.includes('✗')).slice(0, 8)
        .forEach(l => results.problems.push({ file: '_test_all.js', what: '单测失败', detail: l.trim().slice(0, 200) }));
    }
  } catch (e) {
    results.problems.push({ file: '_test_all.js', what: '单测跑挂了', detail: String(e.stdout || e.message).slice(-400) });
    say('单测', false, '跑挂了（看 selfcheck-latest.json）');
  }

  /* 5. 面板 / 机器人活着吗（只是提醒，不算 bug） */
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bot-status.json'), 'utf8'));
    const thinkMs = st.thinking && st.thinkingAt ? Date.now() - Date.parse(st.thinkingAt) : 0;
    // 「思考中」卡死（2026-10-23 真事）：上一轮进程被杀时 thinking=true 没复位，
    // 面板一直显示「正在想答案…」，看着像她卡住了——其实进程早没了。超过 3 分钟就一直算卡住。
    const stuck = thinkMs > 180000;
    // 进程还在不在（v88）：主人一直开着 启动.bat 却掉线，就是因为「窗口开着」≠「进程活着」。
    // 状态文件是进程自己写的，进程一死它就冻住、里面还写着 online:true —— 必须对着 pid 探一下。
    let pidAlive = null;
    if (st.pid) {
      try { process.kill(st.pid, 0); pidAlive = true; }
      catch (e) { pidAlive = e && e.code === 'EPERM'; }
    }
    const dead = pidAlive === false;
    say('机器人状态', !!st.online && !stuck && !dead,
      dead ? ('进程已经退了（pid ' + st.pid + ' 不在了）——启动窗口可能还开着，光看窗口看不出掉线，重新双击「启动」或跑 --restart')
        : (st.detail || (st.online ? '' : 'bot-status 显示离线（如果刚改完代码还没重启，重启就好）'))
        + (stuck ? '｜「正在想答案」卡了 ' + Math.round(thinkMs / 60000) + ' 分钟（进程多半已经没了，跑 --restart）' : ''));
    if (dead) results.problems.push({ file: 'data/bot-status.json', what: '机器人进程不在', detail: 'pid ' + st.pid + ' 已经不在（窗口可能还开着）。重新双击「启动」 或跑 node selfcheck.js --restart' });
    if (stuck) results.problems.push({ file: 'data/bot-status.json', what: '思考状态卡住', detail: 'thinking=true 已经 ' + Math.round(thinkMs / 60000) + ' 分钟没复位，进程可能已退出' });
  } catch { say('机器人状态', false, 'bot-status.json 读不到'); }

  /* 5b. 运行日志体检（2026-10-23 新增）
     为什么非要有这一项：语法/JSON/单测全过，她照样可能一句话都不回。
     真事（当天）：`[merge] 处理出错：replyOrigin is not defined` 每轮都抛、日志刷了一屏，
     自检却全是 ✓，主人只能自己截图来问「为什么不说话」。
     模型限流/降级/返回空正文也只有日志里看得到——这类「运行期故障」静态检查永远看不见。 */
  /* 6. Key 与网络的快速体检（不花 token；要真打模型用 --why） */
  let cfg = {};
  try { cfg = configStore.load(); } catch { }
  const llm = cfg.llm || {};
  let host = 'open.bigmodel.cn';
  try { host = new URL(llm.endpoint).host; } catch { }
  const k = String(llm.apiKey || '');
  if (!k || k.includes('在这里填')) say('模型 Key', false, '没填 Key → 面板「Key」页，或双击换Key.bat');
  else if (!/^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/.test(k)) say('模型 Key', false, 'Key 格式看着不对（正常是 32位.16位），多半粘漏了');
  else say('模型 Key', true, '格式正常');

  /* 7. 运行日志体检（2026-10-23 新增）
     为什么非要有这一项：语法/JSON/单测全过，她照样可能一句话都不回。
     真事（当天）：`[merge] 处理出错：replyOrigin is not defined` 每轮都抛、日志刷了一屏，
     自检却全是 ✓，主人只能自己截图来问「为什么不说话」。
     模型限流/降级/返回空正文也只有日志里看得到——运行期故障，静态检查永远看不见。 */
  logCheck();

  /* 8. 数据一致性（2026-10-23 新增，放最后）：这类错是「代码全对、数据对不上」，
     语法/单测都查不出来。真事：常用单 16 张表情全匹配失败（文件名前多了「常用/」），
     她发不出表情、还反过来报「库里没有这张」，自检却全 ✓。 */
  dataCheck();
}

/* ==================================================================
 * 二·五、数据一致性体检
 * ================================================================== */
function dataCheck() {
  // 8a. 表情常用单 ↔ data/stickers/常用/ 里的图
  try {
    const qq = require('./connectors/qq');
    const occ = qq._stickerOccasions();
    const names = Object.keys(occ);
    const miss = names.filter(n => !qq._stickerHit(n));
    // 反向：有图但没登记场合 = 这张她永远不会发（不算错，但要让人看见）
    const base = f => f.replace(/\.[^.]+$/, '').split('/').pop();
    const noOcc = qq._stickerFiles().filter(f => f.startsWith('常用/') && !occ[base(f)]).map(base);
    say('表情常用单 ×' + names.length, names.length > 0 && miss.length === 0,
      (names.length === 0
        ? '常用.md 一条场合都没登记（她一张表情都不会发）'
        : (miss.length
          ? miss.length + ' 张登记了场合但找不到图：' + miss.slice(0, 6).join('、') + ' → 图要放进 ' + require('./sticker-paths').relSticker() + '/常用/'
          : '每张都能找到'))
      + (noOcc.length ? '｜另有 ' + noOcc.length + ' 张有图没登记场合（不会发）：' + noOcc.slice(0, 6).join('、') : ''));
    if (miss.length) results.problems.push({ file: require('./sticker-paths').relSticker() + '/常用.md', what: '登记的场合找不到图', detail: miss.join('、') });
  } catch (e) {
    say('表情常用单', false, '读不出来：' + String(e.message).slice(0, 60));
  }

  // 8b. 单人约定指向的人还在不在（人不在了，提示词还在叫她照那个人的要求说话）
  // 键从 2026-11-06 起是 'platform:id'（qq:123 / bili:456 / xhs:abc），
  // 所以判「人还在不在」要问人物档案，别再拿 people-state.json 的裸 QQ 表对——
  // 带前缀的键在旧表里永远查不到，会把全部约定都报成「指向不认识的人」。
  try {
    const peopleStore = require('./people');
    const pacts = fs.readFileSync(path.join(ROOT, 'data', 'topics.jsonl'), 'utf8').split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && x.kind === 'promise' && x.qq);
    const orphan = pacts.filter(x => !peopleStore.pidOfKey(x.qq));
    say('单人的约定 ×' + pacts.length, orphan.length === 0,
      orphan.length
        ? orphan.length + ' 条指向不认识的人（' + orphan.slice(0, 3).map(x => x.qq).join('、') + '）'
        : '都指向认识的人');
    if (orphan.length) {
      results.problems.push({ file: 'data/topics.jsonl', what: '约定指向的人不存在', detail: orphan.map(x => x.qq + '：' + x.text).join('；').slice(0, 200) });
    }
  } catch { say('单人的约定', false, '读不出来'); }

  // 8c. 自己的 QQ 号（问号那一轮要用；没配她只能答「主人」）
  try {
    const cfg = configStore.load();
    say('自己的 QQ 号', !!cfg.selfQQ, cfg.selfQQ ? String(cfg.selfQQ) : 'config.selfQQ 没配 → 群友问她 QQ 号时答不出来');
    if (!cfg.selfQQ) results.problems.push({ file: 'config/', what: 'selfQQ 没配', detail: '群友问她自己的 QQ 号时没有号可答' });
  } catch { }

  // 8d. 面板接口（面板挂了不影响她回话，但主人什么都看不见——她只认面板）
  try {
    // 2026-10-28 迁 Mac：原来写死 'curl.exe' 和 Windows 的空设备 'NUL'。
    // Mac 上两个都不存在，execFileSync 会直接抛错 → 被下面的 catch 吞掉 → 明明面板开着却报「面板没开」。
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const code = execFileSync(curlBin, ['-s', '-o', devNull, '-w', '%{http_code}', '--max-time', '3', '--noproxy', '*',
      'http://127.0.0.1:8899/api/status'], { stdio: 'pipe', timeout: 6000 }).toString().trim();
    say('面板接口', code === '200', code === '200' ? '127.0.0.1:8899 正常' : '返回 ' + code + ' → 双击「管理面板」');
  } catch {
    say('面板接口', false, '连不上 127.0.0.1:8899（面板没开）');
    results.problems.push({ file: 'panel.js', what: '面板没开', detail: '127.0.0.1:8899 连不上，双击「管理面板」' });
  }

  // 8e. 日志体积（bot-out.log 只追加不裁剪，长久了会拖慢读取）
  try {
    const sz = fs.statSync(path.join(ROOT, 'data', 'bot-out.log')).size;
    const mb = sz / 1048576;
    say('日志体积', mb < 8, mb.toFixed(1) + ' MB' + (mb >= 8 ? ' → 偏大，建议裁到最近 2000 行' : ''));
  } catch { }
}

/* ==================================================================
 * 二、运行日志体检（2026-10-23 新增）
 *   只看「最后一次启动之后」的日志：昨天的老错不该一直算在今天的账上。
 *   查三件事：① 消息处理有没有抛异常（= 收得到消息但不回话）
 *            ② 模型链路有没有连不上 / 限流 / 降级
 *            ③ 有没有「模型返回空正文」（思考型模型烧 token 的典型症状）
 * ================================================================== */
function logCheck() {
  const p = path.join(ROOT, 'data', 'bot-out.log');
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { say('运行日志', false, 'bot-out.log 读不到（没启动过？）'); return; }
  const all = raw.split('\n');
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (/后端已启动/.test(all[i])) { start = i; break; }
  const lines = all.slice(start).slice(-3000);
  const crash = lines.filter(l => /\[merge\] 处理出错|\[fatal\]|UnhandledPromiseRejection/.test(l));
  const llmDown = lines.filter(l => /\[llm\] .*(连不上|超时)|429|130\d\b/.test(l));
  const degrade = lines.filter(l => /已切到/.test(l)).length;
  const emptyAns = lines.filter(l => /返回空|正文为空|no content/i.test(l)).length;

  if (crash.length) {
    const names = [...new Set(crash.map(l => (l.match(/([A-Za-z_$][\w$]*) is not defined/) || [])[1]).filter(Boolean))];
    say('运行日志 · 没在崩', false,
      crash.length + ' 次处理异常（那几轮她直接没回话）'
      + (names.length ? '：变量 ' + names.join('、') + ' 不存在 → 代码改漏了' : ''));
    results.problems.push({
      file: 'connectors/qq.js',
      what: '消息处理抛异常（收到消息但没回话）',
      detail: crash.slice(-3).join('\n').slice(0, 400) + (names.length ? '\n→ 代码里用了不存在的变量：' + names.join('、') : ''),
    });
  } else {
    say('运行日志 · 没在崩', true, '上次启动之后的 ' + lines.length + ' 行里 0 次处理异常');
  }

  if (llmDown.length) {
    say('运行日志 · 模型链路', degrade > 0,
      llmDown.length + ' 次连不上/限流' + (degrade ? '，已降级 ' + degrade + ' 次（下一条会自动试回主模型）' : '，而且一次都没降级成功'));
    if (!degrade) {
      results.problems.push({ file: 'core.js', what: '模型连不上且没降级成功', detail: llmDown.slice(-3).join('\n').slice(0, 300) });
    }
  } else {
    say('运行日志 · 模型链路', true, '没有连不上/限流的记录');
  }

  if (emptyAns) say('运行日志 · 空正文', false, emptyAns + ' 次模型返回空正文（思考型模型把 token 烧在思考上的典型症状）');
  else say('运行日志 · 空正文', true, '没有空正文');
}

/* ==================================================================
 * 三、为什么不回话（--why / --all）— 原 selfcheck.js 的老本事，收编在这里
 * ================================================================== */
function post(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'POST', headers, timeout: timeoutMs,
    }, res => {
      let t = '';
      res.on('data', d => { t += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}
function askOne(llm, model) {
  return post(llm.endpoint, {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (llm.apiKey || ''),
  }, JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }], max_tokens: 8 }), 12000);
}

async function whyCheck() {
  console.log('\n── 她为什么不回话 ' + '─'.repeat(32));
  let cfg = {};
  try { cfg = configStore.load(); } catch (e) {
    console.log('✗ config 读不出来：' + e.message);
    return;
  }
  const llm = cfg.llm || {};
  let host = 'open.bigmodel.cn';
  try { host = new URL(llm.endpoint).host; } catch { }

  console.log('接口：' + (llm.endpoint || '（空）'));

  // ① 先查最常见的原因：她被「暂停」了（真人真事 2026-10-23：主人问「为什么不说话」，
  // 结果 --why 只测了模型、还让他去看 NapCat，其实是早上一条无限期暂停没解）。
  // 暂停期间她一句都不说（聊天记录照记），模型通不通都没用——所以这条排最前面。
  let paused = [];
  try {
    const now0 = Date.now();
    paused = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pause.json'), 'utf8')) || [])
      .filter(x => x && x.kind && x.id && (!x.until || x.until > now0));
  } catch { }
  if (paused.length) {
    console.log('✗ 她是被暂停的（暂停期间一句都不说，只记聊天记录）：');
    paused.forEach(x => console.log('   · ' + (x.kind === 'group' ? '群 ' : '私聊 ') + x.id
      + (x.until ? '（' + new Date(x.until).toLocaleString('zh-CN') + ' 自动恢复）' : '（一直停到你允许）')
      + '，从 ' + String(x.t || '').replace('T', ' ').slice(0, 16) + ' 开始'));
    console.log('   → 解除：私聊发「允许' + (paused[0].kind === 'group' ? '群' + paused[0].id : '私聊 ' + paused[0].id) + '」，或删掉 data/pause.json 里那条');
  } else {
    console.log('✓ 没被暂停');
  }

  const k = String(llm.apiKey || '');
  const looksOk = /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/.test(k);
  console.log((k ? (looksOk ? '✓ Key 格式正常：' : '⚠ Key 格式看着不像（应该是 32位.16位）：') : '✗ 没填 Key：') + k.slice(0, 8) + '****' + k.slice(-4));
  console.log('主模型：' + (llm.model || '（空）') + '   备用：' + ((llm.fallbackModels || []).join(' / ') || '（无）'));

  let ip = '';
  try { ip = await new Promise((res, rej) => dns.lookup(host, (e, a) => e ? rej(e) : res(a))); } catch (e) { }
  console.log(ip ? ('✓ ' + host + ' → ' + ip) : ('✗ ' + host + ' 解析不了 → 换 DNS 223.5.5.5，或关掉代理软件'));

  console.log('\n真打一次（max_tokens 8，几个 token 而已）：');
  const models = [llm.model].concat(llm.fallbackModels || []).filter(Boolean);
  let lastCode = '', lastMsg = '', ok = 0;
  for (const m of models) {
    try {
      const r = await askOne(llm, m);
      let body = {};
      try { body = JSON.parse(r.text); } catch { }
      const code = (body.error && body.error.code) || '';
      const msg = (body.error && body.error.message) || '';
      if (r.status >= 200 && r.status < 300 && body.choices) {
        ok++;
        console.log('✓ ' + m + ' 能用：' + String(body.choices[0].message.content || '').trim().slice(0, 20));
      } else {
        lastCode = String(code); lastMsg = String(msg).slice(0, 90);
        console.log('✗ ' + m + ' → HTTP ' + r.status + (code ? ' / ' + code : '') + ' ' + String(msg).slice(0, 60));
      }
    } catch (e) {
      lastCode = e.code || ''; lastMsg = e.message;
      console.log('✗ ' + m + ' → ' + (e.code === 'ETIMEDOUT' ? '12 秒没响应' : (e.code || e.message)));
    }
  }

  // ④ 真走一遍完整链路（2026-10-23 新增）：上面打的是裸模型，只能证明「接口通」。
  // 真事：接口通、单测全过，她照样不回——真实提示词大得多，还可能撞思考型模型返回空正文。
  // 这一步才等价于「群里发一句话她会怎么样」。
  console.log('\n真走一遍完整链路（真实提示词 + 真实超时，问一句「在吗」）：');
  try {
    const core = require('./core');
    core.init(cfg);
    const k = 'selfcheck#probe';
    core.setTurn(k, { source: 'selfcheck', uid: String(cfg.masterQQ || ''), gid: 0, nick: '主人' });
    core.pushHist(k, 'user', '在吗');
    const t0 = Date.now();
    let out = '';
    await core.chat(k, () => core.buildMessages(k, '在吗'), a => { out = String(a || ''); });
    const ms = Date.now() - t0;
    if (out.replace(/[\s，。！？~～、（）()]/g, '')) {
      console.log('✓ 完整链路回了（' + (ms / 1000).toFixed(1) + ' 秒）：' + out.replace(/\s+/g, ' ').slice(0, 40));
    } else {
      console.log('✗ 完整链路返回空正文（' + (ms / 1000).toFixed(1) + ' 秒）：');
      console.log('  接口是通的，但她一个字都没说 → 多半是思考型模型把 token 烧在思考上，或限流后被降级的模型返回空。');
      console.log('  先看 config.llm.noThinkModels 里有没有这个模型；再看 data/thinking.jsonl 最后一条的原文。');
    }
  } catch (e) {
    console.log('✗ 完整链路抛错：' + String(e.message).slice(0, 120));
    console.log('  这说明「模型通，但她的代码在组装/发送这一步崩了」——不是网络问题，去看 data/bot-out.log 的 [merge] 那一行。');
  }

  console.log('\n结论：');
  if (ok) {
    console.log('她能用（' + ok + ' 个模型通）。如果群里还是不回，看是不是 NapCat 掉线了。');
  } else if (lastCode === '1220') {
    console.log('这不是断网，也不是 Key 写错——Key 能读、但生成接口被拒：');
    console.log('  智谱回的是「IP 没有接口访问权限」（403 + 1220）。');
    console.log('  按顺序试，一步就能看出来：');
    console.log('  1) bigmodel.cn 登录 → API Keys → 看这个 Key 有没有设「IP 白名单」，有就清空保存（30 秒生效）。');
    console.log('  2) 新建一个 Key（默认不带白名单）→ 双击「换Key」粘进去 → 重启「启动」。');
    console.log('  3) 把电脑切到手机热点再跑一次这个自检：');
    console.log('       热点能通 → 是你家宽带这个 IP 被限制了（换 IP / 重启光猫）；');
    console.log('       热点也不通 → 是账号层面（实名认证、免费额度、风控），去控制台看，或问智谱客服。');
  } else if (lastCode === '1000' || lastCode === '1001' || lastCode === '1003') {
    console.log('Key 本身不对（智谱连身份都没认）：双击「换Key」重新粘一次。');
  } else if (lastCode === '1113') {
    console.log('账户欠费：去 bigmodel.cn 充值。');
  } else if (lastCode === '1305' || lastCode === '1302' || lastCode === '1304') {
    console.log('限流（' + lastCode + '）：等 1~3 分钟自己会好，不用动任何东西。');
  } else if (/ETIMEDOUT|超时/.test(lastMsg)) {
    console.log('模型都不回话（超时）：先看代理是不是只接管了浏览器；关掉代理再跑一次。');
  } else if (/ENOTFOUND|DNS/.test(lastMsg) || !ip) {
    console.log('DNS 解析不了：把 DNS 改成 223.5.5.5 / 119.29.29.29，或关掉代理软件。');
  } else if (/ECONNREFUSED|ECONNRESET/.test(lastMsg)) {
    console.log('连不上接口：多半是代理 / 防火墙拦了 node.exe，先关代理再跑一次。');
  } else {
    console.log('没归类：' + (lastCode ? lastCode + ' ' : '') + lastMsg);
    console.log('把上面这段发给主人（或我），我照着改。');
  }
}

/* ==================================================================
 * 三、基准 / 演示（只开发时才用的三个模式）
 * ================================================================== */
function sizeCheck() {
  process.env.BENCH = '1';
  const core = require('./core');
  const cfg = require('./config').cfgLive();
  const cfgCopy = JSON.parse(JSON.stringify(cfg));
  cfgCopy.llm = Object.assign({}, cfgCopy.llm, { apiKey: 'x' });
  core.init(cfgCopy);
  const sys = core.systemPrompt();
  const secs = sys.split(/\n(?=## )/);
  const rows = secs.map(s => ({ title: (s.match(/^## (.+)$/m) || ['?', '（人设开头/无标题）'])[1].slice(0, 30), n: s.length }))
    .sort((a, b) => b.n - a.n);
  for (const r of rows) console.log(String(r.n).padStart(6), r.title);
  console.log('------ 合计', sys.length, '字符 ≈', Math.round(sys.length / 1.4), 'token（粗估）');
}

function speedCheck() {
  process.env.BENCH = '1';
  const core = require('./core');
  const cfg = require('./config').cfgLive();
  const cfgCopy = JSON.parse(JSON.stringify(cfg));
  cfgCopy.llm = Object.assign({}, cfgCopy.llm, { apiKey: 'bench-not-real-key' });
  cfgCopy.webSearch = Object.assign({}, cfgCopy.webSearch, { enabled: false });   // 基准只测本地组装，不联网
  core.init(cfgCopy);

  function timeIt(label, fn, n) {
    const N = n || 20;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn(i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    console.log(`${label.padEnd(44)} ${ms.toFixed(2)} ms/次`);
    return ms;
  }

  (async () => {
    const k = 'g_bench';
    console.log('== 单项基准（每条消息都会走一遍的部分）==');
    core.setTurn(k, { source: 'qq', uid: '123456', gid: 1000000004, nick: '测试群友', isMaster: false, atMe: true });
    core.pushHist(k, 'user', '测试群友说: 这个bot响应速度怎么样啊');
    core.pushHist(k, 'assistant', '还行吧，嘻嘻，你问这个干嘛');
    core.setTurn(k, { source: 'qq', uid: '123456', gid: 1000000004, nick: '测试群友', isMaster: false, atMe: true });

    console.log('\nsystemPrompt 长度：' + core.systemPrompt().length + ' 字符\n');
    timeIt('systemPrompt()', () => core.systemPrompt(), 20);
    core.setTurn(k, { source: 'qq', uid: '123456', gid: 1000000004, nick: '测试群友', isMaster: false, atMe: true, uid2: 0 });
    timeIt('buildMessages()（无联网路径）', () => core.buildMessages(k, '这个bot响应速度怎么样啊', ''), 20);
    timeIt('readTopics（话题jsonl 全量解析）', () => core.readTopics(), 20);
    timeIt('promiseLines()', () => core.readPromises(), 20);
    timeIt('keptTopicLines()', () => core.readKeptTopics(), 20);
    timeIt('topicHint()（readTopics 300）', () => core.topicHint('这个bot响应速度怎么样啊'), 20);
    timeIt('shortTermBlock()（翻 chat-log）', () => core.shortTermBlock(['测试群友']), 10);
    timeIt('taste.mine + listMine（喜好md解析）', () => { core.taste.mine(cfg.masterQQ); core.taste.listMine(cfg.masterQQ); }, 20);
    timeIt('guides.search（攻略库）', () => require('./guides').search('折射怎么打', 3), 20);
    timeIt('matchTrigger()（读 config）', () => core.matchTrigger('随便说点什么'), 20);

    core.setTurn(k, { source: 'qq', uid: '123456', gid: 1000000004, nick: '测试群友', isMaster: false, atMe: true });
    let total = 0;
    {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 10; i++) await core.buildMessages(k, '这个bot响应速度怎么样啊', '');
      total = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
    }
    console.log('\n== 一条消息组装 prompt 的本地总耗时：' + total.toFixed(2) + ' ms（不含模型/联网）==');
  })().catch(e => { console.error('基准失败：', e.message); process.exit(1); });
}

function demoCheck() {
  const core = require('./core');
  core.init(require('./config').cfgLive());
  const demo = core._xiaodianDemo;
  const cases = [
    {
      name: '样例1 · 主人范例原题（司凤/老冯，测 2 层+AI 点评）',
      xd: {
        target: '（他引用的消息）电子之海的虚幻幽灵：司凤是什么意思？你是在说我吗',
        person: ['元囮妈妈-婚内单身：@虚幻之海的电子幽灵 不要啊，我的老冯'],
        group: [
          '电子之海的虚幻幽灵：司凤是什么意思？你是在说我吗？',
          '元囮妈妈-婚内单身：@虚幻之海的电子幽灵 不要啊，我的老冯',
          '电子之海的虚幻幽灵：呜呜，主人的老冯不能不要啊！',
        ],
        after: ['元囮妈妈-婚内单身：笑死'],
      },
    },
    {
      name: '样例2 · 半截反常识梗（测自有梗库资料链）',
      xd: {
        target: '大肥鱼：生鱼片实际是死鱼片，等红灯实际是等绿灯',
        person: ['大肥鱼：生鱼片实际是死鱼片，等红灯实际是等绿灯'],
        group: ['大肥鱼：生鱼片实际是死鱼片，等红灯实际是等绿灯', '雷课：？'],
        after: [],
      },
    },
    {
      name: '样例3 · 一层小笑话 + AI 接错（测 1 层+点评）',
      xd: {
        target: '雷课：我以前是个胖子，后来瘦了',
        person: ['雷课：我以前是个胖子，后来瘦了'],
        group: [
          '雷课：我以前是个胖子，后来瘦了',
          '德川：瘦了多少',
          '雷课：瘦了心',
          '电子之海的虚幻幽灵：呜呜主人瘦了也很棒哦，要好好吃饭呀',
        ],
        after: ['雷课：……'],
      },
    },
  ];
  (async () => {
    for (const c of cases) {
      console.log('\n======== ' + c.name + ' ========');
      try {
        const t0 = Date.now();
        console.log(await demo(c.xd));
        console.log('—— 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's ——');
      } catch (e) { console.log('演示失败：' + e.message); }
    }
  })();
}

/* ==================================================================
 * 五、一键恢复（--restart）：只重启 bot.js，不动面板、不动 NapCat
 *   为什么要有这一项：自检原来只会「报告」，不会「恢复」——看到 ✗ 之后还得自己去关窗口、
 *   双击「启动」。真事 2026-10-23：进程其实早就没了，面板却一直显示「正在想答案…」，
 *   主人以为她卡死，其实连进程都不存在。这里顺手把 thinking 标记也复位。
 * ================================================================== */
function botPids() {
  try {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bot.js*' } | Select-Object -ExpandProperty ProcessId";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'pipe', timeout: 15000 }).toString();
      return out.split(/\s+/).filter(x => /^\d+$/.test(x));
    }
    // macOS / Linux：ps ax 列出「pid + 完整命令行」，挑出真正在跑 bot.js 的 node 进程。
    // 2026-10-28 迁 Mac 时加：原来只用 PowerShell，在 Mac 上一次都找不到进程，
    // 于是「一键恢复」会误判成「本来就没在跑」，再新开一个 → 两条 bot.js 同时在线 = 每条消息回两遍。
    // 排掉 selfcheck 自己和 ps/sh 包装层，避免把自己算成 bot.js。
    const out = execFileSync('ps', ['ax', '-o', 'pid=,command='], { stdio: 'pipe', timeout: 15000 }).toString();
    return out.split('\n')
      .map(l => l.trim())
      .filter(l => /bot\.js/.test(l) && !/selfcheck\.js|-c |\/bin\/sh|ps ax/.test(l))
      .map(l => (l.match(/^(\d+)/) || [])[1])
      .filter(x => x && /^\d+$/.test(x));
  } catch { return []; }
}

function restartBot() {
  console.log('── 一键恢复 ' + '─'.repeat(40));
  const pids = botPids();
  if (pids.length > 1) console.log('⚠ 有 ' + pids.length + ' 个 bot.js 在跑（会一条消息回两遍）——全部关掉重开');
  for (const pid of pids) {
    // process.kill 是 Node 原生能力，Win/Mac/Linux 通吃（Windows 上会被映射成 TerminateProcess），
    // 2026-10-28 迁 Mac 时把 execFileSync('taskkill'...) 换掉——Mac 没有 taskkill。
    try { process.kill(Number(pid), 'SIGTERM'); console.log('· 已结束旧进程 ' + pid); }
    catch (e) { console.log('· 结束 ' + pid + ' 失败：' + String(e.message).slice(0, 60)); }
  }
  if (!pids.length) console.log('· 本来就没有 bot.js 在跑（这本身就是不回话的原因）');
  // 思考标记复位：进程被强杀时 thinking 会留在 true，面板就永远显示「正在想答案…」
  try {
    const sp = path.join(ROOT, 'data', 'bot-status.json');
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    st.thinking = false;
    delete st.thinkingAt;
    fs.writeFileSync(sp, JSON.stringify(st, null, 1), 'utf8');
  } catch { }
  // 防双开（v90，主人 2026-10-23 问「启动.bat 真的正常吗」时查出来的真隐患）：
  // 主人的用法是「启动.bat 常开」——那个窗口退出后 5 秒会自己再拉一个。
  // 所以这里杀掉之后**先等 8 秒看有没有人接手**，有就不许再 spawn，否则一条消息回两遍。
  console.log('· 等 8 秒：启动.bat 的窗口要是还开着，它会自己把机器人拉回来（那样我就不再另开一个）');
  setTimeout(() => {
    const after = botPids();
    if (after.length) {
      console.log('✓ 守护窗口已经自动拉起来了（pid ' + after.join('、') + '），我没有再开第二个');
      waitOnline();
      return;
    }
    try {
      const fd = fs.openSync(path.join(ROOT, 'data', 'bot-out.log'), 'a');
      const child = spawn(NODE, [path.join(ROOT, 'bot.js')], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      console.log('· 没人在守护，我自己启动一个（日志：data/bot-out.log）');
    } catch (e) {
      console.log('✗ 启动失败：' + e.message + '（手动双击「启动」）');
      process.exitCode = 1;
      return;
    }
    waitOnline();
  }, 8000);
}

// 收尾复查：等 10 秒看有没有连上 NapCat
function waitOnline() {
  console.log('· 等 10 秒让它连上 NapCat…');
  setTimeout(() => {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bot-status.json'), 'utf8'));
      console.log((st.online ? '✓ 已上线：' : '✗ 还没上线：') + (st.detail || '')
        + '（' + String(st.at || '').replace('T', ' ').slice(0, 19) + '）');
      console.log(st.online ? '\n现在去群里发一句话试试。' : '\n还没连上 → 看 data/bot-out.log 最后几行，或确认 NapCat 开着（3001 端口）。');
      process.exitCode = st.online ? 0 : 1;
    } catch { console.log('✗ 读不到 bot-status.json，看 data/bot-out.log'); process.exitCode = 1; }
  }, 10000);
}

/* ==================================================================
 * 四、深度巡检（--deep）：五类覆盖，和自动自查（selfwatch）共用 checks.js
 *   和默认模式的分工：默认模式查「代码能不能跑」，这里查「她现在能不能正常干活」。
 *   五类（主人 2026-10-23 要求）：运行环境与依赖 / 配置与数据完整性 /
 *   网络与接口 / 核心功能 / 日志与异常定位。
 * ================================================================== */
async function deepCheck(verbose) {
  const checks = require('./checks');
  console.log('── 深度巡检（五类，' + '运行环境 · 配置数据 · 网络接口 · 核心功能 · 日志异常' + '）' + '─'.repeat(6));
  const items = await checks.runAll({ initCore: true });
  const s = checks.summarize(items);

  for (const g of checks.GROUPS) {
    const gs = items.filter(x => x.g === g);
    const bad = gs.filter(x => !x.ok);
    console.log('\n【' + g + '】' + (gs.length - bad.length) + '/' + gs.length
      + (bad.length ? '　' + bad.length + ' 项要处理' : '　全过'));
    if (verbose) {
      for (const x of gs) {
        console.log('  ' + (x.ok ? '✓' : (x.level === 'error' ? '✗' : '!')) + ' ' + x.name + ' — ' + x.detail);
        if (!x.ok && x.fix) console.log('      → ' + x.fix);
      }
      continue;
    }
    // 默认不刷屏：通过的项并排一行列出名字（看得见查了哪些），要处理的逐条展开 + 怎么修
    const okNames = gs.filter(x => x.ok).map(x => x.name);
    if (okNames.length) console.log('  ✓ ' + okNames.join('、'));
    for (const x of bad) {
      console.log('  ' + (x.level === 'error' ? '✗' : '!') + ' ' + x.name + ' — ' + x.detail);
      if (x.fix) console.log('      → ' + x.fix);
    }
  }

  // 报告落盘：手动一份、自动一份分开存，面板和「查看上次报告」都读得到
  const report = { t: new Date().toISOString(), source: 'manual', summary: s, items };
  try { fs.writeFileSync(path.join(ROOT, 'data', 'deepcheck-latest.json'), JSON.stringify(report, null, 1), 'utf8'); } catch { }
  try {
    const bad = items.filter(x => !x.ok);
    const md = ['# 深度巡检报告', '', '时间：' + new Date().toLocaleString('zh-CN'),
      '结果：' + s.total + ' 项，通过 ' + s.ok + '，错误 ' + s.err + '，警告 ' + s.warn, ''];
    for (const g of checks.GROUPS) {
      const gs = items.filter(x => x.g === g);
      md.push('## ' + g + '（' + (gs.length - gs.filter(x => !x.ok).length) + '/' + gs.length + '）');
      for (const x of gs) {
        md.push('- ' + (x.ok ? '[正常]' : (x.level === 'error' ? '[错误]' : '[提醒]')) + ' ' + x.name + '：' + x.detail);
        if (!x.ok && x.fix) md.push('  - 怎么修：' + x.fix);
      }
      md.push('');
    }
    fs.writeFileSync(path.join(ROOT, 'data', '自检报告.md'), md.join('\n'), 'utf8');
    results.problems.push(...bad.map(x => ({ file: x.g, what: x.name, detail: x.detail + (x.fix ? ' → ' + x.fix : '') })));
  } catch { }

  console.log('\n结论：' + (s.pass
    ? s.total + ' 项全过（警告 ' + s.warn + ' 条）'
    : s.err + ' 个错误、' + s.warn + ' 条警告要人看'));
  console.log('报告：data/deepcheck-latest.json（给人看的版本：data/自检报告.md）');
  if (verbose) console.log('（这是全部项；不加 -v 只显示要处理的）');
  process.exitCode = s.pass ? 0 : 1;
}

/* ==================================================================
 * 收尾：结果落盘 + 功能日志（结论没变就不追加，不刷屏）
 * ================================================================== */
function finish() {
  try { fs.writeFileSync(path.join(ROOT, 'data', 'selfcheck-latest.json'), JSON.stringify(results, null, 1), 'utf8'); } catch { }
  try {
    const detail = (results.problems.length ? '问题：' + results.problems.map(p => p.file + ' ' + p.what).join('；') : '语法/JSON/必备文件/单测/运行状态全过')
      + (results.fixed.length ? '（已自动修复：' + results.fixed.join('；') + '）' : '');
    // 功能日志不刷屏（主人 2026-10-23 定）：结论和上次一样就不再追加（面板「变更记录」
    // 曾被一次一次的「全过」刷满 55 条）。只有结论变了（全过↔出问题、问题内容变了、自动修了东西）才记一条。
    const fp = path.join(ROOT, 'data', 'feature-log.jsonl');
    let last = null;
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const e = JSON.parse(lines[i]); if (e.name === '代码自检') { last = e; break; } } catch { }
      }
    } catch { }
    if (!last || last.action !== (results.ok ? '通过' : '发现问题') || last.detail !== detail) {
      const log = { t: results.t, name: '代码自检', action: results.ok ? '通过' : '发现问题', state: results.ok ? '正常' : '异常', detail };
      fs.appendFileSync(fp, JSON.stringify(log) + '\n', 'utf8');
    }
  } catch { }

  console.log('\n结论：' + (results.ok ? '全过' : results.problems.length + ' 个问题要人看（data/selfcheck-latest.json）')
    + (results.fixed.length ? '；自动修了 ' + results.fixed.length + ' 处' : ''));
  if (!MODE || MODE === '--all') {
    console.log('\n其它玩法：--deep（深度巡检五类） / --why（为什么不回话） / --restart（一键重启机器人） / --speed（速度基准） / --size（提示词体积） / --demo（笑点解析演示）');
  }
  process.exitCode = results.ok ? 0 : 1;
}

/* ==================================================================
 * 分派
 * ================================================================== */
if (MODE === '--speed') speedCheck();
else if (MODE === '--size') sizeCheck();
else if (MODE === '--demo') demoCheck();
else if (MODE === '--why') whyCheck().then(() => { console.log(''); }).catch(e => console.log('诊断自己出错了：' + e.message));
else if (MODE === '--restart') restartBot();
else if (MODE === '--deep') deepCheck(process.argv[3] === '-v').catch(e => { console.log('深度巡检自己出错了：' + e.message); process.exitCode = 1; });
else if (MODE === '--all') {
  codeCheck();
  whyCheck().then(() => finish()).catch(e => { console.log('诊断自己出错了：' + e.message); finish(); });
} else {
  codeCheck();
  finish();
}
