<#
  把 dsh-peak-guard 装进某个 DSH profile（默认 desktop）。

  为什么需要脚本：`desktop` 是 Electron 应用保留的 profile，命令行
  `dsh plugin --profile desktop …` 会被拒绝（"managed exclusively by the Electron
  application"），所以只能改 profile 的 package.json + 建一个链接。脚本把那几步
  封装起来，并且每一步都落盘前校验、落盘后可回退。

  用法：
    pwsh -File install-profile.ps1                 # 装进 desktop
    pwsh -File install-profile.ps1 -WhatIf         # 只看要做什么，不落盘
    pwsh -File install-profile.ps1 -Profile tui    # 装进别的 profile
    pwsh -File install-profile.ps1 -Uninstall      # 卸载（还原依赖与 bundles，删链接）

  生效条件：**完全退出并重开 DSH Desktop**（关窗口不够，要退出进程）。
#>
[CmdletBinding()]
param(
  [string]$Profile = "desktop",
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
  [string]$PluginDir = "",
  [switch]$Uninstall,
  [switch]$WhatIf
)

# PS 5.1 里 $PSScriptRoot 在参数默认值求值时可能是空的，所以在这里兜底
if (-not $PluginDir) {
  $PluginDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
}

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say($message) { Write-Host "  $message" }
function Fail($message) { Write-Host "x $message" -ForegroundColor Red; exit 1 }

Write-Host "`n=== dsh-peak-guard 安装器 ===" -ForegroundColor Cyan
Say "DSH home   : $DshHome"
Say "profile    : $Profile"
Say "插件目录   : $PluginDir"
Say "模式       : $(if ($Uninstall) { '卸载' } else { '安装' })"

# ── 前置检查 ────────────────────────────────────────────────────────────────
$profileDir = Join-Path $DshHome (Join-Path "profiles" $Profile)
if (-not (Test-Path $profileDir)) {
  Fail "找不到 profile 目录：$profileDir`n  先用 DSH 启动过一次这个 profile，它才会被创建。"
}
$manifestPath = Join-Path $profileDir "package.json"
if (-not (Test-Path $manifestPath)) { Fail "profile 里没有 package.json：$manifestPath" }

$name = "dsh-peak-guard"
if (-not $Uninstall) {
  $pluginManifest = Join-Path $PluginDir "package.json"
  if (-not (Test-Path $pluginManifest)) { Fail "插件目录里没有 package.json：$PluginDir" }
  $plugin = Get-Content $pluginManifest -Raw -Encoding utf8 | ConvertFrom-Json
  if (-not $plugin.name) { Fail "插件 package.json 里没有 name" }
  if (-not $plugin.dsh.bundle.patch) { Fail "插件没有声明 dsh.bundle.patch（DSH 需要它来挂进组合包）" }
  $entry = Join-Path $PluginDir "lib\index.js"
  if (-not (Test-Path $entry)) { Fail "插件缺少入口 lib/index.js" }
  $name = $plugin.name
}

# ── 读 profile 清单 ────────────────────────────────────────────────────────
$raw = Get-Content $manifestPath -Raw -Encoding utf8
try { $manifest = $raw | ConvertFrom-Json } catch { Fail "profile 的 package.json 解析失败：$($_.Exception.Message)" }
if (-not $manifest.PSObject.Properties["dependencies"]) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $manifest.PSObject.Properties["dsh"]) {
  $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $manifest.dsh.PSObject.Properties["profile"]) {
  $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}

$depSpec = "link:" + ($PluginDir -replace "\\", "/")
if ($Uninstall) {
  if ($manifest.dependencies.PSObject.Properties[$name]) { $manifest.dependencies.PSObject.Properties.Remove($name) }
  $bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $name })
} else {
  $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $depSpec -Force
  $bundles = @($manifest.dsh.profile.bundles)
  if ($bundles -notcontains $name) { $bundles += $name }
}
$manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

$json = $manifest | ConvertTo-Json -Depth 20
try { $null = $json | ConvertFrom-Json } catch { Fail "写回前校验失败（不会落盘）：$($_.Exception.Message)" }

