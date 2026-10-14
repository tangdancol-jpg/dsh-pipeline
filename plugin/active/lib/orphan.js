/**
 * dsh-pipeline · **孤儿单自恢复**（识别「席位被切断 / 没人管」，然后**自己重新投递**）
 * ============================================================================
 * 用户原话（本条的验收口径，逐字）：
 *   「**孤儿单：席位被切断后，机制要能【自己意识到】并重新投递 —— 不是等人来救。**」
 *
 * ---------------------------------------------------------------------------
 * 它补的是哪一条**既有判据覆盖不到**的空档
 * ---------------------------------------------------------------------------
 * 改前，同一张卡死的单会被三条既有判据从旁边绕过去，**没有一条**会说
 * 「这单没人管了，我再去叫一次」：
 *
 *   · `lib/liveness.js → seatLiveness`（判词：**席位失联**）——
 *     判据是「静默超阈值 + 轮到它 + 无活证据」，处置是**把任务推到「已阻塞」**。
 *     它只**冻**，不**叫**；而且它挂在"下一次工具调用 / 下一次开步"上（写时检查）——
 *     **没有任何人在动**恰恰让那两个触发点全部失效。
 *   · `lib/patrol.js`（判词：**长时间无进展**）——
 *     用户裁定 A22 写死了「**只播报，不动作**」。它把事实说出来，然后就没有然后了。
 *   · `lib/runfail.js`（判词：**运行失败中止**）——
 *     它回答的是「**崩 ≠ 闲**」（A9/A10/A11）：崩了不冻、但必须播报。
 *     它是**另一条判词**，与"席位会话已经不在磁盘上"是两件事。
 *
 * 于是现场留下了两个真实孤儿（本机数据，只读引用，未改动）：
 *   · `T-20261011-4a2dc7`：`state=analyzing`（该 `orchestrator` 动），
 *     **`dispatched` 字段根本不存在**、`handoffs/artifacts/records/context_reports` 全 0，
 *     自 2026-10-11T10:00:40Z 之后再没有任何一行 —— 没有会话、没有交接物、没有流水。
 *   · `T-20261011-a5fe41`：`state=blocked`（机制阻塞，`liveness.escalations[0]` 写着
 *     `seats:["planner"]`），`dispatched` 里 `planner` 的会话 id 是裸 UUID
 *     （不是 `session-…` 形状），planner **零交接物**（6 份交接物全是 orchestrator 的）。
 *
 * ---------------------------------------------------------------------------
 * ★ 四种判词**必须分得开**（本条的第一条硬要求；下面的判据逐条落到函数上）
 * ---------------------------------------------------------------------------
 *   | 形态 | 判词（finding.kind） | 判据落在 |
 *   | --- | --- | --- |
 *   | 正常闲置（等用户 / 等澄清 / 已交付） | **不产出任何 finding**（带 `skip.reason`） | `ORPHAN_IDLE_STATES` + 终态 + 「有人叫停的 blocked」 |
 *   | 回合中止（`MALFORMED_RESPONSE` 等） | `seat-turn-aborted`（`orphan:false`） | `spec.runFailure.found === true`（复用 `lib/runfail.js` 的取证结论） |
 *   | ★ 席位会话被切掉 / 消失 | `orphan-seat-gone`（`orphan:true`） | 会话日志**在盘上找不到**（`present:false`）/ 派活台账里**没有会话 id** / 会话日志**经实测不再变化**且无任何活证据 |
 *   | ★ 停在非终态 + 长时间零交接物/流水/水位 | `orphan-task-unattended`（`orphan:true`） | 整单零证据（`handoffs/artifacts/records/context_reports/writer_submissions` 全空 + 流水里没有非 main 的执行者） |
 *
 *   判为中止的那一支**不再**判孤儿：一次中止只该有一条判词（A9 的纪律），
 *   而且中止本来就有自己的播报面（`intercept` 的 A11 播报）。
 *
 * ---------------------------------------------------------------------------
 * ★ 复用了哪些既有件（**不是重造**，逐条指名）
 * ---------------------------------------------------------------------------
 *   · 「谁该动」= `lib/liveness.js → EXPECTED_ROLES_BY_STATE`（同一份表，不另抄一份）；
 *   · 「有没有活着的证据」= `lib/liveness.js → evidenceOfLife`（交接物 / 席位提交 /
 *     水位自报 / 流水 / 继任，五条口径原样）；
 *   · 「会话日志还在长吗」= `lib/liveness.js → activityOfSamples`（含 2026-10-13 快修
 *     的 `conclusive` 语义）；采样本身也只调它的 `sessionsRootCandidates /
 *     findSessionLog / sampleSessionLog` 三个只读原语（**同一套候选根**，
 *     所以不会出现"store 采得到、孤儿判据采不到"的第二套口径）；
 *   · 「最后一次进展」= `lib/patrol.js → lastProgressAtMs`（同一份口径）；
 *   · 「崩没崩」= `lib/runfail.js`（经 `store.detectRunFailure` 注入，不自己解 zstd）；
 *   · **重新投递的通道** = `lib/tools.js → createSeatNotifier().notifyOnly` ——
 *     与 `pipeline_dispatch { notify_only: true }` **同一份实现**（不建会话、不改状态、
 *     失败返回 `ok:false` 并写清原因）；
 *   · **幂等** = `lib/wakeledger.js` 的 `hasDelivered / record / noteUnresolved /
 *     markEscalated / escalatedEntry / unresolvedEntries`（**不新开账本**）；
 *   · **可见的失败** = 失败落 `noteUnresolved` ⇒ **既有巡检**那条 `unresolved-wake`
 *     会把它播报出去（不新开播报面）；成功与放弃则直接 `wakeup.wake` 播一次。
 *
 * ---------------------------------------------------------------------------
 * ★ 它**不做**什么（结构上就做不到，写在参数表上）
 * ---------------------------------------------------------------------------
 *   · **不建会话、不派新席位**（用户裁定：「不要求自动补新席位」）——
 *     本模块的 `deps` 里**没有** `transport.spawnRole`，只有 `notify`（投给既有会话）；
 *   · **不改任何任务状态**（不推进 / 不回退 / 不解冻 / 不重置失联计数）；
 *     留痕走 `.pipeline/<任务>/audit.jsonl`（只追加，**不碰 `task.json`**）——
 *     这一条同时是防"自喂"的：改 `task.json` 会写 `history` ⇒ 会被算成"有新进展"
 *     ⇒ 自己把自己的无进展计时清零（巡检当初就是靠"不产生进展"避开这个坑的）；
 *   · **不越权投递**：投给谁由 `task.dispatched` 的派活台账决定（与
 *     `pipeline_dispatch notify_only` 同一条判据），投不出去就**如实报**。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么它不会变成新的刷屏源（写在判据里，不是写在善意里）
 * ---------------------------------------------------------------------------
 *   ① 身份是**内容派生**的：`<任务>|orphan|<判词>|<状态>|<最后一次进展时刻>` ——
 *      同一段卡死跨多次巡检是**同一个键** ⇒ 被账本幂等吃掉；进展恢复后再卡住 ⇒
 *      时刻变了 ⇒ **新的一条**（不会永久哑掉）；
 *   ② 成功即记账（`record`）⇒ 同一条身份**永不重投第二次**；
 *   ③ 失败**限次 + 退避**：`maxAttempts`（默认 3）次之后记 `markEscalated`（= 放弃），
 *      同一身份不再尝试；每次尝试之间至少隔一个 `backoffMs`（默认 30 分钟）；
 *   ④ 每次投递**只发一条**给席位、最多播报一条给主对话（键含结局，成功/放弃各一条）；
 *   ⑤ 完全没有"读时副作用"：判据是纯函数（`orphanVerdict`），采样与投递都在运行期
 *      （`createOrphanRescue`）里，且**不写任务文件**；
 *   ⑥ ★ **机制自己的两条投递留痕不参与判据**（`MECHANISM_BOOKKEEPING_ACTIONS` /
 *      `judgeView`）：`notify_only` 按 A6/A7/A28(b) 的纪律会往 `task.history` 写一行
 *      `actor = 该席位` 的 `seat:wake-delivered` / `seat:wake-failed` —— 不剔掉它，
 *      "投过一次"就会被读成"这个席位还活着"、并且把身份键里的"最后一次进展"顶走
 *      （⇒ 投失败后永不重试、退避永不生效）。**这一条是本次实现里最隐蔽的坑**。
 *
 * @module dsh-pipeline/lib/orphan
 */

