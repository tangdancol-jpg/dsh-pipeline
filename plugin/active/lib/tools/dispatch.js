/**
 * dsh-pipeline · 派活与角色认领（pipeline_dispatch / pipeline_bind_role）
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/dispatch
 */

import { ROLE, ROLES, roleLabel } from '../roles.js'
import { ST, STATE_LABEL } from '../states.js'
import { agentIdOf } from '../guard.js'
import { DEFAULT_SEAT_SILENCE_MS, formatDuration } from '../liveness.js'
// ★★ P5 接线（W6）：`tier ≥ L3` 无主管 ⇒ 需求位不可派。判断"档位落地没落地"要用
//    `isUnknownTier` 分流（`tier-order.js` 自己就是这么要求的：未知与非法是两件事）。
import { isUnknownTier } from '../tiers/tier-order.js'
import { describeSlotDivergence, resolveEffectiveSlots } from '../roster/slot-truth.js'
import { DISPATCH_SLOT_KEYS, isSpawnableRole } from '../transport/index.js'
import { toStringArray } from '../util.js'
import { dispatchSlotPlan, dispatchSlots } from './dispatch-slots.js'
import { hubAuthorizedRoles } from './hub-seats.js'
import { describeScopePaths } from '../scope/root-marker.js'
import { S, tool, resolveActor, dispatchEventFor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { taskNotFound } from '../errors/text.js'

/**
 * 派活与角色认领（pipeline_dispatch / pipeline_bind_role）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildDispatchTools(ctx) {
  const { deps, config, store, tokens, transport, indexTask, notifyOnly, load } = ctx

  // =========================================================================
  // 3. pipeline_dispatch —— 主对话派活
  // =========================================================================
  const dispatch = tool(deps, {
    name: 'pipeline_dispatch',
    mutating: true,
    description:
      '【主对话专用】按已产出的角色清单把一个角色派出去，并铸一枚只属于该角色的令牌。' +
      'role 必须**已经出现在当前角色清单里**，否则拒绝 —— 主对话不能自己决定加人减人。' +
      'transport=subagent 时会真的创建子代理会话；transport=manual（或 spawn_roles=false）时只返回一段可粘贴的派活单。',
    parameters: {
      task_id: S('string', '任务 ID'),
      role: S('string', '要派出的角色', { enum: Object.keys(ROLES) }),
      seat: S('string', '★编写席位（role=writer 且清单里 count>1 时必填，形如 writer#2）'),
      /**
       * ★ **四槽下发**（权限档 / 模式 / 模型 / 推理等级）。
       *
       * 四个槽**必须四个独立顶层字段** —— 不许打包成 `options{}` / `slots{}`
       * （越界清单里写死的一条）。每一槽原样交给通道侧，由通道分别用
       * `permissionPresets.set(会话对象, 档名)`（并读回核对）/ `create({agentPreset})`（模式）/
       * `selectModel`（模型 + 推理等级，用完把被顺带改掉的全局默认还原）落到会话上。
       * 任一槽落不下去 ⇒ **拒绝派活 + 留痕**，不静默降级、不拿近似物冒名。
       *
       * 不给 = 取名单里为该席位（`partitions[].seat`）或该角色（`sequence[].role`）声明的同名字段；
       * 名单里也没有 = 交给通道取兜底并留痕。★ **B 件（2026-10-16）**：`permission` / `mode`
       * **不再落全局那一个兜底**，而是**按角色取** —— 权限档按角色写入需求推导
       * （会产生落盘产物的角色至少 `workspace-write`，纯只读角色保持 `read-only`；
       * 判据见 `lib/roster/permission-need.js`），模式按角色取 `pl-<role>`；
       * 模型 / 推理等级仍落环境枚举默认档。名单是四槽的唯一权威，这里只做消费。
       */
      permission: S('string', '★四槽①权限档（四槽分开传，不许打包）：read-only / workspace-write / danger-full-access。「完全」档默认禁用，须三段齐（需求分析→主对话→用户判定）否则拒绝。不给 = 名单声明值 → **按角色需求推导**（会落盘的角色至少 workspace-write）'),
      mode: S('string', '★四槽②内置模式 = 会话头 agentPreset（例如 standard）。不给则取名单声明值，再退配置默认'),
      model: S('string', '★四槽③模型（"provider/model" 或 "model"）。不给则取名单声明值，再退环境枚举默认档'),
      reasoning: S('string', '★四槽④推理等级（与模型分开传，不许并进模型里）。不给则取名单声明值，再退环境枚举默认档'),
      spawn: S('boolean', '是否真的创建会话（默认跟随配置 spawnRoles）'),
      /**
       * ★ **席位失联重派**（一键恢复通道）。
       *
       * 为什么需要它：席位可能**秒死**（2026-10-11 的事故：`turn/start` 之后 277 ms 报错收尾，
       * 一句话没说），之后**没有任何角色再调用工具**。这时唯一能救场的就是"重派同一个席位"。
       * 而失联处置会把任务推到「已阻塞」，`dispatchEventFor(role,'blocked')` 是 null ——
       * 直接重派会**派出去了但状态永远停在阻塞**。所以这条通道必须把"解除阻塞"与"重派"合成一步。
       *
       * ★ **不消耗打回预算**：派活路径本来就不动 `rework`（那是测试/审核打回时才扣的）；
       *   而且"席位死了"不是编写的错。
       */
      reassign: S('boolean', '★ 席位失联重派：任务处于「已阻塞」时，先回到阻塞前的状态再派同一角色/席位（不消耗打回预算）'),
      /**
       * ★★ **B8：只传话、不派活**（停 / 催通道）。
       *
       * `notify_only:true` ⇒ **不建会话、不改状态**，只把 `note` 投给这个 role/seat
       * **已经存在**的那个会话。投不出去会返回 `ok:false` 并写清原因与等价路径。
       * 配 `stop:true` 表示"叫它停手"（消息里写明这是主对话的指令；停不停由它自己执行 ——
       * 插件不替它改状态，也不假装它已经停了）。
       */
      notify_only: S('boolean', '★ 只给**既有席位**传话（催办/叫醒/停手）：不建会话、不改状态；投不出去会返回 ok:false'),
      stop: S('boolean', '★ 停手信号（配 notify_only 用）：消息里写明"立即停手"'),
      message: S('string', '★ 要传给席位的话（notify_only=true 时用；也可用 note）'),
      note: S('string', '补充说明（可空；notify_only=true 时它就是要说的话）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含派活单或会话 id）'),
      agent_id: S('string', '角色会话 id（manual 通道下为空串）'),
      role: S('string', '派出的角色'),
      seat: S('string', '编写席位（非 writer 或单席位时为空串）'),
      token: S('string', '该角色的令牌（要交给那个对话）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, agent_id: '', role: '', token: '' }
      let task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: taskNotFound(args.task_id), agent_id: '', role: '', token: '' }
      const role = String(args.role ?? '')
      if (!ROLES[role]) {
        return { ok: false, summary: `未知角色「${role}」；合法值：${Object.keys(ROLES).join(' / ')}`, agent_id: '', role: '', token: '' }
      }

      // ★ **席位失联重派通道**（`reassign:true`）—— 一键把死掉的席位换一个新的上去。
      //
      //   为什么必须合成一步：失联处置会把任务推到「已阻塞」，而
      //   `dispatchEventFor(role, 'blocked')` 是 `null` ⇒ 若只重派不解除阻塞，
      //   结果就是"新席位在干活、任务状态却永远是已阻塞"的半截现场。
      //
      //   ★ 不消耗打回预算：派活路径从不触碰 `task.rework`（那是测试/审核打回时扣的），
      //     而且"席位死了"不是任何角色的错 —— 这条恢复不该让人付账。
      let revived = null
      /**
       * ★★ **B8：只传话、不派活**（`notify_only: true`）。
       *
       * "停会话 / 催办"这条**可见**通道 —— 改前完全没有（当晚只能由用户用 GUI 手动打字
       * 把席位叫醒）。它复用本工具的 role/seat 身份解析，从**派活台账**里找会话，
       * 结构上投不错人；投不出去返回 `ok:false` + 原因 + 等价路径（**不静默失败**）。
       */
      if (args.notify_only === true) {
        // ★★ **2026-10-13 快修（④）：`seat` 暂时性死区崩溃**。
        //
        //   现场：`pipeline_dispatch { notify_only: true, role, seat, task_id }` **每次必崩**
        //   `ReferenceError: Cannot access 'seat' before initialization`。
        //
        //   病根：本块在 `let seat = null`（下面的"编写席位的解析与校验"那一段）**之前**执行，
        //   却直接引用了那个 `seat` ⇒ 落进 TDZ。而**上面那条 return（空 note 分支）用的却是
        //   `args.seat`** —— 说明原意本来就是"用调用方给的席位键"，只是有一半写成了裸 `seat`。
        //
        //   修法：在本块内用**调用方给的席位键**自行解析，不再向外层 `seat` 借（那一个是
        //   roster 解析出来的**编写席位**，只管 writer，语义也不一样）：
        //     · 非空字符串 ⇒ 原样用作 `task.dispatched` 的匹配键（谁的台账记录就投谁）；
        //     · 缺省 / 空串 ⇒ `null`，交给 `nudgeSeat` 按 role 匹配（"该角色那个会话"）。
        //   `nudgeSeat` 的判据是 `seat === null || String(x.seat) === String(seat)` ——
        //   所以这里**必须**归一成 `null`，不能把 `undefined` 递下去（那会变成字符串
        //   `"undefined"` 去匹配席位，永远匹配不上）。
        const notifySeat = typeof args.seat === 'string' && args.seat.length > 0 ? args.seat : null
        const text = String(args.note ?? args.message ?? '').trim()
        if (text.length === 0) {
          return { ok: false, agent_id: '', role, seat: String(args.seat ?? ''), token: '', summary: 'notify_only=true 时必须给 note（要说的话）—— 发空消息等于没说。' }
        }
        const nr = await notifyOnly(task, role, notifySeat, text, args.stop === true)
        if (nr.ok === true) {
          return {
            ok: true,
            agent_id: nr.sessionId ?? '',
            role,
            seat: String(notifySeat ?? ''),
            token: '',
            summary: `已把消息投给「${roleLabel(role)}${notifySeat === null ? '' : `（${notifySeat}）`}」的会话 ${nr.sessionId}。\n${nr.note}`,
          }
        }
        return {
          ok: false,
          agent_id: '',
          role,
          seat: String(notifySeat ?? ''),
          token: '',
          summary:
            `**没投出去**（这是看得见的失败，不是静默）：${nr.note}\n` +
            `等价可达路径：\n` +
            `  · 重派同一席位：pipeline_dispatch { task_id: "${task.id}", role: "${role}", reassign: true }\n` +
            `  · 查派活台账：pipeline_status { task_id: "${task.id}" }\n` +
            '  · 若会话已经不在了：这条**只能由用户**在 GUI 里处置（插件不替你删会话）。',
        }
      }
      if (args.reassign === true && task.state === ST.BLOCKED) {
        const un = await store.transition({
          taskId: task.id,
          event: 'unblock',
          actorRole: ROLE.MAIN,
          actorAgentId: actor.agentId,
          note: '★ 席位失联重派：先解除阻塞（不消耗打回预算）',
        })
        if (un.ok !== true) {
          return {
            ok: false,
            agent_id: '',
            role,
            seat: String(args.seat ?? ''),
            token: '',
            summary:
              `重派失败：任务 ${task.id} 处于「已阻塞」，但解除阻塞被拒。\n${un.error}\n` +
              '请先 pipeline_status 看清状态，或改用 pipeline_transition event="unblock" 手动解除。',
          }
        }
        task = un.task
        revived = { from: un.from, to: un.to }
        indexTask(task.id, task)
      }
      /**
       * ★★ P5 接线（`WIRING.md` §W6）：`tier ≥ L3` 且**没有主管席位** ⇒ 需求位不可派
       * （裁定 1 / 定稿 §3.5）。判据本体在 `lib/tiers/hub-required.js`，经
       * `store.hubCanDispatchOrchestrator` 转发（与既有各闸门同一条规矩）。
       *
       * ★ 判在**这一刻**（"要不要放开 orchestrator"的决策点）：放到后面判，会话已经建出来了。
       * ★ 判在 `roster === null` 那个分支**之外**：有清单但清单里没 supervisor 正是要拦的形状。
       *
       * ⚠️⚠️ `requirementConfirmed` 传的是**"档位有没有落地"**，**不是** `state !== PENDING`
       *   （`WIRING.md` §W6 的示例那样写）。那个代理判据过宽：`analyzing` 的单子档位还没落地
       *   （`tier` 仍是 `null`），会被算成"已确认" ⇒ `tierOrdinal(null)` ⇒ `BAD_TIER` ⇒ **误拒**；
       *   实测把 `reassign:true`（席位失联后唯一必然可用的恢复路径）挡死，liveness 三条正例全红。
       *   改判"档位是否落地"后两边都成立：已落地且无主管 ⇒ 拒；未知 ⇒ 走"还没落地"分支
       *   （主管是开单时先强制设上的那个，W4）⇒ 放行。完整现场见 W6 那条提交。
       */
      if (role === ROLE.ORCHESTRATOR) {
        const hubOk = await store.hubCanDispatchOrchestrator(task.id, {
          requirementConfirmed: !isUnknownTier(task.hub_requirement?.tier),
          /**
           * ★★ A 件（2026-10-16）：`by` 记**机制名**而不是 `main` —— 自愈补派是
           *   `tokens.mint({ mechanism: 'hub-seat-respawn' })` 铸的身份（授权来源
           *   是 `task.hub` 账本），把它写成 `main` 就等于"机制冒充了主对话"，
           *   事后没人分得清"这一步是人推的还是机制自己补的"。
           */
          by: actor.mechanism ?? actor.role,
        })
        // ★ 不返回 `code`：本工具 output 是 `additionalProperties:false`，多一个键过不了
        //   宿主输出校验（output-check 跑的就是这条）。
        if (hubOk.ok !== true) {
          return { ok: false, agent_id: '', role, seat: String(args.seat ?? ''), token: '', summary: hubOk.error }
        }
      }
      // ★ 引导步：角色清单还没产出时，能派的只有**产出清单链条上的那两个**。
      //   否则会死锁 —— 没有清单就派不出它们，没有它们就产不出清单。
      //
      //   ★ 本轮改动：链条从"一个编排角色"变成**两站**（需求分析 → 计划），
      //     所以这里按**状态**判，而不是一律放开 orchestrator：
      //       · 待分配 / 需求分析中 ⇒ 只能派需求分析（它出分析结论）；
      //       · 待计划 / 计划中     ⇒ 只能派计划 AI（它出清单）。
      //     注意仍然**只**放开这两个角色：主对话不能凭空派人。
      //
      //   ★★ 2026-10-11 真单 T-20261011-a5fe41 死锁修复：**「计划中」也是引导态**。
      //
      //     病根：原来的三元只认 `ready_plan`，一旦状态已经是 `planning` 就落进 else ——
      //     而 else 那句"唯一能派的是需求分析"是**拆角色之前**的旧规则残留
      //     （那时清单由 orchestrator 产出，所以它确实是唯一入口）。
      //
      //     为什么会被踩到：`dispatch_planner`（ready_plan → planning）这条边的
      //     `by` 里有 `main` —— 主对话自己也能触发它。真单现场就是主对话先把状态
      //     推到了「计划中」（roster 仍为 null），**再**调 pipeline_dispatch{role:'planner'}，
      //     于是被 else 分支拒掉。而 `planned` / `plan_gap` 两条出边**只有 planner** 能发
      //     ⇒ 派不出 planner ⇒ 清单永远产不出来 ⇒ 任务在「计划中」单向死锁。
      //
      //     修法：引导态覆盖**两站各自的"轮到我"状态** —— ready_plan 与 planning。
      //     这**不是**把门放宽成"谁都能派"：白名单仍只有那两个角色，且只在
      //     `roster === null` 时生效；非引导态一律走下面"清单里没有就拒"那条通用门。
      //     在 `planning` 里重派 planner 也不是新权限 —— 它紧接 ready_plan 的那次派活
      //     （引导步漏点 / 席位失联时的恢复路径），而清单仍是 null，
      //     所以 planner 照样得**过 `plan_ready` 守卫**才能把它产出来。
      if (task.roster === null) {
        const planningStage = task.state === ST.READY_PLAN || task.state === ST.PLANNING
        /**
         * ★★ P0-1 **入口**（用户新口径第 1 跳：「主对话agent递给主管agent」）。
         *
         * 病灶（实测原文）：新单上"主管席位**在任何阶段都派不出来**" ——
         *   引导步白名单只有需求分析，而主管枢纽又要求"必须由主管发起" ⇒
         *   新单上枢纽**永远启动不了**（入口悬空）。
         *
         * 修法：**只**在「主对话已经把本单递给主管」（`hub.entry`）**且**
         *   仍在 `pending`（待分配）这一刻时，引导步白名单**多出 supervisor 这一席**。
         *
         * ★ **凭什么**（三条同时成立，缺一即回到旧行为）：
         *   ① `task.hub.entry` 存在 —— 那是**主对话自己**用
         *      `pipeline_transition event=handoff_to_supervisor` 落下的留痕
         *      （那条边 `by:['main']` + 五条判据，中途的单递不出去）；
         *   ② 状态恰好是 `pending` —— 递单那一刻，流程还没往前走一步；
         *   ③ `roster === null` —— 还没有角色清单（本分支的前提）。
         * ★ **没有顺带放宽别的角色**：这条分支**只**把 `supervisor` 加进白名单，
         *   而且是在**替换**（不是追加）需求分析那一席的前提下 —— 递单之后
         *   主对话**不能**再自己派需求位（那正是"递单"这个动作的意义）。
         *   编写 / 测试 / 审核 / 架构 / 计划等其余角色**一个都没进来**
         *   （★ 唯一的另一条口子见紧下面那段：**枢纽账本已授权**的席位 —— 那是 2026-10-16
         *     修 L5 死锁时补的，判据是 `task.hub`，不是调用方身份）。
         */
        const handedOver = task.state === ST.PENDING && task.hub?.entry !== null && task.hub?.entry !== undefined
        /**
         * ★★ **主管枢纽的席位**（2026-10-16，真缺陷：L5 死锁）。
         *
         * 病灶（真机 `T-20261016-fullai`，实测原文）：主管 `agree_need` 之后状态到了
         *   「架构位出图中」，而**架构位不存在**；这一刻 `pipeline_dispatch{role:'architect'}`
         *   被本行的白名单拒掉（"这个时候唯一能被派出去的角色是：需求分析"）。
         *   偏偏角色清单只能由**计划位**产出、计划位要唤醒点 B、唤醒点 B 要架构图、
         *   架构图要**架构位** ⇒ **环 = 死锁**（主对话只能干等 4 分 13 秒）。
         *
         * 修法：引导步的白名单**多出枢纽账本已经授权的那些席位** ——
         *   授权来源是 `task.hub`（`lib/tools/hub-seats.js` 的 `hubAuthorizedRoles`），
         *   不是调用方身份：
         *     · `hub.enabled` ⇒ 需求位（发起它的就是这个枢纽）；
         *     · `hub.standby[].status === 'woken'` ⇒ 那个席位（**到点了**才该有人）。
         *
         * ★ **为什么这不是"放宽成谁都能派"**（三条同时成立）：
         *   ① 账本**只有主管能写**（`by: ['supervisor']` + 具名事件 + `store.checkPrecondition`）
         *      ⇒ 主对话在这里不是"自己决定加人减人"，只是**执行主管已经登记的名单**；
         *   ② 仍然只在 `roster === null`（引导态）时生效；清单一旦产出，一律走下面
         *      "清单里没有就拒"那条通用门；
         *   ③ **调用方白名单一个字没动**（仍只有 main）—— 安全预审阻断项 B2 明令禁止
         *      把 `pipeline_dispatch` 的名单扩到 supervisor（见 `lib/guard/rules.js`）。
         *      所以这一处**没有**给主管任何新的调用面，它只是把"主管已经写到账本上的名单"
         *      变成"真的能被派出去"。
         */
        const hubAuthorized = hubAuthorizedRoles(task)
        const bootstrapBase = planningStage ? [ROLE.PLANNER] : handedOver ? [ROLE.SUPERVISOR] : [ROLE.ORCHESTRATOR]
        const allowedBootstrap = [...new Set([...bootstrapBase, ...hubAuthorized])]
        if (!allowedBootstrap.includes(role)) {
          return {
            ok: false,
            summary:
              `任务 ${task.id} 还没有角色清单（当前状态：${STATE_LABEL[task.state] ?? task.state}）。\n` +
              `这个时候唯一能被派出去的角色是：${allowedBootstrap.map(roleLabel).join(' / ')}。\n` +
              (hubAuthorized.length > 0
                ? `★ 其中有 ${hubAuthorized.map(roleLabel).join(' / ')} 是**主管枢纽账本**授权的（\`task.hub\`：已发起 + 到点唤醒）——` +
                  '主线上的席位由主管的具名动作直接拉起（`pipeline_supervise`），这里只是同一条授权面下的补派入口。\n'
                : '') +
              (planningStage
                ? '★ 需求已经过用户确认 —— 现在该出计划并分配 AI 了（planner 出清单）。'
                : handedOver
                  ? '★ 主对话已经把本单**递给主管**了（`hub.entry`）—— 现在该把**主管席位**派出去，由它发起枢纽（拉起需求 / 计划 / 架构三席）。'
                  : '★ 顺序是：**主对话递给主管**（pipeline_transition event=handoff_to_supervisor）→ 主管发起（pipeline_supervise action=initiate）→ 需求分析（出任务卡 + 不清楚处清单）→ **用户确认** → 计划（出角色清单）。') +
              '\n主对话不自行判断要调几个 AI。',
            agent_id: '', role, seat: '', token: '',
          }
        }
      }
      // ★ 只能派清单里有的角色
      if (task.roster !== null && !task.roster.conversations.includes(role)) {
        return {
          ok: false,
          summary:
            `拒绝派活：角色「${roleLabel(role)}」不在本任务的角色清单里。\n` +
            `当前清单（${task.roster.tier}，${task.roster.ai_count} 个独立对话）：${task.roster.conversations.map(roleLabel).join(' / ')}\n` +
            '★ 主对话不能自己决定加人减人。需要增减角色请走：执行角色 pipeline_roster_request 提出申请 → 编排角色 pipeline_roster_review 复核 → 按新清单派活。',
          agent_id: '', role, seat: '', token: '',
        }
      }
      if (role === ROLE.MAIN) {
        return { ok: false, summary: '主对话不需要被派出去 —— 它就是当前这个会话。', agent_id: '', role, seat: '', token: '' }
      }

      // ★ 需求档硬闸：**没有留档就不许开工**。
      //
      //   放在"派活"这一步（而不是编排那一步），是因为**分发任务才是真正的开工动作** ——
      //   编排可能先出清单、过一会儿才派人，中间档被删掉了也该拦住。
      //
      //   ★ 豁免**计划 AI**、**需求分析**、**留档 AI** 与**主管**：
      //     · 计划 AI 要先跑完，角色清单与需求档才产得出来 —— 卡它就死锁；
      //       （派 planner → 被"没有档"拒 → 永远产不出档）
      //     · 需求分析要先跑完，才有东西可确认 —— 同理；
      //     · 留档 AI **就是产出需求档的人** —— 卡它同样死锁。
      //     语义上也对："开工"指的是干活，而这三位的活**就是**产出任务卡 / 计划 / 需求档。
      //
      //   ★★ P0-1 补上**主管**（第四条）：理由与上面三条**逐字同一条** —— 卡它就死锁。
      //     用户新口径第 1~2 跳是「主对话递给主管 → 主管拉起需求/计划/架构三席」，
      //     而需求档是**需求位 / 留档位**的产物。若主管席位被"没有留档就不许开工"卡住，
      //     就派不出主管 ⇒ 发不起枢纽 ⇒ 没有需求位 ⇒ **永远产不出需求档** —— 闭环死锁。
      //     ★ 主管是**控制位**（不写实现、不跑测试、不判通过，只做发起/确认/否掉），
      //       "开工"这个词对它本来就是另一个意思。豁免**只是**把这条死锁打开，
      //       没有给主管任何新的写入面或判定面（边界仍由 `roles.js` 的 writes 管）。
      //   ★★ 2026-10-16 第五条豁免：**枢纽唤醒点上的席位**（真缺陷：L5 死锁的**第二段**）。
      //
      //     现场（同一条死锁链的下一环，实测）：补齐引导步白名单之后，架构位的派活
      //     又被本闸拒掉 —— `拒绝分发任务：约定目录下没有需求档`。
      //     而 L1+ 的 `requirement.md` **只有留档 AI 能写**，留档 AI 又在**计划位产出的角色清单**里，
      //     计划位要唤醒点 B，唤醒点 B 要架构图，架构图要架构位
      //     ⇒ **同一个环，只是卡在了另一道闸上**。不补这一条，"唤醒点派人"在生产上照样走不通。
      //
      //     ★ 凭什么豁免（**不是**"枢纽的单就放行"，而是它拿出了比需求档更强的东西）：
      //       条件 = ① 这个角色在**枢纽账本授权**的名单里（`hubAuthorizedRoles`），
      //              **且** ② 第①道闸 `hub_station_need_agree` **当下就过**
      //              —— 它同时要求：**用户人工确认已答复**（`requirement_confirm_gate`
      //              读的是 `human_requests` 里那条 answered 的原话）**＋** 主管交过一份
      //              **绑定当前 `requirement_analysis` 交接物**的 `station_confirm{decision:'ok'}`。
      //       也就是说：这里放行的不是"还没确认的需求"，而是"已经过了用户与主管两道确认、
      //       并且有一份可追溯的需求结论交接物在盘上"的席位。
      //       `requirement.md` 要解决的问题（"什么都忘了之后还能还原要做什么"）在这一刻
      //       由 `handoffs/requirement_analysis` + `task.handoffs` 承担，且**更强**：
      //       它绑定了确认记录、用户答复与内容哈希。
      //     ★ 三条边界：**只**在引导态（`roster === null` 才走到这一段）生效；
      //       **只**对账本点名的角色生效；**没有**动 "tester/writer 等没有档就不许开工"。
      const hubWakeSeat =
        hubAuthorizedRoles(task).includes(role) &&
        (await store.checkPrecondition(task, 'hub_station_need_agree', {})).ok === true
      if (!hubWakeSeat && role !== ROLE.PLANNER && role !== ROLE.ORCHESTRATOR && role !== ROLE.ARCHIVIST && role !== ROLE.SUPERVISOR) {
        const chk = await store.checkRequirementDoc(task)
        if (chk.ok !== true) {
          return { ok: false, agent_id: '', role, seat: '', token: '', summary: chk.error }
        }
      }

      // ★ 编写席位的解析与校验。
      //
      // 主对话**只能派在册席位** —— 它不能自己加席位、也不能改分区范围。
      // 单席位（count=1）不传 seat 时自动落到 writer#1，与旧行为完全等价。
      let seat = null
      if (role === ROLE.WRITER) {
        const writers = task.roster?.writers ?? null
        const parts = Array.isArray(writers?.partitions) ? writers.partitions : []
        const inSeats = parts.length > 0 ? parts.map((p) => p.seat) : ['writer#1']
        const asked = typeof args.seat === 'string' && args.seat.length > 0 ? args.seat : null
        seat = asked ?? inSeats[0]
        if (!inSeats.includes(seat)) {
          return {
            ok: false,
            agent_id: '',
            role,
            token: '',
            seat,
            summary:
              `拒绝派活：席位「${seat}」不在本任务在册的编写席位里。\n` +
              `在册席位：${inSeats.join('、')}（各席位范围：\n${parts.map((p) => `  · ${p.seat}：${describeScopePaths(p.scope_paths)}`).join('\n') || '  · writer#1：整棵项目根'}）\n` +
              '★ 主对话不能自行加席位、也不能改分区 —— 编写怎么分是**计划 AI**（planner）按层定的产物。\n' +
              '要加/改席位：让执行角色走 pipeline_roster_request 提出，再由计划 AI 用 pipeline_roster_review 复核。',
          }
        }
      }

      // ★★ **reassign 先吊销旧席位的令牌**（2026-10-18 测试报告 P1-5）。
      //
      //   现场：`reassign:true` 派了新会话后，**旧会话仍在活动**，两个 tester 同时写
      //   `reports/tester/`，`tester-results.jsonl` 属另一个会话 —— 结论可能互相矛盾，
      //   而审核只能看到"目录里有结果"。改前这里只更新派活台账，**没有让旧席位停下**。
      //
      //   判据：旧席位的一切身份都来自令牌（`roleOfAgent`）。撤掉它之后，旧会话的
      //   任何写操作都会被守门以"没有身份"拒掉 —— 不是靠自然语言让它"自觉退出"。
      //   （`pipeline_succession` 早就有这条语义，`reassign` 补上同一件事。）
      let revokedOld = 0
      if (args.reassign === true) {
        try {
          const old = tokens.findSeat(task.id, role, seat)
          if (old !== null && typeof old.token === 'string' && old.token.length > 0 && tokens.revoke(old.token)) revokedOld = 1
        } catch {
          revokedOld = 0
        }
      }

      const spawn = args.spawn === undefined ? config.spawnRoles !== false : args.spawn === true
      let res
      /**
       * ★★ **四槽：声明 vs 事实**（缺陷 ②，真机 T-20261015-bb30bc）。
       *
       * 取完值之后再问一次"这跟名单里写的对得上吗"：
       *   · 名单里 **显式声明**（`origin: declared`）的槽 ⇒ 请求与它不符就**拒绝派活**
       *     （冻结的槽不许在派活那一刻悄悄换一档 —— 这正是 `compareDispatchSlots` 当初的判据）；
       *   · 名单里只是**占位默认值**（`origin: default`）⇒ 请求可以覆盖，但**记下来**
       *     （现场就是这种形状：名单说 read-only、实际生效 workspace-write，
       *      改前没有任何地方记这件事 ⇒ 读名单的人会得出相反的结论）。
       *
       * ★★ B 件（2026-10-16）：取值改走 {@link dispatchSlotPlan} —— 交给下面对
       *   `resolveEffectiveSlots` 的 `requested` 与它**逐字节相同**，只是多带一份
       *   "哪几槽是**按角色推导**出来的"，好让留痕里的 `origin` 说实话。
       */
      const slotPlan = dispatchSlotPlan(task, role, seat, args)
      const truth = resolveEffectiveSlots({
        roster: task.roster ?? null,
        role,
        seat,
        requested: slotPlan.slots,
        /**
         * ★★ B 件（2026-10-16 真机 `T-20261016-fullai`）：把**推导出来的**槽的来源
         *   一并交下去 —— `permission` 的兜底值是按**角色写入需求**算的
         *   （`lib/roster/permission-need.js`），不是"调用方显式给的"。
         *   不交它，下面 `recordDispatchSlots` 落盘的 `provenance.permission.origin`
         *   会是 `request` ⇒ 读审计的人会把"机制按角色给的档"读成"谁手工指定的档"。
         */
        origins: slotPlan.origins,
      })
      if (truth.blocked !== null) {
        return {
          ok: false,
          agent_id: '',
          role,
          seat: seat ?? '',
          token: '',
          summary: `拒绝派活：四槽与名单不符（槽：${truth.blocked.slot}）。\n${truth.blocked.reason}`,
        }
      }
      const slots = truth.slots
      /**
       * ★★ F12：把"要不要真的建会话"**明确带进 spec**，让通道自己守这条线。
       *
       * 改前是 `if (!spawn || !isSpawnableRole(role)) { spawnRole({...agentId:null}) }
       * else { spawnRole({...parent}) }` —— **两个分支调的是同一个方法**，
       * 只有 `parent` / `agentId` 两个字段不同，而 `SessionTransport.spawnRole`
       * 根本不看 `agentId` 就无条件 `create` ⇒ 用户传 `spawn=false` 时宿主照样建会话。
       *
       * ★ 为什么不让这里直接换成 ManualTransport：`spawn:false` 是**自测里普遍使用的**
       *   调用形态（约 40 处），而自测跑的是 `SimulatedTransport` —— 它本来就不建任何真实会话，
       *   还靠假会话 id 驱动状态机。把那些调用一律改道，等于为了修一条真机路径
       *   把整套自测的夹具语义换掉。所以判据下沉到"**真的会建东西的那两条通道**"里
       *   （Session / Subagent），它们才是"不许碰宿主"这条线的责任方。
       */
      const effectiveSpawn = spawn && isSpawnableRole(role)
      if (!effectiveSpawn) {
        res = await transport.spawnRole({ task, roster: task.roster, role, seat, spawn: false, agentId: null, ...slots })
      } else {
        /**
         * ★ WP-T：`reassign` 要一起带进 spec —— 官方 teammate 名字**同 Team 内永不重用**
         *   （事实 F4），所以"同一席位换个人"必须换个新名字（`-r2`、`-r3`）。通道侧
         *   只有拿到这个标志才能区分"复用既有 member"与"重派一个新 member"（01 §D5）。
         *   ★ 其余通道不读这个字段，行为不变。
         */
        res = await transport.spawnRole({ task, roster: task.roster, role, seat, spawn: true, parent: exec.agent, signal: exec.signal, reassign: args.reassign === true, ...slots })
      }
      if (res.ok !== true) {
        // ★ `seat ?? ''`：**不能**把裸 `seat` 交出去。
        //
        //   2026-10-11 事故现场：`seat` 只有 writer 分支才会被赋值，其余角色一直是
        //   `null`（见上面的 `let seat = null`）。这条失败分支一旦真的走到，返回体里
        //   就是 `seat: null`，而 output 声明是 `S('string')` ⇒ 宿主判
        //   `tool "pipeline_dispatch" returned invalid output: "value.seat" must be a string`，
        //   整份返回值被丢掉 —— 连 `summary` 里那句**真正的原因**（通道不可达 / 建会话失败）
        //   都一起消失，看起来就像"派活根本没生效"。
        //   声明里写的本来就是"非 writer 或单席位时为空串"，所以这里按声明补齐。
        return { ok: false, agent_id: res.agentId ?? '', role, seat: seat ?? '', token: res.token ?? '', summary: res.note }
      }

      // ★ **派活台账**：失联检测的计时起点。
      //
      //   为什么必须记：`pipeline_dispatch` 可能**成功**建出子会话、投递派活单、返回令牌，
      //   而那个子会话在第一步就静默死亡（2026-10-11 的事故：turn/start 之后 277 ms 报错，
      //   一句话没说）。没有台账，`pipeline_status` 就分不清"派出去了没人回"与"根本没派"——
      //   而任务就会永远停在「需求分析中」没人知道。
      //   只在 `res.ok === true` 之后记：派活失败不该留下会被误读成"它不回话"的记录。
      let warnLine = ''
      try {
        const rec = await store.recordDispatch(task.id, {
          role,
          seat: seat ?? null,
          agentId: res.agentId ?? null,
          /**
           * ★★ **会话 id 必须一起记**（A6 / A7 / A27 的落点）。
           *
           * 现场：需求分析连答三条澄清（`clarify:reply` ×3），等着的编写席
           * **一直没被叫醒，白等 30 分钟**；用户答复人工请求后机制如实报了
           * 「叫不醒发起席位」。反向投递（`nudgeSeat`）找会话时优先读
           * `session_id`，改前这里**没传** ⇒ 那一格恒为 null，只能退回 `agent_id`
           * —— 真实会话通道下两者同值，但**派活台账是跨进程的唯一线索**，
           * 少记一格就等于把"重启后还认不认得这个席位"押在另一个字段的巧合上。
           */
          sessionId: typeof res.sessionId === 'string' && res.sessionId.length > 0 ? res.sessionId : null,
          token: res.token ?? null,
          at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          atMs: Date.now(),
          /**
           * ★ WP-T：`via` 按**通道自报**（`res.via`）记，而不是按"有没有 spawn"猜。
           *   改前恒为 `spawn ? 'subagent' : 'manual'` —— Session 通道也被记成 subagent
           *   （既有小谎），team 通道更会被彻底记错，而审计、失联检测、`nudgeSeat` 都读这一格。
           *   通道不自报时保持改前的口径（逐字不变）。
           */
          via: res.via ?? (spawn ? 'subagent' : 'manual'),
        })
        if (rec.ok === true) indexTask(rec.task.id, rec.task)
      } catch (err) {
        // 台账记不上不该拦住派活本身（会话已经建好了）——但要**说出来**，不静默。
        warnLine = `⚠ 派活台账记录失败（失联检测对此席位不生效）：${String(err?.message ?? err)}\n`
      }

      // ★ 派活与状态推进合一：派出角色的同时把状态推到"正在做"。
      //   这样"待开发/开发中"之类的中转态不会因为人忘了点而卡住，
      //   也不会出现"派出去了但状态没动"的半截现场。
      const advanceEvent = dispatchEventFor(role, task.state)
      let advanced = null
      if (advanceEvent !== null) {
        const tr = await store.transition({ taskId: task.id, event: advanceEvent, actorRole: ROLE.MAIN, actorAgentId: actor.agentId, note: `派活给 ${role}` })
        if (tr.ok !== true) {
          // 派活会话已经建好了，但状态没推进 —— 明说，不假装成功。
          return {
            ok: false,
            agent_id: res.agentId ?? '',
            role,
            seat: seat ?? '',
            token: res.token ?? '',
            summary:
              `角色会话已建立（${res.agentId}），但状态推进失败：\n${tr.error}\n` +
              `令牌：${res.token}（已绑定到该会话）。请先用 pipeline_status 看清状态再决定下一步。`,
          }
        }
        advanced = { from: tr.from, to: tr.to }
        indexTask(tr.task.id, tr.task)
      }

      // ★ 设计目的（职责自限）：**派活时按计划给的边界派**。
      //
      //   计划里为每个执行角色写死了一张边界卡（only / not）。派活这一刻把它贴在
      //   派活单上 —— "别让谁顺手多干"就不再靠事后追责，而是**开工前就写明**。
      //
      //   ★★ 双轨派活（用户要求）：**审核与编写同时接任务** ——
      //     审核不是等产物到了才被唤起。它开工前就拿齐四样：
      //     ① 这次授权了什么（change_scope）；② 这次不许做什么（forbidden）；
      //     ③ 它的边界卡；④ 改动基线（前后版本对比的基准）。
      //     链路本身不变：编写 → 测试 → **才**交审核（状态机没动）。
      let boundaryNote = ''
      {
        const cards = Array.isArray(task.role_boundaries) ? task.role_boundaries : []
        // ★★ **B6：回执给出的边界卡必须是「所派席位」的那张**。
        //
        //   现场：`pipeline_dispatch { seat: "writer#3" }` 的回执给出的是**别人的**卡
        //   （实测连续 3 次复现）。根因是这里**只按角色名取卡** ——
        //   多席位时 role 恒为 `writer`，`find()` 命中的永远是第一张 ⇒ writer#3 拿到
        //   writer#1（或角色级）的那张卡，而它看起来完全正常，没人会发现。
        //
        //   修法两条：
        //     ① 取卡**先按席位**（`role_boundaries[].seat` 显式匹配），再退到角色级；
        //     ② 计划若为编写席位发了**逐席位**的卡、却偏偏没有本席位那张 ⇒ **报错**，
        //        不静默给角色卡（"给错卡"比"没有卡"危险得多：它看起来像已经安排好了）。
        const seatCard = seat === null
          ? null
          : cards.find((b) => String(b?.seat ?? '') === seat) ?? null
        const roleCard = cards.find((b) => String(b?.role ?? '') === role) ?? null
        const seatScoped = cards.filter((b) => String(b?.role ?? '') === role && String(b?.seat ?? '').length > 0)
        if (role === ROLE.WRITER && seat !== null && seatCard === null && seatScoped.length > 0) {
          return {
            ok: false,
            agent_id: res.agentId ?? '',
            role,
            seat,
            token: res.token ?? '',
            summary:
              `拒绝派活：计划为编写席位发了**逐席位**的边界卡，但**没有「${seat}」那一张**。\n` +
              `已发卡的席位：${seatScoped.map((b) => String(b?.seat)).join('、')}\n` +
              `角色级卡：${roleCard === null ? '（无）' : '有（但它不区分席位，不能顶替）'}\n` +
              '★ 为什么拒：给错卡比不给卡更危险 —— 它看起来像"已经安排好了"，' +
              '而席位会照着一张**别人的**边界干活。\n' +
              '下一步：让计划 AI 在 plan.payload.role_boundaries 里给这个席位补一张 `{ role, seat, only, not }`。',
          }
        }
        const card = seatCard ?? roleCard
        if (card !== null) {
          boundaryNote =
            `\n【你的边界卡（计划里写死的）】${roleLabel(role)}\n` +
            `  只做：${toStringArray(card.only).join('；')}\n` +
            `  不做：${toStringArray(card.not).join('；')}`
        } else if (Array.isArray(cards) && cards.length > 0 && role !== ROLE.MAIN) {
          // 有计划却找不到这个角色的卡：不该发生（setRoster 会核对覆盖性），
          // 但真发生了要**说出来**，不要静默派活。
          boundaryNote = `\n⚠ 计划里**没有**「${roleLabel(role)}」的边界卡（本应覆盖全部执行角色）—— 请让计划 AI 补上。`
        }

        // 双轨简报：**审核在开工前就拿到授权面 / 禁令 / 基线**
        if (role === ROLE.REVIEWER) {
          const scope = Array.isArray(task.change_scope) ? task.change_scope : []
          const base = store.currentBaseline(task)
          boundaryNote +=
            '\n\n★★ **开工前简报（双轨派活）** —— 你不是"等产物到了才被唤起"，' +
            '而是**和编写同时开工**，现在就拿齐判据：\n' +
            `  ① **这次授权了什么**（${scope.length} 条）：\n` +
            (scope.length === 0
              ? '     （本次任务没有授权面记录 —— 可能还没有计划）\n'
              : scope.map((e) => `     · ${e.id}　${e.action}　${e.path}　原因：${e.why}`).join('\n') + '\n') +
            '  ② **这次不许做什么**（越界清单）：\n' +
            (toStringArray(task.plan_forbidden).length > 0
              ? toStringArray(task.plan_forbidden).map((x) => `     · ${x}`).join('\n') + '\n'
              : '     （计划里没给 —— 请让计划 AI 补）\n') +
            '  ③ **你的边界卡**：见上（你只核对，不改任何东西）。\n' +
            (base === null
              ? '  ④ **改动基线**：**尚未记录** —— 没有基线就没法做前后版本对比。\n'
              : `  ④ **改动基线**：${base.baseline_id}（${base.file_count} 个文件，记于 ${base.taken_at}）。\n`) +
            '\n  ★ 你的**只读**是硬约束：除了自己的日志 ' +
            `.pipeline/<任务id>/reports/reviewer/reviewer.log 之外，任何位置都写不了。\n` +
            '  ★ 审核判定要按**前后版本对比**做：调 pipeline_change_audit 拿对照结论，' +
            '填进 review_verdict.change_audit。\n' +
            '  ★ 但**现在不要出审核结论**：链路是 编写 → 测试 → 才交审核（状态到了才轮到你判）。'
        }
      }

      /**
       * ★★ **把"这一次实际生效了什么档"落盘**（缺陷 ② 的如实登记半边）。
       *
       * 为什么必须记：`roster.slots` 是**声明表**。现场三席的 `permission` 在名单里
       * 全是 `read-only`（`origin: default` 的占位值），而实际生效的是主对话在派活时
       * 显式给的 `workspace-write` —— 改前**没有任何地方**记下这个覆盖，
       * 于是读名单的人只会得出"这三席只有只读权限"，与事实相反。
       *
       * 记不上**不拦派活**（会话已经建好了），但要**说出来**，不静默。
       */
      let slotNote = ''
      try {
        const rec = await store.recordDispatchSlots({
          taskId: task.id,
          role,
          seat: seat ?? null,
          slots,
          provenance: truth.provenance,
          divergences: truth.divergences,
          /**
           * ★ F11：把**每一槽的证据等级**一并落盘 —— `readback`（真读回并比对过）/
           * `requested`（只发了请求，**没有回读**）/ `readback_unavailable`（想读但宿主没接口）。
           * 不落这个，"实际生效值"就会被读成"四槽都确认过了"，而 model / reasoning 从来没回读过。
           */
          evidence: res.slotEvidence ?? null,
          actorRole: ROLE.MAIN,
          actorAgentId: actor.agentId,
        })
        if (rec.ok === true) indexTask(rec.task.id, rec.task)
      } catch (err) {
        slotNote = `\n⚠ 四槽实际生效值**没能落盘**（读名单的人仍会看到占位值）：${String(err?.message ?? err)}\n`
      }
      const divergenceNote = describeSlotDivergence(truth.divergences)

      return {
        ok: true,
        agent_id: res.agentId ?? '',
        role,
        seat: seat ?? '',
        token: res.token ?? '',
        summary:
          `${warnLine}` +
          (revived === null
            ? ''
            : `★ **席位失联重派**：任务已从「已阻塞」恢复到「${STATE_LABEL[revived.to] ?? revived.to}」（**没有消耗打回预算** —— 席位死亡不是任何角色的错）。\n`) +
          (revokedOld > 0
            ? '★ **已吊销旧席位的令牌**：旧会话之后的任何写操作都会被守门以「没有身份」拒掉 —— 不会出现两个席位同时写同一目录。\n'
            : '') +
          `已派出「${roleLabel(role)}」。\n${res.note}\n` +
          /**
           * ★ WP-T（01 §D9）：team 通道派出去的是**官方 Team member**（`list_agents` 里可见），
           *   所以"等它的变化"应当用官方 `wait_agent`，而不是让主对话反复 `pipeline_status` 轮询。
           *   ★ 只在 team 通道出现这一句 —— 别的通道下面没有这些官方工具，提了就是误导。
           */
          (res.via === 'team'
            ? '★ 该席位是**官方 Team member**（`list_agents` 里可见、可用 `send_message` 直接对话）：' +
              '等它的变化用 `wait_agent`（10s–1h，**不必**轮询 `pipeline_status`）；' +
              '`wait_agent` 立刻返回「无进展」只说明队里暂时没有别的 running/provisioning 成员，**不代表**该席位失败。\n'
            : '') +
          (advanced === null ? '' : `任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。\n`) +
          (args.note ? `补充说明：${args.note}\n` : '') +
          slotNote +
          (divergenceNote.length > 0 ? `\n${divergenceNote}\n` : '') +
          boundaryNote +
          `\n该角色令牌：${res.token}。` +
          // ★ 派活这一刻就把"失联检测已武装"告诉主对话 —— 它才知道多久之后该回来看。
          `\n★ 已记派活台账（失联检测的计时起点）：该席位若在 ${formatDuration(
            Number.isInteger(deps.config?.seatSilenceMs) && deps.config.seatSilenceMs > 0
              ? deps.config.seatSilenceMs
              : DEFAULT_SEAT_SILENCE_MS,
          )}内**毫无动静**（0 交接物 / 0 流水 / 0 水位自报），机制会把它判为**失联**并自动把任务推到「已阻塞」。` +
          '\n（判据见 lib/liveness.js：只有"轮到场了"的角色才会被判失联 —— 双轨派活下审核不会因此被误报。）',
      }
    },
  })

  // =========================================================================
  // 4. pipeline_bind_role —— 角色会话认领身份
  // =========================================================================
  const bindRole = tool(deps, {
    name: 'pipeline_bind_role',
    mutating: true,
    description:
      '角色会话用令牌认领自己的角色：调用一次之后，本会话与该角色锁死（一个会话在同一任务里只能担任一个角色）。' +
      '这是守门能拦住"测试改代码""编写提交审核"的前提 —— 绑定之后，文件工具与 shell 的越权判定才有依据。' +
      'transport=subagent 时令牌已自动绑定，通常不需要显式调用。',
    parameters: {
      role_token: S('string', '主对话派活时给你的令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      role: S('string', '绑定到的角色'),
      task_id: S('string', '任务 ID'),
      agent_id: S('string', '本会话 id'),
    },
    async run(args, exec) {
      const agentId = agentIdOf(exec)
      if (agentId === null) {
        return {
          ok: false, role: '', task_id: '', agent_id: '',
          summary:
            '无法绑定：当前调用没有会话身份（exec.agent 为空）。\n' +
            '这通常意味着你在一条没有 Agent 上下文的链路上调用（例如 PTC 子调用或外部脚本）。\n' +
            '这种情况请改用带 role_token 的调用方式，守门会按令牌角色判定。',
        }
      }
      const declared = String(args.role_token ?? '')
      const r = tokens.resolve(declared, {})
      if (r.ok !== true) return { ok: false, role: '', task_id: '', agent_id: agentId, summary: r.error }
      const b = tokens.bindAgent(declared, agentId)
      if (b.ok !== true) return { ok: false, role: '', task_id: '', agent_id: agentId, summary: b.error }

      const task = await load(r.rec.taskId)
      if (task !== null) indexTask(task.id, task)
      return {
        ok: true,
        role: r.rec.role,
        task_id: r.rec.taskId,
        agent_id: agentId,
        summary:
          `已绑定：本会话（${agentId}）＝ 任务 ${r.rec.taskId} 的「${roleLabel(r.rec.role)}」。\n` +
          `职责：${ROLES[r.rec.role]?.summary ?? ''}\n` +
          '从现在起，越权动作（例如测试角色改项目源码、编写角色直接提交审核）会被守门拦下。',
      }
    },
  })

  return { dispatchSlots, dispatch, bindRole }
}
