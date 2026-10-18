// DEMO 存储 · 阶段推进与轮次落账：档位结论 / 交付席位交内容 / 主对话定稿一轮 / 记确认。
/**
 * dsh-pipeline · DEMO 存储
 * ============================================================================
 * 本文件是 DEMO 阶段的**唯一写点**：把 `demo-rounds.js` 判过的东西落到任务卡上。
 *
 * ---------------------------------------------------------------------------
 * 落点：任务卡上一个**新字段** `task.demo`
 * ---------------------------------------------------------------------------
 * 为什么单开一个字段而不是塞进既有数组：DEMO 的账要回答三个**连在一起**的问题 ——
 *   「这个档位该怎么处理 DEMO」「已经交到第几轮了」「用户确认的是哪一轮」——
 *   拆到 `human_requests` / `history` / 别处，就没有一个地方能一次答完。
 *
 * ---------------------------------------------------------------------------
 * P1-7 / P1-8（2026-10-18）后的写路径
 * ---------------------------------------------------------------------------
 *   · `demoPlan`   —— 记档位策略（require / ask / skip）与用户决定（`decision`）；主对话专用；
 *   · `demoSubmit` —— **交付席位**把本轮 DEMO 交付物挂进 `rounds[i]`（草稿 `status:'submitted'`）；
 *   · `demoRound`  —— **主对话**把草稿定稿成"已交一轮"，挂住人工请求并推进 `demo_submitted`；
 *     ★ 生产通道（2026-10-19）：**没给 `human_request_id` 时由本方法自己登记**一条
 *       `reason_kind=demo_review` 的人工请求（走 `store/human.js` 的 `createDemoReviewEntry`），
 *       之后照旧 relay → reply → confirm；显式给 id 时沿用旧判据（兼容旧夹具）。
 *   · `demoConfirm`—— **主对话**记下用户对某一轮的确认（之后由 main 触发 `demo_passed`）。
 *
 * ★ 判据全部委托 `demo-rounds.js` / `demo-gate.js`（纯函数）；本文件只负责
 *   **改字段 + 落盘 + 留痕 + 推进状态**，不重新实现一遍判定（两份判定必然漂移）。
 *
 * @module dsh-pipeline/lib/store/demo
 */

import { fullHash, nowIso } from '../util.js'
import { ROLE } from '../roles.js'
import { DEMO_GATE_GUARD, DEMO_ROUND_GUARD, demoGate } from '../guard/demo-gate.js'
import {
  DEMO_EVENTS,
  DEMO_ST,
  DEMO_SUBMIT_ROLES,
} from '../states/demo-phase.js'
import { demoPlanFor } from '../states/demo-tier-policy.js'
import {
  checkDemoConfirm,
  checkDemoRound,
  checkDemoRoundRequest,
  combineDeliverablesDigest,
  demoStateOf,
  digestOf,
  draftRoundOf,
  nextRoundIndex,
  recordedRoundsOf,
  summarizeDemo,
} from './demo-rounds.js'

/** 审计动作名（唯一出处）。 */
export const DEMO_ACTIONS = Object.freeze({
  PLAN: 'demo:plan',
  SUBMIT: 'demo:submit',
  ROUND: 'demo:round',
  /** ★ 生产通道：`round` 定稿时自动登记的「请用户审阅这轮 DEMO」请求。 */
  REQUEST: 'demo:request',
  CONFIRM: 'demo:confirm',
})

/** 确保 `task.demo` 结构在位（**只补结构，不覆盖已有内容**）。 */
function ensureDemo(task) {
  if (task.demo === null || typeof task.demo !== 'object' || Array.isArray(task.demo)) {
    task.demo = { plan: null, rounds: [], confirmed_at: null, confirm_request_id: null, confirm_answer: null, confirmed_by: null }
  }
  const d = task.demo
  if (!Array.isArray(d.rounds)) d.rounds = []
  if (d.plan === undefined) d.plan = null
  if (d.confirmed_at === undefined) d.confirmed_at = null
  if (d.confirm_request_id === undefined) d.confirm_request_id = null
  return d
}

