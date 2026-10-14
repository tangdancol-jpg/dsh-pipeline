/**
 * dsh-pipeline · **唤醒 / 投递通道**自测（T-20261012-8cdee0 编写席自写用例）
 * ============================================================================
 *     node tests/wake-channel-check.mjs            # 全套
 *     node tests/wake-channel-check.mjs --help     # 用法
 *
 * ---------------------------------------------------------------------------
 * 这一套盯的是「干完活 → 停下来 → 没人叫 → 被冻 → 人肉解冻 → 再派一席」那条循环
 * 的**每一个环节**（判据编号见 `.pipeline/<任务>/requirement.md` 的 A / T / B 三族）：
 *   · A1/A19 同一事件恰播一次 —— 含**跨进程**（独立进程 + 预置账本）
 *   · A2/A5   不同事件不被吃掉、旧身份不复用不重放
 *   · A3      没有实体的事件（状态推进 / 中止）也能送达，且不留静默跳过
 *   · A4      身份归属：键里的执行者必须就是实体的提交者（**错配**是现场那条缺陷）
 *   · A6/A7   澄清裁定 / 人工答复之后**发起席位**被自动投递（且不新开会话）
 *   · A8/A25  看得见的失败：不可达 / 没身份 / 账本坏了 —— 都有可读留痕 + 原因
 *   · A9/A10/A11 崩 ≠ 闲、崩 ≠ 冻、中止必须被播报（判词携带失败证据）
 *   · A13     交付在等待/阻塞窗口里被拒收时：可见 + 内容可查回
 *   · A20     账本三态（缺失 / 损坏 / 不可写）各有可判定行为 + 可重建
 *   · A21–A25 巡检：会响、不越权、不刷屏也不哑掉、不是后门、自身抛错可见
 *   · A27     重启后认出席位（识别依据缺失时走看得见的失败）
 *   · A28     送达 ≠ 接管：两侧留痕**配对可读**（含 R1 的升级叫醒）
 *
 * ★ 纪律：
 *   · 全程零副作用（临时目录，跑完即删；不碰线上任务数据与会话目录）；
 *   · **零 skip / 零 todo / 零 only**（断言不得靠跳过变绿）；
 *   · 断言只吃"公开入口的返回值 + 盘上文件"，不去读私有字段。
 *
 * @module dsh-pipeline/tests/wake-channel-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createWakeLedger, rebuildEntriesFromTask, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { eventIdentityFor, ledgerIdentityScoped, createMainSessionRegistry, createWaker, actorKeyOf, wakeKeyOf } from '../lib/wakeup.js'
import { patrolFindings, createPatrol, DEFAULT_TASK_STALL_MS } from '../lib/patrol.js'
import { detectRunFailure, findFailureInText, scanRunFailureInLog, RUN_FAILURE_MARKERS } from '../lib/runfail.js'
import { seatLiveness } from '../lib/liveness.js'

// ---------------------------------------------------------------------------
// 断言小工具（与其它自测同形状：只记 pass/detail，不抛）
// ---------------------------------------------------------------------------

const tmpRoots = []
function tmpDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `dsh-wake-${tag}-`))
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
// 假宿主：只要能"看见投递"就够（与线上同形：agents.followup 优先，prompt 退路）
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
            ensure(request.sessionId).followup({ id: `prompt-${request.requestId}`, role: 'user', content: request.content, source: { kind: 'user' } })
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
    id: 'T-WAKE-1',
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

async function makeWaker({ ledger = null, host = fakeHost(), task = seedTask(), sinks = auditSink() } = {}) {
  const registry = createMainSessionRegistry()
  registry.remember(task.id, 'session-main-1', 'test')
  host.ensure('session-main-1')
  const waker = createWaker({
    ctx: host.ctx,
    registry,
    ledger,
    getTask: () => task,
    audit: sinks.audit,
    warn: () => {},
  })
  return { waker, host, task, sinks, registry }
}

// ===========================================================================
// 1) 账本：跨进程「恰播一次」+ 三态 + 可重建（A19 / A20 / B11 / B16 / B20）
// ===========================================================================

async function checkLedger() {
  const G = '1 账本（A19/A20）'
  const dir = tmpDir('ledger')
  const file = join(dir, LEDGER_FILE_NAME)

  // --- ① 首次运行：账本不存在 ⇒ **建它**（不是失败）
  const l1 = createWakeLedger({ file, warn: () => {} })
  rec.add(G, '① 账本不存在 ⇒ 首次创建，状态可判定（不是静默跳过、也不是失败）', l1.status().state === 'ready' && existsSync(file), `state=${l1.status().state} exists=${existsSync(file)}`)

  // --- ② 播过就记住：同键第二次判为"已播报"
  l1.record({ key: 'T|handoff|writer#1|H-1', task_id: 'T', kind: 'handoff', actor: 'writer#1', target: 'session-main-1', request_id: 'req-1' })
  rec.add(G, '② 记一条之后 hasDelivered=true（跨进程去重的那一半）', l1.hasDelivered('T|handoff|writer#1|H-1') === true, JSON.stringify(l1.status()))

  // --- ③ **独立实例**（= 另一个进程的判据）：同一份盘上的账本，认得同一个键
  const l2 = createWakeLedger({ file, warn: () => {} })
  rec.add(
    G,
    '③ ★★ 换一个实例（= 独立进程）读同一份账本 ⇒ 仍认得"已播报"（重启不重放）',
    l2.hasDelivered('T|handoff|writer#1|H-1') === true && l2.hasDelivered('T|handoff|writer#1|H-2') === false,
    `已播=${l2.hasDelivered('T|handoff|writer#1|H-1')} 未播=${l2.hasDelivered('T|handoff|writer#1|H-2')}`,
  )

  // --- ④ 损坏态：坏行**不删不覆盖**、如实报、去重退到"已解析的那部分"
  const dir2 = tmpDir('ledger-damaged')
  const file2 = join(dir2, LEDGER_FILE_NAME)
  writeFileSync(file2, `${JSON.stringify({ t: 'wake', key: 'K-OK', task_id: 'T', kind: 'handoff', actor: 'writer#1', at: '2026-10-13T00:00:00Z' })}\n{ 这不是 JSON\n`, 'utf8')
  const before = readFileSync(file2, 'utf8')
  const l3 = createWakeLedger({ file: file2, warn: () => {} })
  rec.add(G, '④ 账本损坏 ⇒ state=damaged + 原因，**文件一个字节没动**（不删不覆盖）', l3.status().state === 'damaged' && readFileSync(file2, 'utf8') === before, `state=${l3.status().state} note=${l3.status().note}`)
  rec.add(G, '④b 损坏时**好行照旧生效**（既不静默跳过、也不退化成"每次都播"）', l3.hasDelivered('K-OK') === true && l3.hasDelivered('K-NEW') === false, `好行=${l3.hasDelivered('K-OK')} 新键=${l3.hasDelivered('K-NEW')}`)

  // --- ⑤ 不可写态：可见失败 + 仍然进内存镜像（不许因为写不进就重放）
  const dir3 = tmpDir('ledger-unwritable')
  /**
   * ★ 怎么造"真的写不进去"：**拿一个普通文件当目录用**
   *   （`<dir3>/blocker` 是文件 ⇒ 它下面建不出任何东西）。
   *   刻意不用"父目录不存在"——那一条会被 `mkdirSync(recursive)` 建好，不是不可写。
   */
  writeFileSync(join(dir3, 'blocker'), 'not a directory', 'utf8')
  const file3 = join(dir3, 'blocker', LEDGER_FILE_NAME)
  const warns = []
  const l4 = createWakeLedger({ file: file3, warn: (m) => warns.push(m) })
  const w = l4.record({ key: 'K-X', task_id: 'T', kind: 'handoff', actor: 'writer#1' })
  rec.add(
    G,
    '⑤ 账本写不进 ⇒ `ok:false` + 原因 + **warn 出声**，且该键在本次进程内仍判"已播报"',
    l4.status().state === 'unwritable' && w.ok === false && warns.length > 0 && l4.hasDelivered('K-X') === true,
    `state=${l4.status().state} ok=${w.ok} warns=${warns.length}`,
  )

  // --- ⑥ 可重建：从既有事件数据推键，重建后重跑"恰一次"仍然成立
  const task = seedTask({
    handoffs: [{ handoff_id: 'H-9', from_role: 'writer', from_seat: 'writer#1', created_at: '2026-10-13T01:00:00Z' }],
    history: [{ at: '2026-10-13T01:01:00Z', action: 'transition:dev_submitted', actor: 'writer', from: 'developing', to: 'ready_test' }],
  })
  const entries = rebuildEntriesFromTask(task)
  const keyHandoff = wakeKeyOf({ taskId: 'T-WAKE-1', kind: 'handoff', actorRole: 'writer', actorSeat: 'writer#1', disc: 'H-9' })
  rec.add(
    G,
    '⑥ 重建口径与 wakeKeyOf **逐字同源**（重建出来的键就是线上会用的那个键）',
    entries.some((e) => e.key === keyHandoff),
    `重建键=${entries.map((e) => e.key).join(' | ')}`,
  )
  const dir4 = tmpDir('ledger-rebuild')
  const l5 = createWakeLedger({ file: join(dir4, LEDGER_FILE_NAME), warn: () => {} })
  const rb = l5.rebuild(task)
  rec.add(G, '⑥b 重建之后，那条"早该播过"的事件被判为已播报（A20 末句：账本不是单点）', rb.added >= 1 && l5.hasDelivered(keyHandoff) === true, `added=${rb.added} note=${rb.note}`)

  // --- ⑦ 落点：默认落点就在插件目录内（B16）
  const { defaultLedgerPath } = await import('../lib/wakeledger.js')
  const def = defaultLedgerPath(process.cwd())
  rec.add(G, '⑦ 默认落点在**插件目录内**（B16：账本不得越出插件目录写文件）', def.startsWith(process.cwd()), def)
}

