/**
 * p9 · 需求位派活判据：`tier ≥ L3` 无主管 ⇒ 拒（W6 的**判据化**验证）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p9-orchestrator-dispatch-gate-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件测的不是"判据本身"，而是**接线处传对了没有**
 * ---------------------------------------------------------------------------
 * `checkOrchestratorDispatch()`（`lib/tiers/hub-required.js`）是纯策略，它早就对了。
 * 会错的是**调用点**：`lib/tools/dispatch.js` 给它喂的 `requirementConfirmed` 是什么。
 *
 * ★ 真事：按 `WIRING.md` §W6 原文喂 `task.state !== ST.PENDING` 时，`analyzing` 的单子
 *   档位还没落地（`hub_requirement.tier` 仍是 `null`）却被算成"已确认" ⇒
 *   `tierOrdinal(null)` ⇒ **`BAD_TIER` 误拒** —— 实测把 `reassign:true`（席位失联后唯一
 *   必然可用的恢复路径）挡死（`liveness-check` 三条正例全红）。
 *
 * 所以本文件**走工具的真实 `execute()`**，并用**探针**记录调用点实际传了什么参数 ——
 * 判据是"传进去的那个布尔值"，不是"读了代码觉得它传对了"。
 *
 * ---------------------------------------------------------------------------
 * 判据读的字段（唯一出处：`lib/store/hub-require.js` 的 `hubSeatPresent`）
 * ---------------------------------------------------------------------------
 *   · `task.hub_requirement.tier`  —— 档位有没有落地（`null` = 未落地）
 *   · `task.roster.conversations`  —— 名单里有没有 `supervisor`
 *   · `task.hub_requirement.forced` / `.revoked_at` —— 开单时"先强制设上"的那一席还在不在
 *
 * @module dsh-pipeline/tests/p9-orchestrator-dispatch-gate-check
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROLE } from '../lib/roles.js'
import { ST } from '../lib/states.js'
import { createTaskStore } from '../lib/store.js'
import { createTokenStore } from '../lib/tokens.js'
import { buildDispatchTools } from '../lib/tools/dispatch.js'

// ---------------------------------------------------------------------------
// 极简断言（每个测试文件自带一份）
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  }
}

function eq(actual, expected, title) {
  ok(actual === expected, title, `期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
}

/** 闸门拒绝时文案都长这样（判据本体给的，不是随便一句"不行"）。 */
const HUB_REFUSAL = '拒绝派需求位'

