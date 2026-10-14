/**
 * dsh-pipeline · 第 6 轮追加需求自测：拆角色 / 澄清前置 / 按层分工
 * ============================================================================
 *     node tests/plan-check.mjs
 *
 * 本套覆盖本轮（第六轮）改动的四条链路：
 *
 *   A. **拆角色**：`orchestrator` 只做需求分析（出任务卡 + **不清楚处清单**），
 *      **`planner` 才有分配权**（角色清单 / 用几个 AI / 派谁 / 什么顺序）。
 *   B. **澄清前置到人工确认**：分析完 → 主对话 → **用户**确认 → 才允许进计划。
 *      没有用户答复，`requirement_confirmed` 这条边**过不去**（机制，不是习惯）。
 *   C. **计划缺失回流**：planner 自检 verdict=gaps ⇒ 退回需求分析（**沿用既有两级梯**，
 *      没有另起一套并行机制）；需求分析答不了 ⇒ 升级主对话 → 用户。
 *   D. **按层分工 + 席位 3→6**：席位数 = 层数；`scope_paths` 的越界写执法
 *      **一条都没少**；count=1 仍是同一套机制的退化情形。
 *
 * @module dsh-pipeline/tests/plan-check
 */

import { join } from 'node:path'

import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与其它套同形）
// ---------------------------------------------------------------------------

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

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
  }
}

const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

function expectDenied(rec, group, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
    group,
    name,
    pass,
    pass
      ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
      : `期望被拒但 denied=${res.denied} layer=${res.layer}` +
        (missing.length > 0 ? `\n缺少关键片段：${missing.join(' ｜ ')}` : '') +
        `\n实际原文：\n${indent(res.text)}`,
  )
  return pass
}

function expectOk(rec, group, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    group,
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

const AGENTS = { main: 'plan-main', orchestrator: 'plan-orch', planner: 'plan-planner' }

/** 三层默认层清单（与 roles.js 的 DEFAULT_WRITER_LAYERS 同源）。 */
const THREE_LAYERS = ['interface', 'data', 'logic']

const LAYERED_WRITERS = {
  layers: THREE_LAYERS,
  partitions: [
    { seat: 'writer#1', layer: 'interface', scope_paths: ['src/interface'], deliverables: ['接口定义'] },
    { seat: 'writer#2', layer: 'data', scope_paths: ['src/data'], deliverables: ['数据访问'] },
    { seat: 'writer#3', layer: 'logic', scope_paths: ['src/logic'], deliverables: ['业务处理'] },
  ],
  reason: '接口先冻结，三层路径互不重叠，可并行',
}

/**
 * 走到「待计划」为止（需求分析 + **用户确认**），把后续步骤留给用例自己决定。
 *
 * 抽出来是因为 C 组（计划缺失回流）需要在"计划之前"分叉，而公共夹具
 * `runAnalysisThenPlan` 是一路走到底的。
 */
async function toReadyPlan(h, opts = {}) {
  const MAIN = AGENTS.main
  const req = opts.requirement ?? '给订单系统加导出功能：接口层、数据层、处理层三块并行推进。'
  const opened = await callTool(h, 'pipeline_task_open', { requirement: req, deliverable_format: '补丁 + 变更说明 + 可运行命令' }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }

  const dOrch = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'orchestrator', spawn: false, role_token: tokens.main }, MAIN)
  if (dOrch.denied) throw new Error(`派需求分析失败：\n${dOrch.text}`)
  agents.orchestrator = dOrch.value?.agent_id ?? 'manual-orchestrator'
  tokens.orchestrator = dOrch.value?.token ?? ''

  const analysis = await callTool(
    h,
    'pipeline_orchestrate',
    {
      task_id: taskId,
      acceptance: opts.acceptance ?? ['三层各自的产物齐全', '接口契约冻结', '有独立测试且通过'],
      test_points: opts.testPoints ?? ['正常路径', '边界值', '层间接口不被绕过'],
      boundaries: opts.boundaries ?? ['不改动既有公开接口'],
      unclear_points: opts.unclearPoints ?? [],
      open_assumptions: opts.openAssumptions ?? [],
      analysis_reason: opts.analysisReason ?? '按用户原话拆解；三层路径可由目录切分；验收标准逐条可判定。',
      role_scope: opts.roleScope ?? ROLE_SCOPE.requirementAnalysis,
      role_token: tokens.orchestrator,
    },
    agents.orchestrator,
  )

  let confirm = null
  if (opts.analysisOk !== false) {
    if (analysis.denied) throw new Error(`需求分析失败：\n${analysis.text}`)
    confirm = await callTool(
      h,
      'pipeline_human_request',
      {
        task_id: taskId,
        reason_kind: 'requirement_confirmation',
        question_for_human: '需求分析已经出结论（含不清楚处清单），可以按这份理解往下做吗？',
        context_for_human: '确认之后才会把需求交给计划 AI 去切分与分配。',
        blocking: opts.confirmBlocking !== false,
        blocked_stage: '需求确认',
        urgency: 'blocking',
        decision_kind: 'yes_no',
        timeout_behavior: 'stay_blocked',
        role_token: tokens.orchestrator,
      },
      agents.orchestrator,
    )
    if (opts.confirmOk !== false) {
      if (confirm.denied) throw new Error(`提请需求确认失败：\n${confirm.text}`)
      await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: confirm.value.request_id, role_token: tokens.main }, MAIN)
      const rp = await callTool(
        h,
        'pipeline_human_reply',
        {
          task_id: taskId,
          request_id: confirm.value.request_id,
          user_quote: '就按这份理解做，验收标准和边界我看过了。',
          reply_channel: 'chat',
          attribution: '用户在当前会话里直接回复',
          answer: true,
          role_token: tokens.main,
        },
        MAIN,
      )
      if (rp.denied) throw new Error(`记用户答复失败：\n${rp.text}`)
      // ★ 拿到用户答复之后，**主对话**才能把状态推进到「待计划」。
      //   这一步刻意与 user 答复分开：答复只证明"人回了"，推进是主对话按机制做事。
      if (opts.skipConfirmedTransition !== true) {
        const tr = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'requirement_confirmed', role_token: tokens.main }, MAIN)
        if (tr.denied) throw new Error(`需求确认后推进失败：\n${tr.text}`)
      }
    }
  }

  return { h, taskId, tokens, agents, analysis, confirm, requirement: req }
}

