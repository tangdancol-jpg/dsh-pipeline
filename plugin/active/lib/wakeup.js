/**
 * dsh-pipeline · **交付即唤醒主对话**（wake the coordinator the moment a seat delivers）
 * ============================================================================
 * 用户原话（本次前置修复的现场描述）：
 *   「真实会话干完活，**主对话收不到任何信号**，只能靠人问或轮询，
 *     整条流水线看着像停摆。」
 *
 * ---------------------------------------------------------------------------
 * 缺的是第四步：交付回调
 * ---------------------------------------------------------------------------
 * 旧的**子代理**通道自带回调：子会话结束，harness 会往协调者注入一条
 * `Background subagent … finished` ⇒ 主对话被唤醒，立刻接着往下走。
 *
 * 新的**真实会话**通道（`lib/transport/`）只做了三步 ——
 *   ① 建会话 `sessionController.create()` →
 *   ② 投派活单 `sessionController.prompt()` →
 *   ③ 读回会话头 `sessionController.inspect()`。
 * **没有第四步**。于是席位交付（`pipeline_handoff` / `pipeline_artifact` /
 * `pipeline_record_submit`）、状态推进、席位失联这三类事件发生时，
 * 主对话**完全不知情**：用户在界面上看到的就是「没动静了」。
 *
 * 本模块补的就是这一步：**在席位交付的那一刻，往主对话所在会话注入一条可操作的消息。**
 *
 * ---------------------------------------------------------------------------
 * ★ 两条硬判据（踩过就别再踩）
 * ---------------------------------------------------------------------------
 * ① **消息必须带 `source`，而且是 `runtime-context`。**
 *    · 缺 `source` ⇒ 宿主 `@deepseek-ai/dsh-session-reference#prepareDirectMessages`
 *      无守卫地读 `message.source.kind` ⇒ `TypeError` ⇒ **整个 turn** 以 error 收尾
 *      （2026-10-11 事故：子会话 `turn/start` 之后 277 ms 静默死亡）。
 *    · 所以消息**一律**走 `lib/hostmsg.js` 的 {@link hostMessage}（唯一出口）。
 *    · kind 取 `runtime-context`（DSH 原生 kind，语义 = "这不是人说的，是运行时塞的
 *      上下文"），**`role` 保持 `user` 是宿主的消息形状**，但 **`source.kind` 绝不写成
 *      `user`** —— 那才是"伪装成用户消息"，主对话会把机制信号当人话读。
 *
 * ② **只能发给主对话，而且同一次交付只注入一次。**
 *    · 目标会话**只**从 {@link createMainSessionRegistry} 登记的那一份取，
 *      **从不**接受调用方传入的 sessionId ⇒ 结构上就不可能投错会话。
 *    · 幂等靠**确定的派生化**：交付键 ⇒ 确定的 `requestId` 与确定的 `message.id`，
 *      先在 {@link alreadyDelivered} 里查（内存 + 目标会话的 inbox），
 *      命中就**一次都不注入**。宿主那侧的 `prompt()` 也自带 `requestId` 幂等
 *      （`hasPromptRequest()` 扫 `inbox.nextTurn` / `inbox.nextStep` / 落盘事件）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么**不**直接用 `sessionController.prompt()`（已核实，不是猜的）
 * ---------------------------------------------------------------------------
 * 需求里点名的 API 是 `prompt({ requestId, sessionId, mode:'queue', content })`。
 * 但它的**入参类型**（`@deepseek-ai/dsh-api-session-controller/types`）是：
 *
 * ```ts
 * export interface SessionPromptRequest {
 *     readonly requestId: SessionRequestId;
 *     readonly sessionId: SessionId;
 *     readonly mode: 'queue' | 'steer';
 *     readonly content: readonly PromptContentPart[];
 *     readonly clientTimeZone?: string;
 * }
 * ```
 * ——**没有 `source` 字段**；而它的实现**硬写** `source = { kind:'user', rpcId: requestId }`。
 * 也就是说走 `prompt()` 投出去的每一条都**只能是**用户消息 —— 与判据 ① 直接冲突。
 *
 * 而 `prompt()` 内部其实只做了一件事：
 * ```js
 * if (request.mode === 'steer') agent.steer(message)
 * else agent.followup(message)
 * ```
 * ⇒ 本模块走**同一条内部通道**，只是**把 source 留在自己手上**：
 *   (a) `agents.get(sessionId).followup(message)` —— source 保住（首选）；
 *   (b) `agents` 拿不到时才退回 `prompt()`，并在 audit 里**如实**标
 *       `source_preserved:false` —— 不假装两条路一样。
 *
 * ---------------------------------------------------------------------------
 * ★ 不抛纪律
 * ---------------------------------------------------------------------------
 * 唤醒是**副作用**，不是判据。它跑在 `tools/post-execute` 这种关键路径上，
 * 所以：**任何一步失败都不许把调用方带崩**。没登记主对话会话 ⇒ 静默跳过 +
 * 在 audit 留一行（`wake:skipped`），**不抛错**。
 *
 * @module dsh-pipeline/lib/wakeup
 */

import { createHash } from 'node:crypto'

import { agentIdOf } from './guard.js'
import { hostMessage, RUNTIME_CONTEXT_KIND, assertHostMessage } from './hostmsg.js'
import { roleLabel } from './roles.js'
import { STATE_LABEL, STATE_OWNER, availableTransitions } from './states.js'

/**
 * ★ 唤醒消息写进 `source.kind` 的值。
 *
 * 就是 `runtime-context`（**运行时上下文**）—— 见文件头判据 ①。
 * 常量放这里是为了让测试与生产代码引用**同一个**值，别在两处各写一遍。
 */
export const WAKE_SOURCE_KIND = RUNTIME_CONTEXT_KIND

/** 唤醒消息写进 `source.form` 的值（同一来源的多种用途靠它区分）。 */
export const WAKE_FORM = 'wake-main'

/** audit 里的动作名 —— 成功、跳过、失败各一个，便于事后按动作过滤。 */
export const WAKE_AUDIT = Object.freeze({
  delivered: 'wake:delivered',
  skipped: 'wake:skipped',
  failed: 'wake:failed',
  /**
   * ★★ **去重也要留痕**（A25 的必含形态：唤醒尝试无论成败都必须有记录）。
   *
   * 现场：一条「任务被冻结」的唤醒**从未送达**主对话，而审计里**什么都没有** ——
   * 既没有 delivered，也没有 skipped：它是被"去重"吃掉的（§A 吞法 2）。
   * 于是主对话「全程不知道任务已经冻了」。所以去重这一支必须**自己说出来**。
   */
  dedup: 'wake:dedup',
  /** ★ **接管**留痕（A28：送达 ≠ 接管；与原事件用**同一个键**配对可读）。 */
  consumed: 'wake:consumed',
  /** ★ **升级叫醒**（R1：未被消费的投递不得永久静默；升级事件与原事件配对可读）。 */
  escalated: 'wake:escalated',
  /** ★ 席位侧反向投递的成败（A6 / A7 的"送达留痕"）。 */
  seatDelivered: 'seat:wake-delivered',
  seatFailed: 'seat:wake-failed',
  /** ★ 席位**接管**留痕（A28(b)：该席位下一轮确实带着这条投递继续工作）。 */
  seatConsumed: 'seat:wake-consumed',
})

/**
 * ★★ **触发点表** —— 哪些工具一结束就该唤醒主对话。
 *
 * 用户点名的六条，外加两条「机制自己发现的事」：
 *   · `handoff`   任何 kind 的交接物（席位交付的主通道）
 *   · `artifact`  制品版本登记
 *   · `record`    分权落档（各席位交自己那份记录）
 *   · `clarify`   澄清请求（升级梯第一级）
 *   · `human`     人工介入请求（用户拍板）
 *   · `transition` 状态推进
 *   · `liveness`  席位失联 / 机制自动阻塞（**不走工具**，由 intercept 的失联检测直接调）
 *
 * `what` 是给人看的一句话（进消息正文），`disc` 决定幂等键的判别子从结果里怎么取。
 */
export const WAKE_TRIGGER_TOOLS = Object.freeze({
  pipeline_handoff: Object.freeze({ kind: 'handoff', what: '交了一份**交接物**', disc: ['handoff_id', 'kind'] }),
  pipeline_artifact: Object.freeze({ kind: 'artifact', what: '登记了一个**制品版本**', disc: ['artifact_version', 'version'] }),
  pipeline_record_submit: Object.freeze({ kind: 'record', what: '交了**自己那份记录**', disc: ['record_id', 'sha256', 'role'] }),
  pipeline_clarify_request: Object.freeze({ kind: 'clarify', what: '提了一条**澄清请求**（第一级升级梯）', disc: ['request_id', 'question_key'] }),
  pipeline_human_request: Object.freeze({ kind: 'human', what: '提了一条**人工介入请求**（要用户拍板）', disc: ['request_id', 'reason_kind'] }),
  /**
   * ★★ 状态推进。
   *
   * 现场（2026-10-11，真单 T-20261011-63633e 的 h10 / h16）：这条原本写的是
   * `disc: ['state', 'event']`，而 **`pipeline_transition` 的返回值是
   * `{ ok, from, to, summary }` —— 两个字段一个都不存在**，于是判别子恒为空，
   * 每次都退到 `h<historyLen>`。delivery key 就变成了
   * `T-…|transition|main|h10` / `h16` —— 数字后缀，**不携带任何语义**。
   *
   * 后果两条，都实测过：
   *   · 同一件事（`ready_plan → planning`）因为落在不同历史长度上而拿到**两个键**
   *     ⇒ 幂等判据失效 ⇒ 刷屏；
   *   · 键里读不出"这是哪一次转换"，事后对不上账。
   *
   * 修法：判别子取**工具确实返回的那两个字段**（`from` / `to`），
   * 再由 `discriminatorOf` 把它规范成 `from→to`（见那个函数）。
   * 再叠一道 `h<historyLen>` 保证"两次真转换"不会被互相吞掉（A→B→A 那种）。
   */
  pipeline_transition: Object.freeze({
    kind: 'transition',
    what: '推进了**任务状态**',
    disc: ['from', 'to'],
    /**
     * ★ 这条工具**会改状态** ⇒ 门要更严：见 `wakeForTool` 与
     *   `lib/intercept.js` 的同名判据（`ok:true` 但 `from === to` = 操作没落地 ⇒ 不唤醒）。
     */
    advancesState: true,
  }),
})

/** 触发工具名的有序清单（给测试与文档用）。 */
export const WAKE_TRIGGER_TOOL_NAMES = Object.freeze(Object.keys(WAKE_TRIGGER_TOOLS))

/**
 * ★ "谁也没交东西，是**机制自己**发现的事"（席位失联 / 自动阻塞）用的伪角色 id。
 *
 * 为什么占一个 id 而不是留空：唤醒的正文要回答"**谁**"，而失联这条没有交付者 ——
 * 空着会让主对话以为是某个席位交了东西。`lib/intercept.js` 的失联处置点用它。
 */
export const WAKE_ACTOR_MECHANISM = 'mechanism'

/** 伪角色 id ⇒ 给人看的名字（认不出就原样返回，见 `roles.js` 的 `roleLabel`）。 */
function actorLabel(role) {
  const r = String(role ?? 'unknown')
  if (r === WAKE_ACTOR_MECHANISM) return '机制（失联检测）'
  return roleLabel(r)
}

// ---------------------------------------------------------------------------
// 主对话会话登记表
// ---------------------------------------------------------------------------

/**
 * ★ **主对话所在会话**的登记表（taskId → sessionId）。
 *
 * 为什么必须有它：唤醒要投到**主对话那个会话**，而这个 id 只有主对话自己调用
 * 插件工具时才拿得到（`exec.agent.id`，见 `guard.js` 的 `agentIdOf`）。
 * 所以主对话每调一次 pipeline 工具，就顺手把 `(taskId → sessionId)` 记下来。
 *
 * ★ 只增不减会泄漏 ⇒ 上限兜底（到一个数就清空）。丢一次唤醒远好过内存泄漏。
 *
 * @returns {{remember:Function, sessionOf:Function, forget:Function, size:Function, snapshot:Function}}
 */
