/**
 * dsh-pipeline · **哈希前置闸门**自测
 * ============================================================================
 *     node tests/hashgate-check.mjs
 *
 * 用户原话：「**先过哈希对比，哈希对比不过全量测试直接打回**」
 *
 * 验五件事：
 *   A. **判定**：新增 / 修改 / 删除三类越界 + "声明不实"，逐条判得出、理由可执行
 *   B. **执法**：闸门排在**一切测试之前** ——
 *      不通过 ⇒ dev_to_test 被拒（任务仍停在"开发中"）、**测试没被触发**、
 *      且此后任何角色跑测试（含定向）都被守门拦下；
 *      通过 ⇒ 才进测试。
 *   C. ★ **连续不过的计数 + 自动交人工**（用户拍板 P13）：连续 3 次不过 ⇒
 *      走**既有**的 human_request / 两级梯交人工，答复前**拒收**重交；
 *      撤回不归零、通过才归零；答复后重新武装；计数不跨任务串台。
 *   D. ★ **回归**：既有"打回扣预算"的逻辑不受影响（闸门不扣、真打回照扣）。
 *   E. ★ `hashGateEscalateAfter: 0` = **关掉**自动升级（这个 0 必须真的关得掉）。
 *   F. ★★ **重取基线 = 新起点**：计数归零 + 旧基线判定作废 + 留痕；
 *      且**越界照拒**（授权面之外的改动仍必须被拒 —— 只改起点，不放宽判定）。
 *
 * ⚠️ 写这一套时踩过的坑（留给后人）：`store.peek()` 返回的是**内存里那个活对象** ——
 *    `const t = peek(id)` 不是快照。要比"改动前后"，必须先 `snap()` 深拷一份。
 *
 * @module dsh-pipeline/tests/hashgate-check
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { nextHashGateStreak, hashGateVerdict, renderGateRejection, resetHashGateOrigin, shouldEscalateHashGate } from '../lib/hashgate.js'
import { DEFAULTS, mergeConfig } from '../lib/config.js'
import { createHarness, disposeHarness, callTool, manifestFor, runAnalysisThenPlan } from './selftest-core.mjs'
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

/** 造一份 changeAudit 的假结果（判定层单测用）。 */
const fakeAudit = (over = {}) => ({
  ok: true,
  baseline: { baseline_id: 'BL-test', taken_at: '2026-10-11T00:00:00Z', file_count: 2, taken_by: 'planner', digest: 'x' },
  added: [],
  modified: [],
  removed: [],
  unauthorized: [],
  missing: [],
  verdict: 'within_scope',
  counts: { added: 0, modified: 0, removed: 0, unauthorized: 0, missing: 0 },
  ...over,
})

/**
 * ★ **快照**一份任务状态。
 *
 * ⚠️ `store.peek()` 返回的是**内存里那个活对象** —— 直接 `const t = peek(id)` 拿到的
 * 不是快照，后续任何提交都会**就地改掉它**（本套第一版就踩了这个：
 * "闸门通过后计数归零"把先前那次失败留下的计数 1 一起改成了 0，
 * 于是"失败时计数是 1"这条断言变成假红）。要比"改动前后"，就得先深拷一份。
 */
const snap = (h, taskId) => JSON.parse(JSON.stringify(h.store.peek(taskId)))

/**
 * ★ 在**同一个测试台**上再造一个"三层三席位、停在开发中"的任务。
 *
 * 用途只有一个：验「连续不过计数**不会跨任务串台**」。
 * 跨任务串台只可能在"两个任务共享同一份内存状态"时发生（例如有人把计数写成
 * 模块级变量）—— 所以这条用例**必须**让两个任务活在同一台 harness 里，
 * 各开一台 harness 是测不出来的（那等于给每个任务各配一份内存）。
 */
