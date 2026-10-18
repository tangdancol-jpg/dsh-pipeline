// P2-13 残余：baseline 只留最近 2 份，更早的按序 gzip 归档（不删数据、可按 id 回查、失败不裁剪）。
/**
 * dsh-pipeline · F37：改动基线溢出归档（P2-13 残余）
 * ============================================================================
 *     node tests/f37-baseline-archive-check.mjs
 *
 * 现场：`task.baselines[]` 每份都带**逐文件清单**（长单几千个文件），而且只增不减
 * —— 长单 `task.json` 的体积大头之一。P2-13 第二步已把 `history` 收到 500 条窗口；
 * 这一步收 `baselines`。口径（Lead 拍板）：
 *
 *   · `task.json` 里**只保留最近 2 份** baseline（`BASELINE_ARCHIVE_WINDOW`）；
 *   · 更早的按序写进 `<任务目录>/archive/baselines-<seq>.jsonl.gz`
 *     （逐条 JSON、**保序**、gzip；每行 `{archived_at, task_id, seq, baseline}`）；
 *   · **不删数据**：`baseline-<id>.json` 单文件也原样留着；归档可按 id 回查；
 *   · **归档失败 ⇒ 不裁剪**（宁可不缩、不许丢）+ `task.baseline_archive.last_error`
 *     + `audit:baseline:archive_failed`。
 *
 * 本套钉住：
 *   A 窗口/归档：N 次取基线 → task.json 只剩 2 份；更早的进 gz（zlib 魔数、逐条保序、零丢失）；
 *   B 反复溢出：一次溢出一个新 gz 文件；id **不撞车**（同一份清单反复取，序号仍单调 → 归档后不重号）；
 *   C **按 id 回查**：归档里的旧基线 `baselineById` 读得到（source:'archive'）；
 *     `changeAudit` 遇到"当前基线只在归档里"也**不判基线缺失**（source:'archive' 照算）；
 *   D 失败注入：归档目录不可写 ⇒ **不裁剪** + 可见失败；恢复后继续归档且零丢失；
 *   E `pipeline_status`：storage 一行带 baseline 归档摘要 + 结构化 `baseline_archive`。
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'
import { BASELINE_ARCHIVE_WINDOW, listBaselineArchiveFiles } from '../lib/store/baseline-archive.js'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · F37：改动基线溢出归档（P2-13 残余）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(...it.detail.split('\n').map((l) => `      ${l}`))
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v))
const linesOf = (text) => text.split('\n').filter((l) => l.trim().length > 0)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 从归档 gz（按 seq 升序）+ 当前窗口拼回完整 baseline id 序列。 */
function reconstructBaselineIds(taskDir, task) {
  const out = []
  for (const f of listBaselineArchiveFiles(taskDir).files) {
    const text = gunzipSync(readFileSync(f.path)).toString('utf8')
    for (const line of linesOf(text)) {
      const rec = JSON.parse(line)
      out.push(String(rec?.baseline?.baseline_id ?? ''))
    }
  }
  out.push(...(Array.isArray(task?.baselines) ? task.baselines : []).map((b) => String(b.baseline_id ?? '')))
  return out
}

/** 建一个带基线的小夹具，并装好"记住每份基线/快照"的帮助器。 */
async function fixtureWithTracker(stopAfter = 5) {
  const f = await createGuardFixture({ stopAfter })
  const taskId = f.taskId
  const store = f.h.store
  const taskDir = store.workspaceOf(taskId)
  /** 按创建顺序的 baseline id（历史全量，含已归档）。 */
  const created = []
  /** id → 记录深拷贝（用来验证归档内容原样、不丢字段）。 */
  const snapshots = new Map()
  const remember = () => {
    for (const b of store.peek(taskId).baselines ?? []) {
      const id = String(b?.baseline_id ?? '')
      if (id.length === 0 || snapshots.has(id)) continue
      snapshots.set(id, clone(b))
      created.push(id)
    }
  }
  remember()
  const take = async (note) => {
    const r = await store.takeBaseline({ taskId, by: 'planner', note })
    if (r.ok !== true) throw new Error(`takeBaseline 失败：${r.error}`)
    remember()
    return r
  }
  return { f, taskId, store, taskDir, created, snapshots, take, remember }
}

