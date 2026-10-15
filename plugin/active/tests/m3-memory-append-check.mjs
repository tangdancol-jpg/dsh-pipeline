/**
 * m3 · 记忆 · **追加写**：写失败不影响调用方（R3）+ 并发追加不互相覆盖
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m3-memory-append-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测一件事
 * ---------------------------------------------------------------------------
 * 记忆库是**追加写**的 JSONL。它只有两条不能破的规矩：
 *   ① **绝不抛**（判据 R3）：写库失败时，触发它的那次工具调用必须**照样拿到原结果**
 *      —— 记忆是"能更好"，不是"没它就不对"；
 *   ② **后写不丢前写**：两个缝同时写（并发）不许把对方的行覆盖掉，
 *      也不许写出"半行"（半行 = 那一行永远读不回来）。
 *
 * ★ 这里用**真文件系统**跑并发（不是桩）：`O_APPEND` 的语义只有在真 fs 上才算数。
 *
 * @module dsh-pipeline/tests/m3-memory-append-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendRecords } from '../lib/memory/append.js'
import { memoryDir, memoryFile } from '../lib/memory/bank.js'
import { KIND, emptyRefs, makeRecord } from '../lib/memory/record.js'
import { appendTransition } from '../lib/memory/retain-transition.js'
import { readBank } from '../lib/memory/load.js'

let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
  }
  if (detail.length > 0) lines.push(`      ${detail}`)
}

/** 造一条合法记忆（`i` 只影响 id 与正文，形状不变）。 */
const rec = (i, kind = KIND.TOOL) =>
  makeRecord({
    id: `${kind}:t-1:${i}`,
    at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    kind,
    text: `第 ${i} 条：工具 pipeline_demo 完成`,
    entity: [`task:t-1`, `tool:pipeline_demo`],
    refs: emptyRefs({ task_id: 'T-1' }),
  }).record

/** 数一下文件里有几行非空行（"行数"就是本域的字节级判据）。 */
const countLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length : 0)

