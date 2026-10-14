/**
 * dsh-pipeline · 授权面 · `'.'` 这个根标记该解析成谁
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ①）
 * -----------------------------------------------------------------------------
 * L0（规则引擎自批）产出的编写席位分区写的是 `scope_paths: ['.']`，
 * 而**全项目的渲染口径**（`describeSeat` / `describePartitions` / `context.js` /
 * `tools/intake.js` / `tools/dispatch.js` / `README` / 自测夹具）都把这个 `'.'`
 * 说成「**整棵项目根**」：
 *
 *     · `lib/tiers.js:706`  「count=1 且没给范围 ⇒ 整棵项目根。这就是"退化情形"」
 *     · `lib/guard/seats.js:82`   `s === '.' ? '整棵项目根' : s`
 *     · `tests/selftest-core.mjs:470` 夹具注释「范围是整棵项目根」
 *
 * 但**判据**那一侧把它解析成了**插件包根**：
 *
 *     resolveAgainstAnchor(anchor, '.')  ⇒  anchor   // = PACKAGE_ROOT
 *
 * ⇒ 两边差了一整棵树：项目根下的任何路径都不在 `node_modules/dsh-pipeline` 之下，
 *   于是编写席**写不进项目源码树**，交付物只能落在 `.pipeline/<任务>/artifacts/`；
 *   而同一份分区在 `requirement.md` 里还写着「范围：整棵项目根」——
 *   **文案与判据自相矛盾**（真机上就是这么报出来的）。
 *
 * -----------------------------------------------------------------------------
 * 为什么修「`'.'` 的基准」而不是把默认锚点整个换掉
 * -----------------------------------------------------------------------------
 * `changeScopeAnchor` 默认取**插件包根**是**刻意**的，而且有真单实测撑着
 * （T-20261011-214043：裸相对路径 `index.js` / `lib/tools.js` 说的就是"包内的那一份"，
 *  拿工作区根去拼 ⇒ 20 条授权条条落空）。所以：
 *
 *   · **裸相对路径**（`index.js`、`tests/`、`lib/tools.js`…）—— 基准**不变**，仍是锚点；
 *   · **根标记 `'.'`** —— 单独认，解析成**本任务的 `project_root`**。
 *
 * 判据：`'.'` 在**所有**渲染里都读作"整棵项目根"，那它就必须真的是项目根。
 * 这不是放宽 —— 它把"声明"与"判据"对齐到**已经写在文案里的那个范围**；
 * 而且守门本来就用 `isInside(task.projectRoot, p)` 当前置闸（项目根之外压根不判），
 * 所以 `'.' = 项目根` 恰好与既有闸门**同一边界**。
 *
 * ★ 兼容：调用方**没给** `projectRoot` 时退回改前行为（`'.'` → 锚点）——
 *   既有测试（`tests/scope-check.mjs` 等）按三参数调用，行为逐字不变。
 *
 * @module dsh-pipeline/lib/scope/root-marker
 */

import { resolveAgainstAnchor } from '../util.js'

/** 根标记的三种写法（与 `resolveAgainstAnchor` 认的那三种一致）。 */
export const ROOT_MARKER_FORMS = Object.freeze(['.', './', '.\\'])

/** 这是不是"整棵项目根"那个标记。 */
export function isRootMarker(raw) {
  const s = String(raw ?? '').trim()
  return ROOT_MARKER_FORMS.includes(s)
}

/**
 * 解析一条授权面 / 分区路径。
 *
 * 三条口径（与 {@link resolveAgainstAnchor} 只差第一条）：
 *   ① 根标记 `'.'` ⇒ **项目根**（给了 `projectRoot` 时）；没给 ⇒ 退回锚点（改前行为）；
 *   ② 绝对路径 ⇒ 原样归一化；
 *   ③ 其它裸相对路径 ⇒ 拼到**锚点**下（改前行为，一个字没动）。
 *
 * @param {string} raw - 待解析路径
 * @param {object} [ctx]
 * @param {string} [ctx.anchor] - 授权面锚点（默认插件包根）
 * @param {string} [ctx.projectRoot] - 本任务的项目根（根标记的落点）
 * @returns {string} pathKey 形式的绝对路径；入参为空时返回空串
 */
export function resolveScopePath(raw, ctx = {}) {
  const anchor = typeof ctx.anchor === 'string' && ctx.anchor.length > 0 ? ctx.anchor : ''
  const projectRoot = typeof ctx.projectRoot === 'string' && ctx.projectRoot.length > 0 ? ctx.projectRoot : ''
  if (isRootMarker(raw) && projectRoot.length > 0) return resolveAgainstAnchor(projectRoot, '.')
  return resolveAgainstAnchor(anchor, raw)
}

/**
 * 把一条分区 / 授权路径渲染成人话。
 *
 * ★ 根标记就写「整棵项目根」——**与判据同口径**（这正是缺陷 ① 的另一半：
 *   改前渲染说"整棵项目根"、判据却按包根算）。
 */
export function describeScopePath(raw) {
  const s = String(raw ?? '').trim()
  if (s.length === 0) return '(未声明)'
  return isRootMarker(s) ? '整棵项目根' : s
}

/** 渲染一组分区路径。 */
export function describeScopePaths(list) {
  const arr = Array.isArray(list) ? list : []
  const shown = arr.map(describeScopePath).filter((x) => x.length > 0)
  return shown.length > 0 ? shown.join('、') : '(未声明)'
}
