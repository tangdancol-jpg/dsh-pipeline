/**
 * dsh-pipeline · **宿主面消息构造器（唯一出口）**
 * ============================================================================
 * 用户原话（这一条是事故后补的）：
 *   「**让每个工具 AI 知道自己要干什么，而不是去运行，然后被切断**」
 *
 * ---------------------------------------------------------------------------
 * 这个模块为什么存在：一次真实事故
 * ---------------------------------------------------------------------------
 * 2026-10-11 的复现链（父会话 turn 29 与子会话 `session-…` 各炸一次）：
 *
 *   1. 本插件在 `agent/pre-step` 里把席位简报塞进 `decision.messages`，用的是
 *      **裸对象** `{ role:'user', content: seatBriefing(...) }` —— **没有 `source`**，
 *      而且 `content` 是**字符串**（宿主惯例是 block 数组）；
 *   2. 宿主 `@deepseek-ai/dsh-session-reference` 的 `prepareDirectMessages`
 *      （`app.asar` @55346974，`{prepend:true}` 的 pre-step 监听器）会遍历
 *      `decision.messages` 并**无守卫地**读 `message.source.kind`
 *      （`if (message.source.kind !== "user") return [message];`）；
 *   3. ⇒ `TypeError: Cannot read properties of undefined (reading 'kind')`，
 *      整个 turn 以 `turn/end reason.kind="error"` 收尾。
 *
 * 子会话的症状是最贵的：`turn/start` 之后 **277 ms** 就死，没有 `step/start`、
 * 没有模型请求、没有工具调用 —— **席位一句话没说就没了**，任务静静停在
 * 「需求分析中」，机制自己不知道。
 *
 * ---------------------------------------------------------------------------
 * 判据（写死在这里，别在别处重新发明）
 * ---------------------------------------------------------------------------
 * 凡是**交给宿主**的消息，必须同时满足四条：
 *   ① `role` 是宿主认的四个之一；
 *   ② `content` 是 **block 数组**（`[{type:'text',text}]`），不是字符串；
 *   ③ `source` 是**对象**且带 `kind` —— 宿主多个内建监听器（session-reference /
 *      repeat-tool-reminder / 插件自己的 dsh-orb）都直接读 `message.source.kind`。
 *   ④ `id` 是**非空字符串** —— 会话 v4 落盘校验的准入条件，缺了它**整个会话再也读不回来**。
 *
 * ---------------------------------------------------------------------------
 * ★★ 第二次事故（2026-10-11 晚）：`id` 缺失 ⇒ 会话永久损坏
 * ---------------------------------------------------------------------------
 * 判据来自 `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` 的
 * `assertMessageEventShape()`（同一函数也被 `@deepseek-ai/dsh-session/lib/index.js`
 * 复用），它在**读盘**时对每条消息事件跑：
 *
 * ```js
 * const message = type === "user/message" ? record : record?.["message"];
 * if (typeof message !== "object" || message === null ||
 *     typeof message["id"] !== "string" || message["id"] === "")
 *   throw new Error(`${subject} lacks an identified message`);   // subject = session event at seq N
 * ```
 *
 * `user/message` 的 `data` **本身就是消息对象**（没有外层 `message` 字段），
 * 所以 `data.id` 必须存在。而本模块原先返回 `{ role, content, source }` —— 没有 `id`。
 * 后果不是当轮报错，而是**那条事件已经写进日志**，之后每次打开这个会话都
 * `历史加载失败: … failed validation: Error: session event at seq 1400 lacks an identified message`
 * —— 会话从此打不开，且坏行永久留在盘上。
 *
 * ★ **一处都不能漏**：所有注入点都必须走 {@link hostMessage}，
 *   且必须登记在 {@link HOST_INJECTION_SITES} 里 —— 自测按这张表逐一核对形状
 *   （见 `tests/liveness-check.mjs` 的「注入形状」用例组）。
 *
 * @module dsh-pipeline/lib/hostmsg
 */

import { randomUUID } from 'node:crypto'

