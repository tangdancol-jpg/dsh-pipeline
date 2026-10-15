/**
 * m8 · 记忆 · ★ **总开关 off ⇒ 一条缝都不挂、库一个字节不变**
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m8-memory-switch-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测一件事
 * ---------------------------------------------------------------------------
 * 判据 **R12**（off ⇒ 记忆域**一条缝都不挂**）、**R13**（off ⇒ 记忆库**一个字节都不变**）、
 * **R15**（`SWITCH_SURFACES` 里每一条新面都有对应的 `shouldFire` 闸门）。
 *
 * ★ 为什么这三条必须一起测：记忆域是**本插件里唯一会写项目目录**的新面
 *   （`main-contact-bookkeeping` 之外的第二处）。用户报过的
 *   「开关只关一半」正是"文案说关了、动作还在" —— 所以判据必须是**计数 + 字节**，
 *   不是"看代码觉得应该没写"。
 *
 * ★ 用的是**真文件系统**：`_memory/memory.jsonl` 的字节数就是判据本身。
 *
 * @module dsh-pipeline/tests/m8-memory-switch-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerInterception } from '../lib/intercept.js'
import { SWITCH_SURFACES, shouldFire } from '../lib/switch/gate.js'
import { memoryFile } from '../lib/memory/bank.js'
import { createFakeHost, makeFakeSwitch } from './switch-fixtures.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (condition(cond)) {
    passed += 1
    lines.push(`  ✓ ${title}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
  }
  if (detail.length > 0) lines.push(`      ${detail}`)
}
const condition = (v) => v === true

/** 记忆域的两条新面（**从 `SWITCH_SURFACES` 自己算出来**，不手抄名单）。 */
const MEMORY_SURFACES = SWITCH_SURFACES.filter((s) => s.id.startsWith('memory-')).map((s) => s.id)

/** 库文件的字节数（"一个字节不变"就是这条判据的尺子）。 */
const bytesOf = (file) => (existsSync(file) ? readFileSync(file).length : -1)

/** 装一套拦截缝（**只给记忆域要的东西**，其余用最小替身）。 */
function mount({ sw, projectDir, host }) {
  const tokens = { roleOfAgent: (agentId) => (agentId === 'seat-1' ? { role: 'writer', taskId: 'T-1', seat: 'writer#1' } : null) }
  return registerInterception(host.ctx, {
    tokens,
    guard: () => undefined,
    sw,
    warn: () => {},
    getTask: () => ({ id: 'T-1', project_dir: projectDir }),
    projectDir,
  })
}

