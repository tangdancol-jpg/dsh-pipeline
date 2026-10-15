// 能力额度台账 · 「批准之后只放行一次」：追加式 JSONL 台账的读写、折叠与**用尽即失效**。
/**
 * dsh-pipeline · 守门 · **能力额度台账**（application → approval → one-shot release）
 * ============================================================================
 * 用户原话第 1 件的下半条：「必要时能向用户申请」。
 * 这句话若不落成**一次一份的额度**，就会变成"申请过一次以后永久放宽" —— 那不是申请，是拆除。
 *
 * ---------------------------------------------------------------------------
 * 台账形状（**追加式 JSONL**，一行一个事件，永不改写历史）
 * ---------------------------------------------------------------------------
 *     {"id":"C-3f9a1c8e","op":"request","capability":"read-source","scope":["…/src/a.js"],
 *      "reason":"核对接口签名","tool":"read","by":"main","task_id":"T-1","at":"…"}
 *     {"id":"C-3f9a1c8e","op":"approve","by":"user","quote":"可以，就这一次","at":"…"}
 *     {"id":"C-3f9a1c8e","op":"release","tool":"read","target":"…/src/a.js","at":"…"}
 *
 * 折叠规则（纯函数 `foldGrants`）：按 `id` 归并，取**最后一个**决定状态的 op
 *   · 只有 `request`                    ⇒ `pending`  （**申请中 ⇒ 仍被拒**）
 *   · `request` + `approve`             ⇒ `approved` （可放行一次）
 *   · `… + release`                     ⇒ `used`     （**用完 ⇒ 再次被拒**）
 *   · `request` + `reject`              ⇒ `rejected`
 *
 * ★ 三条纪律：
 *   ① **追加写**：`release` 是**再追加一行**，不是改写那一行 —— 历史不可篡改；
 *   ② **绝不抛给调用方**：守门判据不能因为写台账失败而崩（那会让一次工具调用变成异常）。
 *      写失败 ⇒ 返回 `{ok:false}`，**由调用方决定**（守门的选择是**不放行**：拿不到
 *      "用过一次"的记录就不能假装它用过了 —— fail-closed）；
 *   ③ **id 由内容算出**：同一次申请重复提交是**同一条**，不会刷出一堆待批。
 *
 * @module dsh-pipeline/lib/guard/grant
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fullHash } from '../util.js'
import { GRANTABLE_CAPABILITIES, isGrantable, normalizeScope, scopeAllows } from './capability.js'

/** 台账文件名（落在 `<任务目录>/` 下）。 */
export const GRANT_FILE = 'capability-grants.jsonl'

/** 台账里认识的动作（认不出的行**忽略**，不当成错误）。 */
export const GRANT_OPS = Object.freeze(['request', 'approve', 'reject', 'release'])

/** 折出来的状态。 */
export const GRANT_STATE = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  USED: 'used',
  REJECTED: 'rejected',
})

/** 台账落点（`<任务目录>/capability-grants.jsonl`；任务目录取不到 ⇒ `''`）。 */
export function grantFileOf(task) {
  const self = typeof task?.taskSelfDir === 'string' ? task.taskSelfDir.trim() : ''
  if (self.length === 0) return ''
  return join(self, GRANT_FILE)
}

/**
 * 一次申请的**稳定 id**：由 `能力 + 作用域 + 理由` 算出（同一次申请重复提交 = 同一条）。
 * @param {{capability:string, scope:string[], reason?:string}} spec
 * @returns {string}
 */
export function grantIdOf(spec) {
  const cap = String(spec?.capability ?? '')
  const scope = (Array.isArray(spec?.scope) ? spec.scope : []).join('|')
  const reason = String(spec?.reason ?? '').trim()
  if (cap.length === 0 || scope.length === 0) return ''
  return `C-${fullHash(`${cap}\n${scope}\n${reason}`).slice(0, 8)}`
}

/** 解析台账文本（坏行**跳过**，不抛）。 */
export function parseLedger(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (s.length === 0) continue
    try {
      const o = JSON.parse(s)
      if (o !== null && typeof o === 'object' && typeof o.id === 'string' && GRANT_OPS.includes(String(o.op))) out.push(o)
    } catch {
      /* 坏行跳过 —— 台账是留痕，不是判据的唯一来源 */
    }
  }
  return out
}

