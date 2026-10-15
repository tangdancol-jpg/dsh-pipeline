// 项目策略 · 两条取舍：走 git 还是走快照（git 优先）、快照保留哪些（最近 5 + 每里程碑 1）。
/**
 * dsh-pipeline · 项目策略
 * ============================================================================
 * 本文件回答**两个纯策略问题**（不读盘、不建目录、不调 git）：
 *
 *   ① **git 优先**（裁定 3）：有 git 就用 git；快照**只在无 git 时**用；
 *      一旦 git 化，**移除本地快照**（那条动作的确认归主对话，见 `git-init.js`）。
 *   ② **快照保留**（验收 A23 / 定稿 §七）：保留「**最近 5 个**」+「**每个里程碑 1 个**」；
 *      里程碑 = 每次用户验收通过 / 交付确认。**非里程碑且超出最近 5 个的方可清理**，
 *      里程碑快照与最近 5 个**不得删除**。
 *
 * ★ 第 ② 条来自"今天刚删掉 279MB+77MB 垃圾"的现场教训 —— 所以它必须是**可判定的**
 *   （给出 keep / remove 两个清单），而不是"看着删"。
 *
 * @module dsh-pipeline/lib/project/policy
 */

import { compareSnapshotVersions } from './snapshot-compare.js'

/** 无条件保留的最近快照个数（裁定 / 验收 A23）。 */
export const SNAPSHOT_KEEP_RECENT = 5

/** 模式取值。 */
export const MODE_GIT = 'git'
export const MODE_SNAPSHOT = 'snapshot'

/**
 * 这个项目该走 git 还是快照？
 *
 * 判定顺序（**git 优先**是硬序，不能颠倒）：
 *   ① 已经是 git 仓库（有 `.git`）⇒ `git`，且**什么都不用做**（`action:'none'`）；
 *   ② 用户**显式确认**过开仓库 ⇒ `git`，`action:'init'`（并提示"git 化后要移除本地快照"）；
 *   ③ 其余 ⇒ `snapshot`（`action:'snapshot'`）。
 *
 * @param {object} input
 * @param {boolean} input.repoPresent - 项目目录里已经有 `.git`
 * @param {boolean} [input.userConfirmed] - 主对话**显式确认**要开仓库（`pipeline_project_init { git: true }`）
 * @param {number} [input.snapshotCount] - 现有快照个数（用于提示迁移）
 * @returns {{mode:'git'|'snapshot', action:'none'|'init'|'snapshot', migrateSnapshots:boolean, reason:string}}
 */
export function gitPolicyFor(input = {}) {
  const repoPresent = input.repoPresent === true
  const confirmed = input.userConfirmed === true
  const snapshotCount = Number.isInteger(input.snapshotCount) ? input.snapshotCount : 0

  if (repoPresent) {
    return {
      mode: MODE_GIT,
      action: 'none',
      migrateSnapshots: snapshotCount > 0,
      reason:
        '项目目录已经是 git 仓库 ⇒ 直接用它（边界：已有 `.git` 不重复 init，只补 AGENTS.md + commit）。' +
        (snapshotCount > 0
          ? `\n★ 仍有 ${snapshotCount} 个本地快照目录：裁定 3 要求 git 化后**移除本地快照**并把最新内容提交进仓库（此步由主对话确认）。`
          : ''),
    }
  }
  if (confirmed) {
    return {
      mode: MODE_GIT,
      action: 'init',
      migrateSnapshots: snapshotCount > 0,
      reason:
        '主对话**显式确认**开仓库 ⇒ 走 git（`git init` + AGENTS.md + 首次 commit）。' +
        (snapshotCount > 0
          ? `\n★ 已有 ${snapshotCount} 个本地快照：git 化之后**移除**它们，并把最新内容提交进仓库（裁定 3；此步由主对话确认）。`
          : ''),
    }
  }
  return {
    mode: MODE_SNAPSHOT,
    action: 'snapshot',
    migrateSnapshots: false,
    reason:
      '既没有 `.git`、主对话也没有显式确认开仓库 ⇒ 走**快照版本目录**（裁定 3：快照只在无 git 时用；裁定 D3：git 化必须显式确认）。',
  }
}

