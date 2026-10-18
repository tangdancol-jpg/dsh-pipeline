/**
 * dsh-pipeline · 任务存储 · 席位归属、架构图交付、哈希闸门升级
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/seat-checks
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { ROLES_CAN_RAISE_HUMAN, ST } from '../states.js'
import { ROLE } from '../roles.js'
import { isInside, nowIso, pathKey } from '../util.js'
import { hashGateEscalationPending, renderHashGateEscalation, shouldEscalateHashGate, vetForeignPathsAck } from '../hashgate.js'
import { writeJsonAtomic, writerSeatsOf, seatPartitionOf } from './shared.js'

/**
 * 任务存储 · 席位归属、架构图交付、哈希闸门升级
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function seatCheckMethods(ctx) {
  const { hashGateEscalateAfter, now, handoffDir, audit, deny, persist, scopeAbsKey, baselineAbsKey } = ctx

  return {
    /** 把一份交接物记录追加进任务并落盘。 */
    async appendHandoff(task, record) {
      task.handoffs.push(record)
      const seq = String(task.handoffs.length).padStart(3, '0')
      const file = join(handoffDir(task.id), `${seq}-${record.kind}.json`)
      await writeJsonAtomic(file, record)
      record.file = file
      return record
    },

    /**
     * ★ 校验一份 `dev_to_test` 的席位归属。
     *
     * 两条判据：
     *   ① 提交的席位必须在册（roster.writers.partitions 里有它）
     *   ② 调用方令牌的席位必须与提交的席位一致（防"拿 writer#1 的令牌交 writer#2 的分区"）
     *
     * 单席位（count=1）并且没给 partition 时，自动补成 `writer#1` + 整根范围 ——
     * 这是与旧行为**完全等价**的退化路径。
     */
    checkSeatOwnership(task, payload, input) {
      const seats = writerSeatsOf(task)
      const given = payload.partition
      const declaredSeat = typeof given?.seat === 'string' && given.seat.length > 0 ? given.seat : null

      // ① 在册？
      const seat = declaredSeat ?? seats[0]
      if (!seats.includes(seat)) {
        return deny(
          'SEAT_NOT_DECLARED',
          `席位「${seat}」不在本任务的在册编写席位里（在册：${seats.join('、')}）。\n` +
            '编写席位是**计划分配**（planner）的产物，不是自己声明的。要加席位必须走 ' +
            'pipeline_roster_request → pipeline_roster_review 复核。',
        )
      }

      // ② 令牌席位是否对得上？
      const tokenSeat = typeof input.actorSeat === 'string' && input.actorSeat.length > 0 ? input.actorSeat : null
      if (tokenSeat !== null && tokenSeat !== seat) {
        const mine = seatPartitionOf(task, tokenSeat)
        const theirs = seatPartitionOf(task, seat)
        return deny(
          'SEAT_MISMATCH',
          `席位不匹配：你这枚令牌属于「${tokenSeat}」，但这份交接物声明的是「${seat}」。\n` +
            `你的范围：${(mine?.scope_paths ?? []).join('、') || '(未声明)'}\n` +
            `对方范围：${(theirs?.scope_paths ?? []).join('、') || '(未声明)'}\n` +
            '★ 只能提交自己那一份。要交别人的分区，得先让编排把席位重新分配（roster_request → roster_review）。',
        )
      }

      const part = seatPartitionOf(task, seat)
      return {
        ok: true,
        partition: {
          seat,
          index: part?.index ?? 1,
          total: part?.total ?? seats.length,
          // ★ 本轮新增：层随分区一起回填 —— 交接物与角色清单里的层必须一致，
          //   否则"谁负责哪层"会出现两个版本。
          //   （layer 的**形状**校验在 handoff.js；这里回填的是**事实来源**：roster 的分区表。）
          layer: part?.layer ?? 'all',
          scope_paths: part?.scope_paths ?? ['.'],
        },
      }
    },

    /**
     * ★★ P1-9：核 `dev_to_test` 的「外来路径显式确认」（`foreign_paths_ack`）。
     *
     * 判据本体是**纯函数** `lib/hashgate/foreign-ack.js` 的 `vetForeignPathsAck`
     * （五条硬判据：本次真有变化 / 不是本席分区 / 是别的编写席位分区 / 不是越界 / 删除类不适用）。
     * 这里只做三件**接线**：
     *   ① 从任务取本席与别的编写席位的分区范围（唯一事实来源是 `writerSeatsOf` / `seatPartitionOf`）；
     *   ② 给路径归一化器 —— **与哈希闸门同一套坐标系**（授权面用 `scopeAbsKey`、审计路径用 `baselineAbsKey`）；
     *   ③ 把 `changeAudit()` 的结果原样传进去（判据 ①④ 要读它的 added/modified/unauthorized）。
     *
     * ⚠️ 这是**闸门判定之前**的一道用法校验：不合格 ⇒ 整次提交被拒（码见 `FOREIGN_ACK_CODES`），
     *    不写台账、不进"连续不过"计数 —— 那是形状/用法错误，不是"改动面对不上"。
     *
     * @param {object} task
     * @param {object} input
     * @param {object[]} input.ack - 已过形状校验的 `foreign_paths_ack`
     * @param {string|null} [input.seat] - 本席（缺省按在册第一席，与 `checkSeatOwnership` 同口径）
     * @param {object} input.audit - `changeAudit()` 的结果
     * @returns {{ok:true, keys:string[], entries:object[]} | {ok:false, code:string, error:string}}
     */
    checkForeignPathsAck(task, input = {}) {
      const ack = Array.isArray(input.ack) ? input.ack : []
      if (ack.length === 0) return { ok: true, keys: [], entries: [] }
      return vetForeignPathsAck({
        ack,
        seat: input.seat ?? null,
        seats: writerSeatsOf(task),
        partitionOf: (seat) => seatPartitionOf(task, seat),
        audit: input.audit ?? null,
        absOfDeclared: (p) => scopeAbsKey(p, task),
        absOfTouched: (p) => baselineAbsKey(p),
        isInside,
      })
    },

    /**
     * ★ 校验架构图交付的**回执**（要读磁盘，所以只能在 store 层做）。
     *
     * 判据分两条路：
     *   · `produced_by=diagram_deliver`：收据文件必须**真实存在**（这是"声称走过闸门"的凭据）；
     *   · `produced_by=self-provided`：`degraded` 必须为 true 且有原因（字段校验已管），
     *     这里只确认产物本身存在
     *
     * 无论哪条路，`diagram_path` 都必须指向一个**真实存在**的文件，且 `html_sha256` 必须与它逐字节一致
     * （缺陷 ⑰：原先只有 diagram_deliver 那一路核哈希）——
     * 交一份指向不存在路径的"交付物"没有意义。
     */
    async checkDiagramDelivery(task, payload) {
      const { existsSync } = await import('node:fs')
      const root = task.project_root

      const resolveOne = (p) => {
        const s = String(p ?? '').trim()
        if (s.length === 0) return null
        return pathKey(isAbsolute(s) ? resolve(s) : resolve(root, s))
      }

      const diagramPath = resolveOne(payload.diagram_path)
      if (diagramPath === null || !existsSync(diagramPath)) {
        return deny(
          'DIAGRAM_MISSING',
          `diagram_path 指向的文件不存在：${payload.diagram_path}\n` +
            '交付物必须真的躺在盘上 —— 指向一个不存在的路径不算交付。\n' +
            '（若走 diagram_deliver，把它返回的 html_path 原样填进来。）',
        )
      }

      // ★ 缺陷 ⑰（2026-10-17）：哈希核对挪到两条产出路共用的位置（原先只有 diagram_deliver 那一路核，
      //   self-provided 给错了照样放行）；按**原始字节**算，与任何外部 sha256 工具的结果一致。
      //   字段本身已是必填（schemas.js），这里兜底"给了空串"也拒。
      const declared = String(payload.html_sha256 ?? '').trim().toLowerCase()
      const { readFile } = await import('node:fs/promises')
      const actual = createHash('sha256').update(await readFile(diagramPath)).digest('hex')
      if (declared !== actual) {
        return deny(
          'DIAGRAM_HASH_MISMATCH',
          `html_sha256 与磁盘上的产物对不上。\n` +
            `交接物里写的：${declared || '(缺失)'}\n实际文件的：      ${actual}\n` +
            '制品版本化就是为了防"说的是这一版、交的是另一版"。\n' +
            '下一步：对 diagram_path 指向的那个文件算 sha256（十六进制），原样填进 html_sha256 再交。',
        )
      }

      if (payload.produced_by === 'diagram_deliver') {
        const receiptPath = resolveOne(payload.receipt_path)
        if (receiptPath === null || !existsSync(receiptPath)) {
          return deny(
            'RECEIPT_MISSING',
            `produced_by=diagram_deliver，但收据文件不存在：${payload.receipt_path}\n` +
              '★ diagram_deliver 的价值就在那份**交付收据**（含被引用模块的 id 与 fingerprint、' +
              '规格文件 sha256、产物 sha256、所用命令与版本）。没有收据，事后就答不出' +
              '"这张图基于哪一版结构数据、当时校验过没有"。\n' +
              '两条出路：① 真的调一次 diagram_deliver，把它返回的 receipt_path 填进来；' +
              '② 如果 dsh-archigate 没装/被禁用，把 produced_by 改成 self-provided 并标 degraded=true + 原因。',
          )
        }

        return { ok: true, diagramPath, receiptPath }
      }

      // self-provided：产物在就行（degraded/原因由字段校验管）
      return { ok: true, diagramPath, receiptPath: null }
    },

    /**
     * ★★ **哈希闸门连续不通过 ⇒ 自动交人工**（用户拍板 P13 的那一半）。
     *
     * 「不许另起一套并行机制」是硬要求，所以这里**不新开**状态、工具、请求表：
     *   · 用的就是既有的 `human_request` 交接物 + `task.human_requests` 生命周期
     *     + `awaiting_human` 那两条边（发起 → 主对话转告 → 用户答复 → 恢复）；
     *   · 答复仍然必须带**来源**与用户**本人原话**（`human_reply_has_source` 判据一个字没动）；
     *   · 唯一"新"的东西是 `reason_kind=hash_gate_escalation` 这一个枚举值，
     *     以及"只有机制发得出来"那一条闸（见 `checkHumanRequestChannel` 的 ⓪）。
     *
     * 谁发起：**需求分析（orchestrator）**—— 两级梯的第二级本来就是它；
     * 没有独立编排的档位（`orchestrator_mode !== 'separate'`）退化用**取基线的那个人**
     * （`baseline.taken_by`，实务上就是计划 AI）。这样 `from_role` 不撒谎：
     * 它一定是本任务里真实存在的那个角色。
     *
     * @param {object} task
     * @param {object} ctx
     * @param {number} ctx.streak
     * @param {number} ctx.threshold
     * @param {object} [ctx.verdict] - 本次闸门判定（越界明细会进审计）
     * @param {object|null} [ctx.baseline]
     * @returns {Promise<{escalated:boolean, reason:string, streak:number, threshold:number, round?:number, request_id?:string, handoff_id?:string, from_role?:string, error?:string}>}
     */
    async escalateHashGate(task, ctx) {
      const threshold = Number.isInteger(ctx?.threshold) ? ctx.threshold : hashGateEscalateAfter
      const streak = Number.isInteger(ctx?.streak)
        ? ctx.streak
        : Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0

      if (threshold <= 0) return { escalated: false, reason: 'threshold_off', streak, threshold }
      if (!shouldEscalateHashGate(task, threshold)) {
        return { escalated: false, reason: hashGateEscalationPending(task) ? 'already_pending' : 'below_threshold', streak, threshold }
      }
      // 只有"开发中"才谈得上这件事：闸门就是在这一站卡的。状态不是它就说明
      // 有人抢在前面动过任务 —— 那就什么都不做，让正常路径去处置。
      if (task.state !== ST.DEVELOPING) return { escalated: false, reason: 'not_developing', streak, threshold }

      const round = (Number.isInteger(task.hash_gate_escalation?.round) ? task.hash_gate_escalation.round : 0) + 1
      /**
       * ★ 由**谁**发起这条人工请求。
       *
       * 优先级（每一步都必须"这个角色真的发得出来 human_request"，否则往后让）：
       *   ① 有独立编排 ⇒ **需求分析**（两级梯的第二级本来就是它）；
       *   ② 没有独立编排 ⇒ **取基线的那个人**（`baseline.taken_by`，实务上就是计划 AI）；
       *   ③ 兜底 ⇒ **计划 AI**。
       *
       * ⚠️ 为什么每一步都要查 `ROLES_CAN_RAISE_HUMAN`：基线是**可以重取**的，
       *    而重取允许"主对话兜底"（见 `pipeline_change_audit` 的 take 权限）。
       *    若照抄 `taken_by='main'`，`canProduceHandoff('main','human_request')` 会直接拒 ——
       *    升级**发不出去**，而且现场只留下一条 `gate:hash_escalate_failed`。
       *    这是本项目反复踩过的同一类坑：**别让一条判据在角落路径上静默失效**。
       *    宁可把 `from_role` 写成计划 AI（审计里 `gate:hash_escalate` 仍写着真实来由：机制触发），
       *    也不要让"连续 N 次不过"这件事没人管。
       */
      const taker = typeof ctx?.baseline?.taken_by === 'string' ? ctx.baseline.taken_by : ''
      const fromRole = task.roster?.orchestrator_mode === 'separate'
        ? ROLE.ORCHESTRATOR
        : ROLES_CAN_RAISE_HUMAN.includes(taker) && taker !== ROLE.HUMAN
          ? taker
          : ROLE.PLANNER
      const q = renderHashGateEscalation({ streak, threshold, round })

      // ⚠️ 记下"发之前的条数"：升级失败时要把可能落下的半截记录摘干净。
      //   （`submitHandoff` 在写 human_requests 之后、真迁移失败时会回滚交接物，
      //     但那一条生命周期记录不在它的回滚范围内 —— 别把悬空记录留在盘上。）
      const before = Array.isArray(task.human_requests) ? task.human_requests.length : 0

      const res = await this.submitHandoff({
        taskId: task.id,
        kind: 'human_request',
        actorRole: fromRole,
        actorSeat: null,
        actorAgentId: null,
        // ★ 机制触发（不是角色触发）—— 唯一的凭证，见 checkHumanRequestChannel 的 ⓪
        systemEscalation: true,
        payload: {
          task_id: task.id,
          from_role: fromRole,
          reason_kind: 'hash_gate_escalation',
          question_for_human: q.question,
          context_for_human: q.context,
          options: q.options,
          recommended: '',
          blocking: true,
          blocked_stage: '编写提交（哈希前置闸门）',
          urgency: 'blocking',
          // ★ free_text 而不是 choose_option：选项是**给人参考**的，
          //   但用户怎么答都得能如实记下来（choose_option 会拒掉选项之外的原话）。
          decision_kind: 'free_text',
          // ★ stay_blocked：机制不替用户设默认值，也不会自己按超时往下走。
          timeout_behavior: 'stay_blocked',
          orchestrator_reason:
            `机制自动升级：哈希前置闸门连续 ${streak} 次不通过（阈值 ${threshold}）。` +
            '这不是需求层的歧义 —— 需求分析与编排都答不了"为什么同一份改动反复落在授权范围之外"，所以按两级梯直接交用户。',
        },
      })

      if (res.ok !== true) {
        if (Array.isArray(task.human_requests) && task.human_requests.length > before) {
          task.human_requests.length = before
        }
        task.history.push(
          await audit(task.id, ROLE.MAIN, 'gate:hash_escalate_failed', {
            streak,
            threshold,
            round,
            code: res.code ?? null,
            error: String(res.error ?? '').slice(0, 400),
          }),
        )
        await persist(task)
        return { escalated: false, reason: 'request_denied', streak, threshold, round, error: res.error }
      }

      const entry = Array.isArray(task.human_requests) ? task.human_requests.at(-1) ?? null : null
      task.hash_gate_escalation = {
        round,
        at: nowIso(now()),
        streak,
        threshold,
        request_id: entry?.request_id ?? null,
        handoff_id: res.handoff?.handoff_id ?? null,
        from_role: fromRole,
        /** `null` = **还没了结**（既不再升级，也拒收同一任务的再次提交）。 */
        answered_at: null,
        answer_source: null,
        user_quote: null,
        resumed_to: null,
        reason: 'hash_gate_streak',
      }
      task.history.push(
        await audit(task.id, ROLE.MAIN, 'gate:hash_escalate', {
          round,
          streak,
          threshold,
          request_id: task.hash_gate_escalation.request_id,
          handoff_id: task.hash_gate_escalation.handoff_id,
          from_role: fromRole,
          violations: (ctx?.verdict?.violations ?? []).map((x) => `${x.how}:${x.path}`),
          state: task.state,
          // ★ 一句话说清"为什么现在轮到用户"：阈值是机制数的，不是谁拍的
          why: `连续 ${streak} 次哈希前置闸门不通过（阈值 ${threshold}）`,
        }),
      )
      await persist(task)
      return {
        escalated: true,
        reason: 'escalated',
        streak,
        threshold,
        round,
        request_id: task.hash_gate_escalation.request_id,
        handoff_id: task.hash_gate_escalation.handoff_id,
        from_role: fromRole,
      }
    },
  }
}
