// P1-7 回归：DEMO 显式阶段（demo_building / demo_review + 四条迁移边 + 轮次请求三条判据）。
/**
 * dsh-pipeline · F31：DEMO 显式阶段（P1-7）
 * ============================================================================
 *     node tests/f31-demo-stage-check.mjs
 *
 * 依据（设计档 `design/conventions/04-demo与制品模型.md` §1，用户已拍板「推荐 A」）：
 *
 *     planning ──demo_started──▶ demo_building ──demo_submitted──▶ demo_review
 *                                     ▲                                  │
 *                                     └──────────demo_rework─────────────┤
 *                                                                        │
 *                                     ready_dev ◀──────demo_passed───────┘
 *
 * 钉住：
 *   A 新状态与四条边（`demo_building` / `demo_review`；`demo_started` / `demo_submitted` /
 *     `demo_passed` / `demo_rework`；`demo_passed` 挂的还是 `demo_confirmed` 闸门；旧名兼容别名）
 *   B 档位路由：L3+ require **必走**新阶段；L2 默认旧路径、显式 `decision:"demo"` 才走；
 *     L2 `decision:"skip"` 旧路径；L3+ 不许 skip
 *   C 轮次请求三条判据（纯函数）：**本轮创建** / **已 answered** / **未被别的轮消费**；
 *     legacy（无 created_at）按宽松判据（旧数据不红）
 *   D 端到端正例：plan→demo_building → submit → round 定稿（**消费请求**）→ demo_review
 *     → 未确认时 demo_passed **被拒** → confirm → demo_passed → ready_dev
 *   E 端到端负例：relayed 请求 / 旧请求（stale）/ 错误状态 / 复用已消费请求 ⇒ 全被拒
 *   F 旧单兼容：旧状态 `demo_confirm + demo_confirmed` 仍能进 ready_dev；
 *     已到 ready_dev 的任务不因缺 DEMO 账本而红
 */

import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness, callTool, runAnalysisThenPlan } from './selftest-core.mjs'
import { ST, STATE_LABEL, STATE_OWNER, TRANSITIONS, availableTransitions } from '../lib/states.js'
import { DEMO_EVENTS, DEMO_ST, isDemoState } from '../lib/states/demo-phase.js'
import { DEMO_GATE_GUARD } from '../lib/guard/demo-gate.js'
import { checkDemoRoundRequest } from '../lib/store/demo-rounds.js'

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
      const L = ['dsh-pipeline · F31：DEMO 显式阶段（P1-7）', '='.repeat(78)]
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
const uid = (p) => `${p}-${++seq}`

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一条"已答复"的人工请求记录（直接登记到任务上：本套只验 DEMO 判据，不重走两级梯）。 */
function pushRequest(h, taskId, { requestId, status = 'answered', createdAt = iso(), consumedByRound = null }) {
  const task = h.store.peek(taskId)
  if (!Array.isArray(task.human_requests)) task.human_requests = []
  const rec = {
    request_id: requestId,
    status,
    from_role: 'writer',
    reason_kind: 'approval_needed',
    created_at: createdAt,
    answered_at: status === 'answered' ? createdAt : null,
    answer_text: status === 'answered' ? '看过了，可以' : '',
    answer: status === 'answered' ? '看过了，可以' : '',
    answer_source: status === 'answered' ? 'user' : null,
  }
  if (consumedByRound !== null) {
    rec.consumed = true
    rec.consumed_by_round = consumedByRound
    rec.consumed_at = createdAt
  }
  task.human_requests.push(rec)
  return rec
}

/**
 * 走完「需求 → 用户确认 → 计划」拿到一张**已在流程里**的任务。
 * @param {object} opts.beforePlan - 计划之前的一个回调（用来先 `pipeline_demo plan` 记用户决定）
 * @param {object} opts.plan - 传给 runAnalysisThenPlan 的覆盖
 */
async function plannedTask(h, tier, opts = {}) {
  const MAIN = `f31-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F31 夹具：${tier} 档 DEMO 阶段。` }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  if (typeof opts.beforePlan === 'function') await opts.beforePlan({ h, taskId, tokens, agents })
  const res = await runAnalysisThenPlan(h, { taskId, tokens, agents, tier, reason: `F31 ${tier}`, ...(opts.plan ?? {}) })
  return { h, taskId, tokens, agents, plan: res.plan, task: h.store.peek(taskId) }
}

