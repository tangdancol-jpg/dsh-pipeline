/**
 * dsh-pipeline · 任务存储 · **每次派活的四槽实际生效值**（缺陷 ② / F11 的落盘半边）
 * ============================================================================
 * 「声明」与「事实」必须分两处存 —— 但**必须能一次查齐**：
 *
 *   · `task.roster.slots[<键>]`            = **声明表**（计划/规则引擎声明该拿什么档）
 *   · `task.roster.slots_effective[<键>]`  = **事实**（该席位最近一次派活实际生效的档）★ F11 新增
 *   · `task.dispatch_slots[]`              = **流水**（每一次派活的完整记录，只追加）
 *
 * 为什么要单独开这一格（真机 T-20261015-bb30bc）：现场三席的 `roster.slots.permission`
 * 全是 `read-only`（`origin: default` 的占位值），而三席**全都写成功了** ——
 * 因为实际档是主对话在派活时显式覆盖的 `workspace-write`。改前**没有任何地方**
 * 记下这个覆盖 ⇒ 读名单的人只会得出相反的结论。
 *
 * ★★ 缺陷 F11 的关键取舍：**为什么不直接改写 `roster.slots` 本身**
 *   因为 `roster.slots` 是**带摘要冻结**的（`lib/tiers.js:451` 的 `slots_digest`，
 *   由 `buildRosterSlots` 的产物算出）。就地改写它有两个后果：
 *     ① 那张表不再是"当初声明了什么"的历史证据，`slots_version` 的语义也跟着坏掉；
 *     ② `compareDispatchSlots`（`tiers.js:1265`）是**拿 `roster.slots` 当基准**去比对的 ——
 *        基准被改成现实之后，比对永远通过，"冻结"就成了一张废纸。
 *   ⇒ 所以用**同键的平行表** `slots_effective`：一次 `roster.slots_effective[key]` 就能
 *     拿到"这个席位实际拿到了什么"，两个真相在同一次查找里都看得到，而声明表与摘要不动。
 *
 * ★ 只追加、有上限、永不改写名单：`dispatch_slots` 保留最近 {@link MAX_DISPATCH_SLOT_RECORDS} 条。
 * ★ 与 `recordDispatch`（席位台账，**会被 upsert 覆盖**）刻意分开：那份是"怎么找到这个席位"，
 *   这份是"这个席位当时拿到什么档"，两者的生命周期不同。
 *
 * @module dsh-pipeline/lib/store/dispatch-slots
 */

import { ROLE } from '../roles.js'
import { slotKeyOf } from '../tiers.js'

/** 保留最近多少条派活四槽记录（够回溯一轮打回，又不会把 task.json 撑大）。 */
export const MAX_DISPATCH_SLOT_RECORDS = 24

/**
 * 「每次派活的四槽实际生效值」—— 由 `createTaskStore` 原位展开。
 *
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字
 */
export function dispatchSlotMethods(ctx) {
  const { now, audit, deny, loadTask, persist } = ctx

  return {
    /**
     * 记一次派活的四槽**实际生效值**。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.role
     * @param {string|null} [input.seat]
     * @param {object} [input.slots] - 实际下发的四槽（`{permission, mode, model, reasoning}`）
     * @param {object} [input.provenance] - 每槽来源（`{slot: {value, origin}}`）
     * @param {Array} [input.divergences] - 覆盖了名单占位值的那些槽
     * @param {string|null} [input.actorAgentId]
     * @returns {Promise<{ok:boolean, task?:object, record?:object, error?:string}>}
     */
    async recordDispatchSlots(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const role = String(input.role ?? '')
      if (role.length === 0) return deny('BAD_INPUT', '记派活四槽必须给 role。')

      const record = {
        at: nowIsoOf(now()),
        role,
        seat: input.seat === undefined || input.seat === null || input.seat === '' ? null : String(input.seat),
        /** ★ 实际生效值 —— 这才是"这个席位拿到了什么档"。 */
        effective: normalizeSlotsForRecord(input.slots),
        /** 每槽的来源：`request`（本次显式给）/ `declared`（名单显式声明）/ `default`（谁都没给）。 */
        provenance: normalizeProvenance(input.provenance),
        /** ★ 覆盖了名单里**占位值**的那些槽（名单没声明、本次显式给了别的档）。 */
        divergences: Array.isArray(input.divergences)
          ? input.divergences.map((d) => ({
              slot: String(d?.slot ?? ''),
              declared: d?.declared ?? null,
              declared_origin: String(d?.declared_origin ?? 'default'),
              resolved: d?.resolved ?? null,
            }))
          : [],
        agent: input.actorAgentId ?? null,
      }

      const prev = Array.isArray(task.dispatch_slots) ? task.dispatch_slots : []
      task.dispatch_slots = [...prev, record].slice(-MAX_DISPATCH_SLOT_RECORDS)
      // ★ F11：同键的"实际生效值"表 —— 让 `roster` 一个对象里就能同时看到声明与事实。
      const effectiveTable = writeEffectiveEntry(task, record, input)
      const entry = await audit(task.id, String(input.actorRole ?? ROLE.MAIN), 'dispatch:slots', {
        role: record.role,
        seat: record.seat,
        effective: record.effective,
        divergences: record.divergences.length,
        effective_key: effectiveTable.key,
        roster_declares_the_seat: effectiveTable.declaredPresent,
      })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, record, effective_key: effectiveTable.key, declared_present: effectiveTable.declaredPresent }
    },
  }
}

