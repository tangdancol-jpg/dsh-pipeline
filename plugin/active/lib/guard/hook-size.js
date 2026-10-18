// 拦截缝 · 文件规模提醒：post-execute 记行数，pre-step 把问句**程序自动发起**给 AI。
/**
 * dsh-pipeline · 拦截缝 · 文件规模提醒
 * ============================================================================
 * 用户需求（2026-10-18 逐字）：
 *   「文件行数大于 150 就开始提醒 ai，自动发起对话询问：有必要写这么大吗？是因为
 *     顺手写一起了还是功能需求；大于 300，二次询问；400 时三次提问：一定这个写法吗？
 *     有没有更优的写法？你能不能上网调用 Search 接口和 Fetch 接口查询有没有更优质的写法。」
 *
 * 落法（两条**既有**缝，不新挂事件）：
 *   · `tools/post-execute`（本文件 `createSizeWatchHook`）：写类工具执行完 ⇒ 数目标文件行数 ⇒
 *     按 150/300/400 判档 ⇒ 同一文件同一档**只记一次**（去重状态在 `lib/size-reminder.js`）；
 *   · `agent/pre-step`（本文件 `createSizeAskHook`）：下一次开步时把待问的条目作为
 *     **宿主用户消息**注入（`hostMessage`，登记在 `lib/hostmsg.js` 的 `HOST_INJECTION_SITES`）
 *     —— 这就是"程序自动发起对话"，AI 会把它当用户消息来回答。
 *
 * 纪律（三条，缺一条就变成噪音或事故）：
 *   ① **只提醒，不否决**：不改工具结果、不 block、不抛；提醒失败一律吞掉；
 *   ② **只对管线席位**：与其它拦截缝同一条判据（`seatOf(agentId)` 为 null ⇒ 直通）；
 *   ③ **去重 + 有界**：同一文件同一档只问一次；每次开步最多 2 条；状态表有上限。
 *
 * @module dsh-pipeline/lib/guard/hook-size
 */

import { agentIdOf } from '../guard.js'
import { hostMessage } from '../hostmsg.js'
import { SIZE_REMINDER_FORM, isWatchedTool, shortPath, writtenPathOf } from '../size-reminder.js'

/** 待投递提醒的 `source.form`（与 `lib/hostmsg.js` 的登记表同一字面值）。 */
export const SIZE_ASK_FORM = SIZE_REMINDER_FORM

/**
 * 造 `tools/post-execute` 的观察缝：**只记录，不改变结果**。
 *
 * @param {object} svc
 * @param {()=>boolean} svc.ask - 闸门（`shouldFire('seam-post-execute-size-watch')` + 观测计数）
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @param {{note:Function, cfg:Function, take:Function}} svc.sizeReminder
 * @returns {(exec:object, result:*, next:Function)=>Promise<*>}
 */
export function createSizeWatchHook(svc) {
  const { ask, seatOf } = svc
  const reminder = svc.sizeReminder
  return async function sizeWatchHook(exec, result, next) {
    // ★ 总开关：关 ⇒ 一个字节都不记录。
    if (!ask()) return next()
    try {
      const cfg = reminder.cfg()
      if (!cfg.enabled) return next()
      const agentId = agentIdOf(exec)
      const seat = seatOf(agentId)
      if (seat === null) return next()
      const tool = String(exec?.name ?? exec?.tool ?? '')
      if (!isWatchedTool(tool, cfg)) return next()
      const args = exec?.arguments ?? exec?.args ?? {}
      const cwd = exec?.cwd ?? exec?.agent?.cwd ?? process.cwd()
      const file = writtenPathOf(args, cwd)
      if (file === null) return next()
      reminder.note({ agentId, files: [file] })
    } catch {
      // 提醒是"更好"，不是判决的前提：任何异常都不许影响这次工具调用的结果。
    }
    return next()
  }
}

/**
 * 造 `agent/pre-step` 的投递缝：把待问的规模问题作为**用户消息**自动发起。
 *
 * @param {object} svc
 * @param {()=>boolean} svc.ask - 闸门（`shouldFire('seam-pre-step-size-ask')`）
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @param {{take:Function}} svc.sizeReminder
 * @returns {(payload:object, next:Function)=>Promise<*>}
 */
export function createSizeAskHook(svc) {
  const { ask, seatOf } = svc
  const reminder = svc.sizeReminder
  return async function sizeAskHook(payload, next) {
    if (!ask()) return next()
    const downstream = await next()
    if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') return downstream
    try {
      const agentId = agentIdOf(payload)
      if (agentId === null) return downstream
      const seat = seatOf(agentId)
      if (seat === null) return downstream
      const items = reminder.take(agentId)
      if (!Array.isArray(items) || items.length === 0) return downstream
      const extra = items.map((item) =>
        hostMessage({
          text: item.text,
          form: SIZE_ASK_FORM,
          taskId: seat.taskId,
          role: seat.role,
          seat: seat.seat,
          extra: { file: shortPath(item.file), lines: item.lines, level: item.level },
        }),
      )
      return { ...downstream, messages: [...(downstream.messages ?? []), ...extra] }
    } catch {
      return downstream
    }
  }
}
