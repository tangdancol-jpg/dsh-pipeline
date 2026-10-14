/**
 * dsh-pipeline · **机器可读的边界清单**
 * ============================================================================
 * 用户原话（本项目的目标函数）：
 *   「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」
 *
 * 这个模块把"**谁、能做什么、判据在哪**"导成一份结构化清单 —— 它**不是文档**，
 * 而是给**别的执法层**（例如在 DSH 层挂 `UserPromptSubmit` / `PreToolUse` 钩子的那条线）
 * 复用的数据：钩子层不需要读懂本插件的源码，只要读这份清单就能知道
 * "哪个角色不许碰什么、命中哪条判据"。
 *
 * 三条设计约束：
 *   ① **派生，不手抄**：角色/交接物/读禁名单都从 `roles.js` / `guard.js` / `handoff.js`
 *      的**真实常量**里取 —— 手抄一份必然与代码漂移，而漂移了的清单比没有更危险
 *      （钩子层会照着错的清单执法）。
 *   ② **只读**：本模块不产生任何副作用，也不写盘。
 *   ③ **认不出的东西要暴露**：`writeClassOf()` 认不出的 `writes` 取值会进
 *      `unmapped` 列表 —— 让"表里有个值守门不认识"这件事看得见（那正是能力漂移的入口）。
 *
 * @module dsh-pipeline/lib/boundaries
 */

import {
  NO_CODE_READ_ROLES,
  OWN_DIR_ROLES,
  OWN_LOG_ROLES,
  READONLY_ROLES,
  writeClassOf,
} from './guard.js'
import { HANDOFF_SCHEMAS } from './handoff.js'
// ★★ 2026-10-14：孤儿单自恢复的判据面（**派生自真实常量**，不手抄一份会漂移的表）。
import { orphanCatalog } from './orphan.js'
import { ROLES } from './roles.js'
import {
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_DUAL_STATIONS,
  HUB_HANDOFF_CONFIRM_EVENTS,
  HUB_HANDOFF_CONFIRM_ORDER,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_STANDBY_SEATS,
  HUB_STATION_CONFIRMERS,
  HUB_STATIONS,
  HUB_STATION_REJECT_BUDGET,
  HUB_STATION_REJECT_EVENTS,
  HUB_WAKE_POINTS,
  ROLES_CAN_ASK_CLARIFICATION,
  ROLES_CAN_RAISE_HUMAN,
  STATE_LABEL,
  TRANSITIONS,
  hubConfirmersOf,
} from './states.js'
import {
  DISPATCH_OPEN_ACTION,
  DISPATCH_OPEN_AUDIT_FIELDS,
  ROSTER_DEFAULT_MODE,
  ROSTER_ENV_DEFAULT,
  ROSTER_FULL_PERMISSION,
  ROSTER_MIN_PERMISSION,
  ROSTER_PERMISSION_TIERS,
  ROSTER_SLOT_KEYS,
  slotRoleNeedsDeclaration,
} from './tiers.js'

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
      '那个函数只判四件事（站点合法性 `lib/handoff.js:615-620`、证据标识 `:621-634`、' +
      '脱敏正文无代码 `:635-643`、夹带判据 `:644-653`），**不绑版本、不查打回序号、不防跨站复用**。' +
      '三条的真实执法在 **`store:hubValidConfirms`**（`lib/store.js:1155-1169`：`:1158` 只取' +
      '最近一次打回之后的、`:1163` 站点字段必须正是这一站、`:1165` 制品版本必须等于本站当前目标），' +
      '入口是 `store:hubStationGate`（`:1176`）。**判据没有缺，改的只是归因。**',
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

/**
 * 生成边界清单。
 *
 * @returns {object} 纯数据，可直接 JSON 序列化（给钩子层用）
 */
