// 能力额度闸 · 把"批准的额度放行这一次"整件事收在一处（守门只留一行接线）。
/**
 * dsh-pipeline · 守门 · **能力额度闸**（用户第 1 件的执行体）
 * ============================================================================
 * 用户原话：「主对话的限制应该是平常禁止读代码、写面、工具面按角色收紧等，
 *           但是**必要时能向用户申请**」。
 *
 * 本模块是那句话在**守门里**的落点：一次调用进来，问一句"这次能不能用已批准的额度放行"。
 *
 * ---------------------------------------------------------------------------
 * ★ 五问全过才放行，且放行**立刻消耗**（追加一行 `release`）
 * ---------------------------------------------------------------------------
 *   ① 这次调用的能力**可申请**（`shell` 不在其列 —— 见 `capability.js` 文件头）；
 *   ② 台账里有一条 `approved` 且**还没用过**的额度；
 *   ③ 这次调用的**目标**落在那条额度的作用域内（按路径段判，不做字符串前缀）；
 *   ④ 额度必须覆盖**这一次调用的全部目标** —— 一次批准买的是"**这一次调用**"，
 *      不是"这一个文件"。只覆盖一部分就放行 = 凭空把作用域放大（后门写法）；
 *   ⑤ `release` 那一行**写得进去** —— 写不进就不放行。
 *
 * ★ ⑤ 为什么是 fail-closed：拿不到"它已经用过了"的记录，就没法保证"只放行一次"。
 *   宁可这一次被拒（用户看得见、可以再申请），也不能让它变成永久放宽。
 *
 * ★ 为什么整件事要收在一个 `take()` 里（而不是散在守门的四处）：
 *   （a）**行数纪律**：`lib/guard/decide.js` 本来就超 400 行，新逻辑进去必须"只接线"；
 *   （b）同一个会话在一次调用里可能有**多个目标**（`collectTargets` 会把显式路径键
 *       与单行补充扫描的结果都给出来）。它们属于**同一次调用**，额度只该问一次 ——
 *       问第二遍必然问不到（额度已经 `used`），于是"放行了又被拒"，判据自相矛盾。
 *       `released` 这个调用级布尔就是为它准备的。
 *
 * @module dsh-pipeline/lib/guard/capability-gate
 */

import { CAPABILITY, GRANTABLE_CAPABILITIES, capabilityOfTool, scopeAllows } from './capability.js'
import { appendGrant, findReleasable, grantFileOf, readGrants, targetOfCall } from './grant.js'

/**
 * 造一个**调用级**的能力额度闸。
 *
 * @param {object} opts
 * @param {object|null} opts.task 同步索引条目（要它的 `taskSelfDir` 落台账）
 * @param {string} opts.role 调用方角色（**只有 main 有额度** —— 申请入口写死在它的工具白名单上）
 * @param {string} opts.tool 工具名
 * @param {object} [opts.cfg] 插件配置（透传给 `capabilityOfTool`，认工具名用）
 * @param {()=>void} [opts.onRelease] 放行时的留痕回调（可选；失败不许影响判定）
 * @returns {{take:(capability:string, targets:string[])=>boolean, released:()=>boolean}}
 */
export function createCapabilityGate(opts = {}) {
  const { task = null, role = '', tool = '', cfg = {}, onRelease = null } = opts
  const state = { released: false }

  /**
   * ★ 这次调用是不是"这个能力"，以及**有没有**额度放行它。
   *
   * @param {string} capability 调用点声明自己属于哪一类（`CAPABILITY.*`）
   * @param {string[]} targets 这一次调用的**全部**目标
   * @returns {boolean} true = 放行（额度已消耗）
   */
  const take = (capability, targets) => {
    try {
      if (role !== 'main') return false // 额度只认申请人（申请入口只有 main 有）
      if (capabilityOfTool(tool, cfg) !== capability) return false // 工具名与调用点声明不符 ⇒ 不认
      if (!GRANTABLE_CAPABILITIES.includes(String(capability ?? ''))) return false
      if (state.released === true) return true // 同一次调用已经放行过 ⇒ 后续目标一并放行
      const file = grantFileOf(task)
      if (file.length === 0) return false
      const list = (Array.isArray(targets) ? targets : []).filter((t) => typeof t === 'string' && t.length > 0)
      const grant = findReleasable(readGrants(file), { capability, target: targetOfCall(list) })
      if (grant === null) return false
      // ★ ④ 作用域必须覆盖**全部**目标（空目标清单 ⇒ 覆盖不了 ⇒ 不放行）。
      if (list.length === 0 || !list.every((t) => scopeAllows(grant.scope, t))) return false
      const w = appendGrant(file, { id: grant.id, op: 'release', capability, tool, target: targetOfCall(list), at: new Date().toISOString() })
      if (w.ok !== true) return false
      state.released = true
      if (typeof onRelease === 'function') {
        try {
          onRelease({ capability, tool, grant: grant.id, targets: list })
        } catch {
          /* 留痕失败绝不影响判定 */
        }
      }
      return true
    } catch {
      // ★ 闸自己坏了 ⇒ **不放行**（fail-closed）：它是一条"少给能力"的路，
      //   而反方向（异常时放行）会把额度变成后门。
      return false
    }
  }

  return { take, released: () => state.released === true }
}

export { CAPABILITY }
