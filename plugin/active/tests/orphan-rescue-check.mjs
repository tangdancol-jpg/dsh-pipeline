/**
 * dsh-pipeline · **孤儿单自恢复的验证台**（2026-10-14）
 * ============================================================================
 * 用户原话（本条要验的就是这一句）：
 *   「**孤儿单：席位被切断后，机制要能【自己意识到】并重新投递 —— 不是等人来救。**」
 *
 * 这套自测**只做只读计算 + 临时目录**：不创建任何真实会话、不碰真账本、不碰真单。
 * 它分五段，逐段对应验收口径里的一个字：
 *
 *   【A 现场形状】  两段本机真孤儿单的**形状**（`T-20261011-4a2dc7`：`analyzing` /
 *                   0 交接物 / 连派活台账都没有；`T-20261011-a5fe41`：机制阻塞 /
 *                   planner 零交接物 / 会话 id 非会话形状）——
 *                   ★ **P1-12 修复（2026-10-14）**：改前这一段**直接读那两张活体真单**的
 *                   `task.json`，于是插件自己一活动（唤醒层每轮往 `task.history` 写一行
 *                   `wake:skipped`）就把它们的"最后一次进展"顶到现在 ⇒ 随机红
 *                   （实测同一份代码两次跑出 42/46 与 44/46）。
 *                   现在改成**夹具自造临时任务目录**（照 `station-reject-check.mjs` 的做法）：
 *                   在本测试自己的临时项目里开单 → 把盘上那份 `task.json` 改成真单的形状
 *                   → **从盘上读回来**喂判据。与真单再无任何关系，结果恒定。
 *   【B 正例】      造一张"孤儿形状"的单（停在非终态 + 席位会话不在 + 零证据）⇒
 *                   **被识别 + 发起再投递 + 留痕**（真 store / 真账本 / 真 `notify_only` 通道）。
 *   【C 投不出去】  老实报出来（审计行 + 账本 unresolved + **既有巡检**那条 `unresolved-wake`），
 *                   并限次退避 —— 不是静默，也不是刷屏。
 *   【C2 attempt 用尽】★ P2-8 实测：**线上默认 3 次**用尽之后到底发生什么
 *                   （落 `orphan:redeliver-abandoned` / 停手 / 播报）。
 *   【D 反例】      正常闲置 / 刚被正常唤醒过 / 会话还在长 / 有活证据 / 人工阻塞 / 终态 /
 *                   窗口内 —— **一条都不许判成孤儿**（反例跑不过就不算实现）。
 *   【E 判词分开】  运行失败中止（`MALFORMED_RESPONSE`）判 `seat-turn-aborted`，
 *                   **不是**孤儿、**不重投** —— 与既有判词分得开。
 *   【E2 正在写交付】★ P1-6：**"席位写完报告、正要交交接物的那几十秒"**不许被判失联并冻结
 *                   （会话日志 `mtime` 就在几秒前 ⇒ 它此刻正在被写）。
 *   【F 只读导出】  `pipeline_boundaries` 的 `orphan_rescue` 面 + R12 规则 +
 *                   "不建席位"的**机械判据**（静态扫描：`lib/orphan.js` 里一个建会话调用都没有）。
 *   【G 不许停摆】  播报坏了 / 采样坏了，识别与投递照旧 + 留痕照旧。
 *   【H 投递话术】  "重新投递"里的"带上下文"单独可断言。
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
  DEFAULT_ACTIVITY_FRESH_MS,
  DEFAULT_SEAT_SILENCE_MS,
  seatLiveness,
} from '../lib/liveness.js'
import {
  DEFAULT_MAX_REDELIVER_ATTEMPTS,
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

/**
 * ★★ **P1-12 修复（2026-10-14）的夹具原语**：把本测试**自己那张临时单**的
 * `task.json` 改成某个"现场形状"，再让 store 按"盘比内存新 ⇒ 重载"读回来。
 *
 * 为什么必须走盘、而不是在内存里捏一个对象喂判据：A 段要证的正是
 * 「**盘上那份真形状的台账**能不能被认出来」—— 内存对象会把"字段到底在不在"
 * 这件事悄悄抹平（真单 `4a2dc7` 的关键特征恰恰是 `dispatched` **这个字段不存在**，
 * 不是"它是 null"）。
 */
