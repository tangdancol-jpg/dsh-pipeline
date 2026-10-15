/**
 * p6 · DEMO 阶段：三档策略 + 未确认不得进 ready_dev + 三条软约束
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p6-demo-phase-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A16（L0/L1 跳过、L2 询问、L3+ 必须出）、A17（未确认 ⇒ 进 ready_dev 被拒，
 *   且原因可读）、A18（无轮次硬上限 + 三条软约束），以及边界
 *   「tier 未知按 L2 保守」「tier 非法/非有限值 ⇒ 拒绝，不得降级成跳过 DEMO」。
 *
 * @module dsh-pipeline/tests/p6-demo-phase-check
 */

import { DEMO_ACTION, demoPlanFor, demoRequiredForTier } from '../lib/states/demo-tier-policy.js'
import { DEMO_EVENTS, DEMO_ROUND_CAP, DEMO_ST, demoPhaseMerge, demoTransitions, isDemoState } from '../lib/states/demo-phase.js'
import { DEMO_CODES, checkDemoConfirm, checkDemoRound, demoStateOf, digestOf, summarizeDemo } from '../lib/store/demo-rounds.js'
import { DEMO_GATE_GUARD, DEMO_ROUND_GUARD, demoConfirmed, demoGate, demoGateReason, demoPlanOfTask } from '../lib/guard/demo-gate.js'
import { demoMethods } from '../lib/store/demo.js'
import { createTaskStore } from '../lib/store.js'
import { ST, STATE_LABEL } from '../lib/states.js'
import { ROLE } from '../lib/roles.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** 造一个最小的任务替身（只带 DEMO 账本需要的字段 + 人工请求表）。 */
function mkTask(over = {}) {
  return { id: 'T-demo', state: ST.PLANNING, human_requests: [], history: [], ...over }
}

