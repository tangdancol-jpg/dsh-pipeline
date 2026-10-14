/**
 * dsh-pipeline · 交接物 · 字段表
 * ============================================================================
 * 从 `lib/handoff.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/handoff.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/handoff/schemas
 */

import { HUB_STATION_NAMES } from '../states.js'
import { F, HUMAN_REASON_KINDS, HUMAN_DECISION_KINDS, HUMAN_TIMEOUT_BEHAVIORS, HUMAN_URGENCIES } from './fields.js'

/**
 * 交接物 schema 表。
 *
 * `required` 里的字段缺一不可；`text` 类字段要求非空字符串。
 * `from` / `to` 声明方向 —— 这是「编写不能直接把产物交给审核」在数据层的表达。
 *
 * @type {Record<string, {zh:string, from:string[], to:string, fields:Record<string,object>, required:string[]}>}
 */
export const HANDOFF_SCHEMAS = {
  // --- 主 → 执行角色 -------------------------------------------------------
  dispatch: {
    zh: '派活单',
    from: ['main'],
    to: 'writer|tester|reviewer|orchestrator|architect|security|release|docs|performance|arbiter',
    fields: {
      task_id: F('string', '任务ID'),
      requirement: F('text', '原始需求'),
      acceptance: F('string[]', '验收标准'),
      constraints: F('string[]', '约束条件'),
      deliverable_format: F('text', '交付格式'),
      deadline: F('string', '截止要求'),
      roster_tier: F('string', '本次采用的档位'),
    },
    required: ['task_id', 'requirement', 'acceptance', 'constraints', 'deliverable_format', 'deadline'],
  },

  // --- ★需求分析（第 1 轮）------------------------------------------------
  //
  // ⚠️ 与 `orchestration` 的区别（本轮把这两个角色拆开了，别混）：
  //   · 本类型 = `orchestrator`（需求分析）回答「**这东西到底要做什么**」：
  //     任务卡、验收标准、边界条件、测试要点，外加一份**需求不清楚处清单**。
  //   · `orchestration` = `planner`（计划）回答「**这活怎么切、给谁、什么次序**」。
  //   拆分理由见 README / REPORT 本轮更正记录。
  requirement_analysis: {
    zh: '需求分析结论',
    from: ['orchestrator'],
    to: 'main|planner',
    fields: {
      task_id: F('string', '任务ID'),
      task_card: F('object', '任务卡（人话版：要做什么、不做什么）'),
      acceptance: F('string[]', '验收标准（可执行的、可判定的）'),
      test_points: F('string[]', '测试要点'),
      boundaries: F('string[]', '边界条件（没有就显式给空数组）', { allowEmpty: true }),
      /**
       * ★ 本轮的核心字段：**需求不清楚处清单**。
       *
       * 它是**必填**的，而且允许为空数组 —— "没有不清楚处"本身是一个必须
       * 显式回答的答案（与 known_issues / risk_notes 同一条设计）。
       * 这份清单会被完整带进 human_request（reason_kind=requirement_confirmation），
       * 由主对话转告用户确认。
       */
      unclear_points: F('string[]', '★ 需求不清楚处清单（没有就显式给空数组）', { allowEmpty: true }),
      analysis_reason: F('text', '分析依据：为什么这么理解这份需求、为什么这么定验收标准'),
      open_assumptions: F('string[]', '你替用户假设了什么（没有就给空数组；有假设时用户确认才有意义）', { allowEmpty: true }),
      /**
       * ★ 职责自限声明（设计目的第 3 条）：**我这次只做什么、不做什么**。
       *
       * 为什么它是必填而不是"最好写一下"：分析与计划这两个角色最容易"顺手多干" ——
       * 需求分析顺手把档位与角色清单定了（那是计划的活），
       * 计划顺手把实现方案也写了（那是编写的活）。
       * 把"我不做什么"写成**必填字段**之后，越界的产物就有了一个可机械检查的落点：
       * `will_not_do` 里写了"不分配 AI"，产物里却出现"派 writer#1" → 自相矛盾，拒。
       */
      role_scope: F('object', '★ 职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么'),
    },
    required: ['task_id', 'task_card', 'acceptance', 'test_points', 'boundaries', 'unclear_points', 'analysis_reason', 'role_scope'],
  },

  // --- ★计划（planner 的产出）--------------------------------------------
  //
  // 一条硬规矩：**自检没通过就不许分配 AI**。
  // 所以 `self_check.verdict=gaps` 时这份交接物会把状态推到「等待需求分析答复」
  // （退回需求分析），planner 在那之后**不能**再写角色清单（store 层拦）。
  plan: {
    zh: '开发计划（含自检）',
    from: ['planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      based_on_analysis: F('string', '依据哪份需求分析结论（requirement_analysis 的 handoff_id）'),
      plan_steps: F('string[]', '计划步骤（按顺序）'),
      // ⚠️ 允许空数组：**单席位**（count=1）时层清单退化成 ['all']，计划里本来就没有层要声明。
      //    多席位时必须给 —— 那一条由 buildWriters 执法（没给 layers 又 count>1 直接拒）。
      layers: F('object[]', '★ 层清单 [{layer, scope_paths[], deliverables[]}] —— 一个层一个编写席位（单席位可给空数组）', { allowEmpty: true }),
      self_check: F('object', '★ 自检结果 { verdict: "ok"|"gaps", checked: string[], gaps: string[] }'),
      // --- 自检发现缺失（verdict=gaps）时必填：回流要问的问题 ---
      gap_stage: F('string', '卡在哪一步（verdict=gaps 时必填）'),
      gap_question: F('text', '要问需求分析的问题（问句；verdict=gaps 时必填）'),
      gap_context: F('text', '★ 脱敏摘要（不许含代码；verdict=gaps 时必填）'),
      gap_urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      plan_reason: F('text', '为什么这么计划（可追溯）'),
      risks: F('string[]', '计划层面的风险（没有就给空数组）', { allowEmpty: true }),
      /**
       * ★ **授权改动面**（设计目的第 1 条：最小改动）。
       *
       * 「改动面必须与授权面相等」—— 多改一行也算越界。
       * 逐条 = 一处授权：`{ id, path, action, why }`
       *   · `id`     授权条目 id（编写在 `dev_to_test.change_manifest` 里要**逐条引用**它，
       *              于是"每一处改动都有一个授权来源"这件事变成可机械核对的）
       *   · `path`   允许动的文件（也可以是一个目录/前缀，守门按前缀判定）
       *   · `action` `modify` / `create` / `delete` —— **新增文件也算越界**，
       *              要新建就必须在这里显式授权（写 `create`）
       *   · `why`    为什么非动它不可（"顺手重构 / 统一风格 / 升级依赖"在这里写不出理由 ⇒ 没有授权）
       */
      change_scope: F('object[]', '★ 授权改动面 [{ id, path, action: modify|create|delete, why }] —— 编写只能在这个清单内动'),
      /**
       * ★ **越界清单**：这次**不许做什么**。
       *
       * 与 `change_scope`（允许什么）配对：一个是白名单，一个是明令禁止。
       * 用户点名的四条要在这里写死：不许顺手重构、不许改测试、不许扩范围、不许改依赖；
       * 另有 `role_scope.will_not_do`（**角色级**自限）与它互补 ——
       * 这里是**任务级**的禁令，派活时会一起交给 writer 与 reviewer。
       */
      forbidden: F('string[]', '★ 越界清单（这次**不许**做什么；至少 1 条。例如：不许顺手重构 / 不许改测试 / 不许扩范围 / 不许改依赖）'),
      /**
       * ★ 每个角色的**边界卡**：这个角色只干什么、不干什么。
       *
       * 派活时按它派（`pipeline_dispatch` 会把对应那条写进派活单），
       * 于是"别让谁顺手多干"这件事在**派活那一刻**就被写死，而不是靠事后追责。
       * 覆盖性由 store 在写角色清单时核对（必须覆盖 roster 里每一个执行角色）。
       */
      role_boundaries: F('object[]', '★ 每个角色的边界卡 [{ role, only: string[], not: string[] }] —— 必须覆盖清单里每一个执行角色'),
      /** ★ 职责自限声明（同 requirement_analysis）。 */
      role_scope: F('object', '★ 职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么'),
    },
    required: ['task_id', 'plan_steps', 'layers', 'self_check', 'plan_reason', 'change_scope', 'forbidden', 'role_boundaries', 'role_scope'],
  },

  // --- ★分配结论（角色清单）—— 本轮从 orchestrator 改归 planner -----------
  orchestration: {
    zh: '分配结论（角色清单）',
    from: ['planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      tier: F('enum', '档位', { values: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] }),
      ai_count: F('number', '需要几个独立对话'),
      roles: F('string[]', '角色清单'),
      sequence: F('string[]', '调用顺序'),
      reason: F('text', '判断理由（每次判断都要有理由记录）'),
      task_card: F('object', '任务卡'),
      acceptance: F('string[]', '验收标准'),
      test_points: F('string[]', '测试要点'),
      boundaries: F('string[]', '边界条件'),
      /** ★ 本轮新增：编写层清单（与 writers.partitions[].layer 同源）。 */
      layers: F('string[]', '★ 层清单（席位数 = 层数）'),
    },
    required: ['task_id', 'tier', 'ai_count', 'roles', 'sequence', 'reason', 'acceptance', 'test_points'],
  },

  // --- 编写 → 测试 ---------------------------------------------------------
  dev_to_test: {
    zh: '编写交付给测试',
    from: ['writer'],
    to: 'tester',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '制品版本号，例如 v1'),
      patch_or_code: F('text', '代码或补丁'),
      change_note: F('text', '变更说明'),
      run_commands: F('string[]', '运行命令'),
      selftest_result: F('text', '自测结果'),
      known_issues: F('string[]', '已知问题（可以为空数组 —— "没有已知问题"本身是一个必须显式回答的答案）', { allowEmpty: true }),
      acceptance_map: F('object', '验收标准 → 实现位置 的对照（可空对象）'),
      /** ★ 席位元数据：多席位分工时必填，单席位可省（省了按 writer#1 算）。 */
      partition: F('object', '分区元数据 { seat, index, total, layer, scope_paths }'),
      /**
       * ★ **实际改动面**（设计目的第 1 条：最小改动）。
       *
       * 「改动面必须与授权面相等」—— 这份清单是**实际动了什么**的账：
       * `{ path, action, scope_id, lines, note }`
       *   · `scope_id` 必须指向计划里 `change_scope` 的某一条 ⇒
       *     **每一处改动都有一个授权来源**，可机械核对；
       *   · 测试与审核按这个面核对（"只改了这三行"是可验证的声明，不是形容词）。
       *
       * ⚠️ 它在 schema 里是**可选**的，但当任务**有**授权改动面（即有计划）时，
       *    store 层会把它变成**必填**并逐条核对 —— 为什么不在 schema 里直接必填：
       *    L0 没有"计划"这一站（规则引擎自批），所以 L0 任务不存在授权面，
       *    那时它是弃权的（见 README「待确认项」P4）。
       */
      change_manifest: F('object[]', '★ 实际改动面 [{ path, action, scope_id, lines, note }] —— 有授权面时必填，且每条必须引用授权条目', { allowEmpty: true }),
    },
    required: ['task_id', 'artifact_version', 'patch_or_code', 'change_note', 'run_commands', 'selftest_result', 'known_issues'],
  },

  // --- ★编写完成之后：架构图（交付物之一）---------------------------------
  //
  // ⚠️ 与 `design` 的区别：`design` 是 `architect` 在**编写之前**给的文字方案；
  //    本类型是 `diagrammer` 在**编写之后**交的**图**，而且必须带着
  //    "我确实走过闸门"的回执。
  architecture_diagram: {
    zh: '架构图交付',
    from: ['diagrammer'],
    to: 'main|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      based_on_artifact_version: F('string', '这张图对应哪个制品版本'),
      diagram_path: F('text', '渲染出来的图（HTML）路径'),
      /** ★ 走没走过 diagram_deliver 的闸门 —— 决定要不要收据。 */
      produced_by: F('enum', '怎么产出的', { values: ['diagram_deliver', 'self-provided'] }),
      receipt_path: F('string', '交付收据路径（produced_by=diagram_deliver 时必填，且必须真实存在）'),
      receipt_id: F('string', '收据 id（可空）'),
      html_sha256: F('string', '产物 sha256（可空；给了就会与磁盘上的文件核对）'),
      covered_modules: F('string[]', '这张图覆盖了哪些模块'),
      degraded: F('boolean', '是否降级产出（没走 diagram_deliver）'),
      degraded_reason: F('text', '降级原因（degraded=true 时必填）'),
      notes: F('string[]', '说明（可空）'),
    },
    required: ['task_id', 'based_on_artifact_version', 'diagram_path', 'produced_by', 'covered_modules', 'degraded'],
  },

  // --- ★★主管枢纽（T-20261011-56a37e）：五道确认的留痕载体 ------------------
  //
  //   为什么是**一种**带 station 字段的交接物、而不是五种各一个类型：
  //   五道站点的**形态必须一致**（验收 5 的原话），而"形态一致"最省事的落地
  //   就是同一张 schema —— 判据只写一遍，站点之间的差异全部落在一个枚举字段上。
  //   反过来（五个类型）会让"单确认冒充双确认"有五个可以各写一遍的地方。
  //
  //   ★ 双确认的**形态**（照抄既有 `effectiveReviewOk` 的强度，安全预审 B1/准入判据）：
  //     ① 必须是**两份**交接物，`from` 分别落在 `confirmers` 里的不同角色上
  //        —— from_role 由**调用方令牌**决定（lib/tools.js → lib/handoff.js），
  //        payload **自述不算数**（否则一份记录里写两个布尔字段就能冒充双确认）；
  //     ② 两份都绑定**同一个 artifact_version**；
  //     ③ 都必须在**最近一次打回之后**（打回即作废）；
  //     ④ 缺任一份 ⇒ 目标状态不可达，拒绝原文指名还缺谁；
  //     ⑤ 第③道与第④道**不得复用同一份确认记录**（station 字段写死在哪一站）。
  station_confirm: {
    zh: '站点确认（主管枢纽的确认留痕：五道站点里那四道 + ②b/②c 两个交接确认点）',
    from: ['supervisor', 'orchestrator'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      /**
       * ★ 哪一道站点 —— 这一个字段把"这份确认属于哪一站"写死（跨站复用即被拒）。
       *
       * ★ P0-1：枚举 = **五道站点**（①②③④⑤）+ **②b / ②c 两个交接确认点**
       *   （用户新口径第 7~8 跳：需求位确认架构图 → 主管二次确认）。
       *   唯一出处 `states.js` 的 `HUB_STATION_NAMES`（派生自两张同形的确认方表）——
       *   手抄一份的下场就是"某一站的确认记录交不上来"（第⑤道刻意不在枚举里，正是这个道理）。
       */
      station: F('enum', '★ 站点', { values: [...HUB_STATION_NAMES] }),
      /** ★ 确认针对的制品版本（双确认必须**绑同一版本**；打回即作废）。 */
      artifact_version: F('string', '被确认的制品版本（架构图站为图的产物标识；需求站为需求结论的 handoff_id）'),
      decision: F('enum', '确认结论', { values: ['ok', 'ng'] }),
      /**
       * ★ **证据标识**（不是正文搬运）。
       *
       * 安全预审阻断项 B1 的原话：控制角色在两道确认里引用的材料必须带
       * 「**可查的证据标识**（哪份交接物 id + 制品版本 + 内容哈希 + 计数/结论字段），
       * 而不是正文搬运」。
       */
      basis_refs: F('string[]', '★ 依据的证据标识（交接物 id / 制品版本 / 内容哈希 / 计数或结论字段；**不许搬正文**）'),
      /** ★ 依据的类别：本单只允许"脱敏证据正文"这一类（用户口径⑤）。 */
      basis_kind: F('enum', '依据类别', { values: ['evidence_digest'] }),
      /**
       * ★ **脱敏后的证据正文**（用户口径⑤：需求位两次确认看脱敏后的证据正文，
       *   而「证据 ≠ 代码正文」）。
       *   它会被 handoff 层的**形态判据**扫一遍：出现代码形态即拒（见 hubDigestErrors）。
       */
      basis_digest: F('text', '★ 脱敏后的证据正文（结论 / 计数 / 路径 / 哈希；**不许含代码正文**）'),
      reason: F('text', '为什么这么确认（可追溯）'),
    },
    required: ['task_id', 'station', 'artifact_version', 'decision', 'basis_refs', 'basis_kind', 'basis_digest', 'reason'],
  },

  // --- ★计划位 → 测试位的「任务内容预登记」（测试提前知情）-------------------
  //
  //   用户原话：「测试ai**提前**收到计划ai安排任务内容」。
  //   ★ 三条边界写死在字段与判据上（用户口径③ + 越界清单第 15 条）：
  //     · 它是**内容提前交到测试位手里**（本类型就是那个载体），不是"提前打个招呼"；
  //     · **不许看编写的产物** —— 提交时机判据：必须**在 dev_to_test 之前**；
  //       payload 里出现编写产物字段（patch_or_code / change_manifest / selftest_result）
  //       或测试结论字段（TEST_VERDICT_FIELDS）一律拒；
  //     · **提前知情 ≠ 提前开工**：`not_yet_available` 必须显式列出"还没有的东西"，
  //       而测试位在 `dev_submitted` 之前的**一切测试行动**由守门层拦（见 lib/guard.js）。
  prebrief: {
    zh: '任务内容预登记（计划位 → 测试位）',
    from: ['planner'],
    to: 'tester',
    fields: {
      task_id: F('string', '任务ID'),
      plan_handoff_id: F('string', '★ 这份预登记依据的计划交接物 id（可查）'),
      assigned_scope: F('string[]', '★ 计划位安排给测试的任务内容（要测什么、按哪几条验收）'),
      acceptance_refs: F('string[]', '对应的验收标准条目（引用需求档/计划里的序号或原文要点）'),
      artifact_under_test: F('string', '将要被测试的制品标识（版本号**在编写交付之前**还只是占位）'),
      /** ★ "还没有的东西"必须显式回答（同 known_issues 的设计：空集也是一个答案）。 */
      not_yet_available: F('string[]', '★ 现在还拿不到的东西（**编写产物必须在列**；显式回答，不许省）'),
      must_not_start_before: F('enum', '★ 开工闸：到哪个事件之后才允许开跑', { values: ['dev_submitted'] }),
      notes: F('string[]', '说明（可空）', { allowEmpty: true }),
    },
    required: ['task_id', 'plan_handoff_id', 'assigned_scope', 'acceptance_refs', 'artifact_under_test', 'not_yet_available', 'must_not_start_before'],
  },

  // --- ★主管 → 架构位：架构图重画指令（限 1 次）-----------------------------
  diagram_rework: {
    zh: '架构图重画指令（主管 → 架构位）',
    from: ['supervisor'],
    to: 'diagrammer',
    fields: {
      task_id: F('string', '任务ID'),
      reason: F('text', '★ 哪里不满足要求（可追溯；重画要照着它改）'),
      round: F('number', '第几次重画（**限 1 次**，即 round 只能是 1）'),
      escalate_after: F('boolean', '用尽预算后是否升级人工（用户口径④：是）'),
    },
    required: ['task_id', 'reason', 'round', 'escalate_after'],
  },

  // --- 测试 → 审核 ---------------------------------------------------------
  test_to_review: {
    zh: '测试报告交审核',
    from: ['tester'],
    to: 'reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被测试的制品版本（必须与编写交付一致）'),
      test_cases: F('string[]', '测试用例'),
      execution_result: F('text', '执行结果'),
      failure_logs: F('string[]', '失败日志（通过时可以为空数组）', { allowEmpty: true }),
      pass_evidence: F('string[]', '通过证据'),
      risk_notes: F('string[]', '风险说明（没有风险时显式给空数组）', { allowEmpty: true }),
      verdict: F('enum', '测试结论', { values: ['pass', 'fail'] }),
    },
    required: ['task_id', 'artifact_version', 'test_cases', 'execution_result', 'failure_logs', 'pass_evidence', 'risk_notes', 'verdict'],
  },

  // --- 审核 → 主对话 / 用户 ------------------------------------------------
  review_verdict: {
    zh: '审核结论',
    from: ['reviewer'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被审核的制品版本（必须与测试报告一致）'),
      conclusion: F('enum', '审核结论', { values: ['OK', 'NG'] }),
      risk_notes: F('string[]', '风险说明（没有风险时显式给空数组）', { allowEmpty: true }),
      /**
       * ★ 安全确认（**必填**）。「审核必须确认网络安全/本地泄密是否发生」的落点。
       *   shape:
       *     {
       *       network:    { checked, applicable, reason?, evidence[], checks_ref[] },
       *       local_leak: { checked, evidence[], checks_ref[] },
       *       attestation: 'clean' | 'issues' | 'unknown',
       *       checked_by:  <role>,
       *       checks_ref:  [<检查工具的产物路径或 sha256>],
       *       findings:    [{ location, type, why, resolved }]
       *     }
       */
      security: F('object', '★ 安全确认（网络面 + 本地泄密面，含 attestation 与依据）'),
      release_approved: F('boolean', '是否放行'),
      final_delivery_note: F('text', '最终交付说明'),
      acceptance_check: F('object', '逐条验收标准的核对结果'),
      /**
       * ★ **前后版本对比结论**（用户原话：「审核 ai 确认没有干不该干的事（前后版本对比）」）。
       *
       * 审核不是靠"我看了一遍"，而是拿**改动基线**（派活那一刻记录的文件清单 + 哈希）
       * 与当前状态逐文件对比，产出对照结论。三种都要报出来：
       *   · **多改**：清单外的文件被改 / 被新增
       *   · **少改**：授权了却没动
       *   · **改错地方**：动的是别处
       *
       * shape：`{ baseline_id, verdict: 'within_scope'|'out_of_scope', added[], modified[],
       *          removed[], unauthorized[], missing[], note? }`
       *
       * ⚠️ **必填条件**：任务**有基线**时必填（`store` 层判）。
       *    它与 `pipeline_change_audit` 工具算出来的结果**必须一致** ——
       *    store 会自己再算一遍并核对 `baseline_id` 与 `verdict`，对不上就拒。
       *    完整的对照明细（added/modified/…）可以由工具产出后原样贴进来。
       */
      change_audit: F('object', '★ 前后版本对比结论 { baseline_id, verdict: within_scope|out_of_scope, added[], modified[], removed[], unauthorized[], missing[] }'),
      reject_to: F('enum', '不通过时打回给谁', { values: ['writer', 'tester', 'none'] }),
      reject_reason: F('text', '不通过原因（NG 时必填）'),
    },
    required: ['task_id', 'artifact_version', 'conclusion', 'risk_notes', 'release_approved', 'final_delivery_note', 'security'],
  },

  // --- 打回 ---------------------------------------------------------------
  test_to_dev: {
    zh: '测试打回编写',
    from: ['tester'],
    to: 'writer',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被驳回的制品版本'),
      failed_cases: F('string[]', '失败的用例'),
      failure_logs: F('string[]', '失败日志'),
      expected: F('text', '期望行为 / 修复要求'),
    },
    required: ['task_id', 'artifact_version', 'failed_cases', 'failure_logs', 'expected'],
  },

  // --- 咨询角色（L2+ 按需）-------------------------------------------------
  design: {
    zh: '架构/技术方案',
    from: ['architect'],
    to: 'writer|main',
    fields: {
      task_id: F('string', '任务ID'),
      modules: F('string[]', '模块划分'),
      contracts: F('string[]', '接口契约'),
      decisions: F('string[]', '技术决策'),
      risks: F('string[]', '风险'),
    },
    required: ['task_id', 'modules', 'decisions'],
  },
  security_review: {
    zh: '安全/合规审计',
    from: ['security'],
    to: 'main|writer|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      findings: F('string[]', '发现项'),
      severity: F('enum', '最高严重级别', { values: ['none', 'low', 'medium', 'high', 'critical'] }),
      blocked: F('boolean', '是否存在阻断项'),
      remediation: F('string[]', '整改要求'),
    },
    required: ['task_id', 'findings', 'severity', 'blocked'],
  },
  release_plan: {
    zh: '发布/运维计划',
    from: ['release'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      steps: F('string[]', '上线步骤'),
      rollback: F('text', '回滚方案'),
      monitoring: F('string[]', '监控与告警'),
      window: F('string', '发布窗口'),
    },
    required: ['task_id', 'steps', 'rollback'],
  },
  docs_note: {
    zh: '文档产物',
    from: ['docs'],
    to: 'main',
    fields: { task_id: F('string', '任务ID'), files: F('string[]', '文档文件'), summary: F('text', '摘要') },
    required: ['task_id', 'summary'],
  },
  perf_report: {
    zh: '性能/压测报告',
    from: ['performance'],
    to: 'main|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      baseline: F('text', '基线'),
      measured: F('text', '实测'),
      regression: F('boolean', '是否有性能回归'),
      notes: F('string[]', '说明'),
    },
    required: ['task_id', 'baseline', 'measured', 'regression'],
  },
  arbitration: {
    zh: '仲裁裁定',
    from: ['arbiter'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      dispute: F('text', '争议点'),
      ruling: F('text', '裁定'),
      binding: F('boolean', '是否具约束力'),
    },
    required: ['task_id', 'dispute', 'ruling', 'binding'],
  },
  human_note: {
    zh: '人工干预记录',
    from: ['human'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      action: F('enum', '人工动作', { values: ['block', 'unblock', 'cancel', 'approve_override', 'rollback', 'note'] }),
      note: F('text', '说明'),
    },
    required: ['task_id', 'action', 'note'],
  },

  // --- ★席位继任的交接物（"换班"，不是"改角色"）----------------------------
  //
  // 为什么必须有它：继任的全部意义就是"新来的不用从零开始"。
  // 所以 must_read_files（至少含需求档）与 open_questions 是**硬要求**。
  seat_handover: {
    zh: '席位交接（换班）',
    from: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'orchestrator', 'planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      from_seat: F('string', '旧席位（roster 席位 id 或角色）'),
      to_seat: F('string', '新席位'),
      reason: F('text', '★ 为什么换班（水位 + 依据）'),
      context_percent: F('number', '上报时的水位百分比'),
      progress_done: F('string[]', '已经做完的'),
      progress_todo: F('string[]', '还没做的'),
      must_read_files: F('string[]', '★ 必读文件清单（**至少含需求档**）'),
      key_decisions: F('string[]', '关键决定（决定 + 理由）'),
      open_questions: F('string[]', '★ 悬而未决的问题（没有就写空数组，必须显式给）', { allowEmpty: true }),
      next_step: F('text', '接手后的第一步做什么'),
      do_not_repeat: F('string[]', '★ 不要重复做的事（走过的弯路）'),
      pending_requests: F('object[]', '★ **编排专有**：待处理的请求队列 [{from, about, waiting_since}] —— 谁在等答复（没有就写空数组）', { allowEmpty: true }),
    },
    required: ['task_id', 'from_seat', 'to_seat', 'reason', 'progress_done', 'progress_todo', 'must_read_files', 'key_decisions', 'open_questions', 'next_step', 'do_not_repeat'],
  },

  // --- ★两级升级梯 · 第一级：角色 → 需求分析/编排判断 ---------------------
  //
  // 执行/顾问角色遇到确定不了的事，**先问需求分析**，不要一步就去找用户。
  // 需求分析能在需求层裁定（验收标准、边界条件、优先级、范围取舍、测试要点）就自己答；
  // 答不了才升级成 human_request。理由见 README「人工介入（两级升级梯）」。
  clarification_request: {
    zh: '请求需求分析裁定',
    // ★ planner 也在册：它的「计划自检发现缺失」就是退回需求分析。
    from: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner'],
    to: 'orchestrator',
    fields: {
      task_id: F('string', '任务ID'),
      from_role: F('enum', '发起角色（必须与调用方一致）', {
        values: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner'],
      }),
      stage: F('string', '卡在哪一步（例如"编写：接口字段命名"）'),
      question: F('text', '要问的问题 —— 必须是个**清晰可答**的问句'),
      context_digest: F('text', '★ 脱敏摘要（**不许含代码正文**）—— 让需求分析不读代码也能判断'),
      options: F('object[]', '你想到的可选方案（每项 {label, consequence}，可空）'),
      blocking: F('boolean', '是否阻塞本任务推进'),
      urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      deadline: F('string', '希望什么时候答复（ISO 8601，可空）'),
    },
    required: ['task_id', 'from_role', 'stage', 'question', 'context_digest', 'blocking', 'urgency'],
  },

  // --- ★两级升级梯 · 第一级的回复：需求分析 → 发起角色 ---------------------
  clarification_reply: {
    zh: '需求分析裁定',
    from: ['orchestrator'],
    to: '*',
    fields: {
      task_id: F('string', '任务ID'),
      answer_to: F('string', '回给哪条请求（clarification_request 的 handoff_id 或 request_id）'),
      verdict: F('enum', '裁定结果', { values: ['answered', 'cannot_answer'] }),
      answer: F('text', '★ 结论（verdict=answered 时必填）'),
      reason: F('text', '★ 为什么这么答 / 为什么答不了（**必填**，可追溯）'),
      constraints_added: F('string[]', '因这次裁定而新增/收紧的约束（可空数组）'),
      escalate: F('boolean', '是否已/准备升级给人工（verdict=cannot_answer 时通常为 true）'),
    },
    required: ['task_id', 'answer_to', 'verdict', 'reason'],
  },

  // --- ★全量测试审批链（第 1 站）：测试 → 需求分析 --------------------------
  //
  // 用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
  // 必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
  // 确认人工通过后再提交给计划 ai 安排」。
  //
  // ★ 与**澄清梯**（clarification_request/reply）**问的不是同一个问题**：
  //   · 澄清梯问的是「**需求本身不清楚**」—— 答案在需求层，答完就能继续干活；
  //   · 这条链问的是「**这件事值不值得做**」—— 它不改需求、不改计划范围，
  //     只是给"要不要跑一整套测试"这个**成本决策**盖章。
  //   两者的形状一样（提出 → 逐级裁定 → 顶到人工），所以**合流**在同一个两级梯机制上：
  //   升级到人工那一级用的就是既有的 `human_request` / `human_reply`，不另起一套。
  full_test_request: {
    zh: '全量测试申请',
    from: ['tester'],
    to: 'orchestrator',
    fields: {
      task_id: F('string', '任务ID'),
      /** 本次**改动面**（授权面 / 实际改动清单）——定向测试就是按它挑用例的。 */
      affected_paths: F('string[]', '★ 本次改动面（改动清单里的路径）—— 定向测试按它挑用例'),
      /** 已经跑过的定向测试（先证明"定向不够"，这是提全量的前提）。 */
      targeted_already_run: F('string[]', '★ 已经跑过的定向/增量测试（命令 + 结论）—— 先证明定向不够'),
      /** ④ 为什么定向不够（对应 Stop Ladder 第四问：没它会失败吗？）。 */
      why_targeted_insufficient: F('text', '★ **为什么定向测试不够** —— 不做全量的话，会在哪一步失败？（答不上来就别申请）'),
      /** 打算怎么跑（范围 + 命令），审批链就是批这个。 */
      what_will_run: F('text', '★ 打算跑什么（**具体的全量命令 / 范围**）—— 审批批的就是它'),
      estimated_cost: F('string', '预计耗时/资源（可空，但审批人会想看）'),
      risk_if_not_run: F('text', '不跑的话风险是什么（可空）'),
    },
    required: ['task_id', 'affected_paths', 'targeted_already_run', 'why_targeted_insufficient', 'what_will_run'],
  },

  // --- ★全量测试审批链（第 2~4 站）：三站裁定 ------------------------------
  //
  // 一站一份，`stage` 区分；**必须按 need → worth → arrange 的顺序**（顺序由 store 判，
  // 不是靠自觉）。任一站 `ok=false` 就是**否决**，链当场停住并留痕。
  full_test_review: {
    zh: '全量测试裁定',
    from: ['orchestrator', 'reviewer', 'planner'],
    to: '*',
    fields: {
      task_id: F('string', '任务ID'),
      /** 回给哪条申请（full_test_request 的 handoff_id 或 request_id）。 */
      request_id: F('string', '★ 回给哪条 full_test_request'),
      stage: F('enum', '★ 这是哪一站（必须与你的角色匹配：需求分析=need / 审核=worth / 计划=arrange）', {
        values: ['need', 'worth', 'arrange'],
      }),
      ok: F('boolean', '★ 同意还是否决 —— 否决也要交这一份（留痕），理由是必填'),
      reason: F('text', '★ 判断理由（**同意与否决都必须写**）'),
      /** 只有 need 站该填：这次到底需不需要全量。 */
      necessity: F('text', 'need 站：这次为什么**需要/不需要**全量（可空）'),
      /** 只有 worth 站该填：值不值得（成本 vs 风险）。 */
      worth_it: F('text', 'worth 站：值不值得跑（成本 vs 风险，可空）'),
      /** 只有 arrange 站该填：怎么跑（派谁 / 范围 / 命令）—— 会变成放行凭据的内容。 */
      scope: F('string', 'arrange 站：跑的范围（例如"全部用例" / "除 e2e 外"）'),
      command: F('string', 'arrange 站：**最终批准的全量命令**（放行时按它比对，避免"批一条跑另一条"）'),
      notes: F('text', 'arrange 站：其它安排（派谁跑、注意什么）'),
    },
    required: ['task_id', 'request_id', 'stage', 'ok', 'reason'],
  },

  // --- ★人工介入请求（执行/顾问角色 → 主对话 → 用户）----------------------  //
  // 拓扑上这是**唯一**的上升通道：用户只与主对话相连，执行角色根本没有
  // 用户的对话框。所以"我这边卡住了，要人拍板"必须先变成一份结构化请求
  // 交给主对话，由主对话**转告**。`question_for_human` 强制是**给人看的人话**
  // 且**不许含代码** —— 因为主对话不读代码，含代码的请求它转告不了。
  human_request: {
    zh: '人工介入请求',
    from: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      from_role: F('enum', '发起角色（必须与调用方一致）', {
        values: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human'],
      }),
      created_at: F('string', '发起时间（ISO 8601；留空则由插件按服务器时间补上）'),
      reason_kind: F('enum', '为什么要人拍板', { values: Object.keys(HUMAN_REASON_KINDS) }),
      question_for_human: F('text', '★ 给用户看的人话问题（不含代码、不含补丁、必须是个问句）'),
      context_for_human: F('text', '给用户的补充背景（同样不许含代码，可空）'),
      options: F('object[]', '可选方案（每项 {label, consequence}，可空）'),
      recommended: F('string', '你的建议（必须是 options 里某个 label；仅供参考，不构成决定）'),
      blocking: F('boolean', '是否阻塞本任务推进'),
      blocked_stage: F('string', '卡在哪一步（blocking=true 时必填）'),
      urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      decision_kind: F('enum', '需要用户给什么形式的答复', { values: Object.keys(HUMAN_DECISION_KINDS) }),
      timeout_behavior: F('enum', '无人回应时怎么办', { values: Object.keys(HUMAN_TIMEOUT_BEHAVIORS) }),
      // --- ★两级升级梯：由需求分析升级上来时必填 ---
      escalated_from: F('string', '从哪条 clarification_request 升上来的（handoff_id）'),
      raised_by: F('string', '原本是谁问的（上游请求的发起角色）'),
      orchestrator_reason: F('text', '需求分析为什么答不了（用户有权知道为什么这事轮到他拍板）'),
      default_option: F('string', '默认选项（timeout_behavior=proceed_with_default 时必填）'),
    },
    required: [
      'task_id',
      'from_role',
      'reason_kind',
      'question_for_human',
      'blocking',
      'urgency',
      'decision_kind',
      'timeout_behavior',
    ],
  },
}
