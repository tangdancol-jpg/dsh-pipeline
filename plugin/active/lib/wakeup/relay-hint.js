// 唤醒 · 「这条投递的席位按继任策略能不能换班」（§9 噪声 ④）：不能换班的给出可执行的下一步，而不是一条消费不掉的升级。
/**
 * 现场：某角色（现场是 planner）的"没人接管"告警一直挂着、升了级也消费不掉 ——
 * `lib/context.js` 的 `checkRelayAuthorization` 明写"不在 relayPolicy.allowedRoles 里，本次不给继任"，
 * 而巡检 / 升级链全程不读 relayPolicy ⇒ 把告警升给一个按策略换不了它的主对话。
 *
 * 判据与继任判据**同源**（`relayEnabled` + `allowedRoles`），只在三条同时成立时才算"不可换班"：
 * 本单启用继任、白名单非空、投递方角色不在白名单里。机制 / 主对话自己的投递不判。
 *
 * @module dsh-pipeline/lib/wakeup/relay-hint
 */

import { relayEnabled } from '../context.js'
import { parseWakeKey } from '../wakeledger.js'

/** 投递方角色（账本条目的 actor，老行退回按键解析；去掉 `#席位`）。 */
export function roleOfDelivery(entry) {
  const raw = String(entry?.actor ?? '') || parseWakeKey(entry?.key ?? '').actor
  return raw.split('#')[0]
}

/**
 * 这条投递的席位是不是按继任策略不可换班。
 * @param {object|null} task
 * @param {{key?:string, actor?:string}} entry
 * @returns {{role:string, allowed:string[]}|null}
 */
export function relayBlockedRole(task, entry) {
  if (task === null || typeof task !== 'object') return null
  const role = roleOfDelivery(entry)
  if (role.length === 0 || role === 'mechanism' || role === 'main') return null
  const en = relayEnabled(task)
  if (en.enabled !== true) return null
  const allowed = Array.isArray(en.policy?.allowedRoles) ? en.policy.allowedRoles.map(String) : []
  if (allowed.length === 0 || allowed.includes(role)) return null
  return { role, allowed }
}

/** 给人看的下一步（巡检正文与升级结论共用这一句）。 */
export function relayBlockedHint(b) {
  return (
    `★ 投递方角色「${b.role}」按继任策略**不可换班**（relayPolicy.allowedRoles = ${b.allowed.join(' / ')}）` +
    '—— 主对话换不了这个席位，升级叫醒也消费不掉，所以不再升级。\n' +
    `★ 下一步：由计划 AI **重下 relayPolicy**（把 ${b.role} 加进 allowedRoles），或走人工（pipeline_human_request）。`
  )
}
