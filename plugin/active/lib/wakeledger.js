/**
 * dsh-pipeline · **已播报账本**（唤醒的「恰一次」跨进程活下去）
 * ============================================================================
 * 用户裁定（方案 4 的两项新授权之一）：
 *   「**允许新增状态文件**」—— 落点在**生效副本插件目录内**，用途是让
 *   「同一条事件恰播一次」在**进程重启后仍然成立**。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须有它（现场）
 * ---------------------------------------------------------------------------
 * 改前「恰一次」只活在 `lib/wakeup.js` 的 `delivered` **内存表**里 ⇒ 进程一重启，
 * 表就空了 ⇒ 同一条事件（同一次交付 / 同一次失联）会被**重新播报**一遍；
 * 而反过来，一旦把它做成「重启后什么都不敢投」，就变成今晚那种
 * 「干完活 → 停下来 → 没人叫」。两条都要治，所以判据必须**落盘**：
 *   · 盘上有这条键 ⇒ 已经播过了 ⇒ **不再播**（A1 / A19）；
 *   · 盘上没有这条键 ⇒ 没播过 ⇒ **照播**（A3：该投的必须投）。
 *
 * ---------------------------------------------------------------------------
 * ★ 三种"用不了"的形态都有**可判定行为**，且都走「看得见的失败」（A20 / B19）
 * ---------------------------------------------------------------------------
 *   · **缺失**（首次运行）：判据是"还没有账本" ⇒ **建它**（不是失败），
 *     留一行 `ledger:init`；这一轮的去重退回"内存表 + 目标会话队列"两道既有判据。
 *   · **损坏**（解析不了 / 半行）：**不删、不覆盖**（用户的账本不许被机制毁掉），
 *     记 `ledger:damaged` + 原因 + 坏在第几行 ⇒ 去重退回既有两道判据（**仍然投递**，
 *     因为"投不出去"比"可能重复投一次"贵得多 —— 今晚所有的痛都是"没叫"）。
 *   · **不可写**（权限 / IO 错）：`ledger:unwritable` + 原因；投递**照旧进行**，
 *     每一次写入失败都会被**限流地**再报一次（不许安静）。
 *
 * ★ **不许静默跳过，也不许退化成"每次都播"**：前者会把事件丢掉，后者会重放。
 *   所以三态下的行为是**明确的**：投递继续 + 失败可见 + 去重退到既有两道网。
 *
 * ---------------------------------------------------------------------------
 * ★ 它**不是**第二条守门通路（B12 / 越界清单）
 * ---------------------------------------------------------------------------
 *   本文件只有"读/写一个只追加的 jsonl"这一件事：不给任何调用方**授权**、
 *   不改任何状态、不参与守门判据。账本里记的也只是"哪条事件播过、给谁、何时"——
 *   **不含任何令牌 / 身份凭据**（不许成为伪造身份的原料）。
 *
 * ---------------------------------------------------------------------------
 * ★ 可重建（A20 末句：避免它变成不可替代的单点）
 * ---------------------------------------------------------------------------
 *   重建口径写在 {@link rebuildEntriesFromTask} 上：**从既有事件数据推**出
 *   「哪些事件按现口径早该已经播过」—— 交付物（交接物 / 制品 / 记录 / 请求）
 *   与状态推进历史各按各自的身份字段推键，键的拼法与 `lib/wakeup.js` 的
 *   `wakeKeyOf` **逐字同源**（重建不许另造一套口径，否则重建出来的账本判不出重复）。
 *
 * @module dsh-pipeline/lib/wakeledger
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 账本默认文件名（落在**生效副本插件目录内** —— 授权面 `active-state`）。 */
export const LEDGER_FILE_NAME = 'wake-ledger.jsonl'

/** 一次加载最多认多少行；超过就**压实**（只留每个键的最新一条 + 未消费 + 升级）。 */
export const DEFAULT_MAX_LINES = 20000

