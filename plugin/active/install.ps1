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
     -ProjectRoot "<path\to\your\repo>" -GuardMainReadsCode:$false

 安装目录 / 工作目录**不在本文件里写死**：它们走「读目录设定」（见下面 §0a，
  与插件运行期的 `lib/dirs.js` 是同一份判据）—— 命令行参数 > 环境变量 >
  配置文件 <DSH 用户目录>\dsh-pipeline.dirs.json > 运行时推导。
  怎么覆盖见 `docs/directory-settings.md`。

 环境预检（§0b）：若「workspace 根包住了 %TEMP%」，受限 shell 会全部失败。
  本脚本只**告警 + 给出修法**，不中止安装；显式修法是 -SetUserTempRoot <目录>
  （默认关闭 —— 它会改掉所有用户进程的 temp 落点）。

 回滚见 rollback.ps1（它用同一批备份文件还原）。安装完脚本会**打印精确的
 回滚命令**，直接复制即可。

 生效方式：装完**需要重启 DSH**（Host 半边插件在启动时装载）。
============================================================================
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  # ★ DSH 用户目录（安装落点）。留空 = 按「读目录设定」解析（见下面 §0a）：
  #   环境变量 DSH_PIPELINE_DSH_HOME → 配置文件 dsh-pipeline.dirs.json → 宿主导出的
  #   DSH_HOME → $env:USERPROFILE\.dsh。**默认值一律运行时求值**，
  #   脚本里没有个人路径字面量 —— 换个机器、换个用户名照样能用。
  [string]$DshHome = '',
  # 流水线工作区根目录（.pipeline 就建在它下面）。留空 = 按「读目录设定」解析
  #   （DSH_PIPELINE_PROJECT_ROOT → 配置文件 → 当前目录）。
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
  # Skill 落到哪个 dsh-home 的 skills/ 下（默认跟「读目录设定」算出的 dsh-home 走）
  [string]$SkillsDir = '',
  # ★ 显式把**用户级** TEMP/TMP 落成持久值（落盘位置 HKCU\Environment）。
  #   默认空 = 不动。理由见下面「0b) 环境预检」那一段的说明。
  [string]$SetUserTempRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0a) ★★ **读目录设定** —— 安装目录 / 工作目录的**唯一出处**
# ---------------------------------------------------------------------------
#
# 需求原话：「**换个机器、换个用户名照样能用**」。所以本脚本里不许出现某个人的
# 绝对路径：机器的差异只能从**运行时环境**推导，并且要留一个**能覆盖**的口子。
#
# 判据与插件运行期**同一份**（`plugin/active/lib/dirs.js`）—— 改一处要改两处，
# 两边读的是同一个配置文件、同一组环境变量。
#
# ---------------------------------------------------------------------------
# 取值顺序（四条，从高到低；**别改顺序**）
# ---------------------------------------------------------------------------
#   ① 命令行参数     -DshHome / -ProjectRoot / -SkillsDir
#   ② 环境变量       DSH_PIPELINE_DSH_HOME / DSH_PIPELINE_PROJECT_ROOT /
#                    DSH_PIPELINE_SKILLS_DIR
#   ③ 配置文件       <DSH 用户目录>/dsh-pipeline.dirs.json
#                    （落点本身可用 DSH_PIPELINE_DIRS_FILE 覆盖）
#   ④ 运行时推导     DSH_HOME → $env:USERPROFILE\.dsh（非 Windows 退 $env:HOME/.dsh）；
#                    工作目录 = 当前目录
#
# ★ 配置文件里认三个字段：{"dshHome": …, "projectRoot": …, "skillsDir": …}。
#   相对路径按**配置文件自己所在的目录**解析 —— 那样整份文件连同它描述的
#   相对布局可以一起搬到别的机器上。
# ★ 文件读不到 / 读坏了 / 字段类型不对一律**不中止安装**，只退回下一级来源并告警。
#
# 找配置文件的这一步有个**先有鸡还是先有蛋**：dshHome 本身可以被配置文件覆盖，
# 而配置文件又在 dshHome 下面。取舍是：**找文件只用环境变量与推导值**，
# 文件里写的 dshHome 只影响"目录是谁"，**不回头改变文件的位置**，所以不会绕圈。

$DirsFileName = 'dsh-pipeline.dirs.json'

