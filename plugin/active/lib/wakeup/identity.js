/**
 * dsh-pipeline · 唤醒 · 账本身份
 * ============================================================================
 * 从 `lib/wakeup.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/wakeup.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/wakeup/identity
 */

import {
  WAKE_ACTOR_MECHANISM,
  actorKeyOf,
  wakeKeyOf,
  legacyWakeKeyOf,
  deliveredKeyFormIn,
  WAKE_TRIGGER_TOOLS,
  discriminatorOf,
} from './keys.js'

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