/** 写失败时重复告警的最小间隔（毫秒）—— 失败必须吵，但不许变成刷屏源。 */
export const WRITE_WARN_THROTTLE_MS = 60 * 1000

// ---------------------------------------------------------------------------
// ★★ **P0-3：未消费升级链的收敛判据**（活锁的断开点就在下面这两个纯函数上）
// ---------------------------------------------------------------------------
//
// 现场（真实账本 `wake-ledger.jsonl`，同一张**已取消**的单 T-20261014-hello01）：
//
//   hello01|unresolved-wake|mechanism|…|human|no-stable-identity              （123 字符）
//     → hello01|escalation|mechanism|…unresolved-wake… #escalated            （175 字符）
//     → hello01|unconsumed-delivery|mechanism|…unresolved-wake…              （213 字符）
//     → hello01|unconsumed-delivery|mechanism|…escalation…unresolved-wake…   （263 字符）
//     → hello01|unconsumed-delivery|mechanism|…unconsumed-delivery|…         （301 字符）
//     → …（继续加深；42 条已播报里 **26 条**是这类机制通知，占 62%）
//
// 为什么 `requestId` 幂等挡不住：**每一层都是新键**（新键 = 新交付 = 新幂等域）。
// 为什么它无法自愈：目标单是**终态** ⇒ 状态机明示「无合法事件」⇒ 主对话没有任何
// 动作能"消费"它 ⇒ "一旦被消费就不再升级"这个终止条件**永远无法满足**。
//
// 两条收敛判据（都是"**不再从『等待接管』这个口子出去**"，不是删数据）：
//   ② 深度上限 —— 升级**不再派生升级**（原事件 + 1 层封顶）；
//   ③ 机制通知不当作新交付 —— 巡检播报 / 升级叫醒本身就是机制发出去的，
//      拿它们再报一次"这条没人接管"，就是那场套娃的每一层。

/**
 * ★★ **P0-3②：升级链深度上限** —— 原事件 + **1 层**升级封顶（默认）。
 *
 * 口径：一个键的**升级层数** = 它里面 `#escalated` 出现几次（原事件 = 0 层）。
 * 层数 ≥ 本上限的条目**不再进"等待接管"清单** ⇒ `escalateUnconsumed` 拿不到它
 * ⇒ 自然升不出下一层。传 `0` = 一律不升级；传更大的数 = 明确要求更长的链。
 */
export const DEFAULT_MAX_ESCALATION_DEPTH = 1

/**
 * ★★ **P0-3③：哪些类别是「机制在说机制自己的事」**（而不是"谁交了一份东西"）。
 *
 * ★ 刻意**只列这六个通知类别**，不列 `liveness` / `abort` / `transition` / `handoff`——
 *   那几个是**真事实**（席位失联、运行中止、状态推进、有人交了活），它们没人接管时
 *   该报、该升级，一个字不动（"该叫没叫必须报出来"这条契约不许被这次收敛削掉）。
 * ★ **凡新增一种"由巡检发出去的"通知类别，必须同时加进这张表**（例：2026-10-14 追加的
 *   `missing-transition`）—— 漏加一个，那个类别下一轮就会被当成"等待接管的交付"
 *   再报一次，套娃原样复发。`tests/terminal-filter-check.mjs` 有一条断言专门锁这条纪律。
 */
export const MECHANISM_NOTICE_KINDS = Object.freeze([
  'escalation',
  'unconsumed-delivery',
  'unresolved-wake',
  'task-stall',
  'patrol-stalled',
  'missing-transition',
])

/**
 * 交付键 ⇒ 四段（`<任务>|<类别>|<执行者>|<判别子>`）。
 *
 * ★ 只切**前三段**：判别子自己可以含 `|`（实测那些套娃键里就含一大串），
 *   所以第四段是"剩下的全部"，不许再切。
 *
 * @param {string} key
 * @returns {{task_id:string, kind:string, actor:string, disc:string}}
 */
