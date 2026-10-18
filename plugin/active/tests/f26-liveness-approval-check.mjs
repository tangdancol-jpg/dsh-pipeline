// P1-4 回归：ask 审批策略下席位弹审批卡等人，不许被判成「失联」。
/**
 * dsh-pipeline · F26：liveness 分不清「死了」与「在等审批」
 * ============================================================================
 *     node tests/f26-liveness-approval-check.mjs
 *
 * 现场（`内部复盘（2026-10-18，不公开）` P1-4）：
 *   `ask` 审批策略下席位弹出审批卡**等人点**；主对话那边 6 分 34 秒后 liveness
 *   判它「失联」，判词还写「不是它还在想，它可能已经死了」⇒ 主对话据此重派
 *   ⇒ **白烧 30 分钟**。
 *
 * 本套钉住（全部用夹具注入 pending 状态，**不真弹审批**）：
 *   A. 纯判据 `foldApprovalEvents`：asked 无配对 decided = 还在等；配对 = 已结；
 *      pending 的顺序 / 工具名 / 策略；输入读不到 ⇒ `known:false`（不是"没有"）。
 *   B. 落盘日志：会话日志是**多帧 zstd 串接**（单帧 API 只读得到 session 头），
 *      多帧解压 + 文本折叠能读出待批；尾部被截断不抛。
 *   C. 宿主面采样：进程内会话事件优先；拿不到再读落盘日志；都读不到 ⇒ `known:false`。
 *   D. `seatLiveness`：**同一份台账**，没审批 ⇒ 照旧 `silent`（真死不被豁免）；
 *      有 pending 审批 ⇒ 不进 `silent`、进 `awaiting`，判词是"在等审批"。
 *   E. 端到端 `store.checkLiveness`：误诊消失（不冻结、不改状态、留痕且幂等）；
 *      反例（读到了但没有待批）照旧冻结。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

import { createHarness, disposeHarness } from './selftest-core.mjs'
import {
  decompressZstdFramesLossy,
  describeApprovalWait,
  detectPendingApprovals,
  foldApprovalEvents,
  foldApprovalText,
  scanApprovalsInAgent,
  scanApprovalsInLog,
  seatKey,
  seatLiveness,
  summarizeApprovalWait,
  zstdFrameOffsets,
} from '../lib/liveness.js'

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
    text() {
      const L = ['dsh-pipeline · F26：liveness 分不清「死了」与「在等审批」（P1-4）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

// ---------------------------------------------------------------------------
// 夹具：宿主事件形状（与真实会话日志逐字同形，见 append 的 payload）
// ---------------------------------------------------------------------------
const evAsked = (id, toolName, extra = {}) => ({ type: 'approval/asked', seq: 2, time: Date.now(), data: { id, toolName, ...extra } })
const evDecided = (id, outcome = 'allowed-once') => ({ type: 'approval/decided', seq: 3, time: Date.now(), data: { id, outcome } })
const evPolicy = (policy) => ({ type: 'approval/policy', seq: 1, time: Date.now(), data: { policy } })
const evUser = (text) => ({ type: 'user/message', seq: 4, time: Date.now(), data: { content: [{ type: 'text', text }] } })

/** 把若干事件写成**多帧 zstd** 会话日志（真实宿主就是"一次 append 一帧"）。 */
function zstdFramesOf(lines) {
  const frames = []
  for (const line of lines) frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')))
  return Buffer.concat(frames)
}

/** 落盘一个会话的 `session.v4.jsonl.zstd`（多帧），返回会话根。 */
async function writeSessionLog(sessionsRoot, sessionId, events) {
  const dir = join(sessionsRoot, 'bucket', sessionId)
  await mkdir(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd: 'C:/f26-fixture' }
  const buf = zstdFramesOf([header, ...events])
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), buf)
  return { dir, file: join(dir, 'session.v4.jsonl.zstd'), bytes: buf.length }
}

