/**
 * dsh-pipeline · 通道 · **team 通道（官方 Agent Teams 原语）**
 * ============================================================================
 * 第三条**真实派活**通道（前两条：`subagent` 子代理 / `session` 一等公民会话）。
 * 派活 = 官方 `spawnTeammate(caller, {name, description, prompt, context, provider, signal})`。
 * "投递半边"（sendMessage / interrupt / 名单反查）在 `lib/team/deliver.js`。
 *
 * ## 三条硬事实（`_tmp/teamservice.txt`），决定了本通道的形状
 *   1. `spawnTeammate` **没有** agentPreset / permission / model / reasoning 参数（`:1723-1751`）
 *      ⇒ `mode` 槽**下发不了**，人格只能写进派活单正文（`lib/team/brief.js`），
 *      补钉与如实交代在 `lib/team/slots.js`；
 *   2. teammate 是 `startActivation` 建出的**延续子会话**（`:1742-1751`）—— 既有 session 通道
 *      明文拒 `origin==='subagent'` 的会话（`./index.js:1107`），两条判据互斥；
 *   3. 授权凭据是**活着的 Lead Agent 对象**（`:860-903`，事实 F3）⇒ 机制发起的补派
 *      在这条通道上**必然失败**，只能如实报，不许静默降级（01 §D4）。
 *
 * ## 本文件只做接线，不复刻既有判据
 *   四槽归一 / 完全档三段闸门 → `normalizeSlots` / `fullPermissionGate`；
 *   `spawn:false` 零副作用出口 → `manualSpawnResult`；权限/模型补钉 → `lib/team/slots.js`。
 *   抄第二份判据 = 漂移（本项目反复列过的禁忌）。
 *
 * @module dsh-pipeline/lib/transport/team
 */

import { roleLabel } from '../roles.js'
import { composeTeamBrief, rolePersona } from '../team/brief.js'
import { deliverToTeammate, interruptTeammate, listTeamMembers } from '../team/deliver.js'
import { nextNameForReassign, teamNameOf } from '../team/naming.js'
import { TEAM_KIND, describeTeamError, getAgentTeams, isLiveAgent, probeTeamChannel, renderNoLiveCallerReport } from '../team/preflight.js'
import { pinTeamSlots } from '../team/slots.js'
import { MIN_PERMISSION, NEVER_ABORTED_SIGNAL, fullPermissionGate, manualSpawnResult, normalizeSlots, renderDispatchBrief } from './index.js'

export { TEAM_KIND, probeTeamChannel }

/** **team 通道**。派活 = 官方具名 teammate；投递 = 官方 `sendMessage`（在 deliver.js）。 */
export class TeamTransport {
  constructor(deps) {
    this.kind = TEAM_KIND
    this.deps = deps
  }

  available() {
    return probeTeamChannel(this.deps?.ctx).ok
  }

  probe() {
    return probeTeamChannel(this.deps?.ctx)
  }

  /** 通道侧留痕（与 SessionTransport 同一个出口 `deps.audit`，不新开机制）。 */
  audit(spec, action, detail) {
    const fn = this.deps?.audit
    if (typeof fn !== 'function') return
    try {
      fn({ taskId: String(spec?.task?.id ?? ''), action, detail: { ...detail, via: TEAM_KIND, role: spec?.role ?? null, seat: spec?.seat ?? null } })
    } catch {
      /* 留痕失败不该拦住派活本身 */
    }
  }

  /** 官方名单（拿不到就 `[]`）。 */
  async listMembers(caller) {
    return listTeamMembers(this.deps?.ctx, caller)
  }

  /** 打断一个 teammate（`notifyRole({stop:true})` 的落点）。 */
  async interrupt(caller, name) {
    return interruptTeammate(this.deps?.ctx, caller, name)
  }

