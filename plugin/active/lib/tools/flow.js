/**
 * dsh-pipeline · 交接、迁移、主管枢纽、打回、关单
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/flow
 */

import { HANDOFF_SCHEMAS } from '../handoff.js'
import { ROLE, roleLabel } from '../roles.js'
import {
  STATE_LABEL,
  HUB_STATIONS,
  HUB_STATION_REJECT_BUDGET,
  HUB_STATION_REJECT_EVENTS,
  HUB_WAKE_POINTS,
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_HANDOFF_CONFIRM_EVENTS,
  HUB_HANDOFF_CONFIRM_ORDER,
  HUB_HANDOFF_CONFIRM_STATIONS,
} from '../states.js'
// ★★ 长入参通道（`payload_path`）：字段说明的唯一出处在这儿，别在 schema 里另抄一份。
import { WAKE_ACTOR_MECHANISM } from '../wakeup/keys.js'
import { ARGS_FILE_DOC } from './args-file.js'
// ★★ 主管枢纽的**席位补派**（唤醒点要真的派人 + 缺位自愈）：判据与实现都在它里面。
import { HUB_SEAT_RESPAWN_HEAD } from './hub-seats.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 判据码的**唯一出处**（`lib/errors/`）：这里只**读**它做分流，产出方在 `store/review.js`。
import { HANDOFF_STEP_SKIPPED } from '../errors/codes.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { taskNotFound } from '../errors/text.js'

/**
 * ★ 哪几个主管动作**要顺带派人**（与"唤醒点"同源：到点了就得有人）。
 *
 *   `initiate`          ⇒ 需求位（发起它的就是这个枢纽）
 *   `agree_need`        ⇒ 唤醒点 A：架构位（architect / diagrammer）
 *   `reconfirm_diagram` ⇒ 唤醒点 B：计划位
 * ★ `confirm_diagram` **不在**其中：它只是"转交需求位"，不叫醒任何席位
 *   （见 `store/hub.js` 的 `applyHubSideEffects`）—— 需求位本来就在册。
 */
const HUB_SPAWN_ACTIONS = new Set(['initiate', 'agree_need', 'reconfirm_diagram'])

