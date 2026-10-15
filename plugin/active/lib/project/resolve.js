// 项目目录 · 解析（既存优先）：先复用已绑定的 project_dir，再复用时既存根，最后才按首单 task_id 新建。
/**
 * dsh-pipeline · 项目目录 · 解析与复用
 * ============================================================================
 * 裁定 U2（**既存优先**）：「已有仓库 / 既存目录的项目：**直接复用该既存根为项目目录，
 * 不按 task_id 新建目录**；task_id 命名只用于**全新项目**。」
 * 裁定 10：后续单**先查 `project_dir`**，命中即复用（一项目多单）。
 *
 * ---------------------------------------------------------------------------
 * 解析顺序（**这是本文件的全部内容**，顺序不能调）
 * ---------------------------------------------------------------------------
 *   ① 本单已绑定 `project_dir` ⇒ 复用它（绑定不匹配 ⇒ **停下报错**；目录没了 ⇒ 重新建出来，算 `recreated`）；
 *   ② 有**既存根**（已有仓库 / 既存目录）⇒ 复用它（**不**按 task_id 新建）；
 *   ③ 给了 `scope_paths` ⇒ 项目目录 = 授权面的**公共根**（裁定 8：项目目录与授权面同源）；
 *   ④ 都没有 ⇒ **全新项目**：`<DSH 用户目录>/projects/<首单 task_id>`（裁定 D2）。
 *
 * 边界：`scope_paths` **显式为空数组** ⇒ 不建目录、不报致命错，只记 `project_id`
 *   （并在返回值里把 `dispatchable:false` 明说，让派活面看得见）。
 *
 * @module dsh-pipeline/lib/project/resolve
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { pathKey } from '../util.js'
import { commonScopeRoot } from './layout.js'
import { defaultProjectDir, directoryNameFor, projectIdOf, readBinding, verifyBinding } from './id.js'
import { ensureProjectDir } from './create.js'

/** 解析结果的四种形态。 */
export const RESOLVE_MODE = Object.freeze({
  REUSE: 'reuse',
  RECREATED: 'recreated',
  EXISTING: 'existing',
  SCOPE_ROOT: 'scope-root',
  CREATED: 'created',
  UNBOUND: 'unbound',
})

/**
 * 解析一个项目该用哪个目录。
 *
 * @param {object} input
 * @param {object} input.task - 任务卡（读 `project_id` / `project_dir`；**本函数不写它**）
 * @param {string} [input.existingRoot] - 既存根（已有仓库 / 既存目录）
 * @param {string} [input.dshHome] - DSH 用户目录（算全新项目默认父根用）
 * @param {string[]} [input.scopePaths] - 授权面路径（裁定 8 同源）
 * @param {boolean} [input.dryRun] - 只解析不落盘
 * @returns {Promise<{ok:true, mode:string, projectId:string, projectDir:string|null, created:boolean,
 *                    dispatchable:boolean, binding:{projectId:string|null, projectDir:string|null},
 *                    notes:string[]}|{ok:false, code:string, message:string}>}
 */
