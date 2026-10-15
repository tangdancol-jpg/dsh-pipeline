// 强制主管 · 存储：pending 先设主管、requirement_confirmed 按档位留下或撤销、需求位派活前判据。
/**
 * dsh-pipeline · 强制主管 · 存储
 * ============================================================================
 * 本文件是「L3+ 强制主管」（裁定 1）的**唯一写点**：
 *
 *   · `hubForceOnOpen`                —— 开单（`pending`）**先强制设主管**，不做试算；
 *   · `hubSyncOnRequirementConfirmed` —— 档位落地时**留下或撤销**主管席位；
 *   · `hubCanDispatchOrchestrator`    —— **需求位能不能派**（`tier ≥ L3` 无主管 ⇒ 拒）。
 *
 * ---------------------------------------------------------------------------
 * 落点：任务卡上一个**新字段** `task.hub_requirement`
 * ---------------------------------------------------------------------------
 * 为什么不塞进既有的 `task.hub`（枢纽账本）：那个字段管的是"枢纽发起没发起、
 * 谁在待机、站点打回剩几次"；本字段管的是**"这个档位该不该有主管"** ——
 * 它是**一条治理规则的可查事实**，与枢纽的运行时状态是两件事。
 * 混在一起，"主管为什么被撤了"就变成要去枢纽账本里考古。
 *
 * ★ 判据委托 `lib/tiers/hub-required.js`（纯策略）；本文件只负责改字段 + 落盘 + 留痕。
 *
 * @module dsh-pipeline/lib/store/hub-require
 */

import { nowIso, toStringArray } from '../util.js'
import {
  HUB_ACTION,
  HUB_REQUIRED_FROM as REQUIRE_FROM,
  SUPERVISOR_ROLE,
  checkOrchestratorDispatch,
  hubPlanOnOpen,
  hubPlanOnRequirementConfirmed,
  hubRequirementRecord,
} from '../tiers/hub-required.js'

/** 审计动作名（唯一出处）。 */
export const HUB_REQUIRE_ACTIONS = Object.freeze({
  FORCE: 'hub:force_on_open',
  SYNC: 'hub:sync_on_requirement_confirmed',
  REFUSE: 'hub:refuse_orchestrator_dispatch',
})

/** 确保 `task.hub_requirement` 结构在位（**只补结构，不覆盖已有内容**）。 */
function ensureRecord(task) {
  if (task.hub_requirement === null || typeof task.hub_requirement !== 'object' || Array.isArray(task.hub_requirement)) {
    task.hub_requirement = hubRequirementRecord({})
  }
  const r = task.hub_requirement
  if (!Array.isArray(r.history)) r.history = []
  return r
}

/**
 * ★ **当前有没有主管席位**。
 *
 * 判据（两条，任一成立即"有"）：
 *   ① 角色清单里登记了 `supervisor`；
 *   ② `hub_requirement.forced === true` 且**没被撤销**（pending 阶段"先强制设上"的那一个）。
 *
 * 两条都要，是因为"先设后撤"跨越了两个时刻：强制设上时名单可能还是 `null`
 * （`pending` 时还没做计划），而撤销时又要能真的从名单里拿掉。
 *
 * @param {object} task
 * @returns {boolean}
 */
export function hubSeatPresent(task) {
  const roster = Array.isArray(task?.roster?.conversations) ? task.roster.conversations : []
  if (roster.includes(SUPERVISOR_ROLE)) return true
  const r = task?.hub_requirement
  return r !== null && typeof r === 'object' && r.forced === true && (r.revoked_at ?? null) === null
}

/** 从角色清单里拿掉主管席位（**只动这一个角色**，其余名单原样）。 */
function dropSupervisorSeat(task) {
  const roster = task?.roster
  if (roster === null || typeof roster !== 'object') return false
  const list = toStringArray(roster.conversations)
  if (!list.includes(SUPERVISOR_ROLE)) return false
  roster.conversations = list.filter((r) => r !== SUPERVISOR_ROLE)
  return true
}

/**
 * 强制主管存储方法（由 `createTaskStore` 原位展开，`this` 指向同一个对象）。
 *
 * @param {object} ctx - `{ now, deny, audit, loadTask, persist }`
 */