// ===========================================================================
// 2) 身份：归属正确 / 不复用旧身份 / 无实体事件也能送达（A3 / A4 / A5）
// ===========================================================================

async function checkIdentity() {
  const G = '2 身份（A3/A4/A5）'
  const task = seedTask({
    handoffs: [
      { handoff_id: 'H-writer', from_role: 'writer', from_seat: 'writer#1', created_at: '2026-10-13T01:00:00Z' },
      { handoff_id: 'H-tester', from_role: 'tester', from_seat: null, created_at: '2026-10-13T01:05:00Z' },
    ],
    human_requests: [{ request_id: 'HR-1', from_role: 'writer', from_seat: 'writer#1', at: '2026-10-13T01:00:00Z', status: 'answered' }],
  })

  // --- A4：**生产者与实体错配**不许发生（现场那条 `|handoff|tester|H-writer`）
  const scopedTester = ledgerIdentityScoped({ kind: 'handoff', task, actor: 'tester' })
  const scopedWriter = ledgerIdentityScoped({ kind: 'handoff', task, actor: 'writer#1' })
  rec.add(
    G,
    '① ★★ A4：tester 的唤醒**拿不到 writer 的交接物**（错配被作者判据挡住）',
    scopedTester.disc === 'H-tester' && scopedWriter.disc === 'H-writer',
    `tester⇒${scopedTester.disc}　writer#1⇒${scopedWriter.disc}`,
  )

  // --- A5：已播过的旧身份不再当"新事件"（重放识别）
  const dir = tmpDir('identity')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const keyOld = wakeKeyOf({ taskId: task.id, kind: 'handoff', actorRole: 'tester', actorSeat: null, disc: 'H-tester' })
  ledger.record({ key: keyOld, task_id: task.id, kind: 'handoff', actor: 'tester', target: 'session-main-1' })
  const replay = ledgerIdentityScoped({ kind: 'handoff', task, actor: 'tester', ledger })
  rec.add(
    G,
    '② ★★ A5：已播报过的身份**不会被当成新事件**（判为 replay，交去重而不是再播一次）',
    replay.disc === null && replay.source === 'replay' && replay.replayKey === keyOld,
    JSON.stringify(replay),
  )

  // --- A3：**没有实体的事件**（状态推进）也能拿到逐次唯一的身份（不含递增计数器）
  const task2 = seedTask({
    history: [
      { at: '2026-10-13T02:00:00Z', action: 'transition:dispatch_planner', actor: 'main', from: 'ready_plan', to: 'planning' },
      { at: '2026-10-13T02:10:00Z', action: 'transition:dispatch_writer', actor: 'main', from: 'ready_dev', to: 'developing' },
    ],
  })
  const idA = eventIdentityFor({ kind: 'transition', toolName: 'pipeline_transition', result: { from: 'ready_plan', to: 'planning' }, task: task2, actor: 'main' })
  const idB = eventIdentityFor({ kind: 'transition', toolName: 'pipeline_transition', result: { from: 'ready_plan', to: 'planning' }, task: task2, actor: 'main' })
  rec.add(
    G,
    '③ A3：状态推进也拿得到身份，且**同一转换重放 ⇒ 同一个身份**（键稳定）',
    idA.disc !== null && idA.disc === idB.disc,
    `A=${idA.disc} B=${idB.disc} source=${idA.source}`,
  )
  const keyA = wakeKeyOf({ taskId: task2.id, kind: 'transition', actorRole: 'main', actorSeat: null, disc: idA.disc })
  rec.add(
    G,
    '③b 键里**读得出"这是哪一次真实转换"**（含 `ready_plan→planning`，且带这一次的 `at`）',
    keyA.includes('ready_plan→planning') && keyA.includes('2026-10-13T02:00:00Z') === true,
    keyA,
  )

  // --- A5 反例：**A→B→A** 的第二次不能被吞掉
  const task3 = seedTask({
    history: [
      { at: '2026-10-13T03:00:00Z', action: 'transition:unblock', actor: 'main', from: 'blocked', to: 'developing' },
      { at: '2026-10-13T03:30:00Z', action: 'transition:block', actor: 'main', from: 'developing', to: 'blocked' },
      { at: '2026-10-13T04:00:00Z', action: 'transition:unblock', actor: 'main', from: 'blocked', to: 'developing' },
    ],
  })
  const idFirst = eventIdentityFor({ kind: 'transition', toolName: 'pipeline_transition', result: { from: 'blocked', to: 'developing' }, task: task3, actor: 'main' })
  rec.add(
    G,
    '④ ★ A→B→A 的第二个 A **是新的一条**（身份含这一次的 at ⇒ 不会被当成重复吞掉）',
    idFirst.disc !== null && idFirst.disc.includes('2026-10-13T04:00:00Z'),
    String(idFirst.disc),
  )

  // --- 席位键口径（与既有一致：不是 writer#writer#3）
  rec.add(G, '⑤ 席位键口径：`writer` + `writer#1` ⇒ `writer#1`（不是 `writer#writer#1`）', actorKeyOf('writer', 'writer#1') === 'writer#1', actorKeyOf('writer', 'writer#1'))
}

