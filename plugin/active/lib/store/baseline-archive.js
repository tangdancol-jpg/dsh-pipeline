// 改动基线 · 溢出归档（P2-13 第三步）：`task.baselines` 只留最近 2 份，更早的按序 gzip 进 `archive/baselines-<seq>.jsonl.gz`（不删数据、可回查）。
/**
 * dsh-pipeline · 任务存储 · **baseline 溢出归档**（P2-13 残余）
 * ============================================================================
 * 现场：`task.baselines[]` 每份都带**逐文件清单**（长单几千个文件 × 每个一条
 * `{sha256,bytes}`），而它**只增不减** —— 长单里 `task.json` 的体积大头就是它
 * （与 history 同源的那个病）。P2-13 第二步已经把 `history` 收到 500 条窗口；
 * 这一步收 `baselines`。
 *
 * 口径（Lead 拍板）：
 *   · `WINDOW = 2`  —— `task.json` 里**只保留最近 2 份** baseline；
 *   · 更早的按序写进 `<任务目录>/archive/baselines-<seq>.jsonl.gz`
 *     （逐条 JSON、**保序**、gzip；每行 `{archived_at, task_id, seq, baseline}`）；
 *   · **不删数据**：原件只从 `task.json` 的窗口移出，归档文件就是真相；
 *     `baseline-<id>.json` 单文件也**原样留着**（不删、不搬）；
 *   · **归档失败 ⇒ 不裁剪**（宁可不缩、不许丢），由调用方记 `last_error` + 审计
 *     `baseline:archive_failed`；
 *   · 不碰 `audit.jsonl` / handoffs / artifacts / history。
 *
 * ---------------------------------------------------------------------------
 * 为什么要"按 id 回查"（{@link readArchivedBaseline}）
 * ---------------------------------------------------------------------------
 * 归档把记录从窗口里移走，但**历史证据不会因此消失**：`audit.jsonl` 的
 * `baseline:take`、`task.hash_gate_checks[].baseline_id`、各次 `gate:hash` 都还
 * 引着旧 baseline id。任何"按 id 读旧基线"的判据（hash gate 复核 / 审计追溯）
 * 都必须能**先窗口、再归档**地找到它 —— 否则一次正常归档就会被误判成"基线缺失"。
 * 所以本模块提供 {@link readArchivedBaseline}，store 侧提供 `baselineById()`
 * （窗口优先、归档兜底，返回 `source:'window'|'archive'`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么"一次溢出 = 一个新文件"（与 history 归档同一形状）
 * ---------------------------------------------------------------------------
 * 写入用**临时文件 → rename**：rename 之前出错 ⇒ 目标文件根本不存在、内存**不裁剪**，
 * 不存在"写了一半又裁了/裁了却没写全"的中间态。多个文件按 seq 顺序拼起来就是
 * **完整的归档序列**（`task.baseline_archive.files[]` 按同一顺序登记）。
 *
 * ⚠️ 诚实的边界（与 history 归档同源）：进程若在 "归档文件已 rename、task.json
 *   还没写" 之间被杀，下一次归档会把同一批再写一份（重复但**不丢**、可按 id 去重）。
 *   调用方（`takeBaseline`）在 task.json 写失败时会把这个新归档文件删掉，把窗口压到最小。
 *
 * @module dsh-pipeline/lib/store/baseline-archive
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { nowIso } from '../util.js'

/** `task.json` 里保留的 baseline 窗口（份）。Lead 拍板：2。 */
export const BASELINE_ARCHIVE_WINDOW = 2
/** 归档子目录名（与 history 归档同一个 `archive/`，文件名前缀区分）。 */
export const BASELINE_ARCHIVE_DIR = 'archive'
/** 归档文件名形状：`baselines-0001.jsonl.gz`。 */
const BASELINE_FILE_RE = /^baselines-(\d+)\.jsonl\.gz$/

/** 4 位补零的 seq（文件按名字排序 = 按时间排序）。 */
function padSeq(n) {
  return String(n).padStart(4, '0')
}

/**
 * 扫归档目录，返回已有的 baseline 归档文件（按 seq 升序）与统计。
 *
 * @param {string} taskDir
 * @returns {{dir:string, files:{seq:number, name:string, path:string}[], maxSeq:number}}
 */
export function listBaselineArchiveFiles(taskDir) {
  const dir = join(String(taskDir ?? ''), BASELINE_ARCHIVE_DIR)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { dir, files: [], maxSeq: 0 }
  }
  const files = names
    .map((name) => {
      const m = BASELINE_FILE_RE.exec(name)
      return m === null ? null : { seq: Number(m[1]), name, path: join(dir, name) }
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.seq - b.seq)
  return { dir, files, maxSeq: files.length === 0 ? 0 : files[files.length - 1].seq }
}

