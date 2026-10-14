/**
 * dsh-pipeline · 守门 · shell 命令判据
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/guard/shell
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { classifyTestCommand, sameTestCommand } from '../testscope.js'
import { isInside, pathKey } from '../util.js'
import { NO_CODE_READ_ROLES, roleZh, TAG } from './rules.js'
import { describeChangeScope, owningChangeScopeEntry } from './seats.js'

// ---------------------------------------------------------------------------
// shell 命令扫描（best-effort）
// ---------------------------------------------------------------------------

/**
 * 「会改文件」的命令特征。
 * 后半段（copy 起）是 P1-4 补的常见改文件写法：cmd 的复制 / 移动 / 改名、git 改工作区的子命令、
 * 下载到文件、解压 —— 与前半段一样，只在命令里点到受保护路径时才拦。
 */
const SHELL_WRITE_RE = /(^|[\s|;&(])(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|ni|sc|ac|rm|del|erase|mv|cp|touch|mkdir|sed\s+-i|tee|truncate|dd|copy|xcopy|robocopy|move|ren|rename|git(?:\s+-[Cc]\s+\S+)*\s+(?:checkout|restore|apply|reset|clean|stash|am|rm|mv)|patch|perl\s+-[a-z]*i|curl\s[^|;&]*(?:-o|--output)\b|wget\s[^|;&]*-O\b|(?:invoke-webrequest|iwr)\s[^|;&]*-outfile\b|expand-archive|unzip)\b/i
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

/** 去掉引号里的内容：引号里的 `>` / `|` 是字面量，不是重定向（`node -e "a => b"` 不该算写）。 */
function stripShellQuotes(text) {
  return String(text).replace(/"(?:[^"\\`]|\\.|`.)*"|'[^']*'/g, '""')
}

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

  // 4a) 测试/审核/咨询角色：不得用 shell 改项目文件
  //     P1-4：改前是"命令里出现任何 `>` 就拒"，`2>$null` / `2>&1` / 引号里的 `=>` 全被当成写文件，
  //     主对话 stat 一个文件、读一个账本都会被拦。现在只认**真写文件**的重定向，且看它写到哪：
  //     写进项目根（或相对路径、取不准）照旧拒；写到项目外 / 临时目录 / 空设备不拦。
  if (role !== 'writer' && role !== 'human') {
    const unquoted = stripShellQuotes(text)
    const writeVerb = SHELL_WRITE_RE.test(text) && mentionsProtectedPath
    const redirectWrite = shellRedirectTargets(text).some((t) => redirectHitsProject(t, lowerRoot))
    const pipeWrite = SHELL_PIPE_WRITE_RE.test(unquoted)
    const inlineWrite = SHELL_INLINE_CODE_RE.test(text) && INLINE_WRITE_API_RE.test(text) && mentionsProtectedPath
    {
      if (writeVerb || redirectWrite || pipeWrite || inlineWrite) {
        return (
          `${TAG} 拒绝：角色「${role}」不得通过 shell 修改项目文件。\n` +
          `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n` +
          '原因：测试/审核不得替编写改代码；shell 旁路与文件工具受同一套规则约束。\n' +
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
        if (owningChangeScopeEntry(scope, p, task.scopeAnchor) === null) {
          return (
            `${TAG} 拒绝：**改动面超出了授权面**（shell 旁路）。\n` +
            `任务：${task.taskId}\n命令片段：${text.slice(0, 200)}\n目标：${p}\n` +
            `本次授权改动面（箭号后是**锚点解析结果**）：\n${describeChangeScope(scope, task.scopeAnchor)}\n` +
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

  return null
}
