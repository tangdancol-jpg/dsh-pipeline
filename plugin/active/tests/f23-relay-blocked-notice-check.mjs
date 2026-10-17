// §9 噪声 ④ 回归：投递的席位角色按继任策略不可换班 ⇒ 告警写明"不可换班 / 重下 relayPolicy"，不再生出消费不掉的升级键。
/**
 * dsh-pipeline · F23：不可换班的席位，告警给出可执行的下一步
 * ============================================================================
 *     node tests/f23-relay-blocked-notice-check.mjs
 *
 * 现场：某角色（现场是 planner）的"没人接管"告警一直挂着、升了级也消费不掉 ——
 * `lib/context.js` 的继任判据明写"不在 relayPolicy.allowedRoles 里，本次不给继任"，
 * 而巡检的 unconsumed 一支全程不读 relayPolicy ⇒ 把告警升给一个按策略换不了它的主对话。
 *
 * 钉住：
 *   ④-A 角色不在 allowedRoles ⇒ 巡检正文含"不可换班 / 重下 relayPolicy / 走人工"
 *   ④-B 同上 ⇒ 升级链不升（没有 #escalated 键），升级结论里写明为什么不升
 *   ④-C 反向：角色在 allowedRoles 内 ⇒ 正文与升级逐字不变
 *   ④-D 反向：allowedRoles 为空（= 全部可换）⇒ 不变
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULT_RELAY_POLICY } from '../lib/context.js'
import { patrolFindings } from '../lib/patrol.js'
import { createWakeLedger, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { createMainSessionRegistry, createWaker } from '../lib/wakeup.js'

const MAIN_SESSION = 'f23-session-main'

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
      const L = ['dsh-pipeline · F23：不可换班的席位告警给出下一步（§9 噪声 ④）', '='.repeat(78)]
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

/** 一张 L3 单（继任启用）+ 一条某角色交的、没人接管的投递。 */
async function scene(dir, id, { role, allowedRoles }) {
  const task = {
    id,
    state: 'planning',
    roster: { tier: 'L3', relay_policy: { ...DEFAULT_RELAY_POLICY, allowedRoles } },
    handoffs: [], artifacts: [], records: [], clarification_requests: [], human_requests: [], history: [], dispatched: [],
    liveness: { escalations: [], aborts: [] },
  }
  const host = fakeHost()
  host.ensure(MAIN_SESSION)
  const registry = createMainSessionRegistry()
  registry.remember(id, MAIN_SESSION, 'test')
  const ledger = createWakeLedger({ file: join(dir, `${id}-${LEDGER_FILE_NAME}`), warn: () => {} })
  const waker = createWaker({ ctx: host.ctx, registry, ledger, getTask: async () => task, audit: async () => {}, warn: () => {} })
  const w = await waker.wake({ taskId: id, actorRole: role, actorSeat: null, kind: 'handoff', what: '交了一份 seat_handover', disc: `H-${id}` })
  if (w.injected !== true) throw new Error(`夹具：投递没送出去（${w.reason}）`)
  const pending = waker.pendingDeliveries(id).map((e) => ({ ...e, age_ms: 3600_000 }))
  const finding = patrolFindings({ task, now: Date.now(), unconsumed: pending }).findings.find((x) => x.kind === 'unconsumed-delivery') ?? null
  const esc = await waker.escalateUnconsumed(id, { limit: 5, task })
  return { finding, esc, escalatedKeys: ledger.snapshot().escalated.length }
}

const HINT = ['不可换班', '重下 relayPolicy', '人工']
const hasHint = (s) => HINT.every((n) => String(s ?? '').includes(n))

export async function runF23RelayBlockedNoticeCheck() {
  const rec = createRecorder()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f23-'))
  try {
    {
      const s = await scene(dir, 'T-F23A', { role: 'planner', allowedRoles: ['writer', 'tester'] })
      rec.add('④-A 不可换班 ⇒ 告警给下一步', '★★ 巡检正文含"不可换班 / 重下 relayPolicy / 走人工"', s.finding !== null && hasHint(s.finding.detail), String(s.finding?.detail ?? '(没有告警)'))
      rec.add('④-A 不可换班 ⇒ 告警给下一步', '★ 正文点名是哪个角色、白名单是什么', String(s.finding?.detail ?? '').includes('planner') && String(s.finding?.detail ?? '').includes('writer / tester'), '')
      rec.add('④-B 不升级', '★★ 升级链不升（没有 #escalated 键）', s.esc.escalated === 0 && s.escalatedKeys === 0, s.esc.note)
      rec.add('④-B 不升级', '★ 升级结论写明为什么不升', hasHint(s.esc.note), s.esc.note)
    }
    {
      const s = await scene(dir, 'T-F23C', { role: 'writer', allowedRoles: ['writer', 'tester'] })
      rec.add('④-C 反向：可换班 ⇒ 不变', '★★ 正文不带不可换班指引（与改前同形）', s.finding !== null && !String(s.finding.detail).includes('不可换班') && String(s.finding.detail).endsWith('—— 送达不等于接管（A28）。'), String(s.finding?.detail ?? ''))
      rec.add('④-C 反向：可换班 ⇒ 不变', '★★ 照旧升一层', s.esc.escalated === 1 && s.escalatedKeys === 1, s.esc.note)
    }
    {
      const s = await scene(dir, 'T-F23D', { role: 'planner', allowedRoles: [] })
      rec.add('④-D 反向：白名单为空 ⇒ 不变', '★ 正文不带指引、照旧升一层', s.finding !== null && !String(s.finding.detail).includes('不可换班') && s.esc.escalated === 1, s.esc.note)
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
  runF23RelayBlockedNoticeCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
