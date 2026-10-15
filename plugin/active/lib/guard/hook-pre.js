// 拦截缝 ① `tools/pre-execute`：与 ctx.tools.guard **同一份**判据的那个前置执法点。
/**
 * dsh-pipeline · 拦截缝 ① · `tools/pre-execute`
 * ============================================================================
 * 用户原话：「我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写」
 *           「四问 Skill 只是"引导"；**真正的拦截必须是代码**」
 *
 * 为什么它和 `ctx.tools.guard` **两个执法缝都要**：
 *   · `ctx.tools.guard` 只在**工具服务**那条路上跑，靠令牌/会话绑定认人；
 *   · `tools/pre-execute` 是宿主的**前置缝**，按"这个会话是不是管线席位"认人 ——
 *     管线席位**派生出来的子会话**（没有自己的令牌）也躲不掉。
 *   ⇒ 判据只有一份（`deps.guard`，来自 `lib/guard-factory.js`），两条缝不会漂移。
 *
 * ---------------------------------------------------------------------------
 * ★ 总开关：**这条缝问闸门两次，两次都有用**
 * ---------------------------------------------------------------------------
 *   ① 挂载侧：`lib/intercept/registry.js` 在关掉时**根本不挂**这条缝
 *      （⇒ "off 时挂着的缝 = 0"，可程序化断言）；
 *   ② 调用侧：本函数的第一句仍然问一次闸门 —— 挂载是**采样**（订阅到才摘），
 *      而闸门是**逐次**的。开关是即时生效的，不能有一次调用落在两次采样之间。
 *
 * ★ 作用域（不做就是事故）：这些缝是**宿主级**的，全机每个会话都会经过。
 *   所以本文件第一条判据永远是"这个会话是不是本插件派出去的管线席位"：
 *   不是 ⇒ **直通放行**（用户自己的对话、别的项目、别的插件的会话一律不管）。
 *   主对话默认不在令牌表里，所以也直通 —— 它只在调用 `pipeline_*` 工具时受
 *   `ctx.tools.guard` 约束（那是另一条缝，见 `lib/guard.js`）。
 *
 * @module dsh-pipeline/lib/guard/hook-pre
 */

import { agentIdOf } from '../guard.js'
import { criterionOf, SEAM_VOICE_ACTIONS } from '../intercept/seam-voice.js'

/**
 * ★★ **绝不静默**：工具缝的拒绝理由用户看得见（宿主的工具结果），
 * 但"看见过"不等于"查得到" —— 所以每条拒绝**再补一行审计**
 * （谁 / 何时 / 命中哪条判据 / 工具 + 目标），并在这段可见文案里点明留痕在哪。
 *
 * 用户裁定的判据（逐字）：「一票否决时**必须给用户可见的说明**」
 *                      「**只有"拒绝"没有"说明" = 失败**」。
 */
export const DENY_TRACE_POINTER =
  '★ 留痕：这一条已写进 `.pipeline/<任务>/audit.jsonl`（`action=seam:tool-deny`）—— 拒绝不会静默发生。'

/**
 * 从调用里抠出"目标"（写进审计的 `target`）：优先取路径 / 模式这类可核对的字段。
 *
 * @param {object} exec
 * @returns {string|null}
 */
export function targetOf(exec) {
  const a = exec?.arguments
  if (a === null || typeof a !== 'object') return null
  for (const k of ['path', 'file_path', 'pattern', 'query', 'command', 'cwd']) {
    const v = a[k]
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 200)
  }
  return null
}

/**
 * 造 pre-execute 缝的中间件。
 *
 * @param {object} svc - 由 `lib/intercept/registry.js` 装配的服务袋
 * @param {()=>boolean} svc.ask - 闸门（`shouldFire('seam-pre-execute')` + 观测计数）
 * @param {(exec:object)=>string|undefined} svc.guard - **同一份**守门判据
 * @param {(sid:string)=>Promise<object>} [svc.mainReattach] - 主对话侧的重启自动认领
 * @param {(taskId:string, now?:number)=>Promise<object|null>} svc.runLivenessCheck - 失联检测（节流在 registry）
 * @param {(spec:object)=>Promise<object|null>} [svc.recordSeamVoice] - ★ 留痕（只追加 audit.jsonl）
 * @param {(m:string)=>void} svc.warn
 * @returns {(exec:object, next:Function)=>Promise<*>}
 */
export function createPreExecuteHook(svc) {
  const { ask, guard, runLivenessCheck, warn, seatOf } = svc
  const waker = svc.waker ?? null
  const mainReattach = typeof svc.mainReattach === 'function' ? svc.mainReattach : null
  const recordSeamVoice = typeof svc.recordSeamVoice === 'function' ? svc.recordSeamVoice : null

  return async function preExecuteHook(exec, next) {
    // ★★ 总开关（唯一判据在 `lib/switch/gate.js`）：关 ⇒ 这条缝一个判据都不跑。
    if (!ask()) return next()

    /**
     * ★★ **主对话侧的重启自动认领**（判据与纪律见 `lib/reattach.js` 文件头）。
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
    if (seat.taskId.length > 0 && waker !== null) {
      try {
        waker.markSeatConsumed?.(seat.taskId, { seat: seat.seat ?? seat.role, by: `seat:${seat.role}`, action: String(exec?.name ?? '') })
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
      reason = guard(exec)
    } catch (err) {
      // 判据炸了就 fail-closed：宁可拒一次，也不要静默放行
      reason = `[pipeline] 拦截缝内部异常，按 fail-closed 拒绝本次调用：${String(err?.message ?? err)}`
    }
    if (typeof reason === 'string' && reason.length > 0) {
      // ★★ **绝不静默（用户裁定）**：拒绝必须①说给用户听 ②留得下审计。
      //    ① 的载体就是下面返回的 `reason`（宿主的工具结果，用户看得到）+ 尾部那行留痕指引；
      //    ② 走 `lib/intercept/seam-voice.js`：**只追加** `.pipeline/<任务>/audit.jsonl`，
      //       **不碰 `task.json`** —— 拒绝不是进展（同 lib/reattach.js:498-505 的理由）。
      const target = targetOf(exec)
      if (recordSeamVoice !== null) {
        try {
          await recordSeamVoice({
            taskId: seat.taskId,
            role: seat.role,
            seat: seat.seat ?? null,
            agentId: agentIdOf(exec),
            action: SEAM_VOICE_ACTIONS.TOOL_DENY,
            criterion: criterionOf(reason),
            tool: String(exec?.name ?? ''),
            target,
            note: '★ 判据落在工具缝（提示词缝不做用户消息判据）—— 真去读源码的那一次在这里被拒',
          })
        } catch {
          /* 留痕失败不影响判决（记录器本身也不抛） */
        }
      }
      return { kind: 'deny', reason: `${reason}\n${DENY_TRACE_POINTER}` }
    }
    return next()
  }
}
