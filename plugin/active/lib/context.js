/**
 * dsh-pipeline · 上下文水位与继任
 * ============================================================================
 *
 * ## 先说侦察结论（这决定了整个模块的形态）
 *
 * **DSH 目前没有面向插件的"上下文/token 用量"接口。** 源码为准：
 *
 *   · `@deepseek-ai/dsh-agent-loop/lib/index.js:460-462` 有一个 `get usage()`
 *     —— 但它在 **流装配器（assembler）内部**，不对外暴露。
 *   · 同文件 `:1250` 读 `contextWindow`（模型上下文窗口大小），
 *     它进的是会话的 `request/context` 记录 —— 只有"窗口多大"，没有"用了多少"。
 *   · `:1098` / `:1148` 把 `live.usage` 写进会话记录（assistant 消息），
 *     但没有任何包把它读出来给插件用。
 *   · `dsh-session` / `dsh-agent` / `dsh-subagent` / `dsh-tools` 里**没有**
 *     `usage` / `contextWindow` 的对外服务或工具。
 *   · 本机 `~/.dsh/.dshw-usage.json` 是**计费**账本（每次 API 调用的钱与 token 总量），
 *     是**按次累计**的，**不能**用来算"当前上下文的占用比例"。
 *
 * 所以按需求里给的降级路径：**角色自报 + 必须给依据**。
 *
 * ## 但"自报"不等于"凭感觉"—— 本模块补一类**客观观测**
 *
 * 插件能自己数：某个席位**调用过多少次工具**、**提交过多少份交接物**、
 * **活跃了多久**（首次/最近一次工具调用的时间跨度）。这些是**插件亲自观测到的**，
 * 不是模型说的。于是每条水位上报都带两块：
 *
 *   · `self_reported`  —— 席位自己说的百分比 + 它给的依据（**必填**）
 *   · `observed`       —— 插件数出来的客观量（工具调用次数、交接物数、活跃时长）
 *
 * 主对话据此判断这条自报**像不像真的**。这仍然不是精确测量 ——
 * 但比"我说我 55% 了"强得多，而且**证据是可核对的**。
 *
 * ## 三级阈值
 *
 *   · `warnPercent`（默认 45）  —— 预警：该准备交接材料了
 *   · `triggerContextPercent`（默认 **55**）—— **必须**上报给分配 AI（主对话）
 *   · `hardLimitPercent`（默认 **65**）—— **禁止再领新活**，只允许交接与收尾
 *
 * @module dsh-pipeline/lib/context
 */

import { toStringArray } from './util.js'
import { describeScopePaths } from './scope/root-marker.js'


/**
 * ★ 把任务卡渲染成**人可读的需求档**（markdown）。
 *
 * 读者是"上下文已经丢了的继任席位"或"过几天回来的你" —— 所以它必须：
 *   · 只讲**要做什么**与**怎么算做完**，不讲实现细节
 *   · 自带"需求以本文件为准"的声明，免得有人回去翻聊天记录
 *   · 列出验收标准与测试要点（这两样是"做完没做完"的判据）
 *
 * @param {object} input
 * @returns {string}
 */
