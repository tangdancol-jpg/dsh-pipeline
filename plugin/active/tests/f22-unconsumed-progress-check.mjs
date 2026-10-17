// §9 噪声 ① 回归：投递之后任务真进展了（状态前进 / 新交接物）⇒ 记为已接管，不再报"没人接管"、不再升级。
/**
 * dsh-pipeline · F22：状态机已前进的投递不再算"没人接管"
 * ============================================================================
 *     node tests/f22-unconsumed-progress-check.mjs
 *
 * 现场：「已消费」只认显式 `markConsumed`（主对话调会写盘的工具时才记）。席位走别的路推进了状态
 * （自愈建的席位、角色自己 `pipeline_transition`），那条投递就永远停在"未消费" ⇒ 巡检反复报、升级链再升。
 *
 * 钉住：
 *   ①-A 投递后状态前进（不调 markConsumed）⇒ 记为已接管：不在清单、巡检零条、升级零条，账上写明依据
 *   ①-B 投递后出现新交接物 ⇒ 同上
 *   ①-C 反向：投递后什么都没发生 ⇒ 照旧报、照旧升（"该叫没叫必须报出来"不许被削掉）
 *   ①-D 反向：只是被冻结 / 进等待态、或进展发生在投递之前 ⇒ 不算接管
 *   ①-E 装配：巡检每轮取清单之前先结算（index.js）
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { patrolFindings } from '../lib/patrol.js'
import { createWakeLedger, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { createMainSessionRegistry, createWaker } from '../lib/wakeup.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_SESSION = 'f22-session-main'

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
      const L = ['dsh-pipeline · F22：状态已前进的投递不再算"没人接管"（§9 噪声 ①）', '='.repeat(78)]
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

function fakeHost() {
  const sessions = new Map()
  const ensure = (id) => {
    if (!sessions.has(id)) sessions.set(id, { id, inbox: { nextTurn: [], nextStep: [] }, followup(msg) { this.inbox.nextTurn.push(msg) } })
    return sessions.get(id)
  }
  const ctx = { logger: { info() {}, warn() {}, debug() {} }, get: (name) => (name === 'agents' ? { get: (id) => sessions.get(id) ?? undefined } : undefined) }
  return { ctx, ensure }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** 一个独立场景：一张单 + 一个唤醒器 + 一条已投递的席位交付。 */
async function scene(dir, id) {
  const task = { id, state: 'ready_test', handoffs: [], artifacts: [], records: [], clarification_requests: [], human_requests: [], history: [], dispatched: [], liveness: { escalations: [], aborts: [] } }
  const host = fakeHost()
  host.ensure(MAIN_SESSION)
  const registry = createMainSessionRegistry()
  registry.remember(id, MAIN_SESSION, 'test')
  const ledger = createWakeLedger({ file: join(dir, `${id}-${LEDGER_FILE_NAME}`), warn: () => {} })
  const waker = createWaker({ ctx: host.ctx, registry, ledger, getTask: async () => task, audit: async () => {}, warn: () => {} })
  const w = await waker.wake({ taskId: id, actorRole: 'writer', actorSeat: 'writer#1', kind: 'handoff', what: '交了一份 dev_to_test', disc: `H-${id}` })
  if (w.injected !== true) throw new Error(`夹具：投递没送出去（${w.reason}）`)
  const deliveredAt = Date.parse(ledger.snapshot().delivered[0].at)
  return { task, waker, ledger, deliveredAt }
}

const settle = (s) => (typeof s.waker.settleByProgress === 'function' ? s.waker.settleByProgress(s.task.id, s.task) : { ok: false, marked: 0, note: '(没有 settleByProgress)' })
const transitionAt = (ms, event, from, to) => ({ at: iso(ms), task_id: 'x', actor: 'tester', action: `transition:${event}`, from, to })
const reported = (s) => patrolFindings({ task: s.task, now: Date.now(), unconsumed: s.waker.pendingDeliveries(s.task.id).map((e) => ({ ...e, age_ms: 3600_000 })) }).findings.filter((x) => x.kind === 'unconsumed-delivery').length

