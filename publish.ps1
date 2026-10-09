<#
  publish.ps1 —— 把 dsh-peak-guard 一键发布到 GitHub（并可选地自动建仓、设 topics）

  用法（本机是 Windows PowerShell 5.1，没有 pwsh，所以用 powershell.exe 调用）：

    # ① 最省事：带一个 GitHub token，自动建仓库 + 推送 + 打 tag + 设 topics
    powershell -ExecutionPolicy Bypass -File publish.ps1 -Token ghp_xxxxxxxx

    # ② 没有 token：脚本会提交、配好 remote，然后告诉你去哪个网址点「Create repository」，
    #    建好之后原样再跑一次即可（推送时 Git 会弹窗让你登录）
    powershell -ExecutionPolicy Bypass -File publish.ps1

    # ③ 先看要做什么，不真的动
    powershell -ExecutionPolicy Bypass -File publish.ps1 -WhatIf

  也可以用双击：publish.cmd（等价于 ②，token 走环境变量 GITHUB_TOKEN）

  这个脚本做的事：
    1. 检查包名 / 分支 / 安装期脚本（发布前自查）
    2. git 身份缺失时按参数补上（只写本仓库，不动全局配置）
    3. git add + commit（没有改动就跳过）
    4. 没有 origin 就加上 https://github.com/<Owner>/<Repo>.git
    5. 仓库不存在时：有 token 就用 API 建（public），没 token 就打印建仓网址并退出
    6. 推送 main（token 走临时 http.extraheader，不写进 .git/config）
    7. 打并推送 v<package.json 里的 version> 标签
    8. 有 token 就设 topics（含收录必需的 dsh-plugin）
    9. 打印下一步：等仓库满 1 天 → 去精选列表提 PR（条目已备好）

  幂等：重复跑不会重复提交、不会重复建仓、不会重复加 remote、tag 已存在会跳过。
#>
[CmdletBinding()]
param(
  [string]$Owner    = 'Eqarx',
  [string]$Repo     = 'dsh-peak-guard',
  [string]$Token    = $env:GITHUB_TOKEN,
  [string]$GitName  = '',
  [string]$GitEmail = '',
  [string[]]$Topics = @('dsh-plugin', 'dsh', 'deepseek-harness', 'peak-hour', 'off-peak', 'cost-control', 'cordis'),
  [switch]$SkipTag,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Continue'   # git 往 stderr 写提示是常态，别让它变成致命错误
# Windows PowerShell 5.1 默认可能还是 TLS 1.0，访问 api.github.com 会直接失败
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Die([string]$text) { Write-Host $text -ForegroundColor Red; exit 1 }
# 只取 stdout、丢掉 git 的常规 stderr 噪音（CRLF 提示、'No such remote' 之类）
# git 调用一律内联写：包装函数在 Windows PowerShell 5.1 里行为不稳（曾静默返回空）

function Invoke-GitHub([string]$Method, [string]$Path, $Body) {
  $headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'dsh-peak-guard-publish'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $args = @{ Method = $Method; Uri = "https://api.github.com$Path"; Headers = $headers; ContentType = 'application/json' }
  if ($Body -ne $null) { $args.Body = ($Body | ConvertTo-Json -Compress) }
  return Invoke-RestMethod @args
}

# ── 0. 站在包目录里 ────────────────────────────────────────────────────────────
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) { Die "这里没有 package.json，请在插件包目录里运行本脚本。" }
Set-Location $root
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne $Repo) { Say "⚠ package.json 里的 name 是 $($pkg.name)，与 -Repo $Repo 不一致，继续按 $Repo 发布。" 'Yellow' }
$version = $pkg.version
$desc = if ($pkg.description) { ($pkg.description -split '/')[0].Trim() } else { 'DeepSeek Harness peak-pricing guard' }
$url = "https://github.com/$Owner/$Repo"

Step "发布前自查"
Say "包名      ：$($pkg.name) v$version"
Say "目标仓库  ：$url"
Say "分支      ：$(& git branch --show-current 2>$null)"
$installScripts = @('prepare', 'prepack', 'postinstall', 'preinstall', 'install') |
  Where-Object { $pkg.scripts.PSObject.Properties.Name -contains $_ }
if ($installScripts) { Say "⚠ 有安装期脚本：$($installScripts -join ', ')（市场安装时可能要用户点「允许构建」）" 'Yellow' }
else { Say "安装期脚本：无 ✓（从源码装不会触发 pnpm 的构建审批）" 'Green' }
if ($pkg.dsh.bundle.patch -and (Test-Path (Join-Path $root $pkg.dsh.bundle.patch))) { Say "dsh.bundle：$($pkg.dsh.bundle.patch) ✓" 'Green' }
else { Die "package.json 里缺少 dsh.bundle.patch，或它指向的文件不存在 —— 这样市场装不了。" }
if (-not $pkg.private) { Say "提示：package.json 没有 private:true，注意别误发 npm。" 'Yellow' }

