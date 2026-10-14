/**
 * dsh-pipeline · 任务存储 · 迁移前置条件
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/precondition
 */

import { isAbsolute, resolve } from 'node:path'
import {
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_REJECT_EVENT_STATIONS,
  HUB_STANDBY_SEATS,
  HUB_STATIONS,
  HUB_WAKE_POINTS,
  ST,
  STATE_LABEL,
} from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
import { nowIso, toStringArray } from '../util.js'
import { checkAllSeatsSubmitted } from './shared.js'

/**
 * 任务存储 · 迁移前置条件
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function preconditionMethods(ctx) {
  const {
    maxRework,
    now,
    deny,
    currentArtifactVersion,
    lastHandoff,
    hubOf,
    hubEnabled,
    hubStandbyOf,
    hubRejectRecords,
    hubLatestValidReject,
    hubRejectBudget,
    hubStationTarget,
    hubStationGate,
    stationLabel,
    effectiveReviewOk,
  } = ctx

  return {
    /**
     * 状态迁移的前置条件判据。
     * 单独抽出来是为了让工具层与守门层调用**同一份**判据，不会出现两套规则。
     */
    async checkPrecondition(task, name, input = {}) {
      switch (name) {
        case 'dev_to_test': {
          if (lastHandoff(task, 'dev_to_test') === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「开发中」进入「待测试」，必须先由编写角色产出 dev_to_test 交接物。`)
          }
          // ★ 全部席位到齐才允许推进（取舍见 README「编写分工」一节）
          const gate = checkAllSeatsSubmitted(task)
          if (gate.ok !== true) return gate
          break
        }
        case 'test_to_review': {
          const h = lastHandoff(task, 'test_to_review')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「测试中」进入「待审核」，必须先由测试角色产出 test_to_review 交接物。`)
          }
          const version = currentArtifactVersion(task)
          if (version !== null && h.artifact_version !== version) {
            return deny(
              'VERSION_MISMATCH',
              `测试报告针对的是制品 ${h.artifact_version}，当前有效制品是 ${version}。请让测试重新验证当前版本。`,
            )
          }
          break
        }
        case 'review_verdict_ok': {
          const h = lastHandoff(task, 'review_verdict')
          if (h === null || h.payload?.conclusion !== 'OK') {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要从「审核中」进入「已通过」，必须先由审核角色产出 conclusion=OK 的 review_verdict。`)
          }
          const version = currentArtifactVersion(task)
          if (version !== null && h.artifact_version !== version) {
            return deny('VERSION_MISMATCH', `审核结论针对的是制品 ${h.artifact_version}，当前有效制品是 ${version}。审核的是旧版本，不予通过。`)
          }
          break
        }
        case 'review_ok_exists': {
          const ok = effectiveReviewOk(task)
          if (ok === null) {
            const version = currentArtifactVersion(task)
            return deny(
              'NO_REVIEW_OK',
              `拒绝关单：任务 ${task.id} 不存在有效的审核 OK。\n` +
                `判据：需要一份 review_verdict，conclusion=OK，且 artifact_version 等于当前有效制品版本（${version ?? '尚无制品'}），且在最近一次打回之后。\n` +
                `主对话不能凭"看起来做完了"关单 —— 必须先走完 测试→审核，由审核角色发 OK。`,
            )
          }
          break
        }
        // ★ 本轮新增（澄清前置到人工确认）----------------------------------
        //
        //   `analyzing → ready_plan` 这条边**必须**有一个"用户确认过需求"的事实。
        //   判据落在既有的 `human_request` 生命周期记录上，不另建一套：
        //     ① 必须有一份需求分析结论（requirement_analysis 交接物）；
        //     ② 必须有需求分析发起的 `requirement_ambiguous` / `requirement_confirmation`
        //        人工请求，且它**已经被答复**（status='answered'）。
        //   ★ 为什么不看 blocking / 转告与否：转告只证明"话带到了"，答复才证明"人回了"。
        //     只查前者的闸是纸做的。
        case 'requirement_confirm_gate': {
          /**
           * ★★ T-20261011-56a37e：**枢纽任务不许从这条边直接跳到计划**。
           *
           * 判据：枢纽启用之后，`analyzing → ready_plan`（`requirement_confirmed`）
           * 会**跳过第①道主管确认与唤醒点 A** —— 用户要的顺序是
           * 「需求结论交主管 → 同意后交给架构ai先画架构图」，所以这条近路在枢纽任务上被关掉。
           * ★ 对未启用枢纽的任务**弃权**：既有链的这条边一个字节没变（既有反例全量照旧）。
           *
           * ⚠️ 只在**走这条边**时判（`input.event === 'requirement_confirmed'`）：
           *   第①道（`hub_station_need_agree`）会把本 guard 当作**子判据**再调一次
           *   （它也要用户确认过）—— 那时若再判一次 hub，第①道就永远过不去了。
           *   判据要认"是谁在问"，不能只看任务状态。
           */
          if (hubEnabled(task) && input?.event === 'requirement_confirmed') {
            return deny(
              'HUB_STATION_NEED_AGREE_REQUIRED',
              `拒绝：任务 ${task.id} 已启用**主管枢纽**，不能从「${STATE_LABEL[ST.ANALYZING]}」直接进计划。\n` +
                '★ 用户原话：「需求ai分析将结果提交**主管**→**同意后**交给架构ai**先画架构图**→架构图完成后给主管确认是否满足要求→主管确认后**才**交给计划ai」。\n' +
                '  也就是说这条路上有第①道（主管同意）与第②道（架构图确认）两站，中间是**架构图前置**。\n' +
                '下一步：主管调 pipeline_supervise action=agree_need（它会同时触发**唤醒点 A**，让架构位开工）。',
            )
          }
          const analysis = lastHandoff(task, 'requirement_analysis')
          if (analysis === null) {
            return deny(
              'MISSING_ANALYSIS',
              `任务 ${task.id} 要从「需求分析中」进入「待计划」，必须先有需求分析角色产出的 requirement_analysis 交接物。\n` +
                '★ 判断依据是**那两份书面结论**（任务卡 + 需求不清楚处清单），不是口头说过。' +
                '下一步：pipeline_orchestrate 出分析结论。',
            )
          }
          const confirmKinds = ['requirement_confirmation', 'requirement_ambiguous']
          const confirmed = (task.human_requests ?? []).filter(
            (r) => r.from_role === ROLE.ORCHESTRATOR && confirmKinds.includes(r.reason_kind) && r.status === 'answered',
          )
          if (confirmed.length === 0) {
            const pending = (task.human_requests ?? []).filter(
              (r) => r.from_role === ROLE.ORCHESTRATOR && confirmKinds.includes(r.reason_kind) && r.status !== 'answered',
            )
            return deny(
              'REQUIREMENT_NOT_CONFIRMED',
              `拒绝推进：需求还**没有经过用户人工确认**。\n` +
                `★ 规矩：需求分析第 1 轮分析完之后，必须把「不清楚的地方」提交主对话 → 主对话交**用户**确认 → 确认后才递交计划。\n` +
                (pending.length > 0
                  ? `当前状态：有一份确认请求还没答复（${pending.map((r) => r.request_id).join('、')}）。\n` +
                    '下一步：pipeline_human_relay 转告用户 → 拿到用户答复后 pipeline_human_reply（必须带答复来源与原话）。'
                  : '当前状态：**还没有**任何需求确认请求。\n' +
                    '下一步：让需求分析调 pipeline_human_request { reason_kind: "requirement_confirmation", blocking: true, ... }，' +
                    '把 unclear_points 逐条问出来。\n' +
                    '（"没有不清楚的地方"也是一个结论，同样要用户点头 —— 模型说"我懂了"不等于用户说"你懂了"。）'),
            )
          }
          break
        }

        // ★ 本轮新增（计划自检通过才能分配）--------------------------------
        //
        //   `planning → ready_dev` 必须有**最近一份计划且自检通过**。
        //   与 setRoster 里那道闸是**同一份判据**（那里判一次是为了给早期拒绝的文案，
        //   这里判一次是为了状态机层面也拦得住）。
        case 'plan_ready': {
          const plan = lastHandoff(task, 'plan')
          if (plan === null) {
            return deny(
              'MISSING_PLAN',
              `任务 ${task.id} 要从「计划中」进入「待开发」，必须先有计划 AI 产出的 plan 交接物（含自检结果）。\n` +
                '★ 没有计划就没有"这活怎么切、给谁"的答案，角色清单也就无从谈起。',
            )
          }
          const verdict = plan.payload?.self_check?.verdict
          if (verdict !== 'ok') {
            return deny(
              'PLAN_SELF_CHECK_NOT_OK',
              `拒绝推进：最近一份计划（${plan.handoff_id}）的自检结果是 **${verdict ?? '(缺失)'}**，不是 ok。\n` +
                '★ 自检发现缺失时**不许分配 AI** —— 先把缺口问清楚（退回需求分析：pipeline_clarify_request）。\n' +
                (Array.isArray(plan.payload?.self_check?.gaps) && plan.payload.self_check.gaps.length > 0
                  ? `缺的是：\n${plan.payload.self_check.gaps.map((g) => `  · ${g}`).join('\n')}`
                  : ''),
            )
          }
          break
        }

        // ★ 本轮新增（计划缺失回流）----------------------------------------
        //
        //   `planning → awaiting_clarification` 的判据：最近一份计划自检 verdict=gaps
        //   且带着可问的问题。它与第一级澄清梯**共用同一批记录**：
        //   submitHandoff 在收到 gaps 的计划时已经建好 clarification 记录（见下面 ④b3），
        //   所以需求分析照旧用 pipeline_clarify_reply 裁定、答不了照旧升级给用户。
        case 'plan_gap_gate': {
          const plan = lastHandoff(task, 'plan')
          if (plan === null) {
            return deny('MISSING_PLAN', `任务 ${task.id} 要回流到需求分析，必须先有 plan 交接物（自检结果在里面）。`)
          }
          const sc = plan.payload?.self_check
          if (sc?.verdict !== 'gaps') {
            return deny(
              'NOT_A_PLAN_GAP',
              `最近一份计划（${plan.handoff_id}）的自检结果是 ${sc?.verdict ?? '(缺失)'}，不是 gaps —— 没有缺口就不该回流。`,
            )
          }
          const gaps = Array.isArray(sc.gaps) ? sc.gaps : []
          if (gaps.length === 0) {
            return deny('EMPTY_PLAN_GAPS', '计划自检说"有缺失"却没列出缺什么 —— 回流必须带上具体缺口，否则需求分析无从下手。')
          }
          const entry = (task.clarification_requests ?? []).find((r) => r.handoff_id === plan.handoff_id || r.from_role === ROLE.PLANNER)
          if (entry === undefined) {
            return deny(
              'NO_CLARIFICATION_FOR_GAP',
              `计划缺失没有对应的澄清请求记录 —— 回流链是断的（插件内部错误：submitHandoff 本应建好它）。`,
            )
          }
          break
        }

        // ★★ 主管枢纽（T-20261011-56a37e）-------------------------------------
        //
        //   这七条装在 **同一张 TRANSITIONS 表** 与 **同一个守卫开关** 上 ——
        //   没有第二套判定机制（越界清单第 4 条 / 边界条件第 2 条）。
        //
        //   ① 发起：主管的具名动作。`by: ['supervisor']` 是**第一道**（applyTransition
        //      就把它拒了，main 代发连这里都到不了）；本处是**第二道**：
        //      写枢纽账本 + 登记两席待机 + 真实 actor 留痕。
        //      ★ 刻意**不**复用 `pipeline_dispatch`（main 的工具）：那会把发起者记成 main
        //        （"谁发起"不可追溯），并且主管会连带拿到 main 的整片派活权 —— 越权放行。
        case 'hub_initiate': {
          /**
           * ★★ P0-1：**"已经发起过"的判据从 `enabled` 收窄到 `initiated_by`**。
           *
           * 为什么必须改：新入口（`handoff_to_supervisor`）会先把本单**递给**主管
           *   （登记 `hub.entry`），此时枢纽**还没发起** —— 真正拉起三席的是主管的
           *   `action=initiate`。若仍按"`enabled` 已为真 ⇒ 拒"，主管就再也发起不了，
           *   `hub.entry` 会把主管自己挡在门外 —— 那正是本单要修的"入口悬空"的翻版。
           *
           * ★ 判据强度**没有降**：`initiated_by` 有值 = 主管**真的发起过**（那一步
           *   既有唯一写点 `applyHubSideEffects('supervisor_initiate')` 落下），
           *   重复发起照旧被拒（"发起是一次性动作"这条一个字没动）。
           */
          if (hubEnabled(task) && typeof hubOf(task)?.initiated_by === 'string' && hubOf(task).initiated_by.length > 0) {
            return deny(
              'HUB_ALREADY_INITIATED',
              `拒绝：任务 ${task.id} 的**主管枢纽已经发起过了**（${hubOf(task)?.initiated_at ?? ''}，发起人 ${hubOf(task)?.initiated_by ?? ''}）。\n` +
                '★ 发起是**一次性**动作：重复发起会覆盖待机名册，把"谁在什么时刻被登记待机"这条留痕抹掉。',
            )
          }
          const roster = Array.isArray(task.roster?.conversations) ? task.roster.conversations : []
          const declared = roster.includes(ROLE.SUPERVISOR)
          return {
            ok: true,
            // ★ 只在**名单四槽面**真的登记了 supervisor 时才算"在册"；没登记也允许发起
            //   （否则用例夹具没法自举），但如实记进账本，供审核与边界导出读。
            hub: {
              supervisor_declared: declared,
              note: declared
                ? '名单里登记了 supervisor 席位。'
                : '名单里**没有** supervisor 席位（本任务是自举/夹具形态）：发起仍留痕，但"主管在册"这条不成立。',
            },
          }
        }

        //   ①a ★★ P0-1 **入口判据**：主对话把任务递给主管（用户新口径第 1 跳）。
        //
        //   为什么单开一条边、而不是把 main 加进 `supervisor_initiate` 的 by 名单：
        //     既有判据逐字写着「**主管的具名动作不是 main 的工具**」
        //     （`gate-states-check` 的「A 发起面」把它钉住了）—— 给那条边加 main
        //     会**改掉既有判据的期望值**，那是本单硬约束禁止的动作。
        //     所以主对话走**自己**的边界事件：它只登记"谁把单递给了主管"，不代替主管发起。
        //
        //   ★ **凭什么放行**（五条同时成立，缺一即拒）—— 回答"主对话发起时依据什么"：
        //     ① 调用方必须是 **main**（`by: ['main']` 是状态机那一道；工具面 `pipeline_transition`
        //        本来就只给 main / human，human 在这里被这条 by 名单挡住）；
        //     ② 状态必须是 **`pending`（待分配）** —— 也就是**流程最初那一刻**；
        //     ③ 名单**还没产出**（`roster === null`）—— 有清单就说明需求分析与用户确认都过了，
        //        那已经不是"最初那一刻"；
        //     ④ **一份交接物都还没有**（`handoffs.length === 0`）—— 活儿还没开始；
        //     ⑤ 本单**还没递过**（`hub.entry` 不存在）—— 递单是一次性动作。
        //   ★ **枢纽必须激活在哪一层**：激活点在**最外层** —— 只能落在
        //     `pending` 这一层（②③④合起来保证"零工作量的新单"）。
        //     任何状态推进、任何交接物、任何角色清单都会**永久关闭**这个入口；
        //     换句话：**中途的单递不出去**（反例见 `tests/p01-handoff-entry-check.mjs`）。
        //   ★ **没有顺带放宽任何别的角色**：本事件只写 `hub.entry`，不改状态、不发令牌、
        //     不放开任何角色的可派范围 —— 派活那一段的引导步白名单另有一处改动，
        //     且那处**只**多出 supervisor 一席（其余角色一个都没动）。
        case 'main_handoff_to_supervisor': {
          const st = task.state
          if (st !== ST.PENDING) {
            return deny(
              'HUB_HANDOFF_NOT_FIRST_MOMENT',
              `拒绝：任务 ${task.id} 已经是「${STATE_LABEL[st] ?? st}」，**不是流程最初那一刻** —— 递单入口只对「${STATE_LABEL[ST.PENDING]}(${ST.PENDING})」上的新单开放。\n` +
                '★ 判据不是"看着像新单"，而是三条硬事实：状态仍是待分配、尚无角色清单、尚无任何交接物。\n' +
                '下一步：中途的单请走既有的转办路径（主管枢纽已经发起的话，主管直接调 pipeline_supervise 推进）。',
            )
          }
          if (task.roster !== null && task.roster !== undefined) {
            return deny(
              'HUB_HANDOFF_AFTER_ROSTER',
              `拒绝：任务 ${task.id} **已经有角色清单**了 —— 那说明需求分析与用户确认都走完了，不再是"最初那一刻"。\n` +
                '★ 递单是把**还没开工的新单**交给主管，不是把已经在跑的单改道。',
            )
          }
          const hs = Array.isArray(task.handoffs) ? task.handoffs : []
          if (hs.length > 0) {
            return deny(
              'HUB_HANDOFF_AFTER_WORK',
              `拒绝：任务 ${task.id} 已经有 ${hs.length} 份交接物了 —— 活儿已经开过工，递单入口只对新单开放。\n` +
                '★ 允许中途递单会让"谁发起"变得可追溯不了：已经产出过的产物归属不到任何一个发起人。',
            )
          }
          if (hubOf(task)?.entry !== null && hubOf(task)?.entry !== undefined) {
            return deny(
              'HUB_HANDOFF_ALREADY_DONE',
              `拒绝：任务 ${task.id} **已经递给主管过了**（${hubOf(task)?.entry?.at ?? ''}，递交人 ${hubOf(task)?.entry?.by ?? ''}）。\n` +
                '★ 递单是**一次性**动作：重复递交会覆盖"谁在什么时刻把单交给主管"这条留痕。\n' +
                '下一步：让主管调 pipeline_supervise action=initiate 拉起三席。',
            )
          }
          return { ok: true, handoff_to_supervisor: { by: input?.actorRole ?? '', at: nowIso(now()) } }
        }

        //   ①b **名单里登记了主管席位 ⇒ 必须由主管发起**（不许 main 代发绕过枢纽）。
        //
        //   判据用的是**名单四槽面**（`task.roster.conversations`）—— 那是 B 单已落地的
        //   "谁在册"的唯一事实来源，不新造标记。名单里没有 supervisor 时弃权
        //   （L0~L5 的既有档位都不含它 ⇒ 既有链与既有反例一个字节不变）。
        case 'hub_initiate_required': {
          const roster = Array.isArray(task.roster?.conversations) ? task.roster.conversations : []
          /**
           * ★★ P0-1：**两个"必须由主管发起"的触发面**（同一个判据体，不另起一套）：
           *   · 名单四槽面里登记了 supervisor 席位（既有那条，一个字节没动）；
           *   · **主对话已经把本单递给主管**（`hub.entry`）—— 递了单就更不该由主对话自己
           *     把需求位派出去：那会让"递单"这个动作变成一句空话。
           * ★ 未登记、也没递过单 ⇒ 照旧弃权（L0~L5 的既有档位都不含主管席位，
           *   既有链与既有反例一个字节不变）。
           */
          const rosterHasSup = roster.includes(ROLE.SUPERVISOR)
          const handedOver = hubOf(task)?.entry !== null && hubOf(task)?.entry !== undefined
          if (!rosterHasSup && !handedOver) return { ok: true }
          if (hubEnabled(task)) return { ok: true }
          return deny(
            'HUB_INITIATE_REQUIRED',
            `拒绝：任务 ${task.id} ${rosterHasSup ? '的名单里**登记了主管席位**' : '**已经由主对话递给主管**'}，所以需求位必须由**主管发起**。\n` +
              `当前动作：main 的 dispatch_orchestrator（起点 ${ST.PENDING}）\n` +
              '★ 用户原话：「**主对话agent递给主管agent**，主管**发起**（需求分析/计划/架构ai）对话」——\n' +
              '  主对话负责**递单**与转发，发起是主管的活。\n' +
              '  这条不是"少一步也能走"：主对话代发会让`谁发起`不可追溯，' +
              '并且新拓扑的两席待机（计划位 / 架构位）根本不会被登记 —— 架构图前置就无从谈起。\n' +
              (handedOver
                ? '下一步：先把主管席位派出去（pipeline_dispatch role=supervisor，递单之后引导步已只放它这一席），再由主管调 pipeline_supervise action=initiate。'
                : '下一步：主管调 pipeline_supervise action=initiate。'),
          )
        }

        //   ①c ★★ P0-1 **②b 确认点**：架构图 → **需求位确认**（用户新口径第 7~8 跳前半）。
        //
        //   与既有站点闸是**同一个判据体**（`hubStationGate`）—— 只是站点名换了。
        //   它判的是：需求位交过一份 `station_confirm{station:'arch_need_confirm', decision:'ok'}`，
        //   且那份记录**绑的是当前这份架构图**（换图即作废）。缺 ⇒ 边过不去。
        case 'hub_station_arch_need_confirm': {
          const gate = hubStationGate(task, HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, confirms: gate.confirms, target: gate.target }
        }

        //   ①d ★★ P0-1 **②c 确认点**：架构图 → **主管二次确认**（用户新口径第 8 跳后半）。
        //
        //   ★ 顺序是判据的一部分：本站**只能**由状态机从 ②b 之后的 `arch_reconfirm` 进来
        //     （`from` 写死在表上），所以"需求位还没确认，主管就先二次确认"没有合法路径。
        //   ★ 唤醒点 B 挂在这一跳上：**无问题后**才把架构图交给计划位。
        case 'hub_station_arch_reconfirm': {
          const gate = hubStationGate(task, HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, confirms: gate.confirms, target: gate.target }
        }

        //   ② 需求结论交主管：必须已经有结论（否则"交"的是空）。
        //
        //   ★ 这里**刻意不查** `requirement_confirm_gate`（用户确认）：用户确认发生在
        //     结论交上来**之后**（需求分析发起 requirement_confirmation → 主对话转告 →
        //     用户答复）。把它挪到这里会变成"先让用户确认一份还没交上来的结论"。
        //     用户的确认判据落在**下一站**（第①道）：见 `hub_station_need_agree`。
        case 'hub_analysis_ready': {
          if (!hubEnabled(task)) {
            return deny(
              'HUB_NOT_ENABLED',
              `拒绝：任务 ${task.id} 没有启用主管枢纽，\`need_to_supervisor\` 不属于它当前走的链` +
                '（既有链是 analyzing → requirement_confirmed → ready_plan）。',
            )
          }
          const analysis = lastHandoff(task, 'requirement_analysis')
          if (analysis === null) {
            return deny(
              'MISSING_ANALYSIS',
              `拒绝：任务 ${task.id} 要把结论交主管，但**还没有** requirement_analysis 交接物。\n` +
                '★ 第①道确认要确认的是**那份书面结论**（任务卡 + 需求不清楚处清单），不是口头说过。\n' +
                '下一步：pipeline_orchestrate 出分析结论。',
            )
          }
          return { ok: true }
        }

        //   ③ 第①道：主管同意需求结论（＋**唤醒点 A**）。
        //
        //   ★ 两道**都要**：①主管的站点确认记录；②**既有的用户确认闸门**。
        //     用户原话里这一站是"需求ai分析将结果提交主管→同意后交给架构ai"，
        //     而既有链里"用户确认过需求"这条不变量一个字没动 —— 枢纽是**加**一道，不是替一道。
        case 'hub_station_need_agree': {
          const userGate = await this.checkPrecondition(task, 'requirement_confirm_gate', input)
          if (userGate.ok !== true) return userGate
          const gate = hubStationGate(task, HUB_STATIONS.NEED_AGREE)
          if (gate.ok !== true) return gate
          return { ok: true, wake: { wake_point: HUB_WAKE_POINTS.NEED_AGREE, roles: HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.NEED_AGREE).map((s) => s.role) } }
        }

        //   ④ 架构图产出：必须是当前枢纽任务的**计划位开工之前**那一站。
        case 'hub_diagram_ready': {
          const diagram = lastHandoff(task, 'architecture_diagram')
          if (diagram === null) {
            return deny('MISSING_HANDOFF', `拒绝：任务 ${task.id} 要落到「架构图待主管确认」，但还没有 architecture_diagram 交接物。`)
          }
          if (diagram.payload?.degraded === true && typeof diagram.payload?.degraded_reason !== 'string') {
            return deny('BAD_HANDOFF', `架构图（${diagram.handoff_id}）声明 degraded=true 却没给 degraded_reason —— 降级必须写明原因。`)
          }
          return { ok: true }
        }

        //   ⑤ 第②道：主管确认架构图满足要求（＋**唤醒点 B**）。
        case 'hub_station_diagram_confirm': {
          const gate = hubStationGate(task, HUB_STATIONS.DIAGRAM_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true, wake: { wake_point: HUB_WAKE_POINTS.DIAGRAM_CONFIRM, roles: HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.DIAGRAM_CONFIRM).map((s) => s.role) } }
        }

        //   ⑥ 架构图不满足 ⇒ 重画（**限 1 次**；再不行升人工）。
        case 'hub_diagram_rework_budget': {
          const used = Number.isInteger(task.hub?.diagram_redraws) ? task.hub.diagram_redraws : 0
          if (used >= HUB_DIAGRAM_REDRAW_BUDGET) {
            return deny(
              'HUB_DIAGRAM_REDRAW_EXHAUSTED',
              `拒绝：架构图重画**预算已用尽**（已用 ${used} / 上限 ${HUB_DIAGRAM_REDRAW_BUDGET}）。\n` +
                '★ 用户口径④：「主管认为架构图不满足要求 ⇒ 让架构位重画（**限 1 次**）；再不行**升给用户**定」。\n' +
                '  无限重画会把"主管确认"退化成一道空转的闸。\n' +
                '下一步（唯一）：主管调 pipeline_supervise action=escalate_user 走**既有的**两级梯\n' +
                '  （human_request → 主对话转告 → 用户答复），把这件事交给人定。',
            )
          }
          const diagram = lastHandoff(task, 'architecture_diagram')
          if (diagram === null) {
            return deny('MISSING_HANDOFF', '拒绝：还没有架构图可判"不满足" —— 先让架构位出图。')
          }
          return { ok: true, redraws: used + 1 }
        }

        //   ⑥b ★★ **站点「否掉」的预算判据**（T-20261011-56a37e 补齐）。
        //
        //   与 ② 道那条（`hub_diagram_rework_budget`）是**同一套口径、同一个位置**：
        //   同样是"退回重做限 1 次、用尽升人工"。两种触发面共用一个判据体：
        //     · 主管交**否掉记录**时（`station_confirm{decision:'ng'}`）—— `input.station`；
        //     · 状态机上那条回边放行时 —— `input.event`（事件名反查站点）。
        //   这样"提交"与"推进"两步判的是**同一件事**，不会出现"记录交得上、边却过不去"
        //   或者反过来的半截状态（与既有站点确认"先交记录、再放行"的形状一致）。
        case 'hub_station_reject_budget': {
          const station =
            HUB_REJECT_EVENT_STATIONS[String(input?.event ?? '')] ??
            (typeof input?.station === 'string' && input.station.length > 0 ? input.station : '')
          const r = hubRejectBudget(task, station)
          if (r.ok !== true) return r
          return { ok: true, station: r.station, used: r.used }
        }

        //   ⑥c ★★ **站点「否掉」的前置条件**（状态机那条回边挂的守卫）。
        //
        //   与 `hubStationGate`（确认侧）**逐项对称**，只是方向相反：
        //     · 确认侧要求"确认方**齐备**的 `station_confirm{ok}` 记录"⇒ 才放行到下一站；
        //     · 否掉侧要求"一份**绑当前目标**的 `station_confirm{ng}` 记录"⇒ 才放行退回上一站。
        //   ★ 为什么否掉也要求先有记录（而不是像 ② 道那样只看一个计数）：
        //     本条的硬要求是「否掉**必须带原因**：失败要带证据、不许静默」。
        //     把这条落在**既有校验器**上（`station_confirm` 的 `reason` 与 `basis_refs`
        //     都是 required、`basis_digest` 还要过"脱敏证据正文"扫描）比在守卫里
        //     判一句 `note` 是否为空要硬得多 —— 后者拦不住一次不带原因的 `pipeline_transition`。
        case 'hub_station_reject': {
          const budget = await this.checkPrecondition(task, 'hub_station_reject_budget', input)
          if (budget.ok !== true) return budget
          const station = budget.station
          const rec = hubLatestValidReject(task, station, ROLE.SUPERVISOR)
          if (rec === null) {
            const anyRec = hubLatestValidReject(task, station)
            if (anyRec !== null) {
              return deny(
                'HUB_STATION_REJECT_NOT_SUPERVISOR',
                `拒绝：这一站当前那条否掉记录是「${roleLabel(anyRec.from_role)}」交的（${anyRec.handoff_id}），而**回边只能由主管走**。\n` +
                  `★ 第${stationLabel(station)}上，需求位的那一份是**确认**（\`decision=ok\`）或**不同意**（\`decision=ng\`）的书面表态；\n` +
                  '  把它直接变成"退回重做"会让**需求位**拿到一条推进/退回状态的能力 —— 那是越权放行，本条明令禁止。\n' +
                  '  需求位说"不同意"时，正确形状是：它的 ng 记录让**双确认不齐备**（闸门保持关闭），' +
                  '由**主管**决定要不要走退回。\n' +
                  '下一步：主管调 pipeline_supervise action=' +
                  (station === HUB_STATIONS.NEED_AGREE ? 'reject_need' : station === HUB_STATIONS.TEST_CONFIRM ? 'reject_test' : 'reject_review') +
                  '（主管那一份否掉记录由它自己交）。',
              )
            }
            const target = hubStationTarget(task, station)
            return deny(
              'HUB_STATION_REJECT_NO_RECORD',
              `拒绝：第${stationLabel(station)}要**否掉**，必须先有一份**带原因与证据**的否掉记录，` +
                `而现在没有（或它绑的不是当前目标）。\n` +
                `该站当前的目标：${target ?? '(还没有可确认的对象)'}\n` +
                `已有的否掉记录：${hubRejectRecords(task, station).length} 条` +
                `${hubRejectRecords(task, station).length > 0 ? '（但都不绑当前目标 —— 否掉也要说清"否的是哪一份"）' : ''}\n` +
                '★ 用户裁定：「失败要带证据、不许静默」—— 所以否掉不是一个动作，是**一份记录 + 一条回边**。\n' +
                '  记录的形状复用**既有**的站点确认交接物（`station_confirm`，`decision=ng`）：\n' +
                '  它的 `reason` 与 `basis_refs`（证据标识 ≥ 1 条）都是**既有校验器**强制要求的。\n' +
                '下一步：主管调 pipeline_supervise action=' +
                (station === HUB_STATIONS.NEED_AGREE ? 'reject_need' : station === HUB_STATIONS.TEST_CONFIRM ? 'reject_test' : 'reject_review') +
                `（它先落否掉记录、再走回边；用 pipeline_handoff kind=station_confirm 手交也可以）。`,
            )
          }
          return { ok: true, station, reject_handoff: rec.handoff_id, used: budget.used }
        }

        //   ⑦ 计划位派活（唤醒点 B 之后的**唯一**入口）。
        case 'hub_plan_woken': {
          if (!hubEnabled(task)) {
            // 未启用枢纽的任务走既有 `ready_plan → dispatch_planner`（那条边一个字没动）。
            return { ok: true }
          }
          const e = hubStandbyOf(task, ROLE.PLANNER)
          if (e === null || e.status !== 'woken') {
            return deny(
              'HUB_PLAN_NOT_WOKEN',
              `拒绝：任务 ${task.id} 的计划位**还没被唤醒**，这条边过不去。\n` +
                `计划位的登记：${e === null ? '（没登记）' : `${e.status}（唤醒点 ${e.wake_point}）`}\n` +
                '★ 用户原话：「计划……ai**待机**……主管确认后交给计划ai」。\n' +
                '  计划位的唤醒点是**「主管确认架构图满足要求」** —— 在它之前，计划位产不出任何计划产物。\n' +
                '下一步：主管在架构图确认后调 pipeline_supervise action=confirm_diagram（那一步会一并唤醒计划位）。',
            )
          }
          return { ok: true }
        }

        //   ⑧ 第③道：测试通过 → 主管+需求位**双确认** ⇒ 才进审核。
        //      对未启用枢纽的任务**弃权**（既有链的 `dispatch_reviewer` 强度一个字节没减）。
        case 'dispatch_reviewer_gate': {
          if (!hubEnabled(task)) return { ok: true }
          const gate = hubStationGate(task, HUB_STATIONS.TEST_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true }
        }

        //   ⑨ 第④道：审核通过 → 主管+需求位**双确认** ⇒ 才进主对话关单。
        case 'hub_station_review_confirm': {
          if (!hubEnabled(task)) return { ok: true }
          const gate = hubStationGate(task, HUB_STATIONS.REVIEW_CONFIRM)
          if (gate.ok !== true) return gate
          return { ok: true }
        }

        // ★ 两级升级梯的两个前置条件
        case 'clarification_blocking': {
          const h = lastHandoff(task, 'clarification_request')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要进入「等待需求分析答复」，必须先有一份 clarification_request 交接物。`)
          }
          if (h.payload?.blocking !== true) {
            return deny('NOT_BLOCKING', `最近一份 clarification_request（${h.handoff_id}）声明的是 blocking=false，不该把任务推进到「等待需求分析答复」。`)
          }
          break
        }
        case 'clarification_reply_ok': {
          const e = this.findClarification(task, input.requestId)
          if (e === null) {
            return deny('NO_CLARIFICATION', `任务 ${task.id} 里没有任何待答复的 clarification_request —— 不能凭空从「等待需求分析答复」恢复。`)
          }
          if (e.status !== 'answered') {
            return deny(
              'MISSING_CLARIFICATION_REPLY',
              `请求 ${e.request_id} 还没有需求分析的裁定（status=${e.status}）。\n` +
                '★ 需求分析必须先给出裁定（answered 带结论 / cannot_answer 带升级理由），状态才会恢复。',
            )
          }
          break
        }

        // ★ 关单的**组合闸**：审核 OK（必过） + 安全确认（必过） + 架构图（清单里有 diagrammer 时）。
        //   做成组合而不是几条并列 guard，是因为转移表里一个事件只能挂一个 guard；
        //   这里把判据按顺序跑一遍，返回第一条不通过的。
        case 'close_gates': {
          // 顺序是有讲究的：**安全否决排在最前** —— 它优先于审核 OK，那也该最先判。
          // （否则一份"审核说没问题"的结论会先撞上别的闸，反而看不到真正的原因。）
          for (const g of ['review_ok_exists', 'security_not_blocked', 'security_attested', 'diagram_delivered', 'role_products_delivered',
            // ★ T-20261011-56a37e：第④道（审核通过 → 主管+需求位**双确认**）。
            //   排在最后是刻意的：先让既有的四道闸把话说清楚，再报"还缺谁的确认" ——
            //   否则一份还没审完的单会先撞上"确认不齐"，看到的理由就错了。
            //   对未启用枢纽的任务它是**弃权**的（既有链强度一个字节没减）。
            'hub_station_review_confirm']) {
            const r = await this.checkPrecondition(task, g, input)
            if (r.ok !== true) return r
          }
          break
        }

        // ★「审核必须确认网络安全/本地泄密是否发生」—— 判据落在**有效审核结论**的 security 段上。
        //
        //   为什么挂在关单而不是挂在 handoff 提交：handoff 层的字段校验只管"形状对不对"，
        //   这里管的是"**当前有效**的那份结论里有没有确认过"。两处都要，因为
        //   旧版本的 review_verdict（改造前提交的、没有 security 段）也可能成为有效结论 ——
        //   那种情况在提交层拦不住（它早就落盘了），必须在关单层拦。
        case 'security_attested': {
          const ok = effectiveReviewOk(task)
          if (ok === null) break // 没有有效 OK 的话，review_ok_exists 已经拒过了
          const sec = ok.payload?.security
          if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) {
            return deny(
              'NO_SECURITY_ATTESTATION',
              `拒绝关单：当前有效的审核结论（${ok.handoff_id}）里**没有安全确认段**。\n` +
                '★ 规则：审核**必须**确认"网络安全 / 本地泄密是否发生" —— 没确认就不算完成审核。\n' +
                '下一步：调 pipeline_security_check 扫一遍本任务工作区，把结论与 checks_ref 填进 review_verdict.security。',
            )
          }
          const att = sec.attestation
          if (att === 'unknown') {
            return deny(
              'SECURITY_ATTESTATION_UNKNOWN',
              `拒绝关单：安全确认的结论是 **unknown**（不知道发生过没有）。\n` +
                '★ "没查"和"查了没问题"是两件完全不同的事，不能都算过。\n' +
                '两条出路：① 查清它（pipeline_security_check + 人工看一眼），给出 clean / issues；' +
                '② 确实查不了（缺环境、缺权限）→ pipeline_rework 打回，或 pipeline_human_request 升级给用户。',
            )
          }
          if (att !== 'clean' && att !== 'issues') {
            return deny('BAD_SECURITY_ATTESTATION', `拒绝关单：security.attestation=「${att ?? '(缺失)'}」非法，必须是 clean / issues。`)
          }

          // ★ 依据必须**真实存在**。
          //   "我扫过了，报告在 reports/security-scan-xxx.json" —— 那就得有那个文件。
          //   只写路径不落盘，等于没有依据；这条把"依据"从一句声明变成一个可核对的事实。
          {
            const { existsSync } = await import('node:fs')
            const refs = [
              ...toStringArray(sec.checks_ref),
              ...toStringArray(sec.local_leak?.checks_ref),
              ...toStringArray(sec.network?.checks_ref),
            ]
              .map((r) => String(r).split('#')[0].trim())
              .filter((r) => r.length > 0 && /[./\\]/.test(r))
            const found = refs.filter((r) => existsSync(isAbsolute(r) ? r : resolve(task.project_root, r)))
            if (refs.length > 0 && found.length === 0) {
              return deny(
                'SECURITY_CHECKS_REF_MISSING',
                '拒绝关单：安全确认里给的 checks_ref 指向的检查产物**一个都不存在**。\n' +
                  refs.slice(0, 5).map((r) => `  · ${r}`).join('\n') +
                  '\n★ "我扫过了"必须留下可核对的东西：调 pipeline_security_check 会把扫描结果落盘到本任务的 reports/，' +
                  '把它返回的 checks_ref 原样填进来即可。\n' +
                  '（只写路径不落盘，等于没有依据。）',
              )
            }
          }
          // 未解决的 finding 一律不许关单
          const open = (Array.isArray(sec.findings) ? sec.findings : []).filter((f) => f?.resolved !== true)
          if (open.length > 0) {
            const lines = open.slice(0, 5).map((f, i) => `  ${i + 1}) ${f.location ?? '(无位置)'} — ${f.type ?? '(无类型)'}：${f.why ?? '(无说明)'}`)
            return deny(
              'SECURITY_FINDINGS_OPEN',
              `拒绝关单：安全确认里有 ${open.length} 条**未解决**的问题。\n` +
                lines.join('\n') +
                (open.length > 5 ? `\n  …还有 ${open.length - 5} 条` : '') +
                '\n★ 处理路径三选一：\n' +
                '  ① pipeline_rework 打回编写（改掉它）；\n' +
                '  ② 让 security 角色复核并给出可接受的整改结论（L3+）；\n' +
                '  ③ pipeline_human_request 升级给用户拍板（接受风险也要有人签字）。\n' +
                '（把 findings 标成 resolved 之前，请先说清"为什么它不再算问题"。）',
            )
          }
          break
        }

        // ★ 安全角色的**否决权**：它报 blocked=true 时，关单必须被拦（哪怕审核给了 OK）。
        //   这一条与上一条互补：上一条看审核自己怎么说，这一条看**独立安全审计**怎么说。
        case 'security_not_blocked': {
          const veto = lastHandoff(task, 'security_review')
          if (veto !== null && veto.payload?.blocked === true) {
            const fs = toStringArray(veto.payload?.findings)
            return deny(
              'SECURITY_VETO',
              `拒绝关单：安全角色（security）出了一份 security_review，其 blocked=true —— 存在**阻断项**。\n` +
                `最高严重级别：${veto.payload?.severity ?? '(未给)'}\n` +
                (fs.length > 0 ? `发现项：\n  · ${fs.slice(0, 5).join('\n  · ')}` : '') +
                '\n★ 安全否决**优先于**审核 OK：安全角色是独立的一票，审核不能替它翻案。\n' +
                '下一步：pipeline_rework 打回编写整改 → 让安全角色复核出新的一份 security_review（blocked=false）→ 再谈关单。' +
                '\n（如果确实要带风险上线，那必须走 pipeline_human_request 让用户签字，不能在这里悄悄放行。）',
            )
          }
          // L3+ 必须真的有过独立安全审计
          const tier = task.roster?.tier ?? ''
          const needSecurity = ['L3', 'L4', 'L5'].includes(tier)
          if (needSecurity && veto === null) {
            return deny(
              'MISSING_SECURITY_REVIEW',
              `拒绝关单：本任务是 ${tier} 档（安全敏感），角色清单里有 security，但没有任何 security_review。\n` +
                '★ L3+ 的安全面要求**两条**：① 安全角色出独立结论（security_review）；② 审核复核并给安全确认（review_verdict.security）。\n' +
                '两者都要有 —— 缺了独立那一票，"审核自己说没问题"就不够了。',
            )
          }
          break
        }

        // ★ 角色清单里给了 diagrammer 时，架构图就是**交付物之一** —— 没有它不能关单。
        //   （没给 diagrammer 的任务不受影响，这条判据直接放行。）
        case 'diagram_delivered': {
          const hasDiagrammer = Array.isArray(task.roster?.execution_roles) && task.roster.execution_roles.includes(ROLE.DIAGRAMMER)
          if (!hasDiagrammer) break
          const dg = lastHandoff(task, 'architecture_diagram')
          if (dg === null) {
            return deny(
              'MISSING_DIAGRAM',
              `拒绝关单：本任务的角色清单里有「架构图」角色（${ROLE.DIAGRAMMER}），但没有任何 architecture_diagram 交接物。\n` +
                '★ 它在本任务里是**交付物之一**，不是可选项 —— 清单里派了它，就得交。\n' +
                '要么让架构图角色交图（走 diagram_deliver 拿收据，或降级并标 degraded=true），' +
                '要么让编排复核后把该角色从清单里去掉（roster_request → roster_review）。',
            )
          }
          const version = currentArtifactVersion(task)
          if (version !== null && dg.payload?.based_on_artifact_version !== version) {
            return deny(
              'DIAGRAM_STALE',
              `拒绝关单：架构图针对的是制品 ${dg.payload?.based_on_artifact_version}，当前有效制品是 ${version}。\n` +
                '图是旧版本的 —— 让架构图角色基于当前版本重出一张。',
            )
          }
          break
        }
        /**
         * ★「在册的角色必须交出它那一份」—— 把三句**自然语言约束**变成判据。
         *
         * 用户原话：「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」。
         * 这三条以前只活在角色卡（`roles.js` 的 summary）里：
         *   · `release`  —— "关单前必须给出可执行的发布与回滚计划"
         *   · `docs`     —— "产出用户文档 / 变更日志 / 使用说明"
         *   · `performance` —— "给出基准、压测结果与性能回归结论"
         * 写在 summary 里等于**没有执法**：角色不交，也没人拦得住。
         * 现在与 `diagram_delivered` **完全同形**：清单里派了它，就得交它那一份。
         *
         * ⚠️ 只在"该角色确实在册"时生效（L4/L5 才会有 release，L5 才会有 docs/performance），
         *    所以 L0~L3 的任务一点都不受影响。
         */
        case 'role_products_delivered': {
          const inRoster = (r) => Array.isArray(task.roster?.execution_roles) && task.roster.execution_roles.includes(r)
          const need = [
            { role: ROLE.RELEASE, kind: 'release_plan', zh: '发布与回滚计划' },
            { role: ROLE.DOCS, kind: 'docs_note', zh: '文档 / 变更日志' },
            { role: ROLE.PERFORMANCE, kind: 'perf_report', zh: '性能基准与回归结论' },
          ]
          const missing = need.filter((x) => inRoster(x.role) && lastHandoff(task, x.kind) === null)
          if (missing.length > 0) {
            return deny(
              'MISSING_ROLE_PRODUCT',
              `拒绝关单：角色清单里有 ${missing.map((x) => `「${roleLabel(x.role)}」`).join('、')}，` +
                `但没有对应的交接物。\n` +
                missing.map((x) => `  · ${roleLabel(x.role)} → 该交 ${x.kind}（${x.zh}）`).join('\n') +
                '\n★ 这条以前只写在角色卡里（"关单前必须给出……"）—— 写在 summary 里等于没人执法。\n' +
                '  现在它与"架构图必须交"完全同形：**清单里派了它，就得交它那一份**。\n' +
                '两条出路：① 让该角色把产物交上来；② 让计划 AI 复核后把它从清单里去掉（roster_request → roster_review）。',
            )
          }
          break
        }

        case 'rework_budget': {
          const leg = input.leg ?? (input.event === 'review_ng_test' ? 'test' : 'dev')
          const used = task.rework[leg] ?? 0
          const budget = task.roster?.rework_budget ?? maxRework
          if (used >= budget) {
            return deny(
              'REWORK_EXHAUSTED',
              `打回次数超限：本任务「${leg === 'dev' ? '打回编写' : '打回测试'}」已用 ${used} 次，上限 ${budget} 次。\n` +
                `按规则不能无限打回。请改用：pipeline_transition event=block（已阻塞）交人工介入，` +
                `或让编排复核后追加仲裁/架构角色（pipeline_roster_request → pipeline_roster_review）。`,
            )
          }
          break
        }

        // ★ 人工介入的两个前置条件（状态机只负责"能不能走"，判据在这里）
        case 'human_request_blocking': {
          const h = lastHandoff(task, 'human_request')
          if (h === null) {
            return deny('MISSING_HANDOFF', `任务 ${task.id} 要进入「等待人工答复」，必须先有一份 human_request 交接物。`)
          }
          if (h.payload?.blocking !== true) {
            return deny(
              'NOT_BLOCKING',
              `最近一份 human_request（${h.handoff_id}）声明的是 blocking=false（不阻塞），不该把任务推进到「等待人工答复」。`,
            )
          }
          break
        }
        case 'human_reply_has_source': {
          const entry = this.findHumanRequest(task, input.requestId)
          if (entry === null) {
            return deny(
              'NO_HUMAN_REQUEST',
              `任务 ${task.id} 里没有任何人工介入请求 —— 不能凭空从「等待人工答复」恢复。\n` +
                '这条挡的是"没等人回话就把状态推回去"。',
            )
          }
          if (entry.relayed_at === null) {
            return deny(
              'NOT_RELAYED',
              `请求 ${entry.request_id} 还没有转告给用户（relayed_at 为空），所以不可能有答复。\n` +
                '先 pipeline_human_relay。',
            )
          }
          if (entry.status !== 'answered') {
            return deny(
              'MISSING_USER_ANSWER',
              `请求 ${entry.request_id} 还没有记录用户答复（status=${entry.status}）。\n` +
                '★ 主对话不能自行把请求标记为已解决 —— 必须先用 pipeline_human_reply 记下用户的答复（含原话与归属），' +
                '状态才会跟着恢复。',
            )
          }
          break
        }
        default:
          return deny('INTERNAL', `未知的前置条件「${name}」（插件内部错误）。`)
      }
      return { ok: true }
    },
  }
}
