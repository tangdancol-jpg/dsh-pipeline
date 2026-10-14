/**
 * dsh-pipeline · **主对话侧的重启自动认领**
 * ============================================================================
 *
 * 现场（机制对比文档 §二 ④ 照出来的两半）
 * ----------------------------------------------------------------------------
 *   · **席位侧**已经是自动的 —— `index.js` 里那段「A27(b)：重启后认出既有席位」
 *     按盘上的 `task.dispatched[]` 台账调 `tokens.restore()`；
 *   · **主对话侧仍是手动** —— 每次 DSH 重启后都得由人（或主对话自己）发一次
 *     `pipeline_task_open { task_id, reattach: true }` 才恢复身份。
 *
 * 而令牌表是**进程内存态**（`lib/tokens.js` 文件头），重启即全空 ——
 * 这就是要在本模块里消灭的那一步。本模块做的是**那一半**，
 * 席位侧那一半一个字没动（判据不同源、互不冒充）。
 *
 * ----------------------------------------------------------------------------
 * 判据：**凭什么认定这个会话是某任务的主对话**
 * ----------------------------------------------------------------------------
 * 只用**主对话自己写下的、跨进程活着的那一条记录**：
 *
 *     `.pipeline/<任务>/task.json`  →  `contacts.main`
 *        { role: 'main', agent_id: '<会话 id>', generation, since, previous_agent, why }
 *
 * 这条记录由 `lib/store.js` 的 `rememberMainContact()` 落盘，而它挂在
 * `lib/tools.js` 的**唯一工具出口**（`rememberMainCaller`）上 —— 也就是
 * **每一次** pipeline 工具调用之后都会刷新一次。所以它回答的正是我们需要的那个问题：
 * 「上一次为止，**这张单的主对话会话是哪一个**」。
 *
 * 认定的**充要条件**（四条同时成立才算，缺一条就不认）：
 *   ① `contacts.main` 存在；
 *   ② 它的 `role` 就是 `main`；
 *   ③ 它的 `agent_id` 是**非空字符串**（空 / 缺 ⇒ 这条记录烂了，**认领不了**）；
 *   ④ 它与**本次调用方的会话 id 逐字相等**（`exec.agent.id`）。
 *
 * ★ 判据的唯一入口是 {@link judgeMainClaim}（**纯函数、只读、不写盘、不抛**）——
 *   要单独核这条判据，读它一个函数就够。
 *
 * ----------------------------------------------------------------------------
 * 三条纪律（写在代码里，不写在善意里）
 * ----------------------------------------------------------------------------
 *   ① **不放宽任何身份校验**：本模块**不碰** `tokens.resolve` / `roleOfAgent` /
 *      `bindAgent`，也不碰守门（`lib/guard.js`）的任何一条规则。它只做一件事 ——
 *      把**盘上已经写着属于这个会话**的 main 身份，从内存里**认回来**。
 *      比既有手动路径**更严**：手动 `reattach` 不校验调用方（`store.reattach`
 *      文件头写明"本方法不校验调用方身份"），而本模块要求
 *      `contacts.main.agent_id === 调用方会话 id`。**紧了一档，松了一档都没有。**
 *   ② **不补位、不建会话、不改状态**：结构上就没有 `transport.spawnRole` /
 *      `store.recordDispatch` / 任何状态迁移入口。留痕走**只追加**的
 *      `.pipeline/<任务>/audit.jsonl`（与 `store.audit()` / `createChannelAudit`
 *      同一份文件、同一种行格式），**不碰 `task.json`** —— 碰了就会把
 *      `lib/patrol.js` 的"最后一次进展时刻"推前，等于"机制自己制造了进展"。
 *   ③ **认领不了就说认领不了**：依据缺失 / 损坏 / 恢复被拒时返回
 *      `{claim:false, reason}` 并**留痕 + 报警**（A27(c) 的"看得见的失败"）。
 *      **不许静默、不许用近似物冒名**。
 *
 * @module dsh-pipeline/lib/reattach
 */

import { appendFileSync } from 'node:fs'

