/**
 * dsh-pipeline · 工具层 · schema 拼装与 tool() 包装
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/kit
 */

import { ROLE, roleLabel } from '../roles.js'
import { ST } from '../states.js'
import { agentIdOf } from '../guard.js'
// ★ 功能开关的**唯一判据 + 文案**（不许自己写 `sw.isOn()` —— 见 lib/switch/gate.js）。
import { isEnabled } from '../switch/gate.js'
import { mutatingOffRefusal } from '../switch/text.js'
import { toStringArray } from '../util.js'
// ★★ 长入参通道（`spec_path` / `payload_path`）—— 修 MALFORMED_RESPONSE，见该文件头。
import { resolveArgsFile } from './args-file.js'

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
export function describeStage(stage) {
  return FULL_TEST_STAGE_ZH[stage] ?? String(stage ?? '')
}

/** 输出 schema 的常用片段。 */
export const S = (type, description, extra = {}) => ({ type, description, ...extra })

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
export function SNullable(type, description, extra = {}) {
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
 * ★★ **E 路 ②：`fields` 投影**（模型侧唯一能省字节的地方）。
 *
 * ---------------------------------------------------------------------------
 * 为什么投影必须做在 render 上，而不是做在返回值上
 * ---------------------------------------------------------------------------
 * 本插件把 `output` 的**每个字段都声明成必填**（见 `normalizeOutput` 的注释），
 * 所以 `run()` 返回的对象**不可能**少字段 —— 少一个键，宿主就判
 * `INVALID_TOOL_OUTPUT`。于是"只回某几个字段"这件事只能在**渲染**这一层做：
 * 模型看到的是 `render` 的产物（`renderSummary` 只给它 `summary` 一个字符串），
 * 结构化字段是给程序化调用方（自测 / 钩子）看的。
 *
 * 规则三条（顺序即优先级）：
 *   ① `fields` 没给（或缺省 / 空数组）⇒ **与改前逐字节相同**：只回 `summary`；
 *   ② `fields` 给了 ⇒ 只回**点名的那些字段**（紧凑 JSON，零排版）；
 *      `ok` 永远保留（否则连"成没成"都看不见），`summary` 点名才给；
 *   ③ 点名了一个不存在的字段 ⇒ **不静默吞掉**：在 JSON 里用 `_unknown_fields`
 *      列出来，并把 `summary` 一并带上（承认"你要的我给不了"，而不是假装给了）。
 *
 * ★ 拒绝路径（`ok:false`）**不受投影影响**：拒绝原文永远原样给
 *   （投影是为了省字节，不是为了把拒绝理由藏起来）。
 */
function renderProjected(args, value) {
  const summary = String(value?.summary ?? '')
  const fields = toStringArray(args?.fields)
  if (fields.length === 0) return [{ type: 'text', text: summary }]

  const src = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const known = new Set(Object.keys(src))
  const unknown = fields.filter((f) => !known.has(f))
  // ★ 拒绝路径：原样给全文（见上面第 3 条）。
  if (src.ok === false) return [{ type: 'text', text: summary }]

  const picked = { ok: src.ok === true }
  for (const f of fields) {
    if (f === 'ok' || !known.has(f)) continue
    picked[f] = src[f]
  }
  if (unknown.length > 0) picked._unknown_fields = unknown
  try {
    return [{ type: 'text', text: JSON.stringify(picked) }]
  } catch (err) {
    // 结构化投影序列化不了（循环引用之类）⇒ 退回摘要，**不假装投影成功**。
    return [{ type: 'text', text: `${summary}\n（★ fields 投影失败，已退回摘要：${String(err?.message ?? err)}）` }]
  }
}

/**
 * 走投影还是走摘要：**只有声明了 `fields` 入参的工具**才启用投影。
 *
 * 为什么要这道闸：`renderProjected` 挂在所有工具的同一个 render 上，
 * 若某个工具没声明 `fields` 而入参里恰好带了同名字段（历史调用 / 手抖），
 * 它就会莫名少回内容 —— 那不是"省字节"，那是**少报**。
 */
const renderFor = (spec) =>
  Object.hasOwn(spec.parameters ?? {}, 'fields') ? renderProjected : renderSummary

/**
 * 组装一个工具定义（把 defineTool 的样板收敛到一处）。
 *
 * ★ 这里是**功能开关**的第二个执法点（第一个是 `lib/guard-factory.js`）：
 *   `mutating: true` 的工具在开关关闭时**直接拒绝**，连 store 都不碰。
 *   为什么两处都要判：守门管的是"越权"，开关管的是"这功能本身开没开"，
 *   两者是正交的。而且守门对**没有身份**的调用方是放行的（守门只约束流水线
 *   参与者），所以关掉之后光靠守门拦不住"开单"这类动作 —— 必须在工具层再判一次。
 *
 * ★★ `rememberMainCaller` **搬去了 `lib/wakeup/main-contact.js`**（它自己一件事：
 *   主对话会话登记，含它的开关判据）。这里**再转出一次**，是为了让既有的
 *   `import { rememberMainCaller } from '../lib/tools.js'` 一字不改还能用。
 */
export { rememberMainCaller } from '../wakeup/main-contact.js'
export function tool(deps, spec) {
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

  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: parametersFor(spec),
    // ★ E 路 ②：声明了 `fields` 的工具走投影 render，其余**逐字节不变**（见 renderFor）。
    output: { schema: outputSchemaFor(spec), render: renderFor(spec) },
    async execute(args, exec) {
      try {
        // ★ 关掉时的拒答文案搬去了 `lib/switch/text.js`（与工具返回 / 启动日志同一出处）。
        if (spec.mutating === true && !isEnabled(sw)) {
          return shape({ ok: false, summary: mutatingOffRefusal(spec.name) })
        }
        // -----------------------------------------------------------------
        // ★★ **长入参走文件**（`spec_path` / `payload_path`）—— 修 MALFORMED_RESPONSE。
        //
        //   为什么挂在 `tool()` 这个**唯一入口**上、而不是散在三个工具里：
        //   这条通道要复用的判据（守门 + 上限 + JSON 校验 + 合并语义）只有一份，
        //   散着写就一定会漂移，而漂移的方向是**放宽**。
        //   哪个工具启用由它自己声明（`argsFile: { field: 'spec_path' }`）——
        //   **没声明的工具一个字节都不变**（连一次 stat 都不会发生）。
        //
        //   ★ 顺序：**先过开关**（关掉时连文件都不读），再解析文件，最后才 `run()`。
        // -----------------------------------------------------------------
        let effective = args ?? {}
        if (spec.argsFile !== undefined) {
          const actor = resolveActor(effective, exec, deps)
          const loaded = await resolveArgsFile({
            field: spec.argsFile.field,
            args: effective,
            exec,
            deps,
            // ★ 判不出角色 ⇒ 传 null，由 args-file 按**最严**的那一档处理。
            role: actor.ok === true ? actor.role : null,
            allowedKeys: Object.keys(spec.parameters ?? {}),
            // ★ 可选：整份文件包进这个键（`pipeline_handoff` 用 `'payload'`）——
            //   由工具**自己声明**，`args-file.js` 不猜。
            wrap: spec.argsFile.wrap,
          })
          if (loaded.ok !== true) return shape({ ok: false, summary: loaded.summary })
          effective = loaded.args
        }
        const out = shape(await spec.run(effective, exec))
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
        // -----------------------------------------------------------------
        // ★★ E 路 ③：**按"实际可见工具"惰性收紧席位工具面**。
        //
        //   为什么挂在唯一出口上：一个席位"是谁"这件事，**只有它真的动了工具**
        //   才确定（`pipeline_bind_role` 是在 `run()` **里面**把会话绑上角色的）。
        //   所以收紧必须发生在 `run()` 之后 —— 这是唯一一个"角色已确定"的时刻。
        //
        //   ★ 只在 `index.js` 注入了 `deps.tightenSeatFace` 时才发生（自测夹具没有它
        //     ⇒ 一个字节都不动）；★ 不抛：收紧失败绝不能把这次工具调用带崩。
        //     ★ 它**不改判据**：隐藏面的定义 = "守门本来就会按角色白名单拒掉的那些"
        //       （推导见 `lib/boundaries.js` 的 `deriveToolFace`）。
        // -----------------------------------------------------------------
        try {
          deps.tightenSeatFace?.(exec)
        } catch (err) {
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
 * ★★ **A 件（2026-10-16）**：返回值里多一个 `mechanism`
 *   （`null` = 普通的会话 / 席位身份；非 `null` = **机制自己铸的身份**）。
 *   它来自 `tokens.mint({ mechanism })` —— 自愈 / 唤醒点补派这类"机制自己发起"
 *   的派活**必须有它**，否则就只能借调用方的 exec，而调用方（重启后的主对话）
 *   恰恰没有身份 ⇒ 自愈必然失败。判据与边界写在 `lib/tokens.js` 的 `mint` 上。
 *
 * @returns {{ok:true, role:string, seat:string|null, agentId:string|null, via:string, mechanism:string|null} | {ok:false, error:string}}
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
    const mech = typeof r.rec.mechanism === 'string' && r.rec.mechanism.length > 0 ? r.rec.mechanism : null
    /**
     * ★ 机制令牌**不走"会话绑定 vs 令牌"那条冲突判据**：它本来就不属于任何会话
     *   （`agentId` 恒 null），拿它去和一个已绑定会话比"是不是同一个角色"没有意义。
     *   它唯一的去处是"机制自己发起"的通道（自愈 / 补派），而那条通道的授权
     *   另有出处（`task.hub` 账本）—— 不在这里放宽任何席位判据。
     */
    if (mech === null && bound !== null && bound.role !== r.rec.role) {
      return {
        ok: false,
        error:
          `身份冲突：本会话已经绑定为任务 ${bound.taskId} 的「${roleLabel(bound.role)}」，` +
          `但这次带的 role_token 属于「${roleLabel(r.rec.role)}」。一个会话在同一任务里只能担任一个角色。`,
      }
    }
    return { ok: true, role: r.rec.role, seat: r.rec.seat ?? null, agentId, via: 'token', mechanism: mech }
  }

  if (bound !== null) {
    return { ok: true, role: bound.role, seat: bound.seat ?? null, agentId, via: 'session-binding', mechanism: null }
  }

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
