/**
 * dsh-pipeline · 设计目的自测：**防过度工程化 = 只干自己该干的**
 * ============================================================================
 *     node tests/boundary-check.mjs
 *
 * 本套验的是本项目的**第一性目标**（用户原话）：
 *   「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
 *     编程别跑测试，编排别看代码」
 *
 * 它落成三条**机器可执法**的边界，每一条都配正例 + 反例：
 *
 *   ① **编写不跑测试**：测试类命令被守门拦；编写不得产出测试结论类交接物；
 *      `dev_to_test` 里不许夹带测试结论字段。（能力边界，不是提示词规劝）
 *   ② **控制角色不看代码**：主对话 / 需求分析 / 计划读源码、检索源码、用 shell 读源码
 *      全被拦；它们的产物里不许出现代码正文。**允许**读 `.pipeline/` 下的东西。
 *   ③ **白名单方向**：谁的能力谁有 —— 忘了加只是少一条能力，不会悄悄多一条。
 *
 * @module dsh-pipeline/tests/boundary-check
 */

import { join } from 'node:path'

import { callTool, createHarness, disposeHarness, manifestFor, runAnalysisThenPlan } from './selftest-core.mjs'

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

/** 绕过守门直接打 execute（验第二道闸）。 */
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
// 夹具：一个 L2 + 三层的任务，停在「开发中」（三个席位各持令牌）
// ---------------------------------------------------------------------------

/**
 * 造一个"三个层各一个席位、都在开发中"的任务。
 *
 * 走的是**真实链路**（需求分析 → 用户确认 → 计划 → 分配），只在最后一步
 * 直接调 `store.transition` 进「开发中」—— 因为工具层的派活还要求先有需求档，
 * 而那是另一条判据（其它套已覆盖），本套要验的是**守门的能力边界**。
 */
