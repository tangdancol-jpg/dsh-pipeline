/**
 * dsh-pipeline · 任务状态机 · 转移表与判定
 * ============================================================================
 * 从 lib/states.js 机械拆出（纯搬家，行为逐字未变）：TRANSITIONS、STATE_OWNER、
 * 查表 / 解释 / 应用转移，以及 unblock 的恢复点解析。
 * 对外入口仍是 lib/states.js（barrel）。
 *
 * @module dsh-pipeline/lib/states/transitions
 */

import { ROLE } from '../roles.js'
import {
  ROLES_CAN_ASK_CLARIFICATION,
  ROLES_CAN_RAISE_HUMAN,
  ST,
  STATE_LABEL,
  TERMINAL_STATES,
  WAITING_STATES,
} from './core.js'
import {
  HUB_HANDOFF_CONFIRM_EVENTS,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_STATION_REJECT_EVENTS,
  HUB_STATIONS,
} from './hub.js'
import { DEMO_EVENTS, DEMO_ST, demoPhaseMerge, demoStateOwners } from './demo-phase.js'

/**
 * 状态转移表。
 *
 * 每一条：`event` 是触发动作名，`by` 是有权触发它的角色列表，
 * `guard` 是可选的前置条件名（由 store 层实现）。
 *
 * @type {Array<{from:string, event:string, to:string, by:string[], guard?:string, note:string}>}
 */
