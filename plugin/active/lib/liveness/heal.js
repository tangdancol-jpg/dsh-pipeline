/**
 * dsh-pipeline · **席位失联检测** · 误判自愈与通道侧审计
 * ============================================================================
 * 从 `lib/liveness.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/liveness.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/liveness/heal
 */

import { appendFileSync } from 'node:fs'
import { roleLabel } from '../roles.js'
import { STATE_LABEL } from '../states.js'
import { seatKey } from './seats.js'

// ===========================================================================
// ★★ 误判**自愈** —— "座位其实活着"时，把那次误判造成的阻塞**收回**
// ===========================================================================
//
// ---------------------------------------------------------------------------
// 现场（2026-10-14 今晚，同一类第 5 次；后果最重的一次）
// ---------------------------------------------------------------------------
// 形状：席位**在干活、但不产那三类证据**（交接物 / 流水 / 水位自报）⇒ 5 分钟静默
// 阈值把它判「失联」⇒ 机制自动把任务推到「已阻塞」⇒ 而**阻塞态下 `dev_submitted`
// 这类唯一出口根本不合法** ⇒ **已经干完的活交不上去**。
//
// 实证（逐字来自线上台账，不是我转述）：
//   · `.pipeline/T-20261011-5a871c/audit.jsonl` 2026-10-14T11:02:20Z 的
//     `transition:unblock` 备注：「检查发现又被失联误报推成「已阻塞」，导致
//     "编写交测试（dev_submitted）"这一唯一出口在当前状态不合法 ⇒ 那件已干完的活
//     交不上去。」
//   · 同刻实测该席位会话日志仍在长：`writer#1` 样本
//     `size=351292`、`session.v4.jsonl.zstd` 6 秒内 **+12611 字节**
//     （复算命令见本轮 `_probe/p4-live.mjs`，判据与线上同一条）。
//
// ---------------------------------------------------------------------------
// 机制缺的那一环：**冻结是一次性的，收回却只能靠人**
// ---------------------------------------------------------------------------
// {@link activityOfSamples} 明明能在**下一次观察**就看见"它的会话日志还在长"，
// 但那个结论只被用来**阻止新的冻结**（`silentHere = … && !alive`），
// **没有人**拿它去检查**已经发生过的**冻结是不是错的。于是每误判一次，就要人
// （或主对话）手工 `pipeline_transition { event: "unblock" }` 一次 —— 机制自己
// 一句话都不说，状态页上写的就是「已阻塞」。
//
// ---------------------------------------------------------------------------
// 判据（**纯函数**；采样仍由 store 层做，判据只吃数字）
// ---------------------------------------------------------------------------
// 把 `task.liveness.escalations[]` 里**最后一条**拿出来（那一份台账**只由**
// `store.checkLiveness` 的自动阻塞分支写入 ⇒ 它天然就是"机制自己推的那次阻塞"，
// 人工/用户指示的阻塞不会进这个数组），逐席问一句：
//
//   「它现在有没有**阳性**的存活证据？」
//     阳性 = `activity.grew === true`
//       —— 会话日志在长，或 `mtime` 显示它此刻正在被写（见 {@link activityOfSamples}）。
//
// 只有**该次处置点名的每一个席位都阳性**，才允许收回。
//
// ★★ 反例红线（**一个字都不许放宽** —— 用户点名不许）：
//   · **真死掉的席位**：会话日志不再增长、`mtime` 也旧 ⇒ `grew === false`
//     ⇒ 拿不到任何阳性证据 ⇒ 本函数**一个字节都不动**（不改状态、连"疑似误判"
//     都不写），任务照旧停在「已阻塞」，等人处理。真失联的判定**没有被动过**。
//   · `known:false`（这一次拿不到日志）**不算阳性** —— "看不见"永远不写成"它还活着"。
//   · 点名席位里**只要有一个**仍拿不到阳性证据 ⇒ **只留痕、不自动收回**
//     （那一个可能是真的死了，状态决定权留给主对话）。
//   · 只有在**恢复点仍在**（`task.previous_state` 与那次处置记的 `previous_state`
//     逐字相等）时才自动收回；期间有人动过状态 ⇒ 只留痕。
//
// ★ 判据**只有一个源**：本条与"不许只凭一次安静就冻结"读的是同一个
//   {@link activityOfSamples} 结论，不另起一套"心跳"口径 —— 两套口径并存迟早互相矛盾。