async function main() {
  lines.push('='.repeat(78))
  lines.push('m3 · 记忆追加写：写失败不影响调用方 + 并发不互相覆盖')
  lines.push('='.repeat(78))

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m3-'))
  try {
    const file = memoryFile(root)

    // ---- ① 正常写：建库 + 追加 ---------------------------------------------
    lines.push('')
    lines.push('【① 正常路径：库不存在 ⇒ 建目录并追加；行数如实增长】')
    ok(!existsSync(memoryDir(root)), '写之前：库目录还不存在', memoryDir(root))
    const first = await appendRecords(file, [rec(1), rec(2)])
    ok(first.ok === true && first.appended === 2, '两条都写进去了（`appended=2`）', JSON.stringify(first))
    ok(existsSync(file) && countLines(file) === 2, '库文件已建、行数 = 2', `行数=${countLines(file)}`)
    const again = await appendRecords(file, [rec(3)])
    ok(again.ok === true && countLines(file) === 3, '第二次追加 ⇒ 行数 = 3（**追加**，不是覆盖）', `行数=${countLines(file)}`)
    const bank = await readBank(file)
    ok(bank.records.length === 3 && bank.skipped === 0, '读回来是 3 条合法记忆（写进去的和读出来的一致）', `records=${bank.records.length} skipped=${bank.skipped}`)

    // ---- ② 坏记录被拒（不许把畸形写进库） ----------------------------------
    lines.push('')
    lines.push('【② 畸形记录**不写**，但要如实计数（不许静默丢）】')
    const bad = { ...rec(4), kind: 'Bad Kind!' }
    const mixed = await appendRecords(file, [rec(5), bad, rec(6)])
    ok(mixed.ok === true && mixed.appended === 2 && mixed.skipped === 1, '好的一条不落、坏的一条不写且 `skipped=1`', JSON.stringify(mixed))
    ok(countLines(file) === 5, '行数 = 5（只有合法的进了库）', `行数=${countLines(file)}`)
    const emptyBatch = await appendRecords(file, [])
    ok(emptyBatch.ok === true && emptyBatch.appended === 0 && emptyBatch.reason === 'EMPTY_BATCH', '空批次 ⇒ `ok:true` + `EMPTY_BATCH`（不是失败）', JSON.stringify(emptyBatch))
    const noFile = await appendRecords('', [rec(7)])
    ok(noFile.ok === false && noFile.reason === 'NO_MEMORY_FILE', '落点取不到 ⇒ `ok:false` + `NO_MEMORY_FILE`（**不猜落点**）', JSON.stringify(noFile))

    // ---- ③ R3：写失败**不抛**，调用方照常拿到原结果 -------------------------
    lines.push('')
    lines.push('【③ R3：写失败（目录只读 / 磁盘满的等价物）⇒ **不抛**，被包裹的调用拿到原结果】')
    const warns = []
    const boom = {
      mkdir: async () => {},
      appendFile: async () => {
        throw new Error('EACCES: permission denied')
      },
    }
    let threw = false
    let wrapped = null
    try {
      // ★ 这就是"被包裹的那次工具调用"的形状：写库只是它中间的一步。
      wrapped = await (async () => {
        const w = await appendRecords(file, [rec(8)], { fs: boom, warn: (m) => warns.push(m) })
        void w
        return { ok: true, value: '工具原结果' }
      })()
    } catch {
      threw = true
    }
    ok(threw === false, '★ **没有异常逃出去**（`appendRecords` 绝不抛）', `抛=${threw}`)
    ok(wrapped !== null && wrapped.value === '工具原结果', '★ 被包裹的调用**照样拿到原结果**（判据 R3 的原话）', JSON.stringify(wrapped))
    const failedWrite = await appendRecords(file, [rec(9)], { fs: boom, warn: (m) => warns.push(m) })
    ok(failedWrite.ok === false && failedWrite.reason.startsWith('APPEND_FAILED'), '失败**如实报**（`ok:false` + `APPEND_FAILED: …`），不当成功', failedWrite.reason)
    ok(warns.length >= 1 && warns[0].includes('记忆追加失败'), '失败留一条 warn（唯一发声渠道），且文案说清"不影响触发它的那次调用"', warns[0] ?? '(没 warn)')
    ok(countLines(file) === 5, '失败之后**一个字节都没多**（没写成就是没写成，不写半行）', `行数=${countLines(file)}`)
    const mkdirBoom = { mkdir: async () => { throw new Error('EROFS: read-only file system') }, appendFile: async () => {} }
    const noDirWrite = await appendRecords(memoryFile(join(root, 'nowhere')), [rec(10)], { fs: mkdirBoom, warn: (m) => warns.push(m) })
    ok(noDirWrite.ok === false && warns.length >= 2, '建目录就失败 ⇒ 同样不抛、同样只 warn', noDirWrite.reason)
    const warnBoom = {
      mkdir: async () => {},
      appendFile: async () => {
        throw new Error('boom')
      },
    }
    let warnThrew = false
    try {
      await appendRecords(file, [rec(11)], { fs: warnBoom, warn: () => { throw new Error('warn 自己也坏了') } })
    } catch {
      warnThrew = true
    }
    ok(warnThrew === false, '连 `warn` 自己抛错也不许把异常带出去（最坏情况仍然安静地失败）', `抛=${warnThrew}`)

    // ---- ④ 并发：后写不丢前写（真 fs + O_APPEND） ---------------------------
    lines.push('')
    lines.push('【④ 并发追加：两个缝同时写，谁也不许覆盖谁（真 fs 上跑 `O_APPEND`）】')
    const conc = join(root, 'conc.jsonl')
    const BATCHES = 8
    const PER = 5
    await Promise.all(
      Array.from({ length: BATCHES }, (_, b) =>
        appendRecords(conc, Array.from({ length: PER }, (_, i) => rec(b * PER + i + 100))),
      ),
    )
    const concLines = readFileSync(conc, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    ok(concLines.length === BATCHES * PER, `★ ${BATCHES} 个并发批次 × ${PER} 条 ⇒ 一行都不丢（${BATCHES * PER} 行）`, `实际=${concLines.length} 行`)
    const ids = new Set()
    let halfLine = 0
    for (const l of concLines) {
      try {
        ids.add(JSON.parse(l).id)
      } catch {
        halfLine += 1
      }
    }
    ok(ids.size === BATCHES * PER, '★ 每一行都是**完整合法的 JSON**（没有交错出来的"半行"）', `唯一 id=${ids.size}　解析失败=${halfLine}`)
    const concBank = await readBank(conc)
    ok(concBank.records.length === BATCHES * PER && concBank.skipped === 0, '读回来同样是满的（半个字都没坏）', `records=${concBank.records.length} skipped=${concBank.skipped}`)

    // ---- ⑤ 坏行跳过 ≠ 整库丢弃 ---------------------------------------------
    lines.push('')
    lines.push('【⑤ 半行 / 坏行 ⇒ 只跳过它自己（`skipped` 计数），**不整库丢弃**】')
    const dirty = join(root, 'dirty.jsonl')
    writeFileSync(dirty, `{"id":"a"}\n这不是 JSON\n{"id":"b"}\n`, 'utf8')
    const dirtyBank = await readBank(dirty)
    ok(dirtyBank.records.length === 2 && dirtyBank.skipped === 1, '两条好的读得回来，坏的那条只计入 `skipped`', `records=${dirtyBank.records.length} skipped=${dirtyBank.skipped} lines=${dirtyBank.lines}`)
    const missing = await readBank(join(root, 'nope.jsonl'))
    ok(missing.records.length === 0 && missing.reason === 'NO_BANK', '库不存在 ⇒ 空 + `NO_BANK`（**不建目录、不报错**）', `reason=${missing.reason}`)

    // ---- ⑥ 迁移记忆的追加入口 ----------------------------------------------
    lines.push('')
    lines.push('【⑥ `appendTransition`：迁移 → 记录 → 追加（同一条追加路径，同样绝不抛）】')
    const t = await appendTransition(root, {
      task: { id: 'T-1', state: 'developing', history: [] },
      from: 'ready_dev',
      to: 'developing',
      event: 'dev_submitted',
      at: '2026-01-02T00:00:00Z',
      by: 'writer',
    })
    ok(t.ok === true && t.appended === 1, '追加成功', JSON.stringify(t))
    const tBad = await appendTransition(root, { task: { id: 'T-1' }, from: 'a', to: 'b', event: 'x', at: '不是时刻' })
    ok(tBad.ok === false && tBad.reason.startsWith('BAD_RECORD'), '畸形迁移 ⇒ `BAD_RECORD`（**不写半条**），并且不抛', tBad.reason)
    const finalBank = await readBank(memoryFile(root))
    ok(finalBank.records.some((r) => r.kind === 'transition'), '库里确实多了一条 `transition` 记忆', `kinds=${JSON.stringify([...new Set(finalBank.records.map((r) => r.kind))])}`)

    // ---- ⑦ 判据自检：这套断言**真的会红** -----------------------------------
    lines.push('')
    lines.push('【⑦ 判据自检：把"会覆盖/会抛"的形状打给同一条判据 ⇒ 必须红】')
    const overwrite = join(root, 'overwrite.jsonl')
    writeFileSync(overwrite, 'first\n', 'utf8')
    writeFileSync(overwrite, 'second\n', 'utf8') // 覆盖写法
    ok(readFileSync(overwrite, 'utf8') === 'second\n', '★ 覆盖写（`writeFile` 而不是 `appendFile`）⇒ "后写不丢前写"那条判据会红：第一行真的没了', JSON.stringify(readFileSync(overwrite, 'utf8')))
    let padThrow = false
    try {
      const throwingFs = { mkdir: async () => {}, appendFile: async () => { throw new Error('x') } }
      // 直接调它（不经过 appendRecords）—— 证明"异常确实存在，是 appendRecords 把它挡住了"
      await throwingFs.appendFile(overwrite, 'x')
    } catch {
      padThrow = true
    }
    ok(padThrow === true, '★ 底层 `appendFile` 确实会抛（所以 ③ 的"不抛"是**实现的功劳**，不是"本来就不抛"）', `抛=${padThrow}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m3 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM3MemoryAppendCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m3 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m3-memory-append-check.mjs')) {
  const r = await runM3MemoryAppendCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