import { appendFileSync } from 'node:fs'

import {
  DEFAULT_ACTIVITY_FRESH_MS,
  DEFAULT_ACTIVITY_MAX_MS,
  DEFAULT_ACTIVITY_MIN_BYTES,
  EXPECTED_ROLES_BY_STATE,
  SESSION_LOG_NAME,
  activityOfSamples,
  evidenceOfLife,
  findSessionLog,
  formatDuration,
  msOf,
  sampleSessionLog,
  seatKey,
  sessionsRootCandidates,
} from './liveness.js'
import { lastProgressAtMs } from './patrol.js'
import { roleLabel } from './roles.js'
import { STATE_LABEL, TERMINAL_STATES, WAITING_STATES } from './states.js'

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
 * 「机制投给**主对话**」那半边也留痕，名字在 `lib/wakeup.js:101-122` 的 `WAKE_AUDIT`
 * 里定义，由同一份实现的 `note()`（`lib/wakeup.js:1101-1108`）经
 * `store.recordAudit`（`lib/store.js:7794`，它 `task.history.push(entry)`）写进 `history`：
 *
 *   | 名字 | 出处 | 为什么必须剔 |
 *   | --- | --- | --- |
 *   | `wake:skipped` | `wakeup.js:1134`（`skip()`，"没投出去"的统一出口）| 本机两张真单 `history` 的**末行**就是它 |
 *   | `wake:delivered` | `wakeup.js:1459` | 投成功也是机制在说话，不是任务在进展 |
 *   | `wake:failed` | `wakeup.js:1408 / :1435` | 同上 |
 *   | `wake:dedup` | `wakeup.js:1281 / :1351 / :1370`（幂等吃掉）| 同上 |
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
 *   · `wake:consumed`（`wakeup.js:114`）—— 它由 `markConsumed`（`wakeup.js:1594`）
 *     写进**账本**，**根本不进 `task.history`**；而且它的语义是"主对话**真的**带着这条
 *     投递动了"，剔除等于把真进展判成噪音。
 *   · `seat:wake-consumed`（`wakeup.js:121`）/ `wake:consumed` 一族 —— 同理，
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

/**
 * ★ **判据视图**：剔掉机制自己的记账行之后的 `task`（**浅拷贝，不改入参**）。
 * @param {object|null} task
 * @returns {object|null}
 */
export function judgeView(task) {
  if (task === null || typeof task !== 'object') return task ?? null
  const history = Array.isArray(task.history) ? task.history : []
  const filtered = history.filter((h) => !MECHANISM_BOOKKEEPING_ACTIONS.includes(String(h?.action ?? '')))
  if (filtered.length === history.length) return task
  return { ...task, history: filtered }
}

/** 毫秒 → ISO（秒级，与项目其它留痕同口径）。 */
function isoAt(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * ★ **只读导出**：孤儿判据的全部常量（`lib/boundaries.js` 直接复用它，
 *   「导出说的」与「判据做的」永远是同一份数字）。
 */
export function orphanCatalog() {
  return {
    verdict_kinds: [...ORPHAN_KINDS],
    orphan_kinds: ORPHAN_KINDS.filter((k) => k.startsWith('orphan-')),
    idle_states: [...ORPHAN_IDLE_STATES],
    eligible_states: [...ORPHAN_ELIGIBLE_STATES],
    terminal_states: [...TERMINAL_STATES],
    grace_ms: DEFAULT_ORPHAN_GRACE_MS,
    sweep_ms: DEFAULT_ORPHAN_SWEEP_MS,
    redeliver_backoff_ms: DEFAULT_REDELIVER_BACKOFF_MS,
    max_redeliver_attempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
    /**
     * ★ 「孤儿」的判据（原话即判据；每一条都指到本文件里的那一行实现）：
     */
    criteria: [
      '席位会话被切掉 / 消失：会话日志在盘上找不到（sampleSeatActivity 的 present:false）',
      '席位会话被切掉 / 消失：派活台账里那条记录没有会话 id（session_id / agent_id 皆空）',
      '席位会话被切掉 / 消失：会话日志经实测不再变化（activityOfSamples 的 conclusive:true 且 grew:false）',
      '任务停在非终态、且长时间没有任何交接物 / 流水 / 水位自报（整单零证据）',
    ],
    /** ★ 判据**不成立**时会写出的抑制原因（反例测试就断言这些字符串）。 */
    skip_reasons: [
      'no-task',
      'terminal-state',
      'waiting-for-human',
      'state-not-orphan-eligible',
      'blocked-by-human',
      'within-grace',
      'has-living-evidence',
      'session-alive',
      'delivered-recently',
    ],
    redeliver_channel: 'pipeline_dispatch { notify_only: true } 的同一份实现（createSeatNotifier().notifyOnly）',
    /** ★ 机制自己的记账动作名（判据必须把它们从 history 里剔掉，见 judgeView）。 */
    mechanism_bookkeeping_actions: [...MECHANISM_BOOKKEEPING_ACTIONS],
    creates_new_seats: false,
    changes_task_state: false,
    /** ★ 留痕只追加 `.pipeline/<任务>/audit.jsonl`：**不碰 `task.json`**（碰了就等于自己制造进展）。 */
    writes_task_json: false,
    audit_actions: ['orphan:detected', 'orphan:redelivered', 'orphan:redeliver-failed', 'orphan:redeliver-abandoned', 'orphan:turn-aborted'],
  }
}

/**
 * ★ **采样一个任务的席位侧活动**（只读；判据是纯的，采样在运行期）。
 *
 * 与 `store.sampleSessionActivity` **同一套候选根与同一套只读原语**
 * （`sessionsRootCandidates / findSessionLog / sampleSessionLog`）——
 * 唯一多出来的一件事是**按席位记下"日志在不在"**：
 * 「找不到」本身是孤儿判据里最硬的一条（`present:false`），而 store 那份返回的是
 * "整体采样到了几条"，回答不了"这个席位的日志在不在"。
 *
 * @param {object|null} task
 * @param {number} atMs
 * @param {{roots?:string[], activityOpts?:object}} [opts]
 * @returns {{seats:object, roots:string[], found:number, looked:number, note:string}}
 */
export function sampleSeatActivity(task, atMs, opts = {}) {
  const roots = Array.isArray(opts.roots) && opts.roots.length > 0 ? opts.roots : sessionsRootCandidates()
  const seats = {}
  let found = 0
  let looked = 0
  for (const raw of Array.isArray(task?.dispatched) ? task.dispatched : []) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const key = seatKey(role, seat)
    const sid =
      typeof raw?.session_id === 'string' && raw.session_id.length > 0
        ? raw.session_id
        : typeof raw?.agent_id === 'string' && raw.agent_id.length > 0
          ? raw.agent_id
          : null
    if (sid === null) {
      seats[key] = { key, role, seat, session_id: null, present: false, sample: null, log_path: null, reason: '派活台账里没有会话 id（session_id / agent_id 都是空的）' }
      continue
    }
    looked += 1
    const logPath = findSessionLog(roots, sid)
    const sample = sampleSessionLog(logPath, atMs)
    if (sample !== null) found += 1
    seats[key] = {
      key,
      role,
      seat,
      session_id: sid,
      present: logPath !== null && sample !== null,
      sample,
      log_path: logPath,
      reason: logPath === null ? `会话 ${sid} 的 ${SESSION_LOG_NAME} 在候选会话根下找不到` : '',
    }
  }
  return {
    seats,
    roots,
    found,
    looked,
    note:
      roots.length === 0
        ? '一个候选会话根都取不到（DSH_SESSIONS_DIR / DSH_HOME / DSH_PROFILE_DIR / ~/.dsh 全都没有）—— 本次拿不到"日志在不在"的证据，判据会退回台账面（**不猜**）。'
        : `候选根 ${roots.length} 个；有会话 id 的席位 ${looked} 个，命中日志 ${found} 个。`,
  }
}