import { ROLE } from './roles.js'

/**
 * 留痕用的动作名（落在 `.pipeline/<任务>/audit.jsonl` 的 `action` 字段）。
 * 只追加，永不改写。
 */
export const MAIN_REATTACH_ACTION = 'main:reattach-auto'
/** 认领失败（依据坏了 / 恢复被拒）的留痕动作名 —— 与成功那条分开，便于反查。 */
export const MAIN_REATTACH_REFUSED_ACTION = 'main:reattach-refused'

/**
 * ★ **判据的理由码**（机器可读，稳定）。
 *
 * 为什么要有这一张表：判据的结论不能只是一句散文 —— 自测要断言它、
 * 报告要引用它、排查时要按它反查。`reason` 字段取这里的值，**永不用自由文本**。
 */
export const CLAIM_REASONS = Object.freeze({
  /** ① 盘上有记录，② 角色是 main，③ 会话 id 非空，④ 与本会话逐字相等 ⇒ **认领**。 */
  CLAIMED: 'recorded-main-session-matches',
  /** 这张单**根本没有** `contacts.main`（多数单的正常状态）⇒ 不认、不报（无从归因）。 */
  NO_RECORD: 'no-main-record-on-disk',
  /** 记录在、但 `agent_id` 是空的 / 不是字符串 ⇒ **这条记录烂了** ⇒ 认领不了（要报）。 */
  EMPTY_SESSION: 'record-has-no-session-id',
  /** 记录在、但 `role` 不是 main ⇒ 认领不了（要报）。 */
  ROLE_NOT_MAIN: 'record-role-is-not-main',
  /** 记录属于**另一个会话** ⇒ 不认（这是"不该绑的会话不得被绑上"那一格，不报）。 */
  OTHER_SESSION: 'record-belongs-to-another-session',
  /** 调用方**没有会话 id**（`exec.agent` 为空）⇒ 无从比对 ⇒ 认领不了。 */
  NO_CALLER_SESSION: 'caller-has-no-session-id',
  /** 本会话**在这张单里已经绑了另一个角色** ⇒ 不能让一个会话在同一单里演两个角色。 */
  ROLE_CONFLICT: 'session-already-has-another-role',
  /** 会话手上已经有 main 令牌（正常态）⇒ 无需认领。 */
  ALREADY_BOUND: 'main-token-already-in-memory',
  /** `tokens.restore()` 拒绝了这次恢复 ⇒ **认领失败**（要报，理由取自它）。 */
  RESTORE_REFUSED: 'token-restore-refused',
  /** 宿主加载的是旧版 tokens（热替换半途），没有 `restore` ⇒ 认领不了（要报）。 */
  RESTORE_UNAVAILABLE: 'token-store-has-no-restore',
})

/**
 * 读**盘上那条**主对话记录（只读、纯）。
 *
 * @param {object|null} task
 * @returns {{raw:object|null, agentId:string, role:string, generation:number|null, since:string, previousAgent:string|null}}
 */
export function mainRecordOf(task) {
  const contacts = task !== null && typeof task === 'object' ? task?.contacts : null
  const raw = contacts !== null && typeof contacts === 'object' && contacts.main !== null && contacts.main !== undefined && typeof contacts.main === 'object'
    ? contacts.main
    : null
  if (raw === null) {
    return { raw: null, agentId: '', role: '', generation: null, since: '', previousAgent: null }
  }
  return {
    raw,
    agentId: typeof raw.agent_id === 'string' ? raw.agent_id : '',
    role: typeof raw.role === 'string' ? raw.role : '',
    generation: Number.isInteger(raw.generation) ? raw.generation : null,
    since: typeof raw.since === 'string' ? raw.since : '',
    previousAgent: typeof raw.previous_agent === 'string' && raw.previous_agent.length > 0 ? raw.previous_agent : null,
  }
}