export const TRANSITIONS = [
  // --- 开单 ---------------------------------------------------------------
  { from: '(new)', event: 'open', to: ST.PENDING, by: ['main'], note: '主对话开单，登记原始需求' },
  { from: ST.PENDING, event: 'dispatch_orchestrator', to: ST.ANALYZING, by: ['main'], guard: 'hub_initiate_required', note: '主对话派出需求分析（第 1 轮：出任务卡 + 不清楚处清单）；★ 名单里登记了主管席位（或主对话已把本单递给主管）时这条路被拒 —— 必须由主管发起' },
  // ★★ P0-1 **入口**：主对话把任务**递给**主管（用户新口径第 1 跳）。
  //
  //   用户原话：「**主对话agent递给主管agent**，主管拉起需求agent、计划agent、架构agent…」
  //   修之前的病灶（实测原文）：`pipeline_supervise{action:'initiate'}` 的工具-角色白名单
  //   只有 supervisor，而 supervisor **在任何阶段都派不出来**（名单为空时引导步只放开
  //   需求分析）⇒ 新单上枢纽**永远启动不了**。
  //
  //   修法（二选一里取 (a)，理由见 README/报告）：**不**给 `supervisor_initiate` 加 main
  //   （那会破坏「主管的具名动作不是 main 的工具」这条既有判据），而是给主对话一条
  //   **自己的、只在流程最初那一刻有效**的边界事件：它只做一件事 —— 登记「谁把单递给了主管」，
  //   并把本单交给主管发起。发起仍然是主管的动作（`supervisor_initiate`）。
  //
  //   ★ 它是**自环**（pending → pending）：递单本身**不推进流程**（用户原话里推进流程的是
  //     "主管拉起三席"，不是"递单"这个动作）。状态不变的边在表上是有先例的
  //     （`human_request` 那条 `from:'*'` 的 blocking 语义、以及 `submitHandoff` 里
  //     "目标状态与当前状态相同 ⇒ 不做这次迁移"那条通用规则）。
  { from: ST.PENDING, event: 'handoff_to_supervisor', to: ST.PENDING, by: ['main'], guard: 'main_handoff_to_supervisor', note: '★ 主对话把任务递给主管（**唯一入口**；只在流程最初那一刻：待分配 + 尚无角色清单 + 尚无任何交接物）—— 只登记"谁递的"，发起仍由主管做' },
  // ⚠️ 本轮把 `analyzing → ready_dev` **删掉了**：需求分析不再产出角色清单，
  //    它交的是「需求分析结论 + 需求不清楚处清单」。那条边现在从 `planning` 出发。
  // L0 没有独立的需求分析与计划对话，两件事都由确定性规则引擎承担 ——
  // 所以保留一条从待分配直达待开发的边（actorRole 是 'rule-engine'）。
  { from: ST.PENDING, event: 'orchestrated', to: ST.READY_DEV, by: ['planner', 'rule-engine'], note: 'L0：规则引擎自批，跳过独立的需求分析与计划' },

  // --- ★需求确认（澄清前置到人工）------------------------------------------
  //
  // 用户拍板：需求分析第 1 轮分析后，**必须**把「不清楚的地方」提交主对话 →
  // 主对话交**用户人工确认** → 确认后才递交 planner。
  //
  // 落地方式（为什么不新开状态）：这一段的机制与既有 `human_request` 链**完全同构** ——
  //   角色提交结构化请求 → 主对话转告 → 用户答复 → 回到被打断的那个状态。
  //   唯一不同的是"问的是什么"（需求确认 vs 别的），而那件事由
  //   `reason_kind = requirement_confirmation` 这一个**数据字段**回答就够了。
  //   单开一个状态只会制造第二套并行的人工通道 —— 而拓扑上用户只与主对话相连，
  //   通道本来就只有一条。
  // 判据落在 guard `requirement_confirm_gate` 上：**没有用户答复原文，这条边过不去**。
  { from: ST.ANALYZING, event: 'requirement_confirmed', to: ST.READY_PLAN, by: ['main'], guard: 'requirement_confirm_gate', note: '★ 需求分析完毕 + 用户确认过 ⇒ 才允许进计划' },
  // 用户不认可分析结果时的回路：重新做需求分析（要求带上用户的答复）。
  { from: ST.READY_PLAN, event: 'dispatch_orchestrator', to: ST.ANALYZING, by: ['main'], note: '用户不认可 / 需求变了 ⇒ 退回需求分析重做' },

  // --- ★计划与分配（planner）----------------------------------------------
  { from: ST.READY_PLAN, event: 'dispatch_planner', to: ST.PLANNING, by: ['main'], note: '主对话派活给计划 AI' },
  { from: ST.PLANNING, event: 'planned', to: ST.READY_DEV, by: ['planner'], guard: 'plan_ready', note: '★ 计划自检通过 + 角色清单产出（分配 AI 是 planner 的活）' },
  // ★ 计划缺失回流：planner 自检发现缺口 ⇒ 退回需求分析（第一级澄清梯）。
  //   它复用**同一部**梯：planner 交一份带 self_check.verdict=gaps 的 plan 交接物，
  //   状态推到「等待需求分析答复」；需求分析答得了就答（answered，原地恢复），
  //   答不了就走既有的升级路径（clarification_reply cannot_answer → human_request）。
  //   —— 刻意**不**另起一套"计划问题专用通道"：那会让"用户到底在等谁"再次说不清。
  { from: ST.PLANNING, event: 'plan_gap', to: ST.AWAITING_CLARIFICATION, by: ['planner'], guard: 'plan_gap_gate', note: '★ 计划缺失回流：退回需求分析（沿用第一级澄清梯）' },

  // --- ★★主管枢纽（T-20261011-56a37e）：发起面 / 两席待机 / 两个唤醒点 / 架构图前置 --
  //
  //   ★ 这一段的**形状**本身就是判据：从 `analyzing` **不存在**直达 `planning` 的边
  //     ⇒「先出计划、后出架构图」在表上无路可走（验收 1/2 的判据落点）。
  //   ★ `by` 名单**只含 supervisor**（发起与确认两处都是），main 代发会被
  //     `applyTransition` 的 by 名单直接拒掉 —— 这就是"越权发起被拒"的第一道判据，
  //     第二道在守门的工具-角色表（`pipeline_supervise: ['supervisor']`）。
  //   ★ 每一跳都挂 guard：守卫开关在 store.checkPrecondition 里，与既有站点**同一套**。
  { from: ST.PENDING, event: 'supervisor_initiate', to: ST.ANALYZING, by: [ROLE.SUPERVISOR], guard: 'hub_initiate', note: '★ 主管发起需求位（同时把计划位与架构位登记为「已登记待机」）' },
  { from: ST.ANALYZING, event: 'need_to_supervisor', to: ST.SUPERVISING, by: [ROLE.ORCHESTRATOR], guard: 'hub_analysis_ready', note: '★ 需求结论交主管（状态落到「主管受理中」，等第①道确认）' },
  { from: ST.SUPERVISING, event: 'supervisor_agree_need', to: ST.ARCH_DRAWING, by: [ROLE.SUPERVISOR], guard: 'hub_station_need_agree', note: '★ 第①道确认（主管同意需求结论）＋ **唤醒点 A**：架构位到点开工' },
  { from: ST.ARCH_DRAWING, event: 'diagram_submitted', to: ST.ARCH_CONFIRM, by: [ROLE.DIAGRAMMER], guard: 'hub_diagram_ready', note: '★ 架构图产出 ⇒ 落到「架构图待主管确认」（第②道）' },
  { from: ST.ARCH_CONFIRM, event: 'supervisor_confirm_diagram', to: ST.ARCH_NEED_CONFIRM, by: [ROLE.SUPERVISOR], guard: 'hub_station_diagram_confirm', note: '★ 第②道确认（主管确认架构图满足要求）⇒ **转交需求位**（用户新口径第 6~7 跳：「主管agent转交需求agent」）' },
  //   ★★ P0-1 **补确认环**：用户新口径第 8 跳的两个确认点（插在「架构图完成」与「交计划」之间）。
  //
  //     用户原话：「…主管agent转交需求agent，**需求agent确认后**递交主管agent**二次确认**，
  //       **无问题后**将架构agent**递交计划agent**…」
  //
  //     ★ 与既有站点**同构**（没有第二套机制）：
  //       · 同样的事件形状：一条 `TRANSITIONS` 表项 + 一个 `guard` 名；
  //       · 同一个守卫开关：`store.checkPrecondition`（判据体是**同一个** `hubStationGate`）；
  //       · 同一份留痕：`station_confirm` 交接物 + `audit.jsonl` 的 `transition:<事件名>`；
  //       · 同一套预算读法：`hub.station_rejects[station]`（P0-1 只补"确认"两个点，
  //         **不新增"否掉"回边** —— 否掉的既有四条回边一个字节没动）。
  //     ★ 顺序即判据：需求位确认（本站）之后的下一站**才是**主管二次确认 ——
  //       表上不存在 `arch_confirm → standby_plan` 的近路，所以"主管一次点头就交计划"
  //       在新口径下**无路可走**。
  { from: ST.ARCH_NEED_CONFIRM, event: HUB_HANDOFF_CONFIRM_EVENTS[HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM], to: ST.ARCH_RECONFIRM, by: [ROLE.ORCHESTRATOR], guard: 'hub_station_arch_need_confirm', note: '★ **需求位确认架构图** ⇒ 递交主管二次确认（用户新口径第 8 跳前半；需求位交一份 station_confirm{station:arch_need_confirm} 即推进）' },
  { from: ST.ARCH_RECONFIRM, event: HUB_HANDOFF_CONFIRM_EVENTS[HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM], to: ST.STANDBY_PLAN, by: [ROLE.SUPERVISOR], guard: 'hub_station_arch_reconfirm', note: '★ **主管二次确认** ＋ **唤醒点 B**：无问题后才把架构图交给计划位（用户新口径第 8 跳后半 ~ 第 9 跳）' },
  { from: ST.ARCH_CONFIRM, event: 'supervisor_reject_diagram', to: ST.ARCH_DRAWING, by: [ROLE.SUPERVISOR], guard: 'hub_diagram_rework_budget', note: '★ 架构图不满足 ⇒ 让架构位重画（**限 1 次**；再不行走升级人工）' },
  //   ★★ **否掉的另外三条回边**（T-20261011-56a37e 补齐：用户原话的下半条分支）。
  //
  //   为什么补：用户原话是「**如果同意**…**如果否掉**…」—— 两条分支都要有。
  //   此前 ② 道有回边（上面那条），而 ①③④ 三道**没有**：
  //   状态机上从 `supervising` / `ready_review` / `passed` 各只有**一条**出边，
  //   且那条都要求"确认方点头" ⇒ 主管在那三站说"不满足"时**无路可走**，
  //   只剩 `block` / `cancel`（那两条不是"退回重做"，是把整单停下来）。
  //
  //   ★ 一条统一的规则（不是三处各拍一次脑袋）：**否掉 = 退回"被确认的那份产物的产出方"**。
  //     · ①道确认的是「需求结论」（需求位产出）⇒ 退回需求位 ⇒ `analyzing`
  //     · ③道确认的是「测试结论」（测试位产出）⇒ 退回测试位 ⇒ `returned_to_test`
  //     · ④道确认的是「审核结论」（审核位产出）⇒ 退回审核位 ⇒ `reviewing`
  //     这与 ② 道（确认的是架构图，架构位产出 ⇒ 退回 `arch_drawing`）**同构**。
  //
  //   ★ 三张形状全部与 ② 道逐项对齐：同一个 `by: [ROLE.SUPERVISOR]`（不许 main 代发）、
  //     同一个守卫开关（`store.checkPrecondition`）、同一枚判据（`hub_station_reject`）、
  //     同一份审计（`audit.jsonl` 的 `transition:<事件名>`）、同一套预算（限 1 次 ⇒ 升人工）。
  //   ★ 事件的**具体事件名**取自 `HUB_STATION_REJECT_EVENTS`（一处定义，三处消费）。
  {
    from: ST.SUPERVISING,
    event: HUB_STATION_REJECT_EVENTS[HUB_STATIONS.NEED_AGREE],
    to: ST.ANALYZING,
    by: [ROLE.SUPERVISOR],
    guard: 'hub_station_reject',
    note: '★ 第①道否掉（主管不同意需求结论）⇒ 退回需求位重做分析（**限 1 次**；再不行走升级人工）',
  },
  {
    from: ST.READY_REVIEW,
    event: HUB_STATION_REJECT_EVENTS[HUB_STATIONS.TEST_CONFIRM],
    to: ST.RETURNED_TO_TEST,
    by: [ROLE.SUPERVISOR],
    guard: 'hub_station_reject',
    note: '★ 第③道否掉（不认可测试结论）⇒ 退回测试位重跑（**限 1 次**；再不行走升级人工）',
  },
  {
    from: ST.PASSED,
    event: HUB_STATION_REJECT_EVENTS[HUB_STATIONS.REVIEW_CONFIRM],
    to: ST.REVIEWING,
    by: [ROLE.SUPERVISOR],
    guard: 'hub_station_reject',
    note: '★ 第④道否掉（不认可审核结论）⇒ 退回审核位重审（**限 1 次**；再不行走升级人工）',
  },
  { from: ST.STANDBY_PLAN, event: 'dispatch_planner', to: ST.PLANNING, by: ['main'], guard: 'hub_plan_woken', note: '★ 唤醒点 B 之后的计划位派活（未到唤醒点这条边过不去）' },

  // --- 开发 ---------------------------------------------------------------
  { from: ST.READY_DEV, event: 'dispatch_writer', to: ST.DEVELOPING, by: ['main'], note: '主对话派活给编写' },
  { from: ST.DEVELOPING, event: 'dev_submitted', to: ST.READY_TEST, by: ['writer'], guard: 'dev_to_test', note: '★ 编写交测试（唯一出口）' },
  // ★ P1-3 / P1-13 的代发半边（A 路报告 §6.3 方案 A1）：编写席位交完最后一份交付就结束回合、
  //   不发上面那一步时，由主对话代按出口。**另起一个事件**而不是把 main 加进上面那条的 by：
  //   守卫与那条完全同源（全部席位到齐、哈希闸门、改动面……一个都不少），
  //   审计里 actor 记 main、事件名也不同 ⇒ 事后分得清"席位自己发的"与"主对话代发的"。
  { from: ST.DEVELOPING, event: 'main_dev_submitted', to: ST.READY_TEST, by: ['main'], guard: 'dev_to_test', note: '★ 主对话代发「编写交测试」（守卫与 dev_submitted 同源）' },
  // ⚠️ 这一条**刻意不挂** rework_budget：
  //    预算在「打回」那一刻就已经扣过了。如果这里再扣一次，就会出现
  //    "第 2 次打回成功 → 但再也派不出编写 → 任务永久卡在已打回编写"的死结。
  //    （第一版就是这样，自测把死结照出来了。）预算的判据只在三个地方：
  //    ① test_failed / review_ng_* 打回时；② review_verdict(NG) 提交时；③ NG 交接物落盘前。
  { from: ST.RETURNED_TO_DEV, event: 'dispatch_writer', to: ST.DEVELOPING, by: ['main'], note: '打回后重新派活（预算已在打回时扣过）' },

  // --- 测试 ---------------------------------------------------------------
  { from: ST.READY_TEST, event: 'dispatch_tester', to: ST.TESTING, by: ['main'], note: '主对话派活给测试' },
  { from: ST.TESTING, event: 'test_passed', to: ST.READY_REVIEW, by: ['tester'], guard: 'test_to_review', note: '★ 测试交审核（唯一入口）' },
  { from: ST.TESTING, event: 'test_failed', to: ST.RETURNED_TO_DEV, by: ['tester'], guard: 'rework_budget', note: '测试不通过 → 打回编写' },
  // 同 dispatch_writer：预算已在打回时扣过，这里不再扣（否则同样会死结）。
  { from: ST.RETURNED_TO_TEST, event: 'dispatch_tester', to: ST.TESTING, by: ['main'], note: '打回后重新派活（预算已在打回时扣过）' },

  // --- 审核 ---------------------------------------------------------------
  //
  // ★ T-20261011-56a37e：第③道站点（测试通过 → **主管+需求位**双确认）挂在这一条上。
  //   为什么挂这里而不是新开一个状态：用户要的是「测试无问题后提交给主管和需求ai确认
  //   → 无问题后交给审核」—— 也就是**审核开工之前**必须双确认齐备。
  //   挂在"派审核"这一跳上，形态与既有站点完全一致（同一个守卫开关、同一张 by 名单），
  //   而既有的 `test_passed → ready_review` 一个字没动（既有反例全量不受影响）。
  //   ★ 该 guard 对**未启用枢纽**的任务是弃权的（`hub_enabled === false` ⇒ 直接通过），
  //     所以它是**扩展**而不是放宽：既有任务的闸门强度一个字节没减。
  { from: ST.READY_REVIEW, event: 'dispatch_reviewer', to: ST.REVIEWING, by: ['main'], guard: 'dispatch_reviewer_gate', note: '主对话派活给审核（枢纽任务：须先过第③道双确认）' },
  { from: ST.REVIEWING, event: 'review_ok', to: ST.PASSED, by: ['reviewer'], guard: 'review_verdict_ok', note: '★ 审核发 OK（唯一入口）' },
  { from: ST.REVIEWING, event: 'review_ng_dev', to: ST.RETURNED_TO_DEV, by: ['reviewer', 'security'], guard: 'rework_budget', note: '审核不通过 → 打回编写' },
  { from: ST.REVIEWING, event: 'review_ng_test', to: ST.RETURNED_TO_TEST, by: ['reviewer'], guard: 'rework_budget', note: '审核不通过 → 打回测试' },

  // --- 关单 ---------------------------------------------------------------
  { from: ST.PASSED, event: 'close', to: ST.CLOSED, by: ['main'], guard: 'close_gates', note: '★ 主对话关单（必须已有审核 OK；角色清单含架构图角色时还必须有针对当前版本的架构图）' },
  // --- ★两级升级梯：第一级（问需求分析）----------------------------------
  //
  // 执行/顾问角色遇到确定不了的事，**先**走这一级，不要一步就去找用户。
  //   ① 提问：角色 → orchestrator，状态推到「等待需求分析答复」
  //   ② 答复：orchestrator 给结论（answered）→ 回到被打断前的状态，原角色继续
  //            orchestrator 答不了（cannot_answer）→ 它再走下面的 human_request 升级到用户
  { from: '*', event: 'clarification_request', to: ST.AWAITING_CLARIFICATION, by: ROLES_CAN_ASK_CLARIFICATION, guard: 'clarification_blocking', note: '★ 第一级：角色向需求分析提问（blocking 时才推状态）' },
  { from: ST.AWAITING_CLARIFICATION, event: 'clarification_reply', to: '(previous)', by: ['orchestrator'], guard: 'clarification_reply_ok', note: '★ 需求分析答复后恢复：回到被打断前的状态' },

  // --- ★人工介入（用户只与主对话相连，所以这是**唯一**的上升通道）-----------
  //
  // 发起：执行/顾问角色（**不含 main**）提交一份 `human_request` 交接物。
  //       `blocking:true` 时状态推到「等待人工答复」并存下被打断前的状态。
  // 转告：主对话调 pipeline_human_relay —— **不改状态**，只留痕（第 2 步）。
  // 答复：主对话调 pipeline_human_reply —— 必须带用户答复的来源与本人原话（第 3 步）。
  // 恢复：同一次调用里触发 `human_reply`，**回到被打断前的状态**（第 4 步）。
  //       为什么回到被打断前的状态、而不是"发起角色对应的阶段"：
  //       发起者当时正在那个状态里干活，问题解决了就该**原地继续**；
  //       按角色反推阶段会把「测试中提问、答完回到测试中」变成"回到待测试"，
  //       那样主对话得重新派一次活，凭空多一次状态往返。
  { from: '*', event: 'human_request', to: ST.AWAITING_HUMAN, by: ROLES_CAN_RAISE_HUMAN, guard: 'human_request_blocking', note: '★ 角色向上发起人工介入（blocking 时才推状态）' },
  { from: ST.AWAITING_HUMAN, event: 'human_reply', to: '(previous)', by: ['main'], guard: 'human_reply_has_source', note: '★ 用户答复后恢复：回到被打断前的状态' },

  // --- 异常出口（人工）-----------------------------------------------------
  { from: '*', event: 'block', to: ST.BLOCKED, by: ['main', 'human'], note: '任意非终态可阻塞' },
  { from: ST.BLOCKED, event: 'unblock', to: '(previous)', by: ['main', 'human'], note: '解除阻塞，回到阻塞前的状态' },
  { from: '*', event: 'cancel', to: ST.CANCELLED, by: ['main', 'human'], note: '任意非终态可取消' },

  // --- ★★ P4 接线 / P1-7 定名：DEMO 阶段的四条边（定义在 `lib/states/demo-phase.js`，本表只做合并）----
  //
  //   P1-7（设计档 `04-demo与制品模型.md` §1）：
  //     planning ──demo_started──▶ demo_building ──demo_submitted──▶ demo_review
  //                                       ▲                                │
  //                                       └──────demo_rework───────────────┤
  //                                       ready_dev ◀──demo_passed─────────┘
  //
  //   ★ 为什么要**在这里**合并：`applyTransition()` 只认本表里登记过的 `(from, event)` ——
  //     表里没有 `demo_review`，`demo_review → ready_dev` 这条边走不通，DEMO 阶段等于不存在。
  //   ★ `demo_passed` 那条边挂的闸门名仍是 **`demo_confirmed`**（判据升级、名字不变）——
  //     判据体在 `lib/guard/demo-gate.js`，由 `lib/store/precondition.js` 转发。
  //   ★ 走不走这两条边由**档位策略**决定：`store.setRoster()` 用
  //     `demoStageRequiredFor()`（`lib/states/demo-phase.js`）在 planning 那一跳选事件 ——
  //     L3+ require 走 `demo_started`；L0–L2（含 L2 未选择出 DEMO）仍走 `planned`。
  ...demoPhaseMerge({ ST, ROLE }).transitions,

  // --- ★ 旧单兼容：P4 期间用**旧名**（`demo_confirm` / `demo_confirmed`）走过的边 ----
  //
  //   任务书原文：「旧单（已到 ready_dev 及之后）不因缺新状态而红」—— 迁移判据只对
  //   **从 planning 出发**的那条边生效。这里保留两条旧名边，让**旧状态**上的单也能继续走完：
  //   · 旧 `demo_confirm --demo_confirmed--> ready_dev`（闸门仍是同一个，判据自动兼容旧数据）；
  //   · 旧 `demo_confirm --demo_rework--> demo_building`（重做回新状态）。
  //   ★ 新流程不会进入 `demo_confirm`（`demoPhaseMerge` 的 states 里没有它）。
  {
    from: DEMO_ST.LEGACY_CONFIRM,
    event: DEMO_EVENTS.LEGACY_CONFIRM,
    to: ST.READY_DEV,
    by: ['main'],
    guard: 'demo_confirmed',
    note: '★ 旧单兼容（P4 旧状态名 demo_confirm / 旧事件名 demo_confirmed）：判据与 `demo_passed` 同一个闸门。',
  },
  {
    from: DEMO_ST.LEGACY_CONFIRM,
    event: DEMO_EVENTS.REWORK,
    to: DEMO_ST.BUILDING,
    by: ['main'],
    guard: 'demo_round_ok',
    note: '★ 旧单兼容：旧状态 `demo_confirm` 上用户要求重做 ⇒ 回到 `demo_building`（之后走新流程）。',
  },
]

