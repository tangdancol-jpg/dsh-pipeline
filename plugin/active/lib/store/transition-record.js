/**
 * dsh-pipeline · 状态迁移 · **"这次到底记了什么"**
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑨）
 * -----------------------------------------------------------------------------
 * 主对话把任务递给主管（`pipeline_transition { event: "handoff_to_supervisor" }`），
 * 拿到的返回是：
 *
 *     任务 T-20261015-f49c2b：待分配 → 待分配。
 *
 * —— **看不出台账到底改了没有**。那条事件在状态机里是 `pending → pending`
 * （它**不改状态**，只登记"谁递的"），于是既看不出成功、也看不出它做了什么，
 * 用户没法据此判断"递单到底成没成"。
 *
 * -----------------------------------------------------------------------------
 * 判据
 * -----------------------------------------------------------------------------
 * **`from === to` 的迁移必须自己交代"记了什么"** —— 它没有状态变化可以播报，
 * 那么唯一有价值的信息就是**落下来的那条台账**（写在哪、值是什么、下一步谁动）。
 *
 * ★ 只对 `from === to` 生效：真有状态变化的迁移**照旧**只播状态（一个字不改），
 *   免得把既有的返回体搞得又长又杂。
 *
 * @module dsh-pipeline/lib/store/transition-record
 */

import { STATE_LABEL } from '../states.js'

/**
 * 一条**不改变状态**的迁移（`from === to`）落下的事实，逐条说清楚。
 *
 * @param {object} input
 * @param {string} input.event
 * @param {object} input.task - 迁移**之后**的任务对象
 * @param {string} input.from
 * @param {string} input.to
 * @param {string} [input.at] - ISO 时刻（默认取台账里那一笔）
 * @returns {string} 说明段（`from !== to` 时返回空串）
 */
export function describeTransitionRecord({ event, task, from, to, at = '' }) {
  /**
   * ★ 只在**两个状态都是真值且相等**时才加这段。
   *
   * 为什么要显式挡"空/缺"：`String(undefined) === String(undefined)` 也是 `true` ——
   * 不挡的话，`describeTransitionRecord({})` 会给一个**根本没有状态信息**的调用
   * 编出一段"状态未变"的说明（自测第一条就抓到了这个形状）。
   */
  const f = typeof from === 'string' ? from : ''
  const t = typeof to === 'string' ? to : ''
  if (f.length === 0 || t.length === 0 || f !== t) return ''
  const e = String(event ?? '')
  const stamp = String(at || task?.history?.[task.history.length - 1]?.at || task?.updated_at || '')

  if (e === 'handoff_to_supervisor') {
    /**
     * ★★ **台账到底写在哪 —— 必须读真地方**。
     *
     * 这条事件的写点是 `store/hub.js` 的 `applyHubSideEffects()`：
     *   `task.hub = { enabled:false, entry: { by, at, via, note }, standby: [] }`
     * —— 也就是 **`task.hub.entry`**。
     *
     * ⚠️ `checkPrecondition` 里那个 `{ ok:true, handoff_to_supervisor:{…} }` 的返回体
     * **并不会落到任务上**（`transition()` 只看 `check.ok`）—— 所以**不能**拿它当台账名：
     * 那会指着一个**不存在的字段**，等于把"看不出台账改没改"这条缺陷原样换个写法。
     * 本单第一版就是这么写的，被 `tests/f9-transition-record-check.mjs` 当场抓住。
     */
    const entry = task?.hub?.entry ?? null
    const by = entry === null || typeof entry !== 'object' ? '(未读到)' : String(entry.by ?? '(未记)')
    const when = entry === null || typeof entry !== 'object' ? stamp : String(entry.at ?? stamp)
    return (
      `★ **已记录**：本单已由「${by}」递给主管 —— 台账 \`task.hub.entry\` = \`{ by: "${by}", at: "${when}" }\`，**递单成功**。\n` +
      `  · 状态**本来就是**「${STATE_LABEL[to] ?? to}」，这条事件**不改状态**（它只登记"谁递的"）；\n` +
      '  · 下一步**由主管发起**：`pipeline_supervise { action: "initiate" }`（主管拉起需求/计划/架构三个席位）。'
    )
  }

  // 其它"不改状态"的事件：至少把"留痕落在哪"说清楚（不许只回一句 A → A）。
  return (
    `★ **已记录**：事件 \`${e}\` 的留痕已落 \`task.history\` + \`audit.jsonl\`（\`transition:${e}\`${stamp.length > 0 ? ` @ ${stamp}` : ''}）。\n` +
    `  · 状态**未变**（${STATE_LABEL[from] ?? from} → ${STATE_LABEL[to] ?? to}）—— 这条事件不改状态，它只留痕。`
  )
}
