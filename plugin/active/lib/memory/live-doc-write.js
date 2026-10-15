// 活文档的**唯一写点**：由状态迁移 / 关单触发 + 读时惰性兜底；**幂等**（同内容不重写）、绝不抛。
/**
 * dsh-pipeline · 记忆 · 活文档写盘（唯一写点）
 * ============================================================================
 * 设计 `06-分阶段.md` 的 E3 把"谁触发更新"**固化**在这一层：
 *
 *   · **触发点 = 关单（`lib/store/review.js` 的 close）+ 状态迁移
 *     （`lib/store/lifecycle.js` 的 transition 出口）+ 读时惰性兜底
 *     （`pipeline_recall` 发现库比活文档新 ⇒ 先重建）**；
 *   · **不是** `tools/post-execute`：那会退化成"每调用一次重算一次"，
 *     而"关单才是语义上完整的时刻"（设计 `04-§3` 的原话）。
 *
 * ---------------------------------------------------------------------------
 * 三条硬判据
 * ---------------------------------------------------------------------------
 *   · **R11 幂等**：渲染结果与盘上那份**逐字节相同** ⇒ **不写**（mtime 不变）。
 *     "重写一份一样的内容"不算幂等 —— 它会让"活文档多久更新一次"变得不可观测。
 *   · **R12/R13 off ⇒ 一个字节都不许改**：总开关关掉时本函数**直接返回**，
 *     连读都不读（`SWITCH_SURFACES` 的 `memory-live-doc` 那一行就是它）。
 *   · **绝不抛**：它是状态迁移 / 关单路径上的副作用 —— 写失败只 `warn`，
 *     被包裹的那次 `pipeline_close` / `pipeline_transition` 照旧返回原结果。
 *
 * ★ 空库**不建文件**：库不存在 ⇒ 不建 `_memory/`（"库是长出来的，不是建出来的"，
 *   与 `load.js` 的边界一致）；库为空 ⇒ 也不写空壳（渲染器支持空输入，写不写由这里定）。
 *
 * @module dsh-pipeline/lib/memory/live-doc-write
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { surfaceAllowed } from '../switch/gate.js'
import { liveDocFile, memoryFile } from './bank.js'
import { readBank } from './load.js'
import { renderLiveDoc } from './live-doc-render.js'

/**
 * 本写点在 `SWITCH_SURFACES` 里的 id（**一处定义** —— 表里那一行与本文件都引它）。
 */
export const LIVE_DOC_SURFACE = 'memory-live-doc'

/**
 * ★ 「这一条面现在该不该动手？」—— 判据在 `lib/switch/gate.js`（`surfaceAllowed`），
 * 本函数只是把它与本面的 id 绑在一起（免得每个调用点各写一次 id）。
 *
 * 为什么是**函数**（`swOf`）而不是开关对象：`index.js` 里 `sw` 建在 `createTaskStore`
 * **之后**（`:235` vs `:174`），store 只能拿到一个闭包。这不是权宜之计：判据仍然
 * 只有 `lib/switch/gate.js` 一处（本文件不写 `sw.isOn()`）。
 *
 * @param {(()=>object|null)|object|null} [swOf]
 * @returns {boolean}
 */
export function liveDocAllowed(swOf) {
  return surfaceAllowed(swOf ?? null, LIVE_DOC_SURFACE)
}

/**
 * ★★ **重建活文档**（幂等；绝不抛）。
 *
 * @param {string} projectDir - 项目目录（空串 ⇒ 直接返回 `NO_PROJECT_DIR`，**不猜落点**）
 * @param {object} [opts]
 * @param {object[]} [opts.records] - 已经读好的记忆（省一次读盘；不给就自己读）
 * @param {object|null} [opts.outline] - 会话投影（`reflect-source` 的产物；可缺）
 * @param {string} [opts.outlineNote]
 * @param {{readFile:Function, writeFile:Function, mkdir:Function, stat:Function}} [opts.fs] - 文件系统缝
 * @param {(m:string)=>void} [opts.warn]
 * @returns {Promise<{ok:boolean, changed:boolean, written:boolean, reason:string,
 *            path:string, bytes:number, records:number, skipped:number}>}
 */
