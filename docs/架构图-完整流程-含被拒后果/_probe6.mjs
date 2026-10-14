// 只读探针 v6：以「首个错误的签名」为状态做贪心前进（只要错误变了就算前进），带访问集防环。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

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
function specKey(spec) { return createHash('sha256').update(JSON.stringify(spec)).digest('hex') }

function run(spec) {
  const k = specKey(spec)
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
function sigOf(spec) {
  const r = run(spec)
  if (r.ok) return 'PASS'
  const bad = r.diagnostics.find((d) => d.severity === 'error')
  if (!bad) return 'PASS'
  return bad.code + '|' + idsOf(bad).slice().sort().join(',')
}

let current = JSON.parse(readFileSync(BASE, 'utf8'))
const log = []
const visited = new Set()
let steps = 0
let ok = false

while (steps++ < 260) {
  const sig = sigOf(current)
  log.push('STEP ' + steps + ' sig=' + sig)
  if (sig === 'PASS') { ok = true; break }
  if (visited.has(sig)) { log.push('  停滞（签名重复），停止'); break }
  visited.add(sig)

  const r = run(current)
  const bad = r.diagnostics.find((d) => d.severity === 'error')
  const ids = idsOf(bad).filter((x) => current.edges.some((e) => e.id === x))
  if (ids.length === 0) { log.push('  无涉及边，停止'); break }

  let advanced = false
  for (const id of ids) {
    const idx = current.edges.findIndex((e) => e.id === id)
    for (const c of combos) {
      const trial = JSON.parse(JSON.stringify(current))
      const e = trial.edges[idx]
      delete e.route; delete e.fromSide; delete e.toSide
      Object.assign(e, c)
      const ns = sigOf(trial)
      const deadEnd = ns.includes('conflict')
      if (ns === 'PASS' || (ns !== sig && !visited.has(ns) && !deadEnd)) {
        log.push('  ADVANCE ' + id + ' <- ' + JSON.stringify(c) + '  => ' + ns)
        current = trial
        advanced = true
        break
      }
    }
    if (advanced) break
  }
  if (advanced) continue

  // 实在无法前进：若涉及边里有非必留的，摘掉它
  const droppable = ids.find((x) => !MUST.has(x))
  if (droppable === undefined) { log.push('  无可前进且涉及边全为必留 —— 停止'); break }
  const idx = current.edges.findIndex((e) => e.id === droppable)
  const removed = current.edges.splice(idx, 1)[0]
  log.push('  DEFER ' + removed.id)
  visited.clear()
}

if (ok) writeFileSync(BASE, JSON.stringify(current, null, 2), 'utf8')
log.push('结果：ok=' + ok + ' steps=' + steps + ' edges=' + current.edges.length + ' validateCalls=' + cache.size)
writeFileSync(DIR + '_probe.log.txt', log.join('\n'), 'utf8')
console.log(log.slice(-45).join('\n'))
console.log('---')
console.log(log[log.length - 1])
