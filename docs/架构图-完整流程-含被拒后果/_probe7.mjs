// 只读探针 v7：先降级（按优先级，先牺牲机制边）拿到一个能整图通过的底，再按优先级从高到低把边加回来。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const DIR = '~/.dsh/dsh_orb/架构图-完整流程-含被拒后果/'
const BASE = DIR + '完整流程.workflow.json'
const TMP = DIR + '_probe.json'
const ARCHIFY = '~/.dsh/skills/archify/bin/archify.mjs'

const PRIO = {
  e_open: 100, e_initiate: 100, e_need_to_supervisor: 100, e_agree_need: 100, e_diagram_submitted: 100,
  e_confirm_diagram: 100, e_planned: 100, e_dev_submitted: 100, e_test_passed: 100, e_review_ok: 100, e_close: 100,
  e_r1_test_to_dev: 90, e_r2_review_to_dev: 90, e_r3_review_to_test: 90, e_r4_reject_diagram: 90,
  e_r5_back_to_analysis: 90, e_r6_plan_gap: 90,
  e_x_reject_need: 85, e_x_reject_test: 85, e_x_reject_review: 85,
  e_clarify_ask: 50, e_design: 45,
  e_r_tokens: 30, e_r_guard: 30, e_r_hashing: 30, e_r_states: 30, e_plumbing_close: 30,
  e_wake_main: 25, e_wakeup_hostmsg: 25, e_hostmsg_main: 25, e_seatnotify_main: 25,
  e_ledger_wake: 20, e_liveness_ledger: 20, e_runfail_liveness: 20, e_patrol_liveness: 20,
  e_orphan_notify: 20, e_reattach_hostmsg: 20
}
const prio = (id) => PRIO[id] ?? 60

const combos = [{}]
for (const r of ['auto', 'straight', 'drop', 'outside-right', 'return-left', 'bottom-channel', 'up-channel']) combos.push({ route: r })
const sides = ['top', 'bottom', 'left', 'right']
for (const a of sides) for (const b of sides) combos.push({ fromSide: a, toSide: b })
for (const a of sides) combos.push({ fromSide: a })
for (const b of sides) combos.push({ toSide: b })
for (const r of ['drop', 'outside-right', 'return-left', 'bottom-channel', 'up-channel', 'straight']) {
  for (const a of sides) for (const b of sides) combos.push({ route: r, fromSide: a, toSide: b })
}

const cache = new Map()
function run(spec) {
  const k = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
  if (cache.has(k)) return cache.get(k)
  writeFileSync(TMP, JSON.stringify(spec, null, 2), 'utf8')
  let res
  try {
    const out = execFileSync(process.execPath, [ARCHIFY, 'validate', 'workflow', TMP, '--layout-json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    res = { ok: true, diagnostics: JSON.parse(out).diagnostics ?? [] }
  } catch (err) {
    const txt = String(err.stdout ?? '') + String(err.stderr ?? '')
    try { const j = JSON.parse(txt); res = { ok: false, diagnostics: j.diagnostics ?? [] } }
    catch { res = { ok: false, diagnostics: [{ code: 'unparsed', severity: 'error', message: txt.slice(0, 300) }] } }
  }
  cache.set(k, res)
  return res
}
function idsOf(d) {
  const out = []
  for (const v of [d && d.subject && d.subject.edge, d && d.subject && d.subject.id, d && d.evidence && d.evidence.otherRelationship && d.evidence.otherRelationship.id]) {
    if (typeof v === 'string') out.push(v)
  }
  return [...new Set(out)]
}

let current = JSON.parse(readFileSync(BASE, 'utf8'))
const log = []
const deferred = []
let guard = 0

// ---- 阶段 1：降级到能整图通过 ------------------------------------------------
while (guard++ < 120) {
  const r = run(current)
  if (r.ok) { log.push('BASE PASS：edges=' + current.edges.length); break }
  const bad = r.diagnostics.find((d) => d.severity === 'error')
  const ids = idsOf(bad).filter((x) => current.edges.some((e) => e.id === x))
  log.push('FAIL ' + bad.code + ' ' + ids.join('/'))
  if (ids.length === 0) { log.push('  无涉及边，停止'); break }
  const victim = ids.slice().sort((a, b) => prio(a) - prio(b))[0]
  const idx = current.edges.findIndex((e) => e.id === victim)
  deferred.push(current.edges.splice(idx, 1)[0])
  log.push('  DEFER ' + victim + ' (prio ' + prio(victim) + ')')
}

// ---- 阶段 2：按优先级从高到低加回 -------------------------------------------
const pending = deferred.slice().sort((a, b) => prio(b.id) - prio(a.id))
const stillOut = []
for (const e of pending) {
  let placed = false
  for (const c of combos) {
    const trial = JSON.parse(JSON.stringify(current))
    const clone = { ...e }
    delete clone.route; delete clone.fromSide; delete clone.toSide
    Object.assign(clone, c)
    trial.edges.push(clone)
    if (run(trial).ok) {
      log.push('  READD ' + e.id + ' <- ' + JSON.stringify(c))
      current = trial; placed = true; break
    }
  }
  if (!placed) { stillOut.push(e.id); log.push('  LEFT OUT ' + e.id + ' (prio ' + prio(e.id) + ')') }
}

if (run(current).ok) writeFileSync(BASE, JSON.stringify(current, null, 2), 'utf8')
log.push('结果：edges=' + current.edges.length + ' 未放入=[' + stillOut.join(', ') + '] validateCalls=' + cache.size)
writeFileSync(DIR + '_probe.log.txt', log.join('\n'), 'utf8')
console.log(log.join('\n'))
