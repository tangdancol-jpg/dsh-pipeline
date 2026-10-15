// retain 缝（`tools/post-execute`）：**机制自己**把 `pipeline_*` 工具的结果记成一条记忆 —— 不靠席位自觉。
/**
 * dsh-pipeline · 记忆 · retain 缝
 * ============================================================================
 * 设计 `04-接线点.md` §1 的原话：「记忆只能靠席位**主动调工具**去写 —— 正是用户要求
 * 排除的"依赖自觉"。席位不调 ⇒ 库永远是空的」。所以这一条缝是本域**唯一的自动积累点**。
 *
 * ---------------------------------------------------------------------------
 * 挂在哪、为什么挂在那里
 * ---------------------------------------------------------------------------
 * 事件：`tools/post-execute`（既有的四个事件之一，**不新增事件名**）。
 * 位置：`HOOKS` 数组里排在 ③ 唤醒之后、④ 结果网**之前** ——
 *   结果是：本缝记的是**原始结果**，不是"被插件自己换成 feedback 的结果"
 *   （设计 §1 的挂载顺序裁决：**记忆要记事实，不要记插件自己造成的替换**）。
 *
 * ---------------------------------------------------------------------------
 * 四条硬约束（每条都有测试钉）
 * ---------------------------------------------------------------------------
 *   ① **只记 `pipeline_*`**（判据 R2）：别的工具（`bash` / `read` / `write`…）一律直通 ——
 *      否则一次会话就能把库写爆，而且那些内容根本不属于本插件的事实。
 *   ② **同一事件不重复记**（去重键）：同一次调用重放 / 同一条交付重复投递只留一条。
 *   ③ **绝不改结果**（本缝是**观察者**，不是过滤器）：无论记没记，返回值都是 `next()` 的原样。
 *   ④ **绝不抛**：写库失败只 `warn` —— 判据 R3 的现场就是"被包裹的那次调用仍返回原结果"。
 *
 * ★ 总开关：关 ⇒ 本缝**根本不挂**（`registry` 按闸门挂/摘），且本函数第一句仍问一次闸门。
 *
 * @module dsh-pipeline/lib/memory/retain-hook
 */

import { agentIdOf } from '../guard.js'
import { ROLE } from '../roles.js'
import { appendRecords } from './append.js'
import { memoryFile } from './bank.js'
import { DIGEST_DISC_BODY_MAX, DIGEST_DISC_FIELDS, DIGEST_KEY_MAX, isPlainObject, scalarText, toolDigest, unwrapResult } from './digest.js'
import { KIND, clip, emptyRefs, makeRecord } from './record.js'
import { aliasAll } from './alias.js'

/** 只有这些工具会被记（`pipeline_*` 的**唯一**判据；别处不许再写第二份前缀）。 */
export const RETAIN_TOOL_PREFIX = 'pipeline_'

/** 进程内去重键的上限（防止长会话里这个 Set 无限长大）。 */
export const MAX_SEEN = 512

/**
 * 这次调用该不该记（**纯判据**，与写盘分开 —— 这样它能被单独测）。
 *
 * @param {object} exec - 宿主的工具执行上下文（读 `name`）
 * @returns {boolean}
 */
export function shouldRetain(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  return name.startsWith(RETAIN_TOOL_PREFIX) && name.length > RETAIN_TOOL_PREFIX.length
}

/**
 * 去重键（**确定性**：同一个工具 + 同一张单 + 同一份结果 ⇒ 同一个键）。
 *
 * 为什么要它：同一次交付可能被重放（重试 / 重复投递 / 宿主重放），
 * 没有这个键，库里会长出一串一模一样的行 —— 那是**噪音**，不是记忆。
 *
 * ★ 2026-10-15（缺陷 A）：**先拆信封再取字段**（`unwrapResult`）。改动前这里读的是
 *   `result.handoff_id ?? …`，而 `result` 是宿主信封 ⇒ 这些字段**恒为 undefined**、
 *   兜底又落到 `String(信封.value)` = `[object Object]` ⇒ **所有调用共用一把键**
 *   （第二次起全被当重复丢掉）。取字段、序列化、截断的口径统一在 `digest.js`。
 *
 * @param {object} exec
 * @param {*} result
 * @returns {string}
 */
export function retainDisc(exec, result) {
  const u = unwrapResult(result)
  const inner = isPlainObject(u.value) ? u.value : {}
  const args = exec?.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
  const parts = DIGEST_DISC_FIELDS.map((k) => scalarText(inner[k]))
  // ★ 结果里没有一个可判别子时，退到"结果的形状指纹"（键名列表 + 摘要正文前 80 字）——
  //   仍然确定性，且不含随机量。
  const fallback = `${Object.keys(inner).sort().join(',')}|${clip(toolDigest(exec, result).body, DIGEST_DISC_BODY_MAX)}`
  return `${String(exec?.name ?? '')}|${clip(scalarText(args.task_id ?? inner.task_id ?? ''), DIGEST_KEY_MAX)}|${parts.join('|')}|${fallback}`
}

