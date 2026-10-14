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

// ★ T-20261011-56a37e：主管枢纽的 by 名单**只写角色 id 的常量**，不写裸字符串 ——
//   角色 id 的唯一出处是 roles.js（`ROLE`），手抄一份就是漂移的入口。
//   依赖方向是单向的（roles.js 不 import 任何模块），不会成环。
import { ROLE } from './roles.js'

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
]

/**
 * ★★ **主管枢纽（T-20261011-56a37e）** —— 拓扑权威层的唯一一份数据。
 *
 * 用户原话：「主管发起（需求分析/计划/架构ai）对话 → 需求ai分析同时计划和架构ai待机
 *   → 需求ai分析将结果提交主管 → 同意后交给架构ai先画架构图 → 架构图完成后给主管确认
 *   是否满足要求 → 主管确认后交给计划ai……」
 *
 * 【为什么这些常量放在本模块而不是各个消费方】
 *   这正是本项目第一性目标的一条：**同一个事实只能有一个出处**。
 *   状态机、守门判据、只读边界导出、测试台全部读这一份 —— 各自手抄一份必然漂移，
 *   而"漂移了的边界表"比"没有边界表"更危险（执法方照错的表执法）。
 *
 * 【与四类不变量的关系】
 *   这里**没有**新造任何判定机制：它只是把新站点登记进**既有**的那张
 *   `TRANSITIONS` 表与**既有**的守卫开关（`store.checkPrecondition`）。
 *   三权分立 / 闸门链 / 守门作用域 / 哈希前置闸门四条本体一个字未动。
 */

/** ★ 两个唤醒点（用户口径：计划位与架构位「到点才动」）。 */
export const HUB_WAKE_POINTS = Object.freeze({
  /** 唤醒点 A：**主管同意需求结论** ⇒ 架构位被唤醒（架构图前置于计划的第一步）。 */
  NEED_AGREE: 'need_agree',
  /** 唤醒点 B：**主管确认架构图满足要求** ⇒ 计划位被唤醒。 */
  DIAGRAM_CONFIRM: 'diagram_confirm',
})

/**
 * ★ 待机名单：主管发起之后处于「已登记待机」的席位，以及各自的唤醒点。
 *
 * 为什么把 architect 与 diagrammer 都列在唤醒点 A 之下：
 *   roles.js 里这两个角色**不是一回事**（architect 出"该怎么写"的文字方案，
 *   diagrammer 出"画成什么样"的图），而用户要的"架构图"由 diagrammer 产出；
 *   架构位这一**组**在唤醒点 A 一起被唤醒，所以两条都登记在这里 ——
 *   这不是把两个角色混为一谈，而是把它们**归属到同一个唤醒点**。
 *
 * ⚠️ 名单方向是白名单：这里没有的席位**不受待机判据约束**（也就不会被误拦）。
 */
export const HUB_STANDBY_SEATS = Object.freeze([
  Object.freeze({ role: 'architect', wake_point: HUB_WAKE_POINTS.NEED_AGREE, group: '架构位' }),
  Object.freeze({ role: 'diagrammer', wake_point: HUB_WAKE_POINTS.NEED_AGREE, group: '架构位' }),
  Object.freeze({ role: 'planner', wake_point: HUB_WAKE_POINTS.DIAGRAM_CONFIRM, group: '计划位' }),
])

/** 待机席位的角色名集合（判据里用；派生自上面那张表，不手抄）。 */
export const HUB_STANDBY_ROLES = Object.freeze(HUB_STANDBY_SEATS.map((s) => s.role))

/** 该角色在待机名单里时的唤醒点；不在名单里返回 `null`。 */
export function hubWakePointOf(role) {
  const hit = HUB_STANDBY_SEATS.find((s) => s.role === role)
  return hit === undefined ? null : hit.wake_point
}

/**
 * ★ 五道确认站点（用户原话的 ①②③④⑤）。
 *
 * `confirmers` = **必须齐备的确认方**。长度 2 ⇒ 双确认（少一方就走不到下一步）。
 * `gate`      = 该站点在**既有守卫开关**里的判据名（不另起一套）。
 * `advances`  = 这个站点把哪条边放行（拒绝原文里要指名"还缺谁的确认"）。
 */
export const HUB_STATIONS = Object.freeze({
  /** ① 需求分析结果 → 主管同意。 */
  NEED_AGREE: 'need_agree',
  /** ② 架构图 → 主管确认（不满足 ⇒ 重画限 1 次，再不行升人工）。 */
  DIAGRAM_CONFIRM: 'diagram_confirm',
  /** ③ 测试通过 → **主管 + 需求位**双确认 ⇒ 才进审核。 */
  TEST_CONFIRM: 'test_confirm',
  /** ④ 审核通过 → **主管 + 需求位**双确认 ⇒ 才进主对话关单。 */
  REVIEW_CONFIRM: 'review_confirm',
  /** ⑤ 主对话关单并交付用户（不需要额外确认记录 —— 它本身就是关单那一刻）。 */
  CLOSEOUT: 'closeout',
})

