<#
============================================================================
 dsh-pipeline · 回滚脚本（Windows PowerShell 5.1 / 7 均可）
============================================================================

 ⚠️ 本文件必须存为 **UTF-8 with BOM**（原因同 install.ps1：本机只有
    PowerShell 5.1，无 BOM 的 .ps1 里有中文会按 ANSI 解码失败）。

 做两件事，顺序固定：

   1. 从 package.json 的 `dsh.profile.bundles` 里**只摘掉 "dsh-pipeline" 那一条**
      （按名字精确匹配；**其它 bundles 条目原样保留**）
   2. 从 cordis.patch.yml 里**只删掉 install.ps1 自己追加的那一个块**
      （按 install 写入时的可识别标记 `# --- dsh-pipeline（…）---` 与 id 精确匹配；
       **其它内容原样保留**）

 ⚠️ 与 install.ps1 一样，**只动本插件相关的东西**。

 ★★ 为什么"回退"**不还原整份文件**（2026-10-16 修，复发性缺陷）：
    旧版会用 install 时的备份把 profile 的 package.json / cordis.patch.yml
    **整份 `Copy-Item -Force` 盖回**。但 install 之后用户还会往这两个文件里加
    **与本插件无关**的东西（例如 `dsh.profile.bundles` 里的 `dsh-askcard-row`、
    或别的插件的 cordis.patch.yml 条目）—— 整份覆盖会让它们**静默消失**。
    真机症状：主窗口提问面板 fallback 成 raw JSON（bundles 里的 `dsh-askcard-row`
    被抹掉 ⇒ 它的 bundle patch 不再被读到 ⇒ 客户端半边没加载），
    而且"修好一阵子又复发"—— 每回滚一次就再抹一次。
    ⇒ 回退语义收窄为：**只撤销 install.ps1 自己加的那两样东西**，别的一律不动。
       改动前只**记录将被改动的片段**（落一份小 JSON 备查），不整份备份、不整份还原。

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
  # install.ps1 打印的时间戳。只用来**给改动记录命名 / 标注 install 备份**；
  # 回退本身不再依赖备份（语义已收窄为"只撤销 install 加的那两样东西"）。
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
  # 只是提示：回退**不依赖**备份（见文件头「为什么回退不还原整份文件」）。
  Warn "用时间戳 $Stamp 没找到成对的备份（package.json / cordis.patch.yml 至少缺一个）。"
  Warn "  不影响回退 —— 回退只做最小外科手术，不还原整份文件。"
}

Info "install 时的备份（仅供参考，回退不用它还原）："
Info "  package.json     ：$(if ($PkgBackup) { $PkgBackup } else { '（没有）' })"
Info "  cordis.patch.yml ：$(if ($PatchBackup) { $PatchBackup } else { '（没有）' })"

# ---------------------------------------------------------------------------
# 1) 改动前：记录原始值（只记录**将被改动的片段**，不整份备份/还原）
# ---------------------------------------------------------------------------
$RunStamp = if ($Stamp -ne '') { $Stamp } else { Get-Date -Format 'yyyyMMdd-HHmmss' }
$RecordPath = Join-Path $ProfileDir ".dsh-pipeline-rollback-$RunStamp.json"
$prePkgHash = if (Test-Path -LiteralPath $PkgPath) { (Get-FileHash -LiteralPath $PkgPath -Algorithm SHA256).Hash } else { $null }
$prePatchHash = if (Test-Path -LiteralPath $PatchPath) { (Get-FileHash -LiteralPath $PatchPath -Algorithm SHA256).Hash } else { $null }
$removedBundleEntry = $null
$removedPatchLines = @()

