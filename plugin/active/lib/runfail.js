/**
 * dsh-pipeline · **「本轮运行失败」的证据**
 * ============================================================================
 * 现场（用户截图，2026-10-12）：
 *   `🔴 本轮运行失败  DeepSeek Messages stream: tool input is invalid JSON  [MALFORMED_RESPONSE]`
 * 而机制 5 分钟后的判词是：
 *   `席位失联：编写（writer#3）静默阈值 5 分` ⇒ **任务被冻结**。
 *   —— 它是**崩死的**，不是闲着的；同一张单因此被冻 4 次，其中一次直接挡掉了
 *   一份**已经提交**的交付。
 *
 * 用户裁定的两条（已折进 A9 / A10 / A11 / B10）：
 *   · A9 **崩 ≠ 闲**：判词必须体现「运行失败」并**携带该次失败的证据**；
 *   · A10 **崩 ≠ 冻**：运行失败中止**不得**把任务推到阻塞；
 *   · A11 但中止本身**必须被主动播报**（不许从"被冻到人肉解冻"变成"静静卡死没人知道"）。
 *
 * ★ 需求层已写明的**唯一的真·停手上报条件**：若机制**实际拿不到**那份失败证据，
 *   不许用「判词里写个『可能失败』」糊过去 —— 那要如实报阻塞。所以本模块的返回值
 *   **三态分明**：
 *     · `found:true`  —— 拿到了失败证据（带原文与出处，判词据此写"运行失败"）；
 *     · `found:false, known:true`  —— **读到了**运行记录、里面**没有**失败 ⇒ 这是"空闲"；
 *     · `known:false`  —— **读不到**运行记录（会话目录不可达 / 事件拿不到）
 *       ⇒ **既不算崩也不算闲**：调用方必须如实写"没有运行记录"，并**退回既有判据**
 *       （真闲置超阈值仍判失联 —— A12 不许弱化）。
 *
 * ★ 本模块**只读**：不写盘、不改状态、不投递。判据是纯的，采样由调用方决定
 *   （与 `lib/liveness.js` 的纪律一致）。
 *
 * @module dsh-pipeline/lib/runfail
 */

import { readFileSync, statSync } from 'node:fs'
import zlib from 'node:zlib'

import { SESSION_LOG_NAME, findSessionLog } from './liveness.js'

/** 解压会话日志（宿主写的是 zstd）；宿主 node 没带 zstd 时**如实说拿不到**，不猜。 */
export function decompressZstd(buf) {
  const fn = typeof zlib?.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
  if (fn === null) return { ok: false, text: '', note: '本机 node 没有 zstd 解压能力（zlib.zstdDecompressSync 不可用）' }
  try {
    return { ok: true, text: fn(buf).toString('utf8'), note: '' }
  } catch (err) {
    return { ok: false, text: '', note: `zstd 解压失败：${String(err?.message ?? err)}` }
  }
}

/**
 * ★ 失败标记 —— **只认现场出现过的那几种形状**（宁可漏判也不误伤）。
 *
 * 为什么不用"任何 error 都算"：席位日常就会看到工具报错（`ok:false`）、
 * 读到不存在的文件 —— 那都不是"这一轮运行失败了"。把那些算进来，
 * 每一次小报错都会被写成"席位崩了"，A9 的判词会立刻变成噪音源。
 */
export const RUN_FAILURE_MARKERS = Object.freeze([
  '本轮运行失败',
  'MALFORMED_RESPONSE',
  'tool input is invalid JSON',
  'invalid JSON',
  'Response stream',
])

/** 一次扫描最多读多少字节的**解压后**文本（只扫尾部，防大文件把内存吃满）。 */
export const MAX_SCAN_BYTES = 400 * 1024

/** 超过这个大小的会话日志**不解压**（如实说"太大，没扫"）。 */
export const MAX_LOG_BYTES = 64 * 1024 * 1024

/** 在一段文本里找失败标记（纯函数，自测直接喂字符串）。 */
export function findFailureInText(text, opts = {}) {
  const s = typeof text === 'string' ? text : ''
  if (s.length === 0) return null
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null
  const tail = s.length > MAX_SCAN_BYTES ? s.slice(-MAX_SCAN_BYTES) : s
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.length === 0) continue
    const hit = RUN_FAILURE_MARKERS.find((m) => line.includes(m))
    if (hit === undefined) continue
    if (sinceMs !== null) {
      const at = extractAt(line)
      if (at !== null && at < sinceMs) continue // 早于本次观察窗口的事件不算这一次
    }
    return { matched: hit, line: line.length > 600 ? `${line.slice(0, 600)}…` : line }
  }
  return null
}

