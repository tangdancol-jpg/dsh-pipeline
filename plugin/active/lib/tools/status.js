/**
 * dsh-pipeline · 状态查询与速查（pipeline_status）
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/status
 */

import { ROLE, ROLES, roleLabel } from '../roles.js'
import { NO_CODE_READ_ROLES } from '../guard.js'
// ★ task.json 体积提示（P2 文案小修）：只 stat 一次、只影响 `detail="full"` 的正文，不改任何判据。
// ★★ P2-13（2026-10-19）：分页 + 存储体积诊断 —— 只读；**不改盘上数据、不裁剪任何内容**。
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// ★ 会话身份（`exec.agent.id`）—— A 件的主对话身份自查要拿它与盘上记录逐字比。
import { agentIdOf } from '../guard/seats.js'
import { DEFAULT_SEAT_SILENCE_MS, describeApprovalWait, describeSilentSeats, nextActionsFor, seatLiveness, summarizeApprovalWait } from '../liveness.js'
import { DISPATCH_SLOT_KEYS } from '../transport/index.js'
import { clamp } from '../util.js'
import { pendingWakesNextSteps, pendingWakesOf } from '../wakeup/pending.js'
// ★★ A 件（2026-10-16 真机 `T-20261016-fullai`）：主对话身份自查 + **下一步**。
import { judgeMainBinding } from '../wakeup/main-identity.js'
// ★ 总开关的**唯一判据**（不许自己写 `sw.isOn()` —— 见 lib/switch/gate.js）。
import { isEnabled } from '../switch/gate.js'
// ★★ 主管枢纽的**席位补派**（缺位自愈）：判据与实现都在它里面，这里只触发。
import { HUB_SEAT_RESPAWN_HEAD } from './hub-seats.js'
import { S, SNullable, tool, resolveActor } from './kit.js'
// ★★ P1-18：按档位的必需产物矩阵（唯一出处 `lib/tiers/product-matrix.js`，经 `lib/tiers.js` 转出）。
import { deferralLine, productKindsText, productStatusFor } from '../tiers.js'

/**
 * ★ P2 文案小修：`task.json` 超过这个体积就提醒"全文很大、建议用紧凑档"。
 *   取 1 MiB 的理由：5.3 MB 的实测单要提示，但正常单（几十 KB）不该多一行噪音；
 *   这个值只影响**正文提示**，不影响任何判据与返回字段。
 */
export const TASK_JSON_WARN_BYTES = 1024 * 1024

/**
 * `task.json` 体积提示（**纯函数**：给字节数，返回一行提示或空串）。
 *
 * 现场（P2）：`pipeline_status { detail: "full" }` 在一张 5.3 MB 的单上照旧倒全文，
 * 既不提示"为什么慢/贵"，也不给更省的取法 —— 主对话只能自己意识到。
 *
 * @param {unknown} bytes
 * @returns {string} 空串 = 不需要提示
 */
export function taskJsonSizeHint(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < TASK_JSON_WARN_BYTES) return ''
  const mb = (n / (1024 * 1024)).toFixed(1)
  return (
    `★ 提示：本任务的 task.json 已有 **${mb} MB** —— 全文输出会又大又慢。` +
    '建议改用 `detail="summary"`（紧凑档）或 `fields=[…]`（只取需要的字段）。'
  )
}

// ---------------------------------------------------------------------------
// ★★ P2-13 第一步（2026-10-19）：分页 + 存储体积诊断（**只读**）
// ---------------------------------------------------------------------------
//
// 现场：长单的 `task.json` 到 MB 级（实测 5.3 MB），`pipeline_status` 一次把
// `handoffs` / `history` / `dispatch_slots` / `human_requests` 全倒出来 ——
// 既慢又贵，而且**没有任何"这段之外还有多少、下一段怎么取"的口径**。
//
// 本节的三个约束（与 P2-13 的"第一步"一致）：
//   ① **只在显式给 `page` 时才分页**：不传 page ⇒ 正文逐字节与改前相同（既有断言不打红）；
//   ② **页码越界不报错**：返回空数组 + `_pagination` 说明（`out_of_range`），不抛；
//   ③ **不动盘上数据**：只 stat / 只读，不做任何裁剪或重写（体积治理是第二步的事）。

/** 分页默认段长（与 E 路既有 `BRIEF_PAGE_SIZE` 同一口径）。 */
export const STATUS_PAGE_SIZE_DEFAULT = 20
/** 分页段长上限（防止一次要 10 万条把返回撑爆）。 */
export const STATUS_PAGE_SIZE_MAX = 200
/** 存储体积提示阈值：任一字节数超过 1 MiB ⇒ 给 hint。 */
export const STORAGE_HINT_BYTES = 1024 * 1024

/**
 * 归一化分页入参（**纯函数**）。
 *
 * - 只有 `page` 显式给了（非 undefined / null / 空串）才 `enabled=true`；
 * - `page` 非法（<1 / 非数）按 1 处理；**不在这里报错**（越界由 `pageWindowOf` 报）；
 * - `page_size` 默认 20，夹到 [1, 200]。
 *
 * @param {object} args
 * @returns {{enabled:boolean, page:number, page_size:number}}
 */
export function normalizePaging(args = {}) {
  const hasPage = args?.page !== undefined && args?.page !== null && String(args.page).trim() !== ''
  const rawPage = Number(args?.page)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const rawSize = Number(args?.page_size)
  const pageSize = Number.isFinite(rawSize)
    ? Math.min(STATUS_PAGE_SIZE_MAX, Math.max(1, Math.floor(rawSize)))
    : STATUS_PAGE_SIZE_DEFAULT
  return { enabled: hasPage, page, page_size: pageSize }
}

/**
 * 切一段（**不钳位**：页码越界返回空数组 + `out_of_range`，不报错）。
 *
 * @param {unknown} list
 * @param {number} page
 * @param {number} pageSize
 * @returns {{slice:any[], page:number, page_size:number, total_pages:number, total_items:number, out_of_range:boolean}}
 */
export function pageWindowOf(list, page, pageSize) {
  const arr = Array.isArray(list) ? list : []
  const size = Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(STATUS_PAGE_SIZE_MAX, pageSize) : STATUS_PAGE_SIZE_DEFAULT
  const p = Number.isInteger(page) && page >= 1 ? page : 1
  const total = arr.length
  const totalPages = total === 0 ? 0 : Math.max(1, Math.ceil(total / size))
  const outOfRange = total > 0 && p > totalPages
  const start = (p - 1) * size
  return {
    slice: outOfRange ? [] : arr.slice(start, start + size),
    page: p,
    page_size: size,
    total_pages: totalPages,
    total_items: total,
    out_of_range: outOfRange,
  }
}

/** 一段的 `_pagination` 信封（字段与 P2-13 规格逐字一致；越界时补说明）。 */
export function paginationRecordOf(section, win) {
  return {
    section: String(section),
    page: win.page,
    page_size: win.page_size,
    total_pages: win.total_pages,
    total_items: win.total_items,
    ...(win.out_of_range === true
      ? { out_of_range: true, note: `页码越界：有效范围 1..${win.total_pages || 0}；本段返回空数组（不报错）` }
      : {}),
  }
}

