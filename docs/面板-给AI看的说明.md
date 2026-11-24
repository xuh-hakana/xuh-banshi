# 虚幻客户端 · 面板功能说明（给 AI 看）

> 面向接手改代码的 AI，不是给主人看的使用手册。
> 基准版本：2026-11-16。文中行号以该版本 `app/renderer/app.js` 为准，与代码冲突时以代码为准。
> 需求原文出处：`ticiqi/workbuddy记忆区/本轮任务-原话.md`（2026-11-14 四条 + 11-15 一句 + 11-16 六句补充）。
> 本文件描述的是**已实现的系统**，不含待办清单。原始需求不得简化执行：逐字拆「触发 → 结果 → 落点」，改前逐条列出，改完逐条对回。

---

## 0. 系统边界

| 项 | 值 |
|---|---|
| 形态 | Electron 自绘桌面应用，渲染层原生 JS 拼字符串；无 Vue、无打包器、无第三方 UI 库 |
| 启动链 | `app/main.js` 开窗 → `app/renderer/index.html` → `app.js`（约 7460 行，单文件） |
| 后端 | `src/server/panel.js` 本地 HTTP；渲染层统一 `window.xuh.api(method, path, body)` |
| 老网页面板 | `public/panel-*`（8899 端口）已弃用，只作实现参考；**不要往里加按钮** |
| 界面层禁区 | 不碰 `src/` 的提示词与模型链，不新增提示词、不新增 token |

---

## 1. 文件分工（改哪个）

| 文件 | 管什么 | 注意 |
|---|---|---|
| `app/renderer/index.html` | 骨架：左栏 17 项、四段标题、热区、小标、二级浮层、顶栏、状态栏、悬浮工具坞 | 导航项写死在这里；`data-view` 是路由键，`data-rail` 是入口类别，`data-panel` 是接管面板键 |
| `app/renderer/app.js` | 全部行为：状态 `S`、数据拉取、各页 HTML、点击分发、左栏开合、主页面板、拖柄 | 函数名带 `html*` 的返回字符串；点击统一走 `document` 上的 `[data-act]` 分发 |
| `app/renderer/app.css` | 白天视觉 + 骨架 + 左栏/二级菜单 + 浮窗系统 + 动画 + 接管面板 | 变量在 `:root`；新增组件必须同步补夜间 |
| `app/renderer/night.css` | 夜晚配色，同骨架只换色 + 雨夜玻璃 | 一律 `html[data-theme="night"]` 前缀 |
| `app/renderer/skins/qq/skin.css` | 聊天记录页 QQ 气泡皮肤（可插拔） | 写死浅色，夜间映射在 `night.css` 末尾；含 `--conv-w` 网格与真头像多层背景 |
| `public/sticker-page.css` / `emobook-page.css` | 表情包页 / 情绪书页共用样式 | 客户端覆盖写在 `app.css` 的 `sp-scope` 段 |

---

## 2. 主页模型（最要紧，别改回平级页）

**「聊天记录」是主页（常驻基底画布），不是「默认选中的那一页」。** 判据：

| 主页 | 默认页 |
|---|---|
| 一直在，别的内容叠在它上面或取代它的某一块 | 13 个平级视图里 `S.tab` 初值取谁 |
| 左栏选择不切 `S.tab`，只换画布内容与小标 | 左栏选择 `go(view)` 换整页 |
| `home-panel` 取代的是**左侧人物列表**，右侧消息区不动 | 整屏 `view.innerHTML` 换掉 |

实现落点：

- `app.js:18` `S.tab = 'chat'`；`S.home` 存主页状态。
- `app.js:7028` `railHoverSelect()` **不调 `go()`**，只设 `S.home.sel`、切 `.nav-item.is-on`、改标题、在 `S.tab === 'chat'` 时 `render()`。切页就等于把主页降级成默认页。
- `app.js:297` `go(tab)` 只被 `homeDrill()` / `homeBack()` 调用：点「打开这一页看全部」才进老平级页，顶栏出现 `← 主页`（`#homeBack`），点它回 `chat`。
- `app.js:7449` 启动顺序固定为 `loadSkin() → railInit() → paramInit() → go(S.tab) → loadSnapshot()`。
  `go()` 必须早于快照：聊天数据是 `go()` 里的 `loadChat()` 懒加载，顺序颠倒会永远停在「读出聊天记录中…」。

---

## 3. 左栏

### 3.1 四段 17 项（`index.html:34-107`）

