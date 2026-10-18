/**
 * dsh-pipeline · 任务存储 · 交接物核对、打回、关单、制品
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * ★★ P1-10（设计档 `design/conventions/04-demo与制品模型.md` §3「推荐 B」，2026-10-18）：
 *   `registerArtifact` 支持可选 `files: [{ path, sha256? }]` —— 把**整体交付快照**
 *   （`snapshot_id` / `complete` / missing / mismatch）一起记进这一版；同一工具新增
 *   `verifyArtifactVersion`（`pipeline_artifact { action: "verify" }`）重算校验。
 *   **磁盘核对**（读盘算 hash / missing / mismatch）在 `lib/store/artifact-snapshot.js`；
 *   **关单判据**在 `lib/store/precondition.js` 的 `artifact_snapshot_complete`（仅 L3+）。
 *
 * @module dsh-pipeline/lib/store/review
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ST, STATE_LABEL, DIAGRAM_DELIVERY_STATES } from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
// ★ E3：关单是"语义上完整的时刻" —— 记忆域在这里把该任务的记忆综合进项目活文档（设计 04 §3.1）。
import { refreshLiveDocForTask } from '../memory/live-doc-write.js'
// ★ 领域对象集中：制品版本记录与关单报告的形状在 `lib/model/` 下。
import { artifactRecordOf, isSnapshotRecord, makeArtifactRecord } from '../model/artifact.js'
import { makeCloseReport } from '../model/close-report.js'
// ★★ P1-10：制品快照的**磁盘核对**（files 规整 / 逐条 hash / missing·mismatch / snapshot_id）
//    在 `lib/store/artifact-snapshot.js` —— 本文件只做"登记 / 校验"这条业务链，判据不在这里手抄。
import { buildArtifactSnapshot, checkSnapshotAgainstDisk, renderSnapshotCheckLines } from './artifact-snapshot.js'

/**
 * 任务存储 · 交接物核对、打回、关单、制品
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function reviewMethods(ctx) {
  const {
    maxRework,
    now,
    artifactDir,
    audit,
    deny,
    loadTask,
    persist,
    currentArtifactVersion,
    lastHandoff,
    hubEnabled,
    hubStandbyBlocks,
    renderStandbyBlock,
    effectiveReviewOk,
    swOf,
    projectRoot,
  } = ctx

  return {
    /**
     * ★★ **主管枢纽**下的交接物-状态判据（T-20261011-56a37e）。
     *
     * 它在 `checkHandoffAgainstState` **同一个方法**里、**同一个入口**上被调用 ——
     * 不是第二套判据面，只是"枢纽启用之后这张表长这样"。
     *
     * @returns {object|null} `null` = 本 kind 不受枢纽分支管，交给原表；否则是判定结果
     */
    checkHubHandoffAgainstState(task, kind, payload = null) {
      const s = task.state
      /**
       * ★ **架构图前置**（用户原话：需求确认后先出架构图 → 主管确认 → 才交计划）。
       *
       * 枢纽任务里，架构图的合法状态面**整体前移**到计划之前；
       * 而**编写完成之后**那几个状态（ready_test 及以后）在本拓扑里**不再**是它该出现的地方
       * —— 这正是"同一张图不再被当成两种东西"的判据。
       *
       * ★★ 2026-10-16 修（真机 `T-20261016-fullai` 的 **L5 关单死锁**）：
       *   "前移"**不等于"删除"**。上面那条把交付站关掉之后，与关单闸
       *   （`precondition.js` 的 `diagram_delivered`：图必须对应写完之后的最终版本）
       *   **结构上不可能同时成立** —— 先画后写的单，图只可能声明"画图那一刻的版本"，
       *   写完产生新版本（v1→v2）之后就再也没有合法位置重交一张对应最终版本的图 ⇒
       *   **任何**走这条路线、且写完产生新版本的单都关不掉（不是个例）。
       *   所以这里把**交付站**（`DIAGRAM_DELIVERY_STATES`，与基础表同源）还给架构图，
       *   并在那里加两条硬判据：① **必须绑当前有效制品版本**；② **幂等**。
       *   关单闸一个字没放宽：它要的仍是"最新那张图 = 当前版本"。
       */
      if (kind === 'architecture_diagram') {
        if (
          s === ST.ARCH_DRAWING ||
          s === ST.ARCH_CONFIRM ||
          /** ★ P0-1：②b / ②c 两个确认点上，架构图仍然是"当前这一份"，可以再交一次（重画后重交）。 */
          s === ST.ARCH_NEED_CONFIRM ||
          s === ST.ARCH_RECONFIRM
        ) {
          // ★ 与既有 `DIAGRAM_BEFORE_WRITE` **方向相反**的那一条：
          //   枢纽里要的是"**还没有**编写产物"的设计态图 —— 有编写产物说明架构图前置已经失效。
          if (lastHandoff(task, 'dev_to_test') !== null && s === ST.ARCH_DRAWING) {
            return deny(
              'HUB_DIAGRAM_AFTER_WRITE',
              `拒绝：任务 ${task.id} 的**架构图前置站**上已经存在编写产物（dev_to_test）。\n` +
                '★ 用户口径⑦：架构图前置是「**设计**」，安全审查是「准入」，两者不冲突；\n' +
                '  而"编写都做完了才补一张设计态图"说明前置站被跳过了 —— 那张图不是前置图，是补的。\n' +
                '下一步：确认是不是走错了站（编写交付之后的图属于**交付站**，不在枢纽的前置站上）。',
            )
          }
          return { ok: true }
        }
        /**
         * ★★ **交付站**（编写完成之后）：枢纽把设计态那一站前移了，但**没有把交付站删掉**。
         *
         * 两条判据（都必须是可判定的，不许"声明什么算什么"）：
         *   ① **绑当前有效制品版本** —— 关单闸要的就是这个；绑旧版本等于没对齐。
         *   ② **幂等** —— 最新那张图已经绑当前版本时，再交一份不产生第二条有效记录
         *      （否则"当前是哪张图"要靠条数猜，关单判据也会随交图次数漂移）。
         */
        if (DIAGRAM_DELIVERY_STATES.includes(s)) {
          const cur = currentArtifactVersion(task)
          if (cur === null) {
            return deny(
              'HUB_DIAGRAM_NO_ARTIFACT',
              `拒绝：任务 ${task.id} 现在处于「${STATE_LABEL[s]}(${s})」，但**还没有任何有效制品** —— ` +
                '交付站的架构图是"写成了什么样"的记录，没有可对应的制品就没有可绑的版本。',
            )
          }
          const last = lastHandoff(task, 'architecture_diagram')
          if (last !== null && last.payload?.based_on_artifact_version === cur) {
            return deny(
              'HUB_DIAGRAM_ALREADY_CURRENT',
              `拒绝：任务 ${task.id} 最新那份架构图（${last.handoff_id}）**已经绑的就是当前有效制品 ${cur}** —— ` +
                '重交同一版本是空动作，不产生第二条有效记录（这条判据是**幂等**的）。\n' +
                '★ 交付站重交的用途只有一个：把关单要的那张图对齐到**写完之后的版本**。\n' +
                '  已经对齐了就不需要再交；要换一张**内容不同**的图，请连同它对应的制品版本一起说清楚。',
            )
          }
          if (String(payload?.based_on_artifact_version ?? '') !== cur) {
            return deny(
              'HUB_DIAGRAM_VERSION_REQUIRED',
              `拒绝：交付站重交的架构图**必须绑当前有效制品版本**（${cur}），` +
                `而这份声明的是「${payload?.based_on_artifact_version ?? '(缺失)'}」。\n` +
                '★ 为什么交付站要查这个：关单闸要求"最新那张图 = 当前有效制品"（本插件不打算放宽它）。\n' +
                '  在交付站把一张旧版本的图原样标成当前版本，等于让那条闸变成一句空话；\n' +
                '  所以这里要求的是**真的对齐**：图对应写完之后的那个版本。\n' +
                '下一步：把 based_on_artifact_version 填成当前有效制品（pipeline_status 里有），重新交一次。',
            )
          }
          return { ok: true }
        }
        const need = [ST.ARCH_DRAWING, ST.ARCH_CONFIRM, ST.ARCH_NEED_CONFIRM, ST.ARCH_RECONFIRM, ...DIAGRAM_DELIVERY_STATES]
        return deny(
          'HUB_DIAGRAM_STEP_SKIPPED',
          `跳步（架构图前置）：枢纽任务的架构图只能在 ${need.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')} 提交 —— ` +
            '前四个是「主管同意需求结论」之后、「主管确认架构图」之前的**前置站**；' +
            '后五个是**交付站**（编写完成之后，重交的图必须绑当前有效制品版本）。\n' +
            `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。\n` +
            '★ 用户原话：「需求ai分析将结果提交主管→同意后交给架构ai**先画架构图**→架构图完成后给主管确认是否满足要求→主管确认后**才**交给计划ai」。\n' +
            '  「先画架构图」在表上的形状就是：`analyzing` **没有**直达 `planning` 的边，' +
            '而架构图这一站排在它们中间。',
        )
      }

      /**
       * ★ **待机期不许抢跑**（安全预审阻断项 B3 的第 1 条：交接物面）。
       *   两位待机席位各自的产物：architect → design；planner → plan / orchestration。
       *
       * ★ 另一半是**正例**（B3 明确要求的那条）：**到点唤醒之后，同样的动作必须放行** ——
       *   否则这条判据就不是"待机判据"，而是"把功能一起关掉"。所以下面显式给出
       *   枢纽下的合法状态面，而不是"拦完就完"。
       */
      if (kind === 'design' || kind === 'plan' || kind === 'orchestration') {
        const role = kind === 'design' ? ROLE.ARCHITECT : ROLE.PLANNER
        const blocked = hubStandbyBlocks(task, role)
        if (blocked.ok !== true) {
          return renderStandbyBlock(task, blocked.entry, blocked.wakePoint, `现在交「${kind}」就是**抢跑**`)
        }
        const hubNeed = {
          // 架构位唤醒点 A 之后的两站，加上既有的几个合法站（唤醒是**解锁**，不是换轨）。
          design: [ST.ANALYZING, ST.ARCH_DRAWING, ST.ARCH_CONFIRM, ST.ARCH_NEED_CONFIRM, ST.ARCH_RECONFIRM, ST.STANDBY_PLAN, ST.PLANNING, ST.READY_DEV, ST.DEVELOPING],
          plan: [ST.PLANNING],
          orchestration: [ST.PENDING, ST.PLANNING],
        }[kind]
        if (hubNeed.includes(s)) return { ok: true }
        return deny(
          'HANDOFF_STEP_SKIPPED',
          `跳步（枢纽）：交接物「${kind}」在主管枢纽下只能在这些状态提交 —— ` +
            `${hubNeed.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')}；任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
        )
      }

      /** ★ 架构图重画指令：只在「架构图待主管确认」这一站发得出。 */
      if (kind === 'diagram_rework') {
        if (s !== ST.ARCH_CONFIRM) {
          return deny(
            'HUB_REDRAW_STEP_SKIPPED',
            `跳步：架构图重画指令只能在「${STATE_LABEL[ST.ARCH_CONFIRM]}(${ST.ARCH_CONFIRM})」发出（那时才有"不满足"可判）。` +
              `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
          )
        }
      }

      /** ★ 测试提前知情：预登记必须**早于编写交付**（用户口径③：不许看编写的产物）。 */
      if (kind === 'prebrief') {
        if (s !== ST.PLANNING) {
          return deny(
            'HUB_PREBRIEF_STEP_SKIPPED',
            `跳步：任务内容预登记（prebrief）只能在「${STATE_LABEL[ST.PLANNING]}(${ST.PLANNING})」提交 —— ` +
              `它是**计划位**在出计划时顺手交出去的那一份。任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。`,
          )
        }
        if (lastHandoff(task, 'dev_to_test') !== null) {
          return deny(
            'HUB_PREBRIEF_AFTER_WRITE',
            `拒绝：任务 ${task.id} 里**已经有编写产物**（dev_to_test）了，这时交的"预登记"不是预登记。\n` +
              '★ 用户口径③：「测试提前收到任务内容」= **内容提前交到测试位手里**，而**不许看编写的产物**（保持独立性）。\n' +
              '  在编写交付之后再交，等于把"事后通知"冒充成"提前知情" —— 那正是本单要改掉的现行做法。',
          )
        }
      }
      return null
    },

    /** 删掉一份刚写了又回滚的交接物文件（保持"要么全成要么全不成"）。 */
    async removeHandoffFile(task, record) {
      try {
        const { unlink } = await import('node:fs/promises')
        if (typeof record.file === 'string' && record.file.length > 0) await unlink(record.file)
      } catch {
        /* 回滚失败不该掩盖真正的错误；内存里已经 pop 掉了，状态是自洽的 */
      }
    },

    /** 交接物与当前状态是否匹配（"跳步"的第二道闸）。 */
    checkHandoffAgainstState(task, kind, payload = null) {
      const s = task.state
      // ★★ 主管枢纽（T-20261011-56a37e）：架构图**前置**之后，各站的合法状态面变了。
      //   ★ 只在**已启用枢纽**的任务上生效 —— 未启用的任务走下面那张原表（一个字节没动）。
      if (hubEnabled(task)) {
        const hub = this.checkHubHandoffAgainstState(task, kind, payload)
        if (hub !== null) return hub
      }
      const need = {
        dev_to_test: [ST.DEVELOPING],
        test_to_review: [ST.TESTING],
        test_to_dev: [ST.TESTING],
        review_verdict: [ST.REVIEWING],
        // ★ 本轮拆分：需求分析结论只在「需求分析中」交；分配结论只在「计划中」交。
        requirement_analysis: [ST.ANALYZING],
        orchestration: [ST.PENDING, ST.PLANNING],
        plan: [ST.PLANNING],
        design: [ST.READY_DEV, ST.DEVELOPING, ST.ANALYZING, ST.READY_PLAN, ST.PLANNING],
        /**
         * ★ 架构图：**编写完成之后**才允许交。
         *
         * 状态下限是「待测试」—— 也就是说"编写还没交（还在开发中）就交图"会被这里拦下。
         * 上面还有一个更硬的判据（必须有 dev_to_test 交接物），两道一起挡"还没写完就交图"。
         *
         * ★ 2026-10-16：这一份清单**搬到 `states.js` 的 `DIAGRAM_DELIVERY_STATES`**
         *   （内容逐字未变）—— 枢纽分支要用**同一个**出处，各写一份迟早漂移。
         */
        architecture_diagram: [...DIAGRAM_DELIVERY_STATES],
        // ★ 第一级提问：除终态外任何状态都能问（被卡住的地方哪都有可能）
        clarification_request: Object.values(ST).filter((x) => x !== ST.CLOSED && x !== ST.CANCELLED),
        // ★ 需求分析的裁定：只在「等待需求分析答复」时提交
        clarification_reply: [ST.AWAITING_CLARIFICATION],
        // ★ 缺陷 ⑬（2026-10-17）：关单闸要求的几票都必须能在 passed 上补交 —— 改前 security_review 与
        //   perf_report 不认 passed，而关单闸（security_not_blocked / role_products_delivered）又非要它们不可
        //   ⇒ L3+ / L5 审核一过就关不了单，只能靠主管"流程性打回"绕（污染打回计数）。
        //   release_plan / docs_note 本来就认 passed，这里与它们对齐；终态（closed / cancelled）照旧不许交。
        security_review: [ST.READY_REVIEW, ST.REVIEWING, ST.DEVELOPING, ST.READY_TEST, ST.TESTING, ST.PASSED],
        release_plan: [ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        docs_note: [ST.DEVELOPING, ST.READY_TEST, ST.TESTING, ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        perf_report: [ST.TESTING, ST.READY_REVIEW, ST.REVIEWING, ST.PASSED],
        arbitration: [ST.RETURNED_TO_DEV, ST.RETURNED_TO_TEST, ST.BLOCKED, ST.TESTING, ST.REVIEWING],
        human_note: Object.values(ST),
      }[kind]
      if (need === undefined || need.includes(s)) {
        // ★ 架构图额外加一条**时机**判据：必须先有编写的产物。
        //   —— 光看状态不够：「待测试」也可能是"被回退回来"的，那时同样没有新产物。
        if (kind === 'architecture_diagram' && lastHandoff(task, 'dev_to_test') === null) {
          return deny(
            'DIAGRAM_BEFORE_WRITE',
            `时序错误：任务 ${task.id} 还没有任何编写产物（没有 dev_to_test 交接物），却要交架构图。\n` +
              '★ 架构图是"写成了什么样"的记录 —— 没有"写成的东西"就没有可画的图。\n' +
              '正确顺序：编写交 dev_to_test → 状态到「待测试」→ 架构图角色交 architecture_diagram。\n' +
              '（本插件刻意不让架构图角色在编写之前动手：那会退化成 architect 的"设计草图"，' +
              '而设计草图是 architect 的活，不是交付物。）',
          )
        }
        return { ok: true }
      }
      return deny(
        'HANDOFF_STEP_SKIPPED',
        `跳步：交接物「${kind}」只能在这些状态下提交 —— ${need.map((x) => `${STATE_LABEL[x]}(${x})`).join(' / ')}；` +
          `任务 ${task.id} 当前是「${STATE_LABEL[s]}(${s})」。\n` +
          (kind === 'review_verdict' && s === ST.DEVELOPING
            ? '★ 编写完成后必须先进「待测试」→「测试中」，测试通过后才进「待审核」。审核不能对着开发中的产物出结论。'
            : '') +
          (kind === 'architecture_diagram' && s === ST.DEVELOPING
            ? '★ 架构图必须在**编写完成之后**交。现在还在「开发中」—— 先让编写交 dev_to_test。'
            : ''),
      )
    },

    /**
     * 打回。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.actorRole
     * @param {'writer'|'tester'} input.target
     * @param {string} input.reason
     * @param {string} [input.actorAgentId]
     */
    async rework(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const target = input.target === 'tester' ? 'tester' : 'writer'
      if (target === 'writer' && ![ROLE.TESTER, ROLE.REVIEWER, ROLE.SECURITY].includes(input.actorRole)) {
        return deny('ROLE_NOT_ALLOWED', `打回编写只能由 测试/审核/安全审计 发起，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      if (target === 'tester' && input.actorRole !== ROLE.REVIEWER) {
        return deny('ROLE_NOT_ALLOWED', `打回测试只能由 审核 发起，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }

      const leg = target === 'writer' ? 'dev' : 'test'
      const budget = task.roster?.rework_budget ?? maxRework
      const used = task.rework[leg] ?? 0
      if (used >= budget) {
        return deny(
          'REWORK_EXHAUSTED',
          `打回次数超限：本任务「${leg === 'dev' ? '打回编写' : '打回测试'}」已用 ${used} 次，上限 ${budget} 次。\n` +
            `按规则不能无限打回。请改用：pipeline_transition event=block（已阻塞）交人工介入，` +
            `或让编排复核后追加仲裁角色（pipeline_roster_request → pipeline_roster_review）。`,
        )
      }

      const event = target === 'writer' ? (input.actorRole === ROLE.TESTER ? 'test_failed' : 'review_ng_dev') : 'review_ng_test'
      const res = await this.transition({ taskId: input.taskId, event, actorRole: input.actorRole, actorAgentId: input.actorAgentId, note: input.reason })
      if (res.ok !== true) return res

      task.rework[leg] = used + 1
      const entry = await audit(task.id, input.actorRole, `rework:${target}`, {
        reason: input.reason,
        used: task.rework[leg],
        budget,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // 打回会作废旧的审核 OK —— 这是"改完代码不能拿旧 OK 关单"的实现。
      return {
        ok: true,
        task,
        target,
        used: task.rework[leg],
        budget,
        summary:
          `已打回${target === 'writer' ? '编写' : '测试'}（第 ${task.rework[leg]}/${budget} 次）。` +
          `任务 ${task.id} 现在处于「${STATE_LABEL[task.state]}」。` +
          (task.rework[leg] >= budget ? ' ⚠ 打回预算已用尽，再打回会被拒绝。' : ''),
      }
    },

    /**
     * 关单。★ 必须存在有效的审核 OK。
     */
    async close(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.MAIN) {
        return deny('ROLE_NOT_ALLOWED', `只有主对话能关单，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }

      // 守门判据 #1：有效审核 OK。
      const okCheck = await this.checkPrecondition(task, 'review_ok_exists', {})
      if (okCheck.ok !== true) return okCheck

      const tr = await this.transition({ taskId: input.taskId, event: 'close', actorRole: ROLE.MAIN, actorAgentId: input.actorAgentId, note: input.note })
      if (tr.ok !== true) return tr

      const ok = effectiveReviewOk(task)
      // 关单报告的形状集中在 `lib/model/close-report.js`。
      task.close_report = makeCloseReport({ task, reviewOk: ok, currentArtifactVersion, now })
      const entry = await audit(task.id, ROLE.MAIN, 'close', {
        artifact_version: task.close_report.artifact_version,
        review_ok: task.close_report.review_ok_handoff,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // ★★ E3（设计 `04-§3.1`）：**关单 = 语义上完整的时刻** —— 把这张单的记忆综合进项目活文档。
      //   不接这一句 ⇒ 活文档永远停在最初那份，**它就不是活文档**（验收判据就是这一条）。
      //   它**绝不抛**、内容不变就不重写（幂等），且受总开关管（`memory-live-doc`）。
      await refreshLiveDocForTask(task, { swOf, projectDir: projectRoot })

      return { ok: true, task, report: task.close_report, summary: `任务 ${task.id} 已关闭。放行依据：${task.close_report.review_ok_handoff}（审核 OK，制品 ${task.close_report.artifact_version}）。` }
    },

    /**
     * 登记一个制品版本（编写角色的动作）。制品版本化 + 可回滚。
     *
     * ★★ P1-10：可选 `files: [{ path, sha256? }]` —— 给了就把这次的**整体交付快照**
     *   一起记进这一版（`rec.snapshot`）；不给 = 与改前**逐字节相同**的旧行为。
     *
     * ★ 快照的**核对**（读盘算哈希）发生在任何写盘动作**之前** ——
     *   files 不合法时直接拒收，不会留下"半截登记"。
     */
    async registerArtifact(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.WRITER) {
        return deny('ROLE_NOT_ALLOWED', `只有编写角色能登记代码制品，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      /**
       * ★ P1-10：先把快照核对出来（纯读）—— 不合法就在这里拒，版本号计数器与磁盘都不动。
       * ★ `files: []` 视为"没给"（保持旧行为）；只有真的列了文件才记快照。
       */
      const fileList = Array.isArray(input.files) ? input.files : []
      let snapshot = null
      if (fileList.length > 0) {
        const built = await buildArtifactSnapshot(task, fileList, now)
        if (built.ok !== true) return built
        snapshot = built.snapshot
      }
      const content = String(input.content ?? '')
      task.artifact_version_counter += 1
      const version = `v${task.artifact_version_counter}`
      const dir = artifactDir(task.id, version)
      await mkdir(dir, { recursive: true })
      const file = join(dir, input.fileName ?? 'artifact.txt')
      await writeFile(file, content, 'utf8')
      // 制品版本记录的形状集中在 `lib/model/artifact.js`。
      const rec = makeArtifactRecord({ version, file, content, note: input.note, now, snapshot })
      task.artifacts.push(rec)
      const entry = await audit(task.id, ROLE.WRITER, 'artifact:register', {
        version,
        sha256: rec.sha256,
        bytes: rec.bytes,
        ...(rec.snapshot === undefined
          ? {}
          : {
              snapshot_id: rec.snapshot.snapshot_id,
              snapshot_complete: rec.snapshot.complete,
              snapshot_files: rec.snapshot.files.length,
              snapshot_missing: rec.snapshot.missing.length,
              snapshot_mismatch: rec.snapshot.mismatch.length,
            }),
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)
      /**
       * 摘要里把快照状况说清（**完整/不完整/缺几个/不一致几个**）——
       * 登记成功不等于快照完整：不完整时调用方要立刻知道（L3+ 关单会被它拦住）。
       */
      const snapNote =
        rec.snapshot === undefined
          ? ''
          : rec.snapshot.complete
            ? `\n快照：${rec.snapshot.files.length} 个文件全部核对一致（snapshot_id ${rec.snapshot.snapshot_id.slice(0, 16)}…）。`
            : `\n⚠ 快照**不完整**：${rec.snapshot.missing.length} 个文件缺失 / ${rec.snapshot.mismatch.length} 个哈希不一致。` +
              `\n  下一步：用 pipeline_artifact { action: "verify", version: "${version}" } 看明细；` +
              '把文件补齐/还原后重跑 verify 可标回完整（L3+ 关单要求快照完整）。'
      return {
        ok: true,
        task,
        artifact: rec,
        snapshot: rec.snapshot ?? null,
        summary: `制品已登记：${version}（${rec.bytes} 字节，sha256 ${rec.sha256.slice(0, 16)}…）。${snapNote}`,
      }
    },

    /**
     * ★★ P1-10：**重算校验**一个版本的快照（`pipeline_artifact { action: "verify" }` 的实现）。
     *
     * 判据（与登记时同源：`snapshotIdOf` + 逐文件磁盘哈希）：
     *   · 按 `snapshot.files` 逐条读盘算哈希 ⇒ `missing[]` / `mismatch[]` 明细；
     *   · 用**磁盘实际哈希**重算 `current_snapshot_id`，与登记时的 `snapshot_id` 比 ——
     *     `same = 完整且 id 一致`（这就是"登记后又被改过"的判据）；
     *   · 本次结论**写回登记记录**（`verified_at` / `complete` / missing / mismatch）——
     *     所以文件被还原后重跑一次 verify，就能把快照标回**完整**（"verify 修复"）；
     *   · 没有快照的 legacy 登记：**明确说"无法校验"**并给出重登记的出路（不假装验过）。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} [input.version] - 缺省 = 当前有效制品版本
     * @param {string} [input.actorRole] - writer / human（与工具守门同一口径）
     */
    async verifyArtifactVersion(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.WRITER && input.actorRole !== ROLE.HUMAN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有编写角色或人工能校验制品快照，当前调用方是「${roleLabel(input.actorRole)}」。`,
        )
      }
      const version =
        typeof input.version === 'string' && input.version.length > 0 ? input.version : currentArtifactVersion(task)
      const emptyExtra = { version: version ?? '', snapshot_id: '', snapshot_complete: false, verified: false, same: false, missing: [], mismatch: [], snapshot: null }
      if (typeof version !== 'string' || version.length === 0) {
        return deny(
          'ARTIFACT_NOT_FOUND',
          `任务 ${task.id} 还没有**当前有效制品**（最近一次 dev_to_test 没带 artifact_version）。\n` +
            '先让编写登记制品 → 交 dev_to_test（artifact_version 指向它），再谈快照校验。',
          emptyExtra,
        )
      }
      const rec = artifactRecordOf(task, version)
      if (rec === null) {
        const known = (Array.isArray(task.artifacts) ? task.artifacts : []).map((a) => a.version)
        return deny(
          'ARTIFACT_NOT_FOUND',
          `任务 ${task.id} 里没有制品版本 ${version} 的登记记录（已有登记：${known.join(', ') || '（无）'}）。\n` +
            '★ 当前有效制品版本来自最近一次 dev_to_test 的声明；没有登记记录就没法核对快照。',
          emptyExtra,
        )
      }
      const snap = isSnapshotRecord(rec.snapshot) ? rec.snapshot : null
      if (snap === null) {
        return deny(
          'ARTIFACT_SNAPSHOT_LEGACY',
          `拒绝校验：制品 ${version} 是 **legacy 登记**（没有 files 快照），没有可比对的哈希。\n` +
            '★ L3+ 关单要求当前有效制品的登记带完整快照 —— legacy 会被视为不完整。\n' +
            '出路：重新登记一个带 files 的制品版本（pipeline_artifact { files: [{ path }] }），' +
            '再让编写重交 dev_to_test / 测试重验 / 审核重绑新版本。',
          emptyExtra,
        )
      }

      // ---- 逐文件重算：与登记时**同一份**实现（`checkSnapshotAgainstDisk`）--------
      const check = await checkSnapshotAgainstDisk(task, snap, now)
      const { missing, mismatch, currentSnapshotId, complete, same } = check

      // ---- 把本次校验结论写回（verify 就是"修复"入口：文件还原后重跑一次即回完整）----
      rec.snapshot = {
        ...snap,
        complete,
        verified_at: check.verifiedAt,
        missing,
        mismatch,
      }
      const entry = await audit(task.id, String(input.actorRole ?? ROLE.WRITER), 'artifact:verify', {
        version,
        snapshot_id: snap.snapshot_id,
        current_snapshot_id: currentSnapshotId,
        same,
        complete,
        missing: missing.length,
        mismatch: mismatch.length,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      let summary
      if (same) {
        summary =
          `制品 ${version} 的快照校验**通过**：${snap.files.length} 个文件与登记哈希全部一致` +
          `（snapshot_id ${snap.snapshot_id.slice(0, 16)}…，校验时间 ${rec.snapshot.verified_at}）。`
      } else if (complete) {
        summary =
          `制品 ${version} 的文件**全部对得上**，但重算出的 snapshot_id 与登记时不同` +
          `（登记 ${snap.snapshot_id.slice(0, 16)}… / 重算 ${currentSnapshotId.slice(0, 16)}…）—— 登记记录可能被手改过。\n` +
          '出路：重新登记一个带 files 的制品版本。'
      } else {
        summary =
          `制品 ${version} 的快照校验**不通过**。\n` +
          renderSnapshotCheckLines({ missing, mismatch }).join('\n') +
          '\n两条出路（选一条）：\n' +
          '  ① 把文件恢复成登记时的内容，然后重跑 `pipeline_artifact { action: "verify", version: "' + version + '" }` —— ' +
          '文件对得上就会把快照标回**完整**；\n' +
          '  ② 内容确实要改：重新登记带 files 的新版本（pipeline_artifact { files: [...] }），' +
          '再让编写重交 dev_to_test / 测试重验 / 审核重绑新版本（审核绑定键仍是 artifact_version）。\n' +
          '★ 在这一步之前，L3+ 的关单会被 artifact_snapshot_complete 判据拦住。'
      }
      return {
        ok: same,
        task,
        version,
        artifact: rec,
        snapshot: rec.snapshot,
        snapshot_id: snap.snapshot_id,
        current_snapshot_id: currentSnapshotId,
        snapshot_complete: complete,
        verified: same,
        same,
        missing,
        mismatch,
        summary,
      }
    },

    /**
     * 回滚：把某个历史版本的制品重新登记为当前版本（不删旧版本）。
     */
    async rollbackArtifact(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      if (input.actorRole !== ROLE.WRITER && input.actorRole !== ROLE.HUMAN) {
        return deny('ROLE_NOT_ALLOWED', `只有编写角色或人工能回滚制品，当前调用方是「${roleLabel(input.actorRole)}」。`)
      }
      const src = task.artifacts.find((a) => a.version === input.version)
      if (src === undefined) {
        return deny('NOT_FOUND', `没有制品版本 ${input.version}；已有版本：${task.artifacts.map((a) => a.version).join(', ') || '（无）'}`)
      }
      const content = await readFile(src.file, 'utf8')
      const res = await this.registerArtifact({
        taskId: input.taskId,
        actorRole: ROLE.WRITER,
        content,
        fileName: `${src.version}-rollback.txt`,
        note: `回滚自 ${src.version}`,
        actorAgentId: input.actorAgentId,
      })
      // ★ P1-10：回滚**不复制快照** —— 快照描述的是"那一版交付的 files"，原样搬到新版本号上
      //   会得到一个"从没被核对过却声称完整"的快照。旧版本上的快照仍留在旧版本上可追溯。
      if (res.ok === true) {
        res.summary +=
          `\n★ 回滚登记**不带快照**（旧版 ${src.version} 的快照仍留在它自己那一版上）。` +
          '若本任务是 L3+，关单前请用 `files` 重新登记一版完整的制品快照。'
      }
      return res
    },
  }
}
