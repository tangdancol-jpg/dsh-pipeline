/**
 * dsh-pipeline · **巡检兜底**（只播报、不动作）
 * ============================================================================
 * 用户裁定（2026-10-12，方案 4 的第二项新授权）：
 *   「**加一条巡检兜底**」—— 定时巡检并播报「长时间无进展」。
 * 需求层把它折成 A21–A25 与 B17–B19：
 *   · A21 存在且**可判定**：触发口径有明确默认值且可配置；
 *   · A22 **只播报，不动作**：不补位、不继任、不冻结、不解冻、不推进/回退状态、
 *     不重置失联计数；巡检那一刻任务与席位状态必须与巡检前一致；
 *   · A23 **既不刷屏也不吃事件**：同一条无进展跨多次巡检**只播一次**；
 *     进展恢复后再卡住算**新的一条**；不吃同刻其它类别的事件；
 *   · A24 **不是弱化失联检测的后门**：真闲置超阈值仍判失联（A12 不变），
 *     两者**判据不同源、互不冒充**（失联 = 静默超阈值；巡检 = **无进展**超口径）；
 *   · A25 **新失败面同样看得见**：巡检自身抛错必须留痕，且**不许整体停摆**
 *     （要么自愈重试，要么把"巡检已停摆"本身播报出去）。
 *
 * ---------------------------------------------------------------------------
 * 它修的是哪一处残留静默面
 * ---------------------------------------------------------------------------
 * 「席位中止播报恰好也不通」是唯一剩下的静默面：中止检测得靠**下一次工具调用**
 * 或**下一次开步**才跑得到（写时检查），而"没有任何人在动"恰恰让那两个触发点
 * 都失效。所以需要一条**与任何人无关的**周期性检查 —— 它只回答一句话：
 * 「这张单已经多久没有任何进展了？」，然后把答案**播报**出去。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么它不会变成新的刷屏源（写在判据里，不是写在善意里）
 * ---------------------------------------------------------------------------
 *   ① 同一条无进展的**身份是内容派生的**（`<状态>|<最后一次进展时刻>`）——
 *      跨多次巡检是**同一个键** ⇒ 播报被幂等吃掉（A23 / B27）；
 *   ② 进展一旦恢复，`最后一次进展时刻`就变了 ⇒ 再卡住是**新的一条**（不会永久哑掉）；
 *   ③ 巡检**自己**不产生"进展"（它不改任何状态），所以它不会自喂自；
 *   ④ 抛错**不静默**、也**不无限刷屏**：连续失败到阈值才播一次"巡检已停摆"，
 *      恢复后再失败算新的一条。
 *
 * @module dsh-pipeline/lib/patrol
 */

import { EXPECTED_ROLES_BY_STATE } from './liveness.js'
import { STATE_LABEL, TERMINAL_STATES } from './states.js'

/** 巡检间隔默认值：5 分钟（够快发现，又不至于变成心跳刷屏源）。 */
export const DEFAULT_PATROL_INTERVAL_MS = 5 * 60 * 1000

/** "任务长时间无进展"的默认口径：20 分钟。 */
export const DEFAULT_TASK_STALL_MS = 20 * 60 * 1000

/** "已投递但没人接管"的默认口径：15 分钟（R1 的升级叫醒阈值）。 */
export const DEFAULT_UNCONSUMED_MS = 15 * 60 * 1000

/** 巡检连续抛错到几次就播报"巡检已停摆"（A25）。 */
export const DEFAULT_PATROL_FAILURE_THRESHOLD = 3

/**
 * ★ **哪些状态下"无进展"值得播报**。
 *
 * 刻意**不含**等待态：`awaiting_human`（等用户）与 `awaiting_clarification`
 * （等需求分析）里"没有进展"是**正常**的 —— 那两处的判据是"投递有没有被接管"
 * （见下面的 `unconsumed-delivery`），而不是"任务卡住了"。
 * 也不含终态与「已阻塞」（后者已经有人被叫过了，再报一次就是刷屏）。
 */
export const PATROL_ACTIVE_STATES = Object.freeze([
  ...new Set([
    ...Object.keys(EXPECTED_ROLES_BY_STATE),
    'developing',
    'testing',
    'reviewing',
    'returned_to_dev',
    'returned_to_test',
  ]),
])

/** 毫秒 → ISO（秒级，与项目其它留痕同口径）。 */
function isoAt(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 从任务台账里取「最后一次进展」的时刻（毫秒；取不到时 null，**不猜**）。 */
export function lastProgressAtMs(task) {
  const stamps = []
  const take = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      stamps.push(v)
      return
    }
    if (typeof v === 'string' && v.length > 0) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) stamps.push(t)
    }
  }
  for (const h of Array.isArray(task?.handoffs) ? task.handoffs : []) take(h?.created_at)
  for (const a of Array.isArray(task?.artifacts) ? task.artifacts : []) take(a?.created_at ?? a?.at)
  for (const r of Array.isArray(task?.records) ? task.records : []) take(r?.at)
  for (const r of Array.isArray(task?.context_reports) ? task.context_reports : []) take(r?.at)
  for (const r of Array.isArray(task?.human_requests) ? task.human_requests : []) take(r?.resolved_at ?? r?.at)
  for (const r of Array.isArray(task?.clarification_requests) ? task.clarification_requests : []) take(r?.resolved_at ?? r?.at)
  const hist = Array.isArray(task?.history) ? task.history : []
  for (let i = hist.length - 1; i >= 0; i--) {
    take(hist[i]?.at)
    if (stamps.length > 0) break
  }
  // ★ 派活也是一种"有人动过"的证据（否则"刚派完活、席位还在读文件"会被误判成无进展）。
  for (const d of Array.isArray(task?.dispatched) ? task.dispatched : []) take(d?.at)
  if (stamps.length === 0) return null
  return Math.max(...stamps)
}

