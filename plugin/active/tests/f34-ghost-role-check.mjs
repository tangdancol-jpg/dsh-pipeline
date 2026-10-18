// P2-17 回归：状态机投影 —— **不在册的角色不展示其"下一步合法事件"**（幽灵 supervisor 修复）。
/**
 * dsh-pipeline · F34：状态机投影的幽灵角色（P2-17）
 * ============================================================================
 *     node tests/f34-ghost-role-check.mjs
 *
 * 现场：`ready_test` 等状态下 `pipeline_status` 的「下一步合法事件」会列出 `supervisor`
 * —— 可本档的计划**根本没派主管**（roster 里没有它），调度者照着那一行去点只会被拒。
 * 根因：`'*'` 那几条侧路边（`clarification_request` / `human_request`）的 `by` 是
 * **角色全集**，投影时把全集当成了"这一刻谁都能点"。
 *
 * 修法：判据收敛到**状态机投影一处**（`lib/states/transitions.js` 的
 * `projectedNextEvents`），`pipeline_status` 只消费它：
 *   · `main` / `human` 恒展示；
 *   · `supervisor` —— **hub 已启用 且 主管席位在册** 才展示；
 *   · `rule-engine` —— 只在 L0（`orchestrator_mode === 'rule-engine'`）；
 *   · 其余角色 —— 看 `roster.conversations`；roster 还没产出 ⇒ 不过滤；
 *   · `by` 过滤后为空的事件整条不展示。
 *
 * ★ 状态机本身（TRANSITIONS / applyTransition）与守门判据**一个字节没动** —— 本套同时钉住
 *   "投影是减法，不是放宽"：被过滤掉的事件直接调状态机，照旧按 `by` 名单拒。
 */

import { pathToFileURL } from 'node:url'

import { createGuardFixture, disposeHarness, callTool } from './selftest-core.mjs'
import {
  TRANSITIONS,
  availableTransitions,
  applyTransition,
  projectedNextEvents,
  projectedRoleVisible,
  projectedTransitions,
} from '../lib/states.js'

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
      const L = ['dsh-pipeline · F34：状态机投影不展示幽灵角色（P2-17）', '='.repeat(78)]
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

/** 事件列表 → 一行可读（`event[by]`），报告里用。 */
const fmt = (events) => (events.length === 0 ? '（空）' : events.map((e) => `${e.event}[${(e.by ?? []).join('/')}]`).join(' · '))

/** 某个角色是否出现在任一事件的 `by` 里。 */
const hasRole = (events, role) => events.some((e) => (e.by ?? []).includes(role))

/** 一份"没派 supervisor 的 L2 任务"（roster 有独立 orchestrator/planner，无 supervisor）。 */
function l2Task(over = {}) {
  return {
    id: 'T-F34-L2',
    state: 'ready_test',
    roster: {
      tier: 'L2',
      orchestrator_mode: 'separate',
      conversations: ['main', 'orchestrator', 'planner', 'architect', 'writer', 'tester', 'reviewer', 'diagrammer', 'archivist'],
      execution_roles: ['architect', 'writer', 'tester', 'reviewer', 'diagrammer', 'archivist'],
    },
    /** 开单时"先设后撤"，低档位在需求确认时撤销 —— 撤过 ⇒ 不在册。 */
    hub_requirement: { forced: false, revoked_at: '2026-01-01T00:00:00Z' },
    hub: null,
    ...over,
  }
}

/** 一份"枢纽已启用、主管在册"的任务（supervising 状态）。 */
function hubTask(over = {}) {
  return {
    id: 'T-F34-HUB',
    state: 'supervising',
    roster: {
      tier: 'L4',
      orchestrator_mode: 'separate',
      conversations: ['main', 'orchestrator', 'planner', 'supervisor', 'architect', 'writer', 'tester', 'reviewer', 'diagrammer', 'archivist'],
      execution_roles: ['architect', 'writer', 'tester', 'reviewer', 'diagrammer', 'archivist'],
    },
    hub: { enabled: true },
    hub_requirement: { forced: true, revoked_at: null },
    ...over,
  }
}