/**
 * ★ **误判自愈判据**（纯函数：不读盘、不写盘、不抛）。
 *
 * @param {object|null} task
 * @param {object|null} live - {@link seatLiveness} 的结果（要它的 `seats[].activity`）
 * @param {{atMs?:number}} [opts]
 * @returns {{applicable:boolean, suspects:Array<object>, basis:string, can_unblock:boolean,
 *   will_return_to:string|null, escalation_at:string|null, already:boolean, reason:string}}
 *   `applicable:false` = 本次**没有**"疑似误判"要写（不是"查不到"）；
 *   `suspects` 非空 = 有席位拿到了**阳性**存活证据，`basis` 是人话依据（写进 audit）。
 */
export function livenessSelfHeal(task, live, opts = {}) {
  const state = String(task?.state ?? '')
  const stateZh = STATE_LABEL[state] ?? state
  /** 统一出口：把"不适用"也写成一句**能回答为什么**的话，不返回光秃秃的 false。 */
  const no = (reason, extra = {}) => ({
    applicable: false,
    suspects: [],
    basis: '',
    can_unblock: false,
    will_return_to: null,
    escalation_at: null,
    already: false,
    reason,
    ...extra,
  })

  const escs = Array.isArray(task?.liveness?.escalations) ? task.liveness.escalations : []
  if (escs.length === 0) return no('本任务没有「机制触发的席位失联」处置记录 —— 没有要收回的误判阻塞')
  const esc = escs[escs.length - 1]
  const escAt = typeof esc?.at === 'string' ? esc.at : null

  if (state !== 'blocked') {
    return no(`任务不在「已阻塞」（当前「${stateZh}」）—— 没有需要收回的阻塞`, { escalation_at: escAt })
  }
  if (String(esc?.to_state ?? '') !== 'blocked') {
    return no(`最后一条失联处置没有把任务推成「已阻塞」（to_state=${String(esc?.to_state ?? '?')}）—— 不是它的账`, { escalation_at: escAt })
  }
  if (esc?.self_heal !== undefined && esc.self_heal !== null) {
    return no('这次阻塞已经做过一次误判自愈标注 —— 不重复处置', { already: true, escalation_at: escAt })
  }
  const seats = (Array.isArray(esc?.seats) ? esc.seats : []).map((x) => String(x)).filter((x) => x.length > 0)
  if (seats.length === 0) return no('那一次失联处置没有记下席位 —— 不知道要收回谁', { escalation_at: escAt })

  const byKey = new Map()
  for (const s of Array.isArray(live?.seats) ? live.seats : []) {
    if (s === null || typeof s !== 'object') continue
    byKey.set(String(s.key ?? seatKey(s.role, s.seat)), s)
  }

  const suspects = []
  const stillQuiet = []
  for (const k of seats) {
    const s = byKey.get(k)
    const a = s?.activity ?? null
    // ★ 只认**阳性**：`grew === true`。`known:false`（拿不到日志）与"测到没长"都不算。
    if (a !== null && a.grew === true) {
      const role = String(s?.role ?? '')
      suspects.push({
        seat: k,
        role,
        role_zh: String(s?.role_zh ?? roleLabel(role)),
        session_id: typeof s?.session_id === 'string' && s.session_id.length > 0 ? s.session_id : null,
        delta_bytes: Number.isFinite(a.delta_bytes) ? a.delta_bytes : null,
        delta_ms: Number.isFinite(a.delta_ms) ? a.delta_ms : null,
        sample_at: Number.isFinite(a.sample_at) ? a.sample_at : null,
        basis: String(a.reason ?? ''),
      })
    } else {
      stillQuiet.push(k)
    }
  }

  const label = (s) => `${s.role_zh}${s.seat === s.role ? '' : `（${s.seat}）`}`
  if (suspects.length === 0) {
    return no('本次观察里，那次处置点名的席位**没有一个**拿到阳性存活证据（会话日志没长 / 拿不到日志）—— 按真失联处理，不动状态', { escalation_at: escAt })
  }
  const basis = suspects.map((s) => `${label(s)}：${s.basis}`).join('；')

  if (stillQuiet.length > 0) {
    return {
      applicable: true,
      suspects,
      basis,
      can_unblock: false,
      will_return_to: null,
      escalation_at: escAt,
      already: false,
      reason: `点名席位里仍有 ${stillQuiet.join('、')} 拿不到阳性存活证据 ⇒ **只留痕、不自动收回**（那一个可能是真的死了，状态决定权留给主对话）`,
    }
  }

  const prev = typeof task?.previous_state === 'string' && task.previous_state.length > 0 ? task.previous_state : null
  const escPrev = typeof esc?.previous_state === 'string' && esc.previous_state.length > 0 ? esc.previous_state : null
  const base = { applicable: true, suspects, basis, escalation_at: escAt, already: false }
  if (prev === null) return { ...base, can_unblock: false, will_return_to: null, reason: '账本里的恢复点缺失 ⇒ 不知道收回后回到哪个状态，**只留痕、不自动收回**' }
  if (prev !== escPrev) {
    return { ...base, can_unblock: false, will_return_to: null, reason: `恢复点与那次处置记的不一致（账本 ${prev} / 处置 ${escPrev ?? '无'}）⇒ 期间有人动过状态，**只留痕、不自动收回**` }
  }
  if (prev === 'blocked') return { ...base, can_unblock: false, will_return_to: null, reason: '恢复点指向「已阻塞」自身 ⇒ 收回会退化成空操作，**只留痕、不自动收回**' }
  return {
    ...base,
    can_unblock: true,
    will_return_to: prev,
    reason: `该次处置点名的席位**全部**拿到阳性存活证据，恢复点仍在（${prev}）⇒ 自动收回这次误判造成的阻塞`,
  }
}

