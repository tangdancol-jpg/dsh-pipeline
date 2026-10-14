/**
 * dsh-pipeline · 可插拔通信通道 / 角色驱动
 * ============================================================================
 * 「对话之间怎么通信」是需求原文点名要留的**待确认项**之一。这里不替你拍板，
 * 而是把它做成一个**接口**，三档实现随便换：
 *
 *   subagent  真实子代理通道 —— 用 DSH 的 `ctx.subagents` 建真会话、投消息、
 *             收结果。角色身份可与会话 id 二次绑定（令牌转手即失效）。
 *   manual    人工复制通道 —— 本插件不创建任何会话，只负责把「派活单」渲染成
 *             一段可直接粘贴的文本，并铸一枚角色令牌。人在别的对话里粘贴，
 *             那个对话调 pipeline_bind_role 认领角色。**零副作用、零 token。**
 *   simulated 自测通道 —— 内存里假装有会话，用于跑正例/反例。不碰任何真实会话。
 *
 * ★ 需求原文说"不要真的去创建/驱动真实会话来做测试"—— 这就是它要求的
 *   adapter 可注入设计：`createTransport(ctx, config)` 是唯一的选择点，
 *   自测直接 new SimulatedTransport()，一行真实会话都不会被建。
 *
 * ---------------------------------------------------------------------------
 * 真实通道用到的 DSH API（读源码得到，非推测）
 * ---------------------------------------------------------------------------
 *   · `ctx.subagents.startContinuable({ provider, label, request, signal })`
 *       → `{ childId, messageId }`   （`dsh-subagent/lib/index.js:2871`）
 *       注意：**它必然投递初始 prompt**，所以是花钱的。
 *   · `ctx.subagents.start(provider, request)` → `SubagentRun`
 *       `{ id, localAgent, result: Promise, dispose() }`（`typert.host.js:767`）
 *   · `ctx.subagents.sendMessage(sender, targetId, content, options)`
 *       → `MessageId`（`typert.host.js:142`）
 *   · `SubagentStartRequest = { label?, prompt: ContentBlock[], parent: Agent,
 *       signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`
 *       （`typert.host.js:779`）
 *
 *   ⇒ 因此本通道**只在真的需要唤醒一个角色时才建会话**。`spawnRoles:false`
 *     时连建都不建，只发令牌 —— 这正是自测与演示要的零副作用形态。
 *
 * @module dsh-pipeline/lib/transport
 */

import { basename } from 'node:path'

import { ROLE, ROLES, roleLabel } from '../roles.js'
import { PACKAGE_ROOT } from '../util.js'
/**
 * ★ 缺陷 F11：四槽的「凭什么说它生效了」拆成两个单一职责模块 ——
 *   ① `presets.js`       模式槽的**事前**枚举与校验（宿主 `agentPresets` 服务）；
 *   ② `slot-evidence.js` 每一槽的**证据等级**（真读回 / 想读但没接口 / 只请求未回读）。
 *   放在这里而不是塞进本文件：本文件已经 1200 行，且这两件事与"建会话"无关。
 */
import { validatePreset, describePresetCheck } from './presets.js'
import {
  EVIDENCE,
  slotEvidence,
  renderSlotsEvidence,
  pickDeclaredSlot,
} from './slot-evidence.js'

/**
 * ★★ P0-2：**永不向宿主递 `undefined` 的 signal**。
 *
 * 宿主 `ctx.sessionController.prompt(request, signal)` 的 `signal` 是**非可选**参数，
 * 它内部第一句就是 `signal.throwIfAborted()`。本插件里有几条投递路径**拿不到调用方的
 * signal** —— `pipeline_dispatch { notify_only: true }`（主对话叫醒既有席位）与
 * 孤儿单自恢复的重投，它们调 `transport.notifyRole({ task, roster, role, seat, sessionId, message })`
 * 时根本没有 `signal` 这个字段 ⇒ 旧代码把 `undefined` 原样递下去 ⇒ 宿主抛
 * `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 表现出来就是「**席位永远叫不醒**」：裁定/答复落地了，发起席收不到任何东西，
 * 每一轮澄清都要重派一个席位。
 *
 * 纪律：**本插件永不向宿主递 `undefined`**。没有调用方 signal 时用这个"永不中止"的
 * signal（语义 = 调用方没有请求取消 —— 这正是"没有 signal"的本意），有则原样透传。
 */
const NEVER_ABORTED_SIGNAL = new AbortController().signal

/**
 * 把「派活单」渲染成一段可直接粘贴给人的文本（manual 通道）。
 *
 * @param {object} input
 * @param {object} input.task
 * @param {object} input.roster
 * @param {string} input.role
 * @param {string} input.token
 * @param {string} [input.taskCardMd]
 * @returns {string}
 */
export { ensureProjectGroup as ensureProjectGroupForTest }

export function renderDispatchBrief(input) {
  const { task, roster, role, token, seat } = input
  const r = ROLES[role]
  return [
    `# 流水线派活单 · ${r?.zh ?? role}`,
    '',
    `任务 ID：${task.id}`,
    `你的角色：${role}（${r?.zh ?? role}）${seat ? `　席位：${seat}` : ''}`,
    `档位：${roster?.tier ?? '(未编排)'} ${roster?.tier_zh ?? ''} · 独立对话数 ${roster?.ai_count ?? '?'}`,
    `角色清单：${(roster?.conversations ?? []).join(' / ')}`,
    `调用顺序：${(roster?.sequence ?? []).map((s) => s.role).join(' → ')}`,
    '',
    '## 原始需求',
    task.requirement,
    '',
    '## 验收标准',
    ...(task.task_card?.acceptance?.length > 0 ? task.task_card.acceptance.map((a, i) => `${i + 1}. ${a}`) : ['（编排判断尚未产出）']),
    '',
    '## 约束条件',
    ...(task.constraints?.length > 0 ? task.constraints.map((c) => `- ${c}`) : ['- （无）']),
    '',
    '## 你的角色职责',
    r?.summary ?? '',
    '',
    '## 接入方式（在这一步之前，你在本任务里什么都做不了）',
    `1. 先调用 pipeline_bind_role，参数 role_token = ${token}`,
    '2. 之后所有动作都带这个令牌；它只对应上面这一个角色，别的角色动作会被守门拒绝。',
    '',
    '## 该你动手时',
    `用 pipeline_status（task_id=${task.id}）看当前状态与下一步合法事件。`,
  ].join('\n')
}

/** 通道基类（只做接口说明，不强制继承 —— JS 里鸭子类型更实用）。 */
export const TRANSPORT_CONTRACT = Object.freeze({
  kind: 'contract',
  spawnRole: '(spec) => Promise<{ok, agentId, note}>',
  notifyRole: '(spec) => Promise<{ok, messageId, note}>',
  available: '() => boolean',
})

/**
 * **人工复制通道**。不创建任何会话，零副作用。
 * 角色身份是**声明式**的：谁拿着令牌调 pipeline_bind_role，谁就是这个角色。
 */
/**
 * ★★ F12：`spawn=false` 时**唯一**该走的出口 —— 只出可粘贴的派活单，**绝不碰宿主 create**。
 *
 * 为什么要有这个函数（真机 T-20261015-slotprobe）：
 *   `pipeline_dispatch` 的参数文档写着「spawn: 是否真的创建会话」，工具描述也写着
 *   「transport=manual（或 spawn_roles=false）时**只返回一段可粘贴的派活单**」——
 *   但改前**两个分支都调 `transport.spawnRole`**（只差 `parent` / `agentId` 两个字段），
 *   而 `SessionTransport.spawnRole` **无条件** `controller.create` ⇒
 *   用户显式传 `spawn=false` 时，宿主那边**照样建了会话**，只是失败信息里告诉你它试过。
 *
 * 契约（写死在这里，谁改都得先看这段）：
 *   · **不调用**宿主的 `sessionController.create` / `subagents.start*`；
 *   · 铸一枚**未绑定**任何会话的令牌 + 渲染派活单，返回 `sessionId: null` / `agentId: null`；
 *   · 返回值里 **`spawned: false`** 是给调用方与测试的机器可读判据（不靠读文案）。
 *
 * @param {{tokens:any}} deps
 * @param {{task:object, roster:object, role:string, seat?:string|null}} spec
 * @param {string} why - 为什么没建（会进流水，便于事后分辨是"调用方要求"还是"通道不可达"）
 */
export function manualSpawnResult(deps, spec, why) {
  const token = deps.tokens.mint({
    taskId: spec.task.id,
    role: spec.role,
    seat: spec.seat ?? null,
    agentId: null,
    note: 'manual transport（没有创建会话）',
  })
  const brief = renderDispatchBrief({ task: spec.task, roster: spec.roster, role: spec.role, token: token.token, seat: spec.seat ?? null })
  return {
    ok: true,
    /** ★ 机器可读判据：**没有**创建任何会话。 */
    spawned: false,
    agentId: null,
    sessionId: null,
    token: token.token,
    brief,
    via: 'manual',
    note:
      `${why}\n` +
      `本插件**没有创建任何会话**（零副作用：没有调用宿主 create，也没有消耗任何会话资源）。\n` +
      `请把下面这段交给「${roleLabel(spec.role)}」那个对话，让它先调用 pipeline_bind_role 认领角色。\n\n` +
      '```\n' + brief + '\n```',
  }
}