/** 从一行 jsonl 里抠时间戳（拿不到就 null —— **不猜**）。 */
export function extractAt(line) {
  const m = /"(?:at|time|timestamp|ts)"\s*:\s*"([^"]{10,40})"/.exec(String(line ?? ''))
  if (m === null) return null
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? t : null
}

/**
 * 从**宿主侧会话事件**里找失败证据（进程内、同步、最准）。
 *
 * @param {object|null} agent
 * @param {{sinceMs?:number}} [opts]
 * @returns {{known:boolean, found:boolean, evidence:object|null, note:string}}
 */
export function scanRunFailureInAgent(agent, opts = {}) {
  const snap = agent?.session?.snapshotEvents
  if (typeof snap !== 'function') {
    return { known: false, found: false, evidence: null, note: '拿不到该会话的事件快照（snapshotEvents 不可用）—— 没有运行记录，不等于它没崩。' }
  }
  let events = null
  try {
    events = snap.call(agent.session)
  } catch (err) {
    return { known: false, found: false, evidence: null, note: `读会话事件失败：${String(err?.message ?? err)}` }
  }
  if (!Array.isArray(events)) {
    return { known: false, found: false, evidence: null, note: '会话事件快照不是数组 —— 没有运行记录。' }
  }
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const at = Date.parse(String(e?.at ?? e?.data?.at ?? ''))
    if (sinceMs !== null && Number.isFinite(at) && at < sinceMs) continue
    let body = ''
    try {
      body = JSON.stringify(e)
    } catch {
      body = ''
    }
    const hit = findFailureInText(body, { sinceMs: null })
    if (hit === null) continue
    return {
      known: true,
      found: true,
      evidence: {
        source: 'session-events',
        at: Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
        matched: hit.matched,
        text: hit.line,
      },
      note: `会话事件里查到运行失败（命中 ${hit.matched}）。`,
    }
  }
  return { known: true, found: false, evidence: null, note: '读到了会话事件，里面没有运行失败记录。' }
}

/**
 * 从**会话日志**（`session.v4.jsonl.zstd`）里找失败证据。
 *
 * 为什么这条也要：席位**崩在中途**时，它那个 agent 可能已经从 `ctx.agents` 里消失
 * （这正是"读不到"的常见成因），而落盘的会话日志还在。
 *
 * @param {string|null} logPath
 * @param {{sinceMs?:number}} [opts]
 * @returns {{known:boolean, found:boolean, evidence:object|null, note:string}}
 */
export function scanRunFailureInLog(logPath, opts = {}) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    return { known: false, found: false, evidence: null, note: `没找到会话日志 ${SESSION_LOG_NAME} —— 没有运行记录。` }
  }
  let size = 0
  try {
    size = statSync(logPath).size
  } catch (err) {
    return { known: false, found: false, evidence: null, note: `会话日志 stat 不到：${String(err?.message ?? err)}` }
  }
  if (size > MAX_LOG_BYTES) {
    return { known: false, found: false, evidence: null, note: `会话日志 ${size} 字节，超过扫描上限 ${MAX_LOG_BYTES} —— 本次没有扫描（如实说明，不猜）。` }
  }
  let text = ''
  try {
    const raw = readFileSync(logPath)
    const dec = decompressZstd(raw)
    if (dec.ok !== true) {
      return { known: false, found: false, evidence: null, note: `会话日志解压失败（${dec.note}）—— 没有运行记录（如实说，不猜）。` }
    }
    text = dec.text
  } catch (err) {
    return { known: false, found: false, evidence: null, note: `会话日志读取失败（${String(err?.message ?? err)}）—— 没有运行记录。` }
  }
  const hit = findFailureInText(text, { sinceMs: opts.sinceMs })
  if (hit === null) return { known: true, found: false, evidence: null, note: '读到了会话日志，尾部没有运行失败记录。' }
  return {
    known: true,
    found: true,
    evidence: { source: 'session-log', at: null, matched: hit.matched, text: hit.line, file: logPath },
    note: `会话日志里查到运行失败（命中 ${hit.matched}）。`,
  }
}

/** 会话目录（与 `lib/liveness.js` / `store.sampleSessionActivity` 同一口径）。 */
export function sessionsRootOf(env = process.env) {
  if (typeof env.DSH_SESSIONS_DIR === 'string' && env.DSH_SESSIONS_DIR.length > 0) return env.DSH_SESSIONS_DIR
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return `${env.DSH_HOME}/sessions`
  return null
}

/**
 * ★ **总入口**：给一个席位会话，回答"它这一轮是崩了还是闲着"。
 *
 * 顺序（先准后糙）：
 *   ① 进程内会话事件（`ctx.agents.get(sessionId).session.snapshotEvents()`）；
 *   ② 落盘会话日志（agent 已消失时的唯一线索）。
 * 两处都**读不到** ⇒ `known:false`（**既不算崩也不算闲**）。
 *
 * @param {object} spec
 * @param {object} spec.ctx - Cordis ctx（读 `agents`）
 * @param {string} spec.sessionId
 * @param {number} [spec.sinceMs]
 * @param {string} [spec.sessionsRoot]
 * @param {(m:string)=>void} [spec.warn]
 * @returns {{known:boolean, found:boolean, evidence:object|null, source:string, note:string}}
 */
