// 总开关的**统一闸门**：所有拦截面都问它一句「我现在该不该动手」。
/**
 * dsh-pipeline · 功能开关 · 闸门（唯一策略源）
 * ============================================================================
 * 缺陷现场（用户原话）：「**`pipeline_switch` 关掉后，插件仍在拦截 —— 开关只关一半**」。
 *   ① `pipeline_switch {on:false}` 返回「守门已弃权（**任何调用都不再被本插件拦**）」；
 *   ② **紧接着**那次工具调用的结果仍被 `tools/post-execute` 的"第二道网"换掉。
 *
 * 根因（结构性，不是漏写一句 if）：改前"开关"只是**若干处各自为政的 `sw.isOn()` 读取**
 * （守门 / 席位工具面收紧 / 写操作拒绝读了），而四条拦截缝与唤醒器**一条都没读**。
 * ⇒ **一处分叉就会再长出同样的缺陷**，所以闸门只此一处。
 *
 * ---------------------------------------------------------------------------
 * 三个出口（各问各的问题，别混用）
 * ---------------------------------------------------------------------------
 *   · {@link isEnabled}(sw)            —— "功能是开着的吗？"（最常用）
 *   · {@link shouldFire}(sw, hookId)   —— "这一条缝现在该不该动手？"（逐缝）
 *   · {@link guardVerdict}(sw)         —— 守门专用：要**区分**"关"与"读不出来"
 *     （关 = 弃权 `undefined`；读不出来 = fail-closed 明确拒绝 —— 不许因为
 *      开关文件被弄坏就变成静默放行）
 *
 * ---------------------------------------------------------------------------
 * ★ 「关 = 彻底摘干净」的**可执行定义**就是 {@link SWITCH_SURFACES}
 * ---------------------------------------------------------------------------
 * 它是"受总开关管的面的清单"：谁、在哪、关掉是什么行为、为什么。
 * **新增任何"会拦住/改写/注入/替用户做决定/写项目目录"的面，都必须在这里登记一行**，
 * 并且第一句过闸门 —— 自测 `tests/switch-off-no-hooks-check.mjs` 会按条数核对
 * （每条 `ctx.on(...)` 缝都要有对应的 `shouldFire`），漏一条就红。
 *
 * `off` 字段就是承诺：
 *   · `inert`   一点都不许发生（拦住 / 改写 / 注入 / 投递 / 记账，全部直通）
 *   · `refuse`  仍然明确拒绝（写操作；关掉功能的语义就是"不干活"）
 *   · `stopped` 周期**停表**（不是"跑着但什么都不做"）
 *   · `allowed` 允许照常（**无害只读**；关掉它反而会造成"再也开不回来"）
 *
 * ⚠️ `where` 刻意写**文件名 + 符号名**而不是行号 —— 行号会随改动静默漂移，
 *    而这份表的用途正是"事后核对有没有漏面"，写一个会烂的坐标比不写更坏。
 *
 * @module dsh-pipeline/lib/switch/gate
 */

import { readSwitchState } from './state.js'

/** 闸门的四个结论名（给观测与文案共用，避免各写一套字符串）。 */
export const GATE = Object.freeze({
  ON: 'on',
  OFF: 'off',
  READ_ERROR: 'read-error',
})

/**
 * ★ 「功能是开着的吗？」
 *
 * @param {{isOn?:()=>boolean}|null|undefined} sw
 * @returns {boolean} false ⇒ 所有拦截面必须直通
 */
export function isEnabled(sw) {
  return readSwitchState(sw).on === true
}

/**
 * ★ 「这一条缝现在该不该动手？」
 *
 * 逐缝而不是全局，是为了让"哪条缝被关掉了"能被单独观测与断言
 * （`lib/switch/audit.js` 记的就是这个）；当前策略下所有缝同生共死。
 *
 * @param {{isOn?:()=>boolean}|null|undefined} sw
 * @param {string} hookId - `SWITCH_SURFACES` 里的 `id`（缝那一类）
 * @returns {boolean}
 */
export function shouldFire(sw, hookId) {
  if (typeof hookId !== 'string' || hookId.length === 0) return false
  const known = SWITCH_SURFACES.some((s) => s.id === hookId)
  // ★ 没登记的面 = 漏了一个：宁可不动手（fail-safe），也不能"没登记就随便动"。
  if (!known) return false
  return isEnabled(sw)
}

/**
 * ★ 守门专用：把"关"与"读不出来"分开（两种语义都必须留着，但判据只有这一处）。
 *
 * @param {{isOn?:()=>boolean}|null|undefined} sw
 * @returns {{skip:boolean, error:string|null}} `skip` = 弃权（返回 undefined，不是"允许"）
 */
export function guardVerdict(sw) {
  const st = readSwitchState(sw)
  return { skip: st.on !== true, error: st.error }
}

/**
 * ★★ **受总开关管的面的清单**（= "关 = 彻底摘干净"的可执行定义）。
 * @type {ReadonlyArray<{id:string, label:string, kind:string, off:string, where:string, why:string}>}
 */
