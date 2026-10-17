/**
 * dsh-pipeline · 自建流水线面板 · **归档视图**（`_trash/` 里那些单）
 * ============================================================================
 * 面板主视图只列 `<项目根>/<artifactDirName>/T-*`；被 `archive`（= `purgeTask(mode:"trash")`）
 * 收掉的单挪进了 `_trash/<任务id>-<时刻>/` —— 主视图里看不见它们，"归档了还能不能捞回来"
 * 这件事在界面上就悬空。本模块补这一半：
 *
 *   ① `listArchived`   只读。坏 JSON 只进 `warnings[]`（与快照同一条口径，不打成 500）。
 *   ② `restoreArchived` `renameSync` 挪回主视图。两道硬闸：目录名必须是 `_trash` 的
 *                    **直接子目录**（挡穿越）、目标目录**不存在**（挡覆盖 —— 覆盖一张
 *                    在跑的单就是数据损坏，且看不出来）。
 *   ③ `deleteArchived` **不可恢复**：必须 `confirm === true`；**先留痕、后动手**
 *                    （墓碑写进 `<项目根>/<artifactDirName>/_purge-log.jsonl`，与
 *                    `lib/store/purge.js` **同一个账本、同一个文件名常量** ——
 *                    账本不在被删目录里，所以删完还查得到）。
 *
 * ★ 任务 id 为什么"从右往左"拆：目录名是 `<任务id>-<stamp>`（`purge.js` 就这么拼，
 *   `stamp = nowIso().replace(/[:]/g,'')` ⇒ `2026-10-18T042252Z`），而任务 id 自己也带
 *   短横线（`T-20261015-bb30bc`）⇒ 只能右锚定认 stamp。认不出就退回 `task.json.id`，
 *   再不行才用目录名本身。
 *
 * @module dsh-pipeline/lib/panel/archive
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { snippetOf, stateLabelOf } from './snapshot.js'
// ★ 归档目录名 / 墓碑文件名 / 目录名安全判定 **一律复用 purge.js 那一份**：
//   另造一套名字就会出现"归档在一个目录、删除记在另一个账本"这种对不上账的分叉。
import { PURGE_LOG_NAME, TRASH_DIR_NAME, isSafeTaskDirName } from '../store/purge.js'
import { nowIso, pathKey } from '../util.js'

/** 归档目录名（就是 `purge.js` 的 `_trash`；转出，不另存一份字面量）。 */
export const ARCHIVE_DIR_NAME = TRASH_DIR_NAME

/** 永久删除归档时写进墓碑的理由（用户可见文案，中文）。 */
export const DELETE_ARCHIVED_REASON = '面板·永久删除归档'

/** 缺二次确认时的拒绝原文（**不可恢复**的动作单独加闸）。 */
export const DELETE_ARCHIVED_CONFIRM_ERROR = '永久删除归档需要二次确认'

/** 目录名里那个时刻尾巴 `-2026-10-18T042252Z`（可带毫秒）。**右锚定**：任务 id 自己带短横线。 */
const STAMP_RE = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/

/**
 * 列归档任务（**同步 · 纯读 · 绝不抛**）。
 *
 * @param {object} input `{ projectRoot, artifactDirName? }`
 * @returns {{ok:boolean, tasks:Array<{id:string, dir:string, state:string, state_label:string,
 *   requirement_snippet:string, archived_at:string}>, warnings:string[], error?:string}}
 */
export function listArchived(input = {}) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const rawRoot = textOf(opts.projectRoot)
  const warnings = []
  // 空根不是"坏"，是"没接线"：说清缺什么，仍然给一个形状完整的空结果。
  if (rawRoot.length === 0) return { ok: false, tasks: [], warnings, error: '归档视图需要 projectRoot（不能为空）。' }
  const trashDir = join(workspaceDirOf(rawRoot, opts.artifactDirName), ARCHIVE_DIR_NAME)

  let entries = null
  try {
    entries = readdirSync(trashDir, { withFileTypes: true })
  } catch (err) {
    // 没有 `_trash` = 这个 profile 还没归档过任何单 —— 这是"空"，不是"坏"。
    if (err?.code === 'ENOENT') return { ok: true, tasks: [], warnings }
    warnings.push(`读取归档目录失败（${pathKey(trashDir)}）：${reasonOf(err)}`)
    return { ok: false, tasks: [], warnings, error: `读取归档目录失败：${reasonOf(err)}` }
  }

  const rows = []
  for (const dirent of sortDirents(entries)) {
    const name = textOf(dirent?.name)
    if (name.length === 0 || isDirectory(dirent) !== true) continue
    const row = buildArchivedRow({ dirName: name, dirPath: join(trashDir, name), warnings })
    if (row !== null) rows.push(row)
  }
  // 最近归档的在前；同刻按目录名升序（确定性 —— 顺序不靠天吃饭）。
  rows.sort((a, b) => (Date.parse(b.archived_at) || 0) - (Date.parse(a.archived_at) || 0) || compareText(a.dir, b.dir))
  return { ok: true, tasks: rows, warnings }
}

