// 唤醒 · 「投递之后任务有没有真进展」的判据（§9 噪声 ①）：状态前进或出现新交接物 ⇒ 该投递视为已接管。
/**
 * 现场：「已消费」原先只认显式 `markConsumed`（主对话调会写盘的工具时才记）。席位走别的路推进了状态
 * （自愈建的席位、角色自己 `pipeline_transition`），那条投递就永远停在"未消费" ⇒ 巡检反复报
 * `unconsumed-delivery`、升级链再升一层 —— 状态机明明已经往前走了。
 *
 * 判据（只读入参，不读盘、不写盘）：投递时刻**之后**（严格晚于，秒级同口径）出现过——
 *   · 一次**真的前进**的状态迁移：`transition:*` 且 `from ≠ to`，且目标不是冻结 / 等待态
 *     （被冻结、去等人答复不是"有人接管了这条投递"）；或
 *   · 一份新的交接物（`task.handoffs[].created_at`）。
 * 机制自己的记账行（`wake:*` 等）不是 `transition:*`，天然不算。
 * ★ 宁可漏判（多报一次），不误判（把没人管的投递洗成已接管）：时间读不出来的一律不算。
 *
 * @module dsh-pipeline/lib/wakeup/progress
 */

import { ST, WAITING_STATES } from '../states.js'

/** 进了这些状态不算"前进"。 */
const NOT_PROGRESS_TARGETS = new Set([ST.BLOCKED, ...WAITING_STATES])

const msOf = (v) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : null
}

/**
 * 某个时刻之后最早的那一次真进展。
 *
 * @param {object|null} task
 * @param {string} afterIso - 投递时刻（账本里的 `at`）
 * @returns {{at:string, action:string}|null}
 */
export function progressAfter(task, afterIso) {
  const after = msOf(afterIso)
  if (after === null || task === null || typeof task !== 'object') return null
  const hits = []
  for (const e of Array.isArray(task.history) ? task.history : []) {
    const action = String(e?.action ?? '')
    if (!action.startsWith('transition:')) continue
    if (e.from === e.to || NOT_PROGRESS_TARGETS.has(String(e.to ?? ''))) continue
    const at = msOf(e.at)
    if (at !== null && at > after) hits.push({ ms: at, at: String(e.at), action })
  }
  for (const h of Array.isArray(task.handoffs) ? task.handoffs : []) {
    const at = msOf(h?.created_at)
    if (at !== null && at > after) hits.push({ ms: at, at: String(h.created_at), action: `handoff:${String(h.kind ?? '?')}` })
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => a.ms - b.ms)
  return { at: hits[0].at, action: hits[0].action }
}