/**
 * 尝试把 DEMO 阶段往前推一步（**只在 store 对象上可用**：p6 等纯方法夹具没有 `transition`）。
 *
 * @returns {Promise<object|null>} `null` = 没有 transition（测试替身）；否则是 transition 的结果
 */
async function tryAdvance(storeObj, task, event, note) {
  if (storeObj === null || typeof storeObj?.transition !== 'function') return null
  return storeObj.transition({ taskId: task.id, event, actorRole: ROLE.MAIN, actorAgentId: null, note })
}

/** 把"推进没成功"写进摘要（**不静默**：记录已经落盘，但状态没动这件事必须说出来）。 */
function advanceLines(advanced) {
  if (advanced === null) return []
  if (advanced.ok === true) return [`任务状态：${advanced.from} → ${advanced.to}${advanced.event ? `（${advanced.event}）` : ''}。`]
  return [`⚠ 状态推进**没有成功**：${String(advanced.error ?? '(见审计)').split('\n')[0]}`]
}

/**
 * DEMO 存储方法（由 `createTaskStore` 原位展开，`this` 指向同一个对象）。
 *
 * @param {object} ctx - `{ now, deny, audit, loadTask, persist }`
 */
export function demoMethods(ctx) {
  const { now, deny, loadTask, persist } = ctx
  const audit = typeof ctx.audit === 'function' ? ctx.audit : null

  return {
    /**
     * ★ 记下**档位策略的结论**（裁定 5）与用户决定（P1-7：L2 ask 仍可选择跳过）。
     *
     * @param {string} taskId
     * @param {{tier:unknown, by?:string, decision?:'demo'|'skip'}} input
     * @returns {Promise<object>}
     */
    async demoPlan(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const plan = demoPlanFor(input.tier)
      if (plan.ok !== true) return deny(plan.code, plan.message)

      const decision = String(input.decision ?? '').trim()
      if (decision.length > 0 && decision !== 'demo' && decision !== 'skip') {
        return deny('BAD_DECISION', `拒绝：decision 只认 \`demo\` / \`skip\`（当前：\`${decision}\`）。`)
      }
      if (decision === 'skip' && plan.action === 'require') {
        return deny(
          'DEMO_REQUIRED',
          `拒绝：本单是 **${plan.tier}** 档 —— 裁定 5 规定 **L3+ 必须出 DEMO**，不能跳过。\n` +
            '★ 跳过 DEMO 只允许两种情形：① L0–L1（本来就跳过）；② L2 的 `ask` 经用户明确答复"不必出"。\n' +
            '下一步：按 DEMO 阶段走（planning → demo_building → demo_review → demo_passed），用户确认后才进「待开发」。',
        )
      }
      if (decision === 'demo' && plan.action === 'skip') {
        return deny(
          'BAD_DECISION',
          `拒绝：本单是 **${plan.tier}** 档（L0–L1 可跳 DEMO）。\n` +
            '★ "显式要看 DEMO"不在当前策略里 —— L0–L1 若要出 DEMO，请把档位如实报成 L2+，而不是在这里翻转策略。',
        )
      }

      const d = ensureDemo(task)
      d.plan = {
        tier: plan.tier,
        action: plan.action,
        assumed: plan.assumed,
        reason: plan.reason,
        /** ★ 用户/主对话对 `ask` 的处置：`demo` = 要看；`skip` = 不必出；`null` = 未决定。 */
        decision: decision.length > 0 ? decision : null,
        at: nowIso(now()),
        by: String(input.by ?? ''),
      }
      task.updated_at = nowIso(now())
      if (audit !== null) task.history.push(await audit(task.id, d.plan.by, DEMO_ACTIONS.PLAN, { tier: d.plan.tier, action: d.plan.action, assumed: d.plan.assumed, decision: d.plan.decision }))
      await persist(task)
      return {
        ok: true,
        task,
        plan: d.plan,
        summary:
          `档位 ${plan.tier} ⇒ DEMO 处置 \`${plan.action}\`${plan.assumed ? '（tier 未知，按保守处理）' : ''}` +
          (d.plan.decision === null ? '。' : `；用户决定：\`${d.plan.decision}\`。`),
      }
    },

    /**
     * ★★ **交付席位交本轮 DEMO 内容**（P1-8 的 `pipeline_demo_submit` 落点）。
     *
     * 只挂交付物（草稿轮次），**不推进状态** —— 定稿与推进是主对话的 `demoRound`。
     * 这样"交内容"与"判断可以给用户看了"由两方各管一半：计划里要求"某席位交 DEMO"时，
     * 那个席位真的能交（而不是只有 main 能调）。
     *
     * @param {string} taskId
     * @param {object} input
     * @param {string} input.actorRole - 必须是 {@link DEMO_SUBMIT_ROLES} 之一
     * @param {string} [input.deliverableRef]
     * @param {string} [input.deliverableContent]
     * @param {number} [input.roundIndex] - 挂到哪一轮（缺省 = 当前草稿轮 / 下一轮）
     * @param {string} [input.note]
     * @param {string} [input.actorAgentId]
     * @returns {Promise<object>}
     */
    async demoSubmit(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const role = String(input.actorRole ?? '')
      if (!DEMO_SUBMIT_ROLES.includes(role)) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `拒绝：只有**交付席位**能交 DEMO 内容（${DEMO_SUBMIT_ROLES.join(' / ')}），当前调用方是「${role || '(未绑定)'}」。\n` +
            '★ 主对话不产出 DEMO 内容（它的动作是 `pipeline_demo` 的 round/confirm/status）；' +
            '其它角色也没有这个交付面。',
        )
      }
      if (task.state !== DEMO_ST.BUILDING) {
        return deny(
          'NOT_DEMO_BUILDING',
          `拒绝：任务 ${task.id} 现在的状态是「${task.state}」，**不是 DEMO 制作中**（${DEMO_ST.BUILDING}）。\n` +
            (task.state === DEMO_ST.REVIEW
              ? '★ 现在已经有一轮 DEMO 在等用户确认（`demo_review`）。用户要求改 ⇒ 先由主对话触发 `demo_rework` 回到制作中，再交新一轮内容。'
              : '★ 交 DEMO 内容必须发生在 DEMO 阶段里：先走 planning → `demo_started` → `demo_building`。'),
        )
      }

      const ref = String(input.deliverableRef ?? '').trim()
      const content = String(input.deliverableContent ?? '')
      if (ref.length === 0 && content.trim().length === 0) {
        return deny(
          'DEMO_NO_DELIVERABLE',
          '拒绝：这一轮**没有交付物**（`deliverable_ref` 与正文都是空的）。\n' +
            '★ 至少要给一个路径/URL/标识（`deliverable_ref`）或一段正文（`deliverable_content`）。',
        )
      }

      const d = ensureDemo(task)
      const at = nowIso(now())
      /** 目标轮次：显式给了就用它；否则接在"当前草稿"后面；再否则是下一轮。 */
      const drafts = d.rounds.filter((r) => r !== null && typeof r === 'object' && r.status === 'submitted')
      const explicit = Number.isInteger(input.roundIndex) && input.roundIndex >= 1 ? input.roundIndex : null
      const index = explicit ?? (drafts.length === 0 ? nextRoundIndex(task) : drafts[drafts.length - 1].index)

      const deliverable = {
        ref,
        content_hash: content.length > 0 ? fullHash(content) : '',
        digest: digestOf({ ref, content }),
        note: String(input.note ?? ''),
        by: role,
        at,
        agent: typeof input.actorAgentId === 'string' ? input.actorAgentId : null,
      }

      let round = draftRoundOf(task, index)
      if (round === null) {
        round = {
          index,
          /** ★ 草稿：还没被主对话 `round` 定稿（`recordedRoundsOf` 会把它排除在判据之外）。 */
          status: 'submitted',
          deliverables: [],
          /** 交付物引用（多席位各交一份时按提交顺序拼起来；定稿时由主对话压成一轮）。 */
          ref: '',
          digest: '',
          human_request_id: '',
          at,
          by: role,
          note: '',
        }
        d.rounds.push(round)
      }
      round.deliverables.push(deliverable)
      round.ref = round.deliverables.map((x) => x.ref).filter((x) => x.length > 0).join(' + ')
      round.digest = combineDeliverablesDigest(round.deliverables)
      /** 每份交付物都留了 by：一轮多席位合作时"谁交的哪份"可查。 */
      round.by = round.deliverables.map((x) => x.by).filter((x, i, a) => a.indexOf(x) === i).join('+')
      task.updated_at = at
      if (audit !== null) {
        task.history.push(
          await audit(task.id, role, DEMO_ACTIONS.SUBMIT, {
            round_index: index,
            ref,
            content_hash: deliverable.content_hash ? deliverable.content_hash.slice(0, 16) : '',
            agent: deliverable.agent,
          }),
        )
      }
      await persist(task)
      return {
        ok: true,
        task,
        round,
        deliverable,
        summary:
          `已把本轮 DEMO 交付物挂到第 ${index} 轮（${ref || '(只给了正文)'}；内容哈希 ${deliverable.content_hash ? `${deliverable.content_hash.slice(0, 12)}…` : '(无正文)'}）。\n` +
          '下一班岗：本轮的"请用户看 DEMO"人工请求由交付席位用 `pipeline_human_request` 发起（主对话转告）；' +
          `用户答复后，主对话用 \`pipeline_demo { action: "round", round_index: ${index}, human_request_id: "…" }\` 定稿这一轮。`,
      }
    },

    /**
     * ★★ **主对话定稿一轮 DEMO**（P1-7：`demo_building --demo_submitted--> demo_review`）。
     *
     * 判据（缺一不可；旧数据缺字段时按 legacy 放宽，见 `checkDemoRoundRequest`）：
     *   ① 本轮有**新交付物**（草稿由交付席位交上来；原地重交被拒）；
     *   ② 本轮挂的 `human_request` 是**本轮创建**、**未被别的轮消费**（一条请求只能用一次）；
     *      **已 answered** 只在"显式传 id"的兼容路径上要求；自动创建的请求此刻必然 pending
     *      （answered 由 `demoConfirm` / `demo_passed` 闸门在后一个出口判，见 `demo-rounds.js`）；
     *   ③ 定稿后推进 `demo_submitted`（store 拿得到 `transition` 时自动推）。
     *
     * ★ 生产通道（2026-10-19）：`human_request_id` 可省略 —— 省略时本方法用
     *   `this.createDemoReviewEntry(...)` **自己登记**一条 `demo_review` 请求并挂到本轮，
     *   于是 `round` 不再依赖"谁来先发一条 human_request"（执行角色会被两级梯跳级闸拦住）。
     *
     * @param {string} taskId
     * @param {{round_index?:number, deliverable?:{ref?:string,content?:string}, human_request_id?:string, by?:string, note?:string}} input
     * @returns {Promise<object>}
     */
    async demoRound(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      if (!Array.isArray(task.human_requests)) task.human_requests = []
      /**
       * ★ 显式给了请求 id ⇒ 沿用旧判据（本轮创建 / 已 answered / 未消费），兼容旧夹具与旧调用方；
       * 没给 ⇒ 走**生产通道**：定稿时由本方法自己登记一条 `demo_review` 人工请求。
       */
      const explicitRid = String(input.human_request_id ?? '').trim()

      // ---- ① 本轮要有新交付物（草稿优先；也兼容老的"直接给 deliverable"调用）----
      const explicitIndex = Number.isInteger(input.round_index) && input.round_index >= 1 ? input.round_index : null
      const draft = explicitIndex === null ? null : draftRoundOf(task, explicitIndex)
      const anyDraft = (() => {
        const list = demoStateOf(task).rounds.filter((r) => r !== null && typeof r === 'object' && r.status === 'submitted')
        return list.length === 0 ? null : list[list.length - 1]
      })()
      const targetDraft = draft ?? (explicitIndex === null ? anyDraft : null)
      let digest
      let ref
      let deliverables = []
      if (targetDraft !== null) {
        deliverables = Array.isArray(targetDraft.deliverables) ? targetDraft.deliverables : []
        digest = combineDeliverablesDigest(deliverables)
        ref = deliverables.map((x) => x.ref).filter((x) => x.length > 0).join(' + ')
        if (deliverables.length === 0 && String(input.deliverable?.ref ?? '').trim().length === 0 && String(input.deliverable?.content ?? '').trim().length === 0) {
          return deny('DEMO_NO_DELIVERABLE', '拒绝：这一轮**还没有交付物** —— 先让交付席位用 `pipeline_demo_submit` 交内容，再定稿。')
        }
      } else {
        // ★ legacy 路（P4 / 旧调用）：主对话直接给 deliverable。保留，不破坏既有调用方。
        //   没给显式请求 id 时传占位串 —— `checkDemoRound` 只判"非空"，真正的请求在下面创建/校验。
        const gate = checkDemoRound(task, { deliverable: input.deliverable, human_request_id: explicitRid.length > 0 ? explicitRid : '(auto)' })
        if (gate.ok !== true) return deny(gate.code, gate.error)
        digest = gate.digest
        ref = String(input.deliverable?.ref ?? '').trim()
        deliverables = [
          {
            ref,
            content_hash: String(input.deliverable?.content ?? '').trim().length > 0 ? fullHash(String(input.deliverable?.content ?? '')) : '',
            digest,
            note: String(input.note ?? ''),
            by: String(input.by ?? ''),
            at: nowIso(now()),
          },
        ]
      }

      // ---- ② 显式请求的三条判据（本轮创建 / 已 answered / 未被消费）----
      //   ★ 自动创建的那条不在这里判 answered —— 它创建于"定稿那一刻"，必然是 pending；
      //     answered / 消费在 `demoConfirm` 与 `demo_passed` 闸门那两个出口判（见 demo-rounds.js）。
      let reqCheck = null
      if (explicitRid.length > 0) {
        reqCheck = checkDemoRoundRequest(task, input)
        if (reqCheck.ok !== true) return deny(reqCheck.code, reqCheck.error)
      }

      // ---- ③ 编号：草稿用它的号；legacy 取下一轮 ----
      const index = targetDraft !== null ? targetDraft.index : nextRoundIndex(task)
      /** 原地重交：与**已定稿**的任一轮指纹相同 ⇒ 拒（草稿不参与比较，草稿同一份被定稿一次是正常的）。 */
      const dup = recordedRoundsOf(task).find((r) => r.digest === digest)
      if (dup !== undefined) {
        return deny(
          'DEMO_DUPLICATE_DELIVERABLE',
          `拒绝：这一轮的交付物与**第 ${dup.index} 轮完全相同**（指纹 ${digest.slice(0, 12)}…）—— 原地重交不算一轮。\n` +
            '★ 软约束①：每轮必须产出**新交付物**（原地重交会被拒）。',
        )
      }

      const at = nowIso(now())
      /**
       * ---- ③b ★★ 生产通道：自动创建「请用户审阅这轮 DEMO」的人工请求 ----
       *
       * 只在**没显式给 id** 时创建，并且放在所有拒绝判据之后（免得被判拒的调用白登记一条）。
       * 登记与轮次记录**同一次 persist** —— 不留"定了稿、请求却没登记"的半截现场。
       */
      let autoRequest = null
      if (reqCheck === null) {
        if (typeof this.createDemoReviewEntry !== 'function') {
          return deny(
            'DEMO_REVIEW_CHANNEL_MISSING',
            '拒绝定稿：本任务的 store 没有「DEMO 审阅请求创建通道」（插件装配不完整，这是内部错误）。\n' +
              '下一步：重装/重启插件后重试；临时可改用显式 `human_request_id`（旧行为）。',
          )
        }
        const built = this.createDemoReviewEntry(task, { roundIndex: index, ref, deliverables, digest, at })
        const existing = task.human_requests.find((r) => r !== null && typeof r === 'object' && r.request_id === built.request_id)
        autoRequest = existing !== undefined ? existing : built
        if (existing === undefined) task.human_requests.push(autoRequest)
        if (audit !== null) {
          task.history.push(
            await audit(task.id, ROLE.MAIN, DEMO_ACTIONS.REQUEST, {
              round_index: index,
              request_id: autoRequest.request_id,
              reason_kind: autoRequest.reason_kind,
              blocking: autoRequest.blocking,
              auto_created: true,
            }),
          )
        }
        reqCheck = { ok: true, request: autoRequest, strict: true, request_created_at: autoRequest.created_at, answered_deferred: true }
      }

      const d = ensureDemo(task)
      const round =
        targetDraft !== null
          ? targetDraft
          : {
              index,
              deliverables,
              ref,
              digest,
              human_request_id: '',
              at,
              by: String(input.by ?? ''),
              note: String(input.note ?? ''),
            }
      if (targetDraft === null) d.rounds.push(round)
      round.status = 'recorded'
      round.digest = digest
      round.ref = ref
      /** ★ 显式 id 沿用旧口径；否则就是本方法刚登记的那条 `demo_review` 请求。 */
      round.human_request_id = explicitRid.length > 0 ? explicitRid : String(reqCheck?.request?.request_id ?? '')
      round.auto_request = autoRequest !== null
      round.at = at
      round.by = round.by || String(input.by ?? '')
      round.note = String(input.note ?? round.note ?? '')
      round.deliverables = deliverables
      round.request_created_at = reqCheck.request_created_at
      /** ★ 请求被**这一轮**消费：之后再拿它定稿别的轮会被 `checkDemoRoundRequest` 拒。 */
      round.consumed_request_at = at
      /** 旧数据缺 created_at ⇒ legacy：不写 consumed 标记（否则既有夹具的第二轮会被判"已消费"）。 */
      const req = reqCheck.request
      if (reqCheck.strict && req !== null && typeof req === 'object') {
        req.consumed = true
        req.consumed_by_round = index
        req.consumed_at = at
      }

      // 新的一轮 ⇒ 上一次确认**作废**（确认认的是具体哪一版）。
      d.confirmed_at = null
      d.confirm_request_id = null
      d.confirm_answer = null
      d.confirmed_by = null
      task.updated_at = at
      if (audit !== null) {
        task.history.push(
          await audit(task.id, String(input.by ?? ''), DEMO_ACTIONS.ROUND, {
            index,
            digest,
            human_request_id: round.human_request_id,
            request_created_at: reqCheck.request_created_at,
            deliverables: deliverables.length,
          }),
        )
      }
      await persist(task)

      const advanced = await tryAdvance(this, task, DEMO_EVENTS.SUBMIT, 'DEMO 一轮已交 ⇒ 等用户确认')
      return {
        ok: true,
        task,
        round,
        advanced: advanced === null ? null : advanced.ok === true,
        summary:
          `已定稿第 ${index} 轮 DEMO（无轮次上限）。\n` +
          `  · 交付物：${ref || '(只给了正文)'}（指纹 ${digest.slice(0, 12)}…，${deliverables.length} 份）\n` +
          `  · 人工请求：${round.human_request_id}（` +
          (autoRequest !== null ? '**由本轮自动创建**：reason_kind=demo_review，blocking，等 relay → reply' : '本轮创建；已 answered；已消费标记') +
          '）\n' +
          '  · 上一轮的确认（若有）已作废 —— 确认认的是具体哪一版。\n' +
          (autoRequest !== null
            ? '下一步：pipeline_human_relay 转告用户 → pipeline_human_reply 记答复 → pipeline_demo { action: "confirm", round_index: ' +
              index +
              ', human_request_id: "' +
              round.human_request_id +
              '" }。\n'
            : '') +
          advanceLines(advanced).join('\n'),
      }
    },

    /**
     * ★ 记下**用户对某一轮 DEMO 的确认**（验收 A15 / A17；P1-7 起确认必须落在某一轮上）。
     *
     * 只记确认、**不推进状态**：`demo_review → ready_dev` 的 `demo_passed` 由主对话显式触发
     * （状态机与闸门才是"必经之路"，工具只是记录"用户点头了"这件事）。
     *
     * @param {string} taskId
     * @param {{round_index:number, request_id:string, answer?:string, answer_source?:'user'|'timeout', by?:string}} input
     * @returns {Promise<object>}
     */
    async demoConfirm(taskId, input = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)

      const ok = checkDemoConfirm(task, input)
      if (ok.ok !== true) return deny(ok.code, ok.error)

      // ★ 用户"真的答复了"是硬条件：请求记录必须存在且 answered（转告 ≠ 答复）。
      const req = (Array.isArray(task.human_requests) ? task.human_requests : []).find((r) => r.request_id === ok.request_id)
      if (req === undefined) {
        return deny(
          'DEMO_CONFIRM_REQUEST_NOT_FOUND',
          `拒绝确认：人工请求 \`${ok.request_id}\` 在任务上不存在 —— 确认必须挂在**一条真实存在**的请求上。`,
        )
      }
      if (req.status !== 'answered') {
        return deny(
          'DEMO_CONFIRM_NOT_ANSWERED',
          `拒绝确认：请求 \`${ok.request_id}\` 目前是 \`${req.status}\`，**用户还没答复**。\n` +
            '★ 转告 ≠ 答复：请求发出去了只证明话带到了。\n' +
            '下一步：pipeline_human_relay 转告 → 拿到用户原话后 pipeline_human_reply。',
        )
      }
      /** 一条请求只能服务一轮：它被**别的**轮消费过 ⇒ 这次确认不成立。 */
      if (req.consumed === true && Number.isInteger(req.consumed_by_round) && req.consumed_by_round !== ok.round_index) {
        return deny(
          'DEMO_REQUEST_CONSUMED',
          `拒绝确认：请求 \`${ok.request_id}\` 已经被第 ${req.consumed_by_round} 轮消费（要确认的是第 ${ok.round_index} 轮）—— 一条请求只能用一次。`,
        )
      }

      const d = ensureDemo(task)
      const at = nowIso(now())
      d.confirmed_at = at
      d.confirm_request_id = ok.request_id
      d.confirm_answer = String(input.answer ?? req.answer_text ?? req.answer ?? '')
      d.confirmed_by = String(input.by ?? '')
      /** ★ 确认**落在具体轮次**上（闸门要"有一轮 confirmed"，不是"有一个全局时间戳"）。 */
      const round = ok.round ?? recordedRoundsOf(task).find((r) => r.index === ok.round_index) ?? null
      if (round !== null) {
        round.confirmed_at = at
        round.confirmed_by = d.confirmed_by
        round.confirm_request_id = ok.request_id
      }
      task.updated_at = at
      if (audit !== null) task.history.push(await audit(task.id, d.confirmed_by, DEMO_ACTIONS.CONFIRM, { round_index: ok.round_index, request_id: ok.request_id }))
      await persist(task)
      return {
        ok: true,
        task,
        round_index: ok.round_index,
        round: round ?? null,
        summary:
          `用户已确认第 ${ok.round_index} 轮 DEMO（请求 ${ok.request_id}）。\n` +
          '下一步：主对话触发 `pipeline_transition { event: "demo_passed" }` —— 闸门 `demo_confirmed` 会核这一轮的请求/答复/消费标记，通过后状态进「待开发」。',
      }
    },

    /** DEMO 账本（只读）。 */
    async demoStatus(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const g = demoGate(task)
      const st = demoStateOf(task)
      const recorded = recordedRoundsOf(task)
      const drafts = st.rounds.filter((r) => r?.status === 'submitted')
      return {
        ok: true,
        task,
        demo: st,
        state: task.state,
        recorded_rounds: recorded,
        draft_rounds: drafts,
        confirmed: g.ok === true,
        blocked_by: g.ok === true ? null : g.code,
        reason: g.ok === true ? '' : g.error,
        summary: summarizeDemo(task),
      }
    },

    /**
     * ★★ **闸门判据**（给 `checkPrecondition` 用）—— 与工具层调用**同一份**实现。
     *
     * 接线方式（见 `WIRING.md`）：在 `lib/store/precondition.js` 的 `switch` 里加两个 case：
     *   `case DEMO_GATE_GUARD:` 与 `case DEMO_ROUND_GUARD:`
     * 都 `return this.checkDemoPrecondition(task, name, input)`。
     *
     * @param {object} task
     * @param {string} name - 闸门名（`demo_confirmed` / `demo_round_ok`）
     * @param {object} [input]
     * @returns {{ok:true}|{ok:false, code:string, error:string}}
     */
    checkDemoPrecondition(task, name, input = {}) {
      if (name === DEMO_GATE_GUARD) return demoGate(task)
      if (name === DEMO_ROUND_GUARD) {
        /**
         * `demo_submitted` 那条边要的是"**刚刚定稿的这一轮**没问题"。
         * · 调用方递进 `input.demo`（新一轮的交付物参数）⇒ 走软约束三条的判据；
         * · 状态机推进时**没有**交付物参数 ⇒ 核对**最近一个已定稿轮次**：
         *   它有交付物（ref/deliverables/digest 之一）且请求三条成立。
         * 两者判的是**同一份数据**，不各写一套。
         */
        if (input?.demo !== undefined && input?.demo !== null) {
          const gate = checkDemoRound(task, input.demo)
          return gate.ok === true ? { ok: true } : { ok: false, code: gate.code, error: gate.error }
        }
        const last = recordedRoundsOf(task).slice(-1)[0] ?? null
        if (last === null) {
          return deny(
            'DEMO_NO_ROUND',
            '拒绝：还没有任何**已定稿**的 DEMO 轮次 —— 先让交付席位 `pipeline_demo_submit` 交内容，主对话再 `pipeline_demo { action: "round" }` 定稿。',
          )
        }
        const hasDeliverable =
          (Array.isArray(last.deliverables) && last.deliverables.length > 0) ||
          String(last.ref ?? '').trim().length > 0 ||
          String(last.digest ?? '').trim().length > 0
        if (!hasDeliverable) {
          return deny(
            'DEMO_NO_DELIVERABLE',
            `拒绝：第 ${last.index} 轮的定稿记录里**没有交付物**（ref 与正文都是空的）—— 这一轮不算数。\n` +
              '★ 每轮必须产出**新交付物**；先由交付席位 `pipeline_demo_submit` 交内容，再定稿。',
          )
        }
        const reqChk = checkDemoRoundRequest(task, { human_request_id: last.human_request_id, round_index: last.index })
        if (reqChk.ok !== true) return { ok: false, code: reqChk.code, error: reqChk.error }
        return { ok: true }
      }
      return deny('UNKNOWN_DEMO_GUARD', `认不出的 DEMO 闸门名 \`${name}\`（只认 ${DEMO_GATE_GUARD} / ${DEMO_ROUND_GUARD}）。`)
    },
  }
}
