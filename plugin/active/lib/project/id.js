// 项目标识 · project_id ↔ 项目目录的绑定：一项目多单的落点，绑定冲突时停下报错而不是静默改写。
/**
 * dsh-pipeline · 项目标识与绑定
 * ============================================================================
 * 裁定 10：目录名用**首单 task_id**，并新增 `project_id` / `project_dir` 两字段，
 * 解决「**单 ≠ 项目，一项目多单**」（裁定 4）。
 *
 * ---------------------------------------------------------------------------
 * 三个概念，别混
 * ---------------------------------------------------------------------------
 *   · `task_id`    = 一张单（一次交付）的 id，形如 `T-20261016-abc123`
 *   · `project_id` = **一个项目**的 id。它的取值 = **首单的 task_id**
 *                    （裁定 10 原话：「目录名用首单 task_id」—— 名与 id 同源，少一个字段就少一处漂移）
 *   · `project_dir`= 该项目的**绝对路径**。一个项目一个目录、一个仓库（裁定 11）
 *
 * 后续单（同项目的第 2、3… 张单）**先查 `project_dir`**，命中即复用 —— 不再建目录。
 *
 * @module dsh-pipeline/lib/project/id
 */

import { join, resolve } from 'node:path'

import { pathKey } from '../util.js'

/** 新增的两个任务卡字段（唯一出处，别处不许再手抄这两个字符串）。 */
export const PROJECT_ID_FIELD = 'project_id'
export const PROJECT_DIR_FIELD = 'project_dir'

/** 全新项目的默认父根目录名（裁定 D2）。 */
export const PROJECTS_PARENT_DIR = 'projects'

/**
 * 由首单 task_id 得到 project_id。
 *
 * 恒等映射是**故意的**：裁定 10 说"目录名用首单 task_id"，若再另生成一个随机
 * `project_id`，就会出现"目录名从 task_id 来、project_id 从别处来"两份真相。
 *
 * @param {string} firstTaskId
 * @returns {{ok:true, projectId:string}|{ok:false, code:string, message:string}}
 */
export function projectIdOf(firstTaskId) {
  const id = String(firstTaskId ?? '').trim()
  if (id.length === 0) {
    return { ok: false, code: 'EMPTY_TASK_ID', message: '首单 task_id 是空的，无法得到 project_id。' }
  }
  return { ok: true, projectId: id }
}

/**
 * 目录名（= 首单 task_id），并做**文件系统安全**归一。
 *
 * 只拒绝/替换真正危险的东西（路径分隔符、`..`、盘符、控制字符、Windows 保留名），
 * **不改大小写、不加随机后缀** —— 目录名必须还能被人一眼认回是哪张单。
 *
 * @param {string} projectId
 * @returns {{ok:true, name:string, changed:boolean}|{ok:false, code:string, message:string}}
 */
