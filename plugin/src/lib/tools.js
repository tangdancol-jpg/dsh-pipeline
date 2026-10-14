/**
 * dsh-pipeline · 工具面
 * ============================================================================
 * 二十六个工具，覆盖需求原文点名的全部动作：
 *   创建任务 → 输出/读取编排角色清单 → 状态迁移 → 生成与校验各环节结构化
 *   交接物 → 查询状态 → 打回 → 关单（关单校验审核 OK）
 *
 * ---------------------------------------------------------------------------
 * ★ 三个 defineTool 的硬约束（读 `dsh-tools/lib/index.js` 得到，写错就直接不注册）
 * ---------------------------------------------------------------------------
 *   ① `output` 是**必填**，且 `output.render` 必须是函数（`:842` 无条件读它）。
 *   ② `output.schema` 的对象根**必须显式写 `additionalProperties: false`**，
 *      否则 `compilePropertyMap` 直接 authorError（`:699`）。
 *   ③ `parameters` 是「属性名 → 值 schema」的映射，`required` 只能写在**属性**上
 *      且值必须是 `true`（`:603-604`）；根上不允许写 `required`。
 *
 * ★ 「拒绝」的表达方式：
 *   `execute` 返回 `{ok:false}` **不是错误**（注册表根本不看 `ok`）。所以每一次
 *   拒绝都是**正常返回值**，靠 `output.render` 把拒绝原文交给模型；真正在
 *   dispatch 之前拦住的是 `lib/guard.js` 里那层 `tools.guard`。
 *
 * @module dsh-pipeline/lib/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { HANDOFF_SCHEMAS, HUMAN_DECISION_KINDS, HUMAN_REASON_KINDS, HUMAN_TIMEOUT_BEHAVIORS, HUMAN_URGENCIES } from './handoff.js'
import { ROLE, ROLES, roleLabel } from './roles.js'
import { ROLES_CAN_ASK_CLARIFICATION, ROLES_CAN_RAISE_HUMAN, ST, STATE_LABEL, HUB_STATIONS, HUB_STATION_REJECT_BUDGET, HUB_STATION_REJECT_EVENTS, HUB_WAKE_POINTS, HUB_STANDBY_SEATS, HUB_DIAGRAM_REDRAW_BUDGET, HUB_HANDOFF_CONFIRM_EVENTS, HUB_HANDOFF_CONFIRM_ORDER, HUB_HANDOFF_CONFIRM_STATIONS } from './states.js'
import { checkSuccessionActor, renderRequirementDoc } from './context.js'
import { renderScanSummary, runSecurityScan } from './security.js'
import { NO_CODE_READ_ROLES, agentIdOf } from './guard.js'
import { boundaryManifest, renderBoundaryManifest } from './boundaries.js'
import { fullTestCredential, nextFullTestStage } from './testscope.js'
import { DEFAULT_SEAT_SILENCE_MS, describeSilentSeats, formatDuration, nextActionsFor, seatLiveness } from './liveness.js'

/** 审批链站名 → 人话（pipeline_full_test 用）。 */
export const FULL_TEST_STAGE_ZH = {
  'tester-request': '还没起链 —— 由 tester 交 full_test_request',
  'orchestrator-need': '① 需求分析（这次是否需要）',
  'reviewer-worth': '② 审核（值不值得）',
  'main-to-human': '③ 主对话 → 用户人工审核',
  'planner-arrange': '④ 计划 AI（怎么跑、范围与最终命令）',
  done: '四级齐了 —— 可以跑（守门按批准的那条命令放行）',
  stopped: '链路已停（有人否决）—— 要跑得重新提一条',
}

/** 站名 → 人话。 */
function describeStage(stage) {
  return FULL_TEST_STAGE_ZH[stage] ?? String(stage ?? '')
}
import { L5_EXTENSION_POOL, TIERS, TIER_ORDER, buildRoster, proposeTier, rosterSlotDeclarations, validateRoster } from './tiers.js'
import { DISPATCH_SLOT_KEYS, isSpawnableRole } from './transport/index.js'
import { clamp, clip, fullHash, toStringArray } from './util.js'

/** 输出 schema 的常用片段。 */
const S = (type, description, extra = {}) => ({ type, description, ...extra })

/**
 * `output.schema` 的对象根 —— **spec 形态**（`defineTool` 正常时走这条）。
 *
 * 每个属性带布尔 `required: true`：宿主 `valueSchemaSpecToJsonSchema` 只认
 * 这个 DSL，它**明确拒绝**对象层的 `required` 数组
 * （`schema.required is not supported by the value schema DSL`），
 * 要归一化之后才变成真正的 JSON Schema。
 */
function objSchema(properties) {
  const props = {}
  for (const [k, v] of Object.entries(properties)) props[k] = { ...v, required: true }
  return { type: 'object', additionalProperties: false, properties: props }
}

/**
 * `output.schema` 的对象根 —— **严格 JSON Schema**（`defineTool` 退化时走这条）。
 *
 * 宿主注册表 `Tools.register()` 会拿 `assertSupportedJsonSchema(output.schema)`
 * 卡一道，它只认对象层的 `required` **字符串数组**；属性上的布尔 `required`
 * 会被判 `required is not supported on type "..."` 并**抛错**。
 *
 * 退化时没有归一化那一步，所以定义必须自己就是合法的 —— 否则第一个
 * `ctx.tools.register()` 就抛，守卫、拦截缝、开关路由、prompt 段**全都挂不上**
 * （表现出来就是"插件完全没加载"）。
 */
function objSchemaStrict(properties) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(properties)) {
    const { required: _ignored, ...rest } = v
    props[k] = rest
    required.push(k)
  }
  return { type: 'object', additionalProperties: false, properties: props, required }
}

/**
 * `parameters` 的**严格 JSON Schema** 形态（只在退化时用）。
 *
 * 正常时交的是裸属性表（宿主 `parameterSchemaSpecToJsonSchema` 要的就是它，
 * 喂 `{type:'object',properties}` 会把 `type` 当参数名并抛
 * `parameters.type must be a value schema object`）；
 * 但退化时没有那一步，裸属性表会原样进注册表 —— 属性名被当成 schema 关键字，
 * 模型侧拿到的入参定义就是坏的。所以这条路必须自己补齐 type/properties。
 */
function paramSchemaStrict(parameters) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = v
    props[k] = rest
    if (isRequired === true) required.push(k)
  }
  const schema = { type: 'object', properties: props }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * 「可空」的值 schema：`oneOf: [X, null]`。
 *
 * 为什么不用 `type: [X, "null"]`：宿主只认 schema 子集，**type 数组被明确拒绝**
 * （`dsh-tools/lib/index.js:237`：`type arrays are not supported`），
 * 而 `oneOf` 它支持（`:430` 起，语义是"恰好命中一支"）。
 * 两条路都收：spec DSL 与退化时的严格 JSON Schema 都只是原样透传这个节点。
 */
function SNullable(type, description, extra = {}) {
  return { description, oneOf: [{ type, ...extra }, { type: 'null' }] }
}

/**
 * 一个字段的**空值** —— 按它自己的 schema 推，保证推出来的值一定能通过校验。
 *
 * `oneOf` 里只要有一支是 `null`（`SNullable` 造的就是），空值取 `null`；
 * 否则取第一支。
 */
function blankOf(node) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.some((branch) => branch?.type === 'null')) return null
    return blankOf(node.oneOf[0])
  }
  switch (node.type) {
    case 'boolean':
      return false
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'array':
      return []
    case 'object':
      return {}
    default:
      // null / json / 认不出的节点：null 是唯一一定合法的取值。
      return null
  }
}

/**
 * 把工具的返回值**补全成 `output` 声明的形状**。
 *
 * 为什么必须有这一步（这是踩过的坑，不是洁癖）：
 * 本插件把 `output` 的**每个字段都声明成必填**（见 `objSchema` / `objSchemaStrict`
 * 的注释），而 `tool()` 的包装层有两条只返回 `{ ok, summary }` 的路径
 * （开关关闭的拒答、内部异常），`run()` 实现里也大量存在"参数不全就早退"的
 * 短返回值。声明与返回值一旦对不上，宿主会在**执行期**把整次调用判成
 * `INVALID_TOOL_OUTPUT`（`dsh-tools/lib/index.js:3543-3544`）——
 * 报文形如 `missing required property "value.hash_gate"`，
 * 而这一点**注册期完全看不出来**。
 *
 * 所以归一化放在 `tool()` 的**唯一出口**上：不管从哪条路径返回，
 * 出去的值都满足自己声明的契约。规则三条：
 *   ① 声明了的字段一定有值（缺的补类型空值）；
 *   ② `undefined` 视为没给（宿主把 `undefined` 当缺字段，`index.js:456`）；
 *   ③ 没声明的键丢掉 —— 宿主 `additionalProperties: false` 本来就会拒它，
 *      丢掉等于把契约执行到底，而不是让整次调用失败。
 *
 * @param {object} output - `spec.output`（字段名 → 值 schema）
 * @param {unknown} value - `run()` / 包装层要返回的值
 * @returns {object} 恰好等于声明形状的纯 JSON 对象
 */
function normalizeOutput(output, value) {
  const declared = output !== null && typeof output === 'object' ? output : {}
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = {}
  for (const [key, node] of Object.entries(declared)) {
    const v = source[key]
    out[key] = v === undefined ? blankOf(node) : v
  }
  return out
}

/** 统一 render：把 `summary` 交给模型（拒绝与成功都走这条路）。 */
const renderSummary = (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }]

/**
 * 组装一个工具定义（把 defineTool 的样板收敛到一处）。
 *
 * ★ 这里是**功能开关**的第二个执法点（第一个是 `lib/guard-factory.js`）：
 *   `mutating: true` 的工具在开关关闭时**直接拒绝**，连 store 都不碰。
 *   为什么两处都要判：守门管的是"越权"，开关管的是"这功能本身开没开"，
 *   两者是正交的。而且守门对**没有身份**的调用方是放行的（守门只约束流水线
 *   参与者），所以关掉之后光靠守门拦不住"开单"这类动作 —— 必须在工具层再判一次。
 */
/**
 * ★★ **记下"主对话在这个会话里"**（交付即唤醒的第四步要用的那一份输入）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是这里
 * ---------------------------------------------------------------------------
 * 唤醒消息必须投到**主对话所在会话**，而这个 id **只有主对话自己调用插件工具时**
 * 才拿得到（`exec.agent.id`，见 `guard.js` 的 `agentIdOf`）。所以挂在
 * {@link tool} 的**唯一出口**上：任何一次 pipeline 工具调用都会顺手记一次。
 *
 * 两条纪律：
 *   · **只有主对话记** —— 席位的会话 id 不是唤醒目标（投错了主对话还是收不到）；
 *   · **不抛** —— 记账失败绝不能把这次工具调用带崩（唤醒是副作用，不是判据）。
 *
 * ★ 登记表有两层：内存（`deps.wakeup.registry`，进程内即查即用）+ 落盘
 *   （`task.contacts.main`，进程重启后 `pipeline_contacts` 还能查到）。
 *   只在**发生变化**时才落盘 —— 别让每次工具调用都写一次任务文件。
 *
 * @param {object} deps
 * @param {object} exec
 * @returns {boolean} 是否真的记下了（测试用）
 */
export function rememberMainCaller(deps, exec, opts = {}) {
  if (deps === null || deps === undefined) return false
  const wakeup = deps.wakeup
  if (wakeup === null || wakeup === undefined || typeof wakeup.rememberMain !== 'function') return false
  const tokens = deps.tokens
  if (tokens === null || tokens === undefined) return false
  const agentId = agentIdOf(exec)
  if (agentId === null) return false

  /**
   * ★★ **这个会话手上的每一张"我是主对话"的单** —— 一张都不能漏。
   *
   * 2026-10-11 的现场（用户原话："唤醒从约 22:17 之后就不响了"）就出在这里：
   * 原来这里写的是 `tokens.roleOfAgent(agentId)`，而它是按 `Map` 插入顺序返回
   * **第一条**命中 —— 主对话会话为每一张开过/认领过的单都持有一枚 `main` 令牌，
   * 于是它永远返回**最早那张单**。结果：`rememberMain` 每次都在刷新老单，
   * **新单的 `task.contacts.main` 一个字节都落不下来**，新单的交付唤醒全部
   * `wake:skipped / no-main-session`（老单却一切正常，特别像"某个时间点之后
   * 突然坏了"，其实是"之后开的新单都没登记过"）。
   *
   * 修法：**不做取舍**，把该会话手上的主对话任务**全部**登记一遍。
   * 这同时就是"自愈"—— 主对话换了会话 id（重开 / 重启 / 重新认领）之后，
   * 它**下一次**调用任何 pipeline 工具就会把新会话 id 覆盖进每一张单的
   * `contacts.main`（`store.rememberMainContact` 认的是"值变了才写盘"，
   * 没变就是零成本的空转）。
   *
   * 为什么不是"从 `args.task_id` 里取"：那个字段**不是每个工具都有**
   * （`pipeline_selftest` / `pipeline_switch` 就没有），漏一条路径就漏一张单。
   * 令牌表才是"这张单的主对话是谁"的**权威来源**（它是 `task_open` / `reattach`
   * 亲手铸的），不在参数字符串上赌。
   */
  let taskIds = []
  try {
    taskIds = typeof tokens.tasksOfAgent === 'function'
      ? tokens.tasksOfAgent(agentId, ROLE.MAIN)
      : // 退化路径：宿主加载的是旧版 tokens（热替换的半途状态）时，退回老行为，
        // 至少不比改之前差；不做猜测式的补全。
        (() => {
          const one = tokens.roleOfAgent(agentId, undefined)
          return one !== null && one !== undefined && one.role === ROLE.MAIN ? [one.taskId] : []
        })()
  } catch {
    return false
  }
  if (!Array.isArray(taskIds) || taskIds.length === 0) return false

  let any = false
  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || taskId.length === 0) continue
    try {
      // ★ 一张单失败不影响其它单 —— 唤醒是副作用，不是判据。
      if (wakeup.rememberMain(taskId, agentId, 'tool-call') === true) any = true
    } catch {
      void 0
    }
    /**
     * ★★ **A28(c)：主对话的"接管"留痕。**
     *
     * 「送达 ≠ 接管」的主对话侧判据是：**目标确实据此推进了**
     * （状态迁移 / 派活 / 答复），或者明确回复"已收到但不推进"并留下可见留痕。
     * 所以这里**只认会改状态的那类工具**（`opts.mutating === true`）——
     * 一次 `pipeline_status` 只读查询**不算**接管，把它算进去就会把
     * "18 小时零动作"洗成"已接管"，A28 当场失效。
     */
    if (opts.mutating === true && typeof wakeup.markConsumed === 'function') {
      try {
        wakeup.markConsumed(taskId, { by: 'main', action: String(opts.action ?? 'tool-call') })
      } catch {
        void 0
      }
    }
  }
  return any
}