/**
 * ★ **这个席位最后一次由它自己产出的东西是什么**（"你上次停在哪"那句话的原料）。
 *
 * 顺序与 `evidenceOfLife` 同源（交接物 > 席位提交 > 水位 > 流水），取**最新**的一条。
 *
 * @returns {string} 人话；查不到时如实说查不到（**不编**）。
 */
export function lastSeatOutput(task, role, seat = null) {
  const r = String(role ?? '')
  if (r.length === 0) return '（角色未知）'
  let best = null
  const take = (at, text) => {
    const t = msOf(at)
    if (t === null) return
    if (best === null || t > best.t) best = { t, text }
  }
  for (const h of Array.isArray(task?.handoffs) ? task.handoffs : []) {
    if (String(h?.from_role ?? '') !== r) continue
    take(h?.created_at, `交接物 ${String(h?.kind_zh ?? h?.kind ?? '?')}（${String(h?.created_at ?? '')}）`)
  }
  if (typeof seat === 'string' && seat.length > 0) {
    const mine = task?.writer_submissions?.[seat]
    if (mine !== null && mine !== undefined) take(mine.at, `席位提交（${String(mine.at ?? '')}）`)
  }
  for (const x of Array.isArray(task?.context_reports) ? task.context_reports : []) {
    if (String(x?.role ?? '') !== r) continue
    take(x?.at, `水位自报（${String(x?.at ?? '')}）`)
  }
  for (const h of Array.isArray(task?.history) ? task.history : []) {
    if (String(h?.actor ?? '') !== r) continue
    take(h?.at, `流水 ${String(h?.action ?? '')}（${String(h?.at ?? '')}）`)
  }
  return best === null ? '机制查不到你产出过任何东西（无交接物 / 无席位提交 / 无水位自报 / 无流水）' : best.text
}

/**
 * ★ "最后一次进展"的**带兜底**口径（与巡检同源，只多一条链尾）。
 *
 * `patrol.lastProgressAtMs` 拿不到任何时间戳时返回 `null` 并且**不猜**（那是巡检的纪律：
 * 拿不到就不判）。孤儿判据不能这么早退出 —— 4a2dc7 那种"只有 3 行流水"的单，
 * 链尾的 `updated_at` / `created_at` 就是唯一可用的起点，而**没有起点就永远判不出"没人管"**。
 * 所以这里显式往下退，并把**用了哪一个来源**一起返回（可审计，不假装是"最后一次进展"）。
 *
 * @returns {{atMs:number|null, source:string}}
 */
export function lastEvidenceAtMs(task) {
  const p = lastProgressAtMs(task)
  if (p !== null) return { atMs: p, source: 'last-progress' }
  const u = msOf(task?.updated_at)
  if (u !== null) return { atMs: u, source: 'updated_at（台账里没有任何进展类时间戳）' }
  const c = msOf(task?.created_at)
  if (c !== null) return { atMs: c, source: 'created_at（台账里没有任何进展类时间戳）' }
  return { atMs: null, source: '读不到' }
}

/** 整单层面"零证据"吗（交付物 / 制品 / 记录 / 水位 / 席位提交全空 + 流水里没有非 main 的执行者）。 */
export function zeroEvidenceOf(task) {
  const empty = (v) => !Array.isArray(v) || v.length === 0
  const subs = task?.writer_submissions
  const noSubs = subs === null || subs === undefined || (typeof subs === 'object' && Object.keys(subs).length === 0)
  const handoffsEmpty = empty(task?.handoffs)
  const artifactsEmpty = empty(task?.artifacts)
  const recordsEmpty = empty(task?.records)
  const ctxEmpty = empty(task?.context_reports)
  const history = Array.isArray(task?.history) ? task.history : []
  const actors = new Set(history.map((h) => String(h?.actor ?? '')))
  const onlyMain = [...actors].every((a) => a === '' || a === 'main')
  return {
    zero: handoffsEmpty && artifactsEmpty && recordsEmpty && ctxEmpty && noSubs && onlyMain,
    handoffs: Array.isArray(task?.handoffs) ? task.handoffs.length : 0,
    artifacts: Array.isArray(task?.artifacts) ? task.artifacts.length : 0,
    records: Array.isArray(task?.records) ? task.records.length : 0,
    context_reports: Array.isArray(task?.context_reports) ? task.context_reports.length : 0,
    writer_submissions: noSubs ? 0 : Object.keys(subs).length,
    actors: [...actors].filter((a) => a.length > 0),
  }
}

/**
 * ★★ **候选判定**（纯函数；孤儿判据里除"崩没崩"以外的全部）。
 *
 * 单开一个函数的原因：`runFailure` 的取证要**解压会话日志**（贵），
 * 所以运行期先用这个便宜的函数筛出候选，**只对候选**去调 `store.detectRunFailure`。
 *
 * @param {object} spec
 * @param {object|null} spec.task
 * @param {number} [spec.now]
 * @param {number} [spec.graceMs]
 * @param {object|null} [spec.activity] - `sampleSeatActivity().seats`（**没有就是 null，不是空对象**）
 * @param {object|null} [spec.prevSamples] - `task.liveness.samples`（上次采样的基线）
 * @param {number|null} [spec.lastDeliveryAtMs] - 最近一次"投给席位的唤醒"时刻（账本里读）
 * @param {object} [spec.activityOpts]
 * @returns {{candidate:boolean, skip:object|null, state:string, seats:Array<object>, last:object, zero:object, graceMs:number}}
 */
