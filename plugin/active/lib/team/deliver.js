/**
 * dsh-pipeline · Agent Teams 通道 · **给 teammate 投消息 / 打断 / 查名单**
 * ============================================================================
 * 通道的"投递半边"（"派活半边"在 `lib/transport/team.js`）。拆开的原因只有一个：
 * 单文件 ≤300 行的纪律（`CONVENTIONS.md`）—— 两半的判据不同源，合在一起只能让文件变长。
 *
 * ## 为什么投递这么绕（现存的真实形状，不是设计出来的复杂度）
 *   · `nudgeSeat`（`lib/tools/notifier.js:104`）只给 **`sessionId` 字符串** —— 没有 caller；
 *   · `lib/tools/records.js:414` 给的是 **`sender: exec.agent` + `agentId`** —— 有活对象；
 *   · 而官方 `sendMessage(caller, …)` 的第一参数**必须是活着的 Lead Agent**（事实 F3），
 *     `target` 又必须是 teammate **名字**（不是 id）。
 *   ⇒ 所以本模块先按 `sessionId ?? agentId` 反查名单拿名字，再从中确定那个 Lead：
 *     对每个候选 caller 调 `listMembers`，谁的名单里有这个会话，谁就是这个 Team 的 Lead。
 *     一条也找不到时**如实失败**（存在 `sender` 时才退到既有 `subagents.sendMessage` 语义）。
 *
 * ## 两条纪律
 *   · `stop:true` 优先走官方 `interrupt`；`interrupt` 是**可选能力**，缺了只能退化为
 *     投一条"停手"消息，且必须写明"这**不等于**已打断"（不许把没做的事说成做了）；
 *   · 正文按 UTF-8 字节截断并标注（01 §D7：不静默丢内容）。
 *
 * @module dsh-pipeline/lib/team/deliver
 */

import { NEVER_ABORTED_SIGNAL } from '../transport/index.js'
import {
  MESSAGE_HEADROOM,
  TEAM_MAX_MESSAGE_BYTES,
  callerCandidates,
  describeTeamError,
  getAgentTeams,
  hasMethods,
  probeTeamChannel,
  readService,
  truncateUtf8,
} from './preflight.js'

