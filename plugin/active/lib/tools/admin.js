/**
 * dsh-pipeline · 角色变更、制品、自检、开关
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/admin
 */

import { L5_EXTENSION_POOL } from '../tiers.js'
// ★★ 关掉时的文案**唯一出处**（与启动日志同一份）—— 缺陷"开关只关一半"的措辞侧修复。
import { offModeCopy } from '../switch/text.js'
import { S, tool, resolveActor } from './kit.js'

/**
 * 角色变更、制品、自检、开关
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildAdminTools(ctx) {
  const { deps, store, indexTask, sw } = ctx

  // =========================================================================
  // 10/11. 角色变更：申请 + 复核
  // =========================================================================
  const rosterRequest = tool(deps, {
    name: 'pipeline_roster_request',
    mutating: true,
    description:
      '【执行角色专用】提出角色变更申请（加人/减人）。这是**唯一**的入口 —— 主对话不能自己决定加人减人。' +
      '流程：编写/测试/审核提出申请 → **计划 AI**（planner）复核 → 输出新角色清单 → 主对话按新清单派活。',
    parameters: {
      task_id: S('string', '任务 ID'),
      add: S('array', '建议追加的角色（可空）', { items: { type: 'string' } }),
      remove: S('array', '建议移除的角色（可空；三权分立角色不可移除）', { items: { type: 'string' } }),
      reason: S('string', '为什么要加/减人（必填，会留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      request_id: S('string', '申请 id'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '' }
      const res = await store.requestRosterChange({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        add: args.add,
        remove: args.remove,
        reason: args.reason,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '' }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        request_id: res.request.request_id,
        summary:
          `${res.summary}\n` +
          `可用扩展角色：${L5_EXTENSION_POOL.join(' / ')}\n` +
          '下一步：等**计划 AI**（planner）调 pipeline_roster_review 复核（主对话不批）。',
      }
    },
  })

  const rosterReview = tool(deps, {
    name: 'pipeline_roster_review',
    mutating: true,
    description:
      '【计划 AI 专用】复核一条角色变更申请。批准则**由本次复核直接改写角色清单**并留痕；驳回则说明理由。' +
      '★ 主对话不能批自己的申请，也不能直接改角色清单 —— 这条路径是封闭的。\n' +
      '★ 本轮改动：复核权从需求分析（orchestrator）移到**计划 AI**（planner）—— 加人减人就是改角色清单，那就是分配。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '申请 id'),
      approve: S('boolean', '是否批准'),
      note: S('string', '复核意见（驳回时必填）'),
      /**
       * ★ 批准**加人**时必须给新角色的边界卡。
       *
       * 为什么：计划里的 `role_boundaries` 是在分配那一刻写死的（覆盖当时的执行角色）。
       * 中途加人 = 加一张新卡 —— 那是分配的一部分，本来就是计划 AI 的活。
       * 缺了这张卡，新角色派活时就没有"只干什么、不干什么"可依据 ⇒ setRoster 会拒。
       */
      role_boundaries: S('array', '★ 新角色的边界卡 [{ role, only: string[], not: string[] }] —— **批准加人时必填**', { items: { type: 'object', additionalProperties: true } }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      applied: S('boolean', '是否已改写角色清单'),
      ai_count: S('number', '新清单的独立对话数'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, applied: false, ai_count: 0 }
      if (args.approve !== true && (typeof args.note !== 'string' || args.note.trim().length === 0)) {
        return { ok: false, summary: '驳回角色变更申请必须给 note（理由）。', applied: false, ai_count: 0 }
      }
      const res = await store.reviewRosterChange({
        taskId: String(args.task_id ?? ''),
        requestId: String(args.request_id ?? ''),
        approve: args.approve === true,
        note: args.note,
        roleBoundaries: Array.isArray(args.role_boundaries) ? args.role_boundaries : [],
        actorRole: actor.role,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, applied: false, ai_count: 0 }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        applied: res.applied === true,
        ai_count: res.task.roster?.ai_count ?? 0,
        summary: res.summary,
      }
    },
  })

  // =========================================================================
  // 12. pipeline_artifact —— 制品登记（版本化 + 可回滚）
  // =========================================================================
  const artifact = tool(deps, {
    name: 'pipeline_artifact',
    mutating: true,
    description:
      '【编写角色专用】登记一个代码制品版本（v1、v2…），落盘到 <项目>/.pipeline/<任务>/artifacts/vN/。' +
      '制品版本化是"审核的是不是同一个版本"的判定依据：测试报告与审核结论都要带上 artifact_version，' +
      '对不上就拒绝。rollback_to 可以把某个历史版本重新登记为当前版本（旧版本不删）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      content: S('string', '制品内容（补丁或代码正文）'),
      file_name: S('string', '文件名（默认 artifact.txt）'),
      note: S('string', '备注（可空）'),
      rollback_to: S('string', '回滚到某个版本号（给了就忽略 content）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      version: S('string', '登记出的版本号'),
      sha256: S('string', '内容哈希'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, version: '', sha256: '' }
      const res =
        typeof args.rollback_to === 'string' && args.rollback_to.length > 0
          ? await store.rollbackArtifact({
              taskId: String(args.task_id ?? ''),
              version: args.rollback_to,
              actorRole: actor.role,
              actorAgentId: actor.agentId,
            })
          : await store.registerArtifact({
              taskId: String(args.task_id ?? ''),
              content: String(args.content ?? ''),
              fileName: typeof args.file_name === 'string' && args.file_name.length > 0 ? args.file_name : undefined,
              note: typeof args.note === 'string' ? args.note : '',
              actorRole: actor.role,
              actorAgentId: actor.agentId,
            })
      if (res.ok !== true) return { ok: false, summary: res.error, version: '', sha256: '' }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        version: res.artifact.version,
        sha256: res.artifact.sha256,
        summary: `${res.summary}\n落盘：${res.artifact.file}`,
      }
    },
  })

  // =========================================================================
  // 13. pipeline_selftest —— 守门自检（在真实环境里复现反例）
  // =========================================================================
  const selftest = tool(deps, {
    name: 'pipeline_selftest',
    description:
      '守门自检：在**内存里**跑一遍正例全流程与全部反例，把每条拒绝原文原样打出来。' +
      '不创建任何真实会话、不写工作区之外的任何文件（只在一个临时任务目录里跑，跑完即删）。' +
      '用途：装完之后当场确认"机制真的在生效"，而不是读 README 猜。',
    parameters: {
      verbose: S('boolean', '是否打印每条用例的完整拒绝原文（默认 true）'),
    },
    output: {
      ok: S('boolean', '自检是否全部通过'),
      summary: S('string', '自检报告'),
    },
    async run(args) {
      // `tests/` 可能没被装过去（install.ps1 的 -WithDocs 才装 examples/REPORT.md，
      // 但 tests/ 是默认装的 —— 因为本工具依赖它）。拷不到就**明说**，不要抛。
      let runSelfTest
      try {
        // 本文件在 lib/tools/ 下 ⇒ 包根是上两级
        ;({ runSelfTest } = await import('../../tests/selftest-core.mjs'))
      } catch (err) {
        return {
          ok: false,
          summary:
            '[pipeline] 自检不可用：找不到 tests/selftest-core.mjs。\n' +
            `原因：${String(err?.message ?? err)}\n` +
            '修法：用 install.ps1 重装一次（它会带上 tests/），' +
            '或手工把插件源目录的 tests/ 拷到已安装的 dsh-pipeline 目录下。\n' +
            '注意：这不代表守门没生效 —— 只是这个"当场自检"入口缺了依赖。',
        }
      }
      const report = await runSelfTest({ verbose: args.verbose !== false })
      return { ok: report.passed === report.total, summary: report.text }
    },
  })

  // =========================================================================
  // 14. pipeline_switch —— 功能开关（与右上角 UI 开关是同一个开关位）
  // =========================================================================
  const switchTool = tool(deps, {
    name: 'pipeline_switch',
    description:
      '多 AI 协调功能的总开关（与 DSH 窗口右上角那个「多AI 协调」按钮**是同一个开关位**）。' +
      '不带参数 = 直接翻转；带 on=true/false = 显式设定。' +
      '开 = 编排（角色清单/调用顺序）+ 守门（越权拦截）+ 状态机全都管；' +
      '关 = 关闭该功能，回到普通 DSH 行为：本插件**不再拦任何调用、不再往任何会话注入消息**' +
      '（拦截缝四条全直通、唤醒不投递、巡检与孤儿单自恢复停表），' +
      '**但流水线的写入动作仍被拒绝**（关掉功能的语义就是"不干活"），查询与自检仍可用。' +
      '切换立即生效，不需要重启；状态会落盘，重启后保持。',
    parameters: {
      on: S('boolean', '显式设定：true=开，false=关。留空 = 翻转当前状态'),
      reason: S('string', '变更原因（会记进日志与状态文件，可空）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      on: S('boolean', '切换后的状态'),
      changed: S('boolean', '这一次是否真的变了'),
      revision: S('number', '状态修订号（每次真正变更 +1）'),
      persisted: S('boolean', '是否成功落盘'),
    },
    async run(args) {
      if (sw === undefined || sw === null) {
        return { ok: false, on: false, changed: false, revision: 0, persisted: false, summary: '[pipeline] 功能开关未初始化（插件内部错误）。' }
      }
      const before = sw.snapshot()
      const meta = { by: 'tool', reason: typeof args.reason === 'string' ? args.reason : '' }
      const res = typeof args.on === 'boolean' ? sw.set(args.on, meta) : sw.toggle(meta)
      const after = res.state
      const lines = [
        `${res.changed ? '已切换' : '状态未变'}：多 AI 协调功能 **${after.on ? '开' : '关'}**。`,
        `修订号：${after.revision}${res.changed ? `（上一次是 ${before.revision}）` : ''}`,
        `生效时间：${after.since}　来源：${after.by}`,
        `落盘：${res.persisted ? '成功' : '**失败**（内存态仍生效，重启会丢；日志里有原因）'}`,
        `状态文件：${sw.stateFile}`,
        '',
        after.on
          ? '现在是**开**：主对话按角色清单调度，编写/测试/审核三权分立，越权动作会被守门拦下，没有审核 OK 关不了单。'
          : ['现在是**关**：多 AI 协调功能已彻底停止介入。', ...offModeCopy(after)].join('\n'),
        '',
        '同一个开关位的另一个入口：DSH 窗口右上角头部那一排里的「多AI 协调」按钮（点一下即切）。',
      ]
      return { ok: true, on: after.on, changed: res.changed, revision: after.revision, persisted: res.persisted, summary: lines.join('\n') }
    },
  })

  return { rosterRequest, rosterReview, artifact, selftest, switchTool }
}
