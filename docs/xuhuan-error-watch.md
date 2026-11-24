# 虚幻报错自动处理

> 虚幻（AstrBot 机器人）一报错 → 队列 → 自动起一轮 DSH → 我定位、修、留痕、重新布防。

## 链路

```
6 个日志源 + 崩溃报告
   ↓ 采集器 xuhuan-error-watch.py（launchd 常驻，每 3 秒扫一次）
指纹去重(24h) → 每小时限流 5 条 → queue.jsonl + reports/
   ↓ --arm 后台任务读到新条目就退出
DSH 会话收到任务完成通知 → 起一轮 → 我处理
```

状态目录：`~/.dsh/storages/xuhuan-error-watch/`（state.json / queue.jsonl / reports/ / collector.err.log）

## 监控源（已全覆盖）

| 源 | 说明 |
|---|---|
| ~/.astrbot/logs/backend.log | 主日志 |
| ~/.astrbot/logs/backend.log.1 | 轮转档（inode 变化自动接续） |
| ~/.astrbot/logs/desktop.log | 桌面端 |
| ~/.astrbot/logs/event_loop_watchdog.log | 事件循环看门狗 |
| /tmp/astrbot-backend.err.log | launchd 的 stderr（崩溃常落这里） |
| /tmp/astrbot-backend.out.log | launchd 的 stdout |
| ~/Library/Logs/DiagnosticReports/astrbot-*.ips | 客户端崩溃报告 |

命中判定：`[ERRO]/[ERROR]/[CRIT]/[CRITICAL]/[FATAL]` 记录行、孤儿 `Traceback`、asyncio `future: <Task ... exception>` / `exception was never retrieved`。
不命中：INFO/WARN 文案里出现的 "ERROR:"（真实存在，已实测挡住）。

## 命令

```bash
S=~/.dsh/scripts/xuhuan-error-watch.py
python3 $S --status                 # 源数量 / 去重表 / 未处理 / 本小时推送
python3 $S --once                   # 扫一遍，有就打印并入队
python3 $S --arm --timeout 10800    # 布防（读到新报错就退出 → 唤醒会话）
python3 $S --ack <指纹>              # 标记已处理
python3 $S --dry-run --from-start   # 全量回扫，只打印
```

## 常驻收集（launchd）

- plist：`~/Library/LaunchAgents/com.xuhuan.error-watch.plist`，KeepAlive + RunAtLoad，开机自起，DSH 关着也收。
- **注意**：launchd 读不了外置卷（外置卷 报 Operation not permitted），所以跑的是家目录副本：
  `~/.dsh/scripts/xuhuan-error-watch.py`。
- 改完工作区里的 `tools/xuhuan-error-watch.py` 要同步一份：
  ```bash
  cp './tools/xuhuan-error-watch.py' ~/.dsh/scripts/
  launchctl unload ~/Library/LaunchAgents/com.xuhuan.error-watch.plist
  launchctl load -w ~/Library/LaunchAgents/com.xuhuan.error-watch.plist
  ```
- 卸载：`launchctl unload ~/Library/LaunchAgents/com.xuhuan.error-watch.plist; rm` plist。

## 我收到报错后的处理协议

1. `error_search` 查旧条目；没命中 `error_list` 补查。
2. 按 traceback 的 `文件:行` 读源码定位、改（第三方插件在 `~/.astrbot/data/plugins/`）。
3. `error_add` 留痕（class=local，section=xuhbot），可复用修复 `code_add` 双向关联。
4. `--ack <指纹>`，重新布防 `--arm`。

## 边界

- 同指纹 24h 只推一次；每小时最多推 5 条，其余只入队。
- 报告脱敏（6 位以上数字 → `<num>`），≤120 行，不带消息正文。
- 采集器自己崩 → 任务退出即触发一轮，等于自带看门狗。
- 会话关掉 → 采集不断（launchd 在跑），重开后 `--arm` 会立刻补报积压。

## 实测记录（2026-11-25）

| 检查 | 结果 |
|---|---|
| 历史日志回扫 | 118 块（旧版只认 [ERROR]，15 个孤儿 traceback 全漏；已修） |
| 模拟三类样本 | [ERRO]+traceback、孤儿 traceback、asyncio future 各 1 块，共 3 块 |
| 伪命中 | INFO 里的 "ERROR:" 未命中 |
| 去重 | 重复扫描返回 NEW 0 |
| 断档补报 | 无 arm 时造错 → 队列 unacked=1，重启守望立刻可读 |


## 采集规则（2026-11-25 起）

| 形态 | 入队条件 | 优先级 |
|---|---|---|
| ERRO / ERROR / CRIT / FATAL | 无条件 | high |
| WARN / WARNING | 行内含失败关键词（失败/错误/异常/failed/error/timeout…） | mid |
| INFO / DEBG | 行内含 SQLAlchemy 报错转储标记，或含失败关键词 | mid |
| 任意行 | startup error / Logging error in Loguru / 下载失败 / Fatal Python error | mid |

- 续行窗口 400 行；out.log 的 `| ` 续行按 rkey 合并回原记录。
- 同类签名 1 小时内只入队一次，重复次数写进队列 `n` 字段，报告显示「同类重复 N 次/小时」。
- 屏蔽表 `~/.dsh/storages/xuhuan-error-watch/mute.txt`，一行一个正则，`#` 注释；缺失时自动补齐默认项（banshi 心跳、watchdog enabled、pip Retrying、赞美关键词、配置加载、Loguru Handler）。
- 队列行字段：`ts / fp / source / sig / pri / n / acked`。
- `--sweep`：从各日志开头全量扫一遍，只把 high 优先级按粗签名入队（去重），用于补历史积压。
- `--from-start` 现在真正忽略 state offset 从头读（此前有 state 时该参数无效）。
