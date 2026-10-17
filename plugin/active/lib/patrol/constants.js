/**
 * dsh-pipeline · 巡检 · **常量与判据表**（自 `lib/patrol.js` 原样拆出，行为逐字不变）。
 *
 * 默认口径、播报类别、三腿判据表、收敛身份、抑制原因、活跃状态表都只在这里定义；
 * 判据实现见 `./findings.js`，定时器见 `./scheduler.js`。
 *
 * @module dsh-pipeline/lib/patrol/constants
 */

import { EXPECTED_ROLES_BY_STATE } from '../liveness.js'

/** 巡检间隔默认值：5 分钟（够快发现，又不至于变成心跳刷屏源）。 */
export const DEFAULT_PATROL_INTERVAL_MS = 5 * 60 * 1000

/** "任务长时间无进展"的默认口径：20 分钟。 */
export const DEFAULT_TASK_STALL_MS = 20 * 60 * 1000

/** "已投递但没人接管"的默认口径：15 分钟（R1 的升级叫醒阈值）。 */
export const DEFAULT_UNCONSUMED_MS = 15 * 60 * 1000

/** 巡检连续抛错到几次就播报"巡检已停摆"（A25）。 */
export const DEFAULT_PATROL_FAILURE_THRESHOLD = 3

/**
 * ★★ **"交付已落盘、出口没按"的默认口径：10 分钟。**
 *
 * 实测（`T-20261011-5a871c`，三次复现）：席位交完**最后一个交付物**就结束回合，
 * 而"发最后那个状态迁移"它不做 —— 制品 v4 落盘、`dev_to_test` 交接物落盘、
 * 记录落盘、哈希闸门过、改动面在授权面内，**就是不 pip `dev_submitted`**，
 * 任务停在「开发中」。
 *
 * 口径为什么按"**交付时间**"而不是"无进展"：交付本身就**算**进展
 * （`lastProgressAtMs` 会把交接物/记录算进去）⇒ 用"无进展"当判据永远不触发。
 * 10 分钟：席位交完东西、顺手发那一步通常就在**几秒**内；10 分钟没发，
 * 就是"停了"，不是"正在发"。
 */
export const DEFAULT_UNDELIVERED_TRANSITION_MS = 10 * 60 * 1000

/**
 * ★★ 本条播报的类别。
 *
 * ★ **必须同时登记进 `lib/wakeledger.js` 的 `MECHANISM_NOTICE_KINDS`** ——
 *   任何**由巡检发出去的**通知类别，若不在那张表里，它自己那条交付下一轮就会
 *   被当成"等待接管的交付"再报一次 ⇒ 又变回 P0-3 的套娃。
 *   （自测里有一条断言专门锁这个"两个文件必须同时改"的约束。）
 */
export const MISSING_TRANSITION_KIND = 'missing-transition'

/**
 * ★★ **"交付已落盘、出口没按"**：三腿的判据表（状态 ⇒ 该发的迁移）。
 *
 * 判据一律与**状态机/守卫同源**（不另造一套口径）：
 *   · `dev_submitted`（`states.js:595`，by `writer`，guard `dev_to_test`）
 *     ⇒ 守卫要求"**全部编写席位都已提交**"（`store/shared.js` 的
 *       `checkAllSeatsSubmitted`）⇒ 本腿也只在**全部到齐**时才判，
 *       否则就是在催一个还没干完的席位（假报）；
 *   · `test_passed` / `test_failed`（`states.js:605/606`，by `tester`）
 *     ⇒ 守卫要求 `test_to_review` 交接物 + **制品版本对得上**
 *       （`store/precondition.js`）—— **通过还是不通过是测试位的结论，机制不替它判**，
 *       所以这一腿同时列出两个候选事件；
 *   · `review_ok` / `review_ng_*`（`states.js:620-622`，by `reviewer`）
 *     ⇒ 结论**就在交接物里**（`payload.conclusion`）⇒ 这一腿能指名道姓。
 */
export const UNDELIVERED_TRANSITION_LEGS = Object.freeze([
  Object.freeze({
    key: 'dev_submitted',
    state: 'developing',
    handoff_kind: 'dev_to_test',
    actor: 'writer',
    label: '编写交测试',
    evidence: '编写席位的本轮提交表（`writer_submissions`）或本轮的 `dev_to_test` 交接物',
  }),
  Object.freeze({
    key: 'test_verdict',
    state: 'testing',
    handoff_kind: 'test_to_review',
    actor: 'tester',
    label: '测试交审核 / 打回编写',
    evidence: '`test_to_review` 交接物（且制品版本与当前有效版本一致）',
  }),
  Object.freeze({
    key: 'review_verdict',
    state: 'reviewing',
    handoff_kind: 'review_verdict',
    actor: 'reviewer',
    label: '审核结论',
    evidence: '`review_verdict` 交接物（结论与制品版本都从它自己身上读）',
  }),
])

/**
 * ★★ **P2-12：这一类"该叫没叫"必然出现，所以要收敛，而不是每次来一条。**
 *
 * 机制**不能对"人"说话**（主对话是唯一传话人）⇒ **每产生一条人工介入请求**，
 * 就必然伴生一条 `kind=human / reason=no-stable-identity` 的"没投出去"。
 * 那不是新事实，是**同一个结构性事实的第 N 次重复**（实例：同一张单 3 条同形播报）。
 *
 * 修法是**收敛身份**：这一类只印「类别 + 原因」，**不印那一次的时刻** ⇒
 * 同一张单**至多播一次**（跨进程仍由已播报账本吃掉）。
 * ★ 别的类别**一个字不动** —— 那些是真失败，每一次都要看得见（A8 不变）。
 */
export const CONVERGED_UNRESOLVED_IDENTITY = Object.freeze({
  kind: 'human',
  reason: 'no-stable-identity',
})

/**
 * 「只记账不播报」的四种原因（人读的那一句里用）。
 * ★ 每一条压下去的事实都带 `reason`，而 `note` 里报的是**按原因分组的条数** ——
 *   于是"为什么没叫"这件事在**返回值里就看得见**，不必去翻代码。
 */
export const SUPPRESS_REASON_LABEL = Object.freeze({
  'terminal-state': '终态',
  'mechanism-notice': '机制通知',
  'depth-capped': '到深度上限',
  'converged-duplicate': '同类已有一条',
})

/**
 * ★ **哪些状态下"无进展"值得播报**。
 *
 * 刻意**不含**等待态：`awaiting_human`（等用户）与 `awaiting_clarification`
 * （等需求分析）里"没有进展"是**正常**的 —— 那两处的判据是"投递有没有被接管"
 * （见下面的 `unconsumed-delivery`），而不是"任务卡住了"。
 * 也不含终态与「已阻塞」（后者已经有人被叫过了，再报一次就是刷屏）。
 */
export const PATROL_ACTIVE_STATES = Object.freeze([
  ...new Set([
    ...Object.keys(EXPECTED_ROLES_BY_STATE),
    'developing',
    'testing',
    'reviewing',
    'returned_to_dev',
    'returned_to_test',
  ]),
])
