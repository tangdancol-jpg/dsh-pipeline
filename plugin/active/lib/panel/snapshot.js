// 自建面板数据面 · 只读快照：把 `.pipeline/*/task.json` 压成「任务 / 席位 / 待办数」三件事。
/**
 * dsh-pipeline · 自建流水线面板 · **数据面**（宿主侧只读快照）
 * ============================================================================
 * 一次给齐客户端要显示的四样东西：任务列表（状态中文名 + 需求摘要）、每个任务的席位
 * （角色中文名 + 席位号 + 是否已派出 + 当前会话身份）、人工待办数。
 *
 * ---- 硬边界 ----------------------------------------------------------------
 *   · **只读**：只 `readdirSync` / `readFileSync` / `statSync`，一个字节都不写任务数据；
 *   · **不读正文**：只碰 `task.json` 与 `team-board.json` 的**结构化字段**，绝不打开
 *     `handoffs/` · `artifacts/` · `records/` · `reports/`（面板不展示交接物正文/补丁/代码）；
 *   · **绝不抛**：坏 JSON / 读失败 / 形状不对 ⇒ 跳过该任务并记进 `warnings[]`；连工作区目录
 *     都读不了才 `ok:false`（此时 `tasks` 为空、`error` 说清原因）；
 *   · **同步纯函数**：`now` 可注入，测试因此不靠 `sleep` 换秒。
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
 * ---- 两个字段形状（盘上逐字段核对过，**别靠想象写**）------------------------
 *   `task.dispatched[]` = `{ key, role, seat, agent_id, session_id, token, at, at_ms, via }`
 *     （`lib/liveness/seats.js` 的 `upsertDispatch`）。**没有** `memberName` 这一格 ⇒ 读
 *     `memberName ?? member_name`，取不到就是 `null`（不拿 `agent_id` 冒充名字）；通道字段是
 *     `via`（`team` / `subagent` / `manual`），`manual` 没建会话 ⇒ `kind:"unknown"`。
 *   `task.human_requests[]` 的"答复过了"与 `lib/store/status.js:253`、`lib/store/human.js:429`
 *     同一套判据：`status === 'answered' | 'withdrawn'`（`pending → relayed → answered`，
 *     `relayed` 只是转告过了，**仍然算待办**）。
 * @module dsh-pipeline/lib/panel/snapshot
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ROLE, roleLabel } from '../roles.js'
import { STATE_LABEL } from '../states.js'
import { pathKey } from '../util.js'

/** 只认这个前缀的任务目录（`_memory` / `_trash` / 杂项一律不看）。 */
export const PANEL_TASK_PREFIX = 'T-'
/** 需求摘要上限（按**码点**算，CJK 与 emoji 都不会被劈成半个）。 */
export const PANEL_SNIPPET_MAX = 80
/** 任务板镜像文件名（与 `lib/team/board-state.js` 的 `BOARD_FILE_NAME` 同名）。 */
export const TEAM_BOARD_FILE = 'team-board.json'
/** 席位状态：当前会话 / 已派出 / 仅声明。 */
export const SEAT_STATUS = Object.freeze({ CURRENT: 'current', DISPATCHED: 'dispatched', DECLARED: 'declared' })
/** 席位挂在哪个通道上。 */
export const SEAT_KIND = Object.freeze({ SESSION: 'session', TEAM: 'team', UNKNOWN: 'unknown' })
/** 人工请求里"已经不需要人再答"的状态（与 store 侧逐字一致）。 */
const HUMAN_CLOSED_STATUSES = ['answered', 'withdrawn']

/**
 * 构建面板快照（**同步 · 纯读 · 绝不抛**）。
 *
 * @param {object} input
 * @param {string} input.projectRoot - 项目根（与插件其它地方同一个来源，别再猜第二份）
 * @param {string} [input.artifactDirName] - 工作区目录名，默认 `.pipeline`
 * @param {number|Date} [input.now] - 注入当前时刻（测试用；直接用作 `generated_at`）
 * @returns {{ok:boolean, generated_at:string, project_root:string, tasks:Array<object>, warnings:string[], error?:string}}
 */
