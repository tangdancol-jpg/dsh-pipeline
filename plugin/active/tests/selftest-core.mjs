/**
 * dsh-pipeline · 自测内核
 * ============================================================================
 * 同一个内核被两处使用：
 *   · `tests/selftest.mjs` —— 命令行跑（`node tests/selftest.mjs`）
 *   · `pipeline_selftest` 工具 —— 装完在真实环境里当场跑一遍
 *
 * ★ 它**不创建任何真实会话**：角色驱动走 `SimulatedTransport`（内存假会话），
 *   工作目录是一个临时目录、跑完即删。所以跑自测零副作用、零 token。
 *   这正好落实了需求原文那句"不要真的去创建/驱动真实会话来做测试"。
 *
 * ★ 它复刻了宿主的**拦截顺序**：`tools/pre-execute` → `guard` → dispatch。
 *   `callTool()` 先跑守门，守门返回字符串就**根本不调 execute** —— 与
 *   `dsh-tools/lib/index.js:3241-3257` 的行为一致。所以报告里能区分
 *   「guard 层拦下」与「execute 层拒绝」两条路径。
 *
 * ---------------------------------------------------------------------------
 * 写这份自测时踩到的三个坑（留在这里，免得改坏了没人知道为什么这么写）
 * ---------------------------------------------------------------------------
 *   ① **必须把宿主工具的替身注册进来**。守门要拦的是 `write` / `read` / `pwsh`
 *      这些**别人的**工具。第一版没注册它们，`callTool` 直接以"工具未注册"
 *      结束，`denied=true` —— 看起来像"被拦下了"，其实一个判据都没跑。
 *      所以 `expectDenied` 现在把 `layer==='missing'` 明确判成失败。
 *
 *   ② **关单会回收令牌**（`pipeline_close` 里 `tokens.revokeTask`）。第一版
 *      拿"已关单的任务"去测 ③测试改代码 之类的守卫，令牌早没了，守门自然不响。
 *      所以守卫类用例一律跑在**还活着的** fixture 任务上。
 *
 *   ③ **`tokens.list()` 回显的是截断令牌**（前 8 位 + 省略号，故意的，用于审计）。
 *      拿它当令牌去调用必然失败。令牌要从未截断的返回值里取。
 *
 * @module dsh-pipeline/tests/selftest-core
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * ★ 本次进程里建过、**还没被清掉**的临时目录。
 *
 * 为什么要登记：`mkdtemp` 建的目录靠各套自己 `rm`。某套抛异常或忘了清，
 * 目录就会永久留在 %TEMP%（实测积过 47 个，41 个里带着真 `.pipeline` 数据）。
 * 这些残留**不影响结果**（每次都是全新唯一目录、taskId 也唯一），
 * 但它们看起来像"外部残留"，会误导排查 —— 所以要能**查到**、能**断言**。
 */
const ownedTempDirs = new Set()

/** ★ 还没清掉的临时目录（run-all 用它断言"没有泄漏"）。 */
export function leakedTempDirs() {
  return [...ownedTempDirs].filter((d) => existsSync(d))
}

/** 文件原始字节的 sha256（十六进制）—— 架构图交接物的 `html_sha256` 必填且与盘上核对（缺陷 ⑰）。 */
export function fileSha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

import { mergeConfig } from '../lib/config.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { composeGuards, makeTaskIndexEntry } from '../lib/guard.js'
import { fullTestCredential } from '../lib/testscope.js'
import { hashGateBlocksTests, hashGateEscalationPending } from '../lib/hashgate.js'
import { createCallCounter } from '../lib/context.js'
import { createTaskStore } from '../lib/store.js'
import { createTokenStore } from '../lib/tokens.js'
import { buildTools } from '../lib/tools.js'
import { SimulatedTransport } from '../lib/transport/index.js'
import { TIERS, proposeTier } from '../lib/tiers.js'
import { pathKey } from '../lib/util.js'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** `defineTool` 的测试替身：注册表要的字段原样留着，不做参数校验。 */
const fakeDefineTool = (definition) => definition

/**
 * 宿主里那些**不属于本插件**、但守门要判的工具的替身（见文件头坑 ①）。
 * 替身本身什么也不做 —— 走到 execute 就说明守门**放行**了，这正是要观测的。
 */
export const HOST_TOOL_STUBS = {
  pwsh: { command: { type: 'string', required: true } },
  bash: { command: { type: 'string', required: true } },
  write: { path: { type: 'string', required: true }, content: { type: 'string' } },
  edit: { file_path: { type: 'string', required: true }, old_string: { type: 'string' }, new_string: { type: 'string' } },
  str_replace_editor: { command: { type: 'string' }, path: { type: 'string' } },
  read: { path: { type: 'string', required: true } },
  read_image: { file_path: { type: 'string', required: true } },
  // ★ 检索类替身：控制角色（主对话 / 需求分析 / 计划）"不得用检索工具翻源码树"
  //   这条判据判的就是这两个工具名 —— 不注册它们，那条判据会以
  //   「工具未注册」结束，看起来像"拦下了"，其实一个判据都没跑（正是文件头坑 ①）。
  grep: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
  glob: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
}

function hostStub(name) {
  return {
    name,
    description: `（自测替身）宿主的 ${name} 工具 —— 本插件不注册它，只是为了观察守门是否放行。`,
    parameters: HOST_TOOL_STUBS[name],
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, summary: { type: 'string', required: true } } },
      render: () => [],
    },
    async execute() {
      return { ok: true, summary: `（自测替身）${name} 已执行 —— 说明守门**放行**了它。` }
    },
  }
}

// ---------------------------------------------------------------------------
// 测试台
// ---------------------------------------------------------------------------

/**
 * 造一个测试台。
 *
 * @param {object} [opts]
 * @param {object} [opts.config] - 覆盖默认配置
 * @param {string} [opts.projectRoot]
 */
export async function createHarness(opts = {}) {
  const owned = opts.projectRoot === undefined
  const projectRoot = opts.projectRoot ?? (await mkdtemp(join(tmpdir(), 'dsh-pipeline-selftest-')))

  // ★ 兜底清理：这套自测正常结束时会 `rm` 掉自己建的临时目录；
  //   但**抛异常**或忘了清的时候，目录会永久留在 %TEMP%（实测积了 47 个）。
  //   这些残留不影响结果（每次 mkdtemp 都是全新唯一目录），但看着像"外部残留"，
  //   会误导排查 —— 所以在源头堵掉：进程一退出就同步删。
  if (opts.projectRoot === undefined) {
    const ownedDir = projectRoot
    ownedTempDirs.add(ownedDir)
    process.once('exit', () => {
      try {
        if (existsSync(ownedDir)) rmSync(ownedDir, { recursive: true, force: true })
        ownedTempDirs.delete(ownedDir)
      } catch {
        /* 退出时清不掉也不该影响退出码 */
      }
    })
  }
  const config = mergeConfig({ transport: 'simulated', spawnRoles: true, ...(opts.config ?? {}) })
  /**
   * ★ **授权面锚点**（与 `index.js` 的真实装配保持一致 —— 同上面那条注释里的坑）。
   *
   * 生产里锚点默认 = **插件包根**（`lib/config.js` 的 `changeScopeAnchor`），
   * 而夹具里"被改的那个包"就是这颗**临时项目根**（`src/…` 是包内相对路径）。
   * 所以测试台默认把锚点设成 `projectRoot` —— 这与既有 ~800 条断言的语义一致。
   *
   * 「锚点 ≠ 项目根」那个**真单形状**（包在 `<工作区根>/node_modules/<pkg>/` 之下）
   * 不靠这里，由 `tests/scope-check.mjs` 专设用例造，并显式传
   * `config: { changeScopeAnchor: … }` 覆盖。
   */
  const scopeAnchor = typeof config.changeScopeAnchor === 'string' && config.changeScopeAnchor.trim().length > 0
    ? config.changeScopeAnchor
    : projectRoot

  const tokens = createTokenStore()
  const store = createTaskStore({
    projectRoot,
    artifactDirName: config.artifactDirName,
    // ★ 必须与 index.js 一致：改动面审计与守门用**同一个锚点**
    scopeAnchor,
    maxReworkPerLeg: config.maxReworkPerLeg,
    // ⚠️ 必须与 index.js 的真实装配保持一致 —— 早先这里漏了 maxReworkPerLeg /
    //    hashGateEscalateAfter 这类开关，判据就会"在自测里是默认值、在线上是配置值"，
    //    而自测照样全绿。同一个坑踩过不止一次（见下面 indexTask 的注释）。
    hashGateEscalateAfter: config.hashGateEscalateAfter,
    humanRequestTimeoutHours: config.humanRequestTimeoutHours,
    requireHumanConfirmCode: config.requireHumanConfirmCode === true,
    maxClarifyRounds: config.maxClarifyRounds,
    // ★ 失联静默阈值也必须与 index.js 的真实装配一致（同上面那条注释里的坑）
    seatSilenceMs: config.seatSilenceMs,
  })
  const transport = new SimulatedTransport({ tokens })
  const taskIndex = new Map()
  const indexTask = (taskId, task) => {
    if (task === null || task === undefined) return
    const root = pathKey(task.project_root ?? projectRoot)
    // 用与生产（index.js）同一份构造函数 —— 否则 reportsDir 的语义会在
    // 自测与线上之间悄悄漂移，而自测还是绿的。
        // ⚠️ 必须与 index.js 的真实 `indexTask` 保持一致。
    //    早先这里漏了 `writers`，导致「编写席位越界写别人的分区」那条守门
    //    **根本没被跑到**，而自测却是全绿的 —— 假绿比红更危险。
    //    本轮又加了 `changeScope`（最小改动那条判据）—— 同一个坑，同样必须同步。
    //    紧跟其后又加了 `scopeAnchor`（授权面锚点：裸相对路径按它解析）—— 同一个坑。
    taskIndex.set(taskId, makeTaskIndexEntry({ taskId, projectRoot: root, pipelineDir: `${root}/${config.artifactDirName}`, scopeAnchor: task?.scope_anchor ?? scopeAnchor, writers: task?.roster?.writers ?? null, changeScope: task?.change_scope ?? null, fullTest: fullTestCredential(task ?? null), hashGateBlocked: hashGateBlocksTests(task ?? null), hashGate: task?.hash_gate ?? null, hashGateEscalated: hashGateEscalationPending(task ?? null),
      // ★★ T-20261011-56a37e（主管枢纽）：与 index.js 的真实装配**逐字段对齐** ——
      //   漏了这三个字段，守门侧那三条待机产物判据就会在自测里**根本没被跑到**，
      //   而自测照样全绿。同一个坑本文件已经写过两次警告，这是第三次。
      hubEnabled: task?.hub?.enabled === true,
      hubStandby: Array.isArray(task?.hub?.standby)
        ? task.hub.standby.map((s) => ({ role: String(s?.role ?? ''), wake_point: String(s?.wake_point ?? ''), status: s?.status === 'woken' ? 'woken' : 'standby' }))
        : [],
      devDelivered: (Array.isArray(task?.handoffs) ? task.handoffs : []).some((h) => h?.kind === 'dev_to_test') }))
  }

  // ⚠️ 这些依赖必须与 index.js 的 `deps` 保持一致 —— 早先漏了 writers，
  //    这次又漏了 counter / retireAgent。harness 与真实装配**任何一处不一致**，
  //    对应判据就会"没被跑到"，而自测可能照样是绿的。
  const counter = createCallCounter()
  const retiredAgents = new Set()
  const retireAgent = (agentId) => {
    if (typeof agentId === 'string' && agentId.length > 0) retiredAgents.add(agentId)
  }
  const tools = buildTools({
    defineTool: fakeDefineTool,
    ctx: { logger: { info() {}, warn() {}, debug() {} } },
    config,
    store,
    tokens,
    transport,
    indexTask,
    counter,
    retireAgent,
  })
  const byName = new Map(Object.values(tools).map((t) => [t.name, t]))
  for (const n of Object.keys(HOST_TOOL_STUBS)) byName.set(n, hostStub(n))
  /** ★ 守门的"索引未命中"提示（自测要断言它**真的报了**，而不是静默放行）。 */
  const guardWarnings = []
  const guard = createGuardFor({
    tokens,
    config,
    taskIndex,
    counter,
    retired: retiredAgents,
    warn: (m) => guardWarnings.push(String(m)),
  })

  return { projectRoot, owned, config, tokens, store, transport, taskIndex, indexTask, tools, byName, guard, guardWarnings }
}

