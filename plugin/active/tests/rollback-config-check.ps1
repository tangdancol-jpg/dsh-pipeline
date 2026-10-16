<#
============================================================================
 dsh-pipeline · rollback.ps1 配置回退的回归检查
============================================================================

 为什么要有这一套（真机缺陷，2026-10-16）：

   现象：主窗口提问面板 fallback 成 raw JSON；而且"修好一阵子又复发"。

   根因：`rollback.ps1` 旧版会把 install 时的备份**整份 `Copy-Item -Force`
        盖回** profile 的 `package.json` / `cordis.patch.yml`。install 之后
        用户又往 `dsh.profile.bundles` 里加了 `dsh-askcard-row`（提问行渲染
        覆盖插件）—— 整份覆盖把它**静默抹掉**，它的 bundle patch 就不再被
        读到，客户端半边不加载 ⇒ 面板退回 raw JSON。每回滚一次抹一次。

 本套钉住三条（全部在**临时副本**上跑，绝不碰真 profile）：

   ① 回退后 `dsh-askcard-row` **仍在**（本次缺陷的核心回归）
   ② 回退后 `dsh-pipeline` 条目**已被移除**（该生效的部分仍生效）——
      含两个位置：末位（install append 的形状）与中间位
   ③ 幂等：连跑两次，第二次不改任何字节

 用法：

   powershell -NoProfile -ExecutionPolicy Bypass -File tests\rollback-config-check.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File tests\rollback-config-check.ps1 -Keep

 退出码：0 = 全绿；1 = 有失败。
 ★ 全程密闭：只在系统临时目录里造 profile 副本，跑完即删（-Keep 可保留排查）。
============================================================================
#>
[CmdletBinding()]
param(
  # 保留临时目录（排查用；默认跑完就删）
  [switch]$Keep,
  # 显式指定要检查的 rollback.ps1（默认取本脚本上一级目录里的那份）
  [string]$RollbackPath = ''
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host "  [PASS] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Head($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }

$passed = 0
$failed = 0
function Assert($cond, $what) {
  if ($cond) { $script:passed++; Ok $what } else { $script:failed++; Bad $what }
}

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($RollbackPath -eq '') { $RollbackPath = Join-Path (Split-Path -Parent $HERE) 'rollback.ps1' }
if (-not (Test-Path -LiteralPath $RollbackPath)) { Write-Host "找不到 rollback.ps1：$RollbackPath" -ForegroundColor Red; exit 1 }

Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host ' rollback.ps1 配置回退回归检查（临时副本，不碰真 profile）' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor Cyan
Info "被测脚本：$RollbackPath"
$rbHash = (Get-FileHash -LiteralPath $RollbackPath -Algorithm SHA256).Hash
Info "脚本 SHA256：$($rbHash.Substring(0,16))…"

# ---------------------------------------------------------------------------
# 夹具：一份"install 之后又加过无关条目"的 profile 副本
# ---------------------------------------------------------------------------
# ★ 关键：bundles 里有 `dsh-askcard-row`（**在 install 加 dsh-pipeline 之后**
#    才加进去的）—— 这正是旧版整份覆盖会抹掉的那一条。
# ★ 另外 dependencies 里有一个**同名** `"dsh-pipeline"` 键：回退只许摘 bundles
#    里的那一条，绝不许碰 dependencies（旧版正则扫全文，这里钉死作用域）。
# ★ json 尾巴上还有一段 `"extra"` 字段：证明"数组之外的内容一个字节都不动"。
$pkgTemplate = @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-orb": "0.1.7",
    "dsh-pipeline": "file:../../dsh-pipeline/repo/plugin/active",
    "dsh-whale-widget": "^0.4.2"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-orb",
        "dsh-archigate",
        "dsh-pipeline",
        "dsh-askcard-row"
      ]
    }
  },
  "extra": {
    "untouched": true
  }
}
'@

