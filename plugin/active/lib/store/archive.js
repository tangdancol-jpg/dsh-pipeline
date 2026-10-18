/**
 * dsh-pipeline · 任务存储 · history 溢出归档（P2-13 第二步）
 * ============================================================================
 * 现场：长单的 `task.json` 到 MB 级，其中 `task.history[]` 是**只增不减**的一坨
 * （每次 transition / 交接物 / 审计都 push 一条）。P2-13 第二步的口径（Lead 拍板）：
 *
 *   · `N = 500`   —— `task.json` 里**保留最近 500 条** history；
 *   · `HIGH = 700`—— **滞回**：超过 700 才触发归档（避免每步都搬，也避免"500 刚过就搬"）；
 *   · **不删任何历史数据**：把最老的那些**原样**（逐条 JSON、保序）追加进
 *     `.pipeline/<taskId>/archive/history-<seq>.jsonl`，再从 `task.json` 的窗口里移出；
 *   · **写失败 ⇒ 不裁剪**（宁可不缩、不许丢），并把失败记进 `audit.jsonl`（`archive:failed`）；
 *   · 不碰 `audit.jsonl`（全量保留）、不碰 `handoffs` / `baselines` / `artifacts`。
 *
 * ---------------------------------------------------------------------------
 * 为什么"一次溢出 = 一个新文件"
 * ---------------------------------------------------------------------------
 * 每次触发写 `history-<seq>.jsonl`（seq 递增、按 4 位补零好排序），用
 * **写临时文件 → rename** 落成 —— rename 之前出错 ⇒ 目标文件根本不存在、内存**不裁剪**，
 * 不存在"写了一半又不裁/裁了却没写全"的中间态。多个文件按 seq 顺序拼起来就是
 * **完整的归档序列**（`task.history_archive.files[]` 也按同一顺序登记）。
 *
 * ⚠️ 诚实的边界：进程若在 "归档文件已 rename、task.json 还没写" 之间被杀，
 *   下一次 persist 会看到**还是旧窗口**的 history ⇒ 同一批会被再归档一次（重复但**不丢**）。
 *   这个窗口在 `persist()` 里被压到最小（归档紧贴写盘），但单进程模型下无法彻底消除；
 *   宁可重复（可去重）也不丢。
 *
 * @module dsh-pipeline/lib/store/archive
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from '../util.js'

/** task.json 里保留的 history 窗口（条）。 */
export const HISTORY_ARCHIVE_WINDOW = 500
/** 滞回阈值：history 超过这个数才触发归档（避免每步都搬）。 */
export const HISTORY_ARCHIVE_HIGH = 700
/** 归档子目录名（相对任务目录）。 */
export const HISTORY_ARCHIVE_DIR = 'archive'

/** 归档文件名形状：`history-0001.jsonl`。 */
const ARCHIVE_FILE_RE = /^history-(\d+)\.jsonl$/

/** 4 位补零的 seq（文件按名字排序 = 按时间排序）。 */
function padSeq(n) {
  return String(n).padStart(4, '0')
}

/** 取一条 history 的时间戳（用于 `from_iso` / `to_iso`；没有就 null）。 */
function atOf(entry) {
  const v = entry?.at ?? entry?.created_at ?? entry?.at_iso ?? null
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * 扫归档目录，返回已有的归档文件（按 seq 升序）与统计。
 *
 * @param {string} taskDir
 * @returns {{dir:string, files:{seq:number, name:string, path:string}[], maxSeq:number, linesTotal:number|null}}
 */
export function listArchiveFiles(taskDir) {
  const dir = join(String(taskDir ?? ''), HISTORY_ARCHIVE_DIR)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { dir, files: [], maxSeq: 0, linesTotal: 0 }
  }
  const files = names
    .map((name) => {
      const m = ARCHIVE_FILE_RE.exec(name)
      return m === null ? null : { seq: Number(m[1]), name, path: join(dir, name) }
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.seq - b.seq)
  return { dir, files, maxSeq: files.length === 0 ? 0 : files[files.length - 1].seq, linesTotal: null }
}

/** 数一个 JSONL 文件的行数（归档文件不大；只在 metadata 缺失时用）。 */
function countJsonlLines(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8')
    if (text.length === 0) return 0
    const lines = text.split('\n')
    return text.endsWith('\n') ? lines.length - 1 : lines.length
  } catch {
    return 0
  }
}

/**
 * ★★ **history 溢出归档**（P2-13 第二步的**唯一实现**）。
 *
 * 只在 `task.history.length > HIGH` 时动作：把最老的 `len - WINDOW` 条写成**一个新的**
 * `archive/history-<seq>.jsonl`（逐条 JSON、保序），成功后才从 `task.history` 移出这些条
 * 并更新 `task.history_archive`。**写入失败 ⇒ 一个字都不裁剪**。
 *
 * @param {object} task - 已被调用方拿到的任务对象（本函数会就地改 `history` / `history_archive`）
 * @param {{taskDir:string, now?:()=>Date, window?:number, high?:number}} ctx
 * @returns {{ok:true, skipped:boolean, archived:number, remaining:number, seq?:number, file?:string,
 *            abs_file?:string, archived_total?:number, reason?:string}
 *          |{ok:false, code:string, note:string, archived:0, remaining:number}}
 */
