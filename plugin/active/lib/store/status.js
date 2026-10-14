/**
 * dsh-pipeline · 任务存储 · 状态汇总
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/status
 */

import { HANDOFF_SCHEMAS, summarizeHandoff } from '../handoff.js'
import {
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_HANDOFF_CONFIRM_EVENTS,
  HUB_HANDOFF_CONFIRM_ORDER,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_STATIONS,
  HUB_STATION_REJECT_BUDGET,
  ST,
  STATE_LABEL,
  WAITING_STATES,
  availableTransitions,
  hubConfirmersOf,
} from '../states.js'
import { ROLE } from '../roles.js'
import { toStringArray } from '../util.js'
import { hashGateEscalationPending } from '../hashgate.js'

/**
 * 任务存储 · 状态汇总
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function statusMethods(ctx) {
  const {
    maxRework,
    hashGateEscalateAfter,
    deny,
    loadTask,
    currentArtifactVersion,
    lastHandoff,
    hubOf,
    hubEnabled,
    hubStandby,
    hubRejectRecords,
    hubStationTarget,
    hubValidConfirms,
    effectiveReviewOk,
  } = ctx

  return {
    /** 给主对话看的脱敏视图。 */
    // --- 查询 ---------------------------------------------------------------

    /** 给主对话看的脱敏视图。 */
    async status(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const redact = input.redactForMain !== false
      const version = currentArtifactVersion(task)
      const ok = effectiveReviewOk(task)
      return {
        ok: true,
        task_id: task.id,
        state: task.state,
        state_zh: STATE_LABEL[task.state],
        requirement: task.requirement,
        tier: task.roster?.tier ?? null,
        ai_count: task.roster?.ai_count ?? null,
        roles: task.roster?.execution_roles ?? [],
        sequence: task.roster?.sequence?.map((s) => s.role) ?? [],
        /** ★ 本轮新增：编写席位与**层**（席位数 = 层数）。 */
        writers: task.roster?.writers
          ? {
              count: task.roster.writers.count,
              layers: task.roster.writers.layers ?? [],
              partitions: (task.roster.writers.partitions ?? []).map((p) => ({ seat: p.seat, layer: p.layer ?? null, scope_paths: p.scope_paths ?? [] })),
            }
          : null,
        /** ★ 本轮新增：需求分析结论（含「不清楚处」清单）—— 需求确认那一步看的就是它。 */
        requirement_analysis: (() => {
          const h = lastHandoff(task, 'requirement_analysis')
          if (h === null) return null
          return {
            handoff_id: h.handoff_id,
            at: h.created_at,
            acceptance: h.payload?.acceptance ?? [],
            test_points: h.payload?.test_points ?? [],
            boundaries: h.payload?.boundaries ?? [],
            unclear_points: h.payload?.unclear_points ?? [],
            open_assumptions: h.payload?.open_assumptions ?? [],
            analysis_reason: h.payload?.analysis_reason ?? '',
          }
        })(),
        /** ★ 本轮新增：计划与自检结果（自检没通过就不许分配 AI）。 */
        plan: (() => {
          const h = lastHandoff(task, 'plan')
          if (h === null) return null
          return {
            handoff_id: h.handoff_id,
            at: h.created_at,
            steps: h.payload?.plan_steps ?? [],
            layers: h.payload?.layers ?? [],
            self_check: h.payload?.self_check ?? null,
          }
        })(),
        requirement_confirmed: (task.human_requests ?? []).some(
          (r) => r.from_role === ROLE.ORCHESTRATOR && ['requirement_confirmation', 'requirement_ambiguous'].includes(r.reason_kind) && r.status === 'answered',
        ),
        /**
         * ★ 设计目的（最小改动）：**授权面 vs 实际改动面**的对照。
         *
         * 这是"改了清单外的文件要能在审核阶段查出来（判据级）"的落点 ——
         * 调用方拿到的是**算好的结论**，不是一堆原始清单让它自己去比。
         */
        change_scope: task.change_scope ?? null,
        /** ★ **越界清单**（这次不许做什么）—— 与 change_scope 配对（一个白名单、一个明令禁止）。 */
        forbidden: toStringArray(task.plan_forbidden),
        /**
         * ★ **授权面变更（amendment）视图** —— 窄通道 `pipeline_scope_amend` 的可见面。
         *
         * 为什么必须出现在状态查询里：授权面被改过之后，光看"现在有哪些条目"
         * 回答不了"**谁在什么时候为什么改的**" —— 而那正是这条通道唯一的代价所在
         * （它换来的是"裁定有了、动作做不了"不再卡死）。靠翻 audit.jsonl 等于没有。
         */
        amendments: (() => {
          const list = Array.isArray(task.amendments) ? task.amendments : []
          return list.map((a) => ({
            amendment_id: a.amendment_id,
            at: a.at,
            by: a.by,
            why: a.why,
            note: a.note ?? '',
            state_at_amend: a.state_at_amend ?? null,
            added: a.added ?? [],
            removed: a.removed ?? [],
            forbidden_added: a.forbidden_added ?? [],
            forbidden_removed: a.forbidden_removed ?? [],
            before: a.before ?? null,
            after: a.after ?? null,
          }))
        })(),
        /** ★ **最近一次**授权面变更（没有就是 null）—— 一眼看出"授权面刚被谁动过"。 */
        last_amendment: (() => {
          const list = Array.isArray(task.amendments) ? task.amendments : []
          if (list.length === 0) return null
          const a = list[list.length - 1]
          return {
            amendment_id: a.amendment_id,
            at: a.at,
            by: a.by,
            why: a.why,
            state_at_amend: a.state_at_amend ?? null,
            added: a.added ?? [],
            removed: a.removed ?? [],
            forbidden_added: a.forbidden_added ?? [],
            forbidden_removed: a.forbidden_removed ?? [],
          }
        })(),
        change_manifest: task.scope_conformance?.manifest ?? [],
        scope_conformance: task.scope_conformance ?? null,
        /** ★ 设计目的（职责自限）：计划给的**角色边界卡** —— 派活按它派。 */
        role_boundaries: task.role_boundaries ?? null,
        rework: { ...task.rework, budget: task.roster?.rework_budget ?? maxRework },
        /**
         * ★ **哈希前置闸门**的可见面（用户拍板 P13 之后它多了一半内容）。
         *
         * 为什么这些必须出现在状态查询里：主对话与编写都要能**一眼**看出
         * "这道闸卡着没有、连续几次了、还剩几次就自动交人工、是不是已经交人工了"。
         * 靠读审计翻出来，等于没有。
         */
        hash_gate: {
          blocked: task.hash_gate?.blocked === true,
          streak: Number.isInteger(task.hash_gate_streak) ? task.hash_gate_streak : 0,
          threshold: hashGateEscalateAfter,
          /** 还收不收 `dev_to_test`（升级未了结 ⇒ false）。 */
          accepting_submissions: !hashGateEscalationPending(task),
          last: task.hash_gate ?? null,
          /** 每一次比对的时间与理由（最近 20 条，全量在 task.json / audit.jsonl）。 */
          checks: (task.hash_gate_checks ?? []).slice(-20).map((c) => ({
            at: c.at,
            by: c.by,
            seat: c.seat ?? null,
            pass: c.pass === true,
            streak: c.streak ?? null,
            counts: c.counts,
            violations: (c.violations ?? []).map((x) => ({ how: x.how, path: x.path })),
          })),
          checks_total: (task.hash_gate_checks ?? []).length,
          escalation: task.hash_gate_escalation ?? null,
        },
        artifact_version: version,
        artifacts: task.artifacts.map((a) => ({ version: a.version, bytes: a.bytes, sha256: a.sha256.slice(0, 16), note: a.note })),
        review_ok: ok === null ? null : { handoff_id: ok.handoff_id, artifact_version: ok.artifact_version, at: ok.created_at },
        close_report: task.close_report,
        pending_roster_requests: task.roster_requests.filter((r) => r.status === 'pending').map((r) => ({ request_id: r.request_id, by: r.by, add: r.add, remove: r.remove })),
        /**
         * ★ 两级升级梯第一级：需求分析的**收件箱**。
         * 主对话也看得到 —— 它靠这个知道"这事现在卡在内部那一级，还不用惊动用户"。
         */
        clarification_requests: (task.clarification_requests ?? []).map((r) => ({
          request_id: r.request_id,
          from_role: r.from_role,
          stage: r.stage,
          question: r.question,
          blocking: r.blocking,
          urgency: r.urgency,
          status: r.status,
          round: r.round,
          verdict: r.verdict,
          answer: r.answer,
          reason: r.reason,
          constraints_added: r.constraints_added,
          answered_at: r.answered_at,
          escalated_at: r.escalated_at,
          escalated_to: r.escalated_to,
          resumed_to: r.resumed_to,
          state_at_request: r.state_at_request,
        })),
        pending_clarifications: (task.clarification_requests ?? []).filter((r) => r.status === 'pending').map((r) => r.request_id),
        /** ★ 等待梯视图：这个任务现在到底在等谁。 */
        waiting: WAITING_STATES.includes(task.state)
          ? { waiting_for: task.state === ST.AWAITING_CLARIFICATION ? 'orchestrator' : 'human',
              waiting_zh: task.state === ST.AWAITING_CLARIFICATION ? '等需求分析裁定（还不用惊动用户）' : '等用户答复',
              will_resume_to: task.previous_state ?? null }
          : null,
        /** ★待办的人工介入请求：主对话的**收件箱**。 */
        human_requests: task.human_requests.map((r) => ({
          request_id: r.request_id,
          from_role: r.from_role,
          created_at: r.created_at,
          reason_kind: r.reason_kind,
          reason_zh: r.reason_zh,
          question_for_human: r.question_for_human,
          blocking: r.blocking,
          blocked_stage: r.blocked_stage,
          urgency: r.urgency,
          decision_kind: r.decision_kind,
          status: r.status,
          relayed_at: r.relayed_at,
          answered_at: r.answered_at,
          answer_source: r.answer_source,
          resolved_at: r.resolved_at,
          resumed_to: r.resumed_to,
          timeout_at: r.timeout_at,
          timeout_behavior: r.timeout_behavior,
          state_at_request: r.state_at_request,
          // ★ 两级升级梯：这条 human_request 是从哪条澄清请求升上来的
          escalated_from: r.escalated_from ?? null,
          raised_by: r.raised_by ?? null,
          orchestrator_reason: r.orchestrator_reason ?? null,
          escalated_from_request: (task.clarification_requests ?? []).find((c) => c.handoff_id === r.escalated_from)?.request_id ?? null,
        })),
        pending_human_requests: task.human_requests.filter((r) => r.status !== 'answered' && r.status !== 'withdrawn').map((r) => r.request_id),
        /**
         * ★ 编写席位视图：主对话与各席位都要靠它知道"分了几块、谁交完了"。
         * 单席位（count=1）也会出现，只是只有一条 —— 调用方不用分情况处理。
         */
        writers: (() => {
          const w = task.roster?.writers ?? null
          if (w === null || typeof w !== 'object') return null
          const subs = task.writer_submissions ?? {}
          const parts = Array.isArray(w.partitions) ? w.partitions : []
          return {
            count: w.count,
            max_writers: w.max_writers ?? task.roster?.max_writers ?? 1,
            reason: w.reason ?? '',
            decided_by: w.decided_by ?? 'orchestrator',
            submitted: parts.filter((p) => subs[p.seat] !== undefined).length,
            pending_seats: parts.filter((p) => subs[p.seat] === undefined).map((p) => p.seat),
            partitions: parts.map((p) => ({
              seat: p.seat,
              scope_paths: p.scope_paths,
              interface_owner: p.interface_owner,
              deliverables: p.deliverables,
              submitted: subs[p.seat] !== undefined,
              handoff_id: subs[p.seat]?.handoff_id ?? null,
              artifact_version: subs[p.seat]?.artifact_version ?? null,
              at: subs[p.seat]?.at ?? null,
            })),
          }
        })(),
        /** ★ 架构图交付（角色清单里有 diagrammer 时它是必交项，关单会查）。 */
        architecture_diagram: (() => {
          const dg = lastHandoff(task, 'architecture_diagram')
          if (dg === null) return null
          return {
            handoff_id: dg.handoff_id,
            at: dg.created_at,
            diagram_path: dg.payload?.diagram_path ?? null,
            receipt_path: dg.payload?.receipt_path ?? null,
            receipt_id: dg.payload?.receipt_id ?? null,
            html_sha256: dg.payload?.html_sha256 ?? null,
            produced_by: dg.payload?.produced_by ?? null,
            degraded: dg.payload?.degraded === true,
            degraded_reason: dg.payload?.degraded_reason ?? null,
            based_on_artifact_version: dg.payload?.based_on_artifact_version ?? null,
            covered_modules: dg.payload?.covered_modules ?? [],
            stale: version !== null && dg.payload?.based_on_artifact_version !== version,
          }
        })(),
        next_events: availableTransitions(task.state).map((t) => ({ event: t.event, to: t.to, to_zh: STATE_LABEL[t.to], by: t.by, note: t.note })),
        /**
         * ★★ **主管枢纽视图**（T-20261011-56a37e）—— 只读、按站点给出**当前缺什么**。
         *
         * 为什么要有它：用户口径③要的是「待机**要能看出来**」（可见的"已登记未开工"），
         * 而验收 5 要的是「每道站点各自留痕（谁确认、依据什么、何时）」。
         * 这两件事都必须**读得回来** —— 只在拒绝原文里出现是不够的
         * （那样"待机"只在被拦的那一刻可见，平时看不出任务停在哪）。
         *
         * ★ 它完全**派生**自 `task.hub` 与 `task.handoffs`（不另存一份状态）。
         */
        hub: (() => {
          /**
           * ★★ P0-1：**"已递单、还没发起"也是一件必须看得见的事实**。
           *
           * 改前这里只认 `hubEnabled`（= 主管已发起），于是"主对话刚把单递给主管、
           *   等主管拉起三席"这段时间在只读面上**完全不可见** —— 主对话看不出
           *   "我递出去了没有""主管动了没有"。现在把入口那一条如实报出来。
           */
          if (!hubEnabled(task)) {
            const entry = hubOf(task)?.entry ?? null
            if (entry === null) return { enabled: false, note: '本任务未启用主管枢纽（走既有链，判据强度未变）。' }
            return {
              enabled: false,
              /** ★ 入口面：谁在什么时候把这张单递给了主管（没递过时为 null）。 */
              handoff_entry: { by: entry.by ?? null, at: entry.at ?? null, via: entry.via ?? null, note: entry.note ?? '' },
              handed_over_to_supervisor: true,
              initiated_by: null,
              note: '主对话已把本单**递给主管**，等主管调 pipeline_supervise action=initiate 拉起三席（需求 / 计划 / 架构）。',
            }
          }
          const standby = hubStandby(task).map((s) => ({
            role: s?.role ?? null,
            group: s?.group ?? null,
            wake_point: s?.wake_point ?? null,
            /** ★ 就是这一栏把"已登记未开工"变成看得见的东西。 */
            status: s?.status === 'woken' ? 'woken' : 'standby',
            status_zh: s?.status === 'woken' ? '已唤醒（到点）' : '已登记待机（未开工）',
            registered_at: s?.registered_at ?? null,
            registered_by: s?.registered_by ?? null,
            woken_at: s?.woken_at ?? null,
            woken_by: s?.woken_by ?? null,
          }))
          const stationView = (st) => {
            const need = hubConfirmersOf(st)
            const target = hubStationTarget(task, st)
            const got = hubValidConfirms(task, st).map((h) => ({ from_role: h.from_role, handoff_id: h.handoff_id, at: h.created_at, decision: h.payload?.decision ?? null, artifact_version: h.payload?.artifact_version ?? null, basis_refs: h.payload?.basis_refs ?? [], basis_kind: h.payload?.basis_kind ?? null, reason: h.payload?.reason ?? null }))
            /**
             * ★★ **否掉的面**（T-20261011-56a37e 补齐）—— 与上面的 `records` 对称。
             *
             * 为什么要在这里列出来：用户裁定「否掉也**不许静默**」。否掉记录是
             * `station_confirm{decision:'ng'}`，它**本来就在 `task.handoffs` 里**；
             * 而这一小节让主对话**不必翻 handoffs** 就能看到"这一站被谁、为什么否过"，
             * 以及那一次否掉**还算不算数**（`valid_now` = 它绑的是不是当前目标）。
             */
            const ngs = hubRejectRecords(task, st).map((h) => ({
              from_role: h.from_role,
              handoff_id: h.handoff_id,
              at: h.created_at,
              artifact_version: h.payload?.artifact_version ?? null,
              reason: h.payload?.reason ?? null,
              basis_refs: h.payload?.basis_refs ?? [],
              valid_now: target !== null && h.payload?.artifact_version === target,
            }))
            return {
              station: st,
              confirmers: need,
              /** ★ 有确认方的站点才是"确认闸门"；⑤（关单交付）没有确认方 ⇒ false。 */
              is_confirm_station: need.length > 0,
              confirmed_by: got.map((x) => x.from_role),
              missing: need.filter((r) => !got.some((x) => x.from_role === r)),
              complete: need.length > 0 && need.every((r) => got.some((x) => x.from_role === r)),
              target,
              records: got,
              /** ★ 本站的否掉记录（含已过期的；`valid_now` 区分）。 */
              rejects: ngs,
              /** ★ 本站否掉预算：已用 / 上限（与 ② 道 `diagram_redraws` 同一套口径）。 */
              rejects_used: Number.isInteger(hubOf(task)?.station_rejects?.[st]) ? hubOf(task).station_rejects[st] : 0,
              rejects_budget: hubConfirmersOf(st).length > 0 ? HUB_STATION_REJECT_BUDGET : 0,
            }
          }
          return {
            enabled: true,
            initiated_by: hubOf(task)?.initiated_by ?? null,
            initiated_at: hubOf(task)?.initiated_at ?? null,
            /**
             * ★ P0-1：**入口留痕**（谁把这张单递给主管的）—— 发起之后也一直读得回来
             *   （否则"发起"会把它盖掉，"谁递的单"就不可追溯了）。
             */
            handoff_entry: hubOf(task)?.entry ?? null,
            /** ★ ②b / ②c 两个新确认点的顺序（人读面：谁先谁后，不靠猜）。 */
            handoff_confirmations: HUB_HANDOFF_CONFIRM_ORDER.map((st) => ({
              station: st,
              zh: st === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ? '架构图 → 需求位确认' : '架构图 → 主管二次确认',
              confirmers: hubConfirmersOf(st),
              advances: HUB_HANDOFF_CONFIRM_EVENTS[st],
            })),
            supervisor_declared: hubOf(task)?.supervisor_declared === true,
            standby,
            /** ★ 两个唤醒点的留痕（谁在什么时候唤醒的）。 */
            wakes: Array.isArray(hubOf(task)?.wakes) ? hubOf(task).wakes : [],
            diagram_redraws: Number.isInteger(hubOf(task)?.diagram_redraws) ? hubOf(task).diagram_redraws : 0,
            diagram_redraw_budget: HUB_DIAGRAM_REDRAW_BUDGET,
            redraw_history: Array.isArray(hubOf(task)?.redraw_history) ? hubOf(task).redraw_history : [],
            /**
             * ★★ **站点否掉的可见面**（T-20261011-56a37e 补齐）——
             *   与 `diagram_redraws` / `redraw_history` 同形，只是按站点分开计数。
             *   `reject_history` 逐条是「哪一站 · 谁 · 何时 · 为什么 · 退到哪」。
             */
            station_rejects: hubOf(task)?.station_rejects !== null && typeof hubOf(task)?.station_rejects === 'object' && !Array.isArray(hubOf(task).station_rejects)
              ? { ...hubOf(task).station_rejects }
              : {},
            station_reject_budget: HUB_STATION_REJECT_BUDGET,
            reject_history: Array.isArray(hubOf(task)?.reject_history) ? hubOf(task).reject_history : [],
            stations: [
              stationView(HUB_STATIONS.NEED_AGREE),
              stationView(HUB_STATIONS.DIAGRAM_CONFIRM),
              /**
               * ★★ P0-1：**②b / ②c 两个新确认点**（用户新口径第 7~8 跳）。
               *
               * 它们插在「架构图完成」与「交计划」之间，顺序即判据：
               *   ②道（主管首判，转交需求位）→ ②b（**需求位确认**架构图）
               *   → ②c（**主管二次确认**，唤醒点 B）→ 才轮到计划位。
               * ★ 视图用的还是**同一个** `stationView` —— 于是"谁确认 / 还缺谁 /
               *   绑的哪份图 / 有没有否掉过"这四栏自动跟着出来，不另写一套渲染。
               */
              ...HUB_HANDOFF_CONFIRM_ORDER.map((st) => stationView(st)),
              stationView(HUB_STATIONS.TEST_CONFIRM),
              stationView(HUB_STATIONS.REVIEW_CONFIRM),
            ],
            /**
             * ★ **明确"第⑤道不是确认站点"**（本单第 2 步要求③）。
             *
             * 五道站点里只有**四道**有确认方（`is_confirm_station=true`）；
             * 第⑤道（关单并交付用户）没有确认方、也不产出确认记录 ——
             * 它**就是"交付"这一步本身**（用户那句里的"确认"落在第④道：
             * 主管+需求确认之后**才**提交主对话）。
             * 这一句写死在只读面上，免得"五道硬闸门"被读成"五道确认"。
             *
             * ★ P0-1：②b / ②c 两个**交接确认点**已经并进上面的 `stations` 视图
             *   （同一个 `stationView`），所以"哪几道是确认点"在只读面上是 4 + 2 = 6 条 ——
             *   而 `not_a_confirm_station` 仍然只有第⑤道一条（它是唯一**不是**确认点的那个）。
             */
            not_a_confirm_station: [HUB_STATIONS.CLOSEOUT],
            /** 测试提前知情的可读面：测试位手上有没有那份预登记、它是什么时候拿到的。 */
            prebrief: (() => {
              const pb = lastHandoff(task, 'prebrief')
              if (pb === null) return { delivered: false, handoff_id: null, at: null }
              return {
                delivered: true,
                handoff_id: pb.handoff_id,
                at: pb.created_at,
                to_role: pb.to_role,
                plan_handoff_id: pb.payload?.plan_handoff_id ?? null,
                must_not_start_before: pb.payload?.must_not_start_before ?? null,
                not_yet_available: pb.payload?.not_yet_available ?? [],
                /** ★ 是否"提前"：预登记必须早于编写交付 —— 这是判据，不是一个形容词。 */
                before_write: lastHandoff(task, 'dev_to_test') === null,
              }
            })(),
          }
        })(),
        /**
         * ★★ **A13：被拒收的交付**（可见面）—— 2026-10-14 补齐。
         *
         * 为什么要有它：`archiveRejectedDelivery` 写进留档记录的 `recall` 字段，指的
         * 就是「`pipeline_status { task_id }` 的『被拒收的交付』一节」（`:2097`）。
         * 而这一节**此前并不存在** —— 那句文案指了一个没有的入口。
         * 这个字段就是它的落点：**拒收照旧拒收，判据一个字没动**，
         * 只是把用户对 A13 的裁定兑现 ——「要么接收，要么拒收但对席位与主对话
         * **都可见且内容留档**（能查回原文）」。
         *
         * ★ 脱敏：主对话拿到的与 `handoffs` **同一条规矩** —— **不给提交内容正文**
         *   （`payload` 里是席位交上来的原文，可能含补丁/代码正文）。
         *   给的是"交了什么、为什么被拒、原文多大、按哪个 id 取"，正文仍留在盘上。
         */
        rejected_deliveries: (Array.isArray(task.rejected_deliveries) ? task.rejected_deliveries : []).map((d) => {
          let chars = 0
          try {
            chars = d.payload === null || d.payload === undefined ? 0 : JSON.stringify(d.payload).length
          } catch {
            chars = 0
          }
          return {
            delivery_id: d.delivery_id,
            at: d.at,
            kind: d.kind,
            kind_zh: HANDOFF_SCHEMAS[d.kind]?.zh ?? d.kind,
            code: d.code,
            reason: String(d.reason ?? '').slice(0, 600),
            from_role: d.from_role,
            from_seat: d.from_seat ?? null,
            /** ★ 提交时任务在哪个状态（"在哪个窗口里被拒的"，事后一眼看得出）。 */
            state_at_submit: d.state_at_submit ?? null,
            /** ★ 原始提交内容有多少字符（留档时超长会截断并标注 —— 这里如实给出）。 */
            payload_chars: chars,
            payload_truncated_from: d.payload_truncated_from ?? null,
            /** ★ 提交内容正文：主对话默认**不给**（与 `handoffs` 同一条脱敏规矩）。 */
            payload: redact
              ? `«已隐去正文：${chars} 字符；完整留档在 task.json 的 rejected_deliveries[] 里（delivery_id=${d.delivery_id}）»`
              : (d.payload ?? null),
          }
        }),
        handoffs: task.handoffs.map((h) => (redact ? summarizeHandoff(h) : h)),
        history_tail: task.history.slice(-20),
      }
    },
  }
}
