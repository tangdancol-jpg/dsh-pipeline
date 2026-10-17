/**
 * dsh-pipeline · 唤醒 · 唤醒器
 * ============================================================================
 * 从 `lib/wakeup.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/wakeup.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/wakeup/waker
 */

import { agentIdOf } from '../guard.js'
import { assertHostMessage } from '../hostmsg.js'
import { isMechanismNotice } from '../wakeledger.js'
import {
  WAKE_SOURCE_KIND,
  WAKE_AUDIT,
  WAKE_TRIGGER_TOOLS,
  WAKE_ACTOR_MECHANISM,
  createMainSessionRegistry,
  wakeKeyOf,
  legacyWakeKeyOf,
  deliveredKeyFormIn,
  wakeRequestIdOf,
  discriminatorOf,
  actorKeyOf,
} from './keys.js'
import { eventIdentityFor } from './identity.js'
import { LAST_RESORT_VIA } from './last-resort.js'
import { progressAfter } from './progress.js'
import { relayBlockedHint, relayBlockedRole } from './relay-hint.js'
import { sleep, wakeMessage, probeTargetSession, deliverWake } from './deliver.js'

/**
 * ★ 「待领」去重时一次扫多少条账本 unresolved。
 * 2000 是账本自己的上限（`wakeledger.js` 的 `unresolved.length > 2000` 就裁到 500）
 * —— 取同一个数量级，保证"扫得到"与"账本留得住"是同一段历史。
 */
