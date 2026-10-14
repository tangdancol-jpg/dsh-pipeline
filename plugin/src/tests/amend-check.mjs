/**
 * dsh-pipeline · 授权面变更（amendment）自测
 * ============================================================================
 *     node tests/amend-check.mjs
 *
 * 现场（真单 `T-20261011-214043` 卡在这儿）：
 *   用户裁决「允许把插件包自带挂载声明档纳入授权面」，需求层也裁定"允许纳入"，
 *   **扩列动作归 planner**。但计划席实测：**计划工具在「待开发」(ready_dev) 拒绝再出计划**，
 *   报「跳步」。⇒ **裁定有了、动作做不了、通道卡着**，一个交付单元整轮走不动。
 *
 * 本套验的是一条**窄通道** `pipeline_scope_amend`：只动授权面
 * （`change_scope` + `forbidden`），其余一个字不许碰。
 *
 *   A. 正例：`ready_dev` + planner ⇒ 追加 1 条 `change_scope` 成功
 *      · `change_scope` 真的长了 1 条；`forbidden` 也能追加/撤销；
 *      · **两处留痕**：`task.json` 的 `amendments[]` + `audit.jsonl` 的 `scope:amend`；
 *      · `pipeline_status` 里看得见"更新后的授权面"与"最近一次 amendment"。
 *
 *   B. 反例①：`ready_dev` 下**非 planner** 调用 ⇒ 拒（守门层 + execute 层各一道）
 *
 *   C. 反例②：借 amendment 改**席位 / 档位 / 顺序 / 层 / 角色清单** ⇒ 拒
 *      · 入参白名单是 **fail-closed** 的：认不得的键一律拒，不是"禁列几个敏感字段"；
 *      · 拒了之后授权面**一个字节都没变**（先在副本上算、全部通过才落盘）。
 *
 *   D. 反例③：在**其它状态**（`planning` / `developing` / 终态）调用 ⇒ 拒
 *
 *   E. 反例④：既有两条路径**不许回退** ——
 *      · 计划那道「跳步」闸**没有被放宽**：`plan` 交接物仍然只在「计划中」收；
 *      · `pipeline_roster_request → pipeline_roster_review`（角色变更）照旧能用；
 *      · 「计划自检缺口 ⇒ 回流需求分析」照旧能用。
 *
 * @module dsh-pipeline/tests/amend-check
 */

import { callTool, createHarness, disposeHarness, runAnalysisThenPlan } from './selftest-core.mjs'

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

/** 片段里带 `|` 表示**任一即可**（同一条规则在不同身份解析路径上文案会不同）。 */
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
// 夹具
// ---------------------------------------------------------------------------