export class ManualTransport {
  constructor(deps) {
    this.kind = 'manual'
    /** @type {{tokens:any, config:any}} */
    this.deps = deps
  }

  available() {
    return true
  }

  /**
   * 「派」一个角色：这里不建会话，只铸令牌并渲染一段可粘贴的派活单。
   * @param {{task:object, roster:object, role:string, agentId?:string|null}} spec
   */
  async spawnRole(spec) {
    return manualSpawnResult(this.deps, spec, '人工复制通道：')
  }

  /** 通知一个角色：manual 通道下只是渲染一段要粘贴的文本。 */
  async notifyRole(spec) {
    return {
      ok: true,
      messageId: null,
      note: `人工复制通道：请把下面这段转给「${roleLabel(spec.role)}」对话。\n\n\`\`\`\n${spec.message}\n\`\`\``,
    }
  }
}

/**
 * **真实子代理通道**。用 `ctx.subagents` 建真会话。
 *
 * ⚠️ 本通道会**真的创建会话并投递 prompt**（会花 token）。所以：
 *   · 只有 `config.spawnRoles === true` 且 `ctx.subagents` 可用时才启用；
 *   · 自测一律用 {@link SimulatedTransport}，不碰这条路径。
 */
/**
 * 取 `subagents` 服务 —— **必须走 `ctx.get()`，不能直读 `ctx.subagents`**。
 *
 * ★ 这是本插件"整个没加载"那个 bug 的根因，写清楚免得再犯：
 *   cordis 的 Context 代理对**没写进 `inject` 的服务名一律抛**
 *   `cannot get property "subagents" without inject`
 *   （`@deepseek-ai/cordis/lib/index.js:676-695`）。而且**服务在不在都一样** ——
 *   实测：兄弟插件用 `provide()` 或 `Service` 提供了它也照抛；
 *   判据是"你声明了没有"，不是"它存不存在"。
 *
 *   本插件刻意**不**把 subagents 写进 inject（见 index.js 插件说明：
 *   少一个服务依赖就少一种"装不上"的方式），所以直读必然抛 ——
 *   而那一抛发生在 `index.js:146` 的 `createTransport()` 里，
 *   在**任何工具注册（:215）、守门（:241）、开关路由（:280）、prompt 段（:298）之前**。
 *   表现出来就是"插件完全没加载"：没有 pipeline_* 工具、`/.dsh-pipeline/state` 404。
 *
 * `ctx.get(name)` 是宿主给的安全读法：拿不到返回 undefined，不抛。
 * `lib/switch-routes.js:198` 读 webServer 用的就是同一招。
 *
 * @param {object} ctx
 * @returns {object|undefined} subagents 服务，拿不到就是 undefined
 */
function getSubagents(ctx) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get('subagents')
    } catch {
      return undefined
    }
  }
  // 非 cordis 的假 ctx（自测替身）是普通对象，直读安全
  try {
    return ctx.subagents
  } catch {
    return undefined
  }
}

export class SubagentTransport {
  constructor(deps) {
    this.kind = 'subagent'
    this.deps = deps
  }

  available() {
    const s = getSubagents(this.deps.ctx)
    return s !== undefined && s !== null && typeof s.start === 'function'
  }

  /**
   * 派一个角色：建一个 continuable 子代理并把派活单作为初始 prompt 投进去。
   *
   * 返回值里的 `agentId` 就是子会话 id（`agent.id === agent.session.id`，
   * 见 `dsh-agent/lib/index.js:511`），令牌会**立刻与它绑定**。
   *
   * @param {{task:object, roster:object, role:string, parent:any, signal?:AbortSignal}} spec
   */
  async spawnRole(spec) {
    /** ★★ F12：`spawn=false` ⇒ 不许 `subagents.start*`。理由同 {@link SessionTransport.spawnRole}。 */
    if (spec?.spawn === false) {
      return manualSpawnResult(this.deps, spec, '调用方显式传了 `spawn=false`（只要派活单，不要子代理会话）：')
    }
    const cfg = this.deps.config
    const subagents = getSubagents(this.deps.ctx)
    const token = this.deps.tokens.mint({ taskId: spec.task.id, role: spec.role, seat: spec.seat ?? null, agentId: null, note: 'subagent transport' })
    const brief = renderDispatchBrief({ task: spec.task, roster: spec.roster, role: spec.role, token: token.token, seat: spec.seat ?? null })

    const provider = (cfg.roleProvider && cfg.roleProvider.length > 0 ? cfg.roleProvider : cfg.subagentProvider) || 'spawn'
    const label = `${cfg.labelPrefix ?? 'pipeline'}:${spec.seat ?? spec.role}:${spec.task.id}`

    try {
      // 优先 continuable（可续接），拿不到就退回一次性 start。
      if (typeof subagents.startContinuable === 'function') {
        const started = await subagents.startContinuable({
          provider,
          label,
          request: {
            label,
            prompt: [{ type: 'text', text: brief }],
            parent: spec.parent,
          },
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
        })
        const agentId = started?.childId ?? null
        if (agentId !== null) this.deps.tokens.bindAgent(token.token, String(agentId))
        return {
          ok: true,
          agentId: agentId === null ? null : String(agentId),
          token: token.token,
          note: `已创建子代理会话 ${agentId}（provider=${provider}，label=${label}），派活单已投递。`,
        }
      }
      const run = await subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: brief }],
        parent: spec.parent,
      })
      const agentId = run?.id ?? null
      if (agentId !== null) this.deps.tokens.bindAgent(token.token, String(agentId))
      return {
        ok: true,
        agentId: agentId === null ? null : String(agentId),
        token: token.token,
        note: `已创建子代理会话 ${agentId}（provider=${provider}，一次性运行）。`,
      }
    } catch (err) {
      // 建会话失败不该静默降级成"人工通道"——那会让主对话以为已经派出去了。
      return {
        ok: false,
        agentId: null,
        token: token.token,
        note:
          `创建子代理会话失败：${String(err?.message ?? err)}\n` +
          `令牌已铸好（${token.token}），你可以改用人工复制通道把它交给对应角色的对话；` +
          `或把 config.transport 设为 'manual' 后重新派活。`,
        brief,
      }
    }
  }

  /** 给一个角色会话投消息。 */
  async notifyRole(spec) {
    const subagents = getSubagents(this.deps.ctx)
    if (subagents === undefined || subagents === null || typeof subagents.sendMessage !== 'function') {
      return { ok: false, messageId: null, note: 'ctx.subagents.sendMessage 不可用，无法投递。' }
    }
    try {
      const messageId = await subagents.sendMessage(spec.sender, spec.agentId, [{ type: 'text', text: spec.message }], {})
      return { ok: true, messageId: messageId === null || messageId === undefined ? null : String(messageId), note: `已投递到 ${spec.agentId}。` }
    } catch (err) {
      return { ok: false, messageId: null, note: `投递失败：${String(err?.message ?? err)}` }
    }
  }
}

/**
 * **自测通道**。内存里假装有会话，一个真实会话都不建。
 * 记录每一次"派活/通知"，供断言检查。
 */
export class SimulatedTransport {
  constructor(deps, opts = {}) {
    this.kind = 'simulated'
    this.deps = deps
    /** 假的会话 id 计数器。 */
    this.seq = opts.startAt ?? 0
    /** @type {Array<{kind:string, role:string, taskId:string, agentId:string|null, at:string}>} */
    this.calls = []
    /** 是否让 spawnRole 失败（用于测"建会话失败"分支）。 */
    this.failSpawn = opts.failSpawn === true
  }

  available() {
    return true
  }

  async spawnRole(spec) {
    if (this.failSpawn) {
      return { ok: false, agentId: null, token: null, note: '（模拟）创建会话失败。' }
    }
    this.seq += 1
    const agentId = `fake-agent-${String(this.seq).padStart(3, '0')}`
    const token = this.deps.tokens.mint({ taskId: spec.task.id, role: spec.role, seat: spec.seat ?? null, agentId, note: 'simulated transport' })
    this.calls.push({
      kind: 'spawn',
      role: spec.role,
      taskId: spec.task.id,
      agentId,
      at: new Date().toISOString(),
    })
    return {
      ok: true,
      agentId,
      token: token.token,
      note: `（模拟通道）已派角色 ${spec.role}，假会话 ${agentId}。未创建任何真实会话。`,
    }
  }

  async notifyRole(spec) {
    this.calls.push({
      kind: 'notify',
      role: spec.role ?? '',
      taskId: spec.taskId ?? '',
      agentId: spec.agentId ?? null,
      at: new Date().toISOString(),
    })
    return { ok: true, messageId: `fake-msg-${this.calls.length}`, note: '（模拟通道）已记录一次通知。' }
  }
}

