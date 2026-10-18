// P2-17 残余回归：**"已先设主管、hub 还没 initiate"** 也必须在投影里可见。
/**
 * dsh-pipeline · F42：supervisor 展示口径（P2-17 残余）
 * ============================================================================
 *     node tests/f42-supervisor-visible-check.mjs
 *
 * 现场：按裁定 1「开单**先强制设主管**」——`hub_requirement.forced=true` 在 `pending` 那一刻就落账，
 * 而 `hub.enabled` 要等主管 `pipeline_supervise action=initiate` 才为真。这段时间里主管
 * **确实在册**（`hubSeatPresent` 认它），P2-17 的投影判据却要求"hub 已启用 **且** 在册"，
 * 于是主管照着 `pipeline_status` 找不到自己该点的动作（幽灵角色的另一半）。
 *
 * 用户 2026-10-19 拍板（**仅这一处**）：投影里 supervisor 可见性条件从 `hub.enabled`
 * 改为 **`hub.enabled || hub.forcedSeat`**；状态机判据（`TRANSITIONS` / `applyTransition` /
 * 守门）一个字节不动。
 *
 * 钉住：
 *   A 三态口径：enabled / forcedSeat / 撤销后 各自可见性
 *   B 投影事件：forcedSeat=true 且 hub 未启用 ⇒ supervisor 的事件出现；撤销后消失
 *   C 投影是减法：状态机的边表与 `applyTransition` 没变
 *   D 集成：`store.status` / `pipeline_status` 在"先设主管"阶段就把 supervisor 展示出来
 */

import { pathToFileURL } from 'node:url'

