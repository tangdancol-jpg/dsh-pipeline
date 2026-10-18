/**
 * dsh-pipeline · **席位失联检测 · 「在等审批」判据**
 * ============================================================================
 * P1-4（`内部复盘（2026-10-18，不公开）`）：
 *
 * 现场：`ask` 审批策略下，席位弹审批卡**等人点**；主对话那边 6 分 34 秒后
 * `liveness` 判它「失联」（判词还写「不是它还在想，它可能已经死了」）⇒ 主对话
 * 据此重派 ⇒ **白烧 30 分钟**。
 *
 * ---------------------------------------------------------------------------
 * 研究结论：宿主**没有**「某会话有 pending approval」的直接可读 API
 * ---------------------------------------------------------------------------
 * 逐条查过（证据都来自本机 `app.asar` 解包树，路径以 `dsh/node_modules/` 起）：
 *
 *   ① `@deepseek-ai/dsh-user-approval/lib/index.js` 的 `ApprovalService`
 *      **只有** `request()` / `setPolicy()` / `effectivePolicy()` / `overrideOf()`：
 *      待决的那个 Promise 活在 `request()` 自己的 `await this.decide(...)` 里，
 *      **没有** `pending()` / `list()` 之类的登记表。⇒ `ctx.get('approval')` 读不到"谁在等"。
 *   ② `dsh-client-ui-approval` 的 `PendingApproval` 是**客户端**状态
 *      （由 Remote waterfall 请求在浏览器侧建的），`dsh-client-ui-session` 的
 *      `pendingInteraction` 也是从那条 Remote 请求派生的 ⇒ 宿主进程里没有对应存储。
 *   ③ ACP / 会话投影：`approval/asked` 等事件**不在**任何"待决"投影里。
 *
 * ---------------------------------------------------------------------------
 * 但宿主**确实**把这件事写进了会话日志（这就是本模块的判据来源）
 * ---------------------------------------------------------------------------
 * `ApprovalService.request()` 逐字是（`dsh-user-approval/lib/index.js`）：
 *
 * ```js
 * session.append('approval/asked', { id, toolName, callId?, reason? })
 * const outcome = await this.decide(req, session)     // ← 人没点就在这里挂着
 * session.append('approval/decided', { id, outcome })
 * ```
 *
 * 所以：**pending ⇔ 某条 `approval/asked` 的 id 没有配对的 `approval/decided`**。
 * 这三个事件类型都在宿主会话格式的已知事件表里（`dsh-session` 的
 * `KNOWN_SESSION_EVENT_TYPES`，持久化 worker 同一份名单）⇒ **会落盘**。
 * 本机实测（2026-10-18，`~/.dsh/sessions/…/session.v4.jsonl.zstd`）确实带
 * `{"type":"approval/policy","seq":2,"time":…,"data":{"policy":"never","source":"delegation"}}`。
 *
 * ---------------------------------------------------------------------------
 * 读取路径（两条，先用准的，再用糙的；**都读不到就如实说"读不到"**）
 * ---------------------------------------------------------------------------
 *   ① **进程内会话事件**：`ctx.agents.get(sessionId).session.snapshotEvents()`
 *      —— 与 `lib/runfail.js` 的失败取证**同一条**宿主面（那条已经在跑）。
 *   ② **落盘会话日志**：`~/.dsh/sessions/<bucket>/<会话id>/session.v4.jsonl.zstd`。
 *      ⚠️ 实测该文件是**多帧 zstd 串接**（一次 append 一帧）：`zlib.zstdDecompressSync`
 *      只解得开**第一帧**（本机实测 347 KB 的文件只解出 285 字节的 session 头）。
 *      所以必须按帧魔数切开逐帧解 —— 见 {@link decompressZstdFramesLossy}。
 *      （★ 同一处坑在 `lib/runfail.js` 的日志分支上也存在；本单不动它，只在报告里点名。）
 *
 * ---------------------------------------------------------------------------
 * 纪律（与 `lib/liveness.js` 全文同源）
 * ---------------------------------------------------------------------------
 *   · **纯判据 + 采样分离**：{@link foldApprovalEvents} 是纯函数，
 *     采样（进程内 / 读盘）由 {@link detectPendingApprovals} 做，判据不碰盘；
 *   · **三态分明**：`known:false` = 读不到（**不是**"没有审批"）；
 *     `known:true, pending:[]` = 读到了、确实没有待批；
 *   · **只加阳性证据，不放宽任何闸门**：拿到"在等审批"只把**这一个席位**
 *     从"失联"里摘出来，静默阈值、确认门、真死席位的判死路径一个字没改。
 *
 * @module dsh-pipeline/lib/liveness/approval
 */

