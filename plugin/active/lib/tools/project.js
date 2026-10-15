// 项目工具面 · `pipeline_project_init`：解析/建立项目目录、按显式确认决定走 git 还是快照、并留痕。
/**
 * dsh-pipeline · 工具面 · `pipeline_project_init`
 * ============================================================================
 * 这是 P1（项目目录 + 仓库）对外的**唯一入口**。它把四件事按固定顺序串起来：
 *
 *   ① **解析**项目目录（`resolve.js`：已绑定 ⇒ 既存根 ⇒ 授权面公共根 ⇒ 全新 projects/<首单id>）
 *   ② **幂等建目录**（`create.js`：已存在就什么都不写）
 *   ③ **git 化**（`git-init.js`：**只有 `git: true` 才开仓库**；否则一个 git 进程都不起）
 *   ④ **留痕**（`git-init.js` 的 `gitConfirmationRecord`：确认动作进台账，验收 A04）
 *
 * ---------------------------------------------------------------------------
 * 本文件的两条纪律
 * ---------------------------------------------------------------------------
 *   · **AGENTS.md 落盘不在本文件里** —— 它是 P2 的职责（`lib/project/agents-md.js`）。
 *     本文件通过 `ctx.ensureAgentsMd` **注入**那一步；没注入就如实报 `skipped`，
 *     **不假装写了**。这样 P1 与 P2 各自的提交都是自洽可加载的。
 *   · 本文件**不做任何远端动作** —— 那条在 `git-run.js` 里已经不可表达。
 *
 * @module dsh-pipeline/lib/tools/project
 */

import { S, tool, resolveActor } from './kit.js'
import { ensureProjectDir, ensureProjectSubdirs } from '../project/create.js'
import { checkGitConfirmation, gitConfirmationRecord, gitInitProject } from '../project/git-init.js'
import { gitPolicyFor } from '../project/policy.js'
import { RESOLVE_MODE, resolveProjectDir } from '../project/resolve.js'
import { latestSnapshot } from '../project/snapshot-compare.js'
import { createSnapshotDir, listSnapshotVersions } from '../project/snapshot-dir.js'
import { nextSnapshotVersion } from '../project/snapshot-next.js'
import { bindProject, readBinding } from '../project/id.js'

/** 工具名（唯一出处）。 */
export const PROJECT_INIT_TOOL_NAME = 'pipeline_project_init'

/**
 * ★ **核心动作**（与工具包装分开，便于直接单测 —— 不必造一个宿主 `defineTool`）。
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {boolean} [input.git] - ★ **主对话显式确认**：true 才开仓库
 * @param {string} [input.existingRoot] - 既存根（裁定 U2 既存优先）
 * @param {string[]} [input.scopePaths] - 授权面（裁定 8 同源）
 * @param {boolean} [input.dryRun]
 * @param {string} [input.reason] - 确认开/不开仓库的理由（留痕）
 * @param {string} input.actorRole
 * @param {object} ctx
 * @param {object} ctx.task - 任务卡（读 project_id / project_dir）
 * @param {string} [ctx.dshHome]
 * @param {Function} [ctx.ensureAgentsMd] - P2 注入的 AGENTS.md 步骤
 * @param {Function} [ctx.exec] - 注入的 git 执行器（测试用）
 * @param {Date} [ctx.now]
 * @returns {Promise<object>}
 */
