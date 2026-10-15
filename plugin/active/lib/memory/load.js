// 读既有档案：把 `.pipeline/<T-*>/task.json` 与 `handoffs/*.json` 的**摘要字段**折成记忆条目（E0 的数据源，只读）。
/**
 * dsh-pipeline · 记忆 · 读既有档案（E0 的"库"就是 `.pipeline/` 本身）
 * ============================================================================
 * E0 刻意**不建记忆库**（设计 `06-分阶段.md`）：`recall` 的输入就是既有的
 * `.pipeline/<任务>/` 档案 —— 那里已经有 `task.json`、`handoffs/*.json`。
 * 于是 E0 的收益**不需要任何新的写盘面**：零新建、零注入、零风险。
 *
 * ---------------------------------------------------------------------------
 * 两条纪律
 * ---------------------------------------------------------------------------
 *  ① **只取摘要**，不把正文搬进记忆：`patch_or_code` / `failure_logs` 这类长字段
 *     **整段跳过** —— 否则"切片"就变成"换个地方再读一次整份"，正好违背痛点 A。
 *  ② **坏行跳过并计数**（`skipped`），**不整库丢弃**（设计 `05` §3 的边界规定）。
 *     半行 JSON、缺 `task.json` 的目录、读不动的文件，都只影响它自己那一条。
 *
 * ★ 记忆条目的规范形状（E1 的 `record.js` 会给出**带校验**的同一套字段）：
 *   `{ id, at, kind, scope, text, entity[], refs }`
 *   · `id`    稳定且唯一（`task:<任务id>` / `handoff:<任务id>:<交接物id>`）—— 去重就靠它
 *   · `at`    ISO 时刻（时间路的依据）
 *   · `kind`  `task` / 交接物类型（`dev_to_test` …）
 *   · `text`  一行摘要（关键词路的依据；**有长度上限**）
 *   · `entity[]` 天然主键（`task:` / `path:` / `role:` / `state:` 前缀）—— E2 的实体路用它
 *   · `refs`  结构化引用（`task_id` / `state` / `paths[]` / `handoff` / `roles[]`）
 *
 * @module dsh-pipeline/lib/memory/load
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_LABEL } from '../states.js'
import { isTaskDirName } from './bank.js'

/** 单条摘要正文的长度上限（字符）。超出即截断 —— 摘要**不许**长成正文。 */
export const TEXT_MAX = 240

/** 摘要里每个字段片段的长度上限（字符）。 */
export const FIELD_MAX = 120

/** 一次读取的最多任务目录数（默认）。★ 有上限，避免库大了以后一次 recall 扫全盘。 */
export const MAX_TASKS = 40

/** 单个任务最多读几份交接物（默认，按文件名倒序取最近的）。 */
export const MAX_HANDOFFS_PER_TASK = 40

/**
 * 交接物摘要取哪几个字段（**顺序即优先级**，最多取前两个非空的）。
 *
 * 为什么是这几个：它们都是**一行说清结论**的字段；`patch_or_code` / `failure_logs`
 * 这类长正文**故意不在表里**（见文件头纪律①）。
 */
export const HANDOFF_SUMMARY_KEYS = [
  'change_note',
  'conclusion',
  'final_delivery_note',
  'selftest_result',
  'run_commands',
  'pass_evidence',
  'test_cases',
  'risk_notes',
  'known_issues',
]

/** 按字符截断并加省略号（幂等：已经是短串就原样返回）。 */
export function clip(value, max = FIELD_MAX) {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/** 把任意值折成"一行短摘要"（数组取前两项；对象不展开 —— 展开就是又把正文搬进来）。 */
export function summarizeValue(value, max = FIELD_MAX) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    const parts = value
      .slice(0, 2)
      .map((v) => summarizeValue(v, Math.floor(max / 2)))
      .filter((s) => s.length > 0)
    return clip(parts.join('；'), max)
  }
  if (typeof value === 'object') return ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  return clip(value, max)
}

/**
 * 一份 `task.json` → 一条记忆条目。
 *
 * @param {object} task
 * @returns {object|null} 形状不对（没有 id）⇒ `null`（调用方计一次 `skipped`）
 */
