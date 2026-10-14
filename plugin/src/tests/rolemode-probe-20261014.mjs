/**
 * dsh-pipeline / tests/rolemode-probe-20261014.mjs
 * ============================================================================
 * **本轮复测专用探针**：证明「1d 角色专属模式」那条需求现在**有可复跑的代码层判据**。
 *
 * 背景（复测核实结果）：改前，派活取值路径（旧 `pickRosterSlots`）只读
 * `roster.writers.partitions[].mode` 与 `roster.sequence[].mode` 两处**裸字段**，
 * 而这两处从来不承载四槽 ⇒ 取值恒为 undefined ⇒ **模式恒为全局默认值**，
 * 权威冻结表 `roster.slots` 没有任何派活路径读它。
 *
 * 本探针用**真实构造函数**（`buildRosterSlots`）产出名单四槽表，再走
 * **新的取值入口**（`rosterSlotDeclarations`）读回来，逐条断言：
 *   ① 按角色声明不同模式 ⇒ 每个角色取到**各自的**模式（这是本轮修复点）；
 *   ② origin==='default' 的占位值**不**被当成声明（审计不许说谎）；
 *   ③ 名单没有四槽 ⇒ 返回 `{}`（与改造前逐字节等价，仍走通道兜底）；
 *   ④ 裸声明（手写名单）仍被兼容；
 *   ⑤ `roleModePlan` 的判据在「7 个角色全是 standard」时如实报不成立。
 *
 * ★ 只读：不写盘、不建会话、不改任何既有测试文件。
 * 用法：node tests/rolemode-probe-20261014.mjs
 * @module dsh-pipeline/tests/rolemode-probe-20261014
 */

import { buildRosterSlots, roleModePlan, rosterSlotDeclarations } from '../lib/tiers.js'
import { ROLE } from '../lib/roles.js'

const items = []
const add = (name, pass, detail = '') => items.push({ name, pass: pass === true, detail: String(detail) })

// ---------------------------------------------------------------------------
// ① 权威冻结表：按角色声明**各自不同**的模式
// ---------------------------------------------------------------------------
const conversations = [ROLE.ORCHESTRATOR, ROLE.PLANNER, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHIVIST]
const built = buildRosterSlots(conversations, null, {
  slots: {
    [ROLE.TESTER]: { permission: 'workspace-write', mode: 'mode-alpha', model: 'm', reasoning: 'high' },
    [ROLE.REVIEWER]: { permission: 'read-only', mode: 'mode-beta', model: 'm', reasoning: 'low' },
    [ROLE.ARCHIVIST]: { permission: 'read-only', mode: 'mode-gamma', model: 'm', reasoning: 'low' },
  },
})
add('① buildRosterSlots 接受按角色分列的四槽声明', built.ok === true, built.ok === true ? `slots 键：${Object.keys(built.slots).join('、')}` : built.error)
if (built.ok !== true) {
  console.error(built.error)
  process.exit(1)
}

const roster = { slots: built.slots, sequence: [{ role: ROLE.TESTER, phase: 'x', order: 1, requires: [] }], writers: null }

const tester = rosterSlotDeclarations(roster, ROLE.TESTER, null)
const reviewer = rosterSlotDeclarations(roster, ROLE.REVIEWER, null)
const archivist = rosterSlotDeclarations(roster, ROLE.ARCHIVIST, null)

add('① tester 取到自己的 mode', tester.mode === 'mode-alpha', JSON.stringify(tester))
add('① reviewer 取到**另一个** mode', reviewer.mode === 'mode-beta', JSON.stringify(reviewer))
add('① archivist 取到第三个 mode', archivist.mode === 'mode-gamma', JSON.stringify(archivist))
add(
  '①★ 「一个 AI 一个专属模式」在取值层真的成立（三者互不相同）',
  new Set([tester.mode, reviewer.mode, archivist.mode]).size === 3,
  `${tester.mode} / ${reviewer.mode} / ${archivist.mode}`,
)

// ---------------------------------------------------------------------------
// ② origin==='default' 的占位值不算声明
// ---------------------------------------------------------------------------
const undeclared = rosterSlotDeclarations(roster, ROLE.ORCHESTRATOR, null)
add(
  '② 未声明的角色（origin=default）不被当成"声明过"',
  Object.keys(undeclared).length === 0,
  `取到：${JSON.stringify(undeclared)}（权威表里 orchestrator 的 mode 是 default 占位 standard）`,
)

