// 面板任务行字段域：一行任务里 `state_label` / 摘要 / 待办数 / `team_board` / `tier` / `allowed_actions` 各怎么算。
/**
 * dsh-pipeline · 自建流水线面板 · **任务行字段域**
 * ============================================================================
 * 一行任务里"每个字段怎么算"的唯一出处，以及字段契约常量（键序 / 摘要上限 / 操作顺序）。
 *
 *   · `snippetOf` 压缩空白 → 截 {@link PANEL_SNIPPET_MAX} 个码点 → 超出加 `…`；只取 `task.requirement`；
 *   · `humanPendingCount` 只数**还没答复**的（`relayed` 只是转告过了，**仍然算待办**）；
 *   · `updatedAtOf` / `teamBoardOf` 行装配用的两个读法（mtime 兜底 / 只读团队板两格）；
 *   · `taskTierOf` 只从**结构化字段**读（`roster.tier` → `task.tier`），认不出就是 `null`，**不猜**；
 *   · `allowedActionsOf` 判据全部复用 `lib/states.js`，本文件不另抄状态名单。
 *
 * 共用标量工具（`textOf` / `nullableText` / `msOf` / `isoOf` / `reasonOf`）也在这里**只定义一次**：
 * `seats.js` / `snapshot.js` 从这里取；本文件**不 import 另外两块**（循环依赖约束）。
 *
 * @module dsh-pipeline/lib/panel/task-fields
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STATE_LABEL, TERMINAL_STATES, findTransition } from '../states.js'

/** 需求摘要上限（按**码点**算，CJK 与 emoji 都不会被劈成半个）。 */
export const PANEL_SNIPPET_MAX = 80
/** 任务板镜像文件名（与 `lib/team/board-state.js` 的 `BOARD_FILE_NAME` 同名）。 */
export const TEAM_BOARD_FILE = 'team-board.json'
/** 人工请求里"已经不需要人再答"的状态（与 store 侧逐字一致）。 */
const HUMAN_CLOSED_STATUSES = ['answered', 'withdrawn']
/** 只认这六档（大小写不敏感，输出统一大写）。 */
const TIER_IDS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])

/**
 * 面板操作 id（顺序 = 契约顺序，**只出现可用的**）。与 `lib/panel/actions.js` 的
 * `PANEL_ACTION_IDS` **前四个同组**：本文件只答"能做什么"，真做成由 `actions.run()` 判。
 * `pin` / `unpin` / `unarchive` / `delete_archived` **不在这里**（与状态机无关，
 * 进了数组就会给在跑的单画出"恢复归档"按钮）。
 */
export const PANEL_ACTION_ORDER = Object.freeze(['cancel', 'restore', 'archive', 'delete'])

/**
 * 任务行的**键序契约**（`allowed_actions` 固定在最后；`tier` 倒数第三、`pinned` 倒数第二）。
 * 写成本常量：客户端按它渲染，键序**会被无意打乱**；测试逐字比对，漂移当场被抓住。
 */
export const PANEL_TASK_KEY_ORDER = Object.freeze([
  'id', 'state', 'state_label', 'requirement_snippet',
  'updated_at', 'human_pending', 'team_board', 'seats',
  'tier', 'pinned', 'allowed_actions',
])

/** 状态中文名；认不出就原样返回 id（宁可显示得丑，也不要抛、不要吞）。 */
export function stateLabelOf(state) {
  const key = textOf(state)
  if (key.length === 0) return ''
  return Object.hasOwn(STATE_LABEL, key) ? STATE_LABEL[key] : key
}

/**
 * 当前状态下**面板可以发起**的操作（顺序固定：`cancel, restore, archive, delete`）。
 * ★ 判据全部复用状态机，不另抄状态名单：`cancel` 要先挡终态（表里那条是 `from:'*'`，
 *   对 `closed` / `cancelled` 也会返回非 null；"什么是终态"读 `TERMINAL_STATES`）；
 *   `restore` 直接问 `unblock` 边；`archive` / `delete` 仅终态（与 `purgeTask` 同一份判据）。
 * @param {string} state
 * @returns {string[]} 可能是空数组（未知/空状态：什么都不能做，也绝不抛）
 */
export function allowedActionsOf(state) {
  const key = textOf(state)
  if (key.length === 0) return []
  const terminal = TERMINAL_STATES.includes(key)
  const out = []
  if (!terminal && findTransition(key, 'cancel') !== null) out.push('cancel')
  if (!terminal && findTransition(key, 'unblock') !== null) out.push('restore')
  if (terminal) out.push('archive', 'delete')
  return out
}

/**
 * 任务档位（`L0`–`L5`）：**只从结构化字段读**，认不出就是 `null`。
 * ★ 取值顺序 `task.roster.tier` → `task.tier`；第一个**非空**来源说了算，写了却认不出 ⇒
 *   `null`（不退回读下一个，更**不**从 `requirement` 文本里猜）。大小写不敏感，输出统一大写。
 * @param {object} [task]
 * @returns {string|null}
 */
export function taskTierOf(task) {
  for (const raw of [task?.roster?.tier, task?.tier]) {
    const text = nullableText(raw)
    if (text === null) continue
    const key = text.toUpperCase()
    return TIER_IDS.includes(key) ? key : null
  }
  return null
}

/** 需求摘要：压缩空白 → 截 {@link PANEL_SNIPPET_MAX} 个码点 → 超出加 `…`；只取 `task.requirement`。 */
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

/** `updated_at`：盘上合法就原样用（不重新格式化，免得与审计对不上），否则退回 mtime；导出只为 `snapshot.js` 行装配。 */
export function updatedAtOf(task, mtimeMs, nowMs) {
  const raw = textOf(task?.updated_at)
  if (raw.length > 0 && msOf(raw) !== null) return raw
  return isoOf(msOf(mtimeMs) ?? nowMs)
}

/** 同目录 `team-board.json`：只读 `team_task_id` / `last_action`，没有/读坏了 ⇒ `null`（`warnings` 由调用方给）。 */
export function teamBoardOf({ taskDir, taskId, warnings }) {
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

// 共用标量工具（**唯一出处**：`seats.js` / `snapshot.js` 从这里取，不另抄）
/** 非空文本或 `null`（`nullableText` 的语义在调用点更清楚：空串一律当"没有"）。 */
export function nullableText(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s.length === 0 ? null : s
}
/** 宽松取文本：数字 / 字符串都收，其它给空串（状态、角色 id 这类**不该**是对象）。 */
export function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}
/** 收敛成毫秒数；取不到 `null`（**不猜**）。 */
export function msOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}
/** ISO 字符串（去掉毫秒尾巴，与 `lib/util.js` 的 `nowIso` 同一个形状）。 */
export function isoOf(value) {
  return new Date(msOf(value) ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
/** 异常 → 一句人话（不带堆栈：`warnings` 是给人看的）。 */
export function reasonOf(err) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code} ` : ''
  return `${code}${String(err?.message ?? err)}`
}
