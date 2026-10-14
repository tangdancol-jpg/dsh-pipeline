/**
 * dsh-pipeline · 结构化交接物（schema + 校验）
 * ============================================================================
 * 每个交接环节都必须交一份**固定字段**的记录。字段名固定是有原因的：
 * 下游角色与守门判据都要按字段名读，一旦允许"自由发挥"，越权与跳步就没法
 * 机械判定，整条流水线就退回成"靠自觉"。
 *
 * 四份核心交接物（需求原文的固定字段，一个不多一个不少）：
 *   · dispatch        主 → 编写/测试   任务ID、原始需求、验收标准、约束条件、交付格式、截止要求
 *   · dev_to_test     编写 → 测试      代码或补丁、变更说明、运行命令、自测结果、已知问题
 *   · test_to_review  测试 → 审核      测试用例、执行结果、失败日志、通过证据、风险说明
 *   · review_verdict  审核 → 主/用户   审核结论(OK/NG)、风险说明、是否放行、最终交付说明
 *
 * ★ 本轮新增两份「控制角色」的交接物（把需求分析与计划拆开之后各自要交的东西）：
 *   · requirement_analysis  需求分析 → 主/计划  任务卡、验收标准、边界、测试要点、**不清楚处清单**
 *   · plan                  计划 → 主         计划步骤、层清单、**自检结果**、（有缺失时）回流问题
 *
 * 其余 kind 是打回、分配、咨询角色（架构/安全/发布/文档/性能/仲裁）用的补充类型。
 *
 * @module dsh-pipeline/lib/handoff
 */

// ---------------------------------------------------------------------------
// 文件布局：本文件只做转出，实现按主题拆在 `lib/handoff/` 下（对外导出名与拆分前逐一相同）
//   handoff/fields.js    人工介入字段枚举、授权面 / 角色边界的字段校验
//   handoff/scans.js     内容扫描（控制角色夹带代码、需求分析越位分配）、站点确认与预 brief
//   handoff/schemas.js   各类交接物的字段表 HANDOFF_SCHEMAS
//   handoff/validate.js  交接物校验 validateHandoff
//   handoff/record.js    交接记录、席位归属、摘要、任务 id
// ---------------------------------------------------------------------------

export {
  HUMAN_REASON_KINDS,
  HUMAN_DECISION_KINDS,
  HUMAN_TIMEOUT_BEHAVIORS,
  HUMAN_URGENCIES,
  detectCodeInHumanText,
  looksLikeQuestion,
  CHANGE_ACTIONS,
  SCOPE_ID_PATTERN,
  allowedActionsForEntry,
  validateRoleScope,
  validateChangeScope,
  validateRoleBoundaries,
  checkManifestAgainstScope,
} from './handoff/fields.js'

export {
  scanRequirementAnalysisForAllocation,
  CONTROL_ROLES_NO_CODE,
  TEST_VERDICT_FIELDS,
  scanControlRoleProductForCode,
  hubEvidenceDigestHit,
  PREBRIEF_FORBIDDEN_FIELDS,
  validateStationConfirm,
  validatePrebrief,
} from './handoff/scans.js'

export {
  HANDOFF_SCHEMAS,
} from './handoff/schemas.js'

export {
  validateHandoff,
} from './handoff/validate.js'

export {
  resolveHandoffSeat,
  buildHandoffRecord,
  summarizeHandoff,
  makeTaskId,
} from './handoff/record.js'