/** 一条"已答复"的人工请求。 */
function answered(id) {
  return { request_id: id, status: 'answered', from_role: ROLE.MAIN, reason_kind: 'demo_review', answer_text: '看过了，可以' }
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('p6 · DEMO 阶段：三档策略 + ready_dev 闸门 + 三条软约束')
  lines.push('='.repeat(78))

  // ---- ① 三档策略（A16）----------------------------------------------------
  lines.push('')
  lines.push('【① 三档策略：L0–L1 可跳 / L2 询问 / L3+ 必须出（A16）】')
  for (const t of ['L0', 'L1']) {
    const p = demoPlanFor(t)
    ok(p.ok === true && p.action === DEMO_ACTION.SKIP, `${t} ⇒ skip（可跳）`, `action=${p.action}`)
    eq(p.assumed, false, `${t} 不是"猜的"`)
  }
  const l2 = demoPlanFor('L2')
  ok(l2.ok === true && l2.action === DEMO_ACTION.ASK, 'L2 ⇒ ask（发人工请求询问）', `action=${l2.action}`)
  for (const t of ['L3', 'L4', 'L5']) {
    const p = demoPlanFor(t)
    ok(p.ok === true && p.action === DEMO_ACTION.REQUIRE, `${t} ⇒ require（必须出）`, `action=${p.action}`)
    eq(demoRequiredForTier(t), true, `${t} 判定为"必须出 DEMO"`)
  }
  eq(demoRequiredForTier('L2'), false, 'L2 不算"必须出"')
  ok(demoPlanFor('L3').reason.includes('未获用户确认不得进'), 'L3 的理由里点明了 ready_dev 闸门', demoPlanFor('L3').reason)
  ok(demoPlanFor('l3').ok === true && demoPlanFor('l3').action === DEMO_ACTION.REQUIRE, '小写 l3 也认（归一成大写）')
  ok(demoPlanFor(' L4 ').ok === true, '两端空白也认')

  // ---- ② 边界：tier 未知按 L2 保守 ------------------------------------------
  lines.push('')
  lines.push('【② 边界：tier 未知 ⇒ 按最保守（等同 L2），**不得静默跳过 DEMO**】')
  for (const unknown of [undefined, null, '', '   ']) {
    const p = demoPlanFor(unknown)
    ok(p.ok === true && p.tier === 'L2' && p.action === DEMO_ACTION.ASK && p.assumed === true,
      `tier=${JSON.stringify(unknown)} ⇒ L2/ask（assumed=true）`, `action=${p.action}`)
    ok(p.reason.includes('不得静默跳过'), '理由里写明"不得静默跳过 DEMO"')
  }
  ok(demoPlanFor(undefined).action !== DEMO_ACTION.SKIP, '★ 未知**绝不**被当成 skip')

  // ---- ③ 边界：tier 非法/非有限 ⇒ 拒绝，不得降级成跳过 ----------------------
  lines.push('')
  lines.push('【③ 边界：tier 非法 / 非有限值 ⇒ **拒绝**（不得降级成"跳过 DEMO"）】')
  for (const bad of ['L9', 'x', 'high', 'L', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 3, true, {}]) {
    const p = demoPlanFor(bad)
    ok(p.ok === false && p.code === 'BAD_TIER', `tier=${String(bad)} ⇒ 拒绝（BAD_TIER）`)
    ok(p.action === undefined, `★ tier=${String(bad)} **没有**被降级成 skip/ask`)
  }
  ok(String(demoPlanFor('L9').message).includes('不得降级'), '拒绝文案里写明"不得降级成跳过 DEMO"')

  // ---- ④ 新状态与新迁移 ------------------------------------------------------
  lines.push('')
  lines.push('【④ 新状态与新迁移：四条边并进状态机（`WIRING.md` §W1 已接线）】')
  eq(DEMO_ST.BUILDING, 'demo_building', '新状态 1 = demo_building')
  eq(DEMO_ST.CONFIRM, 'demo_confirm', '新状态 2 = demo_confirm')
  ok(isDemoState('demo_building') && isDemoState('demo_confirm'), 'isDemoState 两个都认')
  ok(!isDemoState(ST.READY_DEV), '既有状态不被误认为 DEMO 状态')
  /**
   * ★★ 本条是 W1 **接线前后**的判据换向，不是"把红改成绿"。
   *
   *   接线之前这里断言的是 `!Object.values(ST).includes('demo_building')` ——
   *   它当初钉的是一个**事实**："既有 states.js 里没有这两个状态，所以只能给合并器，
   *   不接线就是不生效"。`WIRING.md` §W1 明写了接线之后那条断言会变红、
   *   且"应当把它改成已接线的断言（这是预期的红，不是回归）"。
   *
   *   ★ 换向之后它仍然**会红**：只要有人把 W1 那几行从 `states.js` 撤掉。
   *     换句话说，它测的还是原来那件事（"这两个状态在不在真状态机里"），
   *     只是结论方向反了。
   */
  ok(Object.values(ST).includes(DEMO_ST.BUILDING) && Object.values(ST).includes(DEMO_ST.CONFIRM),
    '★ `states.js` 的 `ST` 里**已经有**这两个状态（W1 已接线；撤掉那几行本条即红）')
  eq(ST.DEMO_BUILDING, DEMO_ST.BUILDING, 'ST.DEMO_BUILDING 与 demo-phase.js 同值（不是手抄的第二份）')
  ok(String(STATE_LABEL[DEMO_ST.BUILDING] ?? '').length > 0 && String(STATE_LABEL[DEMO_ST.CONFIRM] ?? '').length > 0,
    '★ 两个状态在 `STATE_LABEL` 里都有中文名（否则 `pipeline_status` 只会显示英文 id）',
    `${STATE_LABEL[DEMO_ST.BUILDING]} / ${STATE_LABEL[DEMO_ST.CONFIRM]}`)

  const merged = demoPhaseMerge({ ST, ROLE })
  eq(merged.transitions.length, 4, '合并器给出 4 条边')
  eq(merged.states.DEMO_BUILDING, 'demo_building', 'states 里带 DEMO_BUILDING')
  eq(Object.keys(merged.labels).length, 2, 'labels 里带两个中文名')
  const t4 = merged.transitions
  const confirmEdge = t4.find((t) => t.event === DEMO_EVENTS.CONFIRM)
  eq(confirmEdge.to, ST.READY_DEV, '★ 确认边落在 ready_dev')
  eq(confirmEdge.guard, DEMO_GATE_GUARD, '★ 确认边挂的闸门就是 demo_confirmed')
  const startEdge = t4.find((t) => t.event === DEMO_EVENTS.START)
  eq(startEdge.from, ST.PLANNING, '起点边从 planning 出发')
  eq(startEdge.guard, 'plan_ready', '起点边复用既有 plan_ready（不自创一份计划判据）')
  const rework = t4.find((t) => t.event === DEMO_EVENTS.REWORK)
  eq(rework.from, DEMO_ST.CONFIRM, '重做边从 demo_confirm 出发')
  eq(rework.to, DEMO_ST.BUILDING, '重做边回到 demo_building（可以无限轮）')
  ok(t4.every((t) => typeof t.note === 'string' && t.note.length > 0), '每条边都写了 note（与既有表项同形）')
  ok(t4.every((t) => Array.isArray(t.by) && t.by.length > 0), '每条边都有 by 名单')
  const rawTransitions = demoTransitions({ ST, ROLE })
  ok(rawTransitions.length === 4, 'demoTransitions 与 merge 同源')
  let threw = false
  try {
    demoTransitions({})
  } catch {
    threw = true
  }
  ok(threw, '不注入 ST/ROLE 时抛错（避免"两份 ST 常量"的漂移）')

  // ---- ⑤ 无轮次硬上限 + 软约束①：原地重交被拒（A18）------------------------
  lines.push('')
  lines.push('【⑤ 无轮次硬上限 + 软约束①：原地重交被拒（A18）】')
  eq(DEMO_ROUND_CAP, null, '★ 轮次硬上限是显式 null（"不设上限"是结论，不是忘了设）')
  const capGuards = t4.map((t) => String(t.guard)).filter((g) => /cap|limit|max|quota/i.test(g))
  eq(capGuards.length, 0, '★ 四条边里**没有任何**"轮次上限"类闸门', `闸门名单：${t4.map((t) => t.guard).join(' / ')}`)
  ok(/不设轮次硬上限|无轮次硬上限/.test(String(rework.note)), '★ 重做边上写明了"不设轮次硬上限"', rework.note)

  const task = mkTask()
  task.human_requests.push(answered('HR-1'), answered('HR-2'), answered('HR-3'))
  const r1 = checkDemoRound(task, { deliverable: { ref: 'demo/index.html', content: '<h1>v1</h1>' }, human_request_id: 'HR-1' })
  ok(r1.ok === true && r1.index === 1, '第 1 轮通过（新交付物 + 挂了请求）', r1.ok ? '' : r1.error)
  eq(r1.cap, null, '这一轮的判据里也带上了"无上限"')

  // 手工把第 1 轮记进账本，模拟 store 写盘后的状态
  task.demo = { plan: null, rounds: [{ index: 1, digest: r1.digest, ref: 'demo/index.html', human_request_id: 'HR-1', at: 't', by: 'writer' }] }
  const dup = checkDemoRound(task, { deliverable: { ref: 'demo/index.html', content: '<h1>v1</h1>' }, human_request_id: 'HR-2' })
  ok(dup.ok === false && dup.code === DEMO_CODES.DUPLICATE, '★ 同一份东西再交一遍 ⇒ 被拒（DEMO_DUPLICATE_DELIVERABLE）')
  ok(dup.error.includes('原地重交'), '拒绝文案点明"原地重交"', dup.error.split('\n')[0])
  ok(dup.error.includes('无轮次上限') || dup.error.includes('不设轮次上限') || dup.error.includes('轮次上限'), '★ 文案解释了"为什么这条比轮次上限更要紧"')

  const r2 = checkDemoRound(task, { deliverable: { ref: 'demo/index.html', content: '<h1>v2</h1>' }, human_request_id: 'HR-2' })
  ok(r2.ok === true && r2.index === 2, '同一路径但**内容变了** ⇒ 是新交付物，通过')
  task.demo.rounds.push({ index: 2, digest: r2.digest, ref: 'demo/index.html', human_request_id: 'HR-2', at: 't', by: 'writer' })

  // ★ 连做 8 轮，一轮都不因"轮次"被拒
  let allOk = true
  for (let i = 3; i <= 10; i += 1) {
    const r = checkDemoRound(task, { deliverable: { ref: `demo/v${i}.html`, content: `<h1>v${i}</h1>` }, human_request_id: `HR-${i}` })
    if (r.ok !== true) allOk = false
    else task.demo.rounds.push({ index: r.index, digest: r.digest, ref: `demo/v${i}.html`, human_request_id: `HR-${i}`, at: 't', by: 'writer' })
  }
  ok(allOk, '★ **连续 8 轮全部通过** —— 没有任何"轮次太多"的判断（无硬上限）')
  eq(task.demo.rounds.length, 10, '账本上记到第 10 轮')

  // ---- ⑥ 软约束②：每轮必须挂一条人工请求 ------------------------------------
  lines.push('')
  lines.push('【⑥ 软约束②：每轮必须挂上一条人工请求】')
  const noReq = checkDemoRound(task, { deliverable: { ref: 'demo/new.html', content: 'x' } })
  ok(noReq.ok === false && noReq.code === DEMO_CODES.NO_HUMAN_REQUEST, '没挂请求 ⇒ 被拒（DEMO_NO_HUMAN_REQUEST）')
  const blankReq = checkDemoRound(task, { deliverable: { ref: 'demo/new.html', content: 'x' }, human_request_id: '   ' })
  ok(blankReq.ok === false && blankReq.code === DEMO_CODES.NO_HUMAN_REQUEST, '请求 id 是空白 ⇒ 也拒')
  const noDeliverable = checkDemoRound(task, { human_request_id: 'HR-9' })
  ok(noDeliverable.ok === false && noDeliverable.code === DEMO_CODES.NO_DELIVERABLE, '没交付物 ⇒ 被拒（"什么都没交"连"新"都谈不上）')

  // ---- ⑦ ★ 闸门：未确认不得进 ready_dev（A17）------------------------------
  lines.push('')
  lines.push('【⑦ ★ 闸门：未获用户确认 ⇒ 向 ready_dev 的推进被拒（A17）】')
  const fresh = mkTask()
  const g0 = demoGate(fresh)
  ok(g0.ok === false && g0.code === 'DEMO_NOT_DELIVERED', '一轮都没交过 ⇒ 被拒（DEMO_NOT_DELIVERED）')
  ok(g0.error.includes('用户确认后'), '拒绝文案引了用户口径', g0.error.split('\n')[0])
  ok(String(demoGateReason(fresh)).length > 0, 'demoGateReason 总是给人话（可读）')

  const delivered = mkTask()
  delivered.demo = { plan: { tier: 'L3', action: 'require' }, rounds: [{ index: 1, digest: 'd1', ref: 'demo/a.html', human_request_id: 'HR-1' }] }
  const g1 = demoGate(delivered)
  ok(g1.ok === false && g1.code === 'DEMO_NOT_CONFIRMED', '交过但**没确认** ⇒ 被拒（DEMO_NOT_CONFIRMED）')
  ok(g1.error.includes('未获用户确认') || g1.error.includes('还没获得用户确认'), '拒绝文案写明"还没获得用户确认"')
  ok(g1.error.includes('pipeline_demo { action: "confirm"'), '★ 文案给了**下一步的具体调法**（可读不是"顺手写一句"）')
  eq(demoConfirmed(delivered), false, 'demoConfirmed = false')

  // 有确认动作、但**请求还没答复** ⇒ 仍被拒（转告 ≠ 答复）
  const answeredOnly = mkTask({ human_requests: [{ request_id: 'HR-1', status: 'relayed' }] })
  answeredOnly.demo = { rounds: [{ index: 1, digest: 'd1', human_request_id: 'HR-1' }], confirmed_at: '2026-10-15T12:00:00Z', confirm_request_id: 'HR-1' }
  const g2 = demoGate(answeredOnly)
  ok(g2.ok === false && g2.code === 'DEMO_CONFIRM_NOT_ANSWERED', '★ 有确认动作但请求只是 relayed ⇒ 仍被拒（转告 ≠ 答复）')
  ok(g2.error.includes('转告 ≠ 答复'), '拒绝文案点明了这条判据的依据')

  // 请求 answered ⇒ 放行
  const done = mkTask({ human_requests: [answered('HR-1')] })
  done.demo = { rounds: [{ index: 1, digest: 'd1', human_request_id: 'HR-1' }], confirmed_at: '2026-10-15T12:00:00Z', confirm_request_id: 'HR-1' }
  const g3 = demoGate(done)
  ok(g3.ok === true, '★ 用户真的答复了 ⇒ **放行**（可以进 ready_dev）', g3.ok ? '' : g3.error)
  eq(g3.round_index, 1, '放行时报出确认的是第几轮')
  eq(demoConfirmed(done), true, 'demoConfirmed = true')
  ok(demoGateReason(done).includes('已获用户确认'), '放行时的人话也对')

  // 确认指向一条不存在的请求 ⇒ 被拒（凭据没了）
  const ghost = mkTask()
  ghost.demo = { rounds: [{ index: 1, digest: 'd1', human_request_id: 'HR-1' }], confirmed_at: 'x', confirm_request_id: 'HR-ghost' }
  ok(demoGate(ghost).code === 'DEMO_CONFIRM_REQUEST_NOT_FOUND', '确认指向不存在的请求 ⇒ 被拒')

  // ---- ⑧ 确认本身也要"认轮次" ------------------------------------------------
  lines.push('')
  lines.push('【⑧ 确认必须认准某一轮（不是"点个头就算"）】')
  const c0 = checkDemoConfirm(mkTask(), { round_index: 1, request_id: 'HR-1' })
  ok(c0.ok === false && c0.code === DEMO_CODES.NO_ROUND, '一轮都没交就"确认" ⇒ 被拒（空头支票）')
  const c1 = checkDemoConfirm(delivered, { round_index: 7, request_id: 'HR-1' })
  ok(c1.ok === false && c1.code === 'DEMO_CONFIRM_BAD_ROUND', '确认一个不存在的轮次 ⇒ 被拒')
  const c2 = checkDemoConfirm(delivered, { round_index: 1, request_id: 'HR-9' })
  ok(c2.ok === false && c2.code === 'DEMO_CONFIRM_REQUEST_MISMATCH', '请求 id 与那一轮挂的对不上 ⇒ 被拒')
  const c3 = checkDemoConfirm(delivered, { round_index: 1, request_id: 'HR-1', answer_source: 'guessed' })
  ok(c3.ok === false && c3.code === 'DEMO_CONFIRM_BAD_SOURCE', '答复来源非法 ⇒ 被拒')
  const c4 = checkDemoConfirm(delivered, { round_index: 1, request_id: 'HR-1' })
  ok(c4.ok === true, '都对得上 ⇒ 通过', c4.ok ? '' : c4.error)

  // ---- ⑨ 软约束③：cancel 出口可用 -------------------------------------------
  lines.push('')
  lines.push('【⑨ 软约束③：cancel 出口在 DEMO 阶段可用 + 档位未定时不跳过】')
  const { TRANSITIONS } = await import('../lib/states.js')
  const cancelEdge = TRANSITIONS.find((t) => t.event === 'cancel' && t.from === '*')
  ok(cancelEdge !== undefined, '★ 既有状态机里 `cancel` 是 `from: "*"` ⇒ 两个新状态**自动**拿到 cancel 出口')
  eq(cancelEdge.to, ST.CANCELLED, 'cancel 落到 cancelled')
  ok(cancelEdge.by.includes('main') && cancelEdge.by.includes('human'), '主对话与用户都能取消')

  const noPlan = demoPlanOfTask(mkTask())
  eq(noPlan.action, 'ask', '★ 任务上还没算过档位 ⇒ 按 ask（等同 L2）保守处理')
  eq(noPlan.assumed, true, '并标出这是"猜的"')
  ok(noPlan.reason.includes('不得静默跳过'), '理由里写明不得静默跳过')

  // ---- ⑩ store 层：写盘 + 留痕（真跑）----------------------------------------
  lines.push('')
  lines.push('【⑩ store 层写盘：记档位 / 交轮次 / 记确认（真跑，含落盘留痕）】')
  const storeTask = mkTask({ human_requests: [{ request_id: 'HR-a', status: 'relayed' }] })
  const persisted = []
  const methods = demoMethods({
    now: () => new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
    deny: (code, error, extra = {}) => ({ ok: false, code, error, ...extra }),
    loadTask: async () => storeTask,
    persist: async (t) => {
      persisted.push(t.id)
    },
    audit: async (id, actor, action, extra) => ({ id, actor, action, extra }),
  })

  const p1 = await methods.demoPlan('T-demo', { tier: 'L3', by: 'main' })
  ok(p1.ok === true && p1.plan.tier === 'L3' && p1.plan.action === 'require', '记下 L3 ⇒ require')
  eq(persisted.length, 1, '落盘了一次')
  const pBad = await methods.demoPlan('T-demo', { tier: 'L9' })
  ok(pBad.ok === false && pBad.code === 'BAD_TIER', '非法档位在 store 层也被拒')
  eq(persisted.length, 1, '★ 被拒时**没有**落盘')

  const roundA = await methods.demoRound('T-demo', { deliverable: { ref: 'demo/a.html', content: 'v1' }, human_request_id: 'HR-a', by: 'writer' })
  ok(roundA.ok === true && roundA.round.index === 1, 'store 层交第 1 轮成功')
  eq(persisted.length, 2, '又落盘一次')
  const roundDup = await methods.demoRound('T-demo', { deliverable: { ref: 'demo/a.html', content: 'v1' }, human_request_id: 'HR-a', by: 'writer' })
  ok(roundDup.ok === false && roundDup.code === DEMO_CODES.DUPLICATE, 'store 层原地重交被拒')
  eq(persisted.length, 2, '★ 被拒时**没有**落盘')

  const confirmBad = await methods.demoConfirm('T-demo', { round_index: 1, request_id: 'HR-a' })
  ok(confirmBad.ok === false && confirmBad.code === 'DEMO_CONFIRM_NOT_ANSWERED', '★ 请求只是 relayed ⇒ 确认被拒（转告 ≠ 答复）', confirmBad.error?.split('\n')[0])
  const st = demoStateOf(storeTask)
  eq(st.confirmed_at, null, '★ 被拒之后 confirmed_at 仍是 null')
  eq(demoGate(storeTask).ok, false, '★ 闸门照旧拦着')

  storeTask.human_requests = [answered('HR-a')]
  const confirmOk = await methods.demoConfirm('T-demo', { round_index: 1, request_id: 'HR-a', answer_source: 'user', by: 'main' })
  ok(confirmOk.ok === true, '请求已答复后确认成功', confirmOk.ok ? '' : confirmOk.error)
  eq(demoGate(storeTask).ok, true, '★ 确认之后闸门放行')

  const round2 = await methods.demoRound('T-demo', { deliverable: { ref: 'demo/b.html', content: 'v2' }, human_request_id: 'HR-a', by: 'writer' })
  ok(round2.ok === true, '再交一轮（用户又要改）成功')
  eq(demoStateOf(storeTask).confirmed_at, null, '★ 新的一轮 ⇒ 上一次确认**作废**（确认认的是具体哪一版）')
  eq(demoGate(storeTask).ok, false, '★ 闸门重新拦上')

  ok(summarizeDemo(storeTask).includes('无轮次上限'), '摘要里写明"无轮次上限"', summarizeDemo(storeTask))
  const dg = methods.checkDemoPrecondition(storeTask, DEMO_GATE_GUARD)
  ok(dg.ok === false, 'checkDemoPrecondition 能直接给状态机用（与闸门同一份实现）')

  // ---- ⑪ ★★ 接线专项验证（`WIRING.md` §W3）----------------------------------
  //
  //   ★ 为什么单独有这一段：⑩ 验的是 `demoGate()` **这个纯函数**对不对；
  //     而 W3 要证明的是另一件事 —— **这道闸门真的挂在状态机必经之路上**。
  //     两件事差得很远：判据写对了但没登记进 `checkPrecondition` 的 switch，
  //     ⑩ 照样全绿，而真机上根本没有闸门。
  //
  //     所以这一段**不碰 demoGate**，一律走真实 store：
  //       `store.transition(...)` → `applyTransition` 取 guard 名
  //                              → `store.checkPrecondition(task, name)`
  //                              → 落到 `case DEMO_GATE_GUARD` → 闸门本体
  //     这条链就是 `pipeline_transition` 在真机上走的同一条链。
  //
  //   ★ 状态怎么摆到 `demo_confirm`：经 **store 自己的落盘入口**（`recordAudit`）写下去，
  //     不是手改内存里那份 —— 之后 `transition` 的 `loadTask` 读到的就是盘上那一份。
  lines.push('')
  lines.push('【⑪ ★★ W3 接线专项：闸门挂在必经之路上才算闸门（正例 + 反例）】')
  const wiringRoot = mkdtempSync(join(tmpdir(), 'dsh-pipeline-p6-w3-'))
  try {
    const store = createTaskStore({ projectRoot: wiringRoot, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })

    // ① 先证明"这条边真的在表里" —— 否则下面的"被拒"会退化成 BAD_TRANSITION（没这条边）。
    const { TRANSITIONS: TR2 } = await import('../lib/states.js')
    const wiredEdge = TR2.find((t) => t.from === DEMO_ST.CONFIRM && t.event === DEMO_EVENTS.CONFIRM)
    ok(wiredEdge !== undefined, '★ `demo_confirm --demo_confirmed--> ready_dev` **真的在** TRANSITIONS 里（W1）')
    eq(wiredEdge?.guard, DEMO_GATE_GUARD, '它挂的闸门名就是 `demo_confirmed`（W3 要登记的那个名字）')
    eq(wiredEdge?.to, ST.READY_DEV, '它的目的地是 ready_dev')

    const opened = await store.open({ id: 'T-P6-W3', requirement: '接线专项：未确认不得进 ready_dev', actorRole: ROLE.MAIN, actorAgentId: 'main-s' })
    eq(opened.ok, true, '开单成功（走真 store）', String(opened.error ?? ''))

    // ② 摆一个"DEMO 已交第 1 轮、请求**只转告了、用户还没回**"的现场。
    const t1 = await store.get('T-P6-W3')
    t1.state = DEMO_ST.CONFIRM
    t1.demo = {
      plan: { tier: 'L3', action: 'require' },
      rounds: [{ index: 1, digest: 'd1', ref: 'demo/a.html', human_request_id: 'HR-1', at: 't', by: 'writer' }],
      confirmed_at: null,
      confirm_request_id: null,
    }
    t1.human_requests = [{ request_id: 'HR-1', status: 'relayed', from_role: 'writer', reason_kind: 'demo_review' }]
    await store.recordAudit('T-P6-W3', ROLE.MAIN, 'fixture:demo_confirm_relayed', { note: '把单摆到 demo_confirm（经 store 的落盘入口）' })

    // ★ 正例①：一轮都没确认过 ⇒ 推进**被拒**，且判词是 DEMO 闸门给的
    const denied1 = await store.transition({ taskId: 'T-P6-W3', event: DEMO_EVENTS.CONFIRM, actorRole: ROLE.MAIN, actorAgentId: 'main-s', note: '未确认就推进' })
    eq(denied1.ok, false, '★★ 未获用户确认 ⇒ 向 `ready_dev` 的推进**被拒**')
    eq(denied1.code, 'DEMO_NOT_CONFIRMED', '★★ 拒绝码是 DEMO 闸门给的（**不是** switch 末尾那条 INTERNAL 兜底、也不是 BAD_TRANSITION）', String(denied1.code))
    ok(String(denied1.error).includes('A17'), '判词引了验收 A17', String(denied1.error).split('\n')[0])
    ok(String(denied1.error).includes('pipeline_demo'), '★ 判词给了**下一步的具体调法**（可读，不是只说"不行"）')
    eq((await store.get('T-P6-W3')).state, DEMO_ST.CONFIRM, '★★ 被拒之后状态**一毫米没动**（还停在 demo_confirm）')

    // ★ 正例②：有确认动作、但请求只是 relayed ⇒ 仍被拒（**转告 ≠ 答复**）
    const t2 = await store.get('T-P6-W3')
    t2.demo.confirmed_at = '2026-10-15T12:00:00Z'
    t2.demo.confirm_request_id = 'HR-1'
    await store.recordAudit('T-P6-W3', ROLE.MAIN, 'fixture:confirm_without_answer', {})
    const denied2 = await store.transition({ taskId: 'T-P6-W3', event: DEMO_EVENTS.CONFIRM, actorRole: ROLE.MAIN, actorAgentId: 'main-s', note: '把转告当答复' })
    eq(denied2.code, 'DEMO_CONFIRM_NOT_ANSWERED', '★ 把"转告了"当"用户回了" ⇒ 仍被拒（DEMO_CONFIRM_NOT_ANSWERED）')
    ok(String(denied2.error).includes('转告 ≠ 答复'), '判词点明了这条判据的依据')
    eq((await store.get('T-P6-W3')).state, DEMO_ST.CONFIRM, '★ 仍停在 demo_confirm')

    // ★★ 反例（证明上面两条不是"永远拒绝"那种假绿）：用户**真的答复了** ⇒ 放行
    const t3 = await store.get('T-P6-W3')
    t3.human_requests = [answered('HR-1')]
    await store.recordAudit('T-P6-W3', ROLE.MAIN, 'fixture:user_answered', { note: '用户原话：看过了，可以' })
    const allowed = await store.transition({ taskId: 'T-P6-W3', event: DEMO_EVENTS.CONFIRM, actorRole: ROLE.MAIN, actorAgentId: 'main-s', note: '用户已确认' })
    eq(allowed.ok, true, '★★ 反例：已确认 ⇒ **放行**（同一个判据、同一条链，不是另一套规则）', String(allowed.error ?? ''))
    eq(allowed.to, ST.READY_DEV, '★★ 状态真的落到 `ready_dev`')
    eq((await store.get('T-P6-W3')).state, ST.READY_DEV, '★ 读回来仍是 ready_dev —— 真的落盘了')

    // ★ 闸门本体确实挂在 checkPrecondition 上（直调那一层，绕开状态机）。
    //   用一份**未确认**的任务替身：这里验的是"名字 → 判据"的登记，不是落盘。
    const unconfirmed = {
      id: 'T-P6-W3',
      state: DEMO_ST.CONFIRM,
      demo: { rounds: [{ index: 1, digest: 'd1', human_request_id: 'HR-1' }], confirmed_at: null, confirm_request_id: null },
      human_requests: [],
    }
    const direct = await store.checkPrecondition(unconfirmed, DEMO_GATE_GUARD, {})
    ok(direct.ok === false && direct.code === 'DEMO_NOT_CONFIRMED', '★ `store.checkPrecondition(task, "demo_confirmed")` 走到的就是 DEMO 闸门本体（W3 的落点）')
    const roundGuard = await store.checkPrecondition(unconfirmed, DEMO_ROUND_GUARD, { demo: { human_request_id: '' } })
    ok(roundGuard.ok === false, '★ 第二个 case：`demo_round_ok` 也接上了（交轮次那条闸门）', String(roundGuard.code))
    /**
     * ★ 对照组：**没登记**的闸门名落到 switch 末尾那条兜底。
     *
     * 这正是 W3 接线前的形状 —— 名字进了 TRANSITIONS，却没进 switch。
     * 留这一条是为了让"接线"与"没接线"在**同一份输出**里可比对：
     * 前者给出 `DEMO_NOT_CONFIRMED`（含下一步），后者只给一句 `INTERNAL`。
     */
    const unknownGuard = await store.checkPrecondition(unconfirmed, 'no_such_guard_xyz', {})
    ok(unknownGuard.ok === false && unknownGuard.code === 'INTERNAL',
      '★ 对照：**没登记**的闸门名落到 switch 末尾兜底（INTERNAL）—— 接线前 `demo_confirmed` 就是这个形状',
      String(unknownGuard.code))
    ok(direct.code !== unknownGuard.code, '★★ 接线之后 `demo_confirmed` 拿到的判据码**与兜底那条不同** ⇒ 闸门真的接上了')
  } finally {
    rmSync(wiringRoot, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p6 总计：${passed}/${passed + failed} 通过`)
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
export async function runP6DemoPhaseCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p6 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p6-demo-phase-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，DEMO 阶段）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p6-demo-phase-check.mjs')) {
  const r = await runP6DemoPhaseCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