| 段 | `data-rail` | 项数 | 内容 | 点击结果 |
|---|---|---|---|---|
| 分级 · 单人 / 群 / 平台 | `level` | 6 | 聊天记录、记录的、朋友录、B站、提醒、学习 | `homeOpenPanel('topic', {level:[名称]})`，二级菜单走多级下钻 |
| 汇总 · 也能分开显示 | `both` | 5 | 约定、话题、情绪表、表情包、写入日志 | `HOME_PANELS` 中 `cls:'both'`，面板给「汇总 / 分开显示」两模式 |
| 只有汇总 | `sum` | 5 | 查词典、命令方块、人设编辑、需求记录、机器人 | `cls:'sum'`，面板只写「只有汇总显示」，不给分开模式 |
| 收纳 | `settings` | 1 | 被移动的全部 | `htmlHomeSettings()` 列出前 10 项 + 3 个总开关 |

不含单人/群/平台分级的内容全部收在 `收纳` 一处，不在左栏平铺。

### 3.2 默认态与动画

- 默认**没有左栏**；窗口左边缘 12px 感应区 `#railHot`（`index.html:120`），`mouseenter` / `click` → `railOpen()`（`app.js:6992`）。
- `.rail` 是 `fixed` 浮层，`.is-open` 弹性滑出；`--ease-pop` + `nav-bubble-in` 逐项入场（`--i` 索引 × 22ms）。
- `animation-fill-mode` 用 `backwards` 不用 `both`：用 `both` 时首帧/无头截图动画未执行会停在透明起始态，整栏看似空白。
- 移开 `railClose(320)` 收起；`mouseleave` **只排延迟**，不立刻 `railFlyHide()`（`app.js:7339`）——立即隐藏会让二级目录永远点不到。
- `.rail-fly[hidden] { display:none!important }` 必须保留：CSS 里 `.rail-fly { display:flex }` 会盖掉 UA 的 `[hidden]`。

### 3.3 碰即选中 + 小标

- 鼠标进 `.nav-item` 即选中（去抖 90ms，`railHoverSelect`），同时 `railFlyShow()` 展开二级菜单。
- 收起后选中项在窗口左边缘留 `#railTick`：3px 竖条，`position:fixed`，**不占布局**（`app.js:6982 railTickTo()` 按 `offsetTop` 算位置，切页/缩放/开合都重算）。
- 顶部选项卡的小图标 `⋯` 在 `S.home.sel` 非空时也有一个同语义的选中点（`.chip-fold[data-sel="1"]`）。

### 3.4 二级浮层与多级下钻

- `#railFly`（`index.html:123`），`left:216px` 贴住左栏右缘，避免 14px 接缝让鼠标中途 `mouseleave`。
- 层级由 `RAIL.level`（数组）驱动，面包屑 = `TITLES[view] · level[0] · level[1] …`，不封顶：

| 级 | `railLevelItems()` 分支 | 例 |
|---|---|---|
| 0 | 全部 + 真实会话（单人 / 群 / 平台三组）+ `RAIL_CATS` 分类 | 聊天记录 › 全部 / 主人 / 院里的猫窝 / 按内容：约定 |
| 1 | `railDirsOf(cat)` | 记录的 · 约定 › 说话方式 / 条件明确 / 其他 |
| 2 | `railLeavesOf(cat, dir)` | 记录的 · 约定 · 说话方式 › 具体条目 |
| 3 | `railFieldsOf(RAIL.pickedId)` | 触发 / 原文 / 时间 |
| 4+ | `railFieldsOf()` | 同上，结构不封顶 |

- `railDirsOf('约定')`（`app.js:7058`）**固定给「说话方式 / 条件明确 / 其他」三项，0 条也列**。按现有数据统计的话，某类为空时「记录的 · 约定 · 说话方式」这条路径会整条消失。
- `pactKindOf(x)`（`app.js:1304`）不读 `x.kind`：靠 `x.sig`、`x.text` 里的口癖关键词、`x.say`/`x.when` 判 `style` / `scene` / `note`。造测试数据别只写 `kind:'style'`。
- 上一级：`data-act="rail-back"` → `RAIL.level.pop()` → 重画。
- 点头像：`data-act="rail-person"` → `homeOpenPanel('pact', {level:[…], splitKey, conv})`。

### 3.5 头像

- 会话列表 `convAvatar()`（`app.js:3041`）和消息气泡都放 `<img class="conv-av__img" src="xuh://avatar/<plat>/<id>">`；群用 `xuh://avatar/group/<gid>`。
- 只往 style 写 `--conv-avatar` 无效——以前就是这样把头像弄丢的，CSS 根本没引用那个变量。
- 加载失败由 `app.js:7440` 的全局捕获 `error` 监听摘掉 `<img>`（CSP `script-src 'self'` 禁内联 `onerror`），底下首字方块照常显示。
- `skin.css` / `night.css` 用多层 `background`：真图在最上层，底下是人形剪影 + 身份色，夜间换深墨莓色，不会剩空白紫方块。

