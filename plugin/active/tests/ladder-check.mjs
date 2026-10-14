/**
 * dsh-pipeline · 两级升级梯自测
 * ============================================================================
 *     node tests/ladder-check.mjs
 *
 * 验的是一条拓扑约束：**执行角色不能一步就去找用户** ——
 * 先问「需求分析/编排判断」，它答不了才升级给用户。
 *
 *   ①角色提问 → ②需求分析裁定（answered / cannot_answer）→ ③升级 → ④转告 → ⑤用户答复 → ⑥恢复
 *
 * 关键回归点：`待测试 → 等需求分析 → 等用户` 这条链恢复时必须回到**最初被打断的工作状态**，
 * 不能回到 `awaiting_clarification`（那会永久卡死）。
 *
 * @module dsh-pipeline/tests/ladder-check
 */

import { callTool, createGuardFixture, manifestFor } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'

/**
 * ★ 夹具的「人工介入」基线条数。
 *
 * 为什么需要它：本轮起，任何 L1+ 任务在开工前**必须**经过一次
 * 「需求分析 → 用户确认」（用户拍板：澄清前置到人工确认）。
 * 所以夹具本身就会产生一条 `requirement_confirmation` 的 human_request ——
 * 「这一级不该惊动用户」的断言必须以**夹具基线**为准，钉死成 0 会把
 * 那条**正常的**确认也当成违规。
 */
function fixtureHumanBase(fx) {
  return (fx?.h?.store?.peek(fx.taskId)?.human_requests ?? []).length
}

