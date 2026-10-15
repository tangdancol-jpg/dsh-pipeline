// 拦截缝 ③ `tools/post-execute`：**交付即唤醒主对话**（本次前置修复的核心）。
/**
 * dsh-pipeline · 拦截缝 ③ · `tools/post-execute`（交付即唤醒）
 * ============================================================================
 * 从 `lib/intercept.js` 拆出来的一部分（**代码原样搬过来，行为未改**；
 * 拆分理由见 `CONVENTIONS.md`：一文件一职责、单文件 ≤400 行）。
 *
 * ---------------------------------------------------------------------------
 * 现场（用户原话）
 * ---------------------------------------------------------------------------
 *   「真实会话干完活，**主对话收不到任何信号**，只能靠人问或轮询，
 *     整条流水线看着像停摆。」
 *
 * 根因：旧的**子代理**通道自带回调（会话结束 ⇒ harness 往协调者注入一条
 * `Background subagent … finished`），而新的**真实会话**通道只做了
 * 「建会话 → 投递 → 读回」三步，**没有第四步「交付回调」**。
 *
 * 这一条就是第四步：席位交付 / 状态推进 / 席位失联的那一刻，往主对话所在
 * 会话注入一条 `source.kind = runtime-context` 的**可操作**消息
 * （谁 · 发生了什么 · 当前状态 · **下一步合法事件**）。
 *
 * ★ **注册顺序有讲究**：它排在 ④「结果带代码正文 ⇒ 拦结果」**之前**。
 *   宿主 waterfall 一旦被 ④ 拦下（`{kind:'block'}`），后面的监听器就不会再跑 ——
 *   而**工具本身已经执行完了**（交付已经发生），因为"结果里带了代码"就吞掉唤醒
 *   是错的。唤醒与结果内容无关，所以它必须排在前面
 *   （挂载次序由 `lib/intercept/registry.js` 保证）。
 *
 * ★ 作用域：只认**触发点表内**的工具（`WAKE_TRIGGER_TOOLS`，`lib/wakeup.js`），
 *   其余工具一律直通 —— 特别是 `pipeline_status` 这种只读查询，
 *   主对话每次查状态都唤醒一次就是刷屏。
 *
 * ★ 总开关：关 ⇒ 不唤醒、不往任何会话注入消息（本函数第一句问闸门；
 *   关掉时这条缝在 `registry` 里**根本不会被挂上**）。
 *
 * @module dsh-pipeline/lib/guard/hook-wake
 */

import { WAKE_TRIGGER_TOOLS, actorOf } from '../wakeup.js'
import { readWakeDisc } from '../intercept/wake-disc.js'

/**
 * 造 post-execute「交付即唤醒」缝的中间件。
 *
 * @param {object} svc
 * @param {()=>boolean} svc.ask - 闸门（`shouldFire('seam-post-execute-wake')` + 观测计数）
 * @param {(agentId:string)=>object|null} svc.seatOf - 席位解析（与别的缝**同一份**）
 * @param {(spec:object)=>Promise<object|null>} svc.wakeMain - 投递（幂等与投递路径都在唤醒器里，唯一一份）
 * @param {(taskId:string)=>object|null} svc.getTask
 * @returns {(exec:object, result:*, next:Function)=>Promise<*>}
 */
export function createWakeHook(svc) {
  const { ask, wakeMain, seatOf } = svc
  const getTask = typeof svc.getTask === 'function' ? svc.getTask : null

  return async function wakeHook(exec, result, next) {
    // ★★ 总开关：关 ⇒ 不唤醒、不往任何会话注入消息。
    if (!ask()) return next()
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
        task = getTask === null ? null : getTask(actor.taskId)
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
  }
}
