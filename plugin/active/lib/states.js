/**
 * dsh-pipeline · 任务状态机
 * ============================================================================
 * 主对话维护状态，但**状态怎么走是机制定的**，不是主对话说了算。
 * 每一对 (from, event) → to 都是显式登记的；没登记的组合一律拒绝。
 *
 * 正常链（本轮把「分析」与「计划」拆成两站）：
 *   待分配 → 需求分析中 → 待计划 → 计划中 → 待开发 → 开发中 → 待测试 → 测试中
 *          → 待审核 → 审核中 → 已通过 → 已关闭
 * 异常：
 *   已打回编写 / 已打回测试 / 已阻塞 / 已取消
 *   （外加两个等待态：等待需求分析答复 / 等待人工答复）
 *
 * ★★ **主管枢纽链**（T-20261011-56a37e 新增；由主管位发起动作激活，见 `hub_initiate`）：
 *   待分配 →（主管发起）需求分析中 →（需求结论交主管）主管受理中
 *          →（第①道确认＋**唤醒点 A**）架构位出图中 →（架构图产出）架构图待主管确认
 *          →（第②道确认＋**唤醒点 B**）计划位已唤醒待派 →（计划位派活）计划中
 *          → 待开发 → 开发中 → 待测试 → 测试中 →（第③道**双确认**）待审核
 *          → 审核中 → 已通过 →（第④道**双确认**）已关闭 ⇒ 用户收到结果
 *   ★ 架构图前置是**表上**的硬序：`analyzing` 没有直达 `planning` 的边。
 *   ★ 未启用枢纽的任务走上面的"正常链"，一个字节没变（这是回归保护，不是放宽）。
 *
 * ★ 关键不变量（写死在这里，任何档位、任何配置都改不了）：
 *   1. `developing` 只能走到 `ready_test`，**没有**直达 `ready_review` 的边。
 *      编辑"编写绕过测试直接找审核"的第一道闸。
 *   2. `passed` 只能由 `reviewing` + 审核 OK 到达。第二道闸。
 *   3. `closed` 只能由 `passed` 到达。第三道闸（配合"必须存在 OK 交接物"）。
 *   4. ★本轮新增：`analyzing → ready_plan` 必须有**用户答复**（guard
 *      `requirement_confirm_gate`）。澄清前置到人工确认，不是靠自觉。
 *   5. ★本轮新增：`planning → ready_dev` 必须有**自检通过的 plan**
 *      （guard `plan_ready`）。计划缺失时 planner 只能走回流，不能硬分配。
 *
 * @module dsh-pipeline/lib/states
 */

// ★ 本文件现在是 barrel：实现按关注点拆到 lib/states/{core,hub,transitions}.js，
//   对外导出名与拆前逐字一致 —— 既有 import './states.js' / '../states.js' 全部不受影响。
export {
  ST,
  WAITING_STATES,
  DIAGRAM_DELIVERY_STATES,
  ROLES_CAN_ASK_CLARIFICATION,
  STATE_LABEL,
  TERMINAL_STATES,
  ROLES_CAN_RAISE_HUMAN,
} from './states/core.js'

export {
  HUB_WAKE_POINTS,
  HUB_STANDBY_SEATS,
  HUB_STANDBY_ROLES,
  hubWakePointOf,
  HUB_STATIONS,
  HUB_STATION_CONFIRMERS,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_HANDOFF_CONFIRM_CONFIRMERS,
  HUB_HANDOFF_CONFIRM_ORDER,
  HUB_HANDOFF_CONFIRM_EVENTS,
  HUB_ALL_CONFIRMERS,
  HUB_STATION_NAMES,
  HUB_DUAL_STATIONS,
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_STATION_REJECT_BUDGET,
  HUB_STATION_REJECT_EVENTS,
  HUB_REJECT_EVENT_STATIONS,
  HUB_STATION_REJECT_STATIONS,
  HUB_CONFIRM_STATIONS,
  hubConfirmersOf,
  hubIsKnownStation,
  hubIsDualStation,
} from './states/hub.js'

export {
  TRANSITIONS,
  STATE_OWNER,
  findTransition,
  availableTransitions,
  projectedRoleVisible,
  projectedTransitions,
  projectedNextEvents,
  explainRefusal,
  applyTransition,
  resolveUnblockRecovery,
} from './states/transitions.js'
