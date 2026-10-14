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

// ---------------------------------------------------------------------------
// 文件布局：本文件只做转出，实现按主题拆在 `lib/wakeup/` 下（对外导出名与拆分前逐一相同）
//   wakeup/keys.js      常量、触发工具表、主对话登记表、唤醒键 / 请求 id / 判别子
//   wakeup/identity.js  账本身份（候选、作用域内身份、事件身份）
//   wakeup/deliver.js   唤醒正文渲染与投递
//   wakeup/waker.js     唤醒器 createWaker 与调用方识别
// ---------------------------------------------------------------------------

export {
  WAKE_SOURCE_KIND,
  WAKE_FORM,
  WAKE_AUDIT,
  WAKE_TRIGGER_TOOLS,
  WAKE_TRIGGER_TOOL_NAMES,
  WAKE_ACTOR_MECHANISM,
  createMainSessionRegistry,
  wakeKeyOf,
  legacyWakeKeyOf,
  wakeRequestIdOf,
  wakeMessageIdOf,
  discriminatorOf,
  actorKeyOf,
} from './wakeup/keys.js'

export {
  ledgerIdentityOf,
  statusOfLedgerEntry,
  liveLedgerCandidates,
  ledgerCandidates,
  ledgerIdentityScoped,
  eventIdentityFor,
  transitionDiscOf,
  stableDiscFor,
} from './wakeup/identity.js'

export {
  sleep,
  nextStepLine,
  stateOfTask,
  renderWakeText,
  wakeMessage,
  alreadyDelivered,
  probeTargetSession,
  deliverWake,
} from './wakeup/deliver.js'

export {
  createWaker,
  actorOf,
} from './wakeup/waker.js'
