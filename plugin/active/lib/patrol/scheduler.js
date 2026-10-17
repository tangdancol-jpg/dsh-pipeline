/**
 * dsh-pipeline · 巡检 · **定时器**（自 `lib/patrol.js` 原样拆出，行为逐字不变）。
 *
 * 只负责按间隔调 `deps.tick`、记账、连续失败到阈值时走 `deps.onStalled` 播报；
 * 它不认识任何"补位 / 继任 / 冻结 / 推进状态"的接口（A22：只播报，不动作）。
 *
 * @module dsh-pipeline/lib/patrol/scheduler
 */

import {
  DEFAULT_PATROL_FAILURE_THRESHOLD,
  DEFAULT_PATROL_INTERVAL_MS,
} from './constants.js'

/**
 * 造一个巡检器（**只播报**）。
 *
 * 纪律（与 B17 一一对应）：
 *   · 只调 `deps.report(finding)` —— 它**只播报**；巡检器自己**不认识**任何
 *     "补位 / 继任 / 冻结 / 解冻 / 推进状态 / 重置失联计数"的接口（结构上就做不到）；
 *   · 每一次 tick **绝不抛**（抛出去会把定时器带死 —— 那正是"停摆"的成因）；
 *   · 连续失败到阈值 ⇒ 把"巡检已停摆"**播报出去**，然后**继续重试**（自愈）。
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.tick
 * @param {number} [deps.intervalMs]
 * @param {(m:string)=>void} [deps.warn]
 * @returns {{start:Function, stop:Function, runOnce:Function, stats:object, running:Function}}
 */
export function createPatrol(deps = {}) {
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0 ? deps.intervalMs : DEFAULT_PATROL_INTERVAL_MS
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const tick = typeof deps.tick === 'function' ? deps.tick : async () => {}
  const failureThreshold = Number.isFinite(deps.failureThreshold) && deps.failureThreshold > 0 ? deps.failureThreshold : DEFAULT_PATROL_FAILURE_THRESHOLD
  let timer = null
  let inFlight = false
  const stats = {
    ticks: 0,
    failures: 0,
    consecutive_failures: 0,
    /** ★ 第几段停摆（恢复后再停摆 = 新的一段 ⇒ 播报算新的一条，A23 末句）。 */
    stall_episodes: 0,
    failure_threshold: failureThreshold,
    last_tick_at: null,
    last_error: null,
    started_at: null,
  }

  async function runOnce() {
    if (inFlight) return { ok: true, skipped: true, note: '上一次巡检还在跑 —— 跳过这一次（不并发、不堆积）。' }
    inFlight = true
    stats.ticks += 1
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    try {
      await tick({ at, stats })
      stats.consecutive_failures = 0
      stats.last_tick_at = at
      stats.last_error = null
      return { ok: true, note: 'ok' }
    } catch (err) {
      // ★ A25：抛错**不许**把巡检带死，也**不许**静默 —— 记账 + warn，下一轮照跑。
      stats.failures += 1
      stats.consecutive_failures += 1
      // ★ 第一次到达阈值 ⇒ 这是**新的一段停摆**（恢复后 consecutive 会归零）。
      if (stats.consecutive_failures === failureThreshold) stats.stall_episodes += 1
      stats.last_error = String(err?.message ?? err)
      stats.last_tick_at = at
      warn(`[pipeline] 巡检本轮抛错（不会停摆，下一轮继续；连续失败 ${stats.consecutive_failures} 次）：${stats.last_error}`)
      /**
       * ★ A25：**停摆本身必须被播报** —— 而且这一支**不能依赖 tick 自己**
       *   （tick 都抛错了，指望它在里面播报就是自欺）。所以给一个**最小出口**：
       *   到达阈值那一次调 `deps.onStalled(stats)`，由装配方用"最不依赖 tick"的
       *   路径把"巡检已停摆"送出去；送不出去也只是少一条播报，**不影响重试**。
       */
      if (stats.consecutive_failures === failureThreshold && typeof deps.onStalled === 'function') {
        try {
          await deps.onStalled(stats)
        } catch (err2) {
          warn(`[pipeline] 播报"巡检已停摆"失败（下一轮照旧重试）：${String(err2?.message ?? err2)}`)
        }
      }
      return { ok: false, note: stats.last_error }
    } finally {
      inFlight = false
    }
  }

  return {
    intervalMs,
    stats,
    runOnce,
    running: () => timer !== null,
    start() {
      if (timer !== null) return false
      stats.started_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      timer = setInterval(() => {
        void runOnce()
      }, intervalMs)
      // ★ 不许因为巡检把进程钉住（DSH 退出时定时器不该拦着）。
      if (typeof timer?.unref === 'function') timer.unref()
      return true
    },
    stop() {
      if (timer === null) return false
      clearInterval(timer)
      timer = null
      return true
    },
  }
}
