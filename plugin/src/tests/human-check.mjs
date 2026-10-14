/**
 * dsh-pipeline · 人工介入链路自测（拓扑约束：用户只与主对话相连）
 * ============================================================================
 *     node tests/human-check.mjs
 *
 * 验的是一条**硬约束**：执行/顾问角色**没有用户的对话框**，所以任何要人拍板的事
 * 只能走「角色发起 → 主对话转告 → 用户答复 → 主对话记回来 → 恢复」。
 *
 * 四步都要留痕，四类越权都要被拒。全程零副作用（临时目录 + 假会话）。
 *
 * @module dsh-pipeline/tests/human-check
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createGuardFixture, callTool } from './selftest-core.mjs'

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

/** 片段里带 `|` 表示任一即可。 */
function hit(text, fragment) {
  return String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))
}

function expectDenied(rec, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
      : `期望被拒但结果是 denied=${res.denied} layer=${res.layer}` +
        (missing.length > 0 ? `\n拒绝原文缺少关键片段：${missing.join(' ｜ ')}` : '') +
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
      : `期望成功但被拒了（layer=${res.layer}）${missing.length > 0 ? `，或缺少关键片段：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

/**
 * **绕过守门**直接调 execute —— 用来验第二道闸。
 *
 * 有意义的理由：同一个越权在守门层与 execute 层各有一份判据（纵深防御）。
 * `callTool` 会先跑守门，所以它只验到了第一层；把守门摘掉再调一次，
 * 才能确认**即使守门因为某种原因没拦住，execute 自己也会拒**。
 */
async function callToolRaw(h, toolName, args, agentId) {
  const exec = {
    name: toolName,
    arguments: args ?? {},
    ...(agentId === undefined || agentId === null ? {} : { agent: { id: agentId } }),
  }
  const def = h.byName.get(toolName)
  if (def === undefined) return { denied: true, layer: 'missing', text: `工具 ${toolName} 未注册` }
  const out = await def.execute(exec.arguments, exec)
  const ok = out !== null && typeof out === 'object' && out.ok === true
  return { denied: !ok, layer: ok ? 'passed' : 'execute', text: String(out?.summary ?? JSON.stringify(out)), value: out }
}

// ---------------------------------------------------------------------------
// 构造一个"测试中"的任务（tester 正在干活，最有理由向上提问）
// ---------------------------------------------------------------------------

/** 一份合法的选择题请求体（tester：编写与测试结论冲突）。 */
function makeRequest(over = {}) {
  return {
    reason_kind: 'conclusion_conflict',
    question_for_human:
      '测试跑出来步长过滤在 step 为 0 时会返回全部结果，但编写认为这是预期行为。' +
      '这两种理解会做出不一样的东西，需要你定一下：到底该按哪种？',
    context_for_human: '同一份验收标准，两种读法都说得通，测试与编写各自有理由，角色之间定不了。',
    options: [
      { label: '按编写的理解：step=0 返回全部', consequence: '测试要改期望值，用例重跑一遍即可，改动最小' },
      { label: '按测试的理解：step=0 应当报错', consequence: '编写要改实现并补一个错误分支，工作量稍大但语义更严' },
    ],
    recommended: '按测试的理解：step=0 应当报错',
    blocking: true,
    blocked_stage: '测试用例设计（边界值定不下来）',
    urgency: 'normal',
    decision_kind: 'choose_option',
    timeout_behavior: 'stay_blocked',
    ...over,
  }
}

export async function runHumanCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例：四步走通
  // =========================================================================
  const f = await createGuardFixture({ stopAfter: 5 }) // 停在 testing
  open.push(f.h)
  const h = f.h

  rec.add('夹具就绪：任务停在「测试中」，三个角色都已被派出',
    f.state === 'testing', `taskId=${f.taskId} state=${f.state} agents=${JSON.stringify(f.agents)}`)

  // --- ① 发起 -------------------------------------------------------------
  const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
  expectOk(rec, '①发起：tester 向上发起人工介入请求（阻塞）', raised, ['请求已登记', '等待人工答复'])
  const requestId = raised.value?.request_id ?? ''
  const task1 = await h.store.get(f.taskId)
  rec.add('①发起：任务进入「等待人工答复」，并记下被打断前的状态',
    task1.state === 'awaiting_human' && task1.human_requests[0]?.state_at_request === 'testing',
    `state=${task1.state}  state_at_request=${task1.human_requests[0]?.state_at_request}  status=${task1.human_requests[0]?.status}`)

  // --- ② 转告 -------------------------------------------------------------
  const inbox = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
  expectOk(rec, '②转告：主对话先看收件箱（不带 request_id）', inbox, ['人工介入请求', '待转告'])
  const relayed = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: requestId, role_token: f.tokens.main }, f.agents.main)
  expectOk(rec, '②转告：把请求转告给用户（含"照抄给用户看"的原文块）', relayed, ['照抄这段', '确认码', '不要替用户选'])
  const task2 = await h.store.get(f.taskId)
  rec.add('②转告：状态**没有**被转告动作改变（它早在发起时就推了）',
    task2.state === 'awaiting_human' && task2.human_requests[0]?.status === 'relayed' && typeof task2.human_requests[0]?.relayed_at === 'string',
    `state=${task2.state} status=${task2.human_requests[0]?.status} relayed_at=${task2.human_requests[0]?.relayed_at}`)

  // --- ③④ 记答复 + 恢复 ----------------------------------------------------
  const replied = await callTool(h, 'pipeline_human_reply', {
    task_id: f.taskId,
    request_id: requestId,
    user_quote: '就按测试那个来吧，step 是 0 应该报错。别的先不用动。',
    reply_channel: 'chat',
    attribution: '用户在当前会话里直接回复',
    chosen_option: '按测试的理解：step=0 应当报错',
    role_token: f.tokens.main,
  }, f.agents.main)
  expectOk(rec, '③记答复 + ④恢复：一句话完成两步', replied, ['已记录答复并推进', '测试中'])
  const task3 = await h.store.get(f.taskId)
  rec.add('④恢复：状态**回到被打断前的那个状态**（测试中）',
    task3.state === 'testing' && task3.human_requests[0]?.resumed_to === 'testing' && task3.human_requests[0]?.resumed_from === 'awaiting_human',
    `state=${task3.state}  resumed_from=${task3.human_requests[0]?.resumed_from} → resumed_to=${task3.human_requests[0]?.resumed_to}`)

  // --- 四步留痕 -----------------------------------------------------------
  const audit = await h.store.auditLog(f.taskId)
  const actions = audit.map((a) => a.action)
  const need = ['human:request', 'human:relay', 'human:reply', 'human:resume']
  rec.add('留痕：audit.jsonl 四步齐全',
    need.every((a) => actions.includes(a)),
    `缺失：${need.filter((a) => !actions.includes(a)).join(', ') || '（无）'}\n实际 human:* 动作：${actions.filter((a) => a.startsWith('human:')).join(', ')}`)

  const replyLine = audit.find((a) => a.action === 'human:reply')
  rec.add('留痕：答复里能看到"用户说了什么"（原话 + 归属）',
    typeof replyLine?.user_quote === 'string' && replyLine.user_quote.includes('step 是 0 应该报错') && typeof replyLine?.attribution === 'string',
    `human:reply 审计行：\n${indent(JSON.stringify(replyLine, null, 2))}`)

  const resumeLine = audit.find((a) => a.action === 'human:resume')
  rec.add('留痕：恢复里能看到"依据哪条答复恢复"',
    typeof resumeLine?.based_on === 'string' && resumeLine.based_on.includes('用户原话') && resumeLine.to === 'testing',
    `human:resume 审计行：\n${indent(JSON.stringify(resumeLine, null, 2))}`)

  const handoffDir = join(h.projectRoot, '.pipeline', f.taskId, 'handoffs')
  let files = []
  try { files = await readdir(handoffDir) } catch { files = [] }
  const reqFile = files.find((n) => n.includes('human_request'))
  let original = null
  if (reqFile !== undefined) {
    original = JSON.parse(await readFile(join(handoffDir, reqFile), 'utf8'))
  }
  rec.add('留痕：请求**原件**也落盘（handoffs/NNN-human_request.json，不可变）',
    original !== null && original.kind === 'human_request' && original.from_role === 'tester' && original.to_role === 'main',
    `文件：${files.join(', ')}\n原件：from_role=${original?.from_role} to_role=${original?.to_role} handoff_id=${original?.handoff_id}`)

  // --- 角色可以继续干活 ---------------------------------------------------
  const cont = await callTool(h, 'pipeline_handoff', {
    task_id: f.taskId, kind: 'test_to_review', role_token: f.tokens.tester,
    payload: {
      task_id: f.taskId, artifact_version: f.version,
      test_cases: ['按用户裁定：step=0 应当报错'], execution_result: '1/1 通过',
      failure_logs: [], pass_evidence: ['按裁定改完用例后重跑通过'], risk_notes: [], verdict: 'pass',
    },
  }, f.agents.tester)
  expectOk(rec, '闭环：恢复后发起角色能接着把活干完（测试交审核）', cont, ['测试报告交审核'])

  // =========================================================================
  // 反例 ①：主对话伪造用户答复（无来源依据）
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const raised2 = await callTool(g.h, 'pipeline_human_request', { task_id: g.taskId, ...makeRequest(), role_token: g.tokens.tester }, g.agents.tester)
    const rid = raised2.value?.request_id ?? ''

    // (a) 还没转告就想记答复
    const beforeRelay = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '用户说可以', attribution: '用户',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '①伪造①a 还没转告就记答复（跳过转告）', beforeRelay, ['还没有转告给用户', '不可能有用户答复', '先调 pipeline_human_relay'])

    // 先正常转告，再试各种伪造
    await callTool(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.main }, g.agents.main)

    // (b) 不给用户原话
    const noQuote = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, attribution: '用户在当前会话里回复',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '①伪造①b 答复不带用户原话（user_quote 缺失）', noQuote, ['缺 user_quote', '用户本人的原话'])

    // (c) 原话太短
    const shortQuote = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '可以', attribution: '用户',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '①伪造①c 原话短到不构成可核对的凭据', shortQuote, ['太短'])

    // (d) 把问题原样抄回来当答复
    const echo = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: makeRequest().question_for_human, attribution: '用户',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '①伪造①d 把问题原文抄回来当答复（回声）', echo, ['一字不差', '不像用户说的话'])

    // (e) 不给归属
    const noAttr = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '就按测试那个来', attribution: '',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '①伪造①e 答复没有归属（谁在哪说的）', noAttr, ['缺 attribution', '可归属'])

    // 状态始终没动
    const st = await g.h.store.get(g.taskId)
    rec.add('①伪造：以上五次尝试之后，任务仍停在「等待人工答复」',
      st.state === 'awaiting_human' && st.human_requests[0]?.status === 'relayed',
      `state=${st.state} status=${st.human_requests[0]?.status} answered_at=${st.human_requests[0]?.answered_at}`)
  }

  // =========================================================================
  // 反例 ②：主对话替用户拍板
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const raised2 = await callTool(g.h, 'pipeline_human_request', { task_id: g.taskId, ...makeRequest(), role_token: g.tokens.tester }, g.agents.tester)
    const rid = raised2.value?.request_id ?? ''
    await callTool(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.main }, g.agents.main)

    // (a) 主对话直接推状态（不经答复记录）
    const direct = await callTool(g.h, 'pipeline_transition', { task_id: g.taskId, event: 'human_reply', role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '②拍板②a 主对话直接推 human_reply（没有答复记录）', direct, ['还没有记录用户答复', '不能自行把请求标记为已解决'])

    // (b) 答复形状不对：选择题却给了布尔
    const wrongShape = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '我觉得可以放行', attribution: '用户',
      answer: true, role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '②拍板②b 请求问的是"选哪个"，主对话回了个布尔（形状对不上）', wrongShape, ['choose_option', '必须给 chosen_option'])

    // (c) 选了一个不存在的选项
    const notAnOption = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '用户说全都要', attribution: '用户',
      chosen_option: '两个都按', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '②拍板②c 选了一个不在选项里的答案', notAnOption, ['不在给用户的选项里', '选项之外的东西'])

    // (d) 用超时路径绕过（但请求声明的是 stay_blocked）
    const viaTimeout = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, answer_source: 'timeout', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '②拍板②d 用 answer_source=timeout 绕过用户答复（策略是 stay_blocked）', viaTimeout, ['stay_blocked', '不能按超时放行'])

    const st = await g.h.store.get(g.taskId)
    rec.add('②拍板：任务仍停在「等待人工答复」，没有被主对话自行放行', st.state === 'awaiting_human', `state=${st.state}`)
  }

  // =========================================================================
  // 反例 ③：角色越权（非 main 想把请求标记为已解决 / 推状态）
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const raised2 = await callTool(g.h, 'pipeline_human_request', { task_id: g.taskId, ...makeRequest(), role_token: g.tokens.tester }, g.agents.tester)
    const rid = raised2.value?.request_id ?? ''

    const wRelay = await callTool(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.writer }, g.agents.writer)
    expectDenied(rec, '③越权③a 编写角色想自己把请求转告/标记（守门层）', wRelay, ['角色越权', '允许角色：main'])

    const tReply = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '用户说行', attribution: '用户',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '③越权③b 测试角色想自己记"用户答复"（守门层）', tReply, ['角色越权', '允许角色：main'])

    // 纵深防御：把守门摘掉，直接打 execute —— 第二道闸也要拒
    const rawRelay = await callToolRaw(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.writer }, g.agents.writer)
    expectDenied(rec, '③越权③a′ 绕过守门直接打 execute：转告仍然被拒（第二道闸）', rawRelay, ['只有主对话能把人工介入请求转告', '对话框只在主对话里'])

    const rawReply = await callToolRaw(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '用户说行', attribution: '用户',
      chosen_option: '按测试的理解：step=0 应当报错', role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '③越权③b′ 绕过守门直接打 execute：记答复仍然被拒（第二道闸）', rawReply, ['只有主对话能记录用户的答复', '无源之言'])

    // 反向：绕过守门直接打 execute，main 发起请求也被拒
    const rawRaise = await callToolRaw(g.h, 'pipeline_human_request', { task_id: g.taskId, ...makeRequest(), role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '③越权③d′ 绕过守门直接打 execute：主对话发起也被拒（第二道闸）', rawRaise, ['主对话不发起人工介入请求', '就在用户的对话框里'])

    const tTransition = await callTool(g.h, 'pipeline_transition', { task_id: g.taskId, event: 'human_reply', role_token: g.tokens.tester }, g.agents.tester)
    expectDenied(rec, '③越权③c 测试角色想直接推 human_reply 恢复状态', tTransition, ['角色越权'])

    // 反向：main 不能发起（它就在用户的对话框里）
    const mainRaise = await callTool(g.h, 'pipeline_human_request', { task_id: g.taskId, ...makeRequest(), role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '③越权③d 主对话发起人工介入请求（反向越权）', mainRaise, ['主对话不能发起人工介入请求', '就在主对话里'])

    // 反向：main 不能通过 pipeline_handoff 产出 human_request
    const mainHandoff = await callTool(g.h, 'pipeline_handoff', {
      task_id: g.taskId, kind: 'human_request', role_token: g.tokens.main,
      payload: { ...makeRequest(), task_id: g.taskId, from_role: 'main' },
    }, g.agents.main)
    expectDenied(rec, '③越权③e 主对话用 handoff 通道产出 human_request', mainHandoff, ['角色越权', '主对话不产出人工介入请求'])

    const st = await g.h.store.get(g.taskId)
    rec.add('③越权：以上五次尝试之后，请求仍未被解决', st.state === 'awaiting_human' && st.human_requests[0]?.status === 'pending',
      `state=${st.state} status=${st.human_requests[0]?.status}`)
  }

  // =========================================================================
  // 反例 ④：请求体让用户看代码
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)

    const missing = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      reason_kind: 'approval_needed', blocking: true, blocked_stage: '上线前',
      urgency: 'high', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked',
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '④看代码④a 缺 question_for_human（用户不知道要回答什么）', missing, ['question_for_human', '缺少必填字段'])

    const withCode = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({
        question_for_human:
          '这段改动可以放行吗？\n\ndiff --git a/src/fizzbuzz.js b/src/fizzbuzz.js\n@@ -1,3 +1,4 @@\n+  if (step === 0) throw new Error("bad step")\n',
      }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '④看代码④b question_for_human 里塞了 diff（主对话不读代码，转告不了）', withCode, ['混进了代码', 'diff 头', '给用户看的人话'])

    const withPath = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({ question_for_human: 'src/fizzbuzz.js 里那个分支要不要保留？我拿不准。' }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '④看代码④c question_for_human 里出现代码文件路径', withPath, ['混进了代码', '代码扩展名'])

    const notAQuestion = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({ question_for_human: '这里需要你定夺一下，我们两种理解都说得通。' }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '④看代码④d 不是在问问题（没有问号，用户不知道要回答什么）', notAQuestion, ['没有问号', '明确的问句'])

    const tooLong = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({ question_for_human: `这个要不要放行？${'补充说明。'.repeat(200)}` }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectDenied(rec, '④看代码④e 问题长到不像给人看的', tooLong, ['超过', '上限', '一眼读完'])

    const st = await g.h.store.get(g.taskId)
    rec.add('④看代码：五次尝试都没有创建出请求', st.human_requests.length === 0 && st.state === 'testing',
      `human_requests=${st.human_requests.length} state=${st.state}`)
  }

  // =========================================================================
  // 补充：非阻塞请求 / 重复答复 / 无截止的超时 / 确认码
  // =========================================================================
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const raised2 = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({ blocking: false, reason_kind: 'scope_change', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked', options: undefined, recommended: undefined, blocked_stage: undefined }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    expectOk(rec, '补充：非阻塞请求也能提交（不打断流程）', raised2, ['非阻塞'])
    const st = await g.h.store.get(g.taskId)
    rec.add('补充：非阻塞请求**不改变任务状态**',
      st.state === 'testing' && st.human_requests[0]?.blocking === false && st.human_requests[0]?.state_at_request === 'testing',
      `state=${st.state} blocking=${st.human_requests[0]?.blocking} state_at_request=${st.human_requests[0]?.state_at_request}`)

    const rid = raised2.value?.request_id ?? ''
    await callTool(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.main }, g.agents.main)
    const ok1 = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '这个先不做，按原范围来。', attribution: '用户在当前会话里回复',
      answer: false, role_token: g.tokens.main,
    }, g.agents.main)
    expectOk(rec, '补充：非阻塞请求的答复正常记录（状态不变）', ok1, ['已记录答复'])
    const again = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, user_quote: '我又想了想，还是做吧。', attribution: '用户', answer: true, role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '补充：同一条请求不能重复答复', again, ['已经答复过了'])
  }
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const raised2 = await callTool(g.h, 'pipeline_human_request', {
      task_id: g.taskId,
      ...makeRequest({ timeout_behavior: 'proceed_with_default', default_option: '按编写的理解：step=0 返回全部' }),
      role_token: g.tokens.tester,
    }, g.agents.tester)
    const rid = raised2.value?.request_id ?? ''
    await callTool(g.h, 'pipeline_human_relay', { task_id: g.taskId, request_id: rid, role_token: g.tokens.main }, g.agents.main)
    // 默认配置 humanRequestTimeoutHours=0 且请求没给 timeout_at ⇒ 不存在"超时"
    const noDeadline = await callTool(g.h, 'pipeline_human_reply', {
      task_id: g.taskId, request_id: rid, answer_source: 'timeout', role_token: g.tokens.main,
    }, g.agents.main)
    expectDenied(rec, '补充：没有声明截止时间时，"超时"路径被拒（否则就是绕过用户的后门）', noDeadline, ['没有声明截止时间', '后门'])
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  /** 按用例名的前缀归组（名字前缀就是"这是哪一组"的标记）。 */
  const groupOf = (name) => {
    if (name.startsWith('①伪造')) return '反例① 主对话伪造用户答复（无来源依据）'
    if (name.startsWith('②拍板')) return '反例② 主对话替用户拍板'
    if (name.startsWith('③越权')) return '反例③ 角色越权（非 main 想标记已解决 / 推状态）'
    if (name.startsWith('④看代码')) return '反例④ 请求体让用户看代码'
    if (name.startsWith('留痕')) return '审计留痕（发起 / 转告 / 答复 / 恢复 四步）'
    if (name.startsWith('闭环')) return '闭环：答复后发起角色能继续干活'
    if (name.startsWith('补充')) return '补充用例（非阻塞 / 重复答复 / 超时后门）'
    if (name.startsWith('夹具')) return '正例 · 夹具'
    return '正例：四步走通（发起 → 转告 → 答复 → 恢复）'
  }

  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 人工介入链路自测（用户只与主对话相连）')
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

if (process.argv[1] !== undefined && /human-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runHumanCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
