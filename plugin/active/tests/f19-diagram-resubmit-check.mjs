// 缺陷 ⑯ 回归：前置站（arch_confirm / ②b / ②c）重交架构图不再撞 BAD_TRANSITION —— 只有首次出图推状态。
/**
 * dsh-pipeline · F19：前置站重交架构图
 * ============================================================================
 *     node tests/f19-diagram-resubmit-check.mjs
 *
 * 现场：任务在「架构图待主管确认」（arch_confirm）上，架构位再交一份 architecture_diagram ⇒
 * `hubAdvanceFor` 仍去发 `diagram_submitted`，而状态表上这条边只从 arch_drawing 出发 ⇒
 * `submitHandoff` ⑤ 预检 BAD_TRANSITION（图根本落不了盘）。`review.js` 的注释却说
 * "②b / ②c 两个确认点上可以再交一次" —— 文实不符；想改图只能靠主管 reject_diagram（限 1 次）。
 *
 * 钉住：
 *   ⑯-A arch_confirm 上重交 ⇒ 放行、状态不变、新的那份是最新一张图（②b / ②c 同理）
 *   ⑯-B 反向：arch_drawing 上首次出图 ⇒ 照旧推到 arch_confirm
 *   ⑯-C 反向：既有判据不松 —— 前置站已有编写产物照旧拒；不传状态的调用（推导用）照旧报 diagram_submitted
 *   （交付站逐字不变由 f13-hub-diagram-close-check 钉，本套不重复）
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness, fileSha256 } from './selftest-core.mjs'
import { ST } from '../lib/states.js'
import { hubAdvanceFor } from '../lib/store.js'
import { buildRoster } from '../lib/tiers.js'

const MAIN = 'f19-main'
const DIAG = 'f19-diag'

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
      const L = ['dsh-pipeline · F19：前置站重交架构图（缺陷 ⑯）', '='.repeat(78)]
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

const firstLine = (r) => String(r.text).split('\n')[0].slice(0, 200)

/** 一张枢纽单，停在架构位出图中（arch_drawing），主管已同意需求结论；盘上躺着两张图。 */
async function buildScene(h, { withDevToTest = false } = {}) {
  const opened = await callTool(h, 'pipeline_task_open', { requirement: 'F19 夹具：主管枢纽路线，前置站画图。' }, MAIN)
  if (opened.denied === true) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const r = h.tokens.mint({ taskId, role: 'diagrammer', seat: null, agentId: DIAG })
  const tk = r?.token ?? r?.rec?.token
  if (typeof tk !== 'string') throw new Error('夹具：铸 diagrammer 令牌失败')

  const built = buildRoster({
    tier: 'L5',
    reason: 'F19 夹具',
    judgedBy: 'planner',
    extraRoles: ['diagrammer'],
    writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: ['交付物'] }] },
  })
  if (built.ok !== true) throw new Error(`夹具：buildRoster 失败 ${built.error}`)

  const dgDir = join(h.projectRoot, '.pipeline', taskId, 'reports', 'diagrammer')
  await mkdir(dgDir, { recursive: true })
  const d1 = join(dgDir, 'f19-arch-1.md')
  const d2 = join(dgDir, 'f19-arch-2.md')
  await writeFile(d1, '# 前置站架构图（第一版）\n', 'utf8')
  await writeFile(d2, '# 前置站架构图（改过一版）\n', 'utf8')

  let n = 0
  const H = (kind, { av = null, payload = {}, from = 'orchestrator', to = 'main' } = {}) => ({
    handoff_id: `H-f19-${String(++n).padStart(2, '0')}`,
    task_id: taskId,
    kind,
    kind_zh: kind,
    from_role: from,
    from_seat: from,
    to_role: to,
    created_at: '2026-10-17T00:00:00Z',
    artifact_version: av,
    payload,
    content_hash: `f19-${n}`,
  })
  const analysis = H('requirement_analysis')
  const task = await h.store.get(taskId)
  task.roster = { ...built.roster }
  task.state = ST.ARCH_DRAWING
  task.hub = { enabled: true, standby: [], wake_points: [], wakes: [], diagram_redraws: 0, station_rejects: { need_agree: 0, test_confirm: 0, review_confirm: 0 }, reject_history: [] }
  task.handoffs = [
    analysis,
    H('station_confirm', { from: 'supervisor', payload: { task_id: taskId, station: 'need_agree', artifact_version: analysis.handoff_id, decision: 'ok', basis_refs: ['夹具'], basis_kind: 'evidence_digest', basis_digest: '夹具', reason: '夹具' } }),
    ...(withDevToTest ? [H('dev_to_test', { av: 'v1', from: 'writer' })] : []),
  ]
  task.history = []
  await writeFile(join(h.projectRoot, '.pipeline', taskId, 'task.json'), JSON.stringify(task, null, 2), 'utf8')
  h.indexTask(taskId, task)
  return { taskId, tk, d1, d2 }
}

