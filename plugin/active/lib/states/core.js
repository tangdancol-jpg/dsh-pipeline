/**
 * dsh-pipeline · 任务状态机 · 核心状态常量
 * ============================================================================
 * 从 lib/states.js 机械拆出（纯搬家，行为逐字未变）：
 * 状态 id、等待态与终态、状态中文名、可提问与可上报的角色名单。
 * 对外入口仍是 lib/states.js（barrel）。
 *
 * @module dsh-pipeline/lib/states/core
 */

import { ROLE } from '../roles.js'
import { DEMO_ST, DEMO_STATE_LABEL } from './demo-phase.js'

/** 状态 id。 */
export const ST = {
  PENDING: 'pending',
  ANALYZING: 'analyzing',
  /**
   * ★「待计划」：需求分析完毕、**用户也确认过**了，轮到场次安排。
   *
   * 为什么不并进 `ready_dev`：这两站回答的是不同问题 ——
   *   · `ready_plan` = 活儿还没切（谁写哪一层、要几个 AI，都还没定）
   *   · `ready_dev`  = 活儿已经切好、名单已定，只等派出去
   * 并起来之后"任务卡有了但没有角色清单"会变成一个说不清的中间态，
   * 而主对话最需要知道的恰好是"我现在该催计划还是该催编写"。
   */
  READY_PLAN: 'ready_plan',
  /** ★「计划中」：planner 在出计划、自检、分配 AI。 */
  PLANNING: 'planning',
  /**
   * ★★「主管受理中」—— 主管枢纽的第 1 站（T-20261011-56a37e 新增）。
   *
   * 它回答的问题与 `analyzing` 不同：
   *   · `analyzing`    = 需求位**还在分析**（结论还没交上来）
   *   · `supervising`  = 需求结论**已经交上来了**，正等**主管同意**（五道确认的第①道）
   *
   * 为什么要单开而不是并进 `analyzing`：并起来之后"需求位还没写完"与
   * "写完了但主管还没点头"是同一个状态，而这两件事的**下一步动作**完全不同
   * （前者催需求位，后者催主管）—— 主对话最需要知道的恰好是这个区别。
   */
  SUPERVISING: 'supervising',
  /**
   * ★★「架构位出图中」—— 架构图**前置于计划**的落点（唤醒点 A 之后）。
   *
   * 处在这里意味着：主管已同意需求结论 ⇒ 架构位（architect / diagrammer）被唤醒，
   * 正在出架构图。**计划位不在这个状态里**（它还在待机，见 `standby_plan`）。
   * 这就是「架构图先于计划」在状态机上的形状 —— 表上不存在从 `analyzing`
   * 直接到 `planning` 的边，所以"先出计划、后出架构图"**没有合法路径**。
   */
  ARCH_DRAWING: 'arch_drawing',
  /** ★★「架构图待主管确认」—— 五道确认的第②道（架构图出来后等主管点头）。 */
  ARCH_CONFIRM: 'arch_confirm',
  /**
   * ★★「架构图待需求位确认」—— **用户新口径第 7 跳**（P0-1）。
   *
   * 用户原话：「架构agent完成后发给主管agent，**主管agent转交需求agent**，
   *   **需求agent确认后**递交主管agent二次确认，无问题后将架构agent递交计划agent」。
   *
   * 为什么单开一站而不是并进 `arch_confirm`：并起来之后"主管还没判"与
   *   "主管判过了、等需求位确认"是同一个状态 —— 而这两件事的**下一步动作**完全不同
   *   （前者催主管，后者催需求位）。主对话最需要知道的恰好是这个区别。
   */
  ARCH_NEED_CONFIRM: 'arch_need_confirm',
  /**
   * ★★「架构图待主管二次确认」—— **用户新口径第 8 跳后半**（P0-1）。
   *
   * 它回答的是：「**需求位确认之后**再去问主管一次」—— 与第②道（首次确认）
   *   是两个不同的确认点，绑定的是**同一份架构图**、但确认方与依据不同
   *   （第②道：主管看架构图本身；本站：主管看**需求位的确认结论**）。
   */
  ARCH_RECONFIRM: 'arch_reconfirm',
  /** ★★「计划位已唤醒待派」—— 唤醒点 B 之后：架构图已被主管**二次确认**，才轮到计划位。 */
  STANDBY_PLAN: 'standby_plan',
  READY_DEV: 'ready_dev',
  DEVELOPING: 'developing',
  READY_TEST: 'ready_test',
  TESTING: 'testing',
  READY_REVIEW: 'ready_review',
  REVIEWING: 'reviewing',
  PASSED: 'passed',
  CLOSED: 'closed',
  RETURNED_TO_DEV: 'returned_to_dev',
  RETURNED_TO_TEST: 'returned_to_test',
  /**
   * ★「等待人工答复」。
   *
   * 为什么不复用 `blocked` 而单开一个状态：`blocked` 是**主对话/人工主动叫停**，
   * 而这里是**执行角色向上发起请求、主对话转告、等用户回话**。
   * 两者要回答的问题不同（"谁叫停的" vs "卡在等谁回话"），
   * 而在本插件的拓扑里后者是**唯一合法的人工上升通道** ——
   * 用户只与主对话相连，执行角色没有用户的对话框。
   * 合成一个状态就没法机械回答"这个任务在等谁"。
   */
  /**
   * ★「等待需求分析答复」。
   *
   * 为什么**不复用** `awaiting_human`：这两个状态回答的是**不同的问题** ——
   *   · `awaiting_clarification` = 卡在**内部**某一级（等编排判断回话），用户不该被打扰
   *   · `awaiting_human`         = 卡在**用户**那一级，谁都得等
   * 合成一个之后，"这个任务到底在等谁"就答不出来了 —— 而那正是主对话最需要知道的事
   * （它要不要去催用户？还是根本不用惊动用户？）。
   *
   * 两者都属于「等待态」（见 WAITING_STATES）：进入等待态**不覆盖** `previous_state`，
   * 这样 提问 → 升级 → 用户答复 这条链恢复时仍然能回到**最初被打断的那个工作状态**。
   */
  AWAITING_CLARIFICATION: 'awaiting_clarification',
  AWAITING_HUMAN: 'awaiting_human',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  /**
   * ★★ DEMO 阶段（P4 接线）：复杂任务先出**可操作前端 DEMO**，**用户确认后**才继续后端。
   * ★ 为什么不直接并进 `ready_dev`：`ready_dev` 是"活已切好、只等派"，而这里是
   *   "DEMO 还在做 / 等用户点头" —— **下一步该催谁**完全不同（催做 DEMO 的人 vs 催用户）。
   */
  DEMO_BUILDING: DEMO_ST.BUILDING,
  DEMO_CONFIRM: DEMO_ST.CONFIRM,
}

