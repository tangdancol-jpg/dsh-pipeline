/**
 * dsh-pipeline · **交付即唤醒主对话**自测
 * ============================================================================
 *     node tests/wake-check.mjs
 *
 * 现场（用户原话）：
 *   「真实会话干完活，**主对话收不到任何信号**，只能靠人问或轮询，
 *     整条流水线看着像停摆。」
 *
 * 验的是补上的**第四步「交付回调」**：
 *   A. 注入形状 —— `source.kind` 必须是 `runtime-context`，**不得伪装成用户消息**
 *      （缺 source 会让宿主 `prepareDirectMessages` 炸掉整个 turn；写成 `user`
 *       会让主对话把机制信号当人话读）
 *   B. **幂等** —— 同一次交付**只注入一次**（内存已投递表 + 宿主队列查重 +
 *      确定性 requestId/message.id 三道）
 *   C. **只投主对话** —— 目标会话只从登记表取，结构上不可能投错会话
 *   D. **没登记主对话会话 ⇒ 静默跳过 + audit 留一行**，绝不抛错把调用方带崩
 *   E. **触发点接线** —— 六个工具 + 席位失联自动阻塞，走的是**同一个**入
 *   F. **正文可操作** —— 谁 · 发生了什么 · 当前状态 · 下一步合法事件
 *
 * ★ 全程零副作用：不建任何真实会话，`ctx.agents` / `ctx.sessionController` 都是替身。
 *
 * @module dsh-pipeline/tests/wake-check
 */

import { WAKE_AUDIT, WAKE_ACTOR_MECHANISM, WAKE_SOURCE_KIND, WAKE_TRIGGER_TOOL_NAMES, createMainSessionRegistry, createWaker, probeTargetSession, wakeKeyOf, wakeMessage, wakeMessageIdOf, wakeRequestIdOf } from '../lib/wakeup.js'
import { HOST_INJECTION_SITES, assertHostMessage, hostMessage } from '../lib/hostmsg.js'
import { registerInterception } from '../lib/intercept.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { rememberMainCaller } from '../lib/tools.js'
import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与 intercept-check.mjs 同一套口径）
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

const messageText = (m) =>
  Array.isArray(m?.content) ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : String(m?.content ?? '')

/**
 * ★ **假会话宿主** —— 只实现唤醒真正用到的那些面。
 *
 * 形状**逐条照抄宿主实现**（`@deepseek-ai/dsh-api-session-controller`，app.asar）：
 *   · `ctx.agents.get(sessionId)` → agent；`agent.followup(message)` 入队
 *   · `agent.inbox.nextTurn` / `agent.inbox.nextStep` —— 宿主 `hasPromptRequest()`
 *     扫的就是这两个队列
 *   · `ctx.sessionController.prompt({requestId, sessionId, mode, content})` ——
 *     **`requestId` 幂等**（同一个 id 第二次直接 `{accepted:true}`，不再入队），
 *     且宿主**会把 source 硬写成 `{kind:'user', rpcId}`**
 */
function createFakeSessionHost() {
  const sessions = new Map()
  const delivered = [] // 每一次**真的**入队（重复的不会进来）
  const promptSeen = new Set()
  const promptCalls = []

  function ensure(sessionId) {
    if (!sessions.has(sessionId)) {
      const rec = { id: sessionId, inbox: { nextTurn: [], nextStep: [] }, events: [] }
      rec.session = { snapshotEvents: () => rec.events }
      rec.followup = (message) => {
        rec.inbox.nextTurn.push(message)
        delivered.push({ via: 'agent.followup', sessionId, message })
      }
      rec.steer = (message) => {
        rec.inbox.nextStep.push(message)
        delivered.push({ via: 'agent.steer', sessionId, message })
      }
      sessions.set(sessionId, rec)
    }
    return sessions.get(sessionId)
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'agents') return { get: (sessionId) => sessions.get(sessionId) }
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            promptCalls.push(request)
            if (promptSeen.has(request.requestId)) return { accepted: true } // ★ 宿主幂等
            promptSeen.add(request.requestId)
            const message = {
              id: `prompt-${request.requestId}`,
              role: 'user',
              content: request.content,
              // ★ 宿主**硬写**的 source —— 这正是本插件要避开的那条路。
              source: { kind: 'user', rpcId: request.requestId },
            }
            ensure(request.sessionId).followup(message)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, sessions, ensure, delivered, promptSeen, promptCalls }
}

/** 造一个"已登记主对话 + 已装配唤醒器"的夹具。 */
async function setup(opts = {}) {
  const f = await createGuardFixture({ stopAfter: opts.stopAfter ?? 5 })
  const host = createFakeSessionHost()
  const registry = createMainSessionRegistry()
  const audits = []
  const waker = createWaker({
    ctx: host.ctx,
    registry,
    getTask: (taskId) => f.h.store.peek(taskId) ?? null,
    audit: async (taskId, action, detail) => {
      audits.push({ taskId, action, detail })
    },
    warn: () => {},
  })
  if (opts.registerMain !== false) {
    registry.remember(f.taskId, f.agents.main, 'test')
    host.ensure(f.agents.main)
  }
  // 席位自己的会话也建出来 —— 反例②要断言**它一条都没收到**。
  host.ensure(f.agents.writer)
  return { f, host, registry, waker, audits }
}

