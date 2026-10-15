/**
 * dsh-pipeline · 角色定义
 * ============================================================================
 * 「谁能做什么」唯一的事实来源。工具层、状态机、守门判据全部从这里读，
 * 不允许别处再写一份 —— 那正是"规则漂移"的来源。
 *
 * ★ 三权分立的核心不变量（INVARIANTS）在这里被编码成数据，而不是散文：
 *   · 编写不提交审核   → writer 无权产出 `review_verdict`，也无权把状态推到 `ready_review`
 *   · 测试不改代码     → tester 的写权限被限制在 reports/ 下
 *   · 审核不改代码     → reviewer 同上，且审核只核对测试报告与验收标准
 *   · 主对话不干活     → main 无权产出任何技术交接物，也不能自己写角色清单
 *
 * ★★ 本项目的**第一性目标**（用户原话）：
 *   「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
 *     编程别跑测试，编排别看代码」
 *
 *   也就是说：这份角色表不只是"分工表"，它是**防过度工程化的机制**。
 *   过工程化在实践里长这样：写实现的人顺手把测试也写了（于是测试证明的是他自己）、
 *   做需求与计划的人读了实现（于是开始定字段名、选算法库、加抽象层）。
 *   所以这里的边界一律按「**只给该给的能力**」编码：
 *     · writer 的 `handoffKinds` 里**没有**测试类产物，测试类命令也被守门拦（见 lib/guard.js）
 *     · `orchestrator` / `planner` 的产物里**不许有代码正文**，且**读**源码会被守门拦
 *   方向永远是**白名单**：忘了加 = 少一条能力（会被明确拒绝）；
 *   忘了删 = 悄悄多一条能力（不可接受）。
 *
 * @module dsh-pipeline/lib/roles
 */

/** 角色 id（贯穿全流程的稳定标识）。 */
export const ROLE = {
  MAIN: 'main',
  /**
   * ★「需求分析」。
   *
   * ⚠️ 这个角色**曾经**叫「需求分析/编排判断」，本轮被拆开了（见下面的 `PLANNER`）：
   *   · `orchestrator` = **只做需求分析**：第 1 轮分析 → 任务卡 / 验收标准 /
   *     边界条件 / 测试要点 + **「需求不清楚处」清单**。它**不再分配 AI**。
   *   · `planner`      = **计划 AI**：接用户确认过的需求 → 出计划 → 自检计划有无缺失
   *     → 无缺失才**分配 AI**（角色清单 / 用几个 / 派谁 / 什么顺序）。
   *
   * 为什么非拆不可（用户拍板）：这两件事的回答方式根本不同 ——
   *   · 需求分析回答的是「**这东西到底要做什么**」（语义问题，答错了后面全错）
   *   · 计划分配回答的是「**这活怎么切、给谁、按什么次序**」（结构问题）
   * 挤在一个角色里时，"计划缺失"只能回头问自己 —— 那等于自问自答。
   * 拆开之后，计划缺失有了一条**真实的**回流边：planner → orchestrator（见 states.js）。
   */
  ORCHESTRATOR: 'orchestrator',
  /** ★「计划 AI」：出计划 + 自检 + 分配 AI（角色清单的唯一产出者）。 */
  PLANNER: 'planner',
  /**
   * ★「项目主管」。
   *
   * 它是**需求分析与计划之间的那一站**：需求确认之后状态先落到它，它做**两次独立确认**
   * （两条各自留痕的记录），两次都完成才允许下放给计划。
   *
   * ⚠️ 它是**编排位，不是第四权**。两条边界写死在这里，不靠散文：
   *   · `writes: 'readonly'` —— 不持有编写 / 测试 / 审核任何一权的写权限；
   *   · `handoffKinds` 白名单里**没有** `review_verdict`（审核结论只能由 reviewer 产出，
   *     方向表与状态机各有一道判据）；它也不在 `canRework` 里。
   *   · 与 main / orchestrator / planner **同一类**：读源码正文的能力为「否」
   *     （守门的 `NO_CODE_READ_ROLES`）—— 它凭什么判断？凭需求档与只给路径的目录结构。
   */
  /** ★「项目主管」：需求确认之后那一站，两次独立确认后下放（见 ROLES 里的条目）。 */  SUPERVISOR: 'supervisor',
  ARCHITECT: 'architect',
  SECURITY: 'security',
  WRITER: 'writer',
  TESTER: 'tester',
  REVIEWER: 'reviewer',
  REVIEWER: 'reviewer',
  /**
   * ★「留档 AI」。
   *
   * 它是 `requirement.md` 的**唯一写者** —— 这一点推翻了上一轮「需求分析独占写权」的设计。
   * 现在的分工是**分权写 + 专人汇总**：
   *   · 各角色 / 席位在 `records/` 下写**自己那份**记录（互不覆盖，谁的记录谁写）
   *   · 留档 AI **收集**这些记录 → **统一编写**成唯一的需求档
   *   · 每条内容必须能追溯到「哪份记录、谁提交的、何时」—— **不得凭空写入无来源内容**
   *   · 记录之间**矛盾**时它**不得自己拍板**，走 clarification_request 或升级
   */
  ARCHIVIST: 'archivist',
  DIAGRAMMER: 'diagrammer',
  RELEASE: 'release',
  DOCS: 'docs',
  PERFORMANCE: 'performance',
  ARBITER: 'arbiter',
  HUMAN: 'human',
}

