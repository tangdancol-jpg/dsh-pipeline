/**
 * dsh-pipeline · WP-B · 任务板镜像的**宿主面与落盘状态**
 * ============================================================================
 * 从 `board.js` 按功能拆出来的一半（行数纪律：单文件 ≤300 行）。这里回答
 * 「**能不能镜像、镜像状态写哪儿**」，三个**动作**（开单/派活/关单）在 `board.js`：
 *   · `.pipeline/<task>/team-board.json` 的读写（契约见设计 02 §4）；
 *   · **模块级宿主登记** —— store hook 拿不到宿主 ctx，只能靠装配期登记补；
 *   · 门槛：`config.teamBoard` / `agentTeams` 服务 / **活着的** caller 对象；
 *   · 审计出口 `audit('team:board-error', …)`（best-effort，它自己失败也不抛）。
 *
 * @module dsh-pipeline/lib/team/board-state
 */

import { join } from 'node:path'

import { readHostService } from '../host-surface.js'
import { readJson, writeJsonAtomic } from '../store/shared.js'

/** 契约里的落盘文件名（02 §4）。 */
export const BOARD_FILE_NAME = 'team-board.json'

/**
 * ★ **模块级宿主注册**（晚绑定）—— 本模块的单例出口。
 *
 * 为什么必须有它：`lib/store/lifecycle.js` 的 ctx 只有 `createStoreBase` 传进去的
 * 一组闭包名（没有 `opts`、没有宿主 `ctx`），而开单/关单 hook 必须拿得到
 * `ctx.get('agentTeams')`。`index.js` 的 `apply()` 拿得到，且既有 `noteSeatFaceTighten`
 * 已是同一套写法。★ 没登记时一律跳过（不抛）—— 镜像不该成为插件能否启动的条件。
 * @type {{ctx?:object, config?:object, dirs?:object, audit?:Function, callerAgent?:object}|null}
 */
let BOARD_HOST = null

/** 装配期登记宿主面（`index.js` 的 `apply()` 调一次；后调覆盖前调）。 */
export function installBoardHost(host) {
  BOARD_HOST = host !== null && typeof host === 'object' && !Array.isArray(host) ? host : null
  return BOARD_HOST
}

/** 读当前登记（自测/审查可查；`null` = 没登记）。 */
export function installedBoardHost() {
  return BOARD_HOST
}

/**
 * store 侧能拿到的部分 + 模块级宿主 ⇒ `env = {ctx, dirs, audit, config, callerAgent}`。
 * ★ 显式入参优先，缺的字段才取登记值（store hook 只传得出任务目录与审计出口）。
 */
export function boardEnvFromStore(parts = {}) {
  const host = BOARD_HOST ?? {}
  return {
    ctx: parts.ctx ?? host.ctx ?? null,
    config: parts.config ?? host.config ?? {},
    dirs: parts.dirs ?? host.dirs ?? {},
    audit: parts.audit ?? host.audit ?? null,
    callerAgent: parts.callerAgent ?? host.callerAgent ?? null,
    callerAgentId: typeof parts.callerAgentId === 'string' ? parts.callerAgentId : null,
  }
}

/** 配置值：只认 `'off'` 这一种"关"；没配/写错一律按 D10 默认的 `'auto'`。 */
export function teamBoardMode(env) {
  return env?.config?.teamBoard === 'off' ? 'off' : 'auto'
}

/** `.pipeline` 根：优先 store 给的 `pipelineRoot`，否则按 `<projectRoot>/<artifactDirName>` 拼。 */
function pipelineRootOf(env) {
  const dirs = env?.dirs ?? {}
  if (typeof dirs.pipelineRoot === 'string' && dirs.pipelineRoot.length > 0) return dirs.pipelineRoot
  // ★ 目录名三级回落：显式 dirs > 配置（transport 传进来的 dirs 只有 projectRoot）> 默认。
  const configured = env?.config?.artifactDirName
  const name = typeof dirs.artifactDirName === 'string' && dirs.artifactDirName.length > 0
    ? dirs.artifactDirName
    : typeof configured === 'string' && configured.length > 0 ? configured : '.pipeline'
  if (typeof dirs.projectRoot !== 'string' || dirs.projectRoot.length === 0) return ''
  return join(dirs.projectRoot, name)
}

/** `<pipelineRoot>/<taskId>/team-board.json`；拿不到目录 ⇒ `''`（按 skipped 处理）。 */
export function teamBoardPath(env, taskId) {
  const root = pipelineRootOf(env)
  if (root.length === 0 || typeof taskId !== 'string' || taskId.length === 0) return ''
  return join(root, taskId, BOARD_FILE_NAME)
}