/**
 * 交接、迁移、主管枢纽、打回、关单
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildFlowTools(ctx) {
  const { deps, store, tokens, indexTask, nudgeSeat, load, hubSeats } = ctx

  // =========================================================================
  // 5. pipeline_handoff —— 提交结构化交接物
  // =========================================================================
  const handoff = tool(deps, {
    name: 'pipeline_handoff',
    mutating: true,
    /**
     * ★★ 长入参通道：`payload_path` 指一份 JSON，工具读它当交接物内容。
     *   `wrap: 'payload'` = 文件既可以写成 payload 的字段本身，也可以写成 `{payload:{…}}`。
     */
    argsFile: { field: 'payload_path', wrap: 'payload' },
    description:
      '提交一份**结构化交接物**，这是流水线上唯一的"交付"入口。每种类型有固定字段，缺字段会被拒。' +
      '方向由类型决定，不能自选：' +
      'dev_to_test（编写→测试：代码或补丁/变更说明/运行命令/自测结果/已知问题）；' +
      'test_to_review（测试→审核：测试用例/执行结果/失败日志/通过证据/风险说明）；' +
      'review_verdict（审核→主对话：结论 OK 或 NG/风险说明/是否放行/最终交付说明）；' +
      '以及 orchestration / design / security_review / release_plan / docs_note / perf_report / arbitration / human_note。' +
      '★ 编写不能直接提交审核 —— kind=review_verdict 只允许审核角色产出，状态机也不接受 开发中→待审核。' +
      '★★ **长中文正文一律走 `payload_path`（写进文件再传路径），不要内联** —— ' +
      '长段落（测试用例 / 失败日志 / 风险说明 / 验收证据…）内联时模型侧写坏参数 JSON 会让宿主判 ' +
      '`MALFORMED_RESPONSE` 并**作废整轮上下文**；写进文件则大段正文不经过工具参数（`kind` 仍内联）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      kind: S('string', '交接物类型', { enum: Object.keys(HANDOFF_SCHEMAS) }),
      payload_path: S('string', ARGS_FILE_DOC.payload_path),
      payload: S('object', '交接物内容（字段随 kind 而定，见工具描述）', { additionalProperties: true }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整的拒绝理由）'),
      handoff_id: S('string', '交接物 id（失败时为空串）'),
      kind_zh: S('string', '交接物中文名'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, handoff_id: '', kind_zh: '' }
      const kind = String(args.kind ?? '')
      const res = await store.submitHandoff({
        taskId: String(args.task_id ?? ''),
        kind,
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        payload: args.payload,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) {
        // ⚠️ **失败也要刷新同步索引**：哈希前置闸门在拒绝之前**已经**把状态写进任务
        //    （hash_gate.blocked）—— 不刷新的话守门看不到它，
        //    "闸门没过就不许跑测试"会静默失效。这是真踩过的坑。
        if (typeof res.task !== 'undefined' && res.task !== null) indexTask(res.task.id, res.task)
        else indexTask(String(args.task_id ?? ''), await load(String(args.task_id ?? '')))
        /**
         * ★★ **A13：被拒收的交付不许静默消失**（用户裁定：要么收，要么拒收但**可见且可查回原文**）。
         *
         * 现场：任务被机制冻住之后，席位仍在工作 —— 那 2 分钟里交的 `test_to_review`
         * 被「任务已阻塞」拒收。席位只拿到一句拒绝理由，主对话**什么都不知道**，
         * 内容是**彻底没了**（事后连"它当时交了什么"都查不回来）。
         *
         * 这里补的就是"留档 + 可见"两件事（**判据本身一个字没放宽** ——
         * 状态机照样拒收，`checkHandoffAgainstState` 一个字没动）：
         *   ① 把这次交付的**完整提交内容**追进任务数据（`rejected_deliveries[]`），
         *      给一个可查回的 `delivery_id`；
         *   ② 往主对话**播报**一条（走既有的唤醒通道，类别 `delivery-rejected`）——
         *      它**不是**"交付成功"，正文里写死"这条**没有**被接收"。
         */
        let archived = null
        const waiting = ['awaiting_human', 'awaiting_clarification', 'blocked'].includes(String(res.task?.state ?? ''))
        if (waiting || String(res.code ?? '') === HANDOFF_STEP_SKIPPED) {
          try {
            archived = await store.archiveRejectedDelivery(String(args.task_id ?? ''), {
              kind,
              code: String(res.code ?? ''),
              reason: String(res.error ?? ''),
              fromRole: actor.role,
              fromSeat: actor.seat ?? null,
              payload: { kind, payload: args.payload ?? null, actor_role: actor.role, actor_seat: actor.seat ?? null },
            })
            if (archived.ok === true) indexTask(archived.task.id, archived.task)
          } catch (err) {
            store.warn?.(`[pipeline] 归档被拒收的交付失败（拒绝判决本身不受影响）：${String(err?.message ?? err)}`)
          }
          // ★ 播报（失败不抛：唤醒是副作用，拒绝判决才是正事）。
          //   ★ §9 噪声 ②③（2026-10-17）：actor 是**机制**（类别也已进 MECHANISM_NOTICE_KINDS）——
          //     这条是"没有被接收"的结论，不是一份等人接管的交付；不这样它会被巡检再报、被升级链再升。
          //     提交方照样写进正文（谁交的一眼可见）。
          try {
            const submitter = `${roleLabel(actor.role)}（${actor.role}${actor.seat ? `#${actor.seat}` : ''}）`
            await deps.wakeup?.wake?.({
              taskId: String(args.task_id ?? ''),
              actorRole: WAKE_ACTOR_MECHANISM,
              actorSeat: null,
              kind: 'delivery-rejected',
              what: `${submitter}提交的**交接物被拒收**（${HANDOFF_SCHEMAS[kind]?.zh ?? kind}）—— 这条**没有**被接收，但内容已留档`,
              disc: String(archived?.delivery_id ?? ''),
              identitySource: 'rejected-delivery-record',
              task: archived?.task ?? res.task ?? null,
              note:
                `拒收原因：${String(res.code ?? '')}\n${String(res.error ?? '')}\n` +
                `★ 原文已留档（delivery_id=${String(archived?.delivery_id ?? '(归档失败)')}）：${String(archived?.delivery?.recall ?? '')}`,
              via: 'delivery-rejected',
            })
          } catch (err) {
            store.warn?.(`[pipeline] 播报"交付被拒收"失败（拒绝判决本身不受影响）：${String(err?.message ?? err)}`)
          }
        }
        return {
          ok: false,
          summary:
            `${res.error}\n` +
            (archived !== null && archived.ok === true
              ? `★ 这条交付**没有**被接收，但**内容已留档**（delivery_id=${archived.delivery_id}）—— 主对话已收到一条"交付被拒收"的播报，你**不需要**重发一份：等窗口过去之后再决定要不要重交。\n`
              : ''),
          handoff_id: '',
          kind_zh: HANDOFF_SCHEMAS[kind]?.zh ?? kind,
        }
      }
      indexTask(res.task.id, res.task)

      /**
       * ★★ **测试提前知情：内容要真的交到测试位手里**（T-20261011-56a37e）。
       *
       * 用户口径③的原话是「**内容提前交到测试位手里**」—— 只把交接物落盘、
       * 测试位却不知道有这东西，等于"提前登记"而不是"提前交付"。
       * 这里走**既有**的投递通道（`nudgeSeat` → `transport.notifyRole`），不新开通道。
       *
       * ★ 消息正文里**不含编写的产物**：它引用的只是预登记本身的字段
       *   （要测什么、按哪几条验收、还缺什么）—— 那正是 `prebrief` 的形状判据保证的事。
       * ★ 投不出去**不静默**：失败原文进 summary，并给出等价可达路径。
       */
      let prebriefLine = ''
      if (kind === 'prebrief') {
        const p = res.handoff.payload ?? {}
        const body =
          `【流水线 · 任务内容预登记】计划位把**要测什么**提前交到你手里了（${res.handoff.handoff_id}）。\n` +
          `任务：${res.task.id}　依据的计划：${p.plan_handoff_id ?? '(见交接物)'}\n` +
          `要测的：\n${(Array.isArray(p.assigned_scope) ? p.assigned_scope : []).map((x) => `  · ${x}`).join('\n')}\n` +
          `对应验收：\n${(Array.isArray(p.acceptance_refs) ? p.acceptance_refs : []).map((x) => `  · ${x}`).join('\n')}\n` +
          `现在还拿不到的：\n${(Array.isArray(p.not_yet_available) ? p.not_yet_available : []).map((x) => `  · ${x}`).join('\n')}\n` +
          `开工闸：**${p.must_not_start_before ?? 'dev_submitted'}** 之后才允许开跑。\n` +
          '★ 这条是**运行时上下文**，不是用户说的话。\n' +
          '★ **提前知情 ≠ 提前开工**：编写位交付之前，你跑任何测试都会被守门拒（判据在守门层，不是提醒），\n' +
          '  也不要产出测试结论 —— 那要等编写交付、你正式开工之后。现在可以做的是**设计用例**。'
        const r = await nudgeSeat(res.task, ROLE.TESTER, null, body, { kind: 'prebrief-delivered', requestId: `${res.task.id}|prebrief|${res.handoff.handoff_id}` })
        prebriefLine =
          r.ok === true
            ? `★ 预登记已**投到测试位会话**（${r.sessionId}）—— 这就是「测试提前收到任务内容」。`
            : `★ ⚠ 预登记**落盘了但没投出去**：${r.note}\n` +
              '  （通道不可达时**不静默降级**：等价可达路径是主对话用 `pipeline_dispatch { notify_only: true, role: "tester", message: … }` 手动转达。）'
      }

      return {
        ok: true,
        handoff_id: res.handoff.handoff_id,
        kind_zh: res.handoff.kind_zh,
        summary:
          `${res.summary}\n` +
          `内容哈希：${res.handoff.content_hash}\n` +
          `落盘：${res.handoff.file}\n` +
          `任务当前状态：${STATE_LABEL[res.task.state]}。` +
          (prebriefLine.length > 0 ? `\n${prebriefLine}` : ''),
      }
    },
  })

  // =========================================================================
  // 6. pipeline_transition —— 状态迁移（主对话路由）
  // =========================================================================
  const transition = tool(deps, {
    name: 'pipeline_transition',
    mutating: true,
    description:
      '推进任务状态。主对话用它做路由（派活/催办），人工用它做异常出口。' +
      '合法事件随状态而定，非法组合会被拒并列出当前可用事件。' +
      '异常出口 event：block（已阻塞）/ unblock（解除阻塞）/ cancel（已取消）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      event: S('string', '事件名（dispatch_orchestrator / requirement_confirmed / dispatch_planner / planned / dispatch_writer / dev_submitted / main_dev_submitted（主对话代发编写交测试）/ dispatch_tester / test_passed / dispatch_reviewer / review_ok / close / block / unblock / cancel 等）'),
      note: S('string', '备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      from: S('string', '迁移前状态'),
      to: S('string', '迁移后状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, from: '', to: '' }
      const res = await store.transition({
        taskId: String(args.task_id ?? ''),
        event: String(args.event ?? ''),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        note: typeof args.note === 'string' ? args.note : '',
      })
      if (res.ok !== true) return { ok: false, summary: res.error, from: '', to: '' }
      indexTask(res.task.id, res.task)
      return { ok: true, from: res.from, to: res.to, summary: res.summary }
    },
  })

  // =========================================================================
  // 6b. pipeline_supervise —— ★★主管枢纽的**具名动作**（T-20261011-56a37e）
  // =========================================================================
  //
  //  为什么单开一个工具、而不是把 supervisor 加进 `pipeline_dispatch` 的名单：
  //    安全预审（H-35ab8749a1f6f103 实测判据 R3 / 阻断项 B2）给了两条后果 ——
  //      ① `pipeline_dispatch` 内部把状态迁移的 actor **硬写成 main**
  //         ⇒ 五道确认要求的"谁发起 / 谁唤醒"**不可追溯**（直接打验收 1/5/10）；
  //      ② 主管会连带拿到 main 的**整片派活权**（含叫醒任意席位、notify_only 传话）
  //         ⇒ 越权放行。
  //    正解就是这里：**自己的工具 + 自己的事件 + 自己的 by 名单 + 真实 actor + 目标位白名单**。
  //
  //  ★ 工具-角色白名单只有一处（`lib/guard.js` 的 `PIPELINE_TOOL_ROLES.pipeline_supervise`），
  //    状态机的 `by: ['supervisor']` 是第二道 —— 两道都不放行 main 代发。
  const supervise = tool(deps, {
    name: 'pipeline_supervise',
    mutating: true,
    description:
      '【主管专用】主管枢纽的具名动作。' +
      'action=initiate 发起需求位（同时把计划位与架构位登记为「已登记待机」）；' +
      'action=agree_need 第①道确认（主管同意需求结论）并触发**唤醒点 A**（架构位到点开工）；' +
      'action=confirm_diagram 第②道确认（主管确认架构图满足要求）⇒ **转交需求位**（本动作**不再**唤醒计划位）；' +
      'action=reconfirm_diagram **主管二次确认**（用户新口径第 8 跳：需求位确认过之后再由主管确认一次）' +
      '⇒ 触发**唤醒点 B**（到这一刻才把架构图交给计划位）；' +
      'action=reject_diagram 架构图不满足 ⇒ 让架构位重画（**限 1 次**）；' +
      'action=reject_need / reject_test / reject_review 第①③④道**否掉**（用户原话的下半条分支：「如果否掉…」）' +
      '⇒ 先落一份**带原因与证据**的否掉记录，再退回被确认产物的产出方（需求位 / 测试位 / 审核位；同样**限 1 次**）；' +
      'action=confirm_station 提交主管那一侧的站点确认（②c 与第③④道的确认之一，本动作不推进状态）；' +
      'action=escalate_user 重画 / 否掉预算用尽 ⇒ 走既有两级梯升给用户。' +
      '★ 只有 supervisor 能调；main 或其它角色调会被守门与状态机两道拒掉。',
    parameters: {
      task_id: S('string', '任务 ID'),
      action: S('string', '主管动作', { enum: ['initiate', 'agree_need', 'confirm_diagram', 'reconfirm_diagram', 'reject_diagram', 'reject_need', 'reject_test', 'reject_review', 'confirm_station', 'escalate_user'] }),
      /** ★ 站点确认（action=confirm_station）用的五元。 */
      station: S('string', '站点（action=confirm_station 时必填）', { enum: [HUB_STATIONS.TEST_CONFIRM, HUB_STATIONS.REVIEW_CONFIRM, HUB_STATIONS.NEED_AGREE, HUB_STATIONS.DIAGRAM_CONFIRM, ...HUB_HANDOFF_CONFIRM_ORDER] }),
      artifact_version: S('string', '被确认的目标（制品版本 / 交接物 id；留空则按站点自动取当前目标）'),
      basis_refs: S('array', '★ 依据的证据标识（交接物 id / 制品版本 / 内容哈希 / 计数或结论字段）', { items: { type: 'string' } }),
      basis_digest: S('string', '★ 脱敏后的证据正文（**不许含代码正文**）'),
      reason: S('string', '为什么这么确认 / 为什么不满足（必填，会留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整的拒绝理由）'),
      state: S('string', '动作之后的任务状态'),
      handoff_id: S('string', '本次产生的交接物 id（没有则为空串）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, state: '', handoff_id: '' }
      const taskId = String(args.task_id ?? '')
      const action = String(args.action ?? '')
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason.length === 0) {
        return { ok: false, summary: '主管动作必须给 reason（为什么这么判）—— 站点确认要求"依据什么"可追溯。', state: '', handoff_id: '' }
      }

      // ★ 第一道：**发起方必须是主管**（第二道是状态机的 by 名单）。
      //   这里显式判一次是为了给出**指名**的拒绝原文（工具-角色表那条文案是通用的）。
      if (actor.role !== ROLE.SUPERVISOR) {
        return {
          ok: false,
          state: '',
          handoff_id: '',
          summary:
            `拒绝：**发起方与唤醒方必须是主管位**（supervisor），当前调用方是「${roleLabel(actor.role)}」。\n` +
            '★ 用户原话：「让**主管**成为枢纽」—— 发起（需求分析/计划/架构）与两个唤醒点都是主管的动作。\n' +
            '  主对话代发被明确禁止：那会把发起者记成 main（"谁发起"不可追溯），' +
            '  并且主管会连带拿到 main 的整片派活权 —— 安全预审把这一条列为**阻断项 B2**。\n' +
            '下一步：由主管席位的会话调用本工具（令牌在 pipeline_dispatch 派活时铸出）。',
        }
      }

      // --- 三种"推进链"的动作：都是具名事件 ---------------------------------
      const EVENT_OF = {
        initiate: 'supervisor_initiate',
        agree_need: 'supervisor_agree_need',
        confirm_diagram: 'supervisor_confirm_diagram',
        /** ★ P0-1：②c —— 主管**二次**确认（需求位确认过之后），它才是唤醒点 B。 */
        reconfirm_diagram: HUB_HANDOFF_CONFIRM_EVENTS[HUB_HANDOFF_CONFIRM_STATIONS.ARCH_RECONFIRM],
        reject_diagram: 'supervisor_reject_diagram',
      }
      if (Object.prototype.hasOwnProperty.call(EVENT_OF, action)) {
        const event = EVENT_OF[action]
        const res = await store.transition({
          taskId,
          event,
          actorRole: actor.role,
          actorAgentId: actor.agentId,
          note: reason,
          via: 'pipeline_supervise',
        })
        if (res.ok !== true) return { ok: false, summary: res.error, state: '', handoff_id: '' }
        indexTask(res.task.id, res.task)

        // ★★ **唤醒点要「真的派人」**（2026-10-16，真缺陷：状态到了人没到 ⇒ L5 死锁）。
        //
        //   现场（真机 `T-20261016-fullai`）：`initiate` / `agree_need` 只写枢纽账本，
        //   状态推进了、**席位一个都没建**；而引导步的白名单当时只放开需求分析
        //   ⇒ `pipeline_dispatch{role:'architect'}` 被拒 ⇒ 架构位永远不存在
        //   ⇒ 架构图产不出 ⇒ 唤醒点 B 到不了 ⇒ 计划位起不来 ⇒ 角色清单产不出 ⇒ **死锁**。
        //
        //   ★ 授权来源不是调用方身份，而是**主管自己写下的账本**（`task.hub`：
        //     已发起 + 到点唤醒）。判据见 `lib/tools/hub-seats.js`。
        //   ★ 派活**复用既有通道**（`pipeline_dispatch` 的 execute 入口）：
        //     真会话 + 四槽 + 令牌 + 台账 + 它里面每一道既有闸门；不另造一套。
        //   ★ 幂等：同一个角色**不重复派**（判据 = 派活台账里有没有这一条）；
        //     每一次补派都写 `hub:seat-respawn` 进审计与 `task.history`。
        let seatLines = []
        let liveTask = res.task
        if (HUB_SPAWN_ACTIONS.has(action)) {
          const ensured = await hubSeats.ensureHubSeats(res.task, exec, {
            by: actor.role,
            via: `pipeline_supervise:${action}`,
            reason: `唤醒点派人（${action}）`,
          })
          if (ensured.lines.length > 0) seatLines = [HUB_SEAT_RESPAWN_HEAD, ...ensured.lines]
          if (ensured.task !== null && ensured.task !== undefined) {
            liveTask = ensured.task
            indexTask(liveTask.id, liveTask)
          }
        }

        // ★★ **唤醒必须真的投到会话**（不是只改一个字段）。
        //   安全预审的准入判据形态写死：「唤醒动作（主管侧：谁叫、能不能叫）与产物的
        //   产出（席位侧：叫了也不能提前产出）必须**各有一道**判据」。
        //   上面那道是"能不能叫"（guard + by 名单）；这一处是"叫了要真的到"。
        //   ★ 通道不可达时**不静默降级**（越界清单第 13 条）：失败原文照原样拼进 summary，
        //     并给出等价可达路径，让主对话当场看见。
        //   ★ 用 `liveTask`（补派之后的**最新**台账）：刚建出来的席位必须能被叫醒 ——
        //     拿补派之前的旧任务去投，就会"人刚派到、消息却投不出去"。
        let wakeLines = []
        const WP = action === 'agree_need'
          ? HUB_WAKE_POINTS.NEED_AGREE
          : action === 'reconfirm_diagram' ? HUB_WAKE_POINTS.DIAGRAM_CONFIRM : null
        if (WP !== null) {
          const targets = (Array.isArray(liveTask.hub?.standby) ? liveTask.hub.standby : [])
            .filter((s) => s?.wake_point === WP && s?.status === 'woken')
          for (const s of targets) {
            const body =
              `【流水线 · 唤醒】你是「${roleLabel(s.role)}」（${s.group}），现在**到点了**。\n` +
              `任务：${liveTask.id}　唤醒点：**${WP === HUB_WAKE_POINTS.NEED_AGREE ? '主管同意需求结论' : '主管确认架构图满足要求'}**\n` +
              `任务当前状态：${STATE_LABEL[res.to] ?? res.to}（\`${res.to}\`）\n` +
              '★ 这条是**运行时上下文**，不是用户说的话。\n' +
              '★ 在此之前你处于「已登记待机」—— 那时交产物、写自己目录的报告、跑测试都会被守门/状态机拒。\n' +
              '下一步：pipeline_status 读回你的边界与当前位置，然后做你那一份活。'
            const r = await nudgeSeat(liveTask, s.role, null, body, { kind: 'hub-wake', requestId: `${liveTask.id}|hub-wake|${WP}|${s.role}` })
            wakeLines.push(r.ok === true ? `  ✓ 已唤醒 ${roleLabel(s.role)}（会话 ${r.sessionId}）` : `  ✗ 唤醒 ${roleLabel(s.role)} **没投出去**：${r.note}`)
          }
          if (wakeLines.some((l) => l.includes('✗'))) {
            wakeLines.push('★ 通道不可达时**不静默降级**（越界清单第 13 条）：上面对不上的那几行是**失败原文**。' +
              '等价可达路径：主对话用 `pipeline_dispatch { notify_only: true, role, message }` 手动催；' +
              '若席位根本没建起来，用 `pipeline_dispatch { role, reassign: true }` 重派。')
          }
        }

        const hub = liveTask?.hub ?? res.task?.hub ?? null
        return {
          ok: true,
          state: res.to,
          handoff_id: '',
          summary:
            `${res.summary}\n` +
            (action === 'initiate'
              ? `★ 已登记待机（**已登记未开工**，可在 pipeline_status 的 hub.standby 读回）：\n` +
                (Array.isArray(hub?.standby) ? hub.standby.map((s) => `  · ${s.role}（${s.group}）⇒ 唤醒点 ${s.wake_point}　状态 ${s.status}`).join('\n') : '') +
                (hub?.entry !== null && hub?.entry !== undefined
                  ? `\n★ **入口留痕**：本单由「${hub.entry.by}」在 ${hub.entry.at} 递给主管（用户新口径第 1 跳）。`
                  : '\n⚠ 本单**没有**入口留痕（`handoff_to_supervisor`）—— 属于自举/夹具形态：' +
                    '主对话若要走新口径，应在**新单那一刻**先用 pipeline_transition event=handoff_to_supervisor 把任务递给主管。') +
                '\n下一步：等需求位交结论 → 它会把状态推到「主管受理中」→ 你调 action=agree_need。'
              : action === 'agree_need'
                ? '★ **唤醒点 A** 已触发：架构位（architect / diagrammer）到点开工，出架构图。\n' +
                  '下一步：架构图产出后状态落到「架构图待主管确认」→ 你调 action=confirm_diagram。'
                : action === 'confirm_diagram'
                  ? '★ 架构图已**转交需求位**（第②道确认完成，用户新口径第 6~7 跳）。\n' +
                    '★ 本动作**不唤醒计划位** —— 计划位要等**主管二次确认**（新口径：需求位确认 → 主管二次确认 → 才交计划）。\n' +
                    '下一步：需求位交一份 station_confirm{station:"arch_need_confirm", decision:"ok"}（交了它状态自动走到「架构图待主管二次确认」）→ 你再调 action=reconfirm_diagram。'
                  : action === 'reconfirm_diagram'
                    ? '★ **唤醒点 B** 已触发：**主管二次确认**完成，计划位到点开工（这是它唯一的唤醒点）。\n' +
                      '下一步：pipeline_transition event=dispatch_planner 派活给计划位（未唤醒时那条边过不去）。'
                    : `★ 重画指令已留痕（已用 ${hub?.diagram_redraws ?? '?'} / 上限 ${HUB_DIAGRAM_REDRAW_BUDGET}）。\n` +
                      '下一步：架构位重画 → 再交一次架构图 → 你再判。' +
                      ((hub?.diagram_redraws ?? 0) >= HUB_DIAGRAM_REDRAW_BUDGET
                        ? '\n⚠ 预算已用尽：再判"不满足"只能走 action=escalate_user（升给用户）。'
                        : '')) +
            (seatLines.length > 0 ? `\n${seatLines.join('\n')}` : '') +
            (wakeLines.length > 0 ? `\n★ 唤醒投递：\n${wakeLines.join('\n')}` : ''),
        }
      }

      // --- ★★①③④ 三站的「否掉」通道（T-20261011-56a37e 补齐）----------------
      //
      //  用户原话：「…**如果同意**…**如果否掉**…」—— 上半条（同意）早已落地在
      //  第①~④道的确认闸门上，下半条（否掉）此前**只有第②道**有回边
      //  （`reject_diagram`）。这三个动作补的就是剩下三站。
      //
      //  ★ 与 `reject_diagram` **逐项对齐**（同构性）：
      //    · 同一个工具（`pipeline_supervise`；工具-角色白名单里只有 supervisor）；
      //    · 同一个 `by: [ROLE.SUPERVISOR]`（状态机那一道，main 代发在这里就被拒）；
      //    · 同一条 `TRANSITIONS` 边、同一枚守门判据（`store.checkPrecondition`）；
      //    · 同一份审计（`audit.jsonl` 的 `transition:<事件名>`）；
      //    · 同一套预算口径（**限 1 次**；用尽 ⇒ 指向 `action=escalate_user` 走既有两级梯）。
      //  ★ 唯一的一处**加强**（加强不是放宽）：否掉必须先落一份**带原因与证据**的
      //    否掉记录（复用既有的 `station_confirm`，`decision='ng'`）—— 依据是本条硬要求
      //    「失败要带证据、不许静默」。第②道没有这一条（它刻意保持原样，自测把它钉住了）。
      const REJECT_STATION_OF = {
        reject_need: HUB_STATIONS.NEED_AGREE,
        reject_test: HUB_STATIONS.TEST_CONFIRM,
        reject_review: HUB_STATIONS.REVIEW_CONFIRM,
      }
      const BACK_TO_ZH = {
        [HUB_STATIONS.NEED_AGREE]: '需求位（重做需求分析）',
        [HUB_STATIONS.TEST_CONFIRM]: '测试位（重跑测试）',
        [HUB_STATIONS.REVIEW_CONFIRM]: '审核位（重新审核）',
      }
      if (Object.prototype.hasOwnProperty.call(REJECT_STATION_OF, action)) {
        const station = REJECT_STATION_OF[action]
        const event = HUB_STATION_REJECT_EVENTS[station]
        const t0 = await load(taskId)
        if (t0 === null) return { ok: false, summary: taskNotFound(taskId), state: '', handoff_id: '' }
        /** ★ 与 `confirm_station` 用**同一条**目标派生规则（不靠调用方自觉传对）。 */
        const lastOf = (kind) => {
          const hs = Array.isArray(t0.handoffs) ? t0.handoffs : []
          for (let i = hs.length - 1; i >= 0; i--) if (hs[i].kind === kind) return hs[i]
          return null
        }
        const target = typeof args.artifact_version === 'string' && args.artifact_version.trim().length > 0
          ? args.artifact_version.trim()
          : station === HUB_STATIONS.NEED_AGREE
            ? (lastOf('requirement_analysis')?.handoff_id ?? '')
            : (lastOf('dev_to_test')?.artifact_version ?? '')

        // 第一步：落「否掉记录」—— 复用**既有**的站点确认交接物与**既有**的校验器
        //   （`reason` 与 `basis_refs` ≥ 1 条是 schema 强制；`basis_digest` 要过脱敏扫描）。
        //   预算用尽时它会**交不上来**（submitHandoff 里的预算前置），所以不会留下半截状态。
        const rec = await store.submitHandoff({
          taskId,
          kind: 'station_confirm',
          actorRole: actor.role,
          actorSeat: actor.seat ?? null,
          payload: {
            task_id: taskId,
            station,
            artifact_version: target,
            decision: 'ng',
            basis_refs: Array.isArray(args.basis_refs) ? args.basis_refs : [],
            basis_kind: 'evidence_digest',
            basis_digest: typeof args.basis_digest === 'string' && args.basis_digest.trim().length > 0
              ? args.basis_digest
              : '（主管否掉：见 basis_refs 里的证据标识；本字段只记录结论、计数与定位，不含代码正文。）',
            reason,
          },
          actorAgentId: actor.agentId,
        })
        if (rec.ok !== true) return { ok: false, summary: rec.error, state: '', handoff_id: '' }
        indexTask(rec.task.id, rec.task)

        // 第二步：走那条回边（守门会再判一次**同一枚**判据；预算用尽在这里被拒）。
        const tr = await store.transition({
          taskId,
          event,
          actorRole: actor.role,
          actorAgentId: actor.agentId,
          note: reason,
          via: 'pipeline_supervise',
        })
        if (tr.ok !== true) {
          // ★ 不许静默：记录留下了、状态没动 —— 这两件事都如实说。
          return {
            ok: false,
            state: rec.task.state,
            handoff_id: rec.handoff.handoff_id,
            summary:
              `否掉记录**已留痕**（${rec.handoff.handoff_id}），但**退回没走成** —— 状态没有推进。\n` +
              `拒绝原文：${tr.error}\n` +
              '★ 如实报告：那条记录留在盘上（它是"我说过不同意"的事实），但**不要**把它当成"已退回"、' +
              '也不要据此对下游说"已经退回去了"。',
          }
        }
        indexTask(tr.task.id, tr.task)
        const used = Number.isInteger(tr.task?.hub?.station_rejects?.[station]) ? tr.task.hub.station_rejects[station] : 1
        return {
          ok: true,
          state: tr.to,
          handoff_id: rec.handoff.handoff_id,
          summary:
            `★ 第${{ [HUB_STATIONS.NEED_AGREE]: '①', [HUB_STATIONS.TEST_CONFIRM]: '③', [HUB_STATIONS.REVIEW_CONFIRM]: '④' }[station]}道**否掉**已生效，退回 **${BACK_TO_ZH[station]}**。\n` +
            `否掉记录：${rec.handoff.handoff_id}（带原因与证据标识；在 task.handoffs 与审计里都可查）\n` +
            `${tr.summary}\n` +
            `★ 否掉预算：已用 ${used} / 上限 ${HUB_STATION_REJECT_BUDGET}（与②道架构图重画同一套口径）。\n` +
            '★ 否掉**即作废**：这一站此前收到的确认记录全部失效（与被测试/审核打回同一条规则）——' +
            '重做之后要**重新**确认，旧的点头不作数。\n' +
            (used >= HUB_STATION_REJECT_BUDGET
              ? '\n⚠ 预算已用尽：再判"不满足"只能调 action=escalate_user（升给用户定）。'
              : ''),
        }
      }

      // --- 站点确认（主管那一侧；不推进状态）--------------------------------
      if (action === 'confirm_station') {
        const station = String(args.station ?? '')
        const t0 = await load(taskId)
        if (t0 === null) return { ok: false, summary: taskNotFound(taskId), state: '', handoff_id: '' }
        /**
         * ★ 确认目标**按站点派生**（不靠调用方自觉传对）：
         *   第①②道绑"被确认的那份产物"（结论 / 图的交接物 id），第③④道绑**制品版本**。
         *   与 `store.hubStationTarget` 同一条规则 —— 这里只是把它在工具层复算一次，
         *   好让调用方**不用**自己去翻 task.json。
         */
        const last = (kind) => {
          const hs = Array.isArray(t0.handoffs) ? t0.handoffs : []
          for (let i = hs.length - 1; i >= 0; i--) if (hs[i].kind === kind) return hs[i]
          return null
        }
        const target = typeof args.artifact_version === 'string' && args.artifact_version.trim().length > 0
          ? args.artifact_version.trim()
          : station === HUB_STATIONS.NEED_AGREE
            ? (last('requirement_analysis')?.handoff_id ?? '')
            : station === HUB_STATIONS.DIAGRAM_CONFIRM
              ? (last('architecture_diagram')?.handoff_id ?? '')
              : (last('dev_to_test')?.artifact_version ?? '')
        const res = await store.submitHandoff({
          taskId,
          kind: 'station_confirm',
          actorRole: actor.role,
          actorSeat: actor.seat ?? null,
          payload: {
            task_id: taskId,
            station,
            artifact_version: target ?? '',            decision: 'ok',
            basis_refs: Array.isArray(args.basis_refs) ? args.basis_refs : [],
            basis_kind: 'evidence_digest',
            basis_digest: typeof args.basis_digest === 'string' && args.basis_digest.trim().length > 0
              ? args.basis_digest
              : '（主管确认：见 basis_refs 里的证据标识；本字段只记录结论、计数与定位，不含代码正文。）',
            reason,
          },
          actorAgentId: actor.agentId,
        })
        if (res.ok !== true) return { ok: false, summary: res.error, state: '', handoff_id: '' }
        indexTask(res.task.id, res.task)
        const view = (res.task.hub?.standby ?? [])
        void view
        return {
          ok: true,
          state: res.task.state,
          handoff_id: res.handoff.handoff_id,
          summary:
            `主管侧站点确认已留痕：${res.handoff.handoff_id}（站点 ${station}）。\n` +
            `${res.summary}\n` +
            '★ 若该站点是**双确认**站点（第③④道），还需要**需求位**那一侧各交一份 ' +
            'station_confirm —— 两份各自令牌产出、绑定同一个目标，缺一份就走不到下一步。\n' +
            '下一步：pipeline_transition（第③道 ⇒ dispatch_reviewer；第④道 ⇒ close）。',
        }
      }

      // --- 重画预算用尽 ⇒ 升级人工（走**既有**的两级梯）---------------------
      if (action === 'escalate_user') {
        const res = await store.submitHandoff({
          taskId,
          kind: 'human_request',
          actorRole: actor.role,
          actorSeat: actor.seat ?? null,
          payload: {
            task_id: taskId,
            stage: '主管枢纽 · 架构图确认',
            question:
              '架构图经主管判为"不满足要求"，重画预算（限 1 次）已用尽 —— 请裁定：接受现状 / 换架构位重做 / 改需求。',
            context_digest: reason,
            reason_kind: 'other',
            decision_kind: 'free_text',
            options: [],
            blocking: true,
            urgency: 'blocking',
            timeout_behavior: 'wait',
          },
          actorAgentId: actor.agentId,
        })
        if (res.ok !== true) return { ok: false, summary: res.error, state: '', handoff_id: '' }
        indexTask(res.task.id, res.task)
        return {
          ok: true,
          state: res.task.state,
          handoff_id: res.handoff.handoff_id,
          summary:
            `已按用户口径④把架构图这件事**升给用户**：${res.handoff.handoff_id}。\n` +
            `${res.summary}\n` +
            '★ 走的是**既有的**两级梯（human_request），没有第二套上升通道。\n' +
            '下一步：主对话 pipeline_human_relay 转告用户 → 拿到答复后 pipeline_human_reply。',
        }
      }

      return {
        ok: false,
        state: '',
        handoff_id: '',
        summary: `未知的主管动作「${action}」；合法值：initiate / agree_need / confirm_diagram / reject_diagram / reject_need / reject_test / reject_review / confirm_station / escalate_user。`,
      }
    },
  })

  // =========================================================================
  // 7. pipeline_rework —— 打回
  // =========================================================================
  const rework = tool(deps, {
    name: 'pipeline_rework',
    mutating: true,
    description:
      '打回。测试不通过 → 打回编写（target=writer）；审核不通过 → 打回编写或测试（target=writer/tester）。' +
      '每条打回链有次数上限（默认 2 次，配置 maxReworkPerLeg），超限会被拒 —— 那时应改用 block 交人工，' +
      '或让编排复核后追加仲裁角色。打回会作废该轮已有的审核 OK。',
    parameters: {
      task_id: S('string', '任务 ID'),
      target: S('string', '打回给谁', { enum: ['writer', 'tester'] }),
      reason: S('string', '打回原因（必填，会留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（超限时是完整拒绝理由）'),
      used: S('number', '已用次数'),
      budget: S('number', '上限'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, used: 0, budget: 0 }
      if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
        return { ok: false, summary: '打回必须给 reason（为什么打回、要改什么）。', used: 0, budget: 0 }
      }
      const res = await store.rework({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        target: String(args.target ?? 'writer'),
        reason: args.reason,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, used: 0, budget: 0 }
      indexTask(res.task.id, res.task)
      return { ok: true, used: res.used, budget: res.budget, summary: res.summary }
    },
  })

  // =========================================================================
  // 8. pipeline_close —— 关单（必须审核 OK）
  // =========================================================================
  const close = tool(deps, {
    name: 'pipeline_close',
    mutating: true,
    description:
      '【主对话专用】关单。★ 必须已存在**有效的审核 OK**，否则拒绝：' +
      '需要一份 review_verdict（conclusion=OK，artifact_version 等于当前有效制品版本，且在最近一次打回之后）。' +
      '主对话不能凭"看起来做完了"关单 —— 测试与审核不通过时只能打回，不能直接关。' +
      '关单后会写 close_report 并把审核的放行依据一并留痕。',
    parameters: {
      task_id: S('string', '任务 ID'),
      note: S('string', '关单备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（无 OK 时是完整拒绝理由）'),
      artifact_version: S('string', '被放行的制品版本'),
      review_ok: S('string', '放行依据（审核 OK 的交接物 id）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, artifact_version: '', review_ok: '' }
      const res = await store.close({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        note: typeof args.note === 'string' ? args.note : '',
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, artifact_version: '', review_ok: '' }
      indexTask(res.task.id, res.task)
      const n = tokens.revokeTask(res.task.id)
      return {
        ok: true,
        artifact_version: res.report.artifact_version ?? '',
        review_ok: res.report.review_ok_handoff ?? '',
        summary:
          `${res.summary}\n` +
          `最终交付说明：${res.report.final_delivery_note || '（审核未填）'}\n` +
          `风险说明：${(res.report.risk_notes ?? []).join('；') || '（无）'}\n` +
          `已回收本任务的角色令牌 ${n} 枚。`,
      }
    },
  })

  return { handoff, transition, supervise, rework, close }
}
