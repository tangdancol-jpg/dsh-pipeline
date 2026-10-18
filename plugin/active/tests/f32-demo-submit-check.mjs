// P1-8 回归：拆分 `pipeline_demo_submit`（交付席位交 DEMO）+ 计划自检对 DEMO 交付方的硬校验。
/**
 * dsh-pipeline · F32：DEMO 交付权限拆分（P1-8）
 * ============================================================================
 *     node tests/f32-demo-submit-check.mjs
 *
 * 现场（设计档 `design/conventions/04-demo与制品模型.md` §2，用户已拍板「推荐 A」）：
 * 计划里的步骤要求"某两个席位各交一半 DEMO"，但 `pipeline_demo` **只允许 main** ——
 * 计划写了、机制不允许，矛盾没有任何一处会指出来。
 *
 * 修法（本单）：
 *   ① 新增 `pipeline_demo_submit`（**writer / architect / diagrammer** 可调）：
 *      把本轮 DEMO 交付物（路径 / 摘要 / 内容哈希）挂到 `task.demo.rounds[i]`，
 *      供 main 的 `pipeline_demo { action: "round" }` 引用；
 *   ② `pipeline_demo` 仍 **main 专用**（round / confirm / status / plan）；
 *   ③ `pipeline_plan` 自检：计划要求非 main 角色交 DEMO ⇒ 该角色必须**在册**且**可 submit**，
 *      否则**拒收计划**（不提交、不分配，文案给改法）。
 *
 * 钉住：
 *   A 交付席位可交：writer / architect / diagrammer 各自把交付物挂进**同一轮**（追加）；
 *     内容哈希可核对；**不推进状态**（定稿是主对话的活）
 *   B 非交付席位（tester / main）被守门拒；错误状态（planning）/ 空交付物被拒
 *   C main 的 `round` 能**引用**交付席位交上来的那几份（`round_index` → 交付物/指纹/ref），
 *     定稿后推进 demo_review，confirm + demo_passed 收尾
 *   D `pipeline_plan` 自检：要求 `tester` 交 DEMO ⇒ 拒（没权限）；要求 `diagrammer` 交但不在 L1 清单 ⇒ 拒；
 *     不点名角色 + 清单里有可交角色 ⇒ 放行；点名 `writer`（在册）⇒ 放行
 *   E 旧调用兼容：不给 `pipeline_demo_submit`、直接由 main 用 `deliverable_ref` 交一轮的旧写法仍可用
 */

import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness, callTool, runAnalysisThenPlan } from './selftest-core.mjs'
import { ST } from '../lib/states.js'
import { DEMO_ST, DEMO_SUBMIT_ROLES } from '../lib/states/demo-phase.js'
import { TIERS } from '../lib/tiers.js'
import { fullHash } from '../lib/util.js'

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
      const L = ['dsh-pipeline · F32：DEMO 交付权限拆分（P1-8）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
let seq = 0

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 开单 → 需求 → 计划；返回停在流程里的任务（默认 L3 ⇒ demo_building）。 */
async function plannedTask(h, tier = 'L3') {
  const MAIN = `f32-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F32 夹具：${tier} 档 DEMO 交付拆分。` }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  const res = await runAnalysisThenPlan(h, { taskId, tokens, agents, tier, reason: `F32 ${tier}` })
  return { h, taskId, tokens, agents, plan: res.plan, task: h.store.peek(taskId) }
}

/** 开单 → 需求 → 停在「计划中」（用于直接调 pipeline_plan 验自检）。 */
async function planningTask(h, tier) {
  const MAIN = `f32-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F32 夹具：${tier} 停在计划中。` }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  const res = await runAnalysisThenPlan(h, { taskId, tokens, agents, tier, reason: `F32 ${tier}`, stopBeforePlan: true })
  return { h, taskId, tokens: res.tokens, agents: res.agents }
}

