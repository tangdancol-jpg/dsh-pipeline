/**
 * dsh-pipeline · tests/f13-hub-diagram-close-check.mjs
 * ============================================================================
 * ★★ **主管枢纽路线下「先画图 → 后写文件」的单，修前关不掉单**（L5 关单死锁）。
 *
 * 真机现场（`T-20261016-fullai`，L5，已通过）：
 *   · 只有**一份** `architecture_diagram`（`H-9553298ff39ea815`，声明 `v1`），
 *     它是在**计划之前、编写之前**画的 —— 枢纽路线上架构图只有那一个合法位置；
 *   · 编写交付带的是 **v2**（`dev_to_test` 只此一份，av=v2）⇒ 当前有效制品 = v2；
 *   · `pipeline_close` 连拒三次，原文：「架构图针对的是制品 v1，当前有效制品是 v2」；
 *   · 架构图位**想**按 v2 重交，但交不出来 —— 它最后交的是
 *     `clarification_request`（`H-523d76624f4e1265`），不是第二份图。
 *
 * 根因是**流程顺序冲突**，不是个例：
 *   `store/review.js` 的枢纽分支把 `architecture_diagram` 的合法状态面**整体前移**到
 *   计划之前（前置站），而 `store/precondition.js` 的关单闸要求"图必须对应**写完之后的
 *   最终版本**"。⇒ 任何走这条路线、且写完产生新版本的单，结构上都不可能满足。
 *
 * 本套钉三件事（**先红后绿**：修前 ②③ 必红）：
 *   ① 交付站重交：图可以在编写完成之后重交，但**必须绑当前有效制品版本**（判据，不是声明）；
 *   ② 真·过期的图仍必须被关单闸拒（**不许把闸门改废**）；
 *   ③ 幂等：同一版本重复重交不产生第二条有效记录。
 *
 * ⚠️ 夹具形状的诚实说明：本单的"已通过"现场是**按真机 handoff 序列构造**的
 *   （不重跑整条 L5 链 —— 那要拉起全部角色）；但被检验的两个动作
 *   （重交图 / 关单）走的都是**真工具 + 真守门 + 真状态机 + 真判据**。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/f13-hub-diagram-close-check
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'
import { ST } from '../lib/states.js'
import { buildRoster } from '../lib/tiers.js'

const MAIN = 'f13-main'
const SUP = 'f13-sup'
const ORCH = 'f13-orch'
const DIAG = 'f13-diag'

function createRecorder() {
  const items = []
  return {
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
      const L = ['dsh-pipeline · 枢纽路线下的架构图与关单（先画后写 ⇒ 关不掉单）', '='.repeat(78)]
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

/** 拒绝原文里有没有那些要点（拒绝要**指名**，不能只说"不行"）。 */
const says = (r, ...needles) => needles.every((n) => String(r.text).includes(n))
const firstLine = (r) => String(r.text).split('\n')[0].slice(0, 200)

// ---------------------------------------------------------------------------
// 夹具：按真机 T-20261016-fullai 的 handoff 序列构造一张「已通过」的枢纽单
// ---------------------------------------------------------------------------

