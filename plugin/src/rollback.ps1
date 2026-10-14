<#
============================================================================
 dsh-pipeline · 回滚脚本（Windows PowerShell 5.1 / 7 均可）
============================================================================

 ⚠️ 本文件必须存为 **UTF-8 with BOM**（原因同 install.ps1：本机只有
    PowerShell 5.1，无 BOM 的 .ps1 里有中文会按 ANSI 解码失败）。

 做三件事，顺序固定：

   1. 从备份还原 profile 的 `cordis.patch.yml` 与 `package.json`
      （用 -Stamp 指定 install 时打印的那一串；不指定就自动找最新的一对）
   2. 从 package.json 的 `dsh.profile.bundles` 里摘掉 "dsh-pipeline"
      （备份不存在时的兜底路径：不还原整份文件，只做最小外科手术）
   3. 从 cordis.patch.yml 里删掉本插件那一个 insert 块
      （备份不存在时的兜底路径）

 ⚠️ 与 install.ps1 一样，**只动本插件相关的东西**。

 用法：

   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -Stamp 20261011-051230
   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -PurgePluginDir

 生效方式：回滚后**需要重启 DSH**。若 DSH 当前正因为本插件起不来，
 先重启再回滚也行 —— 配置文件的修改不依赖进程存活。
============================================================================
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  # ★ 保留插件自带的 stop-ladder Skill（默认撤掉；装/撤要对称）
  [switch]$KeepSkill,
  # Skill 目录（默认跟 -DshHome 走）
  [string]$SkillsDir = '',
  # install.ps1 打印的时间戳。留空 = 自动挑最新的一对备份。
  [string]$Stamp = '',
  # 连 <profile>\node_modules\dsh-pipeline 一起删掉
  [switch]$PurgePluginDir,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-pipeline'
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
# ★ 插件自带的 Skill 落点（install.ps1 装的那个）
$SkillsRoot = if ($SkillsDir -ne '') { $SkillsDir } else { Join-Path $DshHome 'skills' }
$SkillTarget = Join-Path $SkillsRoot 'stop-ladder'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$PkgPath = Join-Path $ProfileDir 'package.json'
$TargetDir = Join-Path (Join-Path $ProfileDir 'node_modules') $PluginName

function Info($m) { Write-Host "[pipeline] $m" }
function Warn($m) { Write-Host "[pipeline] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[pipeline] 失败：$m" -ForegroundColor Red; exit 1 }
function Read-Text($p) { return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-TextNoBom($p, $t) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $t, $enc)
}
function Remove-ChildSafely($child) {
  $full = [System.IO.Path]::GetFullPath($child)
  $rootFull = [System.IO.Path]::GetFullPath((Join-Path $ProfileDir 'node_modules'))
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Die "拒绝删除 node_modules 之外的路径：$full"
  }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) { Die "找不到 profile 目录：$ProfileDir" }

# ---------------------------------------------------------------------------
# 0) 找回滚用的备份
# ---------------------------------------------------------------------------
function Find-Backup($base, $stamp) {
  $dir = Split-Path $base -Parent
  $leaf = Split-Path $base -Leaf
  if ($stamp -ne '') {
    $p = "$base.bak-$stamp"
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
  }
  $cands = Get-ChildItem -LiteralPath $dir -Filter "$leaf.bak-*" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($cands.Count -eq 0) { return $null }
  return $cands[0].FullName
}

$PkgBackup = Find-Backup $PkgPath $Stamp
$PatchBackup = Find-Backup $PatchPath $Stamp

if ($Stamp -ne '' -and ($PkgBackup -eq $null -or $PatchBackup -eq $null)) {
  Die "用时间戳 $Stamp 找不到成对的备份（package.json / cordis.patch.yml 至少缺一个）。检查一下备份文件名。"
}

Info "package.json 备份：$(if ($PkgBackup) { $PkgBackup } else { '（没有）' })"
Info "cordis.patch.yml 备份：$(if ($PatchBackup) { $PatchBackup } else { '（没有）' })"

# ---------------------------------------------------------------------------
# 1) 还原文件（有备份走这条路）
# ---------------------------------------------------------------------------
$restoredPatch = $false
$restoredPkg = $false

if ($PatchBackup -ne $null) {
  if (-not $DryRun) {
    Copy-Item -LiteralPath $PatchBackup -Destination $PatchPath -Force
    Info "已还原 cordis.patch.yml ← $PatchBackup"
  } else { Info "[DryRun] 会还原 cordis.patch.yml ← $PatchBackup" }
  $restoredPatch = $true
}
if ($PkgBackup -ne $null) {
  if (-not $DryRun) {
    Copy-Item -LiteralPath $PkgBackup -Destination $PkgPath -Force
    Info "已还原 package.json ← $PkgBackup"
  } else { Info "[DryRun] 会还原 package.json ← $PkgBackup" }
  $restoredPkg = $true
}

# ---------------------------------------------------------------------------
# 2) 没有备份时的兜底：最小外科手术，只摘掉本插件
# ---------------------------------------------------------------------------
if (-not $restoredPkg -and (Test-Path -LiteralPath $PkgPath)) {
  Warn "没有 package.json 备份，改用最小手术：只把 `"$PluginName`" 从 dsh.profile.bundles 里摘掉。"
  $pkgText = Read-Text $PkgPath
  $pattern = ',\s*"' + [regex]::Escape($PluginName) + '"(?=\s*[,\]])|"' + [regex]::Escape($PluginName) + '"\s*,\s*'
  $newPkg = [regex]::Replace($pkgText, $pattern, '', 1)
  if ($newPkg -eq $pkgText) {
    Warn "在 package.json 里没找到 `"$PluginName`"，可能本来就没装。"
  } else {
    # 兜底也要先验一遍 JSON，绝不写坏 profile
    try { $null = $newPkg | ConvertFrom-Json } catch { Die "最小手术后 JSON 不合法，已放弃（原文件未改）：$($_.Exception.Message)" }
    if (-not $DryRun) { Write-TextNoBom $PkgPath $newPkg; Info "已从 bundles 里摘掉 $PluginName。" }
    else { Info "[DryRun] 会从 bundles 里摘掉 $PluginName。" }
  }
}