// ===========================================================================
// 真实会话通道（session）—— 取代 `provider=spawn` 的子代理派活
// ===========================================================================
//
// 为什么必须换：子代理是**进程内的后台会话**，用户在侧栏里看不见、点不进去、
// 也翻不了它每一轮干了什么。本通道用宿主的会话服务新建**一等公民会话**：
// 侧栏里多出一个会话、点进去能翻每一轮（与 Computer Use 派 Code Agent 同一套能力）。
//
// 调用形状取自**同机在跑的实现**（不是按文档推断）：
//   `node_modules/dsh-orb/dist/computer-use/code-agent.js`
//     · `await ctx.sessionController.create({ agentPreset, workspaceId })` → `{ sessionId }`
//     · `await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [...] })`
//     · `(await ctx.sessionController.inspect(sessionId)).meta` → 会话头
//   宿主硬约束：`workspaceId` 与 `cwd` **不能同时给**（给了会抛 gateway/bad-request）。
//
// 三条判据（诚实边界，同一条也写进交付说明）：
//   ① 子代理的唯一标记是 `header.origin === 'subagent'`（该字段只有这一个合法取值，
//      普通会话是 undefined）⇒ 派活之后**必须**读回一次，确认不是子代理会话；
//      拿子代理冒名「真实对话」是本通道**唯一不许发生**的事情。
//   ② 模式是否生效看 `header.agentPreset`。
//   ③ 权限档读回用 `permissionPresets.current(session)`。
//
// ★ 四槽为什么必须**显式**落（不传 ≠ 中性，三条都是本机实测）：
//   · 模式：profile 里 `selectedDefault: computer-use` ⇒ 不指定 preset 的新会话
//     拿到的是 Computer Use 模式（另一套工具树与提示词），而它「看起来能跑」。
//   · 权限：宿主 `pinInitialPermission` 会给全新会话钉上 defaultPreset，而那个
//     默认档是按运行时沙箱模式**推断**出来的 —— 可能是「完全放开」。
//   · 模型：`selectModel` 一定顺带把选择写成**全局默认**，所以下发之后要还原。
//   ⇒ 落地口径：**未指定 = 插件显式写该槽默认档 + 留痕**，然后读回核对。
//
// ★ 不可达纪律：通道缺件时**只上报、不降级**（`UnreachableTransport`）。
//   静默退回子代理 = 拿近似物冒名，是本次需求点名禁止的。

/** 本通道的 kind；派活记录里的 `via` 同值。 */
export const SESSION_KIND = 'session'

/** 派活四槽的字段名 —— **四个独立顶层字段**，不许合并成一个 options 对象。 */
export const DISPATCH_SLOT_KEYS = Object.freeze(['permission', 'mode', 'model', 'reasoning'])

/** 三档权限（宿主档名原样使用）。 */
export const PERMISSION_TIERS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** 「未指定时取最小档」的那一档。 */
export const MIN_PERMISSION = 'read-only'

/** 「完全」档：默认禁用；开启必须走 需求分析 → 主对话 → 用户判定。 */
export const FULL_PERMISSION = 'danger-full-access'

/** 「完全」档三段闸门（缺一段即拒）。 */
export const FULL_PERMISSION_CHAIN = Object.freeze(['orchestrator', 'main', 'user'])

/** 会话预设缺省。★ 不传 ≠ 中性：本机 selectedDefault 是 computer-use。 */
export const DEFAULT_SESSION_PRESET = 'standard'

/** 跨插件串行键：与 dsh-orb 共用同一个进程级队列，免得两边互相插队。 */
const SELECT_MODEL_QUEUE = Symbol.for('dsh-orb.select-model.queue')

/**
 * 读宿主服务：一律 `ctx.get()`（拿不到返回 undefined，**不抛**），绝不直读属性。
 * 直读会撞上 cordis 的「没写进 inject 的服务名一律抛」，而那一抛发生在 apply 里，
 * 表现是「插件整个没加载」—— 这个坑本插件踩过一次，见文件头部 getSubagents 的注释。
 */
function readService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 服务是否带有全部所需方法（存在 ≠ 可用）。 */
function hasMethods(target, names) {
  if (target === null || target === undefined) return false
  return names.every((n) => typeof target[n] === 'function')
}

/** 能力探测清单（派活前必跑的第一步）。`required=false` 的缺件会如实登记、但不拦住派活。 */
export const CHANNEL_SERVICES = Object.freeze([
  Object.freeze({ name: 'sessionController', need: ['create', 'prompt', 'inspect'], required: true, why: '建会话 / 投派活单 / 读回会话头' }),
  Object.freeze({ name: 'workspaceRegistry', need: ['create'], required: true, why: '按项目建组 —— 不做这一步新会话会落「未分组」' }),
  Object.freeze({ name: 'permissionPresets', need: ['set', 'current'], required: true, why: '按单个会话钉权限档；缺了就保证不了最小档，不许静默放行' }),
  Object.freeze({ name: 'agents', need: ['get'], required: false, why: '会话存活探测' }),
  Object.freeze({ name: 'agentDefaultModel', need: ['currentSelection', 'saveSelection'], required: false, why: '模型 / 推理等级下发与全局默认还原' }),
])

/**
 * 探测真实会话通道是否可达。**结论与证据都要能给用户看**（不许只说「不行」）。
 *
 * @param {object} ctx
 * @returns {{ok:boolean, kind:string, checks:Array<object>, missing:string[], absent:string[], evidence:string[], degradations:string[], note:string}}
 */
export function probeSessionChannel(ctx) {
  const checks = CHANNEL_SERVICES.map((s) => {
    const svc = readService(ctx, s.name)
    const present = hasMethods(svc, s.need)
    return {
      name: s.name,
      need: s.need,
      required: s.required,
      why: s.why,
      present,
      evidence: `ctx.get('${s.name}') → ${present ? '可用' : '不可用'}（需要 ${s.need.join(' / ')}；用途：${s.why}）`,
    }
  })
  const missing = checks.filter((c) => c.required && !c.present).map((c) => c.name)
  const absent = checks.filter((c) => !c.required && !c.present).map((c) => c.name)
  return {
    ok: missing.length === 0,
    kind: SESSION_KIND,
    checks,
    missing,
    absent,
    evidence: checks.map((c) => c.evidence),
    degradations: missing.length === 0 ? [] : [
      '降级甲（零副作用）：把 config.transport 设为 "manual" —— 本插件不建任何会话，只把派活单渲染成一段可粘贴文本，由人转给目标对话。代价：侧栏不会新增会话，「真实对话派活」这条验收**不成立**。',
      '降级乙（保留旧行为）：把 config.transport 设为 "subagent" —— 退回 provider=spawn 子代理通道。代价：会话是后台子代理，侧栏看不见、点不进去，「真实对话派活」这条验收**同样不成立**，且等于拿近似物冒名。',
      '降级丙（补齐能力后复验）：把缺失的服务补上（宿主能力 / 插件挂载声明），由**用户重启**后复验。这一步可能涉及安装或改 profile，属人工拍板项。',
    ],
    note: missing.length === 0
      ? '真实会话通道所需服务齐全。'
      : `真实会话通道不可达：缺 ${missing.join('、')}。★ 已按「先上报、不静默降级」停住 —— 请把上面的降级方案交用户裁定后再执行。`,
  }
}

/** 把四槽归一化成 `{value, origin, isDefault, reason, approval}`。**四槽物理分离，这里不做任何合并。** */
export function normalizeSlots(raw, fallback = {}) {
  const out = {}
  for (const key of DISPATCH_SLOT_KEYS) {
    const src = raw === null || raw === undefined ? undefined : raw[key]
    const fb = fallback === null || fallback === undefined ? undefined : fallback[key]
    const fbValue = fb !== undefined && fb !== null && fb.value !== undefined ? fb.value : null
    const fbReason = fb !== undefined && fb !== null && typeof fb.reason === 'string' ? fb.reason : ''
    if (src !== null && src !== undefined && typeof src === 'object' && !Array.isArray(src)) {
      out[key] = {
        value: src.value === undefined ? fbValue : src.value,
        origin: typeof src.origin === 'string' && src.origin.length > 0 ? src.origin : 'plan',
        isDefault: src.origin === 'default' || src.isDefault === true,
        reason: typeof src.reason === 'string' && src.reason.length > 0 ? src.reason : fbReason,
        approval: src.approval === undefined ? null : src.approval,
      }
    } else if (typeof src === 'string' && src.length > 0) {
      out[key] = { value: src, origin: 'plan', isDefault: false, reason: fbReason, approval: null }
    } else {
      out[key] = { value: fbValue, origin: 'default', isDefault: true, reason: fbReason, approval: null }
    }
  }
  return out
}

/**
 * 「完全」档闸门：**默认禁用**；开启必须三段齐（需求分析 → 主对话 → 用户判定），
 * 且用户批准的范围要覆盖本次派活（本次、本角色、本任务）。缺一段即拒。
 */