const UNCLAIMED_SCAN_LIMIT = 2000

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
   * ★★ **兜底解析主对话会话**（第三道来源，2026-10-16 补）。
   *
   * 前两道（内存登记表 / `task.contacts.main`）**同时空**时才会被调用 ——
   * 判据在 `wakeup/last-resort.js`（纯函数），这里只接线。
   * 没给（自测替身 / 装配不全）⇒ 退回改前的行为：仍然跳过，但**不静默**（见下面那条）。
   *
   * @type {((taskId:string)=>Promise<{agentId:string, at:string, action:string}|null>)|null}
   */
  const lastResortMainOf = typeof deps?.lastResortMainOf === 'function' ? deps.lastResortMainOf : null

  /**
   * ★ 已投递表：交付键 ⇒ 投递结果。
   * 这是幂等的**第一道**（同进程内重放同一个交付键 ⇒ 直接返回上一次的结论）。
   * 第二道是 {@@link alreadyDelivered}（查目标会话自己的队列）。
   */
  const delivered = new Map()
  /** 上限兜底：只增不减会泄漏。丢一条唤醒无所谓，内存泄漏不会自己好。 */
  const DELIVERED_LIMIT = 2048

  /**
   * ★★ **本进程内已经落盘过 `contacts.main` 的任务**（2026-10-16 补登记用）。
   *
   * 它挡的是"每次工具调用都写一次任务文件"，同时**不许**把"这一张单还没写过"
   * 也一起挡掉 —— 见下面 `rememberMain` 那一段（`changed` 只真一次，靠它不够）。
   * ★ 只在**写成功之后**才加进来：失败要下次再试。
   */
  const persistedOk = new Set()

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
   * ★★ **"这一条事件没人领"记进账本** —— 幂等（同一个键只记一次）。
   *
   * 为什么幂等要自己判：`ledger.noteUnresolved` 是**只追加**的（`wakeledger.js`），
   * 它不认重。而"找不到主对话会话"这件事会**每一次交付都发生一次**（现场 22 次），
   * 直接记就是 22 条一模一样的待领记录 ⇒ 主对话捞的时候淹没在重复里。
   * 所以这里先读账本里已有的 unresolved，认键；认到了就一个字节都不写。
   *
   * ★ 判据只有一条：`detail.key`（= `pendingKey`，与 `wakeKeyOf` 同源）。
   * ★ 绝不影响那次调用：账本坏了 / 没给账本 ⇒ 只是没有第二条落点，
   *   audit 行里的待领标记（`pending/unclaimed`）照旧在。
   */
  async function noteUnclaimed(taskId, spec) {
    const key = String(spec?.key ?? '')
    if (ledger === null || typeof ledger?.noteUnresolved !== 'function' || key.length === 0) return false
    try {
      const already = typeof ledger.unresolvedEntries === 'function'
        ? ledger.unresolvedEntries({ taskId, limit: UNCLAIMED_SCAN_LIMIT }).some((e) => String(e?.detail?.key ?? '') === key)
        : false
      if (already) return false
      ledger.noteUnresolved({
        task_id: taskId,
        kind: String(spec?.kind ?? ''),
        actor: String(spec?.actor ?? ''),
        reason: 'no-main-session',
        /**
         * ★ 账本那份 `detail` **必须带 `key`** —— 它是这条待领记录的**唯一身份**：
         *   上面的去重按它认，`lib/wakeup/pending.js` 的 `pendingWakesOf` 也按它
         *   取值与去重。audit 行里那个字段叫 `unclaimed`（给人读的名字），
         *   这里统一落成 `key`（机器读的那个）—— 两个名字指同一把键。
         */
        detail: { ...(spec?.detail ?? {}), key },
      })
      return true
    } catch (err) {
      warn(`[pipeline] 记"待领事件"到账本失败（不影响本次调用）：${String(err?.message ?? err)}`)
      return false
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

    /**
     * ★★ **身份输入提到"找目标"之前**（2026-10-16 · 唤醒投递失败修复）。
     *
     * 为什么必须提前：**找不到主对话会话时也要能给这条事件一个稳定的名字** ——
     * 否则"待领"落点只能按"第几次尝试"命名，同一件事每试一次就多落一份
     * （现场 `T-20261016-ff9ba7` 的 22 行 `wake:skipped` 就是这么堆起来的）。
     * 这四个值**只读 `s`**，提上来一个字节的语义都没改（下面原来那几行已删除）。
     */
    const actorRole = String(s.actorRole ?? 'unknown')
    const actorSeat = s.actorSeat === null || s.actorSeat === undefined ? null : String(s.actorSeat)
    const kind = String(s.kind ?? 'event')
    const callerDisc = s.disc === null || s.disc === undefined ? '' : String(s.disc)
    const trigOf = WAKE_TRIGGER_TOOLS[String(s.toolName ?? '')]
    const resultDisc = callerDisc.length > 0 || trigOf === undefined || trigOf.advancesState === true
      ? null
      : discriminatorOf(s.result ?? null, trigOf.disc)
    const actor = actorKeyOf(actorRole, actorSeat)

    /**
     * ★★ **"这一件事"的稳定名字**（不管这一次投不投得出去）。
     *
     * 三个来源，与下面 `identityOf()` 的**前两级逐字同源**（工具返回值 → 调用方显式给），
     * 只是**不做**第三级"去台账里等一等"（那要读盘、要 sleep，不该在"没有地址"这条
     * 早退路径上付）。三级都取不到时退成 `no-identity` —— 粒度**故意粗**：
     * 同一张单上同类同作者的、连身份都读不出来的事件会被并成一条待领记录。
     * 宁可合并，也不许"每试一次多一条"（那正是现场 22 条的成因）。
     */
    const pendingDisc = callerDisc.length > 0 ? callerDisc : resultDisc !== null ? resultDisc : 'no-identity'
    const pendingKey = wakeKeyOf({ taskId, kind, actorRole, actorSeat, disc: pendingDisc })

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
      /**
       * ★★ **第三道来源：从这张单自己的台账里翻**（2026-10-16 补；判据在
       * `wakeup/last-resort.js`，**纯函数、只读、不冒名**）。
       *
       * 前两道（内存登记表 / `task.contacts.main`）**同时空**不是"主对话还没来过"，
       * 而是**一条死锁**：`rememberMainCaller` 只认内存里的 `main` 令牌，而重启后
       * 自动认回身份的那条路要求 `contacts.main` 已经存在 —— 缺记录就永远写不了记录。
       * 真单 `T-20261016-ff9ba7` 因此**整张单 22 次唤醒全部静默跳过**（跨两天）。
       *
       * ★ 它**只在前两道都空时**才跑（正常路径一次都不会读盘）。
       * ★ 它**不写** `contacts.main` —— 兜底是提示，不是权威登记。
       * ★ 它**必须出声**：来源如实标成 `last-known-agent` 并 `warn` 一次，
       *   免得"台账里翻出来的旧会话"被当成登记表给的地址。
       */
      if (typeof lastResortMainOf === 'function') {
        try {
          const found = await lastResortMainOf(taskId)
          const agentId = typeof found?.agentId === 'string' ? found.agentId : ''
          if (agentId.length > 0) {
            target = agentId
            targetVia = LAST_RESORT_VIA
            warn(
              `[pipeline] 唤醒的地址**两条正路都空**（内存登记表 + task.contacts.main），` +
                `改从这张单自己的台账兜底解析到会话 ${agentId}（依据：${String(found.action ?? '?')} @ ${String(found.at ?? '?')}）。` +
                `task=${taskId} kind=${kind} —— 兜底路径命中，说明登记缺失，请留意。`,
            )
          }
        } catch (err) {
          warn(`[pipeline] 兜底解析主对话会话失败（按未登记处理）：${String(err?.message ?? err)}`)
        }
      }
    }
    if (target === null || target.length === 0) {
      /**
       * ★★ **不许静默跳过**（2026-10-16 修复的核心）。
       *
       * 改前这里只有 `audit 一行 wake:skipped` —— 于是"人工请求投不出去"这件事
       * **只存在于一个 append-only 的日志文件里**，主对话没有任何确定的路子去捞它
       * （现场：请求静默积压，全靠人自己发现）。现在补齐两条可见落点：
       *
       *   a. **待领标记**：`skip()` 会把 `detail` 整份写进 audit 行 ⇒ 那一行从此带
       *      `pending: true` / `unclaimed: <稳定键>` / `claim_via: 'pipeline_status'`，
       *      是**明确的待领标记**，不再是"一次普通的跳过"；
       *   b. **进已播报账本的 unresolved 列表** ⇒ `pipeline_status` 的 `pending_wakes`
       *      会把它带回给主对话（下一次**任何**流水线工具调用都能看到）。
       *
       * ★ 幂等：同一个 `pendingKey` 只进账本一次（下面先查后写）。
       *   改前那种"每试一次多一条"的堆法会让待领清单淹没在重复里。
       */
      const detail = {
        hint: '主对话还没调用过任何 pipeline 工具，且 task.contacts.main 里也没有登记，台账里也翻不到 ⇒ 不知道唤醒该投到哪。',
        kind,
        actor,
        // ---- 可见的待领标记（a）----
        pending: true,
        unclaimed: pendingKey,
        claim_via: 'pipeline_status',
        note:
          '★ 这条事件**没有被投出去**，但它**不是静默消失**：本行的 `pending/unclaimed` 是待领标记，' +
          '并且主对话下一次调用 `pipeline_status` 时它会在 `pending_wakes` 里被带回。',
      }
      await noteUnclaimed(taskId, { kind, actor, key: pendingKey, detail })
      warn(
        `[pipeline] 唤醒投不出去：主对话会话未知（任务 ${taskId}，类别 ${kind}）—— ` +
          `待领键 ${pendingKey}，已记进账本，\`pipeline_status\` 会带回。`,
      )
      return skip('no-main-session', detail)
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

    // ★ 取任务（渲染"当前状态 + 下一步合法事件"、并作为**台账身份**的来源）。
    //   取不到也照样唤醒 —— 状态那一行会如实说读不到。
    //   ★ 上面那三个（`actorRole` / `actorSeat` / `kind`）**已经提到"找目标"之前**：
    //     "找不到主对话会话"那条早退路径也要给事件一个稳定的名字（待领键），
    //     见本函数开头那一段。
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
     *
     * ★ 本段原来的四行（`callerDisc` / `trigOf` / `resultDisc` / `actor`）**已提到
     *   "找目标"之前** —— 找不到主对话会话那条早退路径要用同一个判别子生成待领键。
     *   口径**一个字没改**，只是算得早了一点。
     */
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

    /**
     * ★ §9 噪声 ①（2026-10-17）：**按任务进展结算接管** —— 投递之后状态真前进过、或出现了新交接物
     *   ⇒ 记一笔接管（`by: 'mechanism'`，`action` 写明是哪一步进展；判据见 `progress.js`）。
     *   记在账本上，巡检播报与升级链共用的取数口就都不再拿到它。巡检每轮取清单之前调一次。
     *
     * @param {string} taskId
     * @param {object|null} task - 当前任务（只读）
     */
    settleByProgress(taskId, task) {
      if (ledger === null || typeof ledger.markConsumed !== 'function') return { ok: false, marked: 0, note: '没有账本 —— 不结算。' }
      const list = this.pendingDeliveries(taskId, { limit: 50 })
      let marked = 0
      const lines = []
      for (const e of list) {
        const p = progressAfter(task, e.at)
        if (p === null) continue
        const r = ledger.markConsumed({ key: e.key, by: WAKE_ACTOR_MECHANISM, action: `progressed:${p.action}@${p.at}` })
        if (r.ok === true) {
          marked += 1
          lines.push(`  · ${e.key} ⇐ ${p.action} @ ${p.at}`)
        }
      }
      return { ok: true, marked, note: marked === 0 ? '没有可按进展结算的投递。' : `按任务进展记下 ${marked} 条接管：\n${lines.join('\n')}` }
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
      // ★ §9 噪声 ③（2026-10-17）：与巡检播报路**同一个判据**显式再挡一道机制通知 ——
      //   取数口 pendingUnconsumed 默认已滤，这里不依赖它的默认参数（两路判据同源，不靠巧合对称）。
      const pending = this.pendingDeliveries(taskId, { olderThanMs: Number.isFinite(spec.olderThanMs) ? spec.olderThanMs : 0, limit: Number.isInteger(spec.limit) ? spec.limit : 3 })
        .filter((p) => !isMechanismNotice(p))
      // ★ §9 噪声 ④：投递方按继任策略不可换班 ⇒ 不升级（升给主对话也消费不掉），结论里写明下一步。
      let task = spec.task !== undefined ? spec.task : null
      if (spec.task === undefined && getTask !== null) {
        try {
          task = await getTask(taskId)
        } catch {
          task = null // 取不到任务 ⇒ 不做这一判（照旧升级，宁可多报）
        }
      }
      let escalated = 0
      const lines = []
      for (const p of pending) {
        const relayBlocked = relayBlockedRole(task, p)
        if (relayBlocked !== null) {
          lines.push(`  · 不升级：${p.key}\n${relayBlockedHint(relayBlocked)}`)
          continue
        }
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
      /**
       * ★★ **补登记：本进程内对同一张单至少要真的写一次盘**（2026-10-16 补）。
       *
       * 改前这里写的是 `if (changed && …)` —— 于是落盘**只在"内存值发生变化"的
       * 那一次**发生。这一条纪律的代价是**不可逆**的：
       *   · `registry.remember` 之后**永远返回 false**（值没变）；
       *   · 所以那唯一一次异步落盘要么成功，要么**这张单的 `contacts.main`
       *     这辈子都不会再被写第二次**（除非进程重启 + 内存表被清）。
       *
       * 而它偏偏是**异步、fire-and-forget** 的（下一行的 `Promise.resolve().then`），
       * 又与工具链上的 `persist(task)` 抢同一份文件（读-改-写）—— 丢一次就永久缺。
       * 真单 `T-20261016-ff9ba7` 就是这么来的：`task.json` 顶层**连 `contacts` 键
       * 都没有**（`generation` 在 3.6 MB 里一次都没出现过），而唤醒的跨重启兜底
       * 恰好只认那一份 ⇒ **整张单 22 次唤醒全部 `no-main-session`**（跨两天）。
       * 更狠的是它**自愈不了**：重启后主对话身份的唯一自动恢复路径
       * （`mainReattachEnabled` → `judgeMainClaim`）要求 `contacts.main` 已经存在。
       *
       * 修法：`persistedOk` —— **本进程内每张单补一次**。落盘**成功之后**才记账，
       * 失败就下次工具调用再试（失败不静默：下面 `.catch` 照旧 `warn`）。
       * 代价：主对话重启后**第一次**调工具会多一次读-改-写（"值没变"时
       * `store.rememberMainContact` 自己会短路，见 `lib/store.js` 那一句）。
       * 而它买回来的正是"重启后自动恢复"这件事 —— 这一半原来只写在注释里。
       */
      const needPersist = changed || !persistedOk.has(taskId)
      if (needPersist && typeof deps.rememberContact === 'function') {
        // 落盘失败不影响内存登记（唤醒照旧能投）；但要留痕，别静默。
        Promise.resolve()
          .then(() => deps.rememberContact(taskId, sessionId))
          .then(() => {
            persistedOk.add(taskId)
          })
          .catch((err) => warn(`[pipeline] 主对话会话落盘失败（内存登记仍在，下次工具调用会再试）：${String(err?.message ?? err)}`))
      }
      return changed || registry.sessionOf(taskId) === sessionId
    },
    /** 测试用：清空"已投递"表（registry 不动）。 */
    reset() {
      delivered.clear()
      persistedOk.clear()
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
