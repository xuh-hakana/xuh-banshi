#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重启 AstrBot 后端（改了插件/配置之后用）。

为什么需要它：
  AstrBot 是 Tauri 桌面版，后端由桌面 app 托管，WebUI 里点「重启核心」会被拒
  （"AstrBot Desktop manages this backend process"）。只能从外面重启后端。

怎么用：
  python3 "重启AstrBot后端.py"
  或者双击运行（如果有 .command 就更方便）

关键点（都是踩过的坑）：
  1) webui 路径是 backend/../webui，不是 backend/webui
  2) 必须用 --webui-dir 参数；环境变量 ASTRBOT_WEBUI_DIR 不生效。不传会去下载 WebUI（慢且可能失败）
  3) 必须设 ASTRBOT_ROOT=~/.astrbot，否则数据目录会建到 backend/app/data（错的）
  4) 必须用 start_new_session=True 让进程脱离当前会话，否则命令一结束进程就被回收
"""
import os
import subprocess
import sys
import time

APP = "~/Applications/AstrBot.app/Contents/Resources/backend"
PY = f"{APP}/python/bin/python3"
MAIN = f"{APP}/app/main.py"
WEBUI = f"{APP}/../webui"


def running_pids():
    """找出正在跑的后端进程（按命令行特征匹配）。"""
    out = subprocess.run(["pgrep", "-f", "main.py --webui-dir"],
                         capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.strip().isdigit()]


def main():
    pids = running_pids()
    if pids:
        print(f"先停掉旧后端：{pids}")
        for p in pids:
            subprocess.run(["kill", str(p)], capture_output=True)
        time.sleep(4)

    env = dict(os.environ)
    env["ASTRBOT_ROOT"] = os.path.expanduser("~/.astrbot")
    env["PYTHONUTF8"] = "1"

    log_path = "/tmp/astrbot-backend.log"
    log = open(log_path, "ab", buffering=0)
    proc = subprocess.Popen(
        [PY, MAIN, "--webui-dir", WEBUI],
        cwd=f"{APP}/app",
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,   # 关键：脱离当前会话，不会被回收
        close_fds=True,
    )
    print(f"已启动后端，pid = {proc.pid}")
    print("等它起 QQ 连接…")

    for i in range(40):
        time.sleep(2)
        r = subprocess.run(["lsof", "-tiTCP:6199", "-sTCP:LISTEN"],
                           capture_output=True, text=True).stdout.strip()
        if r:
            print(f"✅ AstrBot 后端已就绪（QQ 端口 6199 在监听，pid {r}）")
            print(f"   日志：{log_path}")
            return 0
        if proc.poll() is not None:
            print(f"❌ 后端启动失败（退出码 {proc.returncode}），看日志：{log_path}")
            return 1
    print(f"⚠️ 40 秒还没起来，看日志：{log_path}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
