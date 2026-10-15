// 快照目录 · 命名与创建：`<项目目录>/<快照版本号>/`，已存在则幂等复用、绝不覆盖既有内容。
/**
 * dsh-pipeline · 快照目录 · 命名与创建
 * ============================================================================
 * 裁定 3：**git 优先**；快照只在**无 git** 时用。
 * 裁定 D1：快照落在 `<项目目录>/<快照版本号>/…`，即「根」= `project_dir` 本身。
 *
 * 本文件只管两件事：**目录叫什么**、**怎么幂等地把它建出来**。
 * 「下一个版本号是多少」归 `snapshot-next.js`；「哪个最新」归 `snapshot-compare.js`。
 *
 * @module dsh-pipeline/lib/project/snapshot-dir
 */

import { mkdir, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isInside } from '../util.js'
import { ordinalOfSegment, parseSnapshotVersion } from './snapshot-parse.js'

/**
 * 快照目录名 = 快照版本号本身（不再加前缀、不再加后缀）。
 *
 * ★ 为什么目录名与版本号**逐字相同**：版本号是给人看的（`b.2026.10.15.A-01`），
 *   目录名再包一层（如 `snap-b.2026…`）会让"从目录名反推版本号"变成一次解析，
 *   而解析就有解析错的可能 —— 同名就没有这个问题。
 *
 * @param {string} version
 * @returns {{ok:true, name:string}|{ok:false, code:string, message:string}}
 */
export function snapshotDirName(version) {
  const p = parseSnapshotVersion(version)
  if (!p.ok) return p
  return { ok: true, name: p.version }
}

/**
 * 快照目录的绝对路径。
 *
 * @param {string} projectDir - 项目目录（快照根）
 * @param {string} version
 * @returns {{ok:true, dir:string, name:string}|{ok:false, code:string, message:string}}
 */
export function snapshotDirFor(projectDir, version) {
  const name = snapshotDirName(version)
  if (!name.ok) return name
  const root = resolve(String(projectDir ?? ''))
  if (root.length === 0) {
    return { ok: false, code: 'NO_PROJECT_DIR', message: '快照目录的父根（项目目录）是空的，无法定位快照目录。' }
  }
  return { ok: true, dir: join(root, name.name), name: name.name }
}

/**
 * **幂等**建快照目录。
 *
 * 边界（逐条对应需求分析的边界清单）：
 *   · 「同版本号快照目录已存在：幂等，不覆盖既有内容」⇒ `created:false`、**一个字节都不写**；
 *   · 「project_dir 指向不存在路径：视为未建，重新创建」⇒ 父根不存在时**递归建**；
 *   · 路径逃逸（算出来的目录不在项目目录之下）⇒ 拒绝（不给"往上写"留后门）。
 *
 * @param {object} input
 * @param {string} input.projectDir
 * @param {string} input.version
 * @param {boolean} [input.dryRun] - 只算路径不落盘
 * @returns {Promise<{ok:true, dir:string, name:string, created:boolean, existed:boolean, wrote:boolean}
 *          |{ok:false, code:string, message:string}>}
 */
export async function createSnapshotDir(input = {}) {
  const { projectDir, version, dryRun = false } = input
  const target = snapshotDirFor(projectDir, version)
  if (!target.ok) return target
  const root = resolve(String(projectDir ?? ''))
  if (!isInside(root, target.dir) || resolve(target.dir) === root) {
    return {
      ok: false,
      code: 'SNAPSHOT_DIR_ESCAPES_PROJECT',
      message: `算出来的快照目录 ${target.dir} 不在项目目录 ${root} 之内 —— 拒绝创建（快照必须落在项目目录里，才与授权面同源）。`,
    }
  }
  const existed = existsSync(target.dir)
  if (existed) {
    const st = statSync(target.dir)
    if (!st.isDirectory()) {
      return {
        ok: false,
        code: 'SNAPSHOT_PATH_NOT_DIR',
        message: `${target.dir} 已经存在但**不是目录** —— 停下报错，不覆盖、不删除用户的东西。`,
      }
    }
    return { ok: true, dir: target.dir, name: target.name, created: false, existed: true, wrote: false }
  }
  if (dryRun === true) {
    return { ok: true, dir: target.dir, name: target.name, created: false, existed: false, wrote: false }
  }
  await mkdir(target.dir, { recursive: true })
  return { ok: true, dir: target.dir, name: target.name, created: true, existed: false, wrote: true }
}

/**
 * 列出一个项目目录下**已经存在的**快照版本号（按目录名认，不读文件内容）。
 *
 * @param {string} projectDir
 * @returns {Promise<{ok:true, versions:string[], malformed:string[]}|{ok:false, code:string, message:string}>}
 */
export async function listSnapshotVersions(projectDir) {
  const root = resolve(String(projectDir ?? ''))
  if (!existsSync(root)) return { ok: true, versions: [], malformed: [] }
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    return { ok: false, code: 'READDIR_FAILED', message: `读不出项目目录 ${root}：${err?.message ?? err}` }
  }
  const versions = []
  const malformed = []
  for (const e of entries) {
    if (e.isDirectory() !== true) continue
    if (!/^b\./.test(e.name)) continue
    const p = parseSnapshotVersion(e.name)
    if (p.ok) versions.push(e.name)
    else malformed.push(e.name)
  }
  return { ok: true, versions, malformed }
}

/**
 * 当天已有段的最大值（给 `snapshot-next.js` 用；本函数只做"取最大"这一件事）。
 *
 * @param {string[]} versions
 * @param {{year:number, month:number, day:number}} parts
 * @returns {number} 当天最大段序数；当天没有任何快照时返回 0
 */
export function maxSegmentOrdinalOnDay(versions, parts) {
  let max = 0
  for (const v of Array.isArray(versions) ? versions : []) {
    const p = parseSnapshotVersion(v)
    if (!p.ok) continue
    if (p.year !== parts.year || p.month !== parts.month || p.day !== parts.day) continue
    const seg = ordinalOfSegment(p.segment)
    if (seg.ok && seg.ordinal > max) max = seg.ordinal
  }
  return max
}
