/**
 * dsh-pipeline · 守门 · shell 命令判据
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * ★ 本文件超 400 行，按 `CONVENTIONS.md` §4 的「必要性 ①」不拆：它是一份**按顺序执行的
 *   判据清单**（4a / 4b / 4c / 4e / 4f / 4g / 4h + P0-3 主对话边界），各段共享同一批
 *   词表（写动词 / 只读命令 / 路径抽取 / 临时目录判定）。切开必须先把这些原语抽成
 *   第三个模块，而抽取过程中最容易发生的正是"某一支的判据换了一份词表"——那会静默放宽。
 *
 * @module dsh-pipeline/lib/guard/shell
 */

import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { classifyTestCommand, sameTestCommand } from '../testscope.js'
import { isInside, pathKey } from '../util.js'
import { NO_CODE_READ_ROLES, roleZh, TAG } from './rules.js'
import { whyShellWriteRefused } from './attribution.js'
import { describeChangeScope, owningChangeScopeEntry } from './seats.js'
// ★★ P0-2（浏览器 Profile / 凭证数据卫生）：shell 侧的复制 / 写入判据。
//    为什么接在这里：本轮 P0-2 的现场动作是「从用户目录**复制**进工作区」，
//    而 4a 只看"写动词 + 命令里出现项目根的绝对路径" —— 相对目标从那条缝里漏了过去。
import { browserProfileShellRefusal } from './browser-profile.js'

// ---------------------------------------------------------------------------
// shell 命令扫描（best-effort）
// ---------------------------------------------------------------------------

/**
 * 「会改文件」的命令特征 —— **定义已收敛到 `lib/guard/shell-text.js`**（缺陷 ⑧ 的落点：
 * 它必须在"命令位置"上匹配，不能拿引号里回显用的英文单词当命令）。
 * 这里**既要本地绑定**（本模块多处直接用它），**又对外转出**（供测试与文档引用）。
 */
import { SHELL_WRITE_RE, hasWriteVerbOutsideQuotes, stripQuotedSegments as stripShellQuotes } from './shell-text.js'
export { SHELL_WRITE_RE, hasWriteVerbOutsideQuotes, stripShellQuotes }
/**
 * 内联解释器（`node -e` / `python -c` / `pwsh -Command` …）里的写文件 API。
 * 命令行上只看得见"跑了个 node"，真正的写入藏在代码串里 —— 这是 P1-4 点名的绕过形态。
 */