/**
 * ★★ 本插件在宿主消息 `source` 上的**生产者自有 kind**。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须是 `plugin:dsh-pipeline`，而不是裸的 `'plugin'`（2026-10-11 事故）
 * ---------------------------------------------------------------------------
 * 会话格式 v4 **退役**了「裸 `kind:'plugin'` + 并列 `plugin` 字段」这一对写法。
 * DSH 的 v4 准入判据是（`@deepseek-ai/dsh-session-format-v3-to-v4` 的
 * `lib/types/message-sources.ts`，同一份被打包进
 * `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs`）：
 *
 * ```js
 * function source(message) {
 *   const value = message["source"];
 *   if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
 *       || value["kind"].length === 0 || value["kind"] === "plugin")
 *     throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 * }
 * ```
 *
 * 而 `releasedV4SessionFormatCodec.encodeEvent()` →
 * `assertV4RowAdmission()` → `assertV4SourceRowAdmission()` 会在**写盘之前**
 * 对 `user/message` 跑一遍。所以传裸 `'plugin'` 的后果是**整个落盘被拒**：
 * 表现是会话「本轮运行失败 / 处理失败」，而且因为坏行**根本没写进去**，
 * 盘上查不到任何痕迹（实测：49 个会话、49455 行，0 行含 `"kind":"plugin"`）。
 *
 * 正确形态来自 DSH 自己的迁移推导 —— 未知插件 ⇒ `` `plugin:${plugin}` ``。
 * 同机邻居插件 `dsh-better-sidebar` 也已改成 `plugin:dsh-better-sidebar`。
 *
 * ⚠️ **别再改回 `'plugin'`。** `tests/liveness-check.mjs` 的「A 注入形状」用例组
 * 有 A2b/A2c 两条断言钉着这件事（形状必须过 `assertHostMessage`，且必须过
 * DSH **真实**的 `assertV4MessageSources` 反例校验）。
 */
export const HOST_SOURCE_KIND = 'plugin:dsh-pipeline'

/**
 * 本插件名。
 *
 * ⚠️ **不要再把它写进 `source`** —— v4 把生产者身份放进 `kind` 里，
 * 不再有并列的 `plugin` 字段（DSH 的 v3→v4 迁移 `rewritePluginSource`
 * 动作就是把这个键删掉）。这里保留常量供日志 / 审计 / 分流域引用。
 */
export const HOST_PLUGIN_NAME = 'dsh-pipeline'

/** 生产者自有 kind 的前缀。第三方插件的规范形态是 `plugin:<插件名>`。 */
export const PRODUCER_KIND_PREFIX = 'plugin:'

/**
 * ★★ **`runtime-context`** —— 本插件往**别人的会话**（主对话）投递"运行时上下文"时
 * 用的 `source.kind`（2026-10-11「交付即唤醒」补的）。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须是这一个值（而不是 `plugin:dsh-pipeline`、更不是裸 `user`）
 * ---------------------------------------------------------------------------
 * ① 它是 DSH **原生**的 producer-owned kind（在 {@link NATIVE_SOURCE_KINDS} 里），
 *    语义就是"**这条不是人说的，是运行时塞进来的上下文**"。
 *    主对话据此把唤醒消息当**机制状态**读，而不是当用户指令读。
 * ② `plugin:dsh-pipeline` 是**本插件自己会话里**的内部注入用的；投进**主对话**时
 *    要的是"这是运行时上下文"这一层语义，不是"哪个插件写的"。
 * ③ **绝不伪装成用户消息**：`prompt()` 那条路宿主会**硬写**
 *    `source = { kind: 'user', rpcId }`（见下），那正是本条要避开的东西。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么不能靠 `sessionController.prompt()` 来拿这个 kind（已核实，别猜）
 * ---------------------------------------------------------------------------
 * 宿主的 `prompt()` 实现（`@deepseek-ai/dsh-api-session-controller`，app.asar）是：
 *
 * ```js
 * async prompt(request) {
 *   if (!hasPromptContent(request.content)) throw new RemoteError('gateway/bad-request', …)
 *   const agent = await this.resolveAgent(request.sessionId)
 *   if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
 *   const source = { kind: 'user', rpcId: request.requestId, … }   // ★ 硬编码 kind='user'
 *   const message = createUserMessage({ content: …, source })
 *   if (request.mode === 'steer') agent.steer(message)
 *   else agent.followup(message)
 * }
 * ```
 * 而它的入参类型是（`dsh-api-session-controller/types`，逐字抄来）：
 *
 * ```ts
 * export interface SessionPromptRequest {
 *     readonly requestId: SessionRequestId;
 *     readonly sessionId: SessionId;
 *     readonly mode: 'queue' | 'steer';
 *     readonly content: readonly PromptContentPart[];
 *     readonly clientTimeZone?: string;
 * }
 * ```
 * ——**根本没有 `source` 字段**。所以走 `prompt()` 投出去的每一条都**只能是**
 * `kind:'user'`：那正是"伪装成用户消息"。本插件的做法是走**同一条内部通道**
 * （`prompt()` 自己调的就是 `agent.followup(message)`）而**把 source 留在自己手上**，
 * 见 `lib/wakeup.js` 的 `deliver()`：（a）`agents.get(sessionId).followup(hostMessage(...))`
 * 保住 source；（b）`agents` 拿不到时才退回 `prompt()`，并在 audit 里如实标
 * `source_preserved:false` —— **不假装两条路一样**。
 */