/** 状态 → 该状态下"轮到的角色"（用于催办与守门）。 */
export const STATE_OWNER = {
  [ST.PENDING]: 'main',
  [ST.ANALYZING]: 'orchestrator',
  [ST.READY_PLAN]: 'main',
  [ST.PLANNING]: 'planner',
  [ST.SUPERVISING]: ROLE.SUPERVISOR,
  [ST.ARCH_DRAWING]: ROLE.ARCHITECT,
  [ST.ARCH_CONFIRM]: ROLE.SUPERVISOR,
  /** ★ P0-1：架构图转交需求位之后，轮到的是**需求位**（催办要说得出催谁）。 */
  [ST.ARCH_NEED_CONFIRM]: 'orchestrator',
  [ST.ARCH_RECONFIRM]: ROLE.SUPERVISOR,
  [ST.STANDBY_PLAN]: 'main',
  [ST.READY_DEV]: 'main',
  [ST.DEVELOPING]: 'writer',
  [ST.READY_TEST]: 'main',
  [ST.TESTING]: 'tester',
  [ST.READY_REVIEW]: 'main',
  [ST.REVIEWING]: 'reviewer',
  [ST.PASSED]: 'main',
  [ST.CLOSED]: null,
  [ST.RETURNED_TO_DEV]: 'main',
  [ST.RETURNED_TO_TEST]: 'main',
  [ST.AWAITING_CLARIFICATION]: 'orchestrator',
  [ST.AWAITING_HUMAN]: 'main',
  [ST.BLOCKED]: 'human',
  [ST.CANCELLED]: null,
  /**
   * ★★ DEMO 两个状态的 owner（P4 接线补齐；P1-7 起状态名为 `demo_building` / `demo_review`）。
   *
   * 不补的后果是**可执行的**：`STATE_OWNER` 恒等于"全部状态 ⇒ 谁"这张表，
   * 缺一个键就答不出"这一步该催谁"（`deliver.js` 取到 `undefined ?? null`，
   * 就成了"没人可催"）。两个状态各有明确的人可催，所以**不是** `null`：
   *   · `demo_building` ⇒ 编写席（DEMO 还在做）；`demo_review` ⇒ 主对话（等用户点头）。
   *   · 旧名 `demo_confirm` 也保留了条目（旧单兼容；见 `demoStateOwners`）。
   * ★ 与 `TRANSITIONS` 同一条纪律：条目来自 `states/demo-phase.js`，本文件不手抄角色 id。
   */
  ...demoStateOwners({ ROLE }),
}