export function orphanCandidate(spec = {}) {
  const now = Number.isFinite(spec.now) ? spec.now : Date.now()
  const graceMs = Number.isFinite(spec.graceMs) && spec.graceMs >= 0 ? spec.graceMs : DEFAULT_ORPHAN_GRACE_MS
  /**
   * ★ 一律在**判据视图**上判（剔掉机制自己的记账行）—— 理由见
   *   {@link MECHANISM_BOOKKEEPING_ACTIONS}：不剔的话，投过一次之后这张单就再也不会
   *   被认作孤儿（失败也永不重试），而幂等键会被自己的留痕顶得一跳一跳的。
   */
  const task = judgeView(spec.task !== null && typeof spec.task === 'object' ? spec.task : null)
  const last = lastEvidenceAtMs(task)
  const zero = zeroEvidenceOf(task)
  const base = { candidate: false, skip: null, state: String(task?.state ?? ''), seats: [], last, zero, graceMs }
  if (task === null) return { ...base, skip: { reason: 'no-task', detail: '任务读不到 —— 本次不判（不猜）。' } }

  const state = String(task.state ?? '')
  if (TERMINAL_STATES.includes(state)) {
    return { ...base, skip: { reason: 'terminal-state', detail: `任务已是终态「${STATE_LABEL[state] ?? state}」—— 没有"没人管"这回事。` } }
  }
  if (ORPHAN_IDLE_STATES.includes(state)) {
    return { ...base, skip: { reason: 'waiting-for-human', detail: `任务停在「${STATE_LABEL[state] ?? state}」（等人）—— 没人说话是**正常闲置**，不是孤儿。` } }
  }
  if (!ORPHAN_ELIGIBLE_STATES.includes(state)) {
    return { ...base, skip: { reason: 'state-not-orphan-eligible', detail: `状态「${state || '(空)'}」不在孤儿可判状态面内（还没派活 / 等关单之类，没人动是流程正常形态）。` } }
  }

  /**
   * ★ **`blocked` 只有在"这次阻塞是机制自己触发的"时才算孤儿候选**。
   *
   * 判据（写在数据上，不是写在善意里）：`task.liveness.escalations` 的最后一条
   * `to_state === 'blocked'` —— 那条记录是 `store.checkLiveness` 的处置写下的，
   * 上面还带着它判死的席位名单（`seats`）。于是：
   *   · 机制阻塞 ⇒ 席位本来就死了 ⇒ **正是孤儿**（a5fe41 的形状）；
   *   · 人叫停（main/human 的 `block`）⇒ 那是在**等人**，再投一次就是骚扰 ⇒ 不判。
   */
  let responsible = Array.isArray(EXPECTED_ROLES_BY_STATE[state]) ? [...EXPECTED_ROLES_BY_STATE[state]] : []
  let blockedByMechanism = false
  if (state === 'blocked') {
    const escs = Array.isArray(task?.liveness?.escalations) ? task.liveness.escalations : []
    const lastEsc = escs.length > 0 ? escs[escs.length - 1] : null
    if (lastEsc === null || String(lastEsc?.to_state ?? '') !== 'blocked') {
      return { ...base, skip: { reason: 'blocked-by-human', detail: '任务处于「已阻塞」，但阻塞不是机制触发的（没有失联处置记录）—— 那是**等人**，不是孤儿。' } }
    }
    blockedByMechanism = true
    responsible = Array.isArray(lastEsc.seats) && lastEsc.seats.length > 0
      ? lastEsc.seats.map((k) => String(k).split('#')[0])
      : responsible
  }

  const stalled = last.atMs === null ? null : Math.max(0, now - last.atMs)
  if (stalled !== null && stalled < graceMs) {
    return {
      ...base,
      skip: { reason: 'within-grace', detail: `距最后一次进展只有 ${formatDuration(stalled)}（判定窗 ${formatDuration(graceMs)}）—— 还在窗口内，不判。` },
    }
  }
  /**
   * ★ 刚被**正常唤醒过**（A6/A7 的席位侧投递还在账本里、还没被接管）⇒ 不判孤儿。
   *   这一条就是"别把'我刚叫过它'读成'它没人管'"。
   */
  if (Number.isFinite(spec.lastDeliveryAtMs) && now - spec.lastDeliveryAtMs < graceMs) {
    return {
      ...base,
      skip: {
        reason: 'delivered-recently',
        detail: `机制在 ${formatDuration(now - spec.lastDeliveryAtMs)} 前刚给该席位投过一条唤醒（账本里有记录）—— 给它时间，不判孤儿。`,
      },
    }
  }

  const dispatched = Array.isArray(task?.dispatched) ? task.dispatched : []
  const seats = []
  for (const role of responsible.length > 0 ? responsible : ['']) {
    if (role.length === 0) continue
    const rec =
      dispatched.find((x) => String(x?.role ?? '') === role && (x?.seat === null || x?.seat === undefined || String(x.seat).length === 0)) ??
      dispatched.find((x) => String(x?.role ?? '') === role) ??
      null
    const seat = typeof rec?.seat === 'string' && rec.seat.length > 0 ? rec.seat : null
    const key = seatKey(role, seat)
    const act = activityOfSamples(spec.prevSamples?.[key] ?? null, spec.activity?.[key]?.sample ?? null, spec.activityOpts ?? {})
    const evidence = evidenceOfLife(task, { role, seat, atMs: typeof rec?.at_ms === 'number' ? rec.at_ms : msOf(rec?.at) })
    const alive = act.grew === true
    const sessionPresent = spec.activity === null || spec.activity === undefined ? null : spec.activity[key]?.present === true
    const sessionGone =
      spec.activity === null || spec.activity === undefined
        ? null // 本次**拿不到**活动证据 —— 不许当成"日志不在"（那是把"查不到"说成"死了"）
        : spec.activity[key]?.present !== true
    /** 「不再变化」：实测过、且结论是"没长"（conclusive 是 2026-10-13 快修补的语义）。 */
    const sessionStatic = act.known === true && act.conclusive === true && act.grew === false
    seats.push({
      key,
      role,
      seat,
      dispatched: rec !== null,
      session_id: rec === null ? null : (typeof rec.session_id === 'string' && rec.session_id.length > 0 ? rec.session_id : (rec.agent_id ?? null)),
      dispatched_at: rec?.at ?? null,
      evidence,
      alive,
      activity: { known: act.known, grew: act.grew, conclusive: act.conclusive, reason: act.reason, delta_bytes: act.delta_bytes },
      session_present: sessionPresent,
      session_gone: sessionGone,
      session_static: sessionStatic,
      last_output: lastSeatOutput(task, role, seat),
      /** ★ 这个席位**够格算"被切断"**吗（三条并存：不在动 + 无活证据 + 会话没了/不再变化）。 */
      cut_off: !alive && evidence === null && (sessionGone === true || sessionStatic || rec === null || (rec.session_id ?? rec.agent_id ?? null) === null),
    })
  }

  const cutOff = seats.filter((s) => s.cut_off === true)
  /**
   * ★★ **候选 = "席位被切断" 或 "整单没人管"**。
   *
   * ⚠️ 第二条（整单零证据）**必须同时要求"没有任何席位还活着、也没有任何活证据"** ——
   *   否则"刚派完活、席位正在读文件、还没交任何东西"那种**正常进行中**的形状会被判成孤儿
   *   （零证据在开工初期是常态）。这一条正是反例 D5（会话还在长）与 D6（已有交接物）
   *   必须挡住的东西。
   */
  const anyAlive = seats.some((s) => s.alive === true)
  const anyEvidence = seats.some((s) => s.evidence !== null)
  const unattended = zero.zero && !anyAlive && !anyEvidence
  const candidate = cutOff.length > 0 || unattended
  return {
    candidate,
    skip: candidate
      ? null
      : {
          reason: anyAlive ? 'session-alive' : 'has-living-evidence',
          detail: anyAlive
            ? '该动席位的会话日志**还在长**（实测）—— 它活着，不是孤儿。'
            : anyEvidence
              ? '该动席位有活着的证据（交接物 / 席位提交 / 水位自报 / 流水 / 已继任）—— 不是孤儿。'
              : '整单虽然还没有交付物，但没有任何"被切断"的证据 —— 不许只凭"还没交东西"就判孤儿。',
        },
    state,
    blocked_by_mechanism: blockedByMechanism,
    responsible,
    seats,
    last,
    zero,
    /** ★ 有没有席位**实测还活着** / 有没有**活着的证据**（两条反例的判据面）。 */
    any_alive: anyAlive,
    any_evidence: anyEvidence,
    /** ★ 判据视图剔掉了几行机制自己的记账行（可审计）。 */
    bookkeeping_filtered: Array.isArray(spec.task?.history) ? spec.task.history.length - (Array.isArray(task?.history) ? task.history.length : 0) : 0,
    stalled_ms: stalled,
    graceMs,
  }
}

