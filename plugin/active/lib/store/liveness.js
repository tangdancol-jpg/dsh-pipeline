/**
 * dsh-pipeline · 任务存储 · 席位失联与被拒交付留档
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/liveness
 */

import { STATE_LABEL } from '../states.js'
import { ROLE } from '../roles.js'
import { nowIso, shortHash } from '../util.js'
// ★ A9/A11：运行失败中止的**判词**（"崩"与"闲"必须写得不一样）。
import { describeRunFailures } from '../runfail.js'
import {
  DEFAULT_SEAT_SILENCE_MS,
  LIVENESS_ACTIVITY_SOURCE,
  approvalWaitSignature,
  describeApprovalWait,
  describeSilentSeats,
  describeSuspectedFalsePositive,
  livenessSelfHeal,
  seatLiveness,
  summarizeApprovalWait,
} from '../liveness.js'
import { sampleSessionActivity } from './shared.js'

/**
 * 任务存储 · 席位失联与被拒交付留档
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function livenessMethods(ctx) {
  const { now, MAX_REJECTED_PAYLOAD_CHARS, audit, deny, loadTask, persist } = ctx

  return {
    /**
     * ★ **查一次失联**（纯计算 + 可选的自动处置）。
     *
     * 语义分两段，**必须分清**（这决定了调用方怎么用它）：
     *   · `escalate !== true` ⇒ **只报告，不改任何东西**（`pipeline_status` 走这条）。
     *   · `escalate === true` ⇒ 发现失联就把任务推到「已阻塞」并写明原因
     *     （`tools/pre-execute` 那条缝走这条 —— "任意角色的下一次工具调用"）。
     *
     * 为什么自动处置挑 `block` 而不是新开一个状态：
     *   `states.js` 里已有一条 `{ from:'*', event:'block', to: BLOCKED, by:['main','human'] }`
     *   —— "任意非终态可阻塞"。复用它 = 不新开状态、不新开工具、不新开并行机制；
     *   而且 `blocked` 之后 `EXPECTED_ROLES_BY_STATE` 里没有它 ⇒ **不会重复升级**（自解除武装）。
     *   要解除：`pipeline_transition event=unblock` 回到阻塞前那个状态。
     *
     * ★ 失败分支不吞：拿不到任务就返回结构化的 `ok:false`，**不假装查过了**
     *   （"查不到"和"没失联"是两件事 —— 静默 fail-open 就是假绿）。
     *
     * @param {string} taskId
     * @param {{now?:number, escalate?:boolean, silenceMs?:number, probe?:Function}} [opts]
     *   ★ `opts.probe(seats, task)` = 「在等审批」采样器（P1-4）。由装配层注入
     *   （`index.js` 用 `createSeatApprovalProbe` 建，读宿主 `approval/asked` 事件）；
     *   不给 ⇒ 判据与改前**逐字节相同**（自测替身 / 装配不全时不会被这条新判据影响）。
     * @returns {Promise<object>}
     */
    async checkLiveness(taskId, opts = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)

      const atMs = typeof opts.now === 'number' ? opts.now : now().getTime()
      const silenceMs =
        Number.isInteger(opts.silenceMs) && opts.silenceMs > 0
          ? opts.silenceMs
          : Number.isInteger(this.seatSilenceMs) && this.seatSilenceMs > 0
            ? this.seatSilenceMs
            : DEFAULT_SEAT_SILENCE_MS

      // ★★ B2：先**现采**一次会话日志（size / mtime），再交给纯判据判。
      //
      //   为什么在这里采：判据是纯函数（`lib/liveness.js`），采样要碰磁盘 ——
      //   采样的活属于 store 层。**采不到就整份给 null**（= 本次没有活动证据），
      //   绝不给一个空对象冒充"它没动"（那会把"拿不到"误报成"死了"）。
      const activity = sampleSessionActivity(task, atMs, Number.isInteger(opts.activityMaxMs) ? opts.activityMaxMs : undefined)

      /** ★ 判据的公共入参（两次 `seatLiveness` 必须**同一个口径**，只差审批映射）。 */
      const liveOpts = {
        silenceMs,
        activity: activity.samples,
        gateApplicable: activity.gate_applicable === true,
        confirmations: Number.isInteger(opts.confirmations) ? opts.confirmations : undefined,
      }
      let live = seatLiveness(task, atMs, liveOpts)
      /**
       * ★★ **P1-4：先问一句「它是不是在等审批」，再决定要不要判失联。**
       *
       * 现场：`ask` 审批策略下席位弹审批卡等人点，6 分 34 秒后被判"失联"⇒ 主对话重派
       * ⇒ 白烧 30 分钟。判据来源是宿主自己写的会话事件（`approval/asked` 无配对
       * `approval/decided` = 还在等人批），采样器由装配层注入（见
       * `lib/liveness/approval.js` 的文件头；宿主**没有**可直接读的 pending API）。
       *
       * ★ 两个**成本 / 安全**边界：
       *   ① **只对"已经会被判失联"的席位探**（`live.silent` 非空）—— 正常干活时
       *      一次都不探，不给每次工具调用加一份读盘成本；
       *   ② 采样抛错 / 读不到 ⇒ **退回原有三条判据**（`known:false` 不算阳性证据），
       *      真死席位照旧判死 —— 这条新判据**只做减法（少误报）**，不做加法。
       */
      const approvalProbe = typeof opts.probe === 'function' ? opts.probe : null
      let approvalProbeNote = null
      if (approvalProbe !== null && live.silent.length > 0) {
        let probed = null
        try {
          probed = await approvalProbe(live.silent, task)
        } catch (err) {
          this.warn?.(`[pipeline] 审批探测异常（按"读不到"处理，判据退回既有三条）：${String(err?.message ?? err)}`)
        }
        if (probed !== null && probed !== undefined) {
          approvalProbeNote = typeof probed.note === 'string' ? probed.note : null
          const approvals = probed.approvals ?? null
          if (approvals !== null && typeof approvals === 'object' && Object.keys(approvals).length > 0) {
            live = seatLiveness(task, atMs, { ...liveOpts, approvals })
          }
        }
      }
      /** ★ P1-4：在等审批的席位（它们**不在** `live.silent` 里）。 */
      const awaitingSeats = Array.isArray(live.awaiting) ? live.awaiting : []
      const base = {
        ok: true,
        task,
        live,
        silent: live.silent,
        pending: live.pending,
        /**
         * ★★ **P1-4：在等审批的席位**（`approval.count > 0`）。
         *   它们**不是失联** —— 调用方（status / 拦截缝 / 唤醒）据此改写判词，
         *   **不要**走"重派"那条路。
         */
        awaiting: awaitingSeats,
        awaiting_count: awaitingSeats.length,
        awaiting_text: describeApprovalWait(awaitingSeats, { taskId, state: task.state, state_zh: STATE_LABEL[task.state] ?? task.state }),
        awaiting_summary: summarizeApprovalWait(awaitingSeats),
        /** ★ 审批探测的结论（`null` = 本次没探；读不到时也如实写）。 */
        approval_probe: approvalProbeNote,
        escalated: false,
        silence_ms: silenceMs,
        // ★ B5 修复：唤醒的幂等判别子要取**这里真实返回的字段**。
        //   改前 `lib/intercept.js` 取的是 `res.seats` / `res.escalations` ——
        //   这个返回值里**两个都不存在** ⇒ 判别子恒为 `|0` ⇒ 两次不同的失联
        //   拿到同一个交付键（实测：2026-10-11T16:51:40Z 与 2026-10-12T12:58:36Z
        //   两条 wake:delivered 的 key 逐字相同）。
        seats: live.silent.map((s) => s.key),
        escalations: Array.isArray(task.liveness?.escalations) ? task.liveness.escalations.length : 0,
        /** ★ 活动采样是否可用（false ⇒ 判据更保守，见 liveness.js 的 confirmations）。 */
        activity_known: live.activity_known,
        gate_applicable: live.gate_applicable,
        activity: activity.samples,
        activity_note: activity.note,
      }

      /**
       * ★★ **P1-4 留痕：读到"在等审批"时写一条自己的事实** —— 不判失联、不冻结，
       * 但事后必须能回答"机制当时为什么没把这张单冻掉"。
       *
       * 纪律（与"拒绝不是进展"同一条）：
       *   · **只在 `escalate === true` 的处置那一轮写**（`pipeline_status` 的只读查询
       *     不该往项目目录写东西）；判据与状态机一个字节不动；
       *   · **同一次等待只记一次**（签名 = 席位 + 待批 id 集合）—— 观察一次写一次
       *     会把 task.json / audit.jsonl 撑爆（与 P2-13 的台账膨胀同一类问题）；
       *   · `task.liveness.approvals_notified` 只留**最近一条**，它不是处置台账。
       */
      if (awaitingSeats.length > 0) {
        const sig = approvalWaitSignature(awaitingSeats)
        const notified = task.liveness?.approvals_notified ?? null
        if (opts.escalate === true && (notified === null || typeof notified !== 'object' || notified.sig !== sig)) {
          try {
            task.liveness = task.liveness ?? { escalations: [] }
            task.liveness.approvals_notified = {
              at: nowIso(now()),
              at_ms: atMs,
              sig,
              seats: awaitingSeats.map((s) => s.key),
              count: awaitingSeats.reduce((n, s) => n + (Number.isFinite(s?.approval?.count) ? s.approval.count : 0), 0),
              tools: [...new Set(awaitingSeats.flatMap((s) => (Array.isArray(s?.approval?.tools) ? s.approval.tools : [])))].slice(0, 12),
              state: task.state,
              /** ★ 与 `escalations[]` 最要紧的一处不同：**状态一步没动**（不冻结）。 */
              no_freeze: true,
            }
            await persist(task)
            await audit(taskId, ROLE.MAIN, 'liveness:awaiting-approval', {
              seats: task.liveness.approvals_notified.seats,
              count: task.liveness.approvals_notified.count,
              tools: task.liveness.approvals_notified.tools,
              state: task.state,
              no_freeze: true,
              note: describeApprovalWait(awaitingSeats, { taskId, state: task.state, state_zh: STATE_LABEL[task.state] ?? task.state }),
            })
          } catch (err) {
            this.warn?.(`[pipeline] 在等审批留痕失败（不影响本次判定）：${String(err?.message ?? err)}`)
          }
        }
      }

      // ★ B2：把本次采样与"连续没证据"计数落盘 —— 下一次观察才有基线可对比。
      //   只在真的采样到东西时写，避免每个工具调用都写一次任务文件。
      //
      //   ★★ 2026-10-13 快修（②，P0-3 的另一半）：**pending 的轮次也必须落盘**。
      //   改前只有 `samples !== null` 才写，于是"一个候选根都没命中"的那些轮次
      //   （正是本案的形状）计数器永远回不到台账 ⇒ 确认门**永远凑不满** ⇒ 门一旦开着
      //   就再也不冻结任何席位（静默把检测关掉）。现在无样本但有 pending 时也写一次，
      //   保证"两到三次观察内一定有个结论"。
      //   ⚠️ 只在**这一张单真的在等结论**时才写（`pending.length > 0`），
      //      所以"每个工具调用都写一遍任务文件"的老顾虑没有被放宽。
      if (activity.samples !== null || live.pending.length > 0) {
        try {
          task.liveness = task.liveness ?? { escalations: [] }
          if (activity.samples !== null) {
            task.liveness.samples = { ...(task.liveness.samples ?? {}), ...activity.samples }
          }
          const quiet = { ...(task.liveness.quiet ?? {}) }
          for (const s of live.seats) quiet[s.key] = s.quiet_streak
          task.liveness.quiet = quiet
          await persist(task)
        } catch (err) {
          this.warn?.(`[pipeline] 失联采样留痕失败（不影响本次判定）：${String(err?.message ?? err)}`)
        }
      }

      /**
       * ★★ **误判自愈（本轮修复）** —— "座位其实活着"时，把那次误判造成的阻塞**收回**。
       *
       * 为什么放在**这里**（`live.silent.length === 0` 那道早退之前）：
       *   任务一旦被推成「已阻塞」，`EXPECTED_ROLES_BY_STATE` 里根本没有 `blocked`
       *   ⇒ `expected` 是空数组 ⇒ `silent` 恒为空 ⇒ 走不到下面任何一支。
       *   换句话说：**冻结之后，所有"失联"相关的分支都不再跑了** —— 这正是
       *   "冻结是一次性的、收回只能靠人"的结构性原因。自愈必须挂在早退**之前**。
       *
       * 两条纪律（与"不许放宽真失联的判定"直接对应）：
       *   · **留痕永远做**（哪怕 `escalate:false` 的"只报告不处置"档）——
       *     用户原话：「或至少在 audit 里写明"疑似误判 + 依据"，让主对话一眼能看出」。
       *   · **改状态只在 `escalate === true` 时做**，且只认 {@link livenessSelfHeal} 的
       *     `can_unblock === true`（= 点名席位**全部**有阳性存活证据 + 恢复点仍在）。
       *     真死掉的席位拿不到阳性证据 ⇒ 这里**一个字节都不动**。
       *
       * ★★ 一处容易写错、写错就**永久堵死自愈**的地方（本轮自测抓到过）：
       *   "已标注过"这个**章**（`escalation.self_heal`）**只能在有权处置的那一轮盖**。
       *   如果 `escalate:false`（只报告档）也盖，那么后面真能处置的那一轮会看到
       *   `already:true` ⇒ **永远不敢收回** —— 那就是"只报告"把"能修"给关了。
       *   所以：`escalate:false` 时只按 `escalation_at` **去重地留痕**（不盖章、不动状态）。
       */
      const heal = livenessSelfHeal(task, live, { atMs })
      if (heal.suspects.length > 0) {
        const mayAct = opts.escalate === true
        const escsNow = Array.isArray(task.liveness?.escalations) ? task.liveness.escalations : []
        const escNow = escsNow.length > 0 ? escsNow[escsNow.length - 1] : null
        const alreadyLogged = Array.isArray(task.liveness?.suspected_false_positives) &&
          task.liveness.suspected_false_positives.some((r) => r?.escalation_at === heal.escalation_at)
        if (!alreadyLogged) {
          const healText = describeSuspectedFalsePositive(heal.suspects, {
            taskId,
            state: task.state,
            state_zh: STATE_LABEL[task.state] ?? task.state,
            unblocked: false,
            will_unblock: heal.can_unblock === true && mayAct,
            return_to: heal.will_return_to,
            reason: heal.reason,
          })
          try {
            task.liveness = task.liveness ?? { escalations: [] }
            if (!Array.isArray(task.liveness.suspected_false_positives)) task.liveness.suspected_false_positives = []
            const recHeal = {
              at: nowIso(now()),
              at_ms: atMs,
              seats: heal.suspects.map((s) => s.seat),
              basis: heal.basis,
              source: LIVENESS_ACTIVITY_SOURCE,
              escalation_at: heal.escalation_at,
              can_unblock: heal.can_unblock === true,
              unblocked: false,
              reason: heal.reason,
            }
            task.liveness.suspected_false_positives.push(recHeal)
            // ★ 章只在这一轮**有权处置**时盖（见上面那段"永久堵死"的说明）。
            if (mayAct && escNow !== null && typeof escNow === 'object') {
              escNow.self_heal = { at: recHeal.at, at_ms: atMs, basis: heal.basis, seats: recHeal.seats, unblocked: false }
            }
            await persist(task)
            await audit(taskId, ROLE.MAIN, 'liveness:suspected-false-positive', {
              seats: recHeal.seats,
              basis: heal.basis,
              source: LIVENESS_ACTIVITY_SOURCE,
              escalation_at: heal.escalation_at,
              can_unblock: recHeal.can_unblock,
              will_unblock: heal.can_unblock === true && mayAct,
              reason: heal.reason,
              note: healText,
            })
          } catch (err) {
            this.warn?.(`[pipeline] 疑似误判留痕失败（不影响本次判定）：${String(err?.message ?? err)}`)
          }
        }
      }

      if (heal.can_unblock === true && opts.escalate === true) {
        const trHeal = await this.transition({
          taskId,
          event: 'unblock',
          actorRole: ROLE.MAIN,
          actorAgentId: null,
          note:
            `★ 机制自愈（不是人叫停）：上一次「席位失联」是**误判** —— ${heal.basis}。` +
            `　依据（权威来源）：${LIVENESS_ACTIVITY_SOURCE}。` +
            `　恢复到「${STATE_LABEL[String(heal.will_return_to ?? '')] ?? String(heal.will_return_to ?? '?')}」，` +
            '让交付事件重新合法。',
        })
        if (trHeal.ok === true) {
          const taskAfter = trHeal.task
          const escsAfter = Array.isArray(taskAfter?.liveness?.escalations) ? taskAfter.liveness.escalations : []
          const escAfter = escsAfter.length > 0 ? escsAfter[escsAfter.length - 1] : null
          const fpos = Array.isArray(taskAfter?.liveness?.suspected_false_positives) ? taskAfter.liveness.suspected_false_positives : []
          const lastFp = fpos.length > 0 ? fpos[fpos.length - 1] : null
          if (lastFp !== null) lastFp.unblocked = true
          if (escAfter !== null && typeof escAfter === 'object' && escAfter.self_heal !== null && typeof escAfter.self_heal === 'object') {
            escAfter.self_heal.unblocked = true
          }
          await persist(taskAfter)
          await audit(taskId, ROLE.MAIN, 'liveness:false-positive-healed', {
            seats: heal.suspects.map((s) => s.seat),
            from: trHeal.from,
            to: trHeal.to,
            basis: heal.basis,
            source: LIVENESS_ACTIVITY_SOURCE,
            note: describeSuspectedFalsePositive(heal.suspects, {
              taskId,
              state: trHeal.from,
              state_zh: STATE_LABEL[trHeal.from] ?? trHeal.from,
              unblocked: true,
              return_to: trHeal.to,
            }),
          })
          return {
            ...base,
            task: taskAfter,
            healed: true,
            healed_seats: heal.suspects.map((s) => s.seat),
            healed_from: trHeal.from,
            healed_to: trHeal.to,
            heal_basis: heal.basis,
            heal_text: describeSuspectedFalsePositive(heal.suspects, {
              taskId,
              state: trHeal.from,
              state_zh: STATE_LABEL[trHeal.from] ?? trHeal.from,
              unblocked: true,
              return_to: trHeal.to,
            }),
          }
        }
        // 收回失败也要**说出来**（不静默吞掉）——回执里带上状态机的原话。
        return { ...base, healed: false, heal_error: trHeal.error, heal_basis: heal.basis }
      }

      if (live.silent.length === 0) return base
      if (opts.escalate !== true) return base

      /**
       * ★★ **A9 / A10：先问一句"它是不是**崩了**"，再决定冻不冻。**
       *
       * 现场：席位因模型输出层故障中止（`[MALFORMED_RESPONSE]`），机制却按
       * 「静默阈值 5 分」把任务**冻掉** —— 同一张单被冻 4 次，其中一次直接挡掉了
       * 一份**已提交**的交付（席位在冻结后仍工作了 2 分钟，那 2 分钟里交的
       * `test_to_review` 被「任务已阻塞」拒收）。
       *
       * 用户裁定：**运行失败中止不许冻**（A10），但**必须主动播报**（A11）——
       * 所以这一支既不改状态，也不安静：它把这次中止记成**自己的**一条记录
       * （带失败原文当证据），由拦截缝据此播报给主对话。
       *
       * ★ 真阳性保留（A12）：**拿不到失败证据**时这一支不生效，照旧走
       *   "真闲置超阈值 ⇒ 判失联 ⇒ 冻"那条既有判据。取证是本函数**额外**问的一句，
       *   不是替换 —— 没有任何一条判据被放宽。
       */
      if (typeof this.detectRunFailure === 'function') {
        let failure = null
        try {
          failure = await this.detectRunFailure(task, live.silent)
        } catch (err) {
          this.warn?.(`[pipeline] 运行失败取证异常（按"没有失败证据"处理，退回既有失联判据）：${String(err?.message ?? err)}`)
          failure = null
        }
        if (failure !== null && failure.found === true) {
          const abort = await this.recordSeatAbort(taskId, {
            seats: live.silent.map((s) => s.key),
            evidence: failure.evidence ?? null,
            detectedVia: String(failure.source ?? ''),
            note: `席位运行失败中止（不是闲置）：${String(failure.note ?? '')}`,
          })
          return {
            ...base,
            escalated: false,
            aborted: true,
            abort_id: abort.ok === true ? abort.abort_id : '',
            abort_text: describeRunFailures(live.silent, {
              evidence: failure.evidence ?? null,
              taskId,
              state: task.state,
              state_zh: STATE_LABEL[task.state] ?? task.state,
            }),
            note:
              `席位**运行失败中止**（不是闲置，任务**不冻结**）：${live.silent.map((s) => `${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}`).join('、')}` +
              `　取证：${String(failure.source ?? '?')}　${String(failure.note ?? '')}`,
          }
        }
      }

      // 重复升级的闸：同一批席位、且距上次处置还没过一个静默窗口 ⇒ 不重复推状态。
      // （正常情况到不了这里 —— 升到 blocked 之后 `live.silent` 已经是空的了。
      //   留着是因为**人工可能刚 unblock 而席位还是没活**，那时该允许再升一次。）
      const escs = Array.isArray(task.liveness?.escalations) ? task.liveness.escalations : []
      const seatKeys = live.silent.map((s) => s.key).sort().join(',')
      const last = escs.length > 0 ? escs[escs.length - 1] : null
      if (last !== null && Array.isArray(last.seats) && last.seats.slice().sort().join(',') === seatKeys) {
        if (typeof last.at_ms === 'number' && atMs - last.at_ms < silenceMs) {
          return { ...base, escalated: false, note: '同一批席位在上一轮静默窗口内已处置过，不重复升级。' }
        }
      }

      const note =
        `席位失联：${live.silent.map((s) => `${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}`).join('、')}` +
        `　静默阈值 ${live.silence_zh}　原状态「${live.state_zh}」`
      const tr = await this.transition({
        taskId,
        event: 'block',
        actorRole: ROLE.MAIN,
        actorAgentId: null,
        note: `★ 机制触发（不是人叫停）：${note}`,
      })
      if (tr.ok !== true) {
        // 推不动状态也要留痕 —— 但**不写**"已处置"，免得下次以为查过了。
        return { ...base, escalated: false, note: `失联已确认，但自动阻塞失败：${tr.error}` }
      }

      tr.task.liveness = tr.task.liveness ?? { escalations: [] }
      if (!Array.isArray(tr.task.liveness.escalations)) tr.task.liveness.escalations = []
      // ★ 处置后把"连续没证据"计数归零（这次已经处置过了，下一次是新一轮观察）。
      const quietReset = { ...(tr.task.liveness.quiet ?? {}) }
      for (const s of live.silent) quietReset[s.key] = 0
      tr.task.liveness.quiet = quietReset
      tr.task.liveness.escalations.push({
        at: nowIso(now()),
        at_ms: atMs,
        seats: live.silent.map((s) => s.key),
        previous_state: tr.from,
        to_state: tr.to,
        reason: note,
        // ★ B2：把**判据依据**一起留痕 —— 事后能回答"它被判死时，会话日志到底在不在长"。
        evidence: live.silent.map((s) => ({
          seat: s.key,
          quiet_streak: s.quiet_streak,
          activity: s.activity ?? null,
        })),
        activity_known: live.activity_known,
      })
      await persist(tr.task)
      return {
        ok: true,
        task: tr.task,
        live,
        silent: live.silent,
        escalated: true,
        from: tr.from,
        to: tr.to,
        silence_ms: silenceMs,
        note,
        summary: describeSilentSeats(live.silent, { state: tr.from, state_zh: STATE_LABEL[tr.from] ?? tr.from, silenceMs, activityKnown: live.activity_known }),
      }
    },

    /**
     * ★★ **A9 / A10 / A11：把一次"运行失败中止"记成它自己的一条事实。**
     *
     * 为什么单独记而不是塞进 `liveness.escalations`：那一条是"真闲置超阈值"的
     * 处置台账（它会**改状态**），这一条**不改状态**（用户裁定不冻结）。两者的
     * 判据必须**不同源、互不冒充**（A24 同向）—— 混在一起，事后就分不出
     * "这张单是被冻的"还是"它是崩了但没冻"。
     *
     * @param {string} taskId
     * @param {{seats?:string[], evidence?:object|null, detectedVia?:string, note?:string, atMs?:number}} [spec]
     * @returns {Promise<{ok:boolean, task?:object, abort_id?:string, abort?:object, error?:string}>}
     */
    async recordSeatAbort(taskId, spec = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      task.liveness = task.liveness ?? { escalations: [] }
      if (!Array.isArray(task.liveness.aborts)) task.liveness.aborts = []
      const atMs = Number.isFinite(spec.atMs) ? spec.atMs : now().getTime()
      const at = nowIso(now())
      const seats = Array.isArray(spec.seats) ? spec.seats.map((x) => String(x)) : []
      /**
       * ★★ **A1（打回项 ③）：中止身份必须认的是"这一次崩溃"，不是"这一次观察"。**
       *
       * 现场：同一份**未变化**的中止跨观察产生了 3 个不同的 `abort_id`
       * （实测 `AB-ce70e2…` / `AB-eec10c…` / `AB-bdfbdf…`）⇒ 每查一次 `pipeline_status`
       * 就多播一条"席位中止"，且 `liveness.aborts` **无界增长**。
       * 根因：下面这个 id 里含了 `at`（= 本次观察时刻，每次调用都不同）。
       *
       * 现在：身份取**问题自己**（哪些席位 + 失败证据的内容）；
       *   · 同一次崩溃重复观察 ⇒ 证据逐字相同 ⇒ **同一个 id** ⇒ 去重，不重播（A1）；
       *   · **又一次中止** ⇒ 证据不同（含新的时刻 / 行文）⇒ 新 id ⇒ 新一条播报（A3 不被吞）。
       *   ★ 证据拿不到时退成空串 ⇒ 只按席位算（仍然稳定，不会因观察次数而变）。
       */
      const abortSig = String(spec?.evidence?.text ?? '') + '|' + String(spec?.evidence?.at ?? '')
      const abortId = `AB-${shortHash(`${taskId}|${seats.slice().sort().join(',')}|${abortSig}`)}`
      /**
       * ★ 同一件事只记一次：此前已有**席位相同、证据相同**的中止记录 ⇒
       *   直接把它还回去（同一个 id ⇒ 接雨那一侧的幂等键命中 ⇒ 不重播），
       *   且**不再向 `liveness.aborts` 追加** 也不再写一条审计（避免无界增长）。
       */
      const priorAbort = (Array.isArray(task.liveness.aborts) ? task.liveness.aborts : []).find(
        (r) => r?.abort_id === abortId &&
          String((Array.isArray(r?.seats) ? r.seats : []).slice().sort().join(',')) === seats.slice().sort().join(','),
      )
      if (priorAbort !== undefined && priorAbort !== null) {
        return { ok: true, task, abort_id: abortId, abort: priorAbort, deduped: true }
      }
      const rec = {
        abort_id: abortId,
        at,
        at_ms: atMs,
        seats,
        /** ★ 失败原文（出处 + 命中标记 + 那一段）—— A9 要求判词**携带**它。 */
        evidence: spec.evidence ?? null,
        detected_via: String(spec.detectedVia ?? ''),
        note: String(spec.note ?? ''),
        previous_state: task.state,
        /** ★ 与 `escalations[]` 最要紧的一处不同：**状态一步没动**（A10 不许冻结）。 */
        to_state: task.state,
        no_freeze: true,
      }
      task.liveness.aborts.push(rec)
      const entry = await audit(task.id, 'mechanism', 'liveness:abort', {
        abort_id: abortId,
        seats,
        evidence: rec.evidence,
        detected_via: rec.detected_via,
        note: rec.note,
        state: task.state,
        no_freeze: true,
      })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, abort_id: abortId, abort: rec }
    },

    /**
     * ★★ **A13：被拒收的交付不许静默消失。**
     *
     * 现场：机制把任务冻住之后，席位仍在工作 2 分钟，那 2 分钟里交的
     * `test_to_review` 被「任务已阻塞」（状态判据）**拒收** —— 席位那边只拿到一句
     * 拒绝理由，主对话那边什么都不知道，**内容是彻底没了**。
     *
     * 用户裁定的处置（A13）：**要么接收，要么拒收但对席位与主对话都可见且内容留档
     * （能查回原文）**。本方法就是"留档"那一半：把这条交付的**完整提交内容**
     * 追加进任务数据，并给一个可查回的句柄（`delivery_id`）。
     *
     * ★ 它与"接收"是互斥的两条路：判据不许因此放宽（状态机一个字没改），
     *   只是把"拒收"变成**可见且有据可查**。
     *
     * @param {string} taskId
     * @param {{kind?:string, code?:string, reason?:string, fromRole?:string, fromSeat?:string|null, payload?:object|null}} [spec]
     * @returns {Promise<{ok:boolean, task?:object, delivery_id?:string, delivery?:object, error?:string}>}
     */
    async archiveRejectedDelivery(taskId, spec = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      if (!Array.isArray(task.rejected_deliveries)) task.rejected_deliveries = []
      const at = nowIso(now())
      const kind = String(spec.kind ?? '')
      const deliveryId = `RD-${shortHash(`${taskId}|${at}|${kind}|${String(spec.fromRole ?? '')}`)}`
      const rawPayload = spec.payload !== null && typeof spec.payload === 'object' ? spec.payload : null
      /**
       * ★ **留档要留得住，但不能把任务文件撑爆**：超长内容截断保存并**如实标注**，
       *   绝不静默丢弃（"能查回原文"是判据，"原文有多大"不是）。
       */
      let payload = rawPayload
      let truncated = null
      if (rawPayload !== null) {
        let body = ''
        try {
          body = JSON.stringify(rawPayload)
        } catch {
          body = ''
        }
        if (body.length > MAX_REJECTED_PAYLOAD_CHARS) {
          payload = { truncated: true, chars: body.length, head: body.slice(0, MAX_REJECTED_PAYLOAD_CHARS), note: '★ 内容超长，这里只留前一段（完整原文在席位那次调用的返回值里；这条留档的意义是"它交过什么、为什么被拒"可查）。' }
          truncated = body.length
        }
      }
      const rec = {
        delivery_id: deliveryId,
        at,
        kind,
        code: String(spec.code ?? ''),
        reason: String(spec.reason ?? ''),
        from_role: String(spec.fromRole ?? ''),
        from_seat: typeof spec.fromSeat === 'string' && spec.fromSeat.length > 0 ? spec.fromSeat : null,
        /** ★ 提交时的任务状态（"在哪个窗口里被拒的"——事后一眼看得出）。 */
        state_at_submit: task.state,
        /** ★ **原始提交内容**（能查回原文）；超长时截断并标注 `payload_truncated_from`。 */
        payload,
        payload_truncated_from: truncated,
        /** ★ 查回方式（写给主对话看的一行）。 */
        recall: `pipeline_status { task_id: "${taskId}" } 的「被拒收的交付」一节，或 node_modules/dsh-pipeline/lib/store.js 的 task.rejected_deliveries[]（delivery_id=${deliveryId}）`,
      }
      task.rejected_deliveries.push(rec)
      const entry = await audit(task.id, String(spec.fromRole ?? 'unknown'), 'delivery:rejected', {
        delivery_id: deliveryId,
        kind,
        code: rec.code,
        reason: rec.reason,
        state: rec.state_at_submit,
        archived: true,
      })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, delivery_id: deliveryId, delivery: rec }
    },
  }
}
