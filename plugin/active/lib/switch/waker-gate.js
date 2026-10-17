// 唤醒器的**开关外壳**：把唯一投递咽喉包一层，关掉时一条都不投、一个字节都不写。
/**
 * dsh-pipeline · 功能开关 · 唤醒投递闸门
 * ============================================================================
 * 为什么在**外壳**上判、而不是改 `lib/wakeup/waker.js` 的每一处：
 *   `wake()` 是"本插件往会话里说话"的**唯一咽喉** —— 拦截缝 ③、巡检、
 *   孤儿单自恢复、工具出口四条来路都汇到这里。在咽喉上包一层，四条来路一次覆盖，
 *   而且**不可能"新增一条来路忘了判"**（新来路要么走这个对象，要么根本投不出去）。
 *
 * ★ 为什么不在 `waker.js` 里加判断：那是既有大文件（>700 行），
 *   往它里面塞开关逻辑正是本次要禁掉的"把新逻辑塞进既有大文件"。
 *   包一层 ⇒ `waker.js` **一个字节都不用改**（本次修复对它的 diff 是 0）。
 *
 * ★ 为什么关掉时**不写 audit**：`waker` 内部那条 `skip()` 出口会往
 *   `.pipeline/<任务>/audit.jsonl` 落一行 —— 而"关掉"的语义是**回到普通 DSH 行为**，
 *   任务数据不该因为一次已被关掉的功能而被改写。要查"为什么没唤醒"，
 *   看返回值的 `reason === 'switch-off'`（结构化、可断言）与观测计数（内存）。
 *
 * @module dsh-pipeline/lib/switch/waker-gate
 */

import { isEnabled } from './gate.js'

/** 关掉时统一的"没做成"返回值（形状与 `waker.wake()` 的成功/跳过出口逐一相同）。 */
const offResult = (extra = {}) => ({
  ok: true,
  injected: false,
  reason: 'switch-off',
  targetSession: '',
  requestId: '',
  key: '',
  via: null,
  sourcePreserved: false,
  ...extra,
})

/**
 * ★★ 把唤醒器包成"过闸门"的唤醒器。
 *
 * 语义与 `waker` **逐字一致**，只在最前面多一句"功能关着 ⇒ 直接返回"。
 * 关掉时会动手的出口全部包住：`wake` / `wakeForTool` / `escalateUnconsumed` / `settleByProgress`
 * （以及 `wakeForTool` 内部对 `wake` 的调用）。
 *
 * @param {object} waker - `createWaker()` 的产物
 * @param {{isOn?:()=>boolean}|null|undefined} sw - 总开关
 * @returns {object} 同形状的唤醒器（其余成员原样透出，不复制、不包装）
 */
export function withSwitchGate(waker, sw) {
  if (waker === null || waker === undefined) return waker
  const gate = () => isEnabled(sw) !== true

  return {
    ...waker,

    async wake(spec) {
      if (gate()) return offResult()
      return waker.wake(spec)
    },

    async wakeForTool(spec) {
      if (gate()) return offResult()
      return waker.wakeForTool(spec)
    },

    async escalateUnconsumed(taskId, spec) {
      // ★ 它写账本（`ledger.markEscalated`）—— off 下必须**一个字节都不写**。
      if (gate()) return { ok: true, escalated: 0, note: '多 AI 协调功能当前是关闭状态 ⇒ 不升级（也不写账本）。' }
      return waker.escalateUnconsumed(taskId, spec)
    },

    settleByProgress(taskId, task) {
      // ★ 它也写账本（`ledger.markConsumed`）—— off 下同样一个字节都不写。
      if (gate()) return { ok: true, marked: 0, note: '多 AI 协调功能当前是关闭状态 ⇒ 不结算（也不写账本）。' }
      return waker.settleByProgress(taskId, task)
    },
  }
}
