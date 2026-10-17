/**
 * dsh-pipeline · 边界清单的**静态规则表**
 * ============================================================================
 * 从 `lib/boundaries.js` 拆出（纯搬迁：标识符 / 字符串 / 默认值 / 逻辑逐字未动）：
 *   · `RULE_CLASS`：每条规则的分类（a 已判据化 / b 待做 / c 判据化不了）
 *   · `RULES`：六条**设计目的**规则 → 判据
 *   · `ADVISORY_LIMITS`：(c) 类 —— 判据化不了的自然语言约束（诚实边界）
 *
 * 由 `lib/boundaries.js`（barrel）与 `lib/boundaries/manifest.js` 复用。
 *
 * @module dsh-pipeline/lib/boundaries/rules
 */

import { ROLES } from '../roles.js'

/** 每条规则的分类（与文档里的 (a)/(b)/(c) 三类盘点一一对应）。 */
export const RULE_CLASS = {
  /** (a) 已判据化：守门/状态机/execute 里已经有判据 */
  enforced: 'a',
  /** (b) 可判据化但尚未做（本轮之后应为空） */
  todo: 'b',
  /** (c) 判据化不了：仍是自然语言约束，清单里如实列出并写明原因 */
  advisory: 'c',
}

/**
 * ★ 六条**设计目的**规则 → 判据。
 *
 * 这是这份清单的核心：每条规则都指向**代码里的那个函数/判据名**，
 * 而不是指向一段说明。`enforce` 为空 = 那条规则没有被判据执法（只可能是 (c)）。
 */