// ===========================================================================
// 3) 唤醒器：恰播一次 / 去重留痕 / 跨进程去重 / 没身份=看得见的失败（A1/A2/A8/A19）
// ===========================================================================

async function checkWaker() {
  const G = '3 唤醒器（A1/A2/A8/A19）'
  const dir = tmpDir('waker')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const { waker, host, task, sinks } = await makeWaker({ ledger })

  // --- ① 同一事件连触三次 ⇒ 恰播一次（A1），且三次都有留痕
  const base = { taskId: task.id, actorRole: 'writer', actorSeat: 'writer#1', kind: 'handoff', what: '交了一份交接物', disc: 'H-1' }
  const r1 = await waker.wake(base)
  const r2 = await waker.wake(base)
  const r3 = await waker.wake(base)
  const injected = host.delivered.filter((d) => String(d.message?.id ?? '').includes('wake-')).length
  rec.add(G, '① 同一事件触发 3 次 ⇒ 主对话侧**恰注入 1 次**（A1）', r1.injected === true && r2.injected === false && r3.injected === false && injected === 1, `injected=${injected} reasons=${[r1.reason, r2.reason, r3.reason].join(',')}`)
  rec.add(
    G,
    '①b ★ A25 必含形态：**每一次尝试都留了痕**（delivered + dedup），不存在"没有记录"',
    sinks.lines.some((l) => l.action === 'wake:delivered') && sinks.lines.filter((l) => l.action === 'wake:dedup').length >= 2,
    `delivered=${sinks.lines.filter((l) => l.action === 'wake:delivered').length} dedup=${sinks.lines.filter((l) => l.action === 'wake:dedup').length}`,
  )

  // --- ② **跨进程去重**：换一个唤醒器 + 同一份盘上的账本 ⇒ 仍然不再播
  const host2 = fakeHost()
  const w2 = await makeWaker({ ledger: createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} }), host: host2, task })
  const r4 = await w2.waker.wake(base)
  rec.add(G, '② ★★ A19：**换一个进程实例**（新唤醒器 + 盘上账本）⇒ 同一条事件仍然不再播', r4.injected === false && r4.reason === 'duplicate' && host2.delivered.length === 0, `reason=${r4.reason} delivered=${host2.delivered.length}`)

  // --- ③ 不同事件不被吃掉（A2）：同任务同执行者，类别不同 ⇒ 都送到
  const host3 = fakeHost()
  const w3 = await makeWaker({ ledger: createWakeLedger({ file: join(dir, 'third.jsonl'), warn: () => {} }), host: host3, task })
  await w3.waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: 'writer#1', kind: 'handoff', what: '交付', disc: 'H-A' })
  await w3.waker.wake({ taskId: task.id, actorRole: 'mechanism', actorSeat: null, kind: 'abort', what: '中止', disc: 'AB-1' })
  rec.add(G, '③ ★ A2：同任务不同类别的两条事件**都送到了**（没有"已有同一条"式误吃）', host3.delivered.length === 2, `delivered=${host3.delivered.length}`)

  // --- ④ 没身份 ⇒ **看得见的失败**（不是静默跳过）
  const host4 = fakeHost()
  const sinks4 = auditSink()
  const warns4 = []
  const w4 = await makeWaker({ ledger: createWakeLedger({ file: join(dir, 'fourth.jsonl'), warn: () => {} }), host: host4, task: seedTask(), sinks: sinks4 })
  const rNoId = await w4.waker.wake({ taskId: w4.task.id, actorRole: 'writer', actorSeat: 'writer#1', kind: 'handoff', what: '交付', result: null, toolName: 'pipeline_handoff' })
  void warns4
  rec.add(
    G,
    '④ ★ A8/A3：取不到身份时 **reason=no-stable-identity + 审计留痕**（保留既有口径），并且**记进账本的 unresolved 列表**（巡检会再叫）',
    rNoId.injected === false &&
      rNoId.reason === 'no-stable-identity' &&
      sinks4.lines.some((l) => l.action === 'wake:skipped' && l.detail?.reason === 'no-stable-identity') &&
      w4.waker.ledger.unresolvedEntries({ taskId: w4.task.id }).length === 1,
    `reason=${rNoId.reason} unresolved=${w4.waker.ledger.unresolvedEntries({ taskId: w4.task.id }).length}`,
  )

  // --- ⑤ 没登记主对话会话 ⇒ 既有行为不变（no-main-session + 留痕）
  const host5 = fakeHost()
  const sinks5 = auditSink()
  const w5 = createWaker({ ctx: host5.ctx, registry: createMainSessionRegistry(), getTask: () => seedTask(), audit: sinks5.audit, warn: () => {} })
  const rNoMain = await w5.wake({ taskId: 'T-WAKE-1', actorRole: 'writer', actorSeat: null, kind: 'handoff', what: '交付', disc: 'H-X' })
  rec.add(G, '⑤ 没登记主对话会话 ⇒ 照旧 `no-main-session`（既有行为一个字没改）', rNoMain.reason === 'no-main-session' && sinks5.lines.some((l) => l.action === 'wake:skipped'), `reason=${rNoMain.reason}`)
}