/**
 * 查一条转移。
 *
 * @param {string} from - 当前状态（开单时传 '(new)'）
 * @param {string} event
 * @returns {object|null}
 */
export function findTransition(from, event) {
  for (const t of TRANSITIONS) {
    if ((t.from === from || t.from === '*') && t.event === event) return t
  }
  return null
}

/**
 * 该状态下所有合法的下一步（给"主对话下一步该干嘛"用）。
 *
 * @param {string} from
 * @returns {object[]}
 */
export function availableTransitions(from) {
  const out = []
  for (const t of TRANSITIONS) {
    if (t.from !== from && t.from !== '*') continue
    // 终态不再接受任何转移（block/cancel 的 '*' 也不适用）。
    if (TERMINAL_STATES.includes(from)) continue
    out.push(t)
  }
  return out
}

/**
 * 人话版的"为什么这个动作被拒"。
 *
 * @param {string} from
 * @param {string} event
 * @returns {string}
 */
export function explainRefusal(from, event) {
  const label = (s) => `${STATE_LABEL[s] ?? s}(${s})`
  const next = availableTransitions(from)
    .map((t) => `${t.event}→${label(t.to)}（${t.by.join('/')}）`)
    .join('；')
  if (TERMINAL_STATES.includes(from)) {
    return `状态「${label(from)}」是终态，不再接受任何转移。`
  }
  return `状态「${label(from)}」不接受事件「${event}」。当前合法事件：${next.length > 0 ? next : '（无）'}。`
}