const LAYERS = ['interface', 'data', 'logic']
const WRITERS = {
  layers: LAYERS,
  partitions: LAYERS.map((l, i) => ({ seat: `writer#${i + 1}`, layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
  reason: '夹具：三层路径互不重叠，接口先冻结再并行',
}

/**
 * 造一个任务，可选停在两站：
 *   · `stopBeforePlan:false`（默认）⇒ 「待开发」(ready_dev)：**本通道唯一生效的那一站**
 *   · `stopBeforePlan:true`          ⇒ 「计划中」(planning)：用来验"其它状态一律拒"
 *
 * 走的是真实链路（开单 → 需求分析 → 用户确认 → 派计划 AI [→ 计划/分配]）。
 */
async function createAmendFixture(opts = {}) {
  const h = await createHarness()
  const MAIN = 'amend-main'
  const opened = await callTool(
    h,
    'pipeline_task_open',
    {
      requirement: '给插件包加一条「授权面变更」通道：插件包自带挂载声明档要能纳入本次授权面。',
      deliverable_format: '补丁 + 变更说明 + 可运行命令',
    },
    MAIN,
  )
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }

  await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: '夹具：跨模块 + 需要冻结接口契约 ⇒ L2；按层并行',
    layers: LAYERS.map((l) => ({ layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
    writers: WRITERS,
    stopBeforePlan: opts.stopBeforePlan === true,
  })

  // 给非 planner 角色各铸一枚令牌（反例①要用）
  for (const seat of ['writer#1', 'writer#2', 'writer#3']) {
    const tok = h.tokens.mint({ taskId, role: 'writer', seat, agentId: `amend-${seat}`, note: 'amend-check' })
    tokens[seat] = tok.token
    agents[seat] = `amend-${seat}`
  }
  for (const role of ['tester', 'reviewer']) {
    const tok = h.tokens.mint({ taskId, role, agentId: `amend-${role}`, note: 'amend-check' })
    tokens[role] = tok.token
    agents[role] = `amend-${role}`
  }

  // ★ 守门要**同步**查任务，所以登记进索引（与生产同一条路径）
  const task = await h.store.get(taskId)
  h.indexTask(taskId, task)
  return { h, taskId, tokens, agents, state: task.state }
}

/** 一条合法的追加条目（授权面里的东西长什么样，它就是什么样）。 */
const AMEND_ENTRY = {
  id: 'CS-amend1',
  path: 'plugins/self/manifest.json',
  action: 'modify',
  why: '用户已裁定：插件包自带挂载声明档纳入本次授权面（需求层裁定，扩列动作归 planner）。',
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runAmendCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 正例：ready_dev + planner ⇒ 追加 1 条 change_scope 成功，status 可见
  // =========================================================================
  {
    const f = await createAmendFixture()
    open.push(f.h)
    const before = f.h.store.peek(f.taskId)
    const scopeBefore = (before.change_scope ?? []).length
    const forbidBefore = (before.plan_forbidden ?? []).length

    rec.add(
      'A 正例：ready_dev + planner',
      '（夹具）任务停在「待开发」，计划已定稿、编写还没开工',
      f.state === 'ready_dev',
      `state=${f.state}　授权面 ${scopeBefore} 条　越界清单 ${forbidBefore} 条`,
    )

    // --- A1 追加 1 条 change_scope ---
    const amended = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '用户已裁定允许把插件包自带挂载声明档纳入授权面；扩列动作归 planner。', add: [AMEND_ENTRY], role_token: f.tokens.planner },
      f.agents.planner,
    )
    expectOk(rec, 'A 正例：ready_dev + planner', '★ 正例：追加 1 条 change_scope ⇒ 成功', amended, ['授权面已变更', 'CS-amend1', '只动授权面'])

    const t1 = f.h.store.peek(f.taskId)
    const scopeAfter = t1.change_scope ?? []
    rec.add(
      'A 正例：ready_dev + planner',
      '★ 授权面真的长了 1 条（判据级，不看散文）',
      scopeAfter.length === scopeBefore + 1 && scopeAfter.some((e) => e.id === 'CS-amend1' && e.action === 'modify' && e.path === AMEND_ENTRY.path),
      `before=${scopeBefore} → after=${scopeAfter.length}\n${JSON.stringify(scopeAfter.map((e) => `${e.id} ${e.action} ${e.path}`), null, 2)}`,
    )

    // --- A2 留痕①：task.json 的 amendments[] ---
    const am = t1.amendments ?? []
    rec.add(
      'A 正例：ready_dev + planner',
      '★ 留痕①：`task.json` 的 `amendments[]` 记下了 谁 / 何时 / 加了什么 / **why**',
      am.length === 1 &&
        am[0].by === 'planner' &&
        typeof am[0].at === 'string' &&
        am[0].at.length > 0 &&
        am[0].why.includes('用户已裁定') &&
        am[0].added.length === 1 &&
        am[0].added[0].id === 'CS-amend1' &&
        am[0].state_at_amend === 'ready_dev',
      JSON.stringify(am, null, 2),
    )
    rec.add(
      'A 正例：ready_dev + planner',
      '★ 留痕①′：变更**前后**都记下来了（可追溯"改了哪一条"）',
      am[0]?.before?.change_scope?.length === scopeBefore && am[0]?.after?.change_scope?.includes('CS-amend1'),
      `before=${JSON.stringify(am[0]?.before)}　after=${JSON.stringify(am[0]?.after)}`,
    )

    // --- A3 留痕②：audit.jsonl 的 scope:amend ---
    const log = await f.h.store.auditLog(f.taskId)
    const ev = log.filter((e) => e.action === 'scope:amend')
    rec.add(
      'A 正例：ready_dev + planner',
      '★ 留痕②：`audit.jsonl` 有一条 `scope:amend`（谁、何时、加了哪些条目、why）',
      ev.length === 1 && ev[0].actor === 'planner' && ev[0].why.includes('用户已裁定') && JSON.stringify(ev[0].added).includes('CS-amend1'),
      JSON.stringify(ev, null, 2),
    )

    // --- A4 可见面：pipeline_status ---
    const st = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.planner }, f.agents.planner)
    rec.add(
      'A 正例：ready_dev + planner',
      '★ `pipeline_status` 里看得见**更新后的授权面**',
      st.denied !== true && (st.value?.change_scope ?? []).some((e) => e.id === 'CS-amend1') && hit(st.text, 'CS-amend1'),
      `change_scope=${JSON.stringify(st.value?.change_scope?.map((e) => e.id))}\n摘要：\n${indent(st.text)}`,
    )
    rec.add(
      'A 正例：ready_dev + planner',
      '★ `pipeline_status` 里看得见**最近一次 amendment**（谁在什么时候为什么改的）',
      st.value?.last_amendment?.amendment_id === am[0].amendment_id &&
        st.value?.last_amendment?.by === 'planner' &&
        (st.value?.amendments ?? []).length === 1 &&
        hit(st.text, '最近一次授权面变更') &&
        hit(st.text, '用户已裁定'),
      `last_amendment=${JSON.stringify(st.value?.last_amendment, null, 2)}\n摘要：\n${indent(st.text)}`,
    )

    // --- A5 越界清单也能改（同一通道的另一半）---
    const forb = await callTool(
      f.h,
      'pipeline_scope_amend',
      {
        task_id: f.taskId,
        why: '新纳入的档是只读声明，必须同时禁止顺手改它的构建产物。',
        forbidden_add: ['不许改插件包自带挂载声明档以外的构建产物'],
        role_token: f.tokens.planner,
      },
      f.agents.planner,
    )
    expectOk(rec, 'A 正例：ready_dev + planner', '★ 正例：追加 1 条 `forbidden`（越界清单）⇒ 成功', forb, ['越界清单', '不许改插件包自带挂载声明档以外的构建产物'])
    const t2 = f.h.store.peek(f.taskId)
    rec.add(
      'A 正例：ready_dev + planner',
      '★ `forbidden` 真的多了 1 条，且 `amendments[]` 累积到 2 条（不是覆盖）',
      (t2.plan_forbidden ?? []).length === forbidBefore + 1 && (t2.amendments ?? []).length === 2,
      `forbidden=${JSON.stringify(t2.plan_forbidden, null, 2)}\namendments=${(t2.amendments ?? []).length} 条`,
    )

    // --- A6 撤销一条（异常出口也要有）---
    const rm = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '用户改口：这一层这次不动了，撤销它的授权。', remove: ['CS2'], role_token: f.tokens.planner },
      f.agents.planner,
    )
    expectOk(rec, 'A 正例：ready_dev + planner', '★ 正例：撤销 1 条 `change_scope` ⇒ 成功', rm, ['授权面已变更', '− CS2'])
    rec.add(
      'A 正例：ready_dev + planner',
      '★ 撤销真的生效（那一条不在了，其余还在）',
      !(f.h.store.peek(f.taskId).change_scope ?? []).some((e) => e.id === 'CS2') &&
        (f.h.store.peek(f.taskId).change_scope ?? []).some((e) => e.id === 'CS1'),
      JSON.stringify(f.h.store.peek(f.taskId).change_scope?.map((e) => e.id)),
    )

    // --- A7 反例②的"没变"基线：记下这一站的授权面指纹 ---
    rec.add(
      'A 正例：ready_dev + planner',
      '（基线）三次变更之后：授权面 / 越界清单 / 席位 / 档位都已经是"改过之后"的样子',
      true,
      `change_scope=${JSON.stringify(f.h.store.peek(f.taskId).change_scope?.map((e) => e.id))}\n` +
        `forbidden=${JSON.stringify(f.h.store.peek(f.taskId).plan_forbidden)}\n` +
        `roster=${f.h.store.peek(f.taskId).roster?.tier} / ${f.h.store.peek(f.taskId).roster?.execution_roles?.join(',')}`,
    )
  }

  // =========================================================================
  // B. 反例①：ready_dev 下**非 planner** 调用 ⇒ 拒
  // =========================================================================
  {
    const f = await createAmendFixture()
    open.push(f.h)
    const beforeIds = (f.h.store.peek(f.taskId).change_scope ?? []).map((e) => e.id).join(',')

    const asWriter = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '我是编写，我被授权面卡住了，想自己加一条。', add: [AMEND_ENTRY], role_token: f.tokens['writer#1'] },
      f.agents['writer#1'],
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①a 编写（writer#1）调用 ⇒ 守门层就拦下', asWriter, ['角色越权', 'planner'])

    const rawWriter = await callToolRaw(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '绕过守门试试。', add: [AMEND_ENTRY], role_token: f.tokens['writer#1'] },
      f.agents['writer#1'],
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①a′ 绕过守门直接打 execute：第二道闸仍然拦', rawWriter, ['只能由**计划 AI**', '计划的产物'])

    const asTester = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '测试想扩授权面。', add: [AMEND_ENTRY], role_token: f.tokens.tester },
      f.agents.tester,
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①b 测试调用 ⇒ 拦', asTester, ['角色越权', 'planner'])

    const asReviewer = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '审核想扩授权面。', add: [AMEND_ENTRY], role_token: f.tokens.reviewer },
      f.agents.reviewer,
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①c 审核调用 ⇒ 拦', asReviewer, ['角色越权', 'planner'])

    const asMain = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '主对话想替计划 AI 扩一条。', add: [AMEND_ENTRY], role_token: f.tokens.main },
      f.agents.main,
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①d **主对话**调用 ⇒ 拦（它不掌分配权，也不掌授权面）', asMain, ['角色越权', 'planner'])

    const asOrch = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '需求分析想替计划 AI 扩一条。', add: [AMEND_ENTRY], role_token: f.tokens.orchestrator },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'B 反例①：非 planner ⇒ 拒', '反例①e 需求分析调用 ⇒ 拦（它不掌分配权）', asOrch, ['角色越权', 'planner'])

    const afterIds = (f.h.store.peek(f.taskId).change_scope ?? []).map((e) => e.id).join(',')
    rec.add(
      'B 反例①：非 planner ⇒ 拒',
      '★ 五次被拒之后：授权面**一个字节都没变**，amendments 也是 0 条',
      afterIds === beforeIds && (f.h.store.peek(f.taskId).amendments ?? []).length === 0,
      `before=[${beforeIds}]　after=[${afterIds}]　amendments=${(f.h.store.peek(f.taskId).amendments ?? []).length}`,
    )
  }

  // =========================================================================
  // C. 反例②：借 amendment 改席位 / 档位 / 顺序 / 层 / 角色清单 ⇒ 拒
  // =========================================================================
  {
    const f = await createAmendFixture()
    open.push(f.h)
    const snapshot = () => {
      const t = f.h.store.peek(f.taskId)
      return JSON.stringify({
        scope: (t.change_scope ?? []).map((e) => e.id),
        forbidden: t.plan_forbidden ?? [],
        tier: t.roster?.tier ?? null,
        roles: t.roster?.execution_roles ?? [],
        layers: t.roster?.writers?.layers ?? [],
        seats: (t.roster?.writers?.partitions ?? []).map((p) => p.seat),
        sequence: (t.roster?.sequence ?? []).map((s) => s.role),
        amendments: (t.amendments ?? []).length,
      })
    }
    const before = snapshot()

    /** 每一发都带**一个**越界字段 —— 覆盖用户点名的那五类。 */
    const probes = [
      ['席位（seats）', { seats: ['writer#9'] }, ['seats']],
      ['席位（seat）', { seat: 'writer#9' }, ['seat']],
      ['席位方案（writers）', { writers: { layers: ['all'], partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'] }] } }, ['writers']],
      ['层划分（layers）', { layers: [{ layer: 'all', scope_paths: ['.'] }] }, ['layers']],
      ['层划分（partitions）', { partitions: [{ seat: 'writer#1', layer: 'all' }] }, ['partitions']],
      ['档位（tier）', { tier: 'L5' }, ['tier']],
      ['调用顺序（sequence）', { sequence: ['writer', 'tester'] }, ['sequence']],
      ['调用顺序（order）', { order: ['writer', 'tester'] }, ['order']],
      ['角色清单（roster）', { roster: { tier: 'L5' } }, ['roster']],
      ['角色清单（roles）', { roles: ['writer', 'tester'] }, ['roles']],
      ['角色清单（extra_roles）', { extra_roles: ['arbiter'] }, ['extra_roles']],
      ['执行角色（execution_roles）', { execution_roles: ['writer'] }, ['execution_roles']],
      ['独立对话数（ai_count）', { ai_count: 1 }, ['ai_count']],
      ['继任策略（relay_policy）', { relay_policy: { enabledTiers: ['L5'] } }, ['relay_policy']],
      ['计划步骤（plan_steps）', { plan_steps: ['重来一遍'] }, ['plan_steps']],
    ]

    for (const [label, extra, must] of probes) {
      const r = await callTool(
        f.h,
        'pipeline_scope_amend',
        { task_id: f.taskId, why: '顺手把别的东西也改一下。', add: [AMEND_ENTRY], role_token: f.tokens.planner, ...extra },
        f.agents.planner,
      )
      expectDenied(rec, 'C 反例②：借 amendment 改别的东西 ⇒ 拒', `反例② ${label} ⇒ 拒`, r, [
        '只许动授权面',
        '席位、角色清单、档位、调用顺序、层划分',
        ...must,
      ])
    }

    // 连"看起来无害"的未知键也拒 —— 白名单是 fail-closed 的，不是禁列几个敏感字段
    const unknown = await callTool(
      f.h,
      'pipeline_scope_amend',
      { task_id: f.taskId, why: '带一个没人见过的键试试。', add: [AMEND_ENTRY], seat_order_hint: 'writer#1 先上', role_token: f.tokens.planner },
      f.agents.planner,
    )
    expectDenied(rec, 'C 反例②：借 amendment 改别的东西 ⇒ 拒', '反例②′ **未知键**（seat_order_hint）也拒 —— 白名单 fail-closed，不是"禁列几个敏感字段"', unknown, [
      '只许动授权面',
      'seat_order_hint',
    ])

    rec.add(
      'C 反例②：借 amendment 改别的东西 ⇒ 拒',
      `★ ${probes.length + 1} 发全拒之后：档位 / 角色 / 层 / 席位 / 顺序 / 授权面 **一个字都没变**`,
      snapshot() === before,
      `before=${before}\n\nafter =${snapshot()}`,
    )
  }

  // =========================================================================
  // D. 反例③：在**其它状态**调用 ⇒ 拒
  // =========================================================================
  {
    // --- D1「计划中」---
    const plan = await createAmendFixture({ stopBeforePlan: true })
    open.push(plan.h)
    rec.add('D 反例③：其它状态 ⇒ 拒', '（夹具）第二个任务停在「计划中」', plan.state === 'planning', `state=${plan.state}`)
    const inPlanning = await callTool(
      plan.h,
      'pipeline_scope_amend',
      { task_id: plan.taskId, why: '计划还没交就想先扩一条。', add: [AMEND_ENTRY], role_token: plan.tokens.planner },
      plan.agents.planner,
    )
    expectDenied(rec, 'D 反例③：其它状态 ⇒ 拒', '反例③a 在「计划中」(planning) 调用 ⇒ 拒（那一站本来就收得下新范围，直接重出计划）', inPlanning, [
      '只在**「待开发」',
      '计划中',
      'AMEND_STATE_NOT_ALLOWED|只在',
    ])
    rec.add(
      'D 反例③：其它状态 ⇒ 拒',
      '★ 拒的理由里**明确给出正确路径**（计划中 ⇒ 重出计划；开发中 ⇒ 不许事后扩授权）',
      hit(inPlanning.text, '直接重出计划') && hit(inPlanning.text, '把越界洗成合规'),
      indent(inPlanning.text),
    )

    // --- D2「开发中」---
    const dev = await createAmendFixture()
    open.push(dev.h)
    const tr = await dev.h.store.transition({ taskId: dev.taskId, event: 'dispatch_writer', actorRole: 'main' })
    if (tr.ok !== true) throw new Error(`夹具：推进到开发中失败：${tr.error}`)
    dev.h.indexTask(dev.taskId, await dev.h.store.get(dev.taskId))
    const inDev = await callTool(
      dev.h,
      'pipeline_scope_amend',
      { task_id: dev.taskId, why: '编写已经开工了，事后补一条授权。', add: [AMEND_ENTRY], role_token: dev.tokens.planner },
      dev.agents.planner,
    )
    expectDenied(rec, 'D 反例③：其它状态 ⇒ 拒', '反例③b 在「开发中」(developing) 调用 ⇒ 拒（事后扩授权面 = 把越界洗成合规）', inDev, [
      '只在**「待开发」',
      '开发中',
      '把越界洗成合规',
    ])
    rec.add(
      'D 反例③：其它状态 ⇒ 拒',
      '★ 开发中那一次也没能改动授权面',
      (dev.h.store.peek(dev.taskId).amendments ?? []).length === 0 &&
        (dev.h.store.peek(dev.taskId).change_scope ?? []).length === 3,
      `amendments=${(dev.h.store.peek(dev.taskId).amendments ?? []).length}　change_scope=${(dev.h.store.peek(dev.taskId).change_scope ?? []).length} 条`,
    )

    // --- D3 终态（已取消）---
    const term = await createAmendFixture()
    open.push(term.h)
    const cancelled = await callTool(term.h, 'pipeline_transition', { task_id: term.taskId, event: 'cancel', role_token: term.tokens.main }, term.agents.main)
    if (cancelled.denied) throw new Error(`夹具：取消失败：\n${cancelled.text}`)
    term.h.indexTask(term.taskId, await term.h.store.get(term.taskId))
    const inTerminal = await callTool(
      term.h,
      'pipeline_scope_amend',
      { task_id: term.taskId, why: '任务都取消了还想扩一条。', add: [AMEND_ENTRY], role_token: term.tokens.planner },
      term.agents.planner,
    )
    expectDenied(rec, 'D 反例③：其它状态 ⇒ 拒', '反例③c 在**终态**（已取消）调用 ⇒ 拒', inTerminal, [
      '只在**「待开发」',
      '已取消',
      '开新任务',
    ])

    // --- D4 「待开发」是被**放行**的（对照组：拦的是状态，不是工具） ---
    const okFixture = await createAmendFixture()
    open.push(okFixture.h)
    const allowed = await callTool(
      okFixture.h,
      'pipeline_scope_amend',
      { task_id: okFixture.taskId, why: '对照组：同样的调用，只是状态对了。', add: [AMEND_ENTRY], role_token: okFixture.tokens.planner },
      okFixture.agents.planner,
    )
    expectOk(rec, 'D 反例③：其它状态 ⇒ 拒', '对照：**同样的调用**放在「待开发」⇒ 放行（拦的是状态，不是工具/参数）', allowed, ['授权面已变更'])
  }

  // =========================================================================
  // E. 反例④：既有路径**不许回退**
  // =========================================================================
  {
    // --- E1 计划那道「跳步」闸**没有被放宽** ---
    //
    //   这正是本轮的起点：planner 在 ready_dev 调 pipeline_plan 会被拒（跳步）。
    //   新增窄通道**不许**把这条闸放松 —— 它必须**照旧**拒。
    const f = await createAmendFixture()
    open.push(f.h)
    const jump = await callTool(
      f.h,
      'pipeline_plan',
      {
        task_id: f.taskId,
        plan_steps: ['重来'],
        layers: [],
        self_check_verdict: 'ok',
        self_check_checked: ['就想再规划一次'],
        self_check_gaps: [],
        plan_reason: '想顺手再出一版计划。',
        change_scope: [AMEND_ENTRY],
        forbidden: ['不许顺手重构'],
        role_boundaries: [{ role: 'writer', only: ['只写代码'], not: ['不干别的'] }],
        role_scope: { will_do: ['出计划'], will_not_do: ['不写实现'] },
        tier: 'L2',
        reason: '再分配一次',
        role_token: f.tokens.planner,
      },
      f.agents.planner,
    )
    expectDenied(rec, 'E 反例④：既有路径不许回退', '★ `pipeline_plan` 在「待开发」**照旧被拒**（跳步闸一个字没松）', jump, ['跳步', 'plan', 'planning'])
    rec.add(
      'E 反例④：既有路径不许回退',
      '★ 被拒之后角色清单**原封不动**（说明没绕过 setRoster 偷偷重分配）',
      (f.h.store.peek(f.taskId).roster?.execution_roles ?? []).join(',') === 'architect,writer,tester,reviewer,diagrammer,archivist',
      `execution_roles=${(f.h.store.peek(f.taskId).roster?.execution_roles ?? []).join(',')}`,
    )

    // --- E2 角色变更申请 / 复核 照旧能用 ---
    const req = await callTool(
      f.h,
      'pipeline_roster_request',
      { task_id: f.taskId, add: ['architect'], reason: '需求里出现了跨模块接口，建议保留架构角色。', role_token: f.tokens['writer#1'] },
      f.agents['writer#1'],
    )
    expectOk(rec, 'E 反例④：既有路径不许回退', '★ `pipeline_roster_request` 照旧能用（编写提出 → 计划 AI 复核）', req, ['角色变更申请已登记'])

    const wrongReviewer = await callTool(
      f.h,
      'pipeline_roster_review',
      { task_id: f.taskId, request_id: req.value.request_id, approve: true, note: '需求分析想批。', role_token: f.tokens.orchestrator },
      f.agents.orchestrator,
    )
    expectDenied(rec, 'E 反例④：既有路径不许回退', '★ 复核权**仍在计划 AI 手里**（需求分析批不了）', wrongReviewer, ['角色越权', 'planner'])

    const reviewed = await callTool(
      f.h,
      'pipeline_roster_review',
      {
        task_id: f.taskId,
        request_id: req.value.request_id,
        approve: true,
        note: '跨模块接口确实需要先定契约，同意。',
        role_boundaries: [{ role: 'architect', only: ['只定接口契约'], not: ['不写实现', '不扩大改动面'] }],
        role_token: f.tokens.planner,
      },
      f.agents.planner,
    )
    expectOk(rec, 'E 反例④：既有路径不许回退', '★ `pipeline_roster_review` 由计划 AI 复核**照旧能改写清单**（这条路径没被 amendment 顶替）', reviewed, ['新清单'])

    // --- E3 计划自检缺口 ⇒ 回流需求分析 照旧能用 ---
    const g = await createAmendFixture({ stopBeforePlan: true })
    open.push(g.h)
    const gaps = await callTool(
      g.h,
      'pipeline_plan',
      {
        task_id: g.taskId,
        plan_steps: ['先冻结接口'],
        layers: [],
        self_check_verdict: 'gaps',
        self_check_checked: ['需求覆盖', '层边界'],
        self_check_gaps: ['验收标准第 2 条没有落点'],
        gap_stage: '计划：验收标准落点',
        gap_question: '验收标准第 2 条（有独立测试且通过）这次由谁负责？',
        gap_context: '计划里没有为这条标准找到归属席位。',
        gap_urgency: 'blocking',
        plan_reason: '自检发现缺口，先回流。',
        // ⚠️ 即使自检没过，计划这份交接物的**字段**仍要合法 —— 缺一条就轮不到"回流"，
        //    会先被交接物校验拦下（这条是本套自己踩出来的）。
        change_scope: [AMEND_ENTRY],
        forbidden: ['不许顺手重构（改动面必须与授权面相等）'],
        role_boundaries: [{ role: 'writer', only: ['只写授权面内的改动'], not: ['不干别人的活', '不扩大改动面'] }],
        role_scope: { will_do: ['出计划', '自检'], will_not_do: ['不硬分配'] },
        role_token: g.tokens.planner,
      },
      g.agents.planner,
    )
    // 自检 verdict=gaps 的返回值本身是 ok（"计划已提交，但不会分配 AI"），
    // 但它**必须**留在「计划中」那一侧 —— 所以这里断言的是最终状态与措辞。
    expectOk(rec, 'E 反例④：既有路径不许回退', '★ 计划自检缺口**照旧回流需求分析**（不分配 AI）', gaps, ['gaps', '不会分配 AI', '需求分析'])
    const gState = g.h.store.peek(g.taskId).state
    rec.add(
      'E 反例④：既有路径不许回退',
      '★ 回流之后状态是「等待需求分析答复」（走的是**既有**的两级梯，没有另起通道）',
      gState === 'awaiting_clarification' && (g.h.store.peek(g.taskId).roster ?? null) === null,
      `state=${gState}　roster=${JSON.stringify(g.h.store.peek(g.taskId).roster)}`,
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
  lines.push('dsh-pipeline 授权面变更（amendment）自测')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('现场：用户已裁定"允许把插件包自带挂载声明档纳入授权面"，扩列动作归 planner；')
  lines.push('      但计划工具在「待开发」拒绝再出计划（跳步）⇒ 裁定有了、动作做不了。')
  lines.push('本套验一条**只动授权面**的窄通道，并证明它**没有**把计划那道闸放松。')
  for (const [grp, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${grp}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
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

// 直接跑：`node tests/amend-check.mjs`
if (process.argv[1] !== undefined && /amend-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runAmendCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
