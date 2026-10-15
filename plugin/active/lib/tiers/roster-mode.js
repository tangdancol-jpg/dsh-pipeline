// 模式槽的落值规则：显式声明优先；没声明 ⇒ 按角色取 `pl-<role>`（用户第 2 件）。
/**
 * dsh-pipeline · 档位规则 · **模式槽**（"一个 AI 一个专属模式"的落地点）
 * ============================================================================
 * 用户原话（2026-10-16，第 2 件）：
 *   「**预设要在被安排身份后使用，而不是摆设**（依旧设其他预设）」
 *
 * 现状（改前）：`normalizeRosterSlots` 在名单没写 `mode` 时一律落 `'standard'`
 * ⇒ 16 个 `pl-*` 预设**一个都不会被用上**（派活拿到的永远是宿主默认档）——
 * 这就是"摆设"在数据上的样子。
 *
 * 改后的落值规则（**三条，顺序即优先级**）：
 *   ① **名单/计划里显式声明了 `mode`** ⇒ **原样尊重**，一个字节都不改
 *      （这就是用户说的"依旧设其他预设"）；
 *   ② 没声明、且该角色有专属预设 `pl-<role>` ⇒ 落 `pl-<role>`，`origin='role-preset'`；
 *   ③ 角色认不出（不在 16 个角色里）⇒ 才退回 `'standard'`，`origin='default'`。
 *
 * ★ **宿主没有该预设时不许静默降级**：派活通道在 `sessionController.create` **之前**
 *   会拿 `agentPresets.list()` 现查（`lib/transport/presets.js` 的 `validatePreset`），
 *   查得到且不在名单里 ⇒ **拒绝派活**并把合法取值一并交回。
 *   所以本模块**不需要**再写一份"降级"逻辑 —— 降级那条路根本不存在。
 *   依据：那一层是既有的、已被 `tests/f11-slot-truth-check.mjs` 钉住的判据；
 *   在这里再判一次就是第二份真源（手抄必漂移，而漂移的坏方向是**放宽**）。
 *
 * @module dsh-pipeline/lib/tiers/roster-mode
 */

import { ALL_ROLE_IDS } from '../roles.js'

/** 角色专属预设的 id 前缀 —— **唯一出处**是 `presets/_index.json` 的 `presetIdPrefix`；
 *  这里写字面量是为了让 `lib/` 不依赖 `presets/`（能单独加载、单独断言），
 *  并由 `tests/p14-roster-preset-mode-check.mjs` 断言两处**逐字相等**。 */
export const ROLE_PRESET_PREFIX = 'pl-'

/** 这个落值的出处（审计用；与 `'declared'` / `'default'` 并列的第三种）。 */
export const ROLE_PRESET_ORIGIN = 'role-preset'

/** 哪些角色有专属预设 —— 权威名单是 `lib/roles.js` 的 `ALL_ROLE_IDS`（不手抄第二份）。 */
export function hasRolePreset(role) {
  return ALL_ROLE_IDS.includes(String(role ?? ''))
}

/** 角色专属预设 id（认不出的角色 ⇒ 空串）。 */
export function rolePresetId(role) {
  return hasRolePreset(role) ? `${ROLE_PRESET_PREFIX}${String(role)}` : ''
}

/**
 * ★ **模式槽没声明时的落值**（本模块的核心，三行代码，但它是"预设不是摆设"的落点）。
 *
 * @param {string} role
 * @param {string} fallback 角色认不出时用的兜底（= `ROSTER_DEFAULT_MODE`，由调用方给，避免两处常量）
 * @returns {{value:string, origin:'role-preset'|'default', presetId:string}}
 */
export function roleDefaultMode(role, fallback = 'standard') {
  const id = rolePresetId(role)
  if (id.length === 0) return { value: String(fallback), origin: 'default', presetId: '' }
  return { value: id, origin: ROLE_PRESET_ORIGIN, presetId: id }
}

/**
 * ★★ **解析模式槽**（唯一的落值入口；`normalizeRosterSlots` 只调它）。
 *
 * 优先级（逐条可断言）：
 *   ① `raw` 是函数（老调用方传"下发函数"） ⇒ **原样尊重**，`origin='declared'`；
 *   ② `raw` 是非空字符串 ⇒ **原样尊重**（去首尾空白），`origin='declared'`
 *      —— 这就是用户说的「**依旧设其他预设**」；
 *   ③ 没声明 ⇒ 按角色取 `pl-<role>`，`origin='role-preset'`；
 *   ④ 角色认不出 ⇒ 落兜底，`origin='default'`。
 *
 * ★ 三种 origin 是**互不相同**的字面量，所以"声明过的"与"按角色给的"在数据上分得开 ——
 *   `roleModePlan` 的 `declared_count` 因此仍然只数**真的声明过的**那几个。
 *
 * @param {unknown} raw 名单里那一格 `mode`
 * @param {{role?:string, who?:string, fallback?:string}} [opts]
 * @returns {{value:any, origin:'declared'|'role-preset'|'default', note:string}}
 */
