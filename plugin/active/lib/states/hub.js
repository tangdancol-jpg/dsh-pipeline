/**
 * dsh-pipeline · 任务状态机 · 主管枢纽拓扑常量
 * ============================================================================
 * 从 lib/states.js 机械拆出（纯搬家，行为逐字未变）：HUB_* 常量与
 * hubWakePointOf / hubConfirmersOf / hubIsKnownStation / hubIsDualStation。
 * 对外入口仍是 lib/states.js（barrel）。
 *
 * @module dsh-pipeline/lib/states/hub
 */

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