/** 停在「计划中」的任务（计划工具可再调一次；用来验计划自检/错误状态）。 */
async function planningTask(h, tier) {
  const MAIN = `f31-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F31 夹具：${tier} 停在计划中。` }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  const res = await runAnalysisThenPlan(h, { taskId, tokens, agents, tier, reason: `F31 ${tier}`, stopBeforePlan: true })
  return { h, taskId, tokens: res.tokens, agents: res.agents }
}

/** 一枚交付席位令牌（本套不依赖真实 dispatch —— 工具按令牌认角色）。 */
function seatToken(h, taskId, role, seat = null) {
  return h.tokens.mint({ taskId, role, seat, agentId: `f31-${role}-${++seq}` }).token
}

/** 交付席位交一份本轮 DEMO 内容。 */
async function submit(h, taskId, role, { ref = 'demo/index.html', content = '<h1>v1</h1>', roundIndex } = {}) {
  const token = seatToken(h, taskId, role, role === 'writer' ? 'writer#1' : null)
  const agent = `f31-${role}-${seq}`
  return callTool(
    h,
    'pipeline_demo_submit',
    { task_id: taskId, deliverable_ref: ref, deliverable_content: content, ...(roundIndex === undefined ? {} : { round_index: roundIndex }), role_token: token },
    agent,
  )
}

/** main 定稿一轮。 */
async function roundOf(h, taskId, tokens, agent, humanRequestId, roundIndex) {
  return callTool(
    h,
    'pipeline_demo',
    { action: 'round', task_id: taskId, round_index: roundIndex, human_request_id: humanRequestId, role_token: tokens.main },
    agent,
  )
}

/** main 记用户确认。 */
async function confirmOf(h, taskId, tokens, agent, humanRequestId, roundIndex) {
  return callTool(
    h,
    'pipeline_demo',
    { action: 'confirm', task_id: taskId, round_index: roundIndex, human_request_id: humanRequestId, answer: '可以', answer_source: 'user', role_token: tokens.main },
    agent,
  )
}

