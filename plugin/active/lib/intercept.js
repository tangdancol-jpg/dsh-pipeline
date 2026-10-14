/**
 * dsh-pipeline · **拦截缝（harness interception seams）**
 * ============================================================================
 * 用户原话：
 *   「**我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写**」
 *   「四问 Skill 只是"引导"；**真正的拦截必须是代码**」
 *
 * ---------------------------------------------------------------------------
 * 为什么用**原生扩展点**而不是 hooks.json / 桥接插件
 * ---------------------------------------------------------------------------
 * DSH 有两条可走的路：
 *
 *   **(a) 原生 Cordis 插件直接挂 harness 的拦截扩展点**（本文件走的就是这条）
 *       缝是普通的 Cordis 事件/中间件：
 *         · `tools/pre-execute`  (exec, next) → `next()` | `{kind:'deny', reason}` | `{kind:'ask', reason?}`
 *         · `tools/post-execute` (exec, result, next) → `next()` | `{kind:'block', feedback:[...], additionalContexts?}`
 *         · `agent/pre-step`     ({agent, messages, turn, signal}, next) → `next()` | `{kind:'reject'}` | `{...下游, messages:[...附加]}`
 *         · `agent/turn-stopping`、`subagent/start`、`subagent/end`、`agent/created`
 *
 *   ★★ **注入形状是硬契约**（2026-10-11 事故的教训）★★
 *     凡是塞进 `messages` / `additionalContexts` 的**消息**，必须满足：
 *       `content` 是 **block 数组**、`source` 是**带 `kind` 的对象**。
 *     宿主有不止一处**无守卫**地读 `message.source.kind`
 *     （`@deepseek-ai/dsh-session-reference#prepareDirectMessages`、
 *      `@deepseek-ai/dsh-repeat-tool-reminder`、`dsh-orb` 的 computer-use 缝）。
 *     一条裸消息（`{role:'user', content:'...'}`）就能让**整个 turn** 以
 *     `Cannot read properties of undefined (reading 'kind')` 收尾 ——
 *     子会话在 `turn/start` 之后 277 ms 静默死亡。
 *     ⇒ **一律走 `lib/hostmsg.js` 的 `hostMessage()`**，注入点必须在
 *       `HOST_INJECTION_SITES` 里登记，自测按那张表核对形状。
 *
 *   **(b) 由本插件写一份 `hooks.json`，让 `@deepseek-ai/dsh-hooks-claude-code` 去跑**
 *
 * **选 (a)，四条理由：**
 *   ① `dsh-hook-protocol` 自己的 README 就写着：「没有参考工具对应物的定制行为请避开整个组：
 *      **原生 Cordis 插件拥有完整的 harness API，无需中间的钩子协议**」。本插件的判据是
 *      **进程内**的函数调用，走钩子协议等于把它降级成"起子进程 + 解析 stdout"。
 *   ② (b) 要往 profile 的 bundles 里加条目才能挂桥接插件 —— 那是**别人的配置面**，
 *      而本项目的纪律是"插件自己带、一步装一步撤"。
 *   ③ (b) 的每个钩子都是一次**子进程执行**（超时、stderr 摘要、退出码语义）；
 *      判据本该是零成本的同步判断，没必要为它引入进程开销与超时面。
 *   ④ **同一份判据，两个执法缝**：`tools/pre-execute` 与已有的 `ctx.tools.guard`
 *      调用**同一个** `guard(exec)`。判据只有一份，所以两条缝不会漂移。
 *
 * ---------------------------------------------------------------------------
 * 作用域（不做就是事故）
 * ---------------------------------------------------------------------------
 * 这些缝是**宿主级**的：全机的每个会话都会经过。所以本文件第一条判据永远是
 * **"这个会话是不是本插件派出去的管线席位"**：
 *   · 判据 = 该 `agentId` 在**本插件的令牌表**里绑定了某个任务的某个角色
 *     （`tokens.roleOfAgent(agentId)`，进程内、同步、无法伪造）。
 *   · 不是 ⇒ **直通放行**（用户自己的对话、别的项目的会话、别的插件的会话一律不管）。
 *   · 主对话（用户正在打字的那个会话）**默认不在令牌表里**，所以也直通 ——
 *     它只在**调用 pipeline_* 工具**时受 `ctx.tools.guard` 约束（那是另一条缝，见 lib/guard.js）。
 *
 * ---------------------------------------------------------------------------
 * kill-switch
 * ---------------------------------------------------------------------------
 * 三层，任何一层关掉都立刻生效：
 *   ① `config.intercept !== true`（配置层，需要重启）
 *   ② 总开关 `sw.isOn()`（右上角那个按钮 / `pipeline_switch` 工具，**即时**生效）
 *   ③ `ctx.tools.guard` 走的是同一份判据，所以"关掉守门"也是同一颗开关
 *
 * @module dsh-pipeline/lib/intercept
 */

import { NO_CODE_READ_ROLES, agentIdOf, scanTestRunnerCommand } from './guard.js'
import { roleLabel } from './roles.js'
import { hostMessage } from './hostmsg.js'
import { seatLiveness } from './liveness.js'
import { WAKE_ACTOR_MECHANISM, WAKE_TRIGGER_TOOLS, actorOf } from './wakeup.js'