/**
 * 快照保留策略（**纯函数**）。
 *
 * 判据（三条，与验收 A23 逐字对应）：
 *   ① **最近 `keepRecent` 个**（按**序数**，不是字符串序）—— 无条件保留；
 *   ② **每个里程碑 1 个** —— 给定里程碑版本号清单，它们在库里就无条件保留；
 *   ③ 其余（既不在最近 N 个里、又不是里程碑）⇒ **可清理**。
 *
 * ★ 「里程碑快照与最近 5 个不得删除」是**结构上**成立的：keep 先算完，remove 只从
 *   `全部 - keep` 里取，不可能把 keep 里的东西删掉。
 *
 * @param {string[]} versions - 项目目录下现存的快照版本号
 * @param {{keepRecent?:number, milestones?:string[]}} [opts]
 * @returns {{ok:true, keep:string[], remove:string[], keepRecent:string[], keepMilestones:string[],
 *            missingMilestones:string[], reasons:Record<string,string>}
 *          |{ok:false, code:string, message:string}}
 */
export function snapshotRetention(versions, opts = {}) {
  const list = (Array.isArray(versions) ? versions : []).map((v) => String(v))
  const keepRecent = Number.isInteger(opts.keepRecent) && opts.keepRecent >= 0 ? opts.keepRecent : SNAPSHOT_KEEP_RECENT
  const milestones = (Array.isArray(opts.milestones) ? opts.milestones : []).map((v) => String(v))

  let sorted
  try {
    sorted = [...list].sort(compareSnapshotVersions)
  } catch (err) {
    return { ok: false, code: 'VERSION_UNPARSABLE', message: `快照版本号列表里有无法解析的项：${err?.message ?? err}` }
  }

  const recent = sorted.slice(Math.max(0, sorted.length - keepRecent))
  const inLib = new Set(sorted)
  const milestoneKeep = milestones.filter((m) => inLib.has(m))
  const missingMilestones = milestones.filter((m) => !inLib.has(m))

  const keep = [...new Set([...recent, ...milestoneKeep])]
  const keepSet = new Set(keep)
  const remove = sorted.filter((v) => !keepSet.has(v))

  const reasons = {}
  for (const v of recent) reasons[v] = `最近 ${keepRecent} 个之一 ⇒ 保留`
  for (const v of milestoneKeep) {
    reasons[v] = reasons[v] === undefined ? '里程碑快照 ⇒ 保留' : `${reasons[v]}；同时是里程碑快照`
  }
  for (const v of remove) reasons[v] = `既不在最近 ${keepRecent} 个里，也不是里程碑 ⇒ 可清理`

  return { ok: true, keep, remove, keepRecent: recent, keepMilestones: milestoneKeep, missingMilestones, reasons }
}

/**
 * ★ **git 化之后的迁移清单**（裁定 3：有 git 后移除本地快照并把最新内容提交到仓库）。
 *
 * 本函数**只产出计划**，不动文件、也不碰远端 —— 真正的提交归 `git-init.js`，
 * 而"要不要做"由主对话确认（裁定 11：主对话先行确认是否开仓库）。
 *
 * @param {string[]} versions
 * @returns {{ok:true, removable:string[], keepMilestones:string[], latest:string|null, note:string}
 *          |{ok:false, code:string, message:string}}
 */
export function gitMigrationPlan(versions, opts = {}) {
  const r = snapshotRetention(versions, { keepRecent: 0, milestones: opts.milestones ?? [] })
  if (!r.ok) return r
  let latest = null
  try {
    const sorted = [...(Array.isArray(versions) ? versions : [])].map((v) => String(v)).sort(compareSnapshotVersions)
    latest = sorted.length === 0 ? null : sorted[sorted.length - 1]
  } catch (err) {
    return { ok: false, code: 'VERSION_UNPARSABLE', message: `快照版本号列表里有无法解析的项：${err?.message ?? err}` }
  }
  return {
    ok: true,
    removable: r.remove,
    keepMilestones: r.keepMilestones,
    latest,
    note:
      'git 化之后：① 把**最新内容**提交进仓库（不是把快照目录提交进去）；' +
      '② 移除本地快照目录（里程碑快照按裁定保留）；③ **不 push、不改 remote**。',
  }
}