/**
 * ★★ **一次孤儿判定**（纯函数：不读盘、不写盘、不抛）。
 *
 * @param {object} spec - 同 {@link orphanCandidate}，另加
 * @param {object|null} [spec.runFailure] - `store.detectRunFailure` 的结论（`found:true` = 崩了）
 * @returns {{findings:Array<object>, skip:object|null, note:string, candidate:object}}
 */
export function orphanVerdict(spec = {}) {
  const cand = orphanCandidate(spec)
  const task = spec.task !== null && typeof spec.task === 'object' ? spec.task : null
  if (!cand.candidate) return { findings: [], skip: cand.skip, note: `不判：${cand.skip?.reason ?? '未知'} —— ${cand.skip?.detail ?? ''}`, candidate: cand }
  const state = cand.state
  const now = Number.isFinite(spec.now) ? spec.now : Date.now()
  const at = isoAt(now)
  const taskId = String(task?.id ?? '')
  const progressedAt = cand.last.atMs === null ? '(读不到)' : isoAt(cand.last.atMs)
  const id = (kind) => `${taskId}|orphan|${kind}|${state}|${cand.last.atMs === null ? 'no-stamp' : isoAt(cand.last.atMs)}`
  const seat = cand.seats.find((s) => s.cut_off === true) ?? cand.seats[0] ?? null
  const findings = []

  /**
   * ★ **先问"它是不是崩了"**（A9：崩 ≠ 闲）。命中 ⇒ 判词是 `seat-turn-aborted`，
   *   **不再**判孤儿 —— 一次中止只该有一条判词，而中止有自己的播报面（A11）。
   */
  if (spec.runFailure !== null && spec.runFailure !== undefined && spec.runFailure.found === true) {
    findings.push({
      id: id('seat-turn-aborted'),
      kind: 'seat-turn-aborted',
      orphan: false,
      task_id: taskId,
      state,
      state_zh: STATE_LABEL[state] ?? state,
      seat,
      at,
      evidence: { run_failure: { source: String(spec.runFailure.source ?? ''), note: String(spec.runFailure.note ?? ''), detail: spec.runFailure.evidence ?? null }, activity: seat?.activity ?? null },
      reason: '席位**运行失败中止**（模型输出层故障，例如 tool input is invalid JSON / MALFORMED_RESPONSE）—— 与"被切断"是两条判词（A9）。',
      detail:
        `任务「${STATE_LABEL[state] ?? state}」上的席位${seat === null ? '' : `「${roleLabel(seat.role)}${seat.seat === null ? '' : `（${seat.seat}）`}」`}` +
        `**本轮运行失败中止**（不是闲置、也不是被切断）：${String(spec.runFailure.note ?? '')}`,
      message: '',
      redeliver: false,
    })
    return { findings, skip: null, note: `判为**运行失败中止**（1 条，不判孤儿、不重投 —— A11 有自己的播报面）。`, candidate: cand }
  }

  const cutOffSeats = cand.seats.filter((s) => s.cut_off === true)
  if (cutOffSeats.length > 0) {
    const why = cutOffSeats
      .map((s) => {
        const who = `${roleLabel(s.role)}${s.seat === null ? '' : `（${s.seat}）`}`
        const bits = []
        if (s.dispatched !== true) {
          bits.push('**派活台账里根本没有这一条**（没派出去 / 派活没落盘 ⇒ 连"它在哪个会话"都不知道）')
        } else if (s.session_id === null) {
          bits.push('派活台账里**没有会话 id**（session_id / agent_id 都是空的）')
        } else {
          if (s.session_gone === true) bits.push(`会话 ${String(s.session_id)} 的 \`${SESSION_LOG_NAME}\` **在候选会话根下找不到**`)
          if (s.session_static) bits.push(`会话日志经实测**不再变化**（${String(s.activity?.reason ?? '')}）`)
          if (s.session_gone === null) bits.push('本次**拿不到**会话活动证据（拿不到 ≠ 它死了 —— 这一支只作弱证据）')
        }
        if (s.alive !== true) bits.push('且没有任何活着的证据（0 交接物 / 0 席位提交 / 0 水位自报 / 无该角色流水）')
        return `${who}：${bits.join('；')}`
      })
      .join('\n  · ')
    findings.push({
      id: id('orphan-seat-gone'),
      kind: 'orphan-seat-gone',
      orphan: true,
      task_id: taskId,
      state,
      state_zh: STATE_LABEL[state] ?? state,
      seat: cutOffSeats[0],
      seats: cutOffSeats,
      at,
      stalled_ms: cand.stalled_ms,
      evidence: {
        last_evidence_at: progressedAt,
        last_evidence_source: cand.last.source,
        seats: cutOffSeats.map((s) => ({
          key: s.key,
          dispatched: s.dispatched,
          session_id: s.session_id,
          session_present: s.session_present,
          activity: s.activity,
          evidence: s.evidence,
        })),
        zero_evidence: cand.zero,
      },
      reason: '席位会话被切掉 / 消失（会话文件不在、或不再变化且无任何活着证据）—— 这就是"孤儿"的判据。',
      detail:
        `★ **孤儿单**：任务「${STATE_LABEL[state] ?? state}」停在非终态，` +
        `自 ${progressedAt}（来源：${cand.last.source}）起已经 **${cand.stalled_ms === null ? '未知时长' : formatDuration(cand.stalled_ms)}** 没有任何进展，` +
        `而该动的席位**已经被切断或消失**：\n  · ${why}`,
      message: '',
      redeliver: true,
    })
    return { findings, skip: null, note: `判为**孤儿（席位会话被切断/消失）**：${cutOffSeats.map((s) => s.key).join('、')}。`, candidate: cand }
  }

  if (cand.zero.zero && cand.any_alive !== true && cand.any_evidence !== true) {
    findings.push({
      id: id('orphan-task-unattended'),
      kind: 'orphan-task-unattended',
      orphan: true,
      task_id: taskId,
      state,
      state_zh: STATE_LABEL[state] ?? state,
      seat,
      seats: cand.seats,
      at,
      stalled_ms: cand.stalled_ms,
      evidence: { last_evidence_at: progressedAt, last_evidence_source: cand.last.source, zero_evidence: cand.zero },
      reason: '任务停在非终态、长时间没有任何交接物 / 流水 / 水位自报 —— 即使判不出原因，也能识别"这单没人管了"。',
      detail:
        `★ **孤儿单**：任务「${STATE_LABEL[state] ?? state}」停在非终态，` +
        `自 ${progressedAt}（来源：${cand.last.source}）起已经 **${cand.stalled_ms === null ? '未知时长' : formatDuration(cand.stalled_ms)}** 没有任何进展，` +
        `并且**整单零证据**：交接物 0 / 制品 0 / 记录 0 / 水位自报 0 / 席位提交 0，流水里的执行者只有 ${cand.zero.actors.join('、') || '(无)'}。` +
        `该动的角色：${(cand.responsible ?? []).map((r) => roleLabel(r)).join('、') || '(无)'}。`,
      message: '',
      redeliver: true,
    })
    return { findings, skip: null, note: '判为**孤儿（没人管：整单零证据）**。', candidate: cand }
  }

  return {
    findings: [],
    skip: { reason: 'has-living-evidence', detail: '该动席位有活证据，且整单不是零证据 —— 不判孤儿。' },
    note: '不判：有活证据。',
    candidate: cand,
  }
}