export function createMainSessionRegistry(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 512
  const map = new Map()
  return {
    /**
     * 记下"这个任务的主对话在哪个会话里"。
     *
     * @param {string} taskId
     * @param {string} sessionId
     * @param {string} [via] - 怎么知道的（审计用）
     * @returns {boolean} 是否**发生了变化**（变了才需要落盘到 task.contacts.main）
     */
    remember(taskId, sessionId, via = 'tool-call') {
      if (typeof taskId !== 'string' || taskId.length === 0) return false
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      const prev = map.get(taskId) ?? null
      if (prev !== null && prev.sessionId === sessionId) return false
      if (map.size >= limit) map.clear()
      map.set(taskId, { sessionId, at: new Date().toISOString(), via, previous: prev?.sessionId ?? null })
      return true
    },
    /** 取主对话会话 id；没登记过就是 `null`（**不是**抛错）。 */
    sessionOf(taskId) {
      if (typeof taskId !== 'string' || taskId.length === 0) return null
      const rec = map.get(taskId)
      return rec === undefined ? null : rec.sessionId
    },
    /** 登记详情（测试/排障用）。 */
    recordOf(taskId) {
      return map.get(taskId) ?? null
    },
    forget(taskId) {
      return map.delete(taskId)
    },
    size() {
      return map.size
    },
    snapshot() {
      return [...map.entries()].map(([taskId, rec]) => ({ taskId, ...rec }))
    },
  }
}

// ---------------------------------------------------------------------------
// 幂等键与消息体
// ---------------------------------------------------------------------------

/** 短哈希（幂等键的稳定派生；与 store.js 的 shortHash 同口味，但不共用实现避免循环依赖）。 */
function shortHash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
}

/**
 * ★★ **席位段的唯一一处换算**（{@link wakeKeyOf} / {@link actorKeyOf} / {@link legacyWakeKeyOf} 共用）。
 *
 * 三条口径，一条都不许多、也不许少：
 *   · `writer` + `writer#1` ⇒ `1` —— 编写席位的 id 本身就是**全限定**的（`writer#3`），
 *     去掉前缀只留序号（否则拼出 `writer#writer#3` 这种双前缀键，实测账本里 20+ 条）；
 *   · `writer` + 空 / `null` ⇒ ``（**无席位** ⇒ 键里只用角色名）；
 *   · ★★ `tester` + `tester` ⇒ `` —— **本轮硬化**：单席位角色的**席位名就是角色名**
 *     （`lib/handoff.js` 的 `resolveHandoffSeat` 第 ③ 档、以及 `liveness.seatKey(role, seat) = seat || role`
 *     都是这个口径）。改前这里把它当成"有席位" ⇒ 拼出 `tester#tester`，
 *     与实时令牌那侧（非编写角色的 seat 是 `null` ⇒ `tester`）**对不上**。
 *
 * @param {string} role
 * @param {string|null|undefined} seat
 * @returns {string} 席位段（空串 = 该角色只有一个席位，键里只用角色名）
 */