export function directoryNameFor(projectId) {
  const raw = String(projectId ?? '').trim()
  if (raw.length === 0) return { ok: false, code: 'EMPTY_PROJECT_ID', message: 'project_id 是空的，无法得到目录名。' }
  if (raw === '.' || raw === '..') {
    return { ok: false, code: 'UNSAFE_PROJECT_ID', message: `project_id \`${raw}\` 不能当作目录名。` }
  }
  const unsafe = /[\\/:*?"<>|\u0000-\u001f]/.test(raw)
  const name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim()
  if (name.length === 0) {
    return { ok: false, code: 'UNSAFE_PROJECT_ID', message: `project_id \`${raw}\` 归一之后成了空串，拒绝当作目录名。` }
  }
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  const finalName = reserved.test(name) ? `${name}-proj` : name
  return { ok: true, name: finalName, changed: unsafe || finalName !== raw }
}

/**
 * 全新项目的默认父根（裁定 D2）：`<DSH 用户目录>/projects/<首单 task_id>`。
 *
 * ★ 只用于**全新项目**（没有任何既存根可复用）。已有仓库/既存目录**不适用**这条 ——
 *   那种情况走 `resolve.js` 的"既存优先"。
 *
 * @param {string} dshHome - DSH 用户目录（如 `%USERPROFILE%\.dsh`）
 * @param {string} projectId
 * @returns {{ok:true, dir:string}|{ok:false, code:string, message:string}}
 */
export function defaultProjectDir(dshHome, projectId) {
  const home = String(dshHome ?? '').trim()
  if (home.length === 0) {
    return { ok: false, code: 'NO_DSH_HOME', message: '不知道 DSH 用户目录，无法算全新项目的默认父根。' }
  }
  const name = directoryNameFor(projectId)
  if (!name.ok) return name
  return { ok: true, dir: join(resolve(home), PROJECTS_PARENT_DIR, name.name) }
}

/**
 * 读一张单上的项目绑定。
 *
 * @param {object} task
 * @returns {{projectId:string|null, projectDir:string|null, bound:boolean}}
 */
export function readBinding(task) {
  const t = task ?? {}
  const projectId = typeof t[PROJECT_ID_FIELD] === 'string' && t[PROJECT_ID_FIELD].length > 0 ? t[PROJECT_ID_FIELD] : null
  const projectDir = typeof t[PROJECT_DIR_FIELD] === 'string' && t[PROJECT_DIR_FIELD].length > 0 ? t[PROJECT_DIR_FIELD] : null
  return { projectId, projectDir, bound: projectId !== null && projectDir !== null }
}

/**
 * 校验一张单上已有的绑定**自洽**（不写盘、不改字段）。
 *
 * 边界（需求分析原话）：「`project_dir` 存在但 `project_id` 不匹配（被人手工改过）：
 * **停下报错，不静默覆盖**」。
 *
 * ★ 这里刻意**不**去读盘判断目录存不存在 —— 那是 `resolve.js` 的活。
 *   本函数只回答"这两个字段彼此是否说得通、与首单是否说得通"。
 *
 * @param {object} task
 * @param {{firstTaskId?:string}} [opts] - 已知的项目首单 id（可选；给了就一并核对）
 * @returns {{ok:boolean, code:string, message:string, projectId:string|null, projectDir:string|null}}
 */
export function verifyBinding(task, opts = {}) {
  const b = readBinding(task)
  if (!b.bound) {
    // 只写了一个字段 —— 半绑定状态，必须报出来（另一半是"没有 project_id 的目录"）。
    if (b.projectId !== null || b.projectDir !== null) {
      return {
        ok: false,
        code: 'PARTIAL_BINDING',
        message:
          `任务 ${task?.id ?? '?'} 的项目绑定只有一半（project_id=${b.projectId ?? '(空)'}，` +
          `project_dir=${b.projectDir ?? '(空)'}）—— 两字段必须同时有或同时无，否则"复用哪个目录"没有答案。`,
        projectId: b.projectId,
        projectDir: b.projectDir,
      }
    }
    return { ok: true, code: 'UNBOUND', message: '尚未绑定项目（首次派单时绑定）。', projectId: null, projectDir: null }
  }

  const first = String(opts.firstTaskId ?? '').trim()
  if (first.length > 0 && pathKey(b.projectId) !== pathKey(first)) {
    return {
      ok: false,
      code: 'PROJECT_ID_MISMATCH',
      message:
        `任务 ${task?.id ?? '?'} 的 project_id（${b.projectId}）与项目首单（${first}）**不一致**。\n` +
        '★ 边界：project_dir 存在但 project_id 不匹配（被人手工改过）⇒ **停下报错，不静默覆盖**。\n' +
        '下一步：人工确认该项目到底属于谁，再决定改哪一个字段。',
      projectId: b.projectId,
      projectDir: b.projectDir,
    }
  }

  const dir = resolve(b.projectDir)
  const derived = directoryNameFor(b.projectId)
  if (derived.ok && pathKey(dir).split('/').pop() !== pathKey(derived.name)) {
    return {
      ok: true,
      code: 'DIR_NAME_DIFFERS',
      message:
        `绑定自洽，但目录名（${pathKey(dir).split('/').pop()}）与 project_id（${b.projectId}）不同名。\n` +
        '★ 这**不算错误**：裁定 U2 说"已有仓库/既存目录直接复用，不按 task_id 新建"，那种情况下两者本来就不同名。',
      projectId: b.projectId,
      projectDir: b.projectDir,
    }
  }

  return { ok: true, code: 'OK', message: `项目绑定自洽：project_id=${b.projectId} ⇒ ${b.projectDir}`, projectId: b.projectId, projectDir: b.projectDir }
}

/**
 * 把项目绑定写进一张单（**唯一的写点**）。
 *
 * 幂等：同样的值再写一次 ⇒ `changed:false`，一个字节不动。
 * 冲突：已有绑定且新值不同 ⇒ **拒绝**（除非显式 `force:true`，且必须给 `why`）。
 *
 * @param {object} task - 任务对象（**原地修改**，落盘由调用方负责）
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.projectDir
 * @param {boolean} [input.force]
 * @param {string} [input.why]
 * @returns {{ok:boolean, changed:boolean, code:string, message:string}}
 */
export function bindProject(task, input = {}) {
  const t = task
  if (t === null || typeof t !== 'object') {
    return { ok: false, changed: false, code: 'NO_TASK', message: '绑定项目需要一张任务卡对象。' }
  }
  const id = String(input.projectId ?? '').trim()
  const dir = String(input.projectDir ?? '').trim()
  if (id.length === 0 || dir.length === 0) {
    return { ok: false, changed: false, code: 'BAD_BINDING', message: '绑定项目必须同时给 project_id 与 project_dir（两字段同源，缺一不可）。' }
  }

  const cur = readBinding(t)
  const next = { projectId: id, projectDir: resolve(dir) }
  if (cur.bound) {
    if (pathKey(cur.projectId) === pathKey(next.projectId) && pathKey(cur.projectDir) === pathKey(next.projectDir)) {
      return { ok: true, changed: false, code: 'ALREADY_BOUND', message: `任务 ${t.id} 已经绑定到同一个项目（${cur.projectDir}），不重复写。` }
    }
    if (input.force !== true) {
      return {
        ok: false,
        changed: false,
        code: 'BINDING_CONFLICT',
        message:
          `任务 ${t.id} 已经有项目绑定（project_id=${cur.projectId} ⇒ ${cur.projectDir}），` +
          `与本次要写的（project_id=${next.projectId} ⇒ ${next.projectDir}）不同。\n` +
          '★ 边界：binding 冲突时**停下报错、不静默覆盖**。确需改绑请显式传 force=true 并说明 why。',
      }
    }
    if (String(input.why ?? '').trim().length === 0) {
      return { ok: false, changed: false, code: 'FORCE_NEEDS_WHY', message: '强制改绑必须给 why（这条会留痕，不能空着）。' }
    }
  }

  t[PROJECT_ID_FIELD] = next.projectId
  t[PROJECT_DIR_FIELD] = next.projectDir
  return {
    ok: true,
    changed: true,
    code: cur.bound ? 'REBOUND' : 'BOUND',
    message: `任务 ${t.id} 绑定项目：project_id=${next.projectId} ⇒ ${next.projectDir}`,
  }
}