/** 站点的确认方清单（白名单方向：没登记 = 谁都不能在该站点确认）。 */
export const HUB_STATION_CONFIRMERS = Object.freeze({
  [HUB_STATIONS.NEED_AGREE]: Object.freeze(['supervisor']),
  [HUB_STATIONS.DIAGRAM_CONFIRM]: Object.freeze(['supervisor']),
  [HUB_STATIONS.TEST_CONFIRM]: Object.freeze(['supervisor', 'orchestrator']),
  [HUB_STATIONS.REVIEW_CONFIRM]: Object.freeze(['supervisor', 'orchestrator']),
})

/**
 * ★★ **架构图「交接计划位之前」的两道确认点**（P0-1：用户新口径第 7~8 跳）。
 *
 * 用户原话：「…架构agent完成后发给主管agent，**主管agent转交需求agent**，
 *   **需求agent确认后**递交主管agent**二次确认**，无问题后将架构agent**递交计划agent**…」
 *
 * 【为什么单开一张表、而不是并进 `HUB_STATIONS`】
 *   `HUB_STATIONS` 是**用户原话里那五道**（①②③④⑤）的登记表，它的条目数被既有
 *   自测逐字钉住（`gate-states-check` 的「五道站点齐备」= 5；只读导出 `stations.length === 5`；
 *   `hub.confirm_stations` = 那四道）。把它改成七条会**改掉既有判据的期望值** ——
 *   那是本单硬约束明令禁止的动作（"不得删既有测试、不得放宽断言、不得改期望值"）。
 *
 *   所以这里**不新增"站点"这个类别**，而是把这两个**确认点**登记成**同一种东西的另一张表**：
 *   同样的形状（station → confirmers）、同样走 `station_confirm` 交接物、同一个
 *   `store.checkPrecondition` 守卫开关、同一份 `audit.jsonl` 留痕、同一套预算读法。
 *   ⇒ 判据机制**一套**，只是登记表分了两张（新增的两点与用户原话的五道不混号）。
 *
 * ★ 顺序即判据：需求位先确认（`ARCH_NEED_CONFIRM`），主管**才**能二次确认
 *   （`ARCH_RECONFIRM`）—— 两站由状态机串起来，不能颠倒（见 `TRANSITIONS`）。
 */
export const HUB_HANDOFF_CONFIRM_STATIONS = Object.freeze({
  /** 需求位确认架构图（用户新口径第 8 跳前半）。 */
  ARCH_NEED_CONFIRM: 'arch_need_confirm',
  /** 主管**二次**确认（用户新口径第 8 跳后半）⇒ 才允许交计划位。 */
  ARCH_RECONFIRM: 'arch_reconfirm',
})

/** 两个新确认点的确认方（白名单方向：没登记 = 谁都不能确认）。 */
export const HUB_HANDOFF_CONFIRM_CONFIRMERS = Object.freeze({
  [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM]: Object.freeze(['orchestrator']),
  [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM]: Object.freeze(['supervisor']),
})

/** 阅读/推进顺序（需求位 → 主管）。派生自状态机那条链，不是第二份事实。 */
export const HUB_HANDOFF_CONFIRM_ORDER = Object.freeze([
  HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM,
  HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM,
])

/** 每个确认点**放行哪一跳**（拒绝原文与只读导出都读这一份）。 */
export const HUB_HANDOFF_CONFIRM_EVENTS = Object.freeze({
  [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM]: 'need_confirm_diagram',
  [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM]: 'supervisor_reconfirm_diagram',
})

/** 有确认方的站点全表（五道里那四道 + ②b/②c 两个交接确认点）—— **派生**，不手抄。 */
export const HUB_ALL_CONFIRMERS = Object.freeze({
  ...HUB_STATION_CONFIRMERS,
  ...HUB_HANDOFF_CONFIRM_CONFIRMERS,
})

/**
 * ★ **`station_confirm` 交接物承认的全部站点名** = **有确认方的那些站点**。
 *
 * ① 唯一出处：`handoff.js` 的 `station` 枚举与 `validateStationConfirm` 都读它 ——
 *    手抄第二份必然漂移，而"漂移了的枚举"会让某一道的确认记录**交不上来**
 *    （那正是第⑤道刻意不在枚举里的原因：它没有确认方，见 `HUB_STATIONS.CLOSEOUT` 的说明）。
 * ② 它取自 `HUB_ALL_CONFIRMERS` 的键（**派生**，不是第二张手抄清单）：
 *    五道里那四道 + ②b/②c 两个交接确认点 = 六项；第⑤道（关单交付）**不在**其中 ——
 *    "五道站点"与"几道确认"依旧分得清（这条既有的区分一个字没动）。
 */
export const HUB_STATION_NAMES = Object.freeze(Object.keys(HUB_ALL_CONFIRMERS))

/** 需要**双确认**的站点（长度 ≥ 2 的那些，派生不手抄）。 */
export const HUB_DUAL_STATIONS = Object.freeze(
  Object.entries(HUB_STATION_CONFIRMERS)
    .filter(([, who]) => who.length >= 2)
    .map(([st]) => st),
)

