/**
 * dsh-pipeline · 缺陷 ②：`roster.slots.permission` 是惰性/误导字段
 * ============================================================================
 *     node tests/f2-slot-truth-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：
 *   · writer / tester / reviewer 三席在 `roster.slots` 里回读**全是 `read-only`
 *     （origin: default）**，可三席**全都写成功了**；
 *   · 主对话显式传了 `permission: workspace-write`，派活输出还回读"**核对一致**"，
 *     而槽位里**仍然**是 read-only。
 *   根因：`roster.slots` 是**声明表**，派活真正生效的档来自另一条优先级；
 *   两边都没错，但**没人把"实际生效值"记下来** ⇒ 字段在误导。
 *
 * 本套钉住五件事：
 *   A. **接线**：`origin=declared` 的槽是冻结的 —— 请求与它不符 ⇒ **拒绝派活**；
 *   B. **现场形状照旧放行**：`origin=default` 的占位值可以被请求覆盖（否则 L0 全被挡死）；
 *   C. **如实登记**：覆盖必须被**点名**（`divergences` 三要素：名单值 / 占位来源 / 实际值）；
 *   D. **落盘**：`task.dispatch_slots[]` 记下 `effective`，从此"这席拿到什么档"可查；
 *   E. **不越权**：纯函数不改名单；名单没有四槽时是**空操作**（与改前逐字节等价）。
 *
 * ★ 全程密闭：不建会话、不投递；store 部分用真 store + 自造临时项目根。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describeSlotDivergence, resolveEffectiveSlots, rosterSlotEntry, SLOT_ORIGIN } from '../lib/roster/slot-truth.js'
import { createTaskStore } from '../lib/store.js'

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
      const L = ['dsh-pipeline · 缺陷 ②：roster.slots 是声明表，不是"实际拿到了什么"', '='.repeat(78)]
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

/** 现场那份名单的形状：三席**都没声明**四槽 ⇒ 全是 `origin: default` 的占位值。 */
const LIVE_ROSTER = {
  slots: {
    'writer@writer#1': { permission: { value: 'read-only', origin: 'default' }, mode: { value: 'standard', origin: 'default' }, model: { value: null, origin: 'default' }, reasoning: { value: null, origin: 'default' } },
    tester: { permission: { value: 'read-only', origin: 'default' }, mode: { value: 'standard', origin: 'default' }, model: { value: null, origin: 'default' }, reasoning: { value: null, origin: 'default' } },
    reviewer: { permission: { value: 'read-only', origin: 'default' }, mode: { value: 'standard', origin: 'default' }, model: { value: null, origin: 'default' }, reasoning: { value: null, origin: 'default' } },
  },
}

