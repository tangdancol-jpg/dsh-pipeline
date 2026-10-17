/**
 * dsh-pipeline · 孤儿单自恢复 · 常量面
 * ============================================================================
 * 从 `lib/orphan.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/orphan.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/orphan/constants
 */

import { EXPECTED_ROLES_BY_STATE } from '../liveness.js'
import { WAITING_STATES } from '../states.js'

/** 判定窗（毫秒）：任务超过这么久没有任何进展/证据才允许判孤儿（默认 15 分钟）。 */
export const DEFAULT_ORPHAN_GRACE_MS = 15 * 60 * 1000

/** 两次重投之间的最小间隔（毫秒）——失败限次之外的**退避**（默认 30 分钟）。 */
export const DEFAULT_REDELIVER_BACKOFF_MS = 30 * 60 * 1000

/** 同一身份最多重投几次（超过就记 `markEscalated` = 放弃，不再骚扰）。 */
export const DEFAULT_MAX_REDELIVER_ATTEMPTS = 3

/** 巡检（自恢复扫描）间隔默认值：5 分钟一轮。 */
export const DEFAULT_ORPHAN_SWEEP_MS = 5 * 60 * 1000

/**
 * ★ **"正常闲置"的状态面**（等用户 / 等澄清）—— 这两处没人说话是**正常**的。
 * 直接复用 `states.js` 的 `WAITING_STATES`，不另抄一份字符串。
 */
export const ORPHAN_IDLE_STATES = Object.freeze([...WAITING_STATES])

/**
 * ★ **哪些状态才允许判孤儿**：有明确责任人的非终态（`EXPECTED_ROLES_BY_STATE` 的键）
 *   ＋ `blocked`（**仅当那次阻塞是机制自己触发的** —— 见 `orphanCandidate` 的判据）。
 *
 * 为什么不含其它状态：`pending`（还没派活）、`passed`（等关单）之类"没人动"是流程正常形态，
 * 判它们孤儿就是误报。
 */
export const ORPHAN_ELIGIBLE_STATES = Object.freeze([
  ...new Set([...Object.keys(EXPECTED_ROLES_BY_STATE), 'blocked']),
])

/** 本模块会产出的判词（只读导出用；顺序 = 判据里的优先级）。 */
export const ORPHAN_KINDS = Object.freeze([
  'seat-turn-aborted',
  'orphan-seat-gone',
  'orphan-task-unattended',
])

