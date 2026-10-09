# dsh-peak-guard

> **梁文峰是谁？我只认识梁文谷！**
>
> 高峰计价时段，DSH 不许调模型。被拦下的那次调用**不产生任何费用**，
> 用户收到的是一句说明，以及一份「高峰期间拦下了哪些请求」的列表。

[English](README.en.md) · 中文

一个 DSH **宿主 + 客户端**插件。谷时（含周末与法定假期）什么都不做；高峰时段在
`llm/stream` 这个瀑布式事件上直接短路 —— **不调用 `next()`，所以一个字节都不会发往任何模型适配器**，
然后自己捏一段合法的分片流回去，于是那句说明就长在模型的回复位置上。

## 1. 装好之后是什么样

高峰期（默认北京时间 09:00–12:00、14:00–18:00 的工作日）你在 DSH 里发一句话，
模型的回复位置出现的是（默认**正经版**话术）：

```
⛔ 高峰时段暂停模型调用（本次未产生费用）

— 现在是 DeepSeek 高峰计价时段（北京时间 09:00–12:00、14:00–18:00），高峰单价约为谷时的 2 倍；本次调用没有产生费用。
谷时 18:00 开始（还有 3 小时 12 分），届时再发即可。
需要现在继续：`/peak off 30`（放行 30 分钟） · 查看状态：`/peak status`
```

想要最初那个彩蛋版（`现在是梁文峰时间，你马内不要了？胆子真是肥嘟嘟的`），
把配置里的 `tone` 设成 `joke`；也可以用 `message` 写任意自定义话术。
不想看下面那几行说明（只留第一句），把 `hint` 设成 `false`。

会话标题生成、上下文压缩这类「管家调用」**默认不拦** —— 拦了只会让标题变成那句说明、
让上下文压不动。真想「高峰期一个 token 都不发」，把 `blockUtilityCalls` 设成 `true`。

### 输入框那一带的两块 UI

**① 左边的盾牌开关**（插槽 `conversation.input.left`）——高峰保护总开关：

| 外观 | 含义 | 悬停提示 |
|---|---|---|
| 灰色盾牌 + 斜杠 | 开关关着 | 「点击打开：高峰时段不调用模型」 |
| 品牌色盾牌 + 对勾 | 开着，现在是谷时，待命中 | 「现在是谷时，模型调用放行；下一段高峰 09:00 开始（2 天 11 小时后）」 |
| 橙色盾牌 + 右上角橙点 | 开着，**现在正在拦** | 「现在是高峰，模型调用会被拦下；谷时 18:00 开始（还有 3 小时 12 分）」 |
| 左上角数字角标 | 被拦截列表里有 N 条（超过 99 显示 `99+`） | —— |

开关状态**落盘**（重启 DSH 后仍然记得），和 `/peak enable|disable` 是同一个状态。
宿主未就绪时它会呈现为灰色不可用态（提示「宿主半边未就绪」）—— 那说明插件代码改过但
**还没重启 DSH**，见下面 §3 的生效方式。

**② 输入框上方的「被拦截列表」卡片**（插槽 `conversation.input.dock` —— 和 DSH 那张「任务」卡同一个座位）
**只读记录 + 两个无害小动作**：高峰期间拦下了哪些请求，看得见、不动作（不排队、不重投、不打扰任何会话）。
只在有记录时出现：

```
⠿ 高峰期间有 2 条请求被拦下    这些请求没有发给模型，也没有产生费用          [ ˇ ] [ ✕ ]
  ● 把 README 里的截图换掉                                              09:52
  ⊘ 帮我看看这个报错                                                    09:41   ← 被关闭收起过的：空心环+斜杠
   ↑ ≤3 条默认展开（最新在前），>3 条默认折叠只留标题；点箭头展开/收起，点 ✕ 把没处理的收起
```

* **✕ 关闭**：卡片把「当时还没处理」的记录**交给宿主收起**（盖上「跳过」戳），并从此默认不再展示已办 ——
  于是卡片随即变空、自己消失；**之后新拦下的请求照旧会出现在卡片上**（关掉之后再勾的已办也仍留在卡上，
  直到下一次关闭）。
  想捞回来就去「拦截记录」页点一下那条的图标，它会恢复成正常待办。与折叠键共用同一套图标键样式
  （20×20、圆角、悬停底色），叉号是 **1.3px**（= DSH 自带的 `ICON_MEDIUM_STROKE`）圆头描边 SVG。