function seatSegmentOf(role, seat) {
  const r = String(role ?? '')
  const s = typeof seat === 'string' && seat.length > 0 ? String(seat).replace(/^[a-z_]+#/, '') : ''
  if (s.length === 0) return ''
  // ★★ `seat === role` ⇒ **视作无席位**（`tester#tester` ⇒ `tester`）。
  return s === r ? '' : s
}

/**
 * ★ **交付键** —— "同一次交付"的判据。
 *
 * 形状：`<taskId>|<kind>|<actor>|<disc>`
 *   · `taskId` 任务隔离（不同任务的同名动作不互相抵消）
 *   · `kind`   哪一类事件（handoff / artifact / …）
 *   · `actor`  谁干的（角色 + 席位）
 *   · `disc`   判别子 —— **从工具结果里取**（`handoff_id` / `request_id` / 版本号…），
 *              取不到就退到"任务历史的长度"，那是**每次动作都会变**的数，
 *              保证"同一个状态被推进两次"是**两件事**、两条唤醒。
 *
 * ★ 为什么不是 `taskId|state` 这种粗键：那样 A→B→A 的第二条会被当成重复而吞掉。
 *   键必须**逐次事件唯一**，这正是"不刷屏"与"不吞消息"的分界。
 *
 * @param {{taskId:string, kind:string, actorRole:string, actorSeat?:string|null, disc?:string|number|null}} spec
 * @returns {string}
 */
export function wakeKeyOf(spec) {
  const s = spec ?? {}
  const taskId = String(s.taskId ?? '')
  const kind = String(s.kind ?? 'event')
  // ★★ 席位键的**唯一口径**（换算在 `seatSegmentOf` 一处，本函数与 `actorKeyOf` 共用）：
  //    编写席位的 id 本身就是全限定的（`writer#3`）⇒ 去掉前缀只留序号；
  //    非编写角色的 seat 是 null ⇒ 只用角色名；
  //    ★ 本轮再补一条：**单席位角色的 seat 就是角色名**（`tester` + `tester`）⇒ 也只用角色名。
  //    改前这里是 `${role}#${seat}` ⇒ 产出 `writer#writer#3` 这种**双前缀**键
  //    （实测：账本里 20+ 条 wake:delivered 全是它），于是唤醒正文里的"谁"与账本里的席位
  //    对不上 —— 归因错误（B5）。
  const role = String(s.actorRole ?? '?')
  const seg = seatSegmentOf(role, s.actorSeat)
  const actor = seg.length === 0 ? role : `${role}#${seg}`
  const disc = s.disc === null || s.disc === undefined || s.disc === '' ? 'none' : String(s.disc)
  return `${taskId}|${kind}|${actor}|${disc}`
}

/**
 * ★★ **读取侧兼容：同一把交付键在"旧口径"下可能写成的那把**（`角色#角色`）。
 *
 * 为什么需要它（**不迁移、不改写**历史账本的前提）：
 *   · 改前 `actorKeyOf` / `wakeKeyOf` 把"席位名 === 角色名"当成**有席位**
 *     ⇒ 单席位角色的键被写成 `tester#tester`（`from_seat="tester"` 的台账行、
 *       以及重建账本那侧的口径都产出过这种键）；
 *   · 那些行**已经落在盘上的账本里**，本插件**不迁移、不改写**它们（账本是"恰一次"的证据，
 *     改写历史就等于伪造证据）；
 *   · 于是读取侧必须**新旧两种形态都认** —— 否则历史账本会被当成"没播过"，
 *     同一条事件在重启后被**重播**一次（那正是 A1 / A19 要治的事）。
 *
 * 返回 `null` = 该键**没有旧形态**（真的带席位的键，如 `writer#1`，旧口径算出来一模一样）。
 *
 * @param {{taskId?:string, kind?:string, actorRole?:string, actorSeat?:string|null, disc?:string|number|null}} spec
 * @returns {string|null}
 */
export function legacyWakeKeyOf(spec = {}) {
  const s = spec ?? {}
  const actor = actorKeyOf(s.actorRole, s.actorSeat)
  if (actor.length === 0 || actor.includes('#')) return null
  const kind = String(s.kind ?? 'event')
  const disc = s.disc === null || s.disc === undefined || s.disc === '' ? 'none' : String(s.disc)
  return `${String(s.taskId ?? '')}|${kind}|${actor}#${actor}|${disc}`
}

/**
 * ★ 读取侧：账本里有没有这把键 —— **新旧两种形态都认**。
 *
 * 写入侧一律只用新形态（{@link wakeKeyOf}），旧形态只在这里被"认出来"。
 *
 * @param {object|null} ledger
 * @param {string} key - 新口径的键
 * @param {string|null} legacyKey - 旧口径的键（没有就给 null）
 * @returns {string|null} **命中的那一把**（没命中给 null）—— 报出账本里真实的那行，便于配对可读
 */
function deliveredKeyFormIn(ledger, key, legacyKey) {
  if (ledger === null || ledger === undefined || typeof ledger.hasDelivered !== 'function') return null
  if (ledger.hasDelivered(key)) return key
  if (typeof legacyKey === 'string' && legacyKey.length > 0 && ledger.hasDelivered(legacyKey)) return legacyKey
  return null
}

/** 交付键 ⇒ **确定的** `requestId`（宿主那侧靠它幂等；同一次交付重放同一个 id）。 */
export function wakeRequestIdOf(key) {
  return `pipeline-wake-${shortHash(key)}`
}

/** 交付键 ⇒ **确定的** `message.id`（会话 v4 准入要求非空字符串；本插件靠它查重）。 */
export function wakeMessageIdOf(key) {
  return `wake-${shortHash(key)}`
}

/**
 * 从工具的**返回值**里抠判别子（顺序即优先级，取到第一个非空的）。
 *
 * ★ 特例：`pipeline_transition` 的两个字段是一对（`from` + `to`），
 *   单独一个都不构成"哪一次转换"。所以 `['from','to']` 这种**成对**写法会被
 *   规范成 `from→to` —— 键里因此能读出"这是哪一次真实转换"。
 *
 * @param {object} result
 * @param {string[]} fields
 * @returns {string|null}
 */
export function discriminatorOf(result, fields) {
  if (result === null || typeof result !== 'object') return null
  const list = Array.isArray(fields) ? fields : []
  /**
   * ★★ **B5：判别子要能在"信封"里找到**。
   *
   * 实测（真单 T-20261011-214043 的 `audit.jsonl`）：**每一条** `wake:delivered`
   * 的交付键都以 `h<historyLen>` 结尾 —— 包括本该用 `handoff_id` / `request_id`
   * 的那些。也就是说 `tools/post-execute` 交到本插件手里的 `result`
   * **顶层并不带工具返回值的那几个字段**（同一个证据：`pipeline_transition`
   * 的 `from`/`to` 也读不到，所以账本里 `kind=transition` 的唤醒**一条都没有**）。
   *
   * 所以这里逐层找（顶层 → 常见信封层 → 再兜一层 `content[].json`），
   * 找不到才返回 null —— **绝不退到"递增计数器"**（那是 B5 的根因）。
   */
  const envelopes = [result, result.structuredContent, result.data, result.result, result.value, result.output]
  const take = (o, f) => {
    if (o === null || o === undefined || typeof o !== 'object') return null
    const v = o[f]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return null
  }
  const takeAnywhere = (f) => {
    for (const env of envelopes) {
      const v = take(env, f)
      if (v !== null) return v
    }
    const content = Array.isArray(result.content) ? result.content : []
    for (const c of content) {
      const v = take(c, f) ?? take(c?.json, f)
      if (v !== null) return v
    }
    return null
  }
  // ★ 成对写法：`['from','to']` ⇒ `from→to`（两半都必须在，缺一不可）。
  if (list.length === 2 && list[0] === 'from' && list[1] === 'to') {
    const a = takeAnywhere('from')
    const b = takeAnywhere('to')
    return a !== null && b !== null ? `${a}→${b}` : null
  }
  for (const f of list) {
    const v = takeAnywhere(f)
    if (v !== null) return v
  }
  return null
}

/**
 * ★★ **B5：从任务台账里取"稳定交付身份"** —— 幂等键不许含"递增计数器"。
 *
 * 为什么不能靠工具返回值那一路：实测它拿不到（见 {@link discriminatorOf}）。
 * 而"这次到底交了什么"**台账里一定有**（交接物/制品/记录/请求都是先落盘再返回），
 * 所以按事件类别取**最新那一条的身份**：
 *   · 同一件事被重放 ⇒ 台账最新一条没变 ⇒ 同一个键 ⇒ 去重命中（不再刷屏）；
 *   · 新的一件事 ⇒ 台账多一条 ⇒ 新键（不会把第二条吞掉）。
 *
 * ★ 与"退到 `h<historyLen>`"的区别就在这里：历史长度是**单调递增的计数器**，
 *   它保证"每次都不同" ⇒ **去重永远不可能命中**（实测 h228 → h233 → h237，
 *   同一条人工介入请求被播报三遍）。身份则刚好相反。
 *
 * @param {string} kind - `handoff` / `artifact` / `record` / `clarify` / `human` / `transition` / `liveness`
 * @param {object|null} task
 * @returns {string|null} 取不到就 null（调用方**不许**改用一个计数器顶上）
 */
export function ledgerIdentityOf(kind, task) {
  const t = task !== null && typeof task === 'object' ? task : null
  if (t === null) return null
  const last = (arr, pick) => {
    const a = Array.isArray(arr) ? arr : []
    for (let i = a.length - 1; i >= 0; i--) {
      const v = pick(a[i])
      if (typeof v === 'string' && v.length > 0) return v
    }
    return null
  }
  switch (String(kind ?? '')) {
    case 'handoff':
      return last(t.handoffs, (h) => h?.handoff_id)
    case 'artifact':
      return last(t.artifacts, (a) => a?.version)
    case 'record':
      return last(t.records, (r) => r?.record_id)
    case 'clarify':
      return last(t.clarify_requests, (r) => r?.request_id)
    case 'human':
      return last(t.human_requests, (r) => r?.request_id)
    case 'transition':
      // ★ 逐次事件：取**最新一条历史**的内容身份（不是它的下标）。
      return last(t.history, (h) => {
        const at = typeof h?.at === 'string' ? h.at : null
        const action = typeof h?.action === 'string' ? h.action : null
        if (at === null || action === null) return null
        const from = typeof h?.from === 'string' ? h.from : ''
        const to = typeof h?.to === 'string' ? h.to : ''
        return `${action}@${at}${from || to ? `:${from}->${to}` : ''}`
      })
    case 'liveness':
      return last(t.liveness?.escalations, (e) => (typeof e?.at === 'string' ? `${e.at}|${(e.seats ?? []).join('+')}` : null))
    default:
      return null
  }
}

/**
 * ★★ **A4/A5：身份必须来自事件自身，而不是"最新一条别人的记录"**
 * ============================================================================
 * 现场（四种吞法里的第 1 / 3 / 4 条，全部有审计留痕）：
 *   · **拿错身份**：一条「交了一份交接物」的唤醒，键里用的是**编写席**的
 *     `H-7d661abef1479500`（`T-…|handoff|**tester**|H-7d661abef1479500`）——
 *     实体是 writer 交的，键里的执行者写着 tester ⇒ **生产者与实体错配**（A4）。
 *   · **复用旧身份**：多条唤醒反复复用**早已答复过**的旧 `HR-…` 请求 id（A5）。
 *   · **静默跳过**：身份还没产生就试着唤醒（唤醒尝试比交付落地早 9 秒）⇒
 *     `reason:no-stable-identity` ⇒ **干脆不叫**（A3 要治的正是这一条）。
 *
 * 根因就一句：`ledgerIdentityOf(kind, task)` 取的是"该类别**最新那一条**"——
 * 它既不管**是谁**交的，也不管**播没播过**，于是"最新一条"常常是**别人家的、
 * 或者上一轮的**实体。下面这一组函数把它换成三条硬判据：
 *   ① **作者对齐**（A4）：实体的提交者必须就是这次事件的执行者，错配一律不采纳；
 *   ② **没播过才算新**（A1/A5）：算出来的键若已在已播报账本里，说明这条**早就播过**
 *      ⇒ 不当新事件用（那正是"延迟重放"）；
 *   ③ 一条都没有时**不再编造**，而是分清"**重放**"（账本里有 ⇒ 去重）与
 *      "**真的还没产生**"（交给调用方，等一等再读；仍没有 ⇒ 走**看得见的失败**）。
 */

/**
 * 席位键口径 —— 与 {@link wakeKeyOf} **同一份**（换算同在 `seatSegmentOf` 一处）。
 *
 * 三条形态（★ 后两条是本轮硬化补的判据）：
 *   · `writer#1` / `writer#2` ⇒ 原样保留席位（多席位角色，**不许**被并成 `writer`）；
 *   · `seat` 为空 / `null` ⇒ 角色名（`tester` ⇒ `tester`）；
 *   · ★★ `seat === role` ⇒ **视作无席位** ⇒ 角色名（`tester` + `tester` ⇒ `tester`，
 *     不再是 `tester#tester`）。
 *
 * 改前缺第三条：单席位角色的 `from_seat` 是**角色名**（`lib/handoff.js` 的
 * `resolveHandoffSeat` 第 ③ 档），于是台账里的行被算成 `tester#tester`，
 * 与实时令牌那侧算出的 `tester` 对不上 ⇒ `ledgerIdentityScoped` 的「作者对齐」在
 * **账本重建**那条路上把自家实体挡掉（`disc:null` / `source:'none'` ⇒ 该叫不叫）。
 *
 * @param {string} role
 * @param {string|null} [seat]
 * @returns {string} 席位键（`writer#2` / `tester` …）
 */
export function actorKeyOf(role, seat = null) {
  const r = String(role ?? '')
  if (r.length === 0) return ''
  const s = seatSegmentOf(r, seat)
  return s.length === 0 ? r : `${r}#${s}`
}

/**
 * 该类别在台账里的**候选身份**（按时间正序；每条带"谁交的"）。
 *
 * 键的拼法与 {@link ledgerIdentityOf} **逐字同源** —— 两个函数必须一起改，
 * 否则"重建账本"（`lib/wakeledger.js`）会算出与线上不同的键，重建就判不出重复。
 *
 * @param {string} kind
 * @param {object|null} task
 * @returns {Array<{disc:string, author:string, at:string|null}>}
 */
/**
 * ★ **A5 / T5 / D6：取出实体的生命周期状态（供"已处理的不许再当新事件"这条判据用）。**
 *
 * 现场：多条唤醒反复复用**早已答复过**的旧 `HR-…` 请求 id —— 一条早已处理完的旧请求
 * 被采纳成"这一次交付"的键，反复播报（A5 的第 3 种吞法）。
 *
 * 生命周期（`lib/store.js`）：`pending → relayed → answered`（澄清另有 `escalated`）。
 * 这里只**如实取出**它，怎么判由 {@link liveLedgerCandidates} 一处说了算。
 *
 * ★ 取不到（没有 `status` 字段）就返回 `null` —— **不猜、也不因此把实体打成不可用**：
 *   既有用例里就有不带 `status` 的实体，它们照旧要被采纳。
 *
 * @param {object|null|undefined} r
 * @returns {string|null}
 */
export function statusOfLedgerEntry(r) {
  if (r === null || r === undefined || typeof r !== 'object') return null
  const raw = r.status
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  return s.length === 0 ? null : s
}

/**
 * ★★ **A5 / T5 / D6（打回项 ②）：按生命周期过滤台账候选 —— 已处理的旧实体不许当新事件。**
 *
 * 与 {@link ledgerCandidates} 的分工：那一个只管"台账里有哪些实体"，这一个只管
 * "其中哪些**还没走完**、可以代表当前这次事件"。两件事分开，重建账本那侧不受影响。
 *
 * ★ 状态**从台账原文取**（不依赖候选的形状）：按身份值去原文里对齐，
 *   顺序按**最后出现**的算（与"取最新一条"同向）。
 *
 * @param {string} kind
 * @param {object|null} task
 * @returns {Array<{disc:string, author:string, at:string|null, status:string|null}>}
 */
export function liveLedgerCandidates(kind, task) {
  const all = ledgerCandidates(kind, task)
  const live = new Map()
  const note = (r) => {
    const id = kind === 'handoff'
      ? r?.handoff_id
      : kind === 'artifact'
        ? r?.version
        : kind === 'record'
          ? r?.record_id
          : r?.request_id
    if (typeof id === 'string' && id.length > 0) live.set(id, statusOfLedgerEntry(r))
  }
  if (kind === 'clarify') for (const r of Array.isArray(task?.clarification_requests) ? task.clarification_requests : []) note(r)
  else if (kind === 'human') for (const r of Array.isArray(task?.human_requests) ? task.human_requests : []) note(r)
  else if (kind === 'handoff') for (const r of Array.isArray(task?.handoffs) ? task.handoffs : []) note(r)
  else if (kind === 'artifact') for (const r of Array.isArray(task?.artifacts) ? task.artifacts : []) note(r)
  else if (kind === 'record') for (const r of Array.isArray(task?.records) ? task.records : []) note(r)
  const out = []
  for (const c of all) {
    const st = typeof c?.status === 'string' && c.status.length > 0 ? c.status : live.get(c?.disc) ?? null
    if (st !== null && st !== 'pending' && st !== 'relayed') continue
    out.push(c)
  }
  return out
}

export function ledgerCandidates(kind, task) {
  const t = task !== null && typeof task === 'object' ? task : null
  if (t === null) return []
  const out = []
  const push = (disc, author, at, status = null) => {
    if (typeof disc !== 'string' || disc.length === 0) return
    out.push({
      disc,
      author: String(author ?? ''),
      at: typeof at === 'string' && at.length > 0 ? at : null,
      /** ★ 生命周期状态（T5/D6）：`liveLedgerCandidates` 靠它把"已处理"的旧实体挡掉。 */
      status: statusOfLedgerEntry({ status }),
    })
  }
  switch (String(kind ?? '')) {
    case 'handoff':
      for (const h of Array.isArray(t.handoffs) ? t.handoffs : []) push(h?.handoff_id, actorKeyOf(h?.from_role, h?.from_seat), h?.created_at)
      break
    case 'artifact':
      for (const a of Array.isArray(t.artifacts) ? t.artifacts : []) push(a?.version, actorKeyOf(a?.role ?? 'writer', a?.seat), a?.created_at ?? a?.at)
      break
    case 'record':
      for (const r of Array.isArray(t.records) ? t.records : []) push(r?.record_id, actorKeyOf(r?.base ?? r?.role, r?.seat), r?.at)
      break
    case 'clarify':
      for (const r of Array.isArray(t.clarification_requests) ? t.clarification_requests : []) push(r?.request_id, actorKeyOf(r?.from_role, r?.from_seat), r?.at ?? r?.created_at, r?.status)
      break
    case 'human':
      for (const r of Array.isArray(t.human_requests) ? t.human_requests : []) push(r?.request_id, actorKeyOf(r?.from_role, r?.from_seat), r?.at ?? r?.created_at, r?.status)
      break
    case 'transition':
      // ★ 逐次事件：取**最新一条历史的内容身份**（不是它的下标，也不是它的长度）。
      //   身份含 `at` ⇒ A→B→A 的第二次是**另一条**；同一条重放则是同一个 `at`。
      for (const h of Array.isArray(t.history) ? t.history : []) {
        const at = typeof h?.at === 'string' ? h.at : null
        const action = typeof h?.action === 'string' ? h.action : null
        if (at === null || action === null) continue
        const from = typeof h?.from === 'string' ? h.from : ''
        const to = typeof h?.to === 'string' ? h.to : ''
        push(`${action}@${at}${from || to ? `:${from}->${to}` : ''}`, String(h?.actor ?? ''), at)
      }
      break
    case 'liveness': {
      const escs = Array.isArray(t.liveness?.escalations) ? t.liveness.escalations : []
      for (let i = 0; i < escs.length; i++) {
        const e = escs[i]
        const seats = Array.isArray(e?.seats) ? e.seats.slice().sort().join(',') : ''
        push(`${seats}|${i + 1}`, WAKE_ACTOR_MECHANISM, e?.at)
      }
      break
    }
    default:
      break
  }
  return out
}

/**
 * ★ **按作者与"播没播过"筛过的台账身份**（A4 / A5 的落点）。
 *
 * @param {object} spec
 * @param {string} spec.kind
 * @param {object|null} spec.task
 * @param {string} [spec.actor] - 本次事件的执行者（`role[#seat]`）
 * @param {object|null} [spec.ledger] - 已播报账本（给了才做"播没播过"的判断）
 * @param {string|null} [spec.prefer] - 只认与它相符的候选（状态推进用它钉住"这一步"）
 * @returns {{disc:string|null, source:string, key:string|null, author:string|null, replayKey:string|null, candidates:number}}
 */
export function ledgerIdentityScoped(spec = {}) {
  const task = spec.task !== null && typeof spec.task === 'object' ? spec.task : null
  const kind = String(spec.kind ?? '')
  const actor = String(spec.actor ?? '')
  const ledger = spec.ledger ?? null
  /**
   * ★ `prefer` 的口径统一：`discriminatorOf` 把成对字段拼成 `from→to`（箭头字符），
   *   而历史里的内容身份写的是 `from->to` ⇒ 比较前先归一，否则"这一步"永远匹配不上。
   */
  const preferRaw = typeof spec.prefer === 'string' && spec.prefer.length > 0 ? spec.prefer : null
  const prefer = preferRaw === null ? null : preferRaw.replace('→', '->')
  const taskId = String(task?.id ?? '')
  /**
   * ★★ **A5 / T5 / D6（打回项 ②）：候选换成"过滤过生命周期"的那一份。**
   *
   * 改前这里直接用 `ledgerCandidates(kind, task)` —— 它不看状态，于是**早已答复过**的
   * 旧 `HR-…` 被当成"这一次交付"的身份采纳，同一条事件被反复播报（A5 第 3 种吞法）。
   * 现在由 `liveLedgerCandidates` 把终态实体挡掉：拿不到"尚未处理"的实体时，
   * 下面会返回 `disc:null`，由 `wake()` 走去等 → **看得见的失败**（而不是采纳旧身份）。
   */
  const cands = liveLedgerCandidates(kind, task)
  let announced = null
  for (let i = cands.length - 1; i >= 0; i--) {
    const c = cands[i]
    // ① 作者对齐：键里的执行者必须就是这条实体的提交者（错配 ⇒ 不采纳）。
    if (actor.length > 0 && c.author.length > 0 && c.author !== actor) continue
    // ② 状态推进：只认"这一步真实转换"（同 from→to）的那条历史。
    if (prefer !== null && !c.disc.includes(prefer)) continue
    /**
     * ★★ **状态推进的判别子形状**（兼容既有口径，又补上"逐次唯一"）：
     *   `<from>→<to>@<这一条历史的 at>`。
     *
     * 为什么不能直接用 `<action>@<at>:<from>-><to>`：既有用例（`tests/wake-fidelity-check.mjs`
     * 的 B5）逐字断言键里**含 `ready_plan→planning`**（箭头字符）—— 那是"键要能读出
     * 这是哪一次真实转换"的判据，不许为了新格式把它弄丢。所以保留箭头那一半，
     * 只在后面追加 `@at`：既有断言照旧成立，而 A→B→A 的第二次因为 `at` 不同
     * **仍然是新键**（改前 `h<n>` 递增计数器那条错误的路子不会被重新引入）。
     */
    const discHere = spec.transitionDisc === true && preferRaw !== null && c.at !== null ? `${preferRaw}@${c.at}` : c.disc
    const key = wakeKeyOf({ taskId, kind, actorRole: actor.split('#')[0] || actor, actorSeat: actor.includes('#') ? actor : null, disc: discHere })
    /**
     * ★★ **旧键只读兼容**：改前 `actorKeyOf` 把"单席位角色"算成 `角色#角色`
     *   （`from_seat="tester"` ⇒ `tester#tester`），账本里**已经写下的那些行不迁移、不改写**；
     *   这里顺手再探一次旧形态 —— 否则历史账本会被当成"没播过"，同一条事件被重播。
     */
    const legacyKey = legacyWakeKeyOf({ taskId, kind, actorRole: actor.split('#')[0] || actor, actorSeat: actor.includes('#') ? actor : null, disc: discHere })
    const hitForm = deliveredKeyFormIn(ledger, key, legacyKey)
    if (hitForm !== null) {
      // ③ 已经播过 ⇒ 这不是一条新事件（那正是"延迟重放"的形状）。
      //    ★ 报出**账本里真实的那一行**（旧形态命中时就报旧形态）—— 与原投递配对可读。
      if (announced === null) announced = hitForm
      continue
    }
    return { disc: discHere, source: 'ledger-scoped', key, author: c.author, replayKey: null, candidates: cands.length }
  }
  return {
    disc: null,
    source: announced === null ? 'none' : 'replay',
    key: null,
    author: null,
    replayKey: announced,
    candidates: cands.length,
  }
}

/**
 * ★★ **事件自身身份的总入口**（A3 / A4 / A5）。
 *
 * 顺序即优先级：
 *   ① 工具**这一次调用自己的返回值**里能读到的身份（最直接，且与"这一次"一一对应）；
 *   ② **同作者、且还没播过**的台账身份（工具返回值读不到时的替代 —— 但**不许**再回落
 *      到"别人家的 / 上一轮的"实体）；
 *   ③ 都没有 ⇒ `disc:null`，并把"是**重放**（账本里有）还是**真没有**"如实分开
 *      —— 重放走去重，真没有走去等 / 走看得见的失败。**绝不退成递增计数器**。
 *
 * @param {object} spec
 * @param {string} spec.kind
 * @param {string} [spec.toolName]
 * @param {object|null} [spec.result]
 * @param {object|null} [spec.task]
 * @param {string} [spec.actor]
 * @param {object|null} [spec.ledger]
 * @returns {{disc:string|null, source:string, key:string|null, replayKey:string|null}}
 */
export function eventIdentityFor(spec = {}) {
  const kind = String(spec.kind ?? '')
  const toolName = String(spec.toolName ?? '')
  const result = spec.result ?? null
  const trig = WAKE_TRIGGER_TOOLS[toolName]
  const fields = trig?.disc ?? ['id']
  const fromResult = discriminatorOf(result, fields)
  if (kind === 'transition') {
    /**
     * ★ 状态推进：结果里的 `from`/`to` 只回答"哪一对"，不含 `at` ⇒ 用它去台账里
     *   钉住**这一步**（身份 = `<from>→<to>@<历史 at>`：逐次唯一、无递增计数器，
     *   且**保留既有断言要的箭头形态** —— 见 `ledgerIdentityScoped` 里的说明）。
     */
    const scoped = ledgerIdentityScoped({ ...spec, prefer: fromResult, transitionDisc: fromResult !== null })
    if (scoped.disc !== null) return { disc: scoped.disc, source: scoped.source, key: scoped.key, replayKey: null }
    if (scoped.replayKey !== null) return { disc: null, source: 'replay', key: null, replayKey: scoped.replayKey }
    if (fromResult !== null) {
      // 兜底：台账里查不到这一步（历史读不到）⇒ 用 `from→to`，并**如实标注**它不含 `at`。
      return { disc: fromResult, source: 'result-pair', key: null, replayKey: null }
    }
    return { disc: null, source: 'none', key: null, replayKey: null }
  }
  if (fromResult !== null) return { disc: fromResult, source: 'result', key: null, replayKey: null }
  const scoped = ledgerIdentityScoped(spec)
  if (scoped.disc !== null) return { disc: scoped.disc, source: scoped.source, key: scoped.key, replayKey: null }
  if (scoped.replayKey !== null) return { disc: null, source: 'replay', key: null, replayKey: scoped.replayKey }
  return { disc: null, source: 'none', key: null, replayKey: null }
}

/** 小睡（**只用于"等身份产生"这一处**：等一次读盘的时间，不做轮询、不起定时器）。 */
export function sleep(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 200) : 0
  return new Promise((resolve) => setTimeout(resolve, wait))
}