export async function projectInitCore(input = {}, ctx = {}) {
  const task = ctx.task ?? null
  if (task === null || typeof task !== 'object') {
    return fail('NO_TASK', 'pipeline_project_init 需要一张任务卡（先开单）。')
  }
  const dryRun = input.dryRun === true

  // ---- ① 解析项目目录 ------------------------------------------------------
  const resolved = await resolveProjectDir({
    task,
    existingRoot: input.existingRoot,
    dshHome: ctx.dshHome,
    scopePaths: input.scopePaths,
    dryRun,
  })
  if (!resolved.ok) return fail(resolved.code, resolved.message)

  if (resolved.mode === RESOLVE_MODE.UNBOUND) {
    // 边界：scope_paths 为空 ⇒ 不建目录、不报致命错，只记 project_id。
    return {
      ok: true,
      code: 'SCOPE_EMPTY',
      task_id: task.id,
      project_id: resolved.projectId,
      project_dir: '',
      mode: resolved.mode,
      created: false,
      dispatchable: false,
      git_mode: 'snapshot',
      git_inited: false,
      committed: false,
      agents_md: { written: false, path: '', action: 'skipped' },
      snapshot: { version: '', dir: '', created: false },
      remote_untouched: true,
      notes: resolved.notes,
      summary:
        `任务 ${task.id} 的授权面为空 ⇒ **不建项目目录、不报致命错**，只记 project_id=${resolved.projectId}。\n` +
        '★ 派活面应看见 dispatchable=false（没有目录就没有可写的范围）。',
    }
  }

  const projectDir = resolved.projectDir

  // ---- ② 幂等建目录 --------------------------------------------------------
  const made = await ensureProjectDir(projectDir, { dryRun })
  if (!made.ok) return fail(made.code, made.message)
  if (!dryRun) {
    const sub = await ensureProjectSubdirs(projectDir, { docs: true })
    if (!sub.ok) return fail(sub.code, sub.message)
  }

  // ---- 已有快照（决定 git 策略里要不要提示迁移）-----------------------------
  const snap = await listSnapshotVersions(projectDir)
  const snapshots = snap.ok ? snap.versions : []
  const latest = latestSnapshot(snapshots)

  // ---- ③ git 化（只有显式确认才开）----------------------------------------
  const gitConfirmed = input.git === true
  const gate = checkGitConfirmation({ confirmed: gitConfirmed })
  const policy = gitPolicyFor({ repoPresent: false, userConfirmed: gitConfirmed, snapshotCount: snapshots.length })

  let gitResult = {
    inited: false,
    committed: false,
    alreadyRepo: false,
    commitMessage: '',
    files: [],
  }
  let agentsMd = { written: false, path: '', action: 'skipped' }

  if (gitConfirmed && !dryRun) {
    // 先把 AGENTS.md 落盘（P2 注入），再 commit —— 顺序不能反（验收 A05 要求三样一次做完）。
    if (typeof ctx.ensureAgentsMd === 'function') {
      const md = await ctx.ensureAgentsMd({ projectDir, task, mode: 'git' })
      if (!md.ok) return fail(md.code ?? 'AGENTS_MD_FAILED', md.message ?? 'AGENTS.md 落盘失败。')
      agentsMd = { written: md.written === true, path: md.path ?? '', action: md.action ?? 'unknown' }
    }
    const g = await gitInitProject({
      dir: projectDir,
      confirmed: true,
      agentsMdFile: agentsMd.path.length > 0 ? agentsMd.path : undefined,
      files: agentsMd.path.length > 0 ? [agentsMd.path] : undefined,
      exec: ctx.exec,
    })
    if (!g.ok) return fail(g.code, g.message)
    gitResult = {
      inited: g.inited,
      committed: g.committed,
      alreadyRepo: g.alreadyRepo,
      commitMessage: g.commitMessage,
      files: g.files,
    }
  } else if (gitConfirmed && dryRun) {
    gitResult = { ...gitResult, inited: false, committed: false, dryRun: true }
  }

  // ---- 无 git ⇒ 快照版本目录（编号 + 进位 + 建目录）------------------------
  let snapshot = { version: '', dir: '', created: false }
  if (gitConfirmed !== true || gitResult.alreadyRepo === true) {
    // 有 git 时不建快照（裁定 3：快照只在无 git 时用）。
  }
  if (gitConfirmed !== true) {
    const next = nextSnapshotVersion({ existing: snapshots, now: ctx.now instanceof Date ? ctx.now : new Date() })
    if (!next.ok) {
      // 段用尽（Z-99）等：原样把可照做的建议带回给模型。
      return fail(next.code, next.message, { project_id: resolved.projectId, project_dir: projectDir })
    }
    const dirRes = await createSnapshotDir({ projectDir, version: next.version, dryRun })
    if (!dirRes.ok) return fail(dirRes.code, dirRes.message)
    snapshot = { version: next.version, dir: dirRes.dir, created: dirRes.created }
  }

  const confirmRecord = gitConfirmationRecord({
    taskId: task.id,
    actorRole: input.actorRole,
    actorAgentId: input.actorAgentId,
    confirmed: gitConfirmed,
    reason: input.reason,
    at: ctx.now instanceof Date ? ctx.now : new Date(),
  })

  return {
    ok: true,
    code: 'OK',
    task_id: task.id,
    project_id: resolved.projectId,
    project_dir: projectDir,
    mode: resolved.mode,
    created: resolved.created === true || made.created === true,
    dispatchable: true,
    git_mode: policy.mode,
    git_inited: gitResult.inited,
    committed: gitResult.committed,
    agents_md: agentsMd,
    snapshot,
    confirm_record: confirmRecord,
    remote_untouched: true,
    notes: resolved.notes,
    summary: renderSummary({ task, resolved, policy, gitResult, agentsMd, snapshot, snapshots, latest, dryRun }),
  }
}

