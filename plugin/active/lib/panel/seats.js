// 面板席位域：把 `roster` 的声明席位与 `task.dispatched[]` 的派活台账合成面板上的席位行。
/**
 * dsh-pipeline · 自建流水线面板 · **席位域**
 * ============================================================================
 * 一个任务在面板上显示几行席位、每行的状态/通道/会话 id 从哪来，全在这里定。
 *
 * ---- 席位怎么合出来的（三层，顺序 = 面板显示顺序）--------------------------
 *   `main`       恒一条 `status:"current"`；`kind:"session"`（用户正在对话的那条就是它），
 *                `session_id` 记 `null` —— 快照是纯读的，**不猜**当前会话 id。
 *   `declared`   `roster.execution_roles` 的执行角色；`writer` 按
 *                `roster.writers.partitions[]`（`seat` / `role_id` / `layer`）一个分区一位。
 *   `dispatched` `task.dispatched[]` 里真派出去过的：同 (role, seat) **升级**成 `dispatched`
 *                并填 `session_id` / `member_name` / `kind`；名单没声明的（需求位 / 计划位）
 *                追加在后面 —— 它们是真会话，漏掉就等于面板上凭空少几行。
 *
 * ---- `task.dispatched[]` 的形状（盘上逐字段核对过，**别靠想象写**）------------
 *   `{ key, role, seat, agent_id, session_id, token, at, at_ms, via }`
 *   （`lib/liveness/seats.js` 的 `upsertDispatch`）。**没有** `memberName` 这一格 ⇒ 读
 *   `memberName ?? member_name`，取不到就是 `null`（不拿 `agent_id` 冒充名字）；通道字段是
 *   `via`（`team` / `subagent` / `manual`），`manual` 没建会话 ⇒ `kind:"unknown"`。
 *   ★ 真实台账里 `session_id` 常是 `null`、只有 `agent_id = "session-<uuid>"` ⇒ 显式
 *   `session_id` 优先，取不到才用 {@link sessionIdOfAgentId} 剥前缀兜底（面板要靠它开会话）。
 *
 * ★ 循环依赖约束：本文件**不 import `snapshot.js`**（`snapshot.js` 反过来 import 这里）。
 *   共用的标量工具（`textOf` / `nullableText` / `nonEmptyText`）从 `./task-fields.js` 取 ——
 *   那是它们的唯一出处，三块各抄一份就是三处会漂移的判据。
 *
 * @module dsh-pipeline/lib/panel/seats
 */

import { ROLE, roleLabel } from '../roles.js'
import { nullableText, textOf } from './task-fields.js'

/** 席位状态：当前会话 / 已派出 / 仅声明。 */
export const SEAT_STATUS = Object.freeze({ CURRENT: 'current', DISPATCHED: 'dispatched', DECLARED: 'declared' })
/** 席位挂在哪个通道上。 */
export const SEAT_KIND = Object.freeze({ SESSION: 'session', TEAM: 'team', UNKNOWN: 'unknown' })

/** 派活台账里"真的建了会话"的 agent id 前缀。 */
const SESSION_AGENT_PREFIX = 'session-'

/** 席位表：`main` + 声明位（按名单顺序，writer 按分区展开）+ 派出去过但没声明的位。 */
export function seatsOf(task) {
  const rows = [mainSeat()]
  const byKey = new Map()
  for (const decl of declaredSeatsOf(task?.roster)) {
    // `main` 恒为"当前会话"那一条，声明表里就算写了也不算第二行。
    if (decl.role === ROLE.MAIN) continue
    const key = seatKeyOf(decl.role, decl.seat)
    if (byKey.has(key)) continue
    const row = {
      role: decl.role, role_label: roleLabelOf(decl.role), seat: decl.seat, status: SEAT_STATUS.DECLARED,
      kind: SEAT_KIND.UNKNOWN, session_id: null, parent_session_id: null, member_name: null, layer: decl.layer,
    }
    rows.push(row)
    byKey.set(key, row)
  }
  for (const rec of dispatchedRecordsOf(task)) {
    const role = textOf(rec?.role)
    if (role.length === 0 || role === ROLE.MAIN) continue
    const seat = nullableText(rec?.seat)
    const key = seatKeyOf(role, seat)
    const patch = {
      status: SEAT_STATUS.DISPATCHED,
      kind: kindOfChannel(rec),
      // ★ 真实台账里 `session_id` 常是 `null`，只有 `agent_id = "session-<uuid>"`：
      //   显式 `session_id` 永远优先，取不到才从 `agent_id` 剥前缀兜底（见 {@link sessionIdOfAgentId}）。
      session_id: nullableText(rec?.session_id) ?? sessionIdOfAgentId(rec?.agent_id),
      parent_session_id: nullableText(rec?.parent_session_id ?? rec?.parentSessionId),
      member_name: nullableText(rec?.memberName ?? rec?.member_name),
    }
    const hit = byKey.get(key)
    if (hit !== undefined) {
      // 声明过 + 真派出去过 ⇒ **事实优先**（状态、通道、会话 id 全按台账）。
      Object.assign(hit, patch)
      continue
    }
    const row = { role, role_label: roleLabelOf(role), seat, ...patch, layer: null }
    rows.push(row)
    byKey.set(key, row)
  }
  return rows
}