/**
 * ★★ **状态推进的交付键判别子** —— 现场修复（2026-10-11）。
 *
 * 用户原话：「幂等键必须覆盖'同一转换只发一次'（键要由**任务 + 事件类型 +
 * 真实转换前后状态 + 执行者**稳定派生）」。
 *
 * 所以这一条由三段拼成，各管一件事：
 *   · `from→to`   —— **语义**：这是哪一次真实转换（前后状态都写进去）。
 *                     同一件事重复报 → 同一段 → 同一个键 → 被幂等吃掉。
 *   · `h<n>`      —— **逐次**：任务历史的长度。A→B→A 那种"状态回来了、但确实是
 *                     第二次"必须能区分开，否则第二条会被当成重复**吞掉**。
 *   · 任务 + 执行者 —— 由 `wakeKeyOf` 拼在最外层（`taskId|kind|actor|…`）。
 *
 * ★ 为什么不只用 `h<n>`（改前的行为）：数字后缀不携带语义 —— 同一件事落在不同
 *   历史长度上就会拿到两个不同的键，幂等判据当场失效（实测 h10 / h16 同形不同键）。
 *
 * @param {object|null} result - 工具返回值
 * @param {number|null} historyLen - 任务历史长度（逐次唯一的兜底）
 * @returns {string}
 */
export function transitionDiscOf(result, historyLen) {
  const pair = discriminatorOf(result, ['from', 'to'])
  const per = `h${Number.isFinite(historyLen) ? historyLen : 'x'}`
  return pair === null ? per : `${pair}|${per}`
}

/**
 * ★★ **B5：稳定交付身份的总入口**（工具结果 → 台账，谁先有就用谁）。
 *
 * 顺序就是优先级：
 *   ① 工具**返回值**里能读到的身份（envelope 深搜，见 `discriminatorOf`）——
 *      最直接，且与"这一次调用"一一对应；
 *   ② 台账里**最新一条**同类别记录的身份（`ledgerIdentityOf`）——
 *      工具返回值读不到时的替代（实测线上**全部**走这条）；
 *   ③ 都没有 ⇒ **返回 null**。调用方**不许**退回"任务历史长度"这种递增计数器：
 *      那保证每次都不同 ⇒ 去重永远不命中 ⇒ 同一条交付被反复重放（B5 的现场）。
 *
 * @param {{kind:string, result?:object|null, task?:object|null}} spec
 * @returns {string|null}
 */
export function stableDiscFor(spec) {
  const s = spec ?? {}
  const fromResult = discriminatorOf(s.result ?? null, WAKE_TRIGGER_TOOLS[String(s.toolName ?? '')]?.disc ?? ['id'])
  if (fromResult !== null) return fromResult
  return ledgerIdentityOf(String(s.kind ?? ''), s.task ?? null)
}

/**
 * 「下一步合法事件」那一句 —— **照 `pipeline_status` 的口径**（同一个数据源
 * `availableTransitions()`，不另造一份判断）。
 *
 * @param {object|null} task - 任务（**必须已含转换后的状态**，见 `stateOfTask`）
 * @param {string} [labelSuffix] - 状态标签后面附的一句（例如"转换后"）
 * @returns {string} 一行；终态时说清楚"没得推了"
 */
export function nextStepLine(task, labelSuffix = '') {
  const state = typeof task?.state === 'string' ? task.state : ''
  if (state.length === 0) return '下一步：**任务状态读不到** —— 用 pipeline_status 查一次。'
  const label = STATE_LABEL[state] ?? state
  const owner = STATE_OWNER[state] ?? null
  let next = []
  try {
    next = availableTransitions(state)
  } catch {
    next = []
  }
  if (next.length === 0) {
    return `下一步：**无合法事件**（当前状态「${label}${labelSuffix}」是终态）—— 不需要再推。`
  }
  const head = next[0]
  const ownerText = owner === null ? '' : `（${owner}）`
  return (
    `下一步：**${head.event} ${ownerText} → ${STATE_LABEL[head.to] ?? head.to}**` +
    (next.length > 1 ? `　（另有 ${next.length - 1} 条可选：${next.slice(1).map((t) => t.event).join(' / ')}）` : '')
  )
}

/**
 * ★★ **渲染用的任务快照** —— 当前状态、下一步、谁，**共用的唯一权威来源**。
 *
 * 现场（2026-10-11）：唤醒正文报的是**转换之前**的状态，于是正文、`下一步`、
 * 甚至"谁"全错 —— 主对话被引去处理一个**不存在的状态**（实测两次被引去
 * "取一封不存在的信"）。
 *
 * 修法（用户原话："一律取**转换之后**的真实值；从同一个权威来源取，不要各算一遍"）：
 *   · 工具**自己报的**转换后状态（`spec.stateAfter`）优先 —— 那是"这一次操作
 *     到底把任务推到了哪"的**直接证据**，不依赖任何缓存/读盘时序；
 *   · 没有就用任务对象（`spec.task`，由 `getTask` 取）；
 *   · 两者都没有 ⇒ 返回 null，正文如实写"读不到"。
 *
 * ★ 关键性质：返回的是**一个**对象，`renderWakeText` 里的
 *   「状态标签 / 下一步 / 谁（STATE_OWNER）」**全从它派生** ——
 *   结构上不可能出现"状态说 A、下一步按 B 算"这种自相矛盾。
 *
 * @param {{task?:object|null, stateAfter?:string|null}} spec
 * @returns {object|null}
 */
export function stateOfTask(spec) {
  const s = spec ?? {}
  const after = typeof s.stateAfter === 'string' && s.stateAfter.length > 0 ? s.stateAfter : null
  if (after !== null) {
    // ★ 换的是**状态**那一格，任务其它字段（roster / history …）照旧 ——
    //   下一步合法事件只看 state，所以这份快照与"真任务"同源同口径。
    const base = s.task !== null && typeof s.task === 'object' ? s.task : {}
    return { ...base, state: after }
  }
  return s.task !== null && typeof s.task === 'object' ? s.task : null
}

/**
 * 渲染唤醒消息的**正文**（可操作，不是干巴巴的通知）。
 *
 * 四段：谁 · 发生了什么 · 任务现在什么状态 · **下一步合法事件**。
 *
 * ★ "任务现在什么状态"取的是**转换之后**的值（见 `stateOfTask`）——
 *   被唤醒的人据此行动，报错一个状态就会把他引到不存在的下一步去。
 *
 * @param {object} spec
 * @returns {string}
 */