---

## 4. 接管面板

### 4.1 状态与配置

- `S.home`（`app.js:18`）：`panel / cls / mode / level / sel / conv / splitKey / convW / from / settings`。
- `HOME_PANELS`（`app.js:7182`）：12 项，每项 `{ label, view, cls, sum }`。`cls` 只有 `both` / `sum` 两种。
- `homeOpenPanel(id, o)`（`app.js:7196`）：设状态 → 在 `chat` 页 `render()`，非 `chat` 页 `go('chat')` → **补拉缺失的 `S.pacts` / `S.review` 并在到货后重绘**（否则首次直接点汇总入口会停在「0 条」）→ `railTickTo()`。
- `homeClose()`（`app.js:7213`）清状态并 `render()`，**恢复原本的人物列表主视图**。

### 4.2 取代关系

`htmlChat()`（`app.js:3105`）里 `convBar = S.home.panel ? htmlHomePanel() : <aside class="chat-convs">…`。
被取代的只有左侧会话列表；右侧消息区、顶部搜索、悬浮窗、状态栏都不动。

### 4.3 两类模式

| `cls` | 面板头 | 内容 |
|---|---|---|
| `both` | 「汇总 / 分开显示」两个 tab | 汇总：`htmlHomePactSum()` / `htmlHomeTopicSum()` / `htmlHomeEmotion()` / `htmlHomeStub()`；分开：`htmlHomeSplit()` 按单人 / 群 / 平台列真实会话，点一条 `home-split-pick` 切到该会话 |
| `sum` | 只有「只有汇总显示」一行 | `htmlHomeStub()`：条数 + 一句说明 + 「打开这一页看全部」 |

- `htmlHomeSettings()`（`app.js:7277`）列出被移动的 10 项，每项标「汇总 + 分开」或「只有汇总」，底部 3 个总开关：`chat-reply-toggle`（回复总开关）、`chat-show-set`（显示设置）、`chat-fb-open`（兜底词池）。
- 面板体为空时 `htmlHomePanel()` 给 `home-empty` 兜底，不留纯白空白。

---

## 5. 聊天主页内部

| 块 | 落点 | 行为 |
|---|---|---|
| 会话 / 消息两栏可调 | `.chat-wrap` 网格 `var(--conv-w,250px) 6px minmax(0,1fr)`（`skin.css`）+ `.chat-split` 拖柄 + `chatSplitInit()`（`app.js:7414`） | 拖 180–520px，写 `localStorage['xuh.chat.convW']`，下次打开保留 |
| 顶部选项卡 | `.chip-fold`（`app.js:3178`，`app.css:1945`） | 12 个 chip 一个不删，默认折成 `⋯` 小图标；`:hover` / `:focus-within` 才展开；**选择后不摊开整排**，选中内容由接管面板 / 对应栏直接显示，小图标上留一个点 |
| 汇总条目改跳转 | `jump-all` 按钮（`htmlChatPacts` `app.js:2711`、`htmlChatTopics` `app.js:2880` / `2897`） | 「◈ 共 N 条相关 · 碰一下看全部」→ `home-panel` 打开接管面板看全部；不再有「只显示 5 条」 |
| 约定两个功能都留 | `htmlChatPacts()`（`app.js:2682`） | `jump-all`（碰一下看全部）+ `chat-pact-head`（本会话关联显示，点开列卡片）。只留一个会丢功能 |
| 悬浮窗 | `htmlChatDock()`（`app.js:747`） | 只有 3 个 tab：`当前提示词` / `AI 思考` / `AI 状态`。话题 / 约定 / 情绪表等汇总性质一律不在悬浮窗，移到左栏入口或接管面板；工具坞里原「情绪表」入口 `#fabReply` 已删 |

---

## 6. 状态栏

- 左侧 `#status-left` **只显示模型名**，不显示主人账号（`app.js:200`）。右侧数据时间。
- 中间 `paintStatus()`（`app.js:216`）按 `GET /api/status` 生成，最多 9 条，每条可点：
  连接 / 正在想 / 暂停中 / 自动同意 / 回话权 / 待确认口味 / 喜好重合 / 好感（满·喜欢）/ 自查。
  条数为 0 或 false 的不显示，不是漏搬。