# install 时的备份：**不含** `dsh-askcard-row` —— 真机就是这样（install 先备份，
# `dsh-askcard-row` 是此后才被加进 bundles 的）。
# ★ 夹具里**必须**放这个备份文件：旧版 rollback.ps1 只有"找得到备份"时才走
#   `Copy-Item -Force` 整份覆盖那条路。不放备份 = 复现不出真机缺陷 = 本套会变成假绿。
$pkgBackupTemplate = @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-orb": "0.1.7",
    "dsh-pipeline": "file:../../dsh-pipeline/repo/plugin/active",
    "dsh-whale-widget": "^0.4.2"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-orb",
        "dsh-archigate",
        "dsh-pipeline"
      ]
    }
  },
  "extra": {
    "untouched": true
  }
}
'@

# 末位形状：`dsh-pipeline` 就在 bundles 最后一项（= install.ps1 append 之后的真实形状）
$pkgTemplateLast = @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-pipeline": "file:../../dsh-pipeline/repo/plugin/active"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-orb",
        "dsh-pipeline"
      ]
    }
  }
}
'@

# cordis.patch.yml 的**备份**版本：到 dsh-pipeline 那个块为止（没有 askcard 块）
$patchBackupTemplate = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard

# --- dsh-archigate（把 normify 校验 → archify 交付固化成机制）---
- id: dsh-archigate
  name: 'dsh-archigate'
  config:
    enabled: true

# --- dsh-pipeline（多对话 AI 协作开发流水线：主对话只调度，编写/测试/审核三权分立）---
- insert:
    - id: dsh-pipeline
      name: 'dsh-pipeline'
      config:
        enabled: true
        guardEnabled: true
'@

# cordis.patch.yml 的**现状**版本：在 dsh-pipeline 之后又加了 askcard 那个块
$patchTemplate = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard

# --- dsh-archigate（把 normify 校验 → archify 交付固化成机制）---
- id: dsh-archigate
  name: 'dsh-archigate'
  config:
    enabled: true

# --- dsh-pipeline（多对话 AI 协作开发流水线：主对话只调度，编写/测试/审核三权分立）---
- insert:
    - id: dsh-pipeline
      name: 'dsh-pipeline'
      config:
        enabled: true
        guardEnabled: true

# --- dsh-askcard-row（提问行渲染覆盖：输入+JSON → 问题+可点选项）---
# 本插件没有 config 字段（Host 半边是空实现），所以这条 insert 不需要写 config。
- insert:
    - id: dsh-askcard-row
      name: 'dsh-askcard-row'
'@

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-rbcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$profDir = Join-Path (Join-Path $root 'profiles') 'desktop'
$null = New-Item -ItemType Directory -Force -Path $profDir
$encNoBom = New-Object System.Text.UTF8Encoding($false)