export function buildPanelSnapshot(input = {}) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const nowMs = msOf(opts.now) ?? Date.now()
  const rootRaw = String(opts.projectRoot ?? '')
  const base = { generated_at: isoOf(nowMs), project_root: pathKey(rootRaw) }
  const warnings = []

  if (rootRaw.length === 0) {
    return { ok: false, ...base, error: '面板快照需要 projectRoot（不能为空）。', tasks: [], warnings }
  }

  try {
    const pipelineDir = join(rootRaw, nonEmptyText(opts.artifactDirName) ?? '.pipeline')
    let entries = null
    try {
      entries = readdirSync(pipelineDir, { withFileTypes: true })
    } catch (err) {
      // 目录还不存在 = 这个 profile 还没有任何任务 —— 这是"空"，不是"坏"。
      if (err?.code === 'ENOENT') return { ok: true, ...base, tasks: [], warnings }
      warnings.push(`读取工作区目录失败（${pathKey(pipelineDir)}）：${reasonOf(err)}`)
      return { ok: false, ...base, error: `读取工作区目录失败：${reasonOf(err)}`, tasks: [], warnings }
    }

    const rows = []
    for (const dirent of sortDirents(entries)) {
      const name = String(dirent?.name ?? '')
      if (!name.startsWith(PANEL_TASK_PREFIX)) continue
      if (isDirectory(dirent) !== true) continue
      const built = buildTaskRow({ taskId: name, taskDir: join(pipelineDir, name), nowMs, warnings })
      if (built !== null) rows.push(built)
    }
    // 任务按 `updated_at` **倒序**；同刻按 id 升序（确定性 —— 顺序不靠天吃饭）。
    rows.sort((a, b) => (b.sortMs - a.sortMs) || compareText(a.entry.id, b.entry.id))
    return { ok: true, ...base, tasks: rows.map((r) => r.entry), warnings }
  } catch (err) {
    // 兜底：任何意外都不许把面板打成 500 —— 如实说"没拿到"，并把理由带出去。
    warnings.push(`面板快照构建异常：${reasonOf(err)}`)
    return { ok: false, ...base, error: `面板快照构建异常：${reasonOf(err)}`, tasks: [], warnings }
  }
}

/** 一个任务目录 → 一行任务（坏 JSON / 形状不对 ⇒ `null` + `warnings`）。 */
function buildTaskRow({ taskId, taskDir, nowMs, warnings }) {
  const taskFile = join(taskDir, 'task.json')
  let text = null
  let mtimeMs = null
  try {
    mtimeMs = statSync(taskFile).mtimeMs
    text = readFileSync(taskFile, 'utf8')
  } catch (err) {
    warnings.push(`任务 ${taskId}：task.json 读不出来（${reasonOf(err)}），已跳过。`)
    return null
  }
  let task = null
  try {
    task = JSON.parse(text)
  } catch (err) {
    warnings.push(`任务 ${taskId}：task.json 不是合法 JSON（${reasonOf(err)}），已跳过。`)
    return null
  }
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    warnings.push(`任务 ${taskId}：task.json 不是一个任务对象（${Array.isArray(task) ? '是数组' : typeof task}），已跳过。`)
    return null
  }
  const updatedAt = updatedAtOf(task, mtimeMs, nowMs)
  return {
    entry: {
      id: taskId,
      state: textOf(task.state),
      state_label: stateLabelOf(task.state),
      requirement_snippet: snippetOf(task.requirement),
      updated_at: updatedAt,
      human_pending: humanPendingCount(task),
      team_board: teamBoardOf({ taskDir, taskId, warnings }),
      seats: seatsOf(task),
    },
    sortMs: msOf(updatedAt) ?? 0,
  }
}