export function boundaryManifest() {
  /** 每个角色的能力边界（从真实的 `ROLES` 派生）。 */
  const roles = Object.values(ROLES).map((r) => {
    const cls = writeClassOf(r.id)
    return {
      id: r.id,
      zh: r.zh,
      en: r.en,
      kind: r.kind,
      /** 角色表里声明的写权限（`roles.js`） */
      writes: r.writes,
      /** 守门实际认的类别（`guard.js`）—— 两者必须一致，见 unmapped */
      write_class: cls,
      /**
       * 只读 = **一字节都不许写**。
       *
       * 取的是「守门的写入判据实际拦不拦它」，不是「在不在控制三角名单里」：
       * `'readonly'` 与 `'none'` 在写入判据上**完全等价**（`guard.js` 的
       * `if (cls === 'readonly' || cls === 'none')`），差别只在要不要出现在
       * 那两张对外名单里。按字面判（原先只认 `'readonly'`）会把主管导成
       * `read_only: false` —— 而它实际连一个字节都写不了，且角色表里声明的就是
       * `writes: 'readonly'`。那是清单与代码漂移，正是本模块第 ① 条约束要防的事。
       */
      read_only: cls === 'readonly' || cls === 'none',
      /** 可写的唯一位置（人话；空串 = 不许写） */
      write_scope:
        cls === 'readonly'
          ? ''
          : cls === 'own-log'
            ? '.pipeline/<taskId>/reports/<role>/<role>[-后缀].log|.jsonl'
            : cls === 'own-dir'
              ? '.pipeline/<taskId>/reports/<role>/<role>[-后缀].log|jsonl|md|json|txt'
              : '项目源码树（受 scope_paths + change_scope 双重约束）',
      /** 能不能读源码正文（`guard.js` 的 NO_CODE_READ_ROLES 的补集） */
      can_read_source: !NO_CODE_READ_ROLES.includes(r.id),
      /** 能不能跑测试（只有 tester 能；见 R1） */
      can_run_tests: r.id === 'tester' || r.id === 'human',
      /** 有权产出的交接物类型（`roles.js`） */
      handoff_kinds: [...r.handoffKinds],
      /** 能不能提澄清请求 / 发起人工介入（`states.js`） */
      can_ask_clarification: ROLES_CAN_ASK_CLARIFICATION.includes(r.id),
      can_raise_human: ROLES_CAN_RAISE_HUMAN.includes(r.id),
      can_rework: r.canRework === true,
      can_request_roster_change: r.canRequestRosterChange === true,
    }
  })

  /** 交接物的方向表（谁能产出哪种）——钩子层判"这次提交的身份对不对"用得上。 */
  const handoffDirections = Object.entries(HANDOFF_SCHEMAS).map(([kind, s]) => ({
    kind,
    zh: s.zh,
    from: [...s.from],
    to: s.to,
  }))

  /** 状态迁移表里"谁能在什么状态做什么"。 */
  const transitions = TRANSITIONS.filter((t) => t.by !== undefined).map((t) => ({
    from: t.from,
    event: t.event,
    to: t.to,
    by: [...t.by],
    guard: t.guard ?? null,
  }))

  /**
   * ★ 漂移检查：角色表里写了、但守门认不出的 `writes` 取值。
   * 非空就说明"文档说一套、代码另一套"—— 那正是本项目要防的事。
   */
  const unmapped = Object.values(ROLES)
    .filter((r) => writeClassOf(r.id) === null)
    .map((r) => ({ role: r.id, writes: r.writes, why: 'guard.writeClassOf() 认不出这个取值' }))

  return {
    plugin: 'dsh-pipeline',
    version: 1,
    principle: 'AI 的行为不靠自然语言限制，靠代码层直接拦截。',
    /** 读禁 / 写禁 / 只写自己那一片 —— 钩子层可以直接用这三张名单。 */
    lists: {
      no_code_read_roles: [...READONLY_ROLES],
      read_only_roles: [...READONLY_ROLES],
      own_log_roles: [...OWN_LOG_ROLES],
      own_dir_roles: [...OWN_DIR_ROLES],
    },
    roles,
    rules: RULES.map((r) => ({ ...r })),
    /** ★ 判据化不了的（诚实边界）—— 钩子层在这里拦不住，别白费力气。 */
    advisory_limits: ADVISORY_LIMITS.map((x) => ({ ...x })),
    handoff_directions: handoffDirections,
    transitions,
    /**
     * ★ **名单四槽面**（只读导出；A5 / B1 的可见性判据）。
     *
     * 它是"名单声明什么档、会话就该拿到什么档"这条链在**导出处**的样子：
     * 四槽字段名、三档取值、最小档、完全档、只读角色集合（不派活 ⇒ 不落槽位）、
     * 需声明槽位的角色集合、开对话留痕的动作名与字段表 —— 全部**派生自真实常量**，不手抄。
     *
     * ⚠️ 这里**不导出任何具体任务的名单**：那份清单是任务级数据（task.roster），
     *    本清单是**能力边界**（谁能开什么档），两者别混。
     */
    roster_slots: {
      slot_keys: [...ROSTER_SLOT_KEYS],
      permission_tiers: [...ROSTER_PERMISSION_TIERS],
      min_permission: ROSTER_MIN_PERMISSION,
      full_permission: ROSTER_FULL_PERMISSION,
      full_permission_requires: 'permission_approval{ref,at,seat}（缺一项即拒：B4；给了即留痕：B5）',
      default_mode: ROSTER_DEFAULT_MODE,
      env_default: ROSTER_ENV_DEFAULT,
      needs_declaration_roles: Object.values(ROLES).map((r) => r.id).filter((id) => slotRoleNeedsDeclaration(id)),
      no_slot_roles: Object.values(ROLES).map((r) => r.id).filter((id) => !slotRoleNeedsDeclaration(id)),
      dispatch_open_action: DISPATCH_OPEN_ACTION,
      dispatch_open_fields: [...DISPATCH_OPEN_AUDIT_FIELDS],
    },
    /**
     * ★★ **主管枢纽面**（T-20261011-56a37e 的只读导出）。
     *
     * 为什么要有这一块：验收与测试要点要求「新站点、待机态与发起方集合**在只读导出里直接可见**」
     *   —— 判据不能只在拒绝原文里，还要有"现在这张拓扑长什么样"的可核对面。
     *
     * ★ 全部**派生自 `states.js` 的真实常量**（不手抄）：改一处表，这里跟着变；
     *   手抄一份的下场就是"导出说的"与"判据做的"不一致 —— 那比没有导出更坏。
     */
    supervisor_hub: {
      /** 发起方集合：**只有主管**（main 代发会被 by 名单与工具白名单两道拒掉）。 */
      initiator_roles: [...new Set(TRANSITIONS.filter((t) => t.event === 'supervisor_initiate').flatMap((t) => t.by ?? []))],
      /** 发起事件名（具名动作；不是复用 main 的 `pipeline_dispatch`）。 */
      initiate_event: 'supervisor_initiate',
      /** 具名动作工具（工具-角色白名单里只放 supervisor）。 */
      initiate_tool: 'pipeline_supervise',
      /** 两个唤醒点 + 各自唤醒谁（'已登记待机' 的可见面）。 */
      wake_points: Object.values(HUB_WAKE_POINTS).map((wp) => ({
        wake_point: wp,
        seats: HUB_STANDBY_SEATS.filter((s) => s.wake_point === wp).map((s) => ({ role: s.role, group: s.group })),
      })),
      /** 待机席位全表（与原表同源）。 */
      standby_seats: HUB_STANDBY_SEATS.map((s) => ({ ...s })),
      /**
       * 五道确认站点：谁确认、走哪条判据、放行哪一跳。
       *
       * ★ 归因更正（2026-10-14）：第③道的 `gate` 改成了**真实存在的判据名**。
       *   改前写的是 `hub_station_test_confirm` —— `lib/store.js` 的 `checkPrecondition`
       *   里**没有这个 case**（它只认 `hub_station_need_agree` / `hub_station_diagram_confirm` /
       *   `hub_station_review_confirm` 三个站点闸）。第③道真正的落点是状态机上
       *   `dispatch_reviewer → ready_review` 挂的那枚 guard **`dispatch_reviewer_gate`**
       *   （`lib/states.js:396` → `lib/store.js:2444-2449`，内部就是
       *   `hubStationGate(task, HUB_STATIONS.TEST_CONFIRM)`）。
       *   ★ **只改名字，判据行为一个字节没动。**
       */
      stations: [
        { n: 1, station: HUB_STATIONS.NEED_AGREE, zh: '需求分析结果 → 主管同意', confirmers: [...(HUB_STATION_CONFIRMERS[HUB_STATIONS.NEED_AGREE] ?? [])], is_confirm_station: (HUB_STATION_CONFIRMERS[HUB_STATIONS.NEED_AGREE] ?? []).length > 0, gate: 'hub_station_need_agree', advances: 'supervisor_agree_need' },
        { n: 2, station: HUB_STATIONS.DIAGRAM_CONFIRM, zh: '架构图 → 主管确认是否满足要求', confirmers: [...(HUB_STATION_CONFIRMERS[HUB_STATIONS.DIAGRAM_CONFIRM] ?? [])], is_confirm_station: (HUB_STATION_CONFIRMERS[HUB_STATIONS.DIAGRAM_CONFIRM] ?? []).length > 0, gate: 'hub_station_diagram_confirm', advances: 'supervisor_confirm_diagram', redraw_budget: HUB_DIAGRAM_REDRAW_BUDGET, escalate_on_exhaust: 'human_request（走既有的两级梯）' },
        { n: 3, station: HUB_STATIONS.TEST_CONFIRM, zh: '测试通过 → 主管 + 需求位**双确认**', confirmers: [...(HUB_STATION_CONFIRMERS[HUB_STATIONS.TEST_CONFIRM] ?? [])], is_confirm_station: (HUB_STATION_CONFIRMERS[HUB_STATIONS.TEST_CONFIRM] ?? []).length > 0, gate: 'dispatch_reviewer_gate', advances: 'dispatch_reviewer' },
        { n: 4, station: HUB_STATIONS.REVIEW_CONFIRM, zh: '审核通过 → 主管 + 需求位**双确认**', confirmers: [...(HUB_STATION_CONFIRMERS[HUB_STATIONS.REVIEW_CONFIRM] ?? [])], is_confirm_station: (HUB_STATION_CONFIRMERS[HUB_STATIONS.REVIEW_CONFIRM] ?? []).length > 0, gate: 'hub_station_review_confirm', advances: 'close' },
        /**
         * ★★ 第⑤道：**如实标明"它不是确认站点"**（本单第 2 步要求③，二选一取这一支）。
         *
         * 理由（依据用户原话，不是我的偏好）：
         *   用户那句是「无问题提交给主管和需求，**确认后**提交主对话→用户收到结果」——
         *   句中的"确认"修饰的是**提交主对话之前**那一步，也就是**第④道**
         *   （审核通过 → 主管+需求位双确认）；而第⑤道是「**提交主对话 → 用户收到结果**」
         *   本身，即**交付**那一步。
         *   ★ 判据上的形状也一致：它**没有确认方**（`HUB_STATION_CONFIRMERS` 里没有它），
         *     所以 `station_confirm` 的 station 枚举里也没有它 ——
         *     一份"第⑤道的确认记录"是**不存在**的东西（`validateStationConfirm` 会拒）。
         *   ⇒ 于是"五道站点"里只有**四道**是确认闸门；第⑤道是**交付站**。
         *     把它硬塞进确认表反而会造出第五份可以伪造的确认记录 —— 那是放宽，不是补齐。
         */
        {
          n: 5,
          station: HUB_STATIONS.CLOSEOUT,
          zh: '主对话关单并交付用户',
          confirmers: [],
          is_confirm_station: false,
          gate: 'close_gates',
          advances: 'close',
          role: 'delivery（交付站，**不是**确认闸门）',
          why_not_a_confirm_station:
            '用户原话里的"确认"落在第④道（主管+需求确认之后**才**提交主对话）；第⑤道是"提交主对话 → 用户收到结果"这一步本身。' +
            '它没有确认方、也不产出确认记录 —— `station_confirm` 的 station 枚举里没有 closeout，交一份会被 `handoff:validateStationConfirm` 拒。',
        },
      ],
      /**
       * ★★ **「否掉」的四条回边**（T-20261011-56a37e 补齐：用户原话的下半条分支）。
       *
       * 用户原话里明写「**如果同意**…**如果否掉**…」—— 两条分支都要有。
       * 补之前：② 道有回边（架构位重画），①③④ 三道**没有** ——
       * 状态机上从 `supervising` / `ready_review` / `passed` 各只有一条出边，
       * 且那条都要求"确认方点头" ⇒ 主管在那三站说"不满足"时无路可走（只剩 block / cancel）。
       *
       * ★ 全部**派生自真实的 `TRANSITIONS` 表**（`from` / `to` / `by` / `guard` 逐字取自表），
       *   不手抄 —— 于是"导出说的"与"判据做的"不可能漂移。
       * ★ 表格里四条并排放在一起，**同构性是可见的**：同样的事件形状（一条表项）、
       *   同样的 `by: [supervisor]`、同样的"限 1 次 ⇒ 升人工"、同样落到 `hub.*` 账本与审计。
       * ★ 两条口径差异**如实标出**（不藏着）：
       *   · `evidence_record_required`：①③④ = true（否掉必须先落一份带原因与证据的
       *     `station_confirm{decision:'ng'}`，否则回边过不去）；② = false（刻意保持原样）。
       *   · `budget_field`：①③④ 计在 `task.hub.station_rejects[station]`；② 计在 `task.hub.diagram_redraws`。
       */
      reject_edges: [
        ...Object.entries(HUB_STATION_REJECT_EVENTS).map(([st, ev]) => ({
          station: st,
          event: ev,
          from: TRANSITIONS.find((t) => t.event === ev)?.from ?? null,
          to: TRANSITIONS.find((t) => t.event === ev)?.to ?? null,
          to_zh: STATE_LABEL[TRANSITIONS.find((t) => t.event === ev)?.to] ?? null,
          by: [...(TRANSITIONS.find((t) => t.event === ev)?.by ?? [])],
          guard: TRANSITIONS.find((t) => t.event === ev)?.guard ?? null,
          record_kind: 'station_confirm',
          record_decision: 'ng',
          evidence_record_required: true,
          budget: HUB_STATION_REJECT_BUDGET,
          budget_field: `task.hub.station_rejects.${st}`,
          escalate_on_exhaust: 'human_request（走既有的两级梯）',
        })),
        {
          station: HUB_STATIONS.DIAGRAM_CONFIRM,
          event: 'supervisor_reject_diagram',
          from: TRANSITIONS.find((t) => t.event === 'supervisor_reject_diagram')?.from ?? null,
          to: TRANSITIONS.find((t) => t.event === 'supervisor_reject_diagram')?.to ?? null,
          to_zh: STATE_LABEL[TRANSITIONS.find((t) => t.event === 'supervisor_reject_diagram')?.to] ?? null,
          by: [...(TRANSITIONS.find((t) => t.event === 'supervisor_reject_diagram')?.by ?? [])],
          guard: TRANSITIONS.find((t) => t.event === 'supervisor_reject_diagram')?.guard ?? null,
          record_kind: 'diagram_rework',
          record_decision: null,
          evidence_record_required: false,
          budget: HUB_DIAGRAM_REDRAW_BUDGET,
          budget_field: 'task.hub.diagram_redraws',
          escalate_on_exhaust: 'human_request（走既有的两级梯）',
        },
      ],
      /** ★ 有确认方的站点 = 真的确认闸门（派生；`closeout` 不在其中）。 */
      confirm_stations: Object.keys(HUB_STATION_CONFIRMERS),
      /** ★ 明确列出"**不是**确认站点"的那些（第⑤道）。 */
      not_confirm_stations: [HUB_STATIONS.CLOSEOUT],
      /**
       * ★★ **②b / ②c 两个交接确认点**（P0-1：用户新口径第 7~8 跳）。
       *
       * 用户原话：「架构agent完成后发给主管agent，**主管agent转交需求agent**，
       *   **需求agent确认后**递交主管agent**二次确认**，**无问题后**将架构agent
       *   **递交计划agent**」——
       * 也就是在「架构图完成」与「交计划」之间还有**两道**确认点。
       *
       * 【为什么单开一栏、而不是并进 `stations`】
       *   `stations` 是**用户原话里那五道**（①②③④⑤）的登记表，它的条目数被既有自测
       *   逐字钉住（`gate-states-check` 的 `stations.length === 5`、
       *   `station-reject-check` 的 `confirm_stations` = 那四道）。
       *   往 `stations` 里塞两条会**改掉既有判据的期望值** —— 本单硬约束明令禁止。
       *   所以这里**另开一栏、形状相同**：同样给出 `is_confirm_station` 与**理由**，
       *   同样给判据名与放行哪一跳；而它们与五道站点**共用同一套判据体**
       *   （`hubStationGate` / `store.checkPrecondition` / `station_confirm` 交接物 /
       *   `audit.jsonl` 的 `transition:<事件名>`）—— 是"同一套机制的另一栏登记"，不是第二套机制。
       *
       * ★ 归因（判据落在哪）：`checkPrecondition` 的
       *   `hub_station_arch_need_confirm`（②b）与 `hub_station_arch_reconfirm`（②c）两枚判据，
       *   分别挂在 `need_confirm_diagram` 与 `supervisor_reconfirm_diagram` 两条表项上。
       */
      handoff_confirmations: HUB_HANDOFF_CONFIRM_ORDER.map((st, i) => {
        const confirmers = [...hubConfirmersOf(st)]
        return {
          n: `②${i === 0 ? 'b' : 'c'}`,
          station: st,
          zh: st === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ? '架构图 → 需求位确认' : '架构图 → 主管**二次**确认',
          confirmers,
          is_confirm_station: confirmers.length > 0,
          why: st === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM
            ? '用户原话：「主管agent**转交需求agent**，**需求agent确认后**递交主管agent二次确认」—— 需求位确认的是**同一份架构图**（目标 = architecture_diagram 的 handoff_id，换图即作废）。'
            : '用户原话：「需求agent确认后递交主管agent**二次确认**，**无问题后**将架构agent递交计划agent」—— 它是**唯一**的唤醒点 B：到这一刻计划位才到点开工（产物面判据同源）。',
          gate: st === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ? 'hub_station_arch_need_confirm' : 'hub_station_arch_reconfirm',
          advances: HUB_HANDOFF_CONFIRM_EVENTS[st],
          to: TRANSITIONS.find((t) => t.event === HUB_HANDOFF_CONFIRM_EVENTS[st])?.to ?? null,
          to_zh: STATE_LABEL[TRANSITIONS.find((t) => t.event === HUB_HANDOFF_CONFIRM_EVENTS[st])?.to] ?? null,
          by: [...(TRANSITIONS.find((t) => t.event === HUB_HANDOFF_CONFIRM_EVENTS[st])?.by ?? [])],
          record_kind: 'station_confirm',
          record_decision: 'ok',
          target: 'architecture_diagram 的最新一份 handoff_id（与第②道**同一个目标**）',
          order: `${i + 1} / ${HUB_HANDOFF_CONFIRM_ORDER.length}（顺序由状态机保证：表上不存在 arch_confirm → standby_plan 的近路）`,
        }
      }),
      /** ★ 入口面（P0-1）：**主对话把任务递给主管**的那条边 —— 凭什么放行、激活在哪一层。 */
      entry: {
        event: 'handoff_to_supervisor',
        by: [...(TRANSITIONS.find((t) => t.event === 'handoff_to_supervisor')?.by ?? [])],
        guard: TRANSITIONS.find((t) => t.event === 'handoff_to_supervisor')?.guard ?? null,
        /**
         * 五条判据（同时成立才放行）—— 这就是"主对话发起时依据什么"的答案，
         * 判据体在 `store.checkPrecondition` 的 `main_handoff_to_supervisor`。
         */
        criteria: [
          '调用方是 main（状态机 by 名单；pipeline_transition 本来只给 main / human）',
          '状态 = pending（待分配）—— 流程最初那一刻',
          'roster === null（还没有角色清单）',
          'handoffs.length === 0（活儿还没开工）',
          'hub.entry 不存在（递单是一次性动作）',
        ],
        /** ★ "枢纽必须激活在哪一层"：**最外层**（待分配这一层），一旦有进展即永久关闭。 */
        activation_layer: 'pending（待分配）—— 零工作量的新单；任何状态推进 / 交接物 / 角色清单都会关掉这个入口',
        effect: 'task.hub.entry = {by, at, via, note}（**不**置 enabled，不改状态）—— 发起仍是主管的动作',
        closes_when: '状态离开 pending、或产出第一份交接物、或产出角色清单、或已递过一次',
        dispatch_window: '递单之后、仍在 pending 时，pipeline_dispatch 的引导步白名单**只**放 supervisor 这一席（其余角色一个都没放宽）',
      },
      /** 必须双确认的站点（派生，不手抄）。 */
      dual_stations: [...HUB_DUAL_STATIONS],
      /** 双确认的**形态五要素**（判据里的原话，供钩子层复读）。 */
      dual_confirm_shape: [
        '两份交接物，from_role 分别落在 confirmers 的不同角色上（**由令牌决定，payload 自述不算**）',
        '两份都绑定**同一个 artifact_version**',
        '两份都在**最近一次打回之后**（打回即作废）',
        '缺任一份 ⇒ 目标状态不可达，拒绝原文**指名还缺谁**',
        '第③道与第④道**不得复用同一份确认记录**（station 字段写死在哪一站）',
      ],
      /**
       * 「待机期不许抢跑」的产物面三条判据（安全预审阻断项 B3 的原话）。
       *
       * ★ 符号名更正（2026-10-14）：文件名写作 **`hubStandbyBlocksWrite`** ——
       *   定义在 `lib/guard.js:1705-1712`，**唯一的调用点**在 `:809-823`（文件面：
       *   待机席位写自己目录的报告）。
       *   改前写的是 `hubStandbyProductGate`，**`guard.js` 里没有这个符号**。
       *   ⚠️ 下面第 3 条（测试面）的执法在 `lib/guard.js:1392-1415`，是**另一段内联判据**
       *   （读 `task.hubEnabled` / `task.devDelivered`），**不调用** `hubStandbyBlocksWrite` ——
       *   两条判据同族但不同源，别把它们当成一个函数。
       *   ★ **只改名字，判据行为一个字节没动。**
       */
      standby_product_gates: [
        '交接物面：待机席位提交自己那一类产物（design / plan）⇒ store:checkHandoffAgainstState 拒',
        '文件面：待机席位写自己目录的报告 ⇒ guard:hubStandbyBlocksWrite 拒',
        '测试面：编写交付（dev_submitted）之前 tester 跑任何测试 ⇒ guard:hubStandbyBlocksWrite 拒',
      ],
      /** 测试提前知情的载体与边界。 */
      prebrief: {
        kind: 'prebrief',
        from: 'planner',
        to: 'tester',
        before: 'dev_to_test（编写交付之前）',
        must_not_contain: ['patch_or_code', 'change_note', 'selftest_result', 'change_manifest', 'run_commands', 'test_cases', 'execution_result', 'pass_evidence', 'failure_logs', 'verdict', 'test_report'],
        must_not_start_before: 'dev_submitted',
      },
      /** 架构图前置的硬序：表上不存在的那条边（判据 = 它不存在）。 */
      diagram_first: {
        forbidden_edge: 'analyzing → planning',
        preplan_states: ['arch_drawing', 'arch_confirm'],
        legacy_states: ['ready_test', 'testing', 'ready_review', 'reviewing', 'passed'],
        gate: 'checkHandoffAgainstState:HUB_DIAGRAM_FIRST',
      },
      /** 枢纽的启用方式（**不是**默认全局打开 —— 见 R9 的说明与 README）。 */
      activation: {
        by: '主管位的发起动作（pipeline_supervise action=initiate）',
        effect: 'task.hub.enabled = true；此后该任务的**五道站点 + ②b/②c 两个交接确认点**全部是硬闸门',
        legacy: '未激活的任务走既有链，一个字节未变（回归保护，不是放宽）',
        installs_supervisor_by: 'B 单 T-20261011-5a871c 的名单四槽面（`no_slot_roles` 里的 supervisor）',
      },
    },
    /**
     * ★★ **孤儿单自恢复面**（2026-10-14 的只读导出）。
     *
     * 为什么要有这一块：本条的验收口径是「凡声称已实现，必须指出**判据落在哪条拒绝或
     * 哪个只读导出上**」。孤儿自恢复**没有拒绝面**（它不拦任何人 —— 它只是"自己再去叫一次"），
     * 所以判据只能落在**只读导出**上，这里就是那一个：
     *   · 判词有哪几种、各自由什么判据触发（`criteria`）；
     *   · 什么形状**不算**孤儿（`skip_reasons` —— 反例测试断言的就是这些字符串）；
     *   · 重投走哪条通道、会不会建新席位、会不会改状态（三个布尔字段，**写死在这里**）。
     *
     * ★ 全部**派生自 `lib/orphan.js` 的真实常量**（`orphanCatalog()`），不手抄。
     */
    orphan_rescue: (() => {
      const c = orphanCatalog()
      return {
        verdict_kinds: c.verdict_kinds,
        orphan_kinds: c.orphan_kinds,
        /** 判定窗 / 扫描间隔 / 失败退避 / 重投上限（毫秒与次数；与 `config.js` 默认值同源）。 */
        grace_ms: c.grace_ms,
        sweep_ms: c.sweep_ms,
        redeliver_backoff_ms: c.redeliver_backoff_ms,
        max_redeliver_attempts: c.max_redeliver_attempts,
        /** 允许判孤儿的非终态（含机制阻塞；**人工阻塞不算**）。 */
        eligible_states: c.eligible_states,
        /** 正常闲置（等人 / 等澄清）—— 这两处不判。 */
        idle_states: c.idle_states,
        terminal_states: c.terminal_states,
        criteria: c.criteria,
        skip_reasons: c.skip_reasons,
        redeliver_channel: c.redeliver_channel,
        /** 判据全落在纯函数上（不读盘、不写盘、不抛）—— 可离线复算。 */
        judge: 'orphan:orphanVerdict / orphan:orphanCandidate（纯函数）',
        runtime: 'orphan:createOrphanRescue（周期扫描；判据不在这里，只在这里投递）',
        audit_actions: c.audit_actions,
        /** ★★ 三条硬边界（断言级，不是形容词）。 */
        creates_new_seats: c.creates_new_seats,
        changes_task_state: c.changes_task_state,
        writes_task_json: c.writes_task_json,
      }
    })(),
    unmapped,
  }
}
/**
 * 把清单渲染成人能读的文本（工具摘要用）。
 * @param {object} [m]
 */
