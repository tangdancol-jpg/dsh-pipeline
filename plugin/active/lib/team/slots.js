/**
 * dsh-pipeline · Agent Teams 通道 · **四槽在官方 teammate 上的补钉与如实交代**
 * ============================================================================
 * 官方 `spawnTeammate` **没有** agentPreset / permission / model / reasoning 参数
 * （`_tmp/teamservice.txt:1723-1751`，事实 F1）⇒ 四槽在 team 通道上只能这样交代：
 *
 *   | 槽 | team 通道怎么处理 | 证据等级 |
 *   | --- | --- | --- |
 *   | `mode`       | **下发不了**（官方无此参数），人格改走派活单正文 | `UNAVAILABLE`（确定没生效） |
 *   | `permission` | spawn 之后 `permissionPresets.set(member.id)` 并**读回** | 真读回 / 未读回 |
 *   | `model`      | spawn 之后 `selectModel` 下发，**没有读回接口** | 已请求·未回读 |
 *   | `reasoning`  | 同 model（塞在同一次 selectModel 调用里） | 已请求·未回读 |
 *
 * 判据**一行都不复制**：读 `.js` 时用 `./transport/index.js` 的 `applyPermissionSlot` /
 * `applyModelSlot`（那是 F11 修好的同一份实现），证据等级用 `./transport/slot-evidence.js`
 * 的既有词汇。本文件只做"按 team 通道的事实组装结论 + 出可读报告"。
 *
 * ★ 一条铁律（F11 的教训）：**没有读回来的值，任何地方都不许写成"一致"**；
 *   而"根本下发不了"必须写成 `UNAVAILABLE`，不许含糊成"已生效"或"未指定"。
 *
 * @module dsh-pipeline/lib/team/slots
 */

import { applyModelSlot, applyPermissionSlot } from '../transport/index.js'
import { EVIDENCE, slotEvidence } from '../transport/slot-evidence.js'

/** 模式槽的机器可读判据（01 §D3 写死这个字面值：`UNAVAILABLE`）。 */
export const MODE_SLOT_UNAVAILABLE = 'UNAVAILABLE'

/**
 * 在已建出的 teammate 会话上补钉四槽，并把"哪一槽读回来了 / 哪一槽根本下发不了"
 * 结构化地交出去。
 *
 * @param {object} ctx
 * @param {object} spec 派活 spec（`task` / `role` / `seat`）
 * @param {object} slots `normalizeSlots` 的产物（四个独立顶层槽）
 * @param {string} memberId 官方 `member.id`（**就是**子会话 id，可当 sessionId 用）
 * @param {object} cfg 配置（只读 `teamStrictSlots`）
 * @returns {Promise<{ok:boolean, violations:string[], lines:string[], report:string, slots:object, slotEvidence:object}>}
 */
export async function pinTeamSlots(ctx, spec, slots, memberId, cfg) {
  const permission = await applyPermissionSlot(ctx, memberId, slots.permission)
  const model = await applyModelSlot(ctx, memberId, slots)
  const modeEvidence = slotEvidence(
    EVIDENCE.READBACK_UNAVAILABLE,
    slots?.mode?.value ?? null,
    null,
    '官方 spawnTeammate **没有** agentPreset 参数（事实 F1）⇒ 模式槽**没有下发通道**；角色人格已随派活单正文投递（lib/team/brief.js）',
  )
  const strict = cfg?.teamStrictSlots === true
  const explicitlySet = (s) => s !== null && s !== undefined && s.isDefault === false
  const violations = []
  if (permission.ok !== true) violations.push('permission')
  if (model.ok !== true) violations.push('model/reasoning')
  // `strict` 时"显式非默认却钉不上"也要拒 —— 而 mode 恒钉不上，所以显式给了 mode 就必然命中。
  if (strict && explicitlySet(slots?.mode)) violations.push('mode')
  const lines = [
    `模式：${slots?.mode?.value ?? '（未指定）'} · **${MODE_SLOT_UNAVAILABLE}（官方无此参数，确定没生效）** —— ${modeEvidence.detail}`,
    `权限档：${permission.note}`,
    `模型 / 推理等级：${model.note}`,
  ]
  const record = {
    permission,
    mode: { value: slots?.mode?.value ?? null, applied: false, evidence: modeEvidence },
    model,
    reasoning: slots?.reasoning ?? null,
  }
  const evidence = {
    mode: MODE_SLOT_UNAVAILABLE,
    permission: permission.evidence?.kind ?? null,
    model: model.evidence?.kind ?? null,
    reasoning: model.reasoningEvidence?.kind ?? null,
  }
  if (violations.length === 0) return { ok: true, violations, lines, report: '', slots: record, slotEvidence: evidence }

  const report = [
    '# 拒绝派活：四槽钉不上（team 通道）',
    '',
    `任务 ${String(spec?.task?.id ?? '')} · 角色 ${String(spec?.role ?? '')}${spec?.seat ? ` · 席位 ${spec.seat}` : ''}`,
    `teammate 会话：${memberId}`,
    `钉不上的槽：${violations.join('、')}`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    strict
      ? '★ `teamStrictSlots: true`：任一槽"显式非默认"却钉不上 ⇒ 拒绝派活（01 §D3）。'
      : '★ 权限档 / 模型是硬要求：钉不上就不放会话出去（不把"没钉上"当"钉上了"）。',
    '★ teammate 会话**已经建出来了** —— 这不算派活成功；请人工处置（停止 / 忽略）后再决定。',
  ].join('\n')
  return { ok: false, violations, lines, report, slots: record, slotEvidence: evidence }
}
