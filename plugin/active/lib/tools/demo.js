// DEMO 工具面 · `pipeline_demo`：档位策略 / 交一轮 / 记确认 / 查状态（四个动作一个工具）。
/**
 * dsh-pipeline · 工具面 · `pipeline_demo`
 * ============================================================================
 * 四个动作（用一个工具而不是四个，因为它们是**同一条链上的四步**，
 * 拆成四个工具只会让模型更容易漏掉"交完要挂请求""确认要认轮次"这些约束）：
 *
 *   · `plan`    算这个档位该怎么处理 DEMO（L0–L1 skip / L2 ask / L3+ require）
 *   · `round`   交**一轮** DEMO（同时挂一条人工请求；原地重交会被拒）
 *   · `confirm` 记下**用户对某一轮**的确认（要求那条请求**已被答复**）
 *   · `status`  看账本与闸门现状（只读）
 *
 * ★ 本文件**不做判定** —— 判定在 `demo-rounds.js`（纯函数）与 `demo-gate.js`（闸门）；
 *   写盘在 `lib/store/demo.js`。工具面只负责"参数 → 调用 → 人话摘要"。
 *
 * @module dsh-pipeline/lib/tools/demo
 */

import { S, tool, resolveActor } from './kit.js'
import { DEMO_ROUND_CAP } from '../states/demo-phase.js'
import { DEMO_SOFT_RULES, demoStateOf } from '../store/demo-rounds.js'
// ★ 判据码 + 拒绝文案的**唯一出处**（`lib/errors/`）；本文件的判据与文案字面值未动。
import { BAD_ACTION, NO_ACTOR, OK, TASK_NOT_FOUND } from '../errors/codes.js'
import { taskNotFound } from '../errors/text.js'

/** 工具名（唯一出处）。 */
export const DEMO_TOOL_NAME = 'pipeline_demo'

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

/**
 * 工具定义（与其余 `pipeline_*` 工具同形）。
 *
 * @param {object} ctx - `{ deps, store, load }`
 * @returns {{demo:object}}
 */
export function buildDemoTools(ctx) {
  const { deps, store, load } = ctx

  const demo = tool(deps, {
    name: DEMO_TOOL_NAME,
    mutating: true,
    description:
      '【DEMO 阶段】复杂任务**先出可操作前端 DEMO**，**用户确认后才继续后端**（裁定 5/6）。\n' +
      '· `action: "plan"` —— 算档位策略：**L0–L1 可跳 / L2 询问 / L3+ 必须出**；tier 未知按 L2 保守，非法 tier 直接拒。\n' +
      '· `action: "round"` —— 交一轮 DEMO。**无轮次硬上限**；三条软约束：每轮必须是**新交付物**（原地重交被拒）、每轮挂**一条人工请求**、`cancel` 出口始终可用。\n' +
      '· `action: "confirm"` —— 记下用户对**某一轮**的确认（那条请求必须已 `answered` —— 转告 ≠ 答复）。\n' +
      '· `action: "status"` —— 看账本与闸门现状（只读）。\n' +
      '★ 未获确认时，向 `ready_dev` 的推进会被闸门 `demo_confirmed` 拒绝（验收 A17）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      action: S('string', `动作：${DEMO_TOOL_ACTIONS.join(' / ')}`, { enum: [...DEMO_TOOL_ACTIONS] }),
      tier: S('string', '★ 本单档位（`L0`…`L5`）；**不给** ⇒ 按最保守处理（等同 L2，发人工请求询问）'),
      deliverable_ref: S('string', '本轮 DEMO 的交付物引用（路径 / URL / 标识）'),
      deliverable_content: S('string', '本轮 DEMO 的正文（与 ref 一起算指纹，用来判"是不是原地重交"）'),
      human_request_id: S('string', '★ 本轮挂上的人工请求 id（软约束②；没挂 ⇒ 这一轮不算数）'),
      round_index: S('number', '`confirm` 用：要确认的是**第几轮**（必须存在于账本里）'),
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
      rounds: S('number', '已交了几轮 DEMO'),
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
        const r = await store.demoPlan(task.id, { tier: args.tier, by: actor.role })
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
        const r = await store.demoRound(task.id, {
          deliverable: { ref: args.deliverable_ref, content: args.deliverable_content },
          human_request_id: args.human_request_id,
          note: args.note,
          by: actor.role,
        })
        if (r.ok !== true) {
          const st = demoStateOf(task)
          return fail(r.code, `${r.error}\n\n★ 三条软约束：\n${DEMO_SOFT_RULES.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`, {
            ...base,
            rounds: st.rounds.length,
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
          rounds: demoStateOf(r.task).rounds.length,
          round_index: r.round.index,
          confirmed: false,
          blocked_by: '',
          summary: r.summary,
        }
      }

      if (action === 'confirm') {
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
          rounds: st.rounds.length,
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
      return {
        ...base,
        ok: true,
        code: OK,
        tier: st.plan?.tier ?? '',
        demo_action: st.plan?.action ?? '',
        rounds: st.rounds.length,
        round_index: st.rounds.length === 0 ? 0 : st.rounds[st.rounds.length - 1].index,
        confirmed: r.confirmed,
        blocked_by: r.blocked_by ?? '',
        summary:
          `${r.summary}\n` +
          `  · 轮次硬上限：**无**（裁定 13；软约束三条见下）\n` +
          DEMO_SOFT_RULES.map((s, i) => `    ${i + 1}. ${s}`).join('\n') +
          (r.confirmed ? '\n  · 闸门 `demo_confirmed`：**放行**（可以进「待开发」）。' : `\n  · 闸门 \`demo_confirmed\`：**拦着**（${r.blocked_by}）—— 不能进「待开发」。`),
      }
    },
  })

  return { demo }
}