/** 官方名单（拿不到就 `[]`：这是诊断用的，不该把派活带崩）。 */
export async function listTeamMembers(ctx, caller) {
  const teams = getAgentTeams(ctx)
  if (typeof teams?.listMembers !== 'function') return []
  try {
    const list = await teams.listMembers(caller)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 打断一个 teammate。
 * @returns {Promise<{ok:boolean, unavailable?:boolean, previousStatus:string|null, note:string}>}
 */
export async function interruptTeammate(ctx, caller, name) {
  const teams = getAgentTeams(ctx)
  if (typeof teams?.interrupt !== 'function') {
    // ★ 可选能力缺失 ⇒ `unavailable:true`，让调用方**退化**成投一条"停手"消息；
    //   绝不能在这里返回 ok（那会把"没打断"说成"已打断"）。
    return { ok: false, unavailable: true, previousStatus: null, note: 'agentTeams.interrupt 不可用（可选能力缺失）⇒ **没有打断**。' }
  }
  try {
    const r = await teams.interrupt(caller, name)
    return { ok: true, previousStatus: r?.previousStatus ?? null, note: `已打断 teammate「${name}」（打断前状态 ${r?.previousStatus ?? 'unknown'}）。` }
  } catch (err) {
    return { ok: false, previousStatus: null, note: describeTeamError(err, { action: '打断' }).report }
  }
}

/**
 * 按 `sessionId ?? agentId` 反查「哪个 Lead 的名单里有它」。
 * @returns {Promise<{caller:object, name:string}|null>}
 */
async function findTarget(ctx, spec) {
  const sessionId = typeof spec?.sessionId === 'string' && spec.sessionId.length > 0
    ? spec.sessionId
    : typeof spec?.agentId === 'string' && spec.agentId.length > 0 ? spec.agentId : ''
  if (sessionId.length === 0) return null
  for (const caller of callerCandidates(ctx, spec)) {
    const hit = (await listTeamMembers(ctx, caller)).find((m) => String(m?.id ?? '') === sessionId)
    if (hit !== undefined && String(hit?.name ?? '').length > 0) return { caller, name: String(hit.name), sessionId }
  }
  return null
}

/**
 * 给一个已派 teammate 投消息（`notify_only` / 催办 / 孤儿重投的唯一出站口）。
 * @param {{ctx:object, audit?:Function}} deps
 * @param {object} spec `{sessionId?, agentId?, sender?, message, stop?, signal?}`
 */
export async function deliverToTeammate(deps, spec) {
  const ctx = deps?.ctx
  const teams = getAgentTeams(ctx)
  const probe = probeTeamChannel(ctx)
  if (probe.ok !== true) return { ok: false, messageId: null, note: probe.note }
  const target = await findTarget(ctx, spec)
  let stopFallbackNote = ''
  if (target !== null && spec?.stop === true) {
    const it = await interruptTeammate(ctx, target.caller, target.name)
    if (it.ok === true) return { ok: true, messageId: null, note: it.note }
    // 可选能力缺失 ⇒ 退化成投"停手"消息（正文本身已写明停手）；其它失败如实失败。
    if (it.unavailable !== true) return { ok: false, messageId: null, note: it.note }
    stopFallbackNote = '★ agentTeams.interrupt 不可用 ⇒ **没有打断**，已改用消息正文投递"停手"指令（这**不等于**已打断，停不停由它自己决定）。\n'
  }
  if (target === null) return deliverByLegacyPath(ctx, spec)
  const cut = truncateUtf8(String(spec?.message ?? ''), TEAM_MAX_MESSAGE_BYTES - MESSAGE_HEADROOM)
  try {
    const r = await teams.sendMessage(target.caller, {
      target: target.name,
      content: [{ type: 'text', text: cut.text }],
      signal: spec?.signal ?? NEVER_ABORTED_SIGNAL,
    })
    return {
      ok: true,
      messageId: r?.messageId ?? null,
      note:
        stopFallbackNote +
        `已投给 teammate「${target.name}」（官方 sendMessage；消息 id=${r?.messageId ?? '(未返回)'}）。` +
        (cut.truncated ? `\n★ 正文超长已按 UTF-8 字节截断：${cut.originalBytes} → ${cut.bytes} 字节（官方上限 ${TEAM_MAX_MESSAGE_BYTES}）。` : ''),
    }
  } catch (err) {
    return { ok: false, messageId: null, note: describeTeamError(err, { action: '投递' }).report }
  }
}

/**
 * 名单里查不到时：有 `sender`（活 Agent）+ `agentId` 字符串 ⇒ 退到**既有子代理语义**
 * （`subagents.sendMessage`），并如实标注"走的是退路"；否则如实失败。
 */
async function deliverByLegacyPath(ctx, spec) {
  const subagents = readService(ctx, 'subagents')
  const sessionId = String(spec?.sessionId ?? spec?.agentId ?? '')
  if (hasMethods(subagents, ['sendMessage']) && spec?.sender !== undefined && spec?.sender !== null && typeof spec?.agentId === 'string' && spec.agentId.length > 0) {
    try {
      const messageId = await subagents.sendMessage(spec.sender, spec.agentId, [{ type: 'text', text: String(spec.message ?? '') }], {})
      return { ok: true, messageId, note: `team 名单里查不到会话 ${sessionId} ⇒ 已按既有子代理投递路径投给 ${spec.agentId}（如实标注：走的是退路，不是官方 sendMessage）。` }
    } catch (err) {
      return { ok: false, messageId: null, note: `投递失败（team 名单查不到，且子代理退路也失败）：${String(err?.message ?? err)}` }
    }
  }
  return {
    ok: false,
    messageId: null,
    note:
      `找不到会话 ${sessionId || '(空)'} 对应的 teammate：官方名单里没有它` +
      (sessionId.length === 0 ? '（sessionId / agentId 都是空的）' : '，也没有可用的退路（缺 `sender` 或 `subagents.sendMessage`）') +
      '。★ 如实上报，不做近似替代。',
  }
}