export async function resolveProjectDir(input = {}) {
  const task = input.task ?? {}
  const notes = []
  const binding = readBinding(task)

  // ① 已绑定 ⇒ 复用（一项目多单的入口）
  if (binding.bound) {
    const v = verifyBinding(task)
    if (!v.ok) return { ok: false, code: v.code, message: v.message }
    if (v.code === 'DIR_NAME_DIFFERS') notes.push(v.message)

    const dir = resolve(binding.projectDir)
    if (existsSync(dir)) {
      notes.push(`复用已绑定的项目目录：${dir}`)
      return done(RESOLVE_MODE.REUSE, binding.projectId, dir, false, notes)
    }
    // 边界：project_dir 指向不存在路径 ⇒ 视为未建，重新创建。
    const made = await ensureProjectDir(dir, { dryRun: input.dryRun === true })
    if (!made.ok) return made
    notes.push(`绑定的项目目录不存在 ⇒ 视为未建，重新创建：${dir}`)
    return done(RESOLVE_MODE.RECREATED, binding.projectId, made.dir, made.created, notes)
  }

  if (binding.projectId !== null || binding.projectDir !== null) {
    return {
      ok: false,
      code: 'PARTIAL_BINDING',
      message:
        `任务 ${task.id ?? '?'} 的项目绑定只有一半（project_id=${binding.projectId ?? '(空)'}，` +
        `project_dir=${binding.projectDir ?? '(空)'}）—— 停下报错，不猜、不补。`,
    }
  }

  // ② 既存根优先（裁定 U2）
  const existing = String(input.existingRoot ?? '').trim()
  if (existing.length > 0) {
    const abs = resolve(existing)
    const pid = projectIdOf(task.id)
    if (!pid.ok) return pid
    if (!existsSync(abs)) {
      return {
        ok: false,
        code: 'EXISTING_ROOT_MISSING',
        message: `既存根 ${abs} 不存在 —— 既存优先的前提是"它真的在"；请确认路径或改走全新项目路径。`,
      }
    }
    notes.push(`既存优先：复用既存根 ${abs} 为项目目录，**不按 task_id 新建**（裁定 U2）。`)
    return done(RESOLVE_MODE.EXISTING, pid.projectId, abs, false, notes)
  }

  // ③ 授权面公共根（裁定 8 同源）
  if (Array.isArray(input.scopePaths)) {
    if (input.scopePaths.length === 0) {
      const pid = projectIdOf(task.id)
      if (!pid.ok) return pid
      notes.push('授权面为空 ⇒ **不建目录、不报致命错**，只记 project_id（边界条件）。派活面应看见 dispatchable:false。')
      return {
        ok: true,
        mode: RESOLVE_MODE.UNBOUND,
        projectId: pid.projectId,
        projectDir: null,
        created: false,
        dispatchable: false,
        binding,
        notes,
      }
    }
    const common = commonScopeRoot(input.scopePaths)
    if (!common.ok) {
      return { ok: false, code: common.reason, message: `授权面各条没有公共根（${common.reason}），无法据此定项目目录。` }
    }
    const abs = existsSync(common.root) ? common.root : resolve(common.root)
    if (existsSync(abs)) {
      const pid = projectIdOf(task.id)
      if (!pid.ok) return pid
      notes.push(`项目目录取自授权面公共根 ${abs}（裁定 8：项目目录与授权面同源）。`)
      return done(RESOLVE_MODE.SCOPE_ROOT, pid.projectId, abs, false, notes)
    }
    const made = await ensureProjectDir(abs, { dryRun: input.dryRun === true })
    if (!made.ok) return made
    const pid = projectIdOf(task.id)
    if (!pid.ok) return pid
    notes.push(`授权面公共根 ${made.dir} 尚不存在 ⇒ 建出来（授权面与项目目录同源）。`)
    return done(RESOLVE_MODE.SCOPE_ROOT, pid.projectId, made.dir, made.created, notes)
  }

  // ④ 全新项目（裁定 D2）
  const pid = projectIdOf(task.id)
  if (!pid.ok) return pid
  const def = defaultProjectDir(input.dshHome, pid.projectId)
  if (!def.ok) return def
  const made = await ensureProjectDir(def.dir, { dryRun: input.dryRun === true })
  if (!made.ok) return made
  const name = directoryNameFor(pid.projectId)
  if (name.ok && name.changed) notes.push(`project_id 含不安全字符，目录名归一为 \`${name.name}\`。`)
  notes.push(`全新项目 ⇒ 默认父根 projects/<首单 task_id>：${made.dir}（裁定 D2）。`)
  return done(RESOLVE_MODE.CREATED, pid.projectId, made.dir, made.created, notes)
}

/**
 * 同项目第 2..N 单：只读 `project_dir` 即命中同一目录（验收 A02 / T01）。
 *
 * ★ 与 {@link resolveProjectDir} 的区别只有一条：**不建目录**。
 *   第二单的职责是"确认还是那个目录"，不是"再建一次"。
 *
 * @param {object} task
 * @returns {{ok:true, reused:boolean, projectId:string|null, projectDir:string|null, message:string}
 *          |{ok:false, code:string, message:string}}
 */
export function reuseProjectDir(task) {
  const binding = readBinding(task)
  if (!binding.bound) {
    return { ok: true, reused: false, projectId: null, projectDir: null, message: '本单还没绑定项目 —— 由 resolveProjectDir 走首次解析。' }
  }
  const v = verifyBinding(task)
  if (!v.ok) return { ok: false, code: v.code, message: v.message }
  const dir = resolve(binding.projectDir)
  if (!existsSync(dir)) {
    return { ok: false, code: 'BOUND_DIR_MISSING', message: `绑定的项目目录 ${dir} 不存在 —— 交给 resolveProjectDir 重新建（不是新建一个别的目录）。` }
  }
  return {
    ok: true,
    reused: true,
    projectId: binding.projectId,
    projectDir: dir,
    message: `同项目第 N 单复用同一目录：${dir}（project_id=${binding.projectId}）。`,
  }
}

/** 内部：把成功结果收成同一个形状。 */
function done(mode, projectId, projectDir, created, notes) {
  return {
    ok: true,
    mode,
    projectId,
    projectDir,
    created: created === true,
    dispatchable: true,
    binding: { projectId, projectDir: pathKey(projectDir) },
    notes,
  }
}
