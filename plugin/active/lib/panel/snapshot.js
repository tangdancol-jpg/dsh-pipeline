// 面板快照 · 编排：扫描 `<项目根>/.pipeline/T-*/task.json`，压成面板快照（排序 / 置顶 / 降级）。
/**
 * dsh-pipeline · 自建流水线面板 · **数据面**（宿主侧只读快照）
 * ============================================================================
 * 一次给齐客户端要显示的四样东西：任务列表（状态中文名 + 需求摘要）、每个任务的席位
 * （角色中文名 + 席位号 + 是否已派出 + 当前会话身份）、人工待办数。
 * 外加两格：`pinned`（这颗星是不是用户置顶的，见 `lib/panel/pins.js`）与
 * `allowed_actions`（这个状态下**面板能发起**哪些操作；只读判定，
 * 执行在 `lib/panel/actions.js`，两边共用 `lib/states.js` 的同一份状态机判据）。
 *
 * 排序：**置顶优先**，组内按 `updated_at` 倒序（见 `buildPanelSnapshot` 里那段比较器）。
 *
 * ---- 三块的边界（本轮拆文件后的唯一口径）------------------------------------
 *   · 席位怎么合 ⇒ `./seats.js`（`main` / 声明位 / 派活台账三层，含 `session_id` 兜底）；
 *   · 每个字段怎么算 ⇒ `./task-fields.js`（摘要 / 待办数 / `team_board` / `tier` /
 *     `allowed_actions` + 键序契约常量 + 共用标量工具）；
 *   · 本文件只做**编排**：目录扫描、行装配、排序、置顶读取、降级。
 *   本文件对上面两块**只 import、不反向依赖**，并由文件末尾的 barrel 保持
 *   `lib/panel/snapshot.js` 原有 18 个导出一个不少（其它模块与测试照旧只从这里 import）。
 *
 * ---- 硬边界 ----------------------------------------------------------------
 *   · **只读**：只 `readdirSync` / `readFileSync` / `statSync`，一个字节都不写任务数据
 *     （置顶表的**写**在 `pins.js`，本文件只读它）；
 *   · **不读正文**：只碰 `task.json` 与 `team-board.json` 的**结构化字段**，绝不打开
 *     `handoffs/` · `artifacts/` · `records/` · `reports/`（面板不展示交接物正文/补丁/代码）；
 *   · **绝不抛**：坏 JSON / 读失败 / 形状不对 ⇒ 跳过该任务并记进 `warnings[]`；连工作区目录
 *     都读不了才 `ok:false`（此时 `tasks` 为空、`error` 说清原因）；
 *   · **同步纯函数**：`now` 可注入，测试因此不靠 `sleep` 换秒。
 *
 * @module dsh-pipeline/lib/panel/snapshot
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readPins } from './pins.js'
import { seatsOf } from './seats.js'
import {
  allowedActionsOf,
  humanPendingCount,
  isoOf,
  msOf,
  nullableText,
  reasonOf,
  snippetOf,
  stateLabelOf,
  taskTierOf,
  teamBoardOf,
  textOf,
  updatedAtOf,
} from './task-fields.js'
import { pathKey } from '../util.js'

/** 只认这个前缀的任务目录（`_memory` / `_trash` / 杂项一律不看）。 */
export const PANEL_TASK_PREFIX = 'T-'

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
    const dirName = nullableText(opts.artifactDirName) ?? '.pipeline'
    const pipelineDir = join(rootRaw, dirName)
    // ★ 置顶表是一次读出来的（不是每行再读一遍盘）：坏文件在 `pins.js` 里已经降级成空表。
    const pinnedIds = pinnedSetOf(rootRaw, dirName, warnings)
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
      const built = buildTaskRow({ taskId: name, taskDir: join(pipelineDir, name), nowMs, warnings, pinnedIds })
      if (built !== null) rows.push(built)
    }
    // 排序：**置顶优先**，组内按 `updated_at` 倒序；同刻按 id 升序（确定性 —— 顺序不靠天吃饭）。
    // ★ 置顶组内部**不另立一套顺序**：置顶只回答"要不要往上提"，不跟时间抢排序权。
    rows.sort((a, b) => (Number(b.entry.pinned) - Number(a.entry.pinned))
      || (b.sortMs - a.sortMs)
      || compareText(a.entry.id, b.entry.id))
    return { ok: true, ...base, tasks: rows.map((r) => r.entry), warnings }
  } catch (err) {
    // 兜底：任何意外都不许把面板打成 500 —— 如实说"没拿到"，并把理由带出去。
    warnings.push(`面板快照构建异常：${reasonOf(err)}`)
    return { ok: false, ...base, error: `面板快照构建异常：${reasonOf(err)}`, tasks: [], warnings }
  }
}

/** 一个任务目录 → 一行任务（坏 JSON / 形状不对 ⇒ `null` + `warnings`）。 */
function buildTaskRow({ taskId, taskDir, nowMs, warnings, pinnedIds }) {
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
      // ★ `tier` 只从**结构化字段**读（`roster.tier` 优先于 `task.tier`），只认 `L0`–`L5`；
      //   认不出就是 `null` —— **绝不**从需求文本里猜。判据见 `task-fields.js#taskTierOf`。
      tier: taskTierOf(task),
      // ★ `pinned` / `allowed_actions` 仍然垫在最后两个位置（`tier` 插在它们之前）：
      //   既有 8 个键位置不动，`allowed_actions` 仍是最后一个键。
      //   判据见 `task-fields.js#PANEL_TASK_KEY_ORDER`（键序是契约，测试逐字钉住）。
      pinned: pinnedIds instanceof Set && pinnedIds.has(taskId),
      // ★ 追加在最后（键名/顺序不动）：判据见 `task-fields.js#allowedActionsOf`，
      //   全部来自 `lib/states.js`，不手抄状态名单。
      allowed_actions: allowedActionsOf(task.state),
    },
    sortMs: msOf(updatedAt) ?? 0,
  }
}

/**
 * 置顶 id 集合（**读不出来就是空集**：置顶丢了只影响排序，不该让整张面板失败）。
 *
 * @param {string} root
 * @param {string} dirName
 * @param {string[]} warnings
 * @returns {Set<string>}
 */
function pinnedSetOf(root, dirName, warnings) {
  try {
    return new Set(readPins(root, dirName))
  } catch (err) {
    warnings.push(`读取置顶表失败（${reasonOf(err)}），本次按"没有置顶"处理。`)
    return new Set()
  }
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

// ---------------------------------------------------------------------------
// barrel：`lib/panel/snapshot.js` 拆分前的 18 个导出**一个不少**。
// 其它模块（`index.js` / `lib/panel/archive.js`）与测试照旧只从本文件 import。
// ---------------------------------------------------------------------------

export { SEAT_KIND, SEAT_STATUS, declaredSeatsOf, kindOfChannel, seatKeyOf, sessionIdOfAgentId } from './seats.js'
export {
  PANEL_ACTION_ORDER,
  PANEL_SNIPPET_MAX,
  PANEL_TASK_KEY_ORDER,
  TEAM_BOARD_FILE,
  allowedActionsOf,
  humanPendingCount,
  snippetOf,
  stateLabelOf,
  taskTierOf,
} from './task-fields.js'
export { seatsOf }