export function fullPermissionGate(slot, spec) {
  const tier = slot !== null && slot !== undefined ? slot.value ?? null : null
  if (tier !== FULL_PERMISSION) return { ok: true, required: false, tier, missing: [], scopeMismatch: [], report: '' }

  const taskId = String(spec?.task?.id ?? '')
  const role = String(spec?.role ?? '')
  const seat = spec?.seat ?? null
  const ap = slot.approval !== null && typeof slot.approval === 'object' ? slot.approval : null
  const stages = []
  if (ap !== null) {
    if (ap.requirement !== null && ap.requirement !== undefined && typeof ap.requirement === 'object') stages.push('orchestrator')
    if (ap.main !== null && ap.main !== undefined && typeof ap.main === 'object') stages.push('main')
    const u = ap.user
    if (u !== null && u !== undefined && typeof u === 'object' && (u.decision === 'approved' || u.approved === true)) stages.push('user')
  }
  const missing = FULL_PERMISSION_CHAIN.filter((s) => !stages.includes(s))

  const scope = ap !== null && ap.user !== null && typeof ap.user === 'object' ? ap.user.scope ?? null : null
  const scopeMismatch = []
  if (missing.length === 0) {
    if (typeof scope?.taskId === 'string' && scope.taskId !== taskId) scopeMismatch.push(`批准范围是任务 ${scope.taskId}，本次是 ${taskId}`)
    if (typeof scope?.role === 'string' && scope.role !== role) scopeMismatch.push(`批准范围是角色 ${scope.role}，本次是 ${role}`)
    if (scope?.seat !== undefined && scope.seat !== null && scope.seat !== seat) scopeMismatch.push(`批准范围是席位 ${scope.seat}，本次是 ${seat === null ? '(单席位)' : seat}`)
  }
  const ok = missing.length === 0 && scopeMismatch.length === 0
  const report = ok
    ? ''
    : [
        '# 拒绝派活：「完全」档未获批准',
        '',
        `任务 ${taskId || '(未知)'} · 角色 ${role || '(未知)'}${seat === null ? '' : ` · 席位 ${seat}`}：本次派活申请的是「完全」档（${FULL_PERMISSION}）。`,
        '',
        '## 为什么拒',
        '「完全」档**默认禁用**：开启必须走齐三段 —— 需求分析 → 主对话 → 用户判定，缺一段即拒。',
        `本次缺：${missing.length > 0 ? missing.join('、') : '（三段齐了，但批准范围对不上）'}`,
        ...(scopeMismatch.length > 0 ? ['', '## 范围不符', ...scopeMismatch.map((m) => `- ${m}`)] : []),
        '',
        '## 下一步',
        '把这条交主对话转告用户，由用户判定。本插件不代替用户批准，也不以「技术需要」默认放行；',
        '在用户给出肯定答复之前，**任何会话都不得以「完全」档启动**。',
      ].join('\n')
  return { ok, required: true, tier, stages, missing, scopeMismatch, report }
}

/**
 * ★★ **B7：分组的标题取"任务的项目名 / 落点目录名"，绝不取"当前工作目录的名字"**。
 *
 * 现场：新派会话落进的分组标题是 `desktop`，`root=<profile>\desktop`
 * —— 那是**插件所在的那个 profile 目录**（也就是主对话的工作目录），
 * 不是这个任务在做的项目。用户上一轮曾因为这个错名**把整组删掉**。
 *
 * 判据（三条，按优先级）：
 *   ① 配置里显式给了 `groupTitle` ⇒ 用它的（人工拍板优先）；
 *   ② 任务带 `project_name` ⇒ 用它（任务自己的身份）；
 *   ③ 否则用**落点目录名**：`task.scope_anchor`（授权面的锚点 = 这个任务真正动的是哪个包）
 *      的 basename；再退 `task.project_root` 的 basename —— 但**工作目录兜底不算项目名**
 *      （`<DSH_PROFILE_DIR>` 或 basename 恰好等于 profile 名时它只是"会话开在哪儿"，
 *      拿它当组名就是把插件目录名写进分组），此时退到 `task.id`。
 *
 * @param {object} cfg
 * @param {object|null} task
 * @param {string} root - 已解析的建组根
 * @returns {{title:string, source:string, isFallback:boolean}}
 */
function groupTitleOf(cfg, task, root) {
  const explicit = typeof cfg?.groupTitle === 'string' && cfg.groupTitle.length > 0 ? cfg.groupTitle : null
  if (explicit !== null) return { title: explicit, source: 'config.groupTitle', isFallback: false }
  const named = typeof task?.project_name === 'string' && task.project_name.trim().length > 0 ? task.project_name.trim() : null
  if (named !== null) return { title: named, source: 'task.project_name', isFallback: false }
  const anchor = typeof task?.scope_anchor === 'string' && task.scope_anchor.length > 0 ? task.scope_anchor : null
  if (anchor !== null) {
    const b = basename(anchor)
    if (b.length > 0) return { title: b, source: 'task.scope_anchor', isFallback: false }
  }
  const profileDir = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.length > 0 ? process.env.DSH_PROFILE_DIR : null
  const profileName = process.env.DSH_PROFILE && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : null
  const base = basename(root)
  const looksLikeWorkspaceOnly =
    (profileDir !== null && pathKeyLite(root) === pathKeyLite(profileDir)) ||
    (profileName !== null && base === profileName) ||
    looksLikeProfileDir(root)
  if (!looksLikeWorkspaceOnly && base.length > 0) return { title: base, source: 'basename(project_root)', isFallback: false }
  const id = typeof task?.id === 'string' && task.id.length > 0 ? task.id : null
  return {
    title: id ?? base,
    source: id === null ? 'basename(project_root)·兜底' : 'task.id·兜底（工作目录不算项目名）',
    isFallback: true,
  }
}

/**
 * 不靠环境变量认 profile 目录（插件进程里 `DSH_PROFILE_DIR` / `DSH_PROFILE` 常常取不到，
 * 只靠它们时这条判据在真机上等于没有）：
 *   ① 路径形状 `…/.dsh/profiles/<名字>`；
 *   ② 本插件装在 `<profile>/node_modules/dsh-pipeline` ⇒ 往上两级就是 profile 目录。
 */
function looksLikeProfileDir(p) {
  const k = pathKeyLite(p)
  if (/\/\.dsh\/profiles\/[^/]+$/.test(k)) return true
  const installed = pathKeyLite(PACKAGE_ROOT).match(/^(.*)\/node_modules\/[^/]+$/)
  return installed !== null && k === installed[1]
}

