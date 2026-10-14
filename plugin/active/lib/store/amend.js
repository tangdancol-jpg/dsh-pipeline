/**
 * dsh-pipeline · 任务存储 · 角色变更与授权面变更
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/amend
 */

import { validateChangeScope } from '../handoff.js'
import { ST, STATE_LABEL } from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
import { nowIso, shortHash, toStringArray } from '../util.js'
import { findNonScopeKeys } from './shared.js'

/**
 * 任务存储 · 角色变更与授权面变更
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function amendMethods(ctx) {
  const { now, audit, deny, loadTask, persist } = ctx

  return {
    // --- 角色变更申请（编写/测试/审核提出 → 编排复核）-----------------------

    async requestRosterChange(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const allowed = [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHITECT, ROLE.SECURITY, ROLE.RELEASE, ROLE.PERFORMANCE, ROLE.DOCS]
      if (!allowed.includes(input.actorRole)) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有执行角色（${allowed.map(roleLabel).join('/')}）能提角色变更申请，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            (input.actorRole === ROLE.MAIN
              ? '★ 主对话不能自己决定加人减人 —— 增减角色必须走「执行角色申请 → 编排复核」这条路。'
              : ''),
        )
      }
      if (task.roster === null) return deny('NO_ROSTER', `任务 ${task.id} 还没有角色清单，先做计划分配（需求分析 → 用户确认 → pipeline_plan）。`)

      const req = {
        request_id: `RR-${shortHash(`${task.id}|${task.roster_requests.length}|${input.reason}`)}`,
        at: nowIso(now()),
        by: input.actorRole,
        agent: input.actorAgentId ?? null,
        add: toStringArray(input.add),
        remove: toStringArray(input.remove),
        reason: String(input.reason ?? '').trim(),
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        decision_note: '',
      }
      if (req.reason.length === 0) return deny('BAD_ARGUMENT', '角色变更申请必须给 reason（为什么要加/减人）。')
      if (req.add.length === 0 && req.remove.length === 0) return deny('BAD_ARGUMENT', '角色变更申请至少要给 add 或 remove 中的一项。')

      task.roster_requests.push(req)
      const entry = await audit(task.id, input.actorRole, 'roster:request', { request_id: req.request_id, add: req.add, remove: req.remove, reason: req.reason })
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, request: req, summary: `角色变更申请已登记：${req.request_id}（+[${req.add.join(',')}] -[${req.remove.join(',')}]）。等待编排复核。` }
    },

    /**
     * 计划 AI 复核。★ 只有计划 AI 能做；复核通过后**由复核动作本身**改写角色清单，
     * 主对话没有任何路径能自己改 roster。
     *
     * ★ 本轮改动：从 `orchestrator` 改成 `planner` —— 角色变更复核**就是分配**
     *   （加人减人 = 改角色清单），而分配权本轮随"拆角色"移给了 planner。
     *   需求分析不掌分配权，所以它**不能**再批这类申请。
     */
    async reviewRosterChange(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.PLANNER) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `角色变更复核只能由**计划 AI**（planner）执行，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '理由：加人减人 = 改角色清单 = 分配 —— 那是计划 AI 的职权。\n' +
            (input.actorRole === ROLE.MAIN ? '★ 主对话不能自己批自己的申请，也不能直接改角色清单。' : '') +
            (input.actorRole === ROLE.ORCHESTRATOR
              ? '★ 需求分析**不掌分配权**（本轮改的）：它只负责把需求讲清楚，增减角色要交计划 AI 判。'
              : ''),
        )
      }
      const req = task.roster_requests.find((r) => r.request_id === input.requestId)
      if (req === undefined) return deny('NOT_FOUND', `找不到角色变更申请 ${input.requestId}。`)
      if (req.status !== 'pending') return deny('ALREADY_REVIEWED', `申请 ${input.requestId} 已经复核过了（${req.status}）。`)

      const approve = input.approve === true
      req.reviewed_by = ROLE.PLANNER
      req.reviewed_at = nowIso(now())
      req.decision_note = String(input.note ?? '').trim()

      if (!approve) {
        req.status = 'rejected'
        await persist(task)
        await audit(task.id, ROLE.PLANNER, 'roster:review', { request_id: req.request_id, decision: 'rejected', note: req.decision_note })
        return { ok: true, task, request: req, applied: false, summary: `角色变更申请 ${req.request_id} 被驳回：${req.decision_note || '（未给理由）'}` }
      }

      // 通过 → 直接重建 roster（新增/移除在本任务上累积）。
      const current = task.roster
      const mergedExtra = [...new Set([...current.execution_roles.filter((r) => !['writer', 'tester', 'reviewer'].includes(r)), ...req.add])]
      const mergedRemove = [...new Set([...req.remove])]
      // ★ 设计目的（职责自限）：**中途加人 = 加一张新边界卡**，那是分配的一部分。
      //   把复核时给的新卡与计划原有的卡合并，一起交给 setRoster 的覆盖性核对。
      const existingCards = Array.isArray(task.role_boundaries) ? task.role_boundaries : []
      const newCards = Array.isArray(input.roleBoundaries) ? input.roleBoundaries : []
      const mergedCards = [...existingCards.filter((b) => !newCards.some((n) => String(n?.role) === String(b?.role))), ...newCards]
      const res = await this.setRoster({
        taskId: task.id,
        tier: current.tier,
        reason: `${current.reason}\n[角色变更 ${req.request_id} 由 ${roleLabel(req.by)} 提出、计划 AI 复核通过] ${req.reason}${req.decision_note ? `；复核意见：${req.decision_note}` : ''}`,
        // ★ L0 没有独立的计划 AI（规则引擎档位），那时用不用 plan 闸 —— 跟着原清单走。
        judgedBy: current.judged_by === 'planner' ? 'planner' : 'rule-engine',
        extraRoles: mergedExtra,
        removeRoles: mergedRemove,
        actorRole: ROLE.PLANNER,
        // ★ 席位方案与继任策略要**原样带过去**：这次改的是角色清单，
        //   顺手把它们清掉会让所有席位的范围凭空消失。
        writers: current.writers,
        relayPolicy: current.relay_policy,
        /** ★ 边界卡：复核时给的新卡 + 计划原有的卡。 */
        roleBoundaries: mergedCards,
        acceptance: task.task_card?.acceptance ?? [],
        testPoints: task.task_card?.test_points ?? [],
        boundaries: task.task_card?.boundaries ?? [],
      })
      if (res.ok !== true) {
        // ★ 没改成清单就不算复核过：把申请**退回 pending**。
        //   为什么必须回滚：批准是"清单已改写"这个事实的记账。
        //   记账先行、改写失败，会留下"申请说批了、清单没动"的半截现场 ——
        //   而那个半截现场没有任何路径能修复（申请已经不是 pending，复核会拒）。
        req.status = 'pending'
        req.reviewed_by = null
        req.reviewed_at = null
        await persist(task)
        return deny(
          'ROSTER_APPLY_FAILED',
          `复核批准**没有生效**（角色清单没被改写，申请已退回 pending）：\n${res.error}\n` +
            '下一步：按上面的原因补齐后重新复核（例如给新角色补一张边界卡）。',
        )
      }
      req.status = 'approved'
      await persist(task)
      return {
        ok: true,
        task,
        request: req,
        applied: true,
        roster: task.roster,
        summary: `角色变更申请 ${req.request_id} 已通过，新清单：${task.roster.execution_roles.join(' / ')}（${task.roster.ai_count} 个独立对话）。`,
      }
    },

    // --- ★授权面变更（amendment）：一条**只动授权面**的窄通道 ----------------
    //
    //   要解决的问题（真单现场）：用户已经在需求层裁定"允许把某样东西纳入授权面"，
    //   但 `pipeline_plan` 只在「计划中」交得进计划 —— 任务一进「待开发」，
    //   就变成 **裁定有了、动作做不了**，一个交付单元整轮走不动。
    //
    //   ★ 修法的形状是**另开一条窄门**，不是把「跳步」那道闸整体放宽：
    //     `checkHandoffAgainstState` 里 `plan: [ST.PLANNING]` 一个字都不动 ——
    //     计划仍然只能在计划那一站交。这里新增的能力**够不到计划**：
    //     它不产交接物、不推状态、更碰不到角色清单。
    //
    //   为什么值得开这道门（而不是"让 planner 就地在 ready_dev 重出计划"）：
    //     重出计划会把 `setRoster` 一起带进来 —— 那是**改席位与档位**。
    //     "补一条授权"和"重新分配一次人力"是两件事，混在一起之后，
    //     一个只想扩一条路径的人就顺手拿到了改档位的权力。

    /**
     * ★ **授权面变更（amendment）** —— 追加 / 撤销 `change_scope` 与 `forbidden`。
     *
     * 三条硬判据，缺一不可：
     *   ① 调用方必须是**计划 AI**：授权面是计划的产物，谁定计划谁改授权面；
     *   ② 任务必须在**「待开发」**：授权面要在"计划已定稿、编写还没开工"那一刻改
     *      （再往后改，就是把已经发生过的越界洗成合规）；
     *   ③ 入参**只许**出现授权面字段（白名单，见 `AMEND_ALLOWED_KEYS`）——
     *      席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字都进不来。
     *
     * 全程留痕：`task.amendments[]`（含变更前后）+ `audit.jsonl` 的 `scope:amend`。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.actorRole
     * @param {string} [input.actorAgentId]
     * @param {string} input.why - **为什么非扩它不可**（必填）
     * @param {object[]} [input.add] - 追加的 `change_scope` 条目
     * @param {string[]} [input.remove] - 要撤销的 `change_scope` id
     * @param {string[]} [input.forbiddenAdd] - 追加的越界清单条目
     * @param {string[]} [input.forbiddenRemove] - 撤销的越界清单条目
     * @param {object} [input.raw] - **原始入参**（白名单就查它）
     */
    async amendScope(input) {
      const fail = (code, message) => deny(code, message)
      const task = await loadTask(input.taskId)
      if (task === null) return fail('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      // ---- ① 谁：只有计划 AI。主对话也不行 —— 它既不掌分配权，也不掌授权面。
      if (input.actorRole !== ROLE.PLANNER) {
        return fail(
          'ROLE_NOT_ALLOWED',
          `授权面变更只能由**计划 AI**（planner）执行，当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            '理由：授权面（这次允许改哪些文件、不许做什么）是**计划的产物** —— 谁定计划谁改授权面。\n' +
            (input.actorRole === ROLE.MAIN
              ? '★ 主对话不掌分配权，也不掌授权面：它只能按已经定稿的清单派活。'
              : '★ 如果你（执行角色）是被授权面卡住了：把理由交回计划 AI，由它来改 —— 这条门只能它走。'),
        )
      }

      // ---- ② 何时：只在「待开发」。
      if (task.state !== ST.READY_DEV) {
        return fail(
          'AMEND_STATE_NOT_ALLOWED',
          `授权面变更只在**「待开发」(${ST.READY_DEV})**有效；任务 ${task.id} 当前是「${STATE_LABEL[task.state]}(${task.state})」。\n` +
            '为什么只有这一站：授权面必须在**计划已定稿、编写还没开工**的那一刻改 ——\n' +
            '  · 还在「计划中」⇒ 直接重出计划就行（那一站 `pipeline_plan` 本来就收得下新范围）；\n' +
            '  · 已经「开发中」⇒ 编写可能已经动过手，事后扩授权面等于**把越界洗成合规**；\n' +
            '  · 终态（已通过 / 已关闭 / 已取消）⇒ 本轮已经结束，要改就得开新任务。\n' +
            '★ 这条守卫**只属于这条窄通道** —— 计划那道"跳步"闸（`plan` 只在 planning 收）一个字没松。',
        )
      }

      // ---- ③ 只许动授权面：白名单之外的任何入参字段 ⇒ 当场拒。
      const alien = findNonScopeKeys(input.raw)
      if (alien.length > 0) {
        return fail(
          'AMEND_SCOPE_VIOLATION',
          `授权面变更**只许动授权面**（change_scope / forbidden）—— 但这次入参里带了：${alien.join('、')}。\n` +
            '★ 席位、角色清单、档位、调用顺序、层划分都是**分配**：改它们要重出计划，' +
            '或走 pipeline_roster_request（提出）→ pipeline_roster_review（计划 AI 复核）—— 不是这条门。\n' +
            '★ 为什么这条闸这么硬：这条窄门之所以被允许存在，**恰恰因为它改不了那些东西**。\n' +
            '  一旦它能顺带改清单，它就是一条绕过"计划自检 + 用户确认"的分配后门。',
        )
      }

      // ---- ④ 变更本身要有内容、要有理由。
      const why = typeof input.why === 'string' ? input.why.trim() : ''
      if (why.length === 0) {
        return fail(
          'BAD_ARGUMENT',
          '授权面变更必须给 why —— **为什么非扩它不可**。\n' +
            '★ 这一栏与计划里的 change_scope[].why 是同一面照妖镜："顺手扩一点"写不出理由。',
        )
      }
      const add = Array.isArray(input.add) ? input.add : []
      const remove = toStringArray(input.remove)
      const forbiddenAdd = toStringArray(input.forbiddenAdd)
      const forbiddenRemove = toStringArray(input.forbiddenRemove)
      if (add.length === 0 && remove.length === 0 && forbiddenAdd.length === 0 && forbiddenRemove.length === 0) {
        return fail('BAD_ARGUMENT', '授权面变更至少要动一处：add / remove / forbidden_add / forbidden_remove 四选一（或更多）。')
      }

      // ---- ⑤ 先在**副本**上算合并结果，全部通过才落到 task 上 ----------------
      //   为什么不能在 task 上边算边写：`loadTask` 返回的是**缓存里的同一个对象**。
      //   拒之前写进去的半个改动会留在内存里（而落盘没落）—— 下一次读就是脏的，
      //   而"授权面被改过一半"这种半截现场没有任何路径能修复。
      const currentScope = Array.isArray(task.change_scope) ? task.change_scope : []
      const currentForbidden = toStringArray(task.plan_forbidden)

      const removedMissing = remove.filter((id) => !currentScope.some((e) => String(e?.id ?? '') === id))
      if (removedMissing.length > 0) {
        return fail('SCOPE_ENTRY_NOT_FOUND', `要撤销的授权条目在现有授权面里不存在：${removedMissing.join('、')}。`)
      }
      const mergedScope = currentScope.filter((e) => !remove.includes(String(e?.id ?? '')))
      const seenIds = new Set(mergedScope.map((e) => String(e?.id ?? '')))
      for (const raw of add) {
        const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
        if (id.length > 0) {
          if (seenIds.has(id)) return fail('DUPLICATE_SCOPE_ID', `授权面变更里有重复的 id「${id}」—— 它在现有授权面（或本次新增）里已经存在。`)
          seenIds.add(id)
        }
        mergedScope.push(raw)
      }
      // 合并后必须仍然合法且非空 —— 复用**计划那一份**校验器，不另写一套。
      const scopeErrors = validateChangeScope(mergedScope)
      if (scopeErrors.length > 0) {
        return fail('BAD_SCOPE', `变更后的授权面不合法（校验器与计划里那份是同一个）：\n- ${scopeErrors.join('\n- ')}`)
      }
      const mergedForbidden = [
        ...currentForbidden.filter((x) => !forbiddenRemove.includes(x)),
        ...forbiddenAdd.filter((x) => !currentForbidden.includes(x)),
      ]

      // ---- ⑥ 落盘 + 留痕（task.amendments[] 与 audit.jsonl 两处都要有）-------
      if (!Array.isArray(task.amendments)) task.amendments = []
      const amendment = {
        amendment_id: `AM-${shortHash(`${task.id}|${task.amendments.length}|${why}`)}`,
        at: nowIso(now()),
        by: ROLE.PLANNER,
        agent: input.actorAgentId ?? null,
        why,
        note: typeof input.note === 'string' ? input.note.trim() : '',
        state_at_amend: task.state,
        added: add.map((e) => ({ id: e?.id ?? null, path: e?.path ?? null, action: e?.action ?? null })),
        removed: remove,
        forbidden_added: forbiddenAdd,
        forbidden_removed: forbiddenRemove,
        before: { change_scope: currentScope.map((e) => e?.id ?? null), forbidden: currentForbidden },
        after: { change_scope: mergedScope.map((e) => e?.id ?? null), forbidden: mergedForbidden },
      }
      task.change_scope = mergedScope
      task.plan_forbidden = mergedForbidden
      task.amendments.push(amendment)

      const entry = await audit(task.id, ROLE.PLANNER, 'scope:amend', {
        amendment_id: amendment.amendment_id,
        why,
        added: amendment.added,
        removed: amendment.removed,
        forbidden_added: forbiddenAdd,
        forbidden_removed: forbiddenRemove,
        before: amendment.before,
        after: amendment.after,
        agent: input.actorAgentId ?? null,
      })
      task.history.push(entry)
      await persist(task)

      return {
        ok: true,
        task,
        amendment,
        summary: [
          `授权面已变更：${amendment.amendment_id}（第 ${task.amendments.length} 次，计划 AI，${amendment.at}）`,
          `为什么：${why}`,
          '',
          `授权改动面（change_scope）：${currentScope.length} → ${mergedScope.length} 条`,
          ...(add.length === 0 ? [] : add.map((e) => `  + ${e?.id ?? '?'}　${e?.action ?? '?'}　${e?.path ?? '?'}`)),
          ...(remove.length === 0 ? [] : remove.map((id) => `  − ${id}`)),
          `越界清单（forbidden）：${currentForbidden.length} → ${mergedForbidden.length} 条` +
            (forbiddenAdd.length === 0 ? '' : `\n${forbiddenAdd.map((x) => `  + ${x}`).join('\n')}`) +
            (forbiddenRemove.length === 0 ? '' : `\n${forbiddenRemove.map((x) => `  − ${x}`).join('\n')}`),
          '',
          '★ 这条通道**只动授权面**：席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字没动。',
          '★ 计划那道"跳步"闸也没松 —— plan 交接物仍然只能在「计划中」提交。',
          '★ 留痕：task.json 的 amendments[] + audit.jsonl 的 scope:amend；pipeline_status 可见。',
        ].join('\n'),
      }
    },
  }
}
