/**
 * dsh-pipeline · **席位失联检测**
 * ============================================================================
 * 用户原话：
 *   「**被切断后要能自我意识到**」+「不是卡死、不是报错终止、也不是反复撞同一面墙」
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它：一个真实事故留下的空洞
 * ---------------------------------------------------------------------------
 * 2026-10-11：主对话 `pipeline_dispatch role=orchestrator` **成功**建了子会话、
 * 投递了派活单、返回了令牌；然后那个子会话在 `turn/start` 之后 **277 ms** 就死了
 * （宿主报 `Cannot read properties of undefined (reading 'kind')`）。
 *
 * 结果：任务永远停在「需求分析中」、`pipeline_status` 显示「交接物（0 份）」，
 * **机制自己一句话都不说** —— 主对话是从宿主的通知里才知道的，用户是从主对话口里
 * 才知道的。这就是「被切断后不能自我意识到」最贵的一种形态：**静默**。
 *
 * 本模块补的就是这一层：**派出去的席位有没有回话，机制得知道**。
 *
 * ---------------------------------------------------------------------------
 * 判据（三条同时成立才算"失联"，宁可漏报也不误报）
 * ---------------------------------------------------------------------------
 *   ① **超时**：`now - dispatched_at >= silenceMs`（默认 5 分钟，可配）。
 *   ② **轮到场了**：该角色的**下一步就该它动**（见 {@link EXPECTED_ROLES_BY_STATE}）。
 *      ★ 这一条是**防误报的关键**：双轨派活下审核是与编写同时开工的，它可能
 *        合法地沉默很久（链路是 编写 → 测试 → **才**交审核）。没有这一条，
 *        审核每次都会被误判成失联。
 *   ③ **没有任何活着的证据**：自派活之后，该席位没产出交接物、没写过历史、
 *      没自报过水位、也没被继任过（见 {@link evidenceOfLife}）。
 *
 * ---------------------------------------------------------------------------
 * 刻意**不做**的三件事
 * ---------------------------------------------------------------------------
 *   · **不起定时器**。插件没有生命周期外的调度面，定时器还会与"不安装不重启"的
 *     纪律打架。判据是**纯函数**，"什么时候查"由调用方决定 —— 本插件挂在
 *     既有的两个点上：`pipeline_status`（读时暴露）与 `tools/pre-execute`
 *     （任意角色的下一次工具调用；写时检查，带节流）。
 *   · **不猜**。查不到就报"查不到"，不把"没证据"写成"它还活着"，
 *     也不把"没证据"直接写成"它死了"——超时阈值就是"没证据"到"失联"的那条线。
 *   · **不新开状态**。失联的处置复用**既有**的异常出口 `block`（`states.js` 里
 *     `{ from:'*', event:'block', to: BLOCKED, by:['main','human'] }`），
 *     理由写进 `task.liveness.escalations[]` + 审计 —— 不新开一套并行机制。
 *
 * @module dsh-pipeline/lib/liveness
 */

export {
  DEFAULT_ACTIVITY_FRESH_MS,
  DEFAULT_ACTIVITY_MAX_MS,
  DEFAULT_ACTIVITY_MIN_BYTES,
  DEFAULT_SEAT_SILENCE_MS,
  DEFAULT_SILENCE_CONFIRMATIONS,
  LIVENESS_ACTIVITY_SOURCE,
  SESSION_LOG_NAME,
  activityOfSamples,
  findSessionLog,
  formatDuration,
  sampleSessionLog,
  sessionsRootCandidates,
} from './liveness/activity.js'

export { EXPECTED_ROLES_BY_STATE, evidenceOfLife, msOf, seatKey, seatLiveness, upsertDispatch } from './liveness/seats.js'

export { describeSilentSeats, describeSuspectedFalsePositive, nextActionsFor } from './liveness/describe.js'

export { VIA_SESSION, createChannelAudit, livenessSelfHeal } from './liveness/heal.js'

/**
 * ★★ **P1-4：「在等审批」判据**（ask 审批策略下席位弹审批卡等人，不该被判失联）。
 *
 * 判据来源是宿主自己写进会话日志的 `approval/asked` / `approval/decided` 事件
 * （`approval/asked` 的 id 没有配对的 `approval/decided` = 还在等人批）——
 * 宿主**没有**可直接读的"pending approval"服务，读取路径与同源证据见
 * `lib/liveness/approval.js` 的文件头。
 */
export {
  APPROVAL_ASKED,
  APPROVAL_DECIDED,
  APPROVAL_EVENT_TYPES,
  APPROVAL_POLICY,
  MAX_APPROVAL_LOG_BYTES,
  MAX_APPROVAL_TAIL_BYTES,
  MAX_APPROVAL_TOOLS_SHOWN,
  ZSTD_FRAME_MAGIC,
  approvalItemText,
  approvalWaitDuration,
  approvalWaitSignature,
  createSeatApprovalProbe,
  decompressZstdFramesLossy,
  describeApprovalWait,
  detectPendingApprovals,
  foldApprovalEvents,
  foldApprovalText,
  pendingToolsText,
  scanApprovalsInAgent,
  scanApprovalsInLog,
  summarizeApprovalWait,
  zstdFrameOffsets,
} from './liveness/approval.js'