/**
 * ★★ **T12 / E3：从"这一次调用的返回值"里取判别子。**
 *
 * 为什么在这里取：拦截缝是唯一能看见"这一次工具调用真实返回了什么"的地方，
 * 而既有用例 `tests/wake-check.mjs` E3 逐字断言交给唤醒器的 spec 上**必须带** `disc === 'HO-XYZ'`
 * （`pipeline_handoff` 的成功返回值里给的就是 `handoff_id`）。
 *
 * 取法与 `lib/wakeup.js` 的 `discriminatorOf` 同一套（封信层深搜 → `content[].json`），
 * 字段名单直接取自已导入的 {@link WAKE_TRIGGER_TOOLS}（不另立一份名单）。
 * ★ 两份实现是否会漂移：由自测逐例比对两者输出（包含封信层 / 缺字段 / 非字符串等边界），
 *   不一致就会红。
 *
 * @param {object|null} result
 * @param {string[]} fields
 * @returns {string|null}
 */
export function readWakeDisc(result, fields) {
  if (result === null || typeof result !== 'object') return null
  const list = Array.isArray(fields) ? fields : []
  const envs = [result, result.structuredContent, result.data, result.result, result.value, result.output]
  const take = (o, f) => {
    if (o === null || o === undefined || typeof o !== 'object') return null
    const v = o[f]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return null
  }
  const anywhere = (f) => {
    for (const e of envs) {
      const v = take(e, f)
      if (v !== null) return v
    }
    for (const c of Array.isArray(result.content) ? result.content : []) {
      const v = take(c, f) ?? take(c?.json, f)
      if (v !== null) return v
    }
    return null
  }
  if (list.length === 2 && list[0] === 'from' && list[1] === 'to') {
    const a = anywhere('from')
    const b = anywhere('to')
    return a !== null && b !== null ? `${a}→${b}` : null
  }
  for (const f of list) {
    const v = anywhere(f)
    if (v !== null) return v
  }
  return null
}

/** 本插件挂上的拦截缝（写出来是为了可审计：报告里要能说清"挂了哪几条"）。 */
export const INTERCEPT_EVENTS = ['tools/pre-execute', 'agent/pre-step', 'tools/post-execute']

/**
 * ★ 失联检测在 `tools/pre-execute` 上的**节流窗口**（毫秒）。
 *
 * 为什么要有它：那条缝在**每一次工具调用**上都会跑。失联判据本身是纯函数（便宜），
 * 但"发现失联之后要落盘"是 IO；每秒一次工具调用的会话上不能每次都读盘写盘。
 * 60 秒的窗口相对 5 分钟的静默阈值是安全的（最多晚 1 分钟发现）。
 */
export const LIVENESS_CHECK_THROTTLE_MS = 60 * 1000

/**
 * ★ Stop Ladder 四问 —— **拦截时注入的上下文**。
 *
 * 用户原话：「用户让你做了吗？结果需要它吗？有证据吗？没它会失败吗？」
 *
 * ⚠️ 这四问是**引导**，不是判据。真正的拦截在上面的 `tools/pre-execute` 里（代码层）。
 *    四问随 `agent/pre-step` 注入，让席位在"想多干一点"的时候自己停一下。
 */
export const STOP_LADDER_FOUR = [
  '① **用户让你做了吗？** —— 这处改动/这个文件/这件事，在授权面（change_scope）或需求里出现过吗？',
  '② **结果需要它吗？** —— 不做它，本次验收标准会因为哪一条失败？说不出具体那一条 ⇒ 不需要。',
  '③ **有证据吗？** —— 是你实测/实读得到的，还是"顺手觉得应该"？拿不出证据的改动不许提。',
  '④ **没它会失败吗？** —— 如果答案是"也不会失败"，那它就是过度工程化，不做。',
]

/** 控制角色的"读代码"提示词判据：**动词 + 代码名词**同现才算（避免误伤正常话术）。 */
export const PROMPT_CODE_READ_RE =
  /(读一下|读读|看一下|看看|打开|检查|审阅|review|read)\s*[^。\n]{0,16}(源码|代码|实现|\.js\b|\.ts\b|\.py\b|\.go\b|\.java\b|\.rs\b|\.cs\b|\.sql\b|src[\\/])/i

/**
 * 造一个"这个会话是不是管线席位"的解析器。
 *
 * @param {{tokens:{roleOfAgent:(a:string,t?:string)=>any}}} deps
 * @returns {(agentId:string)=>null|{role:string, taskId:string, seat:string|null}}
 */
export function createSeatResolver(deps) {
  return function seatOf(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return null
    let rec = null
    try {
      rec = deps.tokens.roleOfAgent(agentId)
    } catch {
      return null
    }
    if (rec === null || rec === undefined) return null
    if (typeof rec.role !== 'string' || rec.role.length === 0) return null
    return {
      role: rec.role,
      taskId: typeof rec.taskId === 'string' ? rec.taskId : '',
      seat: typeof rec.seat === 'string' && rec.seat.length > 0 ? rec.seat : null,
    }
  }
}