export function taskRecord(task) {
  const id = typeof task?.id === 'string' ? task.id.trim() : ''
  if (id.length === 0) return null
  const state = typeof task.state === 'string' ? task.state : ''
  const label = state.length > 0 ? STATE_LABEL[state] ?? state : '(未知状态)'
  const requirement = summarizeValue(task.requirement, FIELD_MAX)
  const acceptance = Array.isArray(task.acceptance_from_user) ? task.acceptance_from_user : []
  const scope = Array.isArray(task.change_scope) ? task.change_scope : []
  const paths = scope
    .map((s) => (typeof s?.path === 'string' ? s.path : ''))
    .filter((p) => p.length > 0)
  // ★ "最后停在哪一步"（E0 验收里的手工判据）：状态 + **最近一次动作事件**。
  //   事件名来自既有 `task.history`（`{ event, at, by }`），只取最后一条 —— 不搬正文。
  const history = Array.isArray(task.history) ? task.history : []
  const last = history.length > 0 && history[history.length - 1] !== null ? history[history.length - 1] : null
  const lastEvent = summarizeValue(last?.event, 60)

  const body =
    `任务 ${id}｜${label}（${state || '?'}）` +
    (lastEvent.length > 0 ? `｜最近动作：${lastEvent}` : '') +
    (requirement.length > 0 ? `｜需求：${requirement}` : '') +
    (acceptance.length > 0 ? `｜验收 ${acceptance.length} 条` : '')
  return {
    id: `task:${id}`,
    at: String(task.updated_at ?? task.created_at ?? ''),
    kind: 'task',
    scope: 'project',
    text: clip(body, TEXT_MAX),
    entity: [`task:${id}`, ...(state.length > 0 ? [`state:${state}`] : []), ...paths.map((p) => `path:${p}`)],
    refs: {
      task_id: id,
      state,
      state_label: label,
      paths,
      handoff: '',
      artifact_version: '',
      roles: [],
    },
  }
}

/**
 * 一份 `handoffs/*.json` → 一条记忆条目（**只存摘要 + 引用**，不存正文）。
 *
 * @param {object} h
 * @param {string} [taskId] - 目录名兜底（文件里没有 `task_id` 时用）
 * @returns {object|null}
 */
export function handoffRecord(h, taskId = '') {
  const hid = typeof h?.handoff_id === 'string' ? h.handoff_id.trim() : ''
  const tid = String(h?.task_id ?? taskId ?? '').trim()
  const kind = String(h?.kind ?? '').trim()
  if (hid.length === 0 || tid.length === 0 || kind.length === 0) return null

  const from = String(h?.from_role ?? '').trim()
  const to = String(h?.to_role ?? '').trim()
  const ver = String(h?.artifact_version ?? '').trim()
  const payload = h?.payload !== null && typeof h.payload === 'object' ? h.payload : {}

  const bits = []
  for (const key of HANDOFF_SUMMARY_KEYS) {
    if (bits.length >= 2) break
    const s = summarizeValue(payload[key])
    if (s.length > 0) bits.push(`${key}=${s}`)
  }
  const body =
    `${String(h?.kind_zh ?? kind)}（${from || '?'} → ${to || '?'}）` +
    (ver.length > 0 ? `｜${ver}` : '') +
    (bits.length > 0 ? `｜${bits.join('｜')}` : '')

  const roles = [from, to].filter((r) => r.length > 0)
  return {
    id: `handoff:${tid}:${hid}`,
    at: String(h?.created_at ?? ''),
    kind,
    scope: 'project',
    text: clip(body, TEXT_MAX),
    entity: [
      `task:${tid}`,
      `handoff:${hid}`,
      ...roles.map((r) => `role:${r}`),
      ...(ver.length > 0 ? [`artifact:${tid}:${ver}`] : []),
    ],
    refs: {
      task_id: tid,
      state: '',
      state_label: '',
      paths: [],
      handoff: hid,
      artifact_version: ver,
      roles,
    },
  }
}

