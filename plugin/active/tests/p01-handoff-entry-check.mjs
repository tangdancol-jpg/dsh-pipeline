/**
 * dsh-pipeline · tests/p01-handoff-entry-check.mjs
 * ============================================================================
 * **P0-1**：主管枢纽的**入口**与**补确认环**（用户新口径）
 *
 * 用户原话（逐字，这是规格）：
 *   「**前期应该是主对话agent递给主管agent**，主管拉起需求agent、计划agent、架构agent，
 *     将内容递交到需求agent，需求agent分析完后递交主管agent，主管agent确认后发给架构agent，
 *     架构agent完成后发给主管agent，主管agent转交需求agent，**需求agent确认后递交主管agent
 *     二次确认**，**无问题后**将架构agent递交计划agent，计划agent安排发起其他agent
 *     安装架构图详细执行」
 *
 * 本套回答的是本单要求的**一组正例与反例**（"反例跑不过就不算实现"）：
 *   【A】正例：**新单**（待分配）上主对话把任务递给主管 ⇒ 入口留痕 + 主管席位可派 +
 *        主管发起成功 + 后续站点**可达**
 *   【B】反例·中途：**已经在流程中途的单**递不出去（状态 / 交接物 / 角色清单 三道判据各一条）
 *   【C】反例·身份：**非主对话的会话**递不出去（状态机 by 名单是硬的那一道）
 *   【D】反例·一次性：重复递单被拒；递单之后主对话**不能**自己派需求位
 *   【E】反例·不放宽：递单之后引导步白名单**只**多出 supervisor 一席（编排/架构/计划/测试都仍被拒）
 *   【F】补确认环：②b（需求位确认）→ ②c（主管二次确认）**是硬闸门**，
 *        跳过它们交计划位在**状态表上无路可走**；②c 缺记录时边过不去
 *
 * 全程临时目录、跑完即删；不建真实会话、不监听端口。
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/p01-handoff-entry-check
 */

import { createHarness, disposeHarness, callTool } from './selftest-core.mjs'
import { HUB_HANDOFF_CONFIRM_STATIONS, ST, STATE_LABEL, TRANSITIONS, findTransition } from '../lib/states.js'
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
      L.push('dsh-pipeline · P0-1 主管枢纽：入口（主对话递给主管）与补确认环（②b/②c）')
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