/** 直接调 `pipeline_plan` 的一次合法入参（默认值按本档执行角色给齐）。 */
function planArgs(taskId, tier, token, over = {}) {
  const execRoles = TIERS[tier].execution
  return {
    task_id: taskId,
    plan_steps: ['冻结接口契约', '按层实现', '自测后交测试'],
    layers: [],
    self_check_verdict: 'ok',
    self_check_checked: ['需求覆盖', '层边界', '依赖顺序'],
    self_check_gaps: [],
    plan_reason: 'F32 夹具：按档位出计划。',
    change_scope: [{ id: 'CS1', path: '.', action: 'modify', why: 'F32 夹具：单席位，范围是整棵项目根' }],
    forbidden: ['不许顺手重构', '不许改测试', '不许扩范围'],
    role_boundaries: execRoles.map((r) => ({ role: r, only: [`只干「${r}」这一份活`], not: ['不干别人的活', '不扩大改动面'] })),
    role_scope: { will_do: ['出计划、自检、分配 AI'], will_not_do: ['不写实现、不读代码、不跑测试'] },
    tier,
    reason: `F32 夹具：${tier} 档`,
    acceptance: ['按需求实现'],
    test_points: ['正常路径'],
    boundaries: ['不改公开接口'],
    ...over,
    role_token: token,
  }
}

/** 一枚交付席位令牌（工具按令牌认角色；不需要真实 dispatch）。 */
function seatToken(h, taskId, role, seat = null) {
  const agentId = `f32-${role}-${++seq}`
  return { token: h.tokens.mint({ taskId, role, seat, agentId }).token, agentId }
}

/** 调 `pipeline_demo_submit`。 */
async function submit(h, taskId, role, { ref = 'demo/x.html', content = '<h1>x</h1>', roundIndex } = {}) {
  const { token, agentId } = seatToken(h, taskId, role, role === 'writer' ? 'writer#1' : null)
  return callTool(
    h,
    'pipeline_demo_submit',
    {
      task_id: taskId,
      deliverable_ref: ref,
      deliverable_content: content,
      ...(roundIndex === undefined ? {} : { round_index: roundIndex }),
      role_token: token,
    },
    agentId,
  )
}

function pushAnswered(h, taskId, { requestId, createdAt = iso() }) {
  const task = h.store.peek(taskId)
  if (!Array.isArray(task.human_requests)) task.human_requests = []
  task.human_requests.push({
    request_id: requestId,
    status: 'answered',
    from_role: 'writer',
    reason_kind: 'approval_needed',
    created_at: createdAt,
    answered_at: createdAt,
    answer_text: '可以',
    answer: '可以',
    answer_source: 'user',
  })
  return requestId
}