import { readFileSync, statSync } from 'node:fs'
import zlib from 'node:zlib'

import { findSessionLog, formatDuration, sessionsRootCandidates } from './activity.js'

/** 宿主在**会话日志**里追加的"发起审批"事件。 */
export const APPROVAL_ASKED = 'approval/asked'
/** 宿主追加的"审批有结论"事件（人点了允许/拒绝、或信号中止都会走到它）。 */
export const APPROVAL_DECIDED = 'approval/decided'
/** 会话级审批策略（`ask` / `never`）—— 只是顺带读出来给人看，不参与"是否在等"的判定。 */
export const APPROVAL_POLICY = 'approval/policy'

/** 参与折叠的事件类型。 */
export const APPROVAL_EVENT_TYPES = Object.freeze([APPROVAL_ASKED, APPROVAL_DECIDED])

/** zstd 帧魔数（小端 `0xFD2FB528` 的字节序）。 */
export const ZSTD_FRAME_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志超过这么大就不读了（与 `lib/runfail.js` 的取同一个数量级；如实说"没读"）。 */
export const MAX_APPROVAL_LOG_BYTES = 64 * 1024 * 1024

/** 只读**文件尾部**这么多字节（zstd 帧是独立的，尾部若干帧足够覆盖"正在等的那一个"）。 */
export const MAX_APPROVAL_TAIL_BYTES = 8 * 1024 * 1024

/** 判词里最多列几个工具名（超出的给"+N"）。 */
export const MAX_APPROVAL_TOOLS_SHOWN = 6

/**
 * ★ **纯判据**：把一串会话事件折叠成"当前还挂着几个审批"。
 *
 * 判据只有一条：`approval/asked` 的 id 出现过、而 `approval/decided` 的同 id
 * **还没出现** ⇒ 这条还在等（人没点、或拒答器没回）。
 * 同一个 id 重复 `asked` 只算一条（宿主每次 `request()` 只 append 一次，这里只是防脏）。
 *
 * @param {Array<{type?:string, data?:object, time?:number}>|null|undefined} events
 * @returns {{known:boolean, pending:Array<{id:string, tool_name:string, call_id:string|null, reason:string|null, at_ms:number|null}>, asked:number, decided:number, policy:string|null, note:string}}
 *   `known:false` 只在"输入不是数组"时出现（= 没读到，不是没有）。
 */