export const RUNTIME_CONTEXT_KIND = 'runtime-context'

/**
 * ★ **DSH 原生**的 producer-owned kind 白名单（本插件不产出，但校验器认得）。
 *
 * 用途只有一个：让 {@link assertHostMessage} 的判据是"**属于已知生产者**"，
 * 而不是"碰巧不等于 `plugin`" —— 后者挡不住下一个被退役的值。
 *
 * 名单来源：DSH v3→v4 迁移表里的 `RELEASED_SAME_NAME_PRODUCERS` +
 * `RENAMED_PRODUCERS`，以及本机会话文件里**实测出现**的 kind。
 */
export const NATIVE_SOURCE_KINDS = [
  // DSH 原生（迁移表里的同名生产者）
  'user',
  'tool',
  'tool-registry',
  'provider',
  'model',
  'fallback',
  'agent-instructions',
  'session-reference',
  'team-message',
  'goal',
  'skill-invocation',
  'skill-catalog',
  'coordinator',
  'subagent-report',
  'subagent-settled',
  'webhook',
  'agent-message',
  'model-selection',
  'plan-mode',
  'time-context',
  'tmux-context',
  'user-approval',
  'repeat-tool-reminder',
  'tool-cordis',
  'cordis-host-runner',
  'tool-goal',
  'tool-jobs',
  'hooks-codex',
  'hooks-claude-code',
  'schedule',
  'dsh-session-title-llm',
  'computer-use',
  // 迁移表里被**改名**的那些（旧值 ⇒ 新值）
  'compact-checkpoint',
  'ptc-mode',
  'compact-basic',
  'runtime-context',
  'system-prompt',
]

/**
 * ★ `kind` 是否是**生产者自有**的（会话格式 v4 的准入要求）。
 *
 * 判据两条，满足其一即可：
 *   ① 以 `plugin:` 开头（第三方插件的规范形态）；
 *   ② 属于 {@link NATIVE_SOURCE_KINDS}（DSH 原生生产者）。
 *
 * ★ 明确**排除**裸的 `'plugin'` —— 那是已退役的 V3 包装形态，
 *   v4 的 `source()` 会直接抛 `SessionFormatError`。
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isProducerOwnedKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return false
  if (kind === 'plugin') return false
  if (kind.startsWith(PRODUCER_KIND_PREFIX)) return true
  return NATIVE_SOURCE_KINDS.includes(kind)
}

/**
 * ★ **本插件全部的宿主注入点**（可审计清单）。
 *
 * 这张表是"防漏"的判据：自测会拿它去核对"表里每一处都真的产出了宿主形状"。
 * 新增注入点时**必须先加一行**，否则就是又一处会炸的裸消息。
 *
 * 字段：
 *   · `id`    稳定标识
 *   · `where` 文件 · 缝
 *   · `field` 注入到宿主的哪个字段
 *   · `form`  写进 `source.form` 的值（同一来源的多种用途靠它区分）
 *   · `via`   构造方式：`hostMessage` = 走本模块；`content-blocks` = 只交内容块，由宿主自己包消息
 */
