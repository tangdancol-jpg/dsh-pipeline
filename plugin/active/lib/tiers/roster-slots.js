// 名单四槽（权限档 / 模式 / 模型 / 推理等级）的表：键、声明收敛、目标、取值、构造。
/**
 * dsh-pipeline · 档位规则 · **名单四槽表**
 * ============================================================================
 * 从 `lib/tiers.js` **原样搬出来**的一部分（代码逐字节搬过来，行为未改）；
 * 对外仍经 `lib/tiers.js` 转出，调用方不需要改 import。
 *
 * 为什么搬（用户第 2 件的行数纪律）：`lib/tiers.js` 已经 1388 行，
 * 而"派活那一刻按角色取 `pl-<role>` 预设"这件事**必须**动到 `normalizeRosterSlots` ——
 * 规矩是"要给 ≥400 行的文件加行，先拆再改"。抽的就是这一整段（四槽是自成一域的：
 * 谁能声明、声明长什么样、每个席位拿到什么档）。
 *
 * ★ 依赖方向：本文件 → `./roster-mode.js`（模式槽的落值规则）；
 *   `roster-mode.js` **不 import 本文件**，所以没有环。
 *
 * @module dsh-pipeline/lib/tiers/roster-slots
 */

import { ROLE, seatId } from '../roles.js'
import { stableStringify, toStringArray } from '../util.js'
import { writeClassOf } from '../guard.js'
import { ROLE_PRESET_ORIGIN, resolveModeSlot } from './roster-mode.js'

/**
 * 校验一份 roster 结构是否自洽（落盘后读回来、或外部传进来时用）。
 *
 * @param {any} roster
 * @returns {{ok:boolean, errors:string[]}}
 */
/** ★ 名单侧四槽的字段名（与派活通道的四槽常量同源；本层不引入通道，保持可单独加载）。 */
export const ROSTER_SLOT_KEYS = Object.freeze(['permission', 'mode', 'model', 'reasoning'])

/** 三档权限（与派活通道的三档同源；逐字相等判定，不做任何归一）。 */
export const ROSTER_PERMISSION_TIERS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** 未声明权限档时落的**最小档**（B3 的数据面）。 */
export const ROSTER_MIN_PERMISSION = 'read-only'

/** 「完全」档：默认禁用；要在名单里声明它，必须同时带用户判定记录（B4 / B5 的数据面）。 */
export const ROSTER_FULL_PERMISSION = 'danger-full-access'

/** 模式槽未声明时的落值 —— 与派活通道的默认会话模式同源。 */
export const ROSTER_DEFAULT_MODE = 'standard'

/** 模型 / 推理等级未声明时的落值（= 该环境可枚举的默认档，由通道侧读回核对）。 */
export const ROSTER_ENV_DEFAULT = 'environment-default'

/** 角色在某席位下的映射键。非编写角色没有席位 ⇒ seat 恒为 null。 */
export function slotKeyOf(roleId, seat) {
  const role = String(roleId ?? '')
  const s = seat === null || seat === undefined || String(seat).length === 0 ? null : String(seat)
  return s === null ? role : `${role}@${s}`
}

/**
 * 该角色是不是「要落四槽并接受槽位校验」的角色。
 *
 * 只读角色（main、orchestrator、planner、supervisor）**不派活、不落四槽** ——
 * （human 不在其列：它的角色表条目是既有的 `workdir`（异常出口），本单未动它。）
 * 它们本来就是只读的，给它一个权限档没有意义，反而会把"没声明"与"声明了最小档"搅在一起。
 * ⚠️ 这条分界同时是 C4（主管读源码能力为否）与 C5（主管不持有写权限）的同一份数据面：
 *    主管是只读角色 ⇒ 不在此列 ⇒ 名单里不许、也不需要给它声明工作区及以上档位。
 */
export function slotRoleNeedsDeclaration(roleId) {
  const cls = writeClassOf(typeof roleId === 'string' ? roleId : String(roleId ?? ''))
  return cls === 'workdir' || cls === 'own-dir' || cls === 'own-log'
}

/**
 * 把一条槽位声明收敛成**显式落值**的四槽（B1 的数据面）。
 *
 * 每一槽返回 {value, declared, origin}：
 *   · permission 未声明 ⇒ **显式落最小档**（read-only）、origin=default ——
 *     让"没声明"与"声明了最小档"在数据上可区分（B3）；
 *   · 声明了但不在三档之内 ⇒ 直接拒（不做近似、不做归一）；
 *   · 声明「完全」档 ⇒ 必须同时带用户判定记录，否则拒（B4）；带齐了则原样保留那份记录（B5）。
 *
 * @returns {{ok:true, slots:object} | {ok:false, error:string}}
 */