export function foldApprovalEvents(events) {
  if (!Array.isArray(events)) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, note: '输入不是事件数组 —— 没读到会话事件（不是"没有审批"）。' }
  }
  /** id → 待批条目（按出现顺序） */
  const open = new Map()
  const order = []
  let asked = 0
  let decided = 0
  let policy = null
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    const type = String(ev.type ?? '')
    if (type === APPROVAL_POLICY) {
      const p = ev.data !== null && typeof ev.data === 'object' ? ev.data.policy : null
      if (typeof p === 'string' && p.length > 0) policy = p
      continue
    }
    if (type !== APPROVAL_ASKED && type !== APPROVAL_DECIDED) continue
    const data = ev.data !== null && typeof ev.data === 'object' ? ev.data : null
    const id = typeof data?.id === 'string' && data.id.length > 0 ? data.id : null
    if (id === null) continue
    if (type === APPROVAL_ASKED) {
      asked += 1
      if (!open.has(id)) {
        order.push(id)
        open.set(id, {
          id,
          tool_name: typeof data?.toolName === 'string' ? data.toolName : '',
          call_id: typeof data?.callId === 'string' && data.callId.length > 0 ? data.callId : null,
          reason: typeof data?.reason === 'string' && data.reason.length > 0 ? data.reason : null,
          at_ms: Number.isFinite(ev.time) ? ev.time : null,
        })
      }
    } else {
      decided += 1
      open.delete(id)
    }
  }
  const pending = order.filter((id) => open.has(id)).map((id) => open.get(id))
  return {
    known: true,
    pending,
    asked,
    decided,
    policy,
    note:
      pending.length === 0
        ? `读到了 ${asked} 条 approval/asked、${decided} 条 approval/decided —— 当前没有待批的审批。`
        : `读到了 ${asked} 条 approval/asked、${decided} 条 approval/decided ⇒ **${pending.length} 条还在等人批**。`,
  }
}

/**
 * ★ **纯判据**：从一段 JSONL 文本（会话日志解压后的样子）里折叠审批状态。
 *
 * 只挑**含 `"approval/` 的行**去 parse —— 长日志里 99% 的行与审批无关，
 * 全量 `JSON.parse` 在几百 KB 上是纯浪费。被截断的行（尾部半行）parse 失败就跳过。
 *
 * @param {string} text
 * @returns {{known:boolean, pending:Array<object>, asked:number, decided:number, policy:string|null, note:string}}
 */
export function foldApprovalText(text) {
  const s = typeof text === 'string' ? text : ''
  if (s.length === 0) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, note: '会话日志文本为空 —— 没读到事件（不是"没有审批"）。' }
  }
  const events = []
  let seenApprovalLines = 0
  for (const line of s.split('\n')) {
    if (line.length === 0 || !line.includes('"approval/')) continue
    seenApprovalLines += 1
    try {
      const ev = JSON.parse(line)
      if (ev !== null && typeof ev === 'object') events.push(ev)
    } catch {
      // 被截断的尾部半行 / 帧边界上的碎片 —— 跳过，不猜。
    }
  }
  const folded = foldApprovalEvents(events)
  return {
    ...folded,
    known: true,
    note:
      seenApprovalLines === 0
        ? '读到了会话日志，里面一条审批事件都没有（当前没有待批的审批）。'
        : folded.note,
  }
}

/**
 * ★ 把一个 zstd 缓冲区按**帧魔数**切成独立帧（会话日志是"一次 append 一帧"的串接）。
 *
 * 返回的是候选起点；真正的帧合法性由解压那一步验证（压缩数据里偶然出现魔数的
 * 概率是 2^-32 量级，真撞上也只是那一段解不开、被 `bad` 记一笔，不会伪造审批事件）。
 *
 * @param {Buffer|Uint8Array} raw
 * @returns {number[]} 各帧起点（升序）
 */
export function zstdFrameOffsets(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? [])
  const magic = Buffer.from(ZSTD_FRAME_MAGIC)
  const offsets = []
  let at = buf.indexOf(magic, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(magic, at + magic.length)
  }
  return offsets
}

/**
 * ★★ **多帧 zstd 解压**（会话日志的唯一正确读法；单帧 API 只会读到 session 头）。
 *
 * 为什么必须自己切帧：`zlib.zstdDecompressSync()` 只解**第一帧** ——
 * 本机实测（2026-10-18）一个 347,419 B 的 `session.v4.jsonl.zstd` 解出来只有
 * **285 B / 1 行**（就是会话头），而按帧切开的逐帧解压得到 **1.27 MB / 350 行**。
 *
 * 尾部损坏（正在写）不致命：坏帧计入 `bad` 并**如实写进 note**，好帧照用
 * （调用方据此知道"这段可能没读到"）。
 *
 * @param {Buffer|Uint8Array} raw - zstd 字节（可以是文件尾部切片）
 * @returns {{ok:boolean, text:string, frames:number, bad:number, note:string}}
 */