async function buildScene(h) {
  const opened = await callTool(h, 'pipeline_task_open', { requirement: '夹具：主管枢纽路线 + 先画架构图 → 后写文件（写完产生 v2）' }, MAIN)
  if (opened.denied === true) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id

  const mint = (role, agentId) => {
    const r = h.tokens.mint({ taskId, role, seat: null, agentId })
    const tk = r?.token ?? r?.rec?.token
    if (typeof tk !== 'string') throw new Error(`夹具：铸 ${role} 令牌失败`)
    return tk
  }
  const TK = { main: mint('main', MAIN), sup: mint('supervisor', SUP), orch: mint('orchestrator', ORCH), diag: mint('diagrammer', DIAG) }

  // L5 清单（真机 shape：含 diagrammer / release / docs / performance）
  const built = buildRoster({
    tier: 'L5',
    reason: '夹具：L5 全 AI 单',
    judgedBy: 'planner',
    extraRoles: ['diagrammer'],
    writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: ['交付物'] }] },
  })
  if (built.ok !== true) throw new Error(`夹具：buildRoster 失败 ${built.error}`)

  // 产物必须真的躺在盘上（`checkDiagramDelivery` 的既有判据）
  const dgDir = join(h.projectRoot, '.pipeline', taskId, 'reports', 'diagrammer')
  await mkdir(dgDir, { recursive: true })
  const diagramV1 = join(dgDir, 'diagrammer-design-arch.md')
  const diagramV2 = join(dgDir, 'diagrammer-design-arch-current.md')
  await writeFile(diagramV1, '# 设计态架构图（编写之前画的，声明 v1）\n', 'utf8')
  await writeFile(diagramV2, '# 交付站重交的同一张设计态图（声明当前制品）\n', 'utf8')
  const scanRef = join(h.projectRoot, '.pipeline', taskId, 'reports', 'security-scan-fixture.json')
  await writeFile(scanRef, '{"fixture":true}\n', 'utf8')

  let n = 0
  const H = (kind, { av = null, payload = {}, from = 'writer', to = 'main' } = {}) => ({
    handoff_id: `H-fixture-${String(++n).padStart(2, '0')}`,
    task_id: taskId,
    kind,
    kind_zh: kind,
    from_role: from,
    from_seat: from,
    to_role: to,
    created_at: '2026-10-16T15:14:53Z',
    artifact_version: av,
    payload,
    content_hash: `fixture-${n}`,
  })
  const SC = (station, av, from) =>
    H('station_confirm', {
      av,
      from,
      payload: { task_id: taskId, station, artifact_version: av, decision: 'ok', basis_refs: [`${av}#fixture`], basis_kind: 'evidence_digest', basis_digest: '夹具：站点确认', reason: '夹具' },
    })

  const analysis = H('requirement_analysis', { from: 'orchestrator' })
  /** ★ 真机那一份：编写之前画的图，前向声明 v1。 */
  const dg1 = H('architecture_diagram', {
    from: 'diagrammer',
    to: 'main|reviewer',
    payload: { task_id: taskId, based_on_artifact_version: 'v1', diagram_path: diagramV1, produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: '夹具：自备产物' },
  })

  const task = await h.store.get(taskId)
  task.roster = { ...built.roster }
  task.state = ST.PASSED
  task.hub = { enabled: true, standby: [], wake_points: [], wakes: [], diagram_redraws: 0, station_rejects: { need_agree: 0, test_confirm: 0, review_confirm: 0 }, reject_history: [] }
  task.handoffs = [
    analysis,
    SC('need_agree', analysis.handoff_id, 'supervisor'),
    // ★★ 顺序即现场：图在**编写之前**交，编写交付（v2）在它之后。
    dg1,
    SC('diagram_confirm', dg1.handoff_id, 'supervisor'),
    SC('arch_need_confirm', dg1.handoff_id, 'orchestrator'),
    SC('arch_reconfirm', dg1.handoff_id, 'supervisor'),
    H('plan', { from: 'planner' }),
    H('dev_to_test', { av: 'v2', from: 'writer' }),
    H('test_to_review', { av: 'v2', from: 'tester' }),
    SC('test_confirm', 'v2', 'supervisor'),
    SC('test_confirm', 'v2', 'orchestrator'),
    H('review_verdict', {
      av: 'v2',
      from: 'reviewer',
      payload: {
        task_id: taskId, artifact_version: 'v2', conclusion: 'OK', release_approved: true, final_delivery_note: '夹具', risk_notes: [],
        security: { attestation: 'clean', checks_ref: [scanRef], local_leak: { checked: true, checks_ref: [scanRef] }, network: { checked: true, checks_ref: [scanRef] } },
      },
    }),
    SC('review_confirm', 'v2', 'supervisor'),
    SC('review_confirm', 'v2', 'orchestrator'),
    H('security_review', { from: 'security', payload: { task_id: taskId, blocked: false, severity: 'low', findings: [] } }),
    H('release_plan', { from: 'release' }),
    H('docs_note', { from: 'docs' }),
    H('perf_report', { from: 'performance' }),
  ]
  task.history = []
  await writeFile(join(h.projectRoot, '.pipeline', taskId, 'task.json'), JSON.stringify(task, null, 2), 'utf8')
  h.indexTask(taskId, task)
  return { taskId, TK, diagramV1, diagramV2, scanRef }
}