/**
 * 把这一次的**实际生效值**写进同键的平行表 `task.roster.slots_effective[<键>]`。
 *
 * 键与声明表**同一套规则**（`slotKeyOf`：带席位 `role@seat`、不带席位 `role`），
 * 所以 `roster.slots[k]` 与 `roster.slots_effective[k]` 永远指同一个席位。
 *
 * ★ 声明表 `roster.slots` **一个字节都不动**（它带摘要冻结，见模块头）。
 * ★ 同时记下 `declared_present`：这个席位在声明表里**有没有**条目 ——
 *   "声明了 null" 与 "压根没声明" 是两件事，读的人要能分开。
 *
 * @returns {{key:string, declaredPresent:boolean}}
 */
function writeEffectiveEntry(task, record, input) {
  const key = slotKeyOf(record.role, record.seat)
  const roster = task.roster !== null && typeof task.roster === 'object' ? task.roster : null
  const declaredPresent = roster !== null && roster.slots !== null && typeof roster.slots === 'object' && Object.hasOwn(roster.slots, key)
  if (roster === null) return { key, declaredPresent: false }
  if (roster.slots_effective === null || typeof roster.slots_effective !== 'object') roster.slots_effective = {}
  const evidence = input.evidence !== null && typeof input.evidence === 'object' ? input.evidence : {}
  roster.slots_effective[key] = {
    /** 这个席位最近一次派活**实际生效**的四槽值。 */
    effective: record.effective,
    /** 每槽来源：`request`（本次显式给）/ `declared`（名单显式声明）/ `default`（谁都没给）。 */
    provenance: record.provenance,
    /**
     * ★ 每槽的**证据等级**（F11）：`readback` = 真读回并比对过；
     *   `requested` = 只发了请求、**没有回读**；`readback_unavailable` = 想读但宿主没有接口。
     *   ⇒ 看到 `requested` 就不许把这一槽读成"已确认生效"。
     */
    evidence: {
      permission: typeof evidence.permission === 'string' ? evidence.permission : null,
      mode: typeof evidence.mode === 'string' ? evidence.mode : null,
      model: typeof evidence.model === 'string' ? evidence.model : null,
      reasoning: typeof evidence.reasoning === 'string' ? evidence.reasoning : null,
    },
    /** 这个席位在**声明表**里有没有条目（false = 声明表压根没提它，不是"声明成空"）。 */
    declared_present: declaredPresent,
    at: record.at,
    agent: record.agent,
  }
  return { key, declaredPresent }
}

function nowIsoOf(d) {
  const t = d instanceof Date ? d : new Date(d)
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function normalizeSlotsForRecord(slots) {
  const out = {}
  for (const k of ['permission', 'mode', 'model', 'reasoning']) {
    const v = slots === null || slots === undefined ? undefined : slots[k]
    out[k] = v === undefined ? null : v
  }
  return out
}

function normalizeProvenance(p) {
  const out = {}
  for (const k of ['permission', 'mode', 'model', 'reasoning']) {
    const cell = p === null || p === undefined ? null : p[k]
    out[k] = {
      value: cell?.value ?? null,
      origin: typeof cell?.origin === 'string' && cell.origin.length > 0 ? cell.origin : 'default',
    }
  }
  return out
}