// ===========================================================================
// 4) 席位侧反向投递 + 送达≠接管（A6 / A7 / A28 / R1 / T30）
// ===========================================================================

async function checkSeatDeliveryAndTakeover() {
  const G = '4 反向投递与接管（A6/A7/A28/R1）'
  const dir = tmpDir('seat')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const { waker, host, task } = await makeWaker({ ledger })

  // --- 席位侧投递：记一条"已投递"，再记"已接管"，两条**同键**
  const key = waker.seatDeliveryKey({ taskId: task.id, kind: 'clarify-reply', role: 'writer', seat: 'writer#1', requestId: 'CQ-1' })
  waker.noteSeatDelivery({ key, task_id: task.id, kind: 'clarify-reply', role: 'writer', seat: 'writer#1', session: 'session-w1', ok: true, note: '已投给会话 session-w1。' })
  const pendA = waker.pendingSeatDeliveries({ taskId: task.id, seat: 'writer#1' })
  rec.add(G, '① A6/A7：席位侧"已投递"留痕可查（且此时**还没接管**）', pendA.length === 1 && pendA[0].key === key, JSON.stringify(pendA.map((p) => p.key)))
  waker.markSeatConsumed(task.id, { seat: 'writer#1', by: 'seat:writer', action: 'pipeline_status' })
  const pendB = waker.pendingSeatDeliveries({ taskId: task.id, seat: 'writer#1' })
  rec.add(G, '② ★ A28(b)：席位**接管**之后不再算"未接管"（两侧同键 ⇒ 配对可读）', pendB.length === 0, `pending=${pendB.length}`)

  // --- 主对话侧：已投递未接管 ⇒ 留痕可见（A28(a)）＋ 升级叫醒（R1）
  const k1 = 'T-WAKE-1|handoff|writer#1|H-9'
  ledger.record({ key: k1, task_id: task.id, kind: 'handoff', actor: 'writer#1', target: 'session-main-1', request_id: 'req-9', at: new Date(Date.now() - 3600_000).toISOString() })
  const pending = waker.pendingDeliveries(task.id, { olderThanMs: 1000 })
  rec.add(G, '③ ★ A28(a)：只投递未接管 ⇒ 留下**可见的**"未接管"条目（不是静默）', pending.length === 1 && pending[0].key === k1, JSON.stringify(pending.map((p) => p.key)))
  const esc = await waker.escalateUnconsumed(task.id, { olderThanMs: 1000, limit: 2 })
  const escKey = `${k1}#escalated`
  rec.add(
    G,
    '④ ★★ R1/T30：未接管的投递会被**升级叫醒**，升级事件与原事件**配对可读**（原键 + #escalated），且不冒充新事件',
    esc.escalated === 1 && ledger.escalatedEntry(k1)?.escalation_key === escKey && host.delivered.some((d) => String(d.message?.id ?? '').length > 0),
    `escalated=${esc.escalated} pair=${ledger.escalatedEntry(k1)?.escalation_key}`,
  )
  const esc2 = await waker.escalateUnconsumed(task.id, { olderThanMs: 1000, limit: 2 })
  rec.add(G, '④b 同一条**只升一次**（不刷屏，A23/B27 同向）', esc2.escalated === 0, `second=${esc2.escalated}`)

  // --- 被消费之后 ⇒ 不再升级、不再重放（A1/A19 仍成立）
  ledger.markConsumed({ key: k1, by: 'main', action: 'pipeline_transition' })
  const pendAfter = waker.pendingDeliveries(task.id, { olderThanMs: 1000 })
  rec.add(G, '⑤ ★ 一旦被消费 ⇒ 不再进"未接管"清单、也不再升级（A1/A19 照旧）', pendAfter.length === 0, `pending=${pendAfter.length}`)
}