# ④ 运行时推导：宿主亲口说的 DSH_HOME > 用户主目录下的 .dsh。全是运行时求值。
function Get-DerivedDshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
    return [System.IO.Path]::GetFullPath($env:DSH_HOME)
  }
  $home = if ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') { $env:USERPROFILE }
  elseif ($env:HOME -and $env:HOME.Trim() -ne '') { $env:HOME }
  else { (Get-Location).Path }
  return [System.IO.Path]::GetFullPath((Join-Path $home '.dsh'))
}

# 相对路径 → 绝对路径（基准：配置文件所在目录 / 当前目录）。
function ConvertTo-DirPath($value, $base) {
  $s = if ($null -eq $value) { '' } else { ([string]$value).Trim() }
  if ($s -eq '') { return '' }
  if ([System.IO.Path]::IsPathRooted($s)) { return [System.IO.Path]::GetFullPath($s) }
  return [System.IO.Path]::GetFullPath((Join-Path $base $s))
}

$DirsFile = if ($env:DSH_PIPELINE_DIRS_FILE -and $env:DSH_PIPELINE_DIRS_FILE.Trim() -ne '') {
  ConvertTo-DirPath $env:DSH_PIPELINE_DIRS_FILE (Get-Location).Path
} else {
  Join-Path (Get-DerivedDshHome) $DirsFileName
}
$DirsFileBase = Split-Path -Parent $DirsFile
$DirsFromFile = @{}
$DirsFileNote = ''
if (Test-Path -LiteralPath $DirsFile -PathType Leaf) {
  try {
    $dirsJson = (Get-Content -LiteralPath $DirsFile -Raw -Encoding UTF8) | ConvertFrom-Json
    foreach ($k in @('dshHome', 'projectRoot', 'skillsDir')) {
      $v = $dirsJson.$k
      if ($v -is [string] -and $v.Trim() -ne '') { $DirsFromFile[$k] = $v.Trim() }
    }
  } catch {
    $DirsFileNote = "配置文件不是合法 JSON，已忽略：$($_.Exception.Message)"
  }
} else {
  $DirsFileNote = '（还没有这份文件 —— 用默认推导值；想固定下来就按 docs/directory-settings.md 建一份）'
}

# ①→②→③→④ 逐个字段走一遍，并记下最终是谁说了算（排障时一眼看出）。
# 返回 @{ Value=<绝对路径>; Source=<人读的出处>; Kind=<machine 可判的出处> }；
# Kind ∈ explicit | env | file | derived —— 调用方按它决定"要不要写进 patch"。
function Resolve-PipelineDir($explicit, $envName, $fileKey) {
  if ($explicit -and $explicit.Trim() -ne '') { return @{ Value = (ConvertTo-DirPath $explicit (Get-Location).Path); Source = '命令行参数'; Kind = 'explicit' } }
  $ev = [Environment]::GetEnvironmentVariable($envName)
  if ($ev -and $ev.Trim() -ne '') { return @{ Value = (ConvertTo-DirPath $ev (Get-Location).Path); Source = "环境变量 $envName"; Kind = 'env' } }
  if ($DirsFromFile.ContainsKey($fileKey)) { return @{ Value = (ConvertTo-DirPath $DirsFromFile[$fileKey] $DirsFileBase); Source = "配置文件 $DirsFileName"; Kind = 'file' } }
  return $null
}

$DshHomeR = Resolve-PipelineDir $DshHome 'DSH_PIPELINE_DSH_HOME' 'dshHome'
if (-not $DshHomeR) { $DshHomeR = @{ Value = (Get-DerivedDshHome); Source = '运行时推导（DSH_HOME / 用户主目录）'; Kind = 'derived' } }
$DshHome = $DshHomeR.Value

# ⚠️ skillsDir 的兜底基准是**已经定下来的 dshHome**，不是最初的推导值。
$SkillsRootR = Resolve-PipelineDir $SkillsDir 'DSH_PIPELINE_SKILLS_DIR' 'skillsDir'
if (-not $SkillsRootR) { $SkillsRootR = @{ Value = (Join-Path $DshHome 'skills'); Source = '推导（<dsh-home>/skills）'; Kind = 'derived' } }
$SkillsRoot = $SkillsRootR.Value

$ProjectRootR = Resolve-PipelineDir $ProjectRoot 'DSH_PIPELINE_PROJECT_ROOT' 'projectRoot'
if (-not $ProjectRootR) { $ProjectRootR = @{ Value = (Get-Location).Path; Source = '运行时推导（当前目录）'; Kind = 'derived' } }
$ProjectRoot = $ProjectRootR.Value