export function normalizeRosterSlots(raw, opts = {}) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const who = String(opts.who ?? '某席位')
  const out = {}
  const put = (key, value, origin) => {
    out[key] = { value, declared: origin === 'declared', origin }
  }

  const permRaw = r.permission
  if (permRaw === undefined || permRaw === null || String(permRaw).trim().length === 0) {
    put('permission', ROSTER_MIN_PERMISSION, 'default')
  } else {
    const perm = String(permRaw).trim()
    if (!ROSTER_PERMISSION_TIERS.includes(perm)) {
      return {
        ok: false,
        error:
          `席位 ${who} 的权限档「${perm}」不在三档之内（${ROSTER_PERMISSION_TIERS.join('、')}）。\n` +
          '★ 逐字相等判定，不做任何归一：名字差一个字就是另一档。',
      }
    }
    put('permission', perm, 'declared')
  }

  // ★★ 用户第 2 件（2026-10-16）：模式槽的落值**只有这一个入口**（`resolveModeSlot`）。
  //    改前这里是"没声明就落 'standard'" ⇒ 16 个 `pl-*` 预设一个都用不上（摆设）。
  //    改后：**显式声明优先**（依旧设其他预设）；没声明 ⇒ 按角色取 `pl-<role>`。
  //    ★ 宿主没有那个预设时不在这里降级 —— 派活通道会在建会话**之前**拒绝并交回合法取值
  //      （`lib/transport/presets.js` 的 `validatePreset`，既有判据、f11 已钉）。
  const modeSlot = resolveModeSlot(r.mode, { role: opts.role, seat: opts.seat, who, fallback: ROSTER_DEFAULT_MODE })
  put('mode', modeSlot.value, modeSlot.origin)

  const modelRaw = r.model
  if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) put('model', modelRaw.trim(), 'declared')
  else put('model', ROSTER_ENV_DEFAULT, 'default')

  const reasonRaw = r.reasoning
  if (typeof reasonRaw === 'string' && reasonRaw.trim().length > 0) put('reasoning', reasonRaw.trim(), 'declared')
  else put('reasoning', ROSTER_ENV_DEFAULT, 'default')

  const approval = r.permission_approval
  if (out.permission.value === ROSTER_FULL_PERMISSION) {
    const a = approval !== null && typeof approval === 'object' ? approval : null
    const ref = a === null ? '' : String(a.ref ?? '').trim()
    const at = a === null ? '' : String(a.at ?? '').trim()
    if (ref.length === 0 || at.length === 0) {
      return {
        ok: false,
        error:
          `席位 ${who} 声明了「完全」档（${ROSTER_FULL_PERMISSION}），但没有可追溯的**用户判定**记录。\n` +
          '★ 「完全」档默认禁用：要开它必须同时给出 permission_approval = { ref, at, seat }；' +
          '缺一项即拒（B4），给了就原样留痕、事后可追溯"谁在什么时候、针对哪个席位判的"（B5）。',
      }
    }
    put('permission_approval', { ref, at, seat: a.seat === undefined ? null : a.seat }, 'declared')
  }

  return { ok: true, slots: out }
}

/**
 * ★★ **四槽表的键集合**（B1 的**唯一**数据源）。
 *
 * 现场（2026-10-12）：`lib/store.js` 的写入前置判据自己又算了一遍"哪些席位要落四槽"，
 * 而它把**裸角色键 `writer`** 也算进去了；本函数在编写角色有分区时**故意不产生**这个键
 * （有分区 ⇒ 派活的实体是席位 `writer@writer#1`，不是裸角色）。
 * 两边各算一遍 ⇒ 判据每次都点名 `writer` 没声明四槽 ⇒ **任何计划都出不来**
 * （连插件自带的正例夹具都过不去）。
 *
 * 修法：键集合只有这一个出处 —— 判据与本函数**共用**它，不再各算一遍。
 * `tests/roster-authority-check.mjs` 早就断言过"裸 `writer` 键不该存在"，
 * 所以这不是放宽判据，而是让判据与既定的数据结构一致。
 *
 * @param {string[]} conversations - roster 里的独立对话清单（角色 id）
 * @param {object|null} writers - buildWriters 的结果（编写席位分区）
 * @returns {Array<{role:string, seat:string|null}>}
 */
