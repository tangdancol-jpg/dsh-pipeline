/**
 * dsh-pipeline · **孤儿单自恢复的验证台**（2026-10-14）
 * ============================================================================
 * 用户原话（本条要验的就是这一句）：
 *   「**孤儿单：席位被切断后，机制要能【自己意识到】并重新投递 —— 不是等人来救。**」
 *
 * 这套自测**只做只读计算 + 临时目录**：不创建任何真实会话、不碰真账本、不碰真单。
 * 它分五段，逐段对应验收口径里的一个字：
 *
 *   【A 现场样本】  本机两张真孤儿单（**只读引用，未改动一个字节**）直接喂判据 ——
 *                   `T-20261011-4a2dc7`（`analyzing` / 0 交接物 / 连派活台账都没有）、
 *                   `T-20261011-a5fe41`（机制阻塞 / planner 零交接物 / 会话 id 非会话形状）。
 *   【B 正例】      造一张"孤儿形状"的单（停在非终态 + 席位会话不在 + 零证据）⇒
 *                   **被识别 + 发起再投递 + 留痕**（真 store / 真账本 / 真 `notify_only` 通道）。
 *   【C 投不出去】  老实报出来（审计行 + 账本 unresolved + **既有巡检**那条 `unresolved-wake`），
 *                   并限次退避 —— 不是静默，也不是刷屏。
 *   【D 反例】      正常闲置 / 刚被正常唤醒过 / 会话还在长 / 有活证据 / 人工阻塞 / 终态 /
 *                   窗口内 —— **一条都不许判成孤儿**（反例跑不过就不算实现）。
 *   【E 判词分开】  运行失败中止（`MALFORMED_RESPONSE`）判 `seat-turn-aborted`，
 *                   **不是**孤儿、**不重投** —— 与既有判词分得开。
 *   【F 只读导出】  `pipeline_boundaries` 的 `orphan_rescue` 面 + R12 规则 +
 *                   "不建席位"的**机械判据**（静态扫描：`lib/orphan.js` 里一个建会话调用都没有）。
 *
 * 用法：`node tests/orphan-rescue-check.mjs`（独立跑）或经 `tests/run-all.mjs` 汇总。
 *
 * @module dsh-pipeline/tests/orphan-rescue-check
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boundaryManifest } from '../lib/boundaries.js'
import {
  DEFAULT_ORPHAN_GRACE_MS,
  MECHANISM_BOOKKEEPING_ACTIONS,
  createOrphanAudit,
  createOrphanRescue,
  judgeView,
  lastEvidenceAtMs,
  orphanCatalog,
  orphanCandidate,
  orphanRedeliverMessage,
  orphanVerdict,
  sampleSeatActivity,
  zeroEvidenceOf,
} from '../lib/orphan.js'
import { patrolFindings } from '../lib/patrol.js'
import { createSeatNotifier } from '../lib/tools.js'
import { createWakeLedger } from '../lib/wakeledger.js'
import { createHarness, disposeHarness } from './selftest-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIN = 60 * 1000

/** 本机两张真孤儿单的落点（**只读参考**；本测试只读它们，一个字节都不写）。 */
const REAL_PIPELINE_DIR = '<DSH_HOME>\\profiles\\desktop\\.pipeline'
const REAL_TICKETS = ['T-20261011-4a2dc7', 'T-20261011-a5fe41']

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

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
      const L = []
      L.push('dsh-pipeline · 孤儿单自恢复验证（2026-10-14）')
      L.push('='.repeat(78))
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('')
          L.push(`【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(indent(it.detail, 6))
      }
      L.push('')
      L.push('='.repeat(78))
      L.push(`总计：${this.passed}/${this.total} 通过`)
      L.push('='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 造一个"孤儿形状"的任务台账（纯数据；不落盘）。 */
function mkTask(over = {}) {
  const now = over.now ?? Date.now()
  const stale = new Date(now - 40 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    id: 'T-FIXTURE-orphan',
    state: 'analyzing',
    created_at: stale,
    updated_at: stale,
    dispatched: [{ key: 'orchestrator', role: 'orchestrator', seat: null, agent_id: 'session-dead-0001', session_id: null, token: 'PT-x', at: stale, at_ms: Date.parse(stale) }],
    handoffs: [],
    artifacts: [],
    records: [],
    context_reports: [],
    writer_submissions: {},
    successions: [],
    clarification_requests: [],
    human_requests: [],
    history: [{ at: stale, actor: 'main', action: 'transition:dispatch_orchestrator', from: 'pending', to: 'analyzing' }],
    liveness: { escalations: [] },
    ...over,
  }
}

/**
 * 会话活动采样替身（**判据只吃数字** —— 与 `lib/liveness.js` 的纪律一致）。
 * `present:false` = 会话日志在候选根下找不到（"被切掉"的最硬形态）。
 */
function act(present, samples = {}) {
  const seats = {}
  for (const [key, s] of Object.entries(samples)) seats[key] = { key, present, sample: s, session_id: 'session-x', log_path: present ? '<fixture>/session.v4.jsonl.zstd' : null, reason: present ? '' : '夹具：找不到' }
  return seats
}

/** 记录型投递通道替身：既记 `notifyRole`（连正文一起记），也记 `spawnRole`（用来证明"没建席位"）。 */
function createSpyTransport(opts = {}) {
  const notifies = []
  const spawns = []
  return {
    notifies,
    spawns,
    messages: () => notifies.map((n) => n.message),
    async notifyRole(spec) {
      notifies.push({ role: String(spec.role ?? ''), seat: spec.seat ?? null, sessionId: String(spec.sessionId ?? ''), message: String(spec.message ?? '') })
      if (typeof opts.notifyResult === 'function') return opts.notifyResult(spec, notifies.length)
      return { ok: true, messageId: `spy-${notifies.length}`, note: '（替身通道）已记录一次投递。' }
    },
    async spawnRole(spec) {
      spawns.push({ role: String(spec?.role ?? '') })
      return { ok: false, agentId: null, token: null, note: '（替身通道）本机制**不许**建会话。' }
    },
  }
}

/** 读真单（只读；解析不了或不存在就返回 null）。 */
function readRealTicket(id) {
  const p = join(REAL_PIPELINE_DIR, id, 'task.json')
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * ★ 把一张**刚建出来**的夹具单整体"变旧"（`minutes` 分钟前）—— 造"长时间无进展"的真实形状。
 *
 * 为什么必须这样造、而不是给 `recordDispatch` 传一个假时间：判据取的是
 * 「最后一次进展」的**最大值**，而 `store.open` / `transition` 刚写下的 history 行
 * 本身就是"现在" ⇒ 只把派活时间改旧，最后进展仍然是"现在"（D8 那条 within-grace 会命中）。
 * 所以夹具直接改盘上那份 `task.json`（临时目录里我们自己的单），再让 store 按
 * "盘比内存新 ⇒ 重载"的既有对账把它读回来（`store.js:845` 的 `loadTask`）。
 */
async function ageTask(h, taskId, minutes = 40) {
  const file = join(h.store.taskDir(taskId), 'task.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  const shift = (iso) =>
    typeof iso === 'string' && iso.length > 0 && Number.isFinite(Date.parse(iso))
      ? new Date(Date.parse(iso) - minutes * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : iso
  t.created_at = shift(t.created_at)
  t.updated_at = shift(t.updated_at)
  for (const x of Array.isArray(t.history) ? t.history : []) x.at = shift(x.at)
  for (const d of Array.isArray(t.dispatched) ? t.dispatched : []) {
    if (typeof d.at === 'string') {
      d.at = shift(d.at)
      d.at_ms = Date.parse(d.at)
    }
  }
  writeFileSync(file, JSON.stringify(t, null, 2), 'utf8')
  return h.store.get(taskId)
}

/** 一个"什么都投不出去、但一切都记下来"的最小运行期（供 B/C/G 用）。 */
async function makeRig(over = {}) {
  const h = await createHarness()
  const opened = await h.store.open({ requirement: '自测：孤儿单自恢复', actorRole: 'main', actorAgentId: 'agent-main' })
  const taskId = opened.task.id
  await h.store.transition({ taskId, event: 'dispatch_orchestrator', actorRole: 'main', actorAgentId: 'agent-main' })
  const ledgerFile = join(h.projectRoot, '_ledger', 'wake-ledger.jsonl')
  const ledger = createWakeLedger({ file: ledgerFile })
  const transport = createSpyTransport(over.transport)
  const notifier = createSeatNotifier({ store: h.store, transport, wakeup: {} })
  const wakes = []
  const audits = []
  const rescue = createOrphanRescue({
    store: h.store,
    ledger,
    notify: (spec) => notifier.notifyOnly(spec.task, spec.role, spec.seat, spec.text, false),
    wake: async (spec) => {
      wakes.push(spec)
      if (over.wakeThrows === true) throw new Error('（夹具）播报通道坏了')
    },
    audit: async (id, action, detail) => {
      audits.push({ task_id: id, action, detail })
      await createOrphanAudit((x) => h.store.auditFile(x))(id, action, detail)
    },
    detectRunFailure: over.detectRunFailure ?? (async () => ({ known: true, found: false, evidence: null, source: 'fixture', note: '夹具：没有失败证据' })),
    sampleActivity: over.sampleActivity ?? ((task) => sampleSeatActivity(task, Date.now(), { roots: [join(h.projectRoot, '_sessions')] })),
    graceMs: over.graceMs ?? DEFAULT_ORPHAN_GRACE_MS,
    backoffMs: over.backoffMs ?? 30 * MIN,
    maxAttempts: over.maxAttempts ?? 3,
    warn: () => {},
  })
  return { h, taskId, ledger, transport, notifier, rescue, wakes, audits, ledgerFile }
}

/** 主入口。 */
export async function runOrphanRescueCheck() {
  const rec = createRecorder()
  const own = []

  // =========================================================================
  // A. 现场样本（只读引用）—— 本机两张真孤儿单直接喂判据
  // =========================================================================
  {
    const now = Date.now()
    const missing = []
    const seen = {}
    for (const id of REAL_TICKETS) {
      const t = readRealTicket(id)
      if (t === null) {
        missing.push(id)
        continue
      }
      const res = orphanVerdict({
        task: t,
        now,
        graceMs: DEFAULT_ORPHAN_GRACE_MS,
        activity: act(false),
        prevSamples: null,
        lastDeliveryAtMs: null,
        runFailure: null,
      })
      seen[id] = { t, res }
      const f = res.findings[0] ?? null
      rec.add(
        'A 现场样本',
        `★★ 真单 ${id}（state=${t.state}，handoffs=${(t.handoffs ?? []).length}，dispatched=${t.dispatched === null || t.dispatched === undefined ? 'null' : t.dispatched.length}）被识别为**孤儿**`,
        f !== null && f.orphan === true && String(f.kind).startsWith('orphan-'),
        f === null ? `未识别：${res.note}` : `判词 ${f.kind}\n${f.detail}`,
      )
    }
    rec.add(
      'A 现场样本',
      '★ 现场样本只读可得（缺失就**判红**，不用"跳过"冒充通过）',
      missing.length === 0,
      missing.length === 0
        ? `${REAL_PIPELINE_DIR} 下两张单都读到了（本测试对它们**只读**：不写、不改、不删）`
        : `读不到：${missing.join('、')} —— 本套用例**无法验证**（宁可红，不假装绿）`,
    )
    const a = seen[REAL_TICKETS[0]]
    const b = seen[REAL_TICKETS[1]]
    rec.add(
      'A 现场样本',
      '★ 4a2dc7 的判据是"**派活台账里根本没有这一条**"（连它在哪个会话都不知道）',
      a !== undefined && String(a.res.findings[0]?.detail ?? '').includes('派活台账里根本没有这一条'),
      a === undefined ? '(缺样本)' : String(a.res.findings[0]?.detail ?? '').slice(0, 400),
    )
    rec.add(
      'A 现场样本',
      '★ a5fe41 的判据是"**机制阻塞 + planner 无活证据 + 会话文件不在**"（不是"人工阻塞"）',
      b !== undefined &&
        String(b.res.findings[0]?.kind) === 'orphan-seat-gone' &&
        String(b.res.findings[0]?.detail ?? '').includes('计划') &&
        b.res.findings[0]?.evidence?.seats?.[0]?.session_present === false,
      b === undefined ? '(缺样本)' : String(b.res.findings[0]?.detail ?? '').slice(0, 400),
    )
    rec.add(
      'A 现场样本',
      '★ 两张真单**都不是**被判成"运行失败中止"（判词确实分开了）',
      [a, b].every((x) => x !== undefined && x.res.findings[0]?.kind !== 'seat-turn-aborted'),
      [a, b].map((x) => String(x?.res?.findings?.[0]?.kind ?? '(缺)')).join(' / '),
    )
  }

  // =========================================================================
  // B. 正例：孤儿被识别 + 发起再投递 + 留痕（真 store / 真账本 / 真 notify_only）
  // =========================================================================
  {
    const rig = await makeRig()
    own.push(rig)
    const { h, taskId, rescue, transport, ledger } = rig
    // 派活台账：有会话 id，但那个会话在候选会话根下**不存在**（席位被切掉的最硬形态）。
    await h.store.recordDispatch(taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0001', token: 'PT-dead' })
    await ageTask(h, taskId, 40)
    const taskFile = join(h.store.taskDir(taskId), 'task.json')
    const before = readFileSync(taskFile, 'utf8')

    const r1 = await rescue.runOnce()
    const f = r1.actions[0] ?? null
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★★ 孤儿形状（非终态 + 席位会话不在 + 零证据）被**识别**并**发起再投递**',
      r1.orphans === 1 && f !== null && f.kind === 'orphan-seat-gone' && f.action === 'redelivered',
      `orphans=${r1.orphans}　kind=${String(f?.kind)}　action=${String(f?.action)}　note=${String(f?.note)}\n扫描结论：${r1.note}`,
    )
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★★ **投递真的走了既有的 `transport.notifyRole`**（= `notify_only` 那条路），且**一次都没建会话**',
      transport.notifies.length === 1 && transport.notifies[0].role === 'orchestrator' && transport.spawns.length === 0,
      `notifyRole ${transport.notifies.length} 次（role=${transport.notifies[0]?.role ?? '-'}）　spawnRole ${transport.spawns.length} 次`,
    )
    const msg = transport.messages()[0] ?? ''
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★★ 投出去的正文**带上下文**（你是谁 / 任务在哪 / 你上次停在哪 / 请继续）+ 任务 id',
      msg.includes('你是谁') &&
        msg.includes('任务在哪') &&
        msg.includes('你上次停在哪') &&
        msg.includes('请继续') &&
        msg.includes(taskId) &&
        msg.includes('孤儿单自恢复'),
      msg.slice(0, 700),
    )
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★ 审计**两条都落了**（识别 `orphan:detected` + 投递成功 `orphan:redelivered`），且都在 `.pipeline/<任务>/audit.jsonl` 里',
      rig.audits.some((a) => a.action === 'orphan:detected') && rig.audits.some((a) => a.action === 'orphan:redelivered'),
      rig.audits.map((a) => a.action).join(' / ') || '(无)',
    )
    const auditText = existsSync(h.store.auditFile(taskId)) ? readFileSync(h.store.auditFile(taskId), 'utf8') : ''
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★ 审计**真的落盘**（盘上有 `orphan:detected` 与 `orphan:redelivered` 两行，含 orphan_id 与正文）',
      auditText.includes('"action":"orphan:detected"') && auditText.includes('"action":"orphan:redelivered"') && auditText.includes('孤儿单自恢复'),
      auditText
        .split('\n')
        .filter((l) => l.includes('orphan:'))
        .map((l) => l.slice(0, 220))
        .join('\n'),
    )
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★ 播报一次（`orphan-redelivered`）—— 主对话看得见"机制自己把孤儿单重新投出去了"',
      rig.wakes.length === 1 && rig.wakes[0].kind === 'orphan-redelivered' && String(rig.wakes[0].disc).includes('orphan-seat-gone'),
      `wake kind=${rig.wakes.map((w) => w.kind).join(',')}　disc=${String(rig.wakes[0]?.disc)}`,
    )
    const r2 = await rescue.runOnce()
    const r3 = await rescue.runOnce()
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★★ **幂等**：账本里记下这条身份；**同一身份再扫两轮 ⇒ 仍然识别得到，但一次都不再投、不再播**（不刷屏）',
      ledger.hasDelivered(String(f?.id)) === true &&
        r2.orphans === 1 &&
        r3.orphans === 1 &&
        r2.actions[0]?.action === 'skip' &&
        r3.actions[0]?.action === 'skip' &&
        r2.new_orphans === 0 &&
        r3.new_orphans === 0 &&
        transport.notifies.length === 1 &&
        rig.wakes.length === 1,
      `账本 hasDelivered=${String(ledger.hasDelivered(String(f?.id)))}　第二轮 orphans=${r2.orphans}/动作=${String(r2.actions[0]?.action)}　第三轮 orphans=${r3.orphans}/动作=${String(r3.actions[0]?.action)}\n` +
        `notify 次数=${transport.notifies.length}（应恒为 1）　播报=${rig.wakes.length}（应恒为 1）　理由：${String(r2.actions[0]?.note)}`,
    )
    const after = readFileSync(taskFile, 'utf8')
    const changed = before !== after
    /**
     * ⚠️ 诚实的边界：自恢复**自己**不写 `task.json`；但"投递"这一步走的是既有
     * `notify_only` 通道，那条通道按 A6/A7/A28(b) 的纪律会写一行
     * `seat:wake-delivered` 审计进 `task.history`（与人工调用它**逐字相同**）。
     * 所以这里断言的不是"文件没变"，而是"**变的那一行是既有通道的既有留痕**"。
     */
    const added = changed ? JSON.parse(after).history.filter((x) => !JSON.parse(before).history.some((y) => JSON.stringify(y) === JSON.stringify(x))) : []
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★★ **不改状态、不自造成长**：自恢复自己不加任何流水；`task.json` 的增量**只有**既有 `notify_only` 通道那一行 `seat:wake-delivered`',
      added.every((x) => String(x?.action ?? '') === 'seat:wake-delivered') && JSON.parse(after).state === JSON.parse(before).state,
      changed ? `新增流水 ${added.length} 行：${added.map((x) => `${x.actor}:${x.action}`).join(' / ')}　状态 ${JSON.parse(before).state} → ${JSON.parse(after).state}` : 'task.json 逐字节未变',
    )
    rec.add(
      'B 正例：识别 + 再投递 + 留痕',
      '★ 自恢复**没有**碰任务状态机：`state` 停在原处（不是"重投=恢复"这种假自愈）',
      JSON.parse(after).state === JSON.parse(before).state,
      `state=${JSON.parse(after).state}（机制阻塞/等人解除，本机制不改状态）`,
    )
  }

  // =========================================================================
  // C. 投不出去 ⇒ **看得见的失败**（审计 + 账本 unresolved + 既有巡检那条播报）
  // =========================================================================
  {
    const rig = await makeRig({
      transport: { notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）会话 ' + 'session-gone-0002' + ' 已经不在宿主里，投递被拒。' }) },
    })
    own.push(rig)
    const { h, taskId, rescue, ledger, audits } = rig
    await h.store.recordDispatch(taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0002', token: 'PT-dead' })
    await ageTask(h, taskId, 40)
    const r1 = await rescue.runOnce()
    const f = r1.actions[0] ?? null
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★★ 投不出去 ⇒ 结果是 `failed` + **失败原文**（不是"当成功"、也不是静默）',
      f !== null && f.action === 'failed' && String(f.note).includes('投递被拒'),
      `action=${String(f?.action)}　note=${String(f?.note)}`,
    )
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★ 审计留一行 `orphan:redeliver-failed`（含失败的**原文**与目标会话）',
      audits.some((a) => a.action === 'orphan:redeliver-failed' && String(a.detail?.reason ?? '').includes('投递被拒')),
      audits.filter((a) => a.action === 'orphan:redeliver-failed').map((a) => String(a.detail?.reason ?? '')).join(' | ') || '(无)',
    )
    const un = ledger.unresolvedEntries({ taskId, limit: 20 })
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★★ 失败落进**既有账本**的 `unresolved`（不是新开一份记录）',
      un.length === 1 && String(un[0]?.kind) === 'orphan-rescue' && String(un[0]?.reason ?? '').includes('投递被拒'),
      JSON.stringify(un[0] ?? null).slice(0, 400),
    )
    const task = await h.store.get(taskId)
    const pf = patrolFindings({ task, now: Date.now(), unresolved: ledger.unresolvedEntries({ taskId, limit: 5 }) })
    const uw = pf.findings.find((x) => x.kind === 'unresolved-wake') ?? null
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★★ **既有巡检**会把这条"投不出去"播报出去（`unresolved-wake`）—— 复用，不新开播报面',
      uw !== null && String(uw.detail).includes('没有投出去'),
      uw === null ? '(巡检没认出来)' : String(uw.detail),
    )
    const r2 = await rescue.runOnce()
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★ **退避**：距上次失败不足一个退避窗口 ⇒ 本轮**不重试**（不刷屏）',
      (r2.actions[0]?.action ?? '') === 'wait' || r2.orphans === 0,
      `第二轮 action=${String(r2.actions[0]?.action)}　${String(r2.actions[0]?.note ?? '')}`,
    )
    // 退避到期（把账本里那条失败的时间改成很久以前）⇒ 允许再试一次；失败次数到上限 ⇒ 放弃并记 escalated
    const rig2 = await makeRig({
      backoffMs: 0,
      maxAttempts: 2,
      transport: { notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）仍然投不出去。' }) },
    })
    own.push(rig2)
    await rig2.h.store.recordDispatch(rig2.taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0003', token: 'PT-dead' })
    await ageTask(rig2.h, rig2.taskId, 40)
    await rig2.rescue.runOnce()
    await rig2.rescue.runOnce()
    const r3 = await rig2.rescue.runOnce()
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★★ **限次**：投失败到上限 ⇒ 记为**已放弃**（`orphan:redeliver-abandoned` + 账本 escalated），不再无限骚扰',
      rig2.audits.some((a) => a.action === 'orphan:redeliver-abandoned') && r3.actions[0]?.action === 'abandon',
      `第三次 action=${String(r3.actions[0]?.action)}　${String(r3.actions[0]?.note ?? '')}　审计=${rig2.audits.map((a) => a.action).join('/')}`,
    )
    const r4 = await rig2.rescue.runOnce()
    rec.add(
      'C 投不出去 = 看得见的失败',
      '★ 放弃之后**彻底停下**（同一身份不再尝试、不再播报、不再记 unresolved）',
      r4.actions[0]?.action === 'skip' && r4.new_orphans === 0 && rig2.transport.notifies.length === 2 && rig2.ledger.unresolvedEntries({ taskId: rig2.taskId, limit: 20 }).length === 2,
      `第四轮 动作=${String(r4.actions[0]?.action)}　本轮发起=${r4.new_orphans}　notify 次数=${rig2.transport.notifies.length}（恒为 2）　unresolved=${rig2.ledger.unresolvedEntries({ taskId: rig2.taskId, limit: 20 }).length}（恒为 2）\n理由：${String(r4.actions[0]?.note)}`,
    )
  }

  // =========================================================================
  // D. 反例：这些形状**一条都不许**判成孤儿
  // =========================================================================
  {
    const now = Date.now()
    const ev = (over) =>
      orphanVerdict({ task: mkTask(over.task ?? {}), now, graceMs: DEFAULT_ORPHAN_GRACE_MS, activity: act(false), prevSamples: null, lastDeliveryAtMs: null, runFailure: null, ...over.spec })

    // --- D1 正常闲置（等人）---
    {
      const r = ev({ task: { state: 'awaiting_human' } })
      rec.add('D 反例：不许误判', '★ 正常闲置（`awaiting_human`：等用户拍板）⇒ **不判孤儿**，理由是 `waiting-for-human`', r.findings.length === 0 && r.skip?.reason === 'waiting-for-human', `skip=${JSON.stringify(r.skip)}`)
    }
    // --- D2 等澄清 ---
    {
      const r = ev({ task: { state: 'awaiting_clarification' } })
      rec.add('D 反例：不许误判', '★ 正常闲置（`awaiting_clarification`：等澄清答复）⇒ 不判孤儿', r.findings.length === 0 && r.skip?.reason === 'waiting-for-human', `skip=${JSON.stringify(r.skip)}`)
    }
    // --- D3 终态 ---
    {
      const r = ev({ task: { state: 'closed' } })
      rec.add('D 反例：不许误判', '★ 已关单（终态）⇒ 不判孤儿（没有"没人管"这回事）', r.findings.length === 0 && r.skip?.reason === 'terminal-state', `skip=${JSON.stringify(r.skip)}`)
    }
    // --- D4 刚被正常唤醒过 ---
    {
      const r = ev({ spec: { lastDeliveryAtMs: now - 2 * MIN } })
      rec.add(
        'D 反例：不许误判',
        '★★ 刚被**正常唤醒过**（2 分钟前投过一条席位消息，账本里有记录）⇒ **不判孤儿**（`delivered-recently`）',
        r.findings.length === 0 && r.skip?.reason === 'delivered-recently',
        `skip=${JSON.stringify(r.skip)}`,
      )
    }
    // --- D5 会话还在长（实测阳性）---
    {
      const key = 'orchestrator'
      const prev = { [key]: { atMs: now - 30 * 1000, size: 1000, mtimeMs: now - 30 * 1000 } }
      const cur = act(true, { [key]: { atMs: now, size: 1000 + 10717, mtimeMs: now } })
      const r = ev({ spec: { activity: cur, prevSamples: prev } })
      rec.add(
        'D 反例：不许误判',
        '★★ 席位会话日志**还在长**（30 秒 +10,717 字节 —— 用当晚实测数字）⇒ **不判孤儿**（`session-alive`）',
        r.findings.length === 0 && r.skip?.reason === 'session-alive',
        `skip=${JSON.stringify(r.skip)}`,
      )
    }
    // --- D6 有活的证据（交接物）---
    {
      const at = new Date(now - 39 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const r = ev({ task: { handoffs: [{ handoff_id: 'H-1', kind: 'requirement_analysis', from_role: 'orchestrator', created_at: at }] } })
      rec.add(
        'D 反例：不许误判',
        '★ 该席位**有活着的证据**（交过 `requirement_analysis`）⇒ 不判孤儿（`has-living-evidence`）',
        r.findings.length === 0 && r.skip?.reason === 'has-living-evidence',
        `skip=${JSON.stringify(r.skip)}`,
      )
    }
    // --- D7 人工阻塞 ---
    {
      const r = ev({ task: { state: 'blocked', liveness: { escalations: [] } } })
      rec.add(
        'D 反例：不许误判',
        '★★ **人工叫停**的阻塞（没有失联处置记录）⇒ **不判孤儿**（`blocked-by-human`：那是在等人，不是没人管）',
        r.findings.length === 0 && r.skip?.reason === 'blocked-by-human',
        `skip=${JSON.stringify(r.skip)}`,
      )
    }
    // --- D8 判定窗内 ---
    {
      const fresh = new Date(now - 1 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const r = ev({
        task: {
          history: [{ at: fresh, actor: 'main', action: 'transition:dispatch_orchestrator' }],
          dispatched: [{ key: 'orchestrator', role: 'orchestrator', seat: null, agent_id: 'session-just-born', at: fresh, at_ms: Date.parse(fresh) }],
        },
      })
      rec.add('D 反例：不许误判', '★ 刚派完活 1 分钟（还在判定窗内）⇒ 不判孤儿（`within-grace`）', r.findings.length === 0 && r.skip?.reason === 'within-grace', `skip=${JSON.stringify(r.skip)}`)
    }
    // --- D9 机制自己的记账行**不算活证据、也不算进展** ---
    {
      const at = new Date(now - 39 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const withBookkeeping = mkTask({
        history: [
          { at, actor: 'main', action: 'transition:dispatch_orchestrator' },
          { at: new Date(now - 30 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z'), actor: 'orchestrator', action: 'seat:wake-delivered' },
          { at: new Date(now - 29 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z'), actor: 'orchestrator', action: 'seat:wake-failed' },
        ],
      })
      const r = ev({ task: withBookkeeping })
      const view = judgeView(withBookkeeping)
      rec.add(
        'D 反例：不许误判',
        '★★ 机制自己写的 `seat:wake-*` 记账行**不许**被读成"席位还活着"（否则投过一次就永远不再认孤儿）',
        r.findings.length === 1 && r.findings[0].kind === 'orphan-seat-gone' && view.history.length === 1,
        `判词=${String(r.findings[0]?.kind)}　判据视图 history=${view.history.length} 行（原 ${withBookkeeping.history.length} 行）`,
      )
    }
    // --- D10 判据视图不改入参（纯函数纪律）---
    {
      const t = mkTask()
      const before = JSON.stringify(t)
      judgeView(t)
      lastEvidenceAtMs(t)
      zeroEvidenceOf(t)
      orphanCandidate({ task: t, now, activity: act(false) })
      rec.add('D 反例：不许误判', '★ 判据全是纯函数：跑一圈**不改入参**（`task` 逐字节相同）', JSON.stringify(t) === before, `before===after：${JSON.stringify(t) === before}`)
    }
  }

  // =========================================================================
  // E. 与既有判词分得开：运行失败中止 ≠ 孤儿
  // =========================================================================
  {
    const now = Date.now()
    const runFailure = { known: true, found: true, source: 'session-log', note: '本轮运行失败 DeepSeek Messages stream: tool input is invalid JSON [MALFORMED_RESPONSE]', evidence: { marker: 'MALFORMED_RESPONSE' } }
    const r = orphanVerdict({ task: mkTask(), now, graceMs: DEFAULT_ORPHAN_GRACE_MS, activity: act(false), prevSamples: null, lastDeliveryAtMs: null, runFailure })
    const f = r.findings[0] ?? null
    rec.add(
      'E 判词分得开',
      '★★ 同一张孤儿形状的单 + 命中运行失败证据 ⇒ 判词是 **`seat-turn-aborted`**（`orphan:false`），**不是**孤儿',
      f !== null && f.kind === 'seat-turn-aborted' && f.orphan === false && f.redeliver === false,
      f === null ? '(没判出来)' : `${f.kind}　orphan=${String(f.orphan)}\n${f.detail}`,
    )
    rec.add(
      'E 判词分得开',
      '★★ 中止**不重投**（A11 有自己的播报面）—— 同一条身份只该有一条判词',
      f !== null && f.message === '' && f.redeliver === false,
      `message 长度=${String(f?.message ?? '').length}　redeliver=${String(f?.redeliver)}`,
    )
    const kinds = orphanCatalog().verdict_kinds
    rec.add(
      'E 判词分得开',
      '★ 三种判词是**三个不同的 kind**（会话被切 / 没人管 / 回合中止），互不冒充',
      kinds.length === 3 && kinds.includes('orphan-seat-gone') && kinds.includes('orphan-task-unattended') && kinds.includes('seat-turn-aborted'),
      `verdict_kinds=${JSON.stringify(kinds)}`,
    )
    const pf = patrolFindings({ task: mkTask(), now, stallMs: 20 * MIN })
    rec.add(
      'E 判词分得开',
      '★ 与**既有巡检**的判词不同源：巡检那条仍然叫 `task-stall`（本机制没有替换、也没有放宽它）',
      pf.findings.some((x) => x.kind === 'task-stall'),
      pf.findings.map((x) => x.kind).join(' / ') || '(巡检没判出来 —— 那就说明基线变了)',
    )
    // "没人管"那一支（判不出原因也要能认出来）：有派活记录、但**采样拿不到**（不许把"查不到"当"死了"）
    // ⇒ 走整单零证据那一支，判词是 `orphan-task-unattended`。
    const r2 = orphanVerdict({ task: mkTask(), now, graceMs: DEFAULT_ORPHAN_GRACE_MS, activity: null, prevSamples: null, lastDeliveryAtMs: null, runFailure: null })
    rec.add(
      'E 判词分得开',
      '★★ "没人管"那一支**单独可达**：采样拿不到活动证据 + 整单零证据 ⇒ 判 `orphan-task-unattended`（即使原因判不出）',
      r2.findings.length === 1 && r2.findings[0].kind === 'orphan-task-unattended' && r2.findings[0].orphan === true,
      `${String(r2.findings[0]?.kind)}　${String(r2.findings[0]?.detail ?? '').slice(0, 260)}`,
    )
  }

  // =========================================================================
  // F. 只读导出 + "不建席位"的机械判据
  // =========================================================================
  {
    const man = boundaryManifest()
    const orph = man.orphan_rescue
    rec.add(
      'F 只读导出',
      '★★ `pipeline_boundaries` 里有 `orphan_rescue` 面（判据、判词、可判状态、不判原因、通道、审计动作）',
      orph !== undefined && Array.isArray(orph.criteria) && orph.criteria.length >= 4 && Array.isArray(orph.skip_reasons) && orph.skip_reasons.length >= 8,
      `criteria=${orph?.criteria?.length}　skip_reasons=${orph?.skip_reasons?.length}　orphan_kinds=${JSON.stringify(orph?.orphan_kinds)}`,
    )
    rec.add(
      'F 只读导出',
      '★★ 三条硬边界写在导出里（断言级）：**不建新席位 / 不改任务状态 / 不写 task.json**',
      orph?.creates_new_seats === false && orph?.changes_task_state === false && orph?.writes_task_json === false,
      `creates_new_seats=${String(orph?.creates_new_seats)}　changes_task_state=${String(orph?.changes_task_state)}　writes_task_json=${String(orph?.writes_task_json)}`,
    )
    const rules = man.rules.filter((r) => r.id === 'R12')
    rec.add('F 只读导出', '★ R12 进了规则表且是 `class=a`（已判据化，不是纯文档）', rules.length === 1 && rules[0].class === 'a' && String(rules[0].enforce).length > 20, rules.map((r) => `${r.id}:${r.class}　${r.enforce}`).join(' '))
    /**
     * ★★ **机械判据**（与 `liveness-check` 的静态扫描同风格）：
     *   `lib/orphan.js` 里**不许出现任何建会话的写法** —— 用户裁定「不要求自动补新席位」，
     *   "结构上做不到"必须能被一条 grep 式断言证明，而不是靠注释保证。
     */
    const src = readFileSync(join(HERE, '..', 'lib', 'orphan.js'), 'utf8')
    const offenders = []
    src.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
      for (const bad of ['spawnRole', 'startContinuable', 'recordDispatch(', 'createTaskStore']) {
        if (line.includes(bad)) offenders.push(`${i + 1}: ${t.slice(0, 90)}`)
      }
    })
    rec.add(
      'F 只读导出',
      '★★ **静态扫描**：`lib/orphan.js` 里**不存在**任何"建会话 / 派活 / 建台账"的调用（`spawnRole` / `startContinuable` / `recordDispatch` / `createTaskStore` 一个都没有）',
      offenders.length === 0,
      offenders.length === 0 ? '扫描 lib/orphan.js 全部非注释行：0 处 ✓（"不产生新席位"是结构性的）' : `发现：\n${offenders.join('\n')}`,
    )
    rec.add(
      'F 只读导出',
      '★ `orphanCatalog()` 与判据同源：机制的记账动作名逐条导出（可核对判据剔了哪些行）',
      orphanCatalog().mechanism_bookkeeping_actions.length === MECHANISM_BOOKKEEPING_ACTIONS.length && MECHANISM_BOOKKEEPING_ACTIONS.includes('seat:wake-delivered'),
      JSON.stringify(orphanCatalog().mechanism_bookkeeping_actions),
    )
  }

  // =========================================================================
  // G. 不许整体停摆：播报坏了、采样坏了，识别与投递照旧 + 留痕照旧
  // =========================================================================
  {
    const rig = await makeRig({ wakeThrows: true })
    own.push(rig)
    await rig.h.store.recordDispatch(rig.taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0004', token: 'PT-dead' })
    await ageTask(rig.h, rig.taskId, 40)
    const r = await rig.rescue.runOnce()
    rec.add(
      'G 不许整体停摆',
      '★ **播报通道坏了**也照样识别 + 投递 + 留痕（播报失败不许把判决或投递带崩）',
      r.orphans === 1 && (r.actions[0]?.action ?? '') === 'redelivered' && rig.transport.notifies.length === 1 && rig.rescue.stats.last_error === null,
      `orphans=${r.orphans}　action=${String(r.actions[0]?.action)}　notify=${rig.transport.notifies.length}　last_error=${String(rig.rescue.stats.last_error)}`,
    )
    const rig2 = await makeRig({ sampleActivity: () => { throw new Error('（夹具）采样炸了') } })
    own.push(rig2)
    await rig2.h.store.recordDispatch(rig2.taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0005', token: 'PT-dead' })
    await ageTask(rig2.h, rig2.taskId, 40)
    const r2 = await rig2.rescue.runOnce()
    rec.add(
      'G 不许整体停摆',
      '★★ **采样失败 ≠ 判它死了**：拿不到活动证据时退回台账面 ⇒ 仍能识别（判"没人管"那一支），且**不抛**',
      r2.ok === true && rig2.rescue.stats.last_error === null && r2.orphans === 1 && (r2.actions[0]?.kind ?? '') === 'orphan-task-unattended',
      `ok=${String(r2.ok)}　orphans=${r2.orphans}　kind=${String(r2.actions[0]?.kind)}　action=${String(r2.actions[0]?.action)}　last_error=${String(rig2.rescue.stats.last_error)}`,
    )
  }

  // =========================================================================
  // H. 话术（"重新投递"里的"带上下文"）单独可断言
  // =========================================================================
  {
    const task = mkTask({ id: 'T-FIXTURE-msg' })
    const msg = orphanRedeliverMessage({
      task,
      finding: { reason: '夹具原因', detail: '夹具判据正文', seat: { role: 'orchestrator', seat: null, session_id: 'session-x', last_output: '交接物 requirement_analysis（2026-10-11T10:18:26Z）' } },
    })
    rec.add(
      'H 投递话术',
      '★ 正文四要素齐备：你是谁 / 任务在哪 / 你上次停在哪 / 请继续（且明确"这不是用户说的话"）',
      msg.includes('你是谁：需求分析') && msg.includes('任务在哪：T-FIXTURE-msg') && msg.includes('你上次停在哪：交接物 requirement_analysis') && msg.includes('请继续：') && msg.includes('不是用户说的话'),
      msg,
    )
    rec.add(
      'H 投递话术',
      '★ 正文**不冒充用户**：写的是"运行时上下文"，且带 `pipeline_status` 的重读指令（不凭记忆）',
      msg.includes('运行时上下文') && msg.includes('pipeline_status'),
      msg.split('\n').slice(-4).join('\n'),
    )
  }

  // --- 清理（临时目录跑完即删）---
  for (const rig of own) await disposeHarness(rig.h)

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

// 独立跑：`node tests/orphan-rescue-check.mjs`
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await runOrphanRescueCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
