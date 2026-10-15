// DEMO 存储 · 推进/回退与软约束落账：记档位结论、交轮次、记确认，并给状态机提供闸门判据。
/**
 * dsh-pipeline · DEMO 存储
 * ============================================================================
 * 本文件是 DEMO 阶段的**唯一写点**：把 `demo-rounds.js` 判过的东西落到任务卡上。
 *
 * ---------------------------------------------------------------------------
 * 落点：任务卡上一个**新字段** `task.demo`
 * ---------------------------------------------------------------------------
 * 为什么单开一个字段而不是塞进既有数组：DEMO 的账要回答三个**连在一起**的问题 ——
 *   「这个档位该怎么处理 DEMO」「已经交到第几轮了」「用户确认的是哪一轮」——
 *   拆到 `human_requests` / `history` / 别处，就没有一个地方能一次答完。
 *
 * ★ 形状与判据都委托给 `demo-rounds.js`（纯函数）；本文件只负责
 *   **改字段 + 落盘 + 留痕**，不重新实现一遍判定（两份判定必然漂移）。
 *
 * @module dsh-pipeline/lib/store/demo
 */

import { nowIso } from '../util.js'
import { DEMO_GATE_GUARD, DEMO_ROUND_GUARD, demoGate } from '../guard/demo-gate.js'
import { checkDemoConfirm, checkDemoRound, demoStateOf, summarizeDemo } from './demo-rounds.js'
import { demoPlanFor } from '../states/demo-tier-policy.js'

/** 审计动作名（唯一出处）。 */
export const DEMO_ACTIONS = Object.freeze({
  PLAN: 'demo:plan',
  ROUND: 'demo:round',
  CONFIRM: 'demo:confirm',
})

/** 确保 `task.demo` 结构在位（**只补结构，不覆盖已有内容**）。 */
function ensureDemo(task) {
  if (task.demo === null || typeof task.demo !== 'object' || Array.isArray(task.demo)) {
    task.demo = { plan: null, rounds: [], confirmed_at: null, confirm_request_id: null, confirm_answer: null, confirmed_by: null }
  }
  const d = task.demo
  if (!Array.isArray(d.rounds)) d.rounds = []
  if (d.plan === undefined) d.plan = null
  if (d.confirmed_at === undefined) d.confirmed_at = null
  if (d.confirm_request_id === undefined) d.confirm_request_id = null
  return d
}

/**
 * DEMO 存储方法（由 `createTaskStore` 原位展开，`this` 指向同一个对象）。
 *
 * @param {object} ctx - `{ now, deny, audit, loadTask, persist }`
 */