/** 架构图重画预算（用户口径④：**限 1 次**，再不行升给用户）。 */
export const HUB_DIAGRAM_REDRAW_BUDGET = 1

/**
 * ★★ **站点「否掉」预算**（T-20261011-56a37e 补齐条第 2~3 步）。
 *
 * 用户原话里有**两条**分支：「**如果同意**……**如果否掉**……」。
 * 上半条（同意）此前已经落地（第①~④道的确认闸门）；
 * 下半条（否掉）此前**只有第②道做了**（`supervisor_reject_diagram` ⇒ 架构位重画），
 * ①③④ 三道**没有回边** ⇒ 主管在那三站说"不行"时，任务只剩 `block` / `cancel` 两条路
 * （状态机上从 `supervising` / `ready_review` / `passed` 各只有一条出边，且那条都要求"确认方点头"）。
 *
 * 这里补的就是那三条回边。预算口径**照抄 ② 道那一套**（用户口径④的同一句话）：
 * **限 1 次**，用尽 ⇒ 升级人工（走既有的两级梯 `human_request`，不是第二套通道）。
 * 四个站点各自独立计数（在 ① 站用掉一次不影响 ③ 站的额度）。
 */
export const HUB_STATION_REJECT_BUDGET = 1

/**
 * ★★ **①③④ 三站的「否掉」事件名**（站点 → 事件）。
 *
 * ⚠️ 第②道**刻意不在这张表里**：它已经有自己的 `supervisor_reject_diagram`
 *   与自己的判据 `hub_diagram_rework_budget`（自测里有一条把它逐字钉住：
 *   `gate-states-check` 的「重画边存在且挂预算判据」），**一个字都不动**。
 *   本表只收**此前没有回边**的那三站 —— 补的是缺口，不是把既有那条重写一遍。
 *
 * 为什么用一张表而不是三处手抄事件名：三处消费（`TRANSITIONS` / 守门判据 / 主管工具动作）
 * 必须认同一个事实 —— 这正是本项目"同一个事实只能有一个出处"那条。
 */
export const HUB_STATION_REJECT_EVENTS = Object.freeze({
  [HUB_STATIONS.NEED_AGREE]: 'supervisor_reject_need',
  [HUB_STATIONS.TEST_CONFIRM]: 'supervisor_reject_test',
  [HUB_STATIONS.REVIEW_CONFIRM]: 'supervisor_reject_review',
})

/** 上面那张表的**反向**查表（事件 → 站点）；派生，不手抄。 */
export const HUB_REJECT_EVENT_STATIONS = Object.freeze(
  Object.fromEntries(Object.entries(HUB_STATION_REJECT_EVENTS).map(([st, ev]) => [ev, st])),
)

/** 有「否掉」回边的站点集合（①③④；② 走它自己那条，见上面的说明）。 */
export const HUB_STATION_REJECT_STATIONS = Object.freeze(Object.keys(HUB_STATION_REJECT_EVENTS))

/**
 * ★ **确认站点** = 有确认方的那些（由确认方清单**派生**，不另立一张表）。
 *
 * 为什么要有这个名字：用户原话与计划里说的是「**五道**硬闸门」，而这五道里
 * 第⑤道（关单并交付用户）**不是**一道"确认"—— 它没有确认方、也不产出确认记录，
 * 它就是"交付"这一步本身（用户那句里的"确认"落在第④道：主管+需求确认之后
 * **才**提交主对话）。把这两件事分开命名之后，"五道"（站点）与"四道确认"
 * （有确认方的闸门）就不会再被混为一谈 —— 这正是本单第 2 步要求③⑤说清楚的那件事。
 */
export const HUB_CONFIRM_STATIONS = Object.freeze(Object.keys(HUB_STATION_CONFIRMERS))

/**
 * 该站点需要哪些确认方（不在表里 = 空数组 ⇒ 谁都不能确认）。
 *
 * ★ P0-1：查表范围是**两张同形的表** —— 用户原话那五道里的四道（`HUB_STATION_CONFIRMERS`）
 *   与两个交接确认点（`HUB_HANDOFF_CONFIRM_CONFIRMERS`）。
 *   为什么要能查后者：新增的两个确认点要**复用同一套**站点闸
 *   （`hubStationGate` / `hubValidConfirms` / `pipeline_status` 的站点视图），
 *   而它们读的都是本函数 —— 改这一处，两个新点就自动进了同一套判据。
 */
export function hubConfirmersOf(station) {
  return HUB_STATION_CONFIRMERS[station] ?? HUB_HANDOFF_CONFIRM_CONFIRMERS[station] ?? []
}

/** 这个 station 名是不是**本插件承认的**站点（五道站点 + 两个交接确认点）。 */
export function hubIsKnownStation(station) {
  return HUB_STATION_NAMES.includes(station)
}

/** 该站点是不是双确认站点。 */
export function hubIsDualStation(station) {
  return HUB_DUAL_STATIONS.includes(station)
}

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