/** 极简路径归一（只用于"这两个路径是不是同一个"，不引入依赖）。 */
function pathKeyLite(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 把「按项目建组」做成**确定性**动作：ensure（建则建、有则复用），不是事后整理。 */
async function ensureProjectGroup(ctx, cfg, spec) {
  const registry = readService(ctx, 'workspaceRegistry')
  const root = typeof cfg?.projectRoot === 'string' && cfg.projectRoot.length > 0
    ? cfg.projectRoot
    : (typeof spec?.task?.project_root === 'string' && spec.task.project_root.length > 0 ? spec.task.project_root : null)
  if (root === null) {
    return { ok: false, note: '没有项目根（config.projectRoot 与 task.project_root 都是空的）⇒ 无法建组，**拒绝派活**（不许静默落「未分组」）。' }
  }
  if (!hasMethods(registry, ['create'])) {
    return { ok: false, note: 'ctx.workspaceRegistry.create 不可用 ⇒ 无法把会话归进项目分组，**拒绝派活**（不许静默落「未分组」）。', root }
  }
  const titleInfo = groupTitleOf(cfg, spec?.task ?? null, root)
  const title = titleInfo.title
  const attempts = [
    { shape: '({ path, title })', call: () => registry.create({ path: root, title }) },
    { shape: '(path, title)', call: () => registry.create(root, title) },
  ]
  const errors = []
  for (const a of attempts) {
    try {
      const ws = await a.call()
      const id = ws?.id ?? ws?.workspaceId ?? null
      if (typeof id === 'string' && id.length > 0) {
        return {
          ok: true,
          workspaceId: id,
          root,
          title,
          /** ★ B7：标题**从哪来**（可核：组名错了能一眼看出是取错来源还是取错根）。 */
          title_source: titleInfo.source,
          title_is_fallback: titleInfo.isFallback,
          shape: a.shape,
          created: ws?.created === true,
          note:
            `项目分组 ${id}（标题 ${title}；标题来源 ${titleInfo.source}；root=${root}；create 形状 ${a.shape}；` +
            `${ws?.created === true ? '本次新建' : '复用已有记录'}）` +
            (titleInfo.isFallback
              ? '\n★ 注意：这个标题是**兜底值**（任务没带项目名 / 落点目录名），不是项目名 —— 建议给任务补 `project_name`。'
              : ''),
        }
      }
      errors.push(`${a.shape} → 调用成功但返回里没有 id`)
    } catch (err) {
      errors.push(`${a.shape} → ${String(err?.message ?? err)}`)
    }
  }
  return { ok: false, root, note: `workspaceRegistry.create 两种调用形状都失败：\n  · ${errors.join('\n  · ')}` }
}

/** 候选会话对象（权限档 API 收对象不收 id；不同宿主形态或许多包一层 `session`）。 */
function resolveSessionCandidates(ctx, sessionId) {
  const agents = readService(ctx, 'agents')
  if (!hasMethods(agents, ['get'])) return []
  try {
    const a = agents.get(sessionId)
    if (a === null || a === undefined) return []
    const list = [a]
    if (a.session !== undefined && a.session !== null && typeof a.session === 'object') list.push(a.session)
    return list
  } catch {
    return []
  }
}

/** 会话↔席位读回（三项冻结接口之一）：会话头 + 模式 + 权限档 + 会话归属，一次读齐。 */
export async function readSessionBinding(ctx, sessionId) {
  const out = { sessionId, ok: false, origin: null, agentPreset: null, workspaceId: null, cwd: null, permission: null, notes: [] }
  const controller = readService(ctx, 'sessionController')
  if (!hasMethods(controller, ['inspect'])) {
    out.notes.push('inspect 不可用 —— 读不回会话头，**不能判定它是不是子代理会话**')
    return out
  }
  try {
    const meta = (await controller.inspect(sessionId))?.meta ?? null
    out.origin = meta?.origin ?? null
    out.agentPreset = meta?.agentPreset ?? null
    out.workspaceId = meta?.workspaceId ?? null
    out.cwd = meta?.cwd ?? null
  } catch (err) {
    out.notes.push(`inspect 失败：${String(err?.message ?? err)}`)
    return out
  }
  const presets = readService(ctx, 'permissionPresets')
  if (hasMethods(presets, ['current'])) {
    for (const c of resolveSessionCandidates(ctx, sessionId)) {
      try {
        const cur = presets.current(c)
        if (cur !== undefined) {
          out.permission = cur === null ? null : typeof cur === 'string' ? cur : (cur.preset ?? cur.name ?? null)
          break
        }
      } catch {
        /* 读不到就如实留 null */
      }
    }
  }
  out.ok = true
  return out
}

/** 会话存活探测（失联检测用）。查不到就**说查不到**，不假装「它还活着」。 */
export function sessionAlive(ctx, sessionId) {
  const agents = readService(ctx, 'agents')
  if (!hasMethods(agents, ['get'])) {
    return { known: false, alive: null, status: null, note: '存活探测不可用：拿不到 agents 服务（如实登记，不假装"还活着"）' }
  }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch (err) {
    return { known: false, alive: null, status: null, note: `存活探测失败：${String(err?.message ?? err)}` }
  }
  if (agent === null || agent === undefined) {
    return { known: true, alive: false, status: 'gone', note: `会话 ${sessionId} 已不在 agents 表里（已结束或被回收）` }
  }
  const status = typeof agent.status === 'string' ? agent.status : null
  return { known: true, alive: true, status, note: `会话 ${sessionId} 存活（status=${status === null ? 'unknown' : status}）` }
}

/** 进程级串行（与 dsh-orb 共用同一个 Symbol 键）—— 免得两边互相插队。 */
function enqueueSelectModel(task) {
  const holder = globalThis
  const run = (holder[SELECT_MODEL_QUEUE] ?? Promise.resolve()).then(task, task)
  holder[SELECT_MODEL_QUEUE] = run.catch(() => void 0)
  return run
}

function sameSelection(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false
  return a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
}

/** 权限槽：钉到会话上并**读回核对**。钉不上 / 读回不符 ⇒ 拒绝派活（不回退、不静默）。 */
async function applyPermissionSlot(ctx, sessionId, slot) {
  const presets = readService(ctx, 'permissionPresets')
  const want = slot === null || slot === undefined ? null : slot.value ?? null
  const rec = { ok: false, applied: false, value: want, origin: slot?.origin ?? 'default', readback: null, note: '' }
  if (want === null) {
    rec.note = '权限槽没有值 ⇒ 拒绝派活（不许"不设置"就把会话放出去）'
    return rec
  }
  if (!hasMethods(presets, ['set'])) {
    rec.note = 'permissionPresets.set 不可用 ⇒ 钉不上权限档，拒绝派活'
    return rec
  }
  const candidates = resolveSessionCandidates(ctx, sessionId)
  if (candidates.length === 0) {
    rec.note = '拿不到会话对象（agents.get 返回空）⇒ 钉不上权限档，拒绝派活'
    return rec
  }
  const errors = []
  for (const c of candidates) {
    try {
      await presets.set(c, want)
      rec.applied = true
      if (hasMethods(presets, ['current'])) {
        try {
          const cur = presets.current(c)
          rec.readback = cur === null || cur === undefined ? null : typeof cur === 'string' ? cur : (cur.preset ?? cur.name ?? null)
        } catch (err) {
          errors.push(`读回失败：${String(err?.message ?? err)}`)
        }
      }
      break
    } catch (err) {
      errors.push(`set(${want}) → ${String(err?.message ?? err)}`)
    }
  }
  if (!rec.applied) {
    rec.note = `权限档钉不上（很可能档名不在宿主档表里）⇒ 拒绝派活 + 留痕，不回退：\n  · ${errors.join('\n  · ')}`
    rec.evidence = slotEvidence(EVIDENCE.FAILED, want, null, 'permissionPresets.set 全部候选会话都失败')
    return rec
  }
  if (rec.readback !== null && rec.readback !== want) {
    rec.note = `读回不符：要 ${want}，实际 ${rec.readback} ⇒ 拒绝派活（不回退、不静默）。留痕：${errors.join('；') || '无'}`
    rec.evidence = slotEvidence(EVIDENCE.READBACK, want, rec.readback, '读回值与请求值不符 ⇒ 已拒绝派活')
    return rec
  }
  rec.ok = true
  /**
   * ★ 缺陷 F11：这里以前是一句话「权限档 = X（…）；读回核对一致（X）」。
   *   它对**这个槽**是真话（确实读了 `permissionPresets.current`），
   *   但读者会把它读成"整个四槽都核对过了" —— 而 `model` / `reasoning` 从来没回读过。
   *   现在拆成**结构化证据**：真读回 / 想读但没有接口 / 只请求未回读，三态互不打掩护。
   */
  if (rec.readback === null) {
    rec.evidence = slotEvidence(
      hasMethods(presets, ['current']) ? EVIDENCE.READBACK_UNAVAILABLE : EVIDENCE.READBACK_UNAVAILABLE,
      want,
      null,
      hasMethods(presets, ['current'])
        ? 'permissionPresets.current 读不到值 ⇒ **未读回**（钉是钉上了：set 没抛错）'
        : '宿主没有 permissionPresets.current ⇒ 无法回读（钉是钉上了：set 没抛错）',
    )
    rec.note = `权限档 = ${want}（${rec.origin === 'default' ? '未指定 ⇒ 取三档中最小档' : '计划指定'}）；**未读回**（${rec.evidence.detail}）`
  } else {
    rec.evidence = slotEvidence(EVIDENCE.READBACK, want, rec.readback, '')
    rec.note = `权限档 = ${want}（${rec.origin === 'default' ? '未指定 ⇒ 取三档中最小档' : '计划指定'}）；会话读回一致（${rec.readback}）`
  }
  return rec
}

/** 模型 / 推理等级槽：下发到该会话，并把被顺带改掉的全局默认还原。 */
async function applyModelSlot(ctx, sessionId, slots) {
  const controller = readService(ctx, 'sessionController')
  const defaults = readService(ctx, 'agentDefaultModel')
  const raw = slots.model.value
  const effort = slots.reasoning.value
  const rec = { ok: false, applied: false, value: raw, reasoningEffort: effort ?? null, origin: slots.model.origin, note: '' }
  if (raw === null && (effort === null || effort === undefined)) {
    rec.ok = true
    rec.note = '模型 / 推理等级未指定 ⇒ 不调用 selectModel，会话沿用环境枚举默认档（也就不会写全局默认）'
    rec.evidence = slotEvidence(EVIDENCE.NOT_SPECIFIED, null, null, '没指定就不下发；会话沿用环境枚举默认档')
    rec.reasoningEvidence = slotEvidence(EVIDENCE.NOT_SPECIFIED, null, null, '没指定就不下发')
    return rec
  }
  let provider = null
  let model = null
  if (typeof raw === 'string' && raw.length > 0) {
    const i = raw.indexOf('/')
    if (i > 0) {
      provider = raw.slice(0, i)
      model = raw.slice(i + 1)
    } else {
      model = raw
    }
  } else if (raw !== null && typeof raw === 'object') {
    provider = raw.provider ?? null
    model = raw.model ?? null
  }
  if (typeof controller?.selectModel !== 'function') {
    rec.note = '计划指定了模型 / 推理等级，但宿主的 sessionController.selectModel 不可用 ⇒ 拒绝派活 + 留痕，不回退'
    return rec
  }
  if (typeof model !== 'string' || model.length === 0) {
    rec.note = `模型槽的值认不出来（要 "provider/model"、"model" 或 { provider, model }）⇒ 拒绝派活 + 留痕，不回退`
    return rec
  }
  if (provider === null && typeof defaults?.currentSelection === 'function') {
    try {
      provider = defaults.currentSelection()?.provider ?? null
    } catch {
      provider = null
    }
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    rec.note = '拿不到 provider（模型槽里没写，也读不到环境默认）⇒ 拒绝派活 + 留痕'
    return rec
  }
  const chosen = { provider, model, ...(effort === null || effort === undefined ? {} : { reasoningEffort: effort }) }
  const previous = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
  try {
    await enqueueSelectModel(async () => {
      await controller.selectModel({ sessionId, ...chosen })
      if (hasMethods(defaults, ['saveSelection']) && previous !== undefined && !sameSelection(previous, chosen)) {
        await defaults.saveSelection(previous)
      }
    })
  } catch (err) {
    rec.note = `下发失败（指定了部署里不存在的 provider / model / 等级会被宿主拒）⇒ 拒绝派活 + 留痕，不回退：${String(err?.message ?? err)}`
    return rec
  }
  rec.ok = true
  rec.applied = true
  /**
   * ★★ 缺陷 F11 的核心更正（用户那个尖锐的问题）：
   *   模型 / 推理等级**从来没有回读过** —— 宿主没有"读回某个会话当前用什么模型"的接口，
   *   改前的证据只有「`selectModel` 没抛错」。所以这里**不许**写"核对一致"，
   *   结构化地记成 `REQUESTED`（`effective` 恒为 null ⇒ 结构上就写不出"一致"）。
   */
  const modelText = `${provider}/${model}`
  const reasonText = chosen.reasoningEffort === undefined ? null : String(chosen.reasoningEffort)
  rec.evidence = slotEvidence(
    EVIDENCE.REQUESTED,
    modelText,
    null,
    '宿主没有"读回某会话当前模型"的接口 ⇒ 证据只有 selectModel 未抛错；**没有读回，故不称一致**；全局默认已还原（残余窗口如实登记：写入与还原之间新建的会话会看到被选中的模型一次 —— 与 dsh-orb 同款补偿，未消除）',
  )
  rec.reasoningEvidence = slotEvidence(
    effort === null || effort === undefined ? EVIDENCE.NOT_SPECIFIED : EVIDENCE.REQUESTED,
    reasonText,
    null,
    effort === null || effort === undefined
      ? '没指定推理等级 ⇒ 不下发'
      : '推理等级与模型同一次 selectModel 下发；同样**没有读回**',
  )
  rec.note = `模型 = ${modelText}${reasonText === null ? '' : `，推理等级 = ${reasonText}`}；**已请求·未回读**（宿主没有读回接口，证据只有 selectModel 未抛错）；全局默认已还原（残余窗口如实登记：写入与还原之间新建的会话会看到被选中的模型一次 —— 与 dsh-orb 同款补偿，未消除）`
  return rec
}

/** 通道不可达的报告（给用户看的人话，带证据与降级方案）。 */
function renderUnreachableReport(probe, spec) {
  const role = spec?.role ?? '(未知角色)'
  return [
    `# 派活通道不可达 · ${roleLabel(role)}${spec?.seat ? `（${spec.seat}）` : ''}`,
    '',
    `任务 ${spec?.task?.id ?? '(未知)'}：本插件**没有**创建任何会话，也**没有**降级到子代理。`,
    '',
    '## 证据（逐项来自运行时探测，不是推断）',
    ...probe.evidence.map((e) => `- ${e}`),
    '',
    '## 结论',
    `缺 ${probe.missing.join('、')}：真实会话派活这条路径在当前宿主上是**不可达**的。`,
    '',
    '## 降级方案（★ 必须先交用户裁定，不许自行挑一个接着跑）',
    ...probe.degradations.map((x, i) => `${i + 1}. ${x}`),
    '',
    '★ 本插件不会自己挑一个降级方案继续 —— 静默降级 = 拿近似物冒名。',
  ].join('\n')
}

/**
 * **真实会话通道**。派活 = 新建一个用户能看见、能点开、能继续对话的一等公民会话。
 */
export class SessionTransport {
  constructor(deps) {
    this.kind = SESSION_KIND
    this.deps = deps
  }

  available() {
    return probeSessionChannel(this.deps.ctx).ok
  }

  probe() {
    return probeSessionChannel(this.deps.ctx)
  }

  /** 通道侧留痕（不可达 / 拒档 / 归组失败都要落盘，不许只活在返回值里）。 */
  audit(spec, action, detail) {
    const fn = this.deps.audit
    if (typeof fn !== 'function') return
    try {
      fn({
        taskId: String(spec?.task?.id ?? ''),
        action,
        detail: { ...detail, via: SESSION_KIND, role: spec?.role ?? null, seat: spec?.seat ?? null },
      })
    } catch {
      /* 留痕失败不该拦住派活本身 */
    }
  }

  /**
   * 派一个角色：建组 → 建会话 → 钉四槽 → 读回核对 → 铸令牌绑定 → 投派活单。
   * 任一步不满足就**拒绝**并把理由说清楚；不做部分成功、不做近似替代。
   */
  async spawnRole(spec) {
    /**
     * ★★ F12：调用方说了 `spawn=false` ⇒ **一个字节都不许碰宿主**。
     *   本通道是"真的建会话"的那条路，所以这个判断必须放在**最前面** ——
     *   放在 `ensureProjectGroup` / `create` 之后就晚了（会话已经建出来了）。
     */
    if (spec?.spawn === false) {
      this.audit(spec, 'channel:spawn_false', { note: '调用方显式要求不建会话 ⇒ 只出可粘贴的派活单，未调用宿主 create' })
      return manualSpawnResult(this.deps, spec, '调用方显式传了 `spawn=false`（只要派活单，不要会话）：')
    }
    const ctx = this.deps.ctx
    const cfg = this.deps.config ?? {}
    const taskId = String(spec?.task?.id ?? '')
    const role = String(spec?.role ?? '')

    // ① 能力探测：缺件 → 先上报，不降级。
    const probe = this.probe()
    if (!probe.ok) {
      const report = renderUnreachableReport(probe, spec)
      this.audit(spec, 'channel:unreachable', { missing: probe.missing, absent: probe.absent, evidence: probe.evidence })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, unreachable: true, probe, report, note: report, escalate: 'human' }
    }

    // ② 四槽（物理分离的四个字段）+ 「完全」档闸门。
    const slots = normalizeSlots(spec, {
      permission: { value: MIN_PERMISSION, reason: '未指定 ⇒ 取三档中最小档' },
      mode: { value: typeof cfg.sessionPreset === 'string' && cfg.sessionPreset.length > 0 ? cfg.sessionPreset : DEFAULT_SESSION_PRESET, reason: '未指定 ⇒ 角色默认会话模式' },
      model: { value: null, reason: '未指定 ⇒ 环境枚举默认档' },
      reasoning: { value: null, reason: '未指定 ⇒ 环境枚举默认档' },
    })
    const gate = fullPermissionGate(slots.permission, spec)
    if (!gate.ok) {
      this.audit(spec, 'channel:full_tier_refused', { missing: gate.missing, scope_mismatch: gate.scopeMismatch })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, code: 'FULL_TIER_NOT_APPROVED', report: gate.report, note: gate.report, escalate: 'human', slots }
    }

    // ③ 建组：**派活那一刻**就落对（ensure），不靠事后整理。
    const group = await ensureProjectGroup(ctx, cfg, spec)
    // ③b ★ **建组这件事不许静默**：宿主的 workspace 记录会被换掉 —— 本单现场实测，同一个项目根
    //     （profiles\desktop）的分组 id 从 （UUID） 变成
    //     （UUID）（旧记录已不在 .dsh\storages\workspace.json 里），
    //     此后同一张单的各角色会话就会**跨在两个组里**，而账上没有任何痕迹。
    //     判据只用宿主 create 已返回的 `created`（拿不到就是 undefined ⇒ 恒不触发，不会误报）。
    if (group.created === true) {
      this.audit(spec, 'channel:group_created', { workspaceId: group.workspaceId, root: group.root, title: group.title })
    }
    if (group.ok !== true) {
      const report = `# 拒绝派活：项目分组建不起来\n\n任务 ${taskId} · 角色 ${role}\n\n${group.note}\n\n★ 不做静默降级（不许"先建成未分组、回头再拖"）。请把这条交主对话转告用户，裁定后再派。`
      this.audit(spec, 'channel:group_failed', { note: group.note, root: group.root ?? null })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, unreachable: true, group, report, note: report, escalate: 'human' }
    }

    // ④ 建会话（agentPreset 必须**显式**给，否则会落到宿主推断出来的模式）。
    const controller = readService(ctx, 'sessionController')
    const preset = slots.mode.value
    /**
     * ★★ 缺陷 F11：**事前**校验模式槽（改前只有两道事后判据：create 抛不抛 + 会话头读回相不相等）。
     *   宿主有可枚举的 `agentPresets` 服务（`list()` / `resolve(id)`，见 presets.js 的模块头），
     *   所以名字打错时**在建会话之前**就能拦住，并直接把**合法取值**交给调用方 ——
     *   而不是让宿主静默回落到默认档、等会话建出来之后再靠读回发现。
     *   查不到这个服务时**不拦**（如实标注"未校验"）——因为"探测不到"不等于"名字是错的"。
     */
    const presetCheck = await validatePreset(ctx, preset)
    if (presetCheck.checked && !presetCheck.ok) {
      const report = `# 拒绝派活：模式槽的名字宿主上不存在\n\n任务 ${taskId} · 角色 ${role}\n\n${describePresetCheck(presetCheck)}\n\n★ 改前这种情况要么靠 create 抛一句看不懂的话，要么宿主**静默回落到默认档**、等会话建出来再靠读回发现 —— 现在在建会话之前就拦住。`
      this.audit(spec, 'channel:preset_unknown', { preset, available: presetCheck.ids, defaultId: presetCheck.defaultId })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, code: 'PRESET_UNKNOWN', report, note: report, escalate: 'human', slots, presetCheck }
    }
    if (!presetCheck.checked) {
      this.audit(spec, 'channel:preset_unchecked', { preset, why: presetCheck.why })
    }
    let sessionId = ''
    try {
      const created = await controller.create({ agentPreset: preset, workspaceId: group.workspaceId })
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
    } catch (err) {
      const report = `# 拒绝派活：会话建不出来\n\n任务 ${taskId} · 角色 ${role}\n\n宿主 sessionController.create 失败：${String(err?.message ?? err)}\n\n（已指定 agentPreset=${preset}、workspaceId=${group.workspaceId}）\n★ 不做静默降级。`
      this.audit(spec, 'channel:create_failed', { preset, workspaceId: group.workspaceId, error: String(err?.message ?? err) })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, report, note: report, escalate: 'human' }
    }
    if (sessionId.length === 0) {
      const report = `# 拒绝派活：会话建出来了但拿不到 sessionId\n\n任务 ${taskId} · 角色 ${role}\n★ 没有 id 就没法绑定令牌、没法读回核对 —— 当作失败处理，不做静默降级。`
      this.audit(spec, 'channel:create_no_id', { preset, workspaceId: group.workspaceId })
      return { ok: false, agentId: null, sessionId: null, token: null, via: SESSION_KIND, report, note: report, escalate: 'human' }
    }

    // ⑤ 读回核对：**不许是子代理会话**，模式要真的落上。这一步是「真实对话」的判据。
    const binding = await readSessionBinding(ctx, sessionId)
    if (binding.origin === 'subagent') {
      const report = `# 拒绝派活：建出来的会话是**子代理会话**（origin=subagent）\n\n会话 ${sessionId}。★ 这正是本次需求点名不许发生的"拿近似物冒名" —— 该会话已建出但**不当作派活成功**，请人工处置（停止 / 忽略）后再决定。`
      this.audit(spec, 'channel:subagent_session', { sessionId })
      return { ok: false, agentId: null, sessionId, token: null, via: SESSION_KIND, report, note: report, escalate: 'human' }
    }
    if (binding.ok !== true) {
      const report = `# 拒绝派活：读不回会话头，无法证明它不是子代理会话\n\n会话 ${sessionId}\n${binding.notes.join('\n')}\n★ 「证明不了」不等于「过了」—— 按失败处理，不做静默降级。`
      this.audit(spec, 'channel:binding_unreadable', { sessionId, notes: binding.notes })
      return { ok: false, agentId: null, sessionId, token: null, via: SESSION_KIND, report, note: report, escalate: 'human' }
    }
    if (binding.agentPreset !== null && binding.agentPreset !== preset) {
      const report = `# 拒绝派活：模式没落到会话上\n\n会话 ${sessionId}：要 ${preset}，会话头里是 ${binding.agentPreset}。\n★ 模式只写在计划文本里不算数（验收要求"可在会话元信息或首次回复中观测"）—— 按失败处理。`
      this.audit(spec, 'channel:preset_mismatch', { sessionId, want: preset, got: binding.agentPreset })
      return { ok: false, agentId: null, sessionId, token: null, via: SESSION_KIND, report, note: report, escalate: 'human' }
    }

    // ⑥ 钉四槽（权限 + 模型 / 推理等级），任何一槽钉不上就拒绝。
    const permission = await applyPermissionSlot(ctx, sessionId, slots.permission)
    if (permission.ok !== true) {
      const report = `# 拒绝派活：权限档落不到会话上\n\n会话 ${sessionId}\n${permission.note}\n★ 不把"没钉上"当"钉上了"：最小档保证不了就不放会话出去。`
      this.audit(spec, 'channel:permission_failed', { sessionId, want: permission.value, note: permission.note })
      return { ok: false, agentId: null, sessionId, token: null, via: SESSION_KIND, report, note: report, escalate: 'human', slots }
    }
    const model = await applyModelSlot(ctx, sessionId, slots)
    if (model.ok !== true) {
      const report = `# 拒绝派活：模型 / 推理等级落不到会话上\n\n会话 ${sessionId}\n${model.note}`
      this.audit(spec, 'channel:model_failed', { sessionId, note: model.note })
      return { ok: false, agentId: null, sessionId, token: null, via: SESSION_KIND, report, note: report, escalate: 'human', slots }
    }

    // ⑦ 铸令牌并**与会话绑定**（绑定用 agentId 字段，既有守门判据一行不改）。
    const token = this.deps.tokens.mint({
      taskId,
      role,
      seat: spec?.seat ?? null,
      agentId: sessionId,
      sessionId,
      note: `session transport（项目分组 ${group.workspaceId}）`,
    })
    const brief = renderDispatchBrief({ task: spec.task, roster: spec.roster, role, token: token.token, seat: spec?.seat ?? null })

    // ⑧ 投派活单（建会话与投递分开：先建出来、绑好身份，再让它开工）。
    let delivered = false
    let deliverNote = ''
    try {
      const res = await controller.prompt(
        { requestId: `${SESSION_KIND}-${taskId}-${role}-${Date.now().toString(36)}`, sessionId, mode: 'queue', content: [{ type: 'text', text: brief }] },
        spec?.signal ?? NEVER_ABORTED_SIGNAL,
      )
      delivered = res?.accepted === true || res === undefined || res === null
      deliverNote = `派活单已投递（requestId 幂等，重试用同一个 id 不会重复入队）`
    } catch (err) {
      deliverNote = `★ 会话已建、令牌已绑，但派活单投递失败：${String(err?.message ?? err)} —— 请人工处置（可重投或停止该会话）`
    }
    if (!delivered) {
      this.audit(spec, 'channel:prompt_failed', { sessionId, deliverNote })
      return { ok: false, agentId: sessionId, sessionId, token: token.token, via: SESSION_KIND, report: deliverNote, note: deliverNote, escalate: 'human', group, binding, slots: { permission, mode: slots.mode, model, reasoning: slots.reasoning } }
    }

    /**
     * ★★ 缺陷 F11：四槽逐槽给**证据等级**，不再用一句话把四个槽说成同一件事。
     *   改前「权限档 = X；读回核对一致」这半句对 permission 是真话，
     *   却让整段读起来像"四槽都核对过" —— 而 model / reasoning 从来没回读过。
     */
    const declaredHit = pickDeclaredSlot(spec?.roster ?? null, role, spec?.seat ?? null)
    /**
     * ★ 模式槽的证据：会话头**读到了** agentPreset ⇒ 真读回（且上面已经跟请求值比对过、
     *   不符就拒绝派活了）；读不到那个字段 ⇒ **未读回** —— `create` 没抛错**不能**当"模式落上了"。
     */
    const modeEvidence = slotEvidence(
      binding.agentPreset === null ? EVIDENCE.READBACK_UNAVAILABLE : EVIDENCE.READBACK,
      preset,
      binding.agentPreset,
      binding.agentPreset === null ? '会话头里读不到 agentPreset 字段 ⇒ **未读回**（create 没抛错不能当"模式落上了"）' : '',
    )
    const slotLines = renderSlotsEvidence(
      {
        mode: modeEvidence,
        permission: permission.evidence ?? slotEvidence(EVIDENCE.FAILED, permission.value, null, '缺证据记录'),
        model: model.evidence ?? slotEvidence(EVIDENCE.FAILED, model.value, null, '缺证据记录'),
        reasoning: model.reasoningEvidence ?? slotEvidence(EVIDENCE.FAILED, slots.reasoning?.value ?? null, null, '缺证据记录'),
      },
      declaredHit === null
        ? {}
        : {
            declared: {
              permission: declaredHit.slots.permission ?? null,
              mode: declaredHit.slots.mode ?? null,
              model: declaredHit.slots.model ?? null,
              reasoning: declaredHit.slots.reasoning ?? null,
            },
          },
    )
    slotLines.push(`模式预校验：${describePresetCheck(presetCheck)}`)

    const note = [
      `已新建**真实会话** ${sessionId}（不是子代理会话；读回 origin=${binding.origin ?? 'undefined'}）。`,
      `项目分组：${group.note}`,
      '',
      '## 四槽（逐槽给证据等级 —— 哪一槽是"读回来的"、哪一槽只是"发出去了"，都在这里）',
      ...slotLines.map((l) => `- ${l}`),
      '',
      `角色令牌：${token.token}（已与会话绑定；转手即失效）`,
      '★ 诚实边界：「真实会话 + 归组 + 四槽」这三件事的**真派活观测**（侧栏真的多出会话、真的落进项目组、档位真的落到会话）需要用户重启插件后复验 —— 本通道给出的证据是宿主 API 的返回值与读回，不是肉眼观测。',
    ].join('\n')
    this.audit(spec, 'channel:dispatched', { sessionId, workspaceId: group.workspaceId, preset, permission: permission.value, model: model.value, evidence: modeEvidence === null ? null : { mode: modeEvidence.kind, permission: permission.evidence?.kind ?? null, model: model.evidence?.kind ?? null, reasoning: model.reasoningEvidence?.kind ?? null }, presetCheck: { checked: presetCheck.checked, ok: presetCheck.ok } })
    return {
      ok: true,
      agentId: sessionId,
      sessionId,
      token: token.token,
      via: SESSION_KIND,
      workspaceId: group.workspaceId,
      preset,
      brief,
      group,
      binding,
      slots: { permission, mode: slots.mode, model, reasoning: slots.reasoning },
      /**
       * ★ F11：四槽各自的结构化证据，**原样往上传**（`lib/tools/dispatch.js` 会把它落进
       * `roster.slots_effective[key].evidence`）。这里不做二次解释 —— 谁渲染谁负责说清楚。
       */
      slotEvidence: {
        mode: modeEvidence?.kind ?? null,
        permission: permission.evidence?.kind ?? null,
        model: model.evidence?.kind ?? null,
        reasoning: model.reasoningEvidence?.kind ?? null,
      },
      presetCheck: { checked: presetCheck.checked, ok: presetCheck.ok, ids: presetCheck.ids, defaultId: presetCheck.defaultId, why: presetCheck.why },
      note,
    }
  }

  /** 给一个已派会话投消息（续派活 / 催办）。 */
  async notifyRole(spec) {
    const ctx = this.deps.ctx
    const controller = readService(ctx, 'sessionController')
    if (!hasMethods(controller, ['prompt'])) return { ok: false, messageId: null, note: 'ctx.sessionController.prompt 不可用，无法投递。' }
    const sessionId = typeof spec?.sessionId === 'string' && spec.sessionId.length > 0
      ? spec.sessionId
      : (typeof spec?.agentId === 'string' && spec.agentId.length > 0 ? spec.agentId : '')
    if (sessionId.length === 0) return { ok: false, messageId: null, note: '没有目标会话（sessionId / agentId 都是空的）。' }
    const requestId = `${SESSION_KIND}-msg-${Date.now().toString(36)}`
    try {
      await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: String(spec.message ?? '') }] }, spec?.signal ?? NEVER_ABORTED_SIGNAL)
      return { ok: true, messageId: requestId, sessionId, note: `已投递到会话 ${sessionId}（requestId=${requestId}，mode=queue）。` }
    } catch (err) {
      return { ok: false, messageId: null, sessionId, note: `投递失败：${String(err?.message ?? err)}` }
    }
  }
}

