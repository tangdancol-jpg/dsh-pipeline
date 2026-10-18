// DEMO 闸门 · 未获用户确认时，向 ready_dev 的推进被拒（验收 A17）。
/**
 * dsh-pipeline · DEMO 闸门
 * ============================================================================
 * 验收 A17：「DEMO **闸门**：未获用户确认时，向 `ready_dev` 的推进被拒，并给出**可读原因**。」
 *
 * ---------------------------------------------------------------------------
 * 这道闸门与别的闸门的区别：它拦的是"**越过用户**"
 * ---------------------------------------------------------------------------
 * 别的闸门拦的是"跳步"（编写绕过测试、测试绕过审核）。本闸门拦的是另一种跳步：
 * **把用户跳过去** —— 代码已经能跑起来了，用户还没点过头，就继续做后端。
 * 那正是裁定 6 要消灭的东西（文档 + DEMO **用户一次确认**之后才继续）。
 *
 * ---------------------------------------------------------------------------
 * 判据（三条，缺一不可；全部是"可查的事实"，不是"谁说过什么"）
 * ---------------------------------------------------------------------------
 *   ① `task.demo.rounds` 非空 —— **真的交过 DEMO**；
 *   ② `task.demo.confirmed_at` 非空 —— 有**一次**确认动作；
 *   ③ 那条确认信的 `confirm_request_id` 能在 `task.human_requests` 里找到，
 *      且 `status === 'answered'` —— **用户真的答复了**（转告 ≠ 答复）。
 *
 * ★ 第 ③ 条是关键："请求已发出"证明不了任何事（话带到了，人没回）；
 *   只有 `answered` 才证明人回了。只看前者的闸是纸做的。
 *
 * @module dsh-pipeline/lib/guard/demo-gate
 */

import { demoStateOf } from '../store/demo-rounds.js'
// ★ 判据码的**唯一出处**（`lib/errors/`）；这里只取常量，判据与文案一个字没动。
import {
  DEMO_CONFIRM_NOT_ANSWERED,
  DEMO_CONFIRM_REQUEST_NOT_FOUND,
  DEMO_NOT_CONFIRMED,
  DEMO_NOT_DELIVERED,
} from '../errors/codes.js'

/** 闸门在 `TRANSITIONS` 表里的名字（接线方要用**同一个**字符串）。 */
export const DEMO_GATE_GUARD = 'demo_confirmed'

/** 轮次闸门（每轮交 DEMO 时判）。 */
export const DEMO_ROUND_GUARD = 'demo_round_ok'

/**
 * 闸门的判定结果形状与既有 `deny` 一致（`{ok:false, code, error}`），
 * 这样接线时可以**原样**塞进 `checkPrecondition` 的 `case`，不必做适配。
 */
