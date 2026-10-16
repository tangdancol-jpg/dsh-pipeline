// 主管枢纽的「席位补派」：唤醒点要**真的派人**，缺位要能自愈（幂等 + 留痕）。
/**
 * dsh-pipeline · 工具层 · 主管枢纽的席位补派
 * ============================================================================
 * 从 `lib/tools/flow.js`（主管枢纽那一支）拆出来的一部分：**"唤醒点派人"与
 * "缺位自愈"本来就是同一件事**（同一个授权来源、同一套派活通道、同一份留痕），
 * 所以自成一个文件，而不是两处各写一遍。
 *
 * ---------------------------------------------------------------------------
 * 它修的是什么（真机 `T-20261016-fullai`，实测）
 * ---------------------------------------------------------------------------
 *   `pipeline_supervise{action:'initiate'}` 只写枢纽账本：状态到了「需求分析中」，
 *   而**需求位根本不存在**；`action='agree_need'` 同理（架构位不存在），
 *   而此刻 `pipeline_dispatch{role:'architect'}` 又被引导步白名单拒掉
 *   （"这个时候唯一能被派出去的角色是：需求分析"）。
 *   偏偏角色清单只能由计划位产出、计划位要唤醒点 B、唤醒点 B 要架构图、架构图要架构位
 *   ⇒ **环 = 死锁**，主对话只能干等（现场静默 4 分 13 秒）。
 *
 * ---------------------------------------------------------------------------
 * 三条设计判据（写在代码里，不写在善意里）
 * ---------------------------------------------------------------------------
 *   ① **授权的唯一来源是 `task.hub` 账本** —— 它不是调用方身份、也不是第二份名单：
 *      · `hub.enabled === true` ⇒ 需求位（发起它的就是这个枢纽）；
 *      · `hub.standby[].status === 'woken'` ⇒ 那个席位（**到点了**才该有人）。
 *      账本只有主管能写（`by: ['supervisor']` + 具名事件 + `store.checkPrecondition`），
 *      所以"补派"不是"谁想加人就能加人"，而是**执行主管已经登记的名单**。
 *   ② **派活复用既有通道**（`pipeline_dispatch` 这个**工具入口**本身，不是复制它的实现）：
 *      真会话 + 四槽 + 令牌 + 派活台账 + 它里面每一道既有闸门（档位/清单/席位/留痕）
 *      一个不落。★ 刻意**不**把 `pipeline_dispatch` 的调用方白名单从 `['main']`
 *      扩到 `['main','supervisor']` —— 安全预审阻断项 B2 明令禁止（那会让主管
 *      连带拿到 main 的整片派活权），见 `lib/guard/rules.js` 的 `pipeline_supervise`。
 *   ③ **幂等 + 不许静默**：同一个角色**不重复派**（判据是派活台账里**有没有这一条**）；
 *      每一次补派都写 `hub:seat-respawn` 进 `audit.jsonl` 与 `task.history`；
 *      派不出去时把**拒绝原文**如实带回去（这一条与越界清单第 13 条同源）。
 *
 * @module dsh-pipeline/lib/tools/hub-seats
 */

import { ROLE, ROLES, roleLabel } from '../roles.js'
import { ST, TERMINAL_STATES, hubWakePointOf } from '../states.js'

/** 补派的审计动作名（**唯一出处** —— 审计、只读导出、自测都读它，不手抄）。 */
export const HUB_SEAT_RESPAWN_ACTION = 'hub:seat-respawn'

/**
 * ★★ **机制身份的名字**（A 件，2026-10-16 真机 `T-20261016-fullai`）。
 *
 * 它写进令牌记录的 `mechanism` 字段、写进审计、也写进摘要 —— 一处常量、三个落点，
 * 事后按它一条 grep 就能把"机制自己发起的派活"全部捞出来。
 */
export const HUB_SEAT_MECHANISM = 'hub-seat-respawn'

