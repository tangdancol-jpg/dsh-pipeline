// 只读探针 v4：必须留的边无解就中止报告；可选的边才允许推迟。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const DIR = '<DSH_HOME>/dsh_orb/架构图-完整流程-含被拒后果/'
const BASE = DIR + '完整流程.workflow.json'
const TMP = DIR + '_probe.json'
const ARCHIFY = '<DSH_HOME>/skills/archify/bin/archify.mjs'

const MUST = new Set([
  'e_open', 'e_initiate', 'e_need_to_supervisor', 'e_agree_need', 'e_diagram_submitted',
  'e_confirm_diagram', 'e_planned', 'e_dev_submitted', 'e_test_passed', 'e_review_ok', 'e_close',
  'e_r1_test_to_dev', 'e_r2_review_to_dev', 'e_r3_review_to_test', 'e_r4_reject_diagram',
  'e_r5_back_to_analysis', 'e_r6_plan_gap',
  'e_x_reject_need', 'e_x_reject_test', 'e_x_reject_review'
])

const base = JSON.parse(readFileSync(BASE, 'utf8'))

const combos = [{}]
for (const r of ['auto', 'straight', 'drop', 'outside-right', 'return-left', 'bottom-channel', 'up-channel']) combos.push({ route: r })
const sides = ['top', 'bottom', 'left', 'right']
for (const a of sides) for (const b of sides) combos.push({ fromSide: a, toSide: b })
for (const a of sides) combos.push({ fromSide: a })
for (const b of sides) combos.push({ toSide: b })

function run(spec) {
  writeFileSync(TMP, JSON.stringify(spec, null, 2), 'utf8')
  try {
    const out = execFileSync(process.execPath, [ARCHIFY, 'validate', 'workflow', TMP, '--layout-json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, diagnostics: JSON.parse(out).diagnostics ?? [] }
  } catch (err) {
    const txt = String(err.stdout ?? '') + String(err.stderr ?? '')
    try { const j = JSON.parse(txt); return { ok: false, diagnostics: j.diagnostics ?? [] } }
    catch { return { ok: false, diagnostics: [{ code: 'unparsed', severity: 'error', message: txt.slice(0, 400) }] } }
  }
}

function edgeIdsOf(d) {
  const ids = []
  const cands = [d && d.subject && d.subject.edge, d && d.subject && d.subject.id, d && d.evidence && d.evidence.otherRelationship && d.evidence.otherRelationship.id]
  for (const v of cands) if (typeof v === 'string') ids.push(v)
  return [...new Set(ids)]
}

function tryFix(spec, ids) {
  for (const id of ids) {
    const idx = spec.edges.findIndex((e) => e.id === id)
    if (idx < 0) continue
    for (const c of combos) {
      const trial = JSON.parse(JSON.stringify(spec))
      const e = trial.edges[idx]
      delete e.route; delete e.fromSide; delete e.toSide
      Object.assign(e, c)
      if (run(trial).ok) return { trial, id, combo: c }
    }
  }
  return null
}

const log = []
let current = base
const deferred = []
let guard = 0
let aborted = false

while (guard++ < 90) {
  const r = run(current)
  if (r.ok) { log.push('PASS: 整图 validate 无 error'); break }
  const bad = r.diagnostics.find((d) => d.severity === 'error')
  const ids = edgeIdsOf(bad)
  log.push('FAIL ' + bad.code + ' edges=' + (ids.join('/') || '(none)') + ' :: ' + String(bad.message).slice(0, 170))
  if (ids.length === 0) { aborted = true; break }

  const fixed = tryFix(current, ids)
  if (fixed) { log.push('  FIX ' + fixed.id + ' <- ' + JSON.stringify(fixed.combo)); current = fixed.trial; continue }

  const first = ids.find((x) => current.edges.some((e) => e.id === x))
  if (first === undefined) { aborted = true; break }
  if (MUST.has(first)) { log.push('  ABORT: 必留边 ' + first + ' 穷举无解 —— 需要改布局或节点列位'); aborted = true; break }

  const idx = current.edges.findIndex((e) => e.id === first)
  const removed = current.edges.splice(idx, 1)[0]
  deferred.push(removed)
  log.push('  DEFER ' + removed.id)
}

const stillOut = []
if (!aborted) {
  for (const e of deferred) {
    const trial = JSON.parse(JSON.stringify(current))
    trial.edges.push({ ...e })
    const fixed = tryFix(trial, [e.id])
    if (fixed) { log.push('  READD ' + e.id + ' <- ' + JSON.stringify(fixed.combo)); current = fixed.trial }
    else { stillOut.push(e.id); log.push('  DROPPED ' + e.id) }
  }
  writeFileSync(BASE, JSON.stringify(current, null, 2), 'utf8')
}

log.push('最终：nodes=' + current.nodes.length + ' edges=' + current.edges.length + ' dropped=[' + stillOut.join(', ') + '] aborted=' + aborted)
writeFileSync(DIR + '_probe.log.txt', log.join('\n'), 'utf8')
console.log(log.join('\n'))
