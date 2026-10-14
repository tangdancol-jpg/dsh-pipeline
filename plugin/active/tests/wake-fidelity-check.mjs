/**
 * dsh-pipeline · 唤醒机制的**保真度**自测（现场修复 #5 追加）
 * ============================================================================
 *     node tests/wake-fidelity-check.mjs
 *
 * -----------------------------------------------------------------------------
 * 现场（2026-10-11，真单 T-20261011-63633e，三次实证）
 * -----------------------------------------------------------------------------
 *  ① **状态取值早于转换**：唤醒正文连续报告「当前状态 = 等待人工答复 / 待计划」，
 *     而任务实际是 `planning` —— 它取的是**转换之前**的状态
 *     ⇒ 正文、`下一步`、甚至 `谁`**全错**，主对话被引去处理**不存在的状态**
 *     （实测两次被引去"取一封不存在的信"）。
 *     交付键：`T-20261011-63633e|transition|main|h10` / `h11` / `h16`。
 *  ② **同一转换重复唤醒**：`h10` 与 `h16` 报的是同一件事（`ready_plan → planning`），
 *     交付键却不同 ⇒ **幂等键不稳定** ⇒ 刷屏。
 *     根因：触发点表写的是 `disc: ['state','event']`，而 `pipeline_transition`
 *     返回的是 `{ ok, from, to, summary }` —— **两个字段一个都不存在**
 *     ⇒ 判别子恒空 ⇒ 每次退到 `h<historyLen>`（只有数字、没有语义）。
 *  ③ **可能在操作未成功时也发**：判别 `plan_gap` 被 `plan_gap_gate` 前置条件拒掉时，
 *     结果里 `ok` 仍是真值、而状态**一步没动**，唤醒照样发 ⇒ 正文里的状态还是旧的那个。
 *
 * -----------------------------------------------------------------------------
 * 这一套验什么（全部走**真拦截缝** + **真工具调用** + **真状态机**）
 * -----------------------------------------------------------------------------
 *   A 正文取**转换之后**的状态（用 `ready_plan → planning` 证明正文写 `planning`）
 *   B 幂等键由「任务 + 事件类型 + **真实转换前后状态** + 执行者」稳定派生
 *   C 同一转换重放 ⇒ **只出一次**
 *   D 被拒的操作（状态机跳步 / 前置条件不过）⇒ **不发**唤醒
 *   E 单源：状态 / 下一步 / 谁 全从**同一份快照**派生（结构上不可能互相矛盾）
 *
 * 全程零副作用（临时目录 + 假会话，跑完即删）。
 *
 * @module dsh-pipeline/tests/wake-fidelity-check
 */

import { createHarness, callTool, runAnalysisThenPlan } from './selftest-core.mjs'
import { createGuardFor } from '../lib/guard-factory.js'
import { registerInterception } from '../lib/intercept.js'
import { createMainSessionRegistry, createWaker, discriminatorOf, transitionDiscOf, wakeKeyOf, nextStepLine, renderWakeText, stateOfTask, WAKE_TRIGGER_TOOLS } from '../lib/wakeup.js'

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

const textOf = (m) =>
  typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((c) => c.text ?? '').join('') : ''

/**
 * 从唤醒**正文**里抠出交付键。
 *
 * 为什么不读 `message.extra.wake_key`：真实投递走 `sessionController.prompt`，
 * 那一路把消息**压成正文**（宿主自己硬写 source），`extra` 在宿主那侧就被丢掉了。
 * 正文里那一行 `★ 同一次交付只唤醒一次（交付键 \`…\`…）` 才是**人在事件现场
 * 真正看得到的**那个键 —— 按键做事、按它核对，就该读这一个。
 */
