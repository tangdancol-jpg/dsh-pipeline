/**
 * dsh-pipeline · **席位失联检测** · 席位判据（派活台账 ⇒ 该不该判失联）
 * ============================================================================
 * 从 `lib/liveness.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/liveness.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/liveness/seats
 */

import { roleLabel } from '../roles.js'
import { STATE_LABEL } from '../states.js'
import {
  DEFAULT_SEAT_SILENCE_MS,
  DEFAULT_SILENCE_CONFIRMATIONS,
  activityOfSamples,
  formatDuration,
} from './activity.js'
import { describeApprovalWait } from './approval.js'
import { describeSilentSeats } from './describe.js'

/**
 * ★ **哪些状态下"该轮到谁动"**。
 *
 * 只列**有唯一明确责任人**的状态。没列到的状态（待分配 / 待计划 / 已通过 /
 * 各等待态 / 已阻塞 / 已取消 / 已关闭）一律**不报失联** —— 那些状态下
 * "没人说话"是正常的（活儿还没派、或者正在等别人）。
 *
 * ★ 防误报：`developing` 只列 `writer`。审核即便刚被双轨派活、一直没吭声，
 *   也不会在这里被判失联 —— 它的轮次还没到。
 */
export const EXPECTED_ROLES_BY_STATE = {
  analyzing: ['orchestrator'],
  planning: ['planner'],
  developing: ['writer'],
  testing: ['tester'],
  reviewing: ['reviewer'],
  returned_to_dev: ['writer'],
  returned_to_test: ['tester'],
  ready_plan: ['planner'],
  ready_dev: ['writer'],
  ready_test: ['tester'],
  ready_review: ['reviewer'],
}

/**
 * 席位键。
 *
 * ★ 口径**必须**与项目既有的一致（`lib/store/records.js` 里的 `const seatKey = seat || role`）：
 *   编写席位的 id **本身就是全限定**的（`writer#1`），非编写角色的 `seat` 是 `null`。
 *   所以这里**不是** `${role}#${seat}` —— 那会造出 `writer#writer#1` 这种键，
 *   与 `writer_submissions` / `seat_handover.payload.from_seat` 全部对不上。
 *
 * @param {string} role
 * @param {string|null} [seat]
 * @returns {string}
 */
export function seatKey(role, seat = null) {
  const s = typeof seat === 'string' && seat.length > 0 ? seat : ''
  return s.length > 0 ? s : String(role ?? '')
}

/** 把 ISO 字符串或数字收敛成毫秒数；取不到时 null（**不猜**）。 */
export function msOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * 写一条派活记录（**纯函数**：返回新数组，不改入参）。
 *
 * 同一个 (role, seat) 重复派活时**覆盖**旧记录（最新一次派活才是有意义的计时起点 ——
 * 重派之后不该还按上一次的时间算超时）。
 *
 * @param {Array<object>|null|undefined} list - `task.dispatched`
 * @param {object} entry
 * @param {string} entry.role
 * @param {string|null} [entry.seat]
 * @param {string|null} [entry.agentId]
 * @param {string|null} [entry.token]
 * @param {string} [entry.at] - ISO 时间戳
 * @param {number} [entry.atMs]
 * @param {string} [entry.via] - 通道（subagent / manual）
 * @returns {Array<object>}
 */
export function upsertDispatch(list, entry) {
  const arr = Array.isArray(list) ? list : []
  const role = String(entry?.role ?? '')
  const seat = typeof entry?.seat === 'string' && entry.seat.length > 0 ? entry.seat : null
  const key = seatKey(role, seat)
  const rec = {
    key,
    role,
    seat,
    agent_id: typeof entry?.agentId === 'string' && entry.agentId.length > 0 ? entry.agentId : null,
    /**
     * ★ **会话 id**（真实会话通道下 = 侧栏里那个一等公民会话）。
     * 与 `agent_id` 分开记：一个是"进程内身份"，一个是"用户能点开的会话"——
     * 失联提示要指到后者，用户才知道该去看哪一条。
     */
    session_id: typeof entry?.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : null,
    token: typeof entry?.token === 'string' && entry.token.length > 0 ? entry.token : null,
    at: typeof entry?.at === 'string' ? entry.at : null,
    at_ms: typeof entry?.atMs === 'number' ? entry.atMs : msOf(entry?.at),
    via: typeof entry?.via === 'string' ? entry.via : '',
  }
  const out = []
  let replaced = false
  for (const raw of arr) {
    const rRole = String(raw?.role ?? '')
    const rSeat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    if (seatKey(rRole, rSeat) === key) {
      out.push(rec)
      replaced = true
    } else {
      out.push(raw)
    }
  }
  if (!replaced) out.push(rec)
  return out
}