/**
 * 应用一次转移。
 *
 * @param {string} from
 * @param {string} event
 * @param {string} actorRole
 * @param {string} [previousState] - blocked 回退用
 * @returns {{ok:true, to:string, transition:object} | {ok:false, error:string}}
 */
export function applyTransition(from, event, actorRole, previousState) {
  const t = findTransition(from, event)
  if (t === null) return { ok: false, error: explainRefusal(from, event) }
  if (TERMINAL_STATES.includes(from)) return { ok: false, error: explainRefusal(from, event) }
  if (!t.by.includes(actorRole)) {
    return {
      ok: false,
      error: `事件「${event}」只允许角色 ${t.by.join('/')} 触发，当前调用方是「${actorRole}」。`,
    }
  }
  let to = t.to
  if (to === '(previous)') {
    if (typeof previousState !== 'string' || previousState.length === 0) {
      return { ok: false, error: '解除阻塞失败：没有记录阻塞前的状态，无法回退。' }
    }
    to = previousState
  }
  return { ok: true, to, transition: t }
}

// ===========================================================================
// ★ 本轮新增：`unblock` 的**恢复点**（修「重复 block 覆盖恢复点 ⇒ unblock 空转」）
// ===========================================================================

/**
 * ★ 一个**可用**的恢复点长什么样。
 *
 * 五条同时成立才算数（缺一条就按"账本被写坏"处理，回落 + 留痕）：
 *   ① 非空串；② 是已知状态；③ **不是 `blocked`**；④ 不是终态；⑤ 不是等待态。
 *
 * ③ 就是这次事故的形状本身：`block` 是 `{ from:'*' }`，重复触发时 `from` 已经是
 *    `blocked`，早先那条判据（"`from` 不是等待态就记")把它记成了恢复点。
 * ④ 终态回不去（`applyTransition` 本来也不从终态出发）—— 账本上出现终态说明被写坏。
 * ⑤ 本模块自己的不变量是「**等待态不记进 `previous_state`**」（见文件头），
 *    所以账本上出现等待态同样说明被写坏，硬回去只会把任务卡在"等谁回话"上。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function isUsableRecoveryPoint(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    Object.prototype.hasOwnProperty.call(STATE_LABEL, s) &&
    s !== ST.BLOCKED &&
    !TERMINAL_STATES.includes(s) &&
    !WAITING_STATES.includes(s)
  )
}

/**
 * ★ **`unblock` 该回到哪个状态** —— 恢复点可用就用它，不可用就**回落**到一个
 *   明确的合法状态。
 *
 * -----------------------------------------------------------------------------
 * 为什么需要它（真单 T-20261011-5a871c 实测）
 * -----------------------------------------------------------------------------
 * 现场：主对话对同一张单 `block` 了两次。第二次 `from === 'blocked'`，
 * 而记恢复点那条判据只问"`from` 是不是等待态" —— 对 `blocked` 照样成立
 * ⇒ **恢复点被覆盖成 `blocked` 自己**。之后 `unblock` 回退到 `blocked`，
 * 变成**空操作**：连调两次，回执都是「已阻塞 → 已阻塞」（audit 里两条都在），
 * 而状态页上写的是「解除阻塞，回到阻塞前的状态」—— 说明与行为对不上。
 *
 * 所以判定要从"**有没有记过**"改成"**记的这个还能不能用**"：
 *   · 能用 ⇒ 原样返回（`fallback:false`，正常的回退路径，一个字没变）；
 *   · 不能用 ⇒ 按**该任务自己的进度**回落，并给出原因（调用方写进 audit）。
 *
 * 回落的判据只用任务上**已有**的字段（不新造事实来源）：
 *   · 编写这一站**开过工**（有制品登记 / 有席位提交 / history 里落过"开发中"
 *     或派过编写席）⇒ 回落到 **`developing`（开发中）**；
 *   · 否则 ⇒ 回落到 **`ready_dev`（待开发）**。
 *
 * 两个落点都是**非终态**，本函数**永远不会**返回 `cancelled` / `closed` ——
 * 「不许动终态」这条是硬约束。
 *
 * @param {object} task
 * @returns {{ok:true, state:string, fallback:boolean, reason:string}
 *          | {ok:false, error:string}}
 */
