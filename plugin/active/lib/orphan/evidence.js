/**
 * dsh-pipeline · 孤儿单自恢复 · 判据取证（判据视图 / 席位采样 / 证据时刻 / 零证据）
 * ============================================================================
 * 从 `lib/orphan.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/orphan.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/orphan/evidence
 */

import {
  SESSION_LOG_NAME,
  findSessionLog,
  msOf,
  sampleSessionLog,
  seatKey,
  sessionsRootCandidates,
} from '../liveness.js'
import { lastProgressAtMs } from '../patrol.js'
import { MECHANISM_BOOKKEEPING_ACTIONS } from './constants.js'

/**
 * ★ **判据视图**：剔掉机制自己的记账行之后的 `task`（**浅拷贝，不改入参**）。
 * @param {object|null} task
 * @returns {object|null}
 */
export function judgeView(task) {
  if (task === null || typeof task !== 'object') return task ?? null
  const history = Array.isArray(task.history) ? task.history : []
  const filtered = history.filter((h) => !MECHANISM_BOOKKEEPING_ACTIONS.includes(String(h?.action ?? '')))
  if (filtered.length === history.length) return task
  return { ...task, history: filtered }
}

/**
 * ★ **采样一个任务的席位侧活动**（只读；判据是纯的，采样在运行期）。
 *
 * 与 `store.sampleSessionActivity` **同一套候选根与同一套只读原语**
 * （`sessionsRootCandidates / findSessionLog / sampleSessionLog`）——
 * 唯一多出来的一件事是**按席位记下"日志在不在"**：
 * 「找不到」本身是孤儿判据里最硬的一条（`present:false`），而 store 那份返回的是
 * "整体采样到了几条"，回答不了"这个席位的日志在不在"。
 *
 * @param {object|null} task
 * @param {number} atMs
 * @param {{roots?:string[], activityOpts?:object}} [opts]
 * @returns {{seats:object, roots:string[], found:number, looked:number, note:string}}
 */
export function sampleSeatActivity(task, atMs, opts = {}) {
  const roots = Array.isArray(opts.roots) && opts.roots.length > 0 ? opts.roots : sessionsRootCandidates()
  const seats = {}
  let found = 0
  let looked = 0
  for (const raw of Array.isArray(task?.dispatched) ? task.dispatched : []) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const key = seatKey(role, seat)
    const sid =
      typeof raw?.session_id === 'string' && raw.session_id.length > 0
        ? raw.session_id
        : typeof raw?.agent_id === 'string' && raw.agent_id.length > 0
          ? raw.agent_id
          : null
    if (sid === null) {
      seats[key] = { key, role, seat, session_id: null, present: false, sample: null, log_path: null, reason: '派活台账里没有会话 id（session_id / agent_id 都是空的）' }
      continue
    }
    looked += 1
    const logPath = findSessionLog(roots, sid)
    const sample = sampleSessionLog(logPath, atMs)
    if (sample !== null) found += 1
    seats[key] = {
      key,
      role,
      seat,
      session_id: sid,
      present: logPath !== null && sample !== null,
      sample,
      log_path: logPath,
      reason: logPath === null ? `会话 ${sid} 的 ${SESSION_LOG_NAME} 在候选会话根下找不到` : '',
    }
  }
  return {
    seats,
    roots,
    found,
    looked,
    note:
      roots.length === 0
        ? '一个候选会话根都取不到（DSH_SESSIONS_DIR / DSH_HOME / DSH_PROFILE_DIR / ~/.dsh 全都没有）—— 本次拿不到"日志在不在"的证据，判据会退回台账面（**不猜**）。'
        : `候选根 ${roots.length} 个；有会话 id 的席位 ${looked} 个，命中日志 ${found} 个。`,
  }
}

/**
 * ★ **这个席位最后一次由它自己产出的东西是什么**（"你上次停在哪"那句话的原料）。
 *
 * 顺序与 `evidenceOfLife` 同源（交接物 > 席位提交 > 水位 > 流水），取**最新**的一条。
 *
 * @returns {string} 人话；查不到时如实说查不到（**不编**）。
 */
