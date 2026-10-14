/**
 * dsh-pipeline · tests/dispatch-channel-check.mjs
 * ============================================================================
 * **通道与派活层**（T-20261011-56a37e · 主管枢纽）
 *   —— 四槽下发与读回 / 拒绝留痕
 *
 * 本套与 `gate-states-check` 分工不同：那一套读**表**（拓扑权威面对不对），
 * 这一套走**真工具 + 真守门 + 真状态机**（通道通不通、待机可见不可见、抢跑拦不拦得住）。
 * 全程临时目录、跑完即删；不建真实会话、不监听端口。
 *
 * 判据分组：
 *   【A】发起：名单登记了主管席位 ⇒ main 代发被拒；主管发起成功且**两席待机可见**
 *   【B】越权：main 调主管动作被守门拒（第一道）；main 触发主管事件被状态机拒（第二道）
 *   【C】待机期不许抢跑（产物面三条）：交产物 / 写自己目录 / 跑测试
 *   【D】站点①：缺确认走不动；双前置（主管确认 + **既有的用户确认**）齐备才放行 + 唤醒点 A
 *   【E】架构图前置：非前置站交图被拒；前置站放行并自动推进；重画预算 = 1
 *   【F】站点② + 唤醒点 B：计划位到点才动
 *   【G】测试提前知情：预登记只在计划站交；**编写交付之前不许开跑**；交付之后不许再交预登记
 *   【H】拒绝留痕：状态迁移逐条留痕，发起者记的是**真实角色**
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/dispatch-channel-check
 */

import { createHarness, disposeHarness, callTool } from './selftest-core.mjs'
import { HUB_HANDOFF_CONFIRM_STATIONS, HUB_STATIONS, ST } from '../lib/states.js'
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
      L.push('dsh-pipeline · 通道与派活层（主管枢纽：四槽下发与读回 / 拒绝留痕）')
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