  /**
   * 派一个角色。步骤顺序即判据（02 §1.1）。
   * @param {object} spec `{task, roster, role, seat, spawn, parent, signal, reassign, ...四槽}`
   */
  async spawnRole(spec) {
    const ctx = this.deps?.ctx
    const cfg = this.deps?.config ?? {}
    const taskId = String(spec?.task?.id ?? '')
    const role = String(spec?.role ?? '')
    const seat = spec?.seat ?? null

    // ① `spawn:false` ⇒ **零宿主调用**（与 SessionTransport 同一判据，F12 盯着这条）。
    if (spec?.spawn === false) {
      this.audit(spec, 'channel:spawn_false', { note: '调用方显式要求不建 teammate ⇒ 只出可粘贴的派活单，未调用 spawnTeammate' })
      return manualSpawnResult(this.deps, spec, '调用方显式传了 `spawn=false`（只要派活单，不要 teammate）：')
    }
    // ② 能力探测：缺件只上报，不降级。
    const probe = this.probe()
    if (probe.ok !== true) {
      this.audit(spec, 'channel:unreachable', { missing: probe.missing, absent: probe.absent })
      return { ok: false, agentId: null, sessionId: null, token: null, via: TEAM_KIND, unreachable: true, probe, report: probe.note, note: probe.note, escalate: 'human' }
    }
    // ③ caller 必须是活着的 Lead Agent（F3）；机制派活没有活 Agent ⇒ 明确失败（D4）。
    const caller = spec?.parent
    if (isLiveAgent(ctx, caller) !== true) {
      const report = renderNoLiveCallerReport({ taskId, role, seat })
      this.audit(spec, 'channel:no_live_caller', { callerId: caller?.id ?? null })
      return { ok: false, agentId: null, sessionId: null, token: null, via: TEAM_KIND, code: 'TEAM_NO_LIVE_CALLER', report, note: report, escalate: 'human' }
    }
    // ④ 四槽（四个独立顶层字段）+ 「完全」档闸门 —— 判据全部复用既有实现，一个字不抄。
    const slots = normalizeSlots(spec, {
      permission: { value: MIN_PERMISSION, reason: '未指定 ⇒ 取三档中最小档' },
      mode: { value: null, reason: '官方 spawnTeammate 没有 agentPreset 参数（事实 F1）⇒ 模式槽不下发' },
      model: { value: null, reason: '未指定 ⇒ 环境枚举默认档' },
      reasoning: { value: null, reason: '未指定 ⇒ 环境枚举默认档' },
    })
    const gate = fullPermissionGate(slots.permission, spec)
    if (gate.ok !== true) {
      this.audit(spec, 'channel:full_tier_refused', { missing: gate.missing, scope_mismatch: gate.scopeMismatch })
      return { ok: false, agentId: null, sessionId: null, token: null, via: TEAM_KIND, code: 'FULL_TIER_NOT_APPROVED', report: gate.report, note: gate.report, escalate: 'human', slots }
    }
    // ⑤ 名字：任务编进名字；`reassign` 要换人 ⇒ 追加 `-r<N>`（D5：官方名字永不重用）。
    //   ★ 先查名单再铸令牌（与 02 的编号顺序相反，判据没变）：复用既有 member 时必须交回
    //     **它原来那枚令牌** —— 会话已绑着那枚，新令牌拿 bindAgent 绑不上去（tokens.js:276-283），
    //     而未绑定的令牌交给席位后会被 `requireAgentBinding` 把每个动作都拒掉。
    const base = teamNameOf({ taskId, role, seat, prefix: cfg.teamNamePrefix })
    const members = await this.listMembers(caller)
    const name = spec?.reassign === true ? nextNameForReassign(members.map((m) => String(m?.name ?? '')), base) : base
    const existing = members.find((m) => String(m?.name ?? '') === name) ?? null
    const prior = existing === null ? null : this.deps.tokens.roleOfAgent(String(existing.id), taskId)
    const token = prior !== null && prior.role === role
      ? { token: prior.token, reused: true }
      : this.deps.tokens.mint({ taskId, role, seat, agentId: null, note: 'team transport（官方 teammate）' })
    // ⑥ 正文 = 角色固定提示词 + 派活单（官方没有 agentPreset 参数，人格只能进正文）。
    const persona = rolePersona(role)
    const brief = renderDispatchBrief({ task: spec.task, roster: spec.roster, role, token: token.token, seat })
    const text = composeTeamBrief({ brief, persona })
    const teams = getAgentTeams(ctx)

    // ⑦ 同名已存在 ⇒ **复用**（不重复 spawn）；否则真的建一个 teammate。
    let member = existing
    if (member === null) {
      let spawned
      try {
        spawned = await teams.spawnTeammate(caller, {
          name,
          description: `流水线 · ${roleLabel(role)}${seat ? `（${seat}）` : ''} · 任务 ${taskId}`.slice(0, 200),
          prompt: [{ type: 'text', text }],
          context: 'fresh',
          provider: typeof cfg.teamProvider === 'string' && cfg.teamProvider.length > 0 ? cfg.teamProvider : 'spawn',
          signal: spec?.signal ?? NEVER_ABORTED_SIGNAL,
        })
      } catch (err) {
        const d = describeTeamError(err, { action: '派活', taskId, role, seat, members: members.length })
        this.audit(spec, 'channel:spawn_error', { code: d.code ?? null, name })
        return { ok: false, agentId: null, sessionId: null, token: token.token, via: TEAM_KIND, code: d.code ?? 'TEAM_SPAWN_FAILED', report: d.report, note: d.report, escalate: 'human', brief, slots }
      }
      member = spawned?.member ?? null
      if (member === null || typeof member.id !== 'string' || member.id.length === 0) {
        const report = `# 拒绝派活：teammate 建出来了但拿不到 member.id\n\n任务 ${taskId} · 角色 ${role}\n★ 没有 id 就没法绑令牌、没法钉四槽 —— 按失败处理，不做静默降级。请人工处置（停止 / 忽略）后再决定。`
        this.audit(spec, 'channel:no_member_id', { name })
        return { ok: false, agentId: null, sessionId: null, token: token.token, via: TEAM_KIND, report, note: report, escalate: 'human', brief, slots }
      }
    }
    // ⑧ 令牌与会话绑定（新建的才绑；复用的那枚本来就绑着，**绑定关系不动**）。
    const memberId = String(member.id)
    if (token.reused !== true) {
      const bound = this.deps.tokens.bindAgent(token.token, memberId)
      if (bound?.ok === false) {
        const report = `# 拒绝派活：令牌绑不上 teammate 会话\n\nmember.id=${memberId}\n${bound.error}`
        this.audit(spec, 'channel:bind_failed', { memberId })
        return { ok: false, agentId: memberId, sessionId: memberId, token: token.token, via: TEAM_KIND, report, note: report, escalate: 'human', brief, slots }
      }
    }
    // ⑨ 四槽：mode 恒 `UNAVAILABLE`；permission / model 补钉 + 读回（D3，判据在 lib/team/slots.js）。
    const pinned = await pinTeamSlots(ctx, spec, slots, memberId, cfg)
    if (pinned.ok !== true) {
      this.audit(spec, 'channel:slot_unpinned', { memberId, violations: pinned.violations })
      return { ok: false, agentId: memberId, sessionId: memberId, token: token.token, via: TEAM_KIND, code: 'TEAM_SLOT_UNPINNED', report: pinned.report, note: pinned.report, escalate: 'human', brief, slots: pinned.slots, slotEvidence: pinned.slotEvidence }
    }
    // ⑩ 复用路径：把派活单**投进去**（新 spawn 时官方在建会话那一刻已把 prompt 投了）。
    let delivered = { ok: true, note: '' }
    if (existing !== null) {
      try {
        await teams.sendMessage(caller, { target: name, content: [{ type: 'text', text }], signal: spec?.signal ?? NEVER_ABORTED_SIGNAL })
      } catch (err) {
        delivered = { ok: false, note: describeTeamError(err, { action: '复用席位投递', taskId, role, seat }).report }
      }
      if (delivered.ok !== true) {
        this.audit(spec, 'channel:reuse_delivery_failed', { memberId, name })
        return { ok: false, agentId: memberId, sessionId: memberId, token: token.token, via: TEAM_KIND, report: delivered.note, note: delivered.note, escalate: 'human', brief, slots: pinned.slots, slotEvidence: pinned.slotEvidence }
      }
    }
    // ⑪ 任务板镜像：best-effort（模块未落地 ⇒ skipped，不抛、不阻断）。
    const board = await this.mirrorDispatch(spec, caller, { role, seat, memberName: name })
    const note = [
      existing === null
        ? `已创建**官方 teammate**「${name}」（member.id=${memberId}）—— 派活单随建会话一并投递。`
        : `复用了**已存在的** teammate「${name}」（member.id=${memberId}；官方名字永不重用，所以不重复 spawn），派活单已投递。`,
      '',
      '## 四槽（逐槽给证据等级 —— 哪一槽是"读回来的"、哪一槽"根本下发不了"，都在这里）',
      ...pinned.lines.map((l) => `- ${l}`),
      '',
      token.reused === true
        ? `角色令牌：${token.token}（**复用该 teammate 原有的令牌**；绑定关系未变，转手即失效）`
        : `角色令牌：${token.token}（已与 teammate 会话绑定；转手即失效）`,
      ...(board.note.length > 0 ? ['', `任务板镜像：${board.note}`] : []),
      '',
      '★ 诚实边界：官方 `spawnTeammate` **没有** agentPreset / permission / model 参数 ⇒ 模式槽不可能生效，权限与模型是**spawn 之后**补钉的（补钉前有一个残余窗口，如实登记）；',
      '  且 teammate 是 subagent 延续子会话（不是侧栏一等公民会话）—— "真实对话"这条验收在 team 通道上应读作"官方 Team 名单里出现具名 teammate、消息可达"。',
    ].join('\n')
    this.audit(spec, 'channel:dispatched', { memberId, memberName: name, reused: existing !== null, slots: pinned.slotEvidence, board: board.skipped === true ? 'skipped' : 'mirrored' })
    return {
      ok: true, agentId: memberId, sessionId: memberId, token: token.token, via: TEAM_KIND,
      memberName: name, reused: existing !== null, brief,
      persona: { ok: persona.ok, dir: persona.dir, note: persona.note },
      slots: pinned.slots, slotEvidence: pinned.slotEvidence, board, note,
    }
  }