/**
 * 把一次工具调用折成一条记忆（纯函数；写不写由调用方定）。
 *
 * ★ 2026-10-15（缺陷 A）：正文与 `refs` 一律从**信封里的 `value`** 取
 *   （`toolDigest`）。改动前 `r.summary ?? r.value` 拿到的是信封里的 `value` 对象，
 *   于是正文成了 `[object Object]`、`refs.state` / `refs.handoff` 恒为空串。
 *
 * @param {object} exec
 * @param {*} result
 * @param {object} [ctx]
 * @param {string} [ctx.at] - ISO 时刻（**必须由调用方给** —— 本函数不读时钟）
 * @param {string} [ctx.projectDir]
 * @returns {{ok:true, record:object} | {ok:false, errors:string[]}}
 */
export function toolResultRecord(exec, result, ctx = {}) {
  const name = String(exec?.name ?? '')
  const d = toolDigest(exec, result)

  return makeRecord({
    id: `${KIND.TOOL}:${name}:${clip(retainDisc(exec, result), DIGEST_KEY_MAX)}`,
    at: String(ctx.at ?? ''),
    kind: KIND.TOOL,
    text: d.text,
    entity: aliasAll(
      [
        `tool:${name}`,
        ...(d.taskId.length > 0 ? [`task:${d.taskId}`] : []),
        ...(d.state.length > 0 ? [`state:${d.state}`] : []),
      ],
      'tool',
    ),
    refs: emptyRefs({
      task_id: d.taskId,
      state: d.state,
      state_label: '',
      paths: [],
      handoff: d.handoffId,
      artifact_version: d.artifactVersion,
      roles: [],
    }),
  })
}

/**
 * 造 retain 缝的中间件。
 *
 * @param {object} svc - 由 `lib/intercept/registry.js` 装配的服务袋
 * @param {()=>boolean} svc.ask - 逐次闸门
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @param {(taskId:string)=>object|null} [svc.getTask]
 * @param {(m:string)=>void} [svc.warn]
 * @param {string} [svc.projectDir] - 项目目录（缺省时按任务的 `project_dir` 取）
 * @param {{appendFile:Function, mkdir:Function}} [svc.memoryFs] - 文件系统缝（自测注入）
 * @param {()=>string} [svc.nowIso] - 时钟缝（自测注入 —— 判据要确定性）
 * @returns {(exec:object, result:*, next:Function)=>Promise<*>}
 */
export function createMemoryRetainHook(svc) {
  const { ask, seatOf } = svc
  const warn = typeof svc.warn === 'function' ? svc.warn : () => {}
  const seen = svc.retainedKeys ?? new Set()
  const nowIso = typeof svc.nowIso === 'function' ? svc.nowIso : () => new Date().toISOString()

  /** 项目目录：任务的绑定优先，其次装配时给的工作区（**都取不到就静默不写**）。 */
  const projectDirOf = (taskId) => {
    try {
      const task = typeof svc.getTask === 'function' && taskId.length > 0 ? svc.getTask(taskId) : null
      const bound = typeof task?.project_dir === 'string' ? task.project_dir.trim() : ''
      if (bound.length > 0) return bound
    } catch {
      /* 取不到就当没有 */
    }
    return String(svc.projectDir ?? '').trim()
  }

  return async function memoryRetainHook(exec, result, next) {
    // ★★ 总开关：关 ⇒ 直通（本缝本该已被摘掉；这一句覆盖"两次采样之间"的调用）。
    if (!ask()) return next()
    try {
      if (!shouldRetain(exec)) return next()
      const disc = retainDisc(exec, result)
      if (seen.has(disc)) return next()
      if (seen.size >= MAX_SEEN) seen.clear()
      seen.add(disc)

      const seat = seatOf(agentIdOf(exec))
      const taskId = String(exec?.arguments?.task_id ?? '')
      const projectDir = projectDirOf(taskId)
      const file = memoryFile(projectDir)
      // ★ 项目目录取不到 ⇒ **静默不写**（不猜落点）—— 边界规定写在设计 `05` §3。
      if (file.length === 0) return next()

      const made = toolResultRecord(exec, result, { at: nowIso(), projectDir })
      if (made.ok !== true) return next()
      // ★ 席位信息只影响 `refs.roles`（"谁触发的"），缺了也照样记 —— 记忆记的是事实。
      if (seat !== null && typeof seat?.role === 'string' && seat.role !== ROLE.MAIN) {
        made.record.refs.roles = aliasAll([`role:${seat.role}`], 'role')
      }
      await appendRecords(file, [made.record], { fs: svc.memoryFs, warn, createDir: true })
      return next()
    } catch (err) {
      // ★★ 绝不抛：这条缝在**每一次工具调用**的关键路径上（判据 R3）。
      try {
        warn(`[pipeline] 记忆 retain 失败（不影响本次调用）：${String(err?.message ?? err)}`)
      } catch {
        /* 连 warn 坏了也不许抛 */
      }
      return next()
    }
  }
}