export function resolveUnblockRecovery(task) {
  const raw = typeof task?.previous_state === 'string' ? task.previous_state.trim() : ''
  if (isUsableRecoveryPoint(raw)) return { ok: true, state: raw, fallback: false, reason: '' }
  if (task === null || typeof task !== 'object') {
    return { ok: false, error: '解除阻塞失败：拿不到任务对象，无法判定恢复点。' }
  }

  // --- 恢复点不可用 ⇒ 按任务进度回落 --------------------------------------
  const hist = Array.isArray(task.history) ? task.history : []
  const submissions =
    typeof task.writer_submissions === 'object' && task.writer_submissions !== null
      ? Object.keys(task.writer_submissions).length
      : 0
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts.length : 0
  const devStarted =
    submissions > 0 ||
    artifacts > 0 ||
    hist.some((h) => h?.to === ST.DEVELOPING || h?.action === 'transition:dispatch_writer')
  const state = devStarted ? ST.DEVELOPING : ST.READY_DEV

  const why =
    raw.length === 0
      ? '缺失'
      : raw === ST.BLOCKED
        ? '等于 blocked（重复 block 覆盖恢复点那次缺陷留下的形状）'
        : TERMINAL_STATES.includes(raw)
          ? `是终态 ${raw}`
          : WAITING_STATES.includes(raw)
            ? `是等待态 ${raw}（按本模块不变量，等待态不该被记成恢复点）`
            : `不是已知状态（${raw}）`

  return {
    ok: true,
    state,
    fallback: true,
    reason:
      `解除阻塞：恢复点不可用（${why}）⇒ 按任务进度回落。` +
      `本任务${devStarted ? `已经开过工（制品 ${artifacts} 份 / 席位提交 ${submissions} 份 / history 里落过开发中）` : '还没有编写开工的证据'} ⇒ ` +
      `回到「${STATE_LABEL[state]}(${state})」。`,
  }
}