# ── 1. git 身份 ────────────────────────────────────────────────────────────────
Step "git 身份"
if (-not (Test-Path (Join-Path $root '.git'))) { Die "这里还不是 git 仓库，先 git init -b main。" }
if (-not (& git config --get user.name 2>$null)) {
  if ($GitName) {
    if ($WhatIf) { Say "[WhatIf] git config user.name $GitName" 'Yellow' }
    else { & git config user.name $GitName 2>$null; Say "已为本仓库设置 user.name = $GitName" 'Green' }
  }
  else { Die "还没配 git 身份。加参数 -GitName ""你的名字"" -GitEmail ""你的邮箱""，或先跑一次：git config --global user.name / user.email" }
}
if (-not (& git config --get user.email 2>$null)) {
  if ($GitEmail) {
    if ($WhatIf) { Say "[WhatIf] git config user.email $GitEmail" 'Yellow' }
    else { & git config user.email $GitEmail 2>$null; Say "已为本仓库设置 user.email = $GitEmail" 'Green' }
  }
  else { Die "还没配 git 邮箱。加参数 -GitEmail ""你的邮箱""，或先跑一次 git config --global user.email" }
}
Say "user.name  = $(& git config --get user.name 2>$null)"
Say "user.email = $(& git config --get user.email 2>$null)"

# ── 2. 提交 ────────────────────────────────────────────────────────────────────
Step "提交改动"
& git add -A 2>$null | Out-Null
$staged = (@(& git diff --cached --name-only 2>$null) | Measure-Object).Count
if ($staged -gt 0) {
  Say "本次要提交 $staged 个文件"
  if ($WhatIf) { Say "[WhatIf] 跳过 commit" 'Yellow' }
  else {
    git commit -q -m "feat: $($pkg.name) $version — 高峰时段拦下模型调用并记录被拦请求"
    Say "已提交：$(git log -1 --pretty=format:'%h %s')" 'Green'
  }
} else { Say "没有未提交的改动 ✓" }

# ── 3. remote ─────────────────────────────────────────────────────────────────
Step "远程仓库"
$remotes = @(& git remote 2>$null)
if ($remotes -notcontains 'origin') {
  if ($WhatIf) { Say "[WhatIf] git remote add origin $url.git" 'Yellow' }
  else { git remote add origin "$url.git"; Say "已添加 origin = $url.git" 'Green' }
} else { Say "origin 已存在：$(& git remote get-url origin 2>$null)" }

# ── 4. 仓库存在吗 ──────────────────────────────────────────────────────────────
Step "检查 GitHub 上的仓库"
# 先用 /user 体检 token：无效就**降级**成「没有 token」继续跑，绝不半路把整个发布掐断。
# （最惨的一次踩坑：有人照着文档把占位符 ghp_xxxxxxxx 原样填了进来，于是 401 直接 exit 1，
#   连本来能成的 git push 也一起断掉。）
if ($Token) {
  if ($Token -match '^ghp_x+$|^x+$|<.*>' -or $Token.Length -lt 20) {
    Say "⚠ 这个 token 看着还是占位符（$Token）。" 'Yellow'
    Say "  真 token 在这里建：https://github.com/settings/tokens → Generate new token (classic) → 勾选 repo" 'Yellow'
    Say "  本次按「没有 token」继续：照样提交、推送、打 tag，只是不能自动建仓库和设 topics。" 'Yellow'
    $Token = $null
  } else {
    try {
      $me = Invoke-GitHub 'GET' '/user'
      Say "token 有效 ✓（登录身份：$($me.login)）" 'Green'
    } catch {
      Say "⚠ token 用不了：$($_.Exception.Message)" 'Yellow'
      Say "  常见原因：token 已过期 / 被撤销 / 权限不足（建仓库需要 classic token 的 repo 权限）。" 'Yellow'
      Say "  本次按「没有 token」继续：照样提交、推送、打 tag，只是不能自动建仓库和设 topics。" 'Yellow'
      $Token = $null
    }
  }
}

