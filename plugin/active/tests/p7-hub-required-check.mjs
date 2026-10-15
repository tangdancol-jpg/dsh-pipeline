/**
 * p7 · L3+ 强制主管：先设后撤 + 需求位派活判据
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p7-hub-required-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A19（pending 先设主管；tier ≥ L3 无主管时需求位派活被拒；
 *   tier < L3 时主管席位被撤销），以及裁定 1 / 定稿 §3.5 的四条细化判据。
 *
 * @module dsh-pipeline/tests/p7-hub-required-check
 */

import { BAD_TIER, TIER_ORDER, compareTier, isValidTier, isUnknownTier, tierAtLeast, tierOrdinal } from '../lib/tiers/tier-order.js'
import {
  HUB_ACTION,
  HUB_REQUIRED_FROM,
  SUPERVISOR_ROLE,
  checkOrchestratorDispatch,
  hubPlanOnOpen,
  hubPlanOnRequirementConfirmed,
  hubRequirementRecord,
} from '../lib/tiers/hub-required.js'
import { hubRequireMethods, hubSeatPresent, summarizeHubRequirement } from '../lib/store/hub-require.js'
import { ST } from '../lib/states.js'
import { ROLE } from '../lib/roles.js'

// ---------------------------------------------------------------------------
// 极简断言
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

function mkTask(over = {}) {
  return { id: 'T-hub', state: ST.PENDING, roster: null, history: [], ...over }
}