export const HOST_INJECTION_SITES = [
  {
    id: 'pre-step-seat-briefing',
    where: 'lib/intercept.js · agent/pre-step',
    field: 'decision.messages[]',
    form: 'seat-briefing',
    via: 'hostMessage',
    why: '席位开场注入：边界卡 + Stop Ladder 四问（★ 就是这一处曾经炸掉子会话）',
  },
  {
    id: 'pre-step-stale-seat-notice',
    where: 'lib/intercept.js · agent/pre-step',
    field: 'decision.messages[]',
    form: 'stale-seat-notice',
    via: 'hostMessage',
    why: '★ 失联席位提示：只发给控制角色（主对话 / 需求分析 / 计划），一次性',
  },
  {
    id: 'spawn-brief-prompt',
    where: 'lib/transport/index.js · subagents.startContinuable / start',
    field: 'request.prompt[]',
    form: 'content-blocks',
    via: 'content-blocks',
    why: '派活单：交的是**内容块**，消息由宿主自己包（宿主补 source）',
  },
  {
    id: 'notify-role-sendMessage',
    where: 'lib/transport/index.js · subagents.sendMessage',
    field: 'content blocks',
    form: 'content-blocks',
    via: 'content-blocks',
    why: '席位间通知：同上，交内容块',
  },
  {
    id: 'post-execute-block-feedback',
    where: 'lib/intercept.js · tools/post-execute',
    field: 'decision.feedback[]',
    form: 'feedback',
    via: 'content-blocks',
    why: '工具结果拦截的纠正反馈：交的是 `feedback` 内容块，**不是消息**（宿主不读它的 source）',
  },
  {
    id: 'wake-main-session',
    where: 'lib/wakeup.js · deliver()（触发点见 lib/intercept.js · tools/post-execute）',
    field: '目标会话的 inbox（agent.followup(message)）',
    form: 'wake-main',
    via: 'hostMessage',
    why:
      '★ **交付即唤醒主对话**：席位交付 / 状态推进 / 席位失联时，把一条**可操作**的消息' +
      '投进主对话所在会话，把它叫醒（不再靠人问或轮询）。' +
      `★ source.kind = ${RUNTIME_CONTEXT_KIND}（**不是** user）——不伪装成用户消息；` +
      '注入点表的这条由 tests/wake-check.mjs 的「注入形状」用例组按表核对。',
  },
]

/**
 * ★ 造一条**宿主形状**的用户消息。
 *
 * @param {object} spec
 * @param {string} spec.text - 正文（会被包成一个 text block）
 * @param {string} spec.form - 用途（写进 `source.form`）
 * @param {string} [spec.kind] - `source.kind`。缺省 = {@link HOST_SOURCE_KIND}
 *   （本插件自己会话里的内部注入）；往**主对话**投"运行时上下文"时传
 *   {@link RUNTIME_CONTEXT_KIND}。★ 取值必须过 {@link isProducerOwnedKind}，
 *   否则**当场抛** —— 裸 `'plugin'` 那种已退役形态不许从这里溜出去。
 * @param {string} [spec.taskId]
 * @param {string} [spec.role] - 目标角色（收件人视角）
 * @param {string|null} [spec.seat]
 * @param {object|null} [spec.extra] - 附加到 source 上的字段（可为空）
 * @param {string} [spec.id] - 显式指定消息 id（默认自动生成一枚 UUID）
 * @returns {{id:string, role:'user', content:Array<{type:'text',text:string}>, source:object}}
 */
