// 受限能力表 · 「看得见但不给」的那几类工具的**分类与作用域匹配**（纯函数，不读盘）。
/**
 * dsh-pipeline · 守门 · **受限能力**（用户原话第 1 件：可见但不给 + 可申请）
 * ============================================================================
 * 现场口径（用户原话）：
 *
 *   「主对话的限制应该是平常禁止读代码、写面、工具面按角色收紧等，
 *     但是必要时能向用户申请，主对话能知道工具，但是被告知必要申请，且最好别碰」
 *
 * 这条口径拆成两件事，本模块只负责**第一件的一半**：
 *
 *   ① **看得见**：受限的工具**不从会话清单里摘掉**（详见 `lib/boundaries.js` 的
 *      `deriveToolFace`：`main.denied` 写死为空）。模型**知道**它们存在 ——
 *      这一条是本模块的**前提**，不是它的产物。
 *   ② **不给**：调用时由守门拒绝 —— 本模块给出「这一次调用落在哪一类受限能力上、
 *      目标是什么」，供 `decide.js` 判定与 `grant.js` 匹配额度。
 *
 * ---------------------------------------------------------------------------
 * ★ 哪几类**可以申请**，哪几类**不可以**（写死在这里，不靠文档）
 * ---------------------------------------------------------------------------
 *   · `read-source`   ✅ 可申请 —— 它就是"读某个文件的正文"，作用域能精确到路径。
 *   · `search-source` ✅ 可申请 —— 同上，作用域是一个目录前缀。
 *   · `write-file`    ✅ 可申请 —— "写面 readonly"是**日常限制**，必要时能要一次。
 *   · `shell`         ❌ **不可申请** —— shell 判据是**按命令内容**判的
 *     （`lib/guard/shell.js`：改项目文件、跑测试、绕过收尾清理），它不是"一种能力"，
 *     而是"一堆边界的集合"。给它一条"申请即可整体放行"的路，等于把那一整层判据
 *     用一个布尔关掉 —— 那不是放行一次，那是拆掉边界。
 *     ⇒ 主对话要用 shell，走**具名工具**（`pipeline_status` / `pipeline_task_purge` …）。
 *
 * @module dsh-pipeline/lib/guard/capability
 */

import { isInside, pathKey } from '../util.js'
import {
  DEFAULT_READ_TOOLS,
  DEFAULT_SEARCH_TOOLS,
  DEFAULT_WRITE_TOOLS,
  isShellToolName,
} from './rules.js'

/** 能力 id（**一处定义**；`capability.json` / 台账 / 工具参数都用这几个字面量）。 */
export const CAPABILITY = Object.freeze({
  READ_SOURCE: 'read-source',
  SEARCH_SOURCE: 'search-source',
  WRITE_FILE: 'write-file',
  SHELL: 'shell',
})

/** 人话名（拒绝文案与返回摘要里用）。 */
export const CAPABILITY_ZH = Object.freeze({
  [CAPABILITY.READ_SOURCE]: '读代码正文',
  [CAPABILITY.SEARCH_SOURCE]: '用检索工具翻源码树',
  [CAPABILITY.WRITE_FILE]: '写文件',
  [CAPABILITY.SHELL]: '跑 shell 命令',
})

/**
 * ★ **可申请的能力全集**（`shell` 刻意不在里面，理由见文件头）。
 * 工具层与守门层**共用这一份** —— 手抄一份就是漂移的入口。
 */
export const GRANTABLE_CAPABILITIES = Object.freeze([
  CAPABILITY.READ_SOURCE,
  CAPABILITY.SEARCH_SOURCE,
  CAPABILITY.WRITE_FILE,
])

/** 作用域里的通配符：只允许出现在**单独**一个作用域上（`scope: "*"`）。 */
export const SCOPE_ANY = '*'

/**
 * 一次调用落在哪一类受限能力上（认不出 ⇒ `null`，调用方**不收紧**）。
 *
 * @param {string} toolName
 * @param {object} [opts] 透传给 `isShellToolName` 的配置（`cfg.guardShellTools` …）
 * @returns {string|null}
 */
