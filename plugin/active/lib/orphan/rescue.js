/**
 * dsh-pipeline · 孤儿单自恢复 · 运行期（扫描器 / 只追加审计）
 * ============================================================================
 * 从 `lib/orphan.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/orphan.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/orphan/rescue
 */

import { appendFileSync } from 'node:fs'

import {
  DEFAULT_ACTIVITY_FRESH_MS,
  DEFAULT_ACTIVITY_MAX_MS,
  DEFAULT_ACTIVITY_MIN_BYTES,
  formatDuration,
  msOf,
} from '../liveness.js'
import { roleLabel } from '../roles.js'
import {
  DEFAULT_MAX_REDELIVER_ATTEMPTS,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_ORPHAN_SWEEP_MS,
  DEFAULT_REDELIVER_BACKOFF_MS,
} from './constants.js'
import { sampleSeatActivity } from './evidence.js'
import {
  isoAt,
  orphanCandidate,
  orphanRedeliverMessage,
  orphanVerdict,
} from './verdict.js'

/**
 * ★★ 造一个**孤儿自恢复扫描器**（运行期；判据全在上面的纯函数里）。
 *
 * 它每个周期做四件事（**只做这四件**）：
 *   ① 读任务 + 采样席位会话活动（只读）；
 *   ② 判（纯函数）—— 候选再取证（`detectRunFailure`），然后 `orphanVerdict`；
 *   ③ 对**孤儿**发一条**带上下文**的续做消息（走 `notify_only` 的同一份实现）；
 *   ④ 留痕：审计行（`.pipeline/<任务>/audit.jsonl`）+ 幂等账本（`wake-ledger.jsonl`）
 *      + 一条播报（成功 / 放弃；失败则落 `unresolved` 由**既有巡检**播报）。
 *
 * ★ `deps` 里**没有**"建会话"的任何接口 —— 结构上不可能靠"再派一席"冒充自愈。
 *
 * @param {object} deps
 * @param {object} deps.store - `createTaskStore()` 的实例
 * @param {(spec:{task:object, role:string, seat:string|null, text:string}) => Promise<{ok:boolean, sessionId?:string|null, note?:string}>} deps.notify
 *   **必填**：`createSeatNotifier(deps).notifyOnly` 的包装（不建会话 / 不改状态 / 失败返回 ok:false）
 * @param {object} [deps.ledger] - `createWakeLedger()` 的实例（幂等与失败留痕）
 * @param {(spec:object) => Promise<object>} [deps.wake] - 播报（`wakeup.wake`）
 * @param {(taskId:string, action:string, detail:object) => Promise<void>} [deps.audit] - 只追加审计
 * @param {(task:object, seats:Array<object>) => Promise<object>} [deps.detectRunFailure]
 * @param {() => Promise<Array<{id:string}>>} [deps.listTasks]
 * @param {(task:object, atMs:number) => object} [deps.sampleActivity]
 * @param {number} [deps.intervalMs] @param {number} [deps.graceMs]
 * @param {number} [deps.backoffMs] @param {number} [deps.maxAttempts]
 * @param {(m:string)=>void} [deps.warn]
 */
