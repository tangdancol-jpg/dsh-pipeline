// 交接物记录 · 构造与摘要：`buildHandoffRecord`（id / 时间 / 来源 / 席位 / 内容哈希）、`resolveHandoffSeat`、`summarizeHandoff`、`makeTaskId`。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/handoff/record.js` 原样搬来（**只改了 import 路径与说明文字，行为未改**）。
 * 对外仍经原模块转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 *
 * @module dsh-pipeline/lib/model/handoff-record
 */

import { clamp, newTaskId, shortHash } from '../util.js'
import { HANDOFF_SCHEMAS } from './handoff-schemas.js'

/** 「席位 id」的形状：全限定的 `writer#2`（编写席位 id 本身就是全限定的，见 `liveness.seatKey`）。 */
const SEAT_ID_PATTERN = /^[a-z][a-z0-9_]*#[1-9]\d*$/

/**
 * ★★ **P2-7：解析一份交接物的「席位」**（"是谁交的"里的后半截）。
 *
 * ---------------------------------------------------------------------------
 * 背景（实测，不是推测）
 * ---------------------------------------------------------------------------
 * `buildHandoffRecord` 从来不写这个字段 —— 真单 `T-20261012-8cdee0` 的 **22 份
 * handoffs 一份都没有 `from_seat` 键**（★ 注意：**不是 `null`，是压根不存在**，
 * 所以按 `=== null` 筛选根本筛不出来）。后果：多编写席位时「writer#2 交的东西」
 * 与「writer#1 交的东西」在记录里**分不出来**，只能回审计日志反查 `seat:submit`。
 *
 * ---------------------------------------------------------------------------
 * 取值来源：三级，按权威性降序 —— **不猜、不硬编码**
 * ---------------------------------------------------------------------------
 *   ① **令牌席位**（调用方给的 `fromSeat` / `actorSeat`）—— 唯一凭据来源。
 *      口径与 `store.submitHandoff` 里澄清请求那条**逐字一致**：
 *      「席位只从令牌来，不让调用方在 payload 里自报 —— 那是第二个真相源，
 *        而'谁问的'必须由凭据决定」。
 *   ② **`payload.partition.seat`**（只有 `dev_to_test` 有这个字段）。
 *      ★ 它**不是**自报值：store 层的 `checkSeatOwnership` 会拿**令牌席位**与它
 *      逐字核对，不一致直接 `SEAT_MISMATCH` 拒收；调用方没给时，它由**角色清单
 *      的分区表**（`roster.writers.partitions[].seat`）回填。
 *      ⇒ 能走到这里，它已经是"令牌核对过的在册席位"。
 *   ③ **角色名**（`fromRole`）—— 单席位角色（`tester` / `reviewer` / `planner` …）
 *      本来就只有**一个**席位，那个席位的名字就是角色名。这与项目既有口径同源
 *      （`liveness.seatKey(role, seat) = seat || role`）。
 *      ⇒ 所以交付记录里的 `from_seat` **不会是 `undefined` / `null`**。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 两个必须写下来的边界
 * ---------------------------------------------------------------------------
 *   · 读 `payload.partition.seat`，**绝不读 `payload.from_seat`** ——
 *     后者在 `seat_handover`（席位继任）里是"**旧**席位"的意思，同名不同义；
 *     混用会把"交的人"写成"被接班的那个人"。
 *   · ③ 这条取值与 `wakeup.actorKeyOf(role, seat)` 的既有假设（"非编写角色
 *     seat 为空"）**不一致**：那里对非空 seat 会拼成 `${role}#${seat}`，
 *     于是 `from_seat='tester'` 会算成 `tester#tester`。影响面只有一处：
 *     `ledgerIdentityScoped` 的「作者对齐」在**拿不到工具返回值判别子**时的
 *     候选回退（正常交付走的是返回值里的 `handoff_id`，不经过它）。
 *     这条**不在本文件**（`lib/wakeup.js`），故只如实记录、不越界改：
 *     推荐的一行硬化是 `actorKeyOf` 里加 `seat === role ⇒ 视作无席位`。
 *
 * @param {{fromSeat?:string|null, actorSeat?:string|null, fromRole?:string|null, payload?:object|null}} [input]
 * @returns {string|null} 席位（`writer#2` / `tester` …）；**连角色都取不到时如实给 null**，不编造
 */
export function resolveHandoffSeat(input = {}) {
  // ① 令牌席位（唯一凭据来源）
  for (const raw of [input?.fromSeat, input?.actorSeat]) {
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  }
  // ② dev_to_test 的分区席位（store 层已用令牌核对过）
  const declared = input?.payload?.partition?.seat
  if (typeof declared === 'string' && SEAT_ID_PATTERN.test(declared.trim())) return declared.trim()
  // ③ 单席位角色：席位名就是角色名
  const role = typeof input?.fromRole === 'string' ? input.fromRole.trim() : ''
  return role.length > 0 ? role : null
}