/** 重交一份架构图（真工具）。 */
async function resubmit(h, taskId, TK, diagramPath, declaredVersion) {
  return callTool(
    h,
    'pipeline_handoff',
    {
      task_id: taskId,
      kind: 'architecture_diagram',
      role_token: TK.diag,
      payload: {
        task_id: taskId,
        based_on_artifact_version: declaredVersion,
        diagram_path: diagramPath,
        produced_by: 'self-provided',
        covered_modules: ['m1'],
        degraded: true,
        degraded_reason: '夹具：自备产物',
      },
    },
    DIAG,
  )
}

const countDiagrams = async (h, taskId) => (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').length

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runF13HubDiagramCloseCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    const { taskId, TK, diagramV1, diagramV2 } = await buildScene(h)

    // =======================================================================
    // 【A】现场还原：先画图 → 后写文件 ⇒ 当前制品 v2，图声明 v1
    // =======================================================================
    {
      const t = await h.store.get(taskId)
      const kinds = t.handoffs.map((x) => x.kind)
      rec.add('A 现场还原', '★ 任务落在「已通过」且**图排在编写交付之前**（先画后写）', t.state === ST.PASSED && kinds.indexOf('architecture_diagram') < kinds.indexOf('dev_to_test'), `state=${t.state}\n图 idx=${kinds.indexOf('architecture_diagram')} / dev_to_test idx=${kinds.indexOf('dev_to_test')}`)
      // ★ 当前有效制品**问 store 自己**（不在这份测试里重写一遍判据）。
      const cur = (await h.store.status({ taskId })).artifact_version
      const dg = t.handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
      rec.add('A 现场还原', '★★ 当前有效制品 = v2，而唯一那份图声明的是 v1（真机 DIAGRAM_STALE 的形状）', cur === 'v2' && dg.payload.based_on_artifact_version === 'v1', `currentArtifactVersion=${cur}  图声明=${dg.payload.based_on_artifact_version}`)
    }

    // =======================================================================
    // 【B】★ 反向控制①：真·过期的图 ⇒ 关单**必须被拒**（改前改后都拒）
    // =======================================================================
    {
      const close = await callTool(h, 'pipeline_close', { task_id: taskId, role_token: TK.main, note: '先试一次' }, MAIN)
      rec.add(
        'B 反向控制',
        '★★ 最新那张图仍是 v1 ⇒ 关单被拒，且原文指名「架构图针对的是制品 v1 / 当前有效制品是 v2」',
        close.denied === true && says(close, '架构图', 'v1', 'v2'),
        firstLine(close),
      )
    }

    // =======================================================================
    // 【C】核心：交付站重交（改前红 ⇒ 改后绿）
    // =======================================================================
    {
      const wrong = await resubmit(h, taskId, TK, diagramV2, 'v1')
      rec.add(
        'C 交付站重交',
        '★★ 交付站重交**必须绑当前有效制品**：声明 v1（≠ 当前 v2）⇒ 拒，且原文说清"要绑当前版本"',
        wrong.denied === true && says(wrong, 'v2'),
        firstLine(wrong),
      )

      const ok = await resubmit(h, taskId, TK, diagramV2, 'v2')
      rec.add('C 交付站重交', '★★ 绑当前制品 v2 重交 ⇒ **放行**（修前：被枢纽分支按"跳步"拒掉）', ok.denied !== true, firstLine(ok))

      const t = await h.store.get(taskId)
      rec.add('C 交付站重交', '★ 重交图**不推动状态**（它更新"当前是哪张图"，不是一步状态迁移）', t.state === ST.PASSED, `state=${t.state}`)

      const close = await callTool(h, 'pipeline_close', { task_id: taskId, role_token: TK.main, note: '图已对齐当前版本' }, MAIN)
      rec.add('C 交付站重交', '★★★ 再关单 ⇒ **通过**（这一条就是"先画后写的单也能关单"）', close.denied !== true, firstLine(close))
      rec.add('C 交付站重交', '★ 关单收束：状态 = 已关闭，且放行依据记的是当前版本的审核 OK', (await h.store.get(taskId)).state === ST.CLOSED, `state=${(await h.store.get(taskId)).state}`)
    }

    // =======================================================================
    // 【D】幂等：同一版本重复重交 ⇒ 不产生第二条有效记录
    // =======================================================================
    //
    // ⚠️ 关单会回收令牌，所以幂等那一条跑在**另一张还没关单的**单上（同一夹具、不同任务）。
    {
      const s = await buildScene(h)
      const ok = await resubmit(h, s.taskId, s.TK, s.diagramV2, 'v2')
      const before = await countDiagrams(h, s.taskId)
      const again = await resubmit(h, s.taskId, s.TK, s.diagramV2, 'v2')
      const after = await countDiagrams(h, s.taskId)
      const t = await h.store.get(s.taskId)
      const chk = h.store.checkHandoffAgainstState(t, 'architecture_diagram', { based_on_artifact_version: 'v2' })
      rec.add('D 幂等', '★ 第一次重交放行、第二次被拒（判据码 = HUB_DIAGRAM_ALREADY_CURRENT）', ok.denied !== true && again.denied === true && chk.ok !== true && chk.code === 'HUB_DIAGRAM_ALREADY_CURRENT', `again=${firstLine(again)}\nstore 判据码=${chk.code}`)
      rec.add('D 幂等', '★★ 记录数没变（第一份 v1 图 + 重交的那一份 = 2，重复重交**不落第二条**）', before === 2 && after === 2, `before=${before} after=${after}`)
    }

    // =======================================================================
    // 【E】闸门没被改废：既有判据逐条对照（前置站语义 / 非枢纽任务弃权）
    // =======================================================================
    {
      const pre = h.store.checkHandoffAgainstState({ id: 'T-f13-prep', state: ST.ARCH_DRAWING, hub: { enabled: true }, handoffs: [] }, 'architecture_diagram', { based_on_artifact_version: 'pre-plan' })
      rec.add('E 既有判据', '★ 前置站（架构位出图中）交图仍放行 —— 前移那一站的语义一个字没改', pre.ok === true, JSON.stringify(pre))

      const after = h.store.checkHandoffAgainstState({ id: 'T-f13-prep', state: ST.ARCH_DRAWING, hub: { enabled: true }, handoffs: [{ kind: 'dev_to_test', artifact_version: 'v1' }] }, 'architecture_diagram', { based_on_artifact_version: 'v1' })
      rec.add('E 既有判据', '★★ 前置站上已有编写产物 ⇒ 仍拒（HUB_DIAGRAM_AFTER_WRITE）', after.ok !== true && after.code === 'HUB_DIAGRAM_AFTER_WRITE', `code=${after.code}`)

      const plain = h.store.checkHandoffAgainstState({ id: 'T-f13-plain', state: ST.PASSED, handoffs: [{ kind: 'dev_to_test', artifact_version: 'v2' }] }, 'architecture_diagram', { based_on_artifact_version: 'v1' })
      rec.add('E 既有判据', '★ 未启用枢纽的任务**不受新判据影响**（既有表原样：交付站不查绑定）', plain.ok === true, JSON.stringify(plain))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/f13-hub-diagram-close-check.mjs`
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /f13-hub-diagram-close-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runF13HubDiagramCloseCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