/**
 * ★ 判"这段提示词是不是在让一个席位干它不能干的事"。
 *
 * 刻意**只判两条硬约束**（其余一律放行）—— 提示词层面的误伤比漏判更贵：
 *   · 编写席位 + 提示词里出现测试命令 ⇒ 拒（判据复用 `scanTestRunnerCommand`）
 *   · 控制角色 + 提示词里出现"读代码"的同现 ⇒ 拒（动词 + 代码名词）
 *
 * @param {object} seat
 * @param {string} text
 * @returns {string|null} 拒绝理由；null = 放行
 */
export function judgePrompt(seat, text) {
  if (seat === null || typeof text !== 'string' || text.length === 0) return null
  if (seat.role === 'writer') {
    const hitTest = scanTestRunnerCommand(text)
    if (hitTest !== null) {
      // ⚠️ `scanTestRunnerCommand` 的返回值形状随实现变过（字符串 / {what, snippet}）——
      //    这里两种都接住，别把 `[object Object]` 递给用户看。
      const what =
        typeof hitTest === 'string'
          ? hitTest
          : String(hitTest?.what ?? hitTest?.label ?? hitTest?.kind ?? JSON.stringify(hitTest))
      return (
        `你是**编写**席位，提示词里出现了测试命令（命中：${what}）。\n` +
        '★ 编写不跑测试 —— 这是**能力边界**（守门在 `tools/pre-execute` 那一层直接拦），不是提醒。\n' +
        '要让测试跑起来：把产物交给测试角色（pipeline_handoff kind=dev_to_test）。'
      )
    }
  }
  if (NO_CODE_READ_ROLES.includes(seat.role)) {
    const m = PROMPT_CODE_READ_RE.exec(text)
    if (m !== null) {
      return (
        `你是「${roleLabel(seat.role)}」，**不看代码** —— 这条提示词在让你读实现（命中：${m[0]}）。\n` +
        '★ 你的判据是需求档 + 脱敏摘要 + 只给路径的目录结构。要看"改了什么"，用 ' +
        'pipeline_status / pipeline_change_audit（给的是路径与哈希，不是代码正文）。'
      )
    }
  }
  return null
}

/**
 * 席位开场注入的上下文（边界卡 + 四问）。
 *
 * @param {object} seat
 * @param {object|null} task - 任务对象（取 role_boundaries / plan_forbidden）
 * @returns {string}
 */
export function seatBriefing(seat, task) {
  const cards = Array.isArray(task?.role_boundaries) ? task.role_boundaries : []
  const card = cards.find((b) => String(b?.role ?? '') === seat.role) ?? null
  const forbidden = Array.isArray(task?.plan_forbidden) ? task.plan_forbidden : []
  const L = []
  L.push(`【多 AI 协同流水线 · 你的边界（代码层执法，不是提醒）】任务 ${seat.taskId}｜你是「${roleLabel(seat.role)}」`)
  if (card !== null) {
    L.push(`只做：${(card.only ?? []).join('；')}`)
    L.push(`不做：${(card.not ?? []).join('；')}`)
  } else {
    L.push('（计划里没给你的边界卡 —— 按你的角色定义行事，并让计划 AI 补上）')
  }
  if (forbidden.length > 0) L.push(`本次越界清单：${forbidden.join('；')}`)
  L.push('')
  L.push('★ 停下之前先过四问（**答不上来就别做**）：')
  for (const q of STOP_LADDER_FOUR) L.push(`  ${q}`)
  L.push('')
  L.push('★ 这些不是建议：越界的能力在守门层**直接不给**（工具会被拒），你省下的只有一次往返。')
  // ★★ 跑 shell 的写法（与 index.js 的 PIPELINE_PROMPT 同一口径，不另说一套话）。
  //
  //   为什么写进席位开场简报：这是唯一**必然**到达每个席位的一条注入（系统提示词段
  //   受 `config.registerPromptSection` 控制，而这条缝只对管线席位生效、一次注入）。
  //   它治的是"整轮作废"：多行 / 带引号 / 带中文的命令直接塞进 shell 参数时，
  //   多层转义会把**工具调用的 JSON** 写坏 ⇒ MALFORMED_RESPONSE ⇒ 整轮（含此前全部上下文）作废。
  //   ⚠️ 措辞里刻意**不许**出现任何测试类命令样例：本段文本会进席位上下文，
  //      而 `judgePrompt` 对编写席位扫的就是"提示词里有没有测试命令"（别自己把自己判红）。
  L.push('')
  L.push('★ 要跑 shell 时：多行 / 带引号 / 带中文 / 带反斜杠的命令，**先落盘成脚本文件再执行那个文件**')
  L.push('  （`pwsh -File x.ps1` / `bash x.sh`），不要整段塞进 command 参数。')
  L.push('  为什么：多层转义会把**工具调用的 JSON** 写坏 ⇒ MALFORMED_RESPONSE ⇒ **整轮作废**（含此前全部上下文）—— 最贵的一种失败。')
  L.push('  它是写法不是后门：脚本与命令受**同一套判据**管，落在你的授权面之外照样被拒。')
  return L.join('\n')
}

