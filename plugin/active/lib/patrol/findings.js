/**
 * dsh-pipeline · 巡检 · **纯判据**（自 `lib/patrol.js` 原样拆出，行为逐字不变）。
 *
 * 五个导出判据：`writerSeatsOfTask` / `enteredStateAtMs` / `undeliveredTransitionOf` /
 * `lastProgressAtMs` / `patrolFindings` —— 全部不读盘、不写盘、不抛（除参数本身不可读）。
 * 常量与判据表在 `./constants.js`。
 *
 * @module dsh-pipeline/lib/patrol/findings
 */

import { EXPECTED_ROLES_BY_STATE } from '../liveness.js'
import { STATE_LABEL, TERMINAL_STATES } from '../states.js'
import { DEFAULT_MAX_ESCALATION_DEPTH, escalationDepthOf, isMechanismNotice } from '../wakeledger.js'
import { relayBlockedHint, relayBlockedRole } from '../wakeup/relay-hint.js'
import {
  CONVERGED_UNRESOLVED_IDENTITY,
  DEFAULT_PATROL_FAILURE_THRESHOLD,
  DEFAULT_TASK_STALL_MS,
  DEFAULT_UNDELIVERED_TRANSITION_MS,
  MISSING_TRANSITION_KIND,
  PATROL_ACTIVE_STATES,
  SUPPRESS_REASON_LABEL,
  UNDELIVERED_TRANSITION_LEGS,
} from './constants.js'

/**
 * 与 `store.writerSeatsOf`（`store/shared.js`）**同口径**：单席位也走这里。
 * 唯一的加固：分区里缺 `seat` 时退回默认席位（读不到就不猜）。
 */
export function writerSeatsOfTask(task) {
  const w = task?.roster?.writers
  if (w === null || w === undefined || typeof w !== 'object') return ['writer#1']
  const parts = Array.isArray(w.partitions) ? w.partitions : []
  const seats = parts.map((p) => p?.seat).filter((s) => typeof s === 'string' && s.length > 0)
  return seats.length > 0 ? seats : ['writer#1']
}

/**
 * 这个状态是**什么时候进来的**：最后一次 `to === <state>` 的状态迁移的时刻。
 * ★ 读不到就 `null`（**不猜**）—— 判据宁可不报，也不误报。
 */
export function enteredStateAtMs(task, state) {
  const hist = Array.isArray(task?.history) ? task.history : []
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i]
    if (!String(h?.action ?? '').startsWith('transition:')) continue
    if (String(h?.to ?? '') !== String(state)) continue
    const t = Date.parse(String(h?.at ?? ''))
    if (Number.isFinite(t)) return t
  }
  return null
}

/** 某个类别**最新**那份交接物（读不到 = null）。 */
function latestHandoffOf(task, kind) {
  const list = Array.isArray(task?.handoffs) ? task.handoffs : []
  let best = null
  for (const h of list) {
    if (String(h?.kind ?? '') !== kind) continue
    const at = Date.parse(String(h?.created_at ?? ''))
    if (!Number.isFinite(at)) continue
    if (best === null || at > best.at) best = { h, at }
  }
  return best
}

/** 当前有效制品版本（取最新一条制品；读不到 = null）。 */
function latestArtifactVersion(task) {
  const list = Array.isArray(task?.artifacts) ? task.artifacts : []
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i]?.version
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/**
 * ★★ **"交付已落盘、出口没按"**：判一腿（纯函数，不读盘不写盘）。
 *
 * @returns {{key:string, state:string, actor:string, label:string, expected_events:string[],
 *            evidence_id:string, delivered_at_ms:number, dwell_ms:number, version:string|null,
 *            complete:boolean, submitted_seats:string[], missing_seats:string[],
 *            round_at_ms:number|null, evidence_note:string}|null} 判不出来（或正常推进中）⇒ `null`
 */