/** `main` 那一条：用户正在对话的会话，`kind` 记 `session`，id 一律不猜。 */
function mainSeat() {
  return {
    role: ROLE.MAIN, role_label: roleLabelOf(ROLE.MAIN), seat: null, status: SEAT_STATUS.CURRENT,
    kind: SEAT_KIND.SESSION, session_id: null, parent_session_id: null, member_name: null, layer: null,
  }
}

/**
 * 名单里的席位声明（**只看结构，不看谁在不在线**）。
 *
 * 顺序 = `execution_roles` 的顺序：遇到 `writer` 就把它的分区逐个展开（席位号 / 层从分区取），
 * 其余角色一位；分区里出现、而名单没提的角色补在后面（名单缺一条不该让人消失）。
 *
 * @returns {Array<{role:string, seat:string|null, layer:string|null}>}
 */
export function declaredSeatsOf(roster) {
  const out = []
  const seen = new Set()
  const push = (role, seat, layer) => {
    const key = seatKeyOf(role, seat)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ role, seat, layer })
  }
  const roles = Array.isArray(roster?.execution_roles) ? roster.execution_roles : []
  const byRole = new Map()
  for (const part of Array.isArray(roster?.writers?.partitions) ? roster.writers.partitions : []) {
    if (part === null || typeof part !== 'object') continue
    const role = nullableText(part.role_id) ?? ROLE.WRITER
    const row = { seat: nullableText(part.seat), layer: nullableText(part.layer) }
    const list = byRole.get(role)
    if (list === undefined) byRole.set(role, [row])
    else list.push(row)
  }
  for (const rawRole of roles) {
    const role = textOf(rawRole)
    if (role.length === 0) continue
    const parts = byRole.get(role)
    if (parts === undefined) {
      push(role, null, null)
      continue
    }
    byRole.delete(role)
    for (const part of parts) push(role, part.seat, part.layer)
  }
  // 分区里出现、而名单没提的角色：按分区顺序补在后面。
  for (const [role, parts] of byRole) for (const part of parts) push(role, part.seat, part.layer)
  return out
}

/** 派活台账；不是数组就当没有（**不抛**）。 */
function dispatchedRecordsOf(task) {
  const list = task?.dispatched
  return Array.isArray(list) ? list.filter((x) => x !== null && typeof x === 'object') : []
}

/**
 * `kind`：通道字段是 `via`（`lib/transport/*` 自报）。
 * `team` ⇒ team；`manual` ⇒ unknown（**没建会话**，只有可粘贴派活单，记成 session 是假话）；
 * 其余非空 ⇒ session；缺/空 ⇒ unknown。
 */
export function kindOfChannel(record) {
  const raw = textOf(record?.via ?? record?.channel ?? record?.transport)
  if (raw.length === 0) return SEAT_KIND.UNKNOWN
  const v = raw.toLowerCase()
  if (v === 'team') return SEAT_KIND.TEAM
  if (v === 'manual') return SEAT_KIND.UNKNOWN
  return SEAT_KIND.SESSION
}

/**
 * 从派活台账的 `agent_id` 兜底出**会话 id**（`session_id` 为 `null` 时用）。
 *
 * ★ 为什么需要它：真实 `task.dispatched[]` 里 `session_id` 是 `null`，只有
 *   `agent_id = "session-<uuid>"`；而面板要拿 `session_id` 去拉会话预览 / 打开会话。
 *   不兜这一下，真实派出去的席位在面板上就是"没有会话"。
 * ★ 只认 `session-` 前缀且后面**非空**（`abc-123`）；其余（`member-2` / 普通 agent id /
 *   非字符串 / 空白）一律 `null`，**不抛** —— 猜错 id 比留空更糟。
 *
 * @param {unknown} agentId
 * @returns {string|null}
 */
export function sessionIdOfAgentId(agentId) {
  const raw = nullableText(agentId)
  if (raw === null || !raw.startsWith(SESSION_AGENT_PREFIX)) return null
  const id = raw.slice(SESSION_AGENT_PREFIX.length).trim()
  return id.length === 0 ? null : id
}

/** 角色中文名；认不出原样返回 id（与 `lib/roles.js` 的 `roleLabel` 同一份判据）。 */
function roleLabelOf(role) {
  const id = textOf(role)
  return id.length === 0 ? '' : roleLabel(id)
}

/** 席位键：`role` 或 `role@seat`（与 `lib/tiers.js` 的 `slotKeyOf` 同一个形状）。 */
export function seatKeyOf(role, seat) {
  const s = nullableText(seat)
  return s === null ? textOf(role) : `${textOf(role)}@${s}`
}