/** 人类可读的字节数。 */
export function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1024) return `${Math.round(v)} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 递归算一个目录下文件的字节数（**有上限**：最多看 `cap` 个目录项）。
 *
 * 为什么有上限：状态查询不该变成磁盘扫描器；超大目录只统计到上限并标 `truncated`。
 *
 * @param {string} dir
 * @param {number} [cap]
 * @returns {{bytes:number, truncated:boolean, entries:number}}
 */
export function dirBytesOf(dir, cap = 4000) {
  const out = { bytes: 0, truncated: false, entries: 0 }
  const stack = [String(dir ?? '')].filter((d) => d.length > 0)
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      out.entries += 1
      if (out.entries > cap) {
        out.truncated = true
        return out
      }
      const abs = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(abs)
        continue
      }
      try {
        out.bytes += statSync(abs).size
      } catch {
        /* 读不到就跳过（诊断字段，不因它失败） */
      }
    }
  }
  return out
}

/**
 * 数一个文本文件的行数（**分块读**，不把大审计日志整个读进内存）。
 *
 * @param {string} filePath
 * @returns {number}
 */
export function countFileLines(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return 0
  let fd = null
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return 0
  }
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let lines = 0
    let total = 0
    let lastByte = null
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      total += n
      lastByte = buf[n - 1]
      for (let i = 0; i < n; i += 1) {
        if (buf[i] === 10) lines += 1
      }
    }
    return total > 0 && lastByte !== 10 ? lines + 1 : lines
  } catch {
    return 0
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 关不上不影响结论 */
    }
  }
}

/**
 * ★ **存储体积诊断**（只读；不裁剪、不改盘）。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {string} input.taskId
 * @param {object|null} input.task
 * @param {number|null} [input.taskJsonBytes]
 * @param {number|null} [input.auditLines]
 * @returns {{task_json_bytes:number|null, baseline_bytes:number|null, artifacts_bytes:number|null,
 *            handoff_count:number, history_count:number, audit_lines:number, hint:string|null}}
 */
export function collectStorageInfo(input = {}) {
  const { store, taskId, task } = input
  const rawJsonBytes = input.taskJsonBytes
  const jsonBytes = rawJsonBytes === null || rawJsonBytes === undefined || !Number.isFinite(Number(rawJsonBytes)) ? null : Number(rawJsonBytes)

  /** baseline 就住在 task.json 里（`task.baselines[]`）—— 量它占了多少。 */
  let baselineBytes = null
  if (Array.isArray(task?.baselines) && task.baselines.length > 0) {
    try {
      baselineBytes = Buffer.byteLength(JSON.stringify(task.baselines), 'utf8')
    } catch {
      baselineBytes = null
    }
  }

  /** artifacts：优先量磁盘目录；目录还没有记录时退回 `task.artifacts[].bytes` 之和。 */
  let artifactsBytes = null
  try {
    const taskDir = typeof store?.taskDir === 'function' ? store.taskDir(taskId) : ''
    const artDir = taskDir.length > 0 ? join(taskDir, 'artifacts') : ''
    if (artDir.length > 0 && existsSync(artDir)) {
      artifactsBytes = dirBytesOf(artDir).bytes
    } else if (Array.isArray(task?.artifacts)) {
      artifactsBytes = task.artifacts.reduce((sum, a) => sum + (Number.isFinite(a?.bytes) ? a.bytes : 0), 0)
    }
  } catch {
    artifactsBytes = null
  }

  const auditLines = Number.isFinite(Number(input.auditLines))
    ? Number(input.auditLines)
    : countFileLines(typeof store?.auditFile === 'function' ? store.auditFile(taskId) : '')

  const storage = {
    task_json_bytes: jsonBytes,
    baseline_bytes: baselineBytes,
    artifacts_bytes: artifactsBytes,
    handoff_count: Array.isArray(task?.handoffs) ? task.handoffs.length : 0,
    history_count: Array.isArray(task?.history) ? task.history.length : 0,
    audit_lines: auditLines,
  }

  const big = []
  if (Number.isFinite(jsonBytes) && jsonBytes > STORAGE_HINT_BYTES) big.push(`task.json ${formatBytes(jsonBytes)}`)
  if (Number.isFinite(baselineBytes) && baselineBytes > STORAGE_HINT_BYTES) big.push(`baseline ${formatBytes(baselineBytes)}`)
  if (Number.isFinite(artifactsBytes) && artifactsBytes > STORAGE_HINT_BYTES) big.push(`artifacts ${formatBytes(artifactsBytes)}`)
  storage.hint =
    big.length === 0
      ? null
      : `存储偏大（${big.join(' / ')}）。用 page=… 分页取 / fields=[…] 只取需要的字段 / detail="summary" 紧凑档；baseline 体积另见 P2-13 第二步。`
  return storage
}

/**
 * ★ P2-13 第二步：history 归档的**一行摘要**（归档文件数 / 已归档条数 / 当前窗口）。
 *   没触发过归档 ⇒ 空串（正文不多一行噪音）。
 *
 * @param {object|null} archive - `task.history_archive`
 * @returns {string}
 */
export function renderArchiveBrief(archive) {
  if (archive === null || archive === undefined || typeof archive !== 'object' || Array.isArray(archive)) return ''
  const files = Array.isArray(archive.files) ? archive.files : []
  const total = Number(archive.archived_total) || 0
  const windowSize = Number(archive.window) || 0
  const err = archive.last_error !== null && typeof archive.last_error === 'object' ? archive.last_error : null
  return (
    `归档 ${files.length} 文件 / ${total} 条（窗口 ${windowSize}）` +
    (err !== null ? `　⚠ 上次归档失败：${String(err.code ?? '?')}（未裁剪，见 audit:archive:failed）` : '')
  )
}

/** 存储诊断的**一行摘要**（全文档用；有 hint 时接在同一行末尾，不额外占行）。 */
export function renderStorageLine(storage, archive = null) {
  const s = storage ?? {}
  const parts = [`存储：task.json ${formatBytes(s.task_json_bytes)}`]
  if (s.baseline_bytes !== null && s.baseline_bytes !== undefined) parts.push(`baseline ${formatBytes(s.baseline_bytes)}`)
  parts.push(`artifacts ${formatBytes(s.artifacts_bytes)}`)
  parts.push(`交接物 ${Number(s.handoff_count) || 0} 份`)
  parts.push(`历史 ${Number(s.history_count) || 0} 条`)
  parts.push(`审计 ${Number(s.audit_lines) || 0} 行`)
  const arc = renderArchiveBrief(archive)
  if (arc.length > 0) parts.push(arc)
  return `${parts.join(' · ')}${s.hint ? `　★ ${s.hint}` : ''}`
}

/**
 * 紧凑档的存储摘要（**更短的一行**：紧凑档的立身之本是"省字节"，
 * 详细字节数在结构化 `storage` 里一个不少）。
 */
export function renderStorageBriefLine(storage, archive = null) {
  const s = storage ?? {}
  const arc = renderArchiveBrief(archive)
  return (
    `存储：task.json ${formatBytes(s.task_json_bytes)} · 交接物 ${Number(s.handoff_count) || 0} / 历史 ${Number(s.history_count) || 0} / 审计 ${Number(s.audit_lines) || 0} 行` +
    (arc.length > 0 ? ` · ${arc}` : '') +
    (s.hint ? '　★ 存储偏大：用 `page=` / `fields=` / `detail="summary"`（详见 `storage.hint`）' : '')
  )
}

/**
 * 状态查询与速查（pipeline_status）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildStatusTools(ctx) {
  const { deps, store, indexTask, load, paginate, hubSeats } = ctx

  /**
   * ★★ **P1-4：「在等审批」探测**（由 `index.js` 注入；自测替身没有 ⇒ 判据与改前逐字节相同）。
   *
   * 为什么工具层也要自己探一次：`pipeline_status` 的两条路径里有一条**不经过**
   * `store.checkLiveness`（"列全部任务"的扫描、以及"只报告不处置"档的详情视图），
   * 而那个误诊恰恰就是从**查状态**这一眼看到的（"失联，可能已经死了"）。
   * 探测只在**已经会被判失联**的席位上做（见 {@link liveWithApprovals}），
   * 正常干活时一次都不探。
   */
  const probeSeatApprovals = typeof deps.probeSeatApprovals === 'function' ? deps.probeSeatApprovals : null

  /**
   * 算一次失联（带"在等审批"二次判定）：先按原判据算，**只对候选失联的席位**
   * 探一次审批；探到了就带 `approvals` 重算 ⇒ 该席位从 `silent` 挪进 `awaiting`。
   *
   * ★ 探不到 / 探测抛错 ⇒ 原样返回第一次的结果（**真死席位照旧判死**）。
   *
   * @param {object} task
   * @param {number} nowMs
   * @param {number} silenceMs
   * @returns {Promise<object>} {@link seatLiveness} 的结果
   */
  async function liveWithApprovals(task, nowMs, silenceMs) {
    const baseOpts = { silenceMs }
    let lv = seatLiveness(task, nowMs, baseOpts)
    if (probeSeatApprovals === null || task === null || task === undefined || lv.silent.length === 0) return lv
    try {
      const probed = await probeSeatApprovals(lv.silent, task)
      const approvals = probed !== null && probed !== undefined ? probed.approvals ?? null : null
      if (approvals !== null && typeof approvals === 'object' && Object.keys(approvals).length > 0) {
        lv = seatLiveness(task, nowMs, { ...baseOpts, approvals })
      }
    } catch {
      // 探测失败按"读不到"处理 —— 不改变原有失联判据（这条新判据只做减法）。
    }
    return lv
  }

  /**
   * ★★ **"没人领的事件"清单**（2026-10-16 补 · 唤醒投递失败的兜底出口）。
   *
   * 判据**不在本文件**：整份在 `lib/wakeup/pending.js` 的 `pendingWakesOf`
   * （三条：取 unresolved / 剔掉后来已投递的 / 按待领键去重）。这里只做一件事 ——
   * 把 `deps.wakeup` 手上那份账本**同一个实例**递进去（账本只有一份，见
   * `index.js` 的装配：`createWaker({ ledger: wakeLedger })`）。
   *
   * 为什么要有它（现场 · 真单 `T-20261016-ff9ba7`）：那张单顶层连 `contacts` 键
   * 都没有 ⇒ 唤醒找不到该投给谁 ⇒ **整张单 22 次唤醒全部 `no-main-session`**
   * （跨两天）。改前这种失败**只落在 append-only 的 `audit.jsonl` 里**，
   * 主对话**没有任何确定的路子去捞它** —— 请求静默积压，全靠人自己发现。
   *
   * ★ 只读、不抛：账本没装配（`deps.wakeup` 缺失 / 自测替身）⇒ 空数组。
   *
   * @param {string} taskId
   */
  function pendingWakes(taskId) {
    return pendingWakesOf(deps?.wakeup?.ledger ?? null, taskId)
  }

  /** 计数分布渲染：`dev_to_test 3 / test_to_review 1`。 */
  function distribution(list, keyOf) {
    const m = new Map()
    for (const x of Array.isArray(list) ? list : []) {
      const k = String(keyOf(x) ?? '?')
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }

  /**
   * ★ **卡点**（"有没有卡、卡在哪"）—— 全部**派生自 `store.status()` 已经算好的字段**，
   * 不重算任何判据、不读盘、不改状态。返回的是"人话 + 谁要动"。
   */
  function statusBlockers(res, live) {
    const out = []
    const waiting = res.waiting ?? null
    if (waiting !== null) out.push(`${waiting.waiting_zh}（等 ${waiting.waiting_for}）`)
    const hg = res.hash_gate ?? null
    if (hg !== null && hg.blocked === true) out.push(`哈希前置闸门**卡着**（连续不过 ${hg.streak}/${hg.threshold}）`)
    if (hg !== null && hg.accepting_submissions === false) out.push('哈希闸门已连续到阈值 ⇒ **机制已交人工**，答复前拒收新提交（要用户拍板）')
    if (live !== null && live !== undefined && live.silent.length > 0) {
      out.push(`席位失联：${live.silent.map((s) => `${s.role_zh}${s.seat === null || s.seat === undefined ? '' : `(${s.seat})`} 静默 ${s.elapsed_zh}`).join('、')}`)
    }
    // ★★ P1-4：**在等审批**不是卡在席位身上（它没死），而是卡在**人**身上 —— 必须单列。
    if (live !== null && live !== undefined && Array.isArray(live.awaiting) && live.awaiting.length > 0) {
      out.push(`${summarizeApprovalWait(live.awaiting)}（★ 别重派 —— 重派会多起一个会话，白烧一轮）`)
    }
    if (res.pending_human_requests.length > 0) out.push(`等**用户**答复的人工请求 ${res.pending_human_requests.length} 条（主对话转告 → 用户拍板）`)
    if (res.pending_clarifications.length > 0) out.push(`等**需求分析**裁定的澄清请求 ${res.pending_clarifications.length} 条（还不用惊动用户）`)
    if (res.pending_roster_requests.length > 0) out.push(`等**计划 AI**复核的角色变更申请 ${res.pending_roster_requests.length} 条（主对话不能自己批）`)
    if (res.rework.dev >= res.rework.budget) out.push(`编写打回预算用尽（${res.rework.dev}/${res.rework.budget}）⇒ 该走人工/仲裁，不是再打回`)
    if (res.rework.test >= res.rework.budget) out.push(`测试打回预算用尽（${res.rework.test}/${res.rework.budget}）⇒ 该走人工/仲裁，不是再打回`)
    const hub = res.hub ?? null
    if (hub !== null && hub.enabled === true) {
      const standby = (hub.standby ?? []).filter((s) => s.status !== 'woken')
      if (standby.length > 0) out.push(`主管枢纽：${standby.map((s) => `${s.role}(${s.status_zh})`).join('、')}`)
      for (const st of hub.stations ?? []) {
        if (st.is_confirm_station !== true || st.complete === true) continue
        if ((st.missing ?? []).length > 0) out.push(`主管枢纽第${st.n}站（${st.station}）缺确认：${st.missing.join(' + ')}`)
      }
    }
    if (res.review_ok === null || res.review_ok === undefined) {
      // 只有"该有审核结论了"的时候才算卡点：还在前面几站时它只是"还没到"。
      const late = ['ready_review', 'reviewing', 'passed', 'ready_close', 'closed']
      if (late.includes(String(res.state))) out.push('尚无审核 OK（**没有它就不能关单**）')
      else out.push('尚无审核 OK（还没到审核站，属正常）')
    }
    return out
  }

  /**
   * ★ **侧路事件**：不推进主链的那几个（澄清 / 人工介入 / 阻塞 / 取消）。
   *
   * 为什么必须把它们摘出来：它们在状态机上**谁都能提**（`by` 名单一挂十几个角色），
   * 逐条列出来会把紧凑档**撑回全文那么大** —— 而"下一步该谁"这个问题问的其实是
   * **主链上下一跳是谁**。所以紧凑档分两行：
   *   · 主路径：`writer（dev_submitted → 待测试）`
   *   · 侧路：只给"有哪些、各自几个角色可提"，不逐个展开。
   *
   * 两份判据（一份明写、一份派生）—— **多认出来的算主路径**（啰嗦但不会漏），
   * 所以这里不会因为"漏写一个新侧路事件"而把关键信息吞掉。
   */
  const SIDE_EVENT_NAMES = new Set(['clarification_request', 'human_request', 'block', 'cancel', 'unblock'])
  const isSideEvent = (e) => SIDE_EVENT_NAMES.has(String(e?.event)) || (Array.isArray(e?.by) && e.by.length >= 4)

  /** ★ **下一步该谁**（判据 = 状态机给的 `next_events[].by`，不另立一套口径）。 */
  function statusNextOwners(res) {
    const main = new Map()
    const side = new Map()
    for (const e of res.next_events ?? []) {
      const bag = isSideEvent(e) ? side : main
      for (const who of e.by ?? []) {
        const k = String(who)
        const list = bag.get(k) ?? []
        list.push(`${e.event} → ${e.to_zh}`)
        bag.set(k, list)
      }
    }
    return {
      main: [...main.entries()].map(([who, events]) => ({ who, events })),
      side: [...side.entries()].map(([who, events]) => ({ who, events })),
      side_events: [...new Set((res.next_events ?? []).filter(isSideEvent).map((e) => String(e.event)))],
      total_events: (res.next_events ?? []).length,
    }
  }

  /** ★ 计数与分布（**算好再给** —— 调用方不该自己去数）。 */
  function statusCounts(res, live) {
    const kinds = distribution(res.handoffs, (h) => h.kind)
    const seats = live === null || live === undefined ? null : live.seats
    return {
      handoffs: res.handoffs.length,
      handoff_kinds: kinds.map(([kind, n]) => ({ kind, count: n })),
      rejected_deliveries: Array.isArray(res.rejected_deliveries) ? res.rejected_deliveries.length : 0,
      artifacts: res.artifacts.length,
      artifact_version: res.artifact_version ?? null,
      rework: { writer: res.rework.dev, tester: res.rework.test, budget: res.rework.budget },
      pending_human_requests: res.pending_human_requests.length,
      pending_clarifications: res.pending_clarifications.length,
      pending_roster_requests: res.pending_roster_requests.length,
      amendments: Array.isArray(res.amendments) ? res.amendments.length : 0,
      change_scope: Array.isArray(res.change_scope) ? res.change_scope.length : null,
      change_manifest: Array.isArray(res.change_manifest) ? res.change_manifest.length : 0,
      seats: Array.isArray(seats) ? seats.length : 0,
      silent_seats: live === null || live === undefined ? 0 : live.silent.length,
      /** ★ P1-4：在等审批的席位数（它们**不在** `silent_seats` 里 —— 不是失联）。 */
      awaiting_seats: live === null || live === undefined || !Array.isArray(live.awaiting) ? 0 : live.awaiting.length,
      review_ok: res.review_ok === null || res.review_ok === undefined ? null : res.review_ok.artifact_version,
    }
  }

  /**
   * ★★ **P1-18：产物矩阵的一行紧凑摘要**（`pipeline_status` 的「产物 / 关单」区块）。
   *
   * 要求原话：「显示"必需产物 / 已交 / 已豁免（理由）"（紧凑档一行，别撑体积）」。
   * 所以这里只给**算好的计数 + 必要的名字**（缺什么 / 豁免了什么），理由截断到 40 字符。
   * 判据与关单闸同源：`productStatusFor` 只看档位矩阵 + 任务卡上的豁免，
   * 不在状态这层重新判一遍。
   */
  function productBriefLine(products) {
    if (products === null || products === undefined || products.known !== true) {
      return `产物：档位未编排 —— 矩阵不适用（没有 role 清单就没有必需产物）`
    }
    const parts = [
      `产物（${products.tier}）：必需 ${products.required.length}`,
      `已交 ${products.delivered.length}`,
      `已豁免 ${products.deferred.length}`,
      `缺 ${products.missing.length}`,
    ]
    if (products.deferred.length > 0) {
      parts.push(`豁免：${products.deferred.map((d) => `${productKindsText([d.kind])}——${clamp(d.why, 40)}（${d.accepted_by}）`).join('；')}`)
    }
    if (products.missing.length > 0) parts.push(`缺：${productKindsText(products.missing)}`)
    return parts.join(' · ')
  }

  /**
   * ★★ **P1-18：产物矩阵的完整两行**（非紧凑档）。
   *   · 第一行：本档必需的产物清单（人话名）
   *   · 第二行：已交 / 已豁免（理由 + 批准人）/ 缺
   */
  function productFullLines(products) {
    if (products === null || products === undefined || products.known !== true) {
      return ['必需产物：（档位未编排 —— 矩阵不适用）']
    }
    const L = [`必需产物（${products.tier}，${products.required.length} 项）：${productKindsText(products.required.map((p) => p.kind))}`]
    const detail = [`已交 ${products.delivered.length}${products.delivered.length === 0 ? '' : `：${productKindsText(products.delivered)}`}`]
    if (products.deferred.length > 0) {
      detail.push(`已豁免 ${products.deferred.length}：${products.deferred.map((d) => deferralLine(d)).join('；')}`)
    }
    if (products.missing.length > 0) detail.push(`**缺 ${products.missing.length}**：${productKindsText(products.missing)}`)
    L.push(`  ${detail.join('　·　')}`)
    return L
  }

  /**
   * ★★ **P1-10：当前制品快照的一行紧凑摘要**（`pipeline_status` 的「制品快照」区块）。
   *
   * 要求原话：「显示当前制品的快照状态（版本、是否完整、文件数、校验时间；紧凑档一行）」。
   * 判据与关单闸 `artifact_snapshot_complete` **同源**（`describeArtifactSnapshot`），
   * 不在状态这层重新判一遍。
   */
  function snapshotBriefLine(snap) {
    if (snap === null || snap === undefined) return '制品快照：无可核对信息（尚无当前有效制品）'
    const head = `制品快照 ${snap.version ?? '（无当前制品）'}`
    if (snap.version === null) return `${head}：还没有当前有效制品（dev_to_test 没带 artifact_version）`
    if (snap.complete === true) {
      return (
        `${head}：**完整** ✓（${snap.file_count} 个文件，校验于 ${snap.verified_at ?? '（未记录）'}；` +
        `snapshot_id ${String(snap.snapshot_id).slice(0, 12)}…）`
      )
    }
    if (snap.legacy === true) {
      return `${head}：**不完整**（legacy 旧登记——没有 files 快照；L3+ 关单前需重登记带 files 的版本）`
    }
    if (snap.registered !== true) {
      return `${head}：**无登记记录**（无法核对快照；L3+ 关单前需先登记带 files 的制品）`
    }
    return (
      `${head}：**不完整**（缺 ${snap.missing_count} 个 / 哈希不一致 ${snap.mismatch_count} 个；` +
      `校验于 ${snap.verified_at ?? '（未记录）'}）→ 用 pipeline_artifact action=verify 看明细`
    )
  }

  /** ★ P1-10：非紧凑档的制品快照细节（不完整时把缺失/不一致的文件列出来）。 */
  function snapshotFullLines(snap) {
    const L = [snapshotBriefLine(snap)]
    if (snap !== null && snap !== undefined && Array.isArray(snap.missing) && snap.missing.length > 0) {
      L.push(`  · 缺失：${snap.missing.slice(0, 10).map((f) => f.path).join('、')}${snap.missing.length > 10 ? ' …' : ''}`)
    }
    if (snap !== null && snap !== undefined && Array.isArray(snap.mismatch) && snap.mismatch.length > 0) {
      L.push(`  · 哈希不一致：${snap.mismatch.slice(0, 10).map((f) => f.path).join('、')}${snap.mismatch.length > 10 ? ' …' : ''}`)
    }
    return L
  }

  /**
   * 紧凑档正文（`summary` / `count`）。
   *
   * ★ 每个**数**都在这里算好；`count` 只是把 `summary` 再压成一行。
   */
  function renderStatusBrief(res, live, opts = {}) {
    const mode = opts.mode === 'count' ? 'count' : 'summary'
    const c = statusCounts(res, live)
    const blockers = statusBlockers(res, live)
    const owners = statusNextOwners(res)
    const head =
      `任务 ${res.task_id}：${res.state_zh}(${res.state})` +
      (res.tier === null ? '　角色清单：尚未编排' : `　档位 ${res.tier} · 角色 ${res.roles.length} 个`) +
      `　制品 ${c.artifact_version ?? '（尚无）'}` +
      `　审核 OK ${c.review_ok === null ? '**尚无**' : c.review_ok}`
    const countLine =
      `计数：交接物 ${c.handoffs}${c.handoff_kinds.length === 0 ? '' : `（${c.handoff_kinds.map((k) => `${k.kind} ${k.count}`).join(' / ')}）`}` +
      ` · 被拒收 ${c.rejected_deliveries} · 制品 ${c.artifacts} 版` +
      ` · 打回 编写${c.rework.writer}/${c.rework.budget} 测试${c.rework.tester}/${c.rework.budget}` +
      ` · 待办人工 ${c.pending_human_requests} · 待裁澄清 ${c.pending_clarifications} · 待复核申请 ${c.pending_roster_requests}` +
      ` · 席位 ${c.seats}（失联 ${c.silent_seats}${c.awaiting_seats > 0 ? ` / 等审批 ${c.awaiting_seats}` : ''}）` +
      ` · 授权面 ${c.change_scope === null ? '无' : `${c.change_scope} 条`} / 实际改动 ${c.change_manifest} 处`
    if (mode === 'count') {
      return [
        head,
        `卡点 ${blockers.length} 个：${blockers.length === 0 ? '无' : blockers.join('；')}`,
        `下一步该谁（主链）：${owners.main.length === 0 ? '（无 —— 终态）' : owners.main.map((o) => o.who).join('、')}` +
          `${owners.side_events.length === 0 ? '' : `　侧路可提：${owners.side_events.join(' / ')}`}`,
        countLine,
        // ★ P1-18：产物矩阵一行（必需 / 已交 / 已豁免 / 缺）—— 紧凑档也只多这一行。
        productBriefLine(opts.products ?? null),
        // ★ P1-10：当前制品快照一行（版本 / 完整 / 文件数 / 校验时间）。
        snapshotBriefLine(res.artifact_snapshot ?? null),
        `★ 要摘要版：detail="summary"；要全文：detail="full"；只要某几个字段：fields=[…]。`,
      ].join('\n')
    }
    const L = [head]
    L.push(`卡点（${blockers.length}）：${blockers.length === 0 ? '**没有**（没有卡在任何人身上）' : ''}`)
    for (const b of blockers) L.push(`  · ${b}`)
    L.push(
      `下一步该谁（主链 ${owners.main.length} 方）：` +
        (owners.main.length === 0 ? '（无 —— 终态）' : owners.main.map((o) => `${o.who}（${o.events.join('；')}）`).join('　')),
    )
    if (owners.side_events.length > 0) {
      const n = new Set(owners.side.flatMap((o) => o.events)).size
      L.push(
        `  侧路（不推进主链，谁都能提）：${owners.side_events.join(' / ')}　—— 共 ${n} 种去向 / ` +
          `${owners.total_events} 条合法事件（要逐条看：\`detail="full"\` 的「下一步合法事件」一节）`,
      )
    }
    L.push(countLine)
    // ★ P1-18：产物矩阵一行（必需 / 已交 / 已豁免（理由）/ 缺）—— 紧凑档别撑体积。
    L.push(productBriefLine(opts.products ?? null))
    // ★ P1-10：当前制品快照一行（版本 / 是否完整 / 文件数 / 校验时间）—— 紧凑档一行。
    L.push(snapshotBriefLine(res.artifact_snapshot ?? null))
    const sc = res.scope_conformance ?? null
    if (sc !== null) {
      L.push(
        `改动面核对：**${sc.within_scope === true ? '全在授权面内 ✓' : `有越界 ✗（${(sc.out_of_scope ?? []).join('、')}）`}**` +
          `${(sc.unused_scope ?? []).length > 0 ? `；授权了却没动：${(sc.unused_scope ?? []).join('、')}` : ''}`,
      )
    }
    if (Array.isArray(res.amendments) && res.amendments.length > 0) {
      const a = res.last_amendment ?? res.amendments[res.amendments.length - 1]
      L.push(`授权面变更：共 ${res.amendments.length} 次，最近一次 ${a.amendment_id}（${a.by}，${a.at}）—— 为什么：${clamp(a.why, 120)}`)
    }
    if (res.failure !== null && res.failure !== undefined) L.push(`⚠ 运行失败判词：${clamp(JSON.stringify(res.failure), 200)}`)
    L.push('')
    L.push('★ 本段是**紧凑档**（' + mode + '）：要全文用 `detail="full"`；只要某几个字段用 `fields=[…]`（如 ["hash_gate","liveness"]）。')
    return L.join('\n')
  }

  /**
   * ★★ P2-13：**分页段**的正文渲染（`handoffs` / `human_requests` / `history` / `dispatch_slots` / `audit` 共用）。
   *
   * 只在调用方显式给了 `page` 时才走（不传 page 的路径保持改前逐字节一致）。
   * 每段末尾**必须**给 `_pagination` 信封与"下一段怎么取" —— 否则调用方只能靠
   * "看起来像完了"判断（然后重跑一遍 = 再付一次）。
   *
   * @param {string} section - 段名（写进 `_pagination.section`）
   * @param {string} title - 正文小节标题
   * @param {object} win - `pageWindowOf()` 的返回
   * @param {(item:any)=>string} mapLine - 单条渲染
   * @param {string} taskId
   * @returns {string[]}
   */
  function pagedSectionLines(section, title, win, mapLine, taskId) {
    const L = ['', `${title}：`]
    if (win.total_items === 0) {
      L.push('  （无）')
    } else if (win.out_of_range === true) {
      L.push(`  （本段为空 —— 页码越界：有效范围 1..${win.total_pages}；**不报错**，换一页再取）`)
    } else {
      for (const item of win.slice) L.push(mapLine(item))
    }
    const next =
      win.out_of_range === true
        ? ''
        : win.total_items === 0
          ? '；该段无条目'
          : win.total_pages > 0 && win.page < win.total_pages
            ? `；下一段：\`pipeline_status { task_id: "${taskId}", page: ${win.page + 1}, page_size: ${win.page_size} }\``
            : '；已是最后一段'
    L.push(`（_pagination ${section}：page ${win.page}/${win.total_pages}，page_size ${win.page_size}，total ${win.total_items}${next}）`)
    return L
  }

  /** 交接物单条（与改前逐字同格式）。 */
  const handoffToListLine = (h) => `  [${h.kind_zh}] ${h.from_role}→${h.to_role}  ${h.artifact_version ?? '-'}  ${h.handoff_id}`

  /** 人工请求单条（分页段的紧凑渲染；问题正文用 clamp 截断）。 */
  const humanRequestToListLine = (r) =>
    `  [${r.status}] ${r.request_id}  ${r.from_role}  ${r.reason_zh ?? r.reason_kind ?? ''}  blocked=${r.blocked_stage || '-'}` +
    `${typeof r.question_for_human === 'string' && r.question_for_human.length > 0 ? `\n      ${clamp(r.question_for_human, 120)}` : ''}`

  /** 历史单条（与 audit 内联同一套渲染口径：只给事件与一截 detail）。 */
  const historyToListLine = (e) =>
    `  ${e?.at ?? '?'}  ${e?.actor ?? '?'}  ${e?.action ?? '?'}  ` +
    clamp(JSON.stringify({ ...(e ?? {}), at: undefined, task_id: undefined, actor: undefined, action: undefined }), 200)

  /** 派活四槽单条。 */
  const dispatchSlotToListLine = (s) => `  ${clamp(JSON.stringify(s ?? null), 240)}`

  /**
   * ★ 紧凑档的分页摘要（一行）：告诉调用方"各段第几页 / 共几条 / 下一段怎么取"。
   */
  function pagingBriefLineOf(paged, pagedAudit, paging, taskId) {
    const secs = [
      ['交接物', paged.handoffs],
      ['人工请求', paged.human_requests],
      ['历史', paged.history],
      ['派活四槽', paged.dispatch_slots],
      ...(pagedAudit !== null ? [['审计', pagedAudit]] : []),
    ]
    const shown = secs.map(([name, w]) =>
      w.total_items === 0
        ? `${name} 0 条`
        : `${name} ${w.out_of_range === true ? `第 ${w.page} 页越界(空)` : `${w.page}/${w.total_pages}`}（本段 ${w.slice.length} / 共 ${w.total_items}）`,
    )
    const more = secs.some(([, w]) => w.out_of_range !== true && w.total_pages > 0 && w.page < w.total_pages)
    return (
      `分页：page=${paging.page} · page_size=${paging.page_size} —— ${shown.join(' · ')}` +
      (more
        ? `；下一段：\`pipeline_status { task_id: "${taskId}", page: ${paging.page + 1}, page_size: ${paging.page_size} }\``
        : '；已是最后一段')
    )
  }

  const status = tool(deps, {
    name: 'pipeline_status',
    description:
      '查询任务状态：当前状态、角色清单、制品版本、有效审核 OK、打回计数、下一步合法事件、最近交接物摘要、动作历史。' +
      '主对话默认拿到**脱敏摘要**（不含补丁正文与失败日志正文）—— 这就是"主对话与代码正文隔离"的默认面。' +
      '不带 task_id 时列出全部任务。',
    parameters: {
      task_id: S('string', '任务 ID（留空则列出全部任务）'),
      full: S('boolean', '是否返回未脱敏的完整交接物（仅执行角色该用）'),
      include_audit: S('boolean', '是否附上完整审计日志（只追加的动作流水）'),
      /**
       * ★★ **B12：插件的速查入口**。
       *
       * 现场：计划 AI 调 `pipeline_help` → `Error: unknown tool "pipeline_help"` ——
       * 那个名字**在本插件里从来不存在**（是模型照别的插件的 `normify_help` 猜的）。
       * 修法二选一里选"给它一个真的入口"：把速查挂在本就有、任何角色都会调的
       * `pipeline_status` 上（`help=<主题>`），并给出**与实现同源**的条目
       * （清单从真实常量派生，不手抄一份会漂移的文档）。
       */
      help: S('string', '★ 不查状态、改查**速查**：tools | flow | slots | roles | states | liveness | wake | all', { enum: ['tools', 'flow', 'slots', 'roles', 'states', 'liveness', 'wake', 'all'] }),
      /**
       * ★★ **E 路 ②：输出模式（投影）** —— 让模型"先用最便宜的投影探路"。
       *
       * 铁律：**不传 = 与改前逐字节相同**（既有调用方与断言一条都不许破）。
       * `summary` / `count` 都必须**自己把数算好**，不许让调用方去数。
       */
      detail: S('string', '★ 输出档（**不传 = 与改前逐字节相同**）：summary = 紧凑档（状态 + 卡点 + 下一步该谁 + 算好的计数）｜count = 只回结论与计数｜full = 现状全文（task.json 过大时会附体积提示）', { enum: ['summary', 'count', 'full'] }),
      fields: S('array', '★ 只回**点名的字段**（投影，省字节）：如 ["state","hash_gate","liveness"]；`ok` 永远保留。不传 = 回人读摘要。**未知字段名会回 `_unknown_fields` + `_available_fields` 可用键清单**', { items: { type: 'string' } }),
      page: S('number', '★ 分段取长清单（1 起；**不传 = 不分页，正文与改前逐字节一致**）。给 page 时对 handoffs / history / dispatch_slots / human_requests（含 include_audit 的 audit）分段，每段带 `_pagination` 信封；页码越界返回空数组 + 说明，不报错'),
      page_size: S('number', '★ 每段条数（默认 20，范围 1–200；只在给了 `page` 时生效）'),
      role_token: S('string', '角色令牌（查询也建议带上，便于按角色脱敏）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '可直接阅读的状态报告'),
      /** ★ 哈希前置闸门：连续不通过计数 + 自动交人工（升级未了结时拒收新提交）。 */
      hash_gate: SNullable('object', '★ 哈希前置闸门视图 { blocked, streak, threshold, accepting_submissions, checks, escalation }', { additionalProperties: true }),
      /**
       * ★★ **P1-18：按档位的必需产物矩阵**（状态展示与关单闸同源）。
       *   `{ tier, known, required:[{kind,zh,role,exemptible,delivered,deferred}], delivered[], deferred:[{kind,why,accepted_by}], missing[], non_exemptible[] }`
       */
      products: SNullable('object', '★ 产物矩阵视图 { tier, required[], delivered[], deferred[]（理由/批准人）, missing[] }（与关单闸同源）', { additionalProperties: true }),
      /**
       * ★★ **P1-10：当前有效制品的快照状态**（与关单闸 `artifact_snapshot_complete` 同源）。
       *   `{ version, registered, has_snapshot, legacy, complete, snapshot_id, file_count,
       *      verified_at, missing[], mismatch[], missing_count, mismatch_count }`
       *   `legacy=true` = 旧登记没有 files 快照（L3+ 关单视为不完整）。
       */
      artifact_snapshot: SNullable('object', '★ 当前制品快照状态 { version, complete, file_count, verified_at, legacy, missing[], mismatch[] }（与关单闸同源）', { additionalProperties: true }),
      /**
       * ★★ **主管枢纽视图**（T-20261011-56a37e）。
       *   `enabled=false` = 本任务未启用枢纽（走既有链）。
       *   启用时给出：两席待机的**可观测状态**（`standby[].status_zh` = 「已登记待机（未开工）」/
       *   「已唤醒（到点）」）、两个唤醒点的留痕（`wakes`）、各站点确认的**当前缺谁**
       *   （`stations[].missing`）、架构图重画计数、以及测试那份预登记是否**真的早于编写交付**。
       */
      hub: SNullable('object', '★ 主管枢纽视图 { enabled, standby[], wakes[], stations[], hub.diagram_redraws, prebrief }', { additionalProperties: true }),
      /** ★ 设计目的（最小改动）：授权面 / 实际面 / 核对结果 —— 判据级，不用人来比。 */
      change_scope: SNullable('array', '★ 授权改动面（计划给的；L0 为 null）[{ id, path, action, why }]', { items: { type: 'object', additionalProperties: true } }),
      /** ★ 与 change_scope 配对：这次**不许**做什么。 */
      forbidden: S('array', '★ 越界清单（这次不许做什么）', { items: { type: 'string' } }),
      /**
       * ★ **授权面变更（amendment）视图** —— 窄通道 `pipeline_scope_amend` 的可见面。
       *   没有它，"授权面被改过"这件事就只存在于审计日志里 = 等于没有。
       */
      amendments: S('array', '★ 授权面变更历史（窄通道 pipeline_scope_amend；按时间正序）', { items: { type: 'object', additionalProperties: true } }),
      last_amendment: SNullable('object', '★ **最近一次**授权面变更 { amendment_id, at, by, why, added[], removed[], … }（没改过就是 null）', { additionalProperties: true }),
      change_manifest: S('array', '★ 实际改动面（各席位交上来的）[{ path, action, scope_id, lines?, note? }]', { items: { type: 'object', additionalProperties: true } }),
      scope_conformance: SNullable('object', '★ 两者的核对结果 { within_scope, out_of_scope, unused_scope, manifest }', { additionalProperties: true }),
      role_boundaries: SNullable('array', '★ 角色边界卡（计划给的；派活时按它派）[{ role, only, not }]', { items: { type: 'object', additionalProperties: true } }),
      /**
       * ★★ **A13：被拒收的交付**（留档的可查面）。
       *
       * 改前 `archiveRejectedDelivery` 的 `recall` 指向「pipeline_status 的
       * 『被拒收的交付』一节」，而**那一节并不存在** —— 这个字段就是它。
       * ★ 主对话默认拿到的是**脱敏摘要**：`payload` 位置给的是"正文已隐去 + 多少字符"，
       *   提交内容正文不给（与 `handoffs` 同一条规矩）。
       */
      rejected_deliveries: S('array', '★ 被拒收的交付留档（A13）[{ delivery_id, at, kind, kind_zh, code, reason, from_role, from_seat, state_at_submit, payload_chars, payload }]（主对话脱敏：payload 不给正文）', { items: { type: 'object', additionalProperties: true } }),
      /**
       * ★★ **P2-13 第一步：分页段 + 分页信封 + 存储体积诊断**（只读）。
       *
       * 铁律：**不传 `page` ⇒ 这些字段一律为 null**（正文也与改前逐字节一致）；
       * 给 `page` 才返回**本段**（不是全量）。越界给空数组 + `_pagination.out_of_range`，不报错。
       */
      handoffs: SNullable('array', '★ 交接物**本段**（仅在给了 `page` 时非 null；不传 page 时为 null）', { items: { type: 'object', additionalProperties: true } }),
      history: SNullable('array', '★ 动作历史**本段**（仅在给了 `page` 时非 null；不传 page 时为 null）', { items: { type: 'object', additionalProperties: true } }),
      dispatch_slots: SNullable('array', '★ 派活四槽记录**本段**（仅在给了 `page` 时非 null；不传 page 时为 null）', { items: { type: 'object', additionalProperties: true } }),
      human_requests: SNullable('array', '★ 人工介入请求**本段**（仅在给了 `page` 时非 null；不传 page 时为 null）', { items: { type: 'object', additionalProperties: true } }),
      audit: SNullable('array', '★ 审计日志**本段**（仅在给了 `page` 且 `include_audit=true` 时非 null）', { items: { type: 'object', additionalProperties: true } }),
      _pagination: SNullable('object', '★ 每段的分页信封：{ <section>: { section, page, page_size, total_pages, total_items[, out_of_range, note] } }（不传 page 时为 null）', { additionalProperties: true }),
      total_handoffs: SNullable('number', '★ 交接物总条数（不传 page 时为 null；分页时与实际总数一致）'),
      total_history: SNullable('number', '★ 动作历史总条数（不传 page 时为 null）'),
      total_dispatch_slots: SNullable('number', '★ 派活四槽总条数（不传 page 时为 null）'),
      total_human_requests: SNullable('number', '★ 人工介入请求总条数（不传 page 时为 null）'),
      total_audit: SNullable('number', '★ 审计日志总行数（不传 page 时为 null；分页但没 include_audit 时也给总数）'),
      storage: S('object', '★ P2-13 存储体积诊断（只读）{ task_json_bytes, baseline_bytes, artifacts_bytes, handoff_count, history_count, audit_lines, hint }', { additionalProperties: true }),
      /**
       * ★★ P2-13 第二步：history 归档账本（只读）。
       *   `{ files:[{file,count,seq,from_iso,to_iso}], archived_total, window, last_at[, last_error] }`；
       *   没触发过归档 ⇒ null。归档**不删数据**（原件逐条保序留在 `archive/history-<seq>.jsonl`）。
       */
      history_archive: SNullable('object', '★ history 归档账本 { files[], archived_total, window, last_at[, last_error] }（没触发过归档时为 null）', { additionalProperties: true }),
      /** ★ 席位失联视图（`lib/liveness.js`）：派出去的席位还在不在。 */
      liveness: SNullable('object', '★ 席位失联视图 { ok, silence_ms, state, seats[], silent[] }', { additionalProperties: true }),
    },
    async run(args, exec) {
      const taskId = String(args.task_id ?? '')
      // ★★ B12：`help=<主题>` = 插件速查（与状态查询共用同一个入口，不另开工具）。
      if (typeof args.help === 'string' && args.help.length > 0) {
        const topic = String(args.help)
        const keys = topic === 'all' ? Object.keys(PIPELINE_HELP_TOPICS) : [topic]
        const missing = keys.filter((k) => PIPELINE_HELP_TOPICS[k] === undefined)
        if (missing.length > 0) {
          return {
            ok: false,
            summary: `未知速查主题「${missing[0]}」；可用：${Object.keys(PIPELINE_HELP_TOPICS).join(' | ')} | all`,
            liveness: null,
          }
        }
        const L = [`dsh-pipeline 速查 · 主题 ${topic}`, '']
        for (const k of keys) L.push(`== ${k} ==`, PIPELINE_HELP_TOPICS[k], '')
        return { ok: true, summary: L.join('\n'), liveness: null }
      }
      if (taskId.length === 0) {
        const list = await store.list()
        if (list.length === 0) {
          return { ok: true, summary: `目前没有任何流水线任务。工作区：${store.root}`, liveness: null }
        }
        // ★ **列全部任务时也扫一遍失联**：主对话往往就是先"看一眼所有任务"。
        //   只扫**有派活台账**的任务（没派过人就不存在失联），每条最多一次处置。
        const swept = []
        /** ★★ P1-4：**在等审批**的任务（与"失联"分两段写 —— 判据不同源、处置也不同）。 */
        const awaitingSwept = []
        const escalatedIds = []
        const silenceMs =
          Number.isInteger(deps.config?.seatSilenceMs) && deps.config.seatSilenceMs > 0
            ? deps.config.seatSilenceMs
            : DEFAULT_SEAT_SILENCE_MS
        for (const row of list) {
          const t = await load(row.id)
          if (t === null) continue
          if (!Array.isArray(t.dispatched) || t.dispatched.length === 0) continue
          // ★ 先按原判据算，只对候选失联的席位补一次"在等审批"探测（P1-4）。
          const lv = await liveWithApprovals(t, Date.now(), silenceMs)
          const awaitingNow = Array.isArray(lv.awaiting) ? lv.awaiting : []
          if (awaitingNow.length > 0) {
            awaitingSwept.push(
              `  ⏳ ${row.id}：${awaitingNow
                .map((s) => `${s.role_zh}${s.seat === null ? '' : `(${s.seat})`} 等 ${Number.isFinite(s?.approval?.count) ? s.approval.count : 0} 个审批`)
                .join('、')} ⇒ **不是失联、不该重派**（去对应会话里点审批卡）`,
            )
          }
          if (lv.silent.length === 0) continue
          let note = '（只报告，未处置）'
          if (deps.config?.seatLivenessEscalate === true) {
            const r = await store.checkLiveness(row.id, { escalate: true, probe: probeSeatApprovals })
            if (r.ok === true) {
              if (r.task !== undefined && r.task !== null) indexTask(r.task.id, r.task)
              if (r.escalated === true) {
                escalatedIds.push(row.id)
                note = '已推到「已阻塞」'
              }
            }
          }
          swept.push(`  ⚠ ${row.id}：${lv.silent.map((s) => `${s.role_zh}${s.seat === null ? '' : `(${s.seat})`}`).join('、')} 静默 ${lv.silent[0].elapsed_zh} ⇒ ${note}`)
        }
        /**
         * ★★ **孤儿单自恢复的只读可见面**（2026-10-14）。
         *
         * 为什么把它放在这里：主对话**不读日志文件**，而"机制自己意识到并重新投递过"
         * 这件事如果只落在 audit.jsonl 里，就等于用户看不到（那正是本单要消灭的静默）。
         * 所以最近一轮扫描的结论直接进"列全部任务"的正文。
         *
         * ★ **没有任何动作时一个字都不印**（不留噪音）；缺装配时也不印（自测夹具形状）。
         */
        const rescue = deps.orphanRescue
        const rep = rescue !== null && rescue !== undefined && typeof rescue.lastReport === 'function' ? rescue.lastReport() : null
        const acts = Array.isArray(rep?.actions) ? rep.actions : []
        const st = rescue !== null && rescue !== undefined && typeof rescue.status === 'function' ? rescue.status() : null
        const orphanLines =
          rep === null || (Number(rep.orphans ?? 0) === 0 && acts.length === 0)
            ? ''
            : `\n\n★ **孤儿单自恢复**（最近一轮 ${String(rep.at ?? '?')}）：扫描 ${Number(rep.scanned ?? 0)} 张单，` +
              `识别孤儿 ${Number(rep.orphans ?? 0)} 张（其中**本轮发起重投/报失败** ${Number(rep.new_orphans ?? 0)} 条）。\n` +
              acts
                .slice(0, 8)
                .map((a) => `  · ${a.task_id}　${a.kind}　${a.action}${String(a.note ?? '').length === 0 ? '' : `　${String(a.note).slice(0, 160)}`}`)
                .join('\n') +
              (st === null
                ? ''
                : `\n  累计：已重投 ${Number(st.stats?.redelivered ?? 0)} · 投不出去 ${Number(st.stats?.redeliver_failed ?? 0)} · 已放弃 ${Number(st.stats?.abandoned ?? 0)}` +
                  `（**不建会话、不派新席位、不改状态**；投不出去的失败另有 unresolved 播报，不是静默）`)
        /**
         * ★★ **E 路 ②：列全部任务也有紧凑档**。
         *
         * 改前每条任务都把 `requirement` **整段**贴出来（需求可以很长），
         * 而"我有哪些单、各在什么状态"这件事本来只需要**状态分布 + 计数**。
         * 判据不变、数据来源不变（同一个 `store.list()`），只是不再倒正文。
         * ★ 不传 `detail` ⇒ 下面的原路**逐字节不变**。
         */
        const listDetail = typeof args.detail === 'string' ? String(args.detail) : ''
        if (listDetail === 'summary' || listDetail === 'count') {
          const states = distribution(list, (t) => `${t.state_zh}(${t.state})`)
          const L = [
            `共 ${list.length} 个任务（紧凑档 ${listDetail}）：`,
            `状态分布（算好的）：${states.map(([k, n]) => `${k} ${n}`).join(' · ')}`,
            ...list.map((t) => `  ${t.id}  ${t.state_zh}(${t.state})` + (listDetail === 'count' ? '' : `  ${clamp(t.requirement, 80)}`)),
          ]
          if (swept.length > 0) {
            L.push('', `⚠ **席位失联（${swept.length} 个任务）**：`, ...swept)
            if (escalatedIds.length > 0) L.push(`★ 已自动推到「已阻塞」：${escalatedIds.join('、')}。`)
          }
          if (awaitingSwept.length > 0) {
            L.push('', `⏳ **在等审批（${awaitingSwept.length} 个任务）** —— 不是失联：`, ...awaitingSwept)
          }
          if (orphanLines !== '') L.push(orphanLines)
          L.push('', '★ 要逐条正文用 `detail="full"`（或干脆不传 detail，与改前一致）。')
          return {
            ok: true,
            summary: L.join('\n'),
            liveness:
              swept.length === 0 && awaitingSwept.length === 0
                ? null
                : { ok: false, silence_ms: silenceMs, swept: swept.length, escalated: escalatedIds, awaiting: awaitingSwept.length },
          }
        }
        return {
          ok: true,
          summary:
            `共 ${list.length} 个任务：\n${list.map((t) => `  ${t.id}  ${t.state_zh}(${t.state})  ${t.requirement}`).join('\n')}` +
            (swept.length === 0
              ? ''
              : `\n\n⚠ **席位失联（${swept.length} 个任务）**：\n${swept.join('\n')}` +
                (escalatedIds.length === 0
                  ? ''
                  : `\n★ 已自动推到「已阻塞」：${escalatedIds.join('、')}。恢复：\`pipeline_dispatch { task_id, role: "…", reassign: true }\`（会自动解除阻塞、不消耗打回预算）。`)) +
            (awaitingSwept.length === 0 ? '' : `\n\n⏳ **在等审批（${awaitingSwept.length} 个任务）** —— 不是失联、不要重派：\n${awaitingSwept.join('\n')}`) +
            orphanLines,
          liveness:
            swept.length === 0 && awaitingSwept.length === 0
              ? null
              : { ok: false, silence_ms: silenceMs, swept: swept.length, escalated: escalatedIds, awaiting: awaitingSwept.length },
        }
      }
      // 查询不强制角色（谁都能查状态），但脱敏按角色走。
      const actor = resolveActor(args, exec, deps)
      const isMain = actor.ok === true && actor.role === ROLE.MAIN
      /**
       * ★★ **B1（安全预审阻断项）：`full` 必须按角色受限。**
       *
       * 现场（安全预审实测判据 R1）：`full=true` 的消费点只有一处
       * （`store.status({ redactForMain:false })`）⇒ **非执行角色**（需求位 / 计划位，
       * 正是"不看代码"的那两个控制角色）可以用一条 `full=true` 拿到补丁正文、
       * 失败日志正文、运行命令正文。安全席的判定：**这是既有漏洞**（不属本单引入），
       * 但用户口径⑤要求需求位凭「脱敏后的证据正文」确认 —— 若新站点把证据通道建在这个开关上，
       * 等于把漏洞制度化，属「新增越权放行」⇒ **本席否决**。
       *
       * 处置（照 B1 的原话）：非执行角色（`NO_CODE_READ_ROLES` = main / 需求位 / 计划位 / 主管）
       * 请求 `full=true` ⇒ **拒绝**（不是静默降级 —— 静默降级会让调用方以为"我拿到的是全文"）。
       * 含**未绑定会话**（`actor.ok !== true`）：它拿不到角色，就更没有理由拿到正文。
       *
       * ★ 执行角色（测试 / 审核 / 编写等）的 `full=true` 一个字节没动（不得误伤）。
       */
      if (args.full === true) {
        const role = actor.ok === true ? String(actor.role) : ''
        if (role === '' || NO_CODE_READ_ROLES.includes(role)) {
          return {
            ok: false,
            summary:
              `拒绝：\`full=true\` 只对**执行角色**开放 —— 当前调用方${role === '' ? '没有绑定角色（未绑定会话）' : `是「${roleLabel(role)}」`}。\n` +
              `★ 判据：守门的 \`NO_CODE_READ_ROLES\` = ${NO_CODE_READ_ROLES.join(' / ')} —— 这几个角色**不看代码正文**。\n` +
              '  它们的确认依据是**证据标识 + 脱敏证据正文**（哪份交接物 id / 制品版本 / 内容哈希 / 计数与结论字段），\n' +
              '  不是把补丁正文搬过来。安全预审（H-35ab8749a1f6f103 实测判据 R1 / 阻断项 B1）已判定：\n' +
              '  把证据通道建在这个开关上，等于把"控制角色不看代码"这条边界制度化地绕开。\n' +
              '★ 要判"改动面对不对"：用 pipeline_change_audit（只给路径 + 哈希 + 结论，不给正文）。\n' +
              '★ 要判"测试过没过"：看 station_confirm 里的 basis_refs / basis_digest（脱敏证据面）。',
          }
        }
      }
      const res = await store.status({
        taskId,
        redactForMain: args.full === true ? isMain : true,
      })
      if (res.ok !== true) {
        // ⚠️ **失败也要刷新同步索引**：有些判据（哈希前置闸门）在拒绝之前
        //    已经把状态写进了任务（hash_gate.blocked）—— 不刷新的话守门看不到它，
        //    "闸门没过就不许跑测试"会静默失效。这是真踩过的坑。
        indexTask(taskId, await load(taskId))
        return { ok: false, summary: res.error }
      }
      indexTask(taskId, await load(taskId))

      /**
       * ★ P2 文案小修：`task.json` 的体积（**只 stat 一次**）。
       *   取不到就 null（不给提示好过给错提示）；提示只出现在 `detail:"full"`
       *   （含"不传 detail"的全文路）那一段正文里，紧凑档本来就在省字节、不重复劝。
       */
      let taskJsonBytes = null
      try {
        /**
         * ★ 公开 store 只暴露 `taskDir` / `auditFile`，**没有** `taskFile`（那是内部闭包）；
         *   这里对两种形状都认（自测夹具/旧装配可能挂 `taskFile`），否则悄悄退化成 null。
         *   —— 这是 P2-13 复查时发现的既有小坑（`task.json` 体积提示此前实际取不到大小）。
         */
        const taskJsonPath =
          typeof store.taskFile === 'function'
            ? store.taskFile(taskId)
            : typeof store.taskDir === 'function'
              ? join(store.taskDir(taskId), 'task.json')
              : ''
        if (taskJsonPath.length > 0) taskJsonBytes = statSync(taskJsonPath).size
      } catch {
        taskJsonBytes = null
      }

      /**
       * ★★ **待领事件**（唤醒投递失败的兜底出口，2026-10-16 补）：
       * 算一次，下面正文与返回字段**共用**（判据只有一份）。
       */
      const unclaimedWakes = pendingWakes(taskId)

      /**
       * ★★ **A 件 ②（2026-10-16 真机 `T-20261016-fullai`）：主对话身份自查 + 「下一步该做什么」。**
       *
       * 现场：DSH 重启后 `tokens`（进程内存态）全空 ⇒ 主对话调 `pipeline_dispatch` /
       *   `pipeline_task_purge` 一律被拒，原文「本会话既没有绑定任何角色，也没有携带
       *   role_token」。**没有人告诉它这件事** —— 它是撞上那堵墙才知道的，还得自己想起
       *   `pipeline_task_open { reattach: true }` 这条命令。
       *
       * 判据**不在本文件**：整份在 `lib/wakeup/main-identity.js` 的 `judgeMainBinding`
       *   （纯函数：不碰令牌表、不放宽任何校验、不绑任何身份）。这里只做两件事：
       *     ① 把盘上的证据取来（`contacts.main` + `task.history` 的**只读**兜底解析）；
       *     ② 把结论印在正文里（只给结构化字段 = 藏在返回值里）。
       *
       * ★ **自动恢复优先**：`deps.mainReattach`（若装配给了）先试一次 ——
       *   它就是 `lib/reattach.js` 那条既有的重启自动认领（判据 = 盘上
       *   `contacts.main.agent_id` 与本会话 id 逐字相等）。它成功 ⇒ 这次查询之后
       *   身份就回来了；它没成功 ⇒ 下面那句提示照旧给出来（**两条路各管一段**）。
       *   ★ 它失败/抛错**不许把那一次查询带崩**，也不许静默。
       */
      let mainIdentityLines = []
      let mainIdentityField = null
      try {
        const sid = agentIdOf(exec)
        if (actor.ok !== true && typeof deps.mainReattach === 'function' && typeof sid === 'string' && sid.length > 0) {
          try {
            await deps.mainReattach(sid)
          } catch (err) {
            mainIdentityLines.push(`⚠ 主对话侧自动认领异常（查状态本身不受影响）：${String(err?.message ?? err)}`)
          }
        }
        const lastKnownMain = typeof store.lastKnownMainAgent === 'function' ? await store.lastKnownMainAgent(taskId) : null
        // ⚠ 用 `await load(taskId)`（store 有缓存，不是第二次读盘）：`liveTask` 在下面才定义。
        mainIdentityField = judgeMainBinding({ task: await load(taskId), taskId, sessionId: sid ?? '', actor, lastKnownMain })
        if (mainIdentityField.bound !== true && mainIdentityField.hint.length > 0) {
          mainIdentityLines = [`${mainIdentityField.hint}`, ...mainIdentityLines]
        }
      } catch (err) {
        // ★ 判不出来就说"判不出来"—— **不写成"不用绑"**（那是静默）。
        mainIdentityLines = [`⚠ 主对话身份自查**没能完成**（查状态本身不受影响）：${String(err?.message ?? err)}`]
      }

      // ★ **席位失联视图**（读时暴露，**只报告不处置** —— 这个工具是只读的）。
      //
      //   处置（自动推到「已阻塞」）在 `tools/pre-execute` 那条缝上做，见 lib/intercept.js。
      //   为什么这里也报：主对话查状态是最自然的动作，而"任务停在需求分析中、
      //   交接物 0 份"这句话本身**看不出**是"它还在想"还是"它已经死了"——
      //   失联视图补的就是这一个比特。
      const liveTask = await load(taskId)
      /**
       * ★★ **P1-18：按档位的必需产物矩阵视图**（必需 / 已交 / 已豁免（理由）/ 缺）。
       *
       * ★ 与关单闸 `role_products_delivered` **同一份派生逻辑**（`productStatusFor`）——
       *   状态展示与关单判据不各算一套，否则"status 说齐了、close 说缺"就是必然。
       * ★ 只读：不写盘、不改状态。
       */
      const products = productStatusFor(liveTask ?? (await load(taskId)))
      const liveSilenceMs =
        Number.isInteger(deps.config?.seatSilenceMs) && deps.config.seatSilenceMs > 0
          ? deps.config.seatSilenceMs
          : DEFAULT_SEAT_SILENCE_MS
      let live = liveTask === null ? null : await liveWithApprovals(liveTask, Date.now(), liveSilenceMs)

      // ★★ **失联处置：查状态时也动手**（2026-10-11 复盘补的一条）。
      //
      //   为什么必须在这里处置：真实事故里席位**秒死**（turn/start 后 277 ms），
      //   此后**没有任何角色再调用工具** —— 挂在 `tools/pre-execute` 上的那个触发点
      //   永远等不到"下一次调用"。而主对话查 `pipeline_status` 恰恰是它**唯一**一定会做的动作。
      //   只报告不处置 = 把"机制能意识到"降级成"下次有人动手时才可能说一句"，
      //   任务依旧静静停在「需求分析中」。
      //
      //   ★ 开关复用 `config.seatLivenessEscalate`（false = 只报告不处置，那时输出里会**明写**）。
      const escalateOn = deps.config?.seatLivenessEscalate === true
      let handled = null
      if (live !== null && live.silent.length > 0 && escalateOn) {
        const r = await store.checkLiveness(taskId, { escalate: true, probe: probeSeatApprovals })
        if (r.ok === true) {
          if (r.task !== undefined && r.task !== null) indexTask(r.task.id, r.task)
          handled = r
          live = r.live ?? live
        }
      }
      const liveAwaiting = live === null || live === undefined || !Array.isArray(live.awaiting) ? [] : live.awaiting
      const liveLines =
        live === null || live.seats.length === 0
          ? []
          : [
              live.silent.length === 0
                ? `席位：已派 ${live.seats.length} 个，均**无失联**（静默阈值 ${live.silence_zh}）` +
                  (liveAwaiting.length === 0 ? '' : `；其中 **${liveAwaiting.length} 个在等你审批**（不是失联）`)
                : describeSilentSeats(live.silent, { state: live.state, state_zh: live.state_zh, silenceMs: live.silenceMs }),
              ...(live.silent.length === 0
                ? []
                : [
                    escalateOn
                      ? handled !== null && handled.escalated === true
                        ? `★ **已自动处置**：任务已推到「已阻塞」（原因写进 task.liveness.escalations + 审计）。` +
                          `解除：\`pipeline_transition { task_id: "${taskId}", event: "unblock" }\`；` +
                          `或直接重派（会自动恢复）：\`pipeline_dispatch { task_id: "${taskId}", role: "…", reassign: true }\`。`
                        : `⚠ 失联已确认，但自动处置没成功：${String(handled?.note ?? '（见审计）')}`
                      : `⚠ **只报告、未处置**（\`seatLivenessEscalate:false\`）：任务状态**保持不变**。` +
                        '要恢复请显式调 `pipeline_dispatch { …, reassign: true }` 或 `pipeline_transition event="unblock"`。',
                    ...nextActionsFor(live.silent, { taskId }),
                  ]),
              /**
               * ★★ **P1-4：在等审批的判词**（放在失联判词之后、独立一段）。
               *   它回答的是"这不是失联，那是谁在拖" —— 误诊消失的那一眼就在这里。
               */
              ...(liveAwaiting.length === 0 ? [] : [describeApprovalWait(liveAwaiting, { taskId, state: live.state, state_zh: live.state_zh })]),
            ]

      /**
       * ★★ **③ 自愈：状态到了、人没到**（2026-10-16，真缺陷：L5 死锁）。
       *
       * 现场：主管 `initiate` / `agree_need` 之后状态推进了，**席位却不存在**
       *   （真机 `T-20261016-fullai` 静默 4 分 13 秒等一个不会到的席位）；
       *   而那时主对话连"补派"都做不到（引导步白名单只放开需求分析）⇒ 死锁。
       *
       * 为什么触发点选在**查状态**这一刻：这与上面那条"失联处置：查状态时也动手"
       *   **逐字同源** —— 出事时**没有任何角色会再调工具**，而主对话查
       *   `pipeline_status` 恰恰是它唯一一定会做的动作。
       *
       * 四条边界（缺一条就不做）：
       *   ① **总开关为开** —— 关掉功能时，只读工具**一个字节都不许写项目目录**；
       *   ② **枢纽已发起**（`hub.enabled`）—— 没发起就没有"该到的人"这回事；
       *   ③ 只补**账本授权的角色**（需求位 + **已到点唤醒**的待机席位）——
       *      已登记待机（`standby`）**不补**：那时该做的是"登记可见"，不是叫人开工；
       *   ④ **幂等** —— 判据是派活台账里**有没有这一条**，有就不动；补派走
       *      `pipeline_dispatch` 的既有入口（真会话 + 四槽 + 令牌 + 台账 + 全部既有闸门），
       *      每次补派写 `hub:seat-respawn` 进审计（谁、什么时候、补的谁、成没成）。
       */
      let hubSeatLines = []
      if (hubSeats !== undefined && hubSeats !== null && isEnabled(deps.sw)) {
        try {
          const hubTask = liveTask ?? (await load(taskId))
          if (hubTask !== null && hubTask?.hub?.enabled === true) {
            const ensured = await hubSeats.ensureHubSeats(hubTask, exec, {
              by: actor.ok === true ? actor.role : 'mechanism',
              via: 'pipeline_status:self-heal',
              reason: '状态到了人没到（枢纽已发起 / 已到点唤醒，而席位不存在）',
            })
            if (ensured.lines.length > 0) hubSeatLines = [HUB_SEAT_RESPAWN_HEAD, ...ensured.lines]
          }
        } catch (err) {
          // ★ 自愈失败**不许把查状态带崩**（与失联处置同一条纪律），但也**不许静默**。
          hubSeatLines = [`⚠ 枢纽席位自愈补派失败（查状态本身不受影响）：${String(err?.message ?? err)}`]
        }
      }

      /**
       * ★★ **E 路 ②：紧凑档（`detail: "summary" | "count"`）**。
       *
       * ★ 只换**正文**，不换任何结构化字段、不换判据、不换脱敏口径 ——
       *   下面那个 return 一个字没动（紧凑档与全文档返回的是同一个形状）。
       * ★ `detail` 缺省 / `"full"` ⇒ `isBrief === false` ⇒ **原路，逐字节不变**。
       */
      const briefMode = typeof args.detail === 'string' ? String(args.detail) : ''
      const isBrief = briefMode === 'summary' || briefMode === 'count'
      /**
       * ★★ P2-13：**只有显式给了 `page` 才分页**。不传 ⇒ 下面的分页段全部 `null`，
       *   正文与结构化字段保持改前形状（既有断言不打红）。
       */
      const paging = normalizePaging(args)
      const paged =
        paging.enabled === true
          ? {
              handoffs: pageWindowOf(res.handoffs, paging.page, paging.page_size),
              human_requests: pageWindowOf(res.human_requests, paging.page, paging.page_size),
              history: pageWindowOf(liveTask?.history, paging.page, paging.page_size),
              dispatch_slots: pageWindowOf(liveTask?.dispatch_slots, paging.page, paging.page_size),
            }
          : null
      /** 审计日志只读一次：分页时切段，不分页时照旧整段内联（读盘与改前同一条路径）。 */
      const wantAudit = args.include_audit === true && !isBrief
      const auditLog = wantAudit ? await store.auditLog(taskId) : null
      const pagedAudit = paged !== null && auditLog !== null ? pageWindowOf(auditLog, paging.page, paging.page_size) : null
      /** ★ P2-13 存储体积诊断（只读；紧凑档/全文档都只占一行）。 */
      const storage = collectStorageInfo({ store, taskId, task: liveTask, taskJsonBytes })
      /**
       * ★ P2-13 第二步：history 归档账本（只读）。
       *   紧凑档：并进存储那一行（文件数 / 条数 / 窗口）；
       *   全文档：额外单独一行（`history 归档：…`），并作为结构化字段 `history_archive` 返回。
       */
      const archiveInfo = res.history_archive ?? null
      const lines = isBrief
        ? [
            renderStatusBrief(res, live, { mode: briefMode, products }),
            renderStorageBriefLine(storage, archiveInfo),
            ...(paged === null ? [] : [pagingBriefLineOf(paged, pagedAudit, paging, taskId)]),
            ...hubSeatLines,
            ...mainIdentityLines,
          ]
        : [
        `任务 ${res.task_id}：${res.state_zh}(${res.state})`,
        `原始需求：${clamp(res.requirement, 300)}`,
        res.tier === null ? '角色清单：（尚未编排）' : `档位：${res.tier} · 独立对话数：${res.ai_count} · 角色：${res.roles.join(' / ')}`,
        res.sequence.length > 0 ? `调用顺序：${res.sequence.join(' → ')}` : '',
        // ★ 设计目的（最小改动）：把两面摊开 —— 判据级，调用方不用自己去比
        res.change_scope === null || res.change_scope === undefined
          ? '改动面：**无授权面**（本档没有"计划"这一站，如 L0）'
          : `改动面（授权 ${res.change_scope.length} 条）：${res.change_scope.map((e) => `${e.id} ${e.action} ${e.path}`).join('；')}`,
        Array.isArray(res.forbidden) && res.forbidden.length > 0
          ? `越界清单（${res.forbidden.length} 条）：${res.forbidden.join('；')}`
          : '',
        // ★ 授权面变更（amendment）的可见面：改过就说清"谁在什么时候为什么改的"
        res.last_amendment === null || res.last_amendment === undefined
          ? ''
          : `★ 最近一次授权面变更：${res.last_amendment.amendment_id}（计划 AI，${res.last_amendment.at}，共 ${res.amendments.length} 次）\n` +
            `    为什么：${clamp(res.last_amendment.why, 200)}\n` +
            `    加了：${(res.last_amendment.added ?? []).map((e) => `${e.id} ${e.action} ${e.path}`).join('；') || '（无）'}` +
            `${(res.last_amendment.removed ?? []).length > 0 ? `　撤销：${res.last_amendment.removed.join('、')}` : ''}` +
            `${(res.last_amendment.forbidden_added ?? []).length > 0 ? `　新增禁令：${res.last_amendment.forbidden_added.join('；')}` : ''}` +
            '（★ 只动授权面：席位 / 角色清单 / 档位 / 顺序 / 层一个字没动）',
        res.scope_conformance === null || res.scope_conformance === undefined
          ? ''
          : `改动面（实际 ${(res.scope_conformance.manifest ?? []).length} 处）：核对结果 **${
              res.scope_conformance.within_scope === true ? '全在授权面内 ✓' : `有越界 ✗（${(res.scope_conformance.out_of_scope ?? []).join('、')}）`
            }**${(res.scope_conformance.unused_scope ?? []).length > 0 ? `；授权了却没动：${res.scope_conformance.unused_scope.join('、')}` : ''}`,
        Array.isArray(res.role_boundaries) && res.role_boundaries.length > 0
          ? `角色边界卡：${res.role_boundaries.map((b) => b.role).join(' / ')}（派活时按它派）`
          : '',
        `制品版本：${res.artifact_version ?? '（尚无）'}${res.artifacts.length > 0 ? `（历史：${res.artifacts.map((a) => a.version).join(', ')}）` : ''}`,
        // ★★ P1-10：当前有效制品的快照状态（版本 / 完整 / 文件数 / 校验时间；不完整时列文件）。
        ...snapshotFullLines(res.artifact_snapshot ?? null),
        // ★★ P1-18：产物矩阵（必需 / 已交 / 已豁免（理由、批准人）/ 缺）—— 与关单闸同源。
        ...productFullLines(products),
        `打回计数：编写 ${res.rework.dev}/${res.rework.budget}，测试 ${res.rework.test}/${res.rework.budget}`,
        // ★★ P2-13：存储体积诊断（只读；一行，不撑体积）+ history 归档账本（有则多一行）。
        renderStorageLine(storage, archiveInfo),
        ...(archiveInfo === null
          ? []
          : [
              `history 归档：${(Array.isArray(archiveInfo.files) ? archiveInfo.files : []).length} 个文件 / 共 ${Number(archiveInfo.archived_total) || 0} 条（task.json 窗口 ${Number(archiveInfo.window) || 0}；最近 ${archiveInfo.last_at ?? '-'}）` +
                (Array.isArray(archiveInfo.files) && archiveInfo.files.length > 0
                  ? `\n  文件：${archiveInfo.files.map((f) => `${f.file}（${f.count} 条，${f.seq}）`).join(' / ')}`
                  : '') +
                (archiveInfo.last_error ? `\n  ⚠ **上次归档失败**（${archiveInfo.last_error.code ?? '?'}，${archiveInfo.last_error.at ?? '-'}）：${clamp(String(archiveInfo.last_error.note ?? ''), 300)}` : ''),
            ]),
        res.hash_gate === null || res.hash_gate === undefined
          ? ''
          : `哈希前置闸门：${res.hash_gate.blocked ? '**卡着**' : '通过'}　连续不通过 ${res.hash_gate.streak}/${res.hash_gate.threshold}` +
            `${res.hash_gate.accepting_submissions ? '' : '　★ **已连续到阈值 ⇒ 机制已交人工，答复前拒收新提交**'}` +
            `${res.hash_gate.escalation === null || res.hash_gate.escalation === undefined ? '' : `（第 ${res.hash_gate.escalation.round} 次升级，${res.hash_gate.escalation.request_id ?? '?'}）`}` +
            `（历史比对 ${res.hash_gate.checks_total} 次）`,
        res.review_ok === null
          ? '审核 OK：**尚无**（没有它就不能关单）'
          : `审核 OK：${res.review_ok.handoff_id}（制品 ${res.review_ok.artifact_version}，${res.review_ok.at}）`,
        res.pending_roster_requests.length > 0
          ? `待复核的角色变更申请：${res.pending_roster_requests.map((r) => `${r.request_id}(由 ${r.by} 提出)`).join('，')}`
          : '',
        '',
        '下一步合法事件：',
        ...(res.next_events.length === 0
          ? ['  （无 —— 终态）']
          : res.next_events.map((e) => `  ${e.event} → ${e.to_zh}（${e.by.join('/')}）：${e.note}`)),
        '',
        /**
         * ★★ P2-13：交接物清单。
         *   · 不传 page ⇒ **与改前逐字节一致**（全量、无脚注）；
         *   · 传 page   ⇒ 只印本段 + `_pagination` 信封与"下一段怎么取"。
         */
        ...(paged === null
          ? [
              `交接物（${res.handoffs.length} 份）：`,
              ...(res.handoffs.length === 0 ? ['  （无）'] : res.handoffs.map(handoffToListLine)),
            ]
          : pagedSectionLines('handoffs', `交接物（共 ${paged.handoffs.total_items} 份）`, paged.handoffs, handoffToListLine, taskId)),
        /** ★ P2-13：人工请求段（只在分页时单独铺开；不分页时与改前一样不铺开）。 */
        ...(paged === null
          ? []
          : pagedSectionLines('human_requests', `人工请求（共 ${paged.human_requests.total_items} 条）`, paged.human_requests, humanRequestToListLine, taskId)),
        /** ★ P2-13：动作历史段（同上：只在分页时出现）。 */
        ...(paged === null
          ? []
          : pagedSectionLines('history', `动作历史（共 ${paged.history.total_items} 条）`, paged.history, historyToListLine, taskId)),
        /** ★ P2-13：派活四槽段（同上：只在分页时出现）。 */
        ...(paged === null
          ? []
          : pagedSectionLines('dispatch_slots', `派活四槽（共 ${paged.dispatch_slots.total_items} 条）`, paged.dispatch_slots, dispatchSlotToListLine, taskId)),
        // ★★ **A13：被拒收的交付** —— `recall` 字段指的就是这一节（改前它并不存在）。
        //   只在**真有**留档时印；**不印正文**（与上面的交接物同一条脱敏规矩）。
        ...(Array.isArray(res.rejected_deliveries) && res.rejected_deliveries.length > 0
          ? [
              '',
              `被拒收的交付（${res.rejected_deliveries.length} 条；★ 拒收判决不受影响 —— 这些是**留档可查**的）：`,
              ...res.rejected_deliveries.map(
                (d) =>
                  `  [${d.kind_zh}] ${d.from_role}${d.from_seat === null ? '' : `(${d.from_seat})`}  ${d.code}  ${d.at}  ${d.delivery_id}` +
                  `\n      为什么被拒：${clamp(d.reason, 300)}` +
                  `\n      交的是什么：${d.payload_chars} 字符${d.payload_truncated_from === null ? '' : '（留档时超长已截断）'}` +
                  `　★ 正文按脱敏规矩不在这里展开（按上面那枚 delivery_id 取）`,
              ),
            ]
          : []),
        /**
         * ★★ **没人领的事件**（正文里也要看得见 —— 只给结构化字段等于"藏在返回值里"）。
         *   主对话查状态时第一眼就该看到"有 N 条事件没送到我这儿"。
         */
        ...(unclaimedWakes.length > 0
          ? [
              '',
              `★★ 没人领的事件（${unclaimedWakes.length} 条）—— 它们**没有被投出去**，不是没发生：`,
              ...unclaimedWakes.map(
                (p) => `  [${p.reason}] ${p.kind}／${p.actor || '?'}  ${p.at}\n      待领键：${p.key}\n      ${p.what}`,
              ),
              /**
               * ★★ **A 件 ③（2026-10-16）**：光有"没投出去"不够 —— **下一步该做什么**要写死。
               *   判据与文案**唯一出处**是 `lib/wakeup/pending.js` 的 `pendingWakesNextSteps`
               *   （这里只铺开它，不另抄一份 —— 抄一份就会漂移）。
               */
              ...pendingWakesNextSteps(taskId),
            ]
          : []),
        ...liveLines,
        // ★★ 缺位自愈的结论（补了谁 / 没补成 / 为什么）—— 只给结构化字段等于"藏在返回值里"。
        ...hubSeatLines,
        // ★★ A 件②：主对话身份自查的结论与**下一步**（同上：必须印在正文里）。
        ...mainIdentityLines,
      ]

      /**
       * ★ E 路 ②：紧凑档**不追加**审计日志与完整交接物 —— 那正是它要省掉的部分
       *   （`detail` 与 `include_audit` / `full` 同时给时以 `detail` 为准：
       *    调用方已经明说"我要紧凑的"；要全文就 `detail="full"`）。
       * ★★ P2-13：给了 `page` 时，审计日志也只印**本段** + `_pagination` 信封。
       */
      if (wantAudit && auditLog !== null) {
        if (pagedAudit === null) {
          lines.push('', `审计日志（${auditLog.length} 条）：`, ...auditLog.map(historyToListLine))
        } else {
          lines.push(...pagedSectionLines('audit', `审计日志（共 ${pagedAudit.total_items} 条）`, pagedAudit, historyToListLine, taskId))
        }
      }

      if (args.full === true && !isMain && !isBrief) {
        /** ★ P2-13：分页时"完整交接物"也只印本段（不再把整份全量 JSON 倒出来）。 */
        const handoffsForJson = paged === null ? res.handoffs : paged.handoffs.slice
        lines.push('', '完整交接物：', '```json', JSON.stringify(handoffsForJson, null, 2), '```')
        if (paged !== null) {
          lines.push(
            `（_pagination handoffs：page ${paged.handoffs.page}/${paged.handoffs.total_pages}，page_size ${paged.handoffs.page_size}，` +
              `total ${paged.handoffs.total_items}；本段只印 ${handoffsForJson.length} 份` +
              `${paged.handoffs.out_of_range === true ? '；**页码越界**（返回空数组，不报错）' : ''}）`,
          )
        }
      } else if (!isBrief && (isMain || actor.ok !== true)) {
        lines.push('', '（主对话看到的是脱敏摘要：补丁正文、失败日志正文、运行命令正文已隐去。）')
      }

      // ★ P2 文案小修：全文路才提示体积（紧凑档与 fields 投影不会走到这里）。
      const sizeHint = isBrief ? '' : taskJsonSizeHint(taskJsonBytes)
      if (sizeHint.length > 0) lines.push('', sizeHint)

      /**
       * ★★ P2-13：分页信封（**每段一条**，字段与规格逐字一致）。
       *   `page=null`（没给 page）⇒ `_pagination` 为 null、分页段字段一律 null —— 与改前同形状。
       */
      const pagination = paged === null
        ? null
        : {
            handoffs: paginationRecordOf('handoffs', paged.handoffs),
            human_requests: paginationRecordOf('human_requests', paged.human_requests),
            history: paginationRecordOf('history', paged.history),
            dispatch_slots: paginationRecordOf('dispatch_slots', paged.dispatch_slots),
            ...(pagedAudit === null ? {} : { audit: paginationRecordOf('audit', pagedAudit) }),
          }

      return {
        ok: true,
        summary: lines.filter((l) => l !== '').join('\n'),
        // ★ 设计目的：这两面以**结构化字段**给出，调用方不必从散文里抠
        change_scope: res.change_scope ?? null,
        /** ★ 越界清单 + 授权面变更历史（窄通道的可见面） */
        forbidden: Array.isArray(res.forbidden) ? res.forbidden : [],
        amendments: Array.isArray(res.amendments) ? res.amendments : [],
        last_amendment: res.last_amendment ?? null,
        change_manifest: res.change_manifest ?? [],
        scope_conformance: res.scope_conformance ?? null,
        role_boundaries: res.role_boundaries ?? null,
        // ★ 哈希前置闸门（P13：连续不过计数 + 自动交人工）
        hash_gate: res.hash_gate ?? null,
        // ★★ P1-18：产物矩阵视图（必需 / 已交 / 已豁免（理由、批准人）/ 缺）—— 与关单闸同源
        products: products ?? null,
        // ★★ P1-10：当前制品快照状态（版本 / 完整 / 文件数 / 校验时间）—— 与关单闸同源
        artifact_snapshot: res.artifact_snapshot ?? null,
        /**
         * ★★ **主管枢纽视图**（T-20261011-56a37e）。
         *   用户口径③要「待机**要能看出来**」，验收 5 要「每道站点各自留痕」——
         *   两件事都得**读得回来**，只在拒绝原文里出现是不够的。字段的含义见 output schema。
         */
        hub: res.hub ?? null,
        // ★ 席位失联视图（silent 非空 = 派出去的席位在静默）
        liveness:
          live === null
            ? null
            : {
                ok: live.ok,
                silence_ms: live.silenceMs,
                state: live.state,
                seats: live.seats,
                silent: live.silent,
                /**
                 * ★★ **P1-4：在等审批的席位**（`seats[]` 里 `approval.count > 0` 的那些）。
                 *   它们**不在** `silent` 里 —— 拿这一项回答"它是不是死了"：
                 *   不是，它在**等人点审批**；处置是「去那个会话点审批卡」，**不是重派**。
                 */
                awaiting: Array.isArray(live.awaiting) ? live.awaiting : [],
                awaiting_count: Array.isArray(live.awaiting) ? live.awaiting.length : 0,
                /** 这次查状态时**机制是否已经自动处置**（推到「已阻塞」）。 */
                escalated: handled !== null && handled.escalated === true,
                /** ★ 主对话下一步可以**直接调**的动作（重派 / 换班 / 人工 / 取消）。 */
                next_actions: nextActionsFor(live.silent, { taskId }),
              },
        // ★★ P2-13：存储体积诊断（只读；每次查状态都给）
        storage,
        /** ★ P2-13 第二步：history 归档账本（只读；没触发过归档时为 null）。 */
        history_archive: archiveInfo,
        /**
         * ★★ P2-13：**分页段 + 分页信封** —— 只在给了 `page` 时非 null。
         *   不传 page ⇒ 全部 null（与改前形状一致；正文也与改前逐字节一致）。
         *   越界 ⇒ 该段空数组 + `_pagination.<section>.out_of_range/note`，不报错。
         */
        handoffs: paged === null ? null : paged.handoffs.slice,
        human_requests: paged === null ? null : paged.human_requests.slice,
        history: paged === null ? null : paged.history.slice,
        dispatch_slots: paged === null ? null : paged.dispatch_slots.slice,
        audit: paged === null || pagedAudit === null ? null : pagedAudit.slice,
        _pagination: pagination,
        /** ★ 分页时**仍然给 total_***（调用方不用自己数；也回答"这段之外还有多少"）。 */
        total_handoffs: paged === null ? null : paged.handoffs.total_items,
        total_human_requests: paged === null ? null : paged.human_requests.total_items,
        total_history: paged === null ? null : paged.history.total_items,
        total_dispatch_slots: paged === null ? null : paged.dispatch_slots.total_items,
        total_audit: paged === null ? null : auditLog === null ? storage.audit_lines : pagedAudit.total_items,
        /**
         * ★★ **"没人领的事件"清单**（2026-10-16 补 · 唤醒投递失败的兜底出口）。
         *
         * 这是"找不到主对话会话"时那条**确定的捞法**：唤醒投不出去的事件进账本的
         * unresolved 列表（`wakeup/waker.js` 的 `noteUnclaimed()`，**幂等**），
         * 而每一次 `pipeline_status` 都会把它带回给主对话。
         *
         * ★ 三种 `reason` 原样透出，因为出路不一样：
         *   `no-main-session` ⇒ 认回主对话身份；`no-stable-identity` ⇒ 等台账落地后巡检再叫；
         *   `deliver-failed` ⇒ 目标会话不可达，下次同类事件会重投。
         * ★ 判据在 `lib/wakeup/pending.js`（只读）；账本没装配 ⇒ 空数组。
         */
        pending_wakes: unclaimedWakes,
      }
    },
  })

  /**
   * ★★ **B8：给"已经派出去的席位"传话的通道**（催办 / 叫醒 / 停手）。
   *
   * 现场（2026-10-12）：主对话**停不掉空转席位**，也没有"给既有席位发一条消息"的通道 ——
   * 当晚只能由用户用 GUI 手动打字把席位叫醒。
   *
   * 为什么做成 `pipeline_dispatch` 的一条模式（`notify_only: true`）而不是新开一个工具：
   *   · "按 role + seat 找到那个会话并给它投一句话"与"派活"是**同一套身份解析**
   *     （都从派活台账里找席位），复制一份必然漂移；
   *   · 本插件的工具面**有数量闸门**（`tests/load-smoke.mjs` 逐字钉住注册数），
   *     新开一个工具会迫使改那些断言 —— 不值得。
   *
   * 纪律三条（与 B3 一致）：① 会话 id **只**从派活台账取，结构上投不错人；
   *   ② 投不出去返回 `ok:false` + 原因 + 等价路径（**不静默失败**）；③ 不新开状态、不建会话。
   */
  const PIPELINE_HELP_TOPICS = Object.freeze({
    tools: [
      '主对话：pipeline_task_open / pipeline_orchestrate / pipeline_plan / pipeline_dispatch / pipeline_transition /',
      '        pipeline_human_relay / pipeline_human_reply / pipeline_status / pipeline_wait / pipeline_contacts',
      // ★ P2 文案小修：`pipeline_demo` 原先在速查里**完全没提**，confirm 的必填参数只能靠猜。
      '主对话 · DEMO 阶段：pipeline_demo（action: plan / round / confirm / status）；',
      '        交付席位交内容：pipeline_demo_submit（writer / architect / diagrammer）；',
      '        `confirm` **必填** `round_index` + `human_request_id`（请求必须已 answered），再 pipeline_transition event=demo_passed。',
      '执行角色：pipeline_bind_role / pipeline_handoff / pipeline_artifact / pipeline_record_submit /',
      '        pipeline_clarify_request / pipeline_clarify_reply / pipeline_human_request / pipeline_roster_request /',
      '        pipeline_context_report / pipeline_succession / pipeline_compile_requirement',
      '★ 给**既有席位**传话（催办 / 叫醒 / 停手）没有单独的工具：用 pipeline_dispatch { notify_only: true }。',
      '★ 等状态别 sleep 轮询：pipeline_wait { task_id, until_state?, until_event?, timeout_ms? } —',
      '        只读长轮询，到状态/历史动作立刻返回；超时给当前状态 + 最近动作 + 建议（不改任务、不写盘）。',
      '★ 拿不准就 pipeline_status：它给的是脱敏摘要 + **下一步合法事件**，比翻文档准。',
    ].join('\n'),
    flow: [
      '需求分析（orchestrator）→ 用户确认 → 计划（planner：plan + 自检 + 分配）→ 编写席位（可多席位，按层）',
      '→ 测试（tester）→ 审核（reviewer）→ 主对话关单。',
      '★ 每一步的**下一步合法事件**由状态机说了算（见 pipeline_status 的返回）。',
    ].join('\n'),
    slots: [
      `四槽 = ${DISPATCH_SLOT_KEYS.join(' / ')}（四个**平级**字段，不许打包）。`,
      '声明位置：pipeline_plan 的 slots 参数 `{ "<角色>": {...}, "<角色>@<席位>": {...} }`；',
      '不声明 = 名单给每个要派活的席位落**显式默认**（权限档 = 最小档 read-only，origin=default）。',
      '派活时四槽跟着席位走（pipeline_dispatch 的 permission / mode / model / reasoning）。',
      '★★ `roster.slots` 是**声明表**，不是"席位实际拿到了什么"：',
      '  · `origin=declared`（计划显式声明）⇒ **冻结**，派活时改档会被拒（不许在派活那一刻悄悄换一档）；',
      '  · `origin=default`（占位默认值，比如那个 read-only）⇒ 派活可以覆盖它，',
      '    覆盖结果记在 **`task.dispatch_slots[]`**（`effective` = 实际生效值，`divergences` = 被覆盖的占位槽）。',
      '  ⇒ 要判断"某个席位到底有什么权限"，看 `dispatch_slots` 的 `effective`，**不要**只看 `roster.slots`。',
    ].join('\n'),
    roles: Object.values(ROLES).map((r) => `${r.id}\t${r.zh}\twrites=${r.writes}`).join('\n'),
    states: `状态机的合法事件一律用 pipeline_status 查（它读的就是 states.js 的同一份表）；当前状态的"下一步"写在返回里。`,
    liveness: [
      `失联判据四条同时成立：① 超过静默阈值（config.seatSilenceMs，默认 5 分钟）；② **轮到场了**（该它动）；`,
      `③ 台账里没有任何活着的证据（0 交接物 / 0 流水 / 0 水位自报 / 0 继任）；④ **会话日志也没在长**（${'session.v4.jsonl.zstd'} 的 size/mtime）。`,
      '★★ **在等审批 ≠ 失联**：`ask` 审批策略下席位弹审批卡等人点时，它的会话里会有一条没有配对',
      '   `approval/decided` 的 `approval/asked`（宿主自己写的会话事件）⇒ liveness 报 `awaiting` 而不是 `silent`：',
      '   **去那个会话点审批卡**，不要重派（重派会多起一个会话白烧一轮）。长单一开始就该用 `never`。',
      '恢复：pipeline_dispatch { reassign: true }（一键：先恢复阻塞前的状态再重派，不消耗打回预算）；',
      '叫醒既有席位：pipeline_dispatch { notify_only: true }（**不建会话、不改状态**）；放弃：pipeline_transition { event: "cancel" }。',
    ].join('\n'),
    wake: [
      '席位交付 / 状态推进 / 席位失联 ⇒ 机制往**主对话所在会话**注入一条 runtime-context 消息（不是用户消息）。',
      '幂等键 = 任务 + 事件类别 + 执行者 + **稳定交付身份**（交接物 id / 请求 id / 制品版本 / 最新一条历史）；',
      '取不到稳定身份就**不播报**（留痕 wake:skipped，reason=no-stable-identity）—— 不许退回递增计数器（那会导致重复重放）。',
      '正文里的状态是**快照**：动手前请用 pipeline_status 重读。',
    ].join('\n'),
  })

  return { status }
}
