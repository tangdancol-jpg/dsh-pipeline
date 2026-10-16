/**
 * dsh-pipeline · **唤醒兜底解析与幂等**自测
 * ============================================================================
 *     node tests/wake-last-resort-check.mjs            # 单跑这一条
 *
 * 现场（2026-10-16 · 真单 `T-20261016-ff9ba7`）：唤醒的两道来源全空
 * （内存登记表随重启即空；`task.contacts.main` 压根没有这个键）
 * ⇒ `no-main-session`。本套钉的就是**补上的第三道来源**，以及它不许带来的副作用。
 *
 * 本套钉四件事（改前红、改后绿）：
 *   1) 兜底解析的判据（`lib/wakeup/last-resort.js`）：只用这张单**自己**的台账证据
 *      —— 席位行不选、机制记账行不选、没 `agent` 不选。
 *   2) **找得到时正常投递**（登记表 / 落盘兜底 / 台账兜底三条来源逐一走通），
 *      且兜底**只读不冒名**（不写 `contacts.main`）。
 *   3) **幂等**：同一条事件连试三次 ⇒ 待领记录**只有一条**；不同事件各自一条。
 *   4) ★ **先红后绿**：落盘那一次丢了 ⇒ 下一次工具调用会补登记。
 *
 * ★ "找不到主对话会话时**不许静默**"（audit 待领标记 + `pending_wakes` 带出 + warn）
 *   那一组在 `tests/wake-pending-check.mjs`（拆文件，见 `CONVENTIONS.md` 的
 *   「单个测试文件 ≤ 400 行」）；共享夹具在 `tests/wake-no-main-fixtures.mjs`。
 *
 * ★ 纪律：全程零副作用（临时目录，跑完即删；**不碰**线上任务数据与会话目录）；
 *   **零 skip / 零 todo / 零 only**。
 *
 * @module dsh-pipeline/tests/wake-last-resort-check
 */

import { join } from 'node:path'

import { createWakeLedger, LEDGER_FILE_NAME } from '../lib/wakeledger.js'
import { wakeKeyOf } from '../lib/wakeup.js'
import { lastKnownMainAgentOf, LAST_RESORT_VIA } from '../lib/wakeup/last-resort.js'
import { pendingWakesOf } from '../lib/wakeup/pending.js'
import { createRecorder, fakeHost, liveShapedTask, makeTmpScope, makeWaker, renderReport, runDirect, seedTask } from './wake-no-main-fixtures.mjs'

const rec = createRecorder()

// ===========================================================================
// 1) 兜底解析的判据（纯函数 · 只用这张单自己的证据）
// ===========================================================================