/**
 * 跑 F34 自测。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
export async function runF34GhostRoleCheck() {
  const rec = createRecorder()
  try {
    // =====================================================================
    // A 纯函数：投影按"在册"过滤
    // =====================================================================
    {
      const G = 'A 投影判据（纯函数）'
      const noSup = l2Task()
      const ev = projectedNextEvents(noSup)
      rec.add(
        G,
        '★★ 没有 supervisor 的 L2 任务：`ready_test` 的下一步里**没有** supervisor 的事件',
        ev.length > 0 && !hasRole(ev, 'supervisor'),
        fmt(ev),
      )
      rec.add(
        G,
        '★★ 过滤不是"全砍"：主对话的 `dispatch_tester` 与侧路边照旧在',
        ev.some((e) => e.event === 'dispatch_tester' && (e.by ?? []).includes('main')) && ev.some((e) => e.event === 'human_request'),
        fmt(ev),
      )
      rec.add(
        G,
        '★ `by` 名单也收敛到在册角色（清单外的 orchestrator/planner 等一个不剩）',
        ev.every((e) => (e.by ?? []).every((r) => r === 'main' || r === 'human' || noSup.roster.conversations.includes(r))),
        fmt(ev),
      )
      rec.add(
        G,
        '★ supervisor 席位在册、但 hub **未启用** ⇒ 仍不展示（P2-17 的"hub 启用且在册"两条缺一不可）',
        projectedRoleVisible({ ...noSup, roster: { ...noSup.roster, conversations: [...noSup.roster.conversations, 'supervisor'] }, hub_requirement: { forced: true } }, 'supervisor') === false,
        `hub=${JSON.stringify(noSup.hub)}`,
      )
      rec.add(
        G,
        '★ `rule-engine` 只在 L0（`orchestrator_mode=rule-engine`）投影，与"被派的角色"分开判',
        projectedRoleVisible({ roster: { orchestrator_mode: 'rule-engine', conversations: ['main', 'writer', 'tester', 'reviewer'] } }, 'rule-engine') === true &&
          projectedRoleVisible({ roster: { orchestrator_mode: 'separate', conversations: ['main', 'writer', 'tester', 'reviewer'] } }, 'rule-engine') === false,
        'L0 true / separate false',
      )

      const hub = hubTask()
      const evHub = projectedNextEvents(hub)
      rec.add(
        G,
        '★★ hub 启用 + 主管在册 ⇒ supervisor 事件**正常出现**（`by=["supervisor"]`）',
        evHub.some((e) => e.event === 'supervisor_agree_need' && (e.by ?? []).join('/') === 'supervisor'),
        fmt(evHub),
      )
      rec.add(
        G,
        '★ hub 未启用（同一份名单）⇒ supervisor 事件消失',
        !hasRole(projectedNextEvents({ ...hub, hub: { enabled: false } }), 'supervisor'),
        fmt(projectedNextEvents({ ...hub, hub: { enabled: false } })),
      )
      rec.add(
        G,
        '★ "先设后撤"留下的席位（`hub_requirement.forced=true`）也算在册（与 `hubSeatPresent` 同源）',
        projectedRoleVisible({ roster: { conversations: ['main'] }, hub: { enabled: true }, hub_requirement: { forced: true, revoked_at: null } }, 'supervisor') === true &&
          projectedRoleVisible({ roster: { conversations: ['main'] }, hub: { enabled: true }, hub_requirement: { forced: false, revoked_at: '2026-01-01T00:00:00Z' } }, 'supervisor') === false,
        'forced=true ⇒ 展示；已撤销 ⇒ 不展示',
      )
    }

    // =====================================================================
    // B 投影是**减法**：状态机本身一个字节没动
    // =====================================================================
    {
      const G = 'B 投影是减法（状态机没变）'
      const raw = availableTransitions('supervising')
      rec.add(
        G,
        '★★ 官方边表仍是全集（`availableTransitions` 没被投影改掉）',
        raw.some((t) => t.event === 'supervisor_agree_need' && (t.by ?? []).includes('supervisor')),
        `raw 共 ${raw.length} 条`,
      )
      rec.add(
        G,
        '★★ 被投影过滤掉的事件**直接调状态机照旧被拒**（不是放宽，只是不展示）',
        applyTransition('ready_test', 'supervisor_agree_need', 'supervisor').ok !== true,
        JSON.stringify(applyTransition('ready_test', 'supervisor_agree_need', 'supervisor')).slice(0, 200),
      )
      rec.add(
        G,
        '★ TRANSITIONS 里 supervisor 那条边的 by 名单没被动过',
        (TRANSITIONS.find((t) => t.event === 'supervisor_agree_need')?.by ?? []).join('/') === 'supervisor',
        JSON.stringify(TRANSITIONS.find((t) => t.event === 'supervisor_agree_need')?.by),
      )
    }

    // =====================================================================
    // C 集成：真实任务上的 `pipeline_status` / `store.status`
    // =====================================================================
    {
      const G = 'C 集成：pipeline_status 不投幽灵角色'
      /** 一个真实走过的 L0 任务（停在 testing）：roster 里没有 supervisor。 */
      const f = await createGuardFixture({ stopAfter: 5 })
      try {
        const task = f.h.store.peek(f.taskId)
        rec.add(
          G,
          '（前置）真实任务停在 testing、名单里没有 supervisor',
          task.state === 'testing' && !(task.roster?.conversations ?? []).includes('supervisor'),
          `state=${task.state} convs=${(task.roster?.conversations ?? []).join(' / ')}`,
        )

        const st = await f.h.store.status({ taskId: f.taskId, redactForMain: true })
        rec.add(
          G,
          '★★ `store.status.next_events`（pipeline_status 的数据源）里不含 supervisor',
          st.ok === true && Array.isArray(st.next_events) && st.next_events.length > 0 && !hasRole(st.next_events, 'supervisor'),
          fmt(st.next_events ?? []),
        )
        rec.add(
          G,
          '★ `by` 名单与 roster 一致（不在册角色不出现）',
          (st.next_events ?? []).every((e) => (e.by ?? []).every((r) => r === 'main' || r === 'human' || (task.roster?.conversations ?? []).includes(r))),
          fmt(st.next_events ?? []),
        )

        const full = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
        const fullText = String(full.value?.summary ?? '')
        rec.add(
          G,
          '★★ 全文正文的「下一步合法事件」一节里也没有 supervisor',
          full.denied !== true && fullText.includes('下一步合法事件') && !fullText.includes('supervisor'),
          fullText.split('\n').filter((l) => l.includes('下一步') || l.includes('supervisor')).join('\n'),
        )
        const brief = await callTool(
          f.h,
          'pipeline_status',
          { task_id: f.taskId, role_token: f.tokens.main, detail: 'summary' },
          f.agents.main,
        )
        rec.add(
          G,
          '★ 紧凑档的「下一步该谁」同样不出现 supervisor',
          brief.denied !== true && !String(brief.value?.summary ?? '').includes('supervisor'),
          String(brief.value?.summary ?? '').split('\n').slice(0, 4).join('\n'),
        )

        // ---- 正向：同一任务改成"枢纽已启用 + 主管在册" ⇒ supervisor 事件出现 ----
        const t = f.h.store.peek(f.taskId)
        t.hub = { enabled: true }
        t.roster.conversations = [...(t.roster.conversations ?? []), 'supervisor']
        t.state = 'supervising'
        const stHub = await f.h.store.status({ taskId: f.taskId, redactForMain: true })
        rec.add(
          G,
          '★★ 同一任务 hub 启用 + 主管在册 ⇒ supervisor 事件**正常出现**（"有则正常"）',
          stHub.ok === true && (stHub.next_events ?? []).some((e) => e.event === 'supervisor_agree_need' && (e.by ?? []).join('/') === 'supervisor'),
          fmt(stHub.next_events ?? []),
        )
        const fullHub = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
        rec.add(
          G,
          '★ 该正向任务的全文档正文能照抄到 `supervisor` 的调用形状',
          fullHub.denied !== true && String(fullHub.value?.summary ?? '').includes('supervisor_agree_need'),
          String(fullHub.value?.summary ?? '').split('\n').filter((l) => l.includes('supervisor')).slice(0, 2).join('\n'),
        )
      } finally {
        await disposeHarness(f.h)
      }
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF34GhostRoleCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
