// 领域对象统一出口：任务 / 基线 / 制品 / 关单报告 / 人工介入请求这五个对象的定义与构造，以及交接物的字段表。
/**
 * dsh-pipeline · 领域对象（统一出口）
 * ============================================================================
 * 这个目录只放**领域对象本身**：它们的**字段清单、默认值、构造（工厂）、对象级纯函数**。
 * 它**不放**任何副作用（读写盘 / 审计 / 状态推进）—— 那些仍在 `lib/store/**`。
 *
 * ★ 依赖方向是**单向**的：
 *   `lib/store/**` 与 `lib/handoff/**` → `lib/model/**`
 *   `lib/model/**` **不 import** store / handoff。
 *   于是"对象长什么样"只在这里定义一次，判据与写盘各自引用它，不会两边各抄一份。
 *
 * ★ 原模块的**导出面逐字未变**：`lib/store.js` / `lib/handoff.js` 与
 *   `lib/handoff/{fields,schemas,record}.js`、`lib/handoff/schemas/product-design.js`
 *   全部保留原名、原路径（有搬动的都留了转出），调用方不需要改 import。
 *
 * | 文件 | 领域对象 | 原出处 |
 * | --- | --- | --- |
 * | `task.js` | 任务卡初始结构 + `task.task_card` | `store/lifecycle.js` · `store/roster.js` |
 * | `baseline.js` | 改动基线记录 | `store/baseline.js` |
 * | `artifact.js` | 制品版本记录 | `store/review.js` |
 * | `close-report.js` | 关单报告 `task.close_report` | `store/review.js` |
 * | `human-request.js` | 人工介入请求登记 `task.human_requests[]` | `store/shared.js` |
 * | `handoff-fields.js` | 字段类型 DSL `F` + 人工介入枚举 | `handoff/fields.js` |
 * | `handoff-schemas.js` | `HANDOFF_SCHEMAS` 字段表 | `handoff/schemas.js` |
 * | `handoff-product-design.js` | `product_design` 字段表 | `handoff/schemas/product-design.js` |
 * | `handoff-record.js` | 交接物记录构造 / 席位 / 摘要 / 任务 id | `handoff/record.js` |
 *
 * @module dsh-pipeline/lib/model
 */

export { makeTaskRecord, makeTaskCard } from './task.js'
export { makeBaselineRecord } from './baseline.js'
// ★ P1-10：制品快照（`files` + `snapshot_id` + 校验视图）的纯函数，单一出处。
export {
  SNAPSHOT_MAX_FILES,
  makeArtifactRecord,
  normalizeSnapshotPath,
  snapshotIdOf,
  makeArtifactSnapshotRecord,
  artifactRecordOf,
  isSnapshotRecord,
  describeArtifactSnapshot,
} from './artifact.js'
export { makeCloseReport } from './close-report.js'
export { buildHumanRequestEntry } from './human-request.js'

// 交接物（handoff）这个领域对象的字段表与记录构造。
export {
  F,
  HUMAN_REASON_KINDS,
  HUMAN_DECISION_KINDS,
  HUMAN_TIMEOUT_BEHAVIORS,
  HUMAN_URGENCIES,
} from './handoff-fields.js'
export { HANDOFF_SCHEMAS } from './handoff-schemas.js'
export {
  PRODUCT_DESIGN_KIND,
  CATALOG_ENTRY_FIELDS,
  PRODUCT_DESIGN_SCHEMA,
  validateProductDesignPayload,
  summarizeProductDesign,
} from './handoff-product-design.js'
export { resolveHandoffSeat, buildHandoffRecord, summarizeHandoff, makeTaskId } from './handoff-record.js'
