// 派活四槽的取值：名单 → 请求 → 通道兜底（含用户第 2 件的"按角色取 pl-<role>"）。
/**
 * dsh-pipeline · 工具面 · **派活四槽的取值**
 * ============================================================================
 * 从 `lib/tools/dispatch.js` **原样搬出来**的一部分（`pickRosterSlots` / `dispatchSlots`
 * 逐字节搬过来，行为未改），只加了一条：用户第 2 件的 `mode` 按角色落 `pl-<role>`。
 *
 * 为什么搬（行数纪律）：`dispatch.js` 本来就 727 行（≥400），要往里加行就得先拆；
 * 而"四槽怎么取值"本来就自成一域（名单 / 请求 / 兜底三层）。
 *
 * ---------------------------------------------------------------------------
 * ★ 用户第 2 件（2026-10-16）：「**预设要在被安排身份后使用，而不是摆设**」
 * ---------------------------------------------------------------------------
 * 改前：名单没写 `mode` ⇒ 一路落通道兜底 `DEFAULT_SESSION_PRESET = 'standard'`
 *   ⇒ 16 个 `pl-*` 预设**一个都不会被用上**。
 * 改后（三层，顺序即优先级；**逐槽独立判定，不做归一、不做四槽之间的合并**）：
 *   ① 本次请求显式给的（`args.mode` …）—— 原样尊重；
 *   ② 名单四槽表里该角色 / 席位的值（含 `role-preset` 那一档，见 `lib/tiers/roster-mode.js`）；
 *   ③ **`mode` 这一槽**：还没有值 ⇒ 按角色取 `pl-<role>`（角色认不出才落通道兜底）。
 *      ★ `permission` 这一槽**同样按角色取**（`permissionNeedOf`：会产生落盘产物的角色
 *        至少 `workspace-write`）—— 见 {@link dispatchSlotPlan} 的注释（B 件，2026-10-16）。
 *      ★ 只对 `mode` / `permission` 这么做：模型 / 推理等级的兜底另有契约（环境枚举），
 *        乱补会把"没声明"与"声明了"搅在一起。
 *
 * ★ **宿主没有该预设时不许静默降级**：值下去之后，通道在建会话**之前**会拿
 *   `agentPresets.list()` 现查（`lib/transport/presets.js` 的 `validatePreset`），
 *   不在名单里 ⇒ **拒绝派活**并把合法取值一并交回。这里**不再写第二份降级逻辑** ——
 *   那条路本来就不存在，写第二份就是两个真源（漂移的坏方向是放宽）。
 *
 * @module dsh-pipeline/lib/tools/dispatch-slots
 */

import { rosterSlotDeclarations } from '../tiers.js'
import { DISPATCH_SLOT_KEYS } from '../transport/index.js'
import { ROLE_PRESET_ORIGIN, roleDefaultMode } from '../tiers/roster-mode.js'
// ★★ B 件：`permission` 这一槽的**角色需求底线**（唯一出处见该模块文件头）。
import { permissionNeedOf } from '../roster/permission-need.js'

/**
 * 从名单取该角色 / 席位的四槽声明（**唯一取值入口**是 `tiers.rosterSlotDeclarations`）。
 *
 * 改前的实现在 `dispatch.js` 里又抄了一份"从名单取值"的逻辑，而它只读
 * `roster.writers.partitions[].seat` 与 `roster.sequence[].role` 两处**裸字段**；
 * 这两处从来不承载四槽 ⇒ 取值永远 undefined ⇒ **模式恒为全局那一个默认值**，
 * `roster.slots` 那张权威冻结表**没有任何派活路径读它**（1d 长期标「未核实」的实质）。
 *
 * ★ 只读不写：名单里没有这四个键时返回 `{}` ⇒ 与改造前逐字节等价。
 */
export function pickRosterSlots(roster, role, seat) {
  return rosterSlotDeclarations(roster, role, seat)
}