* **● → ✓ → ⊘ 三态勾选**：行首那颗图标有三种状态，**共用同一个 SVG**：
  **实心点**（正常待办）→ 点一下变**对勾**（已办，绿色，文字变淡划掉）→ 再点变回点；
  被「关闭」收起的显示为**空心圆环 + 一道斜杠**（琥珀色，含义是「关掉展示框时它还没被处理」），
  点一下**恢复成正常待办**（单向：没有手动改回跳过态的入口）。
  动画都在同一套描边里完成：圆环由同一个 `<circle>` 从实心撑开（`r` 3→3.7、`fill-opacity` 1→0、
  `stroke-opacity` 0→1，190ms `cubic-bezier(.2,.8,.2,1)`），对勾与斜杠各自用
  `stroke-dasharray` / `stroke-dashoffset`「画」出来 / 收回去（240ms / 220ms）；
  勾选是**乐观更新**（先动观感再发请求，失败回滚），点了不会有延迟感；
  `prefers-reduced-motion` 下自动关掉过渡。
* **卡片列什么**（纯函数 `cardItems(list, dismissedAtMs)`）：跳过的永不展示；已办则**按时间判** ——
  只有「**关掉那一刻之前**就已办」的才收起。所以**在卡片上勾「已办」不会让那行当场消失**，
  得再关一次卡片才会收起 —— 勾错了随时反悔。开关上那个角标数的就是「还等着处理」的条数。
* 三态都是**纯本地状态**：不影响任何拦截行为，但都会**落盘**
  （`POST /peak-guard/set` 的 `{check:{id,done}}` / `{restore:[id]}` / `{dismiss:true}`），重启后还在。

### 卡头那两枚图标键

* **两个图标键的 DOM 结构必须对称，且 SVG 要 `display:block`**：
  曾经折叠键外面多包了一层 `<span>`，而那条 span 的样式在一次 CSS 重写里被删掉 →
  inline SVG 按**文字基线**对齐，被顶高 **1.44px**（量截图才发现）。
  现在两边都是「按钮里直接装 SVG」，并有回归测试盯着。
* **整组的纵向位置由一个常量控制**：`CHEVRON_Y_SHIFT`（0.5px 一档，负值 = 上移），
  两个箭头方向共用同一段 y 区间，所以展开/收起切换时图标不会上下跳。
* **卡头三枚图标（lead / chevron / close）统一描边 `ICON_STROKE = 1.3`**（对齐 DSH 自带的
  `ICON_MEDIUM_STROKE`，官方那个 16px 关闭键就是 1.3）；列表里的对勾用 `CHECK_STROKE = 1.6` 略重一点。

### 设置 → 拦截记录（管理页）

除了输入框上方那张小卡片，插件还在 **DSH 设置**里注册了一整页「拦截记录」
（插槽 `settings.section`，注册形状照 `dsh-archived-chats`：`{id, order, label}`，
`label` 决定左侧导航文案）。页面结构对齐 DSH 自带设置页：

```
拦截记录  v1.0.0                              [ 全部标为已办 ]  [ 清空记录 ]
──────────────────────────────────────────────────────────────────────────
  全部 12      待办 6      已办 3      跳过 3
┌──────────────────────────────────────────────────────────────────────┐
│ 🔍 搜索请求内容或会话 id                                              │
└──────────────────────────────────────────────────────────────────────┘
⊘ 帮我看看这个报错                    09:41   a1b2c3d4        [⊘]  [🗑]   ← 跳过：点一下恢复为待办
● 把 README 里的截图换掉              09:52   e5f6a7b8        [✓]  [🗑]
…（没有记录时是收件箱图标 +「暂无拦截记录」空态）
```

* **标签页**：全部 / 待办 / 已办 / **跳过**，各带实时计数；**搜索**匹配请求原文与会话 id
  （大小写不敏感），与标签页叠加生效。「待办」只算正常待办，被展示框收起过的那些归到「跳过」。
* **每行**：三态图标键（实心点 ↔ 对勾 ↔ 空心环 + 斜杠，同一套 SVG 与描边动画；**跳过态点一下
  即恢复为正常待办，单向**）、请求原文（截断）、时间、会话尾号、删除键。
  操作都是即时反馈，失败会在页面上写明错误码。