/** 清理临时目录。 */
export async function disposeHarness(h) {
  try {
    h.tokens.clear()
    h.taskIndex.clear()
    if (h.owned === true && h.projectRoot.includes('dsh-pipeline-selftest-')) {
      await rm(h.projectRoot, { recursive: true, force: true })
    }
  } catch {
    /* 清不掉不影响结论 */
  }
}

/**
 * 按宿主的顺序调一次工具：**先守门，后 dispatch**。
 *
 * @returns {{denied:boolean, layer:'guard'|'execute'|'missing'|'passed', text:string, value?:any}}
 */
export async function callTool(h, toolName, args, agentId) {
  const exec = {
    name: toolName,
    arguments: args ?? {},
    ...(agentId === undefined || agentId === null ? {} : { agent: { id: agentId } }),
  }
  const denial = h.guard(exec)
  if (denial !== undefined) return { denied: true, layer: 'guard', text: String(denial) }

  const def = h.byName.get(toolName)
  if (def === undefined) return { denied: true, layer: 'missing', text: `工具 ${toolName} 未注册（自测自身的问题）` }

  const out = await def.execute(exec.arguments, exec)
  const ok = out !== null && typeof out === 'object' && out.ok === true
  return { denied: !ok, layer: ok ? 'passed' : 'execute', text: String(out?.summary ?? JSON.stringify(out)), value: out }
}

/**
 * ★ 按任务的**改动基线**造一份合法的 `change_audit`（夹具专用）。
 *
 * 用户要求：审核必须交「前后版本对比结论」（有基线时必填），而且 store 会**自己再算一遍**
 * 核对 `baseline_id` 与 `verdict` —— 所以夹具不能瞎填，得真去问一次。
 *
 * ★ **缺陷 ⑤（2026-10-15）之后 L0 也有基线了**：规则引擎在角色清单写入后自动记一次
 *   （`lib/store/l0-baseline.js`）⇒ 这条判据**对 L0 同样生效**，正例必须真的交一份。
 *   L0 没有授权面，所以 `changeAudit` 给的是第三种结论 `no_scope`（"越界/少改"不适用，
 *   只给前后差异）—— 本夹具照抄工具的真实结论，不手编。
 *
 * @param {object} h - `createHarness()` 的产物（要 `h.store`）
 * @param {string} taskId
 * @returns {Promise<{change_audit?:object}>} 没有基线时返回 `{}`（那条判据真的不适用）
 */
export async function auditFor(h, taskId) {
  const t = typeof h?.store?.peek === 'function' ? h.store.peek(taskId) : null
  const base = typeof h?.store?.currentBaseline === 'function' ? h.store.currentBaseline(t) : null
  if (base === null) return {}
  const res = await h.store.changeAudit({ taskId })
  if (res.ok !== true) return {}
  return {
    change_audit: {
      baseline_id: res.baseline.baseline_id,
      verdict: res.verdict,
      added: res.added.map((x) => x.path),
      modified: res.modified.map((x) => x.path),
      removed: res.removed.map((x) => x.path),
      unauthorized: res.unauthorized.map((x) => x.path),
      missing: res.missing.map((x) => x.path),
      note: '夹具：按基线比对的实际结论',
    },
  }
}

// ---------------------------------------------------------------------------
// ★ 本轮新增：需求 → 用户确认 → 计划 → 分配 —— 把这条链**一次走完**的夹具
// ---------------------------------------------------------------------------

/**
 * ★ 按任务的**授权改动面**造一份合法的 `change_manifest`（夹具专用）。
 *
 * 设计目的（最小改动）要求：有授权面的任务，`dev_to_test` 必须交出"实际动了哪些文件"，
 * 且每条都要引用一个授权条目（`scope_id`）。夹具当然要按这个规矩来 ——
 * 否则测的就不是真实用法。
 *
 * L0 任务没有计划站 ⇒ 没有授权面 ⇒ 返回 `{}`（那条判据不适用）。
 *
 * @param {object} store - `createHarness()` 返回的 store
 * @param {string} taskId
 * @param {{index?:number, path?:string, lines?:number}} [opts]
 * @returns {{change_manifest?:object[]}}
 */
export function manifestFor(store, taskId, opts = {}) {
  const t = typeof store?.peek === 'function' ? store.peek(taskId) : null
  const scope = Array.isArray(t?.change_scope) ? t.change_scope : []
  if (scope.length === 0) return {}
  const idx = Number.isInteger(opts.index) ? Math.max(0, Math.min(scope.length - 1, opts.index)) : 0
  const entry = scope[idx]
  return {
    change_manifest: [
      {
        path: opts.path ?? entry.path,
        action: entry.action === 'create' ? 'create' : entry.action === 'delete' ? 'delete' : 'modify',
        scope_id: entry.id,
        lines: Number.isInteger(opts.lines) ? opts.lines : 3,
        note: '夹具：按授权面动了一处',
      },
    ],
  }
}
/**
 * 走完「需求分析 → 用户人工确认 → 计划（自检 + 分配 AI）」。
 *
 * 为什么抽成公共函数：本轮把原先一个「编排判断」拆成了**两站**
 * （`orchestrator` 出分析结论、`planner` 出角色清单），而且中间**强制**夹一次
 * 用户确认。任何需要 L1+ 角色清单的用例都得走这条链 —— 复制三份必然漂移。
 *
 * ⚠️ 它**不**代替用户拍板：第 ③ 步必须给出用户答复来源与原话（与真实链路同一条判据）。
 *
 * @param {object} h - `createHarness()` 的产物
 * @param {object} ctx
 * @param {string} ctx.taskId
 * @param {Record<string,string>} ctx.tokens - 至少要有 main；orchestrator/planner 缺失会自动派
 * @param {Record<string,string>} ctx.agents
 * @param {string} [ctx.tier]
 * @param {string} [ctx.reason]
 * @param {object} [ctx.writers]
 * @param {object} [ctx.relayPolicy]
 * @param {string[]} [ctx.unclearPoints]
 * @param {string[]} [ctx.acceptance]
 * @param {string[]} [ctx.testPoints]
 * @param {string[]} [ctx.boundaries]
 * @param {string[]} [ctx.planSteps]
 * @param {object[]} [ctx.layers]
 * @returns {Promise<{analysis:object, human:object, plannerDispatch:object, plan:object, tokens:object, agents:object}>}
 */