$exists = $false
if ($Token) {
  try { $null = Invoke-GitHub 'GET' "/repos/$Owner/$Repo"; $exists = $true; Say "仓库已存在 ✓" 'Green' }
  catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) { Say "仓库还不存在" } else { Say "查询失败：$($_.Exception.Message)" 'Yellow' }
  }
  if (-not $exists) {
    if ($WhatIf) { Say "[WhatIf] 用 API 创建 public 仓库 $Owner/$Repo" 'Yellow' }
    else {
      try {
        $created = Invoke-GitHub 'POST' '/user/repos' @{ name = $Repo; private = $false; description = $desc; has_issues = $true; has_wiki = $false; auto_init = $false }
        $exists = $true
        Say "已创建仓库：$($created.html_url)" 'Green'
        Start-Sleep -Seconds 2   # 让 GitHub 那边把 refs 准备好
      } catch {
        # 建仓失败也别死：下面的 push 自己会给出准确结论
        Say "⚠ 自动建仓失败：$($_.Exception.Message)" 'Yellow'
        Say "  那就手动建一个空仓库（不要勾 README / .gitignore / License）：" 'Yellow'
        Say "  https://github.com/new?name=$Repo&owner=$Owner" 'Cyan'
      }
    }
  }
} else {
  Say "没给 -Token：跳过 API 检查，直接尝试推送（仓库不存在的话 git 会报错，下面会给建仓链接）" 'Yellow'
}

# ── 5. 推送 ────────────────────────────────────────────────────────────────────
Step "推送 main"
$gitArgs = @()
if ($Token) {
  # token 只在这次命令里出现，不写进 .git/config
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
  $gitArgs += @('-c', "http.extraheader=Authorization: Basic $basic")
}
if ($WhatIf) { Say "[WhatIf] git $($gitArgs -join ' ') push -u origin main" 'Yellow' }
else {
  # git 把进度写在 stderr，这里合并成正常的灰字输出，免得 PowerShell 包一层 NativeCommandError
  & git @gitArgs push -u origin main 2>&1 | ForEach-Object { Say "  $_" }
  if ($LASTEXITCODE -ne 0) {
    Say ""
    Say "推送没成功。最常见的原因是仓库还不存在 —— 先去建一个**空**仓库" 'White'
    Say "（不要勾 README / .gitignore / License，否则第一次推送会冲突）：" 'White'
    Say "  https://github.com/new?name=$Repo&owner=$Owner" 'Cyan'
    Say "建好之后，原样再跑一次本脚本即可。" 'White'
    Say "（另一种做法：带 -Token 跑，脚本会自己把仓库建出来。也可以设环境变量 GITHUB_TOKEN。）" 'White'
    Die "已停在推送这一步，前面的提交与 remote 都已就绪，不用重来。"
  }
  Say "推送完成 ✓" 'Green'
}

# ── 6. 版本 tag ────────────────────────────────────────────────────────────────
if ($SkipTag) { Say "`n（-SkipTag：跳过打标签）" }
else {
  Step "版本标签 v$version"
  if (& git tag -l "v$version" 2>$null) { Say "标签 v$version 已存在 ✓" }
  elseif ($WhatIf) { Say "[WhatIf] git tag -a v$version && git push origin v$version" 'Yellow' }
  else {
    git tag -a "v$version" -m "$($pkg.name) $version"
    & git @gitArgs push origin "v$version" 2>&1 | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { Say "标签推送失败（不影响仓库本身，可稍后手动 git push origin v$version）" 'Yellow' }
    else { Say "标签 v$version 已推送 ✓（GitHub 上会生成 Release 页）" 'Green' }
  }
}

# ── 7. topics ─────────────────────────────────────────────────────────────────
Step "仓库 topics（收录 dsh-market 的必需项）"
if (-not $Token) { Say "没给 -Token，跳过。可到仓库首页 ⚙️ About → Topics 手填：$($Topics -join '  ')" 'Yellow' }
elseif ($WhatIf) { Say "[WhatIf] PUT /repos/$Owner/$Repo/topics = $($Topics -join ', ')" 'Yellow' }
else {
  try {
    $r = Invoke-GitHub 'PUT' "/repos/$Owner/$Repo/topics" @{ names = $Topics }
    Say "已设置：$($r.names -join '  ')" 'Green'
  } catch { Say "设置 topics 失败：$($_.Exception.Message)（仓库页 ⚙️ About 里可以手填）" 'Yellow' }
}

# ── 8. 下一步 ─────────────────────────────────────────────────────────────────
Step "完成，接下来两件事"
Say "1) 仓库要创建满 1 天后才能被精选列表收录 —— 稍后再去提 PR。"
Say "2) 提 PR：fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin，"
Say "   新建 data/plugins/$Owner`__$Repo.yml，内容见 docs/awesome-dsh-plugin-entry.yml（里面已是你的用户名）。"
Say ""
Say "仓库地址：$url" 'Cyan'
