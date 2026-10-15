<#
============================================================================
 dsh-pipeline · 安装脚本（Windows PowerShell 5.1 / 7 均可）
============================================================================

 ⚠️ 本文件必须存为 **UTF-8 with BOM**。
    本机只有 PowerShell 5.1，它读取**无 BOM** 的 .ps1 时会按系统 ANSI 代码页
    解码；文件里只要有中文，就会解码失败并报「缺少右 }」之类的解析错误，
    脚本根本无法启动。用编辑器保存时请选 "UTF-8 with BOM"
    （VS Code：右下角编码 → Save with Encoding → UTF-8 with BOM）。

 做五件事，顺序固定，改任何文件之前先备份：

   1. 备份 profile 的 `cordis.patch.yml` 与 `package.json`（带时间戳，同目录）
   2. 把插件**运行期需要的文件**复制到 <profile>\node_modules\dsh-pipeline
   3. 清掉目标目录里上一轮可能留下的非运行期目录
   4. 把 "dsh-pipeline" 加进 <profile>\package.json 的 dsh.profile.bundles
   5. 往 <profile>\cordis.patch.yml 追加一条本插件的行（含 config）

 ⚠️ 不跑 pnpm、不装依赖：本插件**没有任何运行期第三方依赖**
     （只用 node 内置模块 + 可选的 DSH 核心包 `@deepseek-ai/dsh-tools`，
      后者由宿主提供；解析不到时会自动退化成恒等 defineTool，插件照样激活）。

 ⚠️ 本脚本**只动本插件自己的那一行**：往 bundles 里 append 一个名字、往
    cordis.patch.yml 末尾 append 一个条目。不改任何别人的条目，不重写整份文件。

 用法（在**普通** PowerShell 里跑）：

   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WithDocs
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
     -ProjectRoot "C:\path\to\your\repo" -GuardMainReadsCode:$false

 回滚见 rollback.ps1（它用同一批备份文件还原）。安装完脚本会**打印精确的
 回滚命令**，直接复制即可。

 生效方式：装完**需要重启 DSH**（Host 半边插件在启动时装载）。
============================================================================
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  # 流水线工作区根目录（.pipeline 就建在它下面）。留空 = 用 session 的工作目录。
  [string]$ProjectRoot = '',
  # 角色驱动通道：auto | subagent | manual
  [string]$Transport = 'auto',
  # 是否真的创建角色子代理会话。false = 只发令牌、不建会话（零 token 的演示模式）
  [switch]$NoSpawnRoles,
  # 是否拦截主对话读取代码正文
  [bool]$GuardMainReadsCode = $true,
  # 单条打回链最大次数
  [int]$MaxReworkPerLeg = 2,
  # L0 是否也拆出独立编排对话（规格歧义开关，见 README「待确认项」）
  [switch]$L0OrchestratorSeparate,
  # 只装运行期文件（默认）；加这个开关则把 tests / examples / REPORT.md 一起装过去
  [switch]$WithDocs,
  # ★ 不装自带的 stop-ladder Skill（默认装：Skill 是"引导"，拦截是代码，两者都要有）
  [switch]$NoSkill,
  # Skill 落到哪个 dsh-home 的 skills/ 下（默认跟 -DshHome 走）
  [string]$SkillsDir = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginSrc = $PSScriptRoot
$PluginName = 'dsh-pipeline'
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$PkgPath = Join-Path $ProfileDir 'package.json'
$TargetDir = Join-Path (Join-Path $ProfileDir 'node_modules') $PluginName
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# ★ 插件自带的 Skill（Stop Ladder 四问）落点：<dsh-home>/skills/stop-ladder/
$SkillSrc = Join-Path $PluginSrc 'skills'
$SkillsRoot = if ($SkillsDir -ne '') { $SkillsDir } else { Join-Path $DshHome 'skills' }
$SkillTarget = Join-Path $SkillsRoot 'stop-ladder'

