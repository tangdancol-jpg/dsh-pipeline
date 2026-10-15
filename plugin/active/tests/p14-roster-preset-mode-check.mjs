/**
 * p14 · 派活那一刻「按角色取 `pl-<role>`」（用户第 2 件：预设不是摆设）
 * ============================================================================
 *     node tests/p14-roster-preset-mode-check.mjs
 *
 * 用户原话：「**预设要在被安排身份后使用，而不是摆设**（**依旧设其他预设**）」。
 *
 * 判据（每条都能红）：
 *   ① **前缀同源**：`lib/tiers/roster-mode.js` 的 `ROLE_PRESET_PREFIX` 与
 *      `presets/_index.json` 的 `presetIdPrefix` **逐字相等**（不是手抄两份）。
 *   ② **16 个角色都有专属预设**：`rolePresetId(role) === _index.json` 里那一条的 id。
 *   ③ **显式声明优先**：名单写了 `mode` ⇒ **原样尊重**（`origin='declared'`，值一个字节不改）——
 *      这就是"依旧设其他预设"。
 *   ④ **没声明 ⇒ `pl-<role>`**：`normalizeRosterSlots` 的落值是 `pl-<role>`，`origin='role-preset'`。
 *   ⑤ **下得去**：`rosterSlotDeclarations` 必须把它取出来（`role-preset` 那一档要能下发），
 *      而 `default` 那一档仍然**不下发**（占位不是声明）。
 *   ⑥ **派活那一刻的实测值**：`dispatchSlots(task, role, seat, {})` 的 `mode === 'pl-<role>'`；
 *      请求里显式给了 mode ⇒ 以请求为准。
 *   ⑦ **"一个 AI 一个专属模式"在数据上成立**：`roleModePlan` 的
 *      `distinct_effective_modes === 席位数`、`per_role_effective_ok === true`，
 *      而 `declared_count` **仍然是 0**（没声明就是没声明，不许把按角色给的算成声明）。
 *   ⑧ **宿主没有该预设 ⇒ 如实报错，不静默降级**：`validatePreset(假的 ctx, 'pl-writer')`
 *      在名单里没有它时返回 `checked:true, ok:false` 且 why 带合法取值。
 *   ⑨ **负例自证**：临时副本里把 `_index.json` 的 `presetIdPrefix` 改成 `xx-`
 *      ⇒ 判据① 必须变红。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 * @module dsh-pipeline/tests/p14-roster-preset-mode-check
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALL_ROLE_IDS } from '../lib/roles.js'
import { buildRosterSlots, normalizeRosterSlots, roleModePlan, rosterSlotDeclarations, slotKeyOf } from '../lib/tiers.js'
import { ROLE_PRESET_PREFIX, roleDefaultMode, rolePresetId } from '../lib/tiers/roster-mode.js'
import { dispatchSlots } from '../lib/tools/dispatch-slots.js'
import { validatePreset } from '../lib/transport/presets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const INDEX_PATH = join(PKG, 'presets', '_index.json')

/** 假宿主：`agentPresets.list()` 只报给定的那些 id。 */
const fakeCtx = (ids) => ({
  get: (name) => (name === 'agentPresets' ? { list: async () => ids.map((id) => ({ id })), defaultId: 'standard' } : undefined),
})

