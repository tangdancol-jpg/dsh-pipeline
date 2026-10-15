// 记忆注入缝（`agent/pre-step`）：把**最近攒下的记忆**作为运行时上下文交给席位 —— 走正门、每席位一次、有硬上限。
/**
 * dsh-pipeline · 记忆 · 注入缝
 * ============================================================================
 * 设计 `04-接线点.md` §2 的每一条都落在这里（逐条对照）：
 *   · §2.2 **用 `hostMessage()` 构造**，不自己拼消息；
 *   · §2.3 复用生产者自有的 `source.kind`（`plugin:dsh-pipeline`）；
 *   · §2.4 抄 `hook-prompt.js` 的返回形状 `{...downstream, messages:[...downstream.messages, ...extra]}`；
 *   · §2.5 抄 `downstream.kind !== 'enter'` 早退；
 *   · §2.6 复用"**每席位只注入一次**"的去重 —— 每一轮都注入就是把上下文撑爆
 *          （`lib/context.js` 的三级阈值 / 换班就是被这件事逼出来的）。
 *   · §2.1 注入点必须**先**登记进 `lib/hostmsg.js` 的 `HOST_INJECTION_SITES`
 *          （不登记 = 一处会炸的裸消息：`lib/guard/hook-prompt.js:5-15` 记着那次事故）。
 *
 * ---------------------------------------------------------------------------
 * 注进去的是什么（刻意最小）
 * ---------------------------------------------------------------------------
 * **记忆库**（`.pipeline/_memory/memory.jsonl`）里最近的若干条，按
 * `route-time`（新的在前）取、用 `budget.applyBudget` 卡上限 ——
 * 与 `pipeline_recall` **同一套**取回与计价实现，不另写一份"注入专用"逻辑。
 * 库是空的（E1 刚起步）⇒ **什么都不注入**（不塞一句"暂无记忆"占位：那也是一条消息）。
 *
 * ★ 总开关：关 ⇒ 本缝**根本不挂**，且第一句仍问一次闸门（`memory-inject` 那一行）。
 *
 * @module dsh-pipeline/lib/memory/inject-hook
 */

import { agentIdOf } from '../guard.js'
import { hostMessage } from '../hostmsg.js'
import { applyBudget, meterFrom, wireLine } from './budget.js'
import { memoryFile } from './bank.js'
import { readBank } from './load.js'
import { routeTime } from './route-time.js'

/** 一次注入最多几条记忆。 */
export const MAX_INJECT_ITEMS = 8

/** 一次注入的 token 上限（**硬**：超过就截断，见 `budget.js`）。 */
export const INJECT_TOKEN_LIMIT = 600

/** 注入文本收尾那句定性 —— 一处定义（读者不该把它当成用户说的话）。 */
export const RUNTIME_CONTEXT_HINT =
  '★ 以上是**运行时上下文**（机制自动注入），**不是用户说的话**；要更细的切片用 `pipeline_recall`。'

/**
 * 造注入缝的中间件。
 *
 * @param {object} svc
 * @param {()=>boolean} svc.ask
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @param {(taskId:string)=>object|null} [svc.getTask]
 * @param {(m:string)=>void} [svc.warn]
 * @param {string} [svc.projectDir]
 * @param {Set<string>} [svc.injected] - **与席位简报共用同一个去重集合**（§2.6）；
 *   本缝用 `memory|` 前缀命名键，保证两件事互不干扰。
 * @param {{readFile:Function}} [svc.memoryFs] - 读库的文件系统缝（自测注入）
 * @param {object} [svc.tokenMeter] - `ctx.tokenMeter`（可选；拿不到就降级并如实报）
 * @returns {(payload:object, next:Function)=>Promise<*>}
 */
export function createMemoryInjectHook(svc) {
  const { ask, seatOf } = svc
  const warn = typeof svc.warn === 'function' ? svc.warn : () => {}
  const injected = svc.injected instanceof Set ? svc.injected : new Set()
  const { meter, metered_by } = meterFrom(svc.tokenMeter ?? null)

  const projectDirOf = (taskId) => {
    try {
      const task = typeof svc.getTask === 'function' && taskId.length > 0 ? svc.getTask(taskId) : null
      const bound = typeof task?.project_dir === 'string' ? task.project_dir.trim() : ''
      if (bound.length > 0) return bound
    } catch {
      /* 取不到就当没有 */
    }
    return String(svc.projectDir ?? '').trim()
  }

  return async function memoryInjectHook(payload, next) {
    // ★★ 总开关：关 ⇒ 一个字节都不注入（本缝本该已被摘掉；这一句覆盖两次采样之间的调用）。
    if (!ask()) return next()
    try {
      const seat = seatOf(agentIdOf(payload))
      if (seat === null) return next()

      const downstream = await next()
      // ★ §2.5：下游已经拒绝时**不许**硬塞消息（形状会错）。
      if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') return downstream

      // ★ §2.6：每个席位只注入一次（键带 `memory|` 前缀，与开场简报互不干扰）。
      const key = `memory|${seat.taskId}|${seat.role}|${seat.seat ?? ''}`
      if (injected.has(key)) return downstream

      const file = memoryFile(projectDirOf(seat.taskId))
      if (file.length === 0) return downstream
      const bank = await readBank(file, { fs: svc.memoryFs, limit: 200 })
      const recent = routeTime(bank.records, { limit: MAX_INJECT_ITEMS })
      const budget = applyBudget(recent, { limit: INJECT_TOKEN_LIMIT, meter, metered_by })
      if (budget.items.length === 0) return downstream

      injected.add(key)
      const lines = budget.items.map((it) => wireLine(it))
      const text =
        `【流水线 · 记忆切片】本项目已攒下 ${bank.records.length} 条记忆，这里是其中**最近 ${budget.items.length} 条**` +
        `（计价 ${budget.tokens}/${budget.limit} token，计量：${budget.metered_by}）。\n` +
        `${lines.join('\n')}\n` +
        RUNTIME_CONTEXT_HINT
      return {
        ...downstream,
        messages: [
          ...(downstream.messages ?? []),
          hostMessage({
            text,
            form: 'memory-recall',
            taskId: seat.taskId,
            role: seat.role,
            seat: seat.seat,
          }),
        ],
      }
    } catch (err) {
      // ★ 注入是"能更好"，不是"没它就不对"：**绝不抛**（抛出去会把整个 turn 带死）。
      try {
        warn(`[pipeline] 记忆注入失败（不影响本步）：${String(err?.message ?? err)}`)
      } catch {
        /* 连 warn 坏了也不许抛 */
      }
      return next()
    }
  }
}