/**
 * 四槽取值（见 {@link pickRosterSlots}）；返回值永远是四个**分开的**键。
 *
 * ★ 想要**每槽的来源**（用于 `dispatch:slots` 留痕）就用 {@link dispatchSlotPlan} ——
 *   本函数是它的薄包装，返回值逐字节不变（既有调用方与断言一个都不受影响）。
 *
 * @param {object|null} task
 * @param {string} role
 * @param {string|null} seat
 * @param {object} [args] 本次派活请求（显式给的槽优先）
 * @returns {Record<string, any>} 四槽（可能含 `undefined` —— 那是"这一槽没给"）
 */
export function dispatchSlots(task, role, seat, args) {
  return dispatchSlotPlan(task, role, seat, args).slots
}

/**
 * ★★ **四槽取值 + 每槽的来源**（`dispatch:slots` 留痕要的那一份）。
 *
 * 三层（顺序即优先级；逐槽独立判定，不做归一、不做四槽之间的合并）：
 *   ① 本次请求显式给的（原样尊重）；
 *   ② 名单里为该角色 / 席位声明的；
 *   ③ 兜底 —— **逐槽各有各的契约**：
 *      · `mode`：按角色取 `pl-<role>`（见文件头，用户第 2 件）；
 *      · `permission`：★ **按角色需求推导**（`permissionNeedOf`，B 件）；
 *      · `model` / `reasoning`：**不产出**，交给通道按"环境枚举默认档"取。
 *        （名单里那份 `environment-default` 占位也不下发 —— 闸在 `lib/roster/slot-truth.js` 的
 *        `isSentinelPlaceholder`；改前这里写"不产出"，那一层却把占位照抄给了宿主，缺陷 ③。）
 *
 * ★ 为什么 `permission` 的兜底放在这里、而不是改名单的占位值：`roster.slots` 是
 *   **带摘要冻结的声明表**，它的占位默认值被三处既有断言钉着（`roster-authority-check`
 *   的 D5/D7、`t14-fix-check` 的 D 组）。改占位值等于改"当初声明了什么"的历史证据；
 *   而"这个角色该拿什么档"本来就该在**派活那一刻**算 —— 那里才是权限档真正落地的地方。
 *
 * @param {object|null} task
 * @param {string} role
 * @param {string|null} seat
 * @param {object} [args]
 * @returns {{slots: Record<string, any>, origins: Record<string, string>}}
 *   `origins` 只含**推导出来的**槽（`{permission: 'role-need'}`）—— 请求给的 / 名单声明的
 *   由 `resolveEffectiveSlots` 自己按既有判据标，这里不重复标、也不覆盖。
 */
export function dispatchSlotPlan(task, role, seat, args) {
  const fromRoster = pickRosterSlots(task === null || task === undefined ? null : task.roster, role, seat)
  const out = {}
  for (const k of DISPATCH_SLOT_KEYS) {
    const asked = args === null || args === undefined ? undefined : args[k]
    out[k] = typeof asked === 'string' && asked.length > 0 ? asked : fromRoster[k]
  }
  // ★★ 用户第 2 件：`mode` 这一槽还没值 ⇒ **按角色取 `pl-<role>`**（不是全局一个默认值）。
  //    角色认不出（不在 16 个角色里）⇒ `roleDefaultMode` 返回 origin='default' ⇒ **不动它**，
  //    照旧交给通道兜底并留痕。
  const mode = out.mode
  if (mode === undefined || mode === null || (typeof mode === 'string' && mode.trim().length === 0)) {
    const d = roleDefaultMode(String(role ?? ''))
    if (d.origin === ROLE_PRESET_ORIGIN) out.mode = d.value
  }
  /**
   * ★★ B 件（2026-10-16 真机 `T-20261016-fullai`）：`permission` 这一槽还没值
   *   ⇒ **按角色需求推导**（会产生落盘产物的角色至少 `workspace-write`）。
   *
   * 判据、为什么这条规则能覆盖"顾问角色要写自己的报告目录"、以及为什么**不**放宽成
   * "所有角色都给写权限" —— 全部写在 `lib/roster/permission-need.js` 的文件头。
   */
  const origins = {}
  const perm = out.permission
  if (perm === undefined || perm === null || (typeof perm === 'string' && perm.trim().length === 0)) {
    const need = permissionNeedOf(String(role ?? ''))
    out.permission = need.value
    origins.permission = need.origin
  }
  return { slots: out, origins }
}
