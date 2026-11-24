# 笑点解析 · xiaodian-jiexi v0.9.0

一个 Agent Skill：把一条聊天/一句话/一张图，解析成「谁说的哪句原话 → 字面 → 实际指什么、谁把什么当成了什么 → 属于哪种笑」，按固定解析体输出。

## 安装

**方式一：下载 zip 手动解压（推荐，包里有内置资料库）**

1. 下载 `dist/xiaodian-jiexi-0.9.0.zip`
2. 解压到 `~/.workbuddy/skills/xiaodian-jiexi/`
3. 确认 `~/.workbuddy/skills/xiaodian-jiexi/SKILL.md` 存在

**方式二：克隆目录**

```bash
git clone <仓库地址> ~/.workbuddy/skills/xiaodian-jiexi
```

> 其他 agent（Claude Code 等）放 `~/.claude/skills/xiaodian-jiexi/` 也能用。

## 用法

- 「笑点解析」+ 原话 / 引用 / 图
- 「这段为什么好笑」「笑点在哪」「没看懂求解析」
- 只给一句话也可以，它只解析这一条

## 和机器人数据的关系（不要求独立运行）

装了机器人（xuhbot / qq-companion-bot 一类）的话，脚本能自动找到它的数据，星标走同一条路径：

```bash
node scripts/data-locate.mjs
node scripts/import-stars.mjs --dry
```

`data-locate.mjs` 只读：按 `--root` / `$XUHBOT_ROOT` / 当前目录 / `~/xuhbot` `~/.xuhbot` `~/qq-companion-bot` 的顺序找 `src/data/chat-stars.json`，再向上找。找不到就退出码 0 并列出候选，不会报错。

## 版本与已知缺口（v0.9.0）

- 解析主体可用：四问 + 机制 + 固定解析体 + 确定性自检（`scripts/check.mjs`）。
- **情绪参照表**：`references/情绪参照表.md` 只有表头和用法，内容待填。
- **群友幽默发言学习清单**：`references/群友幽默发言学习.md` 只有表头和生成脚本，内容待填。
- 两节填了之后 SKILL.md 的流程自动使用，不用改提示词。

## 外部资料库

| 资料 | 来源 | 许可 | 位置 |
|---|---|---|---|
| 喜剧 Mechanics（67 张机制/结构卡） | ddcat-ai/open-ai-canvas | MIT | `knowledge/comedy-mechanics/`（已内置） |
| 幽默大师 humor-master | caicai688/humor.skill | 未声明 | `node scripts/fetch-knowledge.mjs` 自取 |
| Joke Engineering | ynulihao/AgentSkillOS | 未声明 | 同上自取 |

## 许可

原创部分 MIT（见 LICENSE）；第三方各自许可见 NOTICE.md。