async function checkResolver() {
  const G = '1 兜底解析判据（last-resort）'
  const hit = lastKnownMainAgentOf(liveShapedTask())
  rec.add(G, '① ★ 现场同形：`open` 行（`actor:"main"` + `agent`）⇒ 解析得出那个会话', hit !== null && hit.agentId === 'session-main-live' && hit.action === 'open', JSON.stringify(hit))

  const two = seedTask({
    history: [
      { at: '2026-10-15T00:00:00Z', actor: 'main', action: 'open', agent: 'session-old' },
      { at: '2026-10-16T00:00:00Z', actor: 'main', action: 'human:reply', agent: 'session-new' },
    ],
  })
  const last = lastKnownMainAgentOf(two)
  rec.add(G, '② 两条证据 ⇒ 取**最后一条**（重启后换了会话 id 也认得新的）', last !== null && last.agentId === 'session-new', JSON.stringify(last))

  const seatOnly = seedTask({ history: [{ at: 'x', actor: 'writer', action: 'handoff:human_request', agent: 'session-writer-9' }] })
  rec.add(G, '③ ★ 反例·**席位行永远不选**（`actor:"writer"` 的 `agent` 是席位会话 —— 投过去就是投错人）', lastKnownMainAgentOf(seatOnly) === null, '只有席位行 ⇒ null')

  const mechOnly = seedTask({ history: [{ at: 'x', actor: 'main', action: 'wake:skipped', agent: 'session-mystery' }] })
  rec.add(G, '④ ★★ 反例·**机制记账行不算证据**（`index.js` 的留痕回调把 `actor` 写死成 `main`，不剔就会把机制自己的行当成主对话的足迹）', lastKnownMainAgentOf(mechOnly) === null, '只有 wake:skipped 行 ⇒ null')

  const noAgent = seedTask({ history: [{ at: 'x', actor: 'main', action: 'open' }, { at: 'y', actor: 'main', action: 'open', agent: '' }] })
  rec.add(G, '⑤ 反例·没有 `agent` / `agent` 是空串 ⇒ `null`（**不编造**）', lastKnownMainAgentOf(noAgent) === null, 'null')

  let threw = false
  try {
    lastKnownMainAgentOf(null)
    lastKnownMainAgentOf(undefined)
    lastKnownMainAgentOf({ history: 'not-an-array' })
    lastKnownMainAgentOf({ history: [null, 7, 'x'] })
  } catch {
    threw = true
  }
  rec.add(G, '⑥ 畸形入参**一个都不抛**（只读纯函数：唤醒跑在工具关键路径上）', threw === false, `threw=${threw}`)
}

// ===========================================================================
// 2) ★★ 兜底解析：让它**找得到**（首选修法）
// ===========================================================================

async function checkResolved(scope) {
  const G = '2 兜底解析 ⇒ 找得到（首选）'
  const dir = scope.dir('resolved')
  const task = liveShapedTask()
  const seen = []
  const host = fakeHost()
  host.ensure('session-main-live')
  const w1 = await makeWaker({
    ledger: createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} }),
    task,
    host,
    lastResort: async (taskId) => {
      seen.push(taskId)
      return lastKnownMainAgentOf(task)
    },
  })
  const r1 = await w1.waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '一条人工请求', disc: 'HR-1' })

  rec.add(G, '① ★★ 台账里翻得到 ⇒ **投出去了**（现场那种单从此不再全哑）', r1.injected === true && r1.reason === 'delivered' && host.delivered.length === 1, `reason=${r1.reason} delivered=${host.delivered.length}`)
  rec.add(G, '② ★ 来源**可分辨**：`target_via === "last-known-agent"`（不是 registry、也不是 persisted-contact）', r1.targetSession === 'session-main-live' && w1.sinks.lines.some((l) => l.action === 'wake:delivered' && l.detail?.target_via === LAST_RESORT_VIA), `target=${r1.targetSession}`)
  rec.add(G, '③ ★ 兜底**出声**（第 3 道来源命中本身就是"登记缺失"的信号，不许安静）', w1.warns.some((m) => m.includes('兜底解析')), `warns=${w1.warns.length}`)
  rec.add(G, '④ 兜底只在**前两道都空**时才被问一次（正常路径不读盘）', seen.length === 1 && seen[0] === task.id, JSON.stringify(seen))

  // ★ 正常两条来源照旧优先，**不允许**被兜底抢答。
  const w2 = await makeWaker({
    ledger: createWakeLedger({ file: join(dir, 'r2.jsonl'), warn: () => {} }),
    task,
    mainSession: 'session-reg',
    lastResort: async () => ({ agentId: 'session-should-not-win', at: '', action: 'open' }),
  })
  const r2 = await w2.waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '另一条', disc: 'HR-2' })
  rec.add(G, '⑤ ★ 登记表有 ⇒ **绝不用兜底**（三条来源的优先级不许被改）', r2.targetSession === 'session-reg' && w2.sinks.lines.some((l) => l.action === 'wake:delivered' && l.detail?.target_via === 'registry'), `target=${r2.targetSession}`)

  const w3 = await makeWaker({
    ledger: createWakeLedger({ file: join(dir, 'r3.jsonl'), warn: () => {} }),
    task,
    persisted: 'session-disk',
    lastResort: async () => ({ agentId: 'session-should-not-win', at: '', action: 'open' }),
  })
  w3.host.ensure('session-disk')
  const r3 = await w3.waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '第三条', disc: 'HR-3' })
  rec.add(G, '⑥ ★ 落盘有 ⇒ 用落盘，**仍然不用兜底**', r3.targetSession === 'session-disk' && w3.sinks.lines.some((l) => l.action === 'wake:delivered' && l.detail?.target_via === 'persisted-contact'), `target=${r3.targetSession}`)

  const w4 = await makeWaker({ ledger: createWakeLedger({ file: join(dir, 'r4.jsonl'), warn: () => {} }), task, lastResort: async () => lastKnownMainAgentOf(task) })
  w4.host.ensure('session-main-live')
  const r4 = await w4.waker.wake({ taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '第四条', disc: 'HR-4' })
  rec.add(G, '⑦ ★★ 兜底**只读、不冒名**：投出去了，但**一个字节都没写** `contacts.main`（近似物不许冒名成权威登记）', r4.injected === true && w4.persistCalls.length === 0, `injected=${r4.injected} rememberContact 调用=${w4.persistCalls.length}`)
}