* **批量**：「全部标为已办」走 `POST /peak-guard/set` 的 `{checkAll:true}`（一条请求，不是 N 条）；
  「清空记录」是**两步确认**（第一次点变成「确认清空？」，再点才真删），避免误触。
* **一次拉全量**：`GET /peak-guard/state?limit=200`（卡片用默认 20 条，设置页要 200）；
  超过 200 条时页面顶上一行说明「只显示了最新的 200 条」。
* 这个页面只跟插件自己的两个路由打交道，**不读任何会话数据**。

> 💡 **提示：在设置里把「跳过」改回「待办」之后，对话界面那张卡片可能要等一会儿才会显示它。**
> 改动是立刻落盘的，设置页也会顺手把新状态推给两边共用的那份内存状态，所以切回对话界面
> **通常立刻就能看到**；万一那张卡片还是旧样子（比如两个窗口各开着一份），最多等 **20 秒** ——
> 卡片每 20 秒轮询一次，窗口重新获得焦点时也会立刻刷新。

> **为什么没有「一键补发 / 谷时自动补发」**：做过一版，投递链路脆弱（要跨会话 resume + 排队 +
> 串行等待，还容易和用户手上的回合并发）且语义上自相矛盾 —— 这个插件的意义是"高峰期别烧钱"，
> 而"谷时替你自动发一遍"是在你不在场时替你花钱。**已整体砍掉**，相关路由、命令、依赖
> （`sessionController`）、界面控件、配置键全部删除。插件现在只做一件事：**拦下 + 记账 + 让你看见**。
> 之前的设计推演留在 [`docs/DESIGN-replay-tradeoffs.md`](docs/DESIGN-replay-tradeoffs.md) 里当记录。

**几何是照官方那张卡片的 CSS 抄的**（`aSus8q_*` 那组规则：`width/max-width` 用
`--dsh-composer-card-max-width` 与 `--dsh-composer-*` 那套 composer 变量、`border-radius: var(--dsw-radius-lg)`、
`background: var(--dsw-specific-menu)`、`box-shadow: var(--dsw-elevation-panel)`、`__body` 内边距 `6px 12px`、
列表 `gap:8px / max-height:180px / item 行高 20px`），所以它跟输入框**同宽、同一水平中线**，
不会自己长出另一种宽度或节奏。折叠箭头是 SVG 描边图标（16px 画布 / 1.6px 描边 / 圆头圆角 `currentColor`），
不是 `^` `ˇ` 字符 —— 字符的字形和粗细随字体走，跟官方那枚对不上。

三个不写就会"看起来不对"的细节（都有测试盯着）：

* **表头那格灰色说明永远渲染**（没内容时是空元素）。它是 `flex:auto` 的弹簧 ——
  少了它，折叠箭头就会贴在标题后面，而不会靠右。
* **圆角胶囊/圆点必须 `corner-shape:round`**：DSH 全局把圆角做成了 superellipse，
  不自带这行的话角标和提示点会被渲染成方圆角（自带组件就是这么写的）。
实现上的三条自我约束（照 DSH 官方插件开发 skill 的硬规矩）：

* **不 import 任何 DSH 自带的客户端包**（连 `@deepseek-ai/dsh-client-ui-primitives` 都不许），UI 全手写；
* **样式只用主题令牌** `--dsw-alias-*`，浅色/深色自动跟随 —— `test/client.test.mjs` 里有自动检查：
  CSS 里出现任何非 `--dsw-alias-` 的变量、或硬编码颜色，测试就判失败；
* 装样式 / 起定时器 / 挂监听器全在 `ctx.effect` 里（factory 阶段零副作用），随插件卸载回收；
  插槽注册失败只打日志，绝不连累输入区。两块 UI 共用**一份**轮询，不各打各的请求。

## 2. 判定口径（不是拍脑袋定的）

| 规则 | 值 |
|---|---|
| 高峰窗口 | 本地（默认 `Asia/Shanghai`）09:00–12:00、14:00–18:00，半开区间 `[start, end)` |
| 周末 | 本地周六/周日**全天谷价** |
| 法定假期 | 默认内置 2026 年中秋 + 国庆共 10 天，全天谷价（每年需更新一次） |

