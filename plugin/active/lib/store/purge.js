/**
 * dsh-pipeline · 任务存储 · **收尾清理**（终态单的目录归档 / 删除）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑦）
 * -----------------------------------------------------------------------------
 * 现场：用户要清掉几张跑完的旧单，而**插件没有任何"删除任务"的工具**；
 * 唯一官方出口是 `pipeline_transition { event: "cancel" }`（**只改状态、文件全留着**）。
 * 主对话想用 shell 手工删，又被守门那条「角色「main」不得通过 shell 修改项目文件」挡住
 * ⇒ `.pipeline` 只能靠人**去资源管理器里手删**。
 *
 * -----------------------------------------------------------------------------
 * 为什么不能"给主对话开 shell 的口子"
 * -----------------------------------------------------------------------------
 * 那条 shell 判据拦的是"**命令串里出现项目路径就放行/拒绝**"这一类**字符串匹配**，
 * 它本来就拦不住混淆写法（README 的诚实边界写得很清楚）。为了删几个目录去放宽它，
 * 等于把"主对话不得用 shell 改项目文件"这条**既有边界**换成一句口号。
 *
 * ⇒ 正确的路子是**开一条具名的、可审计的收尾通道**（本模块 + `pipeline_task_purge`），
 *   而不是把守门的口子挖大。它自带四条硬约束：
 *
 *   ① **只认终态单**（`closed` / `cancelled`）—— 在跑的单一个字节都不许动；
 *      ★ 这不是"礼貌"，是**判据**：非终态单里可能有席位正在写，删了就是数据损坏。
 *   ② **先留痕、后动手**：墓碑行写进 `<项目根>/.pipeline/_purge-log.jsonl`
 *      （**不在被删目录里**，所以删完还查得到：谁在什么时候、以什么理由、删了哪张单、多大）。
 *   ③ **默认进回收站**（`mode: "trash"` ⇒ 移到 `.pipeline/_trash/<任务id>-<时刻>/`），
 *      **可恢复**；真要永久删得显式 `mode: "delete"`（工具层还要求 `confirm: true`）。
 *   ④ **删不动就如实报错**，**绝不**"删一半当成功"（rename 失败、目录被占 ⇒ 原样报原因）。
 *
 * @module dsh-pipeline/lib/store/purge
 */

import { existsSync, renameSync, rmSync, statSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_STATES } from '../states.js'
import { nowIso } from '../util.js'

/** 归档目录名（在 `.pipeline/` 之下，与被删目录**平级** —— 所以不会跟着被删掉）。 */
export const TRASH_DIR_NAME = '_trash'

/** 墓碑账本文件名（只追加，永不删）。 */
export const PURGE_LOG_NAME = '_purge-log.jsonl'

/** 两种模式。 */
export const PURGE_MODES = Object.freeze(['trash', 'delete'])

/**
 * 递归统计一个目录的文件数与字节数（删之前先算，删完就没得算了）。
 *
 * @param {string} dir
 * @returns {{files:number, bytes:number}}
 */
