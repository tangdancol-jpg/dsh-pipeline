// 拦截缝 ② `agent/pre-step`：提示词**提示**（可见文案 + 审计，不否决）+ 席位开场注入 + 失联提示。
/**
 * dsh-pipeline · 拦截缝 ② · `agent/pre-step`（UserPromptSubmit）
 * ============================================================================
 * ★★ **这一条缝不再有一票否决**（2026-10-16 真机缺陷的口径修正）
 * ----------------------------------------------------------------------------
 * 现场：把 `pl-main` 预设全文粘进主对话会话 ⇒「**这一轮 1 秒结束、消息像没发出去**」。
 * 成因是 `judgePrompt` 拿一条正则去扫**拼起来的用户文本**，命中的是**叙述规则的散文**，
 * 然后 `return {kind:'reject', reason}` —— 而 `agent/pre-step` 的 reject 是**宿主的一票否决**：
 * turn **根本不开始**，所以拒绝理由**没有任何出口**（会话事件里
 * `turn/end {"reason":{"kind":"blocked"}}` 之前没有 `step/start`，插件侧零留痕）。
 *
 * 两条修正（判据见 `lib/intercept/prompt-rules.js` 文件头的口径表）：
 *   ① **用户消息层不做越界判据** —— 用户有权粘贴任何东西；
 *      判据从"文本里出现了什么字"改成"**有没有真的发起读动作**"，落点在 `tools/pre-execute`。
 *   ② **绝不静默** —— 剩下的提示判据命中时，**注入一条用户看得见的说明**
 *      （`hostMessage`，登记在 `HOST_INJECTION_SITES`）**并写审计行**
 *      （`lib/intercept/seam-voice.js`）；这一轮**照常进行**。
 *
 * ★★ **注入形状是硬契约**（2026-10-11 事故的教训）★★
 *   凡是塞进 `messages` / `additionalContexts` 的**消息**，必须满足：
 *     `content` 是 **block 数组**、`source` 是**带 `kind` 的对象**。
 *   宿主有不止一处**无守卫**地读 `message.source.kind`
 *   （`@deepseek-ai/dsh-session-reference#prepareDirectMessages`、
 *    `@deepseek-ai/dsh-repeat-tool-reminder`、`dsh-orb` 的 computer-use 缝）。
 *   一条裸消息（`{role:'user', content:'...'}`）就能让**整个 turn** 以
 *   `Cannot read properties of undefined (reading 'kind')` 收尾 ——
 *   子会话在 `turn/start` 之后 277 ms 静默死亡。
 *   ⇒ **一律走 `lib/hostmsg.js` 的 `hostMessage()`**，注入点必须在
 *     `HOST_INJECTION_SITES` 里登记，自测按那张表核对形状。
 *
 * ★ 下游一旦不是 `{kind:'enter'}` 就必须**原样**传回去（包括它给的 undefined ——
 *   宿主 waterfall 不填默认值，本插件不许替宿主发明形状）。
 *
 * ★ 总开关：关 ⇒ 不提示、不注入边界卡、不跑失联检测（三者都是"本插件在说话"）。
 *
 * @module dsh-pipeline/lib/guard/hook-prompt
 */

import { NO_CODE_READ_ROLES, agentIdOf } from '../guard.js'
import { hostMessage } from '../hostmsg.js'
import { seatLiveness } from '../liveness.js'
import { collectPromptText, judgePrompt, seatBriefing, PROMPT_ADVICE_FORM } from '../intercept/prompt-rules.js'

/**
 * 造 pre-step 缝的中间件。
 *
 * @param {object} svc - 由 `lib/intercept/registry.js` 装配的服务袋
 * @param {()=>boolean} svc.ask
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @param {(taskId:string, now?:number)=>Promise<object|null>} svc.runLivenessCheck
 * @param {(taskId:string)=>object|null} svc.getTask
 * @param {Set<string>} svc.injected - 已注入过开场简报的席位键（跨调用去重）
 * @param {Set<string>} svc.staleNoticed - 已发过失联提示的键（去重）
 * @param {number} [svc.seatSilenceMs]
 * @param {(spec:object)=>Promise<object|null>} [svc.recordSeamVoice] - ★ 留痕（只追加 audit.jsonl）
 * @returns {(payload:object, next:Function)=>Promise<*>}
 */
