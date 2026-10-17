/**
 * dsh-pipeline · 名单校验与开对话判据（四槽比对 / 配额 / 次序 / 整体校验）
 * ============================================================================
 * 自 `lib/tiers.js` 拆分出来的子模块（纯机械拆分，行为与原文件逐字一致）。
 *
 * @module dsh-pipeline/lib/tiers/validate
 */

import { ROLE, SEPARATION_ROLES } from '../roles.js'
import { toStringArray } from '../util.js'
import { ROSTER_SLOT_KEYS, slotKeyOf } from './roster-slots.js'
import { TIERS } from './constants.js'
import { buildWriters } from './roster.js'

/**
 * ★ **逐字段严格相等**地比对一次「开对话」请求带下来的四槽与名单里冻结的四槽（B2）。
 *
 * 不做任何归一、不做近似匹配：差一个字符就是另一档。
 *
 * @param {object} roster
 * @param {{role:string, seat?:string|null, permission?:any, mode?:any, model?:any, reasoning?:any}} req
 * @returns {{ok:boolean, mismatches:Array<{slot:string, want:any, got:any}>}}
 */
export function compareDispatchSlots(roster, req = {}) {
  const table = roster !== null && typeof roster === 'object' && roster.slots !== null && typeof roster.slots === 'object' ? roster.slots : null
  if (table === null) {
    return { ok: false, mismatches: [{ slot: '(名单)', want: 'roster.slots', got: null }] }
  }
  const seat = req.seat === undefined ? null : req.seat
  const entry = table[slotKeyOf(req.role, seat)] ?? table[slotKeyOf(req.role, null)]
  if (entry === undefined) {
    return { ok: false, mismatches: [{ slot: '(席位)', want: slotKeyOf(req.role, seat), got: '名单里没有这一条' }] }
  }
  const mismatches = []
  for (const slot of ROSTER_SLOT_KEYS) {
    if (!Object.hasOwn(entry, slot)) {
      mismatches.push({ slot, want: '(名单缺这一槽)', got: req[slot] ?? null })
      continue
    }
    const want = entry[slot]?.value
    const got = req[slot] === undefined ? null : req[slot]
    const bothFn = typeof want === 'function' && typeof got === 'function'
    if (!bothFn && want !== got) mismatches.push({ slot, want, got })
  }
  return { ok: mismatches.length === 0, mismatches }
}

/**
 * ★ **开对话人数上限**的数据面（A3）。
 *
 * 上限值来自名单（`roster.dispatch_quota`，缺省 = 清单里的独立对话数，**不含主对话**，与 buildRoster 的缺省同一口径）。
 * 纯函数：调用方把"当前已开出、还活着的会话数"数给它，它只回答"再开一个合不合法"。
 */
export function checkDispatchQuota(roster, currentOpen, opts = {}) {
  const n = Number.isInteger(currentOpen) && currentOpen >= 0 ? currentOpen : 0
  const explicit = roster !== null && typeof roster === 'object' ? roster.dispatch_quota : undefined
  const fromList = roster !== null && typeof roster === 'object' && Array.isArray(roster.conversations)
    ? roster.conversations.filter((r) => r !== ROLE.MAIN).length
    : 0
  const max = Number.isInteger(explicit) ? explicit : fromList
  const who = String(opts.who ?? '本次请求')
  return {
    ok: n < max,
    current: n,
    max,
    error:
      n < max
        ? null
        : `${who} 要开的会话数会到第 ${n + 1} 个，但名单里声明的上限是 ${max} 个。\n` +
          '★ 能开几个**由名单说了算**（不是由发起方的判断说了算）：要更多就先改名单，' +
          '而改名单只有一条路 —— 角色变更申请 → 计划复核（A3）。',
  }
}

/**
 * ★ **硬性次序**的数据面（A4）：把 `sequence[].order` 与 `sequence[].requires` 变成判据。
 *
 * @param {object} roster
 * @param {string} eventRole - 要开的那个角色
 * @param {string[]} completedRoles - 已经完成的角色
 * @returns {{ok:boolean, blockedBy:string[], error:string|null, entry:object|null}}
 */
export function validateDispatchSequence(roster, eventRole, completedRoles) {
  const seq = roster !== null && typeof roster === 'object' && Array.isArray(roster.sequence) ? roster.sequence : []
  const entry = seq.find((x) => String(x?.role ?? '') === String(eventRole ?? '')) ?? null
  if (entry === null) {
    const name = String(eventRole ?? '')
    return {
      ok: false,
      blockedBy: [],
      entry: null,
      error:
        `角色「${name}」不在本次名单的硬性次序里 —— 名单外的角色一律开不出来。\n` +
        `名单次序：${seq.map((x) => x.role).join(' → ')}`,
    }
  }
  const done = new Set((Array.isArray(completedRoles) ? completedRoles : []).map((x) => String(x)))
  const requires = toStringArray(entry.requires)
  const blockedBy = requires.filter((r) => !done.has(r))
  return {
    ok: blockedBy.length === 0,
    blockedBy,
    entry,
    error:
      blockedBy.length === 0
        ? null
        : `次序倒置：角色「${entry.role}」（第 ${entry.order} 位）要求先完成 ${requires.join('、')}，` +
          `现在还没完成的是 ${blockedBy.join('、')}。\n` +
          '★ 次序是**硬的**（写死在名单的 sequence 上），不是"最好按这个顺序"。',
  }
}

export function validateRoster(roster) {
  const errors = []
  if (roster === null || typeof roster !== 'object') return { ok: false, errors: ['roster 不是对象'] }
  if (!Object.hasOwn(TIERS, String(roster.tier ?? ''))) errors.push(`tier 非法：${roster.tier}`)
  const exec = Array.isArray(roster.execution_roles) ? roster.execution_roles : null
  if (exec === null) errors.push('execution_roles 不是数组')
  else {
    for (const r of SEPARATION_ROLES) {
      if (!exec.includes(r)) errors.push(`缺少三权分立角色「${r}」`)
    }
    if (!Number.isInteger(roster.ai_count) || roster.ai_count < 4) {
      errors.push(`ai_count 必须 >= 4（最少 4 个独立对话），当前 ${roster.ai_count}`)
    }
    if (Array.isArray(roster.conversations) && roster.conversations.length !== roster.ai_count) {
      errors.push(`ai_count(${roster.ai_count}) 与 conversations 长度(${roster.conversations.length}) 不一致`)
    }
  }
  if (roster.judged_by === 'planner' && (typeof roster.reason !== 'string' || roster.reason.trim().length === 0)) {
    errors.push('由计划 AI 产出的清单必须带 reason（每次判断都要有理由记录、可追溯）')
  }
  // ★ 编写席位
  if (exec.includes !== null && exec.includes(ROLE.WRITER)) {
    const w = roster.writers
    if (w === null || typeof w !== 'object') {
      errors.push('roster 缺少 writers（编写席位方案）—— 即使是单席位也必须显式给 count=1')
    } else {
      const built = buildWriters(w, Number.isInteger(roster.max_writers) ? roster.max_writers : TIERS[roster.tier]?.maxWriters ?? 1)
      if (built.ok !== true) errors.push(`writers 非法：${built.error.split('\n')[0]}`)
      else if (built.writers.count !== w.count) errors.push('writers.count 与 partitions 不一致')
      if (w.count > 1 && (typeof w.reason !== 'string' || w.reason.trim().length === 0)) {
        errors.push('分多个编写席位时必须写 writers.reason（为什么分、怎么分的）—— 这是可追溯性要求')
      }
    }
  }
  return { ok: errors.length === 0, errors }
}