/**
 * 全部角色及其职责/权限。
 *
 * `writes` 描述「该角色允许写文件的位置」，取值与守门的 `writeClassOf()`
 * （`lib/guard/rules.js` 的 `writeClassOf`，枚举在它上方）返回的类别**是同一套** ——
 * 守门认的就是这几个词：
 *   · `'readonly'` 一字节都不许写（`main` / `orchestrator` / `planner` / `supervisor`）
 *   · `'workdir'`  项目源码树（编写角色的正当工作区；`writer` / `human`）
 *   · `'own-dir'`  ★ **只有它自己的子目录**：`<任务>/reports/<role>/<role>[-后缀].<log|jsonl|md|json|txt>`，
 *                  其余位置（**包括 reports/ 下的别的文件**）一律拒绝写入
 *                  （`tester` / `architect` / `security` / `archivist` / `diagrammer` /
 *                  `release` / `docs` / `performance` / `arbiter`）
 *   · `'own-log'`  ★ **只有它自己的日志文件**：`<任务>/reports/<role>/<role>[-后缀].log|.jsonl`，
 *                  其余位置（**包括 reports/ 下的别的文件**）一律拒绝写入。
 *                  目前只有 `reviewer` 用这个取值 —— 见下面 REVIEWER 条目里的理由。
 *   · `'none'`     真只读，但不进控制三角那两张对外名单；写入判据与 `'readonly'` **完全等价**
 *                  （都是一字节不许写）。★ 本表没有角色声明它 —— `supervisor` 在守门里被判成
 *                  `'none'`（`guard.js` 的 `NO_WRITE_ROLES`），与它这里声明的 `'readonly'`
 *                  在写入判据上等价，差别只在 `read_only_roles` / `no_code_read_roles`
 *                  两张对外名单里出不出现。
 *
 * ★ 沿革（**过时的取值不要再写回来**）：`'reports'`（整个 `reports/` 目录随便写）与
 *   `'pipeline'`（本任务的 task.json / handoffs/）**都已经不是**合法取值 ——
 *   前者被 `'own-log'` 收紧取代（见下面 REVIEWER 条目的沿革），
 *   后者一直由工具写、不经文件工具。
 *
 * ★ 这份表是**能力边界**，方向永远是"只给该给的"：
 *   忘了给某角色加能力 = 少一条能力（会被明确拒绝）；
 *   忘了收 = **悄悄多一条能力**（不可接受）。
 *   所以收紧权限时**必须同时改这张表与守门**（守门读的是同一份语义）。
 *
 * `handoffKinds` 是该角色**有权产出**的交接物类型。空数组 = 不产出交接物。
 * 这张表就是"编写不能直接把产物交给审核"的落地处：writer 的列表里没有
 * `dev_to_review`，而状态机也不接受 developing → ready_review。
 *
 * @type {Record<string, {id:string, zh:string, en:string, kind:'control'|'execution'|'advisory', writes:string, handoffKinds:string[], canRework:boolean, canRequestRosterChange:boolean, summary:string}>}
 */
