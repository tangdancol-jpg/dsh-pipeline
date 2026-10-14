/**
 * dsh-pipeline · L0 · **规则引擎自批时也要记一次改动基线**
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑤）
 * -----------------------------------------------------------------------------
 * 现场：审核席位要按规则 **R6「前后版本对比」** 出 `review_verdict.change_audit`，
 * 却发现 **L0 任务根本没有基线** —— 它只能**手工清点**，而 `pipeline_change_audit`
 * 直接报「没有基线」。审核位如实拒绝编造，改用人工清点（这一点它做对了）。
 *
 * 根因：基线只在**计划**那一站记（`pipeline_plan` 里那次 `takeBaseline`），
 * 而 **L0 没有计划这一站**（规则引擎自批，`judged_by: 'rule-engine'`）
 * ⇒ 整条 L0 链路上**没有任何时刻**记过"没动手之前的样子"。
 *
 * -----------------------------------------------------------------------------
 * 修法：把"派活那一刻"这条口径**原样**搬到 L0
 * -----------------------------------------------------------------------------
 * 计划路径的注释写得很清楚：「这一刻就是"计划定稿、即将派活"的边界 ——
 * 再往后就没有一个干净的时刻了」。L0 上**对应的那一该**是：**角色清单写进去之后、
 * 主对话派活之前**（`setRoster` 成功那一瞬间）—— 同一个语义、同一个时机，
 * 只是产出清单的人从计划 AI 换成了规则引擎。
 *
 * ★ 三条不越界：
 *   · **不新开机制**：调的是**既有**的 `store.takeBaseline`（同一份清单算法、
 *     同一份 `gate:hash_reset` 语义），不新造第二套基线；
 *   · **不覆盖已有基线**：已经有基线就**什么都不做**（重取基线是计划 AI / 主对话的动作，
 *     不是机制的）；
 *   · **不拦流程**：记不上（项目根读不到等）**照样让编排成功**，只在摘要里如实说一句 ——
 *     基线是"审核的判据"，不是"开工的前提"。
 *
 * @module dsh-pipeline/lib/store/l0-baseline
 */

/** 规则引擎记基线时写进 `taken_by` 的名字（与 `roster.judged_by` 同源）。 */
export const L0_BASELINE_ACTOR = 'rule-engine'

/**
 * 这张单现在需不需要补一次 L0 基线（**纯判据**，不读盘、不写盘）。
 *
 * @param {object|null} task
 * @returns {boolean}
 */
export function needsL0Baseline(task) {
  if (task === null || typeof task !== 'object') return false
  const has = typeof task.baseline_current === 'string' && task.baseline_current.length > 0
  if (has) return false
  // 已经有基线记录（哪怕指针没设）也不算"从没记过"。
  return !(Array.isArray(task.baselines) && task.baselines.length > 0)
}

/**
 * L0 自批之后补一次基线（**幂等**：已有基线就空操作）。
 *
 * @param {object} input
 * @param {object} input.store - 真 store（要有 `takeBaseline`）
 * @param {object} input.task
 * @param {string} [input.by] - 默认 `rule-engine`
 * @param {string} [input.reason] - L0 自批的理由（拼进 baseline 的 note，便于回溯）
 * @returns {Promise<{ok:boolean, created:boolean, baseline:object|null, skipped?:string, error?:string}>}
 */
export async function ensureL0Baseline({ store, task, by = L0_BASELINE_ACTOR, reason = '' } = {}) {
  if (task === null || typeof task !== 'object') {
    return { ok: false, created: false, baseline: null, error: '没有任务对象，记不了基线。' }
  }
  if (typeof store?.takeBaseline !== 'function') {
    return { ok: false, created: false, baseline: null, error: '这个 store 没有 takeBaseline（装配不全）—— 如实登记，不假装记了。' }
  }
  if (!needsL0Baseline(task)) {
    return { ok: true, created: false, baseline: null, skipped: '已经有基线了 —— L0 补记**不覆盖**它（重取基线是计划 AI / 主对话的动作）。' }
  }
  const r = await store.takeBaseline({
    taskId: task.id,
    by,
    planHandoffId: null,
    note:
      'L0 自批那一刻的基线（由规则引擎在角色清单写入后自动记录）。' +
      '★ 与计划路径同一条口径：**清单定稿、即将派活**就是这个任务的"没动手之前"。' +
      (reason.length > 0 ? `自批理由：${reason}` : ''),
  })
  if (r === null || r === undefined || r.ok !== true) {
    return { ok: false, created: false, baseline: null, error: String(r?.error ?? 'takeBaseline 没有返回成功。') }
  }
  return { ok: true, created: true, baseline: r.baseline }
}

/**
 * 渲染成编排摘要里的一行（成功 / 已经有 / 没记上，三种都如实说）。
 *
 * @param {object} r - {@link ensureL0Baseline} 的返回
 * @returns {string}
 */
export function describeL0Baseline(r) {
  if (r?.created === true) {
    return (
      `改动基线已记录：${r.baseline?.baseline_id}（${r.baseline?.file_count ?? '?'} 个文件，记于 ${r.baseline?.taken_at ?? '?'}）。\n` +
      '  ★ 审核阶段的「前后版本对比」（R6）从此在 L0 上也有判据可用了。'
    )
  }
  if (r?.ok === true) return `改动基线：${r.skipped ?? '已有基线，未重记。'}`
  return `⚠ 改动基线**没能记录**：${r?.error ?? '原因不明'} —— 审核阶段的前后版本对比会缺依据（**不拦流程**，如实登记）。`
}