async function roundOf(h, taskId, tokens, agent, body) {
  return callTool(h, 'pipeline_demo', { action: 'round', task_id: taskId, ...body, role_token: tokens.main }, agent)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runF32DemoSubmitCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    // =====================================================================
    // A 交付席位可交（同一轮追加 / 内容哈希 / 不推进状态）
    // =====================================================================
    {
      const G = 'A 交付席位可交'
      const fx = await plannedTask(h, 'L3')
      rec.add(G, '（前置）任务在 demo_building', fx.task.state === DEMO_ST.BUILDING, fx.task.state)
      rec.add(G, '★ 白名单就是设计档那三个角色（writer / architect / diagrammer）', DEMO_SUBMIT_ROLES.join(',') === 'writer,architect,diagrammer', DEMO_SUBMIT_ROLES.join(','))

      const w = await submit(fx.h, fx.taskId, 'writer', { ref: 'demo/main.html', content: '<h1>主页面</h1>' })
      rec.add(
        G,
        '★★ writer 交内容 ⇒ 挂到第 1 轮草稿（round_index=1），**状态不动**（定稿是主对话的活）',
        w.denied !== true && w.value?.round_index === 1 && w.value?.state === DEMO_ST.BUILDING && fx.h.store.peek(fx.taskId).state === DEMO_ST.BUILDING,
        `round=${w.value?.round_index} state=${w.value?.state}`,
      )
      rec.add(G, '★ 内容哈希可核对（= sha256(正文)）', w.value?.content_hash === fullHash('<h1>主页面</h1>'), `${String(w.value?.content_hash).slice(0, 16)}…`)

      const a = await submit(fx.h, fx.taskId, 'architect', { ref: 'demo/frame.html', content: '<h1>骨架</h1>' })
      const d = await submit(fx.h, fx.taskId, 'diagrammer', { ref: 'demo/proto.html', content: '<h1>原型</h1>', roundIndex: 1 })
      const draft = fx.h.store.peek(fx.taskId).demo.rounds[0]
      rec.add(
        G,
        '★★ 三个角色**同一轮各交一份**（append 到 rounds[1].deliverables）⇒ 一轮三份，round_index 一致',
        a.denied !== true && d.denied !== true && a.value?.round_index === 1 && d.value?.round_index === 1 && Array.isArray(draft.deliverables) && draft.deliverables.length === 3 && draft.deliverables.map((x) => x.by).join(',') === 'writer,architect,diagrammer',
        JSON.stringify({ rounds: a.value?.rounds, draftDeliverables: draft.deliverables?.map((x) => `${x.by}:${x.ref}`) }),
      )
      rec.add(G, '★ 草稿轮不参与"已定稿轮次"的账（不会被提前算成一轮）', fx.h.store.peek(fx.taskId).demo.rounds.filter((r) => r.status === 'submitted').length === 1 && String(fx.h.store.peek(fx.taskId).demo.confirmed_at) === 'null', JSON.stringify({ rounds: fx.h.store.peek(fx.taskId).demo.rounds.map((r) => r.status) }))
    }

    // =====================================================================
    // B 负例：非交付席位 / 错误状态 / 空交付物
    // =====================================================================
    {
      const G = 'B 负例'
      const fx = await plannedTask(h, 'L3')
      const tester = seatToken(fx.h, fx.taskId, 'tester')
      const byTester = await callTool(fx.h, 'pipeline_demo_submit', { task_id: fx.taskId, deliverable_ref: 'demo/x.html', role_token: tester.token }, tester.agentId)
      rec.add(G, '★★ tester 调 `pipeline_demo_submit` ⇒ **守门层拒**（不是交付席位；不是"点了才被拒"）', byTester.denied === true && byTester.layer === 'guard', `${byTester.layer}\n${String(byTester.text).split('\n').slice(0, 3).join('\n')}`)

      const mainSeat = seatToken(fx.h, fx.taskId, 'main')
      const byMain = await callTool(fx.h, 'pipeline_demo_submit', { task_id: fx.taskId, deliverable_ref: 'demo/x.html', role_token: mainSeat.token }, mainSeat.agentId)
      rec.add(G, '★★ main 调 `pipeline_demo_submit` ⇒ **拒**（main 是调度方，不是交付方）', byMain.denied === true && byMain.layer === 'guard', byMain.layer)

      const plan = await planningTask(h, 'L3')
      const writer = seatToken(plan.h, plan.taskId, 'writer')
      const wrongState = await callTool(plan.h, 'pipeline_demo_submit', { task_id: plan.taskId, deliverable_ref: 'demo/x.html', role_token: writer.token }, writer.agentId)
      rec.add(G, '★★ 不在 demo_building（还在 planning）⇒ 拒（NOT_DEMO_BUILDING，文案给下一步）', wrongState.denied === true && String(wrongState.text).includes('DEMO 制作中'), String(wrongState.text).split('\n')[0])

      const empty = await submit(fx.h, fx.taskId, 'writer', { ref: '', content: '   ' })
      rec.add(G, '★ 空交付物（ref 与正文都空）⇒ 拒（DEMO_NO_DELIVERABLE）', empty.denied === true && String(empty.text).includes('没有交付物'), String(empty.text).split('\n')[0])
    }

    // =====================================================================
    // C main 的 round 能引用交付席位交上来的东西 → confirm → demo_passed
    // =====================================================================
    {
      const G = 'C main 引用交付物'
      const fx = await plannedTask(h, 'L3')
      await submit(fx.h, fx.taskId, 'writer', { ref: 'demo/main.html', content: '<h1>主页面</h1>' })
      await submit(fx.h, fx.taskId, 'diagrammer', { ref: 'demo/proto.html', content: '<h1>原型</h1>' })
      const draft = fx.h.store.peek(fx.taskId).demo.rounds[0]
      const draftDigest = draft.digest
      const rid = pushAnswered(fx.h, fx.taskId, { requestId: `HR-f32-${++seq}` })

      const rnd = await roundOf(fx.h, fx.taskId, fx.tokens, fx.agents.main, { round_index: 1, human_request_id: rid })
      const recorded = fx.h.store.peek(fx.taskId).demo.rounds[0]
      rec.add(
        G,
        '★★ 主对话 `round { round_index, human_request_id }` **不需要再给交付物**：直接引用交付席位交的那一份',
        rnd.denied !== true && fx.h.store.peek(fx.taskId).state === DEMO_ST.REVIEW && recorded.status === 'recorded' && recorded.digest === draftDigest && recorded.deliverables.length === 2 && String(recorded.ref).includes('demo/main.html') && String(recorded.ref).includes('demo/proto.html'),
        String(rnd.text).split('\n').slice(0, 5).join('\n'),
      )
      rec.add(G, '★ 定稿后请求被消费（一条请求只能用一次）', fx.h.store.peek(fx.taskId).human_requests.find((x) => x.request_id === rid)?.consumed === true, JSON.stringify(fx.h.store.peek(fx.taskId).human_requests.find((x) => x.request_id === rid)).slice(0, 200))

      const conf = await callTool(fx.h, 'pipeline_demo', { action: 'confirm', task_id: fx.taskId, round_index: 1, human_request_id: rid, answer: '可以', answer_source: 'user', role_token: fx.tokens.main }, fx.agents.main)
      const pass = await callTool(fx.h, 'pipeline_transition', { task_id: fx.taskId, event: 'demo_passed', role_token: fx.tokens.main }, fx.agents.main)
      rec.add(G, '★★ 引用交付物的整条链走通：confirm → demo_passed ⇒ ready_dev', conf.denied !== true && pass.denied !== true && fx.h.store.peek(fx.taskId).state === ST.READY_DEV, `state=${fx.h.store.peek(fx.taskId).state}`)

      // C-2 账本可读：这一轮是几份交付物、谁交的（任务卡上同一份数据，status 侧靠它展示）
      const ledgerRound = fx.h.store.peek(fx.taskId).demo.rounds[0]
      rec.add(G, '★ 任务账本能读出"这一轮是几份交付物、谁交的"', Array.isArray(ledgerRound.deliverables) && ledgerRound.deliverables.length === 2, JSON.stringify(ledgerRound.deliverables?.map((x) => x.by)))
      const stOut = await callTool(fx.h, 'pipeline_demo', { action: 'status', task_id: fx.taskId, role_token: fx.tokens.main }, fx.agents.main)
      rec.add(G, '★ `pipeline_demo status` 返回**已定稿轮数**（不把草稿算进去）', stOut.denied !== true && stOut.value?.rounds === 1, String(stOut.value?.rounds))
    }

    // =====================================================================
    // D pipeline_plan 自检：DEMO 交付方必须在册且可 submit
    // =====================================================================
    {
      const G = 'D 计划自检'
      const planTool = h.byName.get('pipeline_plan')

      // D-1 要求 tester 交 DEMO ⇒ 拒（tester 没有 submit 权限）
      {
        const fx = await planningTask(h, 'L2')
        const out = await planTool.execute(
          planArgs(fx.taskId, 'L2', fx.tokens.planner, { plan_steps: ['冻结接口契约', '由 tester 交付 DEMO 页面', '按层实现'] }),
          { agent: { id: fx.agents.planner } },
        )
        const t = fx.h.store.peek(fx.taskId)
        rec.add(
          G,
          '★★ 计划要求「tester 交付 DEMO 页面」⇒ **拒收计划**（tester 没有 pipeline_demo_submit 权限）',
          out?.ok !== true && String(out?.summary).includes('pipeline_demo_submit') && String(out?.summary).includes('权限'),
          String(out?.summary ?? '').split('\n').slice(0, 5).join('\n'),
        )
        rec.add(G, '★★ 拒收发生在分配前：状态仍在 planning、没有 plan 交接物', t.state === ST.PLANNING && (t.handoffs ?? []).filter((x) => x.kind === 'plan').length === 0, JSON.stringify({ state: t.state, plans: (t.handoffs ?? []).filter((x) => x.kind === 'plan').length }))
      }

      // D-2 要求 diagrammer 交，但 L1 清单里没有它 ⇒ 拒（有权限但不在册）
      {
        const fx = await planningTask(h, 'L1')
        const out = await planTool.execute(
          planArgs(fx.taskId, 'L1', fx.tokens.planner, { plan_steps: ['冻结接口契约', '由 diagrammer 交付 DEMO 页面', '按层实现'] }),
          { agent: { id: fx.agents.planner } },
        )
        rec.add(
          G,
          '★★ 计划要求「diagrammer 交付 DEMO」但本档（L1）清单里没有它 ⇒ **拒收**（不在册就不能交）',
          out?.ok !== true && String(out?.summary).includes('不在本档角色清单'),
          String(out?.summary ?? '').split('\n').slice(0, 6).join('\n'),
        )
      }

      // D-3 不点名角色 + 清单里有可交角色（L2 有 writer/architect/diagrammer）⇒ 放行
      {
        const fx = await planningTask(h, 'L2')
        const out = await planTool.execute(
          planArgs(fx.taskId, 'L2', fx.tokens.planner, { plan_steps: ['冻结接口契约', '先出一个可操作 DEMO 页面给用户看', '按层实现'] }),
          { agent: { id: fx.agents.planner } },
        )
        const t = fx.h.store.peek(fx.taskId)
        rec.add(
          G,
          '★★ 计划要求出 DEMO 但**不点名角色**、清单里有可交角色 ⇒ **放行**（不误伤）',
          out?.ok === true && t.state === ST.READY_DEV && (t.handoffs ?? []).some((x) => x.kind === 'plan'),
          `ok=${out?.ok} state=${t.state}`,
        )
      }

      // D-4 点名 writer（在册且可 submit）⇒ 放行
      {
        const fx = await planningTask(h, 'L2')
        const out = await planTool.execute(
          planArgs(fx.taskId, 'L2', fx.tokens.planner, { plan_steps: ['冻结接口契约', '由 writer 交付 DEMO 页面（可操作前端）', '按层实现'] }),
          { agent: { id: fx.agents.planner } },
        )
        const t = fx.h.store.peek(fx.taskId)
        rec.add(G, '★★ 计划点名 `writer` 交 DEMO（在册 + 可 submit）⇒ **放行**（计划与机制一致）', out?.ok === true && t.state === ST.READY_DEV, `ok=${out?.ok} state=${t.state}\n${String(out?.summary ?? '').split('\n').slice(0, 3).join('\n')}`)
      }
    }

    // =====================================================================
    // E 旧调用兼容：main 直接给 deliverable_ref 的旧写法仍可用（不强制 submit）
    // =====================================================================
    {
      const G = 'E 旧调用兼容'
      const fx = await plannedTask(h, 'L3')
      const rid = `HR-f32-${++seq}`
      const t = fx.h.store.peek(fx.taskId)
      if (!Array.isArray(t.human_requests)) t.human_requests = []
      t.human_requests.push({ request_id: rid, status: 'answered', from_role: 'writer', reason_kind: 'approval_needed', answer_text: '可以', answer: '可以' })
      const rnd = await roundOf(fx.h, fx.taskId, fx.tokens, fx.agents.main, {
        deliverable_ref: 'demo/legacy.html',
        deliverable_content: '<h1>旧写法</h1>',
        human_request_id: rid,
      })
      rec.add(
        G,
        '★★ 不给 `pipeline_demo_submit`、main 直接 `deliverable_ref` 交一轮的**旧写法仍可用**（legacy 请求无 created_at ⇒ 宽松判据）',
        rnd.denied !== true && fx.h.store.peek(fx.taskId).state === DEMO_ST.REVIEW && fx.h.store.peek(fx.taskId).demo.rounds[0]?.ref === 'demo/legacy.html',
        String(rnd.text).split('\n').slice(0, 4).join('\n'),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF32DemoSubmitCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
