# scripts

零依赖 Node 脚本（Node 18+）。

| 脚本 | 作用 | 只读 |
|---|---|---|
| `check.mjs` | 解析体自检：六项结构 + 四项内容；`--self-test` 跑内置正反例 | 是 |
| `data-locate.mjs` | 找机器人数据目录（chat-stars/热梗/解析留档） | 是 |
| `import-stars.mjs` | 星标+热梗+留档 → 群友幽默发言学习表；默认只预览 | 否（写 md） |
| `fetch-knowledge.mjs` | 拉取无许可的第三方资料到 `knowledge/` | 否（写 knowledge/） |

```bash
node scripts/check.mjs answer.md --target "原话"
node scripts/check.mjs --self-test
node scripts/data-locate.mjs
node scripts/import-stars.mjs --dry
node scripts/fetch-knowledge.mjs --list
```