/**
 * ★ 等待态：处在这里意味着"任务没在干活，在等某个人回话"。
 *
 * 判据用它的地方只有一处，但很关键：`transition()` **不把等待态记进 `previous_state`**。
 * 否则 `待测试 → 等需求分析 → 等用户` 这条链会把 `previous_state` 写成
 * `awaiting_clarification`，用户答复完就"恢复"到"等需求分析" —— 永久卡死。
 */
export const WAITING_STATES = ['awaiting_clarification', 'awaiting_human']

/**
 * ★★ **架构图的「交付站」状态面**（编写完成之后）—— 基础表与主管枢纽分支**同一个出处**。
 *
 * 为什么单独立这一份常量（真机 `T-20261016-fullai` 的 L5 关单死锁）：
 *   · **枢纽路线**把「画架构图」整体安排在**计划之前、编写之前**（用户原话："先画架构图
 *     → 主管确认 → 才交给计划ai"），于是 `store/review.js` 的枢纽分支把合法状态面
 *     前移到了那四个前置站；
 *   · 而**关单闸**（`store/precondition.js` 的 `diagram_delivered`）要求"图必须对应
 *     **写完之后的最终版本**"（版本由产出时刻/内容哈希推导）。
 *   ⇒ 两条规则各自都对，合起来**结构上不可能同时成立**：任何走枢纽路线、且写完产生
 *     新版本（v1→v2）的单**都**关不掉单（不是个例）。
 *
 * 修法的判据形状：**枢纽分支只做「前移」，不做「删除」** —— 前置站照旧（那一条一个字
 * 没改），同时**交付站仍然可以交图**（就是这张表），只是在那里多两条硬判据：
 *   ① 必须**绑当前有效制品版本**（不是"声明什么算什么"）；
 *   ② 幂等（同一版本重复重交不产生第二条有效记录）。
 * 关单闸一个字都没放宽 —— 它仍然要求"最新那张图 = 当前版本"。
 *
 * ⚠️ 两处必须**同源**（基础表的 `architecture_diagram` 与枢纽分支），
 *   所以这份清单只在这里定义一次，两边都 import 它（各写一份 = 迟早漂移）。
 */