# --- 要复制什么 ------------------------------------------------------------
# ⚠️ `tests/` **必须**默认装上：`pipeline_selftest` 工具依赖
#    `tests/selftest-core.mjs` —— "装完当场自检"是这个插件的核心卖点之一。
#    但只装 .mjs 源文件，不装 last-run.txt / demo-project 之类的产物。
#    `examples/` 与 `REPORT.md` 对运行没有贡献，只有 -WithDocs 才带。
$RuntimeItems = @(
  'index.js',
  'lib',
  'skills',
  'tests',
  'package.json',
  'cordis.patch.yml',
  # ★ 16 个角色专属 Agent 预设（源 + 生成物一起过去）。`package.json` 的
  #   `dsh.bundle.patch` 第二条引用的正是 `presets/generated/pipeline-presets.patch.yml`
  #   —— 少装这一项，那条 patch 就指向不存在的文件（整行不激活）。
  #   含 `generated/`：产物就在它下面，必须一起同步（`presets/apply.js` 也按同样口径）。
  'presets',
  'README.md',
  'ARCHITECTURE.md',
  'install.ps1',
  'rollback.ps1'
)
$DocItems = @('examples', 'REPORT.md', 'tools')

# 复制目录时要排除的产物（跑自测/样例生成的，与运行无关）。
$ExcludeNames = @('last-run.txt', '_run.log', '_err.txt', '_out.txt', '_patch.mjs', 'demo-project')

function Info($m) { Write-Host "[pipeline] $m" }
function Warn($m) { Write-Host "[pipeline] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[pipeline] 失败：$m" -ForegroundColor Red; exit 1 }
function Read-Text($p) { return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-TextNoBom($p, $t) {
  # 不要 BOM：Node 的 JSON.parse 不认 BOM
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $t, $enc)
}
function Get-DirSize($path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [int64]$sum
}
# 安全删除：只允许删 TargetDir 里面的东西。
function Remove-ChildSafely($child) {
  $full = [System.IO.Path]::GetFullPath($child)
  $rootFull = [System.IO.Path]::GetFullPath($TargetDir)
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Die "拒绝删除目标目录之外的东西：$full"
  }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

# ---------------------------------------------------------------------------
# 0) 前置检查
# ---------------------------------------------------------------------------
Info "插件源：$PluginSrc"
Info "profile：$ProfileDir"

if (-not (Test-Path -LiteralPath $PluginSrc -PathType Container)) { Die "找不到插件源目录：$PluginSrc" }
foreach ($f in @('index.js', 'package.json', 'cordis.patch.yml')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PluginSrc $f))) { Die "插件源缺少必需文件：$f" }
}
if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) { Die "找不到 profile 目录：$ProfileDir（-Profile 传错了吗？）" }
if (-not (Test-Path -LiteralPath $PatchPath)) { Die "找不到 $PatchPath" }
if (-not (Test-Path -LiteralPath $PkgPath)) { Die "找不到 $PkgPath" }

# 本脚本会**读**cordis.yml 确认它不是被手改过的那种，但绝不写它。
$CordisYml = Join-Path $ProfileDir 'cordis.yml'

# ---------------------------------------------------------------------------
# 1) 备份（改任何文件之前）
# ---------------------------------------------------------------------------
$PatchBackup = "$PatchPath.bak-$Stamp"
$PkgBackup = "$PkgPath.bak-$Stamp"

if (-not $DryRun) {
  Copy-Item -LiteralPath $PatchPath -Destination $PatchBackup -Force
  Copy-Item -LiteralPath $PkgPath -Destination $PkgBackup -Force
  Info "已备份：$PatchBackup"
  Info "已备份：$PkgBackup"
} else {
  Info "[DryRun] 会备份：$PatchPath → $PatchBackup"
  Info "[DryRun] 会备份：$PkgPath → $PkgBackup"
}