export function decompressZstdFramesLossy(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? [])
  const fn = typeof zlib?.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
  if (fn === null) {
    return { ok: false, text: '', frames: 0, bad: 0, note: '本机 node 没有 zstd 解压能力（zlib.zstdDecompressSync 不可用）—— 没读到，不猜。' }
  }
  const offsets = zstdFrameOffsets(buf)
  if (offsets.length === 0) {
    return { ok: false, text: '', frames: 0, bad: 0, note: '缓冲里找不到 zstd 帧（不是本机会话日志的形状）—— 没读到。' }
  }
  let text = ''
  let frames = 0
  let bad = 0
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      text += fn(buf.subarray(start, end)).toString('utf8')
      frames += 1
    } catch {
      bad += 1
    }
  }
  return {
    ok: frames > 0,
    text,
    frames,
    bad,
    note:
      frames === 0
        ? `找到 ${offsets.length} 个候选帧但一个都解不开`
        : bad > 0
          ? `解开了 ${frames} 帧（另有 ${bad} 帧解不开 —— 可能是尾部正在写；已读到的部分照用）`
          : `解开了 ${frames} 帧`,
  }
}

/**
 * ★ **进程内**取一个会话是否在等审批（最准的一条，与 `lib/runfail.js` 同一宿主面）。
 *
 * @param {object|null} agent - `ctx.agents.get(sessionId)` 的返回值
 * @returns {{known:boolean, pending:Array<object>, asked:number, decided:number, policy:string|null, source:string, note:string}}
 */
export function scanApprovalsInAgent(agent) {
  const snap = agent?.session?.snapshotEvents
  if (typeof snap !== 'function') {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-events', note: '拿不到该会话的事件快照（snapshotEvents 不可用）—— 没读到，不猜。' }
  }
  let events = null
  try {
    events = snap.call(agent.session)
  } catch (err) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-events', note: `读会话事件失败：${String(err?.message ?? err)}` }
  }
  if (!Array.isArray(events)) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-events', note: '会话事件快照不是数组 —— 没读到。' }
  }
  const folded = foldApprovalEvents(events)
  return { ...folded, source: 'session-events', note: `${folded.note}（来源：进程内会话事件，共 ${events.length} 条）` }
}

/**
 * ★ **落盘**取一个会话是否在等审批（进程内拿不到时的唯一线索）。
 *
 * 只读文件**尾部** {@link MAX_APPROVAL_TAIL_BYTES}：会话日志按帧追加，
 * 尾部若干帧足够覆盖"当前正在等的那一条"（它一定在最末尾附近）。
 *
 * @param {string|null} logPath
 * @returns {{known:boolean, pending:Array<object>, asked:number, decided:number, policy:string|null, source:string, note:string, file?:string}}
 */
export function scanApprovalsInLog(logPath) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-log', note: '没找到会话日志（session.v4.jsonl.zstd）—— 没读到。' }
  }
  let size = 0
  try {
    size = statSync(logPath).size
  } catch (err) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-log', note: `会话日志 stat 不到：${String(err?.message ?? err)}` }
  }
  if (size > MAX_APPROVAL_LOG_BYTES) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-log', note: `会话日志 ${size} 字节，超过上限 ${MAX_APPROVAL_LOG_BYTES} —— 本次没读（如实说明，不猜）。` }
  }
  let raw = null
  try {
    raw = readFileSync(logPath)
  } catch (err) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-log', note: `会话日志读取失败：${String(err?.message ?? err)}` }
  }
  // ★ 只解尾部若干帧（大日志不必全量解）：从尾部切片里**第一个帧起点**开始，
  //   保证不会把"从中间截断的半帧"当成数据。
  const tail = raw.length > MAX_APPROVAL_TAIL_BYTES ? raw.subarray(raw.length - MAX_APPROVAL_TAIL_BYTES) : raw
  const offsets = zstdFrameOffsets(tail)
  const start = offsets.length > 0 ? offsets[0] : tail.length
  const dec = decompressZstdFramesLossy(tail.subarray(start))
  if (dec.ok !== true) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'session-log', note: `会话日志解压失败（${dec.note}）—— 没读到，不猜。` }
  }
  const folded = foldApprovalText(dec.text)
  return {
    ...folded,
    source: 'session-log',
    note: `${folded.note}（来源：落盘会话日志${tail.length < raw.length ? '尾部' : ''}，${dec.note}）`,
    file: logPath,
  }
}