这套口径与 `dsh-cost-meter` 的峰谷计价**逐项一致**（那边的窗口来自 DeepSeek 控制台公告
并跟随官方页面同步）。`test/peak.test.mjs` 里有一段差分测试：从 2026-08-22T16:00Z 到
2027-03-01、每 7 分钟采一个点，逐点比对本插件的 `isPeak` 与 `dsh-cost-meter` 的
`isPeakHour`，另有 60 天、每 53 分钟一次的「下一个切换点」比对。**两边有一个点不一致，
测试就红。**

## 3. 安装

```powershell
pwsh -File install-profile.ps1            # 装进 desktop（默认）
pwsh -File install-profile.ps1 -WhatIf    # 只看要做什么，不落盘
pwsh -File install-profile.ps1 -Uninstall # 卸载
```

脚本做四件事：备份 profile 的 `package.json` → 加一条 `link:` 依赖 → 把包名追加进
`dsh.profile.bundles` → 在 profile 的 `node_modules` 下建 junction。做完会自校验
（依赖 / bundles / 链接 / 入口可达），任一项不过就以非零码退出并告诉你怎么用备份还原。

> `desktop` 是 Electron 保留 profile，命令行 `dsh plugin --profile desktop …` 会被
> 拒绝（"managed exclusively by the Electron application"），所以走脚本。

**生效方式（分两种，别混）**：

| 改了什么 | 怎么生效 |
|---|---|
| **profile 组合**（装/卸插件、`dsh.profile.bundles`、profile 的 `cordis.patch.yml`） | **就地热生效**。本机实测：脚本写完 profile 不到一秒，`include:peak-guard` 就是 `enabled + active` |
| **插件自己的代码**（`lib/*.js`、`package.json` 里的 `dsh.client`） | **必须完全退出并重开 DSH Desktop**。宿主模块是启动时 import 的，客户端产物也在启动时扫描一次（`dsh-hmr` 只 watch 配置文件，不管模块代码）—— 实测：改完代码后新增的 HTTP 路由与 `/plugins/dsh-peak-guard/client.js` 都还是 404，重启后才出现 |

## 4. 逃生门

被锁在门外还进不去，那就不是插件是牢房。所以留了这些路，任何一条都能把人捞出来：

| 逃生门 | 怎么用 | 生效范围 |
|---|---|---|
| 输入框左边那个开关 | 点一下（走 `fetch`，**不需要模型参与**） | 立刻，且落盘 |
| `/peak enable｜disable` | 等价于上面那个开关 | 立刻，且落盘 |
| `/peak off [分钟]` | 临时放行（命令走 `commands` 服务，不需要模型） | 运行时，最长到重启 |
| `/peak force` / `/peak on` | 现场强制拦 / 立刻收回 | 运行时 |
| `allowSessions` | 配置里写 session id 白名单 | 直到改配置 |
| `DSH_PEAK_GUARD=off` | 启动 DSH 前设环境变量（`0/off/false/no/disable` 都算关） | 整进程，重启前一直有效 |

`/peak` 的全部子命令：

```
/peak                     看当前峰谷状态、窗口、拦截计数、话术与被拦截列表
/peak test                不下发请求，先看看提示语长什么样（dry-run）
/peak force [分钟]        无视峰谷强制拦一段时间（默认 5 分钟）—— 用来现场验收
/peak enable|disable      高峰保护总开关（和输入框左边那个开关同一个状态，会落盘）
/peak off [分钟|forever]  临时放行（默认 30 分钟；forever = 放行到重启）
/peak on                  立刻恢复拦截（同时收回 force / off）
/peak list                列出高峰期间被拦下的请求（只是记录，插件不会替它们重投）
```

## 5. 配置