/** 派计划 AI 并返回它的令牌。 */
async function dispatchPlanner(h, taskId, tokens, agents) {
  const dp = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'planner', spawn: false, role_token: tokens.main }, agents.main)
  if (dp.denied) throw new Error(`派计划 AI 失败：\n${dp.text}`)
  agents.planner = dp.value?.agent_id ?? 'manual-planner'
  tokens.planner = dp.value?.token ?? ''
  return dp
}

const OK_CHECK = { verdict: 'ok', checked: ['需求覆盖', '层边界', '依赖顺序', '验收可测'], gaps: [] }

/** 职责自限声明的默认值（设计与计划的必填字段）。 */
const ROLE_SCOPE = {
  requirementAnalysis: {
    will_do: ['出任务卡 / 验收标准 / 边界 / 测试要点', '列需求不清楚处并提请用户确认'],
    will_not_do: ['不分配 AI、不定档、不读代码、不写实现'],
  },
  plan: {
    will_do: ['出计划、自检、分配 AI（角色清单 / 席位 / 层）'],
    will_not_do: ['不改需求、不写实现、不读代码、不自己执行任务'],
  },
}

/** 授权改动面：三层各授权一个目录（夹具）。 */
const CHANGE_SCOPE = THREE_LAYERS.map((l, i) => ({
  id: `CS${i + 1}`,
  path: `src/${l}`,
  action: 'modify',
  why: `夹具：${l} 层的改动就在这个目录下`,
}))

/** 角色边界卡：覆盖 L2 的全部执行角色。 */
const ROLE_BOUNDARIES = ['architect', 'writer', 'tester', 'reviewer', 'diagrammer', 'archivist'].map((r) => ({
  role: r,
  only: [`只干「${r}」这一份活`],
  not: ['不干别人的活', '不扩大改动面'],
}))