export function resolveModeSlot(raw, opts = {}) {
  const role = String(opts.role ?? '')
  const who = String(opts.who ?? '某席位')
  if (typeof raw === 'function') {
    return { value: raw, origin: 'declared', note: `${who} 的模式槽是一个下发函数 —— 原样尊重` }
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const v = raw.trim()
    return { value: v, origin: 'declared', note: `${who} 显式声明了模式 ${v} —— 原样尊重（不覆盖）` }
  }
  const d = roleDefaultMode(role, String(opts.fallback ?? 'standard'))
  if (d.origin === ROLE_PRESET_ORIGIN) {
    return { value: d.value, origin: d.origin, note: `${who} 没声明模式 ⇒ 按角色取专属预设 ${d.presetId}` }
  }
  return { value: d.value, origin: d.origin, note: `${who} 没声明模式，且角色「${role}」没有专属预设 ⇒ 落 ${d.value}` }
}

/**
 * ★★ **「一个 AI 一个专属模式」的只读判据**。
 *
 * 需求原文（交付文档 · 需求2）：「**要求追加新的内置模式，满足用于不同 ai 的专属模式**」；
 * 用户在 HR-4dc4643d207f77e8 的裁定原话：「**3) 一个 AI 一个专属模式**」。
 *
 * 这条需求能不能成立，是一个**可机读的事实**，不该靠形容词：
 *   · `declared_count` = 名单里**显式声明**过 mode 的角色/席位有几个；
 *   · `distinct_declared_modes` = 这些声明值里有几个**互不相同**；
 *   · `per_role_ok` = `distinct_declared_modes >= 2`。
 *
 * ★ 为什么阈值取 2：只有一个取值时，"每个角色各自的模式"与"全局一个默认值"
 *   在**数据上无法区分** —— 那正是 1d 长期标「未核实」的实质。
 * ★ 本函数**只读不判**：它不假装知道哪个模式名"适合"哪个角色（那是计划位的活），
 *   只回答"名单里到底有没有按角色分开的模式"。
 *
 * @param {object|null} roster
 * @returns {{rows:Array<{key:string,mode:any,origin:string|null,declared:boolean}>, declared_count:number, total:number, distinct_declared_modes:number, per_role_ok:boolean}}
 */
export function roleModePlan(roster) {
  const table = roster !== null && typeof roster === 'object' && roster.slots !== null && typeof roster.slots === 'object' ? roster.slots : {}
  const rows = Object.keys(table)
    .sort()
    .map((key) => {
      const entry = table[key]
      const cell = entry !== null && entry !== undefined && typeof entry === 'object' ? entry.mode : undefined
      const isCell = cell !== null && cell !== undefined && typeof cell === 'object'
      const origin = isCell && typeof cell.origin === 'string' ? cell.origin : null
      return {
        key,
        mode: isCell && cell.value !== undefined ? cell.value : null,
        origin,
        declared: origin === 'declared',
      }
    })
  const distinct = new Set(rows.filter((r) => r.declared).map((r) => String(r.mode)))
  const declaredCount = rows.filter((r) => r.declared).length
  /**
   * ★★ 用户第 2 件（2026-10-16）：**按角色给的专属预设也算"每个角色各自的模式"** ——
   *   改前它落的是全局一个 `'standard'`，所以 `distinct` 恒为 0/1，`per_role_ok` 永远 false：
   *   "一个 AI 一个专属模式"在数据上根本不成立。现在把 `role-preset` 那一档一并算进来。
   *   ⚠ `declared_count` / `distinct_declared_modes` / `per_role_ok` **一个字没改**
   *     （它们回答的是"名单里**显式**声明了几个"，那是另一个问题，不能混）。
   */
  const rolePresetRows = rows.filter((r) => r.origin === ROLE_PRESET_ORIGIN)
  const distinctEffective = new Set(rows.filter((r) => r.declared || r.origin === ROLE_PRESET_ORIGIN).map((r) => String(r.mode)))
  return {
    rows,
    declared_count: declaredCount,
    total: rows.length,
    distinct_declared_modes: distinct.size,
    per_role_ok: distinct.size >= 2,
    /** ★ 按角色落 `pl-<role>` 的有几个（`role-preset` 那一档）。 */
    role_preset_count: rolePresetRows.length,
    /** ★ declared ∪ role-preset 的**不同取值**个数 —— 这才是"每个角色各自的模式"的实测面。 */
    distinct_effective_modes: distinctEffective.size,
    /** ★ 落值面：每个角色都拿到"自己的"模式（阈值 2 沿用 `per_role_ok` 的口径）。 */
    per_role_effective_ok: distinctEffective.size >= 2,
    /** ★ 逐角色一行：`<键> -> <模式>（<出处>）`，给报告与排查看。 */
    effective: rows.map((r) => `${r.key} -> ${String(r.mode)}（${r.origin ?? '(缺)'}）`),
  }
}
