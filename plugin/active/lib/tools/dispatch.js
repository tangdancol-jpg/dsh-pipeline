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
import { rosterSlotDeclarations } from '../tiers.js'
import { DISPATCH_SLOT_KEYS, isSpawnableRole } from '../transport/index.js'
import { toStringArray } from '../util.js'
import { S, tool, resolveActor, dispatchEventFor } from './kit.js'

/**
 * 派活与角色认领（pipeline_dispatch / pipeline_bind_role）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildDispatchTools(ctx) {
  const { deps, config, store, tokens, transport, indexTask, notifyOnly, load } = ctx

  /**
   * ★ **四槽下发**（权限档 / 模式 / 模型 / 推理等级）—— 四个**独立顶层字段**，绝不打包。
   *
   * 为什么必须在这里补这一手（这是「四槽被丢弃」的唯一现场）：
   *   通道侧（`lib/transport/index.js`）的四槽落地**早就齐了** ——
   *   `normalizeSlots` → `create({agentPreset})` → `permissionPresets.set` + 读回核对 →
   *   `selectModel` + 全局默认还原。但**派活这一端从来没把四槽交出去过**：
   *   `transport.spawnRole(spec)` 的 spec 里只有 `task / roster / role / seat`，
   *   于是 `normalizeSlots(spec, 兜底)` 四槽**全部落进兜底分支** ——
   *   权限恒为最小档、模式恒为配置默认、模型与推理等级恒为「未指定 ⇒ 不调 selectModel」。
   *   表现出来就是：名单里写了「工作区」，开出来的会话还是只读 ⇒ 编写席写不了盘。
   *
   * 取值优先级（**逐槽独立判定，不做归一、不做近似、不做四槽之间的合并**）：
   *   ① 本次请求显式给的（`args.permission` / `args.mode` / `args.model` / `args.reasoning`）；
   *   ② 名单里为该**席位**（`roster.writers.partitions[].seat`）或该**角色**
   *      （`roster.sequence[].role`）声明的同名字段；
   *   ③ 都没有 ⇒ **返回 `undefined`**（= 这一槽没给），交给通道按契约取兜底并留痕：
   *      权限落最小档 `read-only`、模式落 `config.sessionPreset`、模型 / 推理等级落环境枚举默认档。
   *
   * ★ 本函数**只读不写**：不新建名单结构、不改名单字段、不做「请求 vs 名单是否相等」的判定
   *   （那条判据是 B2，属守门层，不在本文件）。名单里没有这四个键时它是个空操作 ——
   *   这正是「名单槽位尚未落地时，行为与改造前逐字节等价」的保证。
   */
  function pickRosterSlots(roster, role, seat) {
    // ★ 2026-10-14（1d 复测）：取值**收敛到唯一一处** —— `tiers.rosterSlotDeclarations`。
    //
    //   改前的实现在本文件里又抄了一份"从名单取值"的逻辑，而它只读
    //   `roster.writers.partitions[].seat` 与 `roster.sequence[].role` 两处**裸字段**；
    //   这两处**从来不承载四槽**（`sequence[]` 是 `{role,phase,order,requires}`、
    //   `partitions[]` 是 `{seat,role_id,layer,scope_paths,interface_owner,deliverables}`）
    //   ⇒ 取值永远 undefined ⇒ **模式恒为全局那一个默认值**，
    //   `roster.slots` 那张权威冻结表**没有任何派活路径读它**。
    //   ⇒ 「一个 AI 一个专属模式」在数据上无法成立（1d 长期标「未核实」的实质）。
    //
    //   现在改为：权威表里 **origin==='declared'** 的槽优先，再退两处裸声明。
    //   名单没有四槽时返回 `{}` ⇒ 与改造前**逐字节等价**（仍走通道兜底 + 留痕）。
    return rosterSlotDeclarations(roster, role, seat)
  }

  /** 四槽取值（见 {@link pickRosterSlots}）；返回值永远是四个**分开的**键。 */
  function dispatchSlots(task, role, seat, args) {
    const fromRoster = pickRosterSlots(task === null || task === undefined ? null : task.roster, role, seat)
    const out = {}
    for (const k of DISPATCH_SLOT_KEYS) {
      const asked = args === null || args === undefined ? undefined : args[k]
      out[k] = typeof asked === 'string' && asked.length > 0 ? asked : fromRoster[k]
    }
    return out
  }

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
       * 名单里也没有 = 交给通道取兜底并留痕（权限落最小档 read-only、模式落配置默认、
       * 模型 / 推理等级落环境枚举默认档）。名单是四槽的唯一权威，这里只做消费。
       */
      permission: S('string', '★四槽①权限档（四槽分开传，不许打包）：read-only / workspace-write / danger-full-access。「完全」档默认禁用，须三段齐（需求分析→主对话→用户判定）否则拒绝'),
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
      if (task === null) return { ok: false, summary: `找不到任务 ${args.task_id}。`, agent_id: '', role: '', token: '' }
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
         *   编写 / 测试 / 审核 / 架构 / 计划等其余角色**一个都没进来**。
         */
        const handedOver = task.state === ST.PENDING && task.hub?.entry !== null && task.hub?.entry !== undefined
        const allowedBootstrap = planningStage ? [ROLE.PLANNER] : handedOver ? [ROLE.SUPERVISOR] : [ROLE.ORCHESTRATOR]
        if (!allowedBootstrap.includes(role)) {
          return {
            ok: false,
            summary:
              `任务 ${task.id} 还没有角色清单（当前状态：${STATE_LABEL[task.state] ?? task.state}）。\n` +
              `这个时候唯一能被派出去的角色是：${allowedBootstrap.map(roleLabel).join(' / ')}。\n` +
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
      if (role !== ROLE.PLANNER && role !== ROLE.ORCHESTRATOR && role !== ROLE.ARCHIVIST && role !== ROLE.SUPERVISOR) {
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
              `在册席位：${inSeats.join('、')}（各席位范围：\n${parts.map((p) => `  · ${p.seat}：${(p.scope_paths ?? []).map((s) => (s === '.' ? '整棵项目根' : s)).join('、')}`).join('\n') || '  · writer#1：整棵项目根'}）\n` +
              '★ 主对话不能自行加席位、也不能改分区 —— 编写怎么分是**计划 AI**（planner）按层定的产物。\n' +
              '要加/改席位：让执行角色走 pipeline_roster_request 提出，再由计划 AI 用 pipeline_roster_review 复核。',
          }
        }
      }

      const spawn = args.spawn === undefined ? config.spawnRoles !== false : args.spawn === true
      let res
      // ★ 四槽下发：四个独立顶层字段原样交给通道（不打包、不归一、不合并）。
      const slots = dispatchSlots(task, role, seat, args)
      if (!spawn || !isSpawnableRole(role)) {
        res = await transport.spawnRole({ task, roster: task.roster, role, seat, agentId: null, ...slots })
      } else {
        res = await transport.spawnRole({ task, roster: task.roster, role, seat, parent: exec.agent, signal: exec.signal, ...slots })
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
          via: spawn ? 'subagent' : 'manual',
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
          `已派出「${roleLabel(role)}」。\n${res.note}\n` +
          (advanced === null ? '' : `任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。\n`) +
          (args.note ? `补充说明：${args.note}\n` : '') +
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
