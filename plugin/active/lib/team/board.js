/**
 * dsh-pipeline · WP-B · **官方 Team 任务板镜像**（`team_task_*`）
 * ============================================================================
 * 一句话：流水线任务走到哪，官方任务板就跟到哪 —— 开单建一条官方任务、派活派给
 * 那个 teammate、关单/取消标完成。
 *
 * ★ 为什么是"镜像"而不是"搬过去"：官方任务板回答「**谁在干什么**」（成员视角），
 *   流水线任务回答「**这一步过没过**」（状态机 + 交接物 + 打回预算）。两者语义不同，
 *   **谁也不许当对方的事实来源**。所以这里只是单向、可丢弃的投影：失败绝不能
 *   反过来卡住流水线（D10）。
 *
 * 契约（01 §D10 / 02 §4）：
 *   · 落盘 `.pipeline/<task>/team-board.json` = `{team_task_id, revision, last_action, at}`；
 *   · `mirrorOpen`→`createTask`；`mirrorDispatch`→`updateTask('reassign')`；
 *     `mirrorClose`→`updateTask('complete')`；
 *   · **best-effort**：服务缺失 / `config.teamBoard==='off'` / 任何异常 ⇒ `skipped` 或
 *     `{ok:false}` + `audit('team:board-error')`，**绝不抛**、绝不改流水线主流程的 `ok`；
 *   · revision 是官方侧 CAS：冲突（`TEAM_TASK_STALE_REVISION`）重读一次、重试一次。
 *
 * 官方状态机事实（核对 TeamService 源码，别凭想象写）：
 *   · `createTask(caller,{subject,description,blockedBy?,writeScopes?})` 要求 caller 是
 *     **活着的 Team 成员**；新任务 `pending` / `revision:1` / 无 owner；subject ≤200、
 *     description ≤16384、writeScopes 必须是 workspace-relative 前缀。
 *   · `updateTask(caller,{taskId,expectedRevision,action,…})`：① revision 不符 ⇒
 *     `TEAM_TASK_STALE_REVISION`；② `claim` 任何成员都能领未被别人领走的 pending 任务，
 *     成功即 `in_progress` + owner=caller；③ `reassign` **只有 lead** 能调，置
 *     `in_progress` + owner=<成员名>；④ `complete` owner/lead 可调，且**只接受 `in_progress`**。
 *   ⇒ 派活必须走 `reassign`（主对话即 lead）；关单时官方侧若仍 pending，得先 claim 再 complete。
 *
 * 宿主面（登记 / 门槛 / team-board.json 读写 / 审计）在 `board-state.js`（行数纪律）。
 *
 * @module dsh-pipeline/lib/team/board
 */

import { nowIso } from '../util.js'
import {
  auditBoardError,
  boardGate,
  failed,
  readBoardState,
  persistBoardState,
  skipped,
} from './board-state.js'

// 对外仍是**一个入口**：`board.js` 把状态面一并转出，调用方（store hook / transport）
// 只 import 本文件，不需要知道内部拆过文件。
export {
  BOARD_FILE_NAME,
  boardEnvFromStore,
  installBoardHost,
  installedBoardHost,
  readBoardState,
  teamBoardMode,
  teamBoardPath,
} from './board-state.js'

/** 官方 `subject` / `description` 上限（TeamService 的 requiredText 校验）。 */
const SUBJECT_MAX = 200
const DESCRIPTION_MAX = 16384

/** 官方错误原文里的当前 revision（`… current revision is 7`）—— CAS 冲突后的重读兜底。 */
function revisionFromError(err) {
  const m = /current revision is (\d+)/i.exec(String(err?.message ?? ''))
  return m === null ? null : Number(m[1])
}

/** 优先用官方 `getTask` 读权威 revision；读不到才退回错误原文。 */
function revisionFromService(service, caller, taskId) {
  if (typeof service.getTask !== 'function') return null
  try {
    const view = service.getTask(caller, taskId)
    return Number.isInteger(view?.revision) ? view.revision : null
  } catch {
    return null
  }
}

/** 是不是"revision 过期"（只有它值得重读+重试一次；别的错误重试也不会好）。 */
function isStaleError(err) {
  if (err?.code === 'TEAM_TASK_STALE_REVISION') return true
  return /TEAM_TASK_STALE_REVISION|stale team task/i.test(String(err?.message ?? ''))
}

/** `complete` 只接受 `in_progress` —— 这是"官方拒绝"，不是"镜像坏了"，值得换路。 */
function isInvalidTransition(err) {
  if (err?.code === 'TEAM_TASK_INVALID_TRANSITION') return true
  return /only an in-progress task can complete|invalid transition/i.test(String(err?.message ?? ''))
}