/**
 * **不可达通道**：真实会话通道缺件时的形态。
 *
 * ★ 它存在的唯一理由就是「不许静默降级」：拿不到真实会话通道时，本插件
 * **不**自动退回子代理，而是每次派活都返回同一份「不可达 + 证据 + 降级方案」，
 * 由用户裁定后再改配置。
 */
export class UnreachableTransport {
  constructor(deps, probe) {
    this.kind = 'unreachable'
    this.deps = deps
    this.initialProbe = probe ?? null
  }

  available() {
    return false
  }

  probeNow() {
    return probeSessionChannel(this.deps?.ctx)
  }

  async spawnRole(spec) {
    const probe = this.probeNow()
    // ★ **启动竞态修复（2026-10-11 事故的根因）**：本通道是 `createTransport` 在
    //    **插件 apply 那一刻**做出的判决，而那时别的插件可能还没 provide
    //    `sessionController` / `workspaceRegistry` / `permissionPresets` —— 探测必然失败，
    //    判决于是被**永久**钉成「不可达」，重启一次就再也派不出人。
    //
    //    现场证据（`.pipeline/T-20261011-214043/audit.jsonl`）：两次 `channel:unreachable`
    //    的 `missing` 与 `absent` **都是空数组** —— 派活那一刻通道其实是通的，
    //    只是被**过期判决**挡在门外（报文里那句"缺 ："就是这么来的）。
    //
    //    所以这里按**当场重探**的结果走：真通了就交给真通道。
    //    ★ 仍然**不静默降级**：真不通时下面照旧如实上报 + 落审计 + 交人工裁定。
    if (probe.ok === true) return new SessionTransport(this.deps).spawnRole(spec)
    const report = renderUnreachableReport(probe, spec)
    const fn = this.deps?.audit
    if (typeof fn === 'function') {
      try {
        fn({ taskId: String(spec?.task?.id ?? ''), action: 'channel:unreachable', detail: { role: spec?.role ?? null, seat: spec?.seat ?? null, missing: probe.missing, absent: probe.absent } })
      } catch {
        /* 留痕失败不影响"拒绝"这个判决本身 */
      }
    }
    return { ok: false, agentId: null, sessionId: null, token: null, via: 'unreachable', unreachable: true, probe, report, note: report, escalate: 'human' }
  }

