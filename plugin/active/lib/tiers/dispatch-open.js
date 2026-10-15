// 开对话留痕：字段表 + 一条记录的形状（纯函数，不写盘）。
/**
 * dsh-pipeline · 档位规则 · **开对话留痕**（A1 / A2 / B6 的字段面）
 * ============================================================================
 * 从 `lib/tiers/roster-slots.js` 再抽出来的一小块（代码逐字节搬过来，行为未改），
 * 理由同上一层的抽取：**行数纪律**（`CONVENTIONS.md` §4：单文件 ≤400 行）。
 * 它自成一域 —— "开一次对话要留哪些痕"，与"四槽表怎么拼"不是一个改动原因。
 *
 * 对外仍经 `lib/tiers.js` 转出。
 *
 * @module dsh-pipeline/lib/tiers/dispatch-open
 */

/**
 * ★ **开对话留痕**的字段表（A1 / A2 / B6 的判据落点）。
 *
 * 一条留痕 = 一次开对话请求（**接受与拒绝都留**），字段全部平级、可机读；
 * 拒绝必须带 reason（B6 明文）。
 */
export const DISPATCH_OPEN_AUDIT_FIELDS = Object.freeze([
  'actor_role',
  'actor_seat',
  'target_role',
  'target_seat',
  'permission',
  'mode',
  'model',
  'reasoning',
  'roster_version',
  'at',
  'verdict',
  'reason',
])

/** 「开对话」留痕的动作名（走既有 audit 入口，不另建第二套日志）。 */
export const DISPATCH_OPEN_ACTION = 'dispatch:open'

/**
 * ★ **开对话留痕的一条记录**（A1 / A2 / B6 的字段面）—— 纯函数，不写盘。
 *
 * 只干一件事：把一次「开对话」请求收敛成**恰好 12 个字段**（键名与顺序 = `DISPATCH_OPEN_AUDIT_FIELDS`），
 * 让"被接受"与"被拒绝"在审计流水里是**同一种形状**的记录（机读）。
 * 落盘由 `store.recordDispatchOpen()` 走**既有** audit 入口完成（不另建第二套日志）。
 *
 * 三条刻意的取舍（不是宽容）：
 *   ① **留痕优先于报错**：`verdict` 认不出、或"拒绝却没给原因"时，本函数**仍然产出记录**
 *      （结论落成 reject，原因里写明这次是调用方违约），违约项列进 `defects`。
 *      理由：留痕是审计的底线 —— 一条缺字段的痕迹，也好过"什么都没留下"。
 *   ② **不归一四槽**：permission / mode / model / reasoning **原样照抄**请求里的值（缺就写 null）。
 *      "与名单是否逐字相等"是 `compareDispatchSlots()`（B2）的活，两处职责不许混。
 *   ③ **roster_version 只从名单上取**：它得回答"这次开对话依据的是哪一版名单"（B6）；
 *      名单没有版本位就写 null（老清单）—— 不许编一个 0 冒名"第 0 版"。
 *
 * @param {object} input - { actorRole, actorSeat, targetRole, targetSeat, permission, mode, model, reasoning, verdict, reason }
 * @param {object|null} [roster] - 任务当前 roster（取 `slots_version`）
 * @param {{at?:string}} [opts]
 * @returns {{record:object, defects:string[]}}
 */
export function dispatchOpenRecord(input = {}, roster = null, opts = {}) {
  const defects = []
  const idOf = (v) => (v === null || v === undefined || String(v).length === 0 ? null : String(v))
  /** 四个槽位原样照抄，但必须是**能被 JSON 序列化**的值（函数会被 JSON.stringify 整键丢掉 ⇒ 记录少字段）。 */
  const slotOf = (v) => {
    if (v === undefined || v === null) return null
    if (typeof v === 'function') return '<function>'
    if (typeof v === 'string') return v.length === 0 ? null : v
    if (typeof v === 'number' || typeof v === 'boolean') return v
    try {
      const j = JSON.parse(JSON.stringify(v))
      return j === undefined ? null : j
    } catch {
      return String(v)
    }
  }

  const verdictRaw = String(input.verdict ?? '').trim().toLowerCase()
  const ACCEPT = ['accept', 'accepted', 'ok', '接受']
  const REJECT = ['reject', 'rejected', 'deny', 'denied', '拒绝']
  let verdict = 'reject'
  let reason = idOf(input.reason)
  if (ACCEPT.includes(verdictRaw)) {
    verdict = 'accept'
  } else if (REJECT.includes(verdictRaw)) {
    verdict = 'reject'
  } else {
    // 认不出的结论**按未通过落痕**（fail-closed）：不许把"没看懂"记成"接受"。
    defects.push('VERDICT_INVALID')
    reason =
      `结论取值非法（${JSON.stringify(input.verdict ?? null)}）：只能是 accept 或 reject。` +
      '★ 认不出的结论一律按**未通过**落痕，不许当成接受。'
  }
  if (verdict === 'reject' && reason === null) {
    defects.push('REJECT_REASON_MISSING')
    reason = '(拒绝但未给出原因 —— 违反 B6：拒绝记录里必须含拒绝原因)'
  }

  const rv =
    roster !== null && typeof roster === 'object' && Number.isInteger(roster.slots_version) ? roster.slots_version : null

  /** 键名与顺序**逐字**对齐 DISPATCH_OPEN_AUDIT_FIELDS（机读的那份契约）。 */
  const record = {
    actor_role: idOf(input.actorRole),
    actor_seat: idOf(input.actorSeat),
    target_role: idOf(input.targetRole),
    target_seat: idOf(input.targetSeat),
    permission: slotOf(input.permission),
    mode: slotOf(input.mode),
    model: slotOf(input.model),
    reasoning: slotOf(input.reasoning),
    roster_version: rv,
    at: idOf(opts.at) ?? idOf(input.at) ?? new Date().toISOString(),
    verdict,
    reason,
  }

  return { record, defects }
}

