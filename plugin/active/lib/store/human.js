/**
 * dsh-pipeline · 任务存储 · 人工介入请求
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/human
 */

import { HUMAN_DECISION_KINDS, HUMAN_TIMEOUT_BEHAVIORS } from '../handoff.js'
import { ST, STATE_LABEL } from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
import { clip, nowIso, randomId } from '../util.js'
import { REPLY_CHANNELS, checkAnswerShape, buildHumanRequestEntry } from './shared.js'

/**
 * 任务存储 · 人工介入请求
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function humanMethods(ctx) {
  const {
    hashGateEscalateAfter,
    timeoutHours,
    requireHumanConfirmCode,
    now,
    audit,
    deny,
    loadTask,
    persist,
    reconcileHumanRequests,
  } = ctx

  return {
    // --- ★人工介入（用户只与主对话相连，这是唯一的上升通道）-------------------
    //
    // 四步：① 角色发起（submitHandoff kind=human_request，已在上面的通用路径里建好记录）
    //       ② 主对话转告（relayHumanRequest）—— 不改状态，只留痕
    //       ③ 用户答复（replyHumanRequest 的前半）—— 必须有来源依据
    //       ④ 据答复恢复（replyHumanRequest 的后半 → 状态回到被打断前的那个）

    /**
     * 建一条生命周期记录（由 `submitHandoff` 在 kind=human_request 时调用）。
     *
     * ★ 幂等：同一个 `handoff_id` 已经有登记就**原样返回**，不重复登记。
     *   真实构造逻辑在模块级 `buildHumanRequestEntry` —— 与兜底修复**共用同一份**，
     *   免得"登记"这件事出现两个实现（那正是这次事故的成因）。
     */
    createHumanRequestEntry(task, record, payload) {
      const existing = (task.human_requests ?? []).find((r) => r.handoff_id === record.handoff_id)
      if (existing !== undefined) return existing
      const entry = buildHumanRequestEntry(task, record, payload, timeoutHours)
      task.human_requests.push(entry)
      return entry
    },

    /**
     * ★ **兜底（事后补）**：从「交接物 + 状态」反推出缺的那条登记。
     *
     * 实现是工厂级的 `reconcileHumanRequests`（`loadTask` 读盘时也要用它，
     * 而那时还没法引用返回对象）—— 这里只是把它暴露给工具层，方便自测直接调。
     */
    reconcileHumanRequests(task) {
      return reconcileHumanRequests(task)
    },

    /**
     * ★ **登记闸（当场就不许漏）**：`human_request` 交接物落地时，登记必须同时落上。
     *
     * 两条提交路径（`pipeline_human_request` 与 `pipeline_handoff{kind:"human_request"}`）
     * 都汇到 `submitHandoff`，所以这一处覆盖那两条路。
     * 正常路径下这里必然是个 no-op（`createHumanRequestEntry` 刚建过）。
     *
     * @param {object} patched - 已把 payload 补进元数据的那份交接物记录
     * @returns {boolean} 是否补建了登记
     */
    async enforceHumanRequestRegistration(task, patched) {
      const recovered = reconcileHumanRequests(task)
      if (recovered === 0) return false
      const entry = (task.human_requests ?? []).find((r) => r.handoff_id === patched?.handoff_id) ?? null
      const aentry = await audit(task.id, ROLE.ORCHESTRATOR, 'human:recovered', {
        handoff_id: patched?.handoff_id ?? null,
        request_id: entry?.request_id ?? null,
        recovered,
        reason: '交接物在盘上但请求登记表里没有 —— 已按交接物 + awaiting_human 状态反推补登记',
      })
      task.history.push(aentry)
      await persist(task)
      return true
    },

    /** 查一条请求（按 id；不给就返回最近一条未答复的）。 */
    findHumanRequest(task, requestId) {
      if (typeof requestId === 'string' && requestId.length > 0) {
        return task.human_requests.find((r) => r.request_id === requestId) ?? null
      }
      for (let i = task.human_requests.length - 1; i >= 0; i--) {
        const r = task.human_requests[i]
        if (r.status !== 'answered' && r.status !== 'withdrawn') return r
      }
      return task.human_requests.at(-1) ?? null
    },

    /**
     * ② 主对话转告。**只有主对话能做**（守门也会拦，这里是第二道）。
     * 刻意**不改任务状态** —— 状态在发起那一刻就已经推到「等待人工答复」了，
     * 转告只是"我确实把话带到了"的留痕。
     */
    async relayHumanRequest(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话能把人工介入请求转告给用户，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：**用户的对话框只在主对话里** —— 执行/顾问角色根本没有对用户说话的通道。',
        )
      }
      const entry = this.findHumanRequest(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何人工介入请求。`)
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `请求 ${entry.request_id} 已经答复过了，不需要再转告。`)
      }

      entry.status = 'relayed'
      entry.relayed_at = nowIso(now())
      entry.relayed_by = ROLE.MAIN
      entry.relay_channel = typeof input.channel === 'string' && input.channel.length > 0 ? input.channel : 'chat'
      entry.relay_note = typeof input.note === 'string' ? input.note : ''
      entry.relay_count += 1
      // 确认码：转告时生成一次，之后不变。默认不强制用户回带（见配置 requireHumanConfirmCode）
      if (entry.confirm_code === null) entry.confirm_code = `HC-${randomId(4)}`

      const aentry = await audit(task.id, ROLE.MAIN, 'human:relay', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        relay_channel: entry.relay_channel,
        relay_count: entry.relay_count,
        to_user: true,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      const tail = [
        `请求：${entry.request_id}（${entry.from_role} 发起，${entry.reason_zh}）`,
        `阻塞：${entry.blocking ? `是（卡在 ${entry.blocked_stage || '未说明'}）` : '否'}`,
        `紧急度：${entry.urgency}　需要用户给：${HUMAN_DECISION_KINDS[entry.decision_kind] ?? entry.decision_kind}`,
        `无人回应时：${HUMAN_TIMEOUT_BEHAVIORS[entry.timeout_behavior] ?? entry.timeout_behavior}` +
          (entry.timeout_at ? `（截止 ${entry.timeout_at}）` : ''),
        '',
        '★ 转告给用户的内容（**照抄这段**，不要自己加技术判断）：',
        '',
        `  ${entry.question_for_human}`,
        ...(entry.context_for_human ? ['', `  背景：${entry.context_for_human}`] : []),
        ...(entry.options.length > 0
          ? ['', '  可选方案：', ...entry.options.map((o, i) => `   ${i + 1}) ${o.label} —— ${o.consequence}`)]
          : []),
        ...(entry.recommended ? ['', `  ${entry.from_role} 的建议（仅供参考，不是决定）：${entry.recommended}`] : []),
        '',
        `  确认码：${entry.confirm_code}（把这一行也带上，用户答复时可以回带它作为凭据）`,
        '',
        '主对话接下来只做两件事：把上面这段呈现给用户，然后把用户的答复原样记回来：',
        `  pipeline_human_reply { task_id: "${task.id}", request_id: "${entry.request_id}", user_quote: "<用户的原话>", ... }`,
        '★ 不要替用户选，也不要把这条请求标成"已解决" —— 没有用户答复就恢复不了。',
      ]
      return { ok: true, task, request: { ...entry }, summary: tail.join('\n') }
    },

    /**
     * ③④ 记录用户答复 + 据答复恢复状态。
     */
    async replyHumanRequest(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话能记录用户的答复，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '原因：用户的答复只会出现在主对话的对话框里；别的角色声称"用户说可以"是无源之言。',
        )
      }
      const entry = this.findHumanRequest(task, input.requestId)
      if (entry === null) return deny('NOT_FOUND', `任务 ${task.id} 没有任何人工介入请求。`)
      if (entry.status === 'answered') {
        return deny('ALREADY_ANSWERED', `请求 ${entry.request_id} 已经答复过了（${entry.answered_at}），不能重复答复。`)
      }

      // --- 顺序闸：没转告就不能有答复 --------------------------------------
      if (entry.relayed_at === null) {
        return deny(
          'NOT_RELAYED',
          `请求 ${entry.request_id} 还没有转告给用户，所以不可能有用户答复。\n` +
            '先调 pipeline_human_relay 把问题呈现给用户，拿到用户的原话之后再回来记录。\n' +
            '★ 这条判据挡的是"跳过转告、直接伪造一个答复"。',
        )
      }

      const source = input.answerSource === 'timeout' ? 'timeout' : 'user'

      if (source === 'timeout') {
        // --- 超时路径：不是"用户说了什么"，而是"事前声明的策略到期生效" ----
        if (entry.timeout_behavior === 'stay_blocked') {
          return deny(
            'TIMEOUT_POLICY_STAYS_BLOCKED',
            `请求 ${entry.request_id} 声明的是 timeout_behavior=stay_blocked（一直等），所以不能按超时放行。\n` +
              '要么等用户答复，要么由主对话调 pipeline_transition event=cancel 明确取消。',
          )
        }
        if (entry.timeout_at === null) {
          return deny(
            'NO_DEADLINE_DECLARED',
            `请求 ${entry.request_id} 没有声明截止时间（timeout_at 为空，且配置 humanRequestTimeoutHours=0）。\n` +
              '没有截止时间就不存在"超时"这回事 —— 让它按超时处理等于开一个绕过用户答复的后门。\n' +
              '要允许超时：发起时带 timeout_at，或把配置 humanRequestTimeoutHours 设成正数。',
          )
        }
        if (Date.parse(entry.timeout_at) > now().getTime()) {
          return deny('DEADLINE_NOT_REACHED', `请求 ${entry.request_id} 的截止时间是 ${entry.timeout_at}，还没到。`)
        }
        entry.status = 'answered'
        entry.answered_at = nowIso(now())
        entry.answer_source = 'timeout'
        entry.answer = {
          source: 'timeout',
          deadline: entry.timeout_at,
          applied_policy: entry.timeout_behavior,
          applied_option: entry.default_option || null,
        }
      } else {
        // --- 用户答复路径：必须有来源依据 ---------------------------------
        const quote = typeof input.userQuote === 'string' ? input.userQuote.trim() : ''
        if (quote.length === 0) {
          return deny(
            'MISSING_USER_QUOTE',
            `缺 user_quote：记录用户答复时必须带上**用户本人的原话**。\n` +
              '为什么这条是硬要求：本插件拦不住主对话编一句"用户说可以"，' +
              '但一条**没有原话**的答复连事后审计都无从下手。' +
              '带上原话之后，编造至少是"留下了一份可被用户本人核对的伪造记录"。',
          )
        }
        if (quote.length < 4) {
          return deny('USER_QUOTE_TOO_SHORT', `user_quote 只有 ${quote.length} 个字符，太短，不构成一句可核对的原话。`)
        }
        // 防"把问题原样抄回来当答复"
        const echoes = [entry.question_for_human, entry.recommended, ...entry.options.map((o) => o.label)]
          .filter((s) => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
        if (echoes.some((e) => e === quote)) {
          return deny(
            'USER_QUOTE_IS_ECHO',
            'user_quote 与请求里的问题/建议/选项标签**一字不差** —— 那不像用户说的话，像是把问题抄了一遍。\n' +
              '请记用户实际答复的原话。',
          )
        }
        const source1 = typeof input.replyChannel === 'string' && input.replyChannel.length > 0 ? input.replyChannel : 'chat'
        if (!REPLY_CHANNELS.includes(source1)) {
          return deny('BAD_REPLY_CHANNEL', `reply_channel 必须是 ${REPLY_CHANNELS.join(' / ')} 之一，当前是「${source1}」。`)
        }
        const attribution = typeof input.attribution === 'string' ? input.attribution.trim() : ''
        if (attribution.length === 0) {
          return deny(
            'MISSING_ATTRIBUTION',
            '缺 attribution：要写清这句答复是**谁、在哪**说的（例如"用户在当前会话里直接回复"）。\n' +
              '答复必须可归属 —— 否则审计里看不出这句话的出处。',
          )
        }
        if (requireHumanConfirmCode === true) {
          const code = typeof input.confirmCode === 'string' ? input.confirmCode.trim() : ''
          if (code !== entry.confirm_code) {
            return deny(
              'CONFIRM_CODE_MISMATCH',
              `本插件配置了 requireHumanConfirmCode=true：答复必须回带转告时给出的确认码。\n` +
                `期望：${entry.confirm_code}　实际：${code.length === 0 ? '（未提供）' : code}\n` +
                '这条把"主对话替用户拍板"的门槛抬高到"必须把确认码也一起编出来"。',
            )
          }
        }

        // --- 答复形状必须与 decision_kind 相符 -----------------------------
        const shape = checkAnswerShape(entry, input)
        if (shape.ok !== true) return deny('BAD_ANSWER_SHAPE', shape.error)

        entry.status = 'answered'
        entry.answered_at = nowIso(now())
        entry.answer_source = 'user'
        entry.answer = {
          source: 'user',
          user_quote: quote,
          reply_channel: source1,
          attribution,
          confirm_code: typeof input.confirmCode === 'string' ? input.confirmCode.trim() : null,
          ...shape.value,
        }
      }

      // ★ 全量测试审批链：如果这条人工请求是为它发起的，把答复**挂回链上**。
      //
      //   为什么必须回填：凭据判据（fullTestCredential）要看到 human.approved === true
      //   才可能放行 —— 光有一份 human_reply 文件不够，必须与那条链对上。
      const linked = this.linkHumanReplyToFullTest(task, {
        request_id: entry.request_id,
        decision: entry.answer?.decision ?? null,
        approved: entry.answer?.decision === 'approved' || entry.answer?.decision === 'yes',
        quote: entry.answer?.user_quote ?? '',
        answered_by: entry.answer?.attribution ?? 'human',
        answered_at: entry.answered_at,
        note: entry.answer?.note ?? '',
      })
      if (linked !== null) {
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'fulltest:human', {
            approval_id: linked.approval_id,
            approved: linked.human?.approved === true,
            quote: linked.human?.quote ?? '',
          }),
        )
      }

      const aentry = await audit(task.id, ROLE.MAIN, 'human:reply', {
        request_id: entry.request_id,
        from_role: entry.from_role,
        answer_source: entry.answer_source,
        user_quote: entry.answer?.user_quote ?? null,
        attribution: entry.answer?.attribution ?? null,
        reply_channel: entry.answer?.reply_channel ?? null,
        decision: entry.answer?.decision ?? null,
        applied_policy: entry.answer?.applied_policy ?? null,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      // --- ④ 据答复恢复 -----------------------------------------------------
      let resumed = null
      if (entry.blocking === true && task.state === ST.AWAITING_HUMAN) {
        const applied = await this.transition({
          taskId: task.id,
          event: 'human_reply',
          actorRole: ROLE.MAIN,
          actorAgentId: input.actorAgentId,
          note: `依据答复 ${entry.request_id}（${entry.answer_source}）恢复`,
        })
        if (applied.ok !== true) {
          // 状态没恢复成功：答复记录保留（它是事实），但把问题如实报出来。
          entry.resolved_at = nowIso(now())
          entry.resumed_to = null
          await persist(task)
          return deny(
            'RESUME_FAILED',
            `用户答复已记录（${entry.request_id}），但状态恢复失败：\n${applied.error}\n` +
              `任务当前仍在「${STATE_LABEL[task.state]}」。答复记录不会被撤销 —— 请人工处置。`,
          )
        }
        resumed = { from: applied.from, to: applied.to }
        entry.resolved_at = nowIso(now())
        entry.resumed_from = applied.from
        entry.resumed_to = applied.to
        const rentry = await audit(task.id, ROLE.MAIN, 'human:resume', {
          request_id: entry.request_id,
          based_on: entry.answer_source === 'timeout' ? entry.answer?.deadline : `用户原话：${clip(entry.answer?.user_quote ?? '', 160)}`,
          from: applied.from,
          to: applied.to,
          agent: input.actorAgentId,
        })
        task.history.push(rentry)
      } else if (entry.blocking === true) {
        entry.resolved_at = nowIso(now())
      }

      // ★★ 哈希闸门自动升级：用户答复过了 ⇒ 这件事**了结**，计数**重新武装**。
      //
      //   为什么是"重新武装"而不是"一次升级永久生效"：
      //   用户的答复未必真能解决问题（"你去看看是不是授权面本身给窄了"这种答复很常见）。
      //   若升级一次就永久失效，第 4 次以后的失败就**没有人管**了 ——
      //   那恰恰是这条机制要堵的"无限重交"。
      //   重新武装之后仍然是「连续 N 次不过 ⇒ 再交一次人工」：每 N 次都有人点头，
      //   不存在"没人看着的无限重交"。审计里 `gate:hash_rearm` 是这段的留痕。
      const escRec = task.hash_gate_escalation ?? null
      if (escRec !== null && escRec.request_id === entry.request_id && (escRec.answered_at === null || escRec.answered_at === undefined)) {
        escRec.answered_at = entry.answered_at
        escRec.answer_source = entry.answer_source
        escRec.user_quote = entry.answer?.user_quote ?? null
        escRec.resumed_to = entry.resumed_to ?? null
        escRec.rearm_at = nowIso(now())
        task.hash_gate_streak = 0
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'gate:hash_rearm', {
            round: escRec.round ?? null,
            request_id: entry.request_id,
            answer_source: entry.answer_source,
            user_quote: escRec.user_quote,
            resumed_to: escRec.resumed_to,
            streak_reset_to: 0,
            threshold: escRec.threshold ?? hashGateEscalateAfter,
          }),
        )
      }

      await persist(task)

      const lines = [
        `已记录答复并推进：${entry.request_id}`,
        `发起角色：${entry.from_role}　答复来源：${entry.answer_source === 'timeout' ? '超时策略' : '用户'}`,
        entry.answer_source === 'user'
          ? `用户原话：${clip(entry.answer.user_quote, 200)}\n归属：${entry.answer.attribution}（${entry.answer.reply_channel}）`
          : `按事前声明的策略处理：${entry.answer.applied_policy}${entry.answer.applied_option ? `（选项：${entry.answer.applied_option}）` : ''}`,
        `决定：${JSON.stringify(entry.answer.decision ?? entry.answer.applied_option ?? null)}`,
        resumed === null
          ? '（这条请求是非阻塞的，或任务已不在「等待人工答复」，状态未变。）'
          : `任务状态：${STATE_LABEL[resumed.from]} → ${STATE_LABEL[resumed.to]}`,
        '',
        '四步留痕（都在 audit.jsonl 与 task.json 里）：',
        `  ① 发起  human:request  ${entry.request_id}  by ${entry.from_role}`,
        `  ② 转告  human:relay    ${entry.relayed_at}  by main`,
        `  ③ 答复  human:reply    ${entry.answered_at}  source=${entry.answer_source}`,
        resumed === null ? '  ④ 恢复  （本请求未阻塞，无需恢复）' : `  ④ 恢复  human:resume   ${entry.resolved_at}  → ${entry.resumed_to}`,
        '',
        `下一步：把结果回投给「${entry.from_role}」那个角色 —— 用 pipeline_dispatch 重新派活即可（状态已经回到它该在的地方）。`,
      ]
      return { ok: true, task, request: { ...entry }, resumed, summary: lines.join('\n') }
    },

    /** 列出人工介入请求（主对话收件箱）。 */
    async listHumanRequests(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const all = task.human_requests
      const pending = all.filter((r) => r.status !== 'answered' && r.status !== 'withdrawn')
      return { ok: true, task, all, pending }
    },
  }
}
