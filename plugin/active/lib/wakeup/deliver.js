/**
 * dsh-pipeline · 唤醒 · 正文渲染与投递
 * ============================================================================
 * 从 `lib/wakeup.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/wakeup.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/wakeup/deliver
 */

import { hostMessage } from '../hostmsg.js'
import { STATE_LABEL, STATE_OWNER, availableTransitions } from '../states.js'
import { WAKE_SOURCE_KIND, WAKE_FORM, actorLabel, wakeKeyOf, wakeMessageIdOf } from './keys.js'

/** 小睡（**只用于"等身份产生"这一处**：等一次读盘的时间，不做轮询、不起定时器）。 */
export function sleep(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 200) : 0
  return new Promise((resolve) => setTimeout(resolve, wait))
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
