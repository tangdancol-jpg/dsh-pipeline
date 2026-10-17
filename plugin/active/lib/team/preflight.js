/**
 * dsh-pipeline · Agent Teams 通道 · **能力探测 + 官方硬约束**
 * ============================================================================
 * 官方 Agent Teams 服务名是 `agentTeams`（`class TeamService extends Service` →
 * `super(ctx,'agentTeams')`）。本插件**不许**把它写进 `PLUGIN_INJECT`
 * （`lib/host-surface.js:54` 精确等于 `['tools','sessionProjections']`，且
 * `tests/load-smoke.mjs:204` 把这条写成"改动必红"的断言）⇒ 一律 `ctx.get('agentTeams')`。
 *
 * 本模块收拢**关于这条通道的一切事实**，让 `lib/transport/team.js` 只剩接线：
 *   · 服务探测（缺件只上报，不在这里做降级决定）；
 *   · 官方硬上限（`maxMessageBytes` 65536 / `maxMembers`）；
 *   · `TeamError` 失败码 → 可读报告（含"出路"，不许只说"失败了"）；
 *   · caller 判据（**活着的 Lead Agent**，事实 F3）与候选解析。
 *
 * 两条纪律（与既有 `probeSessionChannel` 同源）：
 *   · `readService` 绝不直读 `ctx.xxx`：cordis 对没写进 inject 的服务名会**抛**，
 *     而那一抛发生在 apply 里，表现是「插件完全没加载」（`transport/index.js:459-478` 的事故记录）；
 *   · 缺件**只上报**，不在这里做任何降级决定 —— 静默降级 = 拿近似物冒名。
 *
 * @module dsh-pipeline/lib/team/preflight
 */

/** 本通道的 kind 常量（与 `SESSION_KIND` 同一套写法）。 */
export const TEAM_KIND = 'team'

/** 官方服务的**必需**方法集：派活 / 投递 / 名单。缺一 → 通道不可达。 */
export const TEAM_REQUIRED = Object.freeze(['spawnTeammate', 'sendMessage', 'listMembers'])

/** 可选方法集：缺了照常派活，但某条能力如实降级（不是故障）。 */
export const TEAM_OPTIONAL = Object.freeze(['interrupt', 'membership', 'tryMembership', 'waitForChange', 'createTask', 'getTask', 'listTasks', 'updateTask'])

/** 官方 `sendMessage` 的正文上限（`_tmp/teamservice.txt:117,292`；默认 65536 字节）。 */
export const TEAM_MAX_MESSAGE_BYTES = 65536

/** 给"Team message from <name>:"前缀与 JSON 转义留的余量。 */
export const MESSAGE_HEADROOM = 1024

/** 官方默认 `maxMembers`（`_tmp/teamservice.txt:1420`；本机 agent-team profile 配成 8）。 */
export const TEAM_DEFAULT_MAX_MEMBERS = 16

const errText = (err) => String(err?.message ?? err)

/**
 * 读宿主服务：**一律 `ctx.get()`**（拿不到返回 undefined，不抛），绝不直读属性。
 * ★ 与 `lib/transport/index.js` 的 `readService` 同一判据 —— 那份没有 export，
 *   所以本文件是 team 侧的**唯一出处**（`lib/transport/team.js` 从这里取，不另抄一份）。
 */