/**
 * 把一份交接物包装成可落盘的记录（带 id、时间、来源、内容哈希）。
 *
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.taskId
 * @param {string} input.fromRole
 * @param {string} [input.fromSeat] - ★ 令牌席位（调用方从凭据里取；缺省时按 {@link resolveHandoffSeat} 的口径推导）
 * @param {string} [input.actorSeat] - 同上（本插件里"令牌席位"的惯用字段名）
 * @param {string} input.toRole
 * @param {object} input.payload
 * @param {string} [input.artifactVersion]
 * @param {string} [input.seq]
 * @returns {object}
 */
export function buildHandoffRecord(input) {
  const payload = input.payload ?? {}
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    // ⚠️ 哈希必须带**序号**与**毫秒**：光靠"秒级时间戳 + payload"会让
    //    "同一秒内提交两份内容完全相同的交接物"撞成同一个 id
    //    （两级升级梯里"同一个问题问第二遍"正好就是这样）。
    handoff_id: `H-${shortHash(`${input.kind}|${input.taskId}|${input.seq ?? 0}|${new Date().toISOString()}|${JSON.stringify(payload).slice(0, 200)}`)}`,
    task_id: input.taskId,
    kind: input.kind,
    kind_zh: HANDOFF_SCHEMAS[input.kind]?.zh ?? input.kind,
    from_role: input.fromRole,
    /**
     * ★★ **P2-7：谁交的（席位）** —— 与 `from_role` 成对，形状 `writer#2` / `tester`。
     *
     * 为什么必须落盘而不是"要用时再推"：多编写席位时，光有 `from_role='writer'`
     * 分不出「writer#1 交的」与「writer#2 交的」（真单里 22 份 handoffs 全是这个形状，
     * 只能回审计反查）。取值的三级来源与理由见 {@link resolveHandoffSeat}。
     *
     * ★ **向后兼容**：这一条只影响**新写**的记录。已有的旧交接物
     *   （改前落的，压根没有这个键）**不迁移、不重写**；读侧（`summarizeHandoff`）
     *   按同一口径推导着显示，照常工作。
     */
    from_seat: resolveHandoffSeat({ fromSeat: input.fromSeat, actorSeat: input.actorSeat, fromRole: input.fromRole, payload }),
    to_role: input.toRole,
    created_at: stamp,
    artifact_version: input.artifactVersion ?? payload.artifact_version ?? null,
    payload,
    /** 内容的稳定哈希：用于"审核的是不是同一个版本"这类判定。 */
    content_hash: shortHash(JSON.stringify(payload)),
  }
}

/**
 * 生成给主对话看的**脱敏摘要**。
 *
 * ★ 这是「主对话与代码正文隔离」的落地手段之一：主对话在 pipeline_status 里
 *   拿到的是摘要，不是 patch 正文。真正的隔离仍然依赖守门（主对话读源码文件
 *   会被拦），这里做的是"默认不给"。
 *
 * @param {object} record
 * @param {number} [maxText]
 * @returns {object}
 */
export function summarizeHandoff(record, maxText = 400) {
  const redactedFields = new Set(['patch_or_code', 'failure_logs', 'run_commands'])
  const out = {
    handoff_id: record.handoff_id,
    kind: record.kind,
    kind_zh: record.kind_zh,
    from_role: record.from_role,
    /**
     * ★ P2-7：**只读导出也看得见席位**（"哪个席位交的"不必再回审计反查）。
     *
     * ⚠️ 这是**只增字段**：上面那些既有字段一个都不动 —— 既有读者照旧。
     * 旧记录（改前落的）没有这个键，这里按**同一条口径**推导出来照样显示
     * （`dev_to_test` 从 `payload.partition.seat` 推，其余角色就是角色名），
     * 所以"读的时候缺字段"能正常工作，且**不会**回头改写盘上的旧记录。
     */
    from_seat: resolveHandoffSeat({ fromSeat: record.from_seat, fromRole: record.from_role, payload: record.payload }),
    to_role: record.to_role,
    created_at: record.created_at,
    artifact_version: record.artifact_version,
    summary: {},
    redacted: [...redactedFields].filter((f) => Object.hasOwn(record.payload ?? {}, f)),
  }
  for (const [k, v] of Object.entries(record.payload ?? {})) {
    if (redactedFields.has(k)) {
      const len = typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0
      out.summary[k] = `«已隐去正文：${len} ${typeof v === 'string' ? '字符' : '条'}»`
      continue
    }
    if (typeof v === 'string') out.summary[k] = clamp(v, maxText)
    else if (Array.isArray(v)) out.summary[k] = v.map((x) => clamp(x, 200))
    else out.summary[k] = v
  }
  return out
}

/** 生成一个默认的任务 id（供测试与示例用）。 */
export function makeTaskId() {
  return newTaskId()
}