# ---------------------------------------------------------------------------
# 2) 只撤销 install.ps1 加的第 ① 样：dsh.profile.bundles 里的 "dsh-pipeline"
# ---------------------------------------------------------------------------
# ★ 只在 bundles 数组**内部**按名字精确匹配 —— 绝不动 dependencies 里的同名键。
#   （旧版正则扫全文，靠 `(?=[,\]])` 的前瞻侥幸没误伤 dependencies；这里从结构上排除。）
if (Test-Path -LiteralPath $PkgPath) {
  $pkgText = Read-Text $PkgPath
  $arrPat = '(?s)("bundles"\s*:\s*\[)(.*?)(\s*\])'
  $am = [regex]::Match($pkgText, $arrPat)
  if (-not $am.Success) {
    Warn "在 package.json 里找不到 dsh.profile.bundles 数组 —— 跳过（不动文件）。"
  } else {
    $inner = $am.Groups[2].Value
    # 只在**数组内部**匹配 —— 这样 `dependencies` 里那个同名的 `"dsh-pipeline"`
    # 依赖键**结构上不可能**被误碰。（旧版扫全文，靠 `(?=[,\]])` 前瞻侥幸避开了它
    # ——依赖键后面跟的是 `:`——但那是巧合，不是保障。）
    # 形状两种、共四条正则，依次试、命中即停：
    #   ① 条目独占一行（pretty-print 的常规形状；带行尾换行或就是最后一行都认）
    #   ② 条目不独占一行（有人把 package.json 压成单行时）——
    #      再分「前面带逗号 / 后面带逗号 / 前面带逗号且在数组末尾」三种位置。
    # 判据见 tests/rollback-config-check.ps1 的场景 A/B/C 与「作用域」三条。
    $esc = [regex]::Escape($PluginName)
    # ⚠️ 每一项都要**自己带括号**：PowerShell 里逗号比 `+` 结合得更紧，
    #    写成 `'a' + $x + 'b', 'c' + $x + 'd'` 会被解析成**一个**字符串而不是两个元素。
    $pats = @(
      ('(?m)^[ \t]*"' + $esc + '"[ \t]*,?[ \t]*(?:\r?\n|\z)'),
      (',\s*"' + $esc + '"(?=\s*[,\]])'),
      ('"' + $esc + '"\s*,\s*'),
      (',\s*"' + $esc + '"\s*\z')
    )
    $newInner = $inner
    foreach ($p in $pats) {
      $try = [regex]::Replace($newInner, $p, '', 1)
      if ($try -ne $newInner) { $newInner = $try; break }
    }
    if ($newInner -eq $inner) {
      Warn "dsh.profile.bundles 里没有 `"$PluginName`"，无需摘除。"
    } else {
      # 摘掉末项时前一项会留下一个尾随逗号 —— 去掉紧贴数组末尾的那一个。
      $newInner = [regex]::Replace($newInner, ',[ \t]*(\s*)\z', '$1')
      $newPkg = $pkgText.Substring(0, $am.Groups[2].Index) + $newInner +
                $pkgText.Substring($am.Groups[2].Index + $am.Groups[2].Length)
      # 绝不写坏 profile：先验一遍 JSON
      try { $null = $newPkg | ConvertFrom-Json }
      catch { Die "最小手术后 JSON 不合法，已放弃（原文件未改）：$($_.Exception.Message)" }
      $removedBundleEntry = $PluginName
      if (-not $DryRun) {
        Write-TextNoBom $PkgPath $newPkg
        Info "已从 dsh.profile.bundles 摘掉 `"$PluginName`"（其它条目原样保留）。"
      } else { Info "[DryRun] 会从 dsh.profile.bundles 摘掉 `"$PluginName`"。" }
    }
  }
}

# ---------------------------------------------------------------------------
# 3) 只撤销 install.ps1 加的第 ② 样：cordis.patch.yml 里本插件那一个块
# ---------------------------------------------------------------------------
# 两种形状都认（install.ps1 写的是 `- insert:` 套一层；后来手工改成按 id 覆盖就没有它）：
#     # --- dsh-pipeline（…）---        ← install 写入时的可识别标记
#     - insert:
#         - id: dsh-pipeline
#           name: 'dsh-pipeline'
#           config: …
#   或
#     - id: dsh-pipeline
#       name: 'dsh-pipeline'
#       …
if (Test-Path -LiteralPath $PatchPath) {
  $lines = [System.IO.File]::ReadAllLines($PatchPath, [System.Text.Encoding]::UTF8)
  # 文件头注释的行数 —— 任何时候都不许吃掉它（越界兜底）。
  $headerCount = 0
  while ($headerCount -lt $lines.Count -and $lines[$headerCount] -match '^#') { $headerCount++ }

  $out = New-Object System.Collections.Generic.List[string]
  $outIdx = New-Object System.Collections.Generic.List[int]
  $removedIdx = New-Object System.Collections.Generic.List[int]
  $i = 0
  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    if ($line -match "^\s*-\s*id:\s*$([regex]::Escape($PluginName))\s*$") {
      # ★ 命中的这一行自己也要记进"被删清单" —— 漏了它，改动记录里就少了
      #   `- id: dsh-pipeline` 那一行（文件是对的，记录是残的），
      #   而这份记录正是人工还原时唯一能照抄的东西。
      $removedIdx.Add($i)
      # 往上：`- insert:` 那一行（install.ps1 写的外壳）
      while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*-\s*insert:\s*$') {
        $removedIdx.Add($outIdx[$outIdx.Count - 1])
        $out.RemoveAt($out.Count - 1); $outIdx.RemoveAt($outIdx.Count - 1)
      }
      # 再往上：紧邻的注释块与空行 —— **只吃 install 自己写的那一段**。
      # 判据：这段连续注释里必须有 install 的标记行 `# --- dsh-pipeline`。
      # 没有标记就不动它们 —— 宁可留一行多余注释，也不越权删别的插件的注释。
      $j = $out.Count
      while ($j -gt 0 -and ($out[$j - 1] -match '^\s*#' -or $out[$j - 1].Trim() -eq '')) { $j-- }
      $ours = $false
      for ($k = $j; $k -lt $out.Count; $k++) {
        if ($out[$k] -match ('^#\s*---\s*' + [regex]::Escape($PluginName))) { $ours = $true; break }
      }
      if ($ours -and $j -ge $headerCount -and $out.Count -gt $j) {
        for ($k = $out.Count - 1; $k -ge $j; $k--) { $removedIdx.Add($outIdx[$k]) }
        $out.RemoveRange($j, $out.Count - $j); $outIdx.RemoveRange($j, $outIdx.Count - $j)
      }
      # 往下：吃掉属于这个条目的续行（缩进比 `- id:` 更深的行）
      $i++
      while ($i -lt $lines.Count -and $lines[$i] -match '^\s+\S') { $removedIdx.Add($i); $i++ }
      continue
    }
    $out.Add($line); $outIdx.Add($i)
    $i++
  }

  if ($removedIdx.Count -eq 0) {
    Warn "在 cordis.patch.yml 里没找到 $PluginName 的条目，无需删除。"
  } elseif ($out.Count -eq 0 -or $out[0] -notmatch '^#') {
    # 越界兜底：手术后连文件头都没了 ⇒ 说明匹配错了，宁可不改。
    Die "手术后 cordis.patch.yml 会丢掉文件头（匹配可疑），已放弃（原文件未改）。"
  } else {
    # 记录被删片段（按原文件顺序），供人工还原时照抄。
    $removedPatchLines = @($removedIdx | Sort-Object | ForEach-Object { $lines[$_] })
    $newPatchText = ($out -join "`r`n") + "`r`n"
    if (-not $DryRun) {
      Write-TextNoBom $PatchPath $newPatchText
      Info "已从 cordis.patch.yml 删掉 $PluginName 的条目（$($removedIdx.Count) 行；其它内容原样保留）。"
    } else { Info "[DryRun] 会从 cordis.patch.yml 删掉 $PluginName 的条目（$($removedIdx.Count) 行）。" }
  }
}