function mkStore(task) {
  const persisted = []
  const methods = hubRequireMethods({
    now: () => new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
    deny: (code, error, extra = {}) => ({ ok: false, code, error, ...extra }),
    loadTask: async () => task,
    persist: async (t) => {
      persisted.push(t.id)
    },
    audit: async (id, actor, action, extra) => ({ id, actor, action, extra }),
  })
  return { methods, persisted }
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('p7 · L3+ 强制主管：先设后撤 + 需求位派活判据')
  lines.push('='.repeat(78))

  // ---- ① 档位比较按序数 ------------------------------------------------------
  lines.push('')
  lines.push('【① 档位按**序数**比较（不是字符串）】')
  eq(TIER_ORDER.join(','), 'L0,L1,L2,L3,L4,L5', '档位表 = L0…L5')
  for (const [t, n] of [['L0', 0], ['L1', 1], ['L2', 2], ['L3', 3], ['L4', 4], ['L5', 5]]) {
    eq(tierOrdinal(t).ordinal, n, `${t} ⇒ ${n}`)
  }
  ok(tierOrdinal('l3').ok === true && tierOrdinal('l3').ordinal === 3, '小写也认')
  ok(tierOrdinal(' L4 ').ok === true, '两端空白也认')
  ok(isValidTier('L3') && !isValidTier('L9'), 'L3 合法、L9 不在表里')
  ok(tierOrdinal('L9').ok === true && tierOrdinal('L9').known === false, '★ L9 给出**序数 9**（表外档也排得出先后，不会静默判错）')
  eq(compareTier('L2', 'L3').cmp, -1, 'L2 < L3')
  eq(compareTier('L3', 'L3').cmp, 0, 'L3 = L3')
  eq(compareTier('L5', 'L3').cmp, 1, 'L5 > L3')
  eq(compareTier('L10', 'L3').cmp, 1, '★ L10 > L3（按序数；字符串比会说 L10 < L3 —— 这是本文件存在的理由）')
  ok(tierAtLeast('L3', HUB_REQUIRED_FROM) && tierAtLeast('L5', HUB_REQUIRED_FROM), 'L3 / L5 都 ≥ L3')
  ok(!tierAtLeast('L2', HUB_REQUIRED_FROM), 'L2 不 ≥ L3')
  eq(HUB_REQUIRED_FROM, 'L3', '强制主管的起点 = L3')
  eq(SUPERVISOR_ROLE, ROLE.SUPERVISOR, '★ 主管角色 id 与 roles.js 同源（不是手抄的字符串）')

  // ---- ② 非法 / 未知档位 -----------------------------------------------------
  lines.push('')
  lines.push('【② 非法档位拒、未知档位保守】')
  for (const bad of ['x', 'high', 'L', Number.NaN, Number.POSITIVE_INFINITY, -1, 3, true, {}]) {
    const r = tierOrdinal(bad)
    ok(r.ok === false && r.code === BAD_TIER, `tierOrdinal(${String(bad)}) ⇒ 拒绝`)
  }
  ok(isUnknownTier(undefined) && isUnknownTier(null) && isUnknownTier(''), '未知档位被单独认出来')
  ok(!isUnknownTier('L9'), '★ L9 是"认不出"，不是"未知"——两者不许混')
  const unknownPlan = hubPlanOnRequirementConfirmed({ tier: undefined, hasHubSeat: true })
  ok(unknownPlan.ok === true && unknownPlan.assumed === true && unknownPlan.tier === 'L2', '★ tier 未知 ⇒ 等同 L2（保守）')
  eq(unknownPlan.required, false, '未知按 L2 ⇒ 不强制主管（并标出是"猜的"）')
  eq(unknownPlan.action, HUB_ACTION.REVOKE, '未知按 L2 ⇒ 撤销')
  const badPlan = hubPlanOnRequirementConfirmed({ tier: 'L9x', hasHubSeat: true })
  ok(badPlan.ok === false && badPlan.code === BAD_TIER, '非法档位 ⇒ 拒绝')
  ok(String(badPlan.message).includes('不许'), '★ 拒绝文案写明"不许降级成那就不要主管了"', badPlan.message.split('\n')[1])

  // ---- ③ pending：先强制设主管（不做试算）----------------------------------
  lines.push('')
  lines.push('【③ pending：**先强制设主管**，且明确"不做试算"（裁定 1 / §3.5）】')
  const onOpen = hubPlanOnOpen({ by: 'main' })
  eq(onOpen.action, HUB_ACTION.FORCE, '开单动作 = force')
  eq(onOpen.requiredNow, true, '开单时就是"需要主管"')
  ok(onOpen.reason.includes('先强制设主管'), '理由写明"先强制设主管"')
  ok(onOpen.reason.includes('不做试算'), '★ 理由写明"刻意不做试算"，并解释了时序矛盾')

  const taskA = mkTask()
  const sA = mkStore(taskA)
  const forced = await sA.methods.hubForceOnOpen('T-hub', { by: 'main' })
  ok(forced.ok === true && forced.changed === true, '接到单就先把主管设上')
  eq(taskA.hub_requirement.forced, true, '账上记了 forced = true')
  ok(hubSeatPresent(taskA) === true, '★ "主管在册"成立（名单还是 null，靠账记着）')
  eq(sA.persisted.length, 1, '落盘一次')
  const forcedAgain = await sA.methods.hubForceOnOpen('T-hub', { by: 'main' })
  ok(forcedAgain.ok === true && forcedAgain.changed === false, '★ 幂等：再调一次 changed=false')
  eq(sA.persisted.length, 1, '幂等时**没有**再落盘')

  // 名单已在位时：会真的把 supervisor 写进名单
  const taskA2 = mkTask({ roster: { conversations: ['orchestrator', 'planner'] } })
  const sA2 = mkStore(taskA2)
  const forced2 = await sA2.methods.hubForceOnOpen('T-hub', { by: 'main' })
  eq(forced2.seat_added, true, '名单已在位时把 supervisor 写进名单')
  ok(taskA2.roster.conversations.includes(SUPERVISOR_ROLE), '名单里真的有了 supervisor')
  eq(taskA2.roster.conversations[0], SUPERVISOR_ROLE, '主管排在最前（它是接需求结论的那个人）')

  // ---- ④ requirement_confirmed：tier < L3 ⇒ 撤销主管 ------------------------
  lines.push('')
  lines.push('【④ ★ 档位落地：tier < L3 ⇒ **撤销主管席位**（裁定 1 / A19）】')
  const taskB = mkTask({ roster: { conversations: [SUPERVISOR_ROLE, 'orchestrator', 'planner', 'writer'] } })
  taskB.hub_requirement = hubRequirementRecord({ forced: true, forced_at: 'x' })
  const sB = mkStore(taskB)
  const revoke = await sB.methods.hubSyncOnRequirementConfirmed('T-hub', { tier: 'L1', by: 'main' })
  ok(revoke.ok === true, '同步成功', revoke.ok ? '' : revoke.error)
  eq(revoke.action, HUB_ACTION.REVOKE, '动作 = revoke')
  eq(revoke.seat_removed, true, '真的把席位从名单里拿掉了')
  ok(!taskB.roster.conversations.includes(SUPERVISOR_ROLE), '★ 名单里**没有** supervisor 了')
  eq(taskB.roster.conversations.length, 3, '★ 只动了主管那一个 —— 其余三个角色原样', taskB.roster.conversations.join(','))
  eq(hubSeatPresent(taskB), false, 'hubSeatPresent = false')
  ok(taskB.hub_requirement.revoked_at !== null, '账上记了撤销时刻')
  ok(summarizeHubRequirement(taskB).includes('已撤销'), '摘要如实说"已撤销"', summarizeHubRequirement(taskB))

  // L2 也撤（边界正好在 L3）
  const taskB2 = mkTask({ roster: { conversations: [SUPERVISOR_ROLE, 'orchestrator'] } })
  taskB2.hub_requirement = hubRequirementRecord({ forced: true })
  const sB2 = mkStore(taskB2)
  const revokeL2 = await sB2.methods.hubSyncOnRequirementConfirmed('T-hub', { tier: 'L2' })
  eq(revokeL2.action, HUB_ACTION.REVOKE, 'L2 也撤销（边界正好卡在 L3）')
  ok(!taskB2.roster.conversations.includes(SUPERVISOR_ROLE), 'L2 时席位也拿掉了')

  // ---- ⑤ tier ≥ L3 ⇒ 主管必须存在，否则需求位不可派 -------------------------
  lines.push('')
  lines.push('【⑤ ★ tier ≥ L3 且无主管 ⇒ **需求位派活被拒**（A19）】')
  const orphan = mkTask({ roster: { conversations: ['orchestrator', 'planner'] } })
  orphan.hub_requirement = hubRequirementRecord({ forced: false, tier: 'L3', ordinal: 3, required: true, action: HUB_ACTION.REQUIRE })
  eq(hubSeatPresent(orphan), false, '这个任务确实没有主管席位')
  const denied = checkOrchestratorDispatch({ tier: 'L3', hasHubSeat: false, requirementConfirmed: true })
  ok(denied.ok === false && denied.code === 'HUB_REQUIRED_MISSING_SUPERVISOR', '★ L3 无主管 ⇒ 拒绝（HUB_REQUIRED_MISSING_SUPERVISOR）')
  ok(denied.error.includes('主管席位不存在'), '拒绝文案点明"主管席位不存在"')
  ok(denied.error.includes('第①道'), '★ 文案解释了"为什么这条是硬的"（L3+ 必经第①道确认）', denied.error.split('\n')[1])
  ok(denied.error.includes('下一步'), '给了下一步（补席位 / 降档位）')

  const stillDenied = await mkStore(orphan).methods.hubCanDispatchOrchestrator('T-hub', { requirementConfirmed: true, by: 'main' })
  ok(stillDenied.ok === false && stillDenied.code === 'HUB_REQUIRED_MISSING_SUPERVISOR', 'store 层同样拦得住')
  ok(orphan.history.some((h) => h.action === 'hub:refuse_orchestrator_dispatch'), '★ 被拒也**留痕**（谁在什么时候被拦过）')

  // L4 / L5 同理
  ok(checkOrchestratorDispatch({ tier: 'L4', hasHubSeat: false, requirementConfirmed: true }).ok === false, 'L4 无主管也拒')
  ok(checkOrchestratorDispatch({ tier: 'L5', hasHubSeat: false, requirementConfirmed: true }).ok === false, 'L5 无主管也拒')

  // 有主管 ⇒ 放行
  const withHub = checkOrchestratorDispatch({ tier: 'L3', hasHubSeat: true, requirementConfirmed: true })
  ok(withHub.ok === true && withHub.required === true, '★ L3 **有主管** ⇒ 放行')
  // tier < L3 ⇒ 不需要主管，放行
  const lowTier = checkOrchestratorDispatch({ tier: 'L1', hasHubSeat: false, requirementConfirmed: true })
  ok(lowTier.ok === true && lowTier.required === false, 'L1 无主管照旧放行（低档位本来就不需要）')
  // 档位还没落地 ⇒ pending 时先强制设上的那个在场就放行
  const pendingOk = checkOrchestratorDispatch({ tier: null, hasHubSeat: true, requirementConfirmed: false })
  ok(pendingOk.ok === true, '档位未落地 + 主管在册 ⇒ 放行')
  const pendingNo = checkOrchestratorDispatch({ tier: null, hasHubSeat: false, requirementConfirmed: false })
  ok(pendingNo.ok === false, '★ 档位未落地 + 主管**不在册** ⇒ 也拒（"先强制设主管"没做）')

  // ---- ⑥ 先设 → 后撤 的完整一轮（真跑 store）--------------------------------
  lines.push('')
  lines.push('【⑥ 完整一轮：pending 先设 → L4 留下 → 派需求位 → 再降档撤销】')
  const taskC = mkTask({ roster: { conversations: ['planner'] } })
  const sC = mkStore(taskC)
  const c1 = await sC.methods.hubForceOnOpen('T-hub', { by: 'main' })
  ok(c1.ok === true && hubSeatPresent(taskC), '① pending：先强制设主管 ⇒ 在册')
  const c2 = await sC.methods.hubSyncOnRequirementConfirmed('T-hub', { tier: 'L4', by: 'main' })
  eq(c2.action, HUB_ACTION.KEEP, '② 档位 L4（≥ L3）⇒ 保留')
  eq(c2.required, true, '并要求"主管必须存在"')
  const c3 = await sC.methods.hubCanDispatchOrchestrator('T-hub', { requirementConfirmed: true, by: 'main' })
  ok(c3.ok === true, '③ 需求位可以派（主管在册）')
  const c4 = await sC.methods.hubSyncOnRequirementConfirmed('T-hub', { tier: 'L1', by: 'main' })
  eq(c4.action, HUB_ACTION.REVOKE, '④ 档位改成 L1 ⇒ 撤销')
  eq(c4.seat_removed, true, '⑤ 席位真的拿掉了')
  const c5 = await sC.methods.hubCanDispatchOrchestrator('T-hub', { requirementConfirmed: true, by: 'main' })
  ok(c5.ok === true && c5.required === false, '⑥ 低档位不再需要主管 ⇒ 需求位照旧可派')
  eq(taskC.hub_requirement.history.length, 3, '账上留了三条（force / keep / revoke）', JSON.stringify(taskC.hub_requirement.history.map((h) => h.action)))

  // ★ 撤销之后若档位又升回 L3 ⇒ 必须重新要求主管
  const c6 = await sC.methods.hubSyncOnRequirementConfirmed('T-hub', { tier: 'L3', by: 'main' })
  eq(c6.action, HUB_ACTION.REQUIRE, '★ 档位升回 L3 ⇒ 重新要求主管（不是"撤过就永远撤了"）')
  eq(c6.required, true, 'required = true')
  eq(hubSeatPresent(taskC), false, '此时席位确实不在册')
  const c7 = await sC.methods.hubCanDispatchOrchestrator('T-hub', { requirementConfirmed: true, by: 'main' })
  ok(c7.ok === false, '★ 于是需求位又被拦住 —— 先设后撤是**双向**的')

  const status = await sC.methods.hubRequirementStatus('T-hub')
  ok(status.ok === true && status.required === true && status.has_hub_seat === false, '状态查询如实报出"要求主管但没有席位"')

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p7 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))

  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * ★ 聚合跑入口（`tests/run-all.mjs` 登记用 —— `WIRING.md` §W8 的"前置改动"）。
 *
 * 与"直接跑"的区别只有两条：**不 `process.exit`**、把原始输出**收进 `text`** ——
 * 断言、计数、清理临时目录走的**完全是同一条路径**（所以登记不会改变被测行为）。
 *
 * ★ 每次调用先把三份模块级状态清零：聚合跑里同一模块只 import 一次，
 *   但清零是"重复调用不累加"的硬保证 —— 累加出来的通过率就是假绿。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runP7HubRequiredCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p7 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p7-hub-required-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，强制主管）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p7-hub-required-check.mjs')) {
  const r = await runP7HubRequiredCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