function deny(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

/**
 * 这个任务**是不是已经拿到了用户对 DEMO 的确认**。
 *
 * @param {object} task
 * @param {(id:string)=>(object|null)} [findHumanRequest] - 查人工请求记录（默认查 `task.human_requests`）
 * @returns {boolean}
 */
export function demoConfirmed(task, findHumanRequest) {
  return demoGate(task, findHumanRequest).ok === true
}

/**
 * ★ **闸门本体**。
 *
 * @param {object} task
 * @param {(id:string)=>(object|null)} [findHumanRequest]
 * @returns {{ok:true, round_index:number, request_id:string, confirmed_at:string}
 *          |{ok:false, code:string, error:string}}
 */
export function demoGate(task, findHumanRequest) {
  const st = demoStateOf(task)
  const lookup =
    typeof findHumanRequest === 'function'
      ? findHumanRequest
      : (id) => (Array.isArray(task?.human_requests) ? task.human_requests.find((r) => r.request_id === id) : null)

  if (st.rounds.length === 0) {
    return deny(
      DEMO_NOT_DELIVERED,
      `拒绝推进：任务 ${task?.id ?? '?'} 要进「待开发」，但它**一轮可操作 DEMO 都没交过**。\n` +
        '★ 用户口径：「复杂任务**先出可操作前端 DEMO** → **用户确认后**才继续后端」。\n' +
        '下一步：出第一轮 DEMO（`pipeline_demo { action: "round", ... }`），它会同时挂上一条人工请求。',
      { demo: summarize(st) },
    )
  }

  if (st.confirmed_at === null || st.confirm_request_id === null) {
    const last = st.rounds[st.rounds.length - 1]
    return deny(
      DEMO_NOT_CONFIRMED,
      `拒绝推进：任务 ${task?.id ?? '?'} 的 DEMO **还没获得用户确认**（已交 ${st.rounds.length} 轮，最新第 ${last.index} 轮）。\n` +
        '★ 验收 A17：未获用户确认时，向 `ready_dev` 的推进被拒。\n' +
        '下一步（二选一）：\n' +
        `  · 用户看了满意 ⇒ 主对话调 \`pipeline_demo { action: "confirm", round_index: ${last.index}, human_request_id: "${last.human_request_id}" }\`；\n` +
        '  · 用户还要改 ⇒ 再交一轮（**没有轮次上限**，只要这一轮是新的东西）。',
      { demo: summarize(st) },
    )
  }

  const req = lookup(st.confirm_request_id)
  if (req === null || req === undefined) {
    return deny(
      DEMO_CONFIRM_REQUEST_NOT_FOUND,
      `拒绝推进：确认信指向的人工请求 \`${st.confirm_request_id}\` **在任务上找不到**。\n` +
        '★ 判据要求"用户**真的答复了**"，而那条请求记录是唯一的凭据 —— 凭据没了，确认就不成立。\n' +
        '下一步：重走一次确认（用户答复由主对话用 `pipeline_human_reply` 记回来）。',
    )
  }
  if (req.status !== 'answered') {
    return deny(
      DEMO_CONFIRM_NOT_ANSWERED,
      `拒绝推进：请求 \`${st.confirm_request_id}\` 当前状态是 \`${req.status}\`，**还不是已答复**。\n` +
        '★ 为什么这条要单独判：**转告 ≠ 答复**。请求发出去了只证明"话带到了"，' +
        '只有 `answered` 才证明"人回了"—— 只看前者的闸是纸做的。\n' +
        '下一步：pipeline_human_relay 转告用户 → 拿到答复后 pipeline_human_reply（带用户原话）。',
    )
  }

  const idx = st.rounds.find((r) => r.human_request_id === st.confirm_request_id)
  return {
    ok: true,
    round_index: idx === undefined ? st.rounds.length : idx.index,
    request_id: st.confirm_request_id,
    confirmed_at: st.confirmed_at,
  }
}

/** 内部：一行摘要（拒绝文案里带上"现在到哪了"）。 */
function summarize(st) {
  const last = st.rounds.length === 0 ? null : st.rounds[st.rounds.length - 1]
  return {
    rounds: st.rounds.length,
    confirmed: st.confirmed_at !== null,
    latest_round: last === null ? null : last.index,
    latest_request: last === null ? null : last.human_request_id,
  }
}

/**
 * ★ 给人看的拒绝原因（**可读**是验收 A17 的明文要求，不是"顺手写一句"）。
 *
 * 与 {@link demoGate} 的区别：这个函数**总是**返回一段人话 ——
 * 通过时说"已经确认（第 N 轮）"，不通过时把 `error` 原样带出来。
 *
 * @param {object} task
 * @param {(id:string)=>object|null} [findHumanRequest]
 * @returns {string}
 */
export function demoGateReason(task, findHumanRequest) {
  const g = demoGate(task, findHumanRequest)
  return g.ok === true ? `DEMO 已获用户确认（第 ${g.round_index} 轮，请求 ${g.request_id}，${g.confirmed_at}）。` : g.error
}

/**
 * 这个任务**要不要**出 DEMO —— 闸门的前置问题（裁定 5）。
 *
 * ★ 与 {@link demoGate} 分开：`demoGate` 回答"能不能进 ready_dev"，
 *   本函数回答"**这个档位该不该有 DEMO**"。L0–L1 跳过时，前者根本不该被调用。
 *
 * @param {object} task
 * @returns {{action:'skip'|'ask'|'require', tier:string, assumed:boolean, reason:string}}
 */
export function demoPlanOfTask(task) {
  const st = demoStateOf(task)
  if (st.plan === null) {
    return {
      action: 'ask',
      tier: 'L2',
      assumed: true,
      reason: '任务上还没有档位结论 ⇒ **按最保守处理（等同 L2，发人工请求询问）**，不得静默跳过 DEMO。',
    }
  }
  return { action: st.plan.action, tier: st.plan.tier, assumed: st.plan.assumed === true, reason: st.plan.reason ?? '' }
}