export function renderWakeText(spec) {
  const s = spec ?? {}
  const who = `${actorLabel(s.actorRole ?? 'unknown')}${s.actorSeat === null || s.actorSeat === undefined ? '' : ` / ${s.actorSeat}`}`
  // ★ 唯一权威来源：状态、下一步、谁**全从这一份**派生。
  const snapshot = stateOfTask(s)
  const state = typeof snapshot?.state === 'string' && snapshot.state.length > 0 ? snapshot.state : ''
  // 过渡（`from → to`）：正文里点明"这是转换后的状态"，免得读者以为它早就在这儿了。
  const moved = typeof s.stateFrom === 'string' && s.stateFrom.length > 0 && s.stateFrom !== state
  const suffix = moved ? '（**转换后**）' : ''
  const L = []
  L.push(`【多 AI 协同流水线 · 唤醒】任务 ${String(s.taskId ?? '(未知)')}`)
  L.push('')
  L.push(`谁：${who}`)
  L.push(`发生了什么：${String(s.what ?? '有一次事件')}`)
  if (state.length === 0) {
    L.push('任务当前状态：(读不到) —— 用 pipeline_status 查一次')
    L.push('下一步：**状态读不到** —— 用 pipeline_status 查一次。')
  } else {
    L.push(
      `任务当前状态：${STATE_LABEL[state] ?? state}（\`${state}\`）${suffix}` +
        (moved ? `　← 刚从 ${STATE_LABEL[s.stateFrom] ?? s.stateFrom}（\`${s.stateFrom}\`）转过来` : ''),
    )
    L.push(nextStepLine(snapshot, suffix))
  }
  if (typeof s.note === 'string' && s.note.length > 0) L.push(`补充：${s.note}`)
  /**
   * ★★ **B4：状态快照会过期，必须自己说出来**。
   *
   * 现场：当晚 6 条唤醒全部声称"已阻塞"，而实际状态依次是
   * 「开发中 / 等待需求分析答复 / 计划中 / 开发中」—— 正文里那份任务是**生成那一刻**的快照，
   * 经会话排队投递之后已经过期；主对话据此发起的一次 `unblock` **被状态机拒绝**（白打一次往返）。
   *
   * 为什么不做成"投递时重读"：唤醒是投进目标会话的**队列**，投递完还要排队等它那一步，
   * 排队期间的漂移照样会发生 ⇒ 单靠重读治不了根。所以**两件都做**：
   *   · 这里写死快照的**取样时刻**，并明说"动手前请重读"（读者据此知道该不该信这一行）；
   *   · `wake()` 在投递**前一刻**才渲染正文（把"生成→投递"这段窗口压到最小）。
   */
  const snapAt = typeof s.snapshotAt === 'string' && s.snapshotAt.length > 0 ? s.snapshotAt : '(未记录取样时刻)'
  L.push('')
  L.push(`★ 上面这一行状态是**快照**（取样于 ${snapAt}）—— 唤醒要排队投递，` +
    '**动手前请先 `pipeline_status` 重读一次**：状态可能已经变了，照旧状态做会被状态机拒掉。')
  L.push('')
  L.push('★ 你是**主对话**：这一步只有你能做（派活 / 转告用户 / 关单）。')
  L.push(`★ 这条是**运行时上下文**（\`source.kind=${WAKE_SOURCE_KIND}\`，form=\`${WAKE_FORM}\`），`)
  L.push('  **不是用户说的话** —— 它是机制在"席位交付 / 状态推进 / 席位失联"时主动叫醒你的信号。')
  L.push(`★ 同一次交付**只唤醒一次**（交付键 \`${String(s.key ?? '')}\`，requestId 幂等）。`)
  return L.join('\n')
}

/**
 * 造一条**唤醒用的宿主消息**（唯一出口 = `hostMessage`，见文件头判据 ①）。
 *
 * @param {object} spec
 * @returns {object} 宿主形状的消息（`{id, role, content, source}`）
 */
export function wakeMessage(spec) {
  const s = spec ?? {}
  const key = typeof s.key === 'string' && s.key.length > 0 ? s.key : wakeKeyOf(s)
  const msg = hostMessage({
    // ★ 显式 id：幂等键的确定性派生 —— 同一次交付重放得到**同一条**消息 id，
    //   于是"目标会话的 inbox 里已经有了"这件事可以被直接查到。
    id: wakeMessageIdOf(key),
    // ★ 判据 ①：直接投主对话会话，kind 必须是 runtime-context。
    kind: WAKE_SOURCE_KIND,
    form: WAKE_FORM,
    text: renderWakeText({ ...s, key }),
    taskId: s.taskId,
    role: s.actorRole,
    seat: s.actorSeat ?? null,
    extra: { wake_key: key, event: String(s.kind ?? 'event'), via: String(s.via ?? 'post-execute') },
  })
  return msg
}

// ---------------------------------------------------------------------------
// 宿主投递
// ---------------------------------------------------------------------------

/** 读宿主服务：一律 `ctx.get()`（拿不到返回 undefined，**不抛**）。与 transport 同口径。 */
function readService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * ★ **目标会话里是不是已经有这条消息了** —— 宿主侧的查重。
 *
 * 判据取宿主自己的两个队列（`hasPromptRequest()` 扫的就是这两处）：
 *   · `agent.inbox.nextTurn`  —— 排队等下一轮
 *   · `agent.inbox.nextStep`  —— 排队等下一步
 * 再加一段落盘事件兜底（进程内重建 registry 时，队列可能已经空了）。
 *
 * @returns {boolean}
 */
export function alreadyDelivered(agent, messageId) {
  if (agent === null || agent === undefined) return false
  if (typeof messageId !== 'string' || messageId.length === 0) return false
  const queues = [agent?.inbox?.nextTurn, agent?.inbox?.nextStep]
  for (const q of queues) {
    if (Array.isArray(q) && q.some((m) => m !== null && typeof m === 'object' && m.id === messageId)) return true
  }
  const snap = agent?.session?.snapshotEvents
  if (typeof snap === 'function') {
    try {
      const events = snap.call(agent.session)
      if (Array.isArray(events)) {
        return events.some((e) => e?.type === 'user/message' && e?.data?.id === messageId)
      }
    } catch {
      /* 读不到就当没查过 —— 不能因为兜底查询失败而重复注入 */
    }
  }
  return false
}

/**
 * ★ **目标会话在不在这个进程里**（三态，`lib/wakeup.js` 的 `wake()` 用它留痕）。
 *
 * 为什么要单独问一句：`task.contacts.main` 里那份会话 id 是**上一刻**写下的，
 * 而用户可以在那之后把那个对话删掉 / 换一个（现场就是这么怀疑的）。
 * 删掉之后 `deliverWake` 会掉到 `sessionController.prompt()` 那条退路 ——
 * 那条路**宿主不保证告诉你入没入队**（见 `deliverWake` 的注释），于是
 * "投进了一个已经不存在的会话"与"投成功了"在 audit 里长得一模一样。
 *
 * 所以这里**只补一条事实**（目标会话在不在进程里），不改任何投递行为：
 *   · `true`  —— 查到了，投递正常；
 *   · `false` —— 查不到（已删除 / 尚未加载）⇒ **仍然投**，但 audit 里写死
 *                `target_live:false` 并 `warn` 一行 —— 这一条很可能收不到，
 *                必须吵，不许安静；
 *   · `null`  —— 拿不到 `ctx.agents`（宿主装配不同 / 测试替身）⇒ **不可知**，
 *                不许写成 `false`（那就是假装知道）。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {boolean|null}
 */
export function probeTargetSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  const agents = readService(ctx, 'agents')
  if (agents === null || agents === undefined || typeof agents.get !== 'function') return null
  try {
    const agent = agents.get(sessionId)
    return agent !== null && agent !== undefined
  } catch {
    return null
  }
}

/**
 * 把唤醒消息投进目标会话。
 *
 * 两条路，**优先级与代价都写在返回值里**（不假装一样）：
 *   (a) `agents.get(sessionId).followup(message)` —— **首选**，source 保住。
 *       这条路与宿主 `prompt()` 内部调的**是同一个方法**，只是不经它那道
 *       "把 source 硬写成 user"的封装。
 *   (b) `sessionController.prompt({requestId, sessionId, mode:'queue', content})`
 *       —— 退路。`requestId` 幂等；但 Host **会把 source 改写为 `user`**
 *       ⇒ 返回 `sourcePreserved:false`，调用方据此留痕。
 *
 * @param {object} deps
 * @param {object} spec
 * @returns {Promise<{ok:boolean, via:string|null, sourcePreserved:boolean, duplicateAtHost:boolean, note:string}>}
 */
export async function deliverWake(ctx, spec) {
  const s = spec ?? {}
  const sessionId = String(s.sessionId ?? '')
  const message = s.message
  const requestId = String(s.requestId ?? '')
  if (sessionId.length === 0 || message === null || typeof message !== 'object') {
    return { ok: false, via: null, sourcePreserved: false, duplicateAtHost: false, note: '缺 sessionId 或 message。' }
  }

  // --- (a) agents.get(sessionId).followup(message) ---------------------------
  const agents = readService(ctx, 'agents')
  const get = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get.bind(agents) : null
  if (get !== null) {
    let agent = null
    try {
      agent = get(sessionId)
    } catch {
      agent = null
    }
    if (agent !== null && agent !== undefined && typeof agent.followup === 'function') {
      if (alreadyDelivered(agent, message.id)) {
        // ★ 宿主侧查重命中：会话里已经有这条 ⇒ **一次都不再注入**（幂等的第二道）。
        return { ok: true, via: 'agent.followup', sourcePreserved: true, duplicateAtHost: true, note: '目标会话里已有同一条（确定性消息 id 命中），不再注入。' }
      }
      try {
        agent.followup(message)
        return { ok: true, via: 'agent.followup', sourcePreserved: true, duplicateAtHost: false, note: `已投进会话 ${sessionId} 的下一轮队列（source 保住 = ${WAKE_SOURCE_KIND}）。` }
      } catch (err) {
        // 掉到退路，但**把原因记下来** —— 不许静默换路。
        s.onFallback?.(`agent.followup 失败：${String(err?.message ?? err)}`)
      }
    }
  }

  // --- (b) sessionController.prompt(...) 退路 ---------------------------------
  const controller = readService(ctx, 'sessionController')
  if (controller === null || controller === undefined || typeof controller.prompt !== 'function') {
    return { ok: false, via: null, sourcePreserved: false, duplicateAtHost: false, note: 'agents.followup 与 sessionController.prompt 都不可用，无法投递。' }
  }
  try {
    await controller.prompt({ requestId, sessionId, mode: 'queue', content: message.content })
    return {
      ok: true,
      via: 'sessionController.prompt',
      sourcePreserved: false,
      // ★ 这里**只能是 `null`（未知）**，不许写成 `false`：
      //   宿主 `prompt()` 无论"新入队"还是"按 requestId 命中已有、直接 `{accepted:true}`"，
      //   返回的都是同一个 `{accepted:true}` —— 它**不告诉调用方**这次到底入没入队。
      //   我们那一侧没有 `agent.inbox` 可查（正是因为拿不到 agents 才走这条退路），
      //   所以"是不是重复"这件事在本插件这一层**不可知**。写 `false` 就是假装知道。
      duplicateAtHost: null,
      note:
        `已投进会话 ${sessionId}（requestId=${requestId}，mode=queue）。` +
        '⚠ 这条走的是宿主 prompt()，**宿主会把 source 改写为 kind=\'user\'** —— source 未被保住；' +
        '而"这次到底新入队还是被 requestId 幂等挡下"宿主不告诉调用方 ⇒ 幂等命中与否**不可知**（如实留痕）。',
    }
  } catch (err) {
    return { ok: false, via: 'sessionController.prompt', sourcePreserved: false, duplicateAtHost: false, note: `投递失败：${String(err?.message ?? err)}` }
  }
}

// ---------------------------------------------------------------------------
// 唤醒器
// ---------------------------------------------------------------------------

/**
 * 造一个**唤醒器**。
 *
 * @param {object} deps
 * @param {object} deps.ctx - Cordis ctx（读 `agents` / `sessionController`）
 * @param {ReturnType<typeof createMainSessionRegistry>} deps.registry - 主对话会话登记表
 * @param {(taskId:string)=>Promise<object|null>} [deps.getTask] - 取任务（渲染状态与下一步）
 * @param {(taskId:string, action:string, detail:object)=>Promise<void>} [deps.audit] - 留痕（store.recordAudit）
 * @param {(m:string)=>void} [deps.warn]
 * @returns {{wake:Function, wakeForTool:Function, registry:object, stats:object, delivered:Map, reset:Function}}
 */