function tool(deps, spec) {
  const { defineTool, sw, defineToolDegraded } = deps

  /**
   * schema 形态**随 defineTool 是否退化而变** —— 两边契约本来就不同，不是权宜之计：
   *
   *   · `defineTool` 正常 —— 入参交**裸属性表**、输出交**带布尔 required 的 spec**
   *     （宿主那对 `*SpecToJsonSchema` 只认这个 DSL；喂归一化后的形态会抛
   *     `parameters.type must be a value schema object` /
   *     `schema.required is not supported by the value schema DSL`）。
   *   · `defineTool` 退化 —— 没有归一化那一步，定义必须**自己就是严格 JSON Schema**，
   *     否则 `Tools.register()` 的 `assertSupportedJsonSchema` 会在第一个工具上抛，
   *     守卫 / 拦截缝 / 开关路由 / prompt 段就全都挂不上。
   *
   * 两条路都用真实宿主实现实测过：正常路与改动前**逐字节一致**，退化路 29/29 合法。
   */
  const degraded = defineToolDegraded === true
  const parametersFor = (s) => (degraded ? paramSchemaStrict(s.parameters) : s.parameters)
  const outputSchemaFor = (s) => (degraded ? objSchemaStrict(s.output) : objSchema(s.output))

  /**
   * ★ 出口归一化（唯一出口，见 `normalizeOutput` 的注释）。
   *   下面三条 return 全都要过它 —— 少过一条，那条路径就又变成宿主眼里的
   *   `INVALID_TOOL_OUTPUT`。测试 `tests/output-check.mjs` 专门盯这件事。
   */
  const shape = (value) => normalizeOutput(spec.output, value)

  /** 开关关闭时的统一拒绝文案。 */
  const offRefusal = () =>
    '[pipeline] 多 AI 协调功能当前是**关闭**状态，本动作不会执行。\n' +
    `工具：${spec.name}\n` +
    '怎么恢复：把 DSH 窗口右上角头部那一排里的「多AI 协调」开关点成「开」，' +
    '或者让主对话调用 pipeline_switch { on: true }，或者调用 pipeline_switch 不带参数直接翻转。\n' +
    '关闭状态下仍然可用的是只读动作：pipeline_status（查历史任务）、pipeline_switch（看/改开关）、pipeline_selftest（自检）。'

  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: parametersFor(spec),
    output: { schema: outputSchemaFor(spec), render: renderSummary },
    async execute(args, exec) {
      try {
        if (spec.mutating === true && sw !== undefined && sw !== null && sw.isOn() !== true) {
          return shape({ ok: false, summary: offRefusal() })
        }
        const out = shape(await spec.run(args ?? {}, exec))
        // -----------------------------------------------------------------
        // ★★ 交付即唤醒 · **第四步的输入**：记下主对话在哪个会话里。
        //
        //   为什么必须挂在**唯一出口**上（而不是散在各工具里）：
        //   唤醒要投到"主对话所在会话"，而那个 id **只有主对话自己调用工具时**
        //   才拿得到（`exec.agent.id`）。任何一个 pipeline 工具漏掉这一句，
        //   那条路径上的交付就会变成"知道该唤醒、但不知道投给谁"。
        //
        //   为什么放在 `run()` **之后**：`pipeline_task_open` / `reattach` 是在
        //   `run()` **里面**才铸主对话令牌并绑定会话的 —— 放在前面那一瞬间
        //   `roleOfAgent` 还查不到它。
        //
        //   ★ 不抛：记账失败绝不能把这次工具调用带崩（唤醒是副作用，不是判据）。
        // -----------------------------------------------------------------
        try {
          rememberMainCaller(deps, exec, { mutating: spec.mutating === true, action: spec.name })
        } catch (err) {
          // 静默降级：唤醒是"能更好"，不是"没它就不对"。
          void err
        }
        return out
      } catch (err) {
        // 不抛：抛出去会被注册表变成通用 tool error，丢掉我们的可读理由。
        return shape({ ok: false, summary: `[pipeline] 内部错误（这是插件 bug，不是你的操作问题）：${String(err?.stack ?? err)}` })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 调用方身份解析
// ---------------------------------------------------------------------------

/**
 * 解析"谁在调用"。
 *
 * 优先级：**会话绑定 > 参数里的 role_token**。
 * 会话绑定优先是有意的 —— 令牌可以被转手，绑定不能。一个已经绑定了角色的
 * 会话，拿别人的令牌来调也只会按自己的角色算。
 *
 * @returns {{ok:true, role:string, agentId:string|null, via:string} | {ok:false, error:string}}
 */
export function resolveActor(args, exec, deps) {
  const agentId = agentIdOf(exec)
  const bound = agentId === null ? null : deps.tokens.roleOfAgent(agentId, undefined)

  const declared = typeof args?.role_token === 'string' && args.role_token.length > 0 ? args.role_token : ''
  if (declared.length > 0) {
    const r = deps.tokens.resolve(declared, {
      taskId: typeof args?.task_id === 'string' && args.task_id.length > 0 ? args.task_id : undefined,
      agentId: agentId ?? undefined,
      requireAgentBinding: deps.config?.requireAgentBinding === true,
    })
    if (r.ok !== true) return { ok: false, error: r.error }
    if (bound !== null && bound.role !== r.rec.role) {
      return {
        ok: false,
        error:
          `身份冲突：本会话已经绑定为任务 ${bound.taskId} 的「${roleLabel(bound.role)}」，` +
          `但这次带的 role_token 属于「${roleLabel(r.rec.role)}」。一个会话在同一任务里只能担任一个角色。`,
      }
    }
    return { ok: true, role: r.rec.role, seat: r.rec.seat ?? null, agentId, via: 'token' }
  }

  if (bound !== null) return { ok: true, role: bound.role, seat: bound.seat ?? null, agentId, via: 'session-binding' }

  return {
    ok: false,
    error:
      '无法确定调用方角色：既没有绑定会话，也没有携带 role_token。\n' +
      '流水线的每个动作都必须能回答"你是谁" —— 请让主对话先用 pipeline_dispatch 派活拿到令牌，' +
      '或在本会话调用 pipeline_bind_role 认领角色。',
  }
}

/**
 * 派出某个角色时应该顺带触发哪个状态事件。
 *
 * 这张表刻意写死：主对话只能"按角色派活"，不能挑状态事件 ——
 * 派 writer 就是 ready_dev/returned_to_dev → developing，没有别的可能。
 *
 * @param {string} role
 * @param {string} state
 * @returns {string|null}
 */
export function dispatchEventFor(role, state) {
  const table = {
    [`${ROLE.ORCHESTRATOR}|${ST.PENDING}`]: 'dispatch_orchestrator',
    // ★ 本轮新增：需求确认之后把计划 AI 派出去（ready_plan → planning）。
    [`${ROLE.PLANNER}|${ST.READY_PLAN}`]: 'dispatch_planner',
    [`${ROLE.WRITER}|${ST.READY_DEV}`]: 'dispatch_writer',
    [`${ROLE.WRITER}|${ST.RETURNED_TO_DEV}`]: 'dispatch_writer',
    [`${ROLE.TESTER}|${ST.READY_TEST}`]: 'dispatch_tester',
    [`${ROLE.TESTER}|${ST.RETURNED_TO_TEST}`]: 'dispatch_tester',
    [`${ROLE.REVIEWER}|${ST.READY_REVIEW}`]: 'dispatch_reviewer',
  }
  return table[`${role}|${state}`] ?? null
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * 构造全部工具定义。
 *
 * @param {object} deps
 * @param {Function} deps.defineTool
 * @param {object} deps.ctx
 * @param {object} deps.config
 * @param {ReturnType<import('./store.js').createTaskStore>} deps.store
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {object} deps.transport
 * @param {(taskId:string, task:object)=>void} deps.indexTask - 把任务登记进守门用的同步索引
 * @returns {object[]}
 */
/**
 * ★★ **席位侧投递器**（唯一实现；`pipeline_dispatch { notify_only: true }` 与
 *    **孤儿单自恢复的重投**用的是**同一份代码**）。
 *
 * 为什么把它从 `buildTools` 里提出来（2026-10-14，孤儿单自恢复）：
 *   自恢复要"重新投递"，而用户点名的通道就是**已经修好的** `notify_only`
 *   （`lib/tools.js:1788` 的 `notifySeat`）—— 不建会话、不改状态、投不出去
 *   返回 `ok:false` + 原因。若让 `lib/orphan.js` 自己再写一份投递，
 *   就会有**第二份**"投给谁 / 怎么算投成功"的口径 —— 那正是本项目反复吃亏的形状。
 *   所以：**搬出来、两边共用**（`buildTools` 与 `index.js` 各取一次），
 *   行为与改前**逐字相同**（同一份闭包、同一个 `transport.notifyRole`、
 *   同一组审计动作 `seat:wake-delivered` / `seat:wake-failed`）。
 *
 * @param {object} deps - 与 `buildTools(deps)` 同一份依赖（只用其中的
 *   `store` / `transport` / `wakeup`）
 * @returns {{noteSeatDelivery:Function, nudgeSeat:Function, notifyOnly:Function}}
 */
export function createSeatNotifier(deps = {}) {
  const store = deps.store
  const transport = deps.transport

  /**
   * ★★ **A6 / A7 / A28(b)：席位侧投递的**成败**都必须留痕**（盘上，跨进程可查）。
   *
   * 现场：裁定落地了、席位没被叫醒，而这件事**只活在一次工具调用的返回值里**
   * （"叫不醒"这句话说完就没了）；另一头，A28 要求「已投递」与「已接管」
   * **配对可读** —— 所以两边用**同一个键**：`<任务>|<类别>|seat:<席位>|<请求 id>`。
   *
   * ★ 不抛：留痕失败绝不能把"投递"这个判决本身带崩（与唤醒同一条纪律）。
   */
  async function noteSeatDelivery(task, role, seat, kind, requestId, ok, sessionId, note) {
    const actorKey = `${String(role)}${seat === null || seat === undefined || String(seat).length === 0 ? '' : `#${String(seat).replace(/^[a-z_]+#/, '')}`}`
    const key = `${String(task?.id ?? '')}|${String(kind)}|seat:${actorKey}|${String(requestId ?? '')}`
    try {
      deps.wakeup?.noteSeatDelivery?.({ key, task_id: String(task?.id ?? ''), kind: String(kind), role: String(role), seat: seat === null || seat === undefined ? '' : String(seat), session: String(sessionId ?? ''), ok, note: String(note ?? '') })
    } catch {
      void 0
    }
    try {
      await store.recordAudit(task.id, role, ok === true ? 'seat:wake-delivered' : 'seat:wake-failed', {
        key,
        request_id: String(requestId ?? ''),
        target_session: String(sessionId ?? ''),
        seat: seat ?? null,
        kind: String(kind),
        note: String(note ?? ''),
      })
    } catch {
      void 0
    }
    return key
  }

  async function nudgeSeat(task, role, seat, text, meta = {}) {
    const list = Array.isArray(task?.dispatched) ? task.dispatched : []
    const rec = list.find((x) => String(x?.role ?? '') === String(role) && (seat === null || String(x?.seat ?? '') === String(seat))) ?? null
    const sessionId = rec === null
      ? null
      : (typeof rec.session_id === 'string' && rec.session_id.length > 0
        ? rec.session_id
        : typeof rec.agent_id === 'string' && rec.agent_id.length > 0 ? rec.agent_id : null)
    const kind = String(meta.kind ?? 'notify')
    const requestId = String(meta.requestId ?? '')
    if (rec === null) {
      const note = `派活台账里没有「${role}${seat === null ? '' : `/${seat}`}」这一条 —— 不知道它在哪个会话，**没有投递**。`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, null, note)
      return { ok: false, sessionId: null, note }
    }
    if (sessionId === null) {
      const note = `「${role}${seat === null ? '' : `/${seat}`}」的派活台账里没有会话 id（session_id / agent_id 都是空的）—— **没有投递**。`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, null, note)
      return { ok: false, sessionId: null, note }
    }
    try {
      const r = await transport.notifyRole({ task, roster: task.roster, role, seat, sessionId, message: text })
      if (r !== null && r !== undefined && r.ok === false) {
        const note = String(r.note ?? '通道拒绝投递。')
        await noteSeatDelivery(task, role, seat, kind, requestId, false, sessionId, note)
        return { ok: false, sessionId, note }
      }
      const note = String(r?.note ?? `已投给会话 ${sessionId}。`)
      await noteSeatDelivery(task, role, seat, kind, requestId, true, sessionId, note)
      return { ok: true, sessionId, note }
    } catch (err) {
      const note = `投递异常：${String(err?.message ?? err)}`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, sessionId, note)
      return { ok: false, sessionId, note }
    }
  }

  /**
   * ★★ **B8：只传话、不派活**（`notify_only: true` 的内核）。
   *
   * "停会话 / 催办"这条**可见**通道 —— 改前完全没有（当晚只能由用户用 GUI 手动打字
   * 把席位叫醒）。它复用本工具的 role/seat 身份解析，从**派活台账**里找会话，
   * 结构上投不错人；投不出去返回 `ok:false` + 原因 + 等价路径（**不静默失败**）。
   *
   * ★ 2026-10-14：本函数**原样搬出** `buildTools`（见 {@link createSeatNotifier}），
   *   逻辑一个字节没改 —— 孤儿单自恢复的重投走的就是它。
   */
  async function notifyOnly(task, role, seat, text, stop) {
    const head = stop === true
      ? '【流水线 · 主对话指令 · **停手**】立即停止你正在做的事，不要继续改任何东西。\n'
      : '【流水线 · 主对话留言】\n'
    const r = await nudgeSeat(task, role, seat, `${head}${text}\n（任务 ${task.id}；这条是**运行时上下文**，不是用户说的话。）`)
    return r
  }

  return { noteSeatDelivery, nudgeSeat, notifyOnly }
}

export function buildTools(deps) {
  const { defineTool, config, store, tokens, transport, indexTask, sw, counter, retireAgent } = deps
  /**
   * ★ 席位侧投递器：**唯一实现**（见 {@link createSeatNotifier} 的文件级说明）。
   *   `notifyOnly` / `nudgeSeat` 就是本文件里原来那三个函数，行为逐字未变。
   */
  const { nudgeSeat, notifyOnly } = createSeatNotifier(deps)

  /** 读任务；顺手登记进同步索引（守门判据要同步查）。 */
  async function load(taskId) {
    const t = await store.get(taskId)
    if (t !== null) indexTask(taskId, t)
    return t
  }

  /** 取最近一份需求分析结论（计划 AI 交自己那份记录时要照抄验收标准 / 不清楚处）。 */
  function lastAnalysisOf(task) {
    const hs = Array.isArray(task?.handoffs) ? task.handoffs : []
    for (let i = hs.length - 1; i >= 0; i--) if (hs[i].kind === 'requirement_analysis') return hs[i]
    return null
  }

  /**
   * ★ 需求分析（第 1 轮）—— 只出分析结论，**不产出角色清单**。
   *
   * 三件硬事都在这里落地：
   *   ① `unclear_points` **必填**（允许空数组）—— "没有不清楚的地方"也是一个必须显式回答的答案；
   *   ② 交完分析**必须**提请用户确认（本函数只负责交分析，并在返回里明确下一步怎么提请），
   *      机制上由状态机的 `requirement_confirmed` 边兜底：没有用户答复，这条边过不去；
   *   ③ 有 `open_assumptions` 却不提任何不清楚处 ⇒ 交界物层直接拒（handoff.js 的跨字段判据）。
   */
  async function submitRequirementAnalysis(args, actor, task, engineReport) {
    const fail = (msg) => ({ ok: false, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false, summary: msg })

    if (!Array.isArray(args.unclear_points)) {
      return fail(
        '需求分析**必须**给出 unclear_points（需求不清楚处清单）—— 即使一条都没有，也要显式给空数组 [].\n' +
          '★ 为什么这条是必填：这份清单是**澄清前置到人工确认**的入口。缺了它，用户根本没机会说"你理解错了"。',
      )
    }
    if (!Array.isArray(args.acceptance) || args.acceptance.length === 0) {
      return fail('需求分析必须给 acceptance（验收标准）—— 没有验收标准就没有"做完没做完"的判据。')
    }
    if (!Array.isArray(args.test_points) || args.test_points.length === 0) {
      return fail('需求分析必须给 test_points（测试要点）—— 测试角色靠它设计用例。')
    }
    if (typeof args.analysis_reason !== 'string' || args.analysis_reason.trim().length === 0) {
      return fail('需求分析必须给 analysis_reason（为什么这么理解这份需求、为什么这么定验收标准）。')
    }

    const sub = await store.submitHandoff({
      taskId: task.id,
      kind: 'requirement_analysis',
      payload: {
        task_id: task.id,
        task_card: args.task_card ?? {
          goal: String(task.requirement ?? '').slice(0, 200),
          in_scope: toStringArray(args.acceptance),
          out_of_scope: toStringArray(args.boundaries),
        },
        acceptance: toStringArray(args.acceptance),
        test_points: toStringArray(args.test_points),
        boundaries: toStringArray(args.boundaries),
        unclear_points: toStringArray(args.unclear_points),
        open_assumptions: toStringArray(args.open_assumptions),
        analysis_reason: args.analysis_reason,
        /**
         * ★ 职责自限声明 —— 缺省给一份"需求层"的模板，但**鼓励覆盖它**。
         *   为什么要给缺省：这一栏的价值在"点名自己不做什么"，
         *   模板里那句"不分配 AI"正是最容易越界的那一条。
         */
        role_scope: args.role_scope ?? {
          will_do: [
            '把需求翻译成任务卡 / 验收标准 / 边界条件 / 测试要点',
            '列出「需求不清楚处」清单并提请用户确认',
            '作为两级澄清梯的第一级，裁定执行角色提出的需求层问题',
          ],
          will_not_do: ['不分配 AI（角色清单 / 用几个 / 派谁 / 顺序都是计划 AI 的活）', '不判档位（tier）', '不读代码、不写实现、不跑测试'],
        },
      },
      actorRole: actor.role,
      actorSeat: actor.seat ?? null,
      actorAgentId: actor.agentId,
    })
    if (sub.ok !== true) return fail(sub.error)
    indexTask(sub.task.id, sub.task)

    const unclear = toStringArray(args.unclear_points)
    const assumptions = toStringArray(args.open_assumptions)
    return {
      ok: true,
      dry_run: false,
      tier: '',
      ai_count: 0,
      roles: '',
      sequence: '',
      summary: [
        `需求分析结论已提交：${sub.handoff?.handoff_id ?? ''}（任务状态：${STATE_LABEL[sub.task.state]}）。`,
        `验收标准 ${toStringArray(args.acceptance).length} 条；测试要点 ${toStringArray(args.test_points).length} 条；不清楚处 ${unclear.length} 条` +
          `${assumptions.length > 0 ? `；你替用户做的假设 ${assumptions.length} 条` : ''}。`,
        '',
        unclear.length === 0
          ? '★ 清单是空的 —— 但**这一步不能省**："没有不清楚的地方"同样要用户点头。'
          : '★ 清单非空 —— 逐条问出来，别自己替用户拍板。',
        '',
        '下一步（**必须做，否则流程走不动**）：调 pipeline_human_request 把不清楚处提交主对话转告用户：',
        '  {',
        `    task_id: "${task.id}",`,
        '    reason_kind: "requirement_confirmation",',
        '    question_for_human: "<把上面的清单归成一个用户能回答的问句>",',
        '    context_for_human: "<不含代码的背景说明>",',
        '    blocking: true,',
        '    blocked_stage: "需求确认",',
        '    urgency: "blocking",',
        '    decision_kind: "free_text",   // 是/否类结论用 yes_no',
        '    timeout_behavior: "stay_blocked"',
        '  }',
        '主对话会把它转告用户；用户答复之后状态才会回到「需求分析中」，再由主对话推进到「待计划」。',
        '',
        '★ 分配 AI **不是你的活**：角色清单、用几个独立对话、谁先谁后，全部由计划 AI（pipeline_plan）产出。',
        `\n【规则引擎的建议（仅供参考，不构成判断）】\n${engineReport}`,
      ].join('\n'),
    }
  }

  // =========================================================================
  // 1. pipeline_task_open —— 主对话开单
  // =========================================================================
  const taskOpen = tool(deps, {
    name: 'pipeline_task_open',
    mutating: true,
    description:
      '【主对话专用】开一张流水线任务单：登记原始需求，返回任务 ID。' +
      '主对话在这里**不做技术分析**，只登记需求，然后交给需求分析（出任务卡 + 不清楚处清单）。' +
      '本工具会把调用方注册为这张单的「主对话」角色 —— 非主对话调它会拿到一张不属于自己的单，无法关单。' +
      '★ `reattach: true` = **重新认领一张已存在的单**（DSH 重启后恢复身份用的唯一入口；' +
      '不带它时同 id 仍然按老规矩报「已存在，请换一个 id」）。',
    parameters: {
      requirement: S('string', '原始需求（用户原话，不要替用户"提炼"）'),
      constraints: S('array', '约束条件（可空）', { items: { type: 'string' } }),
      acceptance: S('array', '用户已经明说的验收标准（可空；技术性验收标准由需求分析产出）', { items: { type: 'string' } }),
      deadline: S('string', '截止要求（可空）'),
      deliverable_format: S('string', '交付格式（可空，例如"补丁 + 变更说明 + 可运行命令"）'),
      task_id: S('string', '指定任务 ID（可空；留空自动生成）。`reattach: true` 时**必填**'),
      /**
       * ★ **重新认领**（重启后的恢复入口，2026-10-11 补）。
       *
       * 为什么恢复入口必须挂在"开单"这个工具上：主对话被切断之后**只有这一条路** ——
       *   · 它的令牌随重启一起没了（令牌表是进程内存态）；
       *   · `pipeline_bind_role` 救不了它 —— 那个工具**先 `tokens.resolve` 再 `bindAgent`**，
       *     令牌表空了它必然失败（这是个死锁：认领要令牌 → 令牌要主对话 → 主对话要身份）；
       *   · 同一个 `task_id` 又不能重开（`TASK_EXISTS`）。
       * 而 `pipeline_task_open` 恰好是**唯一不需要身份**的写工具。
       */
      reattach: S('boolean', '★ 重新认领一张**已存在**的任务单（DSH 重启后主对话恢复身份用）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      task_id: S('string', '任务 ID'),
      state: S('string', '当前状态'),
      role_token: S('string', '主对话自己的角色令牌（后续动作带上它）'),
    },
    async run(args, exec) {
      const agentId = agentIdOf(exec)

      // ---------------------------------------------------------------------
      // ★ **重新认领**（`reattach: true`）—— DSH 重启后的恢复入口。
      //
      //   为什么与"开单"共用一个工具：主对话被切断之后只有这一条路 ——
      //     · 令牌随重启没了（令牌表是进程内存态，`lib/tokens.js:41`）；
      //     · `pipeline_bind_role` 救不了它（先 resolve 再 bind，令牌表空了必失败）；
      //     · 同一个 task_id 又不能重开（`store.js` 的 `TASK_EXISTS`）。
      //   而 `pipeline_task_open` 是全插件**唯一不需要身份**的写工具
      //   （守门表里它是 `null`），所以恢复入口只能挂在这里。
      //
      //   ★ 认领 = **保留全部历史**（history / handoffs / artifacts 一条不动），
      //     只换身份。这与"覆盖重开"是两回事 —— 后者会毁掉审计链。
      // ---------------------------------------------------------------------
      if (args.reattach === true) {
        const id = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        if (id.length === 0) {
          return {
            ok: false,
            summary:
              '认领（`reattach: true`）必须给 `task_id` —— 就是那张**已存在**的单的 id。\n' +
              '★ 若你要开一张**新**单，请不要带 `reattach`。\n' +
              '  不确定有哪些单：`pipeline_status`（不带 task_id 会列出全部）。',
            task_id: '',
            state: '',
            role_token: '',
          }
        }

        const res = await store.reattach(id, { agentId })
        if (res.ok !== true) return { ok: false, summary: res.error, task_id: '', state: '', role_token: '' }

        const task = res.task
        indexTask(task.id, task)
        const t = tokens.mint({ taskId: task.id, role: ROLE.MAIN, agentId, note: 'reattach' })

        return {
          ok: true,
          task_id: task.id,
          state: task.state,
          role_token: t.token,
          summary:
            `已**重新认领** ${task.id}（当前状态：${STATE_LABEL[task.state] ?? task.state}）。\n` +
            `主对话令牌：${t.token}（本会话已绑定为该任务的「主对话」）。\n` +
            '★ 这是**认领**不是重开：`history` / `handoffs` / `artifacts` **一条都没动**，进度原样保留。\n' +
            (res.terminal
              ? `⚠ 这张单已处于**终态**（${STATE_LABEL[task.state] ?? task.state}）—— 认领成功，但它不再接受任何状态迁移，只能查看。\n`
              : '') +
            '\n**现在你有三个选择（明文列出，不替你决定）**：\n' +
            `  ① **继续推进**：先 \`pipeline_status { task_id: "${task.id}" }\` 看当前状态与下一步合法事件，再按它往下走。\n` +
            `  ② **取消这张单**：\`pipeline_transition { task_id: "${task.id}", event: "cancel" }\`\n` +
            '     （任意非终态都能取消 —— 这条边一直存在，之前"取消不了"是因为**身份先没了**，不是状态机缺边）。\n' +
            '  ③ **放着不管**：什么都不用做。它不会自己变，也不会阻塞你新开别的单。\n\n' +
            '★ 为什么需要这一步：DSH 重启后令牌表（**进程内存态**）被清空，**所有**令牌 ——\n' +
            '  包括开单时铸的主对话那枚 —— 全部失效，而同一个 `task_id` 又不能再开一次。\n' +
            '  认领是回到老单的**唯一**入口。',
        }
      }

      const res = await store.open({
        requirement: args.requirement,
        constraints: args.constraints,
        acceptance: args.acceptance,
        deadline: args.deadline,
        deliverableFormat: args.deliverable_format,
        id: typeof args.task_id === 'string' ? args.task_id : undefined,
        actorRole: ROLE.MAIN,
        actorAgentId: agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, task_id: '', state: '', role_token: '' }

      indexTask(res.task.id, res.task)
      const t = tokens.mint({ taskId: res.task.id, role: ROLE.MAIN, agentId, note: 'task_open' })
      return {
        ok: true,
        task_id: res.task.id,
        state: res.task.state,
        role_token: t.token,
        summary:
          `已开单 ${res.task.id}（状态：${STATE_LABEL[res.task.state]}）。\n` +
          `主对话令牌：${t.token}（本会话已自动绑定为该任务的主对话）。\n\n` +
          '下一步：调用 pipeline_orchestrate 做**需求分析** —— 出任务卡 / 验收标准 / 边界条件 / 测试要点，并列出**需求不清楚处**。\n' +
          '★ 分析结论要先交**用户人工确认**，确认后才由计划 AI（pipeline_plan）决定这次要几个 AI、调用谁、按什么顺序。\n' +
          '★ 主对话既不自行判断需要几个 AI，也不替用户拍板需求。',
      }
    },
  })

  // =========================================================================
  // 2. pipeline_orchestrate —— 需求分析（第 1 轮）
  // =========================================================================
  //
  // ★ 本轮改动：这个工具**收窄成只做需求分析**。
  //   它以前顺带产出角色清单（"编排判断"），现在那件事归 `pipeline_plan`（planner）。
  //   理由：这两件事的回答方式不同 —— 需求分析回答"要做什么"（语义问题），
  //   计划分配回答"怎么切、给谁、什么次序"（结构问题）。挤在一起时，
  //   "计划缺失"只能回头问自己，等于自问自答；拆开后才有真实的回流边。
  const orchestrate = tool(deps, {
    name: 'pipeline_orchestrate',
    mutating: true,
    description:
      '【需求分析专用】把模糊需求变成任务卡 + 验收标准 + 边界条件 + 测试要点，' +
      '并**产出「需求不清楚处」清单**（unclear_points）。' +
      '★ 它**不产出角色清单**——"要调用几个 AI、调用谁、按什么顺序"是计划 AI（pipeline_plan）的产物。' +
      '调用形态：(a) 独立需求分析对话调用（L1+）：交分析结论，然后**必须**用 pipeline_human_request 把不清楚处提交主对话转告用户确认；' +
      '(b) L0 极简脚本：主对话可以调它让**确定性规则引擎**自批角色清单 —— ' +
      '引擎要输出 L0，需求必须先通过一组保守的平凡性判据，任何一条不满足就强制升档（复杂需求不漏配）。' +
      '传 dry_run=true 只拿建议档位，不落盘。',
    parameters: {
      task_id: S('string', '任务 ID'),
      requirement: S('string', '原始需求（与开单时一致）'),
      acceptance: S('array', '验收标准（可执行的、可判定的）', { items: { type: 'string' } }),
      test_points: S('array', '测试要点', { items: { type: 'string' } }),
      boundaries: S('array', '边界条件（没有就给空数组）', { items: { type: 'string' } }),
      unclear_points: S('array', '★ 需求不清楚处清单（**必填**；没有不清楚的就给空数组 —— 那也是一个必须显式回答的结论）', { items: { type: 'string' } }),
      open_assumptions: S('array', '你替用户假设了什么（有假设却不提不清楚处会被拒）', { items: { type: 'string' } }),
      role_scope: S('object', '★ 需求分析自己的职责自限声明 { will_do: string[], will_not_do: string[] } —— 「不分配 AI、不定档、不读代码、不写实现」要写进 will_not_do', { additionalProperties: true }),
      analysis_reason: S('string', '★ 分析依据：为什么这么理解这份需求、为什么这么定验收标准'),
      task_card: S('object', '任务卡（人话版：要做什么、不做什么；可空）', { additionalProperties: true }),
      // --- L0 规则引擎自批时才用得到的两项 ---
      tier: S('string', '档位 L0~L5（**独立需求分析对话不要再传它**：档位是计划 AI 的判断）', { enum: TIER_ORDER }),
      reason: S('string', '理由（分配相关的理由请交给 pipeline_plan）'),
      writers: S('object', '★编写席位方案（**归计划 AI**；这里只为 L0 规则引擎兼容保留）', { additionalProperties: true }),
      relay_policy: S('object', '★继任策略（归计划 AI；这里只为 L0 兼容保留）', { additionalProperties: true }),
      extra_roles: S('array', '额外角色（归计划 AI）', { items: { type: 'string' } }),
      dry_run: S('boolean', '只拿规则引擎的建议档位，不写入'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含规则引擎的建议与理由）'),
      tier: S('string', '最终档位'),
      ai_count: S('number', '需要的独立对话总数'),
      roles: S('string', '角色清单（顿号分隔）'),
      sequence: S('string', '调用顺序'),
      dry_run: S('boolean', '是否只是试算'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: args.dry_run === true }

      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: `找不到任务 ${args.task_id}。`, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false }

      // --- 规则引擎先算一遍（永远算，dry_run 也用它回答）------------------
      const proposal = proposeTier({
        requirement: args.requirement ?? task.requirement,
        acceptance: args.acceptance,
        constraints: task.constraints,
        defaultTier: config.defaultTier,
      })

      const engineReport =
        `规则引擎建议档位：${proposal.proposedTier}（${TIERS[proposal.proposedTier].zh}）\n` +
        proposal.notes.map((n) => `  · ${n}`).join('\n') +
        (proposal.signals.length > 0
          ? `\n  命中的不平凡信号：\n${proposal.signals.map((s) => `    - [${s.tier}] ${s.why}（匹配「${s.matched}」）`).join('\n')}`
          : '')

      if (args.dry_run === true) {
        return {
          ok: true,
          dry_run: true,
          tier: proposal.proposedTier,
          ai_count: TIERS[proposal.proposedTier].total,
          roles: TIERS[proposal.proposedTier].execution.join('、'),
          sequence: TIERS[proposal.proposedTier].execution.join(' → '),
          summary: `【试算】未写入任何内容。\n${engineReport}\n\n若按此档位执行，角色清单为：${TIERS[proposal.proposedTier].execution.join(' / ')}。`,
        }
      }

      // --- 判定调用形态 ----------------------------------------------------
      const role = actor.role

      // ★ (a) 独立需求分析对话（L1+）：只交「需求分析结论」，**不产出角色清单**。
      if (role === ROLE.ORCHESTRATOR) {
        if (typeof args.tier === 'string' && args.tier.length > 0) {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              `需求分析不再接收 tier（你传的是 ${args.tier}）。\n` +
              '★ 本轮把「分配 AI」从需求分析移给了**计划 AI**（planner）—— 档位、角色清单、\n' +
              '用几个 AI、按什么顺序，全部由 pipeline_plan 产出。\n' +
              '你这一轮的产物是：任务卡 + 验收标准 + 边界条件 + 测试要点 + **需求不清楚处清单**。\n' +
              `\n【规则引擎的建议（仅供参考，不构成判断）】\n${engineReport}\n` +
              '下一步：调 pipeline_human_request { reason_kind: "requirement_confirmation", blocking: true, question_for_human: "<把 unclear_points 归成一个可确认的问句>" }，\n' +
              '      由主对话转告用户确认；用户确认后主对话才会把任务交给计划 AI。',
          }
        }
        return await submitRequirementAnalysis(args, actor, task, engineReport)
      }

      // ★ (b) 主对话：**只有 L0** 能走规则引擎自批（角色清单 + 需求档一起产出）。
      //    L1+ 一律要有独立的计划 AI —— 主对话不得自己产出角色清单。
      if (role === ROLE.MAIN) {
        if (config.l0OrchestratorSeparate === true) {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              '本插件配置为 l0OrchestratorSeparate=true：L0 也必须有独立的编排对话。' +
              '主对话不能自己产出角色清单 —— 请先 pipeline_dispatch 派出 orchestrator 做需求分析、再派 planner 做计划分配。',
          }
        }
        if (proposal.proposedTier !== 'L0') {
          return {
            ok: false,
            tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
            summary:
              `拒绝：主对话不能自己产出角色清单。\n\n${engineReport}\n\n` +
              `规则引擎判的是 ${proposal.proposedTier}，不是 L0 —— 这个需求需要**独立的需求分析 + 计划分配**。\n` +
              '正确的下一步：\n' +
              '  ① pipeline_dispatch role=orchestrator（需求分析出任务卡 + 不清楚处清单）；\n' +
              '  ② 需求分析把不清楚处提交主对话 → 你交**用户**确认；\n' +
              '  ③ 确认后 pipeline_dispatch role=planner（计划 + 自检 + 分配 AI）。\n' +
              '★ 主对话不自行判断要几个 AI。',
          }
        }
        // L0：由规则引擎自批，主对话只是"调用方"。
      } else {
        return {
          ok: false,
          tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
          summary: `只有主对话（main）或需求分析对话（orchestrator）能触需求分析，当前角色是「${roleLabel(role)}」。`,
        }
      }

      const finalTier = proposal.proposedTier
      const reason = `L0 自批：需求通过规则引擎的平凡性判据（未命中任何不平凡信号；文本 ${String(task.requirement).trim().length} 字符 ≤ 240；无声明约束）。`

      const res = await store.setRoster({
        taskId: task.id,
        tier: finalTier,
        reason,
        judgedBy: 'rule-engine',
        extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
        l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
        writers: args.writers,
        relayPolicy: args.relay_policy,
        acceptance: args.acceptance,
        testPoints: args.test_points,
        boundaries: args.boundaries,
        actorRole: ROLE.MAIN,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) {
        return { ok: false, summary: res.error, tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false }
      }
      // ---------------------------------------------------------------------
      // ★ 需求留档：编排产出任务卡时**必须同时**落一份本地需求档。
      // ---------------------------------------------------------------------
      //
      // 为什么放在编排这一步：任务卡（档位 / 角色清单 / 验收标准）是这一课的全部产出，
      // 而"上下文会溢出、会失忆、席位会换人"意味着**这份产出必须落到盘上** ——
      // 否则它只活在编排那个会话的上下文里，那个会话一换，需求就没人说得清了。
      //
      // 档 = 人可读 markdown（requirement.md）+ 结构化 JSON（requirement.json），
      // 路径与 sha256 记进任务卡；**所有角色默认以该文件为准**。
      // ★ 更正 A：`requirement.md` 的**唯一写者**是留档 AI（archivist）。
      //   所以编排**只在 L0** 直接落档 —— L0 没有留档 AI（规则引擎档位），
      //   由规则引擎直接生成单一需求档；L1+ 一律走"各方落 records → 留档 AI 汇总"。
      // ★ 更正 A：L1+ 的 `requirement.md` 由**留档 AI** 汇总产生，编排不直接写它。
      //   编排把自己这份任务卡作为**自己那份记录**交出去（records/orchestrator.md），
      //   留档 AI 读它 + 各方记录，汇总成唯一的需求档。
      //   （L0 没有留档 AI，仍由规则引擎直接落档 —— 见下面的 writeRequirementDoc。）
      const mdBody = renderRequirementDoc({
        task: res.task,
        roster: res.roster,
        acceptance: Array.isArray(args.acceptance) ? args.acceptance : [],
        testPoints: Array.isArray(args.test_points) ? args.test_points : [],
        boundaries: Array.isArray(args.boundaries) ? args.boundaries : [],
        reason,
      })
      if (res.roster.tier !== 'L0') {
        // ⚠️ 本轮起这条分支**不可达**：只有 L0 走规则引擎自批（上面的 role 分支已经判过）。
        //    保留它会让"L1+ 也能从这里产出清单"变成一个看起来合法的口子，
        //    所以直接拒——任何到达这里的 L1+ 都是内部矛盾。
        return {
          ok: false,
          tier: '', ai_count: 0, roles: '', sequence: '', dry_run: false,
          summary:
            `插件内部错误：非 L0 档位（${res.roster.tier}）不该由规则引擎自批，角色清单已回滚请人工检查。\n` +
            'L1+ 必须走：需求分析（pipeline_orchestrate）→ 用户确认 → 计划分配（pipeline_plan）。',
        }
      }

      const doc = await store.writeRequirementDoc({
        task: res.task,
        markdown: mdBody,
        structured: {
          task_id: res.task.id,
          requirement: res.task.requirement,
          deliverable_format: res.task.deliverable_format ?? null,
          tier: res.roster.tier,
          tier_zh: res.roster.tier_zh,
          orchestrator_mode: res.roster.orchestrator_mode,
          roles: res.roster.execution_roles,
          sequence: res.roster.sequence.map((s) => s.role),
          writers: res.roster.writers,
          relay_policy: res.roster.relay_policy,
          acceptance: res.roster.acceptance ?? [],
          test_points: res.roster.test_points ?? [],
          boundaries: res.roster.boundaries ?? [],
          reason,
        },
        by: ROLE.MAIN,
      })
      indexTask(res.task.id, res.task)

      const r = res.roster
      return {
        ok: true,
        dry_run: false,
        tier: r.tier,
        ai_count: r.ai_count,
        roles: r.execution_roles.join('、'),
        sequence: r.sequence.map((s) => s.role).join(' → '),
        summary:
          `角色清单已产出（judged_by=${r.judged_by}）。\n` +
          `档位：${r.tier}（${r.tier_zh}） —— ${r.trigger}\n` +
          `需要几个独立对话：${r.ai_count} 个\n` +
          (r.writers
            ? [
                `编写席位：${r.writers.count} 个（本档上限 ${r.max_writers}）\n`,
                ...r.writers.partitions.map(
                  (p) =>
                    `  · ${p.seat}｜层 ${p.layer ?? '-'} → ${(p.scope_paths ?? []).map((s) => (s === '.' ? '整棵项目根' : s)).join('、')}` +
                    `${p.deliverables?.length ? `（${p.deliverables.join('、')}）` : ''}\n`,
                ),
                r.writers.reason ? `  为什么这么分：${r.writers.reason}\n` : '',
              ].filter((x) => x !== '').join('')
            : '') +
          `  对话：${r.conversations.map(roleLabel).join(' / ')}\n` +
          `  执行角色：${r.execution_roles.join(' / ')}\n` +
          `调用顺序：${r.sequence.map((s) => s.role).join(' → ')}\n` +
          `判断理由：${r.reason}\n` +
          `需求档已落盘：.pipeline/${res.task.id}/requirement.md（${doc.version}，sha256 ${doc.sha256.slice(0, 16)}…）\n` +
          '  ★ 所有角色**以该文件为准**；路径靠**目录约定**，不再登记进任务卡。\n' +
          `\n${engineReport}\n` +
          '\n下一步：主对话用 pipeline_dispatch 按这个清单逐个派活（主对话不自行增减角色）。',
      }
    },
  })

  // =========================================================================
  // 2.5 pipeline_plan —— 计划 AI：出计划 → 自检 → 分配 AI
  // =========================================================================
  //
  // ★ 本轮新增。它是**角色清单的唯一出口**（原先那是 pipeline_orchestrate 的活）。
  //
  // 一次调用做三件事，顺序是刻意的：
  //   ① 交 `plan` 交接物（计划步骤 + 层清单 + **自检结果**）；
  //      · 自检 verdict=gaps ⇒ 状态被推到「等待需求分析答复」，**到此为止**，
  //        绝不再往下走分配（store 层也有一道闸，任何路径都绕不过去）；
  //      · 自检 verdict=ok ⇒ 继续第 ② 步。
  //   ② 写角色清单（setRoster，judgedBy=planner）—— 档位、几个 AI、角色、顺序、席位分层。
  //   ③ 状态进「待开发」。
  const planTool = tool(deps, {
    name: 'pipeline_plan',
    mutating: true,
    description:
      '【计划 AI 专用】出计划 → **自检计划有无缺失** → 无缺失则**分配 AI**（角色清单 / 用几个独立对话 / 派谁 / 什么顺序 / 编写席位与层分工）。' +
      '★ 这是"要调用几个 AI"的**唯一出口**（本轮从 pipeline_orchestrate 移交过来）。' +
      '自检 verdict=gaps 时**不会分配**：状态会退回需求分析（等待需求分析答复），等它给结论或升级给用户。' +
      '席位数由层数决定（count === layers.length），默认层清单：接口层 / 数据层 / 处理层。',
    parameters: {
      task_id: S('string', '任务 ID'),
      plan_steps: S('array', '计划步骤（按顺序）', { items: { type: 'string' } }),
      layers: S('array', '★ 层清单 [{layer, scope_paths[], deliverables[]}] —— 一个层一个编写席位；不传 = 单层 all（范围整棵项目根）', { items: { type: 'object', additionalProperties: true } }),
      self_check_verdict: S('string', '★ 自检结论', { enum: ['ok', 'gaps'] }),
      self_check_checked: S('array', '★ 自检**核对过什么**（逐条列，不能只给结论）', { items: { type: 'string' } }),
      self_check_gaps: S('array', '自检发现的缺失（verdict=ok 时必须为空）', { items: { type: 'string' } }),
      gap_stage: S('string', '卡在哪一步（verdict=gaps 时必填）'),
      gap_question: S('string', '要问需求分析的问题（问句；verdict=gaps 时必填）'),
      gap_context: S('string', '★ 脱敏摘要（不许含代码；verdict=gaps 时必填）'),
      gap_urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      plan_reason: S('string', '为什么这么计划（可追溯）'),
      risks: S('array', '计划层面的风险', { items: { type: 'string' } }),
      based_on_analysis: S('string', '依据哪份需求分析结论（requirement_analysis 的 handoff_id；可空）'),
      /** ★ 设计目的（最小改动）：授权改动面。 */
      change_scope: S('array', '★ 授权改动面 [{ id, path, action: modify|create|delete, why }] —— 编写**只能在这个清单内动**；**新增文件也算越界**（要新建就显式写 create）；"顺手重构 / 统一风格 / 升级依赖"写不出 why ⇒ 不许', { items: { type: 'object', additionalProperties: true } }),
      /** ★ 越界清单：这次不许做什么（给 writer 与 reviewer 一起看）。 */
      forbidden: S('array', '★ **越界清单**（这次**不许**做什么；至少 1 条。例如：不许顺手重构 / 不许改测试 / 不许扩范围 / 不许改依赖）', { items: { type: 'string' } }),
      /** ★ 设计目的（职责自限）：每个执行角色一张边界卡。 */
      role_boundaries: S('array', '★ 角色边界卡 [{ role, only: string[], not: string[] }] —— **必须覆盖清单里每一个执行角色**；派活时按它派，别让谁顺手多干', { items: { type: 'object', additionalProperties: true } }),
      role_scope: S('object', '★ 计划 AI 自己的职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么', { additionalProperties: true }),
      // --- 分配 AI（verdict=ok 时才用得到）---
      tier: S('string', '档位 L0~L5（必须给）', { enum: TIER_ORDER }),
      reason: S('string', '★ 分配理由：为什么是这一档、为什么是这几个角色、为什么这么分层（必须给，会留痕可追溯）'),
      extra_roles: S('array', '额外需要的角色（L5 从扩展池里挑）', { items: { type: 'string' } }),
      writers: S('object', '★编写席位方案 { layers: ["interface","data","logic"], partitions: [{seat, layer, scope_paths[], interface_owner, deliverables[]}], reason }。**席位数 = 层数**；不传 = 单席位（层 all，范围整棵项目根）', { additionalProperties: true }),
      relay_policy: S('object', '★继任策略 { warnPercent, triggerContextPercent, hardLimitPercent, maxSuccessionsPerSeat, allowedRoles[], enabledTiers[] }。主对话只能在此授权内换班', { additionalProperties: true }),
      acceptance: S('array', '验收标准（沿用需求分析的结论即可）', { items: { type: 'string' } }),
      test_points: S('array', '测试要点', { items: { type: 'string' } }),
      boundaries: S('array', '边界条件', { items: { type: 'string' } }),
      /**
       * ★★ **四槽声明**（B1 的数据通路；不传 = 全部落显式默认）。
       *
       * 形状：`{ "<角色>": { permission, mode, model, reasoning }, "<角色>@<席位>": {...} }`
       * —— `<角色>` 用于非编写角色（tester / reviewer / architect / security / archivist …），
       * `<角色>@<席位>` 用于编写席位（`writer@writer#1`）。**四个槽是四个平级字段**，
       * 不许打包成 `options`。
       *
       * ★ 声明了就**必须声明齐**（每个要落槽位的席位一条都不许少）：只声明一半会被拒，
       *   因为那看起来像"已经安排好了"。不声明 = 名单给每个席位落**显式默认**
       *   （权限档 = 最小档 `read-only`，带 `origin=default`，与"声明了最小档"可区分）。
       */
      slots: S('object', '★四槽声明 { "<角色>": {permission,mode,model,reasoning}, "<角色>@<席位>": {...} }；不传 = 全部落显式默认（权限档 = 最小档 read-only）', { additionalProperties: true }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含档位、几个 AI、层与席位、拒绝原文）'),
      tier: S('string', '最终档位（自检未通过时为空串）'),
      ai_count: S('number', '需要的独立对话总数（自检未通过时为 0）'),
      roles: S('string', '角色清单（顿号分隔）'),
      sequence: S('string', '调用顺序'),
      allocated: S('boolean', '是否已经分配 AI（自检 gaps 时为 false）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      const empty = { ok: false, tier: '', ai_count: 0, roles: '', sequence: '', allocated: false }
      if (actor.ok !== true) return { ...empty, summary: actor.error }

      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ...empty, summary: `找不到任务 ${args.task_id}。` }

      // --- ① 交计划（含自检）------------------------------------------------
      const selfCheck = {
        verdict: String(args.self_check_verdict ?? ''),
        checked: toStringArray(args.self_check_checked),
        gaps: toStringArray(args.self_check_gaps),
      }
      const planPayload = {
        task_id: task.id,
        based_on_analysis: typeof args.based_on_analysis === 'string' ? args.based_on_analysis : '',
        plan_steps: toStringArray(args.plan_steps),
        layers: Array.isArray(args.layers) ? args.layers : [],
        self_check: selfCheck,
        plan_reason: String(args.plan_reason ?? ''),
        risks: toStringArray(args.risks),
        // ★ 设计目的：**最小改动**（授权改动面）+ **职责自限**（自己的 + 每个角色的边界卡）
        change_scope: Array.isArray(args.change_scope) ? args.change_scope : [],
        forbidden: toStringArray(args.forbidden),
        role_boundaries: Array.isArray(args.role_boundaries) ? args.role_boundaries : [],
        role_scope: args.role_scope,
        /**
         * ★★ **B1 的第二半：四槽声明的落点**。
         *
         * 计划的 `writers` 与 `role_boundaries` 早就有列，但"四槽声明"**没有任何字段承载它** ——
         * `store.setRoster` 从来没收到过 `slots` ⇒ 名单的四槽表永远只有默认值，
         * 计划 AI 把四槽写在哪个字段里都进不来。这里补上行使其可落：
         * 形状 `{ "<角色>": {permission,mode,model,reasoning}, "<角色>@<席位>": {...} }`。
         * 不传 = 全部落显式默认（权限档 = 最小档 read-only，origin=default）。
         */
        slots: args.slots !== null && typeof args.slots === 'object' ? args.slots : null,
      }
      if (selfCheck.verdict === 'gaps') {
        planPayload.gap_stage = args.gap_stage
        planPayload.gap_question = args.gap_question
        planPayload.gap_context = args.gap_context
        planPayload.gap_urgency = typeof args.gap_urgency === 'string' && args.gap_urgency.length > 0 ? args.gap_urgency : 'blocking'
      }
      const sub = await store.submitHandoff({
        taskId: task.id,
        kind: 'plan',
        payload: planPayload,
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
      })
      if (sub.ok !== true) return { ...empty, summary: sub.error }
      indexTask(sub.task.id, sub.task)

      // --- 自检未过：**到此为止**（状态已回流到需求分析）----------------------
      if (selfCheck.verdict !== 'ok') {
        return {
          ok: true,
          allocated: false,
          tier: '', ai_count: 0, roles: '', sequence: '',
          summary:
            `计划已提交，但自检结论是 **gaps**（${selfCheck.gaps.length} 条缺失）—— **不会分配 AI**。\n` +
            `已退回需求分析：${sub.summary}\n` +
            `问它的问题：${String(args.gap_question ?? '')}\n` +
            '接下来的路径（沿用既有两级梯，没有另起通道）：\n' +
            '  ① 需求分析 pipeline_clarify_reply 裁定（answered）→ 状态回到「计划中」，你按结论重出计划；\n' +
            '  ② 它答不了（cannot_answer）→ 由它 pipeline_human_request 升级给用户 → 主对话转告 → 用户答复。\n' +
            '★ 补完缺口后重交一份 self_check.verdict=ok 的计划即可继续。',
        }
      }

      // --- ② 分配（写角色清单）+ ③ 状态进「待开发」--------------------------
      if (typeof args.tier !== 'string' || !TIER_ORDER.includes(args.tier)) {
        return { ...empty, summary: `自检已过，但分配需要 tier（${TIER_ORDER.join('/')}）—— 你给的是 ${JSON.stringify(args.tier ?? null)}。` }
      }
      if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
        return { ...empty, summary: '分配必须给 reason —— 每次判断都要有理由记录、可追溯。' }
      }

      // ★★ **B13：计划的角色边界卡必须覆盖清单里每一个执行角色（在计划这一站就判死）**。
      //
      //   改前的现场：`role_boundaries` 覆盖性只在 `store.setRoster` 里核对 ——
      //   那是"分配"那一刻，而分配是同一份计划的后半段 ⇒ 计划**已经落盘**、
      //   任务已经被推到「待开发」，拒了还得靠人再补一轮；更糟的是派活那一刻
      //   才用一句**警告**告诉主对话"计划里没有某某的边界卡（本应覆盖全部执行角色）"。
      //   用户要求：像 `forbidden` 至少 1 条那样**硬性**。
      //
      //   所以这里在**交计划之前**就判：本档位的执行角色（`buildRoster` 算得出来，
      //   与分配用的是同一份数据）逐条对边界卡；缺一条 ⇒ 计划**不提交**、明确点名。
      if (selfCheck.verdict === 'ok') {
        const probe = buildRoster({
          tier: args.tier,
          reason: String(args.reason ?? '计划自检'),
          judgedBy: 'planner',
          extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
          l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
          writers: args.writers,
          relayPolicy: args.relay_policy,
        })
        if (probe.ok === true) {
          const need = probe.roster.execution_roles
          const got = new Set(planPayload.role_boundaries.map((b) => String(b?.role ?? '').trim()).filter((x) => x.length > 0))
          const missing = need.filter((r) => !got.has(r))
          if (missing.length > 0) {
            return {
              ...empty,
              summary:
                `拒绝：计划里的**角色边界卡没覆盖全部执行角色**（缺 ${missing.length} 张）—— 计划**没有提交**。\n` +
                `缺的是：${missing.join('、')}\n` +
                `本档（${args.tier}）的执行角色：${need.join('、')}\n` +
                `你给的卡：${[...got].join('、') || '（无）'}\n` +
                '★ 规矩与 `forbidden`（至少 1 条）同一档：**每个执行角色都要一张卡**，\n' +
                '  在计划里写死"它只干什么、不干什么"，派活时按它派。\n' +
                '★ 为什么卡在这里：等到派活那一刻才提醒，任务**已经**被推到「待开发」了，\n' +
                '  而"谁顺手多干了"恰恰是从"没有边界"开始的。\n' +
                '下一步：给上面点名的角色各补一张 `{ role, only: [...], not: [...] }` 再重交计划。',
            }
          }
        }
      }

      const res = await store.setRoster({
        taskId: task.id,
        tier: args.tier,
        reason: String(args.reason),
        judgedBy: 'planner',
        extraRoles: Array.isArray(args.extra_roles) ? args.extra_roles : [],
        l0OrchestratorSeparate: config.l0OrchestratorSeparate === true,
        writers: args.writers,
        relayPolicy: args.relay_policy,
        /** ★ B1 的第二半：计划里的四槽声明原样交给名单（不传 = 全落显式默认）。 */
        slots: planPayload.slots,
        acceptance: args.acceptance,
        testPoints: args.test_points,
        boundaries: args.boundaries,
        actorRole: ROLE.PLANNER,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ...empty, summary: res.error }
      indexTask(res.task.id, res.task)

      const r = res.roster
      const analysis = lastAnalysisOf(res.task)
      // ---------------------------------------------------------------------
      // ★ 需求留档：L1+ 的 requirement.md 由**留档 AI** 汇总产生，planner 不直接写它。
      //   planner 把自己这份（任务卡 + 计划 + 角色清单 + 分层）作为**自己那份记录**
      //   交出去（records/planner.md），留档 AI 读它 + 各方记录，汇总成唯一的需求档。
      //   （L0 没有留档 AI，仍由规则引擎在 pipeline_orchestrate 里直接落档。）
      // ---------------------------------------------------------------------
      const mdBody = renderRequirementDoc({
        task: res.task,
        roster: res.roster,
        acceptance: Array.isArray(args.acceptance) ? args.acceptance : (analysis?.payload?.acceptance ?? []),
        testPoints: Array.isArray(args.test_points) ? args.test_points : (analysis?.payload?.test_points ?? []),
        boundaries: Array.isArray(args.boundaries) ? args.boundaries : (analysis?.payload?.boundaries ?? []),
        unclearPoints: analysis?.payload?.unclear_points ?? [],
        planSteps: planPayload.plan_steps,
        reason: r.reason,
      })
      const myTok = tokens.findSeat(res.task.id, ROLE.PLANNER, null)
      const rec = await store.submitRecord({
        taskId: res.task.id,
        role: ROLE.PLANNER,
        seat: null,
        markdown: mdBody,
        sections: ['需求原文', '分档与角色', '验收标准', '测试要点', '边界与不做的事', '计划步骤', '分配理由'],
        source: '计划 AI：计划 + 自检 + 分配（档位 / 角色清单 / 席位分层都由它定）',
        structured: {
          tier: r.tier,
          roles: r.execution_roles,
          sequence: r.sequence.map((s) => s.role),
          layers: r.writers?.layers ?? [],
        },
        token: myTok,
        actorAgentId: actor.agentId,
      })
      if (rec.ok !== true) return { ...empty, summary: rec.error }
      indexTask(res.task.id, res.task)

      // ---------------------------------------------------------------------
      // ★ **派活那一刻记录改动基线**（用户要求：前后版本对比要有基准）
      //
      //   为什么放在这里：这一刻就是"计划定稿、即将派活"的边界 ——
      //   再往后就没有一个干净的时刻了（writer 一旦动手，基线就脏了）。
      //   基线 = 项目根的文件清单 + 每个文件的 sha256（**只存清单与哈希，不复制源码**），
      //   并绑定这次计划的 handoff id（可证明它属于哪一版计划）。
      // ---------------------------------------------------------------------
      let baseline = null
      {
        const bl = await store.takeBaseline({
          taskId: res.task.id,
          by: ROLE.PLANNER,
          planHandoffId: sub.handoff?.handoff_id ?? null,
          note: '派活那一刻的基线（由 pipeline_plan 自动记录）',
        })
        if (bl.ok === true) baseline = bl.baseline
        indexTask(res.task.id, res.task)
      }

      return {
        ok: true,
        allocated: true,
        tier: r.tier,
        ai_count: r.ai_count,
        roles: r.execution_roles.map((x) => roleLabel(x)).join(' / '),
        sequence: r.sequence.map((s) => roleLabel(s.role)).join(' → '),
        summary: [
          `计划自检通过（核对了 ${selfCheck.checked.length} 项），角色清单已产出：${r.tier}（${r.tier_zh}）· ${r.ai_count} 个独立对话`,
          `执行角色：${r.execution_roles.map((x) => roleLabel(x)).join(' / ')}`,
          `调用顺序：${r.sequence.map((s) => roleLabel(s.role)).join(' → ')}`,
          `分配理由：${r.reason}`,
          ...(r.writers
            ? [
                `编写席位：${r.writers.count} 个（席位数 = 层数 ${(r.writers.layers ?? []).length}）`,
                ...(r.writers.partitions ?? []).map(
                  (p) =>
                    `  · ${p.seat}｜层 ${p.layer} → ${(p.scope_paths ?? []).join('、')}` +
                    `${p.deliverables?.length ? `（${p.deliverables.join('、')}）` : ''}`,
                ),
                `分层理由：${r.writers.reason}`,
              ]
            : []),
          ...(baseline === null
            ? ['⚠ 改动基线**没能记录**（项目根读不到？）—— 审核阶段的前后版本对比会缺依据。']
            : [
                '',
                `★ **改动基线已记录**：${baseline.baseline_id}（${baseline.file_count} 个文件，${baseline.taken_at}）`,
                `  绑定计划：${baseline.plan_handoff_id ?? '(无)'}　清单指纹：${baseline.digest.slice(0, 16)}…`,
                '  它只存"文件清单 + 哈希"，不复制源码 —— 审核据此做前后版本对比。',
              ]),
          '',
          '★ 需求档（requirement.md）的**唯一写者**是留档 AI —— 计划 AI 不直接写它。',
          `计划 AI 已提交自己那份记录：${rec.record.rel_path}（${rec.record.record_id}）`,
          '  下一步：① 先派 archivist（留档）；② 各角色用 pipeline_record_submit 交自己那份记录；',
          '           ③ archivist 用 pipeline_compile_requirement 汇总成唯一的需求档。',
          '  ★ 需求档没汇总出来之前，除计划 AI 与留档之外的派活会被拒（没有留档就不许开工）。',
          '',
          '★★ **双轨派活**（用户要求）：需求档就绪后，**同时**把任务发给编写与审核 ——',
          '   审核不是等产物到了才被唤起，它在开工前就拿到：这次授权了什么、不许什么、它的边界卡、',
          '   以及改动基线。链路本身不变：编写 → 测试 → 才交审核。',
          `   派法：pipeline_dispatch role=writer（各席位）+ pipeline_dispatch role=reviewer。`,
        ].join('\n'),
      }
    },
  })

  // =========================================================================
  // 2.7 pipeline_scope_amend —— ★ 授权面变更：一条**只动授权面**的窄通道
  // =========================================================================
  //
  // 要解决的问题（真单现场）：用户已经在需求层裁定"允许把某样东西纳入授权面"，
  // 但计划工具只在「计划中」交得进计划（store 的 `checkHandoffAgainstState`：
  // `plan: [ST.PLANNING]`）—— 任务一进「待开发」，就变成
  // **裁定有了、动作做不了**，一个交付单元整轮走不动。
  //
  // ★ 为什么是"另开一个工具"而不是给 `pipeline_plan` 加 amendment 模式：
  //   `pipeline_plan.run()` 是无条件走「交计划 → setRoster → 记基线 → 交记录」的，
  //   要在它里面插一条只在 ready_dev 生效的旁路，就得在那条原本线性、且**写角色清单**
  //   的路上多开一个分支 —— 而角色清单正是这次**碰都不许碰**的东西。
  //   独立工具的参数面里**根本没有** roster / tier / writers / layers / sequence，
  //   于是"只动授权面"是**能力边界**，不是靠自觉。
  //
  // ★ 计划那道"跳步"闸一个字没动：`plan` 交接物仍然只能在「计划中」提交。
  const scopeAmend = tool(deps, {
    name: 'pipeline_scope_amend',
    mutating: true,
    description:
      '【计划 AI 专用】★ **授权面变更（amendment）** —— 只做一件事：追加/撤销计划的 ' +
      '`change_scope`（这次允许改哪些文件）与 `forbidden`（这次不许做什么）。' +
      '★ 为什么需要它：用户已在需求层裁定"允许纳入"，但计划工具只在「计划中」能出计划 —— ' +
      '任务一旦进「待开发」，那条裁定就**做不了**，交付单元卡死。这条窄通道补的就是这一步。' +
      '★ **硬的边界**：只在**「待开发」(ready_dev)** 生效、**只有计划 AI** 能调；' +
      '**席位 / 角色清单 / 档位 / 调用顺序 / 层划分一个字都不许动** —— 入参里出现那些字段直接拒' +
      '（要改那些请走 pipeline_plan 重出计划，或 pipeline_roster_request → pipeline_roster_review）。' +
      '★ 计划那道"跳步"闸**没有被放宽**：plan 交接物仍然只能在「计划中」提交。' +
      '每次变更都留痕（task.json 的 amendments[] + audit.jsonl 的 scope:amend），pipeline_status 可见。',
    parameters: {
      task_id: S('string', '任务 ID'),
      why: S('string', '★ **为什么非扩它不可**（必填）—— 与计划里的 change_scope[].why 是同一面照妖镜："顺手扩一点"写不出理由'),
      add: S('array', '追加的授权条目 [{ id, path, action: modify|create|delete, why }]（校验器与计划里那份同一个）', { items: { type: 'object', additionalProperties: true } }),
      remove: S('array', '要撤销的授权条目 id（在现有授权面里找不到就拒）', { items: { type: 'string' } }),
      forbidden_add: S('array', '追加的**越界清单**条目（这次又多不许做什么）', { items: { type: 'string' } }),
      forbidden_remove: S('array', '撤销的越界清单条目（原文必须完全一致）', { items: { type: 'string' } }),
      note: S('string', '备注（可选，会一起留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（变更前后 + 拒绝原文）'),
      amendment_id: S('string', '本次变更的 id（被拒时为空串）'),
      /** ★ 更新后的授权面与越界清单 —— 调用方不用再去查一次。 */
      change_scope: S('array', '★ **变更后**的授权改动面 [{ id, path, action, why }]', { items: { type: 'object', additionalProperties: true } }),
      forbidden: S('array', '★ **变更后**的越界清单', { items: { type: 'string' } }),
      amendments_total: S('number', '★ 本任务累计变更过几次（含本次）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      const empty = { ok: false, amendment_id: '', change_scope: [], forbidden: [], amendments_total: 0 }
      if (actor.ok !== true) return { ...empty, summary: actor.error }

      const res = await store.amendScope({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        why: args.why,
        add: args.add,
        remove: args.remove,
        forbiddenAdd: args.forbidden_add,
        forbiddenRemove: args.forbidden_remove,
        note: args.note,
        /**
         * ★ 把**原始入参**原样交给 store 做白名单核对（见 `findNonScopeKeys`）。
         *
         *   为什么不在这一层判：这条判据必须与落盘在**同一个函数**里 ——
         *   否则将来多一条入口（或有人直接调 store）就绕过去了。
         *   工具层只负责"把原样参数递下去"。
         */
        raw: args,
      })
      // ⚠️ 被拒时也要刷新同步索引：`amendScope` 有"先在副本上算、全部通过才落盘"
      //    的写法，所以被拒时任务**没有被改**；但守门读的是索引里那份任务对象，
      //    刷新一次是零成本的保险（"失败分支没刷新索引 ⇒ 拦截静默失效"是踩过的坑）。
      if (res.ok !== true) {
        indexTask(String(args.task_id ?? ''), await load(String(args.task_id ?? '')))
        return { ...empty, summary: res.error }
      }
      indexTask(res.task.id, res.task)

      const t = res.task
      return {
        ok: true,
        amendment_id: res.amendment.amendment_id,
        change_scope: Array.isArray(t.change_scope) ? t.change_scope : [],
        forbidden: toStringArray(t.plan_forbidden),
        amendments_total: Array.isArray(t.amendments) ? t.amendments.length : 0,
        summary: res.summary,
      }
    },
  })

  // =========================================================================
  // 2.6 pipeline_change_audit —— 前后版本对比（基线 → 当前）
  // =========================================================================
  //
  // ★ 用户要求：「审核 ai 确认没有干不该干的事（**前后版本对比**）」。
  //   审核**不读代码**（那条边界还在），所以"对比"不能靠眼睛 —— 靠**哈希**：
  //   派活那一刻记了基线（文件清单 + 每个文件的 sha256），这里按基线逐文件比。
  //
  // 产出三类结论（用户点名要的）：
  //   · **多改**：清单外的文件被改 / 被新增（`unauthorized`）
  //   · **少改**：授权了却没动（`missing`）
  //   · **改错地方**：动的不是授权的那份（同样进 `unauthorized`，带 `how`）
  const changeAuditTool = tool(deps, {
    name: 'pipeline_change_audit',
    mutating: false,
    description:
      '【任何角色】★ **前后版本对比**：拿「改动基线」（派活那一刻记录的项目文件清单 + 哈希）' +
      '与当前状态逐文件比，产出「实际改动面 vs 授权面」的对照结论 —— ' +
      '**多改 / 少改 / 改错地方**三类都报出来。' +
      '★ 判据是**哈希比对**，不是"看代码"：所以审核可以在不读代码的前提下拿到判据式证据。' +
      '审核提交 review_verdict 时要把这份结论填进 change_audit（有基线时必填，且 store 会复核）。' +
      'take=true 可以**重新记录基线**（只有计划 AI / 主对话能调，会留痕）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      take: S('boolean', '★ 重新记录基线（把**当前**状态当成新的对比基准）。只有计划 AI / 主对话能调'),
      note: S('string', '重取基线时的说明（take=true 时建议给：为什么要重新基准）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（三类结论 + 逐条路径）'),
      verdict: S('string', '★ 对照结论：within_scope（全在授权面内）/ out_of_scope（有多改）'),
      baseline_id: S('string', '用的是哪一版基线'),
      unauthorized: S('array', '★ 多改 / 改错地方：清单外的改动 [{ path, how }]', { items: { type: 'object', additionalProperties: true } }),
      missing: S('array', '★ 少改：授权了却没动的条目 [{ scope_id, path }]', { items: { type: 'object', additionalProperties: true } }),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, verdict: '', baseline_id: '', unauthorized: [], missing: [] })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return fail(`找不到任务 ${args.task_id}。`)

      // --- take：重新记录基线（权限收在白名单里）---
      if (args.take === true) {
        if (actor.role !== ROLE.PLANNER && actor.role !== ROLE.MAIN) {
          return fail(
            `拒绝重取基线：只有**计划 AI**（或主对话兜底）能重新记录改动基准，当前角色是「${roleLabel(actor.role)}」。\n` +
              '★ 基线是"没动手之前的样子" —— 谁能重设它，谁就能把已经改过的东西洗成"本来就这样"。',
          )
        }
        const bl = await store.takeBaseline({
          taskId: task.id,
          by: actor.role,
          planHandoffId: task.plan_handoff_id ?? null,
          note: typeof args.note === 'string' ? args.note : '手工重取',
        })
        if (bl.ok !== true) return fail(bl.error)
        indexTask(bl.task.id, bl.task)
        return {
          ok: true,
          verdict: '',
          baseline_id: bl.baseline.baseline_id,
          unauthorized: [],
          missing: [],
          summary:
            `已重新记录改动基线：${bl.baseline.baseline_id}\n` +
            `  ${bl.baseline.file_count} 个文件，清单指纹 ${bl.baseline.digest.slice(0, 16)}…（${bl.baseline.taken_at}）\n` +
            '★ 从此往后的改动都按这一版基线比。重取会留痕（audit: baseline:take）。',
        }
      }

      const res = await store.changeAudit({ taskId: task.id })
      if (res.ok !== true) return fail(res.error)

      const lines = [
        `前后版本对比 · 任务 ${task.id}`,
        `基线：${res.baseline.baseline_id}（${res.baseline.file_count} 个文件，记于 ${res.baseline.taken_at}，由 ${res.baseline.taken_by} 记录）`,
        `结论：**${res.verdict === 'within_scope' ? '全在授权面内 ✓' : '有多改 ✗'}**`,
        '',
        `新增 ${res.counts.added} · 修改 ${res.counts.modified} · 删除 ${res.counts.removed}　` +
          `多改/改错地方 ${res.counts.unauthorized} · 少改（授权了没动）${res.counts.missing}`,
        '',
        res.unauthorized.length > 0
          ? `★ **多改 / 改错地方**（清单外的改动）：\n${res.unauthorized.map((x) => `  · ${x.how}：${x.path}`).join('\n')}`
          : '★ 多改：**没有**（实际改动面全在授权面内）。',
        res.missing.length > 0
          ? `⚠ **少改**（计划授权了、但一个都没动）：\n${res.missing.map((x) => `  · ${x.scope_id} ${x.path}`).join('\n')}`
          : '少改：没有。',
        '',
        '明细：',
        ...(res.added.length > 0 ? res.added.map((x) => `  + ${x.path}`) : []),
        ...(res.modified.length > 0 ? res.modified.map((x) => `  ~ ${x.path}`) : []),
        ...(res.removed.length > 0 ? res.removed.map((x) => `  - ${x.path}`) : []),
        ...(res.added.length + res.modified.length + res.removed.length === 0 ? ['  （一个文件都没动）'] : []),
        '',
        '★ 这份结论要填进 review_verdict.change_audit（有基线时必填；store 会自己再算一遍核对）。',
        '  change_audit = { baseline_id: "' + res.baseline.baseline_id + '", verdict: "' + res.verdict + '", unauthorized: ' + JSON.stringify(res.unauthorized) + ', missing: ' + JSON.stringify(res.missing) + ' }',
      ]
      return {
        ok: true,
        summary: lines.join('\n'),
        verdict: res.verdict,
        baseline_id: res.baseline.baseline_id,
        unauthorized: res.unauthorized,
        missing: res.missing,
      }
    },
  })

  // =========================================================================
  // 2.7 pipeline_boundaries —— ★ 机器可读的边界清单（给别的执法层复用）
  // =========================================================================
  //
  // ★ 用户要求：「把本项目"谁、什么边界、什么判据"导出成一份**机器可读的边界清单**
  //   （例如一个 JSON 或一个只读子命令），供**那层钩子**复用 ——
  //   不要为了这个改坏既有结构」。
  //
  // 所以它：只读、不依赖任务、不需要身份；数据由 `lib/boundaries.js`
  // 从**真实常量**（roles / guard / handoff / states）派生，不手抄。
  const boundariesTool = tool(deps, {
    name: 'pipeline_boundaries',
    mutating: false,
    description:
      '【任何角色 · 只读】★ 导出**机器可读的边界清单**：每个角色的写权限（含"只读 / 只写自己那一片"）、' +
      '六条设计目的的**判据落点**（函数名）、交接物方向表、状态迁移表，' +
      '以及一份"**判据化不了的**自然语言约束"诚实清单（别假装它被执法了）。' +
      '数据从插件里的真实常量派生（不手抄），并会做一次**漂移检查**：' +
      '角色表里的 writes 取值若守门认不出，会出现在 unmapped 里。' +
      '用途：DSH 层的 UserPromptSubmit / PreToolUse 钩子不需要读本插件源码，读这份 JSON 就够。' +
      'format=json 返回纯 JSON（给程序吃），默认返回人读摘要。',
    parameters: {
      format: S('string', "输出格式：'text'（默认，给人看）/ 'json'（给程序吃）"),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '边界清单（text 为摘要，json 为完整 JSON 文本）'),
      manifest: S('object', '★ 结构化清单（钩子层直接取这个字段）', { additionalProperties: true }),
    },
    async run(args) {
      const m = boundaryManifest()
      const asJson = String(args.format ?? '') === 'json'
      return {
        ok: true,
        summary: asJson ? JSON.stringify(m, null, 2) : renderBoundaryManifest(m),
        manifest: m,
      }
    },
  })

  // =========================================================================
  // 2.8 pipeline_full_test —— ★ 全量测试审批链的进度（只读）
  // =========================================================================
  //
  //   ★ 用户要求这条链"和既有的两级梯合流"：
  //     · 四级里的**人工那一站**用的就是既有的 human_request / human_reply；
  //     · 另外三站是 full_test_request / full_test_review 两种交接物（走 pipeline_handoff）。
  //   这个工具只做一件事：**把链的进度与"还差谁点头"摊开**（只读，谁都能查）。
  //
  //   为什么需要它：守门拦下全量命令时只会给一句"走审批链"，
  //   而"现在走到哪一站了、还差谁"必须能被一眼看到 —— 否则这条链就成了黑箱。
  const fullTestTool = tool(deps, {
    name: 'pipeline_full_test',
    mutating: false,
    description:
      '【任何角色 · 只读】★ 查**全量测试审批链**的进度：这条链回答的是「**这套测试值不值得跑**」' +
      '（成本决策）—— 与澄清梯回答的「需求清不清楚」不是同一个问题。' +
      '四级：tester 提申请 → 需求分析 need → 审核 worth → 用户人工 → 计划 arrange。' +
      '缺一级都不许开跑；任一站否决就停住（留痕）。' +
      '本工具不改任何东西：申请/裁定走 pipeline_handoff，人工那站走 pipeline_human_request。',
    parameters: {
      task_id: S('string', '任务 ID'),
      role_token: S('string', '角色令牌（查询也建议带上）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '可直接阅读的审批链进度'),
      status: S('string', 'pending | rejected | approved | none'),
      next_stage: S('string', '还差谁点头'),
      credential: SNullable('object', '★ 当前可用的放行凭据（没有则为 null）', { additionalProperties: true }),
    },
    async run(args, exec) {
      void exec
      const empty = { ok: false, status: 'none', next_stage: '', credential: null }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ...empty, summary: `找不到任务 ${args.task_id}。` }
      const list = Array.isArray(task.full_test_approvals) ? task.full_test_approvals : []
      const cred = store.currentBaseline === undefined ? null : null
      void cred
      if (list.length === 0) {
        return {
          ok: true,
          status: 'none',
          next_stage: 'tester-request',
          credential: null,
          summary:
            `任务 ${task.id} 还没有任何全量测试申请。\n` +
            '★ 默认就应该是这样：**测试只跑定向/增量**（按改动面挑相关用例）。\n' +
            '  真要跑全量，由 tester 交 pipeline_handoff kind=full_test_request 起链。',
        }
      }
      const c = list[list.length - 1]
      const stage = nextFullTestStage(c)
      const mark = (rec, name) =>
        rec === null
          ? `  · ${name}：**未做**`
          : `  · ${name}：${rec.ok === false ? '**否决**' : '同意'}${rec.at ? `（${rec.at}）` : ''} —— ${String(rec.reason ?? '').slice(0, 80)}`
      const lines = [
        `全量测试审批链 · 任务 ${task.id}（第 ${c.round} 次申请）`,
        `申请：${c.approval_id}（${c.created_at} 由 ${roleLabel(c.created_by)} 提出）`,
        `打算跑：${c.request.what_will_run}`,
        `本次改动面：${(c.request.affected_paths ?? []).join('、') || '(未填)'}`,
        `为什么定向不够：${c.request.why_targeted_insufficient}`,
        '',
        `当前状态：**${c.status === 'approved' ? '已批准 ✓' : c.status === 'rejected' ? `已否决 ✗（停在 ${c.rejected_at_stage} 站）` : '在办'}**`,
        `下一站：${describeStage(stage)}`,
        '',
        mark(c.need, '① 需求分析（这次是否需要）'),
        mark(c.worth, '② 审核（值不值得）'),
        c.human === null
          ? '  · ③ 用户人工：**未发起**（主对话用 pipeline_human_request reason_kind=full_test_approval）'
          : `  · ③ 用户人工：${c.human.approved === true ? '通过' : c.human.approved === false ? '**未通过**' : '等答复'}（${c.human.request_id}）`,
        c.arranged === null
          ? '  · ④ 计划 AI（怎么跑）：**未安排**'
          : `  · ④ 计划 AI（怎么跑）：${c.arranged.command ? `批准命令 \`${c.arranged.command}\`` : '(同意但没给命令)'}`,
        '',
        c.status === 'rejected' ? `否决理由：${c.reject_reason}` : '',
        '★ 守门在 shell 那一层按"最终批准的命令"放行：跑别的全量命令会被拒（批一条跑另一条 = 没审批）。',
        '★ 定向测试（带 --grep / -k / 具体测试文件或包）**不需要**这条链，直接跑。',
      ]
      return {
        ok: true,
        status: c.status,
        next_stage: stage,
        credential: fullTestCredential(task),
        summary: lines.filter((l) => l !== '').join('\n'),
      }
    },
  })

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

  // =========================================================================
  // 5. pipeline_handoff —— 提交结构化交接物
  // =========================================================================
  const handoff = tool(deps, {
    name: 'pipeline_handoff',
    mutating: true,
    description:
      '提交一份**结构化交接物**，这是流水线上唯一的"交付"入口。每种类型有固定字段，缺字段会被拒。' +
      '方向由类型决定，不能自选：' +
      'dev_to_test（编写→测试：代码或补丁/变更说明/运行命令/自测结果/已知问题）；' +
      'test_to_review（测试→审核：测试用例/执行结果/失败日志/通过证据/风险说明）；' +
      'review_verdict（审核→主对话：结论 OK 或 NG/风险说明/是否放行/最终交付说明）；' +
      '以及 orchestration / design / security_review / release_plan / docs_note / perf_report / arbitration / human_note。' +
      '★ 编写不能直接提交审核 —— kind=review_verdict 只允许审核角色产出，状态机也不接受 开发中→待审核。',
    parameters: {
      task_id: S('string', '任务 ID'),
      kind: S('string', '交接物类型', { enum: Object.keys(HANDOFF_SCHEMAS) }),
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
        if (waiting || String(res.code ?? '') === 'HANDOFF_STEP_SKIPPED') {
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
          try {
            await deps.wakeup?.wake?.({
              taskId: String(args.task_id ?? ''),
              actorRole: actor.role,
              actorSeat: actor.seat ?? null,
              kind: 'delivery-rejected',
              what: `提交的**交接物被拒收**（${HANDOFF_SCHEMAS[kind]?.zh ?? kind}）—— 这条**没有**被接收，但内容已留档`,
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
      event: S('string', '事件名（dispatch_orchestrator / requirement_confirmed / dispatch_planner / planned / dispatch_writer / dev_submitted / dispatch_tester / test_passed / dispatch_reviewer / review_ok / close / block / unblock / cancel 等）'),
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

        // ★★ **唤醒必须真的投到会话**（不是只改一个字段）。
        //   安全预审的准入判据形态写死：「唤醒动作（主管侧：谁叫、能不能叫）与产物的
        //   产出（席位侧：叫了也不能提前产出）必须**各有一道**判据」。
        //   上面那道是"能不能叫"（guard + by 名单）；这一处是"叫了要真的到"。
        //   ★ 通道不可达时**不静默降级**（越界清单第 13 条）：失败原文照原样拼进 summary，
        //     并给出等价可达路径，让主对话当场看见。
        let wakeLines = []
        const WP = action === 'agree_need'
          ? HUB_WAKE_POINTS.NEED_AGREE
          : action === 'reconfirm_diagram' ? HUB_WAKE_POINTS.DIAGRAM_CONFIRM : null
        if (WP !== null) {
          const targets = (Array.isArray(res.task.hub?.standby) ? res.task.hub.standby : [])
            .filter((s) => s?.wake_point === WP && s?.status === 'woken')
          for (const s of targets) {
            const body =
              `【流水线 · 唤醒】你是「${roleLabel(s.role)}」（${s.group}），现在**到点了**。\n` +
              `任务：${res.task.id}　唤醒点：**${WP === HUB_WAKE_POINTS.NEED_AGREE ? '主管同意需求结论' : '主管确认架构图满足要求'}**\n` +
              `任务当前状态：${STATE_LABEL[res.to] ?? res.to}（\`${res.to}\`）\n` +
              '★ 这条是**运行时上下文**，不是用户说的话。\n' +
              '★ 在此之前你处于「已登记待机」—— 那时交产物、写自己目录的报告、跑测试都会被守门/状态机拒。\n' +
              '下一步：pipeline_status 读回你的边界与当前位置，然后做你那一份活。'
            const r = await nudgeSeat(res.task, s.role, null, body, { kind: 'hub-wake', requestId: `${res.task.id}|hub-wake|${WP}|${s.role}` })
            wakeLines.push(r.ok === true ? `  ✓ 已唤醒 ${roleLabel(s.role)}（会话 ${r.sessionId}）` : `  ✗ 唤醒 ${roleLabel(s.role)} **没投出去**：${r.note}`)
          }
          if (wakeLines.some((l) => l.includes('✗'))) {
            wakeLines.push('★ 通道不可达时**不静默降级**（越界清单第 13 条）：上面对不上的那几行是**失败原文**。' +
              '等价可达路径：主对话用 `pipeline_dispatch { notify_only: true, role, message }` 手动催；' +
              '若席位根本没建起来，用 `pipeline_dispatch { role, reassign: true }` 重派。')
          }
        }

        const hub = res.task?.hub ?? null
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
        if (t0 === null) return { ok: false, summary: `找不到任务 ${taskId}。`, state: '', handoff_id: '' }
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
        if (t0 === null) return { ok: false, summary: `找不到任务 ${taskId}。`, state: '', handoff_id: '' }
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

  // =========================================================================
  // 9. pipeline_status —— 查询（可追溯）
  // =========================================================================
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

      const lines = [
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
          : res.handoffs.map((h) => `  [${h.kind_zh}] ${h.from_role}→${h.to_role}  ${h.artifact_version ?? '-'}  ${h.handoff_id}`)),
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

      if (args.include_audit === true) {
        const log = await store.auditLog(taskId)
        lines.push('', `审计日志（${log.length} 条）：`, ...log.map((e) => `  ${e.at}  ${e.actor}  ${e.action}  ${clamp(JSON.stringify({ ...e, at: undefined, task_id: undefined, actor: undefined, action: undefined }), 200)}`))
      }

      if (args.full === true && !isMain) {
        lines.push('', '完整交接物：', '```json', JSON.stringify(res.handoffs, null, 2), '```')
      } else if (isMain || actor.ok !== true) {
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

  // =========================================================================
  // 10/11. 角色变更：申请 + 复核
  // =========================================================================
  const rosterRequest = tool(deps, {
    name: 'pipeline_roster_request',
    mutating: true,
    description:
      '【执行角色专用】提出角色变更申请（加人/减人）。这是**唯一**的入口 —— 主对话不能自己决定加人减人。' +
      '流程：编写/测试/审核提出申请 → **计划 AI**（planner）复核 → 输出新角色清单 → 主对话按新清单派活。',
    parameters: {
      task_id: S('string', '任务 ID'),
      add: S('array', '建议追加的角色（可空）', { items: { type: 'string' } }),
      remove: S('array', '建议移除的角色（可空；三权分立角色不可移除）', { items: { type: 'string' } }),
      reason: S('string', '为什么要加/减人（必填，会留痕）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      request_id: S('string', '申请 id'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '' }
      const res = await store.requestRosterChange({
        taskId: String(args.task_id ?? ''),
        actorRole: actor.role,
        add: args.add,
        remove: args.remove,
        reason: args.reason,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '' }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        request_id: res.request.request_id,
        summary:
          `${res.summary}\n` +
          `可用扩展角色：${L5_EXTENSION_POOL.join(' / ')}\n` +
          '下一步：等**计划 AI**（planner）调 pipeline_roster_review 复核（主对话不批）。',
      }
    },
  })

  const rosterReview = tool(deps, {
    name: 'pipeline_roster_review',
    mutating: true,
    description:
      '【计划 AI 专用】复核一条角色变更申请。批准则**由本次复核直接改写角色清单**并留痕；驳回则说明理由。' +
      '★ 主对话不能批自己的申请，也不能直接改角色清单 —— 这条路径是封闭的。\n' +
      '★ 本轮改动：复核权从需求分析（orchestrator）移到**计划 AI**（planner）—— 加人减人就是改角色清单，那就是分配。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '申请 id'),
      approve: S('boolean', '是否批准'),
      note: S('string', '复核意见（驳回时必填）'),
      /**
       * ★ 批准**加人**时必须给新角色的边界卡。
       *
       * 为什么：计划里的 `role_boundaries` 是在分配那一刻写死的（覆盖当时的执行角色）。
       * 中途加人 = 加一张新卡 —— 那是分配的一部分，本来就是计划 AI 的活。
       * 缺了这张卡，新角色派活时就没有"只干什么、不干什么"可依据 ⇒ setRoster 会拒。
       */
      role_boundaries: S('array', '★ 新角色的边界卡 [{ role, only: string[], not: string[] }] —— **批准加人时必填**', { items: { type: 'object', additionalProperties: true } }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      applied: S('boolean', '是否已改写角色清单'),
      ai_count: S('number', '新清单的独立对话数'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, applied: false, ai_count: 0 }
      if (args.approve !== true && (typeof args.note !== 'string' || args.note.trim().length === 0)) {
        return { ok: false, summary: '驳回角色变更申请必须给 note（理由）。', applied: false, ai_count: 0 }
      }
      const res = await store.reviewRosterChange({
        taskId: String(args.task_id ?? ''),
        requestId: String(args.request_id ?? ''),
        approve: args.approve === true,
        note: args.note,
        roleBoundaries: Array.isArray(args.role_boundaries) ? args.role_boundaries : [],
        actorRole: actor.role,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, applied: false, ai_count: 0 }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        applied: res.applied === true,
        ai_count: res.task.roster?.ai_count ?? 0,
        summary: res.summary,
      }
    },
  })

  // =========================================================================
  // 12. pipeline_artifact —— 制品登记（版本化 + 可回滚）
  // =========================================================================
  const artifact = tool(deps, {
    name: 'pipeline_artifact',
    mutating: true,
    description:
      '【编写角色专用】登记一个代码制品版本（v1、v2…），落盘到 <项目>/.pipeline/<任务>/artifacts/vN/。' +
      '制品版本化是"审核的是不是同一个版本"的判定依据：测试报告与审核结论都要带上 artifact_version，' +
      '对不上就拒绝。rollback_to 可以把某个历史版本重新登记为当前版本（旧版本不删）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      content: S('string', '制品内容（补丁或代码正文）'),
      file_name: S('string', '文件名（默认 artifact.txt）'),
      note: S('string', '备注（可空）'),
      rollback_to: S('string', '回滚到某个版本号（给了就忽略 content）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      version: S('string', '登记出的版本号'),
      sha256: S('string', '内容哈希'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, version: '', sha256: '' }
      const res =
        typeof args.rollback_to === 'string' && args.rollback_to.length > 0
          ? await store.rollbackArtifact({
              taskId: String(args.task_id ?? ''),
              version: args.rollback_to,
              actorRole: actor.role,
              actorAgentId: actor.agentId,
            })
          : await store.registerArtifact({
              taskId: String(args.task_id ?? ''),
              content: String(args.content ?? ''),
              fileName: typeof args.file_name === 'string' && args.file_name.length > 0 ? args.file_name : undefined,
              note: typeof args.note === 'string' ? args.note : '',
              actorRole: actor.role,
              actorAgentId: actor.agentId,
            })
      if (res.ok !== true) return { ok: false, summary: res.error, version: '', sha256: '' }
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        version: res.artifact.version,
        sha256: res.artifact.sha256,
        summary: `${res.summary}\n落盘：${res.artifact.file}`,
      }
    },
  })

  // =========================================================================
  // 13. pipeline_selftest —— 守门自检（在真实环境里复现反例）
  // =========================================================================
  const selftest = tool(deps, {
    name: 'pipeline_selftest',
    description:
      '守门自检：在**内存里**跑一遍正例全流程与全部反例，把每条拒绝原文原样打出来。' +
      '不创建任何真实会话、不写工作区之外的任何文件（只在一个临时任务目录里跑，跑完即删）。' +
      '用途：装完之后当场确认"机制真的在生效"，而不是读 README 猜。',
    parameters: {
      verbose: S('boolean', '是否打印每条用例的完整拒绝原文（默认 true）'),
    },
    output: {
      ok: S('boolean', '自检是否全部通过'),
      summary: S('string', '自检报告'),
    },
    async run(args) {
      // `tests/` 可能没被装过去（install.ps1 的 -WithDocs 才装 examples/REPORT.md，
      // 但 tests/ 是默认装的 —— 因为本工具依赖它）。拷不到就**明说**，不要抛。
      let runSelfTest
      try {
        ;({ runSelfTest } = await import('../tests/selftest-core.mjs'))
      } catch (err) {
        return {
          ok: false,
          summary:
            '[pipeline] 自检不可用：找不到 tests/selftest-core.mjs。\n' +
            `原因：${String(err?.message ?? err)}\n` +
            '修法：用 install.ps1 重装一次（它会带上 tests/），' +
            '或手工把插件源目录的 tests/ 拷到已安装的 dsh-pipeline 目录下。\n' +
            '注意：这不代表守门没生效 —— 只是这个"当场自检"入口缺了依赖。',
        }
      }
      const report = await runSelfTest({ verbose: args.verbose !== false })
      return { ok: report.passed === report.total, summary: report.text }
    },
  })

  // =========================================================================
  // 14. pipeline_switch —— 功能开关（与右上角 UI 开关是同一个开关位）
  // =========================================================================
  const switchTool = tool(deps, {
    name: 'pipeline_switch',
    description:
      '多 AI 协调功能的总开关（与 DSH 窗口右上角那个「多AI 协调」按钮**是同一个开关位**）。' +
      '不带参数 = 直接翻转；带 on=true/false = 显式设定。' +
      '开 = 编排（角色清单/调用顺序）+ 守门（越权拦截）+ 状态机全都管；' +
      '关 = 关闭该功能，回到普通 DSH 行为：守门不介入，流水线的写入动作被拒（查询与自检仍可用）。' +
      '切换立即生效，不需要重启；状态会落盘，重启后保持。',
    parameters: {
      on: S('boolean', '显式设定：true=开，false=关。留空 = 翻转当前状态'),
      reason: S('string', '变更原因（会记进日志与状态文件，可空）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      on: S('boolean', '切换后的状态'),
      changed: S('boolean', '这一次是否真的变了'),
      revision: S('number', '状态修订号（每次真正变更 +1）'),
      persisted: S('boolean', '是否成功落盘'),
    },
    async run(args) {
      if (sw === undefined || sw === null) {
        return { ok: false, on: false, changed: false, revision: 0, persisted: false, summary: '[pipeline] 功能开关未初始化（插件内部错误）。' }
      }
      const before = sw.snapshot()
      const meta = { by: 'tool', reason: typeof args.reason === 'string' ? args.reason : '' }
      const res = typeof args.on === 'boolean' ? sw.set(args.on, meta) : sw.toggle(meta)
      const after = res.state
      const lines = [
        `${res.changed ? '已切换' : '状态未变'}：多 AI 协调功能 **${after.on ? '开' : '关'}**。`,
        `修订号：${after.revision}${res.changed ? `（上一次是 ${before.revision}）` : ''}`,
        `生效时间：${after.since}　来源：${after.by}`,
        `落盘：${res.persisted ? '成功' : '**失败**（内存态仍生效，重启会丢；日志里有原因）'}`,
        `状态文件：${sw.stateFile}`,
        '',
        after.on
          ? '现在是**开**：主对话按角色清单调度，编写/测试/审核三权分立，越权动作会被守门拦下，没有审核 OK 关不了单。'
          : '现在是**关**：守门已弃权（任何调用都不再被本插件拦），流水线的写入动作（开单/编排/派活/交接/打回/关单等）会被拒绝，' +
            '只读动作（pipeline_status / pipeline_selftest / 本工具）仍然可用。',
        '',
        '同一个开关位的另一个入口：DSH 窗口右上角头部那一排里的「多AI 协调」按钮（点一下即切）。',
      ]
      return { ok: true, on: after.on, changed: res.changed, revision: after.revision, persisted: res.persisted, summary: lines.join('\n') }
    },
  })

  // =========================================================================
  // 23~25. ★分权落档（留档 AI）+ 联系人查询
  // =========================================================================

  const recordSubmit = tool(deps, {
    name: 'pipeline_record_submit',
    mutating: true,
    description:
      '【除留档 AI 外的所有角色】★ 把**自己那份**记录提交给留档 AI（更正 A）。' +
      '落盘在约定位置 `.pipeline/<taskId>/records/<role>[-<seat>].md` + `.json`，**互不覆盖**（谁的记录谁写）。' +
      '提交会**带上你的席位令牌** —— 留档 AI 靠它**校验来路**（谁写的、哪个席位、哪一版），拒绝匿名 / 冒名。' +
      '留档 AI 收集所有记录后统一编写成唯一的需求档 `requirement.md`，每条内容都标来源，可逐条追溯。' +
      '★ 你不能直接写 requirement.md（那是留档 AI 的活）；你只写自己那份记录。',
    parameters: {
      task_id: S('string', '任务 ID'),
      markdown: S('string', '★ 你这份记录的内容（markdown）'),
      sections: S('array', '你负责的小节名（如 ["验收标准","测试要点"]）'),
      source: S('string', '这份记录的依据（如：需求原文 / 与用户确认 / 代码事实）'),
      structured: S('object', '结构化版本（可选）', { additionalProperties: true }),
      role_token: S('string', '★ 你的角色令牌（提交必须带凭据）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      record_id: S('string', '记录 id（供留档 AI 追溯来源）'),
      path: S('string', '落盘的约定路径'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, record_id: '', path: '' }
      if (actor.role === ROLE.ARCHIVIST) {
        return {
          ok: false,
          summary:
            '留档 AI 不需要给自己提交记录 —— 你的活是**汇总**别人的记录（pipeline_compile_requirement）。\n' +
            '★ 如果你对需求有判断，那也应该走 clarify_request / 升级，而不是把自己写进来源里。',
          record_id: '',
          path: '',
        }
      }
      const tok = tokens.roleOfAgent(actor.agentId, String(args.task_id ?? ''))
      const res = await store.submitRecord({
        taskId: String(args.task_id ?? ''),
        role: actor.role,
        seat: actor.seat ?? null,
        markdown: args.markdown,
        sections: args.sections,
        source: args.source,
        structured: args.structured,
        token: tok,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, record_id: '', path: '' }
      indexTask(res.task.id, res.task)
      return { ok: true, summary: res.summary, record_id: res.record.record_id, path: res.record.rel_path }
    },
  })

  const compileRequirement = tool(deps, {
    name: 'pipeline_compile_requirement',
    mutating: true,
    description:
      '【只有留档 AI】★ 把各方记录**汇总**成唯一的需求档 `requirement.md`（+ 结构化 JSON）。' +
      '两条硬规则：① **每条内容必须有来源**（source_record 必须指向一份真实存在的记录）—— 不得凭空写入；' +
      '② **遇到互相矛盾的记录不得自己拍板** —— 报告 conflicts 就会被拒，要求你先走 clarify_request 或升级给用户。' +
      '生成的需求档里每条内容都标了来源（记录 id + 提交者 + 时间），版本与差异由版本索引维护。',
    parameters: {
      task_id: S('string', '任务 ID'),
      entries: S('array', '★ 汇总条目 [{ section, text, source_record }] —— source_record 必填'),
      conflicts: S('array', '★ 你发现的互相矛盾之处 [{ about, between:[记录id] }] —— 非空则拒绝汇总'),
      notes: S('array', '留档说明（可选）'),
      role_token: S('string', '你的角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      version: S('string', '需求档版本（v1/v2…）'),
      sources: S('number', '用到了几份记录'),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, version: '', sources: 0 })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      if (actor.role !== ROLE.ARCHIVIST) {
        return fail(
          `只有留档 AI 能汇总需求档，当前调用方是「${roleLabel(actor.role)}」。\n` +
            '★ 需求档是**分权写 + 专人汇总**出来的：各方在 records/ 下写自己那份，留档 AI 收集后统一编写。\n' +
            '  你要是对需求有补充 → 用 pipeline_record_submit 写**自己那份**记录。',
        )
      }
      const res = await store.compileRequirement({
        taskId: String(args.task_id ?? ''),
        entries: args.entries,
        conflicts: args.conflicts,
        notes: args.notes,
        actorAgentId: actor.agentId,
      })
      if (res.ok !== true) return fail(res.error)
      indexTask(res.task.id, res.task)
      return {
        ok: true,
        summary: res.summary,
        version: res.doc.version,
        sources: new Set((args.entries ?? []).map((e) => e.source_record)).size,
      }
    },
  })

  const contacts = tool(deps, {
    name: 'pipeline_contacts',
    mutating: false,
    description:
      '【任何角色】★ 查**当前联系人**：现在谁是指派者（**计划 AI / 分配 AI**）、谁在哪个席位、谁已经退场。' +
      '为什么必须能查：计划 AI 自己也会继任 —— 查不到「当前分配 AI 是谁」，上报就会发给一个**已经退场的席位**，' +
      '那条消息永远不会有人看。所以每个席位在行动前都该先确认联系人。' +
      '（继任发生时插件会**广播**新联系人给所有已绑定席位；这里是事后再确认的地方。）' +
      '⚠️ 历史沿革：分配权本轮从需求分析（orchestrator）移给了计划 AI（planner），' +
      '所以 `orchestrator_agent` / `orchestrator_seat` 这两个**旧字段名**保留为别名（值与 planner_* 相同），新代码请用 planner_*。',
    parameters: {
      task_id: S('string', '任务 ID'),
      role_token: S('string', '角色令牌（可选；给了就用你的身份看）'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      planner_agent: S('string', '★ 当前计划 AI（分配 AI）的会话 id（上报要发给他）'),
      planner_seat: S('string', '当前计划席位标识'),
      orchestrator_agent: S('string', '（别名，同 planner_agent；旧字段名保留兼容）'),
      orchestrator_seat: S('string', '（别名，同 planner_seat）'),
      retired: S('number', '已退场的会话数'),
    },
    async run(args) {
      const fail = (msg) => ({ ok: false, summary: msg, planner_agent: '', planner_seat: '', orchestrator_agent: '', orchestrator_seat: '', retired: 0 })
      const task = await store.get(String(args.task_id ?? ''))
      if (task === null) return fail(`找不到任务 ${String(args.task_id ?? '')}。`)
      // ★ 兼容读：旧任务文件里这个键叫 `orchestrator`。
      const cur = task.contacts?.planner ?? task.contacts?.orchestrator ?? null
      const tok = cur === null ? null : tokens.findSeat(task.id, ROLE.PLANNER, null)
      const lines = []
      lines.push(`当前联系人 · 任务 ${task.id}`)
      lines.push('')
      lines.push(cur === null
        ? '★ 计划 AI（分配 AI）联系人：**未登记**（还没有计划席位建起来）'
        : `★ 计划 AI（分配 AI）：${cur.agent_id ?? '(未建会话)'}　第 ${cur.generation ?? 1} 代　（${cur.seat ?? 'planner'}）`)
      if (tok !== null && tok !== undefined) lines.push(`  令牌可查：${tok.agentId ?? '(未绑定)'}`)
      lines.push('')
      lines.push('各席位当前占位：')
      for (const t2 of tokens.list().filter((x) => x.taskId === task.id)) {
        lines.push(`  · ${t2.role}${t2.seat ? ` / ${t2.seat}` : ''} → ${t2.agentId ?? '(未绑定)'}`)
      }
      const retiredCount = (task.successions ?? []).reduce((a, s) => a + (s.from_agent ? 1 : 0), 0)
      lines.push('')
      lines.push(`已退场（继任换掉的旧会话）：${retiredCount} 个`)
      for (const s of (task.successions ?? [])) {
        lines.push(`  · ${s.seat}　第 ${s.generation} 代：${s.from_agent ?? '(无)'} → ${s.to_agent ?? '(无)'}　依据：${s.reason ?? ''}`)
      }
      lines.push('')
      lines.push('★ 行动前先确认联系人 —— 发给已退场的席位等于发进黑洞。')
      return {
        ok: true,
        summary: lines.join('\n'),
        planner_agent: cur?.agent_id ?? '',
        planner_seat: cur?.seat ?? '',
        // ★ 旧字段名保留兼容（历史任务与既有调用方都在用）
        orchestrator_agent: cur?.agent_id ?? '',
        orchestrator_seat: cur?.seat ?? '',
        retired: retiredCount,
      }
    },
  })

  // =========================================================================
  // 21~22. ★上下文水位与席位继任
  // =========================================================================

  const contextReport = tool(deps, {
    name: 'pipeline_context_report',
    mutating: true,
    description:
      '【任何角色】上报自己的**上下文水位**（百分比 + 依据）★。' +
      'DSH 目前**没有**面向插件的上下文用量接口（源码：dsh-agent-loop:460-462 的 usage getter 在流装配器内部，' +
      ':1250 的 contextWindow 只给"窗口多大"），所以水位只能由席位**自报** —— ' +
      '既然是自己说的，就**必须给依据**（已读文件数 / 轮次 / 上下文里压了几份大报告）。' +
      '到达触发线（默认 55%）时必须上报给分配 AI（主对话）：先产出一份 seat_handover 交接物，' +
      '再让主对话执行 pipeline_succession 换班。到达硬限（默认 75%）后不允许再领新活，只允许交接与收尾。' +
      '返回里会附上**插件侧客观观测**（本席位调用过多少次工具、活跃多久），可与自报互相印证。',
    parameters: {
      task_id: S('string', '任务 ID'),
      percent: S('number', '★ 上下文水位百分比 0~100'),
      basis: S('string', '★ 依据（为什么是这个数）—— 必填，不能只写"我觉得"'),
      requested_succession: S('boolean', '是否请求继任（换班）'),
      to_planner_agent: S('string', '★ 你要发给的**计划 AI**会话 id（可选；给了就核对是不是当前联系人，防止发给已退场的分配 AI）'),
      to_orchestrator_agent: S('string', '（旧字段名，等价于 to_planner_agent；两个都给时以 to_planner_agent 为准）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      report_id: S('string', '上报 id'),
      level: S('string', '档位：ok / warn / succession / hard_limit'),
      observed_tool_calls: S('number', '插件观测到的本席位工具调用次数'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, report_id: '', level: '', observed_tool_calls: 0 }
      // ★ 客观观测：本席位在插件眼里调用过多少次工具（不是模型说的）
      // ★ 更正 B（本轮改名）：先校验收件人 —— 发给**已退场的分配 AI**等于发进黑洞。
      const wantTo = typeof args.to_planner_agent === 'string' && args.to_planner_agent.trim().length > 0
        ? args.to_planner_agent.trim()
        : typeof args.to_orchestrator_agent === 'string' ? args.to_orchestrator_agent.trim() : ''
      if (wantTo.length > 0) {
        const cur0 = await store.get(String(args.task_id ?? ''))
        const cur = cur0?.contacts?.planner ?? cur0?.contacts?.orchestrator ?? null
        if (cur === null || cur.agent_id !== wantTo) {
          const lines0 = [
            `拒绝：你要发给的分配 AI ${wantTo} **不是当前联系人**。`,
            '',
            cur === null
              ? '  当前：**还没有登记分配 AI 联系人**（可能还没建计划席位）。'
              : `  当前：${cur.agent_id ?? '(未建会话)'}（第 ${cur.generation ?? 1} 代，自 ${cur.since ?? '?'} 起）`,
            `  你要发的：${wantTo}`,
            '',
            '★ 计划 AI 自己也会继任 —— 发给一个已经退场的席位，那条消息永远不会有人看。',
            '  先用 pipeline_contacts 查「当前分配 AI 是谁」，再发。',
          ].join('\n')
          return { ok: false, summary: lines0, report_id: '', level: '', observed_tool_calls: 0 }
        }
      }

      const observed = counter.snapshot(actor.agentId)
      const res = await store.reportContext({
        taskId: String(args.task_id ?? ''),
        role: actor.role,
        seat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        percent: args.percent,
        basis: args.basis,
        requestedSuccession: args.requested_succession === true,
        observed,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, report_id: '', level: '', observed_tool_calls: observed.tool_calls }
      indexTask(res.task.id, res.task)

      // ★ 更正 C（本轮改名）：到触发线时**通知分配 AI（= 计划 AI）**，而不是通知主对话 ——
      //   分配是计划 AI 的职权，主对话只跟踪状态。
      let notifyNote = ''
      if (res.report.level === 'succession' || res.report.level === 'hard_limit') {
        const orch = tokens.findSeat(res.task.id, ROLE.PLANNER, null)
        if (orch === null || orch === undefined || typeof orch.agentId !== 'string' || orch.agentId.length === 0) {
          notifyNote = '\n\n⚠ 没能通知分配 AI（计划 AI，找不到它的会话）—— 请主对话用 pipeline_status 看到这条上报后转达计划 AI。'
        } else {
          const sent = await transport.notifyRole({
            sender: exec.agent,
            agentId: orch.agentId,
            message: [
              `【水位上报】${actor.role}${actor.seat ? `（${actor.seat}）` : ''} 到了 ${res.report.percent}%（${res.report.level}）。`,
              `依据：${res.report.basis}`,
              `插件侧客观观测：工具调用 ${observed.tool_calls} 次，活跃 ${observed.active_minutes} 分钟。`,
              '',
              '★ 你是**分配 AI（计划 AI）**：请决定是否追加 / 指派继任者，并更新席位清单。',
              `  上报 id：${res.report.report_id}`,
              '  流程：① 先让该席位产出 seat_handover 交接物（含 must_read_files / key_decisions / open_questions / do_not_repeat）；② 你调 pipeline_succession 指派继任者。',
            ].join('\n'),
          })
          notifyNote = sent.ok === true
            ? `\n\n✅ 已通知**分配 AI（计划 AI）**：${orch.agentId}`
            : `\n\n⚠ 通知分配 AI（计划 AI）失败：${sent.note}`
        }
      }
      return {
        ok: true,
        summary: res.summary + notifyNote,
        report_id: res.report.report_id,
        level: res.report.level,
        observed_tool_calls: observed.tool_calls,
      }    },
  })

  const succession = tool(deps, {
    name: 'pipeline_succession',
    mutating: true,
    description:
      '【只有主对话】★ 执行一次**席位继任**（换班，**不是**改角色）：同一个角色的席位换一个人接着干。' +
      '角色清单不变、任务状态不变 —— 所以它不违反"主对话不得自行增减角色"，' +
      '但它**只能在编排给的 relayPolicy 授权内**执行（档位是否启用、角色是否在白名单、次数有没有用尽）。' +
      '前置三条缺一不可：① 授权内；② 该席位**上报过水位**且达到触发线；' +
      '③ 该席位产出过合法的 seat_handover（含 must_read_files 与 open_questions）。' +
      '执行后：新会话拿到新令牌接管同一席位，**旧令牌立即失效**（旧席位不得再写），继任关系记为 succeeds。',
    parameters: {
      task_id: S('string', '任务 ID'),
      seat: S('string', '要换班的 roster 席位 id（非编写角色可直接给角色名）'),
      role: S('string', '该席位的角色'),
      spawn: S('boolean', '是否真的建新会话（默认跟配置）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      succession_id: S('string', '继任记录 id'),
      agent_id: S('string', '新席位会话 id'),
      token: S('string', '新席位令牌'),
      retired_agent: S('string', '已退休的旧会话 id'),
    },
    async run(args, exec) {
      const fail = (msg) => ({ ok: false, summary: msg, succession_id: '', agent_id: '', token: '', retired_agent: '' })
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return fail(actor.error)
      // ★ 更正 C：**分配 AI = 编排 AI**。
      //   编排随时可以给任何席位换班（追加/指派继任者本来就是它的本职）；
      //   主对话只在"给**编排席位自己**换班"时兜底（指派者不能是自己）。
      const who = checkSuccessionActor({ actorRole: actor.role, role: String(args.role ?? '') })
      if (who.ok !== true) return fail(who.error)
      const taskId = String(args.task_id ?? '')
      const role = String(args.role ?? '')
      const seat = String(args.seat ?? '')
      // ★ 席位 key：只有编写角色有 roster 席位（writer#1…）；其它角色的令牌里 seat 是 null。
      const seatKey = role === ROLE.WRITER && seat.length > 0 ? seat : ''
      if (taskId.length === 0 || role.length === 0) return fail('必须给 task_id 与 role。')

      // 第一步：只校验（授权 / 水位 / 交接物），一个字节都不改
      const plan = await store.planSuccession({ taskId, seat: seatKey || role, role })
      if (plan.ok !== true) return fail(plan.error)
      const { task, lastReport, handover } = plan

      // 第二步：建新会话（走 transport，与派活同一条路）
      const oldTok = tokens.findSeat(taskId, role, seatKey.length > 0 ? seatKey : null)
      const succSeat = seatKey.length > 0 ? seatKey : null
      const spec = {
        task,
        roster: task.roster,
        role,
        seat: succSeat,
        // ★ 四槽跟着**席位**走：继任换的是人，不是档。不带上四槽，换班之后
        //   这个席位会掉回最小档（编写席随即写不了盘）—— 与派活端同一套取值口径。
        ...dispatchSlots(task, role, succSeat, args),
      }
      const spawn = args.spawn === undefined ? config.spawnRoles !== false : args.spawn === true
      const res = spawn && isSpawnableRole(role)
        ? await transport.spawnRole({ ...spec, parent: exec.agent, signal: exec.signal })
        : await transport.spawnRole({ ...spec, agentId: null })
      if (res.ok !== true) return fail(res.note)

      // 第三步：★ 撤旧令牌 —— 旧席位从此不得再写
      if (oldTok !== null && oldTok !== undefined) tokens.revoke(oldTok.token)

      // 第四步：落记录
      const committed = await store.commitSuccession({
        taskId,
        seat: seatKey || role,
        role,
        fromAgent: oldTok?.agentId ?? null,
        toAgent: res.agentId ?? null,
        handoffId: handover.handoff_id,
        reason: `水位 ${lastReport.percent}%：${lastReport.basis}`,
      })
      if (committed.ok !== true) return fail(committed.error)
      indexTask(taskId, committed.task)
      // ★ 把旧会话登记为"已退休"：守门靠它拦住旧席位的后续写入
      //   （只撤令牌不够 —— 令牌没了之后 roleOfAgent 找不到绑定，守门会当成"无关会话"放行）
      if (typeof oldTok?.agentId === 'string' && oldTok.agentId.length > 0) retireAgent(oldTok.agentId, taskId)

      const s = committed.succession

      // ★ 更正 B：**广播新联系人**给所有已绑定席位。
      //   理由：编排换人了，各席位如果还往旧编排发上报，那些消息永远没人看。
      const broadcast = { sent: [], failed: [], note: '' }
      if (s.role === ROLE.PLANNER) {
        const targets = tokens.list().filter((x) => x.taskId === taskId && x.agentId && x.agentId !== res.agentId)
        const text = [
          `【联系人变更】任务 ${taskId} 的**分配 AI（计划 AI）**已换人。`,
          '',
          `  旧：${s.from_agent ?? '(无)'}（已退场，令牌已撤销，**不要再发给他**）`,
          `  新：${s.to_agent ?? '(manual 通道)'}　第 ${s.generation} 代`,
          `  依据：${s.reason}`,
          '',
          '★ 后续的**水位上报 / 澄清请求 / 任何需要分配裁决的事**，都发给**新的计划 AI**。',
          '  不确定当前联系人是谁 → 调 pipeline_contacts 查一下。',
        ].join('\n')
        for (const x of targets) {
          const r = await transport.notifyRole({ sender: exec.agent, agentId: x.agentId, message: text })
          if (r.ok === true) broadcast.sent.push(`${x.role}${x.seat ? ` / ${x.seat}` : ''}`)
          else broadcast.failed.push(`${x.role}${x.seat ? ` / ${x.seat}` : ''}（${r.note}）`)
        }
        broadcast.note =
          broadcast.sent.length === 0 && broadcast.failed.length === 0
            ? '（当前没有其它已绑定席位，无需广播）'
            : `已广播给 ${broadcast.sent.length} 个席位${broadcast.failed.length > 0 ? `，${broadcast.failed.length} 个失败` : ''}`
      }

      const lines = [
        `席位继任完成：${s.succession_id}`,
        `席位：${s.seat}（${s.role}）　第 ${s.generation} 代`,
        '',
        `依据：水位 ${lastReport.percent}%（${lastReport.level}）—— ${lastReport.basis}`,
        `交接物：${handover.handoff_id}`,
        `旧会话：${oldTok?.agentId ?? '(无)'}（令牌已撤销 + 已登记退休，**不得再写**）`,
        `新会话：${res.agentId ?? '(manual 通道)'}`,
        `新令牌：${res.token}`,
        '',
        '★ 任务状态**没有变** —— 继任是换班，不是重开（制品版本、打回计数、审计都连续）。',
        ...(s.role === ROLE.PLANNER ? ['', `★ 新联系人广播：${broadcast.note}`] : []),
        '新席位第一步：读交接物里的 must_read_files（至少含需求档），然后按 next_step 继续。',
      ]
      return {
        ok: true,
        summary: lines.join('\n'),
        succession_id: s.succession_id,
        agent_id: res.agentId ?? '',
        token: res.token ?? '',
        retired_agent: oldTok?.agentId ?? '',
      }
    },
  })

  // =========================================================================
  // 20. ★安全确认扫描（审核必须确认"网络安全 / 本地泄密是否发生"）
  // =========================================================================

  const securityCheck = tool(deps, {
    name: 'pipeline_security_check',
    mutating: false,
    description:
      '★ 对本任务工作区做**安全确认扫描**：本地泄密面（密钥/凭证/隐私是否出现在制品、报告、日志、收据、audit.jsonl 里）' +
      '+ 网络面（产物/脚本里有没有外联地址、有没有**未解释**的外联、有没有凭证出现在出网请求里）。' +
      '产出结构化 JSON + **脱敏**的人可读摘要。' +
      '★ 扫描范围**只限本任务工作区**（.pipeline/<taskId>/ 与显式给出且落在项目根内的路径）—— 不遍历用户其它目录。' +
      '★ 结果里**不回显命中原文**，只写"哪个文件第几行命中哪一类"+ 打码片段（工具自身不得成为泄密渠道）。' +
      '审核把它返回的 checks_ref 与结论填进 review_verdict.security。',
    parameters: {
      task_id: S('string', '任务 ID'),
      extra_paths: S('array', '补充扫描路径（必须落在项目根之内；越界会被拒绝并记入结果）', { items: { type: 'string' } }),
      allowed_hosts: S('array', '已解释的外联主机白名单（出现在这里的不算"未解释外联"）', { items: { type: 'string' } }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '脱敏的可读摘要（不含任何命中原文）'),
      finding_count: S('number', '命中总数'),
      checks_ref: S('string', '本次扫描结果的落盘路径（填进 review_verdict.security.checks_ref）'),
      attestation_hint: S('string', '按扫描结果给出的建议结论：clean / issues'),
      report_path: S('string', '完整结构化 JSON 的落盘路径'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: '必须给 task_id。', finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: `找不到任务 ${taskId}。`, finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }

      const root = task.project_root
      const pipelineDir = join(root, config.artifactDirName)
      const scan = await runSecurityScan({
        task,
        projectRoot: root,
        pipelineDir,
        extraPaths: toStringArray(args.extra_paths),
        allowedHosts: toStringArray(args.allowed_hosts),
      })

      // 落盘：结构化 JSON 进本任务的 reports/ —— 它就是 checks_ref 指的东西
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-d{3}Z$/, 'Z')
      const reportsDir = join(pipelineDir, taskId, 'reports')
      await mkdir(reportsDir, { recursive: true })
      const reportPath = join(reportsDir, `security-scan-${stamp}.json`)
      const body = JSON.stringify(scan, null, 2)
      await writeFile(reportPath, body, 'utf8')
      const digest = fullHash(body)
      const relRef = relative(root, reportPath).replace(/\\/g, '/')

      const hint = scan.finding_count === 0 ? 'clean' : 'issues'
      const summary =
        renderScanSummary(scan) +
        '\n' +
        `\n落盘：${relRef}` +
        `\nsha256：${digest.slice(0, 32)}…` +
        `\n\n★ 建议结论：attestation=${hint}` +
        (hint === 'clean'
          ? '\n（扫描未见命中。注意：**扫描不是万能的** —— 它只查已知模式；结论仍要你自己负责。）'
          : `\n（有 ${scan.finding_count} 处命中，**不能**给 clean。要么打回编写，要么让 security 角色复核，要么升级给用户。）`)

      const logged = await store.recordAudit(taskId, actor.role, 'security:scan', {
        report: relRef,
        digest,
        finding_count: scan.finding_count,
        local_leak: scan.local_leak.findings.length,
        network: scan.network.findings.length,
        files_scanned: scan.scope.files_scanned,
        rejected_paths: scan.scope.rejected_paths.length,
        agent: actor.agentId,
      })
      if (logged.ok === true) indexTask(taskId, logged.task)

      return {
        ok: true,
        summary,
        finding_count: scan.finding_count,
        checks_ref: `${relRef}#${digest.slice(0, 16)}`,
        attestation_hint: hint,
        report_path: reportPath,
      }
    },
  })

  // =========================================================================
  // 18~19. ★两级升级梯 · 第一级（角色 → 需求分析）
  // =========================================================================
  //
  // 执行/顾问角色遇到确定不了的事，**先问需求分析**。
  // 它能在需求层裁定就自己答（用户根本不用被打扰）；答不了才由它升级给用户。
  // 只有 L0 档没有独立编排对话，那时才允许直接发 human_request。

  const clarifyRequest = tool(deps, {
    name: 'pipeline_clarify_request',
    mutating: true,
    description:
      '【执行/顾问角色专用】★ 遇到确定不了的事，**先问需求分析**（人工介入的第一级）。' +
      '需求层的事（验收标准、边界条件、优先级、范围取舍、测试要点）它多半能直接裁定，**用户根本不用被打扰**；' +
      '它确实答不了时会由它升级给用户。' +
      'context_digest 必须是**脱敏摘要**（不许含代码正文）—— 需求分析靠它在不读代码的前提下判断。' +
      'blocking=true 时任务进入「等待需求分析答复」，裁定后回到被打断前的状态。' +
      '（本档没有独立编排对话时——L0——这条链路不存在，直接调 pipeline_human_request 才是合法路径。）',
    parameters: {
      task_id: S('string', '任务 ID'),
      stage: S('string', '卡在哪一步（例如"编写：接口字段命名"）'),
      question: S('string', '要问的问题 —— 必须是清晰可答的问句'),
      context_digest: S('string', '★ 脱敏摘要（不含代码正文）'),
      options: S('array', '你想到的可选方案，每项 { label, consequence }', { items: { type: 'object', additionalProperties: true } }),
      blocking: S('boolean', '是否阻塞本任务推进（默认 true）'),
      urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      deadline: S('string', '希望什么时候答复（ISO 8601，可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '澄清请求 id'),
      state: S('string', '提交后的任务状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', state: '' }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: `找不到任务 ${args.task_id}。`, request_id: '', state: '' }
      if (!ROLES_CAN_ASK_CLARIFICATION.includes(actor.role)) {
        return {
          ok: false,
          request_id: '',
          state: '',
          summary:
            `角色「${roleLabel(actor.role)}」不在可向需求分析提问的名单里。\n` +
            `可提问的角色：${ROLES_CAN_ASK_CLARIFICATION.map(roleLabel).join(' / ')}\n` +
            '（主对话不产出技术交接物；需求分析是**被问的人**，它答不了时走升级路径。）',
        }
      }
      const res = await store.submitHandoff({
        taskId: task.id,
        kind: 'clarification_request',
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        payload: {
          task_id: task.id,
          from_role: actor.role,
          stage: args.stage,
          question: args.question,
          context_digest: args.context_digest,
          options: args.options,
          blocking: args.blocking === undefined ? true : args.blocking === true,
          urgency: args.urgency,
          deadline: args.deadline,
        },
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', state: '' }
      indexTask(res.task.id, res.task)
      const entry = store.findClarification(res.task, undefined)
      return {
        ok: true,
        request_id: entry?.request_id ?? '',
        state: res.task.state,
        summary:
          `${res.summary}\n` +
          `澄清请求已登记：${entry?.request_id ?? '(未生成)'}　当前状态：${STATE_LABEL[res.task.state]}` +
          `　（这是第 ${entry?.round ?? 1} 次问这个问题）\n` +
          (res.advanced
            ? '任务已进入「等待需求分析答复」—— 裁定之前它不会被推进。\n'
            : '这是一条**非阻塞**提问：任务可以继续推进，但结论仍会回投给你。\n') +
          '\n★ 你**没有**惊动用户 —— 这一级就是为此存在的。等需求分析给出裁定（answered 会给结论；' +
          'cannot_answer 说明它已把问题升级给用户），状态会回到你提问时的位置。',
      }
    },
  })

  const clarifyReply = tool(deps, {
    name: 'pipeline_clarify_reply',
    mutating: true,
    description:
      '【需求分析专用】★ 对澄清请求出裁定（两级升级梯的枢纽）。' +
      'verdict=answered：**能在需求层定的就自己定**，给 answer + reason，发起角色原地继续，用户不用被打扰；' +
      'verdict=cannot_answer：答不了就必须说清 reason（需要用户拍板 / 涉及新需求 / 需求层冲突无法自解 / 缺环境权限），' +
      '然后由你再发 pipeline_human_request（带 escalated_from/raised_by/orchestrator_reason）升级给用户。' +
      '★ 一旦升级就是**单向门** —— 那条澄清请求不能再被你改口裁定。' +
      '不带 request_id 时它同时充当收件箱（列出本任务全部澄清请求）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '澄清请求 id（留空 = 列出全部，不裁定）'),
      verdict: S('string', '裁定结果', { enum: ['answered', 'cannot_answer'] }),
      answer: S('string', '结论（verdict=answered 时必填）'),
      reason: S('string', '★ 为什么这么答 / 为什么答不了（必填）'),
      constraints_added: S('array', '因这次裁定而新增/收紧的约束', { items: { type: 'string' } }),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '澄清请求 id'),
      resumed_to: S('string', '恢复到的状态（没恢复则为空串）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', resumed_to: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: '必须给 task_id。', request_id: '', resumed_to: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: `找不到任务 ${taskId}。`, request_id: '', resumed_to: '' }

      if (typeof args.request_id !== 'string' || args.request_id.length === 0) {
        const list = await store.listClarifications({ taskId })
        if (list.ok !== true) return { ok: false, summary: list.error, request_id: '', resumed_to: '' }
        indexTask(taskId, list.task)
        if (list.all.length === 0) {
          return { ok: true, request_id: '', resumed_to: '', summary: `任务 ${taskId} 目前没有澄清请求。` }
        }
        const lines = [
          `任务 ${taskId} 的澄清请求（共 ${list.all.length} 条，待裁定 ${list.pending.length} 条）：`,
          '',
          ...list.all.map((r) => {
            const mark = r.status === 'pending' ? '●待裁定' : r.status === 'escalated' ? '↑已升级' : '✓已裁定'
            return (
              `  ${mark} ${r.request_id}  [${r.status}]  ${r.from_role}  ${r.stage}\n` +
              `      ${clip(r.question, 90)}\n` +
              `      阻塞=${r.blocking} 紧急=${r.urgency} 第 ${r.round} 次问` +
              (r.verdict ? ` 裁定=${r.verdict}` : '') +
              (r.escalated_to ? ` 已升级为 ${r.escalated_to}` : '')
            )
          }),
          '',
          list.pending.length > 0
            ? `下一步：pipeline_clarify_reply { task_id: "${taskId}", request_id: "${list.pending[0].request_id}", verdict: "answered"|"cannot_answer", ... }`
            : '（没有待裁定的请求。）',
        ]
        return { ok: true, request_id: '', resumed_to: '', summary: lines.join('\n') }
      }

      const res = await store.replyClarification({
        taskId,
        requestId: String(args.request_id),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        verdict: args.verdict,
        answer: args.answer,
        reason: args.reason,
        constraintsAdded: args.constraints_added,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', resumed_to: '' }
      indexTask(taskId, res.task)
      // ★★ **B3：裁定落地 ⇒ 唤醒那个"停手等答复"的席位**。
      //
      //   现场：席位提 `blocking` 澄清后按规矩停手，裁定回来了、状态也**正确恢复**了，
      //   但**没有一个人被叫醒**（实测该席位会话自 21:03:01 起完全冻结、45 秒零写入）——
      //   于是"每一次 blocking 澄清 = 永久废掉一个席位"。
      //   这里在状态恢复之后把结论投给**发起席位**；**投不出去就报出来**（不静默失败）。
      const woken = await wakeResumedSeat(
        res.task,
        String(res.request?.from_role ?? ''),
        res.request?.from_seat ?? null,
        `澄清请求 ${res.request?.request_id ?? ''} 已裁定（${String(args.verdict ?? '')}）`,
        { kind: 'clarify-reply', requestId: String(res.request?.request_id ?? '') },
      )
      return { ok: true, request_id: res.request.request_id, resumed_to: res.resumed?.to ?? '', summary: `${res.summary}\n${woken.line}` }
    },
  })

  // =========================================================================
  // 15~17. ★人工介入（用户只与主对话相连 —— 这是唯一的上升通道）
  // =========================================================================
  //
  // 拓扑：  执行/顾问角色 ──①发起──► 主对话 ──②转告──► 用户
  //                        ▲                              │
  //                        └──── 主对话 ──③记答复◄─────────┘
  //                                     └──④恢复──► 状态机回到被打断前
  //
  // 三个动作的角色边界（守门 + execute 双重判定）：
  //   发起 = 除 main 之外的角色    转告 / 记答复 = 只有 main

  const humanRequest = tool(deps, {
    name: 'pipeline_human_request',
    mutating: true,
    description:
      '【执行/顾问角色专用】向上发起人工介入请求。**用户的对话框只在主对话里** —— 你不能直接对用户说话，' +
      '所以任何需要人拍板的事都必须走这条路：你发起 → 主对话转告用户 → 用户答复 → 主对话记回来 → 你继续。' +
      'question_for_human 必须是**给用户看的人话**（不许含代码/补丁/文件路径），因为主对话不读代码、也转告不了代码；' +
      '混进代码会被直接拒。blocking=true 时任务会进入「等待人工答复」，用户答复后**回到被打断前的那个状态**。' +
      '（与 pipeline_handoff{kind:"human_request"} 是同一条路径，这个工具只是把参数摊平了。）',
    parameters: {
      task_id: S('string', '任务 ID'),
      reason_kind: S('string', '为什么要人拍板', { enum: Object.keys(HUMAN_REASON_KINDS) }),
      question_for_human: S('string', '★ 给用户看的人话问题（不含代码、不含补丁、必须是个问句）'),
      context_for_human: S('string', '给用户的补充背景（同样不许含代码，可空）'),
      options: S('array', '可选方案，每项 { label, consequence }（decision_kind=choose_option 时至少 2 个）', { items: { type: 'object', additionalProperties: true } }),
      recommended: S('string', '你的建议（必须是 options 里某个 label；仅供参考，不构成决定）'),
      blocking: S('boolean', '是否阻塞本任务推进（默认 true）'),
      blocked_stage: S('string', '卡在哪一步（blocking=true 时必填）'),
      urgency: S('string', '紧急度', { enum: HUMAN_URGENCIES }),
      decision_kind: S('string', '需要用户给什么形式的答复', { enum: Object.keys(HUMAN_DECISION_KINDS) }),
      timeout_behavior: S('string', '无人回应时怎么办', { enum: Object.keys(HUMAN_TIMEOUT_BEHAVIORS) }),
      default_option: S('string', '默认选项（timeout_behavior=proceed_with_default 时必填）'),
      timeout_at: S('string', '截止时间 ISO 8601（可空；配置 humanRequestTimeoutHours>0 时会自动算）'),
      // --- ★由需求分析升级上来时必填（执行角色**不许**填这三个 —— 它得先走 clarification_request）---
      escalated_from: S('string', '升级来源：某条 clarification_request 的 handoff_id（需求分析升级时必填）'),
      raised_by: S('string', '原本是谁问的（上游澄清请求的发起角色）'),
      orchestrator_reason: S('string', '需求分析为什么答不了（用户有权知道为什么这事轮到他拍板）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '请求 id（失败时为空串）'),
      state: S('string', '提交后的任务状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', state: '' }
      if (actor.role === ROLE.MAIN) {
        return {
          ok: false,
          request_id: '',
          state: '',
          summary:
            '主对话不发起人工介入请求 —— 你就在用户的对话框里，要问直接问。\n' +
            '这个工具是给 writer / tester / reviewer / security / architect 这些**没有用户对话框**的角色用的。\n' +
            '你收到它们提交的请求后：pipeline_human_relay 转告用户 → pipeline_human_reply 记答复。',
        }
      }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, summary: `找不到任务 ${args.task_id}。`, request_id: '', state: '' }
      if (!ROLES_CAN_RAISE_HUMAN.includes(actor.role)) {
        return {
          ok: false, request_id: '', state: '',
          summary: `角色「${roleLabel(actor.role)}」不在可发起人工介入的名单里（${ROLES_CAN_RAISE_HUMAN.join(' / ')}）。`,
        }
      }

      const res = await store.submitHandoff({
        taskId: task.id,
        kind: 'human_request',
        actorRole: actor.role,
        actorSeat: actor.seat ?? null,
        actorAgentId: actor.agentId,
        payload: {
          task_id: task.id,
          from_role: actor.role,
          created_at: typeof args.created_at === 'string' ? args.created_at : undefined,
          reason_kind: args.reason_kind,
          question_for_human: args.question_for_human,
          context_for_human: args.context_for_human,
          options: args.options,
          recommended: args.recommended,
          blocking: args.blocking === undefined ? true : args.blocking === true,
          blocked_stage: args.blocked_stage,
          urgency: args.urgency,
          decision_kind: args.decision_kind,
          timeout_behavior: args.timeout_behavior,
          default_option: args.default_option,
          timeout_at: args.timeout_at,
          escalated_from: args.escalated_from,
          raised_by: args.raised_by,
          orchestrator_reason: args.orchestrator_reason,
        },
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', state: '' }
      indexTask(res.task.id, res.task)
      const entry = store.findHumanRequest(res.task, undefined)
      return {
        ok: true,
        request_id: entry?.request_id ?? '',
        state: res.task.state,
        summary:
          `${res.summary}\n` +
          `请求已登记：${entry?.request_id ?? '(未生成)'}　当前状态：${STATE_LABEL[res.task.state]}\n` +
          (res.advanced
            ? '任务已进入「等待人工答复」—— 在用户答复之前它不会被推进。\n'
            : '这是一条**非阻塞**请求：任务可以继续推进，但主对话仍会转告用户。\n') +
          '\n接下来**不是你去问用户** —— 你的对话框里没有用户。等主对话把用户的答复记回来，\n' +
          '状态会回到你提问时的那个位置，你再用 pipeline_status 看结论继续干活。',
      }
    },
  })

  /**
   * ★★ **2026-10-14：补上 `mutating: true`。**
   *
   * 事实：`pipeline_human_relay` 会往任务里写 `relayed_at`（转告留痕）；
   * `pipeline_human_reply` 会**记答复 + 恢复状态 + 唤醒席位** —— 两个都改任务数据。
   * 而开关闸只在 `spec.mutating === true` 时才拦（`:345-347`），
   * 所以改前**总开关关掉时这两个照样能用**。
   *
   * ★ 判为**疏漏**，不是"有意的应急出口"（三条证据，都能机械复核）：
   *   ① 同一族的 `pipeline_human_request`（发起侧）标了 `mutating: true`、
   *      `pipeline_clarify_reply`（澄清梯的答复侧）也标了 —— 全表只有这两个漏标；
   *   ② 开关关闭时的统一拒答文案自己写着「关闭状态下仍然可用的是**只读**动作：
   *      pipeline_status / pipeline_switch / pipeline_selftest」——
   *      这两个**不在**那份名单里，却事实上可用 ⇒ 文案与行为对不上；
   *   ③ 从最早的备份（`tools.js.bak-20261011-084255`）起就没标过，
   *      也**没有任何一处注释**说明这是故意的。
   *
   * ★ **这改变了行为**（如实标注）：开关关闭时这两个工具会被拒（与其它写工具一致）。
   *   影响面：`pipeline_human_reply` 调不动 ⇒ 卡在「等待人工答复」的单在开关重新打开之前
   *   **不会被恢复**。可恢复性由 `pipeline_switch` 兜底 —— 它**没有**标 `mutating`
   *   （开关本身必须永远可用，自测 `switch-check` T3 验的就是这条）。
   *   连带影响：`tool()` 出口的 `rememberMainCaller` 只在 `mutating === true` 时才记
   *   A28「主对话已接管」；补标之后"主对话答复了"也会被算作接管 ——
   *   这正是那段注释里写死的口径（「状态迁移 / 派活 / **答复**」）。
   */
  const humanRelay = tool(deps, {
    name: 'pipeline_human_relay',
    mutating: true,
    description:
      '【主对话专用】把一条人工介入请求**转告用户**（第 2 步）。' +
      '不带 request_id 时它同时充当收件箱：列出本任务所有人工介入请求。' +
      '转告动作**不改任务状态**（状态在角色发起那一刻就已经推到「等待人工答复」了），只留痕。' +
      '返回里会带上"照抄给用户看"的原文块，以及一枚确认码（用户答复时可回带，用作凭据）。' +
      '★ 你只负责转告，不要替用户做技术判断。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '请求 id（留空 = 列出本任务的全部请求，不转告）'),
      channel: S('string', '用什么渠道转告（默认 chat，可空）'),
      note: S('string', '转告备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（含"照抄给用户看"的原文块）'),
      request_id: S('string', '请求 id'),
      status: S('string', '请求状态'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', status: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: '必须给 task_id。', request_id: '', status: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: `找不到任务 ${taskId}。`, request_id: '', status: '' }

      // 收件箱模式
      if (typeof args.request_id !== 'string' || args.request_id.length === 0) {
        const list = await store.listHumanRequests({ taskId })
        if (list.ok !== true) return { ok: false, summary: list.error, request_id: '', status: '' }
        indexTask(taskId, list.task)
        if (list.all.length === 0) {
          return { ok: true, request_id: '', status: '', summary: `任务 ${taskId} 目前没有人工介入请求。` }
        }
        const lines = [
          `任务 ${taskId} 的人工介入请求（共 ${list.all.length} 条，待处理 ${list.pending.length} 条）：`,
          '',
          ...list.all.map((r) => {
            const mark = r.status === 'answered' ? '✓' : r.status === 'relayed' ? '⏳已转告' : '●待转告'
            return (
              `  ${mark} ${r.request_id}  [${r.status}]  ${r.from_role}  ${r.reason_zh}\n` +
              `      ${clip(r.question_for_human, 90)}\n` +
              `      阻塞=${r.blocking} 紧急=${r.urgency} 需要=${HUMAN_DECISION_KINDS[r.decision_kind] ?? r.decision_kind}` +
              (r.timeout_at ? ` 截止=${r.timeout_at}` : '') +
              (r.answered_at ? ` 已答复=${r.answered_at}(${r.answer_source})` : '')
            )
          }),
          '',
          list.pending.length > 0
            ? `下一步：pipeline_human_relay { task_id: "${taskId}", request_id: "${list.pending[0].request_id}" } 拿到"照抄给用户看"的原文块。`
            : '（没有待处理的请求。）',
        ]
        return { ok: true, request_id: '', status: '', summary: lines.join('\n') }
      }

      const res = await store.relayHumanRequest({
        taskId,
        requestId: String(args.request_id),
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        channel: args.channel,
        note: args.note,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', status: '' }
      indexTask(taskId, res.task)
      return { ok: true, request_id: res.request.request_id, status: res.request.status, summary: res.summary }
    },
  })

  /**
   * ★★ **2026-10-14：补上 `mutating: true`** —— 与上面的 `pipeline_human_relay` 同一条
   * 判断与同一份证据（都在"这个工具改不改任务数据"这一点上），理由见那一处注释。
   *
   * 这一个比 relay 更硬：它**明确会改状态**（「等待人工答复」唯一的出口，
   * 记录成功且请求阻塞时任务状态会回到被打断前那个状态）。
   */
  const humanReply = tool(deps, {
    name: 'pipeline_human_reply',
    mutating: true,
    description:
      '【主对话专用】把**用户的答复**结构化记下来，并据此恢复任务（第 3+4 步）。' +
      '★ 这是"等待人工答复"唯一的出口 —— 主对话不能自行把请求标记为已解决。' +
      '必须带 user_quote（用户本人的原话）与 attribution（谁在哪说的），且请求必须**先转告过**；' +
      '答复形状要与请求的 decision_kind 相符（是非题要布尔、选择题要选项之一、说明题要文本）。' +
      'answer_source=timeout 是另一条路：不是"用户说了什么"，而是请求发起时**事前声明的超时策略**到期生效 —— ' +
      '只有当请求声明了截止时间、且策略不是 stay_blocked 时才允许。' +
      '记录成功且请求是阻塞的，任务状态会**回到被打断前的那个状态**。',
    parameters: {
      task_id: S('string', '任务 ID'),
      request_id: S('string', '请求 id（留空 = 最近一条未答复的）'),
      answer_source: S('string', '答复来源（默认 user）', { enum: ['user', 'timeout'] }),
      user_quote: S('string', '★ 用户本人的原话（answer_source=user 时必填）'),
      reply_channel: S('string', '用户通过什么渠道答复的', { enum: ['chat', 'typed', 'selected', 'relayed', 'other'] }),
      attribution: S('string', '谁在哪说的（例如「用户在当前会话里直接回复」）'),
      confirm_code: S('string', '转告时给出的确认码（配置 requireHumanConfirmCode=true 时必填）'),
      answer: S('boolean', '是非题/审批题的答复（decision_kind=yes_no / approve_reject 时必填）'),
      chosen_option: S('string', '选择题选了哪个（decision_kind=choose_option 时必填，必须是选项 label 之一）'),
      answer_text: S('string', '说明题的答复（decision_kind=free_text 时必填）'),
      note: S('string', '备注（可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要（拒绝时是完整拒绝理由）'),
      request_id: S('string', '请求 id'),
      resumed_to: S('string', '恢复到的状态（没恢复则为空串）'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, request_id: '', resumed_to: '' }
      const res = await store.replyHumanRequest({
        taskId: String(args.task_id ?? ''),
        requestId: typeof args.request_id === 'string' ? args.request_id : '',
        actorRole: actor.role,
        actorAgentId: actor.agentId,
        answerSource: args.answer_source,
        userQuote: args.user_quote,
        replyChannel: args.reply_channel,
        attribution: args.attribution,
        confirmCode: args.confirm_code,
        answer: args.answer,
        chosenOption: args.chosen_option,
        answerText: args.answer_text,
        note: args.note,
      })
      if (res.ok !== true) return { ok: false, summary: res.error, request_id: '', resumed_to: '' }
      indexTask(res.task.id, res.task)
      // ★★ **B3：人工裁定落地 ⇒ 唤醒那个"停手等答复"的席位**（澄清链的上一级同理）。
      //
      //   用户已裁定：**不要求自动补一个新席位**顶上 —— 但原来那个必须被叫醒；
      //   叫不醒时**报出看得见的失败**（`wakeResumedSeat` 会把失败原文与等价路径拼进 summary），
      //   任务也不许停在半路。
      const woken = await wakeResumedSeat(
        res.task,
        String(res.request?.from_role ?? ''),
        res.request?.from_seat ?? null,
        `人工介入请求 ${res.request?.request_id ?? ''} 已答复（${String(args.answer_source ?? 'user')}）`,
        { kind: 'human-reply', requestId: String(res.request?.request_id ?? '') },
      )
      return {
        ok: true,
        request_id: res.request.request_id,
        resumed_to: res.resumed?.to ?? '',
        summary: `${res.summary}\n${woken.line}`,
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


  // =========================================================================
  // ★★ B3 / B8：**叫醒一个席位**（裁定落地后唤醒发起席位；也给"催办/停"一条可见通道）
  // =========================================================================
  //
  // 现场（2026-10-12）：
  //   · 席位提了 `blocking` 澄清 → 按规矩停手等 → 需求分析出了裁定 → 状态**正确恢复** →
  //     **但那个停手的席位再没有任何人被叫醒**（实测其会话自 21:03:01 起完全冻结，
  //     45 秒观测 size 恒定）；解除任务阻塞同样叫不醒它。
  //     ⇒ **每一次 blocking 澄清 = 永久废掉一个席位**。
  //   · 主对话也**停不掉空转席位**，也没有"给既有席位发一条消息"的通道 ——
  //     当晚只能由用户用 GUI 手动打字把席位叫醒。
  //
  // 判据（三条，写死在这里）：
  //   ① **投递失败必须看得见** —— 叫不醒就返回 `ok:false` 并写清"为什么、去哪儿看"，
  //      绝不当成功（用户原话：「不许静默失败」）；
  //   ② 会话 id 从**派活台账**取（`task.dispatched`），不从调用方传 —— 结构上不可能投错人；
  //   ③ 不新开状态、不新开机制：投递走既有的通道 `transport.notifyRole`。
  //
  // ★ 2026-10-14（孤儿单自恢复）：`notifyOnly` / `nudgeSeat` / `noteSeatDelivery`
  //   三个函数**原样搬进** `createSeatNotifier(deps)`（本文件顶部），本作用域只做
  //   `const { nudgeSeat, notifyOnly } = createSeatNotifier(deps)`。
  //   搬运的原因只有一个：**孤儿单自恢复的重投必须与 `notify_only` 是同一份实现**
  //   （见 `lib/orphan.js` 的文件头与 `createSeatNotifier` 的 JSDoc）。
  //   行为逐字未变 —— 判据①②③仍然落在上面那三条上。

  /**
   * ★★ **B3：裁定落地后唤醒"停手等答复"的那个席位**。
   *
   * 失败**绝不静默**：把失败原文拼进返回的 summary，让主对话当场看见，
   * 并且给出等价可达路径（`pipeline_dispatch { notify_only: true }` 手动催 / `reassign` 重派）。
   */
  async function wakeResumedSeat(task, role, seat, why, meta = {}) {
    const body =
      `【流水线 · 裁定已落地】你之前停手等的那件事有结论了（${why}）。\n` +
      `任务 ${task.id} 当前状态：${STATE_LABEL[task.state] ?? task.state}（\`${task.state}\`）。\n` +
      '★ 这条是**运行时上下文**，不是用户说的话。\n' +
      '下一步：用 pipeline_status 重读任务状态，然后继续你那一份活（你原来的边界不变）。'
    const r = await nudgeSeat(task, role, seat, body, meta)
    if (r.ok === true) return { ok: true, line: `★ 已唤醒发起席位「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」（会话 ${r.sessionId}）。\n` }
    return {
      ok: false,
      line:
        `⚠ **裁定已落地，但叫不醒发起席位**「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」—— 这是**看得见的失败**（不是静默）：\n` +
        `  原因：${r.note}\n` +
        `  等价可达路径（择一）：\n` +
        `    · 手动催一次：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, notify_only: true, note: "裁定已落地，请继续" }（**不建会话、不改状态**）\n` +
        `    · 重派同一席位：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, reassign: true }\n`,
    }
  }

  return {
    taskOpen,
    orchestrate,
    // ★ 本轮新增：计划 AI 的工具（出计划 → 自检 → 分配 AI）
    planTool,
    // ★ 本轮新增：**授权面变更（amendment）** —— 一条只动 change_scope / forbidden 的窄通道
    //   （只在「待开发」由计划 AI 生效；席位/角色清单/档位/顺序/层一个字都动不了）
    scopeAmend,
    // ★ 本轮新增：前后版本对比（基线 → 当前），审核的判据式证据
    changeAuditTool,
    // ★ 本轮新增：机器可读的边界清单（给 DSH 层的钩子复用）
    boundariesTool,
    // ★ 本轮新增：全量测试审批链的进度（只读）
    fullTestTool,
    dispatch,
    bindRole,
    handoff,
    transition,
    // ★★ T-20261011-56a37e：主管枢纽的**具名动作**（只有 supervisor 能调）。
    supervise,
    rework,
    close,
    status,
    rosterRequest,
    rosterReview,
    artifact,
    selftest,
    switchTool,
    humanRequest,
    humanRelay,
    humanReply,
    clarifyRequest,
    clarifyReply,
    securityCheck,
    contextReport,
    succession,
    recordSubmit,
    compileRequirement,
    contacts,
  }
}