/**
 * ★★ **判据本体**：这个会话是不是这张单的主对话？
 *
 * 纯函数 —— **不读盘、不写盘、不抛、不改入参**。判据四条件见文件头。
 *
 * @param {object|null} task - 盘上那张单（`store.get()` / `store.peek()` 的形状）
 * @param {string|null|undefined} sessionId - 调用方会话 id（`exec.agent.id`）
 * @returns {{claim:boolean, reason:string, detail:string, evidence:object}}
 */
export function judgeMainClaim(task, sessionId) {
  const taskId = String(task?.id ?? '')
  const sid = typeof sessionId === 'string' ? sessionId : ''
  const rec = mainRecordOf(task)
  /** ★ 判据的**证据**：事后能逐字复算这一次判决（不靠"我记得"）。 */
  const evidence = {
    task_id: taskId,
    caller_session: sid,
    recorded_agent_id: rec.agentId,
    recorded_role: rec.role,
    recorded_generation: rec.generation,
    recorded_since: rec.since,
    recorded_previous_agent: rec.previousAgent,
    task_state: String(task?.state ?? ''),
  }

  // ① 盘上没有这条记录 ⇒ 无从归因。**这是多数单的正常状态**，不是失败。
  if (rec.raw === null) {
    return {
      claim: false,
      reason: CLAIM_REASONS.NO_RECORD,
      detail: '这张单的 `task.json` 里没有 `contacts.main` —— 没有"谁是主对话"的跨进程记录，**不猜**。',
      evidence,
    }
  }
  // ③ 记录在、但烂了（会话 id 空 / 非字符串）⇒ **认领不了，必须报出来**。
  if (rec.agentId.length === 0) {
    return {
      claim: false,
      reason: CLAIM_REASONS.EMPTY_SESSION,
      detail:
        '`contacts.main` 在，但它的 `agent_id` 是空的 —— 这条记录已经坏了。\n' +
        '★ **认领不了**（不用近似物冒名）：请人出面走手动通道 `pipeline_task_open { task_id, reattach: true }`。',
      evidence,
    }
  }
  // ② 角色不是 main ⇒ 认领不了（要报）。
  if (rec.role !== ROLE.MAIN) {
    return {
      claim: false,
      reason: CLAIM_REASONS.ROLE_NOT_MAIN,
      detail: `\`contacts.main\` 的 \`role\` 是「${rec.role}」而不是「${ROLE.MAIN}」—— 认领不了。`,
      evidence,
    }
  }
  // 调用方自己没身份 ⇒ 无从比对。
  if (sid.length === 0) {
    return {
      claim: false,
      reason: CLAIM_REASONS.NO_CALLER_SESSION,
      detail: '本次调用没有会话身份（`exec.agent` 为空）—— 没有可比对的东西，认领不了。',
      evidence,
    }
  }
  // ④ 逐字相等才算 —— 这是整条判据里唯一"授权"的那一步。
  if (rec.agentId !== sid) {
    return {
      claim: false,
      reason: CLAIM_REASONS.OTHER_SESSION,
      detail: '这条 `contacts.main` 属于**另一个会话** —— 不认（一个任务同时只认一个主对话会话）。',
      evidence,
    }
  }
  return {
    claim: true,
    reason: CLAIM_REASONS.CLAIMED,
    detail: `盘上这条记录写着本单的主对话就是本会话（generation ${rec.generation ?? '(未知)'}，自 ${rec.since || '(未知)'}）⇒ 认领。`,
    evidence,
  }
}

/**
 * ★ **纯判据的第二段**：把"盘上所有单"过一遍，给出**认领计划**（不动作）。
 *
 * 与 {@link judgeMainClaim} 同源 —— 这里只负责"逐单问一遍 + 把已经绑好的剔掉"。
 *
 * @param {object} spec
 * @param {Array<object>} spec.tasks - 盘上的单（`store.get()` 的形状）
 * @param {string} spec.sessionId
 * @param {(taskId:string)=>boolean} [spec.isBound] - 本会话在这张单里已经有令牌了吗
 * @returns {{claims:Array<object>, refused:Array<object>, skipped:Array<object>}}
 */