/** 会话目录（与 `lib/liveness.js` / `lib/runfail.js` 同一候选口径）。 */
function firstSessionsRoot(env = process.env, home) {
  const roots = sessionsRootCandidates(env, home)
  return roots.length > 0 ? roots[0] : null
}

/**
 * ★★ **总入口**：一串事件/日志/宿主面 ⇒ 回答"这个会话现在是不是在等审批"。
 *
 * 顺序（先准后糙，与 `lib/runfail.js` 同一条纪律）：
 *   ① 进程内会话事件（会话还活着 —— 等审批时**必然**活着，因为请求挂在那一轮里）；
 *   ② 落盘会话日志（进程内拿不到时的唯一线索）。
 * 两处都读不到 ⇒ `known:false`（**既不能说"在等"，也不能说"没在等"**）。
 *
 * @param {object} [spec]
 * @param {object} [spec.ctx] - Cordis ctx（读 `agents`）
 * @param {string} spec.sessionId
 * @param {string|string[]|null} [spec.sessionsRoot] - 会话根（可以是候选列表）
 * @param {(m:string)=>void} [spec.warn]
 * @returns {{known:boolean, pending:Array<object>, asked:number, decided:number, policy:string|null, source:string, note:string}}
 */
export function detectPendingApprovals(spec = {}) {
  const sessionId = typeof spec.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId : ''
  if (sessionId.length === 0) {
    return { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'none', note: '没有会话 id —— 读不到审批状态（如实说，不猜）。' }
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
      const r = scanApprovalsInAgent(agent)
      if (r.known === true) {
        return notes.length === 0 ? r : { ...r, note: `${r.note}${notes.length > 0 ? `；${notes.join('；')}` : ''}` }
      }
      notes.push(`事件侧：${r.note}`)
    } else {
      notes.push('事件侧：该会话在进程里已经不在了（agent 已消失）')
    }
  } else {
    notes.push('事件侧：拿不到 ctx.agents（宿主装配不同 / 自测替身）')
  }
  // ② 落盘
  const root =
    typeof spec.sessionsRoot === 'string' && spec.sessionsRoot.length > 0
      ? spec.sessionsRoot
      : Array.isArray(spec.sessionsRoot) && spec.sessionsRoot.length > 0
        ? spec.sessionsRoot
        : firstSessionsRoot()
  const logPath = root === null ? null : findSessionLog(root, sessionId)
  const r2 = scanApprovalsInLog(logPath)
  if (r2.known === true) return { ...r2, note: `${r2.note}${notes.length > 0 ? `；${notes.join('；')}` : ''}` }
  notes.push(`日志侧：${r2.note}`)
  return {
    known: false,
    pending: [],
    asked: 0,
    decided: 0,
    policy: null,
    source: 'none',
    note: `**读不到任何审批记录**（${notes.join('；')}）—— 既不能说"它在等审批"，也不能说"它没在等"；判据退回既有静默阈值。`,
  }
}