/**
 * ★ **要投给席位的那条消息**（带上下文：你是谁 / 任务在哪 / 你上次停在哪 / 请继续）。
 *
 * 单独导出的原因：它是本条的**交付物之一**（"重新投递"里的"带上下文"），
 * 必须能被测试逐句断言，而不是埋在投递函数里。
 *
 * @param {{task:object, finding:object}} spec
 * @returns {string}
 */
export function orphanRedeliverMessage(spec = {}) {
  const task = spec.task ?? {}
  const f = spec.finding ?? {}
  const seat = f.seat ?? null
  const role = String(seat?.role ?? '')
  const state = String(task.state ?? '')
  const who = `${roleLabel(role)}${seat?.seat === null || seat?.seat === undefined || String(seat.seat).length === 0 ? '' : `（${seat.seat}）`}`
  const sid = seat?.session_id === null || seat?.session_id === undefined ? '(台账里没有会话 id)' : String(seat.session_id)
  return [
    '【流水线 · 机制自动重投 · 孤儿单自恢复】',
    `你是谁：${who}（会话 ${sid}）。`,
    `任务在哪：${String(task.id ?? '')}　当前状态：${STATE_LABEL[state] ?? state}（\`${state}\`）。`,
    `你上次停在哪：${String(seat?.last_output ?? '（查不到）')}。`,
    `为什么叫醒你：${String(f.reason ?? '')}`,
    String(f.detail ?? ''),
    '请继续：',
    `  1) 先用 pipeline_status { task_id: "${String(task.id ?? '')}" } 重读任务与派活台账（**不要凭记忆**）；`,
    '  2) 接着做你那一份活（你原来的边界与授权面不变）。',
    '  ★ 若当前状态不允许你动手（例如「已阻塞」需要人来解），**请回一条说明是谁挡住的** ——',
    '    静默停在这里正是本机制要消灭的形态。',
    '（这条是**运行时上下文**，不是用户说的话。）',
  ].join('\n')
}

/**
 * ★★ 造一个**孤儿自恢复扫描器**（运行期；判据全在上面的纯函数里）。
 *
 * 它每个周期做四件事（**只做这四件**）：
 *   ① 读任务 + 采样席位会话活动（只读）；
 *   ② 判（纯函数）—— 候选再取证（`detectRunFailure`），然后 `orphanVerdict`；
 *   ③ 对**孤儿**发一条**带上下文**的续做消息（走 `notify_only` 的同一份实现）；
 *   ④ 留痕：审计行（`.pipeline/<任务>/audit.jsonl`）+ 幂等账本（`wake-ledger.jsonl`）
 *      + 一条播报（成功 / 放弃；失败则落 `unresolved` 由**既有巡检**播报）。
 *
 * ★ `deps` 里**没有**"建会话"的任何接口 —— 结构上不可能靠"再派一席"冒充自愈。
 *
 * @param {object} deps
 * @param {object} deps.store - `createTaskStore()` 的实例
 * @param {(spec:{task:object, role:string, seat:string|null, text:string}) => Promise<{ok:boolean, sessionId?:string|null, note?:string}>} deps.notify
 *   **必填**：`createSeatNotifier(deps).notifyOnly` 的包装（不建会话 / 不改状态 / 失败返回 ok:false）
 * @param {object} [deps.ledger] - `createWakeLedger()` 的实例（幂等与失败留痕）
 * @param {(spec:object) => Promise<object>} [deps.wake] - 播报（`wakeup.wake`）
 * @param {(taskId:string, action:string, detail:object) => Promise<void>} [deps.audit] - 只追加审计
 * @param {(task:object, seats:Array<object>) => Promise<object>} [deps.detectRunFailure]
 * @param {() => Promise<Array<{id:string}>>} [deps.listTasks]
 * @param {(task:object, atMs:number) => object} [deps.sampleActivity]
 * @param {number} [deps.intervalMs] @param {number} [deps.graceMs]
 * @param {number} [deps.backoffMs] @param {number} [deps.maxAttempts]
 * @param {(m:string)=>void} [deps.warn]
 */