  /** 任务板镜像（WP-B 的 `lib/team/board.js`）：**动态 import + 缺文件当 skipped**，绝不阻断派活。 */
  async mirrorDispatch(spec, caller, info) {
    if (this.deps?.config?.teamBoard === 'off') return { skipped: true, note: 'teamBoard=off（配置关闭，跳过镜像）。' }
    try {
      const mod = await import('../team/board.js')
      if (typeof mod?.mirrorDispatch !== 'function') return { skipped: true, note: 'lib/team/board.js 没有产出 mirrorDispatch ⇒ skipped。' }
      const r = await mod.mirrorDispatch({ ctx: this.deps?.ctx, dirs: this.deps?.dirs ?? null, audit: this.deps?.audit, config: this.deps?.config ?? {}, callerAgent: caller }, spec?.task ?? null, info)
      return { skipped: r?.skipped === true, note: String(r?.note ?? (r?.skipped === true ? 'skipped。' : '已镜像。')) }
    } catch (err) {
      if (String(err?.code ?? '') === 'ERR_MODULE_NOT_FOUND') return { skipped: true, note: 'lib/team/board.js 尚未落地（WP-B 未交付）⇒ skipped，不阻断派活。' }
      const note = `镜像失败（只留痕，不改变派活结果）：${String(err?.message ?? err)}`
      this.audit(spec, 'team:board-error', { note })
      return { skipped: true, note }
    }
  }

  /**
   * 给一个已派 teammate 投消息（`notify_only` / 催办 / 孤儿重投的唯一出站口）。
   * 判据全在 `lib/team/deliver.js`（两套入参形状 / interrupt 退化 / 64KB 截断，理由见那里）。
   */
  async notifyRole(spec) {
    return deliverToTeammate(this.deps, spec)
  }
}