export function lastSeatOutput(task, role, seat = null) {
  const r = String(role ?? '')
  if (r.length === 0) return '（角色未知）'
  let best = null
  const take = (at, text) => {
    const t = msOf(at)
    if (t === null) return
    if (best === null || t > best.t) best = { t, text }
  }
  for (const h of Array.isArray(task?.handoffs) ? task.handoffs : []) {
    if (String(h?.from_role ?? '') !== r) continue
    take(h?.created_at, `交接物 ${String(h?.kind_zh ?? h?.kind ?? '?')}（${String(h?.created_at ?? '')}）`)
  }
  if (typeof seat === 'string' && seat.length > 0) {
    const mine = task?.writer_submissions?.[seat]
    if (mine !== null && mine !== undefined) take(mine.at, `席位提交（${String(mine.at ?? '')}）`)
  }
  for (const x of Array.isArray(task?.context_reports) ? task.context_reports : []) {
    if (String(x?.role ?? '') !== r) continue
    take(x?.at, `水位自报（${String(x?.at ?? '')}）`)
  }
  for (const h of Array.isArray(task?.history) ? task.history : []) {
    if (String(h?.actor ?? '') !== r) continue
    take(h?.at, `流水 ${String(h?.action ?? '')}（${String(h?.at ?? '')}）`)
  }
  return best === null ? '机制查不到你产出过任何东西（无交接物 / 无席位提交 / 无水位自报 / 无流水）' : best.text
}

/**
 * ★ "最后一次进展"的**带兜底**口径（与巡检同源，只多一条链尾）。
 *
 * `patrol.lastProgressAtMs` 拿不到任何时间戳时返回 `null` 并且**不猜**（那是巡检的纪律：
 * 拿不到就不判）。孤儿判据不能这么早退出 —— 4a2dc7 那种"只有 3 行流水"的单，
 * 链尾的 `updated_at` / `created_at` 就是唯一可用的起点，而**没有起点就永远判不出"没人管"**。
 * 所以这里显式往下退，并把**用了哪一个来源**一起返回（可审计，不假装是"最后一次进展"）。
 *
 * @returns {{atMs:number|null, source:string}}
 */
export function lastEvidenceAtMs(task) {
  const p = lastProgressAtMs(task)
  if (p !== null) return { atMs: p, source: 'last-progress' }
  const u = msOf(task?.updated_at)
  if (u !== null) return { atMs: u, source: 'updated_at（台账里没有任何进展类时间戳）' }
  const c = msOf(task?.created_at)
  if (c !== null) return { atMs: c, source: 'created_at（台账里没有任何进展类时间戳）' }
  return { atMs: null, source: '读不到' }
}

/** 整单层面"零证据"吗（交付物 / 制品 / 记录 / 水位 / 席位提交全空 + 流水里没有非 main 的执行者）。 */
export function zeroEvidenceOf(task) {
  const empty = (v) => !Array.isArray(v) || v.length === 0
  const subs = task?.writer_submissions
  const noSubs = subs === null || subs === undefined || (typeof subs === 'object' && Object.keys(subs).length === 0)
  const handoffsEmpty = empty(task?.handoffs)
  const artifactsEmpty = empty(task?.artifacts)
  const recordsEmpty = empty(task?.records)
  const ctxEmpty = empty(task?.context_reports)
  const history = Array.isArray(task?.history) ? task.history : []
  const actors = new Set(history.map((h) => String(h?.actor ?? '')))
  const onlyMain = [...actors].every((a) => a === '' || a === 'main')
  return {
    zero: handoffsEmpty && artifactsEmpty && recordsEmpty && ctxEmpty && noSubs && onlyMain,
    handoffs: Array.isArray(task?.handoffs) ? task.handoffs.length : 0,
    artifacts: Array.isArray(task?.artifacts) ? task.artifacts.length : 0,
    records: Array.isArray(task?.records) ? task.records.length : 0,
    context_reports: Array.isArray(task?.context_reports) ? task.context_reports.length : 0,
    writer_submissions: noSubs ? 0 : Object.keys(subs).length,
    actors: [...actors].filter((a) => a.length > 0),
  }
}