$PluginSrc = $PSScriptRoot
$PluginName = 'dsh-pipeline'
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$PkgPath = Join-Path $ProfileDir 'package.json'
$TargetDir = Join-Path (Join-Path $ProfileDir 'node_modules') $PluginName
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# ★ 插件自带的 Skill（Stop Ladder 四问）落点：<dsh-home>/skills/stop-ladder/
$SkillSrc = Join-Path $PluginSrc 'skills'
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
Info "读目录设定：dsh-home = $DshHome（来自：$($DshHomeR.Source)）"
Info "            工作目录 = $ProjectRoot（来自：$($ProjectRootR.Source)）"
Info "            skills   = $SkillsRoot（来自：$($SkillsRootR.Source)）"
Info "            配置文件 = $DirsFile"
if ($DirsFileNote -ne '') { Warn "            $DirsFileNote" }

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
# 0b) ★ 环境预检：DSH 的 workspace 根不得包住 %TEMP%
# ---------------------------------------------------------------------------
#
# 上游判据（读 DSH 实现得来，不是推测）：
#
#   @deepseek-ai/dsh-sandbox-windows-acl  lib/types-*.js
#     function assertTempRootOutsideWorkspace(workspaceRoot, tempRoot) {
#       if (containsDirectory(workspaceRoot, tempRoot)) throw new Error(
#         `Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`);
#     }
#
#   抛出的调用点：@deepseek-ai/dsh-sandbox-local  lib/index.js
#     materializeAclGrant(sessionId, workspaceRoot) {
#       assertTempRootOutsideWorkspace(workspaceRoot, tmpdir());   // ← 抛在这里
#     }
#
#   其中 workspaceRoot = **会话的 cwd**（不是 process.cwd()）；
#   tempRoot = **宿主进程的 os.tmpdir()**（Windows 上先取 %TMP% 再取 %TEMP%，
#   TMPDIR 被忽略；同一个文件里用它 mkdtemp 出 dsh-XXXXXX 那个目录）。
#
# ⇒ 只要「会话 workspace 根」是 %TEMP% 的祖先，该会话里每一次受限的
#   workspace-write shell 调用都会抛上面那句。最常见的触发形态：
#   拿**用户主目录**当 workspace 开会话 —— %TEMP% 正好在它下面。
#
# ★ 为什么这里只告警、不中止安装：这是环境配置问题，装插件本身不受影响。
# ★ 为什么插件层**修不了**它：被检查的是宿主进程的 os.tmpdir()，上游是写死的
#   tmpdir() 调用，**没有任何配置键**能覆盖；插件跑在另一个进程里，改不了
#   已经启动的宿主的进程环境。唯一能动的杠杆是宿主进程的 TEMP/TMP 环境变量
#   —— 见下面的 -SetUserTempRoot。
#
# ★ 本段**不出现任何个人路径字面量**：temp 根与候选 workspace 根一律运行时求值
#   （$env:TMP / $env:TEMP / GetTempPath / $env:USERPROFILE）。
function Get-HostTempRoot {
  # 取值顺序与 Win32 GetTempPathW 一致：先 TMP，再 TEMP。
  foreach ($v in @($env:TMP, $env:TEMP)) {
    if ($v -and $v.Trim() -ne '' -and (Test-Path -LiteralPath $v)) {
      return [System.IO.Path]::GetFullPath($v)
    }
  }
  return [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
}
function Test-PathInside($root, $candidate) {
  # 与上游 containsDirectory 同口径：按**路径段**判包含关系（不做裸前缀比较，
  # 否则 C:\a 会把 C:\ab 误判成它的子目录）。
  try {
    $r = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
    $c = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
  } catch { return $false }
  if ($r -eq '') { return $false }
  if ($r -eq $c) { return $true }
  return $c.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

$HostTemp = Get-HostTempRoot
# 候选 workspace 根：DSH 会用**会话的 cwd**，而安装期拿不到未来的会话 cwd，
# 所以检查三个最可能的形态（当前目录 / 「读目录设定」算出的工作目录 / 用户主目录）。
$WsCandidates = @()
$WsCandidates += [pscustomobject]@{ Label = '当前目录'; Path = (Get-Location).Path }
if ($ProjectRoot -ne '' -and $ProjectRoot -ne (Get-Location).Path) {
  $WsCandidates += [pscustomobject]@{ Label = '读目录设定的工作目录'; Path = $ProjectRoot }
}
if ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') {
  $WsCandidates += [pscustomobject]@{ Label = '用户主目录'; Path = $env:USERPROFILE }
}
$TempInside = @($WsCandidates | Where-Object { Test-PathInside $_.Path $HostTemp })

Info "环境预检：宿主 temp 根 = $HostTemp"
if ($TempInside.Count -gt 0) {
  Warn '----------------------------------------------------------------------'
  Warn '环境预检：DSH 的 workspace 根**包住了** %TEMP%'
  Warn '          => 以它当 workspace 的会话，受限 shell 会**全部**失败'
  Warn '----------------------------------------------------------------------'
  foreach ($t in $TempInside) { Warn "  命中：$($t.Label) = $($t.Path)" }
  Warn ''
  Warn '上游会这样报错（原文）：'
  Warn "  Windows ACL temp root must be outside the workspace: workspace=$($TempInside[0].Path); temp=$HostTemp"
  Warn ''
  Warn '修法（任选一条，按推荐顺序）：'
  Warn '  1) ★ 换一个**更窄**的目录当 workspace 开会话，别用用户主目录：'
  Warn '     先 cd 到项目目录，再从那里开会话（本预检就会变绿）。'
  Warn '  2) 启动 DSH **之前**，在同一个进程里把 temp 指到 workspace 之外：'
  Warn '     $outside = Join-Path $env:SystemDrive ''dsh-tmp''   # 任何 workspace 之外的目录都行'
  Warn '     $env:TEMP = $outside; $env:TMP = $outside'
  Warn '     想落成持久值：本脚本的 -SetUserTempRoot <那个目录>（见下）。'
  Warn '  3) 该会话改用 read-only / danger-full-access —— 只有 workspace-write 会走到这条检查。'
  Warn '----------------------------------------------------------------------'
} else {
  Info '环境预检：没有「workspace 根包住 %TEMP%」的形态 —— 该检查不会触发。'
}

# -SetUserTempRoot：把**用户级** TEMP/TMP 落成持久值（显式开关，默认不动）。
# ★ 为什么默认不动：这会改掉**所有**用户进程的 temp 落点（机器级副作用），
#   一个插件安装器不该悄悄做这件事；而且它只对**新启动**的进程生效。
if ($SetUserTempRoot -ne '') {
  $NewTemp = [System.IO.Path]::GetFullPath($SetUserTempRoot)
  if (-not (Test-Path -LiteralPath $NewTemp -PathType Container)) {
    Die "-SetUserTempRoot 指向的目录不存在：$NewTemp"
  }
  foreach ($t in $WsCandidates) {
    if (Test-PathInside $t.Path $NewTemp) {
      Die "-SetUserTempRoot 给的新 temp 根仍落在 workspace（$($t.Label) = $($t.Path)）里，没有意义：$NewTemp"
    }
  }
  $oldT = [Environment]::GetEnvironmentVariable('TEMP', 'User')
  $oldP = [Environment]::GetEnvironmentVariable('TMP', 'User')
  if ($DryRun) {
    Info "[DryRun] 会把**用户级** TEMP/TMP 设为：$NewTemp"
    Info "[DryRun]   当前用户级值：TEMP='$oldT'  TMP='$oldP'"
    Info '[DryRun]   落盘位置：HKCU\Environment'
  } else {
    [Environment]::SetEnvironmentVariable('TEMP', $NewTemp, 'User')
    [Environment]::SetEnvironmentVariable('TMP', $NewTemp, 'User')
    Info "已把**用户级** TEMP/TMP 设为：$NewTemp（落盘位置：HKCU\Environment）"
    Info '★ 只对**新启动**的进程生效 —— 必须重启 DSH，宿主才会读到新值。'
    Info "  原值：TEMP='$oldT'  TMP='$oldP'"
    Info '  撤销（恢复成原来的值，或直接删掉这两个用户级变量）：'
    Info "    [Environment]::SetEnvironmentVariable('TEMP', '$oldT', 'User')"
    Info "    [Environment]::SetEnvironmentVariable('TMP',  '$oldP', 'User')"
  }
}

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
# ★ 只有**显式指定**工作目录（命令行 / 环境变量 / 配置文件）时才把它写进 patch。
#   推导出来的"当前目录"**不写** —— 那等于把**这台机器的绝对路径**烙进 profile 的
#   配置里，正是"换个机器换用户名照样能用"要消灭的东西。不写 = 插件按 session
#   工作目录走，与改前行为逐字一致。
$rootLine = if ($ProjectRootR.Kind -ne 'derived') { "        projectRoot: '$($ProjectRoot -replace '\\','/')'" } else { '' }

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
