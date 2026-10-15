/**
 * dsh-pipeline · **拦截缝**自测（用户原话：「真正的拦截必须是代码」）
 * ============================================================================
 *     node tests/intercept-check.mjs
 *
 * 验的是**宿主拦截扩展点**上那三条缝，以及它们的**作用域**与 **kill-switch**：
 *
 *   A. `tools/pre-execute` (PreToolUse)
 *      · 管线席位：越界调用 ⇒ `{kind:'deny', reason}`（**真的拦住**，不是劝）
 *      · 管线席位：正当调用 ⇒ 放行到 `next()`
 *      · **非管线会话 ⇒ 一律 `next()`**（作用域；这是"不做就是事故"那条）
 *   B. `agent/pre-step` (UserPromptSubmit)
 *      · 注入：席位开场拿到边界卡 + Stop Ladder 四问（只注入一次）
 *      · **不否决**：编写席位收到"跑测试"的提示词 ⇒ 注入**用户看得见的说明**
 *        （`{kind:'enter'}` + `messages[]`）★ 2026-10-16 口径修正 —— 见
 *        `tests/silent-veto-check.mjs`（那条路原来是 `{kind:'reject'}`，
 *        而 reject 是宿主的**一票否决**：turn 不开始 ⇒ 理由没有出口 ⇒ 用户只看到
 *        "这一轮 1 秒结束、消息像没发出去"）
 *      · **用户消息层不做越界判据**：控制角色收到"读代码"的提示词 ⇒ 放行
 *        （判据落点在 `tools/pre-execute`：Agent 真去读源码的那一次被拒）
 *      · 非管线会话 ⇒ 不注入、不判
 *   C. `tools/post-execute` (PostToolUse)
 *      · 控制角色的工具结果里带代码正文 ⇒ `{kind:'block', feedback:[...]}`
 *      · 执行角色（编写/测试）⇒ 原样放行（不误伤）
 *   D. kill-switch：总开关一关，三条缝全部放行；打开立刻恢复
 *
 * @module dsh-pipeline/tests/intercept-check
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerInterception, seatBriefing, judgePrompt, STOP_LADDER_FOUR } from '../lib/intercept.js'
import { assertHostMessage } from '../lib/hostmsg.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { callTool, createHarness, createGuardFixture } from './selftest-core.mjs'

/**
 * ★ 本文件自己所在的位置（= `<包根>/tests`）。
 *
 * 为什么要有它：本套的「E Skill 资产」用例要读**包自带的资源**
 * `skills/stop-ladder/SKILL.md`，而它原先写成 `join(process.cwd(), 'skills', ...)` ——
 * **基准是调用者的 cwd**。后果是同一份代码"在插件目录里跑全绿、在别的目录里跑三条全红"，
 * 而失败文案还说"四问四个全缺"（其实文件一个字都不缺）。判据必须钉在**包**上，
 * 不能钉在"人刚好 cd 到哪"上 —— 否则这条自测就是个会撒谎的测试。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

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

/**
 * 把一条消息的正文摊平成字符串。
 *
 * ★ 为什么需要它（2026-10-11 的形状修复）：本插件注入的消息从"字符串 content"
 *   改成了**宿主形状的 block 数组**（`[{type:'text',text}]`）—— 旧断言用
 *   `String(m.content)`，改形状之后会读到 `[object Object]` 而误判成"没注入"。
 *   这里两种都接住：这个工具只负责"把正文抠出来看"。
 */
const messageText = (m) =>
  Array.isArray(m?.content)
    ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    : String(m?.content ?? '')

/**
 * 造一个**假的宿主**：收集 `ctx.on` 挂上来的中间件，并给一个 `emit` 按宿主语义跑它们。
 *
 * 语义照抄宿主：中间件是**链**，`next()` 往下走，返回值不是 `next()` 的结果就意味着拦下了。
 */
