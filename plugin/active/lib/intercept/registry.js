// 拦截缝的**挂载编排**：按总开关真挂真摘，并把四条缝装配成中间件。
/**
 * dsh-pipeline · 拦截缝 · 挂载编排
 * ============================================================================
 * 用户原话：「我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写」。
 * 所以它挂在**本插件**里，不是另起一套 Skill + 钩子。
 *
 * ---------------------------------------------------------------------------
 * ★★ 缺陷「开关只关一半」的修法就在这里：**关掉时这四条缝一条都不挂**
 * ---------------------------------------------------------------------------
 * 改前 `ctx.on(...)` 是**无条件**执行的，"关"只关掉了缝里调用的**守门**；
 * 而缝自己那些跟守门无关的动作（主对话认领 / 席位接管留痕 / 失联检测 /
 * 提示词硬拦 / 上下文注入 / **结果替换**）全都照跑 —— 用户看到的就是
 * "开关说不再拦，下一次调用的结果照样被换掉"。
 *
 * 现在两层：
 *   ① **挂载侧**（本文件）：`shouldFire()` 为假 ⇒ 那条缝**摘掉**（订阅开关，翻转即时跟随）
 *      ⇒ "off 时挂着的缝 = 0"，可程序化断言（`lib/switch/audit.js` 记数）；
 *   ② **调用侧**（每条缝的第一句）：仍然问一次闸门 —— 挂载是**采样**，
 *      闸门是**逐次**的，不能有一次调用落在两次采样之间。
 *
 * ★ 为什么本次**可以**真摘（而 `lib/switch/state.js` 文件头说工具/守卫不能摘）：
 *   工具与守卫的顺序对用户可见（守卫链"取第一个非 undefined"，顺序变了拒绝文案就变）；
 *   而 `ctx.on` 缝的顺序对用户不可见，摘掉就是"不存在"。
 *
 * ★ 挂载顺序有硬要求：③ 唤醒必须排在 ④ 结果网**之前**（见 `lib/guard/hook-wake.js`
 *   文件头）。所以本文件只在**整组**变化时重挂，且永远按 {@link HOOKS} 的顺序挂。
 *
 * @module dsh-pipeline/lib/intercept/registry
 */

import { createHookAudit, createSeamGate } from '../switch/audit.js'
import { shouldFire } from '../switch/gate.js'
import { createSeatResolver } from './seat.js'
import { createPreExecuteHook } from '../guard/hook-pre.js'
import { createPromptHook } from '../guard/hook-prompt.js'
import { createWakeHook } from '../guard/hook-wake.js'
import { createResultNetHook } from '../guard/hook-post.js'
import { WAKE_ACTOR_MECHANISM } from '../wakeup.js'

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

/** 四条缝的**登记表**（顺序 = 挂载顺序；id 与 `lib/switch/gate.js` 的清单逐一对应）。 */
const HOOKS = [
  { id: 'seam-pre-execute', event: 'tools/pre-execute', make: createPreExecuteHook },
  { id: 'seam-pre-step', event: 'agent/pre-step', make: createPromptHook },
  { id: 'seam-post-execute-wake', event: 'tools/post-execute', make: createWakeHook },
  { id: 'seam-post-execute-result-net', event: 'tools/post-execute', make: createResultNetHook },
]

/**
 * 把拦截缝挂到宿主上（**按总开关决定挂几条**）。
 *
 * @param {object} ctx - Cordis ctx（需要 `.on` 与 `.logger`）
 * @param {object} deps
 * @param {(exec:object)=>string|undefined} deps.guard - **同一份**判据（`lib/guard-factory.js`）
 * @param {{isOn?:()=>boolean, subscribe?:Function}} [deps.sw] - ★★ 总开关
 * @param {(m:string)=>void} [deps.warn]
 * @param {(taskId:string)=>object|null} [deps.getTask]
 * @param {(sessionId:string)=>Promise<object>} [deps.mainReattach] - 主对话侧重启自动认领
 * @param {(spec:object)=>Promise<object>} [deps.wakeMain] - 唤醒投递（唯一入口）
 * @param {object} [deps.waker] - 唤醒器本体（席位接管留痕用）
 * @param {(taskId:string)=>Promise<object>} [deps.checkLiveness] - 失联检测
 * @param {number} [deps.seatSilenceMs]
 * @param {object} [deps.audit] - 观测台账（不给则自造一个）
 * @returns {{seams:string[], hookIds:string[], mounted:()=>string[], audit:object, seenSeats:Set<string>, staleNoticed:Set<string>, runLivenessCheck:Function, dispose:()=>void}}
 */
