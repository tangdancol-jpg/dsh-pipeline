// DEMO 闸门 · 未获用户确认时，向 ready_dev 的推进被拒（验收 A17 / P1-7 升级版）。
/**
 * dsh-pipeline · DEMO 闸门
 * ============================================================================
 * 验收 A17：「DEMO **闸门**：未获用户确认时，向 `ready_dev` 的推进被拒，并给出**可读原因**。」
 *
 * 本文件在 P1-7（设计档 `04-demo与制品模型.md` §1）之后承担三件事：
 *   ① `demo_passed`（`demo_review → ready_dev`）的闸门：**必须有一轮 confirmed**；
 *   ② 该轮挂的 `human_request` 必须**本轮创建**（不是复用旧请求）、**已 answered**（转告 ≠ 答复）、
 *      **未被别的轮消费过**（一条请求只能用一次）；
 *   ③ `demo_round_ok`（定稿一轮时的防御判据）。
 *
 * ---------------------------------------------------------------------------
 * 为什么判据全是"可查的事实"
 * ---------------------------------------------------------------------------
 *   ① `task.demo.rounds` 里**已定稿**的轮次非空 —— 真的交过 DEMO；
 *   ② `task.demo.confirmed_at` / `confirm_request_id` 非空，且**能落到某一轮上** ——
 *      有**一次**确认动作，而且认的是**具体哪一版**；
 *   ③ 那条确认信的请求能在 `task.human_requests` 里找到、`status === 'answered'` ——
 *      **用户真的答复了**（话带到了 ≠ 人回了）；
 *   ④（P1-7 新增）请求的 `created_at` 晚于**本轮起点** —— 不是拿上一轮的旧请求冒充；
 *   ⑤（P1-7 新增）请求没有被**别的轮**消费过（`consumed_by_round`）。
 *
 * ★ **旧数据豁免**：P4 落盘的轮次/请求没有 `request_created_at` / `created_at` 这些字段，
 *   这时 ④ 与"confirmed 落在轮上"按 legacy 放宽（只看 ①②③）——
 *   任务书要求"旧单不因加判据而红"；新数据一律走严判据。
 *
 * @module dsh-pipeline/lib/guard/demo-gate
 */

import { demoPhaseAnchorOf, demoStateOf, recordedRoundsOf } from '../store/demo-rounds.js'
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
 * ★ **闸门本体**（`demo_passed` 那条边挂的判据）。
 *
 * @param {object} task
 * @param {(id:string)=>object|null} [findHumanRequest]
 * @returns {{ok:true, round_index:number, request_id:string, confirmed_at:string}
 *          |{ok:false, code:string, error:string}}
 */