/**
 * ★★ **采样器工厂**（装配期建一次，`checkLiveness` / `pipeline_status` 共用）。
 *
 * 返回的函数吃一批**要判失联的席位**（`seatLiveness().silent` 那种形状），
 * 逐个问宿主"你在等审批吗"，产出 `approvals` 映射（键 = {@link seatKey} 的席位键，
 * 与 `seatLiveness` 的 `opts.approvals` 同形）。
 *
 * ★ 只给**候选失联的席位**做探测：正常干活时（silent 为空）一次都不探 ——
 *   这条判据不会给每次工具调用加一份读盘成本。
 *
 * @param {{ctx?:object, sessionsRoot?:string|string[]|null, warn?:(m:string)=>void}} [spec]
 * @returns {(seats:Array<object>) => Promise<{approvals:Record<string, object>, note:string}>}
 */
export function createSeatApprovalProbe(spec = {}) {
  const ctx = spec.ctx ?? null
  const sessionsRoot = spec.sessionsRoot ?? null
  const warn = typeof spec.warn === 'function' ? spec.warn : () => {}
  return async function probeSeatApprovals(seats) {
    const list = Array.isArray(seats) ? seats : []
    const approvals = {}
    let waiting = 0
    let known = 0
    for (const s of list) {
      const key = String(s?.key ?? '')
      if (key.length === 0) continue
      const sessionId =
        typeof s?.session_id === 'string' && s.session_id.length > 0
          ? s.session_id
          : typeof s?.agent_id === 'string' && s.agent_id.length > 0
            ? s.agent_id
            : ''
      if (sessionId.length === 0) {
        approvals[key] = { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'none', note: '该席位没有会话 id —— 读不到审批状态。' }
        continue
      }
      try {
        const r = detectPendingApprovals({ ctx, sessionId, sessionsRoot })
        approvals[key] = r
        if (r.known === true) known += 1
        if (r.known === true && r.pending.length > 0) waiting += 1
      } catch (err) {
        approvals[key] = { known: false, pending: [], asked: 0, decided: 0, policy: null, source: 'none', note: `审批探测异常：${String(err?.message ?? err)}` }
        warn(`[pipeline] 审批探测异常（按"读不到"处理，不影响失联判据）：${String(err?.message ?? err)}`)
      }
    }
    return { approvals, note: `审批探测：${list.length} 个候选席位，读到 ${known} 个，其中 **${waiting} 个在等审批**` }
  }
}

/** 把一个待批条目写成一行人话（工具名 / 原因）。 */
export function approvalItemText(item) {
  const tool = String(item?.tool_name ?? '') || '（未知工具）'
  const reason = typeof item?.reason === 'string' && item.reason.length > 0 ? `　原因：${item.reason}` : ''
  return `${tool}${item?.call_id === null || item?.call_id === undefined ? '' : `（call ${String(item.call_id).slice(0, 12)}…）`}${reason}`
}

/** 席位在等审批时，把工具名汇总成一句（`bash、write`，超出给 +N）。 */
export function pendingToolsText(pending) {
  const list = Array.isArray(pending) ? pending : []
  const names = []
  for (const it of list) {
    const n = String(it?.tool_name ?? '') || '（未知工具）'
    if (!names.includes(n)) names.push(n)
  }
  if (names.length === 0) return ''
  const head = names.slice(0, MAX_APPROVAL_TOOLS_SHOWN)
  return names.length > MAX_APPROVAL_TOOLS_SHOWN ? `${head.join('、')} 等 ${names.length} 种工具` : head.join('、')
}

/**
 * ★★ **判词**：席位在等审批（P1-4 的"误诊怎么消失"就落在这里）。
 *
 * 与"席位失联"判词**必须不同源、互不冒充**：
 *   · 这一条说的是「**它在等你点审批**」—— 人不动，它就不会动，**不是死了**；
 *   · 那一条说的是「静默超阈值 + 零活着的证据」。
 *
 * @param {Array<object>} awaiting - `seatLiveness().awaiting`
 * @param {{taskId?:string, state?:string, state_zh?:string, now?:number}} [ctx]
 * @returns {string} 没有在等审批的席位 ⇒ 空串
 */