export function demoMethods(ctx) {
  const { now, deny, loadTask, persist } = ctx
  const audit = typeof ctx.audit === 'function' ? ctx.audit : null

  return {
    /**
     * ★ 记下**档位策略的结论**（裁定 5）。
     *
     * @param {string} taskId
     * @param {{tier:unknown, by?:string}} input
     * @returns {Promise<object>}
     */
    async demoPlan(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const plan = demoPlanFor(input.tier)
      if (plan.ok !== true) return deny(plan.code, plan.message)

      const d = ensureDemo(task)
      d.plan = { tier: plan.tier, action: plan.action, assumed: plan.assumed, reason: plan.reason, at: nowIso(now()), by: String(input.by ?? '') }
      task.updated_at = nowIso(now())
      if (audit !== null) task.history.push(await audit(task.id, d.plan.by, DEMO_ACTIONS.PLAN, { tier: d.plan.tier, action: d.plan.action, assumed: d.plan.assumed }))
      await persist(task)
      return { ok: true, task, plan: d.plan, summary: `档位 ${plan.tier} ⇒ DEMO 处置 \`${plan.action}\`${plan.assumed ? '（tier 未知，按保守处理）' : ''}。` }
    },

    /**
     * ★ 交**一轮** DEMO（软约束①②都在这条路径上判）。
     *
     * 无轮次硬上限：**这里没有任何"轮次太多了"的判断**（裁定 13）。
     *
     * @param {string} taskId
     * @param {{deliverable:{ref?:string,content?:string}, human_request_id:string, by?:string, note?:string}} input
     * @returns {Promise<object>}
     */
    async demoRound(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)

      const gate = checkDemoRound(task, input)
      if (gate.ok !== true) return deny(gate.code, gate.error)

      const d = ensureDemo(task)
      const at = nowIso(now())
      const round = {
        index: gate.index,
        digest: gate.digest,
        ref: String(input.deliverable?.ref ?? ''),
        human_request_id: String(input.human_request_id),
        note: String(input.note ?? ''),
        at,
        by: String(input.by ?? ''),
      }
      d.rounds.push(round)
      // ★ 又交了一轮 ⇒ 之前那次确认**作废**（确认的是旧的那一版）。
      d.confirmed_at = null
      d.confirm_request_id = null
      d.confirm_answer = null
      d.confirmed_by = null
      task.updated_at = at
      if (audit !== null) {
        task.history.push(await audit(task.id, round.by, DEMO_ACTIONS.ROUND, { index: round.index, digest: round.digest, human_request_id: round.human_request_id }))
      }
      await persist(task)
      return {
        ok: true,
        task,
        round,
        summary:
          `已交第 ${gate.index} 轮 DEMO（无轮次上限）。\n` +
          `  · 交付物：${round.ref || '(只给了正文)'}（指纹 ${round.digest.slice(0, 12)}…）\n` +
          `  · 人工请求：${round.human_request_id}\n` +
          '  · 上一轮的确认（若有）已作废 —— 确认认的是具体哪一版。',
      }
    },

    /**
     * ★ 记下**用户对某一轮 DEMO 的确认**（验收 A15 / A17）。
     *
     * @param {string} taskId
     * @param {{round_index:number, request_id:string, answer?:string, answer_source?:'user'|'timeout', by?:string}} input
     * @returns {Promise<object>}
     */
    async demoConfirm(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)

      const ok = checkDemoConfirm(task, input)
      if (ok.ok !== true) return deny(ok.code, ok.error)

      // ★ 用户"真的答复了"是硬条件：请求记录必须存在且 answered（转告 ≠ 答复）。
      const req = (Array.isArray(task.human_requests) ? task.human_requests : []).find((r) => r.request_id === ok.request_id)
      if (req === undefined) {
        return deny(
          'DEMO_CONFIRM_REQUEST_NOT_FOUND',
          `拒绝确认：人工请求 \`${ok.request_id}\` 在任务上不存在 —— 确认必须挂在**一条真实存在**的请求上。`,
        )
      }
      if (req.status !== 'answered') {
        return deny(
          'DEMO_CONFIRM_NOT_ANSWERED',
          `拒绝确认：请求 \`${ok.request_id}\` 目前是 \`${req.status}\`，**用户还没答复**。\n` +
            '★ 转告 ≠ 答复：请求发出去了只证明话带到了。\n' +
            '下一步：pipeline_human_relay 转告 → 拿到用户原话后 pipeline_human_reply。',
        )
      }

      const d = ensureDemo(task)
      const at = nowIso(now())
      d.confirmed_at = at
      d.confirm_request_id = ok.request_id
      d.confirm_answer = String(input.answer ?? req.answer_text ?? req.answer ?? '')
      d.confirmed_by = String(input.by ?? '')
      task.updated_at = at
      if (audit !== null) task.history.push(await audit(task.id, d.confirmed_by, DEMO_ACTIONS.CONFIRM, { round_index: ok.round_index, request_id: ok.request_id }))
      await persist(task)
      return {
        ok: true,
        task,
        round_index: ok.round_index,
        summary: `用户已确认第 ${ok.round_index} 轮 DEMO（请求 ${ok.request_id}）⇒ 现在可以进「待开发」了。`,
      }
    },

    /** DEMO 账本（只读）。 */
    async demoStatus(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const g = demoGate(task)
      return {
        ok: true,
        task,
        demo: demoStateOf(task),
        confirmed: g.ok === true,
        blocked_by: g.ok === true ? null : g.code,
        reason: g.ok === true ? '' : g.error,
        summary: summarizeDemo(task),
      }
    },

    /**
     * ★★ **闸门判据**（给 `checkPrecondition` 用）—— 与工具层调用**同一份**实现。
     *
     * 接线方式（见 `WIRING.md`）：在 `lib/store/precondition.js` 的 `switch` 里加两个 case：
     *   `case DEMO_GATE_GUARD:` 与 `case DEMO_ROUND_GUARD:`
     * 都 `return this.checkDemoPrecondition(task, name, input)`。
     *
     * @param {object} task
     * @param {string} name - 闸门名（`demo_confirmed` / `demo_round_ok`）
     * @param {object} [input]
     * @returns {{ok:true}|{ok:false, code:string, error:string}}
     */
    checkDemoPrecondition(task, name, input = {}) {
      if (name === DEMO_GATE_GUARD) return demoGate(task)
      if (name === DEMO_ROUND_GUARD) {
        const gate = checkDemoRound(task, input?.demo ?? input)
        return gate.ok === true ? { ok: true } : { ok: false, code: gate.code, error: gate.error }
      }
      return deny('UNKNOWN_DEMO_GUARD', `认不出的 DEMO 闸门名 \`${name}\`（只认 ${DEMO_GATE_GUARD} / ${DEMO_ROUND_GUARD}）。`)
    },
  }
}