/**
 * ★★ **自愈为什么必须有「自己的身份」**（这一件修的就是它）
 *
 * 现场原文（主对话在 `pipeline_status` 里触发了自愈补派）：
 *   ```
 *   ✗ 补派 架构/技术方案 没派出去：无法确定调用方角色：既没有绑定会话，也没有携带 role_token。
 *   ✗ 补派 架构图      没派出去：同上
 *   ```
 * 病根：`ensureHubSeats` 把**调用方的 `exec`** 递进了派活通道，于是判据变成了
 * 「**谁在查状态**」—— 而重启之后主对话自己也没有身份（令牌表是进程内存态）
 * ⇒ 自愈**必然**失败，且看起来像"就是派不出去"。
 *
 * 判据（**复用既有授权来源，不新造概念**）：
 *   · **授权**来自 `task.hub` 账本 —— 与 `hubAuthorizedRoles` / `hubSeatGaps` 同源：
 *     `hub.enabled` + `standby[].status === 'woken'`。账本只有主管能写 ⇒
 *     "谁能被补派"仍然是**执行主管已经登记的名单**，机制没有多一分辨人权。
 *   · **身份**由机制**自己铸**（`tokens.mint({ mechanism })`），不是从调用方借的：
 *     这枚令牌 `agentId` 恒为 `null`（不属于任何会话）、不能被 `bindAgent` 绑走、
 *     在审计里记的是机制名而不是 `main`。
 *   ⇒ 目标（用户原话）：**任何人在任何时候查一次状态，缺位席位都能被补派成功。**
 *
 * @param {object|null} tokens - 令牌表（宿主注入；拿不到时**退回旧行为**并说出来）
 * @param {object} task
 * @returns {{token:string|null, exec:object, why:string, revoke:()=>void}}
 */
export function mintMechanismIdentity(tokens, task) {
  const taskId = String(task?.id ?? '')
  const bare = { agent: null, signal: undefined }
  if (
    tokens === null ||
    tokens === undefined ||
    typeof tokens.mint !== 'function' ||
    typeof tokens.revoke !== 'function' ||
    taskId.length === 0
  ) {
    return {
      token: null,
      exec: bare,
      why:
        '⚠ **没有铸出机制身份**（令牌表不可用 / 任务 id 为空）—— 这一次补派退回"借调用方身份"的旧行为，' +
        '调用方自己没身份时**必然失败**。这是降级，不是正常态。',
      revoke: () => {},
    }
  }
  const rec = tokens.mint({
    // ★ 角色取 `main`：`pipeline_dispatch` 的调用方白名单就是 `['main']`（`lib/guard/rules.js:277`），
    //   而**授权**不是这个字段给的 —— 是 `task.hub` 账本给的（见上面的判据）。不新造角色。
    role: ROLE.MAIN,
    taskId,
    seat: null,
    agentId: null,
    mechanism: HUB_SEAT_MECHANISM,
    note: `机制身份（${HUB_SEAT_MECHANISM}）：授权来源 = task.hub 账本；不对应任何会话，用完即撤。`,
  })
  return {
    token: rec.token,
    exec: bare,
    why: `机制身份 ${rec.token}（${HUB_SEAT_MECHANISM}；授权来源 = \`task.hub\` 账本，不对应任何会话）。`,
    revoke: () => {
      try {
        tokens.revoke(rec.token)
      } catch {
        /* 撤不掉不影响判据：它 `agentId` 恒 null、TTL 到期即清（令牌表自己会 sweep） */
      }
    },
  }
}

/** 摘要里那一行的统一措辞（自测按它断言；改文案要一起改，不许两处各写一份）。 */
export const HUB_SEAT_RESPAWN_HEAD = '★ 唤醒点派人（复用既有派活通道；幂等，同一角色不重复派）：'

/**
 * ★ 枢纽账本**授权**哪些角色可以在这个阶段被补派。
 *
 * 白名单方向（没登记 = 补派不了）：
 *   · `orchestrator` —— `hub.enabled` 就是"这个枢纽要跑需求位"这件事本身；
 *   · `hub.standby` 里 **`status === 'woken'`** 的席位 —— 到点了才该有人。
 *     `standby`（已登记待机）**不算**：那时该做的是"登记可见"，不是"叫人开工"
 *     （早早建出来的闲置席位还会被失联检测盯上）。
 *
 * @param {object|null} task
 * @returns {string[]} 角色 id（去重、按授权顺序）
 */
