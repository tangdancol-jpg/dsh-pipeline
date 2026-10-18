// DEMO 工具面 · `pipeline_demo`（main：plan / round / confirm / status）+ `pipeline_demo_submit`（交付席位：交本轮内容）。
/**
 * dsh-pipeline · 工具面 · DEMO 阶段
 * ============================================================================
 * 设计档 `design/conventions/04-demo与制品模型.md` §2（用户已拍板「推荐 A」）：
 * **拆工具**，把"调度 DEMO 轮次"与"交付 DEMO 内容"分开：
 *
 *   · `pipeline_demo`（**main 专用**）—— 一条链上的四步：
 *       `plan`    算这个档位该怎么处理 DEMO（L0–L1 skip / L2 ask / L3+ require；可记用户决定）
 *       `round`   交**一轮** DEMO（定稿交付席位交上来的内容 + 挂住人工请求；原地重交会被拒）
 *       `confirm` 记下**用户对某一轮**的确认（要求那条请求**已被答复**、且是**本轮创建**的）
 *       `status`  看账本与闸门现状（只读）
 *   · `pipeline_demo_submit`（**交付席位** writer / architect / diagrammer）——
 *     把本轮 DEMO 交付物（路径/摘要/内容哈希）挂到 `task.demo.rounds[i]`，
 *     供 main 的 `pipeline_demo { action: "round" }` 引用。
 *
 * ★ 为什么这样拆：计划里写"DEMO 由某两个席位各交一半"过去**不可执行** ——
 *   `pipeline_demo` 只允许 main，而 main 不是交付方。拆出 submit 之后
 *   "谁在册谁可交"，与 `pipeline_handoff` 的方向白名单同形。
 *
 * ★ 本文件**不做判定** —— 判定在 `demo-rounds.js`（纯函数）与 `demo-gate.js`（闸门）；
 *   写盘在 `lib/store/demo.js`。工具面只负责"参数 → 调用 → 人话摘要"。
 *
 * @module dsh-pipeline/lib/tools/demo
 */

import { S, tool, resolveActor } from './kit.js'
import { DEMO_ROUND_CAP, DEMO_ST, DEMO_SUBMIT_ROLES } from '../states/demo-phase.js'
import { DEMO_SOFT_RULES, demoStateOf, recordedRoundsOf } from '../store/demo-rounds.js'
// ★ 判据码 + 拒绝文案的**唯一出处**（`lib/errors/`）；本文件的判据与文案字面值未动。
import { BAD_ACTION, NO_ACTOR, OK, TASK_NOT_FOUND } from '../errors/codes.js'
import { taskNotFound } from '../errors/text.js'

/** 工具名（唯一出处）。 */
export const DEMO_TOOL_NAME = 'pipeline_demo'

/** 交付席位工具名（P1-8 拆出来的那一个）。 */
export const DEMO_SUBMIT_TOOL_NAME = 'pipeline_demo_submit'

/** 四个动作名。 */
export const DEMO_TOOL_ACTIONS = Object.freeze(['plan', 'round', 'confirm', 'status'])

/** 统一失败形状（工具输出契约里的必填项一个不少）。 */
function fail(code, message, extra = {}) {
  return {
    ok: false,
    code,
    action: '',
    summary: message,
    tier: '',
    demo_action: '',
    rounds: 0,
    round_index: 0,
    confirmed: false,
    blocked_by: code,
    ...extra,
  }
}

/** `pipeline_demo_submit` 的统一失败形状。 */
function submitFail(code, message, extra = {}) {
  return { ok: false, code, summary: message, round_index: 0, rounds: 0, digest: '', content_hash: '', state: '', ...extra }
}

/**
 * 工具定义（与其余 `pipeline_*` 工具同形）。
 *
 * @param {object} ctx - `{ deps, store, load }`
 * @returns {{demo:object, demoSubmit:object}}
 */