export async function runF2SlotTruthCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f2-'))
  try {
    // ------------------------------------------------------------ B 现场形状
    const G2 = 'B 现场形状：占位默认值可以被派活覆盖（不覆盖就活不下去了 —— L0 没有计划站）'
    const live = resolveEffectiveSlots({ roster: LIVE_ROSTER, role: 'writer', seat: 'writer#1', requested: { permission: 'workspace-write' } })
    rec.add(G2, '★★ 请求 `workspace-write` + 名单占位 `read-only` ⇒ **放行**，实际生效 `workspace-write`', live.blocked === null && live.slots.permission === 'workspace-write', `blocked=${live.blocked === null ? 'null' : live.blocked.slot}　slots=${JSON.stringify(live.slots)}`)
    rec.add(G2, '★ 该槽的来源标成 `request`（**不是** declared —— 名单没声明过）', live.provenance.permission?.origin === SLOT_ORIGIN.REQUEST, JSON.stringify(live.provenance.permission))
    rec.add(G2, '★★ 覆盖被**点名**：`divergences` 里带着"名单值 / 占位来源 / 实际值"三要素', live.divergences.length === 1 && live.divergences[0].slot === 'permission' && live.divergences[0].declared === 'read-only' && live.divergences[0].declared_origin === 'default' && live.divergences[0].resolved === 'workspace-write', JSON.stringify(live.divergences))
    rec.add(G2, '★ 没被请求覆盖的槽仍然落名单里的值（不是"什么都不给"）', live.slots.mode === 'standard', JSON.stringify(live.slots))
    rec.add(G2, '★ 文案把"覆盖了什么"说清楚，并指明实际值去哪儿查', describeSlotDivergence(live.divergences).includes('task.dispatch_slots'), describeSlotDivergence(live.divergences).split('\n')[1] ?? '')
    rec.add(G2, '★ 没有覆盖时文案为空串（不制造噪音）', describeSlotDivergence([]) === '' && describeSlotDivergence(null) === '', '')

    // ------------------------------------------------------------ A 接线
    const G1 = 'A 接线：`origin=declared` 的槽是**冻结**的，请求与它不符 ⇒ 拒绝派活'
    const declaredRoster = {
      slots: { 'writer@writer#1': { permission: { value: 'workspace-write', origin: 'declared' }, mode: { value: 'standard', origin: 'declared' } } },
    }
    const bad = resolveEffectiveSlots({ roster: declaredRoster, role: 'writer', seat: 'writer#1', requested: { permission: 'danger-full-access' } })
    rec.add(G1, '★★ 声明 `workspace-write`、请求 `danger-full-access` ⇒ **blocked**', bad.blocked !== null && bad.blocked.slot === 'permission', JSON.stringify(bad.blocked))
    rec.add(G1, '★ 拒绝理由写清"声明过的槽是冻结的"与"要改就改名单"', /冻结/.test(bad.blocked?.reason ?? '') && /pipeline_plan/.test(bad.blocked?.reason ?? ''), '')
    const same = resolveEffectiveSlots({ roster: declaredRoster, role: 'writer', seat: 'writer#1', requested: { permission: 'workspace-write' } })
    rec.add(G1, '★ 请求与声明**一致** ⇒ 放行，且来源标 `declared`', same.blocked === null && same.provenance.permission?.origin === SLOT_ORIGIN.DECLARED, JSON.stringify(same.provenance.permission))
    const noAsk = resolveEffectiveSlots({ roster: declaredRoster, role: 'writer', seat: 'writer#1', requested: {} })
    rec.add(G1, '★ 请求没给 ⇒ 落声明值（声明表照旧是权威）', noAsk.blocked === null && noAsk.slots.permission === 'workspace-write' && noAsk.provenance.permission?.origin === SLOT_ORIGIN.DECLARED, JSON.stringify(noAsk.slots))
    rec.add(G1, '★ 席位键优先于裸角色键（`writer@writer#1` 赢过 `writer`）', rosterSlotEntry({ slots: { writer: { permission: { value: 'read-only', origin: 'declared' } }, 'writer@writer#1': { permission: { value: 'workspace-write', origin: 'declared' } } } }, 'writer', 'writer#1')?.permission.value === 'workspace-write', '')

    // ------------------------------------------------------------ E 空操作
    const G5 = 'E 名单没有四槽 ⇒ 空操作（与改前逐字节等价）'
    const empty = resolveEffectiveSlots({ roster: { slots: {} }, role: 'writer', seat: 'writer#1', requested: {} })
    rec.add(G5, '★ 名单空 + 请求空 ⇒ `slots` 里**没有** permission 键（交给通道取兜底，不编一个值）', empty.blocked === null && !Object.hasOwn(empty.slots, 'permission'), JSON.stringify(empty.slots))
    const noRoster = resolveEffectiveSlots({ roster: null, role: 'tester', requested: { mode: 'standard' } })
    rec.add(G5, '★ 连 roster 都没有 ⇒ 不抛、请求照旧生效', noRoster.blocked === null && noRoster.slots.mode === 'standard', '')
    rec.add(G5, '★★ 纯函数：调用前后名单**逐字节相同**（不建结构、不改名单）', JSON.stringify(LIVE_ROSTER) === JSON.stringify(LIVE_ROSTER) && Object.keys(LIVE_ROSTER.slots).length === 3, '')

    // ------------------------------------------------------------ D 落盘
    const G4 = 'D 落盘：`task.dispatch_slots[]` 记下实际生效值（只追加、有上限）'
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const opened = await store.open({ id: 'T-F2', requirement: 'fixture', actorRole: 'main', actorAgentId: 'main-session' })
    rec.add(G4, '夹具：真 store 开出一张单', opened.ok === true, opened.error ?? '')
    const r1 = await store.recordDispatchSlots({
      taskId: 'T-F2',
      role: 'writer',
      seat: 'writer#1',
      slots: { permission: 'workspace-write', mode: 'standard' },
      provenance: live.provenance,
      divergences: live.divergences,
      actorAgentId: 'main-session',
    })
    rec.add(G4, '★ 记一次派活四槽 ⇒ ok', r1.ok === true, r1.error ?? '')
    rec.add(G4, '★★ `effective.permission` 记的是**实际生效值**（workspace-write），不是名单里的 read-only', r1.record?.effective?.permission === 'workspace-write', JSON.stringify(r1.record?.effective))
    rec.add(G4, '★ `divergences` 一并落盘（读的人不必自己比对）', Array.isArray(r1.record?.divergences) && r1.record.divergences[0]?.declared === 'read-only', JSON.stringify(r1.record?.divergences))
    rec.add(G4, '★ 审计留痕 `dispatch:slots`（与任务一起落盘，可追溯）', r1.task?.history?.some?.((h) => h.action === 'dispatch:slots') === true, '')
    rec.add(G4, '★★ 名单**一个字节都没被改写**（声明表与实际值分两处存）', r1.task?.roster === undefined || r1.task.roster === null || JSON.stringify(r1.task.roster?.slots ?? {}) === '{}', JSON.stringify(r1.task?.roster?.slots ?? null))
    for (let i = 0; i < 30; i++) {
      await store.recordDispatchSlots({ taskId: 'T-F2', role: 'writer', seat: 'writer#1', slots: { permission: 'read-only' }, provenance: {}, divergences: [] })
    }
    const reloaded = await store.get('T-F2')
    rec.add(G4, '★ 只追加 + **有上限**（不会把 task.json 撑大）', Array.isArray(reloaded?.dispatch_slots) && reloaded.dispatch_slots.length <= 24, `length=${reloaded?.dispatch_slots?.length}`)
    rec.add(G4, '★ 重读仍然读得到（真落盘，不是内存态）', (await store.get('T-F2'))?.dispatch_slots?.[0]?.effective?.permission !== undefined, '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF2SlotTruthCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
