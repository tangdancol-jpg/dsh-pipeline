// 项目目录 · 开单后自动建立：幂等建目录 + 绑定写回 + 留痕（`WIRING.md` §W9 的落点）。
/**
 * dsh-pipeline · 项目目录 · 开单后自动建立
 * ============================================================================
 * `pipeline_project_init` 是一个**工具** —— 不调它就不会发生。而用户要的是
 * 「**派单后先建**」：那是**自动**语义。只给工具等于把这一步变成"主对话要记得做"，
 * 而"要记得做"从来不是机制。
 *
 * 所以本文件把那条自动路径收成一个函数，由 `lib/tools/intake.js` 在
 * `store.open()` **成功之后**调一次（见 `WIRING.md` §W9）。
 *
 * ---------------------------------------------------------------------------
 * 四条纪律（每一条都有理由，改之前先读）
 * ---------------------------------------------------------------------------
 *   ① `git` **一律 false** —— git 化必须由主对话**显式确认**（裁定 11）。
 *      自动建目录**绝不能**顺手把仓库也开了；不开仓库时走快照版本目录。
 *   ② **失败不阻断开单** —— 这一步是便利性。"在哪干活"还没定，不该让单子开不出来；
 *      真正需要目录的地方（派活面）会看到 `dispatchable:false` 并如实报出来。
 *   ③ **绑定写回走唯一写点** `id.js` 的 `bindProject`（冲突就拒绝，不静默覆盖）。
 *   ④ 留痕走 `store.recordAudit`：它 `loadTask → push → persist`，
 *      所以第 ③ 步写进任务卡的 `project_id` / `project_dir` **跟着一起落盘**
 *      （任务卡在缓存里就是同一个对象 —— 这也是这里不必自建落盘通道的原因）。
 *
 * ★ 本文件**不 import `lib/tools/intake.js`**，依赖方向是单向的（intake → 本文件）。
 *
 * @module dsh-pipeline/lib/project/auto-init
 */

import { bindProject } from './id.js'
import { ensureAgentsMd as defaultEnsureAgentsMd } from './agents-md.js'
import { projectInitCore } from '../tools/project.js'

/** 审计动作名（唯一出处）。 */
export const AUTO_INIT_ACTION = 'project:auto_init'

/**
 * 从任务卡的授权面取路径清单。
 *
 * ★ 开单那一刻 `change_scope` 通常还是 `undefined`（它是计划 AI 的产物）——
 *   那时返回 `undefined`（**不是**空数组）：两者语义不同，
 *   空数组 = "授权面确实为空 ⇒ 不建目录"，`undefined` = "还没定 ⇒ 继续往下找别的根"。
 *
 * @param {object} task
 * @returns {string[]|undefined}
 */
function scopePathsOf(task) {
  const scope = task?.change_scope
  if (!Array.isArray(scope)) return undefined
  return scope.map((e) => (typeof e === 'string' ? e : e?.path)).filter((p) => typeof p === 'string' && p.length > 0)
}

/**
 * ★ **开单后自动建项目目录**（幂等、无副作用）。
 *
 * @param {object} input
 * @param {object} input.task - 刚开出来的任务卡（会被就地绑定 `project_id` / `project_dir`）
 * @param {object} input.store - 任务存储（只用它的 `recordAudit`）
 * @param {string} [input.dshHome] - DSH 用户目录（全新项目的默认父根；缺 ⇒ 可读的 `NO_DSH_HOME`）
 * @param {string} [input.actorRole] - 留痕用
 * @param {Date} [input.now]
 * @param {Function} [input.ensureAgentsMd] - P2 的落盘步骤（注入；缺省用真实现）
 * @returns {Promise<{ok:true, project_id:string, project_dir:string, mode:string, created:boolean, action:string}
 *          |{ok:false, code:string, reason:string, project_id:string, project_dir:string}>}
 */
export async function autoInitProjectDir(input = {}) {
  const task = input.task ?? null
  const store = input.store ?? null
  if (task === null || typeof task !== 'object' || store === null || typeof store.recordAudit !== 'function') {
    return skip('NO_TASK', '没有任务卡（或 store 不带 recordAudit）—— 跳过自动建项目目录。')
  }

  const proj = await projectInitCore(
    {
      taskId: task.id,
      // ★ 纪律 ①：一律不开仓库（自动路径**没有**用户确认这一步的容身之处）。
      git: false,
      actorRole: input.actorRole,
      scopePaths: scopePathsOf(task),
    },
    {
      task,
      dshHome: input.dshHome,
      ensureAgentsMd: typeof input.ensureAgentsMd === 'function' ? input.ensureAgentsMd : defaultEnsureAgentsMd,
      now: input.now,
    },
  )

  if (proj.ok !== true || String(proj.project_dir ?? '').length === 0) {
    // ★ 纪律 ②：**不抛、不阻断**，把可读的原因原样带回给调用方。
    return skip(proj.code ?? 'NO_PROJECT_DIR', proj.summary ?? proj.message ?? '自动建项目目录没做成。', proj)
  }

  // ★ 纪律 ③：绑定写回（唯一写点在 `id.js`；冲突会被它拒，不静默覆盖）。
  const bound = bindProject(task, { projectId: proj.project_id, projectDir: proj.project_dir })
  if (bound.ok !== true) {
    return skip(bound.code ?? 'BINDING_FAILED', bound.message ?? '项目目录建出来了，但绑定写回被拒。', proj)
  }

  // ★ 纪律 ④：留痕 —— 这一次 `persist` 把上面那次绑定一起落盘。
  await store.recordAudit(task.id, input.actorRole ?? '', AUTO_INIT_ACTION, {
    project_id: proj.project_id,
    project_dir: proj.project_dir,
    mode: proj.mode,
  })

  return {
    ok: true,
    action: AUTO_INIT_ACTION,
    project_id: proj.project_id,
    project_dir: proj.project_dir,
    mode: proj.mode,
    created: proj.created === true,
    summary: proj.summary ?? '',
  }
}

/** 统一的"没做成"形状（`project_dir` 恒为空串，调用方一眼看得出没绑上）。 */
function skip(code, reason, proj = {}) {
  return { ok: false, code, reason, project_id: String(proj.project_id ?? ''), project_dir: '', mode: String(proj.mode ?? '') }
}