function keyOf(text) {
  const m = /交付键 `([^`]+)`/.exec(String(text ?? ''))
  return m === null ? '(无键)' : m[1]
}

// ---------------------------------------------------------------------------
// 夹具：假会话宿主 + 真拦截缝（与 wake-check.mjs 同一套形状）
// ---------------------------------------------------------------------------

function createFakeSessionHost() {
  const delivered = []
  const promptSeen = new Set()
  const sessions = new Map()
  const ensure = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        followup(msg) {
          delivered.push({ sessionId: id, message: msg })
        },
      })
    }
    return sessions.get(id)
  }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            if (promptSeen.has(request.requestId)) return { accepted: true }
            promptSeen.add(request.requestId)
            ensure(request.sessionId).followup({
              id: `prompt-${request.requestId}`,
              role: 'user',
              content: request.content,
              source: { kind: 'user', rpcId: request.requestId },
            })
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, ensure, delivered }
}

/**
 * 装配一块**真**测试台：真 harness + 真拦截缝 + 真唤醒器。
 *
 * ★ 关键：`registerInterception` 拿的是**真** guard（`createGuardFor`）——
 *   `actorOf` 靠它把 agentId 解析成角色/席位/任务；给个空壳会让 post-execute
 *   静默不触发（这正是"自测假绿"的一种：看起来跑了，其实一个判据都没到）。
 */
async function mountProbe() {
  const h = await createHarness({})
  const host = createFakeSessionHost()
  const registry = createMainSessionRegistry()
  const audits = []
  const waker = createWaker({
    ctx: host.ctx,
    registry,
    getTask: (taskId) => h.store.peek(taskId) ?? null,
    audit: async (taskId, action, detail) => audits.push({ taskId, action, detail }),
    warn: () => {},
  })
  const handlers = new Map()
  const guard = createGuardFor({ tokens: h.tokens, config: h.config, taskIndex: h.taskIndex, sw: { isOn: () => true }, counter: { touch() {} }, retired: new Set(), warn: () => {} })
  registerInterception(
    {
      logger: { info() {}, warn() {}, debug() {} },
      get: (n) => host.ctx.get(n),
      on(e, fn) {
        if (!handlers.has(e)) handlers.set(e, [])
        handlers.get(e).push(fn)
        return () => {}
      },
    },
    { tokens: h.tokens, guard, warn: () => {}, getTask: (taskId) => h.store.peek(taskId) ?? null, wakeMain: (spec) => waker.wake(spec) },
  )
  /** 按宿主 waterfall 语义跑一遍 post-execute 链。 */
  async function firePostExecute(exec, result) {
    const chain = handlers.get('tools/post-execute') ?? []
    let idx = 0
    const next = async () => {
      if (idx >= chain.length) return { kind: 'enter' }
      return chain[idx++](exec, result, next)
    }
    return next()
  }
  return { h, host, registry, audits, waker, firePostExecute }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runWakeFidelityCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 纯函数层（无需装配）：判别子 / 键 / 单源快照
  // =========================================================================
  {
    const trig = WAKE_TRIGGER_TOOLS.pipeline_transition
    rec.add(
      'B0 触发点表：状态推进的判别子取的是**工具真正返回的字段**（`from` / `to`）',
      Array.isArray(trig.disc) && trig.disc[0] === 'from' && trig.disc[1] === 'to' && trig.advancesState === true,
      `disc = ${JSON.stringify(trig.disc)}　advancesState = ${trig.advancesState}\n` +
        '（改前是 [\'state\',\'event\'] —— pipeline_transition 返回 {ok, from, to, summary}，两个字段都不存在）',
    )

    // 真实返回值形状
    const realResult = { ok: true, from: 'ready_plan', to: 'planning', summary: '任务 T-x：待计划 → 计划中。' }
    rec.add(
      'B1 `pipeline_transition` 的真实返回值 ⇒ 判别子读得出「真实转换前后状态」',
      discriminatorOf(realResult, trig.disc) === 'ready_plan→planning',
      `判别子 = ${JSON.stringify(discriminatorOf(realResult, trig.disc))}（期望 "ready_plan→planning"）\n` +
        `★ 改前用 [\'state\',\'event\'] 取同一个结果 ⇒ ${JSON.stringify(discriminatorOf(realResult, ['state', 'event']))}（空 ⇒ 只能退到 h<n>）`,
    )

    // 交付键：任务 + 事件类型 + 真实转换前后状态 + 执行者
    const keyA = wakeKeyOf({ taskId: 'T-1', kind: 'transition', actorRole: 'main', disc: transitionDiscOf(realResult, 13) })
    const keyB = wakeKeyOf({ taskId: 'T-1', kind: 'transition', actorRole: 'main', disc: transitionDiscOf(realResult, 13) })
    const keyOtherActor = wakeKeyOf({ taskId: 'T-1', kind: 'transition', actorRole: 'planner', disc: transitionDiscOf(realResult, 13) })
    const keyOtherTask = wakeKeyOf({ taskId: 'T-2', kind: 'transition', actorRole: 'main', disc: transitionDiscOf(realResult, 13) })
    rec.add(
      'B2 交付键由「任务 + 事件类型 + 真实转换前后状态 + 执行者」稳定派生（同输入同键）',
      keyA === keyB && keyA.includes('ready_plan→planning') && keyA.startsWith('T-1|transition|main|'),
      `键 = ${keyA}\n同输入再来一次 = ${keyB}　相同：${keyA === keyB}`,
    )
    rec.add(
      'B3 键对「谁」与「哪个任务」敏感（换执行者 / 换任务 ⇒ 换键，不会互相抵消）',
      keyA !== keyOtherActor && keyA !== keyOtherTask,
      `同转换换执行者：${keyOtherActor}\n同转换换任务：${keyOtherTask}`,
    )

    // A×2 与 A×1 必须区分（否则第二条会被幂等地吞掉）
    const backAgain = { ok: true, from: 'planning', to: 'ready_plan', summary: 'x' }
    const keyBack = wakeKeyOf({ taskId: 'T-1', kind: 'transition', actorRole: 'main', disc: transitionDiscOf(backAgain, 14) })
    rec.add(
      'B4 A→B 与 B→A **不会**被当成同一次（方向不同 ⇒ 键不同）',
      keyBack !== keyA && keyBack.includes('planning→ready_plan'),
      `A→B 键 = ${keyA}\nB→A 键 = ${keyBack}`,
    )

    // ★ 单源：状态 / 下一步 / 谁 全从同一份快照派生
    const snapshot = stateOfTask({ task: { state: 'ready_plan', history: [] }, stateAfter: 'planning' })
    const text = renderWakeText({ taskId: 'T-1', actorRole: 'main', kind: 'transition', what: '推进了**任务状态**', task: { state: 'ready_plan', history: [] }, stateAfter: 'planning', stateFrom: 'ready_plan', key: keyA })
    rec.add(
      'E1 单源：给了转换后状态 ⇒ 正文的状态 / 下一步都用它（不再各算一遍）',
      snapshot.state === 'planning' &&
        /任务当前状态：计划中（`planning`）/.test(text) &&
        /下一步：\*\*planned/.test(text) &&
        !/任务当前状态：待计划/.test(text),
      `快照状态 = ${snapshot.state}\n正文状态行：${text.split('\n').find((l) => l.startsWith('任务当前状态：')) ?? '（缺）'}\n` +
        `正文下一步：${text.split('\n').find((l) => l.startsWith('下一步：')) ?? '（缺）'}`,
    )
    rec.add(
      'E2 单源：下一步与状态出自**同一个**状态值（`availableTransitions(snapshot.state)`）',
      nextStepLine(snapshot).includes('planned') && nextStepLine({ state: 'ready_plan' }).includes('dispatch_planner'),
      `planning 的下一步 = ${nextStepLine(snapshot)}\nready_plan 的下一步 = ${nextStepLine({ state: 'ready_plan' })}`,
    )
    rec.add(
      'E3 没给转换后状态时**不硬编**：退回任务对象；两者都没有就如实说"读不到"',
      stateOfTask({ task: { state: 'planning' } }).state === 'planning' &&
        stateOfTask({}) === null &&
        renderWakeText({ taskId: 'T-1', actorRole: 'main', task: null }).includes('读不到'),
      `只有 task ⇒ ${stateOfTask({ task: { state: 'planning' } })?.state}\n` +
        `都没有 ⇒ ${JSON.stringify(stateOfTask({}))}\n` +
        `正文：${renderWakeText({ taskId: 'T-1', actorRole: 'main', task: null }).split('\n').find((l) => l.startsWith('任务当前状态：'))}`,
    )
  }

  // =========================================================================
  // 真链路：真状态机 + 真工具 + 真拦截缝
  // =========================================================================
  const p = await mountProbe()
  open.push(p.h)
  const { h, host, registry, firePostExecute } = p
  const MAIN = 'probe-main'

  const opened = await callTool(h, 'pipeline_task_open', { requirement: '唤醒保真度自测：一次真实状态转换' }, MAIN)
  const taskId = opened.value.task_id
  const mainToken = opened.value.role_token
  registry.remember(taskId, MAIN, 'selftest')
  host.ensure(MAIN)

  // 需求分析 → 人工确认 → 派计划 AI；停在「计划中」由本套自己把那一步做了
  await runAnalysisThenPlan(h, { taskId, tokens: { main: mainToken }, agents: { main: MAIN }, stopBeforePlan: true })
  const dp = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'planner', spawn: false, role_token: mainToken }, MAIN)
  const plannerToken = dp.value?.token ?? ''
  const plannerAgent = dp.value?.agent_id ?? 'manual-planner'

  /**
   * 一条**真**操作：真工具 → 真返回值灌进真 post-execute → 收唤醒。
   *
   * @returns {{res:object, wakes:object[], n:number, keys:string[]}}
   */
  async function realCall(toolName, args, agentId) {
    const before = host.delivered.length
    const res = await callTool(h, toolName, args, agentId)
    await firePostExecute({ name: toolName, arguments: args, agent: { id: agentId } }, res.value)
    const got = host.delivered.slice(before).map((d) => textOf(d.message))
    const keys = got.map(keyOf)
    return { res, wakes: got, n: got.length, keys }
  }

  // 夹具把 ready_plan → planning 那一步走了；本套要自己做 ⇒ 退回 ready_plan。
  // （改的是**同一个**对象引用，`peek` 立刻看到 —— 见 `store.peek` 的语义。）
  let readyPlan = true
  {
    const t = await h.store.get(taskId)
    t.state = 'ready_plan'
    t.previous_state = 'analyzing'
    readyPlan = h.store.peek(taskId)?.state === 'ready_plan'
  }
  rec.add(
    'A0 夹具就绪：任务停在「待计划(ready_plan)」，主对话会话已登记',
    readyPlan,
    `taskId=${taskId} state=${h.store.peek(taskId)?.state} 主对话会话=${registry.sessionOf(taskId)}`,
  )

  // --- A：正文取**转换之后**的状态（核心用例）------------------------------
  host.delivered.length = 0
  const main = await realCall('pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: mainToken }, MAIN)
  const afterState = h.store.peek(taskId)?.state
  const stateLine = main.wakes[0]?.split('\n').find((l) => l.startsWith('任务当前状态：')) ?? '（没收到唤醒）'
  const nextLine = main.wakes[0]?.split('\n').find((l) => l.startsWith('下一步：')) ?? ''

  rec.add(
    'A1 真转换成功：ready_plan → planning（工具返回 from/to）',
    main.res.value?.ok === true && main.res.value?.from === 'ready_plan' && main.res.value?.to === 'planning',
    `工具返回：${JSON.stringify(main.res.value)}`,
  )
  rec.add(
    'A2 ★★ 唤醒正文里的「当前状态」= **转换后**的 `planning`（不是 `ready_plan`）',
    main.n === 1 && /任务当前状态：计划中（`planning`）/.test(stateLine) && /← 刚从 待计划（`ready_plan`）转过来/.test(stateLine),
    `任务实际状态 = ${afterState}\n正文那一行：\n${indent(stateLine)}\n` +
      '（`ready_plan` 只允许出现在"刚从…转过来"那个**来源标注**里，不能当当前状态。）',
  )
  rec.add(
    'A3 ★ 正文里的「下一步」按**转换后**的状态算（planning ⇒ planned → 待开发，而不是 ready_plan 的 dispatch_planner）',
    nextLine.includes('planned') && !nextLine.includes('dispatch_planner'),
    `正文那一行：\n${indent(nextLine)}`,
  )
  rec.add(
    'A4 正文点明"这是转换后的状态 + 刚从哪儿转过来"（读者不会误以为它早就在这儿）',
    main.wakes[0]?.includes('转换后') === true && main.wakes[0]?.includes('ready_plan') === true,
    `正文：\n${indent(main.wakes[0] ?? '（没收到）')}`,
  )

  // --- B：交付键 ----------------------------------------------------------
  rec.add(
    'B5 ★★ 交付键里含**真实转换前后状态**（不再只有 h<n> 那种无语义的数字后缀）',
    main.keys.length === 1 && main.keys[0].includes('ready_plan→planning') && main.keys[0].startsWith(`${taskId}|transition|main|`),
    `交付键 = ${main.keys[0]}\n` +
      '（现场是 T-20261011-63633e|transition|main|h10 / h16 —— 同一件事两个键）',
  )

  // --- C：同一转换重放 ⇒ 只出一次 -----------------------------------------
  {
    const n1 = host.delivered.length
    await firePostExecute({ name: 'pipeline_transition', arguments: { task_id: taskId }, agent: { id: MAIN } }, main.res.value)
    rec.add(
      'C1 ★★ 同一转换重放（同键）⇒ **不再唤醒**（幂等）',
      host.delivered.length - n1 === 0,
      `重放后又收到 ${host.delivered.length - n1} 条（期望 0）\n交付键仍是 ${main.keys[0]}`,
    )
  }

  // --- D：被拒的操作 ⇒ 不发 ------------------------------------------------
  {
    // (1) 状态机跳步：planning 不接受 dispatch_planner ⇒ ok:false
    host.delivered.length = 0
    const rejected = await realCall('pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: mainToken }, MAIN)
    rec.add(
      'D1 ★ 被状态机**拒绝**的操作（跳步）⇒ 不发唤醒',
      rejected.res.value?.ok === false && rejected.n === 0,
      `工具返回 ok = ${rejected.res.value?.ok}\n收到唤醒 ${rejected.n} 条（期望 0）\n拒绝原文：\n${indent(String(rejected.res.text).slice(0, 300))}`,
    )

    // (2) ★ 工具"返回了"但**状态一步没动**（前置条件不过）⇒ `ok` 仍是真值、from/to 缺失
    //     这一条正是"光看 ok 不够"的现场形状。
    host.delivered.length = 0
    const stuck = await realCall('pipeline_transition', { task_id: taskId, event: 'plan_gap', role_token: plannerToken }, plannerAgent)
    const sameState = h.store.peek(taskId)?.state
    rec.add(
      'D2 ★★ 操作**没落地**（状态一步没动 / 结果里拿不到 from,to）⇒ 不发唤醒，哪怕 `ok` 是真值',
      stuck.n === 0,
      `工具返回：${JSON.stringify(stuck.res.value)}\n任务状态 = ${sameState}（与调用前相同）\n` +
        `收到唤醒 ${stuck.n} 条（期望 0）\n` +
        `★ 改前这里会发 —— 正文里的状态还是旧的那个，把主对话引向不存在的下一步。`,
    )

    // (3) 非触发工具 / 明确失败 ⇒ 直通、不唤醒
    host.delivered.length = 0
    await firePostExecute({ name: 'pipeline_status', arguments: { task_id: taskId }, agent: { id: MAIN } }, { ok: true, summary: '状态' })
    await firePostExecute({ name: 'pipeline_handoff', arguments: { task_id: taskId }, agent: { id: MAIN } }, { ok: false, summary: '守门拒绝：越界' })
    rec.add(
      'D3 只读查询不唤醒 + 明确失败（ok:false）不唤醒',
      host.delivered.length === 0,
      `两次调用共收到 ${host.delivered.length} 条（期望 0）`,
    )
  }

  // --- 收尾：擦干净 --------------------------------------------------------
  for (const hh of open) await hh.store.dropCache()
  for (const hh of open) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(hh.projectRoot, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('A0')) return 'A · 夹具'
    if (name.startsWith('A')) return 'A · 正文取**转换之后**的状态（现场问题①）'
    if (name.startsWith('B0')) return 'B · 判别子取工具真正返回的字段（现场问题②的根因）'
    if (name.startsWith('B')) return 'B · 幂等键：任务 + 事件类型 + 真实转换前后状态 + 执行者（现场问题②）'
    if (name.startsWith('C')) return 'C · 同一转换只出一次（幂等）'
    if (name.startsWith('D')) return 'D · 只有成功的操作才唤醒（现场问题③）'
    if (name.startsWith('E')) return 'E · 单源：状态 / 下一步 / 谁 出自同一份快照'
    return '其他'
  }
  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 唤醒保真度自测（现场修复 #5 追加）')
  lines.push('真状态机 + 真工具 + 真拦截缝：状态取值 / 幂等键 / 只发成功的')
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

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /wake-fidelity-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runWakeFidelityCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