/** 摘要文案（给人看的；`summary` 是工具输出契约里必填的那一项）。 */
function renderSummary(ctx) {
  const { task, resolved, policy, gitResult, agentsMd, snapshot, snapshots, latest, dryRun } = ctx
  const lines = []
  lines.push(`项目目录：${resolved.projectDir}（方式 ${resolved.mode}${resolved.created ? '，本次新建' : '，已存在直接复用'}）`)
  lines.push(`  · project_id = ${resolved.projectId}（= 首单 task_id，裁定 10）`)
  lines.push(`  · 版本方案：${policy.mode}（${policy.reason.split('\n')[0]}）`)
  if (policy.mode === 'git') {
    lines.push(`  · git：${gitResult.alreadyRepo ? '已是仓库，未重复 init' : gitResult.inited ? 'git init 完成' : '未 init'}；commit=${gitResult.committed ? `成功（${gitResult.commitMessage}）` : '未做'}`)
    lines.push(`  · AGENTS.md：${agentsMd.written ? `已落盘 ${agentsMd.path}` : `未落盘（${agentsMd.action}）`}`)
    if (policy.migrateSnapshots) {
      lines.push(`  · ⚠ 仍有 ${snapshots.length} 个本地快照（最新 ${latest.latest ?? '?'}）：裁定 3 要求 git 化后**移除本地快照**并把最新内容提交进仓库 —— 此步由主对话确认。`)
    }
  } else {
    lines.push(`  · 快照版本目录：${snapshot.dir}（${snapshot.created ? '本次新建' : '已存在，幂等复用、未覆盖'}）`)
  }
  if (dryRun) lines.push('  · dryRun：只算计划，未落盘。')
  if (resolved.notes.length > 0) lines.push(...resolved.notes.map((n) => `  · ${n}`))
  lines.push('★ 全程没有 push / fetch / remote —— 远端未被触碰（验收 A06）。')
  return lines.join('\n')
}

/** 统一失败形状。 */
function fail(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    task_id: '',
    project_id: '',
    project_dir: '',
    mode: '',
    created: false,
    dispatchable: false,
    git_mode: '',
    git_inited: false,
    committed: false,
    agents_md: { written: false, path: '', action: 'skipped' },
    snapshot: { version: '', dir: '', created: false },
    confirm_record: null,
    remote_untouched: true,
    notes: [],
    summary: message,
    ...extra,
  }
}

/**
 * 工具定义（与其余 `pipeline_*` 工具同形）。
 *
 * @param {object} deps - `buildTools` 的依赖包（含 `defineTool` / `config` / `store`）
 * @returns {{projectInit:object}}
 */