export function capabilityOfTool(toolName, opts = {}) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : ''
  if (name.length === 0) return null
  const has = (list, fallback) => {
    const l = Array.isArray(list) && list.length > 0 ? list : fallback
    return l.some((t) => String(t).toLowerCase() === name)
  }
  if (has(opts.writeTools, DEFAULT_WRITE_TOOLS)) return CAPABILITY.WRITE_FILE
  if (has(opts.readTools, DEFAULT_READ_TOOLS)) return CAPABILITY.READ_SOURCE
  if (has(opts.searchTools, DEFAULT_SEARCH_TOOLS)) return CAPABILITY.SEARCH_SOURCE
  if (isShellToolName(name, opts)) return CAPABILITY.SHELL
  return null
}

/** 这条能力可不可以申请（`shell` 不可以）。 */
export function isGrantable(capability) {
  return GRANTABLE_CAPABILITIES.includes(String(capability ?? ''))
}

/**
 * 把调用方给的 `scope` 规格化成**路径前缀数组**（`['*']` = 任意目标）。
 *
 * 接受：`"*"` / 一个路径 / 路径数组。空数组或全是空串 ⇒ `[]`（= 判不了，调用方拒绝）。
 *
 * @param {unknown} scope
 * @param {string} [cwd] 相对路径的落点（守门传 `task.projectRoot`）
 * @returns {string[]}
 */
export function normalizeScope(scope, cwd = '') {
  const base = String(cwd ?? '').replace(/[\\/]+$/, '')
  const one = (v) => {
    const s = String(v ?? '').trim()
    if (s.length === 0) return ''
    if (s === SCOPE_ANY) return SCOPE_ANY
    // 相对路径落到调用方给的锚点（守门传 `task.projectRoot`）—— **不猜 cwd**。
    const abs = /^([a-z]:[\\/]|[\\/])/i.test(s) || base.length === 0 ? s : `${base}/${s}`
    return pathKey(abs)
  }
  const list = Array.isArray(scope) ? scope : [scope]
  const out = []
  for (const v of list) {
    const s = one(v)
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * ★ **作用域放行判定**（纯函数，`decide` 与自测共用这一份）。
 *
 * 三种情形：
 *   · 作用域里有 `'*'` ⇒ 放行（**申请时的原文里必须真的写了 `*`** —— 见 `describeScope`）；
 *   · 目标为空（例如检索工具没给路径，默认扫整个工作区）⇒ **只有 `'*'` 放行**；
 *   · 否则目标必须落在某个作用域**之内**（`isInside`，按路径段判，不做字符串前缀）。
 *
 * @param {string[]} scope 已规格化
 * @param {string} target 绝对路径（`''` = 这次调用没有可判的目标）
 * @returns {boolean}
 */
export function scopeAllows(scope, target) {
  const list = Array.isArray(scope) ? scope : []
  if (list.includes(SCOPE_ANY)) return true
  const t = typeof target === 'string' ? pathKey(target) : ''
  if (t.length === 0) return false
  return list.some((s) => s !== SCOPE_ANY && isInside(s, t))
}

/** 作用域的人话描述（申请文案与台账摘要共用）。 */
export function describeScope(scope) {
  const list = Array.isArray(scope) ? scope : []
  if (list.length === 0) return '（空 —— 这次申请没有任何作用域，会被拒）'
  if (list.includes(SCOPE_ANY)) return '**任意路径**（`*`）'
  return list.join('、')
}

/**
 * ★ 从工具实参里取**这次调用的目标路径**（`write-file` / `read-source` / `search-source`）。
 *
 * `collectTargets` 由调用方注入（它是 `guard/targets.js` 的导出）—— 本模块刻意
 * **不 import** 它，好让"分类与匹配"这部分能脱离文件系统单独断言。
 *
 * @param {Function} collectTargets `(args, cwd) => {path:string}[]`
 * @param {object} args 工具实参
 * @param {string} cwd
 * @returns {string[]}
 */
export function targetsOf(collectTargets, args, cwd) {
  if (typeof collectTargets !== 'function') return []
  try {
    return collectTargets(args, cwd)
      .map((t) => (typeof t?.path === 'string' ? t.path : ''))
      .filter((p) => p.length > 0)
  } catch {
    return []
  }
}