export function planMainReattach(spec = {}) {
  const tasks = Array.isArray(spec.tasks) ? spec.tasks : []
  const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId : ''
  const isBound = typeof spec.isBound === 'function' ? spec.isBound : () => false
  const claims = []
  const refused = []
  const skipped = []
  for (const task of tasks) {
    if (task === null || task === undefined) continue
    const verdict = judgeMainClaim(task, sessionId)
    if (verdict.claim !== true) {
      // ★ 只有**这条记录存在但用不了**的几种才算"认领不了"（要报警、要留痕）；
      //   "没有记录" / "属于别人" 是**正常**的，报出来只会变成噪音（也会泄露别人的会话 id）。
      const reportable =
        verdict.reason === CLAIM_REASONS.EMPTY_SESSION ||
        verdict.reason === CLAIM_REASONS.ROLE_NOT_MAIN ||
        verdict.reason === CLAIM_REASONS.RESTORE_UNAVAILABLE
      if (reportable) refused.push({ ...verdict, reportable: true })
      else skipped.push({ ...verdict, reportable: false })
      continue
    }
    if (isBound(String(task.id ?? '')) === true) {
      skipped.push({
        claim: false,
        reason: CLAIM_REASONS.ALREADY_BOUND,
        detail: '本会话在这张单里已经有令牌了 —— 无需认领。',
        evidence: verdict.evidence,
        reportable: false,
      })
      continue
    }
    claims.push(verdict)
  }
  return { claims, refused, skipped }
}

/**
 * ★★ **执行认领**（唯一会动令牌表的地方）。
 *
 * 纪律见文件头：只调 `tokens.restore()`（席位侧那半用的是**同一个**入口、
 * 同一份语义），**不建会话、不派席位、不迁移状态、不碰 `task.json`**。
 *
 * @param {object} deps
 * @param {object} deps.store - 任务存储（只用 `list` / `get` / `auditFile`）
 * @param {object} deps.tokens - 令牌表
 * @param {string} deps.sessionId - 调用方会话 id
 * @param {(msg:string)=>void} [deps.log] - 正常进展（成功认领）
 * @param {(msg:string)=>void} [deps.warn] - **看得见的失败**（认领不了）
 * @param {Set<string>} [deps.cache] - 负缓存：扫过且一张都没认到的会话，不再重复扫盘
 * @param {Set<string>} [deps.refusalMemo] - "同一条认领不了"只报警/留痕一次（**不刷屏**）；
 *   ⚠️ 它只压**报警与留痕**，**不压报告** —— 每一次扫的结论里那一条照样在 `refused` 里
 *   （不静默与不刷屏是两件事，两个都要）。
 * @returns {Promise<object>} 报告（同时是只读导出 `lastMainReattach()` 的内容）
 */
