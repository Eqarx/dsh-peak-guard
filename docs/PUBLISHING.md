# 发布到 GitHub 与上架 dsh-market

这份文档记录**发布这个插件**要做的每一步，以及 dsh-market 的收录规则（我读过
`dshmarket` 的源码与精选列表的 contributing 指南，规则如下，不是猜的）。

---

## 0. 先搞清楚「收录」是怎么发生的

```
你的 GitHub 仓库  ──① 提 PR 加一个 YAML──▶  awesome-dsh-plugin/awesome-dsh-plugin
                                              │  CI 每日构建
                                              ▼
                                    awesome-dsh-plugin.com/plugins.json
                                              │  dshmarket 每次打开实时拉取
                                              ▼
                                     DSH 设置 → 插件市场里的卡片
```

* **dsh-market 本身不是目录**，它只负责拉 `plugins.json` 并渲染。
* **所以打 topic 不会自动收录** —— 收录靠的是往精选列表提 PR。「自动」的部分是：
  合并后网站每天重建，市场打开即最新，不需要你更新任何东西。
* **但 `dsh-plugin` topic 是收录的硬性要求**：精选列表的 contributing 明确列了
  「为仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic」这一条，
  CI 会检查。所以两者都要做。

---

## 1. 建仓库并推上去

```powershell
cd "C:\Users\Eqarx\Documents\deepseek-harness\default-workspace\2026-10-09_2141_DSH高峰期拦截插件\plugins\dsh-peak-guard"

# 身份只需配一次（填你自己的）
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@example.com"

# 文件已经 git add 过了
git commit -m "feat: dsh-peak-guard 1.0.0 — 高峰时段拦下模型调用并记录被拦请求"

# 去 https://github.com/new 建一个空仓库（名字 dsh-peak-guard，不要勾 README/.gitignore/License）
git remote add origin https://github.com/<你的用户名>/dsh-peak-guard.git
git push -u origin main
```

推送用 **Personal Access Token**（GitHub 已不接受密码）：Settings → Developer settings →
Personal access tokens，勾 `repo` 即可。

## 2. 打版本 tag（GitHub 上会生成 Release 页）

```powershell
git tag -a v1.0.0 -m "dsh-peak-guard 1.0.0"
git push origin v1.0.0
```

> 这个插件**零依赖、无构建步骤**，源码安装即可用，所以**不需要** npm 包，也**不需要**
> 往 Release 挂预构建 tarball（精选列表的 `tarball:` 字段是可选的）。

## 3. 给仓库加 topics（**收录的必需项**）

`dsh-plugin` 必须有；其余是我建议的，方便被人搜到：

```
dsh-plugin  dsh  deepseek-harness  dsh-plugin-market  peak-hour  off-peak  cost-control  cordis
```

三种加法，任选：

**A. 网页（最省事）** —— 仓库首页右上角 `⚙️ About` → `Topics` → 逐个填 → Save。

**B. API（一条命令，把 `<TOKEN>` 换成你的 token）**

```powershell
curl.exe -X PUT `
  -H "Authorization: Bearer <TOKEN>" `
  -H "Accept: application/vnd.github+json" `
  -d '{\"names\":[\"dsh-plugin\",\"dsh\",\"deepseek-harness\",\"peak-hour\",\"off-peak\",\"cost-control\",\"cordis\"]}' `
  https://api.github.com/repos/<你的用户名>/dsh-peak-guard/topics
```

**C. GitHub CLI**（这台机器没装 `gh`；装了的话 `gh repo edit --add-topic dsh-plugin,dsh ...`）

验证：`curl.exe -H "Accept: application/vnd.github+json" https://api.github.com/repos/<你的用户名>/dsh-peak-guard/topics`

## 4. 上架 dsh-market：往精选列表提一个 PR

**只加一个文件**：`data/plugins/<owner>__<repo>.yml`（文件名是「owner + 双下划线 + repo」）。
现成内容见 [`awesome-dsh-plugin-entry.yml`](awesome-dsh-plugin-entry.yml)，把两处
`YOUR-GITHUB-USERNAME` 换掉即可：

```yaml
url: https://github.com/YOUR-GITHUB-USERNAME/dsh-peak-guard
name: YOUR-GITHUB-USERNAME/dsh-peak-guard
category: usage
description:
  en: Blocks every model call during DeepSeek's peak pricing windows before any bytes leave the machine, answers in the model's place, and keeps a searchable record of what it blocked.
  zh: DeepSeek 高峰计价时段直接拦下模型调用（一个字节都不发出去），替模型回一句说明，并把拦下的请求记成一份可搜索、可勾选、可清理的列表。
```

提 PR 的流程：

