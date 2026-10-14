/**
 * dsh-pipeline · 守门工厂
 * ============================================================================
 * 把 `lib/guard.js` 的纯判据接到 DSH 的 `ctx.tools.guard` 上。
 *
 * 单独一个文件是因为这里有**四条与宿主实现绑定的约束**，必须集中在一处，
 * 免得散落到判据里去：
 *
 *   ① `ctx.tools.guard(fn)` 是**同步**调用的（`dsh-tools/lib/index.js:2646-2651`
 *      在同步循环里直接 `guard(exec)`）—— 所以判据只能用同步数据源。
 *      这就是为什么任务索引是一张内存 Map、而功能开关也必须同步可读。
 *
 *   ② 判据必须返回 `undefined` 才放行（`:2649` 判的是 `reason !== void 0`）。
 *
 *   ③ 判据**抛异常不是拒绝**（`:3267` 会把它吞成通用 tool error，理由文本丢失）。
 *      所以这里兜一层 try/catch，内部异常按 fail-closed 返回明确理由。
 *
 *   ④ **功能开关关掉时，守门必须"不存在"**（用户语义：关 = 守门不介入）。
 *      开关判定放在最前面、且早于一切其它判据 —— 关掉之后本守卫对任何调用
 *      都返回 `undefined`（弃权）。注意：`undefined` 是**弃权**不是"允许"，
 *      别的守卫（例如 dsh-archigate）照样能拒 —— 这正是我们要的语义：
 *      关掉的是"多 AI 协调"，不是"整个 DSH 的其它保护"。
 *
 * @module dsh-pipeline/lib/guard-factory
 */

import { agentIdOf, guardDecision } from './guard.js'

/** 内部异常时的拒绝文案（要能一眼看出是插件 bug，而不是模型操作错）。 */
const INTERNAL_FAILURE_PREFIX = '[pipeline] 守门内部异常，按 fail-closed 拒绝本次调用。这是插件 bug，不是你的操作问题。'

/**
 * 造一个可直接交给 `ctx.tools.guard()` 的函数。
 *
 * @param {object} deps
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {object} deps.config
 * @param {Map<string, object>} deps.taskIndex - taskId → {taskId, projectRoot, pipelineDir, reportsDir}
 * @param {{isOn:()=>boolean}} [deps.sw] - 功能开关。**同步** `isOn()`。
 * @returns {(exec:object)=>string|undefined}
 */
export function createGuardFor(deps) {
  /**
   * ★ 索引未命中时的留痕（**只报一次 / 每个任务**，免得刷屏）。
   *
   * 为什么要它：守门要**同步**查任务，而任务在盘上、读取是异步的 ——
   * 索引取不到时，靠 task.projectRoot / taskSelfDir / writers 的那几条判据会
   * **整段跳过**。那是 fail-open，但**不能是静默的**：
   * "这段判据没跑到"必须在日志里看得见，否则就是假绿。
   */
  const alreadyWarned = new Set()
  const onMissingTask = (info) => {
    const key = String(info?.taskId ?? '?')
    if (alreadyWarned.has(key)) return
    alreadyWarned.add(key)
    const sink = typeof deps.warn === 'function' ? deps.warn : (m) => deps.ctx?.logger?.warn?.(m)
    if (typeof sink !== 'function') return
    try {
      sink(
        `[pipeline] 守门提示：任务 ${key} 还没进同步索引，**靠索引的那几条文件判据本次没有生效**` +
          `（工具=${info?.tool ?? '?'}，角色=${info?.role ?? '?'}）。` +
          '\n  这不是拒绝，是"没查到"—— 判据整段跳过（fail-open）。' +
          '\n  为什么会这样：守门必须同步判定，而任务数据在盘上、读取是异步的，索引只是缓存。' +
          '\n  怎么缓解：让该会话先做一次流水线动作（任何 pipeline_* 调用都会把任务登记进索引），' +
          '或在派活之后再做文件写入。本提示每个任务只报一次。',
      )
    } catch {
      /* 留痕失败绝不该影响守门 */
    }
  }
  const { tokens, config, taskIndex, sw, counter } = deps

  /** 同步查表包装：Map 的 get 找不到时返回 undefined，判据里要的是 null。 */
  const index = {
    get: (taskId) => {
      if (typeof taskId !== 'string' || taskId.length === 0) return null
      return taskIndex.get(taskId) ?? null
    },
  }

  return function pipelineGuard(exec) {
    // ④ 功能开关：关掉 = 本守卫弃权（返回 undefined，不是"允许"）。
    //    放在 try 外面、且早于一切判据 —— 关掉之后不应该再有任何本插件的理由文本。
    if (sw !== undefined && sw !== null) {
      let on
      try {
        on = sw.isOn() === true
      } catch (err) {
        // 开关自己坏了：宁可照常守（fail-closed），也不能因为读开关失败就静默放行。
        return `${INTERNAL_FAILURE_PREFIX}\n读功能开关失败：${String(err?.message ?? err)}`
      }
      if (!on) return undefined
    }

    try {
      // ★ 客观观测：每经过一次工具调用就记一笔（按 agent 分桶）。
      //   它不是"上下文占用"的度量 —— 只是"这个席位有多忙"的客观代理指标，
      //   用来给席位自报的水位做交叉印证。放在最前面，开关关掉也照数。
      if (counter !== undefined && counter !== null) {
        try {
          counter.touch(agentIdOf(exec), exec?.name)
        } catch {
          /* 计数失败绝不该拦住调用 */
        }
      }
      return guardDecision(exec, { tokens, config, taskIndex: index, retired: deps.retired, onMissingTask })
    } catch (err) {
      return `${INTERNAL_FAILURE_PREFIX}\n工具：${String(exec?.name ?? '(未知)')}\n异常：${String(err?.message ?? err)}`
    }
  }
}