export async function autoReattachMain(deps = {}) {
  const store = deps.store
  const tokens = deps.tokens
  const sessionId = typeof deps.sessionId === 'string' ? deps.sessionId : ''
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const cache = deps.cache instanceof Set ? deps.cache : null
  const refusalMemo = deps.refusalMemo instanceof Set ? deps.refusalMemo : null
  /** 同一张单 + 同一个理由只喊一次（进程内）。 */
  const shoutOnce = (taskId, reason) => {
    if (refusalMemo === null) return true
    const key = `${taskId}|${reason}`
    if (refusalMemo.has(key)) return false
    refusalMemo.add(key)
    return true
  }

  const report = {
    at: new Date().toISOString(),
    session_id: sessionId,
    swept: false,
    reason: '',
    tasks_seen: 0,
    claims: [],
    refused: [],
    skipped: 0,
    /** ★ 机械判据：本模块**没有**任何创建会话 / 派席位的通路（自测直接断言这两个字段）。 */
    created_sessions: 0,
    created_seats: 0,
    touched_task_json: false,
  }

  if (sessionId.length === 0) {
    report.reason = CLAIM_REASONS.NO_CALLER_SESSION
    return report
  }
  /** ★ 会话 id 都没有就别问令牌表 —— 但要**说出来**这是"认领不了"，不是"不用认领"。 */
  if (tokens === null || tokens === undefined || typeof tokens.tasksOfAgent !== 'function') {
    report.reason = CLAIM_REASONS.RESTORE_UNAVAILABLE
    warn(`[pipeline] 主对话侧自动认领**做不了**：令牌表没有 \`tasksOfAgent\`（会话 ${sessionId}）—— 重启后仍须手动 reattach。`)
    return report
  }

  // ★ 快路径：手上已经有 main 令牌 ⇒ 本来就是正常态，**连盘都不扫**。
  let bound = []
  try {
    bound = tokens.tasksOfAgent(sessionId, ROLE.MAIN)
  } catch {
    bound = []
  }
  if (Array.isArray(bound) && bound.length > 0) {
    report.reason = CLAIM_REASONS.ALREADY_BOUND
    return report
  }

  /**
   * ★ 负缓存：**扫过一次、一张都没认到**的会话不再重复扫盘。
   *
   * 为什么必须有：这条判据挂在**每一次**工具调用的前置缝上，而绝大多数会话
   * 都不是任何任务的主对话 —— 没有缓存，用户每点一次工具都要把整个
   * `.pipeline/` 扫一遍。
   */
  if (cache !== null && cache.has(sessionId)) {
    report.reason = CLAIM_REASONS.NO_RECORD
    report.note = '本会话已经扫过一遍（当时一张都没认到）—— 不重复扫盘。'
    return report
  }

  if (store === null || store === undefined || typeof store.list !== 'function' || typeof store.get !== 'function') {
    report.reason = CLAIM_REASONS.RESTORE_UNAVAILABLE
    warn('[pipeline] 主对话侧自动认领**做不了**：拿不到任务存储（`store.list` / `store.get`）。')
    return report
  }

  report.swept = true
  let list = []
  try {
    list = await store.list()
  } catch (err) {
    report.reason = 'scan-failed'
    warn(`[pipeline] 主对话侧自动认领**扫盘失败**（认领不了，不是"不用认领"）：${String(err?.message ?? err)}`)
    return report
  }

  const tasks = []
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry?.id ?? '')
    if (id.length === 0) continue
    let task = null
    try {
      task = await store.get(id)
    } catch {
      task = null
    }
    if (task !== null && task !== undefined) tasks.push(task)
  }
  report.tasks_seen = tasks.length

  const isBound = (taskId) => {
    try {
      return tokens.roleOfAgent(sessionId, taskId) !== null
    } catch {
      return false
    }
  }
  const plan = planMainReattach({ tasks, sessionId, isBound })
  report.refused = plan.refused.map((r) => ({ ...r }))
  report.skipped = plan.skipped.length

  const hasRestore = typeof tokens.restore === 'function'
  for (const claim of plan.claims) {
    const taskId = String(claim.evidence.task_id ?? '')
    if (!hasRestore) {
      const refusal = {
        claim: false,
        reason: CLAIM_REASONS.RESTORE_UNAVAILABLE,
        detail: '令牌表没有 `restore()`（宿主加载的是旧版 tokens）—— **认领不了**。',
        evidence: claim.evidence,
        reportable: true,
      }
      report.refused.push(refusal)
      if (shoutOnce(taskId, refusal.reason) === true) {
        auditRefusal(store, taskId, refusal, warn)
        warn(`[pipeline] 认领不了 ${taskId}：${refusal.detail}`)
      }
      continue
    }
    // ★ 同一单里已经演了别的角色 ⇒ 不让它再演 main（否则一个会话两个角色）。
    let existing = null
    try {
      existing = tokens.roleOfAgent(sessionId, taskId)
    } catch {
      existing = null
    }
    if (existing !== null && existing !== undefined) {
      // ★ 这一个会话在这张单里已经演了**别的角色** ⇒ 不能让它在同一单里再演 main
      //   （`lib/tokens.js` 的 `bindAgent` 认的是同一条不变量）。**认领不了，报出来。**
      const refusal = {
        claim: false,
        reason: CLAIM_REASONS.ROLE_CONFLICT,
        detail: `本会话在这张单里已经绑了「${String(existing.role ?? '?')}」—— 一个会话在同一任务里只能担任一个角色，**认领不了**。`,
        evidence: claim.evidence,
        reportable: true,
      }
      report.refused.push(refusal)
      if (shoutOnce(taskId, refusal.reason) === true) {
        auditRefusal(store, taskId, refusal, warn)
        warn(`[pipeline] ✗ **认领不了** ${taskId} 的主对话身份：${refusal.detail}`)
      }
      continue
    }

    let r = null
    try {
      /**
       * ★ 与**席位侧**那半调用的是**同一个**入口、同一份语义（`lib/tokens.js`
       *   的 `restore`）：只认身份，不铸"新"身份。
       *   `token: null` ⇒ 让它铸一枚 `PT-restored-…` 并标 `restored: true`，
       *   事后能分辨"这枚是认回来的"（**不冒充**一枚从没存在过的原始令牌）。
       */
      r = tokens.restore({ taskId, role: ROLE.MAIN, seat: null, agentId: sessionId, sessionId, token: null, atMs: null })
    } catch (err) {
      r = { ok: false, restored: false, reason: `restore 抛异常：${String(err?.message ?? err)}` }
    }

    if (r === null || r === undefined || r.ok !== true) {
      const reason = String(r?.reason ?? '(没有理由 —— 这本身是个缺陷)')
      const refusal = {
        claim: false,
        reason: CLAIM_REASONS.RESTORE_REFUSED,
        detail: reason,
        evidence: claim.evidence,
        reportable: true,
      }
      report.refused.push(refusal)
      if (shoutOnce(taskId, refusal.reason) === true) {
        auditRefusal(store, taskId, refusal, warn)
        warn(
          `[pipeline] ✗ **认领不了** ${taskId} 的主对话身份（会话 ${sessionId}）—— ${reason}\n` +
            '  依据：`task.json` 的 `contacts.main.agent_id` 与本次会话 id 逐字相等。\n' +
            '  ⇒ 这一次**没有**恢复任何身份（不静默、也不用近似物冒名）；请人出面走手动通道 ' +
            '`pipeline_task_open { task_id, reattach: true }`。',
        )
      }
      continue
    }

    report.claims.push({
      task_id: taskId,
      role: ROLE.MAIN,
      session_id: sessionId,
      restored: r.restored === true,
      reason: String(r.reason ?? ''),
      evidence: claim.evidence,
      created_session: false,
      created_seat: false,
      touched_task_json: false,
    })
    auditClaim(store, taskId, sessionId, claim, r, warn)
    log(
      `[pipeline] ✓ 主对话侧**自动认领**：会话 ${sessionId} 恢复为 ${taskId} 的主对话` +
        `（判据 = \`contacts.main.agent_id\` 与本会话逐字相等；${r.restored === true ? '令牌已按台账认回' : '令牌已在表里'}）。`,
    )
  }

  // ★ 依据坏掉的那几张（记录在、用不了）—— **必须报出来**，这是"认领不了"。
  for (const refusal of plan.refused) {
    const taskId = String(refusal.evidence?.task_id ?? '')
    if (shoutOnce(taskId, refusal.reason) !== true) continue
    auditRefusal(store, taskId, refusal, warn)
    warn(
      `[pipeline] ✗ **认领不了** ${taskId} 的主对话身份 —— ${refusal.detail}\n` +
        `  记录原文：${JSON.stringify(refusal.evidence)}\n` +
        '  ⇒ 请人出面走手动通道 `pipeline_task_open { task_id, reattach: true }`（本模块**不补位、不新建会话**）。',
    )
  }

  /**
   * ★ 负缓存只记"一张都没认到"的那一次：认到了的会话下次会走"已有令牌"快路径，
   *   而**依据坏掉的单**每次调用都还会再报一遍（不许因为缓存而静默）。
   */
  if (cache !== null && report.claims.length === 0 && report.refused.length === 0) cache.add(sessionId)
  if (report.claims.length > 0) report.reason = CLAIM_REASONS.CLAIMED
  else if (report.refused.length > 0) report.reason = CLAIM_REASONS.RESTORE_REFUSED
  else report.reason = CLAIM_REASONS.NO_RECORD

  return report
}

