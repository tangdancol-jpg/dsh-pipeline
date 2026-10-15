/**
 * m4 · 记忆 · **retain 缝只在"该记"时记**（+ 注入形状合法）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m4-memory-retain-hook-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测一件事
 * ---------------------------------------------------------------------------
 * 两条缝的**取舍**对不对：
 *   · retain（`tools/post-execute`）：**该记的记**（R1）、**不该记的一条都不记**（R2）、
 *     同一件事不记两遍、**绝不改结果**、写失败不抛（R3 的缝上口径）；
 *   · inject（`agent/pre-step`）：注进去的消息**必须是宿主形状**（R14）——
 *     一条裸消息就能让整个 turn 以 `reading 'kind'` 收尾（`hook-prompt.js:5-15` 的事故）。
 *
 * ★ 判据 R2 的分量：`pipeline_*` 之外的每一次工具调用（`bash` / `read` / `write`…）
 *   都不许进库 —— 否则一次会话就能把库写爆，而且那些内容根本不属于本插件的事实。
 *
 * @module dsh-pipeline/tests/m4-memory-retain-hook-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOST_INJECTION_SITES, RUNTIME_CONTEXT_KIND, assertHostMessage, isProducerOwnedKind } from '../lib/hostmsg.js'
import { memoryDir, memoryFile } from '../lib/memory/bank.js'
import { readBank } from '../lib/memory/load.js'
import { validateRecord } from '../lib/memory/record.js'
import { createMemoryInjectHook, INJECT_TOKEN_LIMIT } from '../lib/memory/inject-hook.js'
import { createMemoryRetainHook, retainDisc, shouldRetain } from '../lib/memory/retain-hook.js'

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

const countLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length : 0)
const FIXED_AT = '2026-01-05T00:00:00Z'
const SEAT = { taskId: 'T-1', role: 'writer', seat: 'writer#1' }

/** 造一条 retain 缝（真 fs；时钟写死 ⇒ 判据确定性）。 */
function makeSeam(projectDir, extra = {}) {
  const warns = []
  const svc = {
    ask: () => true,
    seatOf: () => SEAT,
    getTask: () => null,
    warn: (m) => warns.push(m),
    projectDir,
    nowIso: () => FIXED_AT,
    ...extra,
  }
  return { hook: createMemoryRetainHook(svc), warns }
}