# 造一副 profile 副本。$WithBackup = 同时放 install 时的 `.bak-*` 备份文件
# （旧版只有备份在场时才会走整份覆盖 —— 复现真机缺陷的必要条件）。
function New-Fixture($pkgText, [switch]$WithBackup) {
  Get-ChildItem -LiteralPath $profDir -Filter '*.bak-*' -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText((Join-Path $profDir 'package.json'), $pkgText, $encNoBom)
  [System.IO.File]::WriteAllText((Join-Path $profDir 'cordis.patch.yml'), $patchTemplate, $encNoBom)
  if ($WithBackup) {
    # 备份 = install 那一刻的样子（还没有 askcard）
    [System.IO.File]::WriteAllText((Join-Path $profDir 'package.json.bak-20261011-181931'), $pkgBackupTemplate, $encNoBom)
    [System.IO.File]::WriteAllText((Join-Path $profDir 'cordis.patch.yml.bak-20261011-181931'), $patchBackupTemplate, $encNoBom)
  }
}
function Run-Rollback {
  # 真跑被测脚本；DshHome 指向临时根 ⇒ 它只会动临时副本
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $RollbackPath `
    -Profile desktop -DshHome $root 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out }
}
function Get-Bundles($path) {
  return @((Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).dsh.profile.bundles)
}
function Read-All($path) { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }

try {
  # =========================================================================
  # 场景 A：install 之后又加了 dsh-askcard-row（真机那个形状）
  # =========================================================================
  Head '【场景 A】回退后 dsh-askcard-row 必须还在（本次缺陷的核心回归）'
  New-Fixture $pkgTemplate -WithBackup
  $pkgPath = Join-Path $profDir 'package.json'
  $patchPath = Join-Path $profDir 'cordis.patch.yml'
  $pkgBefore = Read-All $pkgPath
  $patchBefore = Read-All $patchPath

  # 先证明"诱因在场"：install 时的备份确实存在，而且确实**没有** askcard。
  # （没有这一条，本套可能因为"根本没触发整份覆盖"而变成假绿。）
  $bakPkg = Join-Path $profDir 'package.json.bak-20261011-181931'
  Assert (Test-Path -LiteralPath $bakPkg) '诱因在场：install 时的 package.json 备份存在（旧版会拿它整份覆盖）'
  Assert (-not ((Read-All $bakPkg) -match 'dsh-askcard-row')) '诱因在场：那份备份里**没有** dsh-askcard-row'

  # 回退前的原始行数（下面用来核"改动记录不许比事实少"）
  $patchLinesBefore = ([System.IO.File]::ReadAllLines($patchPath, [System.Text.Encoding]::UTF8)).Count

  $r1 = Run-Rollback
  Assert ($r1.code -eq 0) "回退退出码 = 0（实际 $($r1.code)）"
  if ($r1.code -ne 0) { Info $r1.out }

  $bundlesA = Get-Bundles $pkgPath
  # ① 核心回归
  Assert ($bundlesA -contains 'dsh-askcard-row') '① 回退后 dsh.profile.bundles 里 dsh-askcard-row 仍在'
  Assert ((Read-All $pkgPath) -ne (Read-All $bakPkg)) '回退**没有**把整份备份盖回来（现文件 ≠ 备份文件）'
  # ② 该生效的部分仍生效
  Assert (-not ($bundlesA -contains 'dsh-pipeline')) '② 回退后 dsh.profile.bundles 里 dsh-pipeline 已移除'
  # 作用域：dependencies 里的同名键不许被误伤
  $depsA = (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).dependencies
  Assert ($null -ne $depsA.'dsh-pipeline') '作用域：dependencies 里的 dsh-pipeline 依赖键未被误删'
  Assert (@($depsA.PSObject.Properties).Count -eq 3) '作用域：dependencies 条目数未变（3）'
  # 其它 bundles 条目一个不多一个不少
  $expectA = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-orb', 'dsh-archigate', 'dsh-askcard-row')
  Assert ((Compare-Object $expectA $bundlesA).Count -eq 0) "其它 bundles 条目一个不多一个不少（期望 $($expectA.Count) 条，实际 $($bundlesA.Count) 条）"
  # bundles 数组之外的内容一个字节都没动
  Assert (((Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).extra.untouched) -eq $true) '数组之外的 "extra" 字段原样保留'
  Assert ((Read-All $pkgPath).Length -lt $pkgBefore.Length) 'package.json 确实被改写（少了一条）'

  # cordis.patch.yml 那半边
  $patchA = Read-All $patchPath
  Assert ($patchA -match 'dsh-askcard-row') '① cordis.patch.yml 里 dsh-askcard-row 的条目仍在'
  Assert ($patchA -notmatch 'id:\s*dsh-pipeline') '② cordis.patch.yml 里 dsh-pipeline 的条目已移除'
  Assert ($patchA -match 'id:\s*dsh-archigate') 'cordis.patch.yml：别的插件条目（dsh-archigate）原样保留'
  Assert ($patchA -match 'id:\s*ui-chat') 'cordis.patch.yml：别的插件条目（ui-chat）原样保留'
  Assert ($patchA.StartsWith('# Your patch layer')) 'cordis.patch.yml：文件头注释未被吃掉'
  Assert ($patchA.Length -lt $patchBefore.Length) 'cordis.patch.yml 确实被改写（少了那个块）'

  # 改动记录：它取代了"整份备份"，所以必须真能当人工还原的依据 ——
  # 被删的**每一行**都要在里面（少一行，将来就照抄不回来）。
  $recFile = Get-ChildItem -LiteralPath $profDir -Filter '.dsh-pipeline-rollback-*.json' -Force -ErrorAction SilentlyContinue |
    Select-Object -First 1
  Assert ($null -ne $recFile) '改动记录文件已落盘（取代整份备份）'
  if ($null -ne $recFile) {
    $rec = (Read-All $recFile.FullName) | ConvertFrom-Json
    $recLines = @($rec.removed.patch_block_lines)
    Assert ($rec.removed.bundles_entry -eq 'dsh-pipeline') '改动记录：bundle 条目名记下来了'
    Assert (@($recLines | Where-Object { $_ -match '^\s*-\s*id:\s*dsh-pipeline\s*$' }).Count -eq 1) '改动记录：含被删的 `- id: dsh-pipeline` 行'
    Assert (@($recLines | Where-Object { $_ -match '^\s*-\s*insert:\s*$' }).Count -eq 1) '改动记录：含被删的 `- insert:` 行'
    Assert (@($recLines | Where-Object { $_ -match '^\s*#\s*---\s*dsh-pipeline' }).Count -eq 1) '改动记录：含被删的标记注释行'
    Assert (@($recLines | Where-Object { $_ -match "^\s*name:\s*'dsh-pipeline'\s*$" }).Count -eq 1) '改动记录：含被删的 name 行'
    Assert ($rec.note -match '整份覆盖') '改动记录：写明了"为什么不整份覆盖"'
    # 记录下来的行数要等于文件真正少掉的行数（记录不许比事实少）
    $goneLines = ([System.IO.File]::ReadAllLines($patchPath, [System.Text.Encoding]::UTF8)).Count
    Assert (($patchLinesBefore - $goneLines) -eq $recLines.Count) "改动记录行数 = 文件实际少掉的行数（$($recLines.Count) vs $($patchLinesBefore - $goneLines)）"
  }

  # =========================================================================
  # ③ 幂等：连跑第二次，两个文件一个字节都不许变
  # =========================================================================
  Head '【③ 幂等】连跑第二次：结果必须与第一次逐字节相同'
  $pkgAfter1 = Read-All $pkgPath
  $patchAfter1 = Read-All $patchPath
  $r2 = Run-Rollback
  Assert ($r2.code -eq 0) "第二次回退退出码 = 0（实际 $($r2.code)）"
  if ($r2.code -ne 0) { Info $r2.out }
  Assert ((Read-All $pkgPath) -eq $pkgAfter1) '第二次跑完 package.json 逐字节不变'
  Assert ((Read-All $patchPath) -eq $patchAfter1) '第二次跑完 cordis.patch.yml 逐字节不变'
  Assert ((Get-Bundles $pkgPath) -contains 'dsh-askcard-row') '第二次跑完 dsh-askcard-row 依然在'
  # 用 ASCII 判据（不匹配中文）：子进程输出经管道往返可能有代码页折损，
  # 而 `dsh-pipeline` 这个名字在告警里是纯 ASCII，判得稳。
  Assert ($r2.out -match 'dsh-pipeline') '第二次跑明确报告了"没有可摘的条目"（不是静默）'

  # =========================================================================
  # 场景 B：dsh-pipeline 在 bundles 末位、且**没有备份**（走最小手术那条路）
  # =========================================================================
  Head '【场景 B】dsh-pipeline 在末位 + 无备份（install.ps1 append 的真实形状）'
  New-Fixture $pkgTemplateLast
  Assert (@(Get-ChildItem -LiteralPath $profDir -Filter '*.bak-*' -File).Count -eq 0) '本场景刻意不放备份（强制走最小手术路径）'
  $r3 = Run-Rollback
  Assert ($r3.code -eq 0) "回退退出码 = 0（实际 $($r3.code)）"
  if ($r3.code -ne 0) { Info $r3.out }
  $jsonOk = $true
  try { $null = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json } catch { $jsonOk = $false }
  Assert $jsonOk '末位摘除后 package.json 仍是合法 JSON（无尾随逗号残留）'
  $bundlesB = Get-Bundles $pkgPath
  Assert (-not ($bundlesB -contains 'dsh-pipeline')) '末位 dsh-pipeline 已被摘掉'
  Assert ($bundlesB.Count -eq 2) "剩余条目数 = 2（实际 $($bundlesB.Count)）"
  Assert (-not ((Read-All $pkgPath) -match ',\s*\]')) '数组末尾没有留下多余逗号'

  # =========================================================================
  # 场景 C：package.json 被压成**单行**（bundles 数组不再"一条一行"）
  # =========================================================================
  # 为什么要这一条：本节第一版用的是「条目独占一行」的正则，在单行 JSON 上
  # 一条也摘不掉（静默退化成"无需摘除"）。这个场景就是那次漏检的固化判据。
  Head '【场景 C】compact 单行 JSON（条目不独占一行）'
  $compactCases = @(
    @{ n = '中间项'; json = '{ "dsh": { "profile": { "bundles": [ "a", "dsh-pipeline", "dsh-askcard-row" ] } } }'; left = 2 },
    @{ n = '末项';   json = '{ "dsh": { "profile": { "bundles": [ "a", "dsh-pipeline" ] } } }';                    left = 1 },
    @{ n = '首项';   json = '{ "dsh": { "profile": { "bundles": [ "dsh-pipeline", "a" ] } } }';                    left = 1 }
  )
  foreach ($c in $compactCases) {
    New-Fixture $c.json
    $r = Run-Rollback
    $okJson = $true
    try { $null = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json } catch { $okJson = $false }
    $bb = if ($okJson) { @(Get-Bundles $pkgPath) } else { @() }
    Assert $okJson "compact/$($c.n)：摘除后仍是合法 JSON"
    Assert (-not ($bb -contains 'dsh-pipeline')) "compact/$($c.n)：dsh-pipeline 已被摘掉"
    Assert ($bb.Count -eq $c.left) "compact/$($c.n)：剩余条目数 = $($c.left)（实际 $($bb.Count)）"
  }

  # =========================================================================
  # 附：真 profile 的只读复查（不算成败，只报告）
  # =========================================================================
  Head '【附·只读】真 profile 的 askcard_in_bundles（不改任何东西）'
  $realPkg = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') 'desktop\package.json'
  if (Test-Path -LiteralPath $realPkg) {
    $realBundles = Get-Bundles $realPkg
    $inB = $realBundles -contains 'dsh-askcard-row'
    if ($inB) { Ok "真 profile：askcard_in_bundles = True（$($realBundles.Count) 条）" }
    else { Bad "真 profile：askcard_in_bundles = False —— 面板会退回 raw JSON！用下面的复查命令确认后修回。" }
  } else { Info "  （找不到真 profile：$realPkg，跳过）" }
} finally {
  if ($Keep) { Info ''; Info "临时目录保留：$root" }
  else { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '======================================================================' -ForegroundColor Cyan
if ($failed -eq 0) {
  Write-Host " rollback.ps1 配置回退回归检查：$passed/$passed 通过" -ForegroundColor Green
} else {
  Write-Host " rollback.ps1 配置回退回归检查：$passed/$($passed + $failed) 通过 —— $failed 条失败" -ForegroundColor Red
}
Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '★ 随时可粘贴的复查命令（每次 install / rollback 后一秒确认面板组件还在）：' -ForegroundColor Yellow
Write-Host '  （直接粘进 PowerShell 回车即可；应打印 askcard_in_bundles = True）' -ForegroundColor Yellow
Write-Host '  $b=(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw|ConvertFrom-Json).dsh.profile.bundles; "askcard_in_bundles = $($b -contains ''dsh-askcard-row'')"' -ForegroundColor Yellow
Write-Host ''

exit $(if ($failed -eq 0) { 0 } else { 1 })