function createFakeHost(nextResult = { kind: 'enter', messages: [] }) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }
  /** 把一条缝跑一遍（多个中间件串起来，直到有人不调 next）。 */
  async function emit(event, ...args) {
    const arr = handlers.get(event) ?? []
    let idx = 0
    const next = async () => {
      if (idx >= arr.length) return nextResult
      const fn = arr[idx++]
      return fn(...args, next)
    }
    return next()
  }
  return { ctx, emit, handlers, events: () => [...handlers.keys()] }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runInterceptCheck() {
  const rec = createRecorder()
  const open = []

  /** 造一个"夹具 + 已挂好拦截缝"的宿主。 */
  async function setup(opts = {}) {
    const f = await createGuardFixture({ stopAfter: opts.stopAfter ?? 3 })
    open.push(f.h)
    const host = createFakeHost()
    const guard = createGuardFor({
      tokens: f.h.tokens,
      config: f.h.config,
      taskIndex: f.h.taskIndex,
      sw: opts.sw ?? { isOn: () => true },
      counter: f.h.counter,
      retired: opts.retired ?? new Set(),
      warn: () => {},
    })
    const ic = registerInterception(host.ctx, {
      tokens: f.h.tokens,
      guard,
      warn: () => {},
      getTask: (taskId) => f.h.store.peek(taskId) ?? null,
    })
    return { f, host, ic, guard }
  }

  /** 从令牌表里取一个席位的 agentId（夹具已经铸了 writer 的令牌）。 */
  const writerAgentOf = (f) => f.agents.writer

  // =========================================================================
  // A. tools/pre-execute —— 真的拦得住吗
  // =========================================================================
  {
    const { f, host } = await setup({ stopAfter: 3 })
    const W = writerAgentOf(f)

    rec.add(
      'A PreToolUse',
      '（前置）拦截缝挂上了三条（`tools/pre-execute` / `agent/pre-step` / `tools/post-execute`）',
      host.events().length === 3 && host.events().includes('tools/pre-execute'),
      `已挂事件：${host.events().join(' / ')}`,
    )

    // --- 正例：管线席位的越界调用被拦 ---
    const denyTest = await host.emit('tools/pre-execute', {
      name: 'pwsh',
      arguments: { command: 'npm test' },
      agent: { id: W },
    })
    rec.add(
      'A PreToolUse',
      '★ 管线席位跑测试命令 ⇒ `{kind:"deny"}`（**拦住了**，不是劝）',
      denyTest?.kind === 'deny' && hit(denyTest.reason, '编写|不跑测试|测试'),
      `返回：${JSON.stringify(denyTest)?.slice(0, 120)}\n理由原文：\n${indent(denyTest?.reason ?? '')}`,
    )

    // --- 正例：正当调用放行 ---
    const allow = await host.emit('tools/pre-execute', {
      name: 'write',
      arguments: { path: join(f.h.projectRoot, 'src', 'fizzbuzz.js'), content: 'x' },
      agent: { id: W },
    })
    rec.add(
      'A PreToolUse',
      '正例：管线席位的**正当**调用 ⇒ 放行到 `next()`（不误伤）',
      allow?.kind === 'enter',
      `返回：${JSON.stringify(allow)}`,
    )

    // --- ★ 作用域：非管线会话一律直通 ---
    for (const [who, id] of [
      ['用户自己的会话（没绑任何管线角色）', 'user-own-session'],
      ['别的插件的会话', 'archigate-session'],
      ['空 agentId', ''],
    ]) {
      const pass = await host.emit('tools/pre-execute', {
        name: 'pwsh',
        arguments: { command: 'npm test' },
        agent: { id },
      })
      rec.add(
        'A PreToolUse',
        `★★ 作用域：**${who}** 跑同样的测试命令 ⇒ **直通放行**（事故防线）`,
        pass?.kind === 'enter',
        `agentId=${JSON.stringify(id)} → ${JSON.stringify(pass)}`,
      )
    }

    // --- 退休席位（继任之后）也拦得住 ---
    {
      const retired = new Set([W])
      const g2 = createGuardFor({
        tokens: f.h.tokens,
        config: f.h.config,
        taskIndex: f.h.taskIndex,
        sw: { isOn: () => true },
        counter: f.h.counter,
        retired,
        warn: () => {},
      })
      const host2 = createFakeHost()
      registerInterception(host2.ctx, { tokens: f.h.tokens, guard: g2, warn: () => {}, getTask: () => null })
      const r = await host2.emit('tools/pre-execute', {
        name: 'write',
        arguments: { path: join(f.h.projectRoot, 'src', 'x.js'), content: 'x' },
        agent: { id: W },
      })
      rec.add(
        'A PreToolUse',
        '★ 已退休（继任换人）的旧席位再动手 ⇒ 拦（拦截缝与守门同一份判据）',
        r?.kind === 'deny' && hit(r.reason, '退休|继任'),
        `返回：${JSON.stringify(r)?.slice(0, 100)}\n${indent(r?.reason ?? '')}`,
      )
    }
  }

  // =========================================================================
  // B. agent/pre-step —— 注入 + 两条硬拦
  // =========================================================================
  {
    const { f, host } = await setup({ stopAfter: 3 })
    const W = writerAgentOf(f)
    const step = (id, texts) =>
      host.emit('agent/pre-step', { agent: { id }, messages: texts.map((t) => ({ role: 'user', content: t })), turn: 1 })

    // --- 注入 ---
    const first = await step(W, ['开始干活'])
    const injected = (first?.messages ?? []).map(messageText).join('\n')
    rec.add(
      'B UserPromptSubmit',
      '★ 席位开场拿到**边界卡 + Stop Ladder 四问**（注入到上下文里）',
      first?.kind === 'enter' &&
        hit(injected, '你的边界') &&
        STOP_LADDER_FOUR.every((q) => injected.includes(q.slice(0, 12))),
      `注入的上下文（前 20 行）：\n${indent(injected.split('\n').slice(0, 20).join('\n'))}`,
    )

    // --- ★★ 注入形状：宿主面消息必须是"block 数组 + source 对象" ---
    //
    //   2026-10-11 的事故判据：旧代码注入的是 `{role:'user', content:'字符串'}`，
    //   没有 `source`；宿主 `@deepseek-ai/dsh-session-reference#prepareDirectMessages`
    //   无守卫地读 `message.source.kind` ⇒ 整个 turn 报错收尾，
    //   子会话在 turn/start 之后 277 ms 静默死亡。
    //   完整覆盖见 tests/liveness-check.mjs 的「注入形状」用例组。
    {
      const violations = []
      for (const [i, m] of (first?.messages ?? []).entries()) {
        violations.push(...assertHostMessage(m, { path: `messages[${i}]` }))
      }
      rec.add(
        'B UserPromptSubmit',
        '★★ 注入的每条消息都是**宿主形状**（`content` 是 block 数组 + `source` 是带 kind 的对象）',
        first?.kind === 'enter' && (first?.messages ?? []).length > 0 && violations.length === 0,
        `注入 ${(first?.messages ?? []).length} 条　违规：${violations.length === 0 ? '0 条 ✓' : violations.join('；')}\n` +
          `第一条原样：${JSON.stringify((first?.messages ?? [])[0])}`,
      )
    }

    const second = await step(W, ['继续'])
    rec.add(
      'B UserPromptSubmit',
      '★ 边界卡**只注入一次**（每轮都塞会把上下文撑爆）',
      second?.kind === 'enter' && (second.messages ?? []).length === 0,
      `第二次 pre-step 返回的 messages 条数：${(second?.messages ?? []).length}`,
    )

    // --- ★ 口径修正：编写 + 测试命令 ⇒ **可见说明**（不是 `{kind:"reject"}`）---
    //
    //   2026-10-16 真机缺陷：`agent/pre-step` 的 `reject` 是宿主的**一票否决** ——
    //   turn 根本不开始，所以拒绝理由**没有任何出口**（用户只看到"消息像没发出去"）。
    //   ⇒ 判据改为"注入一条用户看得见的说明 + 落一行审计"，这一轮照常进行；
    //     真正的拦截仍在 `tools/pre-execute`（编写真去跑测试时当场被拒）。
    //   完整回归（含 pl-main 全文的假阳性）见 `tests/silent-veto-check.mjs`。
    const r1 = await step(W, ['先跑一下 npm test 看看过不过，然后把结果写进提交说明'])
    const r1text = (r1?.messages ?? []).map(messageText).join('\n')
    rec.add(
      'B UserPromptSubmit',
      '★★ 编写 + 提示词里的"跑测试" ⇒ **注入用户看得见的说明**（`{kind:"enter"}` + `messages[]`，**不是** `{kind:"reject"}`）',
      r1?.kind === 'enter' && hit(r1text, '编写|不跑测试|不是拒绝') && r1text.length > 40,
      `返回 kind=${JSON.stringify(r1?.kind)}\n注入的说明：\n${indent(r1text.split('\n').slice(0, 6).join('\n'))}`,
    )

    // --- ★ 口径修正：用户消息层不做越界判据 ---
    {
      const f2 = await createGuardFixture({ stopAfter: 3 })
      open.push(f2.h)
      const host2 = createFakeHost()
      const guard2 = createGuardFor({
        tokens: f2.h.tokens,
        config: f2.h.config,
        taskIndex: f2.h.taskIndex,
        sw: { isOn: () => true },
        counter: f2.h.counter,
        retired: new Set(),
        warn: () => {},
      })
      registerInterception(host2.ctx, { tokens: f2.h.tokens, guard: guard2, warn: () => {}, getTask: () => null })
      const mainAgent = f2.agents.main
      const r2 = await host2.emit('agent/pre-step', {
        agent: { id: mainAgent },
        messages: [{ role: 'user', content: '先读一下 src/fizzbuzz.js 的实现，看看逻辑对不对' }],
        turn: 1,
      })
      rec.add(
        'B UserPromptSubmit',
        '★★ **用户消息层不做越界判据**：控制角色收到"读一下源码"的提示词 ⇒ **放行**（判据落点在 `tools/pre-execute`）',
        r2?.kind === 'enter',
        `返回 kind=${JSON.stringify(r2?.kind)}${r2?.kind === 'reject' ? `\n★ 被拦理由：\n${indent(r2?.reason ?? '')}` : ''}`,
      )
      // 对照：真去读源码的那一次调用 ⇒ 拒（判据落在工具缝）
      const r2b = await host2.emit('tools/pre-execute', {
        name: 'read',
        arguments: { path: 'src/fizzbuzz.js' },
        agent: { id: mainAgent },
      })
      rec.add(
        'B UserPromptSubmit',
        '★★ 同一句"读一下 src/fizzbuzz.js"：**Agent 真去读** ⇒ `{kind:"deny"}`（判据确实还在，只是落点收窄了）',
        r2b?.kind === 'deny',
        `返回：${JSON.stringify(r2b)?.slice(0, 100)}\n${indent(r2b?.reason ?? '')}`,
      )
      // 对照：同一句话给**编写**席位 ⇒ 放行（它本来就该读代码）
      rec.add(
        'B UserPromptSubmit',
        '对照：同一句"读一下源码"发给**编写**席位 ⇒ 不判（不误伤正当角色）',
        judgePrompt({ role: 'writer', taskId: 'T', seat: null }, '先读一下 src/fizzbuzz.js 的实现，看看逻辑对不对') === null,
        `judgePrompt(writer, ...) = ${JSON.stringify(judgePrompt({ role: 'writer', taskId: 'T', seat: null }, '先读一下 src/fizzbuzz.js 的实现，看看逻辑对不对'))}`,
      )
    }

    // --- 作用域：非管线会话不注入不判 ---
    const outsider = await step('user-own-session', ['先跑一下 npm test', '再读一下 src/x.js'])
    rec.add(
      'B UserPromptSubmit',
      '★★ 作用域：**非管线会话**既不被注入、也不被拦（原样 `next()`）',
      outsider?.kind === 'enter' && (outsider.messages ?? []).length === 0,
      `返回：${JSON.stringify(outsider)?.slice(0, 120)}`,
    )
  }

  // =========================================================================
  // C. tools/post-execute —— 第二道网（结果里带代码正文）
  // =========================================================================
  {
    const { f, host } = await setup({ stopAfter: 3 })
    const MAIN = f.agents.main
    const W = writerAgentOf(f)

    const blocked = await host.emit(
      'tools/post-execute',
      { name: 'read', arguments: { path: 'src/x.js' }, agent: { id: MAIN } },
      { ok: true, content: 'export function fizzbuzz(n) { const out = []; for (let i = 1; i <= n; i++) out.push(i); return out; }' },
    )
    rec.add(
      'C PostToolUse',
      '★ 控制角色的工具结果里带**代码正文** ⇒ `{kind:"block", feedback:[...]}`（第二道网）',
      blocked?.kind === 'block' && Array.isArray(blocked.feedback) && hit(JSON.stringify(blocked.feedback), '不看代码'),
      `返回：${JSON.stringify(blocked)?.slice(0, 160)}`,
    )

    // 对照：编写席位拿到同样的结果 ⇒ 放行
    const notBlocked = await host.emit(
      'tools/post-execute',
      { name: 'read', arguments: { path: 'src/x.js' }, agent: { id: W } },
      { ok: true, content: 'export function fizzbuzz(n) { return n }' },
    )
    rec.add(
      'C PostToolUse',
      '对照：**编写**席位拿到同样的代码结果 ⇒ 原样放行（不误伤）',
      notBlocked?.kind === 'enter',
      `返回：${JSON.stringify(notBlocked)}`,
    )

    // 对照：非管线会话 ⇒ 放行
    const outsider = await host.emit(
      'tools/post-execute',
      { name: 'read', arguments: { path: 'src/x.js' }, agent: { id: 'user-own-session' } },
      { ok: true, content: 'export function fizzbuzz(n) { return n }' },
    )
    rec.add(
      'C PostToolUse',
      '★★ 作用域：非管线会话的结果 ⇒ 放行（别的项目/别的会话不被这套边界管）',
      outsider?.kind === 'enter',
      `返回：${JSON.stringify(outsider)}`,
    )
  }

  // =========================================================================
  // D. kill-switch：总开关一关，三条缝全部放行
  // =========================================================================
  {
    let on = true
    const sw = { isOn: () => on }
    const { f, host } = await setup({ stopAfter: 3, sw })
    const W = writerAgentOf(f)
    const probe = () =>
      host.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'npm test' }, agent: { id: W } })

    rec.add('D kill-switch', '（前置）开关开着时：越界调用被拦', (await probe())?.kind === 'deny', '已确认')
    on = false
    rec.add(
      'D kill-switch',
      '★★ 总开关**关掉** ⇒ 拦截缝立刻弃权（同一次会话，不重启）',
      (await probe())?.kind === 'enter',
      `总开关=关 → ${JSON.stringify(await probe())}`,
    )
    on = true
    rec.add('D kill-switch', '★ 开关**再打开** ⇒ 立刻恢复拦截', (await probe())?.kind === 'deny', '已确认')

    // 配置层总闸：intercept=false ⇒ 一条缝都不挂
    {
      const h = await createHarness()
      open.push(h)
      const host2 = createFakeHost()
      const ic2 =
        h.config.intercept === false
          ? null
          : registerInterception(host2.ctx, {
              tokens: h.tokens,
              guard: () => undefined,
              warn: () => {},
              getTask: () => null,
            })
      rec.add(
        'D kill-switch',
        '（说明）配置层总闸是 `config.intercept`（默认 true）；关掉时 `index.js` 一条缝都不挂',
        ic2 !== null && h.config.intercept === true,
        `config.intercept = ${String(h.config.intercept)}（默认值的来源：lib/config.js 的 DEFAULTS.intercept）`,
      )
    }
  }

  // =========================================================================
  // E. 资产自检：Skill 在插件目录里（不是手工另建）
  // =========================================================================
  {
    const { readFileSync, existsSync } = await import('node:fs')
    // ★ 包自带资源 ⇒ 按**包**定位（`<包根>/skills/...`），不按 `process.cwd()`。
    //   理由见文件头的 `HERE` 注释：cwd 相对会让同一次提交"看你在哪跑"而定生死。
    const skill = join(HERE, '..', 'skills', 'stop-ladder', 'SKILL.md')
    const exists = existsSync(skill)
    const text = exists ? readFileSync(skill, 'utf8') : ''
    // 只比"四问的核心问句"（问号之前那段）—— 注入文本与 Skill 文本的措辞可以不同，
    // 但**四个问题本身**必须一致，否则"引导"与"代码注入"就成两套话了。
    const cores = STOP_LADDER_FOUR.map((q) => q.replace(/^[①-④]\s*/, '').split('？')[0].replace(/\*\*/g, '').trim())
    rec.add(
      'E Skill 资产',
      '★ Stop Ladder 四问作为**插件自带资源**躺在 `skills/stop-ladder/SKILL.md`，且四问与代码注入的**一致**',
      exists && cores.every((c) => text.includes(c)),
      `路径（按包定位）：${skill}\n存在：${exists}｜大小：${text.length}\n四问核心：${cores.join(' ｜ ')}\n缺的：${cores.filter((c) => !text.includes(c)).join('、') || '（无）'}`,
    )
    rec.add(
      'E Skill 资产',
      '★ Skill 里把四问写成了**可操作判据**（每问都有"怎么判 + 答不上来怎么办"）',
      hit(text, '怎么判') && hit(text, '答不上来就是不做') && hit(text, '停'),
      `出现"怎么判" ${(text.match(/怎么判/g) ?? []).length} 次；出现"停" ${(text.match(/停/g) ?? []).length} 次；` +
        `出现"答不上来就是不做" ${(text.match(/答不上来就是不做/g) ?? []).length} 次`,
    )
    rec.add(
      'E Skill 资产',
      '★ Skill 里点明"这份 Skill 是引导，真正的拦截在代码里"（不把劝告当机制）',
      text.includes('引导') && text.includes('代码'),
      // ⚠️ 这一行原先写死成字符串 `'已确认'` —— 断言判红、证据却说"已确认"，
      //    自相矛盾（用户当场抓到过）。证据必须与判据同源：真命中才叫已确认。
      `"引导" ${text.includes('引导') ? '已确认' : '**未找到**'}；"代码" ${text.includes('代码') ? '已确认' : '**未找到**'}`,
    )
    const marker = seatBriefing({ role: 'writer', taskId: 'T-1', seat: null }, { role_boundaries: [{ role: 'writer', only: ['只写实现'], not: ['不跑测试'] }] })
    rec.add(
      'E Skill 资产',
      '★ 同一套四问也由**代码**注入到席位上下文里（`seatBriefing`）',
      hit(marker, '只做：只写实现') && hit(marker, '不做：不跑测试') && hit(marker, '用户让你做了吗'),
      indent(marker.split('\n').slice(0, 10).join('\n')),
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
  lines.push('dsh-pipeline 拦截缝自测（PreToolUse / UserPromptSubmit / PostToolUse + 作用域 + kill-switch）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写；')
  lines.push('          真正的拦截必须是代码。')
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

// 直接跑：`node tests/intercept-check.mjs`
if (process.argv[1] !== undefined && /intercept-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runInterceptCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