export function hubAuthorizedRoles(task) {
  const hub = task?.hub
  if (hub === null || typeof hub !== 'object' || Array.isArray(hub)) return []
  if (hub.enabled !== true) return []
  const out = []
  const push = (role) => {
    const r = String(role ?? '')
    if (r.length === 0 || r === ROLE.MAIN) return
    if (ROLES[r] === undefined) return
    if (!out.includes(r)) out.push(r)
  }
  push(ROLE.ORCHESTRATOR)
  for (const e of Array.isArray(hub.standby) ? hub.standby : []) {
    if (String(e?.status ?? '') !== 'woken') continue
    push(e?.role)
  }
  return out
}

/**
 * ★ 「状态到了、人没到」的**判据**：账本授权的角色里，派活台账**没有这一条**的那些。
 *
 * ⚠️ 判据是"台账里有没有这一条"，**不是**"这一条的会话 id 空不空"：
 *   后者在 `transport=manual`（只出派活单、不建会话）下**永远是空**，
 *   拿它当缺位判据会把"人工通道"变成每次触发都重派一次的循环。
 *   会话 id 缺失时 `nudgeSeat` 会**指名报出来**（"台账里没有会话 id"），不静默。
 *
 * @param {object|null} task
 * @returns {Array<{role:string, wake_point:string|null}>}
 */
export function hubSeatGaps(task) {
  const dispatched = Array.isArray(task?.dispatched) ? task.dispatched : []
  /**
   * ★ 终态与「已阻塞」上**没有"该到的人"这回事**（否则自愈会替人做决定）：
   *   · `closed` / `cancelled` —— 流程已经结束，补派只会给一张死单建会话；
   *   · `blocked` —— 那是机制或主对话**故意**按下的暂停键，恢复路径是
   *     `pipeline_dispatch { reassign: true }`（先回到阻塞前的状态再重派，是一个**明确动作**）——
   *     不该由"查一次状态"顺手替它做，那会把一次事故静默抹平。
   */
  if (TERMINAL_STATES.includes(String(task?.state ?? '')) || String(task?.state ?? '') === ST.BLOCKED) return []
  return hubAuthorizedRoles(task)
    .filter((role) => !dispatched.some((x) => String(x?.role ?? '') === role))
    .map((role) => ({ role, wake_point: hubWakePointOf(role) }))
}