/**
 * 把一个归档目录**挪回**主视图（**同步 · 不抛**）。
 *
 * @param {object} input `{ projectRoot, artifactDirName?, dir }`（`dir` = 归档目录名 / `task_id`）
 * @returns {{ok:boolean, task_id?:string, restored_to?:string, error?:string}}
 */
export function restoreArchived(input = {}) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const rawRoot = textOf(opts.projectRoot)
  if (rawRoot.length === 0) return { ok: false, error: '恢复归档需要 projectRoot（不能为空）。' }

  const located = locateArchived(rawRoot, opts.artifactDirName, opts.dir)
  if (located.ok !== true) return { ok: false, error: located.error }
  const { src, pipelineDir, dirName } = located

  const taskId = taskIdOfDir(dirName, readTaskIdOf(src))
  if (!isSafeTaskDirName(taskId)) {
    return { ok: false, error: `从归档目录名里认不出可用的任务 id：${dirName}（不猜，也不改名硬塞）。` }
  }
  const target = join(pipelineDir, taskId)
  // ★ 挡覆盖：目标已在册就**停手**。覆盖一张在跑的单 = 数据损坏，且看不出来。
  if (existsSync(target)) {
    return { ok: false, error: `目标目录已存在，不覆盖：${pathKey(target)}（把同名任务挪走或删掉再来）。` }
  }
  try {
    renameSync(src, target)
  } catch (err) {
    return { ok: false, error: `恢复归档失败（没有挪一半当成功）：${reasonOf(err)}` }
  }
  return { ok: true, task_id: taskId, restored_to: pathKey(target) }
}

/**
 * **永久删除**一个归档目录（**同步 · 不抛**）。
 *
 * 顺序是硬的：① 二次确认 ⇒ ② 定位（必须 `_trash` 直接子目录）⇒ ③ **先写墓碑** ⇒ ④ 递归删除。
 * 墓碑写不进去就**不许删**（否则会出现"删了没账"）—— 与 `purge.js` 同一条纪律。
 *
 * @param {object} input `{ projectRoot, artifactDirName?, dir, confirm }`（`confirm` 必须严格 `true`）
 * @returns {{ok:boolean, task_id?:string, deleted?:boolean, error?:string}}
 */
export function deleteArchived(input = {}) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  if (opts.confirm !== true) return { ok: false, error: DELETE_ARCHIVED_CONFIRM_ERROR }

  const rawRoot = textOf(opts.projectRoot)
  if (rawRoot.length === 0) return { ok: false, error: '永久删除归档需要 projectRoot（不能为空）。' }

  const located = locateArchived(rawRoot, opts.artifactDirName, opts.dir)
  if (located.ok !== true) return { ok: false, error: located.error }
  const { src, pipelineDir, dirName } = located

  const taskId = taskIdOfDir(dirName, readTaskIdOf(src))
  if (!isSafeTaskDirName(taskId)) {
    return { ok: false, error: `从归档目录名里认不出可用的任务 id：${dirName}（不猜，也不删自己说不清的东西）。` }
  }

  const tombstone = {
    at: nowIso(new Date()),
    task_id: taskId,
    mode: 'delete-archived',
    by: 'human',
    reason: DELETE_ARCHIVED_REASON,
  }
  try {
    appendFileSync(join(pipelineDir, PURGE_LOG_NAME), `${JSON.stringify(tombstone)}\n`, 'utf8')
  } catch (err) {
    return { ok: false, error: `拒绝删除：墓碑账本写不进去（${reasonOf(err)}）。先留痕后动手是这条通道的硬约束。` }
  }
  try {
    rmSync(src, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `删除失败（墓碑已记下这一次尝试）：${reasonOf(err)}` }
  }
  return { ok: true, task_id: taskId, deleted: true }
}

/* 内部 --------------------------------------------------------------------- */

/** 工作区目录（`<项目根>/<artifactDirName>`）。 */
function workspaceDirOf(root, dirName) {
  const s = textOf(dirName)
  return join(root, s.length === 0 ? '.pipeline' : s)
}

/**
 * 把用户给的 `dir` 解析成 `_trash` 下的一个**真实子目录**，否则说清为什么不行。
 * 三道校验缺一不可：① 名字本身安全（挡 `../../`）；② 拼出来的路径父目录**就是** `_trash`
 * （双保险）；③ 真的存在、而且是个目录（不是文件）。
 */
