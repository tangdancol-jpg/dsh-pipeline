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

// ---------------------------------------------------------------------------
// 文件布局：本文件只做转出，实现按主题拆在 `lib/orphan/` 下（对外导出名与拆分前逐一相同）
//   orphan/constants.js  判定窗 / 退避 / 次数、可判状态面、判词表、机制记账动作名
//   orphan/evidence.js   判据视图、席位活动采样、最后一次产出、最后证据时刻、整单零证据
//   orphan/verdict.js    只读目录、候选判定、孤儿判定、重投正文
//   orphan/rescue.js     扫描器 createOrphanRescue 与只追加审计 createOrphanAudit
// ---------------------------------------------------------------------------

export {
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_REDELIVER_BACKOFF_MS,
  DEFAULT_MAX_REDELIVER_ATTEMPTS,
  DEFAULT_ORPHAN_SWEEP_MS,
  ORPHAN_IDLE_STATES,
  ORPHAN_ELIGIBLE_STATES,
  ORPHAN_KINDS,
  MECHANISM_BOOKKEEPING_ACTIONS,
} from './orphan/constants.js'

export {
  judgeView,
  sampleSeatActivity,
  lastSeatOutput,
  lastEvidenceAtMs,
  zeroEvidenceOf,
} from './orphan/evidence.js'

export {
  orphanCatalog,
  orphanCandidate,
  orphanVerdict,
  orphanRedeliverMessage,
} from './orphan/verdict.js'

export {
  createOrphanRescue,
  createOrphanAudit,
} from './orphan/rescue.js'