const SHELL_INLINE_CODE_RE = /(^|[\s|;&(])(node|python3?|py|perl|ruby|pwsh|powershell)(\.exe)?\s[^|;&]*?(-e|-p|-c|--eval|-command)\b/i
const INLINE_WRITE_API_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|rmSync|unlinkSync|unlink|rmdirSync|mkdirSync|WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|shutil\.\w+|os\.(remove|rename|replace|unlink|makedirs|mkdir)|write_text|write_bytes|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b|\bopen\([^)]*,\s*["'][wax+]/
/** 「会读文件」的命令特征。 */
const SHELL_READ_RE = /(^|[\s|;&(])(get-content|gc|cat|type|more|head|tail|select-string|sls|findstr|grep|rg|awk|strings|xxd|od|less)\b/i
/** ★「检索内容」的命令特征（它们**返回的就是代码正文**，与 `head`/`less` 之类并列但单独判）。 */
const SHELL_CONTENT_SEARCH_RE = /(^|[\s|;&(])(select-string|sls|findstr|grep|rg|ripgrep|ag|ack)\b/i
/** 管道写文件（目标在参数里，取不到 ⇒ 按写处理）。 */
const SHELL_PIPE_WRITE_RE = /\|\s*(out-file|set-content|add-content|tee(-object)?)\b/i

// ★ `stripShellQuotes` 已收敛到 `lib/guard/shell-text.js`（在上面 re-export）。

/** 空设备：写到这里等于丢弃，不是写文件。 */
const NULL_DEVICE_RE = /^(\$null|nul|\/dev\/null)$/i
/** 明确指向临时目录的写入目标（在项目根之外）。 */
const TEMP_TARGET_RE = /^(\$env:(temp|tmp)|%(temp|tmp)%|\$tmpdir|\$\{tmpdir\}|\/tmp\/)/i

/**
 * 命令里**真正写文件**的重定向目标（P1-4：改前见到任何 `>` 都判成写）。
 * 不算写的：`2>&1` / `*>&1` 这类句柄合并、写到空设备、引号里的 `>`、`=>` / `->` / `>=` 这类运算符。
 * @param {string} text
 * @returns {string[]}
 */
export function shellRedirectTargets(text) {
  const s = stripShellQuotes(text)
  const out = []
  const re = /(?<![=\-<>])(?:\d|\*)?>>?(?![=&])\s*([^\s|;&<>()]+)?/g
  let m = re.exec(s)
  while (m !== null) {
    const target = String(m[1] ?? '').replace(/^["']|["']$/g, '')
    if (!NULL_DEVICE_RE.test(target)) out.push(target)
    m = re.exec(s)
  }
  return out
}

/** 这个重定向目标会不会落进项目根（取不准就当会 —— 宁可多拦）。 */
function redirectHitsProject(target, lowerRoot) {
  if (target.length === 0) return true
  if (TEMP_TARGET_RE.test(target)) return false
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\\\')) {
    return lowerRoot.length > 0 && isInside(lowerRoot, pathKey(target))
  }
  // 相对路径：不知道工作目录在哪 ⇒ 按落在项目里处理（与改前一样保守）
  return true
}

/**
 * ★ 测试类命令的判据（`writer` 不跑测试）。
 *
 * 只认**明确的测试执行形态**，刻意**不**拦"构建/启动级冒烟"：
 *   · 拦：`npm test` / `npm run test:unit` / `npx jest` / `pytest` / `go test` /
 *        `cargo test` / `node --test` / `node tests/xxx.mjs` / `--coverage`
 *   · 不拦：`npm run build` / `node build.mjs` / `node -e "..."` / `tsc --noEmit`
 *     —— 这些是"我写的代码能不能装上/起得来"，不是"它是否满足验收标准"。
 *
 * ⚠️ 自测的**最小限度**（"冒烟算不算测试判定""`selftest_result` 还要不要"）
 * 与 `writer` 的既有 summary 里那句"自测结果"存在冲突，
 * 已列进 README「待确认项」**等用户拍板**；这一层可以用
 * `guardWriterRunsTests: false` 整体关掉。
 *
 * @param {string} cmd
 * @returns {{what:string, matched:string} | null}
 */
export function scanTestRunnerCommand(cmd) {
  const text = String(cmd ?? '')
  if (text.length === 0) return null
  const rules = [
    // 包管理器的 test 脚本（连同 test:unit / test:watch 这类变体）
    { re: /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?t(est)?([\s:.-]|$)/i, what: '包管理器的 test 脚本（npm test / npm run test:unit）' },
    // npx 拉起来的测试运行器
    { re: /(^|[\s;&|(])(npx|pnpx|bunx|yarn\s+dlx)\s+\S*(jest|vitest|mocha|ava|tap|jasmine|karma|cypress|playwright|cucumber|newman)/i, what: '测试运行器（npx jest / npx vitest …）' },
    // 直接调起的测试运行器
    { re: /(^|[\s;&|(])(jest|vitest|mocha|ava|jasmine|karma|cypress|pytest|py\.test|nose2?|tox|rspec|phpunit|unittest|testcafe)(\s|$)/i, what: '测试运行器（pytest / jest / rspec …）' },
    // python -m pytest / unittest
    { re: /(^|[\s;&|(])python[0-9.]*\s+-m\s+(pytest|unittest|nose2?)\b/i, what: 'python -m pytest / unittest' },
    // 语言自带的测试子命令
    { re: /(^|[\s;&|(])(go|cargo|dotnet|swift|dart|mvn|gradle|gradlew|rake|ant|sbt)\s+[\w:.-]*test\b/i, what: '语言自带的测试子命令（go test / cargo test / dotnet test …）' },
    // 测试运行标志
    { re: /(^|\s)--(test|coverage|runTestsByPath|testPathPattern|reporter)\b/i, what: '测试运行标志（--test / --coverage）' },
    // 直接跑测试目录下的脚本（含带一个开关的形态：pwsh -File tests/x.ps1）
    { re: /(^|[\s;&|(])(node|deno|bun|ts-node|tsx|pwsh|powershell|bash|sh|ruby|php|python[0-9.]*)\s+(-\S+\s+)?[^\s;&|]*[/\\]?(tests?|__tests__|spec)\b/i, what: '直接执行测试目录下的脚本（node tests/xxx.mjs / pwsh -File tests/x.ps1）' },
  ]
  for (const r of rules) {
    const m = r.re.exec(text)
    if (m !== null) return { what: r.what, matched: m[0].trim() }
  }
  return null
}

/**
 * 把一段自由文本归一化成"可做包含判断"的形式：反斜杠转正斜杠、统一小写。
 *
 * ★ 为什么必须小写：`pathKey()` 只在**整串以盘符开头**时小写化。一条命令
 *   形如 `Get-Content "C:\x\y.js"` 经 pathKey 后是 `get-content "c:/x/y.js"`
 *   —— 首字符不是盘符，所以**没有被小写**，而任务根是 `c:/x`。两边直接
 *   `includes` 在 Windows 上**永远不成立**，shell 旁路判据会静默失效。
 *   自测里"测试用 shell 旁路改项目源码""主对话用 shell 读项目代码"两条
 *   就是给这个坑留的回归用例。
 */
function normText(s) {
  return String(s ?? '').replace(/\\/g, '/').toLowerCase()
}

/**
 * ★★ **B9：按"真实文件身份"判"这条命令是不是在读代码正文"**。
 *
 * 现场（2026-10-12）：
 *   · 主对话读取 `profiles\desktop` 下的**回滚快照目录名**与一份 **223 字节的 cordis 配置**
 *     被拦，理由写的是「主对话不得通过 shell 读取项目代码」—— 那两样**都不是代码正文**；
 *   · 更麻烦的是**同形状命令一次放行、一次拒绝**（当晚 3 次拦截里 1 次不稳定）⇒
 *     编写席没法靠"改写法"绕过去。
 *
 * 根因：判据是 `命令里出现了项目根这个**目录前缀**` ⇒ **任何**路径（哪怕是个目录名、
 *   哪怕是一份 yaml 配置）只要落在根下就算"读代码"。这是**按目录前缀**判的，
 *   不是按文件身份判的。
 *
 * 修法：把候选路径抽出来，逐个**解析成真实路径**再看它的身份：
 *   · 源码扩展名（或 `Makefile` / `Dockerfile` 这类无扩展名的源码）⇒ **算读代码**；
 *   · 非源码扩展名（`.yml/.json/.md/.txt/.log/.jsonl/.zstd/.png` …）⇒ **不算**；
 *   · 纯目录（列目录名）、不存在的路径 ⇒ **不算**（"列出快照目录名"不是"读代码正文"）；
 *   · 会话 / 日志 / 存储 / 备份 / 流水线台账目录下的任何东西 ⇒ **不算**。
 *
 * ★ 确定性：这条判据只依赖 `(命令串, 任务根, 文件系统状态)`，**不依赖任何缓存**，
 *   所以同一条命令在同样的现场**必然**得到同一个结论。
 */

/** 算作"代码正文"的扩展名（按身份判，不按目录前缀判）。 */
export const SOURCE_CODE_EXTS = Object.freeze([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'rb', 'php', 'pl', 'pm', 'lua', 'r',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'swift', 'dart', 'ex', 'exs', 'erl',
  'hs', 'ml', 'clj', 'groovy', 'asm', 's', 'f90', 'vb', 'vue', 'svelte',
])

/** 无扩展名但确实是源码的文件名。 */
const SOURCE_CODE_BASENAMES = Object.freeze(['makefile', 'dockerfile', 'rakefile', 'gemfile', 'cmakelists.txt'])

/** 这些目录下的东西**一律不算**代码正文（哪怕扩展名像）。 */
const NON_CODE_DIR_SEGMENTS = Object.freeze(['sessions', 'logs', 'storages', 'cache', '.pipeline', 'node_modules', '_plugin-backups', '_session-backups', '_staged-pkgs', 'attachments', 'skills', 'dsh_orb'])

/**
 * 一条路径算不算"代码正文"（**纯函数**：只看路径字符串与它是不是目录/是否存在）。
 *
 * @param {string} raw - 命令里抽出来的候选路径（可能带引号）
 * @param {string} root - 任务根（相对路径按它解析）
 * @param {(p:string)=>{exists:boolean, isDir:boolean}|null} [probe] - 探测函数（默认不探测）
 * @returns {boolean}
 */
export function looksLikeSourcePath(raw, root, probe) {
  const s = String(raw ?? '').replace(/["']/g, '').replace(/\\/g, '/').trim()
  if (s.length === 0) return false
  const lower = s.toLowerCase()
  for (const seg of NON_CODE_DIR_SEGMENTS) {
    if (lower.includes(`/${seg}/`) || lower.endsWith(`/${seg}`)) return false
  }
  const base = lower.split('/').pop() ?? ''
  if (SOURCE_CODE_BASENAMES.includes(base)) return true
  const dot = base.lastIndexOf('.')
  if (dot < 0) {
    // 没有扩展名：可能是目录（列目录名不算读代码），也可能是无扩展名脚本 —— 靠探测说话。
    if (typeof probe === 'function') {
      const st = probe(s)
      if (st !== null && st !== undefined && st.isDir === true) return false
    }
    return false
  }
  return SOURCE_CODE_EXTS.includes(base.slice(dot + 1))
}

/** 从一条命令里抽出候选路径（引号内的优先，其次是裸路径 token）。 */
export function extractCommandPaths(text) {
  const out = []
  const push = (v) => {
    const s = String(v ?? '').replace(/["']/g, '').trim()
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }
  const reQ = /["']([^"']+)["']/g
  let m = reQ.exec(text)
  while (m !== null) {
    push(m[1])
    m = reQ.exec(text)
  }
  const reBare = /(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s"';|&()]+/g
  let n = reBare.exec(text)
  while (n !== null) {
    push(n[0])
    n = reBare.exec(text)
  }
  return out
}

// ---------------------------------------------------------------------------
// ★★ P0-3（2026-10-19）：**主对话的 shell 边界**（口径：`design/conventions/03-shell边界.md`）
// ---------------------------------------------------------------------------
//
// 口径一句话：**主对话可以动"环境"，不可以动"交付物"与"源码"**。
//
//   放行（本段不新增判据，按既有分类走）：
//     · 环境级只读 / 探活：`Get-ChildItem` / `Get-Content`（非源码）/ `Test-Path` /
//       `Select-String` / `Measure-Object` / `Get-Process` / `Test-NetConnection` /
//       `Invoke-WebRequest`（无 `-OutFile`）/ `curl`（无 `-o`）/ `git status|log|diff` …
//     · **清理本单临时残留**：`Remove-Item` 只允许落在
//       ① 本单报告目录 `<taskSelfDir>/reports/**`（设计档 §2 的"清理本单测试残留"）；
//       ② 系统临时目录（`$env:TEMP` / `%TEMP%` / `/tmp/`）。
//   拒绝（本段**补既有 4a 漏掉的形态**；既有拒绝原文一个字不变）：
//     · shell 写 / 删 / 改交付根与源码树 —— 目标点到项目根的照旧走 4a（既有文案）；
//       相对路径 / 取不准目标的写与删由本段拒（4a 的 `mentionsProtectedPath` 有缝）；
//     · `Start-Process`（及 `start-job` 等）启动任意程序 —— 只允许完全落在临时目录的形态；
//     · `git` 写操作（checkout / reset / clean / add / commit / push …）—— 只读 git 照旧放行；
//     · 删流水线台账（`task.json` / `handoffs/` / `audit.jsonl`）—— 清残留不等删证据。
//
// ★ 三条"不许变坏"的边界：
//   ① **只对 `main` 生效** —— 非 main 席位的判据（4a / 4b / 4e / 4f …）一个字不动；
//   ② **只放行限定路径的清理 / 临时写入** —— 目标必须能证明落在"本单 reports"或"临时目录"；
//      证明不了（相对路径、变量拼接、取不到）一律不放行；
//   ③ **只补漏、不抢既有文案** —— 目标落在项目根内的写/删让 4a/4c 先拒（既有测试钉着原文）。
// ★ 默认启用（`cfg.guardMainShellBoundary !== false`）；**不改 `lib/config.js`**：
//   不传这个键就是启用，只有显式传 false 才关。

/** 删除类命令（与 4c 同一份词表；只用于"这条命令在删东西"的判断）。 */
const MAIN_REMOVE_RE = /(^|[\s|;&(])(remove-item|rm|rmdir|del|erase|rd)\b/i
/** 起进程类命令（只认**命令位置**上的；`Get-Process` 之类不受影响）。 */
const MAIN_START_RE = /^(start-process|saps|start-job|start-threadjob)\b/i
/**
 * `git` 写操作（只认命令位置上的 git；`git -C <path> status` 这类只读照旧放行）。
 * ★ 覆盖：改工作区 / 改索引 / 改远端 / 改分支。
 */
const MAIN_GIT_WRITE_RE =
  /^git(?:\.exe)?(?:\s+(?:-[Cc]\s+\S+|--no-pager|--git-dir(?:=\S+)?|--work-tree(?:=\S+)?))*\s+(checkout|restore|apply|reset|clean|stash|am|rm|mv|add|commit|push|pull|merge|rebase|switch|tag|init|clone)\b/i
/** `git stash list|show` 是**只读**查询 —— 别因为 `stash` 在写操作名单里就误伤。 */
const MAIN_GIT_STASH_READONLY_RE =
  /^git(?:\.exe)?(?:\s+(?:-[Cc]\s+\S+|--no-pager|--git-dir(?:=\S+)?|--work-tree(?:=\S+)?))*\s+stash\s+(list|show)\b/i
/** URL 不是文件目标（探活命令里的地址不该参与"目标路径"判断）。 */
const URL_TOKEN_RE = /^[a-z][a-z0-9+.-]*:\/\//i
/** 命令里**提到**系统临时目录（不要求出现在开头；与 `TEMP_TARGET_RE` 的分工见调用处）。 */
const MAIN_TEMP_MENTION_RE = /\$env:(?:temp|tmp)\b|%temp%|%tmp%|\$tmpdir|\$\{tmpdir\}|\/tmp\//i

/** 系统临时目录（pathKey 归一化；取不到就空串）。 */
function mainShellTempRoot() {
  try {
    return pathKey(tmpdir())
  } catch {
    return ''
  }
}

/**
 * 把 `$env:TEMP\...` / `%TEMP%\...` / `/tmp/...` 展开成**真实路径键**（能展开就展开）。
 *
 * ★ 为什么要展开而不是直接当"临时目录"：`$env:TEMP\..\项目\src` 这种写法会**逃出**临时目录，
 *   只看前缀就放行等于给了一条绕过口子（P0-3 的静态判据也不能自己挖洞）。
 *   展开失败（环境变量缺失）时返回 `null`，由调用方按"证明不了"处理（不放行）。
 *
 * @param {string} raw
 * @returns {string|null}
 */
function expandTempToken(raw) {
  const s = String(raw ?? '').trim()
  const re = /^(?:\$env:(temp|tmp)|%(temp|tmp)%|\$tmpdir|\$\{tmpdir\}|\/tmp\/)/i
  const m = re.exec(s)
  if (m === null) return null
  const base =
    typeof process.env.TEMP === 'string' && process.env.TEMP.length > 0
      ? process.env.TEMP
      : typeof process.env.TMP === 'string' && process.env.TMP.length > 0
        ? process.env.TMP
        : m[1] !== undefined || m[2] !== undefined || m[5] !== undefined
          ? process.platform === 'win32'
            ? ''
            : '/tmp'
          : ''
  if (base.length === 0) return null
  const rest = s.slice(m[0].length)
  return pathKey(join(base, rest))
}

/**
 * 把命令里的一个目标 token 归一成"可比较的绝对路径键"。
 *
 * @param {string} raw
 * @param {object} task - 同步索引条目（要 `projectRoot`）
 * @returns {string} `''` = 不是文件目标（URL / 空）；`'$TEMP'` = 明确写向系统临时目录（展开失败时的兜底）
 */
function mainShellTargetKey(raw, task) {
  const s = String(raw ?? '').replace(/["']/g, '').trim().replace(/\\/g, '/')
  if (s.length === 0) return ''
  if (URL_TOKEN_RE.test(s)) return ''
  const expanded = expandTempToken(s)
  if (expanded !== null) return expanded
  if (TEMP_TARGET_RE.test(s)) return '$TEMP'
  const root = typeof task?.projectRoot === 'string' ? task.projectRoot : ''
  if (isAbsolute(s)) return pathKey(s)
  if (root.length === 0) return ''
  return pathKey(join(root, s))
}

/** 这些目标是不是**全部**落在给定的根里（空列表 = 证明不了 = false）。 */
function mainShellAllInside(targets, roots, task, opts = {}) {
  const list = Array.isArray(targets) ? targets.filter((t) => typeof t === 'string' && t.length > 0) : []
  const usableRoots = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r.length > 0)
  if (list.length === 0 || usableRoots.length === 0) return false
  const projectKey = typeof task?.projectRoot === 'string' ? pathKey(task.projectRoot) : ''
  const outsideProject = opts.outsideProject === true
  return list.every((t) => {
    const key = mainShellTargetKey(t, task)
    if (key.length === 0) return false
    if (key === '$TEMP') return true
    return usableRoots.some((r) => {
      if (!isInside(r, key)) return false
      /**
       * ★ 项目根**本身就在系统临时目录下**时（自测夹具都是这种形状），
       *   "临时目录"这条豁免不能把项目里的文件也放进来 —— 否则 `src/` 也跟着被放行。
       *   判据：根**在项目根之外**（临时目录）时，目标不许落进项目根；
       *   根**在项目根之内**（本单 reports）时照常放行（那是显式允许的清理范围）。
       */
      if (outsideProject && projectKey.length > 0 && isInside(projectKey, key) && !isInside(projectKey, r)) return false
      return true
    })
  })
}

/** 按"命令分隔符"切段（**不按管道切**：管道是数据流，不是另一条独立命令）。 */
function mainShellSegments(unquoted) {
  return String(unquoted ?? '')
    .split(/;|\r?\n|&&|\|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 目标 token 列表：命令里点名的路径（引号内 / 裸绝对路径）+ 真写文件的重定向目标。 */
function mainShellTargets(text) {
  const raw = extractCommandPaths(text)
  /**
   * ★ `extractCommandPaths` 对**引号内的相对路径**会给出两条：完整那条 + 裸正则从中间
   *   再抓到的尾巴（`.pipeline/T/reports/x` → 还会多一条 `/T/reports/x`）。
   *   尾巴那条按"相对路径"解析会落到别的目录，把合法清理判成越界 —— 这里去掉
   *   "是另一条更长路径后缀"的重复项。只做去重，不改变任何单条路径的解析方式。
   */
  const norm = raw.map((p) => String(p ?? '').replace(/\\/g, '/'))
  const out = raw.filter((p, i) => !norm.some((q, j) => j !== i && q.length > norm[i].length && q.endsWith(norm[i])))
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }
  // `$env:TEMP\...` / `%TEMP%\...` 这类目标不会被上面那两条正则抽到（它们不是以盘符 / `/` 开头），
  // 但对 P0-3 很重要（"临时目录里的写/删"要能证明）。这里单独补一条。
  const reTemp = /(?:\$env:(?:temp|tmp)|%temp%|%tmp%|\$tmpdir|\$\{tmpdir\})[\\/][^\s"';|&()]*/gi
  let m = reTemp.exec(text)
  while (m !== null) {
    push(m[0])
    m = reTemp.exec(text)
  }
  for (const t of shellRedirectTargets(text)) push(t)
  return out
}

/** 拒绝文案里通用的"主对话该走哪条正路"（与 4a 同一份归因出处）。 */
function mainShellAlternatives() {
  return (
    whyShellWriteRefused('main') +
    '★ 允许的替代形态（主对话能动"环境"，不能动"交付物/源码"）：\n' +
    '  · 写文件 → 用 **write / edit 工具**（受同一套角色与授权面规则约束；shell 是字符串匹配，相对路径会误伤）；\n' +
    '  · 只检查 → 用**只读命令**（`Get-ChildItem` / `Test-Path` / `Get-Content` 非源码文件 / `Select-String`）或 `pipeline_status`；\n' +
    '  · 清理本单残留 → 只允许删**本单报告目录** `<任务>/.pipeline/<任务id>/reports/**` 与**系统临时目录**；\n' +
    '  · 收尾旧单 → 走 **pipeline_task_purge**（终态单的唯一具名入口，有审计留痕）。'
  )
}

/** 主对话"用 shell 写文件"的拒绝文案。 */
function mainShellWriteRefusal(text, task) {
  return (
    `${TAG} 拒绝：主对话不得用 shell 写 / 改文件（交付根与源码树尤其不行）。\n` +
    `任务：${task?.taskId ?? '(未知)'}\n命令片段：${String(text ?? '').slice(0, 200)}\n` +
    '★ 判据：主对话的 shell 只做**环境级**操作（只读 / 探活 / 清理本单残留）；写交付物与源码不是它的活。\n' +
    mainShellAlternatives()
  )
}

/** 主对话"清理范围越界"的拒绝文案。 */
function mainShellCleanupRefusal(text, task) {
  return (
    `${TAG} 拒绝：主对话用 shell 删东西，**只允许删本单临时残留**。\n` +
    `任务：${task?.taskId ?? '(未知)'}\n命令片段：${String(text ?? '').slice(0, 200)}\n` +
    '★ 允许的清理范围（且路径要写**绝对路径** —— 相对路径取不准一律按拒处理）：\n' +
    `  · 本单报告目录：${typeof task?.reportsDir === 'string' ? task.reportsDir : '<项目根>/.pipeline/<任务id>/reports'}/**\n` +
    '  · 系统临时目录：`$env:TEMP` / `$env:TMP` / `/tmp/`；\n' +
    '★ **流水线台账不能删**（task.json / handoffs / audit.jsonl 是可追溯凭据）—— 清残留不等于删证据。\n' +
    mainShellAlternatives()
  )
}

/** 主对话"起进程"的拒绝文案。 */
function mainShellProcessRefusal(text, task) {
  return (
    `${TAG} 拒绝：主对话不得用 shell 启动任意程序（Start-Process / start-job …）。\n` +
    `任务：${task?.taskId ?? '(未知)'}\n命令片段：${String(text ?? '').slice(0, 200)}\n` +
    '★ 原因：起进程 = **任意代码执行**，等于用 shell 绕开"主对话不写交付面"这条边界；' +
    '静态判据看不到新进程里会写哪里。\n' +
    '★ 允许的替代形态：\n' +
    '  · 探活 → 用**只读命令**（`Test-NetConnection` / `Invoke-WebRequest` 无 `-OutFile` / `Get-Process` / `curl` 无 `-o`）；\n' +
    '  · 起服务 / 跑程序属于**环境级操作**：需要时让用户执行，或派执行席位做（它们有各自的能力边界）；\n' +
    '  · 真要在本单临时目录里起一个短命进程 → 把路径写**绝对路径**且全部落在临时目录（本判据只放行这一种形态）。\n' +
    mainShellAlternatives()
  )
}

/** 主对话"git 写操作"的拒绝文案。 */
function mainShellGitWriteRefusal(text, task) {
  return (
    `${TAG} 拒绝：主对话不得用 shell 做 **git 写操作**（checkout / reset / clean / add / commit / push …）。\n` +
    `任务：${task?.taskId ?? '(未知)'}\n命令片段：${String(text ?? '').slice(0, 200)}\n` +
    '★ 原因：git 写操作会改工作区 / 索引 / 分支 —— 那是交付面与源码树，不是"环境级只读"。\n' +
    '★ 允许的替代形态：**只读 git**（`git status` / `git log` / `git diff` / `git show`）照旧放行；' +
    '要提交/回滚/切分支 → 让用户执行，或由计划/编写走结构化交接物。\n' +
    mainShellAlternatives()
  )
}

/**
 * ★★ **主对话 shell 边界判据**（P0-3 的唯一出处）。
 *
 * 返回三态（调用方按顺序决定）：
 *   · `{ action: 'allow' }` —— 明确放行（只限"本单临时残留清理 / 临时目录写入 / 临时目录起进程"）；
 *   · `{ action: 'deny', message }` —— 明确拒绝（本段补的是既有 4a 漏掉的形态，文案带替代形态）；
 *   · `{ action: 'pass' }` —— 本段不表态，交给既有判据（**既有拒绝原文一个字不变**）。
 *
 * @param {string} cmd - shell 命令原文
 * @param {object} task - 同步索引条目（`projectRoot` / `pipelineDir` / `reportsDir` / `taskId`）
 * @returns {{action:'allow'|'deny'|'pass', message?:string}}
 */
export function judgeMainShellBoundary(cmd, task) {
  const text = String(cmd ?? '')
  if (text.trim().length === 0) return { action: 'pass' }

  const unquoted = stripShellQuotes(text)
  const segments = mainShellSegments(unquoted)
  const lowerText = normText(text)
  const lowerRoot = normText(task?.projectRoot ?? '')
  const lowerPipeline = normText(task?.pipelineDir ?? '')
  const mentionsProject =
    (lowerRoot.length > 0 && lowerText.includes(lowerRoot)) || (lowerPipeline.length > 0 && lowerText.includes(lowerPipeline))

  const tempRoot = mainShellTempRoot()
  const reportsDir = typeof task?.reportsDir === 'string' ? pathKey(task.reportsDir) : ''
  /** 清理允许的根：本单报告目录 + 系统临时目录（顺序无关）。 */
  const cleanupRoots = [tempRoot, reportsDir].filter((r) => r.length > 0)
  /** 写文件 / 起进程允许的根：**只有**系统临时目录（本单 reports 是"清理"，不是"写"）。 */
  const tempRoots = [tempRoot].filter((r) => r.length > 0)

  const targets = mainShellTargets(text)
  const redirects = shellRedirectTargets(text).filter((t) => String(t ?? '').length > 0)
  const tempMentioned = MAIN_TEMP_MENTION_RE.test(text) || (tempRoot.length > 0 && lowerText.includes(tempRoot))
  const inlineWriteHidden = SHELL_INLINE_CODE_RE.test(text) && INLINE_WRITE_API_RE.test(text)

  // ① 起进程：只允许**完全落在临时目录**的形态（其余一律拒 —— P0-3 的"任意程序"口子）。
  if (segments.some((seg) => MAIN_START_RE.test(seg))) {
    const confined =
      targets.length > 0 &&
      mainShellAllInside(targets, tempRoots, task, { outsideProject: true }) &&
      tempMentioned &&
      !mentionsProject &&
      redirects.length === 0 &&
      !inlineWriteHidden
    if (confined) return { action: 'allow' }
    return { action: 'deny', message: mainShellProcessRefusal(text, task) }
  }

  // ② git 写操作：只读 git 不在此列；写操作一律拒（它改的就是工作区/索引）。
  if (segments.some((seg) => MAIN_GIT_WRITE_RE.test(seg) && !MAIN_GIT_STASH_READONLY_RE.test(seg))) {
    return { action: 'deny', message: mainShellGitWriteRefusal(text, task) }
  }
  /**
   * ★ 剩下的**纯 git 命令**都是只读查询（写操作上面已经拒了）——直接交给既有判据，
   *   不要掉进 ④ 的"写动词"分支：`SHELL_WRITE_RE` 里 `git … stash` 会误命中
   *   `git stash list` 这种查询（4a 只在"命令里点到了项目根"时才用它，本段不该放大它）。
   */
  if (segments.length > 0 && segments.every((seg) => /^git(?:\.exe)?\b/i.test(seg))) {
    return { action: 'pass' }
  }

  // ③ 删除：只允许"只含删除命令 + 目标全部落在本单 reports / 系统临时目录"的清理形态。
  if (MAIN_REMOVE_RE.test(unquoted)) {
    const noPipes = !/\|/.test(unquoted)
    const removeOnly = segments.length > 0 && segments.every((seg) => MAIN_REMOVE_RE.test(seg))
    const cleanupForm = noPipes && removeOnly && redirects.length === 0 && !inlineWriteHidden
    const targetsInside = targets.length > 0 && mainShellAllInside(targets, cleanupRoots, task, { outsideProject: true })
    if (cleanupForm && targetsInside) return { action: 'allow' }
    // 目标点在项目根里 ⇒ 让既有 4a / 4c 先拒（它们的原文被既有测试钉着，不许改写）。
    if (mentionsProject) return { action: 'pass' }
    // 相对路径 / 取不准的删除：既有 4a 不会拒（没有"受保护路径前缀"）—— 本段补上。
    return { action: 'deny', message: mainShellCleanupRefusal(text, task) }
  }

  // ④ 其它写动词 / 文件重定向：目标证明不了落在临时目录 ⇒ 拒（4a 对"没有点名的写"有缝）。
  const writeVerb = hasWriteVerbOutsideQuotes(text)
  if (writeVerb || redirects.length > 0) {
    const allTemp =
      targets.length > 0 &&
      mainShellAllInside(targets, tempRoots, task, { outsideProject: true }) &&
      tempMentioned &&
      !mentionsProject
    if (allTemp) return { action: 'allow' }
    if (mentionsProject) return { action: 'pass' }
    return { action: 'deny', message: mainShellWriteRefusal(text, task) }
  }

  return { action: 'pass' }
}


/**
 * 扫一条 shell 命令。返回拒绝理由或 null。
 *
 * 判据刻意保守（宁可多拦）：命令里同时出现「动作动词」与「受保护路径」就拦。
 * 代价是可能误伤 —— 用 config.guardShellTools / guardMainReadsCode /
 * guardWriterRunsTests 可以把对应的那层整体关掉，或者用 guardShellTools: []
 * 只留文件工具那层。
 *
 * ★ 设计目的（防过度工程化）在这一层落成两条：`4b` 控制角色不读代码、
 *   `4d` 编写不跑测试。两条都只认**明确的形态**，不追求形式化保证
 *   （shell 侧本来就是 best-effort，见文件头"哪些是约定"）。
 */
export function scanShellCommand(cmd, task, role, cfg = {}) {
  const text = String(cmd ?? '')
  if (text.length === 0) return null

  const lowerText = normText(text)
  const lowerRoot = normText(task.projectRoot)
  const lowerPipeline = normText(task.pipelineDir)
  const mentionsProtectedPath = lowerRoot.length > 0 && lowerText.includes(lowerRoot)

  // ★★ B9：**按真实文件身份**判"是不是在读代码正文"。
  //   不再用"命令里出现了项目根这个目录前缀"当判据（那会把目录名与 yaml 配置也算成代码）。
  const codeTargets = extractCommandPaths(text).filter((p) =>
    looksLikeSourcePath(p, task.projectRoot, (q) => {
      try {
        const abs = isAbsolute(q) ? q : join(task.projectRoot, q)
        if (!existsSync(abs)) return { exists: false, isDir: false }
        return { exists: true, isDir: statSync(abs).isDirectory() }
      } catch {
        return null
      }
    }),
  )
  const readsCode = codeTargets.length > 0

  // ★★ P0-3（2026-10-19）：**主对话 shell 边界** —— 环境级放行 / 交付面拒绝。
  //
  //   ★ 为什么放在 4a 之前：清理**本单** `reports/**` 的命令目标也在项目根里，
  //     4a 会把它们当"用 shell 改项目文件"拒掉；这里必须先按"限定路径的清理"放行。
  //     ★ 但目标**不在**允许范围、又点在项目根里的写/删命令，这里只返回 `pass` ——
  //       交给 4a / 4c 用**既有原文**拒（既有测试钉着那些原文，不许改写）。
  //   ★ 只对 `main` 生效：非 main 席位的判据（4a/4b/4e/4f …）一个字节不动。
  //   ★ 默认启用；显式 `cfg.guardMainShellBoundary === false` 才关（不改 lib/config.js）。
  if (role === 'main' && cfg.guardMainShellBoundary !== false) {
    const boundary = judgeMainShellBoundary(text, task)
    if (boundary.action === 'allow') return null
    if (boundary.action === 'deny') return boundary.message
  }

  // 4a) ★**任何不写代码的角色**：不得用 shell 改项目文件
  //
  //     ⚠️ 判据的适用范围是 `role !== 'writer' && role !== 'human'` —— 它**包含主对话**，
  //        所以理由必须**按角色说**（缺陷 ⑦b/⑧：改前无论谁调用都回一句
  //        "测试/审核不得替编写改代码"，对 main 是**解释了别人**的边界）。
  //        理由段收敛到 `lib/guard/attribution.js` 的唯一出处。
  //
  //     P1-4：改前是"命令里出现任何 `>` 就拒"，`2>$null` / `2>&1` / 引号里的 `=>` 全被当成写文件，
  //     主对话 stat 一个文件、读一个账本都会被拦。现在只认**真写文件**的重定向，且看它写到哪：
  //     写进项目根（或相对路径、取不准）照旧拒；写到项目外 / 临时目录 / 空设备不拦。
  //
  //     ★★ 缺陷 ⑧：写动词的匹配对象从"整段原文"改成"**去掉引号内容之后的文本**"——
  //        真机现场是引号里的回显横幅 `"== … 有 patch 配置的痕迹吗 =="` 被判成了 `patch` 命令。
  //        内联解释器那一支（`INLINE_WRITE_API_RE`）与重定向那一支**都没动**，所以没有放宽。
  if (role !== 'writer' && role !== 'human') {
    const unquoted = stripShellQuotes(text)
    const writeVerb = hasWriteVerbOutsideQuotes(text) && mentionsProtectedPath
    const redirectWrite = shellRedirectTargets(text).some((t) => redirectHitsProject(t, lowerRoot))
    const pipeWrite = SHELL_PIPE_WRITE_RE.test(unquoted)
    const inlineWrite = SHELL_INLINE_CODE_RE.test(text) && INLINE_WRITE_API_RE.test(text) && mentionsProtectedPath
    {
      if (writeVerb || redirectWrite || pipeWrite || inlineWrite) {
        return (
          `${TAG} 拒绝：角色「${role}」不得通过 shell 修改项目文件。\n` +
          `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n` +
          `${whyShellWriteRefused(role)}` +
          // ★ P2 文案小修：把"能被放行的形态"直接写出来 —— 拒绝文案是调用方唯一的行动依据，
          //   只说"不许"会让它反复换写法撞同一堵墙。**判据一个字没动**，只补一句出路。
          '★ 允许的替代形态：**只读命令**不受这条限制（例如 `node --check -e "<代码>"` 校验语法、`git status`、' +
          '列目录 / 读 `.pipeline/` 下的台账）；\n' +
          '  真要写文件 → 用 **write / edit 工具**（受同一套角色与授权面规则约束，判据比 shell 字符串匹配更准）。\n' +
          '（说明：shell 侧是**字符串匹配**的 best-effort 判据，不是形式化保证；不写相对路径、不做变量拼接也拦得住，' +
          '但刻意混淆的写法可能绕过 —— 这一点在插件 README 里明确写了。）'
        )
      }
    }
  }

  // 4b) ★控制角色：不得用 shell 读项目代码 / 翻源码树
  //
  //   本轮把 `main` 那条扩成 `NO_CODE_READ_ROLES`（main / orchestrator / planner）。
  //   ⚠️ 对 main 的文案与判据**一个字都没改**（既有自测与用户可见行为不变），
  //      需求分析与计划走新分支。
  if (NO_CODE_READ_ROLES.includes(role) && cfg.guardMainReadsCode !== false) {
    if (SHELL_READ_RE.test(text) && readsCode) {
      if (role === 'main') {
        return (
          `${TAG} 拒绝：主对话不得通过 shell 读取项目代码。\n` +
          `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n` +
          '原因：主对话与代码正文隔离。请用 pipeline_status 看脱敏摘要。'
        )
      }
      return (
        `${TAG} 拒绝：${roleZh(role)}不得通过 shell 读取项目代码。\n` +
        `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n` +
        `原因：${roleZh(role)}只吃需求原文 + 需求档 + 脱敏摘要，**不看实现** ——\n` +
        '  读了实现就会对实现指手画脚，那就是过度工程化的入口。\n' +
        '要看自己的收件箱/需求档请直接读 .pipeline/<任务id>/ 下的东西（那里允许）。'
      )
    }
    // 检索类命令（rg / grep / findstr / Select-String）：不点名路径 = 默认就翻源码树
    if (role !== 'main' && SHELL_CONTENT_SEARCH_RE.test(text) && !(lowerPipeline.length > 0 && lowerText.includes(lowerPipeline))) {
      return (
        `${TAG} 拒绝：${roleZh(role)}不得用检索命令翻源码树。\n` +
        `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n` +
        '原因：检索命令吐出来的是**匹配到的代码行**，等于读了代码正文。\n' +
        '要看自己的收件箱，就把检索范围限定在 .pipeline/<任务id>/ 下面。'
      )
    }
  }

  // 4e) ★设计目的：**最小改动**（shell 侧，best-effort）
  //
  //     文件工具那一路是硬的（直接读参数里的路径）；shell 这一路只能靠命令串匹配。
  //     判据：编写角色用 shell 写命令、且命令里出现项目根下的路径、且该路径
  //     不在授权改动面里 ⇒ 拦。**没有出现具体路径的写命令**（例如 `echo x > f.txt`
  //     的纯相对形式）拦不住 —— 与其它 shell 判据一样，这是 best-effort。
  if (role === 'writer' && cfg.guardChangeScope !== false) {
    const scope = task.changeScope ?? null
    if (Array.isArray(scope) && scope.length > 0 && SHELL_WRITE_RE.test(text) && mentionsProtectedPath) {
      // 把命令里出现的、位于项目根下的绝对路径都挑出来核对
      const cands = []
      const reAbs = /[A-Za-z]:[\\/][^\s"']+|\/[^\s"']+/g
      let mm = reAbs.exec(text)
      while (mm !== null) {
        const p = pathKey(mm[0].replace(/["']/g, ''))
        if (p.length > 0 && isInside(lowerRoot, p)) cands.push(p)
        mm = reAbs.exec(text)
      }
      for (const p of cands) {
        // 流水线台账不属于改动面（与文件工具那条判据同一豁免）
        const selfDir = typeof task.taskSelfDir === 'string' ? task.taskSelfDir : ''
        const reportsDir = typeof task.reportsDir === 'string' ? task.reportsDir : ''
        if (selfDir.length > 0 && isInside(selfDir, p)) continue
        if (reportsDir.length > 0 && isInside(reportsDir, p)) continue
        if (owningChangeScopeEntry(scope, p, task.scopeAnchor, task.projectRoot) === null) {
          return (
            `${TAG} 拒绝：**改动面超出了授权面**（shell 旁路）。\n` +
            `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n目标：${p}\n` +
            `本次授权改动面（箭号后是**锚点解析结果**）：\n${describeChangeScope(scope, task.scopeAnchor, task.projectRoot)}\n` +
            '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界；新增文件也要显式授权。\n' +
            '真需要扩大范围 → 走澄清/变更拿到新授权，不要自作主张扩。\n' +
            '（shell 侧是字符串匹配的 best-effort 判据；文件工具那一路才是硬的。）'
          )
        }
      }
    }
  }

  //
  //   为什么这条要做成机制而不是纪律：一个既写实现、又自己判"通过"的角色，
  //   会系统性地把测试写成"刚好证明我对"的样子 —— 那不是独立验证，是自证。
  //   把测试**能力**从编写手里拿走，"独立验证"才成立。
  //
  //   ⚠️ 刻意**不拦**构建/启动级冒烟（npm run build / node build.mjs / node -e ...）：
  //      那是"我写的东西能不能装上、起得来"。它的**最小限度**（算不算测试判定、
  //      `selftest_result` 字段还要不要）与 writer 既有 summary 里的"自测结果"冲突，
  //      已列进 README「待确认项」等用户拍板；这里可以用 guardWriterRunsTests:false 整体关掉。
  if (role === 'writer' && cfg.guardWriterRunsTests !== false) {
    const hit = scanTestRunnerCommand(text)
    if (hit !== null) {
      return (
        `${TAG} 拒绝：**编写不跑测试**。\n` +
        `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n命中：${hit.what}（「${hit.matched}」）\n` +
        '★ 测试是 `tester` 的**专属职责**：用例由它独立设计、由它独立执行、由它出结论。\n' +
        '  一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子 ——\n' +
        '  那不是独立验证，是自证。所以这条不是提醒，是**能力边界**。\n' +
        '下一步：用 pipeline_handoff kind=dev_to_test 把**改了什么、运行命令、已知问题**交给测试，由它去跑。\n' +
        '（构建/启动级冒烟（npm run build / node build.mjs / node -e …）不受此限；' +
        '  但"自测的最小限度"到底划到哪，属于待用户拍板项，见 README「待确认项」。）'
      )
    }
  }

  // 4g) ★**哈希前置闸门没通过 ⇒ 谁都不许跑测试** --------------------------
  //
  //   用户原话：「哈希对比不过全量测试直接打回」+「**不许"先跑一下看看"**：
  //   哈希没过之后，任何角色（包括 tester）都不许绕过闸门去跑测试；守门在工具层拦」。
  //
  //   判据：任务上 hash_gate.blocked === true（最近一次 dev_to_test 因哈希对比被拒，
  //   且还没重新通过）—— 这时**任何**测试命令（定向与全量都算）都被拦。
  //   为什么连定向也拦：闸门没过意味着"改动面本身就不合法"，
  //   这时跑任何测试都是在给一份注定要改的产物做验证。
  if (cfg.guardHashGate !== false && task.hashGateBlocked === true) {
    const cls = classifyTestCommand(text)
    if (cls.kind !== null) {
      const gate = task.hashGate ?? null
      const bad = Array.isArray(gate?.violations) ? gate.violations : []
      const escalated = task.hashGateEscalated === true
      return (
        `${TAG} 拒绝：**哈希前置闸门还没过** —— 先修改动面，再谈跑测试。\n` +
        `任务：${task.taskId}　角色：${roleZh(role)}\n命令：${text.slice(0, 160)}\n` +
        (bad.length > 0
          ? `上次被拒的原因（${bad.length} 处）：\n` + bad.slice(0, 8).map((x) => `  · ${x.how}：${x.path}`).join('\n') + '\n'
          : '') +
        (Number.isInteger(gate?.streak) && Number.isInteger(gate?.threshold) && gate.threshold > 0
          ? `连续不通过：${gate.streak} / ${gate.threshold}${escalated ? '（**已到阈值 ⇒ 机制已交人工**）' : ''}\n`
          : '') +
        '★ 设计意图：**不合格的提交不该消耗测试资源**。这次提交在哈希对比那一关就没过，\n' +
        '  连测试都没有进（状态还停在"开发中"），也就谈不上"先跑一下看看"。\n' +
        (escalated
          ? '★ 这一件**已经交人工**（走的是既有的 human_request / 两级梯）：在用户答复之前，\n' +
            '  同一任务的再次提交会被拒收 —— 测试当然更跑不了。等答复即可，不用再试。\n'
          : '★ 下一步：让编写撤回越界改动 / 把漏报的改动补进 change_manifest，重新提交 dev_to_test；\n' +
            '  通过了这道闸，测试才会被唤起（全量测试另有四级审批链）。')
      )
    }
  }

  // 4g2) ★★ **测试位在编写交付之前不许开跑**（T-20261011-56a37e）----------------
  //
  //   安全预审阻断项 B3 的**第 3 条**（产物面三条判据的最后一条）。
  //   用户口径③：「测试位**提前知情 ≠ 提前开工**」；验收 4 的原话是
  //   「编写位提交之前的一切测试行动被拒」。
  //
  //   ★ 与 4g（哈希前置闸门）是**两条独立判据**：那一条判"改动面本身合不合法"，
  //     这一条判"现在还没到你开工的时候"。两条都拦，理由不同 —— 所以拒绝原文分开写。
  //   ★ 只对**枢纽任务**生效（`hubEnabled`），且只在**还没有 dev_to_test** 时拦。
  //     非 tester 的角色不受此限（这条说的是"测试位"）。
  if (cfg.guardHubStandby !== false && task.hubEnabled === true && task.devDelivered !== true && role === 'tester') {
    const cls = classifyTestCommand(text)
    if (cls.kind !== null) {
      return (
        `${TAG} 拒绝：**测试位还没到开工的时候** —— 编写位尚未交付，一切测试行动被拒。\n` +
        `任务：${task.taskId}　角色：${roleZh(role)}\n命令：${text.slice(0, 160)}\n` +
        `判定：这是测试命令（${cls.what}）\n` +
        '★ 用户口径③：「测试提前收到任务内容」= **内容提前交到测试位手里**（计划位的 `prebrief`），\n' +
        '  而**提前知情不等于提前开工** —— 编写位交付（dev_to_test）之前，测试位不得开跑、不得出结论。\n' +
        '  为什么这条必须是代码层判据：只靠"提前知情"这四个字，抢跑与知情在盘上长得一模一样。\n' +
        '下一步：读你手上的那份 `prebrief`（任务内容预登记）做准备；等编写交付之后再开跑。'
      )
    }
  }

  // 4f) ★全量测试审批链：跑**整套**必须有凭据 ------------------------------
  //
  //   用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
  //   必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
  //   确认人工通过后再提交给计划 ai 安排」。
  //
  //   判据两步（都在 lib/testscope.js，纯函数）：
  //     ① classifyTestCommand(cmd)：**定向**（带 -k/--grep/-t/--filter/具体测试文件/具体包）放行；
  //        **全量**（裸跑整套：npm test / pytest / go test ./... / node --test tests/）要凭据。
  //     ② fullTestCredential(task)：四级都点头了吗？点头的**是哪一条命令**？
  //
  //   ⚠️ 与 4d 的关系：编写跑测试那条**更严且排在前面**，所以这里只管非编写的管线席位。
  if (cfg.guardFullTestApproval !== false) {
    {
      const cmd = text
      const cls = classifyTestCommand(cmd)
      if (cls.kind === 'full' && role !== 'writer') {
        const cred = task?.fullTest ?? null
        if (cred === null) {
          return (
            `${TAG} 拒绝：**全量测试要走审批链**。\n` +
            `任务：${task.taskId}　角色：${roleZh(role)}\n命令：${cmd}\n` +
            `判定：这是**整套跑**（${cls.what}）—— ${cls.why}\n` +
            '★ 默认只跑**定向/增量**测试：按本次改动面挑相关用例\n' +
            '  （带 --grep / -k / -t / --testPathPattern / 具体测试文件或具体包 —— 这类**直接放行**）。\n' +
            '★ 真要跑全量，必须走这条链，**缺一级都不许开跑**：\n' +
            '  ① tester        pipeline_handoff kind=full_test_request（写清改动面 / 已跑过的定向 / 为什么定向不够）\n' +
            '  ② 需求分析       pipeline_handoff kind=full_test_review stage=need\n' +
            '  ③ 审核           pipeline_handoff kind=full_test_review stage=worth\n' +
            '  ④ 主对话         pipeline_human_request reason_kind=full_test_approval → 用户答复\n' +
            '  ⑤ 计划 AI        pipeline_handoff kind=full_test_review stage=arrange（定范围与**最终命令**）\n' +
            '  看进度：pipeline_full_test（只读）。'
          )
        }
        const same = sameTestCommand(cred.command, cmd)
        if (same.same !== true) {
          return (
            `${TAG} 拒绝：跑的全量命令与**批准的那一条**不一致。\n` +
            `任务：${task.taskId}　凭据：${cred.approval_id}\n` +
            `批准的命令：${cred.command}\n实际要跑：${cmd}\n原因：${same.why}\n` +
            '★ 凭据是**针对那条命令**发的 —— 批了一条跑另一条，等于没有审批。\n' +
            '要跑别的范围：重新走一遍审批链，或让计划 AI 在 arrange 那站改成这条。'
          )
        }
      }
    }
  }

  // 4c) 任何已绑定角色：不得删/改流水线自己的工作区（审计留痕要保得住）
  if (/(^|[\s|;&(])(remove-item|rm|rmdir|del|erase|rd)\b/i.test(text) && lowerPipeline.length > 0 && lowerText.includes(lowerPipeline)) {
    return (
      `${TAG} 拒绝：不得删除流水线工作区。\n任务：${task.taskId}\n工作区：${task.pipelineDir}\n` +
      '原因：task.json / handoffs / audit.jsonl 是全流程可追溯的凭据，删除即失去可审计性。'
    )
  }

  // 4h) ★★ P0-2：**浏览器 Profile / 凭证数据不得进入工作区** ----------------
  //
  //   现场（2026-10-18 自测问题清单第 2 条）：测试席位把用户真实浏览器 Profile
  //   （`%LOCALAPPDATA%\Microsoft\Edge\User Data`，含 Cookies / Login Data / Local State）
  //   复制进 `reports/tester/edge-profile-*`，报告实测 374.6 MB。
  //
  //   为什么既有判据拦不住：4a 是「写动词 + 命令里出现项目根的**绝对路径**」才拦，
  //   而复制动作的目标写的是**相对路径**（`reports/tester/edge-profile`）
  //   ⇒ `mentionsProtectedPath` 为 false ⇒ 整段判据静默失效。这不是被绕过，是漏过去的。
  //
  //   ★ 对所有角色生效（含 writer）：数据卫生不是角色权限，是"不能发生的事"。
  //   ★ 判据本体在 `browser-profile.js`（分类名单在 `credential-paths.js`，与
  //     `pipeline_security_check` 共用同一份，不另写第二套）。
  if (cfg.guardBrowserProfile !== false) {
    const hit = browserProfileShellRefusal({
      tool: 'shell',
      role,
      task,
      cmd: text,
      paths: extractCommandPaths(text),
    })
    if (hit !== undefined) return hit
  }

  return null
}
