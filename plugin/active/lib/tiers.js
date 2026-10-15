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

import { DEFAULT_WRITER_LAYERS, LAYER_PATTERN, MAX_WRITER_SEATS, ROLE, SEPARATION_ROLES, SINGLE_SEAT_LAYER, seatId } from './roles.js'
import { isInside, pathKey, stableStringify, toAbsolute, toStringArray } from './util.js'
import { buildRelayPolicy } from './context.js'
import { writeClassOf } from './guard.js'
import { createHash } from 'node:crypto'
// ★★ 用户第 2 件（行数纪律）：四槽那一整段搬进 `lib/tiers/roster-slots.js`。
//    本文件里 `buildRoster` 要**调用** `buildRosterSlots`、`compareDispatchSlots` 与
//    `validateRoster` 要用 `slotKeyOf` / `ROSTER_SLOT_KEYS` —— 所以除了下面的 re-export，
//    这里还得**真的 import** 一次（只 re-export 的话它们在模块作用域里不存在）。
import { buildRosterSlots, slotKeyOf, ROSTER_SLOT_KEYS } from './tiers/roster-slots.js'

/**
 * 分档表。`execution` 是**执行角色**（不含主对话、需求分析、计划）。
 * `total` 是含主对话 + 需求分析 + 计划（若独立）的独立对话总数。
 *
 * ★ 本轮改动：
 *   · L1+ 的独立对话多了一个 —— 需求分析与**计划**现在是两个角色（原先挤在一个
 *     名为「需求分析/编排判断」的角色里）。所以 L1 6→7、L2 8→9、L3 9→10、
 *     L4 10→11、L5 12→13。L0 不变（两个角色都由规则引擎承担，仍是 4 个对话）。
 *   · `maxWriters`：3 → **6**（用户拍板的上槛），且 L1/…/L5 都能用到上限，
 *     因为**席位数由层数决定** —— 层多的项目就该多派席位（见 buildWriters）。
 *     L0 仍是 1：极简脚本没有分层的余地。
 *
 * @type {Record<string, {tier:string, zh:string, execution:string[], orchestrator:'rule-engine'|'separate', total:number, trigger:string}>}
 */
