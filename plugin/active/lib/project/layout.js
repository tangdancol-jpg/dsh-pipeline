// 项目目录 · 目录布局：项目根之下有哪些约定路径（AGENTS.md / docs / 快照根），一处定义、别处不手抄。
/**
 * dsh-pipeline · 项目目录 · 布局
 * ============================================================================
 * 「项目目录」是**一个项目一个仓库**那条裁定的落点：项目目录 = 授权的 scope 根，
 * 也是 AGENTS.md、产品设计文档、快照目录共同的家。
 *
 * 本文件**只回答一个问题**：给一个项目根，各个约定路径分别在哪。
 * 它不建目录、不读盘、不判断策略 —— 那三件事分别归 `create.js` / `resolve.js` / `policy.js`。
 *
 * ---------------------------------------------------------------------------
 * 约定（与既有 `lib/store.js` 的 `.pipeline/` 布局**不冲突、也不重叠**）
 * ---------------------------------------------------------------------------
 *   <project_dir>/AGENTS.md              两条纪律（P2 落盘）
 *   <project_dir>/docs/product-design.md 产品目录 + 产品设计文档（P3 由留档落盘）
 *   <project_dir>/<快照版本号>/           无 git 时的快照目录（P1 snapshot-dir.js）
 *   <project_dir>/.pipeline/<task_id>/   既有的任务数据目录（**本文件不改它**）
 *
 * @module dsh-pipeline/lib/project/layout
 */

import { isAbsolute, join, resolve, sep } from 'node:path'

import { isInside, pathKey } from '../util.js'

/** 纪律文件（项目目录根）。 */
export const AGENTS_MD = 'AGENTS.md'

/** 文档目录。 */
export const DOCS_DIR = 'docs'

/** 产品设计文档（相对项目目录）。 */
export const PRODUCT_DESIGN_REL = 'docs/product-design.md'

/**
 * 快照根：**就是 project_dir 本身**。
 *
 * 裁定 D1：「非 git 时快照落在 `<项目目录>/<快照版本号>/…`，即『根』= project_dir 本身」。
 * 所以这里**没有**一层额外的 `snapshots/` —— 多一层会让"快照根"与"项目根"不再同源，
 * 而裁定 8 要求项目目录与授权面同源。
 */
export const SNAPSHOT_ROOT_IS_PROJECT_DIR = true

/**
 * 项目目录下的全部约定路径。
 *
 * @param {string} projectDir - 项目目录（绝对路径）
 * @returns {{root:string, agentsMd:string, docsDir:string, productDesign:string, pipelineDir:string}}
 */
export function projectLayout(projectDir) {
  const root = resolve(String(projectDir ?? ''))
  return {
    root,
    agentsMd: join(root, AGENTS_MD),
    docsDir: join(root, DOCS_DIR),
    productDesign: join(root, DOCS_DIR, 'product-design.md'),
    pipelineDir: join(root, '.pipeline'),
  }
}

/**
 * 某个绝对路径是否落在项目目录之内（含项目目录自身）。
 *
 * 用途：**授权面与项目目录同源**（裁定 8）—— 判定一条 `change_scope[].path`
 * 是不是在项目目录里，用的就是它。判定委托既有的 `util.isInside`（大小写与
 * 分隔符都不影响），本文件不另写一份比较逻辑。
 *
 * @param {string} projectDir
 * @param {string} absPath
 * @returns {boolean}
 */
export function isUnderProject(projectDir, absPath) {
  const p = String(absPath ?? '').trim()
  if (p.length === 0) return false
  return isInside(resolve(String(projectDir ?? '')), resolve(p))
}

/**
 * 给出一组授权面路径的**公共根**（同源判定的另一半）。
 *
 * 判据：每条路径先 `resolve()` 成绝对路径（顺带把 `.`/`..` 折叠掉），
 * 然后**按路径段**求公共前缀 —— 不是按字符比（按字符比会把 `C:/a/bc`
 * 错算成 `C:/a/b` 的子路径，那是错的）。
 *
 * ★ 返回的是**可用的真实路径**，不是 `pathKey`（小写 + 正斜杠）形式：
 *   它会被直接当项目目录用，把归一化键漏出去会让下游拿到一个大小写被改过的路径。
 *   比较时按平台语义大小写不敏感，但**取的是第一条路径的大小写**。
 *
 * @param {string[]} paths - 绝对或相对路径
 * @returns {{root:string, ok:boolean, reason:string}}
 */
export function commonScopeRoot(paths) {
  const list = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p ?? '').trim())
    .filter((p) => p.length > 0)
    .map((p) => resolve(p))
  if (list.length === 0) return { root: '', ok: false, reason: 'EMPTY_SCOPE' }

  const segs = (p) => p.split(/[\\/]+/).filter((s) => s.length > 0)
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

  let acc = segs(list[0])
  for (const p of list.slice(1)) {
    const other = segs(p)
    const next = []
    for (let i = 0; i < Math.min(acc.length, other.length); i += 1) {
      if (!same(acc[i], other[i])) break
      next.push(acc[i])
    }
    acc = next
    if (acc.length === 0) break
  }
  if (acc.length === 0) return { root: '', ok: false, reason: 'NO_COMMON_ROOT' }

  let root = acc.join(sep)
  if (!isAbsolute(root)) root = `${sep}${root}`
  return { root, ok: true, reason: 'OK' }
}

/**
 * 授权面是否**与项目目录同源**（裁定 8 / 验收 A03）。
 *
 * 判定三条（缺一不可）：
 *   ① 公共根存在；
 *   ② 公共根 == 项目目录（两侧都过 pathKey）；
 *   ③ 每一条 scope 路径都在项目目录之内。
 *
 * ★ 不一致时返回 `ok:false` —— **由调用方决定用什么口径**（验收 A03 说「以 scope_paths
 *   为准」，且「不静默改写既有字段」）。本函数**不改任何字段**，只报结论。
 *
 * @param {string} projectDir
 * @param {string[]} scopePaths
 * @returns {{ok:boolean, code:string, commonRoot:string, projectDir:string, outside:string[], message:string}}
 */
export function scopeMatchesProject(projectDir, scopePaths) {
  const root = resolve(String(projectDir ?? ''))
  const common = commonScopeRoot(scopePaths)
  const list = Array.isArray(scopePaths) ? scopePaths : []
  const outside = list.filter((p) => !isUnderProject(root, p))

  if (!common.ok) {
    return {
      ok: false,
      code: common.reason,
      commonRoot: common.root,
      projectDir: root,
      outside,
      message:
        common.reason === 'EMPTY_SCOPE'
          ? '授权面为空 —— 按边界「scope_paths 为空：不建目录、不报致命错，只记 project_id」。'
          : '授权面各条没有公共根（跨盘符或互不相交），无法与项目目录同源。',
    }
  }
  if (pathKey(common.root) !== pathKey(root) || outside.length > 0) {
    return {
      ok: false,
      code: 'SCOPE_NOT_UNDER_PROJECT',
      commonRoot: common.root,
      projectDir: root,
      outside,
      message:
        `授权面的公共根是 ${common.root}，项目目录是 ${root} —— 两者不同源。\n` +
        (outside.length > 0 ? `另有 ${outside.length} 条落在项目目录之外：${outside.join('、')}` : '') +
        '\n★ 验收 A03：以 scope_paths 为准，且**不静默改写**既有 project_dir 字段。',
    }
  }
  return {
    ok: true,
    code: 'OK',
    commonRoot: common.root,
    projectDir: root,
    outside: [],
    message: `授权面与项目目录同源（公共根 = ${common.root}）。`,
  }
}
