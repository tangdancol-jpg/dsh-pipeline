/**
 * dsh-pipeline · 任务存储 · 角色清单
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/roster
 */

import { buildHandoffRecord } from '../handoff.js'
import { ST, STATE_LABEL } from '../states.js'
import { ROLE } from '../roles.js'
import { buildRoster, rosterSlotKeys, validateDeferredArtifacts, validateRoster } from '../tiers.js'
// ★ 领域对象集中：任务卡（task_card）的形状在 `lib/model/task.js`。
import { makeTaskCard } from '../model/task.js'
import { toStringArray } from '../util.js'

/**
 * 任务存储 · 角色清单
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function rosterMethods(ctx) {
  const { maxRework, audit, deny, loadTask, persist, lastHandoff } = ctx

  return {
    /**
     * 写入角色清单（**计划分配**的产物：planner 出计划、自检、再写它）。
     *
     * 谁能调用由工具层判（必须持 planner 令牌，或 L0 的规则引擎路径）。
     */
    async setRoster(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      // ★ 本轮新增（计划自检通过才能分配）----------------------------------
      //   这是"自检没通过就不许分配 AI"的**主闸**：planner 走 pipeline_plan 时，
      //   计划交接物先落盘、再写角色清单；自检 verdict=gaps 时那份计划已经把任务
      //   推到「等待需求分析答复」了，这里再拦一道，保证**任何**调用路径都绕不过去。
      //   （状态机那边还有 plan_ready 一道，两道判的是同一件事、同一份数据。）
      if (input.judgedBy === 'planner') {
        const plan = lastHandoff(task, 'plan')
        if (plan === null) {
          return deny(
            'MISSING_PLAN',
            `拒绝分配：计划 AI 必须先产出 plan 交接物（含自检结果），才能写角色清单。\n` +
              '★ 顺序是"出计划 → 自检 → 无缺失才分配"。跳过计划直接分配 = 没有"这活怎么切"的答案。',
          )
        }
        if (plan.payload?.self_check?.verdict !== 'ok') {
          const gaps = Array.isArray(plan.payload?.self_check?.gaps) ? plan.payload.self_check.gaps : []
          return deny(
            'PLAN_SELF_CHECK_NOT_OK',
            `拒绝分配：最近一份计划（${plan.handoff_id}）的自检结果是 **${plan.payload?.self_check?.verdict ?? '(缺失)'}**，不是 ok。\n` +
              '★ 自己都说了有缺失，就不许分配 AI —— 先把缺口问清楚（退回需求分析）。\n' +
              (gaps.length > 0 ? `缺的是：\n${gaps.map((g) => `  · ${g}`).join('\n')}\n` : '') +
              '下一步：plan 交接物里带上 self_check.verdict=gaps 与 gap_question，状态会落到「等待需求分析答复」。',
          )
        }

        // ★ 设计目的：计划的**角色边界卡必须覆盖清单里每一个执行角色**。
        //
        //   判据放在这里（而不是 handoff.js）的原因：只有这一刻两边数据才齐 ——
        //   plan 里写了哪些角色的边界、roster 里到底有哪几个执行角色。
        //   在提交 plan 那一刻还算不出 roster（清单是同一次调用后面才写的）。
        //
        //   用户要求：「任务卡与计划里**为每个角色写死边界**，派活时按这个边界派，
        //   别让谁顺手多干」—— 少一个角色，那个角色派活时就没有边界可依据。
        {
          const built = buildRoster({
            tier: input.tier,
            reason: input.reason,
            judgedBy: input.judgedBy,
            extraRoles: input.extraRoles,
            removeRoles: input.removeRoles,
            l0OrchestratorSeparate: input.l0OrchestratorSeparate === true,
            reworkBudget: maxRework,
            // ★ 与下面那次构造**同一个数据面**（同一份 slots / strictSlots / writers）——
            //   两次构造若输入不同，"判据看的那份名单"与"真正落盘的那份"就会是两个东西。
            slots: input.slots,
            strictSlots: input.slots !== null && typeof input.slots === 'object' && Object.keys(input.slots).length > 0,
            writers: input.writers,
            relayPolicy: input.relayPolicy,
          })
          if (built.ok === true) {
            // ★ B1 的写入前置判据（名单权威层）：**写活角色**必须逐席位声明四槽。
            //   拒在"改 task.roster 之前、持久化之前"⇒ 拒了之后盘上一个字节都不动。
            //   只读角色（main、orchestrator、planner、supervisor、human）不派活 ⇒ 不在此列。
            //
            //   ★★ 2026-10-12 回归修复：这里的"要声明四槽的席位"**不再自己算一遍**。
            //   改前它把**裸角色键 `writer`** 也算进来，而四槽表的构造方
            //   （`buildRosterSlots` → `rosterSlotTargets`）在编写角色有分区时**故意不产生**
            //   那个键（有分区 ⇒ 派活的实体是席位 `writer@writer#1`）。
            //   两边各算一遍 ⇒ 判据每次只点名 `writer`，**任何计划都出不来**、
            //   连插件自带的正例夹具都报"内部错误（这是插件 bug）"。
            //   现在键集合只有一个出处：`rosterSlotKeys`。
            const slotTargets = rosterSlotKeys(built.roster.conversations, built.roster.writers)
            const slotMissing = slotTargets.filter((k) => !Object.hasOwn(built.roster.slots ?? {}, k))
            if (slotMissing.length > 0) {
              return deny(
                'ROSTER_SLOT_MISSING',
                `拒绝分配：名单里 ${slotMissing.length} 个席位没有声明四槽：${slotMissing.join('、')}\n` +
                  `本次要声明四槽的席位：${slotTargets.join('、')}\n` +
                  '★ 四槽 = 权限档（permission）、内置模式（mode）、模型（model）、推理等级（reasoning），\n' +
                  '  **四个平级字段**（不许打包成一个 options 对象）。缺任一槽即拒 ——\n' +
                  '  否则「名单声明什么档、会话实际拿到什么档」就无从判定（B1）。\n' +
                  '★ 未声明权限档 ⇒ 实际生效档是**最小档**（read-only），该席位写文件会被守门拒（B3）。',
              )
            }

            const need = built.roster.execution_roles
            // ★ 复核中途加人时，新卡由那次复核给出（`input.roleBoundaries`），
            //   与计划原有的卡合并后再核对覆盖性。
            const cards = [
              ...(Array.isArray(plan.payload?.role_boundaries) ? plan.payload.role_boundaries : []),
              ...(Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []),
            ]
            const got = [...new Set(cards.map((b) => String(b?.role ?? '').trim()).filter((x) => x.length > 0))]
            const missing = need.filter((r) => !got.includes(r))
            if (missing.length > 0) {
              return deny(
                'ROLE_BOUNDARIES_INCOMPLETE',
                `拒绝分配：计划里的**角色边界卡没覆盖全部执行角色**。\n` +
                  `缺的是：${missing.join('、')}\n` +
                  `本次清单的执行角色：${need.join('、')}\n` +
                  `边界卡里已有的：${got.filter((x) => x.length > 0).join('、') || '（无）'}\n` +
                  '★ 每个角色的"只干什么、不干什么"必须在**计划里**就写死 —— \n' +
                  '  派活时按它派，而不是等谁顺手多干了再追责。\n' +
                  '  下一步：plan 交接物里的 role_boundaries 补齐这几张卡。',
              )
            }
          }
        }
      }

      const built = buildRoster({
        tier: input.tier,
        reason: input.reason,
        judgedBy: input.judgedBy,
        extraRoles: input.extraRoles,
        removeRoles: input.removeRoles,
        l0OrchestratorSeparate: input.l0OrchestratorSeparate === true,
        reworkBudget: maxRework,
        /**
         * ★★ **四槽声明的数据通路**（B1 的第二半：闸门有了，通路也得有）。
         *
         * 改前：两处 `buildRoster(...)` 都**没有**把 `input.slots` 传下去 ⇒ 名单的四槽表
         * 永远只含**默认值**、`input.slots` 无处可落（计划 AI 把四槽写在哪儿都进不来）。
         * 现在：显式声明表原样交给构造方；**声明了就必须声明齐**（`strictSlots`），
         * 因为"只声明一半"看起来像已经安排好了，比不声明更危险。
         */
        slots: input.slots,
        strictSlots: input.slots !== null && typeof input.slots === 'object' && Object.keys(input.slots).length > 0,
        writers: input.writers,
        relayPolicy: input.relayPolicy,
      })
      if (built.ok !== true) return deny('BAD_ROSTER', `角色清单构造失败：${built.error}`)

      const roster = built.roster
      const v = validateRoster(roster)
      if (v.ok !== true) return deny('BAD_ROSTER', `角色清单自检不通过：\n- ${v.errors.join('\n- ')}`)

      /**
       * ★★ P1-18：**计划里的产物豁免（deferred_artifacts）在分配这一站再判一次**。
       *
       * 为什么判据要在这儿再落一遍（与 `pipeline_plan` 里那次同源、同函数）：
       *   `plan` 交接物还有另一条入口 —— `pipeline_handoff { kind: "plan" }`（planner 直交）。
       *   那条路不经过计划工具的参数校验；如果这里不判，"豁免"就能成为一条
       *   **绕过档位矩阵**的旁路（例如直接声明豁免 security_review 再指望关单闸认）。
       * 判据本体在 `lib/tiers/product-matrix.js`（唯一出处），本处只负责"拒在改内存之前"。
       */
      let planDeferredArtifacts = []
      if (input.judgedBy === 'planner') {
        const planForDeferred = lastHandoff(task, 'plan')
        const dv = validateDeferredArtifacts(planForDeferred?.payload?.deferred_artifacts, { tier: input.tier })
        if (dv.ok !== true) {
          return deny(
            'BAD_DEFERRED_ARTIFACTS',
            `拒绝分配：计划里的 \`deferred_artifacts\` 非法（${dv.errors.length} 处）—— 角色清单**没有写入**。\n` +
              dv.errors.map((e, i) => `  ${i + 1}) ${e}`).join('\n') +
              '\n★ 判据与 `pipeline_plan` 同源（lib/tiers/product-matrix.js）：' +
              '测试 / 审核 / 安全类不可豁免、计划不能自己豁免自己、why 必填、kind 必须是本档可豁免的必需产物。',
          )
        }
        planDeferredArtifacts = dv.items
      }

      const previous = task.roster
      task.roster = roster
      // ★ 设计目的：把计划里的**授权改动面**与**角色边界卡**落到任务上。
      //   前者给守门与 dev_to_test 核对用（"改动面必须与授权面相等"），
      //   后者给派活时取用（"派活时按这个边界派"）。
      {
        const plan = lastHandoff(task, 'plan')
        if (plan !== null && input.judgedBy === 'planner') {
          task.change_scope = Array.isArray(plan.payload?.change_scope) ? plan.payload.change_scope : []
          /** ★ 越界清单（这次不许做什么）—— 派活时与授权面一起交给 writer 与 reviewer。 */
          task.plan_forbidden = toStringArray(plan.payload?.forbidden)
          // 边界卡：计划里的 + 本次复核补的（中途加人时后者非空）
          const base = Array.isArray(plan.payload?.role_boundaries) ? plan.payload.role_boundaries : []
          const extra = Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []
          task.role_boundaries = [
            ...base.filter((b) => !extra.some((n) => String(n?.role) === String(b?.role))),
            ...extra,
          ]
          task.plan_handoff_id = plan.handoff_id
          /**
           * ★★ P1-18：**当前生效的产物豁免**落到任务卡（关单闸 / 状态展示读它）。
           *
           * 为什么读**任务卡**而不是每次去翻最后一份 plan 交接物：
           *   交接物是历史；豁免是"这次分配生效的结论"。后续再有人补交 plan
           *   （或直接 handoff）时，任务卡上这一份会随之更新 —— 判据永远只有一处。
           */
          task.deferred_artifacts = planDeferredArtifacts
        } else if (task.change_scope === undefined) {
          // L0（规则引擎自批）没有计划这一站 ⇒ 不存在授权面。
          // 不塞一个"整棵项目根"的假授权：那只会制造"看起来在管、其实没管"的假执法。
          task.change_scope = null
          task.role_boundaries = null
          // ★ L0 也没有"计划声明豁免"这一站：显式给空数组（不塞假豁免）。
          task.deferred_artifacts = []
        }
      }
      // 任务卡的形状集中在 `lib/model/task.js`（本文件只给上下文值）。
      task.task_card = makeTaskCard({ task, roster, input })
      // 产出分配交接物，让"每次判断有理由记录、可追溯"落到盘上。
      // ★ 本轮起这份产物叫「分配结论」，产出者是**计划 AI**（分配权从 orchestrator 移过来）。
      if (input.judgedBy === 'planner') {
        const rec = buildHandoffRecord({
          kind: 'orchestration',
          taskId: task.id,
          fromRole: ROLE.PLANNER,
          toRole: ROLE.MAIN,
          payload: {
            task_id: task.id,
            tier: roster.tier,
            ai_count: roster.ai_count,
            roles: roster.conversations.slice(),
            sequence: roster.sequence.map((s) => s.role),
            reason: roster.reason,
            task_card: task.task_card,
            acceptance: task.task_card.acceptance,
            test_points: task.task_card.test_points,
            boundaries: task.task_card.boundaries,
            layers: roster.writers?.layers ?? [],
          },
        })
        await this.appendHandoff(task, rec)
      }

      // ★ 名单版本位：**内容变了才 +1**（同内容重写不改版本），单调递增、随 roster 一起落盘。
      //   它是留痕里"依据名单版本"的取值处（B6）；同内容重写不改版本，是为了保住
      //   "版本变了 ⇔ 四槽真的变了"这条等价关系。
      const prevDigest = previous === null ? null : (previous.slots_digest ?? null)
      const sameDigest = prevDigest !== null && prevDigest === roster.slots_digest
      const prevVersion = previous === null || !Number.isInteger(previous.slots_version) ? 0 : previous.slots_version
      roster.slots_version = sameDigest ? prevVersion : prevVersion + 1

      const entry = await audit(task.id, input.actorRole ?? ROLE.PLANNER, 'roster:set', {
        tier: roster.tier,
        ai_count: roster.ai_count,
        roles: roster.conversations,
        judged_by: roster.judged_by,
        slots_version: roster.slots_version,
        slots_digest: roster.slots_digest,
        slots: roster.slots,
        changed: previous === null ? 'initial' : `${previous.tier}→${roster.tier}`,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // ★ 角色清单产出 = 计划分配完成 → 顺带把状态推进到「待开发」。
      //
      //   本轮改了两处（都必须改，否则流程走不通）：
      //     ① 触发状态从 `analyzing` 换成 `planning` —— 需求分析不再产出清单，
      //        它在 `analyzing` 交的是**分析结论**，那条边的终点是「待计划」。
      //     ② 事件与角色跟着换：planner 走 `planned`（挂 plan_ready 判据），
      //        规则引擎（L0）仍走 `orchestrated`。
      //   不在这些状态时不动状态（例如执行中改了角色清单，不该把流程推回去）。
      let advanced = null
      const byPlanner = roster.judged_by === 'planner'
      const canAdvance = byPlanner ? task.state === ST.PLANNING : task.state === ST.PENDING
      if (canAdvance) {
        const tr = await this.transition({
          taskId: task.id,
          event: byPlanner ? 'planned' : 'orchestrated',
          actorRole: byPlanner ? ROLE.PLANNER : 'rule-engine',
          actorAgentId: input.actorAgentId,
          note: byPlanner ? '计划自检通过 + 分配完成' : 'L0 规则引擎自批',
        })
        if (tr.ok === true) advanced = { from: tr.from, to: tr.to }
      }

      return {
        ok: true,
        task,
        roster,
        advanced,
        summary:
          `角色清单已写入：${roster.tier}（${roster.tier_zh}），共 ${roster.ai_count} 个独立对话。` +
          (advanced === null ? '' : `\n任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。`),
      }
    },
  }
}