/**
 * 该席位自派活之后**有没有活着的证据**。
 *
 * 顺序按"最硬的证据在前"：交接物 > 席位提交表 > 自报水位 > 历史流水 > 继任。
 *
 * @param {object} task
 * @param {{role:string, seat:string|null, atMs:number|null}} entry
 * @returns {string|null} 证据描述；null = 查不到任何证据
 */
export function evidenceOfLife(task, entry) {
  const role = String(entry?.role ?? '')
  const seat = entry?.seat ?? null
  const at = entry?.atMs
  const since = (iso) => {
    if (at === null || at === undefined) return true // 没有起点就没法比 —— 一律算"比它新"
    const t = msOf(iso)
    return t === null ? true : t >= at
  }

  // ① 交接物：最硬的证据（席位真的产出东西了）
  const handoffs = Array.isArray(task?.handoffs) ? task.handoffs : []
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i]
    if (String(h?.from_role ?? '') === role && since(h?.created_at)) {
      return `交接物 ${String(h?.kind ?? '?')}（${String(h?.created_at ?? '')}）`
    }
  }

  // ② 编写席位提交表（按 seat 精确匹配 —— 多席位时不会互相顶替）
  if (seat !== null) {
    const subs = task?.writer_submissions
    if (subs !== null && typeof subs === 'object') {
      const mine = subs[seat]
      if (mine !== undefined && mine !== null && since(mine.at)) return `席位提交（${String(mine.at ?? '')}）`
    }
  }

  // ③ 自报上下文水位（席位主动说话的一种）
  const reports = Array.isArray(task?.context_reports) ? task.context_reports : []
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i]
    if (String(r?.role ?? '') === role && since(r?.at)) return `水位自报（${String(r?.at ?? '')}）`
  }

  // ④ 历史流水：该角色**自己**触发过的动作（actor 是角色名）
  const history = Array.isArray(task?.history) ? task.history : []
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (String(h?.actor ?? '') === role && since(h?.at)) return `流水 ${String(h?.action ?? '')}（${String(h?.at ?? '')}）`
  }

  // ⑤ 继任：老席位被换班之后不该再催（换班本身就是处置）
  const successions = Array.isArray(task?.successions) ? task.successions : []
  for (let i = successions.length - 1; i >= 0; i--) {
    const s = successions[i]
    if (String(s?.role ?? '') === role && since(s?.at)) return `已继任（${String(s?.at ?? '')}）`
  }

  return null
}

/**
 * ★ 算一次失联检测（**纯函数**：不读盘、不写盘、不抛异常）。
 *
 * @param {object|null} task
 * @param {number} [now] - 当前毫秒时间（自测要固定它）
 * @param {object} [opts]
 * @param {number} [opts.silenceMs] - 静默阈值
 * @param {object|null} [opts.activity] - ★ B2：本次**现采**的会话日志样本
 *   `{ [seatKey]: {atMs,size,mtimeMs}|null }`（拿不到就整份给 null —— 不是给空对象）
 * @param {number} [opts.confirmations] - 拿不到活动证据时，连续几次安静才冻结
 * @param {object|null} [opts.approvals] - ★★ **P1-4：「在等审批」探测结果**
 *   `{ [seatKey]: {known:boolean, pending:Array<{id,tool_name,…}>, policy?:string|null, note?:string} }`。
 *   由 store 层用宿主面采样（`lib/liveness/approval.js` 的 `createSeatApprovalProbe`）——
 *   判据本身仍是纯函数。`known:true` 且 `pending` 非空 ⇒ 这个席位**在等人点审批**，
 *   **不是失联**（它的静默是人在拖，不是它死了）。
 * @returns {{silenceMs:number, state:string, state_zh:string, expected:string[], seats:Array<object>, silent:Array<object>, pending:Array<object>, awaiting:Array<object>, ok:boolean, summary:string}}
 */
