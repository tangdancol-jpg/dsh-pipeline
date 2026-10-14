/**
 * dsh-pipeline · 任务存储 · 澄清请求与边界
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/clarify
 */

import { ROLES_CAN_RAISE_HUMAN, ST, STATE_LABEL, WAITING_STATES } from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
import { nowIso, shortHash, toStringArray } from '../util.js'
import { hashGateEscalationPending } from '../hashgate.js'

/**
 * 任务存储 · 澄清请求与边界
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function clarifyMethods(ctx) {
  const { hashGateEscalateAfter, maxClarifyRounds, now, audit, deny, loadTask, persist } = ctx

  return {
    // --- ★两级升级梯 · 第一级（角色 → 需求分析）------------------------------

    /** 同一问题的去重键（防踢皮球用）。 */
    questionKeyOf(taskId, fromRole, stage, question) {
      const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[？?。.！!，,、；;：:]/g, '')
      return shortHash(`${taskId}|${fromRole}|${norm(stage)}|${norm(question)}`)
    },

    /** 建一条澄清请求的生命周期记录。 */
    createClarificationEntry(task, record, payload) {
      const p = payload ?? {}
      const fromRole = p.from_role
      const key = this.questionKeyOf(task.id, fromRole, p.stage, p.question)
      const priorSame = (task.clarification_requests ?? []).filter((r) => r.question_key === key)
      const entry = {
        request_id: `CQ-${shortHash(`${task.id}|${record.handoff_id}|${key}|${(task.clarification_requests ?? []).length}`)}`,
        handoff_id: record.handoff_id,
        task_id: task.id,
        from_role: fromRole,
        to_role: ROLE.ORCHESTRATOR,
        question_key: key,
        round: priorSame.length + 1,
        stage: p.stage,
        question: p.question,
        context_digest: typeof p.context_digest === 'string' ? p.context_digest : '',
        options: Array.isArray(p.options) ? p.options.map((o) => ({ label: String(o?.label ?? ''), consequence: String(o?.consequence ?? '') })) : [],
        blocking: p.blocking === true,
        urgency: p.urgency,
        deadline: typeof p.deadline === 'string' ? p.deadline : '',
        state_at_request: WAITING_STATES.includes(task.state) && typeof task.previous_state === 'string' ? task.previous_state : task.state,
        status: 'pending', // pending → answered | escalated
        answered_at: null,
        verdict: null,
        answer: null,
        reason: null,
        constraints_added: [],
        escalated_at: null,
        escalated_to: null,
        resolved_at: null,
        resumed_to: null,
        resumed_from: null,
      }
      task.clarification_requests = task.clarification_requests ?? []
      task.clarification_requests.push(entry)
      return entry
    },

    /** 查一条澄清请求（按 id；不给就返回最近一条未答复的）。 */
    findClarification(task, requestId) {
      const all = task.clarification_requests ?? []
      if (typeof requestId === 'string' && requestId.length > 0) {
        return all.find((r) => r.request_id === requestId || r.handoff_id === requestId) ?? null
      }
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].status === 'pending') return all[i]
      }
      return all.at(-1) ?? null
    },

    /** 列出澄清请求（需求分析的收件箱）。 */
    async listClarifications(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const all = task.clarification_requests ?? []
      const pending = all.filter((r) => r.status === 'pending')
      return { ok: true, task, all, pending }
    },

    /**
     * ★ 需求分析的裁定：answered（给结论）或 cannot_answer（答不了，准备升级）。
     *
     * **只有需求分析能调**（守门也拦一层）。
     */
    async replyClarification(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.ORCHESTRATOR) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有「需求分析」能裁定澄清请求，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：这一级的存在意义就是"由需求分析在需求层先把能定的定掉"。别的角色代替它裁定，等于这一级不存在。',
        )
      }
      const entry = this.findClarification(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何澄清请求。`)

      if (entry.escalated_at !== null) {
        return deny(
          'ALREADY_ESCALATED',
          `澄清请求 ${entry.request_id} 已经**升级**给人工了（${entry.escalated_at}），不能再由需求分析裁定。\n` +
            '★ 这是刻意设计的**单向门**：一旦升级，就只剩用户答复这一条出路 ——\n' +
            '否则"先升级、再自己改口"会变成绕开用户的旁路，用户那边的待办也永远清不掉。',
        )
      }
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `澄清请求 ${entry.request_id} 已经裁定过了（${entry.answered_at}），不能重复裁定。`)
      }

      const verdict = input.verdict === 'cannot_answer' ? 'cannot_answer' : 'answered'
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      const answer = typeof input.answer === 'string' ? input.answer.trim() : ''

      if (verdict === 'answered') {
        // ★ 防"把能答的推给用户"：答了就**必须**给出结论。
        if (answer.length === 0) {
          return deny('EMPTY_ANSWER', 'verdict=answered 时必须给 answer —— 说了"答得了"却没结论，发起角色拿不到东西。')
        }
        // ★ 需求分析的**边界**：它只裁需求层的事。越界去裁实现细节会被点名。
        const boundary = this.checkOrchestratorBoundary(entry, answer)
        if (boundary.warn !== null) {
          // 警告不阻断（需求层的判断本来就有灰色地带），但**写进审计**，让越界看得见。
          entry.boundary_warning = boundary.warn
        }
      }

      if (verdict === 'cannot_answer' && reason.length === 0) {
        return deny(
          'MISSING_REASON',
          'verdict=cannot_answer 时必须给 reason（为什么需求分析答不了）。\n' +
            '★ 这条是"防踢皮球"的第一道：说不出为什么答不了，就不许往上推。\n' +
            '合法的理由类型：需要用户拍板 / 涉及新需求（超出原任务卡范围）/ 需求层内部冲突无法自解 / 缺环境或权限。/\n' +
            '非法的理由：这个我不太懂 / 让用户决定吧 / 实现细节我不管（那些属于本可以在需求层裁定的事）。',
        )
      }

      entry.status = 'answered'
      entry.answered_at = nowIso(now())
      entry.verdict = verdict
      entry.answer = verdict === 'answered' ? answer : null
      entry.reason = reason
      entry.constraints_added = toStringArray(input.constraintsAdded)

      const aentry = await audit(task.id, ROLE.ORCHESTRATOR, 'clarify:reply', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        verdict,
        answer: entry.answer,
        reason: entry.reason,
        constraints_added: entry.constraints_added,
        round: entry.round,
        boundary_warning: entry.boundary_warning ?? null,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      // 恢复状态（回到被打断前的那个）
      let resumed = null
      if (entry.blocking === true && task.state === ST.AWAITING_CLARIFICATION) {
        const applied = await this.transition({
          taskId: task.id,
          event: 'clarification_reply',
          actorRole: ROLE.ORCHESTRATOR,
          actorAgentId: input.actorAgentId,
          note: `依据裁定 ${entry.request_id}（${verdict}）恢复`,
        })
        if (applied.ok !== true) {
          entry.resolved_at = nowIso(now())
          await persist(task)
          return deny(
            'RESUME_FAILED',
            `裁定已记录（${entry.request_id}），但状态恢复失败：\n${applied.error}\n` +
              `任务当前仍在「${STATE_LABEL[task.state]}」。裁定不会被撤销 —— 请人工处置。`,
          )
        }
        resumed = { from: applied.from, to: applied.to }
        entry.resolved_at = nowIso(now())
        entry.resumed_from = applied.from
        entry.resumed_to = applied.to
        const rentry = await audit(task.id, ROLE.ORCHESTRATOR, 'clarify:resume', {
          request_id: entry.request_id,
          from: applied.from,
          to: applied.to,
          agent: input.actorAgentId,
        })
        task.history.push(rentry)
      }
      await persist(task)

      const lines = [
        `已裁定：${entry.request_id}（${verdict === 'answered' ? '需求分析直接答复' : '需求分析答不了'}）`,
        `发起角色：${entry.from_role}　卡在哪：${entry.stage}`,
        verdict === 'answered' ? `结论：${answer}` : `为什么答不了：${reason}`,
        reason.length > 0 && verdict === 'answered' ? `依据：${reason}` : '',
        entry.constraints_added.length > 0 ? `新增/收紧的约束：${entry.constraints_added.join('；')}` : '',
        entry.boundary_warning !== null && entry.boundary_warning !== undefined ? `⚠ ${entry.boundary_warning}` : '',
        resumed === null
          ? entry.blocking === true
            ? '（任务已不在「等待需求分析答复」，状态未变。）'
            : '（这是非阻塞提问：任务可以继续推进，但结论仍要回投给发起角色。）'
          : `任务状态：${STATE_LABEL[resumed.from]} → ${STATE_LABEL[resumed.to]}`,
        '',
        '留痕（audit.jsonl）：',
        `  ① 提问  clarify:request  ${entry.request_id}  by ${entry.from_role}`,
        `  ② 裁定  clarify:reply    ${entry.answered_at}  verdict=${verdict}`,
        resumed === null ? '  ③ 恢复  （本条未阻塞，无需恢复）' : `  ③ 恢复  clarify:resume   ${entry.resolved_at}  → ${entry.resumed_to}`,
        '',
        verdict === 'cannot_answer'
          ? `下一步：把它**升级**给用户 —— pipeline_human_request { ..., escalated_from: "${entry.handoff_id}", raised_by: "${entry.from_role}", orchestrator_reason: "<为什么答不了>" }`
          : `下一步：把结论回投给「${entry.from_role}」—— 用 pipeline_dispatch 重新派活即可（状态已经回到它该在的地方）。`,
      ].filter((x) => x !== '')
      return { ok: true, task, request: { ...entry }, resumed, summary: lines.join('\n') }
    },

    /**
     * 需求分析的**边界**检查：它该裁需求层的事，不该裁实现细节。
     * 命中"越界词"时返回一句警告（**不阻断**，但写进审计）。
     */
    checkOrchestratorBoundary(entry, answer) {
      const impl = /(用哪个库|哪个框架|函数怎么实现|算法选|变量名|代码风格|lint|重构方式|怎么写的)/i
      if (impl.test(answer)) {
        return {
          warn:
            `需求分析的答复里出现了实现层措辞（${answer.match(impl)?.[0]}）。\n` +
            '边界：需求分析裁的是**需求层**（验收标准、边界条件、优先级、范围取舍、测试要点）；\n' +
            '实现层（用哪个库、怎么写）应由发起角色自己定。这次不阻断，但已记入审计。',
        }
      }
      return { warn: null }
    },

    /**
     * ★ **防踢皮球**闸 + **升级通道**闸（合在一条，因为它们回答的是同一个问题：
     *   "这条 human_request 到底该不该走这条路"）。
     *
     * 三条规则：
     *   ① **单向门**：已升级的澄清请求不能再被需求分析裁定（在 replyClarification 里拦）。
     *   ② **同一问题不得反复问**：同一个 question_key 问超过 `maxClarificationRounds` 次就拒。
     *   ③ **跳级闸**：roster 里有独立 orchestrator 时，执行/顾问角色**不能**直接发 human_request，
     *      必须先走第一级。（L0 没有独立 orchestrator ⇒ 直接发是**合法**路径，放行。）
     *
     * ★ 本轮新增第 ⓪ 条（用户拍板 P13，哈希闸门连续不通过 ⇒ 自动交人工）：
     *   `reason_kind=hash_gate_escalation` **只有机制发得出来** ——
     *   角色走 `pipeline_handoff` 发它会被明确拒（`HASH_GATE_ESCALATION_IS_SYSTEM`）。
     *   为什么不让角色发：这条请求的全部意义是"**阈值到了**"，
     *   而阈值是机制数的数 —— 让角色自己声明"我已经连续失败 3 次"就等于把
     *   "什么时候该惊动用户"交给被考核的那一方去定。
     *
     * @param {object} task
     * @param {object} payload
     * @param {string} actorRole
     * @param {{systemEscalation?:boolean}} [opts] - `systemEscalation`：由 store 内部触发（不是角色触发）
     */
    async checkHumanRequestChannel(task, payload, actorRole, opts = {}) {
      const mode = task.roster?.orchestrator_mode ?? null

      // --- ⓪ ★机制自动升级：哈希闸门连续不通过 -------------------------------
      //
      //   判据三条，缺一不可（它们共同保证"这条请求不是谁想发就能发"）：
      //     ① 必须由机制触发（`systemEscalation`）；
      //     ② 配置里阈值必须真的开着（`hashGateEscalateAfter > 0`）；
      //     ③ 任务上的连续计数必须**真的到了阈值**（这是与"计数"唯一的对账点）。
      //   另外：已经升级且还没答复时，不许再叠一条（否则一次失败刷出一堆请求）。
      if (payload?.reason_kind === 'hash_gate_escalation') {
        if (opts.systemEscalation !== true) {
          return deny(
            'HASH_GATE_ESCALATION_IS_SYSTEM',
            '拒绝：`reason_kind=hash_gate_escalation`（哈希闸门连续不通过）**只能由机制自动发起**，角色不能自己发。\n' +
              '★ 为什么：这条请求的全部意义是"**连续失败的次数到了阈值**" —— 而那个数是机制数的。\n' +
              '  让角色自己声明"我已经连续失败 3 次"，等于把"什么时候该惊动用户"交给被考核的那一方去定。\n' +
              '★ 你要问用户的如果是别的事，按用途选一个 reason_kind（需求歧义 / 范围变更 / 需要审批 / 安全否决 …）。',
          )
        }
        if (!Number.isInteger(hashGateEscalateAfter) || hashGateEscalateAfter <= 0) {
          return deny(
            'HASH_GATE_ESCALATION_DISABLED',
            `拒绝：配置 hashGateEscalateAfter=${hashGateEscalateAfter} —— 自动升级**关着**，不该出现这条请求（插件内部错误）。`,
          )
        }
        const streak = Number.isInteger(task.hash_gate_streak) ? task.hash_gate_streak : 0
        if (streak < hashGateEscalateAfter) {
          return deny(
            'HASH_GATE_ESCALATION_TOO_EARLY',
            `拒绝：连续不过计数是 ${streak}，还没到阈值 ${hashGateEscalateAfter} —— 不该升级（插件内部错误）。`,
          )
        }
        if (hashGateEscalationPending(task)) {
          return deny(
            'HASH_GATE_ESCALATION_PENDING',
            `拒绝：本任务已经有一条还没答复的哈希闸门升级（${task.hash_gate_escalation?.request_id ?? '?'}）—— 不重复打扰用户。`,
          )
        }
        return { ok: true }
      }

      // --- ③ 跳级闸 ---------------------------------------------------------
      if (mode === 'separate') {
        if (actorRole === ROLE.ORCHESTRATOR) {
          // 需求分析自己发 human_request —— 这就是**升级**，或者是**需求确认**。
          // 两条合法路径（本轮把第二条从"歧义"扩成"歧义 + 固定确认"）：
          //   ① 需求本身有歧义 / 需要用户确认这份分析（reason_kind 在下面这个名单里）
          //      —— 那本来就是需求分析的份内事，可以不带上游；
          //   ② 升级：带 escalated_from（某个 clarification_request），并带 raised_by 与
          //      orchestrator_reason。
          const from = typeof payload?.escalated_from === 'string' ? payload.escalated_from.trim() : ''
          if (from.length === 0) {
            const kind = payload?.reason_kind
            // ★ 本轮新增 requirement_confirmation：澄清前置到人工那一步用的就是它。
            //   为什么不新开状态：见 states.js 里 `requirement_confirmed` 那条边的注释 ——
            //   这一段与 human_request 链**完全同构**，差别只在"问的是什么"，
            //   而那件事由一个数据字段（reason_kind）回答就够了。
            const selfKinds = ['requirement_ambiguous', 'requirement_confirmation']
            if (!selfKinds.includes(kind)) {
              return deny(
                'ESCALATION_NEEDS_SOURCE',
                `需求分析发 human_request 时，必须说明**这是从哪来的**。\n` +
                  `两条合法路径：\n` +
                  `  ① 升级：escalated_from = 某个 clarification_request 的 handoff_id，并带上 raised_by 与 orchestrator_reason；\n` +
                  `  ② 需求本身有歧义 / 请用户确认需求分析结论（reason_kind=${selfKinds.join(' 或 ')}）` +
                  `—— 那本来就是需求分析的份内事，可以不带上游。\n` +
                  `当前 reason_kind=${kind ?? '(未给)'}，且没有 escalated_from。`,
              )
            }
            return { ok: true }
          }
          const entry = (task.clarification_requests ?? []).find((r) => r.handoff_id === from || r.request_id === from)
          if (entry === undefined) {
            return deny(
              'ESCALATION_SOURCE_NOT_FOUND',
              `escalated_from=${from} 指不到任何 clarification_request。\n` +
                '升级必须挂在**真实存在**的上游请求上 —— 否则"我升级了一个别人没问过的问题"无从追溯。',
            )
          }
          if (entry.status !== 'answered' || entry.verdict !== 'cannot_answer') {
            return deny(
              'ESCALATION_SOURCE_NOT_DECLINED',
              `clarification_request ${entry.request_id} 的状态是 ${entry.status}（verdict=${entry.verdict ?? '无'}），\n` +
                '不是"需求分析答不了"。\n' +
                '★ 只能升级**自己确实答不了**的问题 —— 能答而推给用户，就是踢皮球。\n' +
                '先 pipeline_clarify_reply 给出 cannot_answer 的裁定（带理由），再来升级。',
            )
          }
          if (typeof payload?.raised_by !== 'string' || payload.raised_by !== entry.from_role) {
            return deny(
              'ESCALATION_RAISED_BY_MISMATCH',
              `raised_by=${payload?.raised_by ?? '(未给)'} 与上游请求的发起角色 ${entry.from_role} 不一致。\n` +
                '升级必须写清"这事原本是谁问的" —— 用户答复要能回投给那个人。',
            )
          }
          if (typeof payload?.orchestrator_reason !== 'string' || payload.orchestrator_reason.trim().length === 0) {
            return deny('ESCALATION_NEEDS_REASON', '升级时必须给 orchestrator_reason（为什么需求分析答不了）。用户有权知道为什么这事轮到他拍板。')
          }
          return { ok: true, escalated: entry }
        }

        // 执行/顾问角色：不许跳级
        if (ROLES_CAN_RAISE_HUMAN.includes(actorRole) && actorRole !== 'human') {
          const open = (task.clarification_requests ?? []).filter((r) => r.status === 'pending')
          return deny(
            'MUST_ASK_ORCHESTRATOR_FIRST',
            `跳级：`+`${roleLabel(actorRole)}不能直接向用户发起人工介入。\n` +
              '★ 这个任务有**独立的需求分析**对话，所以人工介入是**两级**的：\n' +
              `   ① 你先提交 clarification_request 问它（需求层的事它多半能直接答，用户根本不用被打扰）；\n` +
              `   ② 它确实答不了时，**由它**升级成 human_request 转给用户。\n` +
              `当前待答复的澄清请求：${open.length > 0 ? open.map((r) => r.request_id).join('、') : '（无）'}\n` +
              '下一步：pipeline_clarify_request { task_id, stage, question, context_digest, blocking, urgency }。\n' +
              `（只有 L0 档没有独立编排对话，那时直接发 human_request 才是合法的 —— 当前档位 ${task.roster?.tier ?? '未知'}，orchestrator_mode=separate。）`,
          )
        }
      }

      // --- ② 同一问题反复问 ------------------------------------------------
      if (mode === 'separate' && actorRole !== ROLE.ORCHESTRATOR) return { ok: true }
      return { ok: true }
    },

    /** ★ 同一个 question_key 允许问几次（默认 2：允许"答完还不明白再问一次"，之后必须升级）。 */
    checkClarificationPingPong(task, payload) {
      const key = this.questionKeyOf(task.id, payload?.from_role, payload?.stage, payload?.question)
      const prior = (task.clarification_requests ?? []).filter((r) => r.question_key === key)
      const cap = Number.isInteger(maxClarifyRounds) && maxClarifyRounds > 0 ? maxClarifyRounds : 2
      if (prior.length >= cap) {
        const last = prior.at(-1)
        return deny(
          'CLARIFICATION_PINGPONG',
          `防踢皮球：同一个问题已经问过 ${prior.length} 次（上限 ${cap} 次）。\n` +
            `问题：${payload?.question}\n` +
            `上一次：${last?.request_id}，状态 ${last?.status}${last?.verdict ? `（verdict=${last.verdict}）` : ''}\n` +
            '★ 反复问同一件事说明它不是"需求层能定的" —— 那就该走升级路径，而不是在原地打转。\n' +
            (last?.status === 'answered' && last?.verdict === 'cannot_answer'
              ? `下一步：让需求分析把它升级给用户（pipeline_human_request 带 escalated_from="${last.handoff_id}"）。`
              : last?.status === 'pending'
                ? `下一步：先等 / 催需求分析对 ${last.request_id} 出裁定。`
                : '下一步：走 pipeline_human_request 升级给用户（带 escalated_from）。'),
        )
      }
      return { ok: true }
    },
  }
}