export function undeliveredTransitionOf(task, leg, { now = Date.now(), dwellMs = DEFAULT_UNDELIVERED_TRANSITION_MS } = {}) {
  if (task === null || typeof task !== 'object') return null
  if (String(task.state ?? '') !== leg.state) return null
  const enteredAt = enteredStateAtMs(task, leg.state)
  const base = { key: leg.key, state: leg.state, actor: leg.actor, label: leg.label, round_at_ms: enteredAt }

  /**
   * ---- 编写腿：主判据是**本轮席位提交表**（store 在进 developing 时清空它 ⇒ 天然"本轮"口径）
   *
   * ★★ **两种形态都判，但措辞必须分开**（这是实测 `T-20261011-5a871c` 教的一件事）：
   *   · **到齐**（`missing_seats` 为空）⇒ 「**出口没按**」：东西齐了、那一步没人发；
   *   · **没到齐** ⇒ 「**这一轮只交到 m/N**」：`dev_submitted` 的守卫要求
   *     **全部席位到齐**（`store/shared.js` 的 `checkAllSeatsSubmitted`）⇒ 那一步
   *     **现在根本发不出去**，该叫的是**还差的那几个席位**。
   *   ★ 两种都**必须报**：实测那张卡单正是"没到齐（1/3）"，而它当时
   *     **一条播报都没有** —— 这就是本条要治的漏报。
   *   ★ 措辞混用会给出**错的动作**：叫主对话去发一条会被守卫拒的迁移。
   */
  if (leg.key === 'dev_submitted') {
    const subs = task.writer_submissions !== null && typeof task.writer_submissions === 'object' ? task.writer_submissions : {}
    const seats = writerSeatsOfTask(task)
    const done = seats.filter((s) => subs[s] !== undefined && subs[s] !== null)
    if (done.length > 0) {
      let latest = null
      for (const s of done) {
        const at = Date.parse(String(subs[s]?.at ?? ''))
        if (!Number.isFinite(at)) continue
        if (latest === null || at > latest.at) latest = { at, seat: s, handoff: String(subs[s]?.handoff_id ?? '') }
      }
      if (latest === null) return null // 提交时间读不到 ⇒ 不判（不猜）
      const dwell = now - latest.at
      if (dwell < dwellMs) return null
      const missing = seats.filter((s) => !done.includes(s))
      return {
        ...base,
        expected_events: ['dev_submitted'],
        evidence_id: latest.handoff.length > 0 ? latest.handoff : `submitted@${isoAt(latest.at)}`,
        delivered_at_ms: latest.at,
        dwell_ms: dwell,
        version: latestArtifactVersion(task),
        complete: missing.length === 0,
        submitted_seats: done.slice(),
        missing_seats: missing.slice(),
        evidence_note:
          missing.length === 0
            ? `全部 ${seats.length} 个编写席位都已提交（最后一个：${latest.seat}，交接物 ${latest.handoff || '(无编号)'}）`
            : `本轮编写交付**只到 ${done.length}/${seats.length}**：已交 ${done.join('、')}（最后一个 ${latest.seat}，交接物 ${latest.handoff || '(无编号)'}），**还差 ${missing.join('、')}**`,
      }
    }
    // ---- 兜底（提交表缺失的老单）：本轮的 dev_to_test 交接物晚于"进 developing 那一刻"
    const old = latestHandoffOf(task, leg.handoff_kind)
    if (old === null || enteredAt === null || old.at <= enteredAt) return null
    const dwell = now - old.at
    if (dwell < dwellMs) return null
    return {
      ...base,
      expected_events: ['dev_submitted'],
      evidence_id: String(old.h.handoff_id ?? `dev_to_test@${isoAt(old.at)}`),
      delivered_at_ms: old.at,
      dwell_ms: dwell,
      version: latestArtifactVersion(task),
      complete: true,
      submitted_seats: [],
      missing_seats: [],
      evidence_note: `本轮的 \`dev_to_test\` 交接物（${String(old.h.handoff_id ?? '(无编号)')}，${isoAt(old.at)}）晚于进「开发中」那一刻（${isoAt(enteredAt)}）`,
    }
  }

  // ---- 测试腿 / 审核腿：判据 = 本轮的该类别交接物（版本与守卫同口径核对）
  const h = latestHandoffOf(task, leg.handoff_kind)
  if (h === null || enteredAt === null || h.at <= enteredAt) return null // 不是本轮的交付 ⇒ 不判
  const version = latestArtifactVersion(task)
  const hVersion = typeof h.h?.artifact_version === 'string' && h.h.artifact_version.length > 0 ? h.h.artifact_version : null
  // ★ 与守卫同口径：交接物针对的不是当前有效制品 ⇒ 那条迁移**本来就过不去** ⇒ 不催（`store/precondition.js`）
  if (version !== null && hVersion !== null && hVersion !== version) return null

  let expected
  let verdictNote = ''
  if (leg.key === 'test_verdict') {
    expected = ['test_passed', 'test_failed'] // ★ 通过与否是**测试位的结论**，机制不替它选
    verdictNote = '（**通过还是不通过是测试位自己的结论** —— 机制不替它判断，两个候选都列出来）'
  } else {
    const conclusion = String(h.h?.payload?.conclusion ?? '')
    const rejectTo = String(h.h?.payload?.reject_to ?? '')
    if (conclusion === 'OK') {
      expected = ['review_ok']
    } else {
      expected = [rejectTo === 'tester' ? 'review_ng_test' : 'review_ng_dev']
      verdictNote = `（交接物里写的结论是 \`${conclusion || '(空)'}\`，打回对象 \`${rejectTo || '(空)'}\`）`
    }
  }
  const dwell = now - h.at
  if (dwell < dwellMs) return null
  return {
    ...base,
    expected_events: expected,
    evidence_id: String(h.h?.handoff_id ?? `${leg.handoff_kind}@${isoAt(h.at)}`),
    delivered_at_ms: h.at,
    dwell_ms: dwell,
    version: hVersion ?? version,
    complete: true,
    submitted_seats: [],
    missing_seats: [],
    evidence_note: `本轮的 \`${leg.handoff_kind}\` 交接物（${String(h.h?.handoff_id ?? '(无编号)')}，${isoAt(h.at)}）${verdictNote}`,
  }
}

