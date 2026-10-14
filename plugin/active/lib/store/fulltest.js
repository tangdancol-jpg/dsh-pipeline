/**
 * dsh-pipeline · 任务存储 · 全量测试审批链
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/fulltest
 */

import { ROLE, roleLabel } from '../roles.js'
import { nowIso, shortHash, toStringArray } from '../util.js'
import { nextFullTestStage } from '../testscope.js'

/**
 * 任务存储 · 全量测试审批链
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function fullTestMethods(ctx) {
  const { now, deny } = ctx

  return {
    // --- ★全量测试审批链（四级：需求分析 → 审核 → 人工 → 计划）----------------
    //
    //   用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
    //   必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
    //   确认人工通过后再提交给计划 ai 安排」。
    //
    //   ★ 与**澄清梯**的分工（写清"回答的是哪个不同的问题"，否则以后必然混）：
    //     · 澄清梯（clarification_*）回答「**需求本身清不清楚**」；
    //     · 这条链（full_test_*）  回答「**这套测试值不值得跑**」—— 成本决策，不改需求。
    //   两者形状相同（提出 → 逐级裁定 → 顶到人工），所以**合流在同一套两级梯机制上**：
    //   人工那一站用的就是既有的 human_request / human_reply，不另起并行机制。

    /** 找当前在办的那条链（最近的 pending）。 */
    fullTestChain(task) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      for (let i = list.length - 1; i >= 0; i--) if (list[i].status === 'pending') return list[i]
      return null
    },

    /** 按 request_id / handoff_id 找链。 */
    findFullTestChain(task, requestId) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const key = String(requestId ?? '')
      return (
        list.find((c) => c.approval_id === key) ??
        list.find((c) => c.request?.handoff_id === key) ??
        list.find((c) => c.request?.request_id === key) ??
        null
      )
    },

    /** ① 测试提出「要跑全量」→ 建一条链。 */
    applyFullTestRequest(task, record, payload) {
      const open = this.fullTestChain(task)
      if (open !== null) {
        return deny(
          'FULL_TEST_ALREADY_PENDING',
          `已经有一条**在办**的全量测试申请（${open.approval_id}，下一站：${nextFullTestStage(open)}）。\n` +
            '★ 不许并行开第二条 —— 一条链走完（批准或否决）才能再提。\n' +
            `  · 看进度：pipeline_full_test action=status\n` +
            `  · 撤回：让测试角色把这条链走完（任一站的裁定都能让它结案）`,
        )
      }
      const round = (Array.isArray(task.full_test_approvals) ? task.full_test_approvals.length : 0) + 1
      const chain = {
        approval_id: `FTA-${shortHash(`${task.id}|${round}|${payload.what_will_run}`)}`,
        round,
        created_at: nowIso(now()),
        created_by: ROLE.TESTER,
        status: 'pending',
        rejected_at_stage: null,
        reject_reason: '',
        request: {
          handoff_id: record.handoff_id,
          request_id: record.handoff_id,
          affected_paths: toStringArray(payload.affected_paths),
          targeted_already_run: toStringArray(payload.targeted_already_run),
          why_targeted_insufficient: String(payload.why_targeted_insufficient ?? ''),
          what_will_run: String(payload.what_will_run ?? ''),
          estimated_cost: String(payload.estimated_cost ?? ''),
        },
        need: null,
        worth: null,
        human: null,
        arranged: null,
      }
      task.full_test_approvals = task.full_test_approvals ?? []
      task.full_test_approvals.push(chain)
      return { ok: true, chain }
    },

    /** ②③④ 三站裁定（顺序由这里判，不靠自觉）。 */
    applyFullTestReview(task, record, payload, actorRole) {
      const chain = this.findFullTestChain(task, payload.request_id)
      if (chain === null) {
        return deny(
          'FULL_TEST_REQUEST_NOT_FOUND',
          `找不到申请「${payload.request_id}」—— 全量测试的每一站裁定都必须回给一条**存在**的 full_test_request。\n` +
            `当前任务的链：${(task.full_test_approvals ?? []).map((c) => `${c.approval_id}(${c.status})`).join('、') || '（一条都没有）'}`,
        )
      }
      if (chain.status !== 'pending') {
        return deny(
          'FULL_TEST_CHAIN_CLOSED',
          `申请 ${chain.approval_id} 已经结案（${chain.status}${chain.rejected_at_stage === null ? '' : `，停在 ${chain.rejected_at_stage} 站`}）。\n` +
            '★ 结案的链不能再往上加裁定：要么让测试重新提一条，要么按结论执行。',
        )
      }
      const stage = String(payload.stage ?? '')
      const expected = actorRole === ROLE.ORCHESTRATOR ? 'need' : actorRole === ROLE.REVIEWER ? 'worth' : actorRole === ROLE.PLANNER ? 'arrange' : ''
      if (expected === '' || expected !== stage) {
        return deny(
          'FULL_TEST_STAGE_MISMATCH',
          `这一站不该由「${roleLabel(actorRole)}」来判，或者 stage 写错了。\n` +
            `  · 需求分析 → stage=need（这次**是否真的需要**）\n` +
            `  · 审核     → stage=worth（**值不值得**跑）\n` +
            `  · 计划     → stage=arrange（**怎么跑**、范围与最终命令）\n` +
            `你交的是 stage=${stage || '(空)'}。★ 顺序不能换、不能跳 —— 那是这条链的意义。`,
        )
      }
      // ★ 顺序：need → worth → arrange，缺一级都不许往下走
      if (stage === 'worth' && (chain.need === null || chain.need.ok !== true)) {
        return deny(
          'FULL_TEST_STAGE_OUT_OF_ORDER',
          '顺序不对：审核那一站（worth）必须在**需求分析先认可**之后。\n' +
            (chain.need === null ? '  · 需求分析还没裁定（need 为空）\n' : `  · 需求分析裁定是 ok=${chain.need.ok}\n`) +
            '★ 缺一级都不许开跑 —— 这条链的顺序本身就是判据。',
        )
      }
      if (stage === 'arrange') {
        if (chain.worth === null || chain.worth.ok !== true) {
          return deny(
            'FULL_TEST_STAGE_OUT_OF_ORDER',
            '顺序不对：计划那一站（arrange）必须在**需求分析与审核都认可**之后。\n' +
              `  · need=${chain.need === null ? '(空)' : chain.need.ok}　worth=${chain.worth === null ? '(空)' : chain.worth.ok}\n` +
              '★ 缺一级都不许开跑。',
          )
        }
        if (chain.human === null || chain.human.approved !== true) {
          return deny(
            'FULL_TEST_HUMAN_NOT_APPROVED',
            '顺序不对：计划那一站（arrange）必须在**用户人工通过**之后。\n' +
              (chain.human === null
                ? '  · 还没有对应的 human_request / human_reply（主对话还没把这件事交给用户）\n'
                : `  · 人工答复是 approved=${chain.human.approved}\n`) +
              '★ 用户没点头，计划 AI 不能安排全量测试。\n' +
              '下一步：由主对话发起 pipeline_human_request（reason_kind=full_test_approval）拿到用户答复。',
          )
        }
      }
      const stageRec = {
        ok: payload.ok === true,
        by: actorRole,
        at: nowIso(now()),
        reason: String(payload.reason ?? ''),
        handoff_id: record.handoff_id,
      }
      if (stage === 'need') {
        stageRec.necessity = String(payload.necessity ?? '')
        chain.need = stageRec
      } else if (stage === 'worth') {
        stageRec.worth_it = String(payload.worth_it ?? '')
        chain.worth = stageRec
      } else {
        stageRec.scope = String(payload.scope ?? '')
        stageRec.command = String(payload.command ?? '')
        stageRec.notes = String(payload.notes ?? '')
        if (payload.ok === true && stageRec.command.trim().length === 0) {
          return deny(
            'FULL_TEST_NO_COMMAND',
            '计划那一站同意时必须给出**最终批准的命令**（command）——\n' +
              '放行时守门会拿实际要跑的命令与它比对，避免"批了一条、跑另一条"。\n' +
              `测试申请里写的是：${chain.request.what_will_run || '(空)'}`,
          )
        }
        chain.arranged = stageRec
      }
      // 任一站否决 ⇒ 整条链停住（留痕）
      if (payload.ok !== true) {
        chain.status = 'rejected'
        chain.rejected_at_stage = stage
        chain.reject_reason = String(payload.reason ?? '')
      } else if (chain.need?.ok === true && chain.worth?.ok === true && chain.human?.approved === true && chain.arranged !== null) {
        chain.status = 'approved'
      }
      return { ok: true, chain }
    },

    /**
     * ★ 人工答复回填：主对话拿到用户答复后，把结果**挂回那条链**。
     *
     * 为什么必须回填：凭据判据（`fullTestCredential`）要看到 `human.approved === true`
     * 才可能放行 —— 光有一份 human_reply 文件是不够的，必须与链对上。
     */
    linkHumanReplyToFullTest(task, humanRequest) {
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const chain = list.find((c) => c.human !== null && c.human.request_id === humanRequest.request_id) ?? null
      if (chain === null) return null
      const approved = humanRequest.decision === 'approved' || humanRequest.approved === true || humanRequest.decision === 'yes'
      chain.human = {
        request_id: humanRequest.request_id,
        reply_id: humanRequest.reply_id ?? humanRequest.reply_handoff_id ?? null,
        approved: approved === true,
        quote: String(humanRequest.quote ?? humanRequest.user_quote ?? ''),
        by: humanRequest.answered_by ?? 'human',
        at: humanRequest.answered_at ?? nowIso(now()),
      }
      if (approved !== true) {
        chain.status = 'rejected'
        chain.rejected_at_stage = 'human'
        chain.reject_reason = String(humanRequest.note ?? humanRequest.reply_note ?? '用户未通过')
      } else if (chain.need?.ok === true && chain.worth?.ok === true && chain.arranged !== null) {
        chain.status = 'approved'
      }
      return chain
    },

    /** 主对话发起人工审核时，把链与那条 human_request 对上。 */
    attachFullTestHumanRequest(task, chain, humanRequest) {
      if (chain === null || humanRequest === null) return
      chain.human = {
        request_id: humanRequest.request_id,
        reply_id: null,
        approved: null,
        quote: '',
        by: 'main',
        at: nowIso(now()),
      }
    },
  }
}