export function measureDir(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(d, e.name)
      if (e.isDirectory()) {
        walk(abs)
        continue
      }
      if (!e.isFile()) continue
      files += 1
      try {
        bytes += statSync(abs).size
      } catch {
        /* 读不到大小就不计，不让它拦住清理 */
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/** `.pipeline/<任务id>` 是不是一个可以清理的目录名（防路径穿越）。 */
export function isSafeTaskDirName(taskId) {
  const s = String(taskId ?? '')
  if (s.length === 0 || s.length > 128) return false
  if (s === '.' || s === '..') return false
  return !s.includes('/') && !s.includes('\\') && !s.includes(':')
}

/** 终态判定（与状态机**同一份名单**，不另抄一份）。 */
export function isTerminalState(state) {
  return Array.isArray(TERMINAL_STATES) && TERMINAL_STATES.includes(String(state ?? ''))
}

/**
 * 「收尾清理」—— 由 `createTaskStore` 原位展开。
 *
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字
 */
export function purgeMethods(ctx) {
  const { root, taskDir, deny, loadTask, cache, cacheStamp } = ctx

  /** 墓碑账本（只追加，落在**被删目录之外**）。 */
  const purgeLogFile = () => join(root, PURGE_LOG_NAME)

  return {
    /** 墓碑账本的位置（只读导出：让状态查询 / 报告能指向它）。 */
    purgeLogPath: purgeLogFile(),

    /**
     * 归档 / 删除一张**终态**任务单。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {'trash'|'delete'} [input.mode] - 默认 `trash`（可恢复）
     * @param {string} [input.reason]
     * @param {string} [input.by] - 动作发起方（默认 main）
     * @returns {Promise<{ok:boolean, mode?:string, task_id?:string, moved_to?:string|null, files?:number, bytes?:number, purged_at?:string, error?:string, code?:string}>}
     */
    async purgeTask(input) {
      const taskId = String(input?.taskId ?? '').trim()
      const mode = PURGE_MODES.includes(input?.mode) ? input.mode : 'trash'
      if (!isSafeTaskDirName(taskId)) {
        return deny('BAD_TASK_ID', `任务 id 不合法（不许含路径分隔符）：${taskId}`)
      }
      // ① 只认终态单 —— 在跑的单一个字节都不许动。
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      if (!isTerminalState(task.state)) {
        return deny(
          'NOT_TERMINAL',
          `拒绝清理：任务 ${taskId} 现在停在「${task.state}」，**不是终态**。\n` +
            '★ 为什么这条是硬约束：非终态单里可能有席位正在写它自己的报告 / 交接物 —— ' +
            '删了就是**数据损坏**，而损坏是看不出来的。\n' +
            '要先收尾：pipeline_transition { event: "cancel" }（取消）或走完流程关单（close）。',
        )
      }
      const dir = taskDir(taskId)
      if (!existsSync(dir)) return deny('TASK_DIR_MISSING', `任务 ${taskId} 在册，但目录不在盘上：${dir}`)
      const size = measureDir(dir)
      const stamp = nowIso(new Date()).replace(/[:]/g, '')
      const to = mode === 'trash' ? join(root, TRASH_DIR_NAME, `${taskId}-${stamp}`) : null

      /**
       * ② **先留痕、后动手**。
       *
       * 墓碑行写在 `.pipeline/_purge-log.jsonl` —— 它在**被删目录之外**，
       * 所以 `mode: "delete"` 之后仍然查得到"谁在什么时候、以什么理由、删了哪张单"。
       * ⚠️ 先写再动手：写失败就**不动手**（宁可没删成，也不许删了没账）。
       */
      const tombstone = {
        at: nowIso(new Date()),
        task_id: taskId,
        state: String(task.state ?? ''),
        mode,
        to,
        files: size.files,
        bytes: size.bytes,
        by: String(input?.by ?? 'main'),
        reason: String(input?.reason ?? ''),
      }
      try {
        appendFileSync(purgeLogFile(), `${JSON.stringify(tombstone)}\n`, 'utf8')
      } catch (err) {
        return deny(
          'PURGE_LOG_FAILED',
          `拒绝清理：墓碑账本写不进去（${String(err?.message ?? err)}）。\n` +
            '★ 先留痕后动手是这条通道的硬约束 —— 记不上就不许删（否则会出现"删了没账"）。',
        )
      }

      // ③ 动手（trash = 先归档；delete = 直接删）。
      try {
        if (mode === 'trash') {
          mkdirSync(join(root, TRASH_DIR_NAME), { recursive: true })
          renameSync(dir, to)
        } else {
          rmSync(dir, { recursive: true, force: true })
        }
      } catch (err) {
        return deny(
          'PURGE_FAILED',
          `清理失败（**没有删一半当成功**）：${String(err?.message ?? err)}\n` +
            `任务目录：${dir}${to === null ? '' : `\n目标位置：${to}`}\n` +
            '常见成因：目录里有文件正被别的进程握着（编辑器 / 索引器 / 正在跑的会话）。' +
            '关掉它再试；墓碑账本里已经记了这一次尝试。',
        )
      }

      // ④ 从内存缓存里摘掉，别让后续读盘拿到一份已经不存在的任务。
      try {
        cache?.delete?.(taskId)
        cacheStamp?.delete?.(taskId)
      } catch {
        /* 缓存清理失败不该把已经完成的清理判成失败 */
      }

      /**
       * ⑤ 收尾留痕。
       *
       * ⚠️ **绝不能**走 `this.audit(taskId, …)` —— 那个入口会 `appendJsonl`
       * 到 `<任务目录>/audit.jsonl`，而目录刚被移走/删掉，它会把目录**重新建出来**
       * ⇒ 清理完又冒出一个空壳目录（本单第一版就踩了这个坑，测试当场抓住）。
       *
       * 所以：
       *   · `trash` ⇒ 往**归档副本**里补一行（留痕跟着这张单一起进回收站，捞回来还看得见）；
       *   · `delete` ⇒ 那一行就是 `.pipeline/_purge-log.jsonl` 里的墓碑（目录已经没了，没有落点）。
       */
      if (mode === 'trash' && to !== null) {
        try {
          appendFileSync(
            join(to, 'audit.jsonl'),
            `${JSON.stringify({ at: tombstone.at, task_id: taskId, actor: tombstone.by, action: 'task:purge', mode, files: size.files, bytes: size.bytes, reason: tombstone.reason })}\n`,
            'utf8',
          )
        } catch {
          /* 归档副本里补不上留痕不该把已经完成的清理判成失败（墓碑账本已经在） */
        }
      }

      return { ok: true, mode, task_id: taskId, moved_to: to, files: size.files, bytes: size.bytes, purged_at: tombstone.at }
    },
  }
}