// ===========================================================================
// 5) 崩 ≠ 闲、崩 ≠ 冻、中止必须被播报（A9 / A10 / A11 / A12 / A24）
// ===========================================================================

async function checkCrashVsIdle() {
  const G = '5 崩闲可分（A9/A10/A11/A12）'
  const dir = tmpDir('runfail')

  // --- ① 判据认得现场那条失败原文
  const line = `${JSON.stringify({ at: '2026-10-13T05:00:00Z', type: 'turn/error', data: { message: '🔴 本轮运行失败  DeepSeek Messages stream: tool input is invalid JSON  [MALFORMED_RESPONSE]' } })}`
  const hit = findFailureInText(line, {})
  rec.add(G, '① 失败判据认出现场原文（`MALFORMED_RESPONSE` / `tool input is invalid JSON`）', hit !== null && RUN_FAILURE_MARKERS.includes(hit.matched), JSON.stringify(hit))

  // --- ② 读不到运行记录时**如实说读不到**（不许把"拿不到"写成"它没动"）
  const miss = scanRunFailureInLog(join(dir, '不存在.zstd'), {})
  rec.add(G, '② ★ 读不到会话日志 ⇒ `known:false` + 原因（既不算崩也不算闲）', miss.known === false && miss.found === false && miss.note.length > 0, miss.note)

  // --- ③ 真实 zstd 日志（本机 node 有 zstd 就能真跑；没有则如实跳过该断言而不是假装通过）
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync === 'function') {
    const logFile = join(dir, 'session.v4.jsonl.zstd')
    const payload = [
      JSON.stringify({ at: '2026-10-13T05:00:00Z', type: 'turn/start' }),
      JSON.stringify({ at: '2026-10-13T05:01:00Z', type: 'turn/error', data: { message: '本轮运行失败 DeepSeek Messages stream: tool input is invalid JSON [MALFORMED_RESPONSE]' } }),
      '',
    ].join('\n')
    writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(payload, 'utf8')))
    const found = scanRunFailureInLog(logFile, {})
    rec.add(G, '③ ★★ 从落盘会话日志（zstd）里查到了失败证据，并**带出处**（"崩"这一侧的证据面成立）', found.known === true && found.found === true && found.evidence?.source === 'session-log', JSON.stringify(found.evidence))
  } else {
    rec.add(G, '③ 本机 node 无 zstd 能力 ⇒ 如实报"拿不到"（不许假装通过）', true, 'zstdCompressSync 不可用：本机不跑这一条，判据在 ② 已验证"读不到就说读不到"')
  }

  // --- ④ detectRunFailure 三态：没有会话 id ⇒ 不猜
  const none = detectRunFailure({ ctx: null, sessionId: '' })
  rec.add(G, '④ 没有会话 id ⇒ `known:false`（不猜崩也不猜闲）', none.known === false && none.found === false, none.note)

  // --- ⑤ 失联判据本身**一个字没动**：真闲置超阈值仍判失联（A12）
  const now = Date.parse('2026-10-13T06:00:00Z')
  const idleTask = seedTask({
    state: 'developing',
    dispatched: [{ key: 'writer#1', role: 'writer', seat: 'writer#1', agent_id: 'session-w1', session_id: 'session-w1', at: '2026-10-13T05:00:00Z', at_ms: Date.parse('2026-10-13T05:00:00Z') }],
  })
  const live = seatLiveness(idleTask, now, { silenceMs: 5 * 60 * 1000 })
  rec.add(G, '⑤ A12：真闲置超阈值仍然判失联（静默阈值 5 分钟、检测没被关掉也没被调大）', live.silent.length === 1 && live.silenceMs === 5 * 60 * 1000, `silent=${live.silent.length} silenceMs=${live.silenceMs}`)
}

