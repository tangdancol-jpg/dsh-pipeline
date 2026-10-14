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
import { DEFAULT_SEAT_SILENCE_MS, describeSilentSeats, nextActionsFor, seatLiveness } from '../liveness.js'
import { DISPATCH_SLOT_KEYS } from '../transport/index.js'
import { clamp } from '../util.js'
import { S, SNullable, tool, resolveActor } from './kit.js'

/**
 * 状态查询与速查（pipeline_status）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildStatusTools(ctx) {
  const { deps, store, indexTask, load, paginate } = ctx

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
      review_ok: res.review_ok === null || res.review_ok === undefined ? null : res.review_ok.artifact_version,
    }
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
      ` · 席位 ${c.seats}（失联 ${c.silent_seats}）` +
      ` · 授权面 ${c.change_scope === null ? '无' : `${c.change_scope} 条`} / 实际改动 ${c.change_manifest} 处`
    if (mode === 'count') {
      return [
        head,
        `卡点 ${blockers.length} 个：${blockers.length === 0 ? '无' : blockers.join('；')}`,
        `下一步该谁（主链）：${owners.main.length === 0 ? '（无 —— 终态）' : owners.main.map((o) => o.who).join('、')}` +
          `${owners.side_events.length === 0 ? '' : `　侧路可提：${owners.side_events.join(' / ')}`}`,
        countLine,
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
      detail: S('string', '★ 输出档（**不传 = 与改前逐字节相同**）：summary = 紧凑档（状态 + 卡点 + 下一步该谁 + 算好的计数）｜count = 只回结论与计数｜full = 现状全文', { enum: ['summary', 'count', 'full'] }),
      fields: S('array', '★ 只回**点名的字段**（投影，省字节）：如 ["state","hash_gate","liveness"]；`ok` 永远保留。不传 = 回人读摘要', { items: { type: 'string' } }),
      page: S('number', '★ 分段取长清单（1 起；不传 = 不分页，与改前一致）。截断时摘要里会写明 page/total 与下一段怎么取'),
      role_token: S('string', '角色令牌（查询也建议带上，便于按角色脱敏）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '可直接阅读的状态报告'),
      /** ★ 哈希前置闸门：连续不通过计数 + 自动交人工（升级未了结时拒收新提交）。 */
      hash_gate: SNullable('object', '★ 哈希前置闸门视图 { blocked, streak, threshold, accepting_submissions, checks, escalation }', { additionalProperties: true }),
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
        const escalatedIds = []
        const silenceMs =
          Number.isInteger(deps.config?.seatSilenceMs) && deps.config.seatSilenceMs > 0
            ? deps.config.seatSilenceMs
            : DEFAULT_SEAT_SILENCE_MS
        for (const row of list) {
          const t = await load(row.id)
          if (t === null) continue
          if (!Array.isArray(t.dispatched) || t.dispatched.length === 0) continue
          const lv = seatLiveness(t, Date.now(), { silenceMs })
          if (lv.silent.length === 0) continue
          let note = '（只报告，未处置）'
          if (deps.config?.seatLivenessEscalate === true) {
            const r = await store.checkLiveness(row.id, { escalate: true })
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
          if (orphanLines !== '') L.push(orphanLines)
          L.push('', '★ 要逐条正文用 `detail="full"`（或干脆不传 detail，与改前一致）。')
          return {
            ok: true,
            summary: L.join('\n'),
            liveness: swept.length === 0 ? null : { ok: false, silence_ms: silenceMs, swept: swept.length, escalated: escalatedIds },
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
            orphanLines,
          liveness: swept.length === 0 ? null : { ok: false, silence_ms: silenceMs, swept: swept.length, escalated: escalatedIds },
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

      // ★ **席位失联视图**（读时暴露，**只报告不处置** —— 这个工具是只读的）。
      //
      //   处置（自动推到「已阻塞」）在 `tools/pre-execute` 那条缝上做，见 lib/intercept.js。
      //   为什么这里也报：主对话查状态是最自然的动作，而"任务停在需求分析中、
      //   交接物 0 份"这句话本身**看不出**是"它还在想"还是"它已经死了"——
      //   失联视图补的就是这一个比特。
      const liveTask = await load(taskId)
      const liveSilenceMs =
        Number.isInteger(deps.config?.seatSilenceMs) && deps.config.seatSilenceMs > 0
          ? deps.config.seatSilenceMs
          : DEFAULT_SEAT_SILENCE_MS
      let live = liveTask === null ? null : seatLiveness(liveTask, Date.now(), { silenceMs: liveSilenceMs })

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
        const r = await store.checkLiveness(taskId, { escalate: true })
        if (r.ok === true) {
          if (r.task !== undefined && r.task !== null) indexTask(r.task.id, r.task)
          handled = r
          live = r.live ?? live
        }
      }
      const liveLines =
        live === null || live.seats.length === 0
          ? []
          : [
              live.silent.length === 0
                ? `席位：已派 ${live.seats.length} 个，均**无失联**（静默阈值 ${live.silence_zh}）`
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
            ]

      /**
       * ★★ **E 路 ②：紧凑档（`detail: "summary" | "count"`）**。
       *
       * ★ 只换**正文**，不换任何结构化字段、不换判据、不换脱敏口径 ——
       *   下面那个 return 一个字没动（紧凑档与全文档返回的是同一个形状）。
       * ★ `detail` 缺省 / `"full"` ⇒ `isBrief === false` ⇒ **原路，逐字节不变**。
       */
      const briefMode = typeof args.detail === 'string' ? String(args.detail) : ''
      const isBrief = briefMode === 'summary' || briefMode === 'count'
      /** ★ 显式给了 `page` 才分页（不传 ⇒ 与改前逐字节一致；紧凑档自己给计数，不分页）。 */
      const handoffPage = !isBrief && args.page !== undefined && args.page !== null ? paginate(res.handoffs, args.page) : null
      const lines = isBrief
        ? [renderStatusBrief(res, live, { mode: briefMode })]
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
        `打回计数：编写 ${res.rework.dev}/${res.rework.budget}，测试 ${res.rework.test}/${res.rework.budget}`,
        // ★ 哈希前置闸门的可见面（P13 之后它多了一半内容：连续计数 + 自动交人工）
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
        `交接物（${res.handoffs.length} 份）：`,
        ...(res.handoffs.length === 0
          ? ['  （无）']
          : (handoffPage === null ? res.handoffs : handoffPage.slice).map((h) => `  [${h.kind_zh}] ${h.from_role}→${h.to_role}  ${h.artifact_version ?? '-'}  ${h.handoff_id}`)),
        // ★ E 路 ②：**分页只在显式给了 `page` 时才有**，且截断**必须**给出续页口径。
        handoffPage === null
          ? ''
          : `（交接物本段 ${handoffPage.page}/${handoffPage.pages}，共 ${handoffPage.total} 份` +
            `${handoffPage.more ? `；下一段：\`pipeline_status { task_id: "${taskId}", page: ${handoffPage.page + 1} }\`` : ''}）`,
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
        ...liveLines,
      ]

      /**
       * ★ E 路 ②：紧凑档**不追加**审计日志与完整交接物 —— 那正是它要省掉的部分
       *   （`detail` 与 `include_audit` / `full` 同时给时以 `detail` 为准：
       *    调用方已经明说"我要紧凑的"；要全文就 `detail="full"`）。
       */
      if (args.include_audit === true && !isBrief) {
        const log = await store.auditLog(taskId)
        lines.push('', `审计日志（${log.length} 条）：`, ...log.map((e) => `  ${e.at}  ${e.actor}  ${e.action}  ${clamp(JSON.stringify({ ...e, at: undefined, task_id: undefined, actor: undefined, action: undefined }), 200)}`))
      }

      if (args.full === true && !isMain && !isBrief) {
        lines.push('', '完整交接物：', '```json', JSON.stringify(res.handoffs, null, 2), '```')
      } else if (!isBrief && (isMain || actor.ok !== true)) {
        lines.push('', '（主对话看到的是脱敏摘要：补丁正文、失败日志正文、运行命令正文已隐去。）')
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
                /** 这次查状态时**机制是否已经自动处置**（推到「已阻塞」）。 */
                escalated: handled !== null && handled.escalated === true,
                /** ★ 主对话下一步可以**直接调**的动作（重派 / 换班 / 人工 / 取消）。 */
                next_actions: nextActionsFor(live.silent, { taskId }),
              },
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
      '        pipeline_human_relay / pipeline_human_reply / pipeline_status / pipeline_contacts',
      '执行角色：pipeline_bind_role / pipeline_handoff / pipeline_artifact / pipeline_record_submit /',
      '        pipeline_clarify_request / pipeline_clarify_reply / pipeline_human_request / pipeline_roster_request /',
      '        pipeline_context_report / pipeline_succession / pipeline_compile_requirement',
      '★ 给**既有席位**传话（催办 / 叫醒 / 停手）没有单独的工具：用 pipeline_dispatch { notify_only: true }。',
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
    ].join('\n'),
    roles: Object.values(ROLES).map((r) => `${r.id}\t${r.zh}\twrites=${r.writes}`).join('\n'),
    states: `状态机的合法事件一律用 pipeline_status 查（它读的就是 states.js 的同一份表）；当前状态的"下一步"写在返回里。`,
    liveness: [
      `失联判据四条同时成立：① 超过静默阈值（config.seatSilenceMs，默认 5 分钟）；② **轮到场了**（该它动）；`,
      `③ 台账里没有任何活着的证据（0 交接物 / 0 流水 / 0 水位自报 / 0 继任）；④ **会话日志也没在长**（${'session.v4.jsonl.zstd'} 的 size/mtime）。`,
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