export function registerInterception(ctx, deps) {
  const seatOf = createSeatResolver(deps)
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const audit = deps.audit ?? createHookAudit({ warn })
  const injected = new Set()
  /** 当前真的挂着的缝：hookId → disposer。 */
  const mounted = new Map()

  // --- 失联提示的去重键（`<taskId>|<失联席位集合>`）与每任务节流表 -------------
  const staleNoticed = new Set()
  const noteStaleKey = (key) => {
    if (staleNoticed.size > 256) staleNoticed.clear()
    staleNoticed.add(key)
  }
  const livenessCheckedAt = new Map()

  /** ★ 唤醒的统一入口（本文件所有触发点都走它；绝不抛）。 */
  const wakeMain = async (spec) => {
    if (typeof deps.wakeMain !== 'function') return null
    try {
      return await deps.wakeMain(spec)
    } catch (err) {
      warn(`[pipeline] 唤醒主对话失败（不影响触发它的那次调用）：${String(err?.message ?? err)}`)
      return null
    }
  }

  /**
   * ★ 失联检测的**执法点**：任意角色的下一次工具调用 / 下一次开步。
   *
   * 纪律（三条都很重要）：
   *   ① **绝不抛出** —— 它在工具调用的关键路径上，检查失败不许影响调用；
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
        // ★★ **交付即唤醒 · 触发点⑦（席位失联 / 机制自动阻塞）**：这一类**不走任何工具** ——
        //   它是机制自己发现的事实。没有这一条，主对话永远不会知道"任务被机制自己停住了"。
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
       * ★★ **崩了 ≠ 闲着，而且崩了也**必须叫****
       *
       * 现场：席位因模型输出层故障中止（`[MALFORMED_RESPONSE]`），机制 5 分钟后的
       * 判词却是「静默阈值 5 分」并**把任务冻掉** —— 同一张单因此被冻 4 次。
       * 判据：拿到**运行失败证据** ⇒ 判"中止"、**不动状态**，并把这次中止**主动播报**出去。
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

  // --- 服务袋：四条缝共用同一批依赖，各自只取自己要的 ------------------------
  const svc = {
    seatOf,
    warn,
    guard: deps.guard,
    waker: deps.waker ?? null,
    getTask: deps.getTask,
    mainReattach: deps.mainReattach,
    wakeMain,
    runLivenessCheck,
    injected,
    staleNoticed,
    noteStaleKey,
    seatSilenceMs: deps.seatSilenceMs,
  }

  // --- 挂 / 摘 ---------------------------------------------------------------
  const unmountAll = () => {
    for (const [id, dispose] of [...mounted.entries()]) {
      try {
        dispose()
      } catch (err) {
        warn(`[pipeline] 摘拦截缝 ${id} 失败（不影响本次调用）：${String(err?.message ?? err)}`)
      }
      mounted.delete(id)
      audit.noteUnmount(id)
    }
  }

  const mountOne = (hook) => {
    // 每条缝第一句都问闸门（逐次判据）；`ask` 同时把"被问/放行/拦下"记进观测台账。
    const ask = createSeamGate({ audit, shouldFire: (id) => shouldFire(deps.sw, id), hookId: hook.id })
    const handler = hook.make({ ...svc, ask })
    try {
      const dispose = ctx.on(hook.event, handler)
      mounted.set(hook.id, typeof dispose === 'function' ? dispose : () => {})
      audit.noteMount(hook.id)
    } catch (err) {
      warn(`[pipeline] 拦截缝 ${hook.event}（${hook.id}）挂载失败（该缝的判据不会生效）：${String(err?.message ?? err)}`)
    }
  }

  /** ★★ 按闸门同步挂载面：**整组重挂**以保证 {@link HOOKS} 的顺序（③ 必须在 ④ 之前）。 */
  const syncHooks = () => {
    const desired = HOOKS.filter((h) => shouldFire(deps.sw, h.id))
    const desiredIds = desired.map((h) => h.id)
    const currentIds = [...mounted.keys()]
    if (desiredIds.length === currentIds.length && desiredIds.every((id, i) => id === currentIds[i])) return
    unmountAll()
    for (const hook of desired) mountOne(hook)
  }

  syncHooks()
  let unsubscribe = null
  if (typeof deps.sw?.subscribe === 'function') {
    try {
      unsubscribe = deps.sw.subscribe(() => syncHooks())
    } catch (err) {
      warn(`[pipeline] 订阅总开关失败（拦截缝不会跟随开关翻转）：${String(err?.message ?? err)}`)
    }
  }

  return {
    /** 本插件管的**四条缝的事件名**（静态清单；真的挂着几条看 `mounted()`）。 */
    seams: HOOKS.map((h) => h.event),
    /** `SWITCH_SURFACES` 里的缝 id（与 `mounted()` 同一口径）。 */
    hookIds: HOOKS.map((h) => h.id),
    /** ★ 此刻真的挂着的缝 id（关掉 ⇒ 空数组；自测/排障的机器可读判据）。 */
    mounted: () => [...mounted.keys()],
    /** ★ 观测台账（"被问/放行/拦下"计数；只读快照见 `snapshot()`）。 */
    audit,
    seenSeats: injected,
    staleNoticed,
    runLivenessCheck,
    dispose: () => {
      unmountAll()
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe()
        } catch {
          /* 退订失败不影响结论 */
        }
      }
    },
  }
}