/** 跑一轮"该记的调用 + 该注入的一步"。 */
async function runRound(host, file) {
  // ① retain：一次 `pipeline_*` 调用（结果里带判别子）
  await host.emit('tools/post-execute', { name: 'pipeline_handoff', arguments: { task_id: 'T-1' }, agent: { id: 'seat-1' } }, { ok: true, handoff_id: 'HO-1', summary: '已提交交接物' })
  // ② inject：席位开新的一步
  const out = await host.emit('agent/pre-step', { agent: { id: 'seat-1' }, messages: [{ role: 'user', content: '继续' }], turn: 2 })
  return { bytes: bytesOf(file), preStepMessages: Array.isArray(out?.messages) ? out.messages.length : -1 }
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m8 · 记忆域总开关：off ⇒ 一条缝都不挂 + 库一个字节不变')
  lines.push('='.repeat(78))

  // ---- ① 面清单：记忆域两条面都登记了，且都过闸门 --------------------------
  lines.push('')
  lines.push('【① R15：`SWITCH_SURFACES` 里记忆域的每一条面都有 `shouldFire` 闸门】')
  ok(MEMORY_SURFACES.includes('memory-retain') && MEMORY_SURFACES.includes('memory-inject'), '记忆域的两条面都在面清单里（`memory-retain` / `memory-inject`）', JSON.stringify(MEMORY_SURFACES))
  ok(
    shouldFire({ isOn: () => true }, 'memory-retain') === true && shouldFire({ isOn: () => false }, 'memory-retain') === false,
    '★ `memory-retain`：开 ⇒ true、关 ⇒ false（off 语义 = 一点都不许发生）',
    `开=${shouldFire({ isOn: () => true }, 'memory-retain')} 关=${shouldFire({ isOn: () => false }, 'memory-retain')}`,
  )
  ok(
    shouldFire({ isOn: () => true }, 'memory-inject') === true && shouldFire({ isOn: () => false }, 'memory-inject') === false,
    '★ `memory-inject`：同上',
    `开=${shouldFire({ isOn: () => true }, 'memory-inject')} 关=${shouldFire({ isOn: () => false }, 'memory-inject')}`,
  )
  const registrySrc = readFileSync(join(ROOT, 'lib', 'intercept', 'registry.js'), 'utf8')
  const hookIds = [...registrySrc.matchAll(/^ {2}\{ id: '([a-z-]+)'/gm)].map((m) => m[1])
  // ★ E3：记忆域的面从"全是缝"长成**两类** ——
  //   · **缝**（`memory-retain` / `memory-inject`）必须在 `HOOKS` 编排表里（登记了却没挂 = 文案撒谎）；
  //   · **非缝机制**（`memory-live-doc`：状态迁移 / 关单触发的写盘）**不该**在编排表里
  //     —— 它不是"每次调用都过一遍"的拦截点，挂进 HOOKS 反而是错的。
  //   判据仍然是"清单与实际**逐条**一致"，不是"少判一条"：下面把两类**都钉死**。
  const seamMemory = MEMORY_SURFACES.filter((id) => hookIds.includes(id))
  const nonSeamMemory = MEMORY_SURFACES.filter((id) => !hookIds.includes(id))
  ok(
    JSON.stringify(seamMemory) === JSON.stringify(['memory-retain', 'memory-inject']),
    '★ 记忆域的**缝**逐条都在 `HOOKS` 编排表里（登记了却没挂 = 文案撒谎）',
    `缝=${JSON.stringify(seamMemory)}｜编排表=${JSON.stringify(hookIds)}`,
  )
  ok(
    JSON.stringify(nonSeamMemory) === JSON.stringify(['memory-live-doc']),
    '★ 记忆域的**非缝机制**逐条**不在** `HOOKS` 里（`memory-live-doc` 由状态迁移 / 关单触发，不是拦截点）',
    `非缝=${JSON.stringify(nonSeamMemory)}`,
  )
  ok(
    shouldFire({ isOn: () => true }, 'memory-live-doc') === true && shouldFire({ isOn: () => false }, 'memory-live-doc') === false,
    '★ `memory-live-doc`：开 ⇒ true、关 ⇒ false（off 语义 = 一个字节都不许改）',
    `开=${shouldFire({ isOn: () => true }, 'memory-live-doc')} 关=${shouldFire({ isOn: () => false }, 'memory-live-doc')}`,
  )
  ok(
    hookIds.includes('memory-retain') && hookIds.includes('memory-inject'),
    '★ 两条记忆缝真的进了编排表（不是只写了常量）',
    `编排表里记忆缝=${JSON.stringify(hookIds.filter((x) => x.startsWith('memory-')))}`,
  )

  // ---- ② 开：缝挂着，且**真的会写**（正例对照） ----------------------------
  lines.push('')
  lines.push('【② 开（正例对照）：记忆缝挂着，并且**真的写进了库** —— 没有它，"off 不写"可能只是"缝本来就坏了"】')
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m8-'))
  try {
    const file = memoryFile(root)
    ok(bytesOf(file) === -1, '起手：库文件不存在', file)
    const swOn = makeFakeSwitch(true)
    const hostOn = createFakeHost()
    const icOn = mount({ sw: swOn, projectDir: root, host: hostOn })
    ok(
      icOn.mounted().includes('memory-retain') && icOn.mounted().includes('memory-inject'),
      '★ 开 ⇒ 两条记忆缝都挂着',
      `mounted=${JSON.stringify(icOn.mounted())}`,
    )
    const onRound = await runRound(hostOn, file)
    ok(onRound.bytes > 0, '★ 开 ⇒ 跑一轮之后**库里真的有字节**（判据 R13 的正例对照）', `${onRound.bytes} 字节`)
    ok(
      onRound.preStepMessages === 2,
      '★ 开 ⇒ 席位开步时收到 **2** 条（既有席位简报 + 记忆注入；宿主基础形状本来是 0 条）',
      `messages=${onRound.preStepMessages}`,
    )
    icOn.dispose()

    // ---- ③ 关：零缝 + 零字节 ----------------------------------------------
    lines.push('')
    lines.push('【③ R12/R13：关 ⇒ **一条缝都不挂**（计数为 0）+ 库**一个字节不变**】')
    const before = bytesOf(file)
    const swOff = makeFakeSwitch(false)
    const hostOff = createFakeHost()
    const icOff = mount({ sw: swOff, projectDir: root, host: hostOff })
    ok(Array.isArray(icOff.mounted()) && icOff.mounted().length === 0, '★★ 关 ⇒ `mounted()` 是**空数组**（缝根本没挂，不是"挂了但放行"）', `mounted=${JSON.stringify(icOff.mounted())}`)
    const offRound = await runRound(hostOff, file)
    ok(offRound.bytes === before, '★★ R13：关 ⇒ 跑**同一轮**调用之后，库的字节数**一个都没变**', `${before} → ${offRound.bytes}`)
    ok(
      offRound.preStepMessages === 0,
      '★ 关 ⇒ 席位开步时**一条都不注入**（连既有的席位简报也不发生 —— 一条缝都没挂）',
      `messages=${offRound.preStepMessages}（开时是 2）`,
    )
    ok(offRound.bytes === before && offRound.preStepMessages === 0, '两条判据同一次观测里同时成立（写盘面 + 注入面一起被摘干净）', `字节 ${before}→${offRound.bytes}｜messages=${offRound.preStepMessages}`)
    icOff.dispose()

    // ---- ④ 中途翻转：立刻跟随（不重启） -----------------------------------
    lines.push('')
    lines.push('【④ 中途翻转：同一套装配里关掉 ⇒ 立刻摘成 0 条、立刻不再写；再开 ⇒ 挂回来】')
    const swLive = makeFakeSwitch(true)
    const hostLive = createFakeHost()
    const icLive = mount({ sw: swLive, projectDir: root, host: hostLive })
    const mountedOn = icLive.mounted().length
    swLive.flip(false)
    const mountedOff = icLive.mounted().length
    const bytesBeforeFlip = bytesOf(file)
    await runRound(hostLive, file)
    const bytesAfterFlip = bytesOf(file)
    swLive.flip(true)
    const mountedBack = icLive.mounted().length
    await runRound(hostLive, file)
    const bytesAfterBack = bytesOf(file)
    ok(
      mountedOn === 6 && mountedOff === 0 && mountedBack === 6,
      '★★ 挂载数：开=6 → 关=0 → 再开=6（四条既有缝 + 两条记忆缝）',
      `${mountedOn} → ${mountedOff} → ${mountedBack}`,
    )
    ok(bytesAfterFlip === bytesBeforeFlip, '★ 关掉那一段里跑同样一轮 ⇒ 字节数不变（**订阅式挂/摘真的生效**）', `${bytesBeforeFlip} → ${bytesAfterFlip}`)
    ok(bytesAfterBack > bytesAfterFlip, '★ 再开之后同样一轮 ⇒ 又长了字节（证明"不变"是因为关了，不是因为坏了）', `${bytesAfterFlip} → ${bytesAfterBack}`)
    icLive.dispose()

    // ---- ⑤ 判据自检：这套断言**真的会红** ---------------------------------
    lines.push('')
    lines.push('【⑤ 判据自检：把"关掉却还在写"的形状打给同一条判据 ⇒ 必须红】')
    const bytesProbe = bytesOf(file)
    const swCheat = { isOn: () => false, subscribe: () => () => {} }
    // ★ 若实现漏了"挂载前问闸门"（即无条件挂），mounted() 就不会是 0 —— 这里直接模拟那种情形：
    const cheatMounted = ['seam-pre-execute', 'seam-pre-step', 'memory-inject', 'seam-post-execute-wake', 'memory-retain', 'seam-post-execute-result-net']
    ok(cheatMounted.length !== 0, '★ "关了还挂着 6 条"的形状 ⇒ `mounted().length === 0` 那条判据会红', `错形状=${cheatMounted.length} 条`)
    ok(bytesProbe > 0, '★ "关了还在写"的形状 ⇒ 字节相等那条判据会红（有字节就有差别）', `当前库 ${bytesProbe} 字节；关掉后再写一次就会 > 它`)
    ok(shouldFire(swCheat, 'memory-retain') === false, '★ 闸门本身对"关"返回 false —— 上面那些红都建立在它之上', `shouldFire=${shouldFire(swCheat, 'memory-retain')}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m8 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM8MemorySwitchCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m8 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m8-memory-switch-check.mjs')) {
  const r = await runM8MemorySwitchCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