async function main() {
  lines.push('='.repeat(78))
  lines.push('p9 · 需求位派活判据（W6）：tier ≥ L3 无主管 ⇒ 拒；判据读的是哪个字段')
  lines.push('='.repeat(78))

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-p9-'))
  try {
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const tokens = createTokenStore()

    /**
     * ★★ **探针**：把 store 上那个方法包一层，记下**调用点实际传了什么**。
     *
     * 这是本文件的核心手法 —— 没有它，测的就只是"判据函数对不对"（它一直是对的），
     * 而真正会错的是"接线处喂了什么参数"。有了它，"传错了"会当场变红。
     */
    const seen = []
    const origVerdict = store.hubCanDispatchOrchestrator.bind(store)
    store.hubCanDispatchOrchestrator = async (taskId, input = {}) => {
      const verdict = await origVerdict(taskId, input)
      seen.push({ taskId, requirementConfirmed: input.requirementConfirmed === true, code: verdict.ok === true ? null : verdict.code })
      return verdict
    }

    // 工具：最小依赖包（只到"决定要不要放开 orchestrator"那一刻所需）
    /**
     * ★ 通道替身：**故意**在 `spawnRole` 上返回一个可读的失败。
     *
     * 为什么要有它：放行用例会一路走到"建会话"那一步。没有它，`transport.spawnRole`
     * 不是函数 ⇒ 抛进工具的统一 catch ⇒ 文案变成"内部错误（这是插件 bug）"，
     * 于是"判据放行了"和"别的地方崩了"在输出里分不开。
     * 有了它，放行用例拿到的是**下游的具名拒绝** —— 那就证明它真的越过了这道闸门。
     */
    const STUB_CHANNEL = '（p9 替身）未接真实派活通道'
    const transport = {
      // ★ 失败字段名是 `note`（`dispatch.js` 的 `summary: res.note`）——
      //   用 `error` 的话文案会被归置成空串，"越过了闸门"这句话就无从判断了。
      spawnRole: async () => ({ ok: false, note: STUB_CHANNEL, error: STUB_CHANNEL }),
      notifyRole: async () => ({ ok: false, note: STUB_CHANNEL, error: STUB_CHANNEL }),
    }
    const deps = {
      defineTool: (d) => d,
      config: {},
      store,
      tokens,
      transport,
      indexTask: () => {},
    }
    const { dispatch } = buildDispatchTools({
      deps,
      config: {},
      store,
      tokens,
      transport,
      indexTask: () => {},
      notifyOnly: async () => ({ ok: false, note: STUB_CHANNEL, error: STUB_CHANNEL }),
      load: (id) => store.get(id),
    })

    const mainToken = tokens.mint({ taskId: '*', role: ROLE.MAIN, agentId: null, note: 'p9' })

    /**
     * 造一张"已到需求分析中"的单，并按用例摆好 `hub_requirement` 与 `roster`。
     *
     * ★ 经 `store.recordAudit` 落盘（不是手改内存）—— 之后 `dispatch` 里的 `load()`
     *   读到的就是盘上那一份，与真机同一条路。
     */
    async function mkCase(id, { tier, seat, forced, conversations }) {
      const opened = await store.open({ id, requirement: `p9 用例 ${id}`, actorRole: ROLE.MAIN, actorAgentId: null })
      if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
      const t = await store.get(id)
      t.state = ST.ANALYZING
      t.roster = { tier: tier ?? '?', ai_count: conversations.length, conversations: [...conversations] }
      t.hub_requirement = {
        forced,
        forced_at: forced ? '2026-10-16T00:00:00Z' : null,
        forced_by: forced ? ROLE.MAIN : '',
        tier,
        ordinal: null,
        assumed: false,
        required: false,
        action: forced ? 'force' : 'keep',
        revoked_at: forced ? null : '2026-10-16T00:00:00Z',
        revoked_reason: forced ? '' : '用例：档位 < L3 撤销',
        history: [],
      }
      await store.recordAudit(id, ROLE.MAIN, 'fixture:p9', { tier, seat, forced })
      return { id, token: tokens.mint({ taskId: id, role: ROLE.MAIN, agentId: null, note: 'p9-case' }).token }
    }

    /** 调一次真实的 `pipeline_dispatch`（走工具的 execute，即真机那条路）。 */
    async function callDispatch(id, token) {
      /**
       * ★ 传一个**最小的 exec**（`{agent:{id}}`）：不传的话放行路径往下一站走时
       *   会 `exec.agent` 崩成"内部错误"，那样"这条判据没拦"就与"别的地方崩了"
       *   混在一起，读不出结论。给了它，放行用例拿到的是**下游自己的**判词。
       */
      return dispatch.execute(
        { task_id: id, role: ROLE.ORCHESTRATOR, role_token: token },
        { agent: { id: 'p9-main' } },
      )
    }

    // ---- ① 判据本体：输入 → 输出（基线，不带探针）-----------------------------
    lines.push('')
    lines.push('【① 判据本体（纯策略）：什么输入拒、什么放行】')
    const { checkOrchestratorDispatch } = await import('../lib/tiers/hub-required.js')
    const table = [
      ['L3', false, true, false, 'HUB_REQUIRED_MISSING_SUPERVISOR'],
      ['L3', true, true, true, null],
      ['L4', false, true, false, 'HUB_REQUIRED_MISSING_SUPERVISOR'],
      ['L2', false, true, true, null],
      [null, false, false, false, 'HUB_REQUIRED_MISSING_SUPERVISOR'],
      [null, true, false, true, null],
    ]
    lines.push('      tier  有主管  已落地   放行?  拒绝码')
    for (const [tier, has, confirmed, allow, code] of table) {
      const v = checkOrchestratorDispatch({ tier, hasHubSeat: has, requirementConfirmed: confirmed })
      const gotAllow = v.ok === true
      const gotCode = v.ok === true ? null : v.code
      ok(gotAllow === allow && gotCode === code, `tier=${String(tier)} 有主管=${has} 已落地=${confirmed} ⇒ ${allow ? '放行' : `拒 ${code}`}`, v.ok === true ? `required=${v.required}` : String(v.error).split('\n')[0])
      lines.push(`      ${String(tier).padEnd(6)}${String(has).padEnd(8)}${String(confirmed).padEnd(9)}${String(gotAllow).padEnd(7)}${gotCode ?? '-'}`)
    }

    // ---- ② 接线处：工具真的按上面的判据拦/放 -----------------------------------
    lines.push('')
    lines.push('【② 接线处（真跑 pipeline_dispatch）：拒的时候真的拒，放的时候不拦】')

    // 用例 A：tier=L3，名单里没有 supervisor，先设的那一席也被撤了 ⇒ 拒
    const A = await mkCase('T-P9-A', { tier: 'L3', seat: false, forced: false, conversations: [ROLE.ORCHESTRATOR, ROLE.WRITER, ROLE.TESTER] })
    seen.length = 0
    const ra = await callDispatch(A.id, A.token)
    eq(ra.ok, false, '★ 用例 A（L3 + 无主管）⇒ 需求位**被拒**')
    ok(String(ra.summary).includes(HUB_REFUSAL), '★ 拒绝文案就是这条判据给的（"拒绝派需求位"）', String(ra.summary).split('\n')[0])
    eq(seen.at(-1)?.requirementConfirmed, true, '★ 探针：调用点传进去的 requirementConfirmed = true（档位已落地）')
    eq(seen.at(-1)?.code, 'HUB_REQUIRED_MISSING_SUPERVISOR', '★ 判据码 = HUB_REQUIRED_MISSING_SUPERVISOR')

    // 用例 B：tier=L3，名单里有 supervisor ⇒ 放行
    const B = await mkCase('T-P9-B', { tier: 'L3', seat: true, forced: false, conversations: [ROLE.SUPERVISOR, ROLE.ORCHESTRATOR, ROLE.WRITER] })
    seen.length = 0
    const rb = await callDispatch(B.id, B.token)
    ok(!String(rb.summary).includes(HUB_REFUSAL), '★ 用例 B（L3 + 有主管）⇒ **这条判据没有拦**', String(rb.summary).split('\n')[0])
    eq(seen.at(-1)?.code, null, '★ 探针：判据本身返回放行（code=null）')

    // 用例 C：档位**未落地**（tier=null）且没有主管席位 ⇒ 拒，但码不是 BAD_TIER
    const C = await mkCase('T-P9-C', { tier: null, seat: false, forced: false, conversations: [ROLE.ORCHESTRATOR, ROLE.WRITER] })
    seen.length = 0
    const rc = await callDispatch(C.id, C.token)
    eq(rc.ok, false, '用例 C（档位未落地 + 无主管）⇒ 被拒')
    eq(seen.at(-1)?.requirementConfirmed, false, '★★ 探针：调用点传的 requirementConfirmed = **false**（档位没落地）')
    eq(seen.at(-1)?.code, 'HUB_REQUIRED_MISSING_SUPERVISOR', '★★ 拒绝码是"没有主管"，**不是** BAD_TIER —— 这正是本次偏离 WIRING 原文的判据')
    ok(!String(ra.summary).includes('档位未知'), '★ 文案里不该出现"档位未知（未编排）"（那是照原文写会踩的坑）')

    // 用例 D：档位未落地，但**开单时先强制设上的那一席还在** ⇒ 放行（W4 的"先设"）
    const D = await mkCase('T-P9-D', { tier: null, seat: true, forced: true, conversations: [ROLE.ORCHESTRATOR, ROLE.WRITER] })
    seen.length = 0
    const rd = await callDispatch(D.id, D.token)
    ok(!String(rd.summary).includes(HUB_REFUSAL), '★★ 用例 D（档位未落地 + 先设的主管在册）⇒ **不拦**（席位失联后 reassign 走的就是这条路）', String(rd.summary).split('\n')[0])
    eq(seen.at(-1)?.requirementConfirmed, false, '★ 探针：仍然传 false（未落地就是未落地，不因为放行就改判）')
    eq(seen.at(-1)?.code, null, '★ 判据返回放行')
    ok(String(rd.summary).includes(STUB_CHANNEL), '★★ 而且它**真的走过了闸门** —— 拿到的是下游（替身通道）的具名拒绝，不是被这道判据挡下的', String(rd.summary).split('\n')[0])

    // 用例 E：tier=L1（低档）⇒ 放行（低档单子走主对话直接调度那条链）
    const E = await mkCase('T-P9-E', { tier: 'L1', seat: true, forced: false, conversations: [ROLE.SUPERVISOR, ROLE.ORCHESTRATOR] })
    seen.length = 0
    const re = await callDispatch(E.id, E.token)
    ok(!String(re.summary).includes(HUB_REFUSAL), '用例 E（L1 + 有主管）⇒ 不拦')
    eq(seen.at(-1)?.code, null, '★ 判据返回放行（required=false）')

    // ---- ③ 偏离本身也是**可执行**的判据：照 WIRING 原文会得到什么 --------------
    lines.push('')
    lines.push('【③ 偏离的依据（代码判定）：照 WIRING §W6 原文喂参数会得到什么】')
    const wrongC = await origVerdict(C.id, { requirementConfirmed: C.id !== '' ? true : false })
    ok(wrongC.ok === false && wrongC.code === 'BAD_TIER', '★ 同一张"档位未落地"的单，若按 `state !== PENDING` 喂 true ⇒ **BAD_TIER 误拒**（这就是偏离的依据）', `${wrongC.code}：${String(wrongC.error).split('\n')[0]}`)
    const wrongD = await origVerdict(D.id, { requirementConfirmed: true })
    ok(wrongD.ok === false && wrongD.code === 'BAD_TIER', '★★ 用例 D（先设的主管在册、本该放行）照原文同样被 BAD_TIER 挡死 —— 正是 liveness 三条正例红的形状', `${wrongD.code}：${String(wrongD.error).split('\n')[0]}`)
    const rightD = await origVerdict(D.id, { requirementConfirmed: false })
    ok(rightD.ok === true, '★ 而按"档位是否落地"喂 false ⇒ 放行（同一个判据、同一个任务，只差喂进去的那个布尔）')

    // ---- ④ 只对 orchestrator 判：别的角色不受这条影响 --------------------------
    lines.push('')
    lines.push('【④ 作用域：这条判据只挂需求位】')
    seen.length = 0
    const other = await dispatch.execute({ task_id: A.id, role: ROLE.WRITER, role_token: A.token }, undefined)
    eq(seen.length, 0, '★ 派 writer 时**根本没调**这条判据（零次）')
    ok(String(other.summary).length > 0, '而且照常给出它自己的判词（不是被这条挡的）', String(other.summary).split('\n')[0])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p9 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))

  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * ★ 聚合跑入口（`tests/run-all.mjs` 登记用 —— `WIRING.md` §W8 的"前置改动"）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runP9OrchestratorDispatchGateCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p9 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p9-orchestrator-dispatch-gate-check.mjs` —— 打印原文 + 退出码。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p9-orchestrator-dispatch-gate-check.mjs')) {
  const r = await runP9OrchestratorDispatchGateCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