配置在 profile 的 `cordis.patch.yml`（`id: peak-guard`）；插件包自带一份带注释的
`cordis.patch.yml`，随 bundle 一起生效。改了配置同样要重开 DSH。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 高峰保护**默认值**；界面开关一旦点过就以开关为准（开关落盘） |
| `timeZone` | `Asia/Shanghai` | 「本地钟点」按哪个时区算 |
| `peakWindows` | `["09:00-12:00","14:00-18:00"]` | 高峰窗口，半开区间，支持跨午夜；`[]` = 永不拦截 |
| `weekendsOffPeak` | `true` | 周末全天谷价 |
| `holidays` | 2026 中秋+国庆 10 天 | `YYYY-MM-DD`，或区间 `A..B` |
| `tone` | `polite` | 内置话术：`polite`（正经）/ `joke`（彩蛋） |
| `message` | 不写 | 自定义话术，**盖过 `tone`** |
| `hint` | `true` | 是否补几行「几点转谷时 / 怎么硬闯」 |
| `blockUtilityCalls` | `false` | 是否连会话标题/压缩也拦 |
| `allowSessions` | `[]` | 白名单 session id |
| `snoozeMinutes` | `30` | `/peak off` 不带参数时的默认放行分钟数 |
| `blockedLimit` | `50` | 被拦截列表最多记多少条（1–200） |
| `blockedMaxAgeMinutes` | `720` | 记录最大存活分钟数，超过丢弃（12 小时） |
| `statePath` | 不写 = `<DSH_HOME>/plugin-data/dsh-peak-guard/state.json` | 开关与列表的落盘位置；显式写 `""` = 不落盘 |

配置写坏了不会让 DSH 起不来：类型不对的键被丢弃、退回默认值，并在 DSH 日志里留一条告警
（`normalizeConfig` 永不抛错）。

## 6. 测试

```powershell
```powershell
node test/peak.test.mjs     # 20 项：解析/边界/周末假期/坏配置/话术三态 + 与 dsh-cost-meter 的差分
node test/blocked.test.mjs  # 13 项：被拦截列表纯逻辑（预览抽取、去重、上限、过期、净化、勾选、摘要）
node test/plugin.test.mjs   # 34 项：假 ctx 起的宿主集成（短路、放行、命令、HTTP 路由、落盘、列表记录、老状态迁移、fail-open）
node test/client.test.mjs   # 49 项：客户端离线验收（模块形态、插槽注册、令牌、文案、卡片、箭头、关闭、勾选落盘、设置页、fail-open）
node test/patch.test.mjs    # 用 DSH 自己那份 js-yaml 解析 cordis.patch.yml，并把 config 过一遍归一化
```

合计 **116 项断言**，五套 exit 0 才算过。

`plugin.test.mjs` 用一个最小 cordis 替身把插件真的 `apply` 起来，然后像 DSH 那样
dispatch `llm/stream`，断言的是：

* 高峰时 `next()` **调用次数为 0**（= 真适配器没被碰过）；
* 吐出去的分片逐个都在 `StreamChunk` 联合类型里，且能按 `BlockAssembler` 的语义组装成
  一条 `{type:'text'}` 消息，内容**逐字等于**那句话，`usage` 在 `finish` 之前；
* 谷时 / `enabled=false` / `purpose` 管家调用 / 白名单 / `DSH_PEAK_GUARD=off` / `/peak off`
  六条路径都真的走回真模型；
* 畸形输入（`options=null`、getter 抛错、`next` 不是函数、垃圾 config、没有 `logger` 的 ctx）
  **一律不抛错**，该放行的放行 —— fail-open，插件坏了不能把 DSH 弄死。

本机跑测试用的 node 是 DSH 自带的那份：
`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

## 7. 实现要点（给下一个改它的人）

```
lib/peak.js    纯逻辑：解析窗口/时区、isPeak、nextTransition、话术。零 import，可单跑。
lib/http.js    界面通路：两条同源 JSON 路由的处理与防 CSRF 闸门。零 import，可用假 req/res 测。
lib/store.js   开关状态落盘：<DSH_HOME>/plugin-data/dsh-peak-guard/state.json，原子替换、永不抛错。
lib/index.js   胶水：apply(ctx, config) 里挂 llm/stream 监听器 + 注册 /peak 命令 + 注册路由。
lib/client.js  客户端半边：输入框左边那个开关（浏览器里跑，只 require('react')）。
cordis.patch.yml  随包配置（改口径就改它）。
```

* **拦截点**：`ctx.on('llm/stream', (options, next) => …)`。这个事件是瀑布式的，
  `LlmRuntime.streamWithRegistration()` 里 `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`，
  返回自己的 `AsyncIterable<StreamChunk>` 就等于从上游把真适配器整个掐掉。