export function rosterSlotTargets(conversations, writers) {
  const parts = writers !== null && typeof writers === 'object' && Array.isArray(writers.partitions) ? writers.partitions : []
  /** 有分区的角色（编写）：它派活的实体是**席位**，不再要一个裸角色级槽位。 */
  const seatedRoles = new Set(parts.map(() => ROLE.WRITER))
  const targets = []
  for (const role of Array.isArray(conversations) ? conversations : []) {
    if (seatedRoles.has(role)) continue
    targets.push({ role, seat: null })
  }
  for (const p of parts) {
    targets.push({ role: ROLE.WRITER, seat: String(p?.seat ?? seatId(p?.index ?? 1)) })
  }
  return targets
}

/**
 * 四槽表的键集合（`<角色>` / `<角色>@<席位>`）—— 判据侧只要键、不要槽位本身时用它。
 *
 * ★ 与 {@link buildRosterSlots} **逐字同源**：只取"要落槽位"的角色
 *   （`slotRoleNeedsDeclaration`；只读角色不派活 ⇒ 不落槽位、也不该被判据点名），
 *   编写角色在有分区时用 `writer@<席位>` 键、**不产生裸 `writer` 键**。
 *
 * @param {string[]} conversations
 * @param {object|null} writers
 * @returns {string[]}
 */
export function rosterSlotKeys(conversations, writers) {
  return rosterSlotTargets(conversations, writers)
    .filter((t) => slotRoleNeedsDeclaration(t.role))
    .map((t) => slotKeyOf(t.role, t.seat))
}

/**
 * ★★ **按角色 / 席位取四槽声明值**（名单 → 会话的**唯一取值入口**）。
 *
 * 为什么必须补这一个函数（2026-10-14 复测核实「1d 角色专属模式」时查出的**死路**）：
 *   派活侧原本自己实现了一份取值（`lib/tools.js` 的 `pickRosterSlots`），它只读两处
 *   **裸字段**：`roster.writers.partitions[].seat` 与 `roster.sequence[].role`。
 *   而这两处**从来不承载四槽**：
 *     · `buildRoster` 产出的 `sequence[]` 条目是 `{role, phase, order, requires}`（本文件 :372）；
 *     · `buildWriters` 产出的 `partitions[]` 条目是
 *       `{seat, role_id, layer, scope_paths, interface_owner, deliverables}`（本文件 :689）。
 *   ⇒ 取值**永远是 undefined** ⇒ 每一槽都落回通道兜底
 *     （权限恒为最小档、**模式恒为全局那一个默认值**）。
 *   与此同时，真正的权威来源 `roster.slots`（`buildRosterSlots` 的产物，本文件自己写明是
 *   "『每个席位拿到什么档』的**唯一出处**"）**没有任何派活路径读它** —— 全项目只有
 *   `compareDispatchSlots` 读，而它**没有任何调用点**。
 *
 *   ⇒ 后果：**「一个 AI 一个专属模式」在数据上根本无法成立** ——
 *     名单里就算按角色声明了各自的 mode，也一个字都到不了会话头。
 *
 * 本函数就是那条缺失的取值路径。优先级（逐槽独立判定，不做归一、不做合并）：
 *   ① `roster.slots[<角色>|<角色>@<席位>]` 里 **origin === 'declared'** 的槽（权威表；
 *      且**只认显式声明的** —— `origin==='default'` 是 `buildRosterSlots` 填的占位默认值，
 *      把它当"声明过"会让审计里的 origin 说谎）；
 *   ② `roster.writers.partitions[]` 里该席位的裸同名字段（兼容手写名单）；
 *   ③ `roster.sequence[]` 里该角色的裸同名字段（兼容手写名单）。
 *   三处都没有 ⇒ **不产出这个键**（= 这一槽没给），由通道按契约取兜底并留痕。
 *
 * ★ 纯函数、只读：不建结构、不改名单、不做"请求 vs 名单是否相等"的判定（那是 B2）。
 * ★ 名单里没有四槽时它是**空操作** ⇒ 行为与改造前逐字节等价。
 *
 * @param {object|null} roster
 * @param {string} role
 * @param {string|null} [seat]
 * @returns {Record<string, any>} 只含**取到值**的槽（可能为空对象）
 */