export function renderRequirementDoc(input) {
  const { task, roster, acceptance, testPoints, boundaries, reason } = input
  const L = []
  L.push(`# 需求档 · ${task.id}`)
  L.push("")
  L.push("> ★ **本文件是权威需求快照。** 所有角色默认**以本文件为准**，不要凭自己上下文里的记忆行事。")
  L.push("> 上下文溢出、失忆、席位换人之后，读这个文件就能恢复\"要做什么、验收标准是什么\"。")
  L.push("")
  L.push("## 需求原文")
  L.push("")
  L.push(String(task.requirement ?? "(未登记)"))
  L.push("")
  L.push("## 交付形态")
  L.push("")
  L.push(String(task.deliverable_format ?? "(未指定)"))
  L.push("")
  L.push("## 分档与角色")
  L.push("")
  L.push(`- 档位：**${roster.tier}**（${roster.tier_zh}）`)
  L.push(`- 编排模式：${roster.orchestrator_mode}${roster.orchestrator_mode === "rule-engine" ? "（规则引擎；本档没有独立的需求分析与计划对话）" : ""}`)
  L.push(`- 执行角色：${(roster.execution_roles ?? []).join(" / ")}`)
  L.push(`- 调用顺序：${(roster.sequence ?? []).map((s) => s.role).join(" → ")}`)
  if (roster.writers) {
    L.push(`- 编写席位：${roster.writers.count} 个（席位数 = 层数）`)
    for (const p of roster.writers.partitions ?? []) {
      L.push(`  - ${p.seat} ｜ 层：${p.layer ?? "(未标)"} ｜ 范围：${describeScopePaths(p.scope_paths)}${p.deliverables?.length ? `（${p.deliverables.join("、")}）` : ""}`)
    }
  }
  if (roster.relay_policy) {
    const rp = roster.relay_policy
    L.push(`- 继任策略：预警 ${rp.warnPercent}% / 触发继任 ${rp.triggerContextPercent}% / 硬限 ${rp.hardLimitPercent}%；每席位最多继任 ${rp.maxSuccessionsPerSeat} 次`)
  }
  L.push("")
  L.push("## 验收标准（做完没做完的判据）")
  L.push("")
  if (acceptance.length === 0) L.push("- （编排未单列验收标准 —— 以上面的需求原文为准）")
  else acceptance.forEach((a, i) => L.push(`${i + 1}. ${a}`))
  L.push("")
  L.push("## 测试要点")
  L.push("")
  if (testPoints.length === 0) L.push("- （未单列）")
  else testPoints.forEach((a) => L.push(`- ${a}`))
  L.push("")
  L.push("## 边界与不做的事")
  L.push("")
  if (boundaries.length === 0) L.push("- （未单列）")
  else boundaries.forEach((a) => L.push(`- ${a}`))
  /**
   * ★ **缺陷 ⑧**：需求面口径 —— 数值入参的**非有限值**（`Infinity` / `NaN`）要在
   *   `boundaries` 里显式规定。这里只是把提示**印进需求档**（所有角色以它为准），
   *   **不替需求分析写条目、不改任何实现行为**。判据见 `lib/intake/boundary-hints.js`。
   */
  if (typeof input.boundaryHint === "string" && input.boundaryHint.length > 0) {
    L.push("")
    L.push(`> ⚠ 提示（需求面口径，**不改行为**）：${input.boundaryHint}`)
  }
  L.push("")
  if (Array.isArray(input.unclearPoints) && input.unclearPoints.length > 0) {
    L.push("## 需求不清楚处（已在开工前提请用户确认）")
    L.push("")
    input.unclearPoints.forEach((a, i) => L.push(`${i + 1}. ${a}`))
    L.push("")
  }
  if (Array.isArray(input.planSteps) && input.planSteps.length > 0) {
    L.push("## 计划步骤")
    L.push("")
    input.planSteps.forEach((a, i) => L.push(`${i + 1}. ${a}`))
    L.push("")
  }
  L.push("## 分配理由")
  L.push("")
  L.push(String(reason ?? "(无)"))
  L.push("")
  L.push("## 安全面（审核必查）")
  L.push("")
  L.push("审核**必须**确认**网络安全 / 本地泄密是否发生**，并在 `review_verdict.security` 里给出 `attestation`")
  L.push("（`clean` / `issues`）与可核对的依据（`checks_ref` 必须真实存在）。`unknown` 不允许通过；")
  L.push("有未解决 finding 不允许关单；安全角色 `blocked: true` 时强制打回。")
  L.push("")
  L.push("---")
  L.push("")
  L.push("_本文件由 dsh-pipeline 在计划分配产出角色清单时自动落盘；变更会另存新版本，历史不覆盖。_")
  return L.join("\n")
}