/** 夹具席位（已派 10 分钟、无任何活着的证据）。 */
function deadSeat(sessionId, nowMs) {
  return {
    key: 'writer',
    role: 'writer',
    seat: null,
    agent_id: null,
    session_id: sessionId,
    token: 'f26-token',
    at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
    at_ms: nowMs - 10 * 60 * 1000,
    via: 'subagent',
  }
}

function livenessTask(nowMs, sessionId = 'f26-seat-nolog') {
  return {
    id: 'T-F26-LIVE',
    state: 'developing',
    dispatched: [deadSeat(sessionId, nowMs)],
    handoffs: [],
    history: [],
    writer_submissions: {},
    context_reports: [],
    successions: [],
    liveness: { escalations: [], samples: {}, quiet: {} },
  }
}

/** approvals 映射夹具：key → {known, pending}。 */
function approvalsFor(key, pending, policy = 'ask') {
  return {
    [key]: { known: true, pending, asked: pending.length, decided: 0, policy, source: 'session-events', note: '夹具：读到审批事件' },
  }
}

const pendingItem = (id = 'AP-1', toolName = 'pwsh') => ({ id, tool_name: toolName, call_id: 'call_f26', reason: null, at_ms: Date.now() })

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
export async function runF26LivenessApprovalCheck() {
  const rec = createRecorder()
  const cleanup = []
  try {
    // =======================================================================
    // A. 纯判据：approval/asked 无配对 decided = 还在等
    // =======================================================================
    {
      const G = 'A 纯判据 foldApprovalEvents'
      const one = foldApprovalEvents([evPolicy('ask'), evUser('hi'), evAsked('AP-1', 'pwsh', { callId: 'call_a', reason: '要写文件' })])
      rec.add(G, '★ asked 没有配对的 decided ⇒ 1 条 pending', one.known === true && one.pending.length === 1, JSON.stringify(one.pending))
      rec.add(G, '★ pending 带着工具名 / callId / 原因（判词要写给人看）', one.pending[0]?.tool_name === 'pwsh' && one.pending[0]?.call_id === 'call_a' && one.pending[0]?.reason === '要写文件', JSON.stringify(one.pending[0]))
      rec.add(G, '★ 顺带读到会话审批策略（ask）', one.policy === 'ask', String(one.policy))

      const closed = foldApprovalEvents([evAsked('AP-1', 'pwsh'), evDecided('AP-1')])
      rec.add(G, '★★ asked + 同 id decided ⇒ 0 条 pending（人已经点过了）', closed.pending.length === 0, JSON.stringify(closed))

      const mixed = foldApprovalEvents([evAsked('AP-1', 'pwsh'), evAsked('AP-2', 'write'), evDecided('AP-1')])
      rec.add(G, '★ 两条 asked、只结了 AP-1 ⇒ pending 只剩 AP-2', mixed.pending.length === 1 && mixed.pending[0].id === 'AP-2', JSON.stringify(mixed.pending.map((p) => p.id)))

      const dup = foldApprovalEvents([evAsked('AP-1', 'pwsh'), evAsked('AP-1', 'pwsh')])
      rec.add(G, '★ 同一个 id 重复 asked 只算一条（防脏）', dup.pending.length === 1 && dup.asked === 2, `pending=${dup.pending.length} asked=${dup.asked}`)

      const unreadable = foldApprovalEvents(null)
      rec.add(G, '★★ 读不到（输入不是数组）⇒ known:false —— **不是**"没有审批"', unreadable.known === false, JSON.stringify(unreadable))
    }

    // =======================================================================
    // B. 落盘日志：多帧 zstd + 文本折叠
    // =======================================================================
    {
      const G = 'B 多帧 zstd 会话日志'
      const fmts = zstdFramesOf([{ type: 'session', version: 4, id: 's1' }, evUser('一'), evAsked('AP-9', 'bash')])
      const offs = zstdFrameOffsets(fmts)
      rec.add(G, '夹具：日志确实被切成 3 个 zstd 帧（宿主"一次 append 一帧"）', offs.length === 3, `帧起点：${offs.join(', ')}`)
      const dec = decompressZstdFramesLossy(fmts)
      rec.add(G, '★★ 多帧解压拿到全部 3 帧的文本（不是只有 session 头）', dec.ok === true && dec.frames === 3 && dec.text.includes('approval/asked') && dec.text.includes('user/message'), `frames=${dec.frames} bad=${dec.bad} chars=${dec.text.length}`)
      const folded = foldApprovalText(dec.text)
      rec.add(G, '★★ 折叠这段文本 ⇒ 1 条 pending（AP-9 / bash）', folded.pending.length === 1 && folded.pending[0].id === 'AP-9' && folded.pending[0].tool_name === 'bash', JSON.stringify(folded.pending))

      // 尾部被截断（正在写）：不抛，已有事件照用
      const cut = dec.text.slice(0, dec.text.lastIndexOf('approval/asked') + 20)
      const foldedCut = foldApprovalText(cut)
      rec.add(G, '★ 尾部半行被截断 ⇒ 不抛（那半行 parse 失败跳过，前面的照样折叠）', foldedCut.known === true && Array.isArray(foldedCut.pending), `pending=${foldedCut.pending.length} chars=${cut.length}`)

      const empty = decompressZstdFramesLossy(Buffer.from('not zstd at all'))
      rec.add(G, '★ 不是 zstd 缓冲 ⇒ ok:false（如实说没读到，不猜）', empty.ok === false, empty.note)
    }

    // =======================================================================
    // C. 宿主面采样：进程内优先、落盘兜底、都读不到如实说
    // =======================================================================
    {
      const G = 'C 宿主面采样 detectPendingApprovals'
      const fakeCtx = (events) => ({
        get: (name) => (name === 'agents' ? { get: () => ({ session: { snapshotEvents: () => events } }) } : undefined),
      })
      const inProc = detectPendingApprovals({ ctx: fakeCtx([evAsked('AP-2', 'edit'), evUser('x')]), sessionId: 'session-f26-a' })
      rec.add(G, '★★ 进程内会话事件里查到了 pending ⇒ 优先用它', inProc.known === true && inProc.pending.length === 1 && inProc.source === 'session-events', `${inProc.source} / ${inProc.note}`)

      const inProcClosed = detectPendingApprovals({ ctx: fakeCtx([evAsked('AP-2', 'edit'), evDecided('AP-2')]), sessionId: 'session-f26-b' })
      rec.add(G, '★ 进程内读到、但已结 ⇒ known:true 且 0 条（"读到了没有" ≠ "读不到"）', inProcClosed.known === true && inProcClosed.pending.length === 0, inProcClosed.note)

      // 进程内拿不到 ⇒ 落盘兜底（夹具写一个真的多帧日志）
      const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-pipeline-f26-sessions-'))
      cleanup.push(sessionsRoot)
      const fixture = await writeSessionLog(sessionsRoot, 'session-f26-log', [evUser('在等你批'), evAsked('AP-7', 'pwsh', { callId: 'call_7' })])
      const fromLog = detectPendingApprovals({ ctx: { get: () => undefined }, sessionId: 'session-f26-log', sessionsRoot })
      rec.add(G, '★★ 进程内拿不到时，从落盘会话日志（多帧 zstd）里读到 pending', fromLog.known === true && fromLog.pending.length === 1 && fromLog.pending[0].id === 'AP-7' && fromLog.source === 'session-log', `${fromLog.source} / ${fromLog.note}\n夹具：${fixture.file}`)
      const direct = scanApprovalsInLog(fixture.file)
      rec.add(G, '★ scanApprovalsInLog 直读同一份日志结论一致', direct.known === true && direct.pending.length === 1, direct.note)

      // 都读不到 ⇒ known:false；且**不能**把"读不到"写成"没在等"
      const emptyRoot = await mkdtemp(join(tmpdir(), 'dsh-pipeline-f26-empty-'))
      cleanup.push(emptyRoot)
      const unreadable = detectPendingApprovals({ ctx: { get: () => undefined }, sessionId: 'session-f26-missing', sessionsRoot: emptyRoot })
      rec.add(G, '★★ 两处都读不到 ⇒ known:false（既不能说"在等"，也不能说"没在等"）', unreadable.known === false && unreadable.pending.length === 0, unreadable.note)

      const weird = scanApprovalsInAgent({ session: {} })
      rec.add(G, '★ agent 没有 snapshotEvents ⇒ known:false（不抛）', weird.known === false, weird.note)
    }

    // =======================================================================
    // D. 判据层 seatLiveness：在等审批 ≠ 失联
    // =======================================================================
    {
      const G = 'D seatLiveness：在等审批不是失联'
      const now = Date.now()
      const task = livenessTask(now)
      const base = seatLiveness(task, now)
      rec.add(G, '★★ 既有反例不变：没审批证据时超阈值 ⇒ 照旧判 silent（真死不被豁免）', base.silent.length === 1 && base.awaiting.length === 0, `silent=${base.silent.length} awaiting=${base.awaiting.length}`)
      rec.add(G, '★ 判词与改前一致（仍是"席位失联"那一段，不掺审批）', base.summary.includes('席位失联') && !base.summary.includes('在等审批'), base.summary.split('\n')[0])

      const key = seatKey('writer', null)
      const awaited = seatLiveness(task, now, { approvals: approvalsFor(key, [pendingItem('AP-3', 'pwsh'), pendingItem('AP-4', 'write')]) })
      rec.add(G, '★★ 同一份台账 + 宿主读到 2 条待批 ⇒ 该席位**不再**是 silent', awaited.silent.length === 0, `silent=${awaited.silent.length}`)
      rec.add(G, '★★ 它进了 awaiting（席位 / 计数 / 工具名都在）', awaited.awaiting.length === 1 && awaited.awaiting[0].approval.count === 2 && awaited.awaiting[0].approval.tools.includes('pwsh') && awaited.awaiting[0].approval.tools.includes('write'), JSON.stringify(awaited.awaiting[0]?.approval))
      rec.add(G, '★★ 判词写"在等审批、不是失联、不该被重派"', awaited.summary.includes('在等审批') && awaited.summary.includes('不该') && awaited.summary.includes('重派') && !awaited.summary.includes('可能已经死了'), awaited.summary.split('\n')[0])
      rec.add(G, '★ ok 仍为 true（等待审批不是 liveness 故障）', awaited.ok === true, String(awaited.ok))
      rec.add(G, '★ 计数器归零（在等审批不该累计"连续没证据"）', awaited.seats[0].quiet_streak === 0 && awaited.seats[0].awaiting_approval === true, `quiet_streak=${awaited.seats[0].quiet_streak}`)

      const unknown = seatLiveness(task, now, { approvals: { [key]: { known: false, pending: [], note: '读不到' } } })
      rec.add(G, '★★ 探测读不到（known:false）⇒ 照旧 silent（读不到不豁免）', unknown.silent.length === 1 && unknown.awaiting.length === 0, `silent=${unknown.silent.length}`)

      const closed = seatLiveness(task, now, { approvals: { [key]: { known: true, pending: [] } } })
      rec.add(G, '★ 读到了、但没在等 ⇒ 也照旧 silent（只加阳性证据）', closed.silent.length === 1, `silent=${closed.silent.length}`)

      const text = describeApprovalWait(awaited.awaiting, { taskId: task.id, state: task.state, state_zh: '开发中' })
      rec.add(G, '★ 判词里给"该怎么做"：去那个会话点审批卡 / 改 never 的策略含义', text.includes('审批卡') && text.includes('never'), text.split('\n').slice(0, 2).join('\n'))
      const short = summarizeApprovalWait(awaited.awaiting)
      rec.add(G, '★ 短版判词（进卡点清单用）带计数与"不是失联"', short.includes('2 个工具调用') && short.includes('不是失联'), short)
    }

    // =======================================================================
    // E. 端到端：store.checkLiveness 的误诊消失 + 反例不变
    // =======================================================================
    {
      const G = 'E store.checkLiveness 端到端'
      const h = await createHarness({})
      try {
        /** 造一张"开发中 + 编写已派 10 分钟 + 零证据"的单（不写盘的真会话，activity 结构上采不到）。 */
        const fresh = async (id) => {
          const opened = await h.store.open({ actorRole: 'main', requirement: 'F26 夹具：ask 审批等待不许被判失联。', id })
          if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
          const t = h.store.peek(id)
          t.state = 'developing'
          const nowMs = Date.now()
          // ★ session_id 故意**不是** `session-…` 形状：活动采样结构上采不到 ⇒
          //   判据退回台账三条（第一次观察即可判失联），本套要验的就是"审批把它救回来"。
          t.dispatched = [deadSeat('f26-seat-nolog', nowMs)]
          return t
        }
        const fakeProbe = async (seats) => ({
          approvals: Object.fromEntries(
            (Array.isArray(seats) ? seats : []).map((s) => [
              s.key,
              { known: true, pending: [pendingItem('AP-5', 'pwsh')], asked: 1, decided: 0, policy: 'ask', source: 'session-events', note: '夹具：席位在等审批' },
            ]),
          ),
          note: '夹具：1 个席位在等审批',
        })

        // --- 反例：没有探测 / 探测说"没在等" ⇒ 照旧冻结（真死席位不被新判据放过）
        const dead = await fresh('T-F26-DEAD')
        const deadRes = await h.store.checkLiveness('T-F26-DEAD', { escalate: true })
        rec.add(G, '★★ 反例：没有「在等审批」证据 ⇒ 照旧判失联并推到「已阻塞」', deadRes.ok === true && deadRes.escalated === true && h.store.peek('T-F26-DEAD').state === 'blocked', `escalated=${deadRes.escalated} state=${h.store.peek('T-F26-DEAD').state}`)

        const closedProbe = async (seats) => ({
          approvals: Object.fromEntries((Array.isArray(seats) ? seats : []).map((s) => [s.key, { known: true, pending: [], asked: 1, decided: 1, policy: 'never', source: 'session-events', note: '夹具：读到了，没有待批' }])),
          note: '夹具：读到了，没有待批',
        })
        await fresh('T-F26-CLOSED')
        const closedRes = await h.store.checkLiveness('T-F26-CLOSED', { escalate: true, probe: closedProbe })
        rec.add(G, '★★ 反例：探测读到了但无待批 ⇒ 照旧冻结（只认阳性证据）', closedRes.escalated === true && h.store.peek('T-F26-CLOSED').state === 'blocked', `escalated=${closedRes.escalated}`)

        // --- 正例：探测到 pending ⇒ 不冻结、不改状态、判词改写
        await fresh('T-F26-OK')
        const okRes = await h.store.checkLiveness('T-F26-OK', { escalate: true, probe: fakeProbe })
        const okTask = h.store.peek('T-F26-OK')
        rec.add(G, '★★ 探测到在等审批 ⇒ **不冻结**（escalated:false）', okRes.ok === true && okRes.escalated === false, `escalated=${okRes.escalated} note=${String(okRes.note ?? '')}`)
        rec.add(G, '★★ 任务状态**一步没动**（仍停在「开发中」）', okTask.state === 'developing', okTask.state)
        rec.add(G, '★★ 回执里 `silent` 空、`awaiting` 有 1 个席位（误诊消失的那一格）', okRes.silent.length === 0 && okRes.awaiting_count === 1, `silent=${okRes.silent.length} awaiting=${okRes.awaiting_count}`)
        rec.add(G, '★ 判词写"在等审批"且给"不要重派"', String(okRes.awaiting_text ?? '').includes('在等审批') && String(okRes.awaiting_text ?? '').includes('重派'), String(okRes.awaiting_summary ?? ''))

        // --- 留痕：只写一条（不冻结，但事后要说得出为什么没冻）
        const notices = okTask.liveness?.approvals_notified ?? null
        rec.add(G, '★ 留痕 `task.liveness.approvals_notified`：no_freeze + 计数 + 席位', notices !== null && typeof notices === 'object' && notices.no_freeze === true && notices.count === 1 && Array.isArray(notices.seats) && notices.seats.includes('writer'), JSON.stringify(notices).slice(0, 220))
        const audit = await h.store.auditLog('T-F26-OK')
        const waitingAudits = audit.filter((a) => a.action === 'liveness:awaiting-approval')
        rec.add(G, '★ 审计里有 `liveness:awaiting-approval`（且 **不写 history** —— 等待不是进展）', waitingAudits.length === 1 && (okTask.history ?? []).every((e) => e.action !== 'liveness:awaiting-approval'), `审计 ${waitingAudits.length} 条；history 末条=${(okTask.history ?? []).slice(-1)[0]?.action ?? '(空)'}`)

        // --- 幂等：同一次等待再观察一次，不重复写审计
        const again = await h.store.checkLiveness('T-F26-OK', { escalate: true, probe: fakeProbe })
        const audit2 = await h.store.auditLog('T-F26-OK')
        rec.add(G, '★ 同一次等待重复观察 ⇒ 不重复留痕（签名去重）', again.awaiting_count === 1 && audit2.filter((a) => a.action === 'liveness:awaiting-approval').length === 1, `审计 ${audit2.filter((a) => a.action === 'liveness:awaiting-approval').length} 条`)

        // --- 只报告档（escalate:false）一个字节都不写
        await fresh('T-F26-READONLY')
        const roRes = await h.store.checkLiveness('T-F26-READONLY', { escalate: false, probe: fakeProbe })
        const roTask = h.store.peek('T-F26-READONLY')
        rec.add(G, '★ `escalate:false`（只报告档）⇒ 不改状态、也不写留痕', roRes.awaiting_count === 1 && roTask.state === 'developing' && roTask.liveness?.approvals_notified === undefined, `state=${roTask.state} notified=${String(roTask.liveness?.approvals_notified)}`)

      // --- ⑦ runfail 落盘日志的多帧读取（2026-10-18 修：旧实现只解第一帧 ⇒ 永远查不到失败）
      {
        const G = '⑦ runfail 多帧日志'
        const mkFrame = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'))
        const line1 = `${JSON.stringify({ type: 'session', version: 4, id: 'f26-multiframe' })}\n`
        const line2 = `${JSON.stringify({ type: 'turn/error', data: { message: '🔴 本轮运行失败 tool input is invalid JSON [MALFORMED_RESPONSE]' } })}\n`
        const dir = await mkdtemp(join(tmpdir(), 'dsh-f26-runfail-'))
        cleanup.push(dir)
        const logPath = join(dir, 'session.v4.jsonl.zstd')
        await writeFile(logPath, Buffer.concat([mkFrame(line1), mkFrame(line2)]))
        const { scanRunFailureInLog } = await import('../lib/runfail.js')
        const hit = scanRunFailureInLog(logPath, {})
        rec.add(
          G,
          '★★ 失败标记在**第二帧**也读得到（多帧 zstd；旧实现 `zstdDecompressSync` 只解第一帧 ⇒ 永远查不到）',
          hit.known === true && hit.found === true && String(hit.evidence?.matched ?? '').includes('运行失败'),
          JSON.stringify(hit).slice(0, 240),
        )
        }
      } finally {
        await disposeHarness(h)
      }
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    for (const p of cleanup) {
      try {
        await rm(p, { recursive: true, force: true })
      } catch {
        /* 清不掉不影响结论 */
      }
    }
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF26LivenessApprovalCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