export function buildProjectTools(deps) {
  const projectInit = tool(deps, {
    name: PROJECT_INIT_TOOL_NAME,
    mutating: true,
    description:
      '【主对话专用】项目目录与仓库：派单后**幂等**建立（或复用）项目目录，并按**显式确认**决定走 git 还是快照版本目录。' +
      '默认 `git: false` ⇒ **不开仓库、一个 git 进程都不起**，改走 `<项目目录>/<快照版本号>/`。' +
      '只在显式 `git: true` 时才 `git init` + 落 AGENTS.md + 首次 commit（裁定 11：主对话先行确认是否开仓库）。' +
      '★ 既存优先：已有仓库/既存目录**直接复用**，不按 task_id 新建（裁定 U2）。' +
      '★ 绝不 push / fetch / 改 remote —— 本批次不许任何远端写（验收 A06）。',
    parameters: {
      task_id: S('string', '任务 ID（首单建目录并写入 project_id / project_dir；后续单先查 project_dir 复用）'),
      git: S('boolean', '★ **显式确认开仓库**：只有 true 才 git init；缺省/false ⇒ 走快照版本目录'),
      existing_root: S('string', '既存根（已有仓库或既存目录）—— 给了就**直接复用**，不按 task_id 新建'),
      scope_paths: S('array', '授权面路径清单 —— 项目目录取其**公共根**（项目目录与授权面同源，裁定 8）'),
      dry_run: S('boolean', '只算计划不落盘'),
      reason: S('string', '开 / 不开仓库的理由（进确认台账，可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      code: S('string', '判据码（OK / GIT_NOT_CONFIRMED / SEGMENT_EXHAUSTED …）'),
      summary: S('string', '给人看的摘要'),
      task_id: S('string', '任务 ID'),
      project_id: S('string', '项目 ID（= 首单 task_id）'),
      project_dir: S('string', '项目目录绝对路径'),
      mode: S('string', '解析方式：reuse / recreated / existing / scope-root / created / unbound'),
      created: S('boolean', '本次是否新建了目录'),
      dispatchable: S('boolean', '现在能不能派活（授权面为空时为 false）'),
      git_mode: S('string', 'git / snapshot'),
      git_inited: S('boolean', '本次是否执行了 git init'),
      committed: S('boolean', '是否完成了首次 commit'),
      remote_untouched: S('boolean', '远端是否未被触碰（恒为 true）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail('NO_ACTOR', actor.error)
      const task = await deps.store.get(String(args.task_id ?? ''))
      if (task === null) return fail('TASK_NOT_FOUND', `找不到任务 ${args.task_id}。`)

      const res = await projectInitCore(
        {
          taskId: task.id,
          git: args.git === true,
          existingRoot: typeof args.existing_root === 'string' ? args.existing_root : '',
          scopePaths: Array.isArray(args.scope_paths) ? args.scope_paths : undefined,
          dryRun: args.dry_run === true,
          reason: typeof args.reason === 'string' ? args.reason : '',
          actorRole: actor.role,
          actorAgentId: actor.agentId ?? null,
        },
        { task, dshHome: deps.dshHome, ensureAgentsMd: deps.ensureAgentsMd, exec: undefined },
      )

      // 绑定写回任务卡（**唯一的写点**在 `id.js`；幂等，冲突就拒绝）。
      if (res.ok === true && res.project_dir.length > 0 && args.dry_run !== true) {
        const bound = bindAndPersist(deps, task, res)
        if (!bound.ok) return fail(bound.code, bound.message)
      }
      if (res.ok === true && res.confirm_record !== null && args.dry_run !== true) {
        // 确认动作留痕（验收 A04：确认动作在台账可查）。
        await deps.store.recordAudit(task.id, actor.role, 'project:git_confirm', res.confirm_record)
      }
      return res
    },
  })

  return { projectInit }
}

/** 把解析结果写回任务卡的 project_id / project_dir（幂等）。 */
async function bindAndPersist(deps, task, res) {
  const cur = readBinding(task)
  if (cur.bound && cur.projectDir === res.project_dir && cur.projectId === res.project_id) return { ok: true }
  const bound = bindProject(task, { projectId: res.project_id, projectDir: res.project_dir })
  if (!bound.ok) return bound
  if (bound.changed && typeof deps.store.persistTask === 'function') await deps.store.persistTask(task)
  return { ok: true }
}
