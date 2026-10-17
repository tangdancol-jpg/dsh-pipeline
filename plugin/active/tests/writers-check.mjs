/**
 * dsh-pipeline · 编写分工（1~3 席位）与架构图角色自测
 * ============================================================================
 *     node tests/writers-check.mjs
 *
 * 验两件事：
 *   A. 「编写」可以被编排拆成 1~3 个席位，各写一段、各交一份、全到齐才推进
 *   B. 「架构图」是编写**之后**的交付物，且必须带回执（走没走过 diagram_deliver 要能分辨）
 *
 * 关键约束：count=1 **必须**是同一套机制的退化情形 —— 本文件的正例①就是既有 happy path。
 *
 * @module dsh-pipeline/tests/writers-check
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool, auditFor, cleanSecurity, createHarness, manifestFor, runAnalysisThenPlan, runHappyPath, fileSha256 } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与其它套一致的形状）
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
// 建一个 L2 三分工的任务
// ---------------------------------------------------------------------------

const PARTITIONS = [
  { seat: 'writer#1', layer: 'interface', scope_paths: ['src/web'], interface_owner: 'writer#1', deliverables: ['前端页面'] },
  { seat: 'writer#2', layer: 'data', scope_paths: ['src/api'], interface_owner: 'writer#1', deliverables: ['后端接口'] },
  { seat: 'writer#3', layer: 'logic', scope_paths: ['docs'], interface_owner: 'writer#1', deliverables: ['文档'] },
]

/** 席位数 = 层数：取前 count 条分区对应的层清单。 */
const layersFor = (count) => PARTITIONS.slice(0, count).map((p) => p.layer)

/**
 * 建一个 L2 + 3 席位的任务，停在各席位都能写代码的状态（developing）。
 *
 * @param {object} [opts]
 * @param {number} [opts.writers] - 席位数（1~3）
 */