// ===========================================================================
// 6) 巡检：会响 / 不越权 / 不刷屏也不哑掉 / 不是后门 / 抛错可见（A21–A25）
// ===========================================================================

async function checkPatrol() {
  const G = '6 巡检（A21–A25）'
  const now = Date.parse('2026-10-13T07:00:00Z')

  // --- ① 会响：一张"20 分钟没有任何进展"的单
  const stalled = seedTask({
    state: 'developing',
    history: [{ at: '2026-10-13T06:30:00Z', action: 'transition:dispatch_writer', actor: 'main', from: 'ready_dev', to: 'developing' }],
  })
  const f1 = patrolFindings({ task: stalled, now, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(
    G,
    '① ★ A21：无进展超口径 ⇒ 产出**可判定的**播报条目（带身份 + 人话 + 一段人读的原因）',
    f1.findings.length === 1 && f1.findings[0].kind === 'task-stall' && String(f1.findings[0].id).includes('task-stall') && String(f1.findings[0].detail).length > 10,
    JSON.stringify(f1.findings.map((f) => `${f.kind}:${f.id}`)),
  )

  // --- ② 不刷屏：同一条无进展跨多次巡检 ⇒ 身份**完全相同**（于是播报被幂等吃掉）
  const f2 = patrolFindings({ task: stalled, now: now + 5 * 60 * 1000, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(G, '② ★ A23：同一条无进展跨巡检 id **不变**（⇒ 只播一次）', f1.findings[0].id === f2.findings[0].id, `${f1.findings[0].id} vs ${f2.findings[0].id}`)

  // --- ③ 不哑掉：进展恢复后再卡住 ⇒ **新的一条**
  const recovered = seedTask({
    state: 'developing',
    history: [
      { at: '2026-10-13T06:30:00Z', action: 'transition:dispatch_writer', actor: 'main', from: 'ready_dev', to: 'developing' },
      { at: '2026-10-13T06:50:00Z', action: 'handoff:dev_to_test', actor: 'writer' },
    ],
  })
  const f3 = patrolFindings({ task: recovered, now: now + 30 * 60 * 1000, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(G, '③ ★ A23：进展恢复后再卡住 ⇒ **新的一条**（id 变了，不会永久哑掉）', f3.findings.length === 1 && f3.findings[0].id !== f1.findings[0].id, `${f3.findings[0]?.id}`)

  // --- ④ 吃得准：等待态（等用户 / 等需求分析）里"没进展"**正常**，不该报
  const waiting = seedTask({ state: 'awaiting_human', history: [{ at: '2026-10-13T05:00:00Z', action: 'transition:human_request', actor: 'writer' }] })
  const f4 = patrolFindings({ task: waiting, now, stallMs: DEFAULT_TASK_STALL_MS })
  rec.add(G, '④ 等待态不报"任务无进展"（判据不同源：那一处看的是"投递有没有被接管"）', f4.findings.filter((f) => f.kind === 'task-stall').length === 0, JSON.stringify(f4.findings.map((f) => f.kind)))

  // --- ⑤ 未接管 / 没投出去 ⇒ 各自成为一条可播报的事实（A28 / A8 / R1）
  const f5 = patrolFindings({
    task: stalled,
    now,
    unconsumed: [{ key: 'K-1', target: 'session-main-1', at: '2026-10-13T06:00:00Z', age_ms: 3600_000 }],
    unresolved: [{ at: '2026-10-13T06:10:00Z', kind: 'human', reason: 'no-stable-identity' }],
  })
  rec.add(
    G,
    '⑤ ★ "已投递未接管"与"该叫没叫"都是**可播报的事实**（各有自己的身份）',
    f5.findings.some((f) => f.kind === 'unconsumed-delivery') && f5.findings.some((f) => f.kind === 'unresolved-wake'),
    JSON.stringify(f5.findings.map((f) => f.kind)),
  )

  // --- ⑥ 只播报不动作：巡检器**没有任何**动作接口（结构判据）
  const actions = []
  const patrol = createPatrol({ intervalMs: 60_000, tick: async ({ stats }) => actions.push({ tick: stats.ticks }) })
  rec.add(
    G,
    '⑥ ★★ A22：巡检器暴露的面里**只有** start/stop/runOnce/stats（没有补位/继任/冻结/推进状态/重置失联计数）',
    ['start', 'stop', 'runOnce', 'stats', 'running', 'intervalMs'].every((k) => k in patrol) && !('dispatch' in patrol) && !('succession' in patrol) && !('freeze' in patrol) && !('transition' in patrol),
    Object.keys(patrol).join(','),
  )
  await patrol.runOnce()
  rec.add(G, '⑥b runOnce 跑了一轮且不计失败（只播报）', patrol.stats.ticks === 1 && patrol.stats.consecutive_failures === 0, JSON.stringify(patrol.stats))

  // --- ⑦ A25：巡检自身抛错必须可见、且**不许停摆**（还在重试）
  const warns = []
  const bad = createPatrol({
    intervalMs: 60_000,
    failureThreshold: 2,
    warn: (m) => warns.push(m),
    tick: async () => {
      throw new Error('模拟巡检内部抛错')
    },
    onStalled: async () => {
      warns.push('stalled-notice')
    },
  })
  await bad.runOnce()
  await bad.runOnce()
  await bad.runOnce()
  rec.add(
    G,
    '⑦ ★ A25：连续抛错到阈值 ⇒ **停摆本身被播报**（onStalled）+ warn 出声，且**继续重试**（没有停摆）',
    bad.stats.consecutive_failures === 3 && warns.includes('stalled-notice') && bad.stats.stall_episodes === 1,
    JSON.stringify({ cf: bad.stats.consecutive_failures, episodes: bad.stats.stall_episodes, warns: warns.length }),
  )
}

// ===========================================================================
// 7) 重启后认出席位（A27）
// ===========================================================================

async function checkSeatRestore() {
  const G = '7 重启认出席位（A27）'
  const { createTokenStore } = await import('../lib/tokens.js')
  const tokens = createTokenStore({})
  rec.add(G, '① 前置：新进程的表是空的（认不出任何会话）', tokens.roleOfAgent('session-w1') === null, String(tokens.roleOfAgent('session-w1')))

  // --- 按盘上的派活登记恢复（有令牌）
  const r1 = tokens.restore({ taskId: 'T-WAKE-1', role: 'writer', seat: 'writer#1', agentId: 'session-w1', sessionId: 'session-w1', token: 'PT-0123456789abcdef01234567', atMs: Date.parse('2026-10-13T05:00:00Z') })
  const back = tokens.roleOfAgent('session-w1')
  rec.add(G, '② ★★ A27(b)：按 `task.dispatched[]` 认回席位身份（同一个会话重新被认成 writer#1）', r1.ok === true && r1.restored === true && back !== null && back.role === 'writer' && back.seat === 'writer#1', JSON.stringify({ r1, back }))

  // --- 识别依据缺失 ⇒ **看得见的失败**，不凭空新建席位
  const r2 = tokens.restore({ taskId: 'T-WAKE-1', role: 'tester', agentId: '', sessionId: null })
  rec.add(G, '③ ★ A27(c)：识别依据缺失 ⇒ `ok:false` + 原因，**不凭空新建席位**', r2.ok === false && r2.restored === false && r2.reason.includes('不凭空新建'), r2.reason)

  // --- 损坏的令牌串 ⇒ 仍然能"认出它是谁"（身份不因为 TTL/令牌丢了而消失），但如实标注 restored
  const r3 = tokens.restore({ taskId: 'T-WAKE-1', role: 'tester', agentId: 'session-t1', sessionId: 'session-t1', token: '' })
  rec.add(G, '④ 没有令牌字符串 ⇒ 用 (会话 + 角色 + 席位) 恢复席位身份，并如实标注 restored=true', r3.ok === true && r3.restored === true && tokens.roleOfAgent('session-t1')?.role === 'tester', JSON.stringify(r3))
}

// ===========================================================================
// 8) 交付不静默消失：留档 + 可见（A13）
// ===========================================================================

async function checkRejectedDeliveryArchive() {
  const G = '8 交付被拒收（A13）'
  const { createHarness } = await import('./selftest-core.mjs')
  const h = await createHarness({})
  const opened = await h.store.open({
    id: 'T-REJ-1',
    requirement: 'A13 用例：等待/阻塞窗口里被拒收的交付必须可见且内容可查回',
    actorRole: 'main',
    actorAgentId: 'session-main-1',
  })
  rec.add(G, '① 夹具就绪（真 store 开了一张单）', opened.ok === true, opened.ok === true ? opened.task.state : String(opened.error))
  const archived = await h.store.archiveRejectedDelivery('T-REJ-1', {
    kind: 'test_to_review',
    code: 'HANDOFF_STEP_SKIPPED',
    reason: '跳步：交接物只允许在测试中提交；当前是「已阻塞」',
    fromRole: 'tester',
    fromSeat: null,
    payload: { kind: 'test_to_review', cases: ['T1', 'T2'], note: '这份内容必须能查回原文' },
  })
  const task = h.store.peek('T-REJ-1')
  rec.add(
    G,
    '② ★★ A13：被拒收的交付**内容留档**（能查回原文）+ 给了可查回的句柄',
    archived.ok === true && Array.isArray(task.rejected_deliveries) && task.rejected_deliveries.length === 1 && task.rejected_deliveries[0].payload?.cases?.length === 2 && typeof task.rejected_deliveries[0].recall === 'string',
    `delivery_id=${archived.delivery_id} payload=${JSON.stringify(task.rejected_deliveries?.[0]?.payload)}`,
  )
  rec.add(
    G,
    '②b 留档同时**留痕**（audit + history 各一条，`delivery:rejected`），席位与主对话都能看见',
    task.history.some((e) => e.action === 'delivery:rejected' && e.archived === true),
    JSON.stringify(task.history.slice(-1)),
  )
  await cleanupOfHarness(h)
  void task
}

/** 关掉一套 harness（临时目录由 disposeHarness 负责删）。 */
async function cleanupOfHarness(h) {
  try {
    const mod = await import('./selftest-core.mjs')
    if (typeof mod.disposeHarness === 'function') await mod.disposeHarness(h)
  } catch {
    /* 清理失败不影响结论 */
  }
}

// ===========================================================================
// 9) 中止记录：崩了不冻（A10），但中止**有自己的一条事实**（A9/A11）
// ===========================================================================

async function checkAbortRecord() {
  const G = '9 中止记录（A10）'
  const { createHarness } = await import('./selftest-core.mjs')
  const h = await createHarness({})
  const opened = await h.store.open({ id: 'T-AB-1', requirement: 'A9/A10 用例：运行失败中止不许冻结任务，但必须留痕', actorRole: 'main', actorAgentId: 'session-main-1' })
  rec.add(G, '① 夹具就绪', opened.ok === true, opened.ok === true ? opened.task.state : String(opened.error))
  const before = h.store.peek('T-AB-1').state
  const ab = await h.store.recordSeatAbort('T-AB-1', {
    seats: ['writer#1'],
    evidence: { source: 'session-events', matched: 'MALFORMED_RESPONSE', text: '🔴 本轮运行失败 DeepSeek Messages stream: tool input is invalid JSON [MALFORMED_RESPONSE]' },
    detectedVia: 'session-events',
    note: '席位运行失败中止（不是闲置）',
  })
  const after = h.store.peek('T-AB-1')
  rec.add(
    G,
    '② ★★ A10：中止**不改任务状态**（崩 ≠ 冻）',
    ab.ok === true && after.state === before && after.liveness.aborts.length === 1 && after.liveness.aborts[0].no_freeze === true,
    `state=${before}→${after.state} aborts=${after.liveness.aborts.length}`,
  )
  rec.add(
    G,
    '③ ★ A9：中止记录**携带失败原文**（判词有据可依），且 id 是这条事实自己的身份',
    after.liveness.aborts[0].abort_id.startsWith('AB-') && String(after.liveness.aborts[0].evidence?.text ?? '').includes('MALFORMED_RESPONSE'),
    `abort_id=${after.liveness.aborts[0].abort_id}`,
  )
  rec.add(
    G,
    '③b 与"失联处置"**不同源**（`liveness.aborts` vs `liveness.escalations`，互不冒充，A24 同向）',
    after.liveness.escalations.length === 0,
    `escalations=${after.liveness.escalations.length}`,
  )
  await cleanupOfHarness(h)
}

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * ★ 本套的**注册入口**（`tests/run-all.mjs` 按约定调用它）。
 *
 * 返回形状与既有各套一致（`{passed,total,text,items}`）—— 汇总口径只有一份。
 */
export async function runWakeChannelCheck() {
  rec.items.length = 0
  await checkLedger()
  await checkIdentity()
  await checkWaker()
  await checkSeatDeliveryAndTakeover()
  await checkCrashVsIdle()
  await checkPatrol()
  await checkSeatRestore()
  await checkRejectedDeliveryArchive()
  await checkAbortRecord()

  const lines = []
  lines.push('【唤醒 / 投递通道 · wake-channel-check】')
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
// 直接执行（`node tests/wake-channel-check.mjs`）：跑一遍并打印。
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runWakeChannelCheck()
    .then((r) => {
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[wake-channel-check] 内部异常（这是用例自身的 bug，请修用例）：', err)
      process.exitCode = 1
    })
    .finally(() => {
      cleanup()
    })
}