export async function runDispatchChannelCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    await driveHub(h, rec)
  } catch (err) {
    // 夹具执行中途抛异常**不许静默**：如实记一条 ✗ 并把原文留在 detail 里。
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 5).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function driveHub(h, rec) {
  const open = await callTool(h, 'pipeline_task_open', { requirement: '主管枢纽端到端夹具：把主管做成枢纽。' }, 'sess-main')
  const taskId = open.value.task_id

  /** 铸一枚**绑定会话**的席位令牌（夹具自举；真实用法由 pipeline_dispatch 铸）。 */
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
  }
  const AG = { main: 'sess-main', sup: 'sess-sup', orch: 'sess-orch', diag: 'sess-diag', arch: 'sess-arch', plan: 'sess-plan', tester: 'sess-tester' }
  const state = async () => (await h.store.get(taskId)).state

  // --- 名单里登记 supervisor 席位（名单四槽面 = B 单已落地的「谁在册」）------
  const built = buildRoster({ tier: 'L3', reason: '夹具', judgedBy: 'planner', writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: [] }] } })
  const task0 = await h.store.get(taskId)
  task0.roster = { ...built.roster, conversations: [...built.roster.conversations, 'supervisor'] }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${h.projectRoot}/.pipeline/${taskId}/task.json`, JSON.stringify(task0, null, 2), 'utf8')
  h.indexTask(taskId, task0)

  // =========================================================================
  // 【A】发起：main 代发被拒；主管发起成功；两席待机可见
  // =========================================================================
  {
    const bad = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_orchestrator', role_token: TK.main }, AG.main)
    rec.add('A 发起面', '★★ 名单里有主管席位 ⇒ main 的 dispatch_orchestrator 被拒（拒绝原文指名「必须由主管发起」）', bad.denied === true && says(bad, '主管', '发起'), bad.text.split('\n')[0])

    const init = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '夹具：主管发起三席', role_token: TK.sup }, AG.sup)
    rec.add('A 发起面', '★ 主管发起成功（待分配 → 需求分析中）', init.denied !== true && (await state()) === ST.ANALYZING, `${await state()} ${init.text.split('\n')[0]}`)

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    const standby = st.value?.hub?.standby ?? []
    rec.add('A 发起面', '★★ 「已登记待机」**读得回来**（三席都在，状态是 standby 而不是 woken）', standby.length === 3 && standby.every((s) => s.status === 'standby'), JSON.stringify(standby.map((s) => `${s.role}:${s.status}`)))
    rec.add('A 发起面', '★ 待机的**中文可读面**写的是「已登记待机（未开工）」', standby.length === 3 && standby.every((s) => s.status_zh === '已登记待机（未开工）'), JSON.stringify(standby.map((s) => s.status_zh)))
    rec.add('A 发起面', '★ 两席各自绑定了唤醒点（架构位=need_agree / 计划位=diagram_confirm）', standby.find((s) => s.role === 'planner')?.wake_point === 'diagram_confirm' && standby.find((s) => s.role === 'architect')?.wake_point === 'need_agree', JSON.stringify(standby.map((s) => `${s.role}->${s.wake_point}`)))
    const again = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '再来一次', role_token: TK.sup }, AG.sup)
    rec.add('A 发起面', '★ 重复发起被拒（发起是一次性动作，不许覆盖待机名册）', again.denied === true, again.text.split('\n')[0])
  }

  // =========================================================================
  // 【B】越权：main 调主管动作（守门第一道 / 状态机第二道）
  // =========================================================================
  {
    const bad = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '代发', role_token: TK.main }, AG.main)
    rec.add('B 越权', '★★ main 调主管工具被**守门**拒（允许角色：supervisor）', bad.denied === true && bad.layer === 'guard' && says(bad, 'supervisor'), `layer=${bad.layer} ${bad.text.split('\n')[0]}`)
    const bad2 = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'supervisor_agree_need', role_token: TK.main }, AG.main)
    rec.add('B 越权', '★★ 就算绕过工具面，状态机的 by:[supervisor] 是第二道（main 代发被拒）', bad2.denied === true, bad2.text.split('\n')[0])
    const bad3 = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'supervisor_agree_need', role_token: TK.orch }, AG.orch)
    rec.add('B 越权', '★ 需求位代发主管事件同样被拒（越权发起不只针对 main）', bad3.denied === true, bad3.text.split('\n')[0])
  }

  // =========================================================================
  // 【C】待机期不许抢跑（产物面三条）
  // =========================================================================
  {
    const p = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'plan', role_token: TK.plan, payload: planPayload(taskId) }, AG.plan)
    rec.add('C 待机抢跑', '★★ ①交接物面：计划位在待机期交 plan ⇒ 拒（拒绝原文指名它的唤醒点）', p.denied === true && says(p, '已登记待机', '唤醒点'), p.text.split('\n')[0])

    const d = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'design', role_token: TK.arch, payload: { task_id: taskId, modules: ['a'], interfaces: ['b'], tech_choices: ['c'], decisions: ['d'], risks: [] } }, AG.arch)
    rec.add('C 待机抢跑', '★★ ①交接物面：架构位在待机期交 design ⇒ 拒', d.denied === true && says(d, '已登记待机'), d.text.split('\n')[0])

    const w = await callTool(h, 'write', { file_path: `${h.projectRoot}/.pipeline/${taskId}/reports/architect/architect-note.md`, content: 'x' }, AG.arch)
    rec.add('C 待机抢跑', '★★ ②文件面（守门）：待机期写**自己目录**的报告也算开工 ⇒ 拒', w.denied === true && w.layer === 'guard' && says(w, '已登记待机'), `layer=${w.layer} ${w.text.split('\n')[0]}`)

    const t = await callTool(h, 'pwsh', { command: 'npm test' }, AG.tester)
    rec.add('C 待机抢跑', '★★ ③测试面（守门）：编写交付之前 tester 跑测试 ⇒ 拒', t.denied === true && t.layer === 'guard' && says(t, '还没到开工的时候'), `layer=${t.layer} ${t.text.split('\n')[0]}`)
  }

  // =========================================================================
  // 【D】站点①：双前置 + 唤醒点 A
  // =========================================================================
  {
    const a = await callTool(h, 'pipeline_orchestrate', { task_id: taskId, task_card: { goal: '把主管做成枢纽' }, acceptance: ['验收1'], test_points: ['要点1'], boundaries: ['边界1'], unclear_points: [], analysis_reason: '依据用户原话', role_scope: { will_do: ['分析'], will_not_do: ['分配'] }, role_token: TK.orch }, AG.orch)
    rec.add('D 站点①', '★ 需求位交结论 ⇒ 状态**自动**落到「主管受理中」（不再直接进计划）', a.denied !== true && (await state()) === ST.SUPERVISING, await state())

    const noConfirm = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '直接同意', role_token: TK.sup }, AG.sup)
    rec.add('D 站点①', '★★ 既有的**用户确认**闸门仍在：没有用户答复 ⇒ 第①道过不去', noConfirm.denied === true && says(noConfirm, '用户'), noConfirm.text.split('\n')[0])

    const hr = await callTool(h, 'pipeline_human_request', { task_id: taskId, reason_kind: 'requirement_confirmation', question_for_human: '按这份理解往下做吗？', context_for_human: '开工前的确认。', blocking: true, blocked_stage: '需求确认', urgency: 'blocking', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked', role_token: TK.orch }, AG.orch)
    const rid = hr.value?.request_id ?? ''
    await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid, role_token: TK.main }, AG.main)
    const rp = await callTool(h, 'pipeline_human_reply', { task_id: taskId, request_id: rid, user_quote: '就按这份理解做，验收标准和边界我看过了，没问题。', reply_channel: 'chat', attribution: '用户在当前会话里直接回复', answer: true, role_token: TK.main }, AG.main)
    rec.add('D 站点①', '★ 用户答复记回来了（既有链，一个字没改）', rp.denied !== true && (await state()) === ST.SUPERVISING, `${await state()} ${rp.text.split('\n')[0]}`)

    const missConfirm = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '还没交确认记录', role_token: TK.sup }, AG.sup)
    rec.add('D 站点①', '★★ 用户答复有了，但**站点确认记录缺失** ⇒ 仍拒（拒绝原文指名「还缺谁」）', missConfirm.denied === true && says(missConfirm, '确认'), missConfirm.text.split('\n')[0])

    const analysis = (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'requirement_analysis').pop()
    const sc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_STATIONS.NEED_AGREE, artifact_version: analysis.handoff_id, decision: 'ok', basis_refs: [`${analysis.handoff_id}@${analysis.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求结论 1 份；验收 1 条；测试要点 1 条；证据见上。', reason: '满足要求' } }, AG.sup)
    rec.add('D 站点①', '★ 主管交第①道站点确认 ⇒ 通过（证据标识 + 脱敏证据正文）', sc.denied !== true, sc.text.split('\n')[0])

    const agree = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '同意需求结论', role_token: TK.sup }, AG.sup)
    rec.add('D 站点①', '★★ 双前置齐备 ⇒ 第①道放行，状态到「架构位出图中」', agree.denied !== true && (await state()) === ST.ARCH_DRAWING, `${await state()} ${agree.text.split('\n')[0]}`)

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    const sb = st.value?.hub?.standby ?? []
    rec.add('D 站点①', '★★ **唤醒点 A** 已触发：架构位两席变成 woken，计划位仍是 standby', sb.filter((s) => s.wake_point === 'need_agree').every((s) => s.status === 'woken') && sb.find((s) => s.role === 'planner')?.status === 'standby', JSON.stringify(sb.map((s) => `${s.role}:${s.status}`)))
    rec.add('D 站点①', '★ 唤醒留痕可查（谁在什么时候唤醒的）', Array.isArray(st.value?.hub?.wakes) && st.value.hub.wakes.some((w) => w.wake_point === 'need_agree' && w.by === 'supervisor'), JSON.stringify(st.value?.hub?.wakes))
    rec.add('D 站点①', '★ 唤醒**投递结果如实上报**（夹具里没有派活台账 ⇒ 投不出去时必须写出来，不许静默）', says(agree, '唤醒投递'), String(agree.text).split('\n').slice(-3).join(' | ').slice(0, 240))

    const w2 = await callTool(h, 'write', { file_path: `${h.projectRoot}/.pipeline/${taskId}/reports/architect/architect-note.md`, content: 'x' }, AG.arch)
    rec.add('D 站点①', '★★ **正例**：到点唤醒之后，架构位写自己目录的报告**放行**（判据是「到点」，不是「关掉功能」）', w2.denied !== true, w2.text.split('\n')[0])
  }

  // =========================================================================
  // 【E】架构图前置 + 重画预算
  // =========================================================================
  {
    // 交付物必须真的躺在盘上（checkDiagramDelivery 的既有判据）。
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    const dgDir = `${h.projectRoot}/.pipeline/${taskId}/reports/diagrammer`
    await mkdir(dgDir, { recursive: true })
    await wf(`${dgDir}/diagrammer-topology-a.html`, '<html>a</html>', 'utf8')
    await wf(`${dgDir}/diagrammer-topology-b.html`, '<html>b</html>', 'utf8')

    const dgBody = (path) => ({ task_id: taskId, based_on_artifact_version: 'pre-plan', diagram_path: path, produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: '夹具：自备产物' })
    const d1 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'architecture_diagram', role_token: TK.diag, payload: dgBody(`${dgDir}/diagrammer-topology-a.html`) }, AG.diag)
    rec.add('E 架构图前置', '★★ 前置站交图 ⇒ 放行，并**自动**推进到「架构图待主管确认」', d1.denied !== true && (await state()) === ST.ARCH_CONFIRM, `${await state()} ${d1.text.split('\n')[0]}`)

    const dp = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: TK.main }, AG.main)
    rec.add('E 架构图前置', '★★ **跳步即拒**：主管还没确认架构图就派计划 ⇒ 拒', dp.denied === true, dp.text.split('\n')[0])

    const p2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'plan', role_token: TK.plan, payload: planPayload(taskId) }, AG.plan)
    rec.add('E 架构图前置', '★★ 唤醒点 B 未到 ⇒ 计划位**连产物都交不出来**（不是「交了不生效」）', p2.denied === true && says(p2, '已登记待机'), p2.text.split('\n')[0])

    const rj = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_diagram', reason: '覆盖模块不全', role_token: TK.sup }, AG.sup)
    rec.add('E 架构图前置', '★ 主管判「不满足」⇒ 重画（回到架构位出图中）', rj.denied !== true && (await state()) === ST.ARCH_DRAWING, `${await state()} ${rj.text.split('\n')[0]}`)
    const d2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'architecture_diagram', role_token: TK.diag, payload: { ...dgBody(`${dgDir}/diagrammer-topology-b.html`), covered_modules: ['m1', 'm2'] } }, AG.diag)
    rec.add('E 架构图前置', '★ 重画后再交图 ⇒ 放行', d2.denied !== true, d2.text.split('\n')[0])
    const rj2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reject_diagram', reason: '还是不行', role_token: TK.sup }, AG.sup)
    rec.add('E 架构图前置', '★★ 重画预算 = 1：第二次拒被**拒**，且拒绝原文指向「升给用户」', rj2.denied === true && says(rj2, '预算', '用户'), rj2.text.split('\n')[0])
    rec.add('E 架构图前置', '★ 重画计数可读回（1 / 上限 1）', (await h.store.get(taskId)).hub?.diagram_redraws === 1, String((await h.store.get(taskId)).hub?.diagram_redraws))
  }

  // =========================================================================
  // 【F】站点② + 唤醒点 B
  // =========================================================================
  {
    const miss = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_diagram', reason: '直接确认', role_token: TK.sup }, AG.sup)
    rec.add('F 站点②', '★★ 没有站点确认记录 ⇒ 第②道拒（缺一道就走不到下一步）', miss.denied === true && says(miss, '第②道'), miss.text.split('\n')[0])

    const dg = (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
    const sc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_STATIONS.DIAGRAM_CONFIRM, artifact_version: dg.handoff_id, decision: 'ok', basis_refs: [`${dg.handoff_id}#${dg.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；覆盖模块 2 个；收据路径见上。', reason: '满足要求' } }, AG.sup)
    rec.add('F 站点②', '★ 主管交第②道站点确认 ⇒ 通过', sc.denied !== true, sc.text.split('\n')[0])
    const cf = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_diagram', reason: '确认架构图满足要求', role_token: TK.sup }, AG.sup)
    // ---------------------------------------------------------------------
    // ★★ P0-1（用户新口径第 7~8 跳）：第②道之后**还有两道确认点**才轮到计划位 ——
    //    ②b 需求位确认架构图 → ②c 主管二次确认。
    //    这里**只补夹具走的路**：下面那条断言、以及本文件其余每一行断言与期望值
    //    **一个字节都没改**（改前"第②道一放行就到 standby_plan"是新口径下不再存在的近路）。
    // ---------------------------------------------------------------------
    const nc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM, artifact_version: dg.handoff_id, decision: 'ok', basis_refs: [`${dg.handoff_id}#${dg.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；覆盖模块 2 个；与需求口径逐条对得上。', reason: '需求位确认架构图' } }, AG.orch)
    const rc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM, artifact_version: dg.handoff_id, decision: 'ok', basis_refs: [`${dg.handoff_id}#${dg.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求位已确认；图与需求口径一致，无问题。', reason: '主管二次确认' } }, AG.sup)
    const cf2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '无问题，交给计划位', role_token: TK.sup }, AG.sup)
    rec.add('F 站点②', '★ P0-1 ②b/②c 两个新确认点走完（需求位确认 → 主管二次确认）', nc.denied !== true && rc.denied !== true && cf2.denied !== true, `${nc.text.split('\n')[0]} | ${rc.text.split('\n')[0]} | ${cf2.text.split('\n')[0]}`)
    rec.add('F 站点②', '★★ 第②道放行 ⇒ 状态到「计划位已唤醒待派」', cf.denied !== true && (await state()) === ST.STANDBY_PLAN, `${await state()} ${cf.text.split('\n')[0]}`)

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    const plan = (st.value?.hub?.standby ?? []).find((s) => s.role === 'planner')
    rec.add('F 站点②', '★★ **唤醒点 B** 已触发：计划位变成 woken', plan?.status === 'woken', JSON.stringify(plan))

    const dp = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: TK.main }, AG.main)
    rec.add('F 站点②', '★★ 唤醒之后派计划 ⇒ 放行（「到点才动」而不是「永远不动」）', dp.denied !== true && (await state()) === ST.PLANNING, `${await state()} ${dp.text.split('\n')[0]}`)
  }

  // =========================================================================
  // 【G】测试提前知情 + 不许提前开工
  // =========================================================================
  {
    const pb = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'prebrief', role_token: TK.plan, payload: { task_id: taskId, plan_handoff_id: 'HO-plan', assigned_scope: ['跑验收 1'], acceptance_refs: ['验收1'], artifact_under_test: 'v1（编写交付前为占位）', not_yet_available: ['编写产物尚未交付'], must_not_start_before: 'dev_submitted' } }, AG.plan)
    rec.add('G 测试提前知情', '★★ **正例**：计划位在「计划中」交预登记 ⇒ 放行（这是测试提前知情的载体）', pb.denied !== true, pb.text.split('\n')[0])
    rec.add('G 测试提前知情', '★ 预登记**真的投出去**（投不出去时如实上报，不许静默）', says(pb, '预登记'), String(pb.text).split('\n').slice(-2).join(' | ').slice(0, 240))

    const view = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    rec.add('G 测试提前知情', '★ 预登记可读回，且**早于编写交付**（before_write 判据，不是形容词）', view.value?.hub?.prebrief?.delivered === true && view.value.hub.prebrief.before_write === true, JSON.stringify(view.value?.hub?.prebrief))

    const pl = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'plan', role_token: TK.plan, payload: planPayload(taskId) }, AG.plan)
    rec.add('G 测试提前知情', '★ 计划位交计划（既有链）', pl.denied !== true, pl.text.split('\n')[0])

    const late = h.store.checkHandoffAgainstState({ id: taskId, state: ST.DEVELOPING, hub: { enabled: true, standby: [] }, handoffs: [] }, 'prebrief')
    rec.add('G 测试提前知情', '★★ 错站交预登记 ⇒ 拒（预登记只在「计划中」那一站交）', late.ok !== true && String(late.code) === 'HUB_PREBRIEF_STEP_SKIPPED', `code=${late.code} ${String(late.error).split('\n')[0]}`)

    const after = h.store.checkHandoffAgainstState({ id: taskId, state: ST.PLANNING, hub: { enabled: true, standby: [] }, handoffs: [{ kind: 'dev_to_test', artifact_version: 'v1' }] }, 'prebrief')
    rec.add('G 测试提前知情', '★★ 编写交付之后再交「预登记」⇒ 拒（不许把事后通知冒充成提前知情）', after.ok !== true && String(after.code) === 'HUB_PREBRIEF_AFTER_WRITE', `code=${after.code} ${String(after.error).split('\n')[0]}`)
    const inPlan = h.store.checkHandoffAgainstState({ id: taskId, state: ST.PLANNING, hub: { enabled: true, standby: [] }, handoffs: [{ kind: 'architecture_diagram' }] }, 'prebrief')
    rec.add('G 测试提前知情', '★★ **正例**：还在「计划中」且没有编写产物 ⇒ 预登记判据放行', inPlan.ok === true, JSON.stringify(inPlan))

    const t2 = await callTool(h, 'pwsh', { command: 'npm test' }, AG.tester)
    rec.add('G 测试提前知情', '★★ 编写交付之前 tester 跑测试仍被守门拒（「知情 ≠ 开工」）', t2.denied === true && t2.layer === 'guard', `layer=${t2.layer} ${t2.text.split('\n')[0]}`)
  }

  // =========================================================================
  // 【H】拒绝留痕 / 真实 actor
  // =========================================================================
  {
    const task = await h.store.get(taskId)
    const hist = task.history ?? []
    rec.add('H 留痕', '★ 状态迁移逐条留痕（transition:supervisor_initiate / transition:supervisor_agree_need 可查）', hist.some((x) => x.action === 'transition:supervisor_initiate') && hist.some((x) => x.action === 'transition:supervisor_agree_need'), hist.map((x) => x.action).filter((a) => String(a).startsWith('transition:')).join('、'))
    rec.add('H 留痕', '★★ 发起者记的是**真实角色**（supervisor），不是 main（「谁发起」可追溯）', hist.some((x) => x.action === 'transition:supervisor_initiate' && x.actor === 'supervisor'), JSON.stringify(hist.filter((x) => x.action === 'transition:supervisor_initiate').map((x) => ({ actor: x.actor, to: x.to }))))
    rec.add('H 留痕', '★ 站点确认的关键字段（谁 / 依据什么 / 何时）留在任务数据里', (task.handoffs ?? []).filter((x) => x.kind === 'station_confirm').every((x) => typeof x.from_role === 'string' && typeof x.created_at === 'string' && Array.isArray(x.payload?.basis_refs) && x.payload.basis_refs.length > 0), JSON.stringify((task.handoffs ?? []).filter((x) => x.kind === 'station_confirm').map((x) => ({ by: x.from_role, at: x.created_at, station: x.payload?.station }))))
    // ★ 被拒的交付**不许静默消失**：触发一次"跳步"拒收，看它有没有进 rejected_deliveries。
    //   （归档只发生在"跳步"与等待态两种情形 —— 那是既有实现的口径，本单一个字没改。）
    await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'test_to_review', role_token: TK.tester, payload: { task_id: taskId, artifact_version: 'v1', test_cases: ['c'], execution_result: 'r', failure_logs: [], pass_evidence: ['e'], risk_notes: [], verdict: 'pass' } }, AG.tester)
    const task2 = await h.store.get(taskId)
    rec.add('H 留痕', '★ 被「跳步」拒收的提交进 rejected_deliveries（内容可查回，不是「拒了就没了」）', Array.isArray(task2.rejected_deliveries) && task2.rejected_deliveries.length > 0, `共 ${(task2.rejected_deliveries ?? []).length} 条；首条 code=${(task2.rejected_deliveries ?? [])[0]?.code ?? '-'}`)
  }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/dispatch-channel-check.mjs`
//
// ★ 2026-10-14 补：本文件此前**没有自跑入口** —— 直接跑会输出 0 字节、退出码 0，
//   即"看起来通过、实际一个用例都没跑"（实测：`node tests/dispatch-channel-check.mjs`
//   → stdout+stderr = 0 B，exit = 0）。真实基线（47/47）当时只能经 `run-all.mjs`
//   （它按约定名 `runDispatchChannelCheck` 发现本文件）或让别的脚本 import 才拿得到。
//
//   形状照抄同目录**已经能直接跑**的兄弟（`human-check.mjs` / `fulltest-check.mjs` /
//   `schema-check.mjs` / `wake-check.mjs` 等 30 余份用的都是同一段）：
//     · 只在**本文件被直接执行**时跑一遍、打印与 run-all 同源的汇总、并给出退出码；
//     · 被 `run-all.mjs` import 时**不产生任何副作用**（它的发现机制一个字没变）。
//
//   ★ 只补入口：断言 / 期望值 / 用例一个字节没动。
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /dispatch-channel-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runDispatchChannelCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
