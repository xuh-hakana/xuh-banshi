'use strict';
/* scripts/pack-win.js — 打 Windows 便携版（一个目录，双击 xuhbot.exe 就开）。
 *
 * 用法：node scripts/pack-win.js
 * 说明：只是把 client/ 这层壳包成 exe；机器人本体（src/、config/、.env）还是 Node，
 *       exe 同级的 resources 目录里放仓库内容即可（client/main.js 会自己往上找 src/bot.js）。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist", "xuhbot-win");
const VER = require(path.join(ROOT, "app", "node_modules", "electron", "package.json")).version;

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: "inherit", cwd: ROOT }, opts || {}));
  return r.status;
}

console.log("[pack-win] Electron " + VER + " → " + OUT);
fs.mkdirSync(OUT, { recursive: true });

// npx 走临时缓存，避免 macOS 上 npm 默认缓存目录没权限（EACCES）
// 沙箱/受限账号下 ~/Library/Caches/electron 不可写（EPERM），把 Electron 下载缓存挪到 /tmp
const env = Object.assign({}, process.env, {
  ELECTRON_CACHE: "/tmp/electron-cache",
  electron_config_cache: "/tmp/electron-cache",
  npm_config_cache: "/tmp/npmcache",
});
const code = run("npx", [
  "--yes", "--cache", "/tmp/npmcache", "@electron/packager",
  "client", "xuhbot",
  "--platform=win32", "--arch=x64",
  "--electron-version=" + VER,
  "--out=" + OUT, "--overwrite", "--asar=false",
  "--app-version=0.3.0",
  "--ignore=日志", "--ignore=\.log$",
].concat(
  fs.existsSync("/tmp/electron-zip") ? ["--electron-zip-dir=/tmp/electron-zip"] : []
), { env: env });

const exe = path.join(OUT, "xuhbot-win32-x64", "xuhbot.exe");
if (code !== 0 || !fs.existsSync(exe)) {
  console.error("[pack-win] 失败：没生成 " + exe + "（exit=" + code + "）");
  console.error("[pack-win] 多半是下载 win32 版 Electron 被网络挡住；联网后在本目录重跑：npm run pack:win");
  process.exit(1);
}

const note = [
  "Windows 版怎么用",
  "",
  "1. 这个 exe 只是界面壳；机器人本体还是 Node 程序。",
  "2. 把仓库里的 src/、config/、public/、package.json、.env 复制到本目录的 resources/ 下",
  "   （和 app 文件夹同级），或者设环境变量 XUHBOT_ROOT 指向仓库根。",
  "3. 双击 xuhbot.exe 打开界面；机器人本身仍在项目根用 npm start 跑。",
  "",
  "源码版（不用 exe）：装 Node >= 22，双击 client\\启动客户端.bat，第一次会自动装 Electron。",
  "",
].join("\r\n");
fs.writeFileSync(path.join(OUT, "xuhbot-win32-x64", "启动Windows版.txt"), note, "utf8");

const zip = path.join(ROOT, "dist", "xuhbot-win-0.3.0.zip");
try { fs.unlinkSync(zip); } catch (e) {}
run("zip", ["-rq", zip, "xuhbot-win32-x64"], { cwd: OUT });

function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? count(p) : 1;
  }
  return n;
}
const dir = path.join(OUT, "xuhbot-win32-x64");
const files = count(dir);
const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
console.log("[pack-win] 好了：" + dir + "（" + files + " 个文件）");
console.log("[pack-win] 压缩包：" + zip + "（" + mb + " MB）");
