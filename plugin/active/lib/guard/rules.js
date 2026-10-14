/**
 * dsh-pipeline · 守门 · 工具名单与角色读写分类
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/guard/rules
 */

import { isInside, pathKey } from '../util.js'

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

/** 把角色 id 渲染成人话（零依赖的小表）。 */
export function roleZh(role) {
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
export const PIPELINE_TOOL_ROLES = {
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
export const HANDOFF_DIRECTION = {
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
  clarification_request: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner', 'archivist'],
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
  // ★ 主管 / 架构图 / 归档三个席位补进来：它们在 roles.js 里都声明了这一类，
  //   而这里漏了 ⇒ 声明能产、实际交不出（主管"否掉预算用尽 ⇒ 升人工"那条唯一出口就断在这里）。
  human_request: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human', 'supervisor', 'diagrammer', 'archivist'],
  seat_handover: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'supervisor', 'archivist'],
}

/** 单条拒绝理由的统一抬头 —— 拒绝原文要能被人一眼认出是谁拦的。 */
export const TAG = '[pipeline]'