  /**
   * ★★ **叫不醒席位的真根因就在这里**（A6 / A7 的落点，本轮修复）。
   *
   * 现场：需求分析连答三条澄清（`clarify:reply` ×3），**等着的编写席一直没被叫醒**；
   * 用户答复人工介入请求之后，机制如实报了「**叫不醒发起席位**」并给了两条等价路径
   * —— 那条"如实上报"是**对的**（不许伪造送达），但它的**原因**报错了：
   * 报文写的是「真实会话通道不可达」，而**同一时刻席位的派活走的就是这条通道**
   * （`spawnRole` 每次当场重探，探通了就交给真通道）。
   *
   * 也就是说：本类是 `createTransport` 在插件 `apply` 那一刻做出的**过期判决**
   * （那时别的插件可能还没 provide `sessionController`），`spawnRole` 早就按
   * 当场重探修掉了，而 `notifyRole` **一直没有** —— 于是"派得出去、叫不回来"：
   * 席位被派活了（走重探后的真通道），却永远收不到裁定/答复（走这条永远失败的旧判决）。
   *
   * 修法：**与 `spawnRole` 同一条判据 —— 当场重探**。真通就交给真通道投递；
   * 真不通时**照旧如实上报 + 不做近似替代**（B8 的"看得见的失败"一个字没改）。
   */
  async notifyRole(spec) {
    const probe = this.probeNow()
    if (probe.ok === true) return new SessionTransport(this.deps).notifyRole(spec)
    return {
      ok: false,
      messageId: null,
      note:
        `真实会话通道不可达，无法投递（目标 ${spec?.sessionId ?? spec?.agentId ?? '(未知)'}）。` +
        '★ 如实上报，不做近似替代。' +
        `（当场重探：缺 ${(probe.missing ?? []).join('、') || '(无)'}；不可用 ${(probe.absent ?? []).join('、') || '(无)'}）`,
    }
  }
}
/**
 * 按配置挑一个通道。这是**唯一**的选择点。
 *
 * @param {object} ctx
 * @param {object} config
 * @param {{tokens:any}} deps
 * @returns {ManualTransport|SubagentTransport}
 */
export function createTransport(ctx, config, deps) {
  const mode = config === null || config === undefined ? 'auto' : config.transport ?? 'auto'
  const wired = { ctx, config, ...deps }
  if (mode === 'manual') return new ManualTransport(deps)
  if (mode === 'subagent') return new SubagentTransport(wired)
  if (mode === 'session') return new SessionTransport(wired)
  // auto：**先试真实会话通道**（需求1 点名要的形态），拿到就用它。
  const session = new SessionTransport(wired)
  if (session.available()) return session
  // ★ 拿不到就**只上报**，不静默降级 —— 静默退回子代理 = 拿近似物冒名。
  //   要保留旧行为必须**显式**配置：transport='subagent'，或 allowChannelFallback=true。
  if (config?.allowChannelFallback === true) {
    const t = new SubagentTransport(wired)
    if (t.available()) return t
  }
  return new UnreachableTransport(wired, session.probe())
}

/** 角色 id 是否是"需要被派出去"的执行角色。 */
export function isSpawnableRole(roleId) {
  return roleId !== ROLE.MAIN && ROLES[roleId] !== undefined
}