# ---------------------------------------------------------------------------
# 2) 计算要追加的内容（幂等：已存在就不重复加）
# ---------------------------------------------------------------------------
$pkgText = Read-Text $PkgPath
try { $pkg = $pkgText | ConvertFrom-Json } catch { Die "profile 的 package.json 不是合法 JSON，请先修好再装：$($_.Exception.Message)" }

$alreadyInBundles = $false
if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
  foreach ($b in $pkg.dsh.profile.bundles) { if ($b -eq $PluginName) { $alreadyInBundles = $true } }
}

$patchText = Read-Text $PatchPath
$alreadyInPatch = $patchText -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($PluginName))\s*$"

$spawnLine = if ($NoSpawnRoles) { '        spawnRoles: false' } else { '        spawnRoles: true' }
$guardLine = if ($GuardMainReadsCode) { '        guardMainReadsCode: true' } else { '        guardMainReadsCode: false' }
$l0Line = if ($L0OrchestratorSeparate) { '        l0OrchestratorSeparate: true' } else { '        l0OrchestratorSeparate: false' }
$rootLine = if ($ProjectRoot -ne '') { "        projectRoot: '$($ProjectRoot -replace '\\','/')'" } else { '' }

$patchBlock = @()
$patchBlock += ''
$patchBlock += '# --- dsh-pipeline（多对话 AI 协作开发流水线：主对话只调度，编写/测试/审核三权分立）---'
$patchBlock += '- insert:'
$patchBlock += "    - id: $PluginName"
$patchBlock += "      name: '$PluginName'"
$patchBlock += '      config:'
$patchBlock += '        enabled: true'
$patchBlock += '        guardEnabled: true'
$patchBlock += "        transport: $Transport"
$patchBlock += $spawnLine
$patchBlock += "        artifactDirName: .pipeline"
$patchBlock += "        maxReworkPerLeg: $MaxReworkPerLeg"
$patchBlock += $guardLine
$patchBlock += $l0Line
if ($rootLine -ne '') { $patchBlock += $rootLine }
$patchBlockText = ($patchBlock -join "`r`n") + "`r`n"

# ---------------------------------------------------------------------------
# 3) 复制运行期文件
# ---------------------------------------------------------------------------
# 复制一份目录树，顺手把产物（last-run.txt 之类）剔掉 —— 它们是跑出来的，
# 不是运行需要的，装过去只会让 node_modules 里多一堆过期报告。
function Copy-TreeFiltered($srcDir, $dstDir) {
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  foreach ($child in Get-ChildItem -LiteralPath $srcDir -Force) {
    if ($ExcludeNames -contains $child.Name) { continue }
    $dst = Join-Path $dstDir $child.Name
    if ($child.PSIsContainer) { Copy-TreeFiltered $child.FullName $dst }
    else { Copy-Item -LiteralPath $child.FullName -Destination $dst -Force }
  }
}

if (-not $DryRun) {
  if (-not (Test-Path -LiteralPath $TargetDir)) { New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null }
  foreach ($item in $RuntimeItems) {
    $src = Join-Path $PluginSrc $item
    if (-not (Test-Path -LiteralPath $src)) { Warn "跳过（源里没有）：$item"; continue }
    $dst = Join-Path $TargetDir $item
    if (Test-Path -LiteralPath $dst) { Remove-ChildSafely $dst }
    if ((Get-Item -LiteralPath $src).PSIsContainer) { Copy-TreeFiltered $src $dst }
    else { Copy-Item -LiteralPath $src -Destination $dst -Force }
  }
  if ($WithDocs) {
    foreach ($item in $DocItems) {
      $src = Join-Path $PluginSrc $item
      if (-not (Test-Path -LiteralPath $src)) { continue }
      $dst = Join-Path $TargetDir $item
      if (Test-Path -LiteralPath $dst) { Remove-ChildSafely $dst }
      if ((Get-Item -LiteralPath $src).PSIsContainer) { Copy-TreeFiltered $src $dst }
      else { Copy-Item -LiteralPath $src -Destination $dst -Force }
    }
  }
  # 自检依赖：没装过去的话 pipeline_selftest 会明说"不可用"，但那是降级体验。
  $selftestPath = Join-Path $TargetDir 'tests\selftest-core.mjs'
  if (-not (Test-Path -LiteralPath $selftestPath)) {
    Warn "警告：tests\selftest-core.mjs 没有装过去 —— pipeline_selftest 会不可用（其它工具与守门不受影响）。"
  }
  $size = Get-DirSize $TargetDir
  Info ("已复制运行期文件到：{0}（{1:N1} KB）" -f $TargetDir, ($size / 1KB))
} else {
  Info "[DryRun] 会复制到：$TargetDir"
  foreach ($item in $RuntimeItems) { Info "[DryRun]   + $item" }
  Info "[DryRun]   排除：$($ExcludeNames -join ', ')"
  if ($WithDocs) { foreach ($item in $DocItems) { Info "[DryRun]   + $item" } }
}

