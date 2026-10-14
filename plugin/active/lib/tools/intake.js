/**
 * dsh-pipeline · 开单与需求分析（pipeline_task_open / pipeline_orchestrate）
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/intake
 */

import { ROLE, roleLabel } from '../roles.js'
import { STATE_LABEL } from '../states.js'
import { renderRequirementDoc } from '../context.js'
import { agentIdOf } from '../guard.js'
import { TIERS, TIER_ORDER, proposeTier } from '../tiers.js'
import { toStringArray } from '../util.js'
import { describeScopePaths } from '../scope/root-marker.js'
import { NONFINITE_BOUNDARY_HINT, boundaryHintLine } from '../intake/boundary-hints.js'
import { describeL0Baseline, ensureL0Baseline } from '../store/l0-baseline.js'
import { S, tool, resolveActor } from './kit.js'

/**
 * 开单与需求分析（pipeline_task_open / pipeline_orchestrate）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildIntakeTools(ctx) {
  const { deps, config, store, tokens, indexTask, load } = ctx

  /** 取最近一份需求分析结论（计划 AI 交自己那份记录时要照抄验收标准 / 不清楚处）。 */
  function lastAnalysisOf(task) {
    const hs = Array.isArray(task?.handoffs) ? task.handoffs : []
    for (let i = hs.length - 1; i >= 0; i--) if (hs[i].kind === 'requirement_analysis') return hs[i]
    return null
  }

  /**
   * ★ 需求分析（第 1 轮）—— 只出分析结论，**不产出角色清单**。
   *
   * 三件硬事都在这里落地：
   *   ① `unclear_points` **必填**（允许空数组）—— "没有不清楚的地方"也是一个必须显式回答的答案；
   *   ② 交完分析**必须**提请用户确认（本函数只负责交分析，并在返回里明确下一步怎么提请），
   *      机制上由状态机的 `requirement_confirmed` 边兜底：没有用户答复，这条边过不去；
   *   ③ 有 `open_assumptions` 却不提任何不清楚处 ⇒ 交界物层直接拒（handoff.js 的跨字段判据）。
   */
  async function submitRequirementAnalysis(args, actor, task, engineReport) {
    const fail = (msg) => ({ ok: false, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false, summary: msg })

    if (!Array.isArray(args.unclear_points)) {
      return fail(
        '需求分析**必须**给出 unclear_points（需求不清楚处清单）—— 即使一条都没有，也要显式给空数组 [].\n' +
          '★ 为什么这条是必填：这份清单是**澄清前置到人工确认**的入口。缺了它，用户根本没机会说"你理解错了"。',
      )
    }
    if (!Array.isArray(args.acceptance) || args.acceptance.length === 0) {
      return fail('需求分析必须给 acceptance（验收标准）—— 没有验收标准就没有"做完没做完"的判据。')
    }
    if (!Array.isArray(args.test_points) || args.test_points.length === 0) {
      return fail('需求分析必须给 test_points（测试要点）—— 测试角色靠它设计用例。')
    }
    if (typeof args.analysis_reason !== 'string' || args.analysis_reason.trim().length === 0) {
      return fail('需求分析必须给 analysis_reason（为什么这么理解这份需求、为什么这么定验收标准）。')
    }

    const sub = await store.submitHandoff({
      taskId: task.id,
      kind: 'requirement_analysis',
      payload: {
        task_id: task.id,
        task_card: args.task_card ?? {
          goal: String(task.requirement ?? '').slice(0, 200),
          in_scope: toStringArray(args.acceptance),
          out_of_scope: toStringArray(args.boundaries),
        },
        acceptance: toStringArray(args.acceptance),
        test_points: toStringArray(args.test_points),
        boundaries: toStringArray(args.boundaries),
        unclear_points: toStringArray(args.unclear_points),
        open_assumptions: toStringArray(args.open_assumptions),
        analysis_reason: args.analysis_reason,
        /**
         * ★ 职责自限声明 —— 缺省给一份"需求层"的模板，但**鼓励覆盖它**。
         *   为什么要给缺省：这一栏的价值在"点名自己不做什么"，
         *   模板里那句"不分配 AI"正是最容易越界的那一条。
         */
        role_scope: args.role_scope ?? {
          will_do: [
            '把需求翻译成任务卡 / 验收标准 / 边界条件 / 测试要点',
            '列出「需求不清楚处」清单并提请用户确认',
            '作为两级澄清梯的第一级，裁定执行角色提出的需求层问题',
          ],
          will_not_do: ['不分配 AI（角色清单 / 用几个 / 派谁 / 顺序都是计划 AI 的活）', '不判档位（tier）', '不读代码、不写实现、不跑测试'],
        },
      },
      actorRole: actor.role,
      actorSeat: actor.seat ?? null,
      actorAgentId: actor.agentId,
    })
    if (sub.ok !== true) return fail(sub.error)
    indexTask(sub.task.id, sub.task)

    const unclear = toStringArray(args.unclear_points)
    const assumptions = toStringArray(args.open_assumptions)
    return {
      ok: true,
      dry_run: false,
      tier: '',
      ai_count: 0,
      roles: '',
      sequence: '',
      summary: [
        `需求分析结论已提交：${sub.handoff?.handoff_id ?? ''}（任务状态：${STATE_LABEL[sub.task.state]}）。`,
        `验收标准 ${toStringArray(args.acceptance).length} 条；测试要点 ${toStringArray(args.test_points).length} 条；不清楚处 ${unclear.length} 条` +
          `${assumptions.length > 0 ? `；你替用户做的假设 ${assumptions.length} 条` : ''}。`,
        '',
        unclear.length === 0
          ? '★ 清单是空的 —— 但**这一步不能省**："没有不清楚的地方"同样要用户点头。'
          : '★ 清单非空 —— 逐条问出来，别自己替用户拍板。',
        '',
        '下一步（**必须做，否则流程走不动**）：调 pipeline_human_request 把不清楚处提交主对话转告用户：',
        '  {',
        `    task_id: "${task.id}",`,
        '    reason_kind: "requirement_confirmation",',
        '    question_for_human: "<把上面的清单归成一个用户能回答的问句>",',
        '    context_for_human: "<不含代码的背景说明>",',
        '    blocking: true,',
        '    blocked_stage: "需求确认",',
        '    urgency: "blocking",',
        '    decision_kind: "free_text",   // 是/否类结论用 yes_no',
        '    timeout_behavior: "stay_blocked"',
        '  }',
        '主对话会把它转告用户；用户答复之后状态才会回到「需求分析中」，再由主对话推进到「待计划」。',
        '',
        '★ 分配 AI **不是你的活**：角色清单、用几个独立对话、谁先谁后，全部由计划 AI（pipeline_plan）产出。',
        `\n【规则引擎的建议（仅供参考，不构成判断）】\n${engineReport}`,
      ].join('\n'),
    }
  }

  // =========================================================================
  // 1. pipeline_task_open —— 主对话开单
  // =========================================================================
  const taskOpen = tool(deps, {
    name: 'pipeline_task_open',
    mutating: true,
    description:
      '【主对话专用】开一张流水线任务单：登记原始需求，返回任务 ID。' +
      '主对话在这里**不做技术分析**，只登记需求，然后交给需求分析（出任务卡 + 不清楚处清单）。' +
      '本工具会把调用方注册为这张单的「主对话」角色 —— 非主对话调它会拿到一张不属于自己的单，无法关单。' +
      '★ `reattach: true` = **重新认领一张已存在的单**（DSH 重启后恢复身份用的唯一入口；' +
      '不带它时同 id 仍然按老规矩报「已存在，请换一个 id」）。',
    parameters: {
      requirement: S('string', '原始需求（用户原话，不要替用户"提炼"）'),
      constraints: S('array', '约束条件（可空）', { items: { type: 'string' } }),
      acceptance: S('array', '用户已经明说的验收标准（可空；技术性验收标准由需求分析产出）', { items: { type: 'string' } }),
      deadline: S('string', '截止要求（可空）'),
      deliverable_format: S('string', '交付格式（可空，例如"补丁 + 变更说明 + 可运行命令"）'),
      task_id: S('string', '指定任务 ID（可空；留空自动生成）。`reattach: true` 时**必填**'),
      /**
       * ★ **重新认领**（重启后的恢复入口，2026-10-11 补）。
       *
       * 为什么恢复入口必须挂在"开单"这个工具上：主对话被切断之后**只有这一条路** ——
       *   · 它的令牌随重启一起没了（令牌表是进程内存态）；
       *   · `pipeline_bind_role` 救不了它 —— 那个工具**先 `tokens.resolve` 再 `bindAgent`**，
       *     令牌表空了它必然失败（这是个死锁：认领要令牌 → 令牌要主对话 → 主对话要身份）；
       *   · 同一个 `task_id` 又不能重开（`TASK_EXISTS`）。
       * 而 `pipeline_task_open` 恰好是**唯一不需要身份**的写工具。
       */
      reattach: S('boolean', '★ 重新认领一张**已存在**的任务单（DSH 重启后主对话恢复身份用）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      task_id: S('string', '任务 ID'),
      state: S('string', '当前状态'),
      role_token: S('string', '主对话自己的角色令牌（后续动作带上它）'),
    },
    async run(args, exec) {
      const agentId = agentIdOf(exec)

      // ---------------------------------------------------------------------
      // ★ **重新认领**（`reattach: true`）—— DSH 重启后的恢复入口。
      //
      //   为什么与"开单"共用一个工具：主对话被切断之后只有这一条路 ——
      //     · 令牌随重启没了（令牌表是进程内存态，`lib/tokens.js:41`）；
      //     · `pipeline_bind_role` 救不了它（先 resolve 再 bind，令牌表空了必失败）；
      //     · 同一个 task_id 又不能重开（`store.js` 的 `TASK_EXISTS`）。
      //   而 `pipeline_task_open` 是全插件**唯一不需要身份**的写工具
      //   （守门表里它是 `null`），所以恢复入口只能挂在这里。
      //
      //   ★ 认领 = **保留全部历史**（history / handoffs / artifacts 一条不动），
      //     只换身份。这与"覆盖重开"是两回事 —— 后者会毁掉审计链。
      // ---------------------------------------------------------------------
      if (args.reattach === true) {
        const id = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        if (id.length === 0) {
          return {
            ok: false,
            summary:
              '认领（`reattach: true`）必须给 `task_id` —— 就是那张**已存在**的单的 id。\n' +
              '★ 若你要开一张**新**单，请不要带 `reattach`。\n' +
              '  不确定有哪些单：`pipeline_status`（不带 task_id 会列出全部）。',
            task_id: '',
            state: '',
            role_token: '',
          }
        }

        const res = await store.reattach(id, { agentId })
        if (res.ok !== true) return { ok: false, summary: res.error, task_id: '', state: '', role_token: '' }

        const task = res.task
        indexTask(task.id, task)
        const t = tokens.mint({ taskId: task.id, role: ROLE.MAIN, agentId, note: 'reattach' })

        return {
          ok: true,
          task_id: task.id,
          state: task.state,
          role_token: t.token,
          summary:
            `已**重新认领** ${task.id}（当前状态：${STATE_LABEL[task.state] ?? task.state}）。\n` +
            `主对话令牌：${t.token}（本会话已绑定为该任务的「主对话」）。\n` +
            '★ 这是**认领**不是重开：`history` / `handoffs` / `artifacts` **一条都没动**，进度原样保留。\n' +
            (res.terminal
              ? `⚠ 这张单已处于**终态**（${STATE_LABEL[task.state] ?? task.state}）—— 认领成功，但它不再接受任何状态迁移，只能查看。\n`
              : '') +
            '\n**现在你有三个选择（明文列出，不替你决定）**：\n' +
            `  ① **继续推进**：先 \`pipeline_status { task_id: "${task.id}" }\` 看当前状态与下一步合法事件，再按它往下走。\n` +
            `  ② **取消这张单**：\`pipeline_transition { task_id: "${task.id}", event: "cancel" }\`\n` +
            '     （任意非终态都能取消 —— 这条边一直存在，之前"取消不了"是因为**身份先没了**，不是状态机缺边）。\n' +
            '  ③ **放着不管**：什么都不用做。它不会自己变，也不会阻塞你新开别的单。\n\n' +
            '★ 为什么需要这一步：DSH 重启后令牌表（**进程内存态**）被清空，**所有**令牌 ——\n' +
            '  包括开单时铸的主对话那枚 —— 全部失效，而同一个 `task_id` 又不能再开一次。\n' +
            '  认领是回到老单的**唯一**入口。',
        }
      }

      const res = await store.open({
        requirement: args.requirement,
        constraints: args.constraints,
        acceptance: args.acceptance,
        deadline: args.deadline,
        deliverableFormat: args.deliverable_format,
        id: typeof args.task_id === 'string' ? args.task_id : undefined,
        actorRole: ROLE.MAIN,
        actorAgentId: agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, task_id: '', state: '', role_token: '' }

      indexTask(res.task.id, res.task)
      const t = tokens.mint({ taskId: res.task.id, role: ROLE.MAIN, agentId, note: 'task_open' })
      return {
        ok: true,
        task_id: res.task.id,
        state: res.task.state,
        role_token: t.token,
        summary:
          `已开单 ${res.task.id}（状态：${STATE_LABEL[res.task.state]}）。\n` +
          `主对话令牌：${t.token}（本会话已自动绑定为该任务的主对话）。\n\n` +
          '下一步：调用 pipeline_orchestrate 做**需求分析** —— 出任务卡 / 验收标准 / 边界条件 / 测试要点，并列出**需求不清楚处**。\n' +
          '★ 分析结论要先交**用户人工确认**，确认后才由计划 AI（pipeline_plan）决定这次要几个 AI、调用谁、按什么顺序。\n' +
          '★ 主对话既不自行判断需要几个 AI，也不替用户拍板需求。',
      }
    },
  })

  // =========================================================================
  // 2. pipeline_orchestrate —— 需求分析（第 1 轮）
  // =========================================================================
  //
  // ★ 本轮改动：这个工具**收窄成只做需求分析**。
  //   它以前顺带产出角色清单（"编排判断"），现在那件事归 `pipeline_plan`（planner）。
  //   理由：这两件事的回答方式不同 —— 需求分析回答"要做什么"（语义问题），
  //   计划分配回答"怎么切、给谁、什么次序"（结构问题）。挤在一起时，
  //   "计划缺失"只能回头问自己，等于自问自答；拆开后才有真实的回流边。
  const orchestrate = tool(deps, {
    name: 'pipeline_orchestrate',
    mutating: true,
    description:
      '【需求分析专用】把模糊需求变成任务卡 + 验收标准 + 边界条件 + 测试要点，' +
      '并**产出「需求不清楚处」清单**（unclear_points）。' +
      '★ 它**不产出角色清单**——"要调用几个 AI、调用谁、按什么顺序"是计划 AI（pipeline_plan）的产物。' +
      '调用形态：(a) 独立需求分析对话调用（L1+）：交分析结论，然后**必须**用 pipeline_human_request 把不清楚处提交主对话转告用户确认；' +
      '(b) L0 极简脚本：主对话可以调它让**确定性规则引擎**自批角色清单 —— ' +
      '引擎要输出 L0，需求必须先通过一组保守的平凡性判据，任何一条不满足就强制升档（复杂需求不漏配）。' +
      '传 dry_run=true 只拿建议档位，不落盘。',
    parameters: {
      task_id: S('string', '任务 ID'),
      requirement: S('string', '原始需求（与开单时一致）'),
      acceptance: S('array', '验收标准（可执行的、可判定的）', { items: { type: 'string' } }),
      test_points: S('array', '测试要点', { items: { type: 'string' } }),
      boundaries: S('array', '边界条件（没有就给空数组）。★ 需求面提示：' + NONFINITE_BOUNDARY_HINT, { items: { type: 'string' } }),
      unclear_points: S('array', '★ 需求不清楚处清单（**必填**；没有不清楚的就给空数组 —— 那也是一个必须显式回答的结论）', { items: { type: 'string' } }),
      open_assumptions: S('array', '你替用户假设了什么（有假设却不提不清楚处会被拒）', { items: { type: 'string' } }),
      role_scope: S('object', '★ 需求分析自己的职责自限声明 { will_do: string[], will_not_do: string[] } —— 「不分配 AI、不定档、不读代码、不写实现」要写进 will_not_do', { additionalProperties: true }),
      analysis_reason: S('string', '★ 分析依据：为什么这么理解这份需求、为什么这么定验收标准'),
      task_card: S('object', '任务卡（人话版：要做什么、不做什么；可空）', { additionalProperties: true }),
      // --- L0 规则引擎自批时才用得到的两项 ---
      tier: S('string', '档位 L0~L5（**独立需求分析对话不要再传它**：档位是计划 AI 的判断）', { enum: TIER_ORDER }),
      reason: S('string', '理由（分配相关的理由请交给 pipeline_plan）'),
      writers: S('object', '★编写席位方案（**归计划 AI**；这里只为 L0 规则引擎兼容保留）', { additionalProperties: true }),
      relay_policy: S('object', '★继任策略（归计划 AI；这里只为 L0 兼容保留）', { additionalProperties: true }),
      extra_roles: S('array', '额外角色（归计划 AI）', { items: { type: 'string' } }),
      dry_run: S('boolean', '只拿规则引擎的建议档位，不写入'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含规则引擎的建议与理由）'),
      tier: S('string', '最终档位'),
      ai_count: S('number', '需要的独立对话总数'),
      roles: S('string', '角色清单（顿号分隔）'),
      sequence: S('string', '调用顺序'),
      dry_run: S('boolean', '是否只是试算'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: args.dry_run === true }

      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: `找不到任务 ${args.task_id}。`, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false }

      // --- 规则引擎先算一遍（永远算，dry_run 也用它回答）------------------
      const proposal = proposeTier({
        requirement: args.requirement ?? task.requirement,
        acceptance: args.acceptance,
        constraints: task.constraints,
        defaultTier: config.defaultTier,
      })

      const engineReport =
        `规则引擎建议档位：${proposal.proposedTier}（${TIERS[proposal.proposedTier].zh}）\n` +
        proposal.notes.map((n) => `  · ${n}`).join('\n') +
        (proposal.signals.length > 0
          ? `\n  命中的不平凡信号：\n${proposal.signals.map((s) => `    - [${s.tier}] ${s.why}（匹配「${s.matched}」）`).join('\n')}`
          : '')

      if (args.dry_run === true) {
        return {
          ok: true,
          dry_run: true,
          tier: proposal.proposedTier,
          ai_count: TIERS[proposal.proposedTier].total,
          roles: TIERS[proposal.proposedTier].execution.join('、'),
          sequence: TIERS[proposal.proposedTier].execution.join(' → '),
          summary: `【试算】未写入任何内容。\n${engineReport}\n\n若按此档位执行，角色清单为：${TIERS[proposal.proposedTier].execution.join(' / ')}。`,
        }
      }

      // --- 判定调用形态 ----------------------------------------------------
      const role = actor.role

      // ★ (a) 独立需求分析对话（L1+）：只交「需求分析结论」，**不产出角色清单**。
      if (role === ROLE.ORCHESTRATOR) {
        if (typeof args.tier === 'string' && args.tier.length > 0) {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              `需求分析不再接收 tier（你传的是 ${args.tier}）。\n` +
              '★ 本轮把「分配 AI」从需求分析移给了**计划 AI**（planner）—— 档位、角色清单、\n' +
              '用几个 AI、按什么顺序，全部由 pipeline_plan 产出。\n' +
              '你这一轮的产物是：任务卡 + 验收标准 + 边界条件 + 测试要点 + **需求不清楚处清单**。\n' +
              `\n【规则引擎的建议（仅供参考，不构成判断）】\n${engineReport}\n` +
              '下一步：调 pipeline_human_request { reason_kind: "requirement_confirmation", blocking: true, question_for_human: "<把 unclear_points 归成一个可确认的问句>" }，\n' +
              '      由主对话转告用户确认；用户确认后主对话才会把任务交给计划 AI。',
          }
        }
        return await submitRequirementAnalysis(args, actor, task, engineReport)
      }

      // ★ (b) 主对话：**只有 L0** 能走规则引擎自批（角色清单 + 需求档一起产出）。
      //    L1+ 一律要有独立的计划 AI —— 主对话不得自己产出角色清单。
      if (role === ROLE.MAIN) {
        if (config.l0OrchestratorSeparate === true) {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              '本插件配置为 l0OrchestratorSeparate=true：L0 也必须有独立的编排对话。' +
              '主对话不能自己产出角色清单 —— 请先 pipeline_dispatch 派出 orchestrator 做需求分析、再派 planner 做计划分配。',
          }
        }
        if (proposal.proposedTier !== 'L0') {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              `拒绝：主对话不能自己产出角色清单。\n\n${engineReport}\n\n` +
              `规则引擎判的是 ${proposal.proposedTier}，不是 L0 —— 这个需求需要**独立的需求分析 + 计划分配**。\n` +
              '正确的下一步：\n' +
              '  ① pipeline_dispatch role=orchestrator（需求分析出任务卡 + 不清楚处清单）；\n' +
              '  ② 需求分析把不清楚处提交主对话 → 你交**用户**确认；\n' +
              '  ③ 确认后 pipeline_dispatch role=planner（计划 + 自检 + 分配 AI）。\n' +
              '★ 主对话不自行判断要几个 AI。',
          }
        }
        // L0：由规则引擎自批，主对话只是"调用方"。
      } else {
        return {
          ok: false,
          tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
          summary: `只有主对话（main）或需求分析对话（orchestrator）能触需求分析，当前角色是「${roleLabel(role)}」。`,
        }
      }

      const finalTier = proposal.proposedTier
      const reason = `L0 自批：需求通过规则引擎的平凡性判据（未命中任何不平凡信号；文本 ${String(task.requirement).trim().length} 字符 ≤ 240；无声明约束）。`

      const res = await store.setRoster({
        taskId: task.id,
        tier: finalTier,
        reason,
        judgedBy: 'rule-engine',
        extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
        l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
        writers: args.writers,
        relayPolicy: args.relay_policy,
        acceptance: args.acceptance,
        testPoints: args.test_points,
        boundaries: args.boundaries,
        actorRole: ROLE.MAIN,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) {
        return { ok: false, summary: res.error, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false }
      }
      // ---------------------------------------------------------------------
      // ★ 需求留档：编排产出任务卡时**必须同时**落一份本地需求档。
      // ---------------------------------------------------------------------
      //
      // 为什么放在编排这一步：任务卡（档位 / 角色清单 / 验收标准）是这一课的全部产出，
      // 而"上下文会溢出、会失忆、席位会换人"意味着**这份产出必须落到盘上** ——
      // 否则它只活在编排那个会话的上下文里，那个会话一换，需求就没人说得清了。
      //
      // 档 = 人可读 markdown（requirement.md）+ 结构化 JSON（requirement.json），
      // 路径与 sha256 记进任务卡；**所有角色默认以该文件为准**。
      // ★ 更正 A：`requirement.md` 的**唯一写者**是留档 AI（archivist）。
      //   所以编排**只在 L0** 直接落档 —— L0 没有留档 AI（规则引擎档位），
      //   由规则引擎直接生成单一需求档；L1+ 一律走"各方落 records → 留档 AI 汇总"。
      // ★ 更正 A：L1+ 的 `requirement.md` 由**留档 AI** 汇总产生，编排不直接写它。
      //   编排把自己这份任务卡作为**自己那份记录**交出去（records/orchestrator.md），
      //   留档 AI 读它 + 各方记录，汇总成唯一的需求档。
      //   （L0 没有留档 AI，仍由规则引擎直接落档 —— 见下面的 writeRequirementDoc。）
      const mdBody = renderRequirementDoc({
        task: res.task,
        roster: res.roster,
        acceptance: Array.isArray(args.acceptance) ? args.acceptance : [],
        testPoints: Array.isArray(args.test_points) ? args.test_points : [],
        boundaries: Array.isArray(args.boundaries) ? args.boundaries : [],
        /**
         * ★ 缺陷 ⑧：提示**印进需求档**（所有角色以该文件为准），
         *   但**不往 `boundaries` 里塞条目** —— 那等于伪造需求分析的结论。
         */
        boundaryHint: boundaryHintLine({
          requirement: res.task.requirement,
          boundaries: Array.isArray(args.boundaries) ? args.boundaries : [],
        }),
        reason,
      })
      if (res.roster.tier !== 'L0') {
        // ⚠️ 本轮起这条分支**不可达**：只有 L0 走规则引擎自批（上面的 role 分支已经判过）。
        //    保留它会让"L1+ 也能从这里产出清单"变成一个看起来合法的口子，
        //    所以直接拒——任何到达这里的 L1+ 都是内部矛盾。
        return {
          ok: false,
          tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
          summary:
            `插件内部错误：非 L0 档位（${res.roster.tier}）不该由规则引擎自批，角色清单已回滚请人工检查。\n` +
            'L1+ 必须走：需求分析（pipeline_orchestrate）→ 用户确认 → 计划分配（pipeline_plan）。',
        }
      }

      const doc = await store.writeRequirementDoc({
        task: res.task,
        markdown: mdBody,
        structured: {
          task_id: res.task.id,
          requirement: res.task.requirement,
          deliverable_format: res.task.deliverable_format ?? null,
          tier: res.roster.tier,
          tier_zh: res.roster.tier_zh,
          orchestrator_mode: res.roster.orchestrator_mode,
          roles: res.roster.execution_roles,
          sequence: res.roster.sequence.map((s) => s.role),
          writers: res.roster.writers,
          relay_policy: res.roster.relay_policy,
          acceptance: res.roster.acceptance ?? [],
          test_points: res.roster.test_points ?? [],
          boundaries: res.roster.boundaries ?? [],
          reason,
        },
        by: ROLE.MAIN,
      })
      indexTask(res.task.id, res.task)

      /**
       * ★★ **缺陷 ⑤：L0 也要有改动基线**。
       *
       * 基线改前只在**计划**那一站记，而 L0 没有计划站（规则引擎自批）
       * ⇒ 审核的规则 R6「前后版本对比」在 L0 上**无判据可用**（真机 T-20261015-bb30bc
       * 的审核位只能手工清点）。
       *
       * 时机的口径与计划路径**逐字相同**：清单定稿、即将派活。
       * 记不上**不拦流程**（基线是审核的判据，不是开工的前提），如实写进摘要。
       */
      const baseline = await ensureL0Baseline({ store, task: res.task, reason })

      const r = res.roster
      /**
       * ★ **缺陷 ⑧（需求面口径，逐字照办）**：需求里若有数值入参、而 `boundaries`
       *   没提非有限入参，就在这里提示一句 —— **只提示**：不改任何实现行为，
       *   也**不替**需求分析往 `boundaries` 里塞条目（那等于伪造它的结论）。
       *   判据见 `lib/intake/boundary-hints.js`（认不出就什么都不说）。
       */
      const hintLine = boundaryHintLine({
        requirement: res.task.requirement,
        boundaries: Array.isArray(args.boundaries) ? args.boundaries : [],
      })
      return {
        ok: true,
        dry_run: false,
        tier: r.tier,
        ai_count: r.ai_count,
        roles: r.execution_roles.join('、'),
        sequence: r.sequence.map((s) => s.role).join(' → '),
        summary:
          `角色清单已产出（judged_by=${r.judged_by}）。\n` +
          `档位：${r.tier}（${r.tier_zh}） —— ${r.trigger}\n` +
          `需要几个独立对话：${r.ai_count} 个\n` +
          (r.writers
            ? [
                `编写席位：${r.writers.count} 个（本档上限 ${r.max_writers}）\n`,
                ...r.writers.partitions.map(
                  (p) =>
                    `  · ${p.seat}｜层 ${p.layer ?? '-'} → ${describeScopePaths(p.scope_paths)}` +
                    `${p.deliverables?.length ? `（${p.deliverables.join('、')}）` : ''}\n`,
                ),
                r.writers.reason ? `  为什么这么分：${r.writers.reason}\n` : '',
              ].filter((x) => x !== '').join('')
            : '') +
          `  对话：${r.conversations.map(roleLabel).join(' / ')}\n` +
          `  执行角色：${r.execution_roles.join(' / ')}\n` +
          `调用顺序：${r.sequence.map((s) => s.role).join(' → ')}\n` +
          `判断理由：${r.reason}\n` +
          `${describeL0Baseline(baseline)}\n` +
          (hintLine.length > 0 ? `${hintLine}\n` : '') +
          `需求档已落盘：.pipeline/${res.task.id}/requirement.md（${doc.version}，sha256 ${doc.sha256.slice(0, 16)}…）\n` +
          '  ★ 所有角色**以该文件为准**；路径靠**目录约定**，不再登记进任务卡。\n' +
          `\n${engineReport}\n` +
          '\n下一步：主对话用 pipeline_dispatch 按这个清单逐个派活（主对话不自行增减角色）。',
      }
    },
  })

  return { lastAnalysisOf, taskOpen, orchestrate }
}
