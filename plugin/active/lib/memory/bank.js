// 记忆库 · 路径解析：项目记忆库 = `<project_dir>/.pipeline/_memory`，档案根 = `<project_dir>/.pipeline`。
/**
 * dsh-pipeline · 记忆 · 库位置（**纯路径**，不读盘、不建目录）
 * ============================================================================
 * 用户裁定（本单硬约束③）：**项目记忆库 = `<project_dir>/.pipeline/_memory/`** ——
 * 复用已定的 `project_dir`，**不用** `ctx.storageDomain`（理由见设计
 * `design/memory/02-DSH-原生设施.md` §3.4：storageDomain 的根固定在 `<home>/storages`，
 * 与"一项目一库"冲突）。
 *
 * ---------------------------------------------------------------------------
 * 为什么路径必须从这里出（不手抄）
 * ---------------------------------------------------------------------------
 * `.pipeline` 的位置**一处定义**在 `lib/project/layout.js:57`（`projectLayout().pipelineDir`）。
 * 别处再拼一次 `join(dir, '.pipeline')` 就是第二份坐标 —— 布局一改，两份就漂移。
 * 所以本文件只做一件事：把 `layout.js` 的结论 + `_memory` 这个名字拼起来。
 *
 * ★ 为什么目录名是 `_memory`（下划线前缀）：`.pipeline/` 下还住着 `T-*` 任务目录，
 *   而 `lib/store/purge.js` 会**按 `TERMINAL_STATES` 扫目录**做终态清理。
 *   用 `T-` 形状或普通名，会被那套扫描误认成"某张任务单"（设计 `04` §8.4）。
 *
 * ★ 本文件**没有副作用**：不 `existsSync`、不 `mkdir`、不 `readdir`。
 *   "库在不在"是调用方的事（E0 的 `recall` 库不存在 ⇒ 返回空 + 一句人话，**不建目录**）。
 *
 * @module dsh-pipeline/lib/memory/bank
 */

import { join } from 'node:path'

import { projectLayout } from '../project/layout.js'

/**
 * 记忆库的目录名（`.pipeline/` 下的下划线子目录）。
 *
 * ⚠️ 改它会**移动全部既有记忆**（老库读不到）。真要改名，配套给一次性迁移，
 *    不要只改这一个常量。
 */
export const MEMORY_DIR_NAME = '_memory'

/** 记忆库的正文文件（JSONL：一行一条记忆，追加语义 —— 见 E1 的 `append.js`）。 */
export const MEMORY_FILE_NAME = 'memory.jsonl'

/** 项目活文档（E3 由状态迁移触发重建；E0 不写它）。 */
export const LIVE_DOC_FILE_NAME = 'MEMORY.md'

/** 任务目录的形状（既有约定：`.pipeline/T-<日期>-<短码>/`）。 */
export const TASK_DIR_RE = /^T-/

/**
 * 档案根 = 既有的 `<project_dir>/.pipeline`。
 *
 * @param {string} projectDir
 * @returns {string} 绝对路径；`projectDir` 为空 ⇒ `''`（调用方据此报 `NO_PROJECT_DIR`）
 */
export function archiveDir(projectDir) {
  const dir = String(projectDir ?? '').trim()
  if (dir.length === 0) return ''
  return projectLayout(dir).pipelineDir
}

/**
 * ★ 记忆库根 = `<project_dir>/.pipeline/_memory`（设计 `01` §3 的"项目库"那一行）。
 *
 * @param {string} projectDir
 * @returns {string} 绝对路径；`projectDir` 为空 ⇒ `''`
 */
export function memoryDir(projectDir) {
  const base = archiveDir(projectDir)
  return base.length === 0 ? '' : join(base, MEMORY_DIR_NAME)
}

/**
 * 记忆库正文文件（JSONL）。
 *
 * @param {string} projectDir
 * @returns {string} 绝对路径；`projectDir` 为空 ⇒ `''`
 */
export function memoryFile(projectDir) {
  const dir = memoryDir(projectDir)
  return dir.length === 0 ? '' : join(dir, MEMORY_FILE_NAME)
}

/**
 * 项目活文档（`MEMORY.md`）。
 *
 * @param {string} projectDir
 * @returns {string} 绝对路径；`projectDir` 为空 ⇒ `''`
 */
export function liveDocFile(projectDir) {
  const dir = memoryDir(projectDir)
  return dir.length === 0 ? '' : join(dir, LIVE_DOC_FILE_NAME)
}

/**
 * 这个目录名是不是**任务目录**（`T-*`）。
 *
 * 用途：扫档案时把 `_memory/`、`_trash/`、`switch.json` 这类非任务项**明确排除**，
 * 而不是"看起来不像就跳过"。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isTaskDirName(name) {
  return TASK_DIR_RE.test(String(name ?? ''))
}

/**
 * 一次解析出调用方要的全部落点（**唯一出口**，避免各调用方各拼一半）。
 *
 * @param {string} projectDir - 项目目录（绝对路径；取不到就传空串）
 * @param {string} [reason] - `projectDir` 取不到时的原因（写进返回，供人话摘要引用）
 * @returns {{ok:boolean, reason:string, projectDir:string, archiveDir:string,
 *            memoryDir:string, memoryFile:string, liveDoc:string}}
 */
export function resolveBank(projectDir, reason = '') {
  const dir = String(projectDir ?? '').trim()
  if (dir.length === 0) {
    return {
      ok: false,
      reason: reason.length > 0 ? reason : 'NO_PROJECT_DIR',
      projectDir: '',
      archiveDir: '',
      memoryDir: '',
      memoryFile: '',
      liveDoc: '',
    }
  }
  return {
    ok: true,
    reason: '',
    projectDir: dir,
    archiveDir: archiveDir(dir),
    memoryDir: memoryDir(dir),
    memoryFile: memoryFile(dir),
    liveDoc: liveDocFile(dir),
  }
}
