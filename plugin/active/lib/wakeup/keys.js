/**
 * dsh-pipeline · 唤醒 · 常量与唤醒键
 * ============================================================================
 * 从 `lib/wakeup.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/wakeup.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/wakeup/keys
 */

import { createHash } from 'node:crypto'
import { RUNTIME_CONTEXT_KIND } from '../hostmsg.js'
import { roleLabel } from '../roles.js'

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
export function actorLabel(role) {
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
export function deliveredKeyFormIn(ledger, key, legacyKey) {
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
