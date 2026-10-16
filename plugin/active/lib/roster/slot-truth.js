/**
 * dsh-pipeline · 角色清单 · **四槽的"声明值"与"实际生效值"**
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ②）
 * -----------------------------------------------------------------------------
 * 现场：
 *   · `roster.slots` 里 writer / tester / reviewer **三槽回读全是 `read-only`
 *     （`origin: default`）**，可三席**全都写成功了**；
 *   · 主对话显式传了 `permission: workspace-write`，派活输出回读"**核对一致**"，
 *     而槽位里**仍然**是 `read-only`。
 *
 * -----------------------------------------------------------------------------
 * 根因（不是"没接线"，是**这张表被当成它并不是的东西**）
 * -----------------------------------------------------------------------------
 * `roster.slots` 是**声明表**（计划/规则引擎**声明**"这个席位该拿什么档"），
 * 而派活那一刻真正生效的档取自**另一条优先级**（`dispatchSlots`）：
 *
 *     ① 本次请求显式给的（`args.permission` …）  ← 主对话 override 走这条
 *     ② 名单里为该席位/角色声明的（**只认 `origin === 'declared'`**）
 *     ③ 都没有 ⇒ 通道取兜底
 *
 * 于是"名单没声明 + 主对话显式给"这种形状里：
 *   实际生效 = `workspace-write`（对，会话真的拿到了），
 *   名单里躺着 = `read-only`（`origin: default` 的**占位**）。
 * 两边都没错，但**没人把"实际生效值"记下来** ⇒ 谁去读 `roster.slots`
 * 都会得出"这三席只有只读权限"，与事实相反 —— **字段在误导**。
 *
 * -----------------------------------------------------------------------------
 * 修法（接线 + 如实登记，两条一起）
 * -----------------------------------------------------------------------------
 *   ① **接线**：`origin === 'declared'` 的槽是**冻结的**，请求与它不符 ⇒ **拒绝派活**
 *      （这正是 `compareDispatchSlots` 当初要干的事 —— 只是它从来没有调用点）。
 *      ★ `origin === 'default'` 的槽**不算声明**，请求可以覆盖它（现场那种形状照旧放行），
 *      但**必须记下来**；
 *   ② **如实登记**：每次派活把"实际生效值 + 每槽的来源"追加到 `task.dispatch_slots[]`，
 *      并**点名**哪几槽覆盖了名单里的占位值 —— 从此 `roster.slots` 不会再被当成
 *      "席位实际拿到了什么"。
 *
 * ★ 纯函数、只读：不建结构、不改名单、不做 IO。名单没有四槽时它是**空操作**。
 *
 * @module dsh-pipeline/lib/roster/slot-truth
 */

/** 四槽的名字（与 `transport.DISPATCH_SLOT_KEYS` 同源；这里刻意写字面量保持零依赖）。 */
export const SLOT_KEYS = Object.freeze(['permission', 'mode', 'model', 'reasoning'])

/** 槽值的来源（写进留痕，读的人一眼看得出这档是谁定的）。 */
export const SLOT_ORIGIN = Object.freeze({
  REQUEST: 'request',
  DECLARED: 'declared',
  DEFAULT: 'default',
})

/** 从名单里取某个角色/席位的四槽条目（席位优先于裸角色 —— 与既有取值口径同源）。 */
export function rosterSlotEntry(roster, role, seat) {
  const table = roster !== null && typeof roster === 'object' && roster.slots !== null && typeof roster.slots === 'object' ? roster.slots : null
  if (table === null) return null
  const withSeat = seat === null || seat === undefined ? undefined : table[`${role}@${seat}`]
  const bare = table[role]
  return withSeat ?? bare ?? null
}

/** 某一槽在名单里是不是**显式声明**的（`origin === 'declared'`）。 */
function isDeclared(entry, slot) {
  const cell = entry === null || typeof entry !== 'object' ? null : entry[slot]
  if (cell === null || cell === undefined) return false
  return cell.origin === SLOT_ORIGIN.DECLARED
}

/** 取名单里那一槽的值（取不到给 null）。 */
function declaredValue(entry, slot) {
  const cell = entry === null || typeof entry !== 'object' ? null : entry[slot]
  if (cell === null || cell === undefined) return null
  const v = cell.value
  return v === undefined ? null : v
}

/** 取名单里那一槽的 origin（取不到给 `default`）。 */
function declaredOrigin(entry, slot) {
  const cell = entry === null || typeof entry !== 'object' ? null : entry[slot]
  const o = cell === null || cell === undefined ? null : cell.origin
  return typeof o === 'string' && o.length > 0 ? o : SLOT_ORIGIN.DEFAULT
}