/** 读镜像状态。**读不到/读坏都返回 `null`**（= 还没镜像过，不是异常）。 */
export async function readBoardState(env, taskId) {
  const file = teamBoardPath(env, taskId)
  if (file.length === 0) return null
  let raw = null
  try {
    raw = await readJson(file)
  } catch {
    return null
  }
  const id = typeof raw?.team_task_id === 'string' ? raw.team_task_id : ''
  const revision = Number.isInteger(raw?.revision) ? raw.revision : 0
  if (id.length === 0 || revision < 1) return null
  return {
    team_task_id: id,
    revision,
    last_action: typeof raw.last_action === 'string' ? raw.last_action : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  }
}

/**
 * 写镜像状态。**best-effort**：写失败只回 `false`、不抛 —— 镜像状态丢了顶多下次
 * revision 对不上（由 CAS 重试兜住），不该把开单/关单搞失败。
 */
export async function persistBoardState(env, taskId, state) {
  const file = teamBoardPath(env, taskId)
  if (file.length === 0) return false
  try {
    await writeJsonAtomic(file, state)
    return true
  } catch {
    return false
  }
}

/**
 * 官方要求的 `caller` 是**活着的 Team 成员对象**（不是 id 字符串）。
 * 显式给了 `callerAgent` 就用；否则用 `callerAgentId` 去 `ctx.get('agents')` 反查。
 */
function callerOf(env) {
  const direct = env?.callerAgent
  if (direct !== null && typeof direct === 'object' && typeof direct.id === 'string') return direct
  const id = typeof env?.callerAgentId === 'string' ? env.callerAgentId : ''
  if (id.length === 0) return null
  const agents = readHostService(env?.ctx, 'agents')
  if (typeof agents?.get !== 'function') return null
  try {
    const found = agents.get(id)
    return found !== null && typeof found === 'object' ? found : null
  } catch {
    return null
  }
}

/** skipped（**不是错误**：没服务 / 关了 / 调用方不满足）。 */
export function skipped(action, note) {
  return { ok: false, skipped: true, action, note }
}

/** 失败（镜像失败，但**流水线主流程不受影响**）。 */
export function failed(action, err, note) {
  return { ok: false, skipped: false, action, code: typeof err?.code === 'string' ? err.code : null, error: String(err?.message ?? err), note }
}

/**
 * 门槛检查：关闭 / 服务不在 / 缺方法 / 拿不到 caller ⇒ skipped。
 * @returns {{skipped:true, note:string}|{skipped:false, service:object, caller:object}}
 */
export function boardGate(env) {
  if (teamBoardMode(env) === 'off') return { skipped: true, note: "config.teamBoard='off'：任务板镜像已关闭（不发起任何宿主调用）。" }
  const service = readHostService(env?.ctx, 'agentTeams')
  if (service === undefined || service === null) return { skipped: true, note: "宿主没有 agentTeams 服务（ctx.get('agentTeams') 拿不到）⇒ 任务板镜像跳过。" }
  if (typeof service.createTask !== 'function' || typeof service.updateTask !== 'function') {
    return { skipped: true, note: '宿主 agentTeams 缺 createTask/updateTask ⇒ 任务板镜像跳过。' }
  }
  const caller = callerOf(env)
  if (caller === null) return { skipped: true, note: '拿不到主对话（Team Lead）的活会话对象 ⇒ 任务板镜像跳过。' }
  return { skipped: false, service, caller }
}

/**
 * 落审计 `team:board-error`；**写审计失败也不抛**。
 *
 * ★ 为什么这里要认两种签名（历史包袱，别改成一种）：
 *   · store 侧注入的是两参闭包 `(action, detail)`（每行自带 task_id/actor）；
 *   · transport 侧注入的是既有 `createChannelAudit().record(entry)` —— **单对象参**
 *     `{taskId, action, detail}`。两处都是既有代码，不去改别人文件，改成适配两种。
 *   判据用 `fn.length`：两参形态走 `(action, detail)`，其余按对象形态调用。
 */
export async function auditBoardError(env, detail) {
  const fn = env?.audit
  if (typeof fn !== 'function') return
  const action = 'team:board-error'
  try {
    if (fn.length >= 2) await fn(action, detail)
    else await fn({ taskId: String(detail?.task_id ?? ''), action, detail })
  } catch {
    /* 审计是辅助面：它自己失败不该制造第二层失败 */
  }
}