/**
 * ★★ **机制自己写下的留痕**（判据必须把它们排除在外，否则机制会**自己把自己喂饱**）。
 *
 * 为什么必须单列出来（这是本次实现里最容易踩、也最隐蔽的一个坑）：
 *   · 「给席位投一条消息」这件事走的是**既有**的 `notify_only` 通道，而那条通道
 *     按 A6/A7/A28(b) 的纪律要留痕 —— 它调 `store.recordAudit(task.id, **那个席位的角色**, …)`
 *     往 `task.history` 里写一行（`seat:wake-delivered` / `seat:wake-failed`）。
 *   · 于是**只要投过一次**，`task.history` 里就多了一行 `actor = 该席位` 的记录。而
 *     `evidenceOfLife` 的第④条判据正是"该角色自己触发过的流水"⇒ 那一行会被读成
 *     **"这个席位还活着"**；`lastProgressAtMs` 也会把它读成"任务有进展"。
 *   · 后果有两个，**都致命**：① 投**失败**之后这张单再也不会被认作孤儿（重试永远不发生）；
 *     ② 身份键里的"最后一次进展时刻"每次投递都变 ⇒ 幂等闸形同虚设、退避永不生效。
 *
 * 所以判据一律看 {@link judgeView} 给出的**判据视图**：把这几条**机制自己写的动作名**
 * 从 `history` 里剔掉再判。剔的判据是**动作名**（只有 `noteSeatDelivery` 会写这两个名字），
 * 不是"凡是机制写的都剔"—— 人工/席位真的动过的东西一个字都不剔。
 *
 * ---------------------------------------------------------------------------
 * ★★ **2026-10-14 补齐（P2-8 实测发现的真缺陷）：主对话侧那一半也必须剔**
 * ---------------------------------------------------------------------------
 * 上面那两条 `seat:wake-*` 是「机制投给**席位**」这半边的留痕；而**同一次投递**在
 * 「机制投给**主对话**」那半边也留痕，名字在 `lib/wakeup/keys.js` 的 `WAKE_AUDIT`
 * 里定义，由同一份实现的 `note()`（`lib/wakeup/waker.js`）经
 * `store.recordAudit`（`lib/store.js`，它 `task.history.push(entry)`）写进 `history`：
 *
 *   | 名字 | 出处 | 为什么必须剔 |
 *   | --- | --- | --- |
 *   | `wake:skipped` | `wakeup/waker.js`（`skip()`，"没投出去"的统一出口）| 本机两张真单 `history` 的**末行**就是它 |
 *   | `wake:delivered` | `wakeup/waker.js` | 投成功也是机制在说话，不是任务在进展 |
 *   | `wake:failed` | `wakeup/waker.js` | 同上 |
 *   | `wake:dedup` | `wakeup/waker.js`（幂等吃掉）| 同上 |
 *   | `wake:escalated` | R1 的升级叫醒 | 同上 |
 *
 * **不剔的代价（实测，不是推测）**：孤儿身份是
 * `<任务>|orphan|<判词>|<状态>|<最后一次进展时刻>`（见下面的 `orphanVerdict`），
 * 而"最后一次进展"取 `history` 末行 ⇒ **每写一次 `wake:skipped` 就换一个身份**
 * ⇒ `attemptsOf(taskId, id)` 每轮从 0 重数 ⇒ "同一身份最多重投 3 次"这条限次
 * **在真实运行里从未生效**：活体真单 `T-20261011-4a2dc7` 已重投 4 次，
 * `wake-ledger.jsonl` 里 4 条 unresolved **全是 `attempt: 1/3`**、`escalated` 0 条
 * ⇒ 无限重投，而且"放弃"那条**看得见的失败**永远不会发生。
 * 同一条链还让 15 分钟判定窗被机制自己顶走（`tests/orphan-rescue-check.mjs` 的
 * P1-12 就是它：改前 42/46 随机红）。
 *
 * ★★ **刻意不剔的三类**（剔了会**削弱**判据，不是补齐）：
 *   · `wake:consumed`（`wakeup/keys.js`）—— 它由 `markConsumed`（`wakeup/waker.js`）
 *     写进**账本**，**根本不进 `task.history`**；而且它的语义是"主对话**真的**带着这条
 *     投递动了"，剔除等于把真进展判成噪音。
 *   · `seat:wake-consumed`（`wakeup/keys.js`）/ `wake:consumed` 一族 —— 同理，
 *     它们是**接管**留痕（A28：送达 ≠ 接管），"有人真的动了手"正是活证据。
 *   · 任何**人工 / 席位真的做过**的动作（`transition:*` / `reattach` / 交接物 …）——
 *     一个字都不剔，判定窗照样被它们重新起算（`tests/orphan-rescue-check.mjs` 的
 *     `C2` 段有一条断言专门钉这一点）。
 */
export const MECHANISM_BOOKKEEPING_ACTIONS = Object.freeze([
  // —— 席位侧那一半（2026-10-14 之前就有）——
  'seat:wake-delivered',
  'seat:wake-failed',
  // —— ★ 主对话侧那一半（2026-10-14 补齐；五个名字逐条对应 lib/wakeup.js 的 WAKE_AUDIT）——
  'wake:skipped',
  'wake:delivered',
  'wake:failed',
  'wake:dedup',
  'wake:escalated',
  // —— 本机制自己的留痕 ——
  'orphan:detected',
  'orphan:redelivered',
  'orphan:redeliver-failed',
  'orphan:redeliver-abandoned',
  'orphan:turn-aborted',
])