/** 这条"没投出去"是不是上面那一类（⇒ 身份收敛、不按次计）。 */
function isConvergedUnresolved(e) {
  return (
    String(e?.kind ?? '') === CONVERGED_UNRESOLVED_IDENTITY.kind &&
    String(e?.reason ?? '') === CONVERGED_UNRESOLVED_IDENTITY.reason
  )
}

/** 毫秒 → ISO（秒级，与项目其它留痕同口径）。 */
function isoAt(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 从任务台账里取「最后一次进展」的时刻（毫秒；取不到时 null，**不猜**）。 */
export function lastProgressAtMs(task) {
  const stamps = []
  const take = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      stamps.push(v)
      return
    }
    if (typeof v === 'string' && v.length > 0) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) stamps.push(t)
    }
  }
  for (const h of Array.isArray(task?.handoffs) ? task.handoffs : []) take(h?.created_at)
  for (const a of Array.isArray(task?.artifacts) ? task.artifacts : []) take(a?.created_at ?? a?.at)
  for (const r of Array.isArray(task?.records) ? task.records : []) take(r?.at)
  for (const r of Array.isArray(task?.context_reports) ? task.context_reports : []) take(r?.at)
  for (const r of Array.isArray(task?.human_requests) ? task.human_requests : []) take(r?.resolved_at ?? r?.at)
  for (const r of Array.isArray(task?.clarification_requests) ? task.clarification_requests : []) take(r?.resolved_at ?? r?.at)
  const hist = Array.isArray(task?.history) ? task.history : []
  for (let i = hist.length - 1; i >= 0; i--) {
    take(hist[i]?.at)
    if (stamps.length > 0) break
  }
  // ★ 派活也是一种"有人动过"的证据（否则"刚派完活、席位还在读文件"会被误判成无进展）。
  for (const d of Array.isArray(task?.dispatched) ? task.dispatched : []) take(d?.at)
  if (stamps.length === 0) return null
  return Math.max(...stamps)
}

/**
 * ★★ **一次巡检的纯判据**（不读盘、不写盘、不抛）。
 *
 * @param {object} spec
 * @param {object|null} spec.task
 * @param {number} [spec.now]
 * @param {number} [spec.stallMs] - 任务无进展口径
 * @param {Array<object>} [spec.unconsumed] - `wakeup.pendingDeliveries()` 的结论
 * @param {Array<object>} [spec.unresolved] - 账本里"没投出去"的事件
 * @param {number} [spec.undeliveredTransitionMs] - "交付已落盘、出口没按"的口径
 * @param {number} [spec.patrolFailures] - 巡检自身连续失败次数
 * @param {number} [spec.failureThreshold]
 * @returns {{findings:Array<object>, suppressed:Array<object>, terminal:boolean, stalled_ms:number|null, state:string, note:string}}
 */