/** CAS 冲突后的新 revision：官方 getTask > 错误原文 > 猜 +1（最后一次兜底）。 */
function nextRevision(service, caller, teamTaskId, err, revision) {
  return revisionFromService(service, caller, teamTaskId) ?? revisionFromError(err) ?? revision + 1
}

/**
 * 授权面路径 → 官方 `writeScopes`（TeamService 会拒绝对路径/盘符/`.`/`..`/空段）。
 * ★ 不合法条目**静默丢弃**：任务板只是辅助面，一条越界条目不该让整条镜像失败。
 */
export function writeScopesOf(task) {
  const out = []
  const push = (raw) => {
    if (typeof raw !== 'string') return
    const s = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (s.length === 0 || s.startsWith('/') || /^[a-z]:/i.test(s)) return
    if (s.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..')) return
    if (!out.includes(s)) out.push(s)
  }
  for (const entry of Array.isArray(task?.change_scope) ? task.change_scope : []) push(entry?.path)
  const partitions = task?.roster?.writers?.partitions
  if (Array.isArray(partitions)) for (const part of partitions) for (const p of Array.isArray(part?.scope_paths) ? part.scope_paths : []) push(p)
  return out
}

/** 写成功后的镜像状态（四字段契约）。 */
function stateOf(teamTaskId, revision, lastAction) {
  return { team_task_id: teamTaskId, revision, last_action: lastAction, at: nowIso() }
}

/**
 * **开单镜像**：`createTask` 建一条官方任务。
 * @param {object} env
 * @param {object} task - 流水线任务卡
 */
export async function mirrorOpen(env, task) {
  const action = 'create'
  const taskId = typeof task?.id === 'string' ? task.id : ''
  if (taskId.length === 0) return skipped(action, '任务卡没有 id ⇒ 不镜像。')
  const gate = boardGate(env)
  if (gate.skipped === true) return skipped(action, gate.note)
  // 幂等：已镜像过就不再建第二条（重放/重开不该在官方板留下同名任务）。
  if ((await readBoardState(env, taskId)) !== null) return skipped(action, `任务 ${taskId} 已有 team-board.json ⇒ 不重复 createTask。`)

  const subject = `[pipeline] ${taskId}`.slice(0, SUBJECT_MAX)
  // description 官方必填非空、上限 16384：空需求用 id 兜底、超长截断，绝不让镜像挡开单。
  const description = (String(task.requirement ?? '').trim() || taskId).slice(0, DESCRIPTION_MAX)
  try {
    const view = await gate.service.createTask(gate.caller, { subject, description, writeScopes: writeScopesOf(task) })
    const teamTaskId = typeof view?.id === 'string' ? view.id : ''
    if (teamTaskId.length === 0) throw new Error('createTask 没回任务 id（宿主实现与预期不符）')
    const state = stateOf(teamTaskId, Number.isInteger(view?.revision) ? view.revision : 1, 'create')
    await persistBoardState(env, taskId, state)
    return { ok: true, action, team_task_id: state.team_task_id, revision: state.revision, note: `已在官方任务板建任务 ${state.team_task_id}（revision ${state.revision}）。` }
  } catch (err) {
    await auditBoardError(env, { task_id: taskId, phase: action, error: String(err?.message ?? err), code: err?.code ?? null })
    return failed(action, err, `镜像开单失败（${String(err?.message ?? err)}）—— 只记审计，流水线开单不受影响。`)
  }
}

/**
 * **派活镜像**：把官方任务派给刚 spawn 的 teammate（`reassign`，只有 lead 能调）。
 * `owner` 是**成员名**（官方按名解析活成员），没有 `memberName` 就跳过 ——
 * 猜一个名字只会换来一条 `TEAM_MEMBER_NOT_FOUND`。
 * @param {object} env
 * @param {object} task
 * @param {{role?:string, seat?:string|null, memberName?:string}} spec
 */
export async function mirrorDispatch(env, task, spec = {}) {
  const action = 'reassign'
  const taskId = typeof task?.id === 'string' ? task.id : ''
  const memberName = typeof spec.memberName === 'string' ? spec.memberName.trim() : ''
  if (taskId.length === 0) return skipped(action, '任务卡没有 id ⇒ 不镜像。')
  if (memberName.length === 0) return skipped(action, '派活没有 memberName ⇒ 不知道该派给谁，跳过。')
  const gate = boardGate(env)
  if (gate.skipped === true) return skipped(action, gate.note)
  const state = await readBoardState(env, taskId)
  if (state === null) return skipped(action, `任务 ${taskId} 没有任务板镜像（开单时被跳过/失败）⇒ 不派发镜像。`)

  let revision = state.revision
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const view = await gate.service.updateTask(gate.caller, { taskId: state.team_task_id, expectedRevision: revision, action: 'reassign', owner: memberName })
      const next = stateOf(state.team_task_id, Number.isInteger(view?.revision) ? view.revision : revision + 1, 'reassign')
      await persistBoardState(env, taskId, next)
      return { ok: true, action, team_task_id: next.team_task_id, revision: next.revision, owner: memberName, note: `官方任务 ${next.team_task_id} 已派给 ${memberName}（revision ${next.revision}）。` }
    } catch (err) {
      lastErr = err
      // CAS 冲突：重读一次 revision、重试一次（02 §4）。
      if (attempt === 0 && isStaleError(err)) {
        revision = nextRevision(gate.service, gate.caller, state.team_task_id, err, revision)
        continue
      }
      break
    }
  }
  await auditBoardError(env, { task_id: taskId, phase: action, team_task_id: state.team_task_id, error: String(lastErr?.message ?? lastErr), code: lastErr?.code ?? null })
  return failed(action, lastErr, `镜像派活失败（${String(lastErr?.message ?? lastErr)}）—— 只记审计，派活主流程不受影响。`)
}

