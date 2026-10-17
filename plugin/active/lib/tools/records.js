/**
 * dsh-pipeline · 分权落档、联系人、上下文水位、席位继任
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/records
 */

import { ROLE, roleLabel } from '../roles.js'
import { checkSuccessionActor } from '../context.js'
// ★ E5（04 §7.4）：`recall` 的用量在**水位上报**里可见 —— 否则参数调不动（无观测）。
import { lastRecallUsage } from '../memory/budget.js'
import { isSpawnableRole } from '../transport/index.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { taskNotFound } from '../errors/text.js'

/**
 * 分权落档、联系人、上下文水位、席位继任
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildRecordTools(ctx) {
  const { deps, config, store, tokens, transport, indexTask, counter, retireAgent, dispatchSlots } = ctx

  // =========================================================================
  // 23~25. ★分权落档（留档 AI）+ 联系人查询
  // =========================================================================

  const recordSubmit = tool(deps, {
    name: 'pipeline_record_submit',
    mutating: true,
    description:
      '【除留档 AI 外的所有角色】★ 把**自己那份**记录提交给留档 AI（更正 A）。' +
      '落盘在约定位置 `.pipeline/<taskId>/records/<role>[-<seat>].md` + `.json`，**互不覆盖**（谁的记录谁写）。' +
      '提交会**带上你的席位令牌** —— 留档 AI 靠它**校验来路**（谁写的、哪个席位、哪一版），拒绝匿名 / 冒名。' +
      '留档 AI 收集所有记录后统一编写成唯一的需求档 `requirement.md`，每条内容都标来源，可逐条追溯。' +
      '★ 你不能直接写 requirement.md（那是留档 AI 的活）；你只写自己那份记录。',
    parameters: {
      task_id: S('string', '任务 ID'),
      markdown: S('string', '★ 你这份记录的内容（markdown）'),
      sections: S('array', '你负责的小节名（如 ["验收标准","测试要点"]）'),
      source: S('string', '这份记录的依据（如：需求原文 / 与用户确认 / 代码事实）'),
      structured: S('object', '结构化版本（可选）', { additionalProperties: true }),
      role_token: S('string', '★ 你的角色令牌（提交必须带凭据）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      record_id: S('string', '记录 id（供留档 AI 追溯来源）'),
      path: S('string', '落盘的约定路径'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, record_id: '', path: '' }
      if (actor.role === ROLE.ARCHIVIST) {
        return {
          ok: false,
          summary:
            '留档 AI 不需要给自己提交记录 —— 你的活是**汇总**别人的记录（pipeline_compile_requirement）。\n' +
            '★ 如果你对需求有判断，那也应该走 clarify_request / 升级，而不是把自己写进来源里。',
          record_id: '',
          path: '',
        }
      }
      const tok = tokens.roleOfAgent(actor.agentId, String(args.task_id ?? ''))
      const res = await store.submitRecord({
        taskId: String(args.task_id ?? ''),
        role: actor.role,
        seat: actor.seat ?? null,
        markdown: args.markdown,
        sections: args.sections,
        source: args.source,
        structured: args.structured,
        token: tok,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, record_id: '', path: '' }
      indexTask(res.task.id, res.task)
      return { ok: true, summary: res.summary, record_id: res.record.record_id, path: res.record.rel_path }
    },
  })

  const compileRequirement = tool(deps, {
    name: 'pipeline_compile_requirement',
    mutating: true,
    description:
      '【只有留档 AI】★ 把各方记录**汇总**成唯一的需求档 `requirement.md`（+ 结构化 JSON）。' +
      '两条硬规则：① **每条内容必须有来源**（source_record 必须指向一份真实存在的记录）—— 不得凭空写入；' +
      '② **遇到互相矛盾的记录不得自己拍板** —— 报告 conflicts 就会被拒，要求你先走 clarify_request 或升级给用户。' +
      '生成的需求档里每条内容都标了来源（记录 id + 提交者 + 时间），版本与差异由版本索引维护。',
    parameters: {
      task_id: S('string', '任务 ID'),
      entries: S('array', '★ 汇总条目 [{ section, text, source_record }] —— source_record 必填'),
      conflicts: S('array', '★ 你发现的互相矛盾之处 [{ about, between:[记录id] }] —— 非空则拒绝汇总'),
      notes: S('array', '留档说明（可选）'),
      role_token: S('string', '你的角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      version: S('string', '需求档版本（v1/v2…）'),
      sources: S('number', '用到了几份记录'),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, version: '', sources: 0 })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      if (actor.role !== ROLE.ARCHIVIST) {
        return fail(
          `只有留档 AI 能汇总需求档，当前调用方是「${roleLabel(actor.role)}」。\n` +
            '★ 需求档是**分权写 + 专人汇总**出来的：各方在 records/ 下写自己那份，留档 AI 收集后统一编写。\n' +
            '  你要是对需求有补充 → 用 pipeline_record_submit 写**自己那份**记录。',
        )
      }
      const res = await store.compileRequirement({
        taskId: String(args.task_id ?? ''),
        entries: args.entries,
        conflicts: args.conflicts,
        notes: args.notes,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return fail(res.error)
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        summary: res.summary,
        version: res.doc.version,
        sources: new Set((args.entries ?? []).map((e) => e.source_record)).size,
      }
    },
  })

  const contacts = tool(deps, {
    name: 'pipeline_contacts',
    mutating: false,
    description:
      '【任何角色】★ 查**当前联系人**：现在谁是指派者（**计划 AI / 分配 AI**）、谁在哪个席位、谁已经退场。' +
      '为什么必须能查：计划 AI 自己也会继任 —— 查不到「当前分配 AI 是谁」，上报就会发给一个**已经退场的席位**，' +
      '那条消息永远不会有人看。所以每个席位在行动前都该先确认联系人。' +
      '（继任发生时插件会**广播**新联系人给所有已绑定席位；这里是事后再确认的地方。）' +
      '⚠️ 历史沿革：分配权本轮从需求分析（orchestrator）移给了计划 AI（planner），' +
      '所以 `orchestrator_agent` / `orchestrator_seat` 这两个**旧字段名**保留为别名（值与 planner_* 相同），新代码请用 planner_*。',
    parameters: {
      task_id: S('string', '任务 ID'),
      role_token: S('string', '角色令牌（可选；给了就用你的身份看）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      planner_agent: S('string', '★ 当前计划 AI（分配 AI）的会话 id（上报要发给他）'),
      planner_seat: S('string', '当前计划席位标识'),
      orchestrator_agent: S('string', '（别名，同 planner_agent；旧字段名保留兼容）'),
      orchestrator_seat: S('string', '（别名，同 planner_seat）'),
      retired: S('number', '已退场的会话数'),
    },
    async run(args) {
      const fail = (msg) => ({ ok: false, summary: msg, planner_agent: '', planner_seat: '', orchestrator_agent: '', orchestrator_seat: '', retired: 0 })
      const task = await store.get(String(args.task_id ?? ''))
      if (task === null) return fail(taskNotFound(String(args.task_id ?? '')))
      // ★ 兼容读：旧任务文件里这个键叫 `orchestrator`。
      const cur = task.contacts?.planner ?? task.contacts?.orchestrator ?? null
      const tok = cur === null ? null : tokens.findSeat(task.id, ROLE.PLANNER, null)
      const lines = []
      lines.push(`当前联系人 · 任务 ${task.id}`)
      lines.push('')
      lines.push(cur === null
        ? '★ 计划 AI（分配 AI）联系人：**未登记**（还没有计划席位建起来）'
        : `★ 计划 AI（分配 AI）：${cur.agent_id ?? '(未建会话)'}　第 ${cur.generation ?? 1} 代　（${cur.seat ?? 'planner'}）`)
      if (tok !== null && tok !== undefined) lines.push(`  令牌可查：${tok.agentId ?? '(未绑定)'}`)
      lines.push('')
      lines.push('各席位当前占位：')
      for (const t2 of tokens.list().filter((x) => x.taskId === task.id)) {
        lines.push(`  · ${t2.role}${t2.seat ? ` / ${t2.seat}` : ''} → ${t2.agentId ?? '(未绑定)'}`)
      }
      const retiredCount = (task.successions ?? []).reduce((a, s) => a + (s.from_agent ? 1 : 0), 0)
      lines.push('')
      lines.push(`已退场（继任换掉的旧会话）：${retiredCount} 个`)
      for (const s of (task.successions ?? [])) {
        lines.push(`  · ${s.seat}　第 ${s.generation} 代：${s.from_agent ?? '(无)'} → ${s.to_agent ?? '(无)'}　依据：${s.reason ?? ''}`)
      }
      lines.push('')
      lines.push('★ 行动前先确认联系人 —— 发给已退场的席位等于发进黑洞。')
      return {
        ok: true,
        summary: lines.join('\n'),
        planner_agent: cur?.agent_id ?? '',
        planner_seat: cur?.seat ?? '',
        // ★ 旧字段名保留兼容（历史任务与既有调用方都在用）
        orchestrator_agent: cur?.agent_id ?? '',
        orchestrator_seat: cur?.seat ?? '',
        retired: retiredCount,
      }
    },
  })

  // =========================================================================
  // 21~22. ★上下文水位与席位继任
  // =========================================================================

  const contextReport = tool(deps, {
    name: 'pipeline_context_report',
    mutating: true,
    description:
      '【任何角色】上报自己的**上下文水位**（百分比 + 依据）★。' +
      'DSH 目前**没有**面向插件的上下文用量接口（源码：dsh-agent-loop:460-462 的 usage getter 在流装配器内部，' +
      ':1250 的 contextWindow 只给"窗口多大"），所以水位只能由席位**自报** —— ' +
      '既然是自己说的，就**必须给依据**（已读文件数 / 轮次 / 上下文里压了几份大报告）。' +
      '到达触发线（默认 55%）时必须上报给分配 AI（主对话）：先产出一份 seat_handover 交接物，' +
      '再让主对话执行 pipeline_succession 换班。到达硬限（默认 75%）后不允许再领新活，只允许交接与收尾。' +
      '返回里会附上**插件侧客观观测**（本席位调用过多少次工具、活跃多久），可与自报互相印证。',
    parameters: {
      task_id: S('string', '任务 ID'),
      percent: S('number', '★ 上下文水位百分比 0~100'),
      basis: S('string', '★ 依据（为什么是这个数）—— 必填，不能只写"我觉得"'),
      requested_succession: S('boolean', '是否请求继任（换班）'),
      to_planner_agent: S('string', '★ 你要发给的**计划 AI**会话 id（可选；给了就核对是不是当前联系人，防止发给已退场的分配 AI）'),
      to_orchestrator_agent: S('string', '（旧字段名，等价于 to_planner_agent；两个都给时以 to_planner_agent 为准）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      report_id: S('string', '上报 id'),
      level: S('string', '档位：ok / warn / succession / hard_limit'),
      observed_tool_calls: S('number', '插件观测到的本席位工具调用次数'),
      recall_usage: S('string', '★ E5：本进程**最近一次** `pipeline_recall` 的用量（上限 / 实付 / 条数 / 是否被水位下调）；还没跑过 ⇒ 一句人话'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      /**
       * ★ E5（`04` §7.4）：本进程**最近一次** `pipeline_recall` 的用量 —— 一行人话。
       * 无观测就调不动参数（"上限设多少合适"只能靠猜），所以每次水位上报都捎上它。
       */
      const recallUsage = () => {
        const u = lastRecallUsage()
        if (u === null) return '（本进程还没有 recall 记录）'
        return `最近一次 recall：上限 ${u.limit} / 实付 ${u.tokens} token，返回 ${u.count} 条${u.reduced_by.length > 0 ? `（★ 被 ${u.reduced_by} 下调过）` : ''}`
      }
      if (actor.ok !== true) return { ok: false, summary: actor.error, report_id: '', level: '', observed_tool_calls: 0, recall_usage: recallUsage() }
      // ★ 客观观测：本席位在插件眼里调用过多少次工具（不是模型说的）
      // ★ 更正 B（本轮改名）：先校验收件人 —— 发给**已退场的分配 AI**等于发进黑洞。
      const wantTo = typeof args.to_planner_agent === 'string' && args.to_planner_agent.trim().length > 0
        ? args.to_planner_agent.trim()
        : typeof args.to_orchestrator_agent === 'string' ? args.to_orchestrator_agent.trim() : ''
      if (wantTo.length > 0) {
        const cur0 = await store.get(String(args.task_id ?? ''))
        const cur = cur0?.contacts?.planner ?? cur0?.contacts?.orchestrator ?? null
        if (cur === null || cur.agent_id !== wantTo) {
          const lines0 = [
            `拒绝：你要发给的分配 AI ${wantTo} **不是当前联系人**。`,
            '',
            cur === null
              ? '  当前：**还没有登记分配 AI 联系人**（可能还没建计划席位）。'
              : `  当前：${cur.agent_id ?? '(未建会话)'}（第 ${cur.generation ?? 1} 代，自 ${cur.since ?? '?'} 起）`,
            `  你要发的：${wantTo}`,
            '',
            '★ 计划 AI 自己也会继任 —— 发给一个已经退场的席位，那条消息永远不会有人看。',
            '  先用 pipeline_contacts 查「当前分配 AI 是谁」，再发。',
          ].join('\n')
          return { ok: false, summary: lines0, report_id: '', level: '', observed_tool_calls: 0, recall_usage: recallUsage() }
        }
      }

      const observed = counter.snapshot(actor.agentId)
      const res = await store.reportContext({
        taskId: String(args.task_id ?? ''),
        role: actor.role,
        seat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        percent: args.percent,
        basis: args.basis,
        requestedSuccession: args.requested_succession === true,
        observed,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, report_id: '', level: '', observed_tool_calls: observed.tool_calls, recall_usage: recallUsage() }
      indexTask(res.task.id, res.task)

      // ★ 更正 C（本轮改名）：到触发线时**通知分配 AI（= 计划 AI）**，而不是通知主对话 ——
      //   分配是计划 AI 的职权，主对话只跟踪状态。
      let notifyNote = ''
      if (res.report.level === 'succession' || res.report.level === 'hard_limit') {
        const orch = tokens.findSeat(res.task.id, ROLE.PLANNER, null)
        if (orch === null || orch === undefined || typeof orch.agentId !== 'string' || orch.agentId.length === 0) {
          notifyNote = '\n\n⚠ 没能通知分配 AI（计划 AI，找不到它的会话）—— 请主对话用 pipeline_status 看到这条上报后转达计划 AI。'
        } else {
          const sent = await transport.notifyRole({
            sender: exec.agent,
            agentId: orch.agentId,
            message: [
              `【水位上报】${actor.role}${actor.seat ? `（${actor.seat}）` : ''} 到了 ${res.report.percent}%（${res.report.level}）。`,
              `依据：${res.report.basis}`,
              `插件侧客观观测：工具调用 ${observed.tool_calls} 次，活跃 ${observed.active_minutes} 分钟。`,
              '',
              '★ 你是**分配 AI（计划 AI）**：请决定是否追加 / 指派继任者，并更新席位清单。',
              `  上报 id：${res.report.report_id}`,
              '  流程：① 先让该席位产出 seat_handover 交接物（含 must_read_files / key_decisions / open_questions / do_not_repeat）；② 你调 pipeline_succession 指派继任者。',
            ].join('\n'),
          })
          notifyNote = sent.ok === true
            ? `\n\n✅ 已通知**分配 AI（计划 AI）**：${orch.agentId}`
            : `\n\n⚠ 通知分配 AI（计划 AI）失败：${sent.note}`
        }
      }
      return {
        ok: true,
        summary: res.summary + notifyNote + `\n\n★ 取回用量观测：${recallUsage()}`,
        report_id: res.report.report_id,
        level: res.report.level,
        observed_tool_calls: observed.tool_calls,
        recall_usage: recallUsage(),
      }    },
  })

  const succession = tool(deps, {
    name: 'pipeline_succession',
    mutating: true,
    description:
      '【只有主对话】★ 执行一次**席位继任**（换班，**不是**改角色）：同一个角色的席位换一个人接着干。' +
      '角色清单不变、任务状态不变 —— 所以它不违反"主对话不得自行增减角色"，' +
      '但它**只能在编排给的 relayPolicy 授权内**执行（档位是否启用、角色是否在白名单、次数有没有用尽）。' +
      '前置三条缺一不可：① 授权内；② 该席位**上报过水位**且达到触发线；' +
      '③ 该席位产出过合法的 seat_handover（含 must_read_files 与 open_questions）。' +
      '执行后：新会话拿到新令牌接管同一席位，**旧令牌立即失效**（旧席位不得再写），继任关系记为 succeeds。',
    parameters: {
      task_id: S('string', '任务 ID'),
      seat: S('string', '要换班的 roster 席位 id（非编写角色可直接给角色名）'),
      role: S('string', '该席位的角色'),
      spawn: S('boolean', '是否真的建新会话（默认跟配置）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      succession_id: S('string', '继任记录 id'),
      agent_id: S('string', '新席位会话 id'),
      token: S('string', '新席位令牌'),
      retired_agent: S('string', '已退休的旧会话 id'),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, succession_id: '', agent_id: '', token: '', retired_agent: '' })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      // ★ 更正 C：**分配 AI = 编排 AI**。
      //   编排随时可以给任何席位换班（追加/指派继任者本来就是它的本职）；
      //   主对话只在"给**编排席位自己**换班"时兜底（指派者不能是自己）。
      const who = checkSuccessionActor({ actorRole: actor.role, role: String(args.role ?? '') })
      if (who.ok !== true) return fail(who.error)
      const taskId = String(args.task_id ?? '')
      const role = String(args.role ?? '')
      const seat = String(args.seat ?? '')
      // ★ 席位 key：只有编写角色有 roster 席位（writer#1…）；其它角色的令牌里 seat 是 null。
      const seatKey = role === ROLE.WRITER && seat.length > 0 ? seat : ''
      if (taskId.length === 0 || role.length === 0) return fail('必须给 task_id 与 role。')

      // 第一步：只校验（授权 / 水位 / 交接物），一个字节都不改
      const plan = await store.planSuccession({ taskId, seat: seatKey || role, role })
      if (plan.ok !== true) return fail(plan.error)
      const { task, lastReport, handover } = plan

      // 第二步：建新会话（走 transport，与派活同一条路）
      const oldTok = tokens.findSeat(taskId, role, seatKey.length > 0 ? seatKey : null)
      const succSeat = seatKey.length > 0 ? seatKey : null
      const spec = {
        task,
        roster: task.roster,
        role,
        seat: succSeat,
        // ★ 四槽跟着**席位**走：继任换的是人，不是档。不带上四槽，换班之后
        //   这个席位会掉回最小档（编写席随即写不了盘）—— 与派活端同一套取值口径。
        ...dispatchSlots(task, role, succSeat, args),
      }
      const spawn = args.spawn === undefined ? config.spawnRoles !== false : args.spawn === true
      const res = spawn && isSpawnableRole(role)
        ? await transport.spawnRole({ ...spec, parent: exec.agent, signal: exec.signal })
        : await transport.spawnRole({ ...spec, agentId: null })
      if (res.ok !== true) return fail(res.note)

      // 第三步：★ 撤旧令牌 —— 旧席位从此不得再写
      if (oldTok !== null && oldTok !== undefined) tokens.revoke(oldTok.token)

      // 第四步：落记录
      const committed = await store.commitSuccession({
        taskId,
        seat: seatKey || role,
        role,
        fromAgent: oldTok?.agentId ?? null,
        toAgent: res.agentId ?? null,
        handoffId: handover.handoff_id,
        reason: `水位 ${lastReport.percent}%：${lastReport.basis}`,
      })
      if (committed.ok !== true) return fail(committed.error)
      indexTask(taskId, committed.task)
      // ★ 把旧会话登记为"已退休"：守门靠它拦住旧席位的后续写入
      //   （只撤令牌不够 —— 令牌没了之后 roleOfAgent 找不到绑定，守门会当成"无关会话"放行）
      if (typeof oldTok?.agentId === 'string' && oldTok.agentId.length > 0) retireAgent(oldTok.agentId, taskId)

      const s = committed.succession

      // ★ 更正 B：**广播新联系人**给所有已绑定席位。
      //   理由：编排换人了，各席位如果还往旧编排发上报，那些消息永远没人看。
      const broadcast = { sent: [], failed: [], note: '' }
      if (s.role === ROLE.PLANNER) {
        const targets = tokens.list().filter((x) => x.taskId === taskId && x.agentId && x.agentId !== res.agentId)
        const text = [
          `【联系人变更】任务 ${taskId} 的**分配 AI（计划 AI）**已换人。`,
          '',
          `  旧：${s.from_agent ?? '(无)'}（已退场，令牌已撤销，**不要再发给他**）`,
          `  新：${s.to_agent ?? '(manual 通道)'}　第 ${s.generation} 代`,
          `  依据：${s.reason}`,
          '',
          '★ 后续的**水位上报 / 澄清请求 / 任何需要分配裁决的事**，都发给**新的计划 AI**。',
          '  不确定当前联系人是谁 → 调 pipeline_contacts 查一下。',
        ].join('\n')
        for (const x of targets) {
          const r = await transport.notifyRole({ sender: exec.agent, agentId: x.agentId, message: text })
          if (r.ok === true) broadcast.sent.push(`${x.role}${x.seat ? ` / ${x.seat}` : ''}`)
          else broadcast.failed.push(`${x.role}${x.seat ? ` / ${x.seat}` : ''}（${r.note}）`)
        }
        broadcast.note =
          broadcast.sent.length === 0 && broadcast.failed.length === 0
            ? '（当前没有其它已绑定席位，无需广播）'
            : `已广播给 ${broadcast.sent.length} 个席位${broadcast.failed.length > 0 ? `，${broadcast.failed.length} 个失败` : ''}`
      }

      const lines = [
        `席位继任完成：${s.succession_id}`,
        `席位：${s.seat}（${s.role}）　第 ${s.generation} 代`,
        '',
        `依据：水位 ${lastReport.percent}%（${lastReport.level}）—— ${lastReport.basis}`,
        `交接物：${handover.handoff_id}`,
        `旧会话：${oldTok?.agentId ?? '(无)'}（令牌已撤销 + 已登记退休，**不得再写**）`,
        `新会话：${res.agentId ?? '(manual 通道)'}`,
        `新令牌：${res.token}`,
        '',
        '★ 任务状态**没有变** —— 继任是换班，不是重开（制品版本、打回计数、审计都连续）。',
        ...(s.role === ROLE.PLANNER ? ['', `★ 新联系人广播：${broadcast.note}`] : []),
        '新席位第一步：读交接物里的 must_read_files（至少含需求档），然后按 next_step 继续。',
      ]
      return {
        ok: true,
        summary: lines.join('\n'),
        succession_id: s.succession_id,
        agent_id: res.agentId ?? '',
        token: res.token ?? '',
        retired_agent: oldTok?.agentId ?? '',
      }
    },
  })

  return { recordSubmit, compileRequirement, contacts, contextReport, succession }
}