export async function createBoundaryFixture() {
  const h = await createHarness()
  const MAIN = 'boundary-main'
  const opened = await callTool(
    h,
    'pipeline_task_open',
    { requirement: '给订单系统加导出：接口层、数据层、处理层三块并行推进。', deliverable_format: '补丁 + 变更说明 + 可运行命令' },
    MAIN,
  )
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }

  const layers = ['interface', 'data', 'logic']
  await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: '跨模块 + 需要冻结接口契约 ⇒ L2；按层并行',
    layers: layers.map((l) => ({ layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
    writers: {
      layers,
      partitions: layers.map((l, i) => ({ seat: `writer#${i + 1}`, layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
      reason: '三层路径互不重叠，接口先冻结再并行',
    },
  })
  // → ready_dev；再直接推进到开发中（不走工具层派活，避免依赖需求档那条判据）
  const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
  if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)

  for (const seat of ['writer#1', 'writer#2', 'writer#3']) {
    const tok = h.tokens.mint({ taskId, role: 'writer', seat, agentId: `boundary-${seat}`, note: 'boundary-check' })
    tokens[seat] = tok.token
    agents[seat] = `boundary-${seat}`
  }
  const testerTok = h.tokens.mint({ taskId, role: 'tester', agentId: 'boundary-tester', note: 'boundary-check' })
  tokens.tester = testerTok.token
  agents.tester = 'boundary-tester'
  const orchTok = h.tokens.mint({ taskId, role: 'orchestrator', agentId: 'boundary-orch', note: 'boundary-check' })
  tokens.orchestrator = orchTok.token
  agents.orchestrator = 'boundary-orch'
  const planTok = h.tokens.mint({ taskId, role: 'planner', agentId: 'boundary-planner', note: 'boundary-check' })
  tokens.planner = planTok.token
  agents.planner = 'boundary-planner'

  // ★ 守门要**同步**查任务，所以登记进索引（与生产同一条路径）
  const task = await h.store.get(taskId)
  h.indexTask(taskId, task)
  return { h, taskId, tokens, agents, requirements: { state: task.state } }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runBoundaryCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // ① 编写不跑测试
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    rec.add('① 编写不跑测试', '（夹具）任务停在「开发中」，writer#1~#3 各持令牌', f.requirements.state === 'developing', `state=${f.requirements.state}`)

    const W1 = f.agents['writer#1']
    const T1 = f.tokens['writer#1']
    const cmd = (command) => callTool(f.h, 'pwsh', { command, role_token: T1 }, W1)

    // --- 反例：四种典型测试执行形态 ---
    expectDenied(rec, '① 编写不跑测试', '反例① `npm test` → 拦', await cmd('npm test'), ['编写不跑测试', 'tester', 'dev_to_test'])
    expectDenied(rec, '① 编写不跑测试', '反例② `npx jest --coverage` → 拦', await cmd('npx jest --coverage'), ['编写不跑测试'])
    expectDenied(rec, '① 编写不跑测试', '反例③ `python -m pytest tests/ -q` → 拦', await cmd('python -m pytest tests/ -q'), ['编写不跑测试'])
    expectDenied(rec, '① 编写不跑测试', '反例④ `node --test tests/` → 拦', await cmd('node --test tests/'), ['编写不跑测试'])
    expectDenied(rec, '① 编写不跑测试', '反例⑤ `node tests/run-all.mjs` → 拦（直接跑测试目录下的脚本）', await cmd('node tests/run-all.mjs'), ['编写不跑测试'])
    expectDenied(rec, '① 编写不跑测试', '反例⑥ `npm run test:unit` → 拦（test 脚本的变体）', await cmd('npm run test:unit'), ['编写不跑测试'])
    expectDenied(rec, '① 编写不跑测试', '反例⑥′ `pwsh -File tests/x.ps1` → 拦（换个解释器跑测试目录）', await cmd('pwsh -File tests/x.ps1'), ['编写不跑测试'])

    // --- 正例：构建 / 启动级冒烟不受限（这是刻意留下的活路）---
    for (const [name, c] of [
      ['`npm run build`（构建）', 'npm run build'],
      ['`node build.mjs`（构建脚本）', 'node build.mjs'],
      ['`node -e "console.log(1)"`（一次性冒烟）', 'node -e "console.log(1)"'],
      ['`tsc --noEmit`（类型检查）', 'tsc --noEmit'],
    ]) {
      const r = await cmd(c)
      rec.add('① 编写不跑测试', `正例：${name} 不被拦（构建/启动级冒烟是刻意留的活路）`, r.denied !== true, `layer=${r.layer}\n${r.text}`)
    }

    // --- 对照：tester 跑**定向**测试不受限（那是它的本职）---
    //
    //   ⚠️ 本轮起 `npm test`（裸跑整套）归"全量测试"，要有四级凭据才放行 ——
    //      所以这条对照改成**带范围的**那条命令：拦的是角色，不是命令。
    //      （全量那条另有 tests/fulltest-check.mjs 专门测正反例。）
    const testerRun = await callTool(f.h, 'pwsh', { command: 'npm test -- --grep fizzbuzz', role_token: f.tokens.tester }, f.agents.tester)
    rec.add(
      '① 编写不跑测试',
      '对照：**tester 跑定向测试（`npm test -- --grep …`）放行**（拦的是角色，不是命令）',
      testerRun.denied !== true,
      `layer=${testerRun.layer}\n${testerRun.text}`,
    )

    // --- ★ 本轮新增对照：tester 裸跑整套 ⇒ 归全量测试，要有凭据 ---
    const testerFull = await callTool(f.h, 'pwsh', { command: 'npm test', role_token: f.tokens.tester }, f.agents.tester)
    rec.add(
      '① 编写不跑测试',
      '★ 对照（本轮新增）：**tester 裸跑 `npm test`（整套）⇒ 要凭据**（全量测试审批链）',
      testerFull.denied === true && hit(testerFull.text, '全量测试要走审批链'),
      `layer=${testerFull.layer}\n${testerFull.text}`,
    )

    // --- 反例：编写交测试结论类交接物 ---
    const asTester = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'test_to_review',
        role_token: T1,
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          test_cases: ['n=1'],
          execution_result: '1/1 通过',
          failure_logs: [],
          pass_evidence: ['我自己跑的'],
          risk_notes: [],
          verdict: 'pass',
        },
      },
      W1,
    )
    expectDenied(rec, '① 编写不跑测试', '反例⑦ 编写交 `test_to_review`（自己出测试报告）→ 拦', asTester, ['角色越权', '编写不跑测试'])

    const rawTester = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'test_to_review',
        role_token: T1,
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          test_cases: ['n=1'],
          execution_result: '1/1 通过',
          failure_logs: [],
          pass_evidence: ['我自己跑的'],
          risk_notes: [],
          verdict: 'pass',
        },
      },
      W1,
    )
    expectDenied(rec, '① 编写不跑测试', '反例⑦′ 绕过守门直接打 execute：第二道闸仍然拦', rawTester, ['角色越权', '编写不跑测试'])

    const asTesterBack = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'test_to_dev',
        role_token: T1,
        payload: { task_id: f.taskId, artifact_version: 'v1', failed_cases: ['x'], failure_logs: ['y'], expected: 'z' },
      },
      W1,
    )
    expectDenied(rec, '① 编写不跑测试', '反例⑧ 编写交 `test_to_dev`（自己判"不通过"）→ 拦', asTesterBack, ['角色越权', 'tester'])

    // --- 反例：dev_to_test 里夹带测试结论字段（换个信封寄结论）---
    const smuggle = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'dev_to_test',
        role_token: T1,
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          patch_or_code: 'diff --git a/src/interface/a.js b/src/interface/a.js',
          change_note: '新增导出接口',
          run_commands: ['node build.mjs'],
          selftest_result: '构建通过',
          known_issues: [],
          partition: { seat: 'writer#1', index: 1, total: 3, layer: 'interface', scope_paths: ['src/interface'] },
          ...manifestFor(f.h.store, f.taskId, { path: 'src/interface' }),
          test_cases: ['n=1', 'n=0'],
          pass_evidence: ['我自己跑的，全过'],
          verdict: 'pass',
        },
      },
      W1,
    )
    expectDenied(rec, '① 编写不跑测试', '反例⑨ dev_to_test 里夹带 `test_cases`/`pass_evidence`/`verdict` → 拦（换信封寄结论）', smuggle, [
      '不属于 dev_to_test',
      '编写不跑测试',
      'tester',
    ])

    // --- 正例：干净的 dev_to_test 收下（构建级自测描述可以写）---
    const clean = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'dev_to_test',
        role_token: T1,
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          patch_or_code: 'diff --git a/src/interface/a.js b/src/interface/a.js',
          change_note: '新增导出接口',
          run_commands: ['node build.mjs'],
          selftest_result: '构建通过、模块能起得来（未做验收判定 —— 判定交给测试）',
          known_issues: ['边界值未覆盖'],
          partition: { seat: 'writer#1', index: 1, total: 3, layer: 'interface', scope_paths: ['src/interface'] },
          ...manifestFor(f.h.store, f.taskId, { path: 'src/interface' }),
        },
      },
      W1,
    )
    expectOk(rec, '① 编写不跑测试', '正例：干净的 dev_to_test 收下（只描述构建/冒烟，不做验收判定）', clean, ['编写交付给测试'])
  }

  // =========================================================================
  // ② 控制角色不看代码
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const srcFile = join(f.h.projectRoot, 'src/interface/a.js')
    const reqDoc = join(f.h.projectRoot, '.pipeline', f.taskId, 'requirement.md')

    for (const role of ['orchestrator', 'planner', 'main']) {
      const agent = f.agents[role]
      const tok = f.tokens[role]

      expectDenied(
        rec,
        '② 控制角色不看代码',
        `反例① ${role} 用 read 读源码 → 拦`,
        await callTool(f.h, 'read', { file_path: srcFile, role_token: tok }, agent),
        ['不得读取代码正文', '不看实现|不读代码'],
      )

      expectDenied(
        rec,
        '② 控制角色不看代码',
        `反例② ${role} 用 grep 检索源码 → 拦（检索吐出来的就是代码行）`,
        await callTool(f.h, 'grep', { pattern: 'export', path: join(f.h.projectRoot, 'src'), role_token: tok }, agent),
        ['不得用检索工具翻源码树', '代码行|代码正文'],
      )

      expectDenied(
        rec,
        '② 控制角色不看代码',
        `反例③ ${role} 用 shell 读源码 → 拦`,
        await callTool(f.h, 'pwsh', { command: `Get-Content "${srcFile}"`, role_token: tok }, agent),
        ['不得通过 shell 读取项目代码'],
      )
    }

    // --- 正例：读 `.pipeline/` 下的东西是允许的（那是它们该看的）---
    rec.add(
      '② 控制角色不看代码',
      '对照：`.pipeline/` 下的需求档允许读（控制角色只吃需求档 + 摘要）',
      true,
      '（下面三条会分别验：需求档 / 记录 / 收件箱都在 .pipeline 下，判据按**路径**放行）',
    )
    for (const role of ['orchestrator', 'planner']) {
      const r = await callTool(f.h, 'read', { file_path: reqDoc, role_token: f.tokens[role] }, f.agents[role])
      rec.add(
        '② 控制角色不看代码',
        `正例：${role} 读 .pipeline/<任务>/requirement.md 放行`,
        r.denied !== true,
        `layer=${r.layer}\n${r.text}`,
      )
      const s = await callTool(
        f.h,
        'grep',
        { pattern: '验收', path: join(f.h.projectRoot, '.pipeline', f.taskId), role_token: f.tokens[role] },
        f.agents[role],
      )
      rec.add(
        '② 控制角色不看代码',
        `正例：${role} 在 .pipeline/<任务>/ 里检索放行（收件箱是它们自己的东西）`,
        s.denied !== true,
        `layer=${s.layer}\n${s.text}`,
      )
    }
    // --- 正例：只给路径的 glob **不拦**（列文件名不算"看代码"）---
    const g1 = await callTool(f.h, 'glob', { pattern: 'src/**/*.js', role_token: f.tokens.planner }, f.agents.planner)
    rec.add(
      '② 控制角色不看代码',
      '正例：`glob`（只给**路径名**）不拦 —— 边界画在"正文"上，不在"知道有哪些文件"上',
      g1.denied !== true,
      `layer=${g1.layer}\n${g1.text}`,
    )
  }

  // =========================================================================
  // ②b 控制角色的**产物**里不许出现代码正文
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    // 需求分析落一份 requirement_analysis（先让状态回到 analyzing 才能交）
    await f.h.store.transition({ taskId: f.taskId, event: 'block', actorRole: 'main' }).catch(() => {})
    const st = await f.h.store.get(f.taskId)
    if (st.state === 'blocked') await f.h.store.transition({ taskId: f.taskId, event: 'unblock', actorRole: 'main' })

    // 直接打 execute（跳过状态判据，单验**内容**判据）
    const dirty = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'requirement_analysis',
        role_token: f.tokens.orchestrator,
        payload: {
          task_id: f.taskId,
          task_card: { goal: '加导出' },
          acceptance: ['导出可用'],
          test_points: ['正常路径'],
          boundaries: [],
          unclear_points: [],
          analysis_reason: '我看了实现：export function fizzbuzz(n){ return [] }，所以按这个改。',
        },
      },
      f.agents.orchestrator,
    )
    expectDenied(rec, '② 控制角色不看代码', '反例④ 需求分析的结论里塞了代码正文 → 拦', dirty, ['代码正文', '不看代码'])

    const planDirty = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'plan',
        role_token: f.tokens.planner,
        payload: {
          task_id: f.taskId,
          plan_steps: ['冻结契约'],
          layers: [],
          self_check: { verdict: 'ok', checked: ['需求覆盖'], gaps: [] },
          plan_reason: '按 src/a.js 里的 const x = require("y") 那样改就行。',
        },
      },
      f.agents.planner,
    )
    expectDenied(rec, '② 控制角色不看代码', '反例⑤ 计划的理由里塞了代码正文 → 拦', planDirty, ['代码正文', '不看代码'])

    // --- 正例：只写路径与人话**不受限**（结构描述本来就该写路径）---
    const cleanPlan = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'plan',
        role_token: f.tokens.planner,
        payload: {
          task_id: f.taskId,
          plan_steps: ['冻结接口契约', '按层并行实现'],
          layers: [
            { layer: 'interface', scope_paths: ['src/interface'], deliverables: ['接口定义'] },
            { layer: 'data', scope_paths: ['src/data'], deliverables: ['数据访问'] },
          ],
          self_check: { verdict: 'ok', checked: ['需求覆盖', '层边界'], gaps: [] },
          plan_reason: '三层路径互不重叠；接口层先冻结，另外两层再并行。只按目录划分，不看实现。',
        },
      },
      f.agents.planner,
    )
    const onlyContentErr = !hit(cleanPlan.text, '代码正文')
    rec.add(
      '② 控制角色不看代码',
      '正例：计划里写路径 / 目录 / 人话**不触发**代码正文判据（判据只查解释性文本）',
      onlyContentErr,
      `layer=${cleanPlan.layer}\n${cleanPlan.text}`,
    )
  }

  // =========================================================================
  // ③ 白名单方向 + 只干自己该干的
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)

    // writer 的手里**没有**测试类产物的能力（表驱动，不是文案）
    const { ROLES } = await import('../lib/roles.js')
    const writerKinds = ROLES.writer.handoffKinds
    rec.add(
      '③ 白名单方向',
      '★ writer 的 handoffKinds 里**没有** test_to_review / test_to_dev / review_verdict',
      !writerKinds.includes('test_to_review') && !writerKinds.includes('test_to_dev') && !writerKinds.includes('review_verdict'),
      `writer.handoffKinds = ${writerKinds.join(' / ')}`,
    )
    rec.add(
      '③ 白名单方向',
      '★ tester 有 test_to_review / test_to_dev，reviewer 有 review_verdict（各自的活各干）',
      ROLES.tester.handoffKinds.includes('test_to_review') &&
        ROLES.tester.handoffKinds.includes('test_to_dev') &&
        ROLES.reviewer.handoffKinds.includes('review_verdict'),
      `tester = ${ROLES.tester.handoffKinds.join(' / ')}\nreviewer = ${ROLES.reviewer.handoffKinds.join(' / ')}`,
    )
    rec.add(
      '③ 白名单方向',
      '★ 控制角色（需求分析 / 计划）都**不产出**技术交接物（dev_to_test 之类）',
      !ROLES.orchestrator.handoffKinds.includes('dev_to_test') && !ROLES.planner.handoffKinds.includes('dev_to_test'),
      `orchestrator = ${ROLES.orchestrator.handoffKinds.join(' / ')}\nplanner = ${ROLES.planner.handoffKinds.join(' / ')}`,
    )

    // 越界调用工具本身也要拦（能力不给）
    expectDenied(
      rec,
      '③ 白名单方向',
      '反例① writer 调 pipeline_close（关单是主对话的）→ 拦',
      await callTool(f.h, 'pipeline_close', { task_id: f.taskId, role_token: f.tokens['writer#1'] }, f.agents['writer#1']),
      ['角色越权'],
    )
    expectDenied(
      rec,
      '③ 白名单方向',
      '反例② planner 调 pipeline_artifact（制品是编写的）→ 拦',
      await callTool(f.h, 'pipeline_artifact', { task_id: f.taskId, content: 'x', role_token: f.tokens.planner }, f.agents.planner),
      ['角色越权'],
    )
    expectDenied(
      rec,
      '③ 白名单方向',
      '反例③ orchestrator 调 pipeline_plan（分配权是计划的）→ 拦',
      await callTool(f.h, 'pipeline_plan', { task_id: f.taskId, role_token: f.tokens.orchestrator }, f.agents.orchestrator),
      ['角色越权', 'planner'],
    )
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
  lines.push('dsh-pipeline 设计目的自测：防过度工程化（只干自己该干的）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，')
  lines.push('          编程别跑测试，编排别看代码。')
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

// 直接跑：`node tests/boundary-check.mjs`
if (process.argv[1] !== undefined && /boundary-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runBoundaryCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