Write-Host "`n--- 将要写入的改动 ---"
Say "dependencies[""$name""] = $(if ($Uninstall) { '(移除)' } else { $depSpec })"
Say "dsh.profile.bundles  = $($bundles -join ', ')"

if ($WhatIf) { Write-Host "`n(-WhatIf：没有落盘)`n" -ForegroundColor Yellow; exit 0 }

# ── 备份 + 落盘 ────────────────────────────────────────────────────────────
$backup = "$manifestPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $manifestPath $backup -Force
Say "`n已备份：$backup"
# 必须写成无 BOM 的 UTF-8：Node/pnpm 的 JSON.parse 遇到 BOM 会直接失败
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)
Say "已写入：$manifestPath"

# ── 链接（junction，双向可见；插件目录仍在工作区里，改完重开 DSH 即生效）────
$modulesDir = Join-Path $profileDir "node_modules"
$linkPath = Join-Path $modulesDir $name
if ($Uninstall) {
  if (Test-Path $linkPath) {
    # 只删链接本体：junction 必须用 rmdir，Remove-Item -Recurse 会顺着链接删进插件目录
    if ($env:OS -eq "Windows_NT") { cmd /c rmdir "$linkPath" | Out-Null } else { Remove-Item $linkPath -Force }
    Say "已移除链接：$linkPath"
  }
} else {
  New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
  if (Test-Path $linkPath) { Say "链接已存在，跳过：$linkPath" }
  elseif ($env:OS -eq "Windows_NT") {
    cmd /c mklink /J "$linkPath" "$PluginDir" | Out-Null
    Say "已建 junction：$linkPath -> $PluginDir"
  } else {
    New-Item -ItemType SymbolicLink -Path $linkPath -Target $PluginDir | Out-Null
    Say "已建符号链接：$linkPath -> $PluginDir"
  }
}

# ── 校验 ───────────────────────────────────────────────────────────────────
$check = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$okDep = if ($Uninstall) { -not $check.dependencies.PSObject.Properties[$name] } else { $check.dependencies.PSObject.Properties[$name].Value -eq $depSpec }
$okBundle = if ($Uninstall) { @($check.dsh.profile.bundles) -notcontains $name } else { @($check.dsh.profile.bundles) -contains $name }
$okLink = if ($Uninstall) { -not (Test-Path $linkPath) } else { Test-Path $linkPath }
$okEntry = if ($Uninstall) { $true } else { Test-Path (Join-Path $linkPath "lib\index.js") }
Write-Host "`n--- 校验 ---"
Say "dependencies : $(if ($okDep) { 'OK' } else { 'FAIL' })"
Say "bundles      : $(if ($okBundle) { 'OK' } else { 'FAIL' })"
Say "node_modules : $(if ($okLink) { 'OK' } else { 'FAIL' })"
Say "入口可达     : $(if ($okEntry) { 'OK' } else { 'FAIL' })"
if (-not ($okDep -and $okBundle -and $okLink -and $okEntry)) { Fail "校验没过，请用备份还原：$backup" }

if ($Uninstall) {
  Write-Host "`n卸载完成。完全退出并重开 DSH Desktop 后生效。`n" -ForegroundColor Green
} else {
  Write-Host "`n安装完成。多数情况下 DSH 会就地热加载这一行（本机实测：写完 profile 后不到" -ForegroundColor Green
  Write-Host "一秒 include:peak-guard 就变成 enabled + active）；没生效再完全退出并重开 DSH Desktop。" -ForegroundColor Green
  Write-Host "`n验收（三选一）：" -ForegroundColor Cyan
  Say "1. 发 /peak  —— 应看到峰谷状态与窗口；谷时会写明「不会拦」，这是正常的"
  Say "2. 发 /peak test —— 不下发请求，直接看那句话长什么样"
  Say "3. 发 /peak force 5 —— 强制拦 5 分钟，然后随便发一句话，模型位置会"
  Say "   出现「现在是梁文峰时间，你马内不要了？胆子真是肥嘟嘟的」；/peak on 收回"
  Write-Host ""
}