* **分片协议**：`block-start` → `text-delta` → `block-end` → `usage` → `finish({kind:'stop'})`。
  `BlockAssembler` 容忍只有增量的流，但补齐 block-start/end 更干净。
* **`options` 是深冻结的**：loop 构建的请求不可改写，所以这里只读、不改。
* **不写会话日志**：拦下的调用没有产生任何模型可见输入，因此不存在「模型可见 ⟺ 已记录」
  的破坏；那次助手回复会以 0 token 记账。
* **fail-open**：`decide()` 和整条监听器都包在 try/catch 里，任何异常都退回 `next()`。
  `apply()` 整体 try/catch，最坏情况是插件静默不生效。
* **`/peak` 必须走 `ctx.inject(['commands'], …)` 注册**（踩过的坑，别改回去）：直接写
  `ctx.commands.register(...)` 时，如果 `apply` 跑得比 `commands` 服务 provide 早，`ctx.commands`
  是 `undefined`，命令就**静默不存在**。后果不是报错，而是 —— 你在输入框里打 `/peak test`，
  客户端在本地命令目录里查不到这个名字（`dsh-client-ui-commands` 的 `matchEnter`：
  `desc === undefined → return void 0`），于是**把它当成一句普通消息发给了模型**。
  挂钩 `commands/change` 的 UI 刷新只会在「宿主真的注册了」之后才生效，救不了这种情况。
* **永远不要直接读 `ctx.<服务名>`**（踩过两次的坑，`commands` 一次、`sessionController` 一次）：
  cordis 对未 inject 的服务访问是**抛错**（`cannot get property "X" without inject`），
  指望 `try { ctx.x } catch { ctx.get('x') }` 兜底也不行 —— catch 会把 `ctx.get` 那条路一起短路。
  统一走 `ctx.inject(['x'], (scope) => { ref = scope.x })`，服务就绪时把引用交进来；
  再退回契约里给可选依赖用的 `ctx.get("x")`。表现层的症状很误导：宿主回了
  `no-session-controller`（HTTP 409），看起来像服务不存在，其实是没 inject。
  （那条用到它的补发链路后来整体砍掉了，但这条教训留着 —— 本插件仍然要 inject
  `commands` 与 `webServer`。）
* **界面通路同理走 `ctx.inject(['webServer'], …)`**：`webServer` 在契约里是可选服务
  （`ctx.get("webServer")` 需要判 undefined），晚到就晚注册；永远缺席也只是没有界面开关。
* **开关与相位解耦**：`isPeak()` 是纯时间函数（不看开关），「要不要拦」由宿主半边的
  `effectiveEnabled()` 决定。否则界面开关一旦覆盖 `config.enabled`，相位显示会跟着失真。
* **开关落盘**：`<DSH_HOME>/plugin-data/<包名>/state.json`，先写 `.tmp` 再 rename；
* **被拦截列表的投递接口**（**已删除**，留作记录）：曾经用宿主服务
  `sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})`
  往任意会话补投一句提示。它本身可用，但整条链路（跨会话 resume、串行等待、跳过运行中会话、
  失败重试）复杂度远超收益，且"谷时替你自动发"与"高峰期别烧钱"自相矛盾 —— 现已整体移除，
  插件不再依赖 `sessionController`，也不再发任何写请求。
* **被拦截列表的三条不变式**（`lib/blocked.js`）：**不重**（同会话同内容 60 秒内只记一条）、
  **有界**（条数上限 + 最大存活时长，坏数据一律丢弃）、**只读**（模块零依赖零副作用；
  给界面的是「最新在前 + 总数 + 截断标记」）。
* **老状态文件兼容**：上一版把列表存在 `queue` 键下，`sanitizeState` 读到就搬进 `list`，
  不会让用户已经攒下的记录凭空消失（有测试盯着）。

### 为什么这条路真的通（源码级核对，不是猜的）

* `LlmRuntime.prepareCall()` 返回的 `PreparedLlmCall.stream(options)`，内部第一件事就是
  `this.streamWithRegistration(options, …)`；而 `streamWithRegistration` 的实现正是
  `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`。agent loop 用的就是这条路
  （`dsh-agent-loop/lib/index.js`：`preparedCall?.stream(request) ?? loopCtx.llm.stream(request)`）
  —— **必经本插件**。
