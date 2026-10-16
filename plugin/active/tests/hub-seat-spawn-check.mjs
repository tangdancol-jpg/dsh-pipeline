/**
 * dsh-pipeline · tests/hub-seat-spawn-check.mjs
 * ============================================================================
 * **主管枢纽的「唤醒点要真的派人」+ 自愈补派**（真缺陷：L5 死锁）
 *
 * ── 现场（真机，单 `T-20261016-fullai`）──────────────────────────────────────
 *   ① 主管调 `pipeline_supervise{action:'initiate'}` ⇒ 状态 `pending → analyzing` ✅、
 *      `hub` 账本写入 ✅ —— 但 **`dispatched[]` 里一个需求位都没有**，
 *      主对话静默等了 4 分 13 秒等一个**不会到**的席位。
 *   ② 主对话**手工补派** `pipeline_dispatch{role:'orchestrator'}` ⇒ 成功（人到了）。
 *   ③ 主管 `action=agree_need` ⇒ 状态 `supervising → arch_drawing` ✅ ——
 *      但**架构位没被创建**，而 `pipeline_dispatch{role:'architect'}` 被拒：
 *      「任务还没有角色清单……这个时候唯一能被派出去的角色是：需求分析」。
 *   ④ 角色清单只能由计划位产出；计划位由**唤醒点 B**（`reconfirm_diagram`）唤醒；
 *      唤醒点 B 要架构图；架构图要架构位 ⇒ **环 = 死锁**。
 *
 * ── 本套钉什么（四条，逐条对应修复）────────────────────────────────────────
 *   【A】`initiate` ⇒ **需求位真的被创建**（派活台账有会话 + 新席位拿自己的令牌能开工）
 *   【B】`agree_need` ⇒ **架构位真的被创建**（architect + diagrammer，按待机名册）
 *   【C】`reconfirm_diagram` ⇒ **计划位真的被创建**
 *   【D】幂等：重复触发**不重复派**（同一角色只有一条台账 + 只有一次 `spawnRole`）
 *   【E】自愈：hub 已发起而席位缺位 ⇒ **自动补派 + 留痕**（`hub:seat-respawn`）
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 全程**真工具 + 真守门 + 真状态机**（`createHarness`，模拟通道，零真实会话）；
 *   · 夹具**刻意让 `roster === null`** —— 那就是死锁的真实形状（有清单就绕开了引导步）；
 *   · 「席位真的到了」不靠字段存在与否判，而靠**拿那个席位自己的令牌把活干成**。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/hub-seat-spawn-check
 */

import { mkdir, writeFile } from 'node:fs/promises'

import { createHarness, disposeHarness, callTool } from './selftest-core.mjs'
import { HUB_HANDOFF_CONFIRM_STATIONS, HUB_STATIONS, ST } from '../lib/states.js'

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
      const L = ['dsh-pipeline · 主管枢纽唤醒点派人（状态到了，人也得到）', '='.repeat(78)]
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

/** 一句摘要里有没有那些要点。 */
const says = (r, ...needles) => needles.every((n) => String(r.text).includes(n))

/** 派活台账里某角色的那一条（没有 ⇒ `null`）。 */
const seatOf = (task, role) => (Array.isArray(task?.dispatched) ? task.dispatched : []).find((x) => String(x?.role) === role) ?? null

/**
 * ★ 「这个席位**真的存在**」的判据 —— 与 `nudgeSeat` 找会话用的是**同一条**
 *   （`session_id` 优先，退回 `agent_id`）：两处口径不一致就会出现
 *   "台账里有人、唤醒却投不出去"这种半截现场。
 */
const hasSeat = (rec) => rec !== null && [rec.session_id, rec.agent_id].some((v) => typeof v === 'string' && v.length > 0)

/** 该角色被 `transport.spawnRole` 真的派过几次。 */
const spawnsOf = (h, role) => h.transport.calls.filter((c) => c.kind === 'spawn' && c.role === role).length