/**
 * **关单/取消镜像**：把官方任务标 `complete`。
 *
 * ★ 为什么要多一条 `claim` 兜底：官方 `complete` **只接受 `in_progress`**，而
 *   "开单后没派活就取消"的任务在官方侧仍 `pending` —— 直接 complete 会被
 *   `TEAM_TASK_INVALID_TRANSITION` 拒掉，官方板就永远挂一条 pending 任务。
 *   `claim` 的官方语义是"任何成员都能领自己没被别人领走的 pending 任务，成功即
 *   owner=caller" ⇒ 主对话先领再完，正好把这条链走通。已被别人 owner ⇒ claim 失败
 *   ⇒ 落审计，仍然不碰主流程。
 * @param {object} env
 * @param {object} task
 * @param {{reason?:string}} [spec]
 */
export async function mirrorClose(env, task, spec = {}) {
  const action = 'complete'
  const taskId = typeof task?.id === 'string' ? task.id : ''
  if (taskId.length === 0) return skipped(action, '任务卡没有 id ⇒ 不镜像。')
  const gate = boardGate(env)
  if (gate.skipped === true) return skipped(action, gate.note)
  const state = await readBoardState(env, taskId)
  if (state === null) return skipped(action, `任务 ${taskId} 没有任务板镜像（开单时被跳过/失败）⇒ 不派发镜像。`)

  const finish = async (revision) => {
    const view = await gate.service.updateTask(gate.caller, { taskId: state.team_task_id, expectedRevision: revision, action: 'complete' })
    const next = stateOf(state.team_task_id, Number.isInteger(view?.revision) ? view.revision : revision + 1, 'complete')
    await persistBoardState(env, taskId, next)
    return { ok: true, action, team_task_id: next.team_task_id, revision: next.revision, note: `官方任务 ${next.team_task_id} 已标完成（revision ${next.revision}）。` }
  }

  let revision = state.revision
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      try {
        return await finish(revision)
      } catch (err) {
        // 只有"还没进 in_progress"才值得先 claim 再 complete；别的错误原样抛。
        if (!isInvalidTransition(err)) throw err
        const claimed = await gate.service.updateTask(gate.caller, { taskId: state.team_task_id, expectedRevision: revision, action: 'claim' })
        revision = Number.isInteger(claimed?.revision) ? claimed.revision : revision + 1
        return await finish(revision)
      }
    } catch (err) {
      lastErr = err
      if (attempt === 0 && isStaleError(err)) {
        revision = nextRevision(gate.service, gate.caller, state.team_task_id, err, revision)
        continue
      }
      break
    }
  }
  const why = typeof spec.reason === 'string' && spec.reason.length > 0 ? `（原因：${spec.reason}）` : ''
  await auditBoardError(env, { task_id: taskId, phase: action, team_task_id: state.team_task_id, error: String(lastErr?.message ?? lastErr), code: lastErr?.code ?? null })
  return failed(action, lastErr, `镜像关单失败${why}（${String(lastErr?.message ?? lastErr)}）—— 只记审计，关单/取消主流程不受影响。`)
}