1. 在 GitHub 网页上 fork [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；
2. 在 fork 里新建 `data/plugins/<你的用户名>__dsh-peak-guard.yml`，粘贴上面的内容（**别的文件一个都别动**）；
3. 提 PR 到 `main`，标题类似 `Add dsh-peak-guard`。

### CI 会检查这些（对着 contributing 抄的）

| 检查 | 我们的情况 |
|---|---|
| 一个 PR 最多 3 条条目 | ✅ 只提 1 条 |
| `package.json` 里有 `dsh.bundle`（**只有 `dsh.client` 会被拒**） | ✅ 两个都有 |
| 仓库**创建满 1 天**（自动检查） | ⚠️ **刚建的仓库当天提会被 CI 挡**，等一天再提 |
| `awesome-lint` 与站点构建 | 由上游跑，我们只需保证 YAML 合法 |
| 描述属实、不带营销词、以句号结尾 | ✅ 上面两句只陈述功能 |
| 分类贴合实际做的事 | ✅ `usage`（Usage & Billing，峰谷计费同类插件都在这） |
| 只改自己的条目 | ✅ 只新增一个文件 |

### 可选但值得做

* **截图**：在仓库根放 `screenshots.json`（1–8 张，相对路径指向仓库内的图片），市场的详情页
  就会像 App Store 那样展示。不声明也行 —— 市场会退而从 README 里抽图。
  想加的话：截图放进 `assets/`，然后：
  ```json
  ["assets/screenshot-1.png", "assets/screenshot-2.png"]
  ```
* **合并之后**再往 README 顶部加精选列表的徽章（提前加等于自称已收录）：
  ```markdown
  ![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)
  ```
* **npm**：可选，只影响市场里能不能显示下载量。真发的话，npm 包的 `repository` 字段必须
  指回这个仓库，否则两边不会关联。注意那会让 `npm install` 也成为一条安装通道，
  而本插件零依赖、无构建步骤，源码安装本来就没有摩擦。

---

## 5. 用户那边是怎么「一键安装」的（已对着 dshmarket 源码核过）

精选列表的 `url` 会被市场解析成 pnpm 的 **`github:<owner>/<repo>`** 规格
（市场客户端里那条正则是
`/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/i`），
也就是**直接从你的仓库源码装**，不需要 npm 包、不需要预构建 tarball。

装的时候 pnpm 会跑一遍**几个特定的安装期脚本**，而这里正好是最容易卡住用户的地方 ——
市场的 `pnpm-compat.js` 专门识别两种失败：

| pnpm 的拦截 | 触发条件 | 本插件 |
|---|---|---|
| `git-prepare-not-allowed` | 从 **git 源**装、且包里有 `prepare` / `prepack` 脚本（在 fetcher 阶段就被拒，node_modules 里什么都还没有） | ✅ 没有这两个脚本 |
| 「需要执行构建脚本，被 pnpm 默认拦截」 | 包里有需要审批的构建脚本（`pnpm` 的 `allowBuilds` 名单里没有它） | ✅ 没有任何构建脚本 |
| 依赖 `@deepseek-ai/*` 官方包 | 要走 `peerDependencies` 且范围要带显式预发布分支，否则用户会遇到 `ERESOLVE` | ✅ 零依赖 |

**本插件之所以能免掉这些**：客户端半边 `lib/client.js` 是手写的纯 JS（不是编译产物），
宿主半边也是纯 ESM，**没有构建步骤** —— 所以从源码装和从 tarball 装，用户体验一模一样。
唯一要记住的是：用户装到的是 **`main` 分支的当前 HEAD**，所以别把半成品推上 `main`。

### 上架前自查清单

- [ ] 仓库是 **public**（私有仓库市场装不了）；
- [ ] `package.json` 在**仓库根**，且含 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；
- [ ] `cordis.patch.yml` 就在仓库根、能被解析、`id` 与包名对得上；
- [ ] **默认分支是 `main`**（GitHub 以第一次推送的分支为默认分支，我们推的就是 `main`）；
- [ ] 仓库里**没有** `prepare` / `prepack` / `postinstall` 脚本（本包只有 `test`，`pnpm` 安装时不执行）；
- [ ] 仓库创建**满 1 天**；
- [ ] 仓库已经打好 `dsh-plugin` topic。

### `private: true` 说明

`package.json` 里保留了 `"private": true`。它**只阻止 `npm publish`**，不影响
`dsh plugin add` / 市场安装（那条路走的是 git 源）。留着它是一道保险：避免哪天顺手
`npm publish` 把包名占了。**真要发 npm 时把这行删掉**即可。

### 用户的三条安装通道

```sh
# ① 市场里点卡片上的「安装」（上架之后）
# ② 命令行直接装（上架前就能用，仓库 public 即可）
dsh plugin add github:<你的用户名>/dsh-peak-guard
# ③ 本机桌面版 profile（Electron 保留 profile，命令行会被拒）
install.cmd     # 等价于 pwsh -File install-profile.ps1
```

装完**必须完全重启 DSH**（宿主模块与客户端产物都是启动时加载的）—— 市场里有「一键重启」。

## 6. 上架后的维护


* 改了功能就推 `main`，**再打一个新 tag**（`v1.0.1`…），版本号跟 `package.json` 保持一致；
* 描述变了（比如新增了接口）要同步更新精选列表里那个 YAML —— 提 PR 只改自己那一条；
* 精选列表会定期扫描「仓库消失 / 归档 / 长期停更」的条目并移除，保持有提交即可。