export function hubRequireMethods(ctx) {
  const { now, deny, loadTask, persist } = ctx
  const audit = typeof ctx.audit === 'function' ? ctx.audit : null

  return {
    /**
     * ★ **开单时**：先强制设主管（裁定 1 / 定稿 §3.5 的 `pending` 那一条）。
     *
     * 幂等：已经强制设过 ⇒ `changed:false`，不再写一遍。
     *
     * @param {string} taskId
     * @param {{by?:string}} [input]
     * @returns {Promise<object>}
     */
    async hubForceOnOpen(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const plan = hubPlanOnOpen(input)
      const r = ensureRecord(task)

      if (r.forced === true && r.revoked_at === null && r.history.some((h) => h.action === HUB_ACTION.FORCE)) {
        return { ok: true, changed: false, task, action: HUB_ACTION.FORCE, reason: '已经强制设过主管，不重复写。', plan }
      }

      const at = nowIso(now())
      r.forced = true
      r.forced_at = at
      r.forced_by = String(input.by ?? '')
      r.revoked_at = null
      r.revoked_reason = ''
      r.action = HUB_ACTION.FORCE
      /**
       * ★ 在名单里**登记**主管席位。
       *
       * `roster` 在 `pending` 时通常是 `null`（计划还没跑）—— 那时**不动它**，
       * 只靠 `hub_requirement.forced` 表示"主管在册"。等计划产出名单时，
       * 由接线方把 `supervisor` 放进 `roster.conversations`（见 `WIRING.md`）。
       * 这样"先设"不会造出一个假名单。
       */
      const roster = task?.roster
      let seatAdded = false
      if (roster !== null && typeof roster === 'object') {
        const list = toStringArray(roster.conversations)
        if (!list.includes(SUPERVISOR_ROLE)) {
          roster.conversations = [SUPERVISOR_ROLE, ...list]
          seatAdded = true
        }
      }
      r.history.push({ action: HUB_ACTION.FORCE, at, by: r.forced_by, seat_added: seatAdded })
      task.updated_at = at
      if (audit !== null) task.history.push(await audit(task.id, r.forced_by, HUB_REQUIRE_ACTIONS.FORCE, { seat_added: seatAdded }))
      await persist(task)
      return {
        ok: true,
        changed: true,
        task,
        action: HUB_ACTION.FORCE,
        seat_added: seatAdded,
        plan,
        summary:
          `已在「待分配」先把主管席位设上（裁定 1：开单先强制设主管）。${seatAdded ? '（写进了角色清单）' : '（名单还没产出，先记账）'}\n` +
          `  · ${plan.reason.split('\n')[0]}`,
      }
    },

    /**
     * ★ **档位落地时**：按档位留下或撤销主管席位。
     *
     * @param {string} taskId
     * @param {{tier:unknown, by?:string}} input
     * @returns {Promise<object>}
     */
    async hubSyncOnRequirementConfirmed(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const has = hubSeatPresent(task)
      const plan = hubPlanOnRequirementConfirmed({ tier: input.tier, hasHubSeat: has })
      if (plan.ok !== true) return deny(plan.code, plan.message)

      const r = ensureRecord(task)
      const at = nowIso(now())
      const seatRemoved = plan.action === HUB_ACTION.REVOKE ? dropSupervisorSeat(task) : false

      r.tier = plan.tier
      r.ordinal = plan.ordinal
      r.assumed = plan.assumed
      r.required = plan.required
      r.action = plan.action
      if (plan.action === HUB_ACTION.REVOKE) {
        r.revoked_at = at
        r.revoked_reason = plan.reason
        r.forced = false
      } else if (plan.required === true) {
        r.revoked_at = null
        r.revoked_reason = ''
      }
      r.history.push({ action: plan.action, at, by: String(input.by ?? ''), tier: plan.tier, ordinal: plan.ordinal, seat_removed: seatRemoved })
      task.updated_at = at
      if (audit !== null) {
        task.history.push(await audit(task.id, String(input.by ?? ''), HUB_REQUIRE_ACTIONS.SYNC, { tier: plan.tier, action: plan.action, seat_removed: seatRemoved }))
      }
      await persist(task)
      return {
        ok: true,
        changed: true,
        task,
        action: plan.action,
        tier: plan.tier,
        required: plan.required,
        seat_removed: seatRemoved,
        summary: `${plan.reason}${seatRemoved ? '\n  · 已从角色清单里移除 supervisor 席位。' : ''}`,
      }
    },

    /**
     * ★★ **需求位能不能派**（`tier ≥ L3` 且无主管 ⇒ 拒）。
     *
     * @param {string} taskId
     * @param {{requirementConfirmed?:boolean, by?:string}} [input]
     * @returns {Promise<{ok:true, required:boolean}|{ok:false, code:string, error:string}>}
     */
    async hubCanDispatchOrchestrator(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const verdict = checkOrchestratorDispatch({
        tier: task.hub_requirement?.tier,
        hasHubSeat: hubSeatPresent(task),
        requirementConfirmed: input.requirementConfirmed === true,
      })
      if (verdict.ok !== true && audit !== null) {
        task.history.push(await audit(task.id, String(input.by ?? ''), HUB_REQUIRE_ACTIONS.REFUSE, { code: verdict.code }))
        await persist(task)
      }
      return verdict
    },

    /** 强制主管的现状（只读；给状态展示与闸门用）。 */
    async hubRequirementStatus(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const r = task.hub_requirement ?? null
      return {
        ok: true,
        task,
        record: r,
        has_hub_seat: hubSeatPresent(task),
        tier: r?.tier ?? null,
        required: r?.required === true,
        revoked: (r?.revoked_at ?? null) !== null,
        summary: summarizeHubRequirement(task),
      }
    },
  }
}

/**
 * 一行摘要（给状态展示与拒绝文案用）。
 *
 * @param {object} task
 * @returns {string}
 */
export function summarizeHubRequirement(task) {
  const r = task?.hub_requirement ?? null
  /**
   * ★ **先看"有没有被撤销过"**，再看 `forced`。
   *
   * 顺序不能反：撤销时会把 `forced` 置回 `false`（"现在没强制着了"），
   * 所以先看 `forced` 会把一个**撤过的**任务说成"不在册（来源未记录）" ——
   * 而"为什么不在册"（档位 < L3 撤的，还是压根没设过）是读这段摘要的人最需要的答案。
   */
  if (r !== null && typeof r === 'object' && (r.revoked_at ?? null) !== null) {
    const tier = r.tier === null || r.tier === undefined ? '?' : r.tier
    return `主管：**已撤销**（档位 ${tier} < ${REQUIRE_FROM}，${r.revoked_at}）`
  }
  if (r === null || r.forced !== true) {
    return hubSeatPresent(task) ? '主管：在册（来源未记录）' : '主管：**不在册**'
  }
  if (r.required === true) return `主管：**必须存在**（档位 ${r.tier ?? '?'}）`
  return `主管：已先强制设上（档位 ${r.tier ?? '未定'}，等需求确认后决定去留）`
}