export async function runP01HandoffEntryCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    await drive(h, rec)
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(h, rec) {
  const open = await callTool(h, 'pipeline_task_open', { requirement: 'P0-1 夹具：主对话把任务递给主管，走完 ②b/②c 两个新确认点。' }, 'sess-main')
  const taskId = open.value.task_id
  const state = async () => (await h.store.get(taskId)).state
  const task = async () => await h.store.get(taskId)

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

  // =========================================================================
  // 【C】反例·身份：非主对话的会话**递不出去**
  //     ★ 放在最前面：此时本单还是**干干净净的新单**，所以被拒的原因**只可能**是身份，
  //       不可能是"中途"那几条 —— 反例的归因必须是干净的。
  // =========================================================================
  {
    const bySup = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'handoff_to_supervisor', note: '主管自己给自己递单', role_token: TK.sup }, AG.sup)
    rec.add('C 反例·身份', '★★ 主管自己调 handoff_to_supervisor ⇒ 拒（by 名单只认 main）', bySup.denied === true, bySup.text.split('\n')[0])
    const byOrch = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'handoff_to_supervisor', note: '需求位替主对话递单', role_token: TK.orch }, AG.orch)
    rec.add('C 反例·身份', '★★ 需求位调 handoff_to_supervisor ⇒ 拒（不是主对话就不许递单）', byOrch.denied === true, byOrch.text.split('\n')[0])
    rec.add('C 反例·身份', '★ 两次被拒之后本单**一个字节都没动**（还在待分配、没有入口留痕）', (await state()) === ST.PENDING && ((await task()).hub?.entry ?? null) === null, `${await state()} entry=${JSON.stringify((await task()).hub?.entry ?? null)}`)
  }

  // =========================================================================
  // 【A】正例：新单上，**主对话把任务递给主管**
  // =========================================================================
  {
    const ho = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'handoff_to_supervisor', note: '把这份需求递给主管，请拉起三席', role_token: TK.main }, AG.main)
    rec.add('A 正例·递单', '★★ **正例**：新单（待分配）上主对话递单 ⇒ 放行', ho.denied !== true, ho.text.split('\n')[0])

    const t = await task()
    rec.add('A 正例·递单', '★★ 入口**留痕**（`hub.entry`：谁 · 何时 · 怎么递的 · 为什么）', t.hub?.entry?.by === 'main' && typeof t.hub?.entry?.at === 'string' && String(t.hub?.entry?.note ?? '').includes('递给主管'), JSON.stringify(t.hub?.entry ?? null))
    rec.add('A 正例·递单', '★ 递单**只登记入口**、不推进流程（用户原话里推进流程的是"主管拉起三席"）', (await state()) === ST.PENDING, await state())
    rec.add('A 正例·递单', '★ 递单**不**把枢纽置为已启用（发起仍是主管的动作 —— `enabled` 仍为 false、`initiated_by` 仍为空）', t.hub?.enabled !== true && (t.hub?.initiated_by ?? null) === null, `enabled=${t.hub?.enabled} initiated_by=${t.hub?.initiated_by ?? null}`)
    rec.add('A 正例·递单', '★ 递单动作**进了既有审计**（`audit.jsonl` 的 `transition:handoff_to_supervisor`，不另起一份日志）', (Array.isArray(t.history) ? t.history : []).some((x) => x.action === 'transition:handoff_to_supervisor' && x.actor === 'main'), JSON.stringify((t.history ?? []).filter((x) => String(x.action).includes('handoff')).map((x) => `${x.actor}:${x.action}`)))

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    rec.add('A 正例·递单', '★★ **只读面看得见**"已递单、还没发起"（改前这段时间在只读面上完全不可见）', st.value?.hub?.handed_over_to_supervisor === true && st.value?.hub?.handoff_entry?.by === 'main', JSON.stringify(st.value?.hub ?? null).slice(0, 220))
  }

  // =========================================================================
  // 【E】反例·不放宽：递单之后引导步白名单**只**多出 supervisor 一席
  // =========================================================================
  {
    const sup = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role: 'supervisor', role_token: TK.main }, AG.main)
    rec.add('E 不放宽', '★★ **凭递单留痕**：主对话能把**主管席位**派出去（这条在改前是死路：名单为空时引导步只放开需求分析）', sup.denied !== true, sup.text.split('\n')[0])

    for (const [role, ag] of [['orchestrator', AG.orch], ['architect', AG.arch], ['planner', AG.plan], ['tester', AG.tester]]) {
      const r = await callTool(h, 'pipeline_dispatch', { task_id: taskId, role, role_token: TK.main }, ag)
      rec.add('E 不放宽', `★★ 递单**没有**顺带放开「${role}」—— 引导步白名单只多出 supervisor 这一席`, r.denied === true, r.text.split('\n')[0])
    }
  }

  // =========================================================================
  // 【D】反例·一次性 + 主对话不许自己派需求位
  // =========================================================================
  {
    const again = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'handoff_to_supervisor', note: '再递一次', role_token: TK.main }, AG.main)
    rec.add('D 一次性', '★★ 重复递单 ⇒ 拒（递单是一次性动作，重复会覆盖"谁在什么时候递的"这条留痕）', again.denied === true && says(again, '已经递给主管'), again.text.split('\n')[0])

    const bad = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_orchestrator', role_token: TK.main }, AG.main)
    rec.add('D 一次性', '★★ 递单之后主对话**不能自己**把需求位派出去（`hub_initiate_required` 的第二个触发面：递了单就更该由主管发起）', bad.denied === true && says(bad, '递给主管', '发起'), bad.text.split('\n')[0])
  }

  // =========================================================================
  // 【A】正例收尾：主管**发起** ⇒ 枢纽激活 + 三席待机 + 后续站点可达
  // =========================================================================
  {
    const init = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '拉起需求 / 计划 / 架构三席', role_token: TK.sup }, AG.sup)
    rec.add('A 正例·发起', '★★ 主管发起成功（待分配 → 需求分析中）——「主对话递给主管」之后枢纽**真的启动得起来**', init.denied !== true && (await state()) === ST.ANALYZING, `${await state()} ${init.text.split('\n')[0]}`)

    const t = await task()
    rec.add('A 正例·发起', '★★ 三席**已登记待机**（用户口径第 2 跳：主管拉起需求 / 计划 / 架构）', (t.hub?.standby ?? []).length === 3 && (t.hub?.standby ?? []).every((s) => s.status === 'standby'), JSON.stringify((t.hub?.standby ?? []).map((s) => `${s.role}:${s.status}`)))
    rec.add('A 正例·发起', '★★ **入口留痕没被发起覆盖**（"谁递的单"与"谁发起的"两条都在）', t.hub?.entry?.by === 'main' && t.hub?.initiated_by === 'supervisor', JSON.stringify({ entry: t.hub?.entry?.by ?? null, initiated_by: t.hub?.initiated_by ?? null }))

    // 后续站点**可达**：从架构图完成一路走到"计划位已唤醒待派"，每一步都有表项、且跨过一个状态。
    const walk = [
      ['diagram_submitted', ST.ARCH_DRAWING, ST.ARCH_CONFIRM],
      ['supervisor_confirm_diagram', ST.ARCH_CONFIRM, ST.ARCH_NEED_CONFIRM],
      ['need_confirm_diagram', ST.ARCH_NEED_CONFIRM, ST.ARCH_RECONFIRM],
      ['supervisor_reconfirm_diagram', ST.ARCH_RECONFIRM, ST.STANDBY_PLAN],
      ['dispatch_planner', ST.STANDBY_PLAN, ST.PLANNING],
    ]
    const bad = walk.filter(([ev, from, to]) => {
      const e = findTransition(from, ev)
      return e === null || e.to !== to
    })
    rec.add('A 正例·可达', '★★ **每个站点都可达**：架构图完成 → ②道 → **②b 需求位确认** → **②c 主管二次确认** → 交计划位（逐跳都在表上，且落点逐字相符）', bad.length === 0, bad.length === 0 ? walk.map(([ev, f, t]) => `${f}--${ev}-->${t}`).join('　') : JSON.stringify(bad))
    rec.add('A 正例·可达', '★★ **老近路没了**：表上**不存在** `arch_confirm → standby_plan` 的边（第②道一次点头就交计划，在新口径下无路可走）', TRANSITIONS.filter((t) => t.from === ST.ARCH_CONFIRM && t.to === ST.STANDBY_PLAN).length === 0, JSON.stringify(TRANSITIONS.filter((t) => t.from === ST.ARCH_CONFIRM).map((t) => t.event)))
  }

  // =========================================================================
  // 【B】反例·中途：已经在流程中途的单**递不出去**
  //     ★ 这里用**另一张单**：本单已经推进（analyzing + 有交接物 + 有角色清单），
  //       正好把三条判据各照一条。
  // =========================================================================
  {
    const mid = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'handoff_to_supervisor', note: '中途递单', role_token: TK.main }, AG.main)
    rec.add('B 反例·中途', '★★ 已经在流程中途的单（`analyzing`）⇒ 拒（**第一道**是状态机：递单这条边的 `from` 写死在 `pending` 上）', mid.denied === true && says(mid, '不接受事件'), mid.text.split('\n')[0])

    /**
     * ★ 第二道是 guard 自己的五条判据 —— 直接问 `checkPrecondition`
     *   （**同一个**守卫开关）看它对"已经推进过"的单说什么。
     *   这样一来"判据落在哪条拒绝上"是可核对的，不靠推断。
     */
    const guard2 = await h.store.checkPrecondition(await h.store.get(taskId), 'main_handoff_to_supervisor', { actorRole: 'main' })
    rec.add('B 反例·中途', '★★ **第二道判据**（`store.checkPrecondition` 的 `main_handoff_to_supervisor`）对中途单指名「不是流程最初那一刻」', guard2.ok !== true && String(guard2.code) === 'HUB_HANDOFF_NOT_FIRST_MOMENT' && String(guard2.error).includes('不是流程最初那一刻'), `code=${guard2.code} ${String(guard2.error ?? '').split('\n')[0]}`)

    // 另起一张干净单，分别造出"有角色清单"与"有交接物"两种中途形态。
    const open2 = await callTool(h, 'pipeline_task_open', { requirement: 'P0-1 反例夹具：有角色清单的单不许递。' }, 'sess-main')
    const t2 = open2.value.task_id
    const tk2 = h.tokens.mint({ taskId: t2, role: 'main', seat: null, agentId: 'sess-main' })
    const TK2 = tk2?.token ?? tk2?.rec?.token
    const t2obj = await h.store.get(t2)
    const built = buildRoster({ tier: 'L3', reason: '夹具', judgedBy: 'planner', writers: { count: 1, reason: '夹具', partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: [] }] } })
    t2obj.roster = { ...built.roster, conversations: [...built.roster.conversations, 'supervisor'] }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${h.projectRoot}/.pipeline/${t2}/task.json`, JSON.stringify(t2obj, null, 2), 'utf8')
    h.indexTask(t2, t2obj)

    const afterRoster = await callTool(h, 'pipeline_transition', { task_id: t2, event: 'handoff_to_supervisor', note: '已经有清单了还想递', role_token: TK2 }, 'sess-main')
    rec.add('B 反例·中途', '★★ **已经有角色清单**的单 ⇒ 拒（需求分析与用户确认都过了，不再是"最初那一刻"）', afterRoster.denied === true && says(afterRoster, '角色清单'), afterRoster.text.split('\n')[0])

    // 有交接物：pending 上直接塞一份 orchestration 交接物（表上允许它落在 pending）。
    const open3 = await callTool(h, 'pipeline_task_open', { requirement: 'P0-1 反例夹具：已经开过工的单不许递。' }, 'sess-main')
    const t3 = open3.value.task_id
    const tk3 = h.tokens.mint({ taskId: t3, role: 'main', seat: null, agentId: 'sess-main' })
    const TK3 = tk3?.token ?? tk3?.rec?.token
    const t3obj = await h.store.get(t3)
    t3obj.handoffs = [
      {
        handoff_id: 'H-p01fixture0001',
        kind: 'orchestration',
        from_role: 'orchestrator',
        to_role: 'main',
        task_id: t3,
        artifact_version: null,
        content_hash: 'deadbeef',
        created_at: new Date().toISOString(),
        payload: { task_id: t3 },
      },
    ]
    await writeFile(`${h.projectRoot}/.pipeline/${t3}/task.json`, JSON.stringify(t3obj, null, 2), 'utf8')
    h.indexTask(t3, t3obj)

    const afterWork = await callTool(h, 'pipeline_transition', { task_id: t3, event: 'handoff_to_supervisor', note: '已经开过工了还想递', role_token: TK3 }, 'sess-main')
    rec.add('B 反例·中途', '★★ **已经有交接物**的单 ⇒ 拒（活儿已经开过工，产物归属不到任何一个发起人）', afterWork.denied === true && says(afterWork, '交接物'), afterWork.text.split('\n')[0])
  }

  // =========================================================================
  // 【F】补确认环：②b / ②c **是硬闸门**
  // =========================================================================
  {
    /**
     * ★ 这一段在**同一张已经发起枢纽的单**上走真实链路：
     *   需求位交结论 → 用户确认 → 主管同意 → 架构位交图 → 第②道确认
     *   → 然后分别试：跳过 ②b/②c 交计划（必须无路可走）、②c 缺记录（必须过不去）。
     */
    const t0 = await h.store.get(taskId)
    // 需求分析结论（会经 hubAdvanceFor 推到「主管受理中」）
    const ra = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'requirement_analysis', role_token: TK.orch, payload: { task_id: taskId, task_card: { what: '夹具', not: ['不写实现'] }, unclear_points: [], acceptance: ['验收1'], boundaries: [], test_points: ['要点1'], open_assumptions: [], analysis_reason: '夹具：结论齐备。', role_scope: { will_do: ['分析'], will_not_do: ['不分配 AI'] } } }, AG.orch)
    rec.add('F 硬闸门', '★ 夹具到位：需求位交结论 ⇒ 落到「主管受理中」', ra.denied !== true && (await state()) === ST.SUPERVISING, `${await state()} ${ra.text.split('\n')[0]}`)

    const hr = await callTool(h, 'pipeline_human_request', { task_id: taskId, reason_kind: 'requirement_confirmation', question_for_human: '按这份理解往下做吗？', context_for_human: '开工前的确认。', blocking: true, blocked_stage: '需求确认', urgency: 'blocking', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked', role_token: TK.orch }, AG.orch)
    const rid = hr.value?.request_id ?? ''
    await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid, role_token: TK.main }, AG.main)
    await callTool(h, 'pipeline_human_reply', { task_id: taskId, request_id: rid, user_quote: '就按这份理解做，验收标准和边界我看过了，没问题。', reply_channel: 'chat', attribution: '用户在当前会话里直接回复', answer: true, role_token: TK.main }, AG.main)

    const agree = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '同意需求结论', role_token: TK.sup }, AG.sup)
    if (agree.denied === true) {
      // 第①道是**双前置**：主管的站点确认记录 + 既有的用户确认闸门。补上主管那一份。
      const raH = (await task()).handoffs.filter((x) => x.kind === 'requirement_analysis').pop()
      const s1 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: 'need_agree', artifact_version: raH.handoff_id, decision: 'ok', basis_refs: [`${raH.handoff_id}@${raH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求结论 1 份；验收 1 条；与用户原话一致。', reason: '主管同意需求结论' } }, AG.sup)
      if (s1.denied === true) throw new Error(`夹具：第①道确认记录失败：\n${s1.text}`)
    }
    const agree2 = agree.denied === true
      ? await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '同意需求结论', role_token: TK.sup }, AG.sup)
      : agree
    if (agree2.denied === true || (await state()) !== ST.ARCH_DRAWING) throw new Error(`夹具：第①道确认失败：${await state()}\n${agree2.text}`)
    rec.add('F 硬闸门', '★ 夹具到位：第①道确认 ⇒ 架构位到点开工（唤醒点 A）', (await state()) === ST.ARCH_DRAWING, await state())

    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    const dgDir = `${h.projectRoot}/.pipeline/${taskId}/reports/diagrammer`
    await mkdir(dgDir, { recursive: true })
    await wf(`${dgDir}/diagrammer-topology.html`, '<html>topology</html>', 'utf8')
    const dg = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'architecture_diagram', role_token: TK.diag, payload: { task_id: taskId, based_on_artifact_version: 'pre-plan', diagram_path: `${dgDir}/diagrammer-topology.html`, produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: '夹具：自备产物' } }, AG.diag)
    if (dg.denied === true) throw new Error(`夹具：交架构图失败：${await state()}\n${dg.text}`)

    const dgH = (await task()).handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
    const s2 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: 'diagram_confirm', artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；覆盖模块 1 个。', reason: '满足要求' } }, AG.sup)
    if (s2.denied === true) throw new Error(`夹具：第②道确认记录失败：\n${s2.text}`)
    const cf = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_diagram', reason: '确认架构图满足要求', role_token: TK.sup }, AG.sup)
    rec.add('F 硬闸门', '★★ 第②道放行 ⇒ **转交需求位**（落点是「架构图待需求位确认」，不再直接到计划位）', cf.denied !== true && (await state()) === ST.ARCH_NEED_CONFIRM, `${await state()} ${cf.text.split('\n')[0]}`)
    rec.add('F 硬闸门', '★★ 第②道的**中文落点**在只读面上是「' + STATE_LABEL[ST.ARCH_NEED_CONFIRM] + '」（不是靠猜状态 id）', STATE_LABEL[ST.ARCH_NEED_CONFIRM] === '架构图待需求位确认', STATE_LABEL[ST.ARCH_NEED_CONFIRM])

    // 反例①：跳过 ②b/②c 直接交计划位 —— 状态表上无路可走。
    const skip = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: TK.main }, AG.main)
    rec.add('F 硬闸门', '★★ **反例（跳过 ②b/②c 交计划）**：`arch_need_confirm` 上派计划位 ⇒ 拒（这一状态下没有 `dispatch_planner` 这条边）', skip.denied === true, skip.text.split('\n')[0])

    // 反例②：主管想直接做"二次确认"，但需求位还没确认 ⇒ 状态机拒。
    const early = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '需求位还没确认，主管先二次确认', role_token: TK.sup }, AG.sup)
    rec.add('F 硬闸门', '★★ **反例（顺序颠倒）**：需求位还没确认，主管就先二次确认 ⇒ 拒（顺序由 `from` 写死在表上）', early.denied === true, early.text.split('\n')[0])

    // 正例：需求位确认（②b）—— 交记录即推进。
    const need = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.orch, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM, artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '图 1 张；与需求口径逐条对得上。', reason: '需求位确认架构图' } }, AG.orch)
    rec.add('F 硬闸门', '★★ **正例（②b）**：需求位确认架构图 ⇒ 状态自动走到「架构图待主管二次确认」', need.denied !== true && (await state()) === ST.ARCH_RECONFIRM, `${await state()} ${need.text.split('\n')[0]}`)

    // 反例③：②c 的确认记录还没交 ⇒ 主管二次确认这条边过不去。
    const noRec = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '没有交 ②c 的确认记录', role_token: TK.sup }, AG.sup)
    rec.add('F 硬闸门', '★★ **反例（②c 缺记录）**：主管没交 `station_confirm{station:"arch_reconfirm"}` ⇒ 边过不去，且拒绝原文**指名还缺谁**', noRec.denied === true && says(noRec, '②c', '还缺'), noRec.text.split('\n')[0])

    // 正例：交 ②c 记录 + 主管二次确认 ⇒ 唤醒点 B，计划位到点。
    const rc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: TK.sup, payload: { task_id: taskId, station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM, artifact_version: dgH.handoff_id, decision: 'ok', basis_refs: [`${dgH.handoff_id}#${dgH.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求位已确认；无问题。', reason: '主管二次确认' } }, AG.sup)
    rec.add('F 硬闸门', '★ **正例（②c 记录）**：主管交 `station_confirm{arch_reconfirm}` ⇒ 通过', rc.denied !== true, rc.text.split('\n')[0])
    const rec2 = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '无问题，交给计划位', role_token: TK.sup }, AG.sup)
    rec.add('F 硬闸门', '★★ **正例（②c）**：主管二次确认 ⇒ 状态到「计划位已唤醒待派」', rec2.denied !== true && (await state()) === ST.STANDBY_PLAN, `${await state()} ${rec2.text.split('\n')[0]}`)

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: TK.main }, AG.main)
    const stations = st.value?.hub?.stations ?? []
    const rowB = stations.find((x) => x.station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM)
    const rowC = stations.find((x) => x.station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM)
    rec.add('F 硬闸门', '★★ **hub 视图看得出这两道新确认**（逐条给出确认方 / 已确认谁 / 还缺谁 / 绑哪份图）', rowB?.is_confirm_station === true && rowC?.is_confirm_station === true && rowB?.confirmed_by?.includes('orchestrator') && rowC?.confirmed_by?.includes('supervisor') && rowB?.target === dgH.handoff_id && rowC?.target === dgH.handoff_id, JSON.stringify({ b: rowB ?? null, c: rowC ?? null }).slice(0, 400))
    const plan = (st.value?.hub?.standby ?? []).find((s) => s.role === 'planner')
    rec.add('F 硬闸门', '★★ **唤醒点 B 挂在二次确认那一跳**：到这一刻计划位才 woken', plan?.status === 'woken', JSON.stringify(plan))

    const dp = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', role_token: TK.main }, AG.main)
    rec.add('F 硬闸门', '★★ **无问题后**才交计划位：派计划 ⇒ 放行（「到点才动」而不是「永远不动」）', dp.denied !== true && (await state()) === ST.PLANNING, `${await state()} ${dp.text.split('\n')[0]}`)
    void t0
  }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/p01-handoff-entry-check.mjs`
// 形状照抄同目录既有的兄弟（只在**本文件被直接执行**时跑一遍并给退出码；
// 被 `run-all.mjs` import 时不产生任何副作用）。
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /p01-handoff-entry-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runP01HandoffEntryCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
