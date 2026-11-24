# xuhbot

> 版本：v0.0.1（公开版 · 未检查（不稳定））


QQ 陪伴机器人。单进程 Node 程序，接 NapCat（OneBot 11 反向/正向 WS），带本地管理面板与 Electron 桌面客户端。

## 运行前提

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22.x | 需要 `require(ESM)` 支持；`src/dice.js` 依赖此特性加载 dicescript |
| NapCat | 任意近期版本 | 提供 OneBot 11 接口；QQ 连接由它维护，本项目只连它的 WS 端口 |
| Python 3 | 3.x | 仅 `src/scripts/sticker_hash.py`（表情包指纹）与 `src/scripts/qzone_stroll.py` 使用 |

## 目录结构

```
xuhbot/
├── src/                    主程序（代码与运行时数据同级）
│   ├── bot.js              进程入口
│   ├── core.js             调度核心：判定接话、生成回复、记忆读写
│   ├── connectors/         qq.js（OneBot）、bili.js（B站直播）、bili-comment.js（评论区收图）
│   ├── server/panel.js     本地面板服务端（127.0.0.1:8899）
│   ├── config/             配置读写入口
│   ├── persona/            人设与记忆（1-6 分层）
│   ├── soul/               基础人格文件
│   ├── data/               运行时数据（表情包、攻略、好感度、日志、花费账）
│   │   └── usage/          token-usage.jsonl 花费账本
│   ├── scripts/            Python 辅助脚本
│   └── dice.js             骰子（SealDice 引擎封装）
├── public/                 面板前端（panel.html / panel-client.js）
├── app/                    Electron 桌面客户端（虚幻.app + main.js）
├── tools/                  维护脚本（检查不记录群 / 重启AstrBot后端 / 同步梗站清单；.command / .sh / .py）
├── tests/                  test-all.js、regress-panel.js
├── docs/                   项目文档
└── integrations/           AstrBot 桥接插件源码
```

## 启动方式

| 用途 | 命令 | 入口 |
|---|---|---|
| 机器人本体 | 客户端「机器人」页启动，或 `NapCatInstaller.app` | `app/启动客户端.command`（虚幻.app） |
| 桌面客户端 | `npm run client` | `app/启动客户端.command` |
| 全部测试 | `npm test` | — |

机器人本体由客户端（虚幻.app）经 `app/bot-runner.js` 拉起，不再有独立的 `tools/启动机器人.command`。
网页面板（:8899）已弃用，管理功能全部在客户端里。

## 路径约定（改动前必读）

`src/` 下所有模块用 `const ROOT = __dirname;` 定位数据文件，不依赖进程工作目录。
因此 `data/`、`persona/`、`soul/`、`config/` 必须与 `src/` 下的 `.js` 保持同级。
把 `src/` 整体平移不破坏任何路径；把 `data/` 单独挪走需要同步修改每个模块的 `ROOT` 定义。

`src/connectors/` 下的模块多一层目录，其路径写作 `path.join(__dirname, '..', 'data', ...)`。

面板服务端 (`src/server/panel.js`) 的 `ROOT` 是 `path.join(__dirname, '..')`，前端静态文件从 `public/` 读取。

## 数据说明

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `src/data/stickers/` | 表情包，按池分目录（常用/可用/虚幻/关键词触发/少用） | 是，约 93 MB |
| `src/data/guides/` | 攻略库 | 是 |
| `src/persona/` | 人设正文、规则层、记忆数据 | 是 |
| `src/data/usage/` | token 花费账本，按天保留 | 是 |
| `src/data/*.log` | 运行日志 | 否（.gitignore） |

## 与 AstrBot 的关系

两者可独立运行，也可让 AstrBot 作为 QQ 接入层、本项目作为判定层。
约束：**同一条 QQ 连接只能由一方持有**，否则一条消息会被回复两次。
接入方式见 `integrations/`。
