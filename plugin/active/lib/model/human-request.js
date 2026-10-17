// 人工介入请求 · 登记记录的形状与构造：`task.human_requests[]` 的字段清单、默认值，以及「回到被打断前的状态」。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/shared.js` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 函数体**原样搬过来**（字段顺序、默认值、「没毛病就是纯读」的性质都没动）。
 *
 * @module dsh-pipeline/lib/model/human-request
 */

import { ST, WAITING_STATES } from '../states.js'
import { nowIso, shortHash } from '../util.js'
import { HUMAN_REASON_KINDS } from './handoff-fields.js'

// ---------------------------------------------------------------------------
// ★ 人工介入请求的「登记」—— 唯一实现，两条提交路径与兜底修复共用
// ---------------------------------------------------------------------------
//
// -----------------------------------------------------------------------------
// 现场（2026-10-11，真单 T-20261011-63633e 卡死）
// -----------------------------------------------------------------------------
// 症状：`pipeline_status` 里明明白白列着
//         `[人工介入请求] orchestrator→main - H-e12407f0aeb5afc0`
//       状态机也停在「等待人工答复(awaiting_human)」，
//       但 `pipeline_human_relay`（收件箱）回「没有任何人工介入请求」。
//       ⇒ 主对话**取不出问题**、**也记不回答复** ⇒ 任务永久卡死。
//
// 根因是**两份数据源各写各的**：
//   · `task.handoffs[]`       —— `pipeline_status` 那行「人工介入请求」读的是这里；
//   · `task.human_requests[]` —— relay（转告）与 reply（答复）读的是这里。
// 写第一份的是 `appendHandoff`（store.js 里 `async appendHandoff`，把交接物推进
// `task.handoffs[]` 并落盘），写第二份的是 `submitHandoff` 后半段的
// `this.createHumanRequestEntry(task, record, v.normalized)`。
// **顺序上：先 appendHandoff + persist（交接物已经落盘、状态机已经能推进），
// 后 createHumanRequestEntry。** 于是中间任何一次中断 —— 异常、进程被杀、
// 或者跑着的是"还没有登记那一步"的旧版本代码 —— 都会留下
// **「交接物在盘上、请求登记表是空的」** 这种半截现场。
// 而推进状态那一段只看 `payload.blocking`（与登记表无关），
// 所以半截现场照样能把任务推成 `awaiting_human` —— 卡死就是这么来的。
//
// -----------------------------------------------------------------------------
// 这一节的两条修补（对应现场报告的 ①②）
// -----------------------------------------------------------------------------
// ① **不能只落交接物**：登记改由 `buildHumanRequestEntry` 唯一实现，
//    `createHumanRequestEntry` 与兜底修复都走它 ⇒ 同一个 handoff_id **永不重复登记**。
// ② **兜底**：`reconcileHumanRequests` 能从「交接物 + 状态」反推出缺的那条登记，
//    使收件箱列得出、答复记得回 —— 否则已经卡住的单**救不回来**。
//
// ⚠️ 兜底只**补缺**，绝不覆盖已有记录：答复过的（`answered`）或撤回过的
//    （`withdrawn`）一律保留原样 —— 那正是"主对话不能自行把请求标记为已解决"
//    这条反例的落点（有记录就说明那条链走完了，不该被"修复"回 pending）。

/** 「请求发起时任务处在哪个状态」——用于答复后**回到被打断前的位置**。 */
function humanStateAtRequest(task, pendingEntry) {
  if (WAITING_STATES.includes(task.state) && typeof task.previous_state === 'string') return task.previous_state
  if (pendingEntry !== undefined && task.state === ST.AWAITING_HUMAN) return pendingEntry.state_at_request
  return task.state
}

/**
 * 保证「这份 human_request 交接物」在 `task.human_requests` 里**恰好有一条**登记。
 *
 * 幂等：同一个 `handoff_id` 已经有了就原样返回，不新建、不改写。
 *
 * @returns {{ entry: object, created: boolean }}
 */
export function buildHumanRequestEntry(task, record, payload, timeoutHours) {
  const p = payload ?? {}
  const created = typeof p.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.created_at) ? p.created_at : nowIso(new Date())

  // 截止时间：请求自己给了就用它；否则按配置的小时数算；配成 0 = 不设截止。
  let timeoutAt = typeof p.timeout_at === 'string' && p.timeout_at.length > 0 ? p.timeout_at : null
  if (timeoutAt === null && timeoutHours > 0) {
    const t = Date.parse(created)
    if (Number.isFinite(t)) timeoutAt = new Date(t + timeoutHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  // ★ 恢复目标：**被打断前的那个状态**（见 humanStateAtRequest 的注释）。
  const list = Array.isArray(task.human_requests) ? task.human_requests : []
  const pending = list.find((r) => r.status !== 'answered' && r.status !== 'withdrawn')
  const stateAtRequest = humanStateAtRequest(task, pending)

  const entry = {
    request_id: `HR-${shortHash(`${task.id}|${record.handoff_id}|${String(p.question_for_human ?? '')}`)}`,
    handoff_id: record.handoff_id,
    task_id: task.id,
    from_role: p.from_role,
    created_at: created,
    reason_kind: p.reason_kind,
    reason_zh: HUMAN_REASON_KINDS[p.reason_kind] ?? p.reason_kind,
    question_for_human: p.question_for_human,
    context_for_human: typeof p.context_for_human === 'string' ? p.context_for_human : '',
    options: Array.isArray(p.options) ? p.options.map((o) => ({ label: String(o?.label ?? ''), consequence: String(o?.consequence ?? '') })) : [],
    recommended: typeof p.recommended === 'string' ? p.recommended : '',
    blocking: p.blocking === true,
    blocked_stage: typeof p.blocked_stage === 'string' ? p.blocked_stage : '',
    urgency: p.urgency,
    decision_kind: p.decision_kind,
    timeout_behavior: p.timeout_behavior,
    default_option: typeof p.default_option === 'string' ? p.default_option : '',
    timeout_at: timeoutAt,
    state_at_request: stateAtRequest,
    // ★ 升级来源：由需求分析升级上来时才有值（单向门的开关）。
    escalated_from: typeof p.escalated_from === 'string' ? p.escalated_from : null,
    raised_by: typeof p.raised_by === 'string' ? p.raised_by : null,
    orchestrator_reason: typeof p.orchestrator_reason === 'string' ? p.orchestrator_reason : null,
    status: 'pending', // pending → relayed → answered
    relayed_at: null,
    relayed_by: null,
    relay_channel: '',
    relay_note: '',
    relay_count: 0,
    confirm_code: null,
    answered_at: null,
    answer_source: null,
    answer: null,
    resolved_at: null,
    resumed_to: null,
    resumed_from: null,
    /**
     * ★ 兜底修复补的登记会带这个字段（正常路径永不出现）。
     * 为什么要留痕：事后要能回答「这条请求当初是不是没登记上、
     * 是**从交接物反推**回来的」—— 不然一次静默修复就把根因盖住了。
     */
    recovered_from_handoff: false,
  }
  return entry
}