/** 跑一次缝：`next` 的原样值是什么、返回值是不是同它一致。 */
async function runSeam(hook, exec, result, nextValue = { ok: true, toolResult: result }) {
  let called = 0
  const out = await hook(exec, result, async () => {
    called += 1
    return nextValue
  })
  return { out, called, nextValue }
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m4 · 记忆 retain 缝：只在"该记"时记（+ 注入形状合法）')
  lines.push('='.repeat(78))

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m4-'))
  try {
    const file = memoryFile(root)

    // ---- ① R1：该记的记 ----------------------------------------------------
    lines.push('')
    lines.push('【① R1：一次 `pipeline_*` 调用 ⇒ 库**多出恰好 1 条**】')
    const seam = makeSeam(root)
    const before = countLines(file)
    const r1 = await runSeam(seam.hook, { name: 'pipeline_handoff', arguments: { task_id: 'T-1' } }, { ok: true, handoff_id: 'HO-1', summary: '已提交交接物' })
    ok(countLines(file) === before + 1, '★ 行数 +1（**恰好一条**，不多不少）', `${before} → ${countLines(file)}`)
    ok(r1.out === r1.nextValue && r1.called === 1, '★ 结果**原样**透传（本缝是观察者，不是过滤器）', `out 与 next 的原样值相等：${r1.out === r1.nextValue}`)
    const bank = await readBank(file)
    ok(bank.records.length === 1 && validateRecord(bank.records[0]).ok === true, '写进去的那条**过校验器**（不是"看着像记忆"）', JSON.stringify(bank.records[0]?.kind))
    ok(bank.records[0]?.refs?.handoff === 'HO-1' && bank.records[0]?.refs?.task_id === 'T-1', '`refs` 带上了任务与交接物（可追溯）', JSON.stringify(bank.records[0]?.refs))
    ok(bank.records[0]?.text.includes('pipeline_handoff') && bank.records[0]?.at === FIXED_AT, '正文含工具名、时刻来自注入的时钟（确定性）', bank.records[0]?.text)

    // ---- ② R2：不该记的一条都不记 ------------------------------------------
    lines.push('')
    lines.push('【② R2：**非 `pipeline_*`** 的工具调用 ⇒ 库行数**不变**】')
    for (const name of ['bash', 'read', 'write', 'pwsh', 'skill', 'pipelinex']) {
      const r = await runSeam(seam.hook, { name, arguments: { command: 'ls' } }, { ok: true, content: 'a'.repeat(500) })
      ok(countLines(file) === before + 1 && r.out === r.nextValue, `\`${name}\` ⇒ 不记（行数仍是 ${before + 1}）`, `name=${name} 行数=${countLines(file)}`)
    }
    ok(shouldRetain({ name: 'bash' }) === false && shouldRetain({ name: 'pipeline_recall' }) === true, '`shouldRetain` 是这条判据的**纯函数形态**（`pipeline_` 空前缀不算）', `bash=${shouldRetain({ name: 'bash' })} pipeline_recall=${shouldRetain({ name: 'pipeline_recall' })} pipeline_=${shouldRetain({ name: 'pipeline_' })}`)

    // ---- ③ 去重：同一件事不记两遍 ------------------------------------------
    lines.push('')
    lines.push('【③ 同一事件重复到达 ⇒ 只记一条（去重键是纯函数）】')
    const dupExec = { name: 'pipeline_transition', arguments: { task_id: 'T-1' } }
    const dupRes = { ok: true, event: 'dev_submitted', from: 'ready_dev', to: 'developing' }
    const n0 = countLines(file)
    await runSeam(seam.hook, dupExec, dupRes)
    const n1 = countLines(file)
    await runSeam(seam.hook, dupExec, dupRes)
    await runSeam(seam.hook, dupExec, dupRes)
    ok(n1 === n0 + 1 && countLines(file) === n0 + 1, '★ 同一次事件连来三次 ⇒ 库里只多 **1** 条（重复的是噪音，不是记忆）', `${n0} → ${n1} → ${countLines(file)}`)
    ok(retainDisc(dupExec, dupRes) === retainDisc(dupExec, dupRes), '去重键**确定性**（同输入同键）', retainDisc(dupExec, dupRes).slice(0, 60))
    ok(
      retainDisc(dupExec, { ...dupRes, to: 'ready_test' }) !== retainDisc(dupExec, dupRes),
      '换了判别子（`to` 变了）⇒ 是**新的一条事实**，键跟着变（不误去重）',
      `不同状态的键不同：${retainDisc(dupExec, { ...dupRes, to: 'ready_test' }) !== retainDisc(dupExec, dupRes)}`,
    )

    // ---- ④ R3（缝上口径）：写失败 ⇒ 照样透传 -------------------------------
    lines.push('')
    lines.push('【④ R3（缝这一层）：写库抛错 ⇒ 异常不外泄、结果照常透传】')
    const boomSeam = makeSeam(root, {
      memoryFs: { mkdir: async () => {}, appendFile: async () => { throw new Error('EACCES: 只读') } },
    })
    const nBeforeBoom = countLines(file)
    let threw = false
    let outBoom = null
    try {
      const r = await runSeam(boomSeam.hook, { name: 'pipeline_close', arguments: { task_id: 'T-1' } }, { ok: true, summary: '已关单' })
      outBoom = r
    } catch {
      threw = true
    }
    ok(threw === false, '★ 缝里**没有异常逃出去**（`tools/post-execute` 是关键路径）', `抛=${threw}`)
    ok(outBoom !== null && outBoom.out === outBoom.nextValue, '★ 被包裹的那次调用**拿到原结果**', `透传=${outBoom?.out === outBoom?.nextValue}`)
    ok(countLines(file) === nBeforeBoom && boomSeam.warns.length >= 1, '一个字节没多 + 留了一条 warn（不静默）', `warn=${boomSeam.warns[0] ?? '(无)'}`)

    // ---- ⑤ 落点取不到 ⇒ 静默不写 -------------------------------------------
    lines.push('')
    lines.push('【⑤ 项目目录取不到 ⇒ **静默不写**（不猜落点、不建目录）】')
    const stranded = makeSeam('')
    const rs = await runSeam(stranded.hook, { name: 'pipeline_status', arguments: { task_id: 'T-1' } }, { ok: true, summary: '状态' })
    ok(rs.out === rs.nextValue && countLines(file) === nBeforeBoom, '不写、不抛、不改结果', `行数=${countLines(file)}`)
    ok(stranded.warns.length === 0, '也不 warn —— "没有项目目录"是**正常情形**（不是失败）', `warn 数=${stranded.warns.length}`)

    // ---- ⑥ 总开关（逐次判据）：ask() 为假 ⇒ 一条不写 -----------------------
    lines.push('')
    lines.push('【⑥ 总开关：`ask()` 为假 ⇒ 一条不写，且仍然照常透传】')
    const offSeam = makeSeam(root, { ask: () => false })
    const ro = await runSeam(offSeam.hook, { name: 'pipeline_handoff', arguments: { task_id: 'T-1' } }, { ok: true, handoff_id: 'HO-OFF' })
    ok(countLines(file) === nBeforeBoom && ro.out === ro.nextValue && ro.called === 1, '★ off ⇒ 库一个字节不变、结果原样、下游照常被调用', `行数=${countLines(file)}（不变）`)

    // ---- ⑦ R14：注入形状合法 ----------------------------------------------
    lines.push('')
    lines.push('【⑦ R14：注入的消息是**宿主形状**，且注入点已登记】')
    const injectedMessages = []
    const inject = createMemoryInjectHook({
      ask: () => true,
      seatOf: () => SEAT,
      getTask: () => ({ id: 'T-1', project_dir: root }),
      warn: () => {},
      projectDir: root,
    })
    const downstream = { kind: 'enter', messages: [{ role: 'user', content: '原有一条' }], startsRequestSeries: true }
    const outInject = await inject({ agent: { id: 'a1' }, messages: [] }, async () => downstream)
    const extra = (outInject.messages ?? []).filter((m) => m !== downstream.messages[0])
    injectedMessages.push(...extra)
    ok(extra.length === 1, '★ 库里有记忆 ⇒ 恰好注入 **1** 条（每席位一次）', `注入数=${extra.length}`)
    ok(outInject.startsRequestSeries === true && (outInject.messages ?? [])[0] === downstream.messages[0], '下游字段被 spread 保留（`startsRequestSeries` 没丢），原消息仍在最前', `startsRequestSeries=${outInject.startsRequestSeries}`)
    const viol = extra.length > 0 ? assertHostMessage(extra[0], { path: 'injected[0]' }) : ['没有注入物']
    ok(viol.length === 0, '★★ 消息过 `assertHostMessage`（id / role / content 是 block 数组 / 有 source.kind）', viol.length === 0 ? `id=${extra[0]?.id?.slice(0, 8)}… source.kind=${extra[0]?.source?.kind} form=${extra[0]?.source?.form}` : viol.join('\n'))
    ok(extra.length > 0 && isProducerOwnedKind(extra[0].source.kind), '★ `source.kind` 是**生产者自有**的（不是已退役的裸 `plugin`）', String(extra[0]?.source?.kind))
    ok(extra.length > 0 && extra[0].source.form === 'memory-recall', '`source.form` = `memory-recall`（与注入点登记表里那一行逐字一致）', String(extra[0]?.source?.form))
    ok(
      HOST_INJECTION_SITES.some((s) => s.id === 'pre-step-memory-recall' && s.form === 'memory-recall' && s.via === 'hostMessage'),
      '★ 注入点**已在 `HOST_INJECTION_SITES` 登记**（设计 04 §2.1：先加一行 —— 不登记就是一处会炸的裸消息）',
      `表里 ${HOST_INJECTION_SITES.length} 行`,
    )
    ok(RUNTIME_CONTEXT_KIND === 'runtime-context', '往席位投运行时上下文时用的 kind 常量仍在（`runtime-context` 是 DSH 原生语义）', RUNTIME_CONTEXT_KIND)

    // ---- ⑧ 注入的边界：空库不注入、下游拒绝不注入、每席位一次 ---------------
    lines.push('')
    lines.push('【⑧ 注入的边界：空库 / 下游拒绝 / 已注入过 ⇒ **都不注入**】')
    const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m4-empty-'))
    try {
      const emptyInject = createMemoryInjectHook({
        ask: () => true,
        seatOf: () => SEAT,
        getTask: () => null,
        warn: () => {},
        projectDir: emptyRoot,
      })
      const outEmpty = await emptyInject({ agent: { id: 'a1' }, messages: [] }, async () => downstream)
      ok(outEmpty === downstream, '库不存在 / 空 ⇒ **原样返回**（不塞一句"暂无记忆"占位 —— 那也是一条消息）', `与 downstream 同一对象=${outEmpty === downstream}`)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
    const rejectInject = createMemoryInjectHook({
      ask: () => true,
      seatOf: () => SEAT,
      getTask: () => ({ id: 'T-1', project_dir: root }),
      warn: () => {},
      projectDir: root,
    })
    const rejected = { kind: 'reject', reason: '越界' }
    const outRejected = await rejectInject({ agent: { id: 'a1' }, messages: [] }, async () => rejected)
    ok(outRejected === rejected, '★ 下游已经是 `{kind:"reject"}` ⇒ **不硬塞消息**（形状会错，设计 04 §2.5）', `原样返回=${outRejected === rejected}`)
    const outAgain = await inject({ agent: { id: 'a1' }, messages: [] }, async () => downstream)
    ok(outAgain === downstream, '★ 同一席位第二次开步 ⇒ **不再注入**（每席位一次；每轮都注入就是把上下文撑爆）', `原样返回=${outAgain === downstream}`)
    const otherSeat = createMemoryInjectHook({
      ask: () => true,
      seatOf: () => ({ taskId: 'T-1', role: 'tester', seat: 'tester#1' }),
      getTask: () => ({ id: 'T-1', project_dir: root }),
      warn: () => {},
      projectDir: root,
      injected: new Set(),
    })
    const outOther = await otherSeat({ agent: { id: 'a2' }, messages: [] }, async () => downstream)
    ok((outOther.messages ?? []).length === 2, '换一个席位 ⇒ 该席位自己注入一次（去重是按席位，不是按进程）', `注入数=${(outOther.messages ?? []).length - 1}`)
    const offInject = createMemoryInjectHook({
      ask: () => false,
      seatOf: () => SEAT,
      getTask: () => ({ id: 'T-1', project_dir: root }),
      warn: () => {},
      projectDir: root,
    })
    const outOff = await offInject({ agent: { id: 'a1' }, messages: [] }, async () => downstream)
    ok(outOff === downstream, '★ off（`ask()` 假）⇒ 一个字节都不注入', `原样返回=${outOff === downstream}`)
    const injectedText = String(injectedMessages[0]?.content?.[0]?.text ?? '')
    ok(injectedText.includes('记忆切片') && injectedText.includes('不是用户说的话'), '注入正文写明"这是运行时上下文，不是用户说的话"（收件人不会误读）', injectedText.slice(0, 70))
    ok(INJECT_TOKEN_LIMIT > 0 && injectedText.length < 4000, '注入有硬上限（`INJECT_TOKEN_LIMIT`），正文不可能无限长', `INJECT_TOKEN_LIMIT=${INJECT_TOKEN_LIMIT} 本次正文=${injectedText.length} 字符`)

    // ---- ⑨ 判据自检：这套断言**真的会红** -----------------------------------
    lines.push('')
    lines.push('【⑨ 判据自检：把"违规形状"打给同一条判据 ⇒ 必须红】')
    const naked = { role: 'user', content: '裸消息（字符串 content、没有 source）' }
    const nakedViol = assertHostMessage(naked, { path: 'naked' })
    ok(nakedViol.length >= 2, '★★ 裸消息 ⇒ `assertHostMessage` 判红（这正是 2026-10-11 让整个 turn 死掉的形状）', nakedViol.map((v) => v.split('\n')[0]).join(' | '))
    const retired = { id: 'x', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin' } }
    ok(assertHostMessage(retired, { path: 'retired' }).length > 0 && isProducerOwnedKind('plugin') === false, '★ 已退役的裸 `plugin` kind ⇒ 同样判红（v4 会拒收它）', assertHostMessage(retired, { path: 'retired' }).join(' | ').slice(0, 120))
    ok(shouldRetain({ name: 'pipeline_' }) === false, '★ `pipeline_` 空前缀不算（"只要有前缀就记"那条松判据会红在这条上）', `shouldRetain('pipeline_')=${shouldRetain({ name: 'pipeline_' })}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m4 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM4MemoryRetainHookCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m4 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m4-memory-retain-hook-check.mjs')) {
  const r = await runM4MemoryRetainHookCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