export function renderBoundaryManifest(m = boundaryManifest()) {
  const L = []
  L.push(`dsh-pipeline 边界清单（机器可读 · version ${m.version}）`)
  L.push('')
  L.push(`★ 总原则：${m.principle}`)
  L.push('')
  L.push(`角色（${m.roles.length} 个）—— writes 与守门认的类别必须一致：`)
  for (const r of m.roles) {
    L.push(
      `  ${r.id.padEnd(12)} ${String(r.writes).padEnd(9)} → ${String(r.write_class).padEnd(9)}` +
        `　读源码：${r.can_read_source ? '可以' : '**不行**'}　跑测试：${r.can_run_tests ? '可以' : '**不行**'}`,
    )
  }
  L.push('')
  L.push(`规则（${m.rules.length} 条，全部 class=a 已判据化）：`)
  for (const r of m.rules) L.push(`  [${r.id}] ${r.zh}\n        判据：${r.enforce}`)
  L.push('')
  L.push(`★ 判据化不了的（${m.advisory_limits.length} 条，**如实列出，不假装被执法**）：`)
  for (const x of m.advisory_limits) L.push(`  [${x.id}] ${x.zh}\n        ${x.why}`)
  // ★★ 主管枢纽面（T-20261011-56a37e）：只读导出的文字形态 —— 与 JSON 同源，不手抄。
  const hub = m.supervisor_hub
  L.push('')
  L.push('★ 主管枢纽（T-20261011-56a37e）—— 只读导出：')
  L.push(`  发起方：${hub.initiator_roles.join(' / ')}（事件 ${hub.initiate_event}，工具 ${hub.initiate_tool}）`)
  L.push('  唤醒点：')
  for (const wp of hub.wake_points) L.push(`    · ${wp.wake_point} ⇒ ${wp.seats.map((s) => `${s.role}(${s.group})`).join(' / ')}`)
  L.push('  五道站点（用户原话 ①②③④⑤）：')
  for (const st of hub.stations) {
    L.push(`    ${st.n}. ${st.zh}　确认方：${st.confirmers.length > 0 ? st.confirmers.join(' + ') : '（关单那一刻）'}　判据：${st.gate}`)
  }
  // ★★ P0-1：两个交接确认点（②b / ②c）—— 与五道站点**同一个形状**，只是不占那五道的号。
  L.push(`  ②b/②c 交接确认点（架构图 → 交计划位之前；用户新口径第 7~8 跳）：`)
  for (const st of hub.handoff_confirmations) {
    L.push(`    ${st.n}. ${st.zh}　确认方：${st.confirmers.join(' + ')}　判据：${st.gate} ⇒ ${st.advances}（到 ${st.to_zh}）`)
  }
  L.push(`  ⇒ 确认点合计：五道站点里的 ${hub.confirm_stations.length} 道 + ②b/②c 两道 = ${hub.confirm_stations.length + hub.handoff_confirmations.length} 道（第⑤道是**交付站**，不是确认点）`)
  L.push('')
  L.push(`  入口（P0-1）：${hub.entry.event}（by ${hub.entry.by.join(' / ')}，判据 ${hub.entry.guard}）`)
  L.push(`    激活在哪一层：${hub.entry.activation_layer}`)
  L.push(`    关掉的条件：${hub.entry.closes_when}`)
  L.push(`    派活窗口：${hub.entry.dispatch_window}`)
  L.push(`  双确认站点：${hub.dual_stations.join(' / ')}`)
  L.push(`  架构图前置：表上不存在的边 = ${hub.diagram_first.forbidden_edge}（判据 ${hub.diagram_first.gate}）`)
  L.push(`  测试提前知情：${hub.prebrief.kind}（${hub.prebrief.from} → ${hub.prebrief.to}，必须早于 ${hub.prebrief.before}）`)
  // ★★ 孤儿单自恢复（2026-10-14）：只读导出的文字形态 —— 与 JSON 同源，不手抄。
  const orph = m.orphan_rescue
  L.push('')
  L.push('★ 孤儿单自恢复（席位被切断 ⇒ 自己意识到 + 自己重新投递）—— 只读导出：')
  L.push(`  判词：${orph.verdict_kinds.join(' / ')}（其中孤儿 = ${orph.orphan_kinds.join(' / ')}）`)
  L.push(`  判定窗 ${Math.round(orph.grace_ms / 60000)} 分钟 · 扫描每 ${Math.round(orph.sweep_ms / 60000)} 分钟 · 失败退避 ${Math.round(orph.redeliver_backoff_ms / 60000)} 分钟 · 同一身份最多重投 ${orph.max_redeliver_attempts} 次`)
  L.push(`  可判状态：${orph.eligible_states.join(' / ')}（人工阻塞与 ${orph.idle_states.join(' / ')} **不判**）`)
  L.push('  判据：')
  for (const c of orph.criteria) L.push(`    · ${c}`)
  L.push(`  不判的原因（反例就断言这些）：${orph.skip_reasons.join(' / ')}`)
  L.push(`  重投通道：${orph.redeliver_channel}`)
  L.push(`  ★ 不建新席位=${orph.creates_new_seats ? '否' : '**是**（不建）'} · 不改任务状态=${orph.changes_task_state ? '否' : '**是**（不改）'} · 不写 task.json=${orph.writes_task_json ? '否' : '**是**（不写）'}`)
  L.push(`  留痕动作：${orph.audit_actions.join(' / ')}（落 .pipeline/<任务>/audit.jsonl，只追加）`)
  if (m.unmapped.length > 0) {
    L.push('')
    L.push(`⚠ 漂移告警：有 ${m.unmapped.length} 个角色的 writes 取值守门认不出：`)
    for (const u of m.unmapped) L.push(`  · ${u.role}（writes=${u.writes}）`)
  } else {
    L.push('')
    L.push('✓ 无漂移：角色表里的每个 writes 取值，守门都认识（文档与代码逐字节一致）。')
  }
  L.push('')
  L.push('（这份清单是给**别的执法层**复用的：DSH 层的 UserPromptSubmit / PreToolUse 钩子')
  L.push('  不需要读本插件源码，读这份 JSON 就能知道"谁、什么边界、命中哪条判据"。）')
  return L.join('\n')
}