export function seatLiveness(task, now = Date.now(), opts = {}) {
  const silenceMs =
    Number.isInteger(opts.silenceMs) && opts.silenceMs > 0 ? opts.silenceMs : DEFAULT_SEAT_SILENCE_MS
  const confirmations =
    Number.isInteger(opts.confirmations) && opts.confirmations >= 1 ? opts.confirmations : DEFAULT_SILENCE_CONFIRMATIONS
  /**
   * ★ **确认门是否适用**（B2 的"不许只凭一次安静就冻结"要有适用范围，别变成"关掉检测"）。
   *
   * 规则（写死在这里，别再各处理解一遍）：
   *   · `opts.gateApplicable === true` —— **本任务的活动采样是"本来做得到"的**
   *     （至少一个已派席位带 `session-…` 形状的会话 id，或至少采到一条日志）；
   *     这时"拿不到证据"是**偶发缺失** ⇒ 必须连续 `confirmations` 次都没有活动证据才冻结。
   *   · `false` / 未给 —— 本任务**结构上采不到**活动（台账里根本没有会话 id、
   *     或会话目录不可达）⇒ 退回原来的台账三条判据，一次安静即可冻结，
   *     并在处置留痕里写明 `activity_known:false`（**不许假装看过日志**）。
   */
  const gateOn = confirmations >= 2 && opts.gateApplicable === true
  /** 现采样本；`null`/`undefined` = 本次**根本拿不到**活动证据（≠"它没动"）。 */
  const activity = opts.activity !== null && typeof opts.activity === 'object' ? opts.activity : null
  /**
   * ★★ **P1-4：本次现采的「在等审批」映射**（`null` = 本次没探 / 探不到）。
   *
   * 语义与 `activity` 同一套：`known:false` 是"读不到"，**不是**"没有审批"。
   * 采样由 store / tools 层做（宿主面在 `lib/liveness/approval.js`），判据只吃结论。
   */
  const approvals = opts.approvals !== null && typeof opts.approvals === 'object' ? opts.approvals : null
  const prevSamples =
    task?.liveness?.samples !== null && typeof task?.liveness?.samples === 'object' ? task.liveness.samples : {}
  const quietMap =
    task?.liveness?.quiet !== null && typeof task?.liveness?.quiet === 'object' ? task.liveness.quiet : {}
  const state = String(task?.state ?? '')
  /** ★ A4：本次有没有拿到活动证据（`false` ⇒ 摘要素写成"拿不到会话日志"，不许写"它没在长"）。 */
  const activityKnownHere = activity !== null
  const expected = Array.isArray(EXPECTED_ROLES_BY_STATE[state]) ? EXPECTED_ROLES_BY_STATE[state] : []
  const list = Array.isArray(task?.dispatched) ? task.dispatched : []

  const seats = []
  const silent = []
  const pending = []
  /** ★ P1-4：在等审批的席位（与 `silent` 互斥 —— 它们**不是**失联）。 */
  const awaiting = []
  for (const raw of list) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const key = seatKey(role, seat)
    const atMs = typeof raw?.at_ms === 'number' ? raw.at_ms : msOf(raw?.at)
    const isExpected = expected.includes(role)
    const evidence = evidenceOfLife(task, { role, seat, atMs })
    /**
     * ★★ **P1-4：「在等审批」不是失联。**
     *
     * 现场（`内部复盘（2026-10-18，不公开）` P1-4）：`ask` 审批策略下
     * 席位弹审批卡等人点，静默 6 分 34 秒后被判"失联"（判词还写"不是它还在想，
     * 它可能已经死了"）⇒ 主对话据此重派 ⇒ **白烧 30 分钟**。
     *
     * 判据（只加一条**阳性**证据，不动任何阈值）：
     *   `approvals[key].known === true` 且 `pending` 非空
     *   ⇒ 这个席位**此刻挂着 N 个人工审批**（宿主 `approval/asked` 没有配对的
     *     `approval/decided`）⇒ 它的静默**是人在拖，不是它死了**：
     *     · 不判失联（`silentHere` 里排除）；
     *     · 不算"没有实证的安静"（`quiet_streak` 归零，与 `fresh_write` 同一条纪律）；
     *     · 单独进 `awaiting` 清单，判词由 `describeApprovalWait` 写。
     *
     * ★ 铁律：**只认宿主读到的 pending 条目**。`known:false`（读不到）与
     *   `pending:[]`（读到了、没在等）**都不改变**原有判据 —— 真死席位照旧判死，
     *   静默阈值一毫秒没动。
     */
    const approvalRec = approvals !== null && approvals !== undefined ? approvals[key] ?? null : null
    const approvalKnown = approvalRec !== null && typeof approvalRec === 'object' && approvalRec.known === true
    const pendingApprovals = approvalKnown && Array.isArray(approvalRec.pending) ? approvalRec.pending : []
    const awaitingHere = pendingApprovals.length > 0
    // ★ B2：第四条判据 —— 会话日志还在长吗？（优先级最高，因为它是最硬的"它还在动"）
    const act = activityOfSamples(
      prevSamples[key] ?? null,
      activity === null ? null : activity[key] ?? null,
      opts.activityOpts ?? {},
    )
    const alive = act.grew === true
    // ★ 活动采样命中 ⇒ 把静默计时**从这次活动重新起算**（"它一直在动"不该被算成静默）。
    const clock = alive && Number.isFinite(activity?.[key]?.atMs) ? activity[key].atMs : atMs
    const elapsedMs = clock === null ? null : Math.max(0, now - clock)
    const quiet = Number.isInteger(quietMap[key]) && quietMap[key] >= 0 ? quietMap[key] : 0
    const timedOut = elapsedMs !== null && elapsedMs >= silenceMs
    /**
     * ★★ **P1-6 修复（2026-10-14）：「正在写交付」的席位不许被判失联并冻结。**
     *
     * 现象（本机实测，见 `_cprobe/p16-probe.mjs`）：席位派活很久、台账里还没有任何
     * 交接物（**它正要交的那一份还没落盘**），而它的会话日志 `mtime` **就在几秒前**
     * —— 也就是"写完报告、正要交交接物的那几十秒"。改前这一格照样被冻结：
     *   · 两次采样**落在同一个活动窗口内**（间隔 ≤ 2 分）；
     *   · 这段里的字节增量 **< `minBytes`（1024 B）** ⇒ `grew:false`；
     *   · 而 `activityOfSamples` 的"同窗小增量"那一格**把 mtime 证据丢掉了**，
     *     并且回的是 `conclusive:true` ⇒ **绕过确认门 ⇒ 一次观察即冻结**。
     * 后果是真实损失：任务在席位**发出交付调用之前**被推成「已阻塞」，
     * 那份 `test_to_review`（`T-20261012-6884af`）因此**从未落盘**。
     *
     * 判据（**只加一条阳性证据，不动任何阈值**）：
     *   `fresh === true`（`mtime` 距今 ≤ {@link DEFAULT_ACTIVITY_FRESH_MS}，60 秒）
     *   ⇒ 这个文件**此刻正在被写** ⇒ 这一次观察**不算实证的安静**：
     *   既不冻结，也**不累计**"连续没证据"的计数（计数归零 —— 席位刚回来动了一下，
     *   不该把它之前那段安静接着数下去，否则"它刚复活"会被读成"安静两轮了"）。
     *
     * ★★ 铁律（一个字都没动）：
     *   · **静默阈值仍是 {@link DEFAULT_SEAT_SILENCE_MS}（5 分）**，`silenceMs` 一毫秒没改；
     *   · **既有反例照旧判死**：真死席位的日志不再被写 ⇒ `mtime` 很快越过 60 秒
     *     ⇒ `fresh:false` ⇒ 走原来那条路（该一次判死的一次判死，该走确认门的走确认门）。
     *     60 秒这条线**本来就写着**"必须远小于静默阈值，否则等于把检测关掉"
     *     （见 {@link DEFAULT_ACTIVITY_FRESH_MS} 的取值理由）—— 本修复把这个界守住了，
     *     没有把它放宽成"多久都算活"。
     *   · 只认 `fresh`，**不认**"增量为正"之类更松的口径 —— `grew` 的语义一个字没改。
     */
    const freshWrite = act.fresh === true
    let silentHere = timedOut && isExpected && evidence === null && !alive && !freshWrite && !awaitingHere
    let pendingHere = null
    /**
     * ★★ **2026-10-13 快修（②，P0-2/P0-3）**：
     *
     *   · 门条件从 `act.known !== true` 改成 `act.conclusive !== true`。
     *     旧写法把三种**其实没有实证**的形状（首次采样、两次采样跨窗、时钟回退）
     *     当成"测到了、没长" ⇒ **绕过确认门、一次观察即冻结**。正是"正在写文件造成的
     *     静默"被判死的那条路径。现在这三种形状一律走确认门。
     *   · ⚠️ **反例一个字没动**：「同一窗口内测到没长」与「跨窗且文件完全没动过」
     *     仍然是 `conclusive:true` ⇒ 真死席位照旧一次判死（`t14-fix-check` 的反例②）。
     *     ★ P1-6 修复后这一条要连着 `fresh` 一起读：`conclusive:true` 仍然成立，
     *     但那两格里真死席位的 `fresh` 都是 `false`（mtime 早已陈旧）⇒ 行为不变。
     *   · `quiet + 1` 这个计数**在 pending 时也必须落盘**（下面 `quiet_streak`），
     *     否则计数器永远回不到 `confirmations` ⇒ 门一旦开着就**永不冻结**
     *     （等于把检测静默关掉 —— 那正是 6884af 诊断报告 §3.2⑦ 点名的独立缺陷）。
     */
    if (silentHere && gateOn && act.conclusive !== true && quiet + 1 < confirmations) {
      // ★ 用户原话：「拿不到活动证据时**不许只凭一次安静**就冻结」。
      silentHere = false
      pendingHere = `第 ${quiet + 1}/${confirmations} 次观察：没有可用来判死的活动证据（${act.reason}）—— 再观察一次，本轮不冻结`
    }
    const rec = {
      key,
      role,
      role_zh: roleLabel(role),
      seat,
      agent_id: raw?.agent_id ?? null,
      session_id: raw?.session_id ?? null,
      at: raw?.at ?? null,
      at_ms: atMs,
      elapsed_ms: elapsedMs,
      elapsed_zh: elapsedMs === null ? '（没有派活时间戳）' : formatDuration(elapsedMs),
      expected: isExpected,
      evidence,
      /** ★ B2：活动采样结论（`known:false` = 本次拿不到证据，不是"它没动"）。 */
      activity: { known: act.known, grew: act.grew, conclusive: act.conclusive, fresh: act.fresh === true, fresh_age_ms: act.fresh_age_ms ?? null, delta_bytes: act.delta_bytes, delta_ms: act.delta_ms, reason: act.reason, sample_at: activity?.[key]?.atMs ?? null },
      /**
       * ★ P1-6：这一次观察有没有拿到**单样本**的阳性证据（"文件此刻正在被写"）。
       *   它**不是** `alive`（`alive` 只看字节增量）：两个口径互不冒充。
       */
      fresh_write: freshWrite,
      /** ★ P1-6：这一次观察算不算"没有实证的安静"（它才是决定冻不冻的那一个比特）。 */
      quiet_evidence: silentHere,
      /**
       * ★ 连续"没有实证"的次数（本次之后）。
       *   ★ 2026-10-13 快修（②，P0-3）：**pending 也要 +1**。旧写法 `silentHere ? quiet+1 : 0`
       *   在 pending 分支写回 0 ⇒ 下一次读回来还是 0 ⇒ 永远凑不满 `confirmations`
       *   ⇒ 门开着的时候机制**一个席位都冻不掉**（静默把检测关掉）。
       */
      quiet_streak: silentHere || pendingHere !== null ? quiet + 1 : 0,
      silent: silentHere,
      /**
       * ★★ **P1-4：宿主读到的「在等审批」状态**（每席位一条）。
       *   `known:false` = 这一次**读不到**（不是"没在等"）—— 与 `activity.known` 同一条口径。
       */
      approval: {
        known: approvalKnown,
        count: pendingApprovals.length,
        pending: pendingApprovals,
        tools: [...new Set(pendingApprovals.map((p) => String(p?.tool_name ?? '')).filter((x) => x.length > 0))],
        policy: typeof approvalRec?.policy === 'string' && approvalRec.policy.length > 0 ? approvalRec.policy : null,
        note: typeof approvalRec?.note === 'string' ? approvalRec.note : '',
      },
      /** ★ P1-4：这个席位**在等审批** ⇒ 不是失联、也不该被重派。 */
      awaiting_approval: awaitingHere,
    }
    seats.push(rec)
    if (silentHere) silent.push(rec)
    else if (pendingHere !== null) pending.push({ ...rec, pending_reason: pendingHere })
    if (awaitingHere) awaiting.push(rec)
  }

  return {
    silenceMs,
    silence_zh: formatDuration(silenceMs),
    confirmations,
    /** ★ 确认门本次是否生效（见函数内 `gateOn` 的规则）。 */
    gate_applicable: gateOn,
    /** ★ 本次有没有拿到会话活动证据（`false` ⇒ 判据会更保守，见 `confirmations`）。 */
    activity_known: activity !== null,
    state,
    state_zh: STATE_LABEL[state] ?? state,
    expected,
    seats,
    silent,
    pending,
    /**
     * ★★ **P1-4：在等审批的席位**（`approval.known === true && pending 非空`）。
     *
     * 它们**不在** `silent` 里 —— 这是本次要消掉的那个误诊：席位弹了审批卡等人点，
     * 机制不该把它读成"可能已经死了"，更不该据此重派。
     */
    awaiting,
    awaiting_count: awaiting.length,
    /** ★ 本次审批探测有没有读到一个席位（`false` = 读不到，判据退回原有三条）。 */
    approval_known: approvals !== null && Object.values(approvals).some((a) => a !== null && typeof a === 'object' && a.known === true),
    ok: silent.length === 0,
    /**
     * ★ 判词：失联 + 在等审批**各写各的**（两份判据不同源、互不冒充）。
     *   没有失联也没有审批时 ⇒ 空串，与改前**逐字节相同**。
     */
    summary: [
      describeSilentSeats(silent, {
        state,
        state_zh: STATE_LABEL[state] ?? state,
        silenceMs,
        // ★ 把任务 id 传下去：处置动作要写成"可以直接复制去调"的形式
        taskId: typeof task?.id === 'string' ? task.id : '',
        /**
         * ★★ **A4 补丁（2026-10-12 · writer#1）：本次到底有没有拿到会话日志。**
         *
         * `describeSilentSeats` 里那一支（"并且**这一次拿不到会话日志**"）本来就存在，
         * 但这里**一直没传** ⇒ 它永远走不到，正文永远声称"会话日志也没在长"。
         * 那是**把"拿不到证据"说成了"它没动"** —— 与审计里 `activity_known:false` 自相矛盾。
         */
        activityKnown: activityKnownHere,
      }),
      describeApprovalWait(awaiting, {
        taskId: typeof task?.id === 'string' ? task.id : '',
        state,
        state_zh: STATE_LABEL[state] ?? state,
      }),
    ]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .join('\n'),
  }
}