const submitDiagram = (h, s, path, version = 'pre-plan') =>
  callTool(
    h,
    'pipeline_handoff',
    {
      task_id: s.taskId,
      kind: 'architecture_diagram',
      role_token: s.tk,
      payload: { task_id: s.taskId, based_on_artifact_version: version, diagram_path: path, html_sha256: fileSha256(path), produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: 'F19 夹具：自备产物' },
    },
    DIAG,
  )

const lastDiagram = async (h, taskId) => (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').pop() ?? null

/** 把单直接摆到某个前置站状态（只验"这个状态能不能重交"，不验怎么走到这里）。 */
async function moveTo(h, taskId, state) {
  const t = await h.store.get(taskId)
  t.state = state
  h.indexTask(taskId, t)
}

export async function runF19DiagramResubmitCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    const s = await buildScene(h)

    {
      const G = '⑯-B 反向：首次出图照旧推状态'
      const r = await submitDiagram(h, s, s.d1)
      const t = await h.store.get(s.taskId)
      rec.add(G, '★ arch_drawing 上首次交图 ⇒ 放行', r.denied !== true, firstLine(r))
      rec.add(G, '★★ 首次出图【必须】推进到 arch_confirm', t.state === ST.ARCH_CONFIRM, `state=${t.state}`)
    }

    {
      const G = '⑯-A arch_confirm 上重交'
      const before = await h.store.get(s.taskId)
      const n0 = before.handoffs.filter((x) => x.kind === 'architecture_diagram').length
      const r = await submitDiagram(h, s, s.d2)
      const t = await h.store.get(s.taskId)
      rec.add(G, '★★ arch_confirm 上重交 ⇒ 不再 BAD_TRANSITION', r.denied !== true, firstLine(r))
      rec.add(G, '★★ 状态不变（重交不推状态）', t.state === ST.ARCH_CONFIRM, `state=${t.state}`)
      const last = await lastDiagram(h, s.taskId)
      const n1 = t.handoffs.filter((x) => x.kind === 'architecture_diagram').length
      rec.add(G, '★ 新的那份落盘且是最新一张图', n1 === n0 + 1 && String(last?.payload?.diagram_path ?? '').endsWith('f19-arch-2.md'), `count ${n0}→${n1}\nlast=${last?.payload?.diagram_path}`)
      rec.add(G, '★ 没动主管的重画预算（不必先 reject_diagram 退回）', (t.hub?.diagram_redraws ?? 0) === 0, `diagram_redraws=${t.hub?.diagram_redraws}`)
    }

    {
      const G = '⑯-A′ ②b / ②c 两个确认点同理'
      for (const [state, path] of [[ST.ARCH_NEED_CONFIRM, s.d1], [ST.ARCH_RECONFIRM, s.d2]]) {
        await moveTo(h, s.taskId, state)
        const r = await submitDiagram(h, s, path)
        const t = await h.store.get(s.taskId)
        rec.add(G, `★ ${state} 上重交 ⇒ 放行且状态不变`, r.denied !== true && t.state === state, `${firstLine(r)}\nstate=${t.state}`)
      }
    }

    {
      const G = '⑯-C 反向：既有判据不松'
      const s2 = await buildScene(h, { withDevToTest: true })
      const r = await submitDiagram(h, s2, s2.d1)
      rec.add(G, '★ 前置站已有编写产物 ⇒ 照旧拒（HUB_DIAGRAM_AFTER_WRITE）', r.denied === true && String(r.text).includes('dev_to_test'), firstLine(r))
      rec.add(G, '★ 被拒后状态不动、图不落盘', (await h.store.get(s2.taskId)).state === ST.ARCH_DRAWING && (await lastDiagram(h, s2.taskId)) === null, `state=${(await h.store.get(s2.taskId)).state}`)
      const derived = hubAdvanceFor('architecture_diagram', {})
      rec.add(G, '★ 不传状态（e-route 推导用）⇒ 照旧报 diagram_submitted', derived?.event === 'diagram_submitted', JSON.stringify(derived))
      const delivery = hubAdvanceFor('architecture_diagram', {}, ST.PASSED)
      rec.add(G, '★ 交付站（passed）照旧不推状态', delivery === null, JSON.stringify(delivery))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF19DiagramResubmitCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
