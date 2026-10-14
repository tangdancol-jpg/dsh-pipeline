/**
 * dsh-pipeline · tests/station-reject-check.mjs
 * ============================================================================
 * **站点「否掉」的四条回边**（T-20261011-56a37e 补齐 · 用户原话的下半条分支）
 *
 * 用户原话：「…如果**同意**…如果**否掉**…」—— 两条分支都要有。
 * 补之前的状态（实读代码得出，本套把它钉住）：
 *   · ② 道 **有**回边（`supervisor_reject_diagram`，架构位重画，限 1 次）；
 *   · ①③④ 三道 **没有** —— 状态机上从 `supervising` / `ready_review` / `passed`
 *     各只有一条出边，且那条都要求"确认方点头" ⇒ 主管在那三站说"不满足"时
 *     无路可走（只剩 `block` / `cancel`）。
 *   · ⑤ 道不是确认站点（没有确认方），它是**交付**那一步本身。
 *
 * 本套要证的六件事：
 *   【A】正例·①：否掉 ⇒ **能走完回边**（回到需求位 = `analyzing`）+ 记录 + 审计 + 账本
 *   【B】反例·①：没记录不许退 / 预算用尽 / 越权代发（main 与需求位）/ 非枢纽任务
 *   【C】正例·③：否掉 ⇒ 回到测试位（`returned_to_test`），且**否掉即作废**（旧确认不再放行）
 *   【D】正例·④：否掉 ⇒ 回到审核位（`reviewing`），且同样作废旧确认
 *   【E】反例·③④：预算用尽（记录**根本交不上来**）/ 没记录
 *   【F】⑤：**不是确认站点**，且只读导出如实标明（不靠说明文档自证）
 *   【G】同构性：四条回边与 ② 道逐项对齐（同一张表 / 同一个 by / 同一套预算 / 同一份审计）
 *
 * 全程临时目录、跑完即删；不建真实会话、不监听端口。
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/station-reject-check
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHarness, disposeHarness, callTool, cleanSecurity } from './selftest-core.mjs'
import { HUB_HANDOFF_CONFIRM_STATIONS, HUB_STATIONS, HUB_STATION_REJECT_BUDGET, HUB_STATION_REJECT_EVENTS, ST, TRANSITIONS } from '../lib/states.js'
import { HANDOFF_SCHEMAS } from '../lib/handoff.js'
import { boundaryManifest } from '../lib/boundaries.js'
import { buildRoster } from '../lib/tiers.js'

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
      L.push('dsh-pipeline · 站点「否掉」的四条回边（主管枢纽 · 用户原话的下半条分支）')
      L.push('='.repeat(78))
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('')
          L.push(`【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('')
      L.push('='.repeat(78))
      L.push(`总计：${this.passed}/${this.total} 通过`)
      L.push('='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 一句拒绝原文里有没有那些要点（拒绝要**指名**，不能只说"不行"）。 */
const says = (r, ...needles) => needles.every((n) => String(r.text).includes(n))

/** 计划交接物的夹具（字段齐备，免得字段校验抢先拦掉真正要判的那条）。 */
const planPayload = (taskId) => ({
  task_id: taskId,
  plan_steps: ['s'],
  layers: [],
  self_check: { verdict: 'ok', checked: ['x'], gaps: [] },
  plan_reason: 'r',
  change_scope: [{ id: 'CS1', path: '.', action: 'modify', why: 'w' }],
  forbidden: ['不重构'],
  role_boundaries: [{ role: 'writer', only: ['写'], not: ['跑测试'] }],
  role_scope: { will_do: ['计划'], will_not_do: ['写实现'] },
})

const edgeOf = (event) => TRANSITIONS.find((t) => t.event === event) ?? null