function locateArchived(root, dirName, dir) {
  const wanted = textOf(dir)
  if (!isSafeTaskDirName(wanted)) {
    return { ok: false, error: `归档目录名不合法（不许含路径分隔符、不许是 . / ..）：${JSON.stringify(dir)}` }
  }
  const pipelineDir = workspaceDirOf(root, dirName)
  const trashDir = join(pipelineDir, ARCHIVE_DIR_NAME)
  const src = join(trashDir, wanted)
  if (pathKey(dirname(resolve(src))) !== pathKey(resolve(trashDir))) {
    return { ok: false, error: `不是归档目录的直接子目录：${wanted}` }
  }
  let stat = null
  try {
    stat = statSync(src)
  } catch {
    return { ok: false, error: `找不到归档目录：${pathKey(src)}` }
  }
  if (stat?.isDirectory?.() !== true) return { ok: false, error: `归档目录不是目录：${pathKey(src)}` }
  return { ok: true, src, pipelineDir, dirName: wanted }
}

/** 一个归档目录 → 一行（坏 JSON / 读不出来 ⇒ `null` + `warnings`）。 */
function buildArchivedRow({ dirName, dirPath, warnings }) {
  let text = null
  try {
    text = readFileSync(join(dirPath, 'task.json'), 'utf8')
  } catch (err) {
    warnings.push(`归档 ${dirName}：task.json 读不出来（${reasonOf(err)}），已跳过。`)
    return null
  }
  let task = null
  try {
    task = JSON.parse(text)
  } catch (err) {
    warnings.push(`归档 ${dirName}：task.json 不是合法 JSON（${reasonOf(err)}），已跳过。`)
    return null
  }
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    warnings.push(`归档 ${dirName}：task.json 不是一个任务对象（${Array.isArray(task) ? '是数组' : typeof task}），已跳过。`)
    return null
  }
  const state = textOf(task.state)
  const rawId = textOf(task.id)
  return {
    id: rawId.length > 0 ? rawId : taskIdOfDir(dirName, ''),
    dir: dirName,
    state,
    state_label: stateLabelOf(state),
    // ★ 摘要 / 中文名复用快照那两个纯函数：面板两处看到的是同一个口径。
    requirement_snippet: snippetOf(task.requirement),
    archived_at: archivedAtOf(dirName, dirPath),
  }
}

/** `archived_at`：**优先**用目录名里的 stamp（那是 purge 动手的时刻，最准），退回目录 mtime。 */
function archivedAtOf(dirName, dirPath) {
  const ms = stampMsOf(dirName)
  if (ms !== null) return isoOf(ms)
  try {
    return isoOf(statSync(dirPath).mtimeMs)
  } catch {
    return isoOf(Date.now())
  }
}

/** `_trash/<任务id>-<stamp>` 里的 stamp → 毫秒；不是这个形状就 `null`。 */
function stampMsOf(dirName) {
  const hit = STAMP_RE.exec(String(dirName ?? ''))
  if (hit === null) return null
  const [, y, mo, d, h, mi, s, ms] = hit
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${ms === undefined ? '' : `.${ms}`}Z`)
  return Number.isFinite(t) ? t : null
}

/** 任务 id：**从右往左**剥掉 stamp；认不出就用 `task.json.id`，再不行才用目录名本身。 */
function taskIdOfDir(dirName, fallbackId) {
  const name = String(dirName ?? '')
  const hit = STAMP_RE.exec(name)
  if (hit !== null) {
    const rest = name.slice(0, hit.index)
    if (rest.length > 0) return rest
  }
  const fb = textOf(fallbackId)
  return fb.length > 0 ? fb : name
}

/** 归档副本里 `task.json` 的 `id`（读不到 ⇒ 空串，由调用方回退）。 */
function readTaskIdOf(dirPath) {
  try {
    const parsed = JSON.parse(readFileSync(join(dirPath, 'task.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? textOf(parsed.id) : ''
  } catch {
    return ''
  }
}

/** 目录项排序（让扫描顺序确定；展示顺序由 `archived_at` 决定）。 */
function sortDirents(entries) {
  return (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => compareText(textOf(a?.name), textOf(b?.name)))
}

/** `Dirent` 判目录；判不出来就当"不是目录"（不抛）。 */
function isDirectory(dirent) { try { return dirent.isDirectory() } catch { return false } }

function compareText(a, b) {
  const [x, y] = [String(a ?? ''), String(b ?? '')]
  return x === y ? 0 : x < y ? -1 : 1
}

/** 宽松取文本（状态 / id / 目录名这类**不该**是对象）。 */
function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** ISO 字符串（去掉毫秒尾巴，与 `lib/util.js` 的 `nowIso` 同一个形状）。 */
function isoOf(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value)
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 异常 → 一句人话（不带堆栈：`warnings` 是给人看的）。 */
function reasonOf(err) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code} ` : ''
  return `${code}${String(err?.message ?? err)}`
}