export function patrolFindings(spec = {}) {
  const task = spec.task !== null && typeof spec.task === 'object' ? spec.task : null
  const now = Number.isFinite(spec.now) ? spec.now : Date.now()
  const stallMs = Number.isFinite(spec.stallMs) && spec.stallMs > 0 ? spec.stallMs : DEFAULT_TASK_STALL_MS
  /**
   * ★ `candidates` = 判据判出来的**全部事实**；`findings` = 其中**该播报**的那些。
   *   两者之差落进 `suppressed`（**只记账不播报**，每条都带原因）——
   *   收敛不等于静默：被压下去的那几条在这里一条不少地列着。
   */
  const candidates = []
  const suppressed = []
  /** 收敛过身份的"没投出去"本轮已出过哪些（同类别不重复列）。 */
  const seenConverged = new Set()
  if (task === null) {
    return { findings: [], suppressed, terminal: false, stalled_ms: null, state: '', note: '任务读不到 —— 本次不判（不猜）。' }
  }

  const state = String(task.state ?? '')
  const terminal = Array.isArray(TERMINAL_STATES) ? TERMINAL_STATES.includes(state) : false
  const last = lastProgressAtMs(task)
  const stalled = last === null ? null : Math.max(0, now - last)
  const active = PATROL_ACTIVE_STATES.includes(state)

  if (active && stalled !== null && stalled >= stallMs) {
    candidates.push({
      /**
       * ★ **身份 = 内容派生的**：`<任务>|task-stall|<状态>|<最后一次进展时刻>`。
       *   同一段无进展跨多次巡检 ⇒ 同一个 id ⇒ 播报被幂等吃掉（A23）；
       *   进展恢复后再卡住 ⇒ 时刻变了 ⇒ **新的一条**（不永久哑掉）。
       */
      id: `${String(task.id ?? '')}|task-stall|${state}|${isoAt(last)}`,
      kind: 'task-stall',
      at: isoAt(now),
      stalled_ms: stalled,
      detail:
        `任务「${STATE_LABEL[state] ?? state}」已经 **${Math.round(stalled / 60000)} 分钟**没有任何进展` +
        `（最后一次进展 ${isoAt(last)}；口径 ${Math.round(stallMs / 60000)} 分钟）。` +
        `该动的角色：${(EXPECTED_ROLES_BY_STATE[state] ?? []).join('、') || '(无)'}`,
    })
  }

  /**
   * ★★ **"交付已落盘、出口没按"**（本轮追加的那条：实测三次复现的机制层缺口）。
   *
   * 与上面那条 `task-stall` **判据不同源、互不冒充**：
   *   · `task-stall` 问的是「**多久没人动**」；
   *   · 本条问的是「**东西已经交齐了、那一步出口没人按**」—— 交付本身算进展，
   *     所以卡在这种形态上的单**根本不会**触发 `task-stall`（实测就是这么漏掉的）。
   * ★ 它落进 `candidates` ⇒ 自动吃到函数末尾的**终态闸**（终态单永不播，P0-3①/P2-11 不许被破）。
   */
  const undeliveredDwellMs = Number.isFinite(spec.undeliveredTransitionMs) && spec.undeliveredTransitionMs > 0
    ? spec.undeliveredTransitionMs
    : DEFAULT_UNDELIVERED_TRANSITION_MS
  for (const leg of UNDELIVERED_TRANSITION_LEGS) {
    const hit = undeliveredTransitionOf(task, leg, { now, dwellMs: undeliveredDwellMs })
    if (hit === null) continue
    const who = hit.expected_events.join(' / ')
    /** 这一轮是从哪一刻开始的（用来把身份钉在"本轮"上；读不到就退回交付证据）。 */
    const roundTag = Number.isFinite(hit.round_at_ms) ? `round@${isoAt(hit.round_at_ms)}` : hit.evidence_id
    /**
     * ★ 两种形态的**动作建议必须分开**（措辞混用 = 给出错的动作）：
     *   · 到齐 ⇒ 叫这个席位**补发那一步**；
     *   · 没到齐 ⇒ 先叫**还差的那几个席位**（那一步现在发不出去）。
     */
    const advice = hit.complete
      ? `**叫醒该席位补发**（重派 / \`pipeline_dispatch { notify_only: true }\` 提醒它发 ` +
        `\`pipeline_transition { event: "${hit.expected_events[0]}" }\`${hit.expected_events.length > 1 ? `，若结论是另一条就发 ${hit.expected_events.slice(1).map((e) => `\`${e}\``).join(' / ')}` : ''}）` +
        (hit.key === 'dev_submitted'
          ? '；或由**主对话直接代发** `pipeline_transition { event: "main_dev_submitted" }`（守卫与 dev_submitted 同源，审计记为主对话代发）'
          : '')
      : `**先叫醒还差的那几个席位**（${hit.missing_seats.join('、')}）把他们那份交了 —— ` +
        `\`pipeline_transition { event: "${hit.expected_events[0]}" }\` 现在**发不出去**（守卫要求全部席位到齐，\`store/precondition.js\`）；` +
        `到齐之后再让任一编写席位补发那一步`
    candidates.push({
      /**
       * ★★ **身份 = 内容派生的**：`<任务>|missing-transition|<状态>|<该发的事件>|<本轮>`。
       *
       * ★ **去重与冷却就靠它**（这是本条被点名的要求）：
       *   · **同一轮里跨多次巡检、甚至跨多次席位提交** ⇒ **同一个 id**
       *     （交付时间、已交几个席位**只进正文，不进身份**）
       *     ⇒ ① `index.js:622` 那个 30 分钟内存窗吃掉重复，
       *        ② 跨进程由**已播报账本**的 `hasDelivered` 吃掉 ⇒ **同一轮至多播一次**；
       *   · 打回后**新一轮**（重新进 developing）⇒ `round@…` 变了 ⇒ **新 id** ⇒ 会再报（**不会永久哑掉**）；
       *   · 那一步真发了（状态变了）⇒ 这一腿的 `state` 对不上 ⇒ **一条都不再出**。
       */
      id: `${String(task.id ?? '')}|${MISSING_TRANSITION_KIND}|${hit.state}|${hit.expected_events.join('+')}|${roundTag}`,
      kind: MISSING_TRANSITION_KIND,
      at: isoAt(now),
      leg: hit.key,
      state: hit.state,
      actor: hit.actor,
      expected_events: hit.expected_events,
      /** ★ 本轮交付到齐没有（false = 那一步现在**发不出去**，该叫的是缺的那几个席位）。 */
      complete: hit.complete,
      submitted_seats: hit.submitted_seats,
      missing_seats: hit.missing_seats,
      artifact_version: hit.version,
      evidence_id: hit.evidence_id,
      delivered_at: isoAt(hit.delivered_at_ms),
      dwell_ms: hit.dwell_ms,
      detail:
        `**${hit.label} 这一步没人按**：${hit.actor} 的交付**已经落盘**，任务却还停在「${STATE_LABEL[hit.state] ?? hit.state}」——` +
        (hit.complete
          ? ` **该发 \`${who}\` 了**`
          : ` **本轮交付只到 ${hit.submitted_seats.length}/${hit.submitted_seats.length + hit.missing_seats.length}，\`${who}\` 现在发不出去**`) +
        `（交付后已过 **${Math.round(hit.dwell_ms / 60000)} 分钟**；口径 ${Math.round(undeliveredDwellMs / 60000)} 分钟）。\n` +
        `证据：${hit.evidence_note}${hit.version === null ? '' : `；制品版本 ${hit.version}`}。\n` +
        (hit.complete
          ? `★ 这**不是**"没人干活"，是**出口没按**：交付齐了、状态机那一步没人发 ⇒ 整条流水线停在这里。\n`
          : `★ 这**不是**"没人盯着"，是**交付没齐**：到齐之前 \`${hit.expected_events[0]}\` 过不去 ⇒ 整条流水线停在这里。\n`) +
        `★ 建议：${advice}。\n` +
        `★ 这一条迁移**只允许 ${hit.actor}** 发（\`states.js\` 的 \`by\` 写死），**主对话代发会被状态机拒** —— 要放开代发属授权面变更（见实现报告的 A 路建议）。`,
    })
  }

  for (const e of Array.isArray(spec.unconsumed) ? spec.unconsumed : []) {
    const key = String(e.key ?? '')
    const id = `${String(task.id ?? '')}|unconsumed-delivery|${key}`
    /**
     * ★ 下面两道只在**非终态**单上判：终态单整条退出播报面（见本函数末尾），
     *   它的每一条都该报出**同一个**原因（`terminal-state`），不该被更细的分支改写。
     */
    if (!terminal) {
      /**
       * ★★ **P0-3②：到深度上限的派生键不再报、也不再升。**
       *   （上游 `wakeup.pendingDeliveries` 已经滤过一道；这里是**第二道**，
       *   手喂进来的清单同样挡住 —— 活锁的断开点不许只有一个。）
       */
      const depth = escalationDepthOf(key)
      if (depth >= DEFAULT_MAX_ESCALATION_DEPTH) {
        suppressed.push({
          id,
          kind: 'unconsumed-delivery',
          reason: 'depth-capped',
          detail: `\`${key}\` 已经是**第 ${depth} 层升级派生物**（上限 ${DEFAULT_MAX_ESCALATION_DEPTH} 层）—— 只记账，不再唤醒（P0-3②）。`,
        })
        continue
      }
      /**
       * ★★ **P0-3③：机制自己的通知不是"等待接管的交付"。**
       *   拿巡检播报 / 升级叫醒再报一条"这条没人接管"，就是那场套娃的每一层
       *   （实测同一张单的交付键 123 → 213 → 301 字符，逐层加深）。
       */
      if (isMechanismNotice(e)) {
        suppressed.push({
          id,
          kind: 'unconsumed-delivery',
          reason: 'mechanism-notice',
          detail: `\`${key}\` 是**机制自己发出去的通知**（不是谁交的一份东西）—— 再报一次就是套娃（P0-3③）。`,
        })
        continue
      }
    }
    // ★ §9 噪声 ④：投递方按继任策略不可换班 ⇒ 正文给出可执行的下一步（升级链那边不再升它）。
    const relayBlocked = relayBlockedRole(task, e)
    candidates.push({
      id,
      kind: 'unconsumed-delivery',
      at: isoAt(now),
      key,
      age_ms: Number.isFinite(e.age_ms) ? e.age_ms : null,
      detail:
        `一条投递**已送达但没人接管**：\`${key}\`（投给 ${String(e.target ?? '(未知)')}，` +
        `${Number.isFinite(e.age_ms) ? `${Math.round(e.age_ms / 1000)} 秒` : '时长未知'}前）` +
        ' —— 送达不等于接管（A28）。' +
        (relayBlocked === null ? '' : `\n${relayBlockedHint(relayBlocked)}`),
      ...(relayBlocked === null ? {} : { relay_blocked: relayBlocked.role }),
    })
  }

  for (const e of Array.isArray(spec.unresolved) ? spec.unresolved : []) {
    const kind = String(e.kind ?? '')
    const reason = String(e.reason ?? '')
    const converged = isConvergedUnresolved(e)
    const id = converged
      ? `${String(task.id ?? '')}|unresolved-wake|${kind}|${reason}`
      : `${String(task.id ?? '')}|unresolved-wake|${String(e.at ?? '')}|${kind}|${reason}`
    /**
     * ★ 收敛过的身份在同一轮里**只出一条**：一轮里两条同类别本来就会撞成同一个键
     *   （账本那一道会吃掉第二条），在这里先合掉 —— 免得白跑一次投递、也免得
     *   日志里出现"播了两条其实是同一条"的假象。
     * ★ 这一道只在**非终态**单上判：终态单的每一条都该报出**同一个**原因
     *   （`terminal-state`，见本函数末尾），账上不混第二种原因。
     */
    if (!terminal && converged && seenConverged.has(id)) {
      suppressed.push({
        id,
        kind: 'unresolved-wake',
        reason: 'converged-duplicate',
        detail: `这一类（${kind} / ${reason}）本轮**已经有一条**了 —— 同一条事实的第 N 次重复不再单列（P2-12）。`,
      })
      continue
    }
    if (converged) seenConverged.add(id)
    candidates.push({
      /**
       * ★★ **P2-12：这一类的身份收敛到「类别 + 原因」**（不含那一次的时刻）⇒
       *   同一张单**至多播一条**，而不是"每来一条人工介入请求就必来一条"。
       *   别的类别仍是**一次一条**（`<时刻>` 进身份）—— 那些是真失败，不许被合并掉。
       */
      id,
      kind: 'unresolved-wake',
      at: isoAt(now),
      converged,
      detail:
        `一条唤醒**没有投出去**（${reason}，类别 ${kind}，` +
        `${String(e.at ?? '')}）—— 这是"该叫没叫"，不是静默（A8）。` +
        (converged
          ? '\n★ 这一类的身份**收敛到「类别 + 原因」**：机制不能对"人"说话，主对话是唯一传话人，' +
            '所以这类"没投出去"是**结构性的、必然的** —— 同一张单至多播一条（P2-12）。'
          : ''),
    })
  }

  const threshold = Number.isFinite(spec.failureThreshold) && spec.failureThreshold > 0
    ? spec.failureThreshold
    : DEFAULT_PATROL_FAILURE_THRESHOLD
  const failures = Number.isFinite(spec.patrolFailures) ? spec.patrolFailures : 0
  if (failures >= threshold) {
    candidates.push({
      /**
       * ★ 停摆也是**一条事实**，有自己的身份：同一段停摆只播一次；
       *   恢复之后**再**停摆是 `stall_episodes` 的下一号 ⇒ **新的一条**（不会永久哑掉）。
       */
      id: `${String(spec.patrolOwner ?? 'patrol')}|patrol-stalled|${Number.isFinite(spec.stallEpisodes) ? spec.stallEpisodes : 1}`,
      kind: 'patrol-stalled',
      at: isoAt(now),
      detail: `巡检自身已连续失败 ${failures} 次（阈值 ${threshold}）—— **巡检已停摆**（A25：停摆本身必须可见）。`,
    })
  }

  /**
   * ★★ **P0-3① / P2-11：终态单整条退出播报面。**
   *
   * 已取消 / 已关闭的单**没有"该动的角色"**，状态机也明示「**无合法事件**」——
   * 于是没有任何动作能"消费"这些播报 ⇒ 再播就是**无限套娃**（实测同一张已取消单
   * 被连播 6 层、42 条已播报里 26 条是这个来源）。
   * ⇒ 判定照旧做，**一条都不播**；每条都落进 `suppressed`（带 `terminal-state` 原因），
   *   底账本来就在盘上（`unresolved` 那几行是 `noteUnresolved` 当时写下的，一个字没动）。
   */
  const findings = []
  for (const c of candidates) {
    if (terminal) {
      suppressed.push({
        id: c.id,
        kind: c.kind,
        reason: 'terminal-state',
        detail: `${String(c.detail ?? '')}\n★ 未播报：任务处于终态「${STATE_LABEL[state] ?? state}」—— 终态单不进巡逻与升级链（P0-3①/P2-11），这条**只记账**。`,
      })
      continue
    }
    findings.push(c)
  }

  const counts = new Map()
  for (const s of suppressed) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  const tail = suppressed.length === 0
    ? ''
    : `　★ 只记账不播报 ${suppressed.length} 条（` +
      [...counts.entries()].map(([r, n]) => `${SUPPRESS_REASON_LABEL[r] ?? r} ${n}`).join(' / ') +
      '）—— 收敛不是静默：原因逐条见 `suppressed[]`'

  return {
    findings,
    suppressed,
    terminal,
    stalled_ms: stalled,
    state,
    note:
      `状态 ${state || '(未知)'}　最后进展 ${last === null ? '(读不到)' : isoAt(last)}　` +
      `无进展 ${stalled === null ? '(未知)' : `${Math.round(stalled / 1000)} 秒`}（口径 ${Math.round(stallMs / 1000)} 秒）　` +
      `待播报 ${findings.length} 条${tail}`,
  }
}