/** 一次典型的"席位交付"（写席位交了一份 dev_to_test 交接物）。 */
const handoffSpec = (f, over = {}) => ({
  taskId: f.taskId,
  actorRole: 'writer',
  actorSeat: 'writer#1',
  kind: 'handoff',
  what: '交了一份**交接物**',
  disc: 'HO-1',
  via: 'post-execute',
  ...over,
})

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runWakeCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A 注入形状：source 必须是 runtime-context，不得伪装成用户消息
  // =========================================================================
  {
    const msg = wakeMessage({ key: 'T-x|handoff|writer#write#1|HO-1', taskId: 'T-x', actorRole: 'writer', actorSeat: 'writer#1', kind: 'handoff', what: '交了一份交接物', task: { state: 'developing' } })
    const violations = assertHostMessage(msg, { path: 'wake 消息' })
    rec.add(
      'A 注入形状（唤醒）',
      'A1 唤醒消息过本插件**唯一**的宿主消息判据（缺 source / 形状不对当场发现）',
      violations.length === 0,
      violations.length === 0 ? 'assertHostMessage → [] （0 条违规）' : violations.join('\n'),
    )
    rec.add(
      'A 注入形状（唤醒）',
      'A2 ★ source.kind 必须是 runtime-context（**反例③**：不得伪装成用户消息）',
      msg.source?.kind === WAKE_SOURCE_KIND,
      `source.kind = ${JSON.stringify(msg.source?.kind)}　（要求 ${JSON.stringify(WAKE_SOURCE_KIND)}）`,
    )
    rec.add(
      'A 注入形状（唤醒）',
      'A3 ★ 显式反例：source.kind **不是** `user`（不是人说的话，是运行时上下文）',
      msg.source?.kind !== 'user' && msg.source?.kind !== 'plugin',
      `source.kind = ${JSON.stringify(msg.source?.kind)}；source = ${JSON.stringify(msg.source)}`,
    )
    rec.add(
      'A 注入形状（唤醒）',
      'A4 消息 id 是**非空字符串**（会话 v4 读盘准入；缺了整条会话再也读不回来）',
      typeof msg.id === 'string' && msg.id.length > 0,
      `id = ${JSON.stringify(msg.id)}`,
    )
    rec.add(
      'A 注入形状（唤醒）',
      'A5 role 是宿主认的四个之一；content 是 **block 数组**（不是字符串）',
      ['user', 'assistant', 'system', 'tool'].includes(msg.role) && Array.isArray(msg.content) && typeof msg.content[0]?.text === 'string',
      `role=${msg.role}　content[0].type=${msg.content?.[0]?.type}　content 是数组=${Array.isArray(msg.content)}`,
    )

    // ★ 反向：裸 `'plugin'` 是**已退役的 V3 包装形态**，从 hostMessage 就进不来。
    let threw = null
    try {
      hostMessage({ text: 'x', form: 'y', kind: 'plugin' })
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    rec.add(
      'A 注入形状（唤醒）',
      'A6 反例：裸 `kind:"plugin"`（v4 已退役）在**构造层**就被拒，不会走到宿主',
      threw !== null && threw.includes('生产者自有'),
      threw === null ? '★ 没抛 —— 这条洞开着（会话落盘会被整条拒收）' : threw,
    )

    const site = HOST_INJECTION_SITES.find((s) => s.id === 'wake-main-session')
    rec.add(
      'A 注入形状（唤醒）',
      'A7 注入点表登记了这一处（`HOST_INJECTION_SITES` —— 表是"防漏"的判据）',
      site !== undefined && site.form === 'wake-main' && site.via === 'hostMessage',
      site === undefined ? '★ 表里没有 `wake-main-session`' : JSON.stringify({ id: site.id, where: site.where, field: site.field, form: site.form, via: site.via }),
    )
  }

  // =========================================================================
  // F 正文可操作：谁 · 发生了什么 · 当前状态 · 下一步合法事件
  // =========================================================================
  {
    const s = await setup({ stopAfter: 5 })
    open.push(s.f.h)
    const r = await s.waker.wake(handoffSpec(s.f))
    const msg = s.host.delivered[0]?.message
    const text = messageText(msg)
    rec.add(
      'F 正文可操作（唤醒）',
      'F1 第一句回答**谁**（角色 + 席位）',
      text.includes('谁：') && text.includes('编写') && text.includes('writer#1'),
      indent(text.split('\n').slice(0, 5).join('\n')),
    )
    rec.add(
      'F 正文可操作（唤醒）',
      'F2 回答**发生了什么**',
      text.includes('发生了什么：') && text.includes('交接物'),
      indent(text.split('\n').find((l) => l.startsWith('发生了什么：')) ?? '（缺）'),
    )
    rec.add(
      'F 正文可操作（唤醒）',
      'F3 回答**任务当前状态**（读真任务，不是占位符）',
      text.includes('任务当前状态：') && text.includes(String(s.f.state)),
      `${indent(text.split('\n').find((l) => l.startsWith('任务当前状态：')) ?? '（缺）')}\n    任务真实状态 = ${s.f.state}`,
    )
    rec.add(
      'F 正文可操作（唤醒）',
      'F4 ★ 给出**下一步合法事件**（照 pipeline_status 的口径，主对话不用轮询）',
      (() => {
        const line = text.split('\n').find((l) => l.startsWith('下一步：')) ?? ''
        // ★ 判据用**事件名 + 目标状态**（`下一步：**test_passed （tester） → 待审核**`），
        //   而不是钉死某一个事件 —— 状态不同，合法事件本来就不同。
        return text.includes('下一步：') && (/(→|无合法事件)/.test(line) && /[a-z_]{4,}/.test(line))
      })(),
      indent(text.split('\n').find((l) => l.startsWith('下一步：')) ?? '（缺）'),
    )
    rec.add(
      'F 正文可操作（唤醒）',
      'F5 ★ 正文里**说清自己是什么**（运行时上下文，不是用户说的话）',
      text.includes('运行时上下文') && text.includes('不是用户说的话'),
      indent(text.split('\n').filter((l) => l.startsWith('★')).join('\n')),
    )
    rec.add(
      'F 正文可操作（唤醒）',
      'F6 失联那一类显示的是「机制（失联检测）」，不是某个席位的名字',
      (() => {
        const m = wakeMessage({ taskId: 'T-x', actorRole: WAKE_ACTOR_MECHANISM, kind: 'liveness', what: 'x', task: { state: 'developing' } })
        return messageText(m).includes('机制（失联检测）')
      })(),
      indent(messageText(wakeMessage({ taskId: 'T-x', actorRole: WAKE_ACTOR_MECHANISM, kind: 'liveness', what: 'x', task: { state: 'developing' } })).split('\n').slice(0, 5).join('\n')),
    )
  }

  // =========================================================================
  // B 幂等：同一次交付只注入一次
  // =========================================================================
  {
    const s = await setup({ stopAfter: 5 })
    open.push(s.f.h)
    const r1 = await s.waker.wake(handoffSpec(s.f))
    const r2 = await s.waker.wake(handoffSpec(s.f))
    rec.add(
      'B 幂等（唤醒）',
      'B1 ★★ **同一次交付调两次 ⇒ 只注入一次**（内存已投递表：第二次数都不投）',
      r1.injected === true && r2.injected === false && r2.reason === 'duplicate' && s.host.delivered.length === 1,
      `第 1 次：injected=${r1.injected} reason=${r1.reason}\n    第 2 次：injected=${r2.injected} reason=${r2.reason}\n    目标会话真的收到：${s.host.delivered.length} 条\n    stats=${JSON.stringify(s.waker.stats)}`,
    )
    rec.add(
      'B 幂等（唤醒）',
      'B2 ★ 交付键与 requestId 是**确定性派生**（同一次交付重放得到同一个 id）',
      wakeRequestIdOf('k') === wakeRequestIdOf('k') && wakeMessageIdOf('k') === wakeMessageIdOf('k') && wakeRequestIdOf('k') !== wakeRequestIdOf('k2'),
      `requestId("k")=${wakeRequestIdOf('k')}\n    requestId("k2")=${wakeRequestIdOf('k2')}\n    messageId("k")=${wakeMessageIdOf('k')}`,
    )

    // ★ 宿主侧查重（第二道）：把注册表/已投递表清掉，模拟"进程重建"，
    //   但目标会话的队列里**已经有**那一条 ⇒ 仍然不许重复注入。
    const s2 = await setup({ stopAfter: 5 })
    open.push(s2.f.h)
    await s2.waker.wake(handoffSpec(s2.f))
    const before = s2.host.delivered.length
    s2.waker.reset() // 清掉内存已投递表（registry 不动）
    const r3 = await s2.waker.wake(handoffSpec(s2.f))
    rec.add(
      'B 幂等（唤醒）',
      'B3 ★★ 宿主侧查重（第二道）：内存表被清掉后，靠**目标会话队列里已有同一条 id** 拦住',
      r3.injected === false && r3.reason === 'duplicate-at-host' && s2.host.delivered.length === before,
      `reset() 之后再投：injected=${r3.injected} reason=${r3.reason}\n    队列条数 ${before} → ${s2.host.delivered.length}（不变）`,
    )

    // ★ 不同的交付必须**都**注入（幂等 ≠ 把一切都吞掉）
    const s3 = await setup({ stopAfter: 5 })
    open.push(s3.f.h)
    await s3.waker.wake(handoffSpec(s3.f, { disc: 'HO-1' }))
    await s3.waker.wake(handoffSpec(s3.f, { disc: 'HO-2' }))
    await s3.waker.wake(handoffSpec(s3.f, { disc: 'HO-3', actorRole: 'tester' }))
    rec.add(
      'B 幂等（唤醒）',
      'B4 不同的交付（不同 handoff_id / 不同角色）⇒ **都注入**（没把一切都吞掉）',
      s3.host.delivered.length === 3 && s3.waker.stats.injected === 3 && s3.waker.stats.deduped === 0,
      `入队 ${s3.host.delivered.length} 条；stats=${JSON.stringify(s3.waker.stats)}`,
    )

    // ★ A→B→A 的第二条不许被吞：判别子带上状态/事件的**逐次**唯一性
    const s4 = await setup({ stopAfter: 5 })
    open.push(s4.f.h)
    const t = (state, event, hist) => ({ taskId: s4.f.taskId, actorRole: 'main', kind: 'transition', what: '推进了**任务状态**', disc: `${state}|${event}|h${hist}` })
    await s4.waker.wake(t('developing', 'dev_submitted', 10))
    await s4.waker.wake(t('ready_test', 'test_passed', 11))
    await s4.waker.wake(t('developing', 'returned_to_dev', 12))
    rec.add(
      'B 幂等（唤醒）',
      'B5 ★ A→B→A 的**第二条**不会被当成重复吞掉（键逐次事件唯一，关键在判别子）',
      s4.host.delivered.length === 3,
      `三次"回到同一个状态"的推进 ⇒ 入队 ${s4.host.delivered.length} 条（要求 3）`,
    )

    // ★ 退路（prompt）也幂等 —— 宿主按 requestId 去重
    const s5 = await setup({ stopAfter: 5 })
    open.push(s5.f.h)
    // 把 agents 服务拿掉 ⇒ 逼它走 prompt 退路
    const plainCtx = { logger: s5.host.ctx.logger, get: (n) => (n === 'sessionController' ? s5.host.ctx.get('sessionController') : undefined) }
    const w2 = createWaker({ ctx: plainCtx, registry: s5.registry, getTask: () => null, audit: async () => {}, warn: () => {} })
    const q1 = await w2.wake(handoffSpec(s5.f))
    // ★ 关键：把**本插件**的内存已投递表清掉，让第二次真的走到宿主 prompt() 那一步 ——
    //   这样"只入队一条"就**只能是**宿主按 requestId 去重的结果，不是本插件自己挡的。
    w2.reset()
    const q2 = await w2.wake(handoffSpec(s5.f))
    rec.add(
      'B 幂等（唤醒）',
      'B6 ★ 退路（`sessionController.prompt`）：`requestId` 幂等 —— 本插件内存表清掉后重放，宿主第二次直接 `{accepted:true}` 不再入队',
      q1.via === 'sessionController.prompt' && q1.sourcePreserved === false && s5.host.promptCalls.length === 2 && s5.host.delivered.length === 1,
      `第 1 次 via=${q1.via} sourcePreserved=${q1.sourcePreserved}\n    第 2 次（reset 后重放）injected=${q2.injected} reason=${q2.reason}\n    prompt() 被调 **2** 次、真入队 **${s5.host.delivered.length}** 条 ⇒ 挡在宿主那侧`,
    )
    rec.add(
      'B 幂等（唤醒）',
      'B7 ★ 退路**如实标注**：`sourcePreserved=false`（宿主会把 source 改写成 user），且幂等命中与否记 `null=不可知` 而**不是假装 `false`**',
      q1.sourcePreserved === false && q1.duplicateAtHost === null,
      `via=${q1.via}　sourcePreserved=${q1.sourcePreserved}　duplicateAtHost=${JSON.stringify(q1.duplicateAtHost)}（null=不可知；首选路 agent.followup 才是 true/false）`,
    )

    // ★★ 最强形态的幂等证据：**同一交付经过真拦截缝、连续触发两次**。
    //    这就是"席位交完卷、post-execute 又跑了一遍（重试 / 宿主重放）"的真实形状。
    {
      const f = await createGuardFixture({ stopAfter: 5 })
      open.push(f.h)
      const host = createFakeSessionHost()
      const registry = createMainSessionRegistry()
      const seen = []
      registry.remember(f.taskId, f.agents.main, 'test')
      host.ensure(f.agents.main)
      const w = createWaker({ ctx: host.ctx, registry, getTask: (t) => f.h.store.peek(t) ?? null, audit: async () => {}, warn: () => {} })
      const handlers = new Map()
      registerInterception(
        { logger: { info() {}, warn() {}, debug() {} }, get: (n) => host.ctx.get(n), on(e, fn) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(fn); return () => {} } },
        { tokens: f.h.tokens, guard: createGuardFor({ tokens: f.h.tokens, config: f.h.config, taskIndex: f.h.taskIndex, sw: { isOn: () => true }, counter: { touch() {} }, retired: new Set(), warn: () => {} }), warn: () => {}, getTask: (t) => f.h.store.peek(t) ?? null, wakeMain: async (spec) => { seen.push(spec); return w.wake(spec) } },
      )
      // 同一份交接物（同一个 handoff_id ⇒ 同一个交付键），连续触发两次
      const exec = { name: 'pipeline_handoff', arguments: { task_id: f.taskId, kind: 'dev_to_test' }, agent: { id: f.agents.writer } }
      const result = { ok: true, summary: '已提交 dev_to_test', handoff_id: 'HO-SAME' }
      const fire = async () => {
        const chain = handlers.get('tools/post-execute') ?? []
        let i = 0
        const next = async () => (i >= chain.length ? { kind: 'enter' } : chain[i++](exec, result, next))
        return next()
      }
      await fire()
      const afterFirst = host.delivered.length
      await fire()
      const afterSecond = host.delivered.length
      rec.add(
        'B 幂等（唤醒）',
        'B8 ★★★ **同一交付经真拦截缝连续触发两次 ⇒ 第二次不产生第二条注入**（座位交卷被重放的真实形状）',
        seen.length === 2 && seen[0].disc === seen[1].disc && afterFirst === 1 && afterSecond === 1 && w.stats.injected === 1 && w.stats.deduped === 1,
        `post-execute 触发了 ${seen.length} 次（交付键判别子都是 ${JSON.stringify(seen[0]?.disc)}）\n` +
          `    目标会话条数：第 1 次后 = ${afterFirst}，第 2 次后 = ${afterSecond}\n` +
          `    stats=${JSON.stringify(w.stats)}`,
      )
    }

    // ★ 重启兜底：内存登记表空着，但盘上 `task.contacts.main` 有 ⇒ **照投**（不许静默跳过）
    {
      const f = await createGuardFixture({ stopAfter: 5 })
      open.push(f.h)
      const host = createFakeSessionHost()
      const registry = createMainSessionRegistry() // ★ 故意的：空表 = "刚重启、主对话还没调过工具"
      const audits = []
      host.ensure('persisted-main-session')
      const w = createWaker({
        ctx: host.ctx,
        registry,
        getTask: (t) => f.h.store.peek(t) ?? null,
        audit: async (taskId, action, detail) => audits.push({ action, detail }),
        warn: () => {},
        mainContactOf: async () => 'persisted-main-session',
      })
      const r = await w.wake(handoffSpec(f))
      const touched = [...new Set(host.delivered.map((d) => d.sessionId))]
      rec.add(
        'B 幂等（唤醒）',
        'B9 ★★ **重启兜底**：内存登记表为空、盘上有 `task.contacts.main` ⇒ 照投（否则"重启后第一次交付"必被静默跳过）',
        r.injected === true && touched.length === 1 && touched[0] === 'persisted-main-session' && registry.sessionOf(f.taskId) === 'persisted-main-session',
        `内存表初始 size=${0}；投递落点=${JSON.stringify(touched)}\n    audit target_via=${JSON.stringify(audits.find((a) => a.detail?.target_via)?.detail?.target_via)}（registry=内存 / persisted-contact=落盘兜底）\n` +
          `    顺手补进内存表后 registry.sessionOf=${registry.sessionOf(f.taskId)}`,
      )
    }
  }

  // =========================================================================
  // C 只投主对话（结构上不可能投错会话）
  // =========================================================================
  {
    const s = await setup({ stopAfter: 5 })
    open.push(s.f.h)
    const r = await s.waker.wake(handoffSpec(s.f))
    const touched = [...new Set(s.host.delivered.map((d) => d.sessionId))]
    rec.add(
      'C 只投主对话（唤醒）',
      'C1 ★★ 唤醒只进**登记的主对话会话**，席位自己的会话一条都没有（反例②）',
      touched.length === 1 && touched[0] === s.f.agents.main && s.host.sessions.get(s.f.agents.writer)?.inbox.nextTurn.length === 0,
      `投递落点：${JSON.stringify(touched)}\n    主对话会话 = ${s.f.agents.main}　编写席位会话 = ${s.f.agents.writer}\n    编写席位的 inbox.nextTurn 条数 = ${s.host.sessions.get(s.f.agents.writer)?.inbox.nextTurn.length}`,
    )
    rec.add(
      'C 只投主对话（唤醒）',
      'C2 ★ 返回里给出目标会话，便于事后核对（不是黑箱）',
      r.targetSession === s.f.agents.main,
      `targetSession=${r.targetSession}　key=${r.key}　requestId=${r.requestId}　via=${r.via}`,
    )

    // ★ 即使调用方硬塞一个 sessionId，也只能投登记的那一个 —— 结构性保证
    const r2 = await s.waker.wake(handoffSpec(s.f, { disc: 'HO-9', sessionId: s.f.agents.writer }))
    rec.add(
      'C 只投主对话（唤醒）',
      'C3 ★★ 调用方**硬塞** `sessionId`（塞的是席位会话）也被忽略：目标只从登记表取',
      r2.targetSession === s.f.agents.main && s.host.sessions.get(s.f.agents.writer)?.inbox.nextTurn.length === 0,
      `塞进去 writer 会话后：targetSession=${r2.targetSession}（登记的主对话 = ${s.f.agents.main}）\n    编写席位 inbox 仍然 = ${s.host.sessions.get(s.f.agents.writer)?.inbox.nextTurn.length} 条`,
    )

    // ★ 两个任务互不串台
    //
    //   ⚠️ 夹具的"主对话会话 id"是**写死的**（`selftest-main`），两个任务会撞成同一个 ——
    //      那样这条断言就测不出"串台"这回事。所以这里显式给第二个任务登记一个
    //      **不同的**会话，再断言"投递只落在它自己那个会话、任务A 那个宿主一条都没多"。
    const beforeC4 = s.host.delivered.length
    const OTHER_MAIN = 'selftest-main-B'
    const other = await setup({ stopAfter: 5 })
    open.push(other.f.h)
    other.registry.forget(other.f.taskId)
    other.registry.remember(other.f.taskId, OTHER_MAIN, 'test')
    other.host.ensure(OTHER_MAIN)
    const ro = await other.waker.wake(handoffSpec(other.f))
    const otherTouched = [...new Set(other.host.delivered.map((d) => d.sessionId))]
    rec.add(
      'C 只投主对话（唤醒）',
      'C4 ★ 任务之间不串台：另一个任务的唤醒只进**它自己**登记的主对话会话，任务A 的宿主一条都没多',
      ro.targetSession === OTHER_MAIN && otherTouched.length === 1 && otherTouched[0] === OTHER_MAIN && s.host.delivered.length === beforeC4,
      `任务A 登记的主对话 = ${s.f.agents.main}（宿主收到 ${beforeC4} 条，之后仍是 ${s.host.delivered.length} 条）\n    任务B 登记的主对话 = ${OTHER_MAIN}　投递落点=${JSON.stringify(otherTouched)}`,
    )
  }

  // =========================================================================
  // D 没登记主对话会话 ⇒ 静默跳过 + audit 一行（反例④）
  // =========================================================================
  {
    const s = await setup({ registerMain: false })
    open.push(s.f.h)
    let threw = null
    let r = null
    try {
      r = await s.waker.wake(handoffSpec(s.f))
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    rec.add(
      'D 没登记主对话会话（唤醒）',
      'D1 ★★ 不抛异常（**调用方不被带崩**）—— 返回一个"跳过了"的结论（反例④）',
      threw === null && r !== null && r.ok === true && r.injected === false,
      threw !== null ? `★ 抛了：${threw}` : `threw=null　返回=${JSON.stringify(r)}`,
    )
    rec.add(
      'D 没登记主对话会话（唤醒）',
      'D2 ★ 跳过理由是 `no-main-session`（不是静默吞掉，也不是装作成功）',
      r?.reason === 'no-main-session',
      `reason=${r?.reason}　injected=${r?.injected}`,
    )
    const skipped = s.audits.filter((a) => a.action === WAKE_AUDIT.skipped)
    rec.add(
      'D 没登记主对话会话（唤醒）',
      'D3 ★★★ **audit 里留了一行**（`wake:skipped` + 原因 + 提示）—— 静默 ≠ 无痕',
      skipped.length === 1 && skipped[0].detail?.reason === 'no-main-session' && typeof skipped[0].detail?.hint === 'string',
      skipped.length === 0 ? '★ audit 里什么都没有 —— 这条是"静默失效"本身' : JSON.stringify(skipped[0], null, 2),
    )
    rec.add(
      'D 没登记主对话会话（唤醒）',
      'D4 一条都没投出去（没登记就绝不瞎投）',
      s.host.delivered.length === 0 && s.host.promptCalls.length === 0,
      `delivered=${s.host.delivered.length}　prompt 调用=${s.host.promptCalls.length}`,
    )

    // ★ 成功那条也要留痕（别只记失败）
    const s2 = await setup({ stopAfter: 5 })
    open.push(s2.f.h)
    await s2.waker.wake(handoffSpec(s2.f))
    const okLine = s2.audits.filter((a) => a.action === WAKE_AUDIT.delivered)
    rec.add(
      'D 没登记主对话会话（唤醒）',
      'D5 成功投递同样留痕（`wake:delivered`，含目标会话 / requestId / source_kind / 是否幂等命中）',
      okLine.length === 1 &&
        okLine[0].detail.source_kind === WAKE_SOURCE_KIND &&
        okLine[0].detail.source_preserved === true &&
        okLine[0].detail.target_session === s2.f.agents.main,
      JSON.stringify(okLine[0]?.detail ?? null, null, 2),
    )
  }

  // =========================================================================
  // E 触发点接线：六个工具 + 席位失联
  // =========================================================================
  {
    const want = ['pipeline_handoff', 'pipeline_artifact', 'pipeline_record_submit', 'pipeline_clarify_request', 'pipeline_human_request', 'pipeline_transition']
    rec.add(
      'E 触发点接线（唤醒）',
      'E1 ★ 触发点名册与需求点名的六条**完全一致**（不多不少）',
      want.every((x) => WAKE_TRIGGER_TOOL_NAMES.includes(x)) && WAKE_TRIGGER_TOOL_NAMES.length === want.length,
      `实际：${WAKE_TRIGGER_TOOL_NAMES.join(' / ')}\n    要求：${want.join(' / ')}`,
    )

    // --- 走真拦截缝：post-execute 上真的会唤醒 -------------------------------
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)

    /**
     * 造一个"挂好拦截缝 + 有主对话登记 + 有唤醒器"的宿主替身。
     *
     * @param {object} [opts]
     * @param {object|null} [opts.liveness] - `checkLiveness` 的返回值；null = 不挂
     */
    function mountInterception(opts = {}) {
      const host = createFakeSessionHost()
      const registry = createMainSessionRegistry()
      const calls = []
      const audits = []
      const handlers = new Map()
      registry.remember(f.taskId, f.agents.main, 'test')
      host.ensure(f.agents.main)
      const ctx = {
        logger: { info() {}, warn() {}, debug() {} },
        get: (n) => host.ctx.get(n),
        on(event, fn) {
          if (!handlers.has(event)) handlers.set(event, [])
          handlers.get(event).push(fn)
          return () => {}
        },
      }
      const waker = createWaker({
        ctx,
        registry,
        getTask: (taskId) => f.h.store.peek(taskId) ?? null,
        audit: async (taskId, action, detail) => audits.push({ taskId, action, detail }),
        warn: () => {},
      })
      const guard = createGuardFor({ tokens: f.h.tokens, config: f.h.config, taskIndex: f.h.taskIndex, sw: { isOn: () => true }, counter: { touch() {} }, retired: new Set(), warn: () => {} })
      const deps = {
        tokens: f.h.tokens,
        guard,
        warn: () => {},
        getTask: (taskId) => f.h.store.peek(taskId) ?? null,
        wakeMain: async (spec) => {
          calls.push(spec)
          return waker.wake(spec)
        },
      }
      if (opts.liveness !== undefined && opts.liveness !== null) deps.checkLiveness = async () => opts.liveness
      registerInterception(ctx, deps)

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
      /** 跑一次 pre-execute（失联检测的执法点在这里）。 */
      async function firePreExecute(agentId) {
        const chain = handlers.get('tools/pre-execute') ?? []
        let idx = 0
        const next = async () => {
          if (idx >= chain.length) return { kind: 'enter' }
          return chain[idx++]({ name: 'pipeline_status', arguments: { task_id: f.taskId }, agent: { id: agentId } }, next)
        }
        return next()
      }
      return { host, registry, calls, audits, handlers, waker, ctx, firePostExecute, firePreExecute }
    }

    const m = mountInterception()
    const writerExec = { name: 'pipeline_handoff', arguments: { task_id: f.taskId, kind: 'dev_to_test' }, agent: { id: f.agents.writer } }
    await m.firePostExecute(writerExec, { ok: true, summary: '已提交 dev_to_test', handoff_id: 'HO-XYZ' })
    rec.add(
      'E 触发点接线（唤醒）',
      'E2 ★★ 真拦截缝：`pipeline_handoff` 成功 ⇒ 主对话被唤醒（走的是 `tools/post-execute`）',
      m.calls.length === 1 && m.calls[0].taskId === f.taskId && m.calls[0].actorRole === 'writer' && m.calls[0].kind === 'handoff',
      `唤醒被调用 ${m.calls.length} 次：${JSON.stringify(m.calls[0] ?? null)}\n    目标会话真的收到 ${m.host.delivered.length} 条` + '\n' + indent(messageText(m.host.delivered[0]?.message).split('\n').slice(0, 6).join('\n')),
    )
    rec.add(
      'E 触发点接线（唤醒）',
      'E3 ★ 判别子取自**结果**（`handoff_id`）⇒ 幂等键逐次唯一',
      m.calls[0]?.disc === 'HO-XYZ',
      `disc=${JSON.stringify(m.calls[0]?.disc)}　（结果里给的是 handoff_id="HO-XYZ"）`,
    )

    const before = m.calls.length
    await m.firePostExecute({ name: 'pipeline_status', arguments: { task_id: f.taskId }, agent: { id: f.agents.main } }, { ok: true, summary: '状态' })
    rec.add(
      'E 触发点接线（唤醒）',
      'E4 ★ 非触发工具（`pipeline_status` 这种只读查询）⇒ **不唤醒**（否则每次查状态都刷屏）',
      m.calls.length === before,
      `查状态后唤醒调用数 = ${m.calls.length}（查之前 ${before}）`,
    )

    const before2 = m.calls.length
    await m.firePostExecute(writerExec, { ok: false, summary: '守门拒绝：越界' })
    rec.add(
      'E 触发点接线（唤醒）',
      'E5 ★ `ok:false` 的调用 ⇒ **不唤醒**（没交付成，唤醒只会制造假信号）',
      m.calls.length === before2,
      `失败调用后唤醒调用数 = ${m.calls.length}（失败之前 ${before2}）`,
    )

    // --- 失联触发点：机制自动阻塞 ⇒ 唤醒（kind='liveness'） -------------------
    const live = mountInterception({ liveness: { escalated: true, seats: ['writer#1'], escalations: 1, note: '席位 writer#1 静默 5 分钟 ⇒ 已自动阻塞' } })
    await live.firePreExecute(f.agents.writer)
    const livenessCalls = live.calls.filter((c) => c.kind === 'liveness')
    rec.add(
      'E 触发点接线（唤醒）',
      'E6 ★★ 席位失联 / **机制自动阻塞** ⇒ 也唤醒（这一类**不走任何工具**，是机制自己发现的事实）',
      livenessCalls.length === 1 && livenessCalls[0].actorRole === WAKE_ACTOR_MECHANISM && live.host.delivered.length === 1,
      `liveness 唤醒 ${livenessCalls.length} 次：${JSON.stringify(livenessCalls.map((c) => ({ kind: c.kind, actor: c.actorRole, disc: c.disc })))}\n    目标会话收到 ${live.host.delivered.length} 条` + '\n' + indent(messageText(live.host.delivered[0]?.message).split('\n').slice(0, 7).join('\n')),
    )
    rec.add(
      'E 触发点接线（唤醒）',
      'E7 ★ 失联唤醒的正文点名"机制（失联检测）"与"已自动阻塞"，并且给出下一步',
      messageText(live.host.delivered[0]?.message).includes('机制（失联检测）') && messageText(live.host.delivered[0]?.message).includes('下一步：'),
      indent(messageText(live.host.delivered[0]?.message).split('\n').slice(0, 7).join('\n')),
    )
    const beforeLive = live.host.delivered.length
    await live.firePreExecute(f.agents.writer)
    rec.add(
      'E 触发点接线（唤醒）',
      'E8 ★ 同一批失联席位**再查一次也不重复唤醒**（60 秒节流 + 交付键两道）',
      live.host.delivered.length === beforeLive,
      `再查一次后目标会话条数 = ${live.host.delivered.length}（之前 ${beforeLive}）`,
    )

    // ★ 反例：只报告不处置（escalated 不是 true）⇒ 一条都不唤醒
    const quiet = mountInterception({ liveness: { escalated: false, seats: ['writer#1'], escalations: 0, note: '只报告不处置' } })
    await quiet.firePreExecute(f.agents.writer)
    rec.add(
      'E 触发点接线（唤醒）',
      'E9 ★ 反例：`escalated` 不是 true（只报告不处置）⇒ **一条都不唤醒**（别打扰主对话）',
      quiet.calls.filter((c) => c.kind === 'liveness').length === 0 && quiet.host.delivered.length === 0,
      `liveness 唤醒 ${quiet.calls.filter((c) => c.kind === 'liveness').length} 次；目标会话收到 ${quiet.host.delivered.length} 条（都要求 0）`,
    )

    // --- rememberMainCaller：主对话调工具 ⇒ 记下它在哪个会话 ------------------
    const remembered = []
    const okMain = rememberMainCaller(
      { tokens: f.h.tokens, wakeup: { rememberMain: (t, s, v) => { remembered.push({ t, s, v }); return true } } },
      { name: 'pipeline_status', arguments: { task_id: f.taskId }, agent: { id: f.agents.main } },
    )
    rec.add(
      'E 触发点接线（唤醒）',
      'E10 ★ 主对话调 pipeline 工具 ⇒ 记下 `(任务 → 会话)`（唤醒的第四步靠它才知道该投给谁）',
      okMain === true && remembered.length === 1 && remembered[0].t === f.taskId && remembered[0].s === f.agents.main,
      `记下：${JSON.stringify(remembered)}`,
    )
    const remembered2 = []
    rememberMainCaller(
      { tokens: f.h.tokens, wakeup: { rememberMain: (t, s) => { remembered2.push({ t, s }); return true } } },
      { name: 'pipeline_status', arguments: { task_id: f.taskId }, agent: { id: f.agents.writer } },
    )
    rec.add(
      'E 触发点接线（唤醒）',
      'E11 ★ **席位**调工具不会把自己记成主对话（记错了唤醒就投错会话）',
      remembered2.length === 0,
      `席位调用后的登记次数 = ${remembered2.length}（要求 0）`,
    )
    rec.add(
      'E 触发点接线（唤醒）',
      'E12 ★ 没有装唤醒器时 `rememberMainCaller` 安静返回 false（自测替身 / 装配不全不许炸）',
      rememberMainCaller({ tokens: f.h.tokens }, { agent: { id: f.agents.main } }) === false,
      'deps.wakeup 缺省 ⇒ 返回 false，不抛',
    )
  }

  // =========================================================================
  // G 持久层：跨重启可查 + 状态渲染的数据源
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const r1 = await f.h.store.rememberMainContact(f.taskId, 'session-main-A')
    const readBack = await f.h.store.mainContact(f.taskId)
    const r2 = await f.h.store.rememberMainContact(f.taskId, 'session-main-A')
    const r3 = await f.h.store.rememberMainContact(f.taskId, 'session-main-B')
    rec.add(
      'G 持久层（唤醒）',
      'G1 ★ 主对话会话**落盘**（`task.contacts.main`）—— 进程重启后 `pipeline_contacts` 还能回答"主对话是谁"',
      r1.ok === true && r1.changed === true && readBack === 'session-main-A',
      `rememberMainContact → ok=${r1.ok} changed=${r1.changed}；mainContact 读回 = ${JSON.stringify(readBack)}`,
    )
    rec.add(
      'G 持久层（唤醒）',
      'G2 ★ 同一个会话**不重复写盘**（这个函数在每一次 pipeline 工具调用后都会跑）',
      r2.ok === true && r2.changed === false,
      `第二次同一会话：changed=${r2.changed}（要求 false）`,
    )
    rec.add(
      'G 持久层（唤醒）',
      'G3 ★ 换了会话（主对话重开/认领）⇒ 换登记并保留 `previous_agent`（可追溯）',
      r3.changed === true && f.h.store.peek(f.taskId)?.contacts?.main?.previous_agent === 'session-main-A',
      JSON.stringify(f.h.store.peek(f.taskId)?.contacts?.main ?? null, null, 2),
    )
    const t = f.h.store.peek(f.taskId)
    rec.add(
      'G 持久层（唤醒）',
      'G4 状态渲染的数据源是**真任务**（`availableTransitions` 同源，不是另造一份判断）',
      typeof t?.state === 'string' && t.state.length > 0,
      `任务状态 = ${t?.state}`,
    )
  }

  // =========================================================================
  // H 主对话会话自愈 + 投递失败不许静默吞（唤醒 · 2026-10-11「22:17 之后不响了」）
  // =========================================================================
  //
  //   现场（用户原话）：「唤醒为什么从约 22:17 之后就不响了」。两例实测都卡在同一处：
  //     · `T-…214043`：编写席提澄清 ⇒ `awaiting_clarification`，主对话**没收到**；
  //     · `T-…56a37e`：需求分析交结论 + 人工请求 ⇒ `awaiting_human`，同样**没收到**。
  //   audit 里全是 `wake:skipped / reason:"no-main-session"` —— 所以**不是**
  //   "投进了已删除的会话"，而是"**压根没敢投**"：那两张单的 `task.contacts.main`
  //   从头到尾就是空的（老单 `T-…5a871c` 却一直响到它没事件为止）。
  //
  //   根因不在投递，而在**找目标时挑错了任务**：`lib/tools.js` 的
  //   `rememberMainCaller` 原来用 `tokens.roleOfAgent(agentId)`，而它按 `Map`
  //   插入顺序返回**第一条**命中 —— 主对话会话为每一张开过 / 认领过的单都持有一枚
  //   main 令牌，于是它永远返回**最早那张单**。`rememberMain` 每次都在刷新老单，
  //   **新单一个字节都落不下来** ⇒ 新单的交付唤醒全部 `no-main-session`。
  //
  //   这一组把三件事钉住：新单也得登记（H1）· 会话被删/换掉能自愈（H2）·
  //   投递失败必须可见且**不许把交付键判死**（H3–H6）。
  {
    // --- H1 根因回归：一个会话手上的**每一张**主对话单都要登记 ------------------
    {
      const f = await createGuardFixture({ stopAfter: 5 })
      open.push(f.h)
      const MAIN = f.agents.main
      const SECOND = 'T-20261011-second'
      // 复刻现场：主对话先认领了老单（夹具已绑好），插件重载后又认领了一张新单。
      f.h.tokens.mint({ taskId: SECOND, role: 'main', agentId: MAIN, note: 'reattach' })

      const remembered = []
      rememberMainCaller(
        { tokens: f.h.tokens, wakeup: { rememberMain: (t, s, v) => { remembered.push({ t, s, v }); return true } } },
        { name: 'pipeline_status', arguments: {}, agent: { id: MAIN } },
      )
      const tasks = [...new Set(remembered.map((x) => x.t))].sort()
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H1 ★★★ **根因回归**：一个主对话会话手上的**每一张单**都要登记（原来 `roleOfAgent` 只挑最老那张 ⇒ 新单永远 `no-main-session`，现场那两张单就是这么哑的）',
        tasks.length === 2 && tasks.includes(f.taskId) && tasks.includes(SECOND) && remembered.every((x) => x.s === MAIN) && remembered.every((x) => x.v === 'tool-call'),
        `登记到 = ${JSON.stringify(remembered)}\n    任务集合 = ${JSON.stringify(tasks)}（要求同时含 ${f.taskId} 与 ${SECOND}）\n` +
          `    ★ 改前：只登记最老那张（= ${f.taskId}），${SECOND} 一条都落不下来`,
      )
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H1b ★ 令牌表给的是**全部**命中，不是"随便挑一个"（`tasksOfAgent` 与 `roleOfAgent` 同源同判据，只是不做取舍）',
        (() => {
          const all = f.h.tokens.tasksOfAgent(MAIN, 'main')
          return Array.isArray(all) && all.length === 2 && all.includes(f.taskId) && all.includes(SECOND) && f.h.tokens.tasksOfAgent('nobody', 'main').length === 0
        })(),
        `tasksOfAgent(main) = ${JSON.stringify(f.h.tokens.tasksOfAgent(MAIN, 'main'))}\n    未绑定的会话 = ${JSON.stringify(f.h.tokens.tasksOfAgent('nobody', 'main'))}（要求 []）`,
      )

      // --- H2 端到端自愈：主对话换了会话 id ⇒ 下次调工具就重新登记（内存 + 落盘）
      const host = createFakeSessionHost()
      const registry = createMainSessionRegistry()
      const waker = createWaker({
        ctx: host.ctx,
        registry,
        getTask: (t) => f.h.store.peek(t) ?? null,
        audit: async () => {},
        warn: () => {},
        rememberContact: async (t, s) => f.h.store.rememberMainContact(t, s),
      })
      // 起点：老会话在册（用户"清理 desktop 分组"之前的样子）
      registry.remember(f.taskId, MAIN, 'before')
      host.ensure(MAIN)
      // 那个对话被删 / 换了一个：新会话重新认领这张单（reattach ⇒ 铸一枚绑到新会话的 main 令牌）
      const NEW_MAIN = 'selftest-main-after-restart'
      f.h.tokens.mint({ taskId: f.taskId, role: 'main', agentId: NEW_MAIN, note: 'reattach' })
      const okSelfHeal = rememberMainCaller(
        { tokens: f.h.tokens, wakeup: waker },
        { name: 'pipeline_status', arguments: { task_id: f.taskId }, agent: { id: NEW_MAIN } },
      )
      await new Promise((r) => setTimeout(r, 40)) // 落盘那一步是 fire-and-forget，等一拍
      host.ensure(NEW_MAIN)
      const persisted = await f.h.store.mainContact(f.taskId)
      const rHeal = await waker.wake(handoffSpec(f))
      const touchedHeal = [...new Set(host.delivered.map((d) => d.sessionId))]
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H2 ★★★ **会话被删 / 换掉 ⇒ 下次主对话调工具自动重登记**（内存登记表 + `task.contacts.main` 一起换成新会话，唤醒随即改道；老会话一条都不再收）',
        okSelfHeal === true &&
          registry.sessionOf(f.taskId) === NEW_MAIN &&
          persisted === NEW_MAIN &&
          rHeal.injected === true &&
          touchedHeal.length === 1 &&
          touchedHeal[0] === NEW_MAIN &&
          host.delivered.filter((d) => d.sessionId === MAIN).length === 0,
        `rememberMainCaller → ${okSelfHeal}\n    内存登记 = ${registry.sessionOf(f.taskId)}（要求 ${NEW_MAIN}）\n` +
          `    落盘 contacts.main = ${JSON.stringify(persisted)}（要求 ${NEW_MAIN}）\n` +
          `    唤醒落点 = ${JSON.stringify(touchedHeal)}；老会话收到 ${host.delivered.filter((d) => d.sessionId === MAIN).length} 条（要求 0）`,
      )
    }

    // --- H3–H6 投递失败：可见 + 可补发 + 幂等键仍稳定 ---------------------------
    {
      const f = await createGuardFixture({ stopAfter: 5 })
      open.push(f.h)
      const registry = createMainSessionRegistry()
      registry.remember(f.taskId, 'selftest-main', 'test')

      const got = []
      let healthy = false
      const ctx = {
        logger: { info() {}, warn() {}, debug() {} },
        get(name) {
          if (name === 'agents') {
            return {
              // 不健康 = 目标会话查不到（已删除）⇒ `deliverWake` 掉退路，退路也不可用 ⇒ ok:false
              get: () => (healthy ? { inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [] }, followup: (m) => got.push(m) } : undefined),
            }
          }
          return undefined // `sessionController` 也不可用（模拟"会话真没了、两条路都投不出去"）
        },
      }
      const audits = []
      const warns = []
      const w = createWaker({
        ctx,
        registry,
        getTask: (t) => f.h.store.peek(t) ?? null,
        audit: async (taskId, action, detail) => audits.push({ action, detail }),
        warn: (m) => warns.push(m),
      })

      const spec = handoffSpec(f)
      const r1 = await w.wake(spec)
      const failed = audits.filter((a) => a.action === WAKE_AUDIT.failed)
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H3 ★★ 投递失败 ⇒ **`wake:failed` 留痕 + `warn` 出声**（这就是"注入投进黑洞却没人知道"的对策：不许静默吞）',
        r1.ok === false &&
          r1.reason === 'deliver' &&
          failed.length === 1 &&
          failed[0].detail?.reason === 'deliver' &&
          typeof failed[0].detail?.note === 'string' &&
          failed[0].detail?.target_live === false &&
          warns.length >= 1,
        `返回 = ${JSON.stringify(r1)}\n    audit = ${JSON.stringify(failed)}\n    warn[0] = ${JSON.stringify(warns[0] ?? '')}`,
      )
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H4 ★★ 失败的交付**不许写进"已投递"表**（原来 `delivered.has(key)` 只看"有没有这个键"、不看 `ok` ⇒ 一次失败就把这个交付键**永久判死**，再也不补发、连"跳过"都不留痕）',
        w.delivered.size === 0,
        `投递失败后「已投递」表 size = ${w.delivered.size}（要求 0 —— 失败的键一条都不许记）\n    stats=${JSON.stringify(w.stats)}`,
      )

      // 目标会话恢复 ⇒ **同一个交付键**再触发一次必须真的补发
      healthy = true
      const r2 = await w.wake(spec)
      const delivered2 = audits.filter((a) => a.action === WAKE_AUDIT.delivered)
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H5 ★★★ **下一次调用补发**：目标会话恢复后，同一个交付键**照投**（不是 `duplicate`）、audit 记 `wake:delivered` 且 `target_live:true`',
        r2.injected === true &&
          r2.reason === 'delivered' &&
          r2.key === r1.key &&
          got.length === 1 &&
          delivered2.length === 1 &&
          delivered2[0].detail?.target_live === true,
        `第 1 次 key = ${r1.key}（reason=${r1.reason}）\n    第 2 次 key = ${r2.key}（reason=${r2.reason}，injected=${r2.injected}）\n` +
          `    目标会话真的收到 ${got.length} 条；delivered 留痕 ${delivered2.length} 条（target_live=${JSON.stringify(delivered2[0]?.detail?.target_live)}）`,
      )

      // 补发成功之后，幂等立刻恢复：同一交付第三次不许再注入
      const r3 = await w.wake(spec)
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H6 ★★ 幂等**仍然稳定**：补发成功后同一交付再触发 ⇒ `duplicate`、目标会话不再多收（失败不记账 ≠ 成功后也不记账）',
        r3.injected === false && r3.reason === 'duplicate' && got.length === 1 && w.stats.deduped === 1,
        `第 3 次：reason=${r3.reason}　injected=${r3.injected}\n    目标会话累计 ${got.length} 条（要求 1）\n    stats=${JSON.stringify(w.stats)}`,
      )

      // 三态探针：在 / 不在 / 不可知 —— 不许把"不可知"写成 false
      const host2 = createFakeSessionHost()
      host2.ensure('alive')
      rec.add(
        'H 主对话会话自愈（唤醒）',
        'H7 ★ 目标会话"在不在"是**三态**（true 在 / false 不在 / **null=不可知**）—— 拿不到 `ctx.agents` 时不许假装知道',
        probeTargetSession(host2.ctx, 'alive') === true &&
          probeTargetSession(host2.ctx, 'gone') === false &&
          probeTargetSession({ get: () => undefined }, 'alive') === null &&
          probeTargetSession(host2.ctx, '') === false,
        `在 = ${JSON.stringify(probeTargetSession(host2.ctx, 'alive'))}　不在 = ${JSON.stringify(probeTargetSession(host2.ctx, 'gone'))}　` +
          `拿不到 agents = ${JSON.stringify(probeTargetSession({ get: () => undefined }, 'alive'))}　空 id = ${JSON.stringify(probeTargetSession(host2.ctx, ''))}`,
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
  lines.push('dsh-pipeline 交付即唤醒自测（注入形状 / 幂等 / 只投主对话 / 静默跳过 / 触发点接线）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('现场（用户原话）：真实会话干完活，**主对话收不到任何信号**，只能靠人问或轮询，')
  lines.push('                  整条流水线看着像停摆。')
  lines.push('')
  lines.push('缺的是**第四步「交付回调」**：子代理通道自带（会话结束 ⇒ harness 往协调者注入')
  lines.push('`Background subagent … finished`），真实会话通道只做了「建会话 → 投递 → 读回」三步。')
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

// 直接跑：`node tests/wake-check.mjs`
if (process.argv[1] !== undefined && /wake-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runWakeCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