/** 拒绝原文的第一行（摘要里只放一行，剩下的让人去查 pipeline_status）。 */
function firstLine(text, max = 200) {
  const s = String(text ?? '').split('\n')[0]
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 造一个「枢纽席位补派器」。
 *
 * @param {object} ctx
 * @param {object} ctx.store - 任务存储（只用 `recordAudit`）
 * @param {{execute:Function}} ctx.dispatch - **既有的** `pipeline_dispatch` 工具定义
 *   （走它的 `execute` = 连开关判据一起走，与宿主调用它是同一条路）
 * @param {(taskId:string)=>Promise<object|null>} ctx.load - 读任务（顺手登记同步索引）
 * @param {object} [ctx.tokens] - ★ **A 件**：令牌表 —— 自愈**自己铸身份**用的那一份
 *   （`mint({ mechanism })` / `revoke`）。拿不到时退回旧行为并在摘要里说明（不静默）。
 * @returns {{ensureHubSeats:Function}}
 */
export function createHubSeatRespawner(ctx) {
  const { store, dispatch, load, tokens } = ctx

  /**
   * 补齐 `task` 上缺位的枢纽席位（幂等；每次补派都留痕）。
   *
   * @param {object} task - 当前任务（判据读它）
   * @param {object} exec - 调用方的 exec（★ **只用来取 signal**；身份不从这里借）
   * @param {{by?:string, via?:string, reason?:string}} [opts] - 留痕用（谁、为什么触发）
   * @returns {Promise<{ok:boolean, task:object|null, spawned:object[], failed:object[], lines:string[], mechanism:string|null}>}
   */
  async function ensureHubSeats(task, exec, opts = {}) {
    const gaps = hubSeatGaps(task)
    const spawned = []
    const failed = []
    const lines = []
    if (gaps.length === 0) return { ok: true, task, spawned, failed, lines, mechanism: null }
    const by = String(opts.by ?? '')
    const via = String(opts.via ?? 'hub-seat-respawn')
    const reason = String(opts.reason ?? '')
    /**
     * ★★ **A 件**：先铸机制自己的身份，再用它去派活 —— 判据见 {@link mintMechanismIdentity}。
     *   `signal` 是唯一从调用方带过来的东西（它是"这一次调用被中止了"这个事实，
     *   不是身份）；其它一律不带。
     */
    const ident = mintMechanismIdentity(tokens, task)
    /**
     * ★ 铸不出机制身份时**退回旧行为**（把调用方的 exec 原样递进去）—— 那是降级，
     *   不是正常态，所以上面已经把话写进摘要（`ident.why`）。反过来：**铸出来了就
     *   绝不碰调用方的 exec**（只借它的 `signal`，那是"这次调用被中止了"这个事实，
     *   不是身份）。
     */
    const mechanismExec = ident.token === null ? exec : { ...ident.exec, signal: exec?.signal }
    if (ident.why.startsWith('⚠')) lines.push(`  ${ident.why}`)
    let cur = task
    try {
      for (const gap of gaps) {
        let res = null
        try {
          // ★ 既有通道的**唯一入口**：真会话 + 四槽 + 令牌 + 台账 + 全部既有闸门。
          res = await dispatch.execute(
            {
              task_id: String(task.id ?? ''),
              role: gap.role,
              ...(ident.token === null ? {} : { role_token: ident.token }),
            },
            mechanismExec,
          )
        } catch (err) {
          res = { ok: false, summary: `[pipeline] 补派通道抛错（这是插件 bug）：${String(err?.message ?? err)}` }
        }
        const ok = res !== null && typeof res === 'object' && res.ok === true
        const session = ok ? String(res.agent_id ?? '') : ''
        if (ok) {
          spawned.push({ role: gap.role, session_id: session })
          lines.push(`  ✓ 补派 ${roleLabel(gap.role)}（${session.length > 0 ? `会话 ${session}` : '人工通道：只出派活单'}）`)
        } else {
          failed.push({ role: gap.role, reason: String(res?.summary ?? '（没有原因）') })
          lines.push(`  ✗ 补派 ${roleLabel(gap.role)} **没派出去**：${firstLine(res?.summary)}`)
        }
        // ★ 每一次补派**都留痕**（谁在什么时候补的谁、成没成）—— 与"叫醒要留痕"同一条纪律。
        try {
          await store.recordAudit(String(task.id ?? ''), by.length > 0 ? by : HUB_SEAT_MECHANISM, HUB_SEAT_RESPAWN_ACTION, {
            by,
            via,
            role: gap.role,
            wake_point: gap.wake_point,
            ok,
            session_id: session.length > 0 ? session : null,
            reason: ok ? reason : `${reason}｜拒绝原文：${firstLine(res?.summary, 400)}`,
            /**
             * ★★ **A 件的留痕**：这一次补派用的是**机制自己的身份**，不是调用方的。
             *   事后能一眼回答"这次补派成不成，靠的是谁的身份"。
             */
            identity: ident.token === null ? 'caller-fallback' : 'mechanism',
            identity_source: 'task.hub',
            mechanism: HUB_SEAT_MECHANISM,
          })
        } catch {
          // 留痕失败不该把补派这个判决本身带崩（与 notifier 的 noteSeatDelivery 同一条纪律）。
          void 0
        }
        cur = await load(String(task.id ?? ''))
      }
    } finally {
      // ★ 用完即撤：机制身份只活在这一次补派里，不留在令牌表上。
      ident.revoke()
    }
    if (failed.length > 0) {
      lines.push('★ 通道不可达时**不静默降级**（越界清单第 13 条）：上面 `✗` 那几行是**失败原文**。' +
        '等价可达路径：`pipeline_dispatch { task_id, role }` 由主对话手工补派，或 `reassign: true` 重派同一席位。')
    }
    return { ok: failed.length === 0, task: cur ?? task, spawned, failed, lines, mechanism: ident.token === null ? null : HUB_SEAT_MECHANISM }
  }

  return { ensureHubSeats }
}
