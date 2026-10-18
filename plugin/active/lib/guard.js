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

// ---------------------------------------------------------------------------
// 文件布局：本文件只做转出，实现按主题拆在 `lib/guard/` 下（对外导出名与拆分前逐一相同）
//   guard/rules.js    工具名单、角色读写分类、路径收集、工具 → 角色表
//   guard/seats.js    席位分区、改动面、任务索引条目
//   guard/shell.js    shell 命令判据（写 / 读代码 / 跑测试）
//   guard/scripts.js  脚本展开（命令里引用的脚本也按同一套判据扫）
//   guard/decide.js   守门主判定 guardDecision / decide
// ---------------------------------------------------------------------------

export {
  DEFAULT_WRITE_TOOLS,
  DEFAULT_READ_TOOLS,
  DEFAULT_SHELL_TOOLS,
  DEFAULT_SHELL_TOOL_PATTERN,
  PIPELINE_TOOL_PREFIX,
  READONLY_ROLES,
  NO_WRITE_ROLES,
  OWN_LOG_ROLES,
  OWN_DIR_ROLES,
  OWN_DIR_EXTS,
  OWN_LOG_EXTS,
  writeClassOf,
  checkOwnPath,
  collectPaths,
  DEFAULT_SEARCH_TOOLS,
  NO_CODE_READ_ROLES,
  codeReadRefusal,
  collectCommandStrings,
  isShellToolName,
} from './guard/rules.js'

export {
  agentIdOf,
  bindingForAgent,
  resolveScopeAnchor,
  owningSeat,
  composeGuards,
  isProtectedPath,
  makeTaskIndexEntry,
  hubStandbyBlocksWrite,
  owningChangeScopeEntry,
  normalizeToolList,
} from './guard/seats.js'

export {
  scanTestRunnerCommand,
  SOURCE_CODE_EXTS,
  looksLikeSourcePath,
  extractCommandPaths,
  scanShellCommand,
} from './guard/shell.js'

export {
  findScriptRefs,
  lastScriptExpansion,
  expandScriptCommands,
  scanCommandWithScripts,
} from './guard/scripts.js'

export {
  guardDecision,
} from './guard/decide.js'

// ---------------------------------------------------------------------------
// ★★ P0-2（2026-10-18 自测问题清单第 2 条）：**浏览器 Profile / 凭证数据卫生**。
//    判据本体（写工具 + shell）与分类名单（唯一出处）分两个文件：
//      · `guard/browser-profile.js`   —— 守门判据与可操作的拒绝文案；
//      · `guard/credential-paths.js`  —— 什么算 profile / 凭证（`lib/security.js` 也 import
//        这一份：扫描器与守门共用同一套口径，不另写第二份名单）。
// ---------------------------------------------------------------------------
export {
  BROWSER_PROFILE_GUARD,
  browserProfileWriteRefusal,
  browserProfileShellRefusal,
} from './guard/browser-profile.js'

export {
  BROWSER_PROFILE_DIR_RULES,
  CREDENTIAL_BASENAMES,
  CREDENTIAL_EXTS,
  normalizeCredentialName,
  classifyBrowserProfileDirName,
  classifyCredentialFileName,
  classifyCredentialPath,
} from './guard/credential-paths.js'

// ---------------------------------------------------------------------------
// ★★ Agent Teams 深度整合（`design/agent-teams/01-目标与边界.md` §D8）：
//    官方新工具的分类名单 —— **唯一出处** `guard/official-tools.js`。
//    这里只做转出：守门（`decide.js`）、工具面（`lib/tools.js`）、测试与钩子层
//    都必须从这一份取，**不许手抄第二份**（手抄必漂移，漂移的坏方向是放宽）。
// ---------------------------------------------------------------------------
export {
  DEFAULT_TEAM_COORD_TOOLS,
  DEFAULT_DELEGATION_TOOLS,
  DEFAULT_ESCAPE_TOOLS,
  DEFAULT_SESSION_READ_TOOLS,
  SHELL_TEXT_ARG_TOOLS,
  officialDenyForRole,
  officialCategoryOf,
  officialOutsideRole,
  isShellTextArgTool,
  applyOfficialDeny,
} from './guard/official-tools.js'
