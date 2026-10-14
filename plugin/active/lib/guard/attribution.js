/**
 * dsh-pipeline · 守门 · **拒绝理由按角色归因**（不许串角色）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑦b / ⑧）
 * -----------------------------------------------------------------------------
 * 同一条拒绝，无论调用方是谁，理由都写死成同一句：
 *
 *     [pipeline] 拒绝：角色「main」不得通过 shell 修改项目文件。
 *     原因：**测试/审核不得替编写改代码**；shell 旁路与文件工具受同一套规则约束。
 *
 * 而 `main` **既不是测试、也不是审核** —— 那句理由说的是**另一个角色的边界**。
 * 用户的原话是「归因串角色」：拒绝本身没错（主对话确实不该用 shell 改项目文件），
 * 但**给的理由不是它犯的那条**。同样的文案也出现在"用 shell 删 `.pipeline` 旧单"那次
 * （缺陷 ⑦b）—— 用户拿到的是一句解释了别人的话。
 *
 * -----------------------------------------------------------------------------
 * 判据（三条）
 * -----------------------------------------------------------------------------
 *   ① 理由必须**说调用方自己**犯的是哪条边界；
 *   ② 理由必须指出**他能走哪条正路**（不然就是把人堵在墙前面）；
 *   ③ 认不出的角色**如实说"这条边界对你也适用"**，不硬套一个别人的身份。
 *
 * ★ 这不是文案洁癖：拒绝文案是**调用方唯一的行动依据**。给错理由 =
 *   它会去改一件跟它无关的事（真机现场主对话就是照那句理由去怀疑 tester/reviewer 的边界）。
 *
 * @module dsh-pipeline/lib/guard/attribution
 */

import { ROLE } from '../roles.js'

/** 角色 → 它自己那条"不得用 shell 改项目文件"的理由 + 正路。 */
const OWN_REASON = Object.freeze({
  [ROLE.MAIN]:
    '主对话只做四件事：**接需求 / 派活 / 跟踪状态 / 关单** —— 写项目文件不是它的活。\n' +
    '  · 要改代码：派编写席位（pipeline_dispatch role=writer），改动面由计划的 `change_scope` 管；\n' +
    '  · 要收尾清理跑完的单：用 **pipeline_task_purge**（终态单归档/删除，有审计留痕）—— 不要用 shell 删。',
  [ROLE.ORCHESTRATOR]:
    '需求分析只产出**任务卡 + 不清楚处清单**，不写实现 —— 它连代码都不读（只看需求原文与需求档）。',
  [ROLE.PLANNER]:
    '计划 AI 只产出**计划 + 自检 + 分配结论**，不写实现 —— 它连代码都不读。\n' +
    '  要改代码：把它派给编写席位。',
  [ROLE.SUPERVISOR]:
    '主管只做**确认与枢纽动作**（发起 / 同意 / 确认 / 否决 / 升级），不写实现。',
  [ROLE.TESTER]:
    '**测试不得替编写改代码** —— 改了就没有独立验证了。\n' +
    '  发现缺陷：pipeline_handoff（test_to_dev）或 pipeline_rework 把问题打回编写。',
  [ROLE.REVIEWER]:
    '**审核不得替编写改代码** —— 它只核对，不改任何东西。\n' +
    '  要写意见：写进自己的日志（reports/reviewer/reviewer*.log），或交 review_verdict。',
  [ROLE.ARCHITECT]:
    '架构角色只出方案，不改代码。要落地：把它交给编写席位。',
  [ROLE.SECURITY]:
    '安全角色只出结论，不改代码。要落地：把它交给编写席位。',
  [ROLE.ARCHIVIST]:
    '留档 AI 只汇总各方记录成需求档，不改代码。',
  [ROLE.DIAGRAMMER]:
    '架构图角色只出图，不改代码。',
  [ROLE.RELEASE]:
    '发布角色只出发布方案，不改代码。',
  [ROLE.DOCS]:
    '文档角色只出文档说明，不改代码。',
  [ROLE.PERFORMANCE]:
    '性能角色只出性能结论，不改代码。',
  [ROLE.ARBITER]:
    '仲裁角色只出仲裁结论，不改代码。',
})

/**
 * 「不得通过 shell 修改项目文件」这条拒绝的**理由段**（按角色）。
 *
 * @param {string} role
 * @returns {string}
 */
export function whyShellWriteRefused(role) {
  const r = String(role ?? '')
  const own = OWN_REASON[r]
  if (own !== undefined) return `原因：${own}\n`
  return (
    `原因：**「${r || '(未知角色)'}」这一档没有写项目文件的权限** —— shell 旁路与文件工具受同一套规则约束。\n` +
    '  要改代码：让主对话派编写席位；要交结论：用结构化交接物（pipeline_handoff）。\n'
  )
}

/**
 * 这条理由是不是**说调用方自己**（自测里用它钉住"不许再串角色"）。
 *
 * @param {string} role
 * @param {string} text - 完整的拒绝文案
 * @returns {boolean}
 */
export function reasonIsAboutOwnRole(role, text) {
  const r = String(role ?? '')
  const t = String(text ?? '')
  if (!t.includes('原因：')) return false
  // 串角色的特征：对 main / orchestrator / planner / supervisor 说"测试/审核…"
  const saysTesterReviewer = t.includes('测试/审核不得替编写改代码') || t.includes('测试不得替编写') || t.includes('审核不得替编写')
  if (saysTesterReviewer && ![ROLE.TESTER, ROLE.REVIEWER].includes(r)) return false
  const own = OWN_REASON[r]
  return own === undefined ? t.includes('没有写项目文件的权限') : t.includes(own.slice(0, 12))
}