/**
 * 成功认领的留痕。
 *
 * ★ 落点是**只追加**的 `.pipeline/<任务>/audit.jsonl`（与 `store.audit()` 同一份
 *   文件、同一种行格式）——**不**走 `store.recordAudit()`，因为后者会把这条
 *   记进 `task.history` 并重写 `task.json`，而 `lib/patrol.js` 的
 *   "最后一次进展时刻"读的正是 `history` 的末条 ⇒ 那等于**机制自己制造了进展**。
 */
function auditClaim(store, taskId, sessionId, claim, restored, warn) {
  appendAudit(store, taskId, MAIN_REATTACH_ACTION, {
    session_id: sessionId,
    recorded_agent_id: claim.evidence.recorded_agent_id,
    recorded_generation: claim.evidence.recorded_generation,
    token_restored: restored?.restored === true,
    created_session: false,
    created_seat: false,
    touched_task_json: false,
    note: '★ DSH 重启后主对话侧**自动认领**（判据 = task.json 的 contacts.main.agent_id 与本次会话 id 逐字相等；不补位、不建会话、不改状态）',
  }, warn)
}

/** 认领失败的留痕（与成功那条**分开**的动作名，便于按"看得见的失败"反查）。 */
function auditRefusal(store, taskId, refusal, warn) {
  appendAudit(store, taskId, MAIN_REATTACH_REFUSED_ACTION, {
    reason: refusal.reason,
    detail: refusal.detail,
    evidence: refusal.evidence,
    note: '★ 认领失败**如实留痕**（不许静默、不许用近似物冒名）',
  }, warn)
}