export const RULES = [
  {
    id: 'R1',
    zh: '编写不跑测试',
    why: '一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子',
    enforce: 'guard:scanTestRunnerCommand',
    applies_to: ['writer'],
    tools: ['pwsh', 'bash', 'shell'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R2',
    zh: '控制角色不看代码',
    why: '读了实现就会对实现指手画脚（定字段名、选库、加抽象）—— 那是过度工程化的入口',
    enforce: 'guard:NO_CODE_READ_ROLES',
    applies_to: ['main', 'orchestrator', 'planner'],
    tools: ['read', 'grep', 'glob', 'pwsh'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R3',
    zh: '最小改动：改动面必须与授权面相等',
    why: '修一个 bug 就别改整个模块；"顺手重构 / 统一风格 / 升级依赖"= 没有授权',
    enforce: 'guard:owningChangeScopeEntry + store:checkManifestAgainstScope',
    applies_to: ['writer'],
    tools: ['write', 'edit', 'pwsh'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R4',
    zh: '职责自限：只干什么，不要多干',
    why: '需求分析不分配、计划不写实现、每个角色有边界卡',
    enforce: 'handoff:validateRoleScope + scanRequirementAnalysisForAllocation + store:ROLE_BOUNDARIES_INCOMPLETE',
    applies_to: ['orchestrator', 'planner'],
    tools: ['pipeline_handoff'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R5',
    zh: '双轨派活：编写与审核同时接任务',
    why: '审核开工前就拿到授权面/越界清单/边界卡/基线，但**不能提前出结论**',
    enforce: 'tools:pipeline_dispatch（reviewer 开工前简报）+ states:review_verdict 只在 reviewing',
    applies_to: ['reviewer'],
    tools: ['pipeline_dispatch'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R6',
    zh: '审核只读 + 前后版本对比',
    why: '审核一有写权限就会"顺手改一下"；对比要靠基线哈希，不靠"我看了一遍"',
    enforce: 'guard:writeClassOf(own-log) + store:changeAudit',
    applies_to: ['reviewer'],
    tools: ['write', 'edit'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R7',
    zh: '没有写权限的位置一律只读（全角色）',
    why: '测试 ai 等同理 —— 每个角色的 writes 逐字节落到守门路径判据上',
    enforce: 'guard:writeClassOf + checkOwnPath',
    applies_to: Object.keys(ROLES),
    tools: ['write', 'edit', 'notebook_edit', 'apply_patch'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R8',
    zh: '在册的角色必须交出它那一份（发布 / 文档 / 性能 / 架构图）',
    why: '以前只写在角色卡里（"关单前必须给出……"）—— 写在 summary 里等于没人执法',
    enforce: 'store:role_products_delivered + diagram_delivered（关单组合闸）',
    applies_to: ['release', 'docs', 'performance', 'diagrammer'],
    tools: ['pipeline_close'],
    class: RULE_CLASS.enforced,
  },
  // ★★ T-20261011-56a37e（主管枢纽）：新站点**全部纳入既有判据**，一条都不另起。
  {
    id: 'R9',
    zh: '主管枢纽：发起 / 待机 / 唤醒 / 架构图前置',
    why:
      '用户要的是「主管发起（需求分析/计划/架构）· 计划位与架构位待机 · 到点才动 · 架构图先于计划」。' +
      '四条都落成**表上的判据**：发起与唤醒是具名事件（`by: [supervisor]` 独占），' +
      '待机是产物面判据（交接物 / own-dir 写入 / 测试执行），架构图前置是**状态表里不存在**的边。',
    enforce:
      'states:TRANSITIONS(supervisor_initiate/supervisor_agree_need/supervisor_confirm_diagram) ' +
      '+ guard:PIPELINE_TOOL_ROLES.pipeline_supervise=[supervisor] ' +
      '+ store:hub_initiate/hub_plan_woken/hub_standby_product_gate + store:checkHandoffAgainstState(HUB_DIAGRAM_FIRST)',
    applies_to: ['supervisor', 'orchestrator', 'planner', 'architect', 'diagrammer', 'main'],
    tools: ['pipeline_supervise', 'pipeline_handoff', 'pipeline_transition'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R10',
    zh: '主管枢纽：五道站点（用户原话 ①②③④⑤）+ ②b/②c 两个交接确认点（③④ 必须是**双确认**）',
    why:
      '用户要的是"少一道就走不到下一步"。双确认若只写成"一份记录里两个布尔字段"，是可以伪造的 ——' +
      '正解是**两份 from_role 不同、各自令牌产出**的记录，都绑同一制品版本、都在最近一次打回之后、' +
      '且不得跨站点复用同一份（照抄既有 effectiveReviewOk 的强度，不弱于它）。' +
      '★ 归因更正（2026-10-14）：这三条**不是** `handoff:validateStationConfirm` 判的 —— ' +
      '那个函数（`lib/handoff/scans.js`）只判四件事（站点合法性、证据标识、' +
      '脱敏正文无代码、夹带判据），**不绑版本、不查打回序号、不防跨站复用**。' +
      '三条的真实执法在 **`store:hubValidConfirms`**（`lib/store/hub.js`：只取' +
      '最近一次打回之后的、站点字段必须正是这一站、制品版本必须等于本站当前目标），' +
      '入口是同一文件的 `store:hubStationGate`。**判据没有缺，改的只是归因。**',
    enforce:
      'handoff:HANDOFF_SCHEMAS.station_confirm + handoff:validateStationConfirm(证据标识/脱敏证据正文) ' +
      '+ store:hubStationGate/hubValidConfirms(绑版本/打回后/不跨站复用) ' +
      '+ store:hub_station_need_agree/hub_station_diagram_confirm/dispatch_reviewer_gate(=hubStationGate(第③道))/hub_station_review_confirm',
    applies_to: ['supervisor', 'orchestrator', 'main'],
    tools: ['pipeline_supervise', 'pipeline_handoff', 'pipeline_transition', 'pipeline_close'],
    class: RULE_CLASS.enforced,
  },
  {
    id: 'R11',
    zh: '测试提前知情：内容提前交到测试位手里，但**不许看编写的产物**、也不许提前开工',
    why:
      '用户口径③的两半是一体两面：只给"知情"没有载体 ⇒ 变成一句口号；只给载体不拦开工 ⇒ 变成提前抢跑。' +
      '所以预登记（prebrief）必须是**编写交付之前**提交的独立交接物，且测试位在 dev_submitted 之前的' +
      '一切测试行动在守门层被拦。',
    enforce:
      'handoff:HANDOFF_SCHEMAS.prebrief + handoff:validatePrebrief(夹带判据) ' +
      '+ store:hub_prebrief_before_write + guard:hubStandbyBlocksWrite(测试执行面)',
    applies_to: ['planner', 'tester'],
    tools: ['pipeline_handoff', 'pwsh', 'bash'],
    class: RULE_CLASS.enforced,
  },
  // ★★ 2026-10-14（孤儿单自恢复）：判据是**内容派生身份 + 只投既有会话**，不是善意。
  {
    id: 'R12',
    zh: '孤儿单：席位被切断 / 这单没人管了 ⇒ 机制**自己意识到并重新投递**（不建新席位、不改状态）',
    why:
      '用户原话：「席位被切断后，机制要能**自己意识到**并**重新投递** —— 不是等人来救。」' +
      '改前没有任何一条判据认领这件事：失联只**冻**不**叫**（liveness）、巡检只**播报**不**动作**（A22）、' +
      '运行失败中止是**另一条判词**（runfail）。所以两条判据必须分开落：' +
      '① **识别**（会话文件不在 / 不再变化且无活证据 / 停在非终态且整单零证据）——纯函数 `orphanVerdict`；' +
      '② **再投递**（走 `notify_only` 的同一份实现，投给派活台账里那个既有会话；投不出去如实报）——`createOrphanRescue`。',
    enforce:
      'orphan:orphanVerdict(orphan-seat-gone / orphan-task-unattended) ' +
      '+ tools:createSeatNotifier().notifyOnly（= pipeline_dispatch notify_only 的同一份实现） ' +
      '+ wakeledger:hasDelivered/record/noteUnresolved/markEscalated（幂等与"投不出去"的可见面）',
    applies_to: Object.keys(ROLES),
    tools: ['pipeline_dispatch', 'pipeline_status'],
    class: RULE_CLASS.enforced,
  },
]

/**
 * ★ (c) 类：**判据化不了**的自然语言约束 —— 如实列出来，不假装它被执法了。
 *
 * 每一条都要写清"为什么判据化不了"。这份清单是给人看的**诚实边界**，
 * 也是给钩子层的"别白费力气"提示：这些位置拦不住。
 */
export const ADVISORY_LIMITS = [
  {
    id: 'C1',
    zh: '别过度设计 / 计划要合理',
    why:
      '判据化不了：什么是"过度"取决于具体项目与验收标准，没有可机械判定的形式。' +
      '能判的只有它的**可观测形态**（改动面超授权、新增未授权的文件、改到清单外）—— 那已经由 R3 覆盖。',
  },
  {
    id: 'C2',
    zh: '需求分析要问得全、计划要自检到位',
    why:
      '判据化不了：只能强制"必须显式产出清单"（unclear_points / self_check.checked 必填），' +
      '但"清单里的东西够不够"没有形式化判据 —— 那正是需要人（用户确认那一步）的原因。',
  },
  {
    id: 'C3',
    zh: '交接物要写得清楚（补丁说明、变更说明的质量）',
    why: '判据化不了：只能约束字段存在与长度下限，写得好不好是主观判断。',
  },
  {
    id: 'C4',
    zh: '测试要"独立设计"用例',
    why:
      '判据化不了：独立性本身来自 DSH 的子代理上下文（另一个会话、没有编写的上下文），' +
      '本插件能保证的只是"谁的活谁交"（方向表）与"用例/证据字段必填"。',
  },
  {
    id: 'C5',
    zh: '主对话不得把别人的令牌转手',
    why:
      '判据化不了（除非开 requireAgentBinding）：令牌就在主对话手里，' +
      '这是设计上的信任根；开了绑定之后令牌与子会话一一对应，转手即失效 —— 那是配置项，不是判据。',
  },
  {
    id: 'C6',
    zh: '不得用 shell 的刻意混淆绕过判据（变量拼接 / 编码后执行 / 先写脚本再跑）',
    why:
      '判据化不了：shell 侧本来就是**字符串匹配**的 best-effort。' +
      '能保证的只有"文件工具那一路"（直接读参数里的路径）。要真封死只能靠环境侧（不给 shell / 不给测试环境）。',
  },
  {
    id: 'C7',
    zh: '未绑定角色的会话不受约束',
    why: '判据化不了（也是刻意的）：守门只约束**流水线参与者**，否则会和别的插件打架。',
  },
  {
    id: 'C8',
    zh: '记录之间矛盾时留档 AI 不得自己拍板',
    why:
      '判据化不了："两条记录互相矛盾"是语义判断。' +
      '能判的只有"每条内容必须指向一份真实存在的记录"（UNSOURCED_CONTENT）与"必须走澄清/升级"这条**出口**的存在。',
  },
]
