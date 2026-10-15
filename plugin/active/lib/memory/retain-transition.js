// 状态迁移 → 记忆：把"这一步是怎么走过来的"记成一条（复用 lib/store/transition-record.js 的产物）。
/**
 * dsh-pipeline · 记忆 · 状态迁移 → 记忆
 * ============================================================================
 * 设计 `04-接线点.md` §3.3 的原话：「落一条 `kind:'transition'` 的记忆 …… 没有它，
 * 记忆库里只有"结果"没有"过程"，recall 答不了**"上次是怎么走到这一步的"**」。
 *
 * ---------------------------------------------------------------------------
 * 为什么复用 `lib/store/transition-record.js`（而不是自己写一句 A→B）
 * ---------------------------------------------------------------------------
 * `from === to` 的迁移（例如 `handoff_to_supervisor`）**不改状态**，它只登记"谁递的"。
 * 那一类的价值全在"**记了什么**"上，而那句话已经有**唯一出处**（`describeTransitionRecord`，
 * 它连"台账落在 `task.hub.entry`"这种事都替我们核过）。
 * 本文件**只做搬运与截断**，不产生第二份措辞（`CONVENTIONS.md` §7：一个常量只有一个出处）。
 *
 * ★ 本文件是**纯函数 + 一个追加入口**：
 *   · {@link transitionRecord} 只造记录（不写盘、不读时钟 —— 时刻由调用方给）；
 *   · {@link appendTransition} 走 `append.js`（**绝不抛**）。
 *
 * ⚠️ **接线状态（如实写在这儿）**：E1 交付的是**模块 + 测试**；"谁调它"那一步**当时没接**。
 *   **E3 已接上** —— 落点是 `lib/store/lifecycle.js` 的 `transition()` 出口（`persist(task)` 之后），
 *   与 `review.js` 的关单触发一起（设计 `04-§3.1/§3.3`）。触发它的那次 `pipeline_transition`
 *   照旧只认自己的返回值：本函数**绝不抛**，且总开关关掉时**一个字节都不写**（判据 R13）。
 *
 * @module dsh-pipeline/lib/memory/retain-transition
 */

import { STATE_LABEL } from '../states.js'
import { describeTransitionRecord } from '../store/transition-record.js'
import { surfaceAllowed } from '../switch/gate.js'
import { appendRecords } from './append.js'
import { memoryFile } from './bank.js'
import { KIND, clip, emptyRefs, makeRecord } from './record.js'
import { aliasAll } from './alias.js'

/**
 * 这条写点归哪一条受开关管的面（**与 `retain-hook.js` 同一条**：两者都是"往记忆库写字"）。
 *
 * ★ 为什么必须过闸门：总开关关掉之后"记忆库一个字节都不变"是判据 R13 —— 只把
 *   `tools/post-execute` 那条缝摘掉、却让状态迁移照旧往库里写，就是**开关只关一半**。
 */
export const RETAIN_SURFACE = 'memory-retain'

/**
 * 一次状态迁移 → 一条记忆（**纯函数**）。
 *
 * @param {object} input
 * @param {object} input.task - 迁移**之后**的任务对象（`describeTransitionRecord` 要读它）
 * @param {string} input.from
 * @param {string} input.to
 * @param {string} input.event
 * @param {string} input.at - ISO 时刻（调用方给）
 * @param {string} [input.by] - 谁推的（角色 id）
 * @returns {{ok:true, record:object} | {ok:false, errors:string[]}}
 */
export function transitionRecord(input = {}) {
  const task = input.task !== null && typeof input.task === 'object' ? input.task : {}
  const taskId = String(task.id ?? input.task_id ?? '').trim()
  const from = String(input.from ?? '').trim()
  const to = String(input.to ?? '').trim()
  const event = String(input.event ?? '').trim()
  const by = String(input.by ?? '').trim()

  const label = (s) => (s.length > 0 ? STATE_LABEL[s] ?? s : '?')
  const move = from === to ? `状态未变（${label(to)}）` : `${label(from)} → ${label(to)}`
  // ★ `describeTransitionRecord` 的产物是**多行**的说明；本域只取一行摘要（`clip` 会把换行折成空格）。
  const detail = String(describeTransitionRecord({ event, task, from, to, at: String(input.at ?? '') }) ?? '')
  const tail = clip(detail, 120)

  return makeRecord({
    id: `${KIND.TRANSITION}:${taskId}:${event}:${String(input.at ?? '').trim()}`,
    at: String(input.at ?? ''),
    kind: KIND.TRANSITION,
    text: `任务 ${taskId || '?'}：${move}（事件 ${event}${by.length > 0 ? `，by ${by}` : ''}）${tail.length > 0 ? `｜${tail}` : ''}`,
    entity: aliasAll([`task:${taskId}`, `state:${to}`, ...(by.length > 0 ? [`role:${by}`] : [])]),
    refs: emptyRefs({
      task_id: taskId,
      state: to,
      state_label: label(to),
      paths: [],
      handoff: '',
      artifact_version: '',
      roles: by.length > 0 ? aliasAll([`role:${by}`], 'role') : [],
    }),
  })
}

/**
 * 造一条迁移记忆并**追加进库**（绝不抛；总开关关掉时**一个字节都不写**）。
 *
 * @param {string} projectDir
 * @param {object} input - 同 {@link transitionRecord}
 * @param {object} [opts]
 * @param {{appendFile:Function, mkdir:Function, readFile:Function}} [opts.fs]
 * @param {(m:string)=>void} [opts.warn]
 * @param {(()=>object|null)|object|null} [opts.swOf] - 晚绑定的开关（见 `switch/gate.surfaceAllowed`）
 * @returns {Promise<{ok:boolean, appended:number, skipped:number, path:string, reason:string}>}
 */
export async function appendTransition(projectDir, input, opts = {}) {
  // ★★ off ⇒ 连"该不该写"都不再问第二遍：直接返回（与 `live-doc-write` 同一条纪律）。
  if (!surfaceAllowed(opts.swOf ?? null, RETAIN_SURFACE)) {
    return { ok: false, appended: 0, skipped: 0, path: '', reason: 'SWITCH_OFF' }
  }
  const made = transitionRecord(input)
  if (made.ok !== true) {
    return { ok: false, appended: 0, skipped: 0, path: '', reason: `BAD_RECORD: ${made.errors.join('；')}` }
  }
  return appendRecords(memoryFile(projectDir), [made.record], opts)
}