/** main 触发一个状态事件。 */
async function transitionOf(h, taskId, tokens, agent, event) {
  return callTool(h, 'pipeline_transition', { task_id: taskId, event, role_token: tokens.main }, agent)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runF31DemoStageCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    // =====================================================================
    // A 状态、事件与四条边
    // =====================================================================
    {
      const G = 'A 状态与四条迁移边'
      rec.add(G, '★★ `demo_building` / `demo_review` 两个新状态存在且有中文名', ST.DEMO_BUILDING === 'demo_building' && ST.DEMO_REVIEW === 'demo_review' && String(STATE_LABEL[ST.DEMO_BUILDING]).length > 0 && String(STATE_LABEL[ST.DEMO_REVIEW]).length > 0, `${ST.DEMO_BUILDING}=${STATE_LABEL[ST.DEMO_BUILDING]} / ${ST.DEMO_REVIEW}=${STATE_LABEL[ST.DEMO_REVIEW]}`)
      rec.add(
        G,
        '★★ 旧名兼容别名：`DEMO_ST.CONFIRM → demo_review`、`DEMO_EVENTS.CONFIRM → demo_passed`，旧 id 仍可识别',
        DEMO_ST.CONFIRM === 'demo_review' &&
          DEMO_EVENTS.CONFIRM === 'demo_passed' &&
          ST.DEMO_CONFIRM === 'demo_confirm' &&
          isDemoState('demo_building') &&
          isDemoState('demo_review') &&
          isDemoState('demo_confirm') &&
          !isDemoState(ST.READY_DEV),
        `CONFIRM=${DEMO_ST.CONFIRM} EVENT.CONFIRM=${DEMO_EVENTS.CONFIRM} legacy=${ST.DEMO_CONFIRM}`,
      )
      const edge = (from, event) => TRANSITIONS.find((t) => t.from === from && t.event === event) ?? null
      const start = edge(ST.PLANNING, DEMO_EVENTS.START)
      const submitEdge = edge(DEMO_ST.BUILDING, DEMO_EVENTS.SUBMIT)
      const pass = edge(DEMO_ST.REVIEW, DEMO_EVENTS.PASS)
      const rework = edge(DEMO_ST.REVIEW, DEMO_EVENTS.REWORK)
      rec.add(
        G,
        '★★ 四条边逐项正确：planning→demo_building→demo_review→ready_dev，且 demo_review→demo_building 回边存在',
        start?.to === DEMO_ST.BUILDING &&
          start?.guard === 'plan_ready' &&
          submitEdge?.to === DEMO_ST.REVIEW &&
          submitEdge?.guard === 'demo_round_ok' &&
          pass?.to === ST.READY_DEV &&
          pass?.guard === DEMO_GATE_GUARD &&
          rework?.to === DEMO_ST.BUILDING,
        JSON.stringify([
          start && `${start.from}--${start.event}-->${start.to}(${start.guard})`,
          submitEdge && `${submitEdge.from}--${submitEdge.event}-->${submitEdge.to}(${submitEdge.guard})`,
          pass && `${pass.from}--${pass.event}-->${pass.to}(${pass.guard})`,
          rework && `${rework.from}--${rework.event}-->${rework.to}`,
        ]),
      )
      rec.add(
        G,
        '★ DEMO 两个状态都有 owner（不是 null）：制作中⇒编写席、待确认⇒主对话；旧名也有 owner',
        STATE_OWNER[DEMO_ST.BUILDING] === 'writer' && STATE_OWNER[DEMO_ST.REVIEW] === 'main' && STATE_OWNER[ST.DEMO_CONFIRM] === 'main',
        JSON.stringify({ building: STATE_OWNER[DEMO_ST.BUILDING], review: STATE_OWNER[DEMO_ST.REVIEW], legacy: STATE_OWNER[ST.DEMO_CONFIRM] }),
      )
      rec.add(
        G,
        '★ 旧单兼容边在表里：`demo_confirm --demo_confirmed--> ready_dev`（旧数据仍能走完）',
        edge(ST.DEMO_CONFIRM, DEMO_EVENTS.LEGACY_CONFIRM)?.to === ST.READY_DEV,
        JSON.stringify(edge(ST.DEMO_CONFIRM, DEMO_EVENTS.LEGACY_CONFIRM) ?? null).slice(0, 200),
      )
    }

    // =====================================================================
    // B 档位路由：L3+ 必走；L2 默认旧路径 / 显式选择才走
    // =====================================================================
    {
      const G = 'B 档位路由'
      const l3 = await plannedTask(h, 'L3')
      rec.add(
        G,
        '★★ L3（require）计划一交 ⇒ 状态 = **demo_building**（不再直接进 ready_dev）',
        l3.task.state === DEMO_ST.BUILDING,
        `state=${l3.task.state}\n计划回执：${String(l3.plan.text).split('\n').pop()}`,
      )
      rec.add(G, '★ 计划回执里写明了"先出 DEMO"的下一步', String(l3.plan.text).includes('DEMO'), String(l3.plan.text).split('\n').slice(-2).join('\n'))

      const l2 = await plannedTask(h, 'L2')
      rec.add(
        G,
        '★★ L2（ask）**没有**用户显式选择 ⇒ 保持原路径直接到 ready_dev（旧行为不误伤）',
        l2.task.state === ST.READY_DEV,
        `state=${l2.task.state}`,
      )

      const decide = (tier, decision) => async ({ h: hh, taskId, tokens, agents }) => {
        const r = await callTool(hh, 'pipeline_demo', { action: 'plan', task_id: taskId, tier, decision, role_token: tokens.main }, agents.main)
        if (r.denied) throw new Error(`夹具：记 demo 决定失败：\n${r.text}`)
      }
      const l2demo = await plannedTask(h, 'L2', { beforePlan: decide('L2', 'demo') })
      rec.add(
        G,
        '★★ L2 + 用户显式 `decision:"demo"` ⇒ 走新阶段（demo_building）',
        l2demo.task.state === DEMO_ST.BUILDING && l2demo.task.demo?.plan?.decision === 'demo',
        `state=${l2demo.task.state} decision=${l2demo.task.demo?.plan?.decision}`,
      )
      const l2skip = await plannedTask(h, 'L2', { beforePlan: decide('L2', 'skip') })
      rec.add(G, '★★ L2 + 用户显式 `decision:"skip"` ⇒ 旧路径（ready_dev）', l2skip.task.state === ST.READY_DEV && l2skip.task.demo?.plan?.decision === 'skip', `state=${l2skip.task.state} decision=${l2skip.task.demo?.plan?.decision}`)

      const l3skipFixture = await planningTask(h, 'L3')
      const skip = await callTool(
        h,
        'pipeline_demo',
        { action: 'plan', task_id: l3skipFixture.taskId, tier: 'L3', decision: 'skip', role_token: l3skipFixture.tokens.main },
        l3skipFixture.agents.main,
      )
      rec.add(G, '★★ L3+ 传 `decision:"skip"` ⇒ **拒绝**（裁定 5：L3+ 必须出 DEMO）', skip.denied === true && String(skip.text).includes('必须出 DEMO'), String(skip.text).split('\n')[0])
    }

    // =====================================================================
    // C 轮次请求三条判据（纯函数）
    // =====================================================================
    {
      const G = 'C 轮次请求三条判据'
      const task = {
        id: 'T-f31-pure',
        created_at: '2026-01-02T00:00:00Z',
        demo: { plan: { tier: 'L3', action: 'require', at: '2026-01-02T00:00:00Z' }, rounds: [{ index: 1, status: 'recorded', human_request_id: 'HR-OLD', at: '2026-01-03T00:00:00Z' }] },
        human_requests: [
          { request_id: 'HR-NEW', status: 'answered', created_at: '2026-01-04T00:00:00Z', answered_at: '2026-01-04T00:01:00Z' },
          { request_id: 'HR-RELAYED', status: 'relayed', created_at: '2026-01-04T00:00:00Z' },
          { request_id: 'HR-STALE', status: 'answered', created_at: '2026-01-01T00:00:00Z' },
          { request_id: 'HR-USED', status: 'answered', created_at: '2026-01-04T00:00:00Z', consumed: true, consumed_by_round: 2 },
          { request_id: 'HR-LEGACY', status: 'answered' },
        ],
      }
      const okNew = checkDemoRoundRequest(task, { human_request_id: 'HR-NEW', round_index: 2 })
      rec.add(G, '★★ 本轮创建 + answered + 未消费 ⇒ **通过**（strict 模式）', okNew.ok === true && okNew.strict === true, JSON.stringify(okNew).slice(0, 200))
      const stale = checkDemoRoundRequest(task, { human_request_id: 'HR-STALE', round_index: 2 })
      rec.add(G, '★★ 请求早于本轮起点 ⇒ **拒**（DEMO_REQUEST_STALE：不能拿旧请求冒充本轮）', stale.ok !== true && stale.code === 'DEMO_REQUEST_STALE', String(stale.error ?? '').split('\n')[0])
      const relayed = checkDemoRoundRequest(task, { human_request_id: 'HR-RELAYED', round_index: 2 })
      rec.add(G, '★★ 只转告、未答复 ⇒ **拒**（DEMO_REQUEST_NOT_ANSWERED：转告 ≠ 答复）', relayed.ok !== true && relayed.code === 'DEMO_REQUEST_NOT_ANSWERED', String(relayed.error ?? '').split('\n')[0])
      const used = checkDemoRoundRequest(task, { human_request_id: 'HR-USED', round_index: 3 })
      rec.add(G, '★★ 请求已被别的轮消费 ⇒ **拒**（DEMO_REQUEST_CONSUMED：一条请求只用一次）', used.ok !== true && used.code === 'DEMO_REQUEST_CONSUMED', String(used.error ?? '').split('\n')[0])
      const notFound = checkDemoRoundRequest(task, { human_request_id: 'HR-GHOST', round_index: 2 })
      rec.add(G, '★ 请求不存在 ⇒ **拒**（DEMO_REQUEST_NOT_FOUND：凭空写 id 不是请求）', notFound.ok !== true && notFound.code === 'DEMO_REQUEST_NOT_FOUND', String(notFound.error ?? '').split('\n')[0])
      const legacy = checkDemoRoundRequest(task, { human_request_id: 'HR-LEGACY', round_index: 2 })
      rec.add(G, '★ legacy（无 created_at 的旧请求）⇒ 宽松通过（旧单不因新判据红）', legacy.ok === true && legacy.strict === false, JSON.stringify({ ok: legacy.ok, strict: legacy.strict }))
      const blank = checkDemoRoundRequest(task, { human_request_id: '   ', round_index: 2 })
      rec.add(G, '★ 空请求 id ⇒ 拒（软约束②）', blank.ok !== true && String(blank.code).includes('DEMO_NO_HUMAN_REQUEST'), blank.code)
    }

    // =====================================================================
    // D 端到端正例：plan → demo_building → submit → round → demo_review → confirm → demo_passed
    // =====================================================================
    {
      const G = 'D 端到端正例'
      const fx = await plannedTask(h, 'L3')
      const { h: hh, taskId, tokens } = fx
      rec.add(G, '（前置）任务在 demo_building', hh.store.peek(taskId).state === DEMO_ST.BUILDING, hh.store.peek(taskId).state)

      const sub = await submit(hh, taskId, 'writer', { ref: 'demo/main.html', content: '<h1>主页面 v1</h1>' })
      rec.add(G, '★ 交付席位 `pipeline_demo_submit` 交内容成功（草稿轮，不推进状态）', sub.denied !== true && sub.value?.round_index === 1 && hh.store.peek(taskId).state === DEMO_ST.BUILDING, `state=${hh.store.peek(taskId).state} round=${sub.value?.round_index}`)

      const rid = `HR-f31-${++seq}`
      pushRequest(hh, taskId, { requestId: rid, createdAt: iso() })
      const rnd = await roundOf(hh, taskId, tokens, fx.agents.main, rid, 1)
      rec.add(
        G,
        '★★ 主对话 `round` 定稿 ⇒ 推进到 **demo_review**，请求被消费（consumed_by_round=1）',
        rnd.denied !== true &&
          hh.store.peek(taskId).state === DEMO_ST.REVIEW &&
          hh.store.peek(taskId).demo.rounds[0].status === 'recorded' &&
          hh.store.peek(taskId).human_requests.find((x) => x.request_id === rid)?.consumed === true &&
          hh.store.peek(taskId).human_requests.find((x) => x.request_id === rid)?.consumed_by_round === 1,
        String(rnd.text).split('\n').slice(0, 5).join('\n'),
      )
      rec.add(G, '★ 定稿轮次记下交付物与"请求本轮创建"的时间（可追溯）', Array.isArray(hh.store.peek(taskId).demo.rounds[0].deliverables) && hh.store.peek(taskId).demo.rounds[0].deliverables.length === 1 && typeof hh.store.peek(taskId).demo.rounds[0].request_created_at === 'string', JSON.stringify(hh.store.peek(taskId).demo.rounds[0]).slice(0, 300))

      const early = await transitionOf(hh, taskId, tokens, fx.agents.main, DEMO_EVENTS.PASS)
      rec.add(G, '★★ 未确认时 `demo_passed` ⇒ **被拒**（DEMO_NOT_CONFIRMED，且状态不动）', early.denied === true && String(early.text).includes('还没获得用户确认') && hh.store.peek(taskId).state === DEMO_ST.REVIEW, String(early.text).split('\n')[0])

      const conf = await confirmOf(hh, taskId, tokens, fx.agents.main, rid, 1)
      rec.add(G, '★★ 记用户确认 ⇒ 确认**落在第 1 轮**上（round.confirmed_at 有值）', conf.denied !== true && typeof hh.store.peek(taskId).demo.rounds[0].confirmed_at === 'string' && hh.store.peek(taskId).demo.confirmed_at !== null, String(conf.text).split('\n').slice(0, 2).join('\n'))

      const pass = await transitionOf(hh, taskId, tokens, fx.agents.main, DEMO_EVENTS.PASS)
      rec.add(G, '★★ 确认后 `demo_passed` ⇒ **ready_dev**（这就是"用户点头才继续后端"）', pass.denied !== true && hh.store.peek(taskId).state === ST.READY_DEV, `state=${hh.store.peek(taskId).state}`)
      rec.add(G, '★ 到 ready_dev 后可以正常派编写（DEMO 阶段结束，旧链路接上）', (await transitionOf(hh, taskId, tokens, fx.agents.main, 'dispatch_writer')).denied !== true && hh.store.peek(taskId).state === ST.DEVELOPING, hh.store.peek(taskId).state)
    }

    // =====================================================================
    // E 端到端负例：relayed / stale / 错误状态 / 复用请求
    // =====================================================================
    {
      const G = 'E 端到端负例'
      // E-1 错误状态（还在 planning 就想 round）
      const plan = await planningTask(h, 'L3')
      const wrongState = await roundOf(plan.h, plan.taskId, plan.tokens, plan.agents.main, 'HR-x', 1)
      rec.add(G, '★★ `round` 只能在 demo_building 调（planning 时 ⇒ 拒，文案给下一步）', wrongState.denied === true && String(wrongState.text).includes('demo_building'), String(wrongState.text).split('\n')[0])

      // E-2 relayed 请求 ⇒ round 被拒
      const rel = await plannedTask(h, 'L3')
      await submit(rel.h, rel.taskId, 'writer', { ref: 'demo/relayed.html', content: 'relayed' })
      const ridRelayed = `HR-f31-${++seq}`
      pushRequest(rel.h, rel.taskId, { requestId: ridRelayed, status: 'relayed', createdAt: iso() })
      const badRelayed = await roundOf(rel.h, rel.taskId, rel.tokens, rel.agents.main, ridRelayed, 1)
      rec.add(G, '★★ 请求只是 relayed ⇒ round **被拒**（DEMO_REQUEST_NOT_ANSWERED）', badRelayed.denied === true && String(badRelayed.text).includes('还不是已答复') && rel.h.store.peek(rel.taskId).state === DEMO_ST.BUILDING, String(badRelayed.text).split('\n').slice(0, 3).join('\n'))

      // E-3 stale 请求 ⇒ round 被拒
      const staleFx = await plannedTask(h, 'L3')
      await submit(staleFx.h, staleFx.taskId, 'writer', { ref: 'demo/stale.html', content: 'stale' })
      const ridStale = `HR-f31-${++seq}`
      pushRequest(staleFx.h, staleFx.taskId, { requestId: ridStale, createdAt: '2020-01-01T00:00:00Z' })
      const badStale = await roundOf(staleFx.h, staleFx.taskId, staleFx.tokens, staleFx.agents.main, ridStale, 1)
      rec.add(G, '★★ 请求是**更早以前创建**的 ⇒ round 被拒（DEMO_REQUEST_STALE：不能复用旧请求）', badStale.denied === true && String(badStale.text).includes('更早以前创建'), String(badStale.text).split('\n').slice(0, 3).join('\n'))

      // E-4 复用已消费请求（demo_rework 回去再交一轮）
      const reuse = await plannedTask(h, 'L3')
      await submit(reuse.h, reuse.taskId, 'writer', { ref: 'demo/r1.html', content: 'r1' })
      const ridA = `HR-f31-${++seq}`
      pushRequest(reuse.h, reuse.taskId, { requestId: ridA, createdAt: iso() })
      const r1 = await roundOf(reuse.h, reuse.taskId, reuse.tokens, reuse.agents.main, ridA, 1)
      const rework = await transitionOf(reuse.h, reuse.taskId, reuse.tokens, reuse.agents.main, DEMO_EVENTS.REWORK)
      if (rework.denied === true) throw new Error(`夹具：demo_rework 失败：\n${rework.text}`)
      await submit(reuse.h, reuse.taskId, 'writer', { ref: 'demo/r2.html', content: 'r2' })
      const badReuse = await roundOf(reuse.h, reuse.taskId, reuse.tokens, reuse.agents.main, ridA, 2)
      rec.add(
        G,
        '★★ 用户要求重做后再交一轮、却复用上一轮请求 ⇒ round **被拒**（一条请求只能用一次）',
        r1.denied !== true && rework.denied !== true && reuse.h.store.peek(reuse.taskId).state === DEMO_ST.BUILDING && badReuse.denied === true && /消费|已消费|挂在/.test(String(badReuse.text)),
        `state=${reuse.h.store.peek(reuse.taskId).state} rework=${rework.denied} badReuse=${badReuse.denied}\n${String(badReuse.text).split('\n').slice(0, 3).join('\n')}`,
      )
      // E-4 收束：换一条新请求 ⇒ 第二轮正常定稿
      const ridB = `HR-f31-${++seq}`
      pushRequest(reuse.h, reuse.taskId, { requestId: ridB, createdAt: iso() })
      const r2 = await roundOf(reuse.h, reuse.taskId, reuse.tokens, reuse.agents.main, ridB, 2)
      rec.add(G, '★★ 换一条**本轮创建**的新请求 ⇒ 第二轮正常定稿到 demo_review', r2.denied !== true && reuse.h.store.peek(reuse.taskId).state === DEMO_ST.REVIEW && reuse.h.store.peek(reuse.taskId).demo.rounds.length === 2, `state=${reuse.h.store.peek(reuse.taskId).state} rounds=${reuse.h.store.peek(reuse.taskId).demo.rounds.length}`)
    }

    // =====================================================================
    // F 旧单兼容
    // =====================================================================
    {
      const G = 'F 旧单兼容'
      // F-1 旧状态 demo_confirm + 旧事件 demo_confirmed 仍能进 ready_dev
      const opened = await callTool(h, 'pipeline_task_open', { requirement: 'F31 旧单兼容：P4 旧名字上的单。' }, 'f31-legacy-main')
      if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
      const oldId = opened.value.task_id
      const oldMain = opened.value.role_token
      const token = h.tokens.mint({ taskId: oldId, role: 'main', agentId: 'f31-legacy-main' }).token
      const t = h.store.peek(oldId)
      t.state = ST.DEMO_CONFIRM
      t.roster = { tier: 'L3', execution_roles: ['writer', 'tester', 'reviewer', 'architect', 'security', 'archivist'] }
      t.demo = {
        plan: { tier: 'L3', action: 'require', assumed: false, reason: 'P4 旧单', at: '2026-01-01T00:00:00Z', by: 'main' },
        rounds: [{ index: 1, digest: 'legacy-d1', ref: 'demo/old.html', human_request_id: 'HR-LEGACY-1', at: '2026-01-02T00:00:00Z', by: 'writer' }],
        confirmed_at: '2026-01-03T00:00:00Z',
        confirm_request_id: 'HR-LEGACY-1',
        confirm_answer: '可以',
        confirmed_by: 'main',
      }
      t.human_requests = [{ request_id: 'HR-LEGACY-1', status: 'answered', answer_text: '可以', answer: '可以' }]
      await h.store.recordAudit(oldId, 'main', 'fixture:legacy_demo_confirm', { note: '把旧单摆到 demo_confirm' })
      const legacyPass = await h.store.transition({ taskId: oldId, event: DEMO_EVENTS.LEGACY_CONFIRM, actorRole: 'main', actorAgentId: 'f31-legacy-main' })
      rec.add(
        G,
        '★★ 旧状态 `demo_confirm` + 旧事件 `demo_confirmed` ⇒ 仍能进 ready_dev（旧单不因改名而红）',
        legacyPass.ok === true && h.store.peek(oldId).state === ST.READY_DEV,
        JSON.stringify({ ok: legacyPass.ok, code: legacyPass.code ?? null, state: h.store.peek(oldId).state }),
      )
      rec.add(G, '★ 旧状态有中文名（status 展示不会只剩英文 id）', String(STATE_LABEL[ST.DEMO_CONFIRM]).length > 0, STATE_LABEL[ST.DEMO_CONFIRM])

      // F-2 已到 ready_dev 的旧任务（没有任何 DEMO 账本）不因新状态而红
      const opened2 = await callTool(h, 'pipeline_task_open', { requirement: 'F31 旧单兼容：已到待开发的旧任务。' }, 'f31-old-main')
      if (opened2.denied) throw new Error(`开单失败：\n${opened2.text}`)
      const oldDev = opened2.value.task_id
      const t2 = h.store.peek(oldDev)
      t2.state = ST.READY_DEV
      t2.roster = { tier: 'L2', execution_roles: ['writer', 'tester', 'reviewer', 'architect', 'archivist'] }
      t2.demo = null
      await h.store.recordAudit(oldDev, 'main', 'fixture:old_ready_dev', { note: '旧任务没有 DEMO 账本' })
      const status = await h.store.status({ taskId: oldDev })
      const dispatch = await h.store.transition({ taskId: oldDev, event: 'dispatch_writer', actorRole: 'main', actorAgentId: 'f31-old-main' })
      rec.add(
        G,
        '★★ 已到 ready_dev 的旧任务（`demo:null`）⇒ status 正常 + 能继续派编写（迁移判据只对"从 planning 出发"生效）',
        status.ok === true && status.state === ST.READY_DEV && dispatch.ok === true && h.store.peek(oldDev).state === ST.DEVELOPING,
        JSON.stringify({ statusOk: status.ok, state: status.state, dispatch: dispatch.ok }),
      )
      rec.add(G, '★ 旧任务的 next_events 里没有 DEMO 阶段（不会要求它补一轮）', (status.next_events ?? []).every((e) => !String(e.event).startsWith('demo_')), JSON.stringify((status.next_events ?? []).map((e) => e.event)))
      void oldMain
      void token
      void availableTransitions
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
  runF31DemoStageCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