export function describeApprovalWait(awaiting, ctx = {}) {
  const list = Array.isArray(awaiting) ? awaiting : []
  if (list.length === 0) return ''
  const taskId = String(ctx.taskId ?? '<任务id>')
  const rows = []
  let total = 0
  for (const s of list) {
    const pending = Array.isArray(s?.approval?.pending) ? s.approval.pending : []
    const count = Number.isFinite(s?.approval?.count) ? s.approval.count : pending.length
    total += count
    const rolePart = `${String(s?.role_zh ?? s?.role ?? '?')}${s?.seat === null || s?.seat === undefined ? '' : `（${s.seat}）`}`
    const tools = pendingToolsText(pending)
    const waited = typeof s?.elapsed_zh === 'string' && s.elapsed_zh.length > 0 ? `，已静默 ${s.elapsed_zh}` : ''
    rows.push(`  · ${rolePart}：**${count} 个工具调用**等你批准${tools.length > 0 ? `（${tools}）` : ''}${waited}`)
    const first = pending[0]
    if (first !== undefined && first !== null) rows.push(`      第一条：${approvalItemText(first)}`)
  }
  const policy = list.map((s) => s?.approval?.policy).find((p) => typeof p === 'string' && p.length > 0) ?? null
  const L = []
  L.push(
    `⏳ **席位在等审批 —— 不是失联，也不是"它还在想"**：任务 ${taskId} 停在「${String(ctx.state_zh ?? ctx.state ?? '?')}」，` +
      `${list.length} 个席位共 **${total} 个工具调用**在等你点「允许一次 / 拒绝」。`,
  )
  L.push(...rows)
  L.push(
    '★ **请到那个席位所在的会话里点一下审批卡**；在答复之前它**本来就不会有任何动静** —— ' +
      '所以它**不该**被判失联、**不该**被重派（重派会多起一个会话，白烧一轮）。',
  )
  if (policy !== null) L.push(`★ 该会话的审批策略是 \`${policy}\`${policy === 'ask' ? '（每次都要人点）' : '（本应自动拒绝，出现审批卡说明策略刚被改过或来自父会话继承）'}。`)
  L.push(
    '★ 如果你**不想**再被打断：把该会话的 approval policy 改成 `never` 再让它继续（或长单一开始就用 `never` 派活）——' +
      '但那样它需要审批的操作会被**自动拒绝**，不是自动放行。',
  )
  return L.join('\n')
}

/**
 * 判词的一句**短版**（进卡点清单 / 紧凑档用）。
 *
 * @param {Array<object>} awaiting
 * @returns {string} 没有 ⇒ 空串
 */
export function summarizeApprovalWait(awaiting) {
  const list = Array.isArray(awaiting) ? awaiting : []
  if (list.length === 0) return ''
  let total = 0
  const who = []
  for (const s of list) {
    const count = Number.isFinite(s?.approval?.count) ? s.approval.count : Array.isArray(s?.approval?.pending) ? s.approval.pending.length : 0
    total += count
    who.push(`${String(s?.role_zh ?? s?.role ?? '?')}${s?.seat === null || s?.seat === undefined ? '' : `(${s.seat})`}`)
  }
  return `席位在等你批准 ${total} 个工具调用（${who.join('、')}）—— 不是失联，先批再谈重派`
}

/**
 * 生成一条"已观察到在等审批"的稳定签名（用于去重留痕，别每次观察都写审计）。
 *
 * @param {Array<object>} awaiting
 * @returns {string}
 */
export function approvalWaitSignature(awaiting) {
  const list = Array.isArray(awaiting) ? awaiting : []
  const parts = []
  for (const s of list) {
    const pending = Array.isArray(s?.approval?.pending) ? s.approval.pending : []
    parts.push(`${String(s?.key ?? '')}:${pending.map((p) => String(p?.id ?? '')).sort().join('+')}`)
  }
  return parts.sort().join('|')
}

/** 把毫秒时长写成"3 分 20 秒"（与 `lib/liveness.js` 的 `formatDuration` 同一口径）。 */
export function approvalWaitDuration(ms) {
  return formatDuration(ms)
}
