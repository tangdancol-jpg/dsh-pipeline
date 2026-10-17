/**
 * dsh-pipeline · 澄清与人工介入
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/human
 */

import { HUMAN_DECISION_KINDS, HUMAN_REASON_KINDS, HUMAN_TIMEOUT_BEHAVIORS, HUMAN_URGENCIES } from '../handoff.js'
import { ROLE, roleLabel } from '../roles.js'
import { ROLES_CAN_ASK_CLARIFICATION, ROLES_CAN_RAISE_HUMAN, STATE_LABEL } from '../states.js'
import { clip } from '../util.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { TASK_ID_REQUIRED, taskNotFound } from '../errors/text.js'

/**
 * 澄清与人工介入
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildHumanTools(ctx) {
  const { deps, store, indexTask, load, wakeResumedSeat } = ctx

  // =========================================================================
  // 18~19. ★两级升级梯 · 第一级（角色 → 需求分析）
  // =========================================================================
  //
  // 执行/顾问角色遇到确定不了的事，**先问需求分析**。
  // 它能在需求层裁定就自己答（用户根本不用被打扰）；答不了才由它升级给用户。
  // 只有 L0 档没有独立编排对话，那时才允许直接发 human_request。

  const clarifyRequest = tool(deps, {
    name: 'pipeline_clarify_request',
    mutating: true,
    description:
      '【执行/顾问角色专用】★ 遇到确定不了的事，**先问需求分析**（人工介入的第一级）。' +
      '需求层的事（验收标准、边界条件、优先级、范围取舍、测试要点）它多半能直接裁定，**用户根本不用被打扰**；' +
      '它确实答不了时会由它升级给用户。' +
      'context_digest 必须是**脱敏摘要**（不许含代码正文）—— 需求分析靠它在不读代码的前提下判断。' +
      'blocking=true 时任务进入「等待需求分析答复」，裁定后回到被打断前的状态。' +
      '（本档没有独立编排对话时——L0——这条链路不存在，直接调 pipeline_human_request 才是合法路径。）',
    parameters: {
      task_id: S('string', '任务 ID'),
      stage: S('string', '卡在哪一步（例如"编写：接口字段命名"）'),
      question: S('string', '要问的问题 —— 必须是清晰可答的问句'),
      context_digest: S('string', '★ 脱敏摘要（不含代码正文）'),
      options: S('array', '你想到的可选方案，每项 { label, consequence }', { items: { type: 'object', additionalProperties: true } }),
      blocking: S('boolean', '是否阻塞本任务推进（默认 true）'),
      urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      deadline: S('string', '希望什么时候答复（ISO 8601，可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '澄清请求 id'),
      state: S('string', '提交后的任务状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', state: '' }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: taskNotFound(args.task_id), request_id: '', state: '' }
      if (!ROLES_CAN_ASK_CLARIFICATION.includes(actor.role)) {
        return {
          ok: false,
          request_id: '',
          state: '',
          summary:
            `角色「${roleLabel(actor.role)}」不在可向需求分析提问的名单里。\n` +
            `可提问的角色：${ROLES_CAN_ASK_CLARIFICATION.map(roleLabel).join(' / ')}\n` +
            '（主对话不产出技术交接物；需求分析是**被问的人**，它答不了时走升级路径。）',
        }
      }
      const res = await store.submitHandoff({
        taskId: task.id,
        kind: 'clarification_request',
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        payload: {
          task_id: task.id,
          from_role: actor.role,
          stage: args.stage,
          question: args.question,
          context_digest: args.context_digest,
          options: args.options,
          blocking: args.blocking === undefined ? true : args.blocking === true,
          urgency: args.urgency,
          deadline: args.deadline,
        },
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', state: '' }
      indexTask(res.task.id, res.task)
      const entry = store.findClarification(res.task, undefined)
      return {
        ok: true,
        request_id: entry?.request_id ?? '',
        state: res.task.state,
        summary:
          `${res.summary}\n` +
          `澄清请求已登记：${entry?.request_id ?? '(未生成)'}　当前状态：${STATE_LABEL[res.task.state]}` +
          `　（这是第 ${entry?.round ?? 1} 次问这个问题）\n` +
          (res.advanced
            ? '任务已进入「等待需求分析答复」—— 裁定之前它不会被推进。\n'
            : '这是一条**非阻塞**提问：任务可以继续推进，但结论仍会回投给你。\n') +
          '\n★ 你**没有**惊动用户 —— 这一级就是为此存在的。等需求分析给出裁定（answered 会给结论；' +
          'cannot_answer 说明它已把问题升级给用户），状态会回到你提问时的位置。',
      }
    },
  })

  const clarifyReply = tool(deps, {
    name: 'pipeline_clarify_reply',
    mutating: true,
    description:
      '【需求分析专用】★ 对澄清请求出裁定（两级升级梯的枢纽）。' +
      'verdict=answered：**能在需求层定的就自己定**，给 answer + reason，发起角色原地继续，用户不用被打扰；' +
      'verdict=cannot_answer：答不了就必须说清 reason（需要用户拍板 / 涉及新需求 / 需求层冲突无法自解 / 缺环境权限），' +
      '然后由你再发 pipeline_human_request（带 escalated_from/raised_by/orchestrator_reason）升级给用户。' +
      '★ 一旦升级就是**单向门** —— 那条澄清请求不能再被你改口裁定。' +
      '不带 request_id 时它同时充当收件箱（列出本任务全部澄清请求）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '澄清请求 id（留空 = 列出全部，不裁定）'),
      verdict: S('string', '裁定结果', { enum: ['answered', 'cannot_answer'] }),
      answer: S('string', '结论（verdict=answered 时必填）'),
      reason: S('string', '★ 为什么这么答 / 为什么答不了（必填）'),
      constraints_added: S('array', '因这次裁定而新增/收紧的约束', { items: { type: 'string' } }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '澄清请求 id'),
      resumed_to: S('string', '恢复到的状态（没恢复则为空串）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', resumed_to: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: TASK_ID_REQUIRED, request_id: '', resumed_to: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: taskNotFound(taskId), request_id: '', resumed_to: '' }

      if (typeof args.request_id !== 'string' || args.request_id.length === 0) {
        const list = await store.listClarifications({ taskId })
        if (list.ok !== true) return { ok: false, summary: list.error, request_id: '', resumed_to: '' }
        indexTask(taskId, list.task)
        if (list.all.length === 0) {
          return { ok: true, request_id: '', resumed_to: '', summary: `任务 ${taskId} 目前没有澄清请求。` }
        }
        const lines = [
          `任务 ${taskId} 的澄清请求（共 ${list.all.length} 条，待裁定 ${list.pending.length} 条）：`,
          '',
          ...list.all.map((r) => {
            const mark = r.status === 'pending' ? '●待裁定' : r.status === 'escalated' ? '↑已升级' : '✓已裁定'
            return (
              `  ${mark} ${r.request_id}  [${r.status}]  ${r.from_role}  ${r.stage}\n` +
              `      ${clip(r.question, 90)}\n` +
              `      阻塞=${r.blocking} 紧急=${r.urgency} 第 ${r.round} 次问` +
              (r.verdict ? ` 裁定=${r.verdict}` : '') +
              (r.escalated_to ? ` 已升级为 ${r.escalated_to}` : '')
            )
          }),
          '',
          list.pending.length > 0
            ? `下一步：pipeline_clarify_reply { task_id: "${taskId}", request_id: "${list.pending[0].request_id}", verdict: "answered"|"cannot_answer", ... }`
            : '（没有待裁定的请求。）',
        ]
        return { ok: true, request_id: '', resumed_to: '', summary: lines.join('\n') }
      }

      const res = await store.replyClarification({
        taskId,
        requestId: String(args.request_id),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        verdict: args.verdict,
        answer: args.answer,
        reason: args.reason,
        constraintsAdded: args.constraints_added,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', resumed_to: '' }
      indexTask(taskId, res.task)
      // ★★ **B3：裁定落地 ⇒ 唤醒那个"停手等答复"的席位**。
      //
      //   现场：席位提 `blocking` 澄清后按规矩停手，裁定回来了、状态也**正确恢复**了，
      //   但**没有一个人被叫醒**（实测该席位会话自 21:03:01 起完全冻结、45 秒零写入）——
      //   于是"每一次 blocking 澄清 = 永久废掉一个席位"。
      //   这里在状态恢复之后把结论投给**发起席位**；**投不出去就报出来**（不静默失败）。
      const woken = await wakeResumedSeat(
        res.task,
        String(res.request?.from_role ?? ''),
        res.request?.from_seat ?? null,
        `澄清请求 ${res.request?.request_id ?? ''} 已裁定（${String(args.verdict ?? '')}）`,
        { kind: 'clarify-reply', requestId: String(res.request?.request_id ?? '') },
      )
      return { ok: true, request_id: res.request.request_id, resumed_to: res.resumed?.to ?? '', summary: `${res.summary}\n${woken.line}` }
    },
  })

  // =========================================================================
  // 15~17. ★人工介入（用户只与主对话相连 —— 这是唯一的上升通道）
  // =========================================================================
  //
  // 拓扑：  执行/顾问角色 ──①发起──► 主对话 ──②转告──► 用户
  //                        ▲                              │
  //                        └──── 主对话 ──③记答复◄─────────┘
  //                                     └──④恢复──► 状态机回到被打断前
  //
  // 三个动作的角色边界（守门 + execute 双重判定）：
  //   发起 = 除 main 之外的角色    转告 / 记答复 = 只有 main

  const humanRequest = tool(deps, {
    name: 'pipeline_human_request',
    mutating: true,
    description:
      '【执行/顾问角色专用】向上发起人工介入请求。**用户的对话框只在主对话里** —— 你不能直接对用户说话，' +
      '所以任何需要人拍板的事都必须走这条路：你发起 → 主对话转告用户 → 用户答复 → 主对话记回来 → 你继续。' +
      'question_for_human 必须是**给用户看的人话**（不许含代码/补丁/文件路径），因为主对话不读代码、也转告不了代码；' +
      '混进代码会被直接拒。blocking=true 时任务会进入「等待人工答复」，用户答复后**回到被打断前的那个状态**。' +
      '（与 pipeline_handoff{kind:"human_request"} 是同一条路径，这个工具只是把参数摊平了。）',
    parameters: {
      task_id: S('string', '任务 ID'),
      reason_kind: S('string', '为什么要人拍板', { enum: Object.keys(HUMAN_REASON_KINDS) }),
      question_for_human: S('string', '★ 给用户看的人话问题（不含代码、不含补丁、必须是个问句）'),
      context_for_human: S('string', '给用户的补充背景（同样不许含代码，可空）'),
      options: S('array', '可选方案，每项 { label, consequence }（decision_kind=choose_option 时至少 2 个）', { items: { type: 'object', additionalProperties: true } }),
      recommended: S('string', '你的建议（必须是 options 里某个 label；仅供参考，不构成决定）'),
      blocking: S('boolean', '是否阻塞本任务推进（默认 true）'),
      blocked_stage: S('string', '卡在哪一步（blocking=true 时必填）'),
      urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      decision_kind: S('string', '需要用户给什么形式的答复', { enum: Object.keys(HUMAN_DECISION_KINDS) }),
      timeout_behavior: S('string', '无人回应时怎么办', { enum: Object.keys(HUMAN_TIMEOUT_BEHAVIORS) }),
      default_option: S('string', '默认选项（timeout_behavior=proceed_with_default 时必填）'),
      timeout_at: S('string', '截止时间 ISO 8601（可空；配置 humanRequestTimeoutHours>0 时会自动算）'),
      // --- ★由需求分析升级上来时必填（执行角色**不许**填这三个 —— 它得先走 clarification_request）---
      escalated_from: S('string', '升级来源：某条 clarification_request 的 handoff_id（需求分析升级时必填）'),
      raised_by: S('string', '原本是谁问的（上游澄清请求的发起角色）'),
      orchestrator_reason: S('string', '需求分析为什么答不了（用户有权知道为什么这事轮到他拍板）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '请求 id（失败时为空串）'),
      state: S('string', '提交后的任务状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', state: '' }
      if (actor.role === ROLE.MAIN) {
        return {
          ok: false,
          request_id: '',
          state: '',
          summary:
            '主对话不发起人工介入请求 —— 你就在用户的对话框里，要问直接问。\n' +
            '这个工具是给 writer / tester / reviewer / security / architect 这些**没有用户对话框**的角色用的。\n' +
            '你收到它们提交的请求后：pipeline_human_relay 转告用户 → pipeline_human_reply 记答复。',
        }
      }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: taskNotFound(args.task_id), request_id: '', state: '' }
      if (!ROLES_CAN_RAISE_HUMAN.includes(actor.role)) {
        return {
          ok: false, request_id: '', state: '',
          summary: `角色「${roleLabel(actor.role)}」不在可发起人工介入的名单里（${ROLES_CAN_RAISE_HUMAN.join(' / ')}）。`,
        }
      }

      const res = await store.submitHandoff({
        taskId: task.id,
        kind: 'human_request',
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        payload: {
          task_id: task.id,
          from_role: actor.role,
          created_at: typeof args.created_at === 'string' ? args.created_at : undefined,
          reason_kind: args.reason_kind,
          question_for_human: args.question_for_human,
          context_for_human: args.context_for_human,
          options: args.options,
          recommended: args.recommended,
          blocking: args.blocking === undefined ? true : args.blocking === true,
          blocked_stage: args.blocked_stage,
          urgency: args.urgency,
          decision_kind: args.decision_kind,
          timeout_behavior: args.timeout_behavior,
          default_option: args.default_option,
          timeout_at: args.timeout_at,
          escalated_from: args.escalated_from,
          raised_by: args.raised_by,
          orchestrator_reason: args.orchestrator_reason,
        },
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', state: '' }
      indexTask(res.task.id, res.task)
      const entry = store.findHumanRequest(res.task, undefined)
      return {
        ok: true,
        request_id: entry?.request_id ?? '',
        state: res.task.state,
        summary:
          `${res.summary}\n` +
          `请求已登记：${entry?.request_id ?? '(未生成)'}　当前状态：${STATE_LABEL[res.task.state]}\n` +
          (res.advanced
            ? '任务已进入「等待人工答复」—— 在用户答复之前它不会被推进。\n'
            : '这是一条**非阻塞**请求：任务可以继续推进，但主对话仍会转告用户。\n') +
          '\n接下来**不是你去问用户** —— 你的对话框里没有用户。等主对话把用户的答复记回来，\n' +
          '状态会回到你提问时的那个位置，你再用 pipeline_status 看结论继续干活。',
      }
    },
  })

  /**
   * ★★ **2026-10-14：补上 `mutating: true`。**
   *
   * 事实：`pipeline_human_relay` 会往任务里写 `relayed_at`（转告留痕）；
   * `pipeline_human_reply` 会**记答复 + 恢复状态 + 唤醒席位** —— 两个都改任务数据。
   * 而开关闸只在 `spec.mutating === true` 时才拦（`:345-347`），
   * 所以改前**总开关关掉时这两个照样能用**。
   *
   * ★ 判为**疏漏**，不是"有意的应急出口"（三条证据，都能机械复核）：
   *   ① 同一族的 `pipeline_human_request`（发起侧）标了 `mutating: true`、
   *      `pipeline_clarify_reply`（澄清梯的答复侧）也标了 —— 全表只有这两个漏标；
   *   ② 开关关闭时的统一拒答文案自己写着「关闭状态下仍然可用的是**只读**动作：
   *      pipeline_status / pipeline_switch / pipeline_selftest」——
   *      这两个**不在**那份名单里，却事实上可用 ⇒ 文案与行为对不上；
   *   ③ 从最早的备份（`tools.js.bak-20261011-084255`）起就没标过，
   *      也**没有任何一处注释**说明这是故意的。
   *
   * ★ **这改变了行为**（如实标注）：开关关闭时这两个工具会被拒（与其它写工具一致）。
   *   影响面：`pipeline_human_reply` 调不动 ⇒ 卡在「等待人工答复」的单在开关重新打开之前
   *   **不会被恢复**。可恢复性由 `pipeline_switch` 兜底 —— 它**没有**标 `mutating`
   *   （开关本身必须永远可用，自测 `switch-check` T3 验的就是这条）。
   *   连带影响：`tool()` 出口的 `rememberMainCaller` 只在 `mutating === true` 时才记
   *   A28「主对话已接管」；补标之后"主对话答复了"也会被算作接管 ——
   *   这正是那段注释里写死的口径（「状态迁移 / 派活 / **答复**」）。
   */
  const humanRelay = tool(deps, {
    name: 'pipeline_human_relay',
    mutating: true,
    description:
      '【主对话专用】把一条人工介入请求**转告用户**（第 2 步）。' +
      '不带 request_id 时它同时充当收件箱：列出本任务所有人工介入请求。' +
      '转告动作**不改任务状态**（状态在角色发起那一刻就已经推到「等待人工答复」了），只留痕。' +
      '返回里会带上"照抄给用户看"的原文块，以及一枚确认码（用户答复时可回带，用作凭据）。' +
      '★ 你只负责转告，不要替用户做技术判断。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '请求 id（留空 = 列出本任务的全部请求，不转告）'),
      channel: S('string', '用什么渠道转告（默认 chat，可空）'),
      note: S('string', '转告备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含"照抄给用户看"的原文块）'),
      request_id: S('string', '请求 id'),
      status: S('string', '请求状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', status: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: TASK_ID_REQUIRED, request_id: '', status: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: taskNotFound(taskId), request_id: '', status: '' }

      // 收件箱模式
      if (typeof args.request_id !== 'string' || args.request_id.length === 0) {
        const list = await store.listHumanRequests({ taskId })
        if (list.ok !== true) return { ok: false, summary: list.error, request_id: '', status: '' }
        indexTask(taskId, list.task)
        if (list.all.length === 0) {
          return { ok: true, request_id: '', status: '', summary: `任务 ${taskId} 目前没有人工介入请求。` }
        }
        const lines = [
          `任务 ${taskId} 的人工介入请求（共 ${list.all.length} 条，待处理 ${list.pending.length} 条）：`,
          '',
          ...list.all.map((r) => {
            const mark = r.status === 'answered' ? '✓' : r.status === 'relayed' ? '⏳已转告' : '●待转告'
            return (
              `  ${mark} ${r.request_id}  [${r.status}]  ${r.from_role}  ${r.reason_zh}\n` +
              `      ${clip(r.question_for_human, 90)}\n` +
              `      阻塞=${r.blocking} 紧急=${r.urgency} 需要=${HUMAN_DECISION_KINDS[r.decision_kind] ?? r.decision_kind}` +
              (r.timeout_at ? ` 截止=${r.timeout_at}` : '') +
              (r.answered_at ? ` 已答复=${r.answered_at}(${r.answer_source})` : '')
            )
          }),
          '',
          list.pending.length > 0
            ? `下一步：pipeline_human_relay { task_id: "${taskId}", request_id: "${list.pending[0].request_id}" } 拿到"照抄给用户看"的原文块。`
            : '（没有待处理的请求。）',
        ]
        return { ok: true, request_id: '', status: '', summary: lines.join('\n') }
      }

      const res = await store.relayHumanRequest({
        taskId,
        requestId: String(args.request_id),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        channel: args.channel,
        note: args.note,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', status: '' }
      indexTask(taskId, res.task)
      return { ok: true, request_id: res.request.request_id, status: res.request.status, summary: res.summary }
    },
  })

  /**
   * ★★ **2026-10-14：补上 `mutating: true`** —— 与上面的 `pipeline_human_relay` 同一条
   * 判断与同一份证据（都在"这个工具改不改任务数据"这一点上），理由见那一处注释。
   *
   * 这一个比 relay 更硬：它**明确会改状态**（「等待人工答复」唯一的出口，
   * 记录成功且请求阻塞时任务状态会回到被打断前那个状态）。
   */
  const humanReply = tool(deps, {
    name: 'pipeline_human_reply',
    mutating: true,
    description:
      '【主对话专用】把**用户的答复**结构化记下来，并据此恢复任务（第 3+4 步）。' +
      '★ 这是"等待人工答复"唯一的出口 —— 主对话不能自行把请求标记为已解决。' +
      '必须带 user_quote（用户本人的原话）与 attribution（谁在哪说的），且请求必须**先转告过**；' +
      '答复形状要与请求的 decision_kind 相符（是非题要布尔、选择题要选项之一、说明题要文本）。' +
      'answer_source=timeout 是另一条路：不是"用户说了什么"，而是请求发起时**事前声明的超时策略**到期生效 —— ' +
      '只有当请求声明了截止时间、且策略不是 stay_blocked 时才允许。' +
      '记录成功且请求是阻塞的，任务状态会**回到被打断前的那个状态**。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '请求 id（留空 = 最近一条未答复的）'),
      answer_source: S('string', '答复来源（默认 user）', { enum: ['user', 'timeout'] }),
      user_quote: S('string', '★ 用户本人的原话（answer_source=user 时必填）'),
      reply_channel: S('string', '用户通过什么渠道答复的', { enum: ['chat', 'typed', 'selected', 'relayed', 'other'] }),
      attribution: S('string', '谁在哪说的（例如「用户在当前会话里直接回复」）'),
      confirm_code: S('string', '转告时给出的确认码（配置 requireHumanConfirmCode=true 时必填）'),
      answer: S('boolean', '是非题/审批题的答复（decision_kind=yes_no / approve_reject 时必填）'),
      chosen_option: S('string', '选择题选了哪个（decision_kind=choose_option 时必填，必须是选项 label 之一）'),
      answer_text: S('string', '说明题的答复（decision_kind=free_text 时必填）'),
      note: S('string', '备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '请求 id'),
      resumed_to: S('string', '恢复到的状态（没恢复则为空串）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', resumed_to: '' }
      const res = await store.replyHumanRequest({
        taskId: String(args.task_id ?? ''),
        requestId: typeof args.request_id === 'string' ? args.request_id : '',
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        answerSource: args.answer_source,
        userQuote: args.user_quote,
        replyChannel: args.reply_channel,
        attribution: args.attribution,
        confirmCode: args.confirm_code,
        answer: args.answer,
        chosenOption: args.chosen_option,
        answerText: args.answer_text,
        note: args.note,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', resumed_to: '' }
      indexTask(res.task.id, res.task)
      // ★★ **B3：人工裁定落地 ⇒ 唤醒那个"停手等答复"的席位**（澄清链的上一级同理）。
      //
      //   用户已裁定：**不要求自动补一个新席位**顶上 —— 但原来那个必须被叫醒；
      //   叫不醒时**报出看得见的失败**（`wakeResumedSeat` 会把失败原文与等价路径拼进 summary），
      //   任务也不许停在半路。
      const woken = await wakeResumedSeat(
        res.task,
        String(res.request?.from_role ?? ''),
        res.request?.from_seat ?? null,
        `人工介入请求 ${res.request?.request_id ?? ''} 已答复（${String(args.answer_source ?? 'user')}）`,
        { kind: 'human-reply', requestId: String(res.request?.request_id ?? '') },
      )
      return {
        ok: true,
        request_id: res.request.request_id,
        resumed_to: res.resumed?.to ?? '',
        summary: `${res.summary}\n${woken.line}`,
      }
    },
  })

  return { clarifyRequest, clarifyReply, humanRequest, humanRelay, humanReply }
}
