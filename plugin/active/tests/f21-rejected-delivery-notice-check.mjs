// §9 噪声 ②③ 回归：被拒收的交付播的那条 delivery-rejected 是机制通知 —— 不进"没人接管"、不升级；真交付照旧报、照旧升。
/**
 * dsh-pipeline · F21：拒收播报不再被当成"等待接管的交付"
 * ============================================================================
 *     node tests/f21-rejected-delivery-notice-check.mjs
 *
 * 现场：交接物被状态机拒收 ⇒ flow.js 归档并播一条 `delivery-rejected`（正文写死"这条没有被接收"）。
 * 但这条播报以**提交方角色**为 actor、类别又不在 MECHANISM_NOTICE_KINDS 里 ⇒
 * `isMechanismNotice` 两段都不成立 ⇒ 它进了"已投递未接管"清单，巡检再报一条
 * `unconsumed-delivery`、升级链再升一条 `#escalated` —— 同一条事实报三次。
 *
 * 本套走真工具：harness 接一个真唤醒器（真账本 + 假宿主），由 `pipeline_handoff` 的拒收路径真正播出去。
 *
 * 钉住：
 *   ②  拒收 ⇒ delivery-rejected 有且仅有一条；它不在"未接管"清单里；巡检零条 unconsumed-delivery
 *   ③  它被认作机制通知；升级链零升级（没有 #escalated 键）；正文里仍看得出是谁交的
 *   反向 真交付（handoff，席位角色）没人接管 ⇒ 照旧进清单、照旧被巡检报、照旧升一层
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'
import { patrolFindings } from '../lib/patrol.js'
import { createWakeLedger, isMechanismNotice, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { createMainSessionRegistry, createWaker } from '../lib/wakeup.js'

const TASK = 'T-F21'
const MAIN_SESSION = 'f21-session-main'

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
      const L = ['dsh-pipeline · F21：拒收播报不当作"等待接管的交付"（§9 噪声 ②③）', '='.repeat(78)]
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

/** 假宿主：只要能"看见投递"就够（与 wake-channel-check 同形）。 */
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
      return undefined
    },
  }
  return { ctx, ensure, delivered }
}

const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? m ?? ''))

export async function runF21RejectedDeliveryNoticeCheck() {
  const rec = createRecorder()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f21-'))
  let h = null
  try {
    const host = fakeHost()
    host.ensure(MAIN_SESSION)
    const registry = createMainSessionRegistry()
    registry.remember(TASK, MAIN_SESSION, 'test')
    const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
    let waker = null
    h = await createHarness({ wakeup: { wake: (spec) => waker.wake(spec) } })
    waker = createWaker({ ctx: host.ctx, registry, ledger, getTask: async (id) => h.store.peek(id), audit: async () => {}, warn: () => {} })

    const opened = await h.store.open({ id: TASK, actorRole: 'main', actorAgentId: 'f21-main', requirement: 'F21 夹具：开单后测试位立刻交 test_to_review（跳步 ⇒ 拒收）。' })
    if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
    const minted = h.tokens.mint({ taskId: TASK, role: 'tester', seat: null, agentId: 'f21-tester' })
    const tk = minted?.token ?? minted?.rec?.token
    const r = await callTool(h, 'pipeline_handoff', { task_id: TASK, kind: 'test_to_review', role_token: tk, payload: { task_id: TASK, artifact_version: 'v1', test_cases: ['c'], execution_result: 'r', failure_logs: [], pass_evidence: ['e'], risk_notes: [], verdict: 'pass' } }, 'f21-tester')

    const rejectedEntries = () => ledger.snapshot().delivered.filter((e) => String(e.key).includes('|delivery-rejected|'))
    const pending = () => waker.pendingDeliveries(TASK)

    {
      const G = '② 拒收只报一次'
      const rd = h.store.peek(TASK).rejected_deliveries ?? []
      rec.add(G, '夹具：交接物真被拒收并留档（跳步）', r.denied === true && rd.length === 1, `${String(r.text).split('\n')[0]}\nrejected_deliveries=${rd.length}`)
      rec.add(G, '★ delivery-rejected 播了且只播了一条', rejectedEntries().length === 1 && host.delivered.length === 1, `ledger=${rejectedEntries().length} host=${host.delivered.length}`)
      rec.add(G, '★★ 它不在"已投递未接管"清单里', pending().length === 0, JSON.stringify(pending().map((e) => e.key)))
      const f = patrolFindings({ task: h.store.peek(TASK), now: Date.now() + 3600_000, unconsumed: pending() })
      rec.add(G, '★★ 巡检零条 unconsumed-delivery', f.findings.filter((x) => x.kind === 'unconsumed-delivery').length === 0, JSON.stringify(f.findings.map((x) => x.kind)))
      const hand = patrolFindings({ task: h.store.peek(TASK), now: Date.now(), unconsumed: rejectedEntries().map((e) => ({ ...e, age_ms: 3600_000 })) })
      rec.add(G, '★ 手喂进巡检（第二道闸）也被挡下（mechanism-notice）', hand.findings.filter((x) => x.kind === 'unconsumed-delivery').length === 0 && hand.suppressed.some((x) => x.reason === 'mechanism-notice'), JSON.stringify({ findings: hand.findings.map((x) => x.kind), suppressed: hand.suppressed.map((x) => x.reason) }))
    }

    {
      const G = '③ 拒收播报是机制通知，不升级'
      const e = rejectedEntries()[0]
      rec.add(G, '★★ isMechanismNotice 认它（类别在名单里 + actor = mechanism）', e !== undefined && isMechanismNotice(e), JSON.stringify({ key: e?.key, kind: e?.kind, actor: e?.actor }))
      const esc = await waker.escalateUnconsumed(TASK, { limit: 10 })
      rec.add(G, '★★ 升级链零升级、账本里没有 #escalated 键', esc.escalated === 0 && ledger.snapshot().escalated.length === 0, `${esc.escalated} · ${esc.note}`)
      const msg = textOf(host.delivered[0]?.message)
      rec.add(G, '★ 正文仍看得出是谁交的、没被接收', msg.includes('tester') && msg.includes('没有'), msg.slice(0, 200))
    }

    {
      const G = '反向：真交付照旧报、照旧升'
      const w = await waker.wake({ taskId: TASK, actorRole: 'tester', actorSeat: null, kind: 'handoff', what: '交了一份交接物', disc: 'H-F21-REAL' })
      const p = pending()
      rec.add(G, '★ 席位交付没人接管 ⇒ 照旧进清单', w.injected === true && p.length === 1 && p[0].key.includes('|handoff|'), JSON.stringify(p.map((x) => x.key)))
      const f = patrolFindings({ task: h.store.peek(TASK), now: Date.now(), unconsumed: p.map((x) => ({ ...x, age_ms: 3600_000 })) })
      rec.add(G, '★ 巡检照旧报 unconsumed-delivery', f.findings.filter((x) => x.kind === 'unconsumed-delivery').length === 1, JSON.stringify(f.findings.map((x) => x.kind)))
      const esc = await waker.escalateUnconsumed(TASK, { limit: 10 })
      rec.add(G, '★★ 升级链照旧升一层（#escalated）', esc.escalated === 1 && ledger.snapshot().escalated.some((x) => String(x.escalation_key).endsWith('H-F21-REAL#escalated')), esc.note)
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    if (h !== null) await disposeHarness(h)
    rmSync(dir, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF21RejectedDeliveryNoticeCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