// ===========================================================================
// 3) 幂等：同一件事只落一条；不同的事不合并
// ===========================================================================

async function checkIdempotent(scope) {
  const G = '3 幂等（同一事件不重复落）'
  const dir = scope.dir('idem')
  const ledger = createWakeLedger({ file: join(dir, LEDGER_FILE_NAME), warn: () => {} })
  const task = liveShapedTask()
  const { waker, sinks } = await makeWaker({ ledger, task })
  const event = { taskId: task.id, actorRole: 'writer', actorSeat: null, kind: 'human', what: '一条人工请求', disc: 'HR-1' }
  const rs = [await waker.wake(event), await waker.wake(event), await waker.wake(event)]

  const un = ledger.unresolvedEntries({ taskId: task.id })
  rec.add(G, '① ★★ 同一条事件连试 3 次 ⇒ 账本 unresolved **只有 1 条**（改前会堆 3 条）', rs.every((r) => r.reason === 'no-main-session') && un.length === 1, `unresolved=${un.length}`)
  rec.add(G, '② 待领键**三次逐字相同**（键稳 ⇒ 落点稳 ⇒ 捞得出）', new Set(sinks.lines.filter((l) => l.action === 'wake:skipped').map((l) => l.detail?.unclaimed)).size === 1, `keys=${[...new Set(sinks.lines.map((l) => l.detail?.unclaimed))].join(',')}`)
  rec.add(G, '③ 每一次尝试**照旧留痕**（幂等不是"少留痕"：A25 的必含形态一个字没改）', sinks.lines.filter((l) => l.action === 'wake:skipped').length === 3, `skipped=${sinks.lines.filter((l) => l.action === 'wake:skipped').length}`)
  rec.add(G, '④ `pending_wakes` 也**只有 1 条**（捞的时候不会淹没在重复里）', pendingWakesOf(ledger, task.id).length === 1, `pending=${pendingWakesOf(ledger, task.id).length}`)

  await waker.wake({ ...event, disc: 'HR-2' })
  rec.add(G, '⑤ ★ 反例·**不同事件各自一条**（幂等不许退化成"一坨合并"）', ledger.unresolvedEntries({ taskId: task.id }).length === 2, `unresolved=${ledger.unresolvedEntries({ taskId: task.id }).length}`)

  const expect = wakeKeyOf({ taskId: task.id, kind: 'human', actorRole: 'writer', actorSeat: null, disc: 'HR-1' })
  rec.add(G, '⑥ ★ 待领键与投递键**同源**（`wakeKeyOf`），不是另造一套命名', un[0]?.detail?.key === expect, `${un[0]?.detail?.key} vs ${expect}`)
}

