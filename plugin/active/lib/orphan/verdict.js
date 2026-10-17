/**
 * dsh-pipeline · 孤儿单自恢复 · 判词（只读目录 / 候选 / 判定 / 重投正文）
 * ============================================================================
 * 从 `lib/orphan.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/orphan.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/orphan/verdict
 */

import {
  EXPECTED_ROLES_BY_STATE,
  SESSION_LOG_NAME,
  activityOfSamples,
  evidenceOfLife,
  formatDuration,
  msOf,
  seatKey,
} from '../liveness.js'
import { roleLabel } from '../roles.js'
import { STATE_LABEL, TERMINAL_STATES } from '../states.js'
import {
  DEFAULT_MAX_REDELIVER_ATTEMPTS,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_ORPHAN_SWEEP_MS,
  DEFAULT_REDELIVER_BACKOFF_MS,
  MECHANISM_BOOKKEEPING_ACTIONS,
  ORPHAN_ELIGIBLE_STATES,
  ORPHAN_IDLE_STATES,
  ORPHAN_KINDS,
} from './constants.js'
import {
  judgeView,
  lastEvidenceAtMs,
  lastSeatOutput,
  zeroEvidenceOf,
} from './evidence.js'

/**
 * 毫秒 → ISO（秒级，与项目其它留痕同口径）。
 * ★ 内部共享：`verdict.js` 与 `rescue.js` 都用它，**不**经 `lib/orphan.js` 转出。
 */
export function isoAt(ms) {
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