# ---------------------------------------------------------------------------
# 4) 把插件加进 dsh.profile.bundles（幂等、只 append）
# ---------------------------------------------------------------------------
if ($alreadyInBundles) {
  Info "package.json 的 dsh.profile.bundles 里已有 $PluginName，跳过。"
} else {
  # 用正则定位 bundles 数组，只往它末尾插一项 —— 不重新序列化整份 JSON，
  # 那样会丢掉原有格式/注释、并可能把别人的字段顺序打乱。
  $pattern = '(?s)("bundles"\s*:\s*\[)(.*?)(\s*\])'
  $m = [regex]::Match($pkgText, $pattern)
  if (-not $m.Success) { Die "在 package.json 里找不到 dsh.profile.bundles 数组，无法自动插入。请手工把 `"$PluginName`" 加进 bundles。" }
  $inner = $m.Groups[2].Value
  $trimmed = $inner.TrimEnd()
  $needsComma = ($trimmed.Length -gt 0 -and -not $trimmed.EndsWith(','))
  $newInner = $inner + $(if ($needsComma) { ',' } else { '' }) + "`r`n        `"$PluginName`"`r`n      "
  $newPkg = $pkgText.Substring(0, $m.Groups[2].Index) + $newInner + $pkgText.Substring($m.Groups[2].Index + $m.Groups[2].Length)
  if (-not $DryRun) {
    Write-TextNoBom $PkgPath $newPkg
    Info "已把 `"$PluginName`" 追加进 dsh.profile.bundles。"
  } else {
    Info "[DryRun] 会把 `"$PluginName`" 追加进 dsh.profile.bundles。"
  }
}

# ---------------------------------------------------------------------------
# 5) 往 cordis.patch.yml 追加本插件一行（幂等）
# ---------------------------------------------------------------------------
if ($alreadyInPatch) {
  Info "cordis.patch.yml 里已有 $PluginName 的条目，跳过。"
} else {
  if (-not $DryRun) {
    $append = $patchBlockText
    [System.IO.File]::AppendAllText($PatchPath, $append, (New-Object System.Text.UTF8Encoding($false)))
    Info "已往 cordis.patch.yml 追加 $PluginName 的条目。"
  } else {
    Info "[DryRun] 会往 cordis.patch.yml 追加："
    Write-Host $patchBlockText
  }
}

# ---------------------------------------------------------------------------
# 5.5) ★ 装插件自带的 Skill（stop-ladder 四问）
# ---------------------------------------------------------------------------
#
# 用户原话：「**Skill 由插件带，不许手工另建**」——
# 所以它躺在插件目录的 skills/ 下，由本脚本一步落到 <dsh-home>/skills/。
# 它回答的是"什么时候不该动手"；真正的拦截在插件的拦截缝里（见 lib/intercept.js）。
if ($NoSkill) {
  Info "按 -NoSkill，不装 stop-ladder Skill。"
} else {
  $skillMd = Join-Path (Join-Path $SkillSrc 'stop-ladder') 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillMd)) { Die "插件源缺少自带的 Skill：$skillMd" }
  if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $SkillTarget)) {
      New-Item -ItemType Directory -Path $SkillTarget -Force | Out-Null
    }
    Copy-Item -LiteralPath $skillMd -Destination (Join-Path $SkillTarget 'SKILL.md') -Force
    # 记一份"这次是谁装的"，方便 rollback 判断该不该撤
    Set-Content -LiteralPath (Join-Path $SkillTarget '.installed-by') -Value $PluginName -Encoding UTF8
    Info "已装 Skill：$SkillTarget\SKILL.md"
  } else {
    Info "[DryRun] 会装 Skill 到：$SkillTarget\SKILL.md"
  }
}