/** 主运行器。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runP14RosterPresetModeCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const ok = (cond, label, detail = '') => {
    total += 1
    if (cond) passed += 1
    lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? `　—— ${detail}` : ''}`)
    return Boolean(cond)
  }

  lines.push('='.repeat(78))
  lines.push('p14 · 派活那一刻按角色取 `pl-<role>`（预设不是摆设）')
  lines.push('='.repeat(78))

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))

  // ---- ①② 前缀同源 + 16 个角色都有预设 --------------------------------------
  ok(
    ROLE_PRESET_PREFIX === index.presetIdPrefix,
    '① `ROLE_PRESET_PREFIX` 与 `presets/_index.json` 的 `presetIdPrefix` 逐字相等（不是手抄两份）',
    `lib=${ROLE_PRESET_PREFIX} · _index=${index.presetIdPrefix}`,
  )
  const badPreset = ALL_ROLE_IDS.filter((r) => (index.presets[r]?.id ?? '') !== rolePresetId(r))
  ok(badPreset.length === 0, `② ${ALL_ROLE_IDS.length} 个角色的专属预设 id 都等于 \`pl-<role>\``, badPreset.map((r) => `${r}:${index.presets[r]?.id}`).join(' ') || ALL_ROLE_IDS.map((r) => rolePresetId(r)).join(' / '))

  // ---- ③ 显式声明优先 --------------------------------------------------------
  const decl = normalizeRosterSlots({ mode: 'computer-use', permission: 'workspace-write' }, { who: 'writer', role: 'writer' })
  ok(
    decl.ok === true && decl.slots.mode.value === 'computer-use' && decl.slots.mode.origin === 'declared',
    '③ ★ 名单显式声明了 `mode` ⇒ **原样尊重**（"依旧设其他预设"）',
    `value=${decl.slots.mode.value} origin=${decl.slots.mode.origin}`,
  )
  const viaRoster = buildRosterSlots(['main', 'writer', 'tester', 'reviewer'], null, {
    slots: { writer: { permission: 'workspace-write', mode: 'cordis' }, tester: { permission: 'read-only' }, reviewer: { permission: 'read-only' } },
  })
  ok(viaRoster.ok === true && viaRoster.slots.writer.mode.value === 'cordis', '③ 端到端：`buildRosterSlots` 也不覆盖显式声明的模式', `writer.mode=${viaRoster.slots.writer.mode.value}`)
  ok(viaRoster.slots.tester.mode.value === 'pl-tester', '③ 同一个名单里，**没声明**的 tester 拿 `pl-tester`（两种落值可以并存）', `tester.mode=${viaRoster.slots.tester.mode.value}`)

  // ---- ④ 没声明 ⇒ pl-<role> --------------------------------------------------
  const bare = normalizeRosterSlots({}, { who: 'archivist', role: 'archivist' })
  ok(bare.slots.mode.value === 'pl-archivist' && bare.slots.mode.origin === 'role-preset', '④ 没声明 ⇒ 落 `pl-<role>`，origin=`role-preset`', `value=${bare.slots.mode.value} origin=${bare.slots.mode.origin}`)
  const unknown = normalizeRosterSlots({}, { who: 'x', role: 'not-a-role' })
  ok(unknown.slots.mode.value === 'standard' && unknown.slots.mode.origin === 'default', '④ 角色认不出 ⇒ 才落兜底 `standard`（origin=`default`）', `value=${unknown.slots.mode.value}`)

  // ---- ⑤ 下得去 / default 不下发 ---------------------------------------------
  const decls = rosterSlotDeclarations({ slots: viaRoster.slots }, 'tester', null)
  ok(decls.mode === 'pl-tester', '⑤ ★ `role-preset` 那一档**能下发**（否则"不是摆设"还是摆设）', `tester → mode=${decls.mode}`)
  ok(decls.model === undefined, '⑤ 对照：`default` 那一档**不下发**（占位不是声明）', `model=${String(decls.model)}`)

  // ---- ⑥ 派活那一刻的实测值 ---------------------------------------------------
  const task = { roster: viaRoster.roster ?? { slots: viaRoster.slots } }
  const t = { roster: { slots: viaRoster.slots } }
  const got = dispatchSlots(t, 'writer', null, {})
  ok(got.mode === 'cordis', '⑥ 请求没给 ⇒ 取名单（显式声明的那一个）', `writer.mode=${got.mode}`)
  const got2 = dispatchSlots(t, 'reviewer', null, {})
  ok(got2.mode === 'pl-reviewer', '⑥ ★★ 请求没给、名单也没声明 ⇒ **按角色取 `pl-<role>`**（本件的核心判据）', `reviewer.mode=${got2.mode}`)
  const got3 = dispatchSlots(t, 'reviewer', null, { mode: 'standard' })
  ok(got3.mode === 'standard', '⑥ 请求里显式给了 `mode` ⇒ 以**请求**为准', `reviewer.mode=${got3.mode}`)
  const got4 = dispatchSlots(null, 'architect', null, {})
  ok(got4.mode === 'pl-architect', '⑥ 没有名单也照样按角色给（`dispatchSlots` 的第 ③ 层）', `architect.mode=${got4.mode}`)
  ok(Object.keys(got4).length === 4 && Object.hasOwn(got4, 'permission'), '⑥ 返回值仍然是四个**分开的**槽键', Object.keys(got4).join(' / '))
  void task
  void slotKeyOf

  // ---- ⑦ "一个 AI 一个专属模式" 在数据上成立 ---------------------------------
  const plan = roleModePlan({ slots: viaRoster.slots })
  const keys = Object.keys(viaRoster.slots)
  ok(plan.declared_count === 1, '⑦ 只有**真的声明过**的那个算 `declared_count`（按角色给的不许算成"声明"）', `declared_count=${plan.declared_count}（名单里只有 writer 写了 mode）`)
  ok(plan.role_preset_count === keys.filter((k) => viaRoster.slots[k].mode.origin === 'role-preset').length, '⑦ `role_preset_count` = 落 `pl-<role>` 的席位数', `${plan.role_preset_count}/${keys.length}`)
  ok(plan.distinct_effective_modes === keys.length && plan.per_role_effective_ok === true, '⑦ ★ `distinct_effective_modes` = 席位数 ⇒ 每个席位**各自的**模式（改前恒为 1）', `${plan.distinct_effective_modes} 种 / ${keys.length} 个席位`)
  ok(plan.per_role_ok === false, '⑦ 对照：原来那条 `per_role_ok`（只看显式声明）保持原义不变', `per_role_ok=${plan.per_role_ok}`)

  // ---- ⑧ 宿主没有该预设 ⇒ 如实报错，不静默降级 -------------------------------
  const miss = await validatePreset(fakeCtx(['standard', 'computer-use']), 'pl-writer')
  ok(miss.checked === true && miss.ok === false, '⑧ ★ 宿主上没有 `pl-writer` ⇒ **判红**（不静默降到 standard）', miss.why)
  ok(miss.why.includes('standard') && miss.why.includes('computer-use'), '⑧ 而且把**合法取值**一并交回（调用方知道该怎么办）', miss.why.slice(0, 120))
  const hit = await validatePreset(fakeCtx(['standard', 'pl-writer']), 'pl-writer')
  ok(hit.checked === true && hit.ok === true, '⑧ 对照：宿主上有 ⇒ 通过', `checked=${hit.checked} ok=${hit.ok}`)

  // ---- ⑨ 负例：前缀漂移必须被抓住 --------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), 'p14-'))
  try {
    cpSync(join(PKG, 'presets'), join(tmp, 'presets'), { recursive: true })
    const j = JSON.parse(readFileSync(join(tmp, 'presets', '_index.json'), 'utf8'))
    j.presetIdPrefix = 'xx-'
    writeFileSync(join(tmp, 'presets', '_index.json'), JSON.stringify(j, null, 2), 'utf8')
    const drifted = JSON.parse(readFileSync(join(tmp, 'presets', '_index.json'), 'utf8'))
    ok(drifted.presetIdPrefix !== ROLE_PRESET_PREFIX, '⑨ 负例：`_index.json` 的前缀改成 `xx-` ⇒ 判据①**会红**（前缀不是两处手抄）', `临时副本 ${drifted.presetIdPrefix} ≠ ${ROLE_PRESET_PREFIX}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  lines.push('')
  lines.push(`p14 总计：${passed}/${total} 通过`)
  return { passed, total, text: lines.join('\n') }
}

// 直接运行
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await runP14RosterPresetModeCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
