/**
 * dsh-pipeline · 角色清单与编写席位（buildRoster / buildWriters / 建议器）
 * ============================================================================
 * 自 `lib/tiers.js` 拆分出来的子模块（纯机械拆分，行为与原文件逐字一致）。
 *
 * @module dsh-pipeline/lib/tiers/roster
 */

import { DEFAULT_WRITER_LAYERS, LAYER_PATTERN, MAX_WRITER_SEATS, ROLE, SEPARATION_ROLES, SINGLE_SEAT_LAYER, seatId } from '../roles.js'
import { isInside, pathKey, toAbsolute, toStringArray } from '../util.js'
import { buildRelayPolicy } from '../context.js'
import { createHash } from 'node:crypto'
import { buildRosterSlots } from './roster-slots.js'
import { TIERS, TIER_ORDER } from './constants.js'

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