/**
 * ★ **折叠台账**（纯函数）：一行一个事件 ⇒ 一条申请一个状态。
 * @param {object[]} entries
 * @returns {Array<{id,capability,scope,reason,tool,state,quote,at,released_at,released_target}>}
 */
export function foldGrants(entries) {
  const byId = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = String(e.id ?? '')
    if (id.length === 0) continue
    const cur = byId.get(id) ?? {
      id,
      capability: String(e.capability ?? ''),
      scope: Array.isArray(e.scope) ? e.scope.map(String) : [],
      reason: String(e.reason ?? ''),
      tool: String(e.tool ?? ''),
      quote: '',
      at: String(e.at ?? ''),
      state: GRANT_STATE.PENDING,
      released_at: '',
      released_target: '',
    }
    if (String(e.op) === 'request') {
      // 后到的 request 不改状态（幂等重复提交），只补空缺字段。
      if (cur.capability.length === 0) cur.capability = String(e.capability ?? '')
      if (cur.scope.length === 0 && Array.isArray(e.scope)) cur.scope = e.scope.map(String)
      if (cur.at.length === 0) cur.at = String(e.at ?? '')
    } else if (String(e.op) === 'approve') {
      if (cur.state === GRANT_STATE.PENDING) cur.state = GRANT_STATE.APPROVED
      cur.quote = String(e.quote ?? '')
    } else if (String(e.op) === 'reject') {
      if (cur.state === GRANT_STATE.PENDING) cur.state = GRANT_STATE.REJECTED
    } else if (String(e.op) === 'release') {
      if (cur.state === GRANT_STATE.APPROVED) {
        cur.state = GRANT_STATE.USED
        cur.released_at = String(e.at ?? '')
        cur.released_target = String(e.target ?? '')
      }
    }
    byId.set(id, cur)
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
}

/** 读台账（文件不存在 ⇒ 空）。**绝不抛**。 */
export function readGrants(file) {
  if (typeof file !== 'string' || file.length === 0) return []
  try {
    if (!existsSync(file)) return []
    return foldGrants(parseLedger(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

/**
 * 追加一行（**唯一写点**）。绝不抛：失败如实返回 `{ok:false, error}`。
 * @param {string} file
 * @param {object} entry
 * @returns {{ok:boolean,error:string}}
 */
export function appendGrant(file, entry) {
  if (typeof file !== 'string' || file.length === 0) return { ok: false, error: '任务目录取不到（台账无处可落）' }
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return { ok: true, error: '' }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * ★★ **找一条可以放行这一次的额度**（纯函数，不写盘）。
 *
 * 判据（四问全过才返回）：
 *   ① 状态是 `approved`（**申请中 / 已用尽 / 已驳回都不行**）；
 *   ② 能力同名；
 *   ③ 这次调用的**目标**落在额度作用域内（`scopeAllows`，按路径段判）；
 *   ④ 额度那条本身可申请（`shell` 就算混进台账也不认）。
 *
 * @param {object[]} grants `foldGrants` 的结果
 * @param {{capability:string, target:string}} req
 * @returns {object|null}
 */
export function findReleasable(grants, req) {
  const cap = String(req?.capability ?? '')
  const target = String(req?.target ?? '')
  if (!isGrantable(cap)) return null
  // 多条命中时取**最早批下来的那条**（确定性：不靠数组顺序、不靠"最近"）。
  const hits = (Array.isArray(grants) ? grants : []).filter(
    (g) => g.state === GRANT_STATE.APPROVED && g.capability === cap && scopeAllows(g.scope, target),
  )
  if (hits.length === 0) return null
  return hits.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))[0]
}

/** 一次调用的目标投影：有路径取第一个路径，否则空串。 */
export function targetOfCall(targets) {
  const list = Array.isArray(targets) ? targets.filter((t) => typeof t === 'string' && t.length > 0) : []
  return list.length > 0 ? list[0] : ''
}

/** 台账里所有 `approved`（还没用）的额度 —— 给人看的清单。 */
export function pendingApproved(grants) {
  return (Array.isArray(grants) ? grants : []).filter((g) => g.state === GRANT_STATE.APPROVED)
}

/** 这条能力能不能申请（转出，避免工具层再 import 一次 capability.js）。 */
export { GRANTABLE_CAPABILITIES, isGrantable, normalizeScope }