import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'
import {
  TRANSITIONS,
  applyTransition,
  availableTransitions,
  projectedNextEvents,
  projectedRoleVisible,
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
      const L = ['dsh-pipeline · F42：supervisor 展示口径（P2-17 残余）', '='.repeat(78)]
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

const fmt = (events) => (events.length === 0 ? '（空）' : events.map((e) => `${e.event}[${(e.by ?? []).join('/')}]`).join(' · '))
const hasSupervisor = (events) => events.some((e) => (e.by ?? []).includes('supervisor'))

/** 一张"枢纽状态可控"的任务（纯函数投影用例用）。 */
function taskWith({ hub = null, requirement = undefined, conversations = null, state = 'supervising' } = {}) {
  return {
    id: 'T-F42',
    state,
    roster: conversations === null ? null : { tier: 'L4', orchestrator_mode: 'separate', conversations, execution_roles: [] },
    hub,
    ...(requirement === undefined ? {} : { hub_requirement: requirement }),
  }
}

export async function runF42SupervisorVisibleCheck() {
  const rec = createRecorder()
  try {
    // =====================================================================
    // A 三态口径：`hub.enabled || hub.forcedSeat`
    // =====================================================================
    {
      const G = 'A 可见性口径'
      const withSup = ['main', 'orchestrator', 'planner', 'supervisor', 'writer', 'tester', 'reviewer']
      const noSup = withSup.filter((r) => r !== 'supervisor')

      rec.add(
        G,
        '★ 既有口径不变：`hub.enabled=true` + 主管在册 ⇒ 可见',
        projectedRoleVisible(taskWith({ hub: { enabled: true }, requirement: { forced: true, revoked_at: null }, conversations: withSup }), 'supervisor') === true,
        'enabled + 在册',
      )
      rec.add(
        G,
        '★★ **新口径**：hub 未启用，但"先设主管"的账还在（`forced=true / 未撤销`）⇒ **可见**',
        projectedRoleVisible(taskWith({ hub: null, requirement: { forced: true, revoked_at: null }, conversations: noSup }), 'supervisor') === true &&
          projectedRoleVisible(taskWith({ hub: { enabled: false }, requirement: { forced: true, revoked_at: null }, conversations: null }), 'supervisor') === true,
        'forcedSeat=true ⇒ 可见（含 roster 还没产出 / 名单里没写 supervisor 两种形状）',
      )
      rec.add(
        G,
        '★★ 撤销之后（低档位 requirement_confirmed 撤主管）⇒ 不可见（P2-17 的"幽灵角色"不许回来）',
        projectedRoleVisible(taskWith({ hub: null, requirement: { forced: false, revoked_at: '2026-01-01T00:00:00Z' }, conversations: noSup }), 'supervisor') === false &&
          projectedRoleVisible(taskWith({ hub: { enabled: false }, requirement: { forced: true, revoked_at: '2026-01-01T00:00:00Z' }, conversations: noSup }), 'supervisor') === false,
        'revoked_at 有值 ⇒ 不可见',
      )
      rec.add(
        G,
        '★ 既没有 hub 也没有强制主管记录 ⇒ 不可见（不凭空展示）',
        projectedRoleVisible(taskWith({ hub: null, requirement: undefined, conversations: noSup }), 'supervisor') === false,
        '无记录 ⇒ 不可见',
      )
      rec.add(
        G,
        '★ 其它角色不受影响：main 恒在；名单内的 writer 可见、名单外的 writer 不可见',
        projectedRoleVisible(taskWith({ conversations: withSup }), 'main') === true &&
          projectedRoleVisible(taskWith({ conversations: withSup }), 'writer') === true &&
          projectedRoleVisible(taskWith({ conversations: ['main', 'tester'] }), 'writer') === false,
        'main / writer',
      )
    }

    // =====================================================================
    // B 投影事件：forcedSeat=true 且 hub 未启用 ⇒ supervisor 的事件出现
    // =====================================================================
    {
      const G = 'B 投影事件'
      const forcedOnly = taskWith({ hub: null, requirement: { forced: true, revoked_at: null }, conversations: ['main', 'orchestrator', 'planner', 'writer', 'tester', 'reviewer'] })
      const ev = projectedNextEvents(forcedOnly)
      rec.add(
        G,
        '★★ "先设主管、hub 未 initiate" ⇒ `supervising` 投影里**出现** supervisor 的事件',
        ev.length > 0 && hasSupervisor(ev),
        fmt(ev),
      )
      rec.add(
        G,
        '★ 同一张单撤销主管之后 ⇒ supervisor 的事件**消失**（不展示幽灵角色）',
        !hasSupervisor(projectedNextEvents({ ...forcedOnly, hub_requirement: { forced: false, revoked_at: '2026-01-01T00:00:00Z' } })),
        fmt(projectedNextEvents({ ...forcedOnly, hub_requirement: { forced: false, revoked_at: '2026-01-01T00:00:00Z' } })),
      )
      rec.add(
        G,
        '★ 名单还没产出（roster=null）+ forcedSeat ⇒ 仍能看见 supervisor（开单那一刻的形状）',
        hasSupervisor(projectedNextEvents(taskWith({ hub: null, requirement: { forced: true, revoked_at: null }, conversations: null }))),
        fmt(projectedNextEvents(taskWith({ hub: null, requirement: { forced: true, revoked_at: null }, conversations: null }))),
      )
      rec.add(
        G,
        '★ 其它角色照旧在（过滤是减法，不是把事件全砍掉）',
        ev.some((e) => e.event === 'human_request'),
        fmt(ev),
      )
    }

    // =====================================================================
    // C 投影是减法：状态机的边表 / applyTransition 没被改
    // =====================================================================
    {
      const G = 'C 状态机判据没动'
      const raw = availableTransitions('supervising')
      rec.add(
        G,
        '★★ 官方边表不变：`supervising` 仍有 supervisor 的 `supervisor_agree_need`（by=supervisor）',
        raw.some((t) => t.event === 'supervisor_agree_need' && (t.by ?? []).join('/') === 'supervisor'),
        `raw 共 ${raw.length} 条`,
      )
      rec.add(
        G,
        '★★ 状态机本身仍是那个名单：`ready_test` 上直接调 `supervisor_agree_need` 照旧被拒（投影不放宽状态机）',
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
    // D 集成：store.status / pipeline_status 在"先设主管"阶段就展示 supervisor
    // =====================================================================
    {
      const G = 'D 集成：pipeline_status / store.status'
      const f = await createGuardFixture({ stopAfter: 5 })
      try {
        const t = f.h.store.peek(f.taskId)
        const forcedSeat = t.hub_requirement?.forced === true && (t.hub_requirement?.revoked_at ?? null) === null
        rec.add(
          G,
          '（前置）真实 L0 任务：forced=true 但**档位不需要主管** ⇒ 不展示（forcedSeat 只在 L3+ 算在册）',
          projectedRoleVisible(t, 'supervisor') === false && forcedSeat === true,
          `tier=${String(t.roster?.tier)} hub.enabled=${String(t.hub?.enabled)} forced=${String(t.hub_requirement?.forced)} 可见=${projectedRoleVisible(t, 'supervisor')}`,
        )

        // 模拟"开单先强制设主管、hub 还没 initiate"这一刻：账在、hub 未启用、名单里没写 supervisor。
        // 用 L4 档位（主管真正适用的档位）来验："先设后撤"阶段主管可见。
        t.roster = { ...(t.roster ?? {}), tier: 'L4', conversations: Array.isArray(t.roster?.conversations) ? t.roster.conversations : [] }
        t.hub = null
        t.hub_requirement = { forced: true, revoked_at: null }
        t.state = 'supervising'
        const st = await f.h.store.status({ taskId: f.taskId, redactForMain: true })
        rec.add(
          G,
          '★★ `store.status.next_events`：forcedSeat=true 且 hub 未启用 ⇒ supervisor 的事件**出现**',
          st.ok === true && hasSupervisor(st.next_events ?? []),
          fmt(st.next_events ?? []),
        )
        const full = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
        const text = String(full.value?.summary ?? '')
        rec.add(
          G,
          '★★ `pipeline_status` 全文正文能照抄到 `supervisor` 的调用形状（主管自己找得到入口）',
          full.denied !== true && text.includes('supervisor_agree_need'),
          text.split('\n').filter((l) => l.includes('supervisor')).slice(0, 3).join('\n'),
        )
        const brief = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, role_token: f.tokens.main, detail: 'summary' }, f.agents.main)
        rec.add(
          G,
          '★ 紧凑档「下一步该谁」里也能看到 supervisor',
          brief.denied !== true && String(brief.value?.summary ?? '').includes('supervisor'),
          String(brief.value?.summary ?? '').split('\n').slice(0, 4).join('\n'),
        )

        // 撤销之后：展示面立刻收回（同一个任务，不改任何状态机数据）。
        t.hub_requirement = { forced: false, revoked_at: '2026-01-01T00:00:00Z' }
        const st2 = await f.h.store.status({ taskId: f.taskId, redactForMain: true })
        rec.add(
          G,
          '★ 撤销主管之后同一张单 ⇒ store.status 里 supervisor 又消失（展示口径可逆）',
          st2.ok === true && !hasSupervisor(st2.next_events ?? []),
          fmt(st2.next_events ?? []),
        )
      } finally {
        await disposeHarness(f.h)
      }
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF42SupervisorVisibleCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