export const ROLES = {
  [ROLE.MAIN]: {
    id: ROLE.MAIN,
    zh: '主对话',
    en: 'Main',
    kind: 'control',
    writes: 'readonly',
    handoffKinds: [],
    canRework: false,
    canRequestRosterChange: false,
    summary: '接需求、开单、按角色清单派活、催办、维护状态、收到审核 OK 后关单。不读代码、不写代码、不跑测试、不做技术判断。',
  },
  [ROLE.ORCHESTRATOR]: {
    id: ROLE.ORCHESTRATOR,
    zh: '需求分析',
    en: 'Orchestrator',
    kind: 'control',
    writes: 'readonly',
    // ★ 本轮改动：`orchestration`（角色清单）**移交给 planner** —— 分配 AI 不再是它的活。
    //   它产出的是「需求分析结论」（requirement_analysis），其中**必须**带
    //   「需求不清楚处」清单；那份清单会被提交到主对话 → 用户人工确认。
    handoffKinds: ['requirement_analysis', 'full_test_review', 'human_request', 'clarification_reply', 'seat_handover',
      // ★ T-20261011-56a37e：第③④道站点的**需求位那一侧**确认（双确认缺它不可）。
      'station_confirm',
      // ★★ P3 接线：产品目录 + 产品设计文档（与 DEMO 同批一次确认，裁定 6 / 验收 A15）。
      //    与 `guard/rules.js` 的 HANDOFF_DIRECTION、`handoff/schemas.js` 的 from 三处一致。
      'product_design'],
    canRework: false,
    canRequestRosterChange: false,
    summary:
      '第 1 轮需求分析：把模糊需求翻译成任务卡、验收标准、边界条件、测试要点，' +
      '并产出「需求不清楚处」清单交给主对话提请**用户人工确认**。' +
      '它同时是**两级澄清梯的第一级**：执行/顾问角色答不了的问题先问它，它能在需求层裁定就直接答，答不了才升级给用户。' +
      '**不分配 AI**（角色清单是 planner 的产物）。' +
      '★ **不看代码**：源码正文读不到（守门拦 read / 检索 / shell 读），产物里也不许出现代码正文。',
  },
  [ROLE.PLANNER]: {
    id: ROLE.PLANNER,
    zh: '计划',
    en: 'Planner',
    kind: 'control',
    writes: 'readonly',
    // ★ 不含 clarification_reply：裁定只有需求分析能出（方向表与 pipeline_clarify_reply 都只认 orchestrator）
    handoffKinds: ['plan', 'orchestration', 'full_test_review', 'human_request', 'seat_handover',
      // ★ T-20261011-56a37e：计划位 → 测试位的「任务内容预登记」（测试**提前**知情）。
      //   它是本单新增的唯一一条"提前交付"通道，方向由类型固定（planner → tester）。
      'prebrief'],
    canRework: false,
    canRequestRosterChange: false,
    summary:
      '接**用户确认过**的需求 → 出计划（步骤 + 层清单）→ **自检计划有无缺失** → ' +
      '无缺失才**分配 AI**：档位、需要几个独立对话、角色清单、调用顺序、编写席位与各层分工。' +
      '自检发现缺失时**不得自行分配**，必须走澄清梯退回需求分析（答不了则由需求分析升级给用户）。' +
      '★ **不看代码**：源码正文读不到（守门拦 read / 检索 / shell 读），产物里也不许出现代码正文 —— ' +
      '它凭什么在没读代码的前提下出计划？凭三样：需求档（权威需求快照）、' +
      '需求分析的验收标准与边界、以及**只给路径不给正文**的目录结构。',
  },
  [ROLE.SUPERVISOR]: {
    id: ROLE.SUPERVISOR,
    zh: '主管',
    en: 'Supervisor',
    kind: 'control',
    /**
     * ★ **真只读**：与 main、orchestrator、planner 同一档 —— 一字节都不许写。
     *   它不持有编写、测试、审核任何一权的写权限（守门按 writeClassOf 判死）。
     */
    writes: 'readonly',
    /**
     * ★ 交接物白名单 —— **方向永远是白名单：忘了加 = 少一条能力（可接受），
     *   忘了删 = 悄悄多一条能力（不可接受）**：
     *   · 白名单里**没有** review_verdict ⇒ 它产不出审核结论（C5 的第一道判据；
     *     第二道在交接物方向表与状态机的 review_ok 前置）；
     *   · 白名单里**没有** dev_to_test、test_to_review ⇒ 它不替编写交活，也不替测试判通过。
     *
     * ⚠️ 「主管两次确认」要落的那条记录由交接物方向表给出；
     *    本表与它必须一致（本表的 handoffKinds ↔ 那份方向表的 from）。
     *    该类型落地后补进这张白名单 —— **在那之前不许先写一个不存在的类型**：
     *    "表里有个谁都不认识的类型"正是能力漂移的入口。
     */
    // ★ 不含 clarification_reply：裁定只有需求分析能出（方向表与 pipeline_clarify_reply 都只认 orchestrator）
    handoffKinds: ['human_request', 'seat_handover',
      // ★★ T-20261011-56a37e（主管枢纽）：
      //   · `station_confirm` —— 确认留痕里**主管那一侧**的那一份（①②是它单独确认，
      //     ③④是它与需求位的**双确认**之一，②c 是架构图的**二次确认**）；
      //   · `diagram_rework`  —— 架构图不满足时的重画指令（**限 1 次**，再不行升人工）。
      //
      //   ⚠️ 「主管的发起与唤醒」**不在这张表里** —— 那是**状态迁移**，不是交接物。
      //      它们走 `pipeline_supervise`（工具级白名单 `['supervisor']`）+ TRANSITIONS 里
      //      `by: ['supervisor']` 的两道判据。为什么不复用 `pipeline_dispatch`（main）：
      //      那会把发起者记成 main（"谁发起"不可追溯），并且主管会连带拿到 main 的整片派活权
      //      —— 那是**越权放行**（安全预审 R3 的原话）。
      'station_confirm', 'diagram_rework'],
    /** 它不打回（打回是测试、审核、安全、人工的事）。 */
    canRework: false,
    /** ★ 它**不能**自己改角色清单：加人减人仍然必须走「角色变更申请 → 计划复核」。 */
    canRequestRosterChange: false,
    summary:
      '★ **枢纽位**（T-20261011-56a37e 落地）：**发起**需求分析 / 计划 / 架构三方对话' +
      '（计划位与架构位发起后先「已登记待机」，到唤醒点才动）；做站点确认里主管那一侧' +
      '（①需求结论同意 ②架构图首次确认 ②c 架构图**二次确认** ③④与需求位的双确认）；架构图不满足时发重画指令（限 1 次），' +
      '再不行走既有的两级梯升给用户。' +
      '★ **不看代码**：源码正文读不到，产物里也不许出现代码正文；确认依据是**证据标识 + 脱敏证据正文**。' +
      '★ **不持有任何一权的写权限**（真只读），也产不出审核结论。' +
      '★ **不是第二个派活出口**：它只发起/唤醒**在册的那三个席位**，派活与状态路由仍走既有状态机与守门。' +
      '★ 下游只带**五元组 + 该角色最小必要上下文**，不转全量需求文档与代码正文。',
  },
  [ROLE.ARCHITECT]: {
    id: ROLE.ARCHITECT,
    zh: '架构/技术方案',
    en: 'Architect',
    kind: 'advisory',
    writes: 'own-dir',
    handoffKinds: ['design', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary: '给出模块划分、接口契约、技术选型与风险；产物作为编写角色的输入约束。',
  },
  [ROLE.SECURITY]: {
    id: ROLE.SECURITY,
    zh: '安全/合规审计',
    en: 'Security',
    kind: 'advisory',
    writes: 'own-dir',
    handoffKinds: ['security_review', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: true,
    canRequestRosterChange: true,
    summary: '按安全/合规基线审计产物，可独立打回编写；对安全敏感的验收标准有否决权。',
  },
  [ROLE.WRITER]: {
    id: ROLE.WRITER,
    zh: '编写',
    en: 'Writer',
    kind: 'execution',
    writes: 'workdir',
    // ★ 设计目的（防过度工程化：只干自己该干的）：这张**白名单**里**没有**
    //   `test_to_review` / `test_to_dev` / `review_verdict` —— 编写不跑测试、不判通过、
    //   不直接找审核。这不是文案，是能力边界（守门与 store 两道都读这张表）。
    handoffKinds: ['dev_to_test', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary: '按任务卡编写/修改程序、自测、整理补丁+变更说明+运行命令+自测结果+已知问题，**直接提交测试**。',
    /**
     * ⚠️ 上面这句里的"**自测**"与"**自测结果**"是**待用户拍板项**：
     *   用户本轮明确说「编程别跑测试」，而现有 `dev_to_test` 的固定字段里
     *   有一个 `selftest_result`。两者的边界（"仅允许构建/启动级冒烟、
     *   且不得作为测试判定、不得写进 dev_to_test 当结论"）**没有拍板之前**不擅自改：
     *     · 已经执法的是**没有歧义**的那半：编写不得产出测试报告/测试结论类交接物
     *       （本表 + `lib/handoff.js` 的 TEST_VERDICT_FIELDS 内容判据）；
     *     · 编写的**测试类命令**在守门层被拦（`lib/guard.js` 的 scanTestRunnerCommand）。
     *   详见 README「待确认项」。
     */
  },
  [ROLE.TESTER]: {
    id: ROLE.TESTER,
    zh: '测试',
    en: 'Tester',
    kind: 'execution',
    writes: 'own-dir',
    handoffKinds: ['test_to_review', 'test_to_dev', 'full_test_request', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: true,
    canRequestRosterChange: true,
    summary:
      '独立设计用例并执行，输出用例/结果/失败日志/通过证据/风险说明；通过后提交审核；不通过打回编写。**不得替编写改代码。**' +
      '★ **默认只跑定向/增量测试**（按改动面挑相关用例）；要跑**全量**必须走四级审批链' +
      '（需求分析 → 审核 → 用户人工 → 计划 AI），守门在 shell 那一层直接拦无凭据的全量命令。',
  },
  [ROLE.REVIEWER]: {
    id: ROLE.REVIEWER,
    zh: '审核',
    en: 'Reviewer',
    kind: 'execution',
    /**
     * ★ **只读角色**：只有它**自己的日志文件**可写。
     *
     * 用户原话：「审核 ai 只读，只有属于他的日志文件有权限写入」。
     *
     * 沿革（这条是**收紧**，不是新加）：
     *   · 更早：`writes: 'reports'` —— 整个 `reports/` 目录随便写；
     *   · 现在：`writes: 'own-log'` —— 只有 `<任务>/reports/reviewer/<...>.log|.jsonl`。
     *   ★ 它比"审核不改代码"更严：旧规矩只说"不许写源码树"，
     *     而 `reports/` 下仍然什么都能写（测试报告、别人的产物、随便一个文件）。
     *     新规矩是「**除自己的日志外，全都不许写**」。
     *
     * 为什么非收不可：审核一旦手里有"写"的权限，就有"顺手改一下"的诱惑 ——
     * 而审核的角色意义恰恰是**独立核对**。给它一支笔，它就从"核对者"滑向"共谋者"：
     * 发现了问题顺手改掉，然后判自己 OK。收掉这支笔，它就只能**报出来**。
     * 它的意见与判定文本落进那个日志文件（以及结构化交接物 `review_verdict`）。
     */
    writes: 'own-log',
    handoffKinds: ['review_verdict', 'full_test_review', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: true,
    canRequestRosterChange: true,
    summary:
      '核对需求/产物/测试报告，检查验收标准、质量、风险、边界、安全；' +
      '并按**改动基线**做前后版本对比，确认有没有多改（多改 / 少改 / 改错地方三种都要报）。' +
      '通过发 OK，否则打回编写或测试。**不得替编写改代码。**' +
      '★ **只读**：除自己的日志文件（reports/reviewer/*.log）之外，任何位置都写不了。',
  },
  /**
   * ★ 架构图角色。
   *
   * ⚠️ 与 `architect`（架构/技术方案）**不是一回事**，别混：
   *   · `architect` 是**编写之前**的顾问，产出"该怎么写"的文字方案（`design`）
   *   · `diagrammer` 是**编写之后**的产出者，产出"写成了什么样"的**图**（`architecture_diagram`）
   *   一个是输入约束，一个是交付物 —— 时机、方向、产物都不同。
   *
   * 为什么 `writes` 是 `'own-dir'` 而不是 `'workdir'`：它不该改代码。
   * 它渲染出来的 HTML 由 archigate 的 `diagram_deliver` 写到它自己指定的 out_dir
   * （通常就是本任务的报告目录），走别人的工具，不经本项目源码树。
   */
  [ROLE.ARCHIVIST]: {
    id: ROLE.ARCHIVIST,
    zh: '留档',
    en: 'Archivist',
    kind: 'execution',
    writes: 'own-dir',
    /**
     * ⚠️ **2026-10-14：`'compilation'` 从这张白名单里去掉了** —— 它不是一个存在的类型：
     *   `HANDOFF_SCHEMAS`（`lib/handoff/schemas.js`，25 个 kind）里**没有** `compilation`，
     *   真提交会被 `UNKNOWN_HANDOFF` 拒（`lib/store/submit.js`；`lib/handoff/validate.js` 同理）。
     *   这正是本文件 `:184-185` 亲口警告过的那个陷阱：「在那之前不许先写一个不存在的类型 ——
     *   "表里有个谁都不认识的类型"正是能力漂移的入口。」
     *
     *   ★ 修法**只能是删掉这个不存在的类型**，不能"照 schema 的形状补一个 compilation 出来" ——
     *     那等于给留档角色新增一条能力，不属于任何一轮"对齐"的授权范围。
     *     留档角色真正的产出通道是**工具**、不是交接物：`pipeline_compile_requirement`
     *     （`lib/tools/records.js`，`【只有留档 AI】`）汇总出 `requirement.md` + 结构化 JSON。
     *
     * ⚠️ 另有一条**未修、只报备**的落差（同一族，但补它 = 新增能力）：
     *   下面这三类虽然都是**真类型**，但 `HANDOFF_DIRECTION`（`lib/guard/rules.js`）
     *   的名单里**都没有 `archivist`** ⇒ 留档角色目前实际交不出**任何一份**交接物。
     *   要修得单独授权（它要么是补方向表，要么是给该角色换一条产出路径）。
     */
    handoffKinds: ['human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary:
      '★ **需求档的唯一写者**：收集各角色 / 席位在 records/ 下落的记录，统一编写成 .pipeline/<taskId>/requirement.md + 结构化 JSON。' +
      '每条内容必须可追溯到「哪份记录、谁提交的、何时」；提交必须带席位令牌（校验来路，拒绝匿名 / 冒名）。' +
      '记录之间矛盾时**不得自己拍板** —— 走 clarification_request 或升级。不得凭空写入无来源内容。',
  },
  [ROLE.DIAGRAMMER]: {
    id: ROLE.DIAGRAMMER,
    zh: '架构图',
    en: 'Diagrammer',
    kind: 'execution',
    writes: 'own-dir',
    handoffKinds: ['architecture_diagram', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary:
      '★ **两个站点**（T-20261011-56a37e 起）：①**架构图前置站** —— 主管同意需求结论（唤醒点 A）' +
      '之后、计划位开工之前，出**设计态结构图**并交主管确认（第②道）；' +
      '②**交付站** —— 编写完成之后，把"写成了什么样"渲染成交付物之一。' +
      '优先走 archigate 的 diagram_deliver（normify 建树校验 → 组件↔模块映射闸门 → archify 渲染四道门 → 交付收据），' +
      '并把收据路径 + 产物 sha256 写进交接物；该工具不可用时可降级为自备产物，但必须显式标注 degraded。',
  },
  [ROLE.RELEASE]: {
    id: ROLE.RELEASE,
    zh: '发布/运维',
    en: 'Release',
    kind: 'execution',
    writes: 'own-dir',
    handoffKinds: ['release_plan', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: true,
    canRequestRosterChange: true,
    summary: '负责上线步骤、回滚方案、灰度与监控；关单前必须给出可执行的发布与回滚计划。',
  },
  [ROLE.DOCS]: {
    id: ROLE.DOCS,
    zh: '文档',
    en: 'Docs',
    kind: 'advisory',
    writes: 'own-dir',
    handoffKinds: ['docs_note', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary: '产出用户文档/变更日志/使用说明。',
  },
  [ROLE.PERFORMANCE]: {
    id: ROLE.PERFORMANCE,
    zh: '性能/压测',
    en: 'Performance',
    kind: 'advisory',
    writes: 'own-dir',
    handoffKinds: ['perf_report', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: true,
    canRequestRosterChange: true,
    summary: '给出基准、压测结果与性能回归结论。',
  },
  [ROLE.ARBITER]: {
    id: ROLE.ARBITER,
    zh: '仲裁/争议解决',
    en: 'Arbiter',
    kind: 'advisory',
    writes: 'own-dir',
    handoffKinds: ['arbitration', 'human_request', 'clarification_request', 'seat_handover'],
    canRework: false,
    canRequestRosterChange: true,
    summary: '编写与测试/审核对结论有分歧且打回次数用尽时介入，给出有约束力的裁定。',
  },
  [ROLE.HUMAN]: {
    id: ROLE.HUMAN,
    zh: '人工',
    en: 'Human',
    kind: 'control',
    writes: 'workdir',
    handoffKinds: ['human_note', 'human_request'],
    canRework: true,
    canRequestRosterChange: true,
    summary: '异常出口：阻塞、取消、人工放行、回滚。人工动作会在审计日志里留痕。',
  },
}

/** 全部角色 id 列表。 */
export const ALL_ROLE_IDS = Object.keys(ROLES)

/**
 * 基线四角色（不含独立编排对话）。
 * 这是「最少 4 个独立对话」那条硬性要求的落地：主 / 编写 / 测试 / 审核。
 */
export const BASE_ROLES = [ROLE.MAIN, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER]

/**
 * 三权分立的三个执行角色。任何一档配置都必须同时包含这三个。
 */
export const SEPARATION_ROLES = [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER]

/**
 * ★ 编写席位（seat）。
 *
 * 「编写」不再必然是一个 AI：同一个 `writer` 角色可以有 **1~3 个独立席位**，
 * 每个席位 = 一份独立令牌 + 一个独立会话 + 一段独立的写入范围。
 *
 * ★ **count=1 必须是同一套机制的退化情形**（这是需求明文要求的）：
 *   席位的存在与否不改变代码路径 —— 1 个席位时 `partitions` 只有一条，
 *   范围就是整个项目根（`scope_paths: ['.']`）。不存在"单编写模式"与
 *   "多编写模式"两套分支。
 *
 * 席位 id 形如 `writer#1`；它**不是**角色 id —— 角色仍然是 `writer`，
 * 席位只是同一角色下的实例编号。这样既有的角色白名单、交接物方向表都不用改。
 *
 * ★ 本轮改动一：上限 **3 → 6**（用户拍板）。为什么是 6 而不是更大：
 *   默认层清单是 3 层（接口/数据/处理），一个工程量大的项目按层拆 + 每层
 *   再拆前后端，翻一倍就是 6。再往上，协调成本会超过并行收益 ——
 *   而且"全部席位到齐才推进"这条规矩会让等待时间线性变长。
 *
 * ★ 本轮改动二：**席位数由层数决定**（`count === layers.length`）。
 *   count=1 仍然是同一套机制的退化情形：那时层清单退化成单层 `all`
 *   （一个席位负责全部），走的还是同一份 `buildWriters` / 同一套越界执法。
 */
export const MAX_WRITER_SEATS = 6

/**
 * ★ 编写**层清单**：默认三层 —— 接口层 / 数据层 / 处理层。
 *
 * 层清单由 planner 按项目裁剪或扩展（`writers.layers`），但：
 *   · 层 id 只能是标识符（小写字母/数字/`_`/`-`），中文名走 `WRITER_LAYERS` 表；
 *   · `count === layers.length` 这条不变量不许破 —— 一个层就是一个席位，
 *     不许多个席位挤同一层（那会让"谁负责哪层"答不出来）。
 *   · `scope_paths` 仍然逐席位必填 —— **按层分工不取消路径执法**。
 */
export const WRITER_LAYERS = {
  interface: '接口层',
  data: '数据层',
  logic: '处理层',
}

/** 默认层清单（按顺序 = 席位序号顺序）。 */
export const DEFAULT_WRITER_LAYERS = ['interface', 'data', 'logic']

/** 单席位退化时用的层 id：一个席位负责**全部**层。 */
export const SINGLE_SEAT_LAYER = 'all'

/** 层 id 的合法形状。 */
export const LAYER_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/

/** 层 id 的中文名（认不出就原样返回 —— 宁可显示得丑，也不要抛）。 */
export function layerLabel(layerId) {
  const id = String(layerId ?? '')
  if (id === SINGLE_SEAT_LAYER) return '全部层'
  return WRITER_LAYERS[id] ?? id
}

/** 由席位序号生成席位 id（1 起）。 */
export function seatId(k) {
  return `${ROLE.WRITER}#${Number(k)}`
}

/** 席位 id 的合法形状。 */
export const SEAT_PATTERN = /^writer#[1-9]\d*$/

/** 该角色是不是"执行角色"（真正干活的那三个，以及 L2+ 的架构/安全/发布等）。 */
export function isExecutionRole(roleId) {
  const r = ROLES[roleId]
  return r !== undefined && r.kind === 'execution'
}

/** 该角色是不是"控制角色"（主对话、编排、人工）。 */
export function isControlRole(roleId) {
  const r = ROLES[roleId]
  return r !== undefined && r.kind === 'control'
}

/**
 * 角色中文名（找不到就原样返回 id —— 宁可显示得丑，也不要抛）。
 * @param {string} roleId
 */
export function roleLabel(roleId) {
  return ROLES[roleId]?.zh ?? String(roleId ?? '')
}

/**
 * 该角色是否有权产出某种交接物。
 * @param {string} roleId
 * @param {string} kind
 */
export function canProduceHandoff(roleId, kind) {
  const r = ROLES[roleId]
  if (r === undefined) return false
  return r.handoffKinds.includes(kind)
}