async function patchTaskFile(h, taskId, mutate) {
  const file = join(h.store.taskDir(taskId), 'task.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  mutate(t)
  writeFileSync(file, JSON.stringify(t, null, 2), 'utf8')
  return h.store.get(taskId)
}

/** 从盘上的（临时）任务目录把 `task.json` 逐字节读回来；读不到就返回 null（由调用方判红）。 */
function readTaskFile(h, taskId) {
  const p = join(h.store.taskDir(taskId), 'task.json')
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
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
 * "盘比内存新 ⇒ 重载"的既有对账把它读回来（`store/base.js` 的 `loadTask`）。
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

/** 毫秒 → 等一等（只在"必须让两个留痕落在不同的**秒**上"时用）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 主入口。 */
export async function runOrphanRescueCheck() {
  const rec = createRecorder()
  const own = []

  // =========================================================================
  // A. 现场**形状**（夹具自造临时任务目录；★ P1-12 修复：不再引用任何真单）
  // =========================================================================
  //
  //  ★ 改前（会随机红）：直接读本机两张**活体真单**的 `task.json`，
  //    而插件自己每轮都会往它们的 `task.history` 写一行 `wake:skipped`
  //    ⇒ "最后一次进展"被顶到当下 ⇒ `within-grace` ⇒ 判不出孤儿 ⇒ 红。
  //  ★ 改后（恒定）：形状由夹具在**本测试自己的临时项目目录**里造出来，
  //    与任何真单、任何外部活动无关。
  {
    const h = await createHarness()
    own.push({ h })
    const now = Date.now()
    const stale = new Date(now - 40 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const missing = []
    const seen = {}

    // --- 形状①（= 真单 `T-20261011-4a2dc7`）：`analyzing` / **`dispatched` 字段整个不存在** / 全零 ---
    const o1 = await h.store.open({ requirement: '夹具：孤儿形状①（analyzing / 连派活台账都没有）', actorRole: 'main', actorAgentId: 'agent-main' })
    const id1 = o1.task.id
    await h.store.transition({ taskId: id1, event: 'dispatch_orchestrator', actorRole: 'main', actorAgentId: 'agent-main' })
    await patchTaskFile(h, id1, (t) => {
      t.state = 'analyzing'
      // ★ 真单的关键特征：这个字段**压根不存在**（不是 null）⇒ 判据必须走
      //   「派活台账里根本没有这一条」那一支。
      delete t.dispatched
      t.handoffs = []
      t.artifacts = []
      t.records = []
      t.context_reports = []
      t.writer_submissions = {}
      t.successions = []
      t.created_at = stale
      t.updated_at = stale
      t.history = [{ at: stale, actor: 'main', action: 'transition:dispatch_orchestrator', from: 'pending', to: 'analyzing' }]
      t.liveness = { escalations: [] }
    })

    // --- 形状②（= 真单 `T-20261011-a5fe41`）：**机制阻塞** / planner 零交接物 / 会话 id 不是会话形状 ---
    const o2 = await h.store.open({ requirement: '夹具：孤儿形状②（机制阻塞 / planner 零交接物）', actorRole: 'main', actorAgentId: 'agent-main' })
    const id2 = o2.task.id
    /** ★ 真单里 planner 的会话 id 就是一个**裸 UUID**（不是 `session-…` 形状）。 */
    const bareUuid = '00000000-0000-4000-8000-000000000201'
    await patchTaskFile(h, id2, (t) => {
      t.state = 'blocked'
      t.created_at = stale
      t.updated_at = stale
      t.dispatched = [
        { key: 'orchestrator', role: 'orchestrator', seat: null, agent_id: 'session-orch-fixture-0001', session_id: 'session-orch-fixture-0001', token: 'PT-a', at: stale, at_ms: Date.parse(stale), via: 'session' },
        { key: 'planner', role: 'planner', seat: null, agent_id: bareUuid, session_id: null, token: 'PT-b', at: stale, at_ms: Date.parse(stale), via: 'session' },
      ]
      // ★ 真单里那 6 份交接物**全是 orchestrator 的** ⇒ planner 自己零证据。
      t.handoffs = Array.from({ length: 6 }, (_, i) => ({ handoff_id: `H-fixture-000${i}`, kind: 'requirement_analysis', from_role: 'orchestrator', created_at: stale }))
      t.artifacts = []
      t.records = []
      t.context_reports = []
      t.writer_submissions = {}
      t.successions = []
      t.history = [{ at: stale, actor: 'main', action: 'transition:block', from: 'planning', to: 'blocked' }]
      // ★ 「这次阻塞是**机制自己**触发的」—— 判据看的就是最后一条处置的 `to_state` 与 `seats`。
      t.liveness = {
        escalations: [{ at: stale, at_ms: Date.parse(stale), seats: ['planner'], previous_state: 'planning', to_state: 'blocked', reason: '★ 机制触发（不是人叫停）：席位失联：计划（planner）' }],
      }
    })

    for (const [id, tag] of [[id1, '形状①'], [id2, '形状②']]) {
      const t = readTaskFile(h, id)
      if (t === null) {
        missing.push(tag)
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
      seen[tag] = { t, res }
    }

    const a = seen['形状①']
    const b = seen['形状②']
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★★ 夹具①（真单 `T-20261011-4a2dc7` 的形状：`state=analyzing`，handoffs=0，`dispatched` **字段不存在**）被识别为**孤儿**',
      a !== undefined && a.res.findings[0]?.orphan === true && String(a.res.findings[0]?.kind).startsWith('orphan-'),
      a === undefined ? '(缺夹具)' : `判词 ${a.res.findings[0]?.kind}\n${a.res.findings[0]?.detail}`,
    )
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★★ 夹具②（真单 `T-20261011-a5fe41` 的形状：`state=blocked`，handoffs=6 全是 orchestrator 的，planner 的会话 id 是**裸 UUID**）被识别为**孤儿**',
      b !== undefined && b.res.findings[0]?.orphan === true && String(b.res.findings[0]?.kind).startsWith('orphan-'),
      b === undefined ? '(缺夹具)' : `判词 ${b.res.findings[0]?.kind}\n${b.res.findings[0]?.detail}`,
    )
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★ 两个夹具都**真的落在本测试自己的临时任务目录里**（从盘上的 `task.json` 读回来 —— 不是内存里捏的对象；缺一个就判红，不用"跳过"冒充通过）',
      missing.length === 0 &&
        a?.t?.state === 'analyzing' &&
        a?.t?.dispatched === undefined &&
        b?.t?.state === 'blocked' &&
        Array.isArray(b?.t?.handoffs) &&
        b.t.handoffs.length === 6 &&
        !String(b?.t?.dispatched?.find((x) => String(x?.role) === 'planner')?.agent_id ?? '').startsWith('session-'),
      missing.length === 0
        ? `两张夹具都从 ${join(h.projectRoot, '.pipeline')} 下的**临时**任务目录读回来了（真单一个字节都没碰）：\n` +
          `  ① ${id1}　state=${a?.t?.state}　dispatched=${a?.t?.dispatched === undefined ? '(字段不存在)' : JSON.stringify(a?.t?.dispatched)}\n` +
          `  ② ${id2}　state=${b?.t?.state}　handoffs=${b?.t?.handoffs?.length}　planner 会话 id=${String(b?.t?.dispatched?.find((x) => String(x?.role) === 'planner')?.agent_id ?? '')}`
        : `读不到：${missing.join('、')} —— 本套用例**无法验证**（宁可红，不假装绿）`,
    )
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★ 夹具①的判据是"**派活台账里根本没有这一条**"（连它在哪个会话都不知道）',
      a !== undefined && String(a.res.findings[0]?.detail ?? '').includes('派活台账里根本没有这一条'),
      a === undefined ? '(缺夹具)' : String(a.res.findings[0]?.detail ?? '').slice(0, 400),
    )
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★ 夹具②的判据是"**机制阻塞 + planner 无活证据 + 会话文件不在**"（不是"人工阻塞"）',
      b !== undefined &&
        String(b.res.findings[0]?.kind) === 'orphan-seat-gone' &&
        String(b.res.findings[0]?.detail ?? '').includes('计划') &&
        b.res.findings[0]?.evidence?.seats?.[0]?.session_present === false,
      b === undefined ? '(缺夹具)' : String(b.res.findings[0]?.detail ?? '').slice(0, 400),
    )
    rec.add(
      'A 现场形状（夹具自造临时任务目录）',
      '★ 两个夹具**都不是**被判成"运行失败中止"（判词确实分开了）',
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
  // C2. ★ P2-8 实测：**线上默认 3 次**用尽之后到底发生什么
  // =========================================================================
  //
  //  为什么单开一段：上面 C 段用的是 `maxAttempts: 2`（为了跑得快），而**线上的默认值
  //  是 3**（`DEFAULT_MAX_REDELIVER_ATTEMPTS`）。P2-8 问的正是"第 **3** 次失败之后"，
  //  所以这里照着默认值原样再跑一遍，把三件事逐条钉住：
  //    ① 是否落 `orphan:redeliver-abandoned`（含 attempts/max）；
  //    ② 是否**播报**（主对话看得见）；
  //    ③ 是否**停手**（再扫两轮：不重投、不再记 unresolved、不再播）。
  {
    const rig3 = await makeRig({
      backoffMs: 0,
      maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
      transport: { notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）仍然投不出去。' }) },
    })
    own.push(rig3)
    await rig3.h.store.recordDispatch(rig3.taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0009', token: 'PT-dead' })
    await ageTask(rig3.h, rig3.taskId, 40)
    const rounds = []
    for (let i = 0; i < 4; i += 1) rounds.push(await rig3.rescue.runOnce())
    const abandAudit = rig3.audits.find((x) => x.action === 'orphan:redeliver-abandoned') ?? null
    rec.add(
      'C2 attempt 用尽（P2-8 · 线上默认 3 次）',
      '★★ **第 3 次失败之后**（第 4 轮扫描）落 `orphan:redeliver-abandoned`，且记明 attempts / 上限',
      abandAudit !== null && Number(abandAudit.detail?.attempts) === DEFAULT_MAX_REDELIVER_ATTEMPTS && rounds[3].actions[0]?.action === 'abandon',
      `前三轮动作=${rounds.slice(0, 3).map((r) => String(r.actions[0]?.action)).join('/')}　第 4 轮=${String(rounds[3].actions[0]?.action)}\n` +
        `审计原文：${JSON.stringify(abandAudit?.detail ?? null)}\n原因：${String(rounds[3].actions[0]?.note ?? '')}`,
    )
    rec.add(
      'C2 attempt 用尽（P2-8 · 线上默认 3 次）',
      '★★ 放弃那一刻**播报**一次（`orphan-abandoned`）—— 主对话看得见"这条投不出去了"',
      rig3.wakes.length === 1 && rig3.wakes[0].kind === 'orphan-abandoned' && String(rig3.wakes[0].disc).includes('orphan-seat-gone'),
      `播报=${JSON.stringify(rig3.wakes)}`,
    )
    const after = [await rig3.rescue.runOnce(), await rig3.rescue.runOnce()]
    rec.add(
      'C2 attempt 用尽（P2-8 · 线上默认 3 次）',
      '★★ 弃权之后**真的停手**：再扫两轮都是 `skip`，notify 恒为 3、unresolved 恒为 3、播报恒为 1（不无限骚扰）',
      after.every((r) => r.actions[0]?.action === 'skip' && r.new_orphans === 0) &&
        rig3.transport.notifies.length === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig3.ledger.unresolvedEntries({ taskId: rig3.taskId, limit: 20 }).length === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig3.wakes.length === 1,
      `第 5/6 轮动作=${after.map((r) => String(r.actions[0]?.action)).join('/')}　notify=${rig3.transport.notifies.length}　unresolved=${rig3.ledger.unresolvedEntries({ taskId: rig3.taskId, limit: 20 }).length}　播报=${rig3.wakes.length}\n` +
        `理由：${String(after[0]?.actions[0]?.note ?? '')}`,
    )
  }

  // =========================================================================
  // C3. ★★ P2-8 修复：**机制自己的唤醒留痕不许顶走孤儿身份**（正例 + 两条反例）
  // =========================================================================
  //
  //  改前实测出来的真缺陷（不是"未验证"）：孤儿身份是
  //  `<任务>|orphan|<判词>|<状态>|<最后一次进展时刻>`，而那个时刻取 `history` **末行**
  //  ⇒ 唤醒层每写一行 `wake:skipped` 就换一个身份 ⇒ `attemptsOf(taskId, id)` 每轮从 0 重数
  //  ⇒ **"同一身份最多重投 3 次"在真实运行里从未生效**（活体真单 `T-20261011-4a2dc7`
  //  重投 4 次，4 条 unresolved 全是 `attempt: 1/3`、`escalated` 0 条）。
  //
  //  修法：`lib/orphan.js` 的 `MECHANISM_BOOKKEEPING_ACTIONS` 补上**主对话侧**那五个名字
  //  （`wake:skipped` / `wake:delivered` / `wake:failed` / `wake:dedup` / `wake:escalated`，
  //  逐条对应 `lib/wakeup/keys.js` 的 `WAKE_AUDIT`），与已经在表里的 `seat:wake-*` 配对。
  //
  //  ★ 本段有**两条反例**，缺一不可：一条防"计数串台"，一条防"把判定窗关掉"。
  //  ★ 下面那行 `wake:skipped` 是**同形夹具**（复刻真单那一行的形状与写入路径，
  //    `wakeup/waker.js` → `store.recordAudit` → `history.push`），**不是活体**。
  {
    // --- 正例：**生产同形**（每轮失败之后真的写一行 `wake:skipped`）---
    const rig4 = await makeRig({
      backoffMs: 0,
      maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
      transport: { notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）仍然投不出去。' }) },
    })
    own.push(rig4)
    await rig4.h.store.recordDispatch(rig4.taskId, { role: 'orchestrator', seat: null, agentId: 'session-gone-0011', token: 'PT-dead' })
    await ageTask(rig4.h, rig4.taskId, 40)
    const prod = []
    for (let i = 0; i < 4; i += 1) {
      prod.push(await rig4.rescue.runOnce())
      if (i >= 3) break
      /**
       * ★★ **复刻生产形状的那一步**：每一轮结束（失败 ⇒ 账本落一条 `unresolved` ⇒
       * **既有巡检**把它当"该叫没叫"播报）之后，唤醒层在"没投出去"时往 `task.history`
       * 写一行 —— 走的是**线上那条写入路径**（`lib/wakeup/waker.js` 的 `note()` →
       * `store.recordAudit`（`lib/store.js`，它 `history.push(entry)`））。
       * 本机两张真单（`T-20261011-4a2dc7` / `a5fe41`）的 `history` 末行逐字就是它。
       * ⚠️ 这是**同形夹具，不是活体**：形状与写入路径一致，数据全在本测试的临时目录里。
       *
       * ★ 前 3 轮**无条件**写（生产里巡检每轮都会播报），且真等 1.1 秒 ——
       *   留痕是**秒级**的，同一秒内写多少次都只算同一个身份；不隔开的话
       *   "改前会红"这件事就测不出来（那才是假绿）。生产里两次重投至少隔一个
       *   30 分退避窗，必然落在不同的秒上。
       */
      await rig4.h.store.recordAudit(rig4.taskId, 'main', 'wake:skipped', { reason: 'no-main-session', kind: 'unresolved-wake' })
      await sleep(1100)
    }
    const ids = prod.map((r) => String(r.actions[0]?.id ?? '(未判)'))
    const acts = prod.map((r) => String(r.actions[0]?.action ?? '(未判)'))
    const skipRowLanded = (await rig4.h.store.get(rig4.taskId)).history.some((x) => String(x?.action) === 'wake:skipped')
    rec.add(
      'C3 机制留痕不许顶走身份（P2-8 修复）',
      '★★ **正例·生产同形**（每轮失败之后真的写一行 `wake:skipped`）⇒ 身份**不再被换掉**，第 3 次失败之后（第 4 轮）落 `orphan:redeliver-abandoned`',
      skipRowLanded &&
        new Set(ids).size === 1 &&
        prod.length === 4 &&
        String(prod[3]?.actions[0]?.action ?? '') === 'abandon' &&
        acts.slice(0, 3).every((a) => a === 'failed'),
      `唤醒层那行真的落盘了：${skipRowLanded}\n` +
        `前四轮动作=${acts.join('/')}（应 failed/failed/failed/abandon）\n` +
        `身份去重数=${new Set(ids).size}（应恒为 1）　身份=${ids[3]}\n` +
        `扫描轮数=${prod.length}（改前这一格会退化成 1 轮 failed + 后 3 轮判不出来）\n` +
        `原因：${String(prod[3]?.actions[0]?.note ?? '(没有动作)')}`,
    )
    const aband4 = rig4.audits.find((x) => x.action === 'orphan:redeliver-abandoned') ?? null
    rec.add(
      'C3 机制留痕不许顶走身份（P2-8 修复）',
      '★★ **放弃那一刻落审计 + 账本 `markEscalated` + 播报一次**（"看得见的失败"这一层恢复了）',
      aband4 !== null &&
        Number(aband4.detail?.attempts) === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig4.ledger.escalatedEntry(String(aband4?.detail?.orphan_id ?? '')) !== null &&
        rig4.wakes.length === 1 &&
        rig4.wakes[0].kind === 'orphan-abandoned',
      `审计=${JSON.stringify(aband4?.detail ?? null)}\n` +
        `账本 escalated=${JSON.stringify(rig4.ledger.escalatedEntry(String(aband4?.detail?.orphan_id ?? '')))}\n` +
        `播报=${JSON.stringify(rig4.wakes)}`,
    )
    const prodAfter = [await rig4.rescue.runOnce(), await rig4.rescue.runOnce()]
    rec.add(
      'C3 机制留痕不许顶走身份（P2-8 修复）',
      '★★ 放弃之后**彻底停手**：再扫两轮都是 `skip`，notify 恒 3 / unresolved 恒 3 / 播报恒 1（不再无限重投）',
      prodAfter.every((r) => r.actions[0]?.action === 'skip' && r.new_orphans === 0) &&
        rig4.transport.notifies.length === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig4.ledger.unresolvedEntries({ taskId: rig4.taskId, limit: 50 }).length === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig4.wakes.length === 1,
      `第 5/6 轮动作=${prodAfter.map((r) => String(r.actions[0]?.action)).join('/')}　notify=${rig4.transport.notifies.length}　unresolved=${rig4.ledger.unresolvedEntries({ taskId: rig4.taskId, limit: 50 }).length}　播报=${rig4.wakes.length}`,
    )

    // --- 反例①：**不许被错误合并**（计数按身份走，不按"全局一个计数器"走）---
    {
      const h5 = await createHarness()
      own.push({ h: h5 })
      const mk2 = async (tag) => {
        const o = await h5.store.open({ requirement: `夹具：反例①-${tag}`, actorRole: 'main', actorAgentId: 'agent-main' })
        await h5.store.transition({ taskId: o.task.id, event: 'dispatch_orchestrator', actorRole: 'main', actorAgentId: 'agent-main' })
        await h5.store.recordDispatch(o.task.id, { role: 'orchestrator', seat: null, agentId: `session-gone-${tag}`, token: `PT-${tag}` })
        return o.task.id
      }
      const idA = await mk2('aa')
      const idB = await mk2('bb')
      const ledger5 = createWakeLedger({ file: join(h5.projectRoot, '_ledger', 'wake-ledger.jsonl') })
      const transport5 = createSpyTransport({ notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）仍然投不出去。' }) })
      const notifier5 = createSeatNotifier({ store: h5.store, transport: transport5, wakeup: {} })
      const rescue5 = createOrphanRescue({
        store: h5.store,
        ledger: ledger5,
        notify: (spec) => notifier5.notifyOnly(spec.task, spec.role, spec.seat, spec.text, false),
        wake: async () => {},
        audit: async () => {},
        detectRunFailure: async () => ({ known: true, found: false, evidence: null, source: 'fixture', note: '夹具' }),
        sampleActivity: (task) => sampleSeatActivity(task, Date.now(), { roots: [join(h5.projectRoot, '_sessions')] }),
        graceMs: 0,
        backoffMs: 0,
        maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
        warn: () => {},
      })
      for (const id of [idA, idB]) await ageTask(h5, id, 40)
      await rescue5.runOnce()
      await rescue5.runOnce()
      const unA = ledger5.unresolvedEntries({ taskId: idA, limit: 50 })
      const unB = ledger5.unresolvedEntries({ taskId: idB, limit: 50 })
      rec.add(
        'C3 反例①：计数不许串台',
        '★★ **不同任务不许被合并**：两张单各失败 2 次 ⇒ **各自**是 2（不是 4），且每条 unresolved 的 `detail.id` 只属于自己那张单',
        unA.length === 2 &&
          unB.length === 2 &&
          unA.every((e) => String(e?.detail?.id ?? '').startsWith(`${idA}|orphan|`)) &&
          unB.every((e) => String(e?.detail?.id ?? '').startsWith(`${idB}|orphan|`)) &&
          !unA.some((e) => String(e?.detail?.id ?? '').includes(idB)) &&
          !unB.some((e) => String(e?.detail?.id ?? '').includes(idA)),
        `A=${idA} ⇒ ${unA.length} 条；B=${idB} ⇒ ${unB.length} 条（合计 notify=${transport5.notifies.length}）\n` +
          `A 的 id：${unA.map((e) => String(e?.detail?.id ?? '').slice(0, 58)).join('\n            ')}\n` +
          `B 的 id：${unB.map((e) => String(e?.detail?.id ?? '').slice(0, 58)).join('\n            ')}`,
      )
      rec.add(
        'C3 反例①：计数不许串台',
        '★★ **两边都还没被放弃**（各 2 次 < 上限 3）—— 证明它是"每个身份一本账"，不是"整单一个计数器"',
        unA.length < DEFAULT_MAX_REDELIVER_ATTEMPTS &&
          unB.length < DEFAULT_MAX_REDELIVER_ATTEMPTS &&
          transport5.notifies.length === 4,
        `A=${unA.length}/3　B=${unB.length}/3　notify 合计=${transport5.notifies.length}（应为 4 = 2+2）`,
      )

      // --- 反例①（续）：**同一张单、身份变了 ⇒ 新身份从 0 起算**（不是按任务累加）---
      const idC = await mk2('cc')
      await ageTask(h5, idC, 40)
      const ledger6 = createWakeLedger({ file: join(h5.projectRoot, '_ledger', 'wake-ledger.jsonl') })
      const transport6 = createSpyTransport({ notifyResult: () => ({ ok: false, messageId: null, note: '（夹具）仍然投不出去。' }) })
      const notifier6 = createSeatNotifier({ store: h5.store, transport: transport6, wakeup: {} })
      const rescue6 = createOrphanRescue({
        store: h5.store,
        ledger: ledger6,
        // ★ 只扫 C —— 同一份 harness 里还有 A / B 两张夹具单，不能被它们串进来。
        listTasks: async () => [{ id: idC }],
        notify: (spec) => notifier6.notifyOnly(spec.task, spec.role, spec.seat, spec.text, false),
        wake: async () => {},
        audit: async () => {},
        detectRunFailure: async () => ({ known: true, found: false, evidence: null, source: 'fixture', note: '夹具' }),
        sampleActivity: (task) => sampleSeatActivity(task, Date.now(), { roots: [join(h5.projectRoot, '_sessions')] }),
        graceMs: 0,
        backoffMs: 0,
        maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
        warn: () => {},
      })
      const c1 = await rescue6.runOnce()
      await sleep(1100)
      const c2 = await rescue6.runOnce()
      // ★ 一条**真实进展**（不是机制留痕）：判定窗与身份都该被它重新起算。
      await sleep(1100)
      await h5.store.recordAudit(idC, 'main', 'transition:dev_submitted', { note: '夹具：真实进展（不是机制留痕）' })
      const c3 = await rescue6.runOnce()
      const unC = ledger6.unresolvedEntries({ taskId: idC, limit: 50 })
      rec.add(
        'C3 反例①：计数不许串台',
        '★★ **同一张单、身份变了 ⇒ 新身份从 0 起算**（真实进展之后重新卡住＝新的一条，不是把旧账接着算）',
        c1.actions[0]?.action === 'failed' &&
          c2.actions[0]?.action === 'failed' &&
          c3.actions[0]?.action === 'failed' &&
          new Set([String(c1.actions[0]?.id), String(c2.actions[0]?.id), String(c3.actions[0]?.id)]).size === 2 &&
          unC.filter((e) => String(e?.detail?.id ?? '').endsWith(String(c3.actions[0]?.id).split('|').slice(-1)[0])).length === 1,
        `三轮动作=${[c1, c2, c3].map((r) => String(r.actions[0]?.action)).join('/')}（全是 failed，**没有**误判成 abandon）\n` +
          `身份数=${new Set([String(c1.actions[0]?.id), String(c2.actions[0]?.id), String(c3.actions[0]?.id)]).size}（应为 2：前两轮同一个，真实进展之后换新）\n` +
          `新身份只记了 ${unC.filter((e) => String(e?.detail?.id ?? '').endsWith(String(c3.actions[0]?.id).split('|').slice(-1)[0])).length} 次（应从 1 起算）`,
      )
    }

    // --- 反例②：**正常推进的单**不许被误判 / 不许消耗 attempt；且不许把判定窗关掉 ---
    {
      const rig5 = await makeRig({ backoffMs: 0, maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS })
      own.push(rig5)
      await rig5.h.store.recordDispatch(rig5.taskId, { role: 'orchestrator', seat: null, agentId: 'session-alive-0012', token: 'PT-live' })
      await ageTask(rig5.h, rig5.taskId, 40)
      // ★ 一条**真实进展**：刚交了一份交接物（席位真的动了手）。
      await patchTaskFile(rig5.h, rig5.taskId, (t) => {
        const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        t.handoffs = [{ handoff_id: 'H-fixture-live', kind: 'requirement_analysis', from_role: 'orchestrator', created_at: nowIso }]
        t.history = [...t.history, { at: nowIso, actor: 'orchestrator', action: 'handoff:requirement_analysis' }]
      })
      const rLive = await rig5.rescue.runOnce()
      rec.add(
        'C3 反例②：正常推进的单',
        '★★ **正常推进的单**（刚交过一份真实交接物）⇒ **不判孤儿**，而且**一个 attempt 都不消耗**（notify / unresolved 都是 0）',
        rLive.orphans === 0 &&
          rLive.new_orphans === 0 &&
          rig5.transport.notifies.length === 0 &&
          rig5.ledger.unresolvedEntries({ taskId: rig5.taskId, limit: 20 }).length === 0,
        `orphans=${rLive.orphans}　本轮发起=${rLive.new_orphans}　notify=${rig5.transport.notifies.length}　unresolved=${rig5.ledger.unresolvedEntries({ taskId: rig5.taskId, limit: 20 }).length}\n` +
          `扫描结论：${String(rLive.note ?? '')}`,
      )

      const now2 = Date.now()
      const staleIso = new Date(now2 - 40 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const freshIso = new Date(now2 - 5 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const withReal = mkTask({
        history: [
          { at: staleIso, actor: 'main', action: 'transition:dispatch_orchestrator' },
          { at: staleIso, actor: 'main', action: 'wake:skipped' },
          { at: freshIso, actor: 'main', action: 'transition:dev_submitted' },
        ],
      })
      const verdictReal = orphanVerdict({ task: withReal, now: now2, graceMs: DEFAULT_ORPHAN_GRACE_MS, activity: act(false), prevSamples: null, lastDeliveryAtMs: null, runFailure: null })
      const viewReal = judgeView(withReal)
      rec.add(
        'C3 反例②：正常推进的单',
        '★★ **反过来说：判定窗没有被关掉** —— 真实动作（`transition:dev_submitted`）仍在表外、仍能让窗口**重新起算**（`within-grace`）；`wake:consumed` / `seat:wake-consumed`（"有人真的接管了"）**不在**剔除表里',
        verdictReal.findings.length === 0 &&
          verdictReal.skip?.reason === 'within-grace' &&
          viewReal.history.length === 2 &&
          !MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:consumed') &&
          !MECHANISM_BOOKKEEPING_ACTIONS.includes('seat:wake-consumed') &&
          MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:skipped') &&
          MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:delivered') &&
          MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:failed') &&
          MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:dedup') &&
          MECHANISM_BOOKKEEPING_ACTIONS.includes('wake:escalated'),
        `skip=${String(verdictReal.skip?.reason)}　判据视图留下 ${viewReal.history.length} 行（真实动作那两行都在）\n` +
          `剔除表=${JSON.stringify(MECHANISM_BOOKKEEPING_ACTIONS)}`,
      )
    }
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
  // E2. ★ P1-6：「正在写交付」的席位不许被判失联并冻结
  // =========================================================================
  //
  //  现场（编号 P1-6，曾一夜触发多次，并害 `T-20261012-6884af` 丢掉一份
  //  `test_to_review` 交付）：席位**写完报告、正要交交接物的那几十秒**里，
  //  台账里当然还没有任何交接物（那一份**还没落盘**），而派活已经是几十分钟前的事
  //  ⇒ 三条老判据（超时 / 轮到场 / 无活证据）全都成立。
  //  唯一的救命证据是**会话日志的 `mtime` 就在几秒前**（它此刻正在被写）。
  //
  //  改前那一格为什么会丢：两次采样**落在同一个活动窗口内**（间隔 ≤ 2 分），
  //  而这一段增量小于 `minBytes`（1024 B）⇒ `grew:false`，
  //  且"同窗小增量"那一格**没有看 mtime**、还回 `conclusive:true`
  //  ⇒ **绕过确认门 ⇒ 一次观察即判死并冻结**（交接物就此交不上去）。
  //
  //  ★ 本段只钉"判死口径"，**不碰任何阈值**：`grew` 的语义（1024 B）一个字没改
  //    （正例里 `grew` 仍然是 `false`），静默阈值仍是 5 分。
  {
    const T0 = 1_760_000_000_000
    const sid = 'session-fixture-p16-0001'
    const base = {
      id: 'T-FIXTURE-p16',
      state: 'developing',
      handoffs: [],
      history: [],
      context_reports: [],
      successions: [],
      writer_submissions: {},
      // ★ 派活于 40 分钟前（远超 5 分钟静默阈值）—— 席位确实干了很久。
      dispatched: [{ role: 'writer', seat: 'writer#1', session_id: sid, agent_id: sid, at: new Date(T0 - 40 * MIN).toISOString(), at_ms: T0 - 40 * MIN }],
      liveness: { escalations: [], samples: {}, quiet: {} },
    }
    const withPrev = (size, mtimeAt) => ({ ...base, liveness: { escalations: [], samples: { 'writer#1': { atMs: T0 - 60 * 1000, size, mtimeMs: T0 - 60 * 1000 } }, quiet: {} } })
    /**
     * ★★ **P1-6 的形状**：上次采样在 60 秒前、这一段只长了 300 字节（< 1024 阈值），
     *   但 `mtime` 是 **8 秒前** —— 席位此刻正在写它那份报告/交付物。
     */
    const aboutToSubmit = { atMs: T0, size: 1300, mtimeMs: T0 - 8 * 1000 }
    const liveFresh = seatLiveness(withPrev(1000), T0, { silenceMs: DEFAULT_SEAT_SILENCE_MS, activity: { 'writer#1': aboutToSubmit }, gateApplicable: true })
    rec.add(
      'E2 正在写交付 ≠ 失联（P1-6）',
      '★★ 「席位写完报告、正要交交接物的那几十秒」（台账 0 证据 + 会话日志 **8 秒前刚被写过** + 这段增量 < 1024 B）⇒ **不判失联、不冻结**',
      liveFresh.silent.length === 0 && liveFresh.seats[0]?.fresh_write === true && liveFresh.seats[0]?.activity?.fresh === true && liveFresh.seats[0]?.activity?.grew === false,
      `silent=${liveFresh.silent.length}　fresh=${String(liveFresh.seats[0]?.activity?.fresh)}　grew=${String(liveFresh.seats[0]?.activity?.grew)}（**仍是 false** —— 字节阈值没被改松）\n` +
        `activity.reason=${String(liveFresh.seats[0]?.activity?.reason)}`,
    )
    /** ★ 反例①：**同一个形状**，只把 `mtime` 推过新鲜窗（70 秒）⇒ 照旧判失联。 */
    const stale70 = seatLiveness(withPrev(1000), T0, { silenceMs: DEFAULT_SEAT_SILENCE_MS, activity: { 'writer#1': { atMs: T0, size: 1300, mtimeMs: T0 - 70 * 1000 } }, gateApplicable: true })
    /** ★ 反例②：**真死**（跨窗 + 一个字节都没长 + `mtime` 陈旧）⇒ 照旧一次判死。 */
    const reallyDead = seatLiveness(
      { ...base, liveness: { escalations: [], samples: { 'writer#1': { atMs: T0 - 10 * MIN, size: 1000, mtimeMs: T0 - 10 * MIN } }, quiet: {} } },
      T0,
      { silenceMs: DEFAULT_SEAT_SILENCE_MS, activity: { 'writer#1': { atMs: T0, size: 1000, mtimeMs: T0 - 40 * MIN } }, gateApplicable: true },
    )
    rec.add(
      'E2 正在写交付 ≠ 失联（P1-6）',
      '★★ **反例照旧判死**（一个字都没放宽）：同一形状但 `mtime` 过了新鲜窗（70 秒）⇒ 判失联；真死（跨窗 +0 字节 + mtime 陈旧）⇒ 也判失联',
      stale70.silent.length === 1 && reallyDead.silent.length === 1 && reallyDead.seats[0]?.activity?.fresh === false,
      `mtime 70 秒 ⇒ silent=${stale70.silent.length}（fresh=${String(stale70.seats[0]?.activity?.fresh)}）\n` +
        `真死（跨窗 +0B + mtime 40 分）⇒ silent=${reallyDead.silent.length}（fresh=${String(reallyDead.seats[0]?.activity?.fresh)}）\n` +
        `${String(reallyDead.seats[0]?.activity?.reason)}`,
    )
    rec.add(
      'E2 正在写交付 ≠ 失联（P1-6）',
      '★★ **阈值一个字没动**：静默阈值仍是 5 分、新鲜窗仍是 60 秒（修的是"判死口径"，不是把检测调松）',
      DEFAULT_SEAT_SILENCE_MS === 5 * MIN && DEFAULT_ACTIVITY_FRESH_MS === 60 * 1000,
      `静默阈值=${DEFAULT_SEAT_SILENCE_MS / MIN} 分　新鲜窗=${DEFAULT_ACTIVITY_FRESH_MS / 1000} 秒`,
    )
    /** ★ 边界：`mtime` **正好**等于新鲜窗（60.0 秒）算"刚刚被写过"；60.5 秒就不算。 */
    const atEdge = seatLiveness(withPrev(1000), T0, { silenceMs: DEFAULT_SEAT_SILENCE_MS, activity: { 'writer#1': { atMs: T0, size: 1000, mtimeMs: T0 - 60 * 1000 } }, gateApplicable: true })
    const pastEdge = seatLiveness(withPrev(1000), T0, { silenceMs: DEFAULT_SEAT_SILENCE_MS, activity: { 'writer#1': { atMs: T0, size: 1000, mtimeMs: T0 - 60_500 } }, gateApplicable: true })
    rec.add(
      'E2 正在写交付 ≠ 失联（P1-6）',
      '★ 新鲜窗的边界是**闭合的**：`mtime` 距今正好 60.0 秒算"刚刚被写过"（不判死）；60.5 秒就算过期（判死）',
      atEdge.silent.length === 0 && pastEdge.silent.length === 1,
      `60.0 秒 ⇒ silent=${atEdge.silent.length}　60.5 秒 ⇒ silent=${pastEdge.silent.length}`,
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