export async function runF37BaselineArchiveCheck() {
  const rec = createRecorder()
  const open = []
  try {
    // =====================================================================
    // 0 常量
    // =====================================================================
    {
      const G = '0 窗口常量'
      rec.add(G, '★ 窗口是 Lead 拍板的 2 份（`BASELINE_ARCHIVE_WINDOW`）', BASELINE_ARCHIVE_WINDOW === 2, String(BASELINE_ARCHIVE_WINDOW))
      rec.add(G, '★ `listBaselineArchiveFiles` 对不存在的目录返回空（不抛）', (() => { const r = listBaselineArchiveFiles(join(process.env.TEMP ?? '/tmp', '__no_such_f37__')); return r.files.length === 0 && r.maxSeq === 0 })(), 'missing dir ⇒ 空')
    }

    // =====================================================================
    // A 窗口 / 归档：3 次重取 → task.json 只剩 2 份，更早的进 gz
    // =====================================================================
    let fx = null
    {
      const G = 'A 窗口 2 份 + 归档零丢失'
      fx = await fixtureWithTracker()
      open.push(fx.f.h)
      const { store, taskId, taskDir, created, snapshots, take } = fx
      rec.add(G, '夹具起点：已有 1 份基线（L0 在角色清单写入后自动记）', created.length === 1, `created=${created.length}`)
      await take('F37 A-1')
      await take('F37 A-2')
      await take('F37 A-3')
      const t = store.peek(taskId)
      const archivedIds = created.slice(0, created.length - BASELINE_ARCHIVE_WINDOW)
      rec.add(
        G,
        '★★ 多次重取之后 `task.baselines` **只剩最近 2 份**（窗口）',
        Array.isArray(t.baselines) && t.baselines.length === BASELINE_ARCHIVE_WINDOW,
        `baselines=${t.baselines?.length} created=${created.length}`,
      )
      rec.add(
        G,
        '★★ 归档账本：`baseline_archive` 记了文件/份数/窗口/first-last id',
        t.baseline_archive?.window === BASELINE_ARCHIVE_WINDOW &&
          t.baseline_archive?.archived_total === archivedIds.length &&
          Array.isArray(t.baseline_archive?.files) &&
          t.baseline_archive.files.length === archivedIds.length &&
          t.baseline_archive.files.every((f) => typeof f.file === 'string' && f.file.startsWith('archive/baselines-') && f.file.endsWith('.jsonl.gz')),
        JSON.stringify(t.baseline_archive ?? null),
      )
      const files = t.baseline_archive?.files ?? []
      rec.add(
        G,
        '★★ 文件名按 seq 递增（`archive/baselines-0001.jsonl.gz` …）且 from_id/to_id 可追溯',
        files.length > 0 &&
          files[0].file === 'archive/baselines-0001.jsonl.gz' &&
          files[0].seq === 1 &&
          files.every((f, i) => f.seq === i + 1) &&
          files[0].from_id === archivedIds[0] &&
          files[files.length - 1].to_id === archivedIds[archivedIds.length - 1],
        JSON.stringify(files.map((f) => ({ file: f.file, seq: f.seq, count: f.count, from: f.from_id, to: f.to_id }))),
      )
      // --- gz 文件本体：zlib 魔数 + 每行形状 + 与快照逐字段一致 -----------------
      const abs0 = join(taskDir, files[0].file)
      const buf = readFileSync(abs0)
      rec.add(G, '★★ 归档文件是**真 gzip**（魔数 1f 8b），不是改后缀的文本', buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b, `bytes=${buf.length}`)
      const archivedLines = linesOf(gunzipSync(buf).toString('utf8')).map((l) => JSON.parse(l))
      rec.add(
        G,
        '★★ 每行形状 `{archived_at, task_id, seq, baseline}`；seq 从 1 连续',
        archivedLines.length > 0 &&
          archivedLines.every((r, i) => typeof r.archived_at === 'string' && r.task_id === taskId && r.seq === i + 1 && r.baseline !== null && typeof r.baseline === 'object'),
        `首行=${JSON.stringify(archivedLines[0]).slice(0, 180)}`,
      )
      const firstArchived = archivedLines[0]?.baseline
      rec.add(
        G,
        '★★ 归档内容是**原样记录**（id / digest / file_count 与取基线时一致）',
        firstArchived?.baseline_id === archivedIds[0] &&
          firstArchived?.digest === snapshots.get(archivedIds[0])?.digest &&
          firstArchived?.file_count === snapshots.get(archivedIds[0])?.file_count,
        JSON.stringify({ id: firstArchived?.baseline_id, digest: firstArchived?.digest?.slice(0, 12) }),
      )
      rec.add(
        G,
        '★★ **不删数据**：每份被归档的 baseline 的 `baseline-<id>.json` 单文件仍在盘上',
        archivedIds.every((id) => existsSync(join(taskDir, `baseline-${id}.json`))),
        archivedIds.map((id) => `baseline-${id}.json`).join(', '),
      )
      rec.add(
        G,
        '★★ **零丢失 + 保序**：归档(gz) ∪ 当前窗口 == 历次取基线的完整序列',
        JSON.stringify(reconstructBaselineIds(taskDir, t)) === JSON.stringify(created),
        `reconstruct=${reconstructBaselineIds(taskDir, t).length} created=${created.length}`,
      )
      const onDisk = readJson(join(taskDir, 'task.json'))
      rec.add(
        G,
        '★★ 盘上 task.json 也只留 2 份（写盘前归档，不是只在内存里缩）',
        Array.isArray(onDisk.baselines) && onDisk.baselines.length === BASELINE_ARCHIVE_WINDOW && onDisk.baseline_archive?.archived_total === archivedIds.length,
        `disk.baselines=${onDisk.baselines?.length} archived_total=${onDisk.baseline_archive?.archived_total}`,
      )
      const takeAud = (await store.auditLog(taskId)).filter((e) => e.action === 'baseline:take')
      rec.add(
        G,
        '★ `baseline:take` 审计里记了这次归档落到哪个文件（没触发归档时为 null）',
        takeAud.some((e) => e.baseline_archive !== null && typeof e.baseline_archive?.file === 'string') && takeAud.length === created.length,
        `take 行=${takeAud.length} 带归档=${takeAud.filter((e) => e.baseline_archive !== null).length}`,
      )
    }

    // =====================================================================
    // B 反复溢出：新 seq 文件；id 不撞车（同一份清单反复取也不重号）
    // =====================================================================
    {
      const G = 'B 二次溢出 + id 不撞车'
      const { store, taskId, taskDir, created, take } = fx
      const filesBefore = (store.peek(taskId).baseline_archive?.files ?? []).length
      await take('F37 B-1')
      await take('F37 B-2')
      const t = store.peek(taskId)
      rec.add(
        G,
        '★★ 继续取基线 ⇒ 新 seq 文件出现、窗口仍 2 份、archived_total 累加',
        t.baselines.length === BASELINE_ARCHIVE_WINDOW &&
          t.baseline_archive.files.length === filesBefore + 2 &&
          t.baseline_archive.archived_total === created.length - BASELINE_ARCHIVE_WINDOW,
        `files=${t.baseline_archive.files.length} total=${t.baseline_archive.archived_total} created=${created.length}`,
      )
      rec.add(
        G,
        '★★ **id 不撞车**：同一份清单反复取基线（digest 相同），归档后序号仍单调 ⇒ 全部 id 唯一',
        new Set(created).size === created.length,
        `created=${created.length} unique=${new Set(created).size}`,
      )
      rec.add(
        G,
        '★★ 跨多个 gz 文件仍**保序 + 零丢失**',
        JSON.stringify(reconstructBaselineIds(taskDir, t)) === JSON.stringify(created),
        `reconstruct=${reconstructBaselineIds(taskDir, t).length} created=${created.length}`,
      )
    }

    // =====================================================================
    // C 按 id 回查归档（hash gate / 审计读旧基线不能判"基线缺失"）
    // =====================================================================
    {
      const G = 'C 按 id 回查归档'
      const { store, taskId, created, snapshots } = fx
      const archivedId = created[0]
      const windowId = created[created.length - 1]
      const hit = await store.baselineById(taskId, archivedId)
      rec.add(
        G,
        '★★ `baselineById(归档里的旧 id)` ⇒ ok，`source:"archive"`，记录原样（digest/file_count 一致）',
        hit.ok === true &&
          hit.source === 'archive' &&
          hit.baseline?.baseline_id === archivedId &&
          hit.baseline?.digest === snapshots.get(archivedId)?.digest &&
          typeof hit.file === 'string' &&
          hit.file.startsWith('archive/baselines-'),
        JSON.stringify({ ok: hit.ok, source: hit.source, file: hit.file, seq: hit.seq, error: hit.error ?? null }),
      )
      const inWin = await store.baselineById(taskId, windowId)
      rec.add(G, '★ 窗口里的 id ⇒ `source:"window"`（窗口优先，不必读 gz）', inWin.ok === true && inWin.source === 'window', JSON.stringify({ source: inWin.source, error: inWin.error ?? null }))
      const missing = await store.baselineById(taskId, 'BL-F37-DOES-NOT-EXIST')
      rec.add(G, '★ 两处都查不到 ⇒ `BASELINE_NOT_FOUND`（如实说不存在，不猜）', missing.ok === false && missing.code === 'BASELINE_NOT_FOUND', String(missing.code ?? ''))
      // --- changeAudit：当前基线只在归档里也不判"基线缺失"（归档兜底） -----------
      {
        const t = store.peek(taskId)
        const savedCur = t.baseline_current
        const savedGate = t.hash_gate
        // 关掉旧闸门判定的自愈（否则读任务时会顺手清一次并落盘，干扰断言）
        t.hash_gate = null
        t.baseline_current = archivedId
        let archAudit = null
        try {
          archAudit = await store.changeAudit({ taskId })
        } finally {
          t.baseline_current = savedCur
          t.hash_gate = savedGate
        }
        rec.add(
          G,
          '★★ **"当前基线只在归档里" ≠ 基线缺失**：changeAudit 归档兜底照算（`baseline.source:"archive"`）',
          archAudit?.ok === true && archAudit?.baseline?.baseline_id === archivedId && archAudit?.baseline?.source === 'archive',
          JSON.stringify({ ok: archAudit?.ok, id: archAudit?.baseline?.baseline_id, source: archAudit?.baseline?.source, error: archAudit?.error ?? null }),
        )
      }
      const curAudit = await store.changeAudit({ taskId })
      rec.add(G, '★ 正常路径不受影响：当前基线在窗口里 ⇒ `source:"window"`', curAudit.ok === true && curAudit.baseline?.source === 'window', JSON.stringify({ source: curAudit.baseline?.source }))
    }

    // =====================================================================
    // D 失败注入：归档目录不可写 ⇒ 不裁剪 + 可见失败；恢复后继续归档
    // =====================================================================
    {
      const G = 'D 归档失败：不裁剪 + 可见失败 + 可恢复'
      const fx2 = await fixtureWithTracker()
      open.push(fx2.f.h)
      const { store, taskId, taskDir, created, take } = fx2
      const archiveDir = join(taskDir, 'archive')
      rec.add(G, '夹具前提：归档目录还不存在（history 归档没触发过）', !existsSync(archiveDir), String(existsSync(archiveDir)))
      // 注入失败：把 `archive` 位置换成同名**文件** ⇒ mkdir 必失败（跨平台）
      writeFileSync(archiveDir, 'blocked', 'utf8')
      await take('F37 D-1')
      await take('F37 D-2')
      await take('F37 D-3')
      const t = store.peek(taskId)
      rec.add(
        G,
        '★★ 归档失败 ⇒ **不裁剪**（task.baselines 一份都没少）',
        Array.isArray(t.baselines) && t.baselines.length === created.length && created.length > BASELINE_ARCHIVE_WINDOW,
        `baselines=${t.baselines?.length} created=${created.length}`,
      )
      rec.add(
        G,
        '★★ 失败可见：`baseline_archive.last_error`（code 非空）+ `audit:baseline:archive_failed`',
        typeof t.baseline_archive?.last_error?.code === 'string' &&
          (await store.auditLog(taskId)).some((e) => e.action === 'baseline:archive_failed' && typeof e.code === 'string'),
        JSON.stringify(t.baseline_archive?.last_error ?? null),
      )
      rec.add(G, '★ 失败时没有写出任何归档文件（不会留下半截）', listBaselineArchiveFiles(taskDir).files.length === 0, `files=${listBaselineArchiveFiles(taskDir).files.length}`)
      rec.add(G, '★ 每次取基线都照旧留了 `baseline:take` 审计（失败只多一条 archive_failed）', (await store.auditLog(taskId)).filter((e) => e.action === 'baseline:take').length === created.length, `takes=${(await store.auditLog(taskId)).filter((e) => e.action === 'baseline:take').length}`)
      // --- 恢复：去掉阻塞文件 ⇒ 下一次取基线把积压的旧基线一次归档 --------
      rmSync(archiveDir, { force: true })
      await take('F37 D-4')
      const t2 = store.peek(taskId)
      rec.add(
        G,
        '★★ 恢复可写后继续归档：窗口回到 2 份、`last_error` 清空、积压的旧基线一次归档',
        t2.baselines.length === BASELINE_ARCHIVE_WINDOW &&
          listBaselineArchiveFiles(taskDir).files.length === 1 &&
          t2.baseline_archive?.last_error === undefined &&
          t2.baseline_archive?.archived_total === created.length - BASELINE_ARCHIVE_WINDOW,
        JSON.stringify({ window: t2.baselines.length, files: listBaselineArchiveFiles(taskDir).files.length, total: t2.baseline_archive?.archived_total, last_error: t2.baseline_archive?.last_error ?? null }),
      )
      rec.add(
        G,
        '★★ 失败 → 恢复全程**零丢失 + 保序**',
        JSON.stringify(reconstructBaselineIds(taskDir, t2)) === JSON.stringify(created),
        `reconstruct=${reconstructBaselineIds(taskDir, t2).length} created=${created.length}`,
      )
    }

    // =====================================================================
    // E pipeline_status：storage 一行摘要 + 结构化 baseline_archive
    // =====================================================================
    {
      const G = 'E status 展示'
      const { f, taskId, store } = fx
      const call = (args) => callTool(f.h, 'pipeline_status', { task_id: taskId, role_token: f.tokens.main, ...args }, f.agents.main)
      const brief = await call({ detail: 'summary' })
      const briefText = String(brief.value?.summary ?? '')
      const storageLines = briefText.split('\n').filter((l) => l.startsWith('存储：'))
      rec.add(
        G,
        '★★ 紧凑档 storage **只有一行**，且带「baseline 归档 N 文件 / M 份（窗口 2）」',
        brief.denied !== true && storageLines.length === 1 && /baseline 归档 \d+ 文件 \/ \d+ 份（窗口 2）/.test(storageLines[0]),
        storageLines.join(' | '),
      )
      rec.add(
        G,
        '★★ 结构化 `baseline_archive` + `baselines_in_window` 与任务一致',
        brief.value?.baseline_archive !== null &&
          Array.isArray(brief.value?.baseline_archive?.files) &&
          brief.value.baseline_archive.window === BASELINE_ARCHIVE_WINDOW &&
          brief.value.baselines_in_window === BASELINE_ARCHIVE_WINDOW,
        JSON.stringify({ files: brief.value?.baseline_archive?.files?.length, total: brief.value?.baseline_archive?.archived_total, win: brief.value?.baselines_in_window }),
      )
      const st = brief.value?.storage ?? {}
      rec.add(
        G,
        '★★ `storage` 里的计数可直接读：窗口 2 份 / 归档文件数 / 已归档份数',
        st.baseline_window_count === BASELINE_ARCHIVE_WINDOW &&
          st.baseline_archive_files === store.peek(taskId).baseline_archive.files.length &&
          st.baseline_archived_total === store.peek(taskId).baseline_archive.archived_total,
        JSON.stringify({ win: st.baseline_window_count, files: st.baseline_archive_files, total: st.baseline_archived_total }),
      )
      const full = await call({})
      const fullText = String(full.value?.summary ?? '')
      rec.add(
        G,
        '★★ 全文档可见 `baseline 归档：…`（文件清单 + 窗口）与 baseline 单文件一样可追溯',
        full.denied !== true && fullText.includes('baseline 归档：') && fullText.includes('archive/baselines-0001.jsonl.gz') && fullText.includes('窗口 2'),
        fullText.split('\n').filter((l) => l.includes('baseline 归档') || l.includes('archive/baselines')).join('\n'),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    for (const h of open) await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

/**
 * 别名（与任务单里的 `runF37` 叫法对齐；主名 `runF37BaselineArchiveCheck` 与其余 F 套一致）。
 */
export const runF37 = runF37BaselineArchiveCheck

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF37BaselineArchiveCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