* loop 拿到流后逐片 `AssistantStreamAttempt.push()` → `AssistantStreamAccumulator`（严格校验：
  `time` 安全整数、chunk 可无损 JSON 化、`text-delta` 的 `index`/`text` 类型）→ `BlockAssembler`；
  本插件吐的五条分片逐条满足这些校验（`block-start`/`block-end`/`usage`/`finish` 按不透明
  chunk 记录，`text-delta` 的 index=0、text 为字符串）。
* 收尾：`finish.kind === 'stop'`、块里没有 `tool-call` → loop 落一条带 usage 的
  `assistant/message` 并 `return { kind: 'completed' }` 结束本步。于是那句话就长在助手气泡里，
  且**没有任何字节离开本机**。

## 8. 已知边界

* 假期表是**年抛型**数据：每年国务院安排公布后要更新 `holidays`（也顺手更新
  `dsh-cost-meter` 的 `DEFAULT_PEAK_HOLIDAYS`，保持两边一致，差分测试才继续绿）。
* `nextTransition()` 用「先按小时粗扫、再在小时内按分钟定位」，对小时级窗口是精确的；
  若把窗口配成 15 分钟级的碎片窗口，理论上可能漏掉同小时内的多次切换（默认配置不受影响）。
* **两块 UI 都没有做浏览器端的视觉验收**：开发时浏览器扩展桥没连上，所以「它们长什么样、
  在浅色/深色下读起来对不对、气泡和弹窗有没有被裁剪」是靠离线测试（模块形态、插槽注册、
  主题令牌白名单、状态→文案映射、元素树渲染、弹窗结构与按钮行为）加人工读码得到的，
  **不等于你已经看到它**。刷新页面确认过一次之后，这条限制才算解除。
* 客户端文案按 `navigator.language` 在中/英两套里挑，**没有走 DSH 的 locale 服务** ——
  故意如此：多声明一个可能缺席的服务会让 fiber 停在 PENDING，代价（整块控件消失）大于收益。
  要做正规本地化，再补 `dsh.client.inject` + locale 文案包。
* **被拦截列表只记「带 sessionId 的对话请求」**：管家调用（标题/压缩）本来就不拦，
  没有 sessionId 的手搓调用也归不到具体会话，所以列表里不会出现它们。
* **列表是「拦下了什么」的证据，不是「可以补答的任务」**：插件不会替你重投。
  真想继续那条请求，请自己把话重发一遍 —— 这也是我们砍掉自动补发的原因之一。

## 9. 仓库结构

```
dsh-peak-guard/
├─ README.md / README.en.md   中文（本文）/ English
├─ CHANGELOG.md               版本记录
├─ LICENSE                    MIT
├─ package.json               含 dsh.bundle.patch 与 dsh.client 声明（零运行时依赖）
├─ cordis.patch.yml           随包配置：装进 profile 后这一行就生效
├─ publish.cmd / publish.ps1  一键发布：提交 + 推送 + 打 tag（可选自动建仓、设 topics）
├─ install.cmd / install-profile.ps1   Windows 一键装进 desktop profile（可 -WhatIf / -Uninstall）
├─ lib/
│  ├─ index.js    宿主半边：llm/stream 短路、命令、HTTP 路由、状态落盘
│  ├─ peak.js     纯逻辑：峰谷判定、窗口/假期解析、话术（无副作用，可单独跑）
│  ├─ blocked.js  纯逻辑：被拦截列表（不重 / 有界 / 只读）
│  ├─ store.js    极小的 JSON 状态文件（原子替换、坏数据不抛错）
│  ├─ http.js     两个同源 JSON 路由 + 两道写闸（自定义头 + 同源）
│  └─ client.js   客户端半边：开关、卡片、设置页（零依赖，只用主题令牌）
├─ test/          五套断言，`npm test` 全绿（116 项）
├─ docs/DESIGN-replay-tradeoffs.md    被砍掉的「谷时补发」设计推演（留档）
├─ docs/PUBLISHING.md                 发布到 GitHub / 上架 dsh-market 的完整步骤
└─ docs/awesome-dsh-plugin-entry.yml  上架精选列表用的条目（去掉注释即可提交）
```

零运行时依赖（Windows 与 Node 内置模块除外），不需要 `npm install` 就能跑测试。

## 10. 许可

[MIT](LICENSE)。

