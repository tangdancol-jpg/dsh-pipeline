/**
 * dsh-pipeline · 任务存储与状态推进（机制的落地点）
 * ============================================================================
 * 这里是把「状态机 + 交接物 + 打回预算 + 制品版本」串成一条**不可绕**的流程
 * 的地方。所有拒绝都返回结构化结果，不抛异常 —— 拒绝是正常结果，不是事故。
 *
 * 落盘布局（需求原文点名要的那种）：
 *
 *   <项目根>/.pipeline/<taskId>/
 *     task.json                 任务卡 + 当前状态 + 角色清单 + 计数器
 *     handoffs/<seq>-<kind>.json 每一份结构化交接物，一份一个文件
 *     artifacts/v<N>/           编写角色登记的制品版本
 *     audit.jsonl                只追加的审计日志（每次动作一行）
 *
 * ★ 只在**任务被打开时**才建目录；没有任务时 `.pipeline/` 不存在。
 * ★ 所有写文件都是「先写临时文件再 rename」，避免半截 JSON 把任务卡写坏。
 *
 * @module dsh-pipeline/lib/store
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { HANDOFF_SCHEMAS, HUMAN_DECISION_KINDS, HUMAN_REASON_KINDS, HUMAN_TIMEOUT_BEHAVIORS, buildHandoffRecord, checkManifestAgainstScope, summarizeHandoff, validateChangeScope, validateHandoff } from './handoff.js'
import { HUB_DIAGRAM_REDRAW_BUDGET, HUB_HANDOFF_CONFIRM_EVENTS, HUB_HANDOFF_CONFIRM_ORDER, HUB_HANDOFF_CONFIRM_STATIONS, HUB_REJECT_EVENT_STATIONS, HUB_STANDBY_SEATS, HUB_STATIONS, HUB_STATION_REJECT_BUDGET, HUB_STATION_REJECT_STATIONS, HUB_WAKE_POINTS, ROLES_CAN_RAISE_HUMAN, ST, STATE_LABEL, TERMINAL_STATES, TRANSITIONS, WAITING_STATES, applyTransition, availableTransitions, hubConfirmersOf, hubWakePointOf, resolveUnblockRecovery } from './states.js'
import { ROLE, canProduceHandoff, roleLabel } from './roles.js'
import {
  DISPATCH_OPEN_ACTION,
  buildRoster,
  dispatchOpenRecord,
  rosterSlotKeys,
  slotRoleNeedsDeclaration,
  validateRoster,
} from './tiers.js'
import { clamp, clip, fullHash, isInside, newTaskId, nowIso, PACKAGE_ROOT, pathKey, randomId, resolveAgainstAnchor, shortHash, toStringArray } from './util.js'
// ★ A9/A11：运行失败中止的**判词**（"崩"与"闲"必须写得不一样）。
import { describeRunFailures } from './runfail.js'
import { LEVELS, checkRelayAuthorization, levelOf, relayEnabled, validateContextReport } from './context.js'
import { nextFullTestStage } from './testscope.js'
import { WRITE_LEDGER_FILE_NAME, WRITE_LEDGER_SOURCES, hashGateEscalationPending, hashGateVerdict, makeWriteLedgerEntry, nextHashGateStreak, parseWriteLedger, renderGateRejection, renderHashGateEscalation, resetHashGateOrigin, shouldEscalateHashGate } from './hashgate.js'
import { DEFAULT_SEAT_SILENCE_MS, LIVENESS_ACTIVITY_SOURCE, SESSION_LOG_NAME, describeSilentSeats, describeSuspectedFalsePositive, findSessionLog, livenessSelfHeal, sampleSessionLog, seatKey, seatLiveness, sessionsRootCandidates, upsertDispatch } from './liveness.js'

/** 用户答复可以走哪些渠道（留痕用；`chat` = 用户在主对话里直接说的）。 */
export const REPLY_CHANNELS = ['chat', 'typed', 'selected', 'relayed', 'other']

/**
 * ★★ **恢复型重入**：`to: '(previous)'` 的那些事件 —— 语义就是「回到被打断前的状态」。
 *
 * 为什么需要它（真单 T-20261011-5a871c）：`transition()` 里那条
 * 「进 developing ⇒ 清空席位提交表」原本是按**状态**判的（`res.to === developing`），
 * 把「恢复」也当成了「开新一轮」。而进 developing 的边有两类：
 *   · `dispatch_writer`（ready_dev / returned_to_dev ⇒ developing）= **新一轮开工**；
 *   · `unblock` / `human_reply` / `clarification_reply`（⇒ `(previous)` = developing）= **同一轮续做**。
 * 于是「block 一下再 unblock」会把**同一轮里已经交过的那几份**悄悄作废：席位白交、
 * 「全部到齐」永远凑不齐，交付也不再算「本轮交付」（`patrol.js:262` 的兜底支看的正是
 * "晚于进 developing 那一刻"）⇒ 任务停在「开发中」、交付躺在盘上、**一条播报都没有**。
 *
 * ⚠️ 名单**从 `TRANSITIONS` 派生**，不手抄第二份：状态表里加一条恢复边，这里自动跟上。
 * ⚠️ 这一支**不放宽任何闸门**：`dispatch_writer`（含打回重做那一次）照旧清空，
 *    「上一轮的提交记录不许冒充本轮已齐」那条反例一个字没动。
 */
const RESUME_EVENTS = new Set(TRANSITIONS.filter((t) => t.to === '(previous)').map((t) => t.event))

/**
 * ★ 答复形状必须与 `decision_kind` 相符。
 *
 * 这条挡的是"主对话替用户拍板"里最隐蔽的一种：**答复的形式根本对不上**。
 * 例如请求问的是"选 A 还是 B"，主对话回一句 `answer: true` ——
 * 那不可能是用户说的，因为用户面前根本没有是非题。
 *
 * @param {object} entry - 请求记录
 * @param {object} input - 调用参数
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function checkAnswerShape(entry, input) {
  const dk = entry.decision_kind
  if (dk === 'yes_no' || dk === 'approve_reject') {
    if (typeof input.answer !== 'boolean') {
      return {
        ok: false,
        error:
          `decision_kind=${dk}：答复必须给布尔值 answer（true/false）。\n` +
          '问题是是非题，用户只能回答"是"或"否" —— 给别的形状说明这条答复不是从那个问题来的。',
      }
    }
    return { ok: true, value: { decision: input.answer, answer_bool: input.answer } }
  }
  if (dk === 'choose_option') {
    const chosen = typeof input.chosenOption === 'string' ? input.chosenOption.trim() : ''
    if (chosen.length === 0) {
      return { ok: false, error: 'decision_kind=choose_option：答复必须给 chosen_option。' }
    }
    const labels = entry.options.map((o) => o.label)
    if (!labels.includes(chosen)) {
      return {
        ok: false,
        error:
          `decision_kind=choose_option：chosen_option=「${chosen}」不在给用户的选项里。\n` +
          `可选：${labels.join(' / ') || '（这条请求没有给选项）'}\n` +
          '★ 选项之外的东西不可能是用户从这个选择题里选出来的。',
      }
    }
    return { ok: true, value: { decision: chosen, chosen_option: chosen } }
  }
  if (dk === 'free_text') {
    const text = typeof input.answerText === 'string' ? input.answerText.trim() : ''
    if (text.length === 0) {
      return { ok: false, error: 'decision_kind=free_text：答复必须给 answer_text。' }
    }
    return { ok: true, value: { decision: clip(text, 200), answer_text: text } }
  }
  return { ok: false, error: `未知的 decision_kind「${dk}」（插件内部错误）。` }
}

/**
 * ★ **授权面变更（amendment）** 允许出现的入参字段 —— 白名单，**fail-closed**。
 *
 * 为什么用白名单而不是"禁列几个敏感字段"：
 *   "只许动授权面"是一句否定式约束，否定式清单永远列不全（明天冒出一个
 *   `seat_order_hint` 就不在列里了）。所以反过来：**只有这几个键认得**，
 *   其余一律当场拒 —— 席位 / 角色清单 / 档位 / 调用顺序 / 层划分碰巧用哪个名字都进不来。
 *
 * ⚠️ 与 `lib/tools.js` 的 `pipeline_scope_amend.parameters` **必须同源**：
 *    声明了却不在白名单里 ⇒ 正规调用会被自己拒掉；白名单里有而没声明 ⇒ 形同虚设。
 */
export const AMEND_ALLOWED_KEYS = ['task_id', 'role_token', 'why', 'note', 'add', 'remove', 'forbidden_add', 'forbidden_remove']

/**
 * 从一次「授权面变更」调用的原始入参里，挑出**不属于授权面**的字段名。
 *
 * @param {unknown} raw - 调用方原样给的参数对象
 * @returns {string[]} 越界的字段名（空数组 = 只带了授权面字段）
 */
export function findNonScopeKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw).filter((k) => !AMEND_ALLOWED_KEYS.includes(k) && raw[k] !== undefined)
}

/** 原子写：先写 `.tmp` 再 rename（同目录 rename 在 NTFS 上是原子的）。 */
async function writeJsonAtomic(file, value) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

async function appendJsonl(file, value) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const line = `${JSON.stringify(value)}\n`
  // 追加写：node 的 append flag 在本地盘上是原子的（单次 write < PIPE_BUF 时）。
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, line, 'utf8')
}

async function readJson(file) {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

/**
 * 一份交接物提交之后，状态该怎么动。
 *
 * 「交接物」与「状态推进」合一是有意的：分开就会出现"交了东西但状态没动"
 * 或者"状态动了但没有交接物"的半截现场，而这两种半截现场没法机械判定。
 * 合一之后，一条断言就能覆盖两者。
 *
 * `leg` 非 null 表示这次推进消耗打回预算。
 *
 * @param {string} kind
 * @param {object} payload
 * @returns {{event:string, leg:'dev'|'test'|null} | null}
 */
export function planAdvance(kind, payload) {
  switch (kind) {
    case 'dev_to_test':
      return { event: 'dev_submitted', leg: null }
    case 'test_to_review':
      return { event: 'test_passed', leg: null }
    case 'review_verdict':
      if (payload?.conclusion === 'OK') return { event: 'review_ok', leg: null }
      // NG：按 reject_to 决定打到谁那儿；两边都消耗打回预算。
      return payload?.reject_to === 'tester' ? { event: 'review_ng_test', leg: 'test' } : { event: 'review_ng_dev', leg: 'dev' }
    case 'test_to_dev':
      return { event: 'test_failed', leg: 'dev' }
    // ★ 本轮新增：计划自检发现缺失 ⇒ **退回需求分析**（第一级澄清梯）。
    //   为什么挂在"交计划"这一刻而不是让 planner 另外发一条澄清请求：
    //   自检结果与回落问题本来就是**同一件事**（缺什么 → 问什么），
    //   分成两步只会在中间制造一个"交了计划但没回流"的半截现场。
    //   状态落到「等待需求分析答复」之后，裁定/升级走的全是既有的那条链。
    case 'plan':
      return payload?.self_check?.verdict === 'gaps' ? { event: 'plan_gap', leg: null } : null
    // ★ 两级升级梯第一级：**只有 blocking 的才推状态**（非阻塞的照样要问，但不打断流程）。
    case 'clarification_request':
      return payload?.blocking === true ? { event: 'clarification_request', leg: null } : null
    // 需求分析的裁定：不管 answered 还是 cannot_answer，都先**恢复状态**
    //（cannot_answer 之后由 orchestrator 再发 human_request 升级，那是另一条边）。
    case 'clarification_reply':
      return { event: 'clarification_reply', leg: null }
    // ★ 人工介入请求：**只有 blocking 的才推状态**。
    //   非阻塞请求（"顺便问一下"）照样进待办、照样要主对话转告，但不打断流程。
    case 'human_request':
      return payload?.blocking === true ? { event: 'human_request', leg: null } : null
    default:
      return null
  }
}

/**
 * ★★ **主管枢纽**下的交接物 → 状态推进（T-20261011-56a37e）。
 *
 * 为什么单独一份、而不是并进 `planAdvance`：`planAdvance` 是**纯函数**（只吃 kind + payload），
 * 而这两条边**只在枢纽任务上存在**。并进去会让所有既有任务的需求分析一交就跳到
 * 「主管受理中」—— 那是把既有链改掉，不是扩展。
 * 所以调用点写成"枢纽任务才问这一份"（见 submitHandoff 的 ⑤）：
 *   未启用枢纽 ⇒ `planAdvance` 原样，一个字节没变。
 *
 * @param {string} kind
 * @returns {{event:string, leg:null} | null}
 */
export function hubAdvanceFor(kind, payload = {}) {
  // 需求结论交主管（状态落到「主管受理中」，等第①道确认）。
  if (kind === 'requirement_analysis') return { event: 'need_to_supervisor', leg: null }
  // 架构图产出 ⇒ 落到「架构图待主管确认」（第②道）。
  if (kind === 'architecture_diagram') return { event: 'diagram_submitted', leg: null }
  /**
   * ★★ P0-1：**需求位确认架构图 ⇒ 递交主管二次确认**（用户新口径第 8 跳前半）。
   *
   * 与上面两条**逐项同构**：`to_role` 由 schema 决定（需求位 → main），
   * 而"这份交接物一交，状态就跟着走"这件事由本函数回答 —— 需求位不需要
   * 第二个工具、也不会出现"记录交了但状态没动"的半截现场。
   *
   * ★ 触发面刻意收窄到三个条件同时成立：`kind=station_confirm` ·
   *   `station=arch_need_confirm` · `decision=ok`。缺任一条 ⇒ 返回 null（走原表）。
   *   于是 ③④ 两站的确认记录、以及任何 `decision='ng'` 的记录**都不会**推动状态。
   *   角色那一道由状态机的 `by: [orchestrator]` 负责（`applyTransition` 会拒非需求位）。
   */
  if (
    kind === 'station_confirm' &&
    String(payload?.station ?? '') === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM &&
    payload?.decision === 'ok'
  ) {
    return { event: HUB_HANDOFF_CONFIRM_EVENTS[HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM], leg: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// ★ 人工介入请求的「登记」—— 唯一实现，两条提交路径与兜底修复共用
// ---------------------------------------------------------------------------
//
// -----------------------------------------------------------------------------
// 现场（2026-10-11，真单 T-20261011-63633e 卡死）
// -----------------------------------------------------------------------------
// 症状：`pipeline_status` 里明明白白列着
//         `[人工介入请求] orchestrator→main - H-e12407f0aeb5afc0`
//       状态机也停在「等待人工答复(awaiting_human)」，
//       但 `pipeline_human_relay`（收件箱）回「没有任何人工介入请求」。
//       ⇒ 主对话**取不出问题**、**也记不回答复** ⇒ 任务永久卡死。
//
// 根因是**两份数据源各写各的**：
//   · `task.handoffs[]`       —— `pipeline_status` 那行「人工介入请求」读的是这里；
//   · `task.human_requests[]` —— relay（转告）与 reply（答复）读的是这里。
// 写第一份的是 `appendHandoff`（store.js 里 `async appendHandoff`，把交接物推进
// `task.handoffs[]` 并落盘），写第二份的是 `submitHandoff` 后半段的
// `this.createHumanRequestEntry(task, record, v.normalized)`。
// **顺序上：先 appendHandoff + persist（交接物已经落盘、状态机已经能推进），
// 后 createHumanRequestEntry。** 于是中间任何一次中断 —— 异常、进程被杀、
// 或者跑着的是"还没有登记那一步"的旧版本代码 —— 都会留下
// **「交接物在盘上、请求登记表是空的」** 这种半截现场。
// 而推进状态那一段只看 `payload.blocking`（与登记表无关），
// 所以半截现场照样能把任务推成 `awaiting_human` —— 卡死就是这么来的。
//
// -----------------------------------------------------------------------------
// 这一节的两条修补（对应现场报告的 ①②）
// -----------------------------------------------------------------------------
// ① **不能只落交接物**：登记改由 `buildHumanRequestEntry` 唯一实现，
//    `createHumanRequestEntry` 与兜底修复都走它 ⇒ 同一个 handoff_id **永不重复登记**。
// ② **兜底**：`reconcileHumanRequests` 能从「交接物 + 状态」反推出缺的那条登记，
//    使收件箱列得出、答复记得回 —— 否则已经卡住的单**救不回来**。
//
// ⚠️ 兜底只**补缺**，绝不覆盖已有记录：答复过的（`answered`）或撤回过的
//    （`withdrawn`）一律保留原样 —— 那正是"主对话不能自行把请求标记为已解决"
//    这条反例的落点（有记录就说明那条链走完了，不该被"修复"回 pending）。

/** 「请求发起时任务处在哪个状态」——用于答复后**回到被打断前的位置**。 */
function humanStateAtRequest(task, pendingEntry) {
  if (WAITING_STATES.includes(task.state) && typeof task.previous_state === 'string') return task.previous_state
  if (pendingEntry !== undefined && task.state === ST.AWAITING_HUMAN) return pendingEntry.state_at_request
  return task.state
}

/**
 * 保证「这份 human_request 交接物」在 `task.human_requests` 里**恰好有一条**登记。
 *
 * 幂等：同一个 `handoff_id` 已经有了就原样返回，不新建、不改写。
 *
 * @returns {{ entry: object, created: boolean }}
 */
function buildHumanRequestEntry(task, record, payload, timeoutHours) {
  const p = payload ?? {}
  const created = typeof p.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.created_at) ? p.created_at : nowIso(new Date())

  // 截止时间：请求自己给了就用它；否则按配置的小时数算；配成 0 = 不设截止。
  let timeoutAt = typeof p.timeout_at === 'string' && p.timeout_at.length > 0 ? p.timeout_at : null
  if (timeoutAt === null && timeoutHours > 0) {
    const t = Date.parse(created)
    if (Number.isFinite(t)) timeoutAt = new Date(t + timeoutHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  // ★ 恢复目标：**被打断前的那个状态**（见 humanStateAtRequest 的注释）。
  const list = Array.isArray(task.human_requests) ? task.human_requests : []
  const pending = list.find((r) => r.status !== 'answered' && r.status !== 'withdrawn')
  const stateAtRequest = humanStateAtRequest(task, pending)

  const entry = {
    request_id: `HR-${shortHash(`${task.id}|${record.handoff_id}|${String(p.question_for_human ?? '')}`)}`,
    handoff_id: record.handoff_id,
    task_id: task.id,
    from_role: p.from_role,
    created_at: created,
    reason_kind: p.reason_kind,
    reason_zh: HUMAN_REASON_KINDS[p.reason_kind] ?? p.reason_kind,
    question_for_human: p.question_for_human,
    context_for_human: typeof p.context_for_human === 'string' ? p.context_for_human : '',
    options: Array.isArray(p.options) ? p.options.map((o) => ({ label: String(o?.label ?? ''), consequence: String(o?.consequence ?? '') })) : [],
    recommended: typeof p.recommended === 'string' ? p.recommended : '',
    blocking: p.blocking === true,
    blocked_stage: typeof p.blocked_stage === 'string' ? p.blocked_stage : '',
    urgency: p.urgency,
    decision_kind: p.decision_kind,
    timeout_behavior: p.timeout_behavior,
    default_option: typeof p.default_option === 'string' ? p.default_option : '',
    timeout_at: timeoutAt,
    state_at_request: stateAtRequest,
    // ★ 升级来源：由需求分析升级上来时才有值（单向门的开关）。
    escalated_from: typeof p.escalated_from === 'string' ? p.escalated_from : null,
    raised_by: typeof p.raised_by === 'string' ? p.raised_by : null,
    orchestrator_reason: typeof p.orchestrator_reason === 'string' ? p.orchestrator_reason : null,
    status: 'pending', // pending → relayed → answered
    relayed_at: null,
    relayed_by: null,
    relay_channel: '',
    relay_note: '',
    relay_count: 0,
    confirm_code: null,
    answered_at: null,
    answer_source: null,
    answer: null,
    resolved_at: null,
    resumed_to: null,
    resumed_from: null,
    /**
     * ★ 兜底修复补的登记会带这个字段（正常路径永不出现）。
     * 为什么要留痕：事后要能回答「这条请求当初是不是没登记上、
     * 是**从交接物反推**回来的」—— 不然一次静默修复就把根因盖住了。
     */
    recovered_from_handoff: false,
  }
  return entry
}

/**
 * ★ **兜底**：把「有交接物、没登记」的人工介入请求补回登记表。
 *
 * 实现在**工厂内部**（`reconcileHumanRequests` / `enforceHumanRequestRegistration`
 * 两个 store 方法）—— 因为它们要落盘（`persist`）与留痕（`audit`），
 * 那是工厂闭包里的东西。这里只留设计说明：
 *
 * ① 先按交接物补全**缺**的登记（`question_for_human` 空的）；
 * ② 若某份 human_request 交接物**完全没有**登记，就按那份交接物重建一条 ——
 *    这是"已经卡住的单也能救回来"的那一步。
 *
 * 为什么第 ① 步是安全的：交接物是**不可变原文**，用它补齐缺字段不会引入新信息。
 * 为什么第 ② 步**不再**加「停在 awaiting_human」这个条件：那条限定只覆盖
 * blocking=true 的请求，**非阻塞请求（blocking=false）永远进不了等待态**，
 * 于是它们一旦漏登记就再也救不回来（真单里点名取不出的三条全是 blocking=false）。
 * 判据回到不可辩驳的那一条：**"有交接物、没登记"本身就是一次没写完的登记**。
 *
 * ⚠️ 绝不触碰 `answered` / `withdrawn` 的记录（见本节开头那条反例）——
 *    它们本来就有条目，落不进"完全没有登记"这一档。
 */

/**
 * ★ 本任务在册的编写席位列表。**单席位也走这里**（count=1 时就是 `['writer#1']`）。
 */
export function writerSeatsOf(task) {
  const w = task?.roster?.writers
  if (w === null || w === undefined || typeof w !== 'object') return ['writer#1']
  const parts = Array.isArray(w.partitions) ? w.partitions : []
  if (parts.length === 0) return ['writer#1']
  return parts.map((p) => p.seat)
}

/**
 * 由某个席位在 roster 里的分区定义。
 * @returns {object|null}
 */
export function seatPartitionOf(task, seat) {
  const w = task?.roster?.writers
  const parts = Array.isArray(w?.partitions) ? w.partitions : []
  return parts.find((p) => p.seat === seat) ?? null
}

/**
 * 会话 id 的形状（宿主真实会话 id 形如 `session-<uuid>`）。
 * 用它回答一个问题：**本任务的活动采样"本来做得到"吗** —— 做得到才启用"连续确认"门
 * （见 `lib/liveness.js` 的 `gateOn`），做不到就退回台账三条判据并如实留痕。
 */
const SESSION_ID_SHAPE = /^session-/

/**
 * ★★ B2：**现采一次会话日志**（每个已派席位一个样本）。
 *
 * 采不到就给 `null`（**不是给空对象**）—— "拿不到活动证据"与"它没动"是两件事，
 * 混起来就会把"查不到"误报成"死了"（这正是 B2 那次误冻的形状）。
 *
 * 会话目录由 `DSH_HOME/sessions` 推出（可用 `sessionsRoot` 覆盖，自测要固定它）；
 * 目录名是工作目录的编码，属宿主实现细节 ⇒ 用 {@link findSessionLog} 扫一层找，
 * 不拼字符串。
 *
 * @param {object|null} task
 * @param {number} atMs
 * @param {number} [maxMs] - 只用于给结果里的人话说明，不改变采样行为
 * @returns {{samples:object|null, note:string, root:string|null, found:number}}
 */
export function sampleSessionActivity(task, atMs, maxMs) {
  /**
   * ★★ **2026-10-13 快修（②，P0-1）：会话根目录改成"候选列表"，不再只认两个环境变量。**
   *
   * 根因（只读诊断报告 §3.3 排除法 + 本次实测复核）：插件进程里 `DSH_SESSIONS_DIR` /
   * `DSH_HOME` 取不到 ⇒ 旧代码在这里就 `root === null` 早退，并**硬编码**
   * `gate_applicable: false` ⇒ 采样从未成功过一次 ⇒ 「会话文件在增长」这条证据恒等于零。
   *
   * 两处改动：
   *   ① 根目录按 {@link sessionsRootCandidates} 逐个试（env → `DSH_HOME/sessions` →
   *      profile 上两级 → `~/.dsh/sessions`），**哪个真的命中日志就以哪个为准**；
   *   ② 「一个都没命中」**不等于**「看得见且没动」⇒ `gate_applicable` 一律按
   *      "台账里有没有真实形状的会话 id"（`samplable`）来定，**不再硬编码 false**。
   *      语义：看得见 ⇒ 由活动判据说话；看不见但有真实会话 ⇒ 走确认门（连续确认才冻）；
   *      结构上本来就没有会话 id（自测替身 / 手搓台账）⇒ 才允许一次观察即判。
   *      ⚠️ 这一支**不放松任何闸门**：静默阈值一毫秒没动，真死席位照旧在有限次观察内冻结。
   */
  const roots = sessionsRootCandidates()
  const root = roots.length > 0 ? roots[0] : null
  const list = Array.isArray(task?.dispatched) ? task.dispatched : []
  const samples = {}
  let found = 0
  let looked = 0
  /** ★ 至少一个已派席位带 `session-…` 形状的会话 id ⇒ 本任务的活动采样"本来做得到"。 */
  let samplable = false
  for (const raw of list) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const sid = typeof raw?.session_id === 'string' && raw.session_id.length > 0
      ? raw.session_id
      : typeof raw?.agent_id === 'string' && raw.agent_id.length > 0
        ? raw.agent_id
        : null
    if (sid === null) continue
    if (SESSION_ID_SHAPE.test(sid)) samplable = true
    looked += 1
    const s = sampleSessionLog(findSessionLog(roots, sid), atMs)
    if (s !== null) {
      samples[seatKey(role, seat)] = s
      found += 1
    }
  }
  const gateApplicable = samplable || found > 0
  if (roots.length === 0) {
    return {
      samples: null,
      note: `一个候选会话根都取不到（DSH_SESSIONS_DIR / DSH_HOME / DSH_PROFILE_DIR / ~/.dsh 全都没有）—— 本次没有活动证据${gateApplicable ? '（但台账里有真实形状的会话 id ⇒ 启用"连续确认"门，不许一次安静就冻结）' : '（且台账里没有真实形状的会话 id ⇒ 不启用"连续确认"门）'}`,
      root: null,
      found: 0,
      gate_applicable: gateApplicable,
    }
  }
  if (looked === 0) return { samples: null, note: '台账里没有任何带会话 id 的派活记录 —— 本次没有活动证据（结构上采不到 ⇒ 不启用"连续确认"门）', root, found: 0, gate_applicable: false }
  if (found === 0) {
    return {
      samples: null,
      note: `在 ${root} 下没找到任何已派席位的会话日志 ${SESSION_LOG_NAME} —— 本次没有活动证据${gateApplicable ? '（但会话 id 是真实形状 ⇒ 启用"连续确认"门）' : '（且台账里没有真实形状的会话 id ⇒ 不启用"连续确认"门）'}`,
      root,
      found: 0,
      gate_applicable: gateApplicable,
    }
  }
  return {
    samples,
    note: `已采到 ${found}/${looked} 个席位的会话日志（窗口 ≤ ${maxMs === undefined ? '默认' : maxMs} ms）`,
    root,
    found,
    gate_applicable: gateApplicable,
  }
}

/**
 * ★「全部编写席位到齐」判据。
 *
 * 取舍（详见 README「编写分工」）：**全部席位到齐才推进**，而不是让某个"主编写席位"汇总成一份。
 * 理由见 README；这里只负责执法。
 *
 * @returns {{ok:true} | {ok:false, code:string, error:string}}
 */
export function checkAllSeatsSubmitted(task) {
  const seats = writerSeatsOf(task)
  if (seats.length <= 1) return { ok: true }
  const subs = task.writer_submissions ?? {}
  const missing = seats.filter((s) => subs[s] === undefined)
  if (missing.length === 0) return { ok: true }
  const done = seats.filter((s) => subs[s] !== undefined)
  return {
    ok: false,
    code: 'SEATS_INCOMPLETE',
    error:
      `编写席位未到齐：本任务在册 ${seats.length} 个席位，已交 ${done.length} 个（${done.join('、') || '无'}），` +
      `还差 ${missing.length} 个（${missing.join('、')}）。\n` +
      '规矩：**全部席位各交一份 dev_to_test 之后**才能推进到「待测试」。\n' +
      '为什么不是"由主编写席位汇总成一份"：汇总会引入一个隐藏的等级（谁是主？谁定的？），' +
      '而且汇总那一步本身不可审计 —— 测试与审核直接看 N 份分区报告反而更清楚谁改了什么。\n' +
      '如果某个席位确实交不了（例如它那块被取消），走 pipeline_roster_request 让编排复核后改分区，' +
      '而不是在这里硬推。',
  }
}

/** ★ 需求档的**约定路径**（由目录约定推导，不写进任务卡）。 */
export function requirementPaths(pipelineDir, taskId) {
const dir = join(pipelineDir, String(taskId))
return {
  dir,
  md: join(dir, "requirement.md"),
  json: join(dir, "requirement.json"),
  index: join(dir, "requirement.index.json"),
  /** 相对项目根的展示用路径（POSIX）。 */
  rel: `.pipeline/${String(taskId)}/requirement.md`,
}
}

/** 两版之间的**差异摘要**（写进版本索引，供"可追溯"用）。 */
function diffSummary(prev, next) {
const bits = []
bits.push(`由 ${prev.version} → ${next.version}`)
if (prev.sha256 !== next.sha256) bits.push("正文有改动")
else bits.push("正文未变（仅元数据）")
if (typeof next.note === "string" && next.note.length > 0) bits.push(`说明：${next.note}`)
return bits.join("；")
}


/**
 * 建立任务存储。
 *
 * @param {object} opts
 * @param {string} opts.projectRoot - 项目根（`.pipeline` 就建在它下面）
 * @param {string} opts.artifactDirName - 默认 `.pipeline`
 * @param {number} opts.maxReworkPerLeg - 单条打回链上限
 * @param {() => Date} [opts.now]
 */
export function createTaskStore(opts) {
  const projectRoot = resolve(opts.projectRoot)
  const dirName = opts.artifactDirName ?? '.pipeline'
  const root = join(projectRoot, dirName)
  const maxRework = Number.isInteger(opts.maxReworkPerLeg) ? opts.maxReworkPerLeg : 2
  /**
   * ★ 失联静默阈值（毫秒）。见 `lib/liveness.js`：默认 5 分钟。
   * 由 `config.seatSilenceMs` 传进来。
   */
  const seatSilence =
    Number.isInteger(opts.seatSilenceMs) && opts.seatSilenceMs > 0 ? opts.seatSilenceMs : DEFAULT_SEAT_SILENCE_MS
  /**
   * ★ 哈希闸门**连续不通过**多少次 ⇒ 自动交人工（0 = 关掉自动升级）。
   *
   * 用户拍板（P13）：不扣打回预算（保持现状），但连续 N 次不过就自动交人工。
   * 语义与理由写在 `lib/config.js` 的 `hashGateEscalateAfter` 与 `lib/hashgate.js`。
   */
  const hashGateEscalateAfter = Number.isInteger(opts.hashGateEscalateAfter) ? opts.hashGateEscalateAfter : 3
  /**
   * ★ **授权面锚点**：`change_scope[].path` 里的**裸相对路径**按它解析。
   *
   * 由 `config.changeScopeAnchor` 传进来（装配处见 `index.js`）；留空 = **插件包根**
   * （`PACKAGE_ROOT`）。**必须与守门用同一个锚点** —— 否则同一份授权面
   * 在「改动面审计」与「守门」两处会得出不同结论（一个说在授权面内、一个说越界）。
   *
   * 为什么不能拿 `project_root` 拼：见 `lib/config.js` 的 `changeScopeAnchor`（真单实测）。
   */
  const scopeAnchor =
    typeof opts.scopeAnchor === 'string' && opts.scopeAnchor.trim().length > 0
      ? pathKey(resolveAgainstAnchor(PACKAGE_ROOT, opts.scopeAnchor))
      : PACKAGE_ROOT
  /**
   * ★ **某个任务的授权面锚点**：`task.scope_anchor`（元数据里显式写的包根，若有）
   *   > 配置/包根默认（`scopeAnchor`）。
   *
   * 按**任务**取而不是按进程取：一个任务的锚点不该影响另一个任务的判定
   * （守门那一侧同理，见 `lib/guard.js` 的 `makeTaskIndexEntry`）。
   */
  const anchorOf = (task) => {
    const raw = typeof task?.scope_anchor === 'string' ? task.scope_anchor.trim() : ''
    return raw.length > 0 ? pathKey(resolveAgainstAnchor(scopeAnchor, raw)) : scopeAnchor
  }

  /**
   * ★ **路径归一化**（唯一一套坐标系；**复用既有 `changeScopeAnchor`，不新造第二套锚点**）。
   *
   * -----------------------------------------------------------------------------
   * 修的是哪条漏路（本轮 ③）
   * -----------------------------------------------------------------------------
   * 问题的形状是**两边不在同一个坐标系里**：
   *   · **基线**的键是「**相对项目根**」的 POSIX 路径（`takeBaselineSnapshot`
   *     从 `task.project_root` 往下扫出来的）；
   *   · **授权面**的条目却可能是**任意一棵树**的**绝对路径** —— 真单
   *     T-20261011-5a871c 的 5 条授权里，源码树那两条写的就是
   *     `C:\…\dsh_orb\…\dsh-pipeline\lib\` 这样的绝对路径。
   *
   * 早先这里拿 `isInside(projectRoot, abs)` 把"落在项目根之外"的条目判成
   * "解析不出"（返回 `null`）⇒ 那两条授权**整条作废**：授权面与校验面对不上，
   * 编写席在源码树里**怎么写都对不上**（怎么写都判越界）。
   *
   * 修法：**两边先落到同一个坐标系（规范绝对键）再比** ——
   *   · 授权条目 / 改动声明里的路径：按**既有锚点**解析（绝对路径原样归一化；
   *     裸相对路径拼到锚点下 —— 与守门 `normScopePath` 用的是同一个
   *     `resolveAgainstAnchor`，所以两侧结论不会打架）；
   *   · 基线的键：拼回项目根，得到同一个坐标系里的绝对键。
   *
   * ⚠️ **这不是放宽**：
   *   · 基线的键**只**覆盖项目根之内的文件；项目根之外的树压根不在基线里
   *     ⇒ 那里"授权得到"也不会凭空放行任何基线内的文件；
   *   · 项目根之内的判定与改动前**逐条等价**（同一个全小写化、同一个 `isInside`，
   *     原来的 `r === p || r.startsWith(p + '/')` 正是 `isInside` 的同一件事）。
   */
  const cmpKey = (p) => pathKey(p).toLowerCase()
  /** 授权条目 / 改动声明里的路径 → 规范绝对比较键（按既有锚点解析；`''` = 解析不出）。 */
  const scopeAbsKey = (raw, task) => {
    const abs = resolveAgainstAnchor(anchorOf(task), raw)
    return abs.length === 0 ? '' : cmpKey(abs)
  }
  /** 基线的键（相对项目根）→ 同一个坐标系里的绝对比较键。 */
  const baselineAbsKey = (rel) => cmpKey(`${projectRoot}/${String(rel ?? '').replace(/\\/g, '/')}`)

  /**
   * 把一条授权面条目解析成**相对项目根**的 POSIX 路径（基线的键就是这个形状）。
   *
   * 例：锚点 = `<profile>/node_modules/dsh-pipeline`、`project_root` = `<profile>`、
   *     条目写 `index.js` ⇒ `node_modules/dsh-pipeline/index.js` —— 这才对得上基线。
   *
   * ★ 修 ③：落在 `project_root` **之外**的条目**不再返回 `null`**（那等于把这条
   *   授权悄悄作废），改为返回它的**规范绝对键** —— 与 `baselineAbsKey()` 出来的
   *   绝对键同一坐标系，于是"绝对路径 vs 相对路径"的错位不再存在。
   *   仍然是 `null` 的只有一种：**空串**（压根没写路径）。
   */
  const scopeRelOf = (raw, task) => {
    const abs = scopeAbsKey(raw, task)
    if (abs.length === 0) return null
    return isInside(projectRoot, abs) ? relKey(projectRoot, abs).replace(/\/+$/, '') : abs
  }
  /** 人工介入请求的默认截止时长（小时）。0 = 不设截止（那时不允许按超时放行）。 */
  const timeoutHours = Number.isFinite(opts.humanRequestTimeoutHours) && opts.humanRequestTimeoutHours > 0
    ? opts.humanRequestTimeoutHours
    : 0
  /** 是否强制答复回带转告时给出的确认码（更防伪、但更啰嗦）。 */
  const requireHumanConfirmCode = opts.requireHumanConfirmCode === true
  /** ★ 同一个澄清问题最多问几次（防踢皮球；默认 2）。 */
  const maxClarifyRounds = Number.isInteger(opts.maxClarifyRounds) ? opts.maxClarifyRounds : 2
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()

  /**
   * ★ 被拒收交付的留档上限（字符）：超长只留前一段并标注。
   *   取值理由：任务文件已经 MB 级，单条留档不该成为新的大头；同时"它交过什么"
   *   这段够读（判据要的是**可查回**，不是"逐字节留全"）。
   */
  const MAX_REJECTED_PAYLOAD_CHARS = 20000

  /** 内存缓存：taskId → task 对象。写操作先更新缓存再落盘。 */
  const cache = new Map()

  /**
   * ★★ **读侧对账用的盘上指纹**：taskId → `"<size>:<mtimeMs>"`（**本进程最后一次
   * 与盘同步那一刻**盘上的样子）。`persist()` 写完刷新它，`loadTask()` 读之前拿它
   * 与**当前**盘上指纹比。
   *
   * -----------------------------------------------------------------------------
   * 为什么必须要有这一条（现场：真单 T-20261012-7b9408，2026-10-11T16:33–16:34）
   * -----------------------------------------------------------------------------
   * 症状是「**写进去了、读不到**」：盘上的 `task.json` 里 `human_requests[]` 有那条
   * `pending`（`request_id=HR-a1b726450f7ac4`），而主对话调
   * `pipeline_human_relay { task_id }`（收件箱模式）得到的是
   * 「任务 … 目前没有人工介入请求。」—— 过一会儿再调又正常了。
   *
   * 读侧的路径查清了（这是上一轮**没覆盖**的那半边）：
   *   · `lib/tools.js:3495` 收件箱 → `store.listHumanRequests({ taskId })`
   *   · `lib/store.js` 的 `listHumanRequests` → `task.human_requests`
   *   · `lib/store.js` 的 `loadTask`：`const cached = cache.get(taskId); if (cached !== undefined) return cached`
   *     ⇒ **内存实例优先、且从不与盘对账**。
   *
   * 上一轮给 `loadTask` 加的"读盘即自愈"只挂在**读盘分支**上；缓存命中那条路
   * 一个字节都不看盘 ⇒ 只要内存里那份实例不是最新的（写事务还在途、或这份实例
   * 与真正落盘的那份不是同一个对象），收件箱就会拿旧实例回答 —— 而且**不会自愈**，
   * 因为缓存从不失效。
   *
   * 判据是**盘说了算**：内存实例只在"它确实就是盘上那一份"时才可信。
   * `(size, mtimeMs)` 是**便宜的启发式**（一次 `stat`，微秒级），不是密码学保证 ——
   * 真正的保证来自下面两条一起：
   *   · **根治**：复合写里"交接物可见"与"登记可见"之间**不再有 await 点**
   *     （见 `submitHandoff` 里的 ★★），进程内再也观察不到半截状态；
   *   · **兜底**：本对账 —— 盘比内存新（别的实例 / 外部改动 / 跨上下文）就重载。
   */
  const cacheStamp = new Map()

  /**
   * ★ **最后一份"确实落盘成功"的内存快照**：taskId → 深拷贝。
   *
   * 为什么必须有它（本轮修 ②：`persist()` 落盘失败**不回滚内存**）：
   *   调用方（`transition` / `submitHandoff` / …）一律是**先改内存对象、再落盘**。
   *   而 `persist()` 早先只管写盘、不管回滚 ⇒ 写盘一失败（真单 T-20261011-214043
   *   的一次 `unblock`：`writeJsonAtomic → fs.rename` 抛 **EPERM**，
   *   调用链 `store.js:693 persist → store.js:1139 transition → lib/tools.js:2084`），
   *   形状就是「**内存已经改了、盘上没改**」——
   *   而且**不会自愈**：`cache` 从不失效，下一次 `loadTask` 命中缓存拿到的正是
   *   那份没落盘的内存 ⇒ 同一个 `unblock` 第二次回的是「已是开发中，不接受 unblock」。
   *
   *   有了这份快照，`persist()` 就能在写盘失败时把内存**回滚到改动前**：
   *   按定义，快照 == 盘上那一份（它就是上一次写成功的内容）。
   */
  const lastGood = new Map()

  /** 有限重试之间的等待（毫秒）。 */
  const PERSIST_RETRY_DELAY_MS = 40
  /**
   * 落盘重试次数。
   *
   * 为什么先重试再回滚：Windows 上 `rename` 抛 EPERM/EACCES/EBUSY 多半是**瞬时**的
   * （杀软 / 索引器 / 编辑器正握着 `task.json` 的句柄），隔几十毫秒再来一次常常就过了。
   * 重试仍然失败才认输 —— 认输时**一定**把内存退回去，绝不留下"内存改了、盘上没改"。
   */
  const PERSIST_RETRIES = 3

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 盘上 `task.json` 的指纹；读不到就 null（该任务可能还没落盘）。 */
  async function diskStampOf(taskId) {
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(taskFile(taskId))
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return null
    }
  }

  const taskDir = (id) => join(root, id)
  const taskFile = (id) => join(taskDir(id), 'task.json')
  const handoffDir = (id) => join(taskDir(id), 'handoffs')

/** 相对项目根的 POSIX 路径（写进记录，避免泄露绝对路径）。 */
const relKey = (root, abs) => relative(root, abs).replace(/\\/g, '/')
  const auditFile = (id) => join(taskDir(id), 'audit.jsonl')
  const artifactDir = (id, version) => join(taskDir(id), 'artifacts', version)

  /** 审计：一行一个动作，永不删除。 */
  async function audit(taskId, actor, action, detail) {
    const entry = { at: nowIso(now()), task_id: taskId, actor, action, ...detail }
    try {
      await appendJsonl(auditFile(taskId), entry)
    } catch {
      /* 审计写失败不该让主流程失败；内存里的 task.history 仍然有记录 */
    }
    return entry
  }

  /** 统一拒绝返回。 */
  const deny = (code, message, extra = {}) => ({ ok: false, code, error: message, ...extra })

  function requireTask(taskId) {
    const t = cache.get(taskId)
    if (t === undefined) return null
    return t
  }

  /**
   * ★ **登记自愈**：把「有交接物、没登记」的人工介入请求补回登记表。
   *
   * 为什么挂在 `loadTask` 这个**唯一公共入口**（而不是在收件箱 / 转告 / 答复
   * 各自入口各写一遍）：`loadTask` 是收件箱、转告、答复、状态查询、以及
   * `submitHandoff` 自己拿任务对象的**共同必经之路**。挂在别处就得在 N 个入口
   * 重复同一段判据，而"漏一处"正是这次事故的形状。
   *
   * -----------------------------------------------------------------------------
   * ★ 本轮修的那条漏路（真单 T-20261011-214043 / T-20261011-5a871c 现场）
   * -----------------------------------------------------------------------------
   * 上一轮把自愈**只挂在"读盘分支"**上（缓存命中直接 return，压根不走到这里）。
   * 但 `cache`（模块级 Map）在插件进程里**从不失效** —— `dropCache` 只有测试在用。
   * 于是形状是：**同一次运行里漏过一次登记 ⇒ 之后再也不会自愈**，
   * 收件箱永远「没有人工介入请求」、答复永远记不回，**只有重启才修得好**。
   * 而漏登记的真实成因就摆在那条路径上：交接物落盘（`appendHandoff`）与登记
   * 之间夹着好几段可抛异常/可提前 return 的代码，一中断就是"半截现场"。
   *
   * 所以：**两条分支都自愈**。没毛病时是纯读（`reconcileHumanRequests` 返回 0
   * ⇒ 不落盘、不写审计），"没毛病就不落盘"这条性质一个字没动。
   */
  async function healHumanRegistry(t) {
    if (t === null || typeof t !== 'object') return 0
    const recovered = reconcileHumanRequests(t)
    if (recovered === 0) return 0
    const aentry = await audit(t.id, ROLE.ORCHESTRATOR, 'human:recovered', {
      recovered,
      state: t.state,
      reason: '读任务时发现 human_request 交接物在盘上但登记表缺 —— 已按交接物反推补登记',
    })
    t.history.push(aentry)
    await persist(t)
    return recovered
  }

  /**
   * ★ **旧基线遗留判定的自愈**：把"拿旧基线算出来、却还挂在任务上"的闸门判定清掉。
   *
   * 为什么需要它（与"登记自愈"同源，都是**已在盘上的卡死单也要能救回来**）：
   *   `takeBaseline` 现在会按"重取基线 = 新起点"清零计数并作废旧判定 ——
   *   但**本次修复之前**重取过的单（真单 T-20261011-214043：14:46 判不过、
   *   14:50 重取基线 BL-64c1eb000b1f10bf，计数与 blocked 却留在了旧基线 BL-8f0ae2… 上）
   *   盘上就是这个形状，等不到下一次重取。
   *
   * 判据是**不可辩驳**的那一条、不靠猜：
   *   **`task.hash_gate.baseline_id !== task.baseline_current` ⇒ 这份判定属于一份
   *   已经不存在的基线** ⇒ 它既不能证明当前状态越界，也没有理由再拦"跑测试"。
   *   而计数与它同源（同一次判定写下的），一并按新起点归零。
   *
   * ⚠️ **一个字都没放宽**：清掉的只是"过期结论"。下一次 `dev_to_test` 会拿**当前**
   *    基线重新算一遍三类越界与"声明不实"，越界照拒、照计数、照在连续 N 次后交人工。
   * ⚠️ **不碰 `hash_gate_escalation`**：已经交到用户手上的单不会因为这条被悄悄撤回。
   *
   * 没毛病时**纯读**（不动、不落盘、不写审计）。
   *
   * @returns {boolean} 是否清了
   */
  async function healStaleHashGate(t) {
    if (t === null || typeof t !== 'object') return false
    const gate = t.hash_gate ?? null
    if (gate === null || typeof gate !== 'object') return false
    const gateBaseline = typeof gate.baseline_id === 'string' ? gate.baseline_id : null
    const cur = typeof t.baseline_current === 'string' ? t.baseline_current : null
    // 没有基线、或判定就是按当前基线算的 ⇒ 什么都不做（**纯读**）。
    if (gateBaseline === null || cur === null || gateBaseline === cur) return false

    const origin = resetHashGateOrigin(t, cur)
    if (origin.changed !== true) return false
    t.history.push(
      await audit(t.id, ROLE.PLANNER, 'gate:hash_reset', {
        // ⚠️ actor 记为**计划角色**：这是机制在读任务时自愈，不是谁下的命令
        //    （与 `human:recovered` 记 orchestrator 同源：都写真实来由，不冒名某个会话）。
        baseline_id: cur,
        stale_gate_baseline_id: gateBaseline,
        prev_streak: origin.prev_streak,
        now_streak: 0,
        prev_gate_blocked: origin.prev_gate_blocked,
        recovered_on_load: true,
        why:
          '读任务时发现闸门判定指向一份**已经不是当前**的基线（重取基线 = 新起点）——' +
          '该判定与它带来的连续计数按新基线重新起算；三类越界判定与"声明不实"一个字没放宽。',
      }),
    )
    await persist(t)
    return true
  }

  /**
   * ★★ **读任务（唯一公共入口）** —— 收件箱、转告、答复、状态查询、以及
   * `submitHandoff` 自己全都经它拿任务对象。
   *
   * 两条分支，**两条都要过对账**：
   *   · 缓存命中：先比 `cacheStamp` 与**当前**盘上指纹。不一致（盘比内存新）⇒
   *     **重载并替换缓存** —— 这就是「写进去了、读不到」那条漏路的堵法
   *     （读侧对账；详见 `cacheStamp` 的注释）；
   *   · 读盘：读完记下指纹。
   *
   * 两条分支读完都跑一次自愈（登记缺 ⇒ 补；闸门判定指向旧基线 ⇒ 清）。
   */
  async function loadTask(taskId) {
    const cached = cache.get(taskId)
    if (cached !== undefined) {
      // ★ **读前对账**：内存实例只在"它确实就是盘上那一份"时才可信。
      //   盘上更"新"（指纹变了）⇒ 丢掉内存那份、从盘重载。
      //   ⚠️ 这里**不会**误伤"本进程刚写完还没被读"的情形：`persist()` 落盘后
      //      立刻把指纹刷成盘上的实际值（见下），所以自己写的不会判成"盘更新"。
      const nowStamp = await diskStampOf(taskId)
      const known = cacheStamp.get(taskId)
      if (nowStamp !== null && known !== undefined && known !== nowStamp) {
        try {
          const fresh = await readJson(taskFile(taskId))
          cache.set(taskId, fresh)
          cacheStamp.set(taskId, nowStamp)
          await healHumanRegistry(fresh)
          await healStaleHashGate(fresh)
          // ★ 从盘上拿到的这份 = 盘上的内容 ⇒ 它天然就是"最后一份好的快照"
          //   （修 ② 的回滚点）。记在自愈之后：自愈可能已经落过盘。
          lastGood.set(taskId, structuredClone(fresh))
          return fresh
        } catch {
          /* 盘上那份读不动（正被替换中）⇒ 退回用内存这份，下一次读再对账 */
        }
      }
      // ★ 缓存命中也要自愈：缓存从不失效，漏过的那次不会再被"读盘"带上岸。
      await healHumanRegistry(cached)
      await healStaleHashGate(cached)
      return cached
    }
    const file = taskFile(taskId)
    if (!existsSync(file)) return null
    try {
      const t = await readJson(file)
      cache.set(taskId, t)
      /**
       * ★ 读盘时自愈一次（见上方 `healHumanRegistry` 的说明）。
       * 顺带解决"已经卡死的单"：兜底见下方 `reconcileHumanRequests`
       * （只补缺，绝不碰 answered / withdrawn）。
       */
      await healHumanRegistry(t)
      await healStaleHashGate(t)
      // ⚠️ 指纹记在**自愈之后** —— 自愈本身可能落盘（改了盘上的内容），
      //    先记会把"刚被自己改过的盘"当成别人的改动，下一次读白重载一遍。
      cacheStamp.set(taskId, await diskStampOf(taskId))
      // ★ 同上一处：盘上读来的这份就是"最后一份好的快照"（修 ② 的回滚点）。
      lastGood.set(taskId, structuredClone(t))
      return t
    } catch {
      return null
    }
  }

  /**
   * ★ **落盘**：写盘成功才算数；**写盘失败就把内存回滚到改动前**。
   *
   * 三条性质（本轮修 ② 的正反例就是照这三条判的）：
   *   ① 写成功 ⇒ 刷新盘上指纹 + 更新"最后一份好的快照"（正常路径，与改动前一致）；
   *   ② 写失败（重试 `PERSIST_RETRIES` 次仍失败）⇒ **内存 == 盘**：
   *      · 有快照 ⇒ 就地把**同一个对象**改回快照的样子（在途调用方正握着这个引用，
   *        换对象会让它和后续 `loadTask` 拿到两个实例，反而制造漂移）；
   *      · 没有快照（例如开单那一次就失败）⇒ 盘上不该有这个任务 ⇒ 从缓存里摘掉，
   *        下次读盘拿到的就是真相（`loadTask` 返回 null）；
   *   ③ 失败**明确报给调用方**：抛出的错误里写清"已重试几次 / 内存已回滚 / 没生效"。
   *
   * ⚠️ 这里**不吞**错误：调用方（`transition` / `submitHandoff` / …）本来就把异常
   *    往上抛，工具层如实报错 —— 这一点改动前是对的，一个字没改。
   */
  async function persist(task) {
    task.updated_at = nowIso(now())
    const rollback = lastGood.get(task.id) ?? null
    let lastErr = null
    for (let attempt = 1; attempt <= PERSIST_RETRIES; attempt++) {
      try {
        await writeJsonAtomic(taskFile(task.id), task)
        // ★ **写后刷新指纹**（"写后主动让缓存失效"的等价物）：内存这份就是我们刚写下去的
        //   那份 ⇒ 把指纹对齐，读前对账才不会把自己刚写的判成"盘更新"而白重载一次。
        //   （这里**不** `cache.delete`：在途的调用方正握着同一个对象，
        //     删缓存会让它和后续 `loadTask` 拿到两个对象，反而制造漂移。）
        cacheStamp.set(task.id, await diskStampOf(task.id))
        lastGood.set(task.id, structuredClone(task))
        return task
      } catch (err) {
        lastErr = err
        if (attempt < PERSIST_RETRIES) await sleep(PERSIST_RETRY_DELAY_MS)
      }
    }

    // --- 重试用尽 ⇒ **回滚内存**，绝不留"内存改了、盘上没改"的半截现场 ----------
    if (rollback === null) {
      cache.delete(task.id)
      cacheStamp.delete(task.id)
    } else {
      for (const k of Object.keys(task)) if (!Object.prototype.hasOwnProperty.call(rollback, k)) delete task[k]
      Object.assign(task, rollback)
      cacheStamp.set(task.id, await diskStampOf(task.id))
    }

    const code = lastErr?.code ?? 'PERSIST_FAILED'
    const e = new Error(
      `任务 ${task.id} 落盘失败（已重试 ${PERSIST_RETRIES} 次）：${code} ${lastErr?.message ?? lastErr}\n` +
        '★ **内存已回滚到改动前**（与盘上一致）—— 这次改动**没有生效**，不会留下"内存改了、盘上没改"的半截状态。\n' +
        '  常见成因：`task.json` 正被别的进程握着（杀软 / 索引器 / 编辑器）⇒ 关掉它再重试；' +
        '磁盘满或只读也会是这个形状。',
    )
    e.code = code
    e.persist_failed = true
    e.memory_rolled_back = true
    e.attempts = PERSIST_RETRIES
    throw e
  }

  /**
   * ★ **兜底（事后补）**：从「交接物 + 状态」反推出缺的那条人工介入登记。
   *
   * 现场：`pipeline_status` 列得出那份 `human_request` 交接物、状态也停在
   * `awaiting_human`，但登记表是空的 ⇒ 收件箱列不出、答复记不回 ⇒ 永久卡死。
   * 这个方法就是那把"把已卡死的单救回来"的钥匙。
   *
   * 刻意的三条约束：
   *   · **只补缺** —— 有完整登记的一律原样保留；
   *   · **不碰 answered / withdrawn** —— 那是"主对话不能自行把请求标记为已解决"
   *     这条反例的落点（有记录说明那条链走完了，不该被"修复"回 pending）；
   *   · **没毛病就是纯读** —— 这个函数会被 `loadTask` 每次都调一次，
   *     没问题时**不落盘**（返回 0，调用方什么都不做）。
   *
   * -----------------------------------------------------------------------------
   * ★ 本轮修的那条漏路：第 ② 步**不再**限定 `task.state === awaiting_human`
   * -----------------------------------------------------------------------------
   * 早先的判据是「**完全没有登记** **且** 任务停在 `awaiting_human`」才反推。
   * 但 `awaiting_human` 只有 **blocking=true** 的请求才进得去（见 `planAdvance`：
   * 「非阻塞请求照样进待办、照样要主对话转告，但不打断流程」）。
   * 于是 **blocking=false 的 human_request 一旦漏登记，就永远救不回来**：
   * 状态不在等待态 ⇒ 判据不成立 ⇒ 收件箱照旧列不出、答复照旧记不回。
   *
   * 这不是假想的角落 —— 真单里点名"取不出来"的三条交接物
   * （`H-8411d229ed7e1ae7` / `H-4b0ec20e3bc9c52e` / `H-b7f6a9c75eb23ae6`）
   * **payload.blocking 全是 false**，而旧判据对它们**一条都盖不住**。
   *
   * 新的判据只留一条、而且是不可辩驳的那一条：
   *   **「盘上有一份 human_request 交接物，登记表里却没有对应条目」= 一次没写完的登记。**
   * 它与任务当时在什么状态无关（阻塞、非阻塞、已经恢复过，都一样是漏写）。
   * 交接待物是**不可变原件**，所以按它重建不会引入任何新信息；
   * 而"答复过的 / 撤回过的"本来就**有**条目（`answered` / `withdrawn`），
   * 压根落不进"完全没有登记"这一档 ⇒ 不会被"修复"回 pending。
   *
   * ⚠️ 这不是放宽：`awaiting_human` 那句从来没起过"防伪"作用 —— 它只是漏掉了
   *    非阻塞请求。反例（不许覆盖已有记录 / 主对话不能自行标记已解决）一个字没动。
   *
   * @returns {number} 本次补了几条（0 = 什么都没干，也没落盘）
   */
  function reconcileHumanRequests(task) {
    if (task === null || typeof task !== 'object') return 0
    const handoffs = Array.isArray(task.handoffs) ? task.handoffs : []
    const requests = handoffs.filter((h) => h !== null && typeof h === 'object' && h.kind === 'human_request')
    if (requests.length === 0) return 0
    // ⚠️ 这个函数会被 `loadTask` **每次都调一次**（含缓存命中的纯读路径）——
    //    所以"确认真要补之前"**一个字节都不许动**（连 `task.human_requests = []`
    //    这种兜底赋值都不做），"没毛病就是纯读"才是真的。
    const list = Array.isArray(task.human_requests) ? task.human_requests : []

    // 先看一眼有没有活要干 —— 没问题时必须纯读、不落盘。
    const orphans = requests.filter((h) => !list.some((r) => r.handoff_id === h.handoff_id))
    const partial = requests.some((h) => {
      const found = list.find((r) => r.handoff_id === h.handoff_id)
      return found !== undefined && found.question_for_human === undefined
    })
    if (orphans.length === 0 && !partial) return 0
    // 真要补了才把容器补齐（老任务可能压根没有这个字段）。
    if (!Array.isArray(task.human_requests)) task.human_requests = list

    let recovered = 0

    // --- ① 有登记但缺本体（`question_for_human` 是这条请求的本体）-----------
    for (const record of requests) {
      const found = list.find((r) => r.handoff_id === record.handoff_id)
      if (found === undefined || found.question_for_human !== undefined) continue
      const rebuilt = buildHumanRequestEntry(task, record, record.payload ?? {}, timeoutHours)
      // ★ 只补**缺**的字段：已经走过的生命周期（转告/答复/恢复）原样保留。
      const kept = {}
      for (const k of Object.keys(rebuilt)) {
        if (found[k] !== undefined && found[k] !== null && found[k] !== '') kept[k] = found[k]
      }
      list[list.indexOf(found)] = { ...rebuilt, ...kept, recovered_from_handoff: true }
      recovered += 1
    }

    // --- ② 完全没有登记的那些（卡死现场就是这一种；阻塞与非阻塞都在内）-------
    for (const record of orphans) {
      // 双保险：上面 ① 刚补过的那几条已经进了 list，别再建第二条。
      if (list.some((r) => r.handoff_id === record.handoff_id)) continue
      const entry = buildHumanRequestEntry(task, record, record.payload ?? {}, timeoutHours)
      entry.recovered_from_handoff = true
      list.push(entry)
      recovered += 1
    }

    return recovered
  }

  /**
   * 取任务里"当前有效制品版本"。
   * 规则：最近一次 `dev_to_test` 交接物的 artifact_version。
   */
  function currentArtifactVersion(task) {
    for (let i = task.handoffs.length - 1; i >= 0; i--) {
      const h = task.handoffs[i]
      if (h.kind === 'dev_to_test' && typeof h.artifact_version === 'string') return h.artifact_version
    }
    return null
  }

  /** 最近一次某 kind 的交接物。 */
  function lastHandoff(task, kind) {
    for (let i = task.handoffs.length - 1; i >= 0; i--) {
      if (task.handoffs[i].kind === kind) return task.handoffs[i]
    }
    return null
  }

  // =========================================================================
  // ★★ 主管枢纽（T-20261011-56a37e）—— 判据的公共读面
  // =========================================================================
  //
  // 这一小段**只读**：把"任务上那份枢纽账本"读成几个纯函数，供各个 guard 复用。
  // 它刻意不新造任何数据源 —— 账本只有一个（`task.hub`），写它只有一处
  // （`hub_initiate` 那一跳）。
  //
  // ★ 与四类不变量的关系：这里判的每一条都落在**既有**的守卫开关
  //   （`checkPrecondition` 的 switch）与**既有**的交接物状态判据上，
  //   没有第二个执法层、没有第二份名单。

  /** 任务上的枢纽账本（没启用时是 `null`）。 */
  function hubOf(task) {
    const h = task?.hub
    return h !== null && typeof h === 'object' && !Array.isArray(h) ? h : null
  }

  /** 枢纽是否已启用。★ 未启用 ⇒ 所有枢纽判据**弃权**（既有链一个字节不变）。 */
  function hubEnabled(task) {
    return hubOf(task)?.enabled === true
  }

  /** 待机名册（`[{role, wake_point, group, status, ...}]`）。 */
  function hubStandby(task) {
    const list = hubOf(task)?.standby
    return Array.isArray(list) ? list : []
  }

  /** 某席位的待机条目；没登记返回 `null`。 */
  function hubStandbyOf(task, role) {
    return hubStandby(task).find((s) => s?.role === role) ?? null
  }

  /**
   * ★ **待机期的产物面判据**（安全预审阻断项 B3 的第 1 条：交接物面）。
   *
   * 已登记待机、且**还没到唤醒点**的席位 ⇒ 不许产出自己那一类产物。
   * 不在待机名单里的角色、以及没启用枢纽的任务 ⇒ 直接放行（弃权，不是放宽）。
   *
   * @returns {{ok:true} | {ok:false, entry:object, wakePoint:string}}
   */
  function hubStandbyBlocks(task, role) {
    if (!hubEnabled(task)) return { ok: true }
    const wp = hubWakePointOf(role)
    if (wp === null) return { ok: true }
    const e = hubStandbyOf(task, role)
    if (e === null) return { ok: true }
    if (e.status === 'woken') return { ok: true }
    return { ok: false, entry: e, wakePoint: wp }
  }

  /**
   * 「最近一次打回」在 `task.handoffs` 里的下标（-1 = 从没打回过）。
   * 与 `effectiveReviewOk` 用的是**同一个形状**（打回即作废）—— 不另起一套。
   *
   * ★★ T-20261011-56a37e 补齐：**「否掉」也是打回的一种**。
   *
   *   主管在某一站说"这份产物不算数"（`station_confirm{decision:'ng'}`），与
   *   测试/审核打回是**同一件事**：它之前的确认全部作废，必须重新确认。
   *   没有这一条，「否掉」就是个空转 —— 被否掉之后，旧的确认记录还留在盘上、
   *   还绑着同一个目标，确认方一"点头"就又能推进，等于否掉没发生过。
   *
   *   ★ 为什么复用的是**同一张 `station_confirm` 交接物**而不是新开一个 kind：
   *     确认与否掉是同一件事的两个方向（schema 里 `decision` 本来就写着 `['ok','ng']`），
   *     同一张 schema 就自动继承了同一套形态判据 —— **证据标识 ≥ 1 条**（`basis_refs`）
   *     与 `reason` 都是 `required` ⇒ "否掉必须带证据、不许静默"由**既有校验器**保证，
   *     不需要（也不许）另写一套。
   */
  function lastReworkIndex(task) {
    let at = -1
    for (let i = 0; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind === 'test_to_dev') at = i
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'NG') at = i
      // ★ 否掉 = 打回：它之前的确认全部作废（见上面那段说明）。
      if (h.kind === 'station_confirm' && h.payload?.decision === 'ng') at = i
    }
    return at
  }

  /**
   * ★★ 某站点的**否掉记录**（主管或需求位交上来的 `station_confirm{decision:'ng'}`，
   *   按提交顺序，含未绑定当前目标的那些 —— 只读导出要用"全部"）。
   */
  function hubRejectRecords(task, station) {
    const out = []
    for (const h of task.handoffs) {
      if (h.kind !== 'station_confirm') continue
      if (h.payload?.station !== station) continue
      if (h.payload?.decision !== 'ng') continue
      out.push(h)
    }
    return out
  }

  /**
   * ★★ 某站点**当前有效的否掉记录** —— 形态与 `hubValidConfirms` **逐项对称**，
   *   只是方向相反（`decision='ng'`）：
   *     ① 是 `station_confirm`；② `station` 正是这一站；③ `decision === 'ng'`；
   *     ④ `artifact_version` 等于该站**当前的目标**（否掉也要说清"否的是哪一份"）；
   *     ⑤ 取**最后一条**（"最新的那次判断"说了算）。
   *
   * ⚠️ 与 `hubValidConfirms` 的一处**有意**不同：这里不再套 `lastReworkIndex` 窗口。
   *   原因：否掉记录**自己就是**窗口的起点（上一段），再用窗口过滤会把记录本身滤掉。
   *   "取最后一条 + 必须绑当前目标"这两条合起来已经保证了它说的是**当前这一份**。
   */
  function hubLatestValidReject(task, station, fromRole = null) {
    const target = hubStationTarget(task, station)
    if (target === null) return null
    let hit = null
    for (const h of hubRejectRecords(task, station)) {
      if (h.payload?.artifact_version !== target) continue
      if (fromRole !== null && h.from_role !== fromRole) continue
      hit = h
    }
    return hit
  }

  /**
   * ★★ **否掉预算**（四个站点各自的额度；见 `states.js` 的 `HUB_STATION_REJECT_BUDGET`）。
   *
   * 判据与 ② 道的 `hub_diagram_rework_budget` **同一套口径**：用尽 ⇒ 拒，
   * 并在拒绝原文里指名唯一出路 —— 走**既有的**两级梯升给用户
   * （`pipeline_supervise action=escalate_user` → `human_request`），不是第二套通道。
   *
   * @returns {{ok:true, station:string, used:number} | {ok:false, code:string, error:string}}
   */
  function hubRejectBudget(task, station) {
    if (station === '' || station === null || station === undefined) {
      return deny(
        'HUB_REJECT_UNKNOWN_STATION',
        '拒绝：认不出这是**哪一站**的否掉动作 —— 它必须挂在五道站点里的某一站上。\n' +
          `可用的站点：${HUB_STATION_REJECT_STATIONS.join(' / ')}（①道 need_agree / ③道 test_confirm / ④道 review_confirm）。`,
      )
    }
    if (hubConfirmersOf(station).length === 0) {
      return deny(
        'HUB_REJECT_NOT_A_STATION',
        `拒绝：站点「${station}」**不是确认站点**（它没有确认方），因此没有"否掉"这条分支。\n` +
          '★ 五道站点里第⑤道（关单并交付用户）是**交付**步骤、不是确认闸门 —— ' +
          '它没有确认方、也不产出确认记录（用户那句里的"确认"落在第④道）。\n' +
          `有否掉回边的站点：${HUB_STATION_REJECT_STATIONS.join(' / ')}。`,
      )
    }
    if (!hubEnabled(task)) {
      // ★ ①③④ 的三条回边**有两站落在与既有链共用的状态上**（`ready_review` / `passed`），
      //   所以这里必须显式弃权，否则等于给既有链凭空加了一条"主管退回"的路。
      return deny(
        'HUB_NOT_ENABLED',
        `拒绝：任务 ${task.id} 没有启用主管枢纽，站点「${station}」的否掉回边不属于它当前走的链。\n` +
          '★ 与既有的测试/审核打回（`pipeline_rework`）是两件事：那两条既有链**一个字节没动**。',
      )
    }
    const used = Number.isInteger(hubOf(task)?.station_rejects?.[station]) ? hubOf(task).station_rejects[station] : 0
    if (used >= HUB_STATION_REJECT_BUDGET) {
      return deny(
        'HUB_STATION_REJECT_EXHAUSTED',
        `拒绝：第${stationLabel(station)}的**否掉预算已用尽**（已用 ${used} / 上限 ${HUB_STATION_REJECT_BUDGET}）。\n` +
          '★ 与②道架构图重画同一套口径：「不满足 ⇒ 退回重做，**限 1 次**；再不行**升给用户**定」。\n' +
          '  无限退回会把"站点确认"退化成一道空转的闸。\n' +
          '下一步（唯一）：主管调 pipeline_supervise action=escalate_user 走**既有的**两级梯\n' +
          '  （human_request → 主对话转告 → 用户答复），把这件事交给人定。',
      )
    }
    return { ok: true, station, used }
  }

  /**
   * ★ 某站点**该绑哪个目标**（第①②道绑结论/图的交接物 id，第③④道绑制品版本）。
   *
   * ★ P0-1：②b / ②c 两个确认点确认的是**同一份架构图** —— 与第②道**同一个目标**
   *   （`architecture_diagram` 的最新一份 handoff_id）。于是三者的确认都绑在同一份图上，
   *   "换了一张图之后旧的点头还算不算数"由既有规则回答（打回即作废 / 目标对不上即作废）。
   */
  function hubStationTarget(task, station) {
    if (station === HUB_STATIONS.NEED_AGREE) {
      const h = lastHandoff(task, 'requirement_analysis')
      return h === null ? null : h.handoff_id
    }
    if (
      station === HUB_STATIONS.DIAGRAM_CONFIRM ||
      station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ||
      station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM
    ) {
      const h = lastHandoff(task, 'architecture_diagram')
      return h === null ? null : h.handoff_id
    }
    return currentArtifactVersion(task)
  }

  /**
   * ★★ 某站点的**有效确认记录**。
   *
   * 有效性五要素（照抄 `effectiveReviewOk` 的强度，安全预审「准入判据形态」）：
   *   ① 是 `station_confirm` 交接物；② `station` 字段**正是这一站**（不许跨站复用）；
   *   ③ `decision === 'ok'`；④ `artifact_version` 等于**该站当前的目标**（绑版本）；
   *   ⑤ 落在**最近一次打回之后**（打回即作废）。
   *
   * @returns {object[]} 按 `from_role` 各自最多一条（同角色重复确认按最后一条算）
   */
  function hubValidConfirms(task, station) {
    const target = hubStationTarget(task, station)
    if (target === null) return []
    const from = lastReworkIndex(task) + 1
    const out = new Map()
    for (let i = from; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind !== 'station_confirm') continue
      if (h.payload?.station !== station) continue
      if (h.payload?.decision !== 'ok') continue
      if (h.payload?.artifact_version !== target) continue
      out.set(h.from_role, h)
    }
    return [...out.values()]
  }

  /**
   * ★★ 站点闸：确认方**齐备**才放行，缺谁就指名缺谁。
   *
   * @returns {{ok:true, confirms:object[], target:string} | {ok:false, code:string, error:string}}
   */
  function hubStationGate(task, station) {
    const need = hubConfirmersOf(station)
    const target = hubStationTarget(task, station)
    if (target === null) {
      const what =
        station === HUB_STATIONS.NEED_AGREE
          ? '需求分析结论（requirement_analysis）'
          : station === HUB_STATIONS.DIAGRAM_CONFIRM ||
              station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ||
              station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM
            ? '架构图（architecture_diagram）'
            : '编写制品（dev_to_test）'
      return deny(
        'HUB_STATION_NO_TARGET',
        `拒绝推进：第${stationLabel(station)}道确认要确认的是「${what}」，而任务 ${task.id} 里还没有它 —— 没有可确认的对象。`,
      )
    }
    const confirms = hubValidConfirms(task, station)
    const got = confirms.map((h) => h.from_role)
    const missing = need.filter((r) => !got.includes(r))
    if (missing.length > 0) {
      const dual = need.length >= 2
      return deny(
        dual && got.length > 0 ? 'HUB_DUAL_CONFIRM_INCOMPLETE' : 'HUB_STATION_NOT_CONFIRMED',
        `拒绝推进：第${stationLabel(station)}道${dual ? '**双**' : ''}确认还**没有齐备**。\n` +
          `需要确认方：${need.map(roleLabel).join(' + ')}（共 ${need.length} 方）\n` +
          `已有确认：${got.length === 0 ? '（一份都没有）' : got.map(roleLabel).join(' + ')}\n` +
          `**还缺**：${missing.map(roleLabel).join(' + ')}\n` +
          `绑定目标：${target}\n` +
          '★ 用户口径⑥：站点确认**全部是硬闸门** —— 少一道就走不到下一步。\n' +
          (dual
            ? '★ 用户原话里的第③④道是「主管 + 需求」**双确认**：\n' +
              '  只有一方确认**不能**推进。两份确认必须是**两份各自令牌产出**的 station_confirm 记录\n' +
              '  （一份记录里写两个布尔字段是可以伪造的，不算数），两者绑定**同一个**目标且都在最近一次打回之后。\n'
            : '') +
          '下一步：' +
          (dual
            ? '主管调 pipeline_supervise action=confirm_station（需求位那一份用 pipeline_handoff kind=station_confirm）。'
            : '主管调 pipeline_supervise（站点确认是它的具名动作）。'),
      )
    }
    return { ok: true, confirms, target }
  }

  /** 站点中文名（拒绝原文里要指名"这是第几道"）。 */
  function stationLabel(station) {
    return (
      {
        [HUB_STATIONS.NEED_AGREE]: '①道（需求结论 → 主管同意）',
        [HUB_STATIONS.DIAGRAM_CONFIRM]: '②道（架构图 → 主管确认）',
        [HUB_STATIONS.TEST_CONFIRM]: '③道（测试通过 → 主管+需求位双确认）',
        [HUB_STATIONS.REVIEW_CONFIRM]: '④道（审核通过 → 主管+需求位双确认）',
        [HUB_STATIONS.CLOSEOUT]: '⑤道（主对话关单交付用户）',
        /** ★ P0-1：架构图交接计划位之前的两道确认点（用户新口径第 7~8 跳）。 */
        [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM]: '②b 确认点（架构图 → 需求位确认）',
        [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM]: '②c 确认点（架构图 → 主管**二次**确认）',
      }[station] ?? `(${station})道`
    )
  }

  /** 待机期被拦时的拒绝原文（交接物面 / 文件面 / 测试面共用一份措辞）。 */
  function renderStandbyBlock(task, entry, wakePoint, what) {
    const woken = hubStandby(task).filter((s) => s?.wake_point === wakePoint && s?.status === 'woken').map((s) => s.role)
    return deny(
      'HUB_STANDBY_NOT_WOKEN',
      `拒绝：席位「${roleLabel(entry?.role)}」现在处于**已登记待机**，还没到唤醒点 —— ${what}。\n` +
        `任务：${task.id}　待机登记：${entry?.registered_at ?? '(见 task.hub.standby)'}\n` +
        `它的唤醒点：**${wakePoint === HUB_WAKE_POINTS.NEED_AGREE ? '主管同意需求结论' : '主管确认架构图满足要求'}**（${wakePoint}）\n` +
        `该唤醒点已唤醒：${woken.length > 0 ? woken.map(roleLabel).join(' / ') : '（还没有席位被唤醒）'}\n` +
        '★ 用户口径③：「待机」是**可见的「已登记未开工」** —— 而"未到点不得开工"必须是**产物面**的判据，\n' +
        '  不是一句提醒。这条判据与承接它的另两条同源：交接物面（本处）/ 文件面（守门 own-dir）/ ' +
        '测试执行面（守门测试命令）。缺任一条，"叫醒即抢跑"就还留着通路。\n' +
        '下一步：等主管在**到点**之后发起唤醒（pipeline_supervise action=agree_need / confirm_diagram）。',
    )
  }

  /**
   * ★★ 主管枢纽账本的**唯一写点**（T-20261011-56a37e）。
   *
   * 什么时候写什么，全部由**事件名**决定（不靠调用方自觉传参）：
   *   · `supervisor_initiate`        ⇒ 建账本（enabled=true）+ 按 `HUB_STANDBY_SEATS`
   *                                     逐席登记「已登记待机」（这就是"待机要能看出来"的数据面）
   *   · `supervisor_agree_need`      ⇒ **唤醒点 A**：把该唤醒点下的席位标成 woken
   *   · `supervisor_confirm_diagram` ⇒ **唤醒点 B**：把计划位标成 woken
   *   · `supervisor_reject_diagram`  ⇒ 重画计数 +1（预算见 HUB_DIAGRAM_REDRAW_BUDGET）
   *
   * ⚠️ 它**只写账本**，不判任何东西 —— 判定在 `checkPrecondition` 的 guard 里
   *   （判与写分开，才不会出现"判过了但没写"的中间态）。
   *
   * @param {object} task
   * @param {string} event
   * @param {string} to
   * @param {object} input
   */
  function applyHubSideEffects(task, event, to, input) {
    const actor = input?.actorRole ?? ''
    /**
     * ★★ P0-1 **入口**：主对话把任务递给主管（用户新口径第 1 跳）。
     *
     * 它**不建待机名册**（"主管拉起三席"是主管 `initiate` 的活，用户原话的顺序就是这样），
     * 只落一件事实：**谁在什么时候把这张单交给了主管**（`hub.entry`）。
     *
     * ⚠️ `enabled` 刻意保持 `false`：枢纽的"启用"以**主管真的发起**为准。
     *   若在这里就把 enabled 置真，`hub_initiate` 的"已发起"判据会被自己骗过去
     *   （改前那条判据看的就是 enabled）—— 那会让主管的发起变成空操作。
     *   而"递单之后主对话不许再自己派需求位"这件事由 `hub_initiate_required`
     *   的第二个触发面负责（它读的就是 `hub.entry`）。
     */
    if (event === 'handoff_to_supervisor') {
      const at = nowIso(now())
      const prev = hubOf(task) ?? {}
      task.hub = {
        ...prev,
        enabled: false,
        entry: {
          by: actor,
          at,
          via: input?.via ?? 'pipeline_transition',
          note: String(input?.note ?? ''),
        },
        standby: [],
      }
      return
    }
    if (event === 'supervisor_initiate') {
      const at = nowIso(now())
      task.hub = {
        enabled: true,
        initiated_by: actor,
        initiated_at: at,
        initiated_via: input?.via ?? 'pipeline_supervise',
        /**
         * ★ P0-1：**入口留痕随发起一起带过去**（不许被发起覆盖掉）。
         *   "谁把单递给主管的"与"谁发起的"是两条都必须可追溯的事实：
         *   改前 `task.hub` 是整体重建，一旦有入口这条就会被抹掉。
         */
        entry: hubOf(task)?.entry ?? null,
        standby: HUB_STANDBY_SEATS.map((s) => ({
          role: s.role,
          group: s.group,
          wake_point: s.wake_point,
          /** ★ 可观测的「已登记未开工」：状态只有这两个取值。 */
          status: 'standby',
          registered_at: at,
          registered_by: actor,
          woken_at: null,
          woken_by: null,
        })),
        diagram_redraws: 0,
        redraw_budget: HUB_DIAGRAM_REDRAW_BUDGET,
        /**
         * ★★ **站点否掉的计数与留痕**（T-20261011-56a37e 补齐）。
         * 与 `diagram_redraws` 同形：计数按站点分开（各自独立额度），
         * `reject_history` 逐条记「哪一站 · 谁 · 什么时候 · 为什么 · 退到哪」——
         * 这就是"否掉也**不许静默**"的数据面（`pipeline_status` 的 hub 一节直接读回）。
         */
        station_rejects: Object.fromEntries(HUB_STATION_REJECT_STATIONS.map((st) => [st, 0])),
        reject_budget: HUB_STATION_REJECT_BUDGET,
        reject_history: [],
        wakes: [],
      }
      return
    }
    if (!hubEnabled(task)) return

    /** 唤醒某个唤醒点下的**全部**待机席位（幂等：已唤醒的不重复记）。 */
    const wakePoint = (wp, note) => {
      const at = nowIso(now())
      let n = 0
      for (const e of hubStandby(task)) {
        if (e?.wake_point !== wp || e?.status === 'woken') continue
        e.status = 'woken'
        e.woken_at = at
        e.woken_by = actor
        n += 1
      }
      task.hub.wakes = Array.isArray(task.hub.wakes) ? task.hub.wakes : []
      task.hub.wakes.push({ wake_point: wp, at, by: actor, woken: n, note: String(note ?? ''), to_state: to })
      return n
    }

    if (event === 'supervisor_agree_need') {
      // ★ **唤醒点 A**：主管同意需求结论 ⇒ 架构位（architect / diagrammer）到点开工。
      wakePoint(HUB_WAKE_POINTS.NEED_AGREE, '主管同意需求结论')
      return
    }
    if (event === 'supervisor_confirm_diagram') {
      /**
       * ★★ P0-1：**唤醒点 B 从这里搬到了主管的"二次确认"那一跳**。
       *
       * 用户新口径是「架构图完成 → 主管确认（转交需求位）→ **需求位确认** →
       *   **主管二次确认** → **无问题后**才把架构图递交计划位」。
       * 既然计划位的开工必须排在**二次确认之后**，唤醒点 B 就只能挂在那一跳上 ——
       * 挂在这里会让计划位在需求位还没确认时就开工（"叫醒即抢跑"）。
       *
       * ★ 唤醒点本身（常量、待机名册、产物面判据）一个字没动，只是**触发它的那一跳**变了。
       * ★ 这一跳现在是"主管把架构图**转交需求位**"（`arch_confirm → arch_need_confirm`），
       *   它**不叫醒任何席位** —— 需求位本来就在册、本来就在干活，不需要"到点才动"。
       */
      return
    }
    if (event === 'supervisor_reconfirm_diagram') {
      // ★ **唤醒点 B**：主管**二次**确认（无问题）⇒ 计划位到点开工。
      wakePoint(HUB_WAKE_POINTS.DIAGRAM_CONFIRM, '主管二次确认架构图满足要求')
      return
    }
    if (event === 'supervisor_reject_diagram') {
      task.hub.diagram_redraws = (Number.isInteger(task.hub.diagram_redraws) ? task.hub.diagram_redraws : 0) + 1
      task.hub.redraw_history = Array.isArray(task.hub.redraw_history) ? task.hub.redraw_history : []
      task.hub.redraw_history.push({ at: nowIso(now()), by: actor, reason: String(input?.note ?? '') })
      return
    }
    // ★★ **站点否掉的账本**（T-20261011-56a37e 补齐）—— 与上面那条同形：
    //   **由事件名决定写什么**（不靠调用方自觉传参），并且**只写账本、不判任何东西**
    //   （判定在 `checkPrecondition` 的 `hub_station_reject_budget` / `hub_station_reject` 里；
    //   判与写分开，才不会出现"判过了但没写"的中间态）。
    const rejectStation = HUB_REJECT_EVENT_STATIONS[String(event ?? '')]
    if (rejectStation !== undefined) {
      const cur = task.hub.station_rejects !== null && typeof task.hub.station_rejects === 'object' && !Array.isArray(task.hub.station_rejects)
        ? task.hub.station_rejects
        : {}
      cur[rejectStation] = (Number.isInteger(cur[rejectStation]) ? cur[rejectStation] : 0) + 1
      task.hub.station_rejects = cur
      task.hub.reject_history = Array.isArray(task.hub.reject_history) ? task.hub.reject_history : []
      task.hub.reject_history.push({
        station: rejectStation,
        at: nowIso(now()),
        by: actor,
        reason: String(input?.note ?? ''),
        /** ★ 退回哪儿（就是这一跳的落点）—— "否掉之后去哪儿"要能一眼读出来。 */
        back_to: to,
      })
    }
  }

  /**
   * 找到"当前这一轮"有效的审核 OK。
   *
   * 有效 = 结论 OK 且 artifact_version 等于当前有效制品版本，且**在最近一次
   * 打回之后**（打回会把上一轮的 OK 作废 —— 否则改完代码还能拿旧 OK 关单）。
   *
   * @returns {object|null}
   */
  function effectiveReviewOk(task) {
    const version = currentArtifactVersion(task)
    if (version === null) return null
    let lastReworkAt = -1
    for (let i = 0; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind === 'test_to_dev' || h.kind === 'review_verdict_ng') lastReworkAt = i
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'NG') lastReworkAt = i
    }
    for (let i = task.handoffs.length - 1; i > lastReworkAt; i--) {
      const h = task.handoffs[i]
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'OK' && h.artifact_version === version) return h
    }
    return null
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  return {
    projectRoot,
    root,
    artifactDirName: dirName,
    maxReworkPerLeg: maxRework,
    /** ★ 失联静默阈值（毫秒）——`checkLiveness` 用它，工具层也会原样报给用户看。 */
    seatSilenceMs: seatSilence,
    /**
     * ★★ **运行失败取证**（A9 的"判词必须携带该次失败的证据"）。
     *
     * 由插件入口（`index.js`）注入：它拿得到 `ctx.agents`（进程内会话事件）与
     * 会话目录（落盘日志）。**没注入时**（自测替身 / 装配不全）`checkLiveness`
     * 退回改前那三条判据 —— 既不算崩也不算闲的那一档**不许假装知道**。
     *
     * @type {((task:object, silent:Array<object>) => Promise<{known:boolean, found:boolean, evidence:object|null, source:string, note:string}>)|null}
     */
    detectRunFailure: typeof opts.detectRunFailure === 'function' ? opts.detectRunFailure : null,
    taskDir,
    handoffDir,
    artifactDir,
    auditFile,

    /** 内部查表（守门判据要用同步接口，所以暴露同步的缓存查询）。 */
    peek: requireTask,
    /** 同步：任务是否在缓存里（落盘后首次访问前为 false）。 */
    isLoaded: (id) => cache.has(id),
    /** 某个任务的工作区目录 —— 守门判据用它做"受保护路径"判定。 */
    workspaceOf: (id) => taskDir(id),

    /**
     * 开单。主对话的动作。
     *
     * @param {object} input
     * @param {string} input.requirement
     * @param {string[]} [input.constraints]
     * @param {string[]} [input.acceptance]
     * @param {string} [input.deadline]
     * @param {string} [input.deliverableFormat]
     * @param {string} [input.id] - 指定任务 id（测试用）
     * @param {string} input.actorRole - 调用方角色（必须是 main）
     * @param {string} input.actorAgentId
     */
    async open(input) {
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话（main）能开单，当前调用方是「${roleLabel(input.actorRole)}」。这一步是流水线的入口，必须由主对话发起。`,
        )
      }
      const requirement = String(input.requirement ?? '').trim()
      if (requirement.length === 0) return deny('BAD_ARGUMENT', '开单必须给 requirement（原始需求）。')

      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : newTaskId(now())
      if (cache.has(id) || existsSync(taskFile(id))) {
        return deny('TASK_EXISTS', `任务 ${id} 已存在，请换一个 id。`)
      }

      const stamp = nowIso(now())
      const task = {
        id,
        created_at: stamp,
        updated_at: stamp,
        state: ST.PENDING,
        previous_state: null,
        project_root: projectRoot,
        requirement,
        constraints: toStringArray(input.constraints),
        acceptance_from_user: toStringArray(input.acceptance),
        deadline: typeof input.deadline === 'string' ? input.deadline : '',
        deliverable_format: typeof input.deliverableFormat === 'string' ? input.deliverableFormat : '',
        /** 角色清单：null 表示还没做计划分配（planner 尚未产出）。 */
        roster: null,
        /** 任务卡：需求分析 + 计划分配的产物。 */
        task_card: null,
        artifact_version_counter: 0,
        /** 打回计数：dev = 被打回编写的次数；test = 被打回测试的次数。 */
        rework: { dev: 0, test: 0 },
        /** 每一次动作的流水（审计日志的镜像，便于一屏看全）。 */
        history: [],
        /**
         * ★ **哈希前置闸门连续不通过计数**（用户拍板 P13）。
         *
         * 归零的**唯一**时点：一次**闸门真通过**的提交（或用户答复了自动升级那件事，
         * 见 `replyHumanRequest` 里的"重新武装"）。撤回越界改动**不**归零 ——
         * 理由写在 `lib/hashgate.js` 的 `nextHashGateStreak`。
         */
        hash_gate_streak: 0,
        /** 每一次哈希比对的结果（含失败的时间与理由）—— 可追溯。 */
        hash_gate_checks: [],
        /** 最后一次比对的可同步判据（守门分支 4g 读它）。 */
        hash_gate: null,
        /**
         * ★ **自动交人工**的记录（连续不过到阈值时由机制写）。
         * 形状：`{ round, at, streak, threshold, request_id, handoff_id, from_role, answered_at, ... }`
         * `answered_at === null` = **还没了结** ⇒ 既不再重复升级，也**拒收**同一任务的再次提交。
         */
        hash_gate_escalation: null,
        /** 交接物（完整记录，同时逐个落盘）。 */
        handoffs: [],
        /** 制品登记表。 */
        artifacts: [],
        /** 角色变更申请。 */
        roster_requests: [],
        /**
         * ★ **授权面变更（amendment）历史** —— 窄通道 `pipeline_scope_amend` 留下的账。
         *
         * 为什么需要这条通道（真事，不是设计洁癖）：用户已经在**需求层**裁定
         * "允许把某样东西纳入授权面"，但计划工具只在「计划中」交得进计划
         * （`checkHandoffAgainstState` 的 `plan: [ST.PLANNING]`）——
         * 任务一进「待开发」，就变成 **裁定有了、动作做不了**，那个交付单元卡死。
         *
         * 每次变更在这里留一条：谁、何时、加了什么、**为什么**、
         * 变更前后的授权面长什么样。形状：
         *   `{ amendment_id, at, by, agent, why, note, state_at_amend,
         *      added[], removed[], forbidden_added[], forbidden_removed[],
         *      before{change_scope[],forbidden[]}, after{change_scope[],forbidden[]} }`
         * ★ 它**只**记授权面的变化 —— 席位/角色清单/档位/顺序/层根本不在这条通道的能力范围内。
         */
        amendments: [],
        /**
         * ★ 各编写席位本轮的提交情况（`dev_to_test` 落在这里）。
         * 进「开发中」时清空；**全部在册席位到齐**才允许推进到「待测试」。
         * 键 = 席位 id（`writer#1`…），值 = `{handoff_id, artifact_version, at}`。
         */
        writer_submissions: {},
        // ★ 需求档**不在这里登记** —— 它靠**目录约定**定位：
        //     <项目根>/.pipeline/<taskId>/requirement.md（人可读）
        //     <项目根>/.pipeline/<taskId>/requirement.json（结构化）
        //     <项目根>/.pipeline/<taskId>/requirement.index.json（版本索引）
        //   为什么不在任务卡里记路径：**每个 AI 只干自己的事** ——
        //   需要需求的人自己去约定目录读，不需要主对话告诉它"文件在哪"。
        //   主对话的任务卡也**不引用**该文件。
        //   （上一轮曾把路径 + sha256 记进任务卡，那条已作废。）
        /** ★ 上下文水位上报（席位自报 + 必须给依据）。 */
        context_reports: [],
        /**
         * ★ 席位继任记录（**换班**，不是改角色）。
         * shape：{ succession_id, seat, role, from_agent, to_agent, handoff_id, reason, at, generation }
         */
        successions: [],

        /**
         * ★ 两级升级梯**第一级**的生命周期记录（每一条对应一份 clarification_request）。
         * 提问 → 需求分析裁定（答了 / 答不了）→（必要时）升级。
         */
        clarification_requests: [],
        /**
         * ★ 人工介入请求的**生命周期**记录（每一条对应一份 human_request 交接物）。
         * 四步都留在这里 + audit.jsonl：发起 → 转告 → 答复 → 恢复。
         */
        human_requests: [],
        /**
         * ★ **全量测试审批链**（用户要求：测试要跑全量，必须四级都点头）。
         *
         * 与别的"请求列表"的区别：这里记的是**一条链**的进度，不是一堆散请求 ——
         * 四站（需求分析 → 审核 → 人工 → 计划）是同一条链上的四个节点，
         * 任一站否决就整条停住（`status='rejected'` + `rejected_at_stage`）。
         */
        full_test_approvals: [],
        /**
         * ★ **派活台账**：派出去了哪些席位、什么时候派的。
         *
         * 形状：`{ key, role, seat, agent_id, token, at, at_ms, via }`。
         * 为什么必须落盘（而不是只放内存）：进程重启后 `pipeline_status` 要能回答
         *   「这个任务是派出去了没人回，还是根本没派出去」—— 那是两件完全不同的事。
         * ★ 它是失联检测（`lib/liveness.js`）的**唯一计时起点**。
         */
        dispatched: [],
        /**
         * ★ **失联处置台账**：机制因为"席位失联"做过什么（谁、什么时候、推到哪个状态）。
         * 形状：`{ at, at_ms, seats:string[], to_state, reason }`。
         */
        liveness: { escalations: [] },
        close_report: null,
      }
      cache.set(id, task)
      await persist(task)
      const entry = await audit(id, ROLE.MAIN, 'open', { requirement_digest: shortHash(requirement), agent: input.actorAgentId })
      task.history.push(entry)
      await persist(task)

      return { ok: true, task, summary: `已开单 ${id}，状态：${STATE_LABEL[ST.PENDING]}。下一步：pipeline_orchestrate 做**需求分析**（出任务卡 + 不清楚处清单；分配 AI 是后面 planner 的事）。` }
    },

    /**
     * ★ **认领一张已存在的任务单** —— 重启后的恢复入口（2026-10-11 补）。
     *
     * ---------------------------------------------------------------------
     * 为什么需要它（现场）
     * ---------------------------------------------------------------------
     * DSH 重启后：会话↔角色绑定（`lib/tokens.js` 的内存 Map）与角色令牌**全部丢失**，
     * 而 {@link open} 对已存在的 id 一律 `deny('TASK_EXISTS')` —— 于是老单成了**孤儿**：
     *   · 不能推进（没有身份）；
     *   · 不能取消（`states.js` 里 `cancel` 这条边**一直都有**，只是**身份先没了**，
     *     连状态机都走不到 —— 这一点很容易被误判成"状态机缺边"）；
     *   · 也不能用同一个 id 重开。
     * 用户当初拍板的设计要求是「**被切断后要能恢复**」，这一条正是补上那个缺口。
     *
     * ---------------------------------------------------------------------
     * 为什么是"认领"而不是"覆盖重开"
     * ---------------------------------------------------------------------
     * 直接覆盖会丢掉 `history` / `handoffs` / `artifacts` 整条审计链，
     * 而"可追溯"是本插件的核心卖点之一。认领**保留全部历史**，只换身份。
     *
     * ---------------------------------------------------------------------
     * 边界（诚实写出来，别在别处又吹一遍）
     * ---------------------------------------------------------------------
     * · 本方法**不校验调用方身份** —— 它没法校验：重启后谁都拿不出令牌。
     *   这与 `open()` 的既有安全等级**相同**：`pipeline_task_open` 在守门表里
     *   （`lib/guard.js` 的 `PIPELINE_TOOL_ROLES`）本就是 `null`（不判角色），
     *   所以"谁都能认领"**没有降低任何门槛** —— 现状是"谁都能开新单并成为它的主对话"。
     * · 真正要保留的不变量是「一个任务同时只认一个主对话会话」，由**铸新令牌 +
     *   覆盖绑定**体现：旧会话的令牌已随重启失效，不存在两个活跃 main。
     * · 终态（已关闭 / 已取消）的单**也允许认领**（用户可能只是要看它一眼），
     *   但会被标成 `terminal: true`，提示层据此说明"它已经走完了，推不动了"。
     *
     * @param {string} taskId
     * @param {{agentId?:string|null}} [opts]
     * @returns {Promise<{ok:true, task:object, reattached:true, terminal:boolean} | {ok:false, error:string}>}
     */
    async reattach(taskId, opts = {}) {
      const id = String(taskId ?? '')
      if (id.length === 0) {
        return deny('BAD_ARGUMENT', '认领必须给 task_id（那张已存在的单的 id）。')
      }

      const task = await loadTask(id)
      if (task === null) {
        return deny(
          'TASK_NOT_FOUND',
          `找不到任务 ${id}，无法认领。\n` +
            '★ 认领（`reattach`）只针对**已存在**的单；要开新单请不带 `reattach` 调用。\n' +
            `  工作区：${root}`,
        )
      }

      const terminal = TERMINAL_STATES.includes(task.state)
      const entry = await audit(id, ROLE.MAIN, 'reattach', {
        agent: typeof opts.agentId === 'string' ? opts.agentId : null,
        from_state: task.state,
        note: '★ 重启后重新认领主对话身份（不覆盖任何历史）',
      })
      task.history.push(entry)
      await persist(task)

      return { ok: true, task, reattached: true, terminal }
    },

    /** 取任务（不同步落盘）。 */
    async get(taskId) {
      return loadTask(taskId)
    },

    /** 列任务（扫目录）。 */
    async list() {
      if (!existsSync(root)) return []
      const dirs = await readdir(root, { withFileTypes: true })
      const out = []
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const t = await loadTask(d.name)
        if (t !== null) out.push({ id: t.id, state: t.state, state_zh: STATE_LABEL[t.state], requirement: clamp(t.requirement, 120), created_at: t.created_at })
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    /**
     * 应用一次状态转移。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.event
     * @param {string} input.actorRole
     * @param {string} [input.actorAgentId]
     * @param {string} [input.note]
     */
    async transition(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const from = task.state
      // ★ **恢复点**（本轮修 ①：重复 `block` 覆盖恢复点 ⇒ `unblock` 空转）。
      //
      //   现场（真单 T-20261011-5a871c）：主对话对同一张单 `block` 了两次。
      //   `block` 是 `{ from:'*' }`，所以第二次的 `from` 已经是 `blocked`；而记
      //   恢复点的那条判据只问"`from` 是不是等待态"，对 `blocked` 照样成立
      //   ⇒ **恢复点被覆盖成 `blocked` 自己** ⇒ 之后 `unblock` 回退到 `blocked`，
      //   成了空操作（主对话连调两次，回执都是「已阻塞 → 已阻塞」；audit 两条都在）。
      //
      //   两处收紧/兜底：
      //     · **首次才记**：已经处在阻塞态时**不覆盖**（下面 `repeatedBlock` 那条）；
      //     · **不可用就回落**：`unblock` 时若恢复点缺失 / 等于 `blocked` / 非法，
      //       按**该任务自己的进度**回落到一个明确的合法状态（`states.js` 的
      //       `resolveUnblockRecovery`），并把回落原因写进 audit。
      //   两条都**不碰终态**：`cancelled` / `closed` 上的 `block` 本来就被状态机拒掉，
      //   回落也只落在 `developing` / `ready_dev` 两个非终态上。
      const repeatedBlock = from === ST.BLOCKED && input.event === 'block'
      let previousForApply = task.previous_state ?? undefined
      /** 修好后的恢复点（非 null 时才写回账本，免得被下面的通用规则盖掉）。 */
      let repairedPrevious = null
      /** 与本次转移有关的说明，进 audit / history（回落原因 / 恢复点保持不变）。 */
      let ledgerNote = ''
      if (input.event === 'unblock') {
        const rec = resolveUnblockRecovery(task)
        if (rec.ok === true) {
          previousForApply = rec.state
          if (rec.fallback === true) {
            // ★ **就地修好账本**：把恢复点写回一个合法落点，下一次 `unblock`
            //   就走正常路径、不用再回落一遍（"已卡死的单也要能一次性救回来"）。
            repairedPrevious = rec.state
            ledgerNote = rec.reason
          }
        }
      }
      const res = applyTransition(from, input.event, input.actorRole, previousForApply)
      if (res.ok !== true) {
        return deny('BAD_TRANSITION', `状态迁移被拒（任务 ${task.id}）：${res.error}`)
      }

      // --- 迁移前置条件（guard 名 → 判据）----------------------------------
      const g = res.transition.guard
      if (g !== undefined) {
        const check = await this.checkPrecondition(task, g, input)
        if (check.ok !== true) return check
      }

      // ★ **不把等待态记进 previous_state**。
      //
      //   为什么：两级升级梯会有「待测试 → 等需求分析 → 等用户」这样的链。
      //   如果每跳都记，previous_state 会被写成 'awaiting_clarification'，
      //   用户答复完就"恢复"到"等需求分析" —— 任务永久卡死。
      //   规则本身是通用的：**等待态不是"被打断的工作"**，它只是路上的一站。
      if (repeatedBlock) {
        // ★ 修 ①：**已经在阻塞态 ⇒ 恢复点已存在，保持不变**（不覆盖）。
        //   覆盖的后果就是上面那段现场："回到阻塞前的状态"变成了"回到已阻塞"。
        ledgerNote =
          `恢复点已存在（${typeof task.previous_state === 'string' && task.previous_state.length > 0 ? task.previous_state : '缺失'}），保持不变。` +
          '（重复 block 不覆盖恢复点 —— 否则 unblock 会退化成空操作。）'
      } else if (!WAITING_STATES.includes(from)) {
        task.previous_state = from
      }
      // 回落的修复写在**后面**：让上面那条通用规则先跑完，再把账本改成可用的落点。
      if (repairedPrevious !== null) task.previous_state = repairedPrevious
      task.state = res.to
      // ★★ 主管枢纽的**唯一写点**（T-20261011-56a37e）。
      //   为什么放在这里而不是各个 guard 里：guard 的职责是**判**，
      //   写账本是状态推进的一部分 —— 两件事混在一起会出现"判过了但没写"的中间态。
      //   放在 `persist(task)` 之前 ⇒ 要么全落盘、要么一点都不落（与既有的
      //   "交接物 + 状态一起落、失败一起撤"同一条纪律）。
      applyHubSideEffects(task, input.event, res.to, input)
      // ★ 进「开发中」= 新一轮编写开始：清空上一轮的席位提交表。
      //   打回重做时这一条尤其重要 —— 否则上一轮的提交记录会让「全部到齐」判据误判为已齐。
      //
      //   ★★ 2026-10-14 判据修正（真单 T-20261011-5a871c）：判据从**状态**改成**事件**。
      //     · 原判据：`res.to === ST.DEVELOPING` —— 把「恢复」也当成「开新一轮」。
      //     · 新判据：`res.to === ST.DEVELOPING && !RESUME_EVENTS.has(input.event)` ——
      //       `(previous)` 那一类事件（unblock / human_reply / clarification_reply）是
      //       **同一轮续做**，不清表；其余（`dispatch_writer`，含打回重做那一次）照旧清。
      //   实测形状：11:33:40Z writer#1 交付（1/3，被席位闸**合法**拦下）→ 12:01:32Z block
      //     → 12:23:03Z unblock ⇒ 原来的判据在这里把提交表清成 `{}`，于是
      //     ① 「全部到齐」在本轮永远凑不齐（席位白交）；② 交付 H-073a6a57aaf0ecc7 不再算
      //     「本轮交付」⇒ `patrol.js:260-262` 的兜底支也不成立 ⇒ **一条播报都没有**。
      //   ⚠️ 刻意**不放宽**：`dispatch_writer` 那两条边（ready_dev / returned_to_dev ⇒ developing）
      //     是唯一的"开新一轮"，它们照旧清空 —— 「打回重做时上一轮记录不许冒充本轮已齐」不受影响。
      if (res.to === ST.DEVELOPING && !RESUME_EVENTS.has(input.event)) task.writer_submissions = {}
      const entry = await audit(task.id, input.actorRole, `transition:${input.event}`, {
        from,
        to: res.to,
        note: [input.note ?? '', ledgerNote].filter((s) => String(s).length > 0).join(' '),
        agent: input.actorAgentId,
        // ★ 结构化留痕：恢复点这一笔独立成字段，翻 audit 时不必去解析 note 文本。
        ...(ledgerNote.length > 0
          ? { recovery_point: { used: res.to, previous_state: task.previous_state ?? null, fallback: repairedPrevious !== null } }
          : {}),
      })
      task.history.push(entry)
      await persist(task)

      return {
        ok: true,
        task,
        from,
        to: res.to,
        state_zh: STATE_LABEL[res.to],
        summary: `任务 ${task.id}：${STATE_LABEL[from]} → ${STATE_LABEL[res.to]}。`,
      }
    },

    /**
     * ★ **记一条派活台账**（失联检测的计时起点）。
     *
     * 为什么由 store 来记、而不是派活那边直接塞：
     *   · 落盘要原子写（`persist` 已经做了）；
     *   · 派活**失败**时不该留下台账（否则会被误判成"派出去了没回话"）——
     *     所以调用方只在 `res.ok === true` 之后调这里。
     *
     * 同一 (role, seat) 重复派活**覆盖**旧记录：重派之后按新的时间算超时。
     *
     * @param {string} taskId
     * @param {{role:string, seat?:string|null, agentId?:string|null, token?:string|null, at?:string, atMs?:number, via?:string}} entry
     * @returns {Promise<{ok:boolean, error?:string, task?:object, entry?:object}>}
     */
    async recordDispatch(taskId, entry) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const at = typeof entry?.at === 'string' && entry.at.length > 0 ? entry.at : nowIso(now())
      const next = upsertDispatch(task.dispatched, { ...entry, at })
      task.dispatched = next
      await persist(task)
      const rec = next.find((x) => x.key === seatKey(entry?.role, entry?.seat)) ?? null
      return { ok: true, task, entry: rec }
    },

    /**
     * ★ **查一次失联**（纯计算 + 可选的自动处置）。
     *
     * 语义分两段，**必须分清**（这决定了调用方怎么用它）：
     *   · `escalate !== true` ⇒ **只报告，不改任何东西**（`pipeline_status` 走这条）。
     *   · `escalate === true` ⇒ 发现失联就把任务推到「已阻塞」并写明原因
     *     （`tools/pre-execute` 那条缝走这条 —— "任意角色的下一次工具调用"）。
     *
     * 为什么自动处置挑 `block` 而不是新开一个状态：
     *   `states.js` 里已有一条 `{ from:'*', event:'block', to: BLOCKED, by:['main','human'] }`
     *   —— "任意非终态可阻塞"。复用它 = 不新开状态、不新开工具、不新开并行机制；
     *   而且 `blocked` 之后 `EXPECTED_ROLES_BY_STATE` 里没有它 ⇒ **不会重复升级**（自解除武装）。
     *   要解除：`pipeline_transition event=unblock` 回到阻塞前那个状态。
     *
     * ★ 失败分支不吞：拿不到任务就返回结构化的 `ok:false`，**不假装查过了**
     *   （"查不到"和"没失联"是两件事 —— 静默 fail-open 就是假绿）。
     *
     * @param {string} taskId
     * @param {{now?:number, escalate?:boolean, silenceMs?:number}} [opts]
     * @returns {Promise<object>}
     */
    async checkLiveness(taskId, opts = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)

      const atMs = typeof opts.now === 'number' ? opts.now : now().getTime()
      const silenceMs =
        Number.isInteger(opts.silenceMs) && opts.silenceMs > 0
          ? opts.silenceMs
          : Number.isInteger(this.seatSilenceMs) && this.seatSilenceMs > 0
            ? this.seatSilenceMs
            : DEFAULT_SEAT_SILENCE_MS

      // ★★ B2：先**现采**一次会话日志（size / mtime），再交给纯判据判。
      //
      //   为什么在这里采：判据是纯函数（`lib/liveness.js`），采样要碰磁盘 ——
      //   采样的活属于 store 层。**采不到就整份给 null**（= 本次没有活动证据），
      //   绝不给一个空对象冒充"它没动"（那会把"拿不到"误报成"死了"）。
      const activity = sampleSessionActivity(task, atMs, Number.isInteger(opts.activityMaxMs) ? opts.activityMaxMs : undefined)

      const live = seatLiveness(task, atMs, {
        silenceMs,
        activity: activity.samples,
        gateApplicable: activity.gate_applicable === true,
        confirmations: Number.isInteger(opts.confirmations) ? opts.confirmations : undefined,
      })
      const base = {
        ok: true,
        task,
        live,
        silent: live.silent,
        pending: live.pending,
        escalated: false,
        silence_ms: silenceMs,
        // ★ B5 修复：唤醒的幂等判别子要取**这里真实返回的字段**。
        //   改前 `lib/intercept.js` 取的是 `res.seats` / `res.escalations` ——
        //   这个返回值里**两个都不存在** ⇒ 判别子恒为 `|0` ⇒ 两次不同的失联
        //   拿到同一个交付键（实测：2026-10-11T16:51:40Z 与 2026-10-12T12:58:36Z
        //   两条 wake:delivered 的 key 逐字相同）。
        seats: live.silent.map((s) => s.key),
        escalations: Array.isArray(task.liveness?.escalations) ? task.liveness.escalations.length : 0,
        /** ★ 活动采样是否可用（false ⇒ 判据更保守，见 liveness.js 的 confirmations）。 */
        activity_known: live.activity_known,
        gate_applicable: live.gate_applicable,
        activity: activity.samples,
        activity_note: activity.note,
      }

      // ★ B2：把本次采样与"连续没证据"计数落盘 —— 下一次观察才有基线可对比。
      //   只在真的采样到东西时写，避免每个工具调用都写一次任务文件。
      //
      //   ★★ 2026-10-13 快修（②，P0-3 的另一半）：**pending 的轮次也必须落盘**。
      //   改前只有 `samples !== null` 才写，于是"一个候选根都没命中"的那些轮次
      //   （正是本案的形状）计数器永远回不到台账 ⇒ 确认门**永远凑不满** ⇒ 门一旦开着
      //   就再也不冻结任何席位（静默把检测关掉）。现在无样本但有 pending 时也写一次，
      //   保证"两到三次观察内一定有个结论"。
      //   ⚠️ 只在**这一张单真的在等结论**时才写（`pending.length > 0`），
      //      所以"每个工具调用都写一遍任务文件"的老顾虑没有被放宽。
      if (activity.samples !== null || live.pending.length > 0) {
        try {
          task.liveness = task.liveness ?? { escalations: [] }
          if (activity.samples !== null) {
            task.liveness.samples = { ...(task.liveness.samples ?? {}), ...activity.samples }
          }
          const quiet = { ...(task.liveness.quiet ?? {}) }
          for (const s of live.seats) quiet[s.key] = s.quiet_streak
          task.liveness.quiet = quiet
          await persist(task)
        } catch (err) {
          this.warn?.(`[pipeline] 失联采样留痕失败（不影响本次判定）：${String(err?.message ?? err)}`)
        }
      }

      /**
       * ★★ **误判自愈（本轮修复）** —— "座位其实活着"时，把那次误判造成的阻塞**收回**。
       *
       * 为什么放在**这里**（`live.silent.length === 0` 那道早退之前）：
       *   任务一旦被推成「已阻塞」，`EXPECTED_ROLES_BY_STATE` 里根本没有 `blocked`
       *   ⇒ `expected` 是空数组 ⇒ `silent` 恒为空 ⇒ 走不到下面任何一支。
       *   换句话说：**冻结之后，所有"失联"相关的分支都不再跑了** —— 这正是
       *   "冻结是一次性的、收回只能靠人"的结构性原因。自愈必须挂在早退**之前**。
       *
       * 两条纪律（与"不许放宽真失联的判定"直接对应）：
       *   · **留痕永远做**（哪怕 `escalate:false` 的"只报告不处置"档）——
       *     用户原话：「或至少在 audit 里写明"疑似误判 + 依据"，让主对话一眼能看出」。
       *   · **改状态只在 `escalate === true` 时做**，且只认 {@link livenessSelfHeal} 的
       *     `can_unblock === true`（= 点名席位**全部**有阳性存活证据 + 恢复点仍在）。
       *     真死掉的席位拿不到阳性证据 ⇒ 这里**一个字节都不动**。
       *
       * ★★ 一处容易写错、写错就**永久堵死自愈**的地方（本轮自测抓到过）：
       *   "已标注过"这个**章**（`escalation.self_heal`）**只能在有权处置的那一轮盖**。
       *   如果 `escalate:false`（只报告档）也盖，那么后面真能处置的那一轮会看到
       *   `already:true` ⇒ **永远不敢收回** —— 那就是"只报告"把"能修"给关了。
       *   所以：`escalate:false` 时只按 `escalation_at` **去重地留痕**（不盖章、不动状态）。
       */
      const heal = livenessSelfHeal(task, live, { atMs })
      if (heal.suspects.length > 0) {
        const mayAct = opts.escalate === true
        const escsNow = Array.isArray(task.liveness?.escalations) ? task.liveness.escalations : []
        const escNow = escsNow.length > 0 ? escsNow[escsNow.length - 1] : null
        const alreadyLogged = Array.isArray(task.liveness?.suspected_false_positives) &&
          task.liveness.suspected_false_positives.some((r) => r?.escalation_at === heal.escalation_at)
        if (!alreadyLogged) {
          const healText = describeSuspectedFalsePositive(heal.suspects, {
            taskId,
            state: task.state,
            state_zh: STATE_LABEL[task.state] ?? task.state,
            unblocked: false,
            will_unblock: heal.can_unblock === true && mayAct,
            return_to: heal.will_return_to,
            reason: heal.reason,
          })
          try {
            task.liveness = task.liveness ?? { escalations: [] }
            if (!Array.isArray(task.liveness.suspected_false_positives)) task.liveness.suspected_false_positives = []
            const recHeal = {
              at: nowIso(now()),
              at_ms: atMs,
              seats: heal.suspects.map((s) => s.seat),
              basis: heal.basis,
              source: LIVENESS_ACTIVITY_SOURCE,
              escalation_at: heal.escalation_at,
              can_unblock: heal.can_unblock === true,
              unblocked: false,
              reason: heal.reason,
            }
            task.liveness.suspected_false_positives.push(recHeal)
            // ★ 章只在这一轮**有权处置**时盖（见上面那段"永久堵死"的说明）。
            if (mayAct && escNow !== null && typeof escNow === 'object') {
              escNow.self_heal = { at: recHeal.at, at_ms: atMs, basis: heal.basis, seats: recHeal.seats, unblocked: false }
            }
            await persist(task)
            await audit(taskId, ROLE.MAIN, 'liveness:suspected-false-positive', {
              seats: recHeal.seats,
              basis: heal.basis,
              source: LIVENESS_ACTIVITY_SOURCE,
              escalation_at: heal.escalation_at,
              can_unblock: recHeal.can_unblock,
              will_unblock: heal.can_unblock === true && mayAct,
              reason: heal.reason,
              note: healText,
            })
          } catch (err) {
            this.warn?.(`[pipeline] 疑似误判留痕失败（不影响本次判定）：${String(err?.message ?? err)}`)
          }
        }
      }

      if (heal.can_unblock === true && opts.escalate === true) {
        const trHeal = await this.transition({
          taskId,
          event: 'unblock',
          actorRole: ROLE.MAIN,
          actorAgentId: null,
          note:
            `★ 机制自愈（不是人叫停）：上一次「席位失联」是**误判** —— ${heal.basis}。` +
            `　依据（权威来源）：${LIVENESS_ACTIVITY_SOURCE}。` +
            `　恢复到「${STATE_LABEL[String(heal.will_return_to ?? '')] ?? String(heal.will_return_to ?? '?')}」，` +
            '让交付事件重新合法。',
        })
        if (trHeal.ok === true) {
          const taskAfter = trHeal.task
          const escsAfter = Array.isArray(taskAfter?.liveness?.escalations) ? taskAfter.liveness.escalations : []
          const escAfter = escsAfter.length > 0 ? escsAfter[escsAfter.length - 1] : null
          const fpos = Array.isArray(taskAfter?.liveness?.suspected_false_positives) ? taskAfter.liveness.suspected_false_positives : []
          const lastFp = fpos.length > 0 ? fpos[fpos.length - 1] : null
          if (lastFp !== null) lastFp.unblocked = true
          if (escAfter !== null && typeof escAfter === 'object' && escAfter.self_heal !== null && typeof escAfter.self_heal === 'object') {
            escAfter.self_heal.unblocked = true
          }
          await persist(taskAfter)
          await audit(taskId, ROLE.MAIN, 'liveness:false-positive-healed', {
            seats: heal.suspects.map((s) => s.seat),
            from: trHeal.from,
            to: trHeal.to,
            basis: heal.basis,
            source: LIVENESS_ACTIVITY_SOURCE,
            note: describeSuspectedFalsePositive(heal.suspects, {
              taskId,
              state: trHeal.from,
              state_zh: STATE_LABEL[trHeal.from] ?? trHeal.from,
              unblocked: true,
              return_to: trHeal.to,
            }),
          })
          return {
            ...base,
            task: taskAfter,
            healed: true,
            healed_seats: heal.suspects.map((s) => s.seat),
            healed_from: trHeal.from,
            healed_to: trHeal.to,
            heal_basis: heal.basis,
            heal_text: describeSuspectedFalsePositive(heal.suspects, {
              taskId,
              state: trHeal.from,
              state_zh: STATE_LABEL[trHeal.from] ?? trHeal.from,
              unblocked: true,
              return_to: trHeal.to,
            }),
          }
        }
        // 收回失败也要**说出来**（不静默吞掉）——回执里带上状态机的原话。
        return { ...base, healed: false, heal_error: trHeal.error, heal_basis: heal.basis }
      }

      if (live.silent.length === 0) return base
      if (opts.escalate !== true) return base

      /**
       * ★★ **A9 / A10：先问一句"它是不是**崩了**"，再决定冻不冻。**
       *
       * 现场：席位因模型输出层故障中止（`[MALFORMED_RESPONSE]`），机制却按
       * 「静默阈值 5 分」把任务**冻掉** —— 同一张单被冻 4 次，其中一次直接挡掉了
       * 一份**已提交**的交付（席位在冻结后仍工作了 2 分钟，那 2 分钟里交的
       * `test_to_review` 被「任务已阻塞」拒收）。
       *
       * 用户裁定：**运行失败中止不许冻**（A10），但**必须主动播报**（A11）——
       * 所以这一支既不改状态，也不安静：它把这次中止记成**自己的**一条记录
       * （带失败原文当证据），由拦截缝据此播报给主对话。
       *
       * ★ 真阳性保留（A12）：**拿不到失败证据**时这一支不生效，照旧走
       *   "真闲置超阈值 ⇒ 判失联 ⇒ 冻"那条既有判据。取证是本函数**额外**问的一句，
       *   不是替换 —— 没有任何一条判据被放宽。
       */
      if (typeof this.detectRunFailure === 'function') {
        let failure = null
        try {
          failure = await this.detectRunFailure(task, live.silent)
        } catch (err) {
          this.warn?.(`[pipeline] 运行失败取证异常（按"没有失败证据"处理，退回既有失联判据）：${String(err?.message ?? err)}`)
          failure = null
        }
        if (failure !== null && failure.found === true) {
          const abort = await this.recordSeatAbort(taskId, {
            seats: live.silent.map((s) => s.key),
            evidence: failure.evidence ?? null,
            detectedVia: String(failure.source ?? ''),
            note: `席位运行失败中止（不是闲置）：${String(failure.note ?? '')}`,
          })
          return {
            ...base,
            escalated: false,
            aborted: true,
            abort_id: abort.ok === true ? abort.abort_id : '',
            abort_text: describeRunFailures(live.silent, {
              evidence: failure.evidence ?? null,
              taskId,
              state: task.state,
              state_zh: STATE_LABEL[task.state] ?? task.state,
            }),
            note:
              `席位**运行失败中止**（不是闲置，任务**不冻结**）：${live.silent.map((s) => `${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}`).join('、')}` +
              `　取证：${String(failure.source ?? '?')}　${String(failure.note ?? '')}`,
          }
        }
      }

      // 重复升级的闸：同一批席位、且距上次处置还没过一个静默窗口 ⇒ 不重复推状态。
      // （正常情况到不了这里 —— 升到 blocked 之后 `live.silent` 已经是空的了。
      //   留着是因为**人工可能刚 unblock 而席位还是没活**，那时该允许再升一次。）
      const escs = Array.isArray(task.liveness?.escalations) ? task.liveness.escalations : []
      const seatKeys = live.silent.map((s) => s.key).sort().join(',')
      const last = escs.length > 0 ? escs[escs.length - 1] : null
      if (last !== null && Array.isArray(last.seats) && last.seats.slice().sort().join(',') === seatKeys) {
        if (typeof last.at_ms === 'number' && atMs - last.at_ms < silenceMs) {
          return { ...base, escalated: false, note: '同一批席位在上一轮静默窗口内已处置过，不重复升级。' }
        }
      }

      const note =
        `席位失联：${live.silent.map((s) => `${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}`).join('、')}` +
        `　静默阈值 ${live.silence_zh}　原状态「${live.state_zh}」`
      const tr = await this.transition({
        taskId,
        event: 'block',
        actorRole: ROLE.MAIN,
        actorAgentId: null,
        note: `★ 机制触发（不是人叫停）：${note}`,
      })
      if (tr.ok !== true) {
        // 推不动状态也要留痕 —— 但**不写**"已处置"，免得下次以为查过了。
        return { ...base, escalated: false, note: `失联已确认，但自动阻塞失败：${tr.error}` }
      }

      tr.task.liveness = tr.task.liveness ?? { escalations: [] }
      if (!Array.isArray(tr.task.liveness.escalations)) tr.task.liveness.escalations = []
      // ★ 处置后把"连续没证据"计数归零（这次已经处置过了，下一次是新一轮观察）。
      const quietReset = { ...(tr.task.liveness.quiet ?? {}) }
      for (const s of live.silent) quietReset[s.key] = 0
      tr.task.liveness.quiet = quietReset
      tr.task.liveness.escalations.push({
        at: nowIso(now()),
        at_ms: atMs,
        seats: live.silent.map((s) => s.key),
        previous_state: tr.from,
        to_state: tr.to,
        reason: note,
        // ★ B2：把**判据依据**一起留痕 —— 事后能回答"它被判死时，会话日志到底在不在长"。
        evidence: live.silent.map((s) => ({
          seat: s.key,
          quiet_streak: s.quiet_streak,
          activity: s.activity ?? null,
        })),
        activity_known: live.activity_known,
      })
      await persist(tr.task)
      return {
        ok: true,
        task: tr.task,
        live,
        silent: live.silent,
        escalated: true,
        from: tr.from,
        to: tr.to,
        silence_ms: silenceMs,
        note,
        summary: describeSilentSeats(live.silent, { state: tr.from, state_zh: STATE_LABEL[tr.from] ?? tr.from, silenceMs, activityKnown: live.activity_known }),
      }
    },

    /**
     * ★★ **A9 / A10 / A11：把一次"运行失败中止"记成它自己的一条事实。**
     *
     * 为什么单独记而不是塞进 `liveness.escalations`：那一条是"真闲置超阈值"的
     * 处置台账（它会**改状态**），这一条**不改状态**（用户裁定不冻结）。两者的
     * 判据必须**不同源、互不冒充**（A24 同向）—— 混在一起，事后就分不出
     * "这张单是被冻的"还是"它是崩了但没冻"。
     *
     * @param {string} taskId
     * @param {{seats?:string[], evidence?:object|null, detectedVia?:string, note?:string, atMs?:number}} [spec]
     * @returns {Promise<{ok:boolean, task?:object, abort_id?:string, abort?:object, error?:string}>}
     */
    async recordSeatAbort(taskId, spec = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      task.liveness = task.liveness ?? { escalations: [] }
      if (!Array.isArray(task.liveness.aborts)) task.liveness.aborts = []
      const atMs = Number.isFinite(spec.atMs) ? spec.atMs : now().getTime()
      const at = nowIso(now())
      const seats = Array.isArray(spec.seats) ? spec.seats.map((x) => String(x)) : []
      /**
       * ★★ **A1（打回项 ③）：中止身份必须认的是"这一次崩溃"，不是"这一次观察"。**
       *
       * 现场：同一份**未变化**的中止跨观察产生了 3 个不同的 `abort_id`
       * （实测 `AB-ce70e2…` / `AB-eec10c…` / `AB-bdfbdf…`）⇒ 每查一次 `pipeline_status`
       * 就多播一条"席位中止"，且 `liveness.aborts` **无界增长**。
       * 根因：下面这个 id 里含了 `at`（= 本次观察时刻，每次调用都不同）。
       *
       * 现在：身份取**问题自己**（哪些席位 + 失败证据的内容）；
       *   · 同一次崩溃重复观察 ⇒ 证据逐字相同 ⇒ **同一个 id** ⇒ 去重，不重播（A1）；
       *   · **又一次中止** ⇒ 证据不同（含新的时刻 / 行文）⇒ 新 id ⇒ 新一条播报（A3 不被吞）。
       *   ★ 证据拿不到时退成空串 ⇒ 只按席位算（仍然稳定，不会因观察次数而变）。
       */
      const abortSig = String(spec?.evidence?.text ?? '') + '|' + String(spec?.evidence?.at ?? '')
      const abortId = `AB-${shortHash(`${taskId}|${seats.slice().sort().join(',')}|${abortSig}`)}`
      /**
       * ★ 同一件事只记一次：此前已有**席位相同、证据相同**的中止记录 ⇒
       *   直接把它还回去（同一个 id ⇒ 接雨那一侧的幂等键命中 ⇒ 不重播），
       *   且**不再向 `liveness.aborts` 追加** 也不再写一条审计（避免无界增长）。
       */
      const priorAbort = (Array.isArray(task.liveness.aborts) ? task.liveness.aborts : []).find(
        (r) => r?.abort_id === abortId &&
          String((Array.isArray(r?.seats) ? r.seats : []).slice().sort().join(',')) === seats.slice().sort().join(','),
      )
      if (priorAbort !== undefined && priorAbort !== null) {
        return { ok: true, task, abort_id: abortId, abort: priorAbort, deduped: true }
      }
      const rec = {
        abort_id: abortId,
        at,
        at_ms: atMs,
        seats,
        /** ★ 失败原文（出处 + 命中标记 + 那一段）—— A9 要求判词**携带**它。 */
        evidence: spec.evidence ?? null,
        detected_via: String(spec.detectedVia ?? ''),
        note: String(spec.note ?? ''),
        previous_state: task.state,
        /** ★ 与 `escalations[]` 最要紧的一处不同：**状态一步没动**（A10 不许冻结）。 */
        to_state: task.state,
        no_freeze: true,
      }
      task.liveness.aborts.push(rec)
      const entry = await audit(task.id, 'mechanism', 'liveness:abort', {
        abort_id: abortId,
        seats,
        evidence: rec.evidence,
        detected_via: rec.detected_via,
        note: rec.note,
        state: task.state,
        no_freeze: true,
      })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, abort_id: abortId, abort: rec }
    },

    /**
     * ★★ **A13：被拒收的交付不许静默消失。**
     *
     * 现场：机制把任务冻住之后，席位仍在工作 2 分钟，那 2 分钟里交的
     * `test_to_review` 被「任务已阻塞」（状态判据）**拒收** —— 席位那边只拿到一句
     * 拒绝理由，主对话那边什么都不知道，**内容是彻底没了**。
     *
     * 用户裁定的处置（A13）：**要么接收，要么拒收但对席位与主对话都可见且内容留档
     * （能查回原文）**。本方法就是"留档"那一半：把这条交付的**完整提交内容**
     * 追加进任务数据，并给一个可查回的句柄（`delivery_id`）。
     *
     * ★ 它与"接收"是互斥的两条路：判据不许因此放宽（状态机一个字没改），
     *   只是把"拒收"变成**可见且有据可查**。
     *
     * @param {string} taskId
     * @param {{kind?:string, code?:string, reason?:string, fromRole?:string, fromSeat?:string|null, payload?:object|null}} [spec]
     * @returns {Promise<{ok:boolean, task?:object, delivery_id?:string, delivery?:object, error?:string}>}
     */
    async archiveRejectedDelivery(taskId, spec = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      if (!Array.isArray(task.rejected_deliveries)) task.rejected_deliveries = []
      const at = nowIso(now())
      const kind = String(spec.kind ?? '')
      const deliveryId = `RD-${shortHash(`${taskId}|${at}|${kind}|${String(spec.fromRole ?? '')}`)}`
      const rawPayload = spec.payload !== null && typeof spec.payload === 'object' ? spec.payload : null
      /**
       * ★ **留档要留得住，但不能把任务文件撑爆**：超长内容截断保存并**如实标注**，
       *   绝不静默丢弃（"能查回原文"是判据，"原文有多大"不是）。
       */
      let payload = rawPayload
      let truncated = null
      if (rawPayload !== null) {
        let body = ''
        try {
          body = JSON.stringify(rawPayload)
        } catch {
          body = ''
        }
        if (body.length > MAX_REJECTED_PAYLOAD_CHARS) {
          payload = { truncated: true, chars: body.length, head: body.slice(0, MAX_REJECTED_PAYLOAD_CHARS), note: '★ 内容超长，这里只留前一段（完整原文在席位那次调用的返回值里；这条留档的意义是"它交过什么、为什么被拒"可查）。' }
          truncated = body.length
        }
      }
      const rec = {
        delivery_id: deliveryId,
        at,
        kind,
        code: String(spec.code ?? ''),
        reason: String(spec.reason ?? ''),
        from_role: String(spec.fromRole ?? ''),
        from_seat: typeof spec.fromSeat === 'string' && spec.fromSeat.length > 0 ? spec.fromSeat : null,
        /** ★ 提交时的任务状态（"在哪个窗口里被拒的"——事后一眼看得出）。 */
        state_at_submit: task.state,
        /** ★ **原始提交内容**（能查回原文）；超长时截断并标注 `payload_truncated_from`。 */
        payload,
        payload_truncated_from: truncated,
        /** ★ 查回方式（写给主对话看的一行）。 */
        recall: `pipeline_status { task_id: "${taskId}" } 的「被拒收的交付」一节，或 node_modules/dsh-pipeline/lib/store.js 的 task.rejected_deliveries[]（delivery_id=${deliveryId}）`,
      }
      task.rejected_deliveries.push(rec)
      const entry = await audit(task.id, String(spec.fromRole ?? 'unknown'), 'delivery:rejected', {
        delivery_id: deliveryId,
        kind,
        code: rec.code,
        reason: rec.reason,
        state: rec.state_at_submit,
        archived: true,
      })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, delivery_id: deliveryId, delivery: rec }
    },

    /**
     * 状态迁移的前置条件判据。
     * 单独抽出来是为了让工具层与守门层调用**同一份**判据，不会出现两套规则。
     */
    async checkPrecondition(task, name, input = {}) {
      switch (name) {
        case 'dev_to_test': {
          if (lastHandoff(task, 'dev_to_test') === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「开发中」进入「待测试」，必须先由编写角色产出 dev_to_test 交接物。`)
          }
          // ★ 全部席位到齐才允许推进（取舍见 README「编写分工」一节）
          const gate = checkAllSeatsSubmitted(task)
          if (gate.ok !== true) return gate
          break
        }
        case 'test_to_review': {
          const h = lastHandoff(task, 'test_to_review')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「测试中」进入「待审核」，必须先由测试角色产出 test_to_review 交接物。`)
          }
          const version = currentArtifactVersion(task)
          if (version !== null && h.artifact_version !== version) {
            return deny(
              'VERSION_MISMATCH',
              `测试报告针对的是制品 ${h.artifact_version}，当前有效制品是 ${version}。请让测试重新验证当前版本。`,
            )
          }
          break
        }
        case 'review_verdict_ok': {
          const h = lastHandoff(task, 'review_verdict')
          if (h === null || h.payload?.conclusion !== 'OK') {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「审核中」进入「已通过」，必须先由审核角色产出 conclusion=OK 的 review_verdict。`)
          }
          const version = currentArtifactVersion(task)
          if (version !== null && h.artifact_version !== version) {
            return deny('VERSION_MISMATCH', `审核结论针对的是制品 ${h.artifact_version}，当前有效制品是 ${version}。审核的是旧版本，不予通过。`)
          }
          break
        }
        case 'review_ok_exists': {
          const ok = effectiveReviewOk(task)
          if (ok === null) {
            const version = currentArtifactVersion(task)
            return deny(
              'NO_REVIEW_OK',
              `拒绝关单：任务 ${task.id} 不存在有效的审核 OK。\n` +
                `判据：需要一份 review_verdict，conclusion=OK，且 artifact_version 等于当前有效制品版本（${version ?? '尚无制品'}），且在最近一次打回之后。\n` +
                `主对话不能凭"看起来做完了"关单 —— 必须先走完 测试→审核，由审核角色发 OK。`,
            )
          }
          break
        }
        // ★ 本轮新增（澄清前置到人工确认）----------------------------------
        //
        //   `analyzing → ready_plan` 这条边**必须**有一个"用户确认过需求"的事实。
        //   判据落在既有的 `human_request` 生命周期记录上，不另建一套：
        //     ① 必须有一份需求分析结论（requirement_analysis 交接物）；
        //     ② 必须有需求分析发起的 `requirement_ambiguous` / `requirement_confirmation`
        //        人工请求，且它**已经被答复**（status='answered'）。
        //   ★ 为什么不看 blocking / 转告与否：转告只证明"话带到了"，答复才证明"人回了"。
        //     只查前者的闸是纸做的。
        case 'requirement_confirm_gate': {
          /**
           * ★★ T-20261011-56a37e：**枢纽任务不许从这条边直接跳到计划**。
           *
           * 判据：枢纽启用之后，`analyzing → ready_plan`（`requirement_confirmed`）
           * 会**跳过第①道主管确认与唤醒点 A** —— 用户要的顺序是
           * 「需求结论交主管 → 同意后交给架构ai先画架构图」，所以这条近路在枢纽任务上被关掉。
           * ★ 对未启用枢纽的任务**弃权**：既有链的这条边一个字节没变（既有反例全量照旧）。
           *
           * ⚠️ 只在**走这条边**时判（`input.event === 'requirement_confirmed'`）：
           *   第①道（`hub_station_need_agree`）会把本 guard 当作**子判据**再调一次
           *   （它也要用户确认过）—— 那时若再判一次 hub，第①道就永远过不去了。
           *   判据要认"是谁在问"，不能只看任务状态。
           */
          if (hubEnabled(task) && input?.event === 'requirement_confirmed') {
            return deny(
              'HUB_STATION_NEED_AGREE_REQUIRED',
              `拒绝：任务 ${task.id} 已启用**主管枢纽**，不能从「${STATE_LABEL[ST.ANALYZING]}」直接进计划。\n` +
                '★ 用户原话：「需求ai分析将结果提交**主管**→**同意后**交给架构ai**先画架构图**→架构图完成后给主管确认是否满足要求→主管确认后**才**交给计划ai」。\n' +
                '  也就是说这条路上有第①道（主管同意）与第②道（架构图确认）两站，中间是**架构图前置**。\n' +
                '下一步：主管调 pipeline_supervise action=agree_need（它会同时触发**唤醒点 A**，让架构位开工）。',
            )
          }
          const analysis = lastHandoff(task, 'requirement_analysis')
          if (analysis === null) {
            return deny(
              'MISSING_ANALYSIS',
              `任务 ${task.id} 要从「需求分析中」进入「待计划」，必须先有需求分析角色产出的 requirement_analysis 交接物。\n` +
                '★ 判断依据是**那两份书面结论**（任务卡 + 需求不清楚处清单），不是口头说过。' +
                '下一步：pipeline_orchestrate 出分析结论。',
            )
          }
          const confirmKinds = ['requirement_confirmation', 'requirement_ambiguous']
          const confirmed = (task.human_requests ?? []).filter(
            (r) => r.from_role === ROLE.ORCHESTRATOR && confirmKinds.includes(r.reason_kind) && r.status === 'answered',
          )
          if (confirmed.length === 0) {
            const pending = (task.human_requests ?? []).filter(
              (r) => r.from_role === ROLE.ORCHESTRATOR && confirmKinds.includes(r.reason_kind) && r.status !== 'answered',
            )
            return deny(
              'REQUIREMENT_NOT_CONFIRMED',
              `拒绝推进：需求还**没有经过用户人工确认**。\n` +
                `★ 规矩：需求分析第 1 轮分析完之后，必须把「不清楚的地方」提交主对话 → 主对话交**用户**确认 → 确认后才递交计划。\n` +
                (pending.length > 0
                  ? `当前状态：有一份确认请求还没答复（${pending.map((r) => r.request_id).join('、')}）。\n` +
                    '下一步：pipeline_human_relay 转告用户 → 拿到用户答复后 pipeline_human_reply（必须带答复来源与原话）。'
                  : '当前状态：**还没有**任何需求确认请求。\n' +
                    '下一步：让需求分析调 pipeline_human_request { reason_kind: "requirement_confirmation", blocking: true, ... }，' +
                    '把 unclear_points 逐条问出来。\n' +
                    '（"没有不清楚的地方"也是一个结论，同样要用户点头 —— 模型说"我懂了"不等于用户说"你懂了"。）'),
            )
          }
          break
        }

        // ★ 本轮新增（计划自检通过才能分配）--------------------------------
        //
        //   `planning → ready_dev` 必须有**最近一份计划且自检通过**。
        //   与 setRoster 里那道闸是**同一份判据**（那里判一次是为了给早期拒绝的文案，
        //   这里判一次是为了状态机层面也拦得住）。
        case 'plan_ready': {
          const plan = lastHandoff(task, 'plan')
          if (plan === null) {
            return deny(
              'MISSING_PLAN',
              `任务 ${task.id} 要从「计划中」进入「待开发」，必须先有计划 AI 产出的 plan 交接物（含自检结果）。\n` +
                '★ 没有计划就没有"这活怎么切、给谁"的答案，角色清单也就无从谈起。',
            )
          }
          const verdict = plan.payload?.self_check?.verdict
          if (verdict !== 'ok') {
            return deny(
              'PLAN_SELF_CHECK_NOT_OK',
              `拒绝推进：最近一份计划（${plan.handoff_id}）的自检结果是 **${verdict ?? '(缺失)'}**，不是 ok。\n` +
                '★ 自检发现缺失时**不许分配 AI** —— 先把缺口问清楚（退回需求分析：pipeline_clarify_request）。\n' +
                (Array.isArray(plan.payload?.self_check?.gaps) && plan.payload.self_check.gaps.length > 0
                  ? `缺的是：\n${plan.payload.self_check.gaps.map((g) => `  · ${g}`).join('\n')}`
                  : ''),
            )
          }
          break
        }

        // ★ 本轮新增（计划缺失回流）----------------------------------------
        //
        //   `planning → awaiting_clarification` 的判据：最近一份计划自检 verdict=gaps
        //   且带着可问的问题。它与第一级澄清梯**共用同一批记录**：
        //   submitHandoff 在收到 gaps 的计划时已经建好 clarification 记录（见下面 ④b3），
        //   所以需求分析照旧用 pipeline_clarify_reply 裁定、答不了照旧升级给用户。
        case 'plan_gap_gate': {
          const plan = lastHandoff(task, 'plan')
          if (plan === null) {
            return deny('MISSING_PLAN', `任务 ${task.id} 要回流到需求分析，必须先有 plan 交接物（自检结果在里面）。`)
          }
          const sc = plan.payload?.self_check
          if (sc?.verdict !== 'gaps') {
            return deny(
              'NOT_A_PLAN_GAP',
              `最近一份计划（${plan.handoff_id}）的自检结果是 ${sc?.verdict ?? '(缺失)'}，不是 gaps —— 没有缺口就不该回流。`,
            )
          }
          const gaps = Array.isArray(sc.gaps) ? sc.gaps : []
          if (gaps.length === 0) {
            return deny('EMPTY_PLAN_GAPS', '计划自检说"有缺失"却没列出缺什么 —— 回流必须带上具体缺口，否则需求分析无从下手。')
          }
          const entry = (task.clarification_requests ?? []).find((r) => r.handoff_id === plan.handoff_id || r.from_role === ROLE.PLANNER)
          if (entry === undefined) {
            return deny(
              'NO_CLARIFICATION_FOR_GAP',
              `计划缺失没有对应的澄清请求记录 —— 回流链是断的（插件内部错误：submitHandoff 本应建好它）。`,
            )
          }
          break
        }

        // ★★ 主管枢纽（T-20261011-56a37e）-------------------------------------
        //
        //   这七条装在 **同一张 TRANSITIONS 表** 与 **同一个守卫开关** 上 ——
        //   没有第二套判定机制（越界清单第 4 条 / 边界条件第 2 条）。
        //
        //   ① 发起：主管的具名动作。`by: ['supervisor']` 是**第一道**（applyTransition
        //      就把它拒了，main 代发连这里都到不了）；本处是**第二道**：
        //      写枢纽账本 + 登记两席待机 + 真实 actor 留痕。
        //      ★ 刻意**不**复用 `pipeline_dispatch`（main 的工具）：那会把发起者记成 main
        //        （"谁发起"不可追溯），并且主管会连带拿到 main 的整片派活权 —— 越权放行。
        case 'hub_initiate': {
          /**
           * ★★ P0-1：**"已经发起过"的判据从 `enabled` 收窄到 `initiated_by`**。
           *
           * 为什么必须改：新入口（`handoff_to_supervisor`）会先把本单**递给**主管
           *   （登记 `hub.entry`），此时枢纽**还没发起** —— 真正拉起三席的是主管的
           *   `action=initiate`。若仍按"`enabled` 已为真 ⇒ 拒"，主管就再也发起不了，
           *   `hub.entry` 会把主管自己挡在门外 —— 那正是本单要修的"入口悬空"的翻版。
           *
           * ★ 判据强度**没有降**：`initiated_by` 有值 = 主管**真的发起过**（那一步
           *   既有唯一写点 `applyHubSideEffects('supervisor_initiate')` 落下），
           *   重复发起照旧被拒（"发起是一次性动作"这条一个字没动）。
           */
          if (hubEnabled(task) && typeof hubOf(task)?.initiated_by === 'string' && hubOf(task).initiated_by.length > 0) {
            return deny(
              'HUB_ALREADY_INITIATED',
              `拒绝：任务 ${task.id} 的**主管枢纽已经发起过了**（${hubOf(task)?.initiated_at ?? ''}，发起人 ${hubOf(task)?.initiated_by ?? ''}）。\n` +
                '★ 发起是**一次性**动作：重复发起会覆盖待机名册，把"谁在什么时刻被登记待机"这条留痕抹掉。',
            )
          }
          const roster = Array.isArray(task.roster?.conversations) ? task.roster.conversations : []
          const declared = roster.includes(ROLE.SUPERVISOR)
          return {
            ok: true,
            // ★ 只在**名单四槽面**真的登记了 supervisor 时才算"在册"；没登记也允许发起
            //   （否则用例夹具没法自举），但如实记进账本，供审核与边界导出读。
            hub: {
              supervisor_declared: declared,
              note: declared
                ? '名单里登记了 supervisor 席位。'
                : '名单里**没有** supervisor 席位（本任务是自举/夹具形态）：发起仍留痕，但"主管在册"这条不成立。',
            },
          }
        }

        //   ①a ★★ P0-1 **入口判据**：主对话把任务递给主管（用户新口径第 1 跳）。
        //
        //   为什么单开一条边、而不是把 main 加进 `supervisor_initiate` 的 by 名单：
        //     既有判据逐字写着「**主管的具名动作不是 main 的工具**」
        //     （`gate-states-check` 的「A 发起面」把它钉住了）—— 给那条边加 main
        //     会**改掉既有判据的期望值**，那是本单硬约束禁止的动作。
        //     所以主对话走**自己**的边界事件：它只登记"谁把单递给了主管"，不代替主管发起。
        //
        //   ★ **凭什么放行**（五条同时成立，缺一即拒）—— 回答"主对话发起时依据什么"：
        //     ① 调用方必须是 **main**（`by: ['main']` 是状态机那一道；工具面 `pipeline_transition`
        //        本来就只给 main / human，human 在这里被这条 by 名单挡住）；
        //     ② 状态必须是 **`pending`（待分配）** —— 也就是**流程最初那一刻**；
        //     ③ 名单**还没产出**（`roster === null`）—— 有清单就说明需求分析与用户确认都过了，
        //        那已经不是"最初那一刻"；
        //     ④ **一份交接物都还没有**（`handoffs.length === 0`）—— 活儿还没开始；
        //     ⑤ 本单**还没递过**（`hub.entry` 不存在）—— 递单是一次性动作。
        //   ★ **枢纽必须激活在哪一层**：激活点在**最外层** —— 只能落在
        //     `pending` 这一层（②③④合起来保证"零工作量的新单"）。
        //     任何状态推进、任何交接物、任何角色清单都会**永久关闭**这个入口；
        //     换句话：**中途的单递不出去**（反例见 `tests/p01-handoff-entry-check.mjs`）。
        //   ★ **没有顺带放宽任何别的角色**：本事件只写 `hub.entry`，不改状态、不发令牌、
        //     不放开任何角色的可派范围 —— 派活那一段的引导步白名单另有一处改动，
        //     且那处**只**多出 supervisor 一席（其余角色一个都没动）。
        case 'main_handoff_to_supervisor': {
          const st = task.state
          if (st !== ST.PENDING) {
            return deny(
              'HUB_HANDOFF_NOT_FIRST_MOMENT',
              `拒绝：任务 ${task.id} 已经是「${STATE_LABEL[st] ?? st}」，**不是流程最初那一刻** —— 递单入口只对「${STATE_LABEL[ST.PENDING]}(${ST.PENDING})」上的新单开放。\n` +
                '★ 判据不是"看着像新单"，而是三条硬事实：状态仍是待分配、尚无角色清单、尚无任何交接物。\n' +
                '下一步：中途的单请走既有的转办路径（主管枢纽已经发起的话，主管直接调 pipeline_supervise 推进）。',
            )
          }
          if (task.roster !== null && task.roster !== undefined) {
            return deny(
              'HUB_HANDOFF_AFTER_ROSTER',
              `拒绝：任务 ${task.id} **已经有角色清单**了 —— 那说明需求分析与用户确认都走完了，不再是"最初那一刻"。\n` +
                '★ 递单是把**还没开工的新单**交给主管，不是把已经在跑的单改道。',
            )
          }
          const hs = Array.isArray(task.handoffs) ? task.handoffs : []
          if (hs.length > 0) {
            return deny(
              'HUB_HANDOFF_AFTER_WORK',
              `拒绝：任务 ${task.id} 已经有 ${hs.length} 份交接物了 —— 活儿已经开过工，递单入口只对新单开放。\n` +
                '★ 允许中途递单会让"谁发起"变得可追溯不了：已经产出过的产物归属不到任何一个发起人。',
            )
          }
          if (hubOf(task)?.entry !== null && hubOf(task)?.entry !== undefined) {
            return deny(
              'HUB_HANDOFF_ALREADY_DONE',
              `拒绝：任务 ${task.id} **已经递给主管过了**（${hubOf(task)?.entry?.at ?? ''}，递交人 ${hubOf(task)?.entry?.by ?? ''}）。\n` +
                '★ 递单是**一次性**动作：重复递交会覆盖"谁在什么时刻把单交给主管"这条留痕。\n' +
                '下一步：让主管调 pipeline_supervise action=initiate 拉起三席。',
            )
          }
          return { ok: true, handoff_to_supervisor: { by: input?.actorRole ?? '', at: nowIso(now()) } }
        }

        //   ①b **名单里登记了主管席位 ⇒ 必须由主管发起**（不许 main 代发绕过枢纽）。
        //
        //   判据用的是**名单四槽面**（`task.roster.conversations`）—— 那是 B 单已落地的
        //   "谁在册"的唯一事实来源，不新造标记。名单里没有 supervisor 时弃权
        //   （L0~L5 的既有档位都不含它 ⇒ 既有链与既有反例一个字节不变）。
        case 'hub_initiate_required': {
          const roster = Array.isArray(task.roster?.conversations) ? task.roster.conversations : []
          /**
           * ★★ P0-1：**两个"必须由主管发起"的触发面**（同一个判据体，不另起一套）：
           *   · 名单四槽面里登记了 supervisor 席位（既有那条，一个字节没动）；
           *   · **主对话已经把本单递给主管**（`hub.entry`）—— 递了单就更不该由主对话自己
           *     把需求位派出去：那会让"递单"这个动作变成一句空话。
           * ★ 未登记、也没递过单 ⇒ 照旧弃权（L0~L5 的既有档位都不含主管席位，
           *   既有链与既有反例一个字节不变）。
           */
          const rosterHasSup = roster.includes(ROLE.SUPERVISOR)
          const handedOver = hubOf(task)?.entry !== null && hubOf(task)?.entry !== undefined
          if (!rosterHasSup && !handedOver) return { ok: true }
          if (hubEnabled(task)) return { ok: true }
          return deny(
            'HUB_INITIATE_REQUIRED',
            `拒绝：任务 ${task.id} ${rosterHasSup ? '的名单里**登记了主管席位**' : '**已经由主对话递给主管**'}，所以需求位必须由**主管发起**。\n` +
              `当前动作：main 的 dispatch_orchestrator（起点 ${ST.PENDING}）\n` +
              '★ 用户原话：「**主对话agent递给主管agent**，主管**发起**（需求分析/计划/架构ai）对话」——\n' +
              '  主对话负责**递单**与转发，发起是主管的活。\n' +
              '  这条不是"少一步也能走"：主对话代发会让`谁发起`不可追溯，' +
              '并且新拓扑的两席待机（计划位 / 架构位）根本不会被登记 —— 架构图前置就无从谈起。\n' +
              (handedOver
                ? '下一步：先把主管席位派出去（pipeline_dispatch role=supervisor，递单之后引导步已只放它这一席），再由主管调 pipeline_supervise action=initiate。'
                : '下一步：主管调 pipeline_supervise action=initiate。'),
          )
        }

        //   ①c ★★ P0-1 **②b 确认点**：架构图 → **需求位确认**（用户新口径第 7~8 跳前半）。
        //
        //   与既有站点闸是**同一个判据体**（`hubStationGate`）—— 只是站点名换了。
        //   它判的是：需求位交过一份 `station_confirm{station:'arch_need_confirm', decision:'ok'}`，
        //   且那份记录**绑的是当前这份架构图**（换图即作废）。缺 ⇒ 边过不去。
        case 'hub_station_arch_need_confirm': {
          const gate = hubStationGate(task, HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, confirms: gate.confirms, target: gate.target }
        }

        //   ①d ★★ P0-1 **②c 确认点**：架构图 → **主管二次确认**（用户新口径第 8 跳后半）。
        //
        //   ★ 顺序是判据的一部分：本站**只能**由状态机从 ②b 之后的 `arch_reconfirm` 进来
        //     （`from` 写死在表上），所以"需求位还没确认，主管就先二次确认"没有合法路径。
        //   ★ 唤醒点 B 挂在这一跳上：**无问题后**才把架构图交给计划位。
        case 'hub_station_arch_reconfirm': {
          const gate = hubStationGate(task, HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, confirms: gate.confirms, target: gate.target }
        }

        //   ② 需求结论交主管：必须已经有结论（否则"交"的是空）。
        //
        //   ★ 这里**刻意不查** `requirement_confirm_gate`（用户确认）：用户确认发生在
        //     结论交上来**之后**（需求分析发起 requirement_confirmation → 主对话转告 →
        //     用户答复）。把它挪到这里会变成"先让用户确认一份还没交上来的结论"。
        //     用户的确认判据落在**下一站**（第①道）：见 `hub_station_need_agree`。
        case 'hub_analysis_ready': {
          if (!hubEnabled(task)) {
            return deny(
              'HUB_NOT_ENABLED',
              `拒绝：任务 ${task.id} 没有启用主管枢纽，\`need_to_supervisor\` 不属于它当前走的链` +
                '（既有链是 analyzing → requirement_confirmed → ready_plan）。',
            )
          }
          const analysis = lastHandoff(task, 'requirement_analysis')
          if (analysis === null) {
            return deny(
              'MISSING_ANALYSIS',
              `拒绝：任务 ${task.id} 要把结论交主管，但**还没有** requirement_analysis 交接物。\n` +
                '★ 第①道确认要确认的是**那份书面结论**（任务卡 + 需求不清楚处清单），不是口头说过。\n' +
                '下一步：pipeline_orchestrate 出分析结论。',
            )
          }
          return { ok: true }
        }

        //   ③ 第①道：主管同意需求结论（＋**唤醒点 A**）。
        //
        //   ★ 两道**都要**：①主管的站点确认记录；②**既有的用户确认闸门**。
        //     用户原话里这一站是"需求ai分析将结果提交主管→同意后交给架构ai"，
        //     而既有链里"用户确认过需求"这条不变量一个字没动 —— 枢纽是**加**一道，不是替一道。
        case 'hub_station_need_agree': {
          const userGate = await this.checkPrecondition(task, 'requirement_confirm_gate', input)
          if (userGate.ok !== true) return userGate
          const gate = hubStationGate(task, HUB_STATIONS.NEED_AGREE)
          if (gate.ok !== true) return gate
          return { ok: true, wake: { wake_point: HUB_WAKE_POINTS.NEED_AGREE, roles: HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.NEED_AGREE).map((s) => s.role) } }
        }

        //   ④ 架构图产出：必须是当前枢纽任务的**计划位开工之前**那一站。
        case 'hub_diagram_ready': {
          const diagram = lastHandoff(task, 'architecture_diagram')
          if (diagram === null) {
            return deny('MISSING_HANDOFF', `拒绝：任务 ${task.id} 要落到「架构图待主管确认」，但还没有 architecture_diagram 交接物。`)
          }
          if (diagram.payload?.degraded === true && typeof diagram.payload?.degraded_reason !== 'string') {
            return deny('BAD_HANDOFF', `架构图（${diagram.handoff_id}）声明 degraded=true 却没给 degraded_reason —— 降级必须写明原因。`)
          }
          return { ok: true }
        }

        //   ⑤ 第②道：主管确认架构图满足要求（＋**唤醒点 B**）。
        case 'hub_station_diagram_confirm': {
          const gate = hubStationGate(task, HUB_STATIONS.DIAGRAM_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, wake: { wake_point: HUB_WAKE_POINTS.DIAGRAM_CONFIRM, roles: HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.DIAGRAM_CONFIRM).map((s) => s.role) } }
        }

        //   ⑥ 架构图不满足 ⇒ 重画（**限 1 次**；再不行升人工）。
        case 'hub_diagram_rework_budget': {
          const used = Number.isInteger(task.hub?.diagram_redraws) ? task.hub.diagram_redraws : 0
          if (used >= HUB_DIAGRAM_REDRAW_BUDGET) {
            return deny(
              'HUB_DIAGRAM_REDRAW_EXHAUSTED',
              `拒绝：架构图重画**预算已用尽**（已用 ${used} / 上限 ${HUB_DIAGRAM_REDRAW_BUDGET}）。\n` +
                '★ 用户口径④：「主管认为架构图不满足要求 ⇒ 让架构位重画（**限 1 次**）；再不行**升给用户**定」。\n' +
                '  无限重画会把"主管确认"退化成一道空转的闸。\n' +
                '下一步（唯一）：主管调 pipeline_supervise action=escalate_user 走**既有的**两级梯\n' +
                '  （human_request → 主对话转告 → 用户答复），把这件事交给人定。',
            )
          }
          const diagram = lastHandoff(task, 'architecture_diagram')
          if (diagram === null) {
            return deny('MISSING_HANDOFF', '拒绝：还没有架构图可判"不满足" —— 先让架构位出图。')
          }
          return { ok: true, redraws: used + 1 }
        }

        //   ⑥b ★★ **站点「否掉」的预算判据**（T-20261011-56a37e 补齐）。
        //
        //   与 ② 道那条（`hub_diagram_rework_budget`）是**同一套口径、同一个位置**：
        //   同样是"退回重做限 1 次、用尽升人工"。两种触发面共用一个判据体：
        //     · 主管交**否掉记录**时（`station_confirm{decision:'ng'}`）—— `input.station`；
        //     · 状态机上那条回边放行时 —— `input.event`（事件名反查站点）。
        //   这样"提交"与"推进"两步判的是**同一件事**，不会出现"记录交得上、边却过不去"
        //   或者反过来的半截状态（与既有站点确认"先交记录、再放行"的形状一致）。
        case 'hub_station_reject_budget': {
          const station =
            HUB_REJECT_EVENT_STATIONS[String(input?.event ?? '')] ??
            (typeof input?.station === 'string' && input.station.length > 0 ? input.station : '')
          const r = hubRejectBudget(task, station)
          if (r.ok !== true) return r
          return { ok: true, station: r.station, used: r.used }
        }

        //   ⑥c ★★ **站点「否掉」的前置条件**（状态机那条回边挂的守卫）。
        //
        //   与 `hubStationGate`（确认侧）**逐项对称**，只是方向相反：
        //     · 确认侧要求"确认方**齐备**的 `station_confirm{ok}` 记录"⇒ 才放行到下一站；
        //     · 否掉侧要求"一份**绑当前目标**的 `station_confirm{ng}` 记录"⇒ 才放行退回上一站。
        //   ★ 为什么否掉也要求先有记录（而不是像 ② 道那样只看一个计数）：
        //     本条的硬要求是「否掉**必须带原因**：失败要带证据、不许静默」。
        //     把这条落在**既有校验器**上（`station_confirm` 的 `reason` 与 `basis_refs`
        //     都是 required、`basis_digest` 还要过"脱敏证据正文"扫描）比在守卫里
        //     判一句 `note` 是否为空要硬得多 —— 后者拦不住一次不带原因的 `pipeline_transition`。
        case 'hub_station_reject': {
          const budget = await this.checkPrecondition(task, 'hub_station_reject_budget', input)
          if (budget.ok !== true) return budget
          const station = budget.station
          const rec = hubLatestValidReject(task, station, ROLE.SUPERVISOR)
          if (rec === null) {
            const anyRec = hubLatestValidReject(task, station)
            if (anyRec !== null) {
              return deny(
                'HUB_STATION_REJECT_NOT_SUPERVISOR',
                `拒绝：这一站当前那条否掉记录是「${roleLabel(anyRec.from_role)}」交的（${anyRec.handoff_id}），而**回边只能由主管走**。\n` +
                  `★ 第${stationLabel(station)}上，需求位的那一份是**确认**（\`decision=ok\`）或**不同意**（\`decision=ng\`）的书面表态；\n` +
                  '  把它直接变成"退回重做"会让**需求位**拿到一条推进/退回状态的能力 —— 那是越权放行，本条明令禁止。\n' +
                  '  需求位说"不同意"时，正确形状是：它的 ng 记录让**双确认不齐备**（闸门保持关闭），' +
                  '由**主管**决定要不要走退回。\n' +
                  '下一步：主管调 pipeline_supervise action=' +
                  (station === HUB_STATIONS.NEED_AGREE ? 'reject_need' : station === HUB_STATIONS.TEST_CONFIRM ? 'reject_test' : 'reject_review') +
                  '（主管那一份否掉记录由它自己交）。',
              )
            }
            const target = hubStationTarget(task, station)
            return deny(
              'HUB_STATION_REJECT_NO_RECORD',
              `拒绝：第${stationLabel(station)}要**否掉**，必须先有一份**带原因与证据**的否掉记录，` +
                `而现在没有（或它绑的不是当前目标）。\n` +
                `该站当前的目标：${target ?? '(还没有可确认的对象)'}\n` +
                `已有的否掉记录：${hubRejectRecords(task, station).length} 条` +
                `${hubRejectRecords(task, station).length > 0 ? '（但都不绑当前目标 —— 否掉也要说清"否的是哪一份"）' : ''}\n` +
                '★ 用户裁定：「失败要带证据、不许静默」—— 所以否掉不是一个动作，是**一份记录 + 一条回边**。\n' +
                '  记录的形状复用**既有**的站点确认交接物（`station_confirm`，`decision=ng`）：\n' +
                '  它的 `reason` 与 `basis_refs`（证据标识 ≥ 1 条）都是**既有校验器**强制要求的。\n' +
                '下一步：主管调 pipeline_supervise action=' +
                (station === HUB_STATIONS.NEED_AGREE ? 'reject_need' : station === HUB_STATIONS.TEST_CONFIRM ? 'reject_test' : 'reject_review') +
                `（它先落否掉记录、再走回边；用 pipeline_handoff kind=station_confirm 手交也可以）。`,
            )
          }
          return { ok: true, station, reject_handoff: rec.handoff_id, used: budget.used }
        }

        //   ⑦ 计划位派活（唤醒点 B 之后的**唯一**入口）。
        case 'hub_plan_woken': {
          if (!hubEnabled(task)) {
            // 未启用枢纽的任务走既有 `ready_plan → dispatch_planner`（那条边一个字没动）。
            return { ok: true }
          }
          const e = hubStandbyOf(task, ROLE.PLANNER)
          if (e === null || e.status !== 'woken') {
            return deny(
              'HUB_PLAN_NOT_WOKEN',
              `拒绝：任务 ${task.id} 的计划位**还没被唤醒**，这条边过不去。\n` +
                `计划位的登记：${e === null ? '（没登记）' : `${e.status}（唤醒点 ${e.wake_point}）`}\n` +
                '★ 用户原话：「计划……ai**待机**……主管确认后交给计划ai」。\n' +
                '  计划位的唤醒点是**「主管确认架构图满足要求」** —— 在它之前，计划位产不出任何计划产物。\n' +
                '下一步：主管在架构图确认后调 pipeline_supervise action=confirm_diagram（那一步会一并唤醒计划位）。',
            )
          }
          return { ok: true }
        }

        //   ⑧ 第③道：测试通过 → 主管+需求位**双确认** ⇒ 才进审核。
        //      对未启用枢纽的任务**弃权**（既有链的 `dispatch_reviewer` 强度一个字节没减）。
        case 'dispatch_reviewer_gate': {
          if (!hubEnabled(task)) return { ok: true }
          const gate = hubStationGate(task, HUB_STATIONS.TEST_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true }
        }

        //   ⑨ 第④道：审核通过 → 主管+需求位**双确认** ⇒ 才进主对话关单。
        case 'hub_station_review_confirm': {
          if (!hubEnabled(task)) return { ok: true }
          const gate = hubStationGate(task, HUB_STATIONS.REVIEW_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true }
        }

        // ★ 两级升级梯的两个前置条件
        case 'clarification_blocking': {
          const h = lastHandoff(task, 'clarification_request')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要进入「等待需求分析答复」，必须先有一份 clarification_request 交接物。`)
          }
          if (h.payload?.blocking !== true) {
            return deny('NOT_BLOCKING', `最近一份 clarification_request（${h.handoff_id}）声明的是 blocking=false，不该把任务推进到「等待需求分析答复」。`)
          }
          break
        }
        case 'clarification_reply_ok': {
          const e = this.findClarification(task, input.requestId)
          if (e === null) {
            return deny('NO_CLARIFICATION', `任务 ${task.id} 里没有任何待答复的 clarification_request —— 不能凭空从「等待需求分析答复」恢复。`)
          }
          if (e.status !== 'answered') {
            return deny(
              'MISSING_CLARIFICATION_REPLY',
              `请求 ${e.request_id} 还没有需求分析的裁定（status=${e.status}）。\n` +
                '★ 需求分析必须先给出裁定（answered 带结论 / cannot_answer 带升级理由），状态才会恢复。',
            )
          }
          break
        }

        // ★ 关单的**组合闸**：审核 OK（必过） + 安全确认（必过） + 架构图（清单里有 diagrammer 时）。
        //   做成组合而不是几条并列 guard，是因为转移表里一个事件只能挂一个 guard；
        //   这里把判据按顺序跑一遍，返回第一条不通过的。
        case 'close_gates': {
          // 顺序是有讲究的：**安全否决排在最前** —— 它优先于审核 OK，那也该最先判。
          // （否则一份"审核说没问题"的结论会先撞上别的闸，反而看不到真正的原因。）
          for (const g of ['review_ok_exists', 'security_not_blocked', 'security_attested', 'diagram_delivered', 'role_products_delivered',
            // ★ T-20261011-56a37e：第④道（审核通过 → 主管+需求位**双确认**）。
            //   排在最后是刻意的：先让既有的四道闸把话说清楚，再报"还缺谁的确认" ——
            //   否则一份还没审完的单会先撞上"确认不齐"，看到的理由就错了。
            //   对未启用枢纽的任务它是**弃权**的（既有链强度一个字节没减）。
            'hub_station_review_confirm']) {
            const r = await this.checkPrecondition(task, g, input)
            if (r.ok !== true) return r
          }
          break
        }

        // ★「审核必须确认网络安全/本地泄密是否发生」—— 判据落在**有效审核结论**的 security 段上。
        //
        //   为什么挂在关单而不是挂在 handoff 提交：handoff 层的字段校验只管"形状对不对"，
        //   这里管的是"**当前有效**的那份结论里有没有确认过"。两处都要，因为
        //   旧版本的 review_verdict（改造前提交的、没有 security 段）也可能成为有效结论 ——
        //   那种情况在提交层拦不住（它早就落盘了），必须在关单层拦。
        case 'security_attested': {
          const ok = effectiveReviewOk(task)
          if (ok === null) break // 没有有效 OK 的话，review_ok_exists 已经拒过了
          const sec = ok.payload?.security
          if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) {
            return deny(
              'NO_SECURITY_ATTESTATION',
              `拒绝关单：当前有效的审核结论（${ok.handoff_id}）里**没有安全确认段**。\n` +
                '★ 规则：审核**必须**确认"网络安全 / 本地泄密是否发生" —— 没确认就不算完成审核。\n' +
                '下一步：调 pipeline_security_check 扫一遍本任务工作区，把结论与 checks_ref 填进 review_verdict.security。',
            )
          }
          const att = sec.attestation
          if (att === 'unknown') {
            return deny(
              'SECURITY_ATTESTATION_UNKNOWN',
              `拒绝关单：安全确认的结论是 **unknown**（不知道发生过没有）。\n` +
                '★ "没查"和"查了没问题"是两件完全不同的事，不能都算过。\n' +
                '两条出路：① 查清它（pipeline_security_check + 人工看一眼），给出 clean / issues；' +
                '② 确实查不了（缺环境、缺权限）→ pipeline_rework 打回，或 pipeline_human_request 升级给用户。',
            )
          }
          if (att !== 'clean' && att !== 'issues') {
            return deny('BAD_SECURITY_ATTESTATION', `拒绝关单：security.attestation=「${att ?? '(缺失)'}」非法，必须是 clean / issues。`)
          }

          // ★ 依据必须**真实存在**。
          //   "我扫过了，报告在 reports/security-scan-xxx.json" —— 那就得有那个文件。
          //   只写路径不落盘，等于没有依据；这条把"依据"从一句声明变成一个可核对的事实。
          {
            const { existsSync } = await import('node:fs')
            const refs = [
              ...toStringArray(sec.checks_ref),
              ...toStringArray(sec.local_leak?.checks_ref),
              ...toStringArray(sec.network?.checks_ref),
            ]
              .map((r) => String(r).split('#')[0].trim())
              .filter((r) => r.length > 0 && /[./\\]/.test(r))
            const found = refs.filter((r) => existsSync(isAbsolute(r) ? r : resolve(task.project_root, r)))
            if (refs.length > 0 && found.length === 0) {
              return deny(
                'SECURITY_CHECKS_REF_MISSING',
                '拒绝关单：安全确认里给的 checks_ref 指向的检查产物**一个都不存在**。\n' +
                  refs.slice(0, 5).map((r) => `  · ${r}`).join('\n') +
                  '\n★ "我扫过了"必须留下可核对的东西：调 pipeline_security_check 会把扫描结果落盘到本任务的 reports/，' +
                  '把它返回的 checks_ref 原样填进来即可。\n' +
                  '（只写路径不落盘，等于没有依据。）',
              )
            }
          }
          // 未解决的 finding 一律不许关单
          const open = (Array.isArray(sec.findings) ? sec.findings : []).filter((f) => f?.resolved !== true)
          if (open.length > 0) {
            const lines = open.slice(0, 5).map((f, i) => `  ${i + 1}) ${f.location ?? '(无位置)'} — ${f.type ?? '(无类型)'}：${f.why ?? '(无说明)'}`)
            return deny(
              'SECURITY_FINDINGS_OPEN',
              `拒绝关单：安全确认里有 ${open.length} 条**未解决**的问题。\n` +
                lines.join('\n') +
                (open.length > 5 ? `\n  …还有 ${open.length - 5} 条` : '') +
                '\n★ 处理路径三选一：\n' +
                '  ① pipeline_rework 打回编写（改掉它）；\n' +
                '  ② 让 security 角色复核并给出可接受的整改结论（L3+）；\n' +
                '  ③ pipeline_human_request 升级给用户拍板（接受风险也要有人签字）。\n' +
                '（把 findings 标成 resolved 之前，请先说清"为什么它不再算问题"。）',
            )
          }
          break
        }

        // ★ 安全角色的**否决权**：它报 blocked=true 时，关单必须被拦（哪怕审核给了 OK）。
        //   这一条与上一条互补：上一条看审核自己怎么说，这一条看**独立安全审计**怎么说。
        case 'security_not_blocked': {
          const veto = lastHandoff(task, 'security_review')
          if (veto !== null && veto.payload?.blocked === true) {
            const fs = toStringArray(veto.payload?.findings)
            return deny(
              'SECURITY_VETO',
              `拒绝关单：安全角色（security）出了一份 security_review，其 blocked=true —— 存在**阻断项**。\n` +
                `最高严重级别：${veto.payload?.severity ?? '(未给)'}\n` +
                (fs.length > 0 ? `发现项：\n  · ${fs.slice(0, 5).join('\n  · ')}` : '') +
                '\n★ 安全否决**优先于**审核 OK：安全角色是独立的一票，审核不能替它翻案。\n' +
                '下一步：pipeline_rework 打回编写整改 → 让安全角色复核出新的一份 security_review（blocked=false）→ 再谈关单。' +
                '\n（如果确实要带风险上线，那必须走 pipeline_human_request 让用户签字，不能在这里悄悄放行。）',
            )
          }
          // L3+ 必须真的有过独立安全审计
          const tier = task.roster?.tier ?? ''
          const needSecurity = ['L3', 'L4', 'L5'].includes(tier)
          if (needSecurity && veto === null) {
            return deny(
              'MISSING_SECURITY_REVIEW',
              `拒绝关单：本任务是 ${tier} 档（安全敏感），角色清单里有 security，但没有任何 security_review。\n` +
                '★ L3+ 的安全面要求**两条**：① 安全角色出独立结论（security_review）；② 审核复核并给安全确认（review_verdict.security）。\n' +
                '两者都要有 —— 缺了独立那一票，"审核自己说没问题"就不够了。',
            )
          }
          break
        }

        // ★ 角色清单里给了 diagrammer 时，架构图就是**交付物之一** —— 没有它不能关单。
        //   （没给 diagrammer 的任务不受影响，这条判据直接放行。）
        case 'diagram_delivered': {
          const hasDiagrammer = Array.isArray(task.roster?.execution_roles) && task.roster.execution_roles.includes(ROLE.DIAGRAMMER)
          if (!hasDiagrammer) break
          const dg = lastHandoff(task, 'architecture_diagram')
          if (dg === null) {
            return deny(
              'MISSING_DIAGRAM',
              `拒绝关单：本任务的角色清单里有「架构图」角色（${ROLE.DIAGRAMMER}），但没有任何 architecture_diagram 交接物。\n` +
                '★ 它在本任务里是**交付物之一**，不是可选项 —— 清单里派了它，就得交。\n' +
                '要么让架构图角色交图（走 diagram_deliver 拿收据，或降级并标 degraded=true），' +
                '要么让编排复核后把该角色从清单里去掉（roster_request → roster_review）。',
            )
          }
          const version = currentArtifactVersion(task)
          if (version !== null && dg.payload?.based_on_artifact_version !== version) {
            return deny(
              'DIAGRAM_STALE',
              `拒绝关单：架构图针对的是制品 ${dg.payload?.based_on_artifact_version}，当前有效制品是 ${version}。\n` +
                '图是旧版本的 —— 让架构图角色基于当前版本重出一张。',
            )
          }
          break
        }
        /**
         * ★「在册的角色必须交出它那一份」—— 把三句**自然语言约束**变成判据。
         *
         * 用户原话：「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」。
         * 这三条以前只活在角色卡（`roles.js` 的 summary）里：
         *   · `release`  —— "关单前必须给出可执行的发布与回滚计划"
         *   · `docs`     —— "产出用户文档 / 变更日志 / 使用说明"
         *   · `performance` —— "给出基准、压测结果与性能回归结论"
         * 写在 summary 里等于**没有执法**：角色不交，也没人拦得住。
         * 现在与 `diagram_delivered` **完全同形**：清单里派了它，就得交它那一份。
         *
         * ⚠️ 只在"该角色确实在册"时生效（L4/L5 才会有 release，L5 才会有 docs/performance），
         *    所以 L0~L3 的任务一点都不受影响。
         */
        case 'role_products_delivered': {
          const inRoster = (r) => Array.isArray(task.roster?.execution_roles) && task.roster.execution_roles.includes(r)
          const need = [
            { role: ROLE.RELEASE, kind: 'release_plan', zh: '发布与回滚计划' },
            { role: ROLE.DOCS, kind: 'docs_note', zh: '文档 / 变更日志' },
            { role: ROLE.PERFORMANCE, kind: 'perf_report', zh: '性能基准与回归结论' },
          ]
          const missing = need.filter((x) => inRoster(x.role) && lastHandoff(task, x.kind) === null)
          if (missing.length > 0) {
            return deny(
              'MISSING_ROLE_PRODUCT',
              `拒绝关单：角色清单里有 ${missing.map((x) => `「${roleLabel(x.role)}」`).join('、')}，` +
                `但没有对应的交接物。\n` +
                missing.map((x) => `  · ${roleLabel(x.role)} → 该交 ${x.kind}（${x.zh}）`).join('\n') +
                '\n★ 这条以前只写在角色卡里（"关单前必须给出……"）—— 写在 summary 里等于没人执法。\n' +
                '  现在它与"架构图必须交"完全同形：**清单里派了它，就得交它那一份**。\n' +
                '两条出路：① 让该角色把产物交上来；② 让计划 AI 复核后把它从清单里去掉（roster_request → roster_review）。',
            )
          }
          break
        }

        case 'rework_budget': {
          const leg = input.leg ?? (input.event === 'review_ng_test' ? 'test' : 'dev')
          const used = task.rework[leg] ?? 0
          const budget = task.roster?.rework_budget ?? maxRework
          if (used >= budget) {
            return deny(
              'REWORK_EXHAUSTED',
              `打回次数超限：本任务「${leg === 'dev' ? '打回编写' : '打回测试'}」已用 ${used} 次，上限 ${budget} 次。\n` +
                `按规则不能无限打回。请改用：pipeline_transition event=block（已阻塞）交人工介入，` +
                `或让编排复核后追加仲裁/架构角色（pipeline_roster_request → pipeline_roster_review）。`,
            )
          }
          break
        }

        // ★ 人工介入的两个前置条件（状态机只负责"能不能走"，判据在这里）
        case 'human_request_blocking': {
          const h = lastHandoff(task, 'human_request')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要进入「等待人工答复」，必须先有一份 human_request 交接物。`)
          }
          if (h.payload?.blocking !== true) {
            return deny(
              'NOT_BLOCKING',
              `最近一份 human_request（${h.handoff_id}）声明的是 blocking=false（不阻塞），不该把任务推进到「等待人工答复」。`,
            )
          }
          break
        }
        case 'human_reply_has_source': {
          const entry = this.findHumanRequest(task, input.requestId)
          if (entry === null) {
            return deny(
              'NO_HUMAN_REQUEST',
              `任务 ${task.id} 里没有任何人工介入请求 —— 不能凭空从「等待人工答复」恢复。\n` +
                '这条挡的是"没等人回话就把状态推回去"。',
            )
          }
          if (entry.relayed_at === null) {
            return deny(
              'NOT_RELAYED',
              `请求 ${entry.request_id} 还没有转告给用户（relayed_at 为空），所以不可能有答复。\n` +
                '先 pipeline_human_relay。',
            )
          }
          if (entry.status !== 'answered') {
            return deny(
              'MISSING_USER_ANSWER',
              `请求 ${entry.request_id} 还没有记录用户答复（status=${entry.status}）。\n` +
                '★ 主对话不能自行把请求标记为已解决 —— 必须先用 pipeline_human_reply 记下用户的答复（含原话与归属），' +
                '状态才会跟着恢复。',
            )
          }
          break
        }
        default:
          return deny('INTERNAL', `未知的前置条件「${name}」（插件内部错误）。`)
      }
      return { ok: true }
    },

    /**
     * 写入角色清单（**计划分配**的产物：planner 出计划、自检、再写它）。
     *
     * 谁能调用由工具层判（必须持 planner 令牌，或 L0 的规则引擎路径）。
     */
    async setRoster(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      // ★ 本轮新增（计划自检通过才能分配）----------------------------------
      //   这是"自检没通过就不许分配 AI"的**主闸**：planner 走 pipeline_plan 时，
      //   计划交接物先落盘、再写角色清单；自检 verdict=gaps 时那份计划已经把任务
      //   推到「等待需求分析答复」了，这里再拦一道，保证**任何**调用路径都绕不过去。
      //   （状态机那边还有 plan_ready 一道，两道判的是同一件事、同一份数据。）
      if (input.judgedBy === 'planner') {
        const plan = lastHandoff(task, 'plan')
        if (plan === null) {
          return deny(
            'MISSING_PLAN',
            `拒绝分配：计划 AI 必须先产出 plan 交接物（含自检结果），才能写角色清单。\n` +
              '★ 顺序是"出计划 → 自检 → 无缺失才分配"。跳过计划直接分配 = 没有"这活怎么切"的答案。',
          )
        }
        if (plan.payload?.self_check?.verdict !== 'ok') {
          const gaps = Array.isArray(plan.payload?.self_check?.gaps) ? plan.payload.self_check.gaps : []
          return deny(
            'PLAN_SELF_CHECK_NOT_OK',
            `拒绝分配：最近一份计划（${plan.handoff_id}）的自检结果是 **${plan.payload?.self_check?.verdict ?? '(缺失)'}**，不是 ok。\n` +
              '★ 自己都说了有缺失，就不许分配 AI —— 先把缺口问清楚（退回需求分析）。\n' +
              (gaps.length > 0 ? `缺的是：\n${gaps.map((g) => `  · ${g}`).join('\n')}\n` : '') +
              '下一步：plan 交接物里带上 self_check.verdict=gaps 与 gap_question，状态会落到「等待需求分析答复」。',
          )
        }

        // ★ 设计目的：计划的**角色边界卡必须覆盖清单里每一个执行角色**。
        //
        //   判据放在这里（而不是 handoff.js）的原因：只有这一刻两边数据才齐 ——
        //   plan 里写了哪些角色的边界、roster 里到底有哪几个执行角色。
        //   在提交 plan 那一刻还算不出 roster（清单是同一次调用后面才写的）。
        //
        //   用户要求：「任务卡与计划里**为每个角色写死边界**，派活时按这个边界派，
        //   别让谁顺手多干」—— 少一个角色，那个角色派活时就没有边界可依据。
        {
          const built = buildRoster({
            tier: input.tier,
            reason: input.reason,
            judgedBy: input.judgedBy,
            extraRoles: input.extraRoles,
            removeRoles: input.removeRoles,
            l0OrchestratorSeparate: input.l0OrchestratorSeparate === true,
            reworkBudget: maxRework,
            // ★ 与下面那次构造**同一个数据面**（同一份 slots / strictSlots / writers）——
            //   两次构造若输入不同，"判据看的那份名单"与"真正落盘的那份"就会是两个东西。
            slots: input.slots,
            strictSlots: input.slots !== null && typeof input.slots === 'object' && Object.keys(input.slots).length > 0,
            writers: input.writers,
            relayPolicy: input.relayPolicy,
          })
          if (built.ok === true) {
            // ★ B1 的写入前置判据（名单权威层）：**写活角色**必须逐席位声明四槽。
            //   拒在"改 task.roster 之前、持久化之前"⇒ 拒了之后盘上一个字节都不动。
            //   只读角色（main、orchestrator、planner、supervisor、human）不派活 ⇒ 不在此列。
            //
            //   ★★ 2026-10-12 回归修复：这里的"要声明四槽的席位"**不再自己算一遍**。
            //   改前它把**裸角色键 `writer`** 也算进来，而四槽表的构造方
            //   （`buildRosterSlots` → `rosterSlotTargets`）在编写角色有分区时**故意不产生**
            //   那个键（有分区 ⇒ 派活的实体是席位 `writer@writer#1`）。
            //   两边各算一遍 ⇒ 判据每次只点名 `writer`，**任何计划都出不来**、
            //   连插件自带的正例夹具都报"内部错误（这是插件 bug）"。
            //   现在键集合只有一个出处：`rosterSlotKeys`。
            const slotTargets = rosterSlotKeys(built.roster.conversations, built.roster.writers)
            const slotMissing = slotTargets.filter((k) => !Object.hasOwn(built.roster.slots ?? {}, k))
            if (slotMissing.length > 0) {
              return deny(
                'ROSTER_SLOT_MISSING',
                `拒绝分配：名单里 ${slotMissing.length} 个席位没有声明四槽：${slotMissing.join('、')}\n` +
                  `本次要声明四槽的席位：${slotTargets.join('、')}\n` +
                  '★ 四槽 = 权限档（permission）、内置模式（mode）、模型（model）、推理等级（reasoning），\n' +
                  '  **四个平级字段**（不许打包成一个 options 对象）。缺任一槽即拒 ——\n' +
                  '  否则「名单声明什么档、会话实际拿到什么档」就无从判定（B1）。\n' +
                  '★ 未声明权限档 ⇒ 实际生效档是**最小档**（read-only），该席位写文件会被守门拒（B3）。',
              )
            }

            const need = built.roster.execution_roles
            // ★ 复核中途加人时，新卡由那次复核给出（`input.roleBoundaries`），
            //   与计划原有的卡合并后再核对覆盖性。
            const cards = [
              ...(Array.isArray(plan.payload?.role_boundaries) ? plan.payload.role_boundaries : []),
              ...(Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []),
            ]
            const got = [...new Set(cards.map((b) => String(b?.role ?? '').trim()).filter((x) => x.length > 0))]
            const missing = need.filter((r) => !got.includes(r))
            if (missing.length > 0) {
              return deny(
                'ROLE_BOUNDARIES_INCOMPLETE',
                `拒绝分配：计划里的**角色边界卡没覆盖全部执行角色**。\n` +
                  `缺的是：${missing.join('、')}\n` +
                  `本次清单的执行角色：${need.join('、')}\n` +
                  `边界卡里已有的：${got.filter((x) => x.length > 0).join('、') || '（无）'}\n` +
                  '★ 每个角色的"只干什么、不干什么"必须在**计划里**就写死 —— \n' +
                  '  派活时按它派，而不是等谁顺手多干了再追责。\n' +
                  '  下一步：plan 交接物里的 role_boundaries 补齐这几张卡。',
              )
            }
          }
        }
      }

      const built = buildRoster({
        tier: input.tier,
        reason: input.reason,
        judgedBy: input.judgedBy,
        extraRoles: input.extraRoles,
        removeRoles: input.removeRoles,
        l0OrchestratorSeparate: input.l0OrchestratorSeparate === true,
        reworkBudget: maxRework,
        /**
         * ★★ **四槽声明的数据通路**（B1 的第二半：闸门有了，通路也得有）。
         *
         * 改前：两处 `buildRoster(...)` 都**没有**把 `input.slots` 传下去 ⇒ 名单的四槽表
         * 永远只含**默认值**、`input.slots` 无处可落（计划 AI 把四槽写在哪儿都进不来）。
         * 现在：显式声明表原样交给构造方；**声明了就必须声明齐**（`strictSlots`），
         * 因为"只声明一半"看起来像已经安排好了，比不声明更危险。
         */
        slots: input.slots,
        strictSlots: input.slots !== null && typeof input.slots === 'object' && Object.keys(input.slots).length > 0,
        writers: input.writers,
        relayPolicy: input.relayPolicy,
      })
      if (built.ok !== true) return deny('BAD_ROSTER', `角色清单构造失败：${built.error}`)

      const roster = built.roster
      const v = validateRoster(roster)
      if (v.ok !== true) return deny('BAD_ROSTER', `角色清单自检不通过：\n- ${v.errors.join('\n- ')}`)

      const previous = task.roster
      task.roster = roster
      // ★ 设计目的：把计划里的**授权改动面**与**角色边界卡**落到任务上。
      //   前者给守门与 dev_to_test 核对用（"改动面必须与授权面相等"），
      //   后者给派活时取用（"派活时按这个边界派"）。
      {
        const plan = lastHandoff(task, 'plan')
        if (plan !== null && input.judgedBy === 'planner') {
          task.change_scope = Array.isArray(plan.payload?.change_scope) ? plan.payload.change_scope : []
          /** ★ 越界清单（这次不许做什么）—— 派活时与授权面一起交给 writer 与 reviewer。 */
          task.plan_forbidden = toStringArray(plan.payload?.forbidden)
          // 边界卡：计划里的 + 本次复核补的（中途加人时后者非空）
          const base = Array.isArray(plan.payload?.role_boundaries) ? plan.payload.role_boundaries : []
          const extra = Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []
          task.role_boundaries = [
            ...base.filter((b) => !extra.some((n) => String(n?.role) === String(b?.role))),
            ...extra,
          ]
          task.plan_handoff_id = plan.handoff_id
        } else if (task.change_scope === undefined) {
          // L0（规则引擎自批）没有计划这一站 ⇒ 不存在授权面。
          // 不塞一个"整棵项目根"的假授权：那只会制造"看起来在管、其实没管"的假执法。
          task.change_scope = null
          task.role_boundaries = null
        }
      }
      task.task_card = {
        task_id: task.id,
        requirement: task.requirement,
        acceptance: toStringArray(input.acceptance),
        test_points: toStringArray(input.testPoints),
        boundaries: toStringArray(input.boundaries),
        tier: roster.tier,
        ai_count: roster.ai_count,
        roles: roster.conversations.slice(),
        sequence: roster.sequence.map((s) => s.role),
        reason: roster.reason,
        judged_by: roster.judged_by,
      }
      // 产出分配交接物，让"每次判断有理由记录、可追溯"落到盘上。
      // ★ 本轮起这份产物叫「分配结论」，产出者是**计划 AI**（分配权从 orchestrator 移过来）。
      if (input.judgedBy === 'planner') {
        const rec = buildHandoffRecord({
          kind: 'orchestration',
          taskId: task.id,
          fromRole: ROLE.PLANNER,
          toRole: ROLE.MAIN,
          payload: {
            task_id: task.id,
            tier: roster.tier,
            ai_count: roster.ai_count,
            roles: roster.conversations.slice(),
            sequence: roster.sequence.map((s) => s.role),
            reason: roster.reason,
            task_card: task.task_card,
            acceptance: task.task_card.acceptance,
            test_points: task.task_card.test_points,
            boundaries: task.task_card.boundaries,
            layers: roster.writers?.layers ?? [],
          },
        })
        await this.appendHandoff(task, rec)
      }

      // ★ 名单版本位：**内容变了才 +1**（同内容重写不改版本），单调递增、随 roster 一起落盘。
      //   它是留痕里"依据名单版本"的取值处（B6）；同内容重写不改版本，是为了保住
      //   "版本变了 ⇔ 四槽真的变了"这条等价关系。
      const prevDigest = previous === null ? null : (previous.slots_digest ?? null)
      const sameDigest = prevDigest !== null && prevDigest === roster.slots_digest
      const prevVersion = previous === null || !Number.isInteger(previous.slots_version) ? 0 : previous.slots_version
      roster.slots_version = sameDigest ? prevVersion : prevVersion + 1

      const entry = await audit(task.id, input.actorRole ?? ROLE.PLANNER, 'roster:set', {
        tier: roster.tier,
        ai_count: roster.ai_count,
        roles: roster.conversations,
        judged_by: roster.judged_by,
        slots_version: roster.slots_version,
        slots_digest: roster.slots_digest,
        slots: roster.slots,
        changed: previous === null ? 'initial' : `${previous.tier}→${roster.tier}`,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // ★ 角色清单产出 = 计划分配完成 → 顺带把状态推进到「待开发」。
      //
      //   本轮改了两处（都必须改，否则流程走不通）：
      //     ① 触发状态从 `analyzing` 换成 `planning` —— 需求分析不再产出清单，
      //        它在 `analyzing` 交的是**分析结论**，那条边的终点是「待计划」。
      //     ② 事件与角色跟着换：planner 走 `planned`（挂 plan_ready 判据），
      //        规则引擎（L0）仍走 `orchestrated`。
      //   不在这些状态时不动状态（例如执行中改了角色清单，不该把流程推回去）。
      let advanced = null
      const byPlanner = roster.judged_by === 'planner'
      const canAdvance = byPlanner ? task.state === ST.PLANNING : task.state === ST.PENDING
      if (canAdvance) {
        const tr = await this.transition({
          taskId: task.id,
          event: byPlanner ? 'planned' : 'orchestrated',
          actorRole: byPlanner ? ROLE.PLANNER : 'rule-engine',
          actorAgentId: input.actorAgentId,
          note: byPlanner ? '计划自检通过 + 分配完成' : 'L0 规则引擎自批',
        })
        if (tr.ok === true) advanced = { from: tr.from, to: tr.to }
      }

      return {
        ok: true,
        task,
        roster,
        advanced,
        summary:
          `角色清单已写入：${roster.tier}（${roster.tier_zh}），共 ${roster.ai_count} 个独立对话。` +
          (advanced === null ? '' : `\n任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。`),
      }
    },

    // --- ★改动基线（前后版本对比的基准）------------------------------------

    /**
     * ★ **记录改动基线**（派活那一刻的项目快照）。
     *
     * 用户原话：「**派活那一刻记录基线**（项目根的文件清单 + 每个文件的哈希；
     * 只存清单与哈希，不复制源码，避免体积膨胀），并让基线**可证明就是派活那一刻的状态**」。
     *
     * 三条设计：
     *   ① **只存清单与哈希**（不复制源码）：体积与"文件数"同阶，不随项目大小膨胀；
     *   ② **可证明**：记下 `taken_at` / `taken_by` / `plan_handoff_id`（绑定这次计划的交接物 id）
     *      与 `digest`（整份清单的 sha256）—— 三者一起构成"这一版基线就是那一刻的状态"；
     *   ③ **排除 `.pipeline/`**：那是流水线自己的台账（报告、记录、审计），
     *      它本来就会被写，算进基线只会让"改动面"永远对不上；
     *   ④ ★ **重取基线 = 新起点**：新基线一落地，就按 `resetHashGateOrigin`
     *      把"哈希闸门连续不通过"的计数归零、并作废基于旧基线算出的那份闸门判定
     *      （留痕 `gate:hash_reset`）。理由与边界见下方内联注释 ——
     *      **越界判定本身一个字没放宽**。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} [input.by] - 谁记的（默认 planner）
     * @param {string} [input.planHandoffId]
     * @param {string} [input.note]
     */
    async takeBaseline(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const root = task.project_root
      const { readdir, stat, readFile: rf } = await import('node:fs/promises')
      const skipDir = String(dirName).toLowerCase()

      const files = {}
      let bytes = 0
      const walk = async (dir, rel) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('.git')) continue
          const abs = join(dir, e.name)
          const r = rel.length === 0 ? e.name : `${rel}/${e.name}`
          if (e.isDirectory()) {
            if (r.toLowerCase() === skipDir) continue // 流水线台账不算改动面
            await walk(abs, r)
            continue
          }
          if (!e.isFile()) continue
          try {
            const st = await stat(abs)
            const buf = await rf(abs)
            files[r.replace(/\\/g, '/')] = { sha256: fullHash(buf.toString('utf8')), bytes: st.size }
            bytes += st.size
          } catch {
            /* 读不到就跳过（权限/临时文件）：基线宁可少一条，也不要整个失败 */
          }
        }
      }
      await walk(root, '')

      const digest = fullHash(JSON.stringify(Object.keys(files).sort().map((k) => `${k}|${files[k].sha256}`)))
      const rec = {
        baseline_id: `BL-${shortHash(`${task.id}|${(task.baselines ?? []).length}|${digest}`)}`,
        taken_at: nowIso(now()),
        taken_by: String(input.by ?? ROLE.PLANNER),
        plan_handoff_id: typeof input.planHandoffId === 'string' ? input.planHandoffId : null,
        note: typeof input.note === 'string' ? input.note : '',
        file_count: Object.keys(files).length,
        total_bytes: bytes,
        digest,
        files,
      }
      task.baselines = task.baselines ?? []
      task.baselines.push(rec)
      // ⚠️ 顺序：**先**按"新基线 id"清旧起点，**再**把基线指针指过去 ——
      //    这样 `origin.prev_baseline_id` 记的才是"被换掉的那一份"，审计读得懂。
      const origin = resetHashGateOrigin(task, rec.baseline_id)
      task.baseline_current = rec.baseline_id

      // ★★ **重取基线 = 新起点**（本轮修的第二个拦路虎）------------------------
      //
      //   闸门判的是「**相对基线**的变化」。基线取早了（本单开工基线早于当晚几次
      //   基础设施前置修复）⇒ 那批**与本单无关**的改动会永远显示成"本单越界"，
      //   编写席修不掉（它撤不回别人的活），唯一出路就是重取基线。
      //   可早先重取基线**不清"连续不通过"的计数**：旧基线下的 1/3 跟着走到新基线，
      //   再攒两次就触发"机制自动交人工" —— 等于让编写替别人的改动挨那张人工单。
      //
      //   所以这里按 `resetHashGateOrigin` 把计数归零、并作废基于**旧基线**算出的
      //   那份闸门判定（它自己的 baseline_id 就是过期证据；留着会继续拦"跑测试"）。
      //
      //   ⚠️ **一个字都没放宽**：三类越界（新增/修改/删除清单外）与"声明不实"
      //      照旧被拒、照旧计数、照旧在连续 N 次后自动交人工 —— 改的只是**起点**。
      //   ⚠️ **不碰 `hash_gate_escalation`**：已经交到用户手上的单不会因为重取基线
      //      被悄悄撤回（机制不替用户撤单）。
      const file = join(taskDir(task.id), `baseline-${rec.baseline_id}.json`)
      await writeJsonAtomic(file, rec)
      rec.file = file
      const entry = await audit(task.id, rec.taken_by, 'baseline:take', {
        baseline_id: rec.baseline_id,
        file_count: rec.file_count,
        digest,
        plan_handoff_id: rec.plan_handoff_id,
      })
      task.history.push(entry)
      if (origin.changed) {
        // 留痕：事主要能回答"这次重取到底清掉了什么"。
        task.history.push(
          await audit(task.id, rec.taken_by, 'gate:hash_reset', {
            baseline_id: rec.baseline_id,
            prev_baseline_id: origin.prev_baseline_id,
            prev_streak: origin.prev_streak,
            now_streak: 0,
            prev_gate_baseline_id: origin.prev_gate_baseline_id,
            prev_gate_blocked: origin.prev_gate_blocked,
            why:
              '重取基线 = 新起点：连续不通过计数按新基线重新起算，基于旧基线算出的闸门判定一并作废。' +
              '三类越界判定与"声明不实"判定**一个字没放宽**（授权面之外的改动仍必须被拒）。',
          }),
        )
      }
      await persist(task)
      return { ok: true, task, baseline: rec, origin }
    },

    /** 取当前基线（读回记录）。 */
    currentBaseline(task) {
      const id = task?.baseline_current ?? null
      if (id === null) return null
      return (task.baselines ?? []).find((b) => b.baseline_id === id) ?? null
    },

    // --- ★★ 席位级写入台账（选项 B）：「谁改的」按**归属**判，而不是只看路径形状 ---
    //
    // 判据本体（三条不许破的线、为什么必须带哈希）在 `lib/hashgate.js` 顶部那一整段；
    // 这里只做两件事：**喂账本**（席位交东西的时候）与**读账本**（判定之前）。
    //
    // 为什么落点是 `.pipeline/<任务>/write-ledger.jsonl`：
    //   · **基线明确排除 `.pipeline/`** ⇒ 台账永远不会把自己变成一处"改动"
    //     （放别处的话，台账自己就会被判越界 —— 这是硬约束，不是偏好）；
    //   · 与 `audit.jsonl` 同级同性质：**只追加**，事后能回答"谁在什么时候写了什么路径"。

    /** 本单的台账文件（与 `audit.jsonl` 并排）。 */
    writeLedgerFileOf(taskId) {
      return join(taskDir(taskId), WRITE_LEDGER_FILE_NAME)
    },

    /**
     * ★★ **记一笔席位写入**：哪张单 / 哪个角色 / 哪个席位 / 哪个会话 / 哪份基线 /
     * 交出了哪些路径 / 那些路径**当时**的内容 sha256。
     *
     * 两条实现要点：
     *   ① **哈希优先取本次审计算出来的那份**（`changeAudit` 的 added/modified 带 sha256，
     *      它就是"现在这一刻"的内容哈希，不必再读一遍文件）；
     *   ② 声明里那些**本次审计没列出**的路径（相对本单基线没变过），**直读一次**补哈希；
     *      读不到就留 `null` —— 归属判据**不认没有哈希的证据**（宁可多拒）。
     *
     * ⚠️ 它**不是授权**、也**不拦任何提交**：写失败只留痕（见调用点的 `ledger:seat-write-failed`），
     *    因为台账是判据的**辅助证据**，不是判据本身 —— 证据缺了，判据退回严格那一支。
     *
     * @returns {Promise<{ok:boolean, written:number, entries:number, error:string|null}>}
     */
    async recordSeatWrites(spec) {
      const task = spec?.task ?? null
      const manifest = Array.isArray(spec?.manifest) ? spec.manifest : []
      if (task === null || typeof task !== 'object' || typeof task.id !== 'string') {
        return { ok: false, written: 0, entries: 0, error: '没有任务对象（内部调用错误）' }
      }
      if (manifest.length === 0) {
        return { ok: true, written: 0, entries: 0, error: null }
      }
      const hashByKey = new Map()
      for (const x of [...(spec?.audit?.added ?? []), ...(spec?.audit?.modified ?? [])]) {
        const key = baselineAbsKey(x?.path)
        if (typeof x?.sha256 === 'string' && x.sha256.length > 0) hashByKey.set(key, x.sha256.toLowerCase())
      }
      const anchor = anchorOf(task)
      const paths = []
      for (const m of manifest) {
        const raw = String(m?.path ?? '').trim()
        if (raw.length === 0) continue
        // ★ 用**本单自己的锚点**把路径解析成原始大小写的绝对路径（读文件要它），
        //   再算规范绝对键（小写 POSIX）—— 台账里存的是后者：读的人不必知道写的人用哪个锚点。
        const absRaw = resolveAgainstAnchor(anchor, raw)
        const key = absRaw.length === 0 ? '' : cmpKey(absRaw)
        if (key.length === 0) continue
        let sha = hashByKey.get(key) ?? null
        if (sha === null) {
          try {
            const buf = await readFile(absRaw)
            sha = fullHash(buf.toString('utf8')).toLowerCase()
          } catch {
            sha = null
          }
        }
        paths.push({ path: raw, key, sha256: sha })
      }
      const entry = makeWriteLedgerEntry({
        at: nowIso(now()),
        taskId: task.id,
        role: String(spec?.role ?? ''),
        seat: spec?.seat ?? null,
        agentId: spec?.agentId ?? null,
        baselineId: spec?.baselineId ?? null,
        submissionSeq: Number.isInteger(spec?.submissionSeq) ? spec.submissionSeq : null,
        source: WRITE_LEDGER_SOURCES.devManifest,
        paths,
      })
      if (entry === null) return { ok: true, written: 0, entries: 0, error: null }
      try {
        await appendJsonl(this.writeLedgerFileOf(task.id), entry)
      } catch (err) {
        return { ok: false, written: 0, entries: paths.length, error: String(err?.message ?? err) }
      }
      return { ok: true, written: 1, entries: paths.length, error: null }
    },

    /**
     * ★★ **读全部台账**（本单的 + 别单的）—— 判定之前调用。
     *
     * 「只能由**别的单**豁免本单」这条线**不在读这一侧**实现，而在
     * `lib/hashgate.js` 的 `buildForeignWriteIndex` 里（`task_id === 本单` 的行在那里被丢）
     * —— 一处实现，免得两边各写一份口径。
     *
     * 读不到 / 坏行 ⇒ 该行不算证据（**不猜、不半信半疑**）：坏行计数如实返回，写进审计。
     *
     * @returns {Promise<{entries:object[], damaged:number, files:number, list_error:string|null}>}
     */
    async loadSeatWriteLedger() {
      const entries = []
      let damaged = 0
      let files = 0
      let listError = null
      let names = []
      try {
        names = await readdir(root, { withFileTypes: true })
      } catch (err) {
        // 一个任务都还没有 / 目录读不到 ⇒ 空台账（判定退回严格那一支），但**说出来**。
        return { entries, damaged, files, list_error: String(err?.message ?? err) }
      }
      for (const e of names) {
        if (e === null || typeof e !== 'object' || e.isDirectory?.() !== true) continue
        try {
          const text = await readFile(join(root, e.name, WRITE_LEDGER_FILE_NAME), 'utf8')
          const parsed = parseWriteLedger(text)
          entries.push(...parsed.entries)
          damaged += parsed.damaged
          files += 1
        } catch {
          /* 这张单没有台账 / 读不到 ⇒ 跳过（**不猜**：没有证据就照旧严格） */
        }
      }
      return { entries, damaged, files, list_error: listError }
    },

    /**
     * ★ **前后版本对比**：拿基线逐文件对照当前状态。
     *
     * 产出用户点名要的三类结论：
     *   · **多改**（`unauthorized` + `added` 里清单外的）
     *   · **少改**（`missing`：授权了却没动）
     *   · **改错地方**（`unauthorized`：动的不是授权的那份）
     * 外加 `modified`（改了且在授权内）与 `removed`。
     *
     * 判据是**哈希比对 + 授权面逐条核对**，不看代码内容 —— 所以审核可以在
     * "不读代码"的前提下拿到判据式证据（与"控制角色不看代码"那条边界兼容）。
     */
    async changeAudit(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const base = this.currentBaseline(task)
      if (base === null) {
        return deny(
          'NO_BASELINE',
          `任务 ${task.id} 还没有**改动基线** —— 没有基线就做不了前后版本对比。\n` +
            '★ 基线应当在**派活那一刻**记录（本项目里由 pipeline_plan 产出计划时自动记录）。\n' +
            '（L0 档没有"计划"这一站，所以也没有基线 —— 这条判据在 L0 上不适用。）',
        )
      }
      const snap = await this.takeBaselineSnapshot(task)
      const scope = Array.isArray(task.change_scope) ? task.change_scope : []

      const added = []
      const modified = []
      const removed = []
      // ★ 每条都带上哈希：打回理由要"可执行"（基线哈希 / 实际哈希 / 期望），
      //   光说"你越界了"编写还得自己去猜哪一处。
      for (const [rel, info] of Object.entries(snap.files)) {
        const before = base.files[rel]
        if (before === undefined) {
          added.push({ path: rel, bytes: info.bytes, sha256: info.sha256, baseline_sha256: null })
        } else if (before.sha256 !== info.sha256) {
          modified.push({ path: rel, bytes: info.bytes, sha256: info.sha256, baseline_sha256: before.sha256 })
        }
      }
      for (const rel of Object.keys(base.files)) {
        if (snap.files[rel] === undefined) {
          removed.push({ path: rel, bytes: base.files[rel].bytes, sha256: null, baseline_sha256: base.files[rel].sha256 })
        }
      }

      const inScope = (rel) => {
        // ★ 修 ③：两边先落到**同一个坐标系**（规范绝对键）再比。
        //   早先这里直接拿"相对项目根的基线键"去比 `scopeRelOf()` 出来的
        //   相对路径，而授权面条目一旦写成**绝对路径**就解析成 `null` ⇒
        //   那条授权被静默作废（真单 T-20261011-5a871c 的源码树两条）。
        const absFile = baselineAbsKey(rel)
        for (const e of scope) {
          const abs = scopeAbsKey(e?.path, task)
          if (abs.length === 0) continue
          if (isInside(abs, absFile)) return e
        }
        return null
      }
      const unauthorized = []
      for (const x of added) {
        if (inScope(x.path) === null) {
          unauthorized.push({ path: x.path, how: 'created_unauthorized', baseline_sha256: null, actual_sha256: x.sha256 ?? null })
        }
      }
      for (const x of modified) {
        if (inScope(x.path) === null) {
          unauthorized.push({ path: x.path, how: 'modified_unauthorized', baseline_sha256: x.baseline_sha256 ?? null, actual_sha256: x.sha256 ?? null })
        }
      }
      for (const x of removed) {
        if (inScope(x.path) === null) {
          unauthorized.push({ path: x.path, how: 'removed_unauthorized', baseline_sha256: x.baseline_sha256 ?? null, actual_sha256: null })
        }
      }

      // 少改：授权了（modify/create）却**一点没动**的条目
      //
      // ★ 修 ③：这里早先直接拿授权条目的**原文**去比 `touched`（相对项目根的基线键）
      //   ⇒ 条目写成绝对路径时**永远**匹配不上，「少改」于是变成一条恒真的误报。
      //   改成与 `inScope` 同一套归一化：条目 → 规范绝对键，touched → 同一个坐标系。
      const touchedAbs = new Set([...added, ...modified].map((x) => baselineAbsKey(x.path)))
      const missing = []
      for (const e of scope) {
        const abs = scopeAbsKey(e?.path, task)
        if (abs.length === 0) continue
        if (e.action === 'delete') continue // 删除类不参与"少改"
        const hit = [...touchedAbs].some((t) => isInside(abs, t))
        if (!hit) missing.push({ scope_id: String(e.id ?? ''), path: String(e.path ?? '') })
      }

      const verdict = unauthorized.length === 0 ? 'within_scope' : 'out_of_scope'
      return {
        ok: true,
        task,
        baseline: { baseline_id: base.baseline_id, taken_at: base.taken_at, taken_by: base.taken_by, file_count: base.file_count, digest: base.digest },
        added,
        modified,
        removed,
        unauthorized,
        missing,
        verdict,
        counts: { added: added.length, modified: modified.length, removed: removed.length, unauthorized: unauthorized.length, missing: missing.length },
      }
    },

    /** 扫一遍当前项目根（基线用的同一个算法）。 */
    async takeBaselineSnapshot(task) {
      const { readdir, stat, readFile: rf } = await import('node:fs/promises')
      const skipDir = String(dirName).toLowerCase()
      const files = {}
      const walk = async (dir, rel) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('.git')) continue
          const abs = join(dir, e.name)
          const r = rel.length === 0 ? e.name : `${rel}/${e.name}`
          if (e.isDirectory()) {
            if (r.toLowerCase() === skipDir) continue
            await walk(abs, r)
            continue
          }
          if (!e.isFile()) continue
          try {
            const st = await stat(abs)
            const buf = await rf(abs)
            files[r.replace(/\\/g, '/')] = { sha256: fullHash(buf.toString('utf8')), bytes: st.size }
          } catch {
            /* 同上：读不到就跳过 */
          }
        }
      }
      await walk(task.project_root, '')
      return { files }
    },

    /** 把一份交接物记录追加进任务并落盘。 */
    async appendHandoff(task, record) {
      task.handoffs.push(record)
      const seq = String(task.handoffs.length).padStart(3, '0')
      const file = join(handoffDir(task.id), `${seq}-${record.kind}.json`)
      await writeJsonAtomic(file, record)
      record.file = file
      return record
    },

    /**
     * ★ 校验一份 `dev_to_test` 的席位归属。
     *
     * 两条判据：
     *   ① 提交的席位必须在册（roster.writers.partitions 里有它）
     *   ② 调用方令牌的席位必须与提交的席位一致（防"拿 writer#1 的令牌交 writer#2 的分区"）
     *
     * 单席位（count=1）并且没给 partition 时，自动补成 `writer#1` + 整根范围 ——
     * 这是与旧行为**完全等价**的退化路径。
     */
    checkSeatOwnership(task, payload, input) {
      const seats = writerSeatsOf(task)
      const given = payload.partition
      const declaredSeat = typeof given?.seat === 'string' && given.seat.length > 0 ? given.seat : null

      // ① 在册？
      const seat = declaredSeat ?? seats[0]
      if (!seats.includes(seat)) {
        return deny(
          'SEAT_NOT_DECLARED',
          `席位「${seat}」不在本任务的在册编写席位里（在册：${seats.join('、')}）。\n` +
            '编写席位是**计划分配**（planner）的产物，不是自己声明的。要加席位必须走 ' +
            'pipeline_roster_request → pipeline_roster_review 复核。',
        )
      }

      // ② 令牌席位是否对得上？
      const tokenSeat = typeof input.actorSeat === 'string' && input.actorSeat.length > 0 ? input.actorSeat : null
      if (tokenSeat !== null && tokenSeat !== seat) {
        const mine = seatPartitionOf(task, tokenSeat)
        const theirs = seatPartitionOf(task, seat)
        return deny(
          'SEAT_MISMATCH',
          `席位不匹配：你这枚令牌属于「${tokenSeat}」，但这份交接物声明的是「${seat}」。\n` +
            `你的范围：${(mine?.scope_paths ?? []).join('、') || '(未声明)'}\n` +
            `对方范围：${(theirs?.scope_paths ?? []).join('、') || '(未声明)'}\n` +
            '★ 只能提交自己那一份。要交别人的分区，得先让编排把席位重新分配（roster_request → roster_review）。',
        )
      }

      const part = seatPartitionOf(task, seat)
      return {
        ok: true,
        partition: {
          seat,
          index: part?.index ?? 1,
          total: part?.total ?? seats.length,
          // ★ 本轮新增：层随分区一起回填 —— 交接物与角色清单里的层必须一致，
          //   否则"谁负责哪层"会出现两个版本。
          //   （layer 的**形状**校验在 handoff.js；这里回填的是**事实来源**：roster 的分区表。）
          layer: part?.layer ?? 'all',
          scope_paths: part?.scope_paths ?? ['.'],
        },
      }
    },

    /**
     * ★ 校验架构图交付的**回执**（要读磁盘，所以只能在 store 层做）。
     *
     * 判据分两条路：
     *   · `produced_by=diagram_deliver`：收据文件必须**真实存在**（这是"声称走过闸门"的凭据）；
     *     若还给了 `html_sha256`，与磁盘上的产物核对
     *   · `produced_by=self-provided`：`degraded` 必须为 true 且有原因（字段校验已管），
     *     这里只确认产物本身存在
     *
     * 无论哪条路，`diagram_path` 都必须指向一个**真实存在**的文件 ——
     * 交一份指向不存在路径的"交付物"没有意义。
     */
    async checkDiagramDelivery(task, payload) {
      const { existsSync } = await import('node:fs')
      const root = task.project_root

      const resolveOne = (p) => {
        const s = String(p ?? '').trim()
        if (s.length === 0) return null
        return pathKey(isAbsolute(s) ? resolve(s) : resolve(root, s))
      }

      const diagramPath = resolveOne(payload.diagram_path)
      if (diagramPath === null || !existsSync(diagramPath)) {
        return deny(
          'DIAGRAM_MISSING',
          `diagram_path 指向的文件不存在：${payload.diagram_path}\n` +
            '交付物必须真的躺在盘上 —— 指向一个不存在的路径不算交付。\n' +
            '（若走 diagram_deliver，把它返回的 html_path 原样填进来。）',
        )
      }

      if (payload.produced_by === 'diagram_deliver') {
        const receiptPath = resolveOne(payload.receipt_path)
        if (receiptPath === null || !existsSync(receiptPath)) {
          return deny(
            'RECEIPT_MISSING',
            `produced_by=diagram_deliver，但收据文件不存在：${payload.receipt_path}\n` +
              '★ diagram_deliver 的价值就在那份**交付收据**（含被引用模块的 id 与 fingerprint、' +
              '规格文件 sha256、产物 sha256、所用命令与版本）。没有收据，事后就答不出' +
              '"这张图基于哪一版结构数据、当时校验过没有"。\n' +
              '两条出路：① 真的调一次 diagram_deliver，把它返回的 receipt_path 填进来；' +
              '② 如果 dsh-archigate 没装/被禁用，把 produced_by 改成 self-provided 并标 degraded=true + 原因。',
          )
        }

        if (typeof payload.html_sha256 === 'string' && payload.html_sha256.trim().length > 0) {
          const { readFile } = await import('node:fs/promises')
          const actual = fullHash(await readFile(diagramPath, 'utf8'))
          if (actual !== payload.html_sha256.trim()) {
            return deny(
              'DIAGRAM_HASH_MISMATCH',
              `html_sha256 与磁盘上的产物对不上。\n` +
                `交接物里写的：${payload.html_sha256.trim()}\n实际文件的：      ${actual}\n` +
                '制品版本化就是为了防"说的是这一版、交的是另一版"。',
            )
          }
        }
        return { ok: true, diagramPath, receiptPath }
      }

      // self-provided：产物在就行（degraded/原因由字段校验管）
      return { ok: true, diagramPath, receiptPath: null }
    },

    /**
     * ★★ **哈希闸门连续不通过 ⇒ 自动交人工**（用户拍板 P13 的那一半）。
     *
     * 「不许另起一套并行机制」是硬要求，所以这里**不新开**状态、工具、请求表：
     *   · 用的就是既有的 `human_request` 交接物 + `task.human_requests` 生命周期
     *     + `awaiting_human` 那两条边（发起 → 主对话转告 → 用户答复 → 恢复）；
     *   · 答复仍然必须带**来源**与用户**本人原话**（`human_reply_has_source` 判据一个字没动）；
     *   · 唯一"新"的东西是 `reason_kind=hash_gate_escalation` 这一个枚举值，
     *     以及"只有机制发得出来"那一条闸（见 `checkHumanRequestChannel` 的 ⓪）。
     *
     * 谁发起：**需求分析（orchestrator）**—— 两级梯的第二级本来就是它；
     * 没有独立编排的档位（`orchestrator_mode !== 'separate'`）退化用**取基线的那个人**
     * （`baseline.taken_by`，实务上就是计划 AI）。这样 `from_role` 不撒谎：
     * 它一定是本任务里真实存在的那个角色。
     *
     * @param {object} task
     * @param {object} ctx
     * @param {number} ctx.streak
     * @param {number} ctx.threshold
     * @param {object} [ctx.verdict] - 本次闸门判定（越界明细会进审计）
     * @param {object|null} [ctx.baseline]
     * @returns {Promise<{escalated:boolean, reason:string, streak:number, threshold:number, round?:number, request_id?:string, handoff_id?:string, from_role?:string, error?:string}>}
     */
    async escalateHashGate(task, ctx) {
      const threshold = Number.isInteger(ctx?.threshold) ? ctx.threshold : hashGateEscalateAfter
      const streak = Number.isInteger(ctx?.streak)
        ? ctx.streak
        : Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0

      if (threshold <= 0) return { escalated: false, reason: 'threshold_off', streak, threshold }
      if (!shouldEscalateHashGate(task, threshold)) {
        return { escalated: false, reason: hashGateEscalationPending(task) ? 'already_pending' : 'below_threshold', streak, threshold }
      }
      // 只有"开发中"才谈得上这件事：闸门就是在这一站卡的。状态不是它就说明
      // 有人抢在前面动过任务 —— 那就什么都不做，让正常路径去处置。
      if (task.state !== ST.DEVELOPING) return { escalated: false, reason: 'not_developing', streak, threshold }

      const round = (Number.isInteger(task.hash_gate_escalation?.round) ? task.hash_gate_escalation.round : 0) + 1
      /**
       * ★ 由**谁**发起这条人工请求。
       *
       * 优先级（每一步都必须"这个角色真的发得出来 human_request"，否则往后让）：
       *   ① 有独立编排 ⇒ **需求分析**（两级梯的第二级本来就是它）；
       *   ② 没有独立编排 ⇒ **取基线的那个人**（`baseline.taken_by`，实务上就是计划 AI）；
       *   ③ 兜底 ⇒ **计划 AI**。
       *
       * ⚠️ 为什么每一步都要查 `ROLES_CAN_RAISE_HUMAN`：基线是**可以重取**的，
       *    而重取允许"主对话兜底"（见 `pipeline_change_audit` 的 take 权限）。
       *    若照抄 `taken_by='main'`，`canProduceHandoff('main','human_request')` 会直接拒 ——
       *    升级**发不出去**，而且现场只留下一条 `gate:hash_escalate_failed`。
       *    这是本项目反复踩过的同一类坑：**别让一条判据在角落路径上静默失效**。
       *    宁可把 `from_role` 写成计划 AI（审计里 `gate:hash_escalate` 仍写着真实来由：机制触发），
       *    也不要让"连续 N 次不过"这件事没人管。
       */
      const taker = typeof ctx?.baseline?.taken_by === 'string' ? ctx.baseline.taken_by : ''
      const fromRole = task.roster?.orchestrator_mode === 'separate'
        ? ROLE.ORCHESTRATOR
        : ROLES_CAN_RAISE_HUMAN.includes(taker) && taker !== ROLE.HUMAN
          ? taker
          : ROLE.PLANNER
      const q = renderHashGateEscalation({ streak, threshold, round })

      // ⚠️ 记下"发之前的条数"：升级失败时要把可能落下的半截记录摘干净。
      //   （`submitHandoff` 在写 human_requests 之后、真迁移失败时会回滚交接物，
      //     但那一条生命周期记录不在它的回滚范围内 —— 别把悬空记录留在盘上。）
      const before = Array.isArray(task.human_requests) ? task.human_requests.length : 0

      const res = await this.submitHandoff({
        taskId: task.id,
        kind: 'human_request',
        actorRole: fromRole,
        actorSeat: null,
        actorAgentId: null,
        // ★ 机制触发（不是角色触发）—— 唯一的凭证，见 checkHumanRequestChannel 的 ⓪
        systemEscalation: true,
        payload: {
          task_id: task.id,
          from_role: fromRole,
          reason_kind: 'hash_gate_escalation',
          question_for_human: q.question,
          context_for_human: q.context,
          options: q.options,
          recommended: '',
          blocking: true,
          blocked_stage: '编写提交（哈希前置闸门）',
          urgency: 'blocking',
          // ★ free_text 而不是 choose_option：选项是**给人参考**的，
          //   但用户怎么答都得能如实记下来（choose_option 会拒掉选项之外的原话）。
          decision_kind: 'free_text',
          // ★ stay_blocked：机制不替用户设默认值，也不会自己按超时往下走。
          timeout_behavior: 'stay_blocked',
          orchestrator_reason:
            `机制自动升级：哈希前置闸门连续 ${streak} 次不通过（阈值 ${threshold}）。` +
            '这不是需求层的歧义 —— 需求分析与编排都答不了"为什么同一份改动反复落在授权范围之外"，所以按两级梯直接交用户。',
        },
      })

      if (res.ok !== true) {
        if (Array.isArray(task.human_requests) && task.human_requests.length > before) {
          task.human_requests.length = before
        }
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'gate:hash_escalate_failed', {
            streak,
            threshold,
            round,
            code: res.code ?? null,
            error: String(res.error ?? '').slice(0, 400),
          }),
        )
        await persist(task)
        return { escalated: false, reason: 'request_denied', streak, threshold, round, error: res.error }
      }

      const entry = Array.isArray(task.human_requests) ? task.human_requests.at(-1) ?? null : null
      task.hash_gate_escalation = {
        round,
        at: nowIso(now()),
        streak,
        threshold,
        request_id: entry?.request_id ?? null,
        handoff_id: res.handoff?.handoff_id ?? null,
        from_role: fromRole,
        /** `null` = **还没了结**（既不再升级，也拒收同一任务的再次提交）。 */
        answered_at: null,
        answer_source: null,
        user_quote: null,
        resumed_to: null,
        reason: 'hash_gate_streak',
      }
      task.history.push(
        await audit(task.id, ROLE.MAIN, 'gate:hash_escalate', {
          round,
          streak,
          threshold,
          request_id: task.hash_gate_escalation.request_id,
          handoff_id: task.hash_gate_escalation.handoff_id,
          from_role: fromRole,
          violations: (ctx?.verdict?.violations ?? []).map((x) => `${x.how}:${x.path}`),
          state: task.state,
          // ★ 一句话说清"为什么现在轮到用户"：阈值是机制数的，不是谁拍的
          why: `连续 ${streak} 次哈希前置闸门不通过（阈值 ${threshold}）`,
        }),
      )
      await persist(task)
      return {
        escalated: true,
        reason: 'escalated',
        streak,
        threshold,
        round,
        request_id: task.hash_gate_escalation.request_id,
        handoff_id: task.hash_gate_escalation.handoff_id,
        from_role: fromRole,
      }
    },

    /**
     * 提交一份结构化交接物。**这是流水线上唯一的"交付"入口。**
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.kind
     * @param {string} input.actorRole
     * @param {object} input.payload
     * @param {string} [input.actorAgentId]
     * @param {boolean} [input.systemEscalation] - **仅供 store 内部**：这是机制触发的自动升级（工具面不给）
     */
    async submitHandoff(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const kind = String(input.kind ?? '')
      const schema = HANDOFF_SCHEMAS[kind]
      if (schema === undefined) {
        return deny('UNKNOWN_HANDOFF', `未知交接物类型「${kind}」；合法值：${Object.keys(HANDOFF_SCHEMAS).join(' / ')}`)
      }

      // --- ① 角色是否有权产出这种交接物 ------------------------------------
      //
      //   ★ 设计目的（防过度工程化：只干自己该干的）：这张表就是**白名单** ——
      //     忘了给某角色加能力 = 少一条能力（会被明确拒绝）；忘了删 = 悄悄多一条能力。
      //     所以"编写不得产出测试结论"这条**不是靠文案**，是靠 writer 的
      //     `handoffKinds` 里压根没有 `test_to_review` / `test_to_dev`。
      if (!canProduceHandoff(input.actorRole, kind)) {
        const allowed = HANDOFF_SCHEMAS[kind].from
        const TEST_PRODUCT_KINDS = ['test_to_review', 'test_to_dev']
        return deny(
          'ROLE_NOT_ALLOWED',
          `角色越权：交接物「${kind}」（${schema.zh}）只能由 ${allowed.map(roleLabel).join(' / ')} 产出，` +
            `当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            (kind === 'review_verdict' && input.actorRole === ROLE.WRITER
              ? '★ 编写角色不能直接提交审核。编写完成后只能产出 dev_to_test（提交测试），由测试通过后再交审核。'
              : '') +
            (TEST_PRODUCT_KINDS.includes(kind) && input.actorRole === ROLE.WRITER
              ? '★ **编写不跑测试**：用例、执行结果、通过证据、失败日志、测试结论全部是 `tester` 的产物。\n' +
                '  一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子 —— 那不是独立验证。\n' +
                '  你要交的是 dev_to_test（补丁 + 变更说明 + 运行命令 + 自测结果 + 已知问题）。'
              : '') +
            (input.actorRole === ROLE.MAIN ? '★ 主对话不产出技术交接物 —— 它只负责派活、路由与关单。' : ''),
        )
      }

      // --- ② payload 字段校验 ----------------------------------------------
      const v = validateHandoff(kind, input.payload)
      if (v.ok !== true) {
        return deny('BAD_HANDOFF', `交接物「${kind}」（${schema.zh}）字段校验不通过：\n- ${v.errors.join('\n- ')}`)
      }

      // --- ④a ★最小改动：审核必须面对"改动面 vs 授权面"的核对结果 -----------
      //
      //   用户要求：「改了清单外的文件要能在**审核阶段**查出来（判据级，不是靠人看）」。
      //   做法：每次 dev_to_test 提交时都会算出 `task.scope_conformance`；
      //   审核提交结论时，如果那个结果是"越界"，这里**直接拒** ——
      //   逼审核先处理它（打回编写 / 走变更），而不是带着越界事实发 OK。
      //
      //   ⚠️ 位置：排在**状态检查之前**。理由：这是"结论本身的性质"，
      //      不该因为任务停在哪一站而看不到它（否则"跳步"会先把它盖住）。
      if (kind === 'review_verdict') {
        const conf = task.scope_conformance ?? null
        if (conf !== null && conf.within_scope === false) {
          return deny(
            'SCOPE_CONFORMANCE_FAILED',
            `拒绝审核结论：本次任务的**改动面超出了授权面**，审核不能带着这个事实出结论。\n` +
              `越界的路径：${(conf.out_of_scope ?? []).join('、') || '(见 scope_conformance)'}\n` +
              '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
              '两条路：① pipeline_rework 打回编写（让它撤回越界改动，或改回授权范围内）；' +
              '② 让计划 AI 重出计划、把新范围补进 change_scope，拿到新授权再交。\n' +
              '（这条判据是**自动**的：审核不需要自己逐个文件去比对。）',
          )
        }
      }

      // --- ④a2 ★前后版本对比：审核必须交"改动基线对照结论" -------------------
      //
      //   用户原话：「审核 ai 确认没有干不该干的事（**前后版本对比**）」+ 
      //   「这份对照结论要进审核的**交接物**（判据式证据，不是一句"我看了没问题"）」。
      //
      //   两道：
      //     ① 任务**有基线**时，`change_audit` 必填（L0 没有计划站 ⇒ 没有基线 ⇒ 不适用）；
      //     ② store **自己再算一遍**（`changeAudit`），与审核交的 `verdict` / `baseline_id` 核对 ——
      //        防"抄一份好看的结论"。审核不需要自己逐个文件比，它拿工具跑一遍即可。
      if (kind === 'review_verdict' && this.currentBaseline(task) !== null) {
        const audit = v.normalized.change_audit
        if (audit === null || typeof audit !== 'object' || Array.isArray(audit)) {
          return deny(
            'MISSING_CHANGE_AUDIT',
            `拒绝审核结论：本次任务**有改动基线**，所以必须交「前后版本对比结论」（change_audit）。\n` +
              `基线：${this.currentBaseline(task).baseline_id}（记录于 ${this.currentBaseline(task).taken_at}，${this.currentBaseline(task).file_count} 个文件）\n` +
              '★ 审核不能只说"我看了没问题"：要拿 `pipeline_change_audit` 跑一遍，把对照结论交上来 ——\n' +
              '  多改（清单外被改/被新增）、少改（该改的没改）、改错地方，三种都要有结论。\n' +
              '  （你不用逐个文件去比：那个工具按基线哈希比对，判据级出结论。）',
          )
        }
        const mine = await this.changeAudit({ taskId: task.id })
        if (mine.ok !== true) return mine
        if (String(audit.baseline_id ?? '') !== mine.baseline.baseline_id) {
          return deny(
            'CHANGE_AUDIT_STALE',
            `拒绝审核结论：change_audit.baseline_id=「${audit.baseline_id ?? '(缺失)'}」与当前基线「${mine.baseline.baseline_id}」不一致。\n` +
              '★ 基线换了就得重跑对比 —— 拿旧基线的结论去审新状态，等于没审。\n' +
              '下一步：重跑 pipeline_change_audit 拿到当前结论。',
          )
        }
        if (audit.verdict !== mine.verdict) {
          return deny(
            'CHANGE_AUDIT_MISMATCH',
            `拒绝审核结论：change_audit.verdict=「${audit.verdict ?? '(缺失)'}」，` +
              `但按基线实测是「${mine.verdict}」。\n` +
              (mine.unauthorized.length > 0
                ? `实测**有多改**（清单外的改动 ${mine.unauthorized.length} 处）：\n${mine.unauthorized.slice(0, 8).map((x) => `  · ${x.how}：${x.path}`).join('\n')}\n`
                : '') +
              '★ 这一条是**复核**，不是让你抄：store 会自己按基线再算一遍，结论对不上就拒。\n' +
              '下一步：重跑 pipeline_change_audit 并如实填写；真有多改就走 pipeline_rework 打回编写。',
          )
        }
        if (mine.verdict === 'out_of_scope' && v.normalized.conclusion === 'OK') {
          return deny(
            'CHANGE_OUT_OF_SCOPE_OK',
            `拒绝：**实测有多改**（${mine.unauthorized.length} 处清单外的改动），但审核结论是 OK。\n` +
              mine.unauthorized.slice(0, 8).map((x) => `  · ${x.how}：${x.path}`).join('\n') +
              '\n★ 用户要求是"审核确认没有干不该干的事" —— 有多改就不能发 OK。\n' +
              '下一步：pipeline_rework 打回编写（撤回越界改动），或让计划 AI 把新范围补进 change_scope 后重交。',
          )
        }
      }

      // --- ③a ★闸门已升级：用户还没答复之前，**拒收**同一任务的再次提交 -----
      //
      //   用户拍板（P13）：「升级发生后，**不许**继续接受同一任务的无限重交」。
      //
      //   为什么这条要单独写、而不是靠状态机顺手拦下：升级之后任务停在
      //   「等待人工答复」，`dev_to_test` 本来也推不动 —— 但那句拒绝是
      //   `HANDOFF_STEP_SKIPPED`（"跳步"），读起来像"你顺序搞错了"；
      //   而事实是"机制已经把这件事交给人了，你在等人回话"。两句话对应两种处置，
      //   所以这里给一个**专门的**拒绝码与文案。机制不是提醒，这里就是拒收。
      //
      //   位置：排在状态预检（③）**之前** —— 否则会被"跳步"先盖住，用户看到的就是错的理由。
      if (kind === 'dev_to_test' && hashGateEscalationPending(task)) {
        const esc = task.hash_gate_escalation
        return deny(
          'HASH_GATE_ESCALATED',
          `拒绝提交（HASH_GATE_ESCALATED）：本任务的**哈希前置闸门已经连续 ${esc.streak ?? '?'} 次不通过**，` +
            `机制已按规则把这件事**交人工**（阈值 ${esc.threshold ?? hashGateEscalateAfter} 次），` +
            '在用户答复之前**不再接受同一任务的提交**。\n' +
            `任务当前状态：${STATE_LABEL[task.state]}(${task.state})　人工请求：${esc.request_id ?? '(见 task.human_requests)'}（第 ${esc.round ?? 1} 次升级，${esc.at ?? ''} 发起）\n` +
            '★ 这一条是**拒收**，不是提醒：闸门不通过不消耗打回预算，等于"编写可以无限重交" ——\n' +
            '  那个副作用就堵在这里（连续 N 次不过 ⇒ 把人请回来，且在他回话前不收新提交）。\n' +
            '★ 你的改动本身没有被否定：撤回越界改动/补齐改动声明这些活照样可以先做，\n' +
            '  只是**提交**要等用户答复之后（答复会让状态回到「开发中」，计数重新从零开始）。\n' +
            '下一步：等主对话把这条请求转告用户并拿到答复（pipeline_human_relay → pipeline_human_reply）。\n' +
            '  主对话可查：pipeline_status（human_requests 那一栏列出了待答复的人工请求）。',
        )
      }

      /**
       * ★★ **哈希前置闸门覆盖新站点**（T-20261011-56a37e）。
       *
       * 安全预审整改项 L5/L8 要求「哈希前置闸门**覆盖新站点**」。
       * 新站点里唯一与"改动面合法性"有关的动作是第③④道的**站点确认** ——
       * 它们是"我确认这份产物没问题"的书面动作，而闸门一旦已经判定改动面不合法
       * （连续不通过到阈值 ⇒ 已交人工），**任何人都不许替它背书**：
       * 那时连测试都不许跑，更不许主管/需求位盖章。
       *
       * ★ 与上面那条（`dev_to_test` 拒收）判的是**同一个事实**（`hash_gate_escalation`），
       *   只是执法点从"编写重交"扩到"别人替它确认" —— 这是**扩展**，不是新机制；
       *   既有那条一个字没动。
       */
      if (kind === 'station_confirm' && hubEnabled(task) && hashGateEscalationPending(task)) {
        const esc = task.hash_gate_escalation
        return deny(
          'HASH_GATE_ESCALATED',
          `拒绝提交站点确认：本任务的**哈希前置闸门已经连续 ${esc.streak ?? '?'} 次不通过**（阈值 ${esc.threshold ?? hashGateEscalateAfter} 次），` +
            '机制已按规则把这件事**交人工**。\n' +
            `任务当前状态：${STATE_LABEL[task.state]}(${task.state})　人工请求：${esc.request_id ?? '(见 task.human_requests)'}\n` +
            '★ 哈希前置闸门排在**一切测试与一切确认之前**：改动面本身不合法时，' +
            '  谁都不许替它盖章（连测试都没被触发）。\n' +
            '  用户原话：「哈希对比不过全量测试直接打回」+「不许"先跑一下看看"」。\n' +
            '下一步：等用户答复（答复会让状态回到「开发中」，计数从零开始），再让编写重交 dev_to_test。',
        )
      }

      // --- ③ 状态是否允许 --------------------------------------------------
      const stateCheck = this.checkHandoffAgainstState(task, kind)
      if (stateCheck.ok !== true) return stateCheck

      /**
       * ★★ **站点否掉的预算前置**（T-20261011-56a37e 补齐）。
       *
       * 为什么否掉记录也要在这里挡一道：否掉是"**一份记录 + 一条回边**"两步
       * （与站点确认"先交记录、再放行"同形）。如果只在回边那一步判预算，
       * 预算用尽时记录**已经落盘**了 —— 而否掉记录会作废此前的全部确认
       * （`lastReworkIndex` 的"否掉即作废"），于是一次**被拒**的动作
       * 却改掉了后续的判定结果。所以判定必须**提前到提交这一步**：
       * 预算用尽 ⇒ 记录根本交不上来，盘上不会留下半截状态。
       *
       * ★ 判据体**只有一个**（`checkPrecondition` 的 `hub_station_reject_budget`），
       *   这里与回边那一步调的是同一个 —— 不会出现"两道判得不一样"。
       */
      if (kind === 'station_confirm' && hubEnabled(task) && v.normalized?.decision === 'ng') {
        const chk = await this.checkPrecondition(task, 'hub_station_reject_budget', { station: String(v.normalized?.station ?? '') })
        if (chk.ok !== true) return chk
      }

      // --- ④ 版本一致性 ----------------------------------------------------
      if (kind === 'test_to_review' || kind === 'test_to_dev' || kind === 'review_verdict') {
        const version = currentArtifactVersion(task)
        if (version !== null && v.normalized.artifact_version !== version) {
          return deny(
            'VERSION_MISMATCH',
            `交接物里的 artifact_version=${v.normalized.artifact_version} 与当前有效制品 ${version} 不一致。` +
              `制品已更新或被换过，请基于当前版本操作（制品版本化就是为了防这个）。`,
          )
        }
      }

      // --- ④b ★席位归属校验（dev_to_test）----------------------------------
      //
      // 提交的席位必须**在册**，且调用方令牌的席位要和提交的席位一致。
      // 这条挡的是"拿 writer#1 的令牌去交 writer#2 的分区"。
      if (kind === 'dev_to_test') {
        const seatCheck = this.checkSeatOwnership(task, v.normalized, input)
        if (seatCheck.ok !== true) return seatCheck
        // 补上席位元数据（单席位没给 partition 时按 writer#1 补全 —— 保持与旧行为等价）
        v.normalized.partition = seatCheck.partition
      }

      // --- ④b0 ★最小改动：实际改动面必须落在**授权改动面**内 -----------------
      //
      //   「改动面必须与授权面相等」—— 多改一行也算越界。
      //   判据在这里（而不是在 handoff.js 的 schema 里）是因为要读**计划**里的
      //   `change_scope`，那是任务级数据。
      //
      //   ⚠️ 只有"有计划"的任务才执法：L0 没有计划这一站（规则引擎自批），
      //      所以 L0 任务不存在授权面，这里弃权并留痕（见 README「待确认项」P4）。
      /** ★ 本次提交的改动面核对结果（要落进任务里，供测试/审核/状态查询读）。 */
      let scopeAudit = null
      if (kind === 'dev_to_test') {
        const scope = task.change_scope ?? null
        if (Array.isArray(scope) && scope.length > 0) {
          const manifest = Array.isArray(v.normalized.change_manifest) ? v.normalized.change_manifest : null
          if (manifest === null || manifest.length === 0) {
            return deny(
              'MISSING_CHANGE_MANIFEST',
              `拒绝提交：本次任务**有授权改动面**，所以 dev_to_test 必须带上「实际改动面」\n` +
                `（change_manifest: [{ path, action, scope_id, lines?, note? }]）。\n` +
                '★ 规矩是**改动面必须与授权面相等** —— 测试与审核要按这个面逐条核对，\n' +
                '  "我只改了三行"必须是**可验证的声明**，不是形容词。\n' +
                `本次授权面（计划里给的）：\n${scope.map((e) => `  · ${e.id} ${e.action} ${e.path}`).join('\n')}`,
            )
          }
          const chk = checkManifestAgainstScope(manifest, scope, {
            scopeRel: (p) => scopeRelOf(p, task),
            // ★ 修 ③：把"授权条目"和"改动声明"都归一到**同一个坐标系的绝对键**再比 ——
            //   授权面写成绝对路径（源码树那两条）时，声明这边不再只剩"逐字节写对"一条路。
            absOf: (p) => scopeAbsKey(p, task),
          })
          if (chk.ok !== true) {
            return deny(
              'CHANGE_OUT_OF_SCOPE',
              `拒绝提交：**改动面超出了授权面**。\n- ${chk.errors.join('\n- ')}\n` +
                `\n本次授权面（计划里给的）：\n${scope.map((e) => `  · ${e.id} ${e.action} ${e.path}（${e.why}）`).join('\n')}\n` +
                (chk.outOfScope.length > 0 ? `\n越界的路径：${chk.outOfScope.join('、')}\n` : '') +
                '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
                '  真需要扩大范围（例如 bug 根因在别的模块）→ **不许自作主张扩**：\n' +
                '  走澄清/变更 —— pipeline_clarify_request 升给需求分析，或 pipeline_roster_request 让计划 AI 重出计划，\n' +
                '  拿到新授权（新的 change_scope）之后再动。',
            )
          }
          scopeAudit = chk
        } else {
          scopeAudit = null
        }
      }

      // --- ④b1 ★**哈希前置闸门**：排在一切测试之前 -------------------------
      //
      //   用户原话：「**先过哈希对比，哈希对比不过全量测试直接打回**」。
      //
      //   位置：**在 ④b0（形状核对）之后、任何测试之前**。不通过时：
      //     · dev_to_test **本身被拒** ⇒ 任务停在"开发中"，**没有进入测试**；
      //     · 不消耗测试预算（连测试角色都还没被唤起）；
      //     · 更谈不上"是否跑全量"那条审批链。
      //   设计意图：**不合格的提交不该消耗测试资源** —— 这是省时间省 token 的第一道闸。
      //
      //   ⚠️ 只有"有计划 ⇒ 有基线"的任务才执法；L0 没有基线 ⇒ 弃权（与 P4 同源）。
      //
      //   ★ 本轮新增（用户拍板 P13）：
      //     · 闸门不通过**不消耗** `maxReworkPerLeg`（保持现状）——
      //       任务从未离开 `developing`，"打回"严格说没发生（提交本身不成立），
      //       而那笔预算是为"真的来回拉锯过"设的。这一段**一个字都没动**（回归用例盯着它）。
      //     · 但"编写可以无限重交"这个副作用要堵 ⇒ **连续 N 次不过 ⇒ 自动交人工**。
      //       连续的定义与归零点见 `lib/hashgate.js` 的 `nextHashGateStreak`。
      if (kind === 'dev_to_test') {
        const baseline = this.currentBaseline(task)
        if (baseline !== null) {
          const auditRes = await this.changeAudit({ taskId: task.id })
          if (auditRes.ok === true) {
            const manifest = Array.isArray(v.normalized.change_manifest) ? v.normalized.change_manifest : []
            // ★★ **席位级写入台账（选项 B）**：**先记账，再判定** —— 顺序是硬要求：
            //    · 本单这一笔必须留下（别单的判定要读得到它）；
            //    · 判定也要读得到**别单**已经留下的账（P2-13 就是被"不知道谁改的"绊住的）。
            //    记的是"这一席这次交出的路径 + 它们**此刻**的内容哈希"（只追加，永不覆盖）。
            const ledgerWrite = await this.recordSeatWrites({
              task,
              role: input.actorRole,
              seat: v.normalized.partition?.seat ?? null,
              agentId: input.actorAgentId ?? null,
              baselineId: auditRes.baseline.baseline_id,
              submissionSeq: task.handoffs.length,
              manifest,
              audit: auditRes,
            })
            const ledgerRead = await this.loadSeatWriteLedger()
            // ★ 台账写失败**不拦提交**（它是判据的辅助证据，不是判据本身）——
            //   但**不静默**：失败要留一行审计，别让"这次没有归属证据"变成看不见的事。
            if (ledgerWrite.ok !== true) {
              task.history.push(
                await audit(task.id, input.actorRole, 'ledger:seat-write-failed', {
                  error: ledgerWrite.error,
                  paths: ledgerWrite.entries,
                  why: '席位级写入台账写失败 —— 本次判定退回严格那一支（没有归属证据 ⇒ 照旧拒），且别单将读不到这一笔。',
                }),
              )
            }
            // ★ 修 ③：`touched` 是**相对项目根**的基线键，而编写可能按授权面的写法
            //   在声明里填**绝对路径** —— 两条字符串直接比，"实际动过"永远盖不住"声明"
            //   ⇒ 每一处都被判"声明不实"。这里把两侧归一到同一个坐标系（绝对键）。
            const verdict = hashGateVerdict(auditRes, manifest, {
              absOfDeclared: (p) => scopeAbsKey(p, task),
              absOfTouched: (p) => baselineAbsKey(p),
              // ★★ 归属判据的两样输入：台账全部行 + 本单是谁（"只有别的单能豁免本单"由判据侧执法）
              writeLedger: ledgerRead.entries,
              writeLedgerTaskId: task.id,
            })
            // ★ 连续不过计数：**只有"闸门真过了"才归零**（撤回不归零，理由见 hashgate.js）
            const streak = nextHashGateStreak(task.hash_gate_streak, verdict.pass)
            task.hash_gate_streak = streak
            task.hash_gate_checks = task.hash_gate_checks ?? []
            task.hash_gate_checks.push({
              at: nowIso(now()),
              by: input.actorRole,
              seat: v.normalized.partition?.seat ?? null,
              handoff_kind: kind,
              baseline_id: auditRes.baseline.baseline_id,
              pass: verdict.pass,
              // ★ 每一次失败/通过都带上"这是连续第几次" —— 审计要能一眼看出趋势
              streak,
              threshold: hashGateEscalateAfter,
              counts: verdict.counts,
              violations: verdict.violations,
              added: auditRes.added.map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
              modified: auditRes.modified.map((x) => ({ path: x.path, sha256: x.sha256 ?? null, baseline_sha256: x.baseline_sha256 ?? null })),
              removed: auditRes.removed.map((x) => ({ path: x.path, baseline_sha256: x.baseline_sha256 ?? null })),
              /** ★★ 归属判据这一轮**看见了什么**（谁被归属给了谁 —— 与 violations 同级可核）。 */
              attributed_foreign: verdict.attributed_foreign,
              withdrawn_machine_artifacts: verdict.withdrawn_machine_artifacts,
              /** ★ 台账这一轮的读写情况（"没有归属证据"必须是看得见的事实，不是静默）。 */
              write_ledger: {
                written: ledgerWrite.written,
                write_error: ledgerWrite.error,
                entries_read: ledgerRead.entries.length,
                files_read: ledgerRead.files,
                damaged_lines: ledgerRead.damaged,
                list_error: ledgerRead.list_error,
              },
            })
            task.history.push(
              await audit(task.id, input.actorRole, 'gate:hash', {
                baseline_id: auditRes.baseline.baseline_id,
                pass: verdict.pass,
                streak,
                threshold: hashGateEscalateAfter,
                counts: verdict.counts,
                violations: verdict.violations.map((x) => `${x.how}:${x.path}`),
                attributed_foreign: verdict.attributed_foreign.map((x) => `${x.path}→${x.attributed_to.task_id}`),
                write_ledger: {
                  written: ledgerWrite.written,
                  write_error: ledgerWrite.error,
                  entries_read: ledgerRead.entries.length,
                  damaged_lines: ledgerRead.damaged,
                },
                agent: input.actorAgentId,
              }),
            )
            task.hash_gate = {
              blocked: verdict.pass !== true,
              at: nowIso(now()),
              baseline_id: auditRes.baseline.baseline_id,
              counts: verdict.counts,
              violations: verdict.violations.map((x) => ({ how: x.how, path: x.path })),
              streak,
              threshold: hashGateEscalateAfter,
            }
            await persist(task)
            if (verdict.pass !== true) {
              // ★★ 连续 N 次不过 ⇒ **自动交人工**（走既有的 human_request / 两级梯）
              //    在返回拒绝之前做 —— 因为"已经交人工"这件事必须体现在这次拒绝的文案里
              //    （否则编写会以为"再交一次就好"）。
              const escalation = await this.escalateHashGate(task, {
                streak,
                threshold: hashGateEscalateAfter,
                verdict,
                baseline,
              })
              // ★ 把 task 一起带出去：工具层要拿它刷新**同步索引**，
              //   否则守门看不到 hash_gate.blocked（"闸门没过不许跑测试"会静默失效）。
              return deny(
                'HASH_GATE_FAILED',
                renderGateRejection({ verdict, audit: auditRes, scope: task.change_scope ?? [], baseline, streak, threshold: hashGateEscalateAfter, escalation }),
                { task },
              )
            }
          }
        }
      }

      // --- ④b2 ★两级升级梯：跳级闸 + 防踢皮球闸 ----------------------------
      if (kind === 'clarification_request') {
        const pp = this.checkClarificationPingPong(task, v.normalized)
        if (pp.ok !== true) return pp
      }
      if (kind === 'human_request') {
        const ch = await this.checkHumanRequestChannel(task, v.normalized, input.actorRole, {
          // ★ 只有机制自己（哈希闸门连续不通过）能置这个标记；
          //   工具面拿不到它 —— `pipeline_handoff` 调 submitHandoff 时压根不传这个键。
          systemEscalation: input.systemEscalation === true,
        })
        if (ch.ok !== true) return ch
        // 升级来源要落到记录上（审计里一眼能看出这条 human_request 是从哪升上来的）
        if (ch.escalated !== undefined && ch.escalated !== null) {
          v.normalized.escalated_from = ch.escalated.handoff_id
          v.normalized.raised_by = ch.escalated.from_role
        }
      }

      // --- ④b3 ★计划缺失回流：把它接到**既有**的第一级澄清梯上 ----------------
      //
      //   为什么这么做：用户明确要求"沿用现有两级梯，不要另起一套并行机制"。
      //   计划自检发现缺口时，planner 交的那份 plan 里已经带着
      //   gap_stage / gap_question / gap_context —— 那就是一份**澄清请求**的内容。
      //   于是这里按同一份 `createClarificationEntry` 建记录（from_role=planner），
      //   后面的裁定（pipeline_clarify_reply）、升级（human_request + escalated_from）、
      //   单向门、防踢皮球、恢复语义**全部照旧生效**，一行新机制都不用加。
      //
      //   ⚠️ 顺序说明：这一步必须**早于** ⑤ 的状态预检 —— 回流那条边的前置判据
      //   （plan_gap_gate）就是靠"这条澄清记录存在"来判的。而真正的 plan 交接物
      //   要到 ⑤ 之后才落盘，所以这里先用一个占位 id 建记录，落盘后回填真 id。
      let planGapEntry = null
      if (kind === 'plan' && v.normalized.self_check?.verdict === 'gaps') {
        planGapEntry = this.createClarificationEntry(
          task,
          { handoff_id: `PLAN-PENDING-${shortHash(`${task.id}|${task.handoffs.length}|${String(v.normalized.gap_question ?? '')}`)}` },
          {
            from_role: ROLE.PLANNER,
            stage: v.normalized.gap_stage,
            question: v.normalized.gap_question,
            context_digest: v.normalized.gap_context,
            options: [],
            blocking: true,
            urgency: v.normalized.gap_urgency ?? 'blocking',
          },
        )
      }

      // --- ④c ★架构图回执校验（要读磁盘，所以放在 store 层）------------------
      if (kind === 'architecture_diagram') {
        const dg = await this.checkDiagramDelivery(task, v.normalized)
        if (dg.ok !== true) return dg
        v.normalized.diagram_path = dg.diagramPath
        if (dg.receiptPath !== null) v.normalized.receipt_path = dg.receiptPath
      }

      // --- ⑤ 交接物与状态推进合一 ------------------------------------------
      //
      // 先**预检**这一步会导致的状态迁移（角色权限、合法边、打回预算），
      // 再写交接物，最后真正迁移。预检失败就一个字节都不写 ——
      // 不会留下"有交接物但状态没动"的半截现场。
      const advance = hubEnabled(task)
        ? (planAdvance(kind, v.normalized) ?? hubAdvanceFor(kind, v.normalized))
        : planAdvance(kind, v.normalized)
      if (advance !== null) {
        const tr = applyTransition(task.state, advance.event, input.actorRole, task.previous_state ?? undefined)
        if (tr.ok !== true) {
          return deny(
            'BAD_TRANSITION',
            `交接物「${kind}」不能推动任务 ${task.id} 的状态：${tr.error}\n` +
              (kind === 'dev_to_test' && task.state === ST.DEVELOPING
                ? ''
                : '（交接物未写入。）'),
          )
        }
        // ★ 目标状态与当前状态相同 → 不做这次迁移。
        //   为什么需要这条：`human_request` 的边是 `from:'*'`（任何非终态都能提问）。
        //   若任务已经在「等待人工答复」而另一个角色又提一个 blocking 请求，
        //   迁移会变成 awaiting_human → awaiting_human，而 `transition()` 会把
        //   `previous_state` 覆盖成 'awaiting_human' —— 之后 `human_reply`
        //   回到 'awaiting_human'，任务**永久卡死**。
        //   规则本身是通用的：**不要迁到你已经待着的那个状态**。
        if (tr.to !== task.state) {
          // 打回类事件要预检预算，避免"写了交接物才发现超限"。
          if (advance.leg !== null) {
            const pre = await this.checkPrecondition(task, 'rework_budget', { leg: advance.leg, event: advance.event })
            if (pre.ok !== true) return pre
          }
        }
      }
      const willAdvance = advance !== null && (() => {
        const tr = applyTransition(task.state, advance.event, input.actorRole, task.previous_state ?? undefined)
        return tr.ok === true && tr.to !== task.state
      })()

      const record = buildHandoffRecord({
        kind,
        taskId: task.id,
        fromRole: input.actorRole,
        toRole: schema.to,
        payload: v.normalized,
        artifactVersion: v.normalized.artifact_version ?? null,
        seq: task.handoffs.length, // ★ 让同一秒内的相同内容也有不同的 id
      })
      // ★★ **登记与落盘同块**（凡"能落交接物"的路径必须同时登记）-----------------
      //
      //   ⚠️ 位置是硬要求，而且**顺序也是硬要求**：登记要建在 `appendHandoff`
      //   **之前**，让"交接物可见"与"登记可见"之间**不存在任何 await 点**。
      //
      //   为什么（这是读侧那条漏路的根治）：`appendHandoff` 是
      //   `task.handoffs.push(record)` 之后才 `await writeJsonAtomic(...)` —— 那个
      //   await 就是一个让出点。只要登记排在它后面，**并发读者就能在这个让出点上
      //   观察到一个半截状态**：`handoffs` 里已经有这份 human_request，而
      //   `human_requests` 里还没有 ⇒ 收件箱答「目前没有人工介入请求」，而
      //   `pipeline_status` 却列得出那份交接物。真单 T-20261012-7b9408 现场就是
      //   这个形状（详见 `cacheStamp` 的注释）。
      //
      //   摆到前面之后：两个数组在**同一个同步块**里各自就位，中间没有让出点 ⇒
      //   读者要么两者都还没看到，要么两者都看到。这是消除竞态，不是缓解。
      //
      //   ⚠️ 反方向（登记已可见、交接物还没落）是**可接受**的：收件箱、转告、答复
      //   读的都是登记本体；`reconcileHumanRequests` 只按交接物补缺、从不删条目。
      //   万一落交接物失败，下面把它撤掉（两条数据源一起落、也一起撤）。
      //
      //   幂等由 `createHumanRequestEntry` 保证（同一个 handoff_id 永不重复登记）。
      let humanRequest = null
      if (kind === 'human_request') {
        humanRequest = this.createHumanRequestEntry(task, record, v.normalized)
      }
      try {
        await this.appendHandoff(task, record)
      } catch (err) {
        if (humanRequest !== null && Array.isArray(task.human_requests)) {
          task.human_requests = task.human_requests.filter((r) => r.handoff_id !== record.handoff_id)
        }
        throw err
      }

      // ★ 计划缺失回流：把占位 id 换成真正的 plan 交接物 id（审计里要对得上）。
      if (planGapEntry !== null) {
        planGapEntry.handoff_id = record.handoff_id
      }

      const entry = await audit(task.id, input.actorRole, `handoff:${kind}`, {
        handoff_id: record.handoff_id,
        artifact_version: record.artifact_version,
        digest: record.content_hash,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // ★ 编写席位：登记本席位的提交。**先登记再判定能不能推进** ——
      //   否则最后一个席位提交时，判据还看不到它自己。
      let seatsNote = ''
      if (kind === 'dev_to_test') {
        const seat = v.normalized.partition?.seat ?? writerSeatsOf(task)[0]
        task.writer_submissions = task.writer_submissions ?? {}
        task.writer_submissions[seat] = {
          handoff_id: record.handoff_id,
          artifact_version: v.normalized.artifact_version ?? null,
          at: nowIso(now()),
        }
        const seats = writerSeatsOf(task)
        const done = seats.filter((s) => task.writer_submissions[s] !== undefined)
        seatsNote =
          seats.length > 1
            ? `\n本席位「${seat}」已交（${done.length}/${seats.length}）。` +
              (done.length < seats.length
                ? `还差：${seats.filter((s) => task.writer_submissions[s] === undefined).join('、')} —— 全部到齐前不会推进到「待测试」。`
                : '全部席位到齐，可以推进了。')
            : ''
        // ★ 最小改动：把改动面核对结果落进任务 —— 测试与审核按它核对，
        //   **判据级，不是靠人看**（`pipeline_status` 会把它原样回显）。
        if (scopeAudit !== null) {
          const prevManifest = (task.scope_conformance?.manifest ?? [])
          task.scope_conformance = {
            checked_at: nowIso(now()),
            within_scope: true,
            out_of_scope: [],
            unused_scope: scopeAudit.unused,
            manifest: [...prevManifest, ...(v.normalized.change_manifest ?? []).map((m) => ({ seat, ...m }))],
            handoff_id: record.handoff_id,
          }
        }
        const sentry = await audit(task.id, input.actorRole, 'seat:submit', {
          seat,
          done: done.length,
          total: seats.length,
          handoff_id: record.handoff_id,
          change_manifest: (v.normalized.change_manifest ?? []).length,
          within_scope: scopeAudit === null ? null : true,
          agent: input.actorAgentId,
        })
        task.history.push(sentry)
        await persist(task)
      }

      // ★ 澄清请求：建一条生命周期记录（提问 → 裁定 →（必要时）升级）。
      //   ★ 本轮起，**计划缺失回流**也走这里：它的记录在 ④b3 已经建好（因为要赶在
      //     状态预检之前），这里只补一条审计 —— 两个入口，同一条记录、同一条链。
      let clarification = null
      if (planGapEntry !== null) {
        const pentry = await audit(task.id, input.actorRole, 'clarify:request', {
          request_id: planGapEntry.request_id,
          handoff_id: record.handoff_id,
          from_role: planGapEntry.from_role,
          stage: planGapEntry.stage,
          question_key: planGapEntry.question_key,
          round: planGapEntry.round,
          blocking: planGapEntry.blocking,
          urgency: planGapEntry.urgency,
          state_at_request: planGapEntry.state_at_request,
          source: 'plan_self_check',
          agent: input.actorAgentId,
        })
        task.history.push(pentry)
        await persist(task)
      }
      if (kind === 'clarification_request') {
        clarification = this.createClarificationEntry(task, record, v.normalized)
        /**
         * ★★ **B3 缺件补丁（2026-10-12 · writer#1）：把"是谁问的"里的「席位」也记下来。**
         *
         * 现场：裁定落地之后 `pipeline_clarify_reply` 拿 `res.request.from_seat` 去唤醒
         * 发起席位（`lib/tools.js` 的 `wakeResumedSeat`），而 `createClarificationEntry`
         * **从来没有写过 `from_seat`** —— 它恒为 undefined，于是 `nudgeSeat` 只按
         * `role` 找派活台账、命中**第一个**同角色记录。
         *
         * 后果（多编写席位时可复现的错投）：「writer#2」提问、裁定却投进了「writer#1」
         * 的会话 —— 真正停手的那个席位仍然卡死，而机制以为已经把它叫醒了。
         *
         * 口径：席位**只从令牌来**（`input.actorSeat`，与 `submitHandoff` 其它分支同一出处）。
         * 不让调用方在 payload 里自报 `from_seat` —— 那是第二个真相源，而"谁问的"必须由凭据决定。
         * 非编写角色没有席位（`actorSeat` 为 null）⇒ 照旧 null，行为不变。
         */
        clarification.from_seat = typeof input.actorSeat === 'string' && input.actorSeat.length > 0 ? input.actorSeat : null
        const centry = await audit(task.id, input.actorRole, 'clarify:request', {
          request_id: clarification.request_id,
          handoff_id: record.handoff_id,
          from_role: clarification.from_role,
          stage: clarification.stage,
          question_key: clarification.question_key,
          round: clarification.round,
          blocking: clarification.blocking,
          urgency: clarification.urgency,
          state_at_request: clarification.state_at_request,
          agent: input.actorAgentId,
        })
        task.history.push(centry)
        await persist(task)
      }

        // ★ 全量测试审批链：四站同一条链（见 lib/testscope.js 的凭据判据）
        if (kind === 'full_test_request') {
          const ft = this.applyFullTestRequest(task, record, v.normalized)
          if (ft.ok !== true) return ft
          task.history.push(await audit(task.id, input.actorRole, 'fulltest:request', {
            approval_id: ft.chain.approval_id,
            what_will_run: ft.chain.request.what_will_run,
            affected_paths: ft.chain.request.affected_paths,
          }))
          await persist(task)
        }
        if (kind === 'full_test_review') {
          const ft = this.applyFullTestReview(task, record, v.normalized, input.actorRole)
          if (ft.ok !== true) return ft
          task.history.push(await audit(task.id, input.actorRole, 'fulltest:review', {
            approval_id: ft.chain.approval_id,
            stage: v.normalized.stage,
            ok: v.normalized.ok === true,
            status: ft.chain.status,
          }))
          await persist(task)
        }

      // ★ 人工介入请求：除了那份**不可变**的交接物，还要建一条**活的**生命周期记录。
      //
      //   两份东西的分工要写清楚，否则以后必然漂移：
      //     · `handoffs/NNN-human_request.json` = 提交时的**原件**（不可变，可审计"当时问了什么"）
      //       ⇒ `pipeline_status` 里那行「[人工介入请求] …」读的就是 `task.handoffs[]`
      //     · `task.human_requests[i]`          = 这条请求的**生命周期**（转告/答复/恢复都记在这里）
      //       ⇒ `pipeline_human_relay`（收件箱）与 `pipeline_human_reply` 读的是这里
      //   它们用 `handoff_id` 对上。
      //
      //   ⚠️ 两条数据源**必须一起落**：写第一份的是 `appendHandoff`（前面已经落盘了），
      //      写第二份的是**紧贴它的那一小段**（`createHumanRequestEntry`，见上方 ★★）。
      //      早先两处是分开的两步、还隔着几百行 ⇒ 中间一中断就留下
      //      「交接物在盘上、登记表空的」半截现场，而推进状态只看 `payload.blocking`，
      //      照样能把任务推成 awaiting_human ⇒ 永久卡死（真单 T-20261011-63633e、
      //      T-20261011-214043、T-20261011-5a871c）。
      //      所以下面再补一道**登记闸**：交接物落地时登记必须同时落上。
      if (kind === 'human_request' && humanRequest !== null) {
        const hentry = await audit(task.id, input.actorRole, 'human:request', {
          request_id: humanRequest.request_id,
          handoff_id: record.handoff_id,
          reason_kind: humanRequest.reason_kind,
          blocking: humanRequest.blocking,
          urgency: humanRequest.urgency,
          decision_kind: humanRequest.decision_kind,
          timeout_behavior: humanRequest.timeout_behavior,
          state_at_request: humanRequest.state_at_request,
          agent: input.actorAgentId,
        })
        task.history.push(hentry)
        await persist(task)

        // ★ **登记闸**：此刻登记表里若没有这条请求（说明上面那一步没能落上），
        //   立刻按交接物补齐并留痕 —— "能进状态、能落交接物"的路径**必须同时登记**。
        await this.enforceHumanRequestRegistration(task, record)

        // ★ 单向门：把上游那条澄清请求标成"已升级"，从此**只能由用户答复解决**。
        if (typeof humanRequest.escalated_from === 'string' && humanRequest.escalated_from.length > 0) {
          const up = (task.clarification_requests ?? []).find((r) => r.handoff_id === humanRequest.escalated_from)
          if (up !== undefined && up.escalated_at === null) {
            up.escalated_at = humanRequest.created_at
            up.escalated_to = humanRequest.request_id
            up.status = 'escalated'
            const eentry = await audit(task.id, input.actorRole, 'clarify:escalate', {
              request_id: up.request_id,
              escalated_to: humanRequest.request_id,
              raised_by: up.from_role,
              orchestrator_reason: v.normalized.orchestrator_reason ?? null,
              agent: input.actorAgentId,
            })
            task.history.push(eentry)
            await persist(task)
          }
        }
      }

      let advanced = null
      // ★ 席位未到齐时：**交接物照收，但先不推进**。
      //
      //   这里是有意为之，不是漏判：一个席位先干完先交，是完全正常的节奏；
      //   如果因为它交得早就把它的活退回去（或拒绝），那才是坏的。
      //   所以：先落盘、先留痕，等最后一个席位到齐时由**它**触发推进。
      let heldForSeats = false
      if (advance !== null && willAdvance && kind === 'dev_to_test') {
        const gate = checkAllSeatsSubmitted(task)
        if (gate.ok !== true) heldForSeats = true
      }

      if (advance !== null && willAdvance && !heldForSeats) {
        const applied = await this.transition({
          taskId: task.id,
          event: advance.event,
          actorRole: input.actorRole,
          actorAgentId: input.actorAgentId,
          note: `由交接物 ${record.handoff_id} 自动推进`,
        })
        if (applied.ok !== true) {
          // 回滚：把刚写的交接物摘掉，保持"要么全成、要么全不成"。
          task.handoffs.pop()
          await this.removeHandoffFile(task, record)
          // ★ 登记也要一起摘掉：否则会留下一条"指着一份已被删掉的交接物"的**悬空登记** ——
          //   收件箱会把它列成待转告，转告时却找不到原件，答复更是无从记回。
          //   与上面那句同源：两条数据源**一起落、也要一起撤**。
          if (humanRequest !== null && Array.isArray(task.human_requests)) {
            task.human_requests = task.human_requests.filter((r) => r.handoff_id !== record.handoff_id)
          }
          // ★ 计划缺失回流那条澄清记录也要一并摘掉 —— 否则会留下一条
          //   "指着一份不存在的计划"的悬空请求（需求分析会去答一个不存在的缺口）。
          if (planGapEntry !== null) {
            task.clarification_requests = (task.clarification_requests ?? []).filter((r) => r.request_id !== planGapEntry.request_id)
          }
          await persist(task)
          return deny('BAD_TRANSITION', `交接物已回滚（状态推进失败）：${applied.error}`)
        }
        advanced = { from: applied.from, to: applied.to }
        if (advance.leg !== null) {
          task.rework[advance.leg] = (task.rework[advance.leg] ?? 0) + 1
          const rentry = await audit(task.id, input.actorRole, `rework:${advance.leg === 'dev' ? 'writer' : 'tester'}`, {
            via: `handoff:${kind}`,
            used: task.rework[advance.leg],
            budget: task.roster?.rework_budget ?? maxRework,
            agent: input.actorAgentId,
          })
          task.history.push(rentry)
          await persist(task)
        }
      }

      return {
        ok: true,
        task,
        handoff: record,
        advanced,
        summary:
          `交接物已提交：${record.handoff_id}（${schema.zh}，${roleLabel(input.actorRole)} → ${schema.to}）。` +
          (advanced === null ? '' : `\n任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。`) +
          seatsNote +
          (heldForSeats ? '\n（席位未到齐：这份交接物已收下并留痕，但状态先不动 —— 等最后一个席位交完自动推进。）' : ''),
      }
    },

    /**
     * ★★ **主管枢纽**下的交接物-状态判据（T-20261011-56a37e）。
     *
     * 它在 `checkHandoffAgainstState` **同一个方法**里、**同一个入口**上被调用 ——
     * 不是第二套判据面，只是"枢纽启用之后这张表长这样"。
     *
     * @returns {object|null} `null` = 本 kind 不受枢纽分支管，交给原表；否则是判定结果
     */
    checkHubHandoffAgainstState(task, kind) {
      const s = task.state
      /**
       * ★ **架构图前置**（用户原话：需求确认后先出架构图 → 主管确认 → 才交计划）。
       *
       * 枢纽任务里，架构图的合法状态面**整体前移**到计划之前；
       * 而**编写完成之后**那几个状态（ready_test 及以后）在本拓扑里**不再**是它该出现的地方
       * —— 这正是"同一张图不再被当成两种东西"的判据。
       */
      if (kind === 'architecture_diagram') {
        if (
          s === ST.ARCH_DRAWING ||
          s === ST.ARCH_CONFIRM ||
          /** ★ P0-1：②b / ②c 两个确认点上，架构图仍然是"当前这一份"，可以再交一次（重画后重交）。 */
          s === ST.ARCH_NEED_CONFIRM ||
          s === ST.ARCH_RECONFIRM
        ) {
          // ★ 与既有 `DIAGRAM_BEFORE_WRITE` **方向相反**的那一条：
          //   枢纽里要的是"**还没有**编写产物"的设计态图 —— 有编写产物说明架构图前置已经失效。
          if (lastHandoff(task, 'dev_to_test') !== null && s === ST.ARCH_DRAWING) {
            return deny(
              'HUB_DIAGRAM_AFTER_WRITE',
              `拒绝：任务 ${task.id} 的**架构图前置站**上已经存在编写产物（dev_to_test）。\n` +
                '★ 用户口径⑦：架构图前置是「**设计**」，安全审查是「准入」，两者不冲突；\n' +
                '  而"编写都做完了才补一张设计态图"说明前置站被跳过了 —— 那张图不是前置图，是补的。\n' +
                '下一步：确认是不是走错了站（编写交付之后的图属于**交付站**，不在枢纽的前置站上）。',
            )
          }
          return { ok: true }
        }
        const need = [ST.ARCH_DRAWING, ST.ARCH_CONFIRM, ST.ARCH_NEED_CONFIRM, ST.ARCH_RECONFIRM]
        return deny(
          'HUB_DIAGRAM_STEP_SKIPPED',
          `跳步（架构图前置）：枢纽任务的架构图只能在 ${need.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')} 提交 —— ` +
            `那是「主管同意需求结论」之后、「主管确认架构图」之前的**前置站**。\n` +
            `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。\n` +
            '★ 用户原话：「需求ai分析将结果提交主管→同意后交给架构ai**先画架构图**→架构图完成后给主管确认是否满足要求→主管确认后**才**交给计划ai」。\n' +
            '  「先画架构图」在表上的形状就是：`analyzing` **没有**直达 `planning` 的边，' +
            '而架构图这一站排在它们中间。',
        )
      }

      /**
       * ★ **待机期不许抢跑**（安全预审阻断项 B3 的第 1 条：交接物面）。
       *   两位待机席位各自的产物：architect → design；planner → plan / orchestration。
       *
       * ★ 另一半是**正例**（B3 明确要求的那条）：**到点唤醒之后，同样的动作必须放行** ——
       *   否则这条判据就不是"待机判据"，而是"把功能一起关掉"。所以下面显式给出
       *   枢纽下的合法状态面，而不是"拦完就完"。
       */
      if (kind === 'design' || kind === 'plan' || kind === 'orchestration') {
        const role = kind === 'design' ? ROLE.ARCHITECT : ROLE.PLANNER
        const blocked = hubStandbyBlocks(task, role)
        if (blocked.ok !== true) {
          return renderStandbyBlock(task, blocked.entry, blocked.wakePoint, `现在交「${kind}」就是**抢跑**`)
        }
        const hubNeed = {
          // 架构位唤醒点 A 之后的两站，加上既有的几个合法站（唤醒是**解锁**，不是换轨）。
          design: [ST.ANALYZING, ST.ARCH_DRAWING, ST.ARCH_CONFIRM, ST.ARCH_NEED_CONFIRM, ST.ARCH_RECONFIRM, ST.STANDBY_PLAN, ST.PLANNING, ST.READY_DEV, ST.DEVELOPING],
          plan: [ST.PLANNING],
          orchestration: [ST.PENDING, ST.PLANNING],
        }[kind]
        if (hubNeed.includes(s)) return { ok: true }
        return deny(
          'HANDOFF_STEP_SKIPPED',
          `跳步（枢纽）：交接物「${kind}」在主管枢纽下只能在这些状态提交 —— ` +
            `${hubNeed.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')}；任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
        )
      }

      /** ★ 架构图重画指令：只在「架构图待主管确认」这一站发得出。 */
      if (kind === 'diagram_rework') {
        if (s !== ST.ARCH_CONFIRM) {
          return deny(
            'HUB_REDRAW_STEP_SKIPPED',
            `跳步：架构图重画指令只能在「${STATE_LABEL[ST.ARCH_CONFIRM]}(${ST.ARCH_CONFIRM})」发出（那时才有"不满足"可判）。` +
              `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
          )
        }
      }

      /** ★ 测试提前知情：预登记必须**早于编写交付**（用户口径③：不许看编写的产物）。 */
      if (kind === 'prebrief') {
        if (s !== ST.PLANNING) {
          return deny(
            'HUB_PREBRIEF_STEP_SKIPPED',
            `跳步：任务内容预登记（prebrief）只能在「${STATE_LABEL[ST.PLANNING]}(${ST.PLANNING})」提交 —— ` +
              `它是**计划位**在出计划时顺手交出去的那一份。任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
          )
        }
        if (lastHandoff(task, 'dev_to_test') !== null) {
          return deny(
            'HUB_PREBRIEF_AFTER_WRITE',
            `拒绝：任务 ${task.id} 里**已经有编写产物**（dev_to_test）了，这时交的"预登记"不是预登记。\n` +
              '★ 用户口径③：「测试提前收到任务内容」= **内容提前交到测试位手里**，而**不许看编写的产物**（保持独立性）。\n' +
              '  在编写交付之后再交，等于把"事后通知"冒充成"提前知情" —— 那正是本单要改掉的现行做法。',
          )
        }
      }
      return null
    },

    /** 删掉一份刚写了又回滚的交接物文件（保持"要么全成要么全不成"）。 */
    async removeHandoffFile(task, record) {
      try {
        const { unlink } = await import('node:fs/promises')
        if (typeof record.file === 'string' && record.file.length > 0) await unlink(record.file)
      } catch {
        /* 回滚失败不该掩盖真正的错误；内存里已经 pop 掉了，状态是自洽的 */
      }
    },

    /** 交接物与当前状态是否匹配（"跳步"的第二道闸）。 */
    checkHandoffAgainstState(task, kind) {
      const s = task.state
      // ★★ 主管枢纽（T-20261011-56a37e）：架构图**前置**之后，各站的合法状态面变了。
      //   ★ 只在**已启用枢纽**的任务上生效 —— 未启用的任务走下面那张原表（一个字节没动）。
      if (hubEnabled(task)) {
        const hub = this.checkHubHandoffAgainstState(task, kind)
        if (hub !== null) return hub
      }
      const need = {
        dev_to_test: [ST.DEVELOPING],
        test_to_review: [ST.TESTING],
        test_to_dev: [ST.TESTING],
        review_verdict: [ST.REVIEWING],
        // ★ 本轮拆分：需求分析结论只在「需求分析中」交；分配结论只在「计划中」交。
        requirement_analysis: [ST.ANALYZING],
        orchestration: [ST.PENDING, ST.PLANNING],
        plan: [ST.PLANNING],
        design: [ST.READY_DEV, ST.DEVELOPING, ST.ANALYZING, ST.READY_PLAN, ST.PLANNING],
        /**
         * ★ 架构图：**编写完成之后**才允许交。
         *
         * 状态下限是「待测试」—— 也就是说"编写还没交（还在开发中）就交图"会被这里拦下。
         * 上面还有一个更硬的判据（必须有 dev_to_test 交接物），两道一起挡"还没写完就交图"。
         */
        architecture_diagram: [ST.READY_TEST, ST.TESTING, ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        // ★ 第一级提问：除终态外任何状态都能问（被卡住的地方哪都有可能）
        clarification_request: Object.values(ST).filter((x) => x !== ST.CLOSED && x !== ST.CANCELLED),
        // ★ 需求分析的裁定：只在「等待需求分析答复」时提交
        clarification_reply: [ST.AWAITING_CLARIFICATION],
        security_review: [ST.READY_REVIEW, ST.REVIEWING, ST.DEVELOPING, ST.READY_TEST, ST.TESTING],
        release_plan: [ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        docs_note: [ST.DEVELOPING, ST.READY_TEST, ST.TESTING, ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        perf_report: [ST.TESTING, ST.READY_REVIEW, ST.REVIEWING],
        arbitration: [ST.RETURNED_TO_DEV, ST.RETURNED_TO_TEST, ST.BLOCKED, ST.TESTING, ST.REVIEWING],
        human_note: Object.values(ST),
      }[kind]
      if (need === undefined || need.includes(s)) {
        // ★ 架构图额外加一条**时机**判据：必须先有编写的产物。
        //   —— 光看状态不够：「待测试」也可能是"被回退回来"的，那时同样没有新产物。
        if (kind === 'architecture_diagram' && lastHandoff(task, 'dev_to_test') === null) {
          return deny(
            'DIAGRAM_BEFORE_WRITE',
            `时序错误：任务 ${task.id} 还没有任何编写产物（没有 dev_to_test 交接物），却要交架构图。\n` +
              '★ 架构图是"写成了什么样"的记录 —— 没有"写成的东西"就没有可画的图。\n' +
              '正确顺序：编写交 dev_to_test → 状态到「待测试」→ 架构图角色交 architecture_diagram。\n' +
              '（本插件刻意不让架构图角色在编写之前动手：那会退化成 architect 的"设计草图"，' +
              '而设计草图是 architect 的活，不是交付物。）',
          )
        }
        return { ok: true }
      }
      return deny(
        'HANDOFF_STEP_SKIPPED',
        `跳步：交接物「${kind}」只能在这些状态下提交 —— ${need.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')}；` +
          `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。\n` +
          (kind === 'review_verdict' && s === ST.DEVELOPING
            ? '★ 编写完成后必须先进「待测试」→「测试中」，测试通过后才进「待审核」。审核不能对着开发中的产物出结论。'
            : '') +
          (kind === 'architecture_diagram' && s === ST.DEVELOPING
            ? '★ 架构图必须在**编写完成之后**交。现在还在「开发中」—— 先让编写交 dev_to_test。'
            : ''),
      )
    },

    /**
     * 打回。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.actorRole
     * @param {'writer'|'tester'} input.target
     * @param {string} input.reason
     * @param {string} [input.actorAgentId]
     */
    async rework(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const target = input.target === 'tester' ? 'tester' : 'writer'
      if (target === 'writer' && ![ROLE.TESTER, ROLE.REVIEWER, ROLE.SECURITY].includes(input.actorRole)) {
        return deny('ROLE_NOT_ALLOWED', `打回编写只能由 测试/审核/安全审计 发起，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      if (target === 'tester' && input.actorRole !== ROLE.REVIEWER) {
        return deny('ROLE_NOT_ALLOWED', `打回测试只能由 审核 发起，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }

      const leg = target === 'writer' ? 'dev' : 'test'
      const budget = task.roster?.rework_budget ?? maxRework
      const used = task.rework[leg] ?? 0
      if (used >= budget) {
        return deny(
          'REWORK_EXHAUSTED',
          `打回次数超限：本任务「${leg === 'dev' ? '打回编写' : '打回测试'}」已用 ${used} 次，上限 ${budget} 次。\n` +
            `按规则不能无限打回。请改用：pipeline_transition event=block（已阻塞）交人工介入，` +
            `或让编排复核后追加仲裁角色（pipeline_roster_request → pipeline_roster_review）。`,
        )
      }

      const event = target === 'writer' ? (input.actorRole === ROLE.TESTER ? 'test_failed' : 'review_ng_dev') : 'review_ng_test'
      const res = await this.transition({ taskId: input.taskId, event, actorRole: input.actorRole, actorAgentId: input.actorAgentId, note: input.reason })
      if (res.ok !== true) return res

      task.rework[leg] = used + 1
      const entry = await audit(task.id, input.actorRole, `rework:${target}`, {
        reason: input.reason,
        used: task.rework[leg],
        budget,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // 打回会作废旧的审核 OK —— 这是"改完代码不能拿旧 OK 关单"的实现。
      return {
        ok: true,
        task,
        target,
        used: task.rework[leg],
        budget,
        summary:
          `已打回${target === 'writer' ? '编写' : '测试'}（第 ${task.rework[leg]}/${budget} 次）。` +
          `任务 ${task.id} 现在处于「${STATE_LABEL[task.state]}」。` +
          (task.rework[leg] >= budget ? ' ⚠ 打回预算已用尽，再打回会被拒绝。' : ''),
      }
    },

    /**
     * 关单。★ 必须存在有效的审核 OK。
     */
    async close(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny('ROLE_NOT_ALLOWED', `只有主对话能关单，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }

      // 守门判据 #1：有效审核 OK。
      const okCheck = await this.checkPrecondition(task, 'review_ok_exists', {})
      if (okCheck.ok !== true) return okCheck

      const tr = await this.transition({ taskId: input.taskId, event: 'close', actorRole: ROLE.MAIN, actorAgentId: input.actorAgentId, note: input.note })
      if (tr.ok !== true) return tr

      const ok = effectiveReviewOk(task)
      task.close_report = {
        closed_at: nowIso(now()),
        closed_by: ROLE.MAIN,
        artifact_version: currentArtifactVersion(task),
        review_ok_handoff: ok?.handoff_id ?? null,
        risk_notes: ok?.payload?.risk_notes ?? [],
        final_delivery_note: ok?.payload?.final_delivery_note ?? '',
        release_approved: ok?.payload?.release_approved === true,
      }
      const entry = await audit(task.id, ROLE.MAIN, 'close', {
        artifact_version: task.close_report.artifact_version,
        review_ok: task.close_report.review_ok_handoff,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      return { ok: true, task, report: task.close_report, summary: `任务 ${task.id} 已关闭。放行依据：${task.close_report.review_ok_handoff}（审核 OK，制品 ${task.close_report.artifact_version}）。` }
    },

    /**
     * 登记一个制品版本（编写角色的动作）。制品版本化 + 可回滚。
     */
    async registerArtifact(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.WRITER) {
        return deny('ROLE_NOT_ALLOWED', `只有编写角色能登记代码制品，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      const content = String(input.content ?? '')
      task.artifact_version_counter += 1
      const version = `v${task.artifact_version_counter}`
      const dir = artifactDir(task.id, version)
      await mkdir(dir, { recursive: true })
      const file = join(dir, input.fileName ?? 'artifact.txt')
      await writeFile(file, content, 'utf8')
      const rec = {
        version,
        file,
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: fullHash(content),
        created_at: nowIso(now()),
        note: typeof input.note === 'string' ? input.note : '',
      }
      task.artifacts.push(rec)
      const entry = await audit(task.id, ROLE.WRITER, 'artifact:register', { version, sha256: rec.sha256, bytes: rec.bytes, agent: input.actorAgentId })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, artifact: rec, summary: `制品已登记：${version}（${rec.bytes} 字节，sha256 ${rec.sha256.slice(0, 16)}…）。` }
    },

    /**
     * 回滚：把某个历史版本的制品重新登记为当前版本（不删旧版本）。
     */
    async rollbackArtifact(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.WRITER && input.actorRole !== ROLE.HUMAN) {
        return deny('ROLE_NOT_ALLOWED', `只有编写角色或人工能回滚制品，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      const src = task.artifacts.find((a) => a.version === input.version)
      if (src === undefined) {
        return deny('NOT_FOUND', `没有制品版本 ${input.version}；已有版本：${task.artifacts.map((a) => a.version).join(', ') || '（无）'}`)
      }
      const content = await readFile(src.file, 'utf8')
      return this.registerArtifact({
        taskId: input.taskId,
        actorRole: ROLE.WRITER,
        content,
        fileName: `${src.version}-rollback.txt`,
        note: `回滚自 ${src.version}`,
        actorAgentId: input.actorAgentId,
      })
    },

    // --- 角色变更申请（编写/测试/审核提出 → 编排复核）-----------------------

    async requestRosterChange(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const allowed = [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHITECT, ROLE.SECURITY, ROLE.RELEASE, ROLE.PERFORMANCE, ROLE.DOCS]
      if (!allowed.includes(input.actorRole)) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有执行角色（${allowed.map(roleLabel).join('/')}）能提角色变更申请，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            (input.actorRole === ROLE.MAIN
              ? '★ 主对话不能自己决定加人减人 —— 增减角色必须走「执行角色申请 → 编排复核」这条路。'
              : ''),
        )
      }
      if (task.roster === null) return deny('NO_ROSTER', `任务 ${task.id} 还没有角色清单，先做计划分配（需求分析 → 用户确认 → pipeline_plan）。`)

      const req = {
        request_id: `RR-${shortHash(`${task.id}|${task.roster_requests.length}|${input.reason}`)}`,
        at: nowIso(now()),
        by: input.actorRole,
        agent: input.actorAgentId ?? null,
        add: toStringArray(input.add),
        remove: toStringArray(input.remove),
        reason: String(input.reason ?? '').trim(),
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        decision_note: '',
      }
      if (req.reason.length === 0) return deny('BAD_ARGUMENT', '角色变更申请必须给 reason（为什么要加/减人）。')
      if (req.add.length === 0 && req.remove.length === 0) return deny('BAD_ARGUMENT', '角色变更申请至少要给 add 或 remove 中的一项。')

      task.roster_requests.push(req)
      const entry = await audit(task.id, input.actorRole, 'roster:request', { request_id: req.request_id, add: req.add, remove: req.remove, reason: req.reason })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, request: req, summary: `角色变更申请已登记：${req.request_id}（+[${req.add.join(',')}] -[${req.remove.join(',')}]）。等待编排复核。` }
    },

    /**
     * 计划 AI 复核。★ 只有计划 AI 能做；复核通过后**由复核动作本身**改写角色清单，
     * 主对话没有任何路径能自己改 roster。
     *
     * ★ 本轮改动：从 `orchestrator` 改成 `planner` —— 角色变更复核**就是分配**
     *   （加人减人 = 改角色清单），而分配权本轮随"拆角色"移给了 planner。
     *   需求分析不掌分配权，所以它**不能**再批这类申请。
     */
    async reviewRosterChange(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.PLANNER) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `角色变更复核只能由**计划 AI**（planner）执行，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '理由：加人减人 = 改角色清单 = 分配 —— 那是计划 AI 的职权。\n' +
            (input.actorRole === ROLE.MAIN ? '★ 主对话不能自己批自己的申请，也不能直接改角色清单。' : '') +
            (input.actorRole === ROLE.ORCHESTRATOR
              ? '★ 需求分析**不掌分配权**（本轮改的）：它只负责把需求讲清楚，增减角色要交计划 AI 判。'
              : ''),
        )
      }
      const req = task.roster_requests.find((r) => r.request_id === input.requestId)
      if (req === undefined) return deny('NOT_FOUND', `找不到角色变更申请 ${input.requestId}。`)
      if (req.status !== 'pending') return deny('ALREADY_REVIEWED', `申请 ${input.requestId} 已经复核过了（${req.status}）。`)

      const approve = input.approve === true
      req.reviewed_by = ROLE.PLANNER
      req.reviewed_at = nowIso(now())
      req.decision_note = String(input.note ?? '').trim()

      if (!approve) {
        req.status = 'rejected'
        await persist(task)
        await audit(task.id, ROLE.PLANNER, 'roster:review', { request_id: req.request_id, decision: 'rejected', note: req.decision_note })
        return { ok: true, task, request: req, applied: false, summary: `角色变更申请 ${req.request_id} 被驳回：${req.decision_note || '（未给理由）'}` }
      }

      // 通过 → 直接重建 roster（新增/移除在本任务上累积）。
      const current = task.roster
      const mergedExtra = [...new Set([...current.execution_roles.filter((r) => !['writer', 'tester', 'reviewer'].includes(r)), ...req.add])]
      const mergedRemove = [...new Set([...req.remove])]
      // ★ 设计目的（职责自限）：**中途加人 = 加一张新边界卡**，那是分配的一部分。
      //   把复核时给的新卡与计划原有的卡合并，一起交给 setRoster 的覆盖性核对。
      const existingCards = Array.isArray(task.role_boundaries) ? task.role_boundaries : []
      const newCards = Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []
      const mergedCards = [...existingCards.filter((b) => !newCards.some((n) => String(n?.role) === String(b?.role))), ...newCards]
      const res = await this.setRoster({
        taskId: task.id,
        tier: current.tier,
        reason: `${current.reason}\n[角色变更 ${req.request_id} 由 ${roleLabel(req.by)} 提出、计划 AI 复核通过] ${req.reason}${req.decision_note ? `；复核意见：${req.decision_note}` : ''}`,
        // ★ L0 没有独立的计划 AI（规则引擎档位），那时用不用 plan 闸 —— 跟着原清单走。
        judgedBy: current.judged_by === 'planner' ? 'planner' : 'rule-engine',
        extraRoles: mergedExtra,
        removeRoles: mergedRemove,
        actorRole: ROLE.PLANNER,
        // ★ 席位方案与继任策略要**原样带过去**：这次改的是角色清单，
        //   顺手把它们清掉会让所有席位的范围凭空消失。
        writers: current.writers,
        relayPolicy: current.relay_policy,
        /** ★ 边界卡：复核时给的新卡 + 计划原有的卡。 */
        roleBoundaries: mergedCards,
        acceptance: task.task_card?.acceptance ?? [],
        testPoints: task.task_card?.test_points ?? [],
        boundaries: task.task_card?.boundaries ?? [],
      })
      if (res.ok !== true) {
        // ★ 没改成清单就不算复核过：把申请**退回 pending**。
        //   为什么必须回滚：批准是"清单已改写"这个事实的记账。
        //   记账先行、改写失败，会留下"申请说批了、清单没动"的半截现场 ——
        //   而那个半截现场没有任何路径能修复（申请已经不是 pending，复核会拒）。
        req.status = 'pending'
        req.reviewed_by = null
        req.reviewed_at = null
        await persist(task)
        return deny(
          'ROSTER_APPLY_FAILED',
          `复核批准**没有生效**（角色清单没被改写，申请已退回 pending）：\n${res.error}\n` +
            '下一步：按上面的原因补齐后重新复核（例如给新角色补一张边界卡）。',
        )
      }
      req.status = 'approved'
      await persist(task)
      return {
        ok: true,
        task,
        request: req,
        applied: true,
        roster: task.roster,
        summary: `角色变更申请 ${req.request_id} 已通过，新清单：${task.roster.execution_roles.join(' / ')}（${task.roster.ai_count} 个独立对话）。`,
      }
    },

    // --- ★授权面变更（amendment）：一条**只动授权面**的窄通道 ----------------
    //
    //   要解决的问题（真单现场）：用户已经在需求层裁定"允许把某样东西纳入授权面"，
    //   但 `pipeline_plan` 只在「计划中」交得进计划 —— 任务一进「待开发」，
    //   就变成 **裁定有了、动作做不了**，一个交付单元整轮走不动。
    //
    //   ★ 修法的形状是**另开一条窄门**，不是把「跳步」那道闸整体放宽：
    //     `checkHandoffAgainstState` 里 `plan: [ST.PLANNING]` 一个字都不动 ——
    //     计划仍然只能在计划那一站交。这里新增的能力**够不到计划**：
    //     它不产交接物、不推状态、更碰不到角色清单。
    //
    //   为什么值得开这道门（而不是"让 planner 就地在 ready_dev 重出计划"）：
    //     重出计划会把 `setRoster` 一起带进来 —— 那是**改席位与档位**。
    //     "补一条授权"和"重新分配一次人力"是两件事，混在一起之后，
    //     一个只想扩一条路径的人就顺手拿到了改档位的权力。

    /**
     * ★ **授权面变更（amendment）** —— 追加 / 撤销 `change_scope` 与 `forbidden`。
     *
     * 三条硬判据，缺一不可：
     *   ① 调用方必须是**计划 AI**：授权面是计划的产物，谁定计划谁改授权面；
     *   ② 任务必须在**「待开发」**：授权面要在"计划已定稿、编写还没开工"那一刻改
     *      （再往后改，就是把已经发生过的越界洗成合规）；
     *   ③ 入参**只许**出现授权面字段（白名单，见 `AMEND_ALLOWED_KEYS`）——
     *      席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字都进不来。
     *
     * 全程留痕：`task.amendments[]`（含变更前后）+ `audit.jsonl` 的 `scope:amend`。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.actorRole
     * @param {string} [input.actorAgentId]
     * @param {string} input.why - **为什么非扩它不可**（必填）
     * @param {object[]} [input.add] - 追加的 `change_scope` 条目
     * @param {string[]} [input.remove] - 要撤销的 `change_scope` id
     * @param {string[]} [input.forbiddenAdd] - 追加的越界清单条目
     * @param {string[]} [input.forbiddenRemove] - 撤销的越界清单条目
     * @param {object} [input.raw] - **原始入参**（白名单就查它）
     */
    async amendScope(input) {
      const fail = (code, message) => deny(code, message)
      const task = await loadTask(input.taskId)
      if (task === null) return fail('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      // ---- ① 谁：只有计划 AI。主对话也不行 —— 它既不掌分配权，也不掌授权面。
      if (input.actorRole !== ROLE.PLANNER) {
        return fail(
          'ROLE_NOT_ALLOWED',
          `授权面变更只能由**计划 AI**（planner）执行，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '理由：授权面（这次允许改哪些文件、不许做什么）是**计划的产物** —— 谁定计划谁改授权面。\n' +
            (input.actorRole === ROLE.MAIN
              ? '★ 主对话不掌分配权，也不掌授权面：它只能按已经定稿的清单派活。'
              : '★ 如果你（执行角色）是被授权面卡住了：把理由交回计划 AI，由它来改 —— 这条门只能它走。'),
        )
      }

      // ---- ② 何时：只在「待开发」。
      if (task.state !== ST.READY_DEV) {
        return fail(
          'AMEND_STATE_NOT_ALLOWED',
          `授权面变更只在**「待开发」(${ST.READY_DEV})**有效；任务 ${task.id} 当前是「${STATE_LABEL[task.state]}(${task.state})」。\n` +
            '为什么只有这一站：授权面必须在**计划已定稿、编写还没开工**的那一刻改 ——\n' +
            '  · 还在「计划中」⇒ 直接重出计划就行（那一站 `pipeline_plan` 本来就收得下新范围）；\n' +
            '  · 已经「开发中」⇒ 编写可能已经动过手，事后扩授权面等于**把越界洗成合规**；\n' +
            '  · 终态（已通过 / 已关闭 / 已取消）⇒ 本轮已经结束，要改就得开新任务。\n' +
            '★ 这条守卫**只属于这条窄通道** —— 计划那道"跳步"闸（`plan` 只在 planning 收）一个字没松。',
        )
      }

      // ---- ③ 只许动授权面：白名单之外的任何入参字段 ⇒ 当场拒。
      const alien = findNonScopeKeys(input.raw)
      if (alien.length > 0) {
        return fail(
          'AMEND_SCOPE_VIOLATION',
          `授权面变更**只许动授权面**（change_scope / forbidden）—— 但这次入参里带了：${alien.join('、')}。\n` +
            '★ 席位、角色清单、档位、调用顺序、层划分都是**分配**：改它们要重出计划，' +
            '或走 pipeline_roster_request（提出）→ pipeline_roster_review（计划 AI 复核）—— 不是这条门。\n' +
            '★ 为什么这条闸这么硬：这条窄门之所以被允许存在，**恰恰因为它改不了那些东西**。\n' +
            '  一旦它能顺带改清单，它就是一条绕过"计划自检 + 用户确认"的分配后门。',
        )
      }

      // ---- ④ 变更本身要有内容、要有理由。
      const why = typeof input.why === 'string' ? input.why.trim() : ''
      if (why.length === 0) {
        return fail(
          'BAD_ARGUMENT',
          '授权面变更必须给 why —— **为什么非扩它不可**。\n' +
            '★ 这一栏与计划里的 change_scope[].why 是同一面照妖镜："顺手扩一点"写不出理由。',
        )
      }
      const add = Array.isArray(input.add) ? input.add : []
      const remove = toStringArray(input.remove)
      const forbiddenAdd = toStringArray(input.forbiddenAdd)
      const forbiddenRemove = toStringArray(input.forbiddenRemove)
      if (add.length === 0 && remove.length === 0 && forbiddenAdd.length === 0 && forbiddenRemove.length === 0) {
        return fail('BAD_ARGUMENT', '授权面变更至少要动一处：add / remove / forbidden_add / forbidden_remove 四选一（或更多）。')
      }

      // ---- ⑤ 先在**副本**上算合并结果，全部通过才落到 task 上 ----------------
      //   为什么不能在 task 上边算边写：`loadTask` 返回的是**缓存里的同一个对象**。
      //   拒之前写进去的半个改动会留在内存里（而落盘没落）—— 下一次读就是脏的，
      //   而"授权面被改过一半"这种半截现场没有任何路径能修复。
      const currentScope = Array.isArray(task.change_scope) ? task.change_scope : []
      const currentForbidden = toStringArray(task.plan_forbidden)

      const removedMissing = remove.filter((id) => !currentScope.some((e) => String(e?.id ?? '') === id))
      if (removedMissing.length > 0) {
        return fail('SCOPE_ENTRY_NOT_FOUND', `要撤销的授权条目在现有授权面里不存在：${removedMissing.join('、')}。`)
      }
      const mergedScope = currentScope.filter((e) => !remove.includes(String(e?.id ?? '')))
      const seenIds = new Set(mergedScope.map((e) => String(e?.id ?? '')))
      for (const raw of add) {
        const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
        if (id.length > 0) {
          if (seenIds.has(id)) return fail('DUPLICATE_SCOPE_ID', `授权面变更里有重复的 id「${id}」—— 它在现有授权面（或本次新增）里已经存在。`)
          seenIds.add(id)
        }
        mergedScope.push(raw)
      }
      // 合并后必须仍然合法且非空 —— 复用**计划那一份**校验器，不另写一套。
      const scopeErrors = validateChangeScope(mergedScope)
      if (scopeErrors.length > 0) {
        return fail('BAD_SCOPE', `变更后的授权面不合法（校验器与计划里那份是同一个）：\n- ${scopeErrors.join('\n- ')}`)
      }
      const mergedForbidden = [
        ...currentForbidden.filter((x) => !forbiddenRemove.includes(x)),
        ...forbiddenAdd.filter((x) => !currentForbidden.includes(x)),
      ]

      // ---- ⑥ 落盘 + 留痕（task.amendments[] 与 audit.jsonl 两处都要有）-------
      if (!Array.isArray(task.amendments)) task.amendments = []
      const amendment = {
        amendment_id: `AM-${shortHash(`${task.id}|${task.amendments.length}|${why}`)}`,
        at: nowIso(now()),
        by: ROLE.PLANNER,
        agent: input.actorAgentId ?? null,
        why,
        note: typeof input.note === 'string' ? input.note.trim() : '',
        state_at_amend: task.state,
        added: add.map((e) => ({ id: e?.id ?? null, path: e?.path ?? null, action: e?.action ?? null })),
        removed: remove,
        forbidden_added: forbiddenAdd,
        forbidden_removed: forbiddenRemove,
        before: { change_scope: currentScope.map((e) => e?.id ?? null), forbidden: currentForbidden },
        after: { change_scope: mergedScope.map((e) => e?.id ?? null), forbidden: mergedForbidden },
      }
      task.change_scope = mergedScope
      task.plan_forbidden = mergedForbidden
      task.amendments.push(amendment)

      const entry = await audit(task.id, ROLE.PLANNER, 'scope:amend', {
        amendment_id: amendment.amendment_id,
        why,
        added: amendment.added,
        removed: amendment.removed,
        forbidden_added: forbiddenAdd,
        forbidden_removed: forbiddenRemove,
        before: amendment.before,
        after: amendment.after,
        agent: input.actorAgentId ?? null,
      })
      task.history.push(entry)
      await persist(task)

      return {
        ok: true,
        task,
        amendment,
        summary: [
          `授权面已变更：${amendment.amendment_id}（第 ${task.amendments.length} 次，计划 AI，${amendment.at}）`,
          `为什么：${why}`,
          '',
          `授权改动面（change_scope）：${currentScope.length} → ${mergedScope.length} 条`,
          ...(add.length === 0 ? [] : add.map((e) => `  + ${e?.id ?? '?'}　${e?.action ?? '?'}　${e?.path ?? '?'}`)),
          ...(remove.length === 0 ? [] : remove.map((id) => `  − ${id}`)),
          `越界清单（forbidden）：${currentForbidden.length} → ${mergedForbidden.length} 条` +
            (forbiddenAdd.length === 0 ? '' : `\n${forbiddenAdd.map((x) => `  + ${x}`).join('\n')}`) +
            (forbiddenRemove.length === 0 ? '' : `\n${forbiddenRemove.map((x) => `  − ${x}`).join('\n')}`),
          '',
          '★ 这条通道**只动授权面**：席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字没动。',
          '★ 计划那道"跳步"闸也没松 —— plan 交接物仍然只能在「计划中」提交。',
          '★ 留痕：task.json 的 amendments[] + audit.jsonl 的 scope:amend；pipeline_status 可见。',
        ].join('\n'),
      }
    },

    // --- ★全量测试审批链（四级：需求分析 → 审核 → 人工 → 计划）----------------
    //
    //   用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
    //   必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
    //   确认人工通过后再提交给计划 ai 安排」。
    //
    //   ★ 与**澄清梯**的分工（写清"回答的是哪个不同的问题"，否则以后必然混）：
    //     · 澄清梯（clarification_*）回答「**需求本身清不清楚**」；
    //     · 这条链（full_test_*）  回答「**这套测试值不值得跑**」—— 成本决策，不改需求。
    //   两者形状相同（提出 → 逐级裁定 → 顶到人工），所以**合流在同一套两级梯机制上**：
    //   人工那一站用的就是既有的 human_request / human_reply，不另起并行机制。

    /** 找当前在办的那条链（最近的 pending）。 */
    fullTestChain(task) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      for (let i = list.length - 1; i >= 0; i--) if (list[i].status === 'pending') return list[i]
      return null
    },

    /** 按 request_id / handoff_id 找链。 */
    findFullTestChain(task, requestId) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const key = String(requestId ?? '')
      return (
        list.find((c) => c.approval_id === key) ??
        list.find((c) => c.request?.handoff_id === key) ??
        list.find((c) => c.request?.request_id === key) ??
        null
      )
    },

    /** ① 测试提出「要跑全量」→ 建一条链。 */
    applyFullTestRequest(task, record, payload) {
      const open = this.fullTestChain(task)
      if (open !== null) {
        return deny(
          'FULL_TEST_ALREADY_PENDING',
          `已经有一条**在办**的全量测试申请（${open.approval_id}，下一站：${nextFullTestStage(open)}）。\n` +
            '★ 不许并行开第二条 —— 一条链走完（批准或否决）才能再提。\n' +
            `  · 看进度：pipeline_full_test action=status\n` +
            `  · 撤回：让测试角色把这条链走完（任一站的裁定都能让它结案）`,
        )
      }
      const round = (Array.isArray(task.full_test_approvals) ? task.full_test_approvals.length : 0) + 1
      const chain = {
        approval_id: `FTA-${shortHash(`${task.id}|${round}|${payload.what_will_run}`)}`,
        round,
        created_at: nowIso(now()),
        created_by: ROLE.TESTER,
        status: 'pending',
        rejected_at_stage: null,
        reject_reason: '',
        request: {
          handoff_id: record.handoff_id,
          request_id: record.handoff_id,
          affected_paths: toStringArray(payload.affected_paths),
          targeted_already_run: toStringArray(payload.targeted_already_run),
          why_targeted_insufficient: String(payload.why_targeted_insufficient ?? ''),
          what_will_run: String(payload.what_will_run ?? ''),
          estimated_cost: String(payload.estimated_cost ?? ''),
        },
        need: null,
        worth: null,
        human: null,
        arranged: null,
      }
      task.full_test_approvals = task.full_test_approvals ?? []
      task.full_test_approvals.push(chain)
      return { ok: true, chain }
    },

    /** ②③④ 三站裁定（顺序由这里判，不靠自觉）。 */
    applyFullTestReview(task, record, payload, actorRole) {
      const chain = this.findFullTestChain(task, payload.request_id)
      if (chain === null) {
        return deny(
          'FULL_TEST_REQUEST_NOT_FOUND',
          `找不到申请「${payload.request_id}」—— 全量测试的每一站裁定都必须回给一条**存在**的 full_test_request。\n` +
            `当前任务的链：${(task.full_test_approvals ?? []).map((c) => `${c.approval_id}(${c.status})`).join('、') || '（一条都没有）'}`,
        )
      }
      if (chain.status !== 'pending') {
        return deny(
          'FULL_TEST_CHAIN_CLOSED',
          `申请 ${chain.approval_id} 已经结案（${chain.status}${chain.rejected_at_stage === null ? '' : `，停在 ${chain.rejected_at_stage} 站`}）。\n` +
            '★ 结案的链不能再往上加裁定：要么让测试重新提一条，要么按结论执行。',
        )
      }
      const stage = String(payload.stage ?? '')
      const expected = actorRole === ROLE.ORCHESTRATOR ? 'need' : actorRole === ROLE.REVIEWER ? 'worth' : actorRole === ROLE.PLANNER ? 'arrange' : ''
      if (expected === '' || expected !== stage) {
        return deny(
          'FULL_TEST_STAGE_MISMATCH',
          `这一站不该由「${roleLabel(actorRole)}」来判，或者 stage 写错了。\n` +
            `  · 需求分析 → stage=need（这次**是否真的需要**）\n` +
            `  · 审核     → stage=worth（**值不值得**跑）\n` +
            `  · 计划     → stage=arrange（**怎么跑**、范围与最终命令）\n` +
            `你交的是 stage=${stage || '(空)'}。★ 顺序不能换、不能跳 —— 那是这条链的意义。`,
        )
      }
      // ★ 顺序：need → worth → arrange，缺一级都不许往下走
      if (stage === 'worth' && (chain.need === null || chain.need.ok !== true)) {
        return deny(
          'FULL_TEST_STAGE_OUT_OF_ORDER',
          '顺序不对：审核那一站（worth）必须在**需求分析先认可**之后。\n' +
            (chain.need === null ? '  · 需求分析还没裁定（need 为空）\n' : `  · 需求分析裁定是 ok=${chain.need.ok}\n`) +
            '★ 缺一级都不许开跑 —— 这条链的顺序本身就是判据。',
        )
      }
      if (stage === 'arrange') {
        if (chain.worth === null || chain.worth.ok !== true) {
          return deny(
            'FULL_TEST_STAGE_OUT_OF_ORDER',
            '顺序不对：计划那一站（arrange）必须在**需求分析与审核都认可**之后。\n' +
              `  · need=${chain.need === null ? '(空)' : chain.need.ok}　worth=${chain.worth === null ? '(空)' : chain.worth.ok}\n` +
              '★ 缺一级都不许开跑。',
          )
        }
        if (chain.human === null || chain.human.approved !== true) {
          return deny(
            'FULL_TEST_HUMAN_NOT_APPROVED',
            '顺序不对：计划那一站（arrange）必须在**用户人工通过**之后。\n' +
              (chain.human === null
                ? '  · 还没有对应的 human_request / human_reply（主对话还没把这件事交给用户）\n'
                : `  · 人工答复是 approved=${chain.human.approved}\n`) +
              '★ 用户没点头，计划 AI 不能安排全量测试。\n' +
              '下一步：由主对话发起 pipeline_human_request（reason_kind=full_test_approval）拿到用户答复。',
          )
        }
      }
      const stageRec = {
        ok: payload.ok === true,
        by: actorRole,
        at: nowIso(now()),
        reason: String(payload.reason ?? ''),
        handoff_id: record.handoff_id,
      }
      if (stage === 'need') {
        stageRec.necessity = String(payload.necessity ?? '')
        chain.need = stageRec
      } else if (stage === 'worth') {
        stageRec.worth_it = String(payload.worth_it ?? '')
        chain.worth = stageRec
      } else {
        stageRec.scope = String(payload.scope ?? '')
        stageRec.command = String(payload.command ?? '')
        stageRec.notes = String(payload.notes ?? '')
        if (payload.ok === true && stageRec.command.trim().length === 0) {
          return deny(
            'FULL_TEST_NO_COMMAND',
            '计划那一站同意时必须给出**最终批准的命令**（command）——\n' +
              '放行时守门会拿实际要跑的命令与它比对，避免"批了一条、跑另一条"。\n' +
              `测试申请里写的是：${chain.request.what_will_run || '(空)'}`,
          )
        }
        chain.arranged = stageRec
      }
      // 任一站否决 ⇒ 整条链停住（留痕）
      if (payload.ok !== true) {
        chain.status = 'rejected'
        chain.rejected_at_stage = stage
        chain.reject_reason = String(payload.reason ?? '')
      } else if (chain.need?.ok === true && chain.worth?.ok === true && chain.human?.approved === true && chain.arranged !== null) {
        chain.status = 'approved'
      }
      return { ok: true, chain }
    },

    /**
     * ★ 人工答复回填：主对话拿到用户答复后，把结果**挂回那条链**。
     *
     * 为什么必须回填：凭据判据（`fullTestCredential`）要看到 `human.approved === true`
     * 才可能放行 —— 光有一份 human_reply 文件是不够的，必须与链对上。
     */
    linkHumanReplyToFullTest(task, humanRequest) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const chain = list.find((c) => c.human !== null && c.human.request_id === humanRequest.request_id) ?? null
      if (chain === null) return null
      const approved = humanRequest.decision === 'approved' || humanRequest.approved === true || humanRequest.decision === 'yes'
      chain.human = {
        request_id: humanRequest.request_id,
        reply_id: humanRequest.reply_id ?? humanRequest.reply_handoff_id ?? null,
        approved: approved === true,
        quote: String(humanRequest.quote ?? humanRequest.user_quote ?? ''),
        by: humanRequest.answered_by ?? 'human',
        at: humanRequest.answered_at ?? nowIso(now()),
      }
      if (approved !== true) {
        chain.status = 'rejected'
        chain.rejected_at_stage = 'human'
        chain.reject_reason = String(humanRequest.note ?? humanRequest.reply_note ?? '用户未通过')
      } else if (chain.need?.ok === true && chain.worth?.ok === true && chain.arranged !== null) {
        chain.status = 'approved'
      }
      return chain
    },

    /** 主对话发起人工审核时，把链与那条 human_request 对上。 */
    attachFullTestHumanRequest(task, chain, humanRequest) {
      if (chain === null || humanRequest === null) return
      chain.human = {
        request_id: humanRequest.request_id,
        reply_id: null,
        approved: null,
        quote: '',
        by: 'main',
        at: nowIso(now()),
      }
    },

    // --- ★需求留档（权威需求快照）--------------------------------------------

    /**
     * ★ 落一份需求档（人可读 markdown + 结构化 JSON），并把路径与 sha256 记进任务。
     * 变更时**不覆盖当前文件名**（requirement.md 永远是最新版），历史另存 vN 并追加进 requirement_history[]。
     */
    async writeRequirementDoc(input) {
      const { task, markdown, structured, by } = input
      const dir = taskDir(task.id)
      await mkdir(dir, { recursive: true })

      // 版本索引是"可追溯"的**凭据**：每一版的 sha256、时间、谁改的、差异摘要都在里面。
      const idxPath = join(dir, "requirement.index.json")
      let idx = { task_id: task.id, versions: [] }
      try {
        idx = JSON.parse(await readFile(idxPath, "utf8"))
        if (!Array.isArray(idx.versions)) idx = { task_id: task.id, versions: [] }
      } catch { /* 第一次写，或索引坏了 —— 从空开始重建 */ }

      const version = `r${idx.versions.length + 1}`
      const mdBody = markdown
      const jsonBody = JSON.stringify(structured, null, 2)
      const sha = fullHash(mdBody)
      const prev = idx.versions.at(-1) ?? null

      // 当前版本固定这两个路径（"随时可查"靠的就是它们不变）
      await writeFile(join(dir, "requirement.md"), mdBody, "utf8")
      await writeFile(join(dir, "requirement.json"), jsonBody, "utf8")
      // 历史版本另存，**绝不覆盖**
      await writeFile(join(dir, `requirement.${version}.md`), mdBody, "utf8")
      await writeFile(join(dir, `requirement.${version}.json`), jsonBody, "utf8")

      idx.versions.push({
        version,
        sha256: sha,
        json_sha256: fullHash(jsonBody),
        bytes: mdBody.length,
        at: nowIso(now()),
        amended_by: by,
        supersedes: prev === null ? null : prev.version,
        note: typeof input.note === "string" ? input.note : "",
        diff_summary: prev === null ? "（首版）" : diffSummary(prev, { version, sha256: sha, note: input.note }),
      })
      await writeFile(idxPath, JSON.stringify(idx, null, 2), "utf8")
      return { version, sha256: sha, index: idx }
    },
    /**
     * ★ 需求档是否可用（**分发任务前的硬闸**）：① 任务卡登记过路径；② 文件真的在盘上。
     */
    /**
     * ★ 需求档是否可用（**分发任务前的硬闸**）。
     *
     * 更正 A 之后这里**不再看任务卡**（路径不进任务卡），改成查两件事：
     *   ① 约定目录下的 `requirement.md` **存在**；
     *   ② **版本可追溯** —— 有版本索引、索引里有版本、每版的文件都在盘上、
     *      且**当前 md 的 sha256 与索引里最新一版对得上**。
     *
     * ② 是"可追溯"的实质：光有一个 md 文件，你不知道它是哪一版、改过没有、
     *   改之前长什么样 —— 那不算可追溯。
     */
    async checkRequirementDoc(task) {
      const p = requirementPaths(join(task.project_root, dirName), task.id)
      const relMd = `.pipeline/${task.id}/requirement.md`

      if (!existsSync(p.md)) {
        return deny(
          "NO_REQUIREMENT_DOC",
          `拒绝分发任务：约定目录下**没有需求档**（找的是 ${relMd}）。\n` +
            '★ 规矩：产出任务卡 / 角色清单时必须同时落一份本地需求档 —— **没有留档就不许开工**。\n' +
            '   路径是**目录约定**推出来的，不需要谁告诉你；任何角色需要需求时自己去读。\n' +
            '为什么：上下文会溢出、会失忆、席位会换人。需求档是唯一能在"什么都忘了"之后' +
            '把"要做什么、验收标准是什么"还原出来的东西。\n' +
            '下一步：L0 由 pipeline_orchestrate 落档；L1+ 由留档 AI 用 pipeline_compile_requirement 汇总落档。',
        )
      }

      if (!existsSync(p.index)) {
        return deny(
          "REQUIREMENT_NOT_TRACEABLE",
          "拒绝分发任务：需求档存在，但**没有版本索引**（requirement.index.json）。\n" +
            '★ "可追溯"指的是：知道现在是第几版、每一版的 sha256 是什么、谁在什么时候改的、' +
            '改之前长什么样。光有一个 md 文件做不到这些。\n' +
            '下一步：让编排重新落一次档（会重建索引并保留历史）。',
        )
      }

      let idx
      try {
        idx = JSON.parse(await readFile(p.index, "utf8"))
      } catch (err) {
        return deny("REQUIREMENT_NOT_TRACEABLE", `拒绝分发任务：版本索引读不出来（${String(err?.message ?? err)}）。`)
      }
      const versions = Array.isArray(idx?.versions) ? idx.versions : []
      if (versions.length === 0) {
        return deny(
          "REQUIREMENT_NOT_TRACEABLE",
          "拒绝分发任务：版本索引里**一个版本都没有** —— 不可追溯。\n" +
            "下一步：让编排重新落一次档。",
        )
      }

      // 每一版的历史文件都得在（历史不许被删）
      const missing = versions.filter((v) => !existsSync(join(p.dir, `requirement.${v.version}.md`)))
      if (missing.length > 0) {
        return deny(
          "REQUIREMENT_HISTORY_MISSING",
          `拒绝分发任务：版本索引里记了 ${versions.length} 版，但有 ${missing.length} 版的历史文件不在盘上。\n` +
            missing.slice(0, 5).map((v) => `  · ${v.version}（requirement.${v.version}.md）`).join("\n") +
            "\n★ 历史被删掉 = 追溯链断了。宁可重建也不要删历史。",
        )
      }

      // ★ 当前 md 必须与索引里最新一版对得上（防"文件被改过但索引没更新"）
      const latest = versions.at(-1)
      const actual = fullHash(await readFile(p.md, "utf8"))
      if (actual !== latest.sha256) {
        return deny(
          "REQUIREMENT_TAMPERED",
          "拒绝分发任务：当前 requirement.md 的 sha256 与版本索引里最新一版**对不上**。\n" +
            `  索引里最新：${latest.version}　${String(latest.sha256).slice(0, 32)}…\n` +
            `  磁盘上实际：　　${actual.slice(0, 32)}…\n` +
            '★ 这说明有人绕过了编排直接改了需求档 —— 而**只有编排能写它**。\n' +
            '下一步：查清是谁改的，然后让编排重新落一次档（会把改动记成新版本）。',
        )
      }

      return { ok: true, paths: p, version: latest.version, versions: versions.length, sha256: latest.sha256 }
    },
    // --- ★分权落档（更正 A：各写各的，留档 AI 汇总）---------------------------

    /** ★ 记录目录的**约定路径**。 */
    recordDirPath(task) {
      return join(taskDir(task.id), "records")
    },

    /** ★ 某角色 / 席位的记录文件**约定名**（谁的记录谁写，互不覆盖）。 */
    recordBaseName(role, seat) {
      const s = typeof seat === "string" && seat.length > 0 && seat !== role ? `-${seat.replace(/#/g, "")}` : ""
      return `${role}${s}`
    },

    /**
     * ★ 提交一份**自己的**记录给留档 AI（更正 A）。
     *
     * 三件事一次做完：
     *   ① 写入约定路径 `records/<role>[-<seat>].md` + `.json`（**只写自己那份**）
     *   ② 校验来路：调用方必须持有**该席位自己的令牌**（拒绝匿名 / 冒名）
     *   ③ 登记一条 submission（留档 AI 汇总时按它追溯来源）
     */
    async submitRecord(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const role = String(input.role ?? "")
      const seat = typeof input.seat === "string" ? input.seat : ""
      const markdown = String(input.markdown ?? "")
      if (markdown.trim().length === 0) return deny("EMPTY_RECORD", "记录内容为空 —— 空记录等于凭空写入，会被汇总时拒收。")

      // ② 来路校验：令牌必须属于 (task, role, seat)
      const tok = input.token ?? null
      if (tok === null || typeof tok.token !== "string" || tok.token.length === 0) {
        return deny(
          "NO_CREDENTIAL",
          "拒绝收下这份记录：**没有带席位令牌**。\n" +
            "★ 留档 AI 要**校验来路** —— 谁写的、哪个席位、哪一版。拒绝匿名提交。\n" +
            "请用 pipeline_record_submit 提交（它会带上你的角色令牌）。",
        )
      }
      if (tok.taskId !== task.id || tok.role !== role) {
        return deny(
          "IMPERSONATION",
          `拒绝收下这份记录：令牌与声明的来路**不符**（冒名）。\n` +
            `  令牌属于：任务 ${tok.taskId} / 角色 ${tok.role} / 席位 ${tok.seat ?? "(无)"}\n` +
            `  声明的是：任务 ${task.id} / 角色 ${role} / 席位 ${seat || "(无)"}\n` +
            "★ 记录的价值全在「这是谁说的」—— 来路不明或冒名的记录，汇总时一文不值。",
        )
      }
      if ((tok.seat ?? "") !== seat) {
        return deny(
          "SEAT_MISMATCH",
          `拒绝收下这份记录：令牌的席位是「${tok.seat ?? "(无)"}」，声明的是「${seat || "(无)"}」。\n` +
            "★ 只能提交**自己那份**。",
        )
      }

      // ① 落盘（只写自己那份）
      const dir = this.recordDirPath(task)
      await mkdir(dir, { recursive: true })
      const base = this.recordBaseName(role, seat)
      const mdPath = join(dir, `${base}.md`)
      const jsonPath = join(dir, `${base}.json`)
      await writeFile(mdPath, markdown, "utf8")
      const meta = {
        record_id: `RC-${shortHash(`${task.id}|${base}|${fullHash(markdown).slice(0, 8)}`)}`,
        task_id: task.id,
        role,
        seat: seat || null,
        base,
        at: nowIso(now()),
        sha256: fullHash(markdown),
        bytes: markdown.length,
        source: typeof input.source === "string" ? input.source : "自述",
        sections: toStringArray(input.sections),
      }
      const body = JSON.stringify({ ...meta, structured: input.structured ?? null }, null, 2)
      await writeFile(jsonPath, body, "utf8")

      // ③ 登记 submission
      task.records = task.records ?? []
      const prev = task.records.filter((r) => r.base === base).length
      const rec = { ...meta, revision: prev + 1, rel_path: relKey(task.project_root, mdPath) }
      task.records.push(rec)

      const aentry = await audit(task.id, role, "record:submit", {
        record_id: rec.record_id, base, seat: seat || null, revision: rec.revision,
        sha256: rec.sha256, agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      return {
        ok: true,
        task,
        record: rec,
        summary: [
          `记录已收下：${rec.record_id}（${role}${seat ? ` / ${seat}` : ""}，第 ${rec.revision} 版）`,
          `落盘：${rec.rel_path}（${rec.bytes} 字符，sha256 ${rec.sha256.slice(0, 16)}…）`,
          "来路已校验：令牌 ↔ 角色 ↔ 席位三者一致。",
          "",
          "留档 AI 会在汇总时按 record_id 追溯来源。",
        ].join("\n"),
      }
    },

    /** 列出已收下的记录。 */
    async listRecords(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)
      const all = task.records ?? []
      // 同一 base 只留最新那一版
      const latest = new Map()
      for (const r of all) if (!latest.has(r.base) || latest.get(r.base).revision < r.revision) latest.set(r.base, r)
      return { ok: true, task, all, latest: [...latest.values()] }
    },

    /**
     * ★ 留档 AI 汇总：把各方的记录编成**唯一的需求档**（更正 A）。
     *
     * 两条硬规则：
     *   ① **每条内容必须有来源** —— `source_record` 必须指向一份真实存在的记录；
     *   ② **有矛盾不得自己拍板** —— conflicts 非空时拒绝汇总，要求先提问 / 升级。
     */
    async compileRequirement(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const entries = Array.isArray(input.entries) ? input.entries : []
      const conflicts = Array.isArray(input.conflicts) ? input.conflicts : []
      if (entries.length === 0) return deny("NO_ENTRIES", "汇总至少要给一条 entries。")

      // ② 矛盾 → 不得自己拍板
      if (conflicts.length > 0) {
        return deny(
          "CONFLICTS_UNRESOLVED",
          `拒绝汇总：你报告了 ${conflicts.length} 处**互相矛盾的记录**。\n` +
            conflicts.slice(0, 5).map((c) => `  · ${c.about ?? "(未说明)"}　(${(c.between ?? []).join(" vs ")})`).join("\n") +
            "\n★ 留档 AI **不得自己拍板** —— 你的职责是收集与统一编写，不是裁定谁对。\n" +
            "两条出路：\n" +
            "  ① 走 pipeline_clarify_request 问需求分析/编排；\n" +
            "  ② 确实定不了 → 由编排升级给用户（pipeline_human_request）。\n" +
            "（把 conflicts 清空之前，requirement.md 不会被改写。）",
        )
      }

      // ① 每条必须有来源
      const all = task.records ?? []
      const byId = new Map(all.map((r) => [r.record_id, r]))
      const byRel = new Map(all.map((r) => [r.rel_path, r]))
      const noSource = []
      for (const [i, e] of entries.entries()) {
        const src = typeof e?.source_record === "string" ? e.source_record.trim() : ""
        if (src.length === 0) { noSource.push(`entries[${i}]：没有 source_record`); continue }
        if (!byId.has(src) && !byRel.has(src)) noSource.push(`entries[${i}]：source_record=「${src}」找不到对应的记录`)
      }
      if (noSource.length > 0) {
        return deny(
          "UNSOURCED_CONTENT",
          `拒绝汇总：有 ${noSource.length} 条内容**没有可追溯的来源**。\n` +
            noSource.slice(0, 5).map((s) => `  · ${s}`).join("\n") +
            "\n★ 留档 AI **不得凭空写入没有记录来源的内容**。\n" +
            "  否则需求档就不再是「大家说的话的汇总」，而是你自己编的东西。\n" +
            `  当前已收下的记录：${all.length === 0 ? "（一份都没有）" : all.map((r) => r.record_id).join("、")}`,
        )
      }

      // 生成 md（带来源标注）
      const lines = []
      lines.push(`# 需求档 · ${task.id}`)
      lines.push("")
      lines.push("> ★ **本文件是权威需求快照**，由**留档 AI** 汇总各方记录统一编写。")
      lines.push("> 每条内容都标了来源（记录 id + 提交者 + 时间）—— 可追溯。")
      lines.push("> **所有角色默认以本文件为准**；路径靠目录约定，任务卡里不登记。")
      lines.push("> 路径靠**目录约定**：`.pipeline/<taskId>/requirement.md`；**任务卡里不登记**。")
      lines.push("")
      lines.push("## 需求原文")
      lines.push("")
      lines.push(String(task.requirement ?? "(未登记)"))
      lines.push("")
      for (const e of entries) {
        const src = byId.get(e.source_record) ?? byRel.get(e.source_record)
        lines.push(`## ${String(e.section ?? "（未命名小节）")}`)
        lines.push("")
        lines.push(String(e.text ?? ""))
        lines.push("")
        lines.push(`<sub>来源：${src.record_id}（${src.role}${src.seat ? ` / ${src.seat}` : ""}，第 ${src.revision} 版，${src.at}）</sub>`)
        lines.push("")
      }
      // ★ 安全面：**每一版需求档都要带**（来源指向产出角色清单的那份记录）。
      //   否则继任上来的席位要等审核被拒了才知道"审核会查网络安全 / 本地泄密"。
      //   ⚠️ 本轮改动：来源从 `orchestrator` 改成 **`planner`** ——
      //      计划 AI 才是产出角色清单的那个角色（需求分析只出分析结论）。
      //      旧任务文件里没有 planner 记录，所以保留 orchestrator 作为回退。
      const orchRec =
        all.filter((r) => r.role === 'planner').at(-1) ??
        all.filter((r) => r.role === 'orchestrator').at(-1)
      if (orchRec !== undefined) {
        lines.push("## 安全面（审核必查）")
        lines.push("")
        lines.push("审核**必须**确认**网络安全 / 本地泄密是否发生**，并在 `review_verdict.security` 里给出")
        lines.push("`attestation`（`clean` / `issues`）与可核对的依据（`checks_ref` 必须真实存在）。")
        lines.push("`unknown` 不允许通过；有未解决 finding 不允许关单；安全角色 `blocked: true` 时强制打回。")
        lines.push("")
        lines.push(`<sub>来源：${orchRec.record_id}（${orchRec.role}，第 ${orchRec.revision} 版，${orchRec.at}）—— 计划分配</sub>`)
        lines.push("")
      }

      if (toStringArray(input.notes).length > 0) {
        lines.push("## 留档说明")
        lines.push("")
        for (const x of toStringArray(input.notes)) lines.push(`- ${x}`)
        lines.push("")
      }
      lines.push("---")
      lines.push("")
      lines.push("_由留档 AI 汇总生成；每条内容均标注来源记录，可逐条追溯。_")

      const doc = await this.writeRequirementDoc({
        task,
        markdown: lines.join("\n"),
        structured: {
          task_id: task.id,
          compiled_by: ROLE.ARCHIVIST,
          compiled_at: nowIso(now()),
          entries: entries.map((e) => ({ section: e.section, source_record: e.source_record })),
          records_used: entries.map((e) => e.source_record),
          requirement: task.requirement,
        },
        by: ROLE.ARCHIVIST,
        note: `汇总 ${entries.length} 条，来自 ${new Set(entries.map((e) => e.source_record)).size} 份记录`,
      })

      const aentry = await audit(task.id, ROLE.ARCHIVIST, "record:compile", {
        version: doc.version, sha256: doc.sha256,
        entries: entries.length, sources: [...new Set(entries.map((e) => e.source_record))],
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      return {
        ok: true,
        task,
        doc,
        summary: [
          `需求档已汇总：${doc.version}（sha256 ${String(doc.sha256).slice(0, 16)}…）`,
          `来源：${entries.length} 条内容，来自 ${new Set(entries.map((e) => e.source_record)).size} 份记录`,
          `路径（目录约定）：.pipeline/${task.id}/requirement.md`,
          "",
          "★ 每条内容都标了来源（记录 id + 提交者 + 时间），可逐条追溯。",
        ].join("\n"),
      }
    },

    // --- ★上下文水位与继任 -----------------------------------------------------

    /** 记录一条水位上报（`observed` 由插件侧工具计数器给出，是客观量）。 */
    async reportContext(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const v = validateContextReport({ percent: input.percent, basis: input.basis })
      if (v.ok !== true) return deny("BAD_CONTEXT_REPORT", v.error)

      const en = relayEnabled(task)
      const policy = en.policy
      const percent = Math.round(Number(input.percent))
      const level = levelOf(percent, policy)
      const observed = input.observed ?? { tool_calls: 0, active_minutes: 0, top_tools: [] }
      task.context_reports = task.context_reports ?? []

      const entry = {
        report_id: `CR-${shortHash(`${task.id}|${input.seat ?? input.role}|${task.context_reports.length}|${percent}`)}`,
        seat: input.seat ?? null,
        role: input.role,
        agent: input.actorAgentId ?? null,
        percent,
        level,
        basis: String(input.basis).trim(),
        requested_succession: input.requestedSuccession === true,
        observed,
        at: nowIso(now()),
        relay_enabled: en.enabled,
      }
      task.context_reports.push(entry)

      const aentry = await audit(task.id, input.role, "context:report", {
        report_id: entry.report_id,
        seat: entry.seat,
        percent,
        level,
        basis: entry.basis,
        requested_succession: entry.requested_succession,
        observed_tool_calls: observed.tool_calls,
        observed_active_minutes: observed.active_minutes,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      const lines = [
        `水位已上报：${entry.report_id}　${input.role}${entry.seat ? `（${entry.seat}）` : ""}　**${percent}%**　档位：${LEVELS[level]}`,
        `依据：${entry.basis}`,
        `插件侧客观观测：工具调用 ${observed.tool_calls} 次，活跃 ${observed.active_minutes} 分钟` +
          (observed.top_tools && observed.top_tools.length > 0 ? `（主要：${observed.top_tools.join("、")}）` : ""),
        "",
        `阈值（来自编排的 relayPolicy）：预警 ${policy.warnPercent}% / 触发继任 ${policy.triggerContextPercent}% / 硬限 ${policy.hardLimitPercent}%`,
      ]
      if (en.enabled !== true) {
        lines.push("", `本任务不启用继任：${en.why}`)
      } else if (level === "hard_limit") {
        lines.push(
          "",
          "★ **硬限**：你已经不允许再领新活了 —— 只允许交接与收尾。",
          "  请立刻产出 seat_handover 交接物，并让主对话执行 pipeline_succession。",
        )
      } else if (level === "succession") {
        lines.push(
          "",
          "★ **触发继任**：必须上报给分配 AI（主对话）。",
          "  下一步：① 产出一份 seat_handover 交接物（含 must_read_files 与 open_questions）；",
          "           ② 主对话调 pipeline_succession 换班。",
          "  ★ 别等自己撑不住才交 —— 交接物写得清不清楚，取决于你还记得多少。",
        )
      } else if (level === "warn") {
        lines.push("", "预警：开始准备交接材料（把进度、决定、必读文件记下来），还没到换班的时候。")
      }
      return { ok: true, task, report: entry, summary: lines.join("\n") }
    },

    /**
     * ★ 继任的第一步：**只做校验**，不改任何东西。
     * 真正的换班（建会话、铸令牌、撤旧令牌）由工具层做完 transport 之后调 commitSuccession。
     */
    async planSuccession(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const seat = String(input.seat ?? "")
      const role = String(input.role ?? "")

      // ① 编排授权（档位 / 角色白名单 / 次数上限 / 是否要复核）
      const auth = checkRelayAuthorization({ task, seat, role })
      if (auth.ok !== true) return deny("RELAY_NOT_AUTHORIZED", auth.error)
      const policy = auth.policy

      // ② 该席位必须**上报过水位**，且达到触发线
      // ★ 席位 key 统一成 seat || role：非编写角色的 context_report 里 seat 是 null，
      //   用 seat 去比永远匹配不上（它会以 role 作为自己的席位标识）。
      const seatKey = seat || role
      const reports = (task.context_reports ?? []).filter((r) => (r.seat ?? r.role) === seatKey && r.role === role)
      const last = reports.at(-1)
      if (last === undefined) {
        return deny(
          "NO_CONTEXT_REPORT",
          `拒绝继任：席位 ${seat || role} **从未上报过上下文水位**。\n` +
            "★ 继任必须有依据 —— \"我觉得它快满了\"不是依据。\n" +
            "下一步：先让该席位调 pipeline_context_report 上报水位（百分比 + 依据）。",
        )
      }
      if (last.percent < policy.triggerContextPercent) {
        return deny(
          "BELOW_TRIGGER",
          `拒绝继任：席位 ${seat || role} 最近一次上报是 **${last.percent}%**，低于触发线 ${policy.triggerContextPercent}%。\n` +
            `依据：${last.basis}\n` +
            "★ 没到线就换班 = 白白丢掉一个还记得上下文的席位，新来的还得从头读一遍。",
        )
      }

      // ③ 必须有合法的 seat_handover 交接物
      const handover = [...(task.handoffs ?? [])].reverse().find(
        (h) => h.kind === "seat_handover" && (h.payload?.from_seat === seatKey || h.payload?.from_seat === seat || h.payload?.from_seat === role),
      )
      if (handover === undefined) {
        return deny(
          "NO_SEAT_HANDOVER",
          `拒绝继任：席位 ${seat || role} 没有产出 seat_handover 交接物。\n` +
            "★ 换班必须留交接物 —— 否则新来的席位从零开始，而那正是继任要避免的事。\n" +
            "必填：from_seat / to_seat / reason / progress_done / progress_todo / must_read_files（至少含需求档）" +
            " / key_decisions / open_questions / next_step / do_not_repeat。",
        )
      }
      if ((task.successions ?? []).some((s) => s.handoff_id === handover.handoff_id)) {
        return deny("HANDOVER_ALREADY_USED", `这份交接物（${handover.handoff_id}）已经用过了，不能重复继任。`)
      }
      return { ok: true, task, policy, lastReport: last, handover }
    },

    /** ★ 继任的第二步：落记录 + 把旧 agent 标记为"已退休"。令牌撤销由工具层做。 */
    async commitSuccession(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)
      task.successions = task.successions ?? []
      const generation = (task.successions.filter((s) => s.seat === input.seat).at(-1)?.generation ?? 1) + 1
      const rec = {
        succession_id: `SC-${shortHash(`${task.id}|${input.seat}|${task.successions.length}|${input.toAgent}`)}`,
        seat: input.seat,
        role: input.role,
        from_agent: input.fromAgent ?? null,
        to_agent: input.toAgent ?? null,
        handoff_id: input.handoffId,
        reason: input.reason ?? "",
        at: nowIso(now()),
        generation,
      }
      task.successions.push(rec)

      // ★ 更正 B：登记「当前联系人」—— 每个席位都该能查到"现在谁是指派者"。
      //   不登记的话，继任之后各席位还会把上报发给**已经退场的旧编排**。
      task.contacts = task.contacts ?? {}
      task.contacts[input.role] = {
        role: input.role,
        seat: rec.seat,
        agent_id: rec.to_agent,
        generation,
        since: rec.at,
        previous_agent: rec.from_agent,
      }

      const aentry = await audit(task.id, "main", "seat:succession", {
        succession_id: rec.succession_id,
        seat: rec.seat,
        role: rec.role,
        from_agent: rec.from_agent,
        to_agent: rec.to_agent,
        handoff_id: rec.handoff_id,
        generation,
        reason: rec.reason,
      })
      task.history.push(aentry)
      await persist(task)
      return { ok: true, task, succession: rec }
    },

    /** 取某席位当前有效的令牌记录（规划继任时要撤掉它）。 */
    activeSeatToken(taskId, role, seat) {
      return null
    },

    // --- ★两级升级梯 · 第一级（角色 → 需求分析）------------------------------

    /** 同一问题的去重键（防踢皮球用）。 */
    questionKeyOf(taskId, fromRole, stage, question) {
      const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[？?。.！!，,、；;：:]/g, '')
      return shortHash(`${taskId}|${fromRole}|${norm(stage)}|${norm(question)}`)
    },

    /** 建一条澄清请求的生命周期记录。 */
    createClarificationEntry(task, record, payload) {
      const p = payload ?? {}
      const fromRole = p.from_role
      const key = this.questionKeyOf(task.id, fromRole, p.stage, p.question)
      const priorSame = (task.clarification_requests ?? []).filter((r) => r.question_key === key)
      const entry = {
        request_id: `CQ-${shortHash(`${task.id}|${record.handoff_id}|${key}|${(task.clarification_requests ?? []).length}`)}`,
        handoff_id: record.handoff_id,
        task_id: task.id,
        from_role: fromRole,
        to_role: ROLE.ORCHESTRATOR,
        question_key: key,
        round: priorSame.length + 1,
        stage: p.stage,
        question: p.question,
        context_digest: typeof p.context_digest === 'string' ? p.context_digest : '',
        options: Array.isArray(p.options) ? p.options.map((o) => ({ label: String(o?.label ?? ''), consequence: String(o?.consequence ?? '') })) : [],
        blocking: p.blocking === true,
        urgency: p.urgency,
        deadline: typeof p.deadline === 'string' ? p.deadline : '',
        state_at_request: WAITING_STATES.includes(task.state) && typeof task.previous_state === 'string' ? task.previous_state : task.state,
        status: 'pending', // pending → answered | escalated
        answered_at: null,
        verdict: null,
        answer: null,
        reason: null,
        constraints_added: [],
        escalated_at: null,
        escalated_to: null,
        resolved_at: null,
        resumed_to: null,
        resumed_from: null,
      }
      task.clarification_requests = task.clarification_requests ?? []
      task.clarification_requests.push(entry)
      return entry
    },

    /** 查一条澄清请求（按 id；不给就返回最近一条未答复的）。 */
    findClarification(task, requestId) {
      const all = task.clarification_requests ?? []
      if (typeof requestId === 'string' && requestId.length > 0) {
        return all.find((r) => r.request_id === requestId || r.handoff_id === requestId) ?? null
      }
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].status === 'pending') return all[i]
      }
      return all.at(-1) ?? null
    },

    /** 列出澄清请求（需求分析的收件箱）。 */
    async listClarifications(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const all = task.clarification_requests ?? []
      const pending = all.filter((r) => r.status === 'pending')
      return { ok: true, task, all, pending }
    },

    /**
     * ★ 需求分析的裁定：answered（给结论）或 cannot_answer（答不了，准备升级）。
     *
     * **只有需求分析能调**（守门也拦一层）。
     */
    async replyClarification(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.ORCHESTRATOR) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有「需求分析」能裁定澄清请求，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：这一级的存在意义就是"由需求分析在需求层先把能定的定掉"。别的角色代替它裁定，等于这一级不存在。',
        )
      }
      const entry = this.findClarification(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何澄清请求。`)

      if (entry.escalated_at !== null) {
        return deny(
          'ALREADY_ESCALATED',
          `澄清请求 ${entry.request_id} 已经**升级**给人工了（${entry.escalated_at}），不能再由需求分析裁定。\n` +
            '★ 这是刻意设计的**单向门**：一旦升级，就只剩用户答复这一条出路 ——\n' +
            '否则"先升级、再自己改口"会变成绕开用户的旁路，用户那边的待办也永远清不掉。',
        )
      }
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `澄清请求 ${entry.request_id} 已经裁定过了（${entry.answered_at}），不能重复裁定。`)
      }

      const verdict = input.verdict === 'cannot_answer' ? 'cannot_answer' : 'answered'
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      const answer = typeof input.answer === 'string' ? input.answer.trim() : ''

      if (verdict === 'answered') {
        // ★ 防"把能答的推给用户"：答了就**必须**给出结论。
        if (answer.length === 0) {
          return deny('EMPTY_ANSWER', 'verdict=answered 时必须给 answer —— 说了"答得了"却没结论，发起角色拿不到东西。')
        }
        // ★ 需求分析的**边界**：它只裁需求层的事。越界去裁实现细节会被点名。
        const boundary = this.checkOrchestratorBoundary(entry, answer)
        if (boundary.warn !== null) {
          // 警告不阻断（需求层的判断本来就有灰色地带），但**写进审计**，让越界看得见。
          entry.boundary_warning = boundary.warn
        }
      }

      if (verdict === 'cannot_answer' && reason.length === 0) {
        return deny(
          'MISSING_REASON',
          'verdict=cannot_answer 时必须给 reason（为什么需求分析答不了）。\n' +
            '★ 这条是"防踢皮球"的第一道：说不出为什么答不了，就不许往上推。\n' +
            '合法的理由类型：需要用户拍板 / 涉及新需求（超出原任务卡范围）/ 需求层内部冲突无法自解 / 缺环境或权限。/\n' +
            '非法的理由：这个我不太懂 / 让用户决定吧 / 实现细节我不管（那些属于本可以在需求层裁定的事）。',
        )
      }

      entry.status = 'answered'
      entry.answered_at = nowIso(now())
      entry.verdict = verdict
      entry.answer = verdict === 'answered' ? answer : null
      entry.reason = reason
      entry.constraints_added = toStringArray(input.constraintsAdded)

      const aentry = await audit(task.id, ROLE.ORCHESTRATOR, 'clarify:reply', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        verdict,
        answer: entry.answer,
        reason: entry.reason,
        constraints_added: entry.constraints_added,
        round: entry.round,
        boundary_warning: entry.boundary_warning ?? null,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      // 恢复状态（回到被打断前的那个）
      let resumed = null
      if (entry.blocking === true && task.state === ST.AWAITING_CLARIFICATION) {
        const applied = await this.transition({
          taskId: task.id,
          event: 'clarification_reply',
          actorRole: ROLE.ORCHESTRATOR,
          actorAgentId: input.actorAgentId,
          note: `依据裁定 ${entry.request_id}（${verdict}）恢复`,
        })
        if (applied.ok !== true) {
          entry.resolved_at = nowIso(now())
          await persist(task)
          return deny(
            'RESUME_FAILED',
            `裁定已记录（${entry.request_id}），但状态恢复失败：\n${applied.error}\n` +
              `任务当前仍在「${STATE_LABEL[task.state]}」。裁定不会被撤销 —— 请人工处置。`,
          )
        }
        resumed = { from: applied.from, to: applied.to }
        entry.resolved_at = nowIso(now())
        entry.resumed_from = applied.from
        entry.resumed_to = applied.to
        const rentry = await audit(task.id, ROLE.ORCHESTRATOR, 'clarify:resume', {
          request_id: entry.request_id,
          from: applied.from,
          to: applied.to,
          agent: input.actorAgentId,
        })
        task.history.push(rentry)
      }
      await persist(task)

      const lines = [
        `已裁定：${entry.request_id}（${verdict === 'answered' ? '需求分析直接答复' : '需求分析答不了'}）`,
        `发起角色：${entry.from_role}　卡在哪：${entry.stage}`,
        verdict === 'answered' ? `结论：${answer}` : `为什么答不了：${reason}`,
        reason.length > 0 && verdict === 'answered' ? `依据：${reason}` : '',
        entry.constraints_added.length > 0 ? `新增/收紧的约束：${entry.constraints_added.join('；')}` : '',
        entry.boundary_warning !== null && entry.boundary_warning !== undefined ? `⚠ ${entry.boundary_warning}` : '',
        resumed === null
          ? entry.blocking === true
            ? '（任务已不在「等待需求分析答复」，状态未变。）'
            : '（这是非阻塞提问：任务可以继续推进，但结论仍要回投给发起角色。）'
          : `任务状态：${STATE_LABEL[resumed.from]} → ${STATE_LABEL[resumed.to]}`,
        '',
        '留痕（audit.jsonl）：',
        `  ① 提问  clarify:request  ${entry.request_id}  by ${entry.from_role}`,
        `  ② 裁定  clarify:reply    ${entry.answered_at}  verdict=${verdict}`,
        resumed === null ? '  ③ 恢复  （本条未阻塞，无需恢复）' : `  ③ 恢复  clarify:resume   ${entry.resolved_at}  → ${entry.resumed_to}`,
        '',
        verdict === 'cannot_answer'
          ? `下一步：把它**升级**给用户 —— pipeline_human_request { ..., escalated_from: "${entry.handoff_id}", raised_by: "${entry.from_role}", orchestrator_reason: "<为什么答不了>" }`
          : `下一步：把结论回投给「${entry.from_role}」—— 用 pipeline_dispatch 重新派活即可（状态已经回到它该在的地方）。`,
      ].filter((x) => x !== '')
      return { ok: true, task, request: { ...entry }, resumed, summary: lines.join('\n') }
    },

    /**
     * 需求分析的**边界**检查：它该裁需求层的事，不该裁实现细节。
     * 命中"越界词"时返回一句警告（**不阻断**，但写进审计）。
     */
    checkOrchestratorBoundary(entry, answer) {
      const impl = /(用哪个库|哪个框架|函数怎么实现|算法选|变量名|代码风格|lint|重构方式|怎么写的)/i
      if (impl.test(answer)) {
        return {
          warn:
            `需求分析的答复里出现了实现层措辞（${answer.match(impl)?.[0]}）。\n` +
            '边界：需求分析裁的是**需求层**（验收标准、边界条件、优先级、范围取舍、测试要点）；\n' +
            '实现层（用哪个库、怎么写）应由发起角色自己定。这次不阻断，但已记入审计。',
        }
      }
      return { warn: null }
    },

    /**
     * ★ **防踢皮球**闸 + **升级通道**闸（合在一条，因为它们回答的是同一个问题：
     *   "这条 human_request 到底该不该走这条路"）。
     *
     * 三条规则：
     *   ① **单向门**：已升级的澄清请求不能再被需求分析裁定（在 replyClarification 里拦）。
     *   ② **同一问题不得反复问**：同一个 question_key 问超过 `maxClarificationRounds` 次就拒。
     *   ③ **跳级闸**：roster 里有独立 orchestrator 时，执行/顾问角色**不能**直接发 human_request，
     *      必须先走第一级。（L0 没有独立 orchestrator ⇒ 直接发是**合法**路径，放行。）
     *
     * ★ 本轮新增第 ⓪ 条（用户拍板 P13，哈希闸门连续不通过 ⇒ 自动交人工）：
     *   `reason_kind=hash_gate_escalation` **只有机制发得出来** ——
     *   角色走 `pipeline_handoff` 发它会被明确拒（`HASH_GATE_ESCALATION_IS_SYSTEM`）。
     *   为什么不让角色发：这条请求的全部意义是"**阈值到了**"，
     *   而阈值是机制数的数 —— 让角色自己声明"我已经连续失败 3 次"就等于把
     *   "什么时候该惊动用户"交给被考核的那一方去定。
     *
     * @param {object} task
     * @param {object} payload
     * @param {string} actorRole
     * @param {{systemEscalation?:boolean}} [opts] - `systemEscalation`：由 store 内部触发（不是角色触发）
     */
    async checkHumanRequestChannel(task, payload, actorRole, opts = {}) {
      const mode = task.roster?.orchestrator_mode ?? null

      // --- ⓪ ★机制自动升级：哈希闸门连续不通过 -------------------------------
      //
      //   判据三条，缺一不可（它们共同保证"这条请求不是谁想发就能发"）：
      //     ① 必须由机制触发（`systemEscalation`）；
      //     ② 配置里阈值必须真的开着（`hashGateEscalateAfter > 0`）；
      //     ③ 任务上的连续计数必须**真的到了阈值**（这是与"计数"唯一的对账点）。
      //   另外：已经升级且还没答复时，不许再叠一条（否则一次失败刷出一堆请求）。
      if (payload?.reason_kind === 'hash_gate_escalation') {
        if (opts.systemEscalation !== true) {
          return deny(
            'HASH_GATE_ESCALATION_IS_SYSTEM',
            '拒绝：`reason_kind=hash_gate_escalation`（哈希闸门连续不通过）**只能由机制自动发起**，角色不能自己发。\n' +
              '★ 为什么：这条请求的全部意义是"**连续失败的次数到了阈值**" —— 而那个数是机制数的。\n' +
              '  让角色自己声明"我已经连续失败 3 次"，等于把"什么时候该惊动用户"交给被考核的那一方去定。\n' +
              '★ 你要问用户的如果是别的事，按用途选一个 reason_kind（需求歧义 / 范围变更 / 需要审批 / 安全否决 …）。',
          )
        }
        if (!Number.isInteger(hashGateEscalateAfter) || hashGateEscalateAfter <= 0) {
          return deny(
            'HASH_GATE_ESCALATION_DISABLED',
            `拒绝：配置 hashGateEscalateAfter=${hashGateEscalateAfter} —— 自动升级**关着**，不该出现这条请求（插件内部错误）。`,
          )
        }
        const streak = Number.isInteger(task.hash_gate_streak) ? task.hash_gate_streak : 0
        if (streak < hashGateEscalateAfter) {
          return deny(
            'HASH_GATE_ESCALATION_TOO_EARLY',
            `拒绝：连续不过计数是 ${streak}，还没到阈值 ${hashGateEscalateAfter} —— 不该升级（插件内部错误）。`,
          )
        }
        if (hashGateEscalationPending(task)) {
          return deny(
            'HASH_GATE_ESCALATION_PENDING',
            `拒绝：本任务已经有一条还没答复的哈希闸门升级（${task.hash_gate_escalation?.request_id ?? '?'}）—— 不重复打扰用户。`,
          )
        }
        return { ok: true }
      }

      // --- ③ 跳级闸 ---------------------------------------------------------
      if (mode === 'separate') {
        if (actorRole === ROLE.ORCHESTRATOR) {
          // 需求分析自己发 human_request —— 这就是**升级**，或者是**需求确认**。
          // 两条合法路径（本轮把第二条从"歧义"扩成"歧义 + 固定确认"）：
          //   ① 需求本身有歧义 / 需要用户确认这份分析（reason_kind 在下面这个名单里）
          //      —— 那本来就是需求分析的份内事，可以不带上游；
          //   ② 升级：带 escalated_from（某个 clarification_request），并带 raised_by 与
          //      orchestrator_reason。
          const from = typeof payload?.escalated_from === 'string' ? payload.escalated_from.trim() : ''
          if (from.length === 0) {
            const kind = payload?.reason_kind
            // ★ 本轮新增 requirement_confirmation：澄清前置到人工那一步用的就是它。
            //   为什么不新开状态：见 states.js 里 `requirement_confirmed` 那条边的注释 ——
            //   这一段与 human_request 链**完全同构**，差别只在"问的是什么"，
            //   而那件事由一个数据字段（reason_kind）回答就够了。
            const selfKinds = ['requirement_ambiguous', 'requirement_confirmation']
            if (!selfKinds.includes(kind)) {
              return deny(
                'ESCALATION_NEEDS_SOURCE',
                `需求分析发 human_request 时，必须说明**这是从哪来的**。\n` +
                  `两条合法路径：\n` +
                  `  ① 升级：escalated_from = 某个 clarification_request 的 handoff_id，并带上 raised_by 与 orchestrator_reason；\n` +
                  `  ② 需求本身有歧义 / 请用户确认需求分析结论（reason_kind=${selfKinds.join(' 或 ')}）` +
                  `—— 那本来就是需求分析的份内事，可以不带上游。\n` +
                  `当前 reason_kind=${kind ?? '(未给)'}，且没有 escalated_from。`,
              )
            }
            return { ok: true }
          }
          const entry = (task.clarification_requests ?? []).find((r) => r.handoff_id === from || r.request_id === from)
          if (entry === undefined) {
            return deny(
              'ESCALATION_SOURCE_NOT_FOUND',
              `escalated_from=${from} 指不到任何 clarification_request。\n` +
                '升级必须挂在**真实存在**的上游请求上 —— 否则"我升级了一个别人没问过的问题"无从追溯。',
            )
          }
          if (entry.status !== 'answered' || entry.verdict !== 'cannot_answer') {
            return deny(
              'ESCALATION_SOURCE_NOT_DECLINED',
              `clarification_request ${entry.request_id} 的状态是 ${entry.status}（verdict=${entry.verdict ?? '无'}），\n` +
                '不是"需求分析答不了"。\n' +
                '★ 只能升级**自己确实答不了**的问题 —— 能答而推给用户，就是踢皮球。\n' +
                '先 pipeline_clarify_reply 给出 cannot_answer 的裁定（带理由），再来升级。',
            )
          }
          if (typeof payload?.raised_by !== 'string' || payload.raised_by !== entry.from_role) {
            return deny(
              'ESCALATION_RAISED_BY_MISMATCH',
              `raised_by=${payload?.raised_by ?? '(未给)'} 与上游请求的发起角色 ${entry.from_role} 不一致。\n` +
                '升级必须写清"这事原本是谁问的" —— 用户答复要能回投给那个人。',
            )
          }
          if (typeof payload?.orchestrator_reason !== 'string' || payload.orchestrator_reason.trim().length === 0) {
            return deny('ESCALATION_NEEDS_REASON', '升级时必须给 orchestrator_reason（为什么需求分析答不了）。用户有权知道为什么这事轮到他拍板。')
          }
          return { ok: true, escalated: entry }
        }

        // 执行/顾问角色：不许跳级
        if (ROLES_CAN_RAISE_HUMAN.includes(actorRole) && actorRole !== 'human') {
          const open = (task.clarification_requests ?? []).filter((r) => r.status === 'pending')
          return deny(
            'MUST_ASK_ORCHESTRATOR_FIRST',
            `跳级：`+`${roleLabel(actorRole)}不能直接向用户发起人工介入。\n` +
              '★ 这个任务有**独立的需求分析**对话，所以人工介入是**两级**的：\n' +
              `   ① 你先提交 clarification_request 问它（需求层的事它多半能直接答，用户根本不用被打扰）；\n` +
              `   ② 它确实答不了时，**由它**升级成 human_request 转给用户。\n` +
              `当前待答复的澄清请求：${open.length > 0 ? open.map((r) => r.request_id).join('、') : '（无）'}\n` +
              '下一步：pipeline_clarify_request { task_id, stage, question, context_digest, blocking, urgency }。\n' +
              `（只有 L0 档没有独立编排对话，那时直接发 human_request 才是合法的 —— 当前档位 ${task.roster?.tier ?? '未知'}，orchestrator_mode=separate。）`,
          )
        }
      }

      // --- ② 同一问题反复问 ------------------------------------------------
      if (mode === 'separate' && actorRole !== ROLE.ORCHESTRATOR) return { ok: true }
      return { ok: true }
    },

    /** ★ 同一个 question_key 允许问几次（默认 2：允许"答完还不明白再问一次"，之后必须升级）。 */
    checkClarificationPingPong(task, payload) {
      const key = this.questionKeyOf(task.id, payload?.from_role, payload?.stage, payload?.question)
      const prior = (task.clarification_requests ?? []).filter((r) => r.question_key === key)
      const cap = Number.isInteger(maxClarifyRounds) && maxClarifyRounds > 0 ? maxClarifyRounds : 2
      if (prior.length >= cap) {
        const last = prior.at(-1)
        return deny(
          'CLARIFICATION_PINGPONG',
          `防踢皮球：同一个问题已经问过 ${prior.length} 次（上限 ${cap} 次）。\n` +
            `问题：${payload?.question}\n` +
            `上一次：${last?.request_id}，状态 ${last?.status}${last?.verdict ? `（verdict=${last.verdict}）` : ''}\n` +
            '★ 反复问同一件事说明它不是"需求层能定的" —— 那就该走升级路径，而不是在原地打转。\n' +
            (last?.status === 'answered' && last?.verdict === 'cannot_answer'
              ? `下一步：让需求分析把它升级给用户（pipeline_human_request 带 escalated_from="${last.handoff_id}"）。`
              : last?.status === 'pending'
                ? `下一步：先等 / 催需求分析对 ${last.request_id} 出裁定。`
                : '下一步：走 pipeline_human_request 升级给用户（带 escalated_from）。'),
        )
      }
      return { ok: true }
    },

    // --- ★人工介入（用户只与主对话相连，这是唯一的上升通道）-------------------
    //
    // 四步：① 角色发起（submitHandoff kind=human_request，已在上面的通用路径里建好记录）
    //       ② 主对话转告（relayHumanRequest）—— 不改状态，只留痕
    //       ③ 用户答复（replyHumanRequest 的前半）—— 必须有来源依据
    //       ④ 据答复恢复（replyHumanRequest 的后半 → 状态回到被打断前的那个）

    /**
     * 建一条生命周期记录（由 `submitHandoff` 在 kind=human_request 时调用）。
     *
     * ★ 幂等：同一个 `handoff_id` 已经有登记就**原样返回**，不重复登记。
     *   真实构造逻辑在模块级 `buildHumanRequestEntry` —— 与兜底修复**共用同一份**，
     *   免得"登记"这件事出现两个实现（那正是这次事故的成因）。
     */
    createHumanRequestEntry(task, record, payload) {
      const existing = (task.human_requests ?? []).find((r) => r.handoff_id === record.handoff_id)
      if (existing !== undefined) return existing
      const entry = buildHumanRequestEntry(task, record, payload, timeoutHours)
      task.human_requests.push(entry)
      return entry
    },

    /**
     * ★ **兜底（事后补）**：从「交接物 + 状态」反推出缺的那条登记。
     *
     * 实现是工厂级的 `reconcileHumanRequests`（`loadTask` 读盘时也要用它，
     * 而那时还没法引用返回对象）—— 这里只是把它暴露给工具层，方便自测直接调。
     */
    reconcileHumanRequests(task) {
      return reconcileHumanRequests(task)
    },

    /**
     * ★ **登记闸（当场就不许漏）**：`human_request` 交接物落地时，登记必须同时落上。
     *
     * 两条提交路径（`pipeline_human_request` 与 `pipeline_handoff{kind:"human_request"}`）
     * 都汇到 `submitHandoff`，所以这一处覆盖那两条路。
     * 正常路径下这里必然是个 no-op（`createHumanRequestEntry` 刚建过）。
     *
     * @param {object} patched - 已把 payload 补进元数据的那份交接物记录
     * @returns {boolean} 是否补建了登记
     */
    async enforceHumanRequestRegistration(task, patched) {
      const recovered = reconcileHumanRequests(task)
      if (recovered === 0) return false
      const entry = (task.human_requests ?? []).find((r) => r.handoff_id === patched?.handoff_id) ?? null
      const aentry = await audit(task.id, ROLE.ORCHESTRATOR, 'human:recovered', {
        handoff_id: patched?.handoff_id ?? null,
        request_id: entry?.request_id ?? null,
        recovered,
        reason: '交接物在盘上但请求登记表里没有 —— 已按交接物 + awaiting_human 状态反推补登记',
      })
      task.history.push(aentry)
      await persist(task)
      return true
    },

    /** 查一条请求（按 id；不给就返回最近一条未答复的）。 */
    findHumanRequest(task, requestId) {
      if (typeof requestId === 'string' && requestId.length > 0) {
        return task.human_requests.find((r) => r.request_id === requestId) ?? null
      }
      for (let i = task.human_requests.length - 1; i >= 0; i--) {
        const r = task.human_requests[i]
        if (r.status !== 'answered' && r.status !== 'withdrawn') return r
      }
      return task.human_requests.at(-1) ?? null
    },

    /**
     * ② 主对话转告。**只有主对话能做**（守门也会拦，这里是第二道）。
     * 刻意**不改任务状态** —— 状态在发起那一刻就已经推到「等待人工答复」了，
     * 转告只是"我确实把话带到了"的留痕。
     */
    async relayHumanRequest(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话能把人工介入请求转告给用户，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：**用户的对话框只在主对话里** —— 执行/顾问角色根本没有对用户说话的通道。',
        )
      }
      const entry = this.findHumanRequest(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何人工介入请求。`)
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `请求 ${entry.request_id} 已经答复过了，不需要再转告。`)
      }

      entry.status = 'relayed'
      entry.relayed_at = nowIso(now())
      entry.relayed_by = ROLE.MAIN
      entry.relay_channel = typeof input.channel === 'string' && input.channel.length > 0 ? input.channel : 'chat'
      entry.relay_note = typeof input.note === 'string' ? input.note : ''
      entry.relay_count += 1
      // 确认码：转告时生成一次，之后不变。默认不强制用户回带（见配置 requireHumanConfirmCode）
      if (entry.confirm_code === null) entry.confirm_code = `HC-${randomId(4)}`

      const aentry = await audit(task.id, ROLE.MAIN, 'human:relay', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        relay_channel: entry.relay_channel,
        relay_count: entry.relay_count,
        to_user: true,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      const tail = [
        `请求：${entry.request_id}（${entry.from_role} 发起，${entry.reason_zh}）`,
        `阻塞：${entry.blocking ? `是（卡在 ${entry.blocked_stage || '未说明'}）` : '否'}`,
        `紧急度：${entry.urgency}　需要用户给：${HUMAN_DECISION_KINDS[entry.decision_kind] ?? entry.decision_kind}`,
        `无人回应时：${HUMAN_TIMEOUT_BEHAVIORS[entry.timeout_behavior] ?? entry.timeout_behavior}` +
          (entry.timeout_at ? `（截止 ${entry.timeout_at}）` : ''),
        '',
        '★ 转告给用户的内容（**照抄这段**，不要自己加技术判断）：',
        '',
        `  ${entry.question_for_human}`,
        ...(entry.context_for_human ? ['', `  背景：${entry.context_for_human}`] : []),
        ...(entry.options.length > 0
          ? ['', '  可选方案：', ...entry.options.map((o, i) => `   ${i + 1}) ${o.label} —— ${o.consequence}`)]
          : []),
        ...(entry.recommended ? ['', `  ${entry.from_role} 的建议（仅供参考，不是决定）：${entry.recommended}`] : []),
        '',
        `  确认码：${entry.confirm_code}（把这一行也带上，用户答复时可以回带它作为凭据）`,
        '',
        '主对话接下来只做两件事：把上面这段呈现给用户，然后把用户的答复原样记回来：',
        `  pipeline_human_reply { task_id: "${task.id}", request_id: "${entry.request_id}", user_quote: "<用户的原话>", ... }`,
        '★ 不要替用户选，也不要把这条请求标成"已解决" —— 没有用户答复就恢复不了。',
      ]
      return { ok: true, task, request: { ...entry }, summary: tail.join('\n') }
    },

    /**
     * ③④ 记录用户答复 + 据答复恢复状态。
     */
    async replyHumanRequest(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话能记录用户的答复，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：用户的答复只会出现在主对话的对话框里；别的角色声称"用户说可以"是无源之言。',
        )
      }
      const entry = this.findHumanRequest(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何人工介入请求。`)
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `请求 ${entry.request_id} 已经答复过了（${entry.answered_at}），不能重复答复。`)
      }

      // --- 顺序闸：没转告就不能有答复 --------------------------------------
      if (entry.relayed_at === null) {
        return deny(
          'NOT_RELAYED',
          `请求 ${entry.request_id} 还没有转告给用户，所以不可能有用户答复。\n` +
            '先调 pipeline_human_relay 把问题呈现给用户，拿到用户的原话之后再回来记录。\n' +
            '★ 这条判据挡的是"跳过转告、直接伪造一个答复"。',
        )
      }

      const source = input.answerSource === 'timeout' ? 'timeout' : 'user'

      if (source === 'timeout') {
        // --- 超时路径：不是"用户说了什么"，而是"事前声明的策略到期生效" ----
        if (entry.timeout_behavior === 'stay_blocked') {
          return deny(
            'TIMEOUT_POLICY_STAYS_BLOCKED',
            `请求 ${entry.request_id} 声明的是 timeout_behavior=stay_blocked（一直等），所以不能按超时放行。\n` +
              '要么等用户答复，要么由主对话调 pipeline_transition event=cancel 明确取消。',
          )
        }
        if (entry.timeout_at === null) {
          return deny(
            'NO_DEADLINE_DECLARED',
            `请求 ${entry.request_id} 没有声明截止时间（timeout_at 为空，且配置 humanRequestTimeoutHours=0）。\n` +
              '没有截止时间就不存在"超时"这回事 —— 让它按超时处理等于开一个绕过用户答复的后门。\n' +
              '要允许超时：发起时带 timeout_at，或把配置 humanRequestTimeoutHours 设成正数。',
          )
        }
        if (Date.parse(entry.timeout_at) > now().getTime()) {
          return deny('DEADLINE_NOT_REACHED', `请求 ${entry.request_id} 的截止时间是 ${entry.timeout_at}，还没到。`)
        }
        entry.status = 'answered'
        entry.answered_at = nowIso(now())
        entry.answer_source = 'timeout'
        entry.answer = {
          source: 'timeout',
          deadline: entry.timeout_at,
          applied_policy: entry.timeout_behavior,
          applied_option: entry.default_option || null,
        }
      } else {
        // --- 用户答复路径：必须有来源依据 ---------------------------------
        const quote = typeof input.userQuote === 'string' ? input.userQuote.trim() : ''
        if (quote.length === 0) {
          return deny(
            'MISSING_USER_QUOTE',
            `缺 user_quote：记录用户答复时必须带上**用户本人的原话**。\n` +
              '为什么这条是硬要求：本插件拦不住主对话编一句"用户说可以"，' +
              '但一条**没有原话**的答复连事后审计都无从下手。' +
              '带上原话之后，编造至少是"留下了一份可被用户本人核对的伪造记录"。',
          )
        }
        if (quote.length < 4) {
          return deny('USER_QUOTE_TOO_SHORT', `user_quote 只有 ${quote.length} 个字符，太短，不构成一句可核对的原话。`)
        }
        // 防"把问题原样抄回来当答复"
        const echoes = [entry.question_for_human, entry.recommended, ...entry.options.map((o) => o.label)]
          .filter((s) => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
        if (echoes.some((e) => e === quote)) {
          return deny(
            'USER_QUOTE_IS_ECHO',
            'user_quote 与请求里的问题/建议/选项标签**一字不差** —— 那不像用户说的话，像是把问题抄了一遍。\n' +
              '请记用户实际答复的原话。',
          )
        }
        const source1 = typeof input.replyChannel === 'string' && input.replyChannel.length > 0 ? input.replyChannel : 'chat'
        if (!REPLY_CHANNELS.includes(source1)) {
          return deny('BAD_REPLY_CHANNEL', `reply_channel 必须是 ${REPLY_CHANNELS.join(' / ')} 之一，当前是「${source1}」。`)
        }
        const attribution = typeof input.attribution === 'string' ? input.attribution.trim() : ''
        if (attribution.length === 0) {
          return deny(
            'MISSING_ATTRIBUTION',
            '缺 attribution：要写清这句答复是**谁、在哪**说的（例如"用户在当前会话里直接回复"）。\n' +
              '答复必须可归属 —— 否则审计里看不出这句话的出处。',
          )
        }
        if (requireHumanConfirmCode === true) {
          const code = typeof input.confirmCode === 'string' ? input.confirmCode.trim() : ''
          if (code !== entry.confirm_code) {
            return deny(
              'CONFIRM_CODE_MISMATCH',
              `本插件配置了 requireHumanConfirmCode=true：答复必须回带转告时给出的确认码。\n` +
                `期望：${entry.confirm_code}　实际：${code.length === 0 ? '（未提供）' : code}\n` +
                '这条把"主对话替用户拍板"的门槛抬高到"必须把确认码也一起编出来"。',
            )
          }
        }

        // --- 答复形状必须与 decision_kind 相符 -----------------------------
        const shape = checkAnswerShape(entry, input)
        if (shape.ok !== true) return deny('BAD_ANSWER_SHAPE', shape.error)

        entry.status = 'answered'
        entry.answered_at = nowIso(now())
        entry.answer_source = 'user'
        entry.answer = {
          source: 'user',
          user_quote: quote,
          reply_channel: source1,
          attribution,
          confirm_code: typeof input.confirmCode === 'string' ? input.confirmCode.trim() : null,
          ...shape.value,
        }
      }

      // ★ 全量测试审批链：如果这条人工请求是为它发起的，把答复**挂回链上**。
      //
      //   为什么必须回填：凭据判据（fullTestCredential）要看到 human.approved === true
      //   才可能放行 —— 光有一份 human_reply 文件不够，必须与那条链对上。
      const linked = this.linkHumanReplyToFullTest(task, {
        request_id: entry.request_id,
        decision: entry.answer?.decision ?? null,
        approved: entry.answer?.decision === 'approved' || entry.answer?.decision === 'yes',
        quote: entry.answer?.user_quote ?? '',
        answered_by: entry.answer?.attribution ?? 'human',
        answered_at: entry.answered_at,
        note: entry.answer?.note ?? '',
      })
      if (linked !== null) {
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'fulltest:human', {
            approval_id: linked.approval_id,
            approved: linked.human?.approved === true,
            quote: linked.human?.quote ?? '',
          }),
        )
      }

      const aentry = await audit(task.id, ROLE.MAIN, 'human:reply', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        answer_source: entry.answer_source,
        user_quote: entry.answer?.user_quote ?? null,
        attribution: entry.answer?.attribution ?? null,
        reply_channel: entry.answer?.reply_channel ?? null,
        decision: entry.answer?.decision ?? null,
        applied_policy: entry.answer?.applied_policy ?? null,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      // --- ④ 据答复恢复 -----------------------------------------------------
      let resumed = null
      if (entry.blocking === true && task.state === ST.AWAITING_HUMAN) {
        const applied = await this.transition({
          taskId: task.id,
          event: 'human_reply',
          actorRole: ROLE.MAIN,
          actorAgentId: input.actorAgentId,
          note: `依据答复 ${entry.request_id}（${entry.answer_source}）恢复`,
        })
        if (applied.ok !== true) {
          // 状态没恢复成功：答复记录保留（它是事实），但把问题如实报出来。
          entry.resolved_at = nowIso(now())
          entry.resumed_to = null
          await persist(task)
          return deny(
            'RESUME_FAILED',
            `用户答复已记录（${entry.request_id}），但状态恢复失败：\n${applied.error}\n` +
              `任务当前仍在「${STATE_LABEL[task.state]}」。答复记录不会被撤销 —— 请人工处置。`,
          )
        }
        resumed = { from: applied.from, to: applied.to }
        entry.resolved_at = nowIso(now())
        entry.resumed_from = applied.from
        entry.resumed_to = applied.to
        const rentry = await audit(task.id, ROLE.MAIN, 'human:resume', {
          request_id: entry.request_id,
          based_on: entry.answer_source === 'timeout' ? entry.answer?.deadline : `用户原话：${clip(entry.answer?.user_quote ?? '', 160)}`,
          from: applied.from,
          to: applied.to,
          agent: input.actorAgentId,
        })
        task.history.push(rentry)
      } else if (entry.blocking === true) {
        entry.resolved_at = nowIso(now())
      }

      // ★★ 哈希闸门自动升级：用户答复过了 ⇒ 这件事**了结**，计数**重新武装**。
      //
      //   为什么是"重新武装"而不是"一次升级永久生效"：
      //   用户的答复未必真能解决问题（"你去看看是不是授权面本身给窄了"这种答复很常见）。
      //   若升级一次就永久失效，第 4 次以后的失败就**没有人管**了 ——
      //   那恰恰是这条机制要堵的"无限重交"。
      //   重新武装之后仍然是「连续 N 次不过 ⇒ 再交一次人工」：每 N 次都有人点头，
      //   不存在"没人看着的无限重交"。审计里 `gate:hash_rearm` 是这段的留痕。
      const escRec = task.hash_gate_escalation ?? null
      if (escRec !== null && escRec.request_id === entry.request_id && (escRec.answered_at === null || escRec.answered_at === undefined)) {
        escRec.answered_at = entry.answered_at
        escRec.answer_source = entry.answer_source
        escRec.user_quote = entry.answer?.user_quote ?? null
        escRec.resumed_to = entry.resumed_to ?? null
        escRec.rearm_at = nowIso(now())
        task.hash_gate_streak = 0
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'gate:hash_rearm', {
            round: escRec.round ?? null,
            request_id: entry.request_id,
            answer_source: entry.answer_source,
            user_quote: escRec.user_quote,
            resumed_to: escRec.resumed_to,
            streak_reset_to: 0,
            threshold: escRec.threshold ?? hashGateEscalateAfter,
          }),
        )
      }

      await persist(task)

      const lines = [
        `已记录答复并推进：${entry.request_id}`,
        `发起角色：${entry.from_role}　答复来源：${entry.answer_source === 'timeout' ? '超时策略' : '用户'}`,
        entry.answer_source === 'user'
          ? `用户原话：${clip(entry.answer.user_quote, 200)}\n归属：${entry.answer.attribution}（${entry.answer.reply_channel}）`
          : `按事前声明的策略处理：${entry.answer.applied_policy}${entry.answer.applied_option ? `（选项：${entry.answer.applied_option}）` : ''}`,
        `决定：${JSON.stringify(entry.answer.decision ?? entry.answer.applied_option ?? null)}`,
        resumed === null
          ? '（这条请求是非阻塞的，或任务已不在「等待人工答复」，状态未变。）'
          : `任务状态：${STATE_LABEL[resumed.from]} → ${STATE_LABEL[resumed.to]}`,
        '',
        '四步留痕（都在 audit.jsonl 与 task.json 里）：',
        `  ① 发起  human:request  ${entry.request_id}  by ${entry.from_role}`,
        `  ② 转告  human:relay    ${entry.relayed_at}  by main`,
        `  ③ 答复  human:reply    ${entry.answered_at}  source=${entry.answer_source}`,
        resumed === null ? '  ④ 恢复  （本请求未阻塞，无需恢复）' : `  ④ 恢复  human:resume   ${entry.resolved_at}  → ${entry.resumed_to}`,
        '',
        `下一步：把结果回投给「${entry.from_role}」那个角色 —— 用 pipeline_dispatch 重新派活即可（状态已经回到它该在的地方）。`,
      ]
      return { ok: true, task, request: { ...entry }, resumed, summary: lines.join('\n') }
    },

    /** 列出人工介入请求（主对话收件箱）。 */
    async listHumanRequests(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const all = task.human_requests
      const pending = all.filter((r) => r.status !== 'answered' && r.status !== 'withdrawn')
      return { ok: true, task, all, pending }
    },



    /** 给主对话看的脱敏视图。 */
    // --- 查询 ---------------------------------------------------------------

    /** 给主对话看的脱敏视图。 */
    async status(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const redact = input.redactForMain !== false
      const version = currentArtifactVersion(task)
      const ok = effectiveReviewOk(task)
      return {
        ok: true,
        task_id: task.id,
        state: task.state,
        state_zh: STATE_LABEL[task.state],
        requirement: task.requirement,
        tier: task.roster?.tier ?? null,
        ai_count: task.roster?.ai_count ?? null,
        roles: task.roster?.execution_roles ?? [],
        sequence: task.roster?.sequence?.map((s) => s.role) ?? [],
        /** ★ 本轮新增：编写席位与**层**（席位数 = 层数）。 */
        writers: task.roster?.writers
          ? {
              count: task.roster.writers.count,
              layers: task.roster.writers.layers ?? [],
              partitions: (task.roster.writers.partitions ?? []).map((p) => ({ seat: p.seat, layer: p.layer ?? null, scope_paths: p.scope_paths ?? [] })),
            }
          : null,
        /** ★ 本轮新增：需求分析结论（含「不清楚处」清单）—— 需求确认那一步看的就是它。 */
        requirement_analysis: (() => {
          const h = lastHandoff(task, 'requirement_analysis')
          if (h === null) return null
          return {
            handoff_id: h.handoff_id,
            at: h.created_at,
            acceptance: h.payload?.acceptance ?? [],
            test_points: h.payload?.test_points ?? [],
            boundaries: h.payload?.boundaries ?? [],
            unclear_points: h.payload?.unclear_points ?? [],
            open_assumptions: h.payload?.open_assumptions ?? [],
            analysis_reason: h.payload?.analysis_reason ?? '',
          }
        })(),
        /** ★ 本轮新增：计划与自检结果（自检没通过就不许分配 AI）。 */
        plan: (() => {
          const h = lastHandoff(task, 'plan')
          if (h === null) return null
          return {
            handoff_id: h.handoff_id,
            at: h.created_at,
            steps: h.payload?.plan_steps ?? [],
            layers: h.payload?.layers ?? [],
            self_check: h.payload?.self_check ?? null,
          }
        })(),
        requirement_confirmed: (task.human_requests ?? []).some(
          (r) => r.from_role === ROLE.ORCHESTRATOR && ['requirement_confirmation', 'requirement_ambiguous'].includes(r.reason_kind) && r.status === 'answered',
        ),
        /**
         * ★ 设计目的（最小改动）：**授权面 vs 实际改动面**的对照。
         *
         * 这是"改了清单外的文件要能在审核阶段查出来（判据级）"的落点 ——
         * 调用方拿到的是**算好的结论**，不是一堆原始清单让它自己去比。
         */
        change_scope: task.change_scope ?? null,
        /** ★ **越界清单**（这次不许做什么）—— 与 change_scope 配对（一个白名单、一个明令禁止）。 */
        forbidden: toStringArray(task.plan_forbidden),
        /**
         * ★ **授权面变更（amendment）视图** —— 窄通道 `pipeline_scope_amend` 的可见面。
         *
         * 为什么必须出现在状态查询里：授权面被改过之后，光看"现在有哪些条目"
         * 回答不了"**谁在什么时候为什么改的**" —— 而那正是这条通道唯一的代价所在
         * （它换来的是"裁定有了、动作做不了"不再卡死）。靠翻 audit.jsonl 等于没有。
         */
        amendments: (() => {
          const list = Array.isArray(task.amendments) ? task.amendments : []
          return list.map((a) => ({
            amendment_id: a.amendment_id,
            at: a.at,
            by: a.by,
            why: a.why,
            note: a.note ?? '',
            state_at_amend: a.state_at_amend ?? null,
            added: a.added ?? [],
            removed: a.removed ?? [],
            forbidden_added: a.forbidden_added ?? [],
            forbidden_removed: a.forbidden_removed ?? [],
            before: a.before ?? null,
            after: a.after ?? null,
          }))
        })(),
        /** ★ **最近一次**授权面变更（没有就是 null）—— 一眼看出"授权面刚被谁动过"。 */
        last_amendment: (() => {
          const list = Array.isArray(task.amendments) ? task.amendments : []
          if (list.length === 0) return null
          const a = list[list.length - 1]
          return {
            amendment_id: a.amendment_id,
            at: a.at,
            by: a.by,
            why: a.why,
            state_at_amend: a.state_at_amend ?? null,
            added: a.added ?? [],
            removed: a.removed ?? [],
            forbidden_added: a.forbidden_added ?? [],
            forbidden_removed: a.forbidden_removed ?? [],
          }
        })(),
        change_manifest: task.scope_conformance?.manifest ?? [],
        scope_conformance: task.scope_conformance ?? null,
        /** ★ 设计目的（职责自限）：计划给的**角色边界卡** —— 派活按它派。 */
        role_boundaries: task.role_boundaries ?? null,
        rework: { ...task.rework, budget: task.roster?.rework_budget ?? maxRework },
        /**
         * ★ **哈希前置闸门**的可见面（用户拍板 P13 之后它多了一半内容）。
         *
         * 为什么这些必须出现在状态查询里：主对话与编写都要能**一眼**看出
         * "这道闸卡着没有、连续几次了、还剩几次就自动交人工、是不是已经交人工了"。
         * 靠读审计翻出来，等于没有。
         */
        hash_gate: {
          blocked: task.hash_gate?.blocked === true,
          streak: Number.isInteger(task.hash_gate_streak) ? task.hash_gate_streak : 0,
          threshold: hashGateEscalateAfter,
          /** 还收不收 `dev_to_test`（升级未了结 ⇒ false）。 */
          accepting_submissions: !hashGateEscalationPending(task),
          last: task.hash_gate ?? null,
          /** 每一次比对的时间与理由（最近 20 条，全量在 task.json / audit.jsonl）。 */
          checks: (task.hash_gate_checks ?? []).slice(-20).map((c) => ({
            at: c.at,
            by: c.by,
            seat: c.seat ?? null,
            pass: c.pass === true,
            streak: c.streak ?? null,
            counts: c.counts,
            violations: (c.violations ?? []).map((x) => ({ how: x.how, path: x.path })),
          })),
          checks_total: (task.hash_gate_checks ?? []).length,
          escalation: task.hash_gate_escalation ?? null,
        },
        artifact_version: version,
        artifacts: task.artifacts.map((a) => ({ version: a.version, bytes: a.bytes, sha256: a.sha256.slice(0, 16), note: a.note })),
        review_ok: ok === null ? null : { handoff_id: ok.handoff_id, artifact_version: ok.artifact_version, at: ok.created_at },
        close_report: task.close_report,
        pending_roster_requests: task.roster_requests.filter((r) => r.status === 'pending').map((r) => ({ request_id: r.request_id, by: r.by, add: r.add, remove: r.remove })),
        /**
         * ★ 两级升级梯第一级：需求分析的**收件箱**。
         * 主对话也看得到 —— 它靠这个知道"这事现在卡在内部那一级，还不用惊动用户"。
         */
        clarification_requests: (task.clarification_requests ?? []).map((r) => ({
          request_id: r.request_id,
          from_role: r.from_role,
          stage: r.stage,
          question: r.question,
          blocking: r.blocking,
          urgency: r.urgency,
          status: r.status,
          round: r.round,
          verdict: r.verdict,
          answer: r.answer,
          reason: r.reason,
          constraints_added: r.constraints_added,
          answered_at: r.answered_at,
          escalated_at: r.escalated_at,
          escalated_to: r.escalated_to,
          resumed_to: r.resumed_to,
          state_at_request: r.state_at_request,
        })),
        pending_clarifications: (task.clarification_requests ?? []).filter((r) => r.status === 'pending').map((r) => r.request_id),
        /** ★ 等待梯视图：这个任务现在到底在等谁。 */
        waiting: WAITING_STATES.includes(task.state)
          ? { waiting_for: task.state === ST.AWAITING_CLARIFICATION ? 'orchestrator' : 'human',
              waiting_zh: task.state === ST.AWAITING_CLARIFICATION ? '等需求分析裁定（还不用惊动用户）' : '等用户答复',
              will_resume_to: task.previous_state ?? null }
          : null,
        /** ★待办的人工介入请求：主对话的**收件箱**。 */
        human_requests: task.human_requests.map((r) => ({
          request_id: r.request_id,
          from_role: r.from_role,
          created_at: r.created_at,
          reason_kind: r.reason_kind,
          reason_zh: r.reason_zh,
          question_for_human: r.question_for_human,
          blocking: r.blocking,
          blocked_stage: r.blocked_stage,
          urgency: r.urgency,
          decision_kind: r.decision_kind,
          status: r.status,
          relayed_at: r.relayed_at,
          answered_at: r.answered_at,
          answer_source: r.answer_source,
          resolved_at: r.resolved_at,
          resumed_to: r.resumed_to,
          timeout_at: r.timeout_at,
          timeout_behavior: r.timeout_behavior,
          state_at_request: r.state_at_request,
          // ★ 两级升级梯：这条 human_request 是从哪条澄清请求升上来的
          escalated_from: r.escalated_from ?? null,
          raised_by: r.raised_by ?? null,
          orchestrator_reason: r.orchestrator_reason ?? null,
          escalated_from_request: (task.clarification_requests ?? []).find((c) => c.handoff_id === r.escalated_from)?.request_id ?? null,
        })),
        pending_human_requests: task.human_requests.filter((r) => r.status !== 'answered' && r.status !== 'withdrawn').map((r) => r.request_id),
        /**
         * ★ 编写席位视图：主对话与各席位都要靠它知道"分了几块、谁交完了"。
         * 单席位（count=1）也会出现，只是只有一条 —— 调用方不用分情况处理。
         */
        writers: (() => {
          const w = task.roster?.writers ?? null
          if (w === null || typeof w !== 'object') return null
          const subs = task.writer_submissions ?? {}
          const parts = Array.isArray(w.partitions) ? w.partitions : []
          return {
            count: w.count,
            max_writers: w.max_writers ?? task.roster?.max_writers ?? 1,
            reason: w.reason ?? '',
            decided_by: w.decided_by ?? 'orchestrator',
            submitted: parts.filter((p) => subs[p.seat] !== undefined).length,
            pending_seats: parts.filter((p) => subs[p.seat] === undefined).map((p) => p.seat),
            partitions: parts.map((p) => ({
              seat: p.seat,
              scope_paths: p.scope_paths,
              interface_owner: p.interface_owner,
              deliverables: p.deliverables,
              submitted: subs[p.seat] !== undefined,
              handoff_id: subs[p.seat]?.handoff_id ?? null,
              artifact_version: subs[p.seat]?.artifact_version ?? null,
              at: subs[p.seat]?.at ?? null,
            })),
          }
        })(),
        /** ★ 架构图交付（角色清单里有 diagrammer 时它是必交项，关单会查）。 */
        architecture_diagram: (() => {
          const dg = lastHandoff(task, 'architecture_diagram')
          if (dg === null) return null
          return {
            handoff_id: dg.handoff_id,
            at: dg.created_at,
            diagram_path: dg.payload?.diagram_path ?? null,
            receipt_path: dg.payload?.receipt_path ?? null,
            receipt_id: dg.payload?.receipt_id ?? null,
            html_sha256: dg.payload?.html_sha256 ?? null,
            produced_by: dg.payload?.produced_by ?? null,
            degraded: dg.payload?.degraded === true,
            degraded_reason: dg.payload?.degraded_reason ?? null,
            based_on_artifact_version: dg.payload?.based_on_artifact_version ?? null,
            covered_modules: dg.payload?.covered_modules ?? [],
            stale: version !== null && dg.payload?.based_on_artifact_version !== version,
          }
        })(),
        next_events: availableTransitions(task.state).map((t) => ({ event: t.event, to: t.to, to_zh: STATE_LABEL[t.to], by: t.by, note: t.note })),
        /**
         * ★★ **主管枢纽视图**（T-20261011-56a37e）—— 只读、按站点给出**当前缺什么**。
         *
         * 为什么要有它：用户口径③要的是「待机**要能看出来**」（可见的"已登记未开工"），
         * 而验收 5 要的是「每道站点各自留痕（谁确认、依据什么、何时）」。
         * 这两件事都必须**读得回来** —— 只在拒绝原文里出现是不够的
         * （那样"待机"只在被拦的那一刻可见，平时看不出任务停在哪）。
         *
         * ★ 它完全**派生**自 `task.hub` 与 `task.handoffs`（不另存一份状态）。
         */
        hub: (() => {
          /**
           * ★★ P0-1：**"已递单、还没发起"也是一件必须看得见的事实**。
           *
           * 改前这里只认 `hubEnabled`（= 主管已发起），于是"主对话刚把单递给主管、
           *   等主管拉起三席"这段时间在只读面上**完全不可见** —— 主对话看不出
           *   "我递出去了没有""主管动了没有"。现在把入口那一条如实报出来。
           */
          if (!hubEnabled(task)) {
            const entry = hubOf(task)?.entry ?? null
            if (entry === null) return { enabled: false, note: '本任务未启用主管枢纽（走既有链，判据强度未变）。' }
            return {
              enabled: false,
              /** ★ 入口面：谁在什么时候把这张单递给了主管（没递过时为 null）。 */
              handoff_entry: { by: entry.by ?? null, at: entry.at ?? null, via: entry.via ?? null, note: entry.note ?? '' },
              handed_over_to_supervisor: true,
              initiated_by: null,
              note: '主对话已把本单**递给主管**，等主管调 pipeline_supervise action=initiate 拉起三席（需求 / 计划 / 架构）。',
            }
          }
          const standby = hubStandby(task).map((s) => ({
            role: s?.role ?? null,
            group: s?.group ?? null,
            wake_point: s?.wake_point ?? null,
            /** ★ 就是这一栏把"已登记未开工"变成看得见的东西。 */
            status: s?.status === 'woken' ? 'woken' : 'standby',
            status_zh: s?.status === 'woken' ? '已唤醒（到点）' : '已登记待机（未开工）',
            registered_at: s?.registered_at ?? null,
            registered_by: s?.registered_by ?? null,
            woken_at: s?.woken_at ?? null,
            woken_by: s?.woken_by ?? null,
          }))
          const stationView = (st) => {
            const need = hubConfirmersOf(st)
            const target = hubStationTarget(task, st)
            const got = hubValidConfirms(task, st).map((h) => ({ from_role: h.from_role, handoff_id: h.handoff_id, at: h.created_at, decision: h.payload?.decision ?? null, artifact_version: h.payload?.artifact_version ?? null, basis_refs: h.payload?.basis_refs ?? [], basis_kind: h.payload?.basis_kind ?? null, reason: h.payload?.reason ?? null }))
            /**
             * ★★ **否掉的面**（T-20261011-56a37e 补齐）—— 与上面的 `records` 对称。
             *
             * 为什么要在这里列出来：用户裁定「否掉也**不许静默**」。否掉记录是
             * `station_confirm{decision:'ng'}`，它**本来就在 `task.handoffs` 里**；
             * 而这一小节让主对话**不必翻 handoffs** 就能看到"这一站被谁、为什么否过"，
             * 以及那一次否掉**还算不算数**（`valid_now` = 它绑的是不是当前目标）。
             */
            const ngs = hubRejectRecords(task, st).map((h) => ({
              from_role: h.from_role,
              handoff_id: h.handoff_id,
              at: h.created_at,
              artifact_version: h.payload?.artifact_version ?? null,
              reason: h.payload?.reason ?? null,
              basis_refs: h.payload?.basis_refs ?? [],
              valid_now: target !== null && h.payload?.artifact_version === target,
            }))
            return {
              station: st,
              confirmers: need,
              /** ★ 有确认方的站点才是"确认闸门"；⑤（关单交付）没有确认方 ⇒ false。 */
              is_confirm_station: need.length > 0,
              confirmed_by: got.map((x) => x.from_role),
              missing: need.filter((r) => !got.some((x) => x.from_role === r)),
              complete: need.length > 0 && need.every((r) => got.some((x) => x.from_role === r)),
              target,
              records: got,
              /** ★ 本站的否掉记录（含已过期的；`valid_now` 区分）。 */
              rejects: ngs,
              /** ★ 本站否掉预算：已用 / 上限（与 ② 道 `diagram_redraws` 同一套口径）。 */
              rejects_used: Number.isInteger(hubOf(task)?.station_rejects?.[st]) ? hubOf(task).station_rejects[st] : 0,
              rejects_budget: hubConfirmersOf(st).length > 0 ? HUB_STATION_REJECT_BUDGET : 0,
            }
          }
          return {
            enabled: true,
            initiated_by: hubOf(task)?.initiated_by ?? null,
            initiated_at: hubOf(task)?.initiated_at ?? null,
            /**
             * ★ P0-1：**入口留痕**（谁把这张单递给主管的）—— 发起之后也一直读得回来
             *   （否则"发起"会把它盖掉，"谁递的单"就不可追溯了）。
             */
            handoff_entry: hubOf(task)?.entry ?? null,
            /** ★ ②b / ②c 两个新确认点的顺序（人读面：谁先谁后，不靠猜）。 */
            handoff_confirmations: HUB_HANDOFF_CONFIRM_ORDER.map((st) => ({
              station: st,
              zh: st === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ? '架构图 → 需求位确认' : '架构图 → 主管二次确认',
              confirmers: hubConfirmersOf(st),
              advances: HUB_HANDOFF_CONFIRM_EVENTS[st],
            })),
            supervisor_declared: hubOf(task)?.supervisor_declared === true,
            standby,
            /** ★ 两个唤醒点的留痕（谁在什么时候唤醒的）。 */
            wakes: Array.isArray(hubOf(task)?.wakes) ? hubOf(task).wakes : [],
            diagram_redraws: Number.isInteger(hubOf(task)?.diagram_redraws) ? hubOf(task).diagram_redraws : 0,
            diagram_redraw_budget: HUB_DIAGRAM_REDRAW_BUDGET,
            redraw_history: Array.isArray(hubOf(task)?.redraw_history) ? hubOf(task).redraw_history : [],
            /**
             * ★★ **站点否掉的可见面**（T-20261011-56a37e 补齐）——
             *   与 `diagram_redraws` / `redraw_history` 同形，只是按站点分开计数。
             *   `reject_history` 逐条是「哪一站 · 谁 · 何时 · 为什么 · 退到哪」。
             */
            station_rejects: hubOf(task)?.station_rejects !== null && typeof hubOf(task)?.station_rejects === 'object' && !Array.isArray(hubOf(task).station_rejects)
              ? { ...hubOf(task).station_rejects }
              : {},
            station_reject_budget: HUB_STATION_REJECT_BUDGET,
            reject_history: Array.isArray(hubOf(task)?.reject_history) ? hubOf(task).reject_history : [],
            stations: [
              stationView(HUB_STATIONS.NEED_AGREE),
              stationView(HUB_STATIONS.DIAGRAM_CONFIRM),
              /**
               * ★★ P0-1：**②b / ②c 两个新确认点**（用户新口径第 7~8 跳）。
               *
               * 它们插在「架构图完成」与「交计划」之间，顺序即判据：
               *   ②道（主管首判，转交需求位）→ ②b（**需求位确认**架构图）
               *   → ②c（**主管二次确认**，唤醒点 B）→ 才轮到计划位。
               * ★ 视图用的还是**同一个** `stationView` —— 于是"谁确认 / 还缺谁 /
               *   绑的哪份图 / 有没有否掉过"这四栏自动跟着出来，不另写一套渲染。
               */
              ...HUB_HANDOFF_CONFIRM_ORDER.map((st) => stationView(st)),
              stationView(HUB_STATIONS.TEST_CONFIRM),
              stationView(HUB_STATIONS.REVIEW_CONFIRM),
            ],
            /**
             * ★ **明确"第⑤道不是确认站点"**（本单第 2 步要求③）。
             *
             * 五道站点里只有**四道**有确认方（`is_confirm_station=true`）；
             * 第⑤道（关单并交付用户）没有确认方、也不产出确认记录 ——
             * 它**就是"交付"这一步本身**（用户那句里的"确认"落在第④道：
             * 主管+需求确认之后**才**提交主对话）。
             * 这一句写死在只读面上，免得"五道硬闸门"被读成"五道确认"。
             *
             * ★ P0-1：②b / ②c 两个**交接确认点**已经并进上面的 `stations` 视图
             *   （同一个 `stationView`），所以"哪几道是确认点"在只读面上是 4 + 2 = 6 条 ——
             *   而 `not_a_confirm_station` 仍然只有第⑤道一条（它是唯一**不是**确认点的那个）。
             */
            not_a_confirm_station: [HUB_STATIONS.CLOSEOUT],
            /** 测试提前知情的可读面：测试位手上有没有那份预登记、它是什么时候拿到的。 */
            prebrief: (() => {
              const pb = lastHandoff(task, 'prebrief')
              if (pb === null) return { delivered: false, handoff_id: null, at: null }
              return {
                delivered: true,
                handoff_id: pb.handoff_id,
                at: pb.created_at,
                to_role: pb.to_role,
                plan_handoff_id: pb.payload?.plan_handoff_id ?? null,
                must_not_start_before: pb.payload?.must_not_start_before ?? null,
                not_yet_available: pb.payload?.not_yet_available ?? [],
                /** ★ 是否"提前"：预登记必须早于编写交付 —— 这是判据，不是一个形容词。 */
                before_write: lastHandoff(task, 'dev_to_test') === null,
              }
            })(),
          }
        })(),
        /**
         * ★★ **A13：被拒收的交付**（可见面）—— 2026-10-14 补齐。
         *
         * 为什么要有它：`archiveRejectedDelivery` 写进留档记录的 `recall` 字段，指的
         * 就是「`pipeline_status { task_id }` 的『被拒收的交付』一节」（`:2097`）。
         * 而这一节**此前并不存在** —— 那句文案指了一个没有的入口。
         * 这个字段就是它的落点：**拒收照旧拒收，判据一个字没动**，
         * 只是把用户对 A13 的裁定兑现 ——「要么接收，要么拒收但对席位与主对话
         * **都可见且内容留档**（能查回原文）」。
         *
         * ★ 脱敏：主对话拿到的与 `handoffs` **同一条规矩** —— **不给提交内容正文**
         *   （`payload` 里是席位交上来的原文，可能含补丁/代码正文）。
         *   给的是"交了什么、为什么被拒、原文多大、按哪个 id 取"，正文仍留在盘上。
         */
        rejected_deliveries: (Array.isArray(task.rejected_deliveries) ? task.rejected_deliveries : []).map((d) => {
          let chars = 0
          try {
            chars = d.payload === null || d.payload === undefined ? 0 : JSON.stringify(d.payload).length
          } catch {
            chars = 0
          }
          return {
            delivery_id: d.delivery_id,
            at: d.at,
            kind: d.kind,
            kind_zh: HANDOFF_SCHEMAS[d.kind]?.zh ?? d.kind,
            code: d.code,
            reason: String(d.reason ?? '').slice(0, 600),
            from_role: d.from_role,
            from_seat: d.from_seat ?? null,
            /** ★ 提交时任务在哪个状态（"在哪个窗口里被拒的"，事后一眼看得出）。 */
            state_at_submit: d.state_at_submit ?? null,
            /** ★ 原始提交内容有多少字符（留档时超长会截断并标注 —— 这里如实给出）。 */
            payload_chars: chars,
            payload_truncated_from: d.payload_truncated_from ?? null,
            /** ★ 提交内容正文：主对话默认**不给**（与 `handoffs` 同一条脱敏规矩）。 */
            payload: redact
              ? `«已隐去正文：${chars} 字符；完整留档在 task.json 的 rejected_deliveries[] 里（delivery_id=${d.delivery_id}）»`
              : (d.payload ?? null),
          }
        }),
        handoffs: task.handoffs.map((h) => (redact ? summarizeHandoff(h) : h)),
        history_tail: task.history.slice(-20),
      }
    },

    /**
     * 往本任务的 audit.jsonl 追加一行（**工具层写审计的正规入口**）。
     *
     * 为什么要有这个方法：审计行必须与任务一起落盘、并进 `task.history`，
     * 直接往文件里 append 会让内存与磁盘两份状态漂移。
     *
     * @param {string} taskId
     * @param {string} actorRole
     * @param {string} action
     * @param {object} [extra]
     */
    /**
     * ★★ **记下主对话所在会话**（`task.contacts.main`）—— 「交付即唤醒」的持久层。
     *
     * ---------------------------------------------------------------------
     * 为什么需要落盘（光有内存登记表不够）
     * ---------------------------------------------------------------------
     * 唤醒要投到"主对话那个会话"。进程内那张登记表（`lib/wakeup.js` 的
     * `createMainSessionRegistry`）**重启就没了** —— 而 DSH 重启恰恰是最常见的
     * 场景（用户关掉再打开）。重启后主对话只要再调一次 pipeline 工具就会重新登记，
     * 但**在它调之前**，机制是不知道唤醒该投到哪的。
     * 落一份 `contacts.main` 就能让这件事跨重启**可查** —— 与既有
     * `contacts.planner`（继任时登记）是同一张表、同一种形状，不新开机制。
     *
     * ★ 与 `commitSuccession` 里那张表**共用 `task.contacts` 这一个键**，
     *   所以 `pipeline_contacts` 能一处看到全部联系人。
     *
     * @param {string} taskId
     * @param {string} agentId - 主对话的会话 id（`exec.agent.id`）
     * @returns {Promise<{ok:boolean, changed:boolean, task?:object, error?:string}>}
     */
    async rememberMainContact(taskId, agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return { ok: false, changed: false, error: '主对话会话 id 是空的，不登记。' }
      }
      const task = await loadTask(taskId)
      if (task === null) return { ok: false, changed: false, error: `找不到任务 ${taskId}。` }
      task.contacts = task.contacts ?? {}
      const cur = task.contacts.main ?? null
      // ★ 没变就不写盘 —— 这个函数在**每一次** pipeline 工具调用后都会跑。
      if (cur !== null && cur.agent_id === agentId) return { ok: true, changed: false, task }
      task.contacts.main = {
        role: ROLE.MAIN,
        seat: null,
        agent_id: agentId,
        generation: (cur?.generation ?? 0) + 1,
        since: nowIso(now()),
        previous_agent: cur?.agent_id ?? null,
        why: '交付即唤醒：唤醒消息要投到主对话所在会话',
      }
      await persist(task)
      return { ok: true, changed: true, task }
    },

    /**
     * 读主对话会话 id（内存没有时回落盘上那份）。
     *
     * ★ **同步优先**：调用方（唤醒路径）先查内存登记表，查不到才来这儿。
     *   返回 `''` 表示"没登记" —— **不是异常**，调用方据此静默跳过 + 留痕。
     *
     * @param {string} taskId
     * @returns {Promise<string>}
     */
    async mainContact(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return ''
      const id = task.contacts?.main?.agent_id
      return typeof id === 'string' ? id : ''
    },

    /**
     * ★ **开对话留痕**（A1、A2、B6）：一次「开对话」请求 —— **被接受与被拒绝都留**。
     *
     * 为什么落点在这里（而不是在守门层）：守门那条路是**同步纯函数**、fail-closed、不写盘，
     * 它只能返回一句拒绝理由；而验收要的是「被拒也留痕」。所以被拒的那一侧也要能调到这里来，
     * 于是本函数把「写不进去」压到最小：**认不出的结论、缺原因的拒绝，照样产出一条记录**
     * （违约项列在 defects 里返回，不吞掉、不假装无事发生）。
     *
     * 它与 `recordDispatch` 是**两件事**，刻意不合并：
     *   · `recordDispatch` 是派活台账（失联检测按席位 upsert，**会被覆盖**）；
     *   · 本函数是**只追加**的审计行（动作名 = 名单权威层冻结的那个常量），一次请求一行，永不改写。
     * 把留痕塞进台账，就会让「重派覆盖旧记录」顺手抹掉历史 —— 那正是审计最怕的。
     *
     * 字段与顺序由名单权威层冻结（12 个平级字段，含四个槽位与 verdict、reason）；
     * `roster_version` 取当前名单的版本位，老清单没有版本位时写 null（不编造版本号）。
     *
     * @param {string|object} taskIdOrInput - 任务 id，或 { taskId, actorRole, actorSeat, targetRole, targetSeat, permission, mode, model, reasoning, verdict, reason }
     * @param {object} [maybe] - 第一个参数是字符串时，这里是那次请求的内容
     * @returns {Promise<object>}
     */
    async recordDispatchOpen(taskIdOrInput, maybe = {}) {
      const input =
        typeof taskIdOrInput === 'string' ? { ...(maybe ?? {}), taskId: taskIdOrInput } : (taskIdOrInput ?? {})
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const at = nowIso(now())
      const built = dispatchOpenRecord({ ...input, at }, task.roster ?? null, { at })
      const entry = await audit(task.id, String(input.actorRole ?? '?'), DISPATCH_OPEN_ACTION, built.record)
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, entry, record: built.record, defects: built.defects }
    },

    async recordAudit(taskId, actorRole, action, extra = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const entry = await audit(task.id, actorRole, action, extra)
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, entry }
    },

    /** 完整审计日志（读盘，不受内存缓存影响）。 */
    async auditLog(taskId) {
      const file = auditFile(taskId)
      if (!existsSync(file)) return []
      const text = await readFile(file, 'utf8')
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return { raw: l }
          }
        })
    },

    /** 守门判据用的同步查询：受保护路径（本任务工作区）。 */
    guardedRootsFor(taskId) {
      const t = cache.get(taskId)
      if (t === undefined) return []
      return [t.project_root]
    },

    /** 守门判据用：某个 agent 在某个任务里的角色。 */
    roleOfAgentSync(agentId, roleIndex) {
      if (typeof agentId !== 'string' || agentId.length === 0) return null
      if (roleIndex === undefined || roleIndex === null) return null
      const role = roleIndex.roleOfAgent(agentId)
      return role
    },

    /** 任务是否有受保护路径包含该绝对路径（守门判据）。 */
    isPathGuarded(taskId, absPath) {
      const t = cache.get(taskId)
      if (t === undefined) return false
      // 项目工作区整体受保护；但 .pipeline 自己的目录除外（工具自己要写）。
      if (!isInside(t.project_root, absPath)) return false
      if (isInside(join(t.project_root, dirName), absPath)) return false
      return true
    },

    /** 任务当前有效制品版本（对外暴露，供测试与状态展示）。 */
    async artifactVersion(taskId) {
      const t = await loadTask(taskId)
      return t === null ? null : currentArtifactVersion(t)
    },

    /** 有效审核 OK（对外暴露）。 */
    async reviewOk(taskId) {
      const t = await loadTask(taskId)
      return t === null ? null : effectiveReviewOk(t)
    },

    /** 测试用：丢掉内存缓存，强制下次从盘上读。 */
    dropCache(taskId) {
      if (taskId === undefined) {
        cache.clear()
        cacheStamp.clear()
      } else {
        cache.delete(taskId)
        cacheStamp.delete(taskId)
      }
    },

    /** 把 pathKey 暴露出去，避免使用方各自实现一份。 */
    pathKey,
  }
}