/** 一个归档 gz 里有多少条 baseline（只在没有元数据、需要续上编号时用）。 */
function countBaselineLines(absFile) {
  try {
    const text = gunzipSync(readFileSync(absFile)).toString('utf8')
    if (text.length === 0) return 0
    const lines = text.split('\n')
    return text.endsWith('\n') ? lines.length - 1 : lines.length
  } catch {
    return 0
  }
}

/** 一条 baseline 的时间戳（用于 from/to 可追溯；没有就 null）。 */
function takenAtOf(rec) {
  const v = rec?.taken_at ?? null
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * ★★ **baseline 溢出归档**（P2-13 残余的**唯一实现**）。
 *
 * 只在 `task.baselines.length > WINDOW` 时动作：把窗口之外的**最老**那几份
 * （**永远保留当前基线** `baseline_current`）按原顺序写成一个**新的**
 * `archive/baselines-<seq>.jsonl.gz`，**写成功之后**才从 `task.baselines` 移出并更新
 * `task.baseline_archive`。**写入失败 ⇒ 一个字都不裁剪**。
 *
 * @param {object} task - 已被调用方拿到的任务对象（本函数会就地改 `baselines` / `baseline_archive`）
 * @param {{taskDir:string, now?:()=>Date, window?:number}} ctx
 * @returns {{ok:true, skipped:boolean, archived:number, remaining:number, seq?:number, file?:string,
 *            abs_file?:string, archived_total?:number, reason?:string}
 *          |{ok:false, code:string, note:string, archived:0, remaining:number}}
 */
export function archiveBaselinesOverflow(task, ctx = {}) {
  const baselines = Array.isArray(task?.baselines) ? task.baselines : null
  if (baselines === null) {
    return { ok: true, skipped: true, archived: 0, remaining: 0, reason: 'no-baselines' }
  }
  const windowSize = Number.isInteger(ctx.window) && ctx.window > 0 ? ctx.window : BASELINE_ARCHIVE_WINDOW
  const len = baselines.length
  if (len <= windowSize) {
    return { ok: true, skipped: true, archived: 0, remaining: len, reason: 'below-window' }
  }
  const taskDir = typeof ctx.taskDir === 'string' ? ctx.taskDir : ''
  if (taskDir.length === 0) {
    return { ok: false, code: 'BASELINE_ARCHIVE_DIR_MISSING', note: '任务目录未知 —— 按口径**不裁剪**（宁可不缩、不许丢）。', archived: 0, remaining: len }
  }

  /**
   * 保留集 = 最近 `windowSize` 份 + **当前基线**（防御：万一 `baseline_current` 指向
   * 窗口之外的旧基线——例如外部改过 task.json——也绝不把"当前基线"归档掉）。
   */
  const keepIds = new Set(baselines.slice(Math.max(0, len - windowSize)).map((b) => String(b?.baseline_id ?? '')).filter((x) => x.length > 0))
  const cur = typeof task?.baseline_current === 'string' && task.baseline_current.length > 0 ? task.baseline_current : null
  if (cur !== null) keepIds.add(cur)
  const overflow = baselines.filter((b) => !keepIds.has(String(b?.baseline_id ?? '')))
  if (overflow.length === 0) {
    return { ok: true, skipped: true, archived: 0, remaining: len, reason: 'nothing-outside-window' }
  }

  const at = nowIso(typeof ctx.now === 'function' ? ctx.now() : new Date())
  const existing = listBaselineArchiveFiles(taskDir)
  const seq = existing.maxSeq + 1
  const fileName = `baselines-${padSeq(seq)}.jsonl.gz`
  const dir = existing.dir
  const absFile = join(dir, fileName)
  const tmpFile = `${absFile}.tmp`

  const prevMeta = task?.baseline_archive !== null && typeof task?.baseline_archive === 'object' && !Array.isArray(task.baseline_archive) ? task.baseline_archive : null
  const prevTotal = Number.isInteger(prevMeta?.archived_total) ? prevMeta.archived_total : null
  /** legacy：任务上没有元数据、但归档目录里已经有文件 ⇒ 按实际条数续上编号（别把 seq 清零）。 */
  const archivedTotalBase = prevTotal !== null ? prevTotal : existing.files.reduce((sum, f) => sum + countBaselineLines(f.path), 0)

  const records = overflow.map((b, i) =>
    JSON.stringify({ archived_at: at, task_id: String(task.id ?? ''), seq: archivedTotalBase + i + 1, baseline: b }),
  )
  let gzBytes = 0
  try {
    mkdirSync(dir, { recursive: true })
    const gz = gzipSync(Buffer.from(`${records.join('\n')}\n`, 'utf8'))
    gzBytes = gz.length
    writeFileSync(tmpFile, gz)
    // ★ 原子出现：rename 之前目标文件不存在；rename 失败 ⇒ catch ⇒ 不裁剪。
    renameSync(tmpFile, absFile)
  } catch (err) {
    try {
      unlinkSync(tmpFile)
    } catch {
      /* 临时文件清不掉也不影响结论 */
    }
    const code = String(err?.code ?? 'BASELINE_ARCHIVE_WRITE_FAILED')
    return {
      ok: false,
      code,
      note:
        `baseline 归档写入失败（${code} ${String(err?.message ?? err)}）—— 按口径**不裁剪**` +
        '（宁可不缩、不许丢；task.json 照旧写未裁剪的 baselines）。\n' +
        `归档目录：${dir}\n归档文件：${fileName}`,
      archived: 0,
      remaining: len,
    }
  }

  // ---- 写成功之后才动内存：移出窗口 + 记元数据 -----------------------------
  const files = Array.isArray(prevMeta?.files) ? [...prevMeta.files] : []
  files.push({
    file: `${BASELINE_ARCHIVE_DIR}/${fileName}`,
    count: overflow.length,
    seq,
    bytes: gzBytes,
    from_id: overflow[0]?.baseline_id ?? null,
    to_id: overflow[overflow.length - 1]?.baseline_id ?? null,
    from_taken_at: takenAtOf(overflow[0]),
    to_taken_at: takenAtOf(overflow[overflow.length - 1]),
  })
  task.baselines = baselines.filter((b) => keepIds.has(String(b?.baseline_id ?? '')))
  task.baseline_archive = {
    files,
    archived_total: archivedTotalBase + overflow.length,
    window: windowSize,
    last_at: at,
  }
  return {
    ok: true,
    skipped: false,
    archived: overflow.length,
    remaining: task.baselines.length,
    seq,
    file: `${BASELINE_ARCHIVE_DIR}/${fileName}`,
    abs_file: absFile,
    archived_total: task.baseline_archive.archived_total,
  }
}

/**
 * ★★ **按 id 回查归档里的基线**（窗口之外的那些）—— hash gate 复核 / 审计追溯用。
 *
 * 按归档文件的 seq 升序扫、逐行解析，命中 `baseline.baseline_id === id` 即返回。
 * 坏 gz / 坏行**跳过并计数**（不半信半疑地用一个解析失败的记录）。
 *
 * @param {string} taskDir - 任务目录
 * @param {string} baselineId - 要回查的 `BL-…` id
 * @returns {{ok:true, baseline:object, file:string, abs_file:string, seq:number,
 *            line_seq:number|null, archived_at:string|null, scanned:number, damaged:number}
 *          |{ok:false, code:string, note:string, scanned:number, damaged:number}}
 */
export function readArchivedBaseline(taskDir, baselineId) {
  const id = String(baselineId ?? '').trim()
  if (id.length === 0) {
    return { ok: false, code: 'BASELINE_ID_EMPTY', note: '没有给 baseline id —— 无法回查。', scanned: 0, damaged: 0 }
  }
  const existing = listBaselineArchiveFiles(taskDir)
  let damaged = 0
  for (const f of existing.files) {
    let text = ''
    try {
      text = gunzipSync(readFileSync(f.path)).toString('utf8')
    } catch {
      damaged += 1
      continue
    }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (s.length === 0) continue
      let rec = null
      try {
        rec = JSON.parse(s)
      } catch {
        damaged += 1
        continue
      }
      const b = rec?.baseline
      if (b !== null && typeof b === 'object' && !Array.isArray(b) && String(b.baseline_id ?? '') === id) {
        return {
          ok: true,
          baseline: b,
          file: `${BASELINE_ARCHIVE_DIR}/${f.name}`,
          abs_file: f.path,
          seq: f.seq,
          line_seq: Number.isInteger(rec?.seq) ? rec.seq : null,
          archived_at: typeof rec?.archived_at === 'string' ? rec.archived_at : null,
          scanned: existing.files.length,
          damaged,
        }
      }
    }
  }
  return {
    ok: false,
    code: 'BASELINE_NOT_FOUND_IN_ARCHIVE',
    note:
      `归档里没有 baseline「${id}」（扫了 ${existing.files.length} 个归档文件` +
      `${damaged > 0 ? `，其中 ${damaged} 处坏行/坏文件已跳过` : ''}）。\n` +
      '★ 归档**不删数据**：查不到说明这条 id 从来不属于本任务，或归档目录被外部动过。',
    scanned: existing.files.length,
    damaged,
  }
}
