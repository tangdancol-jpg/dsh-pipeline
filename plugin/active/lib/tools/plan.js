/**
 * dsh-pipeline · 计划与授权面变更（pipeline_plan / pipeline_scope_amend）
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/plan
 */

import { HUMAN_URGENCIES } from '../handoff.js'
import { ROLE, ROLES, roleLabel } from '../roles.js'
// ★★ P1-8：DEMO 交付席位白名单（唯一出处）—— 计划自检用它判"要求谁交 DEMO"是否可执行。
import { DEMO_EVENTS, DEMO_ST, DEMO_SUBMIT_ROLES } from '../states/demo-phase.js'
import { STATE_LABEL } from '../states.js'
import { renderRequirementDoc } from '../context.js'
import { NONFINITE_BOUNDARY_HINT, boundaryHintLine } from '../intake/boundary-hints.js'
import { TIER_ORDER, buildRoster, deferrableProductsOf, deferralLine, validateDeferredArtifacts } from '../tiers.js'
import { toStringArray } from '../util.js'
// ★★ 分区覆盖校验（2026-10-18 测试报告 P0-1）：授权面里的每条路径必须**有主** ——
//    要么落在某个编写分区的 `scope_paths` 下，要么显式写 `owner_role`（非编写归属）。
//    判据与守门**同源**：直接复用 `owningSeat` / `resolveScopeAnchor`，不在计划侧另抄一份路径匹配。
import { owningSeat, resolveScopeAnchor } from '../guard/seats.js'
import { resolveScopePath } from '../scope/root-marker.js'
// ★★ 长入参通道（`spec_path`）：字段说明的唯一出处在这儿，别在 schema 里另抄一份。
import { ARGS_FILE_DOC } from './args-file.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { taskNotFound } from '../errors/text.js'

/**
 * ★★ **P1-8：计划里的 DEMO 交付面自检**（纯函数；在交计划/分配之前判）。
 *
 * 现场（设计档 `04-demo与制品模型.md` §2）：计划步骤要求"某两个席位各交一半 DEMO"，
 * 但当时 `pipeline_demo` **只有 main 能调** —— 计划写了、机制不允许，矛盾没有任何一处会指出。
 * 推荐 A 拆出 `pipeline_demo_submit` 之后，这条判据把"计划说的"和"机制允许的"对账：
 *
 *   ① 计划步骤/角色边界里**要求交付 DEMO** 的句子，若点名了某个角色：
 *      · 该角色必须**有 submit 权限**（`DEMO_SUBMIT_ROLES`）；
 *      · 该角色必须**在本档角色清单里**（在册）；
 *   ② 没点名角色时，本档清单里至少要有一个**可 submit 的角色**；
 *   ③ 矛盾 ⇒ 计划**不提交、不分配**，文案给出改法。
 *
 * @param {object} input
 * @param {string[]} input.planSteps
 * @param {object[]} input.roleBoundaries - `[{ role, only[], not[] }]`
 * @param {string[]} input.executionRoles - 本档执行角色（`buildRoster` 的结论）
 * @returns {{ok:boolean, errors:string[], demands:number, submitters:string[]}}
 */
function checkDemoDeliveryPlan({ planSteps, roleBoundaries, executionRoles }) {
  const exec = Array.isArray(executionRoles) ? executionRoles.map(String) : []
  const submitters = exec.filter((r) => DEMO_SUBMIT_ROLES.includes(r))
  const textOf = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).join(' ') : String(v ?? ''))
  const entries = []
  for (const s of toStringArray(planSteps)) entries.push({ where: '计划步骤', text: String(s) })
  for (const b of Array.isArray(roleBoundaries) ? roleBoundaries : []) {
    if (b === null || typeof b !== 'object') continue
    const role = String(b.role ?? '').trim()
    const text = `${textOf(b.only)} ${textOf(b.not)}`
    if (text.trim().length > 0) entries.push({ where: `角色边界卡${role.length > 0 ? `（${role}）` : ''}`, text })
  }

  /**
   * "要求交付 DEMO"的判据：句子里有 demo，且相邻有"交付/出/做/提交/制作/写/画/搭"类动词。
   * 刻意只认**紧邻**关系（16 个字符内）—— 只写"参考 DEMO"不算要求交付。
   */
  const DEMAND_RE = /(交付|出|做|提交|制作|写|画|搭)[^。；;\n]{0,16}demo|demo[^。；;\n]{0,16}(交付|页面|原型|可操作)/i
  const demands = entries.filter((e) => /demo/i.test(e.text) && DEMAND_RE.test(e.text))

  const errors = []
  if (demands.length === 0) return { ok: true, errors, demands: 0, submitters }

  /** 在句子里认出角色：英文 id（词边界）+ 中文角色名（子串）。 */
  const mentionOf = (text) => {
    const out = new Set()
    for (const [id, spec] of Object.entries(ROLES)) {
      if (id === ROLE.MAIN) continue
      if (new RegExp(`(^|[^a-z0-9_])${id}([^a-z0-9_]|$)`, 'i').test(text)) out.add(id)
      const zh = String(spec?.zh ?? '').trim()
      if (zh.length > 0 && text.includes(zh)) out.add(id)
    }
    return [...out]
  }

  for (const d of demands) {
    const mentioned = mentionOf(d.text)
    if (mentioned.length === 0) {
      /** 没点名角色：只要本档清单里有一个"能交 DEMO"的角色就够（谁交由派活时定）。 */
      if (submitters.length === 0) {
        errors.push(
          `${d.where}：「${d.text.trim().slice(0, 80)}」要求交付 DEMO，但本档清单里**没有任何可交 DEMO 的角色**` +
            `（需要 ${DEMO_SUBMIT_ROLES.join(' / ')} 之一）—— 加一个 \`extra_roles\`，或把这句改成不需要 DEMO。`,
        )
      }
      continue
    }
    for (const role of mentioned) {
      if (!DEMO_SUBMIT_ROLES.includes(role)) {
        errors.push(
          `${d.where}：「${d.text.trim().slice(0, 80)}」要求「${roleLabel(role)}(${role})」交付 DEMO，` +
            `但它**没有 \`pipeline_demo_submit\` 权限**（只有 ${DEMO_SUBMIT_ROLES.join(' / ')}）—— 改由其中一个角色交，或删掉这句。`,
        )
      } else if (!exec.includes(role)) {
        errors.push(
          `${d.where}：「${d.text.trim().slice(0, 80)}」要求「${roleLabel(role)}(${role})」交付 DEMO，` +
            `但它**不在本档角色清单里**（在册：${exec.join('、') || '（无）'}）—— 用 \`extra_roles\` 把它加进清单，或改由在册的 ` +
            `${submitters.join(' / ') || '（本档没有可交 DEMO 的角色）'} 交。`,
        )
      }
    }
  }
  return { ok: errors.length === 0, errors, demands: demands.length, submitters }
}