// ---------------------------------------------------------------------------
// ③ 名单没有四槽 ⇒ 空操作（与改造前逐字节等价）
// ---------------------------------------------------------------------------
const bare = {
  sequence: [{ role: ROLE.TESTER, phase: 'x', order: 1, requires: [] }],
  writers: { partitions: [{ seat: 'writer#1', role_id: ROLE.WRITER, layer: 'all' }] },
}
add('③ 无 slots 表 ⇒ 角色取值返回 {}（仍走通道兜底）', Object.keys(rosterSlotDeclarations(bare, ROLE.TESTER, null)).length === 0, JSON.stringify(rosterSlotDeclarations(bare, ROLE.TESTER, null)))
add('③ 无 slots 表 ⇒ 席位取值返回 {}', Object.keys(rosterSlotDeclarations(bare, ROLE.WRITER, 'writer#1')).length === 0, '')
add('③ 传 null 名单不抛', Object.keys(rosterSlotDeclarations(null, ROLE.TESTER, null)).length === 0, '')

// ---------------------------------------------------------------------------
// ④ 裸声明仍被兼容（手写名单：sequence[] 上直接挂 mode）
// ---------------------------------------------------------------------------
const handWritten = { sequence: [{ role: ROLE.TESTER, mode: 'mode-handwritten' }] }
add('④ 兼容手写名单：sequence[].mode 仍取得到', rosterSlotDeclarations(handWritten, ROLE.TESTER, null).mode === 'mode-handwritten', JSON.stringify(rosterSlotDeclarations(handWritten, ROLE.TESTER, null)))

const seatKey = {}
seatKey[`${ROLE.WRITER}@writer#2`] = { mode: { value: 'mode-seat2', origin: 'declared' } }
const seatRoster = { slots: seatKey, writers: { partitions: [{ seat: 'writer#2', mode: 'mode-partition' }] } }
add(
  '④ 分席位键优先于裸字段（权威表赢）',
  rosterSlotDeclarations(seatRoster, ROLE.WRITER, 'writer#2').mode === 'mode-seat2',
  JSON.stringify(rosterSlotDeclarations(seatRoster, ROLE.WRITER, 'writer#2')),
)

// ---------------------------------------------------------------------------
// ⑤ roleModePlan：判据本身能如实报"不成立"
// ---------------------------------------------------------------------------
const planMixed = roleModePlan({ slots: built.slots })
add(
  '⑤ 混装名单：distinct≥2 ⇒ per_role_ok=true',
  planMixed.per_role_ok === true && planMixed.declared_count === 3,
  `declared=${planMixed.declared_count} distinct=${planMixed.distinct_declared_modes} rows=${planMixed.total}`,
)

// 现场还原：6884af 真单上 7 个角色的 mode 槽**全是 standard** ⇒ 判据必须报"不成立"
const allStandard = {}
for (const r of [ROLE.ORCHESTRATOR, ROLE.PLANNER, ROLE.SUPERVISOR, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHIVIST, ROLE.WRITER]) {
  allStandard[r] = { permission: { value: 'read-only', origin: 'declared' }, mode: { value: 'standard', origin: 'declared' }, model: { value: 'environment-default', origin: 'declared' }, reasoning: { value: 'environment-default', origin: 'declared' } }
}
const planFlat = roleModePlan({ slots: allStandard })
add(
  '⑤★ 现场形状（7 个角色模式全 = "standard"）⇒ 判据如实报「不是一人一模式」',
  planFlat.per_role_ok === false && planFlat.declared_count === 7 && planFlat.distinct_declared_modes === 1,
  `declared=${planFlat.declared_count} distinct=${planFlat.distinct_declared_modes} per_role_ok=${planFlat.per_role_ok} —— 这正是 1d 长期「未核实」的数据面`,
)
add('⑤ 空名单不抛且报不成立', roleModePlan(null).per_role_ok === false, JSON.stringify(roleModePlan(null)))

// ---------------------------------------------------------------------------
const passed = items.filter((i) => i.pass).length
const L = []
L.push('dsh-pipeline · 1d 角色专属模式 · 取值层判据探针（2026-10-14 复测）')
L.push('='.repeat(78))
for (const it of items) L.push(`${it.pass ? '  ✓' : '  ✗'} ${it.name}${it.detail ? `\n      ${it.detail}` : ''}`)
L.push('')
L.push('='.repeat(78))
L.push(`总计：${passed}/${items.length} 通过`)
L.push('='.repeat(78))
process.stdout.write(L.join('\n') + '\n')
process.exit(passed === items.length ? 0 : 1)