/** 阈值默认值。计划 AI 可以用 `relayPolicy` 覆盖。 */
export const DEFAULT_RELAY_POLICY = {
  warnPercent: 45,
  /** ★ 触发继任。到这条线时**必须**上报给分配 AI（= 计划 AI）。 */
  triggerContextPercent: 55,
  hardLimitPercent: 65,
  /** 同一个席位最多继任几次（防止无限换人）。 */
  maxSuccessionsPerSeat: 2,
  /** 哪些角色允许继任。空数组 = 全部执行角色。 */
  allowedRoles: [],
  /**
   * ★ 谁执行继任。本轮从 `orchestrator` 改成 **`planner`** —— **分配 AI 就是计划 AI**。
   *
   * 为什么跟着改：用户拍板把"分配 AI"从「需求分析/编排判断」拆给了新的 `planner`
   * （见 roles.js / REPORT 本轮更正记录）。继任 = 追加/指派席位，**这就是分配**，
   * 所以决策权跟着**职权**走，而不是跟着旧角色名走。
   * 历史沿革：最早设计成"编排预先授权、主对话执行"（已作废）→ 改成"编排自己执行"
   * → 本轮改成"计划 AI 执行"。
   */
  executor: 'planner',
  /**
   * 哪些档位启用继任。L0 是**故意**不用的 —— 见 README「上下文水位与继任」。
   * 理由：L0 是单文件/单函数级改动，席位本来就没多少上下文；
   * 而且 L0 的编排由规则引擎承担，没有独立编排对话来给 `relayPolicy`。
   */
  enabledTiers: ['L1', 'L2', 'L3', 'L4', 'L5'],
}

/** 水位档位。 */
export const LEVELS = {
  ok: '正常',
  warn: '预警（该准备交接材料了）',
  succession: '触发继任（必须上报给分配 AI）',
  hard_limit: '硬限（禁止再领新活，只允许交接与收尾）',
}

/**
 * 校验并规整编排给出的 `relayPolicy`。
 *
 * @param {any} raw
 * @returns {{ok:true, policy:object} | {ok:false, error:string}}
 */
export function buildRelayPolicy(raw) {
  const p = raw !== null && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v) : d)

  const warn = num(p.warnPercent, DEFAULT_RELAY_POLICY.warnPercent)
  const trigger = num(p.triggerContextPercent, DEFAULT_RELAY_POLICY.triggerContextPercent)
  const hard = num(p.hardLimitPercent, DEFAULT_RELAY_POLICY.hardLimitPercent)

  if (!(warn < trigger && trigger < hard)) {
    return {
      ok: false,
      error:
        `relayPolicy 的三个阈值必须严格递增：warnPercent(${warn}) < triggerContextPercent(${trigger}) < hardLimitPercent(${hard})。\n` +
        '（否则"预警""触发继任""硬限"三档会互相覆盖，席位不知道该听哪一条。）',
    }
  }

  const max = Number.isInteger(p.maxSuccessionsPerSeat) && p.maxSuccessionsPerSeat >= 0 ? p.maxSuccessionsPerSeat : DEFAULT_RELAY_POLICY.maxSuccessionsPerSeat
  const allowed = toStringArray(p.allowedRoles)
  const enabledTiers = toStringArray(p.enabledTiers)
  return {
    ok: true,
    policy: {
      warnPercent: warn,
      triggerContextPercent: trigger,
      hardLimitPercent: hard,
      maxSuccessionsPerSeat: max,
      allowedRoles: allowed,
      executor: p.executor === 'main' ? 'main' : 'planner',
      enabledTiers: enabledTiers.length > 0 ? enabledTiers : [...DEFAULT_RELAY_POLICY.enabledTiers],
    },
  }
}

/**
 * 本任务是否启用继任。
 *
 * @param {object} task
 * @returns {{enabled:boolean, why:string, policy:object}}
 */
export function relayEnabled(task) {
  const policy = task.roster?.relay_policy ?? { ...DEFAULT_RELAY_POLICY }
  const tier = task.roster?.tier ?? ''
  if (task.roster === null || task.roster === undefined) {
    return { enabled: false, why: '任务还没有角色清单（编排尚未判断），谈不上继任策略。', policy }
  }
  if (!policy.enabledTiers.includes(tier)) {
    return {
      enabled: false,
      why:
        `本档（${tier}）不在 relayPolicy.enabledTiers（${policy.enabledTiers.join(' / ')}）里，不启用继任。\n` +
        (tier === 'L0'
          ? '★ L0 是**故意**不启用的：单文件/单函数级改动，席位上下文本来就不大；' +
            '而且 L0 的编排由规则引擎承担，没有独立编排对话来给 relayPolicy。' +
            '真撑不住时直接重新派一个同席位的会话即可（不需要交接物）。'
          : ''),
    }
  }
  return { enabled: true, why: '', policy }
}