export function parseWakeKey(key) {
  const parts = String(key ?? '').split('|')
  return {
    task_id: parts.length > 0 ? parts[0] : '',
    kind: parts.length > 1 ? parts[1] : '',
    actor: parts.length > 2 ? parts[2] : '',
    disc: parts.length > 3 ? parts.slice(3).join('|') : '',
  }
}

/**
 * 升级层数：键里 `#escalated` 出现几次就是第几层（**原事件 = 0**）。
 *
 * @param {string} key
 * @returns {number}
 */
export function escalationDepthOf(key) {
  const m = String(key ?? '').match(/#escalated/g)
  return m === null ? 0 : m.length
}

/**
 * ★ 这条"已投递"是不是**机制自己的通知**。
 *
 * 判据同时看**字段**（`kind` / `actor`）与**键**（老账本里的行可能只带键）：
 * 字段为空时退回按键解析，两者都指向"机制通知"才算。
 * ★ 宁可漏判成"普通交付"（多报一次），也不误判（把真交付吞掉）。
 *
 * @param {{key?:string, kind?:string, actor?:string}} entry
 * @returns {boolean}
 */
export function isMechanismNotice(entry) {
  const parsed = parseWakeKey(entry?.key ?? '')
  const kind = String(entry?.kind ?? '') || parsed.kind
  const actor = String(entry?.actor ?? '') || parsed.actor
  return actor === 'mechanism' && MECHANISM_NOTICE_KINDS.includes(kind)
}

/** 账本在一个插件目录下的默认落点。 */
export function defaultLedgerPath(pluginDir) {
  const base = typeof pluginDir === 'string' && pluginDir.length > 0 ? pluginDir : process.cwd()
  return join(base, LEDGER_FILE_NAME)
}

/** 毫秒 → ISO（秒级，与项目其它留痕同口径）。 */
function isoAt(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 从既有事件数据推出**重建条目**（纯函数）。
 *
 * 重建口径（写死在这里，别再各处理解一遍）：
 *   · 交接物：`<task>|handoff|<from_role[#seat]>|<handoff_id>`
 *   · 制品：  `<task>|artifact|<role>|<version>`
 *   · 记录：  `<task>|record|<role>|<record_id>`
 *   · 澄清请求 / 人工请求：`<task>|<kind>|<from_role[#seat]>|<request_id>`
 *   · 状态推进：`<task>|transition|<actor>|<action>@<at>:<from>-><to>`
 *   · 失联升级：`<task>|liveness|mechanism|<seats>|<n>`
 * ★ 键的形状必须与 `wakeup.js` 的 `wakeKeyOf` 完全一致（同一份口径）。
 *
 * @param {object|null} task
 * @returns {Array<{key:string, task_id:string, kind:string, actor:string, at:string|null, event_at:string|null, identity_source:string}>}
 */
export function rebuildEntriesFromTask(task) {
  const t = task !== null && typeof task === 'object' ? task : null
  if (t === null) return []
  const taskId = String(t.id ?? '')
  if (taskId.length === 0) return []
  const out = []
  const push = (kind, actor, disc, at) => {
    if (typeof disc !== 'string' || disc.length === 0) return
    const who = typeof actor === 'string' && actor.length > 0 ? actor : '?'
    out.push({
      key: `${taskId}|${kind}|${who}|${disc}`,
      task_id: taskId,
      kind,
      actor: who,
      at: typeof at === 'string' && at.length > 0 ? at : null,
      event_at: typeof at === 'string' && at.length > 0 ? at : null,
      identity_source: 'rebuild',
    })
  }
  /** 席位口径与 `wakeKeyOf` 同源：编写席位的 id 本身全限定（`writer#3`），非编写角色 seat 为空。 */
  const actorOf = (role, seat) => {
    const r = String(role ?? '')
    if (r.length === 0) return ''
    const s = typeof seat === 'string' && seat.length > 0 ? String(seat).replace(/^[a-z_]+#/, '') : ''
    return s.length === 0 ? r : `${r}#${s}`
  }
  for (const h of Array.isArray(t.handoffs) ? t.handoffs : []) {
    push('handoff', actorOf(h?.from_role, h?.from_seat), h?.handoff_id, h?.created_at)
  }
  for (const a of Array.isArray(t.artifacts) ? t.artifacts : []) {
    push('artifact', actorOf(a?.role, a?.seat), a?.version, a?.at ?? a?.created_at)
  }
  for (const r of Array.isArray(t.records) ? t.records : []) {
    push('record', actorOf(r?.role, r?.seat), r?.record_id, r?.at)
  }
  for (const r of Array.isArray(t.clarification_requests) ? t.clarification_requests : []) {
    push('clarify', actorOf(r?.from_role, r?.from_seat), r?.request_id, r?.at ?? r?.created_at)
  }
  for (const r of Array.isArray(t.human_requests) ? t.human_requests : []) {
    push('human', actorOf(r?.from_role, r?.from_seat), r?.request_id, r?.at ?? r?.created_at)
  }
  for (const h of Array.isArray(t.history) ? t.history : []) {
    const at = typeof h?.at === 'string' ? h.at : null
    const action = typeof h?.action === 'string' ? h.action : null
    if (at === null || action === null) continue
    const from = typeof h?.from === 'string' ? h.from : ''
    const to = typeof h?.to === 'string' ? h.to : ''
    push('transition', String(h?.actor ?? '?'), `${action}@${at}${from || to ? `:${from}->${to}` : ''}`, at)
  }
  const escs = Array.isArray(t.liveness?.escalations) ? t.liveness.escalations : []
  for (let i = 0; i < escs.length; i++) {
    const e = escs[i]
    const seats = Array.isArray(e?.seats) ? e.seats.slice().sort().join(',') : ''
    push('liveness', 'mechanism', `${seats}|${i + 1}`, e?.at)
  }
  return out
}

/**
 * 造一个账本句柄。
 *
 * @param {object} [opts]
 * @param {string} [opts.file] - 落点（默认 `<pluginDir>/wake-ledger.jsonl`）
 * @param {string} [opts.pluginDir]
 * @param {(m:string)=>void} [opts.warn]
 * @param {number} [opts.maxLines]
 * @param {boolean} [opts.disabled] - true = 彻底不碰盘（自测里固定"内存形态"用）
 * @returns {object}
 */
export function createWakeLedger(opts = {}) {
  const file = typeof opts.file === 'string' && opts.file.length > 0
    ? opts.file
    : defaultLedgerPath(opts.pluginDir)
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const maxLines = Number.isInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : DEFAULT_MAX_LINES
  const disabled = opts.disabled === true

  /** 全部条目（内存镜像；重建与查询都读它）。 */
  let entries = []
  /** `delivered` 状态：键 ⇒ 最新一条 wake 记录。 */
  const delivered = new Map()
  /** 键 ⇒ 消费记录（A28 的"接管"那一半）。 */
  const consumed = new Map()
  /** 键 ⇒ 升级记录（R1 的"再叫"那一半）。 */
  const escalated = new Map()
  /** 席位侧投递：键 ⇒ 记录（反向投递的留痕，A6/A7/A28(b)）。 */
  const seatDeliveries = new Map()
  /** "没投出去"的事件（可见失败留痕，A3/A8）。 */
  let unresolved = []

  let state = 'missing'
  let note = ''
  let lastWriteWarnMs = 0
  let writeFailures = 0

  function indexEntry(e) {
    if (e === null || typeof e !== 'object') return
    const key = typeof e.key === 'string' ? e.key : ''
    if (key.length === 0) return
    entries.push(e)
    if (entries.length > maxLines * 2) entries = entries.slice(-maxLines)
    if (e.t === 'wake') delivered.set(key, e)
    else if (e.t === 'consumed') consumed.set(key, e)
    else if (e.t === 'escalated') escalated.set(key, e)
    else if (e.t === 'seat-wake') seatDeliveries.set(key, e)
    else if (e.t === 'seat-consumed') seatDeliveries.set(key, { ...(seatDeliveries.get(key) ?? { key }), consumed_at: e.at, consumed_by: e.by ?? null })
    else if (e.t === 'unresolved') unresolved.push(e)
  }

  /** 记一次"用不了"（三态都走这里 —— 失败必须可见，且不许刷屏）。 */
  function noteFailure(action, reason, extra = {}) {
    const nowMs = Date.now()
    if (nowMs - lastWriteWarnMs < WRITE_WARN_THROTTLE_MS) return
    lastWriteWarnMs = nowMs
    warn(`[pipeline] 已播报账本${action}：${reason}（去重退回「内存表 + 目标会话队列」两道既有判据；投递照旧进行，不会静默跳过）`)
    void extra
  }

  /** 加载（缺失 = 建它；损坏 = 不删不覆盖 + 可见失败）。 */
  function load() {
    if (disabled) {
      state = 'memory'
      note = '账本被显式关掉（disabled）—— 本次只在内存里去重（自测用）。'
      return
    }
    if (!existsSync(file)) {
      state = 'missing'
      note = `账本不存在（首次运行）：${file}`
      // ★ 首次运行**建它**（不是失败）：留痕一行，下一轮起跨进程生效。
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify({ t: 'init', at: isoAt(Date.now()), file })}\n`, { encoding: 'utf8', flag: 'a' })
        state = 'ready'
        note = `账本首次创建：${file}`
      } catch (err) {
        state = 'unwritable'
        note = `账本不存在且建不出来：${String(err?.message ?? err)}`
        noteFailure('不可写', note)
      }
      return
    }
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      state = 'unwritable'
      note = `账本读不出来：${String(err?.message ?? err)}`
      noteFailure('读失败', note)
      return
    }
    const lines = text.split('\n')
    let bad = 0
    let firstBadAt = 0
    let count = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      count += 1
      try {
        indexEntry(JSON.parse(line))
      } catch {
        bad += 1
        if (firstBadAt === 0) firstBadAt = i + 1
      }
    }
    if (bad > 0) {
      // ★ **不删、不覆盖**：用户的账本不许被机制毁掉。坏行只是不参与判定。
      state = 'damaged'
      note = `账本有 ${bad} 行解析不了（第一处第 ${firstBadAt} 行）；未改动文件 —— 这几行不参与去重判定。`
      noteFailure('损坏', note)
    } else {
      state = 'ready'
      note = `账本已加载：${count} 行，${delivered.size} 个已播报键。`
    }
    if (count > maxLines) compact()
  }

  /** 压实：只留"每个键的最新一条 wake"+ 未消费 + 升级 + 席位投递。 */
  function compact() {
    if (disabled) return
    const keep = []
    for (const e of delivered.values()) keep.push(e)
    for (const e of consumed.values()) keep.push(e)
    for (const e of escalated.values()) keep.push(e)
    for (const e of seatDeliveries.values()) keep.push(e)
    for (const e of unresolved.slice(-500)) keep.push(e)
    try {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${keep.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
      renameSync(tmp, file)
      unresolved = unresolved.slice(-500)
      note = `${note}　★ 已压实到 ${keep.length} 行（超过上限 ${maxLines} 行）。`
    } catch (err) {
      noteFailure('压实失败', String(err?.message ?? err))
    }
  }

  load()

  /** 追加一条（失败 = 可见，不抛）。 */
  function append(entry) {
    if (disabled) {
      indexEntry(entry)
      return { ok: true, state, note: '内存形态（disabled）：未落盘。' }
    }
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      indexEntry(entry)
      if (state === 'unwritable') state = 'ready'
      return { ok: true, state, note: '' }
    } catch (err) {
      writeFailures += 1
      state = 'unwritable'
      note = `账本写不进去：${String(err?.message ?? err)}`
      noteFailure('写失败', note)
      // ★ 写失败**仍然进内存镜像**：进程内这一次的去重照旧成立（不许因为盘写失败就重放）。
      indexEntry(entry)
      return { ok: false, state, note }
    }
  }

  return {
    file,
    get state() {
      return state
    },
    status() {
      let bytes = 0
      try {
        bytes = existsSync(file) ? statSync(file).size : 0
      } catch {
        bytes = 0
      }
      /**
       * ★ P0-3：这两类是**只记账、不再唤醒**的，在这里露出来 = 收敛**不是**静默丢弃。
       * ★ 两个桶**互斥**（同一条只落一个）：先按"深度到顶"（②），再按"机制通知"（③）——
       *   与 `pendingUnconsumed` 里那两道闸的次序一致，于是"账上有几条 / 为什么不上报"
       *   随时查得到，也不必去数 `delivered` 自己。
       */
      let noticeCount = 0
      let derivedCount = 0
      for (const e of delivered.values()) {
        if (escalationDepthOf(e.key) >= 1) derivedCount += 1
        else if (isMechanismNotice(e)) noticeCount += 1
      }
      return {
        ok: state === 'ready' || state === 'memory',
        state,
        path: file,
        bytes,
        entries: delivered.size,
        consumed: consumed.size,
        escalated: escalated.size,
        seat_deliveries: seatDeliveries.size,
        unresolved: unresolved.length,
        write_failures: writeFailures,
        /** 机制自己的通知（`MECHANISM_NOTICE_KINDS`，且没到深度上限）。 */
        mechanism_notices: noticeCount,
        /** 已经带 `#escalated` 的派生键（深度 ≥ 1，含到顶不再唤醒的）。 */
        derived_escalations: derivedCount,
        note,
      }
    },
    /** 这个键**已经播过**吗（跨进程的「恰一次」判据）。 */
    hasDelivered(key) {
      return delivered.has(String(key ?? ''))
    },
    deliveredEntry(key) {
      return delivered.get(String(key ?? '')) ?? null
    },
    /** 同一 (任务, 类别, 执行者) 下**最近一条已播报**的键（重放判定用）。 */
    latestKeyFor({ taskId, kind, actor }) {
      const t = String(taskId ?? '')
      const k = String(kind ?? '')
      const a = String(actor ?? '')
      let best = null
      for (const e of delivered.values()) {
        if (String(e.task_id ?? '') !== t || String(e.kind ?? '') !== k || String(e.actor ?? '') !== a) continue
        if (best === null || String(e.at ?? '') > String(best.at ?? '')) best = e
      }
      return best
    },
    /** 记一条"播过了"。 */
    record(entry) {
      const e = {
        t: 'wake',
        key: String(entry?.key ?? ''),
        task_id: String(entry?.task_id ?? ''),
        kind: String(entry?.kind ?? ''),
        actor: String(entry?.actor ?? ''),
        at: typeof entry?.at === 'string' && entry.at.length > 0 ? entry.at : isoAt(Date.now()),
        target: typeof entry?.target === 'string' ? entry.target : '',
        request_id: typeof entry?.request_id === 'string' ? entry.request_id : '',
        identity_source: typeof entry?.identity_source === 'string' ? entry.identity_source : '',
        event_at: typeof entry?.event_at === 'string' ? entry.event_at : null,
      }
      if (e.key.length === 0) return { ok: false, state, note: '空键不记。' }
      return append(e)
    },
    /** ★ A28：**接管**留痕（与原事件**配对可读**：同一个 key）。 */
    markConsumed({ key, by, action, at }) {
      const k = String(key ?? '')
      if (k.length === 0) return { ok: false, state, note: '空键不记。' }
      if (consumed.has(k)) return { ok: true, state, note: '已记过（同一条只记第一次接管）。' }
      return append({ t: 'consumed', key: k, at: typeof at === 'string' && at.length > 0 ? at : isoAt(Date.now()), by: String(by ?? ''), action: String(action ?? '') })
    },
    consumedEntry(key) {
      return consumed.get(String(key ?? '')) ?? null
    },
    /** ★ R1：**升级叫醒**留痕（与原始事件**配对可读**：`escalation_of` = 原键）。 */
    markEscalated({ key, escalationKey, reason, at }) {
      const k = String(key ?? '')
      if (k.length === 0) return { ok: false, state, note: '空键不记。' }
      if (escalated.has(k)) return { ok: true, state, note: '已升级过（同一条不重复升级）。' }
      return append({
        t: 'escalated',
        key: k,
        escalation_key: String(escalationKey ?? ''),
        reason: String(reason ?? ''),
        at: typeof at === 'string' && at.length > 0 ? at : isoAt(Date.now()),
      })
    },
    escalatedEntry(key) {
      return escalated.get(String(key ?? '')) ?? null
    },
    /**
     * ★ 「已投递未消费」清单（A28 / R1 / T30 的数据面）。
     *
     * ★★ **P0-3 的两道收敛判据就落在这个函数上** —— 它是**巡逻与升级链共同的取数口**
     *   （`wakeup.pendingDeliveries` 与 `wakeup.escalateUnconsumed` 都从这里拿清单）：
     *
     *   · **② 深度上限**：已经带 `#escalated` 到上限的键**不再返回** ⇒ 升级拿不到
     *     "上一层升级"这条交付 ⇒ **升不出第二层**（原事件 + 1 层封顶）；
     *   · **③ 机制通知不当作新交付**：巡检播报 / 升级叫醒本身是机制发出去的
     *     （`actor=mechanism` + {@link MECHANISM_NOTICE_KINDS}）—— 拿它们再报一次
     *     "这条没人接管"就是那场套娃的每一层（每一层都是**新键**，`requestId` 幂等
     *     挡不住）。
     *
     * ★ 两道都**不删任何东西**：那些条目**照旧留在账本里**（`status()` 的
     *   `mechanism_notices` / `derived_escalations` 看得见）—— 是"只记账、不再唤醒"，
     *   不是静默丢弃。`includeMechanismNotices: true` 可以把它们**要回来**
     *   （取证 / 自测用；升级链自己不许用）。
     *
     * @param {{now?:number, olderThanMs?:number, limit?:number, maxEscalationDepth?:number, includeMechanismNotices?:boolean}} [opts]
     */
    pendingUnconsumed({
      now = Date.now(),
      olderThanMs = 0,
      limit = 20,
      maxEscalationDepth = DEFAULT_MAX_ESCALATION_DEPTH,
      includeMechanismNotices = false,
    } = {}) {
      const depthCap = Number.isInteger(maxEscalationDepth) && maxEscalationDepth >= 0
        ? maxEscalationDepth
        : DEFAULT_MAX_ESCALATION_DEPTH
      const out = []
      for (const e of delivered.values()) {
        if (consumed.has(e.key)) continue
        if (escalated.has(e.key)) continue
        // ★ ② 深度上限：到顶的派生键不再进"等待接管"（于是也升不出更深的一层）。
        if (escalationDepthOf(e.key) >= depthCap) continue
        // ★ ③ 机制自己的通知不是"等待接管的交付"（收敛到根事件，不再逐层派生）。
        if (includeMechanismNotices !== true && isMechanismNotice(e)) continue
        const atMs = Date.parse(String(e.at ?? ''))
        const age = Number.isFinite(atMs) ? now - atMs : null
        if (age !== null && age < olderThanMs) continue
        out.push({ ...e, age_ms: age })
      }
      out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
      return out.slice(0, limit)
    },
    /** 席位侧投递（反向投递）留痕：`<task>|<kind>|seat:<role[#seat]>|<requestId>`。 */
    recordSeatDelivery(entry) {
      const e = {
        t: 'seat-wake',
        key: String(entry?.key ?? ''),
        task_id: String(entry?.task_id ?? ''),
        kind: String(entry?.kind ?? ''),
        seat: String(entry?.seat ?? ''),
        role: String(entry?.role ?? ''),
        session: String(entry?.session ?? ''),
        ok: entry?.ok === true,
        note: String(entry?.note ?? ''),
        at: typeof entry?.at === 'string' && entry.at.length > 0 ? entry.at : isoAt(Date.now()),
      }
      if (e.key.length === 0) return { ok: false, state, note: '空键不记。' }
      return append(e)
    },
    /** ★ 席位**接管**留痕（A28(b)）：该席位下一轮确实带着这条投递继续工作。 */
    markSeatConsumed({ key, by, action, at }) {
      const k = String(key ?? '')
      if (k.length === 0) return { ok: false, state, note: '空键不记。' }
      const rec = seatDeliveries.get(k)
      if (rec !== undefined && rec.consumed_at !== undefined && rec.consumed_at !== null) return { ok: true, state, note: '已记过。' }
      return append({ t: 'seat-consumed', key: k, at: typeof at === 'string' && at.length > 0 ? at : isoAt(Date.now()), by: String(by ?? ''), action: String(action ?? '') })
    },
    /** 某个席位**已投递但还没接管**的那些（A28 / T28）。 */
    pendingSeatDeliveries({ seat, taskId = '', limit = 20 } = {}) {
      const out = []
      for (const e of seatDeliveries.values()) {
        if (e.ok !== true) continue
        if (e.consumed_at !== undefined && e.consumed_at !== null) continue
        if (typeof seat === 'string' && seat.length > 0 && e.seat !== seat) continue
        if (taskId.length > 0 && e.task_id !== taskId) continue
        out.push(e)
      }
      out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
      return out.slice(0, limit)
    },
    /** 「没投出去」的事件：可见失败留痕（A3 / A8），巡检据此再叫一次。 */
    noteUnresolved(entry) {
      const e = {
        t: 'unresolved',
        at: typeof entry?.at === 'string' && entry.at.length > 0 ? entry.at : isoAt(Date.now()),
        task_id: String(entry?.task_id ?? ''),
        kind: String(entry?.kind ?? ''),
        actor: String(entry?.actor ?? ''),
        reason: String(entry?.reason ?? ''),
        detail: entry?.detail !== null && typeof entry.detail === 'object' ? entry.detail : {},
      }
      unresolved.push(e)
      if (unresolved.length > 2000) unresolved = unresolved.slice(-500)
      return append(e)
    },
    unresolvedEntries({ taskId = '', limit = 20 } = {}) {
      const list = taskId.length > 0 ? unresolved.filter((e) => e.task_id === taskId) : unresolved
      return list.slice(-limit)
    },
    /** 从既有事件数据重建（把"按现口径早该播过"的键补进账本）。 */
    rebuild(task) {
      const list = rebuildEntriesFromTask(task)
      let added = 0
      for (const e of list) {
        if (delivered.has(e.key)) continue
        const r = append({ t: 'wake', ...e, target: '', request_id: '' })
        if (r.ok === true) added += 1
      }
      return { ok: true, scanned: list.length, added, state, note: `重建口径扫出 ${list.length} 条，补进 ${added} 条。` }
    },
    /** 账本里出现过的任务 id（巡检"自己停摆"时至少知道该往哪几张单播报）。 */
    knownTaskIds() {
      const set = new Set()
      for (const e of delivered.values()) {
        const id = String(e.task_id ?? '')
        if (id.length > 0) set.add(id)
      }
      for (const e of unresolved) {
        const id = String(e.task_id ?? '')
        if (id.length > 0) set.add(id)
      }
      return [...set]
    },
    entries() {
      return [...entries]
    },
    snapshot() {
      return {
        status: this.status(),
        delivered: [...delivered.values()],
        consumed: [...consumed.values()],
        escalated: [...escalated.values()],
        seat_deliveries: [...seatDeliveries.values()],
        unresolved: [...unresolved],
      }
    },
  }
}