// ---------------------------------------------------------------------------
// 断言小工具
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
    add(name, pass, detail) {
      items.push({ name, pass: pass === true, detail: String(detail ?? '') })
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

function expectDenied(rec, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
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

function expectOk(rec, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

/** 一份合法的澄清请求体。 */
function ask(over = {}) {
  return {
    stage: '测试：边界值判定',
    question: '参数为 0 时应当报错还是返回空结果？验收标准里两种读法都说得通。',
    context_digest: '同一份验收标准，两种读法都能自圆其说；两种做法对下游调用方的影响不同。',
    options: [
      { label: '报错', consequence: '调用方必须自己先判空，语义更严但要改一处调用' },
      { label: '返回空', consequence: '调用方不用改，但错误会被静默吞掉' },
    ],
    blocking: true,
    urgency: 'normal',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runLadderCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例①：需求分析**直接裁定** —— 全程没有惊动用户
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    rec.add('正例① 夹具：L2，有独立的需求分析/编排判断对话',
      fx.h.store.peek(fx.taskId)?.roster?.orchestrator_mode === 'separate',
      `orchestrator_mode=${fx.h.store.peek(fx.taskId)?.roster?.orchestrator_mode}  档位=${fx.h.store.peek(fx.taskId)?.roster?.tier}`)

    const before = fx.h.store.peek(fx.taskId).state
    const asked = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...ask(), role_token: fx.tokens.tester }, fx.agents.tester)
    expectOk(rec, '正例① 测试角色向上提问（第一级）', asked, ['澄清请求已登记', '等待需求分析答复', '没有'])
    const rid = asked.value?.request_id ?? ''

    let st = fx.h.store.peek(fx.taskId)
    rec.add('正例① 状态进入「等待需求分析答复」，并记下被打断前的状态',
      st.state === 'awaiting_clarification' && st.clarification_requests[0]?.state_at_request === before,
      `state=${st.state}  state_at_request=${st.clarification_requests[0]?.state_at_request}  （原状态 ${before}）`)

    const reply = await callTool(
      fx.h,
      'pipeline_clarify_reply',
      {
        task_id: fx.taskId, request_id: rid, verdict: 'answered',
        answer: '按「报错」—— 验收标准里"非法输入必须显式失败"那条优先于"返回空结果"。',
        reason: '两条验收标准冲突时，"显式失败"是更严的一条，取严。',
        constraints_added: ['参数为 0 视为非法输入，必须报错'],
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectOk(rec, '正例① 需求分析直接裁定（answered）', reply, ['需求分析直接答复', '参数为 0 视为非法输入'])

    st = fx.h.store.peek(fx.taskId)
    rec.add('正例① 裁定后**回到被打断前的状态**',
      st.state === before && st.clarification_requests[0]?.resumed_to === before,
      `state=${st.state}  resumed_from=${st.clarification_requests[0]?.resumed_from} → resumed_to=${st.clarification_requests[0]?.resumed_to}`)

    rec.add('正例① ★ 全程**没有**再多惊动一次用户（第一级能答就自己答了）',
      (st.human_requests ?? []).length === H0,
      `human_requests 条数 = ${(st.human_requests ?? []).length}（夹具基线 ${H0}，即开工前那次需求确认）\n` +
        `新增的：${JSON.stringify((st.human_requests ?? []).slice(H0))}`)

    const actions = (await fx.h.store.auditLog(fx.taskId)).map((a) => a.action)
    const humanAfter = (st.human_requests ?? []).slice(H0)
    rec.add('正例① 留痕：①提问 ②裁定 ③恢复 三步齐全，且这一级**没有**产生新的人工介入',
      ['clarify:request', 'clarify:reply', 'clarify:resume'].every((a) => actions.includes(a)) && humanAfter.length === 0,
      `clarify:* = ${actions.filter((a) => a.startsWith('clarify:')).join(', ')}\n` +
        `夹具的 human:*（开工前需求确认，正常）= ${actions.filter((a) => a.startsWith('human:')).join(', ') || '（无）'}\n` +
        `本次之后新增的 human_requests = ${humanAfter.length} 条`)

    // 发起角色能继续干活
    const cont = await callTool(
      fx.h, 'pipeline_handoff',
      {
        task_id: fx.taskId, kind: 'dev_to_test', role_token: fx.tokens['writer#1'],
        payload: {
          task_id: fx.taskId, artifact_version: 'v1', patch_or_code: 'x', change_note: '按裁定改了参数校验',
          run_commands: ['node t.mjs'], selftest_result: 'pass', known_issues: [],
          ...manifestFor(fx.h.store, fx.taskId),
        },
      },
      fx.agents['writer#1'],
    )
    expectOk(rec, '正例① 闭环：裁定后发起角色能接着把活干完（编写交测试）', cont, ['编写交付给测试'])
  }

  // =========================================================================
  // 正例②：需求分析答不了 → 升级 → 转告 → 用户答复 → 恢复
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    const before = fx.h.store.peek(fx.taskId).state

    const asked = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...ask(), role_token: fx.tokens.tester }, fx.agents.tester)
    const rid = asked.value?.request_id ?? ''
    expectOk(rec, '正例② 测试角色向上提问（第一级）', asked, ['澄清请求已登记'])

    // --- ② 需求分析：答不了 ------------------------------------------------
    const declined = await callTool(
      fx.h, 'pipeline_clarify_reply',
      {
        task_id: fx.taskId, request_id: rid, verdict: 'cannot_answer',
        reason: '这属于**新需求**：原任务卡只要求"过滤",没规定非法输入的语义。加错误分支会改变对外契约，超出我的裁定范围。',
        escalate: true,
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectOk(rec, '正例② 需求分析给出"答不了"+理由（并声明要升级）', declined, ['需求分析答不了', '新需求', '升级'])

    let st = fx.h.store.peek(fx.taskId)
    rec.add('正例② 裁定"答不了"之后状态先恢复（回到被打断前）',
      st.state === before && st.clarification_requests[0]?.verdict === 'cannot_answer',
      `state=${st.state}  verdict=${st.clarification_requests[0]?.verdict}  resumed_to=${st.clarification_requests[0]?.resumed_to}`)

    // --- ③ 升级 ------------------------------------------------------------
    const escalated = await callTool(
      fx.h, 'pipeline_human_request',
      {
        task_id: fx.taskId,
        reason_kind: 'scope_change',
        question_for_human: '参数为 0 时应当报错还是返回空结果？原需求没写这一条，两种做法会做出不一样的东西。',
        context_for_human: '同一份验收标准两种读法都成立；选"报错"要动一处调用方。',
        options: [
          { label: '报错', consequence: '调用方必须自己先判空，语义更严但要改一处调用' },
          { label: '返回空', consequence: '调用方不用改，但错误会被静默吞掉' },
        ],
        blocking: true, blocked_stage: '测试：边界值判定', urgency: 'normal',
        decision_kind: 'choose_option', timeout_behavior: 'stay_blocked',
        escalated_from: st.clarification_requests[0].handoff_id,
        raised_by: 'tester',
        orchestrator_reason: '这属于新需求，超出我的裁定范围，必须由用户定对外契约。',
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectOk(rec, '正例② 需求分析把问题升级给用户（带 escalated_from / raised_by / orchestrator_reason）', escalated, ['人工介入请求', '等待人工答复'])

    st = fx.h.store.peek(fx.taskId)
    rec.add('正例② ★ 升级后状态是「等待人工答复」，且**恢复目标仍是最初的工作状态**（不是 awaiting_clarification）',
      st.state === 'awaiting_human' && st.previous_state === before &&
        st.human_requests.at(-1)?.state_at_request === before,
      `state=${st.state}\nprevious_state=${st.previous_state}  （应为 ${before}，**不是** awaiting_clarification）\nhuman_requests[0].state_at_request=${st.human_requests.at(-1)?.state_at_request}`)

    const up = st.clarification_requests[0]
    rec.add('正例② 单向门：上游澄清请求被标记为 escalated，不能再被需求分析改口',
      up.status === 'escalated' && up.escalated_to === st.human_requests.at(-1)?.request_id,
      `status=${up.status}  escalated_at=${up.escalated_at}  escalated_to=${up.escalated_to}`)

    // --- ④⑤ 转告 + 用户答复 -------------------------------------------------
    const hid = st.human_requests.at(-1).request_id
    const relayed = await callTool(
      fx.h, 'pipeline_human_relay',
      {
        task_id: fx.taskId, request_id: hid, role_token: fx.tokens.main,
      },
      fx.agents.main,
    )
    expectOk(rec, '正例② 主对话转告用户（转告文案里带得出"这事原本是谁问的"）', relayed, ['照抄这段', '确认码'])

    const answered = await callTool(
      fx.h, 'pipeline_human_reply',
      {
        task_id: fx.taskId, request_id: hid,
        user_quote: '报错吧，这种参数本来就不该传进来。',
        reply_channel: 'chat', attribution: '用户在当前会话里直接回复',
        chosen_option: '报错',
        role_token: fx.tokens.main,
      },
      fx.agents.main,
    )
    expectOk(rec, '正例② 记下用户答复并恢复', answered, ['已记录答复并推进'])

    st = fx.h.store.peek(fx.taskId)
    rec.add('正例② ★ 用户答复后回到**最初被打断的工作状态**（不是 awaiting_clarification）',
      st.state === before && st.human_requests.at(-1)?.resumed_to === before,
      `state=${st.state}  resumed_from=${st.human_requests.at(-1)?.resumed_from} → resumed_to=${st.human_requests.at(-1)?.resumed_to}`)

    // --- 留痕：五跳齐全 -----------------------------------------------------
    const log = await fx.h.store.auditLog(fx.taskId)
    const acts = log.map((a) => a.action)
    const need = ['clarify:request', 'clarify:reply', 'clarify:escalate', 'human:relay', 'human:reply', 'human:resume']
    rec.add('正例② 留痕：提问 → 裁定 → 升级 → 转告 → 答复 → 恢复，六条都在 audit.jsonl 里',
      need.every((a) => acts.includes(a)),
      `缺失：${need.filter((a) => !acts.includes(a)).join(', ') || '（无）'}\n完整链路：${acts.filter((a) => /^(clarify|human):/.test(a)).join(' → ')}`)

    const esc = log.find((a) => a.action === 'clarify:escalate')
    rec.add('正例② 留痕：升级那一步能一眼看出"这事原本是谁问的、需求分析为什么答不了"',
      esc?.raised_by === 'tester' && typeof esc?.orchestrator_reason === 'string' && esc.orchestrator_reason.includes('新需求'),
      `clarify:escalate 审计行：\n${indent(JSON.stringify(esc, null, 2))}`)

    // ★ 取**最后一条** human:reply：夹具自己在开工前走过一次需求确认，
    //   那一条也是 human:reply（正常动作），不能拿它来验这一级。
    const rep = log.filter((a) => a.action === 'human:reply').at(-1)
    rec.add('正例② 留痕：最后谁拍板 —— human:reply 里有用户原话与归属',
      typeof rep?.user_quote === 'string' && rep.user_quote.includes('报错吧') && typeof rep?.attribution === 'string',
      `human:reply 审计行：\n${indent(JSON.stringify(rep, null, 2))}`)
  }

  // =========================================================================
  // 反例①：跳过需求分析，直接发 human_request
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    const skip = await callTool(
      fx.h, 'pipeline_human_request',
      {
        task_id: fx.taskId,
        reason_kind: 'conclusion_conflict',
        question_for_human: '参数为 0 时应当报错还是返回空结果？两种读法都说得通。',
        blocking: true, blocked_stage: '测试：边界值', urgency: 'normal',
        decision_kind: 'choose_option', timeout_behavior: 'stay_blocked',
        options: [{ label: '报错', consequence: '要改调用方' }, { label: '返回空', consequence: '静默吞错' }],
        role_token: fx.tokens.tester,
      },
      fx.agents.tester,
    )
    expectDenied(rec, '反例① 执行角色跳过需求分析，直接向用户发起人工介入', skip,
      ['MUST_ASK_ORCHESTRATOR_FIRST|跳级', '不能直接向用户发起人工介入', 'pipeline_clarify_request', '它确实答不了时'])

    const st = fx.h.store.peek(fx.taskId)
    rec.add('反例① 没有创建出任何 human_request，状态也没动',
      (st.human_requests ?? []).length === H0 && st.state === 'developing',
      `human_requests=${(st.human_requests ?? []).length}（基线 ）  state=${st.state}`)
  }

  // =========================================================================
  // 反例②：★ L0 例外 —— 没有独立编排对话时，直接发 human_request 是**合法**的
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 }) // L0 → 规则引擎
    open.push(g.h)
    const roster = g.h.store.peek(g.taskId)?.roster
    rec.add('反例② 夹具：这是一个 L0 任务，编排由规则引擎承担（没有独立编排对话）',
      roster?.tier === 'L0' && roster?.orchestrator_mode === 'rule-engine',
      `tier=${roster?.tier}  orchestrator_mode=${roster?.orchestrator_mode}`)

    const direct = await callTool(
      g.h, 'pipeline_human_request',
      {
        task_id: g.taskId,
        reason_kind: 'conclusion_conflict',
        question_for_human: '参数为 0 时应当报错还是返回空结果？两种读法都说得通，需要你定一下。',
        blocking: true, blocked_stage: '测试：边界值', urgency: 'normal',
        decision_kind: 'choose_option', timeout_behavior: 'stay_blocked',
        options: [{ label: '报错', consequence: '要改调用方' }, { label: '返回空', consequence: '静默吞错' }],
        role_token: g.tokens.tester,
      },
      g.agents.tester,
    )
    expectOk(rec, '反例② ★ L0 例外生效：没有独立编排对话时，直接发 human_request 被**放行**', direct, ['人工介入请求', '等待人工答复'])

    const st = g.h.store.peek(g.taskId)
    rec.add('反例② L0 下确实推进到了「等待人工答复」',
      st.state === 'awaiting_human', `state=${st.state}`)
  }

  // =========================================================================
  // 反例③：需求分析把可自行裁定的问题推给用户
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    const asked = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...ask(), role_token: fx.tokens.tester }, fx.agents.tester)
    const rid = asked.value?.request_id ?? ''

    // (a) 答不了却不说为什么 → 拒
    const noReason = await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid, verdict: 'cannot_answer', escalate: true, reason: '   ', role_token: fx.tokens.orchestrator },
      fx.agents.orchestrator,
    )
    expectDenied(rec, '反例③a 需求分析说"答不了"却不给理由', noReason,
      ['MISSING_REASON|必须给 reason', '防踢皮球', '这个我不太懂|非法的理由'])

    // (b) 答得了，却去升级 → 拒（没有 cannot_answer 的裁定就不许升级）
    const answered = await callTool(
      fx.h, 'pipeline_clarify_reply',
      {
        task_id: fx.taskId, request_id: rid, verdict: 'answered',
        answer: '按"报错"处理，验收标准里显式失败那条优先。',
        reason: '两条验收标准冲突时取严的那条。',
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectOk(rec, '反例③b 前提：需求分析本来答得了（已给 answered 裁定）', answered, ['需求分析直接答复'])

    const pushToUser = await callTool(
      fx.h, 'pipeline_human_request',
      {
        task_id: fx.taskId,
        reason_kind: 'requirement_ambiguous',
        question_for_human: '参数为 0 时应当报错还是返回空结果？',
        blocking: true, blocked_stage: '测试', urgency: 'normal',
        decision_kind: 'choose_option', timeout_behavior: 'stay_blocked',
        options: [{ label: '报错', consequence: 'x' }, { label: '返回空', consequence: 'y' }],
        escalated_from: fx.h.store.peek(fx.taskId).clarification_requests[0].handoff_id,
        raised_by: 'tester',
        orchestrator_reason: '让用户决定吧。',
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectDenied(rec, '反例③c 需求分析把**自己刚答过**的问题又推给用户', pushToUser,
      ['不是"需求分析答不了"', '只能升级**自己确实答不了**的问题', '踢皮球'])

    const st = fx.h.store.peek(fx.taskId)
    rec.add('反例③ 两次尝试之后仍然没有惊动用户',
      (st.human_requests ?? []).length === H0,
      `human_requests=${(st.human_requests ?? []).length}（基线 ）`)

    // (d) 升级来源指向不存在的请求 → 拒
    const ghost = await callTool(
      fx.h, 'pipeline_human_request',
      {
        task_id: fx.taskId, reason_kind: 'scope_change',
        question_for_human: '这个边界要不要管？',
        blocking: true, blocked_stage: 'x', urgency: 'normal',
        decision_kind: 'yes_no', timeout_behavior: 'stay_blocked',
        escalated_from: 'H-不存在的编号', raised_by: 'tester', orchestrator_reason: '说不清',
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectDenied(rec, '反例③d 升级来源指向一条不存在的澄清请求', ghost,
      ['ESCALATION_SOURCE_NOT_FOUND|指不到任何', '真实存在'])
  }

  // =========================================================================
  // 反例④：同一问题在两级之间反复往返（防踢皮球）
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    const q = ask()

    // 第 1 次
    const a1 = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...q, role_token: fx.tokens.tester }, fx.agents.tester)
    expectOk(rec, '反例④ 第 1 次问同一个问题 —— 放行', a1, ['澄清请求已登记'])
    const rid1 = a1.value?.request_id ?? ''
    await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid1, verdict: 'answered', answer: '按"报错"。', reason: '验收标准取严。', role_token: fx.tokens.orchestrator },
      fx.agents.orchestrator,
    )

    // 第 2 次（允许：答了还不明白可以再确认一次）
    const a2 = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...q, role_token: fx.tokens.tester }, fx.agents.tester)
    expectOk(rec, '反例④ 第 2 次问同一问题 —— 仍放行（允许"答了还是不明白再确认一次"）', a2, ['澄清请求已登记', '第 2 次|2/'])
    const rid2 = a2.value?.request_id ?? ''
    const r2 = await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid2, verdict: 'answered', answer: '还是按"报错"。', reason: '同上。', role_token: fx.tokens.orchestrator },
      fx.agents.orchestrator,
    )
    expectOk(rec, '反例④ 第 2 次也得到了裁定', r2, ['需求分析直接答复'])

    // 第 3 次 → 拒
    const a3 = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...q, role_token: fx.tokens.tester }, fx.agents.tester)
    expectDenied(rec, '反例④ 第 3 次问**同一个**问题 → 拒（防踢皮球）', a3,
      ['CLARIFICATION_PINGPONG|防踢皮球', '已经问过', '原地打转', 'pipeline_human_request'])

    // 换一个问法 → 是新问题，放行
    const a4 = await callTool(
      fx.h, 'pipeline_clarify_request',
      { task_id: fx.taskId, ...ask({ question: '那负数呢？负数按 0 一样处理吗？' }), role_token: fx.tokens.tester },
      fx.agents.tester,
    )
    expectOk(rec, '反例④ 对照：换个问题（问负数）—— 是新问题，放行（闸不是按角色封的）', a4, ['澄清请求已登记'])
  }

  // =========================================================================
  // 反例⑤：单向门 / 越权 / 形态
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    // ★ 本轮起：夹具自己会走一次**需求确认**（需求分析 → 用户确认 → 计划），
    //   所以「没惊动用户」这类断言必须以**夹具基线**为准，不能钉死成 0。
    const H0 = fixtureHumanBase(fx)
    open.push(fx.h)
    const asked = await callTool(fx.h, 'pipeline_clarify_request', { task_id: fx.taskId, ...ask(), role_token: fx.tokens.tester }, fx.agents.tester)
    const rid = asked.value?.request_id ?? ''

    // 越权：非需求分析来裁定
    const wrongRole = await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid, verdict: 'answered', answer: '我说了算。', reason: '我是测试。', role_token: fx.tokens.tester },
      fx.agents.tester,
    )
    expectDenied(rec, '反例⑤a 非需求分析角色想自己出裁定', wrongRole, ['角色越权', '允许角色：orchestrator'])

    // 含代码的脱敏摘要
    const dirty = await callTool(
      fx.h, 'pipeline_clarify_request',
      { task_id: fx.taskId, ...ask({ context_digest: 'diff --git a/src/x.js b/src/x.js\n@@ -1 +1 @@' }), role_token: fx.tokens.writer },
      fx.agents['writer#1'],
    )
    expectDenied(rec, '反例⑤b 脱敏摘要里塞了 diff（需求分析要靠它不读代码就判断）', dirty, ['混进了代码', '脱敏摘要'])

    // 单向门
    await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid, verdict: 'cannot_answer', reason: '这属于新需求，超出裁定范围。', escalate: true, role_token: fx.tokens.orchestrator },
      fx.agents.orchestrator,
    )
    const up = fx.h.store.peek(fx.taskId).clarification_requests[0].handoff_id
    const esc = await callTool(
      fx.h, 'pipeline_human_request',
      {
        task_id: fx.taskId, reason_kind: 'scope_change',
        question_for_human: '这个边界要不要按报错处理？原需求没写。',
        blocking: true, blocked_stage: '测试', urgency: 'normal',
        decision_kind: 'yes_no', timeout_behavior: 'stay_blocked',
        escalated_from: up, raised_by: 'tester', orchestrator_reason: '属于新需求。',
        role_token: fx.tokens.orchestrator,
      },
      fx.agents.orchestrator,
    )
    expectOk(rec, '反例⑤c 前提：升级成功', esc, ['等待人工答复'])

    const reAnswer = await callTool(
      fx.h, 'pipeline_clarify_reply',
      { task_id: fx.taskId, request_id: rid, verdict: 'answered', answer: '我又想通了，按报错。', reason: '改主意。', role_token: fx.tokens.orchestrator },
      fx.agents.orchestrator,
    )
    expectDenied(rec, '反例⑤d ★ 单向门：升级之后需求分析不能再改口裁定', reAnswer,
      ['ALREADY_ESCALATED|已经**升级**给人工', '单向门', '只剩用户答复这一条出路'])
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('正例①')) return '正例① 需求分析直接裁定（全程没惊动用户）'
    if (name.startsWith('正例②')) return '正例② 答不了 → 升级 → 转告 → 用户答复 → 恢复'
    if (name.startsWith('反例①')) return '反例① 跳过需求分析直接发 human_request'
    if (name.startsWith('反例②')) return '反例② ★ L0 例外：没有独立编排对话时直接发是合法的'
    if (name.startsWith('反例③')) return '反例③ 需求分析把可自行裁定的问题推给用户'
    if (name.startsWith('反例④')) return '反例④ 同一问题两级反复往返（防踢皮球）'
    if (name.startsWith('反例⑤')) return '反例⑤ 单向门 / 越权 / 形态'
    return '其它'
  }
  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 两级升级梯自测（角色 → 需求分析 → 用户）')
  lines.push('='.repeat(78))
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      for (const l of String(it.detail).split('\n')) lines.push(`    ${l}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  for (const hh of open) await hh.store.dropCache()
  for (const hh of open) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(hh.projectRoot, { recursive: true, force: true })
    } catch { /* 清不掉不影响结论 */ }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /ladder-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runLadderCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
