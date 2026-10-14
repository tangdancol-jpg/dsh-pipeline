/**
 * dsh-pipeline · 设计目的第 3、4 条自测：**最小改动** 与 **职责自限**
 * ============================================================================
 *     node tests/scope-check.mjs
 *
 * 用户原话：
 *   「还有如修一个 bug 就别该整个模块，分析和计划 ai 确认他们只干什么，不要多干」
 *
 * 两句 = 两条可执法边界，本套逐条验：
 *
 *   A. **最小改动：改动面必须与授权面相等**
 *      · 计划的 `change_scope` 是**授权面**；编写**只能在这个清单内动**；
 *      · 写到清单外 → 拦（**新增文件也算越界**）；
 *      · `dev_to_test` 必须带**实际改动面**（`change_manifest`），
 *        每条改动必须**引用一个授权条目**（`scope_id`）—— 每一处改动都有授权来源；
 *      · 越界要能在**审核阶段**被查出来（判据级：`scope_conformance`），不是靠人看。
 *
 *   B. **职责自限：分析与计划只干什么，不要多干**
 *      · 两份产物都必须有 `role_scope`（will_do / will_not_do）；
 *      · 需求分析的产物里出现**分配内容** → 拒（那是计划 AI 的活）；
 *      · 计划里必须为**每个执行角色**写死边界卡（`role_boundaries`），派活时按它派；
 *      · 越界能力在守门层直接不给（需求分析不能交计划，反之亦然）。
 *
 * @module dsh-pipeline/tests/scope-check
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathKey as pathKeyOf } from '../lib/util.js'
import { callTool, manifestFor } from './selftest-core.mjs'
import { createBoundaryFixture } from './boundary-check.mjs'

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

/** 一份合法的 dev_to_test payload（改动面按授权面造）。 */
function devPayload(f, over = {}) {
  return {
    task_id: f.taskId,
    artifact_version: 'v1',
    patch_or_code: '（夹具改动）',
    change_note: '按授权面改了一处',
    run_commands: ['node build.mjs'],
    selftest_result: '构建通过（不做验收判定）',
    known_issues: [],
    partition: { seat: 'writer#1', index: 1, total: 3, layer: 'interface', scope_paths: ['src/interface'] },
    ...manifestFor(f.h.store, f.taskId, { path: 'src/interface', index: 0 }),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runScopeCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 最小改动：改动面必须与授权面相等
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const W1 = f.agents['writer#1']
    const T1 = f.tokens['writer#1']
    const scope = f.h.store.peek(f.taskId).change_scope ?? []

    rec.add(
      'A 最小改动',
      '（夹具）计划给了 3 条授权，与三个层一一对应',
      scope.length === 3 && scope[0].action === 'modify',
      `change_scope = ${JSON.stringify(scope, null, 2)}`,
    )

    // 先用**宽授权**把两个文件造出来（后面要拿它们验"授权面收窄之后"的判据）
    //
    // ⚠️ 必须用**真的** fs 落盘：守门那条 `create` 判据要 `existsSync` 目标路径，
    //    而自测里的 `write` 是替身、不落盘 —— 只调工具的话文件根本不存在，
    //    那条判据就永远测不到（假绿）。
    await mkdir(join(f.h.projectRoot, 'src/interface'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/interface/a.js'), '// a\n', 'utf8')
    await writeFile(join(f.h.projectRoot, 'src/interface/existing.js'), '// b\n', 'utf8')

    // ★ 把授权面**收窄到一个文件** —— 于是「席位分区之内、但授权面之外」这个区间出现了。
    //   这正是要单独验的那条判据：分区管"你负责哪块"，改动面管"这次允许动哪些"。
    const narrow = [{ id: 'CS1', path: 'src/interface/a.js', action: 'modify', why: '夹具：本次只授权改这一个文件' }]
    const setScope = (v) => {
      const t = f.h.store.peek(f.taskId)
      t.change_scope = v
      f.h.indexTask(f.taskId, t)
    }
    setScope(narrow)

    // --- 正例：授权面之内 ---
    const inside = await callTool(
      f.h,
      'write',
      { path: join(f.h.projectRoot, 'src/interface/a.js'), content: '// 授权面之内', role_token: T1 },
      W1,
    )
    rec.add(
      'A 最小改动',
      '正例：写**授权面之内**的文件 → 放行',
      inside.denied !== true,
      `layer=${inside.layer}\n${inside.text}`,
    )

    // --- 反例①：同一个分区里、但没被授权的**已存在**文件 ---
    const outside = await callTool(
      f.h,
      'write',
      { path: join(f.h.projectRoot, 'src/interface/existing.js'), content: '// 顺手也改了', role_token: T1 },
      W1,
    )
    expectDenied(rec, 'A 最小改动', '★ 反例① 写**授权面之外**的文件（哪怕它在自己的分区里）→ 守门拒', outside, [
      '改动面超出了授权面',
      '改动面必须与授权面相等',
      'CS1',
      'pipeline_clarify_request|pipeline_roster_request',
    ])

    // --- 反例②：**新增**一个未授权的文件（新增也算越界）---
    const newOutside = await callTool(
      f.h,
      'write',
      { path: join(f.h.projectRoot, 'src/interface/helper.js'), content: '// 顺手的，没在清单里', role_token: T1 },
      W1,
    )
    expectDenied(rec, 'A 最小改动', '★ 反例② **新增文件也算越界**：新建一个没授权的文件 → 拒', newOutside, [
      '改动面超出了授权面',
      '新增文件也算越界',
    ])

    // 对照：授权一个**目录**时，在其中新建是允许的
    setScope([{ id: 'CS1', path: 'src/interface', action: 'modify', why: '夹具：整目录授权' }])
    const newInside = await callTool(
      f.h,
      'write',
      { path: join(f.h.projectRoot, 'src/interface/brand-new.js'), content: '// 在授权目录里新建', role_token: T1 },
      W1,
    )
    rec.add(
      'A 最小改动',
      '对照：授权的是一个**目录**时，在其中新建 → 放行（授权的是"这块"）',
      newInside.denied !== true,
      `layer=${newInside.layer}\n${newInside.text}`,
    )

    // --- 反例③：命中 `create` 授权，但改的是已存在的文件 ---
    {
      setScope([{ id: 'CS9', path: 'src/interface', action: 'create', why: '夹具：只授权新建' }])
      const wrongAction = await callTool(
        f.h,
        'write',
        { path: join(f.h.projectRoot, 'src/interface/existing.js'), content: '// 改已有文件', role_token: T1 },
        W1,
      )
      expectDenied(rec, 'A 最小改动', '★ 反例③ 命中的是 `create` 授权，却去改**已存在**的文件 → 拒', wrongAction, [
        'create',
        '已经存在',
      ])
    }
    // 反例④：授权面外的 shell 写入
    setScope(scope)
    const shellOut = await callTool(
      f.h,
      'pwsh',
      { command: `Set-Content -Path "${join(f.h.projectRoot, 'src/other/c.js')}" -Value "x"`, role_token: T1 },
      W1,
    )
    expectDenied(rec, 'A 最小改动', '★ 反例④ 用 shell 写到授权面之外 → 拒（shell 侧 best-effort）', shellOut, [
      '改动面超出了授权面',
      'shell 旁路',
    ])
  }

  // =========================================================================
  // A2. dev_to_test 的实际改动面：每一处改动都要有授权来源
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const W1 = f.agents['writer#1']
    const T1 = f.tokens['writer#1']
    const post = (payload) =>
      callTool(f.h, 'pipeline_handoff', { task_id: f.taskId, kind: 'dev_to_test', role_token: T1, payload }, W1)

    // --- 反例：不带实际改动面 ---
    expectDenied(rec, 'A 最小改动', '★ 反例⑤ 有授权面却不交「实际改动面」→ 拒', await post(devPayload(f, { change_manifest: undefined })), [
      '必须带上「实际改动面」',
      'change_manifest',
      '改动面必须与授权面相等',
    ])

    // --- 反例：引用了不存在的授权条目 ---
    expectDenied(
      rec,
      'A 最小改动',
      '★ 反例⑥ 改动清单引用了**不存在的 scope_id** → 拒（没有授权来源的改动）',
      await post(devPayload(f, { change_manifest: [{ path: 'src/interface/a.js', action: 'modify', scope_id: 'CS-NOPE', lines: 3 }] })),
      ['change_scope 里不存在', 'scope_id'],
    )

    // --- 反例：path 不在引用条目的范围内 ---
    expectDenied(
      rec,
      'A 最小改动',
      '★ 反例⑦ 改动清单的 path **不在它引用的授权范围内** → 拒',
      await post(devPayload(f, { change_manifest: [{ path: 'src/data/x.js', action: 'modify', scope_id: 'CS1', lines: 3 }] })),
      ['不在它引用的授权条目', '改动面必须与授权面相等'],
    )

    // --- 反例：绕过守门直接打 execute，第二道闸仍然拦 ---
    const raw = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'dev_to_test',
        role_token: T1,
        payload: devPayload(f, { change_manifest: [{ path: 'src/other/z.js', action: 'modify', scope_id: 'CS1', lines: 1 }] }),
      },
      W1,
    )
    expectDenied(rec, 'A 最小改动', '★ 反例⑦′ 绕过守门直接打 execute：改动面核对仍然拦（第二道闸）', raw, ['不在它引用的授权条目'])

    // --- 正例：改动清单全部落在授权面内 ---
    const good = await post(devPayload(f))
    expectOk(rec, 'A 最小改动', '正例：改动清单逐条落在授权面内 → 收下', good, ['编写交付给测试'])
    const t = f.h.store.peek(f.taskId)
    rec.add(
      'A 最小改动',
      '★ 核对结果落档（`scope_conformance`）—— 这就是"审核阶段能查出来"的判据级依据',
      t.scope_conformance !== undefined && t.scope_conformance !== null && t.scope_conformance.within_scope === true && Array.isArray(t.scope_conformance.manifest),
      `scope_conformance = ${JSON.stringify(t.scope_conformance, null, 2)}`,
    )

    // --- 越界事实一旦存在，审核不能带它出结论 ---
    {
      const t2 = f.h.store.peek(f.taskId)
      t2.scope_conformance = { ...t2.scope_conformance, within_scope: false, out_of_scope: ['src/other/z.js'] }
      const denyRes = await f.h.store.submitHandoff({
        taskId: f.taskId,
        kind: 'review_verdict',
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          conclusion: 'OK',
          risk_notes: [],
          release_approved: true,
          final_delivery_note: 'x',
          security: {
            attestation: 'clean',
            checked_by: 'reviewer',
            checks_ref: ['a.json'],
            local_leak: { checked: true, checks_ref: ['a.json'] },
            network: { checked: true, checks_ref: ['a.json'] },
            findings: [],
          },
        },
        actorRole: 'reviewer',
      })
      rec.add(
        'A 最小改动',
        '★ 有越界事实时审核**不能**出结论（判据级：scope_conformance 直接拒）',
        denyRes.ok !== true && hit(denyRes.error, '改动面超出了授权面'),
        `ok=${denyRes.ok}\n原文：\n${indent(denyRes.error ?? denyRes.summary ?? '')}`,
      )
      t2.scope_conformance = { ...t2.scope_conformance, within_scope: true, out_of_scope: [] }
    }

    // --- 状态查询把两面都摊开（主对话/审核不用自己比）---
    const st = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    rec.add(
      'A 最小改动',
      '正例：`pipeline_status` 同时给出**授权面 / 实际面 / 核对结果**（判据级，不用人比）',
      st.denied !== true &&
        Array.isArray(st.value?.change_scope) &&
        Array.isArray(st.value?.change_manifest) &&
        st.value?.scope_conformance !== undefined &&
        st.value?.scope_conformance !== null &&
        hit(st.text, '改动面（授权') &&
        hit(st.text, '全在授权面内'),
      `change_scope=${(st.value?.change_scope ?? []).length} 条｜change_manifest=${(st.value?.change_manifest ?? []).length} 条｜within=${st.value?.scope_conformance?.within_scope}\n${indent(String(st.text).split('\n').filter((l) => l.includes('改动面')).join('\n'))}`,
    )
  }

  // =========================================================================
  // B. 职责自限：分析与计划只干什么，不要多干
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId

    // 需求分析只能交 requirement_analysis，计划只能交 plan（分工不能互换）
    const orchPlan = await callTool(
      f.h,
      'pipeline_handoff',
      { task_id: T, kind: 'plan', role_token: f.tokens.orchestrator, payload: {} },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例① 需求分析交「计划」→ 拒（分配是计划 AI 的活，能力不给）', orchPlan, ['角色越权', 'planner'])

    const planAnalysis = await callTool(
      f.h,
      'pipeline_handoff',
      { task_id: T, kind: 'requirement_analysis', role_token: f.tokens.planner, payload: {} },
      f.agents.planner,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例② 计划 AI 交「需求分析结论」→ 拒（不改需求）', planAnalysis, ['角色越权', 'orchestrator'])

    const planArtifact = await callTool(
      f.h,
      'pipeline_artifact',
      { task_id: T, content: 'x', role_token: f.tokens.planner },
      f.agents.planner,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例③ 计划 AI 自己动手写制品 → 拒（它不执行任务）', planArtifact, ['角色越权', 'writer'])

    // 需求分析的产物里出现「分配内容」→ 拒
    const assign = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: T,
        kind: 'requirement_analysis',
        role_token: f.tokens.orchestrator,
        payload: {
          task_id: T,
          task_card: { goal: '加导出功能' },
          acceptance: ['导出可用'],
          test_points: ['正常路径'],
          boundaries: [],
          unclear_points: [],
          analysis_reason: '这次派 writer#1 做接口层、writer#2 做数据层，用 3 个独立对话就够了。',
          role_scope: { will_do: ['出需求结论'], will_not_do: ['不分配 AI'] },
        },
      },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例④ 需求分析的产物里出现「派谁 / 用几个 AI」→ 拒（那是计划的活）', assign, [
      '分配内容',
      '计划 AI',
    ])

    // 缺职责自限声明 → 拒；will_not_do 空 → 拒
    const noScope = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: T,
        kind: 'requirement_analysis',
        role_token: f.tokens.orchestrator,
        payload: {
          task_id: T,
          task_card: { goal: '加导出功能' },
          acceptance: ['导出可用'],
          test_points: ['正常路径'],
          boundaries: [],
          unclear_points: [],
          analysis_reason: '按用户原话拆解。',
        },
      },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例⑤ 缺 `role_scope`（职责自限声明）→ 拒', noScope, ['role_scope', '职责自限'])

    const vagueScope = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: T,
        kind: 'requirement_analysis',
        role_token: f.tokens.orchestrator,
        payload: {
          task_id: T,
          task_card: { goal: '加导出功能' },
          acceptance: ['导出可用'],
          test_points: ['正常路径'],
          boundaries: [],
          unclear_points: [],
          analysis_reason: '按用户原话拆解。',
          role_scope: { will_do: ['只做我该做的'], will_not_do: [] },
        },
      },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'B 职责自限', '★ 反例⑥ `will_not_do` 空 → 拒（含糊的"我只做我该做的"挡不住越界）', vagueScope, [
      'will_not_do',
      '我不做什么',
    ])

    // 正例：只写需求层的事 → 收下
    const cleanAnalysis = await callToolRaw(
      f.h,
      'pipeline_handoff',
      {
        task_id: T,
        kind: 'requirement_analysis',
        role_token: f.tokens.orchestrator,
        payload: {
          task_id: T,
          task_card: { goal: '加导出功能', in_scope: ['导出 CSV'], out_of_scope: ['不做定时导出'] },
          acceptance: ['导出可用'],
          test_points: ['正常路径'],
          boundaries: [],
          unclear_points: ['导出要不要带 BOM？'],
          analysis_reason: '按用户原话拆解；验收标准逐条可判定；未声明的事一律不做。',
          role_scope: { will_do: ['出需求结论', '列不清楚处'], will_not_do: ['不分配 AI、不定档、不读代码、不写实现'] },
        },
      },
      f.agents.orchestrator,
    )
    rec.add(
      'B 职责自限',
      '正例：需求分析只写需求层的事 + 带职责自限声明 → 内容判据通过',
      !hit(cleanAnalysis.text, '分配内容') && !hit(cleanAnalysis.text, '职责自限'),
      `layer=${cleanAnalysis.layer}\n${cleanAnalysis.text}`,
    )
  }

  // =========================================================================
  // B2. 角色边界卡：计划里写死，派活时按它派
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const t = f.h.store.peek(f.taskId)
    const cards = Array.isArray(t.role_boundaries) ? t.role_boundaries : []
    rec.add(
      'B 职责自限',
      '（夹具）计划里给每个执行角色都写了边界卡',
      cards.length >= t.roster.execution_roles.length &&
        t.roster.execution_roles.every((r) => cards.some((c) => c.role === r)),
      `执行角色=${t.roster.execution_roles.join('/')}\n边界卡=${cards.map((c) => c.role).join('/')}`,
    )
    for (const c of cards.slice(0, 2)) {
      rec.add(
        'B 职责自限',
        `边界卡 ${c.role}：only / not 两栏都有内容`,
        Array.isArray(c.only) && c.only.length > 0 && Array.isArray(c.not) && c.not.length > 0,
        `only=${JSON.stringify(c.only)}\nnot=${JSON.stringify(c.not)}`,
      )
    }

    // 派活时把边界卡贴在派活单上。
    // ⚠️ L1+ 的派活要先有需求档（"没有留档就不许开工"），所以这里照真实流程补一步：
    //    派留档 AI → 用它汇总出唯一的需求档。
    const dA = await callTool(f.h, 'pipeline_dispatch', { task_id: f.taskId, role: 'archivist', spawn: false, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, 'B 职责自限', '（前置）派出留档 AI（派活要先有需求档）', dA, ['已派出'])
    {
      const src = (f.h.store.peek(f.taskId).records ?? []).find((x) => x.role === 'planner')
      if (src === undefined) throw new Error('夹具问题：计划 AI 没有提交自己那份记录')
      const comp = await callTool(
        f.h,
        'pipeline_compile_requirement',
        {
          task_id: f.taskId,
          role_token: dA.value.token,
          entries: [
            { section: '需求原文', text: '给订单系统加导出：接口层、数据层、处理层三块并行推进。', source_record: src.record_id },
            { section: '验收标准', text: '1. 三层各自可用 2. 接口契约冻结 3. 审核通过', source_record: src.record_id },
          ],
        },
        dA.value.agent_id,
      )
      expectOk(rec, 'B 职责自限', '（前置）留档 AI 汇总出唯一的需求档', comp, ['需求档已汇总'])
    }

    const dW = await callTool(
      f.h,
      'pipeline_dispatch',
      { task_id: f.taskId, role: 'writer', seat: 'writer#1', spawn: false, role_token: f.tokens.main },
      f.agents.main,
    )
    rec.add(
      'B 职责自限',
      '★ 派活单里**带上该角色的边界卡**（"别让谁顺手多干"在开工前就写明）',
      hit(dW.text, '你的边界卡') && hit(dW.text, '只做') && hit(dW.text, '不做'),
      `layer=${dW.layer}\n${dW.text}`,
    )
  }

  // =========================================================================
  // C. ★ 授权面**锚点**：裸相对路径按"包根"解析，不按工作区根
  //
  //    现场（真单 T-20261011-214043，原文照抄）：
  //      「[pipeline] 拒绝：**改动面超出了授权面**（shell 旁路）。
  //        目标：~/.dsh/profiles/desktop/node_modules/dsh-pipeline/index.js
  //        本次授权改动面：· entry　modify　index.js …」
  //
  //    病根：授权面 20 条与三个编写席分区写的都是**包内相对路径**（`index.js`、
  //    `lib/tools.js`、`tests/`），而守门拿 `task.project_root`（工作区根）去拼 ⇒
  //    **条条落空**，三席写入全被拒（本单交付面 = 0，且守门那一席自己也在墙后面）。
  //
  //    反向缺口（同一处根因的另一半）：工作区根下**恰好同名**的
  //    `package.json` / `cordis.patch.yml` / `index.js` 会被**误放行** ——
  //    而后两份正是越界清单点名禁改的档。⇒「该拦的放行、该放的拦住」。
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)

    // 造**真单的形状**：工作区根之下有一个"插件包"，授权面写的是包内相对路径。
    const PKG_DIR = 'node_modules/dsh-pipeline'
    const pkgRoot = join(f.h.projectRoot, 'node_modules', 'dsh-pipeline')
    await mkdir(join(pkgRoot, 'lib', 'transport'), { recursive: true })
    await mkdir(join(pkgRoot, 'tests'), { recursive: true })

    // 真单的 20 条授权（原文照抄 task.json 的 change_scope）
    const REAL_SCOPE = [
      { id: 'entry', path: 'index.js', action: 'modify', why: '派活通道入口' },
      { id: 'transport', path: 'lib/transport/index.js', action: 'modify', why: '真实会话通道' },
      { id: 'client', path: 'lib/client.js', action: 'modify', why: '客户端槽位' },
      { id: 'hostmsg', path: 'lib/hostmsg.js', action: 'modify', why: '宿主消息' },
      { id: 'tokens', path: 'lib/tokens.js', action: 'modify', why: '令牌' },
      { id: 'liveness', path: 'lib/liveness.js', action: 'modify', why: '存活探测' },
      { id: 'tools', path: 'lib/tools.js', action: 'modify', why: '工具层' },
      { id: 'store', path: 'lib/store.js', action: 'modify', why: '状态存储' },
      { id: 'roles', path: 'lib/roles.js', action: 'modify', why: '角色表' },
      { id: 'config', path: 'lib/config.js', action: 'modify', why: '配置' },
      { id: 'tiers', path: 'lib/tiers.js', action: 'modify', why: '档位' },
      { id: 'guard', path: 'lib/guard.js', action: 'modify', why: '守门' },
      { id: 'boundaries', path: 'lib/boundaries.js', action: 'modify', why: '边界卡' },
      { id: 'modes', path: 'lib/modes.js', action: 'create', why: '内置模式' },
      { id: 'permissions', path: 'lib/permissions.js', action: 'create', why: '权限档' },
      { id: 'handoff', path: 'lib/handoff.js', action: 'modify', why: '交接物' },
      { id: 'states', path: 'lib/states.js', action: 'modify', why: '状态机' },
      { id: 'tests', path: 'tests/', action: 'create', why: '自测（目录级前缀覆盖）' },
      { id: 'pkg', path: 'package.json', action: 'modify', why: '插件包自带清单' },
      { id: 'pkgmount', path: 'cordis.patch.yml', action: 'modify', why: '插件包自带挂载声明档' },
    ]
    // 真单的三个编写席分区（原文照抄，同样是包内相对路径）
    const REAL_PARTS = [
      { seat: 'writer#1', role_id: 'writer', index: 1, total: 3, layer: 'channel', scope_paths: ['index.js', 'lib/transport/index.js', 'lib/client.js', 'lib/hostmsg.js', 'lib/tokens.js', 'lib/liveness.js'], deliverables: ['通道'] },
      { seat: 'writer#2', role_id: 'writer', index: 2, total: 3, layer: 'policy-modes', scope_paths: ['lib/tools.js', 'lib/store.js', 'lib/roles.js', 'lib/config.js', 'lib/tiers.js', 'lib/guard.js', 'lib/boundaries.js', 'lib/modes.js', 'lib/permissions.js'], deliverables: ['权限/模式'] },
      { seat: 'writer#3', role_id: 'writer', index: 3, total: 3, layer: 'supervisor', scope_paths: ['lib/states.js', 'lib/handoff.js'], deliverables: ['主管站'] },
    ]

    const t = f.h.store.peek(f.taskId)
    t.change_scope = REAL_SCOPE
    t.roster = { ...(t.roster ?? {}), writers: { count: 3, layers: ['channel', 'policy-modes', 'supervisor'], partitions: REAL_PARTS } }
    // ★ **显式的每任务锚点**：包根。正是它让"裸相对路径"有了唯一落点 ——
    //   不是从授权面自身推断出来的（那会让判定基准依赖被判定对象）。
    t.scope_anchor = pkgRoot
    f.h.indexTask(f.taskId, t)

    const anchored = f.h.taskIndex.get(f.taskId)
    rec.add(
      'C 授权面锚点',
      '★ 锚点进了同步索引，且 = 插件包根（不是工作区根）',
      anchored.scopeAnchor === pathKeyOf(pkgRoot) && anchored.scopeAnchor !== pathKeyOf(f.h.projectRoot),
      `scopeAnchor=${anchored.scopeAnchor}\nprojectRoot=${anchored.projectRoot}\n包根=${pathKeyOf(pkgRoot)}`,
    )

    // --- 正例：生效副本内那 20 条授权路径 ⇒ 允许 ---
    const W2 = f.agents['writer#2']
    const T2 = f.tokens['writer#2']
    const inside = await callTool(
      f.h,
      'write',
      { path: join(pkgRoot, 'lib', 'guard.js'), content: '// writer#2 的授权面之内\n', role_token: T2 },
      W2,
    )
    rec.add(
      'C 授权面锚点',
      '★★ 正例：包内 `lib/guard.js`（writer#2 分区 + 授权面之内）⇒ **允许**（修前这一条也是被拒的）',
      inside.denied !== true,
      `layer=${inside.layer}\n${inside.text}`,
    )

    // 包内 `index.js`（writer#1 的分区 + `entry` 授权）⇒ 也允许
    const insideEntry = await callTool(
      f.h,
      'write',
      { path: join(pkgRoot, 'index.js'), content: '// writer#1 的 entry 授权之内\n', role_token: f.tokens['writer#1'] },
      f.agents['writer#1'],
    )
    rec.add(
      'C 授权面锚点',
      '★★ 正例：包内 `index.js`（writer#1 的 `entry` 授权）⇒ **允许**',
      insideEntry.denied !== true,
      `layer=${insideEntry.layer}\n${insideEntry.text}`,
    )

    // 20 条逐条核对（走守门真正用的那个判据函数）
    const { owningChangeScopeEntry, resolveScopeAnchor } = await import('../lib/guard.js')
    const hitAt = (rel, anchor) => owningChangeScopeEntry(REAL_SCOPE, join(pkgRoot, rel), anchor)
    const covered = REAL_SCOPE.filter((e) => {
      const base = e.path.replace(/\/$/, '')
      return hitAt(e.path.endsWith('/') ? `${base}/x.mjs` : base, anchored.scopeAnchor) !== null
    })
    rec.add(
      'C 授权面锚点',
      '★★ 正例：**20 条授权全部命中**（含 `tests/` 目录级前缀覆盖）—— 病根"条条落空"已消除',
      covered.length === 20,
      `命中 ${covered.length}/20（锚点=${anchored.scopeAnchor}）\n` +
        `未命中：${REAL_SCOPE.filter((e) => !covered.includes(e)).map((e) => e.id).join('、') || '(无)'}\n` +
        `· tests/ 的目录前缀覆盖：${hitAt('tests/anchor-check.mjs', anchored.scopeAnchor)?.id ?? 'null'}\n` +
        `· 对照：同一个 tests/anchor-check.mjs 按工作区根解析 ⇒ ${owningChangeScopeEntry(REAL_SCOPE, join(f.h.projectRoot, 'tests/anchor-check.mjs'), f.h.projectRoot)?.id ?? 'null'}`,
    )

    // --- 反例①：工作区根下的同名文件 ⇒ 拒（这正是"反向缺口"） ---
    //
    //   两面证据都给：① 判据级 —— 裸 `package.json` **不再**匹配工作区根那份；
    //                ② 守门级 —— 真的被拒（分层不保证是 scope 那条，见下面的说明）。
    const decoys = [
      ['package.json', '越界清单点名禁改的工作区根编排配置'],
      ['cordis.patch.yml', '越界清单点名禁改的工作区根编排配置'],
      ['index.js', '工作区根下的同名件'],
    ]
    for (const [rel, why] of decoys) {
      const abs = join(f.h.projectRoot, rel)
      await writeFile(abs, '// 工作区根下的同名件（不该被授权面命中）\n', 'utf8')
      const w1 = await callTool(
        f.h,
        'write',
        { path: abs, content: '// 越界\n', role_token: f.tokens['writer#1'] },
        f.agents['writer#1'],
      )
      const notMatched = owningChangeScopeEntry(REAL_SCOPE, abs, anchored.scopeAnchor) === null
      const pkgMatched = hitAt(rel, anchored.scopeAnchor)
      rec.add(
        'C 授权面锚点',
        `★★ 反例①：工作区根 ${rel} ⇒ 拒（${why}）`,
        w1.denied === true && w1.layer !== 'missing' && notMatched,
        `守门：denied=${w1.denied} layer=${w1.layer}\n` +
          `★ 判据级：裸「${rel}」在工作区根下 **不命中**任何授权 ⇒ ${notMatched ? 'null ✓（反向缺口已堵）' : '命中 ✗（仍在误放行！）'}\n` +
          `★ 同一个裸路径按包根解析 ⇒ 命中「${pkgMatched?.id ?? 'null'}」（这才是它该落的地方）\n` +
          `拒绝原文：\n${indent(w1.text.slice(0, 400))}`,
      )
    }

    // --- 反例②：包外任意路径 + 既有越界动作 ⇒ 仍拒（一条都不许回退） ---
    const outside = await callTool(
      f.h,
      'write',
      { path: join(f.h.projectRoot, 'src', 'interface', 'outside.js'), content: '// 包外\n', role_token: f.tokens['writer#1'] },
      f.agents['writer#1'],
    )
    rec.add(
      'C 授权面锚点',
      '★★ 反例②：包外路径（工作区根 src/…）⇒ 仍拒',
      outside.denied === true && outside.layer !== 'missing',
      `layer=${outside.layer}\n${indent(outside.text)}`,
    )

    // 包内、但**不在任何席位分区**里的路径 ⇒ 仍拒（分区判据不许回退）
    const noSeat = await callTool(
      f.h,
      'write',
      { path: join(pkgRoot, 'lib', 'nobody.js'), content: '// 无主\n', role_token: T2 },
      W2,
    )
    expectDenied(rec, 'C 授权面锚点', '★★ 反例②：包内但不在任何席位分区（lib/nobody.js）⇒ 仍拒', noSeat, ['分区'])

    // 跨席位：writer#2 去写 writer#1 的分区 ⇒ 仍拒
    const crossSeat = await callTool(
      f.h,
      'write',
      { path: join(pkgRoot, 'lib', 'transport', 'index.js'), content: '// 越席\n', role_token: T2 },
      W2,
    )
    expectDenied(rec, 'C 授权面锚点', '★★ 反例②：跨席位写（writer#2 → writer#1 的 lib/transport/）⇒ 仍拒', crossSeat, ['分区'])

    // --- 反例③：其它任务的授权面不受本任务锚点影响 ---
    //
    //   造第二个任务：换个锚点（工作区根），授权面只写 `package.json`。
    //   它**必须**只认工作区根那份，而**不能**借到本任务锚点下那份。
    {
      const other = await f.h.store.open({
        actorRole: 'main',
        requirement: '另一张单：只授权工作区根的 package.json（与上一单锚点不同）。',
        id: 'T-ANCHOR-OTHER',
      })
      const ot = f.h.store.peek('T-ANCHOR-OTHER')
      ot.project_root = f.h.projectRoot
      ot.change_scope = [{ id: 'ws-pkg', path: 'package.json', action: 'modify', why: '夹具：另一张单自己的授权' }]
      ot.scope_anchor = f.h.projectRoot // ← 与上一单**不同**的锚点
      f.h.indexTask('T-ANCHOR-OTHER', ot)
      const otherEntry = f.h.taskIndex.get('T-ANCHOR-OTHER')
      rec.add(
        'C 授权面锚点',
        '★★ 反例③：另一个任务有自己的锚点，两单的 scopeAnchor **互不相同**',
        otherEntry.scopeAnchor === pathKeyOf(f.h.projectRoot) && otherEntry.scopeAnchor !== anchored.scopeAnchor,
        `本单锚点=${anchored.scopeAnchor}\n另一单锚点=${otherEntry.scopeAnchor}\nopen.ok=${other.ok === true}`,
      )
      // ★ 判据：两单的锚点**各自生效、互不串味**。
      //
      //   本单（锚点 = 包根）：授权面里的 `index.js` 落在 `<包根>/index.js`。
      //   另一单（锚点 = 工作区根）：授权面里的 `package.json` 落在 `<工作区根>/package.json`。
      //   四条断言把"串味"的两个方向都钉住。
      const wsPkg = join(f.h.projectRoot, 'package.json')
      const pkgPkg = join(pkgRoot, 'package.json')
      const checks = [
        ['本单锚点下：<工作区根>/package.json 不命中本单授权面（反向缺口）', owningChangeScopeEntry(REAL_SCOPE, wsPkg, anchored.scopeAnchor) === null],
        ['本单锚点下：<包根>/package.json 命中本单授权面（id=pkg）', owningChangeScopeEntry(REAL_SCOPE, pkgPkg, anchored.scopeAnchor)?.id === 'pkg'],
        ['另一单锚点下：<工作区根>/package.json 命中它自己的授权面（id=ws-pkg）', owningChangeScopeEntry(ot.change_scope, wsPkg, otherEntry.scopeAnchor)?.id === 'ws-pkg'],
        ['另一单锚点下：<包根>/package.json **不**被它顺带授权', owningChangeScopeEntry(ot.change_scope, pkgPkg, otherEntry.scopeAnchor) === null],
      ]
      rec.add(
        'C 授权面锚点',
        '★★ 反例③：两单的授权面**按各自的锚点**判定，互不串味（四条同时成立）',
        checks.every(([, ok]) => ok),
        checks.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`).join('\n'),
      )
    }

    // --- store 侧（改动面审计）用的是同一个锚点：不该只有守门一侧修好 ---
    //
    //   ⚠️ 自测里的 `write` 是**替身、不落盘**（见上面 A 段那条注释），所以这里必须
    //      用**真的** fs 落盘，否则审计看不到"包内那份改动"，断言就是假绿。
    {
      await writeFile(join(pkgRoot, 'lib', 'guard.js'), '// 真的落盘：包内授权面之内的一处改动\n', 'utf8')
      const audit = await f.h.store.changeAudit({ taskId: f.taskId })
      const unauthPaths = (audit.unauthorized ?? []).map((x) => x.path)
      const changed = [...(audit.added ?? []), ...(audit.modified ?? [])].map((x) => x.path)
      const pkgRel = `${PKG_DIR.replace(/\\/g, '/')}/`
      const inPkg = changed.filter((p) => p.startsWith(pkgRel))
      rec.add(
        'C 授权面锚点',
        '★ 改动面审计（store 侧）与守门**同一个锚点**：包内改动认得出来、工作区根那三份算越界',
        audit.ok === true &&
          inPkg.includes(`${pkgRel}lib/guard.js`) &&
          unauthPaths.every((p) => !p.startsWith(pkgRel)) &&
          decoys.every(([rel]) => unauthPaths.includes(rel)),
        `verdict=${audit.verdict}\n` +
          `包内改动（**认得出来**，修前会全被判越界）：${inPkg.join('、') || '(无)'}\n` +
          `判为越界的路径（**正是工作区根那三份**）：${unauthPaths.join('、') || '(无)'}`,
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
  lines.push('dsh-pipeline 最小改动（改动面=授权面）+ 职责自限 自测')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：修一个 bug 就别该整个模块，分析和计划 ai 确认他们只干什么，不要多干。')
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

  const { disposeHarness } = await import('./selftest-core.mjs')
  for (const h of open) {
    try {
      await disposeHarness(h)
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑：`node tests/scope-check.mjs`
if (process.argv[1] !== undefined && /scope-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runScopeCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
