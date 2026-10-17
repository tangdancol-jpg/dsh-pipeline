// 缺陷 ⑰ 回归：架构图交接物必须带 html_sha256，且两条产出路（diagram_deliver / self-provided）都与盘上产物核对。
/**
 * dsh-pipeline · F20：架构图的产物哈希必填且必核
 * ============================================================================
 *     node tests/f20-diagram-hash-check.mjs
 *
 * 现场：`html_sha256` 可空 ⇒ 不给也能交；给了也只在 `produced_by=diagram_deliver` 那一路核盘，
 * `self-provided` 那一路给错了照样放行 ⇒ "这张图就是盘上那个文件"无从判定，只剩自报的
 * `based_on_artifact_version` 一根字符串。
 *
 * 钉住：
 *   ⑰-A 缺 html_sha256 ⇒ 拒（两条产出路都拒）
 *   ⑰-B 哈希与盘上文件不符 ⇒ 拒（两条产出路都核，self-provided 不再放过）
 *   ⑰-C 反向：哈希一致 ⇒ 放行（两条路）；版本判据没删 —— 交付站绑旧版本照旧 HUB_DIAGRAM_VERSION_REQUIRED
 *   （关单闸 DIAGRAM_STALE 由 f13-hub-diagram-close-check 钉，本套不重复）
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'
import { ST } from '../lib/states.js'
import { buildRoster } from '../lib/tiers.js'

const MAIN = 'f20-main'
const DIAG = 'f20-diag'

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
      const L = ['dsh-pipeline · F20：架构图产物哈希必填且必核（缺陷 ⑰）', '='.repeat(78)]
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
const sha256File = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')

/** 一张枢纽单，停在架构位出图中（arch_drawing）；盘上躺着一张图和一份收据。 */
async function buildScene(h) {
  const opened = await callTool(h, 'pipeline_task_open', { requirement: 'F20 夹具：主管枢纽路线，前置站画图。' }, MAIN)
  if (opened.denied === true) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const r = h.tokens.mint({ taskId, role: 'diagrammer', seat: null, agentId: DIAG })
  const tk = r?.token ?? r?.rec?.token
  if (typeof tk !== 'string') throw new Error('夹具：铸 diagrammer 令牌失败')
  const built = buildRoster({
    tier: 'L5',
    reason: 'F20 夹具',
    judgedBy: 'planner',
    extraRoles: ['diagrammer'],
    writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: ['交付物'] }] },
  })
  if (built.ok !== true) throw new Error(`夹具：buildRoster 失败 ${built.error}`)

  const dgDir = join(h.projectRoot, '.pipeline', taskId, 'reports', 'diagrammer')
  await mkdir(dgDir, { recursive: true })
  const diagram = join(dgDir, 'f20-arch.html')
  const receipt = join(dgDir, 'f20-receipt.json')
  await writeFile(diagram, '<!doctype html><title>F20 架构图</title>\n', 'utf8')
  await writeFile(receipt, JSON.stringify({ receipt_id: 'R-F20' }), 'utf8')

  const task = await h.store.get(taskId)
  task.roster = { ...built.roster }
  task.state = ST.ARCH_DRAWING
  task.hub = { enabled: true, standby: [], wake_points: [], wakes: [], diagram_redraws: 0, station_rejects: { need_agree: 0, test_confirm: 0, review_confirm: 0 }, reject_history: [] }
  task.handoffs = []
  task.history = []
  await writeFile(join(h.projectRoot, '.pipeline', taskId, 'task.json'), JSON.stringify(task, null, 2), 'utf8')
  h.indexTask(taskId, task)
  return { taskId, tk, diagram, receipt, hash: await sha256File(diagram) }
}

const submit = (h, s, extra) => {
  const deliver = extra.produced_by === 'diagram_deliver'
  const payload = {
    task_id: s.taskId,
    based_on_artifact_version: 'pre-plan',
    diagram_path: s.diagram,
    produced_by: 'self-provided',
    covered_modules: ['m1'],
    degraded: !deliver,
    ...(deliver ? { receipt_path: s.receipt, receipt_id: 'R-F20' } : { degraded_reason: 'F20 夹具：自备产物' }),
    ...extra,
  }
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
  return callTool(h, 'pipeline_handoff', { task_id: s.taskId, kind: 'architecture_diagram', role_token: s.tk, payload }, DIAG)
}

const diagramCount = async (h, taskId) => (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').length

export async function runF20DiagramHashCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    const s = await buildScene(h)
    const BAD = 'deadbeef'.repeat(8)

    {
      const G = '⑰-A 缺 html_sha256 ⇒ 拒'
      for (const by of ['self-provided', 'diagram_deliver']) {
        const r = await submit(h, s, { produced_by: by, html_sha256: undefined })
        rec.add(G, `★★ ${by} 不给哈希 ⇒ 拒，原文点名 html_sha256`, r.denied === true && String(r.text).includes('html_sha256'), firstLine(r))
      }
      rec.add(G, '★ 被拒的都没落盘', (await diagramCount(h, s.taskId)) === 0, `count=${await diagramCount(h, s.taskId)}`)
    }

    {
      const G = '⑰-B 哈希与盘上文件不符 ⇒ 拒'
      for (const by of ['self-provided', 'diagram_deliver']) {
        const r = await submit(h, s, { produced_by: by, html_sha256: BAD })
        rec.add(G, `★★ ${by} 哈希不符 ⇒ 拒（DIAGRAM_HASH_MISMATCH）`, r.denied === true && String(r.text).includes('html_sha256 与磁盘上的产物对不上'), firstLine(r))
      }
      rec.add(G, '★ 被拒的都没落盘、状态没动', (await diagramCount(h, s.taskId)) === 0 && (await h.store.get(s.taskId)).state === ST.ARCH_DRAWING, `state=${(await h.store.get(s.taskId)).state}`)
    }

    {
      const G = '⑰-C 反向：哈希一致放行，版本判据没删'
      const ok1 = await submit(h, s, { produced_by: 'self-provided', html_sha256: s.hash })
      rec.add(G, '★★ self-provided 哈希一致 ⇒ 放行', ok1.denied !== true, firstLine(ok1))
      const ok2 = await submit(h, s, { produced_by: 'diagram_deliver', html_sha256: s.hash.toUpperCase() })
      rec.add(G, '★ diagram_deliver 哈希一致（大写十六进制也认）⇒ 放行', ok2.denied !== true, firstLine(ok2))
      const last = (await h.store.get(s.taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
      rec.add(G, '★ 落盘的交接物带着这份哈希（关单 / 状态面能取到）', String(last?.payload?.html_sha256 ?? '').toLowerCase() === s.hash, String(last?.payload?.html_sha256))
      const stale = h.store.checkHandoffAgainstState(
        { id: 'T-f20-deliv', state: ST.PASSED, hub: { enabled: true }, handoffs: [{ kind: 'dev_to_test', artifact_version: 'v2' }] },
        'architecture_diagram',
        { based_on_artifact_version: 'v1', html_sha256: s.hash },
      )
      rec.add(G, '★★ 交付站绑旧版本（哈希再对也没用）⇒ 照旧 HUB_DIAGRAM_VERSION_REQUIRED', stale.ok !== true && stale.code === 'HUB_DIAGRAM_VERSION_REQUIRED', stale.code ?? 'ok')
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
  runF20DiagramHashCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