# ---------------------------------------------------------------------------
# 4) 落一份改动记录：只记**将被改动的片段**，不整份备份
# ---------------------------------------------------------------------------
$record = [ordered]@{
  tool              = 'dsh-pipeline/rollback.ps1'
  at                = (Get-Date).ToString('o')
  profile           = $Profile
  plugin            = $PluginName
  stamp             = $RunStamp
  dry_run           = [bool]$DryRun
  install_backup    = [ordered]@{ package_json = $PkgBackup; cordis_patch_yml = $PatchBackup }
  pre_sha256        = [ordered]@{ package_json = $prePkgHash; cordis_patch_yml = $prePatchHash }
  removed           = [ordered]@{
    bundles_entry     = $removedBundleEntry
    patch_block_lines = @($removedPatchLines)
  }
  note              = '本文件只记录"回退将被改动的那两个片段"。回退不整份覆盖 profile 配置 —— 整份覆盖会抹掉备份之后新增的无关条目。'
}
if (-not $DryRun) {
  try {
    Write-TextNoBom $RecordPath (($record | ConvertTo-Json -Depth 6) + "`r`n")
    Info "改动记录（含被删片段原文，人工还原时用）：$RecordPath"
  } catch { Warn "改动记录写入失败（不影响回退结果）：$($_.Exception.Message)" }
} else { Info "[DryRun] 会写改动记录：$RecordPath" }

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