/**
 * 计划与授权面变更（pipeline_plan / pipeline_scope_amend）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildPlanTools(ctx) {
  const { deps, config, store, tokens, indexTask, load, lastAnalysisOf } = ctx

  // =========================================================================
  // 2.5 pipeline_plan —— 计划 AI：出计划 → 自检 → 分配 AI
  // =========================================================================
  //
  // ★ 本轮新增。它是**角色清单的唯一出口**（原先那是 pipeline_orchestrate 的活）。
  //
  // 一次调用做三件事，顺序是刻意的：
  //   ① 交 `plan` 交接物（计划步骤 + 层清单 + **自检结果**）；
  //      · 自检 verdict=gaps ⇒ 状态被推到「等待需求分析答复」，**到此为止**，
  //        绝不再往下走分配（store 层也有一道闸，任何路径都绕不过去）；
  //      · 自检 verdict=ok ⇒ 继续第 ② 步。
  //   ② 写角色清单（setRoster，judgedBy=planner）—— 档位、几个 AI、角色、顺序、席位分层。
  //   ③ 状态进「待开发」。
  const planTool = tool(deps, {
    name: 'pipeline_plan',
    mutating: true,
    /** ★★ 长入参通道：`spec_path` 指一份 JSON，工具读它当整份入参（内联优先）。 */
    argsFile: { field: 'spec_path' },
    description:
      '【计划 AI 专用】出计划 → **自检计划有无缺失** → 无缺失则**分配 AI**（角色清单 / 用几个独立对话 / 派谁 / 什么顺序 / 编写席位与层分工）。' +
      '★ 这是"要调用几个 AI"的**唯一出口**（本轮从 pipeline_orchestrate 移交过来）。' +
      '自检 verdict=gaps 时**不会分配**：状态会退回需求分析（等待需求分析答复），等它给结论或升级给用户。' +
      '席位数由层数决定（count === layers.length），默认层清单：接口层 / 数据层 / 处理层。' +
      '★★ **长中文入参一律走 `spec_path`（写进文件再传路径），不要内联** —— ' +
      '本工具的 `reason` / `plan_steps` / `role_scope` / `role_boundaries` / `change_scope` 都是长段落，' +
      '内联时模型侧写坏参数 JSON 会让宿主判 `MALFORMED_RESPONSE` 并**作废整轮上下文**；写进文件则大段内容不经过工具参数。',
    parameters: {
      task_id: S('string', '任务 ID'),
      spec_path: S('string', ARGS_FILE_DOC.spec_path),
      plan_steps: S('array', '计划步骤（按顺序）', { items: { type: 'string' } }),
      layers: S('array', '★ 层清单 [{layer, scope_paths[], deliverables[]}] —— 一个层一个编写席位；不传 = 单层 all（范围整棵项目根）', { items: { type: 'object', additionalProperties: true } }),
      self_check_verdict: S('string', '★ 自检结论', { enum: ['ok', 'gaps'] }),
      self_check_checked: S('array', '★ 自检**核对过什么**（逐条列，不能只给结论）', { items: { type: 'string' } }),
      self_check_gaps: S('array', '自检发现的缺失（verdict=ok 时必须为空）', { items: { type: 'string' } }),
      gap_stage: S('string', '卡在哪一步（verdict=gaps 时必填）'),
      gap_question: S('string', '要问需求分析的问题（问句；verdict=gaps 时必填）'),
      gap_context: S('string', '★ 脱敏摘要（不许含代码；verdict=gaps 时必填）'),
      gap_urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      plan_reason: S('string', '为什么这么计划（可追溯）'),
      risks: S('array', '计划层面的风险', { items: { type: 'string' } }),
      based_on_analysis: S('string', '依据哪份需求分析结论（requirement_analysis 的 handoff_id；可空）'),
      /** ★ 设计目的（最小改动）：授权改动面。 */
      change_scope: S('array', '★ 授权改动面 [{ id, path, action: modify|create|delete, why }] —— 编写**只能在这个清单内动**；**新增文件也算越界**（要新建就显式写 create）；"顺手重构 / 统一风格 / 升级依赖"写不出 why ⇒ 不许', { items: { type: 'object', additionalProperties: true } }),
      /** ★ 越界清单：这次不许做什么（给 writer 与 reviewer 一起看）。 */
      forbidden: S('array', '★ **越界清单**（这次**不许**做什么；至少 1 条。例如：不许顺手重构 / 不许改测试 / 不许扩范围 / 不许改依赖）', { items: { type: 'string' } }),
      /** ★ 设计目的（职责自限）：每个执行角色一张边界卡。 */
      role_boundaries: S('array', '★ 角色边界卡 [{ role, only: string[], not: string[] }] —— **必须覆盖清单里每一个执行角色**；派活时按它派，别让谁顺手多干', { items: { type: 'object', additionalProperties: true } }),
      role_scope: S('object', '★ 计划 AI 自己的职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么', { additionalProperties: true }),
      // --- 分配 AI（verdict=ok 时才用得到）---
      tier: S('string', '档位 L0~L5（必须给）', { enum: TIER_ORDER }),
      /**
       * ★★ **P1-18：按档位豁免的产物**（设计档 `04-demo与制品模型.md` §4「推荐 A」）。
       *
       * 只在**自检 verdict=ok 且给了 tier** 时可用；非法 ⇒ **拒收计划**（在分配前）。
       * kind 必须是本档矩阵里"可豁免"的必需产物：
       *   · L4：architecture_diagram / release_plan
       *   · L5：再加 docs_note / perf_report
       * 测试 / 审核 / 安全类产物**不可豁免**（既有闸门执法，deferred 绕不过去）。
       */
      deferred_artifacts: S(
        'array',
        '★ 按档位豁免的产物 [{ kind, why, accepted_by }] —— kind 必须是本档"可豁免"的必需产物（L4+: 架构图/发布计划；L5: 再加文档/性能）；why 必填；accepted_by=user 或 supervisor（supervisor 仅 L4+）。测试/审核/安全类不可豁免；非法即拒收计划',
        { items: { type: 'object', additionalProperties: true } },
      ),
      reason: S('string', '★ 分配理由：为什么是这一档、为什么是这几个角色、为什么这么分层（必须给，会留痕可追溯）'),
      extra_roles: S('array', '额外需要的角色（L5 从扩展池里挑）', { items: { type: 'string' } }),
      writers: S('object', '★编写席位方案 { layers: ["interface","data","logic"], partitions: [{seat, layer, scope_paths[], interface_owner, deliverables[]}], reason }。**席位数 = 层数**；不传 = 单席位（层 all，范围整棵项目根）', { additionalProperties: true }),
      relay_policy: S('object', '★继任策略 { warnPercent, triggerContextPercent, hardLimitPercent, maxSuccessionsPerSeat, allowedRoles[], enabledTiers[] }。主对话只能在此授权内换班', { additionalProperties: true }),
      acceptance: S('array', '验收标准（沿用需求分析的结论即可）', { items: { type: 'string' } }),
      test_points: S('array', '测试要点', { items: { type: 'string' } }),
      boundaries: S('array', '边界条件。★ 需求面提示：' + NONFINITE_BOUNDARY_HINT, { items: { type: 'string' } }),
      /**
       * ★★ **四槽声明**（B1 的数据通路；不传 = 全部落显式默认）。
       *
       * 形状：`{ "<角色>": { permission, mode, model, reasoning }, "<角色>@<席位>": {...} }`
       * —— `<角色>` 用于非编写角色（tester / reviewer / architect / security / archivist …），
       * `<角色>@<席位>` 用于编写席位（`writer@writer#1`）。**四个槽是四个平级字段**，
       * 不许打包成 `options`。
       *
       * ★ 声明了就**必须声明齐**（每个要落槽位的席位一条都不许少）：只声明一半会被拒，
       *   因为那看起来像"已经安排好了"。不声明 = 名单给每个席位落**显式默认**
       *   （权限档 = 最小档 `read-only`，带 `origin=default`，与"声明了最小档"可区分）。
       */
      slots: S('object', '★四槽声明 { "<角色>": {permission,mode,model,reasoning}, "<角色>@<席位>": {...} }；不传 = 全部落显式默认（权限档 = 最小档 read-only）', { additionalProperties: true }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含档位、几个 AI、层与席位、拒绝原文）'),
      tier: S('string', '最终档位（自检未通过时为空串）'),
      ai_count: S('number', '需要的独立对话总数（自检未通过时为 0）'),
      roles: S('string', '角色清单（顿号分隔）'),
      sequence: S('string', '调用顺序'),
      allocated: S('boolean', '是否已经分配 AI（自检 gaps 时为 false）'),
      /** ★ P1-18：本计划声明并落盘的豁免项（形如 `[{kind, why, accepted_by}]`）。 */
      deferred_artifacts: S('array', '★ 本计划声明并落盘的豁免项 [{ kind, why, accepted_by }]（没有就是空数组）', { items: { type: 'object', additionalProperties: true } }),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      const empty = { ok: false, tier: '', ai_count: 0, roles: '', sequence: '', allocated: false }
      if (actor.ok !== true) return { ...empty, summary: actor.error }

      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ...empty, summary: taskNotFound(args.task_id) }

      // --- ① 交计划（含自检）------------------------------------------------
      const selfCheck = {
        verdict: String(args.self_check_verdict ?? ''),
        checked: toStringArray(args.self_check_checked),
        gaps: toStringArray(args.self_check_gaps),
      }

      // --- ①a ★★ P1-18：按档位豁免的产物 —— **在分配前**（交计划之前）判死 ------
      //
      //   ★ 为什么必须判在这里：
      //     · 一旦 `submitHandoff(plan)` 先落盘、`setRoster` 再分配，任务就已经到
      //       「待开发」了；拒了还得靠人重走一轮。计划这一站是最后一个"什么都没写"
      //       的时刻 —— 非法豁免必须在这里被拦下（"非法 ⇒ 拒收计划，在分配前"）。
      //     · 档位（tier）是判断"这个 kind 在本档能不能豁免"的唯一依据，所以声明豁免
      //       就必须同时给合法 tier；自检 gaps 的计划也谈不上豁免（还没到分配那一步）。
      //   ★ 合法项原样进 plan 交接物 payload，再由 `store.setRoster` 落到
      //     `task.deferred_artifacts` —— 关单闸与状态展示读的都是那一份。
      let deferredArtifacts = []
      // ⚠️ 空数组 = "没有声明豁免"（不触发那条"gaps 计划不许带豁免"的判据）——
      //    调用方可能习惯性地传 `deferred_artifacts: []`，那不该被当成一次声明。
      const deferredDeclared =
        args.deferred_artifacts !== undefined &&
        args.deferred_artifacts !== null &&
        (!Array.isArray(args.deferred_artifacts) || args.deferred_artifacts.length > 0)
      if (deferredDeclared) {
        if (selfCheck.verdict !== 'ok') {
          return {
            ...empty,
            summary:
              '拒绝：自检 verdict 不是 ok 时**不能**声明 deferred_artifacts —— 计划**没有提交**。\n' +
              '★ 自检发现缺口就先去补缺口（退回需求分析），"豁免产物"是自检通过之后才谈的事。',
          }
        }
        if (typeof args.tier !== 'string' || !TIER_ORDER.includes(args.tier)) {
          return {
            ...empty,
            summary:
              `拒绝：声明 deferred_artifacts 必须同时给**合法档位**（${TIER_ORDER.join('/')}）—— 计划**没有提交**。\n` +
              `你给的 tier 是 ${JSON.stringify(args.tier ?? null)}。\n` +
              '★ 能不能豁免、能豁免哪几项，是按档位矩阵算的；没有档位就没有判据。',
          }
        }
        const dv = validateDeferredArtifacts(args.deferred_artifacts, { tier: args.tier })
        if (dv.ok !== true) {
          return {
            ...empty,
            summary:
              `拒绝：计划的 deferred_artifacts **非法**（${dv.errors.length} 处）—— 计划**没有提交**、也没有分配 AI。\n` +
              dv.errors.map((e, i) => `  ${i + 1}) ${e}`).join('\n') +
              `\n本档（${args.tier}）可豁免的必需产物：${deferrableProductsOf(args.tier).join(' / ') || '（无）'}\n` +
              '★ 三条硬边界：① 测试 / 审核 / 安全类产物不可豁免；② 计划不能自己豁免自己' +
              '（accepted_by 只能是 user / supervisor，supervisor 仅 L4+ 有效）；③ why 必填。',
          }
        }
        deferredArtifacts = dv.items
      }

      const planPayload = {
        task_id: task.id,
        based_on_analysis: typeof args.based_on_analysis === 'string' ? args.based_on_analysis : '',
        plan_steps: toStringArray(args.plan_steps),
        layers: Array.isArray(args.layers) ? args.layers : [],
        self_check: selfCheck,
        plan_reason: String(args.plan_reason ?? ''),
        risks: toStringArray(args.risks),
        // ★ 设计目的：**最小改动**（授权改动面）+ **职责自限**（自己的 + 每个角色的边界卡）
        change_scope: Array.isArray(args.change_scope) ? args.change_scope : [],
        forbidden: toStringArray(args.forbidden),
        role_boundaries: Array.isArray(args.role_boundaries) ? args.role_boundaries : [],
        /**
         * ★★ P1-18：按档位豁免的产物（已在上面的 ①a 校验过）。
         *   `store.setRoster` 会把它落到 `task.deferred_artifacts` —— 关单闸
         *   `role_products_delivered` 与 `pipeline_status` 读的都是任务卡上那一份
         *   （交接物是**历史**，任务卡是**当前生效的结论**）。
         */
        deferred_artifacts: deferredArtifacts,
        role_scope: args.role_scope,
        /**
         * ★★ **B1 的第二半：四槽声明的落点**。
         *
         * 计划的 `writers` 与 `role_boundaries` 早就有列，但"四槽声明"**没有任何字段承载它** ——
         * `store.setRoster` 从来没收到过 `slots` ⇒ 名单的四槽表永远只有默认值，
         * 计划 AI 把四槽写在哪个字段里都进不来。这里补上行使其可落：
         * 形状 `{ "<角色>": {permission,mode,model,reasoning}, "<角色>@<席位>": {...} }`。
         * 不传 = 全部落显式默认（权限档 = 最小档 read-only，origin=default）。
         */
        slots: args.slots !== null && typeof args.slots === 'object' ? args.slots : null,
      }
      if (selfCheck.verdict === 'gaps') {
        planPayload.gap_stage = args.gap_stage
        planPayload.gap_question = args.gap_question
        planPayload.gap_context = args.gap_context
        planPayload.gap_urgency = typeof args.gap_urgency === 'string' && args.gap_urgency.length > 0 ? args.gap_urgency : 'blocking'
      }

      /**
       * ★★ **P1-8：计划的 DEMO 交付面自检（在**交计划之前**判）**。
       *
       * 判据：计划步骤/角色边界里"要求交付 DEMO"的句子，点到的角色必须
       * **有 `pipeline_demo_submit` 权限**且**在本档清单里**；没点名时清单里也至少要有一个可交的角色。
       * 矛盾 ⇒ **拒收计划**（交接物不落盘、不 setRoster、不分配）——任务书原文「矛盾即拒收计划」。
       *
       * ★ 为什么放在 submitHandoff **之前**：`plan` 交接物一旦落盘，"计划没提交"就不成立了；
       *   而这条判据只依赖 args + 本档执行角色（`buildRoster` 算得出来），不需要先落盘。
       */
      if (selfCheck.verdict === 'ok' && typeof args.tier === 'string' && TIER_ORDER.includes(args.tier)) {
        const demoProbe = buildRoster({
          tier: args.tier,
          reason: String(args.reason ?? '计划自检'),
          judgedBy: 'planner',
          extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
          l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
          writers: args.writers,
          relayPolicy: args.relay_policy,
        })
        if (demoProbe.ok === true) {
          const demoDelivery = checkDemoDeliveryPlan({
            planSteps: args.plan_steps,
            roleBoundaries: planPayload.role_boundaries,
            executionRoles: demoProbe.roster.execution_roles,
          })
          if (demoDelivery.ok !== true) {
            return {
              ...empty,
              summary:
                `拒绝：计划里的 **DEMO 交付方与机制不一致**（${demoDelivery.errors.length} 处）—— 计划**没有提交**、也没有分配 AI。\n` +
                demoDelivery.errors.map((e) => `  · ${e}`).join('\n') +
                '\n★ 判据（P1-8，设计档 §2「推荐 A」）：DEMO 内容只能由**交付席位**交 —— ' +
                `${DEMO_SUBMIT_ROLES.join(' / ')}（工具：\`pipeline_demo_submit\`）；` +
                '主对话只用 `pipeline_demo` 做 round / confirm / status。\n' +
                '两条改法（选一条）：\n' +
                '  ① 把 DEMO 交付写进**在册的可交付角色**（writer / architect / diagrammer）的边界卡，或直接不点名、让派活时定；\n' +
                '  ② 确实需要新角色 ⇒ 在计划里用 `extra_roles` 把它加进清单（例如 `extra_roles: ["diagrammer"]`）。',
            }
          }
        }
      }

      const sub = await store.submitHandoff({
        taskId: task.id,
        kind: 'plan',
        payload: planPayload,
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
      })
      if (sub.ok !== true) return { ...empty, summary: sub.error }
      indexTask(sub.task.id, sub.task)

      // --- 自检未过：**到此为止**（状态已回流到需求分析）----------------------
      if (selfCheck.verdict !== 'ok') {
        return {
          ok: true,
          allocated: false,
          tier: '', ai_count: 0, roles: '', sequence: '',
          summary:
            `计划已提交，但自检结论是 **gaps**（${selfCheck.gaps.length} 条缺失）—— **不会分配 AI**。\n` +
            `已退回需求分析：${sub.summary}\n` +
            `问它的问题：${String(args.gap_question ?? '')}\n` +
            '接下来的路径（沿用既有两级梯，没有另起通道）：\n' +
            '  ① 需求分析 pipeline_clarify_reply 裁定（answered）→ 状态回到「计划中」，你按结论重出计划；\n' +
            '  ② 它答不了（cannot_answer）→ 由它 pipeline_human_request 升级给用户 → 主对话转告 → 用户答复。\n' +
            '★ 补完缺口后重交一份 self_check.verdict=ok 的计划即可继续。',
        }
      }

      // --- ② 分配（写角色清单）+ ③ 状态进「待开发」--------------------------
      if (typeof args.tier !== 'string' || !TIER_ORDER.includes(args.tier)) {
        return { ...empty, summary: `自检已过，但分配需要 tier（${TIER_ORDER.join('/')}）—— 你给的是 ${JSON.stringify(args.tier ?? null)}。` }
      }
      if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
        return { ...empty, summary: '分配必须给 reason —— 每次判断都要有理由记录、可追溯。' }
      }

      // ★★ **P0-1 分区覆盖校验**（2026-10-18 测试报告）：授权面里的每条路径必须"有主"。
      //
      //   现场（真机 T-20261018 单）：`change_scope` 里有 README / CHANGES / selftest 三件，
      //   而 `writers.partitions[].scope_paths` 只覆盖了 7 个代码文件 —— 守门的两道判据
      //   （分区 owner + change_scope）要求**同时命中**，于是 `owningSeat()` 返回 null ⇒
      //   **任何编写席位都写不进去**；计划位步骤 11 又要求"文档由界面层席位落盘" ——
      //   计划自相矛盾，而机制没有任何一处会指出来。更糟：分配已经完成、状态已进「待开发」，
      //   `pipeline_plan` 只能在「计划中」提交 ⇒ 中途无法修复，书面交付物永远落不了地。
      //
      //   判据（与守门**同源**，不另抄路径匹配）：
      //     每条 `change_scope` 必须 ① 落在某个编写分区的 `scope_paths` 路径内；
      //     或 ② 显式写 `owner_role: "<角色>"`（非编写归属，例如文档由 docs 角色落盘）。
      //   不满足 ⇒ **不分配 AI**，并一次性列出所有"没主"的路径 + 现有分区范围。
      // ★ 只在 writers 本身合法时做覆盖校验：非法分区（缺 layers / 重复层 / 缺 scope_paths /
      //   超过 6 席）先交给下面的既有判据去报它们自己的错，避免"新校验抢占旧判据"。
      const writersProbe =
        args.writers === undefined
          ? null
          : buildRoster({
              tier: args.tier,
              reason: String(args.reason ?? '计划自检'),
              judgedBy: 'planner',
              extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
              l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
              writers: args.writers,
              relayPolicy: args.relay_policy,
            })
      if (selfCheck.verdict === 'ok' && planPayload.change_scope.length > 0 && (writersProbe === null || writersProbe.ok === true)) {
        const parts = Array.isArray(args.writers?.partitions)
          ? args.writers.partitions.filter((p) => p !== null && typeof p === 'object')
          : []
        if (parts.length > 0) {
          const anchor = resolveScopeAnchor(String(task.scope_anchor ?? config.changeScopeAnchor ?? ''), { projectRoot: task.project_root })
          const uncovered = []
          const badOwner = []
          for (const e of planPayload.change_scope) {
            const raw = String(e?.path ?? '').trim()
            if (raw.length === 0) {
              uncovered.push({ path: '（空路径）', why: 'path 为空' })
              continue
            }
            const ownerRole = String(e?.owner_role ?? '').trim()
            if (ownerRole.length > 0) {
              const r = ROLES[ownerRole]
              if (r === undefined) badOwner.push({ path: raw, role: ownerRole })
              else if (r.writes !== 'workdir') {
                // ★ 只有 writes: 'workdir' 的角色才真的能写这条路径（writer / tester）。
                //   docs / release / security 之类是 own-dir（只能写自己的报告目录），
                //   owner_role 写成它们 = 换一个"看着有主、实际写不了"的假出口。
                uncovered.push({ path: raw, why: `owner_role=${ownerRole} 的写面是 ${r.writes}（只能写自己的报告目录），覆盖不了这条路径` })
              }
              continue
            }
            let abs = raw
            try {
              abs = resolveScopePath(raw, { anchor, projectRoot: task.project_root })
            } catch {
              abs = raw
            }
            if (owningSeat(parts, abs, anchor, task.project_root) === null) {
              uncovered.push({ path: raw, why: '没有编写分区的 scope_paths 覆盖它，也没有 owner_role' })
            }
          }
          if (badOwner.length > 0) {
            return {
              ...empty,
              summary:
                `拒绝分配：授权面里有 ${badOwner.length} 条写了**未知的 owner_role** —— **不会分配 AI**。\n` +
                badOwner.map((x) => `  · ${x.path} → owner_role=「${x.role}」`).join('\n') +
                `\n合法角色：${Object.keys(ROLES).join(' / ')}` +
                '\n★ `owner_role` 的意思：这条路径的主人**不是编写席位**（例如文档由 docs 角色落盘）——' +
                '它会让守门不再要求"编写分区覆盖"，所以角色名必须是真实存在的那一个。',
            }
          }
          if (uncovered.length > 0) {
            return {
              ...empty,
              summary:
                `拒绝分配：授权面（change_scope）里有 ${uncovered.length} 条路径**没有主人** —— **不会分配 AI**。\n` +
                uncovered.map((x) => `  · ${x.path}：${x.why}`).join('\n') +
                `\n现有编写分区（${parts.length} 个）：\n` +
                parts
                  .map((p) => `  · ${String(p.seat ?? '(未命名席位)')}：${Array.isArray(p.scope_paths) ? p.scope_paths.join('、') : '(空)'}`)
                  .join('\n') +
                '\n★ 为什么在计划这一站就拒：守门要求"分区 owner + change_scope **同时命中**"才能写。' +
                '授权面有、分区没有 ⇒ **任何编写席位都写不进去**，而分配之后再改计划只能走重排，' +
                '书面交付物会永远缺位。\n' +
                '两条出路（选一条）：\n' +
                '  ① 把该路径所在目录加进某个分区的 `scope_paths`（或缩小到具体文件）；\n' +
                '  ② 这条路径确实不该由编写席位写 ⇒ 在 change_scope 条目上写 `owner_role: "<角色>"`' +
                '（例如 `{ id, path, action, why, owner_role: "docs" }`）。',
            }
          }
        }
      }

      // ★★ **B13：计划的角色边界卡必须覆盖清单里每一个执行角色（在计划这一站就判死）**。
      //
      //   改前的现场：`role_boundaries` 覆盖性只在 `store.setRoster` 里核对 ——
      //   那是"分配"那一刻，而分配是同一份计划的后半段 ⇒ 计划**已经落盘**、
      //   任务已经被推到「待开发」，拒了还得靠人再补一轮；更糟的是派活那一刻
      //   才用一句**警告**告诉主对话"计划里没有某某的边界卡（本应覆盖全部执行角色）"。
      //   用户要求：像 `forbidden` 至少 1 条那样**硬性**。
      //
      //   所以这里在**交计划之前**就判：本档位的执行角色（`buildRoster` 算得出来，
      //   与分配用的是同一份数据）逐条对边界卡；缺一条 ⇒ 计划**不提交**、明确点名。
      if (selfCheck.verdict === 'ok') {
        const probe = buildRoster({
          tier: args.tier,
          reason: String(args.reason ?? '计划自检'),
          judgedBy: 'planner',
          extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
          l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
          writers: args.writers,
          relayPolicy: args.relay_policy,
        })
        if (probe.ok === true) {
          const need = probe.roster.execution_roles
          const got = new Set(planPayload.role_boundaries.map((b) => String(b?.role ?? '').trim()).filter((x) => x.length > 0))
          const missing = need.filter((r) => !got.has(r))
          if (missing.length > 0) {
            return {
              ...empty,
              summary:
                `拒绝：计划里的**角色边界卡没覆盖全部执行角色**（缺 ${missing.length} 张）—— 计划**没有提交**。\n` +
                `缺的是：${missing.join('、')}\n` +
                `本档（${args.tier}）的执行角色：${need.join('、')}\n` +
                `你给的卡：${[...got].join('、') || '（无）'}\n` +
                '★ 规矩与 `forbidden`（至少 1 条）同一档：**每个执行角色都要一张卡**，\n' +
                '  在计划里写死"它只干什么、不干什么"，派活时按它派。\n' +
                '★ 为什么卡在这里：等到派活那一刻才提醒，任务**已经**被推到「待开发」了，\n' +
                '  而"谁顺手多干了"恰恰是从"没有边界"开始的。\n' +
                '下一步：给上面点名的角色各补一张 `{ role, only: [...], not: [...] }` 再重交计划。',
            }
          }
        }
      }

      const res = await store.setRoster({
        taskId: task.id,
        tier: args.tier,
        reason: String(args.reason),
        judgedBy: 'planner',
        extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
        l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
        writers: args.writers,
        relayPolicy: args.relay_policy,
        /** ★ B1 的第二半：计划里的四槽声明原样交给名单（不传 = 全落显式默认）。 */
        slots: planPayload.slots,
        acceptance: args.acceptance,
        testPoints: args.test_points,
        boundaries: args.boundaries,
        actorRole: ROLE.PLANNER,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ...empty, summary: res.error }
      indexTask(res.task.id, res.task)

      const r = res.roster
      const analysis = lastAnalysisOf(res.task)
      // ---------------------------------------------------------------------
      // ★ 需求留档：L1+ 的 requirement.md 由**留档 AI** 汇总产生，planner 不直接写它。
      //   planner 把自己这份（任务卡 + 计划 + 角色清单 + 分层）作为**自己那份记录**
      //   交出去（records/planner.md），留档 AI 读它 + 各方记录，汇总成唯一的需求档。
      //   （L0 没有留档 AI，仍由规则引擎在 pipeline_orchestrate 里直接落档。）
      // ---------------------------------------------------------------------
      const mdBody = renderRequirementDoc({
        task: res.task,
        roster: res.roster,
        acceptance: Array.isArray(args.acceptance) ? args.acceptance : (analysis?.payload?.acceptance ?? []),
        testPoints: Array.isArray(args.test_points) ? args.test_points : (analysis?.payload?.test_points ?? []),
        boundaries: Array.isArray(args.boundaries) ? args.boundaries : (analysis?.payload?.boundaries ?? []),
        /** ★ 缺陷 ⑧：只提示（印进需求档），不替谁写 boundaries 条目。 */
        boundaryHint: boundaryHintLine({
          requirement: res.task.requirement,
          boundaries: Array.isArray(args.boundaries) ? args.boundaries : (analysis?.payload?.boundaries ?? []),
        }),
        unclearPoints: analysis?.payload?.unclear_points ?? [],
        planSteps: planPayload.plan_steps,
        reason: r.reason,
      })
      const myTok = tokens.findSeat(res.task.id, ROLE.PLANNER, null)
      const rec = await store.submitRecord({
        taskId: res.task.id,
        role: ROLE.PLANNER,
        seat: null,
        markdown: mdBody,
        sections: ['需求原文', '分档与角色', '验收标准', '测试要点', '边界与不做的事', '计划步骤', '分配理由'],
        source: '计划 AI：计划 + 自检 + 分配（档位 / 角色清单 / 席位分层都由它定）',
        structured: {
          tier: r.tier,
          roles: r.execution_roles,
          sequence: r.sequence.map((s) => s.role),
          layers: r.writers?.layers ?? [],
        },
        token: myTok,
        actorAgentId: actor.agentId,
      })
      if (rec.ok !== true) return { ...empty, summary: rec.error }
      indexTask(res.task.id, res.task)

      // ---------------------------------------------------------------------
      // ★ **派活那一刻记录改动基线**（用户要求：前后版本对比要有基准）
      //
      //   为什么放在这里：这一刻就是"计划定稿、即将派活"的边界 ——
      //   再往后就没有一个干净的时刻了（writer 一旦动手，基线就脏了）。
      //   基线 = 项目根的文件清单 + 每个文件的 sha256（**只存清单与哈希，不复制源码**），
      //   并绑定这次计划的 handoff id（可证明它属于哪一版计划）。
      // ---------------------------------------------------------------------
      let baseline = null
      {
        const bl = await store.takeBaseline({
          taskId: res.task.id,
          by: ROLE.PLANNER,
          planHandoffId: sub.handoff?.handoff_id ?? null,
          note: '派活那一刻的基线（由 pipeline_plan 自动记录）',
        })
        if (bl.ok === true) baseline = bl.baseline
        indexTask(res.task.id, res.task)
      }

      return {
        ok: true,
        allocated: true,
        tier: r.tier,
        ai_count: r.ai_count,
        roles: r.execution_roles.map((x) => roleLabel(x)).join(' / '),
        sequence: r.sequence.map((s) => roleLabel(s.role)).join(' → '),
        deferred_artifacts: deferredArtifacts,
        summary: [
          `计划自检通过（核对了 ${selfCheck.checked.length} 项），角色清单已产出：${r.tier}（${r.tier_zh}）· ${r.ai_count} 个独立对话`,
          `执行角色：${r.execution_roles.map((x) => roleLabel(x)).join(' / ')}`,
          `调用顺序：${r.sequence.map((s) => roleLabel(s.role)).join(' → ')}`,
          `分配理由：${r.reason}`,
          // ★★ P1-7：这次计划把任务推进到了**哪个**下一步 —— DEMO 阶段必须说清楚怎么走。
          ...(res.advanced !== null && res.advanced?.to === DEMO_ST.BUILDING
            ? [
                '',
                '★★ **本档要求先出可操作前端 DEMO**（设计档 `04-demo与制品模型.md` §1；裁定 5）：',
                `  任务已进「${STATE_LABEL[DEMO_ST.BUILDING]}(${DEMO_ST.BUILDING})」—— **用户确认后**才进「待开发」。`,
                '  下一步：① 交付席位 `pipeline_demo_submit` 交本轮内容（writer / architect / diagrammer）；',
                '          ② 主对话 `pipeline_demo { action: "round", round_index, human_request_id }` 定稿一轮；',
                '          ③ 用户答复 → `pipeline_demo { action: "confirm", round_index, human_request_id }`；',
                '          ④ `pipeline_transition { event: "demo_passed" }` ⇒ 才进「待开发」；不满意就 `demo_rework` 再做一轮。',
              ]
            : []),
          // ★ P1-18：豁免了哪些产物（写进摘要 —— 关单闸与状态展示看得到，主对话也该看到）。
          ...(deferredArtifacts.length === 0
            ? []
            : [
                `★ 已声明产物豁免（${deferredArtifacts.length} 项，已落盘到任务卡）：`,
                ...deferredArtifacts.map((d) => `  · ${deferralLine(d)}`),
                '  ★ 关单时这些产物不再要求交付；测试 / 审核 / 安全类产物**不可豁免**（既有闸门照旧）。',
              ]),
          ...(r.writers
            ? [
                `编写席位：${r.writers.count} 个（席位数 = 层数 ${(r.writers.layers ?? []).length}）`,
                ...(r.writers.partitions ?? []).map(
                  (p) =>
                    `  · ${p.seat}｜层 ${p.layer} → ${(p.scope_paths ?? []).join('、')}` +
                    `${p.deliverables?.length ? `（${p.deliverables.join('、')}）` : ''}`,
                ),
                `分层理由：${r.writers.reason}`,
              ]
            : []),
          ...(baseline === null
            ? ['⚠ 改动基线**没能记录**（项目根读不到？）—— 审核阶段的前后版本对比会缺依据。']
            : [
                '',
                `★ **改动基线已记录**：${baseline.baseline_id}（${baseline.file_count} 个文件，${baseline.taken_at}）`,
                `  绑定计划：${baseline.plan_handoff_id ?? '(无)'}　清单指纹：${baseline.digest.slice(0, 16)}…`,
                '  它只存"文件清单 + 哈希"，不复制源码 —— 审核据此做前后版本对比。',
              ]),
          '',
          '★ 需求档（requirement.md）的**唯一写者**是留档 AI —— 计划 AI 不直接写它。',
          `计划 AI 已提交自己那份记录：${rec.record.rel_path}（${rec.record.record_id}）`,
          '  下一步：① 先派 archivist（留档）；② 各角色用 pipeline_record_submit 交自己那份记录；',
          '           ③ archivist 用 pipeline_compile_requirement 汇总成唯一的需求档。',
          '  ★ 需求档没汇总出来之前，除计划 AI 与留档之外的派活会被拒（没有留档就不许开工）。',
          '',
          '★★ **双轨派活**（用户要求）：需求档就绪后，**同时**把任务发给编写与审核 ——',
          '   审核不是等产物到了才被唤起，它在开工前就拿到：这次授权了什么、不许什么、它的边界卡、',
          '   以及改动基线。链路本身不变：编写 → 测试 → 才交审核。',
          `   派法：pipeline_dispatch role=writer（各席位）+ pipeline_dispatch role=reviewer。`,
        ].join('\n'),
      }
    },
  })

  // =========================================================================
  // 2.7 pipeline_scope_amend —— ★ 授权面变更：一条**只动授权面**的窄通道
  // =========================================================================
  //
  // 要解决的问题（真单现场）：用户已经在需求层裁定"允许把某样东西纳入授权面"，
  // 但计划工具只在「计划中」交得进计划（store 的 `checkHandoffAgainstState`：
  // `plan: [ST.PLANNING]`）—— 任务一进「待开发」，就变成
  // **裁定有了、动作做不了**，一个交付单元整轮走不动。
  //
  // ★ 为什么是"另开一个工具"而不是给 `pipeline_plan` 加 amendment 模式：
  //   `pipeline_plan.run()` 是无条件走「交计划 → setRoster → 记基线 → 交记录」的，
  //   要在它里面插一条只在 ready_dev 生效的旁路，就得在那条原本线性、且**写角色清单**
  //   的路上多开一个分支 —— 而角色清单正是这次**碰都不许碰**的东西。
  //   独立工具的参数面里**根本没有** roster / tier / writers / layers / sequence，
  //   于是"只动授权面"是**能力边界**，不是靠自觉。
  //
  // ★ 计划那道"跳步"闸一个字没动：`plan` 交接物仍然只能在「计划中」提交。
  const scopeAmend = tool(deps, {
    name: 'pipeline_scope_amend',
    mutating: true,
    description:
      '【计划 AI 专用】★ **授权面变更（amendment）** —— 只做一件事：追加/撤销计划的 ' +
      '`change_scope`（这次允许改哪些文件）、`forbidden`（这次不许做什么），' +
      '以及**P1-18 残余（本单）追加 `deferred_artifacts`（产物豁免）**。' +
      '★ 为什么需要它：用户已在需求层裁定"允许纳入"，但计划工具只在「计划中」能出计划 —— ' +
      '任务一旦进「待开发」，那条裁定就**做不了**，交付单元卡死。这条窄通道补的就是这一步。' +
      '★ **硬的边界**：只在**「待开发」(ready_dev)** 生效、**只有计划 AI** 能调；' +
      '**席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字都不许动** —— 入参里出现那些字段直接拒' +
      '（要改那些请走 pipeline_plan 重出计划，或 pipeline_roster_request → pipeline_roster_review）。' +
      '★ `deferred_artifacts` **只追加不覆盖**、形状/判据与计划同源：why 必填、accepted_by 只能是 user/supervisor（supervisor 仅 L4+）、' +
      '只能豁免本档可豁免的必需产物、测试/审核/安全类不可豁免、重复 kind 拒。' +
      '★ 计划那道"跳步"闸**没有被放宽**：plan 交接物仍然只能在「计划中」提交。' +
      '每次变更都留痕（task.json 的 amendments[] + audit.jsonl 的 scope:amend），pipeline_status 可见（补登的豁免标 via amendment）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      why: S('string', '★ **为什么非扩它不可**（必填）—— 与计划里的 change_scope[].why 是同一面照妖镜："顺手扩一点"写不出理由'),
      add: S('array', '追加的授权条目 [{ id, path, action: modify|create|delete, why }]（校验器与计划里那份同一个）', { items: { type: 'object', additionalProperties: true } }),
      remove: S('array', '要撤销的授权条目 id（在现有授权面里找不到就拒）', { items: { type: 'string' } }),
      forbidden_add: S('array', '追加的**越界清单**条目（这次又多不许做什么）', { items: { type: 'string' } }),
      forbidden_remove: S('array', '撤销的越界清单条目（原文必须完全一致）', { items: { type: 'string' } }),
      /**
       * ★★ P1-18 残余（本单）：**分配后补产物豁免**。
       * 形状 `[{ kind, why, accepted_by }]`，判据与 `pipeline_plan.deferred_artifacts` **同源**
       * （`lib/tiers/product-matrix.js` 的 `validateDeferredArtifacts`）。
       * **只追加**：已存在的 kind 再给 ⇒ 拒；不覆盖计划里那份理由/批准人。
       */
      deferred_artifacts: S(
        'array',
        '★ P1-18 残余：追加产物豁免 [{ kind, why, accepted_by }] —— **只追加不覆盖**；why 必填、accepted_by=user 或 supervisor（supervisor 仅 L4+）、只能豁免本档可豁免产物（L4+: 架构图/发布计划；L5: 再加文档/性能）；测试/审核/安全类不可豁免；重复 kind 拒',
        { items: { type: 'object', additionalProperties: true } },
      ),
      note: S('string', '备注（可选，会一起留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（变更前后 + 拒绝原文）'),
      amendment_id: S('string', '本次变更的 id（被拒时为空串）'),
      /** ★ 更新后的授权面 / 越界清单 / 产物豁免 —— 调用方不用再去查一次。 */
      change_scope: S('array', '★ **变更后**的授权改动面 [{ id, path, action, why }]', { items: { type: 'object', additionalProperties: true } }),
      forbidden: S('array', '★ **变更后**的越界清单', { items: { type: 'string' } }),
      deferred_artifacts: S('array', '★ **变更后**的产物豁免 [{ kind, why, accepted_by, via?, amendment_id? }]（计划声明的与 amendment 补登的都在；补登的带 via:"amendment"）', { items: { type: 'object', additionalProperties: true } }),
      amendments_total: S('number', '★ 本任务累计变更过几次（含本次）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      const empty = { ok: false, amendment_id: '', change_scope: [], forbidden: [], deferred_artifacts: [], amendments_total: 0 }
      if (actor.ok !== true) return { ...empty, summary: actor.error }

      const res = await store.amendScope({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        why: args.why,
        add: args.add,
        remove: args.remove,
        forbiddenAdd: args.forbidden_add,
        forbiddenRemove: args.forbidden_remove,
        deferredArtifacts: args.deferred_artifacts,
        note: args.note,
        /**
         * ★ 把**原始入参**原样交给 store 做白名单核对（见 `findNonScopeKeys`）。
         *
         *   为什么不在这一层判：这条判据必须与落盘在**同一个函数**里 ——
         *   否则将来多一条入口（或有人直接调 store）就绕过去了。
         *   工具层只负责"把原样参数递下去"。
         */
        raw: args,
      })
      // ⚠️ 被拒时也要刷新同步索引：`amendScope` 有"先在副本上算、全部通过才落盘"
      //    的写法，所以被拒时任务**没有被改**；但守门读的是索引里那份任务对象，
      //    刷新一次是零成本的保险（"失败分支没刷新索引 ⇒ 拦截静默失效"是踩过的坑）。
      if (res.ok !== true) {
        indexTask(String(args.task_id ?? ''), await load(String(args.task_id ?? '')))
        return { ...empty, summary: res.error }
      }
      indexTask(res.task.id, res.task)

      const t = res.task
      return {
        ok: true,
        amendment_id: res.amendment.amendment_id,
        change_scope: Array.isArray(t.change_scope) ? t.change_scope : [],
        forbidden: toStringArray(t.plan_forbidden),
        deferred_artifacts: Array.isArray(t.deferred_artifacts) ? t.deferred_artifacts : [],
        amendments_total: Array.isArray(t.amendments) ? t.amendments.length : 0,
        summary: res.summary,
      }
    },
  })

  return { planTool, scopeAmend }
}