export function createWaker(deps) {
  const ctx = deps?.ctx ?? null
  const registry = deps?.registry ?? createMainSessionRegistry()
  const warn = typeof deps?.warn === 'function' ? deps.warn : () => {}
  /**
   * ★★ **已播报账本**（`lib/wakeledger.js`）—— 「恰一次」跨进程活下去的那一半。
   *
   * 没给（自测替身 / 装配不全）⇒ 退回改前的两层判据（内存表 + 目标会话队列），
   * **不是**"关掉去重"。给了就多一层：盘上有这条键 ⇒ 已经播过 ⇒ 不再播（A19）。
   */
  const ledger = deps?.ledger ?? null
  const getTask = typeof deps?.getTask === 'function' ? deps.getTask : null
  const audit = typeof deps?.audit === 'function' ? deps.audit : null
  /**
   * ★ **落盘的主对话联系人**（`task.contacts.main`）—— 内存登记表没命中时的兜底。
   *
   * 为什么必须有它：内存登记表**进程重启就没了**，而"重启后第一次交付"正是最常见
   * 场景。没有兜底，那次交付会被静默跳过（audit 里留一行 `no-main-session`），
   * 用户看到的就是"重启之后第一条交付又没动静"。
   *
   * @type {((taskId:string)=>Promise<string>)|null}
   */
  const mainContactOf = typeof deps?.mainContactOf === 'function' ? deps.mainContactOf : null

  /**
   * ★ 已投递表：交付键 ⇒ 投递结果。
   * 这是幂等的**第一道**（同进程内重放同一个交付键 ⇒ 直接返回上一次的结论）。
   * 第二道是 {@@link alreadyDelivered}（查目标会话自己的队列）。
   */
  const delivered = new Map()
  /** 上限兜底：只增不减会泄漏。丢一条唤醒无所谓，内存泄漏不会自己好。 */
  const DELIVERED_LIMIT = 2048

  const stats = { attempts: 0, injected: 0, deduped: 0, skipped: 0, failed: 0, fallback: 0 }

  /** 留痕：**绝不抛**（它跑在工具关键路径上）。 */
  async function note(taskId, action, detail) {
    if (audit === null) return
    try {
      await audit(taskId, action, detail)
    } catch (err) {
      warn(`[pipeline] 唤醒留痕失败（不影响本次调用）：${String(err?.message ?? err)}`)
    }
  }

  /**
   * ★★ 唤醒主对话（**唯一入口**）。
   *
   * 任何一步失败都**不抛**；每一类"没做成"都在 audit 里留一行。
   *
   * @param {object} spec
   * @param {string} spec.taskId
   * @param {string} spec.actorRole - 谁触发的（席位角色）
   * @param {string|null} [spec.actorSeat]
   * @param {string} spec.kind - 事件类别（handoff / artifact / … / liveness）
   * @param {string} spec.what - 人话一句话
   * @param {string|null} [spec.disc] - 判别子（幂等键用）
   * @param {string} [spec.via='post-execute']
   * @param {string} [spec.note]
   * @returns {Promise<{ok:boolean, injected:boolean, reason:string, targetSession:string, requestId:string, key:string, via:string|null, sourcePreserved:boolean}>}
   */
  async function wake(spec) {
    const s = spec ?? {}
    stats.attempts++
    const taskId = String(s.taskId ?? '')

    /** 统一的"没做成"出口：**静默跳过**（对调用方）+ audit 留一行。 */
    const skip = async (reason, detail = {}) => {
      stats.skipped++
      await note(taskId, WAKE_AUDIT.skipped, { reason, ...detail })
      return {
        ok: true,
        injected: false,
        reason,
        targetSession: '',
        requestId: '',
        key: '',
        via: null,
        sourcePreserved: false,
      }
    }

    if (taskId.length === 0) return skip('no-task-id', { spec: { kind: s.kind ?? null } })

    // ★ 判据 ②：目标会话**只**从登记表取 —— 结构上就不可能投到别的会话。
    //
    //   两道来源，**同一份判据**（都是"主对话所在会话"）：
    //     ① 内存登记表（本进程内主对话调过 pipeline 工具 ⇒ 最热、最准）；
    //     ② **落盘那份**（`task.contacts.main`）—— 补的正是"DSH 重启后、主对话
    //        还没再调过任何工具"的那个窗口。**没有它，重启后的第一次交付会被
    //        静默跳过**，而那恰恰是最常见的场景（用户关掉再打开）。
    //   ⚠️ 落盘那份也可能是**上一个**主对话会话（认领换了会话），所以它只做
    //      **兜底**：内存有就绝不用它。
    let target = registry.sessionOf(taskId)
    let targetVia = 'registry'
    if ((target === null || target.length === 0) && typeof mainContactOf === 'function') {
      try {
        const persisted = await mainContactOf(taskId)
        if (typeof persisted === 'string' && persisted.length > 0) {
          target = persisted
          targetVia = 'persisted-contact'
          // 顺手补进内存登记表：下次不用再读盘。
          registry.remember(taskId, persisted, 'persisted-contact')
        }
      } catch (err) {
        warn(`[pipeline] 读主对话落盘联系人失败（按未登记处理）：${String(err?.message ?? err)}`)
      }
    }
    if (target === null || target.length === 0) {
      // 反例④：没有登记主对话会话 ⇒ **静默跳过 + audit 一行**，绝不抛错把调用方带崩。
      return skip('no-main-session', {
        hint: '主对话还没调用过任何 pipeline 工具，且 task.contacts.main 里也没有登记 ⇒ 不知道唤醒该投到哪。',
        kind: s.kind ?? null,
      })
    }

    /**
     * ★ 目标会话**在不在进程里**（三态）—— 只影响留痕，不影响投递。
     *
     * 补的正是 2026-10-11 那条怀疑："`contacts.main` 指向的会话已经被用户删掉，
     * 注入投进黑洞、还没人知道"。删掉之后投递会掉到 `sessionController.prompt()`
     * 退路，而那条路**不回报入没入队** ⇒ 在 audit 里与投成功长得一样。
     * 这里把"会话还在不在"单独记一笔：`false` = 这一条**大概率收不到**，
     * 于是它至少是**可见的**（audit + warn），而不是安静地消失。
     */
    const targetLive = probeTargetSession(ctx, target)
    if (targetLive === false) {
      warn(`[pipeline] 唤醒目标会话 ${target} 在当前进程里查不到（可能已被删除或尚未加载）—— 仍然投递，但这条很可能收不到。task=${taskId} kind=${String(s.kind ?? '')}`)
    }

    const actorRole = String(s.actorRole ?? 'unknown')
    const actorSeat = s.actorSeat === null || s.actorSeat === undefined ? null : String(s.actorSeat)
    const kind = String(s.kind ?? 'event')

    // ★ 取任务（渲染"当前状态 + 下一步合法事件"、并作为**台账身份**的来源）。
    //   取不到也照样唤醒 —— 状态那一行会如实说读不到。
    let task = s.task !== null && typeof s.task === 'object' ? s.task : null
    if (task === null && getTask !== null) {
      try {
        task = await getTask(taskId)
      } catch (err) {
        warn(`[pipeline] 唤醒时读任务失败（照常唤醒）：${String(err?.message ?? err)}`)
      }
    }

    /**
     * ★★ **A3 / A4 / A5：身份只从"这一次事件自己"来**（本轮重构的核心）。
     *
     * 改前这里是 `s.disc ?? ledgerIdentityOf(kind, task)` —— 后一半取的是
     * "该类别**最新那一条**"，于是：**拿错身份**（tester 的唤醒挂着 writer 的交接物）、
     * **复用旧身份**（反复用早已答复过的旧 `HR-…`）、**静默跳过**（身份还没产生就试，
     * 取不到就干脆不叫）。三条都在真单的审计里出现过。
     *
     * 现在：`eventIdentityFor` 按"① 工具返回值 → ② 同作者且**还没播过**的台账身份"
     * 解析，解析不出时**不许编造**，而是把两种情形**分开**：
     *   · **重放**（账本里已有这条键）⇒ 去重（A1 / A5），并留下 `wake:dedup` 痕迹；
     *   · **真没有身份** ⇒ **看得见的失败**（A8）：审计 + warn + 记进账本，
     *     由巡检再叫一次（R1：不许从此静默消失）。**绝不退成递增计数器**。
     *
     * ★ **消除 E1 那条竞态**：唤醒尝试可以早于身份落地（实测早 9 秒）。所以这里
     *   **该等就等** —— 最多三次、每次几十毫秒（只等一次读盘的时间，不做轮询、
     *   不起定时器），等到了就正常播；等不到才走上面那条"看得见的失败"。
     */
    /**
     * ★★ **T12（打回项 ①）：判别子先问"这一次调用自己的返回值"。**
     *
     * `tools/post-execute`（拦截缝）→ `wakeMain` → `wake()`，三者手上的 `result`
     * 是**逐字同一个对象**，所以在这里取与在拦截缝取结果一样：
     * `pipeline_handoff` 的成功返回值给 `handoff_id` ⇒ 判别子 `HO-XYZ`
     * —— 既有用例 `tests/wake-check.mjs` E3 断言的就是这个值（`m.calls[0].disc`）。
     *
     * 顺序：① 调用方显式给 → ② **这一次结果** → ③ 台账里同作者且还没播过的实体
     * → ④ 等一等 → ⑤ 看得见的失败。
     *
     * ★ 状态推进（`advancesState`）**不走 ②**：`pipeline_transition` 的结果只有 `from`/`to`
     * （不含 `at`），拿它当判别子会把"哪一次真实转换"弄丢；交给 `eventIdentityFor`
     * 去台账钉出 `<from>→<to>@<历史 at>`（A3/B5）。
     *
     * ★★ **绞不退回 `h<historyLen>` 递增计数器**（v1 去掉它的原因，不许改回去）：
     * 计数器保证"每次都不同" ⇒ 去重永不命中 ⇒ 同一条交付反复重放（实测 `h228 → h233 → h237`）。
     */
    const callerDisc = s.disc === null || s.disc === undefined ? '' : String(s.disc)
    const trigOf = WAKE_TRIGGER_TOOLS[String(s.toolName ?? '')]
    const resultDisc = callerDisc.length > 0 || trigOf === undefined || trigOf.advancesState === true
      ? null
      : discriminatorOf(s.result ?? null, trigOf.disc)
    const actor = actorKeyOf(actorRole, actorSeat)
    const identityOf = () => eventIdentityFor({
      kind,
      toolName: s.toolName ?? '',
      result: s.result ?? null,
      task,
      actor,
      ledger,
    })
    let identity = callerDisc.length > 0
      ? { disc: callerDisc, source: typeof s.identitySource === 'string' && s.identitySource.length > 0 ? s.identitySource : 'caller', key: null, replayKey: null }
      : resultDisc !== null
        ? { disc: resultDisc, source: 'result', key: null, replayKey: null }
        : identityOf()
    for (let attempt = 0; identity.disc === null && identity.replayKey === null && attempt < 3; attempt++) {
      await sleep(20 * (attempt + 1) * (attempt + 1))
      if (getTask !== null) {
        try {
          const fresh = await getTask(taskId)
          if (fresh !== null && typeof fresh === 'object') task = fresh
        } catch (err) {
          warn(`[pipeline] 等身份时重读任务失败（照旧继续，不影响判定）：${String(err?.message ?? err)}`)
        }
      }
      identity = identityOf()
    }
    if (identity.disc === null) {
      if (identity.replayKey !== null) {
        // ★ **重放**：账本里已经有这个键 ⇒ 同一条事件早已播过，不再播、也不当新事件（A1 / A5）。
        stats.deduped++
        await note(taskId, WAKE_AUDIT.dedup, {
          key: identity.replayKey,
          via: 'ledger-replay',
          kind,
          actor,
          note: '同一条事件早已播报过（已播报账本里有这个键）—— 不再播，也不当作新事件。',
        })
        return {
          ok: true,
          injected: false,
          reason: 'duplicate',
          targetSession: '',
          requestId: wakeRequestIdOf(identity.replayKey),
          key: identity.replayKey,
          via: null,
          sourcePreserved: false,
        }
      }
      /**
       * ★★ **真没有身份 ⇒ 看得见的失败**（A8 / A3 末句 / B19）。
       *
       * 纪律：① 审计留一行 `wake:skipped`（**保留既有 reason 口径**，`no-stable-identity`）；
       *      ② `warn` 出声（人看得见）；③ **记进已播报账本**的 unresolved 列表 ⇒
       *      巡检会把它当作"该叫没叫"再叫一次（R1 的相容形态）。
       *      —— 静默跳过被彻底取消：跳过也要有人知道。
       */
      const detail = {
        kind,
        toolName: s.toolName ?? null,
        actor,
        identity_source: identity.source,
        hint:
          '这一次既没在工具返回值里读到交付身份，台账里也没有**同作者且还没播过**的实体 —— ' +
          '**没有播报**（改前会退回"任务历史长度"这个递增计数器，那保证每次都不同 ⇒ 去重永不命中 ⇒ 同一条交付反复重放）。' +
          '★ 这条失败**是可见的**：审计 + 账本 unresolved 列表 + 巡检会再叫一次。',
      }
      try {
        ledger?.noteUnresolved?.({ task_id: taskId, kind, actor, reason: 'no-stable-identity', detail })
      } catch (err) {
        warn(`[pipeline] 记"没投出去"失败（不影响返回）：${String(err?.message ?? err)}`)
      }
      warn(
        `[pipeline] 唤醒没有稳定身份（任务 ${taskId}，类别 ${kind}，执行者 ${actor || '?'}）—— ` +
          '没有播报，但**不是静默**：已记进账本 unresolved，巡检会再叫一次。',
      )
      return skip('no-stable-identity', detail)
    }
    const disc = identity.disc
    const key = wakeKeyOf({ taskId, kind, actorRole, actorSeat, disc })
    const requestId = wakeRequestIdOf(key)
    /**
     * ★★ **旧口径（`角色#角色`）形态的那把键 —— 只读兼容，见 {@link legacyWakeKeyOf}。**
     * 改前 `actorKeyOf` 对"席位名 === 角色名"会拼出 `tester#tester`，那种键**已经写在**
     * 盘上的账本里（不迁移、不改写）；探测它才不会把历史账本当成"没播过"而重播。
     */
    const legacyKey = legacyWakeKeyOf({ taskId, kind, actorRole, actorSeat, disc })

    // 幂等**第一道**：同进程内同一个交付键已经处理过 ⇒ 直接返回上一次的结论。
    //
    // ★ **去重必须留痕**（A25 的必含形态：唤醒尝试无论成败都要有记录）。
    //   现场：一条「任务被冻结」的唤醒**从未送达**，审计里**什么都没有** ——
    //   既不是 delivered 也不是 skipped，它就是被这一支悄悄吃掉的（吞法 2）。
    const deduped = (prev, via) => ({
      ok: prev.ok !== false,
      injected: false,
      reason: 'duplicate',
      targetSession: prev.targetSession ?? '',
      requestId: prev.requestId ?? wakeRequestIdOf(key),
      key,
      via: prev.via ?? null,
      sourcePreserved: prev.sourcePreserved === true,
      duplicateVia: via,
    })
    if (delivered.has(key)) {
      stats.deduped++
      const prev = delivered.get(key)
      await note(taskId, WAKE_AUDIT.dedup, {
        key,
        via: 'memory',
        kind,
        actor,
        note: '同一条事件在**本进程内**已经播报过（内存已投递表命中）—— 不再注入；这一行就是"去重没有静默"的证据。',
      })
      return deduped(prev, 'memory')
    }
    /**
     * ★★ **幂等第一道半：盘上的账本**（A19 跨进程「恰一次」）。
     *
     * 为什么必须有它：内存表**进程重启就没了**，而同一条事件在重启后会被
     * 当成新事件**重放**一遍（实测：同一条人工介入请求被播报三遍）。
     * 账本落盘后，「播过了」这件事跨进程成立 ⇒ 重启后照旧不重放。
     *
     * ★ 命中哪一行由 `deliveredKeyFormIn` 说了算（**新旧两种键形态都认**）。
     */
    const ledgerHit = deliveredKeyFormIn(ledger, key, legacyKey)
    if (ledgerHit !== null) {
      stats.deduped++
      const prev = ledger.deliveredEntry?.(ledgerHit) ?? { ok: true, targetSession: '', requestId: wakeRequestIdOf(ledgerHit), via: null }
      await note(taskId, WAKE_AUDIT.dedup, {
        key,
        /**
         * ★ 命中的那一行键：与新形态不同 ⇒ 说明它是**改前口径**写下的历史行
         *   （`角色#角色`）。如实报出来，账本与本条留痕**配对可读**。
         */
        matched_key: ledgerHit,
        legacy_form: ledgerHit !== key,
        via: 'ledger',
        kind,
        actor,
        ledger_state: ledger.state ?? null,
        note: '同一条事件在**已播报账本**里已经有这个键（跨进程判据，新/旧两种键形态都认）—— 不再注入；重启也不会重放。',
      })
      return deduped(prev, 'ledger')
    }

    const message = wakeMessage({
      key,
      taskId,
      actorRole,
      actorSeat,
      kind,
      what: s.what ?? WAKE_TRIGGER_TOOLS[String(s.toolName ?? '')]?.what ?? '有一次事件',
      task,
      /** ★ B4：正文里写明这份快照的**取样时刻**（投递要排队，快照会过期）。 */
      snapshotAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      /**
       * ★★ 转换后的状态（工具**自己报的**）—— 正文里"任务当前状态 / 下一步 / 谁"
       *    一律以它为准，见 `stateOfTask`。没有它就只能拿 `task`（缓存/读盘时序）
       *    —— 那正是"正文报出转换前状态"的那条路。
       */
      stateAfter: typeof s.stateAfter === 'string' && s.stateAfter.length > 0 ? s.stateAfter : null,
      /** 转换前状态：正文里点明"刚从哪儿转过来"，免得读者以为它早就在这儿了。 */
      stateFrom: typeof s.stateFrom === 'string' && s.stateFrom.length > 0 ? s.stateFrom : null,
      note: s.note ?? '',
      via: s.via ?? 'post-execute',
    })

    // ★ 判据 ① 的**自检**：形状必须过本插件唯一的宿主消息判据（缺 source / kind 非法
    //   都在这里当场发现，而不是等到宿主 `prepareDirectMessages` 炸整个 turn）。
    const violations = assertHostMessage(message, { path: `wake(${kind}) 消息` })
    if (violations.length > 0) {
      stats.failed++
      await note(taskId, WAKE_AUDIT.failed, { reason: 'shape', violations: violations.slice(0, 3), key })
      warn(`[pipeline] 唤醒消息形状不合规，已放弃注入（不会交给宿主）：${violations[0]}`)
      return { ok: false, injected: false, reason: 'shape', targetSession: target, requestId, key, via: null, sourcePreserved: false }
    }

    let fallbackReason = ''
    let res
    try {
      res = await deliverWake(ctx, { sessionId: target, message, requestId, onFallback: (m) => { fallbackReason = m } })
    } catch (err) {
      res = { ok: false, via: null, sourcePreserved: false, duplicateAtHost: false, note: `投递异常：${String(err?.message ?? err)}` }
    }

    if (res.ok !== true) {
      stats.failed++
      // ★★ **失败绝不写进"已投递"表**（2026-10-11 修的静默吞）。
      //
      //   原来这里写的是 `delivered.set(key, { ok: false, … })`，而下面那道幂等门
      //   只看 `delivered.has(key)`（不看 `ok`）⇒ **一次投递失败会把那个交付键永久
      //   判死**：同一个转换 / 同一份交接物再来一次时直接返回 `duplicate`，
      //   **一次都不补发**，而 audit 里连"跳过"都不会留 —— 这正是用户说的
      //   "静默吞掉"。目标会话刚被重建 / 临时不可达时，代价尤其大：
      //   机制自认为已经处理过，人却什么也没收到。
      //
      //   改法：失败**不记账** ⇒ 下一次同类事件照投（补发）。代价是失败会重复留痕
      //   （`wake:failed` 每次都记）+ 每次重试都 `warn` 一次 —— 那是**故意的**：
      //   投不出去必须吵，不能安静。
      await note(taskId, WAKE_AUDIT.failed, { reason: 'deliver', note: res.note, key, target_session: target, target_live: targetLive })
      /**
       * ★ 投不出去**也要进账本的 unresolved 列表**（A8 / R1）：下一次巡检会把它
       *   当作"该叫没叫"再叫一次 —— 否则"投递失败"只留在一次工具调用的返回值里，
       *   事情过去之后就再没人知道了。
       */
      try {
        ledger?.noteUnresolved?.({ task_id: taskId, kind, actor, reason: 'deliver-failed', detail: { key, target_session: target, target_live: targetLive, note: res.note } })
      } catch (err) {
        warn(`[pipeline] 记"投递失败"到账本失败（不影响返回）：${String(err?.message ?? err)}`)
      }
      warn(`[pipeline] 唤醒投递失败（不影响触发它的那次调用；已留痕，下次同类事件会重投）：${res.note}`)
      return { ok: false, injected: false, reason: 'deliver', targetSession: target, requestId, key, via: res.via, sourcePreserved: false }
    }

    if (delivered.size >= DELIVERED_LIMIT) delivered.clear()
    delivered.set(key, { ok: true, targetSession: target, requestId, via: res.via })
    if (res.duplicateAtHost === true) {
      stats.deduped++
    } else {
      stats.injected++
      if (res.sourcePreserved !== true) stats.fallback++
    }

    await note(taskId, WAKE_AUDIT.delivered, {
      key,
      request_id: requestId,
      target_session: target,
      /** ★ 目标会话是**怎么找到**的：`registry`（内存，热）或 `persisted-contact`（落盘兜底）。 */
      target_via: targetVia,
      actor: `${actorRole}${actorSeat === null ? '' : `#${actorSeat}`}`,
      kind,
      via: res.via,
      /** ★ 三态：true=目标会话在本进程里；false=查不到（很可能收不到）；null=不可知。 */
      target_live: targetLive,
      source_kind: res.sourcePreserved === true ? WAKE_SOURCE_KIND : 'user(host-rewritten)',
      source_preserved: res.sourcePreserved === true,
      // ★ 三态：true = 宿主侧确实查到了同一条；false = 目标会话队列里没有；null = **不可知**
      //   （prompt() 退路：宿主不告诉调用方这次是"新入队"还是"requestId 命中"，见 deliverWake）。
      duplicate_at_host: res.duplicateAtHost === true ? true : res.duplicateAtHost === null ? null : false,
      ...(fallbackReason.length > 0 ? { fallback_reason: fallbackReason } : {}),
      note: res.note,
    })

    /**
     * ★★ **落进已播报账本**（A19 跨进程「恰一次」的另一半：播过了就记住）。
     *
     * 只记"投递**已经发生**"的那一次（`res.ok === true`）；失败不记 —— 失败要重投
     * （见上面那条：一次投递失败不许把交付键永久判死）。
     */
    if (ledger !== null && typeof ledger.record === 'function') {
      const rec = ledger.record({
        key,
        task_id: taskId,
        kind,
        actor,
        target,
        request_id: requestId,
        identity_source: identity.source,
        event_at: typeof s.eventAt === 'string' && s.eventAt.length > 0 ? s.eventAt : null,
      })
      if (rec.ok !== true) {
        warn(`[pipeline] 已播报账本写入失败（本次投递已经发生；去重退回既有两道判据）：${String(rec.note ?? '')}`)
      }
    }

    return {
      ok: true,
      injected: res.duplicateAtHost !== true,
      reason: res.duplicateAtHost === true ? 'duplicate-at-host' : 'delivered',
      targetSession: target,
      requestId,
      key,
      via: res.via,
      sourcePreserved: res.sourcePreserved === true,
      // ★ 三态透出去（见 audit 那一处）：true / false / **null=不可知**。
      duplicateAtHost: res.duplicateAtHost === true ? true : res.duplicateAtHost === null ? null : false,
      /** ★ 这一次的身份是**从哪儿来**的（result / ledger-scoped / caller / replay …）—— 事后可核。 */
      identitySource: identity.source,
    }
  }

  /**
   * ★ **工具交付触发点**：`tools/post-execute` 里看到表内的工具成功返回就调它。
   *
   * ⚠️ 说明（免得下一个人误会）：**活的那条判据在 `lib/intercept.js` 里**
   * （它直接调 `wakeMain` → `wake`）。这个函数是等价入口，两边**必须同步改** ——
   * 早先这里与 intercept 各写一份，而 intercept 那份漏了 `pipeline_transition`
   * 的真实字段，于是判别子全退到 `h<n>`（现场 h10 / h16）。
   *
   * 判别子分两类：
   *   · 状态推进（`advancesState`）：`from→to|h<historyLen>` —— 语义 + 逐次，
   *     见 `transitionDiscOf`；
   *   · 其余交付：从结果的 `disc` 字段取，取不到退到 `h<historyLen>`。
   *
   * @param {{toolName:string, result:object|null, actorRole:string, actorSeat?:string|null, taskId:string, historyLen?:number}} spec
   */
  async function wakeForTool(spec) {
    const s = spec ?? {}
    const trig = WAKE_TRIGGER_TOOLS[s.toolName]
    if (trig === undefined) return { ok: true, injected: false, reason: 'not-a-trigger', targetSession: '', requestId: '', key: '', via: null, sourcePreserved: false }
    /**
     * ★★ **B5：判别子只认"稳定交付身份"，不认递增计数器**。
     *
     * 改前：`disc = discriminatorOf(result, disc) ?? 'h' + historyLen`。
     * 而 `historyLen` 是**单调递增的**，于是同一个交付每次重放都拿到新键 ⇒
     * 去重永不命中（实测 `h228 → h233 → h237`，同一条人工介入请求被播报三遍，
     * 每条都携带**事件原始时刻**的状态快照 —— 这同时解释了 B4 的"过期"与 B14 的"空报"）。
     *
     * 现在：结果里读不到 ⇒ 去**台账**里取最新一条同类别记录的身份
     * （`stableDiscFor` / `ledgerIdentityOf`）；两处都取不到 ⇒ `disc = null`，
     * 由调用方**放弃播报并留痕**（宁可不报，不许把它变成一个计数器）。
     */
    const to = trig.advancesState === true && typeof s.result?.to === 'string' && s.result.to.length > 0 ? s.result.to : null
    const from = typeof s.result?.from === 'string' && s.result.from.length > 0 ? s.result.from : null
    return wake({
      taskId: s.taskId,
      actorRole: s.actorRole,
      actorSeat: s.actorSeat ?? null,
      kind: trig.kind,
      what: trig.what,
      /**
       * ★★ 身份**交给 `wake()` 自己解析**（`eventIdentityFor`：工具返回值 →
       * 同作者且还没播过的台账身份 → 等一等 → 看得见的失败）。
       *
       * 这里**不再**预先算一份判别子：改前 `stableDiscFor` 与 `intercept.js` 各算一份，
       * 两份口径必然漂移（实测 `intercept` 那份漏了 `from`/`to` 的真实字段，
       * 于是判别子全退成 `h<n>` 递增计数器）。**一份判据只能有一个出处。**
       */
      result: s.result ?? null,
      toolName: s.toolName,
      // ★ 正文一律取**转换之后**的状态（用户原话：「不要各算一遍」）。
      stateAfter: to,
      stateFrom: from,
      task: s.task ?? null,
      via: 'post-execute',
    })
  }

  return {
    wake,
    wakeForTool,
    registry,
    stats,
    delivered,
    /** ★ 已播报账本（A19/A20）—— 给巡检、工具层、审核取证读的**同一份**。 */
    ledger,

    /**
     * ★★ **A28：把"接管"记下来**（与投递**同一个键**配对可读）。
     *
     * 现场（E14/E18）：一条要素俱全的 delivered 之后 **18 小时零动作**，
     * 而同一条通道在另一类事件上 **23 秒**就产生了动作 —— 两次投递在台账上的
     * 形态字段**完全相同**，差别只在"接管侧有没有痕迹"。
     * 所以判据不能只看投递侧，得有这一半：**目标随后确实带着这条投递动了**。
     *
     * @param {string} taskId
     * @param {{by?:string, action?:string, limit?:number, keys?:string[]}} [spec]
     */
    markConsumed(taskId, spec = {}) {
      if (ledger === null || typeof ledger.markConsumed !== 'function') return { ok: false, marked: 0, note: '没有账本（自测替身）—— 不记接管留痕。' }
      const keys = Array.isArray(spec.keys) ? spec.keys.filter((k) => typeof k === 'string' && k.length > 0) : null
      const list = keys !== null
        ? keys.map((k) => ({ key: k }))
        : typeof ledger.pendingUnconsumed === 'function'
          ? ledger.pendingUnconsumed({ now: Date.now(), olderThanMs: 0, limit: Number.isInteger(spec.limit) ? spec.limit : 5 }).filter((e) => taskId === undefined || taskId === null || taskId === '' || String(e.task_id ?? '') === String(taskId))
          : []
      let marked = 0
      for (const e of list) {
        const r = ledger.markConsumed({ key: e.key, by: String(spec.by ?? 'main'), action: String(spec.action ?? '') })
        if (r.ok === true) marked += 1
      }
      return { ok: true, marked, note: marked === 0 ? '没有"已投递未接管"的条目（无需记）。' : `记下 ${marked} 条接管留痕。` }
    },

    /** 「已投递但没人接管」的清单（A28 / T30 的数据面）。 */
    pendingDeliveries(taskId, spec = {}) {
      if (ledger === null || typeof ledger.pendingUnconsumed !== 'function') return []
      const list = ledger.pendingUnconsumed({ now: Date.now(), olderThanMs: Number.isFinite(spec.olderThanMs) ? spec.olderThanMs : 0, limit: Number.isInteger(spec.limit) ? spec.limit : 20 })
      return taskId === undefined || taskId === null || taskId === '' ? list : list.filter((e) => String(e.task_id ?? '') === String(taskId))
    },

    /**
     * ★★ **R1：未被消费的投递不得从此静默消失** —— 再叫一次，但**必须**是
     * 「可与原事件**配对读出**的升级事件」：不冒充新事件（类别是 `escalation`）、
     * 不复用旧身份（键是 `<原键>#escalated`，读得出它升的是哪一条）、
     * 不把原事件原地重放（原键一个字没动）；**同一条只升一次**（`markEscalated` 记账），
     * 一旦被消费就再也不会进这个清单（`pendingUnconsumed` 只看没消费的）。
     *
     * ★ 它**不是**刷屏源：升级是"一次性事件"（升级过就不再重复），
     *   而且受巡检自己的防刷屏约束（A23 / B27）。
     */
    async escalateUnconsumed(taskId, spec = {}) {
      if (ledger === null) return { ok: false, escalated: 0, note: '没有账本 —— 不升级。' }
      const pending = this.pendingDeliveries(taskId, { olderThanMs: Number.isFinite(spec.olderThanMs) ? spec.olderThanMs : 0, limit: Number.isInteger(spec.limit) ? spec.limit : 3 })
      let escalated = 0
      const lines = []
      for (const p of pending) {
        const escKey = `${p.key}#escalated`
        const res = await wake({
          taskId: String(p.task_id ?? taskId ?? ''),
          actorRole: WAKE_ACTOR_MECHANISM,
          actorSeat: null,
          kind: 'escalation',
          what: `**一条投递已送达但没人接管**（原始事件：\`${p.key}\`，投递于 ${String(p.at ?? '?')}，目标会话 ${String(p.target ?? '(未知)')}）`,
          disc: escKey,
          identitySource: 'escalation',
          note:
            `★ 这是一条**升级叫醒**，不是新事件（R1：未被消费的投递不得永久静默）。\n` +
            `★ 与原事件的配对方式：原键 = \`${p.key}\`；本条 = 原键 + \`#escalated\`。\n` +
            `★ 一旦那条投递被消费（目标据此动了），就不会再有下一条升级。\n` +
            `★ 已投递未接管的时长：${p.age_ms === null || p.age_ms === undefined ? '(未知)' : `${Math.round(p.age_ms / 1000)} 秒`}。`,
          via: 'escalation',
        })
        if (res !== null && (res.injected === true || res.reason === 'duplicate' || res.reason === 'duplicate-at-host')) {
          ledger.markEscalated({ key: p.key, escalationKey: escKey, reason: String(spec.reason ?? 'unconsumed') })
          escalated += 1
          lines.push(`  · 已升级：${p.key} ⇒ ${escKey}`)
        } else {
          lines.push(`  · 升级失败（下轮再试）：${p.key} —— ${String(res?.reason ?? '未知')}`)
        }
      }
      return { ok: true, escalated, note: lines.length === 0 ? '没有"已投递未接管"的条目。' : lines.join('\n') }
    },

    /** 席位侧投递的键（同一个 (任务, 类别, 席位, 请求) 只投一次）。 */
    seatDeliveryKey(spec = {}) {
      const taskId = String(spec.taskId ?? '')
      const kind = String(spec.kind ?? 'seat')
      const seat = actorKeyOf(spec.role, spec.seat)
      const rid = String(spec.requestId ?? '')
      return `${taskId}|${kind}|seat:${seat}|${rid}`
    },

    /** ★ A6/A7：席位侧反向投递的**成败留痕**（盘上，主对话可查）。 */
    noteSeatDelivery(spec = {}) {
      if (ledger === null || typeof ledger.recordSeatDelivery !== 'function') return { ok: false, note: '没有账本。' }
      return ledger.recordSeatDelivery(spec)
    },

    /** ★ A28(b)：席位**接管**留痕（该席位下一轮确实带着这条投递继续工作）。 */
    markSeatConsumed(taskId, spec = {}) {
      if (ledger === null || typeof ledger.markSeatConsumed !== 'function') return { ok: false, marked: 0, note: '没有账本。' }
      const list = typeof ledger.pendingSeatDeliveries === 'function'
        ? ledger.pendingSeatDeliveries({ seat: spec.seat, taskId: String(taskId ?? ''), limit: Number.isInteger(spec.limit) ? spec.limit : 5 })
        : []
      let marked = 0
      for (const e of list) {
        const r = ledger.markSeatConsumed({ key: e.key, by: String(spec.by ?? ''), action: String(spec.action ?? '') })
        if (r.ok === true) marked += 1
      }
      return { ok: true, marked, note: marked === 0 ? '没有"已投递未接管"的席位投递。' : `记下 ${marked} 条席位接管留痕。` }
    },

    /** 某个席位「已投递但还没接管」的那些（A28(b) / T28 的数据面）。 */
    pendingSeatDeliveries(spec = {}) {
      if (ledger === null || typeof ledger.pendingSeatDeliveries !== 'function') return []
      return ledger.pendingSeatDeliveries({ seat: spec.seat, taskId: String(spec.taskId ?? ''), limit: Number.isInteger(spec.limit) ? spec.limit : 20 })
    },
    /**
     * ★ **记下主对话在哪个会话**（`lib/tools.js` 的 `rememberMainCaller` 调它）。
     *
     * 两层登记：
     *   · 内存（`registry`）—— 即查即用，唤醒路径只看它；
     *   · 落盘（`deps.rememberContact` → `store.rememberMainContact` → `task.contacts.main`）
     *     —— 进程重启后 `pipeline_contacts` 还能回答"主对话是谁"。
     * 只在**变了**的时候落盘：别让每次工具调用都写一次任务文件。
     *
     * @returns {boolean} 是否记下了
     */
    rememberMain(taskId, sessionId, via = 'tool-call') {
      const changed = registry.remember(taskId, sessionId, via)
      if (changed && typeof deps.rememberContact === 'function') {
        // 落盘失败不影响内存登记（唤醒照旧能投）；但要留痕，别静默。
        Promise.resolve()
          .then(() => deps.rememberContact(taskId, sessionId))
          .catch((err) => warn(`[pipeline] 主对话会话落盘失败（内存登记仍在）：${String(err?.message ?? err)}`))
      }
      return changed || registry.sessionOf(taskId) === sessionId
    },
    /** 测试用：清空"已投递"表（registry 不动）。 */
    reset() {
      delivered.clear()
      stats.attempts = 0
      stats.injected = 0
      stats.deduped = 0
      stats.skipped = 0
      stats.failed = 0
      stats.fallback = 0
    },
  }
}

/**
 * ★ 从 `exec` 里抠出"谁在调"（角色 / 席位 / 会话 id），供触发点用。
 *
 * 刻意**只做形状解析**，不做授权判断 —— 判据不在这里，别在这里发明第二份。
 *
 * @param {object} exec
 * @param {(agentId:string)=>object|null} seatOf - 拦截缝的席位解析器
 * @returns {{agentId:string|null, role:string, seat:string|null, taskId:string}|null}
 */
export function actorOf(exec, seatOf) {
  const agentId = agentIdOf(exec)
  if (agentId === null) return null
  let seat = null
  try {
    seat = typeof seatOf === 'function' ? seatOf(agentId) : null
  } catch {
    seat = null
  }
  if (seat === null || seat === undefined) return null
  return { agentId, role: String(seat.role ?? 'unknown'), seat: seat.seat ?? null, taskId: String(seat.taskId ?? '') }
}