# ---------------------------------------------------------------------------
# 6) 收尾：打印精确回滚命令
# ---------------------------------------------------------------------------
$rollbackCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $TargetDir 'rollback.ps1')`" -Stamp $Stamp -Profile $Profile"

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Green
if ($DryRun) { Write-Host ' dsh-pipeline 安装预演完成（DryRun：没有改任何文件）' -ForegroundColor Green }
else { Write-Host ' dsh-pipeline 安装完成' -ForegroundColor Green }
Write-Host '======================================================================' -ForegroundColor Green
Write-Host ''
Write-Host '生效方式：' -ForegroundColor Yellow
Write-Host '  · 插件本体（工具 / 守门 / 拦截缝）：**需要重启 DSH**（Host 半边在启动时装载；无第三方运行期依赖）。'
Write-Host '  · 自带的 stop-ladder Skill：**下一次会话就能看到**（技能目录是每次会话扫描的）。'
Write-Host '  · 拦截缝（tools/pre-execute · agent/pre-step · tools/post-execute）：随插件一起生效；'
Write-Host '    它只对**本插件派出去的管线席位**生效，其它会话一律直通；'
Write-Host '    想整体关掉：翻右上角总开关（即时），或把配置里的 intercept 设成 false（需重启）。'
Write-Host ''
Write-Host '装完请先做这三件事：'
Write-Host '  1) 重启 DSH，在日志里找这两行，确认装上了：'
Write-Host "     [pipeline] dsh-pipeline 0.1.0 已加载：17 个 pipeline_* 工具已注册；...；多AI 协调开关=**开**（...）。"
Write-Host "     [pipeline] 开关 UI 端点已挂载：GET/POST /.dsh-pipeline/state（右上角「多AI 协调」按钮走它）。"
Write-Host '  2) 看窗口右上角头部那一排（⋯ 菜单与右侧栏切换按钮之间）有没有出现'
Write-Host '     「● 多AI 协调 开」这个胶囊按钮；点一下应当立即变成「关」。'
Write-Host '     看不到按钮也不影响使用：调 pipeline_switch 工具同样能切。'
Write-Host '  3) 在任意对话里调一次 pipeline_selftest（不带参数即可），它会当场跑完'
Write-Host '     正例全流程 + 10 组反例 + 分档验证，并原样打出每条拒绝理由。'
Write-Host ''
Write-Host '★ 精确回滚命令（复制即用）：' -ForegroundColor Yellow
Write-Host "  $rollbackCmd" -ForegroundColor Yellow
Write-Host ''
Write-Host "  或者用当前插件目录里的 rollback.ps1（不需要先用 install.ps1 装过）："
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PluginSrc\rollback.ps1`" -Stamp $Stamp -Profile $Profile"
Write-Host ''
Write-Host '备份文件（手工还原时用）：'
Write-Host "  $PkgBackup"
Write-Host "  $PatchBackup"
if (Test-Path -LiteralPath $CordisYml) {
  Write-Host ''
  Write-Host "提示：cordis.yml（$CordisYml）本脚本**没有动过** —— 它是一份空入口列表，配置在 patch 层。"
}
