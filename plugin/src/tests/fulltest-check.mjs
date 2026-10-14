/**
 * dsh-pipeline · **全量测试审批链**自测
 * ============================================================================
 *     node tests/fulltest-check.mjs
 *
 * 用户原话：
 *   「需求 ai 要确认是否，并**尽可能让测试 ai 少跑全量测试**，如果测试 ai 要跑
 *     必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
 *     确认人工通过后再提交给计划 ai 安排」
 *
 * 本套按两层验：
 *   A. **判定层**（`lib/testscope.js`）：定向 vs 全量，逐条命令形态对上（含"不许误拦定向"）
 *   B. **执法层**（guard + store）：无凭据的全量命令被拦；走完四级链拿到凭据才放行；
 *      缺级 / 越级 / 否决 / 批一条跑另一条 全都要被拒
 *
 * @module dsh-pipeline/tests/fulltest-check
 */

import { join } from 'node:path'

import { classifyTestCommand, sameTestCommand } from '../lib/testscope.js'
import { callTool, disposeHarness } from './selftest-core.mjs'
import { createBoundaryFixture } from './boundary-check.mjs'

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

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runFullTestCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 判定层：定向 vs 全量（逐条命令形态）
  // =========================================================================
  {
    const expected = [
      // [命令, 期望, 说明]
      ['npm test', 'full', '裸跑整套'],
      ['npm run test:unit', 'full', '裸跑整套（变体）'],
      ['pytest', 'full', '裸跑整套'],
      ['go test ./...', 'full', '全包写法'],
      ['node --test tests/', 'full', '整目录'],
      ['npx vitest run', 'full', '无参数'],
      ['cargo test', 'full', '无参数'],
      ['pnpm test --watch', 'full', '没有收窄范围'],
      // --- 定向：**一条都不许误拦** ---
      ['npm test -- --grep fizzbuzz', 'targeted', '-- 之后给过滤'],
      ['npm test -- src/api/a.test.ts', 'targeted', '-- 之后给具体文件'],
      ['pytest -k parse', 'targeted', '-k 过滤'],
      ['python -m pytest tests/unit/test_a.py', 'targeted', '具体文件'],
      ['go test ./pkg/x', 'targeted', '具体包'],
      ['node --test tests/a.test.mjs', 'targeted', '具体文件'],
      ['npx jest -t adds-two', 'targeted', '按用例名'],
      ['jest --testPathPattern=src/api', 'targeted', '按路径'],
      ['cargo test --test adds', 'targeted', '具体测试目标'],
      ['dotnet test --filter Name~Add', 'targeted', '按名字过滤'],
      ['mvn test -Dtest=FooTest', 'targeted', '按类'],
      ['gradle test --tests com.x.Foo', 'targeted', '按类'],
      // --- 不是测试命令 ⇒ 弃权 ---
      ['ls -la', null, '不是测试命令'],
      ['npm run build', null, '构建不是测试'],
      ['node build.mjs', null, '构建不是测试'],
    ]
    for (const [cmd, want, why] of expected) {
      const got = classifyTestCommand(cmd)
      rec.add(
        'A 判定层',
        `${want === 'full' ? '★ 全量' : want === 'targeted' ? '定向（**不许误拦**）' : '弃权'}：\`${cmd}\` —— ${why}`,
        got.kind === want,
        `判定：${got.kind}（期望 ${want}）\n理由：${got.why}\n命中形态：${got.what || '(未识别为测试命令)'}`,
      )
    }
    // 命令比对（批一条跑另一条）
    rec.add(
      'A 判定层',
      '★ 命令比对：逐字一致 / 只多开关 ⇒ 同一条；换了主干 ⇒ 不是同一条',
      sameTestCommand('npm test', 'npm test').same === true &&
        sameTestCommand('npm test', 'npm test --ci').same === true &&
        sameTestCommand('npm test', 'pytest').same === false,
      [
        `npm test ≡ npm test → ${sameTestCommand('npm test', 'npm test').same}`,
        `npm test ≡ "npm test --ci" → ${sameTestCommand('npm test', 'npm test --ci').same}`,
        `npm test ≡ pytest → ${sameTestCommand('npm test', 'pytest').same}`,
      ].join('\n'),
    )
  }

  // =========================================================================
  // B. 执法层：守门拦 + 四级链凭据
  // =========================================================================
  {
    // ⚠️ 用 L2 夹具：这条链要 orchestrator / reviewer / planner 三个角色都在册
    //    （L0 夹具里根本没有计划与需求分析，链走不起来）。
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId
    // 审核令牌：boundary 夹具没铸它，这里补一枚（与 review-check 同一做法）
    if (f.tokens.reviewer === undefined) {
      f.tokens.reviewer = f.h.tokens.mint({ taskId: T, role: 'reviewer', agentId: 'ft-reviewer', note: 'fulltest-check' }).token
      f.agents.reviewer = 'ft-reviewer'
    }
    const testerTok = f.tokens.tester
    const testerAgent = f.agents.tester
    const run = (cmd) => callTool(f.h, 'pwsh', { command: cmd, role_token: testerTok }, testerAgent)

    // --- ① 定向：直接放行 ---
    {
      const r = await run('npm test -- --grep fizzbuzz')
      rec.add(
        'B 执法层',
        '★ 正例：**定向测试直接放行**（拦的是全量，不是测试本身）',
        r.denied !== true,
        `layer=${r.layer}\n${r.text}`,
      )
    }

    // --- ② 全量：无凭据 ⇒ 拦，并告知走审批链 ---
    {
      const r = await run('npm test')
      rec.add(
        'B 执法层',
        '★★ 反例①：**无凭据的全量命令 ⇒ 拦**（并给出完整审批链的走法）',
        r.denied === true &&
          hit(r.text, '全量测试要走审批链') &&
          hit(r.text, 'full_test_request') &&
          hit(r.text, 'stage=need') &&
          hit(r.text, 'stage=worth') &&
          hit(r.text, 'full_test_approval') &&
          hit(r.text, 'stage=arrange'),
        `layer=${r.layer}\n${indent(r.text)}`,
      )
    }

    // --- ③ 越级：审核先裁定（还没需求分析）⇒ 拒 ---
    const reviewPayload = (stage, ok, extra = {}) => ({
      task_id: T,
      request_id: '',
      stage,
      ok,
      reason: '夹具裁定',
      ...extra,
    })
    {
      const chain = () => (f.h.store.peek(T).full_test_approvals ?? []).at(-1)
      // 先提申请
      const req = await callTool(
        f.h,
        'pipeline_handoff',
        {
          task_id: T,
          kind: 'full_test_request',
          role_token: testerTok,
          payload: {
            task_id: T,
            affected_paths: ['src/web/app.js'],
            targeted_already_run: ['npm test -- --grep fizzbuzz → 4/4 通过'],
            why_targeted_insufficient: '这次改的是启动装配，定向用例覆盖不到冷启动路径',
            what_will_run: 'npm test',
          },
        },
        testerAgent,
      )
      rec.add('B 执法层', '★ 正例：tester 交 `full_test_request`（起链）⇒ 收下', req.denied !== true, `layer=${req.layer}\n${indent(req.text)}`)
      const rid = chain()?.approval_id ?? ''

      // 越级：worth 先来
      const skip = await callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: f.tokens.reviewer, payload: reviewPayload('worth', true, { request_id: rid, worth_it: '值得' }) },
        f.agents.reviewer,
      )
      rec.add(
        'B 执法层',
        '★★ 反例②：**越级**（需求分析还没点头，审核先裁定）⇒ 拒（顺序就是判据）',
        skip.denied === true && hit(skip.text, '顺序|FULL_TEST_STAGE_OUT_OF_ORDER|缺一级'),
        `layer=${skip.layer}\n${indent(skip.text)}`,
      )

      // 站别与角色不符
      const wrongStage = await callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: f.tokens.reviewer, payload: reviewPayload('need', true, { request_id: rid }) },
        f.agents.reviewer,
      )
      rec.add(
        'B 执法层',
        '★ 反例③：审核交 `stage=need`（那是需求分析的站）⇒ 拒',
        wrongStage.denied === true && hit(wrongStage.text, 'FULL_TEST_STAGE_MISMATCH|不该由'),
        `layer=${wrongStage.layer}\n${indent(wrongStage.text)}`,
      )

      // 二：需求分析同意
      const need = await callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: f.tokens.orchestrator, payload: reviewPayload('need', true, { request_id: rid, necessity: '冷启动路径确实只有整套跑才覆盖' }) },
        f.agents.orchestrator,
      )
      rec.add('B 执法层', '★ 正例：需求分析 `stage=need` 同意 ⇒ 收下', need.denied !== true, `layer=${need.layer}\n${indent(need.text)}`)

      // 三：审核同意
      const worth = await callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: f.tokens.reviewer, payload: reviewPayload('worth', true, { request_id: rid, worth_it: '一次全量的成本 < 冷启动回归的风险' }) },
        f.agents.reviewer,
      )
      rec.add('B 执法层', '★ 正例：审核 `stage=worth` 同意 ⇒ 收下', worth.denied !== true, `layer=${worth.layer}\n${indent(worth.text)}`)

      // 此刻还没人工 ⇒ 仍然拦
      const stillBlocked = await run('npm test')
      rec.add(
        'B 执法层',
        '★★ 反例④：**两级同意但用户还没点头** ⇒ 仍然拦（缺人工这一级）',
        stillBlocked.denied === true && hit(stillBlocked.text, '全量测试要走审批链'),
        `layer=${stillBlocked.layer}\n${indent(stillBlocked.text.split('\n').slice(0, 6).join('\n'))}`,
      )

      // 计划抢跑（人工没通过）⇒ 拒
      const earlyArrange = await callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: f.tokens.planner, payload: reviewPayload('arrange', true, { request_id: rid, scope: '全部用例', command: 'npm test' }) },
        f.agents.planner,
      )
      rec.add(
        'B 执法层',
        '★★ 反例⑤：**人工没通过，计划 AI 就想安排** ⇒ 拒',
        earlyArrange.denied === true && hit(earlyArrange.text, 'FULL_TEST_HUMAN_NOT_APPROVED|用户没点头'),
        `layer=${earlyArrange.layer}\n${indent(earlyArrange.text)}`,
      )
    }
  }

  // =========================================================================
  // C. 终点：人工通过 + 计划安排 ⇒ 凭据生效，**同一条命令放行**
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId
    if (f.tokens.reviewer === undefined) {
      f.tokens.reviewer = f.h.tokens.mint({ taskId: T, role: 'reviewer', agentId: 'ft-reviewer', note: 'fulltest-check' }).token
      f.agents.reviewer = 'ft-reviewer'
    }
    const run = (cmd) => callTool(f.h, 'pwsh', { command: cmd, role_token: f.tokens.tester }, f.agents.tester)
    const review = (role, tok, agent, stage, ok, extra = {}) =>
      callTool(
        f.h,
        'pipeline_handoff',
        { task_id: T, kind: 'full_test_review', role_token: tok, payload: { task_id: T, request_id: extra.request_id ?? '', stage, ok, reason: '夹具', ...extra } },
        agent,
      )

    await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: T,
        kind: 'full_test_request',
        role_token: f.tokens.tester,
        payload: {
          task_id: T,
          affected_paths: ['src/web/app.js'],
          targeted_already_run: ['npm test -- --grep fizzbuzz → 通过'],
          why_targeted_insufficient: '冷启动路径只有整套跑才覆盖',
          what_will_run: 'npm test',
        },
      },
      f.agents.tester,
    )
    const task = f.h.store.peek(T)
    const rid = (task.full_test_approvals ?? []).at(-1).approval_id

    // 人工那一站：直接走 store 的既有机制（human_request + human_reply），
    // 不走工具 —— 因为主对话发请求要过状态闸，这里测的是链本身。
    const hr = f.h.store.createHumanRequestEntry(
      task,
      { handoff_id: 'H-fixture-1' },
      {
        task_id: T,
        from_role: 'orchestrator',
        reason_kind: 'full_test_approval',
        question_for_human: '要不要跑一次全量测试？',
        decision_kind: 'approve_reject',
        blocking: true,
        blocked_stage: '测试中',
      },
    )
    const chain = (f.h.store.peek(T).full_test_approvals ?? []).at(-1)
    f.h.store.attachFullTestHumanRequest(f.h.store.peek(T), chain, hr)

    await review('orchestrator', f.tokens.orchestrator, f.agents.orchestrator, 'need', true, { request_id: rid, necessity: '需要' })
    await review('reviewer', f.tokens.reviewer, f.agents.reviewer, 'worth', true, { request_id: rid, worth_it: '值得' })

    // 人工答复：**不通过** ⇒ 链停住
    {
      const taskNow = f.h.store.peek(T)
      f.h.store.linkHumanReplyToFullTest(taskNow, {
        request_id: hr.request_id,
        decision: 'rejected',
        quote: '先别跑全量，我这边赶时间',
        answered_by: '用户在当前会话里直接回复',
        answered_at: '2026-10-11T00:00:00Z',
      })
      const c = (taskNow.full_test_approvals ?? []).at(-1)
      rec.add(
        'C 终点',
        '★★ 反例⑥：**用户人工不通过** ⇒ 链停在 human 站（留痕）',
        c.status === 'rejected' && c.rejected_at_stage === 'human' && c.reject_reason.length > 0,
        `status=${c.status}　stopped_at=${c.rejected_at_stage}\nreason=${c.reject_reason}\nquote=${c.human?.quote}`,
      )
      const r = await run('npm test')
      rec.add(
        'C 终点',
        '★★ 反例⑥续：被否决之后**仍然拦**（不能"反正申请过了"）',
        r.denied === true && hit(r.text, '全量测试要走审批链'),
        `layer=${r.layer}\n${indent(r.text.split('\n').slice(0, 4).join('\n'))}`,
      )
      // 计划也不能在否决之后安排
      const arr = await review('planner', f.tokens.planner, f.agents.planner, 'arrange', true, { request_id: rid, scope: '全部', command: 'npm test' })
      rec.add(
        'C 终点',
        '★ 反例⑥续：链已结案 ⇒ 后面的站**不能再加裁定**',
        arr.denied === true && hit(arr.text, '已经结案|FULL_TEST_CHAIN_CLOSED'),
        `layer=${arr.layer}\n${indent(arr.text)}`,
      )
    }

    // --- 重开一条链，这次**人工通过**并走完全程 ---
    {
      const t = f.h.store.peek(T)
      t.full_test_approvals = t.full_test_approvals.filter((c) => c.status === 'approved')
      const req2 = await callTool(
        f.h,
        'pipeline_handoff',
        {
          task_id: T,
          kind: 'full_test_request',
          role_token: f.tokens.tester,
          payload: {
            task_id: T,
            affected_paths: ['src/web/app.js'],
            targeted_already_run: ['npm test -- --grep fizzbuzz → 通过'],
            why_targeted_insufficient: '冷启动路径只有整套跑才覆盖',
            what_will_run: 'npm test',
          },
        },
        f.agents.tester,
      )
      rec.add('C 终点', '★ 正例：结案之后可以**重新提一条**', req2.denied !== true, `layer=${req2.layer}`)
      const rid2 = (f.h.store.peek(T).full_test_approvals ?? []).at(-1).approval_id

      const hr2 = f.h.store.createHumanRequestEntry(
        f.h.store.peek(T),
        { handoff_id: 'H-fixture-2' },
        {
          task_id: T,
          from_role: 'orchestrator',
          reason_kind: 'full_test_approval',
          question_for_human: '要不要跑一次全量测试？',
          decision_kind: 'approve_reject',
          blocking: true,
          blocked_stage: '测试中',
        },
      )
      const c2 = (f.h.store.peek(T).full_test_approvals ?? []).at(-1)
      f.h.store.attachFullTestHumanRequest(f.h.store.peek(T), c2, hr2)

      await review('orchestrator', f.tokens.orchestrator, f.agents.orchestrator, 'need', true, { request_id: rid2, necessity: '需要' })
      await review('reviewer', f.tokens.reviewer, f.agents.reviewer, 'worth', true, { request_id: rid2, worth_it: '值得' })
      f.h.store.linkHumanReplyToFullTest(f.h.store.peek(T), {
        request_id: hr2.request_id,
        decision: 'approved',
        quote: '可以，跑一次全量确认一下',
        answered_by: '用户在当前会话里直接回复',
        answered_at: '2026-10-11T00:10:00Z',
      })

      // 计划没安排之前仍然拦
      const beforeArrange = await run('npm test')
      rec.add(
        'C 终点',
        '★★ 反例⑦：人工通过了，但**计划还没安排** ⇒ 仍然拦（四级缺一不可）',
        beforeArrange.denied === true && hit(beforeArrange.text, '全量测试要走审批链'),
        `layer=${beforeArrange.layer}\n${indent(beforeArrange.text.split('\n').slice(0, 4).join('\n'))}`,
      )

      const arr2 = await review('planner', f.tokens.planner, f.agents.planner, 'arrange', true, { request_id: rid2, scope: '全部用例', command: 'npm test' })
      rec.add('C 终点', '★ 正例：计划 AI `stage=arrange` 给出范围与**最终命令** ⇒ 收下', arr2.denied !== true, `layer=${arr2.layer}\n${indent(arr2.text)}`)
      // 索引同步（真实路径里由 indexTask 做；夹具直接调）
      f.h.indexTask(T, f.h.store.peek(T))

      const allowed = await run('npm test')
      rec.add(
        'C 终点',
        '★★★ 正例：**四级齐了 ⇒ 同一条全量命令放行**（凭据生效）',
        allowed.denied !== true,
        `layer=${allowed.layer}\n${allowed.text}`,
      )
      const allowedWithFlag = await run('npm test --ci')
      rec.add(
        'C 终点',
        '★ 正例：批准的命令 + 无害开关（`npm test --ci`）也算同一条 ⇒ 放行（别把审批做成逐字节比对）',
        allowedWithFlag.denied !== true,
        `layer=${allowedWithFlag.layer}\n${allowedWithFlag.text}`,
      )
      const otherCommand = await run('pytest')
      rec.add(
        'C 终点',
        '★★ 反例⑧：**批的是 npm test，却去跑 pytest** ⇒ 拒（批一条跑另一条 = 没审批）',
        otherCommand.denied === true && hit(otherCommand.text, '与批准的那一条|不一致'),
        `layer=${otherCommand.layer}\n${indent(otherCommand.text)}`,
      )
      const targetedStill = await run('npm test -- --grep fizzbuzz')
      rec.add(
        'C 终点',
        '★ 正例：拿了凭据之后，**定向**测试照样直接放行（凭据只加在全量上）',
        targetedStill.denied !== true,
        `layer=${targetedStill.layer}`,
      )

      // 进度查询
      const st = await callTool(f.h, 'pipeline_full_test', { task_id: T, role_token: f.tokens.main }, f.agents.main)
      rec.add(
        'C 终点',
        '★ 只读工具 `pipeline_full_test`：把链的进度与凭据摊开（谁都能查）',
        st.denied !== true && st.value?.status === 'approved' && st.value?.credential?.command === 'npm test',
        `status=${st.value?.status}　next=${st.value?.next_stage}\ncredential=${JSON.stringify(st.value?.credential)}\n${indent(String(st.text).split('\n').slice(0, 12).join('\n'))}`,
      )
    }
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
  lines.push('dsh-pipeline 全量测试审批链自测（判定层 + 执法层 + 凭据）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：尽可能让测试 ai 少跑全量测试；要跑必须经 需求分析 → 审核 → 用户人工 → 计划 四级。')
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

// 直接跑：`node tests/fulltest-check.mjs`
if (process.argv[1] !== undefined && /fulltest-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runFullTestCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
