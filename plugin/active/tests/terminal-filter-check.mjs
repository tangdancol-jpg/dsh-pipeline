/**
 * dsh-pipeline · **终态过滤包**自测（P0-3 活锁 / P2-11 刷屏 / P2-12 噪音收敛）
 * ============================================================================
 *     node tests/terminal-filter-check.mjs            # 全套
 *
 * ---------------------------------------------------------------------------
 * 这一套盯的是「**播报这件事本身又变成新交付**」那条活锁的三个断开点
 * ---------------------------------------------------------------------------
 *   · **① 终态单整条退出播报面**（P0-3①/P2-11）—— 已取消/已关闭的单没有
 *     "该动的角色"，状态机也明示「无合法事件」⇒ 没有任何动作能"消费"播报
 *     ⇒ 播了就没完（实测同一张已取消单被连播 6 层）；
 *   · **② 升级不派生升级**（深度上限：原事件 + 1 层封顶）；
 *   · **③ 机制自己的通知不当作新交付**（收敛到根事件）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么"正例 + 反例"两条都必须跑（反例跑不过 = 实现是错的）
 * ---------------------------------------------------------------------------
 *   正例（终态单不再进链）**单独通过是没有意义的** —— 把播报整个关掉也能通过。
 *   所以这一套**成对**断言：
 *     · 正例：终态单 ⇒ `findings` 一条都没有（且每条都进了 `suppressed`，带原因）；
 *     · 反例：**同一份输入、只把状态换成活的** ⇒ 三条播报一条不少地照旧出来，
 *       `suppressed` 为空；且"该叫没叫"的升级**照旧发生一次**（契约没被削掉）。
 *
 * ---------------------------------------------------------------------------
 * ★ 它是密闭的（判据：不读活体数据）
 * ---------------------------------------------------------------------------
 *   · 夹具里的"套娃键"是**从真实账本 `wake-ledger.jsonl` 逐字抄下来的**
 *     （T-20261014-hello01 那几条），但**不从盘上读**它 ⇒ 本套不随线上数据变红变绿；
 *   · 全程临时目录，跑完即删；不碰线上任务数据、会话目录与真账本。
 *
 * @module dsh-pipeline/tests/terminal-filter-check
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createWakeLedger, LEDGER_FILE_NAME, DEFAULT_MAX_ESCALATION_DEPTH, MECHANISM_NOTICE_KINDS } from '../lib/wakeledger.js'
import { createWaker, createMainSessionRegistry } from '../lib/wakeup.js'
import { patrolFindings, DEFAULT_TASK_STALL_MS, MISSING_TRANSITION_KIND, DEFAULT_UNDELIVERED_TRANSITION_MS } from '../lib/patrol.js'

// ---------------------------------------------------------------------------
// 断言小工具（与其它自测同形状：只记 pass/detail，不抛）
// ---------------------------------------------------------------------------

const tmpRoots = []
function tmpDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `dsh-termfilter-${tag}-`))
  tmpRoots.push(d)
  return d
}
function cleanup() {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
}

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

const rec = createRecorder()

// ---------------------------------------------------------------------------
// 假宿主（与 wake-channel-check 同形：只要能"看见投递"就够）
// ---------------------------------------------------------------------------

function fakeHost() {
  const delivered = []
  const sessions = new Map()
  const ensure = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        inbox: { nextTurn: [], nextStep: [] },
        followup(msg) {
          this.inbox.nextTurn.push(msg)
          delivered.push({ sessionId: id, message: msg })
        },
      })
    }
    return sessions.get(id)
  }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'agents') return { get: (id) => sessions.get(id) ?? undefined }
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            ensure(request.sessionId).followup({ id: `prompt-${request.requestId}`, role: 'user', content: request.content })
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, ensure, delivered }
}

/** 一块最小任务台账（只放本套要用的字段）。 */
function seedTask(over = {}) {
  return {
    id: 'T-TERMFILTER-1',
    state: 'developing',
    handoffs: [],
    artifacts: [],
    records: [],
    clarification_requests: [],
    human_requests: [],
    history: [],
    dispatched: [],
    liveness: { escalations: [], aborts: [] },
    ...over,
  }
}

const auditSink = () => {
  const lines = []
  return { lines, audit: async (taskId, action, detail) => lines.push({ taskId, action, detail }) }
}

function makeWaker({ ledger, task, host = fakeHost() }) {
  const registry = createMainSessionRegistry()
  registry.remember(task.id, 'session-main-1', 'test')
  host.ensure('session-main-1')
  const waker = createWaker({
    ctx: host.ctx,
    registry,
    ledger,
    getTask: () => task,
    audit: auditSink().audit,
    warn: () => {},
  })
  return { waker, host, registry }
}

// ---------------------------------------------------------------------------
// 交付键夹具：**从真实账本逐字抄下来的**那几条套娃键（T-20261014-hello01，已取消）
// ---------------------------------------------------------------------------

const T = 'T-20261014-hello01'

/** 一条**正常的**交付（有人交了一份东西 —— 非机制通知）。 */
const KEY_ROOT_HANDOFF = `${T}|handoff|writer#1|H-9`

/** 第一层：没投出去（human / no-stable-identity）。 */
const KEY_UNRESOLVED = `${T}|unresolved-wake|mechanism|${T}|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity`

/** 第二层：升级叫醒（原键 + `#escalated`）。 */
const KEY_ESCALATION = `${T}|escalation|mechanism|${KEY_UNRESOLVED}#escalated`

/** 第三~六层：巡检对着**自己刚发的那条**再报"这条没人接管"（这就是套娃）。 */
const KEY_L3 = `${T}|unconsumed-delivery|mechanism|${KEY_UNRESOLVED}`
const KEY_L4 = `${T}|unconsumed-delivery|mechanism|${KEY_ESCALATION}`
const KEY_L5 = `${T}|unconsumed-delivery|mechanism|${KEY_L3}`
const KEY_L6 = `${T}|unconsumed-delivery|mechanism|${KEY_L5}`