export function archiveHistoryOverflow(task, ctx = {}) {
  const history = Array.isArray(task?.history) ? task.history : null
  if (history === null) {
    return { ok: true, skipped: true, archived: 0, remaining: 0, reason: 'no-history' }
  }
  const high = Number.isInteger(ctx.high) && ctx.high > 0 ? ctx.high : HISTORY_ARCHIVE_HIGH
  const windowSize = Number.isInteger(ctx.window) && ctx.window > 0 ? ctx.window : HISTORY_ARCHIVE_WINDOW
  const len = history.length
  if (len <= high) {
    return { ok: true, skipped: true, archived: 0, remaining: len, reason: 'below-high' }
  }

  const taskDir = typeof ctx.taskDir === 'string' ? ctx.taskDir : ''
  if (taskDir.length === 0) {
    return { ok: false, code: 'ARCHIVE_DIR_MISSING', note: '任务目录未知 —— 按口径**不裁剪**（宁可不缩、不许丢）。', archived: 0, remaining: len }
  }

  const overflowCount = len - windowSize
  const overflow = history.slice(0, overflowCount)
  const at = nowIso(typeof ctx.now === 'function' ? ctx.now() : new Date())
  const existing = listArchiveFiles(taskDir)
  const seq = existing.maxSeq + 1
  const fileName = `history-${padSeq(seq)}.jsonl`
  const dir = existing.dir
  const absFile = join(dir, fileName)
  const tmpFile = `${absFile}.tmp`

  const prevMeta = task?.history_archive !== null && typeof task?.history_archive === 'object' && !Array.isArray(task.history_archive) ? task.history_archive : null
  const prevTotal = Number.isInteger(prevMeta?.archived_total) ? prevMeta.archived_total : null
  /** legacy：任务上没有元数据，但归档目录里已经有文件 ⇒ 按实际行数续上 archived_total（别把编号清零）。 */
  const archivedTotalBase =
    prevTotal !== null
      ? prevTotal
      : existing.files.reduce((sum, f) => sum + countJsonlLines(f.path), 0)

  const lines = overflow.map((entry, i) =>
    JSON.stringify({ archived_at: at, task_id: String(task.id ?? ''), seq: archivedTotalBase + i + 1, entry }),
  )

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmpFile, `${lines.join('\n')}\n`, 'utf8')
    // ★ 原子出现：rename 之前目标文件不存在；rename 失败 ⇒ catch ⇒ 不裁剪。
    renameSync(tmpFile, absFile)
  } catch (err) {
    try {
      unlinkSync(tmpFile)
    } catch {
      /* 临时文件清不掉也不影响结论 */
    }
    const code = String(err?.code ?? 'ARCHIVE_WRITE_FAILED')
    return {
      ok: false,
      code,
      note:
        `history 归档写入失败（${code} ${String(err?.message ?? err)}）—— 按口径**不裁剪**` +
        '（宁可不缩、不许丢；task.json 照旧写未裁剪的 history）。\n' +
        `归档目录：${dir}\n归档文件：${fileName}`,
      archived: 0,
      remaining: len,
    }
  }

  // ---- 写成功之后才动内存：移出窗口 + 记元数据 -----------------------------
  const files = Array.isArray(prevMeta?.files) ? [...prevMeta.files] : []
  files.push({
    file: `${HISTORY_ARCHIVE_DIR}/${fileName}`,
    count: overflow.length,
    seq,
    from_iso: atOf(overflow[0]),
    to_iso: atOf(overflow[overflow.length - 1]),
  })
  task.history = history.slice(len - windowSize)
  task.history_archive = {
    files,
    archived_total: archivedTotalBase + overflow.length,
    window: windowSize,
    last_at: at,
  }
  return {
    ok: true,
    skipped: false,
    archived: overflow.length,
    remaining: task.history.length,
    seq,
    file: `${HISTORY_ARCHIVE_DIR}/${fileName}`,
    abs_file: absFile,
    archived_total: task.history_archive.archived_total,
  }
}

/**
 * 丢弃一个刚写出的归档文件（**persist 写 task.json 失败时回滚用**）。
 *
 * 为什么需要：归档先写、task.json 后写；后者失败时内存会回滚到"未归档"的快照，
 * 若归档文件留着，下一次 persist 会再归档同一批 ⇒ 磁盘上多一份重复。删掉它，
 * 内存与盘上就一致了（数据还在内存里，没有丢）。
 *
 * @param {string} absFile
 * @returns {boolean} 是否真的删了
 */
export function discardArchivedFile(absFile) {
  if (typeof absFile !== 'string' || absFile.length === 0) return false
  try {
    if (!existsSync(absFile)) return false
    unlinkSync(absFile)
    return true
  } catch {
    return false
  }
}