/**
 * 把拦截缝挂到宿主上。
 *
 * @param {object} ctx - Cordis ctx（需要 `.on` 与 `.logger`）
 * @param {object} deps
 * @param {(exec:object)=>string|undefined} deps.guard - **同一份**判据（来自 lib/guard-factory.js）
 * @param {(m:string)=>void} [deps.warn]
 * @param {boolean} [deps.enabled] - 配置层总闸（false 时一条都不挂）
 * @param {(taskId:string)=>object|null} [deps.getTask] - 取任务（注入边界卡用；唤醒身份解析也要它）
 * @param {(sessionId:string)=>Promise<object>} [deps.mainReattach] - ★★ **主对话侧的重启自动认领**
 *   （判据与纪律见 `lib/reattach.js` 文件头）。**只在既有这一条缝里调用、不改任何决议** ——
 *   为什么搭这条缝而不是新挂一条：`tests/load-smoke.mjs` 把"`tools/pre-execute` 恰好 1 条中间件"
 *   写成了断言（条数变化会让那条断言变红），而本调用**不改变**这条缝的放行/拒绝语义。
 * @returns {{seams:string[], dispose:()=>void, seenSeats:Set<string>}}
 */
export function registerInterception(ctx, deps) {
  const seatOf = createSeatResolver(deps)
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const mainReattach = typeof deps.mainReattach === 'function' ? deps.mainReattach : null
  const injected = new Set()
  const seams = []
  const disposers = []

  /**
   * ★ 失联提示的**去重键**（`<taskId>|<失联席位集合>`）。
   *
   * 为什么按"集合"而不是按任务去重：重派之后失联的席位会变（也可能一个都不剩），
   * 那是一次**新的事实**，该再说一遍；而同一批席位反复静默不该刷屏。
   * 上限兜底：这是个 Set，只增不减会泄漏 —— 到 256 条就清空（提示丢一条无所谓，
   * 内存泄漏不会自己好）。
   */
  const staleNoticed = new Set()
  const noteStaleKey = (key) => {
    if (staleNoticed.size > 256) staleNoticed.clear()
    staleNoticed.add(key)
  }

  /** 每个任务的失联检查节流表（taskId → 上次检查的毫秒时间）。 */
  const livenessCheckedAt = new Map()

  /**
   * ★ 失联检测的**执法点**：任意角色的下一次工具调用。
   *
   * 纪律（三条都很重要）：
   *   ① **绝不抛出** —— 这条缝在工具调用的关键路径上，检查失败不许影响调用；
   *   ② **节流** —— 每任务每 {@link LIVENESS_CHECK_THROTTLE_MS} 只查一次；
   *   ③ 真正落盘/推状态的活交给 `deps.checkLiveness`（store 层），这里只管"什么时候查"。
   */
  const runLivenessCheck = async (taskId, now = Date.now()) => {
    if (typeof deps.checkLiveness !== 'function') return null
    if (typeof taskId !== 'string' || taskId.length === 0) return null
    const last = livenessCheckedAt.get(taskId)
    if (last !== undefined && now - last < LIVENESS_CHECK_THROTTLE_MS) return null
    livenessCheckedAt.set(taskId, now)
    try {
      const res = await deps.checkLiveness(taskId)
      if (res !== null && res !== undefined && res.escalated === true) {
        warn(`[pipeline] 席位失联 ⇒ 已自动阻塞任务 ${taskId}：${String(res.note ?? '')}`)
        // ★★ **交付即唤醒 · 触发点⑦（席位失联 / 机制自动阻塞）**
        //
        //   这一类**不走任何工具** —— 它是机制自己发现的事实（席位静默超阈值，
        //   机制把任务推到「已阻塞」）。没有这一条，主对话永远不会知道
        //   "任务被机制自己停住了"，只会看到一片安静。
        //
        //   ★ `wakeMain` 与所有别的触发点走的是**同一个**函数（同一份幂等 +
        //     同一条投递路径），不另开一套。失败由唤醒器自己吞掉。
        await wakeMain({
          taskId,
          actorRole: WAKE_ACTOR_MECHANISM,
          actorSeat: null,
          kind: 'liveness',
          what: '**席位失联** —— 机制已自动把任务推到「已阻塞」',
          // ★ 判别子取"失联席位集合 + 升级次数"：同一批席位只唤醒一次，
          //   但重派之后**换了席位**就是新的一条事实，该再说一遍。
          disc: `${(Array.isArray(res.seats) ? res.seats : []).slice().sort().join(',')}|${Number(res.escalations ?? 0)}`,
          identitySource: 'liveness-escalation',
          note: String(res.note ?? ''),
          via: 'liveness',
        })
      }
      /**
       * ★★ **A9 / A10 / A11：崩了 ≠ 闲着，而且崩了也**必须叫****
       *
       * 现场：席位因模型输出层故障中止（`[MALFORMED_RESPONSE]`），机制 5 分钟后的
       * 判词却是「静默阈值 5 分」并**把任务冻掉** —— 同一张单因此被冻 4 次，
       * 其中一次直接挡掉了一份**已提交**的交付。
       *
       * 判据（写死在这里）：
       *   · `store.checkLiveness` 拿到**运行失败证据** ⇒ 判"中止"、**不动状态**（A10），
       *     并把这次中止记成一条**自己的**记录（带判据依据）；
       *   · 这一支负责把"中止"这件事**主动播报**给主对话（A11）——
       *     不冻结**不等于**可以静默：卡点必须看得见，也不必靠再派一席去发现。
       *   · 判别子取**那条中止记录自己的 id** ⇒ 同一次中止恰播一次（A1），
       *     而"又一次中止"是新记录、新 id ⇒ 不会被吞掉。
       */
      if (res !== null && res !== undefined && res.aborted === true) {
        warn(`[pipeline] 席位**运行失败中止**（不是闲置）⇒ 任务**不冻结**：${String(res.note ?? '')}`)
        await wakeMain({
          taskId,
          actorRole: WAKE_ACTOR_MECHANISM,
          actorSeat: null,
          kind: 'abort',
          what: '**席位因本轮运行失败中止**（不是闲置超时）—— 任务**没有被冻结**',
          disc: String(res.abort_id ?? ''),
          identitySource: 'abort-record',
          note: String(res.abort_text ?? res.note ?? ''),
          via: 'runfail',
        })
      }
      return res ?? null
    } catch (err) {
      warn(`[pipeline] 失联检测内部异常（不影响本次工具调用）：${String(err?.message ?? err)}`)
      return null
    }
  }

  /**
   * ★★ **交付即唤醒**的统一入口（本文件里所有触发点都走它）。
   *
   * 纪律三条：
   *   ① **绝不抛** —— 唤醒是副作用，跑在工具调用的关键路径上；
   *   ② 没有 `deps.wakeMain`（比如自测没装配唤醒器）⇒ 直接跳过，不算错；
   *   ③ 幂等不在这里做 —— 幂等是唤醒器自己的判据（`lib/wakeup.js`），
   *      这里只负责"什么时候叫它"。
   */
  const wakeMain = async (spec) => {
    if (typeof deps.wakeMain !== 'function') return null
    try {
      return await deps.wakeMain(spec)
    } catch (err) {
      warn(`[pipeline] 唤醒主对话失败（不影响触发它的那次调用）：${String(err?.message ?? err)}`)
      return null
    }
  }

  const on = (event, fn) => {
    try {
      const dispose = ctx.on(event, fn)
      seams.push(event)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      warn(`拦截缝 ${event} 挂载失败（该缝的判据不会生效）：${String(err?.message ?? err)}`)
    }
  }

  // --- ① PreToolUse：**和 ctx.tools.guard 同一份判据**，两个执法缝 -------------
  //
  //   为什么两个都要：
  //     · `ctx.tools.guard` 只在**工具服务**那条路上跑，靠令牌/会话绑定认人；
  //     · `tools/pre-execute` 是宿主的**前置缝**，按"这个会话是不是管线席位"认人 ——
  //       管线席位**派生出来的子会话**（没有自己的令牌）也躲不掉。
  on('tools/pre-execute', async (exec, next) => {
    /**
     * ★★ **主对话侧的重启自动认领**（D1 第 1 件；判据与纪律见 `lib/reattach.js` 文件头）。
     *
     * 为什么必须挂在这儿、而且是**这一条缝的最前面**：
     *   · 宿主的执行流水线是 `tools/pre-execute`（:3225）→ `ctx.tools.guard`（:3241）
     *     → dispatch ⇒ 挂在**工具出口**就太晚了：重启后主对话的第一次
     *     `pipeline_transition` 会先被守门以"没有身份"拒掉；
     *   · 而下面第二句就是**席位作用域判定**（`seat === null ⇒ 直通`）——
     *     重启后的主对话**恰好不在令牌表里** ⇒ 放在作用域判定之后，它永远轮不到。
     *
     * ★ 它**不改变**这条缝的任何决议（不 deny、不 ask、不改 `next()` 的返回值）：
     *   认领是"能更好"，不是判据。失败与异常都只留痕，绝不改写本次调用的结论。
     */
    if (mainReattach !== null) {
      const sid = agentIdOf(exec)
      if (typeof sid === 'string' && sid.length > 0) {
        try {
          // ★ 判决由注入方自己留档（`index.js` 的只读导出 `lastMainReattach()` 读它）。
          await mainReattach(sid)
        } catch (err) {
          warn(`[pipeline] 主对话侧自动认领异常（不影响本次调用）：${String(err?.message ?? err)}`)
        }
      }
    }

    const seat = seatOf(agentIdOf(exec))
    if (seat === null) return next() // ★ 作用域：不是管线席位 ⇒ 直通

    /**
     * ★★ **A28(b)：席位**接管**留痕**（"送达 ≠ 接管"的席位侧那一半）。
     *
     * 判据不是"投递侧字段齐不齐"（E14/E18 证明两者字段形态**完全相同**），
     * 而是**消费侧有没有痕迹**：这个席位下一次动工具，就说明它已经带着
     * 上一条投递继续干活了。记录与原投递**同一个键**，两边可配对读出。
     * ★ 只留痕，不动作（不补位、不继任、不改状态）。
     */
    if (seat.taskId.length > 0 && deps.waker !== null && deps.waker !== undefined) {
      try {
        deps.waker.markSeatConsumed?.(seat.taskId, { seat: seat.seat ?? seat.role, by: `seat:${seat.role}`, action: String(exec?.name ?? '') })
      } catch (err) {
        warn(`[pipeline] 记席位接管留痕失败（不影响本次调用）：${String(err?.message ?? err)}`)
      }
    }

    // ★ **失联检测的执法点**：管线席位（含主对话）每调用一次工具，就顺带查一次
    //   "派出去的席位还在不在"。写时检查 = 不需要任何定时器。
    //   ⚠️ 必须 await（否则本次调用可能先于"任务被阻塞"发生，主对话看到的状态会自相矛盾）；
    //      失败由 runLivenessCheck 自己吞掉，绝不会把这次工具调用带崩。
    if (seat.taskId.length > 0) await runLivenessCheck(seat.taskId)

    let reason
    try {
      reason = deps.guard(exec)
    } catch (err) {
      // 判据炸了就 fail-closed：宁可拒一次，也不要静默放行
      reason = `[pipeline] 拦截缝内部异常，按 fail-closed 拒绝本次调用：${String(err?.message ?? err)}`
    }
    if (typeof reason === 'string' && reason.length > 0) return { kind: 'deny', reason }
    return next()
  })

  // --- ② UserPromptSubmit：注入边界卡 + 四问；只拦两条硬约束 -----------------
  on('agent/pre-step', async (payload, next) => {
    const seat = seatOf(agentIdOf(payload))
    if (seat === null) return next()

    // ★ **失联检测的触发器②**：席位**开新的一步**时也查一次（同一函数、同一节流）。
    //
    //   为什么不能只挂 `tools/pre-execute`：真实事故里席位**秒死**，此后
    //   **没有任何角色再调用工具** —— 那个触发点永远等不到"下一次调用"。
    //   而"开新的一步"覆盖了**用户发消息**（用户会说话、会追问）这一情形：
    //   只要这个会话还活着，它每走一步都会顺带看一眼"派出去的席位还在不在"。
    if (seat.taskId.length > 0) await runLivenessCheck(seat.taskId)

    // 硬拦：提示词在让这个席位干它干不了的事
    const text = collectPromptText(payload)
    const deny = judgePrompt(seat, text)
    if (deny !== null) return { kind: 'reject', reason: deny }

    const downstream = await next()
    // ⚠️ 下游一旦不是 `{kind:'enter'}` 就必须**原样**传回去（包括它给的 undefined ——
    //    宿主 waterfall 不填默认值，本插件不许替宿主发明形状）。
    if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') return downstream

    const extra = []

    // 注入①：席位开场简报（边界卡 + 四问）。每个席位**只注入一次**。
    //
    // ★★ 这里曾经是本插件最贵的一个 bug 的现场 ★★
    //   旧代码是 `{ role:'user', content: seatBriefing(...) }` —— **没有 `source`**。
    //   宿主 `@deepseek-ai/dsh-session-reference#prepareDirectMessages`
    //   （app.asar @55346974）无守卫地读 `message.source.kind` ⇒
    //   `TypeError: Cannot read properties of undefined (reading 'kind')`
    //   ⇒ 整个 turn 以 error 收尾；**子会话在 turn/start 之后 277 ms 就死**，
    //   一句话没说就没了，任务静静停在「需求分析中」。
    //   现在一律走 `hostMessage()`（唯一出口，形状见 lib/hostmsg.js），
    //   并由 `tests/liveness-check.mjs` 的「注入形状」用例组守着。
    const key = `${seat.taskId}|${seat.role}|${seat.seat ?? ''}`
    let task = null
    try {
      task = typeof deps.getTask === 'function' ? deps.getTask(seat.taskId) : null
    } catch {
      task = null
    }
    if (!injected.has(key)) {
      injected.add(key)
      extra.push(
        hostMessage({
          text: seatBriefing(seat, task),
          form: 'seat-briefing',
          taskId: seat.taskId,
          role: seat.role,
          seat: seat.seat,
        }),
      )
    }

    // 注入②：★ 失联席位提示 —— 只发给**控制角色**（它们才负责调度），一次性。
    //
    //   为什么只给控制角色：失联的处置动作（重派 / 换班 / 阻塞）只有主对话、
    //   需求分析、计划 AI 有权限做；把这条提示塞给编写/测试只会制造噪音。
    //   `NO_CODE_READ_ROLES` 恰好就是这三者 —— 复用它，不新造一份名单。
    if (NO_CODE_READ_ROLES.includes(seat.role) && task !== null) {
      const live = seatLiveness(task, Date.now(), { silenceMs: deps.seatSilenceMs })
      if (live.silent.length > 0) {
        const staleKey = `${seat.taskId}|${live.silent.map((s) => s.key).sort().join(',')}`
        if (!staleNoticed.has(staleKey)) {
          noteStaleKey(staleKey)
          extra.push(
            hostMessage({
              text: live.summary,
              form: 'stale-seat-notice',
              taskId: seat.taskId,
              role: seat.role,
              seat: seat.seat,
            }),
          )
        }
      }
    }

    if (extra.length === 0) return downstream
    return {
      ...downstream,
      messages: [...(downstream.messages ?? []), ...extra],
    }
  })

  // --- ★★ ②.5 PostToolUse：**交付即唤醒主对话**（本次前置修复的核心）---------
  //
  //   现场（用户原话）：「真实会话干完活，**主对话收不到任何信号**，
  //   只能靠人问或轮询，整条流水线看着像停摆。」
  //
  //   根因：旧的**子代理**通道自带回调（会话结束 ⇒ harness 往协调者注入一条
  //   `Background subagent … finished`），而新的**真实会话**通道只做了
  //   「建会话 → 投递 → 读回」三步，**没有第四步「交付回调」**。
  //
  //   这一条就是第四步：席位交付 / 状态推进 / 席位失联的那一刻，往主对话所在
  //   会话注入一条 `source.kind = runtime-context` 的**可操作**消息
  //   （谁 · 发生了什么 · 当前状态 · **下一步合法事件**）。
  //
  //   ★ **注册顺序有讲究**：它排在 ③「结果带代码正文 ⇒ 拦结果」**之前**。
  //     宿主 waterfall 一旦被 ③ 拦下（`{kind:'block'}`），后面的监听器就不会再跑 ——
  //     而**工具本身已经执行完了**（交付已经发生），因为"结果里带了代码"就吞掉唤醒
  //     是错的。唤醒与结果内容无关，所以它必须排在前面。
  //
  //   ★ 作用域：只认**触发点表内**的工具（`WAKE_TRIGGER_TOOLS`，`lib/wakeup.js`），
  //     其余工具一律直通 —— 特别是 `pipeline_status` 这种只读查询，
  //     主对话每次查状态都唤醒一次就是刷屏。
  on('tools/post-execute', async (exec, result, next) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const trig = WAKE_TRIGGER_TOOLS[name]
    if (trig === undefined) return next() // ★ 不是触发点 ⇒ 直通

    // 失败的工具调用不唤醒：`ok:false` 是"没交付成"，唤醒主对话只会制造假信号。
    // （闸门 / 守门拒绝的那次调用本来就没产生交付物。）
    const ok = result === null || result === undefined
      ? true
      : typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')
        ? result.ok !== false
        : true
    if (!ok) return next()

    /**
     * ★★ **只有"真的推进了"才算数**（现场修复，2026-10-11）。
     *
     * 用户原话：「只有**成功**的交付/转换才发；失败/被拒的操作**不发**」。
     *
     * 光看 `ok` 不够：状态推进这条工具存在"工具返回了、但**没落地**"的形状 ——
     * 实测 `plan_gap` 被 `plan_gap_gate` 前置条件拒掉时，结果里 `ok` 仍是真值，
     * 而 `from` / `to` 两个字段都拿不到（状态**一步没动**）。那种时候叫醒主对话
     * 就是拿一条"状态推进了"去骗他 —— 正文里的状态还是旧的那个，他照着做只会扑空。
     *
     * 判据：**会改状态的工具，结果里必须证明状态真的变了** ——
     * `from` 与 `to` 都在、且**不相等**。证不出来就不发唤醒（连审计一起免了：
     * 这不是"投递失败"，而是"本来就不该发"）。
     */
    if (trig.advancesState === true) {
      const from = typeof result?.from === 'string' ? result.from : ''
      const to = typeof result?.to === 'string' ? result.to : ''
      if (from.length === 0 || to.length === 0 || from === to) return next()
    }

    // 谁在调（角色 / 席位 / 任务）—— 复用拦截缝**同一份**席位解析器。
    const actor = actorOf(exec, seatOf)
    if (actor !== null && actor.taskId.length > 0) {
      /**
       * ★★ **B5 / B14：判别子只能取"稳定交付身份"，取不到就**不播报**。**
       *
       * 改前这里是 `discriminatorOf(result, trig.disc) ?? 'h' + historyLen`。
       * 实测（真单 T-20261011-214043 的 `audit.jsonl`）：**每一条** wake:delivered
       * 的键都以 `h<historyLen>` 结尾（含本该用 handoff_id / request_id 的那些）——
       * 也就是说 `result` 顶层读不到工具返回值的那几个字段，判别子**全部**退成了
       * 一个**单调递增的计数器** ⇒ 去重永不命中 ⇒ 同一条交付被反复重放
       * （`h228 → h233 → h237`，约每分钟一条），而每次重放都带着**事件原始时刻**的
       * 快照 ⇒ 看起来就像"又交了一份交接物 / 又提了一条人工请求"（账本里没有对应文件）
       * —— 这正是"空报"与"过期快照"那两个现象的同源根因。
       *
       * 现在：结果里读不到 ⇒ 去**台账**取最新一条同类别记录的身份；
       * 两处都取不到 ⇒ `disc = null` ⇒ 唤醒器**明确跳过并留痕**（`no-stable-identity`）。
       */
      let task = null
      try {
        task = typeof deps.getTask === 'function' ? deps.getTask(actor.taskId) : null
      } catch {
        task = null
      }
      await wakeMain({
        taskId: actor.taskId,
        actorRole: actor.role,
        actorSeat: actor.seat,
        kind: trig.kind,
        what: trig.what,
        /**
         * ★★ **判别子：这一次调用的结果由 `wake()` 自己取（T12 / E3）。**
         *
         * 链路：本拦截缝 → `deps.wakeMain` → `wake()`。三者手上的 `result` 是**逐字同一个
         * 对象**（自测里 `wakeMain: async (spec) => { calls.push(spec); return waker.wake(spec) }`
         * 也是原样转交），所以在 `wake()` 里取与在这里取，**结果是同一个**：
         * `pipeline_handoff` 的成功返回值给 `handoff_id` ⇒ 判别子 `HO-XYZ`
         * —— 既有用例 `tests/wake-check.mjs` E3 断言的就是这个值。
         *
         * ★ **一份判据一个出处**：判别子的解析（含"信封深搜"与"成对字段 `from`/`to`"两条
         *   口径）只留在 `lib/wakeup.js` 一处，本文件不另写一份、也不预判。这里只把
         *   **原料**交出去（`result` + `toolName` + `task`），由 `wake()` 按
         *   ① 调用方显式给 → ② **这一次结果** → ③ 台账里同作者且还没播过的实体 → ④ 等一等
         *   → ⑤ 看得见的失败 的顺序解析。
         *
         * ★★ **绝不退回递增计数器**（v1 去掉它的原因，不许改回去）：解析不出时 `wake()`
         *   交 `null` 并走"看得见的失败"，**不会**退成 `h<historyLen>` —— 那保证每次都不同
         *   ⇒ 去重永不命中 ⇒ 同一条交付反复重放（实测 `h228 → h233 → h237`）。
         *
         * ★ 状态推进尤其不能在这里取：`pipeline_transition` 的结果只有 `from`/`to`
         *   （不含 `at`），提前取会把"哪一次真实转换"弄丢；交给 `eventIdentityFor`
         *   去台账钉出 `<from>→<to>@<历史 at>`（A3/B5）。
         */
        result: result ?? null,
        /**
         * ★★ **T12 / E3：判别子当场交出去**（`readWakeDisc` 取自本次调用的返回值）。
         *
         * 既有用例 E3 逐字断言 `m.calls[0].disc === 'HO-XYZ'` —— 这个字段必须真的在 spec 上。
         * 状态推进不走这一支（结果里只有 `from`/`to`、不含 `at`），
         * 交给 `wake()` 去台账钉出 `<from>→<to>@<历史 at>`。
         * ★ 绞不退回 `h<historyLen>` 递增计数器：取不到就给 `null`，
         *   由 `wake()` 走"台账同作者且还没播过 → 等一等 → 看得见的失败"。
         */
        disc: trig.advancesState === true ? null : readWakeDisc(result, trig.disc),
        result: result ?? null,
        // ★ 正文里的"当前状态 / 下一步 / 谁"取**转换之后**的值（同一个权威来源：
        //   工具自己报的 `to`）。没有它就只能靠 getTask 的时序，那正是"报出转换前状态"的路。
        stateAfter: trig.advancesState === true && typeof result?.to === 'string' ? result.to : null,
        stateFrom: typeof result?.from === 'string' ? result.from : null,
        // ★ B5：把任务一起交给唤醒器 —— 它要用台账算"稳定交付身份"。
        task,
        toolName: name,
        via: 'post-execute',
      })
    }
    return next()
  })

  // --- ③ PostToolUse：第二道网（结果里带代码正文 ⇒ 拦结果 + 反馈）------------
  on('tools/post-execute', async (exec, result, next) => {
    const seat = seatOf(agentIdOf(exec))
    if (seat === null) return next()
    if (!NO_CODE_READ_ROLES.includes(seat.role)) return next()
    const body = JSON.stringify(result ?? '')
    if (body.length > 0 && looksLikeCode(body)) {
      return {
        kind: 'block',
        feedback: [
          {
            type: 'text',
            text:
              `[pipeline] 这次工具结果里有**代码正文**，你是「${roleLabel(seat.role)}」——不看代码。\n` +
              '★ 这是**第二道网**：正常路径在 `tools/pre-execute` 就被拦了；这里是"结果已经拿到"的兜底。\n' +
              '要看"改了什么"：pipeline_status（脱敏摘要）或 pipeline_change_audit（路径 + 哈希）。',
          },
        ],
      }
    }
    return next()
  })

  return {
    seams: [...seams],
    seenSeats: injected,
    /** 自测用：失联提示已发过的键（`<taskId>|<席位集合>`）。 */
    staleNoticed,
    /** 自测/排障用：手动跑一次失联检查（与 `tools/pre-execute` 里那个是**同一个**函数）。 */
    runLivenessCheck,
    dispose: () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* 拆卸失败不影响结论 */
        }
      }
    },
  }
}

/** 从 `agent/pre-step` 的载荷里把提示词文本拼出来（形状不稳，尽力而为）。 */
function collectPromptText(payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : []
  const parts = []
  for (const m of msgs) {
    const c = m?.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) for (const x of c) if (typeof x?.text === 'string') parts.push(x.text)
  }
  return parts.join('\n')
}

/** 粗判"这段文本像不像代码正文"（控制角色那道网用；宁可漏判也不误伤）。 */
function looksLikeCode(body) {
  return (
    /(^|[^A-Za-z])(function|const|let|class|import|export|def|public|private)\s+[A-Za-z_$]/.test(body) ||
    /=>\s*\{/.test(body) ||
    /;\s*\n/.test(body)
  )
}