export function hostMessage(spec) {
  const s = spec !== null && typeof spec === 'object' ? spec : {}
  // ★ 判据 ④：消息 id 必须是非空字符串。会话 v4 读盘时逐条校验
  //   （worker.cjs assertMessageEventShape），缺了它整条会话就再也读不回来。
  //   这里**每次调用都新铸一枚** UUID：同一条简报重复注入也必须是不同的消息，
  //   复用 id 会让会话投影把两条事件当成同一条。
  //   ⚠️ 例外：唤醒消息**故意**传显式 id（幂等键的确定性派生）—— 见 lib/wakeup.js，
  //      那是"同一次交付只注入一次"的判据，不是踩这条坑。
  const id = typeof s.id === 'string' && s.id.length > 0 ? s.id : randomUUID()
  // ★ 生产者自有 kind：缺省是本插件自己（`plugin:dsh-pipeline`）；唤醒主对话时
  //   显式传 `runtime-context`（**运行时上下文**语义，见 RUNTIME_CONTEXT_KIND）。
  const kind = typeof s.kind === 'string' && s.kind.length > 0 ? s.kind : HOST_SOURCE_KIND
  if (!isProducerOwnedKind(kind)) {
    throw new Error(
      `hostMessage: source.kind ${JSON.stringify(kind)} 不是生产者自有的 kind —— 会话格式 v4 会拒收它，` +
        `整个 turn 的落盘会被拒。合法值：以 ${JSON.stringify(PRODUCER_KIND_PREFIX)} 开头，或落在 NATIVE_SOURCE_KINDS 名单内。`,
    )
  }
  const source = {
    // ★ 生产者自有 kind（`plugin:dsh-pipeline`）—— 身份就在 kind 里，
    //   所以**没有**并列的 `plugin` 字段（v4 已退役那一对写法，见文件头）。
    kind,
    form: typeof s.form === 'string' && s.form.length > 0 ? s.form : 'note',
  }
  // `plugin` 只作为**审计元数据**保留在 `extra` 之外不写；若将来确需带，
  // 请走 `source.extra = { plugin: HOST_PLUGIN_NAME }`，不要恢复顶层 `plugin` 键。
  if (typeof s.taskId === 'string' && s.taskId.length > 0) source.task_id = s.taskId
  if (typeof s.role === 'string' && s.role.length > 0) source.role = s.role
  if (typeof s.seat === 'string' && s.seat.length > 0) source.seat = s.seat
  if (s.extra !== null && s.extra !== undefined && typeof s.extra === 'object') source.extra = s.extra

  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: String(s.text ?? '') }],
    source,
  }
}

/**
 * 校验一条"要给宿主"的消息是否符合宿主期望。
 *
 * 为什么是**返回违规清单**而不是抛异常：它要被自测当判据用，
 * 也要能被生产代码"先查再交"而不引入新的失败面。
 *
 * @param {unknown} message
 * @param {object} [opts]
 * @param {string} [opts.path] - 违规文案里的定位前缀
 * @param {boolean} [opts.needSource] - 是否要求 `source`（默认 true）
 * @returns {string[]} 违规清单；空数组 = 合规
 */