export function createOrphanRescue(deps = {}) {
  const store = deps.store ?? null
  const ledger = deps.ledger ?? null
  const notify = typeof deps.notify === 'function' ? deps.notify : null
  const wake = typeof deps.wake === 'function' ? deps.wake : null
  const audit = typeof deps.audit === 'function' ? deps.audit : null
  const detectRunFailure = typeof deps.detectRunFailure === 'function' ? deps.detectRunFailure : null
  const sampleActivity = typeof deps.sampleActivity === 'function' ? deps.sampleActivity : (task, atMs) => sampleSeatActivity(task, atMs)
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0 ? deps.intervalMs : DEFAULT_ORPHAN_SWEEP_MS
  const graceMs = Number.isFinite(deps.graceMs) && deps.graceMs >= 0 ? deps.graceMs : DEFAULT_ORPHAN_GRACE_MS
  const backoffMs = Number.isFinite(deps.backoffMs) && deps.backoffMs >= 0 ? deps.backoffMs : DEFAULT_REDELIVER_BACKOFF_MS
  const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : DEFAULT_MAX_REDELIVER_ATTEMPTS
  const activityOpts = {
    minBytes: Number.isInteger(deps.activityMinBytes) ? deps.activityMinBytes : DEFAULT_ACTIVITY_MIN_BYTES,
    maxMs: Number.isInteger(deps.activityMaxMs) ? deps.activityMaxMs : DEFAULT_ACTIVITY_MAX_MS,
    freshMs: Number.isInteger(deps.activityFreshMs) ? deps.activityFreshMs : DEFAULT_ACTIVITY_FRESH_MS,
  }

  let timer = null
  let inFlight = false
  /** 最近一次扫描的结论（只读导出 / 排障用；有界）。 */
  let lastReport = { at: null, scanned: 0, candidates: 0, orphans: 0, new_orphans: 0, skipped: [], actions: [], note: '尚未扫描' }
  const stats = {
    sweeps: 0,
    scanned: 0,
    candidates: 0,
    /** 本轮识别到的孤儿条数（**含"已处理过、这次不动手"的那些** —— 识别与动作是两件事）。 */
    orphans: 0,
    /** 本轮**真的发起了动作**（重投 / 报失败 / 放弃）的条数。 */
    new_orphans: 0,
    aborted: 0,
    redelivered: 0,
    redeliver_failed: 0,
    abandoned: 0,
    skipped: 0,
    not_judged: 0,
    last_sweep_at: null,
    last_error: null,
    grace_ms: graceMs,
    backoff_ms: backoffMs,
    max_attempts: maxAttempts,
    interval_ms: intervalMs,
  }

  /** 只追加审计（**不碰 task.json** —— 那会被算成"有新进展"，自己把自己的计时清零）。 */
  async function noteAudit(taskId, action, detail) {
    if (audit === null) return
    try {
      await audit(String(taskId), action, detail)
    } catch (err) {
      warn(`[pipeline] 孤儿自恢复留痕失败（不影响本次判定与投递）：${String(err?.message ?? err)}`)
    }
  }

  /** 播报（**绝不抛**；播不出去也只是少一条可见面，机制照旧）。 */
  async function broadcast(task, finding, kind, what, note) {
    if (wake === null) return
    try {
      await wake({
        taskId: String(task?.id ?? ''),
        actorRole: 'mechanism',
        actorSeat: null,
        kind,
        what,
        disc: String(finding?.id ?? ''),
        identitySource: 'orphan-rescue',
        task,
        note,
        via: 'orphan-rescue',
      })
    } catch (err) {
      warn(`[pipeline] 孤儿自恢复播报失败（下一轮照旧）：${String(err?.message ?? err)}`)
    }
  }

  /** 该身份已经失败过几次（**从账本里数** —— 跨进程有效，不新开计数器）。 */
  function attemptsOf(taskId, id) {
    if (ledger === null || typeof ledger.unresolvedEntries !== 'function') return { attempts: 0, lastAtMs: null }
    let attempts = 0
    let lastAtMs = null
    for (const e of ledger.unresolvedEntries({ taskId, limit: 200 })) {
      if (String(e?.detail?.id ?? '') !== id) continue
      attempts += 1
      const t = msOf(e?.at)
      if (t !== null && (lastAtMs === null || t > lastAtMs)) lastAtMs = t
    }
    return { attempts, lastAtMs }
  }

  /** 这个身份还该动手吗（三道闸：已成功 / 已放弃 / 退避未到）。 */
  function gateFor(taskId, finding, nowMs) {
    if (ledger === null) return { action: 'go', attempts: 0, why: '没有账本（自测/排障形态）—— 本次直接投，不做跨进程去重。' }
    if (typeof ledger.hasDelivered === 'function' && ledger.hasDelivered(finding.id) === true) {
      return { action: 'skip', attempts: 0, why: '这一条孤儿身份**已经成功重投过**（账本里有键）—— 同一条不重投。' }
    }
    if (typeof ledger.escalatedEntry === 'function' && ledger.escalatedEntry(finding.id) !== null) {
      return { action: 'skip', attempts: 0, why: '这一条孤儿身份**已经放弃**（连续投不出去到上限）—— 不再骚扰。' }
    }
    const { attempts, lastAtMs } = attemptsOf(taskId, finding.id)
    if (attempts >= maxAttempts) return { action: 'abandon', attempts, why: `已经投失败 ${attempts} 次（上限 ${maxAttempts}）` }
    if (attempts > 0 && lastAtMs !== null && nowMs - lastAtMs < backoffMs) {
      return { action: 'wait', attempts, why: `上一次投失败在 ${formatDuration(nowMs - lastAtMs)} 前（退避 ${formatDuration(backoffMs)}）—— 本轮不重试` }
    }
    return { action: 'go', attempts, why: '' }
  }

  async function rescueOne(task, finding, nowMs) {
    const taskId = String(task?.id ?? '')
    const seat = finding.seat ?? null
    const gate = gateFor(taskId, finding, nowMs)
    if (gate.action === 'skip' || gate.action === 'wait') {
      stats.skipped += 1
      return { id: finding.id, action: gate.action, note: gate.why }
    }
    if (gate.action === 'abandon') {
      stats.abandoned += 1
      await noteAudit(taskId, 'orphan:redeliver-abandoned', { orphan_id: finding.id, kind: finding.kind, attempts: gate.attempts, reason: gate.why })
      if (ledger !== null && typeof ledger.markEscalated === 'function') {
        ledger.markEscalated({ key: finding.id, escalationKey: `${finding.id}|abandoned|${gate.attempts}`, reason: gate.why, at: isoAt(nowMs) })
      }
      await broadcast(task, finding, 'orphan-abandoned', '**孤儿单自恢复：投不出去（已放弃）**',
        `任务 ${taskId} 的孤儿身份 \`${finding.id}\` 连续 ${gate.attempts} 次都没投出去（上限 ${maxAttempts}）—— **再投也不会成功**，停手并在此留痕。\n` +
        `★ 这是**看得见的失败**（不是静默）：席位侧会话可能已经不在了；这条只能由人在 GUI 里处置（重派同一席位 / 取消该单）。`)
      return { id: finding.id, action: 'abandon', note: gate.why }
    }

    await noteAudit(taskId, 'orphan:detected', {
      orphan_id: finding.id,
      kind: finding.kind,
      state: finding.state,
      stalled_ms: finding.stalled_ms ?? null,
      seat: seat?.key ?? null,
      session_id: seat?.session_id ?? null,
      session_present: seat?.session_present ?? null,
      evidence: finding.evidence ?? null,
      gate_before: gate.why,
    })
    const text = orphanRedeliverMessage({ task, finding })
    /**
     * ★ **连收件人都判不出来**（状态没有唯一责任人 / 阻塞记录里没有席位名单）⇒
     *   这是一条"投不出去"，**如实报**，而不是拿 `role: ''` 去调投递（那会得到一句
     *   含糊的失败，事后没人知道是"不知道投给谁"还是"通道坏了"）。
     */
    if (seat === null || String(seat.role ?? '').length === 0) {
      const reason = '判不出该投给谁：该状态下没有唯一责任人（也没有可用的失联处置记录）—— **没有投递**。'
      stats.redeliver_failed += 1
      await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, kind: finding.kind, reason, message: text })
      if (ledger !== null && typeof ledger.noteUnresolved === 'function') {
        ledger.noteUnresolved({
          at: isoAt(nowMs),
          task_id: taskId,
          kind: 'orphan-rescue',
          actor: 'mechanism',
          reason,
          detail: { id: finding.id, role: null, seat: null, session_id: null, attempt: gate.attempts + 1, max_attempts: maxAttempts },
        })
      }
      return { id: finding.id, action: 'failed', note: reason }
    }
    if (notify === null) {
      stats.redeliver_failed += 1
      await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, reason: '本进程没有装配投递通道（notify 未注入）—— 没有投递。' })
      return { id: finding.id, action: 'failed', note: 'notify 未装配' }
    }
    let r = null
    try {
      r = await notify({ task, role: String(seat?.role ?? ''), seat: seat?.seat ?? null, text })
    } catch (err) {
      r = { ok: false, sessionId: null, note: `投递异常：${String(err?.message ?? err)}` }
    }
    if (r !== null && r.ok === true) {
      stats.redelivered += 1
      if (ledger !== null && typeof ledger.record === 'function') {
        ledger.record({
          key: finding.id,
          task_id: taskId,
          kind: finding.kind,
          actor: 'mechanism',
          at: isoAt(nowMs),
          target: String(r.sessionId ?? ''),
          identity_source: 'orphan-rescue',
          event_at: isoAt(finding.stalled_ms === null ? nowMs : nowMs - finding.stalled_ms),
        })
      }
      await noteAudit(taskId, 'orphan:redelivered', { orphan_id: finding.id, kind: finding.kind, seat: seat?.key ?? null, target_session: String(r.sessionId ?? ''), note: String(r.note ?? ''), message: text })
      await broadcast(task, finding, 'orphan-redelivered', '**孤儿单自恢复：已重新投递**',
        `识别到孤儿单 \`${taskId}\`（${finding.reason}），已**自己重新投递**给「${roleLabel(String(seat?.role ?? ''))}${seat?.seat === null || seat?.seat === undefined || String(seat?.seat).length === 0 ? '' : `（${seat.seat}）`}」的会话 ${String(r.sessionId ?? '')}。\n` +
        `判据：${String(finding.detail ?? '')}\n★ 未新建任何席位（结构上就没有那条通道）；同一条孤儿身份不会再投第二次。`)
      return { id: finding.id, action: 'redelivered', note: String(r.note ?? '') }
    }
    const reason = String(r?.note ?? '投递返回了 ok:false 且没给原因')
    stats.redeliver_failed += 1
    await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, kind: finding.kind, seat: seat?.key ?? null, session_id: seat?.session_id ?? null, reason })
    /**
     * ★ **投不出去 = 看得见的失败**：落进账本的 `unresolved` ⇒ **既有巡检**那条
     *   `unresolved-wake` 会把它播报出去（不新开播报面，也不静默）。
     */
    if (ledger !== null && typeof ledger.noteUnresolved === 'function') {
      ledger.noteUnresolved({
        at: isoAt(nowMs),
        task_id: taskId,
        kind: 'orphan-rescue',
        actor: 'mechanism',
        reason,
        detail: { id: finding.id, role: seat?.role ?? null, seat: seat?.seat ?? null, session_id: seat?.session_id ?? null, attempt: gate.attempts + 1, max_attempts: maxAttempts },
      })
    }
    return { id: finding.id, action: 'failed', note: reason }
  }

  async function runOnce() {
    if (inFlight) return { ok: true, skipped: true, note: '上一次扫描还在跑 —— 跳过这一次。' }
    inFlight = true
    stats.sweeps += 1
    const at = isoAt(Date.now())
    const actions = []
    const skipped = []
    try {
      const list = typeof deps.listTasks === 'function'
        ? await deps.listTasks()
        : store !== null && typeof store.list === 'function' ? await store.list() : []
      let scanned = 0
      let candidates = 0
      let orphans = 0
      let newOrphans = 0
      for (const entry of Array.isArray(list) ? list : []) {
        const id = String(entry?.id ?? '')
        if (id.length === 0) continue
        const task = store !== null && typeof store.get === 'function' ? await store.get(id) : null
        if (task === null) continue
        scanned += 1
        const nowMs = Date.now()
        let activity = null
        try {
          activity = sampleActivity(task, nowMs)
        } catch (err) {
          activity = null
          warn(`[pipeline] 孤儿自恢复：席位活动采样失败（本次按"拿不到活动证据"处理，**不猜**）：${String(err?.message ?? err)}`)
        }
        const deliveries = ledger !== null && typeof ledger.pendingSeatDeliveries === 'function'
          ? ledger.pendingSeatDeliveries({ taskId: id, limit: 20 })
          : []
        const lastDeliveryAtMs = deliveries.reduce((acc, e) => {
          const t = msOf(e?.at)
          return t !== null && (acc === null || t > acc) ? t : acc
        }, null)
        const spec = {
          task,
          now: nowMs,
          graceMs,
          activity: activity === null ? null : activity.seats ?? null,
          prevSamples: task?.liveness?.samples ?? null,
          lastDeliveryAtMs,
          activityOpts,
        }
        const cand = orphanCandidate(spec)
        if (!cand.candidate) {
          stats.not_judged += 1
          if (skipped.length < 12 && cand.skip !== null) skipped.push({ task_id: id, reason: cand.skip.reason, detail: cand.skip.detail })
          continue
        }
        candidates += 1
        let runFailure = null
        if (detectRunFailure !== null) {
          try {
            runFailure = await detectRunFailure(task, cand.seats.filter((s) => s.alive !== true))
          } catch (err) {
            warn(`[pipeline] 孤儿自恢复：运行失败取证异常（按"没有失败证据"处理，退回孤儿判据）：${String(err?.message ?? err)}`)
            runFailure = null
          }
        }
        const res = orphanVerdict({ ...spec, runFailure })
        if (res.findings.length === 0) {
          stats.not_judged += 1
          if (skipped.length < 12 && res.skip !== null) skipped.push({ task_id: id, reason: res.skip.reason, detail: res.skip.detail })
          continue
        }
        for (const f of res.findings) {
          if (f.kind === 'seat-turn-aborted') {
            stats.aborted += 1
            await noteAudit(id, 'orphan:turn-aborted', { orphan_id: f.id, seat: f.seat?.key ?? null, run_failure: f.evidence?.run_failure ?? null })
            actions.push({ task_id: id, kind: f.kind, action: 'not-orphan', note: '运行失败中止（A9/A11 有自己的播报面）—— 本机制**不判孤儿、不重投**。' })
            continue
          }
          orphans += 1
          const outcome = await rescueOne(task, f, nowMs)
          if (['redelivered', 'failed', 'abandon'].includes(String(outcome.action))) newOrphans += 1
          actions.push({ task_id: id, kind: f.kind, ...outcome })
        }
      }
      stats.scanned += scanned
      stats.candidates += candidates
      stats.orphans += orphans
      stats.new_orphans += newOrphans
      stats.last_sweep_at = at
      stats.last_error = null
      lastReport = {
        at,
        scanned,
        candidates,
        orphans,
        new_orphans: newOrphans,
        skipped,
        actions,
        note: `扫描 ${scanned} 张单；候选 ${candidates}；识别孤儿 ${orphans}（其中本轮发起动作 ${newOrphans}）；动作 ${actions.length} 条。`,
      }
      return { ok: true, ...lastReport }
    } catch (err) {
      stats.last_error = String(err?.message ?? err)
      warn(`[pipeline] 孤儿自恢复本轮抛错（不会停摆，下一轮继续）：${stats.last_error}`)
      lastReport = { at, scanned: 0, candidates: 0, orphans: 0, new_orphans: 0, skipped, actions, note: `本轮抛错：${stats.last_error}` }
      return { ok: false, ...lastReport }
    } finally {
      inFlight = false
    }
  }

  return {
    intervalMs,
    stats,
    runOnce,
    running: () => timer !== null,
    lastReport: () => lastReport,
    status() {
      return {
        ok: stats.last_error === null,
        interval_ms: intervalMs,
        grace_ms: graceMs,
        backoff_ms: backoffMs,
        max_attempts: maxAttempts,
        stats: { ...stats },
        last_report: lastReport,
        disabled_reason: notify === null ? '本进程没有装配投递通道（notify 未注入）—— 只会识别、不会投递' : '',
      }
    },
    start() {
      if (timer !== null) return false
      timer = setInterval(() => {
        void runOnce()
      }, intervalMs)
      // ★ 不许因为本机制把进程钉住（DSH 退出时定时器不该拦着）。
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

/**
 * ★ 只追加审计的**默认出口**（与 `lib/liveness.js → createChannelAudit` 同一落点与行格式：
 *   `.pipeline/<任务>/audit.jsonl`，一行一个 JSON 对象）。
 *
 * 为什么不走 `store.recordAudit`：那个会**改 `task.json`**（push `history` + 落盘），
 * 于是"没有进展"的最后进展时刻会被自己刷新 ⇒ 自恢复机制自己把自己的判据喂饱
 * （巡检当初也是靠"不产生进展"避开这个坑的）。
 *
 * @param {(taskId:string)=>string} auditFileOf - 通常就是 `store.auditFile`
 * @param {(m:string)=>void} [log]
 * @returns {(taskId:string, action:string, detail:object)=>Promise<void>}
 */
export function createOrphanAudit(auditFileOf, log = null) {
  return async function record(taskId, action, detail = {}) {
    const id = String(taskId ?? '')
    if (id.length === 0 || typeof auditFileOf !== 'function') return
    const line = { at: new Date().toISOString(), task_id: id, actor: 'mechanism', action: String(action), ...detail }
    try {
      appendFileSync(auditFileOf(id), `${JSON.stringify(line)}\n`, 'utf8')
    } catch (err) {
      // 审计写失败不该让判决本身失败；说出来，不静默。
      if (typeof log === 'function') log(`孤儿自恢复审计写盘失败（判决与投递不受影响）：${String(err?.message ?? err)}`)
    }
  }
}
