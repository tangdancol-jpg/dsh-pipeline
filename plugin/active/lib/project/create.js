// 项目目录 · 幂等创建：建目录/建子目录，已存在就复用，绝不清理、搬移或删除用户内容。
/**
 * dsh-pipeline · 项目目录 · 幂等创建
 * ============================================================================
 * 裁定 D3：**建目录随开单幂等自动完成（无副作用）**；git 化必须显式确认。
 *
 * 「无副作用」在代码里的含义（三条，缺一条就是有副作用）：
 *   ① 已存在 ⇒ 什么都不写（`created:false`、`wrote:false`）；
 *   ② 目录**非空且不是本项目**（用户自己放的东西）⇒ **直接用**，不清理、不搬移、不删除；
 *   ③ 目录里已有文件 ⇒ 建目录动作**不碰**它们（本文件只 `mkdir`，从不 `rm`、从不 `rename`）。
 *
 * ★ 本文件里**没有**任何删除/移动系统调用 —— 这是结构上的保证，不是纪律上的保证。
 *
 * @module dsh-pipeline/lib/project/create
 */

import { mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { pathKey } from '../util.js'
import { PROJECTS_PARENT_DIR } from './id.js'

/**
 * 幂等建一个目录。
 *
 * @param {string} dir - 绝对路径
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Promise<{ok:true, dir:string, existed:boolean, created:boolean, wrote:boolean, empty:boolean|null}
 *          |{ok:false, code:string, message:string}>}
 */
export async function ensureProjectDir(dir, opts = {}) {
  const target = String(dir ?? '').trim()
  if (target.length === 0) {
    return { ok: false, code: 'NO_DIR', message: '要建的项目目录是空的。' }
  }
  const abs = resolve(target)
  if (pathKey(abs).length === 0) {
    return { ok: false, code: 'NO_DIR', message: `项目目录 \`${target}\` 归一之后为空，拒绝创建。` }
  }

  if (existsSync(abs)) {
    const st = statSync(abs)
    if (!st.isDirectory()) {
      return {
        ok: false,
        code: 'PATH_NOT_DIR',
        message: `${abs} 已经存在，但**不是目录**（是个文件）—— 停下报错，不覆盖、不删除用户的东西。`,
      }
    }
    return { ok: true, dir: abs, existed: true, created: false, wrote: false, empty: null }
  }

  if (opts.dryRun === true) {
    return { ok: true, dir: abs, existed: false, created: false, wrote: false, empty: null }
  }

  // recursive:true ⇒ 父根不存在也一并建出来（边界：project_dir 指向不存在路径 ⇒ 视为未建，重新创建）。
  await mkdir(abs, { recursive: true })
  return { ok: true, dir: abs, existed: false, created: true, wrote: true, empty: true }
}

/**
 * 幂等建项目目录下的**子目录**（目前只有 `docs/`）。
 *
 * @param {string} projectDir
 * @param {{docs?:boolean, dryRun?:boolean}} [opts]
 * @returns {Promise<{ok:true, root:string, made:string[], skipped:string[]}|{ok:false, code:string, message:string}>}
 */
export async function ensureProjectSubdirs(projectDir, opts = {}) {
  const root = ensureRootOrError(projectDir)
  if (!root.ok) return root
  const made = []
  const skipped = []
  const want = opts.docs === false ? [] : ['docs']
  for (const name of want) {
    const abs = resolve(root.dir, name)
    if (existsSync(abs)) {
      skipped.push(abs)
      continue
    }
    if (opts.dryRun === true) {
      made.push(abs)
      continue
    }
    await mkdir(abs, { recursive: true })
    made.push(abs)
  }
  return { ok: true, root: root.dir, made, skipped }
}

/**
 * 项目目录的**父根**（用于提示"目录会建在哪"，不改任何东西）。
 *
 * @param {string} dir
 * @returns {string}
 */
export function parentOf(dir) {
  const abs = resolve(String(dir ?? ''))
  const i = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
  return i > 0 ? abs.slice(0, i) : abs
}

/**
 * 判断一个目录"是不是空的"（只读；建目录之前用来决定要不要提示"复用非空目录"）。
 *
 * @param {string} dir
 * @param {(d:string)=>Promise<string[]>} [readdirNames] - 注入便于测试
 * @returns {Promise<{ok:true, exists:boolean, empty:boolean, entries:number}>}
 */
export async function probeDir(dir, readdirNames) {
  const abs = resolve(String(dir ?? ''))
  if (!existsSync(abs)) return { ok: true, exists: false, empty: true, entries: 0 }
  if (typeof readdirNames !== 'function') return { ok: true, exists: true, empty: false, entries: -1 }
  const names = await readdirNames(abs)
  return { ok: true, exists: true, empty: names.length === 0, entries: names.length }
}

/** 内部：把 projectDir 收成一个可用的绝对路径。 */
function ensureRootOrError(projectDir) {
  const s = String(projectDir ?? '').trim()
  if (s.length === 0) return { ok: false, code: 'NO_PROJECT_DIR', message: '项目目录是空的。' }
  return { ok: true, dir: resolve(s) }
}

/**
 * 全新项目的默认父根（**与 `id.js` 同源，这里只做展示用的一行**）。
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function projectsParentOf(dshHome) {
  return resolve(String(dshHome ?? ''), PROJECTS_PARENT_DIR)
}