/** 一行 JSON 追加（写不进去也**说出来**，不静默 —— 与 `createChannelAudit` 同一纪律）。 */
function appendAudit(store, taskId, action, detail, warn) {
  if (typeof taskId !== 'string' || taskId.length === 0) return
  if (store === null || store === undefined || typeof store.auditFile !== 'function') return
  let file = ''
  try {
    file = String(store.auditFile(taskId) ?? '')
  } catch {
    file = ''
  }
  if (file.length === 0) return
  const line = { at: new Date().toISOString(), task_id: taskId, actor: ROLE.MAIN, action, ...detail }
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
  } catch (err) {
    warn(`[pipeline] 认领留痕写盘失败（判决仍留在只读导出 lastMainReattach() 里）：${String(err?.message ?? err)}`)
  }
}

/**
 * 把报告变成一段给人看的文字（只读；报告本身是 `lastMainReattach()` 的内容）。
 *
 * @param {object|null} report
 * @returns {string}
 */
export function formatMainReattachReport(report) {
  if (report === null || report === undefined) return '(还没有扫过：本进程内没有任何一次工具调用触发过自动认领。)'
  const lines = [
    `会话：${report.session_id || '(空)'}　扫盘：${report.swept === true ? '是' : '否'}　看了 ${report.tasks_seen} 张单`,
    `结论码：${report.reason || '(无)'}`,
    `认领成功：${report.claims.length} 张${report.claims.length === 0 ? '' : ` —— ${report.claims.map((c) => c.task_id).join('、')}`}`,
    `认领不了：${report.refused.length} 张${report.refused.length === 0 ? '' : ` —— ${report.refused.map((r) => `${r.evidence?.task_id ?? '?'}(${r.reason})`).join('、')}`}`,
    `跳过（正常态）：${report.skipped}`,
    `★ 机械判据：新建会话 ${report.created_sessions} 个、新建席位 ${report.created_seats} 个、改 task.json ${report.touched_task_json === true ? '是' : '否'}`,
  ]
  if (typeof report.note === 'string' && report.note.length > 0) lines.push(`附注：${report.note}`)
  return lines.join('\n')
}