/** 状态中文名；认不出就原样返回 id（宁可显示得丑，也不要抛、不要吞）。 */
export function stateLabelOf(state) {
  const key = textOf(state)
  if (key.length === 0) return ''
  return Object.hasOwn(STATE_LABEL, key) ? STATE_LABEL[key] : key
}

/**
 * 需求摘要：压缩空白 → 截 {@link PANEL_SNIPPET_MAX} 个码点 → 超出加 `…`。
 * **只取 `task.requirement`** —— 这里绝不去读 handoff 正文。
 */
export function snippetOf(requirement) {
  const collapsed = String(requirement ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return ''
  const chars = Array.from(collapsed)
  return chars.length > PANEL_SNIPPET_MAX ? `${chars.slice(0, PANEL_SNIPPET_MAX).join('')}…` : collapsed
}

/** 未答复的人工请求条数（判据同 store：`status` 不是 `answered` / `withdrawn` 就算待办）。 */
export function humanPendingCount(task) {
  const list = Array.isArray(task?.human_requests) ? task.human_requests : []
  let n = 0
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    if (HUMAN_CLOSED_STATUSES.includes(textOf(raw.status))) continue
    n += 1
  }
  return n
}

/** `updated_at`：盘上合法就原样用（不重新格式化，免得与审计对不上）；否则退回文件 mtime。 */
function updatedAtOf(task, mtimeMs, nowMs) {
  const raw = textOf(task?.updated_at)
  if (raw.length > 0 && msOf(raw) !== null) return raw
  return isoOf(msOf(mtimeMs) ?? nowMs)
}

/** 同目录的 `team-board.json`：有就只读这两个字段，没有/读坏了 ⇒ `null`。 */
function teamBoardOf({ taskDir, taskId, warnings }) {
  const file = join(taskDir, TEAM_BOARD_FILE)
  let text = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    // 没有镜像文件是常态（不是每个任务都接官方任务板），不出声。
    if (err?.code !== 'ENOENT') warnings.push(`任务 ${taskId}：${TEAM_BOARD_FILE} 读不出来（${reasonOf(err)}）。`)
    return null
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    warnings.push(`任务 ${taskId}：${TEAM_BOARD_FILE} 不是合法 JSON（${reasonOf(err)}）。`)
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`任务 ${taskId}：${TEAM_BOARD_FILE} 不是一个对象。`)
    return null
  }
  return { team_task_id: nullableText(parsed.team_task_id), last_action: nullableText(parsed.last_action) }
}

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
      session_id: nullableText(rec?.session_id),
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
    const role = nonEmptyText(part.role_id) ?? ROLE.WRITER
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

/** 目录项排序（让扫描顺序确定；展示顺序由 `updated_at` 决定）。 */
function sortDirents(entries) {
  const list = Array.isArray(entries) ? entries.slice() : []
  list.sort((a, b) => compareText(textOf(a?.name), textOf(b?.name)))
  return list
}

/** `Dirent` 判目录；判不出来就当"不是目录"（不抛）。 */
function isDirectory(dirent) { try { return dirent.isDirectory() } catch { return false } }

function compareText(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0
  return x < y ? -1 : 1
}

/** 非空字符串才算数（`null` / `''` / 纯空白 ⇒ `null`）。 */
function nullableText(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s.length === 0 ? null : s
}

/** 宽松取文本：数字 / 字符串都收，其它给空串（状态、角色 id 这类**不该**是对象）。 */
function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 非空文本或 `null`。 */
function nonEmptyText(value) {
  return nullableText(value)
}

/** 收敛成毫秒数；取不到 `null`（**不猜**）。 */
function msOf(value) {
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** ISO 字符串（去掉毫秒尾巴，与 `lib/util.js` 的 `nowIso` 同一个形状）。 */
function isoOf(value) {
  return new Date(msOf(value) ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 异常 → 一句人话（不带堆栈：`warnings` 是给人看的）。 */
function reasonOf(err) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code} ` : ''
  return `${code}${String(err?.message ?? err)}`
}