export async function runStationRejectCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    await drive(h, rec)
  } catch (err) {
    // 夹具执行中途抛异常**不许静默**：如实记一条 ✗ 并把原文留在 detail 里。
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(h, rec) {
  // =========================================================================
  // 夹具：开单 → 名单登记主管 → 主管发起 → 需求位交结论（停在「主管受理中」）
  // =========================================================================
  const open = await callTool(h, 'pipeline_task_open', { requirement: '补齐主管枢纽的「否掉」分支：四条回边 + 主管的 reject 类动作。' }, 'sess-main')
  const taskId = open.value.task_id

  const mint = (role, agentId) => {
    const r = h.tokens.mint({ taskId, role, seat: null, agentId })
    const tk = r?.token ?? r?.rec?.token
    if (typeof tk !== 'string') throw new Error(`夹具：铸 ${role} 令牌失败：${JSON.stringify(r)}`)
    return tk
  }
  const TK = {
    main: mint('main', 'sess-main'),
    sup: mint('supervisor', 'sess-sup'),
    orch: mint('orchestrator', 'sess-orch'),
    diag: mint('diagrammer', 'sess-diag'),
    arch: mint('architect', 'sess-arch'),
    plan: mint('planner', 'sess-plan'),
    tester: mint('tester', 'sess-tester'),
    writer: mint('writer', 'sess-writer'),
    reviewer: mint('reviewer', 'sess-reviewer'),
  }
  const AG = {
    main: 'sess-main', sup: 'sess-sup', orch: 'sess-orch', diag: 'sess-diag', arch: 'sess-arch',
    plan: 'sess-plan', tester: 'sess-tester', writer: 'sess-writer', reviewer: 'sess-reviewer',
  }
  const state = async () => (await h.store.get(taskId)).state
  const taskNow = async () => await h.store.get(taskId)
  const st = async () => (await taskNow()).state
  const pre = async (name, input = {}) => await h.store.checkPrecondition(await taskNow(), name, input)

  const built = buildRoster({
    tier: 'L3',
    reason: '夹具',
    judgedBy: 'planner',
    writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: [] }] },
  })
  const task0 = await h.store.get(taskId)
  task0.roster = { ...built.roster, conversations: [...built.roster.conversations, 'supervisor'] }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${h.projectRoot}/.pipeline/${taskId}/task.json`, JSON.stringify(task0, null, 2), 'utf8')
  h.indexTask(taskId, task0)

  const init = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '夹具：主管发起三席', role_token: TK.sup }, AG.sup)
  if (init.denied === true) throw new Error(`夹具：主管发起失败：\n${init.text}`)

  const a1 = await callTool(h, 'pipeline_orchestrate', { task_id: taskId, task_card: { goal: '补齐否掉分支' }, acceptance: ['验收1'], test_points: ['要点1'], boundaries: ['边界1'], unclear_points: [], analysis_reason: '依据用户原话', role_scope: { will_do: ['分析'], will_not_do: ['分配'] }, role_token: TK.orch }, AG.orch)
  if (a1.denied === true) throw new Error(`夹具：需求位交结论失败：\n${a1.text}`)
  rec.add('A 夹具', '★ 夹具到位：需求结论已交主管，任务停在「主管受理中」（第①道待判）', (await st()) === ST.SUPERVISING, await st())

  const analysis1 = (await taskNow()).handoffs.filter((x) => x.kind === 'requirement_analysis').pop()

  // =========================================================================
  // 【B】反例·①：越权代发 / 没记录不许退 / 非枢纽任务
  // =========================================================================
  {
    const byMain = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'supervisor_reject_need', note: '代发', role_token: TK.main }, AG.main)
    rec.add('B 反例·①', '★★ main 代发"否掉"被拒（`by:[supervisor]` 是第二道，主对话不许替主管否掉）', byMain.denied === true, byMain.text.split('\n')[0])

    const byOrch = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'supervisor_reject_need', note: '需求位自己否自己', role_token: TK.orch }, AG.orch)
    rec.add('B 反例·①', '★★ 需求位代发"否掉"同样被拒（需求位**没有**推进/退回状态的能力 —— 不新增越权放行）', byOrch.denied === true, byOrch.text.split('\n')[0])

    // ★ 主管连 `pipeline_transition` 都调不动（工具-角色表 = [main, human]）⇒
    //   否掉**只有** `pipeline_supervise` 一条路可走，而那条路必然先落一份带证据的记录。
    //   这是"不许静默否掉"的结构性保证，比任何一句约定都硬。
    const supTrans = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'supervisor_reject_need', note: '绕道否掉', role_token: TK.sup }, AG.sup)
    rec.add('B 反例·①', '★★ 主管连 `pipeline_transition` 都调不动（工具-角色表 = [main, human]）⇒ 否掉**没有绕道**，只能走 `pipeline_supervise`', supTrans.denied === true && supTrans.layer === 'guard', `layer=${supTrans.layer} ${supTrans.text.split('\n')[0]}`)

    const noRec = await h.store.checkPrecondition(await taskNow(), 'hub_station_reject', { event: 'supervisor_reject_need' })
    rec.add('B 反例·①', '★★ **没有"带原因与证据"的否掉记录 ⇒ 回边过不去**（判据原文 = HUB_STATION_REJECT_NO_RECORD，明写"不许静默"）', noRec.ok !== true && String(noRec.code) === 'HUB_STATION_REJECT_NO_RECORD' && String(noRec.error).includes('不许静默'), `code=${noRec.code} ${String(noRec.error).split('\n')[0]}`)
    rec.add('B 反例·①', '★ 反例跑完状态**没动**（被拒的动作不留半截状态）', (await st()) === ST.SUPERVISING, await st())

    // ★ 非枢纽任务：三条回边落在与既有链共用的状态上（ready_review / passed），必须弃权。
    const fresh = await callTool(h, 'pipeline_task_open', { requirement: '未启用枢纽的对照任务。' }, 'sess-main')
    const freshTask = await h.store.get(fresh.value.task_id)
    const g = await h.store.checkPrecondition(freshTask, 'hub_station_reject_budget', { station: HUB_STATIONS.NEED_AGREE })
    rec.add('B 反例·①', '★★ **未启用枢纽**的任务上否掉判据弃权（拒绝原文 = HUB_NOT_ENABLED）—— 既有链一个字节没动', g.ok !== true && String(g.code) === 'HUB_NOT_ENABLED', `code=${g.code}`)
    const g2 = await h.store.checkPrecondition(freshTask, 'hub_station_reject_budget', { station: HUB_STATIONS.CLOSEOUT })
    rec.add('B 反例·①', '★★ 第⑤道（关单交付）**不是确认站点** ⇒ 连"否掉"这条分支都没有（判据原文 = HUB_REJECT_NOT_A_STATION）', g2.ok !== true && String(g2.code) === 'HUB_REJECT_NOT_A_STATION', `code=${g2.code}`)
  }

  // =========================================================================
  // 【A】正例·①：否掉 ⇒ 走完回边，退回需求位
  // =========================================================================
  {
    const rj = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_need', reason: '需求结论里"验收标准"和用户原话对不上，退回重做', basis_refs: [`${analysis1.handoff_id}@${analysis1.content_hash}`], basis_digest: '结论 1 份；验收条目 1 条；与用户原话逐句比对后有 1 处不一致。', role_token: TK.sup }, AG.sup)
    rec.add('A 正例·①', '★★ **否掉走完了回边**：状态落到「需求分析中」（退回需求位重做，不是卡死、也不用 block）', rj.denied !== true && (await st()) === ST.ANALYZING, `${await st()} ${rj.text.split('\n')[0]}`)

    const t = await taskNow()
    const ngs = (t.handoffs ?? []).filter((x) => x.kind === 'station_confirm' && x.payload?.decision === 'ng')
    rec.add('A 正例·①', '★★ 否掉**带原因与证据**（一份 `station_confirm{decision:ng}`：reason 与 basis_refs 都在，且是主管交的）', ngs.length === 1 && ngs[0].from_role === 'supervisor' && String(ngs[0].payload?.reason ?? '').length > 0 && Array.isArray(ngs[0].payload?.basis_refs) && ngs[0].payload.basis_refs.length > 0, JSON.stringify(ngs.map((x) => ({ by: x.from_role, station: x.payload?.station, reason: String(x.payload?.reason ?? '').slice(0, 40), refs: x.payload?.basis_refs?.length }))))
    rec.add('A 正例·①', '★ 记录绑的是**被否掉那一份**（artifact_version = 需求结论的 handoff_id）', ngs[0]?.payload?.artifact_version === analysis1.handoff_id, `${ngs[0]?.payload?.artifact_version} vs ${analysis1.handoff_id}`)

    rec.add('A 正例·①', '★★ 账本留痕（`hub.reject_history`：哪一站 · 谁 · 为什么 · 退回哪儿）', (t.hub?.reject_history ?? []).some((x) => x.station === HUB_STATIONS.NEED_AGREE && x.by === 'supervisor' && x.back_to === ST.ANALYZING && String(x.reason ?? '').length > 0), JSON.stringify(t.hub?.reject_history))
    rec.add('A 正例·①', '★ 站点计数 +1（`hub.station_rejects.need_agree = 1`，上限 1）', t.hub?.station_rejects?.[HUB_STATIONS.NEED_AGREE] === 1 && t.hub?.reject_budget === HUB_STATION_REJECT_BUDGET, JSON.stringify(t.hub?.station_rejects))

    const audit = readFileSync(join(h.projectRoot, h.config.artifactDirName, taskId, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const line = audit.filter((x) => x.action === 'transition:supervisor_reject_need').pop()
    rec.add('A 正例·①', '★★ 落**同一份审计**（`audit.jsonl` 有 `transition:supervisor_reject_need`，actor = supervisor，note = 原因）', line !== undefined && line.actor === 'supervisor' && String(line.note ?? '').includes('验收标准'), JSON.stringify(line ?? null).slice(0, 240))

    const view = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    const s1 = (view.value?.hub?.stations ?? []).find((x) => x.station === HUB_STATIONS.NEED_AGREE)
    rec.add('A 正例·①', '★★ 否掉**被主对话看得见**（`pipeline_status` 的站点视图里列出这一条否掉记录，不必翻 handoffs）', Array.isArray(s1?.rejects) && s1.rejects.length === 1 && s1.rejects[0].from_role === 'supervisor' && s1.rejects_used === 1 && s1.rejects_budget === 1, JSON.stringify(s1))
  }

  // =========================================================================
  // 【E】反例·①：预算用尽（限 1 次 ⇒ 升人工）
  // =========================================================================
  {
    // 先把需求位重做的那一份交上来（否则连"哪一份"都没有）。
    const a2 = await callTool(h, 'pipeline_orchestrate', { task_id: taskId, task_card: { goal: '补齐否掉分支（重做）' }, acceptance: ['验收1'], test_points: ['要点1'], boundaries: ['边界1'], unclear_points: [], analysis_reason: '按主管的意见重做', role_scope: { will_do: ['分析'], will_not_do: ['分配'] }, role_token: TK.orch }, AG.orch)
    rec.add('E 反例·预算', '★ 退回之后需求位重交结论 ⇒ 又停在「主管受理中」（回边是**回路**，不是终点）', a2.denied !== true && (await st()) === ST.SUPERVISING, await st())

    const before = (await taskNow()).handoffs.filter((x) => x.kind === 'station_confirm' && x.payload?.decision === 'ng').length
    const rj2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_need', reason: '还是不行', basis_refs: ['HO-x@hash'], basis_digest: '结论 1 份。', role_token: TK.sup }, AG.sup)
    rec.add('E 反例·预算', '★★ 预算 = 1：**第二次否掉被拒**，且拒绝原文指向「升给用户」（照 ② 道重画那一套）', rj2.denied === true && says(rj2, '预算', '用户'), rj2.text.split('\n')[0])
    const after = (await taskNow()).handoffs.filter((x) => x.kind === 'station_confirm' && x.payload?.decision === 'ng').length
    rec.add('E 反例·预算', '★★ 被拒的那次**连否掉记录都交不上来**（预算判定提前到提交这一步 ⇒ 盘上不留半截状态）', after === before, `before=${before} after=${after}`)
    rec.add('E 反例·预算', '★ 状态没动（仍在「主管受理中」）', (await st()) === ST.SUPERVISING, await st())
  }

  // =========================================================================
  // 继续把单推到站点③（写完整条枢纽链：①确认 → ②确认 → 计划 → 编写 → 测试）
  // =========================================================================
  {
    // --- 第①道：需求位那一份确认 ---
    const analysis2 = (await taskNow()).handoffs.filter((x) => x.kind === 'requirement_analysis').pop()
    const o1 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: { task_id: taskId, station: HUB_STATIONS.NEED_AGREE, artifact_version: analysis2.handoff_id, decision: 'ok', basis_refs: [`${analysis2.handoff_id}@${analysis2.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求结论 1 份；验收 1 条；与用户原话一致。', reason: '需求位同意' } }, AG.orch)
    if (o1.denied === true) throw new Error(`夹具：需求位第①道确认失败：\n${o1.text}`)
    const s1 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_STATIONS.NEED_AGREE, artifact_version: analysis2.handoff_id, decision: 'ok', basis_refs: [`${analysis2.handoff_id}@${analysis2.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求结论 1 份；验收 1 条。', reason: '主管同意需求结论' } }, AG.sup)
    if (s1.denied === true) throw new Error(`夹具：主管第①道确认失败：\n${s1.text}`)

    const hr = await callTool(h, 'pipeline_human_request', { task_id: taskId, reason_kind: 'requirement_confirmation', question_for_human: '按这份理解往下做吗？', context_for_human: '开工前的确认。', blocking: true, blocked_stage: '需求确认', urgency: 'blocking', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked', role_token: TK.orch }, AG.orch)
    const rid = hr.value?.request_id ?? ''
    await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid, role_token: TK.main }, AG.main)
    await callTool(h, 'pipeline_human_reply', { task_id: taskId, request_id: rid, user_quote: '就按这份理解做，验收标准和边界我看过了，没问题。', reply_channel: 'chat', attribution: '用户在当前会话里直接回复', answer: true, role_token: TK.main }, AG.main)

    const agree = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '同意需求结论', role_token: TK.sup }, AG.sup)
    if (agree.denied === true || (await st()) !== ST.ARCH_DRAWING) throw new Error(`夹具：第①道确认失败：${await st()}\n${agree.text}`)

    // --- 架构图 ---
    const { mkdir } = await import('node:fs/promises')
    const dgDir = `${h.projectRoot}/.pipeline/${taskId}/reports/diagrammer`
    await mkdir(dgDir, { recursive: true })
    await writeFile(`${dgDir}/diagrammer-topology.html`, '<html>topology</html>', 'utf8')
    const dg = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'architecture_diagram', role_token: TK.diag, payload: { task_id: taskId, based_on_artifact_version: 'pre-plan', diagram_path: `${dgDir}/diagrammer-topology.html`, produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: '夹具：自备产物' } }, AG.diag)
    if (dg.denied === true || (await st()) !== ST.ARCH_CONFIRM) throw new Error(`夹具：交架构图失败：${await st()}\n${dg.text}`)

    const dgH = (await taskNow()).handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
    const s2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_STATIONS.DIAGRAM_CONFIRM, artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；覆盖模块 1 个。', reason: '满足要求' } }, AG.sup)
    if (s2.denied === true) throw new Error(`夹具：第②道确认失败：\n${s2.text}`)
    const cf = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_diagram', reason: '确认架构图满足要求', role_token: TK.sup }, AG.sup)
    // ---------------------------------------------------------------------
    // ★★ P0-1（用户新口径第 7~8 跳）：第②道之后**还有两道确认点**才轮到计划位 ——
    //    ②b 需求位确认架构图 → ②c 主管二次确认。
    //    这里**只补夹具走的路**：下面那条 `if`、以及本文件其余每一行断言与期望值
    //    **一个字节都没改**（"第②道一放行就到 standby_plan"是新口径下不再存在的近路）。
    // ---------------------------------------------------------------------
    const nc2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM, artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；覆盖模块 1 个；与需求口径对得上。', reason: '需求位确认架构图' } }, AG.orch)
    if (nc2.denied === true) throw new Error(`夹具：②b 需求位确认失败：\n${nc2.text}`)
    const rc2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM, artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求位已确认；无问题。', reason: '主管二次确认' } }, AG.sup)
    if (rc2.denied === true) throw new Error(`夹具：②c 主管二次确认记录失败：\n${rc2.text}`)
    const cf2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '无问题，交给计划位', role_token: TK.sup }, AG.sup)
    if (cf2.denied === true) throw new Error(`夹具：②c 主管二次确认失败：\n${cf2.text}`)
    if (cf.denied === true || (await st()) !== ST.STANDBY_PLAN) throw new Error(`夹具：confirm_diagram 失败：${await st()}\n${cf.text}`)

    // --- 计划 → 编写 → 测试 ---
    const dp = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: TK.main }, AG.main)
    if (dp.denied === true) throw new Error(`夹具：派计划失败：\n${dp.text}`)
    const pl = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'plan', role_token: TK.plan, payload: planPayload(taskId) }, AG.plan)
    if (pl.denied === true) throw new Error(`夹具：交计划失败：\n${pl.text}`)
    // ★ 夹具：`planned` 只有 planner 能发（`by:['planner']`），而 planner 调不动
    //   `pipeline_transition`（那条通道只给 main/human）—— 真实用法是 `pipeline_plan`
    //   （交计划 + 写角色清单 + 推进三合一）。这里为了让夹具短一点，直接走 store 层
    //   发这一跳：**它判的还是同一个 guard（`plan_ready`）**，没有绕开任何判据。
    const adv = await h.store.transition({ taskId, event: 'planned', actorRole: 'planner', note: '夹具：计划自检通过 + 分配完成' })
    if (adv.ok !== true) throw new Error(`夹具：planned 失败：${JSON.stringify(adv).slice(0, 300)}`)
    const dw = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_writer', role_token: TK.main }, AG.main)
    if (dw.denied === true) throw new Error(`夹具：派编写失败：\n${dw.text}`)
    const dev = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'dev_to_test', role_token: TK.writer, payload: { task_id: taskId, artifact_version: 'v1', patch_or_code: 'diff --git a/x b/x\n+1', change_note: '夹具', run_commands: ['node --test'], selftest_result: '通过', known_issues: [], acceptance_map: { '验收1': 'x' }, change_manifest: [{ scope_id: 'CS1', path: '.', action: 'modify' }] } }, AG.writer)
    if (dev.denied === true || (await st()) !== ST.READY_TEST) throw new Error(`夹具：编写交测试失败：${await st()}\n${dev.text}`)
    const dt = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_tester', role_token: TK.main }, AG.main)
    if (dt.denied === true) throw new Error(`夹具：派测试失败：\n${dt.text}`)
    const tr = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'test_to_review', role_token: TK.tester, payload: { task_id: taskId, artifact_version: 'v1', test_cases: ['c1'], execution_result: '1/1 通过', failure_logs: [], pass_evidence: ['输出 1 pass'], risk_notes: [], verdict: 'pass' } }, AG.tester)
    if (tr.denied === true || (await st()) !== ST.READY_REVIEW) throw new Error(`夹具：测试交审核失败：${await st()}\n${tr.text}`)
    rec.add('C 正例·③', '★ 夹具到位：任务停在「待审核」（第③道双确认待判）', (await st()) === ST.READY_REVIEW, await st())
  }

  const supOk = (station, version, reason) => ({ task_id: taskId, station, artifact_version: version, decision: 'ok', basis_refs: [`${version}@evidence`], basis_kind: 'evidence_digest', basis_digest: '结论 1 份；计数与路径见上。', reason })

  // =========================================================================
  // 【C】正例·③：否掉 ⇒ 退回测试位，且**否掉即作废**
  // =========================================================================
  {
    // 先让第③道的双确认**齐备**（这样"否掉之后作废"才有可观察的对照）。
    const o = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: supOk(HUB_STATIONS.TEST_CONFIRM, 'v1', '需求位认可测试结论') }, AG.orch)
    const s = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: supOk(HUB_STATIONS.TEST_CONFIRM, 'v1', '主管认可测试结论') }, AG.sup)
    rec.add('C 正例·③', '★ 双确认交齐（③道：主管 + 需求位各一份）', o.denied !== true && s.denied !== true, `${o.text.split('\n')[0]} | ${s.text.split('\n')[0]}`)
    const open1 = await pre('dispatch_reviewer_gate', {})
    rec.add('C 正例·③', '★★ 对照：双确认齐备时第③道闸**是开的**（可达「审核中」）', open1.ok === true, JSON.stringify(open1).slice(0, 200))

    const rj = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_test', reason: '测试结论只跑了 1 条用例，"无问题"这个结论证据不足，退回重跑', basis_refs: ['v1@test_to_review'], basis_digest: '用例 1 条；通过 1 条；未覆盖边界。', role_token: TK.sup }, AG.sup)
    rec.add('C 正例·③', '★★ **否掉走完了回边**：状态落到「已打回测试」（退回**测试位**重跑）', rj.denied !== true && (await st()) === ST.RETURNED_TO_TEST, `${await st()} ${rj.text.split('\n')[0]}`)
    rec.add('C 正例·③', '★ 回边的落点取自状态表（`ready_review → returned_to_test`），不是硬编码在工具里', edgeOf('supervisor_reject_test')?.from === ST.READY_REVIEW && edgeOf('supervisor_reject_test')?.to === ST.RETURNED_TO_TEST, `${edgeOf('supervisor_reject_test')?.from} → ${edgeOf('supervisor_reject_test')?.to}`)

    const closed = await pre('dispatch_reviewer_gate', {})
    rec.add('C 正例·③', '★★ **否掉即作废**：此前的双确认**不再放行**（闸门重新关上 —— 否则"否掉"就是空转）', closed.ok !== true, `code=${closed.code} ${String(closed.error ?? '').split('\n')[0]}`)

    const t = await taskNow()
    rec.add('C 正例·③', '★★ 留痕：账本 + 审计 + 记录三处都在（同一套，不另起一份日志）', (t.hub?.reject_history ?? []).some((x) => x.station === HUB_STATIONS.TEST_CONFIRM && x.back_to === ST.RETURNED_TO_TEST) && (t.handoffs ?? []).some((x) => x.kind === 'station_confirm' && x.payload?.station === HUB_STATIONS.TEST_CONFIRM && x.payload?.decision === 'ng' && x.from_role === 'supervisor') && t.history.some((x) => x.action === 'transition:supervisor_reject_test' && x.actor === 'supervisor'), JSON.stringify(t.hub?.station_rejects))

    // 重跑到「待审核」，证明回路闭合（重跑之后**必须重新确认**）。
    const dt2 = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_tester', role_token: TK.main }, AG.main)
    const tr2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'test_to_review', role_token: TK.tester, payload: { task_id: taskId, artifact_version: 'v1', test_cases: ['c1', 'c2', 'c3'], execution_result: '3/3 通过', failure_logs: [], pass_evidence: ['输出 3 pass'], risk_notes: [], verdict: 'pass' } }, AG.tester)
    rec.add('C 正例·③', '★ 回路是闭合的：退回之后测试位重跑、重交 ⇒ 又停在「待审核」', dt2.denied !== true && tr2.denied !== true && (await st()) === ST.READY_REVIEW, `${await st()}`)
    const stillClosed = await pre('dispatch_reviewer_gate', {})
    rec.add('C 正例·③', '★★ 重跑之后**旧的点头不作数**：仍要重新确认（闸门依旧关着）', stillClosed.ok !== true, `code=${stillClosed.code}`)

    // 重新确认 ⇒ 放行（证明"作废"没有变成"永久关死"）。
    await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: supOk(HUB_STATIONS.TEST_CONFIRM, 'v1', '重跑后需求位再次认可') }, AG.orch)
    await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: supOk(HUB_STATIONS.TEST_CONFIRM, 'v1', '重跑后主管再次认可') }, AG.sup)
    const reopen = await pre('dispatch_reviewer_gate', {})
    rec.add('C 正例·③', '★★ **正例**：重新确认之后闸门重新打开（判据是"重新确认"，不是"永久关死"）', reopen.ok === true, JSON.stringify(reopen).slice(0, 200))

    const dr = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_reviewer', role_token: TK.main }, AG.main)
    if (dr.denied === true) throw new Error(`夹具：派审核失败：\n${dr.text}`)
    const rv = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'review_verdict', role_token: TK.reviewer, payload: { task_id: taskId, artifact_version: 'v1', conclusion: 'OK', risk_notes: [], release_approved: true, security: cleanSecurity(), final_delivery_note: '夹具交付说明。', acceptance_check: { '验收1': 'pass' } } }, AG.reviewer)
    if (rv.denied === true || (await st()) !== ST.PASSED) throw new Error(`夹具：审核 OK 失败：${await st()}\n${rv.text}`)
    rec.add('D 正例·④', '★ 夹具到位：任务停在「已通过」（第④道双确认待判）', (await st()) === ST.PASSED, await st())
  }

  // =========================================================================
  // 【D】正例·④：否掉 ⇒ 退回审核位，且同样作废
  // =========================================================================
  {
    await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: supOk(HUB_STATIONS.REVIEW_CONFIRM, 'v1', '需求位认可审核结论') }, AG.orch)
    await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: supOk(HUB_STATIONS.REVIEW_CONFIRM, 'v1', '主管认可审核结论') }, AG.sup)
    const open4 = await pre('hub_station_review_confirm', {})
    rec.add('D 正例·④', '★★ 对照：第④道双确认齐备时闸是开的（可关单）', open4.ok === true, JSON.stringify(open4).slice(0, 200))

    const noRec = await h.store.checkPrecondition(await taskNow(), 'hub_station_reject', { event: 'supervisor_reject_review' })
    rec.add('D 反例·④', '★★ 第④道没有否掉记录 ⇒ 回边过不去（与①③同一枚判据、同一份措辞）', noRec.ok !== true && String(noRec.code) === 'HUB_STATION_REJECT_NO_RECORD', `code=${noRec.code} ${String(noRec.error).split('\n')[0]}`)

    const rj = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_review', reason: '审核结论里"验收标准逐条核对"只有 1 条，证据不足以放行，退回重审', basis_refs: ['v1@review_verdict'], basis_digest: '验收条目 1 条；逐条核对结论 1 条；风险 0 条。', role_token: TK.sup }, AG.sup)
    rec.add('D 正例·④', '★★ **否掉走完了回边**：状态落到「审核中」（退回**审核位**重审）', rj.denied !== true && (await st()) === ST.REVIEWING, `${await st()} ${rj.text.split('\n')[0]}`)

    const closed4 = await pre('hub_station_review_confirm', {})
    rec.add('D 正例·④', '★★ **否掉即作废**：第④道的旧确认不再放行（关不了单）', closed4.ok !== true, `code=${closed4.code}`)
    const closeGate = await pre('close_gates', {})
    rec.add('D 正例·④', '★★ 关单的组合闸跟着关上（否掉之后**不可能**被关单 —— 这就是"退回"与"卡死"的区别所在）', closeGate.ok !== true, `code=${closeGate.code}`)

    const rj2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_review', reason: '再来一次', basis_refs: ['v1@x'], basis_digest: '结论 1 条。', role_token: TK.sup }, AG.sup)
    rec.add('E 反例·预算', '★★ 第④道预算用尽 ⇒ 拒且指向"升给用户"（四条回边同一套预算口径）', rj2.denied === true && says(rj2, '预算', '用户'), rj2.text.split('\n')[0])
  }

  // =========================================================================
  // 【F】第⑤道：**不是**确认站点（如实标明，二选一取这一支）
  // =========================================================================
  {
    const bad = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: supOk(HUB_STATIONS.CLOSEOUT, 'v1', '给第⑤道交一份确认') }, AG.sup)
    rec.add('F 第⑤道', '★★ 第⑤道**交不出确认记录**（`station_confirm` 的 station 枚举里没有 closeout）⇒ 它**不是**确认站点', bad.denied === true && says(bad, 'closeout'), bad.text.split('\n')[0])
    rec.add('F 第⑤道', '★ 枚举里确实没有 closeout（与上面那条拒绝同源，不是我口头断言）', !HANDOFF_SCHEMAS.station_confirm.fields.station.values.includes(HUB_STATIONS.CLOSEOUT), JSON.stringify(HANDOFF_SCHEMAS.station_confirm.fields.station.values))

    const hub = boundaryManifest().supervisor_hub
    const row5 = (hub.stations ?? []).find((x) => x.station === HUB_STATIONS.CLOSEOUT)
    rec.add('F 第⑤道', '★★ **只读导出**里如实标明它不是确认站点（`is_confirm_station:false` + 为什么）', row5?.is_confirm_station === false && typeof row5?.why_not_a_confirm_station === 'string' && row5.why_not_a_confirm_station.length > 0, JSON.stringify(row5 ?? null).slice(0, 260))
    rec.add('F 第⑤道', '★ 导出同时给出「哪几道**是**确认站点」（四道）与「哪几道不是」（第⑤道）', JSON.stringify(hub.confirm_stations) === JSON.stringify(Object.keys({ need_agree: 1, diagram_confirm: 1, test_confirm: 1, review_confirm: 1 })) && JSON.stringify(hub.not_confirm_stations) === JSON.stringify([HUB_STATIONS.CLOSEOUT]), `confirm=${JSON.stringify(hub.confirm_stations)} not=${JSON.stringify(hub.not_confirm_stations)}`)
    rec.add('F 第⑤道', '★ 四道确认站点的导出全部 `is_confirm_station:true`（派生自确认方清单，不手抄）', (hub.stations ?? []).filter((x) => x.is_confirm_station === true).length === 4, JSON.stringify((hub.stations ?? []).map((x) => `${x.station}:${x.is_confirm_station}`)))
  }

  // =========================================================================
  // 【G】同构性：四条回边逐项对齐（表里读出来的，不是我口头说"同构"）
  // =========================================================================
  {
    const hub = boundaryManifest().supervisor_hub
    const rows = Array.isArray(hub.reject_edges) ? hub.reject_edges : []
    rec.add('G 同构性', '★★ 只读导出里四条回边**并排列出**（② 道那条与新补的三条同表可比）', rows.length === 4, JSON.stringify(rows.map((x) => x.event)))
    rec.add('G 同构性', '★★ 四条回边的 `by` 全部 = [supervisor]（发起/确认/否掉三处同一个 by 名单）', rows.every((x) => JSON.stringify(x.by) === JSON.stringify(['supervisor'])), JSON.stringify(rows.map((x) => x.by)))
    rec.add('G 同构性', '★★ 四条回边全部挂在**同一张 `TRANSITIONS` 表**上（`from`/`to`/`guard` 逐字取自表，导出不手抄）', rows.every((x) => {
      const e = edgeOf(x.event)
      return e !== null && e.from === x.from && e.to === x.to && e.guard === x.guard
    }), JSON.stringify(rows.map((x) => `${x.event}:${x.from}->${x.to}:${x.guard}`)))
    rec.add('G 同构性', '★★ 四条回边全部走**同一个守卫开关**（`store.checkPrecondition`；② 道是它自己的 `hub_diagram_rework_budget`，①③④ 共用 `hub_station_reject`）', rows.every((x) => typeof x.guard === 'string' && x.guard.length > 0), JSON.stringify(rows.map((x) => x.guard)))
    rec.add('G 同构性', '★★ 四条回边**同一套预算口径**：限 1 次 ⇒ 用尽升人工（`escalate_on_exhaust` 全指向既有的两级梯）', rows.every((x) => x.budget === 1 && String(x.escalate_on_exhaust).includes('两级梯')), JSON.stringify(rows.map((x) => `${x.event}:${x.budget}`)))
    rec.add('G 同构性', '★ 两条口径差异**如实标出**（①③④ 必须先落带证据的否掉记录；② 道保持原样）', rows.filter((x) => x.evidence_record_required === true).length === 3 && rows.filter((x) => x.evidence_record_required === false).length === 1, JSON.stringify(rows.map((x) => `${x.event}:${x.evidence_record_required}`)))
    rec.add('G 同构性', '★ 每条回边都写清「退回谁 / 退到哪」且落点各不相同（需求位 / 架构位 / 测试位 / 审核位）', new Set(rows.map((x) => x.to)).size === 4 && rows.every((x) => typeof x.to_zh === 'string' && x.to_zh.length > 0), JSON.stringify(rows.map((x) => `${x.station}->${x.to}`)))
    rec.add('G 同构性', '★ 事件名只有一个出处（`HUB_STATION_REJECT_EVENTS`），导出与状态机读的是同一份', rows.filter((x) => Object.values(HUB_STATION_REJECT_EVENTS).includes(x.event)).length === 3, JSON.stringify(Object.values(HUB_STATION_REJECT_EVENTS)))
  }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/station-reject-check.mjs`
// 形状照抄同目录既有的兄弟（只在**本文件被直接执行**时跑一遍并给退出码；
// 被 `run-all.mjs` import 时不产生任何副作用）。
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /station-reject-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runStationRejectCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