export function rosterSlotDeclarations(roster, role, seat = null) {
  const out = {}
  if (roster === null || roster === undefined || typeof roster !== 'object') return out
  /** 三处来源按优先级依次补空 —— 先到先得，不覆盖已有值。 */
  const take = (src) => {
    if (src === null || src === undefined || typeof src !== 'object') return
    for (const k of ROSTER_SLOT_KEYS) {
      if (out[k] === undefined && src[k] !== undefined && src[k] !== null) out[k] = src[k]
    }
  }
  // ① 权威冻结表：认 **declared**（人/计划显式写的）与 **role-preset**（按角色给的专属预设）。
  //    ⚠ `default` 仍是占位、**不下发** —— 把它当"有值"会让审计里的 origin 说谎。
  //    ★ 用户第 2 件：`role-preset` 必须**下得去**，否则"预设不是摆设"就还是摆设。
  const table = roster.slots !== null && typeof roster.slots === 'object' ? roster.slots : null
  if (table !== null) {
    const entry = table[slotKeyOf(role, seat)]
    if (entry !== null && entry !== undefined && typeof entry === 'object') {
      const declared = {}
      for (const k of ROSTER_SLOT_KEYS) {
        const cell = entry[k]
        const okOrigin = cell !== null && cell !== undefined && typeof cell === 'object' && (cell.origin === 'declared' || cell.origin === ROLE_PRESET_ORIGIN)
        if (okOrigin && cell.value !== undefined && cell.value !== null) declared[k] = cell.value
      }
      take(declared)
    }
  }
  // ② 编写席位上的裸声明
  if (role === ROLE.WRITER && typeof seat === 'string' && seat.length > 0) {
    const parts = Array.isArray(roster.writers?.partitions) ? roster.writers.partitions : []
    take(parts.find((p) => p !== null && p !== undefined && p.seat === seat))
  }
  // ③ 角色上的裸声明
  const seq = Array.isArray(roster.sequence) ? roster.sequence : []
  take(seq.find((s) => s !== null && s !== undefined && s.role === role))
  return out
}



/**
 * 构造名单的**四槽表**（`roster.slots`）—— "每个席位拿到什么档"的唯一出处。
 *
 * @param {string[]} conversations - roster 里的独立对话清单（角色 id）
 * @param {object|null} writers - buildWriters 的结果（编写席位分区）
 * @param {object} input - { slots?: {键: 声明}, strictSlots?: boolean }
 * @returns {{ok:true, slots:object, digest:string, missing:string[]} | {ok:false, error:string}}
 */
export function buildRosterSlots(conversations, writers, input = {}) {
  const raw = input.slots !== null && typeof input.slots === 'object' ? input.slots : {}
  const known = Object.keys(raw)
  const targets = rosterSlotTargets(conversations, writers)
  const targetsSet = new Set(targets.map((t) => slotKeyOf(t.role, t.seat)))
  const strays = known.filter((k) => !targetsSet.has(k))
  if (strays.length > 0) {
    return {
      ok: false,
      error:
        `名单四槽表里有 ${strays.length} 个键对不上本次清单里的任何角色或席位：${strays.join('、')}\n` +
        `本次清单的键：${[...targetsSet].join('、')}\n` +
        '★ 对不上就是"声明了但没有这个席位"—— 那比不声明更危险：它看起来像已经安排好了。',
    }
  }

  const strict = input.strictSlots === true
  const slots = {}
  const missing = []
  for (const t of targets) {
    const key = slotKeyOf(t.role, t.seat)
    const declaredHere = Object.hasOwn(raw, key)
    const needDeclare = slotRoleNeedsDeclaration(t.role)
    if (!declaredHere && needDeclare) missing.push(key)
    if (!declaredHere && !needDeclare) continue
    const who = t.seat === null ? t.role : `${t.role}（席位 ${t.seat}）`
    const built = normalizeRosterSlots(raw[key], { who, role: t.role, seat: t.seat })
    if (built.ok !== true) return { ok: false, error: built.error }
    slots[key] = built.slots
  }

  if (strict && missing.length > 0) {
    return {
      ok: false,
      error:
        `名单缺少 ${missing.length} 个席位的四槽声明：${missing.join('、')}\n` +
        '★ 四槽（权限档、内置模式、模型、推理等级）是**四个平级字段**，不许打包成一个 options 对象；\n' +
        '  缺任一槽即不算声明 —— 否则"名单声明什么档、会话实际拿到什么档"就无从判定（B1）。',
    }
  }

  return { ok: true, slots, digest: stableStringify(slots), missing }
}

// ★ 开对话留痕那一小块也单独成文件（同上一条纪律），本文件只转出。
export { DISPATCH_OPEN_AUDIT_FIELDS, DISPATCH_OPEN_ACTION, dispatchOpenRecord } from './dispatch-open.js'