export function buildDemoTools(ctx) {
  const { deps, store, load } = ctx

  const demo = tool(deps, {
    name: DEMO_TOOL_NAME,
    mutating: true,
    description:
      '【DEMO 阶段 · 主对话专用】复杂任务**先出可操作前端 DEMO**，**用户确认后才继续后端**（裁定 5/6）。' +
      'P1-7 起 DEMO 是**显式阶段**：`planning --demo_started--> demo_building --demo_submitted--> demo_review --demo_passed--> ready_dev`（可 `demo_rework` 回去重做）。\n' +
      '· `action: "plan"` —— 算档位策略：**L0–L1 可跳 / L2 询问 / L3+ 必须出**；tier 未知按 L2 保守，非法 tier 直接拒。' +
      'L2 的 `ask` 可带 `decision: "demo"|"skip"` 记下用户决定（L3+ 不许 skip）。\n' +
      '· `action: "round"` —— **定稿一轮** DEMO：交付席位先用 `pipeline_demo_submit` 交内容，这里按 `round_index` 引用；' +
      '**无轮次硬上限**；三条软约束：每轮必须是**新交付物**、本轮挂一条人工请求、`cancel` 出口始终可用。\n' +
      '  ★ **生产通道**：不给 `human_request_id` 时，本动作会**自己登记**一条 `reason_kind=demo_review` 的人工请求（blocking，' +
      '询问用户"这一轮 DEMO 是否可以"）并挂到本轮；随后走既有 `pipeline_human_relay` → `pipeline_human_reply` → `pipeline_demo confirm`。' +
      '给了 `human_request_id` 则沿用旧判据（本轮创建 / 已 answered / 未被别的轮消费，兼容旧夹具）。\n' +
      '· `action: "confirm"` —— 记下用户对**某一轮**的确认（**必填 `round_index` + `human_request_id`**；请求必须已 `answered`；转告 ≠ 答复）。' +
      '确认之后由主对话触发 `pipeline_transition { event: "demo_passed" }`。\n' +
      '· `action: "status"` —— 看账本与闸门现状（只读）。\n' +
      '★ 未获确认时，`demo_review → ready_dev` 的推进会被闸门 `demo_confirmed` 拒绝（验收 A17）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      action: S('string', `动作：${DEMO_TOOL_ACTIONS.join(' / ')}`, { enum: [...DEMO_TOOL_ACTIONS] }),
      tier: S('string', '★ 本单档位（`L0`…`L5`）；**不给** ⇒ 按最保守处理（等同 L2，发人工请求询问）'),
      /**
       * ★ P1-7：L2 `ask` 的用户决定。
       * `demo` = 要看（走新阶段）；`skip` = 不必出（走 planning→ready_dev 旧路径）。
       * L3+ `require` 传 `skip` 会被拒（裁定 5：L3+ 必须出 DEMO）。
       */
      decision: S('string', '★ `action:"plan"` 用：用户对 `ask` 的决定 —— `demo`（要看，走显式 DEMO 阶段）/ `skip`（不必出，走原路径）；L3+ 不许 skip', { enum: ['demo', 'skip'] }),
      deliverable_ref: S('string', '本轮 DEMO 的交付物引用（路径 / URL / 标识）—— `action:"round"` 的 legacy 写法（新流程用 `pipeline_demo_submit` 交）'),
      deliverable_content: S('string', '本轮 DEMO 的正文（与 ref 一起算指纹，用来判"是不是原地重交"）'),
      human_request_id: S(
        'string',
        '★ `action:"round"` 可选：不给 ⇒ **自动创建**一条 `demo_review` 人工请求并挂到本轮（生产路径，推荐）；' +
          '给了 ⇒ 沿用旧判据（必须**本轮创建**、已 answered、未被别的轮消费，兼容旧夹具）。' +
          '`action:"confirm"` 时**必填**（必须与那一轮挂的 id 一致）。',
      ),
      round_index: S('number', '`round`：要定稿的草稿轮次（`pipeline_demo_submit` 交上来的那一轮）；`confirm` 动作**必填**：要确认的是**第几轮**（必须存在于账本里）'),
      answer: S('string', '`confirm` 用：用户答复的原话/摘要'),
      answer_source: S('string', '`confirm` 用：答复来源', { enum: ['user', 'timeout'] }),
      note: S('string', '备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      code: S('string', '判据码（OK / DEMO_DUPLICATE_DELIVERABLE / DEMO_NOT_CONFIRMED …）'),
      action: S('string', '实际执行的动作'),
      summary: S('string', '给人看的摘要'),
      tier: S('string', '本单档位'),
      demo_action: S('string', '档位处置：skip / ask / require'),
      rounds: S('number', '已**定稿**了几轮 DEMO'),
      round_index: S('number', '涉及的是第几轮（0 = 不涉及）'),
      confirmed: S('boolean', '用户是否已确认 DEMO'),
      blocked_by: S('string', '闸门拦下来的码（没被拦就是空串）'),
      round_cap: S('string', '轮次硬上限的表示（恒为 "none" —— 裁定 13 不设硬上限）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(NO_ACTOR, actor.error)
      const action = String(args.action ?? '').trim()
      if (!DEMO_TOOL_ACTIONS.includes(action)) {
        return fail(BAD_ACTION, `认不出的动作 \`${action}\`（只认 ${DEMO_TOOL_ACTIONS.join(' / ')}）。`)
      }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return fail(TASK_NOT_FOUND, taskNotFound(args.task_id), { action })

      const base = { action, round_cap: DEMO_ROUND_CAP === null ? 'none' : String(DEMO_ROUND_CAP) }

      if (action === 'plan') {
        const r = await store.demoPlan(task.id, { tier: args.tier, by: actor.role, decision: args.decision })
        if (r.ok !== true) return fail(r.code, r.error, base)
        return {
          ...base,
          ok: true,
          code: OK,
          tier: r.plan.tier,
          demo_action: r.plan.action,
          rounds: demoStateOf(r.task).rounds.length,
          round_index: 0,
          confirmed: false,
          blocked_by: '',
          summary: `${r.summary}\n  · ${r.plan.reason}`,
        }
      }

      if (action === 'round') {
        /** P1-7：定稿一轮只发生在 `demo_building`（状态机是必经之路；这里先给可读的下一步）。 */
        if (task.state !== DEMO_ST.BUILDING) {
          return fail(
            'NOT_DEMO_BUILDING',
            `拒绝定稿：任务 ${task.id} 现在的状态是「${task.state}」，不是 **DEMO 制作中**（${DEMO_ST.BUILDING}）。\n` +
              (task.state === DEMO_ST.REVIEW
                ? '★ 已经有一轮在等用户确认（`demo_review`）：用户要改 ⇒ 先 `pipeline_transition { event: "demo_rework" }` 回到制作中。'
                : '★ 定稿轮次必须发生在 DEMO 阶段里：先走 planning → `demo_started` → `demo_building`。'),
            { ...base, tier: demoStateOf(task).plan?.tier ?? '', demo_action: demoStateOf(task).plan?.action ?? '' },
          )
        }
        const r = await store.demoRound(task.id, {
          round_index: args.round_index,
          deliverable: { ref: args.deliverable_ref, content: args.deliverable_content },
          human_request_id: args.human_request_id,
          note: args.note,
          by: actor.role,
        })
        if (r.ok !== true) {
          const st = demoStateOf(task)
          return fail(r.code, `${r.error}\n\n★ 三条软约束：\n${DEMO_SOFT_RULES.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`, {
            ...base,
            rounds: recordedRoundsOf(task).length,
            tier: st.plan?.tier ?? '',
            demo_action: st.plan?.action ?? '',
          })
        }
        return {
          ...base,
          ok: true,
          code: OK,
          tier: demoStateOf(r.task).plan?.tier ?? '',
          demo_action: demoStateOf(r.task).plan?.action ?? '',
          rounds: recordedRoundsOf(r.task).length,
          round_index: r.round.index,
          confirmed: false,
          blocked_by: '',
          summary: r.summary,
        }
      }

      if (action === 'confirm') {
        /** P1-7：确认只发生在 `demo_review`。 */
        if (task.state !== DEMO_ST.REVIEW) {
          return fail(
            'NOT_DEMO_REVIEW',
            `拒绝确认：任务 ${task.id} 现在的状态是「${task.state}」，不是 **DEMO 待用户确认**（${DEMO_ST.REVIEW}）。\n` +
              '★ 先由主对话 `pipeline_demo { action: "round", ... }` 定稿一轮（会推进到 demo_review），再记录用户确认。',
          )
        }
        const r = await store.demoConfirm(task.id, {
          round_index: args.round_index,
          request_id: args.human_request_id,
          answer: args.answer,
          answer_source: args.answer_source,
          by: actor.role,
        })
        if (r.ok !== true) return fail(r.code, r.error, { ...base, round_index: Number(args.round_index) || 0 })
        const st = demoStateOf(r.task)
        return {
          ...base,
          ok: true,
          code: OK,
          tier: st.plan?.tier ?? '',
          demo_action: st.plan?.action ?? '',
          rounds: recordedRoundsOf(r.task).length,
          round_index: r.round_index,
          confirmed: true,
          blocked_by: '',
          summary: r.summary,
        }
      }

      // status（只读）
      const r = await store.demoStatus(task.id)
      if (r.ok !== true) return fail(r.code, r.error, base)
      const st = r.demo
      const recorded = recordedRoundsOf(task)
      return {
        ...base,
        ok: true,
        code: OK,
        tier: st.plan?.tier ?? '',
        demo_action: st.plan?.action ?? '',
        rounds: recorded.length,
        round_index: recorded.length === 0 ? 0 : recorded[recorded.length - 1].index,
        confirmed: r.confirmed,
        blocked_by: r.blocked_by ?? '',
        summary:
          `${r.summary}\n` +
          `  · 状态：${task.state}${r.draft_rounds.length > 0 ? `（另有 ${r.draft_rounds.length} 轮草稿待定稿）` : ''}\n` +
          `  · 轮次硬上限：**无**（裁定 13；软约束三条见下）\n` +
          DEMO_SOFT_RULES.map((s, i) => `    ${i + 1}. ${s}`).join('\n') +
          (r.confirmed ? '\n  · 闸门 `demo_confirmed`：**放行**（`demo_passed` 可通过）。' : `\n  · 闸门 \`demo_confirmed\`：**拦着**（${r.blocked_by}）—— 不能进「待开发」。`),
      }
    },
  })

  /**
   * ★★ **`pipeline_demo_submit`**（P1-8）：交付席位把本轮 DEMO 内容挂到 `task.demo.rounds[i]`。
   *
   * 与 `pipeline_demo` 分开的理由（设计档 §2）：`pipeline_demo` 是**调度**（main），
   * 而 DEMO 内容由**交付席位**产出。过去"计划要求某两个席位各交一半"在机制上不可执行 ——
   * 这个工具就是那条合法出口。
   */
  const demoSubmit = tool(deps, {
    name: DEMO_SUBMIT_TOOL_NAME,
    mutating: true,
    description:
      '【交付席位专用】交本轮 DEMO 内容：把交付物（路径/摘要/内容哈希）挂到 `task.demo.rounds[i]`，' +
      '供主对话的 `pipeline_demo { action: "round", round_index }` 定稿引用。\n' +
      `· 可调用角色：**${DEMO_SUBMIT_ROLES.join(' / ')}**（DEMO 内容由做出来的人交；main 不是交付方）。\n` +
      '· 只在 `demo_building`（DEMO 制作中）可交；**不推进状态** —— 定稿与"可以给用户看了吗"是主对话的判断。\n' +
      '· 一轮可以多席位各交一份（同一 `round_index` 追加）；交完请用 `pipeline_human_request` 发起"请用户看这轮 DEMO"的请求。',
    parameters: {
      task_id: S('string', '任务 ID'),
      deliverable_ref: S('string', '交付物引用（路径 / URL / 标识；至少给 ref 或正文之一）'),
      deliverable_content: S('string', '交付物正文（可空；与 ref 一起算内容哈希，用来判"是不是原地重交"）'),
      round_index: S('number', '挂到哪一轮（缺省 = 当前草稿轮 / 下一轮；多席位合作同一轮时显式给同一个号）'),
      note: S('string', '备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      code: S('string', '判据码（OK / ROLE_NOT_ALLOWED / NOT_DEMO_BUILDING / DEMO_NO_DELIVERABLE …）'),
      summary: S('string', '给人看的摘要'),
      round_index: S('number', '挂到了第几轮（0 = 没挂上）'),
      rounds: S('number', '已交了几份交付物（本轮）'),
      digest: S('string', '本轮合并指纹'),
      content_hash: S('string', '本份交付物的内容哈希（无正文时为空串）'),
      state: S('string', '任务当前状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return submitFail(NO_ACTOR, actor.error)
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return submitFail(TASK_NOT_FOUND, taskNotFound(args.task_id))
      const r = await store.demoSubmit(task.id, {
        actorRole: actor.role,
        deliverableRef: args.deliverable_ref,
        deliverableContent: args.deliverable_content,
        roundIndex: args.round_index,
        note: args.note,
        actorAgentId: actor.agentId,
      })
      if (r.ok !== true) return submitFail(r.code, r.error, { state: task.state })
      return {
        ok: true,
        code: OK,
        summary: r.summary,
        round_index: r.round.index,
        rounds: Array.isArray(r.round.deliverables) ? r.round.deliverables.length : 0,
        digest: r.round.digest ?? '',
        content_hash: r.deliverable.content_hash ?? '',
        state: r.task.state,
      }
    },
  })

  return { demo, demoSubmit }
}
