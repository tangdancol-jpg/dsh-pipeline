/**
 * dsh-pipeline · **席位失联检测** · 人话描述（失联 / 疑似误判）
 * ============================================================================
 * 从 `lib/liveness.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/liveness.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/liveness/describe
 */

import { STATE_LABEL } from '../states.js'
import { LIVENESS_ACTIVITY_SOURCE, SESSION_LOG_NAME, formatDuration } from './activity.js'

/**
 * ★ **"下一步可执行动作"** —— 失联被报出来时，必须同时告诉主对话"现在能调什么"。
 *
 * 为什么这一条不能省：用户原话是「**切断后自己能意识到，然后重新输出正确内容**」。
 * 只报"它失联了"而不给可执行动作，等于让人自己猜 —— 那不是机制，是提示。
 *
 * ⚠️ 诚实的边界（写在这里，别在别处又吹一遍）：
 *   · **重派**是唯一**必然可用**的恢复路径（席位已死，它给不出任何东西）；
 *   · **换班**（`pipeline_succession`）要求该席位**先产出过 `seat_handover` 交接物** ——
 *     席位秒死时它根本没来得及交，所以这条**通常不可用**，必须标注清楚；
 *   · 人工/取消两条永远可用。
 *
 * @param {Array<object>} silent - `seatLiveness().silent`
 * @param {{taskId?:string}} [ctx]
 * @returns {string[]} 逐行的可执行动作（空数组 = 没有失联）
 */
export function nextActionsFor(silent, ctx = {}) {
  const list = Array.isArray(silent) ? silent : []
  if (list.length === 0) return []
  const taskId = String(ctx.taskId ?? '<任务id>')
  const out = ['★ **下一步（可直接调，择一）**：']
  for (const s of list) {
    const seatField = s.seat === null ? '' : `, seat: "${s.seat}"`
    out.push(
      `  · **重派同一席位**（推荐 —— 唯一必然可用的恢复路径）：` +
        `pipeline_dispatch { task_id: "${taskId}", role: "${s.role}"${seatField}, reassign: true }` +
        `　⇒ 任务若在「已阻塞」会**先自动恢复到阻塞前的状态**，且**不消耗打回预算**。`,
    )
    out.push(
      `  · 换人接着干：pipeline_succession { task_id: "${taskId}", role: "${s.role}", seat: "${s.seat ?? s.role}" }` +
        `　★ **仅当该席位留下过 「seat_handover」 交接物时可用** —— 席位秒死时它根本没来得及交，这条通常不可用。`,
    )
  }
  out.push('  · 升级给用户：pipeline_human_request（由执行角色发起；主对话用 pipeline_human_relay 转告）。')
  out.push(`  · 放弃这个任务：pipeline_transition { task_id: "${taskId}", event: "cancel" }。`)
  return out
}

/**
 * 把失联席位写成**给人看的一句话**（没有失联时给空串）。
 *
 * ★ 处置动作**不再在这里手写**：统一走 {@link nextActionsFor}。
 *   为什么：早先这里有一份手写的三步清单（重派 / 换班 / 取消），后来 `nextActionsFor`
 *   又写了一份更准的（标出了"换班在席位秒死时通常不可用"）—— **两份清单并存就会互相矛盾**，
 *   而主对话只会照其中一份做。判据只能有一个源。
 *
 * @param {Array<object>} silent
 * @param {{state?:string, state_zh?:string, silenceMs?:number, taskId?:string}} [ctx]
 * @returns {string}
 */
export function describeSilentSeats(silent, ctx = {}) {
  const list = Array.isArray(silent) ? silent : []
  if (list.length === 0) return ''
  const head =
    `⚠ **席位失联**：任务停在「${String(ctx.state_zh ?? ctx.state ?? '?')}」，` +
    `但该动的席位已经静默超过 ${ctx.silenceMs === undefined ? '' : formatDuration(ctx.silenceMs)}，` +
    '且**没有任何活着的证据**（0 交接物、0 流水、0 水位自报，' +
    `${ctx.activityKnown === false ? '并且**这一次拿不到会话日志**' : `会话日志 ${SESSION_LOG_NAME} 也没在长`}）。\n`
  const rows = list
    .map(
      (s) =>
        `  · ${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}：派活于 ${String(s.at ?? '?')}，` +
        `已静默 ${String(s.elapsed_zh ?? '?')}${s.agent_id === null ? '' : `，会话 ${s.agent_id}`}`,
    )
    .join('\n')
  return (
    head +
    rows +
    '\n★ 这**不是**"它还在想" —— 是它可能已经死了（宿主侧崩溃 / 会话被切 / 派活失败），而没人发现。\n' +
    nextActionsFor(list, { taskId: ctx.taskId }).join('\n')
  )
}

/**
 * 把"疑似误判"写成**给人看的一句话**（没有疑似误判时给空串）。
 *
 * 用户原话：「让主对话**一眼能看出**」。所以这里第一行就给结论 + 席位 + 依据，
 * 不要求读的人自己去翻 `task.json`。
 *
 * @param {Array<object>} suspects - {@link livenessSelfHeal} 的 `suspects`
 * @param {{taskId?:string, state?:string, state_zh?:string, unblocked?:boolean, will_unblock?:boolean, return_to?:string|null, reason?:string}} [ctx]
 * @returns {string}
 */
export function describeSuspectedFalsePositive(suspects, ctx = {}) {
  const list = Array.isArray(suspects) ? suspects : []
  if (list.length === 0) return ''
  const taskId = String(ctx.taskId ?? '<任务id>')
  const rows = list
    .map((s) => `  · ${s.role_zh}${s.seat === s.role ? '' : `（${s.seat}）`}：${String(s.basis ?? '')}${s.session_id === null ? '' : `，会话 ${s.session_id}`}`)
    .join('\n')
  const tail =
    ctx.unblocked === true
      ? `★ **机制已自动收回**这次阻塞，恢复到「${STATE_LABEL[String(ctx.return_to ?? '')] ?? String(ctx.return_to ?? '?')}」。`
      : ctx.will_unblock === true
        ? `★ 机制**即将自动收回**这次阻塞（恢复回「${STATE_LABEL[String(ctx.return_to ?? '')] ?? String(ctx.return_to ?? '?')}」）—— 收回那一步会在同一轮里落一条独立审计。`
        : `★ 本次**只留痕、没有自动收回**：${String(ctx.reason ?? '')}`
  return (
    `⚠ **疑似误判：席位其实活着**（任务 ${taskId} 停在「${String(ctx.state_zh ?? ctx.state ?? '已阻塞')}」）\n` +
    `上一次「席位失联」处置点名的席位**现在有阳性的存活证据**：\n` +
    rows +
    `\n★ 依据（权威来源）：${LIVENESS_ACTIVITY_SOURCE}。\n` +
    `${tail}\n`
  )
}