/**
 * ★★ **一次巡检的纯判据**（不读盘、不写盘、不抛）。
 *
 * @param {object} spec
 * @param {object|null} spec.task
 * @param {number} [spec.now]
 * @param {number} [spec.stallMs] - 任务无进展口径
 * @param {Array<object>} [spec.unconsumed] - `wakeup.pendingDeliveries()` 的结论
 * @param {Array<object>} [spec.unresolved] - 账本里"没投出去"的事件
 * @param {number} [spec.patrolFailures] - 巡检自身连续失败次数
 * @param {number} [spec.failureThreshold]
 * @returns {{findings:Array<object>, stalled_ms:number|null, state:string, note:string}}
 */
export function patrolFindings(spec = {}) {
  const task = spec.task !== null && typeof spec.task === 'object' ? spec.task : null
  const now = Number.isFinite(spec.now) ? spec.now : Date.now()
  const stallMs = Number.isFinite(spec.stallMs) && spec.stallMs > 0 ? spec.stallMs : DEFAULT_TASK_STALL_MS
  const findings = []
  if (task === null) return { findings, stalled_ms: null, state: '', note: '任务读不到 —— 本次不判（不猜）。' }

  const state = String(task.state ?? '')
  const terminal = Array.isArray(TERMINAL_STATES) ? TERMINAL_STATES.includes(state) : false
  const last = lastProgressAtMs(task)
  const stalled = last === null ? null : Math.max(0, now - last)
  const active = PATROL_ACTIVE_STATES.includes(state)

  if (active && !terminal && stalled !== null && stalled >= stallMs) {
    findings.push({
      /**
       * ★ **身份 = 内容派生的**：`<任务>|task-stall|<状态>|<最后一次进展时刻>`。
       *   同一段无进展跨多次巡检 ⇒ 同一个 id ⇒ 播报被幂等吃掉（A23）；
       *   进展恢复后再卡住 ⇒ 时刻变了 ⇒ **新的一条**（不永久哑掉）。
       */
      id: `${String(task.id ?? '')}|task-stall|${state}|${isoAt(last)}`,
      kind: 'task-stall',
      at: isoAt(now),
      stalled_ms: stalled,
      detail:
        `任务「${STATE_LABEL[state] ?? state}」已经 **${Math.round(stalled / 60000)} 分钟**没有任何进展` +
        `（最后一次进展 ${isoAt(last)}；口径 ${Math.round(stallMs / 60000)} 分钟）。` +
        `该动的角色：${(EXPECTED_ROLES_BY_STATE[state] ?? []).join('、') || '(无)'}`,
    })
  }

  for (const e of Array.isArray(spec.unconsumed) ? spec.unconsumed : []) {
    findings.push({
      id: `${String(task.id ?? '')}|unconsumed-delivery|${String(e.key ?? '')}`,
      kind: 'unconsumed-delivery',
      at: isoAt(now),
      key: String(e.key ?? ''),
      age_ms: Number.isFinite(e.age_ms) ? e.age_ms : null,
      detail:
        `一条投递**已送达但没人接管**：\`${String(e.key ?? '')}\`（投给 ${String(e.target ?? '(未知)')}，` +
        `${Number.isFinite(e.age_ms) ? `${Math.round(e.age_ms / 1000)} 秒` : '时长未知'}前）` +
        ' —— 送达不等于接管（A28）。',
    })
  }

  for (const e of Array.isArray(spec.unresolved) ? spec.unresolved : []) {
    findings.push({
      id: `${String(task.id ?? '')}|unresolved-wake|${String(e.at ?? '')}|${String(e.kind ?? '')}|${String(e.reason ?? '')}`,
      kind: 'unresolved-wake',
      at: isoAt(now),
      detail:
        `一条唤醒**没有投出去**（${String(e.reason ?? '')}，类别 ${String(e.kind ?? '')}，` +
        `${String(e.at ?? '')}）—— 这是"该叫没叫"，不是静默（A8）。`,
    })
  }

  const threshold = Number.isFinite(spec.failureThreshold) && spec.failureThreshold > 0
    ? spec.failureThreshold
    : DEFAULT_PATROL_FAILURE_THRESHOLD
  const failures = Number.isFinite(spec.patrolFailures) ? spec.patrolFailures : 0
  if (failures >= threshold) {
    findings.push({
      /**
       * ★ 停摆也是**一条事实**，有自己的身份：同一段停摆只播一次；
       *   恢复之后**再**停摆是 `stall_episodes` 的下一号 ⇒ **新的一条**（不会永久哑掉）。
       */
      id: `${String(spec.patrolOwner ?? 'patrol')}|patrol-stalled|${Number.isFinite(spec.stallEpisodes) ? spec.stallEpisodes : 1}`,
      kind: 'patrol-stalled',
      at: isoAt(now),
      detail: `巡检自身已连续失败 ${failures} 次（阈值 ${threshold}）—— **巡检已停摆**（A25：停摆本身必须可见）。`,
    })
  }

  return {
    findings,
    stalled_ms: stalled,
    state,
    note:
      `状态 ${state || '(未知)'}　最后进展 ${last === null ? '(读不到)' : isoAt(last)}　` +
      `无进展 ${stalled === null ? '(未知)' : `${Math.round(stalled / 1000)} 秒`}（口径 ${Math.round(stallMs / 1000)} 秒）　` +
      `待播报 ${findings.length} 条`,
  }
}

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