export function detectRunFailure(spec = {}) {
  const sessionId = typeof spec.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId : ''
  if (sessionId.length === 0) {
    return { known: false, found: false, evidence: null, source: 'none', note: '没有会话 id —— 判不出崩还是闲（如实说"读不到"）。' }
  }
  const notes = []
  // ① 进程内
  const agents = typeof spec.ctx?.get === 'function' ? spec.ctx.get('agents') : undefined
  if (agents !== undefined && agents !== null && typeof agents.get === 'function') {
    let agent = null
    try {
      agent = agents.get(sessionId)
    } catch {
      agent = null
    }
    if (agent !== null && agent !== undefined) {
      const r = scanRunFailureInAgent(agent, { sinceMs: spec.sinceMs })
      if (r.found === true) return { ...r, source: 'session-events' }
      notes.push(`事件侧：${r.note}`)
    } else {
      notes.push('事件侧：该会话在进程里已经不在了（可能已被切走 / 重启过）')
    }
  } else {
    notes.push('事件侧：拿不到 ctx.agents（宿主装配不同 / 自测替身）')
  }
  // ② 落盘日志
  const root = typeof spec.sessionsRoot === 'string' && spec.sessionsRoot.length > 0 ? spec.sessionsRoot : sessionsRootOf()
  const logPath = root === null ? null : findSessionLog(root, sessionId)
  const r2 = scanRunFailureInLog(logPath, { sinceMs: spec.sinceMs })
  if (r2.found === true) return { ...r2, source: 'session-log' }
  notes.push(`日志侧：${r2.note}`)
  const known = r2.known === true
  return {
    known,
    found: false,
    evidence: null,
    source: 'none',
    note: known
      ? `读到了运行记录，没有失败证据（${notes.join('；')}）`
      : `**读不到任何运行记录**（${notes.join('；')}）—— 这既不算"崩"也不算"闲"，判据退回既有静默阈值那三条。`,
  }
}

/**
 * 判词：**运行失败中止**（A9 的判词维 + A11 的主动播报正文）。
 *
 * ★ 与"席位失联"那一条判词**必须不同源、互不冒充**（A24 同向）：
 *   这一条说的是"它**崩了**"（有失败原文），那一条说的是"它**闲着**超时"。
 *
 * @param {Array<object>} seats - 本次判为"中止"的席位（`{key, role, role_zh, seat, session_id, at, elapsed_zh}`）
 * @param {{evidence?:object|null, taskId?:string, state?:string, state_zh?:string}} [ctx]
 * @returns {string}
 */
export function describeRunFailures(seats, ctx = {}) {
  const list = Array.isArray(seats) ? seats : []
  if (list.length === 0) return ''
  const ev = ctx.evidence ?? null
  const L = []
  L.push(
    `⚠ **席位因「本轮运行失败」中止**（**不是**闲置超时）：任务停在「${String(ctx.state_zh ?? ctx.state ?? '?')}」，` +
      `${list.length} 个席位在这一轮里崩在中途。`,
  )
  for (const s of list) {
    L.push(`  · ${String(s.role_zh ?? s.role ?? '?')}${s.seat === null || s.seat === undefined ? '' : `（${s.seat}）`}：会话 ${String(s.session_id ?? s.agent_id ?? '(未知)')}`)
  }
  if (ev !== null && typeof ev === 'object') {
    L.push(`★ **失败证据**（出处：${String(ev.source ?? '未知')}${ev.at === null || ev.at === undefined ? '' : `，时刻 ${String(ev.at)}`}，命中 \`${String(ev.matched ?? '')}\`）：`)
    L.push(`  \`${String(ev.text ?? '').slice(0, 400)}\``)
  } else {
    L.push('★ **失败证据拿不到** —— 这条判词是按"运行记录里查到失败"发出的，取证失败属于要上报的阻塞，不许用「可能失败」糊过去。')
  }
  L.push(
    '★ 按用户裁定（A10）：**任务不因运行失败被冻结** —— 所以它现在是"停在中途"，' +
      '而不是"被机制冻住"；这一条播报就是让你**不必靠人肉巡检**才知道。',
  )
  L.push('★ 恢复路径（择一，均不消耗打回预算）：`pipeline_dispatch { reassign: true }` 重派同一席位；或 `pipeline_succession`（仅当该席位留下过 seat_handover）；或直接答复它。')
  return L.join('\n')
}