export function createPromptHook(svc) {
  const { ask, seatOf, runLivenessCheck, injected, staleNoticed, noteStaleKey } = svc
  const getTask = typeof svc.getTask === 'function' ? svc.getTask : null
  const recordSeamVoice = typeof svc.recordSeamVoice === 'function' ? svc.recordSeamVoice : null

  return async function promptHook(payload, next) {
    // ★★ 总开关：关 ⇒ 不提示、不注入、不跑失联检测。
    if (!ask()) return next()
    const seat = seatOf(agentIdOf(payload))
    if (seat === null) return next()

    // ★ **失联检测的触发器②**：席位**开新的一步**时也查一次（同一函数、同一节流）。
    //
    //   为什么不能只挂 `tools/pre-execute`：真实事故里席位**秒死**，此后
    //   **没有任何角色再调用工具** —— 那个触发点永远等不到"下一次调用"。
    //   而"开新的一步"覆盖了**用户发消息**（用户会说话、会追问）这一情形：
    //   只要这个会话还活着，它每走一步都会顺带看一眼"派出去的席位还在不在"。
    if (seat.taskId.length > 0) await runLivenessCheck(seat.taskId)

    // ★★ **判据只是"提示"，不是"否决"**（口径修正见文件头）：
    //   命中了也**照常 `next()`** —— 说明以"注入一条用户看得见的消息"的形式抵达，
    //   同时落一行审计。**绝不** `{kind:'reject'}`（那条路没有出口 ⇒ 静默）。
    const advice = judgePrompt(seat, collectPromptText(payload))
    if (advice !== null && recordSeamVoice !== null) {
      try {
        await recordSeamVoice({
          taskId: seat.taskId,
          role: seat.role,
          seat: seat.seat ?? null,
          agentId: agentIdOf(payload),
          action: advice.action,
          criterion: advice.criterion,
          hit: advice.hit,
          note: '★ 提示词缝**不否决**这一轮：命中只产出可见说明 + 审计（"绝不静默"）',
        })
      } catch {
        /* 留痕失败不影响这一轮（记录器本身也不抛） */
      }
    }

    const downstream = await next()
    if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') return downstream

    const extra = []

    // 注入①：★ 提示判据命中 ⇒ **用户可见的说明**（不是拒绝）。
    if (advice !== null) {
      extra.push(
        hostMessage({
          text: advice.text,
          form: PROMPT_ADVICE_FORM,
          taskId: seat.taskId,
          role: seat.role,
          seat: seat.seat,
          extra: { criterion: advice.criterion, hit: advice.hit },
        }),
      )
    }

    // 注入②：席位开场简报（边界卡 + 四问）。每个席位**只注入一次**。
    const key = `${seat.taskId}|${seat.role}|${seat.seat ?? ''}`
    let task = null
    try {
      task = getTask === null ? null : getTask(seat.taskId)
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

    // 注入③：★ 失联席位提示 —— 只发给**控制角色**（它们才负责调度），一次性。
    //
    //   为什么只给控制角色：失联的处置动作（重派 / 换班 / 阻塞）只有主对话、
    //   需求分析、计划 AI 有权限做；把这条提示塞给编写/测试只会制造噪音。
    //   `NO_CODE_READ_ROLES` 恰好就是这三者 —— 复用它，不新造一份名单。
    //   （本轮删掉的是它对**提示词文本**的判据用途；这份名单本身仍只有
    //     `lib/guard/rules.js` 一个出处，这里照旧 import，不另抄一份。）
    if (NO_CODE_READ_ROLES.includes(seat.role) && task !== null) {
      const live = seatLiveness(task, Date.now(), { silenceMs: svc.seatSilenceMs })
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
  }
}