export async function runAnalysisThenPlan(h, ctx) {
  const { taskId } = ctx
  const tokens = ctx.tokens
  const agents = ctx.agents
  const MAIN = agents.main

  // --- ① 派需求分析 --------------------------------------------------------
  if (tokens.orchestrator === undefined || tokens.orchestrator.length === 0) {
    const d = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'orchestrator', spawn: false, role_token: tokens.main }, MAIN)
    if (d.denied) throw new Error(`夹具：派需求分析失败：\n${d.text}`)
    agents.orchestrator = d.value?.agent_id ?? 'manual-orchestrator'
    tokens.orchestrator = d.value?.token ?? ''
  }

  // --- ② 需求分析出结论（任务卡 + 验收标准 + **需求不清楚处清单**）----------
  const acceptance = ctx.acceptance ?? ['功能按需求实现', '有独立测试且通过', '审核通过']
  const testPoints = ctx.testPoints ?? ['正常路径', '边界值', '失败路径']
  const boundaries = ctx.boundaries ?? ['不改动既有公开接口']
  const unclearPoints = ctx.unclearPoints ?? []

  const analysis = await callTool(
    h,
    'pipeline_orchestrate',
    {
      task_id: taskId,
      acceptance,
      test_points: testPoints,
      boundaries,
      unclear_points: unclearPoints,
      analysis_reason: '按用户原话拆解；验收标准逐条可判定；未声明的事一律不做。',
      role_token: tokens.orchestrator,
    },
    agents.orchestrator,
  )
  if (analysis.denied) throw new Error(`夹具：需求分析失败：\n${analysis.text}`)

  // --- ③ 提请**用户**确认（澄清前置到人工）--------------------------------
  const human = await callTool(
    h,
    'pipeline_human_request',
    {
      task_id: taskId,
      reason_kind: 'requirement_confirmation',
      question_for_human:
        unclearPoints.length > 0
          ? `需求分析列出了 ${unclearPoints.length} 处不清楚的地方（第一条：${String(unclearPoints[0]).slice(0, 60)}）。要按分析里的理解往下做吗？`
          : '需求分析没有发现不清楚的地方，验收标准与边界都列出来了。可以按这份理解往下做吗？',
      context_for_human: '这是开工前的一次确认：确认之后才会把需求交给计划 AI 去切分与分配。',
      blocking: true,
      blocked_stage: '需求确认',
      urgency: 'blocking',
      decision_kind: 'yes_no',
      timeout_behavior: 'stay_blocked',
      role_token: tokens.orchestrator,
    },
    agents.orchestrator,
  )
  if (human.denied) throw new Error(`夹具：需求确认请求失败：\n${human.text}`)

  const rid = human.value?.request_id ?? ''
  const relay = await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid, role_token: tokens.main }, MAIN)
  if (relay.denied) throw new Error(`夹具：转告失败：\n${relay.text}`)
  const reply = await callTool(
    h,
    'pipeline_human_reply',
    {
      task_id: taskId,
      request_id: rid,
      user_quote: '就按这份理解做，验收标准和边界我看过了，没问题。',
      reply_channel: 'chat',
      attribution: '用户在当前会话里直接回复',
      answer: true,
      role_token: tokens.main,
    },
    MAIN,
  )
  if (reply.denied) throw new Error(`夹具：记用户答复失败：\n${reply.text}`)

  // --- ④ 主对话推进到「待计划」（没有用户答复这一步过不去）----------------
  const confirmed = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'requirement_confirmed', role_token: tokens.main }, MAIN)
  if (confirmed.denied) throw new Error(`夹具：需求确认后推进失败：\n${confirmed.text}`)

  // --- ⑤ 派计划 AI ---------------------------------------------------------
  const dp = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'planner', spawn: false, role_token: tokens.main }, MAIN)
  if (dp.denied) throw new Error(`夹具：派计划 AI 失败：\n${dp.text}`)
  agents.planner = dp.value?.agent_id ?? 'manual-planner'
  tokens.planner = dp.value?.token ?? ''

  // --- ⑥ 出计划 → 自检 → 分配 AI ------------------------------------------
  //
  // ★ 可选早退：`ctx.stopBeforePlan === true` ⇒ 停在「计划中」就交还现场。
  //   为什么需要：有些判据**只在计划那一站成立**（例如"授权面变更只在待开发生效"、
  //   "计划自检缺口要回流"），而走完 ⑥ 之后任务已经到了「待开发」——
  //   再想复刻「计划中」就得把整条链重走一遍。默认 false，老调用方一个字不用改。
  if (ctx.stopBeforePlan === true) {
    return { analysis, human, relay, reply, confirmed, plannerDispatch: dp, plan: null, tokens, agents, stopBeforePlan: true }
  }
  const layers = ctx.layers ?? []
  // ★ 设计目的（最小改动 / 职责自限）：这三样是 plan 的**必填**字段。
  //   缺省值由夹具按"授权改动面 = 各席位的 scope_paths"推出来 —— 与真实用法一致：
  //   计划授权哪些路径，编写就只能动哪些。
  const changeScope =
    ctx.changeScope ??
    (Array.isArray(ctx.writers?.partitions) && ctx.writers.partitions.length > 0
      ? ctx.writers.partitions.map((p, i) => ({
          id: `CS${i + 1}`,
          path: (p.scope_paths ?? ['.'])[0],
          action: 'modify',
          why: `夹具：${p.layer ?? p.seat} 这一层的改动就在这个路径下`,
        }))
      : [{ id: 'CS1', path: '.', action: 'modify', why: '夹具：单席位，范围是整棵项目根' }])
  // 角色边界卡：必须覆盖 tier 的全部执行角色（store 会核对覆盖性）
  const execRoles = ctx.execRoles ?? TIERS[ctx.tier ?? 'L2'].execution
  const roleBoundaries =
    ctx.roleBoundaries ??
    execRoles.map((r) => ({
      role: r,
      only: [`只干「${r}」这一份活`],
      not: ['不干别人的活', '不扩大改动面（改动面必须与授权面相等）'],
    }))
  const roleScope =
    ctx.roleScope ?? {
      will_do: ['出计划、自检、分配 AI（角色清单 / 席位 / 层）'],
      will_not_do: ['不改需求（需求分析结论与需求档都不是我写的）', '不写实现、不读代码、不跑测试', '不自己执行任务'],
    }
  const plan = await callTool(
    h,
    'pipeline_plan',
    {
      task_id: taskId,
      plan_steps: ctx.planSteps ?? ['冻结接口契约', '按层实现', '各层自测后交测试', '测试通过交审核'],
      layers,
      self_check_verdict: 'ok',
      self_check_checked: ['需求覆盖（验收标准逐条有落点）', '层边界（各层写的路径互不重叠）', '依赖顺序（接口先冻结再并行）', '验收标准可测'],
      self_check_gaps: [],
      plan_reason: '按接口/数据/处理三层并行；接口先冻结，避免两个席位在边界上互相改。',
      change_scope: changeScope,
      // ★ 越界清单：这次不许做什么（给 writer 与 reviewer 一起看）
      forbidden:
        ctx.forbidden ?? [
          '不许顺手重构（改动面必须与授权面相等）',
          '不许改测试（测试是 tester 的活）',
          '不许扩大范围（要扩就得先拿新授权）',
          '不许改依赖',
        ],
      role_boundaries: roleBoundaries,
      role_scope: roleScope,
      tier: ctx.tier ?? 'L2',
      reason: ctx.reason ?? '跨模块改动、需要冻结接口契约，按层并行推进',
      ...(ctx.writers === undefined ? {} : { writers: ctx.writers }),
      ...(ctx.relayPolicy === undefined ? {} : { relay_policy: ctx.relayPolicy }),
      acceptance,
      test_points: testPoints,
      boundaries,
      role_token: tokens.planner,
    },
    agents.planner,
  )
  if (plan.denied) throw new Error(`夹具：计划/分配失败：\n${plan.text}`)

  return { analysis, human, relay, reply, confirmed, plannerDispatch: dp, plan, tokens, agents, changeScope, roleBoundaries }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

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

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

/** 断言"这次调用必须被拒"，并把拒绝原文收进报告。 */
function expectDenied(rec, group, name, res, mustContain = []) {
  // `layer==='missing'` 不算"被拦下"（见文件头坑 ①）。
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => typeof s === 'string' && s.length > 0 && !hit(res.text, s))
  const pass = ok && missing.length === 0
  const why = !ok
    ? `期望被拒但结果是：denied=${res.denied} layer=${res.layer}`
    : missing.length > 0
      ? `拒绝原文里缺少关键片段：${missing.join(' ｜ ')}`
      : ''
  rec.add(group, name, pass, pass ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}` : `${why}\n实际原文：\n${indent(res.text)}`)
  return pass
}

/**
 * 检查一个"关键片段"是否命中。
 *
 * 片段里带 `|` 表示**任一即可** —— 同一条越权在不同的身份解析路径上会得到不同的
 * 拒绝文案（例如"令牌已与会话绑定，不可转手"和"会话身份冲突"其实是同一条规则的
 * 两种触发方式），断言不该把它们钉死成某一种，否则改一处措辞就冒出一堆假红。
 */
function hit(text, fragment) {
  return String(fragment)
    .split('|')
    .some((a) => a.length > 0 && text.includes(a))
}

/** 断言"这次调用必须成功"。 */
function expectOk(rec, group, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => typeof s === 'string' && s.length > 0 && !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    group,
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒了（layer=${res.layer}）${missing.length > 0 ? `，或缺少关键片段：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

// ---------------------------------------------------------------------------
// 正例：一个需求走完全流程
// ---------------------------------------------------------------------------

/**
 * 正例：编排 → 编写 → 测试 → 审核 → 关单。
 *
 * `stopAfter` 让用例可以在任意一步停下来 —— 守卫类用例必须跑在**还活着的**
 * 任务上（关单会回收令牌），而且不同守卫只在自己那个状态下才成立
 * （例如"审核旧版本"必须停在「审核中」）。
 *
 *   1 开单(pending) 2 编排(ready_dev) 3 派编写(developing) 4 编写交测试(ready_test)
 *   5 派测试(testing) 6 测试交审核(ready_review) 7 派审核(reviewing)
 *   8 审核OK(passed) 9 关单(closed)
 *
 * @param {object} [opts]
 * @param {number} [opts.stopAfter] - 走到第几步为止（默认 9）
 * @param {boolean} [opts.close] - 兼容旧写法：false 等价于 stopAfter=7
 * @param {string} [opts.requirement]
 * @param {object} [opts.recorder]
 */