// ===========================================================================
// 4) ★★ 先红后绿：**补登记**（丢了就永远不再写 → 下次工具调用会补）
// ===========================================================================

async function checkRePersist() {
  const G = '4 ★ 先红后绿（补登记）'
  const task = seedTask()
  const attempts = []
  let fail = true
  const { waker } = await makeWaker({
    task,
    rememberContact: async (taskId, sessionId) => {
      attempts.push({ taskId, sessionId })
      if (fail) throw new Error('模拟：落盘那一次丢了（写竞争 / 进程先退）')
      return { ok: true }
    },
  })

  const first = waker.rememberMain(task.id, 'session-main-1', 'tool-call')
  await new Promise((r) => setTimeout(r, 5))
  rec.add(G, '① 第一次工具调用：登记进内存 + **尝试落盘一次**', first === true && attempts.length === 1, `rememberMain=${first} attempts=${attempts.length}`)

  // ★★ 红/绿的分界：第二次调用时内存值**没变**（`changed === false`）。
  const beforeSecond = attempts.length
  fail = false
  const second = waker.rememberMain(task.id, 'session-main-1', 'tool-call')
  await new Promise((r) => setTimeout(r, 5))
  /**
   * ★ 改前口径逐字是 `if (changed && typeof rememberContact === 'function')`。
   *   这里**当场把第二次那一次拿到的 `changed` 复算出来**（同一个值、同一个函数，
   *   再问一次仍然是"没变"）⇒ "改前会不会落盘"就不是叙述，是可断言的数。
   */
  const changedOnSecondCall = waker.registry.remember(task.id, 'session-main-1', 'probe-replay')
  rec.add(G, '② ★★ **先红**：第二次调用内存值没变（`changed === false`）⇒ **改前那一次落盘是 0 次**（丢了就永远丢了）', changedOnSecondCall === false && beforeSecond === 1, `复算 changed=${changedOnSecondCall}；第二次之前 attempts=${beforeSecond} ⇒ 旧口径**停在 ${beforeSecond}**`)
  rec.add(G, '③ ★★ **后绿**：失败之后**下一次工具调用会补**（`persistedOk` 只在写成功后才记账）⇒ attempts 涨到 2', second === true && attempts.length === 2, `attempts=${attempts.length}`)

  waker.rememberMain(task.id, 'session-main-1', 'tool-call')
  waker.rememberMain(task.id, 'session-main-1', 'tool-call')
  await new Promise((r) => setTimeout(r, 5))
  rec.add(G, '④ 补成功之后**不再重复写**（每次工具调用写一次盘 = 把纪律反着违反）', attempts.length === 2, `attempts=${attempts.length}`)

  waker.rememberMain(task.id, 'session-main-2', 'tool-call')
  await new Promise((r) => setTimeout(r, 5))
  rec.add(G, '⑤ 会话 id 变了 ⇒ 照旧落盘（换会话之后要认新的那个）', attempts.length === 3 && attempts[2]?.sessionId === 'session-main-2', JSON.stringify(attempts.map((a) => a.sessionId)))
}

export async function runWakeLastResortCheck() {
  rec.items.length = 0
  const scope = makeTmpScope('lastresort')
  try {
    await checkResolver()
    await checkResolved(scope)
    await checkIdempotent(scope)
    await checkRePersist()
  } finally {
    // ★ 在**套内**清（不是只在直接跑的分支里清）：`run-all` 走的是这个入口。
    scope.cleanup()
  }
  return renderReport('【唤醒 · 兜底解析与幂等 · wake-last-resort-check】', rec)
}

// ★ 临时目录已在 `runWakeLastResortCheck` 的 `finally` 里清掉，这里不再传 cleanup。
runDirect(runWakeLastResortCheck, import.meta.url)