export function createOrphanRescue(deps = {}) {
  const store = deps.store ?? null
  const ledger = deps.ledger ?? null
  const notify = typeof deps.notify === 'function' ? deps.notify : null
  const wake = typeof deps.wake === 'function' ? deps.wake : null
  const audit = typeof deps.audit === 'function' ? deps.audit : null
  const detectRunFailure = typeof deps.detectRunFailure === 'function' ? deps.detectRunFailure : null
  const sampleActivity = typeof deps.sampleActivity === 'function' ? deps.sampleActivity : (task, atMs) => sampleSeatActivity(task, atMs)
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0 ? deps.intervalMs : DEFAULT_ORPHAN_SWEEP_MS
  const graceMs = Number.isFinite(deps.graceMs) && deps.graceMs >= 0 ? deps.graceMs : DEFAULT_ORPHAN_GRACE_MS
  const backoffMs = Number.isFinite(deps.backoffMs) && deps.backoffMs >= 0 ? deps.backoffMs : DEFAULT_REDELIVER_BACKOFF_MS
  const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : DEFAULT_MAX_REDELIVER_ATTEMPTS
  const activityOpts = {
    minBytes: Number.isInteger(deps.activityMinBytes) ? deps.activityMinBytes : DEFAULT_ACTIVITY_MIN_BYTES,
    maxMs: Number.isInteger(deps.activityMaxMs) ? deps.activityMaxMs : DEFAULT_ACTIVITY_MAX_MS,
    freshMs: Number.isInteger(deps.activityFreshMs) ? deps.activityFreshMs : DEFAULT_ACTIVITY_FRESH_MS,
  }

  let timer = null
  let inFlight = false
  /** 最近一次扫描的结论（只读导出 / 排障用；有界）。 */
  let lastReport = { at: null, scanned: 0, candidates: 0, orphans: 0, new_orphans: 0, skipped: [], actions: [], note: '尚未扫描' }
  const stats = {
    sweeps: 0,
    scanned: 0,
    candidates: 0,
    /** 本轮识别到的孤儿条数（**含"已处理过、这次不动手"的那些** —— 识别与动作是两件事）。 */
    orphans: 0,
    /** 本轮**真的发起了动作**（重投 / 报失败 / 放弃）的条数。 */
    new_orphans: 0,
    aborted: 0,
    redelivered: 0,
    redeliver_failed: 0,
    abandoned: 0,
    skipped: 0,
    not_judged: 0,
    last_sweep_at: null,
    last_error: null,
    grace_ms: graceMs,
    backoff_ms: backoffMs,
    max_attempts: maxAttempts,
    interval_ms: intervalMs,
  }

  /** 只追加审计（**不碰 task.json** —— 那会被算成"有新进展"，自己把自己的计时清零）。 */
  async function noteAudit(taskId, action, detail) {
    if (audit === null) return
    try {
      await audit(String(taskId), action, detail)
    } catch (err) {
      warn(`[pipeline] 孤儿自恢复留痕失败（不影响本次判定与投递）：${String(err?.message ?? err)}`)
    }
  }

  /** 播报（**绝不抛**；播不出去也只是少一条可见面，机制照旧）。 */
  async function broadcast(task, finding, kind, what, note) {
    if (wake === null) return
    try {
      await wake({
        taskId: String(task?.id ?? ''),
        actorRole: 'mechanism',
        actorSeat: null,
        kind,
        what,
        disc: String(finding?.id ?? ''),
        identitySource: 'orphan-rescue',
        task,
        note,
        via: 'orphan-rescue',
      })
    } catch (err) {
      warn(`[pipeline] 孤儿自恢复播报失败（下一轮照旧）：${String(err?.message ?? err)}`)
    }
  }

  /** 该身份已经失败过几次（**从账本里数** —— 跨进程有效，不新开计数器）。 */
  function attemptsOf(taskId, id) {
    if (ledger === null || typeof ledger.unresolvedEntries !== 'function') return { attempts: 0, lastAtMs: null }
    let attempts = 0
    let lastAtMs = null
    for (const e of ledger.unresolvedEntries({ taskId, limit: 200 })) {
      if (String(e?.detail?.id ?? '') !== id) continue
      attempts += 1
      const t = msOf(e?.at)
      if (t !== null && (lastAtMs === null || t > lastAtMs)) lastAtMs = t
    }
    return { attempts, lastAtMs }
  }

  /** 这个身份还该动手吗（三道闸：已成功 / 已放弃 / 退避未到）。 */
  function gateFor(taskId, finding, nowMs) {
    if (ledger === null) return { action: 'go', attempts: 0, why: '没有账本（自测/排障形态）—— 本次直接投，不做跨进程去重。' }
    if (typeof ledger.hasDelivered === 'function' && ledger.hasDelivered(finding.id) === true) {
      return { action: 'skip', attempts: 0, why: '这一条孤儿身份**已经成功重投过**（账本里有键）—— 同一条不重投。' }
    }
    if (typeof ledger.escalatedEntry === 'function' && ledger.escalatedEntry(finding.id) !== null) {
      return { action: 'skip', attempts: 0, why: '这一条孤儿身份**已经放弃**（连续投不出去到上限）—— 不再骚扰。' }
    }
    const { attempts, lastAtMs } = attemptsOf(taskId, finding.id)
    if (attempts >= maxAttempts) return { action: 'abandon', attempts, why: `已经投失败 ${attempts} 次（上限 ${maxAttempts}）` }
    if (attempts > 0 && lastAtMs !== null && nowMs - lastAtMs < backoffMs) {
      return { action: 'wait', attempts, why: `上一次投失败在 ${formatDuration(nowMs - lastAtMs)} 前（退避 ${formatDuration(backoffMs)}）—— 本轮不重试` }
    }
    return { action: 'go', attempts, why: '' }
  }

  async function rescueOne(task, finding, nowMs) {
    const taskId = String(task?.id ?? '')
    const seat = finding.seat ?? null
    const gate = gateFor(taskId, finding, nowMs)
    if (gate.action === 'skip' || gate.action === 'wait') {
      stats.skipped += 1
      return { id: finding.id, action: gate.action, note: gate.why }
    }
    if (gate.action === 'abandon') {
      stats.abandoned += 1
      await noteAudit(taskId, 'orphan:redeliver-abandoned', { orphan_id: finding.id, kind: finding.kind, attempts: gate.attempts, reason: gate.why })
      if (ledger !== null && typeof ledger.markEscalated === 'function') {
        ledger.markEscalated({ key: finding.id, escalationKey: `${finding.id}|abandoned|${gate.attempts}`, reason: gate.why, at: isoAt(nowMs) })
      }
      await broadcast(task, finding, 'orphan-abandoned', '**孤儿单自恢复：投不出去（已放弃）**',
        `任务 ${taskId} 的孤儿身份 \`${finding.id}\` 连续 ${gate.attempts} 次都没投出去（上限 ${maxAttempts}）—— **再投也不会成功**，停手并在此留痕。\n` +
        `★ 这是**看得见的失败**（不是静默）：席位侧会话可能已经不在了；这条只能由人在 GUI 里处置（重派同一席位 / 取消该单）。`)
      return { id: finding.id, action: 'abandon', note: gate.why }
    }

    await noteAudit(taskId, 'orphan:detected', {
      orphan_id: finding.id,
      kind: finding.kind,
      state: finding.state,
      stalled_ms: finding.stalled_ms ?? null,
      seat: seat?.key ?? null,
      session_id: seat?.session_id ?? null,
      session_present: seat?.session_present ?? null,
      evidence: finding.evidence ?? null,
      gate_before: gate.why,
    })
    const text = orphanRedeliverMessage({ task, finding })
    /**
     * ★ **连收件人都判不出来**（状态没有唯一责任人 / 阻塞记录里没有席位名单）⇒
     *   这是一条"投不出去"，**如实报**，而不是拿 `role: ''` 去调投递（那会得到一句
     *   含糊的失败，事后没人知道是"不知道投给谁"还是"通道坏了"）。
     */
    if (seat === null || String(seat.role ?? '').length === 0) {
      const reason = '判不出该投给谁：该状态下没有唯一责任人（也没有可用的失联处置记录）—— **没有投递**。'
      stats.redeliver_failed += 1
      await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, kind: finding.kind, reason, message: text })
      if (ledger !== null && typeof ledger.noteUnresolved === 'function') {
        ledger.noteUnresolved({
          at: isoAt(nowMs),
          task_id: taskId,
          kind: 'orphan-rescue',
          actor: 'mechanism',
          reason,
          detail: { id: finding.id, role: null, seat: null, session_id: null, attempt: gate.attempts + 1, max_attempts: maxAttempts },
        })
      }
      return { id: finding.id, action: 'failed', note: reason }
    }
    if (notify === null) {
      stats.redeliver_failed += 1
      await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, reason: '本进程没有装配投递通道（notify 未注入）—— 没有投递。' })
      return { id: finding.id, action: 'failed', note: 'notify 未装配' }
    }
    let r = null
    try {
      r = await notify({ task, role: String(seat?.role ?? ''), seat: seat?.seat ?? null, text })
    } catch (err) {
      r = { ok: false, sessionId: null, note: `投递异常：${String(err?.message ?? err)}` }
    }
    if (r !== null && r.ok === true) {
      stats.redelivered += 1
      if (ledger !== null && typeof ledger.record === 'function') {
        ledger.record({
          key: finding.id,
          task_id: taskId,
          kind: finding.kind,
          actor: 'mechanism',
          at: isoAt(nowMs),
          target: String(r.sessionId ?? ''),
          identity_source: 'orphan-rescue',
          event_at: isoAt(finding.stalled_ms === null ? nowMs : nowMs - finding.stalled_ms),
        })
      }
      await noteAudit(taskId, 'orphan:redelivered', { orphan_id: finding.id, kind: finding.kind, seat: seat?.key ?? null, target_session: String(r.sessionId ?? ''), note: String(r.note ?? ''), message: text })
      await broadcast(task, finding, 'orphan-redelivered', '**孤儿单自恢复：已重新投递**',
        `识别到孤儿单 \`${taskId}\`（${finding.reason}），已**自己重新投递**给「${roleLabel(String(seat?.role ?? ''))}${seat?.seat === null || seat?.seat === undefined || String(seat?.seat).length === 0 ? '' : `（${seat.seat}）`}」的会话 ${String(r.sessionId ?? '')}。\n` +
        `判据：${String(finding.detail ?? '')}\n★ 未新建任何席位（结构上就没有那条通道）；同一条孤儿身份不会再投第二次。`)
      return { id: finding.id, action: 'redelivered', note: String(r.note ?? '') }
    }
    const reason = String(r?.note ?? '投递返回了 ok:false 且没给原因')
    stats.redeliver_failed += 1
    await noteAudit(taskId, 'orphan:redeliver-failed', { orphan_id: finding.id, kind: finding.kind, seat: seat?.key ?? null, session_id: seat?.session_id ?? null, reason })
    /**
     * ★ **投不出去 = 看得见的失败**：落进账本的 `unresolved` ⇒ **既有巡检**那条
     *   `unresolved-wake` 会把它播报出去（不新开播报面，也不静默）。
     */
    if (ledger !== null && typeof ledger.noteUnresolved === 'function') {
      ledger.noteUnresolved({
        at: isoAt(nowMs),
        task_id: taskId,
        kind: 'orphan-rescue',
        actor: 'mechanism',
        reason,
        detail: { id: finding.id, role: seat?.role ?? null, seat: seat?.seat ?? null, session_id: seat?.session_id ?? null, attempt: gate.attempts + 1, max_attempts: maxAttempts },
      })
    }
    return { id: finding.id, action: 'failed', note: reason }
  }

  async function runOnce() {
    if (inFlight) return { ok: true, skipped: true, note: '上一次扫描还在跑 —— 跳过这一次。' }
    inFlight = true
    stats.sweeps += 1
    const at = isoAt(Date.now())
    const actions = []
    const skipped = []
    try {
      const list = typeof deps.listTasks === 'function'
        ? await deps.listTasks()
        : store !== null && typeof store.list === 'function' ? await store.list() : []
      let scanned = 0
      let candidates = 0
      let orphans = 0
      let newOrphans = 0
      for (const entry of Array.isArray(list) ? list : []) {
        const id = String(entry?.id ?? '')
        if (id.length === 0) continue
        const task = store !== null && typeof store.get === 'function' ? await store.get(id) : null
        if (task === null) continue
        scanned += 1
        const nowMs = Date.now()
        let activity = null
        try {
          activity = sampleActivity(task, nowMs)
        } catch (err) {
          activity = null
          warn(`[pipeline] 孤儿自恢复：席位活动采样失败（本次按"拿不到活动证据"处理，**不猜**）：${String(err?.message ?? err)}`)
        }
        const deliveries = ledger !== null && typeof ledger.pendingSeatDeliveries === 'function'
          ? ledger.pendingSeatDeliveries({ taskId: id, limit: 20 })
          : []
        const lastDeliveryAtMs = deliveries.reduce((acc, e) => {
          const t = msOf(e?.at)
          return t !== null && (acc === null || t > acc) ? t : acc
        }, null)
        const spec = {
          task,
          now: nowMs,
          graceMs,
          activity: activity === null ? null : activity.seats ?? null,
          prevSamples: task?.liveness?.samples ?? null,
          lastDeliveryAtMs,
          activityOpts,
        }
        const cand = orphanCandidate(spec)
        if (!cand.candidate) {
          stats.not_judged += 1
          if (skipped.length < 12 && cand.skip !== null) skipped.push({ task_id: id, reason: cand.skip.reason, detail: cand.skip.detail })
          continue
        }
        candidates += 1
        let runFailure = null
        if (detectRunFailure !== null) {
          try {
            runFailure = await detectRunFailure(task, cand.seats.filter((s) => s.alive !== true))
          } catch (err) {
            warn(`[pipeline] 孤儿自恢复：运行失败取证异常（按"没有失败证据"处理，退回孤儿判据）：${String(err?.message ?? err)}`)
            runFailure = null
          }
        }
        const res = orphanVerdict({ ...spec, runFailure })
        if (res.findings.length === 0) {
          stats.not_judged += 1
          if (skipped.length < 12 && res.skip !== null) skipped.push({ task_id: id, reason: res.skip.reason, detail: res.skip.detail })
          continue
        }
        for (const f of res.findings) {
          if (f.kind === 'seat-turn-aborted') {
            stats.aborted += 1
            await noteAudit(id, 'orphan:turn-aborted', { orphan_id: f.id, seat: f.seat?.key ?? null, run_failure: f.evidence?.run_failure ?? null })
            actions.push({ task_id: id, kind: f.kind, action: 'not-orphan', note: '运行失败中止（A9/A11 有自己的播报面）—— 本机制**不判孤儿、不重投**。' })
            continue
          }
          orphans += 1
          const outcome = await rescueOne(task, f, nowMs)
          if (['redelivered', 'failed', 'abandon'].includes(String(outcome.action))) newOrphans += 1
          actions.push({ task_id: id, kind: f.kind, ...outcome })
        }
      }
      stats.scanned += scanned
      stats.candidates += candidates
      stats.orphans += orphans
      stats.new_orphans += newOrphans
      stats.last_sweep_at = at
      stats.last_error = null
      lastReport = {
        at,
        scanned,
        candidates,
        orphans,
        new_orphans: newOrphans,
        skipped,
        actions,
        note: `扫描 ${scanned} 张单；候选 ${candidates}；识别孤儿 ${orphans}（其中本轮发起动作 ${newOrphans}）；动作 ${actions.length} 条。`,
      }
      return { ok: true, ...lastReport }
    } catch (err) {
      stats.last_error = String(err?.message ?? err)
      warn(`[pipeline] 孤儿自恢复本轮抛错（不会停摆，下一轮继续）：${stats.last_error}`)
      lastReport = { at, scanned: 0, candidates: 0, orphans: 0, new_orphans: 0, skipped, actions, note: `本轮抛错：${stats.last_error}` }
      return { ok: false, ...lastReport }
    } finally {
      inFlight = false
    }
  }

  return {
    intervalMs,
    stats,
    runOnce,
    running: () => timer !== null,
    lastReport: () => lastReport,
    status() {
      return {
        ok: stats.last_error === null,
        interval_ms: intervalMs,
        grace_ms: graceMs,
        backoff_ms: backoffMs,
        max_attempts: maxAttempts,
        stats: { ...stats },
        last_report: lastReport,
        disabled_reason: notify === null ? '本进程没有装配投递通道（notify 未注入）—— 只会识别、不会投递' : '',
      }
    },
    start() {
      if (timer !== null) return false
      timer = setInterval(() => {
        void runOnce()
      }, intervalMs)
      // ★ 不许因为本机制把进程钉住（DSH 退出时定时器不该拦着）。
      if (typeof timer?.unref === 'function') timer.unref()
      return true
    },
    stop() {
      if (timer === null) return false
      clearInterval(timer)
      timer = null
      return true
    },
  }
}