export async function runHappyPath(opts = {}) {
  const h = await createHarness(opts)
  const rec = opts.recorder
  const stop = Number.isInteger(opts.stopAfter) ? opts.stopAfter : opts.close === false ? 7 : 9
  const MAIN = 'selftest-main'
  const requirement = opts.requirement ?? '写一个函数 fizzbuzz(n)，返回 1 到 n 的 FizzBuzz 字符串数组。'
  const states = []
  let taskId = null
  let mainToken = null
  let writerAgent = null
  let writerToken = null
  let testerAgent = null
  let testerToken = null
  let reviewerAgent = null
  let reviewerToken = null
  let v1 = null
  let orch = null
  const at = (label) => states.push([label, h.store.peek(taskId)?.state ?? '(未开单)'])

  // --- 1) 开单 ------------------------------------------------------------
  const opened = await callTool(h, 'pipeline_task_open', { requirement, deliverable_format: '补丁 + 变更说明 + 可运行命令' }, MAIN)
  if (opened.denied) throw new Error(`正例第 1 步（开单）失败：\n${opened.text}`)
  taskId = opened.value.task_id
  mainToken = opened.value.role_token
  at('开单')
  if (stop < 2) return finish()

  // --- 2) 编排判断 --------------------------------------------------------
  orch = await callTool(h, 'pipeline_orchestrate', { task_id: taskId, requirement, role_token: mainToken }, MAIN)
  if (orch.denied) throw new Error(`正例第 2 步（编排）失败：\n${orch.text}`)
  at('编排完成')

  // --- 2.5) ★ 留档 AI：汇总出唯一的需求档（更正 A）-------------------------
  //
  //   L1+ 的 requirement.md 由**留档 AI** 汇总产生，编排不直接写它。
  //   没有档之前，除编排与留档之外的派活会被"没有留档就不许开工"拦住。
  //   （L0 没有留档 AI，编排那一步已经直接落档。）
  if ((h.store.peek(taskId)?.roster?.tier ?? 'L0') !== 'L0') {
    const dA = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'archivist', role_token: mainToken }, MAIN)
    if (dA.denied) throw new Error(`正例第 2.5 步（派留档）失败：\n${dA.text}`)
    const srcOrch = (h.store.peek(taskId)?.records ?? []).find((x) => x.role === 'orchestrator')
    if (srcOrch === undefined) throw new Error('正例第 2.5 步：编排没有提交自己那份记录')
    const comp = await callTool(
      h,
      'pipeline_compile_requirement',
      {
        task_id: taskId,
        role_token: dA.value.token,
        entries: [
          { section: '需求原文', text: requirement, source_record: srcOrch.record_id },
          { section: '验收标准', text: '1. fizzbuzz 正确\n2. 有单元测试\n3. 审核通过', source_record: srcOrch.record_id },
        ],
      },
      dA.value.agent_id,
    )
    if (comp.denied) throw new Error(`正例第 2.5 步（留档汇总）失败：\n${comp.text}`)
  }
  if (stop < 3) return finish()

  // --- 3) 派编写 ----------------------------------------------------------
  const dW = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'writer', role_token: mainToken }, MAIN)
  if (dW.denied) throw new Error(`正例第 3 步（派编写）失败：\n${dW.text}`)
  writerAgent = dW.value.agent_id
  writerToken = dW.value.token
  at('派编写后')

  const art = await callTool(
    h, 'pipeline_artifact',
    { task_id: taskId, content: 'export function fizzbuzz(n){ /* … */ }', file_name: 'fizzbuzz.js', role_token: writerToken },
    writerAgent,
  )
  if (art.denied) throw new Error(`正例第 3 步（登记制品）失败：\n${art.text}`)
  v1 = art.value.version

  const writerShell = await callTool(h, 'pwsh', { command: 'node -e "console.log(1)"' }, writerAgent)
  rec?.add('正例', '编写角色有写权限：它的 shell 不被拦', writerShell.denied !== true, `layer=${writerShell.layer}\n${writerShell.text}`)
  const writerWrite = await callTool(h, 'write', { path: join(h.projectRoot, 'fizzbuzz.js'), content: '// writer edits source' }, writerAgent)
  rec?.add('正例', '编写角色可以改项目源码（这是它的正当工作）', writerWrite.denied !== true, `layer=${writerWrite.layer}\n${writerWrite.text}`)
  if (stop < 4) return finish()

  // --- 4) 编写交测试 ------------------------------------------------------
  const devHandoff = await callTool(
    h, 'pipeline_handoff',
    {
      task_id: taskId, kind: 'dev_to_test', role_token: writerToken,
      payload: {
        task_id: taskId, artifact_version: v1,
        patch_or_code: 'diff --git a/fizzbuzz.js b/fizzbuzz.js\n+ export function fizzbuzz(n){ /* … */ }',
        change_note: '新增 fizzbuzz 函数',
        run_commands: ['node --test tests/'],
        selftest_result: '本地跑通，n=15 输出正确',
        known_issues: [],
        acceptance_map: { '1 到 n 的 FizzBuzz 数组': 'fizzbuzz.js' },
      },
    },
    writerAgent,
  )
  if (devHandoff.denied) throw new Error(`正例第 4 步（编写交测试）失败：\n${devHandoff.text}`)
  at('编写交测试后')
  if (stop < 5) return finish()

  // --- 5) 派测试 ----------------------------------------------------------
  const dT = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'tester', role_token: mainToken }, MAIN)
  if (dT.denied) throw new Error(`正例第 5 步（派测试）失败：\n${dT.text}`)
  testerAgent = dT.value.agent_id
  testerToken = dT.value.token
  at('派测试后')

  // ⚠️ 这里原来写的是 `node --test tests/` —— 那是**整套跑**，本轮起归"全量测试"，
    //    要有四级凭据才放行（见 tests/fulltest-check.mjs）。本用例验的是"tester 的 shell 不被拦"，
    //    所以换成一条**真的只读**命令；全量那件事另有专门的套在测。
    const testerShell = await callTool(h, 'pwsh', { command: 'node --version' }, testerAgent)
    rec?.add('正例', '测试角色跑只读命令不被拦', testerShell.denied !== true, `layer=${testerShell.layer}\n${testerShell.text}`)
  if (stop < 6) return finish()

  // --- 6) 测试交审核 ------------------------------------------------------
  const testHandoff = await callTool(
    h, 'pipeline_handoff',
    {
      task_id: taskId, kind: 'test_to_review', role_token: testerToken,
      payload: {
        task_id: taskId, artifact_version: v1,
        test_cases: ['n=1 → ["1"]', 'n=3 → ["1","2","Fizz"]', 'n=15 含 FizzBuzz', 'n=0 → []'],
        execution_result: '4/4 通过',
        failure_logs: [],
        pass_evidence: ['node --test 输出 4 pass 0 fail', '边界 n=0 与 n=1 均覆盖'],
        risk_notes: ['未覆盖超大 n 的性能'],
        verdict: 'pass',
      },
    },
    testerAgent,
  )
  if (testHandoff.denied) throw new Error(`正例第 6 步（测试交审核）失败：\n${testHandoff.text}`)
  at('测试交审核后')
  if (stop < 7) return finish()

  // --- 7) 派审核 ----------------------------------------------------------
  const dR = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'reviewer', role_token: mainToken }, MAIN)
  if (dR.denied) throw new Error(`正例第 7 步（派审核）失败：\n${dR.text}`)
  reviewerAgent = dR.value.agent_id
  reviewerToken = dR.value.token
  at('派审核后')
  if (stop < 8) return finish()

  // --- 8) 审核发 OK -------------------------------------------------------
  const verdict = await callTool(
    h, 'pipeline_handoff',
    {
      task_id: taskId, kind: 'review_verdict', role_token: reviewerToken,
      payload: {
        task_id: taskId, artifact_version: v1, conclusion: 'OK',
        risk_notes: ['未覆盖超大 n 的性能（已由测试标注）'],
        release_approved: true,
        security: cleanSecurity(),
        final_delivery_note: `交付 fizzbuzz 函数，制品 ${v1}，测试 4/4 通过。`,
        acceptance_check: { '1 到 n 的 FizzBuzz 数组': 'pass' },
        /**
         * ★★ **缺陷 ⑤ 的连带要求**：L0 现在也有改动基线了 ⇒
         *   「有基线就必须交前后版本对比结论」这条**对 L0 同样生效**。
         *   所以正例照规矩交一份 —— 而且不是手编的，是真去问一次工具（`auditFor`）。
         */
        ...(await auditFor(h, taskId)),
      },
    },
    reviewerAgent,
  )
  if (verdict.denied) throw new Error(`正例第 8 步（审核发 OK）失败：\n${verdict.text}`)
  at('审核 OK 后')
  if (stop < 9) return finish()

  // --- 9) 关单 ------------------------------------------------------------
  const closed = await callTool(h, 'pipeline_close', { task_id: taskId, role_token: mainToken, note: '审核 OK，放行' }, MAIN)
  if (closed.denied) throw new Error(`正例第 9 步（关单）失败：\n${closed.text}`)
  at('关单后')
  return finish(closed.value)

  function finish(closeValue = null) {
    return {
      harness: h,
      taskId,
      tier: orch.value?.tier ?? null,
      aiCount: orch.value?.ai_count ?? null,
      states,
      version: v1,
      state: h.store.peek(taskId)?.state ?? null,
      agents: { main: MAIN, writer: writerAgent, tester: testerAgent, reviewer: reviewerAgent },
      tokens: { main: mainToken, writer: writerToken, tester: testerToken, reviewer: reviewerToken },
      closeValue,
    }
  }
}

/**
 * ★ 一份"干净"的安全确认段（自测夹具用）。
 *
 * 安全确认是 review_verdict 的**必填**段 —— 所以每个走完整流程的夹具都要造一份。
 * 真实用法是调 pipeline_security_check 扫一遍、把返回的 checks_ref 填进来；
 * 这里为了不依赖磁盘扫描，直接给一份形状合法的。
 *
 * @param {object} [over]
 * @returns {object}
 */
