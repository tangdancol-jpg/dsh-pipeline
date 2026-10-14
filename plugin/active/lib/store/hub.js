/**
 * dsh-pipeline · 任务存储 · 主管枢纽判据
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/hub
 */

import {
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_HANDOFF_CONFIRM_STATIONS,
  HUB_REJECT_EVENT_STATIONS,
  HUB_STANDBY_SEATS,
  HUB_STATIONS,
  HUB_STATION_REJECT_BUDGET,
  HUB_STATION_REJECT_STATIONS,
  HUB_WAKE_POINTS,
  hubConfirmersOf,
  hubWakePointOf,
} from '../states.js'
import { roleLabel } from '../roles.js'
import { nowIso } from '../util.js'

/**
 * 任务存储 · 主管枢纽判据
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function createStoreHub(ctx) {
  const { now, deny, currentArtifactVersion, lastHandoff } = ctx

  // =========================================================================
  // ★★ 主管枢纽（T-20261011-56a37e）—— 判据的公共读面
  // =========================================================================
  //
  // 这一小段**只读**：把"任务上那份枢纽账本"读成几个纯函数，供各个 guard 复用。
  // 它刻意不新造任何数据源 —— 账本只有一个（`task.hub`），写它只有一处
  // （`hub_initiate` 那一跳）。
  //
  // ★ 与四类不变量的关系：这里判的每一条都落在**既有**的守卫开关
  //   （`checkPrecondition` 的 switch）与**既有**的交接物状态判据上，
  //   没有第二个执法层、没有第二份名单。

  /** 任务上的枢纽账本（没启用时是 `null`）。 */
  function hubOf(task) {
    const h = task?.hub
    return h !== null && typeof h === 'object' && !Array.isArray(h) ? h : null
  }

  /** 枢纽是否已启用。★ 未启用 ⇒ 所有枢纽判据**弃权**（既有链一个字节不变）。 */
  function hubEnabled(task) {
    return hubOf(task)?.enabled === true
  }

  /** 待机名册（`[{role, wake_point, group, status, ...}]`）。 */
  function hubStandby(task) {
    const list = hubOf(task)?.standby
    return Array.isArray(list) ? list : []
  }

  /** 某席位的待机条目；没登记返回 `null`。 */
  function hubStandbyOf(task, role) {
    return hubStandby(task).find((s) => s?.role === role) ?? null
  }

  /**
   * ★ **待机期的产物面判据**（安全预审阻断项 B3 的第 1 条：交接物面）。
   *
   * 已登记待机、且**还没到唤醒点**的席位 ⇒ 不许产出自己那一类产物。
   * 不在待机名单里的角色、以及没启用枢纽的任务 ⇒ 直接放行（弃权，不是放宽）。
   *
   * @returns {{ok:true} | {ok:false, entry:object, wakePoint:string}}
   */
  function hubStandbyBlocks(task, role) {
    if (!hubEnabled(task)) return { ok: true }
    const wp = hubWakePointOf(role)
    if (wp === null) return { ok: true }
    const e = hubStandbyOf(task, role)
    if (e === null) return { ok: true }
    if (e.status === 'woken') return { ok: true }
    return { ok: false, entry: e, wakePoint: wp }
  }

  /**
   * 「最近一次打回」在 `task.handoffs` 里的下标（-1 = 从没打回过）。
   * 与 `effectiveReviewOk` 用的是**同一个形状**（打回即作废）—— 不另起一套。
   *
   * ★★ T-20261011-56a37e 补齐：**「否掉」也是打回的一种**。
   *
   *   主管在某一站说"这份产物不算数"（`station_confirm{decision:'ng'}`），与
   *   测试/审核打回是**同一件事**：它之前的确认全部作废，必须重新确认。
   *   没有这一条，「否掉」就是个空转 —— 被否掉之后，旧的确认记录还留在盘上、
   *   还绑着同一个目标，确认方一"点头"就又能推进，等于否掉没发生过。
   *
   *   ★ 为什么复用的是**同一张 `station_confirm` 交接物**而不是新开一个 kind：
   *     确认与否掉是同一件事的两个方向（schema 里 `decision` 本来就写着 `['ok','ng']`），
   *     同一张 schema 就自动继承了同一套形态判据 —— **证据标识 ≥ 1 条**（`basis_refs`）
   *     与 `reason` 都是 `required` ⇒ "否掉必须带证据、不许静默"由**既有校验器**保证，
   *     不需要（也不许）另写一套。
   */
  function lastReworkIndex(task) {
    let at = -1
    for (let i = 0; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind === 'test_to_dev') at = i
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'NG') at = i
      // ★ 否掉 = 打回：它之前的确认全部作废（见上面那段说明）。
      if (h.kind === 'station_confirm' && h.payload?.decision === 'ng') at = i
    }
    return at
  }

  /**
   * ★★ 某站点的**否掉记录**（主管或需求位交上来的 `station_confirm{decision:'ng'}`，
   *   按提交顺序，含未绑定当前目标的那些 —— 只读导出要用"全部"）。
   */
  function hubRejectRecords(task, station) {
    const out = []
    for (const h of task.handoffs) {
      if (h.kind !== 'station_confirm') continue
      if (h.payload?.station !== station) continue
      if (h.payload?.decision !== 'ng') continue
      out.push(h)
    }
    return out
  }

  /**
   * ★★ 某站点**当前有效的否掉记录** —— 形态与 `hubValidConfirms` **逐项对称**，
   *   只是方向相反（`decision='ng'`）：
   *     ① 是 `station_confirm`；② `station` 正是这一站；③ `decision === 'ng'`；
   *     ④ `artifact_version` 等于该站**当前的目标**（否掉也要说清"否的是哪一份"）；
   *     ⑤ 取**最后一条**（"最新的那次判断"说了算）。
   *
   * ⚠️ 与 `hubValidConfirms` 的一处**有意**不同：这里不再套 `lastReworkIndex` 窗口。
   *   原因：否掉记录**自己就是**窗口的起点（上一段），再用窗口过滤会把记录本身滤掉。
   *   "取最后一条 + 必须绑当前目标"这两条合起来已经保证了它说的是**当前这一份**。
   */
  function hubLatestValidReject(task, station, fromRole = null) {
    const target = hubStationTarget(task, station)
    if (target === null) return null
    let hit = null
    for (const h of hubRejectRecords(task, station)) {
      if (h.payload?.artifact_version !== target) continue
      if (fromRole !== null && h.from_role !== fromRole) continue
      hit = h
    }
    return hit
  }

  /**
   * ★★ **否掉预算**（四个站点各自的额度；见 `states.js` 的 `HUB_STATION_REJECT_BUDGET`）。
   *
   * 判据与 ② 道的 `hub_diagram_rework_budget` **同一套口径**：用尽 ⇒ 拒，
   * 并在拒绝原文里指名唯一出路 —— 走**既有的**两级梯升给用户
   * （`pipeline_supervise action=escalate_user` → `human_request`），不是第二套通道。
   *
   * @returns {{ok:true, station:string, used:number} | {ok:false, code:string, error:string}}
   */
  function hubRejectBudget(task, station) {
    if (station === '' || station === null || station === undefined) {
      return deny(
        'HUB_REJECT_UNKNOWN_STATION',
        '拒绝：认不出这是**哪一站**的否掉动作 —— 它必须挂在五道站点里的某一站上。\n' +
          `可用的站点：${HUB_STATION_REJECT_STATIONS.join(' / ')}（①道 need_agree / ③道 test_confirm / ④道 review_confirm）。`,
      )
    }
    if (hubConfirmersOf(station).length === 0) {
      return deny(
        'HUB_REJECT_NOT_A_STATION',
        `拒绝：站点「${station}」**不是确认站点**（它没有确认方），因此没有"否掉"这条分支。\n` +
          '★ 五道站点里第⑤道（关单并交付用户）是**交付**步骤、不是确认闸门 —— ' +
          '它没有确认方、也不产出确认记录（用户那句里的"确认"落在第④道）。\n' +
          `有否掉回边的站点：${HUB_STATION_REJECT_STATIONS.join(' / ')}。`,
      )
    }
    if (!hubEnabled(task)) {
      // ★ ①③④ 的三条回边**有两站落在与既有链共用的状态上**（`ready_review` / `passed`），
      //   所以这里必须显式弃权，否则等于给既有链凭空加了一条"主管退回"的路。
      return deny(
        'HUB_NOT_ENABLED',
        `拒绝：任务 ${task.id} 没有启用主管枢纽，站点「${station}」的否掉回边不属于它当前走的链。\n` +
          '★ 与既有的测试/审核打回（`pipeline_rework`）是两件事：那两条既有链**一个字节没动**。',
      )
    }
    const used = Number.isInteger(hubOf(task)?.station_rejects?.[station]) ? hubOf(task).station_rejects[station] : 0
    if (used >= HUB_STATION_REJECT_BUDGET) {
      return deny(
        'HUB_STATION_REJECT_EXHAUSTED',
        `拒绝：第${stationLabel(station)}的**否掉预算已用尽**（已用 ${used} / 上限 ${HUB_STATION_REJECT_BUDGET}）。\n` +
          '★ 与②道架构图重画同一套口径：「不满足 ⇒ 退回重做，**限 1 次**；再不行**升给用户**定」。\n' +
          '  无限退回会把"站点确认"退化成一道空转的闸。\n' +
          '下一步（唯一）：主管调 pipeline_supervise action=escalate_user 走**既有的**两级梯\n' +
          '  （human_request → 主对话转告 → 用户答复），把这件事交给人定。',
      )
    }
    return { ok: true, station, used }
  }

  /**
   * ★ 某站点**该绑哪个目标**（第①②道绑结论/图的交接物 id，第③④道绑制品版本）。
   *
   * ★ P0-1：②b / ②c 两个确认点确认的是**同一份架构图** —— 与第②道**同一个目标**
   *   （`architecture_diagram` 的最新一份 handoff_id）。于是三者的确认都绑在同一份图上，
   *   "换了一张图之后旧的点头还算不算数"由既有规则回答（打回即作废 / 目标对不上即作废）。
   */
  function hubStationTarget(task, station) {
    if (station === HUB_STATIONS.NEED_AGREE) {
      const h = lastHandoff(task, 'requirement_analysis')
      return h === null ? null : h.handoff_id
    }
    if (
      station === HUB_STATIONS.DIAGRAM_CONFIRM ||
      station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ||
      station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM
    ) {
      const h = lastHandoff(task, 'architecture_diagram')
      return h === null ? null : h.handoff_id
    }
    return currentArtifactVersion(task)
  }

  /**
   * ★★ 某站点的**有效确认记录**。
   *
   * 有效性五要素（照抄 `effectiveReviewOk` 的强度，安全预审「准入判据形态」）：
   *   ① 是 `station_confirm` 交接物；② `station` 字段**正是这一站**（不许跨站复用）；
   *   ③ `decision === 'ok'`；④ `artifact_version` 等于**该站当前的目标**（绑版本）；
   *   ⑤ 落在**最近一次打回之后**（打回即作废）。
   *
   * @returns {object[]} 按 `from_role` 各自最多一条（同角色重复确认按最后一条算）
   */
  function hubValidConfirms(task, station) {
    const target = hubStationTarget(task, station)
    if (target === null) return []
    const from = lastReworkIndex(task) + 1
    const out = new Map()
    for (let i = from; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind !== 'station_confirm') continue
      if (h.payload?.station !== station) continue
      if (h.payload?.decision !== 'ok') continue
      if (h.payload?.artifact_version !== target) continue
      out.set(h.from_role, h)
    }
    return [...out.values()]
  }

  /**
   * ★★ 站点闸：确认方**齐备**才放行，缺谁就指名缺谁。
   *
   * @returns {{ok:true, confirms:object[], target:string} | {ok:false, code:string, error:string}}
   */
  function hubStationGate(task, station) {
    const need = hubConfirmersOf(station)
    const target = hubStationTarget(task, station)
    if (target === null) {
      const what =
        station === HUB_STATIONS.NEED_AGREE
          ? '需求分析结论（requirement_analysis）'
          : station === HUB_STATIONS.DIAGRAM_CONFIRM ||
              station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM ||
              station === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM
            ? '架构图（architecture_diagram）'
            : '编写制品（dev_to_test）'
      return deny(
        'HUB_STATION_NO_TARGET',
        `拒绝推进：第${stationLabel(station)}道确认要确认的是「${what}」，而任务 ${task.id} 里还没有它 —— 没有可确认的对象。`,
      )
    }
    const confirms = hubValidConfirms(task, station)
    const got = confirms.map((h) => h.from_role)
    const missing = need.filter((r) => !got.includes(r))
    if (missing.length > 0) {
      const dual = need.length >= 2
      return deny(
        dual && got.length > 0 ? 'HUB_DUAL_CONFIRM_INCOMPLETE' : 'HUB_STATION_NOT_CONFIRMED',
        `拒绝推进：第${stationLabel(station)}道${dual ? '**双**' : ''}确认还**没有齐备**。\n` +
          `需要确认方：${need.map(roleLabel).join(' + ')}（共 ${need.length} 方）\n` +
          `已有确认：${got.length === 0 ? '（一份都没有）' : got.map(roleLabel).join(' + ')}\n` +
          `**还缺**：${missing.map(roleLabel).join(' + ')}\n` +
          `绑定目标：${target}\n` +
          '★ 用户口径⑥：站点确认**全部是硬闸门** —— 少一道就走不到下一步。\n' +
          (dual
            ? '★ 用户原话里的第③④道是「主管 + 需求」**双确认**：\n' +
              '  只有一方确认**不能**推进。两份确认必须是**两份各自令牌产出**的 station_confirm 记录\n' +
              '  （一份记录里写两个布尔字段是可以伪造的，不算数），两者绑定**同一个**目标且都在最近一次打回之后。\n'
            : '') +
          '下一步：' +
          (dual
            ? '主管调 pipeline_supervise action=confirm_station（需求位那一份用 pipeline_handoff kind=station_confirm）。'
            : '主管调 pipeline_supervise（站点确认是它的具名动作）。'),
      )
    }
    return { ok: true, confirms, target }
  }

  /** 站点中文名（拒绝原文里要指名"这是第几道"）。 */
  function stationLabel(station) {
    return (
      {
        [HUB_STATIONS.NEED_AGREE]: '①道（需求结论 → 主管同意）',
        [HUB_STATIONS.DIAGRAM_CONFIRM]: '②道（架构图 → 主管确认）',
        [HUB_STATIONS.TEST_CONFIRM]: '③道（测试通过 → 主管+需求位双确认）',
        [HUB_STATIONS.REVIEW_CONFIRM]: '④道（审核通过 → 主管+需求位双确认）',
        [HUB_STATIONS.CLOSEOUT]: '⑤道（主对话关单交付用户）',
        /** ★ P0-1：架构图交接计划位之前的两道确认点（用户新口径第 7~8 跳）。 */
        [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM]: '②b 确认点（架构图 → 需求位确认）',
        [HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM]: '②c 确认点（架构图 → 主管**二次**确认）',
      }[station] ?? `(${station})道`
    )
  }

  /** 待机期被拦时的拒绝原文（交接物面 / 文件面 / 测试面共用一份措辞）。 */
  function renderStandbyBlock(task, entry, wakePoint, what) {
    const woken = hubStandby(task).filter((s) => s?.wake_point === wakePoint && s?.status === 'woken').map((s) => s.role)
    return deny(
      'HUB_STANDBY_NOT_WOKEN',
      `拒绝：席位「${roleLabel(entry?.role)}」现在处于**已登记待机**，还没到唤醒点 —— ${what}。\n` +
        `任务：${task.id}　待机登记：${entry?.registered_at ?? '(见 task.hub.standby)'}\n` +
        `它的唤醒点：**${wakePoint === HUB_WAKE_POINTS.NEED_AGREE ? '主管同意需求结论' : '主管确认架构图满足要求'}**（${wakePoint}）\n` +
        `该唤醒点已唤醒：${woken.length > 0 ? woken.map(roleLabel).join(' / ') : '（还没有席位被唤醒）'}\n` +
        '★ 用户口径③：「待机」是**可见的「已登记未开工」** —— 而"未到点不得开工"必须是**产物面**的判据，\n' +
        '  不是一句提醒。这条判据与承接它的另两条同源：交接物面（本处）/ 文件面（守门 own-dir）/ ' +
        '测试执行面（守门测试命令）。缺任一条，"叫醒即抢跑"就还留着通路。\n' +
        '下一步：等主管在**到点**之后发起唤醒（pipeline_supervise action=agree_need / confirm_diagram）。',
    )
  }

  /**
   * ★★ 主管枢纽账本的**唯一写点**（T-20261011-56a37e）。
   *
   * 什么时候写什么，全部由**事件名**决定（不靠调用方自觉传参）：
   *   · `supervisor_initiate`        ⇒ 建账本（enabled=true）+ 按 `HUB_STANDBY_SEATS`
   *                                     逐席登记「已登记待机」（这就是"待机要能看出来"的数据面）
   *   · `supervisor_agree_need`      ⇒ **唤醒点 A**：把该唤醒点下的席位标成 woken
   *   · `supervisor_confirm_diagram` ⇒ **唤醒点 B**：把计划位标成 woken
   *   · `supervisor_reject_diagram`  ⇒ 重画计数 +1（预算见 HUB_DIAGRAM_REDRAW_BUDGET）
   *
   * ⚠️ 它**只写账本**，不判任何东西 —— 判定在 `checkPrecondition` 的 guard 里
   *   （判与写分开，才不会出现"判过了但没写"的中间态）。
   *
   * @param {object} task
   * @param {string} event
   * @param {string} to
   * @param {object} input
   */
  function applyHubSideEffects(task, event, to, input) {
    const actor = input?.actorRole ?? ''
    /**
     * ★★ P0-1 **入口**：主对话把任务递给主管（用户新口径第 1 跳）。
     *
     * 它**不建待机名册**（"主管拉起三席"是主管 `initiate` 的活，用户原话的顺序就是这样），
     * 只落一件事实：**谁在什么时候把这张单交给了主管**（`hub.entry`）。
     *
     * ⚠️ `enabled` 刻意保持 `false`：枢纽的"启用"以**主管真的发起**为准。
     *   若在这里就把 enabled 置真，`hub_initiate` 的"已发起"判据会被自己骗过去
     *   （改前那条判据看的就是 enabled）—— 那会让主管的发起变成空操作。
     *   而"递单之后主对话不许再自己派需求位"这件事由 `hub_initiate_required`
     *   的第二个触发面负责（它读的就是 `hub.entry`）。
     */
    if (event === 'handoff_to_supervisor') {
      const at = nowIso(now())
      const prev = hubOf(task) ?? {}
      task.hub = {
        ...prev,
        enabled: false,
        entry: {
          by: actor,
          at,
          via: input?.via ?? 'pipeline_transition',
          note: String(input?.note ?? ''),
        },
        standby: [],
      }
      return
    }
    if (event === 'supervisor_initiate') {
      const at = nowIso(now())
      task.hub = {
        enabled: true,
        initiated_by: actor,
        initiated_at: at,
        initiated_via: input?.via ?? 'pipeline_supervise',
        /**
         * ★ P0-1：**入口留痕随发起一起带过去**（不许被发起覆盖掉）。
         *   "谁把单递给主管的"与"谁发起的"是两条都必须可追溯的事实：
         *   改前 `task.hub` 是整体重建，一旦有入口这条就会被抹掉。
         */
        entry: hubOf(task)?.entry ?? null,
        standby: HUB_STANDBY_SEATS.map((s) => ({
          role: s.role,
          group: s.group,
          wake_point: s.wake_point,
          /** ★ 可观测的「已登记未开工」：状态只有这两个取值。 */
          status: 'standby',
          registered_at: at,
          registered_by: actor,
          woken_at: null,
          woken_by: null,
        })),
        diagram_redraws: 0,
        redraw_budget: HUB_DIAGRAM_REDRAW_BUDGET,
        /**
         * ★★ **站点否掉的计数与留痕**（T-20261011-56a37e 补齐）。
         * 与 `diagram_redraws` 同形：计数按站点分开（各自独立额度），
         * `reject_history` 逐条记「哪一站 · 谁 · 什么时候 · 为什么 · 退到哪」——
         * 这就是"否掉也**不许静默**"的数据面（`pipeline_status` 的 hub 一节直接读回）。
         */
        station_rejects: Object.fromEntries(HUB_STATION_REJECT_STATIONS.map((st) => [st, 0])),
        reject_budget: HUB_STATION_REJECT_BUDGET,
        reject_history: [],
        wakes: [],
      }
      return
    }
    if (!hubEnabled(task)) return

    /** 唤醒某个唤醒点下的**全部**待机席位（幂等：已唤醒的不重复记）。 */
    const wakePoint = (wp, note) => {
      const at = nowIso(now())
      let n = 0
      for (const e of hubStandby(task)) {
        if (e?.wake_point !== wp || e?.status === 'woken') continue
        e.status = 'woken'
        e.woken_at = at
        e.woken_by = actor
        n += 1
      }
      task.hub.wakes = Array.isArray(task.hub.wakes) ? task.hub.wakes : []
      task.hub.wakes.push({ wake_point: wp, at, by: actor, woken: n, note: String(note ?? ''), to_state: to })
      return n
    }

    if (event === 'supervisor_agree_need') {
      // ★ **唤醒点 A**：主管同意需求结论 ⇒ 架构位（architect / diagrammer）到点开工。
      wakePoint(HUB_WAKE_POINTS.NEED_AGREE, '主管同意需求结论')
      return
    }
    if (event === 'supervisor_confirm_diagram') {
      /**
       * ★★ P0-1：**唤醒点 B 从这里搬到了主管的"二次确认"那一跳**。
       *
       * 用户新口径是「架构图完成 → 主管确认（转交需求位）→ **需求位确认** →
       *   **主管二次确认** → **无问题后**才把架构图递交计划位」。
       * 既然计划位的开工必须排在**二次确认之后**，唤醒点 B 就只能挂在那一跳上 ——
       * 挂在这里会让计划位在需求位还没确认时就开工（"叫醒即抢跑"）。
       *
       * ★ 唤醒点本身（常量、待机名册、产物面判据）一个字没动，只是**触发它的那一跳**变了。
       * ★ 这一跳现在是"主管把架构图**转交需求位**"（`arch_confirm → arch_need_confirm`），
       *   它**不叫醒任何席位** —— 需求位本来就在册、本来就在干活，不需要"到点才动"。
       */
      return
    }
    if (event === 'supervisor_reconfirm_diagram') {
      // ★ **唤醒点 B**：主管**二次**确认（无问题）⇒ 计划位到点开工。
      wakePoint(HUB_WAKE_POINTS.DIAGRAM_CONFIRM, '主管二次确认架构图满足要求')
      return
    }
    if (event === 'supervisor_reject_diagram') {
      task.hub.diagram_redraws = (Number.isInteger(task.hub.diagram_redraws) ? task.hub.diagram_redraws : 0) + 1
      task.hub.redraw_history = Array.isArray(task.hub.redraw_history) ? task.hub.redraw_history : []
      task.hub.redraw_history.push({ at: nowIso(now()), by: actor, reason: String(input?.note ?? '') })
      return
    }
    // ★★ **站点否掉的账本**（T-20261011-56a37e 补齐）—— 与上面那条同形：
    //   **由事件名决定写什么**（不靠调用方自觉传参），并且**只写账本、不判任何东西**
    //   （判定在 `checkPrecondition` 的 `hub_station_reject_budget` / `hub_station_reject` 里；
    //   判与写分开，才不会出现"判过了但没写"的中间态）。
    const rejectStation = HUB_REJECT_EVENT_STATIONS[String(event ?? '')]
    if (rejectStation !== undefined) {
      const cur = task.hub.station_rejects !== null && typeof task.hub.station_rejects === 'object' && !Array.isArray(task.hub.station_rejects)
        ? task.hub.station_rejects
        : {}
      cur[rejectStation] = (Number.isInteger(cur[rejectStation]) ? cur[rejectStation] : 0) + 1
      task.hub.station_rejects = cur
      task.hub.reject_history = Array.isArray(task.hub.reject_history) ? task.hub.reject_history : []
      task.hub.reject_history.push({
        station: rejectStation,
        at: nowIso(now()),
        by: actor,
        reason: String(input?.note ?? ''),
        /** ★ 退回哪儿（就是这一跳的落点）—— "否掉之后去哪儿"要能一眼读出来。 */
        back_to: to,
      })
    }
  }

  /**
   * 找到"当前这一轮"有效的审核 OK。
   *
   * 有效 = 结论 OK 且 artifact_version 等于当前有效制品版本，且**在最近一次
   * 打回之后**（打回会把上一轮的 OK 作废 —— 否则改完代码还能拿旧 OK 关单）。
   *
   * @returns {object|null}
   */
  function effectiveReviewOk(task) {
    const version = currentArtifactVersion(task)
    if (version === null) return null
    let lastReworkAt = -1
    for (let i = 0; i < task.handoffs.length; i++) {
      const h = task.handoffs[i]
      if (h.kind === 'test_to_dev' || h.kind === 'review_verdict_ng') lastReworkAt = i
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'NG') lastReworkAt = i
    }
    for (let i = task.handoffs.length - 1; i > lastReworkAt; i--) {
      const h = task.handoffs[i]
      if (h.kind === 'review_verdict' && h.payload?.conclusion === 'OK' && h.artifact_version === version) return h
    }
    return null
  }

  return {
    hubOf,
    hubEnabled,
    hubStandby,
    hubStandbyOf,
    hubStandbyBlocks,
    hubRejectRecords,
    hubLatestValidReject,
    hubRejectBudget,
    hubStationTarget,
    hubValidConfirms,
    hubStationGate,
    stationLabel,
    renderStandbyBlock,
    applyHubSideEffects,
    effectiveReviewOk,
  }
}