async function addDevelopingTask(h, tag) {
  const MAIN = `hashgate-main-${tag}`
  const opened = await callTool(
    h,
    'pipeline_task_open',
    { requirement: `跨任务计数用例（${tag}）：给订单系统加导出，按三层并行。`, deliverable_format: '补丁 + 变更说明' },
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
    reason: '跨任务计数用例：与另一任务同台共存',
    layers: layers.map((l) => ({ layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
    writers: {
      layers,
      partitions: layers.map((l, i) => ({ seat: `writer#${i + 1}`, layer: l, scope_paths: [`src/${l}`], deliverables: [`${l} 层产物`] })),
      reason: '三层路径互不重叠，接口先冻结再并行',
    },
  })
  const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
  if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)
  for (const seat of ['writer#1', 'writer#2', 'writer#3']) {
    tokens[seat] = h.tokens.mint({ taskId, role: 'writer', seat, agentId: `${tag}-${seat}`, note: 'hashgate-cross' }).token
    agents[seat] = `${tag}-${seat}`
  }
  const task = await h.store.get(taskId)
  h.indexTask(taskId, task)
  return { h, taskId, tokens, agents, requirements: { state: task.state } }
}

/**
 * ★ **单席位**（count=1）+ "有计划 ⇒ 有基线" 的任务，停在「开发中」。
 *
 * 为什么另造一个单席位夹具（而不是复用 `createBoundaryFixture` 的三席位）：
 * 本套要验的是"闸门失败**不**扣打回预算、而**正常打回照样扣**"这条对照 ——
 * 三席位时一个席位交完不会推进（席位未到齐是**另一条**判据），
 * 会把"打回"那半段挡住。单席位让整条链（交 → 测 → 打回）能一次走穿。
 */
async function singleSeatFixture(tag, config = {}) {
  const h = await createHarness({ config })
  const MAIN = `hashgate-${tag}-main`
  const opened = await callTool(
    h,
    'pipeline_task_open',
    { requirement: `哈希闸门与打回预算的对照用例（${tag}）：改一处导出逻辑。`, deliverable_format: '补丁 + 变更说明' },
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
    reason: '单席位 + 一份授权面：用来验闸门与打回预算的交互',
    layers: [{ layer: 'all', scope_paths: ['src/all'], deliverables: ['全部产物'] }],
    writers: {
      layers: ['all'],
      partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['src/all'], deliverables: ['全部产物'] }],
      reason: '改动集中在一处，单席位即可（count=1 是同一套机制的退化情形）',
    },
  })
  const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
  if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)
  tokens['writer#1'] = h.tokens.mint({ taskId, role: 'writer', seat: 'writer#1', agentId: `${tag}-writer1`, note: 'hashgate-single' }).token
  agents['writer#1'] = `${tag}-writer1`
  tokens.tester = h.tokens.mint({ taskId, role: 'tester', agentId: `${tag}-tester`, note: 'hashgate-single' }).token
  agents.tester = `${tag}-tester`
  const task = await h.store.get(taskId)
  h.indexTask(taskId, task)
  return { h, taskId, tokens, agents }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runHashGateCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 判定层（纯函数）
  // =========================================================================
  {
    const scope = [
      { id: 'CS1', path: 'src/interface', action: 'modify', why: '接口层' },
      { id: 'CS2', path: 'src/data', action: 'modify', why: '数据层' },
    ]

    // 正例：全在授权面内
    {
      const v = hashGateVerdict(
        fakeAudit({
          added: [{ path: 'src/interface/a.js', sha256: 'aaa' }],
          counts: { added: 1, modified: 0, removed: 0, unauthorized: 0, missing: 0 },
        }),
        [{ path: 'src/interface/a.js', action: 'modify', scope_id: 'CS1' }],
      )
      rec.add(
        'A 判定层',
        '正例：改动全在授权面内、声明也对得上 ⇒ **通过**',
        v.pass === true && v.violations.length === 0,
        `verdict=${v.pass}\n${v.summary}`,
      )
    }

    // 反例：三类越界
    for (const [how, zh, extra] of [
      ['created_unauthorized', '新增了**清单外**的文件', { added: [{ path: 'src/evil.js', sha256: 'bbb' }], unauthorized: [{ path: 'src/evil.js', how: 'created_unauthorized', baseline_sha256: null, actual_sha256: 'bbb' }] }],
      ['modified_unauthorized', '修改了**清单外**的文件', { modified: [{ path: 'src/other/k.js', sha256: 'ccc', baseline_sha256: 'ddd' }], unauthorized: [{ path: 'src/other/k.js', how: 'modified_unauthorized', baseline_sha256: 'ddd', actual_sha256: 'ccc' }] }],
      ['removed_unauthorized', '删除了**清单外**的文件', { removed: [{ path: 'src/other/gone.js', baseline_sha256: 'eee' }], unauthorized: [{ path: 'src/other/gone.js', how: 'removed_unauthorized', baseline_sha256: 'eee', actual_sha256: null }] }],
    ]) {
      const counts = { added: 0, modified: 0, removed: 0, unauthorized: 1, missing: 0 }
      const v = hashGateVerdict(fakeAudit({ ...extra, counts }), [])
      rec.add(
        'A 判定层',
        `★ 反例：${zh} ⇒ **不通过**（how=${how}）`,
        v.pass === false && v.violations.some((x) => x.how === how),
        `violations=${JSON.stringify(v.violations, null, 2)}`,
      )
    }

    // 反例：声明不实（实际动了但没报）
    {
      const v = hashGateVerdict(
        fakeAudit({
          added: [{ path: 'src/interface/a.js', sha256: 'aaa' }],
          modified: [{ path: 'src/data/b.js', sha256: 'mmm', baseline_sha256: 'nnn' }],
          counts: { added: 1, modified: 1, removed: 0, unauthorized: 0, missing: 0 },
        }),
        [{ path: 'src/interface/a.js', action: 'modify', scope_id: 'CS1' }],
      )
      rec.add(
        'A 判定层',
        '★ 反例：**声明不实**（改了 src/data/b.js 却没在 change_manifest 里报）⇒ **不通过**',
        v.pass === false && v.violations.some((x) => x.how === 'undeclared_change' && x.path === 'src/data/b.js'),
        `violations=${JSON.stringify(v.violations, null, 2)}`,
      )
    }

    // 可执行的打回理由
    {
      const audit = fakeAudit({
        added: [{ path: 'src/evil.js', sha256: 'ACTUAL_HASH_123' }],
        modified: [{ path: 'src/other/k.js', sha256: 'ACT2', baseline_sha256: 'BASE2' }],
        counts: { added: 1, modified: 1, removed: 0, unauthorized: 0, missing: 0 },
        unauthorized: [
          { path: 'src/evil.js', how: 'created_unauthorized', baseline_sha256: null, actual_sha256: 'ACTUAL_HASH_123' },
          { path: 'src/other/k.js', how: 'modified_unauthorized', baseline_sha256: 'BASE2', actual_sha256: 'ACT2' },
        ],
      })
      const v = hashGateVerdict(audit, [])
      const text = renderGateRejection({ verdict: v, audit, scope, baseline: audit.baseline })
      rec.add(
        'A 判定层',
        '★★ 打回理由**可执行**：列出文件 + 基线哈希 + 实际哈希 + 期望 + 授权面',
        hit(text, 'src/evil.js') &&
          hit(text, 'src/other/k.js') &&
          hit(text, 'BASE2') &&
          hit(text, 'ACT2') &&
          hit(text, '期望：') &&
          hit(text, 'CS1') &&
          hit(text, 'CS2'),
        indent(text.slice(0, 1400)),
      )
      rec.add(
        'A 判定层',
        '★★ 理由里明说「**测试没有被触发**」（设计意图写在给编写看的文案里）',
        hit(text, '测试没有被触发') && hit(text, '没有消耗测试预算') && hit(text, '不合格的提交不该消耗测试资源'),
        indent(text.split('\n').slice(-10).join('\n')),
      )
    }
  }

  // =========================================================================
  // B. 执法层：闸门排在一切测试之前
  // =========================================================================
  const fresh = async () => {
    const f = await createBoundaryFixture()
    open.push(f.h)
    return f
  }
  const scopeOf = (f) => f.h.store.peek(f.taskId).change_scope ?? []
  const submit = (f, manifest, seat = 'writer#1') =>
    callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'dev_to_test',
        role_token: f.tokens[seat],
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          patch_or_code: 'x',
          change_note: 'x',
          run_commands: ['node build.mjs'],
          selftest_result: '构建通过',
          known_issues: [],
          partition: { seat, index: 1, total: 3, layer: 'interface', scope_paths: ['src/interface'] },
          change_manifest: manifest,
        },
      },
      f.agents[seat],
    )

  // --- 正例：授权面内改动 → 放行 ---
  {
    const f = await fresh()
    const s = scopeOf(f)
    await mkdir(join(f.h.projectRoot, 'src/interface'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/interface/a.js'), '// 授权面内\n', 'utf8')
    const r = await submit(f, [{ path: 'src/interface/a.js', action: 'modify', scope_id: s[0].id, lines: 1 }])
    rec.add(
      'B 执法层',
      '★ 正例：**授权面内**的改动（哈希与基线对得上）⇒ 放行，进入测试',
      r.denied !== true && String(r.text).includes('编写交付给测试'),
      `layer=${r.layer}　state=${f.h.store.peek(f.taskId).state}\n${indent(r.text)}`,
    )
    rec.add(
      'B 执法层',
      '★ 通过时也**落档**（hash_gate_checks + 审计 gate:hash）',
      (f.h.store.peek(f.taskId).hash_gate_checks ?? []).length === 1 &&
        f.h.store.peek(f.taskId).hash_gate?.blocked === false,
      `checks=${JSON.stringify((f.h.store.peek(f.taskId).hash_gate_checks ?? []).map((c) => ({ pass: c.pass, counts: c.counts })))}\nhash_gate=${JSON.stringify(f.h.store.peek(f.taskId).hash_gate)}`,
    )
  }

  // --- 反例①②③④：四种不通过，全部在**测试之前**打回 ---
  const badCases = [
    {
      name: '★ 反例①：**清单外**的文件被改',
      setup: async (f) => {
        await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
        await writeFile(join(f.h.projectRoot, 'src/other/k.js'), '// 清单外\n', 'utf8')
      },
      manifest: (s) => [{ path: s[0].path, action: 'modify', scope_id: s[0].id, lines: 1 }],
      expect: 'src/other/k.js',
    },
    {
      name: '★ 反例②：**新增**了清单外的文件',
      setup: async (f) => {
        await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
        await writeFile(join(f.h.projectRoot, 'src/other/brand-new.js'), '// 顺手新建\n', 'utf8')
      },
      manifest: (s) => [{ path: s[0].path, action: 'modify', scope_id: s[0].id, lines: 1 }],
      expect: 'src/other/brand-new.js',
    },
    {
      name: '★ 反例③：**删了不该删的**',
      setup: async (f) => {
        // 先造一个"基线里就有"的清单外文件：造完**重取基线**，再删掉
        await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
        await writeFile(join(f.h.projectRoot, 'src/other/keep.js'), '// 本来就在\n', 'utf8')
        await callTool(f.h, 'pipeline_change_audit', { task_id: f.taskId, take: true, note: '把 keep.js 纳入基线', role_token: f.tokens.planner }, f.agents.planner)
        await rm(join(f.h.projectRoot, 'src/other/keep.js'))
      },
      manifest: (s) => [{ path: s[0].path, action: 'modify', scope_id: s[0].id, lines: 1 }],
      expect: 'src/other/keep.js',
    },
    {
      name: '★ 反例④：改了授权面内的文件，但**没在改动声明里报**（声明与实际对不上）',
      setup: async (f) => {
        await mkdir(join(f.h.projectRoot, 'src/interface'), { recursive: true })
        await writeFile(join(f.h.projectRoot, 'src/interface/silent.js'), '// 改了没说\n', 'utf8')
      },
      // 声明的是**另一个**文件（授权面内），实际动的这个没报
      manifest: (s) => [{ path: `${s[0].path}/declared-but-untouched.js`, action: 'create', scope_id: s[0].id, lines: 1 }],
      expect: 'src/interface/silent.js',
      expectUndeclared: true,
    },
  ]

  for (const c of badCases) {
    const f = await fresh()
    const s = scopeOf(f)
    const before = f.h.store.peek(f.taskId).state
    await c.setup(f)
    const r = await submit(f, c.manifest(s))
    const after = f.h.store.peek(f.taskId).state
    const gate = f.h.store.peek(f.taskId).hash_gate
    rec.add(
      'B 执法层',
      `${c.name} ⇒ **提交被拒 + 打回编写**（任务是 ${before}，被拒后仍是 ${after}）`,
      r.denied === true && hit(r.text, 'HASH_GATE_FAILED|哈希前置闸门') && after === before && after === 'developing',
      `layer=${r.layer}　state：${before} → ${after}\n${indent(String(r.text).slice(0, 900))}`,
    )
    rec.add(
      'B 执法层',
      `${c.name} ⇒ 理由里点名了**具体文件**：${c.expect}`,
      hit(r.text, c.expect),
      indent(String(r.text).split('\n').filter((l) => l.includes(c.expect)).slice(0, 3).join('\n') || '(没有出现该路径)'),
    )
    rec.add(
      'B 执法层',
      `${c.name} ⇒ 闸门**卡住**了（hash_gate.blocked=true，供守门同步判）`,
      gate?.blocked === true && gate?.violations?.some((x) => x.path === c.expect),
      `hash_gate=${JSON.stringify(gate)}`,
    )
    if (c.expectUndeclared === true) {
      rec.add(
        'B 执法层',
        `${c.name} ⇒ 归类为**声明不实**（undeclared_change）`,
        gate?.violations?.some((x) => x.how === 'undeclared_change'),
        JSON.stringify(gate?.violations),
      )
    }

    // ★★ 闸门没过 ⇒ **测试没有被触发**：任何角色跑测试（含定向）都被拦
    const tester = f.h.tokens.tester
    for (const [label, cmd] of [
      ['定向', 'npm test -- --grep fizzbuzz'],
      ['全量', 'npm test'],
    ]) {
      const run = await callTool(f.h, 'pwsh', { command: cmd, role_token: tester }, f.agents.tester)
      rec.add(
        'B 执法层',
        `${c.name} ⇒ ★★ **${label}测试也跑不了**（守门拦："哈希前置闸门还没过"）`,
        run.denied === true && hit(run.text, '哈希前置闸门还没过') && hit(run.text, '不合格的提交不该消耗测试资源'),
        `layer=${run.layer}\n${indent(String(run.text).slice(0, 700))}`,
      )
    }

    // 落档留痕
    const checks = f.h.store.peek(f.taskId).hash_gate_checks ?? []
    rec.add(
      'B 执法层',
      `${c.name} ⇒ **落档留痕**（对比结果进审计，可追溯）`,
      checks.length === 1 && checks[0].pass === false && Array.isArray(checks[0].violations) && checks[0].baseline_id.length > 0,
      `hash_gate_checks=${JSON.stringify(checks.map((x) => ({ pass: x.pass, counts: x.counts, n: x.violations.length, baseline: x.baseline_id })))}`,
    )
  }

  // --- 修好之后能过（闸门会解除）---
  {
    const f = await fresh()
    const s = scopeOf(f)
    await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/other/oops.js'), '// 越界\n', 'utf8')
    const bad = await submit(f, [{ path: s[0].path, action: 'modify', scope_id: s[0].id, lines: 1 }])
    const blockedRun = await callTool(f.h, 'pwsh', { command: 'npm test -- --grep x', role_token: f.h.tokens.tester }, f.agents.tester)
    // 撤回越界改动 + 补一份干净的改动
    await rm(join(f.h.projectRoot, 'src/other/oops.js'))
    await mkdir(join(f.h.projectRoot, 'src/interface'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/interface/ok.js'), '// 授权面内\n', 'utf8')
    const good = await submit(f, [{ path: 'src/interface/ok.js', action: 'create', scope_id: s[0].id, lines: 1 }])
    rec.add(
      'B 执法层',
      '★ 正例：**撤回越界改动后重交 ⇒ 闸门解除**，进入测试',
      bad.denied === true &&
        blockedRun.denied === true &&
        good.denied !== true &&
        // ⚠️ 别断言 state === ready_test：L2 夹具是**三席位**，一个席位交完不会推进
        //    （"席位未到齐"是另一条判据）。这里要看的是**闸门解除了**。
        f.h.store.peek(f.taskId).hash_gate?.blocked === false &&
        f.h.taskIndex.get(f.taskId)?.hashGateBlocked === false,
      `被拒=${bad.denied}　闸门期跑测试=${blockedRun.denied}　重交=${good.denied}　state=${f.h.store.peek(f.taskId).state}`,
    )
    const run = await callTool(f.h, 'pwsh', { command: 'npm test -- --grep fizzbuzz', role_token: f.h.tokens.tester }, f.agents.tester)
    rec.add(
      'B 执法层',
      '★ 正例：闸门解除后，**定向测试可以跑**（拦的是闸门，不是测试）',
      run.denied !== true,
      `layer=${run.layer}\n${run.text}`,
    )
    const full = await callTool(f.h, 'pwsh', { command: 'npm test', role_token: f.h.tokens.tester }, f.agents.tester)
    rec.add(
      'B 执法层',
      '★ 对照：闸门解除后，**全量**测试仍然要走四级审批链（两道闸是叠加的，不是替代）',
      full.denied === true && hit(full.text, '全量测试要走审批链'),
      `layer=${full.layer}\n${indent(String(full.text).split('\n').slice(0, 4).join('\n'))}`,
    )
  }

  // --- L0 弃权：没有基线就没有这道闸 ---
  {
    const { runHappyPath } = await import('./selftest-core.mjs')
    // ⚠️ runHappyPath 返回的是 `{ harness, taskId, ... }`（不是 { h }）—— 用错字段会得到 undefined。
    const happy = await runHappyPath({ stopAfter: 4 })
    open.push(happy.harness)
    const t = happy.harness.store.peek(happy.taskId)
    rec.add(
      'B 执法层',
      '★ L0 弃权（**说明性**）：L0 没有"计划"这一站 ⇒ 没有基线 ⇒ 这道闸不适用（与 P4 同源）',
      (t.change_scope === null || t.change_scope === undefined) && happy.harness.store.currentBaseline(t) === null,
      `L0 任务的 change_scope=${JSON.stringify(t.change_scope ?? null)}　baseline=${JSON.stringify(happy.harness.store.currentBaseline(t)?.baseline_id ?? null)}`,
    )
  }

  // =========================================================================
  // C. ★ 连续不过计数 + 自动交人工（用户拍板 P13 的后一半）
  // =========================================================================
  {
    // --- 判定层（纯函数）：把"连续"的定义钉死 ------------------------------
    rec.add(
      'C 连续不过与自动交人工',
      '★ 判定层：**连续**的定义 —— 不通过 +1；**只有通过才归零**（撤回不归零）',
      nextHashGateStreak(undefined, false) === 1 &&
        nextHashGateStreak(0, false) === 1 &&
        nextHashGateStreak(1, false) === 2 &&
        nextHashGateStreak(2, false) === 3 &&
        nextHashGateStreak(2, true) === 0 &&
        nextHashGateStreak(0, true) === 0,
      [
        '不通过：undefined→' + nextHashGateStreak(undefined, false),
        '0→' + nextHashGateStreak(0, false),
        '1→' + nextHashGateStreak(1, false),
        '2→' + nextHashGateStreak(2, false),
        '通过：2→' + nextHashGateStreak(2, true),
        '',
        '★ 「撤回越界改动」不在这张表里 —— 它不是机制可观测的事件（机制只看得到',
        '  下一次提交过没过）。看得到的那件事是"这个任务连续几次交上来的东西没过闸门"。',
      ].join('\n'),
    )
    rec.add(
      'C 连续不过与自动交人工',
      '★ 判定层：到阈值才升级；**已交人工且还没答复**时不再叠一条；阈值 0（关掉）永不升级',
      shouldEscalateHashGate({ hash_gate_streak: 2 }, 3) === false &&
        shouldEscalateHashGate({ hash_gate_streak: 3 }, 3) === true &&
        shouldEscalateHashGate({ hash_gate_streak: 4 }, 3) === true &&
        shouldEscalateHashGate({ hash_gate_streak: 3, hash_gate_escalation: { answered_at: null } }, 3) === false &&
        shouldEscalateHashGate({ hash_gate_streak: 9, hash_gate_escalation: { answered_at: '2026-10-11T00:00:00Z' } }, 3) === true &&
        shouldEscalateHashGate({ hash_gate_streak: 9 }, 0) === false,
      [
        'streak=2 阈值=3 → false（还差一次）',
        'streak=3 阈值=3 → true（到点就交人工）',
        'streak=3 且已升级未答复 → false（不重复打扰用户）',
        'streak=9 且**上一轮已答复** → true（重新武装：答复后再攒够 N 次还会再交一次）',
        '阈值=0 → false（配置层关掉自动升级）',
      ].join('\n'),
    )

    // --- 正例①：一次不过 → 撤回越界 → 重交成功 ⇒ 计数归零 ------------------
    {
      const f = await fresh()
      const s = scopeOf(f)
      await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/other/oops.js'), '// 越界\n', 'utf8')
      const bad = await submit(f, [{ path: s[0].path, action: 'modify', scope_id: s[0].id, lines: 1 }])
      const afterBad = snap(f.h, f.taskId)
      // ★ 撤回越界改动（把文件删掉），再补一份干净的、授权面内的改动
      await rm(join(f.h.projectRoot, 'src/other/oops.js'))
      await mkdir(join(f.h.projectRoot, 'src/interface'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/interface/ok.js'), '// 授权面内\n', 'utf8')
      const good = await submit(f, [{ path: 'src/interface/ok.js', action: 'create', scope_id: s[0].id, lines: 1 }])
      const afterGood = snap(f.h, f.taskId)
      rec.add(
        'C 连续不过与自动交人工',
        '★ 正例①：一次不过（计数 1）→ 撤回越界 → 重交**成功** ⇒ **计数归零**',
        bad.denied === true &&
          afterBad.hash_gate_streak === 1 &&
          afterBad.hash_gate?.blocked === true &&
          good.denied !== true &&
          afterGood.hash_gate_streak === 0 &&
          afterGood.hash_gate?.blocked === false &&
          afterGood.hash_gate_escalation === null,
        `被拒=${bad.denied}　计数：${afterBad.hash_gate_streak} → ${afterGood.hash_gate_streak}\n` +
          `闸门：blocked ${afterBad.hash_gate?.blocked} → ${afterGood.hash_gate?.blocked}\n` +
          `升级记录：${JSON.stringify(afterGood.hash_gate_escalation)}（没到阈值 ⇒ 一次都没升起过）\n` +
          `state=${afterGood.state}　hash_gate_checks=${(afterGood.hash_gate_checks ?? []).length} 条（失败1 + 通过1）`,
      )
      rec.add(
        'C 连续不过与自动交人工',
        '★ 正例① 附带：**每一次失败都留下了时间与理由**（落档留痕）',
        (afterBad.hash_gate_checks ?? []).length === 1 &&
          afterBad.hash_gate_checks[0].pass === false &&
          typeof afterBad.hash_gate_checks[0].at === 'string' &&
          afterBad.hash_gate_checks[0].streak === 1 &&
          afterBad.hash_gate_checks[0].threshold === 3 &&
          (afterBad.hash_gate_checks[0].violations ?? []).some((x) => x.path === 'src/other/oops.js'),
        `hash_gate_checks[0]=${JSON.stringify(afterBad.hash_gate_checks[0], null, 2)}`,
      )
      rec.add(
        'C 连续不过与自动交人工',
        '★ 判定层回归：闸门不通过**不消耗打回预算**（P13 前半，保持现状）',
        afterBad.rework.dev === 0 && afterBad.rework.test === 0,
        `rework=${JSON.stringify(afterBad.rework)}　budget=${afterBad.roster?.rework_budget ?? '(默认)'}\n` +
          '★ 理由：任务从未离开「开发中」，"打回"严格说没发生（提交本身不成立）。\n' +
          '  预算是为"真的来回拉锯过"设的，不该被没成立的提交扣掉。',
      )
    }

    // --- 反例③：连续 3 次不过 ⇒ 自动交人工 + 拒收重交 -----------------------
    {
      const f = await singleSeatFixture('esc')
      const s = scopeOf(f)
      const seat = 'writer#1'
      await mkdir(join(f.h.projectRoot, 'src/evil'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/evil/x.js'), '// 清单外\n', 'utf8')
      await mkdir(join(f.h.projectRoot, 'src/all'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/all/new.js'), '// 授权面内\n', 'utf8')

      const manifest = (sid) => [{ path: 'src/all/new.js', action: 'create', scope_id: sid, lines: 1 }]
      const sends = []
      for (let i = 1; i <= 3; i++) {
        sends.push(await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, manifest(s[0].id), seat))
      }
      const t = snap(f.h, f.taskId)
      const esc = t.hash_gate_escalation
      const escHandoff = (t.handoffs ?? []).filter((x) => x.kind === 'human_request').at(-1) ?? null
      const escReq = (t.human_requests ?? []).filter((r) => r.reason_kind === 'hash_gate_escalation').at(-1) ?? null

      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例③：**连续 3 次**不过 ⇒ 前 2 次只拒提交，**第 3 次自动交人工**（阈值默认 3）',
        sends[0].denied === true &&
          sends[1].denied === true &&
          sends[2].denied === true &&
          t.hash_gate_streak === 3 &&
          esc !== null &&
          esc !== undefined &&
          esc.round === 1 &&
          esc.streak === 3 &&
          esc.threshold === 3 &&
          typeof esc.request_id === 'string' &&
          esc.request_id.startsWith('HR-'),
        [
          `第1次 denied=${sends[0].denied}（文案里有没有"连续"：${hit(sends[0].text, '连续不通过计数')}）`,
          `第2次 denied=${sends[1].denied}　第3次 denied=${sends[2].denied}`,
          `连续计数=${t.hash_gate_streak}/${t.hash_gate?.threshold}`,
          `升级记录=${JSON.stringify(esc, null, 2)}`,
        ].join('\n'),
      )

      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例③：升级用的是**既有的** human_request（理由枚举 + 生命周期记录 + 状态推进），不是另起一套',
        escHandoff !== null &&
          escHandoff.payload?.reason_kind === 'hash_gate_escalation' &&
          escHandoff.from_role === 'orchestrator' &&
          escHandoff.to_role === 'main' &&
          escHandoff.payload?.blocking === true &&
          escHandoff.payload?.decision_kind === 'free_text' &&
          escHandoff.payload?.timeout_behavior === 'stay_blocked' &&
          escReq !== null &&
          escReq.request_id === esc.request_id &&
          escReq.status === 'pending' &&
          t.state === 'awaiting_human' &&
          t.previous_state === 'developing',
        [
          '【升级交接物（原件）】',
          JSON.stringify(
            {
              handoff_id: escHandoff?.handoff_id,
              kind: escHandoff?.kind,
              from_role: escHandoff?.from_role,
              to_role: escHandoff?.to_role,
              content_hash: escHandoff?.content_hash,
              payload: {
                reason_kind: escHandoff?.payload?.reason_kind,
                question_for_human: escHandoff?.payload?.question_for_human,
                context_for_human: escHandoff?.payload?.context_for_human,
                options: escHandoff?.payload?.options,
                blocking: escHandoff?.payload?.blocking,
                urgency: escHandoff?.payload?.urgency,
                decision_kind: escHandoff?.payload?.decision_kind,
                timeout_behavior: escHandoff?.payload?.timeout_behavior,
                orchestrator_reason: escHandoff?.payload?.orchestrator_reason,
              },
            },
            null,
            2,
          ),
          '',
          '【生命周期记录（task.human_requests）】',
          JSON.stringify({ request_id: escReq?.request_id, from_role: escReq?.from_role, reason_zh: escReq?.reason_zh, status: escReq?.status, state_at_request: escReq?.state_at_request, answered_at: escReq?.answered_at }, null, 2),
          '',
          `【状态】${t.state}（被打断前：${t.previous_state}）　任务档案：task.json / handoffs/${escHandoff?.handoff_id}.json / audit.jsonl`,
        ].join('\n'),
      )

      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例③ 附带：升级动作进了审计（`gate:hash_escalate`），可追溯',
        (t.history ?? []).some((e) => e.action === 'gate:hash_escalate' && e.request_id === esc?.request_id && e.streak === 3) &&
          (t.history ?? []).filter((e) => e.action === 'gate:hash').length === 3,
        (t.history ?? [])
          .filter((e) => String(e.action).startsWith('gate:'))
          .map((e) => `${e.at}  ${e.action}  ${JSON.stringify({ pass: e.pass, streak: e.streak, threshold: e.threshold, request_id: e.request_id })}`)
          .join('\n'),
      )

      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例③ 附带：升级**不消耗打回预算**（rework.dev 仍是 0）',
        t.rework.dev === 0 && t.rework.test === 0,
        `rework=${JSON.stringify(t.rework)}　budget=${t.roster?.rework_budget ?? '(默认)'}`,
      )

      // ★★ 升级之后：**拒收**重交（不是提醒，是拒收）
      const again = await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, manifest(s[0].id), seat)
      const direct = await f.h.store.submitHandoff({
        taskId: f.taskId,
        kind: 'dev_to_test',
        actorRole: 'writer',
        actorSeat: seat,
        actorAgentId: f.agents[seat],
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          patch_or_code: 'x',
          change_note: 'x',
          run_commands: ['node build.mjs'],
          selftest_result: '构建通过',
          known_issues: [],
          change_manifest: manifest(s[0].id),
        },
      })
      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例③：升级发生后，同一任务的再次提交**被拒收**（`HASH_GATE_ESCALATED`，守门层 + 工具执行层两道都拦）',
        again.denied === true &&
          hit(again.text, 'HASH_GATE_ESCALATED') &&
          hit(again.text, '不再接受同一任务的提交') &&
          hit(again.text, '拒收') &&
          direct.ok !== true &&
          direct.code === 'HASH_GATE_ESCALATED' &&
          f.h.store.peek(f.taskId).state === 'awaiting_human' &&
          f.h.store.peek(f.taskId).hash_gate_streak === 3,
        `工具层：layer=${again.layer}　denied=${again.denied}\n${indent(String(again.text).slice(0, 900))}\n\n` +
          `绕过守门直接调 store.submitHandoff：code=${direct.code}\n` +
          `（两道都拦 —— 机制不是提醒；计数也没有被第 4 次失败改动：${f.h.store.peek(f.taskId).hash_gate_streak}）`,
      )

      // ★★ **同步索引也要跟着刷新**（本项目真踩过的坑：失败分支没刷新索引 ⇒ 拦截静默失效）
      const idx = f.h.taskIndex.get(f.taskId) ?? {}
      const testRun = await callTool(f.h, 'pwsh', { command: 'npm test -- --grep x', role_token: f.tokens.tester }, f.agents.tester)
      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例③：**同步索引被刷新**（`hashGateEscalated`/`hashGateBlocked` 都进索引）⇒ 升级之后测试也照样跑不了（不是静默失效）',
        idx.hashGateBlocked === true &&
          idx.hashGateEscalated === true &&
          idx.hashGate?.streak === 3 &&
          testRun.denied === true &&
          hit(testRun.text, '哈希前置闸门还没过') &&
          hit(testRun.text, '已交人工'),
        [
          `索引：hashGateBlocked=${idx.hashGateBlocked}　hashGateEscalated=${idx.hashGateEscalated}　hashGate.streak=${idx.hashGate?.streak}/${idx.hashGate?.threshold}`,
          `tester 跑定向测试：layer=${testRun.layer}　denied=${testRun.denied}`,
          indent(String(testRun.text).split('\n').slice(-4).join('\n')),
          '',
          '★ 这条专门盯着"失败分支没刷新同步索引"那个坑：',
          '  闸门判定发生在**拒绝之前**，工具层必须拿 res.task 回灌索引 ——',
          '  否则守门查到的还是旧状态，拦截看着做了、实际不生效。',
        ].join('\n'),
      )

      // ★ 既有判据不许破：答复仍然必须带**来源**与**本人原话**
      const rel = await callTool(f.h, 'pipeline_human_relay', { task_id: f.taskId, request_id: esc.request_id, role_token: f.tokens.main }, f.agents.main)
      const noQuote = await callTool(
        f.h,
        'pipeline_human_reply',
        { task_id: f.taskId, request_id: esc.request_id, reply_channel: 'chat', attribution: '用户在当前会话里直接回复', answer_text: '按你说的办', role_token: f.tokens.main },
        f.agents.main,
      )
      const noAttr = await callTool(
        f.h,
        'pipeline_human_reply',
        { task_id: f.taskId, request_id: esc.request_id, user_quote: '把越界那部分撤掉，按原来授权的范围重做一遍。', reply_channel: 'chat', answer_text: '按你说的办', role_token: f.tokens.main },
        f.agents.main,
      )
      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例③：**既有判据一个字没破** —— 没有 user_quote / attribution 的答复照样被拒（人工答复必须带来源与本人原话）',
        rel.denied !== true &&
          noQuote.denied === true &&
          hit(noQuote.text, '缺 user_quote|用户本人的原话') &&
          noAttr.denied === true &&
          hit(noAttr.text, '缺 attribution|要写清这句答复是'),
        `转告=${rel.denied === true ? '被拒' : '通过'}\n` +
          `缺 user_quote：denied=${noQuote.denied}　原文=${String(noQuote.text).split('\n')[0]}\n` +
          `缺 attribution：denied=${noAttr.denied}　原文=${String(noAttr.text).split('\n')[0]}\n` +
          '（拒绝文案里不带 `MISSING_USER_QUOTE` 这类码 —— 判据看的是**行为**，不是码字。）',
      )

      const replied = await callTool(
        f.h,
        'pipeline_human_reply',
        {
          task_id: f.taskId,
          request_id: esc.request_id,
          user_quote: '把越界那部分撤掉，按原来授权的范围重做一遍。',
          reply_channel: 'chat',
          attribution: '用户在当前会话里直接回复',
          answer_text: '撤回越界改动，按原授权范围重做',
          role_token: f.tokens.main,
        },
        f.agents.main,
      )
      const t2 = snap(f.h, f.taskId)
      const idx2 = f.h.taskIndex.get(f.taskId) ?? {}
      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例③：用户答复后 ⇒ 状态恢复「开发中」、升级**了结**、计数**重新武装**（= 0），重交重新被接受',
        replied.denied !== true &&
          t2.state === 'developing' &&
          t2.hash_gate_escalation?.answered_at !== null &&
          t2.hash_gate_escalation?.user_quote === '把越界那部分撤掉，按原来授权的范围重做一遍。' &&
          t2.hash_gate_streak === 0 &&
          idx2.hashGateEscalated === false &&
          (t2.history ?? []).some((e) => e.action === 'gate:hash_rearm'),
        `state=${t2.state}　计数=${t2.hash_gate_streak}　索引里 hashGateEscalated=${idx2.hashGateEscalated}\n升级记录=${JSON.stringify(t2.hash_gate_escalation, null, 2)}\n` +
          '★ 为什么要重新武装：答复未必真能解决问题；若升级一次就永久失效，\n' +
          '  第 4 次以后的失败就没人管了 —— 那正是本条要堵的"无限重交"。\n' +
          '  重新武装之后仍是"每连续 N 次就有一个人点头"，不存在没人看着的重交。',
      )

      // 答复后再攒够 N 次 ⇒ 再交一次人工（第 2 轮），证明"重新武装"是真的
      for (let i = 1; i <= 3; i++) await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, manifest(s[0].id), seat)
      const t3 = snap(f.h, f.taskId)
      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例③：答复之后又连续 3 次不过 ⇒ **第 2 次升级**（round=2，不重复用旧记录）',
        t3.hash_gate_streak === 3 && t3.hash_gate_escalation?.round === 2 && t3.hash_gate_escalation?.answered_at === null && t3.state === 'awaiting_human',
        `round=${t3.hash_gate_escalation?.round}　request_id=${t3.hash_gate_escalation?.request_id}　state=${t3.state}　计数=${t3.hash_gate_streak}`,
      )
      for (const x of [f.h]) open.push(x)
    }

    // --- 反例③的边角：发起人必须在"能发 human_request"的白名单里 -----------------
    //
    //   为什么专门测这条：基线是**可以重取**的，而重取允许"主对话兜底"
    //   （`pipeline_change_audit` 的 take 权限）。若照抄 `baseline.taken_by='main'`，
    //   `canProduceHandoff('main','human_request')` 会直接拒 ⇒ **升级发不出去**，
    //   现场只剩一条 `gate:hash_escalate_failed` —— "连续 N 次不过"这件事就没人管了。
    //   这正是本项目反复踩过的同一类坑：判据在角落路径上**静默失效**。
    {
      const f = await singleSeatFixture('fallback')
      open.push(f.h)
      const s = scopeOf(f)
      // 白盒地把场景摆出来：档位伪造成"没有独立编排"，基线记录人改成主对话（兜底重取）
      const live = f.h.store.peek(f.taskId)
      live.roster.orchestrator_mode = 'rule-engine'
      f.h.store.currentBaseline(live).taken_by = 'main'

      await mkdir(join(f.h.projectRoot, 'src'), { recursive: true })
      await mkdir(join(f.h.projectRoot, 'src/all'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/evil.js'), '// 越界\n', 'utf8')
      await writeFile(join(f.h.projectRoot, 'src/all/new.js'), '// 授权面内\n', 'utf8')
      const one = { h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }
      const manifest = [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }]
      for (let i = 1; i <= 3; i++) await submit(one, manifest)
      const t = snap(f.h, f.taskId)
      const escHandoff = (t.handoffs ?? []).filter((x) => x.kind === 'human_request').at(-1) ?? null
      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例③ 边角：发起人**必须发得出来** —— 基线记录人是 `main`（兜底重取）时改由**计划 AI** 发起，升级照样发出去',
        t.hash_gate_streak === 3 &&
          t.hash_gate_escalation !== null &&
          t.hash_gate_escalation.from_role === 'planner' &&
          t.hash_gate_escalation.answered_at === null &&
          escHandoff !== null &&
          escHandoff.from_role === 'planner' &&
          escHandoff.payload?.reason_kind === 'hash_gate_escalation' &&
          t.state === 'awaiting_human' &&
          !(t.history ?? []).some((e) => e.action === 'gate:hash_escalate_failed'),
        [
          `基线记录人（伪造的极端情形）：main　档位：${live.roster.orchestrator_mode}`,
          `实际发起人：${t.hash_gate_escalation?.from_role}（交接物里也是 ${escHandoff?.from_role}）`,
          `state=${t.state}　request_id=${t.hash_gate_escalation?.request_id}`,
          `审计里有没有"升级失败"：${(t.history ?? []).some((e) => e.action === 'gate:hash_escalate_failed') ? '**有（没发出去）✗**' : '没有（发出去了 ✓）'}`,
          '',
          '★ `main` 不在 `ROLES_CAN_RAISE_HUMAN` 里（用户只与主对话相连，它要问用户直接问即可，',
          '  不需要"发起请求给自己"）—— 所以照抄 taken_by 会让这条升级**静默发不出去**。',
        ].join('\n'),
      )
    }

    // --- 反例④：计数不会跨任务串台 ------------------------------------------
    {
      const a = await createBoundaryFixture()
      open.push(a.h)
      const sa = scopeOf(a)
      await mkdir(join(a.h.projectRoot, 'src/otherA'), { recursive: true })
      await writeFile(join(a.h.projectRoot, 'src/otherA/a.js'), '// 任务A的越界\n', 'utf8')
      for (let i = 1; i <= 2; i++) await submit(a, [{ path: sa[0].path, action: 'modify', scope_id: sa[0].id, lines: 1 }])

      // ★ 第二个任务**活在同一个测试台里** —— 跨任务串台只可能在共享内存时发生，
      //   各开一台 harness 是测不出来的。
      const b = await addDevelopingTask(a.h, 'cross')
      const sb = (b.h.store.peek(b.taskId).change_scope ?? [])
      await mkdir(join(b.h.projectRoot, 'src/otherB'), { recursive: true })
      await writeFile(join(b.h.projectRoot, 'src/otherB/b.js'), '// 任务B的越界\n', 'utf8')
      for (let i = 1; i <= 2; i++) await submit(b, [{ path: sb[0].path, action: 'modify', scope_id: sb[0].id, lines: 1 }])

      const ta = snap(a.h, a.taskId)
      const tb = snap(b.h, b.taskId)
      rec.add(
        'C 连续不过与自动交人工',
        '★★ 反例④：**计数不会跨任务串台** —— 两个任务各失败 2 次，各自是 2（不是 4）',
        ta.hash_gate_streak === 2 &&
          tb.hash_gate_streak === 2 &&
          ta.hash_gate_escalation === null &&
          tb.hash_gate_escalation === null &&
          (ta.hash_gate_checks ?? []).length === 2 &&
          (tb.hash_gate_checks ?? []).length === 2 &&
          ta.hash_gate_checks.every((c) => c.pass === false) &&
          tb.hash_gate_checks.every((c) => c.pass === false),
        [
          `任务A ${a.taskId}：计数=${ta.hash_gate_streak}　比对记录=${(ta.hash_gate_checks ?? []).length} 条　升级=${ta.hash_gate_escalation === null ? '（未升级，正确）' : '**串台了**'}`,
          `任务B ${b.taskId}：计数=${tb.hash_gate_streak}　比对记录=${(tb.hash_gate_checks ?? []).length} 条　升级=${tb.hash_gate_escalation === null ? '（未升级，正确）' : '**串台了**'}`,
          '',
          '★ 两个任务共享同一台 harness（同一份内存）—— 只有这样才能证明计数是**任务字段**，',
          '  而不是某个模块级/进程级的全局变量（后者会让 B 一上来就顶着 A 的次数）。',
        ].join('\n'),
      )
      rec.add(
        'C 连续不过与自动交人工',
        '★ 反例④ 附带：2 次 < 阈值 3 ⇒ 两边都**没有**被升级（不误伤）',
        ta.state === 'developing' && tb.state === 'developing',
        `A.state=${ta.state}　B.state=${tb.state}（都还在开发中，等编写改）`,
      )
    }
  }

  // =========================================================================
  // D. ★ 正例②：既有"打回扣预算"的逻辑**不受影响**（P13 的回归）
  // =========================================================================
  {
    const f = await singleSeatFixture('rework')
    open.push(f.h)
    const s = scopeOf(f)
    const one = { h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }
    const budget = f.h.store.peek(f.taskId).roster?.rework_budget ?? 2

    // --- 先来一次"闸门不通过"：应当**不**扣预算 ---
    await mkdir(join(f.h.projectRoot, 'src'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/evil.js'), '// 越界一次\n', 'utf8')
    await mkdir(join(f.h.projectRoot, 'src/all'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/all/new.js'), '// 授权面内\n', 'utf8')
    const bad = await submit(one, [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }])
    const afterBad = snap(f.h, f.taskId)
    rec.add(
      'D 打回预算回归',
      `★ 正例② 前半：闸门不通过 ⇒ 提交被拒，但 **rework.dev 仍是 0**（预算上限 ${budget}）`,
      bad.denied === true && afterBad.rework.dev === 0 && afterBad.hash_gate_streak === 1,
      `被拒=${bad.denied}　rework=${JSON.stringify(afterBad.rework)}　连续计数=${afterBad.hash_gate_streak}`,
    )

    // --- 改好后正常提交 → 测试 → 打回：**打回照样扣预算** ---
    await rm(join(f.h.projectRoot, 'src/evil.js'))
    const good = await submit(one, [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }])
    const afterGood = snap(f.h, f.taskId)

    let deniedAt = null
    let rounds = 0
    for (let round = 1; round <= 5; round++) {
      rounds = round
      const tr = await f.h.store.transition({ taskId: f.taskId, event: 'dispatch_tester', actorRole: 'main' })
      if (tr.ok !== true) {
        deniedAt = tr
        break
      }
      const rw = await callTool(f.h, 'pipeline_rework', { task_id: f.taskId, target: 'writer', reason: `第 ${round} 轮：测试发现缺陷`, role_token: f.tokens.tester }, f.agents.tester)
      if (rw.denied === true) {
        deniedAt = rw
        break
      }
      // 回到开发中 → 再交一次（清单不变，仍在授权面内）
      const back = await f.h.store.transition({ taskId: f.taskId, event: 'dispatch_writer', actorRole: 'main' })
      if (back.ok !== true) {
        deniedAt = back
        break
      }
      const again = await submit(one, [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }])
      if (again.denied === true) {
        deniedAt = again
        break
      }
    }
    const tEnd = snap(f.h, f.taskId)
    rec.add(
      'D 打回预算回归',
      `★ 正例② 后半：**打回照样扣预算** —— 前 ${budget} 次打回成功（rework.dev=${budget}），第 ${budget + 1} 次被拒`,
      good.denied !== true &&
        afterGood.rework.dev === 0 &&
        tEnd.rework.dev === budget &&
        deniedAt !== null &&
        hit(String(deniedAt.text ?? deniedAt.error ?? ''), '打回次数超限') &&
        hit(String(deniedAt.text ?? deniedAt.error ?? ''), '不能无限打回'),
      [
        `干净提交=${good.denied === true ? '被拒' : '通过'}（闸门通过 ⇒ 计数归零：${afterGood.hash_gate_streak}）`,
        `循环到第 ${rounds} 轮被拒`,
        `最终 rework=${JSON.stringify(tEnd.rework)}（budget=${budget}）　state=${tEnd.state}`,
        '拒绝原文：',
        indent(String(deniedAt?.text ?? deniedAt?.error ?? '').slice(0, 700)),
      ].join('\n'),
    )
    rec.add(
      'D 打回预算回归',
      '★ 正例② 对照：整条链上**闸门是闸门、预算是预算** —— 两者互不替代',
      afterBad.rework.dev === 0 && tEnd.rework.dev === budget,
      '闸门不通过：rework.dev 0→0（提交没成立，不算一次打回）\n' +
        `打回真的发生：rework.dev 0→${budget}（照扣，与 P13 之前一模一样）\n` +
        '★ 这正是用户拍板的取舍：不该扣的不扣，该扣的照样扣。',
    )
  }

  // =========================================================================
  // E. ★ `hashGateEscalateAfter: 0` = **关掉**自动升级（这个 0 必须真的关得掉）
  // =========================================================================
  {
    rec.add(
      'E 关掉自动升级',
      '★ 配置层：`hashGateEscalateAfter` 默认 3；**0 是合法值**（不会被默认值顶回去）；负数/小数才回落默认',
      DEFAULTS.hashGateEscalateAfter === 3 &&
        mergeConfig({}).hashGateEscalateAfter === 3 &&
        mergeConfig({ hashGateEscalateAfter: 0 }).hashGateEscalateAfter === 0 &&
        mergeConfig({ hashGateEscalateAfter: 5 }).hashGateEscalateAfter === 5 &&
        mergeConfig({ hashGateEscalateAfter: -1 }).hashGateEscalateAfter === 3 &&
        mergeConfig({ hashGateEscalateAfter: 1.5 }).hashGateEscalateAfter === 3 &&
        mergeConfig({ hashGateEscalateAfter: '3' }).hashGateEscalateAfter === 3,
      [
        `DEFAULTS=${DEFAULTS.hashGateEscalateAfter}`,
        `{} → ${mergeConfig({}).hashGateEscalateAfter}`,
        `{0} → ${mergeConfig({ hashGateEscalateAfter: 0 }).hashGateEscalateAfter}  ← 关掉`,
        `{5} → ${mergeConfig({ hashGateEscalateAfter: 5 }).hashGateEscalateAfter}`,
        `{-1} → ${mergeConfig({ hashGateEscalateAfter: -1 }).hashGateEscalateAfter}（回落默认）`,
        `{1.5} → ${mergeConfig({ hashGateEscalateAfter: 1.5 }).hashGateEscalateAfter}（回落默认）`,
        `{'3'} → ${mergeConfig({ hashGateEscalateAfter: '3' }).hashGateEscalateAfter}（回落默认）`,
      ].join('\n'),
    )

    const f = await singleSeatFixture('off', { hashGateEscalateAfter: 0 })
    open.push(f.h)
    const s = scopeOf(f)
    await mkdir(join(f.h.projectRoot, 'src'), { recursive: true })
    await mkdir(join(f.h.projectRoot, 'src/all'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/evil.js'), '// 越界\n', 'utf8')
    await writeFile(join(f.h.projectRoot, 'src/all/new.js'), '// 授权面内\n', 'utf8')
    const one = { h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }
    const manifest = [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }]

    const sends = []
    // 交 **5** 次（比默认阈值 3 多）—— 关掉就是关掉，交多少次都不该升级
    for (let i = 1; i <= 5; i++) sends.push(await submit(one, manifest))
    const t = snap(f.h, f.taskId)

    rec.add(
      'E 关掉自动升级',
      '★★ 反例⑤：`hashGateEscalateAfter: 0` ⇒ 连交 **5 次**全被拒，但**一次都不升级**、任务仍停在「开发中」、提交仍被接受',
      sends.every((r) => r.denied === true) &&
        t.hash_gate_streak === 5 &&
        t.hash_gate_escalation === null &&
        t.state === 'developing' &&
        (t.human_requests ?? []).filter((r) => r.reason_kind === 'hash_gate_escalation').length === 0,
      [
        `连交 5 次的 denied：${sends.map((r) => r.denied).join(' / ')}（全被拒 = 闸门照旧执法）`,
        `连续计数=${t.hash_gate_streak}（照数，只是不升级）　阈值=${t.hash_gate?.threshold}`,
        `升级记录=${JSON.stringify(t.hash_gate_escalation)}（null = 真的关掉了）`,
        `state=${t.state}　hash 升级类人工请求=${(t.human_requests ?? []).filter((r) => r.reason_kind === 'hash_gate_escalation').length} 条`,
        '',
        '拒绝原文（末尾不再出现"离自动交人工还差…"—— 关了就不该提这茬）：',
        indent(String(sends[4].text).split('\n').slice(-6).join('\n')),
      ].join('\n'),
    )
    rec.add(
      'E 关掉自动升级',
      '★ 反例⑤ 附带：关掉的是"自动升级"，**不是**闸门本身 —— 闸门照样拦、也不消耗打回预算',
      t.hash_gate?.blocked === true && t.rework.dev === 0 && t.rework.test === 0,
      `hash_gate.blocked=${t.hash_gate?.blocked}　rework=${JSON.stringify(t.rework)}\n` +
        '★ 两个开关各管一段：`guardHashGate` 管"这道闸执不执法"，`hashGateEscalateAfter` 管"执法不过之后怎么办"。\n' +
        '  把后者设成 0，退回到 P13 拍板之前的行为（编写可以无限重交），但闸门与"不扣打回预算"都还在。',
    )
  }

  // =========================================================================
  // F. ★★ **重取基线 = 新起点**（本轮修的第二个拦路虎）
  // =========================================================================
  //
  //  现场：真单 T-20261011-214043 的闸门长期显示「**卡着** 连续不通过 1/3」。
  //  链条是：本单开工基线**早于**当晚那几次基础设施前置修复 ⇒ 那批**与本单无关**
  //  的改动永远显示成"本单越界"；编写席修不掉（它撤不回别人的活），
  //  唯一出路就是**重取基线**。可重取基线**不清"连续不通过"计数** ⇒
  //  旧基线下的 1/3 跟着走到新基线，再攒两次就触发"机制自动交人工"。
  //
  //  这一套验三件事（缺一不可）：
  //    · 重取基线 ⇒ 计数归零 + 基于旧基线的那份判定作废 + `gate:hash_reset` 留痕；
  //    · **改名不换实质**：真的越界**仍然被拒**，而且计数**从新基线重新起算**（1 而不是 2）；
  //    · 没什么可清的时候是**纯读**（`changed=false`，不写第二条审计）。
  {
    rec.add(
      'F 重取基线 = 新起点',
      '★ 判定层：`resetHashGateOrigin` —— 有计数/有旧判定才动它；**不碰** `hash_gate_escalation`',
      (() => {
        const a = { baseline_current: 'BL-1', hash_gate_streak: 2, hash_gate: { baseline_id: 'BL-1', blocked: true }, hash_gate_escalation: { round: 1, answered_at: null } }
        const r1 = resetHashGateOrigin(a, 'BL-2')
        const b = { baseline_current: 'BL-1', hash_gate_streak: 0, hash_gate: { baseline_id: 'BL-2', blocked: false } }
        const r2 = resetHashGateOrigin(b, 'BL-2')
        const c = { baseline_current: 'BL-1', hash_gate_streak: 1, hash_gate: null }
        const r3 = resetHashGateOrigin(c, 'BL-3')
        return (
          r1.changed === true &&
          a.hash_gate_streak === 0 &&
          a.hash_gate === null &&
          a.hash_gate_escalation?.round === 1 && // ★ 已交到用户手上的单不会被悄悄撤回
          r1.prev_streak === 2 &&
          r1.prev_gate_baseline_id === 'BL-1' &&
          r2.changed === false &&
          b.hash_gate_streak === 0 &&
          b.hash_gate !== null &&
          r3.changed === true &&
          c.hash_gate_streak === 0
        )
      })(),
      [
        '有计数(2) + 旧基线判定 ⇒ changed=true，streak→0，hash_gate→null，升级记录**原样**（不替用户撤单）',
        '没有计数、判定已属新基线 ⇒ changed=false（**纯读**，不写审计）',
        '只有计数、没有判定 ⇒ changed=true，streak→0',
      ].join('\n'),
    )

    const f = await singleSeatFixture('rebase')
    open.push(f.h)
    const s = scopeOf(f)
    await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
    await writeFile(join(f.h.projectRoot, 'src/other/oops.js'), '// 清单外（模拟"非本单改动"）\n', 'utf8')
    const bad = await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, [{ path: 'src/all/new.js', action: 'create', scope_id: s[0].id, lines: 1 }])
    const afterBad = snap(f.h, f.taskId)
    const badBaseline = afterBad.baseline_current

    // 主对话重取基线（真单里就是这么解的：BL-64c1eb000b1f10bf）
    const rebase = await f.h.store.takeBaseline({ taskId: f.taskId, by: 'main', note: '本单开工基线早于基础设施前置修复；重取 = 新起点' })
    const afterRebase = snap(f.h, f.taskId)
    const resetLine = (afterRebase.history ?? []).find((x) => x.action === 'gate:hash_reset') ?? null

    rec.add(
      'F 重取基线 = 新起点',
      '★★ 正例：**重取基线 ⇒ 连续不通过计数归零**，且旧基线算出的判定作废（不再拿旧结论拦人）',
      bad.denied === true &&
        afterBad.hash_gate_streak === 1 &&
        afterBad.hash_gate?.blocked === true &&
        rebase.ok === true &&
        rebase.origin?.changed === true &&
        afterRebase.baseline_current !== badBaseline &&
        afterRebase.hash_gate_streak === 0 &&
        afterRebase.hash_gate === null,
      [
        `第一次提交：denied=${bad.denied}　计数=${afterBad.hash_gate_streak}　blocked=${afterBad.hash_gate?.blocked}（基线 ${badBaseline}）`,
        `重取基线：ok=${rebase.ok === true}　新基线=${afterRebase.baseline_current}　origin.changed=${rebase.origin?.changed}`,
        `重取之后：计数=${afterRebase.hash_gate_streak}（期望 0）　hash_gate=${JSON.stringify(afterRebase.hash_gate)}（期望 null = 旧判定作废）`,
        '',
        '★ 这一条修的是**起点**：闸门判的是"相对基线的变化"，基线换了，旧基线下的连续次数就不该跟着走。',
      ].join('\n'),
    )

    rec.add(
      'F 重取基线 = 新起点',
      '★ 正例附带：重取基线**留痕**（`gate:hash_reset` 写清了清掉什么、以及为什么不算放宽）',
      resetLine !== null &&
        resetLine.prev_streak === 1 &&
        resetLine.now_streak === 0 &&
        resetLine.baseline_id === afterRebase.baseline_current &&
        typeof resetLine.why === 'string' &&
        resetLine.why.includes('一个字没放宽'),
      `gate:hash_reset 审计行：\n${indent(JSON.stringify(resetLine, null, 2))}`,
    )

    // --- ★ 关键反例：**真的越界仍然被拒**，而且计数从新基线重新起算 -----------
    await writeFile(join(f.h.projectRoot, 'src/other/oops2.js'), '// 又来一处清单外\n', 'utf8')
    const bad2 = await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, [{ path: 'src/all/new2.js', action: 'create', scope_id: s[0].id, lines: 1 }])
    const afterBad2 = snap(f.h, f.taskId)
    rec.add(
      'F 重取基线 = 新起点',
      '★★★ 反例（不许放宽）：重取基线**之后**真越界 ⇒ **仍然被拒**，计数**从新基线重新起算**（1，不是 2）',
      bad2.denied === true &&
        afterBad2.hash_gate_streak === 1 &&
        afterBad2.hash_gate?.blocked === true &&
        String(bad2.text).includes('哈希前置闸门') &&
        (afterBad2.hash_gate?.violations ?? []).some((v) => v.path === 'src/other/oops2.js') &&
        (afterBad2.hash_gate?.violations ?? []).every((v) => v.path !== 'src/other/oops.js'),
      [
        `重取基线后再交一次：denied=${bad2.denied}（期望 true —— 越界照拒）`,
        `计数=${afterBad2.hash_gate_streak}（期望 1 = 新基线下的第 1 次，不是旧基线的 1+1=2）`,
        `本次越界明细=${JSON.stringify((afterBad2.hash_gate?.violations ?? []).map((v) => `${v.how}:${v.path}`))}`,
        `（上一轮那处 src/other/oops.js 已经进了新基线 ⇒ 不再算越界，这正是"重取基线"的字面含义）`,
        '',
        '拒绝原文（末尾几行）：',
        indent(String(bad2.text).split('\n').slice(-5).join('\n')),
      ].join('\n'),
    )

    // --- ★ 已在盘上的卡死单也能救回来：旧基线遗留的判定在"读任务"时被清掉 ------
    //
    //  真单 T-20261011-214043 就是这个形状：14:46 判不过（旧基线 BL-8f0ae2…），
    //  14:50 主对话重取基线（BL-64c1eb000b1f10bf），可 `hash_gate`（含 blocked=true）
    //  与 `hash_gate_streak=1` 都**留在了旧基线上** —— 等不到下一次重取。
    {
      const f = await singleSeatFixture('legacy')
      open.push(f.h)
      const s = scopeOf(f)
      await mkdir(join(f.h.projectRoot, 'src/other'), { recursive: true })
      await writeFile(join(f.h.projectRoot, 'src/other/old.js'), '// 清单外\n', 'utf8')
      await submit({ h: f.h, taskId: f.taskId, tokens: f.tokens, agents: f.agents }, [{ path: 'src/all/legacy.js', action: 'create', scope_id: s[0].id, lines: 1 }])
      const stuck = snap(f.h, f.taskId)

      // 模拟"修复之前的重取"：直接改盘上的基线指针，**不清**计数与判定。
      const legacy = JSON.parse(JSON.stringify(stuck))
      legacy.baseline_current = 'BL-legacy-rebased'
      legacy.hash_gate_streak = 7
      legacy.hash_gate = { ...stuck.hash_gate, baseline_id: 'BL-old-origin', blocked: true }
      const file = join(f.h.projectRoot, '.pipeline', f.taskId, 'task.json')
      await writeFile(file, JSON.stringify(legacy), 'utf8')
      f.h.store.dropCache(f.taskId)

      const healed = await f.h.store.get(f.taskId) // 读盘 ⇒ 自愈
      const resetLine = (healed.history ?? []).find((x) => x.action === 'gate:hash_reset' && x.recovered_on_load === true) ?? null
      rec.add(
        'F 重取基线 = 新起点',
        '★★ 既有卡死单也能救回来：判定指向**非当前基线** ⇒ 读任务时清掉（含它带来的连续计数）',
        stuck.hash_gate?.blocked === true &&
          healed.hash_gate === null &&
          healed.hash_gate_streak === 0 &&
          resetLine !== null &&
          resetLine.prev_streak === 7 &&
          resetLine.baseline_id === 'BL-legacy-rebased',
        [
          `自愈前（盘上）：baseline_current=${legacy.baseline_current}　判定指向=${legacy.hash_gate.baseline_id}（stale）　blocked=${legacy.hash_gate.blocked}　计数=${legacy.hash_gate_streak}`,
          `自愈后：hash_gate=${JSON.stringify(healed.hash_gate)}　计数=${healed.hash_gate_streak}`,
          `留痕：${resetLine === null ? '（没有）' : `gate:hash_reset recovered_on_load=true prev_streak=${resetLine.prev_streak}`}`,
        ].join('\n'),
      )
      rec.add(
        'F 重取基线 = 新起点',
        '★ 自愈是**纯读**：判定已经指向当前基线时，读任务什么都不做（不写第二条 `gate:hash_reset`）',
        (await (async () => {
          const before = (snap(f.h, f.taskId).history ?? []).filter((x) => x.action === 'gate:hash_reset').length
          await f.h.store.get(f.taskId)
          await f.h.store.get(f.taskId)
          const after = (snap(f.h, f.taskId).history ?? []).filter((x) => x.action === 'gate:hash_reset').length
          return before === after
        })()),
        '连读两次任务，`gate:hash_reset` 条数不变（不刷屏）',
      )
    }

    // --- 纯读：没什么可清的时候不写第二条审计 --------------------------------
    //
    //  ⚠️ 上一段刚被拒过一次 ⇒ 此刻**确实还有东西要清**（基于上一个基线的判定）。
    //     所以先让它清掉（第二次重取），再**紧接着**重取第三次 —— 那一次才是"没东西可清"。
    const second = await f.h.store.takeBaseline({ taskId: f.taskId, by: 'main', note: '清掉上一条旧基线判定' })
    const clearsAfterSecond = (snap(f.h, f.taskId).history ?? []).filter((x) => x.action === 'gate:hash_reset').length
    const third = await f.h.store.takeBaseline({ taskId: f.taskId, by: 'main', note: '再重取一次（此时没有待清的计数与旧判定）' })
    const afterThird = snap(f.h, f.taskId)
    rec.add(
      'F 重取基线 = 新起点',
      '★ 纯读性质：没有待清的东西时 `changed=false`，**不写** `gate:hash_reset`（审计不会被这条刷屏）',
      second.ok === true &&
        second.origin?.changed === true &&
        clearsAfterSecond === 2 &&
        third.ok === true &&
        third.origin?.changed === false &&
        afterThird.hash_gate_streak === 0 &&
        (afterThird.history ?? []).filter((x) => x.action === 'gate:hash_reset').length === 2,
      `第二次重取（上一段刚拒过一次 ⇒ 还有旧判定要清）：origin.changed=${second.origin?.changed}（期望 true）\n` +
        `第三次重取（紧接其后，无新提交）：origin.changed=${third.origin?.changed}（期望 false）\n` +
        `计数=${afterThird.hash_gate_streak}　gate:hash_reset 条数=${(afterThird.history ?? []).filter((x) => x.action === 'gate:hash_reset').length}（期望 2 —— 第三次没写）`,
    )
  }

  // =========================================================================
  // D. ★★ 「谁改的」分账（T-20261011-56a37e 追加项 ①）—— **走真 store 的端到端对照**
  //
  //   为什么这一套必须走真 store 而不是只调纯函数：
  //     现象是"**测试席跑测试**留下的机器产物被算成**编写席**的未申报"，
  //     而"谁留下的脚印"这件事只存在于 `store.changeAudit()` 的**全量快照比对**里。
  //     纯函数那半（`hashGateVerdict`）只证明"拿到了机器产物会怎么算"；
  //     这里证明的是"真跑一遍测试之后，真提交 dev_to_test 时它确实被豁免"。
  //
  //   ★ 本组同时是**改前/改后对照**与**反例**，三条断言缺一不可：
  //     ① 改后：只有机器产物时 ⇒ `pass` 转真（豁免生效）
  //     ② 改前：同一份**真实 audit** 用严格模式重算 ⇒ `pass=false`、`undeclared` 里
  //        正是那两条机器产物（**这就是改前的形状，用同一份真实数据复现**）
  //     ③ ★ 反例：授权面内的**真实改动**没写进改动声明 ⇒ **照样 pass=false**，
  //        且 `undeclared` 里仍然出现那一条（证明闸门没被改松）
  // =========================================================================
  {
    const h = await createHarness({})
    open.push(h)
    const MAIN = 'hashgate-attr-main'
    const opened = await callTool(
      h,
      'pipeline_task_open',
      { requirement: '哈希闸门「谁改的」对照用例：改一处导出逻辑，并让测试台留下运行产物。', deliverable_format: '补丁 + 变更说明' },
      MAIN,
    )
    if (opened.denied) throw new Error(`开题失败：\n${opened.text}`)
    const taskId = opened.value.task_id
    const tokens = { main: opened.value.role_token }
    const agents = { main: MAIN }
    // ★ 授权面**同时**含源码目录与 `tests/` —— 这是现场的形状：
    //   计划把 `tests/` 也授了（要改测试），于是测试台写的运行产物**落在授权面内**。
    await runAnalysisThenPlan(h, {
      taskId,
      tokens,
      agents,
      tier: 'L2',
      reason: '「谁改的」分账对照：授权面含源码目录 + tests/',
      layers: [{ layer: 'all', scope_paths: ['src/all', 'tests'], deliverables: ['全部产物'] }],
      writers: {
        layers: ['all'],
        partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['src/all', 'tests'], deliverables: ['全部产物'] }],
        reason: '改动集中，单席位即可（count=1 是同一套机制的退化情形）',
      },
      // ⚠️ 必须**显式**给 changeScope：`runAnalysisThenPlan` 的缺省推导只取
      //    `scope_paths[0]`（一个层一条授权），那样 `tests/` 就不在授权面内了 ——
      //    而本组要验的恰恰是"**落在授权面内**的机器产物"。两条都显式列出。
      changeScope: [
        { id: 'CS1', path: 'src/all', action: 'modify', why: '夹具：源码目录在授权面内' },
        { id: 'CS2', path: 'tests', action: 'modify', why: '夹具：要改测试，所以 tests/ 也在授权面内（现场形状）' },
      ],
    })
    const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
    if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)
    tokens['writer#1'] = h.tokens.mint({ taskId, role: 'writer', seat: 'writer#1', agentId: 'attr-writer1', note: 'hashgate-attr' }).token
    agents['writer#1'] = 'attr-writer1'
    try {
      const { writeFile, mkdir } = await import('node:fs/promises')
      const root = h.projectRoot
      // 基线已由计划那一刻取好 ⇒ 这之后写的一切都算"动过"。
      // ① 编写**申报了**的那一处（授权面内）
      await mkdir(`${root}/src/all`, { recursive: true })
      await writeFile(`${root}/src/all/declared.js`, 'export const a = 1\n', 'utf8')
      // ② **测试台自己写的运行产物**（模拟测试席跑测试 —— 现场就是这一条把人绊住的）
      await mkdir(`${root}/tests`, { recursive: true })
      await writeFile(`${root}/tests/repro-check-last-run.txt`, '套件输出\n', 'utf8')

      const audit = await h.store.changeAudit({ taskId })
      const manifest = [{ path: 'src/all/declared.js', action: 'create', scope_id: 'CS1' }]
      const before = hashGateVerdict(audit, manifest, { exemptMachineArtifacts: false })
      const after = hashGateVerdict(audit, manifest)

      rec.add(
        'D 「谁改的」分账',
        '★★ 改后：编写席**没碰过**的测试运行产物（`tests/repro-check-last-run.txt`）不再被算成它的 undeclared ⇒ **pass 转真**',
        after.pass === true && after.counts.machine_artifacts === 1,
        `pass=${after.pass}　unauthorized=${after.counts.unauthorized}　undeclared=${after.counts.undeclared}　机器产物=${after.counts.machine_artifacts}\n` +
          `被豁免：${after.ignored_machine_artifacts.map((x) => x.path).join('、')}\n${after.summary}`,
      )
      rec.add(
        'D 「谁改的」分账',
        '★★ 改前形状（同一份**真实 audit** + 严格模式重算）：`pass=false`，`undeclared` 里正是那条运行产物 —— 这就是现场',
        before.pass === false && before.counts.unauthorized === 0 && before.counts.undeclared === 1 &&
          before.violations.some((x) => x.how === 'undeclared_change' && x.path === 'tests/repro-check-last-run.txt'),
        `pass=${before.pass}　unauthorized=${before.counts.unauthorized}　undeclared=${before.counts.undeclared}\n` +
          `命中的是：${before.violations.map((x) => `${x.how}:${x.path}`).join('、')}`,
      )
      rec.add(
        'D 「谁改的」分账',
        '★ 豁免**不静默**：被豁免的路径逐条落在 `ignored_machine_artifacts` 里（可审计，不靠 summary 措辞）',
        after.ignored_machine_artifacts.length === 1 && after.ignored_machine_artifacts[0].path === 'tests/repro-check-last-run.txt',
        JSON.stringify(after.ignored_machine_artifacts),
      )

      // ---- ★★ 反例：授权面内的**真实改动**没申报 ⇒ 照样被拒（证明没放松）----
      await writeFile(`${root}/src/all/a.js`, 'export const b = 2\n', 'utf8') // 授权面内，但**不写进声明**
      const audit2 = await h.store.changeAudit({ taskId })
      const neg = hashGateVerdict(audit2, manifest)
      rec.add(
        'D 「谁改的」分账',
        '★★ **反例（最关键）**：编写席真的改了**授权面内**的文件（`src/all/a.js`）却没写进改动声明 ⇒ **仍然 pass=false**，`undeclared` 里仍然出现那一条',
        neg.pass === false && neg.violations.some((x) => x.how === 'undeclared_change' && x.path === 'src/all/a.js'),
        `pass=${neg.pass}　undeclared=${neg.counts.undeclared}\n命中：${neg.violations.map((x) => `${x.how}:${x.path}`).join('、')}\n${neg.summary}`,
      )

      // ---- ★★ 豁免收回（P1-5 残余）：编写席**自己**产出的 *-last-run.txt 不算测试台产物 ----
      {
        const P = 'tests/sneaky-last-run.txt'
        const SHA = 'a'.repeat(64)
        const abs = (p) => `/proj/${String(p)}`.toLowerCase()
        const fake = { added: [{ path: P, sha256: SHA }], modified: [], removed: [], unauthorized: [], counts: { added: 1, modified: 0, removed: 0, unauthorized: 0 } }
        const row = (over) => ({ t: 'seat-write', at: '2026-10-15T00:00:00Z', task_id: 'T-SELF', role: 'writer', seat: 'writer#1', source: 'guard.write-allowed', paths: [{ key: abs(P), sha256: null }], ...over })
        const run = (ledger) => hashGateVerdict(fake, [], { absOfDeclared: abs, absOfTouched: abs, writeLedger: ledger, writeLedgerTaskId: 'T-SELF' })
        const control = run([])
        rec.add('D 豁免收回', '★ 对照：没人写过、没人申报过 ⇒ 当作测试台产物豁免（pass）', control.pass === true && control.counts.machine_artifacts === 1, control.summary)
        const declared = run([row({ source: 'handoff.dev_to_test', paths: [{ key: abs(P), sha256: SHA }] })])
        rec.add('D 豁免收回', '★★ 编写席申报过、哈希一致 ⇒ 豁免收回（落回"声明不实"）', declared.pass === false && declared.withdrawn_machine_artifacts.length === 1 && declared.violations.some((x) => x.how === 'undeclared_change' && x.path === P), JSON.stringify(declared.withdrawn_machine_artifacts))
        const touched = run([row({})])
        rec.add('D 豁免收回', '★★ 编写席**从没申报**、但守门看见它用写类工具写过 ⇒ 豁免同样收回（P1-5 残余的那条形态）', touched.pass === false && touched.withdrawn_machine_artifacts.length === 1 && touched.withdrawn_machine_artifacts[0].why.includes('写类工具写过'), JSON.stringify(touched.withdrawn_machine_artifacts))
        const byTester = run([row({ role: 'tester', seat: null })])
        rec.add('D 豁免收回', '★ 反例：写它的是测试席（测试台本来就该写运行产物）⇒ 照旧豁免', byTester.pass === true && byTester.counts.machine_artifacts === 1, byTester.summary)
        const otherTask = run([row({ task_id: 'T-OTHER' })])
        rec.add('D 豁免收回', '★ 反例：别的单的编写席写过 ⇒ 不算本单的产物，照旧豁免', otherTask.pass === true && otherTask.counts.machine_artifacts === 1, otherTask.summary)
      }

      // ---- ★ 反例 2：**落在授权面之外**的机器产物照样是越界（豁免吞不掉越界）----
      await mkdir(`${root}/outside`, { recursive: true })
      await writeFile(`${root}/outside/x-check-last-run.txt`, '越界目录里的机器产物\n', 'utf8')
      const audit3 = await h.store.changeAudit({ taskId })
      const out = hashGateVerdict(audit3, manifest)
      rec.add(
        'D 「谁改的」分账',
        '★★ **反例 2**：同样叫 `*-last-run.txt`，但落在**授权面之外** ⇒ 仍然进 `unauthorized`、仍然 `pass=false`（豁免只认授权面内的机器产物）',
        out.pass === false && out.counts.unauthorized >= 1 && out.violations.some((x) => x.path === 'outside/x-check-last-run.txt'),
        `pass=${out.pass}　unauthorized=${out.counts.unauthorized}　机器产物豁免=${out.counts.machine_artifacts}\n` +
          `命中：${out.violations.map((x) => `${x.how}:${x.path}`).join('、')}`,
      )

      // ---- ★ 反例 3：**源码**不是机器产物（`tests/*.mjs` 照旧要申报）----
      await writeFile(`${root}/tests/repro-helper.mjs`, 'export const c = 3\n', 'utf8')
      const audit4 = await h.store.changeAudit({ taskId })
      const srcNeg = hashGateVerdict(audit4, manifest)
      rec.add(
        'D 「谁改的」分账',
        '★★ **反例 3**：同一个 `tests/` 目录下的**源码**（`tests/repro-helper.mjs`）**不在**豁免名单里 ⇒ 照旧 `undeclared`（豁免名单收得很紧，只认运行产物）',
        srcNeg.pass === false && srcNeg.violations.some((x) => x.how === 'undeclared_change' && x.path === 'tests/repro-helper.mjs'),
        `pass=${srcNeg.pass}　undeclared=${srcNeg.counts.undeclared}\n命中：${srcNeg.violations.map((x) => `${x.how}:${x.path}`).join('、')}`,
      )
    } finally {
      /* 由 open[] 统一 dispose */
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
  lines.push('dsh-pipeline 哈希前置闸门自测（排在一切测试之前）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：先过哈希对比，哈希对比不过全量测试直接打回。')
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

// 直接跑：`node tests/hashgate-check.mjs`
if (process.argv[1] !== undefined && /hashgate-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runHashGateCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