/**
 * ★ 只追加审计的**默认出口**（与 `lib/liveness.js → createChannelAudit` 同一落点与行格式：
 *   `.pipeline/<任务>/audit.jsonl`，一行一个 JSON 对象）。
 *
 * 为什么不走 `store.recordAudit`：那个会**改 `task.json`**（push `history` + 落盘），
 * 于是"没有进展"的最后进展时刻会被自己刷新 ⇒ 自恢复机制自己把自己的判据喂饱
 * （巡检当初也是靠"不产生进展"避开这个坑的）。
 *
 * @param {(taskId:string)=>string} auditFileOf - 通常就是 `store.auditFile`
 * @param {(m:string)=>void} [log]
 * @returns {(taskId:string, action:string, detail:object)=>Promise<void>}
 */
export function createOrphanAudit(auditFileOf, log = null) {
  return async function record(taskId, action, detail = {}) {
    const id = String(taskId ?? '')
    if (id.length === 0 || typeof auditFileOf !== 'function') return
    const line = { at: new Date().toISOString(), task_id: id, actor: 'mechanism', action: String(action), ...detail }
    try {
      appendFileSync(auditFileOf(id), `${JSON.stringify(line)}\n`, 'utf8')
    } catch (err) {
      // 审计写失败不该让判决本身失败；说出来，不静默。
      if (typeof log === 'function') log(`孤儿自恢复审计写盘失败（判决与投递不受影响）：${String(err?.message ?? err)}`)
    }
  }
}
