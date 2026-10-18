/**
 * dsh-pipeline · 角色分档与计划分配
 * ============================================================================
 * 「要调用几个 AI、调用谁、按什么顺序」是**独立计划判断**的产物（`planner`），
 * 不是主对话的心情。本模块把 L0~L5 规则做成可调用逻辑，并提供一个**确定性规则引擎**
 * 先给建议档位 —— 主对话只能调用它，不能覆盖它。
 *
 * ★ 本轮把「需求分析」与「计划分配」拆成两个角色（原先挤在一个"编排判断"里）：
 *   本模块服务的是**计划分配**那一半 —— 档位、角色清单、编写席位与层分工。
 *   需求分析那一半在 `lib/tools.js` 的 `pipeline_orchestrate`（产出任务卡 +
 *   不清楚处清单），它**不产生角色清单**。
 *
 * ---------------------------------------------------------------------------
 * ★ 一条规格歧义的显式处理（写在这里，因为它是本模块最重要的设计取舍）
 * ---------------------------------------------------------------------------
 * 需求原文里两句话互相拉扯：
 *   · "最少 4 个独立对话：主对话、编写、测试、审核"
 *   · "推荐起步 5 个：在四角色外增加「需求分析/编排判断对话」"（本轮已拆成两个角色）
 *   · 分档表："L0 极简脚本=4（主/编写/测试/审核）"
 *
 * 于是 L0 到底有没有独立编排对话？本插件的取舍（可在配置里翻回来）：
 *
 *   L0 的「需求分析 + 计划分配」**依然发生**，但执行者不是另一个 AI 会话，而是本模块的
 *   **确定性规则引擎**。这就是 `orchestrator: 'rule-engine'`。
 *
 *   为什么这不是"主对话自己判断"：主对话只能**调用**引擎，既不能改引擎的
 *   结论，也不能手写角色清单。引擎要输出 L0，需求必须先通过一组**保守的
 *   平凡性判据**（单文件、无外部依赖、无安全面、无并发、无持久化……）。
 *   任何一项不满足，引擎直接拒绝自批 L0，强制升到 L1 —— 也就是"复杂需求
 *   不漏配"。反过来，引擎判 L0 时主对话也没法把它抬到 L4 —— 也就是
 *   "简单需求不超配"。
 *
 *   L1 及以上，计划分配必须由**独立的计划对话**完成（`orchestrator: 'separate'`），
 *   且它必须给出 tier + reason，引擎的建议只作参考。
 *
 * 这个取舍已经列进 README 的「待确认项」，一句话就能翻：
 * 配置 `l0Orchestrator: 'separate'` 就让 L0 也变成 5 个对话。
 *
 * @module dsh-pipeline/lib/tiers
 */

export {
  TIERS,
  TIER_ORDER,
  L5_EXTENSION_POOL,
  tierAtLeast,
  maxTier,
} from './tiers/constants.js'

export { proposeTier } from './tiers/propose.js'

export {
  buildRoster,
  recommendWriters,
  recommendLayers,
  buildWriters,
  seatOwningPath,
} from './tiers/roster.js'

export {
  compareDispatchSlots,
  checkDispatchQuota,
  validateDispatchSequence,
  validateRoster,
} from './tiers/validate.js'

export {
  ROSTER_SLOT_KEYS,
  ROSTER_PERMISSION_TIERS,
  ROSTER_MIN_PERMISSION,
  ROSTER_FULL_PERMISSION,
  ROSTER_DEFAULT_MODE,
  ROSTER_ENV_DEFAULT,
  slotKeyOf,
  slotRoleNeedsDeclaration,
  normalizeRosterSlots,
  rosterSlotTargets,
  rosterSlotKeys,
  rosterSlotDeclarations,
  buildRosterSlots,
} from './tiers/roster-slots.js'

export {
  DISPATCH_OPEN_AUDIT_FIELDS,
  DISPATCH_OPEN_ACTION,
  dispatchOpenRecord,
} from './tiers/dispatch-open.js'

export {
  roleModePlan,
} from './tiers/roster-mode.js'

// ★★ P1-18（设计档 `04-demo与制品模型.md` §4「推荐 A」）：**按档位的必需产物矩阵**
//   与 `deferred_artifacts` 豁免判据。**单一出处**：计划工具、关单闸、状态展示都从
//   这里取，别处不许再手抄一份矩阵（抄一份必然与档位表漂移）。
export {
  PRODUCT_KINDS,
  PRODUCT_ORDER,
  EXEMPTIBLE_PRODUCT_KINDS,
  NON_EXEMPTIBLE_PRODUCT_KINDS,
  LEGACY_ROLE_PRODUCT_KINDS,
  TIER_PRODUCT_REQUIREMENTS,
  normalizeTier,
  productSpecOf,
  requiredProductsOf,
  deferrableProductsOf,
  isDeferrableProduct,
  nonExemptibleProductsOf,
  productKindsText,
  deferralLine,
  validateDeferredArtifacts,
  deferredArtifactsOf,
  isProductDeferred,
  productStatusFor,
} from './tiers/product-matrix.js'