export function assertHostMessage(message, opts = {}) {
  const path = typeof opts.path === 'string' && opts.path.length > 0 ? opts.path : 'message'
  const needSource = opts.needSource !== false
  const v = []

  if (message === null || message === undefined) return [`${path} 是 undefined/null —— 宿主读它的字段会抛异常`]
  if (typeof message !== 'object' || Array.isArray(message)) return [`${path} 不是对象（实际是 ${Array.isArray(message) ? 'array' : typeof message}）`]

  // ★ 判据 ④（2026-10-11 第二次事故补的）：缺 id 的消息**能写进盘**，
  //   但**再也读不出来** —— 校验发生在读盘路径上，症状是会话永久打不开
  //   （`session event at seq N lacks an identified message`），而且坏行留在日志里。
  //   这把检查必须在这里，因为自测拿本函数当判据；漏了它 = 判据本身有洞。
  const id = message.id
  if (typeof id !== 'string' || id.length === 0) {
    v.push(
      `${path}.id 缺失或不是非空字符串：${JSON.stringify(id)}。\n` +
        '    会话 v4 读盘校验（`@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` ' +
        '的 `assertMessageEventShape()`，同函数也被 `@deepseek-ai/dsh-session/lib/index.js` 复用）要求每条\n' +
        '    `user/message` / `assistant/message` / `tool/result` / `system/message` / `developer/message`\n' +
        '    消息都带非空字符串 `id`；`user/message` 的 `data` **本身就是消息对象**（没有外层 `message` 字段）。\n' +
        '    缺它的后果不是当轮报错，而是该事件已落盘 ⇒ 以后每次打开这个会话都\n' +
        '    `历史加载失败: … session event at seq N lacks an identified message`。\n' +
        `    ★ 用 \`hostMessage()\` 构造即可自动带上 id（或显式传 \`{ id }\`）。`,
    )
  }

  const role = message.role
  if (typeof role !== 'string' || !['user', 'assistant', 'system', 'tool'].includes(role)) {
    v.push(`${path}.role 非法：${JSON.stringify(role)}`)
  }

  const content = message.content
  if (typeof content === 'string') {
    v.push(`${path}.content 是**字符串** —— 宿主期望 block 数组（用 hostMessage() 包成 [{type:'text',text}]）`)
  } else if (!Array.isArray(content)) {
    v.push(`${path}.content 既不是字符串也不是数组：${typeof content}`)
  } else {
    content.forEach((block, i) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        v.push(`${path}.content[${i}] 不是对象`)
      } else if (typeof block.type !== 'string' || block.type.length === 0) {
        v.push(`${path}.content[${i}].type 缺失或非字符串`)
      }
    })
  }

  if (needSource) {
    const src = message.source
    if (src === undefined || src === null) {
      v.push(
        `${path}.source **缺失** —— 宿主 agent/pre-step 下游会无守卫地读 message.source.kind` +
          '（@deepseek-ai/dsh-session-reference#prepareDirectMessages，app.asar @55346974），' +
          '会抛 TypeError: Cannot read properties of undefined (reading \'kind\')',
      )
    } else if (typeof src !== 'object' || Array.isArray(src)) {
      v.push(`${path}.source 不是对象：${Array.isArray(src) ? 'array' : typeof src}`)
    } else if (typeof src.kind !== 'string' || src.kind.length === 0) {
      v.push(`${path}.source.kind 缺失或非字符串 —— 宿主靠它分流`)
    } else if (!isProducerOwnedKind(src.kind)) {
      // ★★ 防回归的第二道（2026-10-11）：原来这里只查"kind 是非空字符串"，
      //    于是裸的 `'plugin'` **能通过** —— 而它正是会话格式 v4 明确拒收的值，
      //    后果是整条消息落盘被拒、会话「处理失败」。判据必须查**取值**，不能只查类型。
      v.push(
        `${path}.source.kind 不是**生产者自有**的 kind：${JSON.stringify(src.kind)}。\n` +
          `    会话格式 v4 只接受「以 \`${PRODUCER_KIND_PREFIX}\` 开头」或「\`NATIVE_SOURCE_KINDS\` 名单内」的 kind。\n` +
          '    ★ 裸的 `\'plugin\'` 是**已退役的 V3 包装形态**：`@deepseek-ai/dsh-session-format-v3-to-v4` ' +
          '的 `source()` 会对它抛 SessionFormatError("format v4 message requires a producer-owned source kind")，' +
          '而这发生在**写盘之前** ⇒ 整个 turn 落盘被拒。\n' +
          `    第三方的规范形态是 \`${PRODUCER_KIND_PREFIX}<插件名>\`（本插件 = ${JSON.stringify(HOST_SOURCE_KIND)}）。`,
      )
    }
  }

  return v
}

/**
 * 批量校验一组消息（`decision.messages` / `additionalContexts` 那种数组）。
 *
 * ★ 留的**故意不是异常**：调用方可以选择"报出来"或"不静默"，
 *   而这个模块不做决定 —— 它是判据，不是执法点。
 *
 * @param {unknown} messages
 * @param {string} [label]
 * @returns {string[]}
 */
export function assertHostMessages(messages, label = 'messages') {
  if (!Array.isArray(messages)) return [`${label} 不是数组：${typeof messages}`]
  const out = []
  messages.forEach((m, i) => out.push(...assertHostMessage(m, { path: `${label}[${i}]` })))
  return out
}
