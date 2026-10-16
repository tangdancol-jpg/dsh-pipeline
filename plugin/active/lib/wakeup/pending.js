/**
 * dsh-pipeline · 唤醒 · **"没人领的事件"清单**
 * ============================================================================
 * 现场（2026-10-16 · 真单 `T-20261016-ff9ba7`）
 * ----------------------------------------------------------------------------
 * 唤醒要投到"主对话所在会话"，找不到就不投。改前那种失败**只落在 append-only 的
 * `audit.jsonl` 里** —— 于是"人工请求投不出去"这件事**只存在于一个日志文件里**，
 * 主对话**没有任何确定的路子去捞它**。现场后果：请求静默积压，全靠人自己发现
 * （那张单 22 次 `wake:skipped / no-main-session`，跨两天）。
 *
 * 本模块给的是那条**确定的捞法**：`pipeline_status` 的 `pending_wakes`。
 * 主对话查状态查得最勤，于是"有事件没人领"这件事会**自己回到它眼前**。
 *
 * ---------------------------------------------------------------------------
 * 判据（三条，全部只读）
 * ----------------------------------------------------------------------------
 *   ① 取这张单的 `unresolved`（`lib/wakeledger.js`，由 `wakeup/waker.js` 的
 *      `noteUnclaimed()` **幂等**写入）；
 *   ② **剔掉后来已经投递成功的**（`deliveredKeyFormIn`，**新旧两种键形态都认**）
 *      —— 清单不许把"早就送到了"的旧条目一直报成待领（那会让清单变成噪音，
 *      而噪音等于没有清单）；
 *   ③ 按**待领键**去重（同一件事只出现一次）。
 *
 * ★ 三种理由**原样透出**，因为出路不一样：
 *   · `no-main-session`   ⇒ 主对话身份没了：`pipeline_task_open { task_id, reattach: true }`
 *   · `no-stable-identity`⇒ 这条事件没有稳定身份：等台账落地后由巡检再叫一次
 *   · `deliver-failed`    ⇒ 会话不可达：下一次同类事件会重投
 *   把三种压成一句话，等于把"该做什么"也一起吞掉了。
 *
 * ★ 纪律：**只读**（不写盘、不改入参、不抛）。账本没装配（自测替身 / 旧装配）
 *   ⇒ 空数组 —— 空清单是"没有待领"，不是"我不知道"。
 *
 * @module dsh-pipeline/lib/wakeup/pending
 */

import { deliveredKeyFormIn } from './keys.js'

/** 一次最多带回几条（清单是给人看的，不是日志导出）。 */
export const PENDING_WAKES_LIMIT = 50

/**
 * ★★ **A 件 ③（2026-10-16）：待领清单之后那句「下一步该做什么」。**
 *
 * 为什么必须有它：`pending_wakes` 改前只给出"有 N 条事件没被投出去"——**说出了症状，
 * 没说处方**。现场（真单 `T-20261016-ff9ba7`）的后果就是：主对话看得见"22 次没人领"，
 * 却不知道该做什么才能让它们不再积压。
 *
 * 判据与文案**唯一出处**（`pipeline_status` 直接铺开它，不另抄一份 —— 抄一份就会漂移）。
 * `taskId` 为空时把命令里的 id 写成占位符，**不编造**一个 id。
 *
 * @param {string} [taskId]
 * @returns {string[]} 逐行（开头带缩进，直接塞进状态正文）
 */
export function pendingWakesNextSteps(taskId = '') {
  const id = String(taskId ?? '')
  const arg = id.length > 0 ? `task_id: "${id}"` : 'task_id: "<任务id>"'
  return [
    '  ★ **下一步（按顺序做，第一条通常就够了）**：',
    `     ① 在本会话调 \`pipeline_task_open { ${arg}, reattach: true }\` 把主对话身份认回来 ——`,
    '        身份一回来，**后续**同类事件就投得出去了（投递的目标取自 `task.contacts.main`）；',
    '     ② 认领成功之后随便调一次 `pipeline_status`：主对话的工具出口会顺手把',
    '        "主对话在哪个会话"重新登记进 `task.contacts.main`（`lib/wakeup/main-contact.js`）；',
    '     ③ ★ **已经积压的这些不会自动重投**（上面每条的"待领键"就是它们各自的身份）：',
    '        要么按待领键重放一次对应动作，要么由主对话按上面的清单逐条处置。',
  ]
}

/**
 * 这张单"没人领的事件"清单。
 *
 * @param {object|null} ledger - 已播报账本（`wakeup/waker.js` 的 `ledger`）
 * @param {string} taskId
 * @returns {Array<{key:string, kind:string, actor:string, reason:string, at:string, what:string}>}
 */
export function pendingWakesOf(ledger, taskId) {
  if (ledger === null || ledger === undefined || typeof ledger.unresolvedEntries !== 'function') return []
  let list = []
  try {
    list = ledger.unresolvedEntries({ taskId: String(taskId ?? ''), limit: PENDING_WAKES_LIMIT })
  } catch {
    // 账本坏了不许把状态查询带崩 —— 但也不假装"没有待领"以外的东西（这里只能空）。
    return []
  }
  const out = []
  const seen = new Set()
  for (const e of Array.isArray(list) ? list : []) {
    const key = String(e?.detail?.key ?? '')
    if (key.length === 0 || seen.has(key)) continue
    // ② 后来投递成功的不再算待领（新旧两种键形态都认）。
    try {
      if (deliveredKeyFormIn(ledger, key, null) !== null) continue
    } catch {
      void 0
    }
    seen.add(key)
    out.push({
      key,
      kind: String(e?.kind ?? ''),
      actor: String(e?.actor ?? ''),
      reason: String(e?.reason ?? ''),
      at: String(e?.at ?? ''),
      what: '这条事件**没有被投出去**（原因见 reason）—— 捞法：pipeline_task_open { task_id, reattach: true } 把主对话身份认回来。',
    })
  }
  return out
}