export function readService(ctx, name) {
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
export function hasMethods(target, names) {
  if (target === null || target === undefined) return false
  return names.every((n) => typeof target[n] === 'function')
}

/** 拿 `ctx.get('agentTeams')`（拿不到就 undefined，不抛）。 */
export function getAgentTeams(ctx) {
  return readService(ctx, 'agentTeams')
}

/**
 * 探测 Team 通道是否可达。
 *
 * @param {object} ctx
 * @returns {{ok:boolean, kind:string, checks:Array<object>, missing:string[], absent:string[], evidence:string[], note:string}}
 */
export function probeTeamChannel(ctx) {
  const svc = getAgentTeams(ctx)
  const missing = TEAM_REQUIRED.filter((m) => typeof svc?.[m] !== 'function')
  const absent = TEAM_OPTIONAL.filter((m) => typeof svc?.[m] !== 'function')
  const checks = [
    {
      name: 'agentTeams',
      need: [...TEAM_REQUIRED],
      required: true,
      why: '官方 Agent Teams 服务：spawnTeammate 派活 / sendMessage 投递 / listMembers 查名单',
      present: missing.length === 0,
      evidence:
        `ctx.get('agentTeams') → ${svc === undefined ? '不存在' : '存在'}（需要 ${TEAM_REQUIRED.join(' / ')}；` +
        `缺 ${missing.length === 0 ? '无' : missing.join('、')}）`,
    },
  ]
  const ok = missing.length === 0
  return {
    ok,
    kind: TEAM_KIND,
    checks,
    missing,
    absent,
    evidence: checks.map((c) => c.evidence),
    note: ok
      ? `Agent Teams 通道可用（可选能力缺：${absent.length === 0 ? '无' : absent.join('、')}）。`
      : `Agent Teams 通道不可达：ctx.get('agentTeams') 缺 ${missing.join('、')}。★ 官方 Team 服务要么没装、要么被 profile 关掉了 —— 按「只上报、不静默降级」停住，请改用 transport:'session' 或人工复制，不要猜。`,
  }
}

/**
 * 按 **UTF-8 字节**截断正文，追加如实标注（01 §D7：宁可截断并说明，也不静默丢内容）。
 * @param {string} text
 * @param {number} maxBytes 含标注的总预算
 * @returns {{text:string, truncated:boolean, bytes:number, originalBytes:number}}
 */
export function truncateUtf8(text, maxBytes = TEAM_MAX_MESSAGE_BYTES) {
  const s = String(text ?? '')
  const originalBytes = Buffer.byteLength(s, 'utf8')
  if (originalBytes <= maxBytes) return { text: s, truncated: false, bytes: originalBytes, originalBytes }
  const tail = '…（已截断：官方 sendMessage 上限 65536 字节）'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(tail, 'utf8'))
  let out = ''
  let used = 0
  // 按**码点**迭代：绝不切开代理对（emoji / 增补平面字符）。
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > budget) break
    out += ch
    used += b
  }
  return { text: out + tail, truncated: true, bytes: used + Buffer.byteLength(tail, 'utf8'), originalBytes }
}

/** 官方的 TeamError code → 人话（每一条都要给出路，不能只说"失败了"）。 */
const TEAM_ERROR_GUIDE = {
  TEAM_MEMBER_LIMIT: {
    title: 'Team 成员数到顶（TEAM_MEMBER_LIMIT）',
    why: '官方 Team 成员**只增不减**（没有 remove API），名字也永不回收 ⇒ 到顶之后同一条 lead 会话再也派不出新席位。',
    next: [
      `把 profile 的 \`agent-team\` 行调大 \`maxMembers\`（默认 ${TEAM_DEFAULT_MAX_MEMBERS}，本机 agent-team profile 配的是 8；★ 服务端**不暴露运行值**，本插件读不回来，只能按 profile 文件判）`,
      '或**新开一个主对话会话**（= 新 Team，名单从空开始）',
    ],
  },
  TEAM_MEMBER_NAME_TAKEN: {
    title: '名字在这个 Team 里已被用过（TEAM_MEMBER_NAME_TAKEN）',
    why: '官方名字**同 Team 内永久唯一、永不重用**（失败成员也占名）⇒ 复用旧名必然被拒。',
    next: ['重派请传 `reassign:true`（本通道会追加 `-r2`、`-r3` 生成新名字）', '任务 id 编在名字里 —— 换任务就是换名字'],
  },
  TEAM_LEAD_REQUIRED: {
    title: '只有 Team Lead 能做这件事（TEAM_LEAD_REQUIRED）',
    why: '官方 `spawnTeammate` / `interrupt` 只允许 Lead 调用（事实 F7）。',
    next: ['确认 caller 是**当前主对话会话**本身（不是它的子会话 / 不是已结束的旧会话）'],
  },
  TEAM_NOT_MEMBER: {
    title: 'caller 不是这个 Team 的活成员（TEAM_NOT_MEMBER）',
    why: '官方判据是 `ctx.agents.get(agent.id) === agent`：过期引用、拷贝对象、已结束会话都不算。',
    next: ['由主对话**当场**重新发起这次派活（`exec.agent` 是唯一合法的 caller 来源）', '机制发起的补派请改走 `transport:"session"`'],
  },
  TEAM_INVALID_MEMBER_NAME: {
    title: 'teammate 名字不合法（TEAM_INVALID_MEMBER_NAME）',
    why: '官方要求 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、≤64、≠`lead`。',
    next: ['这是**机制侧命名 bug**：请把本报告连同 `task_id` / `role` / `seat` 交给 Lead（命名规则在 `lib/team/naming.js`）'],
  },
  TEAM_MESSAGE_TOO_LARGE: {
    title: '消息超过官方上限（TEAM_MESSAGE_TOO_LARGE）',
    why: `官方上限 ${TEAM_MAX_MESSAGE_BYTES} 字节（按「前缀 + content」的 JSON UTF-8 计）。`,
    next: ['本通道投递前已按字节截断并标注 —— 若仍触发，说明还有别的路径在直投；请把这条报告交给 Lead'],
  },
}

