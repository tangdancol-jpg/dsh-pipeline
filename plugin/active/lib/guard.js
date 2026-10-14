/**
 * dsh-pipeline · 硬拦截（tools.guard 守门）
 * ============================================================================
 * 「主对话不读代码」「测试不能改代码」「编写不能越过测试找审核」「没有审核 OK
 * 不能关单」这些如果只写在 README 里，就只是**约定**。本模块是把它们变成
 * **机制**的那一层。
 *
 * ---------------------------------------------------------------------------
 * 机制依据（读本机 DSH 实现得到，不是推断）
 * ---------------------------------------------------------------------------
 * `tools.guard(fn)` 注册进 `ToolLayer.guards`（`dsh-tools/lib/index.js:2921`）；
 * 执行流水线是
 *
 *   tools/pre-execute（可扩展 waterfall，`:3225`）
 *     → ctx.tools.guard()（**单调**守卫，`:3241` `guardReason(exec)`）
 *     → dispatch → tools/post-execute → tools/result
 *
 * 三条**必须记住**的源码事实（README 里没有，实测踩过）：
 *
 *   ① 拒绝判据是 `reason !== undefined`（`:2649`）——
 *      **返回 `false` / `0` / `{}` 都会拒绝**，放行必须返回 `undefined`。
 *   ② guard **抛异常不是拒绝**：`prepareExecution` 的 try/catch 会把它吞成
 *      通用 tool error（`:3267`）。所以本模块全部包在 try/catch 里，内部
 *      异常按 **fail-closed** 处理（返回明确理由），绝不静默放行。
 *   ③ 只有 pre-execute 决议为 `allow` 时才跑 guard（`:3241`）。
 *      ⇒ 别的插件（如 archigate、experimental-auto-review）先拒的调用，
 *        根本走不到这里，天然共存、不会互相翻转。
 *
 * 与 dsh-archigate 的共存：两边都是**只拒不放**的单调守卫，`guardReason`
 * 取第一个非 undefined 即返回（`:2646-2651`），没有"后一个把前一个改回允许"
 * 的通路。自测里有一条专门验证这件事（tests/selftest.mjs 的 guard 组合用例）。
 *
 * ---------------------------------------------------------------------------
 * ★ 哪些是真拦截、哪些是约定（诚实边界，README 里有同一份）
 * ---------------------------------------------------------------------------
 * 真拦截（可实测复现，见 tests/selftest.mjs 与 tests/boundary-check.mjs 的反例）：
 *   · 角色越权调用流水线工具（无令牌 / 令牌角色不符 / 令牌跨任务）
 *   · 编写直接提交审核（review_verdict 的 from 只认 reviewer）
 *   · 编写产出测试结论类交接物（test_to_review / test_to_dev 的 from 只认 tester）
 *   · **编写跑测试**（shell 侧的命令形态判据，设计目的第一条，可关）
 *   · 无审核 OK 关单
 *   · 测试/审核角色写项目源码（文件工具路径判定）
 *   · 主对话 / 需求分析 / 计划读项目源码（文件工具路径判定 + 检索工具 + shell，可关）
 *   · 打回超限
 *
 * 约定（拦不住，README 明说）：
 *   · 主对话把别人的令牌转手 —— 令牌机制挡不住，除非开 requireAgentBinding
 *     并只走真实子代理通道。
 *   · shell 旁路的**写**：只能靠命令串的字符串匹配，混淆写法（变量拼接、
 *     编码后解码、写一个脚本再跑）可以绕过。所以 shell 侧是 best-effort，
 *     不是保证。
 *   · **编写不跑测试**同样是 shell 侧判据：写一个 `run-tests.ps1` 再执行它，
 *     或者把测试命令拼成变量，都拦不住。要真保证得靠"测试环境不发给编写席位"
 *     （那是环境侧的事，不是插件能给的）。
 *   · 角色"独立性"本身由 DSH 的子代理上下文提供，不是本插件提供的。
 *   · 不绑定角色的会话不受任何约束（守门只约束流水线参与者）。
 *
 * @module dsh-pipeline/lib/guard
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyTestCommand, sameTestCommand } from './testscope.js'

import { isInside, PACKAGE_ROOT, pathKey, resolveAgainstAnchor, toStringArray } from './util.js'

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

/**
 * ★「只写自己那一片」的角色 —— 把 `lib/roles.js` 的 `writes` 逐字节落到守门上。
 *
 * 用户原话：「**测试 ai 等同理，没有权限动文件的就只能只读**；
 *            总的来说 **ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」。
 *
 * 三种取值差在"能写多宽"，**一律按路径判，不按 summary 判**：
 *   · `readonly` —— **一字节都不许写**（连 reports/ 也不行）。控制角色就是这种：
 *     它们的产物是结构化交接物（工具写），不需要也不该动文件。
 *   · `own-dir`  —— 只写 `<任务>/reports/<role>/` 下**以自己角色名开头**的文件。
 *   · `own-log`  —— 更窄：同上，但**扩展名只允许日志**（`.log` / `.jsonl`）。
 *     审核是这种：它只要能把意见写下来，不需要产出"报告文件"。
 *
 * ⚠️ 与 `lib/roles.js` 的 `writes` 同源，这里刻意写字面量 ——
 * `lib/guard.js` 要保持**零依赖**（可单独单测）。改角色表时**两边一起改**，
 * 并且自测里有一条专门比对"表里的取值都在守门认识的范围里"。
 */
export const READONLY_ROLES = ['main', 'orchestrator', 'planner']
/**
 * ★ **真只读、但不进"控制三角"名单**的角色（当前只有主管）。
 *
 * 为什么要单开一档而不是把主管塞进 `READONLY_ROLES`：
 *   · `READONLY_ROLES` 同时被当成三张**对外的名单**用（`no_code_read_roles` /
 *     `read_only_roles`），它们的语义是"控制三角"（主对话 / 需求分析 / 计划）——
 *     主管是后加的角色，塞进去会改变那两张名单的含义；
 *   · 但主管的 `writes` 在角色表里写的是 `readonly`，而 `writeClassOf('supervisor')`
 *     原来返回 `null` ⇒ **守门的写入判据整段不生效**（`cls === 'readonly' || 'own-dir' ||
 *     'own-log'` 全不匹配）⇒ "文档说只读、代码里却能写"。
 *     这正是 `tests/review-check.mjs` 那条"全角色 writes 与守门逐字节对齐"在抓的漂移。
 * ⇒ 给它一个**显式**的类别 `'none'`：守门按"一字节都不许写"执法，
 *   而那两张名单维持原义不变。
 */
export const NO_WRITE_ROLES = ['supervisor']
export const OWN_LOG_ROLES = ['reviewer']
export const OWN_DIR_ROLES = ['tester', 'architect', 'security', 'archivist', 'diagrammer', 'release', 'docs', 'performance', 'arbiter']

/** `own-dir` 允许的扩展名（测试产物 / 报告 / 日志）。 */
export const OWN_DIR_EXTS = ['log', 'jsonl', 'md', 'json', 'txt']
/** `own-log` 允许的扩展名（**只有日志**）。 */
export const OWN_LOG_EXTS = ['log', 'jsonl']

/**
 * 某个角色的 `writes` 取值 → 守门认识的类别。
 *
 * ★ `'none'` = **真只读但不进控制三角名单**（见 {@link NO_WRITE_ROLES}）——
 *   它与 `'readonly'` 在**写入判据**上完全等价（一字节都不许写），
 *   区别只在"要不要出现在 `read_only_roles` / `no_code_read_roles` 那两张对外名单里"。
 *
 * @param {string} role
 * @returns {'readonly'|'none'|'own-log'|'own-dir'|'workdir'|null}
 */
export function writeClassOf(role) {
  const r = String(role ?? '')
  if (READONLY_ROLES.includes(r)) return 'readonly'
  if (NO_WRITE_ROLES.includes(r)) return 'none'
  if (OWN_LOG_ROLES.includes(r)) return 'own-log'
  if (OWN_DIR_ROLES.includes(r)) return 'own-dir'
  if (r === 'writer' || r === 'human') return 'workdir'
  return null
}

/**
 * 允许写的**专属路径**判据（`own-dir` / `own-log` 共用）。
 *
 * 约定（按本项目既有命名风格：`records/<role>[-<seat>].md`、`reports/<file>`）：
 *   `<项目根>/.pipeline/<任务id>/reports/<role>/<role>[-后缀].<ext>`
 * 例如：`.pipeline/T-1/reports/tester/tester-test-report.md`、
 *       `.pipeline/T-1/reports/reviewer/reviewer.log`
 *
 * 为什么要一个**子目录**而不是直接放 reports/ 根下：`reports/` 根下已经有
 * 别人的产物（测试报告、安全扫描结果…），"只写自己那一片"必须能被**路径判据**
 * 区分出来，而不是靠文件名约定去猜。
 *
 * @param {string} absPath
 * @param {object} task - 同步索引条目（含 taskSelfDir）
 * @param {string} role
 * @param {string} cls - 'own-dir' | 'own-log'
 * @returns {{ok:true} | {ok:false, why:string}}
 */
export function checkOwnPath(absPath, task, role, cls) {
  const self = typeof task?.taskSelfDir === 'string' ? task.taskSelfDir : ''
  if (self.length === 0) return { ok: false, why: '任务还没进同步索引，判不出专属目录' }
  const dir = `${self}/reports/${String(role).toLowerCase()}`
  const p = pathKey(absPath)
  if (!isInside(dir, p)) {
    return { ok: false, why: `不在你的专属目录 ${dir}/ 里` }
  }
  const base = p.slice(p.lastIndexOf('/') + 1)
  const r = String(role).toLowerCase()
  const exts = cls === 'own-log' ? OWN_LOG_EXTS : OWN_DIR_EXTS
  const ext = exts.join('|')
  // ⚠️ 后缀里要允许**连字符**：`tester-test-report.md` 是正常命名，
  //    而 `\w` 不含 `-` —— 早先写成 `[\w.]+` 会把这类合法名字判成非法。
  if (!new RegExp(`^${r}(-[\\w.-]+)?\\.(${ext})$`).test(base)) {
    return {
      ok: false,
      why:
        `文件名必须形如 ${r}.${exts[0]} / ${r}-<后缀>.${exts[exts.length - 1]}` +
        `（当前是 ${base}）` +
        (cls === 'own-log' ? '；你这个角色**只能写日志**，不能产出报告文件' : ''),
    }
  }
  return { ok: true }
}


/** 单个字符串参数最多扫描多少字符（防止拿 1MB 内容跑正则）。 */
const MAX_SCANNED = 200_000

// ---------------------------------------------------------------------------
// 路径提取
// ---------------------------------------------------------------------------

/** 从任意参数值里收集"看起来像路径"的字符串。 */
const PATH_KEYS = ['path', 'file_path', 'filepath', 'target', 'filename', 'file', 'dir', 'directory', 'cwd', 'notebook_path']

/**
 * 从工具参数里收集目标路径（绝对化后返回）。
 *
 * 先看惯用键名；再把参数对象里所有字符串叶子扫一遍 —— 宁可多扫不可漏扫，
 * 因为**漏扫 = 守门形同不存在**。代价只是可能多要求一次授权，方向是安全的。
 *
 * @param {any} args
 * @param {string} cwd
 * @returns {string[]}
 */