/**
 * 算出**这一席实际该拿什么档**，并如实标出每槽的来源与"覆盖了名单里的占位值"这件事。
 *
 * @param {object} input
 * @param {object|null} input.roster - `task.roster`
 * @param {string} input.role
 * @param {string|null} [input.seat]
 * @param {object} [input.requested] - 本次派活显式给的四槽（`{permission?, mode?, model?, reasoning?}`）
 * @param {Record<string,string>} [input.origins] - ★ **推导出来的**槽的来源标注
 *   （`{'permission': 'role-need'}`）—— 只用于把留痕里的 `origin` 写**实话**：
 *   派生值不是"调用方显式给的"，标成 `request` 会让读审计的人得出相反结论。
 *   不传 ⇒ 与改前**逐字节相同**（全部按既有判据标）。
 * @returns {{
 *   slots: Record<string,string|undefined>,
 *   provenance: Record<string,{value:any, origin:string}>,
 *   divergences: Array<{slot:string, declared:any, declared_origin:string, requested:any, resolved:any}>,
 *   blocked: {slot:string, declared:any, requested:any, reason:string}|null
 * }}
 */
export function resolveEffectiveSlots({ roster, role, seat = null, requested = {}, origins = {} } = {}) {
  const entry = rosterSlotEntry(roster, role, seat)
  const derived = origins !== null && typeof origins === 'object' ? origins : {}
  const slots = {}
  const provenance = {}
  const divergences = []
  let blocked = null

  for (const slot of SLOT_KEYS) {
    const asked = requested === null || requested === undefined ? undefined : requested[slot]
    const hasAsked = typeof asked === 'string' && asked.length > 0
    const declared = declaredValue(entry, slot)
    const origin = declaredOrigin(entry, slot)

    /**
     * ★★ **冻结的槽不许被覆盖面**。
     *
     * `origin === 'declared'` = 计划/规则引擎**显式声明**过这一槽 ⇒ 名单是权威，
     * 请求与它不符就**拒绝派活**（不静默降级、也不静默升级）。
     * 这条正是 `compareDispatchSlots` 当初的判据（B2）—— 它此前没有任何调用点。
     */
    if (hasAsked && isDeclared(entry, slot) && declared !== null && asked !== declared) {
      blocked = {
        slot,
        declared,
        requested: asked,
        reason:
          `名单里「${role}${seat === null ? '' : `（席位 ${seat}）`}」的 **${slot}** 是**显式声明**的（\`${declared}\`），` +
          `而本次派活要 \`${asked}\` —— 两者不符。\n` +
          '★ 声明过的槽是**冻结**的：要改就改名单（pipeline_plan 的 slots / pipeline_roster_review），' +
          '不许在派活那一刻悄悄换一档 —— 否则"名单声明什么档、会话实际拿到什么档"就无从判定。',
      }
      return { slots, provenance, divergences, blocked }
    }

    if (hasAsked) {
      slots[slot] = asked
      /**
       * ★ 来源标注（顺序即优先级，全是**实话**）：
       *   ① 名单显式声明过 ⇒ `declared`；
       *   ② 调用方给了 `origins` 说这一槽是**推导**出来的（`role-need`）⇒ 用它 ——
       *      标成 `request` 会让"这一档是谁定的"从审计里读反；
       *   ③ 其余 ⇒ `request`（本次请求显式给）。
       */
      const told = typeof derived[slot] === 'string' && derived[slot].length > 0 ? derived[slot] : ''
      provenance[slot] = {
        value: asked,
        origin: isDeclared(entry, slot) ? SLOT_ORIGIN.DECLARED : told.length > 0 ? told : SLOT_ORIGIN.REQUEST,
      }
      /**
       * ★ **覆盖了名单里的"占位默认值"** —— 这就是缺陷 ② 现场那种形状：
       *   名单没声明（`origin: default`，值是最小档），主对话显式给了更高的档。
       *   放行，但**必须记下来**，否则读名单的人会以为这席只有只读。
       */
      if (!isDeclared(entry, slot) && declared !== null && declared !== asked) {
        divergences.push({ slot, declared, declared_origin: origin, requested: asked, resolved: asked })
      }
      continue
    }

    if (declared !== null) {
      slots[slot] = declared
      provenance[slot] = { value: declared, origin: isDeclared(entry, slot) ? SLOT_ORIGIN.DECLARED : SLOT_ORIGIN.DEFAULT }
      continue
    }
    // 三处都没有 ⇒ **不产出这个键**（这一槽没给），由通道按契约取兜底并留痕。
    provenance[slot] = { value: null, origin: SLOT_ORIGIN.DEFAULT }
  }

  return { slots, provenance, divergences, blocked }
}

/**
 * 把"覆盖了名单占位值"这件事渲染成人话（派活摘要 + 状态查询共用）。
 *
 * @param {Array} divergences - {@link resolveEffectiveSlots} 的 `divergences`
 * @returns {string} 没有覆盖时返回空串
 */
export function describeSlotDivergence(divergences) {
  const list = Array.isArray(divergences) ? divergences : []
  if (list.length === 0) return ''
  return (
    `⚠ **本次派活的四槽与名单里的占位值不一致**（${list.length} 槽）：\n` +
    list
      .map(
        (d) =>
          `  · ${d.slot}：名单里是 \`${d.declared}\`（origin=${d.declared_origin}，**未声明**的占位值），` +
          `本次实际生效 \`${d.resolved}\``,
      )
      .join('\n') +
    '\n★ 名单里的 `slots` 是**声明表**，不是"席位实际拿到了什么" —— 实际生效值记在 ' +
    '`task.dispatch_slots[]` 里（本次已记）。要让名单与事实一致，就在 pipeline_plan 的 slots 里显式声明。'
  )
}
