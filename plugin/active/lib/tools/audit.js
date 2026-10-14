/**
 * dsh-pipeline · 改动审计、边界清单、全量测试进度
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/audit
 */

import { ROLE, roleLabel } from '../roles.js'
import { boundaryManifest, renderBoundaryManifest } from '../boundaries.js'
import { fullTestCredential, nextFullTestStage } from '../testscope.js'
import { describeStage, S, SNullable, tool, resolveActor } from './kit.js'

/**
 * 改动审计、边界清单、全量测试进度
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildAuditTools(ctx) {
  const { deps, store, indexTask, pipelineToolFace, load, paginate } = ctx

  // =========================================================================
  // 2.6 pipeline_change_audit —— 前后版本对比（基线 → 当前）
  // =========================================================================
  //
  // ★ 用户要求：「审核 ai 确认没有干不该干的事（**前后版本对比**）」。
  //   审核**不读代码**（那条边界还在），所以"对比"不能靠眼睛 —— 靠**哈希**：
  //   派活那一刻记了基线（文件清单 + 每个文件的 sha256），这里按基线逐文件比。
  //
  // 产出三类结论（用户点名要的）：
  //   · **多改**：清单外的文件被改 / 被新增（`unauthorized`）
  //   · **少改**：授权了却没动（`missing`）
  //   · **改错地方**：动的不是授权的那份（同样进 `unauthorized`，带 `how`）
  const changeAuditTool = tool(deps, {
    name: 'pipeline_change_audit',
    mutating: false,
    description:
      '【任何角色】★ **前后版本对比**：拿「改动基线」（派活那一刻记录的项目文件清单 + 哈希）' +
      '与当前状态逐文件比，产出「实际改动面 vs 授权面」的对照结论 —— ' +
      '**多改 / 少改 / 改错地方**三类都报出来。' +
      '★ 判据是**哈希比对**，不是"看代码"：所以审核可以在不读代码的前提下拿到判据式证据。' +
      '审核提交 review_verdict 时要把这份结论填进 change_audit（有基线时必填，且 store 会复核）。' +
      'take=true 可以**重新记录基线**（只有计划 AI / 主对话能调，会留痕）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      take: S('boolean', '★ 重新记录基线（把**当前**状态当成新的对比基准）。只有计划 AI / 主对话能调'),
      note: S('string', '重取基线时的说明（take=true 时建议给：为什么要重新基准）'),
      /**
       * ★★ **E 路 ②**：这份对比的正文大头是"逐文件明细"（几百个文件就是几万字节），
       *   而审核真正要的结论 + 多改/少改清单只占一小段 —— 所以给它一个紧凑档。
       *   ★ 不传 = 与改前**逐字节相同**。
       */
      detail: S('string', '★ 输出档（**不传 = 与改前逐字节相同**）：summary = 结论 + 多改/少改 + 算好的计数（明细分页）｜count = 只回结论与计数｜full = 现状全文', { enum: ['summary', 'count', 'full'] }),
      fields: S('array', '★ 只回**点名的字段**（投影）：如 ["verdict","unauthorized","missing"]；`ok` 永远保留。不传 = 回人读摘要', { items: { type: 'string' } }),
      page: S('number', '★ 逐文件明细分段取（1 起，每段 20 条；不传 = 不分页，与改前一致）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（三类结论 + 逐条路径）'),
      verdict: S('string', '★ 对照结论：within_scope（全在授权面内）/ out_of_scope（有多改）'),
      baseline_id: S('string', '用的是哪一版基线'),
      unauthorized: S('array', '★ 多改 / 改错地方：清单外的改动 [{ path, how }]', { items: { type: 'object', additionalProperties: true } }),
      missing: S('array', '★ 少改：授权了却没动的条目 [{ scope_id, path }]', { items: { type: 'object', additionalProperties: true } }),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, verdict: '', baseline_id: '', unauthorized: [], missing: [] })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return fail(`找不到任务 ${args.task_id}。`)

      // --- take：重新记录基线（权限收在白名单里）---
      if (args.take === true) {
        if (actor.role !== ROLE.PLANNER && actor.role !== ROLE.MAIN) {
          return fail(
            `拒绝重取基线：只有**计划 AI**（或主对话兜底）能重新记录改动基准，当前角色是「${roleLabel(actor.role)}」。\n` +
              '★ 基线是"没动手之前的样子" —— 谁能重设它，谁就能把已经改过的东西洗成"本来就这样"。',
          )
        }
        const bl = await store.takeBaseline({
          taskId: task.id,
          by: actor.role,
          planHandoffId: task.plan_handoff_id ?? null,
          note: typeof args.note === 'string' ? args.note : '手工重取',
        })
        if (bl.ok !== true) return fail(bl.error)
        indexTask(bl.task.id, bl.task)
        return {
          ok: true,
          verdict: '',
          baseline_id: bl.baseline.baseline_id,
          unauthorized: [],
          missing: [],
          summary:
            `已重新记录改动基线：${bl.baseline.baseline_id}\n` +
            `  ${bl.baseline.file_count} 个文件，清单指纹 ${bl.baseline.digest.slice(0, 16)}…（${bl.baseline.taken_at}）\n` +
            '★ 从此往后的改动都按这一版基线比。重取会留痕（audit: baseline:take）。',
        }
      }

      const res = await store.changeAudit({ taskId: task.id })
      if (res.ok !== true) return fail(res.error)

      /**
       * ★★ **E 路 ②：紧凑档**（`detail: "summary" | "count"`）。
       *
       * ★ 省掉的是**逐文件明细**（几百个文件就是几万字节），
       *   **不省**结论、多改/少改清单、以及那行可以直接填进 `review_verdict` 的
       *   `change_audit` —— 少一样都会让审核干不了活。
       * ★ 明细分页：`summary` 默认给第一段（20 条）并写明续页口径；
       *   要全量明细就 `detail="full"`（= 改前行为）。
       * ★ 不传 `detail` / 传 `"full"` ⇒ **原路，逐字节不变**。
       */
      const cBrief = typeof args.detail === 'string' ? String(args.detail) : ''
      const cDetailRows = [
        ...res.added.map((x) => `  + ${x.path}`),
        ...res.modified.map((x) => `  ~ ${x.path}`),
        ...res.removed.map((x) => `  - ${x.path}`),
      ]
      if (cBrief === 'count' || cBrief === 'summary') {
        const cL = [
          `前后版本对比 · 任务 ${task.id}`,
          `基线：${res.baseline.baseline_id}（${res.baseline.file_count} 个文件，记于 ${res.baseline.taken_at}，由 ${res.baseline.taken_by} 记录）`,
          `结论：**${res.verdict === 'within_scope' ? '全在授权面内 ✓' : '有多改 ✗'}**　` +
            `新增 ${res.counts.added} · 修改 ${res.counts.modified} · 删除 ${res.counts.removed}　` +
            `多改/改错地方 ${res.counts.unauthorized} · 少改（授权了没动）${res.counts.missing}　` +
            `（合计 ${cDetailRows.length} 个文件有出入）`,
        ]
        if (cBrief === 'summary') {
          cL.push(
            res.unauthorized.length > 0
              ? `★ **多改 / 改错地方**（清单外的改动）：\n${res.unauthorized.map((x) => `  · ${x.how}：${x.path}`).join('\n')}`
              : '★ 多改：**没有**（实际改动面全在授权面内）。',
            res.missing.length > 0
              ? `⚠ **少改**（计划授权了、但一个都没动）：\n${res.missing.map((x) => `  · ${x.scope_id} ${x.path}`).join('\n')}`
              : '少改：没有。',
          )
          /**
           * ★ 逐文件明细**本档不展开**（它是正文大头，而且与上面那两份清单**大量重复**）：
           *   要看得显式给 `page`（那时才真分页），或一次看全 `detail="full"`。
           *   ★ 但**必须**告诉它"有多少条、怎么取" —— 少了这句，调用方只能重跑一遍。
           */
          if (cDetailRows.length === 0) {
            cL.push('', '明细：（一个文件都没动）')
          } else if (args.page !== undefined && args.page !== null) {
            const cp = paginate(cDetailRows, args.page)
            cL.push('', `明细（本段 ${cp.page}/${cp.pages}，共 ${cp.total} 条）：`, ...cp.slice)
            if (cp.more) cL.push(`  …（下一段：\`pipeline_change_audit { task_id: "${task.id}", detail: "summary", page: ${cp.page + 1} }\`；或一次看全：detail="full"）`)
          } else {
            cL.push(
              '',
              `明细：共 ${cDetailRows.length} 条（含授权面内的改动）—— 本档不展开；` +
                `要看得 \`page: 1\`（每段 20 条），或一次看全 \`detail="full"\`。`,
            )
          }
        }
        cL.push(
          '',
          '★ 这份结论要填进 review_verdict.change_audit（有基线时必填；store 会自己再算一遍核对）。',
          '  change_audit = { baseline_id: "' + res.baseline.baseline_id + '", verdict: "' + res.verdict + '", unauthorized: ' + JSON.stringify(res.unauthorized) + ', missing: ' + JSON.stringify(res.missing) + ' }',
          `★ 本段是**紧凑档**（${cBrief}）：要全文用 \`detail="full"\`；只要某几个字段用 \`fields=[…]\`。`,
        )
        return {
          ok: true,
          summary: cL.join('\n'),
          verdict: res.verdict,
          baseline_id: res.baseline.baseline_id,
          unauthorized: res.unauthorized,
          missing: res.missing,
        }
      }
      /** ★ 显式给了 `page` 才分页（不传 ⇒ 逐字节不变）。 */
      const cPage = args.page === undefined || args.page === null ? null : paginate(cDetailRows, args.page)
      const lines = [
        `前后版本对比 · 任务 ${task.id}`,
        `基线：${res.baseline.baseline_id}（${res.baseline.file_count} 个文件，记于 ${res.baseline.taken_at}，由 ${res.baseline.taken_by} 记录）`,
        `结论：**${res.verdict === 'within_scope' ? '全在授权面内 ✓' : '有多改 ✗'}**`,
        '',
        `新增 ${res.counts.added} · 修改 ${res.counts.modified} · 删除 ${res.counts.removed}　` +
          `多改/改错地方 ${res.counts.unauthorized} · 少改（授权了没动）${res.counts.missing}`,
        '',
        res.unauthorized.length > 0
          ? `★ **多改 / 改错地方**（清单外的改动）：\n${res.unauthorized.map((x) => `  · ${x.how}：${x.path}`).join('\n')}`
          : '★ 多改：**没有**（实际改动面全在授权面内）。',
        res.missing.length > 0
          ? `⚠ **少改**（计划授权了、但一个都没动）：\n${res.missing.map((x) => `  · ${x.scope_id} ${x.path}`).join('\n')}`
          : '少改：没有。',
        '',
        '明细：',
        ...(cPage === null ? cDetailRows : cPage.slice),
        ...(cDetailRows.length === 0 ? ['  （一个文件都没动）'] : []),
        // ★ E 路 ②：显式分页时**必须**给出续页口径（截断了却不说"还有多少"，等于让模型重跑一遍）。
        //   ★ 这里用**展开**而不是 `? '' :`：本工具的 summary 走的是 `lines.join('\n')`
        //     （**不过滤空串**），多塞一个 `''` 就会让"不传 page"的输出多一个空行 ——
        //     那正是"默认逐字节不变"要挡住的（本项目实测踩过一次）。
        ...(cPage === null || !cPage.more
          ? []
          : [`  …（明细本段 ${cPage.page}/${cPage.pages}，共 ${cPage.total} 条；下一段：\`pipeline_change_audit { task_id: "${task.id}", page: ${cPage.page + 1} }\`）`]),
        '',
        '★ 这份结论要填进 review_verdict.change_audit（有基线时必填；store 会自己再算一遍核对）。',
        '  change_audit = { baseline_id: "' + res.baseline.baseline_id + '", verdict: "' + res.verdict + '", unauthorized: ' + JSON.stringify(res.unauthorized) + ', missing: ' + JSON.stringify(res.missing) + ' }',
      ]
      return {
        ok: true,
        summary: lines.join('\n'),
        verdict: res.verdict,
        baseline_id: res.baseline.baseline_id,
        unauthorized: res.unauthorized,
        missing: res.missing,
      }
    },
  })

  // =========================================================================
  // 2.7 pipeline_boundaries —— ★ 机器可读的边界清单（给别的执法层复用）
  // =========================================================================
  //
  // ★ 用户要求：「把本项目"谁、什么边界、什么判据"导出成一份**机器可读的边界清单**
  //   （例如一个 JSON 或一个只读子命令），供**那层钩子**复用 ——
  //   不要为了这个改坏既有结构」。
  //
  // 所以它：只读、不依赖任务、不需要身份；数据由 `lib/boundaries.js`
  // 从**真实常量**（roles / guard / handoff / states）派生，不手抄。
  const boundariesTool = tool(deps, {
    name: 'pipeline_boundaries',
    mutating: false,
    description:
      '【任何角色 · 只读】★ 导出**机器可读的边界清单**：每个角色的写权限（含"只读 / 只写自己那一片"）、' +
      '六条设计目的的**判据落点**（函数名）、交接物方向表、状态迁移表，' +
      '以及一份"**判据化不了的**自然语言约束"诚实清单（别假装它被执法了）。' +
      '数据从插件里的真实常量派生（不手抄），并会做一次**漂移检查**：' +
      '角色表里的 writes 取值若守门认不出，会出现在 unmapped 里。' +
      '★ 另含 **E 路 ③ 的工具面**（`tool_face`）：**某角色可见哪些 pipeline_* 工具**、' +
      '哪些被隐藏、判词出处 —— 白名单**从守门判词里读**（`guardDecision` 对匿名调用方的原话），' +
      '不手抄第二份；认不出就**不收紧**（宁可少省字节，也不藏掉角色需要的工具）。' +
      '用途：DSH 层的 UserPromptSubmit / PreToolUse 钩子不需要读本插件源码，读这份 JSON 就够。' +
      'format=json 返回纯 JSON（给程序吃），默认返回人读摘要。',
    parameters: {
      format: S('string', "输出格式：'text'（默认，给人看）/ 'json'（给程序吃）"),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '边界清单（text 为摘要，json 为完整 JSON 文本）'),
      manifest: S('object', '★ 结构化清单（钩子层直接取这个字段）', { additionalProperties: true }),
    },
    async run(args) {
      // ★ E 路 ③：工具面**现算**（工具名到这里已经全了 —— `run()` 是调用期才跑）。
      const m = boundaryManifest({ toolFace: () => pipelineToolFace() })
      const asJson = String(args.format ?? '') === 'json'
      return {
        ok: true,
        summary: asJson ? JSON.stringify(m, null, 2) : renderBoundaryManifest(m),
        manifest: m,
      }
    },
  })

  // =========================================================================
  // 2.8 pipeline_full_test —— ★ 全量测试审批链的进度（只读）
  // =========================================================================
  //
  //   ★ 用户要求这条链"和既有的两级梯合流"：
  //     · 四级里的**人工那一站**用的就是既有的 human_request / human_reply；
  //     · 另外三站是 full_test_request / full_test_review 两种交接物（走 pipeline_handoff）。
  //   这个工具只做一件事：**把链的进度与"还差谁点头"摊开**（只读，谁都能查）。
  //
  //   为什么需要它：守门拦下全量命令时只会给一句"走审批链"，
  //   而"现在走到哪一站了、还差谁"必须能被一眼看到 —— 否则这条链就成了黑箱。
  const fullTestTool = tool(deps, {
    name: 'pipeline_full_test',
    mutating: false,
    description:
      '【任何角色 · 只读】★ 查**全量测试审批链**的进度：这条链回答的是「**这套测试值不值得跑**」' +
      '（成本决策）—— 与澄清梯回答的「需求清不清楚」不是同一个问题。' +
      '四级：tester 提申请 → 需求分析 need → 审核 worth → 用户人工 → 计划 arrange。' +
      '缺一级都不许开跑；任一站否决就停住（留痕）。' +
      '本工具不改任何东西：申请/裁定走 pipeline_handoff，人工那站走 pipeline_human_request。',
    parameters: {
      task_id: S('string', '任务 ID'),
      role_token: S('string', '角色令牌（查询也建议带上）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '可直接阅读的审批链进度'),
      status: S('string', 'pending | rejected | approved | none'),
      next_stage: S('string', '还差谁点头'),
      credential: SNullable('object', '★ 当前可用的放行凭据（没有则为 null）', { additionalProperties: true }),
    },
    async run(args, exec) {
      void exec
      const empty = { ok: false, status: 'none', next_stage: '', credential: null }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ...empty, summary: `找不到任务 ${args.task_id}。` }
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const cred = store.currentBaseline === undefined ? null : null
      void cred
      if (list.length === 0) {
        return {
          ok: true,
          status: 'none',
          next_stage: 'tester-request',
          credential: null,
          summary:
            `任务 ${task.id} 还没有任何全量测试申请。\n` +
            '★ 默认就应该是这样：**测试只跑定向/增量**（按改动面挑相关用例）。\n' +
            '  真要跑全量，由 tester 交 pipeline_handoff kind=full_test_request 起链。',
        }
      }
      const c = list[list.length - 1]
      const stage = nextFullTestStage(c)
      const mark = (rec, name) =>
        rec === null
          ? `  · ${name}：**未做**`
          : `  · ${name}：${rec.ok === false ? '**否决**' : '同意'}${rec.at ? `（${rec.at}）` : ''} —— ${String(rec.reason ?? '').slice(0, 80)}`
      const lines = [
        `全量测试审批链 · 任务 ${task.id}（第 ${c.round} 次申请）`,
        `申请：${c.approval_id}（${c.created_at} 由 ${roleLabel(c.created_by)} 提出）`,
        `打算跑：${c.request.what_will_run}`,
        `本次改动面：${(c.request.affected_paths ?? []).join('、') || '(未填)'}`,
        `为什么定向不够：${c.request.why_targeted_insufficient}`,
        '',
        `当前状态：**${c.status === 'approved' ? '已批准 ✓' : c.status === 'rejected' ? `已否决 ✗（停在 ${c.rejected_at_stage} 站）` : '在办'}**`,
        `下一站：${describeStage(stage)}`,
        '',
        mark(c.need, '① 需求分析（这次是否需要）'),
        mark(c.worth, '② 审核（值不值得）'),
        c.human === null
          ? '  · ③ 用户人工：**未发起**（主对话用 pipeline_human_request reason_kind=full_test_approval）'
          : `  · ③ 用户人工：${c.human.approved === true ? '通过' : c.human.approved === false ? '**未通过**' : '等答复'}（${c.human.request_id}）`,
        c.arranged === null
          ? '  · ④ 计划 AI（怎么跑）：**未安排**'
          : `  · ④ 计划 AI（怎么跑）：${c.arranged.command ? `批准命令 \`${c.arranged.command}\`` : '(同意但没给命令)'}`,
        '',
        c.status === 'rejected' ? `否决理由：${c.reject_reason}` : '',
        '★ 守门在 shell 那一层按"最终批准的命令"放行：跑别的全量命令会被拒（批一条跑另一条 = 没审批）。',
        '★ 定向测试（带 --grep / -k / 具体测试文件或包）**不需要**这条链，直接跑。',
      ]
      return {
        ok: true,
        status: c.status,
        next_stage: stage,
        credential: fullTestCredential(task),
        summary: lines.filter((l) => l !== '').join('\n'),
      }
    },
  })

  return { changeAuditTool, boundariesTool, fullTestTool }
}