export async function refreshLiveDoc(projectDir, opts = {}) {
  const fs = { readFile, writeFile, mkdir, stat, ...(opts.fs ?? {}) }
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const out = { ok: false, changed: false, written: false, reason: '', path: '', bytes: 0, records: 0, skipped: 0 }
  const file = liveDocFile(projectDir)
  out.path = file
  if (file.length === 0) return { ...out, reason: 'NO_PROJECT_DIR' }

  try {
    let records = Array.isArray(opts.records) ? opts.records : null
    let skipped = 0
    if (records === null) {
      // ★ 库文件落点由 `bank.js` 一处给出（别处不许再拼一次 `_memory/memory.jsonl`）。
      const bank = await readBank(memoryFile(projectDir), { fs })
      records = bank.records
      skipped = bank.skipped
    }
    out.records = records.length
    out.skipped = skipped
    // ★ 空库 ⇒ 不写空壳（也**不建目录**）。
    if (records.length === 0) return { ...out, ok: true, reason: 'EMPTY_BANK' }

    const text = renderLiveDoc(records, { outline: opts.outline ?? null, outlineNote: opts.outlineNote ?? '', skipped })
    let existing = null
    try {
      existing = await fs.readFile(file, 'utf8')
    } catch {
      existing = null // 不存在（或读不动）⇒ 当"要写"
    }
    if (existing === text) return { ...out, ok: true, reason: 'UNCHANGED', bytes: Buffer.byteLength(text, 'utf8') }

    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
    return { ...out, ok: true, changed: true, written: true, reason: 'REBUILT', bytes: Buffer.byteLength(text, 'utf8') }
  } catch (err) {
    // ★★ 绝不抛：这是状态迁移 / 关单路径上的副作用（判据 R3 的同一条纪律）。
    try {
      warn(`[pipeline] 活文档重建失败（不影响触发它的那次调用）：${String(err?.message ?? err)}`)
    } catch {
      /* warn 坏了也不许抛 */
    }
    return { ...out, reason: `FAILED: ${String(err?.message ?? err)}` }
  }
}

/**
 * ★ **状态迁移 / 关单那一侧的唯一入口**：过总开关 + 解析项目目录 + 重建。
 *
 * @param {object} task - 迁移**之后**的任务对象（读 `project_dir`）
 * @param {object} [opts]
 * @param {(()=>object|null)|object|null} [opts.swOf] - 晚绑定的开关（见 {@link liveDocAllowed}）
 * @param {string} [opts.projectDir] - `task.project_dir` 取不到时的兜底（通常是装配时的项目根）
 * @returns {Promise<object>} 同 {@link refreshLiveDoc}
 */
export async function refreshLiveDocForTask(task, opts = {}) {
  try {
    // ★★ off ⇒ 连读都不读（"关 = 彻底摘干净"）。
    if (!liveDocAllowed(opts.swOf ?? null)) {
      return { ok: false, changed: false, written: false, reason: 'SWITCH_OFF', path: '', bytes: 0, records: 0, skipped: 0 }
    }
    const bound = String(task?.project_dir ?? '').trim()
    const dir = bound.length > 0 ? bound : String(opts.projectDir ?? '').trim()
    return await refreshLiveDoc(dir, opts)
  } catch (err) {
    return {
      ok: false,
      changed: false,
      written: false,
      reason: `FAILED: ${String(err?.message ?? err)}`,
      path: '',
      bytes: 0,
      records: 0,
      skipped: 0,
    }
  }
}

/**
 * ★ **读时惰性兜底**（设计 `04-§3.5`）：库比活文档新 ⇒ 先重建再返回。
 *
 * 判据（写死在这里）：
 *   · 库为空 ⇒ `EMPTY_BANK`，**一个字节都不动**；
 *   · 活文档不存在 ⇒ 重建（**只有库非空时才走到这**，所以不会凭空造出 `_memory/`）；
 *   · 活文档比库**新或同刻** ⇒ `FRESH`，跳过（省一次渲染 + 一次写）。
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @returns {Promise<object>} 同 {@link refreshLiveDoc}（多一个 `reason:'FRESH'`）
 */
export async function ensureLiveDoc(projectDir, opts = {}) {
  const fs = { readFile, writeFile, mkdir, stat, ...(opts.fs ?? {}) }
  const out = { ok: false, changed: false, written: false, reason: '', path: '', bytes: 0, records: 0, skipped: 0 }
  const file = liveDocFile(projectDir)
  if (file.length === 0) return { ...out, reason: 'NO_PROJECT_DIR' }
  if (!liveDocAllowed(opts.swOf ?? null)) return { ...out, reason: 'SWITCH_OFF' }

  try {
    const records = Array.isArray(opts.records) ? opts.records : null
    if (records !== null && records.length === 0) return { ...out, ok: true, reason: 'EMPTY_BANK' }
    const bankFile = String(opts.bankFile ?? memoryFile(projectDir))
    let bankMs = -Infinity
    try {
      bankMs = (await fs.stat(bankFile)).mtimeMs
    } catch {
      bankMs = -Infinity
    }
    let docMs = -Infinity
    try {
      docMs = (await fs.stat(file)).mtimeMs
    } catch {
      docMs = -Infinity
    }
    if (bankMs !== -Infinity && docMs !== -Infinity && docMs >= bankMs) {
      return { ...out, ok: true, reason: 'FRESH', path: file }
    }
    return await refreshLiveDoc(projectDir, { ...opts, records: records ?? undefined })
  } catch (err) {
    return { ...out, reason: `FAILED: ${String(err?.message ?? err)}` }
  }
}