export function cleanSecurity(over = {}) {
  return {
    // ★ 用 **sha256 形状**的依据，而不是假路径：
    //   关单闸会检查"路径形状的 checks_ref 是否真实存在"，夹具给假路径会撞上那条闸
    //   （那条闸本身由 security-check 的反例④d 专门验，这里不需要重复触发）。
    local_leak: { checked: true, evidence: ['自测夹具：制品只有一行代码，未见密钥/凭证特征'], checks_ref: ['sha256:0000000000000000fixturelocalfixture'] },
    network: { checked: true, evidence: ['自测夹具：产物无出网调用'], checks_ref: ['sha256:0000000000000000fixturenetfixture00'] },
    attestation: 'clean',
    checked_by: 'reviewer',
    checks_ref: ['sha256:0000000000000000fixturescanreport0000'],
    findings: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 守卫夹具：一个**还活着**的任务（见文件头坑 ②）
// ---------------------------------------------------------------------------

/**
 * 建一个"三个角色都派出去了、但任务没关单"的夹具，用来测守卫类判据。
 * 关单会回收令牌，所以守卫用例绝不能跑在已关单的任务上。
 *
 * @param {object} [opts]
 * @param {number} [opts.stopAfter] - 停在第几步（默认 5=testing；7=reviewing；8=passed）
 */
export async function createGuardFixture(opts = {}) {
  const f = await runHappyPath({ stopAfter: 5, ...opts })
  return { ...f, h: f.harness }
}

// ---------------------------------------------------------------------------
// 自测主入口
// ---------------------------------------------------------------------------

/**
 * 跑完整自测。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.verbose] - 是否在报告里带上完整拒绝原文（默认 true）
 * @returns {Promise<{passed:number, total:number, text:string, items:object[]}>}
 */
export async function runSelfTest(opts = {}) {
  const verbose = opts.verbose !== false
  const rec = createRecorder()
  const lines = []
  const log = (s = '') => lines.push(s)
  const open = []

  log('='.repeat(78))
  log('dsh-pipeline 自测：正例全流程 + 反例越权跳步 + 分档验证')
  log('='.repeat(78))

  // =========================================================================
  // 正例
  // =========================================================================
  let happy = null
  try {
    happy = await runHappyPath({ recorder: rec })
    open.push(happy.harness)
  } catch (err) {
    rec.add('正例', '全流程跑通', false, String(err?.message ?? err))
  }

  if (happy !== null) {
    const h = happy.harness
    const EXPECTED = 'pending→ready_dev→developing→ready_test→testing→ready_review→reviewing→passed→closed'
    const actual = happy.states.map((s) => s[1]).join('→')
    rec.add('正例', '全流程状态轨迹正确（9 个状态一步不跳）', actual === EXPECTED, `期望：${EXPECTED}\n实际：${happy.states.map((s) => `${s[0]}=${s[1]}`).join(' → ')}`)
    rec.add('正例', '档位=L0、独立对话数=4（主/编写/测试/审核）', happy.tier === 'L0' && happy.aiCount === 4, `tier=${happy.tier} ai_count=${happy.aiCount}`)

    const dir = join(h.projectRoot, '.pipeline', happy.taskId)
    let handoffFiles = []
    try {
      handoffFiles = await readdir(join(dir, 'handoffs'))
    } catch {
      handoffFiles = []
    }
    rec.add(
      '正例',
      '结构化交接物逐个落盘（<项目>/.pipeline/<任务>/handoffs/*.json）',
      handoffFiles.length === 3 && existsSync(join(dir, 'task.json')) && existsSync(join(dir, 'audit.jsonl')) && existsSync(join(dir, 'artifacts', happy.version)),
      `handoffs/：${handoffFiles.join(', ')}\n` +
        `task.json：${existsSync(join(dir, 'task.json'))}  audit.jsonl：${existsSync(join(dir, 'audit.jsonl'))}  artifacts/${happy.version}：${existsSync(join(dir, 'artifacts', happy.version))}`,
    )

    const audit = await h.store.auditLog(happy.taskId)
    const actions = audit.map((a) => a.action)
    const need = ['open', 'roster:set', 'handoff:dev_to_test', 'transition:dev_submitted', 'handoff:test_to_review', 'transition:test_passed', 'handoff:review_verdict', 'transition:review_ok', 'close']
    rec.add(
      '正例',
      '全流程可查询可追溯（audit.jsonl 覆盖每个环节）',
      need.every((a) => actions.includes(a)),
      `缺失：${need.filter((a) => !actions.includes(a)).join(', ') || '（无）'}\n实际：${actions.join(', ')}`,
    )

    const task = await h.store.get(happy.taskId)
    rec.add(
      '正例',
      '制品版本化 + 关单留痕（close_report 记录了放行依据）',
      task.artifacts.length === 1 && task.close_report !== null && typeof task.close_report.review_ok_handoff === 'string',
      `artifacts=${task.artifacts.map((a) => `${a.version}(sha256 ${a.sha256.slice(0, 8)}…)`).join(', ')}\nclose_report=${JSON.stringify(task.close_report)}`,
    )

    const st = await h.store.status({ taskId: happy.taskId, redactForMain: true })
    const redacted = JSON.stringify(st.handoffs)
    rec.add(
      '正例',
      '主对话视图脱敏（看不到补丁正文与运行命令）',
      redacted.includes('已隐去正文') && !redacted.includes('diff --git'),
      `status.handoffs 里出现"已隐去正文"：${redacted.includes('已隐去正文')}\n出现原始补丁文本：${redacted.includes('diff --git')}`,
    )
  }

  // =========================================================================
  // 反例 ①：编写直接提交审核
  // =========================================================================
  {
    // 停在「审核中」：三个角色都已派出、令牌都活着 —— 这样下面既能让编写越权，
    // 也能让测试/审核互相越权（只停在开发中的话后两个角色的令牌还不存在）。
    const f = await createGuardFixture({ stopAfter: 7 })
    open.push(f.h)
    const res = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'review_verdict',
        role_token: f.tokens.writer,
        payload: {
          task_id: f.taskId,
          artifact_version: f.version,
          conclusion: 'OK',
          risk_notes: [],
          release_approved: true,
          final_delivery_note: '我写完了，直接放行吧。',
        },
      },
      f.agents.writer,
    )
    expectDenied(rec, '反例①编写直接提交审核', '编写调 pipeline_handoff(kind=review_verdict)', res, ['角色越权', '不能直接把产物提交审核'])

    const res2 = await callTool(f.h, 'pipeline_transition', { task_id: f.taskId, event: 'review_ok', role_token: f.tokens.writer }, f.agents.writer)
    expectDenied(rec, '反例①编写直接提交审核', '编写调 pipeline_transition(event=review_ok)', res2, ['角色越权'])

    const res3 = await callTool(f.h, 'pipeline_transition', { task_id: f.taskId, event: 'test_passed', role_token: f.tokens.writer }, f.agents.writer)
    expectDenied(rec, '反例①编写直接提交审核', '编写调 pipeline_transition(event=test_passed)（想跳过测试）', res3, ['角色越权'])

    const res4 = await callTool(f.h, 'pipeline_handoff', { task_id: f.taskId, kind: 'test_to_review', role_token: f.tokens.writer, payload: {} }, f.agents.writer)
    expectDenied(rec, '反例①编写直接提交审核', '编写冒充测试提交 test_to_review', res4, ['角色越权'])

    // 反向也不能：测试不能替审核发结论。
    const res5 = await callTool(f.h, 'pipeline_handoff', { task_id: f.taskId, kind: 'review_verdict', role_token: f.tokens.tester, payload: {} }, f.agents.tester)
    expectDenied(rec, '反例①编写直接提交审核', '测试冒充审核发 review_verdict', res5, ['角色越权'])
    // 审核不能替编写提交产物。
    const res6 = await callTool(f.h, 'pipeline_handoff', { task_id: f.taskId, kind: 'dev_to_test', role_token: f.tokens.reviewer, payload: {} }, f.agents.reviewer)
    expectDenied(rec, '反例①编写直接提交审核', '审核冒充编写提交 dev_to_test', res6, ['角色越权'])
  }

  // =========================================================================
  // 反例 ②：无 OK 关单
  // =========================================================================
  {
    const h = await createHarness()
    open.push(h)
    const MAIN = 'neg2-main'
    const req = '写一个函数 add(a,b) 返回两数之和。'
    const o = await callTool(h, 'pipeline_task_open', { requirement: req }, MAIN)
    const tid = o.value.task_id
    const mt = o.value.role_token
    await callTool(h, 'pipeline_orchestrate', { task_id: tid, requirement: req, role_token: mt }, MAIN)

    const close1 = await callTool(h, 'pipeline_close', { task_id: tid, role_token: mt }, MAIN)
    expectDenied(rec, '反例②无 OK 关单', '任务还在「待开发」就关单', close1, ['拒绝关单'])

    const dw = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'writer', role_token: mt }, MAIN)
    await callTool(h, 'pipeline_artifact', { task_id: tid, content: 'x', role_token: dw.value.token }, dw.value.agent_id)
    const v = (await h.store.get(tid)).artifacts[0].version
    await callTool(h, 'pipeline_handoff', {
      task_id: tid, kind: 'dev_to_test', role_token: dw.value.token,
      payload: { task_id: tid, artifact_version: v, patch_or_code: 'p', change_note: 'c', run_commands: ['x'], selftest_result: 'ok', known_issues: [] },
    }, dw.value.agent_id)
    const dt = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'tester', role_token: mt }, MAIN)
    await callTool(h, 'pipeline_handoff', {
      task_id: tid, kind: 'test_to_review', role_token: dt.value.token,
      payload: { task_id: tid, artifact_version: v, test_cases: ['c1'], execution_result: '1/1', failure_logs: [], pass_evidence: ['e1'], risk_notes: [], verdict: 'pass' },
    }, dt.value.agent_id)
    const dr = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'reviewer', role_token: mt }, MAIN)

    const close2 = await callTool(h, 'pipeline_close', { task_id: tid, role_token: mt }, MAIN)
    expectDenied(rec, '反例②无 OK 关单', '任务已到「审核中」但审核没发 OK 就关单', close2, ['拒绝关单', '不存在有效的审核 OK'])
    rec.add('反例②无 OK 关单', '关单事件在状态机层面也不可用（第二道闸）', (await h.store.get(tid)).state === 'reviewing', `当前状态：${(await h.store.get(tid)).state}；close 只从 passed 出发`)

    const ng = await callTool(h, 'pipeline_handoff', {
      task_id: tid, kind: 'review_verdict', role_token: dr.value.token,
      payload: {
        task_id: tid, artifact_version: v, conclusion: 'NG', risk_notes: ['边界没覆盖'],
        release_approved: false, final_delivery_note: '不通过', reject_to: 'writer', reject_reason: '边界条件缺失',
        security: cleanSecurity(),
        /** ★ 缺陷 ⑤ 的连带要求：L0 也有基线了 ⇒ 有基线就必须交前后版本对比结论（NG 同样要交）。 */
        ...(await auditFor(h, tid)),
      },
    }, dr.value.agent_id)
    expectOk(rec, '反例②无 OK 关单', '（前置）审核发 NG 正常受理并打回编写', ng, ['审核结论', '打回'])
    const close3 = await callTool(h, 'pipeline_close', { task_id: tid, role_token: mt }, MAIN)
    expectDenied(rec, '反例②无 OK 关单', '审核 NG 之后关单依然被拒', close3, ['拒绝关单'])

    // NG 会把上一轮的 OK 作废 —— 这条用另一个任务验。
    await disposeHarness(h)
  }

  // =========================================================================
  // 反例 ③：测试/审核改代码
  // =========================================================================
  {
    // 停在「审核中」：测试与审核的会话都已存在。（默认夹具停在「测试中」，审核还没被
    // 派出去 —— 那样"审核改代码"这一条根本无从测起，会得到一个假绿。）
    const f = await createGuardFixture({ stopAfter: 7 })
    open.push(f.h)
    const h = f.h
    // ★ 诊断本轮起是**能力边界**：每个角色的 `writes` 在守门里落成路径判据。
    //   tester 是 `own-dir`（只写 reports/tester/tester*），所以它改源码时
    //   撞上的是"你只能写自己那一片"，而不是过去那句"不得修改项目源码制品"。
    //   判据更强、文案更具体 —— 断言跟着换（行为是**收紧**，不是放宽）。
    const r1 = await callTool(h, 'write', { path: join(h.projectRoot, 'src', 'fizzbuzz.js'), content: '// 我替编写改了' }, f.agents.tester)
    expectDenied(rec, '反例③测试/审核改代码', '测试用 write 改项目源码', r1, ['只能写**自己那一片**', 'reports/tester'])
    const r2 = await callTool(h, 'edit', { file_path: join(h.projectRoot, 'fizzbuzz.js'), old_string: 'a', new_string: 'b' }, f.agents.tester)
    expectDenied(rec, '反例③测试/审核改代码', '测试用 edit 改项目源码', r2, ['只能写**自己那一片**'])
    const r3 = await callTool(h, 'write', { path: join(h.projectRoot, 'x.js'), content: 'x' }, f.agents.reviewer)
    // ★ 审核是 `own-log`（比 own-dir 更窄：只有日志扩展名），拒它的理由同样按能力给。
    expectDenied(rec, '反例③测试/审核改代码', '审核用 write 改项目源码（现在被"只能写自己那一片"那条更严的判据拦下）', r3, ['只能写**自己那一片**', 'reports/reviewer'])
    const r4 = await callTool(h, 'pwsh', { command: `Set-Content -Path "${join(h.projectRoot, 'fizzbuzz.js')}" -Value "// 测试偷偷改代码"` }, f.agents.tester)
    expectDenied(rec, '反例③测试/审核改代码', '测试用 shell 旁路改项目源码', r4, ['不得通过 shell 修改项目文件'])
    const r5 = await callTool(
      h,
      'write',
      { path: join(h.projectRoot, '.pipeline', f.taskId, 'reports', 'tester', 'tester-test-report.md'), content: '# 测试报告' },
      f.agents.tester,
    )
    expectOk(rec, '反例③测试/审核改代码', '（对照）测试写**自己那一片**（reports/tester/）放行', r5, ['放行'])
    const r6 = await callTool(
      h,
      'write',
      { path: join(h.projectRoot, '.pipeline', f.taskId, 'reports', 'test-report.md'), content: '# 旧位置' },
      f.agents.tester,
    )
    expectDenied(rec, '反例③测试/审核改代码', '★ 对照：测试写 reports/ **根下**（旧位置，现在不给）→ 拒', r6, ['只能写**自己那一片**'])
  }

  // =========================================================================
  // 反例 ④：主对话自行增删角色
  // =========================================================================
  {
    const f = await createGuardFixture()
    open.push(f.h)
    const h = f.h
    const r1 = await callTool(h, 'pipeline_roster_review', { task_id: f.taskId, request_id: 'RR-x', approve: true, role_token: f.tokens.main }, f.agents.main)
    expectDenied(rec, '反例④主对话自行增删角色', '主对话自己批角色变更（roster_review）', r1, ['角色越权', '必须由「计划 AI」复核'])

    // 真流程：编写提出申请 → 主对话想批（被拒）→ 编排复核批准 → 新清单生效。
    const need = await callTool(h, 'pipeline_roster_request', {
      task_id: f.taskId, add: ['security'], reason: '发现需求里有凭证处理，建议加安全审计角色。', role_token: f.tokens.writer,
    }, f.agents.writer)
    expectOk(rec, '反例④主对话自行增删角色', '（前置）编写提出角色变更申请', need, ['角色变更申请已登记'])
    const reqId = need.value?.request_id ?? ''

    const mainApprove = await callTool(h, 'pipeline_roster_review', { task_id: f.taskId, request_id: reqId, approve: true, role_token: f.tokens.main }, f.agents.main)
    expectDenied(rec, '反例④主对话自行增删角色', '主对话批这条申请（被拒）', mainApprove, ['角色越权'])

    const orchDispatch = await callTool(h, 'pipeline_dispatch', { task_id: f.taskId, role: 'orchestrator', role_token: f.tokens.main, spawn: true }, f.agents.main)
    // L0 清单里没有 orchestrator —— 主对话必须走「申请→复核」，而复核只有 orchestrator 能做。
    // 这恰好暴露了 L0 的一个真实限制，下面单独记一条。
    rec.add(
      '反例④主对话自行增删角色',
      'L0 配置下没有独立编排对话 → 角色变更复核路径不可达（已知限制，见 README）',
      orchDispatch.denied === true && orchDispatch.text.includes('不在本任务的角色清单里'),
      `派 orchestrator 被拒：\n${indent(orchDispatch.text)}`,
    )
  }
  {
    // L1 任务：走通「需求分析 → 用户确认 → 计划分配 → 申请 → 计划复核 → 新清单」。
    const h = await createHarness()
    open.push(h)
    const MAIN = 'neg4b-main'
    const req = '给订单接口加一个按状态过滤的查询参数，并补上单元测试。'
    const o = await callTool(h, 'pipeline_task_open', { requirement: req }, MAIN)
    const tid = o.value.task_id
    const mt = o.value.role_token
    const orch = await callTool(h, 'pipeline_orchestrate', { task_id: tid, requirement: req, role_token: mt, dry_run: true }, MAIN)
    rec.add('反例④主对话自行增删角色', '（前置）L1 需求被规则引擎正确判档', orch.value?.tier === 'L1', `tier=${orch.value?.tier}\n${orch.text}`)

    // ★ 本轮起：角色清单由**计划 AI** 产出，而且中间**强制**一次用户确认。
    const planned = await runAnalysisThenPlan(h, {
      taskId: tid,
      tokens: { main: mt },
      agents: { main: MAIN },
      tier: 'L1',
      reason: '涉及接口与单元测试，需要独立验证；不需要架构与安全角色。',
      acceptance: ['带 status 参数的查询返回正确子集', '未知 status 返回空列表而非报错'],
      testPoints: ['边界：status 为空、未知值、多个值'],
    })
    expectOk(rec, '反例④主对话自行增删角色', '（前置）需求分析 → 用户确认 → 计划分配产出 L1 清单', planned.plan, ['角色清单已产出'])
    const planTok = planned.tokens.planner
    const planAgent = planned.agents.planner

    // ★ L1 的需求档由留档 AI 汇总产生 —— 不补这一步，下面的派活会被"没有留档就不许开工"拦住。
    const dA2 = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'archivist', role_token: mt }, MAIN)
    expectOk(rec, '反例④主对话自行增删角色', '（前置）派出留档 AI', dA2, ['已派出'])
    {
      const src = (h.store.peek(tid)?.records ?? []).find((x) => x.role === 'planner')
      if (src === undefined) throw new Error('夹具问题：计划 AI 没有提交自己那份记录')
      const comp = await callTool(
        h,
        'pipeline_compile_requirement',
        {
          task_id: tid,
          role_token: dA2.value.token,
          entries: [
            { section: '需求原文', text: req, source_record: src.record_id },
            { section: '验收标准', text: '1. 带 status 参数的查询返回正确子集\n2. 未知 status 返回空列表', source_record: src.record_id },
          ],
        },
        dA2.value.agent_id,
      )
      expectOk(rec, '反例④主对话自行增删角色', '（前置）留档 AI 汇总出需求档', comp, ['需求档已汇总'])
    }

    // 主对话不能自己改清单
    const badDispatch = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'security', role_token: mt }, MAIN)
    expectDenied(rec, '反例④主对话自行增删角色', '主对话直接派清单外的 security（加人）', badDispatch, ['不在本任务的角色清单里', '主对话不能自己决定加人减人'])

    const dW = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'writer', role_token: mt }, MAIN)
    const need = await callTool(h, 'pipeline_roster_request', {
      task_id: tid, add: ['security'], reason: '需求里出现了对外接口与参数校验，建议加安全审计。', role_token: dW.value.token,
    }, dW.value.agent_id)
    expectOk(rec, '反例④主对话自行增删角色', '编写提出角色变更申请', need, ['角色变更申请已登记'])
    const reqId = need.value.request_id

    const mainApprove = await callTool(h, 'pipeline_roster_review', { task_id: tid, request_id: reqId, approve: true, role_token: mt }, MAIN)
    expectDenied(rec, '反例④主对话自行增删角色', '主对话批这条申请（被拒）', mainApprove, ['角色越权'])

    // ★ 设计目的（职责自限）：**中途加人 = 加一张新边界卡**。
    //   计划里的卡覆盖的是分配那一刻的执行角色；现在加了个 security，
    //   所以这次复核**必须**顺带给出它的边界卡 —— 否则新角色派活时就没有
    //   "只干什么、不干什么"可依据（setRoster 会拒）。
    const missingCard = await callTool(h, 'pipeline_roster_review', { task_id: tid, request_id: reqId, approve: true, note: '先不给边界卡试试', role_token: planTok }, planAgent)
    expectDenied(rec, '反例④主对话自行增删角色', '★ 计划 AI 加人却不给新角色的边界卡 → 拒（边界卡必须覆盖每个执行角色）', missingCard, [
      '角色边界卡没覆盖',
      'security',
      'role_boundaries',
    ])

    const approved = await callTool(
      h,
      'pipeline_roster_review',
      {
        task_id: tid,
        request_id: reqId,
        approve: true,
        note: '对外接口 + 参数校验确实有安全面，同意加。',
        role_boundaries: [{ role: 'security', only: ['只做安全/合规审计'], not: ['不改代码', '不写测试', '不扩大改动面'] }],
        role_token: planTok,
      },
      planAgent,
    )
    expectOk(rec, '反例④主对话自行增删角色', '计划 AI 复核批准（带新角色边界卡）→ 角色清单被改写', approved, ['新清单'])
    const after = await h.store.get(tid)
    rec.add(
      '反例④主对话自行增删角色',
      '新清单生效且可追溯（execution_roles 含 security，reason 里留了申请与复核意见）',
      after?.roster !== null && after?.roster !== undefined && after.roster.execution_roles.includes('security') && after.roster.reason.includes('角色变更'),
      `execution_roles=${after?.roster?.execution_roles?.join('/') ?? '(roster 为空)'}\nai_count=${after?.roster?.ai_count}\nreason=${after?.roster?.reason ?? '-'}`,
    )
    const nowOk = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'security', role_token: mt }, MAIN)
    expectOk(rec, '反例④主对话自行增删角色', '（闭环）复核后主对话按新清单派 security 放行', nowOk, ['已派出'])
  }

  // =========================================================================
  // 反例 ⑤：打回次数超限
  // =========================================================================
  {
    const h = await createHarness({ config: { maxReworkPerLeg: 2 } })
    open.push(h)
    const MAIN = 'neg5-main'
    const req = '写一个函数 add(a,b) 返回两数之和。'
    const o = await callTool(h, 'pipeline_task_open', { requirement: req }, MAIN)
    const tid = o.value.task_id
    const mt = o.value.role_token
    await callTool(h, 'pipeline_orchestrate', { task_id: tid, requirement: req, role_token: mt }, MAIN)

    let last = null
    let thirdDispatchOk = false
    for (let round = 1; round <= 4; round++) {
      const dw = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'writer', role_token: mt }, MAIN)
      if (round === 3) thirdDispatchOk = dw.denied !== true
      if (dw.denied) {
        last = dw
        break
      }
      await callTool(h, 'pipeline_artifact', { task_id: tid, content: `round ${round}`, role_token: dw.value.token }, dw.value.agent_id)
      const task = await h.store.get(tid)
      const v = task.artifacts.at(-1).version
      await callTool(h, 'pipeline_handoff', {
        task_id: tid, kind: 'dev_to_test', role_token: dw.value.token,
        payload: { task_id: tid, artifact_version: v, patch_or_code: `p${round}`, change_note: `c${round}`, run_commands: ['x'], selftest_result: 'ok', known_issues: [] },
      }, dw.value.agent_id)
      const dt = await callTool(h, 'pipeline_dispatch', { task_id: tid, role: 'tester', role_token: mt }, MAIN)
      if (dt.denied) {
        last = dt
        break
      }
      const rw = await callTool(h, 'pipeline_rework', { task_id: tid, target: 'writer', reason: `第 ${round} 轮发现缺陷`, role_token: dt.value.token }, dt.value.agent_id)
      last = rw
      if (rw.denied) break
    }

    expectDenied(rec, '反例⑤打回次数超限', 'maxReworkPerLeg=2：前 2 次打回成功、第 3 次打回被拒', last, ['打回次数超限', '不能无限打回'])
    const task = await h.store.get(tid)
    rec.add(
      '反例⑤打回次数超限',
      '超限后任务不会死结：预算用尽后编写仍派得出去，打回被拒后状态停在「测试中」等人工',
      task.rework.dev === 2 && thirdDispatchOk && task.state === 'testing',
      `rework=${JSON.stringify(task.rework)}  state=${task.state}  第 3 轮派编写成功=${thirdDispatchOk}\n` +
        '（这条断言是给一个真 bug 留的回归：第一版把 rework_budget 也挂在了\n' +
        ' 「已打回编写 → 派编写」这条边上，于是第 2 次打回成功后编写再也派不出去，\n' +
        ' 任务永久卡死。现在预算只在**打回那一刻**扣一次；超限时打回被拒，\n' +
        ' 任务停在「测试中」，由 block 或仲裁角色接手。）',
    )
    // 预算用尽后仍可交人工
    const blk = await callTool(h, 'pipeline_transition', { task_id: tid, event: 'block', role_token: mt, note: '打回预算用尽，交人工' }, MAIN)
    expectOk(rec, '反例⑤打回次数超限', '（出路）预算用尽后仍可用 block 交人工介入', blk, ['已阻塞'])
  }

  // =========================================================================
  // 反例 ⑥：主对话读代码
  // =========================================================================
  {
    const f = await createGuardFixture()
    open.push(f.h)
    const h = f.h
    const r1 = await callTool(h, 'read', { path: join(h.projectRoot, 'fizzbuzz.js') }, f.agents.main)
    expectDenied(rec, '反例⑥主对话读代码', '主对话用 read 读项目源码正文', r1, ['主对话不得读取代码正文', '不读代码'])
    const r2 = await callTool(h, 'pwsh', { command: `Get-Content "${join(h.projectRoot, 'fizzbuzz.js')}"` }, f.agents.main)
    expectDenied(rec, '反例⑥主对话读代码', '主对话用 shell 读项目源码正文', r2, ['不得通过 shell 读取项目代码'])
    const r3 = await callTool(h, 'read', { path: join(h.projectRoot, '.pipeline', f.taskId, 'task.json') }, f.agents.main)
    expectOk(rec, '反例⑥主对话读代码', '（对照）主对话读任务卡放行（那是它该看的）', r3, ['放行'])
  }

  // =========================================================================
  // 反例 ⑦：令牌伪造 / 跨任务 / 转手
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 7 })
    open.push(f.h)
    const h = f.h

    const r2 = await callTool(h, 'pipeline_close', { task_id: f.taskId, role_token: 'PT-伪造的令牌' }, f.agents.main)
    // ★ 2026-10-11：文案从合并的「无效或已过期」**拆成两支**（见 lib/tokens.js 的 missingTokenError）。
    //   伪造的令牌走的是「表里根本没有」那一支 ⇒ 必须说清"DSH 重启会让令牌表整个丢失"，
    //   而**不许**把重启丢失说成"过期"（那正是当初误导现场 AI 的地方）。
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '伪造令牌（表里没有 ⇒ 文案要点出"重启会丢"这一支）', r2, ['role_token 无效', '重启'])

    const r3 = await callTool(h, 'pipeline_close', { task_id: f.taskId }, 'unknown-agent')
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '无令牌、无绑定的会话调用流水线工具', r3, ['role_token', '绑定'])

    // 跨任务：**同一个测试台**里开第二张单，拿它的令牌操作第一张 —— 这样才是真的
    // "跨任务"，而不是"两个互不相识的令牌表"。
    const o2 = await callTool(h, 'pipeline_task_open', { requirement: '写一个函数 sub(a,b) 返回两数之差。' }, 'second-main')
    const secondTask = o2.value.task_id
    const r1 = await callTool(h, 'pipeline_close', { task_id: f.taskId, role_token: o2.value.role_token }, 'second-main')
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '拿另一张单的主对话令牌关这张单', r1, ['属于任务'])
    const r1b = await callTool(h, 'pipeline_close', { task_id: secondTask, role_token: f.tokens.main }, f.agents.main)
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '反向：拿这张单的令牌去关另一张单', r1b, ['属于任务'])

    // 令牌转手：把测试的令牌交给编写的会话用 —— 会话绑定优先于令牌。
    const r4 = await callTool(h, 'pipeline_handoff', {
      task_id: f.taskId, kind: 'test_to_review', role_token: f.tokens.tester,
      payload: { task_id: f.taskId, artifact_version: f.version, test_cases: ['c'], execution_result: '1/1', failure_logs: [], pass_evidence: ['e'], risk_notes: [], verdict: 'pass' },
    }, f.agents.writer)
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '把测试令牌交给编写会话使用（会话绑定优先于令牌）', r4, ['令牌不可转手|身份冲突'])

    // 一个会话想在同一任务里兼任第二个角色。
    const r5 = await callTool(h, 'pipeline_bind_role', { role_token: f.tokens.tester }, f.agents.main)
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '一个会话想在同一任务里兼任第二个角色', r5, ['只能担任一个角色|不能改绑'])

    // 守护层面也拦：编写会话带着审核令牌调关单。
    const r6 = await callTool(h, 'pipeline_close', { task_id: f.taskId, role_token: f.tokens.reviewer }, f.agents.writer)
    expectDenied(rec, '反例⑦令牌伪造与跨任务', '编写会话拿审核令牌调 pipeline_close（守护层拦）', r6, ['角色越权'])
  }

  // =========================================================================
  // 反例 ⑧：版本一致性（审核/测试对着旧版本干活）
  // =========================================================================
  {
    // 停在「审核中」：这正是审核该出结论的状态，也是版本判据唯一能生效的状态。
    const f = await createGuardFixture({ stopAfter: 7 })
    open.push(f.h)
    const h = f.h

    // 编写又登记了 v2（模拟"改完又交了"），当前有效制品是 v1（没走完交测试那步），
    // 所以 v2 是"尚未经过测试的版本" —— 审核不能对它出结论。
    await h.store.registerArtifact({ taskId: f.taskId, actorRole: 'writer', content: 'v2 内容', fileName: 'v2.txt' })
    const task = await h.store.get(f.taskId)
    rec.add('反例⑧版本一致性', '（前置）制品已登记到 v2，但有效制品仍是 v1（v2 没走测试）', task.artifacts.length === 2 && (await h.store.artifactVersion(f.taskId)) === 'v1',
      `artifacts=${task.artifacts.map((a) => a.version).join(', ')}  有效制品=${await h.store.artifactVersion(f.taskId)}`)

    const r = await callTool(h, 'pipeline_handoff', {
      task_id: f.taskId, kind: 'review_verdict', role_token: f.tokens.reviewer,
      payload: {
        task_id: f.taskId, artifact_version: 'v2', conclusion: 'OK', risk_notes: [], release_approved: true, final_delivery_note: 'ok', security: cleanSecurity(),
        /**
         * ★ **缺陷 ⑤ 的连带要求**：L0 现在也有基线 ⇒「有基线就必须交前后版本对比结论」
         *   对 L0 生效。**先把该交的证据交齐**，这一条反例才测得到它要测的那件事
         *   （版本不一致），而不是被"缺证据"先盖住。
         */
        ...(await auditFor(h, f.taskId)),
      },
    }, f.agents.reviewer)
    expectDenied(rec, '反例⑧版本一致性', '审核对未经测试的 v2 出结论', r, ['不一致'])

    // 测试对着错误版本写报告（停在 testing 的夹具）。
    const f2 = await createGuardFixture({ stopAfter: 5 })
    open.push(f2.h)
    const r2 = await callTool(f2.h, 'pipeline_handoff', {
      task_id: f2.taskId, kind: 'test_to_review', role_token: f2.tokens.tester,
      payload: { task_id: f2.taskId, artifact_version: 'v9', test_cases: ['c'], execution_result: '1/1', failure_logs: [], pass_evidence: ['e'], risk_notes: [], verdict: 'pass' },
    }, f2.agents.tester)
    expectDenied(rec, '反例⑧版本一致性', '测试报告写着不存在的制品版本', r2, ['不一致'])

    // 正对照：版本对上就放行。
    const okRes = await callTool(f2.h, 'pipeline_handoff', {
      task_id: f2.taskId, kind: 'test_to_review', role_token: f2.tokens.tester,
      payload: { task_id: f2.taskId, artifact_version: f2.version, test_cases: ['c'], execution_result: '1/1', failure_logs: [], pass_evidence: ['e'], risk_notes: [], verdict: 'pass' },
    }, f2.agents.tester)
    expectOk(rec, '反例⑧版本一致性', '（对照）版本一致时测试报告正常提交', okRes, ['测试报告交审核'])
  }

  // =========================================================================
  // 反例 ⑨：与另一个守护共存（单调语义）
  // =========================================================================
  {
    const f = await createGuardFixture()
    open.push(f.h)
    const h = f.h
    // 模拟 dsh-archigate 那种"只拒不放"的守护。
    const otherGuard = (exec) =>
      exec?.name === 'pwsh' && String(exec.arguments?.command ?? '').includes('archify.mjs')
        ? '[archigate] 拦下了一条绕过编排工具的 archify 交付命令。'
        : undefined

    const combined = composeGuards(otherGuard, h.guard)
    const exec1 = { name: 'pwsh', arguments: { command: 'node archify.mjs finalize x.json' }, agent: { id: f.agents.tester } }
    const r1 = combined(exec1)
    rec.add('反例⑨与其它守护共存', '别人的拒绝不会被本插件翻回允许', typeof r1 === 'string' && r1.includes('[archigate]'), `组合结果：${r1}`)

    const exec2 = { name: 'pwsh', arguments: { command: `Set-Content "${join(h.projectRoot, 'a.js')}" 1` }, agent: { id: f.agents.tester } }
    const r2 = combined(exec2)
    rec.add('反例⑨与其它守护共存', '本插件的拒绝也不会被别人翻回允许', typeof r2 === 'string' && r2.includes('[pipeline]'), `组合结果：${String(r2).slice(0, 120)}`)

    const combined2 = composeGuards(h.guard, otherGuard)
    const r3 = combined2(exec1)
    const r4 = combined2(exec2)
    rec.add(
      '反例⑨与其它守护共存',
      '交换注册顺序结论不变（单调，谁都不能翻谁的盘）',
      typeof r3 === 'string' && typeof r4 === 'string' && r4.includes('[pipeline]'),
      `先 pipeline 后 archigate：archify 命令 → ${String(r3).slice(0, 60)}… / 写源码 → ${String(r4).slice(0, 60)}…`,
    )
    // 无关调用必须放行（守门只约束流水线参与者）
    const exec3 = { name: 'read', arguments: { path: 'C:/somewhere/else/notes.md' }, agent: { id: f.agents.tester } }
    rec.add('反例⑨与其它守护共存', '与流水线无关的路径不受影响', h.guard(exec3) === undefined, `结果：${h.guard(exec3)}`)
    const exec4 = { name: 'read', arguments: { path: 'x.md' }, agent: { id: 'a-completely-unrelated-agent' } }
    rec.add('反例⑨与其它守护共存', '未绑定角色的会话完全不受本守门约束', h.guard(exec4) === undefined, `结果：${h.guard(exec4)}`)
  }

  // =========================================================================
  // 反例 ⑩：守门自身健壮性
  // =========================================================================
  {
    const f = await createGuardFixture()
    open.push(f.h)
    const h = f.h
    let threw = null
    const weird = [
      { name: 'write', arguments: null, agent: { id: f.agents.tester } },
      { name: 'pipeline_close', arguments: undefined, agent: null },
      { name: 'pipeline_close', arguments: { task_id: 42 }, agent: { id: 42 } },
      { name: 'pipeline_handoff', arguments: { kind: 'review_verdict', role_token: 123 }, agent: { id: f.agents.writer } },
      { name: '', arguments: {}, agent: {} },
      { name: 'pwsh', arguments: { command: 'x'.repeat(300000) }, agent: { id: f.agents.tester } },
    ]
    const outputs = []
    for (const w of weird) {
      try {
        outputs.push(h.guard(w))
      } catch (err) {
        threw = String(err?.message ?? err)
      }
    }
    rec.add('反例⑩守门健壮性', '畸形入参不抛异常（抛了会丢掉拒绝理由）', threw === null, `threw=${threw}\n输出：${outputs.map((o) => (o === undefined ? 'undefined(放行)' : String(o).slice(0, 60))).join(' | ')}`)
    rec.add(
      '反例⑩守门健壮性',
      '畸形入参也不会把"该拒的"放行成 undefined',
      outputs[1] !== undefined,
      `agent=null 时的 pipeline_close 返回：${String(outputs[1]).slice(0, 120)}`,
    )
  }

  // =========================================================================
  // 分档验证
  // =========================================================================
  // ★ 本轮起：L1+ 多了一个独立对话 —— 需求分析与**计划**拆成了两个角色。
  //   （L0 不变：两件事都由确定性规则引擎承担，仍是 4 个。）
  const TIER_CASES = [
    { name: 'L0 极简脚本', requirement: '写一个函数 fizzbuzz(n)，返回 1 到 n 的 FizzBuzz 字符串数组。', expect: 'L0', expectTotal: 4 },
    { name: 'L1 普通功能', requirement: '给订单接口加一个按状态过滤的查询参数，并补上单元测试。', expect: 'L1', expectTotal: 7 },
    { name: 'L2 中大型', requirement: '重构订单模块，把支付逻辑拆成独立服务，同时做数据库迁移。', expect: 'L2', expectTotal: 9 },
    { name: 'L3 安全敏感', requirement: '实现基于 JWT 的鉴权中间件，校验 token 并做权限控制。', expect: 'L3', expectTotal: 10 },
    { name: 'L4 生产上线', requirement: '把新版服务发布到生产环境，灰度 10% 流量，准备好回滚方案。', expect: 'L4', expectTotal: 11 },
  ]
  const tierLines = []
  for (const c of TIER_CASES) {
    const p = proposeTier({ requirement: c.requirement, defaultTier: 'L1' })
    const { TIERS } = await import('../lib/tiers.js')
    const total = TIERS[p.proposedTier].total
    const ok = p.proposedTier === c.expect && total === c.expectTotal
    tierLines.push(
      `  ${c.name}\n` +
        `    需求：${c.requirement}\n` +
        `    结论：${p.proposedTier}（${TIERS[p.proposedTier].zh}）· ${total} 个独立对话 ${ok ? '✓' : `✗ 期望 ${c.expect}/${c.expectTotal}`}\n` +
        `    理由：${p.notes.join(' / ')}\n` +
        (p.signals.length > 0 ? `    命中信号：${p.signals.map((s) => `[${s.tier}]${s.why}`).join('，')}\n` : '    命中信号：（无）\n') +
        `    角色清单：${TIERS[p.proposedTier].execution.join(' / ')}`,
    )
    rec.add('分档', `${c.name} → ${c.expect}（${c.expectTotal} 个对话）`, ok, tierLines.at(-1))
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groups = {}
  for (const it of rec.items) {
    if (groups[it.group] === undefined) groups[it.group] = []
    groups[it.group].push(it)
  }
  for (const [g, items] of Object.entries(groups)) {
    log('')
    log('─'.repeat(78))
    log(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    log('─'.repeat(78))
    for (const it of items) {
      log('')
      log(`${it.pass ? '✓' : '✗'} ${it.name}`)
      log(verbose ? indent(it.detail, 4) : indent(String(it.detail).split('\n')[0], 4))
    }
  }

  if (happy !== null) {
    log('')
    log('─'.repeat(78))
    log('正例状态轨迹')
    log('─'.repeat(78))
    for (const [label, state] of happy.states) log(`  ${label.padEnd(14)} ${state}`)
  }

  log('')
  log('─'.repeat(78))
  log('分档验证（简单不超配 / 复杂不漏配）')
  log('─'.repeat(78))
  for (const l of tierLines) log(l)

  log('')
  log('='.repeat(78))
  log(`总计：${rec.passed}/${rec.total} 通过`)
  log('='.repeat(78))

  for (const h of open) await disposeHarness(h)

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

/** 供 bin/ 与工具复用。 */
export const SELFTEST_VERSION = '0.1.0'

// 让 `node tests/selftest-core.mjs` 也能直接跑。
if (process.argv[1] !== undefined && /selftest-core\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSelfTest()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