export async function createMultiWriterFixture(opts = {}) {
  const count = Number.isInteger(opts.writers) ? opts.writers : 3
  const h = await createHarness()
  const MAIN = 'writers-check-main'

  // 开单 → 主对话令牌
  const opened = await callTool(h, 'pipeline_task_open', { requirement: '给订单系统加导出功能：前端页面、后端接口、使用文档。', deliverable_format: '补丁 + 变更说明 + 可运行命令' }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const T = opened.value.task_id
  const agents = { main: MAIN }
  const tokens = { main: opened.value.role_token }

  // ★ 本轮起：需求分析 → **用户人工确认** → 计划（自检 + 分配）。
  //   角色清单（tier / 席位 / 层）**由计划 AI 产出**，不再是需求分析的活。
  const planned = await runAnalysisThenPlan(h, {
    taskId: T,
    tokens,
    agents,
    tier: opts.tier ?? 'L2',
    reason: '跨前端/后端/文档三块，接口已冻结，可并行',
    writers: {
      layers: layersFor(count),
      partitions: PARTITIONS.slice(0, count),
      reason: count > 1 ? '接口契约已冻结，三块互不相干，可并行推进' : '单块改动，一个席位足够',
    },
    ...(opts.relayPolicy === undefined ? {} : { relayPolicy: opts.relayPolicy }),
  })
  const orch = planned.plan
  if (orch.denied) throw new Error(`计划/分配失败：\n${orch.text}`)

  // 派活
  // ★ 更正 A：先把**留档 AI** 派出来，让它用计划 AI 那份记录汇总出唯一的需求档。
  //   没有档之前，其它角色的派活会被"没有留档就不许开工"拦住 —— 这是有意的。
  const dArch = await callTool(h, 'pipeline_dispatch', { task_id: T, role: 'archivist', spawn: false, role_token: tokens.main }, MAIN)
  if (dArch.denied) throw new Error(`派 archivist 失败：\n${dArch.text}`)
  agents.archivist = dArch.value?.agent_id ?? 'manual-archivist'
  tokens.archivist = dArch.value?.token ?? ''
  {
    const srcOrch = (h.store.peek(T).records ?? []).find((x) => x.role === 'planner')
    if (srcOrch === undefined) throw new Error('夹具问题：计划 AI 没有提交自己那份记录')
    const comp = await callTool(
      h,
      'pipeline_compile_requirement',
      {
        task_id: T,
        role_token: tokens.archivist,
        entries: [
          { section: '需求原文', text: '给订单系统加导出功能：前端页面、后端接口、使用文档。', source_record: srcOrch.record_id },
          { section: '验收标准', text: '1. 导出可用\n2. 前后端联通\n3. 文档齐', source_record: srcOrch.record_id },
        ],
      },
      agents.archivist,
    )
    if (comp.denied) throw new Error(`留档汇总失败：\n${comp.text}`)
  }

  for (const r of ['architect', 'diagrammer']) {
    const d = await callTool(h, 'pipeline_dispatch', { task_id: T, role: r, spawn: false, role_token: tokens.main }, MAIN)
    if (d.denied) throw new Error(`派 ${r} 失败：\n${d.text}`)
    agents[r] = d.value?.agent_id ?? `manual-${r}`
    tokens[r] = d.value?.token ?? ''
  }
  const seats = PARTITIONS.slice(0, count).map((p) => p.seat)
  for (const seat of seats) {
    const d = await callTool(h, 'pipeline_dispatch', { task_id: T, role: 'writer', seat, spawn: false, role_token: tokens.main }, MAIN)
    if (d.denied) throw new Error(`派 ${seat} 失败：\n${d.text}`)
    agents[seat] = d.value?.agent_id ?? `manual-${seat}`
    tokens[seat] = d.value?.token ?? ''
  }
  // 编写席位还没动手，状态要先进「开发中」：第一个席位派出去时已经推进；
  // 单席位时同理。这里确认一下，不然 dev_to_test 会被状态闸拦。
  const st = h.store.peek(T)?.state
  if (st !== 'developing') throw new Error(`夹具问题：派出编写后状态应为 developing，实际 ${st}`)

  for (const r of ['tester', 'reviewer']) {
    const d = await callTool(h, 'pipeline_dispatch', { task_id: T, role: r, spawn: false, role_token: tokens.main }, MAIN)
    if (d.denied) throw new Error(`派 ${r} 失败：\n${d.text}`)
    agents[r] = d.value?.agent_id ?? `manual-${r}`
    tokens[r] = d.value?.token ?? ''
  }

  return { h, taskId: T, agents, tokens, seats, orch, count, projectRoot: h.projectRoot }
}

/** 让某个席位登记一个制品。 */
async function seatArtifact(fx, seat, content) {
  const r = await callTool(
    fx.h,
    'pipeline_artifact',
    { task_id: fx.taskId, content, file_name: `${seat.replace('#', '-')}.txt`, note: `${seat} 的产物`, role_token: fx.tokens[seat] },
    fx.agents[seat],
  )
  return r
}

/** 让某个席位交一份带分区元数据的 dev_to_test。 */
async function seatSubmit(fx, seat, version, over = {}) {
  const idx = fx.seats.indexOf(seat) + 1
  return callTool(
    fx.h,
    'pipeline_handoff',
    {
      task_id: fx.taskId,
      kind: 'dev_to_test',
      role_token: fx.tokens[seat],
      payload: {
        task_id: fx.taskId,
        artifact_version: version,
        patch_or_code: `（${seat} 的改动）`,
        change_note: `${seat} 完成了它那一段`,
        run_commands: [`node tests/${seat.replace('#', '-')}.mjs`],
        selftest_result: 'pass',
        known_issues: [],
        partition: { seat, index: idx, total: fx.seats.length, scope_paths: PARTITIONS[idx - 1].scope_paths },
        // ★ 最小改动：有授权面的任务必须交「实际改动面」，每条引用一个授权条目
        ...manifestFor(fx.h.store, fx.taskId, { index: idx - 1, path: PARTITIONS[idx - 1].scope_paths[0] }),
        ...over,
      },
    },
    fx.agents[seat],
  )
}

/**
 * 走完 测试 → 审核，把任务推到 passed。**每一步的结果都返回**，
 * 这样调用方既能断言、也能在第一处失败时看清是哪一步。
 */
async function advanceToPassed(fx, cur) {
  const out = []
  const dT = await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'tester', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
  out.push(['派测试', dT])
  const t2r = await callTool(
    fx.h,
    'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'test_to_review', role_token: fx.tokens.tester,
      payload: {
        task_id: fx.taskId, artifact_version: cur,
        test_cases: ['三块各自可用', '接缝处一致'], execution_result: '2/2 通过',
        failure_logs: [], pass_evidence: ['三个分区的自测都跑了'], risk_notes: [], verdict: 'pass',
      },
    },
    fx.agents.tester,
  )
  out.push(['测试通过（交审核）', t2r])
  const dR = await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'reviewer', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
  out.push(['派审核', dR])
  const ok = await callTool(
    fx.h,
    'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'review_verdict', role_token: fx.tokens.reviewer,
      payload: {
        task_id: fx.taskId, artifact_version: cur, conclusion: 'OK',
        checklist: ['分区报告齐', '接缝一致'], findings: [], residual_risk: [], risk_notes: [], artifact_digest: 'x',
        security: cleanSecurity(),
        release_approved: true, final_delivery_note: '三席位交付齐全，架构图已交',
        // ★ 前后版本对比结论：有基线时必填，且 store 会自己重算核对
        ...(await auditFor(fx.h, fx.taskId)),
      },
    },
    fx.agents.reviewer,
  )
  out.push(['审核 OK', ok])
  return out
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runWritersCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例①：count=1 —— **同一套机制的退化情形**（也就是既有 happy path）
  // =========================================================================
  {
    const f = await runHappyPath({ stopAfter: 9 })
    open.push(f.harness)
    const task = await f.harness.store.get(f.taskId)
    const w = task.roster?.writers
    rec.add('正例① count=1：清单里仍然有 writers（不是"单编写模式"的特殊分支）',
      w?.count === 1 && w.partitions.length === 1 && w.partitions[0].seat === 'writer#1',
      `writers = ${JSON.stringify(w)}`)
    rec.add('正例① count=1：唯一席位的范围是整棵项目根，且它确实交过',
      w.partitions[0].scope_paths.includes('.') && task.writer_submissions['writer#1'] !== undefined,
      `scope_paths=${JSON.stringify(w.partitions[0].scope_paths)}  writer_submissions=${JSON.stringify(Object.keys(task.writer_submissions))}`)
    rec.add('正例① count=1：全流程照旧走完（关单成功）', f.state === 'closed', `最终状态 = ${f.state}`)
  }

  // =========================================================================
  // 正例②：count=3 分工 → 三份到齐 → 推进 → 交图 → 测试 → 审核 → 关单
  // =========================================================================
  let fx = null
  try {
    fx = await createMultiWriterFixture({ writers: 3 })
    open.push(fx.h)
    rec.add('正例② 夹具：3 个席位各持独立令牌与独立会话',
      new Set(fx.seats.map((s) => fx.agents[s])).size === 3 && new Set(fx.seats.map((s) => fx.tokens[s])).size === 3,
      `seats=${fx.seats.join(', ')}\nagents=${fx.seats.map((s) => `${s}=${fx.agents[s]}`).join('  ')}`)
    expectOk(rec, '正例② 编排给出了 3 席位的分区方案（带 reason）', fx.orch, ['编写席位：3 个', 'writer#1', 'writer#3', '可并行推进'])

    const versions = {}
    for (const seat of fx.seats) {
      const a = await seatArtifact(fx, seat, `${seat} 的代码\n`)
      expectOk(rec, `正例② ${seat} 登记自己的制品`, a, ['v'])
      versions[seat] = a.value?.version ?? ''
    }

    // --- 交前两份：状态**不动** ------------------------------------------
    const r1 = await seatSubmit(fx, 'writer#1', versions['writer#1'])
    expectOk(rec, '正例② writer#1 交第一份（席位 1/3）', r1, ['1/3', '还差'])
    let st = await fx.h.store.get(fx.taskId)
    rec.add('正例② 交第一份之后状态**不动**（仍在开发中）—— 先干完的先交，不会被退回去',
      st.state === 'developing', `state=${st.state}`)

    const r2 = await seatSubmit(fx, 'writer#2', versions['writer#2'])
    expectOk(rec, '正例② writer#2 交第二份（席位 2/3）', r2, ['2/3', '还差'])
    st = await fx.h.store.get(fx.taskId)
    rec.add('正例② 交第二份之后状态仍**不动**', st.state === 'developing', `state=${st.state}`)

    // --- 交第三份：自动推进 ----------------------------------------------
    const r3 = await seatSubmit(fx, 'writer#3', versions['writer#3'])
    expectOk(rec, '正例② writer#3 交第三份 → 全部到齐 → 自动推进到「待测试」', r3, ['3/3', '待测试'])
    st = await fx.h.store.get(fx.taskId)
    rec.add('正例② 状态推进到 ready_test，三份提交都有据可查',
      st.state === 'ready_test' && Object.keys(st.writer_submissions).length === 3,
      `state=${st.state}\nwriter_submissions = ${JSON.stringify(st.writer_submissions, null, 2)}`)

    const seatAudit = (await fx.h.store.auditLog(fx.taskId)).filter((a) => a.action === 'seat:submit')
    rec.add('正例② 每次席位提交都留了痕（seat:submit，含 done/total）',
      seatAudit.length === 3 && seatAudit.every((a) => typeof a.seat === 'string' && typeof a.total === 'number'),
      `seat:submit 审计行：\n${indent(JSON.stringify(seatAudit, null, 2))}`)

    // --- 反例④ 在这里顺势测：架构图角色此时可以交图了 ---------------------
    const dir = join(fx.projectRoot, '.pipeline', fx.taskId, 'reports')
    await mkdir(dir, { recursive: true })
    const htmlPath = join(dir, 'architecture.html')
    const receiptPath = join(dir, 'architecture.receipt.json')
    await writeFile(htmlPath, '<html>架构图</html>', 'utf8')
    await writeFile(receiptPath, JSON.stringify({ receipt_id: 'R-1', html_sha256: 'x' }), 'utf8')

    const dg = await callTool(
      fx.h,
      'pipeline_handoff',
      {
        task_id: fx.taskId,
        kind: 'architecture_diagram',
        role_token: fx.tokens.diagrammer,
        payload: {
          task_id: fx.taskId,
          based_on_artifact_version: versions['writer#3'],
          diagram_path: htmlPath,
          html_sha256: fileSha256(htmlPath),
          produced_by: 'diagram_deliver',
          receipt_path: receiptPath,
          receipt_id: 'R-1',
          covered_modules: ['web.ui', 'api.order', 'docs.guide'],
          degraded: false,
          notes: ['覆盖三个分区'],
        },
      },
      fx.agents.diagrammer,
    )
    expectOk(rec, '正例② 架构图角色交图（走 diagram_deliver，带收据）', dg, ['架构图交付', '架构图 → main|reviewer'])

    // --- 继续：测试 → 审核 → 关单 ----------------------------------------
    const cur = (await fx.h.store.status({ taskId: fx.taskId })).artifact_version
    const steps = await advanceToPassed(fx, cur)
    for (const [n, r] of steps) expectOk(rec, `正例② ${n}`, r, [])

    const closed = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '三席位交付 + 架构图齐全' }, fx.agents.main)
    expectOk(rec, '正例② 关单成功（角色清单含架构图角色 ⇒ 关单会查图）', closed, ['已关闭|关闭'])
    rec.add('正例② 全程收束：closed', (await fx.h.store.get(fx.taskId)).state === 'closed', 'state = closed')
  } catch (e) {
    rec.add('正例② 夹具/流程', false, `抛错：${e?.message ?? e}`)
  }

  // =========================================================================
  // 反例①：writer#k 越界写别人的分区
  // =========================================================================
  {
    // 必须用**还活着**的任务：正例② 那个 fx 到这里已经关单，关单会回收令牌，
    // 那时守门根本不会认身份，测出来的"放行"是假绿。
    const g = await createMultiWriterFixture({ writers: 3 })
    open.push(g.h)
    const out = await callTool(g.h, 'write', { file_path: join(g.projectRoot, 'src', 'web', 'steal.js'), content: 'x' }, g.agents['writer#2'])
    expectDenied(rec, '反例① writer#2 往 writer#1 的 src/web 里写', out, ['越界写入别人的分区', '该路径属于：writer#1', 'src/web'])

    const outside = await callTool(g.h, 'write', { file_path: join(g.projectRoot, 'scripts', 'x.sh'), content: 'x' }, g.agents['writer#1'])
    expectDenied(rec, '反例① writer#1 往**分区之外**（scripts/）写', outside, ['不在任何编写席位的分区里', '在册分区'])

    const own = await callTool(g.h, 'write', { file_path: join(g.projectRoot, 'src', 'web', 'ok.js'), content: 'x' }, g.agents['writer#1'])
    rec.add('反例① 对照：writer#1 写自己的 src/web 是**放行**的（守门不是一刀切）',
      own.denied !== true && own.layer !== 'guard', `layer=${own.layer}\n${indent(own.text)}`)
  }

  // =========================================================================
  // 反例②：席位不匹配的令牌
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 3 })
    open.push(g.h)
    const swappedPayload = {
      task_id: g.taskId, artifact_version: 'v1',
      patch_or_code: 'x', change_note: 'x', run_commands: ['x'], selftest_result: 'x', known_issues: [],
      partition: { seat: 'writer#2', index: 2, total: 3, scope_paths: ['src/api'] },
    }
    const swapped = await callTool(
      g.h,
      'pipeline_handoff',
      { task_id: g.taskId, kind: 'dev_to_test', role_token: g.tokens['writer#1'], payload: swappedPayload },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例② 拿 writer#1 的令牌去交 writer#2 的分区', swapped, ['席位不匹配', 'writer#1', 'writer#2', '只能提交自己那一份'])

    const rawSwap = await callToolRaw(
      g.h,
      'pipeline_handoff',
      { task_id: g.taskId, kind: 'dev_to_test', role_token: g.tokens['writer#1'], payload: swappedPayload },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例②′ 绕过守门直接打 execute：席位不匹配仍然被拒（第二道闸）', rawSwap, ['席位不匹配', '只能提交自己那一份'])
  }

  // =========================================================================
  // 反例③：未到齐就推进
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 3 })
    open.push(g.h)
    const v = {}
    for (const seat of g.seats) {
      const a = await seatArtifact(g, seat, `${seat}\n`)
      v[seat] = a.value?.version ?? 'v1'
    }
    await seatSubmit(g, 'writer#1', v['writer#1'])
    await seatSubmit(g, 'writer#2', v['writer#2'])
    // 只交了 2 份，硬推
    // 直接打 store 层的迁移 —— 验的是"全部到齐"那条判据本身
    // （走 pipeline_transition 会先被角色白名单拦掉，测不到这条）
    const push = await g.h.store.transition({ taskId: g.taskId, event: 'dev_submitted', actorRole: 'writer' })
    expectDenied(rec, '反例③ 3 个席位只交 2 份就硬推「待测试」', { denied: push.ok !== true, layer: 'execute', text: String(push.error ?? '') }, [
      '席位未到齐', '还差 1 个', 'writer#3', '全部席位各交一份',
    ])
    const st = await g.h.store.get(g.taskId)
    rec.add('反例③ 任务仍在开发中，没有被推过去', st.state === 'developing', `state=${st.state}`)

    // ★ 主对话代发（main_dev_submitted）：守卫与 dev_submitted 同源 ⇒ 没到齐同样推不动
    const proxy = await g.h.store.transition({ taskId: g.taskId, event: 'main_dev_submitted', actorRole: 'main' })
    expectDenied(rec, '反例③′ 主对话代发也绕不过「全部到齐」（守卫同源）', { denied: proxy.ok !== true, layer: 'execute', text: String(proxy.error ?? '') }, [
      '席位未到齐', '还差 1 个', 'writer#3',
    ])
    const wrongActor = await g.h.store.transition({ taskId: g.taskId, event: 'main_dev_submitted', actorRole: 'writer' })
    rec.add('反例③″ 代发事件只认主对话：编写发 main_dev_submitted ⇒ 拒', wrongActor.ok !== true, String(wrongActor.error ?? '').split('\n')[0])
    const mainAsWriter = await g.h.store.transition({ taskId: g.taskId, event: 'dev_submitted', actorRole: 'main' })
    rec.add('反例③‴ 主对话不能冒用编写那条原事件 dev_submitted', mainAsWriter.ok !== true, String(mainAsWriter.error ?? '').split('\n')[0])
  }

  // =========================================================================
  // 正例：全部到齐但"出口没人按"（P1-13 的现场形状）⇒ 主对话代发成功，且留痕可区分
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 3 })
    open.push(g.h)
    const v = {}
    for (const seat of g.seats) {
      const a = await seatArtifact(g, seat, `${seat}\n`)
      v[seat] = a.value?.version ?? 'v1'
    }
    for (const seat of g.seats) await seatSubmit(g, seat, v[seat])
    // 复现现场：三份都交了，但那一步没推过去（任务停在「开发中」）
    const file = join(g.projectRoot, '.pipeline', g.taskId, 'task.json')
    const t = JSON.parse(await readFile(file, 'utf8'))
    t.state = 'developing'
    await writeFile(file, JSON.stringify(t, null, 2), 'utf8')
    g.h.store.dropCache(g.taskId)
    const pushed = await callTool(g.h, 'pipeline_transition', { task_id: g.taskId, event: 'main_dev_submitted', role_token: g.tokens.main }, g.agents.main)
    const after = await g.h.store.get(g.taskId)
    rec.add('正例 全部到齐 + 出口没人按 ⇒ 主对话代发 main_dev_submitted ⇒ 进「待测试」', pushed.denied !== true && after.state === 'ready_test', `state=${after.state}\n${String(pushed.text ?? '').slice(0, 300)}`)
    const last = after.history.at(-1)
    rec.add('正例 留痕可区分：最后一条历史记的是 main 发的 main_dev_submitted', String(last?.action ?? '').includes('main_dev_submitted') && last?.actor === 'main', JSON.stringify(last))
  }

  // =========================================================================
  // 反例④：架构图角色在编写完成前交图
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    // 此刻 state=developing，还没有任何 dev_to_test
    const dir = join(g.projectRoot, '.pipeline', g.taskId, 'reports')
    await mkdir(dir, { recursive: true })
    const html = join(dir, 'early.html')
    const rc = join(dir, 'early.receipt.json')
    await writeFile(html, '<html>early</html>', 'utf8')
    await writeFile(rc, '{}', 'utf8')

    const early = await callTool(
      g.h,
      'pipeline_handoff',
      {
        task_id: g.taskId,
        kind: 'architecture_diagram',
        role_token: g.tokens.diagrammer,
        payload: {
          task_id: g.taskId, based_on_artifact_version: 'v1', diagram_path: html, html_sha256: fileSha256(html),
          produced_by: 'diagram_deliver', receipt_path: rc, covered_modules: ['x'], degraded: false,
        },
      },
      g.agents.diagrammer,
    )
    expectDenied(rec, '反例④ 编写还没交（state=developing）就交架构图', early, ['跳步', '编写完成之后', '开发中'])
  }

  // =========================================================================
  // 反例⑤：主对话自行决定 writers.count / 自行加席位
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)

    // (a) 主对话自己调编排
    const mainOrch = await callTool(
      g.h,
      'pipeline_orchestrate',
      { task_id: g.taskId, tier: 'L2', reason: '我自己决定分 3 个', writers: { count: 3, partitions: PARTITIONS, reason: '我定的' }, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, '反例⑤a 主对话自己调 pipeline_orchestrate 决定分几个', mainOrch, ['主对话不能自己产出角色清单', '不自行判断要几个 AI'])
    const rawOrch = await callToolRaw(
      g.h,
      'pipeline_orchestrate',
      { task_id: g.taskId, tier: 'L2', reason: '我自己决定分 3 个', writers: { count: 3, partitions: PARTITIONS, reason: '我定的' }, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, '反例⑤a′ 绕过守门直接打 execute：主对话编排仍被拒（第二道闸）', rawOrch, ['主对话', '计划分配'])

    // (b) 主对话自行加一个不在册的席位
    const extraSeat = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'writer', seat: 'writer#2', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '反例⑤b 主对话派一个不在册的席位（自行加席位）', extraSeat, ['不在本任务在册的编写席位', 'writer#1', '不能自行加席位'])

    // (c) 超本档上限
    const g2 = await createMultiWriterFixture({ writers: 1 })
    open.push(g2.h)
    const over = await callTool(
      g2.h,
      'pipeline_handoff',
      {
        task_id: g2.taskId, kind: 'dev_to_test', role_token: g2.tokens['writer#1'],
        payload: {
          task_id: g2.taskId, artifact_version: 'v1', patch_or_code: 'x', change_note: 'x',
          run_commands: ['x'], selftest_result: 'x', known_issues: [],
          partition: { seat: 'writer#2', index: 2, total: 2, scope_paths: ['src/api'] },
        },
      },
      g2.agents['writer#1'],
    )
    expectDenied(rec, '反例⑤c 声明一个计划没批的席位（在册只有 writer#1）', over, ['不在本任务的在册编写席位', 'roster_request', '计划分配'])
  }

  // =========================================================================
  // 架构图的回执闸（降级路径 + 假收据）
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const a = await seatArtifact(g, 'writer#1', 'code\n')
    await seatSubmit(g, 'writer#1', a.value?.version ?? 'v1')
    const dir = join(g.projectRoot, '.pipeline', g.taskId, 'reports')
    await mkdir(dir, { recursive: true })
    const html = join(dir, 'd.html')
    await writeFile(html, '<html>d</html>', 'utf8')

    const fakeReceipt = await callTool(
      g.h, 'pipeline_handoff',
      {
        task_id: g.taskId, kind: 'architecture_diagram', role_token: g.tokens.diagrammer,
        payload: {
          task_id: g.taskId, based_on_artifact_version: 'v1', diagram_path: html, html_sha256: fileSha256(html),
          produced_by: 'diagram_deliver', receipt_path: join(dir, 'nope.json'),
          covered_modules: ['x'], degraded: false,
        },
      },
      g.agents.diagrammer,
    )
    expectDenied(rec, '反例⑥ 声称走过 diagram_deliver，但收据文件不存在', fakeReceipt, ['收据文件不存在', '交付收据', 'self-provided'])

    const noDegrade = await callTool(
      g.h, 'pipeline_handoff',
      {
        task_id: g.taskId, kind: 'architecture_diagram', role_token: g.tokens.diagrammer,
        payload: {
          task_id: g.taskId, based_on_artifact_version: 'v1', diagram_path: html, html_sha256: fileSha256(html),
          produced_by: 'self-provided', covered_modules: ['x'], degraded: false,
        },
      },
      g.agents.diagrammer,
    )
    expectDenied(rec, '反例⑦ 自备产物却不标 degraded（想蒙混过关）', noDegrade, ['degraded 必须是 true', '明确标出来'])

    const degradedOk = await callTool(
      g.h, 'pipeline_handoff',
      {
        task_id: g.taskId, kind: 'architecture_diagram', role_token: g.tokens.diagrammer,
        payload: {
          task_id: g.taskId, based_on_artifact_version: 'v1', diagram_path: html, html_sha256: fileSha256(html),
          produced_by: 'self-provided', degraded: true,
          degraded_reason: 'dsh-archigate 未安装，diagram_deliver 不可用；用自备规格产物代替。',
          covered_modules: ['x'], notes: ['降级交付'],
        },
      },
      g.agents.diagrammer,
    )
    expectOk(rec, '对照：降级路径**可以走通**，但交接物上明确标了 degraded + 原因', degradedOk, ['架构图交付'])
  }

  // =========================================================================
  // 关单闸：清单里有架构图角色却没交图
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const a = await seatArtifact(g, 'writer#1', 'code\n')
    await seatSubmit(g, 'writer#1', a.value?.version ?? 'v1')
    const cur = (await g.h.store.status({ taskId: g.taskId })).artifact_version
    const steps = await advanceToPassed(g, cur)
    const bad = steps.filter(([, r]) => r.denied === true)
    rec.add('关单闸 夹具：测试与审核都顺利走完（否则下面的拒绝理由会跑偏）',
      bad.length === 0,
      bad.length === 0
        ? `四步都过了：${steps.map(([n]) => n).join(' → ')}\n当前状态=${g.h.store.peek(g.taskId)?.state}`
        : `有步骤被拒：\n${bad.map(([n, r]) => `· ${n}：${r.text}`).join('\n')}`)

    const earlyClose = await callTool(g.h, 'pipeline_close', { task_id: g.taskId, role_token: g.tokens.main, note: '想直接关' }, g.agents.main)
    expectDenied(rec, '关单闸：角色清单里有架构图角色，但一张图都没交 → 拒绝关单', earlyClose, ['MISSING_DIAGRAM|架构图', '交付物之一', 'diagram_deliver'])
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('正例①')) return '正例① count=1（退化情形：既有 happy path 一行没改）'
    if (name.startsWith('正例②')) return '正例② count=3 三分工 → 到齐 → 交图 → 测试 → 审核 → 关单'
    if (name.startsWith('反例①')) return '反例① 席位越界写别人的分区'
    if (name.startsWith('反例②')) return '反例② 席位不匹配的令牌'
    if (name.startsWith('反例③')) return '反例③ 未到齐就推进'
    if (name.startsWith('反例④')) return '反例④ 架构图早于编写完成'
    if (name.startsWith('反例⑤')) return '反例⑤ 主对话自行决定 writers.count / 加席位'
    if (name.startsWith('反例⑥') || name.startsWith('反例⑦') || name.startsWith('对照')) return '架构图回执闸与降级路径'
    if (name.startsWith('关单闸')) return '关单闸：派了架构图角色就必须交图'
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
  lines.push('dsh-pipeline 编写分工（1~3 席位）与架构图角色自测')
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
    try { await rm(hh.projectRoot, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /writers-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runWritersCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