export async function runF22UnconsumedProgressCheck() {
  const rec = createRecorder()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f22-'))
  try {
    {
      const G = '①-A 投递后状态前进 ⇒ 已接管'
      const s = await scene(dir, 'T-F22A')
      s.task.history.push(transitionAt(s.deliveredAt + 5000, 'start_test', 'ready_test', 'testing'))
      s.task.state = 'testing'
      const r = await settle(s)
      rec.add(G, '★★ 结算记下 1 条接管（不靠 markConsumed）', r.marked === 1, r.note)
      rec.add(G, '★★ 不在"已投递未接管"清单里；巡检零条 unconsumed-delivery', s.waker.pendingDeliveries('T-F22A').length === 0 && reported(s) === 0, `pending=${s.waker.pendingDeliveries('T-F22A').length}`)
      const esc = await s.waker.escalateUnconsumed('T-F22A', { limit: 5 })
      rec.add(G, '★ 升级链零升级', esc.escalated === 0, esc.note)
      const c = s.ledger.snapshot().consumed[0]
      rec.add(G, '★ 账上写明依据（机制记的、因为哪一步进展）', c?.by === 'mechanism' && String(c?.action ?? '').includes('transition:start_test'), JSON.stringify(c))
      const again = await settle(s)
      rec.add(G, '★ 幂等：再结算一次不重复记', again.marked === 0, again.note)
    }

    {
      const G = '①-B 投递后出现新交接物 ⇒ 已接管'
      const s = await scene(dir, 'T-F22B')
      s.task.handoffs.push({ handoff_id: 'H-next', kind: 'test_to_review', from_role: 'tester', created_at: iso(s.deliveredAt + 5000) })
      const r = await settle(s)
      rec.add(G, '★★ 后续交接物 ⇒ 记为已接管', r.marked === 1 && s.waker.pendingDeliveries('T-F22B').length === 0, r.note)
    }

    {
      const G = '①-C 反向：什么都没发生 ⇒ 照旧报、照旧升'
      const s = await scene(dir, 'T-F22C')
      const r = await settle(s)
      rec.add(G, '★★ 结算零条；仍在清单、巡检照旧报', r.marked === 0 && s.waker.pendingDeliveries('T-F22C').length === 1 && reported(s) === 1, `marked=${r.marked} pending=${s.waker.pendingDeliveries('T-F22C').length}`)
      const esc = await s.waker.escalateUnconsumed('T-F22C', { limit: 5 })
      rec.add(G, '★★ 升级链照旧升一层', esc.escalated === 1, esc.note)
    }

    {
      const G = '①-D 反向：不是真进展 ⇒ 不算接管'
      const s = await scene(dir, 'T-F22D')
      s.task.history.push(transitionAt(s.deliveredAt + 5000, 'block', 'ready_test', 'blocked'))
      s.task.history.push(transitionAt(s.deliveredAt + 6000, 'human_request', 'blocked', 'awaiting_human'))
      s.task.history.push(transitionAt(s.deliveredAt - 60_000, 'dispatch_tester', 'developing', 'ready_test'))
      s.task.history.push({ at: iso(s.deliveredAt + 7000), actor: 'mechanism', action: 'wake:delivered' })
      s.task.handoffs.push({ handoff_id: 'H-old', kind: 'dev_to_test', from_role: 'writer', created_at: iso(s.deliveredAt - 60_000) })
      const r = await settle(s)
      rec.add(G, '★★ 冻结 / 进等待态 / 投递之前的进展 / 机制记账行 ⇒ 都不算', r.marked === 0 && s.waker.pendingDeliveries('T-F22D').length === 1, `marked=${r.marked} ${r.note}`)
    }

    {
      const G = '①-E 装配：巡检先结算再取清单'
      const src = readFileSync(join(HERE, '..', 'index.js'), 'utf8')
      const tick = src.slice(src.indexOf('tick: async ({ stats })'))
      const a = tick.indexOf('settleByProgress')
      const b = tick.indexOf('pendingDeliveries(')
      rec.add(G, '★ index.js 的巡检 tick 在 pendingDeliveries 之前调 settleByProgress', a > 0 && b > 0 && a < b, `settle@${a} pending@${b}`)
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF22UnconsumedProgressCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