export const TIERS = {
  L0: {
    tier: 'L0',
    zh: '极简脚本',
    execution: [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER],
    maxWriters: 1,
    orchestrator: 'rule-engine',
    total: 4,
    trigger: '单文件 / 单函数级改动，无外部依赖、无安全面、无持久化、无并发。',
  },
  L1: {
    tier: 'L1',
    zh: '普通功能',
    execution: [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHIVIST],
    maxWriters: 3,
    orchestrator: 'separate',
    total: 7,
    trigger: '有明确功能边界，但涉及多文件、外部依赖、配置、接口变更中的任意一项。',
  },
  L2: {
    tier: 'L2',
    zh: '中大型',
    execution: [ROLE.ARCHITECT, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 9,
    trigger: '跨模块/跨服务、需要架构决策、接口契约要冻结、迁移或兼容性要求。',
  },
  L3: {
    tier: 'L3',
    zh: '安全敏感',
    execution: [ROLE.ARCHITECT, ROLE.SECURITY, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 10,
    trigger: '碰鉴权/凭证/权限/加密/外部输入边界/合规要求。',
  },
  L4: {
    tier: 'L4',
    zh: '生产上线',
    execution: [ROLE.ARCHITECT, ROLE.SECURITY, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.RELEASE, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 11,
    trigger: '要真的动生产环境：上线、灰度、数据迁移、运维变更。',
  },
  L5: {
    tier: 'L5',
    zh: '特殊要求',
    execution: [
      ROLE.ARCHITECT,
      ROLE.SECURITY,
      ROLE.WRITER,
      ROLE.TESTER,
      ROLE.REVIEWER,
      ROLE.DIAGRAMMER,
      ROLE.ARCHIVIST,
      ROLE.RELEASE,
      ROLE.DOCS,
      ROLE.PERFORMANCE,
    ],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 13,
    trigger: '对外交付/有文档与性能硬指标；或出现争议需要仲裁角色。按需从扩展池里挑，不必全上。',
  },
}

/** 分档从低到高，用于"只能往上调"的比较。 */
export const TIER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']

/** L5 的扩展池：需要哪个加哪个，加了要在 reason 里说明为什么。 */
export const L5_EXTENSION_POOL = [ROLE.DOCS, ROLE.PERFORMANCE, ROLE.ARBITER, ROLE.SECURITY, ROLE.RELEASE, ROLE.ARCHITECT]

/** 档位数值比较：a 是否 >= b。 */
export function tierAtLeast(a, b) {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b)
}

/** 两档里更高的那个（用于"只能往上调"）。 */
export function maxTier(a, b) {
  return tierAtLeast(a, b) ? a : b
}

// ---------------------------------------------------------------------------
// 确定性规则引擎
// ---------------------------------------------------------------------------

/**
 * 平凡性判据（L0 的必要条件）。**宁严勿松** —— 这是"复杂需求不漏配"的第一道闸。
 *
 * 判据全部是否定式的：只要命中任意一条「不平凡信号」，就不许自批 L0。
 * 反过来，只有**全部**平凡性条件成立才返回 L0。
 *
 * 设计意图：漏配（复杂任务只上 4 个对话）的代价远高于超配。所以这里刻意
 * 偏向"不给 L0"。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 这里踩过一个真坑，写下来免得再犯：
 *   最初把 ASCII 与中文关键词写在同一个正则里，形如
 *   `/\b(api|http|接口|服务端)\b/i`。结果**中文关键词一条都匹配不上** ——
 *   JS 的 `\b` 是 `\w`(=[A-Za-z0-9_]) 与 `\W` 之间的边界，而中文字符属于 `\W`，
 *   「单」和「接」之间根本没有边界可谈，`\b接口\b` 永远是 false。
 *   于是"给订单**接口**加参数"被判成了 L0 极简脚本 —— 正是需求原文最担心的
 *   **复杂需求漏配**。
 *
 *   现在拆成两段：`ascii` 带 `\b`（避免 `api` 命中 `rapid`），`cjk` 不带边界
 *   （中文本来就没有词边界，多认一点是安全的方向）。自测里"普通功能→L1"这条
 *   就是给这个坑留的回归用例。
 */
const COMPLEXITY_SIGNALS = [
  {
    ascii: /\b(auth|oauth|jwt|token|credential|secret|password|apikey|api[-_ ]?key)\b/i,
    cjk: /(加密|鉴权|认证|授权|口令|密钥|凭证|权限)/,
    tier: 'L3',
    why: '涉及鉴权/凭证/权限面',
  },
  {
    ascii: /\b(security|compliance|gdpr|hipaa|injection|xss|csrf)\b/i,
    cjk: /(审计|合规|安全|注入|越权|脱敏)/,
    tier: 'L3',
    why: '涉及安全/合规',
  },
  {
    ascii: /\b(prod|production|deploy|release|rollout|canary|launch)\b/i,
    cjk: /(上线|发布|灰度|生产环境|生产|回滚|运维)/,
    tier: 'L4',
    why: '涉及生产上线/发布',
  },
  {
    ascii: /\b(migrat\w*|schema[- ]change|breaking[- ]change)\b/i,
    cjk: /(迁移|兼容性|向下兼容|破坏性变更)/,
    tier: 'L2',
    why: '涉及迁移/兼容性',
  },
  {
    ascii: /\b(architect\w*|refactor\w*|microservice\w*|distributed)\b/i,
    cjk: /(重构|架构|模块划分|接口契约|多服务|微服务|分布式|分层)/,
    tier: 'L2',
    why: '涉及架构决策',
  },
  {
    ascii: /\b(concurren\w*|parallel\w*|race[- ]condition|deadlock|mutex|transaction\w*)\b/i,
    cjk: /(并发|并行|竞态|死锁|加锁|事务)/,
    tier: 'L2',
    why: '涉及并发/事务',
  },
  {
    ascii: /\b(database|sql|postgres\w*|mysql|sqlite|redis|kafka|rabbitmq|mongo\w*)\b/i,
    cjk: /(数据库|消息队列|持久化|存储层|建表|索引)/,
    tier: 'L2',
    why: '涉及持久化/外部存储',
  },
  {
    ascii: /\b(performance|benchmark\w*|throughput|latency|profil\w*)\b/i,
    cjk: /(压测|性能|吞吐|延迟|耗时|优化)/,
    tier: 'L2',
    why: '涉及性能指标',
  },
  {
    ascii: /\b(api|http|https|grpc|webhook|rest|graphql|endpoint|server|client|frontend|backend)\b/i,
    cjk: /(接口|服务端|客户端|前端|后端|路由|中间件|请求|响应)/,
    tier: 'L1',
    why: '涉及接口/网络边界',
  },
  {
    ascii: /\b(dependenc\w*|library|libraries|package|npm|pnpm|yarn|third[- ]party|vendor)\b/i,
    cjk: /(第三方|依赖|引入|安装包|SDK)/i,
    tier: 'L1',
    why: '涉及外部依赖',
  },
  {
    ascii: /\b(multi[- ]?file|system[- ]wide|platform|framework|end[- ]to[- ]end|pipeline)\b/i,
    cjk: /(多个文件|多个模块|整套|系统级|平台|框架|全流程|端到端)/,
    tier: 'L1',
    why: '涉及多文件/系统级改动',
  },
  {
    ascii: /\b(config\w*|env\w*|dotenv|settings)\b/i,
    cjk: /(配置文件|配置项|环境变量|部署脚本|参数化)/,
    tier: 'L1',
    why: '涉及配置/环境',
  },
  {
    ascii: /\b(docs?|documentation|manual|readme|changelog)\b/i,
    cjk: /(文档|说明书|手册|使用说明)/,
    tier: 'L1',
    why: '涉及对外文档',
  },
]

/**
 * 平凡性上限：需求文本不得长过这个长度才允许 L0。
 * 写得越长 = 约束越多 = 越不平凡。这是最粗但很有效的一道。
 */
const L0_MAX_REQUIREMENT_CHARS = 240

/** 声明的验收标准条数上限（L0 才允许）。 */
const L0_MAX_ACCEPTANCE = 4

/**
 * 规则引擎：给出一档**建议**与被拒理由。
 *
 * @param {object} input
 * @param {string} input.requirement - 原始需求文本
 * @param {string[]} [input.acceptance] - 已知验收标准（可为空）
 * @param {string[]} [input.constraints] - 已知约束
 * @param {number} [input.expectedFiles] - 预期涉及文件数（不知道就别给）
 * @param {string} [input.defaultTier] - 拿不准时的兜底档（默认 L1）
 * @returns {{proposedTier:string, signals:Array<{tier:string,why:string,matched:string}>, l0Rejected:string|null, notes:string[]}}
 */
export function proposeTier(input = {}) {
  const requirement = String(input.requirement ?? '')
  const acceptance = Array.isArray(input.acceptance) ? input.acceptance.filter((s) => typeof s === 'string' && s.trim()) : []
  const constraints = Array.isArray(input.constraints) ? input.constraints.filter((s) => typeof s === 'string' && s.trim()) : []
  const defaultTier = TIER_ORDER.includes(input.defaultTier) ? input.defaultTier : 'L1'

  const haystack = [requirement, ...acceptance, ...constraints].join('\n')

  /** @type {Array<{tier:string,why:string,matched:string}>} */
  const signals = []
  for (const s of COMPLEXITY_SIGNALS) {
    const m = s.ascii.exec(haystack) ?? s.cjk.exec(haystack)
    if (m !== null) signals.push({ tier: s.tier, why: s.why, matched: String(m[0]).slice(0, 40) })
  }

  const notes = []
  let l0Rejected = null

  // --- L0 平凡性闸门（任一不满足就否掉 L0）---------------------------------
  if (requirement.trim().length > L0_MAX_REQUIREMENT_CHARS) {
    l0Rejected = `需求文本 ${requirement.trim().length} 字符 > L0 上限 ${L0_MAX_REQUIREMENT_CHARS} 字符（写得越长说明约束越多）`
  } else if (acceptance.length > L0_MAX_ACCEPTANCE) {
    l0Rejected = `验收标准 ${acceptance.length} 条 > L0 上限 ${L0_MAX_ACCEPTANCE} 条`
  } else if (constraints.length > 0) {
    l0Rejected = `声明了 ${constraints.length} 条约束条件（有约束就不是"极简脚本"）`
  } else if (signals.length > 0) {
    l0Rejected = `命中不平凡信号：${signals.map((s) => s.why).join('；')}`
  } else if (typeof input.expectedFiles === 'number' && input.expectedFiles > 1) {
    l0Rejected = `预期涉及 ${input.expectedFiles} 个文件 > 1`
  }

  let proposedTier
  if (l0Rejected === null) {
    proposedTier = 'L0'
    notes.push('未命中任何不平凡信号，允许自批 L0（4 个独立对话：主/编写/测试/审核）。')
  } else {
    notes.push(`L0 被否：${l0Rejected}`)
    // 取最严的那一条信号；没有信号就落到兜底档。
    let best = defaultTier
    for (const s of signals) best = maxTier(best, s.tier)
    proposedTier = best
    if (signals.length === 0) notes.push(`没有明确信号，落到兜底档 ${defaultTier}（宁高不低）。`)
  }

  return { proposedTier, signals, l0Rejected, notes }
}

/**
 * 由档位 + **计划 AI** 的结论，构造一份**角色清单（roster）**。
 *
 * 这是本插件所有"要几个 AI"回答的唯一出口。主对话拿到的永远是这份结构，
 * 而不是一个可以自由拼接的字符串数组。
 *
 * @param {object} input
 * @param {string} input.tier
 * @param {string} [input.reason] - 计划 AI 给出的理由（L1+ 必填）
 * @param {string} [input.judgedBy] - 谁做的判断：'rule-engine' | 'planner'
 * @param {string[]} [input.extraRoles] - 执行中申请追加的角色（已获复核批准）
 * @param {string[]} [input.removeRoles] - 执行中申请移除的角色（已获复核批准）
 * @param {boolean} [input.l0OrchestratorSeparate] - L0 是否也拆出独立编排对话
 * @param {number} [input.reworkBudget] - 打回预算（写进清单，供审核/测试读）
 * @returns {{ok:boolean, error?:string, roster?:object}}
 */
export function buildRoster(input = {}) {
  const tier = String(input.tier ?? '')
  if (!Object.hasOwn(TIERS, tier)) {
    return { ok: false, error: `未知档位 "${tier}"；合法值：${TIER_ORDER.join(' / ')}` }
  }
  const def = TIERS[tier]

  const extra = Array.isArray(input.extraRoles) ? input.extraRoles : []
  const removed = new Set(Array.isArray(input.removeRoles) ? input.removeRoles : [])

  // 三权分立不可拆：编写/测试/审核任意一个被移除都直接拒绝。
  for (const r of SEPARATION_ROLES) {
    if (removed.has(r)) {
      return { ok: false, error: `角色清单非法：不能移除三权分立角色「${r}」。编写/测试/审核必须同时在册。` }
    }
  }

  const orchestratorSeparate = def.orchestrator === 'separate' || input.l0OrchestratorSeparate === true

  /** @type {string[]} */
  const executionRoles = []
  for (const r of [...def.execution, ...extra]) {
    if (removed.has(r)) continue
    if (!executionRoles.includes(r)) executionRoles.push(r)
  }

  /** @type {Array<{role:string, phase:number, order:number}>} */
  const sequence = []
  let order = 0
  let phase = 0
  const pushPhase = (roles) => {
    phase += 1
    for (const r of roles) {
      // ★ A4 的数据面：order 是硬性次序；requires 是"开它之前必须先完成谁"。
      //   同一次 pushPhase 里的角色互为同层（可并行）⇒ requires 只指向前置层。
      const requires = [...new Set(sequence.map((x) => x.role))].filter((x) => x !== r)
      sequence.push({ role: r, phase, order: ++order, requires })
    }
  }

  // 顺序：需求分析 → 计划（分配）→ 咨询角色（架构/安全）→ 编写 → 测试 → 审核 → 发布/文档/性能
  //
  // ★ 本轮把「需求分析」与「计划」拆成两个阶段（原先是一个"编排判断"阶段）：
  //   需求分析先定"做什么"，计划再定"怎么切、给谁、什么次序"。顺序不能反 ——
  //   计划的存在意义就是**承接需求分析的结果**。
  if (orchestratorSeparate) pushPhase([ROLE.ORCHESTRATOR])
  if (orchestratorSeparate) pushPhase([ROLE.PLANNER])
  const advisory = executionRoles.filter((r) => r === ROLE.ARCHITECT || r === ROLE.SECURITY)
  const core = executionRoles.filter((r) => SEPARATION_ROLES.includes(r))
  const tail = executionRoles.filter((r) => !advisory.includes(r) && !core.includes(r))
  if (advisory.length > 0) pushPhase(advisory)
  pushPhase(core)
  if (tail.length > 0) pushPhase(tail)

  const conversations = [
    ROLE.MAIN,
    ...(orchestratorSeparate ? [ROLE.ORCHESTRATOR, ROLE.PLANNER] : []),
    ...executionRoles,
  ]

  // --- ★继任策略（编排授权；主对话只能在此范围内换班）-----------------------
  const builtRelay = buildRelayPolicy(input.relayPolicy)
  if (builtRelay.ok !== true) return { ok: false, error: builtRelay.error }

  // --- ★编写席位 ----------------------------------------------------------
  //
  // 只有 `writer` 在册时才谈席位。`max_writers` 由档位给（见 TIERS，≤6），
  // planner 按**层数**决定席位（`count === layers.length`）。
  // **count=1 是同一套机制的退化情形**：
  // 一条分区、层清单退化成 ['all']、范围是整棵项目根，与多席位走完全相同的校验与推进路径。
  let writers = null
  if (executionRoles.includes(ROLE.WRITER)) {
    const built = buildWriters(input.writers, def.maxWriters)
    if (built.ok !== true) return { ok: false, error: built.error }
    writers = built.writers
  }

  // --- ★四槽表（名单权威层）-------------------------------------------------
  //   四槽 = 权限档、内置模式、模型、推理等级，**四个平级字段**（不许打包成一个对象）。
  //   只读角色不派活 ⇒ 不落槽位、也不参与槽位校验（见 slotRoleNeedsDeclaration）。
  const builtSlots = buildRosterSlots(conversations, writers, {
    slots: input.slots,
    strictSlots: input.strictSlots === true,
  })
  if (builtSlots.ok !== true) return { ok: false, error: builtSlots.error }

  // ★ 缺省 = 清单里的席位会话数（**不含主对话**）：主对话是用户开的那一个，不是本名单派出去的；
  //   减掉它，'名单说 n 个、第 n+1 个就被拒'才严丝合缝（A3）。
  const defaultQuota = Math.max(1, conversations.filter((r) => r !== ROLE.MAIN).length)
  const quota = Number.isInteger(input.dispatchQuota) && input.dispatchQuota > 0 ? input.dispatchQuota : defaultQuota

  return {
    ok: true,
    roster: {
      tier,
      tier_zh: def.zh,
      trigger: def.trigger,
      orchestrator_mode: orchestratorSeparate ? 'separate' : 'rule-engine',
      /** ★继任策略（由计划 AI 给；主对话只能在此授权内执行换班）。 */
      relay_policy: builtRelay.ok === true ? builtRelay.policy : null,
      /** ★这一档允许的最大编写席位数。 */
      max_writers: def.maxWriters,
      /** ★本次实际采用的编写席位方案（由计划 AI 决定，主对话不能改）。 */
      writers,
      execution_roles: executionRoles,
      sequence,
      /** 独立对话总数（含主对话）。这是"要调用几个 AI"的正式答案。 */
      ai_count: conversations.length,
      conversations,
      /**
       * ★ **四槽表**：`<角色>`（非编写角色）或 `<角色>@<席位>` → { permission, mode, model, reasoning }，
       * 每槽形如 { value, declared, origin }。这就是"名单声明什么档、会话就该拿到什么档"的唯一出处。
       */
      slots: builtSlots.slots,
      /** ★ 四槽表的内容指纹（改一个字符就变）—— 留痕里的"依据名单版本"用它 + slots_version。 */
      slots_digest: createHash('sha256').update(builtSlots.digest, 'utf8').digest('hex'),
      /** ★ 四槽表的冻结时刻。 */
      slots_frozen_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      /**
       * ★ **本名单允许同时存在的会话数上限**（A3 的数据面）。
       * 未声明 ⇒ 缺省 = 清单里的独立对话数；它是上限，不是"要开这么多"。
       */
      dispatch_quota: quota,
      /** 编写+测试+审核这三位必须在册；这里显式回显，方便审计一眼看出没被拆。 */
      separation_ok: SEPARATION_ROLES.every((r) => executionRoles.includes(r)),
      reason: typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : '',
      judged_by: input.judgedBy === 'planner' ? 'planner' : 'rule-engine',
      rework_budget: Number.isInteger(input.reworkBudget) ? input.reworkBudget : 2,
      judged_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  }
}

/**
 * ★ 「什么时候该把编写拆成 2~3 个席位」的可执行信号。
 *
 * 这些信号给**规则引擎**用，产出的是**建议**（`recommendWriters`），
 * 最终仍由**计划 AI** 判断并把理由写进 `writers.reason`。
 * 理由：拆分涉及"接口冻没冻结""两块活是不是真的互不相干"这类判断，
 * 规则引擎只能数关键词，数不出这些。
 */
const WRITER_SPLIT_SIGNALS = [
  {
    ascii: /\b(multi[- ]?module|cross[- ]?module|parallel|independent)\b/i,
    cjk: /(跨模块|多模块|多个模块|可并行|互不相干|各自独立|两个子系统|三块)/,
    weight: 2,
    why: '涉及多个互不相干的模块',
  },
  {
    ascii: /\b(interface|contract|api[- ]?spec|freeze|frozen)\b/i,
    cjk: /(接口契约|接口已冻结|契约冻结|接口冻结|先定接口|接口先定)/,
    weight: 3,
    why: '接口/契约已明确（拆分的**前提条件**，权重最高）',
  },
  {
    ascii: /\b(frontend|backend|client|server|ui|cli|sdk|plugin)\b/i,
    cjk: /(前端.*后端|后端.*前端|客户端.*服务端|两个仓库|两个包)/,
    weight: 2,
    why: '天然可切成前后端/多包',
  },
  {
    ascii: /\b(large|big|sizeable|many files)\b/i,
    cjk: /(文件很多|文件数多|改动量大|工作量大|上百个文件|几十个文件)/,
    weight: 1,
    why: '改动量偏大',
  },
]

/** 超过这个文件数就建议拆分（编排也可以在请求里显式给 expectedFiles）。 */
const SPLIT_FILE_THRESHOLD = 8

/**
 * ★ 规则引擎对"编写该分几个席位"的建议。**只是建议**。
 *
 * @param {object} input
 * @param {string} input.requirement
 * @param {number} [input.expectedFiles] - 预期涉及文件数（不知道就别给）
 * @param {number} input.maxWriters - 本档上限
 * @returns {{suggested:number, signals:Array<{why:string}>, reason:string}}
 */
export function recommendWriters(input = {}) {
  const max = Number.isInteger(input.maxWriters) && input.maxWriters > 0 ? input.maxWriters : 1
  const haystack = String(input.requirement ?? '')

  const signals = []
  for (const s of WRITER_SPLIT_SIGNALS) {
    if (s.ascii.test(haystack) || s.cjk.test(haystack)) signals.push({ why: s.why, weight: s.weight })
  }
  const files = Number.isInteger(input.expectedFiles) ? input.expectedFiles : null
  if (files !== null && files > SPLIT_FILE_THRESHOLD) {
    signals.push({ why: `预期涉及 ${files} 个文件（阈值 ${SPLIT_FILE_THRESHOLD}）`, weight: 2 })
  }

  if (max <= 1) {
    return {
      suggested: 1,
      signals,
      reason:
        max === 1 && signals.length > 0
          ? `本档（maxWriters=1）不允许拆分，即使命中 ${signals.length} 条拆分信号也只能 1 个席位。`
          : '未命中拆分信号，1 个席位足够。',
    }
  }

  // 只有"接口已冻结"这类前提条件在场时，才敢加人 —— 没冻结接口就拆，
  // 两个席位会在边界上互相改，比一个人写还慢。
  const hasPrerequisite = signals.some((s) => s.weight >= 3)
  const score = signals.reduce((a, s) => a + s.weight, 0)
  let suggested = 1
  if (hasPrerequisite && score >= 3) suggested = Math.min(max, score >= 6 ? 3 : 2)
  else if (score >= 4) suggested = Math.min(max, 2)

  const reason =
    suggested === 1
      ? signals.length === 0
        ? '未命中拆分信号，1 个席位足够。'
        : `命中了 ${signals.length} 条弱信号（${signals.map((s) => s.why).join('；')}），但**接口尚未冻结** —— 没有冻结的接口就拆，两个席位会在边界上互相改，比一个人还慢。建议仍用 1 个席位。`
      : `命中 ${signals.length} 条信号（${signals.map((s) => s.why).join('；')}），且接口条件满足 ⇒ 建议 ${suggested} 个席位（本档上限 ${max}）。`

  return { suggested, signals, reason }
}

/**
 * ★ 「默认层清单够不够」的可执行建议（**只是建议**）。
 *
 * 默认三层是 接口 / 数据 / 处理。命中下面这些信号时，planner 可以考虑
 * 裁剪（把两层合成一层）或扩展（拆出更多层）。规则引擎只数关键词，
 * "这两块活是不是真的互不相干"仍然只能由 planner 判断。
 *
 * @param {object} input
 * @param {string} input.requirement
 * @param {number} [input.suggestedSeats] - `recommendWriters` 给的席位建议
 * @returns {{layers:string[], notes:string[]}}
 */
export function recommendLayers(input = {}) {
  const hay = String(input.requirement ?? '')
  const notes = []
  const layers = [...DEFAULT_WRITER_LAYERS]

  if (/(单文件|一个文件|单函数|一个函数|小脚本|simple script)/i.test(hay) && layers.length > 1) {
    notes.push('看起来是单文件/小脚本 ⇒ 层清单其实用不满，可以直接 count=1（单层 all，范围整棵项目根）。')
  }
  if (/(前端|界面|ui|页面|组件|frontend)/i.test(hay) && /(后端|服务端|接口|api|backend|server)/i.test(hay)) {
    notes.push('同时提到前端与后端 ⇒ 可在默认三层之外拆出「表现层/视图层」这类层（层 id 自定，例如 view）。')
  }
  if (/(迁移|migration|数据|表结构|schema|存量)/i.test(hay)) {
    notes.push('涉及数据/迁移 ⇒ 数据层与处理层的边界要写清（谁改表结构、谁改读写逻辑）。')
  }
  if (/(并发|并行|性能|吞吐|latency|压测)/i.test(hay)) {
    notes.push('涉及并发/性能 ⇒ 建议把"接口契约"冻结在接口层席位手里，否则两个席位会在边界上互相改。')
  }
  if (Number.isInteger(input.suggestedSeats) && input.suggestedSeats !== layers.length) {
    notes.push(`规则引擎给的是 ${input.suggestedSeats} 个席位，默认层清单是 ${layers.length} 层 —— 两者对不上时以**层数**为准（席位数由层数决定）：裁剪或扩展成 ${input.suggestedSeats} 层。`)
  }
  return { layers, notes }
}

/**
 * 校验并规整 planner 给出的编写席位方案。
 *
 * ★ 五条硬规则（都在这里执法，不靠文档）：
 *   ① `count` 必须在 1..maxWriters 之间（上限由档位给，档位上限 ≤ MAX_WRITER_SEATS=6）
 *   ② `partitions.length` 必须等于 `count`（声明几个席位就得给几条分区）
 *   ③ **分区范围不得重叠** —— 两个席位都声明能写同一个路径 = 允许两个人改同一个文件，
 *      那正是分区要避免的事。这里**直接拒**（而不是运行时警告），
 *      理由：运行时才发现重叠时，两边可能都已经写过了，那时再警告已经晚了。
 *   ④ ★本轮新增：**席位数由层数决定**（`count === layers.length`）——
 *      层清单给了就按层数定席位；同时给 count 又对不上 = 自相矛盾，直接拒。
 *   ⑤ ★本轮新增：每条分区必须带 **层 id**（`layer`）。
 *      ⚠️ 层**不替代** `scope_paths`：层说"负责哪一层"，路径说"能写哪里"。
 *      按层分工之后 `scope_paths` 照样逐席位必填 —— **越界写执法一条都没少**。
 *
 * count=1 仍是同一套机制的退化情形：层清单退化成单层 `all`（一个席位负责全部），
 * 走的是与多席位完全相同的校验路径（需求明文要求的不变量）。
 *
 * @param {any} raw
 * @param {number} maxWriters
 * @returns {{ok:true, writers:object} | {ok:false, error:string}}
 */
export function buildWriters(raw, maxWriters) {
  const max = Number.isInteger(maxWriters) && maxWriters > 0 ? maxWriters : 1

  // 没给 ⇒ 退化成 1 个席位，范围是整个项目根。**这就是单编写模式**，
  // 走的是与多席位完全相同的校验与推进路径（需求明文要求）。
  const w = raw !== null && typeof raw === 'object' ? raw : {}
  const rawLayers = Array.isArray(w.layers) ? w.layers.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0) : []
  const hasLayers = rawLayers.length > 0
  const declaredCount = Number.isInteger(w.count) ? w.count : null

  // ★ ④ 席位数由层数决定。
  let count
  if (hasLayers) {
    count = rawLayers.length
    if (declaredCount !== null && declaredCount !== count) {
      return {
        ok: false,
        error:
          `writers.count=${declaredCount} 与 layers 的层数(${count}) 对不上。\n` +
          '★ 本轮的规矩是**席位数由层数决定**（一个层一个席位）—— 两个都给就必须一致。\n' +
          `层清单：${rawLayers.join('、')}\n` +
          '为什么绑定：席位是"谁负责哪一块"的答案，层是"这块活怎么切"的答案；\n' +
          '两个各说各话时，"writer#3 到底管哪层"就没人答得出来。',
      }
    }
  } else {
    count = declaredCount ?? 1
    if (count > 1) {
      return {
        ok: false,
        error:
          `writers.count=${count} 但没有给 layers。\n` +
          '★ 多席位必须按**层**分工：请给 layers（层清单）与每条分区的 layer。\n' +
          `默认层清单：${DEFAULT_WRITER_LAYERS.join('、')}（接口层 / 数据层 / 处理层），可按项目裁剪或扩展。\n` +
          '只想要一个席位就不必给 layers（自动退化成单层 all，范围整棵项目根）。',
      }
    }
  }

  if (count < 1 || count > max) {
    return {
      ok: false,
      error:
        `编写席位数=${count} 超出本档允许范围 1..${max}。\n` +
        `本档最多 ${max} 个编写席位（档位表见 lib/tiers.js 的 maxWriters；硬上限 ${MAX_WRITER_SEATS}）。\n` +
        '要更多席位请先升档（升档只能由计划 AI 给出 tier 与 reason）。',
    }
  }
  if (count > MAX_WRITER_SEATS) {
    return { ok: false, error: `编写席位数=${count} 超过硬上限 ${MAX_WRITER_SEATS}。` }
  }

  // 层清单：多席位时就是 planner 给的那份；单席位时退化成 ['all']。
  const layers = count === 1 ? [SINGLE_SEAT_LAYER] : rawLayers
  for (const l of layers) {
    if (!LAYER_PATTERN.test(l)) {
      return {
        ok: false,
        error:
          `层 id「${l}」不合法（要求：小写字母开头，可含小写字母/数字/下划线/连字符，≤24 字符）。\n` +
          '层 id 是机器可读的标识，中文名请写进 deliverables 或 reason 里。',
      }
    }
  }
  if (new Set(layers).size !== layers.length) {
    return { ok: false, error: `层清单里有重复的层 id（${layers.join('、')}）—— 一个层只能有一个席位负责。` }
  }

  const rawParts = Array.isArray(w.partitions) ? w.partitions : []
  if (count > 1 && rawParts.length !== count) {
    return {
      ok: false,
      error:
        `席位数=${count}（= 层数 ${layers.length}）但你给了 ${rawParts.length} 条 partitions —— 声明几个席位就必须给几条分区，一条不能少。\n` +
        '每条分区要有：seat / role_id / layer / scope_paths[] / interface_owner / deliverables[]。',
    }
  }

  const partitions = []
  for (let i = 1; i <= count; i++) {
    const seat = seatId(i)
    const given = rawParts.find((p) => p?.seat === seat) ?? rawParts[i - 1] ?? null
    const scope = toStringArray(given?.scope_paths)
    const givenLayer = typeof given?.layer === 'string' ? given.layer.trim() : ''
    partitions.push({
      seat,
      role_id: ROLE.WRITER,
      index: i,
      total: count,
      // ★ 层：给了就用给的（但要与层清单对得上），没给就按层清单的顺序落位。
      layer: givenLayer.length > 0 ? givenLayer : layers[i - 1],
      // count=1 且没给范围 ⇒ 整棵项目根。这就是"退化情形"的具体含义。
      scope_paths: scope.length > 0 ? scope : count === 1 ? ['.'] : [],
      interface_owner: typeof given?.interface_owner === 'string' ? given.interface_owner : '',
      deliverables: toStringArray(given?.deliverables),
    })
  }

  // ★ ⑤ 层必须与层清单一一对上（顺序不强制，但不能多也不能少、不能重）。
  if (count > 1) {
    const used = partitions.map((p) => p.layer)
    const missing = layers.filter((l) => !used.includes(l))
    const extra = used.filter((l) => !layers.includes(l))
    if (missing.length > 0 || extra.length > 0 || new Set(used).size !== used.length) {
      return {
        ok: false,
        error:
          '分区里的 layer 与 layers 层清单对不上。\n' +
          `层清单：${layers.join('、')}\n` +
          `分区实际：${partitions.map((p) => `${p.seat}→${p.layer}`).join('、')}\n` +
          (missing.length > 0 ? `没人认领的层：${missing.join('、')}\n` : '') +
          (extra.length > 0 ? `不在层清单里的层：${extra.join('、')}\n` : '') +
          '一个层只能有一个席位负责，且每个层都必须有席位 —— 否则"这层谁写的"答不出来。',
      }
    }
  }

  for (const p of partitions) {
    if (p.scope_paths.length === 0) {
      return {
        ok: false,
        error:
          `席位 ${p.seat}（层 ${p.layer}）没有声明 scope_paths —— 多席位时每个席位都必须写清"我负责哪些路径"。\n` +
          '★ 按层分工**不取消**路径执法：层说明负责什么，路径说明能写哪里，两个都要。\n' +
          '没有范围就没法执法越界写入，分区也就白分了。',
      }
    }
  }

  // ③ 分区不得重叠（归一化后比较）
  //
  // ⚠️ 重叠不只是"两条写法完全相同"—— `src/a` 与 `src/a/b` 也是重叠：
  //    前者的范围**包含**后者，两个席位照样会写到同一个文件。
  //    第一版只比了相等，于是 `['src/a']` 与 `['src/a/b']` 被放行了。
  const claimed = []
  /** 归一化：`.` 表示整棵项目根，用一个空串哨兵表示（它包含一切）。 */
  const normScope = (raw) => {
    const s = String(raw ?? '').trim()
    if (s === '.' || s === './' || s === '') return ''
    return pathKey(toAbsolute('.', s))
  }
  const covers = (a, b) => a === '' || isInside(a, b)
  for (const p of partitions) {
    for (const raw of p.scope_paths) {
      const abs = normScope(raw)
      const hit = claimed.find((c) => covers(c.abs, abs) || covers(abs, c.abs))
      if (hit !== undefined && hit.seat !== p.seat) {
        const rel = hit.abs === '' ? '（整棵项目根）' : hit.raw
        const mine = abs === '' ? '（整棵项目根）' : raw
        return {
          ok: false,
          error:
            `分区重叠：${p.seat} 的「${mine}」与 ${hit.seat} 的「${rel}」互相包含。\n` +
            '两个席位都能写同一个位置 = 允许两个人改同一个文件 —— 那正是分区要避免的事。\n' +
            '请把范围切开（例如按目录并列而非嵌套），或者改成单席位（count=1，范围 .）。\n' +
            '（选择"编排时就拒"而不是"运行时警告"：等运行时才发现重叠，两边可能都已经写过了。）',
        }
      }
      claimed.push({ abs, seat: p.seat, raw })
    }
  }

  return {
    ok: true,
    writers: {
      count,
      /** ★ 层清单：`count === layers.length` 是本轮写死的不变量。 */
      layers,
      partitions,
      reason: typeof w.reason === 'string' ? w.reason : '',
      decided_by: 'planner',
      max_writers: max,
    },
  }
}

/**
 * 找出某个绝对路径归属于哪个席位（守门判据用）。
 *
 * @param {object} writers - roster.writers
 * @param {string} absPath
 * @param {string} projectRoot
 * @returns {{seat:string, matched:string} | null}
 */
export function seatOwningPath(writers, absPath, projectRoot) {
  if (writers === null || typeof writers !== 'object') return null
  const parts = Array.isArray(writers.partitions) ? writers.partitions : []
  const hits = []
  for (const p of parts) {
    for (const raw of p.scope_paths ?? []) {
      const abs = raw === '.' || raw === './' ? projectRoot : toAbsolute(projectRoot, raw)
      if (isInside(abs, absPath) || pathKey(abs) === pathKey(absPath)) {
        hits.push({ seat: p.seat, matched: raw })
        break
      }
    }
  }
  if (hits.length === 0) return null
  // 多条命中说明重叠（编排层已经拦过，这里是兜底）——返回第一条，调用方看 hits 长度
  return { ...hits[0], overlaps: hits.length > 1 ? hits.map((h) => h.seat) : [] }
}

// ---------------------------------------------------------------------------
// ★ 用户第 2 件（2026-10-16）：四槽那一整段**原样搬进** `lib/tiers/roster-slots.js`
//   （连同"一个 AI 一个专属模式"的只读判据搬进 `lib/tiers/roster-mode.js`）。
//   原因只有一个：**行数纪律** —— 本文件 1388 行，而这次要动 `normalizeRosterSlots`
//   的模式槽落值（规矩：给 ≥400 行的文件加行 ⇒ 先拆再改）。
//   行为一个字节没改；下面这些导出名**一个不少**，调用方不用改 import。
// ---------------------------------------------------------------------------
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

// ★ 开对话留痕那一小块也单独成文件（同一条行数纪律），本文件只转出。
export {
  DISPATCH_OPEN_AUDIT_FIELDS,
  DISPATCH_OPEN_ACTION,
  dispatchOpenRecord,
} from './tiers/dispatch-open.js'

export {
  roleModePlan,
} from './tiers/roster-mode.js'


/**
 * ★ **逐字段严格相等**地比对一次「开对话」请求带下来的四槽与名单里冻结的四槽（B2）。
 *
 * 不做任何归一、不做近似匹配：差一个字符就是另一档。
 *
 * @param {object} roster
 * @param {{role:string, seat?:string|null, permission?:any, mode?:any, model?:any, reasoning?:any}} req
 * @returns {{ok:boolean, mismatches:Array<{slot:string, want:any, got:any}>}}
 */
export function compareDispatchSlots(roster, req = {}) {
  const table = roster !== null && typeof roster === 'object' && roster.slots !== null && typeof roster.slots === 'object' ? roster.slots : null
  if (table === null) {
    return { ok: false, mismatches: [{ slot: '(名单)', want: 'roster.slots', got: null }] }
  }
  const seat = req.seat === undefined ? null : req.seat
  const entry = table[slotKeyOf(req.role, seat)] ?? table[slotKeyOf(req.role, null)]
  if (entry === undefined) {
    return { ok: false, mismatches: [{ slot: '(席位)', want: slotKeyOf(req.role, seat), got: '名单里没有这一条' }] }
  }
  const mismatches = []
  for (const slot of ROSTER_SLOT_KEYS) {
    if (!Object.hasOwn(entry, slot)) {
      mismatches.push({ slot, want: '(名单缺这一槽)', got: req[slot] ?? null })
      continue
    }
    const want = entry[slot]?.value
    const got = req[slot] === undefined ? null : req[slot]
    const bothFn = typeof want === 'function' && typeof got === 'function'
    if (!bothFn && want !== got) mismatches.push({ slot, want, got })
  }
  return { ok: mismatches.length === 0, mismatches }
}

/**
 * ★ **开对话人数上限**的数据面（A3）。
 *
 * 上限值来自名单（`roster.dispatch_quota`，缺省 = 清单里的独立对话数，**不含主对话**，与 buildRoster 的缺省同一口径）。
 * 纯函数：调用方把"当前已开出、还活着的会话数"数给它，它只回答"再开一个合不合法"。
 */
export function checkDispatchQuota(roster, currentOpen, opts = {}) {
  const n = Number.isInteger(currentOpen) && currentOpen >= 0 ? currentOpen : 0
  const explicit = roster !== null && typeof roster === 'object' ? roster.dispatch_quota : undefined
  const fromList = roster !== null && typeof roster === 'object' && Array.isArray(roster.conversations)
    ? roster.conversations.filter((r) => r !== ROLE.MAIN).length
    : 0
  const max = Number.isInteger(explicit) ? explicit : fromList
  const who = String(opts.who ?? '本次请求')
  return {
    ok: n < max,
    current: n,
    max,
    error:
      n < max
        ? null
        : `${who} 要开的会话数会到第 ${n + 1} 个，但名单里声明的上限是 ${max} 个。\n` +
          '★ 能开几个**由名单说了算**（不是由发起方的判断说了算）：要更多就先改名单，' +
          '而改名单只有一条路 —— 角色变更申请 → 计划复核（A3）。',
  }
}

/**
 * ★ **硬性次序**的数据面（A4）：把 `sequence[].order` 与 `sequence[].requires` 变成判据。
 *
 * @param {object} roster
 * @param {string} eventRole - 要开的那个角色
 * @param {string[]} completedRoles - 已经完成的角色
 * @returns {{ok:boolean, blockedBy:string[], error:string|null, entry:object|null}}
 */
export function validateDispatchSequence(roster, eventRole, completedRoles) {
  const seq = roster !== null && typeof roster === 'object' && Array.isArray(roster.sequence) ? roster.sequence : []
  const entry = seq.find((x) => String(x?.role ?? '') === String(eventRole ?? '')) ?? null
  if (entry === null) {
    const name = String(eventRole ?? '')
    return {
      ok: false,
      blockedBy: [],
      entry: null,
      error:
        `角色「${name}」不在本次名单的硬性次序里 —— 名单外的角色一律开不出来。\n` +
        `名单次序：${seq.map((x) => x.role).join(' → ')}`,
    }
  }
  const done = new Set((Array.isArray(completedRoles) ? completedRoles : []).map((x) => String(x)))
  const requires = toStringArray(entry.requires)
  const blockedBy = requires.filter((r) => !done.has(r))
  return {
    ok: blockedBy.length === 0,
    blockedBy,
    entry,
    error:
      blockedBy.length === 0
        ? null
        : `次序倒置：角色「${entry.role}」（第 ${entry.order} 位）要求先完成 ${requires.join('、')}，` +
          `现在还没完成的是 ${blockedBy.join('、')}。\n` +
          '★ 次序是**硬的**（写死在名单的 sequence 上），不是"最好按这个顺序"。',
  }
}

export function validateRoster(roster) {
  const errors = []
  if (roster === null || typeof roster !== 'object') return { ok: false, errors: ['roster 不是对象'] }
  if (!Object.hasOwn(TIERS, String(roster.tier ?? ''))) errors.push(`tier 非法：${roster.tier}`)
  const exec = Array.isArray(roster.execution_roles) ? roster.execution_roles : null
  if (exec === null) errors.push('execution_roles 不是数组')
  else {
    for (const r of SEPARATION_ROLES) {
      if (!exec.includes(r)) errors.push(`缺少三权分立角色「${r}」`)
    }
    if (!Number.isInteger(roster.ai_count) || roster.ai_count < 4) {
      errors.push(`ai_count 必须 >= 4（最少 4 个独立对话），当前 ${roster.ai_count}`)
    }
    if (Array.isArray(roster.conversations) && roster.conversations.length !== roster.ai_count) {
      errors.push(`ai_count(${roster.ai_count}) 与 conversations 长度(${roster.conversations.length}) 不一致`)
    }
  }
  if (roster.judged_by === 'planner' && (typeof roster.reason !== 'string' || roster.reason.trim().length === 0)) {
    errors.push('由计划 AI 产出的清单必须带 reason（每次判断都要有理由记录、可追溯）')
  }
  // ★ 编写席位
  if (exec.includes !== null && exec.includes(ROLE.WRITER)) {
    const w = roster.writers
    if (w === null || typeof w !== 'object') {
      errors.push('roster 缺少 writers（编写席位方案）—— 即使是单席位也必须显式给 count=1')
    } else {
      const built = buildWriters(w, Number.isInteger(roster.max_writers) ? roster.max_writers : TIERS[roster.tier]?.maxWriters ?? 1)
      if (built.ok !== true) errors.push(`writers 非法：${built.error.split('\n')[0]}`)
      else if (built.writers.count !== w.count) errors.push('writers.count 与 partitions 不一致')
      if (w.count > 1 && (typeof w.reason !== 'string' || w.reason.trim().length === 0)) {
        errors.push('分多个编写席位时必须写 writers.reason（为什么分、怎么分的）—— 这是可追溯性要求')
      }
    }
  }
  return { ok: errors.length === 0, errors }
}