/**
 * 由百分比算档位。
 *
 * @param {number} percent
 * @param {object} policy
 * @returns {'ok'|'warn'|'succession'|'hard_limit'}
 */
export function levelOf(percent, policy) {
  const p = Number(percent)
  if (!Number.isFinite(p)) return 'ok'
  if (p >= policy.hardLimitPercent) return 'hard_limit'
  if (p >= policy.triggerContextPercent) return 'succession'
  if (p >= policy.warnPercent) return 'warn'
  return 'ok'
}

/**
 * 校验一条水位上报。
 *
 * ★ 只有一条硬要求：**依据必须给**。
 *   "我 55% 了" 不算上报；"我 55% 了，因为已读 12 个文件、跑了 30 轮、上下文里压了 3 份大报告" 才算。
 *
 * @param {object} input
 * @param {number} input.percent
 * @param {string} input.basis
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function validateContextReport(input) {
  const pct = Number(input?.percent)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: `percent 必须是 0~100 的数字，当前是「${input?.percent ?? '(缺失)'}」。` }
  }
  const basis = typeof input?.basis === 'string' ? input.basis.trim() : ''
  if (basis.length === 0) {
    return {
      ok: false,
      error:
        '缺 basis：上报水位**必须给依据**。\n' +
        '★ 为什么这条是硬要求：`usage` 那个 getter 在流装配器内部，DSH 没有面向插件的上下文用量接口' +
        '（源码：dsh-agent-loop:460-462、:1250），所以水位只能由席位自报。\n' +
        '既然是自己说的，就必须说清**凭什么** —— 否则"我 55% 了"和"我觉得差不多了"没有区别。\n' +
        '可用的依据：已读/已写文件数、工具调用轮次、上下文里压着几份大报告、刚做过什么大动作。',
    }
  }
  if (basis.length < 8) {
    return { ok: false, error: `basis 只有 ${basis.length} 个字符，太短，不构成可核对的依据。` }
  }
  return { ok: true }
}

/**
 * ★ 谁能执行这次继任？（**分配 AI = 计划 AI**）
 *
 * 规则两条：
 *   ① `planner`（分配 AI）**随时可以**给任何席位换班 —— 这是它的本职
 *      （它是角色/席位清单的权威，追加/指派继任者本来就是它做的事）。
 *   ② `main`（主对话）**只在一种情况下**可以执行继任：**给计划席位自己换班**。
 *
 * ② 这条是**异常路径**的最小兜底：计划 AI 在**没有产出继任者**的情况下撞到 65% 硬限时，
 *   为什么不由 security / arbiter 接手：那会**改变角色清单**（新增一个"能指派继任"的角色），
 *   那才是真正的"角色变更"，得走 roster_review。
 *   而主对话给计划席位换班**不新增、不删减任何角色**，清单原封不动 ——
 *   所以它与「主对话不得自行增删角色」**不冲突**。
 *
 * ★ 换句话说：主对话**不参与分配**；它唯一被允许的那次继任，是"清单不变"原则下的
 *   必要兜底，而且范围被死死限制在 `role === "planner"`。
 *
 * ⚠️ 角色名从 `orchestrator` 改成 `planner` 是本轮"拆角色"的直接后果：
 *   能执行继任的是**掌分配权的那个人**。需求分析不掌分配权，所以它**不能**执行继任
 *   —— 但它仍然是继任者接手后的**第一联系人**（那是澄清梯的事，不是分配的事）。
 */
export function checkSuccessionActor(input) {
  const actor = String(input.actorRole ?? '')
  const role = String(input.role ?? '')
  // ★ 计划 AI 自己也会到 55%/65%。它**可以给自己换班**。
  if (actor === 'planner') return { ok: true }
  if (actor === 'main') {
    if (role === 'planner') return { ok: true }
    return {
      ok: false,
      error:
        '拒绝：主对话**不参与继任指派**。\n' +
        '★ 分配 AI 是**计划 AI**（planner），不是主对话 —— 追加/指派继任者本来就是计划的本职。\n' +
        '主对话只负责**更新状态、跟踪、最终关单**。\n' +
        '（唯一的例外：给**计划席位自己**换班 —— 指派者不能是自己，那时主对话按"清单不变"原则兜底。\n' +
        '  本次要换的是「' + role + '」，不在那个例外里。）\n' +
        '下一步：让计划 AI 调 pipeline_succession；或先让该席位上报水位，由计划决定换班。',
    }
  }
  return {
    ok: false,
    error:
      `拒绝：只有**分配 AI（计划 AI，planner）**能执行席位继任，当前调用方是「${actor}」。\n` +
      '★ 继任 = 追加/指派席位 —— 那是计划分配的职权，不是执行角色的。\n' +
      '下一步：调 pipeline_context_report 上报水位（到 55% 会通知计划），然后等计划指派。',
  }
}