export const SWITCH_SURFACES = Object.freeze([
  {
    id: 'guard-chain',
    label: '守门（`ctx.tools.guard`，工具服务那条路）',
    kind: 'intercept',
    off: 'inert',
    where: 'lib/guard-factory.js · createGuardFor 的第一句',
    why: '关掉功能就是"本插件不再否决任何调用"。它**弃权**（返回 undefined），不是"允许" —— 别的插件的守卫照样能拒。',
  },
  {
    id: 'seam-pre-execute',
    label: '拦截缝 ① `tools/pre-execute`',
    kind: 'intercept',
    off: 'inert',
    where: 'lib/guard/hook-pre.js（挂载由 lib/intercept/registry.js 按闸门决定）',
    why: '改前只有它调用的**守门**读了开关，而这条缝自己前面还有主对话认领、席位接管留痕、失联检测（会写状态并唤醒）—— 那些在 off 下照跑。现在这条缝**根本不挂**。',
  },
  {
    id: 'seam-pre-step',
    label: '拦截缝 ② `agent/pre-step`（提示词硬拦 + 上下文注入）',
    kind: 'intercept',
    off: 'inert',
    where: 'lib/guard/hook-prompt.js（挂载同上）',
    why: '它**完全没读开关**：`judgePrompt` 会把提示词 `{kind:"reject"}` 掉，还会注入边界卡与失联提示。off 下两者都必须不发生 ⇒ 这条缝不挂。',
  },
  {
    id: 'seam-post-execute-wake',
    label: '拦截缝 ③ `tools/post-execute`（交付即唤醒）',
    kind: 'inject',
    off: 'inert',
    where: 'lib/guard/hook-wake.js（挂载同上）',
    why: '它往主对话会话注入消息（改写对话内容）。off = 回到普通 DSH 行为 ⇒ 不再有任何机制发言。',
  },
  {
    id: 'seam-post-execute-result-net',
    label: '拦截缝 ④ `tools/post-execute`（结果"第二道网"）★ 本次缺陷的现场',
    kind: 'intercept',
    off: 'inert',
    where: 'lib/guard/hook-post.js（挂载同上）',
    why: '它把**已经拿到的工具结果**整个换成一段反馈（`{kind:"block"}`）。这是最容易被用户看见的一种"还在拦"—— 现场证据就是它。',
  },
  {
    id: 'wake-delivery',
    label: '唤醒投递（`wakeup.wake` / `wakeForTool` / `escalateUnconsumed`）',
    kind: 'inject',
    off: 'inert',
    where: 'lib/switch/waker-gate.js（在 `index.js` 装配处包一层）',
    why: '**唯一投递咽喉**：拦截缝、巡检、孤儿单自恢复、工具出口的唤醒全走这里。在咽喉上判一次，四条来路一次覆盖 —— 比在每个调用点各判一次少三处漂移面。',
  },
  {
    id: 'seat-face-tighten',
    label: '席位工具面收紧（`agent.ctx.tools.restrict`）',
    kind: 'intercept',
    off: 'inert',
    where: 'index.js · createSeatFaceTightener（判据走本文件的 `isEnabled`）',
    why: '藏掉席位本该被拒的工具 = 拦截面的一部分。守门弃权时不去"比守门更严"。',
  },
  {
    id: 'main-contact-bookkeeping',
    label: '主对话会话登记（落盘 `task.contacts.main`）',
    kind: 'mechanism',
    off: 'inert',
    where: 'lib/wakeup/main-contact.js · rememberMainCaller 的第一句',
    why: '★ 它是**唯一一处"只读工具也会写项目目录"**的路径：关掉功能后它的消费者（唤醒投递）已整个停掉，记下来没有任何人读，而它是**写** —— 关掉状态下点一下 `pipeline_status` 就改了 `task.json`，那正是"开关只关一半"的观感来源之一。',
  },
  {
    id: 'mutating-tools',
    label: '`pipeline_*` 写操作（开单/编排/派活/交接/打回/关单…）',
    kind: 'intercept',
    off: 'refuse',
    where: 'lib/tools/kit.js · tool() 的 execute 第一句（文案在 lib/switch/text.js）',
    why: '★ 唯一**故意**在 off 下仍然生效的一条：关掉功能的语义就是"不干活"，放行写操作会让状态机在没有守门的情况下继续被推进。只读工具（status / selftest / switch）不受影响。',
  },
  {
    id: 'patrol',
    label: '巡检兜底（`setInterval`，只播报不动作）',
    kind: 'mechanism',
    off: 'stopped',
    where: 'lib/switch/mechanisms.js（条目由本文件构建，起停受 sw.subscribe 驱动）',
    why: '它自己只读，但每一轮都会 `wakeup.wake` + `wakeup.escalateUnconsumed`（注入 + 写 `.pipeline` 账本）。**停表**比"跑着但空转"诚实：`running()` 能被程序化核对。',
  },
  {
    id: 'orphan-rescue',
    label: '孤儿单自恢复（`setInterval`，识别 + 重新投递）',
    kind: 'mechanism',
    off: 'stopped',
    where: 'lib/switch/mechanisms.js（同上）',
    why: '它是 off 下**唯一还会主动往席位会话投递**的东西（`notify`），并且写 `.pipeline` 账本与审计。停表后 `runOnce` 不再被定时器触发。',
  },
  {
    id: 'switch-route',
    label: '开关的 HTTP 面（`/.dsh-pipeline/state` 的 GET/POST）',
    kind: 'readonly',
    off: 'allowed',
    where: 'lib/switch-routes.js · createSwitchHandler',
    why: '★ **必须留着**：它是"关掉之后还能再打开"的唯一 UI 入口（右上角那个按钮走它）。关掉它 = 关一次就再也开不回来。它不改会话、不拦调用，只读写开关自己的 `.pipeline/switch.json`。',
  },
  {
    id: 'client-poll',
    label: '客户端长轮询（右上角按钮的状态同步）',
    kind: 'readonly',
    off: 'allowed',
    where: 'lib/client.js · 定时轮询开关状态',
    why: '跑在**浏览器**那一半，只 `GET` 开关状态用来把按钮画对。它不产生任何拦截，且是"关掉之后用户看得见自己是关的"的唯一途径。',
  },
])