// ===========================================================================
// 通道侧审计 —— 派活通道的**判决**必须留痕
// ===========================================================================
//
// 为什么单开这一段：通道侧有三类判决的处置都是「先上报、等用户定」——
//   · 通道不可达（缺服务）：不降级、不派活；
//   · 「完全」档被拒：默认禁用，缺一段即拒；
//   · 项目分组建不起来 / 会话建不出来 / 读回证明不了它不是子代理会话：一律按失败处理。
// 如果这些只活在**一次工具调用的返回值**里，任务停下来之后就没人能回答
// 「它为什么没派出去」。所以落进既有的只追加流水 `.pipeline/<任务>/audit.jsonl`
// （与 store 的审计同一份文件、同一种行格式），不新开机制、不新开文件。

/** 派活通道 kind 里「真实会话」这一档的名字（与 lib/transport 的 SESSION_KIND 同值）。 */
export const VIA_SESSION = 'session'

/**
 * 造一个通道侧审计出口。
 *
 * @param {{auditFile?:(taskId:string)=>string, log?:(msg:string)=>void}} [deps]
 * @returns {{record:(entry:{taskId:string, action:string, detail?:object})=>void, entries:()=>object[]}}
 */
export function createChannelAudit(deps = {}) {
  const fileOf = typeof deps.auditFile === 'function' ? deps.auditFile : null
  const log = typeof deps.log === 'function' ? deps.log : null
  /** 内存镜像：诊断与自测可读；落盘失败也不至于把判决吞掉。有界，不无限增长。 */
  const ring = []

  function record(entry) {
    const taskId = String(entry?.taskId ?? '')
    const action = String(entry?.action ?? 'unknown')
    const detail = entry?.detail !== null && entry.detail !== undefined && typeof entry.detail === 'object' ? entry.detail : {}
    ring.push({ taskId, action, detail })
    while (ring.length > 200) ring.shift()
    if (log !== null) log(`通道审计：${action}（任务 ${taskId.length === 0 ? '(未知)' : taskId}）`)
    if (fileOf === null || taskId.length === 0) return
    const line = { at: new Date().toISOString(), task_id: taskId, actor: 'channel', action, ...detail }
    try {
      appendFileSync(fileOf(taskId), `${JSON.stringify(line)}\n`, 'utf8')
    } catch (err) {
      // 审计写失败不该让判决本身失败；内存镜像里还有一份，且**说出来**，不静默。
      if (log !== null) log(`通道审计写盘失败（判决仍留在返回值与内存镜像里）：${String(err?.message ?? err)}`)
    }
  }

  return { record, entries: () => [...ring] }
}
