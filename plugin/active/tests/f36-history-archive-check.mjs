// P2-13 第二步回归：history 超 500 条归档（**不删数据**；HIGH=700 滞回触发）。
/**
 * dsh-pipeline · F36：history 溢出归档
 * ============================================================================
 *     node tests/f36-history-archive-check.mjs
 *
 * 口径（Lead 拍板）：
 *   · `task.json` 里保留**最近 500 条** `history`（`HISTORY_ARCHIVE_WINDOW`）；
 *   · **超过 700 条才触发**（`HISTORY_ARCHIVE_HIGH`，滞回 —— 避免每步都搬）；
 *   · 最老的那些**原样、逐条、保序**写进 `<任务目录>/archive/history-<seq>.jsonl`
 *     （每行 `{archived_at, task_id, seq, entry}`）；
 *   · **写失败 ⇒ 不裁剪**（宁可不缩、不许丢），并记 `audit:archive:failed`；
 *   · 不碰 `audit.jsonl` 的既有内容 / handoffs / baselines / artifacts。
 *
 * 本套钉住：
 *   A 800 条 → 触发后剩 500、归档文件逐条保序、**零丢失**（archive ∪ history == 原始序列）；
 *   B 二次溢出再归档（新 seq 文件；跨文件仍保序不丢）；
 *   C 归档目录不可写 ⇒ **不裁剪** + `last_error` + `audit:archive:failed`；恢复后能继续归档；
 *   D 成功归档**不往 audit.jsonl 里加行**（除业务动作自己的那一行）；
 *   E `pipeline_status` 的 storage/archive 一行摘要与 full 档 `history_archive`；f35 分页仍正常。
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'
import { HISTORY_ARCHIVE_HIGH, HISTORY_ARCHIVE_WINDOW, listArchiveFiles } from '../lib/store/archive.js'

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
      const L = ['dsh-pipeline · F36：history 溢出归档（P2-13 第二步）', '='.repeat(78)]
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

let seq = 0
/** 一条可辨认的 history 记录（`action` 里带序号，便于逐条对序）。 */
function mkEntry(tag, i) {
  return { at: `2026-10-19T01:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, actor: 'main', action: `${tag}:${i}`, note: `第 ${i} 条` }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const linesOf = (file) => readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.length > 0)

/** 把任务上的 history 换成一个已知序列（内存里；只为精确验证"不丢/保序"）。 */
function resetHistory(h, taskId, tag, count) {
  const t = h.store.peek(taskId)
  t.history = Array.from({ length: count }, (_, i) => mkEntry(tag, i + 1))
  return t
}

/** 从归档文件 + 当前窗口拼回完整序列（按 seq 升序、文件内按行序）。 */
function reconstruct(h, taskId) {
  const t = h.store.peek(taskId)
  const taskDir = h.store.workspaceOf(taskId)
  const arch = t.history_archive ?? null
  const files = Array.isArray(arch?.files) ? arch.files : []
  const out = []
  for (const f of files) {
    const abs = join(taskDir, f.file)
    if (!existsSync(abs)) return { ok: false, note: `归档文件不存在：${f.file}`, entries: out }
    for (const line of linesOf(abs)) {
      const rec = JSON.parse(line)
      out.push(rec.entry)
    }
  }
  out.push(...(Array.isArray(t.history) ? t.history : []))
  return { ok: true, entries: out, files }
}

const sameSequence = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 跑 F36 自测。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
export async function runF36HistoryArchiveCheck() {
  const rec = createRecorder()
  const f = await createGuardFixture({ stopAfter: 5 })
  const taskId = f.taskId
  const store = f.h.store
  const taskDir = store.workspaceOf(taskId)
  const archiveDir = join(taskDir, 'archive')
  try {
    // =====================================================================
    // 0 常量与纯函数
    // =====================================================================
    {
      const G = '0 阈值与文件枚举'
      rec.add(
        G,
        '★ 阈值是 Lead 拍板的 500 / 700（窗口 / 滞回）',
        HISTORY_ARCHIVE_WINDOW === 500 && HISTORY_ARCHIVE_HIGH === 700,
        `WINDOW=${HISTORY_ARCHIVE_WINDOW} HIGH=${HISTORY_ARCHIVE_HIGH}`,
      )
      rec.add(
        G,
        '★ `listArchiveFiles` 对不存在的目录返回空（只在溢出时才扫目录）',
        (() => {
          const r = listArchiveFiles(join(taskDir, '__no_such_dir__'))
          return r.files.length === 0 && r.maxSeq === 0
        })(),
        'missing dir ⇒ 空',
      )
    }

    // =====================================================================
    // A 800 条 → 剩 500；归档逐条保序；零丢失
    // =====================================================================
    let expectedAll = null
    {
      const G = 'A 800 条 → 剩 500 + 零丢失'
      // 夹具自带若干条 history；先换成受控序列：799 条 + 触发用的 recordAudit 1 条 = 800 条
      resetHistory(f.h, taskId, 'A', 799)
      const before = f.h.store.peek(taskId).history.map((e) => e)
      const archiveSeqBefore = listArchiveFiles(taskDir).maxSeq
      const triggered = await store.recordAudit(taskId, 'main', 'fixture:triggerA', { n: 1 })
      const t = f.h.store.peek(taskId)
      expectedAll = [...before, triggered.entry]
      rec.add(
        G,
        '★★ 写盘前归档：800 条触发后 `task.history` 只剩 **500** 条（窗口）',
        triggered.ok === true && t.history.length === HISTORY_ARCHIVE_WINDOW,
        `history=${t.history.length}`,
      )
      rec.add(
        G,
        '★★ 归档文件：恰好一个新文件、名字 `history-0001.jsonl`、条数 300',
        Array.isArray(t.history_archive?.files) &&
          t.history_archive.files.length === 1 &&
          t.history_archive.files[0].file === 'archive/history-0001.jsonl' &&
          t.history_archive.files[0].seq === 1 &&
          t.history_archive.files[0].count === expectedAll.length - HISTORY_ARCHIVE_WINDOW &&
          listArchiveFiles(taskDir).maxSeq === archiveSeqBefore + 1,
        JSON.stringify(t.history_archive?.files ?? null),
      )
      const fileAbs = join(taskDir, t.history_archive.files[0].file)
      const lines = linesOf(fileAbs)
      const records = lines.map((l) => JSON.parse(l))
      rec.add(
        G,
        '★★ 归档文件每行形状 `{archived_at, task_id, seq, entry}`；seq 从 1 连续',
        records.every(
          (r, i) =>
            typeof r.archived_at === 'string' &&
            r.task_id === taskId &&
            r.seq === i + 1 &&
            r.entry !== null &&
            typeof r.entry === 'object',
        ),
        `首行=${JSON.stringify(records[0]).slice(0, 160)}`,
      )
      rec.add(
        G,
        '★★ **零丢失 + 逐条保序**：归档(300) ∪ 当前窗口(500) == 原始 800 条序列',
        (() => {
          const r = reconstruct(f.h, taskId)
          return r.ok === true && r.entries.length === expectedAll.length && sameSequence(r.entries, expectedAll)
        })(),
        (() => {
          const r = reconstruct(f.h, taskId)
          if (r.ok !== true) return r.note
          const firstDiff = r.entries.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(expectedAll[i]))
          return `reconstruct=${r.entries.length} 原始=${expectedAll.length} 首个差异下标=${firstDiff}`
        })(),
      )
      rec.add(
        G,
        '★ 元数据：`window=500`、`archived_total=300`、`last_at` 非空、from_iso/to_iso 指向被归档首尾',
        t.history_archive.window === 500 &&
          t.history_archive.archived_total === 300 &&
          typeof t.history_archive.last_at === 'string' &&
          t.history_archive.files[0].from_iso === expectedAll[0].at &&
          t.history_archive.files[0].to_iso === expectedAll[299].at,
        JSON.stringify({ window: t.history_archive.window, total: t.history_archive.archived_total, from: t.history_archive.files[0].from_iso, to: t.history_archive.files[0].to_iso }),
      )
      // --- 幂等：没再溢出时，再 persist 一次不产生新归档文件 -------------------
      const filesBefore = listArchiveFiles(taskDir).files.length
      await store.recordAudit(taskId, 'main', 'fixture:idle', { n: 1 })
      expectedAll = [...expectedAll, { at: f.h.store.peek(taskId).history.at(-1).at, actor: 'main', action: 'fixture:idle', n: 1 }]
      // 上面 expectedAll 用任务里实际存的那条覆盖（时间戳由 audit 生成）
      expectedAll[expectedAll.length - 1] = f.h.store.peek(taskId).history.at(-1)
      rec.add(
        G,
        '★ 幂等：未再越过 HIGH 时不重复归档（文件数不变、窗口不缩）',
        listArchiveFiles(taskDir).files.length === filesBefore && f.h.store.peek(taskId).history.length === 501,
        `files=${listArchiveFiles(taskDir).files.length} history=${f.h.store.peek(taskId).history.length}`,
      )

      // --- 落盘校验：盘上 task.json 也是 501 条（不是只在内存里缩了）---------
      const onDisk = readJson(join(taskDir, 'task.json'))
      rec.add(
        G,
        '★★ 盘上 task.json 的 history 也只剩窗口大小（写盘前归档，不是事后补）',
        Array.isArray(onDisk.history) && onDisk.history.length === 501 && onDisk.history_archive?.archived_total === 300,
        `disk history=${onDisk.history?.length} archived_total=${onDisk.history_archive?.archived_total}`,
      )
    }

    // =====================================================================
    // B 二次溢出再归档（新 seq 文件，跨文件仍保序不丢）
    // =====================================================================
    {
      const G = 'B 二次溢出再归档'
      const t = f.h.store.peek(taskId)
      const beforeLen = t.history.length
      for (let i = 1; i <= 250; i += 1) t.history.push(mkEntry('B', i))
      const added = t.history.slice(beforeLen)
      const filesBefore = listArchiveFiles(taskDir).files.length
      const archivedBefore = t.history_archive.archived_total
      const overflowCount = t.history.length + 1 - HISTORY_ARCHIVE_WINDOW
      const triggered = await store.recordAudit(taskId, 'main', 'fixture:triggerB', { n: 2 })
      expectedAll = [...expectedAll, ...added, triggered.entry]
      const t2 = f.h.store.peek(taskId)
      rec.add(
        G,
        '★★ 第二次溢出（751 条 > 700）⇒ 新文件 `history-0002.jsonl`，窗口仍 500',
        triggered.ok === true &&
          t2.history.length === 500 &&
          t2.history_archive.files.length === filesBefore + 1 &&
          t2.history_archive.files[1].file === 'archive/history-0002.jsonl' &&
          t2.history_archive.files[1].seq === 2 &&
          t2.history_archive.files[1].count === overflowCount,
        JSON.stringify({ files: t2.history_archive.files, history: t2.history.length, expectCount: overflowCount }),
      )
      rec.add(
        G,
        '★★ 跨两个归档文件仍**保序 + 零丢失**（拼回 == 原始序列）',
        (() => {
          const r = reconstruct(f.h, taskId)
          return r.ok === true && r.entries.length === expectedAll.length && sameSequence(r.entries, expectedAll)
        })(),
        (() => {
          const r = reconstruct(f.h, taskId)
          if (r.ok !== true) return r.note
          const bad = r.entries.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(expectedAll[i]))
          return `reconstruct=${r.entries.length} 原始=${expectedAll.length} 首个差异=${bad}`
        })(),
      )
      rec.add(
        G,
        '★ `archived_total` 累加正确（300 + 本次溢出条数）',
        t2.history_archive.archived_total === archivedBefore + overflowCount,
        `${t2.history_archive.archived_total}（前值 ${archivedBefore} + ${overflowCount}）`,
      )
    }

    // =====================================================================
    // C 写失败 ⇒ 不裁剪 + audit:archive:failed；恢复后能继续
    // =====================================================================
    {
      const G = 'C 归档失败：不裁剪 + 可见失败'
      // 注入失败：先把归档目录**改名挪开**（保留已有归档文件），再把 `archive` 位置换成同名**文件**
      // ⇒ mkdir 必失败（跨平台），且不会误删既有归档（测试自己也不许丢数据）。
      const savedDir = `${archiveDir}.saved`
      renameSync(archiveDir, savedDir)
      writeFileSync(archiveDir, 'blocked', 'utf8')
      const t = f.h.store.peek(taskId)
      const historyBefore = t.history.length
      const metaBefore = JSON.parse(JSON.stringify(t.history_archive))
      for (let i = 1; i <= 200; i += 1) t.history.push(mkEntry('C', i))
      const auditLinesBefore = (await store.auditLog(taskId)).length
      const triggered = await store.recordAudit(taskId, 'main', 'fixture:triggerC', { n: 3 })
      const t2 = f.h.store.peek(taskId)
      const auditLinesAfter = (await store.auditLog(taskId)).length
      rec.add(
        G,
        '★★ 归档目录不可写 ⇒ **不裁剪**（history 一条都没少）',
        triggered.ok === true && t2.history.length === historyBefore + 200 + 1,
        `history=${t2.history.length}（失败前 ${historyBefore}，新增 201）`,
      )
      rec.add(
        G,
        '★★ 失败可见：`history_archive.last_error` + `audit:archive:failed`（不是静默）',
        t2.history_archive?.last_error !== undefined &&
          typeof t2.history_archive.last_error.code === 'string' &&
          (await store.auditLog(taskId)).some((e) => e.action === 'archive:failed' && e.code === t2.history_archive.last_error.code),
        JSON.stringify(t2.history_archive?.last_error ?? null),
      )
      rec.add(
        G,
        '★ 失败时已有归档文件/已归档条数**原样保留**（不因失败篡改账本）',
        Array.isArray(t2.history_archive?.files) &&
          t2.history_archive.files.length === metaBefore.files.length &&
          t2.history_archive.archived_total === metaBefore.archived_total,
        JSON.stringify({ files: t2.history_archive?.files?.length, total: t2.history_archive?.archived_total }),
      )
      rec.add(
        G,
        '★ 失败只让 audit 多了 **2** 行（业务动作 1 + archive:failed 1）—— 没动的数据没被删',
        auditLinesAfter === auditLinesBefore + 2,
        `audit ${auditLinesBefore} → ${auditLinesAfter}`,
      )

      // --- 恢复：去掉阻塞文件、把原归档目录挪回来 ⇒ 能继续归档（并清掉 last_error）------
      rmSync(archiveDir, { force: true })
      renameSync(savedDir, archiveDir)
      expectedAll = [...expectedAll, ...t2.history.slice(historyBefore, historyBefore + 200), triggered.entry]
      const audit2Before = (await store.auditLog(taskId)).length
      const rec2 = await store.recordAudit(taskId, 'main', 'fixture:triggerC2', { n: 4 })
      expectedAll = [...expectedAll, rec2.entry]
      const t3 = f.h.store.peek(taskId)
      rec.add(
        G,
        '★★ 恢复可写后再次溢出 ⇒ 继续归档（新文件 history-0003），窗口回到 500、last_error 清空',
        rec2.ok === true &&
          t3.history.length === 500 &&
          t3.history_archive.files.length === 3 &&
          t3.history_archive.files[2].file === 'archive/history-0003.jsonl' &&
          t3.history_archive.last_error === undefined,
        JSON.stringify({ history: t3.history.length, files: t3.history_archive.files, last_error: t3.history_archive.last_error ?? null }),
      )
      rec.add(
        G,
        '★★ 失败 → 恢复全程**零丢失 + 保序**',
        (() => {
          const r = reconstruct(f.h, taskId)
          return r.ok === true && r.entries.length === expectedAll.length && sameSequence(r.entries, expectedAll)
        })(),
        (() => {
          const r = reconstruct(f.h, taskId)
          if (r.ok !== true) return r.note
          const bad = r.entries.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(expectedAll[i]))
          return `reconstruct=${r.entries.length} 原始=${expectedAll.length} 首个差异=${bad}`
        })(),
      )
      rec.add(
        G,
        '★ 成功归档不往 audit.jsonl 里加 `archive:*` 行（触发动作自己那 1 行除外）',
        audit2Before + 1 === (await store.auditLog(taskId)).length &&
          !(await store.auditLog(taskId)).slice(audit2Before).some((e) => String(e.action).startsWith('archive:')),
        `audit ${audit2Before} → ${(await store.auditLog(taskId)).length}`,
      )
      void seq
    }

    // =====================================================================
    // D pipeline_status：storage/archive 一行摘要 + full 的 history_archive；f35 分页正常
    // =====================================================================
    {
      const G = 'D status 展示 + f35 分页'
      const call = (args) => callTool(f.h, 'pipeline_status', { task_id: taskId, role_token: f.tokens.main, ...args }, f.agents.main)
      const brief = await call({ detail: 'summary' })
      const briefText = String(brief.value?.summary ?? '')
      const storageLine = briefText.split('\n').find((l) => l.startsWith('存储：')) ?? ''
      rec.add(
        G,
        '★★ 紧凑档：storage 一行里带「归档 N 文件 / M 条（窗口 500）」',
        brief.denied !== true &&
          briefText.split('\n').filter((l) => l.startsWith('存储：')).length === 1 &&
          /归档 \d+ 文件 \/ \d+ 条（窗口 500）/.test(storageLine),
        storageLine,
      )
      rec.add(
        G,
        '★★ 结构化 `history_archive`：files / archived_total / window / last_at 齐全',
        brief.value?.history_archive !== null &&
          Array.isArray(brief.value?.history_archive?.files) &&
          brief.value.history_archive.files.length === 3 &&
          brief.value.history_archive.archived_total === expectedAll.length - 500 &&
          brief.value.history_archive.window === 500 &&
          typeof brief.value.history_archive.last_at === 'string',
        JSON.stringify({ files: brief.value?.history_archive?.files?.length, total: brief.value?.history_archive?.archived_total }),
      )
      const full = await call({})
      const fullText = String(full.value?.summary ?? '')
      rec.add(
        G,
        '★★ full 档可见 `history 归档：…`（文件数 / 条数 / 窗口 / 文件清单）',
        full.denied !== true &&
          fullText.includes('history 归档：') &&
          fullText.includes('archive/history-0001.jsonl') &&
          fullText.includes('窗口 500'),
        fullText.split('\n').filter((l) => l.includes('history 归档') || l.includes('文件：')).join('\n'),
      )
      // f35 分页仍正常：窗口 500 条 → 分 50 页；history_archive 不影响分页信封
      const paged = await call({ page: 1, page_size: 10 })
      const hist = paged.value?._pagination?.history
      rec.add(
        G,
        '★★ P2-13 第一步的分页不受归档影响：窗口 500 条 → history 分页 1/50',
        paged.denied !== true &&
          hist !== undefined &&
          hist.total_items === 500 &&
          hist.total_pages === 50 &&
          Array.isArray(paged.value?.history) &&
          paged.value.history.length === 10,
        JSON.stringify(hist),
      )
      rec.add(
        G,
        '★ `storage.history_count` 报告的是**当前窗口**（500），不是归档前的总数',
        paged.value?.storage?.history_count === 500,
        String(paged.value?.storage?.history_count),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(f.h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF36HistoryArchiveCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