export function collectPaths(args, cwd) {
  const found = []
  const seen = new Set()
  const push = (v) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SCANNED) return
    const s = v.trim()
    if (s.length === 0 || seen.has(s)) return
    seen.add(s)
    found.push(s)
  }
  if (args === null || typeof args !== 'object') return []
  for (const k of PATH_KEYS) push(args[k])

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
    if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v, depth + 1)
    }
  }
  walk(args, 0)

  return found.map((p) => resolvePath(p, cwd))
}

/** 把可能是相对路径的字符串绝对化；不像路径的字符串原样返回（交由 isInside 判定）。 */
function resolvePath(p, cwd) {
  const s = String(p ?? '')
  if (s.length === 0) return ''
  // 去掉引号与 file:// 前缀
  const cleaned = s.replace(/^file:\/{2,3}/i, '').replace(/^["']|["']$/g, '')
  if (/^[a-z]:[\\/]/i.test(cleaned) || cleaned.startsWith('/') || cleaned.startsWith('\\\\')) return pathKey(cleaned)
  if (/^\.{0,2}[\\/]/.test(cleaned) || cleaned.includes('/') || cleaned.includes('\\')) return pathKey(resolveJoin(cwd, cleaned))
  return '' // 不像路径的（例如 "utf8"、"hello world"）直接丢弃
}

function resolveJoin(base, rel) {
  const b = String(base ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const r = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = (b + '/' + r).split('/')
  const out = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return out.length > 0 && out[0].endsWith(':') ? joined : '/' + joined
}

// ---------------------------------------------------------------------------
// shell 命令扫描（best-effort）
// ---------------------------------------------------------------------------

/** 「会改文件」的命令特征。 */
const SHELL_WRITE_RE = /(^|[\s|;&(])(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|ni|sc|ac|rm|del|erase|mv|cp|touch|mkdir|sed\s+-i|tee|truncate|dd)\b/i
/** 「会读文件」的命令特征。 */
const SHELL_READ_RE = /(^|[\s|;&(])(get-content|gc|cat|type|more|head|tail|select-string|sls|findstr|grep|rg|awk|strings|xxd|od|less)\b/i
/** ★「检索内容」的命令特征（它们**返回的就是代码正文**，与 `head`/`less` 之类并列但单独判）。 */
const SHELL_CONTENT_SEARCH_RE = /(^|[\s|;&(])(select-string|sls|findstr|grep|rg|ripgrep|ag|ack)\b/i
/** 重定向写。 */
const SHELL_REDIRECT_RE = /(>>?|\|\s*out-file|\|\s*set-content|\|\s*add-content)/i

// ---------------------------------------------------------------------------
// ★ 设计目的（第一性目标）：**防过度工程化** —— 每个 AI 只干自己该干的
// ---------------------------------------------------------------------------
//
// 用户原话：
//   「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
//     编程别跑测试，编排别看代码」
//
// 这一条是**本项目的目标函数**，不是一句口号。它在这里落成两条**机器可执法**的边界：
//
//   ① `writer` **不跑测试**（`scanTestRunnerCommand`）：测试是 `tester` 的专属职责。
//      为什么：一个既写实现又自己判"通过"的角色，会系统性地把测试写成
//      "刚好证明我对"的样子 —— 那不是独立验证，是自证。把测试**能力**从编写手里拿走，
//      "独立验证"才从一句纪律变成机制。
//
//   ② `main` / `orchestrator` / `planner` **不看代码**（`NO_CODE_READ_ROLES`）。
//      为什么：读了实现细节的角色会开始对实现指手画脚 ——
//      需求分析开始定字段名、计划开始选算法库，那就是**过度工程化**的入口：
//      每多一个"懂实现"的角色，就多一层不必要的复杂度要求。
//      它们只吃：需求原文、需求档、`context_digest` 脱敏摘要、以及彼此的结论。
//
// 两条都遵守**白名单方向**：忘了给某角色加能力 = 少一条能力（会被明确拒绝）；
// 忘了从黑名单里删 = 悄悄多一条能力。所以这里只写"谁能做"，不写"谁不能做"。

/**
 * ★ 会**返回代码正文**的检索类工具名。
 *
 * 判据是"返回值里有没有代码正文"，不是"是不是只读"：
 *   · `grep` / `ripgrep` / `findstr` / `Select-String` —— 返回**匹配到的那些行**，
 *     那就是代码正文 ⇒ 拦。
 *   · `glob` / `list_dir` / `ls` / `tree` —— 只返回**路径名**，不构成"看代码正文" ⇒ 不拦。
 *     （拦了它们，计划 AI 连"项目里有哪些目录"都不知道，只会做出更不合实际的计划 ——
 *      那是另一种过度工程化。这条边界我们刻意画在"正文"上。）
 */
export const DEFAULT_SEARCH_TOOLS = [
  'grep',
  'ripgrep',
  'rg',
  'search',
  'findstr',
  'select-string',
  'search_files',
  'search_content',
  'code_search',
  'codebase_search',
  'semantic_search',
]

/**
 * ★ 不许读源码正文的**控制角色**：主对话 + 需求分析 + 计划。
 *
 * ⚠️ 与 `lib/roles.js` 的 `ROLE` 同源，但这里刻意写字面量 ——
 * `lib/guard.js` 要保持**零依赖**（可单独单测）。改角色名时两边一起改。
 */
export const NO_CODE_READ_ROLES = ['main', 'orchestrator', 'planner',
  /**
   * ★ T-20261011-56a37e：**主管**（枢纽位）。
   *
   * 为什么它进这张表而不是进 `READONLY_ROLES`（上面那张）：`READONLY_ROLES` 同时被
   * 当成两张**对外的名单**用（`no_code_read_roles` / `read_only_roles`），语义是「控制三角」
   * —— 主管是后加的角色，塞进去会改变那两张名单的含义。
   * 而 `NO_CODE_READ_ROLES` 的语义就是字面那一个：「读源码正文的能力为否」，
   * 而 `roles.js` 里主管的条目**本来就写着**它在该表里（"与 main / orchestrator / planner
   * 同一类：守门的 NO_CODE_READ_ROLES"）—— 补上它，是让代码与那句声明**对上**，
   * 不是新加一条限制。主管凭什么判断？凭需求档、计划、证据标识与只给路径的目录结构。
   */
  'supervisor']

/** 角色中文名（拒绝文案里用；零依赖所以自己带一份小表）。 */
const ROLE_ZH = {
  main: '主对话',
  orchestrator: '需求分析',
  planner: '计划 AI',
  writer: '编写',
  tester: '测试',
  reviewer: '审核',
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

/** 把角色 id 渲染成人话（零依赖的小表）。 */
function roleZh(role) {
  return ROLE_ZH[String(role ?? '')] ?? String(role ?? '')
}


/**
 * 从 shell 工具的实参里收集命令串。
 * pwsh/bash 用 `command`；别的 shell 类工具可能叫 cmd/script/input/code。
 */
export function collectCommandStrings(args) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SCANNED || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  if (args === null || typeof args !== 'object') return out
  for (const k of ['command', 'cmd', 'script', 'input', 'code', 'shell_command']) push(args[k])
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

// ---------------------------------------------------------------------------
// ★★ C3（2026-10-14）：脚本正文展开 —— 让守门能"读脚本正文再判"
//
// 盲区怎么来的：F 路把「多行 / 带引号 / 带中文的命令 ⇒ 先落盘成脚本文件，再执行」
//   写进了 system prompt 与席位简报（理由：多层转义 ⇒ MALFORMED_RESPONSE ⇒ 整轮作废，
//   那是最贵的一种 token 浪费）。这条指引把**正经用法**变成"命令 = 一个脚本文件路径"，
//   而上面 `collectCommandStrings` 只收**命令行字符串** ⇒ **看不到脚本正文**
//   ⇒ 把违禁内容写进脚本再执行，既有全部 shell 判据一起失效（守门睁眼瞎）。
//
// 补法：**只加展开，不动任何既有判据**（阈值 / 名单 / 语义一个字节都没改）。
//   把「命令里确实被执行的那个脚本」的正文读出来，喂回**同一个**
//   {@link scanShellCommand}。唯一调用点在本文件 shell 旁路那一处
//   （{@link scanCommandWithScripts}），别处照旧直接调 `scanShellCommand`。
//
// ★ 四条自我设限（免得补丁自己变成新的洞）：
//
//   ① **只读"确实被执行的脚本"**：字符串不是路径（带引号残渣 / 括号 / `=` / `$`
//      这类表达式字符）/ 文件不存在 / 不是普通文件 / 扩展名不在 `SCRIPT_EXTS` 里
//      ⇒ 一律不读。读出来的正文**只用于匹配、从不回显**（拒绝文案里只有命令片段，
//      没有正文）⇒ 守门不会被当成"读任意文件"的通道。
//
//   ② **深度上限 1 层**（`SCRIPT_EXPAND_MAX_DEPTH`）：命令行 → 脚本（depth=1）。
//      脚本**内部**再出现脚本执行形态就**不再展开**，但记进 `capped` 痕迹
//      （"展开了但到顶"），由 {@link lastScriptExpansion} 取出来看。
//      为什么封顶：展开是**树的遍历**，不封顶等于让一次工具调用触发无界的文件读取
//      —— 守门自己就成了开销源。1 层正好覆盖本次盲区的实际形态（F 路的指引是把
//      **一条命令**落盘成**一个**脚本）。
//
//   ③ **读不到 ≠ 放行**（fail-closed），但不许误拦正常脚本 —— 三条口径分开：
//      · 文件**不存在** ⇒ 没有可执行的正文、也就没东西可藏 ⇒ 跳过（记 `missing`）。
//        这一条与下一条的分界就是"能不能藏东西"：藏东西的前提是文件真的在。
//      · 文件**存在却读不出**（权限 / 句柄被占 / 打开失败）⇒ **拒**。
//        能藏却读不到，就是既有口径里的"扫描不到 ⇒ 不放过"。
//      · **太大** ⇒ **不拒**，只读头部 `SCRIPT_EXPAND_MAX_BYTES` 再扫，痕迹里标
//        `truncated`。按体积拒会误拦正常的大脚本；按体积跳过会开一个"把违禁命令
//        放在 64KB 之后"的洞 —— 读头部是唯一两边都不吃亏的处置。
//
//   ④ **不许自我递归**：候选路径若正是守门自己这一族文件（`guard.js` /
//      `guard-factory.js` / `hashgate.js`）⇒ 跳过（记 `self`）；展开期间置重入标志，
//      重入调用直接返回空痕迹 —— 与深度上限构成双保险。
//
// ⚠️ 诚实边界：展开器**自己**抛异常时，降级为"改前行为"（既有判据已经先跑过并给过
//   答案，不会被展开器改写），并在痕迹里记 `threw`。这与第 ③ 条不矛盾 —— 那条说的是
//   "脚本文件读不出来"（可判定、且能藏东西），这条说的是"展开器自身出错"（不可判定，
//   一律拒会让整个 shell 通道全红）。见 README「哪些是约定」。
// ---------------------------------------------------------------------------

/** 脚本展开：单条命令最多读几个脚本文件。 */
const SCRIPT_EXPAND_MAX_FILES = 4
/** 脚本展开：每个文件最多读多少字节（**只读头部**；体积本身不是拒绝理由）。 */
const SCRIPT_EXPAND_MAX_BYTES = 64 * 1024
/** 脚本展开：深度上限（1 = 只展开命令行直接点名的那一层）。 */
const SCRIPT_EXPAND_MAX_DEPTH = 1
/** 脚本展开：每类痕迹最多记几条。 */
const SCRIPT_EXPAND_MAX_TRACE = 8

/** 会被读进来扫描的脚本扩展名（不在名单里的一律不读 —— 防止变成"读任意文件"）。 */
const SCRIPT_EXTS = Object.freeze([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'nu',
  'ps1', 'psm1', 'bat', 'cmd',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'pl', 'pm', 'php', 'lua', 'r', 'groovy', 'exs',
])

/** 认得出来的解释器名（先定位它，再到**同一个命令段**里挑脚本 token）。 */
const SCRIPT_INTERPRETERS = Object.freeze([
  'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'nu',
  'pwsh', 'powershell', 'cmd',
])

/** POSIX shell 那一族的词（只为在文案里把形态说清）。 */
const POSIX_SHELL_WORDS = Object.freeze(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'nu'])

/**
 * 解释器位置：前面是命令分隔符/空白/引号（引号那一支是为了认
 * `bash -c "node x.mjs"` 这种内嵌形态），后面必须是空白（免得认到 `nodes`）。
 */
const RE_SCRIPT_INTERP = /(?:^|[\s;&|(/\\"'])([A-Za-z][\w.-]*?)(?:\.exe)?(?=\s)/g

/**
 * 直接执行形态：`./x.sh` `.\x.ps1`。
 * ★ 边界刻意**不含引号与 `(`**：`require("./x.js")` 里的字符串字面量不是"被执行"。
 */
const RE_SCRIPT_DIRECT = /(?:^|[\s;&|])((?:\.{1,2}[\\/])[^\s;&|()<>"']+)/g

/** 命令段里的 token（成对引号优先，其次是裸 token）。 */
const RE_SCRIPT_TOKEN = /("[^"]*"|'[^']*'|\S+)/g

/** 去过引号之后还带这些字符 ⇒ 它不是路径，是表达式 / 代码片段。 */
const SCRIPT_REF_BAD_CHARS = /['"`()=$!]/

/**
 * 守门自己这一族文件（**绝不展开**）：从本模块的位置推出来。
 * 推不出来（`import.meta.url` 不可用）就退化成空集 —— 不因为推不出而放宽别的判据。
 */
const GUARD_SELF_FILES = (() => {
  const set = new Set()
  try {
    const here = pathKey(fileURLToPath(import.meta.url))
    const cut = here.lastIndexOf('/')
    const dir = cut > 0 ? here.slice(0, cut) : ''
    for (const f of ['guard.js', 'guard-factory.js', 'hashgate.js']) set.add(dir.length > 0 ? `${dir}/${f}` : f)
  } catch {
    /* 推不出自身位置 ⇒ 空集（上面那条退化口径） */
  }
  return set
})()

/** 去掉成对或残余的引号。 */
function stripScriptQuotes(v) {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1)
  return s.replace(/^["']+|["']+$/g, '')
}

/** 取扩展名（小写；无扩展名或只有隐藏名前缀时返回空串）。 */
function scriptExtOf(p) {
  const base = stripScriptQuotes(p).replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 这个 token 像不像"一个脚本文件"（不含存在性判断 —— 那是后面的事）。 */
function looksLikeScriptRef(raw) {
  const s = stripScriptQuotes(raw)
  if (s.length === 0 || s.length > 400) return false
  if (s.startsWith('-')) return false
  if (SCRIPT_REF_BAD_CHARS.test(s)) return false
  if (s.includes('/') || s.includes('\\')) return true
  const ext = scriptExtOf(s)
  return ext.length > 0 && SCRIPT_EXTS.includes(ext)
}

/** 命令段 = 到下一个 `;` `&` `|` 或换行为止（`&&`/`||` 自然也在内）。 */
function scriptSegmentOf(text, from) {
  const rest = String(text).slice(from)
  const cut = rest.search(/[;&|\n]/)
  return cut < 0 ? rest : rest.slice(0, cut)
}

/** 按"成对引号优先"切 token。 */
function scriptTokensOf(seg) {
  const out = []
  const re = new RegExp(RE_SCRIPT_TOKEN.source, 'g')
  let m = re.exec(seg)
  while (m !== null) {
    out.push(m[1])
    m = re.exec(seg)
  }
  return out
}

/**
 * 从一条命令里挑出"被执行到的脚本文件"（**纯字符串工作，一次 I/O 都不做**）。
 *
 * 形态刻意只挑本机**实际会出现**的那几种（F 路的指引 + 本仓库自测里真在用的写法）：
 *   `node x.mjs` · `pwsh -File x.ps1` · `bash x.sh` · `sh ./x` · `cmd /c x.bat` · `./x.sh`
 * ★ `-c` / `-Command` / `-e` 那几种**不是脚本文件**（命令正文本来就在命令行字符串里，
 *   既有扫描器照旧看得到），这里不碰。
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{raw:string, ext:string, how:string}[]}
 */
export function findScriptRefs(text, limit = SCRIPT_EXPAND_MAX_FILES) {
  const out = []
  const seen = new Set()
  const add = (raw, how) => {
    if (out.length >= limit) return
    const key = stripScriptQuotes(raw)
    if (key.length === 0 || seen.has(key)) return
    if (!looksLikeScriptRef(key)) return
    seen.add(key)
    out.push({ raw: key, ext: scriptExtOf(key), how })
  }
  if (typeof text !== 'string' || text.length === 0) return out

  // ① 直接执行：./x.sh  .\x.ps1
  {
    const re = new RegExp(RE_SCRIPT_DIRECT.source, 'g')
    let m = re.exec(text)
    while (m !== null) {
      add(m[1], '直接执行（./x.sh）')
      m = re.exec(text)
    }
  }

  // ② 解释器：先定位解释器，再到同一个命令段里挑脚本 token
  {
    const re = new RegExp(RE_SCRIPT_INTERP.source, 'g')
    let m = re.exec(text)
    while (m !== null) {
      const word = String(m[1]).toLowerCase()
      const after = m.index + m[0].length
      m = re.exec(text)
      if (!SCRIPT_INTERPRETERS.includes(word)) continue
      const toks = scriptTokensOf(scriptSegmentOf(text, after))
      if (word === 'pwsh' || word === 'powershell' || word === 'cmd') {
        // 这两个只认显式的脚本开关；没有开关（`-Command` / 位置参数）才退回通用挑法
        const anchor = toks.findIndex((t) => /^(-file|\/c)$/i.test(stripScriptQuotes(t)))
        if (anchor >= 0) {
          if (anchor + 1 < toks.length) add(toks[anchor + 1], word === 'cmd' ? 'cmd /c' : 'PowerShell -File')
          continue
        }
      }
      const how = POSIX_SHELL_WORDS.includes(word) ? 'POSIX shell（bash / sh / zsh …）' : 'js 运行时（node / deno / bun / tsx）'
      for (const t of toks) add(t, how)
    }
  }
  return out
}

/**
 * 把候选路径解析成绝对路径（**先绝对化，再看存不存在**）。
 * 相对路径按锚点解析：任务根优先（与 `collectPaths` 同一条口径），其次改动面锚点。
 */
function resolveScriptCandidate(raw, roots) {
  const s = stripScriptQuotes(raw)
  if (s.length === 0) return ''
  if (isAbsolute(s) || /^[a-z]:[\\/]/i.test(s)) return pathKey(s)
  let first = ''
  for (const r of roots) {
    const cand = resolveAgainstAnchor(r, s)
    if (cand.length === 0) continue
    if (first.length === 0) first = cand
    try {
      if (existsSync(cand)) return cand
    } catch {
      /* 探测失败当作不存在，继续试下一个锚点 */
    }
  }
  return first
}

/**
 * 只读文件**头部**：先按上限分配缓冲，再 `readSync`。
 * ★ 为什么不用 `readFileSync`：那会把整个文件读进内存 —— 一个 2GB 的脚本
 *   就足以让守门自己变成资源消耗点，而它本来只是一个判据。
 */
function readScriptHead(abs, maxBytes) {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 关不上不影响结论（读已经读完了） */
    }
  }
}

function pushTrace(list, item) {
  if (list.length < SCRIPT_EXPAND_MAX_TRACE) list.push(item)
}

let LAST_SCRIPT_EXPANSION = null
let SCRIPT_EXPAND_BUSY = false

/**
 * 最近一次脚本展开的痕迹（**只读**）。
 *
 * 用途：`capped` 那一条 —— "脚本里还引用了脚本，但到了深度上限、没再展开"。
 * 这件事**不改判据**（不因为到顶就拒），所以只能靠这份痕迹"报出来"，
 * 让"展开了但到顶"看得见，而不是静默。
 */
export function lastScriptExpansion() {
  return LAST_SCRIPT_EXPANSION
}

/**
 * 展开一条命令里"被执行到的脚本"的正文。
 *
 * @param {string} cmd - 命令行字符串
 * @param {{projectRoot?:string, anchor?:string}} [opts] - 相对路径的解析锚点
 * @returns {{command:string, bodies:{text:string,path:string,how:string,depth:number,readBytes:number,truncated:boolean}[],
 *   capped:object[], truncated:object[], unreadable:object[], skipped:object[]}}
 *   `unreadable` 非空 ⇒ 调用方按 fail-closed 处理（**不许放行**）。
 */
export function expandScriptCommands(cmd, opts = {}) {
  const report = { command: String(cmd ?? ''), bodies: [], capped: [], truncated: [], unreadable: [], skipped: [] }
  const text = report.command
  const roots = []
  for (const r of [opts.projectRoot, opts.anchor]) {
    if (typeof r === 'string' && r.length > 0 && !roots.includes(r)) roots.push(r)
  }
  if (text.length === 0) {
    LAST_SCRIPT_EXPANSION = report
    return report
  }
  if (SCRIPT_EXPAND_BUSY) {
    // ★ 自我递归护栏（第 ④ 条）：展开期间的重入直接返回空痕迹
    pushTrace(report.skipped, { path: '', why: 'reentrant' })
    LAST_SCRIPT_EXPANSION = report
    return report
  }
  SCRIPT_EXPAND_BUSY = true
  try {
    for (const ref of findScriptRefs(text, SCRIPT_EXPAND_MAX_FILES)) {
      const abs = resolveScriptCandidate(ref.raw, roots)
      if (abs.length === 0) {
        pushTrace(report.skipped, { path: ref.raw, why: 'unresolvable' })
        continue
      }
      // ★ 第 ④ 条：守门自己这一族文件绝不展开
      if (GUARD_SELF_FILES.has(abs)) {
        pushTrace(report.skipped, { path: abs, why: 'self' })
        continue
      }
      let st = null
      try {
        st = statSync(abs)
      } catch {
        st = null
      }
      if (st === null) {
        pushTrace(report.skipped, { path: abs, why: 'missing' })
        continue
      }
      if (st.isFile() !== true) {
        pushTrace(report.skipped, { path: abs, why: 'not-a-file' })
        continue
      }
      const ext = scriptExtOf(abs)
      if (ext.length > 0 && !SCRIPT_EXTS.includes(ext)) {
        pushTrace(report.skipped, { path: abs, why: 'ext' })
        continue
      }
      let body = null
      try {
        body = readScriptHead(abs, SCRIPT_EXPAND_MAX_BYTES)
      } catch (err) {
        // ★ 第 ③ 条：存在却读不出 ⇒ 记进 unreadable，由调用方 fail-closed
        pushTrace(report.unreadable, { path: abs, error: String(err?.code ?? err?.message ?? err) })
        continue
      }
      if (typeof body !== 'string' || body.length === 0) {
        pushTrace(report.skipped, { path: abs, why: 'empty' })
        continue
      }
      const fileBytes = Number(st.size ?? 0)
      const truncated = fileBytes > SCRIPT_EXPAND_MAX_BYTES
      if (truncated) pushTrace(report.truncated, { path: abs, readBytes: body.length, fileBytes })
      report.bodies.push({ text: body, path: abs, how: ref.how, depth: SCRIPT_EXPAND_MAX_DEPTH, readBytes: body.length, truncated })

      // ★ 第 ② 条：脚本内部**再**出现脚本执行形态 ⇒ 到此为止，但留痕（"展开了但到顶"）
      for (const inner of findScriptRefs(body, SCRIPT_EXPAND_MAX_TRACE)) {
        const innerAbs = resolveScriptCandidate(inner.raw, roots)
        let exists = false
        try {
          exists = innerAbs.length > 0 && statSync(innerAbs).isFile() === true
        } catch {
          exists = false
        }
        pushTrace(report.capped, {
          raw: inner.raw,
          path: innerAbs.length > 0 ? innerAbs : inner.raw,
          from: abs,
          depth: SCRIPT_EXPAND_MAX_DEPTH + 1,
          limit: SCRIPT_EXPAND_MAX_DEPTH,
          exists,
        })
      }
    }
  } catch (err) {
    // ⚠️ 展开器自身出错 ⇒ 降级为"改前行为"（既有判据已先跑过），只留痕
    pushTrace(report.skipped, { path: '', why: 'threw', error: String(err?.message ?? err) })
  } finally {
    SCRIPT_EXPAND_BUSY = false
    LAST_SCRIPT_EXPANSION = report
  }
  return report
}

/** 脚本正文触发的拒绝文案（**原样透传**内层既有判据的原文，证明确实是它抓到的）。 */
function scriptBodyRejection(cmd, task, b, inner) {
  return (
    `${TAG} 拒绝：命令执行的**脚本正文**里有被禁止的内容。\n` +
    `任务：${task.taskId}\n命令：${String(cmd).slice(0, 200)}\n` +
    `脚本：${b.path}\n` +
    `识别形态：${b.how}（展开深度 ${b.depth}/${SCRIPT_EXPAND_MAX_DEPTH}；已读 ${b.readBytes} 字节` +
    `${b.truncated ? '，**文件更大、只扫了头部**' : ''}）\n` +
    '★ 这一条是**把脚本正文读出来、喂回同一个扫描器**之后抓到的 —— 改前脚本正文不参与扫描，这种写法是盲区。\n' +
    '── 以下是脚本正文触发的既有判据原文 ──\n' +
    inner
  )
}

/** 脚本读不出来的拒绝文案（fail-closed）。 */
function scriptUnreadableRejection(cmd, task, item) {
  return (
    `${TAG} 拒绝：命令要执行的脚本**读不出来**，无法核实内容。\n` +
    `任务：${task.taskId}\n命令：${String(cmd).slice(0, 200)}\n` +
    `脚本：${item.path}（${item.error}）\n` +
    '原因：守门要读脚本正文才判得动，**存在却读不出**就是"扫描不到" —— 按 fail-closed 不放行。\n' +
    '出路：把脚本改成可读（去掉独占占用 / 换权限），或者把命令直接写在命令行上（那种形态本来就在扫描范围内）。'
  )
}

/**
 * ★★ C3 的**唯一**入口：既有判据先跑，判不出来才展开脚本正文再跑同一个扫描器。
 *
 * 顺序刻意如此 —— 这是"改前逐字节一致"的保证：老判据认得出来的命令，返回的还是
 * **同一条**拒绝理由（文案一个字节都没动）；只有老判据**放行**的命令才多走一步。
 *
 * @param {string} cmd
 * @param {object} task
 * @param {string} role
 * @param {object} [cfg]
 * @returns {string|null|undefined} 拒绝理由；`null` = 放行
 */
export function scanCommandWithScripts(cmd, task, role, cfg = {}) {
  const direct = scanShellCommand(cmd, task, role, cfg)
  if (direct !== null) return direct
  if (cfg.guardScriptBodies === false) return null
  if (task === null || task === undefined) return null
  const exp = expandScriptCommands(cmd, {
    projectRoot: typeof task.projectRoot === 'string' ? task.projectRoot : '',
    anchor: typeof task.scopeAnchor === 'string' ? task.scopeAnchor : PACKAGE_ROOT,
  })
  // 正文先扫（有命中就报最具体的那条），再判"读不出来"
  for (const b of exp.bodies) {
    const hit = scanShellCommand(b.text, task, role, cfg)
    if (hit !== null) return scriptBodyRejection(cmd, task, b, hit)
  }
  if (exp.unreadable.length > 0) return scriptUnreadableRejection(cmd, task, exp.unreadable[0])
  return null
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

// ---------------------------------------------------------------------------
// 守门判据
// ---------------------------------------------------------------------------

/**
 * 流水线工具的角色白名单。
 * `null` = 不在此处判角色（交给 execute 内部判，因为需要读 payload 才知道 kind）。
 */
const PIPELINE_TOOL_ROLES = {
  pipeline_task_open: null,
  pipeline_bind_role: null,
  pipeline_orchestrate: ['main', 'orchestrator'],
  // ★ 本轮新增：计划与分配**只有计划 AI** 能做（分配权从 orchestrator 移过来了）。
  //   主对话**不在**这里 —— 它不参与分配，只能按清单派活。
  pipeline_plan: ['planner'],
  // ★ 授权面变更（amendment）：同样**只有计划 AI** —— 授权面是计划的产物。
  //   它与 pipeline_plan 的区别不在"谁能做"，而在"能改什么"：
  //   这条只动 change_scope / forbidden，碰不到席位/档位/顺序/层（store 里的白名单管着）。
  pipeline_scope_amend: ['planner'],
  pipeline_dispatch: ['main'],
  /**
   * ★★ **主管枢纽的具名动作**（T-20261011-56a37e）。
   *
   * 安全预审阻断项 B2 的原话：「主管的发起/唤醒必须是**具名动作**
   * （自己的事件 + 自己的 by 名单 + 真实 actor 留痛 + 目标位白名单）；
   * **不得**通过放宽 main 那两处名单（`guard.js` 的 `pipeline_dispatch` 与
   * `lib/tools.js` 里把 actor 硬写成 MAIN 的那一处）来完成」。
   *
   * 所以这里**只放 supervisor**：main 调它会被这一行拒（第一道），
   * 状态机的 `by: ['supervisor']` 会再拒一次（第二道）。
   * 为什么不复用 `pipeline_dispatch`：那会把发起者记成 main（"谁发起"不可追溯），
   * 并且主管会连带拿到 main 的整片派活权（含叫醒任意席位）—— 那是越权放行。
   */
  pipeline_supervise: ['supervisor'],
  pipeline_transition: ['main', 'human'],
  pipeline_close: ['main'],
  pipeline_rework: ['tester', 'reviewer', 'security', 'human'],
  pipeline_status: null,
  pipeline_handoff: null,
  pipeline_roster_request: null,
  // ★ 角色变更复核 = 分配权的一部分 ⇒ 跟着 planner 走。
  pipeline_roster_review: ['planner'],
  pipeline_roster_apply: null,
  pipeline_artifact: ['writer', 'human'],
  pipeline_selftest: null,
  // ★ 人工介入的三个动作：**只有主对话**能做。
  //   发起（pipeline_human_request）反过来 —— 只有**非 main** 能做（见下面的 SPECIAL 分支）。
  pipeline_human_relay: ['main'],
  pipeline_human_reply: ['main'],
  pipeline_human_request: null, // 交给 execute 内部判（要按角色给不同的拒绝文案）
  // ★ 两级升级梯：提问谁都能提（角色名单在交接物方向表里管），裁定只有需求分析能出
  pipeline_clarify_request: null,
  pipeline_clarify_reply: ['orchestrator'],
  // 安全确认扫描：审核（L0~L2 自己跑）与安全角色（L3+ 出独立结论）都要能用；
  // 主对话也允许 —— 它可能被要求先扫一遍看看，再决定要不要升级。
  pipeline_security_check: ['reviewer', 'security', 'main', 'human'],
}

/**
 * 每种交接物**允许谁产出**（守门层用；与 `lib/handoff.js` 的 `from` 同源，
 * 这里冗余一份是为了让 `lib/guard.js` 保持零依赖、可单独单测）。
 *
 * ⚠️ 白名单方向：**新角色忘了加进来 = 少一条能力（可接受）；
 *    这里漏写而 handoff.js 写了 = 悄悄多一条能力（不可接受）** ——
 *    所以两张表要一起改，自测里有一条专门比对它们。
 */
const HANDOFF_DIRECTION = {
  dispatch: ['main'],
  // ★ 本轮拆分：需求分析交"分析结论"，计划 AI 交"分配结论"，两者不再是同一个角色。
  requirement_analysis: ['orchestrator'],
  orchestration: ['planner'],
  plan: ['planner'],
  dev_to_test: ['writer'],
  test_to_review: ['tester'],
  test_to_dev: ['tester'],
  review_verdict: ['reviewer'],
  // ★ 架构图：只有 diagrammer 能交（**不是** architect —— 后者是编写之前的顾问）
  architecture_diagram: ['diagrammer'],
  // ★★ T-20261011-56a37e（主管枢纽）：三个新类型的**方向**。
  //   ★ 与 `lib/handoff.js` 的 `HANDOFF_SCHEMAS[kind].from` **必须逐字一致** ——
  //     自测里有一条专门比对它们（漏写 = 悄悄多一条能力，不可接受）。
  //   · `station_confirm`：主管与需求位**各自**产出一份（双确认靠"两份各自令牌"成立，
  //     不是"一份里写两个布尔字段"）；`roles.js` 的 handoffKinds 同步放行这两个角色。
  station_confirm: ['supervisor', 'orchestrator'],
  //   · `prebrief`：计划位 → 测试位的「任务内容预登记」（测试**提前**知情的载体）。
  prebrief: ['planner'],
  //   · `diagram_rework`：主管 → 架构位的重画指令（**限 1 次**）。
  diagram_rework: ['supervisor'],
  // ★ 两级升级梯第一级：执行/顾问角色 + 计划 AI → 需求分析
  //   （planner 的在册理由：它的「计划自检发现缺失」就是退回需求分析）
  clarification_request: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner'],
  // ★ 第一级的回复：只有需求分析能裁定
  clarification_reply: ['orchestrator'],
  design: ['architect'],
  security_review: ['security'],
  release_plan: ['release'],
  docs_note: ['docs'],
  perf_report: ['performance'],
  arbitration: ['arbiter'],
  human_note: ['human'],
  // ★ 人工介入请求：**除主对话之外**的角色才能发起。
  //   main 不产出这一类型 —— 它就在用户的对话框里，要问直接问，不需要绕一圈。
  human_request: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human'],
  seat_handover: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer'],
}

/** 单条拒绝理由的统一抬头 —— 拒绝原文要能被人一眼认出是谁拦的。 */
const TAG = '[pipeline]'

/**
 * 守门的判据本体。**必须同步**（`guardReason` 是同步遍历），且**必须不抛**。
 *
 * @param {object} exec - DSH 的 ToolExecution：`{ name, arguments, agent }`。
 * @param {object} deps
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {{get:(taskId:string)=>object|null}} deps.taskIndex - 同步任务索引（项目根/报告目录）
 * @param {object} [deps.config]
 * @returns {string|undefined} 返回字符串 = 拒绝理由；`undefined` = 放行。
 */
export function guardDecision(exec, deps) {
  try {
    return decide(exec, deps)
  } catch (err) {
    // ★ fail-closed：守门自身出问题时不静默放行。
    return (
      `${TAG} 守门内部异常，按 fail-closed 拒绝本次调用（这不是模型的问题，是插件 bug）。\n` +
      `工具：${String(exec?.name ?? '(未知)')}\n异常：${String(err?.message ?? err)}`
    )
  }
}

function decide(exec, deps) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  if (name.length === 0) return undefined

  /** ★ 继任后退休的会话 id 集合（同步可查）。 */
  const retired = deps?.retired ?? null

  /**
   * ★ 从**同步索引**里取任务。
   *
   * 守门必须同步判定，而任务数据在盘上、读取是异步的 —— 所以索引是"缓存"，
   * **取不到就是取不到**。取不到时下面所有靠 `task.projectRoot / taskSelfDir / writers`
   * 的判据都会**静默跳过**（fail-open）。
   *
   * 这里刻意**不改成 fail-closed**：索引为空是"还没热身"，不是"调用方可疑"；
   * 一次误拦会打断正当工作。但**绝不能静默** —— 所以回调 `onMissingTask` 留痕，
   * 让"这段判据没跑到"这件事在日志里看得见。
   */
  const taskOf = (taskId) => {
    const t = deps?.taskIndex?.get(taskId) ?? null
    if (t === null && typeof deps?.onMissingTask === 'function') {
      try {
        deps.onMissingTask({ taskId, tool: name, role: binding?.role ?? null, seat: binding?.seat ?? null })
      } catch {
        /* 留痕失败绝不该影响判定 */
      }
    }
    return t
  }

  const cfg = deps?.config ?? {}
  const tokens = deps?.tokens
  if (tokens === undefined) return undefined

  const agentId = agentIdOf(exec)
  const args = exec?.arguments

  // --- 0) 该调用是否"流水线相关" ------------------------------------------
  const isPipelineTool = name.startsWith(PIPELINE_TOOL_PREFIX)

  // ★ 已退休的席位（继任之后）：令牌已撤销，所以 `roleOfAgent` 找不到它 ——
  //   那会让守门把它当成"与流水线无关的会话"直接放行（这是个真陷阱）。
  //   所以退休名单单独查，且**排在所有放行分支之前**。
  if (retired !== null && agentId !== null && retired.has(agentId)) {
    return (
      `${TAG} 拒绝：本会话所属的席位已经**继任换班**了（它的令牌已撤销）。\n` +
      `工具：${name}\n会话：${agentId}\n` +
      '★ 继任是**换班** —— 工作由新席位接着做，旧席位不得再写、不得再提交、不得再推进。\n' +
      '为什么这条要单独判：令牌撤销之后角色绑定就没了，普通判据会把它当成"无关会话"放行。\n' +
      '如果你是**新席位**：请用主对话在 pipeline_succession 返回里给你的那枚新令牌。'
    )
  }
  const binding = agentId === null ? null : tokens.roleOfAgent(agentId, undefined)

  // 非流水线工具、且调用方没有绑定任何角色 → 与流水线无关，直接放行。
  // （守门只约束流水线参与者，绝不去管无关会话 —— 这是与其它插件共存的前提。）
  if (!isPipelineTool && binding === null) return undefined

  // --- 1) 流水线工具的角色白名单（pre-dispatch 早拦）---------------------
  if (isPipelineTool) {
    // 1a) 交接物的**方向**在守门层就判一次：编写不能直接把产物交给审核。
    //     这条判据在 execute 里还有一份（同源），这里提前拦是为了让拒绝发生在
    //     dispatch 之前 —— 参数校验、落盘都不会发生。
    if (name === 'pipeline_handoff') {
      const kind = typeof args?.kind === 'string' ? args.kind : ''
      const direction = HANDOFF_DIRECTION[kind]
      if (direction !== undefined) {
        let role = binding?.role ?? null
        const declared = typeof args?.role_token === 'string' ? args.role_token : ''
        if (declared.length > 0) {
          const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
          if (!r.ok) return `${TAG} ${r.error}`
          role = r.rec.role
        }
        if (role !== null && !direction.includes(role)) {
          const isTestProduct = kind === 'test_to_review' || kind === 'test_to_dev'
          return (
            `${TAG} 角色越权被拦下（交接物方向）。\n` +
            `交接物：${kind}\n允许产出该交接物的角色：${direction.join(' / ')}\n当前角色：${role}\n` +
            (kind === 'review_verdict'
              ? '原因：★ 编写角色不能直接把产物提交审核。编写的产物只能先交测试（dev_to_test）；\n' +
                '由测试独立验证、产出 test_to_review 之后，审核才介入。这是三权分立的核心一条。'
              : kind === 'human_request'
                ? '原因：★ 主对话不产出人工介入请求。用户的对话框就在主对话里 —— 它需要人拍板时直接问即可，\n' +
                  '不需要"发起请求给自己"这一圈。人工介入请求是**执行/顾问角色**向上发起用的。'
                : isTestProduct && role === 'writer'
                  ? '原因：★ **编写不跑测试** —— 用例、执行结果、通过证据、失败日志、测试结论\n' +
                    '全部是 `tester` 的产物，编写的白名单里**压根没有**这一类型。\n' +
                    '  一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子 ——\n' +
                    '  那不是独立验证，是自证。所以这条边界不是文案，是**能力边界**。\n' +
                    '  你要交的是 dev_to_test（补丁 + 变更说明 + 运行命令 + 自测结果 + 已知问题）。\n' +
                    '（设计目的：防过度工程化 —— 每个 AI 只干自己该干的。）'
                  : '原因：交接物的方向由类型固定，不能自选。')
          )
        }
      }
    }

    // 1b) 人工介入的发起方向：**只有非 main** 能发起。
    //     这条与上面那张方向表互补：表管"哪种交接物谁能产出"，这里管"这个工具谁不能调"。
    if (name === 'pipeline_human_request') {
      let role = binding?.role ?? null
      const declared = typeof args?.role_token === 'string' ? args.role_token : ''
      if (declared.length > 0) {
        const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
        if (!r.ok) return `${TAG} ${r.error}`
        role = r.rec.role
      }
      if (role === 'main') {
        return (
          `${TAG} 主对话不能发起人工介入请求。\n` +
          '原因：用户的对话框**就在主对话里** —— 你要问用户，直接在会话里问就行了，\n' +
          '不需要走"发起请求 → 自己转告 → 等自己答复"这一圈。\n' +
          '这个工具是给**执行/顾问角色**用的：它们没有用户的对话框，只能把问题交给你。\n' +
          '如果你收到别的角色用 pipeline_human_request 提交的请求，用 pipeline_human_relay 转告用户，' +
          '再用 pipeline_human_reply 记答复。'
        )
      }
      if (role === null) {
        return (
          `${TAG} 拒绝：发起人工介入请求必须能确定发起角色。\n` +
          '本会话既没有绑定角色，也没有携带 role_token。请先 pipeline_bind_role 认领角色。'
        )
      }
    }

    const allowed = Object.hasOwn(PIPELINE_TOOL_ROLES, name) ? PIPELINE_TOOL_ROLES[name] : undefined
    if (allowed === null || allowed === undefined) return undefined // 交给 execute 内部判
    // 有令牌的以令牌角色为准；没有令牌但会话已绑定的以绑定为准。
    const declared = typeof args?.role_token === 'string' ? args.role_token : ''
    let role = binding?.role ?? null
    if (declared.length > 0) {
      const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
      if (!r.ok) return `${TAG} ${r.error}`
      role = r.rec.role
    }
    if (role === null) {
      return (
        `${TAG} 拒绝：流水线工具的调用方身份无法确定。\n` +
        `工具：${name}\n允许角色：${allowed.join(' / ')}\n` +
        '本会话既没有绑定任何角色，也没有携带 role_token。\n' +
        '请二选一：① 由主对话用 pipeline_dispatch 派活拿到令牌（派活单里会带）；' +
        '② 本会话调用 pipeline_bind_role 认领角色。\n' +
        '★ 流水线的每个动作都必须能回答"你是谁" —— 身份不明即拒绝。'
      )
    }
    if (!allowed.includes(role)) {
      return (
        `${TAG} 角色越权被拦下。\n工具：${name}\n允许角色：${allowed.join(' / ')}\n当前角色：${role}\n` +
        (name === 'pipeline_close'
          ? '原因：关单是主对话的独占动作，且必须已存在审核 OK。'
          : name === 'pipeline_dispatch'
            ? '原因：派活是主对话的独占动作 —— 主对话按编排给出的角色清单调用，别人不代劳。'
            : name === 'pipeline_roster_review'
              ? '原因：角色增减必须由「计划 AI」复核（加人减人 = 改角色清单 = 分配），主对话与执行角色都不能自己批。'
              : '原因：本工具被限定给上列角色。')
      )
    }
    return undefined
  }

  // --- 2) 文件写工具：测试/审核不得改代码 ---------------------------------
  const writeTools = Array.isArray(cfg.guardFileTools?.write) && cfg.guardFileTools.write.length > 0 ? cfg.guardFileTools.write : DEFAULT_WRITE_TOOLS
  const readTools = Array.isArray(cfg.guardFileTools?.read) && cfg.guardFileTools.read.length > 0 ? cfg.guardFileTools.read : DEFAULT_READ_TOOLS

  // --- 2a) ★只读角色 / 只写自己那一片的角色：按**能力**拦，不按 summary 拦 ----
  //
  //   用户原话：「**测试 ai 等同理，没有权限动文件的就只能只读**；
  //             总的来说 **ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」。
  //
  //   与 2) 的关系：2) 说的是"非编写角色不得改项目源码"（还允许写 reports/）；
  //   这一条把每个角色**实际能写哪**按 `writeClassOf` 判死：
  //     · readonly（主对话 / 需求分析 / 计划）—— **一字节都不许写**（含 reports/）；
  //     · none（主管：真只读，但不进控制三角那两张对外名单）—— **同样一字节都不许写**；
  //     · own-dir（测试 / 架构 / 安全 / 留档 / 架构图 / 发布 / 文档 / 性能 / 仲裁）
  //       —— 只写 `<任务>/reports/<role>/<role>*.<ext>`；
  //     · own-log（审核）—— 同上但**只有日志扩展名**。
  if (writeTools.includes(name) && binding !== null) {
    const cls = writeClassOf(binding.role)
    if (cls === 'readonly' || cls === 'none' || cls === 'own-dir' || cls === 'own-log') {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const paths = collectPaths(args, task.projectRoot).filter((p) => p.length > 0)
        for (const p of paths) {
          if (!isInside(task.projectRoot, p)) continue // 项目外不归本插件管
          if (cls === 'readonly' || cls === 'none') {
            return (
              `${TAG} 拒绝：角色「${roleZh(binding.role)}」**只读** —— 它没有任何写文件的权限。\n` +
              `工具：${name}\n目标：${p}\n任务：${binding.taskId}\n` +
              '★ 为什么连 reports/ 也不给：它的产物是**结构化交接物**（由 pipeline_* 工具落盘），\n' +
              '  不需要也不该动文件。用户的原则是：**行为不靠自然语言限制，靠代码层直接拦截** ——\n' +
              '  所以"只读"不是写在角色卡里的一句话，是这里的一条判据。\n' +
              '要把结论交出去：用 pipeline_handoff（结构化交接物）或对应的 pipeline_* 工具。'
            )
          }
          const chk = checkOwnPath(p, task, binding.role, cls)
          if (chk.ok !== true) {
            const dir = `${task.taskSelfDir}/reports/${binding.role}/`
            return (
              `${TAG} 拒绝：角色「${roleZh(binding.role)}」只能写**自己那一片**。\n` +
              `工具：${name}\n目标：${p}\n任务：${binding.taskId}\n` +
              `原因：${chk.why}\n` +
              `允许写的位置（唯一）：${dir}${binding.role}[-后缀].` +
              (cls === 'own-log' ? OWN_LOG_EXTS.join('|') : OWN_DIR_EXTS.join('|')) +
              '\n★ 这条按**路径**判，不按角色卡里的措辞判 ——\n' +
              '  谁能写哪由代码层的 `writes` 决定，文档只是把它写清楚。\n' +
              '  要交结论：用结构化交接物（pipeline_handoff）；要让别人看到东西：交给你该交给的那个角色。'
            )
          }
          /**
           * ★★ **待机期的产物面判据（第 2 条：文件面）** —— T-20261011-56a37e。
           *
           * 安全预审阻断项 B3 的原话：「待机必须落**产物面三条判据**（交接物 / own-dir 写入 /
           * 测试执行），缺任一条 ⇒ 验收 3、4 不通过」。这是**第 2 条**。
           *
           * 为什么 own-dir 也算"产物"：待机位写自己目录的报告，等于**已经开过工**了 ——
           * 而用户口径③要的是"**压根没产出**"，不是"产物被藏起来"。
           * 位置排在路径判据**之后**：先把"你写错地方了"说清楚，再说"你还没到点"。
           */
          const standby = hubStandbyBlocksWrite(task, binding.role)
          if (standby.blocked === true) {
            const wp = standby.wake_point
            return (
              `${TAG} 拒绝：席位「${roleZh(binding.role)}」现在处于**已登记待机**，还没到唤醒点 —— 写自己目录的报告也算开工。\n` +
              `工具：${name}\n目标：${p}\n任务：${binding.taskId}\n` +
              `唤醒点：**${wp === 'need_agree' ? '主管同意需求结论' : '主管确认架构图满足要求'}**（${wp}）\n` +
              '★ 用户口径③：「待机」是**可见的「已登记未开工」** —— 而未到点不得开工是**产物面**的判据：\n' +
              '  ① 交产物      ⇒ store 的交接物状态判据拒（HUB_STANDBY_NOT_WOKEN）；\n' +
              '  ② 写自己目录  ⇒ **就是这一条**；\n' +
              '  ③ 跑测试      ⇒ 同文件里"编写交付之前不许开跑"那一条。\n' +
              '  三条同源、同一份数据（task.hub.standby）。\n' +
              '下一步：等主管在**到点**之后唤醒（pipeline_supervise）。'
            )
          }
        }
      }
    }
  }

  // --- 2) 文件写工具：测试/审核不得改代码 ---------------------------------
  if (writeTools.includes(name) && binding !== null) {
    const task = taskOf(binding.taskId)
    if (task !== null && binding.role !== 'writer' && binding.role !== 'human') {
      const cwd = task.projectRoot
      const paths = collectPaths(args, cwd)
      for (const p of paths) {
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        if (isInside(task.reportsDir, p)) continue // 报告目录是允许的
        return (
          `${TAG} 拒绝：角色「${binding.role}」不得修改项目源码制品。\n` +
          `工具：${name}\n目标：${p}\n任务：${binding.taskId}（受保护根：${task.projectRoot}）\n` +
          `允许写入的位置只有本任务的报告目录：${task.reportsDir}\n` +
          '原因：编写/测试/审核三权分立 —— 测试与审核**不得替编写改代码**（改了就没有独立验证了）。\n' +
          '如果你发现了缺陷，请用 pipeline_handoff（test_to_dev）或 pipeline_rework 把问题打回编写，由编写角色修改。'
        )
      }
    }

    // --- 2a2) ★分权落档（更正 A）--------------------------------------------
    //
    //   两条规矩：
    //     ① `requirement.md` / `.json` / 版本索引 —— **只有留档 AI（archivist）能写**。
    //        （上一轮是"需求分析独占写权"，那条**已作废**：现在是分权写 + 专人汇总。）
    //     ② `records/<role>[-<seat>].{md,json}` —— 各写各的，且**只能写自己那份**。
    if (writeTools.includes(name) && binding !== null) {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const paths = collectPaths(args, task.projectRoot)
        const root = `${String(task.pipelineDir).toLowerCase()}/${String(task.taskId).toLowerCase()}`
        const recordsDir = `${root}/records/`
        for (const p of paths) {
          if (p.length === 0 || !isInside(root, p)) continue
          const base = p.slice(p.lastIndexOf('/') + 1)

          // ② records/：只能写自己那份
          if (p.startsWith(recordsDir)) {
            const expectName = `${binding.role}${binding.seat ? `-${String(binding.seat).replace(/#/g, '')}` : ''}.md`
            const stem = base.replace(/\.(md|json)$/i, '')
            const mine = stem === String(binding.role) ||
              stem === `${binding.role}-${String(binding.seat ?? '').replace(/#/g, '')}`
            if (!mine) {
              return (
                `${TAG} 拒绝：**只能写自己那份记录**。\n` +
                `工具：${name}\n目标：${p}\n` +
                `你的身份：${binding.role}${binding.seat ? ` / ${binding.seat}` : ''}　→ 你那份应该叫 ${expectName}\n` +
                '★ 记录的价值全在「这是谁说的」—— 写别人的记录等于伪造来源。\n' +
                '  需要别人补内容 → 让它自己写（pipeline_record_submit），或由留档 AI 去问它。'
              )
            }
            continue
          }

          // ① requirement.*：只有留档 AI
          if (!base.startsWith('requirement.')) continue
          if (binding.role === 'archivist') continue
          return (
            `${TAG} 拒绝：**需求档只有留档 AI（archivist）能写**，你是「${binding.role}」。\n` +
            `工具：${name}\n目标：${p}\n` +
            '★ 需求档是**权威需求快照** —— 所有角色默认以它为准。\n' +
            '  现在它是**分权写 + 专人汇总**出来的：各角色在 records/ 下写自己那份，\n' +
            '  留档 AI 收集后统一编写成这一个文件（每条内容都标了来源，可逐条追溯）。\n' +
            '★ 你要补内容 → 用 pipeline_record_submit 写**自己那份**记录，留档 AI 会汇总进去。\n' +
            '  只是**读**需求 → 直接读 .pipeline/<任务id>/requirement.md 就行（只读不受限制）。'
          )
        }
      }
    }

    // --- 2b) ★编写席位的分区边界 ------------------------------------------
    //
    // 每个 `writer#k` 只能写自己那段范围。写到别人的分区、或写到分区之外 → 拒。
    //
    // 单席位（count=1）时范围是整棵项目根 ⇒ 本判据恒真，与旧行为**完全等价**
    // —— 这就是"count=1 是同一套机制的退化情形"在守门层的体现。
    if (writeTools.includes(name) && binding !== null && binding.role === 'writer') {
      const task = taskOf(binding.taskId)
      const writers = task?.writers ?? null
      const seat = binding.seat ?? 'writer#1'
      if (task !== null && writers !== null) {
        const parts = Array.isArray(writers.partitions) ? writers.partitions : []
        if (parts.length > 0) {
          const paths = collectPaths(args, task.projectRoot)
          for (const p of paths) {
            if (p.length === 0) continue
            if (!isInside(task.projectRoot, p)) continue
            // ★ 分区约束管的是**项目源码**；流水线自己的台账（task.json / handoffs /
            //   artifacts / reports / records）不属于任何席位的"那一段"。
            //   `records/` 尤其重要：那是"各写各的落档"，把席位挡在外面等于让分权落档没法用。
            if (task.taskSelfDir !== undefined && task.taskSelfDir !== null && isInside(task.taskSelfDir, p)) continue
            if (isInside(task.reportsDir, p)) continue
            const owner = owningSeat(parts, p, task.scopeAnchor)
            if (owner === null) {
              return (
                `${TAG} 拒绝：写入位置不在任何编写席位的分区里。\n` +
                `工具：${name}\n目标：${p}\n你是：${seat}\n` +
                `在册分区：\n${describePartitions(parts, task.projectRoot)}\n` +
                '原因：编写已被拆成多个席位，每个人只写自己那一段 —— 写到分区外等于越过了编排划的界。\n' +
                '要改范围请走 pipeline_roster_request（提出）→ pipeline_roster_review（编排复核），' +
                '主对话与你自己都不能改分区。'
              )
            }
            if (owner.seat !== seat) {
              return (
                `${TAG} 拒绝：越界写入别人的分区。\n` +
                `工具：${name}\n目标：${p}\n你是：${seat}（范围：${describeSeat(parts, seat, task.projectRoot)}）\n` +
                `该路径属于：${owner.seat}（范围：${describeSeat(parts, owner.seat, task.projectRoot)}，命中「${owner.matched}」）\n` +
                '原因：编排把编写拆成了多个席位，各自范围**互不重叠** —— 那正是分区的意义。\n' +
                '如果你认为某处应该由你改，请让编排复核后重新划界（pipeline_roster_request → pipeline_roster_review），' +
                '不要直接动手。\n' +
                (owner.overlaps.length > 0
                  ? `⚠ 另外：这条路径同时命中 ${owner.overlaps.join('、')} —— 分区表疑似有重叠（编排层本应拦下）。`
                  : '')
              )
            }
          }
        }
      }
    }
  }

  // --- 2c) ★设计目的：**最小改动**（改动面必须与授权面相等）----------------
  //
  //   用户原话：「修一个 bug 就别该整个模块」。
  //
  //   它与 2b（席位分区 `scope_paths`）是**两层**、**同时**生效：
  //     · `scope_paths` = "你负责哪一块"（长期边界，按层/分区）
  //     · `change_scope`= "这次任务允许你动哪些文件"（本次授权面）
  //   写入必须**同时**满足两者 —— 这是"越写越严"的正确方向，不是二选一。
  //
  //   三条判据：
  //     ① 路径必须命中某条授权（`owningChangeScopeEntry`）；
  //     ② 该授权条目的 `action` 必须与实际动作相符 —— **新增文件也算越界**，
  //        要新建就得在计划里显式写 `create`（文件不存在却声明 modify 也会被拦）；
  //     ③ 没有任何授权面（L0）时**弃权**（不是放行，是这段判据不存在 —— 见 README P4）。
  if (writeTools.includes(name) && binding !== null && binding.role === 'writer' && cfg.guardChangeScope !== false) {
    const task = taskOf(binding.taskId)
    const scope = task?.changeScope ?? null
    if (task !== null && Array.isArray(scope) && scope.length > 0) {
      const paths = collectPaths(args, task.projectRoot)
      for (const p of paths) {
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        // 流水线台账不属于改动面（与分区判据同一豁免）
        if (task.taskSelfDir !== undefined && task.taskSelfDir !== null && isInside(task.taskSelfDir, p)) continue
        if (isInside(task.reportsDir, p)) continue
        const hitScope = owningChangeScopeEntry(scope, p, task.scopeAnchor)
        if (hitScope === null) {
          return (
            `${TAG} 拒绝：**改动面超出了授权面**。\n` +
            `工具：${name}\n目标：${p}\n任务：${binding.taskId}\n` +
            `本次授权改动面（计划里给的，箭号后是**锚点解析结果**）：\n${describeChangeScope(scope, task.scopeAnchor)}\n` +
            '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
            '  · **新增文件也算越界**（要新建必须在计划里显式授权 create）；\n' +
            '  · "顺手重构 / 顺手统一风格 / 顺手升级依赖" = **没有授权** ⇒ 不许。\n' +
            '真需要扩大范围（例如 bug 根因在别的模块）→ **不许自作主张扩**：\n' +
            '  走澄清/变更：pipeline_clarify_request 升给需求分析，或 pipeline_roster_request 让计划 AI 重出计划，\n' +
            '  拿到新授权（新的 change_scope）之后再动。'
          )
        }
        // ② 动作是否对得上（`create` 授权只给"新建"，`delete` 授权不给写入）
        //
        //    为什么要判这一条：`action` 是**授权的意图**。
        //      · `modify` = "这个路径可以改"（含在其中新建/删文件 —— 那正是"改这个模块"的含义）
        //      · `create` = **只**授权"新建"；拿它去改一个**已存在**的文件 ⇒ 拦
        //        （那说明编写动的是别的东西，不是计划授权它建的那份）
        //      · `delete` = 授权删除；写成内容不属于它授权的事 ⇒ 拦
        let exists = true
        try {
          exists = existsSync(p)
        } catch {
          exists = true // 判不出来就不判这一条（宁可漏一次，不要误拦）
        }
        if (exists && hitScope.action === 'create') {
          return (
            `${TAG} 拒绝：命中的授权是 create，但这个路径**已经存在**。\n` +
            `工具：${name}\n目标：${p}\n命中的授权：${hitScope.id}（action=create，${hitScope.path}）\n` +
            '★ `create` 只授权"新建这一份"，**不包括改已有文件**。\n' +
            '  两种可能：① 你要改的是已有文件 → 让计划 AI 给你一条 `modify` 授权；' +
            '② 你走错了路径。都不该按"新建"处理。'
          )
        }
        if (hitScope.action === 'delete') {
          return (
            `${TAG} 拒绝：命中的授权是 delete，它只授权**删除**，不授权写入内容。\n` +
            `工具：${name}\n目标：${p}\n命中的授权：${hitScope.id}（${hitScope.path}）\n` +
            '★ 要改内容 → 让计划 AI 给你一条 `modify` 授权。'
          )
        }
      }
    }
  }

  // --- 3) ★文件读工具：控制角色不得读代码正文 ---------------------------
  //
  //   ★ 本轮扩展（设计目的：**编排别看代码**）：
  //     判据从"只判 main"扩成 `NO_CODE_READ_ROLES`（主对话 / 需求分析 / 计划）。
  //     为什么需求分析与计划也算"控制角色"：它们**不实现**，只出任务卡与计划。
  //     一旦读了实现细节，它们就会开始对实现指手画脚（定字段名、选库、加抽象），
  //     而每多一层"不必要的复杂度要求"就是一次过度工程化。
  //
  //   允许读的位置：`.pipeline/` 下的东西（需求档 / 交接物 / 记录 / 脱敏摘要 / 报告）——
  //   那正是它们该看的。判据按**路径**判，不按"读了什么内容"判。
  if (readTools.includes(name) && binding !== null && cfg.guardMainReadsCode !== false) {
    const task = taskOf(binding.taskId)
    if (task !== null && NO_CODE_READ_ROLES.includes(binding.role)) {
      const paths = collectPaths(args, task.projectRoot)
      for (const p of paths) {
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        if (isInside(task.pipelineDir, p)) continue // 任务卡 / 需求档 / 交接物是它们该看的
        return (
          `${TAG} 拒绝：${roleZh(binding.role)}不得读取代码正文。\n` +
          `工具：${name}\n目标：${p}\n任务：${binding.taskId}\n` +
          '原因：' +
          (binding.role === 'main'
            ? '主对话只负责接需求、派活、跟踪状态、关单 —— 不读代码、不做技术判断。\n'
            : `${roleZh(binding.role)}只吃**需求原文 + 需求档 + 脱敏摘要**，不看实现。\n` +
              '  ★ 读了实现就会开始对实现指手画脚（定字段名、选库、加抽象）——\n' +
              '    每多一层"不必要的复杂度要求"，就是一次**过度工程化**。\n') +
          '需要了解进展/需求请用 pipeline_status（返回脱敏摘要），' +
          '或读 .pipeline/<任务id>/ 下的需求档与交接物（那些是允许读的）。'
        )
      }
    }
  }

  // --- 3b) ★检索类工具：控制角色不得用它把代码正文捞回来 -------------------
  //
  //   判据画在"**返回值里有没有代码正文**"上：
  //     · grep / ripgrep / findstr / Select-String / codebase_search —— 返回匹配到的**行** ⇒ 拦
  //     · glob / list_dir / ls / tree —— 只返回**路径名** ⇒ 不拦
  //       （列个文件名不构成"看代码"，拦了反而让计划 AI 做出不合实际的计划。）
  //
  //   检索类工具往往**不给路径**（默认就在整个工作区里搜），所以这里比读工具更严：
  //   只要没有明确限定在 `.pipeline/` 内，就当它会翻到源码树。
  if (binding !== null && cfg.guardMainReadsCode !== false && NO_CODE_READ_ROLES.includes(binding.role)) {
    const searchTools = Array.isArray(cfg.guardFileTools?.search) && cfg.guardFileTools.search.length > 0
      ? cfg.guardFileTools.search
      : DEFAULT_SEARCH_TOOLS
    const isSearch = searchTools.some((t) => String(t).toLowerCase() === name.toLowerCase())
    if (isSearch) {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const paths = collectPaths(args, task.projectRoot).filter((p) => p.length > 0)
        const scopedToPipeline = paths.length > 0 && paths.every((p) => isInside(task.pipelineDir, p))
        if (!scopedToPipeline) {
          return (
            `${TAG} 拒绝：${roleZh(binding.role)}不得用检索工具翻源码树。\n` +
            `工具：${name}\n任务：${binding.taskId}\n` +
            (paths.length === 0
              ? '本次调用**没有限定路径** ⇒ 默认范围就是这个工作区的源码树。\n'
              : `目标：${paths.slice(0, 3).join('、')}\n`) +
            '原因：检索工具返回的是**匹配到的代码行** —— 那就是代码正文，与"用 read 读它"没有区别。\n' +
            '★ 这条边界的画法：拦"会吐正文的"检索（grep / findstr / Select-String），' +
            '不拦"只给路径名的"（glob / 列目录）—— 后者不构成"看代码"。\n' +
            '要看自己的收件箱就在 .pipeline/<任务id>/ 下面搜（那里允许）。'
          )
        }
      }
    }
  }

  // --- 4) shell 旁路（best-effort，字符串匹配）----------------------------
  if (isShellToolName(name, cfg) && binding !== null) {
    const task = taskOf(binding.taskId)
    if (task !== null) {
      const commands = collectCommandStrings(args)
      for (const cmd of commands) {
        // ★★ C3（2026-10-14）：既有判据先跑（逐字节不变）；它放行时才展开**脚本正文**，
        //   把正文喂回同一个 `scanShellCommand`。理由见 `collectCommandStrings` 下面那一段。
        const m = scanCommandWithScripts(cmd, task, binding.role, cfg)
        if (m !== null) return m
      }
    }
  }

  return undefined
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
  if (role !== 'writer' && role !== 'human') {
    if (SHELL_WRITE_RE.test(text) || SHELL_REDIRECT_RE.test(text)) {
      if (mentionsProtectedPath || SHELL_REDIRECT_RE.test(text)) {
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
  if (/(remove-item|rm|rmdir|del|erase)\b/i.test(text) && lowerPipeline.length > 0 && lowerText.includes(lowerPipeline)) {
    return (
      `${TAG} 拒绝：不得删除流水线工作区。\n任务：${task.taskId}\n工作区：${task.pipelineDir}\n` +
      '原因：task.json / handoffs / audit.jsonl 是全流程可追溯的凭据，删除即失去可审计性。'
    )
  }

  return null
}

/** 从 exec 里取调用方的 agent id（`agent.id === agent.session.id`，见 dsh-agent:511）。 */
export function agentIdOf(exec) {
  const a = exec?.agent
  if (a === null || a === undefined) return null
  if (typeof a === 'string') return a
  const id = a.id ?? a.session?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

// ---------------------------------------------------------------------------
// ★编写席位的分区判定（守门用，必须同步）
// ---------------------------------------------------------------------------

/**
 * ★ **授权面锚点**：`scope_paths` / `change_scope[].path` 里写的**裸相对路径**按谁解析。
 *
 * 为什么要有这个概念（真单 T-20261011-214043 实测）：
 *   计划的授权面写的是**插件包内相对路径**（`index.js`、`lib/tools.js`、`tests/`），
 *   而真正要改的文件在 `<工作区根>/node_modules/dsh-pipeline/` 之下。
 *   早先这里拿 `task.projectRoot`（工作区根）当基准 ⇒ 20 条授权**条条落空**，
 *   三个编写席全被挡死（本单交付面 = 0）；反过来，工作区根下**恰好同名**的
 *   `package.json` / `cordis.patch.yml` 又会被**误放行**（越界清单点名禁改的那两份）。
 *
 * 取值优先级（**都是显式的，绝不从授权面自身推断**）：
 *   ① `task.scope_anchor`（任务元数据里显式写的包根，若有）；
 *   ② `config.changeScopeAnchor`（**显式的「包根」配置项**，见 `lib/config.js`）；
 *   ③ {@link PACKAGE_ROOT} —— 本插件自己的包根（从 `lib/util.js` 的位置推出）。
 *
 * @param {string} raw - 显式给的锚点（可为空）
 * @returns {string} pathKey 形式的绝对锚点
 */
export function resolveScopeAnchor(raw) {
  const s = String(raw ?? '').trim()
  return s.length > 0 ? pathKey(resolveAgainstAnchor(PACKAGE_ROOT, s)) : PACKAGE_ROOT
}

/** 把一条 scope_path 归一化成可与绝对路径比较的形式（`.` = 锚点自身）。 */
function normScopePath(raw, anchor) {
  const a = typeof anchor === 'string' && anchor.length > 0 ? anchor : PACKAGE_ROOT
  return resolveAgainstAnchor(a, raw)
}

/**
 * 找出某个绝对路径归属于哪个席位。
 *
 * @param {Array} parts - `roster.writers.partitions`
 * @param {string} absPath
 * @param {string} anchor - 授权面锚点（分区里的裸相对路径按它解析）
 * @returns {{seat:string, matched:string, overlaps:string[]} | null}
 */
export function owningSeat(parts, absPath, anchor) {
  const hits = []
  for (const p of parts) {
    for (const raw of p.scope_paths ?? []) {
      const abs = normScopePath(raw, anchor)
      if (pathKey(abs) === pathKey(absPath) || isInside(abs, absPath)) {
        hits.push({ seat: p.seat, matched: raw })
        break
      }
    }
  }
  if (hits.length === 0) return null
  // 多条命中 = 分区表有重叠（编排层本应拦下）；兜底时取第一条并回报其余。
  return { seat: hits[0].seat, matched: hits[0].matched, overlaps: hits.slice(1).map((h) => h.seat) }
}

/** 把某个席位的范围渲染成人话（拒绝文案里用）。 */
function describeSeat(parts, seat, projectRoot) {
  const p = parts.find((x) => x.seat === seat)
  if (p === undefined) return '(不在册)'
  return (p.scope_paths ?? []).map((s) => (s === '.' ? '整棵项目根' : s)).join('、') || '(未声明)'
}

/** 把全部分区渲染成多行（拒绝文案里用）。 */
function describePartitions(parts, projectRoot) {
  void projectRoot
  return parts.map((p) => `  · ${p.seat}：${(p.scope_paths ?? []).map((s) => (s === '.' ? '整棵项目根' : s)).join('、')}`).join('\n')
}

/**
 * 把授权改动面渲染成多行（拒绝文案里用）。
 *
 * ★ 裸相对路径要**连解析结果一起打出来**：授权面写的是 `index.js` 这种包内相对路径，
 *   光看它没人知道守门到底拿它跟哪个绝对路径比 —— 真单 T-20261011-214043 上
 *   就是"看着授权了、实际条条落空"，而拒绝文案里看不出这一点。
 */
function describeChangeScope(scope, anchor) {
  return (Array.isArray(scope) ? scope : [])
    .map((e) => {
      const raw = String(e?.path ?? '?')
      const abs = resolveAgainstAnchor(anchor, e?.path)
      const shown = abs.length > 0 && abs !== raw ? ` → ${abs}` : ''
      return `  · ${e?.id ?? '?'}　${e?.action ?? '?'}　${raw}${shown}${e?.why ? `（${e.why}）` : ''}`
    })
    .join('\n')
}

/**
 * 组合两个守卫，用于自测验证"单调语义不会被互相翻转"。
 *
 * 语义与 `ToolLayer.guardReason`（`dsh-tools/lib/index.js:2646`）一致：
 * 取**第一个非 undefined** 的返回值；谁都不能把别人的拒绝改回允许。
 *
 * @param {...((exec:object)=>string|undefined)} guards
 * @returns {(exec:object)=>string|undefined}
 */
export function composeGuards(...guards) {
  return (exec) => {
    for (const g of guards) {
      if (typeof g !== 'function') continue
      const reason = g(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** 供测试与文档引用：受保护路径的判定逻辑（与 store 保持一致）。 */
export function isProtectedPath(task, absPath) {
  if (task === null || typeof task !== 'object') return false
  const p = pathKey(absPath)
  if (p.length === 0) return false
  if (!isInside(task.projectRoot, p)) return false
  return !isInside(task.pipelineDir, p)
}

/**
 * 构造一条同步任务索引记录。
 *
 * `reportsDir` **必须带 taskId**：非编写角色唯一被允许写的位置是
 * `<项目>/.pipeline/<任务id>/reports/`，而不是整个 `.pipeline/`。
 * 少了这一段，测试就能往别人的任务目录里写 —— 多任务隔离就破了。
 *
 * `writers` 是角色清单里的编写席位方案。守门要靠它判"这个席位有没有越界写别人的分区"，
 * 而守门是**同步**的（`guardReason` 同步遍历），所以必须放在这份内存索引里。
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.projectRoot
 * @param {string} input.pipelineDir
 * @param {object|null} [input.writers] - `roster.writers`
 * @param {object[]|null} [input.changeScope] - `task.change_scope`（计划的授权改动面）
 * @param {string|null} [input.scopeAnchor] - ★ 授权面锚点（裸相对路径按它解析，见 {@link resolveScopeAnchor}）
 */
export function makeTaskIndexEntry({ taskId, projectRoot, pipelineDir, scopeAnchor = null, writers = null, changeScope = null, fullTest = null, hashGateBlocked = false, hashGate = null, hashGateEscalated = false, hubEnabled = false, hubStandby = null, devDelivered = false }) {
  const pipeline = pathKey(pipelineDir)
  const self = `${pipeline}/${String(taskId).toLowerCase()}`
  return {
    taskId,
    projectRoot: pathKey(projectRoot),
    pipelineDir: pipeline,
    reportsDir: `${self}/reports`,
    /**
     * ★ 任务自己的目录 —— 流水线台账（task.json / handoffs / artifacts / reports / records）
     * 都在这儿。它**不是项目源码**，所以不属于任何编写席位的"那一段"。
     */
    taskSelfDir: self,
    /** ★ 分权落档的记录目录（各写各的，留档 AI 汇总）。 */
    recordsDir: `${self}/records`,
    /**
     * ★ **授权面锚点**（设计目的：最小改动）。
     *
     * `writers.partitions[].scope_paths` 与 `change_scope[].path` 里的**裸相对路径**
     * 一律按它解析 —— 默认是**插件包根**，不是 `projectRoot`（工作区根）。
     * 理由与真单实测见 {@link resolveScopeAnchor}。
     *
     * 它必须进这张同步索引：守门在 `guardReason` 里**同步**判"这次写入有没有超出授权"，
     * 运行时读不到盘。**按任务各存一份**，所以一个任务的锚点不会影响另一个任务的判定。
     */
    scopeAnchor: resolveScopeAnchor(scopeAnchor),
    writers: writers ?? null,
    /**
     * ★ 授权改动面（设计目的：最小改动）。
     *
     * 守门要**同步**判"这次写入有没有超出计划给的授权"，所以它和 `writers` 一样
     * 必须放在这张内存索引里。`null` = 本任务没有授权面（L0 没有计划这一站）⇒ 该判据弃权。
     */
    changeScope: Array.isArray(changeScope) && changeScope.length > 0 ? changeScope : null,
    /**
     * ★ **全量测试的放行凭据**（设计目的：别把整套测试当家常便饭）。
     *
     * 形状见 `lib/testscope.js` 的 `fullTestCredential()`：
     * `{ approval_id, round, command, scope, what_will_run }` 或 `null`。
     * 与 `changeScope` 同样必须进这张内存索引 —— 守门是**同步**的，运行时读不到盘。
     */
    fullTest: fullTest !== null && typeof fullTest === 'object' ? fullTest : null,
    /**
     * ★ **哈希前置闸门**是否正卡着（设计目的：哈希不过 ⇒ 直接打回，测试不跑）。
     *
     * 守门要在 shell 那一层**同步**判"这一刻许不许跑测试"，所以它必须进索引。
     * hashGate 只带 violations（拒绝文案要列出来），不带全量明细 —— 那在审计里。
     */
    hashGateBlocked: hashGateBlocked === true,
    hashGate: hashGate !== null && typeof hashGate === 'object' ? hashGate : null,
    /**
     * ★ 这道闸是不是**已经连续不过到阈值、交人工了**（用户拍板 P13）。
     *
     * 它只改**拒绝文案**（是"你回去改"还是"已经交人工了，等人回话"），
     * 不改放行/拦截的结论 —— 拦截仍然由 `hashGateBlocked` 决定。
     * 与其它字段一样必须进索引：守门是同步的，运行时读不到盘。
     */
    hashGateEscalated: hashGateEscalated === true,
    /**
     * ★★ **主管枢纽面**（T-20261011-56a37e）。
     *
     * 守门要在**文件工具**与**shell 测试命令**两层同步判"这个席位是不是还在待机"、
     * "编写交付了没有"，所以这两件事必须进这张内存索引（运行时读不到盘）。
     *
     * `hubStandby`：`[{role, wake_point, status:'standby'|'woken'}]`；
     * `devDelivered`：本任务是否已有编写交付（`dev_to_test`）——
     *   它是"测试位在编写交付之前不许开跑"这条判据的唯一输入。
     */
    hubEnabled: hubEnabled === true,
    hubStandby: Array.isArray(hubStandby) ? hubStandby : [],
    devDelivered: devDelivered === true,
  }
}

/**
 * ★★ 待机席位此刻**允不允许产出**（守门侧的纯判据；T-20261011-56a37e）。
 *
 * 与 `store.js` 里交接物面那道判据**同一份数据**（`task.hub.standby`），
 * 只是执法点不同：那边拦的是"交产物"，这边拦的是"写自己目录的报告"。
 * 两道都落才叫"纳入既有判据面"（安全预审阻断项 B3 的原话）。
 *
 * @param {object|null} task - 同步索引条目
 * @param {string} role
 * @returns {{blocked:false} | {blocked:true, entry:object, wake_point:string}}
 */
export function hubStandbyBlocksWrite(task, role) {
  if (task === null || task.hubEnabled !== true) return { blocked: false }
  const list = Array.isArray(task.hubStandby) ? task.hubStandby : []
  const e = list.find((s) => s !== null && typeof s === 'object' && s.role === role) ?? null
  if (e === null) return { blocked: false }
  if (e.status === 'woken') return { blocked: false }
  return { blocked: true, entry: e, wake_point: String(e.wake_point ?? '') }
}

/**
 * ★ 找出某个绝对路径落在**哪一条授权改动面**里。
 *
 * 判据：绝对路径等于授权路径，或位于它之下（授权一个目录 = 授权它底下所有文件）。
 * 归一化后比较（Windows 上大小写与反斜杠都要先抹平）。
 *
 * ★ 授权面里的**裸相对路径按 `anchor` 解析**（不是按工作区根）—— 见 {@link resolveScopeAnchor}。
 *   拿工作区根拼裸相对路径会让 20 条授权条条落空（真单 T-20261011-214043 实测），
 *   而工作区根下恰好同名的 `package.json` / `cordis.patch.yml` 又会被误放行。
 *
 * @param {object[]} scope - `task.change_scope`
 * @param {string} absPath
 * @param {string} anchor - 授权面锚点
 * @returns {{id:string, path:string, action:string} | null}
 */
export function owningChangeScopeEntry(scope, absPath, anchor) {
  const target = pathKey(absPath)
  for (const e of Array.isArray(scope) ? scope : []) {
    const raw = String(e?.path ?? '').trim()
    if (raw.length === 0) continue
    const abs = normScopePath(raw, anchor)
    if (abs === target || isInside(abs, target)) {
      return { id: String(e?.id ?? ''), path: raw, action: String(e?.action ?? '') }
    }
  }
  return null
}

/** 把 字符串/字符串数组 归一化（配置里允许两种写法）。 */
export function normalizeToolList(v) {
  return toStringArray(v)
}
