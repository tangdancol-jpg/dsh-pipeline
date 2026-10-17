// 工具名分类 · 默认名单（读/写/shell/检索）+ 从实参里取路径与命令 + shell 工具名判定。
/**
 * dsh-pipeline · 守门 · **工具名分类**
 * ============================================================================
 * 从 `lib/guard/rules.js` **原样搬出来**的一部分（代码逐字节搬过来，行为未改）；
 * 对外仍经 `lib/guard/rules.js` 转出，调用方不需要改 import。
 *
 * 为什么搬（用户第 1 件的行数纪律）：`rules.js` 已经 434 行，而这次要往它的
 * `PIPELINE_TOOL_ROLES` 里加一条（能力申请工具的 role 白名单）—— 规矩是
 * "要给 ≥400 行的文件加行，先拆再改"。抽的是**自成一域**的那一块：
 * "哪些工具名算读 / 写 / shell / 检索"以及"怎么从实参里把它们的目标捞出来"。
 *
 * ★ 依赖方向：本文件 → `./targets.js`（只读地把实参折成候选标的）；
 *   反过来 `targets.js` 不 import 本文件，没有环。
 *
 * @module dsh-pipeline/lib/guard/tool-names
 */

import { collectTargets } from './targets.js'
import { isShellTextArgTool } from './official-tools.js'

/** 默认的**写**类文件工具名。 */
export const DEFAULT_WRITE_TOOLS = ['write', 'edit', 'str_replace_editor', 'notebook_edit', 'apply_patch', 'multi_edit']

/** 默认的**读**类文件工具名。 */
export const DEFAULT_READ_TOOLS = ['read', 'read_image', 'read_file', 'view_file']

/** 默认的 shell 工具名（实测确认：宿主里真实名字是 pwsh / bash）。 */
export const DEFAULT_SHELL_TOOLS = ['pwsh', 'powershell', 'bash', 'sh', 'cmd', 'shell', 'terminal']

/** shell 工具名的宽松判据（与显式名单取并集）。 */
export const DEFAULT_SHELL_TOOL_PATTERN = 'pwsh|powershell|bash|\\bsh\\b|cmd|shell|terminal|run_command|exec_command|run_shell'

/** 不参与路径判定、但属于流水线控制的工具名（避免误判）。 */
export const PIPELINE_TOOL_PREFIX = 'pipeline_'

/** 单个字符串参数最多扫描多少字符（防止拿 1MB 内容跑正则）。 */
const MAX_SCANNED = 200_000

// ---------------------------------------------------------------------------
// 路径提取
// ---------------------------------------------------------------------------
//
// ★ 缺陷 ③（真机 T-20261015-bb30bc）：本文件原来自己实现了一份 `collectPaths`，
//   它把**正文**也当候选路径 ⇒ 正文里一个斜杠就拼出"工作区 + 正文首行"的假路径 ⇒
//   审核席位写自己的报告被**误拒**，而拒绝文案里那行「目标：…」打的是那个假路径。
//   现在提取逻辑**收敛到一处**：`lib/guard/targets.js`（显式路径键优先 + 单行补充扫描
//   + 带来源）。这里只做转出，`collectPaths` 的名字与签名**一个字没变**。
// ---------------------------------------------------------------------------

export { MAX_SCANNED }

/**
 * 从工具参数里收集目标路径（绝对化后返回）。
 *
 * @param {any} args
 * @param {string} cwd
 * @returns {string[]}
 */
export function collectPaths(args, cwd) {
  return collectTargets(args, cwd).map((t) => t.path)
}


/**
 * 从 shell 工具的实参里收集命令串。
 * pwsh/bash 用 `command`；别的 shell 类工具可能叫 cmd/script/input/code。
 *
 * ★ 2026-10 补（`design/agent-teams/01-目标与边界.md` §D8 第 1 条）：**持久终端的命令在
 *   `text` 参数里**（`terminal_send` / `terminal_write` / `terminal_input`）。不把 `text`
 *   收进来，测试/审核就能用 `terminal_send { text: "echo x > src/a.js" }` 改代码 ——
 *   该拦的拦不住，而"测试/审核不得改代码"正是三权分立的核心一条。
 *
 * ★ 为什么**按工具名**决定要不要扫 `text`，而不是把 `text` 加进通用键名表：
 *   `text` 太常见了 —— `write` / `edit` 的正文、审核报告、Markdown 里都会出现 `>`。
 *   把正文当命令扫 = 审核写报告被误拒（那是我们踩过的坑，见 defect ③）。
 *   所以：只有在工具名**明确是**"命令在 text 里"的那一类时，才补扫 `text`。
 *
 * @param {any} args - 工具实参
 * @param {{toolName?: string}} [opts] - `toolName` 给了才按 {@link SHELL_TEXT_ARG_TOOLS} 决定补扫 `text`
 * @returns {string[]}
 */
export function collectCommandStrings(args, opts = {}) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SCANNED || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  if (args === null || typeof args !== 'object') return out
  for (const k of ['command', 'cmd', 'script', 'input', 'code', 'shell_command']) push(args[k])
  // ★ 持久终端：命令在 `text` 里 —— 只对这一类工具补扫（见上面的"为什么按工具名"）。
  if (isShellTextArgTool(opts?.toolName)) push(args.text)
  const walk = (value, depth) => {
    if (depth > 3) return
    if (typeof value === 'string') {
      push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1)
  }
  walk(args, 0)
  return out
}

/** 工具名是不是 shell 类。 */
export function isShellToolName(toolName, opts = {}) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : ''
  if (name.length === 0) return false
  const list = Array.isArray(opts.shellTools) && opts.shellTools.length > 0 ? opts.shellTools : DEFAULT_SHELL_TOOLS
  for (const raw of list) {
    const c = String(raw).toLowerCase()
    if (c.length === 0) continue
    if (name === c || name.startsWith(`${c}-`) || name.startsWith(`${c}_`)) return true
  }
  const pattern = typeof opts.shellToolPattern === 'string' ? opts.shellToolPattern : DEFAULT_SHELL_TOOL_PATTERN
  if (pattern.length > 0) {
    try {
      if (new RegExp(pattern, 'i').test(name)) return true
    } catch {
      /* 配置写错就当没有正则这条路 */
    }
  }
  return false
}