export const DIAGRAM_DELIVERY_STATES = Object.freeze([ST.READY_TEST, ST.TESTING, ST.READY_REVIEW, ST.REVIEWING, ST.PASSED])

/**
 * ★ 有权向上提问（第一级：问需求分析）的角色 = 执行与顾问角色。
 *
 * 不含 `main`（它不产出技术交接物）、不含 `orchestrator`（它是**被问的人**，
 * 答不了时它自己走升级路径）、不含 `human`（人不需要问机器）。
 */
export const ROLES_CAN_ASK_CLARIFICATION = [
  'architect',
  'security',
  'writer',
  'tester',
  'reviewer',
  'release',
  'docs',
  'performance',
  'arbiter',
  'diagrammer',
  // ★ 本轮新增：计划 AI。它的「计划自检发现缺失」就是**退回需求分析**，
  //   走的必须是与其它角色**同一条**澄清梯（用户明确要求"不要另起一套并行机制"）。
  'planner',
  // ★ 归档席位在 roles.js 里声明了 clarification_request，名单里原先漏了
  'archivist',
]

/** 中文名（状态一栏要给人看，所以单独一份映射）。 */
export const STATE_LABEL = {
  [ST.PENDING]: '待分配',
  [ST.ANALYZING]: '需求分析中',
  [ST.READY_PLAN]: '待计划',
  [ST.PLANNING]: '计划中',
  [ST.SUPERVISING]: '主管受理中',
  [ST.ARCH_DRAWING]: '架构位出图中',
  [ST.ARCH_CONFIRM]: '架构图待主管确认',
  [ST.ARCH_NEED_CONFIRM]: '架构图待需求位确认',
  [ST.ARCH_RECONFIRM]: '架构图待主管二次确认',
  [ST.STANDBY_PLAN]: '计划位已唤醒待派',
  [ST.READY_DEV]: '待开发',
  [ST.DEVELOPING]: '开发中',
  [ST.READY_TEST]: '待测试',
  [ST.TESTING]: '测试中',
  [ST.READY_REVIEW]: '待审核',
  [ST.REVIEWING]: '审核中',
  [ST.PASSED]: '已通过',
  [ST.CLOSED]: '已关闭',
  [ST.RETURNED_TO_DEV]: '已打回编写',
  [ST.RETURNED_TO_TEST]: '已打回测试',
  [ST.AWAITING_CLARIFICATION]: '等待需求分析答复',
  [ST.AWAITING_HUMAN]: '等待人工答复',
  [ST.BLOCKED]: '已阻塞',
  [ST.CANCELLED]: '已取消',
  // ★★ P4 接线：DEMO 两个状态的标签（同样从 `states/demo-phase.js` 取，不手抄字符串）。
  ...DEMO_STATE_LABEL,
}

/** 终态：到了就不可再迁（除人工重开）。 */
export const TERMINAL_STATES = [ST.CLOSED, ST.CANCELLED]

/**
 * ★ 有权向上发起人工介入的角色 = **除 main 之外的全部角色**。
 *
 * 为什么把 main 排除掉：本插件的拓扑是「用户只与主对话相连」。
 * main 就在用户的对话框里 —— 它需要问用户时**直接问**即可，
 * 不需要"发起请求给自己"这一圈。让它能发起只会制造一条没有意义的路径，
 * 而且会让"谁发起、谁转告"在审计里变得含糊。
 *
 * 为什么是白名单而不是黑名单：将来加了新角色，**忘了加进来只是少一条能力**
 * （会被明确拒绝），而黑名单忘了更新则是**悄悄多一条能力**。
 */
export const ROLES_CAN_RAISE_HUMAN = [
  'orchestrator',
  // ★ 本轮新增：计划 AI。它自己也可能是"答不了"的那一方（沿用同一部梯）。
  'planner',
  // ★ T-20261011-56a37e 新增：主管。用户口径④「架构图重画限 1 次，再不行**升给用户**定」
  //   —— 那条上升路径走的就是这一部**既有的**梯（human_request），不另开通道。
  ROLE.SUPERVISOR,
  'architect',
  'security',
  'writer',
  'tester',
  'reviewer',
  'release',
  'docs',
  'performance',
  'arbiter',
  'human',
  // ★ 架构图与归档两个席位在 roles.js 里都声明了 human_request，名单里原先漏了
  'diagrammer',
  'archivist',
]