if (-not $restoredPatch -and (Test-Path -LiteralPath $PatchPath)) {
  Warn "没有 cordis.patch.yml 备份，改用最小手术：删掉本插件那一个 insert 块。"
  $lines = [System.IO.File]::ReadAllLines($PatchPath, [System.Text.Encoding]::UTF8)
  $out = New-Object System.Collections.Generic.List[string]
  $i = 0
  $removed = 0
  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    # 命中：`- id: dsh-pipeline` 的那一行，往上吃掉紧邻的注释与空行，
    # 往下吃掉这个 insert 条目（到下一个以 `- ` 顶格开头的行为止）。
    if ($line -match "^\s*-\s*id:\s*$([regex]::Escape($PluginName))\s*$") {
      # 往上回退：`- insert:` 那一行
      while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*-\s*insert:\s*$') { $out.RemoveAt($out.Count - 1) }
      # 再往上：紧邻的注释块与空行
      while ($out.Count -gt 0 -and ($out[$out.Count - 1] -match '^\s*#' -or $out[$out.Count - 1].Trim() -eq '')) { $out.RemoveAt($out.Count - 1) }
      # 往下：吃掉属于这个条目的续行（缩进比 `- id:` 更深的行）
      $i++
      while ($i -lt $lines.Count -and $lines[$i] -match '^\s+\S') { $i++ }
      $removed++
      continue
    }
    $out.Add($line)
    $i++
  }
  if ($removed -eq 0) { Warn "在 cordis.patch.yml 里没找到 $PluginName 的条目。" }
  else {
    if (-not $DryRun) {
      Write-TextNoBom $PatchPath (($out -join "`r`n") + "`r`n")
      Info "已从 cordis.patch.yml 删掉 $PluginName 的条目（$removed 处）。"
    } else { Info "[DryRun] 会从 cordis.patch.yml 删掉 $PluginName 的条目（$removed 处）。" }
  }
}

# ---------------------------------------------------------------------------
# 3) 可选：删掉插件目录
# ---------------------------------------------------------------------------
if ($PurgePluginDir) {
  if (Test-Path -LiteralPath $TargetDir) {
    if (-not $DryRun) { Remove-ChildSafely $TargetDir; Info "已删除插件目录：$TargetDir" }
    else { Info "[DryRun] 会删除插件目录：$TargetDir" }
  } else { Info "插件目录本来就不存在：$TargetDir" }
} else {
  Info "插件目录保留（要删加 -PurgePluginDir）：$TargetDir"
}

# ---------------------------------------------------------------------------
# 3.5) ★ 撤掉插件自带的 Skill（stop-ladder）
# ---------------------------------------------------------------------------
#
# 装与撤要**对称**：install.ps1 落了一份 SKILL.md 到 <dsh-home>/skills/，
# 这里就把它撤掉。只删**我们装的那一份**（靠 .installed-by 标记认），
# 别的来源的同名 Skill 一律不碰 —— 撤装脚本不该越权删别人的东西。
if ($KeepSkill) {
  Info "按 -KeepSkill，保留 Skill：$SkillTarget"
} elseif (-not (Test-Path -LiteralPath $SkillTarget)) {
  Info "Skill 本来就不存在：$SkillTarget"
} else {
  $marker = Join-Path $SkillTarget '.installed-by'
  $ours = (Test-Path -LiteralPath $marker) -and ((Read-Text $marker).Trim() -eq $PluginName)
  if (-not $ours) {
    Warn "Skill 目录存在，但**不是本插件装的**（没有 .installed-by 标记）：$SkillTarget"
    Warn "  按纪律不碰别人的东西，跳过。要手工删：Remove-Item -Recurse -Force \"$SkillTarget\""
  } elseif (-not $DryRun) {
    Remove-Item -LiteralPath $SkillTarget -Recurse -Force
    Info "已撤掉 Skill：$SkillTarget"
  } else {
    Info "[DryRun] 会撤掉 Skill：$SkillTarget"
  }
}

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
if ($DryRun) { Write-Host ' dsh-pipeline 回滚预演完成（DryRun：没有改任何文件）' -ForegroundColor Green }
else { Write-Host ' dsh-pipeline 回滚完成' -ForegroundColor Green }
Write-Host '======================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '生效方式：' -ForegroundColor Yellow
Write-Host '  · 插件本体（工具 / 守门 / 拦截缝）：**需要重启 DSH**（Host 半边在启动时装载/卸载）。'
Write-Host '  · 自带的 stop-ladder Skill：**下一次会话就看不到它了**（技能目录每会话重扫）。'
Write-Host ''
Write-Host '回滚后自查（重启后看日志）：'
Write-Host '  · 不该再出现  [pipeline] dsh-pipeline ... 已加载 ...  这一行；'
Write-Host '  · pipeline_* 工具应该全部消失。'
Write-Host ''
Write-Host '要重新装回来：'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PluginName\install.ps1`" -Profile $Profile"
Write-Host ''
Write-Host '人工核对用的文件：'
Write-Host "  $PkgPath"
Write-Host "  $PatchPath"