/**
 * ★ 一个纯内存的工具调用计数器（客观观测）。
 *
 * 为什么放在守门那一层数：守门是**每一次工具调用都会经过**的地方
 * （`dsh-tools/lib/index.js:3225` 的 pre-execute → guard），
 * 而且它拿得到 `exec.agent`（`agent.id === agent.session.id`，dsh-agent:511）。
 * 于是不需要任何新的宿主接口，插件就能自己数出"这个席位干了多少活"。
 *
 * ⚠️ 它**不是**上下文占用的度量 —— 只是"这个席位有多忙"的客观代理指标。
 *    报告里必须这么写，不能把它当水位用。
 */
export function createCallCounter() {
  /** @type {Map<string, {count:number, first:number, last:number, tools:Record<string,number>}>} */
  const m = new Map()
  return {
    /** 记一次调用。返回该 agent 的累计次数。 */
    touch(agentId, toolName, at = Date.now()) {
      if (typeof agentId !== 'string' || agentId.length === 0) return 0
      let e = m.get(agentId)
      if (e === undefined) {
        e = { count: 0, first: at, last: at, tools: {} }
        m.set(agentId, e)
      }
      e.count += 1
      e.last = at
      const t = String(toolName ?? '')
      if (t.length > 0) e.tools[t] = (e.tools[t] ?? 0) + 1
      return e.count
    },
    /** 取客观观测快照。 */
    snapshot(agentId) {
      const e = m.get(agentId)
      if (e === undefined) return { tool_calls: 0, first_seen_at: null, last_seen_at: null, active_minutes: 0, top_tools: [] }
      const mins = Math.max(0, Math.round((e.last - e.first) / 60000))
      const top = Object.entries(e.tools).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`)
      return {
        tool_calls: e.count,
        first_seen_at: new Date(e.first).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        last_seen_at: new Date(e.last).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        active_minutes: mins,
        top_tools: top,
      }
    },
    /** 全部清掉（测试用）。 */
    reset() {
      m.clear()
    },
  }
}

/**
 * `seat_handover` 交接物的跨字段校验。
 *
 * 目的：**防止继任者从零开始**。所以两个字段是硬要求：
 *   · `must_read_files` —— 必读文件清单（至少含需求档）
 *   · `open_questions` —— 悬而未决的问题（**允许为空数组，但必须显式给**）
 *
 * @param {object} p
 * @returns {{ok:true} | {ok:false, errors:string[]}}
 */
export function validateSeatHandover(p) {
  const errors = []
  const need = (k, zh) => {
    const v = p?.[k]
    if (v === undefined || v === null || (typeof v === 'string' && v.trim().length === 0)) {
      errors.push(`缺少必填字段「${k}」（${zh}）—— 继任者会从零开始。`)
      return false
    }
    return true
  }

  need('from_seat', '旧席位')
  need('to_seat', '新席位')
  need('reason', '为什么换班（水位 + 依据）')
  need('next_step', '接手后的第一步做什么')

  // ★ 两个"防从零开始"的字段
  if (need('must_read_files', '★ 必读文件清单（至少含需求档路径）')) {
    const files = toStringArray(p.must_read_files)
    if (files.length === 0) {
      errors.push(
        '`must_read_files` 是空数组 —— 继任者**至少要读需求档**。\n' +
          '★ 需求档（`requirement.md`）是权威需求快照，它的意义就是"新来的人只读它就能接上"。\n' +
          '请把需求档路径（以及其它必读文件）列进来。',
      )
    }
  }
  if (p.open_questions === undefined || p.open_questions === null) {
    errors.push(
      '缺少 `open_questions` —— 悬而未决的问题**必须显式给**（没有就写空数组）。\n' +
        '★ "没问题"和"没写"是两件事：继任者要知道**哪些坑还没填**，才知道该问谁。',
    )
  }
  // ★ 更正 B（本轮改名）：**计划 AI** 的交接物必须额外带**待处理的请求队列** ——
  //   否则新计划 AI 根本不知道**谁在等答复**，那些请求就永远悬着。
  //   （本轮之前这个字段挂在 `orchestrator` 上；澄清梯的第一级仍然是需求分析，
  //     所以**两个角色都要求**这个字段 —— 换班的是谁，队列就得跟着谁走。）
  if (p.from_seat === 'planner' || p.to_seat === 'planner' || p.role === 'planner') {
    if (p.pending_requests === undefined || p.pending_requests === null) {
      errors.push(
        '计划 AI 的交接物缺少 `pending_requests` —— **待处理的请求队列必须显式给**（没有就写空数组）。\n' +
          '★ 这是分配权持有者特有的交接项：谁在等你的指派、等到什么程度了。\n' +
          '  不写的话，新计划 AI 不知道有人还在等 —— 那些请求会**永远悬着**。',
      )
    }
  }
  if (p.from_seat === 'orchestrator' || p.to_seat === 'orchestrator' || p.role === 'orchestrator') {
    if (p.pending_requests === undefined || p.pending_requests === null) {
      errors.push(
        '需求分析的交接物缺少 `pending_requests` —— **待处理的澄清请求队列必须显式给**（没有就写空数组）。\n' +
          '★ 需求分析是两级澄清梯的**第一级**：谁在等你裁定、等到什么程度了，必须交接下去。',
      )
    }
  }

  if (p.do_not_repeat === undefined || p.do_not_repeat === null) {
    errors.push(
      '缺少 `do_not_repeat` —— 走过的弯路**必须显式给**（没有就写空数组）。\n' +
        '★ 继任者最贵的一课，就是把前人踩过的坑再踩一遍；不写等于让它自己再发现一次。',
    )
  }
  for (const k of ['progress_done', 'progress_todo', 'must_read_files', 'key_decisions', 'open_questions', 'do_not_repeat']) {
    if (p[k] !== undefined && p[k] !== null && !Array.isArray(p[k])) errors.push(`字段「${k}」必须是数组。`)
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * ★ 主对话能不能在 `relayPolicy` 授权内自行执行这次继任？
 *
 * 这是"主对话不得自行加人减人"那条既有约束的**落点**：
 * 继任**不改角色清单**（角色数量不变，只是同一角色的席位换人），
 * 但"换几次、换哪些角色"必须由**计划 AI** 预先授权。超出授权一律回计划复核。
 *
 * @param {object} input
 * @param {object} task
 * @param {string} seat - roster 席位 id（例如 writer#1）
 * @param {string} role
 * @returns {{ok:true, policy:object} | {ok:false, error:string}}
 */
export function checkRelayAuthorization(input) {
  const { task, seat, role } = input
  const en = relayEnabled(task)
  if (en.enabled !== true) {
    return { ok: false, error: `本任务不启用继任：${en.why}` }
  }
  const policy = en.policy

  if (policy.allowedRoles.length > 0 && !policy.allowedRoles.includes(role)) {
    return {
      ok: false,
      error:
        `角色「${role}」不在 relayPolicy.allowedRoles（${policy.allowedRoles.join(' / ')}）里，本次不给继任。\n` +
        '★ 继任策略是**计划 AI 自己掌握**的：哪些角色能换班、最多换几次 —— 它随时可以重下 relayPolicy。\n' +
        '要让某个角色也能换班，由计划 AI 重下一次 relayPolicy 即可。',
    }
  }

  const used = (task.successions ?? []).filter((s) => s.seat === seat).length
  if (used >= policy.maxSuccessionsPerSeat) {
    return {
      ok: false,
      error:
        `席位 ${seat} 已经继任 ${used} 次，达到上限 ${policy.maxSuccessionsPerSeat} 次。\n` +
        '★ 反复换班说明问题不在"上下文不够"，而在别处（任务太大？拆分不合理？需求没定？）。\n' +
        '下一步：**回编排复核** —— pipeline_roster_request 提出，让编排重新划界或调整 relayPolicy。\n' +
        '主对话不得自行突破这个上限。',
    }
  }

  return { ok: true, policy }
}
