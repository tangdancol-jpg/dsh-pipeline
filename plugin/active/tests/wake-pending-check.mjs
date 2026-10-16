/**
 * dsh-pipeline · **唤醒找不到主对话会话 ⇒ 不许静默**自测
 * ============================================================================
 *     node tests/wake-pending-check.mjs            # 单跑这一条
 *
 * 现场（2026-10-16 · 真单 `T-20261016-ff9ba7`，全部来自该单的 `audit.jsonl`）：
 *   · `task.json` 顶层**连 `contacts` 键都没有** ⇒ 唤醒的两道来源（内存登记表 +
 *     `task.contacts.main`）**全空**；
 *   · **22 行 `wake:skipped / reason:"no-main-session"`**，2026-10-15T17:55:26Z →
 *     2026-10-16T13:41:36Z —— **跨两天、跨多次重启**；
 *   · 人工请求因此**投不出去**，主对话只能靠自己主动查才看得到。⇒ **结构性**。
 *
 * 本套只钉**一件事**：找不到主对话会话时**不许静默** ——
 * audit 行带**明确的待领标记** + 账本 `unresolved` 收得到
 * （`pipeline_status.pending_wakes` 的数据面）+ `warn` 出声 + 清单**剔掉后来已投递的**。
 * 三样缺一不可；"投递失败的兜底出口"必须有**确定的捞法**。
 *
 * ★ 兜底解析与幂等那两组断言在 `tests/wake-last-resort-check.mjs`（拆文件，见
 *   `CONVENTIONS.md` 的「单个测试文件 ≤ 400 行」）；共享夹具在
 *   `tests/wake-no-main-fixtures.mjs`。
 *
 * ★ 纪律：全程零副作用（临时目录，跑完即删；**不碰**线上任务数据与会话目录）；
 *   **零 skip / 零 todo / 零 only**。
 *
 * @module dsh-pipeline/tests/wake-pending-check
 */

import { join } from 'node:path'

import { createWakeLedger, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { pendingWakesOf } from '../lib/wakeup/pending.js'
import { createRecorder, liveShapedTask, makeTmpScope, makeWaker, renderReport, runDirect } from './wake-no-main-fixtures.mjs'

const rec = createRecorder()

/**
 * ★★ 本套的主角：登记表空、落盘兜底空、台账兜底**没接线**（= 改前那种装配）
 * ⇒ 事件投不出去，但它**必须在三个地方同时可见**。
 */
async function checkNotSilent(scope) {
  const G = '1 找不到主对话会话 ⇒ 不许静默'
  const dir = scope.dir('silent')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const task = liveShapedTask()
  const { waker, sinks, warns, host } = await makeWaker({ ledger, task })
  const r = await waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '一条人工请求', disc: 'HR-1' })

  rec.add(G, '① 既有口径不变：`reason === "no-main-session"`、且**一次都没注入**', r.reason === 'no-main-session' && r.injected === false && host.delivered.length === 0, `reason=${r.reason} delivered=${host.delivered.length}`)

  const row = sinks.lines.find((l) => l.action === 'wake:skipped' && l.detail?.reason === 'no-main-session')
  rec.add(G, '② ★★ **可见落点（a）**：audit 行带**明确的待领标记**（`pending` / `unclaimed` / `claim_via`）—— 不再是"一次普通的跳过"', row !== undefined && row.detail?.pending === true && String(row.detail?.unclaimed ?? '').length > 0 && row.detail?.claim_via === 'pipeline_status', JSON.stringify({ pending: row?.detail?.pending, unclaimed: row?.detail?.unclaimed, claim_via: row?.detail?.claim_via }))

  const un = ledger.unresolvedEntries({ taskId: task.id })
  rec.add(G, '③ ★★ **可见落点（b）**：这条事件进账本 unresolved（`pipeline_status.pending_wakes` 的数据面）', un.length === 1 && un[0].reason === 'no-main-session' && un[0].detail?.key === row?.detail?.unclaimed, JSON.stringify(un.map((e) => ({ reason: e.reason, key: e.detail?.key }))))

  rec.add(G, '④ 而且**出声**（`warn`）—— 改前这里一声不响', warns.some((m) => m.includes('投不出去')), `warns=${warns.length}`)

  const surfaced = pendingWakesOf(ledger, task.id)
  const firstKey = surfaced[0]?.key ?? ''
  rec.add(G, '⑤ ★★ **带出**：`pending_wakes` 把它带回给主对话（逐条含待领键与出路）', surfaced.length === 1 && firstKey === row?.detail?.unclaimed && surfaced[0]?.reason === 'no-main-session' && String(surfaced[0]?.what ?? '').includes('reattach'), JSON.stringify(surfaced))

  if (firstKey.length > 0) {
    ledger.record({ key: firstKey, task_id: task.id, kind: 'human', actor: 'writer', target: 'session-main-live', request_id: 'req-1' })
  }
  rec.add(G, '⑥ 清单剔掉**后来已投递**的（否则清单变成噪音 = 等于没有清单）', firstKey.length > 0 && pendingWakesOf(ledger, task.id).length === 0, `pending=${pendingWakesOf(ledger, task.id).length}`)
}

export async function runWakePendingCheck() {
  rec.items.length = 0
  const scope = makeTmpScope('pending')
  try {
    await checkNotSilent(scope)
  } finally {
    // ★ 在**套内**清（不是只在直接跑的分支里清）：`run-all` 走的是这个入口。
    scope.cleanup()
  }
  return renderReport('【唤醒 · 找不到主对话会话 ⇒ 不许静默 · wake-pending-check】', rec)
}

// ★ 临时目录已在 `runWakePendingCheck` 的 `finally` 里清掉，这里不再传 cleanup。
runDirect(runWakePendingCheck, import.meta.url)