export function demoGate(task, findHumanRequest) {
  const st = demoStateOf(task)
  const recorded = recordedRoundsOf(task)
  const lookup =
    typeof findHumanRequest === 'function'
      ? findHumanRequest
      : (id) => (Array.isArray(task?.human_requests) ? task.human_requests.find((r) => r.request_id === id) : null)

  if (recorded.length === 0) {
    const drafts = st.rounds.length
    return deny(
      DEMO_NOT_DELIVERED,
      `拒绝推进：任务 ${task?.id ?? '?'} 要进「待开发」，但它**一轮已定稿的可操作 DEMO 都没交过**` +
        (drafts > 0 ? `（账本里只有 ${drafts} 轮草稿，还没被主对话定稿）` : '') +
        '。\n' +
        '★ 用户口径：「复杂任务**先出可操作前端 DEMO** → **用户确认后**才继续后端」。\n' +
        '下一步：交付席位 `pipeline_demo_submit` 交本轮内容 → 主对话 `pipeline_demo { action: "round", round_index, human_request_id }` 定稿一轮 → 用户答复 → confirm → `demo_passed`。',
      { demo: summarize(st) },
    )
  }

  if (st.confirmed_at === null || st.confirm_request_id === null) {
    const last = recorded[recorded.length - 1]
    return deny(
      DEMO_NOT_CONFIRMED,
      `拒绝推进：任务 ${task?.id ?? '?'} 的 DEMO **还没获得用户确认**（已定稿 ${recorded.length} 轮，最新第 ${last.index} 轮）。\n` +
        '★ 验收 A17：未获用户确认时，向 `ready_dev` 的推进被拒。\n' +
        '下一步（二选一）：\n' +
        `  · 用户看了满意 ⇒ 主对话调 \`pipeline_demo { action: "confirm", round_index: ${last.index}, human_request_id: "${last.human_request_id}" }\`，再触发 \`pipeline_transition { event: "demo_passed" }\`；\n` +
        '  · 用户还要改 ⇒ `pipeline_transition { event: "demo_rework" }` 回 DEMO 制作中，再交一轮（**没有轮次上限**，只要这一轮是新的东西）。',
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

  /**
   * ★★ **确认必须落在某一轮上**（P1-7）。
   * 旧数据（P4：只有全局 confirmed_at + confirm_request_id）里能按请求 id 找到那轮即可；
   * 新数据（轮次有 `request_created_at`）必须还带 `round.confirmed_at`。
   */
  const round =
    recorded.find((r) => r.human_request_id === st.confirm_request_id) ??
    recorded.find((r) => r.confirm_request_id === st.confirm_request_id) ??
    null
  if (round === null) {
    return deny(
      DEMO_NOT_CONFIRMED,
      `拒绝推进：确认信指向的请求 \`${st.confirm_request_id}\` **没有落在任何一轮 DEMO 上** —— 确认必须认的是**具体哪一版**。\n` +
        '下一步：重新 `pipeline_demo { action: "confirm", round_index, human_request_id }`（对某一轮），再触发 `demo_passed`。',
      { demo: summarize(st) },
    )
  }
  if (String(round.status ?? '') === 'recorded' && typeof round.confirmed_at !== 'string') {
    return deny(
      DEMO_NOT_CONFIRMED,
      `拒绝推进：第 ${round.index} 轮的定稿记录里**没有确认时间**（只有全局时间戳）—— 新流程要求"确认落在轮上"。\n` +
        '下一步：重新 `pipeline_demo { action: "confirm", round_index: ' + String(round.index) + ', human_request_id: "' + String(round.human_request_id) + '" }`。',
      { demo: summarize(st) },
    )
  }
  if (round.request_created_at === undefined && typeof req.created_at !== 'string') {
    // ★ legacy（P4 旧数据）：没有"请求何时创建"的记录 —— 只做上面的弱判据。
  } else {
    /** ④ 本轮创建：请求必须晚于**本轮起点**（上一轮定稿时间 / 档位结论时间 / 任务创建时间）。 */
    const prev = recorded.filter((r) => r.index < round.index).slice(-1)[0] ?? null
    const anchor = prev !== null && typeof prev.at === 'string' ? prev.at : demoPhaseAnchorOf({ ...task, demo: { ...(task?.demo ?? {}), rounds: recorded.filter((r) => r.index < round.index) } })
    if (typeof req.created_at === 'string' && anchor.length > 0 && req.created_at < anchor) {
      return deny(
        'DEMO_REQUEST_STALE',
        `拒绝推进：第 ${round.index} 轮挂的请求 \`${st.confirm_request_id}\` 是**更早以前创建的**（${req.created_at} 早于本轮起点 ${anchor}）—— ` +
          '不能拿旧请求冒充"本轮询问过用户"。\n' +
          '★ 判据：`round` 的 `human_request_id` 必须**本轮创建**（一条请求只能服务一轮）。\n' +
          '下一步：为本轮新起一条请求、拿到用户答复后重新定稿这一轮（`pipeline_demo { action: "round" }`）。',
      )
    }
    /** ⑤ 未被别的轮消费。 */
    if (req.consumed === true && Number.isInteger(req.consumed_by_round) && req.consumed_by_round !== round.index) {
      return deny(
        'DEMO_REQUEST_CONSUMED',
        `拒绝推进：请求 \`${st.confirm_request_id}\` **已经被第 ${req.consumed_by_round} 轮消费过**，不能再拿来确认第 ${round.index} 轮。\n` +
          '★ 一条请求只能用一次 —— 否则"确认的是哪一轮"会被复用搅混。\n' +
          '下一步：为本轮新起一条请求并重新确认。',
      )
    }
  }

  return {
    ok: true,
    round_index: round.index,
    request_id: st.confirm_request_id,
    confirmed_at: st.confirmed_at,
  }
}

/** 内部：一行摘要（拒绝文案里带上"现在到哪了"）。 */
function summarize(st) {
  const recorded = st.rounds.filter((r) => r?.status !== 'submitted')
  const last = recorded.length === 0 ? null : recorded[recorded.length - 1]
  return {
    rounds: recorded.length,
    drafts: st.rounds.length - recorded.length,
    confirmed: st.confirmed_at !== null,
    latest_round: last === null ? null : last.index,
    latest_request: last === null ? null : last.human_request_id,
  }
}

/**
 * ★ 给人看的拒绝原因（**可读**是验收 A17 的明文要求，不是"顺手写一句"）。
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