/** 读一个 JSON 文件；失败返回 `null`（调用方计 `skipped`）。 */
async function readJson(fs, path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 列目录；不存在 / 读不动都返回 `[]`（**不抛** —— 边界：库不存在 ⇒ 空切片）。 */
async function listDir(fs, dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * ★ **读既有档案**（E0 的唯一数据入口）。
 *
 * @param {object} opts
 * @param {string} opts.archiveDir - `.pipeline/` 绝对路径（空串 ⇒ 直接返回空）
 * @param {string} [opts.taskId] - 只读这一张（给了就**不扫全目录**，更便宜）
 * @param {number} [opts.maxTasks]
 * @param {number} [opts.maxHandoffsPerTask]
 * @param {{readFile:Function, readdir:Function}} [opts.fs] - 文件系统缝（自测注入用）
 * @returns {Promise<{records:object[], skipped:number, tasks:number, handoffs:number, scan:string}>}
 */
export async function readArchive(opts = {}) {
  const fs = opts.fs ?? { readFile, readdir }
  const archive = String(opts.archiveDir ?? '').trim()
  const empty = { records: [], skipped: 0, tasks: 0, handoffs: 0, scan: 'EMPTY_ARCHIVE_DIR' }
  if (archive.length === 0) return empty

  const maxTasks = Number.isInteger(opts.maxTasks) && opts.maxTasks > 0 ? opts.maxTasks : MAX_TASKS
  const maxHandoffs =
    Number.isInteger(opts.maxHandoffsPerTask) && opts.maxHandoffsPerTask > 0
      ? opts.maxHandoffsPerTask
      : MAX_HANDOFFS_PER_TASK

  const only = typeof opts.taskId === 'string' ? opts.taskId.trim() : ''
  let ids = []
  if (only.length > 0) {
    ids = [only]
  } else {
    const entries = await listDir(fs, archive)
    ids = entries
      .filter((e) => e.isDirectory() && isTaskDirName(e.name))
      .map((e) => e.name)
      // ★ 倒序（`T-<日期>-<短码>` 可直接按字符串倒排）⇒ 先读到的是最近的任务。
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, maxTasks)
  }

  const records = []
  let skipped = 0
  let tasks = 0
  let handoffs = 0
  for (const id of ids) {
    const taskDir = join(archive, id)
    const task = await readJson(fs, join(taskDir, 'task.json'))
    const rec = task === null ? null : taskRecord(task)
    if (rec === null) skipped += 1
    else {
      records.push(rec)
      tasks += 1
    }
    const handoffDir = join(taskDir, 'handoffs')
    const files = (await listDir(fs, handoffDir))
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, maxHandoffs)
    for (const f of files) {
      const h = await readJson(fs, join(handoffDir, f))
      const hr = h === null ? null : handoffRecord(h, id)
      if (hr === null) skipped += 1
      else {
        records.push(hr)
        handoffs += 1
      }
    }
  }
  return { records, skipped, tasks, handoffs, scan: only.length > 0 ? `TASK:${only}` : `TASKS:${ids.length}` }
}

/**
 * ★ **读记忆库**（`.pipeline/_memory/memory.jsonl` → 记忆数组）。
 *
 * 与 {@link readArchive} 的分工：那个读**既有档案**（E0 的数据源，`recall` 用），
 * 这个读**记忆库**（E1 起由 retain 追加、由注入与 E2 的取回消费）。
 * 两者产出**同一套条目形状**，所以下游的 route / merge / budget **一个字都不用改**。
 *
 * 边界（设计 `05` §3 写死的规定，逐条落在这里）：
 *   · 库**不存在** ⇒ 空数组（**不建目录、不报错** —— 建库是 retain 的事）；
 *   · 库**为空** ⇒ 空数组；
 *   · **半行 / 坏行** ⇒ 跳过并计数（`skipped`），**不整库丢弃**（一条坏行不该废掉整库）。
 *
 * @param {string} file - `bank.memoryFile(projectDir)`
 * @param {object} [opts]
 * @param {{readFile:Function}} [opts.fs]
 * @param {number} [opts.limit] - 最多返回几条（**从最新往回取**：库是追加写的，新的在后面）
 * @returns {Promise<{records:object[], skipped:number, lines:number, reason:string}>}
 */
export async function readBank(file, opts = {}) {
  const fs = opts.fs ?? { readFile }
  const target = String(file ?? '').trim()
  const empty = { records: [], skipped: 0, lines: 0, reason: '' }
  if (target.length === 0) return { ...empty, reason: 'NO_MEMORY_FILE' }

  let raw = ''
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch {
    // ★ 库不存在（或读不动）⇒ 空。**这不是错误**：库是长出来的，不是建出来的。
    return { ...empty, reason: 'NO_BANK' }
  }

  const out = []
  let skipped = 0
  let lines = 0
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    lines += 1
    try {
      out.push(JSON.parse(t))
    } catch {
      skipped += 1
    }
  }
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : Infinity
  const sliced = Number.isFinite(limit) ? out.slice(Math.max(0, out.length - limit)) : out
  return { records: sliced, skipped, lines, reason: lines === 0 ? 'BANK_EMPTY' : '' }
}