/** 交一份计划（含自检）。 */
function planArgs(taskId, token, over = {}) {
  return {
    task_id: taskId,
    plan_steps: ['冻结接口契约', '按层并行实现', '各层自测后交测试', '测试通过交审核'],
    layers: THREE_LAYERS.map((l) => ({ layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
    self_check_verdict: OK_CHECK.verdict,
    self_check_checked: OK_CHECK.checked,
    self_check_gaps: OK_CHECK.gaps,
    plan_reason: '三层路径互不重叠，接口先冻结再并行。',
    change_scope: CHANGE_SCOPE,
    forbidden: ['不许顺手重构', '不许改测试', '不许扩大范围', '不许改依赖'],
    role_boundaries: ROLE_BOUNDARIES,
    role_scope: ROLE_SCOPE.plan,
    tier: 'L2',
    reason: '跨模块 + 需要冻结接口契约 ⇒ L2；按层并行',
    writers: LAYERED_WRITERS,
    role_token: token,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runPlanCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 拆角色：需求分析只出结论，分配权在 planner
  // =========================================================================
  {
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const allocated = await callTool(h, 'pipeline_plan', planArgs(g.taskId, g.tokens.planner), g.agents.planner)
    if (allocated.denied) throw new Error(`分配失败：\n${allocated.text}`)

    // 需求分析交的是一份**分析结论**（不是角色清单）
    const st = h.store.peek(g.taskId)
    const an = (st.handoffs ?? []).filter((x) => x.kind === 'requirement_analysis').at(-1)
    rec.add(
      'A 拆角色',
      '★ 需求分析交的是 requirement_analysis（含**不清楚处清单**），不是角色清单',
      an !== undefined && Array.isArray(an.payload?.unclear_points) && st.roster !== null,
      `交接物 kind=${an?.kind}\nunclear_points=${JSON.stringify(an?.payload?.unclear_points)}\n` +
        `★ 注意：此时 roster 已经有值 —— 那是**计划 AI** 写的（见下一条）`,
    )
    rec.add(
      'A 拆角色',
      '★ 角色清单的产出者是**计划 AI**（judged_by=planner / decided_by=planner）',
      st.roster?.judged_by === 'planner' && (st.roster?.writers?.decided_by ?? '') === 'planner',
      `judged_by=${st.roster?.judged_by}\nwriters.decided_by=${st.roster?.writers?.decided_by}\n` +
        `执行角色=${st.roster?.execution_roles?.join('/')}`,
    )
    rec.add(
      'A 拆角色',
      '★ 独立对话清单里**需求分析与计划是两个**（L2 从 8 → 9）',
      Array.isArray(st.roster?.conversations) && st.roster.conversations.includes('orchestrator') && st.roster.conversations.includes('planner') && st.roster.ai_count === 9,
      `conversations=${st.roster?.conversations?.join(' / ')}\nai_count=${st.roster?.ai_count}`,
    )
    rec.add(
      'A 拆角色',
      '调用顺序是「需求分析 → 计划 →（咨询）→ 编写 → 测试 → 审核 → 尾」',
      (() => {
        const seq = (st.roster?.sequence ?? []).map((x) => x.role)
        return seq[0] === 'orchestrator' && seq[1] === 'planner' && seq.indexOf('writer') < seq.indexOf('tester') && seq.indexOf('tester') < seq.indexOf('reviewer')
      })(),
      `sequence=${(st.roster?.sequence ?? []).map((x) => `${x.phase}:${x.role}`).join(' → ')}`,
    )

    // 反例：需求分析**不能**产出角色清单（它不再接 tier）
    const g2 = await toReadyPlan(await createHarness(), { analysisOk: false })
    open.push(g2.h)
    const orchWithTier = await callTool(
      g2.h,
      'pipeline_orchestrate',
      { task_id: g2.taskId, acceptance: ['x'], test_points: ['y'], boundaries: [], unclear_points: [], analysis_reason: 'z', tier: 'L2', reason: '我来定档', role_token: g2.tokens.orchestrator },
      g2.agents.orchestrator,
    )
    expectDenied(rec, 'A 拆角色', '反例：需求分析试图自己定档 / 产出角色清单 → 拒', orchWithTier, ['需求分析不再接收 tier', '计划 AI'])
  }

  // =========================================================================
  // B. 澄清前置到人工确认
  // =========================================================================
  {
    // 反例①：用户还没答复 ⇒ 不许进计划
    //
    //   这里刻意用**非阻塞**的确认请求：那样状态会留在「需求分析中」，
    //   于是这条用例考的就是 `requirement_confirm_gate` 这道闸本身，
    //   而不是"状态不对所以事件不适用"（后者是状态机的第一道闸，另有覆盖）。
    const g = await toReadyPlan(await createHarness(), { confirmOk: false, confirmBlocking: false })
    open.push(g.h)
    const before = await callTool(g.h, 'pipeline_transition', { task_id: g.taskId, event: 'requirement_confirmed', role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, 'B 澄清前置', '反例① ★ 没有用户答复就要进计划 → 拒', before, [
      'REQUIREMENT_NOT_CONFIRMED|没有经过用户人工确认',
      '确认请求|人工确认',
      'pipeline_human_reply|pipeline_human_request',
    ])
    const st1 = g.h.store.peek(g.taskId)
    rec.add(
      'B 澄清前置',
      '★ 拒了之后状态**停在**「需求分析中」，没有偷偷前进',
      st1.state === 'analyzing',
      `state=${st1.state}（应为 analyzing）`,
    )

    // 反例②：计划 AI 在用户确认前就被派 ⇒ 拒（引导步按状态判）
    const early = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'planner', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, 'B 澄清前置', '反例② ★ 用户确认之前派计划 AI → 拒', early, ['还没有角色清单', '需求分析', '用户确认'])

    // 反例③：主对话不能替用户拍板（没转告就记答复）
    const fake = await callTool(
      g.h,
      'pipeline_human_reply',
      { task_id: g.taskId, request_id: g.confirm.value.request_id, user_quote: '用户说可以', attribution: '用户', answer: true, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, 'B 澄清前置', '反例③ ★ 没转告就记用户答复 → 拒（主对话不得替用户拍板）', fake, ['还没有转告给用户', 'pipeline_human_relay'])
  }
  {
    // 正例：走完整链路（含**不清楚处非空**的情形）
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {
      unclearPoints: ['导出的 CSV 要不要带 BOM（Excel 直接打开不乱码）？', '单次导出上限是多少条？'],
      analysisReason: '两处会做出不同的东西，必须先定死。',
    })
    const st = h.store.peek(g.taskId)
    rec.add(
      'B 澄清前置',
      '★ 正例：用户答复后状态回到「需求分析中」，再推进到「待计划」',
      st.state === 'ready_plan',
      `state=${st.state}\n确认请求：${g.confirm.value.request_id}（reason_kind=requirement_confirmation，status=${st.human_requests.at(-1)?.status}）`,
    )
    rec.add(
      'B 澄清前置',
      '★ 需求确认走的是**既有** human_request 链（四步留痕齐全，没有另开通道）',
      (() => {
        const acts = (st.history ?? []).map((x) => x.action)
        return ['human:request', 'human:relay', 'human:reply', 'human:resume'].every((a) => acts.includes(a))
      })(),
      `human:* = ${(st.history ?? []).map((x) => x.action).filter((a) => String(a).startsWith('human:')).join(' → ')}`,
    )
    rec.add(
      'B 澄清前置',
      '★ 不清楚处清单被原样带进确认请求（用户看到的是**具体那几条**）',
      (st.human_requests.at(-1)?.question_for_human ?? '').includes('不清楚') === true,
      `question_for_human=${st.human_requests.at(-1)?.question_for_human}`,
    )

    // 反例：需求分析**漏给** unclear_points（必填）
    const g2 = await toReadyPlan(await createHarness(), { analysisOk: false })
    open.push(g2.h)
    const noUnclear = await callTool(
      g2.h,
      'pipeline_orchestrate',
      { task_id: g2.taskId, acceptance: ['x'], test_points: ['y'], boundaries: [], analysis_reason: 'z', role_token: g2.tokens.orchestrator },
      g2.agents.orchestrator,
    )
    expectDenied(rec, 'B 澄清前置', '反例④ 需求分析漏给 unclear_points（必填）→ 拒', noUnclear, ['unclear_points', '必填', '空数组'])

    // 反例：有假设却说不清楚处为空（自相矛盾）
    const contradictory = await callTool(
      g2.h,
      'pipeline_orchestrate',
      {
        task_id: g2.taskId,
        acceptance: ['x'],
        test_points: ['y'],
        boundaries: [],
        unclear_points: [],
        open_assumptions: ['我假设导出格式是 CSV'],
        analysis_reason: 'z',
        role_token: g2.tokens.orchestrator,
      },
      g2.agents.orchestrator,
    )
    expectDenied(rec, 'B 澄清前置', '反例⑤ 有 open_assumptions 却说"没有不清楚处" → 拒（把假设当成用户意图）', contradictory, [
      'open_assumptions',
      '自相矛盾|假设',
    ])
  }

  // =========================================================================
  // C. 计划缺失回流（沿用两级梯）
  // =========================================================================
  {
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)

    const gap = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, {
        self_check_verdict: 'gaps',
        self_check_checked: ['需求覆盖', '层边界'],
        self_check_gaps: ['数据层的表结构变更顺序没定：先改表还是先改读写？'],
        gap_stage: '计划：数据层与接口层的先后',
        gap_question: '数据层要先改表结构还是先改读写逻辑？两种顺序的回滚成本不一样。',
        gap_context: '这一处定不下来，三层就没法真正并行（数据层会挡住处理层）。',
        gap_urgency: 'blocking',
        tier: undefined,
        reason: undefined,
        writers: undefined,
      }),
      g.agents.planner,
    )
    expectOk(rec, 'C 缺失回流', '★ 计划自检 gaps → 交计划成功，但**不分配**', gap, ['gaps', '不会分配'])
    rec.add(
      'C 缺失回流',
      '★ `allocated=false` 且 roster **仍为空**（自检没过就不许分配）',
      gap.value?.allocated === false && g.h.store.peek(g.taskId).roster === null,
      `allocated=${gap.value?.allocated}  roster=${g.h.store.peek(g.taskId).roster === null ? 'null ✓' : '非空 ✗'}`,
    )
    rec.add(
      'C 缺失回流',
      '★ 状态推进到「等待需求分析答复」—— 回流走的是**既有第一级**，没有另起通道',
      g.h.store.peek(g.taskId).state === 'awaiting_clarification',
      `state=${g.h.store.peek(g.taskId).state}\nclarification_requests=${(g.h.store.peek(g.taskId).clarification_requests ?? []).map((r) => `${r.request_id}(from=${r.from_role},status=${r.status})`).join(', ')}`,
    )
    rec.add(
      'C 缺失回流',
      '★ 回流记录挂在**第一级澄清梯**上（from_role=planner，不是新类型）',
      (g.h.store.peek(g.taskId).clarification_requests ?? []).some((r) => r.from_role === 'planner'),
      `clarification_requests = ${JSON.stringify((g.h.store.peek(g.taskId).clarification_requests ?? []).map((r) => ({ id: r.request_id, from: r.from_role, q: r.question })), null, 2)}`,
    )

    // 反例：缺口没补就想硬写角色清单 → 拒
    const hardAlloc = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, { self_check_verdict: 'ok', self_check_gaps: [] }),
      g.agents.planner,
    )
    expectDenied(rec, 'C 缺失回流', '反例① ★ 缺口没补就硬分配 → 拒（状态闸：它还在等需求分析）', hardAlloc, ['跳步', 'plan'])

    // 需求分析裁定 → 恢复 → 重交通过的计划 → 分配成功
    const rid = (g.h.store.peek(g.taskId).clarification_requests ?? []).at(-1).request_id
    const reply = await callTool(
      h,
      'pipeline_clarify_reply',
      {
        task_id: g.taskId,
        request_id: rid,
        verdict: 'answered',
        answer: '先改读写逻辑并加兼容分支，再改表结构；回滚时先回代码再回表。',
        reason: '这是需求层能定的顺序约束（验收标准里"不改动既有公开接口"就要求先兼容）。',
        constraints_added: ['数据层必须提供读写兼容分支'],
        role_token: g.tokens.orchestrator,
      },
      g.agents.orchestrator,
    )
    expectOk(rec, 'C 缺失回流', '★ 需求分析裁定 answered → 状态回到「计划中」', reply, ['已裁定', 'answered|直接答复'])
    rec.add(
      'C 缺失回流',
      '★ 恢复语义：回到**被打断前**的状态（计划中），不是"待计划"',
      g.h.store.peek(g.taskId).state === 'planning',
      `state=${g.h.store.peek(g.taskId).state}（应为 planning）`,
    )

    const redo = await callTool(h, 'pipeline_plan', planArgs(g.taskId, g.tokens.planner), g.agents.planner)
    expectOk(rec, 'C 缺失回流', '★ 补完缺口后重交计划（自检 ok）→ 分配成功、进「待开发」', redo, ['角色清单已产出', '待开发|计划自检通过'])
    const st = g.h.store.peek(g.taskId)
    rec.add(
      'C 缺失回流',
      '★ 分配后状态是「待开发」，且层清单落进角色清单',
      st.state === 'ready_dev' && Array.isArray(st.roster?.writers?.layers) && st.roster.writers.layers.length === 3,
      `state=${st.state}\nlayers=${JSON.stringify(st.roster?.writers?.layers)}\ncount=${st.roster?.writers?.count}`,
    )

    // 反例：planner 跳级直接找用户 → 拒（必须先问需求分析）
    const skip = await callTool(
      h,
      'pipeline_human_request',
      {
        task_id: g.taskId,
        reason_kind: 'approval_needed',
        question_for_human: '这一处顺序要不要你定？',
        blocking: true,
        blocked_stage: '计划',
        urgency: 'normal',
        decision_kind: 'yes_no',
        timeout_behavior: 'stay_blocked',
        role_token: g.tokens.planner,
      },
      g.agents.planner,
    )
    expectDenied(rec, 'C 缺失回流', '反例② ★ 计划 AI 跳级直接找用户 → 拒（必须先问需求分析）', skip, ['跳级', 'pipeline_clarify_request'])
  }
  {
    // 需求分析答不了 ⇒ 升级用户（沿用两级梯）
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, {
        self_check_verdict: 'gaps',
        self_check_checked: ['需求覆盖'],
        self_check_gaps: ['客户要的导出模板句式没给，是超出原范围的新需求'],
        gap_stage: '计划：交付物形态',
        gap_question: '导出模板的句式由谁定？现有需求里没有这一条。',
        gap_context: '这一条属于新增需求，计划层定不了。',
        gap_urgency: 'blocking',
      }),
      g.agents.planner,
    )
    const rid = (h.store.peek(g.taskId).clarification_requests ?? []).at(-1).request_id
    const cannot = await callTool(
      h,
      'pipeline_clarify_reply',
      {
        task_id: g.taskId,
        request_id: rid,
        verdict: 'cannot_answer',
        reason: '这是新增需求（超出原任务卡范围），要用户拍板。',
        escalate: true,
        role_token: g.tokens.orchestrator,
      },
      g.agents.orchestrator,
    )
    expectOk(rec, 'C 缺失回流', '★ 需求分析答不了（cannot_answer）', cannot, ['答不了'])
    const up = await callTool(
      h,
      'pipeline_human_request',
      {
        task_id: g.taskId,
        reason_kind: 'scope_change',
        question_for_human: '导出模板的句式是一条新需求，要做吗？',
        context_for_human: '需求分析与计划都定不了这一条，需要你拍板。',
        blocking: true,
        blocked_stage: '计划：交付物形态',
        urgency: 'blocking',
        decision_kind: 'yes_no',
        timeout_behavior: 'stay_blocked',
        escalated_from: (h.store.peek(g.taskId).clarification_requests ?? []).at(-1).handoff_id,
        raised_by: 'planner',
        orchestrator_reason: '这是新增需求，超出原任务卡范围，需求层定不了。',
        role_token: g.tokens.orchestrator,
      },
      g.agents.orchestrator,
    )
    expectOk(rec, 'C 缺失回流', '★ 升级链路：需求分析 → human_request（带 escalated_from/raised_by/orchestrator_reason）', up, ['人工介入请求|已登记'])
    rec.add(
      'C 缺失回流',
      '★ 单向门：上游澄清请求被标成 escalated，需求分析不能再改口',
      (h.store.peek(g.taskId).clarification_requests ?? []).at(-1)?.status === 'escalated',
      `clarification.status=${(h.store.peek(g.taskId).clarification_requests ?? []).at(-1)?.status}`,
    )
    const relayed = await callTool(h, 'pipeline_human_relay', { task_id: g.taskId, request_id: up.value.request_id, role_token: g.tokens.main }, g.agents.main)
    expectOk(rec, 'C 缺失回流', '★ 主对话转告用户（唯一通道）', relayed, ['照抄这段', '确认码'])
    const answered = await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: g.taskId,
        request_id: up.value.request_id,
        user_quote: '不做模板，先把默认导出做出来。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        answer: false,
        role_token: g.tokens.main,
      },
      g.agents.main,
    )
    expectOk(rec, 'C 缺失回流', '★ 用户答复后恢复（回到最初被打断的工作状态）', answered, ['已记录答复并推进'])
    rec.add(
      'C 缺失回流',
      '★ 恢复目标是**最初**被打断的工作状态（不是 awaiting_clarification）',
      h.store.peek(g.taskId).state === 'planning',
      `state=${h.store.peek(g.taskId).state}  previous_state=${h.store.peek(g.taskId).previous_state}`,
    )
  }

  // =========================================================================
  // D. 按层分工 + 席位 3→6
  // =========================================================================
  {
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const ok = await callTool(h, 'pipeline_plan', planArgs(g.taskId, g.tokens.planner), g.agents.planner)
    expectOk(rec, 'D 按层分工', '★ 三层 ⇒ 三个席位（席位数 = 层数）', ok, ['编写席位：3 个'])
    const parts = h.store.peek(g.taskId).roster?.writers?.partitions ?? []
    rec.add(
      'D 按层分工',
      '★ 每条分区都带 `layer`，且**同时**带 `scope_paths`（按层不取消路径执法）',
      parts.length === 3 && parts.every((p) => typeof p.layer === 'string' && Array.isArray(p.scope_paths) && p.scope_paths.length > 0),
      `partitions=${JSON.stringify(parts.map((p) => ({ seat: p.seat, layer: p.layer, scope_paths: p.scope_paths })), null, 2)}`,
    )

    // 反例：非计划 AI 调 pipeline_plan（分配权是闭的）
    const byMain = await callTool(g.h, 'pipeline_plan', planArgs(g.taskId, g.tokens.main), g.agents.main)
    expectDenied(rec, 'D 按层分工', '反例⓪ 主对话调 pipeline_plan（抢分配权）→ 守门拒', byMain, ['planner', '角色'])

    // ★ 按层分工**没有**放松越界写执法：writer#1（接口层，范围 src/api）
    //   去写 writer#2 的数据层路径 → 守门必须拦下。
    //
    //   这里直接铸一枚 writer#1 的令牌（不派真会话）：本组要验的是**路径执法**，
    //   而派活那一步还要先补需求档（另一条判据，writers-check 里已有覆盖）。
    const w1 = g.h.tokens.mint({ taskId: g.taskId, role: 'writer', seat: 'writer#1', agentId: 'layer-layer-w1', note: 'plan-check' })
    // ⚠️ 路径要用**授权面之内**的地方：本用例验的是"分区执法还在"，
    //    写到授权面之外会先撞上另一条判据（改动面），测的就不是分区了。
    //    —— 那两条判据各有一条用例，分工明确。
    const crossWrite = await callTool(
      g.h,
      'write',
      { path: join(g.h.projectRoot, 'src/data/schema.sql'), content: '-- 我是接口层席位，但我改数据层的东西', role_token: w1.token },
      'layer-layer-w1',
    )
    expectDenied(rec, 'D 按层分工', '★ 反例⑤ 越界写别人的层 → 守门拒（层不替代路径执法）', crossWrite, ['分区', 'src/interface', 'writer#2'])
    const ownWrite = await callTool(
      g.h,
      'write',
      { path: join(g.h.projectRoot, 'src/interface/routes.js'), content: '// 我自己的接口层，随便写', role_token: w1.token },
      'layer-layer-w1',
    )
    rec.add(
      'D 按层分工',
      '★ 对照：写自己那一层不受限（执法只挡越界）',
      ownWrite.denied !== true,
      `layer=${ownWrite.layer}\n${ownWrite.text}`,
    )
  }
  {
    // 反例：count 与层数不一致
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const bad = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, { writers: { ...LAYERED_WRITERS, count: 2 } }),
      g.agents.planner,
    )
    expectDenied(rec, 'D 按层分工', '反例① count 与 layers 层数对不上 → 拒', bad, ['对不上', '席位数由层数决定'])
  }
  {
    // 反例：多席位但不给 layers
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const bad = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, { writers: { count: 2, partitions: LAYERED_WRITERS.partitions.slice(0, 2), reason: '我随便分两个' } }),
      g.agents.planner,
    )
    expectDenied(rec, 'D 按层分工', '反例② 多席位却不给层清单 → 拒（多席位必须按层分工）', bad, ['没有给 layers', '按**层**分工|按层分工'])
  }
  {
    // 反例：层重复 / 缺 scope_paths
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const dup = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, {
        writers: {
          layers: ['interface', 'interface'],
          partitions: [
            { seat: 'writer#1', layer: 'interface', scope_paths: ['src/a'] },
            { seat: 'writer#2', layer: 'interface', scope_paths: ['src/b'] },
          ],
          reason: '两层同名',
        },
      }),
      g.agents.planner,
    )
    expectDenied(rec, 'D 按层分工', '反例③ 层清单里有重复层 id → 拒', dup, ['重复的层 id', '一个层只能有一个席位'])

    const noScope = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, {
        writers: {
          layers: ['interface', 'data'],
          partitions: [
            { seat: 'writer#1', layer: 'interface', scope_paths: ['src/a'] },
            { seat: 'writer#2', layer: 'data' },
          ],
          reason: '有一个席位没写范围',
        },
      }),
      g.agents.planner,
    )
    expectDenied(rec, 'D 按层分工', '反例④ 某席位没声明 scope_paths → 拒（层不替代路径）', noScope, ['scope_paths', '按层分工**不取消**路径执法|不取消'])
  }
  {
    // 席位上限 6：6 个层可以，7 个层不行
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const six = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']
    const okSix = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, {
        writers: {
          layers: six,
          partitions: six.map((l, i) => ({ seat: `writer#${i + 1}`, layer: l, scope_paths: [`src/${l}`] })),
          reason: '六个层，六个席位（本轮硬上限 6）',
        },
      }),
      g.agents.planner,
    )
    expectOk(rec, 'D 按层分工', '★ 6 个层 ⇒ 6 个席位可以（上限 3 → 6）', okSix, ['编写席位：6 个'])
    rec.add(
      'D 按层分工',
      '★ 席位 id 形状 writer#1..writer#6 都合法',
      (h.store.peek(g.taskId).roster?.writers?.partitions ?? []).map((p) => p.seat).join(',') === 'writer#1,writer#2,writer#3,writer#4,writer#5,writer#6',
      `seats=${(h.store.peek(g.taskId).roster?.writers?.partitions ?? []).map((p) => p.seat).join(', ')}`,
    )

    const h2 = await createHarness()
    open.push(h2)
    const g2 = await toReadyPlan(h2, {})
    await dispatchPlanner(h2, g2.taskId, g2.tokens, g2.agents)
    const seven = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']
    const badSeven = await callTool(
      h2,
      'pipeline_plan',
      planArgs(g2.taskId, g2.tokens.planner, {
        writers: {
          layers: seven,
          partitions: seven.map((l, i) => ({ seat: `writer#${i + 1}`, layer: l, scope_paths: [`src/${l}`] })),
          reason: '七个层',
        },
      }),
      h2.agents?.planner ?? undefined,
    )
    expectDenied(rec, 'D 按层分工', '★ 7 个层 → 拒（超过硬上限 6）', badSeven, ['硬上限 6', '超出本档允许范围'])
  }
  {
    // count=1 退化等价：计划里不给 writers ⇒ 一个席位，层退化成 all，范围整棵项目根
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})
    await dispatchPlanner(h, g.taskId, g.tokens, g.agents)
    const one = await callTool(
      h,
      'pipeline_plan',
      planArgs(g.taskId, g.tokens.planner, { layers: [], writers: undefined, tier: 'L1', reason: '单块改动，一个席位足够' }),
      g.agents.planner,
    )
    expectOk(rec, 'D 按层分工', '★ count=1：不给 writers 也能分配（同一套机制的退化情形）', one, ['编写席位：1 个'])
    rec.add(
      'D 按层分工',
      '★ 退化情形：层清单 = [all]、范围 = 整棵项目根、layer = all（走的还是同一份 buildWriters）',
      (() => {
        const w = h.store.peek(g.taskId).roster?.writers
        return (
          w?.count === 1 &&
          Array.isArray(w.layers) &&
          w.layers.length === 1 &&
          w.layers[0] === 'all' &&
          w.partitions.length === 1 &&
          w.partitions[0].layer === 'all' &&
          w.partitions[0].scope_paths.length === 1 &&
          w.partitions[0].scope_paths[0] === '.'
        )
      })(),
      `writers=${JSON.stringify(h.store.peek(g.taskId).roster?.writers, null, 2)}`,
    )
  }

  // =========================================================================
  // E. ★ 引导步死锁回归（真单 T-20261011-a5fe41）
  //
  //   现场：状态已经推到「计划中」，但 `roster` 还是 null —— 因为
  //   `dispatch_planner`（ready_plan → planning）这条边的 `by` 里**有 main**，
  //   主对话自己也能触发它（真单历史里确实只有 `transition:dispatch_planner`，
  //   没有任何 dispatch 动作）。而这时再派 planner 会被引导步的 else 分支拒掉，
  //   `planned` / `plan_gap` 又**只有 planner 能发** ⇒ 单向死锁。
  //
  //   修法：引导态把「计划中」也算上（白名单仍**只有** planner，且只在 roster=null 时生效）。
  //   这一组就是钉住"解开了、但门没放宽"。
  // =========================================================================
  {
    const h = await createHarness()
    open.push(h)
    const g = await toReadyPlan(h, {})

    // ★ 复刻现场：主对话**自己**把状态推到「计划中」（不复用 dispatchPlanner，
    //   因为夹具那条路会顺手把 planner 派出去 —— 真单就没派）。
    const jumped = await callTool(
      h,
      'pipeline_transition',
      { task_id: g.taskId, event: 'dispatch_planner', role_token: g.tokens.main },
      g.agents.main,
    )
    if (jumped.denied) throw new Error(`复刻现场失败（dispatch_planner 应可由主对话触发）：\n${jumped.text}`)
    const st0 = h.store.peek(g.taskId)
    rec.add(
      'E 引导步死锁',
      '★ 复刻真单现场：「计划中」+ 角色清单仍为空（roster=null）',
      st0.state === 'planning' && st0.roster === null,
      `state=${st0.state}（应为 planning）\nroster=${st0.roster === null ? 'null' : 'NOT NULL'}`,
    )

    // 反例①：引导态**只**放开 planner —— 派别的角色仍然被拒
    for (const other of ['writer', 'tester', 'reviewer']) {
      const r = await callTool(
        h,
        'pipeline_dispatch',
        { task_id: g.taskId, role: other, spawn: false, role_token: g.tokens.main },
        g.agents.main,
      )
      expectDenied(rec, 'E 引导步死锁', `反例① ★ 「计划中」+ 空清单 ⇒ 派 ${other} 仍被拒`, r, [
        '还没有角色清单',
        '唯一能被派出去的角色是：计划。',
      ])
    }

    // 正例①：引导态派 planner 成功 —— 这就是死锁的出口
    const dp = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: g.taskId, role: 'planner', spawn: false, role_token: g.tokens.main },
      g.agents.main,
    )
    expectOk(rec, 'E 引导步死锁', '★ 正例① 「计划中」+ 空清单 ⇒ 派 planner **成功**（死锁解开）', dp, ['已派出'])
    g.agents.planner = dp.value?.agent_id ?? 'manual-planner'
    g.tokens.planner = dp.value?.token ?? ''
    rec.add(
      'E 引导步死锁',
      '★ 修的是"派得出去"、不是"清单被凭空造出来"：派完 roster 仍是 null，状态仍是计划中',
      h.store.peek(g.taskId).roster === null && h.store.peek(g.taskId).state === 'planning',
      `state=${h.store.peek(g.taskId).state}\nroster=${h.store.peek(g.taskId).roster === null ? 'null' : 'NOT NULL'}`,
    )

    // 正例②：派完之后 `planned` 走得通（计划 → 待开发），死锁真的解开了
    const allocated = await callTool(h, 'pipeline_plan', planArgs(g.taskId, g.tokens.planner), g.agents.planner)
    expectOk(rec, 'E 引导步死锁', '★ 正例② 派完之后交计划 ⇒ 状态正常走到「待开发」', allocated, [
      '角色清单已产出',
      '待开发|计划自检通过',
    ])
    const st1 = h.store.peek(g.taskId)
    rec.add(
      'E 引导步死锁',
      '★ 终局：state=ready_dev 且角色清单已产出（planner 照样得**过 `plan_ready` 守卫**才拿得到）',
      st1.state === 'ready_dev' && st1.roster !== null && st1.roster.conversations.includes('planner'),
      `state=${st1.state}\nconversations=${st1.roster?.conversations?.join(' / ')}`,
    )

    // 反例②：清单产出之后，**通用门一个字没改** —— 派不在册的角色仍被拒
    const notInRoster = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: g.taskId, role: 'security', spawn: false, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, 'E 引导步死锁', '反例② ★ 已有清单后派不在册的角色 → 仍被拒（"主对话不得自行改角色清单"没回退）', notInRoster, [
      '不在本任务的角色清单里',
      '不能自己决定加人减人',
    ])
  }
  {
    // 反例③：非引导态 + 空清单 ⇒ 派 planner 仍被拒（引导步只认那两站，不是"哪都能派 planner"）
    const h = await createHarness()
    open.push(h)
    const opened = await callTool(
      h,
      'pipeline_task_open',
      { requirement: '引导态边界：还没做需求分析就派计划 AI，应当被拒。' },
      AGENTS.main,
    )
    const taskId = opened.value.task_id
    const tokens = { main: opened.value.role_token }
    const early = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: taskId, role: 'planner', spawn: false, role_token: tokens.main },
      AGENTS.main,
    )
    expectDenied(rec, 'E 引导步死锁', '反例③ ★ 「待分配」（还没做需求分析）就派 planner → 拒', early, [
      '还没有角色清单',
      '需求分析',
      '用户确认',
    ])

    // 反例④：终态不接受任何派活
    const cancelled = await callTool(
      h,
      'pipeline_transition',
      { task_id: taskId, event: 'cancel', role_token: tokens.main },
      AGENTS.main,
    )
    if (cancelled.denied) throw new Error(`取消失败：\n${cancelled.text}`)
    rec.add(
      'E 引导步死锁',
      '★ 反例④ 前置：任务已进入终态「已取消」',
      h.store.peek(taskId).state === 'cancelled',
      `state=${h.store.peek(taskId).state}`,
    )
    const afterCancel = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: taskId, role: 'planner', spawn: false, role_token: tokens.main },
      AGENTS.main,
    )
    expectDenied(rec, 'E 引导步死锁', '★ 反例④ 终态（已取消）派 planner → 仍被拒', afterCancel, ['还没有角色清单'])
  }

  // =========================================================================
  // 报告
  // =========================================================================
  const groups = {}
  for (const it of rec.items) {
    if (groups[it.group] === undefined) groups[it.group] = []
    groups[it.group].push(it)
  }
  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 拆角色 / 澄清前置 / 计划回流 / 按层分工 自测')
  lines.push('='.repeat(78))
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      lines.push(indent(it.detail))
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  for (const h of open) {
    try {
      await disposeHarness(h)
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑：`node tests/plan-check.mjs`
if (process.argv[1] !== undefined && /plan-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runPlanCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