/**
 * TeamError → 可读报告（含 `code` / `report` / `escalate`）。
 * 官方 spawn 失败时**也可能抛 AggregateError**（`_tmp/teamservice.txt:1044-1071`），这里一并拆开。
 * @param {any} err
 * @param {{action?:string, role?:string, seat?:string|null, taskId?:string, members?:number|null}} [info]
 */
export function describeTeamError(err, info = {}) {
  const errors = Array.isArray(err?.errors) ? err.errors : [err]
  const codes = errors.map((e) => (typeof e?.code === 'string' ? e.code : null)).filter((x) => x !== null)
  const code = codes.find((c) => Object.hasOwn(TEAM_ERROR_GUIDE, c)) ?? codes[0] ?? null
  const g = code === null ? null : TEAM_ERROR_GUIDE[code]
  const head = [
    `# ${info.action ?? 'Team 操作'}失败：${g?.title ?? '官方 Agent Teams 拒绝了这次调用'}`,
    '',
    `任务 ${info.taskId ?? '(未知)'} · 角色 ${info.role ?? '(未知)'}${info.seat ? ` · 席位 ${info.seat}` : ''}` +
      (code === null ? '' : `\n失败码：${code}${codes.length > 1 ? `（本次抛出 ${codes.join(' / ')}）` : ''}`) +
      (typeof info.members === 'number' ? `\n当前 Team 名单：${info.members} 人` : ''),
    '',
    '## 为什么',
    g?.why ?? '官方服务没有给出可归类的失败码。',
    '',
    '## 原始信息',
    ...errors.slice(0, 3).map((e) => `- ${errText(e)}`),
    '',
    '## 出路',
    ...(g?.next ?? ['请把这条报告交给 Lead（不要自己猜一个降级方案）']).map((x, i) => `${i + 1}. ${x}`),
    '',
    '★ 不静默降级：本插件不会因为 Team 通道失败就悄悄改用别的通道。',
  ]
  return { code, report: head.join('\n'), escalate: 'human' }
}

/** caller 必须是**活着的** Agent（官方判据 `ctx.agents.get(agent.id) === agent`，事实 F3）。 */
export function isLiveAgent(ctx, agent) {
  if (agent === null || agent === undefined || typeof agent.id !== 'string' || agent.id.length === 0) return false
  const agents = readService(ctx, 'agents')
  if (!hasMethods(agents, ['get'])) return false
  try {
    return agents.get(agent.id) === agent
  } catch {
    return false
  }
}

/**
 * 候选 caller。★ `notifyRole` 的入参里**没有 caller**（`nudgeSeat` 只给 sessionId），
 * 所以只能从"活 Agent"里挑 —— 再用 `listMembers` 反查谁的名下有这个会话（见 team.js）。
 * 顺序：`sender`（records.js 给的是 `exec.agent`）→ `parent`（spawn 给的）→ `agents.list()`。
 */
export function callerCandidates(ctx, spec) {
  const out = []
  const push = (a) => {
    if (a === null || typeof a !== 'object' || typeof a.id !== 'string' || a.id.length === 0) return
    if (!out.some((x) => x.id === a.id)) out.push(a)
  }
  push(spec?.sender)
  push(spec?.parent)
  const agents = readService(ctx, 'agents')
  try {
    const list = typeof agents?.list === 'function' ? agents.list() : typeof agents?.roots === 'function' ? agents.roots() : []
    for (const a of Array.isArray(list) ? list : []) push(a)
  } catch {
    /* 拿不到名单就只用显式给的那几个 */
  }
  return out.filter((a) => isLiveAgent(ctx, a))
}

/**
 * 「没有活 caller」的报告（01 §D4：机制派活在 Team 通道上走不通，**不静默降级**）。
 * @param {{taskId?:string, role?:string, seat?:string|null}} info
 */
export function renderNoLiveCallerReport(info = {}) {
  return [
    '# 拒绝派活：Team 通道需要**活着的 Lead Agent** 作 caller',
    '',
    `任务 ${info.taskId ?? '(未知)'} · 角色 ${info.role ?? '(未知)'}${info.seat ? ` · 席位 ${info.seat}` : ''}`,
    '',
    '官方 `spawnTeammate` 的授权凭据是"活的 Agent 对象"（`ctx.agents.get(agent.id) === agent`，事实 F3）——',
    '机制自己发起的补派（自愈 / 唤醒点补派）**没有**这样的 Agent 对象。',
    '',
    '## 出路',
    '1. 由主对话当场派活（`pipeline_dispatch` 的 `exec.agent` 是唯一合法来源）；',
    '2. 机制发起的补派改用 `transport:"session"`，或人工复制派活单。',
    '',
    '★ 不静默降级：本插件**不会**偷偷改用别的通道。',
  ].join('\n')
}