- 「自动同意」= 热加载自动同意（加好友 / 被拉进群），不是「加群」。`acceptOpen()` → `GET /api/accept` → `htmlAcceptCard()`（`app.js:391`）倒序列出每条。
- 每条 `.acc-row.is-link` 带 `data-act="accept-jump"` → `acceptJump()`（`app.js:376`）按 `gid` / `uid` 切到对应聊天记录，`S.accept.jump++` 计数并提示第几次跳转；**有几条就能跳几次**。
- `✓`（`accept-read`）只清零未看数，不删记录。

---

## 7. 昼夜两套

- 同一套骨架、圆角、间距、字号，只换颜色 + 动效情绪。白天奶油草莓，夜里深莓霓虹。
- 开关 `html[data-theme]`，6:00–17:59 自动白天，手动切只在本会话生效。
- **新增组件必须同时补 `night.css`**，否则出现白底白字。已补：`.rail` / `.nav-item` / `.rail-foot` / `.rail-fly` / `.home-panel` / `.chip-fold` / `.chat-split` / `.jump-all` / `.conv-av__img` / `.msgs:has()` 全套 QQ 皮肤映射。
- `.chip-fold[data-sel="1"]` 的选中态在夜间另写一条，否则被普通态 `.chip-fold__icon` 的更高特异性盖掉。
- 夜里界面半透明，雨（`rain-night.js` + `raindrop-fx.js`）在界面之下。

---

## 8. 数据源与接口对照（易踩）

| 用途 | 真实接口 | 落到 | 坑 |
|---|---|---|---|
| 聊天记录 | `GET /api/chat` | `loadChat()` → `S.chat` | 懒加载，必须 `go('chat')` 触发 |
| 约定 | `GET /api/topic?view=promise&limit=500` | `loadPacts()` `app.js:1270` → `S.pacts.list` | **不是 `/api/pacts`**。2026-11-16 假后端造错路径，约定面板恒显示「0 条约定」，排查时别去改产品代码 |
| 话题 / 复核 | `GET /api/review` | `loadReview()` `app.js:1968` → `S.review.list` | 话题卡要 `rkind:'topic'`、`state!=='dropped'`、`!parent` |
| 状态 | `GET /api/status` | `loadStatus()` → `paintStatus()` | |
| 自动同意 | `GET /api/accept` / `POST /api/accept-read` | `acceptOpen()` / `htmlAcceptCard()` | |
| 情绪书 | `GET /api/emobook` | `loadEmobook()` → `S.chat.emoBook` | |
| 会话显示设置 | `GET /api/conv/state` | `loadConvState()` | |

`loadChat()` 内部串行 `loadIssues() → loadEmobook() → loadPacts() → loadReview() → buildPactLinks()`；`buildPactLinks()` 靠 `scope/qq` + 时间反推「哪条消息生成了哪条约定」，UI 标「📜约」时说明是推断，不冒充 100% 准。

---

## 9. 改动硬规矩

1. **不丢功能**：改前把会碰到的每条「触发 → 结果 → 文件:行」列全，改完逐条核对；少一条算乱删，不提交。
2. **新功能需求不许简化后执行**：逐字拆「触发 → 结果 → 落点」全清单，层级 / 分级 / 动画 / 范围一条不落。把整块排版重做压成「改默认页 + 补几个控件」= 整个需求全没做。
3. **不新增提示词、不新增 token**：界面层不碰 `src/` 提示词与模型链。
4. **同类只有一个入口**：同一功能不在左栏、工具坞、页面内各放一个。
5. **颜色走 `var(--*)`**：不写第二套写死配色；按钮类文字不参与选中，正文可选中可复制。
6. **主页常驻**：左栏选择不切 `S.tab`；只有「打开这一页看全部」才 `go()`，并留 `← 主页`。
7. **造文件必须真被读写**，无用则删；同功能并进老处，不建平行文件。

---

## 10. 验证方式

- 语法：`node --check app/renderer/app.js`。
- 视觉：临时预览页注入假后端，用 headless Chrome 按 query 打开指定状态、真截图后肉眼验收。
  预览需 `classList.remove('boot-hold')`，并注入 `*{transition:none!important;animation:none!important}`——无头截图会冻在动画起始态，否则界面看似空白。
- 必验状态：白天/夜间 × 主页 / 左栏展开 / 二级目录 / 约定面板 / 收纳面板 / 只有汇总 / 自动同意浮层 / 拖柄宽度。
- 验收基准是「逐条对回需求原话」，不是「内部测通」；真 QQ / 客户端重启要主人本人跑。
- 临时预览文件验完即删，不留摆设。