export async function runHubSeatSpawnCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    await drive(h, rec)
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 5).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(h, rec) {
  const open = await callTool(h, 'pipeline_task_open', { requirement: '主管枢纽唤醒点派人夹具：状态到了，人也得到。' }, 'sess-main')
  const taskId = open.value.task_id
  const mint = (role, agentId) => {
    const r = h.tokens.mint({ taskId, role, seat: null, agentId })
    const tk = r?.token ?? r?.rec?.token
    if (typeof tk !== 'string') throw new Error(`夹具：铸 ${role} 令牌失败`)
    return tk
  }
  const SUP = { token: mint('supervisor', 'sess-sup'), agent: 'sess-sup' }
  const MAIN = { token: mint('main', 'sess-main'), agent: 'sess-main' }
  const state = async () => (await h.store.get(taskId)).state
  /** ★ 夹具**刻意不写角色清单** —— 那正是现场那条死锁的形状（有清单就绕开了引导步白名单）。 */
  if ((await h.store.get(taskId)).roster !== null) throw new Error('夹具前提不成立：本单不该有角色清单')

  // =========================================================================
  // 【A】initiate ⇒ 需求位真的被创建（现场证据①）
  // =========================================================================
  const init = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '夹具：主管发起三席', role_token: SUP.token }, SUP.agent)
  const t1 = await h.store.get(taskId)
  const orch = seatOf(t1, 'orchestrator')
  rec.add('A 发起面', '★ 发起成功且状态到「需求分析中」（既有判据一个字没动）', init.denied !== true && t1.state === ST.ANALYZING, `${t1.state} ${init.text.split('\n')[0]}`)
  rec.add(
    'A 发起面',
    '★★ **需求位真的被创建**：派活台账里有 orchestrator，且带真会话 id',
    hasSeat(orch) && typeof orch.token === 'string' && orch.token.length > 0,
    JSON.stringify(orch),
  )
  rec.add('A 发起面', '★ 复用**既有派活通道**（会话由 `transport.spawnRole` 建，不是另造一套）', spawnsOf(h, 'orchestrator') === 1, JSON.stringify(h.transport.calls.filter((c) => c.kind === 'spawn').map((c) => c.role)))
  rec.add('A 发起面', '★ 派了人这件事**在返回值里如实写出来**（不许静默）', says(init, '补派'), String(init.text).split('\n').filter((l) => l.includes('补派')).join(' | ').slice(0, 240))

  // ★★ 「人真的到了」的硬判据：拿**那个席位自己的令牌**把需求结论交出来。
  //
  //   ★ 修前（RED）：台账里根本没有 orchestrator ⇒ 这一段如实计一条 ✗；
  //     为了让**后面三条断言也有机会判**（而不是夹具半路抛异常），这里退到夹具自铸的
  //     令牌继续走链 —— 那正是现场第②步「主对话手工补派」的形状，不是把判据放宽。
  const ORCH = orch ?? { token: mint('orchestrator', 'sess-orch'), session_id: 'sess-orch' }
  const a = await callTool(
    h,
    'pipeline_orchestrate',
    { task_id: taskId, task_card: { goal: '把主管做成枢纽' }, acceptance: ['验收1'], test_points: ['要点1'], boundaries: ['边界1'], unclear_points: [], analysis_reason: '依据用户原话', role_scope: { will_do: ['分析'], will_not_do: ['分配'] }, role_token: ORCH.token },
    ORCH.session_id,
  )
  rec.add('A 发起面', '★★ 新需求位**拿自己的令牌就能开工**（交结论 ⇒ 状态到「主管受理中」）', orch !== null && a.denied !== true && (await state()) === ST.SUPERVISING, `${await state()} ${orch === null ? '派活台账里没有 orchestrator（退到夹具令牌继续走链）' : a.text.split('\n')[0]}`)

  // --- 用户确认（既有闸门，一个字没改）------------------------------------
  const hr = await callTool(h, 'pipeline_human_request', { task_id: taskId, reason_kind: 'requirement_confirmation', question_for_human: '按这份理解往下做吗？', context_for_human: '开工前的确认。', blocking: true, blocked_stage: '需求确认', urgency: 'blocking', decision_kind: 'yes_no', timeout_behavior: 'stay_blocked', role_token: ORCH.token }, ORCH.session_id)
  const rid = hr.value?.request_id ?? ''
  await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid, role_token: MAIN.token }, MAIN.agent)
  await callTool(h, 'pipeline_human_reply', { task_id: taskId, request_id: rid, user_quote: '就按这份理解做，验收标准和边界我看过了，没问题。', reply_channel: 'chat', attribution: '用户在当前会话里直接回复', answer: true, role_token: MAIN.token }, MAIN.agent)

  // =========================================================================
  // 【B】agree_need ⇒ 架构位真的被创建（现场证据③：这条此前**死锁**）
  // =========================================================================
  const analysis = (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'requirement_analysis').pop()
  await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: SUP.token, payload: { task_id: taskId, station: HUB_STATIONS.NEED_AGREE, artifact_version: analysis.handoff_id, decision: 'ok', basis_refs: [`${analysis.handoff_id}@${analysis.content_hash}`], basis_kind: 'evidence_digest', basis_digest: '需求结论 1 份；验收 1 条；测试要点 1 条；证据见上。', reason: '满足要求' } }, SUP.agent)

  const agree = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'agree_need', reason: '同意需求结论', role_token: SUP.token }, SUP.agent)
  const t2 = await h.store.get(taskId)
  rec.add('B 唤醒点A', '★ 第①道放行，状态到「架构位出图中」', agree.denied !== true && t2.state === ST.ARCH_DRAWING, `${t2.state} ${agree.text.split('\n')[0]}`)
  const arch = seatOf(t2, 'architect')
  const diag = seatOf(t2, 'diagrammer')
  rec.add(
    'B 唤醒点A',
    '★★ **架构位真的被创建**：architect 就在派活台账里（带真会话 id）',
    hasSeat(arch),
    JSON.stringify(arch),
  )
  rec.add(
    'B 唤醒点A',
    '★ 待机名册里登记在同一唤醒点的 diagrammer **一并派人**（名单是唯一出处，不手抄）',
    hasSeat(diag),
    JSON.stringify(diag),
  )
  rec.add('B 唤醒点A', '★ 唤醒投递**投出去了**（不是"台账里没人 ⇒ 投不出去"）', says(agree, '唤醒投递', '✓'), String(agree.text).split('\n').filter((l) => l.includes('唤醒')).join(' | ').slice(0, 240))

  // ★★ 到点唤醒之后，架构位拿自己的令牌能真的把图交出来（产物面判据：到点即放行）。
  const DIAG = diag ?? { token: mint('diagrammer', 'sess-diag'), session_id: 'sess-diag' }
  const dgDir = `${h.projectRoot}/.pipeline/${taskId}/reports/diagrammer`
  await mkdir(dgDir, { recursive: true })
  await writeFile(`${dgDir}/hub-seat-spawn-diagram.html`, '<html>x</html>', 'utf8')
  const d1 = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'architecture_diagram', role_token: DIAG.token, payload: { task_id: taskId, based_on_artifact_version: 'pre-plan', diagram_path: `${dgDir}/hub-seat-spawn-diagram.html`, produced_by: 'self-provided', covered_modules: ['m1'], degraded: true, degraded_reason: '夹具：自备产物' } }, DIAG.session_id)
  rec.add('B 唤醒点A', '★★ 新架构位**拿自己的令牌就能交图**（⇒ 状态到「架构图待主管确认」）', diag !== null && d1.denied !== true && (await state()) === ST.ARCH_CONFIRM, `${await state()} ${d1.text.split('\n')[0]}`)

  // =========================================================================
  // 【C】reconfirm_diagram ⇒ 计划位真的被创建
  // =========================================================================
  const dg = (await h.store.get(taskId)).handoffs.filter((x) => x.kind === 'architecture_diagram').pop()
  const basis = [`${dg.handoff_id}#${dg.content_hash}`]
  const scBody = (station, decision, why) => ({ task_id: taskId, station, artifact_version: dg.handoff_id, decision, basis_refs: basis, basis_kind: 'evidence_digest', basis_digest: `${station}：图 1 张；覆盖模块 1 个；证据见上。`, reason: why })
  await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: SUP.token, payload: scBody(HUB_STATIONS.DIAGRAM_CONFIRM, 'ok', '满足要求') }, SUP.agent)
  const cf = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_diagram', reason: '确认架构图满足要求', role_token: SUP.token }, SUP.agent)
  rec.add('C 唤醒点B', '★ 第②道确认 ⇒ 转交需求位（②b 确认点）', cf.denied !== true && (await state()) === ST.ARCH_NEED_CONFIRM, `${await state()} ${cf.text.split('\n')[0]}`)
  const nc = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: ORCH.token, payload: scBody(HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM, 'ok', '需求位确认架构图') }, ORCH.session_id)
  rec.add('C 唤醒点B', '★ ②b 需求位确认 ⇒ 递交主管二次确认', nc.denied !== true && (await state()) === ST.ARCH_RECONFIRM, `${await state()} ${nc.text.split('\n')[0]}`)
  await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'station_confirm', role_token: SUP.token, payload: scBody(HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM, 'ok', '主管二次确认') }, SUP.agent)

  const rc = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'reconfirm_diagram', reason: '无问题，交给计划位', role_token: SUP.token }, SUP.agent)
  const t3 = await h.store.get(taskId)
  const plan = seatOf(t3, 'planner')
  rec.add('C 唤醒点B', '★ 主管二次确认 ⇒ 状态到「计划位已唤醒待派」', rc.denied !== true && t3.state === ST.STANDBY_PLAN, `${t3.state} ${rc.text.split('\n')[0]}`)
  rec.add('C 唤醒点B', '★★ **计划位真的被创建**（唤醒点 B 到点 ⇒ 席位存在）', hasSeat(plan), JSON.stringify(plan))
  rec.add('C 唤醒点B', '★★ 计划位**拿自己的令牌**就能交计划（「到点才动」而不是「永远不动」）', await (async () => {
    const dp = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'dispatch_planner', note: '主对话按既有口径派活', role_token: MAIN.token }, MAIN.agent)
    if (dp.denied === true || plan === null) return false
    const pl = await callTool(h, 'pipeline_handoff', { task_id: taskId, kind: 'plan', role_token: plan.token, payload: planPayload(taskId) }, plan.session_id)
    return pl.denied !== true
  })(), `state=${await state()} 计划位台账=${plan === null ? '（没有）' : '有'}`)

  // =========================================================================
  // 【D】幂等：重复触发不重复派
  // =========================================================================
  {
    const before = (await h.store.get(taskId)).dispatched.length
    const beforeSpawns = h.transport.calls.filter((c) => c.kind === 'spawn').length
    // 再查几次状态（自愈每次都跑）+ 主管再确认一次站点（不推进状态的动作）
    await callTool(h, 'pipeline_status', { task_id: taskId, role_token: MAIN.token }, MAIN.agent)
    await callTool(h, 'pipeline_status', { task_id: taskId, role_token: MAIN.token }, MAIN.agent)
    await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'confirm_station', station: HUB_STATIONS.DIAGRAM_CONFIRM, artifact_version: dg.handoff_id, reason: '重复确认一次', role_token: SUP.token }, SUP.agent)
    const after = (await h.store.get(taskId)).dispatched.length
    const afterSpawns = h.transport.calls.filter((c) => c.kind === 'spawn').length
    rec.add('D 幂等', '★★ 反复触发（status ×2 + 主管再动一次）⇒ 派活台账**条数不变**', after === before, `${before} → ${after}`)
    rec.add('D 幂等', '★★ 同一角色**不重复建会话**（spawnRole 次数不变）', afterSpawns === beforeSpawns, `${beforeSpawns} → ${afterSpawns}`)
    const t4 = await h.store.get(taskId)
    const each = ['orchestrator', 'architect', 'diagrammer', 'planner'].every((r) => t4.dispatched.filter((x) => x.role === r).length === 1)
    rec.add('D 幂等', '★ 四席各只有一条台账（orchestrator / architect / diagrammer / planner）', each, JSON.stringify(t4.dispatched.map((x) => x.role)))
  }

  // =========================================================================
  // 【E】自愈：状态到了人没到 ⇒ 自动补派 + 留痕
  // =========================================================================
  {
    // ★ 造出"状态到了、人没到"的形状：把 architect 那条台账拿掉（席位**不存在**了）。
    const t = await h.store.get(taskId)
    t.dispatched = t.dispatched.filter((x) => x.role !== 'architect')
    await writeFile(`${h.projectRoot}/.pipeline/${taskId}/task.json`, JSON.stringify(t, null, 2), 'utf8')
    h.indexTask(taskId, t)
    const spawnsBefore = spawnsOf(h, 'architect')

    const st = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: MAIN.token }, MAIN.agent)
    const t2 = await h.store.get(taskId)
    const healed = seatOf(t2, 'architect')
    rec.add('E 自愈', '★★ 查一次状态就**自动补派**（不必靠人工发现）', hasSeat(healed) && spawnsOf(h, 'architect') === spawnsBefore + 1, JSON.stringify(healed))
    rec.add('E 自愈', '★ 自愈这件事**在返回值里说出来**（不许静默）', says(st, '补派'), String(st.text).split('\n').filter((l) => l.includes('补派')).join(' | ').slice(0, 240))
    rec.add('E 自愈', '★★ **留痕**：`hub:seat-respawn` 进 task.history（谁在什么时候补的谁）', (t2.history ?? []).some((x) => x.action === 'hub:seat-respawn' && String(x.role ?? '') === 'architect'), JSON.stringify((t2.history ?? []).filter((x) => x.action === 'hub:seat-respawn').map((x) => ({ role: x.role, ok: x.ok, by: x.actor, via: x.via }))))
    const again = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: MAIN.token }, MAIN.agent)
    rec.add('E 自愈', '★ 补过之后**不再重复补**（幂等）', spawnsOf(h, 'architect') === spawnsBefore + 1 && !says(again, '补派'), `spawns=${spawnsOf(h, 'architect')} 二次摘要含"补派"=${says(again, '补派')}`)
  }

  // =========================================================================
  // 【F】边界：终态 / 已阻塞上**没有"该到的人"** —— 自愈不许替人做决定
  // =========================================================================
  {
    const put = async (mut) => {
      const t = await h.store.get(taskId)
      mut(t)
      await writeFile(`${h.projectRoot}/.pipeline/${taskId}/task.json`, JSON.stringify(t, null, 2), 'utf8')
      h.indexTask(taskId, t)
    }
    const noSeat = (t) => {
      t.dispatched = t.dispatched.filter((x) => x.role !== 'planner')
    }
    for (const [state, zh] of [[ST.BLOCKED, '已阻塞'], [ST.CANCELLED, '已取消']]) {
      await put((t) => {
        noSeat(t)
        t.state = state
      })
      const before = spawnsOf(h, 'planner')
      const r = await callTool(h, 'pipeline_status', { task_id: taskId, role_token: MAIN.token }, MAIN.agent)
      rec.add(
        'F 边界',
        `★★ ${zh}的单缺位 ⇒ **不补派**（blocked 的恢复路径是 \`reassign: true\` 这个明确动作，不是"查一眼"）`,
        spawnsOf(h, 'planner') === before && !says(r, '补派'),
        `state=${state} spawns ${before} → ${spawnsOf(h, 'planner')}`,
      )
    }
  }
}

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

/** 单跑本文件（被 `run-all.mjs` 发现时不走这里）。 */
if (process.argv[1] !== undefined && /hub-seat-spawn-check\.mjs$/.test(String(process.argv[1]).replace(/\\/g, '/'))) {
  const r = await runHubSeatSpawnCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