/**
 * ★ 键里**套了几层机制通知**（这就是活锁的可量测形态）。
 *
 * 只数 `<类别>|mechanism|` 这种**完整的通知段**：
 *   · 根事件（`T|handoff|writer#1|H-9`）           ⇒ 0
 *   · 第一层播报（`T|unconsumed-delivery|mechanism|<finding.id>`）⇒ 1
 *     （判别子里虽然含 `|unconsumed-delivery|`，但后面跟的不是 `mechanism|`，不算）
 *   · 拿上面那条**再报一次**（真实账本里那 301 字符的键）⇒ 2 —— 这才是套娃。
 */
function noticeNestingOf(key) {
  const m = String(key).match(
    /\|(?:escalation|unconsumed-delivery|unresolved-wake|task-stall|patrol-stalled)\|mechanism\|/g,
  )
  return m === null ? 0 : m.length
}

/** 升级层数（与 `lib/wakeledger.js` 的 `escalationDepthOf` 同口径：数 `#escalated`）。 */
function escalatedDepthOf(key) {
  const m = String(key).match(/#escalated/g)
  return m === null ? 0 : m.length
}

const stale = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// ===========================================================================
// A) 正例：终态单**整条**退出播报面（P0-3① / P2-11）
// ===========================================================================

function checkTerminalIsSilent() {
  const G = 'A 正例｜终态单不再进链（P0-3① / P2-11）'
  const now = Date.now()
  const feed = {
    // ★ 把**真实那几条套娃键**整批喂进去（它们本来就是从这张已取消的单上长出来的）。
    unconsumed: [
      { key: KEY_L6, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 },
      { key: KEY_ROOT_HANDOFF, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 },
    ],
    unresolved: [
      { at: '2026-10-13T18:20:24Z', kind: 'human', reason: 'no-stable-identity' },
      { at: '2026-10-13T18:24:55Z', kind: 'human', reason: 'no-stable-identity' },
    ],
  }

  for (const state of ['cancelled', 'closed']) {
    const task = seedTask({ id: T, state, history: [{ at: stale(3600_000), action: 'transition:cancel', actor: 'main' }] })
    const res = patrolFindings({ task, now, stallMs: DEFAULT_TASK_STALL_MS, ...feed })
    rec.add(
      G,
      `① ★★ 终态「${state}」⇒ \`findings\` **一条都没有**（交付键本身即证据：这张单的套娃键整批喂进来也不播）`,
      res.findings.length === 0 && res.terminal === true,
      `findings=${JSON.stringify(res.findings.map((f) => f.kind))} terminal=${res.terminal}`,
    )
    rec.add(
      G,
      `② ★★ 但**判定照旧做**：每条都落进 \`suppressed\`，原因一律 \`terminal-state\`（收敛不是静默）`,
      res.suppressed.length === 4 && res.suppressed.every((s) => s.reason === 'terminal-state' && String(s.detail).length > 20),
      `suppressed=${res.suppressed.length} reasons=${JSON.stringify([...new Set(res.suppressed.map((s) => s.reason))])}`,
    )
    rec.add(
      G,
      `③ ★ note 里**写明了"只记账不播报几条 + 为什么"**（人读的那一句不许是空白）`,
      String(res.note).includes('只记账不播报 4 条') && String(res.note).includes('终态 4'),
      String(res.note),
    )
  }

  // --- ④ 终态单连"无进展"也不播（原先只有这一支被滤，其余两支漏了 —— 那正是 P2-11）
  const stalledTerminal = seedTask({ id: T, state: 'cancelled', history: [{ at: stale(3600_000), action: 'transition:cancel', actor: 'main' }] })
  const r4 = patrolFindings({ task: stalledTerminal, now, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(
    G,
    '④ ★★ 终态单连 `task-stall` 也**不播**（滤的是**整条播报面**，不是"少报一类"）',
    r4.findings.length === 0,
    `findings=${JSON.stringify(r4.findings.map((f) => f.kind))} suppressed=${JSON.stringify(r4.suppressed.map((s) => s.kind))}`,
  )

  // --- ⑤ 终态单连"巡检自己停摆"也不往它头上播（停摆由 A25 的 onStalled 另走一条路）
  const r5 = patrolFindings({ task: stalledTerminal, now, stallMs: DEFAULT_TASK_STALL_MS, patrolFailures: 9, failureThreshold: 3 })
  rec.add(
    G,
    '⑤ ★ 终态单不接 `patrol-stalled`（停摆那条事实有自己的出口 `onStalled`，不必往死单上播）',
    r5.findings.length === 0 && r5.suppressed.some((s) => s.kind === 'patrol-stalled'),
    `suppressed kinds=${JSON.stringify(r5.suppressed.map((s) => s.kind))}`,
  )
}

// ===========================================================================
// B) 反例：**非终态**单仍会正常播报（这条跑不过 ⇒ 实现是错的）
// ===========================================================================

function checkLiveStillReports() {
  const G = 'B 反例｜活的单仍然照播（契约没被削掉）'
  const now = Date.now()
  const task = seedTask({ id: T, state: 'developing', history: [{ at: stale(3600_000), action: 'transition:dispatch_writer', actor: 'main' }] })

  const res = patrolFindings({
    task,
    now,
    stallMs: DEFAULT_TASK_STALL_MS,
    unconsumed: [{ key: KEY_ROOT_HANDOFF, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 }],
    unresolved: [{ at: '2026-10-13T18:24:55Z', kind: 'human', reason: 'no-stable-identity' }],
  })
  const kinds = res.findings.map((f) => f.kind)
  rec.add(
    G,
    '① ★★ 反例：**同一份输入、状态换成活的** ⇒ 三条照旧全出（task-stall / unconsumed-delivery / unresolved-wake）',
    kinds.includes('task-stall') && kinds.includes('unconsumed-delivery') && kinds.includes('unresolved-wake') && res.suppressed.length === 0,
    `findings=${JSON.stringify(kinds)} suppressed=${res.suppressed.length}`,
  )
  rec.add(
    G,
    '② ★★ "投不出去/该叫没叫必须报出来"这条契约**一个字没动**：unresolved-wake 的正文仍然写着"没有投出去"',
    String(res.findings.find((f) => f.kind === 'unresolved-wake')?.detail ?? '').includes('没有投出去'),
    String(res.findings.find((f) => f.kind === 'unresolved-wake')?.detail ?? '').slice(0, 120),
  )
  rec.add(
    G,
    '③ ★ 正常的交付（`handoff`，不是机制通知）照旧进"已送达但没人接管"播报',
    res.findings.some((f) => f.kind === 'unconsumed-delivery' && f.key === KEY_ROOT_HANDOFF),
    JSON.stringify(res.findings.filter((f) => f.kind === 'unconsumed-delivery').map((f) => f.key)),
  )

  // --- ④ 反例中的反例：等待态里"没进展"仍然不报（A23 的老口径一个字没动）
  const waiting = seedTask({ id: T, state: 'awaiting_human', history: [{ at: stale(3600_000), action: 'transition:human_request', actor: 'writer' }] })
  const r4 = patrolFindings({ task: waiting, now, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(
    G,
    '④ ★ 等待态（等用户）仍然不报"任务无进展"（既有口径没被这次改动碰过）',
    r4.findings.length === 0,
    `findings=${JSON.stringify(r4.findings.map((f) => f.kind))}`,
  )

  // --- ⑤ P2-12 的收敛是**定向**的：别的类别一次一条，不许被合并掉
  const r5 = patrolFindings({
    task,
    now,
    unresolved: [
      { at: '2026-10-13T18:20:24Z', kind: 'human', reason: 'no-stable-identity' },
      { at: '2026-10-13T18:24:55Z', kind: 'human', reason: 'no-stable-identity' },
      { at: '2026-10-13T18:30:00Z', kind: 'handoff', reason: 'no-stable-identity' },
      { at: '2026-10-13T18:31:00Z', kind: 'handoff', reason: 'no-stable-identity' },
    ],
  })
  const uw = r5.findings.filter((f) => f.kind === 'unresolved-wake')
  rec.add(
    G,
    '⑤ ★★ P2-12 收敛是**定向**的：human/no-stable-identity 两次**合并成一条**（id 不含时刻），别的类别仍**一次一条**',
    uw.length === 3 && new Set(uw.map((f) => f.id)).size === 3 && uw.filter((f) => f.converged === true).length === 1,
    `条数=${uw.length}（期望 3 = 1 条收敛 + 2 条按次）\nids=${JSON.stringify(uw.map((f) => f.id))}`,
  )
  rec.add(
    G,
    '⑤c ★ 同一轮里那第 2 条同类不白跑一次投递：它落进 `suppressed`（原因 `converged-duplicate`）',
    r5.suppressed.filter((s) => s.reason === 'converged-duplicate').length === 1 && String(r5.note).includes('同类已有一条 1'),
    `suppressed=${JSON.stringify(r5.suppressed.map((s) => s.reason))}\nnote=${String(r5.note)}`,
  )
  rec.add(
    G,
    '⑤b ★ 收敛那一条的正文**自己说明了**为什么收敛（下一轮读到的人不必去翻代码）',
    String(uw.find((f) => f.converged === true)?.detail ?? '').includes('收敛到「类别 + 原因」'),
    String(uw.find((f) => f.converged === true)?.detail ?? '').slice(-140),
  )
}

// ===========================================================================
// C) 收敛③：机制自己的通知不当作新交付（套娃的每一层都挡得住）
// ===========================================================================

function checkMechanismNoticesConverge() {
  const G = 'C 收敛③｜机制通知不再派生新交付'
  const dir = tmpDir('converge')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const task = seedTask({ id: T, state: 'developing' })
  const now = Date.now()

  // --- ① 账本侧：机制通知与到顶的派生键都**不再进"等待接管"清单**
  ledger.record({ key: KEY_ROOT_HANDOFF, task_id: T, kind: 'handoff', actor: 'writer#1', at: stale(3600_000) })
  ledger.record({ key: KEY_UNRESOLVED, task_id: T, kind: 'unresolved-wake', actor: 'mechanism', at: stale(3600_000) })
  ledger.record({ key: KEY_ESCALATION, task_id: T, kind: 'escalation', actor: 'mechanism', at: stale(3600_000) })
  ledger.record({ key: `${T}|handoff|writer#1|H-9#escalated`, task_id: T, kind: 'handoff', actor: 'writer#1', at: stale(3600_000) })

  const pending = ledger.pendingUnconsumed({ now, olderThanMs: 0, limit: 20 })
  rec.add(
    G,
    '① ★★ 账本侧：**只有根事件**留在"等待接管"清单里（机制通知 1 条 + 到顶派生键 1 条都被收敛掉）',
    pending.length === 1 && pending[0].key === KEY_ROOT_HANDOFF,
    JSON.stringify(pending.map((p) => p.key)),
  )
  rec.add(
    G,
    '② ★★ 收敛是"**只记账**"不是"删数据"：`includeMechanismNotices:true` 能把它们**要回来**（取证用）',
    ledger.pendingUnconsumed({ now, olderThanMs: 0, limit: 20, includeMechanismNotices: true }).length === 2,
    JSON.stringify(ledger.pendingUnconsumed({ now, olderThanMs: 0, limit: 20, includeMechanismNotices: true }).map((p) => p.key)),
  )
  const st = ledger.status()
  rec.add(
    G,
    '③ ★★ 收敛掉的那些在 `status()` 里**数得出来**（`mechanism_notices` / `derived_escalations`，两个桶互斥）—— 查得到，就不是静默丢弃',
    st.mechanism_notices === 1 && st.derived_escalations === 2,
    `mechanism_notices=${st.mechanism_notices}（1 = 那条 depth 0 的机制通知）` +
      `　derived_escalations=${st.derived_escalations}（2 = 升级键 + 那条带 #escalated 的 handoff，都 depth≥1）`,
  )
  rec.add(
    G,
    '④ ★ `DEFAULT_MAX_ESCALATION_DEPTH` = 1（原事件 + 1 层封顶），且可显式调小到 0 = 一律不升级',
    DEFAULT_MAX_ESCALATION_DEPTH === 1 && ledger.pendingUnconsumed({ now, maxEscalationDepth: 0, limit: 20 }).length === 0,
    `cap=${DEFAULT_MAX_ESCALATION_DEPTH} cap0=${ledger.pendingUnconsumed({ now, maxEscalationDepth: 0, limit: 20 }).length}`,
  )

  // --- ⑤ 巡检侧（第二道闸）：手喂机制通知进来也不播
  const feed = patrolFindings({
    task,
    now,
    unconsumed: [
      { key: KEY_ESCALATION, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 },
      { key: KEY_L4, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 },
      { key: KEY_L6, target: 'session-main-1', at: stale(3600_000), age_ms: 3600_000 },
    ],
  })
  rec.add(
    G,
    '⑤ ★★ 巡检侧**第二道闸**：真实那几条套娃键（套了 1~6 层通知）一条都播不出来，原因指名（`mechanism-notice` / `depth-capped`）',
    feed.findings.length === 0 && feed.suppressed.length === 3 && feed.suppressed.every((s) => ['mechanism-notice', 'depth-capped'].includes(s.reason)),
    `findings=${feed.findings.length} suppressed=${JSON.stringify(feed.suppressed.map((s) => `${s.reason}@套娃${noticeNestingOf(s.id)}层`))}`,
  )
}

// ===========================================================================
// D) ② 深度上限：**端到端**看链到底停不停（本轮最重的一条判据）
// ===========================================================================

/**
 * ★ 照 `index.js:630-702` 的装配形状重放**同一轮巡检**（同一个 wake 调用参数 +
 *   同一条升级调用）—— 没有改 index.js 一个字，只是在这里把那一轮的形状跑出来。
 */
async function pumpRound({ waker, ledger, task, now, unconsumedOlderThanMs = 0, stallMs = DEFAULT_TASK_STALL_MS }) {
  const wakesBefore = ledger.entries().filter((e) => e.t === 'wake').length
  const escalatedBefore = ledger.entries().filter((e) => e.t === 'escalated').length
  const res = patrolFindings({
    task,
    now,
    stallMs,
    unconsumed: waker.pendingDeliveries(task.id, { olderThanMs: unconsumedOlderThanMs, limit: 5 }),
    unresolved: ledger.unresolvedEntries({ taskId: task.id, limit: 5 }),
  })
  for (const f of res.findings) {
    await waker.wake({
      taskId: task.id,
      actorRole: 'mechanism',
      actorSeat: null,
      kind: String(f.kind ?? 'patrol'),
      what: '**巡检发现长时间无进展**（只播报，不动作）',
      disc: String(f.id ?? ''),
      identitySource: 'patrol-finding',
      task,
      note: String(f.detail ?? ''),
      via: 'patrol',
    })
  }
  await waker.escalateUnconsumed(task.id, { olderThanMs: unconsumedOlderThanMs, limit: 2, reason: 'patrol:unconsumed' })
  const entries = ledger.entries()
  return {
    findings: res.findings,
    suppressed: res.suppressed,
    /** 本轮**真的播出去**了几条（只数 `wake` 行；`escalated` 是记账行，不算播报）。 */
    addedWakes: entries.filter((e) => e.t === 'wake').length - wakesBefore,
    /** 本轮新增的"已升级"记账行。 */
    addedEscalated: entries.filter((e) => e.t === 'escalated').length - escalatedBefore,
  }
}

async function checkChainTerminates() {
  const G = 'D 端到端｜链在第 1 层封顶，之后只记账'
  const dir = tmpDir('chain')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const task = seedTask({ id: T, state: 'developing', history: [{ at: stale(600_000), action: 'transition:dispatch_writer', actor: 'main' }] })
  const { waker } = makeWaker({ ledger, task })

  // 根事件：一条**正常**的交付（有人交了一份东西）——它没人接管，该叫。
  ledger.record({ key: KEY_ROOT_HANDOFF, task_id: T, kind: 'handoff', actor: 'writer#1', at: stale(3600_000) })

  const rounds = []
  for (let i = 0; i < 6; i++) {
    rounds.push(await pumpRound({ waker, ledger, task, now: Date.now() }))
  }
  const addedWakes = rounds.map((r) => r.addedWakes)

  const wakeKeys = ledger.entries().filter((e) => e.t === 'wake').map((e) => e.key)
  const maxNest = wakeKeys.reduce((m, k) => Math.max(m, noticeNestingOf(k)), 0)
  const maxEscDepth = wakeKeys.reduce((m, k) => Math.max(m, escalatedDepthOf(k)), 0)
  const noticeOfNotice = wakeKeys.filter((k) => noticeNestingOf(k) >= 2)

  rec.add(
    G,
    '⓪ ★★ **控制项**：第 1 轮**真的**把链起来了（1 条巡检播报 + 1 条升级播报）—— 否则后面的"停住"是假通过',
    addedWakes[0] === 2 && rounds[0].addedEscalated === 1,
    `每轮新增播报=${JSON.stringify(addedWakes)}　每轮新增升级记账=${JSON.stringify(rounds.map((r) => r.addedEscalated))}`,
  )
  rec.add(
    G,
    '① ★★ **第 2 轮起新增 0 条**（链在 1 轮内终止；改前是每轮继续加深一层）',
    addedWakes.slice(1).every((n) => n === 0),
    `每轮新增播报=${JSON.stringify(addedWakes)}　累计播报=${wakeKeys.length} 条`,
  )
  rec.add(
    G,
    '② ★★ **没有任何键是"播报的播报"**（`<类别>|mechanism|` 完整通知段最多出现 1 次）—— 这就是"播报不再变成新交付"',
    noticeOfNotice.length === 0,
    `嵌套键=${JSON.stringify(noticeOfNotice, null, 1)}`,
  )
  rec.add(
    G,
    '③ ★★ 全部交付键**升级深度 ≤ 1**（原事件 + 1 层升级封顶，②的深度上限生效）',
    maxEscDepth <= 1 && maxNest <= 1,
    `最大升级深度=${maxEscDepth}　最大通知嵌套=${maxNest}\nkeys=${JSON.stringify(wakeKeys, null, 1)}`,
  )
  rec.add(
    G,
    '④ ★★ 契约保留：**根事件该叫的那一次升级照样发生**（`escalatedEntry(根键)` 指着 `根键#escalated`）',
    ledger.escalatedEntry(KEY_ROOT_HANDOFF)?.escalation_key === `${KEY_ROOT_HANDOFF}#escalated`,
    JSON.stringify(ledger.escalatedEntry(KEY_ROOT_HANDOFF)),
  )

  // --- ⑤ 反例：第二条**正常的**未接管交付 —— 它照样各叫各的一次（不是"把升级关了"）
  const KEY2 = `${T}|handoff|writer#1|H-10`
  ledger.record({ key: KEY2, task_id: T, kind: 'handoff', actor: 'writer#1', at: stale(3600_000) })
  await pumpRound({ waker, ledger, task, now: Date.now() })
  rec.add(
    G,
    '⑤ ★★ 反例：再来一条正常交付 ⇒ 它**也**拿到自己那一次升级（升级没被关掉，只是不再派生升级）',
    ledger.escalatedEntry(KEY2)?.escalation_key === `${KEY2}#escalated`,
    JSON.stringify(ledger.escalatedEntry(KEY2)),
  )

  // --- ⑥ 正例：同一套循环，落到**终态**单上 ⇒ 巡逻侧一条都不播
  const dir2 = tmpDir('chain-terminal')
  const ledger2 = createWakeLedger({ file: join(dir2, LEDGER_FILE_NAME), warn: () => {} })
  const deadTask = seedTask({ id: 'T-TERMFILTER-DEAD', state: 'cancelled', history: [{ at: stale(600_000), action: 'transition:cancel', actor: 'main' }] })
  const deadWaker = makeWaker({ ledger: ledger2, task: deadTask }).waker
  const deadKey = `T-TERMFILTER-DEAD|handoff|writer#1|H-1`
  ledger2.record({ key: deadKey, task_id: deadTask.id, kind: 'handoff', actor: 'writer#1', at: stale(3600_000) })
  const deadRounds = []
  for (let i = 0; i < 4; i++) {
    deadRounds.push(await pumpRound({ waker: deadWaker, ledger: ledger2, task: deadTask, now: Date.now() }))
  }
  const deadKeys = ledger2.entries().filter((e) => e.t === 'wake').map((e) => e.key)
  /** 巡逻那几类（`index.js` 的 reportFinding 用 finding.kind 当 wake kind）。 */
  const patrolKinds = ['task-stall', 'unconsumed-delivery', 'unresolved-wake', 'patrol-stalled']
  const patrolWakes = ledger2.entries().filter((e) => e.t === 'wake' && patrolKinds.includes(String(e.kind)))
  rec.add(
    G,
    '⑥ ★★ 正例（终态单）：同一套循环跑 4 轮 ⇒ **巡逻一条都不播**（`task-stall` / `unconsumed-delivery` / `unresolved-wake` 全 0），且链不加深',
    patrolWakes.length === 0 && deadKeys.every((k) => noticeNestingOf(k) <= 1) && deadRounds.slice(1).every((r) => r.addedWakes === 0),
    `巡逻播报=${patrolWakes.length} 条　每轮新增播报=${JSON.stringify(deadRounds.map((r) => r.addedWakes))}\nkeys=${JSON.stringify(deadKeys, null, 1)}`,
  )
  rec.add(
    G,
    '⑦ ★★ **已知边界（本包修不到，需 index.js 收口）**：终态单**至多**还会收到 1 条升级播报 —— 升级调用点 `index.js:701` 不看状态；本包保证的是"它到此为止、不加深"',
    deadKeys.filter((k) => String(k).includes('|escalation|mechanism|')).length <= 1,
    `升级播报=${deadKeys.filter((k) => String(k).includes('|escalation|mechanism|')).length} 条（理想是 0；要 0 需 index.js:701 加终态过滤，见实现报告"未做/需收口"一节）`,
  )
  rec.add(
    G,
    '⑧ ★ 但"没投出去"这件事**仍然在账上**（终态单的那条交付还在 `delivered` 里，查得到）',
    ledger2.hasDelivered(deadKey) === true,
    `hasDelivered=${ledger2.hasDelivered(deadKey)}`,
  )
}

// ===========================================================================
// E) "交付已落盘、出口没按" —— 正例（实测那张真卡单的形状）
// ===========================================================================

/**
 * ★ 夹具**照真实卡单 `T-20261011-5a871c` 的形状搭**（数值取自它的 `task.json`，但
 *   不读盘 —— 本套依旧密闭）：
 *   · 3 个编写席位（`roster.writers.partitions`）；
 *   · 进 developing 的那一刻 = `2026-10-14T11:24:43Z`（最后一条 `transition:*` 的 `to`）；
 *   · `writer_submissions` 只有 writer#1（交接物 `H-073a6a57aaf0ecc7`，`at` = 11:33:40Z）；
 *   · 制品 v4；`dev_to_test` 交接物 `H-073a6a57aaf0ecc7`（11:33:39Z）。
 */
const REAL_STUCK = Object.freeze({
  entered_developing: '2026-10-14T11:24:43Z',
  submitted_at: '2026-10-14T11:33:40Z',
  handoff_id: 'H-073a6a57aaf0ecc7',
  handoff_at: '2026-10-14T11:33:39Z',
})

function stuckTask(over = {}) {
  return seedTask({
    id: 'T-A3-STUCK',
    state: 'developing',
    roster: { writers: { count: 3, partitions: [{ seat: 'writer#1' }, { seat: 'writer#2' }, { seat: 'writer#3' }] } },
    history: [{ at: REAL_STUCK.entered_developing, action: 'transition:human_reply', actor: 'main', from: 'awaiting_human', to: 'developing' }],
    artifacts: [{ version: 'v4', role: 'writer', at: REAL_STUCK.submitted_at }],
    handoffs: [{ kind: 'dev_to_test', handoff_id: REAL_STUCK.handoff_id, created_at: REAL_STUCK.handoff_at, from_role: 'writer', artifact_version: 'v4' }],
    writer_submissions: { 'writer#1': { handoff_id: REAL_STUCK.handoff_id, artifact_version: 'v4', at: REAL_STUCK.submitted_at } },
    ...over,
  })
}

const afterSubmit = (min) => Date.parse(REAL_STUCK.submitted_at) + min * 60 * 1000

function checkUndeliveredTransition() {
  const G = 'E 正例｜交付已落盘、出口没按（实测真卡单的形状）'

  // --- ① 真卡单的形状：1/3 到齐、交付后 16 分钟 ⇒ **必须报**，且指名还差谁
  const f1 = patrolFindings({ task: stuckTask(), now: afterSubmit(16) }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)
  rec.add(
    G,
    '① ★★ 实测那张卡单的形状（3 席只到 1 席、交付后 16 分钟）⇒ **报出来了**（这就是原先的漏报）',
    f1 !== undefined && f1.expected_events.join('+') === 'dev_submitted',
    f1 === undefined ? '(一条都没报 —— 漏报仍在)' : `expected=${f1.expected_events.join('+')} dwell=${Math.round(f1.dwell_ms / 60000)}分`,
  )
  rec.add(
    G,
    '② ★★ 措辞**如实**：说清"只到 1/3、还差 writer#2 / writer#3"，并**不**叫主对话去发一条会被守卫拒的迁移',
    f1?.complete === false &&
      f1.missing_seats.join(',') === 'writer#2,writer#3' &&
      f1.submitted_seats.join(',') === 'writer#1' &&
      String(f1.detail).includes('发不出去') &&
      String(f1.detail).includes('全部席位到齐') &&
      !String(f1.detail).includes('叫醒该席位补发'),
    `complete=${f1?.complete} 还差=${JSON.stringify(f1?.missing_seats)}`,
  )
  rec.add(
    G,
    '③ ★★ 机器可读的动作面齐了（`expected_events` / `complete` / `missing_seats` / `evidence_id` / `delivered_at` / `actor`）',
    f1?.actor === 'writer' &&
      f1?.evidence_id === REAL_STUCK.handoff_id &&
      String(f1?.delivered_at).length > 10 &&
      Array.isArray(f1?.missing_seats),
    JSON.stringify({ actor: f1?.actor, evidence: f1?.evidence_id, delivered_at: f1?.delivered_at }),
  )

  // --- ④ 全部到齐 ⇒ 措辞换成"该发了、叫席位补发"
  const allIn = stuckTask({
    writer_submissions: {
      'writer#1': { handoff_id: REAL_STUCK.handoff_id, artifact_version: 'v4', at: REAL_STUCK.submitted_at },
      'writer#2': { handoff_id: 'H-w2', artifact_version: 'v4', at: REAL_STUCK.submitted_at },
      'writer#3': { handoff_id: 'H-w3', artifact_version: 'v4', at: REAL_STUCK.submitted_at },
    },
  })
  const f4 = patrolFindings({ task: allIn, now: afterSubmit(16) }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)
  rec.add(
    G,
    '④ ★★ 三席**到齐**⇒ 换成"出口没按、叫席位补发那一步"（两种形态给出**不同的**动作建议）',
    f4?.complete === true && String(f4.detail).includes('该发') && String(f4.detail).includes('补发'),
    `complete=${f4?.complete}\n${String(f4?.detail ?? '').split('\n').slice(0, 2).join('\n')}`,
  )

  // --- ⑤ 去重与冷却：**同一轮**里跨巡检 / 跨"又交了一个席位" ⇒ id 不变（至多播一次）
  const idA = patrolFindings({ task: stuckTask(), now: afterSubmit(16) }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)?.id
  const idB = patrolFindings({ task: stuckTask(), now: afterSubmit(90) }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)?.id
  const twoIn = stuckTask({
    writer_submissions: {
      'writer#1': { handoff_id: REAL_STUCK.handoff_id, artifact_version: 'v4', at: REAL_STUCK.submitted_at },
      'writer#2': { handoff_id: 'H-w2', artifact_version: 'v4', at: afterSubmit(30) },
    },
  })
  const idC = patrolFindings({ task: twoIn, now: afterSubmit(45) }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)?.id
  rec.add(
    G,
    '⑤ ★★ **去重与冷却**：同一轮跨巡检（16 分→90 分）、甚至又交了一席（1/3→2/3）⇒ **id 一个字不变**（⇒ 账本幂等吃掉 ⇒ 同一轮至多播一次）',
    idA !== undefined && idA === idB && idA === idC,
    `idA=${idA}\nidB=${idB}\nidC=${idC}`,
  )
  rec.add(
    G,
    '⑤b ★ 身份的最后一截钉在"**本轮**"上（`round@进 developing 那一刻`）—— 这是它跨巡检稳定的原因',
    String(idA).endsWith('|round@2026-10-14T11:24:43Z'),
    String(idA),
  )

  // --- ⑥ 测试腿：`test_to_review` 已落盘、仍停在 testing ⇒ 该发 test_passed / test_failed
  const testing = seedTask({
    id: 'T-A3-TESTING',
    state: 'testing',
    history: [{ at: '2026-10-14T10:00:00Z', action: 'transition:dispatch_tester', actor: 'main', from: 'ready_test', to: 'testing' }],
    artifacts: [{ version: 'v4', role: 'writer', at: '2026-10-14T09:00:00Z' }],
    handoffs: [{ kind: 'test_to_review', handoff_id: 'H-tr', created_at: '2026-10-14T10:30:00Z', from_role: 'tester', artifact_version: 'v4' }],
  })
  const f6 = patrolFindings({ task: testing, now: Date.parse('2026-10-14T11:00:00Z') }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)
  rec.add(
    G,
    '⑥ ★★ 测试腿：`test_to_review` 已落盘、仍停在「测试中」⇒ 报，且**两个候选事件都列**（通过与否是测试位自己的结论，机制不替它选）',
    f6?.expected_events.join('+') === 'test_passed+test_failed' && String(f6?.detail).includes('不替它判断'),
    `expected=${f6?.expected_events?.join('+')}`,
  )

  // --- ⑦ 审核腿：结论**就在交接物里** ⇒ 能指名道姓（OK ⇒ review_ok）
  const reviewingOk = seedTask({
    id: 'T-A3-REVIEWING',
    state: 'reviewing',
    history: [{ at: '2026-10-14T10:00:00Z', action: 'transition:dispatch_reviewer', actor: 'main', from: 'ready_review', to: 'reviewing' }],
    artifacts: [{ version: 'v4', role: 'writer', at: '2026-10-14T09:00:00Z' }],
    handoffs: [{ kind: 'review_verdict', handoff_id: 'H-rv', created_at: '2026-10-14T10:30:00Z', from_role: 'reviewer', artifact_version: 'v4', payload: { conclusion: 'OK' } }],
  })
  const f7 = patrolFindings({ task: reviewingOk, now: Date.parse('2026-10-14T11:00:00Z') }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)
  rec.add(G, '⑦ ★★ 审核腿：结论是 OK ⇒ 指名 `review_ok`（不是含糊的"该发点什么"）', f7?.expected_events.join('+') === 'review_ok', `expected=${f7?.expected_events?.join('+')}`)

  const reviewingNg = seedTask({
    ...reviewingOk,
    handoffs: [{ kind: 'review_verdict', handoff_id: 'H-rv2', created_at: '2026-10-14T10:30:00Z', from_role: 'reviewer', artifact_version: 'v4', payload: { conclusion: 'NG', reject_to: 'tester' } }],
  })
  const f7b = patrolFindings({ task: reviewingNg, now: Date.parse('2026-10-14T11:00:00Z') }).findings.find((x) => x.kind === MISSING_TRANSITION_KIND)
  rec.add(
    G,
    '⑦b ★ 结论 NG + 打回测试 ⇒ 指名 `review_ng_test`（**从交接物自己身上读结论**，不猜）',
    f7b?.expected_events.join('+') === 'review_ng_test',
    `expected=${f7b?.expected_events?.join('+')}`,
  )

  // --- ⑧ ★★ 与"机制通知不许派生"的**跨文件纪律**：这个新类别必须在收敛表里
  rec.add(
    G,
    '⑧ ★★ **新增的播报类别必须同时登记进 `MECHANISM_NOTICE_KINDS`**（漏一个，它自己那条交付下一轮就被当成"等待接管的交付"再报一次 ⇒ 套娃复发）',
    MECHANISM_NOTICE_KINDS.includes(MISSING_TRANSITION_KIND),
    `MISSING_TRANSITION_KIND=${MISSING_TRANSITION_KIND}　表里=${MECHANISM_NOTICE_KINDS.join(',')}`,
  )
  rec.add(
    G,
    '⑧b ★ 口径可配（默认 10 分钟）—— 不是写死在判据里',
    DEFAULT_UNDELIVERED_TRANSITION_MS === 10 * 60 * 1000 &&
      patrolFindings({ task: stuckTask(), now: afterSubmit(16), undeliveredTransitionMs: 60 * 60 * 1000 }).findings.filter((x) => x.kind === MISSING_TRANSITION_KIND).length === 0,
    `默认=${DEFAULT_UNDELIVERED_TRANSITION_MS / 60000}分　调成 60 分 ⇒ 不报（符合预期）`,
  )
}

/** 端到端：新判据**不许**变成新的刷屏源/套娃源（跑生产形状的巡检回路）。 */
async function checkMissingTransitionDoesNotLoop() {
  const G = 'E2 端到端｜新判据不会变成新的刷屏源'
  const dir = tmpDir('missing-tx')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const task = stuckTask({ id: 'T-A3-LOOP' })
  const { waker } = makeWaker({ ledger, task })

  const rounds = []
  for (let i = 0; i < 3; i++) {
    // ★ 把"无进展"口径调到 10 小时 ⇒ 本组只量**新判据**自己，不与 task-stall 混在一起
    rounds.push(await pumpRound({ waker, ledger, task, now: afterSubmit(16 + i * 5), stallMs: 10 * 60 * 60 * 1000 }))
  }
  const keys = ledger.entries().filter((e) => e.t === 'wake').map((e) => e.key)
  rec.add(
    G,
    '① ★★ 第 1 轮播**正好 1 条**（就是那条"出口没按"）—— 先证明它真的会响（否则后面"停住"是假通过）',
    rounds[0].addedWakes === 1 && rounds[0].findings.filter((f) => f.kind === MISSING_TRANSITION_KIND).length === 1,
    `每轮新增播报=${JSON.stringify(rounds.map((r) => r.addedWakes))}`,
  )
  rec.add(
    G,
    '② ★★ **第 2 轮起 0 条**：它自己那条交付没有被当成"等待接管的交付"再报一次（`MECHANISM_NOTICE_KINDS` 生效）',
    rounds.slice(1).every((r) => r.addedWakes === 0),
    `每轮新增播报=${JSON.stringify(rounds.map((r) => r.addedWakes))}`,
  )
  rec.add(
    G,
    '③ ★★ 账本里**没有一条"播报的播报"**（键里完整机制通知段 ≤ 1 次）—— 与 P0-3 的断链成果一致，没有被这条新判据破坏',
    keys.every((k) => noticeNestingOf(k) <= 1),
    `keys=${JSON.stringify(keys, null, 1)}`,
  )
}

// ===========================================================================
// F) 反例：正常推进 / 刚交完 / 终态 / 交付没齐 / 版本不对 ⇒ **一条都不许报**
// ===========================================================================

function checkUndeliveredTransitionCounterExamples() {
  const G = 'F 反例｜"出口没按"不许误报'
  const count = (task, now, extra = {}) => patrolFindings({ task, now, ...extra }).findings.filter((x) => x.kind === MISSING_TRANSITION_KIND).length

  // --- ① 正常推进：那一步**发了** ⇒ 状态已不是 developing ⇒ 一条都不报
  const advanced = stuckTask({ state: 'ready_test', history: [...stuckTask().history, { at: '2026-10-14T11:34:00Z', action: 'transition:dev_submitted', actor: 'writer', from: 'developing', to: 'ready_test' }] })
  rec.add(
    G,
    '① ★★ **正常推进**（`dev_submitted` 发了、状态走到「待测试」）⇒ 一条都不报（这是最关键的反例）',
    count(advanced, afterSubmit(600)) === 0,
    `state=${advanced.state}　条数=${count(advanced, afterSubmit(600))}`,
  )

  // --- ② 打回重做：新一轮刚开始、**提交表是空的**，上一轮的旧交接物还在 ⇒ 不报
  const freshRound = stuckTask({
    writer_submissions: {},
    history: [
      { at: REAL_STUCK.entered_developing, action: 'transition:human_reply', actor: 'main', from: 'awaiting_human', to: 'developing' },
      { at: '2026-10-14T11:33:39Z', action: 'transition:dev_submitted', actor: 'writer', from: 'developing', to: 'ready_test' },
      { at: '2026-10-14T12:00:00Z', action: 'transition:test_failed', actor: 'tester', from: 'testing', to: 'returned_to_dev' },
      { at: '2026-10-14T12:05:00Z', action: 'transition:dispatch_writer', actor: 'main', from: 'returned_to_dev', to: 'developing' },
    ],
  })
  rec.add(
    G,
    '② ★★ **打回重做·新一轮刚开始**（提交表空、上一轮的 `dev_to_test` 还在册）⇒ **不报**（否则每一轮重做都会被冤枉一次）',
    count(freshRound, Date.parse('2026-10-14T12:20:00Z')) === 0,
    `条数=${count(freshRound, Date.parse('2026-10-14T12:20:00Z'))}（提交表空 ⇒ 本轮还没人交）`,
  )

  // --- ③ 刚交完（在冷却窗内）⇒ 不报
  rec.add(
    G,
    '③ ★★ **刚交完 2 分钟**（冷却窗 10 分钟内）⇒ 不报 —— 席位交完东西、顺手发那一步通常就在几秒内',
    count(stuckTask(), afterSubmit(2)) === 0,
    `条数=${count(stuckTask(), afterSubmit(2))}`,
  )

  // --- ④ **终态单永远不报**（P0-3①/P2-11 的既有反例不许被破）
  for (const state of ['cancelled', 'closed']) {
    const dead = stuckTask({ state })
    const res = patrolFindings({ task: dead, now: afterSubmit(600) })
    rec.add(
      G,
      `④ ★★ **终态「${state}」**：交付证据一模一样，也**一条都不播**（★ 这一腿的保护是**结构性**的：终态单根本不在那一腿的状态上 —— 不是靠末尾那道闸兜住的）`,
      res.findings.length === 0,
      `findings=${res.findings.length}（=0）　state=${res.state}　terminal=${res.terminal}　suppressed=${JSON.stringify(res.suppressed.map((s) => s.kind + ':' + s.reason))}`,
    )
  }

  // --- ⑤ 交付**没齐**且**一个都没交**（提交表空、也没有本轮交接物）⇒ 不报
  const nothing = stuckTask({ writer_submissions: {}, handoffs: [] })
  rec.add(
    G,
    '⑤ ★ **一个席位都还没交**（提交表空、无本轮交接物）⇒ 不报 —— 那只是"还在干活"，该走的是失联/无进展那两条既有判据',
    count(nothing, afterSubmit(600)) === 0,
    `条数=${count(nothing, afterSubmit(600))}`,
  )

  // --- ⑥ 版本对不上 ⇒ 不报（与守卫同口径：那条迁移**本来就过不去**）
  const wrongVersion = seedTask({
    id: 'T-A3-VER',
    state: 'testing',
    history: [{ at: '2026-10-14T10:00:00Z', action: 'transition:dispatch_tester', actor: 'main', from: 'ready_test', to: 'testing' }],
    artifacts: [{ version: 'v5', role: 'writer', at: '2026-10-14T10:20:00Z' }],
    handoffs: [{ kind: 'test_to_review', handoff_id: 'H-old', created_at: '2026-10-14T10:30:00Z', from_role: 'tester', artifact_version: 'v4' }],
  })
  rec.add(
    G,
    '⑥ ★★ 测试报告针对的是**旧版本**（v4 / 当前 v5）⇒ 不报 —— 与守卫同口径，那条迁移**本来就过不去**（报了就是给错的动作）',
    count(wrongVersion, Date.parse('2026-10-14T11:00:00Z')) === 0,
    `条数=${count(wrongVersion, Date.parse('2026-10-14T11:00:00Z'))}`,
  )

  // --- ⑦ 状态不对（等在等人/等澄清里）⇒ 那三腿一个都不适用
  const waiting = stuckTask({ state: 'awaiting_human' })
  rec.add(G, '⑦ ★ 等待态（等用户拍板）里不判这一条（判据只认那三个"该按出口"的状态）', count(waiting, afterSubmit(600)) === 0, `条数=${count(waiting, afterSubmit(600))}`)

  // --- ⑧ 提交时间**读不到** ⇒ 不猜（算不出"交了多久"，就不该催）
  const noTimestamp = stuckTask({ writer_submissions: { 'writer#1': { handoff_id: 'H-no-at', artifact_version: 'v4' } } })
  rec.add(
    G,
    '⑧ ★ 提交表在、但**提交时间读不到** ⇒ **不猜**（宁可不报，也不凭一个假的时间去催）',
    count(noTimestamp, afterSubmit(600)) === 0,
    `条数=${count(noTimestamp, afterSubmit(600))}（提交时间缺失 ⇒ 不判）`,
  )

  // --- ⑨ 判据只在"该按出口"的那三个状态上；别的状态一律不判
  const elsewhere = stuckTask({ state: 'returned_to_dev' })
  rec.add(
    G,
    '⑨ ★ 「打回编写待重派」不判这一条 —— 那一步该发的是**主对话的 `dispatch_writer`**，不是编写席位的 `dev_submitted`（判据不许越位）',
    count(elsewhere, afterSubmit(600)) === 0,
    `state=returned_to_dev　条数=${count(elsewhere, afterSubmit(600))}`,
  )
}

// ===========================================================================
// 主流程
// ===========================================================================

export async function runTerminalFilterCheck() {
  rec.items.length = 0
  checkTerminalIsSilent()
  checkLiveStillReports()
  checkMechanismNoticesConverge()
  await checkChainTerminates()
  checkUndeliveredTransition()
  checkUndeliveredTransitionCounterExamples()
  await checkMissingTransitionDoesNotLoop()

  const lines = []
  lines.push('【终态过滤包 · terminal-filter-check（P0-3 / P2-11 / P2-12）】')
  let group = ''
  for (const it of rec.items) {
    if (it.group !== group) {
      group = it.group
      lines.push(`\n== ${group} ==`)
    }
    lines.push(`  ${it.pass ? '✅' : '❌'} ${it.name}`)
    if (it.pass !== true) lines.push(`        ↳ ${it.detail}`)
  }
  lines.push(`\n断言：${rec.passed}/${rec.total} 通过`)
  const failed = rec.items.filter((i) => !i.pass)
  if (failed.length > 0) {
    lines.push('\n失败明细：')
    for (const f of failed) lines.push(`  ❌ [${f.group}] ${f.name}\n     ${f.detail}`)
  }
  const text = lines.join('\n')
  console.log(text)
  return { passed: rec.passed, total: rec.total, text, items: [...rec.items] }
}

// ---------------------------------------------------------------------------
// 直接执行（`node tests/terminal-filter-check.mjs`）：跑一遍并打印。
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runTerminalFilterCheck()
    .then((r) => {
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[terminal-filter-check] 内部异常（这是用例自身的 bug，请修用例）：', err)
      process.exitCode = 1
    })
    .finally(() => {
      cleanup()
    })
}
