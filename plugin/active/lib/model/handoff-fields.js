// 交接物字段 · 字段类型 DSL 与人工介入枚举：schema 表里 `F(...)` 的类型标记，以及人工介入请求那几个枚举的取值。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/handoff/fields.js` 原样搬来（**只改了 import 路径与说明文字，行为未改**）。
 * 对外仍经原模块转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 *
 * @module dsh-pipeline/lib/model/handoff-fields
 */

/** 字段类型 DSL：'string' | 'text' | 'string[]' | 'object[]' | 'number' | 'boolean' | 'object' | 'enum'。 */
export const F = (type, zh, opts = {}) => ({ type, zh, ...opts })

/**
 * ★ 「人工介入请求」里允许出现的枚举值。
 * 这些取值不是装饰 —— `reason_kind` 决定了主对话怎么转告、以及用户在界面上看到什么。
 */
export const HUMAN_REASON_KINDS = {
  rework_budget_exhausted: '打回次数用尽（编写与测试/审核来回拉锯，机制已不许再打回）',
  conclusion_conflict: '编写与测试/审核结论冲突（谁对谁错，角色之间定不了）',
  approval_needed: '需要人审批（上线放行、破坏性操作、动生产数据等）',
  environment_missing: '环境或权限缺失（缺凭证、缺测试环境、缺访问权）',
  security_veto: '安全否决（安全审计发现阻断项，需要人拍板是否接受风险）',
  requirement_ambiguous: '需求本身有歧义（不同理解会做出不同的东西，必须先定死）',
  /**
   * ★ 本轮新增：**需求确认**（澄清前置到人工那一步用的就是它）。
   *
   * 与 `requirement_ambiguous` 的区别要写清，否则以后必然混：
   *   · `requirement_ambiguous`   = 需求分析自己**发现**有歧义，问用户"这处按哪个理解"；
   *   · `requirement_confirmation`= 需求分析已经出完结论（含"没有不清楚处"这种结论），
   *     请用户**确认这份分析**，然后才允许进计划。
   * 两者都可能由需求分析发起，但后者是**固定动作**（每次都要走），前者是按需的。
   */
  requirement_confirmation: '需求确认（需求分析已出结论，请用户确认后才能进计划）',
  scope_change: '范围变更（发现要做的事超出了原任务卡）',
  /**
   * ★ 本轮新增：**全量测试审批**（测试要跑整套测试，需求分析与审核都认为需要，请人拍板）。
   *
   * 与 `approval_needed` 的区别（不写清必然混）：
   *   · `approval_needed`   = 泛化的"需要人放行"（上线、破坏性操作、动生产数据）；
   *   · `full_test_approval`= 专门为「**跑一整套测试太贵、值不值得**」这一个成本决策。
   * 它固定出现在全量测试审批链的**第三站**（前两站是需求分析与审核的裁定）。
   */
  full_test_approval: '全量测试审批（跑整套测试成本高，前两站已同意，请人拍板）',
  /**
   * ★ 本轮新增：**哈希闸门连续不通过**（机制自动交人工，P13 的结论）。
   *
   * 与 `rework_budget_exhausted` 的区别要写清（不写清以后必然混）：
   *   · `rework_budget_exhausted` = **打回**次数用尽（审核/测试已经把产物打回过 N 次，
   *      任务真的来回拉锯过）；那是"角色"拉锯出来的。
   *   · `hash_gate_escalation`    = 提交**根本没成立**（哈希对比没过，任务从没离开
   *      "开发中"，连测试都没进），同一个任务**连续** N 次交上来的东西都没过这道闸。
   *
   * ⚠️ 这一条**不是角色能自己发的**：`pipeline_handoff` 走这条路会被拒
   *    （`HASH_GATE_ESCALATION_IS_SYSTEM`）—— 它只由机制在阈值到达时发出，
   *    并记进 `task.hash_gate_escalation` 与审计 `gate:hash_escalate`。
   */
  hash_gate_escalation: '哈希前置闸门连续不通过（同一任务连续 N 次提交都没过这道闸，机制自动交人工）',
  /**
   * ★ P1-7 遗留缺口（2026-10-19）：**DEMO 审阅请求的生产通道**。
   *
   * 现场：`pipeline_demo round`（main）要求本轮挂一条"本轮创建 + 已 answered + 未消费"的
   * 人工请求，但工具自己不创建它；而执行角色直接发 `pipeline_human_request` 会被**两级梯
   * 跳级闸**拦（roster 有独立 orchestrator 时不许跳级）⇒ 生产链根本跑不通，只有测试夹具
   * 手工注入。修法：由 `pipeline_demo round` 定稿时**自己登记**一条 `demo_review` 请求
   * （紧接着走既有 relay → reply → confirm），所以这个取值归机制使用。
   *
   * 与 `approval_needed` 的区别：后者是泛化的"需要人放行"；这一条**专指 DEMO 轮次审阅**，
   * 审阅对象是"第几轮 DEMO"（答复形状是 approve_reject）。
   */
  demo_review: 'DEMO 审阅（这一轮 DEMO 已可操作，请用户确认或要求改；由 pipeline_demo round 自动发起）',
  other: '其它（必须在 question_for_human 里说清楚）',
}

/** 需要用户给什么形式的答复。 */
export const HUMAN_DECISION_KINDS = {
  yes_no: '是 / 否',
  approve_reject: '批准 / 驳回',
  choose_option: '从给定方案里选一个',
  free_text: '给一段说明',
}

/** 没人回应时怎么办。 */
export const HUMAN_TIMEOUT_BEHAVIORS = {
  stay_blocked: '一直保持等待（不自动推进）',
  proceed_with_default: '按默认选项继续（必须在请求里写清默认选项是什么）',
  cancel: '取消任务',
}

/** 紧急度。 */
export const HUMAN_URGENCIES = ['low', 'normal', 'high', 'blocking']
