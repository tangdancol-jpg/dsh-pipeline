/**
 * dsh-pipeline · 唤醒 · 主对话会话的**末位兜底解析**
 * ============================================================================
 * 现场（2026-10-16 · 真单 `T-20261016-ff9ba7`）
 * ----------------------------------------------------------------------------
 * 唤醒要投到"主对话所在会话"，而目标只有两个来源（见 `wakeup/waker.js` 的
 * 「判据 ②」那一段）：① 进程内存登记表；② 落盘那份 `task.contacts.main`。
 *
 * 这张单**两份都是空的**：`task.json` 顶层连 `contacts` 键都没有
 * （`generation` 在整个 3.6 MB 的文件里一次都没出现过），而内存登记表重启即空。
 * 后果不是偶发，是**整张单 22 次唤醒全部 `wake:skipped / no-main-session`**
 * （2026-10-15T17:55:26Z → 2026-10-16T13:41:36Z，跨两天、跨多次重启），
 * 人工请求静默积压，全靠人自己发现。
 *
 * ---------------------------------------------------------------------------
 * 为什么"两份都空"会**自愈不了**（这是一条死锁，不是一次意外）
 * ---------------------------------------------------------------------------
 *   · `rememberMainCaller`（`wakeup/main-contact.js:85-98`）只认**进程内存里的
 *     `main` 令牌**（`tokens.tasksOfAgent`），而令牌表是**进程内存态**、重启即清空；
 *   · 重启后主对话身份唯一的**自动**恢复路径是 `mainReattachEnabled`
 *     （`lib/config.js:109-127`）→ `judgeMainClaim`（`lib/reattach.js`），
 *     而它**要求 `contacts.main` 已经存在**（否则判 `NO_RECORD` —— 恰好就是缺的那份）；
 *   ⇒ **缺记录 ⇒ 认不回身份 ⇒ 写不了记录**。`lib/tools/intake.js:165-170` 把同一个死锁
 *     写在"重新认领"那一支的注释里（"认领要令牌 → 令牌要主对话 → 主对话要身份"），
 *     只是它盯着的是**手动**那一条出路。
 *
 * 本模块补的是这条环上的**解析**一侧：目标从"这张单**自己**的台账"里找 ——
 * 不新造身份、不写记录、不外推别的单。
 *
 * ---------------------------------------------------------------------------
 * 判据（**只用这张单自己写下的证据**）
 * ----------------------------------------------------------------------------
 * 从 `task.history` 里取**最后一条**同时满足下列三条的行：
 *   ① `actor === 'main'`（逐字）—— 席位会话**永远不选**：投到席位上是投错人；
 *   ② `agent` 是**非空字符串** —— 没有它就无从谈起；
 *   ③ `action` **不在** `MECHANISM_BOOKKEEPING_ACTIONS` 里（与 `lib/orphan.js`
 *      **同一份**清单，不另立一份）—— 机制自己的记账行不是"主对话在这里"的证据。
 *      ⚠️ 这一条**必须**有：`index.js` 的留痕回调把唤醒那一族的 `actor` 写死成
 *      `'main'`，不剔就会把机制自己的行当成主对话的足迹。
 *
 * ★ 三条纪律：
 *   · **只读**：纯函数，不写盘、不改入参、不抛；
 *   · **不冒名**：本模块**不写** `task.contacts.main`。它给的是一条**兜底提示**，
 *     不是权威登记 —— 一旦把近似物写进那份记录，"谁是主对话"就再没人说得清了
 *     （与 `lib/reattach.js` 的纪律①"不许用近似物冒名"同源）；
 *   · **可分辨**：调用方必须把来源如实标成 `last-known-agent`
 *     （不是 `registry`、也不是 `persisted-contact`），并出声 ——
 *     兜底路径**不许安静**（兜底只在"正常两条来源都空"时生效，那本身就是异常）。
 *
 * @module dsh-pipeline/lib/wakeup/last-resort
 */

import { MECHANISM_BOOKKEEPING_ACTIONS } from '../orphan.js'

/**
 * 兜底来源的名字（**机器可读、稳定**）。
 *
 * 它出现在两处，两处**逐字相同**：`wake()` 成功投递时 audit 行的 `target_via`，
 * 以及返回值的 `targetVia`。事后据此能分辨"这条唤醒是**登记表**给的地址，
 * 还是**从台账里翻出来的**"—— 后者要复查。
 */
export const LAST_RESORT_VIA = 'last-known-agent'

/**
 * 从这张单自己的台账里解析"主对话上一次在哪个会话里"。
 *
 * @param {object|null} task - 任务（读的是 `history`；不改它）
 * @returns {{agentId:string, at:string, action:string}|null} 取不到就是 `null`（**不是**抛错）
 */
export function lastKnownMainAgentOf(task) {
  if (task === null || typeof task !== 'object') return null
  const history = Array.isArray(task.history) ? task.history : []
  // ★ 倒着找：要的是**最后一条**证据（最近的那次"主对话在这里"）。
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]
    if (row === null || typeof row !== 'object') continue
    // ① 只有主对话自己的行才算（席位的 `agent` 是席位会话，投过去是投错人）。
    if (String(row.actor ?? '') !== 'main') continue
    // ② 会话 id 必须是非空字符串。
    const agentId = typeof row.agent === 'string' ? row.agent : ''
    if (agentId.length === 0) continue
    // ③ 机制自己的记账行不算证据（与 orphan.js 同一份清单）。
    const action = String(row.action ?? '')
    if (MECHANISM_BOOKKEEPING_ACTIONS.includes(action)) continue
    return { agentId, at: typeof row.at === 'string' ? row.at : '', action }
  }
  return null
}

/**
 * 判据的全部常量（**只读导出**，自测与报告据此断言，不手抄字符串）。
 */
export const LAST_RESORT = Object.freeze({
  via: LAST_RESORT_VIA,
  /** 为什么只有这三种行**不算**证据（写在这里，免得下一个人以为漏了）。 */
  excluded: 'actor!==main / agent 非字符串或为空 / action 在 MECHANISM_BOOKKEEPING_ACTIONS 里',
})
